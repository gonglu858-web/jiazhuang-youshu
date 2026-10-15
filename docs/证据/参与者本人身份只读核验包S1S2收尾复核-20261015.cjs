'use strict';
// 两位参与者「本人身份只读核验包」S1/S2 定点收尾 · 独立复核证据（2026-10-15）。
//
// 依据：docs/Codex复查-参与者只读核验包R1R6返修-20261015.md §3（S1/S2）；复查提交 fcc4a58
//
// 标签口径（本轮回更正）：
// - reviewedCommit = **实际受测实现**的基线提交（c5d58ff + 本轮 S1/S2 修改，
//   以 implementationSha256 / packerSha256 运行时摘要精确定位）；
// - reviewBasis = 复查依据（fcc4a58）。
// 历史证据保持原样，不回写。
//
// 性质：离线合成验证——真实本地应用代码（含**实际生成链**：模板→打包器→候选
// App/Page/client/server/core）＋ 合成 wx/db/时钟；SDK 本地转换未执行；
// 真实平台/真实三账号/真实部署完全未验证。
// 每项均为「修复后正确行为 + 正常对照」直接断言；不以旧反例 D7/D8「不再复现」作闭合。
//
// 守卫记账：敏感性探针（G0）单独记账；其后业务期任何命中（含被 catch 的）
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
const RUN = 'pic-s12-' + crypto.randomUUID();
const WORK = path.join(OUT_ROOT, RUN);
fs.mkdirSync(WORK, { recursive: true });

