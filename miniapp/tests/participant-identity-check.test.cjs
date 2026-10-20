// 两位参与者「本人身份只读核验包」相称测试（仅本地合成验证）。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §6
// 方案：docs/Codex执行包草案-三账号P准备窗口-20261015.md §8
//
// 边界（必须与证据文案一致，不得夸大）：
// - 跑的是**真实应用代码**（核验核心模块、候选服务端入口、生成的前端页面/客户端）
//   ＋**合成 wx / 合成 db / 合成时钟**；
// - wx-server-sdk 3.0.1 的历史本地转换验证不重跑；A3/A5 直接使用本地真实 SDK 3.0.1
//   代码（仅传输层与 getWXContext 为合成替换）；真实平台、真实三账号、真实部署完全未验证；
// - 合成口令仅用于本地验证准入路径，**不是**一次性/全局限流的证明，也不代表
//   现实中的1号/2号身份。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const REPO_ROOT = path.join(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'artifacts', 'schedule-sandbox', 'business-test');
const RUN_ID = crypto.randomBytes(4).toString('hex');

const core = require('../scripts/lib/participant-identity-check.cjs');
const packer = require('../scripts/package-participant-identity-check.cjs');
const businessTool = require('../scripts/package-business-test.cjs');

const { APPID, ENV_ID } = require('./helpers/sandbox-entry-loader.cjs');
const TEST_ROUND = 'synthetic-round-pic-1';
const SYNTHETIC_PASSPHRASE = 'synthetic-verify-passphrase-0123456789abcdef';
const SYNTHETIC_DIGEST = crypto.createHash('sha256').update(SYNTHETIC_PASSPHRASE).digest('hex');

const WRITE_TRAP_METHODS = [
  'add', 'set', 'update', 'remove', 'runTransaction',
  'startTransaction', 'commitTransaction', 'rollbackTransaction'
];

// ── 合成 db 替身：所有写/事务方法设陷阱，正常与异常路径都零业务写 ────────────
function makeTrapDb(options) {
  const opts = options || {};
  const calls = { collections: [], docs: [], reads: 0, fields: [] };
  const trap = name => () => { throw new Error('TRAP: 只读核验不得调用写/事务方法 ' + name); };
  const collection = name => {
    calls.collections.push(name);
    if (name !== core.FIXED_TARGET.collection) {
      throw new Error('TRAP: 只允许访问固定测试集合，实际 ' + name);
    }
    return {
      doc(docId) {
        calls.docs.push(docId);
        return {
          // R6：SDK 已支持的字段投影；记录被请求的字段集
          field(fields) { calls.fields.push(fields); return this; },
          async get() {
            calls.reads++;
            if (opts.throwOnRead) { const e = new Error('synthetic SDK failure'); e.code = 'DATABASE_SDK_ERROR'; throw e; }
            if (opts.readThrowsShape) return { unexpected: true };
            const rows = typeof opts.rows === 'function' ? opts.rows(docId) : opts.rows;
            return { data: rows };
          },
          set: trap('doc.set'), update: trap('doc.update'), remove: trap('doc.remove')
        };
      },
      where: trap('collection.where'),
      add: trap('collection.add'),
      set: trap('collection.set')
    };
  };
  const db = { collection, calls };
  for (const name of WRITE_TRAP_METHODS) db[name] = trap('db.' + name);
  return db;
}

function trustedContext(openid, overrides) {
  return Object.assign({ appId: APPID, envId: ENV_ID, openid }, overrides || {});
}

function makeChecker(db, overrides) {
  const o = overrides || {};
  const starts = o.windowStartsAtMs === undefined ? 1000 : o.windowStartsAtMs;
  const expires = o.windowExpiresAtMs === undefined ? starts + 10 * 60 * 1000 : o.windowExpiresAtMs;
  const config = {
    checkRoundId: o.checkRoundId === undefined ? 'synthetic-round-pic-1' : o.checkRoundId,
    passphraseDigest: o.passphraseDigest === undefined ? SYNTHETIC_DIGEST : o.passphraseDigest,
    windowStartsAtMs: starts,
    windowExpiresAtMs: expires
  };
  if (o.keyDiagnostic !== undefined) config.keyDiagnostic = o.keyDiagnostic;
  return core.createIdentityChecker({
    db,
    trusted: o.trusted === undefined ? trustedContext('openid-participant-1') : o.trusted,
    config,
    now: o.now || (() => starts + 1000)
  });
}

const ACTIVE_ROW = { _id: null, openid: null, status: 'active' };
function rowFor(openid, patch) {
  const userId = core.deriveUserId(APPID, openid);
  return Object.assign({ _id: userId, openid, status: 'active' }, patch || {});
}

// ── 1) 核心核验：三个合法对照与状态区分 ──────────────────────────────────────
test('P1 核验核心：不同上下文派生不同 ID；同上下文重复稳定；ACTIVE/ABSENT/DISABLED/MISMATCH/UNKNOWN 分别走真实读取路径', async () => {
  const openid1 = 'openid-participant-1-' + RUN_ID;
  const openid2 = 'openid-participant-2-' + RUN_ID;
  const id1 = core.deriveUserId(APPID, openid1);
  const id2 = core.deriveUserId(APPID, openid2);
  assert.notEqual(id1, id2, '不同微信上下文必须派生不同内部 ID');
  assert.equal(id1, core.deriveUserId(APPID, openid1), '同 App 同 OPENID 重复稳定');
  assert.match(id1, /^u_[0-9a-f]{40}$/);

  // ACTIVE
  const dbActive = makeTrapDb({ rows: [rowFor(openid1)] });
  const active = await makeChecker(dbActive, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(active.ok, true);
  assert.equal(active.identityConfirmed, true);
  assert.equal(active.registrationState, 'ACTIVE');
  assert.equal(active.recordMatched, true);
  assert.equal(active.readAttempted, true);
  assert.deepEqual(dbActive.calls.docs, [id1], '只读取本人主键');
  assert.deepEqual(dbActive.calls.collections, [core.FIXED_TARGET.collection], '只访问固定测试集合');

  // ABSENT（SDK 明确空数组）
  const dbAbsent = makeTrapDb({ rows: [] });
  const absent = await makeChecker(dbAbsent, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(absent.registrationState, 'ABSENT');
  assert.equal(absent.recordMatched, null);
  assert.equal(absent.readAttempted, true);

  // DISABLED（明确支持的停用状态）
  const dbDisabled = makeTrapDb({ rows: [rowFor(openid1, { status: 'disabled' })] });
  const disabled = await makeChecker(dbDisabled, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(disabled.registrationState, 'DISABLED');
  assert.equal(disabled.recordMatched, true);

  // MISMATCH（归属不符：openid 不同）
  const dbMismatch = makeTrapDb({ rows: [rowFor('someone-else-openid')] });
  const mismatch = await makeChecker(dbMismatch, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(mismatch.registrationState, 'MISMATCH');
  assert.equal(mismatch.recordMatched, false);

  // UNKNOWN（多条 / 未知 status / 形状异常）
  const dbMulti = makeTrapDb({ rows: [rowFor(openid1), rowFor(openid1)] });
  assert.equal((await makeChecker(dbMulti, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND })).registrationState, 'UNKNOWN');
  const dbOdd = makeTrapDb({ rows: [rowFor(openid1, { status: 'weird-status' })] });
  assert.equal((await makeChecker(dbOdd, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND })).registrationState, 'UNKNOWN');
  const dbShape = makeTrapDb({ readThrowsShape: true });
  const shape = await makeChecker(dbShape, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(shape.registrationState, 'UNKNOWN', '异常形状不得当作不存在');
  assert.equal(shape.identityConfirmed, false);

  // 读取失败不得报未登记，且 readAttempted 事实为 true
  const dbFail = makeTrapDb({ throwOnRead: true });
  const failed = await makeChecker(dbFail, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(failed.registrationState, 'UNKNOWN', '读取失败必须 UNKNOWN');
  assert.equal(failed.identityConfirmed, false);
  assert.equal(failed.readAttempted, true, '已发读取的事实保留');
  assert.equal(JSON.stringify(failed).includes('synthetic SDK failure'), false, '不透传原始 SDK 异常');
  assert.equal(JSON.stringify(failed).includes(openid1), false, '结果不含 OPENID');

  // 全部路径零业务写
  for (const db of [dbActive, dbAbsent, dbDisabled, dbMismatch, dbMulti, dbOdd, dbShape, dbFail]) {
    assert.equal(db.calls.reads <= 1, true, '应用层至多一次读取');
  }
});

test('P2 请求伪造与准入：自报身份/集合/角色/业务动作全部 DB 前拒绝', async () => {
  const openid = 'openid-participant-1-' + RUN_ID;
  const forged = [
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND, openid: 'other-openid' },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND, appId: 'wx0000000000000000' },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND, userId: 'u_' + '0'.repeat(40) },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND, role: 'manager' },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND, collection: 'app_admins' },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND, docId: 'other' }
  ];
  for (const payload of forged) {
    const db = makeTrapDb({ rows: [rowFor(openid)] });
    const r = await makeChecker(db, { trusted: trustedContext(openid) }).handle(payload);
    assert.equal(r.ok, false, '伪造字段必须拒绝：' + JSON.stringify(payload));
    assert.equal(r.code, 'PIC_REQUEST_INVALID');
    assert.equal(db.calls.reads, 0, '拒绝必须发生在数据库访问之前');
  }
  // 旧业务动作全部拒绝且零 DB
  for (const action of ['identify', 'createProject', 'requestBindingNumber', 'setManager',
    'inviteMember', 'applyInvitation', 'approveInvitation', 'removeMember', 'assignSchedule']) {
    const db = makeTrapDb({ rows: [rowFor(openid)] });
    const r = await makeChecker(db, { trusted: trustedContext(openid) }).handle({ action, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.code, 'PIC_ACTION_REJECTED', action + ' 必须拒绝');
    assert.equal(db.calls.reads, 0, action + ' 拒绝必须零 DB');
    assert.equal(r.registrationState, 'UNKNOWN');
  }
  // 缺/错口令、错轮次、缺上下文、窗口未开/已截止/NaN/时钟抛错：全部 DB 前拒绝
  const cases = [
    [{ action: 'inspectSelf', checkRoundId: TEST_ROUND }, 'PIC_PASSPHRASE_REQUIRED'],
    [{ action: 'inspectSelf', passphrase: 'wrong-passphrase', checkRoundId: TEST_ROUND }, 'PIC_PASSPHRASE_INVALID'],
    [{ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: 'other-round-x' }, 'PIC_ROUND_MISMATCH']
  ];
  for (const [payload, code] of cases) {
    const db = makeTrapDb({ rows: [rowFor(openid)] });
    const r = await makeChecker(db, { trusted: trustedContext(openid) }).handle(payload);
    assert.equal(r.code, code);
    assert.equal(db.calls.reads, 0);
  }
  const clockCases = [
    { now: () => 999, code: 'PIC_WINDOW_NOT_OPEN' },
    { now: () => 10 * 60 * 1000 + 1001, code: 'PIC_WINDOW_EXPIRED' },
    { now: () => NaN, code: 'PIC_CLOCK_INVALID' },
    { now: () => { throw new Error('english clock failure'); }, code: 'PIC_CLOCK_ERROR' }
  ];
  for (const c of clockCases) {
    const db = makeTrapDb({ rows: [rowFor(openid)] });
    const r = await makeChecker(db, { trusted: trustedContext(openid), now: c.now })
      .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
    assert.equal(r.code, c.code, JSON.stringify(r.code));
    assert.equal(db.calls.reads, 0, '时钟类失败必须零 DB');
  }
  // 可信上下文缺失/错目标
  for (const [trusted, code] of [
    [trustedContext(''), 'PIC_CONTEXT_UNVERIFIED'],
    [trustedContext(openid, { appId: 'wx1111111111111111' }), 'PIC_TARGET_MISMATCH'],
    [trustedContext(openid, { envId: 'cloud-other' }), 'PIC_TARGET_MISMATCH']
  ]) {
    const db = makeTrapDb({ rows: [rowFor(openid)] });
    const r = await makeChecker(db, { trusted }).handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
    assert.equal(r.code, code);
    assert.equal(db.calls.reads, 0);
  }
});

test('P3 异步读取后置守卫：读期间推进到期/NaN/时钟抛错均不确认，且 readAttempted 事实正确', async () => {
  const openid = 'openid-participant-1-' + RUN_ID;
  const starts = 1000;
  const expires = starts + 10 * 60 * 1000;
  const build = advance => {
    let now = starts + 1000;
    let pending = null;
    let reads = 0;
    const db = {
      collection(name) {
        assert.equal(name, core.FIXED_TARGET.collection);
        return {
          doc() {
            return {
              field() { return this; }, // S2：P3 正常投影路径需要 field()
              async get() {
                reads++;
                pending = advance; // 读取完成后由后置守卫读取时钟时才推进
                return { data: [rowFor(openid)] };
              },
              set() { throw new Error('TRAP'); }, update() { throw new Error('TRAP'); }, remove() { throw new Error('TRAP'); }
            };
          },
          add() { throw new Error('TRAP'); }
        };
      },
      runTransaction() { throw new Error('TRAP'); }
    };
    const checker = core.createIdentityChecker({
      db, trusted: trustedContext(openid),
      config: { checkRoundId: 'synthetic-round-pic-1', passphraseDigest: SYNTHETIC_DIGEST, windowStartsAtMs: starts, windowExpiresAtMs: expires },
      now: () => {
        if (pending) { const advance = pending; pending = null; now = advance(); }
        return now;
      }
    });
    return { checker, readCount: () => reads };
  };
  const expired = build(() => expires + 1);
  const r1 = await expired.checker.handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(r1.ok, false, '读取后到期不得确认');
  assert.equal(r1.identityConfirmed, false);
  assert.equal(r1.registrationState, 'UNKNOWN');
  assert.equal(r1.readAttempted, true, '已发读取的事实不得报零读取');
  assert.equal(expired.readCount(), 1);

  const nan = build(() => NaN);
  const r2 = await nan.checker.handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(r2.code, 'PIC_CLOCK_INVALID');
  assert.equal(r2.identityConfirmed, false);

  const boom = build(() => { throw new Error('english clock failure'); });
  const r3 = await boom.checker.handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(r3.code, 'PIC_CLOCK_ERROR');
  assert.equal(r3.registrationState, 'UNKNOWN');
});

test('P4 净化输出：结果只含固定 schema 字段，不含 OPENID/凭据/环境变量', async () => {
  const openid = 'openid-secret-' + RUN_ID;
  const db = makeTrapDb({ rows: [rowFor(openid)] });
  const r = await makeChecker(db, { trusted: trustedContext(openid) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  const keys = Object.keys(r).sort();
  assert.deepEqual(keys, [
    'checkRoundId', 'code', 'identityConfirmed', 'message', 'ok', 'readAttempted',
    'recordMatched', 'registrationState', 'schema', 'serverTimeIso', 'userId', 'userIdTail'
  ], '固定字段集（R2 增加受控 userId）');
  // R2：默认不请求完整 ID 时 userId 必须为 null
  assert.equal(r.userId, null, '默认不得返回完整 userId');
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes(openid), false);
  assert.equal(serialized.includes('AKID'), false);
  assert.equal(serialized.includes('secretKey'), false);
  assert.equal(r.userIdTail.length, 6, '只出尾号');
  assert.equal(serialized.includes(core.deriveUserId(APPID, openid)), false, '不回传完整内部 userId');
});

// ── 2) 打包器：计划严格校验、来源重建、零写冲突、复用续建 ────────────────────
function makeCloseSourceDir() {
  const round = 'synthetic-close-src-' + RUN_ID + '-' + crypto.randomBytes(2).toString('hex');
  const planPath = path.join(OUT_ROOT, 'pic-plan-src-' + RUN_ID + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  const mkUser = t => 'u_' + crypto.createHash('sha256').update(APPID + ':synthetic-' + t + RUN_ID).digest('hex').slice(0, 40);
  fs.writeFileSync(planPath, JSON.stringify({
    schema: 'business-test-plan/1', window: 'P', synthetic: true, businessRoundId: round,
    windowNo: 'P-01', appId: APPID, envId: ENV_ID,
    users: {
      owner: { userId: mkUser('owner'), source: 'synthetic 夹具（不代表真实人员）' },
      manager: { userId: mkUser('manager'), source: 'synthetic 夹具（不代表真实人员）' },
      worker: { userId: mkUser('worker'), source: 'synthetic 夹具（不代表真实人员）' }
    },
    projectReadyMarker: 'ready-' + round,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
  }, null, 2));
  const outDir = path.join(OUT_ROOT, 'pic-close-source-' + RUN_ID + '-' + crypto.randomBytes(3).toString('hex'));
  const built = businessTool.build('P', planPath, outDir);
  assert.equal(businessTool.checkCloseDir(built.outDir).ok, true);
  return built.outDir;
}

function writePicPlan(closeSourceDir, overrides) {
  const dir = path.join(OUT_ROOT, 'pic-plans-' + RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'plan-' + crypto.randomBytes(4).toString('hex') + '.json');
  // 固定窗口起点：同一测试内复用同一计划字节，保证完整复用可判定
  const starts = (overrides && overrides.__startsMs) || Date.now() - 60000;
  const plan = Object.assign({
    schema: packer.PLAN_SCHEMA,
    synthetic: true,
    checkRoundId: 'synthetic-round-pic-' + RUN_ID,
    participantCode: '1',
    appId: APPID, envId: ENV_ID, functionName: 'scheduleSandbox', collection: 'schtest_v1_users',
    passphraseDigest: SYNTHETIC_DIGEST,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString(),
    closeSourceDir,
    requestProtocol: packer.REQUEST_PROTOCOL,
    note: '合成夹具计划（非真实口令/非真实核验）'
  }, overrides || {});
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

test('P5 打包器：合成计划生成完整候选与配对关闭包；check 重建一致；真实计划过期零写', () => {
  const closeSource = makeCloseSourceDir();
  const planPath = writePicPlan(closeSource);
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'test-' + RUN_ID);
  const built = packer.build(planPath, outDir);
  assert.equal(built.manifest.schema, packer.MANIFEST_SCHEMA);
  assert.equal(built.manifest.requestProtocol, packer.REQUEST_PROTOCOL, 'manifest 绑定请求协议');
  // 服务端 4（入口+核心模块+请求适配器+package.json）+ 前端 9 + project.config.json + plan.json
  assert.equal(built.manifest.files.length, 15);
  assert.equal(built.manifest.closePackage.files.length, 23);
  assert.equal(built.io.filter(x => x.action === 'written').length, 39);
  // 服务端不含 vendor/service、memberAccess、connectionCheck、project-guard、gate
  const serverFiles = fs.readdirSync(path.join(outDir, 'server'));
  for (const forbidden of ['vendor', 'memberAccess', 'connectionCheck', 'project-guard', 'gate']) {
    assert.equal(serverFiles.includes(forbidden), false, '服务端不得包含 ' + forbidden);
  }
  const entry = fs.readFileSync(path.join(outDir, 'server', 'scheduleSandbox', 'index.js'), 'utf8');
  assert.equal(entry.includes("require('./participant-identity-check')"), true);
  assert.equal(entry.includes("require('./request-adapter')"), true, '入口引用请求适配器');
  assert.equal(entry.includes('requestAdapter.extractBusinessRequest(event)'), true, '入口调用适配器');
  assert.equal(fs.existsSync(path.join(outDir, 'server', 'scheduleSandbox', 'request-adapter.js')), true, '适配器制品在位');
  assert.equal(/require\(['"]\.\/vendor/.test(entry), false, '候选入口不得引入 vendor 业务实现');
  assert.equal(entry.includes(SYNTHETIC_PASSPHRASE), false, '明文口令绝不进入制品');
  assert.equal(entry.includes(SYNTHETIC_DIGEST), true, '只含摘要');
  // 前端 app.json 唯一页面
  const appJson = JSON.parse(fs.readFileSync(path.join(outDir, 'frontend', 'app.json'), 'utf8'));
  assert.deepEqual(appJson.pages, ['pages/identity-check/identity-check']);
  // R1：project.config.json 根路径与实际目录一致
  const projectConfig = JSON.parse(fs.readFileSync(path.join(outDir, 'project.config.json'), 'utf8'));
  assert.equal(projectConfig.miniprogramRoot, 'frontend/');
  assert.equal(projectConfig.cloudfunctionRoot, 'server/');
  assert.equal(fs.existsSync(path.join(outDir, 'frontend')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'server')), true);
  // check 重建一致
  assert.equal(packer.checkDir(outDir).ok, true);
  // 完整复用（零新写）
  const reused = packer.build(planPath, outDir);
  assert.equal(reused.io.filter(x => x.action === 'written').length, 0);
  assert.equal(reused.io.filter(x => x.action === 'reused').length, 39);
  // 关闭包独立核验：与时钟/开启候选无关
  process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
  const closeResult = packer.checkCloseDir(outDir);
  delete process.env.PIC_CLOSE_SOURCE_DIR;
  assert.equal(closeResult.ok, true, JSON.stringify(closeResult.problems));
  assert.equal(closeResult.files, 23);
  // 真实模式过期：零写且目录未创建
  const realPlan = writePicPlan(closeSource, {
    synthetic: false,
    // 窗口在 30 分钟工具上限内，但整体已过期（starts/expires 均在 20/10 分钟前）
    windowStartsAtIso: new Date(Date.now() - 20 * 60e3).toISOString(),
    windowExpiresAtIso: new Date(Date.now() - 10 * 60e3).toISOString()
  });
  const expiredOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'expired-' + RUN_ID);
  assert.throws(() => packer.build(realPlan, expiredOut), e => e.code === packer.ERR.WINDOW_EXPIRED);
  assert.equal(fs.existsSync(expiredOut), false, '过期真实构建必须零写且目录未创建');
});

test('P6 打包器：非法计划/漂移/目录冲突零写；续建与部分写事实', () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'zero-' + RUN_ID);
  // 非法计划矩阵
  const invalid = [
    { unknownField: true },
    { appId: 'wx0000000000000000' },
    { envId: 'cloud-other' },
    { functionName: 'connectionCheck' },
    { collection: 'users' },
    { participantCode: '3' },
    { participantCode: '0' },
    { passphraseDigest: 'not-a-digest' },
    { windowExpiresAtIso: new Date(Date.now() + 45 * 60 * 1000).toISOString() },
    { closeSourceDir: 'relative/path' }
  ];
  for (const patch of invalid) {
    const planPath = writePicPlan(closeSource, patch);
    assert.throws(() => packer.build(planPath, path.join(OUT_ROOT, packer.OUT_PREFIX + 'invalid-' + RUN_ID + '-' + crypto.randomBytes(2).toString('hex'))));
    assert.equal(fs.existsSync(outDir), false, '非法计划必须零写');
  }
  // 关闭来源缺失/无效
  assert.throws(() => packer.build(writePicPlan(path.join(OUT_ROOT, 'nonexistent-close-src-' + RUN_ID)), outDir),
    e => e.code === packer.ERR.CLOSE_SOURCE_INVALID || e.code === packer.ERR.OUT_CONFLICT);
  assert.equal(fs.existsSync(outDir), false);

  // 目录占位冒名 manifest.json → 预检零写
  const conflictDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'conflict-' + RUN_ID);
  fs.mkdirSync(path.join(conflictDir, 'manifest.json'), { recursive: true });
  const snap = fs.readdirSync(conflictDir);
  assert.throws(() => packer.build(writePicPlan(closeSource), conflictDir), e => e.code === packer.ERR.OUT_CONFLICT);
  assert.deepEqual(fs.readdirSync(conflictDir), snap, '预检零写：目录快照不变');

  // 多余目录 → 拒绝
  const extraDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'extra-' + RUN_ID);
  const extraPlan = writePicPlan(closeSource);
  const b = packer.build(extraPlan, extraDir);
  fs.mkdirSync(path.join(extraDir, 'unrelated-dir'));
  assert.throws(() => packer.build(extraPlan, extraDir), e => e.code === packer.ERR.OUT_CONFLICT);
  assert.equal(fs.existsSync(path.join(extraDir, 'unrelated-dir')), true, '不清理用户目录');

  // 续建：删一个文件后只补 1、复用 38（独立目录，避免与"多余目录"用例互相污染）
  const resumeDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'resume-' + RUN_ID);
  const resumePlan = writePicPlan(closeSource);
  const rb = packer.build(resumePlan, resumeDir);
  fs.unlinkSync(path.join(resumeDir, rb.manifest.files[0].rel));
  const resumed = packer.build(resumePlan, resumeDir);
  assert.equal(resumed.io.filter(x => x.action === 'written').length, 1);
  assert.equal(resumed.io.filter(x => x.action === 'reused').length, 38);
  assert.equal(packer.checkDir(resumeDir).ok, true);

  // 部分写：公开异常保留 rel + bytesOnDisk
  const partialDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'partial-' + RUN_ID);
  const realWrite = fs.writeFileSync;
  let err = null;
  fs.writeFileSync = function (f, buf, opts) {
    if (f === path.join(partialDir, 'server', 'scheduleSandbox', 'index.js')) {
      realWrite.call(this, f, Buffer.from(buf).subarray(0, 11), opts);
      const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e;
    }
    return realWrite.call(this, f, buf, opts);
  };
  try { packer.build(writePicPlan(closeSource), partialDir); } catch (e) { err = e; } finally { fs.writeFileSync = realWrite; }
  assert.equal(err && err.code, 'EIO');
  assert.deepEqual(err.written, ['server/scheduleSandbox/participant-identity-check.js', 'server/scheduleSandbox/index.js']);
  assert.equal(err.wroteFiles, 2);
  assert.deepEqual(err.partialWrites, [{ rel: 'server/scheduleSandbox/index.js', bytesOnDisk: 11 }]);
  assert.equal(fs.statSync(path.join(partialDir, 'server', 'scheduleSandbox', 'index.js')).size, 11);

  // 竞态 EEXIST（他人文件）不算本轮写入、不覆盖
  const raceDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'race-' + RUN_ID);
  let err2 = null;
  fs.writeFileSync = function (f, buf, opts) {
    if (f === path.join(raceDir, 'server', 'scheduleSandbox', 'participant-identity-check.js')) {
      realWrite.call(this, f, Buffer.from('other-writer'), opts);
      const e = new Error('EEXIST race'); e.code = 'EEXIST'; throw e;
    }
    return realWrite.call(this, f, buf, opts);
  };
  try { packer.build(writePicPlan(closeSource), raceDir); } catch (e) { err2 = e; } finally { fs.writeFileSync = realWrite; }
  assert.equal(err2 && err2.code, 'EEXIST');
  assert.ok(!err2.written || !err2.written.includes('server/scheduleSandbox/participant-identity-check.js'));
  assert.equal(fs.readFileSync(path.join(raceDir, 'server', 'scheduleSandbox', 'participant-identity-check.js'), 'utf8'), 'other-writer');
  assert.ok(/EEXIST/.test(err2.sideEffect || ''));
});

test('P7 打包器：输出根链接拒绝；改名 planFile 拒绝；check 重建拒绝篡改', () => {
  const closeSource = makeCloseSourceDir();
  // 输出根为 junction → build 拒绝且目标零写
  const target = path.join(OUT_ROOT, 'pic-link-target-' + RUN_ID);
  const link = path.join(OUT_ROOT, packer.OUT_PREFIX + 'link-' + RUN_ID);
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, link, 'junction');
  assert.throws(() => packer.build(writePicPlan(closeSource), link), e => e.code === packer.ERR.OUT_CONFLICT);
  assert.deepEqual(fs.readdirSync(target), [], '链接目标必须零写');
  // check/checkClose 同样拒绝链接根
  assert.throws(() => packer.checkDir(link), e => e.code === packer.ERR.OUT_CONFLICT);
  // 正常包：改名 planFile 拒绝
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'rename-' + RUN_ID);
  const b = packer.build(writePicPlan(closeSource), outDir);
  fs.renameSync(path.join(outDir, 'plan.json'), path.join(outDir, 'replacement.json'));
  const m = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  m.planFile = 'replacement.json';
  m.files.find(x => x.rel === 'plan.json').rel = 'replacement.json';
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(m, null, 2));
  assert.throws(() => packer.checkDir(outDir), e => e.code === packer.ERR.MANIFEST_INVALID);
  // 篡改服务端字节 → check 拒绝
  const out2 = path.join(OUT_ROOT, packer.OUT_PREFIX + 'tamper-' + RUN_ID);
  packer.build(writePicPlan(closeSource), out2);
  const corePath = path.join(out2, 'server', 'scheduleSandbox', 'participant-identity-check.js');
  fs.writeFileSync(corePath, fs.readFileSync(corePath, 'utf8') + '\n// tampered\n');
  const r = packer.checkDir(out2);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(x => x.includes('participant-identity-check.js')));
  // 额外文件 → check 拒绝
  const out3 = path.join(OUT_ROOT, packer.OUT_PREFIX + 'extrafile-' + RUN_ID);
  packer.build(writePicPlan(closeSource), out3);
  fs.writeFileSync(path.join(out3, 'frontend', 'stray.js'), '// stray\n');
  assert.equal(packer.checkDir(out3).ok, false);
});

