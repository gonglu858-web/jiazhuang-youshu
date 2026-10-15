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
const SYNTHETIC_PASSPHRASE = 'synthetic-verify-passphrase-0123456789abcdef';
const SYNTHETIC_DIGEST = crypto.createHash('sha256').update(SYNTHETIC_PASSPHRASE).digest('hex');

const WRITE_TRAP_METHODS = [
  'add', 'set', 'update', 'remove', 'runTransaction',
  'startTransaction', 'commitTransaction', 'rollbackTransaction'
];

// ── 合成 db 替身：所有写/事务方法设陷阱，正常与异常路径都零业务写 ────────────
function makeTrapDb(options) {
  const opts = options || {};
  const calls = { collections: [], docs: [], reads: 0 };
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
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
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
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(absent.registrationState, 'ABSENT');
  assert.equal(absent.recordMatched, null);
  assert.equal(absent.readAttempted, true);

  // DISABLED（明确支持的停用状态）
  const dbDisabled = makeTrapDb({ rows: [rowFor(openid1, { status: 'disabled' })] });
  const disabled = await makeChecker(dbDisabled, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(disabled.registrationState, 'DISABLED');
  assert.equal(disabled.recordMatched, true);

  // MISMATCH（归属不符：openid 不同）
  const dbMismatch = makeTrapDb({ rows: [rowFor('someone-else-openid')] });
  const mismatch = await makeChecker(dbMismatch, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(mismatch.registrationState, 'MISMATCH');
  assert.equal(mismatch.recordMatched, false);

  // UNKNOWN（多条 / 未知 status / 形状异常）
  const dbMulti = makeTrapDb({ rows: [rowFor(openid1), rowFor(openid1)] });
  assert.equal((await makeChecker(dbMulti, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE })).registrationState, 'UNKNOWN');
  const dbOdd = makeTrapDb({ rows: [rowFor(openid1, { status: 'weird-status' })] });
  assert.equal((await makeChecker(dbOdd, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE })).registrationState, 'UNKNOWN');
  const dbShape = makeTrapDb({ readThrowsShape: true });
  const shape = await makeChecker(dbShape, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(shape.registrationState, 'UNKNOWN', '异常形状不得当作不存在');
  assert.equal(shape.identityConfirmed, false);

  // 读取失败不得报未登记，且 readAttempted 事实为 true
  const dbFail = makeTrapDb({ throwOnRead: true });
  const failed = await makeChecker(dbFail, { trusted: trustedContext(openid1) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
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
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, openid: 'other-openid' },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, appId: 'wx0000000000000000' },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, userId: 'u_' + '0'.repeat(40) },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, role: 'manager' },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, collection: 'app_admins' },
    { action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE, docId: 'other' }
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
    [{ action: 'inspectSelf' }, 'PIC_PASSPHRASE_REQUIRED'],
    [{ action: 'inspectSelf', passphrase: 'wrong-passphrase' }, 'PIC_PASSPHRASE_INVALID'],
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
      .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
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
    const r = await makeChecker(db, { trusted }).handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
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
  const r1 = await expired.checker.handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(r1.ok, false, '读取后到期不得确认');
  assert.equal(r1.identityConfirmed, false);
  assert.equal(r1.registrationState, 'UNKNOWN');
  assert.equal(r1.readAttempted, true, '已发读取的事实不得报零读取');
  assert.equal(expired.readCount(), 1);

  const nan = build(() => NaN);
  const r2 = await nan.checker.handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(r2.code, 'PIC_CLOCK_INVALID');
  assert.equal(r2.identityConfirmed, false);

  const boom = build(() => { throw new Error('english clock failure'); });
  const r3 = await boom.checker.handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  assert.equal(r3.code, 'PIC_CLOCK_ERROR');
  assert.equal(r3.registrationState, 'UNKNOWN');
});