const results = [];
let seq = 0;
let sensitivityHits = 0;
let outSeq = 0;
let closeSeq = 0;
const ROUND = 'synthetic-round-s12-' + RUN.slice(-8);
const PASSPHRASE = 'synthetic-s12-passphrase-' + crypto.randomBytes(8).toString('hex');
const DIGEST = sha256Buffer(Buffer.from(PASSPHRASE));
const OPENID = 'synthetic-s12-context';
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
function makeCloseSourceDir() {
  const round = 'synthetic-close-' + RUN.slice(-8) + '-' + (++closeSeq);
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
  const outDir = path.join(WORK, 'close-src-' + closeSeq);
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
  for (const k of ['synthetic', 'windowStartsAtIso', 'windowExpiresAtIso', 'checkRoundId']) {
    if (o[k] !== undefined) merged[k] = o[k];
  }
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { flag: 'wx' });
  return file;
}
/** 读边界替身：可注入无 field / field 抛错 / field 返回无 get；记录投影与读取。 */
function makeDb(options) {
  const o = options || {};
  const calls = { collections: [], docs: [], fields: [], gets: 0, writeAttempts: 0, projectedKeys: null };
  const trap = name => () => { calls.writeAttempts++; throw new Error('TRAP 写/事务：' + name); };
  const docRef = {
    // S2：noField=true 时句柄不提供 field 方法（模拟旧版 SDK / 无投影能力）
    ...(o.noField ? {} : { field(fields) {
      calls.fields.push(fields);
      calls.projectedKeys = Object.keys(fields);
      if (o.fieldError) throw o.fieldError;
      if (o.fieldReturnsNoGet) return {};
      return docRef;
    } }),
    async get() {
      calls.gets++;
      if (o.readError) throw o.readError;
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

/** 实际生成链：装载候选页面（client 经真实 require，wx 挂全局）。 */
function loadGeneratedPage(outDir, wxStub) {
  const pageFile = path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.js');
  const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
  globalThis.wx = wxStub;
  try {
    const pageDef = {};
    const page = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
    const ctx = vm.createContext({
      Page(d) { Object.assign(pageDef, d); },
      wx: wxStub, require: createRequire(pageFile), console
    });
    new vm.Script('(function(){' + fs.readFileSync(pageFile, 'utf8') + '\n}).call(globalThis)', { filename: pageFile }).runInContext(ctx);
    Object.assign(page, pageDef);
    return page;
  } finally {
    // 页面对象的方法在调用期才用到 client 模块的 wx 自由变量，
    // 因此 wx 保留在全局，由调用方负责最终清理。
    if (hadWx) globalThis.wx = wxStub;
  }
}

async function probe(id, fn) {
  try {
    results.push({ id, assertionsPassed: true, actual: await fn() });
  } catch (e) {
    results.push({ id, assertionsPassed: false, error: e.message });
  }
}

async function main() {
  // G0：守卫敏感性探针（实际触发，单独记账）
  await probe('G0_guard_sensitivity', async () => {
    for (const fn of [
      () => require('node:https').request('https://example.invalid'),
      () => require('node:child_process').spawn('node', [])
    ]) assert.throws(fn, /LOCAL_REVIEW_BLOCKED/);
    sensitivityHits = guardHits.length;
    return { sensitivityProbeHits: sensitivityHits, note: '敏感性探针实际触发并单独记账' };
  });

  const closeSource = makeCloseSourceDir();

  // G1（S1）：实际生成页面的事件顺序——默认不展示、勾选展示、取消后不请求不显示、重勾才展示
  await probe('G1_s1_cancel_checkbox_sequence', async () => {
    const outDir = outDirFor('s1');
    packer.build(writePlan(closeSource, { synthetic: false }), outDir);
    const requests = [];
    const wxStub = {
      cloud: {
        _identityCheckEnvInited: false,
        init() {},
        callFunction(opts) {
          requests.push({ data: JSON.parse(JSON.stringify(opts.data)) });
          // 走真实候选 main（入口 → 核心 → 合成 db）
          const serverFile = path.join(outDir, 'server', 'index.js');
          const nativeRequire = createRequire(serverFile);
          const { db } = makeDb({ rows: [row()] });
          const cloudStub = {
            DYNAMIC_CURRENT_ENV: 'dynamic', init() {},
            getWXContext: () => ({ APPID, OPENID: OPENID }), database: () => db
          };
          const sdk = { init() {}, DYNAMIC_CURRENT_ENV: 'dynamic', getWXContext: cloudStub.getWXContext, database: cloudStub.database };
          const module_ = { exports: {} };
          const ctx = vm.createContext({
            require(id) { return id === 'wx-server-sdk' ? sdk : nativeRequire(id); },
            module: module_, exports: module_.exports, cloud: cloudStub,
            process: { env: { TCB_ENV: ENV_ID } }, console
          });
          new vm.Script('(function(){' + fs.readFileSync(serverFile, 'utf8') + '\n}).call(globalThis)', { filename: serverFile }).runInContext(ctx);
          return module_.exports.main(opts.data).then(result => ({ result }));
        }
      }
    };
    const prevWx = globalThis.wx;
    globalThis.wx = wxStub;
    const sequence = [];
    try {
      const page = loadGeneratedPage(outDir, wxStub);
      page.onLoad(); page.onShow();
      // (0) 默认：不展示、请求不带完整 ID
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      sequence.push({ step: 'default', wantFull: page.data.wantFullUserId, requested: requests[0].data.includeFullUserId === true, shown: page.data.result.userId });
      assert.equal(page.data.wantFullUserId, false);
      assert.equal(requests[0].data.includeFullUserId, undefined, '默认请求不得携带完整 ID');
      assert.equal(page.data.result.userId, '', '默认不显示完整 ID');
      // (1) 勾选：请求并展示
      page.onWantFullIdChange({ detail: { value: ['full'] } });
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      sequence.push({ step: 'checked', wantFull: page.data.wantFullUserId, requested: requests[1].data.includeFullUserId === true, shown: page.data.result.userId });
      assert.equal(page.data.wantFullUserId, true);
      assert.equal(requests[1].data.includeFullUserId, true, '勾选后请求携带完整 ID');
      assert.equal(page.data.result.userId, USER_ID, '勾选后显示完整 ID');
      // (2) 取消勾选（detail.value=[]）→ 不请求、不显示（D7 反例的直接修复证明）
      page.onWantFullIdChange({ detail: { value: [] } });
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      sequence.push({ step: 'cancelled', wantFull: page.data.wantFullUserId, requested: requests[2].data.includeFullUserId === true, shown: page.data.result.userId });
      assert.equal(page.data.wantFullUserId, false, '取消勾选必须为 false');
      assert.equal(requests[2].data.includeFullUserId, undefined, '取消后请求不得携带完整 ID');
      assert.equal(page.data.result.userId, '', '取消后不得显示完整 ID');
      assert.equal(page.data.result.userIdTail, USER_ID.slice(-6), '仍显示尾号');
      // (3) 重新勾选 → 才展示
      page.onWantFullIdChange({ detail: { value: ['full'] } });
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      sequence.push({ step: 'rechecked', wantFull: page.data.wantFullUserId, requested: requests[3].data.includeFullUserId === true, shown: page.data.result.userId });
      assert.equal(requests[3].data.includeFullUserId, true, '重新勾选才请求');
      assert.equal(page.data.result.userId, USER_ID, '重新勾选才显示');
      // (4) 选中其他值（不含 full）→ 不请求
      page.onWantFullIdChange({ detail: { value: ['full'] } });
      page.onWantFullIdChange({ detail: { value: ['other'] } });
      assert.equal(page.data.wantFullUserId, false, '选中值不含 full 必须为 false');
      // (5) 在途锁：sending 期间复选框禁用（WXML 静态绑定）且点击不产生新请求
      const wxml = fs.readFileSync(path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.wxml'), 'utf8');
      assert.ok(wxml.includes('disabled="{{sending}}"'), '在途禁用复选框');
      const before = requests.length;
      page.setData({ sending: true });
      await page.onCheckTap();
      assert.equal(requests.length, before, '在途锁：点击不产生新请求');
      page.setData({ sending: false });
      // 口令清除
      assert.equal(page.data.passphrase, '', '调用结束清除口令');
      return { sequence, inFlightLockKept: true, passphraseCleared: true, sends: requests.length };
    } finally {
      if (prevWx === undefined) delete globalThis.wx; else globalThis.wx = prevWx;
    }
  });

  // G2（S2）：字段筛选能力缺失时保守 UNKNOWN
  await probe('G2_s2_field_projection_required', async () => {
    const outcomes = [];
    // (1) 无 field 方法 → 零 get、UNKNOWN、readAttempted=false、完整 ID 为空
    const noField = makeDb({ rows: [row()], noField: true });
    const r1 = await makeChecker(noField.db).handle(req({ includeFullUserId: true }));
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'PIC_FIELD_PROJECTION_UNAVAILABLE');
    assert.equal(r1.registrationState, 'UNKNOWN');
    assert.equal(r1.readAttempted, false, '未实际进入 get 必须 readAttempted=false');
    assert.equal(r1.userId, null, '完整 userId 必须为空');
    assert.equal(noField.calls.gets, 0, '零 get（不回退整文档读取）');
    assert.equal(noField.calls.writeAttempts, 0, '零业务写');
    outcomes.push({ case: 'noFieldMethod', code: r1.code, gets: noField.calls.gets, readAttempted: r1.readAttempted, userId: r1.userId });
    // (2) field 抛错 → 同样保守
    const throws = makeDb({ rows: [row()], fieldError: new Error('synthetic field failure') });
    const r2 = await makeChecker(throws.db).handle(req({ includeFullUserId: true }));
    assert.equal(r2.code, 'PIC_FIELD_PROJECTION_UNAVAILABLE');
    assert.equal(r2.readAttempted, false);
    assert.equal(r2.userId, null);
    assert.equal(throws.calls.gets, 0);
    outcomes.push({ case: 'fieldThrows', code: r2.code, gets: throws.calls.gets, readAttempted: r2.readAttempted, userId: r2.userId });
    // (3) field 返回无 get 的对象 → 保守拒绝
    const noGet = makeDb({ rows: [row()], fieldReturnsNoGet: true });
    const r3 = await makeChecker(noGet.db).handle(req({ includeFullUserId: true }));
    assert.equal(r3.code, 'PIC_FIELD_PROJECTION_UNAVAILABLE');
    assert.equal(r3.readAttempted, false);
    assert.equal(r3.userId, null);
    assert.equal(noGet.calls.gets, 0);
    outcomes.push({ case: 'fieldReturnsNoGet', code: r3.code, gets: noGet.calls.gets, readAttempted: r3.readAttempted, userId: r3.userId });
    // (4) 正常筛选对照：一次本人 get、只投影 _id/openid/status、ACTIVE 且可交付完整 ID
    const good = makeDb({ rows: [row()] });
    const r4 = await makeChecker(good.db).handle(req({ includeFullUserId: true }));
    assert.equal(r4.ok, true);
    assert.equal(r4.registrationState, 'ACTIVE');
    assert.equal(r4.userId, USER_ID);
    assert.deepEqual(good.calls.fields[0], { _id: true, openid: true, status: true });
    assert.equal(good.calls.gets, 1, '至多一次本人 get');
    assert.equal(good.calls.writeAttempts, 0, '零业务写');
    outcomes.push({ case: 'normalProjection', gets: good.calls.gets, projection: good.calls.fields[0], state: r4.registrationState });
    // (5) 实际 get 失败 → readAttempted=true 如实记录
    const getFail = makeDb({ rows: [row()], readError: new Error('synthetic get failure') });
    const r5 = await makeChecker(getFail.db).handle(req({ includeFullUserId: true }));
    assert.equal(r5.readAttempted, true, 'get 已调用必须如实记录');
    assert.equal(r5.registrationState, 'UNKNOWN');
    assert.equal(r5.userId, null);
    outcomes.push({ case: 'getFails', readAttempted: r5.readAttempted, state: r5.registrationState });
    return { outcomes };
  });

  // G3：R3 漂移拒绝保持（核心/页面模板字节变化后基线已更新）
  await probe('G3_drift_still_rejected_pre_write', async () => {
    const planPath = writePlan(closeSource);
    const outDir = outDirFor('g3-ok');
    packer.build(planPath, outDir);
    assert.equal(packer.checkDir(outDir).ok, true, '正常对照');
    const realRead = fs.readFileSync;
    const driftCases = [];
    for (const [label, target] of [
      ['核心模块', corePath],
      ['页面模板', path.join(packer.TEMPLATE_DIR, 'frontend', 'pages', 'identity-check', 'identity-check.js')]
    ]) {
      const original = realRead.call(fs, target);
      const drifted = Buffer.concat([original, Buffer.from('\n// synthetic drift\n')]);
      fs.readFileSync = function (p, ...args) {
        if (typeof p === 'string' && path.resolve(p) === target) {
          return typeof args[0] === 'string' ? drifted.toString(args[0]) : drifted;
        }
        return realRead.call(this, p, ...args);
      };
      const dir = outDirFor('g3-drift');
      let buildErr = null;
      try { packer.build(planPath, dir); } catch (e) { buildErr = e; } finally { fs.readFileSync = realRead; }
      assert.ok(buildErr, label + ' 漂移时 build 必须拒绝');
      assert.equal(buildErr.code, packer.ERR.SOURCE_DRIFT, label + ' 实际 ' + buildErr.code);
      assert.equal(fs.existsSync(dir), false, label + ' 拒绝必须零产物');
      assert.equal(sha256Buffer(fs.readFileSync(target)), sha256Buffer(original), label + ' 磁盘源零改动');
      driftCases.push({ label, rejectedWith: buildErr.code, zeroArtifacts: true, diskSourceUnchanged: true });
    }
    return { driftCases, normalControlOk: true };
  });

  // G4：控制组——只读/关闭包/排他写/续建/部分写不回归
  await probe('G4_controls', async () => {
    const planPath = writePlan(closeSource);
    const outDir = outDirFor('g4');
    const built = packer.build(planPath, outDir);
    assert.equal(built.manifest.files.length, 14);
    assert.equal(built.manifest.closePackage.files.length, 23);
    assert.equal(built.io.filter(x => x.action === 'written').length, 38);
    assert.equal(packer.checkDir(outDir).ok, true);
    const reuse = packer.build(planPath, outDir);
    assert.equal(reuse.io.filter(x => x.action === 'written').length, 0);
    assert.equal(reuse.io.filter(x => x.action === 'reused').length, 38);
    // 关闭包独立核验（NaN 时钟）
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    const closed = withClock(NaN, () => packer.checkCloseDir(outDir));
    delete process.env.PIC_CLOSE_SOURCE_DIR;
    assert.equal(closed.ok, true, JSON.stringify(closed.problems));
    // 部分写事实
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
    try { packer.build(writePlan(closeSource), partialDir); } catch (e) { partialErr = e; } finally { fs.writeFileSync = realWrite; }
    assert.equal(partialErr.code, 'EIO');
    assert.deepEqual(partialErr.partialWrites, [{ rel: 'server/index.js', bytesOnDisk: 11 }]);
    return {
      candidateFiles: 14, closeFiles: 23, writtenFirstBuild: 38,
      fullReuse: { written: 0, reused: 38 },
      closeIndependentCheckOkAtNaNClock: closed.ok,
      partialWrite: partialErr.partialWrites
    };
  });
}

function withClock(value, fn) {
  const old = Date.now;
  Date.now = typeof value === 'function' ? value : () => value;
  try { return fn(); } finally { Date.now = old; }
}

function emitReport() {
  const unexpected = guardHits.length - sensitivityHits;
  const report = {
    schema: 'participant-identity-s12-review/1',
    title: '两位参与者本人身份只读核验包 S1/S2 定点收尾 · 独立复核证据',
    // 标签口径（本轮回更正）：reviewedCommit=实际受测实现基线；本轮 S1/S2 修改以
    // implementationSha256 / packerSha256 运行时摘要精确定位；reviewBasis=复查依据。
    reviewedCommit: process.env.PIC_REVIEWED_COMMIT || 'c5d58ff',
    reviewBasis: 'docs/Codex复查-参与者只读核验包R1R6返修-20261015.md §3（S1/S2）；复查提交 fcc4a58',
    implementationPath: 'miniapp/scripts/lib/participant-identity-check.cjs',
    implementationSha256,
    packerPath: 'miniapp/scripts/package-participant-identity-check.cjs',
    packerSha256,
    labelNote: 'reviewedCommit 为受测实现基线（c5d58ff）；本轮 S1/S2 返修后的实际受测代码以 implementationSha256 为准。历史证据不回写。',
    generatedAt: new Date().toISOString(),
    artifactDirectory: path.relative(ROOT, WORK).split(path.sep).join('/'),
    verificationKind: 'Node 真实本地应用代码（含实际生成链）+ 合成 wx/db/时钟；SDK 本地转换未执行；真实平台/真实三账号/真实部署完全未验证',
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