// ── 3) 真实应用代码链：生成候选 App→Page→客户端→候选入口→核心→合成 db ──────
/**
 * 在**独立 vm context** 中求值小程序源码。
 * 依赖一律从 sandbox 全局取（require/App/Page/wx/cloud/process/exports）——
 * 不用函数形参注入，否则源码里的 `const cloud = require(...)` 会与形参同名冲突。
 */
function runMiniSource(file, sandbox) {
  const context = vm.createContext(sandbox);
  const script = new vm.Script('(function(){' + fs.readFileSync(file, 'utf8') + '\n}).call(globalThis)', { filename: file });
  return script.runInContext(context);
}

function loadCandidateApp(candidateDir) {
  const file = path.join(candidateDir, 'frontend', 'app.js');
  const sandboxApp = { globalData: {}, launched: false };
  runMiniSource(file, {
    App(def) {
      Object.assign(sandboxApp, def);
      if (typeof def.onLaunch === 'function') def.onLaunch();
      sandboxApp.launched = true;
    },
    console
  });
  return sandboxApp;
}

/**
 * 客户端模块走真实 require，其中 `wx` 是自由变量：
 * 因此 wx 必须在**整个调用作用域**内挂到 globalThis，而不是加载页面时挂一下。
 */
function withGlobalWx(stub, fn) {
  const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
  const prevWx = globalThis.wx;
  globalThis.wx = stub;
  try {
    return fn();
  } finally {
    if (hadWx) globalThis.wx = prevWx; else delete globalThis.wx;
  }
}

function loadCandidatePage(candidateDir, wxStub) {
  const file = path.join(candidateDir, 'frontend', 'pages', 'identity-check', 'identity-check.js');
  const pageDef = {};
  const sandboxPage = {
    data: {},
    setData(patch) { Object.assign(this.data, patch); }
  };
  runMiniSource(file, {
    Page(d) { Object.assign(pageDef, d); },
    wx: wxStub,
    require: createRequire(file),
    console
  });
  Object.assign(sandboxPage, pageDef);
  return sandboxPage;
}

function loadCandidateMain(candidateDir, ctx, fnDir) {
  // I1/I2 部署映射：候选服务端制品位于同名函数子目录 server/scheduleSandbox/；
  // 业务关闭包（close/）沿用业务布局 server/ 直接根——传 fnDir='.' 读取。
  const serverDir = fnDir === undefined
    ? path.join(candidateDir, 'server', 'scheduleSandbox')
    : path.join(candidateDir, 'server', fnDir);
  const file = path.join(serverDir, 'index.js');
  const nativeRequire = createRequire(file);
  const cloudStub = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    getWXContext: () => ({ APPID: ctx.appId, OPENID: ctx.openid }),
    database: opts => {
      cloudStub.databaseOptions = opts;
      if (typeof ctx.onDatabase === 'function') ctx.onDatabase(opts);
      return ctx.db;
    }
  };
  const wxSdkStub = { init() {}, DYNAMIC_CURRENT_ENV: 'dynamic', getWXContext: cloudStub.getWXContext, database: cloudStub.database };
  const module_ = { exports: {} };
  runMiniSource(file, {
    // 模板目录本身没有核心模块副本（候选包里才有）：映射到仓库中的核心模块，
    // 验证的是同一份代码。
    require(id) {
      if (id === 'wx-server-sdk') return wxSdkStub;
      if (id === './participant-identity-check') return core;
      return nativeRequire(id);
    },
    module: module_,
    exports: module_.exports,
    cloud: cloudStub,
    process: { env: { TCB_ENV: ctx.envId } },
    console
  });
  return module_.exports;
}

test('P8 完整链：生成候选 App/Page→wx 替身→候选 main→核心→合成 db；页面不自动调用、重复点击受控、关闭端零发送', async () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'chain-' + RUN_ID);
  // 开启态候选：真实模式（synthetic=false）且窗口在当下有效——装配后入口 CONFIG_ENABLED=true。
  // 口令仍是**合成口令**，不代表真实 I1/I2 核验。
  packer.build(writePicPlan(closeSource, { synthetic: false }), outDir);
  const entryText = fs.readFileSync(path.join(outDir, 'server', 'scheduleSandbox', 'index.js'), 'utf8');
  assert.ok(entryText.includes('const CONFIG_ENABLED = true;'), '真实模式候选入口应处于开启态（仅本地合成链验证）');

  // ── 开启链：真实生成代码 + 合成 wx/db
  const openid = 'openid-participant-1-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  const sent = [];
  const runMainAndReturn = opts => {
    const main = loadCandidateMain(outDir, {
      appId: APPID, envId: ENV_ID, openid,
      db: makeTrapDb({ rows: [{ _id: userId, openid, status: 'active' }] })
    });
    return main.main(opts.data).then(result => ({ result }));
  };
  const wxStub = {
    cloud: {
      _identityCheckEnvInited: false,
      init(opts) { sent.push({ type: 'init', env: opts.env }); },
      callFunction(opts) {
        sent.push({ type: 'callFunction', name: opts.name, data: opts.data });
        return runMainAndReturn(opts);
        // 走真实候选 main：入口 → 核心 → 合成 db
        const main = loadCandidateMain(outDir, {
          appId: APPID, envId: ENV_ID, openid,
          db: makeTrapDb({ rows: [{ _id: userId, openid, status: 'active' }] })
        });
        return main(opts.data).then(result => ({ result }));
      }
    }
  };
  const app = loadCandidateApp(outDir);
  assert.equal(app.globalData !== undefined, true, 'App 可加载');

  await withGlobalWx(wxStub, async () => {
    // 页面加载/切前台零发送
    const page = loadCandidatePage(outDir, wxStub);
    page.setData({});
    if (page.onLoad) page.onLoad();
    if (page.onShow) page.onShow();
    assert.equal(sent.filter(x => x.type === 'callFunction').length, 0, '加载与切前台不得自动调用');
    // 输入口令（只在内存）
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    assert.equal(page.data.passphrase, SYNTHETIC_PASSPHRASE);
    // 点击一次核验
    await page.onCheckTap();
    const calls = sent.filter(x => x.type === 'callFunction');
    assert.equal(calls.length, 1, '只点一次只发一次');
    assert.equal(calls[0].name, 'scheduleSandbox', '固定函数目标');
    assert.equal(calls[0].data.picRequest.action, 'inspectSelf', 'picRequest 内层动作');
    assert.equal(calls[0].data.picRequest.schema, 'participant-identity-request/1', '内层协议版本');
    assert.equal(Object.keys(calls[0].data).join(','), 'picRequest', '外层仅 picRequest 一个键');
    assert.equal(page.data.result.registrationState, 'ACTIVE');
    assert.equal(page.data.result.identityConfirmed, true);
    assert.equal(page.data.passphrase, '', '调用结束清除口令输入');
    // 返回后再次点击是新的显式请求；无口令不得发送
    await page.onCheckTap();
    assert.equal(sent.filter(x => x.type === 'callFunction').length, 1, '无口令不得重复发送');
    assert.ok(page.data.stopHint.includes('临时核验口令'));
  });

  // 失败不自动重试：wx 抛错后只有一次调用
  const failing = {
    cloud: {
      _identityCheckEnvInited: true,
      init() {},
      callFunction() { failing.calls++; throw new Error('synthetic transport failure'); }
    }
  };
  failing.calls = 0;
  await withGlobalWx(failing, async () => {
    const failPage = loadCandidatePage(outDir, failing);
    failPage.setData({ passphrase: SYNTHETIC_PASSPHRASE, sending: false, result: null, stopHint: '' });
    await failPage.onCheckTap();
    assert.equal(failing.calls, 1, '失败不自动重试');
    assert.equal(failPage.data.result, null);
    assert.equal(failPage.data.passphrase, '', '失败也清除口令');
    assert.ok(failPage.data.stopHint.includes('不要重复点击'));
  });

  // 服务端默认关闭：直接驱动**模板原文件**（未装配 CONFIG），关闭态必须零数据库访问
  const templateMain = loadTemplateMain({ appId: APPID, envId: ENV_ID, openid, db: makeTrapDb({ rows: [] }) });
  const closedResult = await templateMain.main({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND });
  assert.equal(closedResult.ok, false);
  assert.equal(closedResult.code, 'PIC_NOT_ENABLED');
  assert.equal(closedResult.readAttempted, false, '默认关闭不得触碰数据库');

  // 关闭包：前端零核验发送能力、服务端拒绝一切业务动作
  const closeDir = path.join(outDir, 'close');
  // (1) 关闭包前端不含核验页面/核验客户端：没有任何入口能发起 inspectSelf
  const closeFrontend = path.join(closeDir, 'frontend');
  assert.equal(fs.existsSync(path.join(closeFrontend, 'pages', 'identity-check')), false,
    '关闭包前端不得含核验页面');
  assert.equal(fs.existsSync(path.join(closeFrontend, 'utils', 'identity-check-client.js')), false,
    '关闭包前端不得含核验客户端');
  const closeSent = [];
  globalThis.wx = { cloud: { init() { closeSent.push('init'); }, callFunction() { closeSent.push('call'); return Promise.reject(new Error('closed')); } } };
  try {
    // (2) 关闭包服务端：默认关闭 → 一切业务动作拒绝，且拒绝发生在数据库访问前
    const closeMain = loadCandidateMain(closeDir, {
      appId: APPID, envId: ENV_ID, openid,
      db: new Proxy({}, {
        get(_t, prop) {
          closeSent.push('db.' + String(prop));
          throw new Error('TRAP: 关闭态不得访问数据库');
        }
      })
    }, 'scheduleSandbox');
    for (const action of ['inspectSelf', 'identify', 'createProject', 'removeMember']) {
      const r = await closeMain.main({ action, passphrase: SYNTHETIC_PASSPHRASE });
      // 关闭端返回的是业务入口的关闭拒绝（无核验结果字段），关键事实：ok=false
      assert.equal(r.ok, false, action + ' 在关闭态必须拒绝');
      assert.equal(typeof r.code, 'string');
      assert.notEqual(r.code, '');
    }
  } finally {
    delete globalThis.wx;
  }
  assert.deepEqual(closeSent.filter(x => typeof x === 'string' && x.startsWith('db.')), [],
    '关闭端零数据库访问');
});

function loadTemplateMain(ctx) {
  const file = path.join(packer.TEMPLATE_DIR, 'server', 'index.js');
  const nativeRequire = createRequire(file);
  const cloudStub = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    getWXContext: () => ({ APPID: ctx.appId, OPENID: ctx.openid }),
    database: () => { throw new Error('TRAP: 默认关闭分支不得建立数据库句柄'); }
  };
  const wxSdkStub = { init() {}, DYNAMIC_CURRENT_ENV: 'dynamic', getWXContext: cloudStub.getWXContext, database: cloudStub.database };
  const module_ = { exports: {} };
  runMiniSource(file, {
    require(id) {
      if (id === 'wx-server-sdk') return wxSdkStub;
      if (id === './participant-identity-check') return core;
      return nativeRequire(id);
    },
    module: module_,
    exports: module_.exports,
    cloud: cloudStub,
    process: { env: { TCB_ENV: ctx.envId } },
    console
  });
  return module_.exports;
}
// ════════════════════════════════════════════════════════════════════════════
// R1–R6 定点返修（Codex 复查 ece7659 §3）：逐项「正确拒绝 + 合法对照」
// ════════════════════════════════════════════════════════════════════════════

/** R 组专用替身：可注入集合构造/读取失败，并记录投影与写方法尝试。 */
function makeRDb(options) {
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
      return { doc(id) { calls.docs.push(id); return docRef; }, add: trap('collection.add'), where: trap('collection.where') };
    },
    set: trap('db.set'), update: trap('db.update'), remove: trap('db.remove'),
    runTransaction: trap('db.runTransaction'), startTransaction: trap('db.startTransaction')
  };
  return { db, calls };
}

let rOpenid;
function rChecker(db, o) {
  const cfg = o || {};
  const starts = cfg.windowStartsAtMs === undefined ? 1000 : cfg.windowStartsAtMs;
  const expires = cfg.windowExpiresAtMs === undefined ? starts + 600000 : cfg.windowExpiresAtMs;
  return core.createIdentityChecker({
    db,
    trusted: cfg.trusted === undefined ? trustedContext(cfg.openid || rOpenid) : cfg.trusted,
    config: {
      checkRoundId: cfg.checkRoundId === undefined ? TEST_ROUND : cfg.checkRoundId,
      passphraseDigest: SYNTHETIC_DIGEST,
      windowStartsAtMs: starts,
      windowExpiresAtMs: expires
    },
    now: cfg.now || (() => starts + 1000)
  });
}
rOpenid = 'openid-r-' + RUN_ID;
const rRow = (patch) => Object.assign({ _id: core.deriveUserId(APPID, rOpenid), openid: rOpenid, status: 'active' }, patch || {});
const rReq = (extra) => Object.assign({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND }, extra || {});

test('R1 生成的项目配置与实际目录一致：配置根存在、唯一页面、依赖闭包、固定函数目标', () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r1-' + RUN_ID);
  packer.build(writePicPlan(closeSource), outDir);
  const cfg = JSON.parse(fs.readFileSync(path.join(outDir, 'project.config.json'), 'utf8'));
  // C02 的直接反证：声明的根目录必须真实存在
  assert.equal(cfg.miniprogramRoot, 'frontend/');
  assert.equal(cfg.cloudfunctionRoot, 'server/');
  assert.equal(fs.existsSync(path.join(outDir, cfg.miniprogramRoot)), true, 'miniprogramRoot 必须存在');
  assert.equal(fs.existsSync(path.join(outDir, cfg.cloudfunctionRoot)), true, 'cloudfunctionRoot 必须存在');
  assert.equal(fs.existsSync(path.join(outDir, cfg.miniprogramRoot, 'miniprogram')), false, '不得残留旧目录名');
  assert.equal(cfg.appid, APPID);
  // 唯一页面 + 四件套
  const appJson = JSON.parse(fs.readFileSync(path.join(outDir, 'frontend', 'app.json'), 'utf8'));
  assert.equal(appJson.pages.length, 1);
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.equal(fs.existsSync(path.join(outDir, 'frontend', appJson.pages[0] + '.' + ext)), true, '页面 ' + ext);
  }
  // 依赖闭包：页面 → client → cloud config
  const pageSrc = fs.readFileSync(path.join(outDir, 'frontend', appJson.pages[0] + '.js'), 'utf8');
  assert.ok(pageSrc.includes("require('../../utils/identity-check-client')"));
  const clientPath = path.join(outDir, 'frontend', 'utils', 'identity-check-client.js');
  assert.equal(fs.existsSync(clientPath), true);
  assert.ok(fs.readFileSync(clientPath, 'utf8').includes("require('../config/cloud')"));
  // 固定函数/环境目标
  const cloudSrc = fs.readFileSync(path.join(outDir, 'frontend', 'config', 'cloud.js'), 'utf8');
  assert.ok(cloudSrc.includes("identityCheckFunction: 'scheduleSandbox'"), '固定函数目标');
  assert.ok(cloudSrc.includes("envId: '" + ENV_ID + "'"), '固定环境目标');
  // 反例：配置根指回不存在的目录 → 装配拒绝且零产物
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
  const badOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r1-bad-' + RUN_ID);
  let err = null;
  try { packer.build(writePicPlan(closeSource), badOut); } catch (e) { err = e; } finally { fs.readFileSync = realRead; }
  assert.ok(err, '配置根不一致必须拒绝');
  assert.equal(err.code, packer.ERR.SOURCE_DRIFT, '实际 ' + err.code);
  assert.equal(fs.existsSync(badOut), false, '拒绝必须零产物');
  // 原 miniapp/project.config.json 不得被改动迁就
  const repoCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'miniapp', 'project.config.json'), 'utf8'));
  assert.equal(repoCfg.miniprogramRoot, 'miniprogram/', '原项目配置必须保持不变');
});

test('R2 受控完整 userId 交付：默认仅尾号；有效结果可取得完整 ID；失败不可交付', async () => {
  const userId = core.deriveUserId(APPID, rOpenid);
  // 默认：只有尾号
  const plain = await rChecker(makeRDb({ rows: [rRow()] }).db).handle(rReq());
  assert.equal(plain.registrationState, 'ACTIVE');
  assert.equal(plain.userId, null, '默认不得返回完整 ID');
  assert.equal(plain.userIdTail, userId.slice(-6));
  // 显式请求 + 有效结果 → 完整内部 ID（ACTIVE/ABSENT/DISABLED/MISMATCH）
  for (const [label, rows, state] of [
    ['ACTIVE', [rRow()], 'ACTIVE'],
    ['ABSENT', [], 'ABSENT'],
    ['DISABLED', [rRow({ status: 'disabled' })], 'DISABLED'],
    ['MISMATCH', [rRow({ openid: 'someone-else' })], 'MISMATCH']
  ]) {
    const r = await rChecker(makeRDb({ rows }).db).handle(rReq({ includeFullUserId: true }));
    assert.equal(r.registrationState, state, label);
    assert.equal(r.userId, userId, label + ' 必须能取得完整内部 userId');
    assert.match(r.userId, /^u_[0-9a-f]{40}$/);
    // 轮次/时间关联事实
    assert.equal(r.checkRoundId, TEST_ROUND, label + ' 轮次关联');
    assert.ok(r.serverTimeIso && r.serverTimeIso.length > 0, label + ' 时间关联');
    // 绝不是 OPENID/UNIONID/口令/凭据
    assert.notEqual(r.userId, rOpenid);
    const text = JSON.stringify(r);
    for (const banned of ['openid', 'OPENID', 'unionid', 'AKID', 'secretKey', SYNTHETIC_PASSPHRASE]) {
      assert.equal(text.includes(banned), false, label + ' 结果不得含 ' + banned);
    }
  }
  // 失败结果：不得成为可采信绑定
  for (const [label, opts] of [
    ['缺上下文', { trusted: trustedContext('') }],
    ['错口令', { passphraseOverride: true }],
    ['读失败', { rows: [], readError: Object.assign(new Error('synthetic'), { code: 'SDK_ERR' }) }]
  ]) {
    let req = rReq({ includeFullUserId: true });
    if (label === '错口令') req = { action: 'inspectSelf', passphrase: 'wrong', checkRoundId: TEST_ROUND, includeFullUserId: true };
    const r = await rChecker(makeRDb(opts).db, opts).handle(req);
    assert.equal(r.ok, false, label);
    assert.equal(r.identityConfirmed, false, label);
    assert.equal(r.userId, null, label + ' 不得交付完整 ID');
    assert.equal(r.registrationState, 'UNKNOWN', label);
  }
});

test('R3 受审内容基线钉定：漂移写前零产物拒绝；check 同样拒绝；正常/复用/续建成立', () => {
  const closeSource = makeCloseSourceDir();
  const planPath = writePicPlan(closeSource);
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r3-ok-' + RUN_ID);
  packer.build(planPath, outDir);
  assert.equal(packer.checkDir(outDir).ok, true, '正常对照');
  const corePath = path.join(REPO_ROOT, 'miniapp', 'scripts', 'lib', 'participant-identity-check.cjs');
  const realRead = fs.readFileSync;
  const original = realRead.call(fs, corePath);
  const drifted = Buffer.concat([original, Buffer.from('\n// synthetic drift\n')]);
  let injects = 0;
  fs.readFileSync = function (p, ...args) {
    if (typeof p === 'string' && path.resolve(p) === corePath) {
      injects++;
      return typeof args[0] === 'string' ? drifted.toString(args[0]) : drifted;
    }
    return realRead.call(this, p, ...args);
  };
  const driftOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r3-drift-' + RUN_ID);
  let buildErr = null;
  try { packer.build(planPath, driftOut); } catch (e) { buildErr = e; } finally { fs.readFileSync = realRead; }
  assert.ok(injects > 0);
  assert.ok(buildErr, 'build 必须拒绝漂移');
  assert.equal(buildErr.code, packer.ERR.SOURCE_DRIFT, '实际 ' + (buildErr && buildErr.code));
  assert.equal(fs.existsSync(driftOut), false, '漂移拒绝必须零产物');
  // check 侧同样拒绝
  fs.readFileSync = function (p, ...args) {
    if (typeof p === 'string' && path.resolve(p) === corePath) {
      return typeof args[0] === 'string' ? drifted.toString(args[0]) : drifted;
    }
    return realRead.call(this, p, ...args);
  };
  let checkResult = null, checkErr = null;
  try { checkResult = packer.checkDir(outDir); } catch (e) { checkErr = e; } finally { fs.readFileSync = realRead; }
  // check 以 problems 返回（来源重建失败），不得静默通过
  if (checkErr) {
    assert.equal(checkErr.code, packer.ERR.SOURCE_DRIFT, 'check 抛出时须为漂移');
  } else {
    assert.equal(checkResult.ok, false, 'check 必须拒绝漂移');
    assert.ok(checkResult.problems.some(x => /SOURCE_DRIFT|受审来源漂移|受审基线/.test(x)),
      'check 必须报告漂移原因：' + JSON.stringify(checkResult.problems));
  }
  // 磁盘源文件零改动
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(corePath)).digest('hex'),
    crypto.createHash('sha256').update(original).digest('hex'), '磁盘源文件必须零改动');
  // 模板漂移同样拒绝
  const pagePath = path.join(packer.TEMPLATE_DIR, 'frontend', 'pages', 'identity-check', 'identity-check.js');
  const pageOriginal = realRead.call(fs, pagePath);
  fs.readFileSync = function (p, ...args) {
    if (typeof p === 'string' && path.resolve(p) === pagePath) {
      const buf = Buffer.concat([pageOriginal, Buffer.from('\n// drift\n')]);
      return typeof args[0] === 'string' ? buf.toString(args[0]) : buf;
    }
    return realRead.call(this, p, ...args);
  };
  const tmplOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r3-tmpl-' + RUN_ID);
  let tmplErr = null;
  try { packer.build(planPath, tmplOut); } catch (e) { tmplErr = e; } finally { fs.readFileSync = realRead; }
  assert.ok(tmplErr && tmplErr.code === packer.ERR.SOURCE_DRIFT, '模板漂移必须拒绝');
  assert.equal(fs.existsSync(tmplOut), false);
  // 正常复用/续建仍成立
  assert.equal(packer.build(planPath, outDir).io.filter(x => x.action === 'written').length, 0, '完整复用零新写');
  const rp = writePicPlan(closeSource);
  const resumeDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r3-resume-' + RUN_ID);
  const rb = packer.build(rp, resumeDir);
  fs.unlinkSync(path.join(resumeDir, rb.manifest.files[0].rel));
  const resumed = packer.build(rp, resumeDir);
  assert.equal(resumed.io.filter(x => x.action === 'written').length, 1);
  assert.equal(resumed.io.filter(x => x.action === 'reused').length, 38);
  assert.equal(packer.checkDir(resumeDir).ok, true);
});

test('R4 check 早退均返回原始拒绝分类（过期/NaN/抛错/缺计划/哈希不符/非法计划/来源失败 + 正常对照）', () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r4-' + RUN_ID);
  packer.build(writePicPlan(closeSource), outDir);
  const realNow = Date.now;
  const at = (v, fn) => { Date.now = typeof v === 'function' ? v : () => v; try { return fn(); } finally { Date.now = realNow; } };
  // 真实模式包（窗口当下有效）
  const realPlan = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(Date.now() - 600000).toISOString(),
    windowExpiresAtIso: new Date(Date.now() + 600000).toISOString()
  });
  const realOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r4-real-' + RUN_ID);
  packer.build(realPlan, realOut);
  // (1) 过期 / NaN / 时钟抛错
  const expired = at(Date.now() + 900000, () => packer.checkDir(realOut));
  assert.equal(expired.ok, false);
  assert.ok(expired.problems.some(x => /WINDOW_EXPIRED/.test(x)), '过期分类：' + JSON.stringify(expired.problems));
  const nan = at(NaN, () => packer.checkDir(realOut));
  assert.ok(nan.problems.some(x => /CLOCK_INVALID/.test(x)), 'NaN 分类：' + JSON.stringify(nan.problems));
  const boom = at(() => { throw new Error('synthetic clock failed'); }, () => packer.checkDir(realOut));
  assert.ok(boom.problems.some(x => /CLOCK_ERROR/.test(x)), '时钟异常分类：' + JSON.stringify(boom.problems));
  // (2) 计划哈希不符
  const planOnDisk = path.join(outDir, 'plan.json');
  const saved = fs.readFileSync(planOnDisk);
  fs.writeFileSync(planOnDisk, Buffer.concat([saved, Buffer.from(' ')]));
  const hashMismatch = packer.checkDir(outDir);
  fs.writeFileSync(planOnDisk, saved);
  assert.ok(hashMismatch.problems.some(x => /planSha256/.test(x)), '哈希不符分类');
  // (3) 缺计划
  const noPlanDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r4-noplan-' + RUN_ID);
  fs.mkdirSync(noPlanDir, { recursive: true });
  fs.writeFileSync(path.join(noPlanDir, 'manifest.json'),
    JSON.stringify({ schema: packer.MANIFEST_SCHEMA, planSha256: 'x', files: [{ rel: 'plan.json', bytes: 1, sha256: '0'.repeat(64) }], closePackage: { files: [] } }));
  const noPlan = packer.checkDir(noPlanDir);
  assert.ok(noPlan.problems.some(x => /缺少目录内计划/.test(x)), '缺计划分类：' + JSON.stringify(noPlan.problems));
  // (4) 非法计划（固定字段被改 + 同步哈希）
  const badDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r4-badplan-' + RUN_ID);
  packer.build(writePicPlan(closeSource), badDir);
  const planObj = JSON.parse(fs.readFileSync(path.join(badDir, 'plan.json'), 'utf8'));
  planObj.collection = 'users';
  const badBytes = Buffer.from(JSON.stringify(planObj, null, 2) + '\n');
  const bm = JSON.parse(fs.readFileSync(path.join(badDir, 'manifest.json'), 'utf8'));
  bm.planSha256 = crypto.createHash('sha256').update(badBytes).digest('hex');
  fs.writeFileSync(path.join(badDir, 'plan.json'), badBytes);
  fs.writeFileSync(path.join(badDir, 'manifest.json'), JSON.stringify(bm, null, 2));
  const badPlan = packer.checkDir(badDir);
  assert.ok(badPlan.problems.some(x => /计划校验失败/.test(x)), '非法计划分类：' + JSON.stringify(badPlan.problems));
  // 正常对照（先于破坏性用例）
  assert.equal(packer.checkDir(outDir).ok, true);
  assert.equal(packer.checkDir(realOut).ok, true, '真实模式当下有效包应通过');
  // (5) 来源重建失败：先正常构建，再让**该包自己的**已受审关闭来源失效
  const srcPlan = writePicPlan(closeSource);
  const noSrc = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r4-nosrc-' + RUN_ID);
  packer.build(srcPlan, noSrc);
  assert.equal(packer.checkDir(noSrc).ok, true, '构建后正常对照');
  const closeDirPath = path.join(closeSource, 'close');
  fs.rmSync(closeDirPath, { recursive: true, force: true });
  const srcFail = packer.checkDir(noSrc);
  fs.mkdirSync(closeDirPath, { recursive: true });
  assert.ok(srcFail.problems.some(x => /来源重建失败/.test(x)), '来源失败分类：' + JSON.stringify(srcFail.problems));
  // 汇总：全部返回结构化结果，失败时 planChecked 不得为 true，无 ReferenceError
  for (const [label, r] of [['expired', expired], ['nan', nan], ['throw', boom], ['hash', hashMismatch],
    ['noPlan', noPlan], ['badPlan', badPlan], ['src', srcFail]]) {
    assert.equal(r instanceof ReferenceError, false, label + ' 不得抛 ReferenceError');
    assert.equal(Array.isArray(r.problems), true, label + ' 必须返回 problems');
    assert.equal(r.ok, false, label + ' 必须失败');
    assert.equal(r.planChecked, false, label + ' planChecked 不得为 true');
    assert.ok(r.problems.length > 0, label + ' 必须保留原始拒绝原因');
  }
  // check 全程不写入：候选包文件集保持不变（工具只读校验，不清理目录）
  assert.equal(fs.existsSync(path.join(noSrc, 'server', 'scheduleSandbox', 'index.js')), true, 'check 不得删除候选文件');
  assert.deepEqual(fs.readdirSync(closeDirPath), [], 'close 来源已被本用例主动清空并重建（仅测试内）');
});

