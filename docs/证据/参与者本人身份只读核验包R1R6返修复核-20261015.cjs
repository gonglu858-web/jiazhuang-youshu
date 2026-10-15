'use strict';
// 两位参与者「本人身份只读核验包」R1–R6 定点返修 · 独立复核证据（2026-10-15）。
//
// 依据：docs/Codex复查-参与者本人身份只读核验包-20261015.md §3（受审 39ac526，复查 ece7659）
//
// 性质：离线合成验证——真实本地应用代码 ＋ 合成 wx/db/时钟；
// **SDK 本地转换未执行；真实平台/真实三账号/真实部署完全未验证**。
// 每项均为「修复后正确拒绝 + 合法对照」直接断言；**不以旧反例脚本不再复现作为闭合**。
// 口令为 synthetic 样本，仅验证准入路径；不生成真实口令、不落证据。
//
// 守卫记账：敏感性探针（F0）单独记账；其后业务期任何命中（含被 catch 的）
// 计入 businessUnexpected 并使验证失败（exit 1）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '../..');
const guardHits = [];
const restore = [];
function guard(mod, name) {
  if (typeof mod[name] !== 'function') return;
  const old = mod[name];
  mod[name] = function () { guardHits.push(name); throw new Error('LOCAL_REVIEW_BLOCKED'); };
  restore.push(() => { mod[name] = old; });
}
for (const id of ['node:http', 'node:https']) {
  const mod = require(id); for (const name of ['request', 'get']) guard(mod, name);
}
for (const name of ['connect', 'createConnection']) guard(require('node:net'), name);
guard(require('node:net').Socket.prototype, 'connect');
guard(require('node:tls'), 'connect');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), name); guard(require('node:dns').promises, name);
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  guard(require('node:child_process'), name);
}
guard(globalThis, 'fetch');

const corePath = path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs');
const packerPath = path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs');
const core = require(corePath);
const packer = require(packerPath);
const businessTool = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const { APPID, ENV_ID } = require(path.join(ROOT, 'miniapp/tests/helpers/sandbox-entry-loader.cjs'));

const sha256Buffer = b => crypto.createHash('sha256').update(b).digest('hex');
const implementationSha256 = sha256Buffer(fs.readFileSync(corePath));
const packerSha256 = sha256Buffer(fs.readFileSync(packerPath));

const OUT_ROOT = path.join(ROOT, 'artifacts/schedule-sandbox/business-test');
const RUN = 'pic-r1r6-' + crypto.randomUUID();
const WORK = path.join(OUT_ROOT, RUN);
fs.mkdirSync(WORK, { recursive: true });

const results = [];
let seq = 0;
let sensitivityHits = 0;
let outSeq = 0;
const ROUND = 'synthetic-round-r1r6-' + RUN.slice(-8);
const PASSPHRASE = 'synthetic-r1r6-passphrase-' + crypto.randomBytes(8).toString('hex');
const DIGEST = sha256Buffer(Buffer.from(PASSPHRASE));
const OPENID = 'synthetic-r1r6-context';
const USER_ID = core.deriveUserId(APPID, OPENID);

// ── 夹具 ────────────────────────────────────────────────────────────────────
function put(obj) {
  const f = path.join(WORK, 'fx-' + (++seq) + '.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), { flag: 'wx' });
  return f;
}
function outDirFor(tag) {
  return path.join(OUT_ROOT, packer.OUT_PREFIX + tag + '-' + RUN.slice(-8) + '-' + (++outSeq));
}
let closeSeq = 0;
function makeCloseSourceDir() {
  // 每次独立来源目录：避免复用导致「内容不同不覆盖」
  const tag = 'close-src-' + RUN.slice(-6) + '-' + (++closeSeq);
  const round = 'synthetic-close-' + RUN.slice(-8) + '-' + closeSeq;
  const planPath = put({
    schema: 'business-test-plan/1', window: 'P', synthetic: true,
    businessRoundId: round, windowNo: 'P-01', appId: APPID, envId: ENV_ID,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(r => [r, {
      userId: 'u_' + sha256Buffer(Buffer.from(APPID + ':synthetic-' + r + RUN)).slice(0, 40),
      source: 'synthetic 夹具（不代表真实人员）'
    }])),
    projectReadyMarker: 'ready-' + round,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
  });
  const outDir = path.join(WORK, tag);
  const built = businessTool.build('P', planPath, outDir);
  assert.equal(businessTool.checkCloseDir(built.outDir).ok, true, '关闭包来源须通过未改 checkCloseDir');
  return built.outDir;
}
function writePlan(closeSourceDir, overrides) {
  const o = overrides || {};
  const starts = o.windowStartsAtMs === undefined ? Date.now() - 60000 : o.windowStartsAtMs;
  const file = path.join(WORK, 'plan-' + (++seq) + '.json');
  const base = {
    schema: packer.PLAN_SCHEMA, synthetic: true,
    checkRoundId: ROUND, participantCode: '1',
    appId: APPID, envId: ENV_ID, functionName: 'scheduleSandbox', collection: 'schtest_v1_users',
    passphraseDigest: DIGEST,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString(),
    closeSourceDir,
    note: '合成夹具计划（synthetic；非真实口令、非真实核验）'
  };
  const merged = Object.assign(base, o.plan || {});
  // 顶层覆盖同样生效（synthetic 与窗口 ISO）
  for (const k of ['synthetic', 'windowStartsAtIso', 'windowExpiresAtIso', 'checkRoundId', 'participantCode', 'closeSourceDir']) {
    if (o[k] !== undefined) merged[k] = o[k];
  }
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { flag: 'wx' });
  return file;
}
/** 读边界替身：记录集合/主键/投影/读取次数与写方法尝试。 */
function makeDb(options) {
  const o = options || {};
  const calls = { collections: [], docs: [], fields: [], gets: 0, writeAttempts: 0 };
  const trap = name => () => { calls.writeAttempts++; throw new Error('TRAP 写/事务：' + name); };
  const docRef = {
    field(fields) { calls.fields.push(fields); return docRef; },
    async get() {
      calls.gets++;
      if (o.readError) throw o.readError;
      if (o.afterRead) o.afterRead();
      return { data: typeof o.rows === 'function' ? o.rows() : o.rows };
    },
    set: trap('doc.set'), update: trap('doc.update'), remove: trap('doc.remove')
  };
  const db = {
    collection(name) {
      calls.collections.push(name);
      if (o.collectionError) throw o.collectionError;
      return {
        doc(id) { calls.docs.push(id); return docRef; },
        add: trap('collection.add'), where: trap('collection.where')
      };
    },
    set: trap('db.set'), update: trap('db.update'), remove: trap('db.remove'),
    runTransaction: trap('db.runTransaction'), startTransaction: trap('db.startTransaction')
  };
  return { db, calls };
}
function makeChecker(db, o) {
  const cfg = o || {};
  const starts = cfg.windowStartsAtMs === undefined ? 1000 : cfg.windowStartsAtMs;
  const expires = cfg.windowExpiresAtMs === undefined ? starts + 600000 : cfg.windowExpiresAtMs;
  return core.createIdentityChecker({
    db,
    trusted: cfg.trusted === undefined ? { appId: APPID, envId: ENV_ID, openid: OPENID } : cfg.trusted,
    config: {
      checkRoundId: cfg.checkRoundId === undefined ? ROUND : cfg.checkRoundId,
      passphraseDigest: DIGEST,
      windowStartsAtMs: starts,
      windowExpiresAtMs: expires
    },
    now: cfg.now || (() => starts + 1000)
  });
}
const row = (patch) => Object.assign({ _id: USER_ID, openid: OPENID, status: 'active' }, patch || {});
const req = (extra) => Object.assign({ action: 'inspectSelf', passphrase: PASSPHRASE, checkRoundId: ROUND }, extra || {});
function withClock(value, fn) {
  const old = Date.now;
  Date.now = typeof value === 'function' ? value : () => value;
  try { return fn(); } finally { Date.now = old; }
}