test('P4 净化输出：结果只含固定 schema 字段，不含 OPENID/凭据/环境变量', async () => {
  const openid = 'openid-secret-' + RUN_ID;
  const db = makeTrapDb({ rows: [rowFor(openid)] });
  const r = await makeChecker(db, { trusted: trustedContext(openid) })
    .handle({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
  const keys = Object.keys(r).sort();
  assert.deepEqual(keys, [
    'checkRoundId', 'code', 'identityConfirmed', 'message', 'ok', 'readAttempted',
    'recordMatched', 'registrationState', 'schema', 'serverTimeIso', 'userIdTail'
  ].filter(k => keys.includes(k)).sort(), '固定字段集');
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
  const entry = fs.readFileSync(path.join(outDir, 'server', 'index.js'), 'utf8');
  assert.equal(entry.includes("require('./participant-identity-check')"), true);
  assert.equal(/require\(['"]\.\/vendor/.test(entry), false, '候选入口不得引入 vendor 业务实现');
  assert.equal(entry.includes(SYNTHETIC_PASSPHRASE), false, '明文口令绝不进入制品');
  assert.equal(entry.includes(SYNTHETIC_DIGEST), true, '只含摘要');
  // 前端 app.json 唯一页面
  const appJson = JSON.parse(fs.readFileSync(path.join(outDir, 'frontend', 'app.json'), 'utf8'));
  assert.deepEqual(appJson.pages, ['pages/identity-check/identity-check']);
  // project.config.json 根路径指向本候选
  const projectConfig = JSON.parse(fs.readFileSync(path.join(outDir, 'project.config.json'), 'utf8'));
  assert.equal(projectConfig.miniprogramRoot, 'miniprogram/');
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
    if (f === path.join(partialDir, 'server', 'index.js')) {
      realWrite.call(this, f, Buffer.from(buf).subarray(0, 11), opts);
      const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e;
    }
    return realWrite.call(this, f, buf, opts);
  };
  try { packer.build(writePicPlan(closeSource), partialDir); } catch (e) { err = e; } finally { fs.writeFileSync = realWrite; }
  assert.equal(err && err.code, 'EIO');
  assert.deepEqual(err.written, ['server/participant-identity-check.js', 'server/index.js']);
  assert.equal(err.wroteFiles, 2);
  assert.deepEqual(err.partialWrites, [{ rel: 'server/index.js', bytesOnDisk: 11 }]);
  assert.equal(fs.statSync(path.join(partialDir, 'server', 'index.js')).size, 11);

  // 竞态 EEXIST（他人文件）不算本轮写入、不覆盖
  const raceDir = path.join(OUT_ROOT, packer.OUT_PREFIX + 'race-' + RUN_ID);
  let err2 = null;
  fs.writeFileSync = function (f, buf, opts) {
    if (f === path.join(raceDir, 'server', 'participant-identity-check.js')) {
      realWrite.call(this, f, Buffer.from('other-writer'), opts);
      const e = new Error('EEXIST race'); e.code = 'EEXIST'; throw e;
    }
    return realWrite.call(this, f, buf, opts);
  };
  try { packer.build(writePicPlan(closeSource), raceDir); } catch (e) { err2 = e; } finally { fs.writeFileSync = realWrite; }
  assert.equal(err2 && err2.code, 'EEXIST');
  assert.ok(!err2.written || !err2.written.includes('server/participant-identity-check.js'));
  assert.equal(fs.readFileSync(path.join(raceDir, 'server', 'participant-identity-check.js'), 'utf8'), 'other-writer');
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
  const corePath = path.join(out2, 'server', 'participant-identity-check.js');
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

function loadCandidateMain(candidateDir, ctx) {
  const serverDir = path.join(candidateDir, 'server');
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
  const entryText = fs.readFileSync(path.join(outDir, 'server', 'index.js'), 'utf8');
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
  const closedResult = await templateMain.main({ action: 'inspectSelf', passphrase: SYNTHETIC_PASSPHRASE });
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
    });
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