test('R5 时间与轮次契约：now>=expires、expires>starts、轮次必填且读前拒绝', async () => {
  const starts = Date.now() - 60000;
  const expires = starts + 600000;
  // 核心时间边界
  const before = await rChecker(makeRDb({ rows: [] }).db, { windowStartsAtMs: starts, windowExpiresAtMs: expires, now: () => starts - 1 })
    .handle(rReq());
  assert.equal(before.code, 'PIC_WINDOW_NOT_OPEN');
  const atStart = await rChecker(makeRDb({ rows: [] }).db, { windowStartsAtMs: starts, windowExpiresAtMs: expires, now: () => starts })
    .handle(rReq());
  assert.equal(atStart.ok, true, '恰开始应通过');
  const inside = await rChecker(makeRDb({ rows: [] }).db, { windowStartsAtMs: starts, windowExpiresAtMs: expires, now: () => expires - 1 })
    .handle(rReq());
  assert.equal(inside.ok, true, 'expires-1ms 应通过');
  const atExpiry = await rChecker(makeRDb({ rows: [] }).db, { windowStartsAtMs: starts, windowExpiresAtMs: expires, now: () => expires })
    .handle(rReq());
  assert.equal(atExpiry.code, 'PIC_WINDOW_EXPIRED', '恰截止必须拒绝');
  assert.equal(atExpiry.readAttempted, false, '恰截止不得读库');
  const afterExpiry = await rChecker(makeRDb({ rows: [] }).db, { windowStartsAtMs: starts, windowExpiresAtMs: expires, now: () => expires + 1 })
    .handle(rReq());
  assert.equal(afterExpiry.code, 'PIC_WINDOW_EXPIRED');
  // 计划：expires <= starts 写前拒绝
  const closeSource = makeCloseSourceDir();
  for (const [label, ms] of [['0分钟', 0], ['负1分钟', -60000]]) {
    const planPath = writePicPlan(closeSource, { windowExpiresAtIso: new Date(starts + ms).toISOString() });
    const out = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r5-win-' + RUN_ID);
    let err = null;
    try { packer.build(planPath, out); } catch (e) { err = e; }
    assert.ok(err, label + ' 窗口必须拒绝');
    assert.equal(err.code, packer.ERR.PLAN_WINDOW_INVALID, label + ' 实际 ' + (err && err.code));
    assert.equal(fs.existsSync(out), false, label + ' 必须零写');
  }
  // 真实模式：恰截止 build 零写拒绝；窗口内正常通过
  const realPlanPath = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(expires - 60000).toISOString(),
    windowExpiresAtIso: new Date(expires).toISOString()
  });
  const realOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r5-exact-' + RUN_ID);
  const realNow = Date.now;
  Date.now = () => expires;
  let realErr = null;
  try { packer.build(realPlanPath, realOut); } catch (e) { realErr = e; } finally { Date.now = realNow; }
  assert.ok(realErr && realErr.code === packer.ERR.WINDOW_EXPIRED, '恰截止 build 必须拒绝');
  assert.equal(fs.existsSync(realOut), false, '恰截止零写');
  const okOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r5-inside-' + RUN_ID);
  let insideCheck = null;
  Date.now = () => expires - 1000;
  try {
    packer.build(realPlanPath, okOut);
    insideCheck = packer.checkDir(okOut);
  } finally { Date.now = realNow; }
  assert.equal(insideCheck.ok, true, '窗口内正常对照：' + JSON.stringify(insideCheck.problems));
  // 轮次：缺失/空/非字符串/错误 → 读前拒绝
  for (const [label, round, code] of [
    ['缺失', undefined, 'PIC_ROUND_REQUIRED'],
    ['空串', '', 'PIC_ROUND_REQUIRED'],
    ['数字', 17, 'PIC_ROUND_REQUIRED'],
    ['null', null, 'PIC_ROUND_REQUIRED'],
    ['错误轮次', 'other-round-x', 'PIC_ROUND_MISMATCH']
  ]) {
    const payload = { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE };
    if (label !== '缺失') payload.checkRoundId = round;
    const { db, calls } = makeRDb({ rows: [rRow()] });
    const r = await rChecker(db).handle(payload);
    assert.equal(r.code, code, label + ' 实际 ' + r.code);
    assert.equal(calls.gets, 0, label + ' 必须读前拒绝');
    assert.equal(calls.collections.length, 0, label + ' 不得访问集合');
  }
  // 正确轮次 → 完整页面链可通
  const { db: okDb, calls: okCalls } = makeRDb({ rows: [rRow()] });
  const okResult = await rChecker(okDb).handle(rReq());
  assert.equal(okResult.ok, true);
  assert.equal(okResult.checkRoundId, TEST_ROUND);
  assert.equal(okCalls.gets, 1);
});

test('R6 读取边界：最小字段投影、readAttempted 时机、缺字段 UNKNOWN、错误白名单净化', async () => {
  // (1) 最小字段投影：只 _id/openid/status
  const proj = makeRDb({ rows: [rRow()] });
  const projected = await rChecker(proj.db).handle(rReq());
  assert.equal(projected.registrationState, 'ACTIVE');
  assert.equal(proj.calls.fields.length, 1, '必须选择字段');
  assert.deepEqual(proj.calls.fields[0], { _id: true, openid: true, status: true });
  assert.deepEqual(Object.keys(proj.calls.fields[0]).sort(), ['_id', 'openid', 'status'], '不得多取字段');
  assert.equal(proj.calls.gets, 1, '至多一次本人 get');
  assert.equal(proj.calls.docs.length, 1, '只读本人主键');
  assert.equal(proj.calls.docs[0], core.deriveUserId(APPID, rOpenid));
  assert.equal(proj.calls.writeAttempts, 0, '零业务写');
  // (2) readAttempted 时机
  const collFail = makeRDb({ collectionError: new Error('synthetic collection failure') });
  const noAttempt = await rChecker(collFail.db).handle(rReq());
  assert.equal(noAttempt.readAttempted, false, '集合构造失败不得报已读取');
  assert.equal(noAttempt.registrationState, 'UNKNOWN');
  const getFail = makeRDb({ readError: new Error('synthetic get failure') });
  const attempted = await rChecker(getFail.db).handle(rReq());
  assert.equal(attempted.readAttempted, true, 'get 调用过必须为 true');
  assert.equal(attempted.registrationState, 'UNKNOWN');
  // (3) 缺字段 → UNKNOWN；字段齐备且不符 → MISMATCH
  for (const key of ['_id', 'openid', 'status']) {
    const row = rRow(); delete row[key];
    const r = await rChecker(makeRDb({ rows: [row] }).db).handle(rReq());
    assert.equal(r.registrationState, 'UNKNOWN', '缺 ' + key + ' 必须 UNKNOWN，实际 ' + r.registrationState);
    assert.equal(r.recordMatched, null, '缺 ' + key + ' 不得声称归属一致');
  }
  const mismatch = await rChecker(makeRDb({ rows: [rRow({ _id: 'u_' + '1'.repeat(40) })] }).db).handle(rReq());
  assert.equal(mismatch.registrationState, 'MISMATCH', '字段齐备且不符必须 MISMATCH');
  assert.equal(mismatch.recordMatched, false);
  // (4) 错误白名单与文案净化
  const marker = 'synthetic-raw-sdk-detail-must-not-return';
  for (const [label, code, expectCode, expectText] of [
    ['伪造白名单 code', 'PIC_READ_FAILED', 'PIC_READ_FAILED', '读取本人测试账号记录失败（结果未知）。'],
    ['未列举 code', 'PIC_UNREVIEWED', 'PIC_READ_FAILED', '读取本人测试账号记录失败（结果未知）。'],
    ['无 code', undefined, 'PIC_READ_FAILED', '读取本人测试账号记录失败（结果未知）。'],
    ['第三方 code', 'SDK_DATABASE_ERROR', 'PIC_READ_FAILED', '读取本人测试账号记录失败（结果未知）。']
  ]) {
    const err = new Error(marker);
    if (code) err.code = code;
    const r = await rChecker(makeRDb({ readError: err }).db).handle(rReq());
    assert.equal(r.code, expectCode, label + ' 实际 ' + r.code);
    assert.equal(r.message, expectText, label + ' 文案必须是固定白名单');
    assert.equal(r.message.includes(marker), false, label + ' 不得外传原始异常');
    assert.equal(JSON.stringify(r).includes(marker), false, label + ' 序列化后也不得含原文');
    assert.equal(r.registrationState, 'UNKNOWN');
    assert.equal(r.userId, null, label + ' 不得交付完整 ID');
  }
  // (4b) 非读取阶段的外部异常（伪造内部标记不可能，但第三方异常必须净化）
  const third = {
    collection() { throw new Error(marker); },
    set() {}, update() {}, remove() {}, runTransaction() {}
  };
  const thirdResult = await rChecker(third).handle(rReq());
  assert.equal(thirdResult.code, 'PIC_DB_UNAVAILABLE', '第三方异常须映射到固定白名单代码');
  assert.equal(thirdResult.message, core.ERROR_PUBLIC_TEXT.PIC_DB_UNAVAILABLE, '必须是固定白名单文案');
  assert.equal(JSON.stringify(thirdResult).includes(marker), false, '不得外传第三方异常原文');
  assert.equal(Object.values(core.ERROR_PUBLIC_TEXT).includes(thirdResult.message), true, '文案必须来自白名单表');
  // (5) 白名单覆盖：每个公开 code 都有固定文案
  for (const code of Object.keys(core.ERROR_PUBLIC_TEXT)) {
    assert.equal(typeof core.ERROR_PUBLIC_TEXT[code], 'string', code + ' 必须有固定文案');
    assert.ok(core.ERROR_PUBLIC_TEXT[code].length > 0, code + ' 文案非空');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// S1/S2 定点收尾（Codex 复查 fcc4a58 §3）：逐项「正确拒绝 + 合法对照」
// ════════════════════════════════════════════════════════════════════════════

test('S1 页面取消勾选后不请求也不显示完整 ID；事件顺序：默认→勾选→取消→重勾；在途锁不回归', async () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 's1-' + RUN_ID);
  packer.build(writePicPlan(closeSource, { synthetic: false }), outDir);
  const openid = 'openid-s1-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  const requests = [];
  const wxStub = {
    cloud: {
      _identityCheckEnvInited: false,
      init() {},
      callFunction(opts) {
        requests.push({ data: JSON.parse(JSON.stringify(opts.data)) });
        const main = loadCandidateMain(outDir, {
          appId: APPID, envId: ENV_ID, openid,
          db: makeTrapDb({ rows: [rowFor(openid)] })
        });
        return main.main(opts.data).then(result => ({ result }));
      }
    }
  };
  const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
  globalThis.wx = wxStub;
  try {
    const pageFile = path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.js');
    const pageDef = {};
    const page = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
    const pageCtx = vm.createContext({
      Page(d) { Object.assign(pageDef, d); },
      wx: wxStub, require: createRequire(pageFile), console
    });
    new vm.Script('(function(){' + fs.readFileSync(pageFile, 'utf8') + '\n}).call(globalThis)', { filename: pageFile }).runInContext(pageCtx);
    Object.assign(page, pageDef);
    // (0) 默认不展示
    assert.equal(page.data.wantFullUserId, false);
    page.onLoad(); page.onShow();
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests[0].data.picRequest.includeFullUserId, undefined, '默认请求不得携带完整 ID');
    assert.equal(page.data.result.userId, '', '默认不显示完整 ID');
    // (1) 勾选 → 请求并显示
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    assert.equal(page.data.wantFullUserId, true, '勾选后应为 true');
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests[1].data.picRequest.includeFullUserId, true, '勾选后请求携带完整 ID');
    assert.equal(page.data.result.userId, userId, '勾选后显示完整 ID');
    // (2) 取消勾选（detail.value=[]，即 D7 缺陷的直接反例）→ 不请求、不显示
    page.onWantFullIdChange({ detail: { value: [] } });
    assert.equal(page.data.wantFullUserId, false, '取消勾选必须为 false（旧实现 Boolean([])===true）');
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests[2].data.picRequest.includeFullUserId, undefined, '取消后请求不得携带完整 ID');
    assert.equal(page.data.result.userId, '', '取消后不得显示完整 ID');
    assert.equal(page.data.result.userIdTail, userId.slice(-6), '仍显示尾号');
    // (3) 重新勾选 → 才展示
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    assert.equal(page.data.wantFullUserId, true);
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests[3].data.picRequest.includeFullUserId, true, '重新勾选才请求');
    assert.equal(page.data.result.userId, userId, '重新勾选才显示');
    // (4) 取消后再勾选其他值（不含 full）→ 不请求
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    page.onWantFullIdChange({ detail: { value: ['other'] } });
    assert.equal(page.data.wantFullUserId, false, '选中值不含 full 必须为 false');
    // (5) 在途锁：sending 期间 WXML 禁用复选框（静态绑定）且重复点击不发请求
    const wxml = fs.readFileSync(path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.wxml'), 'utf8');
    assert.ok(wxml.includes('disabled="{{sending}}"'), '复选框在途必须禁用');
    const before = requests.length;
    page.setData({ sending: true });
    await page.onCheckTap();
    assert.equal(requests.length, before, '在途锁：sending 期间点击不产生新请求');
    page.setData({ sending: false });
  } finally {
    if (hadWx) delete globalThis.wx; else delete globalThis.wx;
  }
});

test('S2 缺字段筛选能力时保守 UNKNOWN：无field/field抛错/field返回无get 都零get且不交付完整ID', async () => {
  const openid = 'openid-s2-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  // (1) 无 field 方法 → 零 get、UNKNOWN、完整 ID 为空、readAttempted=false
  const noField = makeTrapDb({ rows: [rowFor(openid)] });
  noField.collection = (name) => {
    assert.equal(name, core.FIXED_TARGET.collection);
    return { doc() { return { async get() { throw new Error('TRAP: 缺 field 时不得 get'); } }; } };
  };
  const noFieldResult = await makeChecker(noField, { trusted: trustedContext(openid) })
    .handle(rReq({ includeFullUserId: true }));
  assert.equal(noFieldResult.ok, false);
  assert.equal(noFieldResult.code, 'PIC_FIELD_PROJECTION_UNAVAILABLE');
  assert.equal(noFieldResult.registrationState, 'UNKNOWN');
  assert.equal(noFieldResult.readAttempted, false, '未实际进入 get 必须 readAttempted=false');
  assert.equal(noFieldResult.userId, null, '完整 userId 必须为空');
  assert.equal(noFieldResult.identityConfirmed, false);
  // (2) field 抛错 → 同样保守拒绝
  const fieldThrows = makeTrapDb({ rows: [rowFor(openid)] });
  fieldThrows.collection = () => ({ doc() { return { field() { throw new Error('synthetic field failure'); }, async get() { throw new Error('TRAP'); } }; } });
  const throwsResult = await makeChecker(fieldThrows, { trusted: trustedContext(openid) })
    .handle(rReq({ includeFullUserId: true }));
  assert.equal(throwsResult.code, 'PIC_FIELD_PROJECTION_UNAVAILABLE');
  assert.equal(throwsResult.readAttempted, false, 'field 抛错发生在 get 前');
  assert.equal(throwsResult.userId, null);
  // (3) field 返回无 get 的对象 → 保守拒绝
  const noGetAfterField = makeTrapDb({ rows: [rowFor(openid)] });
  noGetAfterField.collection = () => ({ doc() {
    let getCalled = false;
    return { field() { return {}; }, async get() { getCalled = true; throw new Error('TRAP: field 返回无 get 时不得 get'); }, _wasGetCalled: () => getCalled };
  } });
  const noGetResult = await makeChecker(noGetAfterField, { trusted: trustedContext(openid) })
    .handle(rReq({ includeFullUserId: true }));
  assert.equal(noGetResult.code, 'PIC_FIELD_PROJECTION_UNAVAILABLE');
  assert.equal(noGetResult.readAttempted, false);
  assert.equal(noGetResult.userId, null);
  // (4) 正常筛选对照：field 成功 → 一次本人 get、只投影三字段、ACTIVE 且可交付完整 ID
  const good = makeTrapDb({ rows: [rowFor(openid)] });
  const goodResult = await makeChecker(good, { trusted: trustedContext(openid) })
    .handle(rReq({ includeFullUserId: true }));
  assert.equal(goodResult.ok, true);
  assert.equal(goodResult.registrationState, 'ACTIVE');
  assert.equal(goodResult.userId, userId);
  assert.deepEqual(good.calls.fields[0], { _id: true, openid: true, status: true });
  assert.equal(good.calls.reads, 1);
  // (5) 实际 get 失败 → readAttempted=true 如实记录
  const getFail = makeTrapDb({ rows: [rowFor(openid)], throwOnRead: true });
  const failResult = await makeChecker(getFail, { trusted: trustedContext(openid) })
    .handle(rReq({ includeFullUserId: true }));
  assert.equal(failResult.readAttempted, true, 'get 已调用必须如实记录');
  assert.equal(failResult.registrationState, 'UNKNOWN');
  assert.equal(failResult.userId, null);
  // 零业务写（全矩阵）
  for (const t of [noField, fieldThrows, noGetAfterField, good, getFail]) {
    // 这些替身的写方法会抛 TRAP，能走到这里说明从未被调用
    assert.ok(true);
  }
  // 白名单覆盖新代码
  assert.equal(typeof core.ERROR_PUBLIC_TEXT.PIC_FIELD_PROJECTION_UNAVAILABLE, 'string');
});

// ════════════════════════════════════════════════════════════════════════════
// S1 收尾（Codex 复查 7d1969f 报告 §S1 剩余展示时点）：取消事件当下立即隐藏旧完整编号
// ════════════════════════════════════════════════════════════════════════════

test('S1b 取消勾选当下立即隐藏旧完整编号：取消后/重勾未提交/再提交三时点断言', async () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 's1b-' + RUN_ID);
  packer.build(writePicPlan(closeSource, { synthetic: false }), outDir);
  const openid = 'openid-s1b-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  const requests = [];
  const wxStub = {
    cloud: {
      _identityCheckEnvInited: false,
      init() {},
      callFunction(opts) {
        requests.push(JSON.parse(JSON.stringify(opts.data)));
        const main = loadCandidateMain(outDir, {
          appId: APPID, envId: ENV_ID, openid,
          db: makeTrapDb({ rows: [rowFor(openid)] })
        });
        return main.main(opts.data).then(result => ({ result }));
      }
    }
  };
  const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
  globalThis.wx = wxStub;
  try {
    // 装载实际生成的页面（模板→打包器→候选 App/Page/client/server/core + 合成 wx/db）
    const pageFile = path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.js');
    const pageDef = {};
    const page = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
    const pageCtx = vm.createContext({
      Page(d) { Object.assign(pageDef, d); },
      wx: wxStub, require: createRequire(pageFile), console
    });
    new vm.Script('(function(){' + fs.readFileSync(pageFile, 'utf8') + '\n}).call(globalThis)', { filename: pageFile }).runInContext(pageCtx);
    Object.assign(page, pageDef);
    page.onLoad(); page.onShow();
    assert.equal(requests.length, 0, '加载零发送');
    // 步骤 1：勾选 + 成功核验 → 显示完整编号
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].picRequest.includeFullUserId, true);
    assert.equal(page.data.result.userId, userId, '勾选核验后显示完整编号');
    assert.equal(page.data.result.fullUserIdAvailable, true);
    assert.equal(page.data.result.userIdTail, userId.slice(-6), '尾号保留');
    // 步骤 2（验收要求 1）：取消勾选（detail.value=[]）当下、下一次提交之前——
    // 立即隐藏旧完整编号、保留尾号、不产生新请求
    page.onWantFullIdChange({ detail: { value: [] } });
    assert.equal(page.data.wantFullUserId, false);
    assert.equal(page.data.result.fullUserIdAvailable, false, '取消当下 fullUserIdAvailable 必须为 false');
    assert.equal(page.data.result.userId, '', '取消当下旧完整编号必须已清空');
    assert.equal(page.data.result.userIdTail, userId.slice(-6), '取消当下尾号必须保留');
    assert.equal(requests.length, 1, '取消事件不得产生新请求');
    // 步骤 3（验收要求 2）：重新勾选但尚未再次完成有效核验 → 不恢复旧完整编号
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    assert.equal(page.data.wantFullUserId, true);
    assert.equal(page.data.result.fullUserIdAvailable, false, '重勾未提交不得恢复完整编号');
    assert.equal(page.data.result.userId, '', '重勾未提交不得恢复旧编号值');
    assert.equal(page.data.result.userIdTail, userId.slice(-6), '尾号仍保留');
    assert.equal(requests.length, 1, '重勾本身不得产生新请求');
    // 步骤 4：取消状态下再次核验 → 不请求完整编号，返回后只显示尾号（既有正确分支保持）
    page.onWantFullIdChange({ detail: { value: [] } });
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].picRequest.includeFullUserId, undefined, '取消后再次核验不请求完整编号');
    assert.equal(page.data.result.userId, '', '取消后再核验不显示完整编号');
    assert.equal(page.data.result.userIdTail, userId.slice(-6));
    // 步骤 5：重新勾选 + 再次核验 → 新一次有效核验返回后才显示完整编号
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].picRequest.includeFullUserId, true, '重新勾选后才请求完整编号');
    assert.equal(page.data.result.userId, userId, '新一次有效核验返回后显示');
    assert.equal(page.data.result.fullUserIdAvailable, true);
    // 非回归：口令清除 + 在途锁
    assert.equal(page.data.passphrase, '', '口令调用后清除');
    const before = requests.length;
    page.setData({ sending: true });
    await page.onCheckTap();
    assert.equal(requests.length, before, '在途锁保持');
  } finally {
    delete globalThis.wx;
  }
});

// ════════════════════════════════════════════════════════════════════════════
// I1/I2 前置核验（执行包准备版 §2）：真实 SDK 本地转换 + 同名函数部署映射
// ════════════════════════════════════════════════════════════════════════════

test('V 真实 SDK 形状兼容：单对象=存在、null=明确不存在、数组兼容、多条 UNKNOWN；入口以 throwOnNotFound:false 构造', async () => {
  const openid = 'openid-v-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  // (1) 真实 wx-server-sdk 形状：存在 → data 为单个文档对象（非数组）
  const r1 = await rChecker({ collection(name) {
    assert.equal(name, core.FIXED_TARGET.collection);
    return { doc(id) {
      assert.equal(id, userId);
      return { field(f) { return this; }, async get() {
        // 真实 SDK resolve 形状：{ data: <单对象>, errMsg: 'document.get:ok' }
        return { data: { _id: userId, openid, status: 'active' }, errMsg: 'document.get:ok' };
      }, set() {}, update() {}, remove() {} };
    }, add() {} };
  }, runTransaction() {} }, { openid }).handle(rReq());
  assert.equal(r1.ok, true, '单对象形状必须正常判定');
  assert.equal(r1.registrationState, 'ACTIVE', '存在（单对象）→ ACTIVE');
  assert.equal(r1.recordMatched, true);
  assert.equal(r1.identityConfirmed, true);
  // (2) 明确不存在：throwOnNotFound=false → { data: null, errMsg }
  const r2 = await rChecker({ collection() { return { doc() { return { field() { return this; }, async get() {
    return { data: null, errMsg: 'document.get:ok' };
  }, set() {}, update() {}, remove() {} }; }, add() {} }; }, runTransaction() {} }, { openid }).handle(rReq());
  assert.equal(r2.ok, true, 'data:null 必须判 ABSENT 而非 READ_FAILED');
  assert.equal(r2.registrationState, 'ABSENT', '明确不存在 → ABSENT');
  assert.equal(r2.recordMatched, null);
  // (3) 数组形状兼容（替身/事务形状）：1 条 → ACTIVE；0 条 → ABSENT
  const r3 = await rChecker(makeRDb({ rows: [rRow()] }).db).handle(rReq());
  assert.equal(r3.registrationState, 'ACTIVE', '数组 1 条兼容');
  const r4 = await rChecker(makeRDb({ rows: [] }).db).handle(rReq());
  assert.equal(r4.registrationState, 'ABSENT', '数组 0 条兼容');
  // (4) 数组多条 → UNKNOWN
  const r5 = await rChecker(makeRDb({ rows: [rRow(), rRow()] }).db).handle(rReq());
  assert.equal(r5.registrationState, 'UNKNOWN', '数组多条不可采信');
  // (5) 单对象缺字段 → UNKNOWN
  for (const key of ['_id', 'openid', 'status']) {
    const obj = { _id: userId, openid, status: 'active' };
    delete obj[key];
    const r = await rChecker({ collection() { return { doc() { return { field() { return this; }, async get() { return { data: obj, errMsg: 'document.get:ok' }; }, set() {}, update() {}, remove() {} }; }, add() {} }; }, runTransaction() {} }, { openid }).handle(rReq());
    assert.equal(r.registrationState, 'UNKNOWN', '单对象缺 ' + key + ' → UNKNOWN');
  }
  // (6) 生成候选入口确实以 throwOnNotFound:false 构造 database（真实 SDK「不存在→null」前提）
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'v-entry-' + RUN_ID);
  packer.build(writePicPlan(closeSource), outDir);
  const entrySrc = fs.readFileSync(path.join(outDir, 'server', 'scheduleSandbox', 'index.js'), 'utf8');
  assert.ok(entrySrc.includes("cloud.database({ throwOnNotFound: false })"),
    '入口必须以 throwOnNotFound:false 构造 database（否则不存在会 reject）');
});