async function probe(id, fn) {
  try {
    results.push({ id, assertionsPassed: true, actual: await fn() });
  } catch (e) {
    results.push({ id, assertionsPassed: false, error: e.message });
  }
}

async function main() {
  // F0：守卫敏感性探针（实际触发，单独记账）
  await probe('F0_guard_sensitivity', async () => {
    for (const fn of [
      () => require('node:https').request('https://example.invalid'),
      () => require('node:child_process').spawn('node', [])
    ]) assert.throws(fn, /LOCAL_REVIEW_BLOCKED/);
    sensitivityHits = guardHits.length;
    return { sensitivityProbeHits: sensitivityHits, note: '敏感性探针实际触发并单独记账' };
  });

  const closeSource = makeCloseSourceDir();

  // F1（R1）：项目配置与实际目录一致 + 布局显式校验
  await probe('F1_r1_project_layout', async () => {
    const outDir = outDirFor('r1');
    packer.build(writePlan(closeSource), outDir);
    const cfg = JSON.parse(fs.readFileSync(path.join(outDir, 'project.config.json'), 'utf8'));
    assert.equal(cfg.miniprogramRoot, 'frontend/');
    assert.equal(cfg.cloudfunctionRoot, 'server/');
    // 声明的根目录必须真实存在（C02 反例的直接反证）
    assert.equal(fs.existsSync(path.join(outDir, cfg.miniprogramRoot)), true);
    assert.equal(fs.existsSync(path.join(outDir, cfg.cloudfunctionRoot)), true);
    assert.equal(fs.existsSync(path.join(outDir, 'frontend', 'miniprogram')), false, '不得残留旧目录名');
    assert.equal(cfg.appid, APPID);
    // 唯一页面与四件套
    const appJson = JSON.parse(fs.readFileSync(path.join(outDir, 'frontend', 'app.json'), 'utf8'));
    assert.equal(appJson.pages.length, 1);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.equal(fs.existsSync(path.join(outDir, 'frontend', appJson.pages[0] + '.' + ext)), true, '页面 ' + ext);
    }
    // 依赖闭包与固定函数目标
    const pageSrc = fs.readFileSync(path.join(outDir, 'frontend', appJson.pages[0] + '.js'), 'utf8');
    assert.ok(pageSrc.includes("require('../../utils/identity-check-client')"));
    const clientSrc = fs.readFileSync(path.join(outDir, 'frontend', 'utils', 'identity-check-client.js'), 'utf8');
    assert.ok(clientSrc.includes("require('../config/cloud')"));
    const cloudSrc = fs.readFileSync(path.join(outDir, 'frontend', 'config', 'cloud.js'), 'utf8');
    assert.ok(cloudSrc.includes("identityCheckFunction: 'scheduleSandbox'"));
    assert.ok(cloudSrc.includes("envId: '" + ENV_ID + "'"));
    // 服务端装配后的固定目标常量
    const entry = fs.readFileSync(path.join(outDir, 'server', 'index.js'), 'utf8');
    assert.ok(entry.includes("const CONFIG_APP_ID = '" + APPID + "';"));
    assert.ok(entry.includes("const CONFIG_ENV_ID = '" + ENV_ID + "';"));
    // 反例：配置根指回不存在目录 → 装配拒绝且零产物
    const cfgPath = path.join(packer.TEMPLATE_DIR, 'project.config.json');
    const realRead = fs.readFileSync;
    const original = realRead.call(fs, cfgPath);
    fs.readFileSync = function (p, ...args) {
      if (typeof p === 'string' && path.resolve(p) === cfgPath) {
        const bad = JSON.parse(original.toString('utf8'));
        bad.miniprogramRoot = 'miniprogram/';
        const buf = Buffer.from(JSON.stringify(bad, null, 2));
        return typeof args[0] === 'string' ? buf.toString(args[0]) : buf;
      }
      return realRead.call(this, p, ...args);
    };
    const badOut = outDirFor('r1-bad');
    let err = null;
    try { packer.build(writePlan(closeSource), badOut); } catch (e) { err = e; } finally { fs.readFileSync = realRead; }
    assert.ok(err, '配置根不一致必须拒绝');
    assert.equal(err.code, packer.ERR.SOURCE_DRIFT);
    assert.equal(fs.existsSync(badOut), false, '拒绝必须零产物');
    // 原项目配置保持不变
    const repoCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniapp', 'project.config.json'), 'utf8'));
    assert.equal(repoCfg.miniprogramRoot, 'miniprogram/', '原 miniapp/project.config.json 不得被迁就修改');
    return {
      miniprogramRoot: cfg.miniprogramRoot, cloudfunctionRoot: cfg.cloudfunctionRoot,
      rootsExist: true, uniquePage: appJson.pages[0], dependencyClosureResolvable: true,
      fixedFunctionTarget: 'scheduleSandbox', fixedEnvTarget: ENV_ID,
      inconsistentConfigRejected: true, zeroArtifactsOnReject: true,
      repoProjectConfigUnchanged: true
    };
  });

  // F2（R2）：受控完整 userId 交付
  await probe('F2_r2_full_userid_delivery', async () => {
    // 默认：只尾号
    const plain = await makeChecker(makeDb({ rows: [row()] }).db).handle(req());
    assert.equal(plain.registrationState, 'ACTIVE');
    assert.equal(plain.userId, null, '默认不得返回完整 userId');
    assert.equal(plain.userIdTail, USER_ID.slice(-6));
    // 显式请求 + 有效结果 → 完整内部 ID（含 ABSENT：需要它才能做受限登记）
    const matrix = [];
    for (const [label, rows, state] of [
      ['ACTIVE', [row()], 'ACTIVE'],
      ['ABSENT', [], 'ABSENT'],
      ['DISABLED', [row({ status: 'disabled' })], 'DISABLED'],
      ['MISMATCH', [row({ openid: 'someone-else' })], 'MISMATCH']
    ]) {
      const r = await makeChecker(makeDb({ rows }).db).handle(req({ includeFullUserId: true }));
      assert.equal(r.registrationState, state, label);
      assert.equal(r.userId, USER_ID, label + ' 必须能取得完整内部 userId');
      assert.match(r.userId, /^u_[0-9a-f]{40}$/);
      assert.equal(r.checkRoundId, ROUND, label + ' 轮次关联');
      assert.ok(r.serverTimeIso && r.serverTimeIso.length > 0, label + ' 时间关联');
      const text = JSON.stringify(r);
      for (const banned of ['openid', 'OPENID', 'unionid', 'UNIONID', 'AKID', 'secretKey', 'sessionToken', PASSPHRASE]) {
        assert.equal(text.includes(banned), false, label + ' 结果不得含 ' + banned);
      }
      matrix.push({ label, state, userIdDelivered: true, tailLength: r.userIdTail.length });
    }
    // 失败结果不得成为可采信绑定
    for (const [label, dbOpts, reqOpts, trusted] of [
      ['缺上下文', { rows: [row()] }, {}, { appId: APPID, envId: ENV_ID, openid: '' }],
      ['读失败', { rows: [], readError: new Error('synthetic failure') }, {}, undefined]
    ]) {
      const r = await makeChecker(makeDb(dbOpts).db, trusted ? { trusted } : {}).handle(req({ includeFullUserId: true, ...reqOpts }));
      assert.equal(r.ok, false, label);
      assert.equal(r.identityConfirmed, false, label);
      assert.equal(r.userId, null, label + ' 不得交付完整 ID');
      assert.equal(r.registrationState, 'UNKNOWN', label);
    }
    return {
      defaultDeliversTailOnly: true,
      fullIdStates: matrix,
      failureNeverDeliversFullId: true,
      neverReturnsOpenidUnionidPassphraseCredentials: true,
      roundAndTimeCorrelated: true
    };
  });

  // F3（R3）：受审内容基线钉定
  await probe('F3_r3_pinned_source_baseline', async () => {
    const planPath = writePlan(closeSource);
    const outDir = outDirFor('r3-ok');
    packer.build(planPath, outDir);
    assert.equal(packer.checkDir(outDir).ok, true, '正常对照');
    const realRead = fs.readFileSync;
    const driftCases = [];
    for (const [label, target] of [
      ['核心模块', corePath],
      ['页面模板', path.join(packer.TEMPLATE_DIR, 'frontend', 'pages', 'identity-check', 'identity-check.js')],
      ['客户端模板', path.join(packer.TEMPLATE_DIR, 'frontend', 'utils', 'identity-check-client.js')],
      ['项目配置模板', path.join(packer.TEMPLATE_DIR, 'project.config.json')]
    ]) {
      const original = realRead.call(fs, target);
      const drifted = Buffer.concat([original, Buffer.from('\n// synthetic drift\n')]);
      fs.readFileSync = function (p, ...args) {
        if (typeof p === 'string' && path.resolve(p) === target) {
          return typeof args[0] === 'string' ? drifted.toString(args[0]) : drifted;
        }
        return realRead.call(this, p, ...args);
      };
      const dir = outDirFor('r3-drift');
      let buildErr = null;
      try { packer.build(planPath, dir); } catch (e) { buildErr = e; } finally { fs.readFileSync = realRead; }
      assert.ok(buildErr, label + ' 漂移时 build 必须拒绝');
      assert.equal(buildErr.code, packer.ERR.SOURCE_DRIFT, label + ' 实际 ' + buildErr.code);
      assert.equal(fs.existsSync(dir), false, label + ' 拒绝必须零产物');
      assert.equal(sha256Buffer(fs.readFileSync(target)), sha256Buffer(original), label + ' 磁盘源必须零改动');
      driftCases.push({ label, rejectedWith: buildErr.code, zeroArtifacts: true, diskSourceUnchanged: true });
    }
    // check 侧也必须拒绝漂移
    fs.readFileSync = function (p, ...args) {
      if (typeof p === 'string' && path.resolve(p) === corePath) {
        const drifted = Buffer.concat([realRead.call(fs, p), Buffer.from('\n// drift\n')]);
        return typeof args[0] === 'string' ? drifted.toString(args[0]) : drifted;
      }
      return realRead.call(this, p, ...args);
    };
    let checkResult = null, checkErr = null;
    try { checkResult = packer.checkDir(outDir); } catch (e) { checkErr = e; } finally { fs.readFileSync = realRead; }
    if (checkErr) {
      assert.equal(checkErr.code, packer.ERR.SOURCE_DRIFT);
    } else {
      assert.equal(checkResult.ok, false, 'check 必须拒绝漂移');
      assert.ok(checkResult.problems.some(x => /漂移|基线/.test(x)), 'check 须报告漂移：' + JSON.stringify(checkResult.problems));
    }
    // 正常复用/续建仍成立
    const reuse = packer.build(planPath, outDir);
    assert.equal(reuse.io.filter(x => x.action === 'written').length, 0, '完整复用零新写');
    assert.equal(reuse.io.filter(x => x.action === 'reused').length, 38, '复用 38');
    const rp = writePlan(closeSource);
    const resumeDir = outDirFor('r3-resume');
    const rb = packer.build(rp, resumeDir);
    fs.unlinkSync(path.join(resumeDir, rb.manifest.files[0].rel));
    const resumed = packer.build(rp, resumeDir);
    assert.equal(resumed.io.filter(x => x.action === 'written').length, 1, '续建补 1');
    assert.equal(resumed.io.filter(x => x.action === 'reused').length, 37, '复用 37');
    return { driftCases, checkAlsoRejects: true, fullReuse: { written: 0, reused: 38 }, resume: { written: 1, reused: 37 } };
  });

  // F4（R4）：check 所有早退返回原始拒绝分类
  await probe('F4_r4_check_early_returns', async () => {
    // 独立关闭来源：破坏性用例不得影响其它探针
    const f4Source = makeCloseSourceDir();
    const outDir = outDirFor('r4');
    packer.build(writePlan(f4Source), outDir);
    const startMs = Date.now();
    const realPlanPath = writePlan(f4Source, {
      synthetic: false,
      windowStartsAtIso: new Date(startMs - 600000).toISOString(),
      windowExpiresAtIso: new Date(startMs + 600000).toISOString()
    });
    const realOut = outDirFor('r4-real');
    packer.build(realPlanPath, realOut);
    // 该真实包的窗口：[startMs-600000, startMs+600000]；过期取值必须晚于截止
    const expired = withClock(startMs + 900000, () => packer.checkDir(realOut));
    const cases = [];
    // (1) 过期 / NaN / 时钟抛错
    cases.push(['expired', expired, /WINDOW_EXPIRED/]);
    const nan = withClock(NaN, () => packer.checkDir(realOut));
    cases.push(['nan', nan, /CLOCK_INVALID/]);
    const boom = withClock(() => { throw new Error('synthetic clock failed'); }, () => packer.checkDir(realOut));
    cases.push(['clockThrow', boom, /CLOCK_ERROR/]);
    // (2) 计划哈希不符
    const planOnDisk = path.join(outDir, 'plan.json');
    const saved = fs.readFileSync(planOnDisk);
    fs.writeFileSync(planOnDisk, Buffer.concat([saved, Buffer.from(' ')]));
    const hashMismatch = packer.checkDir(outDir);
    fs.writeFileSync(planOnDisk, saved);
    cases.push(['planHashMismatch', hashMismatch, /planSha256/]);
    // (3) 缺计划
    const noPlanDir = outDirFor('r4-noplan');
    fs.mkdirSync(noPlanDir, { recursive: true });
    fs.writeFileSync(path.join(noPlanDir, 'manifest.json'), JSON.stringify({
      schema: packer.MANIFEST_SCHEMA, planSha256: 'x',
      files: [{ rel: 'plan.json', bytes: 1, sha256: '0'.repeat(64) }], closePackage: { files: [] }
    }));
    cases.push(['missingPlan', packer.checkDir(noPlanDir), /缺少目录内计划/]);
    // (4) 非法计划（同步哈希后仍须被计划校验拒绝）
    const badDir = outDirFor('r4-badplan');
    packer.build(writePlan(f4Source), badDir);
    const planObj = JSON.parse(fs.readFileSync(path.join(badDir, 'plan.json'), 'utf8'));
    planObj.collection = 'users';
    const badBytes = Buffer.from(JSON.stringify(planObj, null, 2) + '\n');
    const bm = JSON.parse(fs.readFileSync(path.join(badDir, 'manifest.json'), 'utf8'));
    bm.planSha256 = sha256Buffer(badBytes);
    fs.writeFileSync(path.join(badDir, 'plan.json'), badBytes);
    fs.writeFileSync(path.join(badDir, 'manifest.json'), JSON.stringify(bm, null, 2));
    cases.push(['invalidPlan', packer.checkDir(badDir), /计划校验失败/]);
    // (5) 来源重建失败（最后执行：破坏性）
    const srcDir = outDirFor('r4-nosrc');
    packer.build(writePlan(f4Source), srcDir);
    assert.equal(packer.checkDir(srcDir).ok, true, '破坏前正常对照');
    const closeDirPath = path.join(f4Source, 'close');
    fs.rmSync(closeDirPath, { recursive: true, force: true });
    const srcFail = packer.checkDir(srcDir);
    fs.mkdirSync(closeDirPath, { recursive: true });
    cases.push(['sourceFailure', srcFail, /来源重建失败/]);
    // 断言：每类都返回结构化结果、保留原始分类、无 ReferenceError
    const detail = [];
    for (const [label, r, pattern] of cases) {
      assert.equal(r instanceof ReferenceError, false, label + ' 不得抛 ReferenceError');
      assert.equal(Array.isArray(r.problems), true, label + ' 必须有 problems');
      assert.equal(r.ok, false, label + ' 必须失败');
      assert.equal(r.planChecked, false, label + ' planChecked 不得为 true');
      assert.ok(r.problems.some(x => pattern.test(x)), label + ' 必须保留原分类：' + JSON.stringify(r.problems));
      detail.push({ label, ok: r.ok, planChecked: r.planChecked, firstProblem: r.problems[0].slice(0, 90) });
    }
    // 正常对照：用**独立且未被破坏**的关闭来源构建
    const controlSrc = makeCloseSourceDir();
    const controlOut = outDirFor('r4-control');
    packer.build(writePlan(controlSrc), controlOut);
    assert.equal(packer.checkDir(controlOut).ok, true, '合成包正常对照');
    // 真实模式对照：另建独立来源（f4Source 的 close 已被本用例清空）
    const realControlSrc = makeCloseSourceDir();
    const realControlPlan = writePlan(realControlSrc, {
      synthetic: false,
      windowStartsAtIso: new Date(Date.now() - 600000).toISOString(),
      windowExpiresAtIso: new Date(Date.now() + 600000).toISOString()
    });
    const realControlOut = outDirFor('r4-real-control');
    packer.build(realControlPlan, realControlOut);
    const realControl = packer.checkDir(realControlOut);
    assert.equal(realControl.ok, true, '真实包当下有效对照：' + JSON.stringify(realControl.problems));
    return { earlyReturns: detail, noReferenceError: true, normalControlsPass: true };
  });

  // F5（R5）：时间与轮次契约
  await probe('F5_r5_time_and_round_contract', async () => {
    const f5Source = makeCloseSourceDir();
    const starts = 1000, expires = starts + 600000;
    // 核心时间边界五点
    const timePoints = [];
    for (const [label, now, expectOk, expectCode] of [
      ['未到开始', starts - 1, false, 'PIC_WINDOW_NOT_OPEN'],
      ['恰开始', starts, true, ''],
      ['窗口内', starts + 1000, true, ''],
      ['恰截止', expires, false, 'PIC_WINDOW_EXPIRED'],
      ['超过截止', expires + 1, false, 'PIC_WINDOW_EXPIRED']
    ]) {
      const { db, calls } = makeDb({ rows: [row()] });
      const r = await makeChecker(db, { windowStartsAtMs: starts, windowExpiresAtMs: expires, now: () => now }).handle(req());
      assert.equal(r.ok, expectOk, label + ' 期望 ok=' + expectOk + ' 实际 ' + r.ok);
      if (expectCode) {
        assert.equal(r.code, expectCode, label + ' 实际 ' + r.code);
        assert.equal(calls.gets, 0, label + ' 拒绝不得读库');
      }
      timePoints.push({ label, ok: r.ok, code: r.code || '', gets: calls.gets });
    }
    // 计划：expires <= starts 写前拒绝
    const windowCases = [];
    for (const [label, ms] of [['0分钟', 0], ['负1分钟', -60000]]) {
      const planPath = writePlan(f5Source, { windowExpiresAtIso: new Date(starts + ms).toISOString() });
      const dir = outDirFor('r5-win');
      let err = null;
      try { packer.build(planPath, dir); } catch (e) { err = e; }
      assert.ok(err, label + ' 窗口必须拒绝');
      assert.equal(err.code, packer.ERR.PLAN_WINDOW_INVALID);
      assert.equal(fs.existsSync(dir), false, label + ' 必须零写');
      windowCases.push({ label, rejectedWith: err.code, zeroWrite: true });
    }
    // 真实模式恰截止：build 零写拒绝；窗口内通过
    const expiryMs = Date.now() + 600000;
    const realPlanPath = writePlan(f5Source, {
      synthetic: false,
      windowStartsAtIso: new Date(expiryMs - 60000).toISOString(),
      windowExpiresAtIso: new Date(expiryMs).toISOString()
    });
    const atExpiryDir = outDirFor('r5-exact');
    let realErr = null;
    try { withClock(expiryMs, () => packer.build(realPlanPath, atExpiryDir)); } catch (e) { realErr = e; }
    assert.ok(realErr && realErr.code === packer.ERR.WINDOW_EXPIRED, '真实模式恰截止必须拒绝');
    assert.equal(fs.existsSync(atExpiryDir), false, '恰截止零写');
    const insideDir = outDirFor('r5-inside');
    let inside = null;
    withClock(expiryMs - 1000, () => {
      packer.build(realPlanPath, insideDir);
      inside = packer.checkDir(insideDir);
    });
    assert.equal(inside.ok, true, '窗口内正常对照：' + JSON.stringify(inside.problems));
    // 轮次：缺失/空/非字符串/null/错误 → 读前拒绝
    const roundCases = [];
    for (const [label, round] of [
      ['缺失', undefined], ['空串', ''], ['数字', 17], ['null', null], ['错误轮次', 'other-round-x']
    ]) {
      const payload = { action: 'inspectSelf', passphrase: PASSPHRASE };
      if (label !== '缺失') payload.checkRoundId = round;
      const { db, calls } = makeDb({ rows: [row()] });
      const r = await makeChecker(db).handle(payload);
      assert.equal(r.ok, false, label);
      assert.equal(r.code, label === '错误轮次' ? 'PIC_ROUND_MISMATCH' : 'PIC_ROUND_REQUIRED', label + ' 实际 ' + r.code);
      assert.equal(calls.gets, 0, label + ' 读前拒绝');
      assert.equal(calls.collections.length, 0, label + ' 不得访问集合');
      roundCases.push({ label, code: r.code, gets: calls.gets });
    }
    // 计划轮次 → 前端配置 → client → 服务端 全链贯通（真实生成代码解析）
    const chainDir = outDirFor('r5-chain');
    packer.build(writePlan(f5Source), chainDir);
    const cloudSrc = fs.readFileSync(path.join(chainDir, 'frontend', 'config', 'cloud.js'), 'utf8');
    assert.ok(cloudSrc.includes("checkRoundId: '" + ROUND + "'"), '前端配置必须携带本轮轮次');
    const clientSrc = fs.readFileSync(path.join(chainDir, 'frontend', 'utils', 'identity-check-client.js'), 'utf8');
    assert.ok(clientSrc.includes('checkRoundId: cloudConfig.checkRoundId'), 'client 必须原样带回轮次');
    const entrySrc = fs.readFileSync(path.join(chainDir, 'server', 'index.js'), 'utf8');
    assert.ok(entrySrc.includes("const CONFIG_CHECK_ROUND_ID = '" + ROUND + "';"), '服务端必须绑定同一轮次');
    return {
      timePoints, windowCases,
      realModeAtExpiry: 'WINDOW_EXPIRED(零写)',
      realModeInsideWindowOk: inside.ok,
      roundCases,
      roundBindingPlanToFrontendToClientToServer: true,
      round: ROUND
    };
  });

  // F6（R6）：读取边界与错误净化（四项独立）
  await probe('F6_r6_read_boundary_and_sanitisation', async () => {
    // (1) 最小字段投影
    const proj = makeDb({ rows: [row()] });
    const projected = await makeChecker(proj.db).handle(req());
    assert.equal(projected.registrationState, 'ACTIVE');
    assert.equal(proj.calls.fields.length, 1, '必须选择字段');
    assert.deepEqual(Object.keys(proj.calls.fields[0]).sort(), ['_id', 'openid', 'status'], '只投影三字段');
    assert.equal(proj.calls.gets, 1, '至多一次本人 get');
    assert.deepEqual(proj.calls.docs, [USER_ID], '只读本人主键');
    assert.deepEqual(proj.calls.collections, [core.FIXED_TARGET.collection], '只访问固定集合');
    assert.equal(proj.calls.writeAttempts, 0, '零业务写');
    // (2) readAttempted 时机
    const collFail = makeDb({ collectionError: new Error('synthetic collection failure') });
    const noAttempt = await makeChecker(collFail.db).handle(req());
    assert.equal(noAttempt.readAttempted, false, '集合构造失败不得报已读取');
    const getFail = makeDb({ readError: new Error('synthetic get failure') });
    const attempted = await makeChecker(getFail.db).handle(req());
    assert.equal(attempted.readAttempted, true, 'get 调用过必须为 true');
    // (3) 缺字段 UNKNOWN / 字段齐备不符 MISMATCH
    const missingStates = [];
    for (const key of ['_id', 'openid', 'status']) {
      const r2 = row(); delete r2[key];
      const res = await makeChecker(makeDb({ rows: [r2] }).db).handle(req());
      assert.equal(res.registrationState, 'UNKNOWN', '缺 ' + key + ' 必须 UNKNOWN');
      assert.equal(res.recordMatched, null, '缺 ' + key + ' 不得声称归属一致');
      missingStates.push({ missing: key, state: res.registrationState });
    }
    const mismatch = await makeChecker(makeDb({ rows: [row({ _id: 'u_' + '0'.repeat(40) })] }).db).handle(req());
    assert.equal(mismatch.registrationState, 'MISMATCH');
    assert.equal(mismatch.recordMatched, false);
    // (4) 错误白名单与文案净化
    const marker = 'synthetic-raw-sdk-detail-must-not-return';
    const sanitised = [];
    for (const [label, code] of [
      ['伪造白名单 code', 'PIC_READ_FAILED'],
      ['未列举 code', 'PIC_UNREVIEWED'],
      ['第三方 code', 'SDK_DATABASE_ERROR'],
      ['无 code', undefined]
    ]) {
      const err = new Error(marker);
      if (code) err.code = code;
      const res = await makeChecker(makeDb({ readError: err }).db).handle(req({ includeFullUserId: true }));
      assert.equal(res.message.includes(marker), false, label + ' 不得外传原始异常');
      assert.equal(JSON.stringify(res).includes(marker), false, label + ' 序列化后也不得含原文');
      assert.equal(Object.values(core.ERROR_PUBLIC_TEXT).includes(res.message), true, label + ' 文案必须来自白名单表');
      assert.equal(res.registrationState, 'UNKNOWN', label);
      assert.equal(res.userId, null, label + ' 失败不得交付完整 ID');
      sanitised.push({ label, externalCode: code || null, outputCode: res.code, outputMessage: res.message });
    }
    // 集合阶段第三方异常同样净化
    const third = {
      collection() { throw new Error(marker); },
      set() {}, update() {}, remove() {}, runTransaction() {}
    };
    const thirdResult = await makeChecker(third).handle(req());
    assert.equal(Object.values(core.ERROR_PUBLIC_TEXT).includes(thirdResult.message), true);
    assert.equal(JSON.stringify(thirdResult).includes(marker), false);
    return {
      minimalFieldProjection: proj.calls.fields[0],
      getsPerRun: proj.calls.gets, writes: proj.calls.writeAttempts,
      readAttemptedOnConstructionFailure: noAttempt.readAttempted,
      readAttemptedOnGetFailure: attempted.readAttempted,
      missingFieldStates: missingStates,
      mismatchStillDetected: mismatch.registrationState,
      sanitised
    };
  });

  // F7：完整页面链（含受控完整 ID）＋关闭包独立核验
  await probe('F7_page_chain_and_close_package', async () => {
    const chainCloseSource = makeCloseSourceDir();
    const outDir = outDirFor('chain');
    packer.build(writePlan(chainCloseSource, { synthetic: false }), outDir);
    const sent = [];
    const wxStub = {
      cloud: {
        _identityCheckEnvInited: false,
        init(opts) { sent.push({ type: 'init', env: opts.env }); },
        callFunction(opts) {
          sent.push({ type: 'call', name: opts.name, action: opts.data.action, round: opts.data.checkRoundId, wantsFull: opts.data.includeFullUserId === true });
          // 走真实候选 main（入口 → 核心 → 合成 db）
          const serverFile = path.join(outDir, 'server', 'index.js');
          const nativeRequire = createRequire(serverFile);
          const db = makeDb({ rows: [row()] }).db;
          const cloudStub = {
            DYNAMIC_CURRENT_ENV: 'dynamic', init() {},
            getWXContext: () => ({ APPID, OPENID: OPENID }), database: () => db
          };
          const sdk = { init() {}, DYNAMIC_CURRENT_ENV: 'dynamic', getWXContext: cloudStub.getWXContext, database: cloudStub.database };
          const module_ = { exports: {} };
          const context = vm.createContext({
            require(id) { return id === 'wx-server-sdk' ? sdk : nativeRequire(id); },
            module: module_, exports: module_.exports, cloud: cloudStub,
            process: { env: { TCB_ENV: ENV_ID } }, console
          });
          new vm.Script('(function(){' + fs.readFileSync(serverFile, 'utf8') + '\n}).call(globalThis)', { filename: serverFile }).runInContext(context);
          return module_.exports.main(opts.data).then(result => ({ result }));
        }
      }
    };
    // App 装载（onLaunch 不发请求）
    const appFile = path.join(outDir, 'frontend', 'app.js');
    const sandboxApp = { globalData: {}, launched: false };
    const appCtx = vm.createContext({
      App(def) { Object.assign(sandboxApp, def); if (def.onLaunch) def.onLaunch(); sandboxApp.launched = true; },
      console
    });
    new vm.Script('(function(){' + fs.readFileSync(appFile, 'utf8') + '\n}).call(globalThis)', { filename: appFile }).runInContext(appCtx);
    assert.equal(sandboxApp.launched, true, 'App 可加载');
    // 页面链
    const pageFile = path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.js');
    const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
    globalThis.wx = wxStub;
    let pageResult, callRecord;
    try {
      const pageDef = {};
      const page = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
      const pageCtx = vm.createContext({
        Page(d) { Object.assign(pageDef, d); },
        wx: wxStub, require: createRequire(pageFile), console
      });
      new vm.Script('(function(){' + fs.readFileSync(pageFile, 'utf8') + '\n}).call(globalThis)', { filename: pageFile }).runInContext(pageCtx);
      Object.assign(page, pageDef);
      page.setData({});
      page.onLoad(); page.onShow();
      assert.equal(sent.filter(x => x.type === 'call').length, 0, '加载与切前台不得自动调用');
      // 默认：不请求完整 ID
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      callRecord = sent.filter(x => x.type === 'call')[0];
      assert.equal(callRecord.wantsFull, false, '默认不得请求完整 ID');
      assert.equal(callRecord.round, ROUND, '请求必须携带本轮轮次');
      assert.equal(callRecord.name, 'scheduleSandbox', '固定函数目标');
      assert.equal(page.data.result.userId, '', '默认页面只显示尾号');
      assert.equal(page.data.result.fullUserIdAvailable, false, '默认无完整 ID');
      assert.equal(page.data.result.registrationState, 'ACTIVE');
      assert.equal(page.data.passphrase, '', '调用结束清除口令');
      // 勾选后：受控取得完整内部 ID
      page.onWantFullIdChange({ detail: { value: ['full'] } });
      assert.equal(page.data.wantFullUserId, true, '勾选状态');
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      const calls = sent.filter(x => x.type === 'call');
      assert.equal(calls[calls.length - 1].wantsFull, true, '勾选后必须请求完整 ID');
      pageResult = page.data.result;
      assert.equal(pageResult.fullUserIdAvailable, true, '有效结果应可取得完整 ID');
      assert.equal(pageResult.userId, USER_ID, '页面取得完整内部 userId');
      assert.equal(pageResult.checkRoundId, ROUND);
    } finally {
      if (hadWx) globalThis.wx = wxStub; else delete globalThis.wx;
    }
    // 关闭包独立核验（与开启候选/时钟无关）
    process.env.PIC_CLOSE_SOURCE_DIR = chainCloseSource;
    const closed = withClock(NaN, () => packer.checkCloseDir(outDir));
    delete process.env.PIC_CLOSE_SOURCE_DIR;
    assert.equal(closed.ok, true, JSON.stringify(closed.problems));
    // 关闭前端不含核验页面/客户端
    assert.equal(fs.existsSync(path.join(outDir, 'close', 'frontend', 'pages', 'identity-check')), false);
    return {
      appLoads: true, pageLoads: true, autoCallOnLoad: false,
      singleTapSingleCall: true, requestCarriesRound: callRecord.round,
      defaultTailOnly: true,
      fullUserIdOnExplicitRequest: pageResult.userId,
      fullUserIdTail: pageResult.userIdTail,
      round: pageResult.checkRoundId,
      passphraseClearedAfterCall: true,
      closeIndependentCheckOkAtNaNClock: closed.ok, closeFiles: closed.files,
      closeFrontendHasIdentityPage: false
    };
  });

  // F8：排他写、部分写与失败事实不回归
  await probe('F8_exclusive_write_and_failure_facts', async () => {
    const f8CloseSource = makeCloseSourceDir();
    const planPath = writePlan(f8CloseSource);
    const partialDir = outDirFor('partial');
    const realWrite = fs.writeFileSync;
    let partialErr = null;
    fs.writeFileSync = function (f, buf, opts) {
      if (f === path.join(partialDir, 'server', 'index.js')) {
        realWrite.call(this, f, Buffer.from(buf).subarray(0, 11), opts);
        const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e;
      }
      return realWrite.call(this, f, buf, opts);
    };
    try { packer.build(planPath, partialDir); } catch (e) { partialErr = e; } finally { fs.writeFileSync = realWrite; }
    assert.equal(partialErr.code, 'EIO');
    assert.deepEqual(partialErr.partialWrites, [{ rel: 'server/index.js', bytesOnDisk: 11 }]);
    assert.equal(fs.statSync(path.join(partialDir, 'server', 'index.js')).size, 11);
    // 竞态 EEXIST：他人文件不计本轮写入、不覆盖
    const raceDir = outDirFor('race');
    let raceErr = null;
    fs.writeFileSync = function (f, buf, opts) {
      if (f === path.join(raceDir, 'server', 'participant-identity-check.js')) {
        realWrite.call(this, f, Buffer.from('other-writer'), opts);
        const e = new Error('EEXIST race'); e.code = 'EEXIST'; throw e;
      }
      return realWrite.call(this, f, buf, opts);
    };
    try { packer.build(writePlan(f8CloseSource), raceDir); } catch (e) { raceErr = e; } finally { fs.writeFileSync = realWrite; }
    assert.equal(raceErr.code, 'EEXIST');
    assert.ok(!raceErr.written || !raceErr.written.includes('server/participant-identity-check.js'));
    assert.equal(fs.readFileSync(path.join(raceDir, 'server', 'participant-identity-check.js'), 'utf8'), 'other-writer');
    assert.ok(/EEXIST/.test(raceErr.sideEffect || ''));
    // 零写冲突
    const conflictDir = outDirFor('conflict');
    fs.mkdirSync(path.join(conflictDir, 'manifest.json'), { recursive: true });
    const snap = fs.readdirSync(conflictDir);
    let conflictErr = null;
    try { packer.build(writePlan(f8CloseSource), conflictDir); } catch (e) { conflictErr = e; }
    assert.equal(conflictErr.code, packer.ERR.OUT_CONFLICT);
    assert.deepEqual(fs.readdirSync(conflictDir), snap, '预检零写：快照不变');
    return {
      partialWrite: { code: partialErr.code, partialWrites: partialErr.partialWrites, wroteFiles: partialErr.wroteFiles },
      eexist: { code: raceErr.code, sideEffect: raceErr.sideEffect, otherWriterFileUntouched: true },
      precheckSnapshotUnchanged: true
    };
  });
}

