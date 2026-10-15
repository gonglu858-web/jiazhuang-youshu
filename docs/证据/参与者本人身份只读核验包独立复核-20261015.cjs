'use strict';
// 两位参与者「本人身份只读核验包」本地准备 · 独立复核证据（2026-10-15）。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §6
// 方案：docs/Codex执行包草案-三账号P准备窗口-20261015.md §8
//
// 口径（不得夸大）：
// - 跑的是**真实应用代码**（核验核心模块、候选服务端入口、生成的前端页面/客户端）
//   ＋**合成 wx / 合成 db / 合成时钟**；**SDK 本地转换未执行**，真实平台完全未验证；
// - 口令为 **synthetic 样本**，仅验证准入路径；不生成真实口令、不落证据；
// - 不宣称一次性口令或全局限流（零持久写即无法保证）。
//
// 守卫记账：敏感性探针（E0）单独记账；其后业务期任何命中（含被 catch 的）
// 计入 unexpectedAttempts 并使验证失败（exit 1）。

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

const core = require(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'));
const packer = require(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'));
const businessTool = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const { APPID, ENV_ID } = require(path.join(ROOT, 'miniapp/tests/helpers/sandbox-entry-loader.cjs'));

const sha256Buffer = b => crypto.createHash('sha256').update(b).digest('hex');
const implementationPath = 'miniapp/scripts/lib/participant-identity-check.cjs';
const packerPath = 'miniapp/scripts/package-participant-identity-check.cjs';
const implementationSha256 = sha256Buffer(fs.readFileSync(path.join(ROOT, implementationPath)));
const packerSha256 = sha256Buffer(fs.readFileSync(path.join(ROOT, packerPath)));

const OUT_ROOT = path.join(ROOT, 'artifacts/schedule-sandbox/business-test');
const RUN = 'pic-' + crypto.randomUUID();
const WORK = path.join(OUT_ROOT, RUN);
fs.mkdirSync(WORK, { recursive: false });

const results = [];
let seq = 0;
let sensitivityHits = 0;
const SYNTHETIC_PASSPHRASE = 'synthetic-verify-passphrase-' + crypto.randomBytes(8).toString('hex');
const SYNTHETIC_DIGEST = sha256Buffer(Buffer.from(SYNTHETIC_PASSPHRASE));
const CLOSE_PREFIX = 'pic-close-source-' + RUN;

// ── 夹具 ────────────────────────────────────────────────────────────────────
function put(obj) {
  const f = path.join(WORK, 'fx-' + (++seq) + '.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), { flag: 'wx' });
  return f;
}
function makeTrapDb(options) {
  const opts = options || {};
  const calls = { collections: [], docs: [], reads: 0, writeAttempts: 0 };
  const trap = name => () => { calls.writeAttempts++; throw new Error('TRAP: 只读核验调用了写/事务方法 ' + name); };
  const db = {
    collection(name) {
      calls.collections.push(name);
      if (name !== core.FIXED_TARGET.collection) throw new Error('TRAP: 非固定集合 ' + name);
      return {
        doc(docId) {
          calls.docs.push(docId);
          return {
            async get() {
              calls.reads++;
              if (opts.throwOnRead) { const e = new Error('synthetic SDK failure'); e.code = 'DATABASE_SDK_ERROR'; throw e; }
              const rows = typeof opts.rows === 'function' ? opts.rows(docId) : opts.rows;
              return { data: rows };
            },
            set: trap('doc.set'), update: trap('doc.update'), remove: trap('doc.remove')
          };
        },
        where: trap('collection.where'), add: trap('collection.add')
      };
    }
  };
  for (const name of ['set', 'update', 'remove', 'runTransaction', 'startTransaction']) db[name] = trap('db.' + name);
  return { db, calls };
}
function makeChecker(db, overrides) {
  const o = overrides || {};
  const starts = o.windowStartsAtMs === undefined ? 1000 : o.windowStartsAtMs;
  const expires = o.windowExpiresAtMs === undefined ? starts + 10 * 60 * 1000 : o.windowExpiresAtMs;
  return core.createIdentityChecker({
    db,
    trusted: o.trusted === undefined ? { appId: APPID, envId: ENV_ID, openid: o.openid } : o.trusted,
    config: {
      checkRoundId: o.checkRoundId || 'synthetic-round-evidence',
      passphraseDigest: o.passphraseDigest || SYNTHETIC_DIGEST,
      windowStartsAtMs: starts,
      windowExpiresAtMs: expires
    },
    now: o.now || (() => starts + 1000)
  });
}
const rowFor = (openid, patch) => Object.assign(
  { _id: core.deriveUserId(APPID, openid), openid, status: 'active' }, patch || {});

/** 已受审关闭包来源：用未改的旧打包器本地生成，再由旧 checkCloseDir 独立确认。 */
function makeCloseSourceDir() {
  const round = 'synthetic-close-' + RUN.slice(0, 8);
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
  const outDir = path.join(WORK, CLOSE_PREFIX);
  const built = businessTool.build('P', planPath, outDir);
  assert.equal(businessTool.checkCloseDir(built.outDir).ok, true, '关闭包来源须通过未改 checkCloseDir');
  return built.outDir;
}
/** 候选输出目录：必须在 OUT_ROOT 直接层且带专用前缀（不得与 P/E/X 目录混用）。 */
let outSeq = 0;
function outDirFor(tag) {
  return path.join(OUT_ROOT, packer.OUT_PREFIX + tag + '-' + RUN.slice(0, 8) + '-' + (++outSeq));
}

function writePicPlan(closeSourceDir, overrides) {
  const o = overrides || {};
  const starts = o.windowStartsAtMs === undefined ? Date.now() - 60000 : o.windowStartsAtMs;
  const file = path.join(WORK, 'plan-' + (++seq) + '.json');
  fs.writeFileSync(file, JSON.stringify(Object.assign({
    schema: packer.PLAN_SCHEMA,
    synthetic: true,
    checkRoundId: 'synthetic-round-evidence-' + RUN.slice(0, 6),
    participantCode: '1',
    appId: APPID, envId: ENV_ID, functionName: 'scheduleSandbox', collection: 'schtest_v1_users',
    passphraseDigest: SYNTHETIC_DIGEST,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString(),
    closeSourceDir,
    note: '合成夹具计划（synthetic；非真实口令、非真实核验）'
  }, o.plan || {}), null, 2), { flag: 'wx' });
  return file;
}
function runMiniSource(file, sandbox) {
  const context = vm.createContext(sandbox);
  return new vm.Script('(function(){' + fs.readFileSync(file, 'utf8') + '\n}).call(globalThis)', { filename: file })
    .runInContext(context);
}
function loadCandidateMain(candidateDir, ctx) {
  const file = path.join(candidateDir, 'server', 'index.js');
  const nativeRequire = createRequire(file);
  const cloudStub = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    getWXContext: () => ({ APPID: ctx.appId, OPENID: ctx.openid }),
    database: () => ctx.db
  };
  const wxSdkStub = { init() {}, DYNAMIC_CURRENT_ENV: 'dynamic', getWXContext: cloudStub.getWXContext, database: cloudStub.database };
  const module_ = { exports: {} };
  runMiniSource(file, {
    require(id) {
      if (id === 'wx-server-sdk') return wxSdkStub;
      if (id === './participant-identity-check') return core;
      return nativeRequire(id);
    },
    module: module_, exports: module_.exports, cloud: cloudStub,
    process: { env: { TCB_ENV: ctx.envId } }, console
  });
  return module_.exports;
}

async function probe(id, fn) {
  try {
    results.push({ id, assertionsPassed: true, actual: await fn() });
  } catch (e) {
    results.push({ id, assertionsPassed: false, error: e.message });
  }
}

async function main() {
  // E0：守卫敏感性探针（实际触发，单独记账；业务期基线自此固定）
  await probe('E0_guard_sensitivity', async () => {
    for (const fn of [
      () => require('node:https').request('https://example.invalid'),
      () => require('node:child_process').spawn('node', [])
    ]) assert.throws(fn, /LOCAL_REVIEW_BLOCKED/);
    sensitivityHits = guardHits.length;
    return { sensitivityProbeHits: sensitivityHits, note: '敏感性探针实际触发并单独记账' };
  });

  // E1：ID 派生与固定目标
  await probe('E1_identity_derivation', async () => {
    const a = core.deriveUserId(APPID, 'openid-participant-1');
    const b = core.deriveUserId(APPID, 'openid-participant-2');
    assert.notEqual(a, b);
    assert.equal(a, core.deriveUserId(APPID, 'openid-participant-1'));
    assert.match(a, /^u_[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(core.FIXED_TARGET).sort(), ['appId', 'collection', 'envId', 'functionName']);
    assert.deepEqual(core.ALLOWED_ACTIONS.slice(), ['inspectSelf']);
    return {
      appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
      collection: core.FIXED_TARGET.collection, functionName: core.FIXED_TARGET.functionName,
      differentContextsDifferentIds: true, stableRepeat: true
    };
  });

  // E2：五种登记状态各走真实读取路径；读失败 UNKNOWN 且 readAttempted 保留
  await probe('E2_registration_states', async () => {
    const openid = 'openid-evidence-' + RUN.slice(0, 6);
    const states = {};
    const matrix = [
      ['ACTIVE', [rowFor(openid)]],
      ['ABSENT', []],
      ['DISABLED', [rowFor(openid, { status: 'disabled' })]],
      ['MISMATCH', [rowFor('someone-else-' + openid)]],
      ['UNKNOWN_MULTI', [rowFor(openid), rowFor(openid)]],
      ['UNKNOWN_STATUS', [rowFor(openid, { status: 'weird' })]]
    ];
    let totalReads = 0, writeAttempts = 0;
    for (const [label, rows] of matrix) {
      const { db, calls } = makeTrapDb({ rows });
      const r = await makeChecker(db, { openid }).handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
      states[label] = r.registrationState;
      assert.equal(r.readAttempted, true, label + ' 应记录已发起读取');
      assert.deepEqual(calls.collections, [core.FIXED_TARGET.collection]);
      assert.deepEqual(calls.docs, [core.deriveUserId(APPID, openid)]);
      totalReads += calls.reads;
      writeAttempts += calls.writeAttempts;
    }
    const failing = makeTrapDb({ throwOnRead: true });
    const failed = await makeChecker(failing.db, { openid }).handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(failed.registrationState, 'UNKNOWN', '读取失败必须 UNKNOWN');
    assert.equal(failed.identityConfirmed, false);
    assert.equal(failed.readAttempted, true, '已发读取的事实不得报零读取');
    assert.equal(JSON.stringify(failed).includes('synthetic SDK failure'), false, '不透传原始 SDK 异常');
    assert.equal(JSON.stringify(failed).includes(openid), false, '结果不含 OPENID');
    return {
      states, readFailure: failed.registrationState, readAttemptedKept: failed.readAttempted,
      totalReads, writeAttempts, onlyFixedCollectionAndSelfDoc: true
    };
  });

  // E3：伪造字段/业务动作/准入门槛全部 DB 前拒绝（零读）
  await probe('E3_pre_database_rejection', async () => {
    const openid = 'openid-evidence-' + RUN.slice(0, 6);
    const rejected = [];
    const forged = [
      { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, openid: 'other' },
      { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, appId: 'wx0000000000000000' },
      { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, userId: 'u_' + '0'.repeat(40) },
      { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, role: 'manager' },
      { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, collection: 'app_admins' }
    ];
    for (const payload of forged.concat([
      { action: 'identify', passphrase: SYNTHETIC_PASSPHRASE },
      { action: 'createProject', passphrase: SYNTHETIC_PASSPHRASE },
      { action: 'removeMember', passphrase: SYNTHETIC_PASSPHRASE },
      { action: 'inspectSelf' },
      { action: 'inspectSelf', passphrase: 'wrong-synthetic-passphrase' },
      { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: 'other-round-x' }
    ])) {
      const { db, calls } = makeTrapDb({ rows: [rowFor(openid)] });
      const r = await makeChecker(db, { openid }).handle(payload);
      assert.equal(r.ok, false, '必须拒绝：' + JSON.stringify(payload));
      assert.equal(r.registrationState, 'UNKNOWN');
      assert.equal(calls.reads, 0, '拒绝必须发生在数据库访问前：' + JSON.stringify(payload));
      rejected.push(r.code);
    }
    // 时钟与上下文类
    const clockCases = [
      [{ now: () => 999 }, 'PIC_WINDOW_NOT_OPEN'],
      [{ now: () => 1000 + 10 * 60 * 1000 + 1 }, 'PIC_WINDOW_EXPIRED'],
      [{ now: () => NaN }, 'PIC_CLOCK_INVALID'],
      [{ now: () => { throw new Error('english clock failure'); } }, 'PIC_CLOCK_ERROR']
    ];
    for (const [o, code] of clockCases) {
      const { db, calls } = makeTrapDb({ rows: [rowFor(openid)] });
      const r = await makeChecker(db, Object.assign({ openid }, o)).handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
      assert.equal(r.code, code);
      assert.equal(calls.reads, 0);
      rejected.push(code);
    }
    for (const [trusted, code] of [
      [{ appId: APPID, envId: ENV_ID, openid: '' }, 'PIC_CONTEXT_UNVERIFIED'],
      [{ appId: 'wx1111111111111111', envId: ENV_ID, openid }, 'PIC_TARGET_MISMATCH'],
      [{ appId: APPID, envId: 'cloud-other', openid }, 'PIC_TARGET_MISMATCH']
    ]) {
      const { db, calls } = makeTrapDb({ rows: [rowFor(openid)] });
      const r = await makeChecker(db, { trusted }).handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
      assert.equal(r.code, code);
      assert.equal(calls.reads, 0);
      rejected.push(code);
    }
    return { rejectedCount: rejected.length, distinctCodes: [...new Set(rejected)].sort(), zeroDatabaseAccess: true };
  });

  // E4：异步读取后置守卫（读期间推进到期/NaN/抛错）
  await probe('E4_post_read_clock_guard', async () => {
    const openid = 'openid-evidence-' + RUN.slice(0, 6);
    const starts = 1000, expires = starts + 10 * 60 * 1000;
    const runWith = advance => {
      let now = starts + 1000, pending = null, reads = 0;
      const db = {
        collection(name) {
          assert.equal(name, core.FIXED_TARGET.collection);
          return {
            doc() {
              return {
                async get() { reads++; pending = advance; return { data: [rowFor(openid)] }; },
                set() { throw new Error('TRAP'); }, update() { throw new Error('TRAP'); }, remove() { throw new Error('TRAP'); }
              };
            },
            add() { throw new Error('TRAP'); }
          };
        },
        runTransaction() { throw new Error('TRAP'); }
      };
      const checker = core.createIdentityChecker({
        db, trusted: { appId: APPID, envId: ENV_ID, openid },
        config: { checkRoundId: 'synthetic-round-evidence', passphraseDigest: SYNTHETIC_DIGEST, windowStartsAtMs: starts, windowExpiresAtMs: expires },
        now: () => { if (pending) { const a = pending; pending = null; now = a(); } return now; }
      });
      return { checker, readCount: () => reads };
    };
    const cases = [
      ['expired_after_read', () => expires + 1, 'PIC_WINDOW_EXPIRED'],
      ['nan_after_read', () => NaN, 'PIC_CLOCK_INVALID'],
      ['throw_after_read', () => { throw new Error('english clock failure'); }, 'PIC_CLOCK_ERROR']
    ];
    const out = [];
    for (const [label, advance, code] of cases) {
      const { checker, readCount } = runWith(advance);
      const r = await checker.handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
      assert.equal(r.ok, false, label + ' 不得确认');
      assert.equal(r.identityConfirmed, false);
      assert.equal(r.registrationState, 'UNKNOWN');
      assert.equal(r.readAttempted, true, label + ' 必须保留已发读取事实');
      assert.equal(r.code, code, label + ' 错误码');
      assert.equal(readCount(), 1);
      out.push({ label, code, readAttempted: r.readAttempted, reads: 1 });
    }
    return { cases: out };
  });

  // E5：净化输出（固定字段、无 OPENID/凭据、只出尾号）
  await probe('E5_sanitized_output', async () => {
    const openid = 'openid-secret-evidence-' + RUN.slice(0, 6);
    const { db } = makeTrapDb({ rows: [rowFor(openid)] });
    const r = await makeChecker(db, { openid }).handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
    const serialized = JSON.stringify(r);
    assert.equal(r.schema, core.RESULT_SCHEMA);
    assert.equal(r.userIdTail.length, 6);
    assert.equal(serialized.includes(openid), false);
    assert.equal(serialized.includes(core.deriveUserId(APPID, openid)), false);
    for (const banned of ['AKID', 'secretKey', 'sessionToken', 'openid', 'OPENID', 'unionid']) {
      assert.equal(serialized.includes(banned), false, '结果不得含 ' + banned);
    }
    return {
      fields: Object.keys(r).sort(),
      userIdTail: r.userIdTail,
      registrationState: r.registrationState,
      noOpenidNoCredentials: true
    };
  });

  // E6：完整制品与关闭包（打包器 + 旧工具校验来源）
  const closeSource = makeCloseSourceDir();
  await probe('E6_artifacts_and_close_package', async () => {
    const planPath = writePicPlan(closeSource);
    const outDir = outDirFor('artifact');
    const built = packer.build(planPath, outDir);
    assert.equal(built.manifest.schema, packer.MANIFEST_SCHEMA);
    assert.equal(built.manifest.files.length, 14, '服务端3 + 前端9 + project.config.json + plan.json');
    assert.equal(built.manifest.closePackage.files.length, 23);
    assert.equal(built.io.filter(x => x.action === 'written').length, 38);
    assert.equal(packer.checkDir(outDir).ok, true, 'check 从独立来源重建一致');
    const reused = packer.build(planPath, outDir);
    assert.equal(reused.io.filter(x => x.action === 'written').length, 0, '完整复用零新写');
    assert.equal(reused.io.filter(x => x.action === 'reused').length, 38);
    // 服务端不含旧业务实现
    const serverFiles = fs.readdirSync(path.join(outDir, 'server'));
    for (const forbidden of ['vendor', 'memberAccess', 'connectionCheck', 'project-guard', 'gate']) {
      assert.equal(serverFiles.includes(forbidden), false, '服务端不得含 ' + forbidden);
    }
    const entry = fs.readFileSync(path.join(outDir, 'server', 'index.js'), 'utf8');
    assert.equal(entry.includes(SYNTHETIC_PASSPHRASE), false, '明文口令不入制品');
    assert.equal(entry.includes(SYNTHETIC_DIGEST), true, '只含摘要');
    // 前端唯一页面
    const appJson = JSON.parse(fs.readFileSync(path.join(outDir, 'frontend', 'app.json'), 'utf8'));
    assert.deepEqual(appJson.pages, ['pages/identity-check/identity-check']);
    // 关闭包独立核验：与开启候选/时钟无关
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    const closeResult = packer.checkCloseDir(outDir);
    delete process.env.PIC_CLOSE_SOURCE_DIR;
    assert.equal(closeResult.ok, true, JSON.stringify(closeResult.problems));
    return {
      candidateFiles: built.manifest.files.length, closeFiles: built.manifest.closePackage.files.length,
      writtenOnFirstBuild: 38, fullReuseWritten: 0, reusedOnSecondBuild: 38,
      closeIndependentCheckOk: closeResult.ok, closeFilesVerified: closeResult.files,
      cleartextPassphraseInArtifacts: false
    };
  });

  // E7：零写冲突、链接拒绝、部分写与竞态事实
  await probe('E7_zero_write_and_failure_facts', async () => {
    const zeroDir = outDirFor('zero');
    // 非法计划矩阵（零写）
    const invalidPlans = [
      { unknown: 1 }, { appId: 'wx0000000000000000' }, { envId: 'cloud-other' },
      { functionName: 'connectionCheck' }, { collection: 'users' },
      { participantCode: '3' }, { passphraseDigest: 'not-a-digest' },
      { windowExpiresAtIso: new Date(Date.now() + 45 * 60 * 1000).toISOString() },
      { closeSourceDir: 'relative/path' }
    ];
    let rejectedPlans = 0;
    for (const plan of invalidPlans) {
      assert.throws(() => packer.build(writePicPlan(closeSource, { plan }), outDirFor('invalid')));
      rejectedPlans++;
    }
    assert.equal(fs.existsSync(zeroDir), false, '非法计划零写');
    // 关闭来源缺失
    assert.throws(() => packer.build(
      writePicPlan(path.join(WORK, 'nonexistent-close-source')),
      outDirFor('noclose')));
    // 目录占位冒名 manifest.json → 快照不变
    const conflictDir = outDirFor('conflict');
    fs.mkdirSync(path.join(conflictDir, 'manifest.json'), { recursive: true });
    const snapshot = fs.readdirSync(conflictDir);
    assert.throws(() => packer.build(writePicPlan(closeSource), conflictDir), e => e.code === packer.ERR.OUT_CONFLICT);
    assert.deepEqual(fs.readdirSync(conflictDir), snapshot, '预检零写：快照不变');
    // 输出根 junction → 拒绝且目标零写
    const linkTarget = outDirFor('link-target');
    const linkPath = outDirFor('link');
    fs.mkdirSync(linkTarget, { recursive: true });
    fs.mkdirSync(path.dirname(linkTarget), { recursive: true });
    fs.symlinkSync(linkTarget, linkPath, 'junction');
    assert.throws(() => packer.build(writePicPlan(closeSource), linkPath), e => e.code === packer.ERR.OUT_CONFLICT);
    assert.deepEqual(fs.readdirSync(linkTarget), [], '链接目标零写');
    // 部分写与竞态 EEXIST：两类异常分别保存
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
    try { packer.build(writePicPlan(closeSource), partialDir); } catch (e) { partialErr = e; } finally { fs.writeFileSync = realWrite; }
    assert.equal(partialErr && partialErr.code, 'EIO');
    assert.deepEqual(partialErr.partialWrites, [{ rel: 'server/index.js', bytesOnDisk: 11 }]);
    assert.equal(fs.statSync(path.join(partialDir, 'server', 'index.js')).size, 11);
    const raceDir = outDirFor('race');
    let raceErr = null;
    fs.writeFileSync = function (f, buf, opts) {
      if (f === path.join(raceDir, 'server', 'participant-identity-check.js')) {
        realWrite.call(this, f, Buffer.from('other-writer'), opts);
        const e = new Error('EEXIST race'); e.code = 'EEXIST'; throw e;
      }
      return realWrite.call(this, f, buf, opts);
    };
    try { packer.build(writePicPlan(closeSource), raceDir); } catch (e) { raceErr = e; } finally { fs.writeFileSync = realWrite; }
    assert.equal(raceErr && raceErr.code, 'EEXIST');
    assert.ok(!raceErr.written || !raceErr.written.includes('server/participant-identity-check.js'));
    assert.equal(fs.readFileSync(path.join(raceDir, 'server', 'participant-identity-check.js'), 'utf8'), 'other-writer');
    return {
      rejectedInvalidPlans: rejectedPlans, precheckSnapshotUnchanged: true,
      junctionTargetZeroWrite: true,
      partialWrite: { code: partialErr.code, partialWrites: partialErr.partialWrites, wroteFiles: partialErr.wroteFiles },
      eexist: { code: raceErr.code, sideEffect: raceErr.sideEffect, otherWriterFileUntouched: true }
    };
  });

  // E8：真实应用代码完整链（生成候选 App/Page → wx 替身 → 候选 main → 核心 → 合成 db）
  await probe('E8_generated_chain', async () => {
    const outDir = outDirFor('chain');
    packer.build(writePicPlan(closeSource, {
      synthetic: false,
      windowStartsAtMs: Date.now() - 60000,
      plan: { synthetic: false }
    }), outDir);
    const openid = 'openid-evidence-' + RUN.slice(0, 6);
    const userId = core.deriveUserId(APPID, openid);
    const sent = [];
    const wxStub = {
      cloud: {
        _identityCheckEnvInited: false,
        init(opts) { sent.push({ type: 'init', env: opts.env }); },
        callFunction(opts) {
          sent.push({ type: 'callFunction', name: opts.name, action: opts.data.action });
          const main = loadCandidateMain(outDir, {
            appId: APPID, envId: ENV_ID, openid,
            db: makeTrapDb({ rows: [{ _id: userId, openid, status: 'active' }] }).db
          });
          return main.main(opts.data).then(result => ({ result }));
        }
      }
    };
    // App 装载（onLaunch 不发请求）
    const appFile = path.join(outDir, 'frontend', 'app.js');
    const sandboxApp = { globalData: {}, launched: false };
    runMiniSource(appFile, {
      App(def) {
        Object.assign(sandboxApp, def);
        if (typeof def.onLaunch === 'function') def.onLaunch();
        sandboxApp.launched = true;
      },
      console
    });
    assert.equal(sandboxApp.launched, true, 'App 可加载');
    // 页面装载与调用（wx 为客户端模块的自由变量，须在调用作用域内挂载）
    const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
    globalThis.wx = wxStub;
    let pageResult, pageHint;
    try {
      const pageFile = path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.js');
      const pageDef = {};
      const page = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
      runMiniSource(pageFile, {
        Page(d) { Object.assign(pageDef, d); },
        wx: wxStub, require: createRequire(pageFile), console
      });
      Object.assign(page, pageDef);
      page.setData({});
      page.onLoad(); page.onShow();
      assert.equal(sent.filter(x => x.type === 'callFunction').length, 0, '加载/切前台不得自动调用');
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      const calls = sent.filter(x => x.type === 'callFunction');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, 'scheduleSandbox');
      assert.equal(calls[0].action, 'inspectSelf');
      assert.equal(page.data.result.registrationState, 'ACTIVE');
      assert.equal(page.data.passphrase, '', '调用结束清除口令');
      pageResult = page.data.result;
      pageHint = page.data.stopHint;
      // 失败不自动重试
      const failing = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction() { failing.calls++; throw new Error('synthetic transport failure'); } } };
      failing.calls = 0;
      const prevWx = globalThis.wx;
      globalThis.wx = failing;
      const failPageFile = path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.js');
      const failDef = {};
      const failPage = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
      runMiniSource(failPageFile, { Page(d) { Object.assign(failDef, d); }, wx: failing, require: createRequire(failPageFile), console });
      Object.assign(failPage, failDef);
      failPage.setData({ passphrase: SYNTHETIC_PASSPHRASE, sending: false, result: null, stopHint: '' });
      await failPage.onCheckTap();
      assert.equal(failing.calls, 1, '失败不自动重试');
      assert.equal(failPage.data.result, null);
      globalThis.wx = prevWx;
    } finally {
      if (hadWx) globalThis.wx = wxStub; else delete globalThis.wx;
    }
    return {
      appLoaded: true, pageLoaded: true,
      autoCallOnLoad: false, singleTapSingleCall: true,
      functionTarget: 'scheduleSandbox', action: 'inspectSelf',
      registrationState: pageResult.registrationState, identityConfirmed: pageResult.identityConfirmed,
      passphraseClearedAfterCall: true, noAutoRetryOnFailure: true,
      stopHintShown: Boolean(pageHint)
    };
  });

  // E9：关闭端零核验能力 + 服务端拒绝业务动作
  await probe('E9_close_package_rejects', async () => {
    const outDir = outDirFor('closechain');
    packer.build(writePicPlan(closeSource), outDir);
    const closeDir = path.join(outDir, 'close');
    assert.equal(fs.existsSync(path.join(closeDir, 'frontend', 'pages', 'identity-check')), false);
    assert.equal(fs.existsSync(path.join(closeDir, 'frontend', 'utils', 'identity-check-client.js')), false);
    const dbTouched = [];
    const closeMain = loadCandidateMain(closeDir, {
      appId: APPID, envId: ENV_ID, openid: 'openid-close-' + RUN.slice(0, 6),
      db: new Proxy({}, { get(_t, prop) { dbTouched.push(String(prop)); throw new Error('TRAP: 关闭态不得访问数据库'); } })
    });
    const codes = [];
    for (const action of ['inspectSelf', 'identify', 'createProject', 'removeMember']) {
      const r = await closeMain.main({ action, passphrase: SYNTHETIC_PASSPHRASE });
      assert.equal(r.ok, false, action + ' 关闭态必须拒绝');
      codes.push(r.code);
    }
    assert.deepEqual(dbTouched, [], '关闭端零数据库访问');
    return {
      closeFrontendHasIdentityPage: false, closeFrontendHasIdentityClient: false,
      rejectedActions: ['inspectSelf', 'identify', 'createProject', 'removeMember'],
      rejectCodes: codes, zeroDatabaseAccess: true
    };
  });
}

function emitReport() {
  const unexpected = guardHits.length - sensitivityHits;
  const report = {
    schema: 'participant-identity-check-evidence/1',
    title: '两位参与者本人身份只读核验包 · 本地准备独立复核证据',
    reviewedCommit: process.env.PIC_REVIEWED_COMMIT || '104aea8（接手基线）',
    reviewBasis: 'docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §6；docs/Codex执行包草案-三账号P准备窗口-20261015.md §8',
    implementationPath,
    implementationSha256,
    packerPath,
    packerSha256,
    generatedAt: new Date().toISOString(),
    artifactDirectory: path.relative(ROOT, WORK).split(path.sep).join('/'),
    verificationKind: 'Node 真实应用代码 + 合成 wx/db/时钟；SDK 本地转换未执行；真实平台/真实三账号/真实部署完全未验证',
    passphraseSample: 'synthetic（仅验证准入路径；不生成真实口令；不落证据）',
    claims: {
      oneTimePassphrase: false,
      globalRateLimit: false,
      provesRealPersonIdentity: false,
      zeroPlatformLogOrCost: false
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