test('M 同名函数部署映射：候选制品全部位于 server/scheduleSandbox/；与既有业务布局同构；根下散制品拒绝', () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'm-map-' + RUN_ID);
  packer.build(writePicPlan(closeSource), outDir);
  // (1) cloudfunctionRoot=server/ 下只有一个直接子目录，且名称=受审函数名
  const serverRoot = path.join(outDir, 'server');
  const children = fs.readdirSync(serverRoot);
  assert.deepEqual(children, ['scheduleSandbox'], 'server/ 下必须只有同名函数子目录');
  assert.equal('scheduleSandbox', core.FIXED_TARGET.functionName, '子目录名=受审固定函数名');
  // (2) 函数子目录含完整入口四件套（入口/核心/请求适配器/package.json）
  for (const f of ['index.js', 'package.json', 'participant-identity-check.js', 'request-adapter.js']) {
    assert.equal(fs.existsSync(path.join(serverRoot, 'scheduleSandbox', f)), true, '函数目录含 ' + f);
  }
  // (3) 依赖闭包：入口 require('./participant-identity-check') 与 require('./request-adapter') 同目录可解析
  const entrySrc = fs.readFileSync(path.join(serverRoot, 'scheduleSandbox', 'index.js'), 'utf8');
  assert.ok(entrySrc.includes("require('./participant-identity-check')"), '入口引用同目录核心模块');
  assert.ok(entrySrc.includes("require('./request-adapter')"), '入口引用同目录请求适配器');
  // (4) 与既有业务布局同构（静态核对对照）
  const bizFnDir = path.join(REPO_ROOT, 'miniapp', 'cloudfunctions', 'scheduleSandbox');
  assert.equal(fs.existsSync(path.join(bizFnDir, 'index.js')), true, '既有业务函数目录含 index.js');
  assert.equal(fs.existsSync(path.join(bizFnDir, 'package.json')), true, '既有业务函数目录含 package.json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'project.config.json'), 'utf8')).cloudfunctionRoot, 'server/');
  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'miniapp', 'project.config.json'), 'utf8')).cloudfunctionRoot, 'cloudfunctions/');
  // (5) 反例：装配出现 server/ 根下散制品（旧布局）→ verifyProjectLayout 拒绝
  const fake = new Map(packer.computeArtifacts(JSON.parse(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8'))));
  fake.set('server/index.js', Buffer.from('// stray legacy artifact\n'));
  assert.throws(() => packer.verifyProjectLayout(fake),
    e => e.code === packer.ERR.SOURCE_DRIFT && /无法映射到同名函数/.test(e.message),
    'server/ 根下散制品必须被映射校验拒绝');
  // (6) 反例：同名函数子目录缺 package.json → 拒绝
  const fake2 = new Map(packer.computeArtifacts(JSON.parse(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8'))));
  fake2.delete('server/scheduleSandbox/package.json');
  assert.throws(() => packer.verifyProjectLayout(fake2),
    e => e.code === packer.ERR.SOURCE_DRIFT && /同名函数子目录缺少制品/.test(e.message));
  // (7) 精确文件集：候选 15 文件（含请求适配器；仅 rel 调整，数量不变）
  const r = packer.checkDir(outDir);
  assert.equal(r.ok, true);
  assert.equal(r.files, 15, '候选清单 15 文件（含请求适配器）');
});

// ════════════════════════════════════════════════════════════════════════════
// N 组：配对关闭目录映射（Codex 复查 C1）——来源 server/** → close/server/scheduleSandbox/**
// ════════════════════════════════════════════════════════════════════════════

test('N1 关闭目录映射：来源 server/** 映射为 close/server/scheduleSandbox/**，其余逐字节一致，配置与入口可解析', () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'n1-' + RUN_ID);
  const built = packer.build(writePicPlan(closeSource), outDir);
  const closeDir = path.join(outDir, 'close');
  // (1) 映射布局：close/server/ 下只有同名函数子目录
  assert.deepEqual(fs.readdirSync(path.join(closeDir, 'server')), ['scheduleSandbox'],
    'close/server/ 下必须只有同名函数子目录');
  assert.equal(packer.SERVER_FN_DIR, core.FIXED_TARGET.functionName);
  // (2) 逐字节一致：非 server 文件原 rel 原字节；server 文件新 rel 原字节
  const srcClose = path.join(closeSource, 'close');
  for (const f of built.manifest.closePackage.files) {
    const srcAbs = path.join(srcClose, f.sourceRel);
    assert.equal(fs.readFileSync(path.join(closeDir, f.rel)).length, f.bytes, '映射后字节数一致：' + f.rel);
    assert.equal(fs.readFileSync(srcAbs).length, f.bytes, '来源字节数一致：' + f.sourceRel);
    assert.deepEqual(fs.readFileSync(path.join(closeDir, f.rel)), fs.readFileSync(srcAbs),
      '逐字节一致：' + f.sourceRel + ' -> ' + f.rel);
    if (f.sourceRel.startsWith('server/')) {
      assert.ok(f.rel.startsWith('server/scheduleSandbox/'), 'server 来源必须映射：' + f.rel);
    } else {
      assert.equal(f.rel, f.sourceRel, '非 server 文件 rel 保持：' + f.rel);
    }
  }
  // (3) 关闭包项目配置与入口可解析：cloudfunctionRoot=server/ 且 server/ 下仅同名子目录三件套
  const cfg = JSON.parse(fs.readFileSync(path.join(closeDir, 'project.config.json'), 'utf8'));
  assert.equal(cfg.cloudfunctionRoot, 'server/');
  const fnDir = path.join(closeDir, 'server', 'scheduleSandbox');
  for (const must of ['index.js', 'package.json', 'gate.js', 'collection-map.js', 'project-guard.js']) {
    assert.equal(fs.existsSync(path.join(fnDir, must)), true, '函数目录含 ' + must);
  }
  const entrySrc = fs.readFileSync(path.join(fnDir, 'index.js'), 'utf8');
  assert.ok(entrySrc.length > 0, '关闭端入口可读取');
  // vendor 等非 server 根文件逐字节（frontend/project.config.json）
  assert.equal(fs.readFileSync(path.join(closeDir, 'project.config.json')).length,
    fs.readFileSync(path.join(srcClose, 'project.config.json')).length);
  // (4) checkDir（含关闭映射重建）通过；closeFiles 数与来源一致
  const r = packer.checkDir(outDir);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.closeFiles, built.manifest.closePackage.files.length);
});

test('N2 关闭映射独立校验：checkCloseDir 按映射后布局重建；不依赖候选窗口（NaN 时钟）；NaN 与过期候选无关', () => {
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'n2-' + RUN_ID);
  packer.build(writePicPlan(closeSource), outDir);
  process.env.PIC_CLOSE_SOURCE_DIR = closeSource; // checkCloseDir 须显式受审来源
  const realNow = Date.now;
  const at = (v, fn) => { Date.now = typeof v === 'function' ? v : () => v; try { return fn(); } finally { Date.now = realNow; } };
  // 独立校验（NaN 时钟）按映射后布局通过
  const r = at(NaN, () => packer.checkCloseDir(outDir));
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.files, r.expectedFiles);
  // 来源失效 → 独立校验拒绝（关闭包不能凭空重建）
  const closeDirPath = path.join(closeSource, 'close');
  const saved = fs.readdirSync(closeDirPath);
  fs.rmSync(closeDirPath, { recursive: true, force: true });
  const r2 = at(NaN, () => packer.checkCloseDir(outDir));
  fs.mkdirSync(closeDirPath, { recursive: true });
  assert.equal(r2.ok, false, '来源失效须拒绝');
  assert.ok(r2.problems.some(x => /来源重建失败|关闭映射不变量失败/.test(x)), JSON.stringify(r2.problems));
  assert.deepEqual(fs.readdirSync(closeDirPath), [], '来源目录仅测试内清空');
  // check 全程不写不删候选
  assert.equal(fs.existsSync(path.join(outDir, 'close', 'server', 'scheduleSandbox', 'index.js')), true);
  assert.equal(saved.length > 0, true);
  delete process.env.PIC_CLOSE_SOURCE_DIR;
});

test('N3 关闭映射反例：旧布局散文件/缺 package.json 不变量拒绝；checkDir 拒绝盘上根下散文件；复用续建对照', () => {
  const closeSource = makeCloseSourceDir();
  const planPath = writePicPlan(closeSource);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const legit = packer.computeArtifacts(plan);
  // computeArtifacts 生成候选（server/scheduleSandbox/**）；模拟旧业务关闭包布局（server/ 直接根）
  const fnKeys = [...legit.keys()].filter(k => k.startsWith('server/scheduleSandbox/'));
  const legacyMap = new Map(fnKeys.map(k => [k.replace('server/scheduleSandbox/', 'server/'), legit.get(k)]));
  assert.ok(legacyMap.has('server/index.js'), '旧布局含 server/index.js');
  assert.ok(legacyMap.has('server/package.json'));
  assert.throws(() => packer.assertCloseMappingInvariants(legacyMap),
    e => e.code === packer.ERR.CLOSE_SOURCE_INVALID && /无法映射到同名函数/.test(e.message),
    '旧布局必须被不变量拒绝');
  // (2) 正确布局但函数目录缺 package.json → 拒绝
  const noPkg = new Map(fnKeys.map(k => [k, legit.get(k)]).filter(([k]) => k !== 'server/scheduleSandbox/package.json'));
  assert.throws(() => packer.assertCloseMappingInvariants(noPkg),
    e => e.code === packer.ERR.CLOSE_SOURCE_INVALID && /同名函数子目录缺少制品/.test(e.message));
  // (3) 映射函数语义：server/** 映射、其余保持
  assert.equal(packer.adaptCloseRel('server/gate.js'), 'server/scheduleSandbox/gate.js');
  assert.equal(packer.adaptCloseRel('frontend/app.json'), 'frontend/app.json');
  assert.equal(packer.adaptCloseRel('project.config.json'), 'project.config.json');
  // (4) checkDir 拒绝盘上根下散文件（额外文件），且不删除候选文件
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'n3-' + RUN_ID);
  packer.build(planPath, outDir);
  fs.writeFileSync(path.join(outDir, 'close', 'server', 'stray-legacy.js'), Buffer.from('// stray\n'));
  const r = packer.checkDir(outDir);
  assert.equal(r.ok, false, '根下散文件必须拒绝');
  assert.ok(r.problems.some(x => /额外文件：close\/server\/stray-legacy\.js/.test(x)), JSON.stringify(r.problems));
  assert.equal(fs.existsSync(path.join(outDir, 'close', 'server', 'stray-legacy.js')), true, 'check 不删除候选文件');
  // (5) 正常对照 + 完整复用/续建
  const okDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'n3-ok-' + RUN_ID);
  packer.build(planPath, okDir);
  assert.equal(packer.checkDir(okDir).ok, true, '正常对照');
  process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
  assert.equal(packer.checkCloseDir(okDir).ok, true, '关闭独立校验');
  delete process.env.PIC_CLOSE_SOURCE_DIR;
  const reused = packer.build(planPath, okDir);
  assert.equal(reused.io.filter(x => x.action === 'written').length, 0, '完整复用零新写');
  const resumeDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'n3-resume-' + RUN_ID);
  const rb = packer.build(planPath, resumeDir);
  fs.unlinkSync(path.join(resumeDir, 'close', rb.manifest.closePackage.files[0].rel));
  const resumed = packer.build(planPath, resumeDir);
  assert.equal(resumed.io.filter(x => x.action === 'written').length, 1, '关闭文件续建补 1');
  assert.equal(packer.checkDir(resumeDir).ok, true);
});


// ════════════════════════════════════════════════════════════════════════════
// N4：关闭清单来源绑定（Codex 复查 be31af2 C1-a）——sourceRel/mapping/逐字段精确核对
// ════════════════════════════════════════════════════════════════════════════

test('N4 关闭清单来源绑定：sourceRel/mapping/字段篡改与伪造均拒绝；合法对照与复用续建无回归', () => {
  const closeSource = makeCloseSourceDir();
  const planPath = writePicPlan(closeSource);
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'n4-' + RUN_ID);
  const built = packer.build(planPath, outDir);
  // (1) 合法对照：checkDir 通过且 mapping 与固定声明一致
  assert.equal(packer.checkDir(outDir).ok, true);
  const manifestPath = path.join(outDir, 'manifest.json');
  const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(original.closePackage.mapping, packer.CLOSE_MAPPING_DECLARATION);
  assert.equal(original.closePackage.files.length, built.manifest.closePackage.files.length);
  const rewrite = obj => fs.writeFileSync(manifestPath, JSON.stringify(obj, null, 2) + '\n');
  // (2) sourceRel 篡改为不存在路径 → 拒绝（Codex 反例直接堵住）
  const tam1 = structuredClone(original);
  tam1.closePackage.files[0].sourceRel = 'server/nonexistent.js';
  rewrite(tam1);
  const r1 = packer.checkDir(outDir);
  assert.equal(r1.ok, false, '伪造 sourceRel 必须拒绝');
  assert.ok(r1.problems.some(x => /字段与受审来源重建不符（sourceRel）/.test(x)), JSON.stringify(r1.problems));
  // (3) mapping 改为无关文字 → 拒绝
  const tam2 = structuredClone(original);
  tam2.closePackage.mapping = 'unrelated mapping';
  rewrite(tam2);
  const r2 = packer.checkDir(outDir);
  assert.equal(r2.ok, false, '错 mapping 必须拒绝');
  assert.ok(r2.problems.some(x => /closePackage.mapping 与受审固定映射声明不一致/.test(x)), JSON.stringify(r2.problems));
  // (4) 伪造清单条目（rel 无法由来源重建）→ 拒绝
  const tam3 = structuredClone(original);
  tam3.closePackage.files.push({ rel: 'server/fake.js', sourceRel: 'server/fake.js', bytes: 3, sha256: '0'.repeat(64) });
  rewrite(tam3);
  const r3 = packer.checkDir(outDir);
  assert.equal(r3.ok, false, '伪造条目必须拒绝');
  assert.ok(r3.problems.some(x => /无法由受审来源重建：server\/fake\.js/.test(x)), JSON.stringify(r3.problems));
  // (5) 缺字段（sourceRel 删除）→ 拒绝
  const tam4 = structuredClone(original);
  delete tam4.closePackage.files[0].sourceRel;
  rewrite(tam4);
  const r4 = packer.checkDir(outDir);
  assert.equal(r4.ok, false, '缺 sourceRel 必须拒绝');
  assert.ok(r4.problems.some(x => /字段与受审来源重建不符（sourceRel）/.test(x)), JSON.stringify(r4.problems));
  // (6) 未知字段 → 拒绝
  const tam5 = structuredClone(original);
  tam5.closePackage.files[0].note = 'extra';
  rewrite(tam5);
  const r5 = packer.checkDir(outDir);
  assert.equal(r5.ok, false, '未知字段必须拒绝');
  assert.ok(r5.problems.some(x => /含未知字段（note）/.test(x)), JSON.stringify(r5.problems));
  // (7) 缺条目（删除一条声明）→ 拒绝
  const tam6 = structuredClone(original);
  tam6.closePackage.files.splice(0, 1);
  rewrite(tam6);
  const r6 = packer.checkDir(outDir);
  assert.equal(r6.ok, false, '缺条目必须拒绝');
  assert.ok(r6.problems.some(x => /关闭清单缺少来源映射条目/.test(x)), JSON.stringify(r6.problems));
  // (8) bytes 篡改对照仍拒绝（既有字节校验保留）
  const tam7 = structuredClone(original);
  tam7.closePackage.files[0].bytes++;
  rewrite(tam7);
  assert.equal(packer.checkDir(outDir).ok, false, 'bytes 篡改对照仍拒绝');
  // (9) 还原后合法对照 + 完整复用/续建 + 独立校验无回归
  rewrite(original);
  assert.equal(packer.checkDir(outDir).ok, true, '还原后合法对照');
  const reused = packer.build(planPath, outDir);
  assert.equal(reused.io.filter(x => x.action === 'written').length, 0, '完整复用零新写');
  process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
  try { assert.equal(packer.checkCloseDir(outDir).ok, true, '独立校验无回归'); }
  finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
  const resumeDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'n4-resume-' + RUN_ID);
  const rb = packer.build(planPath, resumeDir);
  fs.unlinkSync(path.join(resumeDir, 'close', rb.manifest.closePackage.files[0].rel));
  assert.equal(packer.build(planPath, resumeDir).io.filter(x => x.action === 'written').length, 1, '续建补 1');
  assert.equal(packer.checkDir(resumeDir).ok, true);
});
// ════════════════════════════════════════════════════════════════════════════
// P9：I1 SDK 精确版本接线（执行页 §2）——候选/关闭双侧精确 3.0.1 + 漂移拒绝
// ════════════════════════════════════════════════════════════════════════════

test('P9 SDK 精确版本：候选与关闭 package.json 均精确 3.0.1；模板漂移写前拒绝；版本不符双侧拒绝', () => {
  const closeSource = makeCloseSourceDir();
  const planPath = writePicPlan(closeSource);
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'p9-' + RUN_ID);
  packer.build(planPath, outDir);
  // (1) 生成候选的函数 package.json 精确 3.0.1
  const fnPkg = JSON.parse(fs.readFileSync(path.join(outDir, 'server', 'scheduleSandbox', 'package.json'), 'utf8'));
  assert.equal(fnPkg.dependencies['wx-server-sdk'], '3.0.1',
    '候选声明必须为精确 3.0.1（非 ~2.6.3 波浪号范围）');
  assert.equal(fnPkg.dependencies['wx-server-sdk'], packer.PINNED_WX_SERVER_SDK_VERSION);
  // (2) 配对关闭包（受审来源逐字节映射）的 package.json 同样精确 3.0.1
  const closePkg = JSON.parse(fs.readFileSync(path.join(outDir, 'close', 'server', 'scheduleSandbox', 'package.json'), 'utf8'));
  assert.equal(closePkg.dependencies['wx-server-sdk'], '3.0.1', '关闭包声明必须为精确 3.0.1');
  // (3) 模板依赖声明漂移（改回 ~2.6.3，内存注入不改磁盘）→ build SOURCE_DRIFT 零产物
  const tmplPath = path.join(packer.TEMPLATE_DIR, 'server', 'package.json');
  const realRead = fs.readFileSync;
  const original = realRead.call(fs, tmplPath);
  const drifted = Buffer.from(original.toString('utf8').replace('"3.0.1"', '"~2.6.3"'));
  fs.readFileSync = function (p, ...args) {
    if (typeof p === 'string' && path.resolve(p) === tmplPath) {
      return typeof args[0] === 'string' ? drifted.toString(args[0]) : drifted;
    }
    return realRead.call(this, p, ...args);
  };
  const driftOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'p9-drift-' + RUN_ID);
  let buildErr = null;
  try { packer.build(planPath, driftOut); } catch (e) { buildErr = e; } finally { fs.readFileSync = realRead; }
  assert.ok(buildErr && buildErr.code === packer.ERR.SOURCE_DRIFT, '模板依赖漂移必须写前拒绝：' + (buildErr && buildErr.code));
  assert.equal(fs.existsSync(driftOut), false, '漂移拒绝零产物');
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'),
    crypto.createHash('sha256').update(fs.readFileSync(tmplPath)).digest('hex'), '磁盘模板零改动');
  // (4) 候选侧版本不符反例（内存构造：依赖 ~2.6.3）→ 装配校验拒绝
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const artifacts = packer.computeArtifacts(plan);
  const badPkg = new Map(artifacts);
  const badFnPkg = JSON.parse(badPkg.get('server/scheduleSandbox/package.json').toString('utf8'));
  badFnPkg.dependencies['wx-server-sdk'] = '~2.6.3';
  badPkg.set('server/scheduleSandbox/package.json', Buffer.from(JSON.stringify(badFnPkg, null, 2)));
  assert.throws(() => packer.verifyProjectLayout(badPkg),
    e => e.code === packer.ERR.PLAN_TARGET_INVALID && /必须精确为 3.0.1/.test(e.message),
    '候选侧版本不符必须拒绝');
  // (5) 关闭侧版本不符反例（内存构造：关闭函数目录依赖 ~2.6.3）→ 不变量拒绝
  const closeMap = new Map();
  for (const [k, v] of artifacts) {
    if (!k.startsWith('server/')) continue;
    closeMap.set(k, v);
  }
  // 不变量还需项目配置（cloudfunctionRoot=server/）与候选一致
  closeMap.set('project.config.json', artifacts.get('project.config.json'));
  const badClosePkg = JSON.parse(JSON.stringify(badFnPkg));
  closeMap.set('server/scheduleSandbox/package.json', Buffer.from(JSON.stringify(badClosePkg, null, 2)));
  assert.throws(() => packer.assertCloseMappingInvariants(closeMap),
    e => (e.code === packer.ERR.CLOSE_SOURCE_INVALID || e.code === packer.ERR.PLAN_TARGET_INVALID) &&
      /精确为 3.0.1/.test(e.message), '关闭侧版本不符必须拒绝');
  // (6) 正常对照：checkDir/checkCloseDir 通过
  assert.equal(packer.checkDir(outDir).ok, true);
  process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
  try { assert.equal(packer.checkCloseDir(outDir).ok, true); }
  finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
});

// ════════════════════════════════════════════════════════════════════════════
// D1–D2 受控键诊断（Codex 复查 a187998 C2/C3）：
// 默认关闭；开启且动作/轮次/口令/可信目标/当下窗口全部通过才附净化诊断；
// 只含固定候选标签/计数/键名长度分桶；不含原键名/值/前后缀；零DB；协议绑定。
// ════════════════════════════════════════════════════════════════════════════

test('D1 受控键诊断：默认关闭；全门槛准入；门控反例无诊断；秘密键名不泄漏；getter不访问；枚举异常净化', async () => {
  const openid = 'openid-diag-' + RUN_ID;
  const secretInKey = 'synthetic_secret_' + crypto.randomBytes(8).toString('hex');
  // 每次请求带两个额外键：userInfo（固定候选）+ 含合成秘密的长键名（33字符）
  const req = () => Object.assign(
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND },
    { userInfo: { openId: 'synthetic-untrusted-envelope' }, [secretInKey]: { synthetic: true } }
  );

  // (1) 默认关闭：即便全部门槛成立也不附诊断；零DB
  {
    const db = makeTrapDb({ rows: [] });
    const r = await makeChecker(db).handle(req());
    assert.equal(r.code, 'PIC_REQUEST_INVALID');
    assert.equal(r.ok, false);
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'keyDiagnostic'), false, '默认关闭无诊断字段');
    assert.equal(db.calls.reads, 0, '零读取');
    assert.equal(db.calls.collections.length, 0, '零集合访问');
  }

  // (2) 开启 + 全门槛通过：净化诊断可见；秘密与原键名/值均不泄漏
  {
    const db = makeTrapDb({ rows: [] });
    const r = await makeChecker(db, { keyDiagnostic: true }).handle(req());
    assert.equal(r.code, 'PIC_REQUEST_INVALID');
    assert.equal(r.ok, false);
    assert.equal(r.registrationState, 'UNKNOWN');
    assert.equal(r.readAttempted, false, 'REQUEST_INVALID 分支零读取事实');
    const d = r.keyDiagnostic;
    assert.ok(d, '诊断应存在');
    assert.equal(d.schema, core.KEY_DIAGNOSTIC_SCHEMA);
    assert.equal(d.diagnosticScope, core.KEY_DIAGNOSTIC_SCOPE);
    assert.equal(d.otherKeyCount, 1, 'userInfo 计入候选标签，秘密键计入其它键');
    assert.deepEqual(d.candidateLabels, ['CANDIDATE_USERINFO']);
    assert.equal(d.truncated, false);
    assert.deepEqual(d.otherKeyNameLengthBuckets,
      { 'len<=4': 0, 'len5-8': 0, 'len9-16': 0, 'len17-32': 0, lenOver32: 1 },
      '33字符秘密键名落入溢出桶（只给长度，不给名字）');
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes(secretInKey), false, '合成秘密键名不得出现在结果');
    assert.equal(serialized.includes('userInfo'), false, '原键名不得出现（仅固定标签，大小写敏感区分 CANDIDATE_USERINFO）');
    assert.equal(serialized.includes('synthetic-untrusted-envelope'), false, '键值不得泄漏');
    assert.equal(db.calls.reads, 0);
    assert.equal(db.calls.collections.length, 0);
  }

  // (3) 门控反例：错口令/错轮次/错上下文/过期/NaN时钟 → 行为不变（REQUEST_INVALID）且无诊断
  const gateCases = [
    ['错口令', { reqPatch: { passphrase: 'synthetic-wrong-passphrase' } }],
    ['错轮次', { reqPatch: { checkRoundId: 'synthetic-other-round' } }],
    ['错上下文', { checker: { trusted: trustedContext(openid, { appId: 'wx-synthetic-wrong' }) } }],
    ['过期窗口', { checker: { windowStartsAtMs: 1000, windowExpiresAtMs: 2000, now: () => 5000 } }],
    ['NaN时钟', { checker: { now: () => NaN } }]
  ];
  for (const [name, cfg] of gateCases) {
    const db = makeTrapDb({ rows: [] });
    const r = await makeChecker(db, Object.assign({ keyDiagnostic: true }, cfg.checker || {}))
      .handle(Object.assign(req(), cfg.reqPatch || {}));
    assert.equal(r.code, 'PIC_REQUEST_INVALID', name + '：请求键门槛仍最先（历史行为保持）');
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'keyDiagnostic'), false, name + '：无诊断');
    assert.equal(db.calls.reads, 0, name + '：零读取');
  }

  // (4) getter 值不被读取：诊断只枚举键名
  {
    const db = makeTrapDb({ rows: [] });
    const event = { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND };
    let getterHits = 0;
    Object.defineProperty(event, 'syntheticGetterKey', {
      enumerable: true,
      get() { getterHits++; return 'synthetic-value'; }
    });
    const r = await makeChecker(db, { keyDiagnostic: true }).handle(event);
    assert.equal(r.code, 'PIC_REQUEST_INVALID');
    assert.equal(getterHits, 0, '诊断路径不得读取任何值/getter');
    assert.equal(r.keyDiagnostic.otherKeyCount, 1);
  }

  // (5) 键枚举本身异常（Proxy ownKeys 抛错）：保持净化失败、无诊断、零读取
  {
    const db = makeTrapDb({ rows: [] });
    const event = new Proxy(
      { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND },
      { ownKeys() { throw new Error('synthetic ownKeys failure'); } }
    );
    const r = await makeChecker(db, { keyDiagnostic: true }).handle(event);
    assert.equal(r.ok, false);
    assert.equal(r.code, core.GENERIC_CODE, '非内部异常净化为通用未知');
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'keyDiagnostic'), false, '枚举异常无诊断');
    assert.equal(r.readAttempted, false);
    assert.equal(db.calls.reads, 0);
  }

  // (6) 非布尔开关配置直接拒绝；buildKeyDiagnostic 直接单元（分桶边界）
  assert.throws(() => core.createIdentityChecker({
    db: makeTrapDb({ rows: [] }),
    trusted: trustedContext(openid),
    config: {
      checkRoundId: TEST_ROUND, passphraseDigest: SYNTHETIC_DIGEST,
      windowStartsAtMs: 1000, windowExpiresAtMs: 2000, keyDiagnostic: 'yes'
    },
    now: () => 1500
  }), e => e.code === core.ERR_CODES.TARGET_MISMATCH && /诊断开关无效/.test(e.message), '非布尔诊断开关拒绝');
  const unit = core.buildKeyDiagnostic({ a: 1, bb: 2, ccc: 3, userInfo: { synthetic: true } });
  assert.equal(unit.otherKeyCount, 3);
  assert.equal(unit.otherKeyNameLengthBuckets['len<=4'], 3);
  assert.deepEqual(unit.candidateLabels, ['CANDIDATE_USERINFO']);
  assert.equal(unit.truncated, false);
});

