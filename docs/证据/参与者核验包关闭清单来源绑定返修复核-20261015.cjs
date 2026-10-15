'use strict';
// WorkBuddy 独立证据：关闭清单来源绑定定点返修（Codex 复查 be31af2 C1-a）。
// 全程离线合成验证：实际生成链 + 合成 wx/db/时钟；不调用真实 SDK 平台、不部署、不写库。
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
const WORK = path.join(OUT_ROOT, 'wb-pic-manifestbind-' + RUN);
fs.mkdirSync(WORK, { recursive: true });
let seq = 0;
const outDirFor = tag => path.join(OUT_ROOT, 'participant-identity-wb-bind-' + tag + '-' + RUN.slice(-8) + '-' + (++seq));
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

  // ── B0：受审关闭包来源 ──
  let closeSource = null;
  await probe('B0_source_verified_unchanged_tool', async () => {
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
    assert.equal(business.checkCloseDir(closeSource).ok, true);
    return { sourceCheckOk: true };
  });

  // ── B1：合法对照 + Codex 反例不再复现（sourceRel/mapping 篡改现在拒绝） ──
  let closePlanPath = null;
  await probe('B1_manifest_binding_rejects_forgery', async () => {
    const starts = Date.now() - 60000;
    closePlanPath = writeJson(WORK, 'identity-plan.json', {
      schema: packer.PLAN_SCHEMA, synthetic: true, checkRoundId: 'wb-bind-' + RUN.slice(0, 12),
      participantCode: '1', appId: APPID, envId: ENV_ID,
      functionName: core.FIXED_TARGET.functionName, collection: core.FIXED_TARGET.collection,
      passphraseDigest: sha('synthetic-wb-pass-' + RUN),
      windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 600000).toISOString(),
      closeSourceDir: closeSource, note: 'WorkBuddy manifest-binding synthetic fixture'
    });
    const outDir = outDirFor('candidate');
    const built = packer.build(closePlanPath, outDir);
    const manifestPath = path.join(outDir, 'manifest.json');
    const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // (1) 合法对照
    assert.equal(packer.checkDir(outDir).ok, true, JSON.stringify(r => r));
    assert.equal(original.closePackage.mapping, packer.CLOSE_MAPPING_DECLARATION, 'mapping 固定声明');
    // (2) Codex 反例复现尝试：sourceRel 篡改 + mapping 篡改 → 现在必须拒绝
    const altered = structuredClone(original);
    altered.closePackage.files[0].sourceRel = 'server/nonexistent.js';
    altered.closePackage.mapping = 'unrelated mapping';
    fs.writeFileSync(manifestPath, JSON.stringify(altered, null, 2) + '\n');
    const accepted = packer.checkDir(outDir);
    assert.equal(accepted.ok, false, 'sourceRel/mapping 篡改必须拒绝（C1-a 修复）');
    assert.ok(accepted.problems.some(x => /字段与受审来源重建不符（sourceRel）/.test(x)),
      'sourceRel 分类：' + JSON.stringify(accepted.problems));
    assert.ok(accepted.problems.some(x => /closePackage.mapping 与受审固定映射声明不一致/.test(x)),
      'mapping 分类');
    // (3) 对照：bytes 篡改仍拒绝（既有字节校验保留）
    altered.closePackage.files[0].bytes++;
    fs.writeFileSync(manifestPath, JSON.stringify(altered, null, 2) + '\n');
    assert.equal(packer.checkDir(outDir).ok, false, 'bytes 篡改对照仍拒绝');
    return {
      legitimateCheckOk: true,
      mappingDeclaration: original.closePackage.mapping,
      sourceRelTamperNowRejected: true,
      mappingTamperNowRejected: true,
      bytesTamperControlRejected: true,
      closeFileCount: built.manifest.closePackage.files.length
    };
  });

  // ── B2：缺字段/未知字段/伪造条目/缺条目 全矩阵拒绝 ──
  await probe('B2_manifest_field_matrix_rejected', async () => {
    const outDir = outDirFor('matrix');
    packer.build(closePlanPath, outDir);
    const manifestPath = path.join(outDir, 'manifest.json');
    const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const rewrite = obj => fs.writeFileSync(manifestPath, JSON.stringify(obj, null, 2) + '\n');
    const attempts = [
      ['缺 sourceRel', orig => { delete orig.closePackage.files[0].sourceRel; }, /字段与受审来源重建不符（sourceRel）/],
      ['未知字段', orig => { orig.closePackage.files[0].note = 'extra'; }, /含未知字段（note）/],
      ['伪造条目', orig => { orig.closePackage.files.push({ rel: 'server/fake.js', sourceRel: 'server/fake.js', bytes: 3, sha256: '0'.repeat(64) }); }, /无法由受审来源重建：server\/fake\.js/],
      ['缺条目', orig => { orig.closePackage.files.splice(0, 1); }, /关闭清单缺少来源映射条目/]
    ];
    const outcomes = [];
    for (const [label, mutate, expectRe] of attempts) {
      const tam = structuredClone(original);
      mutate(tam);
      rewrite(tam);
      const r = packer.checkDir(outDir);
      assert.equal(r.ok, false, label + ' 必须拒绝');
      assert.ok(r.problems.some(x => expectRe.test(x)), label + ' 分类：' + JSON.stringify(r.problems));
      outcomes.push({ label, rejected: true });
      rewrite(original); // 还原
    }
    assert.equal(packer.checkDir(outDir).ok, true, '全部还原后合法对照');
    return { attempts: outcomes, allRestoredLegit: true };
  });

  // ── B3：独立 checkCloseDir / 复用 / 续建 无回归 ──
  await probe('B3_no_regression_close_reuse_resume', async () => {
    const outDir = outDirFor('regression');
    packer.build(closePlanPath, outDir);
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    try {
      const realNow = Date.now;
      let r1 = null;
      Date.now = () => NaN;
      try { r1 = packer.checkCloseDir(outDir); } finally { Date.now = realNow; }
      assert.equal(r1.ok, true, 'NaN 时钟独立校验：' + JSON.stringify(r1.problems));
      assert.equal(r1.files, r1.expectedFiles);
    } finally {
      delete process.env.PIC_CLOSE_SOURCE_DIR;
    }
    const reused = packer.build(closePlanPath, outDir);
    assert.equal(reused.io.filter(x => x.action === 'written').length, 0, '完整复用零新写');
    const resumeDir = outDirFor('resume');
    const rb = packer.build(closePlanPath, resumeDir);
    fs.unlinkSync(path.join(resumeDir, 'close', rb.manifest.closePackage.files[0].rel));
    const resumed = packer.build(closePlanPath, resumeDir);
    assert.equal(resumed.io.filter(x => x.action === 'written').length, 1, '续建补 1');
    assert.equal(packer.checkDir(resumeDir).ok, true);
    return { independentCheckOk: true, reuseWritten: 0, resumeWritten: 1 };
  });

  assert.equal(guardHits.length, sensitivityHits, '业务期不得尝试网络或子进程（含被 catch 者）');
  return {
    schema: 'wb-participant-identity-manifest-binding-evidence/1',
    reviewedCommit: '10e47f9',
    reviewedBaseline: 'be31af2',
    implementationSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
    packerSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    verificationKind: '本地合成验证：实际生成链（模板→打包器→候选+关闭包）+ 合成 wx/db/时钟；不证明真实上传、远端关闭覆盖与回读',
    versionBoundary: {
      locallyVerifiedSdk: 'wx-server-sdk 3.0.1（本机唯一可执行副本）',
      declaredSdk: '~2.6.3（候选 package.json 声明）',
      preciseTargetVersionVerified: false,
      changelogWord: 'CHANGELOG 未列数据库 API 行为变更（不等于行为相同证明）'
    },
    codexCounterexample: {
      script: 'docs/证据/Codex参与者关闭映射清单反例-20261015.cjs',
      reproExitCodeAfterFix: 1,
      note: '修复后 Codex 反例脚本的 accepted.ok===true 断言不再成立（exit 1），即 sourceRel/mapping 篡改已被精确校验拒绝'
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
