'use strict';
// WorkBuddy 独立证据：配对关闭目录映射定点返修（Codex 复查 5c54c89 报告 C1/C3）。
// 全程离线合成验证：实际生成链（模板→打包器→候选+关闭包）+ 合成 wx/db/时钟；
// 不调用真实 SDK 平台、不部署、不写库。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const guardHits = [];
const restore = [];
function guard(mod, name) {
  if (typeof mod[name] !== 'function') return;
  const old = mod[name];
  mod[name] = function () { guardHits.push(name); throw new Error('WB_OFFLINE_GUARD'); };
  restore.push(() => { mod[name] = old; });
}
for (const id of ['node:http', 'node:https']) {
  const mod = require(id);
  for (const name of ['request', 'get']) guard(mod, name);
}
for (const name of ['connect', 'createConnection']) guard(require('node:net'), name);
guard(require('node:tls'), 'connect');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), name);
  guard(require('node:dns').promises, name);
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  guard(require('node:child_process'), name);
}
guard(globalThis, 'fetch');

const ROOT = path.resolve(__dirname, '../..');
const packer = require(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'));
const business = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const core = require(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'));
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const RUN = crypto.randomUUID();
const OUT_ROOT = path.join(ROOT, 'artifacts/schedule-sandbox/business-test');
const WORK = path.join(OUT_ROOT, 'wb-pic-closemap-' + RUN);
fs.mkdirSync(WORK, { recursive: true });
let seq = 0;
const outDirFor = tag => path.join(OUT_ROOT, 'participant-identity-wb-close-' + tag + '-' + RUN.slice(-8) + '-' + (++seq));
const APPID = core.FIXED_TARGET.appId;
const ENV_ID = core.FIXED_TARGET.envId;
const writeJson = (dir, name, data) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, JSON.stringify(data, null, 2), { flag: 'wx' });
  return target;
};
const results = [];
async function probe(id, fn) {
  try { results.push({ id, assertionsPassed: true, actual: await fn() }); }
  catch (error) { results.push({ id, assertionsPassed: false, error: error.message }); }
}