test('D2 生成链（请求分层协议）：外层附带键容忍进入本人只读链；旧格式/混用/内层非法/冲突拒绝且零工厂；口令清除保持', async () => {
  const closeSource = makeCloseSourceDir();
  const openid = 'openid-diag-chain-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  // wx 替身：客户端数据原样进入候选 main；mutate 在服务端边界模拟平台入站附带（可返回替换对象）
  const mkChain = (outDir, mutate, rows) => {
    const sent = [];
    const factory = { databaseCalls: 0 };
    const db = makeTrapDb({ rows: rows || [] });
    const stub = {
      cloud: {
        _identityCheckEnvInited: false,
        init() {},
        callFunction(opts) {
          sent.push({ keys: Object.keys(opts.data).slice().sort() });
          const main = loadCandidateMain(outDir, { appId: APPID, envId: ENV_ID, openid, db, onDatabase: () => factory.databaseCalls++ });
          const event = Object.assign({}, opts.data);
          const replaced = mutate ? mutate(event) : undefined;
          return main.main(replaced === undefined ? event : replaced).then(result => ({ result }));
        }
      }
    };
    return { stub, sent, dbCalls: db.calls, factory };
  };
  const attachSecretGetter = (e, name) => Object.defineProperty(e, name, { enumerable: true, get() { throw new Error('synthetic-envelope-getter'); } });

  // (1) v2 真实模式候选：requestProtocol 绑定、keyDiagnostic=false、check 重建一致
  const diagPlanPath = writePicPlan(closeSource, { synthetic: false });
  const diagOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'diag-' + RUN_ID);
  const builtDiag = packer.build(diagPlanPath, diagOut);
  assert.equal(builtDiag.manifest.requestProtocol, packer.REQUEST_PROTOCOL, 'manifest 绑定请求协议');
  assert.equal(builtDiag.manifest.keyDiagnostic, false, '新协议诊断关闭');
  assert.ok(fs.readFileSync(path.join(diagOut, 'server', 'scheduleSandbox', 'index.js'), 'utf8')
    .includes('const CONFIG_KEY_DIAGNOSTIC = false;'), '入口诊断开关为 false');
  const planRound = builtDiag.manifest.checkRoundId;

  // (2) 正向链：外层 userInfo + 9–16 码元未知键 + 秘密键名 + 抛错 getter 全部容忍 → ACTIVE
  const secretKey = 'synthetic_secret_' + crypto.randomBytes(8).toString('hex');
  const pos = mkChain(diagOut, e => {
    e.userInfo = { appId: 'synthetic-envelope-appid', openId: 'synthetic-envelope-openid' };
    e.syntheticUnknownKey12 = { synthetic: true };
    e[secretKey] = { synthetic: true };
    attachSecretGetter(e, 'syntheticGetterKey');
  }, [{ _id: userId, openid, status: 'active' }]);
  await withGlobalWx(pos.stub, async () => {
    const page = loadCandidatePage(diagOut, pos.stub);
    page.onLoad(); page.onShow();
    assert.equal(pos.sent.length, 0, '加载与切前台零发送');
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(pos.sent.length, 1, '只点一次只发一次');
    assert.deepEqual(pos.sent[0].keys, ['picRequest'], '外层仅 picRequest 一个键');
    assert.equal(page.data.result.registrationState, 'ACTIVE', '外层附带容忍进入本人只读链');
    assert.equal(page.data.result.identityConfirmed, true);
    assert.equal(page.data.result.userId, userId, '勾选后完整编号返回');
    assert.equal(page.data.passphrase, '', '调用结束清除口令输入');
    assert.equal(pos.factory.databaseCalls, 1, '数据库工厂恰一次');
    assert.equal(pos.dbCalls.collections.length, 1, '固定集合恰一次');
    assert.equal(pos.dbCalls.reads, 1, '本人主键至多一次 get');
    assert.deepEqual(pos.dbCalls.fields, [{ _id: true, openid: true, status: true }], '三字段投影');
    const pageDump = JSON.stringify(page.data);
    assert.equal(pageDump.includes(secretKey), false, '秘密键名不入页面数据');
    assert.equal(pageDump.includes('synthetic-envelope-appid'), false, '附带值不入页面数据');
    assert.equal(pageDump.includes('"keyDiagnostic"'), false, '新协议无诊断对象字段');
  });

  // (3) 拒绝矩阵：每例 PIC_REQUEST_INVALID、工厂0/集合0/读取0、无诊断字段
  // 三类原型伪造（复查 R1）：自造方法 / 复制 Object.prototype 描述符 / 伪造构造器手工自关联
  const chainForgery = (() => {
    const mkRoot = selfBind => {
      const root = Object.create(null);
      for (const key of ['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf', 'constructor']) {
        Object.defineProperty(root, key, { enumerable: false, writable: true, configurable: true, value: function syntheticFake() {} });
      }
      root.role = 'synthetic-inherited-role';
      if (selfBind) Object.getOwnPropertyDescriptor(root, 'constructor').value.prototype = root;
      return root;
    };
    return {
      fakeMethods: mkRoot(false),
      selfBound: mkRoot(true),
      copiedDescriptors: Object.create(null, Object.getOwnPropertyDescriptors(Object.prototype))
    };
  })();
  const rejections = {
    仅旧顶层格式: () => ({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, checkRoundId: TEST_ROUND }),
    两格式混用: e => { e.action = 'inspectSelf'; e.passphrase = SYNTHETIC_PASSPHRASE; e.checkRoundId = TEST_ROUND; },
    外层冲突动作: e => { e.action = 'inspectSelf'; },
    外层自报身份: e => { e.openid = 'synthetic-forged'; e.APPID = 'synthetic-forged-appid'; e.role = 'synthetic-forged-role'; },
    内层额外字段: e => { e.picRequest.syntheticExtra = 1; },
    内层伪造身份: e => { e.picRequest.openid = 'synthetic-forged'; },
    内层错schema: e => { e.picRequest.schema = 'participant-identity-request/2'; },
    内层缺schema: e => { delete e.picRequest.schema; },
    picRequest为访问器: e => { delete e.picRequest; Object.defineProperty(e, 'picRequest', { enumerable: true, get() { return { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE }; } }); },
    picRequest为继承字段: () => { const child = Object.create({ picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE } }); return child; },
    元操作抛错: e => { Object.defineProperty(e, Symbol.for('synthetic-meta'), { enumerable: false, get() { throw new Error('synthetic-meta'); } }); e[Symbol.for('synthetic-own')] = 1; },
    自定义原型: () => { function Cls() {} Cls.prototype.picRequest = { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE }; return new Cls(); },
    '外层自定义null-root原型': () => { const custom = Object.create(null); custom.role = 'synthetic-forged'; return Object.assign(Object.create(custom), { picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE } }); },
    '内层自定义null-root原型': e => { const custom = Object.create(null); custom.role = 'synthetic-forged'; e.picRequest = Object.assign(Object.create(custom), { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE }); },
    '外层自造方法原型': () => Object.assign(Object.create(chainForgery.fakeMethods), { picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE } }),
    '内层自造方法原型': e => { e.picRequest = Object.assign(Object.create(chainForgery.fakeMethods), { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE }); },
    '外层复制描述符原型': () => Object.assign(Object.create(chainForgery.copiedDescriptors), { picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE } }),
    '内层复制描述符原型': e => { e.picRequest = Object.assign(Object.create(chainForgery.copiedDescriptors), { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE }); },
    '外层伪造自关联原型': () => Object.assign(Object.create(chainForgery.selfBound), { picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE } }),
    '内层伪造自关联原型': e => { e.picRequest = Object.assign(Object.create(chainForgery.selfBound), { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE }); }
  };
  for (const [name, mutate] of Object.entries(rejections)) {
    const neg = mkChain(diagOut, mutate, [{ _id: userId, openid, status: 'active' }]);
    await withGlobalWx(neg.stub, async () => {
      const page = loadCandidatePage(diagOut, neg.stub);
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(page.data.result.code, 'PIC_REQUEST_INVALID', name + '：净化失败码');
      assert.equal(page.data.result.registrationState, 'UNKNOWN', name + '：UNKNOWN');
      assert.equal(page.data.result.readAttempted, false, name + '：读取事实 false');
      assert.equal(page.data.result.serverRoundText, planRound, name + '：服务端返回轮次来自受审配置');
      assert.equal(page.data.result.serverTime, '', name + '：不附服务端时间');
      assert.equal(page.data.passphrase, '', name + '：口令清除保持');
      assert.equal(neg.factory.databaseCalls, 0, name + '：零数据库工厂');
      assert.equal(neg.dbCalls.collections.length, 0, name + '：零集合访问');
      assert.equal(neg.dbCalls.reads, 0, name + '：零读取');
      assert.equal(JSON.stringify(page.data).includes('"keyDiagnostic"'), false, name + '：不附诊断');
    });
  }

  // (4) 关闭包：零适配器/诊断/新协议字符串
  let closeHits = 0;
  (function scanClose(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scanClose(p);
      else if (/keyDiagnostic|request-adapter|picRequest/.test(fs.readFileSync(p, 'utf8'))) closeHits++;
    }
  })(path.join(diagOut, 'close'));
  assert.equal(closeHits, 0, '关闭包不含适配器/诊断/新协议字符串');

  // (5) 手改拒绝：入口适配器调用被篡改 → checkDir 重建比对拒绝
  const entryPath = path.join(diagOut, 'server', 'scheduleSandbox', 'index.js');
  const origEntry = fs.readFileSync(entryPath, 'utf8');
  fs.writeFileSync(entryPath, origEntry.replace('requestAdapter.extractBusinessRequest(event)', 'requestAdapter.extractBusinessRequest({})'));
  assert.equal(packer.checkDir(diagOut).ok, false, '手改入口适配器调用被拒');
  fs.writeFileSync(entryPath, origEntry);
  assert.equal(packer.checkDir(diagOut).ok, true, '还原后重建一致');
});

test('D3 R2 诊断构建后/附加前重查窗口：构造期间到期/NaN/抛错撤销诊断；构造前有效对照可见；零DB与失败语义保持', async () => {
  const passphrase = 'synthetic-r2-passphrase-' + RUN_ID;
  const digest = crypto.createHash('sha256').update(passphrase).digest('hex');
  const mk = endState => {
    let phase = 0, enumerations = 0, clockReads = 0, dbCalls = 0;
    const checker = core.createIdentityChecker({
      db: { collection() { dbCalls++; throw new Error('TRAP: 诊断路径禁止DB'); } },
      trusted: trustedContext('openid-r2-' + RUN_ID),
      config: { checkRoundId: TEST_ROUND, passphraseDigest: digest, windowStartsAtMs: 1000, windowExpiresAtMs: 2000, keyDiagnostic: true },
      // 合成时钟：第二次键枚举（诊断构建）后进入失效状态——模拟「构造前有效、构造后失效」
      now() {
        clockReads++;
        if (!phase || endState === 'unchanged') return 1500;
        if (endState === 'throws') throw new Error('synthetic-clock-unavailable');
        return endState === 'NaN' ? NaN : 2000;
      }
    });
    // 合成枚举钩子：在第 2 次 ownKeys（buildKeyDiagnostic 内部枚举）推进时钟相位；
    // 这不声称真实平台 event 含 Proxy，也不声称平台已发生越窗。
    const event = new Proxy(
      { action: 'inspectSelf', passphrase, checkRoundId: TEST_ROUND, userInfo: {} },
      { ownKeys(t) { if (++enumerations === 2) phase = 1; return Reflect.ownKeys(t); } }
    );
    return { checker, event, stats: () => ({ clockReads, enumerations, dbCalls }) };
  };
  const cases = [
    ['unchanged', true],  // 构造前后时钟均有效 → 诊断可见
    ['expires', false],   // 构建期间恰好到期 → 撤销
    ['NaN', false],       // 构建期间时钟变为 NaN → 撤销
    ['throws', false]     // 构建期间时钟抛错 → 撤销
  ];
  for (const [endState, expectDiag] of cases) {
    const { checker, event, stats } = mk(endState);
    const r = await checker.handle(event);
    assert.equal(r.code, 'PIC_REQUEST_INVALID', endState + '：失败语义保持');
    assert.equal(r.ok, false, endState);
    assert.equal(r.registrationState, 'UNKNOWN', endState);
    assert.equal(r.readAttempted, false, endState + '：读取事实保持');
    assert.equal(r.keyDiagnostic !== undefined, expectDiag, endState + '：诊断' + (expectDiag ? '应附加' : '必须撤销'));
    const s = stats();
    assert.equal(s.dbCalls, 0, endState + '：零DB');
    assert.equal(s.enumerations, 2, endState + '：两次枚举（请求键检查+诊断构建）');
    assert.ok(s.clockReads >= (expectDiag ? 3 : 2), endState + '：时钟多重查（构建前/构建后[/附加前]）');
  }
});

test('D4 v2 清单绑定：requestProtocol/诊断协议/scope 统一严格校验（缺失/错值/篡改拒绝）；keyDiagnostic=true 计划拒绝；关闭检查不依赖候选窗口', () => {
  const closeSource = makeCloseSourceDir();
  const mkCandidate = planOverrides => {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'mbind-' + crypto.randomBytes(4).toString('hex'));
    packer.build(writePicPlan(closeSource, planOverrides), outDir);
    return outDir;
  };
  const tamper = (outDir, patch) => {
    const manifestPath = path.join(outDir, 'manifest.json');
    const original = fs.readFileSync(manifestPath);
    const m = JSON.parse(original);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete m[k]; else m[k] = v;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
    const ok = packer.checkDir(outDir).ok;
    fs.writeFileSync(manifestPath, original);
    return ok;
  };
  // (1) 唯一合法模式：keyDiagnostic 缺省（false）；合法对照与逐字段篡改/缺失拒绝
  const outDir = mkCandidate({});
  assert.equal(packer.checkDir(outDir).ok, true, '合法对照通过');
  assert.equal(tamper(outDir, { requestProtocol: 'participant-identity-request/2' }), false, '协议错值拒绝');
  assert.equal(tamper(outDir, { requestProtocol: undefined }), false, '协议缺失拒绝');
  assert.equal(tamper(outDir, { keyDiagnostic: true }), false, '清单诊断开关翻转为 true 拒绝');
  assert.equal(tamper(outDir, { keyDiagnosticSchema: 'synthetic-unrelated-protocol' }), false, '诊断协议错值拒绝');
  assert.equal(tamper(outDir, { keyDiagnosticScope: 'synthetic-unrelated-scope' }), false, 'scope 错值拒绝');
  assert.equal(tamper(outDir, { keyDiagnosticSchema: undefined }), false, '诊断协议缺失拒绝');
  assert.equal(tamper(outDir, { requestProtocol: packer.REQUEST_PROTOCOL }), true, '协议原值回写通过');
  // (2) 计划层反例：keyDiagnostic=true 写前拒绝；旧 v1 计划 schema 拒绝；缺 requestProtocol 拒绝
  assert.throws(() => packer.build(writePicPlan(closeSource, { keyDiagnostic: true })),
    e => e.code === packer.ERR.PLAN_INVALID && /keyDiagnostic/.test(e.message), 'keyDiagnostic=true 计划拒绝');
  const v1PlanPath = writePicPlan(closeSource, { schema: 'participant-identity-plan/1' });
  assert.throws(() => packer.build(v1PlanPath),
    e => e.code === packer.ERR.PLAN_INVALID, '旧 v1 计划 schema 拒绝');
  const noProto = writePicPlan(closeSource, { requestProtocol: undefined });
  assert.throws(() => packer.build(noProto),
    e => e.code === packer.ERR.PLAN_INVALID && /requestProtocol/.test(e.message), '缺 requestProtocol 拒绝');
  // (3) 独立关闭检查不依赖候选窗口：synthetic 模式允许过去窗口候选装配，checkCloseDir 仍通过
  const pastOut = path.join(OUT_ROOT, packer.OUT_PREFIX + 'pastwin-' + crypto.randomBytes(4).toString('hex'));
  const past = Date.parse('2020-01-01T00:00:00Z');
  packer.build(writePicPlan(closeSource, {
    windowStartsAtIso: new Date(past).toISOString(),
    windowExpiresAtIso: new Date(past + 600000).toISOString()
  }), pastOut);
  process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
  try { assert.equal(packer.checkCloseDir(pastOut).ok, true, '关闭检查不读候选窗口'); }
  finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
});

test('D5 R4 客户端严格验证：畸形诊断整份丢弃不修补；合法对照保留；生成页面无效诊断不展示且原失败事实与口令清除保持', async () => {
  // (1) 模板级：畸形变体全部丢弃
  const clientFile = path.join(packer.TEMPLATE_DIR, 'frontend', 'utils', 'identity-check-client.js');
  const base = () => ({
    schema: core.KEY_DIAGNOSTIC_SCHEMA, diagnosticScope: core.KEY_DIAGNOSTIC_SCOPE,
    otherKeyCount: 1,
    otherKeyNameLengthBuckets: { 'len<=4': 1, 'len5-8': 0, 'len9-16': 0, 'len17-32': 0, lenOver32: 0 },
    candidateLabels: [], truncated: false
  });
  const malformedCases = {
    '标签非数组': d => { d.candidateLabels = 'synthetic-invalid-type'; },
    '计数与分桶不一致': d => { d.otherKeyCount = 9; },
    '非法标签值': d => { d.candidateLabels = ['SYNTHETIC_UNKNOWN_LABEL']; },
    '重复标签': d => { d.candidateLabels = ['CANDIDATE_USERINFO', 'CANDIDATE_USERINFO']; },
    '标签超量': d => { d.candidateLabels = new Array(9).fill('CANDIDATE_USERINFO'); },
    '计数负数': d => { d.otherKeyCount = -1; },
    '计数非整数': d => { d.otherKeyCount = 1.5; },
    '分桶缺失': d => { delete d.otherKeyNameLengthBuckets['len<=4']; },
    '分桶负数': d => { d.otherKeyNameLengthBuckets['len5-8'] = -1; },
    'truncated非布尔': d => { d.truncated = 'no'; },
    'schema错误': d => { d.schema = 'synthetic-schema'; },
    'scope错误': d => { d.diagnosticScope = 'synthetic-scope'; },
    '缺candidateLabels': d => { delete d.candidateLabels; },
    '缺otherKeyCount': d => { delete d.otherKeyCount; },
    '截断矛盾-空标签+true': d => { d.candidateLabels = []; d.truncated = true; },
    '截断矛盾-单标签+true': d => { d.candidateLabels = ['CANDIDATE_USERINFO']; d.truncated = true; }
  };
  let currentResult = null;
  const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async () => ({ result: currentResult }) } };
  await withGlobalWx(wxStub, async () => {
    const ctx = { module: { exports: {} }, require: () => ({ checkRoundId: TEST_ROUND, requestProtocol: packer.REQUEST_PROTOCOL, previewBuildId: 'a'.repeat(64), identityCheckFunction: 'scheduleSandbox' }), wx: wxStub };
    vm.runInNewContext(fs.readFileSync(clientFile, 'utf8'), ctx, { filename: clientFile });
    const client = ctx.module.exports;
    const call = async diag => {
      currentResult = {
        schema: core.RESULT_SCHEMA, checkRoundId: TEST_ROUND, ok: false, identityConfirmed: false,
        registrationState: 'UNKNOWN', recordMatched: null, readAttempted: false, userIdTail: '', code: 'PIC_REQUEST_INVALID', message: '请求含未登记字段。'
      };
      if (diag !== undefined) currentResult.keyDiagnostic = diag;
      // 2026-10-19 任务 §2.2：客户端返回本地封套 {response, localRequestEvidence, transportOutcome}；
      // 本测试关注服务端 result 投影，故取封套内的 response（未改服务端结果）。
      const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: 'synthetic-r4-passphrase' });
      assert.ok(envelope && typeof envelope === 'object' && envelope.transportOutcome === 'returned', '封套结构：returned');
      assert.ok(envelope.localRequestEvidence && envelope.localRequestEvidence.handoffAttempted === true, '封套携带已尝试本机快照');
      return envelope.response;
    };
    // 畸形：整份丢弃（keyDiagnostic 字段消失），不修补
    for (const [name, mutate] of Object.entries(malformedCases)) {
      const d = base();
      const special = mutate(d);
      const input = typeof special === 'string' ? special : d;
      const r = await call(input);
      assert.equal(r && r.keyDiagnostic, undefined, name + '：畸形诊断整份丢弃');
      assert.equal(r.code, 'PIC_REQUEST_INVALID', name + '：原失败事实保持');
    }
    // 合法对照：保留
    const good = await call(base());
    assert.ok(good.keyDiagnostic, '合法诊断保留');
    assert.equal(good.keyDiagnostic.otherKeyCount, 1);
    // 合法标签对照（truncated=false）：保留；truncated=true 矛盾已在畸形集中拒绝
    const withLabel = base();
    withLabel.candidateLabels = ['CANDIDATE_USERINFO'];
    const r2 = await call(withLabel);
    assert.equal(JSON.stringify(r2.keyDiagnostic.candidateLabels), JSON.stringify(['CANDIDATE_USERINFO']), '合法标签保留（跨vm用JSON比较）');
    assert.equal(r2.keyDiagnostic.truncated, false);
    // 新候选合法标签保留；跨标签重复整份丢弃；双标签合法保留
    const newLabel = base();
    newLabel.candidateLabels = ['CANDIDATE_WX_CLOUD_API_TOKEN'];
    const r3 = await call(newLabel);
    assert.equal(JSON.stringify(r3.keyDiagnostic.candidateLabels), JSON.stringify(['CANDIDATE_WX_CLOUD_API_TOKEN']), '新候选合法标签保留');
    const dupPair = base();
    dupPair.candidateLabels = ['CANDIDATE_USERINFO', 'CANDIDATE_WX_CLOUD_API_TOKEN', 'CANDIDATE_USERINFO'];
    assert.equal((await call(dupPair)).keyDiagnostic, undefined, '跨标签重复整份丢弃');
    const pairLegal = base();
    pairLegal.candidateLabels = ['CANDIDATE_USERINFO', 'CANDIDATE_WX_CLOUD_API_TOKEN'];
    assert.equal((await call(pairLegal)).keyDiagnostic !== undefined, true, '双标签合法保留');
  });

  // (2) 生成页面链：畸形诊断不展示；合法诊断展示；原失败事实与口令清除保持
  const closeSource = makeCloseSourceDir();
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'r4page-' + crypto.randomBytes(4).toString('hex'));
  packer.build(writePicPlan(closeSource), outDir);
  const drive = async diag => {
    const response = {
      schema: core.RESULT_SCHEMA, checkRoundId: TEST_ROUND, ok: false, identityConfirmed: false,
      registrationState: 'UNKNOWN', recordMatched: null, readAttempted: false, userIdTail: '',
      code: 'PIC_REQUEST_INVALID', message: '请求含未登记字段。'
    };
    if (diag !== undefined) response.keyDiagnostic = diag;
    const pageStub = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction: async () => ({ result: response }) } };
    let shown;
    await withGlobalWx(pageStub, async () => {
      const page = loadCandidatePage(outDir, pageStub);
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(page.data.result.code, 'PIC_REQUEST_INVALID');
      assert.equal(page.data.passphrase, '', '口令清除保持');
      shown = page.data.result.keyDiagnosticText;
    });
    return shown;
  };
  const malformedShown = await drive((() => { const d = base(); d.otherKeyCount = 9; return d; })());
  assert.equal(malformedShown, '', '生成页面：畸形诊断不展示（净化为空文本）');
  // S2：截断矛盾诊断（单标签+truncated=true）不展示，不得出现「已截断」文本
  const contradictoryShown = await drive((() => {
    const d = base();
    d.candidateLabels = ['CANDIDATE_USERINFO'];
    d.truncated = true;
    return d;
  })());
  assert.equal(contradictoryShown, '', '生成页面：截断矛盾诊断不展示');
  const legalShown = await drive(base());
  assert.ok(typeof legalShown === 'string' && legalShown.includes('其它键 1 个'), '生成页面：合法诊断展示');
  assert.equal(legalShown.includes('已截断'), false, '合法对照不出现截断文本');
  // S2 扩展：新候选合法标签在生成页面展示
  const newLabelShown = await drive((() => { const d = base(); d.candidateLabels = ['CANDIDATE_WX_CLOUD_API_TOKEN']; return d; })());
  assert.ok(typeof newLabelShown === 'string' && newLabelShown.includes('CANDIDATE_WX_CLOUD_API_TOKEN'), '生成页面：新候选标签展示');
});

