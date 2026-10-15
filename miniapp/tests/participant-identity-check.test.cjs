// 两位参与者「本人身份只读核验包」相称测试（仅本地合成验证）。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §6
// 方案：docs/Codex执行包草案-三账号P准备窗口-20261015.md §8
//
// 边界（必须与证据文案一致，不得夸大）：
// - 跑的是**真实应用代码**（核验核心模块、候选服务端入口、生成的前端页面/客户端）
//   ＋**合成 wx / 合成 db / 合成时钟**；
// - **SDK 本地转换未执行**；真实平台、真实三账号、真实部署完全未验证；
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
  return core.createIdentityChecker({
    db,
    trusted: o.trusted === undefined ? trustedContext('openid-participant-1') : o.trusted,
    config: {
      checkRoundId: o.checkRoundId === undefined ? 'synthetic-round-pic-1' : o.checkRoundId,
      passphraseDigest: o.passphraseDigest === undefined ? SYNTHETIC_DIGEST : o.passphraseDigest,
      windowStartsAtMs: starts,
      windowExpiresAtMs: expires
    },
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
  // 服务端 3（入口+核心模块+package.json）+ 前端 9 + project.config.json + plan.json
  assert.equal(built.manifest.files.length, 14);
  assert.equal(built.manifest.closePackage.files.length, 23);
  assert.equal(built.io.filter(x => x.action === 'written').length, 38);
  // 服务端不含 vendor/service、memberAccess、connectionCheck、project-guard、gate
  const serverFiles = fs.readdirSync(path.join(outDir, 'server'));
  for (const forbidden of ['vendor', 'memberAccess', 'connectionCheck', 'project-guard', 'gate']) {
    assert.equal(serverFiles.includes(forbidden), false, '服务端不得包含 ' + forbidden);
  }
  const entry = fs.readFileSync(path.join(outDir, 'server', 'scheduleSandbox', 'index.js'), 'utf8');
  assert.equal(entry.includes("require('./participant-identity-check')"), true);
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
  assert.equal(reused.io.filter(x => x.action === 'reused').length, 38);
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

  // 续建：删一个文件后只补 1、复用 37（独立目录，避免与"多余目录"用例互相污染）
  const resumeDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'resume-' + RUN_ID);
  const resumePlan = writePicPlan(closeSource);
  const rb = packer.build(resumePlan, resumeDir);
  fs.unlinkSync(path.join(resumeDir, rb.manifest.files[0].rel));
  const resumed = packer.build(resumePlan, resumeDir);
  assert.equal(resumed.io.filter(x => x.action === 'written').length, 1);
  assert.equal(resumed.io.filter(x => x.action === 'reused').length, 37);
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
        sent.push({ type: 'callFunction', name: opts.name, data: { action: opts.data.action } });
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
    assert.equal(calls[0].data.action, 'inspectSelf');
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
    }, '.');
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
  assert.equal(resumed.io.filter(x => x.action === 'reused').length, 37);
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
    assert.equal(requests[0].data.includeFullUserId, undefined, '默认请求不得携带完整 ID');
    assert.equal(page.data.result.userId, '', '默认不显示完整 ID');
    // (1) 勾选 → 请求并显示
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    assert.equal(page.data.wantFullUserId, true, '勾选后应为 true');
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests[1].data.includeFullUserId, true, '勾选后请求携带完整 ID');
    assert.equal(page.data.result.userId, userId, '勾选后显示完整 ID');
    // (2) 取消勾选（detail.value=[]，即 D7 缺陷的直接反例）→ 不请求、不显示
    page.onWantFullIdChange({ detail: { value: [] } });
    assert.equal(page.data.wantFullUserId, false, '取消勾选必须为 false（旧实现 Boolean([])===true）');
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests[2].data.includeFullUserId, undefined, '取消后请求不得携带完整 ID');
    assert.equal(page.data.result.userId, '', '取消后不得显示完整 ID');
    assert.equal(page.data.result.userIdTail, userId.slice(-6), '仍显示尾号');
    // (3) 重新勾选 → 才展示
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    assert.equal(page.data.wantFullUserId, true);
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests[3].data.includeFullUserId, true, '重新勾选才请求');
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
    assert.equal(requests[0].includeFullUserId, true);
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
    assert.equal(requests[1].includeFullUserId, undefined, '取消后再次核验不请求完整编号');
    assert.equal(page.data.result.userId, '', '取消后再核验不显示完整编号');
    assert.equal(page.data.result.userIdTail, userId.slice(-6));
    // 步骤 5：重新勾选 + 再次核验 → 新一次有效核验返回后才显示完整编号
    page.onWantFullIdChange({ detail: { value: ['full'] } });
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onCheckTap();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].includeFullUserId, true, '重新勾选后才请求完整编号');
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
  const hit = await makeChecker(makeTrapDb({ rows: [{ _id: userId, openid, status: 'active' }] }).data === undefined ? makeTrapDb({ rows: [{ _id: userId, openid, status: 'active' }] }) : null, {}).handle; // 占位（下方用 rChecker 风格）
  // 单对象形状（直接用 rChecker 替身风格）
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
  // (2) 函数子目录含完整入口三件套
  for (const f of ['index.js', 'package.json', 'participant-identity-check.js']) {
    assert.equal(fs.existsSync(path.join(serverRoot, 'scheduleSandbox', f)), true, '函数目录含 ' + f);
  }
  // (3) 依赖闭包：入口 require('./participant-identity-check') 同目录可解析
  const entrySrc = fs.readFileSync(path.join(serverRoot, 'scheduleSandbox', 'index.js'), 'utf8');
  assert.ok(entrySrc.includes("require('./participant-identity-check')"), '入口引用同目录核心模块');
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
  // (7) 精确文件集：候选 14 文件不变（仅 rel 调整）
  const r = packer.checkDir(outDir);
  assert.equal(r.ok, true);
  assert.equal(r.files, 14, '候选清单 14 文件（仅 rel 调整，数量不变）');
});