function emitReport() {
  const unexpected = guardHits.length - sensitivityHits;
  const report = {
    schema: 'participant-identity-r1r6-review/1',
    title: '两位参与者本人身份只读核验包 R1–R6 定点返修 · 独立复核证据',
    reviewedCommit: process.env.PIC_REVIEWED_COMMIT || 'c5d58ff',
    reviewBasis: 'docs/Codex复查-参与者本人身份只读核验包-20261015.md §3（R1–R6）；复查提交 ece7659',
    implementationPath: 'miniapp/scripts/lib/participant-identity-check.cjs',
    implementationSha256,
    packerPath: 'miniapp/scripts/package-participant-identity-check.cjs',
    packerSha256,
    generatedAt: new Date().toISOString(),
    artifactDirectory: path.relative(ROOT, WORK).split(path.sep).join('/'),
    verificationKind: 'Node 真实本地应用代码 + 合成 wx/db/时钟；SDK 本地转换未执行；真实平台/真实三账号/真实部署完全未验证',
    passphraseSample: 'synthetic（仅验证准入路径；不生成真实口令；不落证据）',
    claims: {
      oneTimePassphrase: false,
      globalRateLimit: false,
      provesRealPersonIdentity: false,
      zeroPlatformLogOrCost: false,
      fullUserIdIsNotOpenid: true,
      fullUserIdIsNotPreregistrationEvidence: true
    },
    results,
    guardAccounting: {
      sensitivityProbeHits: sensitivityHits,
      businessPeriodUnexpectedAttempts: unexpected,
      caughtAttemptsCounted: true,
      note: '敏感性与业务期命中分别记账；业务期命中含被调用方捕获的尝试'
    },
    summary: {
      total: results.length,
      assertionsPassed: results.filter(r => r.assertionsPassed).length,
      unexpectedGuardAttempts: unexpected
    }
  };
  const output = JSON.stringify(report, null, 2) + '\n';
  const args = process.argv.slice(2);
  if (args.length) {
    assert.equal(args.length, 2, '用法：--out <不存在的新路径>');
    assert.equal(args[0], '--out');
    fs.writeFileSync(path.resolve(args[1]), output, { flag: 'wx' });
  }
  process.stdout.write(output);
  if (results.some(r => !r.assertionsPassed) || unexpected !== 0) process.exitCode = 1;
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => restore.reverse().forEach(f => f()))
  .then(() => emitReport());