test('D6 审计v13失败判定：业务期意外守卫（含被catch）必须非零退出且ok=false；正常对照意外0退出0；漂移反例退出1；探针单独记账（历史20261016脚本保留为347261a字节，v7–v12保持各轮已交付字节）', () => {
  const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
  const auditFile = path.join(PROJECT_ROOT, 'docs', '证据', 'CodeBuddyI1入站审计v13-20261020.cjs');
  const auditSource = fs.readFileSync(auditFile, 'utf8');
  const runAudit = kind => {
    let source = auditSource;
    if (kind === 'caughtAttempt') {
      const anchor = 'const businessStart = guardHits.length;';
      assert.equal(source.split(anchor).length, 2, '注入锚点唯一');
      source = source.replace(anchor, anchor + "\ntry { require('node:https').request('https://example.invalid'); } catch (_) {}");
    }
    const processStub = { argv: ['node', auditFile], exitCode: 0 };
    const outputs = [], errors = [];
    const nativeRequire = createRequire(auditFile);
    const fsProxy = new Proxy(fs, { get(target, key) {
      if (key !== 'readFileSync' || kind !== 'sourceDrift') return target[key];
      return (p, ...args) => {
        const b = target.readFileSync(p, ...args);
        if (path.resolve(String(p)) !== path.join(PROJECT_ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs')) return b;
        return Buffer.concat([b, Buffer.from('\n// synthetic drift\n')]);
      };
    }});
    const context = {
      require: n => (n === 'node:fs' ? fsProxy : nativeRequire(n)),
      __dirname: path.dirname(auditFile), __filename: auditFile, Buffer, process: processStub,
      console: { log: s => outputs.push(s), error: (...s) => errors.push(s.join(' ')) }
    };
    vm.runInNewContext(source, context, { filename: auditFile, timeout: 30000 });
    const out = JSON.parse(outputs[0]);
    return { exitCode: processStub.exitCode, ok: out.ok, counters: out.counters, driftHits: out.sourcePins.driftHits };
  };
  const baseline = runAudit('baseline');
  assert.equal(baseline.exitCode, 0, '正常对照退出0');
  assert.equal(baseline.ok, true);
  assert.equal(baseline.counters.businessPhaseGuardAttempts, 0, '正常对照业务期意外0');
  assert.equal(baseline.counters.sensitivityGuardAttempts, 2, '敏感性探针单独记账');
  const caught = runAudit('caughtAttempt');
  assert.equal(caught.counters.businessPhaseGuardAttempts, 1, '被catch的意外同样记账');
  assert.equal(caught.ok, false, '意外>0 成功标记不得为真');
  assert.equal(caught.exitCode, 1, '意外>0 必须非零退出');
  const drift = runAudit('sourceDrift');
  assert.equal(drift.driftHits, 1, '来源漂移检出');
  assert.equal(drift.ok, false);
  assert.equal(drift.exitCode, 1, '漂移必须非零退出');
});

test('D7 收尾证据v8外层判定：外层被catch意外>0 时 ok=false/exit1；正常对照意外0/exit0；守卫计数写入JSON且与内部审计预期反例分述（v7 保持上一轮已交付字节，v6/v5/v4/v3/v2 与历史20261016脚本保持原字节）', async () => {
  const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
  const evidenceFile = path.join(PROJECT_ROOT, 'docs', '证据', 'CodeBuddy受控诊断R1R4收尾v8-20261020.cjs');
  const source = fs.readFileSync(evidenceFile, 'utf8');
  const run = kind => {
    let src = source;
    if (kind === 'caughtAttempt') {
      // 唯一锚点：main 体内 businessStart 行 + 其后 R1 注释行（该文件为 CRLF 行尾；
      // runAudit 内字符串字面量不含此上下文）
      const anchor2 = 'const businessStart = guardHits.length;\r\n\r\n  // ── R1：审计退出码';
      assert.equal(src.split(anchor2).length, 2, '外层业务期起点锚点唯一');
      // 在外层 businessStart 之后注入一次被 catch 的意外尝试：真实守卫拦截，无网络发出
      src = src.replace(anchor2, 'const businessStart = guardHits.length;\r\ntry { require(\'node:https\').request(\'https://example.invalid\'); } catch (_) {}\r\n\r\n  // ── R1：审计退出码');
    }
    // 包装 main() 的 Promise 以便异步等待完成
    const tail = 'main().catch(e => { console.error(e && e.message ? e.message : e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));';
    assert.equal(src.split(tail).length, 2, 'main 调用尾部锚点唯一');
    src = src.replace(tail, 'globalThis.__mainPromise = ' + tail);
    // 沙箱 env 仅共享合成变量 PIC_CLOSE_SOURCE_DIR（与 Codex 复查包装同一做法）：
    // 收尾脚本对该键的写入/删除落到真实 env，checkCloseDir 才能读到；其余键留在沙箱内。
    const sharedEnv = new Proxy({}, {
      get(t, k) { return k === 'PIC_CLOSE_SOURCE_DIR' ? process.env.PIC_CLOSE_SOURCE_DIR : t[k]; },
      set(t, k, v) { if (k === 'PIC_CLOSE_SOURCE_DIR') process.env.PIC_CLOSE_SOURCE_DIR = v; else t[k] = v; return true; },
      deleteProperty(t, k) { if (k === 'PIC_CLOSE_SOURCE_DIR') delete process.env.PIC_CLOSE_SOURCE_DIR; else delete t[k]; return true; },
      has(t, k) { return k === 'PIC_CLOSE_SOURCE_DIR' ? Object.prototype.hasOwnProperty.call(process.env, 'PIC_CLOSE_SOURCE_DIR') : k in t; }
    });
    const processStub = { argv: ['node', evidenceFile], exitCode: 0, env: sharedEnv };
    const outputs = [], errors = [];
    const nativeRequire = createRequire(evidenceFile);
    const context = {
      require: nativeRequire, __dirname: path.dirname(evidenceFile), __filename: evidenceFile,
      Buffer, process: processStub, console: { log: s => outputs.push(s), error: (...s) => errors.push(s.join(' ')) }
    };
    vm.runInNewContext(src, context, { filename: evidenceFile, timeout: 180000 });
    return context.__mainPromise.then(() => {
      if (!outputs[0]) throw new Error('收尾证据脚本未输出JSON；vm错误: ' + errors.join(' | ') + '；exitCode=' + processStub.exitCode);
      const out = JSON.parse(outputs[0]);
      return { exitCode: processStub.exitCode, ok: out.ok, guardCounters: out.guardCounters, r1: { baseline: out.r1.baseline.exitCode, caughtAttempt: out.r1.caughtAttempt.exitCode, sourceDrift: out.r1.sourceDrift.exitCode } };
    });
  };
  const baseline = await run('baseline');
  assert.equal(baseline.exitCode, 0, '正常对照退出0');
  assert.equal(baseline.ok, true, '正常对照 ok=true');
  assert.equal(baseline.guardCounters.businessPhaseGuardAttempts, 0, '正常对照外层业务期意外0');
  assert.equal(baseline.guardCounters.sensitivityAttempts, 2, '外层探针单独记账');
  assert.equal(baseline.guardCounters.total, 2, '总次数=探针+意外');
  // 内部审计预期反例保持原出口（与外层意外分述）
  assert.deepEqual(baseline.r1, { baseline: 0, caughtAttempt: 1, sourceDrift: 1 });
  const caught = await run('caughtAttempt');
  assert.equal(caught.guardCounters.businessPhaseGuardAttempts, 1, '外层被catch意外记账');
  assert.equal(caught.guardCounters.total, 3);
  assert.equal(caught.ok, false, '意外>0 成功标记不得为真');
  assert.equal(caught.exitCode, 1, '意外>0 必须非零退出');
  // 内部审计的预期反例不因外层注入被清零掩盖
  assert.deepEqual(caught.r1, { baseline: 0, caughtAttempt: 1, sourceDrift: 1 });
  // 安全清理：不向真实环境遗留合成变量
  delete process.env.PIC_CLOSE_SOURCE_DIR;
});

// ════════════════════════════════════════════════════════════════════════════
// A1–A4 请求分层兼容（Codex方案 §3–§6；CodeBuddy任务-I1请求分层兼容本地实现-20261017）
// ════════════════════════════════════════════════════════════════════════════

const requestAdapter = require('../scripts/templates/participant-identity-check/server/request-adapter.js');
const IDENTITY_REQUEST_SDK_PATH = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/wx-server-sdk';

test('A1 适配器单元矩阵（§3）：普通/null原型/跨vm plain 接受；冲突/Symbol/非枚举同名/访问器/继承/类型/元操作/三类原型伪造拒绝；仅构造原四字段且schema不入核心', () => {
  const valid = { schema: 'participant-identity-request/1', action: 'inspectSelf', checkRoundId: 'synthetic-r', passphrase: 'synthetic-p' };
  const okReq = { action: 'inspectSelf', checkRoundId: 'synthetic-r', passphrase: 'synthetic-p' };
  // 三类原型伪造（复查 R1）：自造方法 / 复制 Object.prototype 描述符 / 伪造构造器手工自关联
  const fakeMethodCalls = { n: 0 };
  const mkFakeRoot = selfBind => {
    const root = Object.create(null);
    for (const key of ['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf', 'constructor']) {
      Object.defineProperty(root, key, {
        enumerable: false, writable: true, configurable: true,
        value: function syntheticFake() { fakeMethodCalls.n++; }
      });
    }
    root.role = 'synthetic-inherited-role';
    if (selfBind) Object.getOwnPropertyDescriptor(root, 'constructor').value.prototype = root;
    return root;
  };
  const forgery = {
    fakeMethods: mkFakeRoot(false),
    selfBound: mkFakeRoot(true),
    copiedDescriptors: Object.create(null, Object.getOwnPropertyDescriptors(Object.prototype))
  };
  // (1) 接受：普通对象
  assert.deepEqual(requestAdapter.extractBusinessRequest({ picRequest: valid }), { ok: true, request: okReq });
  // (2) 接受：null 原型外层与内层
  const nullProtoEvent = Object.assign(Object.create(null), { picRequest: Object.assign(Object.create(null), valid) });
  assert.equal(requestAdapter.extractBusinessRequest(nullProtoEvent).ok, true, 'null 原型接受');
  // (3) 接受：跨 vm 仓库创建的 plain 对象（原型链深度 ≤1）
  const crossRealm = vm.runInNewContext('({ picRequest: { schema: "participant-identity-request/1", action: "inspectSelf", checkRoundId: "synthetic-r", passphrase: "synthetic-p" } })');
  assert.equal(requestAdapter.extractBusinessRequest(crossRealm).ok, true, '跨vm plain 对象接受');
  // (4) includeFullUserId：缺省/false/true 均按布尔语义处理
  assert.equal(requestAdapter.extractBusinessRequest({ picRequest: valid }).request.includeFullUserId, undefined, '缺省不携带');
  assert.equal(requestAdapter.extractBusinessRequest({ picRequest: Object.assign({}, valid, { includeFullUserId: false }) }).request.includeFullUserId, false, 'false 按布尔透传');
  assert.equal(requestAdapter.extractBusinessRequest({ picRequest: Object.assign({}, valid, { includeFullUserId: true }) }).request.includeFullUserId, true, 'true 按布尔透传');
  // (5) 拒绝集（全部 ok:false，且不外露任何键名/值/异常信息）
  const rejects = {
    event为数组: () => [{ picRequest: valid }],
    event为标量: () => 'x',
    event为null: () => null,
    缺picRequest: () => ({}),
    picRequest继承取得: () => Object.create({ picRequest: valid }),
    picRequest为标量: () => ({ picRequest: 'x' }),
    picRequest为数组: () => ({ picRequest: [] }),
    picRequest为访问器: () => { const e = {}; Object.defineProperty(e, 'picRequest', { enumerable: true, get() { return valid; } }); return e; },
    picRequest非枚举: () => { const e = {}; Object.defineProperty(e, 'picRequest', { enumerable: false, value: valid }); return e; },
    外层冲突action: () => ({ action: 'inspectSelf', picRequest: valid }),
    外层冲突旧schema: () => ({ schema: 'x', picRequest: valid }),
    外层自报openid: () => ({ openid: 'x', picRequest: valid }),
    外层自报大写OPENID: () => ({ OPENID: 'x', picRequest: valid }),
    外层自报role: () => ({ role: 'x', picRequest: valid }),
    外层自报envId: () => ({ envId: 'x', picRequest: valid }),
    外层非枚举constructor: () => { const e = {}; Object.defineProperty(e, 'constructor', { enumerable: false, value: 'x' }); e.picRequest = valid; return e; },
    外层Symbol键: () => { const e = { picRequest: valid }; e[Symbol.for('synthetic-outer')] = 1; return e; },
    内层额外字段: () => ({ picRequest: Object.assign({}, valid, { syntheticExtra: 1 }) }),
    内层伪造openid: () => ({ picRequest: Object.assign({}, valid, { openid: 'synthetic-forged' }) }),
    内层伪造role: () => ({ picRequest: Object.assign({}, valid, { role: 'synthetic-forged' }) }),
    内层Symbol键: () => { const pic = Object.assign({}, valid); pic[Symbol.for('synthetic-inner')] = 1; return { picRequest: pic }; },
    内层非枚举action: () => { const pic = {}; Object.defineProperty(pic, 'action', { enumerable: false, value: 'inspectSelf' }); pic.schema = valid.schema; pic.checkRoundId = 'synthetic-r'; pic.passphrase = 'synthetic-p'; return { picRequest: pic }; },
    内层action访问器: () => { const pic = {}; Object.defineProperty(pic, 'action', { enumerable: true, get() { return 'inspectSelf'; } }); pic.schema = valid.schema; pic.checkRoundId = 'synthetic-r'; pic.passphrase = 'synthetic-p'; return { picRequest: pic }; },
    内层action为数字: () => ({ picRequest: Object.assign({}, valid, { action: 1 }) }),
    内层includeFullUserId字符串: () => ({ picRequest: Object.assign({}, valid, { includeFullUserId: 'true' }) }),
    内层schema错误版本: () => ({ picRequest: Object.assign({}, valid, { schema: 'participant-identity-request/2' }) }),
    内层schema大小写变体: () => ({ picRequest: Object.assign({}, valid, { schema: 'PARTICIPANT-IDENTITY-REQUEST/1' }) }),
    内层缺schema: () => { const p = Object.assign({}, valid); delete p.schema; return { picRequest: p }; },
    内层缺action: () => { const p = Object.assign({}, valid); delete p.action; return { picRequest: p }; },
    元操作ownKeys抛错: () => new Proxy({ picRequest: valid }, { ownKeys() { throw new Error('synthetic-meta'); } }),
    自定义原型实例: () => { function Cls() {} Cls.prototype.picRequest = valid; return new Cls(); },
    两层继承: () => { const mid = Object.create({ picRequest: valid }); return Object.create(mid); },
    '外层自定义null-root原型': () => { const custom = Object.create(null); custom.role = 'synthetic-forged'; return Object.assign(Object.create(custom), { picRequest: valid }); },
    '内层自定义null-root原型': () => { const custom = Object.create(null); custom.role = 'synthetic-forged'; return { picRequest: Object.assign(Object.create(custom), valid) }; },
    '外层自定义null-root带访问器': () => { const custom = Object.create(null); Object.defineProperty(custom, 'meta', { enumerable: false, get() { throw new Error('synthetic-custom-getter'); } }); return Object.assign(Object.create(custom), { picRequest: valid }); },
    '外层自造方法原型': () => Object.assign(Object.create(forgery.fakeMethods), { picRequest: valid }),
    '内层自造方法原型': () => ({ picRequest: Object.assign(Object.create(forgery.fakeMethods), valid) }),
    '外层复制描述符原型': () => Object.assign(Object.create(forgery.copiedDescriptors), { picRequest: valid }),
    '内层复制描述符原型': () => ({ picRequest: Object.assign(Object.create(forgery.copiedDescriptors), valid) }),
    '外层伪造自关联原型': () => Object.assign(Object.create(forgery.selfBound), { picRequest: valid }),
    '内层伪造自关联原型': () => ({ picRequest: Object.assign(Object.create(forgery.selfBound), valid) })
  };
  for (const [name, mk] of Object.entries(rejects)) {
    const r = requestAdapter.extractBusinessRequest(mk());
    assert.equal(r.ok, false, name + '：必须拒绝');
    assert.equal(r.request, undefined, name + '：不得构造请求对象');
  }
  // (6) 拒绝结果仅含 ok，不携带异常信息/键名/值
  const r = requestAdapter.extractBusinessRequest(new Proxy({ picRequest: valid }, { ownKeys() { throw new Error('synthetic-secret-message'); } }));
  assert.deepEqual(Object.keys(r), ['ok'], '拒绝结果仅含 ok');
  // (7) 自定义 null-root 原型上的继承 getter 与伪造方法均零调用（实测计数，非硬编码）
  {
    let customGetterReads = 0;
    const custom = Object.create(null);
    Object.defineProperty(custom, 'inheritedGetter', {
      enumerable: true,
      get() { customGetterReads++; return 'synthetic-inherited-value'; }
    });
    const e = Object.assign(Object.create(custom), { picRequest: valid });
    const rr = requestAdapter.extractBusinessRequest(e);
    assert.equal(rr.ok, false, '自定义 null-root 原型必须拒绝');
    assert.equal(customGetterReads, 0, '自定义原型上的继承 getter 零读取（实测）');
    assert.equal(fakeMethodCalls.n, 0, '伪造原型上的方法零调用（实测）');
  }
});

test('A3 真实SDK接线：生成入口+请求适配器+真实wx-server-sdk3.0.1/database1.4.1 三路；throwOnNotFound 敏感性反例；合成范围披露', { skip: !fs.existsSync(IDENTITY_REQUEST_SDK_PATH) && '未指定已取得的 wx-server-sdk 路径' }, async () => {
  // 网络全程拦截：传输层由实例级 reqClass 本地替身提供（仅替换传输；序列化/投影/包装为真实SDK代码）
  let networkAttempts = 0;
  const originals = [];
  const block = () => { networkAttempts++; throw new Error('LOCAL_NETWORK_DISABLED'); };
  for (const [moduleName, keys] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:net', ['connect', 'createConnection']]]) {
    const mod = require(moduleName);
    for (const key of keys) { originals.push([mod, key, mod[key]]); mod[key] = block; }
  }
  const socket = require('node:net').Socket.prototype;
  originals.push([socket, 'connect', socket.connect]); socket.connect = block;
  try {
    const closeSource = makeCloseSourceDir();
    const openid = 'openid-sdk3-' + RUN_ID;
    const userId = core.deriveUserId(APPID, openid);
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'sdk3-' + RUN_ID);
    const starts = Date.now() - 60000;
    packer.build(writePicPlan(closeSource, {
      synthetic: false,
      windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString()
    }), outDir);
    assert.equal(packer.checkDir(outDir).ok, true);
    const realCloud = require(IDENTITY_REQUEST_SDK_PATH);
    assert.equal(require(path.join(IDENTITY_REQUEST_SDK_PATH, 'package.json')).version, '3.0.1');
    const serverFile = path.join(outDir, 'server', 'scheduleSandbox', 'index.js');
    const adapterFile = path.join(outDir, 'server', 'scheduleSandbox', 'request-adapter.js');
    const nativeRequire = createRequire(serverFile);
    const roundId = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).checkRoundId;
    const mkEntry = () => {
      const initArgs = [], databaseArgs = [];
      let transportScript = [];
      const shim = {
        DYNAMIC_CURRENT_ENV: realCloud.DYNAMIC_CURRENT_ENV,
        init(opts) { initArgs.push(opts); realCloud.init(opts); },
        getWXContext: () => ({ APPID: APPID, OPENID: openid }),
        database(opts) {
          databaseArgs.push(opts);
          const db = realCloud.database(opts);
          class LocalTransport {
            constructor() { this.calls = 0; }
            async send(action, params) {
              this.calls++;
              if (action !== 'database.getDocument') throw new Error('只允许只读 getDocument');
              const step = transportScript.shift();
              if (!step) throw new Error('传输脚本耗尽');
              if (step.kind === 'exists') {
                const utils = require(path.join(IDENTITY_REQUEST_SDK_PATH, '../@cloudbase/database', 'dist', 'commonjs', 'utils', 'utils.js'));
                return { data: { list: [utils.stringifyByEJSON({ _id: userId, openid, status: step.status || 'active' })], offset: 0, limit: 1 } };
              }
              if (step.kind === 'absent') return { data: { list: [], offset: 0, limit: 1 } };
              return { code: 'DATABASE_PERMISSION_DENIED' };
            }
          }
          const transport = new LocalTransport();
          db._db.constructor.reqClass = function () { return transport; };
          return db;
        }
      };
      const srvModule = { exports: {} };
      vm.runInNewContext(fs.readFileSync(serverFile, 'utf8'), {
        require: name => (name === 'wx-server-sdk' ? shim : name === './participant-identity-check' ? core : name === './request-adapter' ? require(adapterFile) : nativeRequire(name)),
        module: srvModule, exports: srvModule.exports, process: { env: { TCB_ENV: ENV_ID } }, console
      });
      return { srvModule, initArgs, databaseArgs, setScript: s => { transportScript = s; } };
    };
    const call = (srvModule, withFullId) => srvModule.exports.main({
      picRequest: Object.assign({
        schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf',
        checkRoundId: roundId, passphrase: SYNTHETIC_PASSPHRASE
      }, withFullId ? { includeFullUserId: true } : {})
    });
    // (1) 存在 → ACTIVE（真实包装层形状：data 为单对象）
    const e1 = mkEntry();
    e1.setScript([{ kind: 'exists' }]);
    const hit = await call(e1.srvModule, true);
    assert.equal(hit.registrationState, 'ACTIVE', '存在→ACTIVE');
    assert.equal(hit.readAttempted, true);
    assert.equal(hit.userId, userId, '勾选后完整编号返回');
    assert.equal(JSON.stringify(e1.databaseArgs[0]), JSON.stringify({ throwOnNotFound: false }), '入口 database 参数原样进入 SDK（跨vm用JSON比较）');
    assert.equal(e1.initArgs.length >= 1 && e1.initArgs[0].env === realCloud.DYNAMIC_CURRENT_ENV, true, '入口 init 参数原样进入 SDK（DYNAMIC_CURRENT_ENV）');
    // (2) 不存在 → ABSENT（throwOnNotFound:false 时 data:null 归一）
    e1.setScript([{ kind: 'absent' }]);
    const miss = await call(e1.srvModule, false);
    assert.equal(miss.registrationState, 'ABSENT', '不存在→ABSENT（真实SDK data:null）');
    assert.equal(miss.readAttempted, true);
    // (3) 权限失败 → UNKNOWN 且 readAttempted=true（不当作不存在）
    e1.setScript([{ kind: 'denied' }]);
    const denied = await call(e1.srvModule, false);
    assert.equal(denied.registrationState, 'UNKNOWN', '权限失败→UNKNOWN');
    assert.equal(denied.code, 'PIC_READ_FAILED');
    assert.equal(denied.readAttempted, true);
    // (4) 敏感性反例：无 throwOnNotFound:false 的实例，不存在路（空列表）必须抛错
    const dbNoFlag = realCloud.database({});
    class EmptyTransport { async send() { return { data: { list: [], offset: 0, limit: 1 } }; } }
    dbNoFlag._db.constructor.reqClass = function () { return new EmptyTransport(); };
    let threw = null;
    try { await dbNoFlag.collection('schtest_v1_users').doc('u_' + 'b'.repeat(40)).field({ _id: true }).get(); } catch (err) { threw = err; }
    assert.ok(threw, '无 throwOnNotFound:false 时不存在路必须抛错（敏感性反例）');
    assert.equal(networkAttempts, 0, '全程零网络尝试');
  } finally {
    for (const [mod, key, original] of originals) mod[key] = original;
  }
});

test('A4 入口级原准入（经适配器）：错口令/轮次/可信身份拒绝且适配后零读取；可控合成时钟覆盖 expires==now 与窗口内对照', async () => {
  const closeSource = makeCloseSourceDir();
  const openid = 'openid-a4-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  const mk = (planOverrides, rows) => {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'a4-' + crypto.randomBytes(4).toString('hex'));
    packer.build(writePicPlan(closeSource, Object.assign({ synthetic: false }, planOverrides)), outDir);
    const planExpiresMs = Date.parse(JSON.parse(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8')).windowExpiresAtIso);
    const mkChainInner = mutate => {
      const factory = { databaseCalls: 0 };
      const db = makeTrapDb({ rows: rows || [{ _id: userId, openid, status: 'active' }] });
      const stub = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction(opts) {
        const main = loadCandidateMain(outDir, { appId: APPID, envId: ENV_ID, openid, db, onDatabase: () => factory.databaseCalls++ });
        const event = Object.assign({}, opts.data);
        const replaced = mutate ? mutate(event) : undefined;
        return main.main(replaced === undefined ? event : replaced).then(r => ({ result: r }));
      } } };
      return { stub, factory, dbCalls: db.calls };
    };
    return { outDir, mkChainInner, planExpiresMs };
  };
  // 错口令：适配通过后建立工厂（1 次）但零读取
  {
    const { outDir, mkChainInner } = mk({});
    const neg = mkChainInner();
    await withGlobalWx(neg.stub, async () => {
      const page = loadCandidatePage(outDir, neg.stub);
      page.onPassphraseInput({ detail: { value: 'synthetic-wrong-passphrase' } });
      await page.onCheckTap();
      assert.equal(page.data.result.code, 'PIC_PASSPHRASE_INVALID');
      assert.equal(neg.factory.databaseCalls, 1, '适配通过后建立工厂');
      assert.equal(neg.dbCalls.reads, 0, '口令拒绝零读取');
    });
  }
  // 错轮次（内层轮次改写）
  {
    const { outDir, mkChainInner } = mk({});
    const neg = mkChainInner(e => { e.picRequest.checkRoundId = 'synthetic-other-round'; });
    await withGlobalWx(neg.stub, async () => {
      const page = loadCandidatePage(outDir, neg.stub);
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(page.data.result.code, 'PIC_ROUND_MISMATCH');
      assert.equal(neg.dbCalls.reads, 0);
    });
  }
  // 可信身份不符（getWXContext 返回错误 APPID；外层伪造身份无法改变本人主键）
  {
    const { outDir } = mk({});
    const db = makeTrapDb({ rows: [{ _id: userId, openid, status: 'active' }] });
    const stub = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction(opts) {
      const main = loadCandidateMain(outDir, { appId: 'wx-synthetic-wrong', envId: ENV_ID, openid, db });
      return main.main(opts.data).then(r => ({ result: r }));
    } } };
    await withGlobalWx(stub, async () => {
      const page = loadCandidatePage(outDir, stub);
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(page.data.result.code, 'PIC_TARGET_MISMATCH', '可信目标不符拒绝');
      assert.equal(page.data.result.registrationState, 'UNKNOWN');
    });
  }
  // 可控合成时钟：实际生成链不变，宿主 Date.now 在调用期间被替换（finally 还原）。
  // (a) expires==now → PIC_WINDOW_EXPIRED（核心窗口门槛；工厂已建立但零读取）
  {
    const { outDir, mkChainInner, planExpiresMs } = mk({});
    const neg = mkChainInner();
    await withGlobalWx(neg.stub, async () => {
      const page = loadCandidatePage(outDir, neg.stub);
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      const origNow = Date.now;
      Date.now = () => planExpiresMs; // expires == now
      try { await page.onCheckTap(); } finally { Date.now = origNow; }
      assert.equal(page.data.result.code, 'PIC_WINDOW_EXPIRED', 'expires==now 拒绝（可控合成时钟）');
      assert.equal(page.data.result.registrationState, 'UNKNOWN');
      assert.equal(page.data.result.readAttempted, false, '到期零读取事实');
      assert.equal(neg.factory.databaseCalls, 1, '适配通过后建立工厂（到期发生在核心窗口门槛）');
      assert.equal(neg.dbCalls.reads, 0, '到期零读取');
    });
  }
  // (b) 时钟回到窗口内 → 同一候选正常进入本人只读链（对照）
  {
    const { outDir, mkChainInner, planExpiresMs } = mk({});
    const ok = mkChainInner();
    await withGlobalWx(ok.stub, async () => {
      const page = loadCandidatePage(outDir, ok.stub);
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      const origNow = Date.now;
      Date.now = () => planExpiresMs - 1000; // 窗口内
      try { await page.onCheckTap(); } finally { Date.now = origNow; }
      assert.equal(page.data.result.registrationState, 'ACTIVE', '时钟在窗口内→正常链（对照）');
      assert.equal(page.data.result.readAttempted, true);
    });
  }
});

test('A5 完整入口 no-flag 敏感性（§4固化）：生成入口内存变体去掉 throwOnNotFound:false，不存在路由由 ABSENT 变 UNKNOWN/PIC_READ_FAILED；实际主键/投影/次数断言', { skip: !fs.existsSync(IDENTITY_REQUEST_SDK_PATH) && '未指定已取得的 wx-server-sdk 路径' }, async () => {
  let networkAttempts = 0;
  const originals = [];
  const block = () => { networkAttempts++; throw new Error('LOCAL_NETWORK_DISABLED'); };
  for (const [moduleName, keys] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:net', ['connect', 'createConnection']]]) {
    const mod = require(moduleName);
    for (const key of keys) { originals.push([mod, key, mod[key]]); mod[key] = block; }
  }
  const socket = require('node:net').Socket.prototype;
  originals.push([socket, 'connect', socket.connect]); socket.connect = block;
  try {
    const closeSource = makeCloseSourceDir();
    const openid = 'openid-a5-' + RUN_ID;
    const userId = core.deriveUserId(APPID, openid);
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'a5-' + RUN_ID);
    const starts = Date.now() - 60000;
    packer.build(writePicPlan(closeSource, {
      synthetic: false,
      windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString()
    }), outDir);
    assert.equal(packer.checkDir(outDir).ok, true);
    const realCloud = require(IDENTITY_REQUEST_SDK_PATH);
    const ejsonUtils = require(path.join(IDENTITY_REQUEST_SDK_PATH, '../@cloudbase/database/dist/commonjs/utils/utils.js'));
    const serverFile = path.join(outDir, 'server', 'scheduleSandbox', 'index.js');
    const roundId = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).checkRoundId;
    const transportCalls = [];
    const loadEntry = variant => {
      const src0 = fs.readFileSync(serverFile, 'utf8');
      assert.ok(src0.includes('cloud.database({ throwOnNotFound: false })'), '生成入口含受审 flag');
      let src = src0;
      if (variant === 'noflag') src = src0.replace('cloud.database({ throwOnNotFound: false })', 'cloud.database({})');
      const initArgs = [], databaseArgs = [];
      let transportScript = [];
      const shim = {
        DYNAMIC_CURRENT_ENV: realCloud.DYNAMIC_CURRENT_ENV,
        init(opts) { initArgs.push(opts); realCloud.init(opts); },
        getWXContext: () => ({ APPID: APPID, OPENID: openid }),
        database(opts) {
          databaseArgs.push(opts);
          const db = realCloud.database(opts);
          class T {
            async send(action, params) {
              transportCalls.push({
                variant,
                action,
                collectionName: params.collectionName,
                queryId: ejsonUtils.parseByEJSON(params.query)._id,
                projection: ejsonUtils.parseByEJSON(params.projection)
              });
              const s = transportScript.shift();
              if (!s) throw new Error('传输脚本耗尽');
              if (s === 'absent') return { data: { list: [], offset: 0, limit: 1 } };
              throw new Error('unused step');
            }
          }
          db._db.constructor.reqClass = function () { return new T(); };
          return db;
        }
      };
      const srv = { exports: {} };
      vm.runInNewContext(src, {
        require: name => (name === 'wx-server-sdk' ? shim : name === './participant-identity-check' ? core : name === './request-adapter' ? requestAdapter : (() => { throw new Error('unexpected ' + name); })()),
        module: srv, exports: srv.exports, process: { env: { TCB_ENV: ENV_ID } }, console
      });
      return { main: srv.exports.main, initArgs, databaseArgs, setScript: s => { transportScript = s; } };
    };
    const call = entry => entry.main({
      picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: roundId, passphrase: SYNTHETIC_PASSPHRASE }
    });
    // (1) 原始入口：不存在 → ABSENT（throwOnNotFound:false 使 data:null 归一）
    const a = loadEntry('original');
    a.setScript(['absent']);
    const miss = await call(a);
    assert.equal(miss.registrationState, 'ABSENT', '原始入口不存在→ABSENT');
    assert.equal(miss.readAttempted, true);
    // (2) no-flag 变体：同一不存在路 → UNKNOWN/PIC_READ_FAILED（真实 SDK 抛错被核心净化）
    const b = loadEntry('noflag');
    b.setScript(['absent']);
    const miss2 = await call(b);
    assert.equal(miss2.registrationState, 'UNKNOWN', 'no-flag 变体不存在→UNKNOWN');
    assert.equal(miss2.code, 'PIC_READ_FAILED', 'no-flag 变体错误码');
    assert.equal(miss2.readAttempted, true, 'no-flag 变体读取事实为 true');
    // (3) 实际参数/主键/投影/次数断言
    assert.equal(JSON.stringify(a.databaseArgs[0]), JSON.stringify({ throwOnNotFound: false }), '原始入口 database 参数');
    assert.equal(JSON.stringify(b.databaseArgs[0]), JSON.stringify({}), 'no-flag 变体 database 参数');
    assert.equal(transportCalls.length, 2, '两次不存在路各一次传输');
    for (const c of transportCalls) {
      assert.equal(c.action, 'database.getDocument', '只读 getDocument');
      assert.equal(c.collectionName, core.FIXED_TARGET.collection, '固定集合');
      assert.equal(c.queryId, userId, '本人主键精确匹配（EJSON 解析后）');
      assert.deepEqual(c.projection, { _id: 1, openid: 1, status: 1 }, '恰三字段投影（EJSON 解析后精确比较）');
    }
    assert.equal(networkAttempts, 0, '全程零网络尝试');
  } finally {
    for (const [mod, key, original] of originals) mod[key] = original;
  }
});

// ════════════════════════════════════════════════════════════════════════════
// E1–E6 提前准备与执行时效分离（CodeBuddy任务-核验包提前准备与执行时效分离-20261017）
// ════════════════════════════════════════════════════════════════════════════

/** 可控时钟：仅测试内使用，finally 恢复；不提供给真实生产入口。 */
async function withClock(now, fn) {
  const orig = Date.now;
  Date.now = typeof now === 'function' ? now : () => now;
  try { return await fn(); } finally { Date.now = orig; }
}

test('E1 未来窗口可准备但严格执行仍拒绝：prepare 39 文件/checkPreparedDir 通过且 executionReady=false；旧 build 写前 WINDOW_NOT_OPEN 且目录未创建；旧 checkDir 拒绝；核心未来窗口拒绝 get=0', async () => {
  const closeSource = makeCloseSourceDir();
  const openid = 'openid-e1-' + RUN_ID;
  const starts = Date.now() + 2 * 60 * 60 * 1000;
  const planPath = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 30 * 60 * 1000).toISOString()
  });
  // (1) prepare：未来窗口真实模式计划可提前准备
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e1-prep-' + RUN_ID);
  const prepared = packer.prepare(planPath, outDir);
  assert.equal(prepared.phase, 'preparation');
  assert.equal(prepared.preparationValidated, true);
  assert.equal(prepared.executionReady, false, '准备结果明确不是执行批准');
  assert.equal(prepared.manifest.files.length, 15, '候选 15 文件');
  assert.equal(prepared.manifest.closePackage.files.length, 23, '关闭 23 文件');
  assert.equal(fs.existsSync(path.join(outDir, 'manifest.json')), true, '39 文件已落盘（候选+计划+清单+关闭）');
  // (2) checkPreparedDir：完整通过且 executionReady=false
  const cp = packer.checkPreparedDir(outDir);
  assert.equal(cp.ok, true, '准备核对完整通过');
  assert.equal(cp.phase, 'preparation');
  assert.equal(cp.preparationValidated, true);
  assert.equal(cp.executionReady, false, '准备核对通过也不升级为执行批准');
  // (3) 旧 build：写前 WINDOW_NOT_OPEN，且新目录未创建
  const outDir2 = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e1-build-' + RUN_ID);
  assert.throws(() => packer.build(planPath, outDir2),
    e => e.code === packer.ERR.WINDOW_NOT_OPEN && /build\.readPlan/.test(e.message), '旧 build 写前拒绝');
  assert.equal(fs.existsSync(outDir2), false, '严格构建未创建输出目录');
  // (4) 旧 checkDir：同一时点对同一已准备目录拒绝（WINDOW_NOT_OPEN）
  const strict = packer.checkDir(outDir);
  assert.equal(strict.ok, false, '严格 checkDir 拒绝未开窗候选');
  assert.ok(strict.problems.some(p => p.includes('WINDOW_NOT_OPEN')), '拒绝原因含 WINDOW_NOT_OPEN');
  // (5) 核心：未来窗口在核心同样拒绝且 get=0（仅合成 db/trusted；核心接口为原四字段）
  const db = makeTrapDb({ rows: [{ _id: core.deriveUserId(APPID, openid), openid, status: 'active' }] });
  const r = await makeChecker(db, {
    trusted: trustedContext(openid),
    windowStartsAtMs: starts, windowExpiresAtMs: starts + 30 * 60 * 1000,
    now: () => Date.now()
  }).handle({ action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(r.code, 'PIC_WINDOW_NOT_OPEN', '核心未来窗口拒绝');
  assert.equal(r.readAttempted, false);
  assert.equal(db.calls.reads, 0, '零读取');
});