async function main() {
  for (const fn of [
    () => require('node:https').request('https://example.invalid'),
    () => require('node:child_process').spawn('node', [])
  ]) assert.throws(fn, /WB_OFFLINE_GUARD/);
  const sensitivityHits = guardHits.length;

  // ── M0：受审关闭包来源（未改 business checkCloseDir 以来源原布局校验） ──
  let closeSource = null;
  await probe('M0_source_verified_with_unchanged_tool', async () => {
    const round = 'synthetic-close-' + RUN.slice(0, 12);
    const users = Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
      userId: 'u_' + sha(APPID + ':synthetic-' + role + RUN).slice(0, 40), source: 'synthetic fixture'
    }]));
    const plan = writeJson(WORK, 'business-plan.json', {
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: round, windowNo: 'P-01', appId: APPID, envId: ENV_ID, users,
      projectReadyMarker: 'ready-' + round,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    });
    closeSource = business.build('P', plan, outDirFor('close-source')).outDir;
    // 来源侧校验：未改业务工具、来源原布局（close/server/ 直接根）
    const check = business.checkCloseDir(closeSource);
    assert.equal(check.ok, true, '来源独立校验');
    assert.ok(fs.existsSync(path.join(closeSource, 'close', 'server', 'index.js')),
      '来源 server/ 为直接根布局（映射前的缺口事实）');
    assert.equal(fs.existsSync(path.join(closeSource, 'close', 'server', 'scheduleSandbox')), false,
      '来源不含同名子目录（本包装配时映射）');
    return { sourceCheckOk: true, sourceServerRootLayout: true, businessToolUnchanged: true };
  });

  // ── M1：映射装配（来源 server/** → close/server/scheduleSandbox/**，其余逐字节） ──
  let closePlanPath = null;
  await probe('M1_close_mapping_assembly', async () => {
    const starts = Date.now() - 60000;
    closePlanPath = writeJson(WORK, 'identity-plan.json', {
      schema: packer.PLAN_SCHEMA, synthetic: true, checkRoundId: 'wb-close-' + RUN.slice(0, 12),
      participantCode: '1', appId: APPID, envId: ENV_ID,
      functionName: core.FIXED_TARGET.functionName, collection: core.FIXED_TARGET.collection,
      passphraseDigest: sha('synthetic-wb-pass-' + RUN),
      windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 600000).toISOString(),
      closeSourceDir: closeSource, note: 'WorkBuddy close-mapping synthetic fixture'
    });
    const outDir = outDirFor('candidate');
    const built = packer.build(closePlanPath, outDir);
    const closeDir = path.join(outDir, 'close');
    // (1) close/server/ 下仅同名函数子目录（映射后布局）
    assert.deepEqual(fs.readdirSync(path.join(closeDir, 'server')), ['scheduleSandbox']);
    assert.equal(packer.SERVER_FN_DIR, core.FIXED_TARGET.functionName);
    // (2) manifest 映射记录：每条含 rel（映射后）与 sourceRel（来源原 rel），字节数一致
    const srcClose = path.join(closeSource, 'close');
    for (const f of built.manifest.closePackage.files) {
      assert.equal(f.rel, packer.adaptCloseRel(f.sourceRel), '映射关系：' + f.sourceRel);
      assert.deepEqual(fs.readFileSync(path.join(closeDir, f.rel)), fs.readFileSync(path.join(srcClose, f.sourceRel)),
        '逐字节一致：' + f.sourceRel + ' -> ' + f.rel);
    }
    // (3) 函数目录齐备 + 入口可读取 + 配置根正确
    for (const must of ['index.js', 'package.json', 'gate.js', 'collection-map.js', 'project-guard.js', 'vendor']) {
      assert.ok(fs.existsSync(path.join(closeDir, 'server', 'scheduleSandbox', must)), '函数目录含 ' + must);
    }
    const cfg = JSON.parse(fs.readFileSync(path.join(closeDir, 'project.config.json'), 'utf8'));
    assert.equal(cfg.cloudfunctionRoot, 'server/');
    assert.equal(fs.readFileSync(path.join(closeDir, 'server', 'scheduleSandbox', 'index.js')).length > 0, true);
    // (4) checkDir 通过（关闭映射重建一致）
    const r = packer.checkDir(outDir);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    return {
      closeFiles: built.manifest.closePackage.files.length,
      mappedServerFiles: built.manifest.closePackage.files.filter(f => f.sourceRel.startsWith('server/')).length,
      bytePreservedFiles: built.manifest.closePackage.files.filter(f => !f.sourceRel.startsWith('server/')).length,
      manifestMappingField: built.manifest.closePackage.mapping,
      checkDirOk: true
    };
  });

  // ── M2：独立 checkCloseDir（映射后布局重建；不依赖候选窗口/时钟） ──
  // M2 使用**独立来源**：其「来源失效」破坏性用例不得影响后续 M3/M4。
  let m2Source = null;
  await probe('M2_independent_check_close_dir', async () => {
    const round2 = 'synthetic-close-' + RUN.slice(0, 12) + '-m2';
    const users2 = Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
      userId: 'u_' + sha(APPID + ':synthetic-m2-' + role + RUN).slice(0, 40), source: 'synthetic fixture'
    }]));
    const plan2 = writeJson(WORK, 'business-plan-m2.json', {
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: round2, windowNo: 'P-01', appId: APPID, envId: ENV_ID, users: users2,
      projectReadyMarker: 'ready-' + round2,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    });
    m2Source = business.build('P', plan2, outDirFor('close-source-m2')).outDir;
    assert.equal(business.checkCloseDir(m2Source).ok, true);
    const starts2 = Date.now() - 60000;
    const closePlanM2 = writeJson(WORK, 'identity-plan-m2.json', {
      schema: packer.PLAN_SCHEMA, synthetic: true, checkRoundId: 'wb-close-m2-' + RUN.slice(0, 8),
      participantCode: '1', appId: APPID, envId: ENV_ID,
      functionName: core.FIXED_TARGET.functionName, collection: core.FIXED_TARGET.collection,
      passphraseDigest: sha('synthetic-wb-pass-' + RUN),
      windowStartsAtIso: new Date(starts2).toISOString(),
      windowExpiresAtIso: new Date(starts2 + 600000).toISOString(),
      closeSourceDir: m2Source
    });
    process.env.PIC_CLOSE_SOURCE_DIR = m2Source;
    try {
      const outDir = outDirFor('candidate2');
      packer.build(closePlanM2, outDir);
      const realNow = Date.now;
      const r1 = (() => { Date.now = () => NaN; try { return packer.checkCloseDir(outDir); } finally { Date.now = realNow; } })();
      assert.equal(r1.ok, true, 'NaN 时钟下独立校验通过：' + JSON.stringify(r1.problems));
      assert.equal(r1.files, r1.expectedFiles);
      // 篡改关闭包内函数文件 → 独立校验拒绝且不清理
      const target = path.join(outDir, 'close', 'server', 'scheduleSandbox', 'index.js');
      const saved = fs.readFileSync(target);
      fs.writeFileSync(target, Buffer.concat([saved, Buffer.from('// tampered\n')]));
      const r2 = packer.checkCloseDir(outDir);
      fs.writeFileSync(target, saved);
      assert.equal(r2.ok, false, '文件漂移必须拒绝');
      assert.ok(r2.problems.some(x => /与受审来源重建不一致/.test(x)), JSON.stringify(r2.problems));
      // 来源失效 → 拒绝（关闭包不能凭空重建）；破坏仅作用于 M2 自己的来源
      const closeDirPath = path.join(m2Source, 'close');
      fs.rmSync(closeDirPath, { recursive: true, force: true });
      const r3 = packer.checkCloseDir(outDir);
      assert.equal(r3.ok, false, '来源失效须拒绝');
      assert.ok(r3.problems.some(x => /来源重建失败|关闭映射不变量失败/.test(x)), JSON.stringify(r3.problems));
      return { nanClockOk: true, tamperRejected: true, sourceMissingRejected: true, candidateNotDeleted: fs.existsSync(target) };
    } finally {
      delete process.env.PIC_CLOSE_SOURCE_DIR;
    }
  });

  // ── M3：写前拒绝反例（旧布局/缺 package.json 不变量 + 盘上散文件）与复用/续建/部分写 ──
  await probe('M3_write_guard_rejections_and_reuse', async () => {
    const plan = JSON.parse(fs.readFileSync(closePlanPath, 'utf8'));
    const legit = packer.computeArtifacts(plan);
    // (1) 旧布局（server/ 根散文件）→ 不变量写前拒绝
    const fnKeys = [...legit.keys()].filter(k => k.startsWith('server/scheduleSandbox/'));
    const legacyMap = new Map(fnKeys.map(k => [k.replace('server/scheduleSandbox/', 'server/'), legit.get(k)]));
    let legacyErr = null;
    try { packer.assertCloseMappingInvariants(legacyMap); } catch (e) { legacyErr = e; }
    assert.ok(legacyErr && legacyErr.code === packer.ERR.CLOSE_SOURCE_INVALID, '旧布局必须拒绝');
    assert.ok(/无法映射到同名函数/.test(legacyErr.message), legacyErr.message);
    // (2) 函数目录缺 package.json → 拒绝
    const noPkg = new Map(fnKeys.map(k => [k, legit.get(k)]).filter(([k]) => k !== 'server/scheduleSandbox/package.json'));
    let noPkgErr = null;
    try { packer.assertCloseMappingInvariants(noPkg); } catch (e) { noPkgErr = e; }
    assert.ok(noPkgErr && /同名函数子目录缺少制品/.test(noPkgErr.message), noPkgErr && noPkgErr.message);
    // (3) checkDir 拒绝盘上根下散文件（额外文件）且不删除
    const outDir = outDirFor('stray');
    packer.build(closePlanPath, outDir);
    fs.writeFileSync(path.join(outDir, 'close', 'server', 'stray-legacy.js'), Buffer.from('// stray\n'));
    const r = packer.checkDir(outDir);
    assert.equal(r.ok, false, '根下散文件必须拒绝');
    assert.ok(r.problems.some(x => /额外文件：close\/server\/stray-legacy\.js/.test(x)), JSON.stringify(r.problems));
    assert.equal(fs.existsSync(path.join(outDir, 'close', 'server', 'stray-legacy.js')), true, 'check 不删除');
    // (4) 正常对照 + 完整复用 + 关闭文件续建
    const okDir = outDirFor('ok');
    const first = packer.build(closePlanPath, okDir);
    assert.equal(packer.checkDir(okDir).ok, true);
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    assert.equal(packer.checkCloseDir(okDir).ok, true);
    delete process.env.PIC_CLOSE_SOURCE_DIR;
    const reused = packer.build(closePlanPath, okDir);
    assert.equal(reused.io.filter(x => x.action === 'written').length, 0, '完整复用零新写');
    const resumeDir = outDirFor('resume');
    const rb = packer.build(closePlanPath, resumeDir);
    const aCloseFile = rb.manifest.closePackage.files[0].rel;
    fs.unlinkSync(path.join(resumeDir, 'close', aCloseFile));
    const resumed = packer.build(closePlanPath, resumeDir);
    assert.equal(resumed.io.filter(x => x.action === 'written').length, 1, '关闭文件续建补 1');
    assert.equal(packer.checkDir(resumeDir).ok, true);
    return {
      legacyLayoutRejected: legacyErr.code,
      missingPackageJsonRejected: true,
      strayFileCheckRejected: true,
      strayFileNotDeleted: true,
      reuseWritten: 0,
      resumeWritten: 1,
      firstBuildTotal: first.manifest.closePackage.files.length
    };
  });

  // ── M4：口径声明（C2/C3）──
  await probe('M4_evidence_labels_and_version_boundary', async () => {
    // 核心与打包器运行时摘要（本轮修改以此定位，而非 reviewedCommit 字段）
    const implSha = sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs')));
    const packerSha = sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs')));
    // V 组占位已删（源文件不含旧占位语句）
    const testSrc = fs.readFileSync(path.join(ROOT, 'miniapp/tests/participant-identity-check.test.cjs'), 'utf8');
    assert.equal(testSrc.includes('占位（下方用 rChecker 风格）'), false, 'V 组占位语句必须已删除');
    return {
      labels: {
        reviewedCommit: 'c9df59b（I1/I2 前置核验提交，受审对象）',
        reviewedBaseline: '5c54c89（Codex 复查提交，接手基线）',
        runtimeImplSha256: implSha,
        runtimePackerSha256: packerSha,
        note: '本轮新增/修改内容以运行时内容摘要精确定位；历史证据 JSON 不改写'
      },
      versionBoundary: {
        declared: '~2.6.3',
        locallyVerified: '3.0.1（本机唯一可执行副本；包装层 + @cloudbase/database 1.4.1）',
        wording: 'CHANGELOG 未列数据库 API 行为变更——不等于证明字节或行为相同',
        targetVersionVerified: false,
        deploymentPrecheck: '部署前须在不暴露凭据条件下核对实际随候选运行的精确依赖版本及三种转换；无法取得即保留阻断'
      },
      placeholderRemoved: true
    };
  });

  assert.equal(guardHits.length, sensitivityHits, '业务期不得尝试网络或子进程（含被 catch 者）');
  return {
    schema: 'wb-participant-identity-close-mapping-evidence/1',
    reviewedCommit: 'c9df59b',
    reviewedBaseline: '5c54c89',
    implementationSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
    packerSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    verificationKind: '本地合成验证：实际生成链（模板→打包器→候选+配对关闭包）+ 合成 wx/db/时钟；不证明真实上传、远端关闭覆盖与回读',
    versionBoundary: {
      locallyVerifiedSdk: 'wx-server-sdk 3.0.1（本机唯一可执行副本）',
      declaredSdk: '~2.6.3（候选 package.json 声明）',
      preciseTargetVersionVerified: false,
      changelogWord: 'CHANGELOG 未列数据库 API 行为变更（不等于行为相同证明）'
    },
    results,
    guardAccounting: {
      sensitivityProbeHits: sensitivityHits,
      businessPeriodUnexpectedAttempts: guardHits.length - sensitivityHits,
      caughtAttemptsCounted: true
    },
    summary: {
      total: results.length,
      assertionsPassed: results.filter(r => r.assertionsPassed).length,
      unexpectedGuardAttempts: guardHits.length - sensitivityHits
    }
  };
}

main().then(report => {
  const body = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2] === '--out' && process.argv[3] && process.argv.length === 4) {
    fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
    process.stdout.write('WB evidence written\n');
  } else if (process.argv.length === 2) {
    process.stdout.write(body);
  } else {
    throw new Error('usage: node evidence.cjs [--out <new-path>]');
  }
  if (report.summary.assertionsPassed !== report.summary.total ||
      report.summary.unexpectedGuardAttempts !== 0) {
    process.exitCode = 1;
  }
}).catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
}).finally(() => {
  for (const fn of restore.reverse()) fn();
});