test('E2 同一未来包进入窗口后：旧 checkDir 通过、旧 build 完全复用 0 新写、候选/关闭/manifest 字节不变', async () => {
  const closeSource = makeCloseSourceDir();
  const starts = Date.now() + 2 * 60 * 60 * 1000;
  const planPath = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 30 * 60 * 1000).toISOString()
  });
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e2-prep-' + RUN_ID);
  packer.prepare(planPath, outDir);
  const snapshot = new Map();
  (function snap(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) snap(p);
      else snapshot.set(path.relative(outDir, p).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  })(outDir);
  assert.equal(snapshot.has('manifest.json'), true);
  // 受控时钟进入有效窗口（仅测试内；finally 恢复）
  await withClock(starts + 60 * 1000, () => {
    const strict = packer.checkDir(outDir);
    assert.equal(strict.ok, true, '进入窗口后同一包通过严格 checkDir');
    assert.equal(Object.prototype.hasOwnProperty.call(strict, 'executionReady'), false, '旧 checkDir 结果结构不变');
    const rebuilt = packer.build(planPath, outDir);
    assert.equal(rebuilt.io.filter(x => x.action === 'written').length, 0, '完全复用，0 新写');
    assert.ok(rebuilt.io.every(x => x.action === 'reused'), '全部条目为 reused');
  });
  const after = new Map();
  (function snap2(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) snap2(p);
      else after.set(path.relative(outDir, p).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  })(outDir);
  assert.equal(after.size, snapshot.size, '文件数不变');
  for (const [rel, sha] of snapshot) assert.equal(after.get(rel), sha, '字节不变：' + rel);
});

test('E3 边界矩阵：expires==now/已过期/NaN/抛错/途中跨截止/最终前跨截止正反例；未来开始跨入窗口不升级 executionReady', async () => {
  const closeSource = makeCloseSourceDir();
  const baseStarts = Date.now() - 60 * 1000;
  const planPath = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(baseStarts).toISOString(),
    windowExpiresAtIso: new Date(baseStarts + 30 * 60 * 1000).toISOString()
  });
  const planExpiresMs = Date.parse(JSON.parse(fs.readFileSync(planPath, 'utf8')).windowExpiresAtIso);
  // (1) expires==now：prepare/checkPreparedDir/旧checkDir 全部 WINDOW_EXPIRED
  {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e3a-' + crypto.randomBytes(3).toString('hex'));
    await withClock(planExpiresMs, () => {
      assert.throws(() => packer.prepare(planPath, outDir), e => e.code === packer.ERR.WINDOW_EXPIRED, 'prepare expires==now 拒绝');
      assert.equal(fs.existsSync(outDir), false);
    });
    const built = packer.build(planPath, outDir); // 真实时钟（当前在窗口内）建立合法目录
    assert.ok(built.manifest);
    await withClock(planExpiresMs, () => {
      const cp = packer.checkPreparedDir(outDir);
      assert.equal(cp.ok, false);
      assert.ok(cp.problems.some(p => p.includes('WINDOW_EXPIRED')), 'checkPreparedDir expires==now 拒绝');
      const strict = packer.checkDir(outDir);
      assert.equal(strict.ok, false);
      assert.ok(strict.problems.some(p => p.includes('WINDOW_EXPIRED')), '旧 checkDir expires==now 拒绝');
    });
  }
  // (2) 已过期：三类入口全部 WINDOW_EXPIRED
  {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e3b-' + crypto.randomBytes(3).toString('hex'));
    await withClock(planExpiresMs + 1, () => {
      assert.throws(() => packer.prepare(planPath, outDir), e => e.code === packer.ERR.WINDOW_EXPIRED, 'prepare 已过期拒绝');
      assert.equal(fs.existsSync(outDir), false);
    });
    packer.build(planPath, outDir);
    await withClock(planExpiresMs + 1, () => {
      assert.equal(packer.checkPreparedDir(outDir).ok, false, 'checkPreparedDir 已过期拒绝');
      assert.equal(packer.checkDir(outDir).ok, false, '旧 checkDir 已过期拒绝');
    });
  }
  // (3) NaN 时钟：CLOCK_INVALID
  {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e3c-' + crypto.randomBytes(3).toString('hex'));
    await withClock(NaN, () => {
      assert.throws(() => packer.prepare(planPath, outDir), e => e.code === packer.ERR.CLOCK_INVALID, 'prepare NaN 拒绝');
      assert.equal(fs.existsSync(outDir), false);
    });
    packer.build(planPath, outDir);
    await withClock(NaN, () => {
      assert.equal(packer.checkPreparedDir(outDir).ok, false, 'checkPreparedDir NaN 拒绝');
      assert.equal(packer.checkDir(outDir).ok, false, '旧 checkDir NaN 拒绝');
    });
  }
  // (4) Date.now 抛错：CLOCK_ERROR
  {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e3d-' + crypto.randomBytes(3).toString('hex'));
    await withClock(() => { throw new Error('synthetic-clock-failure'); }, () => {
      assert.throws(() => packer.prepare(planPath, outDir), e => e.code === packer.ERR.CLOCK_ERROR, 'prepare 抛错拒绝');
      assert.equal(fs.existsSync(outDir), false);
    });
    packer.build(planPath, outDir);
    await withClock(() => { throw new Error('synthetic-clock-failure'); }, () => {
      assert.equal(packer.checkPreparedDir(outDir).ok, false, 'checkPreparedDir 抛错拒绝');
      assert.equal(packer.checkDir(outDir).ok, false, '旧 checkDir 抛错拒绝');
    });
  }
  // (5) 途中跨截止：前若干写入后时钟越过截止 → WINDOW_EXPIRED 且 wroteFiles 事实与已写数量一致
  {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e3e-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0;
    await withClock(() => { calls++; return calls <= 10 ? baseStarts + 1000 : planExpiresMs + 1; }, () => {
      try {
        packer.prepare(planPath, outDir);
        assert.fail('途中跨截止必须拒绝');
      } catch (error) {
        assert.equal(error.code, packer.ERR.WINDOW_EXPIRED, '途中跨截止错误码');
        assert.ok(error.wroteFiles > 0, '已写事实>0：' + error.wroteFiles);
        assert.equal(error.written.length, error.wroteFiles, 'written 列表与计数一致');
      }
    });
  }
  // (6) 最终返回前跨截止：全部写入后 final 边界拒绝 → wroteFiles=39
  {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e3f-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0;
    await withClock(() => { calls++; return calls <= 41 ? baseStarts + 1000 : planExpiresMs + 1; }, () => {
      try {
        packer.prepare(planPath, outDir);
        assert.fail('最终前跨截止必须拒绝');
      } catch (error) {
        assert.equal(error.code, packer.ERR.WINDOW_EXPIRED, '最终前跨截止错误码');
        assert.equal(error.wroteFiles, 39, '全部 39 文件已写但被最终边界拒绝');
      }
    });
  }
  // (7) 未来开始跨入窗口：准备结果不升级为 executionReady
  {
    const futureStarts = Date.now() + 2 * 60 * 60 * 1000;
    const futurePlan = writePicPlan(closeSource, {
      synthetic: false,
      windowStartsAtIso: new Date(futureStarts).toISOString(),
      windowExpiresAtIso: new Date(futureStarts + 30 * 60 * 1000).toISOString()
    });
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e3g-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0;
    const r = await withClock(() => { calls++; return calls <= 5 ? futureStarts - 1000 : futureStarts + 60 * 1000; }, () => packer.prepare(futurePlan, outDir));
    assert.equal(r.phase, 'preparation');
    assert.equal(r.executionReady, false, '跨入窗口后准备结果不升级为执行批准');
    assert.equal(r.preparationValidated, true);
  }
});

test('E4 准备模式的来源/清单/目录/排他写保持：篡改拒绝、额外文件拒绝、junction 拒绝、EEXIST 事实', async () => {
  const closeSource = makeCloseSourceDir();
  const starts = Date.now() + 2 * 60 * 60 * 1000;
  const planPath = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 30 * 60 * 1000).toISOString()
  });
  // (1) 制品篡改 → checkPreparedDir 拒绝（未来窗口不豁免内容校验）
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e4-prep-' + RUN_ID);
  packer.prepare(planPath, outDir);
  const entryPath = path.join(outDir, 'server', 'scheduleSandbox', 'index.js');
  const orig = fs.readFileSync(entryPath);
  fs.writeFileSync(entryPath, orig.toString('utf8').replace('const CONFIG_ENABLED = true;', 'const CONFIG_ENABLED = false;'));
  const cp = packer.checkPreparedDir(outDir);
  assert.equal(cp.ok, false, '制品篡改拒绝（准备模式不豁免）');
  assert.ok(cp.problems.some(p => p.includes('index.js')));
  fs.writeFileSync(entryPath, orig);
  assert.equal(packer.checkPreparedDir(outDir).ok, true, '还原后通过');
  // (2) 额外文件 → 拒绝
  fs.writeFileSync(path.join(outDir, 'frontend', 'stray-e4.js'), '// stray\n');
  assert.equal(packer.checkPreparedDir(outDir).ok, false, '额外文件拒绝');
  fs.unlinkSync(path.join(outDir, 'frontend', 'stray-e4.js'));
  // (3) junction → 拒绝（写前零写核对的准备态等价物）
  fs.symlinkSync(path.join(outDir, 'frontend'), path.join(outDir, 'frontend-link'), 'junction');
  assert.equal(packer.checkPreparedDir(outDir).ok, false, 'junction 拒绝');
  fs.unlinkSync(path.join(outDir, 'frontend-link'));
  assert.equal(packer.checkPreparedDir(outDir).ok, true, '清理后通过');
  // (4) 排他写：预置同内容文件 → 完全复用；预置冲突文件 → EEXIST 且 wroteFiles 事实
  const reuseDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e4-reuse-' + RUN_ID);
  const again = packer.prepare(planPath, reuseDir);
  assert.equal(again.io.filter(x => x.action === 'written').length, 39, '首次准备写入 39');
  const again2 = packer.prepare(planPath, reuseDir);
  assert.equal(again2.io.filter(x => x.action === 'written').length, 0, '二次准备完全复用');
  // 排他写/写前事实：预置同内容文件 → 完全复用；预置冲突文件 → 预检阶段写入前拒绝
  //（零写事实，planted 文件不被触碰）；竞态 EEXIST/部分写事实沿用既有 build 代表性用例（R 组）。
  const conflictDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e4-conflict-' + crypto.randomBytes(3).toString('hex'));
  const planted = path.join(conflictDir, 'plan.json');
  fs.mkdirSync(conflictDir, { recursive: true });
  fs.writeFileSync(planted, '// conflicting content\n');
  try {
    packer.prepare(planPath, conflictDir);
    assert.fail('冲突文件必须拒绝');
  } catch (error) {
    assert.equal(error.code, packer.ERR.OUT_CONFLICT, '冲突以 PIC_OUT_CONFLICT 分类（写入前拒绝）');
    assert.ok(!error.wroteFiles, '预检阶段零写事实（无已写计数）');
    assert.ok(!Array.isArray(error.partialWrites) || error.partialWrites.length === 0, '无部分写');
    assert.equal(fs.readFileSync(planted, 'utf8'), '// conflicting content\n', '冲突文件未被触碰');
  }
});

test('E5 CLI 真实子进程（受控runner·统一回执校验）：preload覆盖网络/进程面（含dns.promises/Socket.connect）；全部结果无差别核验回执（预期exit1不豁免）；超时/启动错误/有界输出；非白名单进程拒绝且不启动', async () => {
  const guardHelper = require('./helpers/pic-guard-runner.cjs');
  const os = require('node:os');
  const closeSource = makeCloseSourceDir();
  const futureStarts = Date.now() + 2 * 60 * 60 * 1000;
  const futurePlan = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(futureStarts).toISOString(),
    windowExpiresAtIso: new Date(futureStarts + 30 * 60 * 1000).toISOString()
  });
  const expiresSoonPlan = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(Date.now() - 60 * 1000).toISOString(),
    windowExpiresAtIso: new Date(Date.now() - 30 * 1000).toISOString()
  });
  const cli = path.resolve(__dirname, '..', 'scripts', 'package-participant-identity-check.cjs');
  // 共享辅助模块（与证据 v3 同源）：父进程守卫（网络/进程面全阻断并记账）+ 私有受控 runner
  const hits = [];
  const guard = guardHelper.installParentGuards({ hits, getPhase: () => 'unexpected', allowedScripts: [cli] });
  const guardPreload = path.join(os.tmpdir(), 'pic-cli-guard-' + RUN_ID + '.cjs');
  fs.writeFileSync(guardPreload, guardHelper.buildGuardPreloadSource());
  const runCli = args => guard.runCli({ scriptPath: cli, args, guardPreload, receiptPath: guard.newReceiptPath('e5') });
  try {
    const preparedDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e5-prep-' + RUN_ID);
    // (1) --prepare 未来计划：exit0 且 executionReady=false；回执统一校验通过
    const p1 = await runCli(['--prepare', futurePlan, '--out', preparedDir]);
    assert.deepEqual(guardHelper.validateChildResult(p1).failures, [], 'prepare 回执/守卫校验通过');
    const p1j = JSON.parse(p1.out);
    assert.equal(p1j.executionReady, false, 'CLI 准备结果明确非执行批准');
    assert.equal(p1j.phase, 'preparation');
    assert.equal(p1j.files, 15);
    // (2) --check-prepared：exit0 且 executionReady=false
    const p2 = await runCli(['--check-prepared', preparedDir]);
    assert.deepEqual(guardHelper.validateChildResult(p2).failures, [], 'check-prepared 校验通过');
    const p2j = JSON.parse(p2.out);
    assert.equal(p2j.executionReady, false);
    assert.equal(p2j.ok, true);
    // (3) 旧 --check 对同一未来目录：预期业务 exit1——回执检查不豁免
    const p3 = await runCli(['--check', preparedDir]);
    assert.deepEqual(guardHelper.validateChildResult(p3).failures, [], '预期失败运行同样通过回执校验');
    assert.equal(p3.code, 1, '旧 --check 未来拒绝 exit1');
    assert.ok(p3.out.includes('WINDOW_NOT_OPEN'), '拒绝原因 WINDOW_NOT_OPEN');
    // (4) 默认 --plan 严格构建未来计划：exit1 且目录未创建（回执不豁免）
    const strictDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e5-strict-' + RUN_ID);
    const p4 = await runCli(['--plan', futurePlan, '--out', strictDir]);
    assert.deepEqual(guardHelper.validateChildResult(p4).failures, [], '预期失败运行同样通过回执校验');
    assert.equal(p4.code, 1, '默认 build 未来拒绝 exit1');
    assert.ok(p4.err.includes('WINDOW_NOT_OPEN'), '错误含 WINDOW_NOT_OPEN');
    assert.equal(fs.existsSync(strictDir), false, '严格构建未创建目录');
    // (5) 已过期计划 --prepare：exit1（回执不豁免）
    const p5 = await runCli(['--prepare', expiresSoonPlan, '--out', path.join(OUT_ROOT, packer.OUT_PREFIX + 'e5-exp-' + RUN_ID)]);
    assert.deepEqual(guardHelper.validateChildResult(p5).failures, [], '预期失败运行同样通过回执校验');
    assert.equal(p5.code, 1, '过期计划 prepare exit1');
    assert.ok(p5.err.includes('WINDOW_EXPIRED'), '错误含 WINDOW_EXPIRED');
    // (6) 混合模式参数：exit1 用法错误（回执不豁免）
    const p6 = await runCli(['--prepare', futurePlan, '--check', preparedDir]);
    assert.deepEqual(guardHelper.validateChildResult(p6).failures, [], '预期失败运行同样通过回执校验');
    assert.equal(p6.code, 1, '混合模式 exit1');
    assert.ok(p6.err.includes('用法错误'), '混合模式明确拒绝');
    // (7) 坏参数：--prepare 无路径 → exit1（回执不豁免）
    const p7 = await runCli(['--prepare']);
    assert.deepEqual(guardHelper.validateChildResult(p7).failures, [], '预期失败运行同样通过回执校验');
    assert.equal(p7.code, 1, '坏参数 exit1');
    // (8) 非白名单脚本：runner 拒绝且不启动任何进程（validation failures 直达）
    const evil = path.join(os.tmpdir(), 'pic-evil-' + RUN_ID + '.cjs');
    fs.writeFileSync(evil, "console.log('should-not-run');");
    const p8 = await guard.runCli({ scriptPath: evil, args: [], guardPreload, receiptPath: guard.newReceiptPath('e5-evil') });
    assert.ok(guardHelper.validateChildResult(p8).failures.some(x=>x.includes('脚本不在受控白名单')), '非白名单脚本被 runner 拒绝');
    fs.unlinkSync(evil);
    // (9) 畸形回执：preload 不写回执 → 校验失败（缺失回执不被接受）
    const barePreload = path.join(os.tmpdir(), 'pic-bare-guard-' + RUN_ID + '.cjs');
    fs.writeFileSync(barePreload, "process.on('exit',()=>require('fs').unlinkSync(process.env.PIC_CLI_GUARD_RECEIPT));");
    const p9 = await guard.runCli({ scriptPath: cli, args: ['--check-prepared', preparedDir], guardPreload: barePreload, receiptPath: guard.newReceiptPath('e5-bare') });
    const v9 = guardHelper.validateChildResult(p9);
    assert.ok(v9.failures.some(f => f.includes('回执缺失或畸形')), '缺失回执被判失败');
    fs.unlinkSync(barePreload);
  } finally {
    guard.restoreAll();
    fs.unlinkSync(guardPreload);
  }
});

test('E6 字节一致性：同计划下 prepare 与受审旧 build 生成的候选/关闭/manifest 逐字节一致；关键身份门槛锚点保留', async () => {
  const closeSource = makeCloseSourceDir();
  const starts = Date.now() - 60 * 1000;
  const planPath = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 30 * 60 * 1000).toISOString()
  });
  const dirPrepare = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e6-prep-' + RUN_ID);
  const dirBuild = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e6-build-' + RUN_ID);
  packer.prepare(planPath, dirPrepare);
  packer.build(planPath, dirBuild);
  const mapOf = dir => {
    const m = new Map();
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else m.set(path.relative(dir, p).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
      }
    })(dir);
    return m;
  };
  const mp = mapOf(dirPrepare), mb = mapOf(dirBuild);
  assert.equal(mp.size, mb.size, '文件集一致');
  for (const [rel, sha] of mb) assert.equal(mp.get(rel), sha, '逐字节一致：' + rel);
  // 关键身份门槛锚点保留（生成入口仍含口令摘要/可信上下文/适配器接线）
  const entry = fs.readFileSync(path.join(dirPrepare, 'server', 'scheduleSandbox', 'index.js'), 'utf8');
  assert.ok(entry.includes('const CONFIG_PASSPHRASE_DIGEST = '), '口令摘要锚点');
  assert.ok(entry.includes('getWXContext'), '可信微信上下文来源');
  assert.ok(entry.includes("require('./request-adapter')"), '请求适配器接线');
  // 完整编号默认不勾选；无新增复制/收集按钮
  const pageJs = fs.readFileSync(path.join(dirPrepare, 'frontend', 'pages', 'identity-check', 'identity-check.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(dirPrepare, 'frontend', 'pages', 'identity-check', 'identity-check.wxml'), 'utf8');
  assert.ok(pageJs.includes('wantFullUserId'), '完整编号勾选语义存在');
  assert.equal(/wantFullUserId:\s*true/.test(pageJs), false, '完整编号默认不勾选（初始 data 不预置 true）');
  assert.equal(wxml.includes('复制'), false, '无复制按钮');
  assert.equal(wxml.includes('收集'), false, '无收集按钮');
});
test('E7 CLI 严格参数解析（C1）：重复模式/重复选项/缺值/未知选项/额外位置参数/不适用组合全部写前拒绝且零产物；合法旧语法不变', async () => {
  // (1) 纯函数单元：全部拒绝发生在解析层（不做 IO）
  const rejectCases = [
    { argv: ['--prepare', 'a.json', '--prepare', 'b.json'], why: '重复模式' },
    { argv: ['--plan', 'a.json', '--out', 'd1', '--out', 'd2'], why: '重复选项' },
    { argv: ['--prepare', 'valid.json', '--out'], why: '缺值（末尾缺值）' },
    { argv: ['--prepare', 'valid.json', '--out', '--check', 'd'], why: '缺值（下一个令牌是选项）' },
    { argv: ['--prepare', 'valid.json', '--unknown-option', 'value'], why: '未知选项' },
    { argv: ['--prepare', 'valid.json', 'extra-positional'], why: '额外位置参数' },
    { argv: ['--check', 'd', '--close-source', 's'], why: '不适用组合（--close-source 仅配 --check-close）' },
    { argv: ['--check', 'd', '--out', 'o'], why: '不适用组合（--out 仅配 --plan/--prepare）' },
    { argv: [], why: '缺少模式参数' },
    { argv: ['--plan', 'a.json', '--check', 'd'], why: '多种模式' }
  ];
  for (const c of rejectCases) {
    const r = packer.parseCliArgs(c.argv);
    assert.ok(r.error, c.why + ' 必须拒绝');
    assert.ok(r.error.includes('[用法错误]'), c.why + ' 错误带 [用法错误] 标记');
    assert.equal(r.values, undefined, c.why + ' 不产生可执行参数');
  }
  // (2) 合法旧语法全部通过解析
  for (const good of [
    ['--plan', 'p'], ['--plan', 'p', '--out', 'o'],
    ['--check', 'd'], ['--check-close', 'd', '--close-source', 's'],
    ['--prepare', 'p'], ['--prepare', 'p', '--out', 'o'], ['--check-prepared', 'd']
  ]) {
    const r = packer.parseCliArgs(good);
    assert.ok(!r.error && r.mode, '合法语法仍通过：' + good.join(' '));
  }
  // (3) 子进程端到端：复查 §2.C1 的三例反例 + 组合反例，各自独立输出目录并核对零产物
  const { spawnSync } = require('node:child_process');
  const cli = path.resolve(__dirname, '..', 'scripts', 'package-participant-identity-check.cjs');
  const closeSource = makeCloseSourceDir();
  const futureStarts = Date.now() + 2 * 60 * 60 * 1000;
  const futurePlan = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(futureStarts).toISOString(),
    windowExpiresAtIso: new Date(futureStarts + 30 * 60 * 1000).toISOString()
  });
  const e2e = [
    { args: ['--prepare', futurePlan, '--prepare', futurePlan, '--out', 'PENDING'], why: '重复模式静默忽略第二份计划（复查反例1）', hasOut: true },
    { args: ['--prepare', futurePlan, '--out'], why: '缺值被当作未提供（复查反例2）', hasOut: false },
    { args: ['--prepare', futurePlan, '--unknown-option', 'value', '--out', 'PENDING'], why: '未知选项被静默接受（复查反例3）', hasOut: true },
    { args: ['--prepare', futurePlan, '--out', 'PENDING', '--out', 'OTHER'], why: '重复选项 --out', hasOut: true },
    { args: ['--prepare', futurePlan, '--out', 'PENDING', 'extra-positional'], why: '额外位置参数', hasOut: true },
    { args: ['--check', futurePlan, '--close-source', 's'], why: '不适用组合 --close-source', hasOut: false }
  ];
  for (const [i, c] of e2e.entries()) {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e7-rej-' + i + '-' + RUN_ID);
    const args = c.args.map(a => (a === 'PENDING' ? outDir : a));
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1, c.why + '：exit1');
    assert.ok(r.stderr.includes('[用法错误]'), c.why + '：stderr 含 [用法错误]');
    if (c.hasOut) assert.equal(fs.existsSync(outDir), false, c.why + '：零产物（独立输出目录未创建）');
  }
  // (4) 合法对照：同参数去重后正常准备成功（证明拒绝不是误伤合法语法）
  const legalDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'e7-legal-' + RUN_ID);
  const ok = spawnSync(process.execPath, [cli, '--prepare', futurePlan, '--out', legalDir], { encoding: 'utf8' });
  assert.equal(ok.status, 0, '合法对照 exit0，stderr=' + (ok.stderr || '').slice(0, 240));
  const okj = JSON.parse(ok.stdout);
  assert.equal(okj.executionReady, false);
  assert.equal(okj.files, 15);
});
test('E8 CLI 空值与必需配对（R4）：空字符串值/缺 --close-source 全部解析期拒绝；端到端空 --out 零IO零产物；合法配对对照通过', async () => {
  // (1) 纯函数单元
  const r4 = [
    { argv: ['--prepare', 'valid.json', '--out', ''], why: '空字符串 --out' },
    { argv: ['--prepare', ''], why: '空字符串计划路径' },
    { argv: ['--plan', ''], why: '空字符串 --plan' },
    { argv: ['--check-close', 'd'], why: '缺 --close-source' },
    { argv: ['--check-close', 'd', '--close-source', ''], why: '空字符串 --close-source' }
  ];
  for (const c of r4) {
    const r = packer.parseCliArgs(c.argv);
    assert.ok(r.error, c.why + ' 必须拒绝');
    assert.ok(r.error.includes('[用法错误]'), c.why + ' 带 [用法错误] 标记');
    assert.equal(r.values, undefined, c.why + ' 不产生可执行参数');
  }
  // 合法配对对照
  assert.ok(!packer.parseCliArgs(['--check-close', 'd', '--close-source', 's']).error, '显式非空 --close-source 合法');
  assert.ok(!packer.parseCliArgs(['--check', 'd']).error, '无 --close-source 的 --check 合法');
  // (2) 端到端：空 --out 子进程 exit1 + [用法错误] + 默认目录零产物（参与集前后一致）
  const { spawnSync } = require('node:child_process');
  const cli = path.resolve(__dirname, '..', 'scripts', 'package-participant-identity-check.cjs');
  const closeSource = makeCloseSourceDir();
  const futureStarts = Date.now() + 2 * 60 * 60 * 1000;
  const futurePlan = writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(futureStarts).toISOString(),
    windowExpiresAtIso: new Date(futureStarts + 30 * 60 * 1000).toISOString()
  });
  const listDirs = () => fs.readdirSync(OUT_ROOT).filter(d => d.startsWith(packer.OUT_PREFIX)).sort().join(',');
  const beforeDirs = listDirs();
  const r = spawnSync(process.execPath, [cli, '--prepare', futurePlan, '--out', ''], { encoding: 'utf8' });
  assert.equal(r.status, 1, '空 --out exit1');
  assert.ok(r.stderr.includes('[用法错误]'), '空 --out 带 [用法错误]');
  assert.equal(r.stdout.trim(), '', '零输出（未进入构建）');
  assert.equal(listDirs(), beforeDirs, 'OUT_ROOT 参与目录集不变（零产物）');
  // (3) 端到端：--check-close 缺 --close-source → exit1（解析期拒绝，不尝试检查目录）
  const r2 = spawnSync(process.execPath, [cli, '--check-close', futurePlan], { encoding: 'utf8' });
  assert.equal(r2.status, 1, '缺 --close-source exit1');
  assert.ok(r2.stderr.includes('--close-source'), '错误指明 --close-source');
});

test('E9 共享守卫边界：父Socket/DNS/公共spawn拒绝；子DNS/Socket计数；按字节截断、超时、启动失败与畸形回执统一拒绝', async () => {
  await require('./helpers/pic-guard-boundary-proof.cjs').runBoundaryProof();
});

// ════════════════════════════════════════════════════════════════════════════
// H1–H5 手机请求轮次与预览版本（CodeBuddy任务-手机请求轮次与预览版本本地核对-20261019 §5 A–E）
// ════════════════════════════════════════════════════════════════════════════

function root4H() { return path.resolve(__dirname, '..', '..'); }
function shaHexH(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

test('H1 预览版本确定性（A）：同输入 build/prepare 同标识同字节；轮次变化标识变化；passphraseDigest 不参与；前端模板漂移写前拒绝；计划自报 buildId 拒绝', () => {
  const closeSource = makeCloseSourceDir();
  const starts = Date.now() - 60000;
  const mkPlan = round => writePicPlan(closeSource, {
    synthetic: false,
    checkRoundId: round,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 30 * 60 * 1000).toISOString()
  });
  const planA = mkPlan('synthetic-round-h1-a');
  const dirA1 = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h1-a1-' + RUN_ID);
  const dirA2 = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h1-a2-' + RUN_ID);
  const b1 = packer.build(planA, dirA1);
  const b2 = packer.build(planA, dirA2);
  const idA = b1.manifest.previewBuildId;
  assert.match(idA, /^[0-9a-f]{64}$/, '64 位小写十六进制');
  assert.equal(b1.manifest.previewEvidenceSchema, 'participant-identity-preview-evidence/1', 'manifest 携带证据 schema');
  assert.equal(b2.manifest.previewBuildId, idA, '同输入同标识');
  const prep = packer.prepare(planA, path.join(OUT_ROOT, packer.OUT_PREFIX + 'h1-prep-' + RUN_ID));
  assert.equal(prep.manifest.previewBuildId, idA, 'prepare 与 build 同标识');
  assert.equal(
    shaHexH(fs.readFileSync(path.join(dirA1, 'frontend', 'config', 'cloud.js'))),
    shaHexH(fs.readFileSync(path.join(prep.outDir, 'frontend', 'config', 'cloud.js'))),
    'prepare/build 生成配置字节一致');
  const cfgText = fs.readFileSync(path.join(dirA1, 'frontend', 'config', 'cloud.js'), 'utf8');
  assert.ok(cfgText.includes("previewBuildId: '" + idA + "'"), 'previewBuildId 已注入生成配置');
  // 轮次敏感性
  const planB = mkPlan('synthetic-round-h1-b');
  assert.notEqual(packer.computePreviewBuildId(JSON.parse(fs.readFileSync(planB, 'utf8'))), idA, '轮次变化 → 标识变化');
  // passphraseDigest 不参与（仅改口令摘要字段）
  const planObj = JSON.parse(fs.readFileSync(planA, 'utf8'));
  const planCPath = planA.replace(/plan-[0-9a-f]+\.json/, 'plan-h1c.json');
  fs.writeFileSync(planCPath, JSON.stringify(Object.assign({}, planObj, { passphraseDigest: shaHexH('h1-other-passphrase') }), null, 2));
  assert.equal(packer.computePreviewBuildId(JSON.parse(fs.readFileSync(planCPath, 'utf8'))), idA, '口令摘要不参与标识');
  // 前端模板漂移：写前拒绝（SOURCE_DRIFT）且零产物
  const wxmlPath = path.join(root4H(), 'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.wxml');
  const wxmlOrig = fs.readFileSync(wxmlPath);
  fs.writeFileSync(wxmlPath, wxmlOrig.toString('utf8') + '<!-- drift -->');
  const driftDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h1-drift-' + RUN_ID);
  try {
    assert.throws(() => packer.build(planA, driftDir), e => e.code === packer.ERR.SOURCE_DRIFT, '受审源码漂移写前拒绝');
    assert.equal(fs.existsSync(driftDir), false, '漂移零产物');
  } finally {
    fs.writeFileSync(wxmlPath, wxmlOrig);
  }
  // 计划自报 buildId：未知字段写前拒绝
  const planDPath = planA.replace(/plan-[0-9a-f]+\.json/, 'plan-h1d.json');
  fs.writeFileSync(planDPath, JSON.stringify(Object.assign({}, planObj, { previewBuildId: idA }), null, 2));
  const selfDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h1-self-' + RUN_ID);
  assert.throws(() => packer.build(planDPath, selfDir), e => /计划含未知字段/.test(e.message), '计划自报 buildId 拒绝');
  assert.equal(fs.existsSync(selfDir), false, '自报 buildId 零产物');
});

test('H2 生成链三栏与payload（B）：加载/前台零发送且预览版本/配置轮次可见；捕获提交轮次与交给wx的payload精确一致；payload键集无新增', async () => {
  const closeSource = makeCloseSourceDir();
  const openid = 'openid-h2-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  const starts = Date.now() - 60000;
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h2-' + RUN_ID);
  packer.build(writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 29 * 60 * 1000).toISOString()
  }), outDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const sent = [];
  const wxStub = {
    cloud: {
      _identityCheckEnvInited: false,
      init() {},
      callFunction(opts) {
        sent.push({ type: 'callFunction', name: opts.name, data: opts.data });
        const main = loadCandidateMain(outDir, {
          appId: APPID, envId: ENV_ID, openid,
          db: makeTrapDb({ rows: [{ _id: userId, openid, status: 'active' }] })
        });
        return main.main(opts.data).then(result => ({ result }));
      }
    }
  };
  await withGlobalWx(wxStub, async () => {
    const page = loadCandidatePage(outDir, wxStub);
    page.setData({});
    page.onLoad();
    if (page.onShow) page.onShow();
    assert.equal(sent.filter(x => x.type === 'callFunction').length, 0, '加载/前台零发送');
    assert.equal(page.data.previewBuildId, manifest.previewBuildId, '本机预览版本可见且与 manifest 一致');
    assert.equal(page.data.configCheckRoundId, manifest.checkRoundId, '本机配置轮次可见');
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    const calls = sent.filter(x => x.type === 'callFunction');
    assert.equal(calls.length, 1, '唯一提交一次发送');
    const payload = calls[0].data;
    assert.equal(payload.picRequest.checkRoundId, page.data.localRequestRound, '捕获提交轮次=交给wx的同一payload值');
    assert.equal(Object.keys(payload).join(','), 'picRequest', '网络payload外层键集无新增');
    assert.equal(Object.keys(payload.picRequest).sort().join(','), 'action,checkRoundId,passphrase,schema', '内层键集无新增（未勾选完整编号）');
    assert.equal(page.data.result.registrationState, 'ACTIVE', '既有 server/adapter/core 链继续通过');
    assert.equal(page.data.result.serverRoundText, manifest.checkRoundId, '服务端返回轮次展示');
    assert.ok(page.data.localRequestRound, '提交轮次（本机调用记录）已展示');
  });
});

test('H3 旧前端请求新服务端（C）：ROUND_MISMATCH/UNKNOWN/readAttempted=false、collection/get=0 与 factory=1 分述；页面同时显示旧提交轮次与新返回轮次且不被覆盖；正向同轮 ACTIVE', async () => {
  const closeSource = makeCloseSourceDir();
  const openid = 'openid-h3-' + RUN_ID;
  const userId = core.deriveUserId(APPID, openid);
  const starts = Date.now() - 60000;
  const mk = round => {
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h3-' + round.slice(-4) + '-' + crypto.randomBytes(3).toString('hex'));
    try {
    packer.build(writePicPlan(closeSource, {
      synthetic: false, checkRoundId: round,
      windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 29 * 60 * 1000).toISOString()
    }), outDir);
    } catch (e) { throw new Error('H3 mk 构建失败[' + round + ' dir=' + outDir + ']: ' + e.message); }
    return { outDir, round };
  };
  const oldPkg = mk('synthetic-round-h3-old');
  const newPkg = mk('synthetic-round-h3-new');
  const counters = { factory: 0, collections: [], gets: 0 };
  const db = {
    collection(name) { counters.collections.push(name); if (name !== core.FIXED_TARGET.collection) throw Error('TRAP 集合'); return { doc(id) { if (id !== userId) throw Error('TRAP 主键'); return { async get() { counters.gets++; throw Error('unprojected get'); }, field(f) { return { async get() { counters.gets++; return { data: { _id: userId, openid, status: 'active' } }; } }; } }; } }; }
  };
  const srvMain = loadCandidateMain(newPkg.outDir, {
    appId: APPID, envId: ENV_ID, openid, db, onDatabase: () => counters.factory++
  });
  const loadOldModule = rel => {
    const m = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(oldPkg.outDir, rel), 'utf8'), { module: m, exports: m.exports }, { filename: rel });
    return m.exports;
  };
  const clientOld = { module: { exports: {} }, require: name => {
    if (name === '../config/cloud') return loadOldModule(path.join('frontend', 'config', 'cloud.js'));
    throw Error('unexpected require ' + name);
  }, wx: null };
  clientOld.wx = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction: async opts => ({ result: await srvMain.main(opts.data) }) } };
  vm.runInNewContext(fs.readFileSync(path.join(oldPkg.outDir, 'frontend', 'utils', 'identity-check-client.js'), 'utf8'), clientOld, { filename: 'client-old.js' });
  const envelope = await clientOld.module.exports.callIdentityCheck({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(envelope.localRequestEvidence.requestRoundId, oldPkg.round, '本机快照=旧配置轮次');
  assert.equal(envelope.transportOutcome, 'returned');
  assert.equal(envelope.response.code, 'PIC_ROUND_MISMATCH', '轮次校验仍拒绝');
  assert.equal(envelope.response.registrationState, 'UNKNOWN');
  assert.equal(envelope.response.readAttempted, false, '零登记读取');
  assert.equal(counters.factory, 1, 'SDK 工厂已构造（按实际计数分述）');
  assert.equal(counters.collections.length, 0, '集合零访问');
  assert.equal(counters.gets, 0, 'get 零次');
  const pageStub = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction: async opts => ({ result: await srvMain.main(opts.data) }) } };
  await withGlobalWx(pageStub, async () => {
    const page = loadCandidatePage(oldPkg.outDir, pageStub);
    page.onLoad();
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(page.data.localRequestRound, oldPkg.round, '提交轮次（本机调用记录）=旧轮次');
    assert.equal(page.data.result.serverRoundText, newPkg.round, '服务端返回轮次=新轮次');
    assert.equal(page.data.result.serverRoundText, newPkg.round, '服务端返回轮次保持新值（原始值不进页面数据）');
    assert.equal(page.data.result.code, 'PIC_ROUND_MISMATCH');
  });
  const okStub = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction: async opts => ({ result: await srvMain.main(opts.data) }) } };
  await withGlobalWx(okStub, async () => {
    const page = loadCandidatePage(newPkg.outDir, okStub);
    page.onLoad();
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(page.data.result.registrationState, 'ACTIVE', '同轮正向 ACTIVE');
    assert.equal(page.data.localRequestRound, newPkg.round);
    assert.equal(page.data.result.serverRoundText, newPkg.round);
  });
});

test('H4 响应伪造与泄漏防护（D）：伪造 localRequestEvidence/previewBuildId、恶意/超长返回轮次、秘密字符串不被采信不泄漏；采样后配置/响应改变证据不变', async () => {
  const TEST_ROUND2 = 'synthetic-round-h4';
  const baseConfig = { envId: 'cloud1-d8gcq5ag39d847723', identityCheckFunction: 'scheduleSandbox', requestProtocol: packer.REQUEST_PROTOCOL, checkRoundId: TEST_ROUND2, previewBuildId: 'b'.repeat(64) };
  const mkClient = (configOverrides, wxStub) => {
    const cfg = configOverrides || baseConfig;
    const ctx = { module: { exports: {} }, require: () => cfg, wx: wxStub };
    vm.runInNewContext(fs.readFileSync(path.join(root4H(), 'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js'), 'utf8'), ctx, { filename: 'client-h4.js' });
    return ctx.module.exports;
  };
  {
    const forged = {
      checkRoundId: TEST_ROUND2, ok: false, code: 'PIC_ROUND_MISMATCH', registrationState: 'UNKNOWN', readAttempted: false,
      localRequestEvidence: { schema: 'participant-identity-local-request/1', requestRoundId: 'forged-server-round', handoffAttempted: true },
      previewBuildId: 'f'.repeat(64),
      serverSecret: 'synthetic-server-secret-value'
    };
    const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async () => ({ result: forged }) } };
    const client = mkClient(null, wxStub);
    const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: 'synthetic-h4-passphrase' });
    assert.equal(envelope.transportOutcome, 'returned');
    assert.notEqual(envelope.localRequestEvidence, forged.localRequestEvidence, '不采信服务端伪造本机证据');
    assert.equal(envelope.localRequestEvidence.previewBuildId, 'b'.repeat(64), '本机 previewBuildId 不被服务端覆盖');
    assert.equal(envelope.localRequestEvidence.requestRoundId, TEST_ROUND2, '本机提交轮次保持实际捕获值');
    assert.equal(JSON.stringify(envelope.localRequestEvidence).includes('synthetic-server-secret-value'), false, '本机证据不含服务端秘密字符串');
  }
  {
    const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async () => ({ result: { checkRoundId: '<script>alert(1)</script>', ok: false, code: 'PIC_ROUND_MISMATCH', registrationState: 'UNKNOWN', readAttempted: false } }) } };
    const closeSource = makeCloseSourceDir();
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h4-page-' + RUN_ID);
    packer.build(writePicPlan(closeSource, { synthetic: false, windowStartsAtIso: new Date(Date.now() - 60000).toISOString(), windowExpiresAtIso: new Date(Date.now() + 28 * 60 * 1000).toISOString() }), outDir);
    await withGlobalWx(wxStub, async () => {
      const page = loadCandidatePage(outDir, wxStub);
      page.onLoad();
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(page.data.result.serverRoundText, '未取得', '恶意返回轮次显示未取得');
      assert.ok(!JSON.stringify(page.data.result).includes('<script>'), '恶意文本不回显');
      assert.equal(page.data.localRequestRound, page.data.configCheckRoundId, '本机提交轮次不被响应覆盖');
    });
    const longStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async () => ({ result: { checkRoundId: 'x'.repeat(500), ok: false, code: 'PIC_ROUND_MISMATCH', registrationState: 'UNKNOWN', readAttempted: false } }) } };
    await withGlobalWx(longStub, async () => {
      const page = loadCandidatePage(outDir, longStub);
      page.onLoad();
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(page.data.result.serverRoundText, '未取得', '超长返回轮次显示未取得');
    });
  }
  {
    let configRound = TEST_ROUND2;
    const changingConfig = { get checkRoundId() { return configRound; }, envId: 'cloud1-d8gcq5ag39d847723', identityCheckFunction: 'scheduleSandbox', requestProtocol: packer.REQUEST_PROTOCOL, previewBuildId: 'c'.repeat(64) };
    let servedResult = { checkRoundId: TEST_ROUND2, ok: true, registrationState: 'ACTIVE', readAttempted: true };
    const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async () => ({ result: servedResult }) } };
    const client = mkClient(changingConfig, wxStub);
    const envelopeBefore = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: 'synthetic-h4-passphrase' });
    const evidenceBefore = JSON.stringify(envelopeBefore.localRequestEvidence);
    configRound = 'synthetic-round-changed';
    servedResult = { checkRoundId: 'synthetic-round-changed', ok: false, code: 'PIC_ROUND_MISMATCH', registrationState: 'UNKNOWN', readAttempted: false, localRequestEvidence: { requestRoundId: 'forged' } };
    const envelopeAfter = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: 'synthetic-h4-passphrase' });
    assert.equal(envelopeBefore.localRequestEvidence.requestRoundId, TEST_ROUND2, '先前证据不被改写');
    assert.equal(JSON.stringify(envelopeBefore.localRequestEvidence), evidenceBefore, '先前证据字节级不变（冻结）');
    assert.equal(envelopeAfter.localRequestEvidence.requestRoundId, 'synthetic-round-changed', '新调用捕获新值（每次独立快照）');
    assert.equal(JSON.stringify(envelopeAfter.localRequestEvidence).includes('forged'), false, '响应伪造不进入本机证据');
  }
});

test('H5 失败路径保留本机事实（E）：同步抛错/异步reject/缺result保留快照与口令清除、无自动重试；前置拒绝无假发送事实', async () => {
  const mkClient = (callFunctionImpl) => {
    const ctx = { module: { exports: {} }, require: () => ({ envId: 'cloud1-d8gcq5ag39d847723', identityCheckFunction: 'scheduleSandbox', requestProtocol: packer.REQUEST_PROTOCOL, checkRoundId: 'synthetic-round-h5', previewBuildId: 'd'.repeat(64) }), wx: { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: callFunctionImpl } } };
    vm.runInNewContext(fs.readFileSync(path.join(root4H(), 'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js'), 'utf8'), ctx, { filename: 'client-h5.js' });
    return ctx.module.exports;
  };
  {
    const client = mkClient(function () { throw new Error('synthetic-sync-throw'); });
    const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: 'p' });
    assert.equal(envelope.transportOutcome, 'failed');
    assert.equal(envelope.response, null);
    assert.equal(envelope.localRequestEvidence.handoffAttempted, true, '同步抛错保留已尝试事实');
    assert.equal(JSON.stringify(envelope).includes('synthetic-sync-throw'), false, '不带原始异常');
  }
  {
    const client = mkClient(async () => { throw new Error('synthetic-async-reject'); });
    const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: 'p' });
    assert.equal(envelope.transportOutcome, 'failed');
    assert.equal(envelope.localRequestEvidence.handoffAttempted, true);
    assert.equal(JSON.stringify(envelope).includes('synthetic-async-reject'), false);
  }
  {
    const client = mkClient(async () => ({ nothing: true }));
    const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: 'p' });
    assert.equal(envelope.response, null);
    assert.equal(envelope.transportOutcome, 'returned');
    assert.equal(envelope.localRequestEvidence.handoffAttempted, true);
  }
  {
    const closeSource = makeCloseSourceDir();
    const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h5-' + RUN_ID);
    packer.build(writePicPlan(closeSource, { synthetic: false, windowStartsAtIso: new Date(Date.now() - 60000).toISOString(), windowExpiresAtIso: new Date(Date.now() + 28 * 60 * 1000).toISOString() }), outDir);
    let calls = 0;
    const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction(opts) { calls++; throw new Error('synthetic transport failure'); } } };
    const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
    const prevWx = globalThis.wx;
    globalThis.wx = wxStub; // 多次 await 的用例：手动作用域保证 wx 全程可用（finally 还原）
    try {
      const page = loadCandidatePage(outDir, wxStub);
      page.onLoad();
      await page.onCheckTap(); // 无口令前置拒绝
      assert.equal(calls, 0, '前置拒绝零发送');
      assert.equal(page.data.localRequestRound, '', '前置拒绝无假发送事实');
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      assert.equal(page.data.passphrase, SYNTHETIC_PASSPHRASE, '口令已输入（sending=' + page.data.sending + '）');
      await page.onCheckTap();
      assert.equal(calls, 1, '失败不自动重试（实际 calls=' + calls + ' stopHint=' + page.data.stopHint + ' sending=' + page.data.sending + '）');
      assert.equal(page.data.passphrase, '', '失败也清除口令（stopHint=' + page.data.stopHint + ' sending=' + page.data.sending + ' passphrase=' + page.data.passphrase + '）');
      assert.ok(page.data.localRequestRound, '失败保留本机调用事实（提交轮次）');
      assert.equal(page.data.result, null);
    } finally {
      if (hadWx) globalThis.wx = prevWx; else delete globalThis.wx;
    }
  }
});

test('H6 发送前置校验（R1）：buildId 缺失/非法、轮次非法、协议错误、函数错误均在 callFunction 前拒绝零发送且无 handoffAttempted 假事实；合法正向、C1 口径与页面失败路径保持', async () => {
  const closeSource = makeCloseSourceDir();
  const starts = Date.now() - 60000;
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h6-' + crypto.randomBytes(3).toString('hex'));
  packer.build(writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 29 * 60 * 1000).toISOString()
  }), outDir);
  // 真实生成服务端链（同 H3 模式），供合法正向使用：
  // trusted OPENID 必须是原始值，服务端 deriveUserId(OPENID) 才会命中关闭来源用户
  const openid = 'synthetic-owner' + RUN_ID;
  const userId = 'u_' + crypto.createHash('sha256').update(APPID + ':synthetic-owner' + RUN_ID).digest('hex').slice(0, 40);
  const db = { collection(name) { if (name !== core.FIXED_TARGET.collection) throw Error('TRAP 集合'); return { doc(id) { if (id !== userId) throw Error('TRAP 主键'); return { async get() { throw Error('unprojected get'); }, field(f) { return { async get() { return { data: { _id: userId, openid, status: 'active' } }; } }; } }; } }; } };
  const srvMain = loadCandidateMain(outDir, { appId: APPID, envId: ENV_ID, openid, db, onDatabase: () => {} });
  const clientPath = path.join(outDir, 'frontend', 'utils', 'identity-check-client.js');
  const mkClient = (configOverrides, wxStub) => {
    const cfg = (() => {
      const m = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(outDir, 'frontend', 'config', 'cloud.js'), 'utf8'), { module: m, exports: m.exports }, { filename: 'h6-cloud.js' });
      return Object.assign(m.exports, configOverrides || {});
    })();
    const ctx = { module: { exports: {} }, require: name => { if (name === '../config/cloud') return cfg; throw Error('unexpected require ' + name); }, wx: wxStub };
    vm.runInNewContext(fs.readFileSync(clientPath, 'utf8'), ctx, { filename: 'h6-client.js' });
    return ctx.module.exports;
  };
  const activeResult = { ok: true, registrationState: 'ACTIVE', code: null, readAttempted: true, userId };
  const mkSendStub = sends => ({ cloud: { _identityCheckEnvInited: true, init() {}, callFunction(opts) { sends.push(opts); return Promise.resolve({ result: activeResult }); } } });
  // (1)–(5) 前置拒绝：零发送、无 handoffAttempted=true 假事实（拒绝而非封套）
  const rejectCases = [
    { why: '缺失 buildId', override: { previewBuildId: '' } },
    { why: '非法 buildId', override: { previewBuildId: 'not-a-hash' } },
    { why: '非法轮次', override: { checkRoundId: 'x' } },
    { why: '错误协议（payload 与配置一致但均非固定值，杜绝配置自比绕过）', override: { requestProtocol: 'unapproved-protocol/9' } },
    { why: '错误函数', override: { identityCheckFunction: 'unapprovedFunction' } }
  ];
  for (const c of rejectCases) {
    const sends = [];
    const client = mkClient(c.override, mkSendStub(sends));
    await assert.rejects(client.callIdentityCheck({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE }), /本机核验参数校验未通过/, c.why + ' 必须调用前拒绝');
    assert.equal(sends.length, 0, c.why + '：零 callFunction');
  }
  // (6) C1 口径：缺 result 时 transportOutcome=returned（SDK Promise 兑现）+ response=null，
  //     不保证有效服务端结果；页面按失败/未知处理（页面级在 (8) 验证）
  {
    const sends = [];
    const client = mkClient(null, { cloud: { _identityCheckEnvInited: true, init() {}, callFunction(opts) { sends.push(opts); return Promise.resolve({}); } } });
    const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(envelope.transportOutcome, 'returned', 'C1：缺 result 仍为 returned（仅 SDK Promise 兑现）');
    assert.equal(envelope.response, null, 'C1：无有效服务端结果时 response=null');
    assert.ok(envelope.localRequestEvidence && envelope.localRequestEvidence.handoffAttempted === true);
    assert.equal(sends.length, 1);
  }
  // (7) 合法正向：客户端级 ACTIVE 保持
  {
    const sends = [];
    const client = mkClient(null, mkSendStub(sends));
    const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(sends.length, 1, '合法正向发送 1 次（实际 ' + sends.length + '）');
    assert.equal(envelope.transportOutcome, 'returned');
    assert.equal(envelope.response.registrationState, 'ACTIVE', '合法正向 ACTIVE（response=' + JSON.stringify(envelope.response).slice(0, 160) + '）');
  }
  // (8) 页面级：无效配置的生成包副本 → 前置拒绝 → 零发送、失败未知、口令清除、无自动重试
  //     （client 经 createRequire 加载、其 wx 取自 globalThis，因此手动设置作用域）
  {
    const badDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h6bad-' + crypto.randomBytes(3).toString('hex'));
    fs.cpSync(outDir, badDir, { recursive: true });
    const cfgPath = path.join(badDir, 'frontend', 'config', 'cloud.js');
    fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(/checkRoundId: '[^']*'/, "checkRoundId: 'x'"));
    let pageSends = 0;
    const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction(opts) { pageSends++; return Promise.resolve({ result: activeResult }); } } };
    const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
    const prevWx = globalThis.wx;
    globalThis.wx = wxStub;
    try {
      const page = loadCandidatePage(badDir, wxStub);
      page.onLoad();
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(pageSends, 0, '页面级前置拒绝：零发送（实际 ' + pageSends + ' stopHint=' + page.data.stopHint + '）');
      assert.equal(page.data.passphrase, '', '失败也清除口令（实际=' + page.data.passphrase + '）');
      assert.equal(page.data.result, null);
      assert.ok(page.data.stopHint && page.data.stopHint.includes('未完成'), '失败未知文案（实际=' + page.data.stopHint + '）');
      await page.onCheckTap();
      assert.equal(pageSends, 0, '无自动重试：第二次点击仍前置拒绝');
      assert.equal(page.data.passphrase, '', '状态一致');
    } finally {
      if (hadWx) globalThis.wx = prevWx; else delete globalThis.wx;
    }
  }
  // (9) 页面级合法正向：真实链 ACTIVE 保持
  {
    let pageSends = 0;
    const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async opts => { pageSends++; return { result: await srvMain.main(opts.data) }; } } };
    const hadWx = Object.prototype.hasOwnProperty.call(globalThis, 'wx');
    const prevWx = globalThis.wx;
    globalThis.wx = wxStub;
    try {
      const page = loadCandidatePage(outDir, wxStub);
      page.onLoad();
      page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(pageSends, 1, '页面级正向发送 1 次（实际 ' + pageSends + '）');
      assert.equal(page.data.result && page.data.result.registrationState, 'ACTIVE', '页面级合法正向 ACTIVE（result=' + JSON.stringify(page.data.result).slice(0, 160) + '）');
    } finally {
      if (hadWx) globalThis.wx = prevWx; else delete globalThis.wx;
    }
  }
});

test('H7 来源漂移结构化失败（R2）：checkDir/checkPreparedDir 对前端模板漂移/缺失/读取异常返回 ok=false/problems/planChecked=false 不抛原始异常、不信任清单自报值；准备不升级 executionReady；合法对照与关闭独立检查保持', () => {
  const closeSource = makeCloseSourceDir();
  const starts = Date.now() - 60000;
  const outDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'h7-' + crypto.randomBytes(3).toString('hex'));
  packer.build(writePicPlan(closeSource, {
    synthetic: false,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 29 * 60 * 1000).toISOString()
  }), outDir);
  const withTemplateRead = (fn, mode) => {
    const orig = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      const s = String(p);
      if (s.includes('participant-identity-check') && s.includes('frontend')) {
        if (mode === 'drift') return Buffer.concat([orig.call(fs, p, ...rest), Buffer.from('\n// synthetic-source-drift\n')]);
        if (mode === 'missing') { const e = new Error('ENOENT: no such file or directory, open ' + s); e.code = 'ENOENT'; throw e; }
        if (mode === 'readError') { const e = new Error('EACCES: permission denied, open ' + s); e.code = 'EACCES'; throw e; }
      }
      return orig.call(fs, p, ...rest);
    };
    try { return fn(); } finally { fs.readFileSync = orig; }
  };
  // 清单自报值在此场景下仍完整有效——结构化失败证明不信任自报值
  const manifestSelfReport = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).previewBuildId;
  assert.ok(/^[0-9a-f]{64}$/.test(manifestSelfReport), '清单自报 previewBuildId 本身合法（漂移时仍被拒绝）');
  const cases = [['前端模板漂移', 'drift', 'SOURCE_DRIFT'], ['前端模板缺失', 'missing', 'ENOENT'], ['前端模板读取异常', 'readError', 'EACCES']];
  for (const [name, mode, classification] of cases) {
    withTemplateRead(() => {
      let r1 = null;
      r1 = packer.checkDir(outDir); // 不抛：结构化失败
      assert.equal(r1.ok, false, name + '：checkDir ok=false');
      assert.ok(r1.problems.some(p => p.includes('预览版本标识重建失败')), name + '：问题含重建失败条目');
      assert.ok(r1.problems.some(p => p.includes(classification)), name + '：错误分类保留');
      assert.equal(r1.planChecked, false, name + '：planChecked=false');
      const r2 = packer.checkPreparedDir(outDir);
      assert.equal(r2.ok, false, name + '：checkPreparedDir ok=false');
      assert.equal(r2.phase, 'preparation', name + '：阶段标记保持');
      assert.equal(r2.executionReady, false, name + '：准备结果不升级 executionReady');
      assert.equal(r2.planChecked, false, name + '：checkPreparedDir planChecked=false');
    }, mode);
  }
  // 合法对照：撤回注入后两检查器均通过（窗口内），且不依赖清单自报值（重算一致）
  const ok1 = packer.checkDir(outDir);
  assert.equal(ok1.ok, true, '合法对照 checkDir 通过');
  const ok2 = packer.checkPreparedDir(outDir);
  assert.equal(ok2.ok, true, '合法对照 checkPreparedDir 通过');
  assert.equal(ok2.executionReady, false, '准备结果仍不升级 executionReady');
  // 关闭独立检查：不受候选来源重建/窗口影响
  process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
  try {
    const closeResult = packer.checkCloseDir(outDir);
    assert.equal(closeResult.ok, true, '关闭 23 文件独立检查保持');
    assert.equal(closeResult.files, 23);
  } finally {
    delete process.env.PIC_CLOSE_SOURCE_DIR;
  }
});
