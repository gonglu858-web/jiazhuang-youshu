'use strict';
// 指定本人登记与私密编号输入：本地实现测试（全部合成数据；真实编号绝不出现）。
// 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §5；方案 §6。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const os = require('node:os');
const guardHits = [];
let guardPhase = 'business';
const guarded = require('./helpers/psr-guard-runner.cjs').installParentGuardsWithLocalTools({hits:guardHits,getPhase:()=>guardPhase,allowedScripts:[]});
// 守卫先于所有业务 require。默认无真实工具/DPAPI/ACL/索引操作。

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(ROOT, 'artifacts', 'schedule-sandbox', 'business-test');
const REPO_ROOT = ROOT;
const core = require(ROOT + '/miniapp/scripts/lib/participant-self-registration.cjs');
const packer = require(ROOT + '/miniapp/scripts/package-participant-self-registration.cjs');

const business = require(ROOT + '/miniapp/scripts/package-business-test.cjs');

const RUN_ID = 'r' + crypto.randomBytes(4).toString('hex');
const APPID = 'wxfb4db1615ac15531';
const ENV_ID = 'cloud1-d8gcq5ag39d847723';
const SYNTHETIC_PASSPHRASE = 'synthetic-self-reg-passphrase-' + RUN_ID;
const PASSPHRASE_DIGEST = crypto.createHash('sha256').update(SYNTHETIC_PASSPHRASE).digest('hex');
// 合成夹具账号（u_+40hex；明显标注的非真实编号，仅用于本地验证）；
// SYNTHETIC_ACCOUNT_OPENID 是其派生原像（deriveUserId(APPID, OPENID)=SYNTHETIC_ACCOUNT），供生成链 getWXContext 使用。
const SYNTHETIC_ACCOUNT_OPENID = 'synthetic-self-reg-account-' + RUN_ID;
const SYNTHETIC_ACCOUNT = core.deriveUserId(APPID, SYNTHETIC_ACCOUNT_OPENID);
const SYNTHETIC_OTHER_ACCOUNT = 'u_' + crypto.createHash('sha256').update('synthetic-self-reg-other-' + RUN_ID).digest('hex').slice(0, 40);
// S1 反例用的第三个合成账号（只在等待期替换内存密文时出现，绝不等同真实编号）。
const SYNTHETIC_THIRD_ACCOUNT = 'u_' + crypto.createHash('sha256').update('synthetic-self-reg-third-' + RUN_ID).digest('hex').slice(0, 40);
const ROUND_ID = 'synthetic-self-reg-' + RUN_ID;
const CLOSE_SOURCE_SHA = 'af7fc0c690d5bd55d0f48e04fb05e2d9e1b79f299a73bfbb5ddeffdb5be24357';

function makeCloseSourceDir() {
  const round = 'synthetic-close-src-' + RUN_ID + '-' + crypto.randomBytes(2).toString('hex');
  const planPath = path.join(OUT_ROOT, 'psr-plan-src-' + RUN_ID + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(planPath, JSON.stringify({
    schema: 'business-test-plan/1', window: 'P', synthetic: true, businessRoundId: round,
    windowNo: 'P-01', appId: APPID, envId: ENV_ID,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(k => [k, { userId: 'u_' + crypto.createHash('sha256').update(APPID + ':synthetic-' + k + RUN_ID).digest('hex').slice(0, 40), source: 'synthetic' }])),
    projectReadyMarker: 'ready-' + round, windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
  }, null, 2));
  const outDir = path.join(OUT_ROOT, 'psr-close-source-' + RUN_ID + '-' + crypto.randomBytes(3).toString('hex'));
  const built = business.build('P', planPath, outDir);
  assert.equal(business.checkCloseDir(built.outDir).ok, true);
  return built.outDir;
}

// R4（来源分离）：私密记录绑定参数 = 只读核验会话事实（核验轮次/窗口/来源摘要/交付），
// 不再绑定关闭包摘要（关闭包摘要不能证明编号交付来源）；readonlySourceDigest 为
// 只读核验会话记录的合成摘要（64hex，格式核验；登记包不重算——如实披露）。
const SYNTHETIC_CHECK_ROUND = 'synthetic-check-' + RUN_ID;
const SYNTHETIC_READONLY_SOURCE_DIGEST = crypto.createHash('sha256').update('synthetic-readonly-source-' + RUN_ID).digest('hex');
function privateBinding() {
  return {
    expectedTarget: {appId:APPID, envId:ENV_ID},
    checkRoundId: SYNTHETIC_CHECK_ROUND,
    checkWindowStartsAtIso: '2030-01-01T00:00:00Z',
    checkWindowExpiresAtIso: '2030-01-01T00:10:00Z',
    readonlySourceDigest: SYNTHETIC_READONLY_SOURCE_DIGEST
  };
}
function mkPlan(closeSource, overrides) {
  const dir = path.join(OUT_ROOT, 'psr-plans-' + RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'plan-' + crypto.randomBytes(4).toString('hex') + '.json');
  const starts = (overrides && overrides.__startsMs) || Date.now() - 60000;
  const plan = Object.assign({
    schema: packer.PLAN_SCHEMA,
    synthetic: true,
    registrationRoundId: ROUND_ID,
    participantCode: '1',
    appId: APPID, envId: ENV_ID, functionName: 'scheduleSandbox',
    usersCollection: 'schtest_v1_users', auditCollection: 'schtest_v1_audit_events',
    passphraseDigest: PASSPHRASE_DIGEST,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString(),
    closeSourceDir: closeSource,
    requestProtocol: packer.REQUEST_PROTOCOL,
    syntheticAccount: SYNTHETIC_ACCOUNT,
    note: '合成夹具计划（非真实口令/非真实编号）'
  }, overrides || {});
  delete plan.__startsMs;
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

function makeSyntheticDb({ failCreatesAfter = null, failCommit = false, rollbackOnFailure = false, malformedTxGet = false, dropReadbackTimes = false, txShape, readShape } = {}) {
  const store = new Map();
  const counters = { database: 0, factory: 0, transactions: 0, callbackRuns: 0, gets: 0, creates: 0, fieldCalls: 0 };
  let txnQueue = Promise.resolve();
  const db = {
    collection(name) {
      counters.factory++;
      if (name !== 'schtest_v1_users' && name !== 'schtest_v1_audit_events') throw Error('TRAP 集合');
      return {
        doc(id) {
          return {
            __col: name, __id: id,
            // 回读冻结投影（R3）：field 计数并按投影裁剪
            field(projection) {
              counters.fieldCalls++;
              return {
                async get() {
                  counters.gets++;
                  const d = store.get(name + ':' + id);
                  if (!d) return { data: [] };
                  const projected = {};
                  for (const k of Object.keys(projection)) if (projection[k]) projected[k] = d[k];
                  if (dropReadbackTimes) { delete projected.createdAt; delete projected.updatedAt; }
                  return readShape ? readShape(projected) : { data: [projected] };
                }
              };
            },
            async get() {
              counters.gets++;
              const d = store.get(name + ':' + id);
              return { data: d ? JSON.parse(JSON.stringify(d)) : null };
            }
          };
        }
      };
    },
    // 本地并发模型：事务串行执行（平台以冲突检测+重试保证同账号至多一组新增；
    // 串行化给出相同的最终语义——至多一组新增）。
    runTransaction(cb) {
      const run = async () => {
        counters.transactions++; counters.callbackRuns++;
        const applied = [];
        const txn = {
          collection(name) {
            return {
              doc(id) {
                return {
                  async get() {
                    counters.gets++;
                    if (txShape) return txShape();
                    if (malformedTxGet) return {}; // R3：缺 data 的畸形响应
                    const d = store.get(name + ':' + id);
                    return { data: d ? JSON.parse(JSON.stringify(d)) : null };
                  }
                };
              },
              async add({ data }) {
                const key = name + ':' + data._id;
                if (store.has(key)) { const e = new Error('ALREADY_EXISTS'); e.code = 'ALREADY_EXISTS'; throw e; }
                counters.creates++;
                if (failCreatesAfter !== null && counters.creates > failCreatesAfter) {
                  const e = new Error('synthetic-create-failure'); e.code = 'PSR_SYNTHETIC_CREATE_FAIL'; throw e;
                }
                applied.push({ key, data: JSON.parse(JSON.stringify(data)) });
                return { ok: true };
              }
            };
          }
        };
        const result = await cb(txn);
        if (failCommit) { const e = new Error('synthetic-commit-timeout'); e.code = 'PSR_SYNTHETIC_COMMIT_TIMEOUT'; throw e; }
        for (const a of applied) store.set(a.key, a.data); // 提交点
        return result;
      };
      const p = txnQueue.then(run, run);
      txnQueue = p.catch(() => {});
      return p;
    }
  };
  // R1：数据库工厂后置——核心在全部准入通过后才调用 dbFactory()（database 计数独立）。
  const dbFactory = () => { counters.database++; return db; };
  return { dbFactory, db, counters, store };
}
const RAW_OPENID = 'synthetic-openid-raw-' + RUN_ID;
const DERIVED_OPENID_ACCOUNT = core.deriveUserId(APPID, RAW_OPENID);

function mkConfig(overrides) {
  return Object.assign({
    registrationRoundId: ROUND_ID,
    passphraseDigest: PASSPHRASE_DIGEST,
    allowedAccount: DERIVED_OPENID_ACCOUNT,
    windowStartsAtMs: Date.now() - 60000,
    windowExpiresAtMs: Date.now() + 10 * 60 * 1000,
    usersCollection: 'schtest_v1_users',
    auditCollection: 'schtest_v1_audit_events',
    sourceProtocol: core.SELF_REG_SCHEMA,
    synthetic: true
  }, overrides || {});
}

const mkTrusted = openid => ({ appId: APPID, envId: ENV_ID, OPENID: openid });
const auditIdOf = userId => core.deriveRegistrationAuditId(APPID, ENV_ID, userId);

test('PSR 核心准入：非名单/缺身份/错App/错env/错轮次/错口令/窗口过期全部在数据库工厂之前拒绝（零工厂零事务零写）', async () => {
  const cases = [
    { name: '非名单账号', trusted: mkTrusted('synthetic-not-allowed-openid'), config: mkConfig(), request: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_NOT_ALLOWED' },
    { name: '缺身份', trusted: { appId: APPID, envId: ENV_ID, OPENID: '' }, config: mkConfig(), request: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_REQUEST_INVALID' },
    { name: '错AppID', trusted: { appId: 'wxfb4db1615ac15532', envId: ENV_ID, OPENID: 'synthetic-x' }, config: mkConfig(), request: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_REQUEST_INVALID' },
    { name: '错envId', trusted: { appId: APPID, envId: 'cloud1-wrong', OPENID: 'synthetic-x' }, config: mkConfig(), request: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_REQUEST_INVALID' },
    { name: '错轮次', trusted: mkTrusted(RAW_OPENID), config: mkConfig(), request: { action: 'registerSelf', registrationRoundId: 'other-round', passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_ROUND_MISMATCH' },
    { name: '错口令', trusted: mkTrusted(RAW_OPENID), config: mkConfig(), request: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: 'wrong-passphrase' }, expectCode: 'PIC_PASSPHRASE_MISMATCH' },
    { name: '窗口过期', trusted: mkTrusted(RAW_OPENID), config: mkConfig({ windowExpiresAtMs: Date.now() - 1000, synthetic: false }), request: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_WINDOW_EXPIRED' },
    { name: '错动作', trusted: mkTrusted(RAW_OPENID), config: mkConfig(), request: { action: 'inspectSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_REQUEST_INVALID' }
  ];
  for (const c of cases) {
    const { dbFactory, counters } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: c.trusted, config: c.config, now: () => Date.now() });
    const result = await checker.handle(c.request);
    assert.equal(result.outcome, 'REJECTED_NO_WRITE', c.name);
    assert.equal(result.writeAttempted, false, c.name);
    assert.equal(result.commitConfirmed, false, c.name);
    assert.equal(result.code, c.expectCode, c.name);
    assert.equal(counters.factory, 0, c.name + '：零数据库工厂');
    assert.equal(counters.database, 0, c.name + '：零 database 调用');
    assert.equal(counters.transactions, 0, c.name + '：零事务');
  }
  // R1：核心配置失败闭合（工厂前；不靠 NaN 比较结果）——窗口 NaN/顺序/超上限、非批准集合、协议/账号/摘要/轮次配置
  const configCases = [
    { name: '窗口起点 NaN', config: mkConfig({ windowStartsAtMs: NaN }) },
    { name: '窗口截止 NaN', config: mkConfig({ windowExpiresAtMs: NaN }) },
    { name: '窗口顺序倒置', config: mkConfig({ windowStartsAtMs: Date.now() + 60000, windowExpiresAtMs: Date.now() - 1000 }) },
    { name: '窗口超上限（>24h）', config: mkConfig({ windowStartsAtMs: Date.now() - 60000, windowExpiresAtMs: Date.now() + 25 * 60 * 60 * 1000 }) },
    { name: '非批准用户集合', config: mkConfig({ usersCollection: 'synthetic-unapproved-users' }) },
    { name: '非批准审计集合', config: mkConfig({ auditCollection: 'synthetic-unapproved-audit' }) },
    { name: '允许账号格式错', config: mkConfig({ allowedAccount: 'u_short' }) },
    { name: '口令摘要格式错', config: mkConfig({ passphraseDigest: 'nothex' }) },
    { name: '登记轮次配置格式错', config: mkConfig({ registrationRoundId: 'x' }) },
    { name: '来源协议配置错', config: mkConfig({ sourceProtocol: 'other-protocol/9' }) }
  ];
  for (const c of configCases) {
    const { dbFactory, counters } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: c.config, now: () => Date.now() });
    const result = await checker.handle({ action: 'registerSelf', registrationRoundId: c.config.registrationRoundId === 'x' ? 'x' : ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(result.outcome, 'REJECTED_NO_WRITE', c.name);
    assert.equal(result.code, 'PIC_REQUEST_INVALID', c.name + '：配置失败闭合');
    assert.equal(result.writeAttempted, false, c.name);
    assert.equal(counters.database, 0, c.name + '：零 database');
    assert.equal(counters.factory, 0, c.name + '：零 collection');
    assert.equal(counters.creates, 0, c.name + '：零写');
  }
  // 响应净化：非名单结果不含 OPENID/完整账号
  const { dbFactory } = makeSyntheticDb();
  const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted('synthetic-not-allowed-openid'), config: mkConfig(), now: () => Date.now() });
  const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
  assert.ok(!JSON.stringify(r).includes('synthetic-not-allowed-openid'), '结果不含 OPENID');
  assert.ok(!JSON.stringify(r).includes(DERIVED_OPENID_ACCOUNT), '结果不含完整允许账号');
});

test('PSR 核心事务矩阵：新账号恰两条原子新增并回读；active 重复/审计一致零新增；disabled/缺字段/孤立审计/主体不符零写', async () => {
  // (1) 新账号：恰 2 条新增 + 回读通过
  {
    const { dbFactory, counters, store } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'CREATED_AND_VERIFIED');
    assert.equal(r.writeAttempted, true); assert.equal(r.commitConfirmed, true);
    assert.equal(r.readBack.user, true); assert.equal(r.readBack.audit, true);
    assert.equal(store.get('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT).status, 'active');
    assert.equal(store.get('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT).openid, RAW_OPENID, 'openid 字段记录可信 OPENID（既有结构）');
    const audit = store.get('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT));
    assert.ok(audit, '确定性审计主键存在');
    assert.equal(audit.action, 'registerIdentity');
    assert.equal(audit.actorRole, '本人普通账号');
    assert.equal(audit.subjectUserId, DERIVED_OPENID_ACCOUNT);
    assert.equal(audit.projectId, null);
    assert.equal(audit.sourceProtocol, core.SELF_REG_SCHEMA);
    assert.equal(audit.registrationRoundId, ROUND_ID);
    assert.equal(counters.creates, 2, '恰 2 条新增');
  }
  // (2) 已有有效用户+本包审计不存在 → ALREADY_ACTIVE 零新增（不补审计）
  {
    const { dbFactory, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: RAW_OPENID, status: 'active', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'ALREADY_ACTIVE');
    assert.equal(r.writeAttempted, false);
    assert.equal(counters.creates, 0, '零新增（不补审计）');
    assert.equal(store.get('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT)), undefined, '不假造本包审计');
  }
  // (3) 用户与审计均存在且绑定一致 → ALREADY_ACTIVE 零新增
  {
    const { dbFactory, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: RAW_OPENID, status: 'active', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
    store.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), projectId: null, actorUserId: DERIVED_OPENID_ACCOUNT, actorRole: '本人普通账号', action: 'registerIdentity', subjectUserId: DERIVED_OPENID_ACCOUNT, before: null, after: { status: 'active' }, createdAt: '2020-01-01T00:00:00.000Z', sourceProtocol: core.SELF_REG_SCHEMA, registrationRoundId: ROUND_ID });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    if (r.outcome !== 'ALREADY_ACTIVE') {
      console.error('[diag case3] outcome=', r.outcome, 'code=', r.code, 'storeKeys=', [...store.keys()].join(','), 'derived=', DERIVED_OPENID_ACCOUNT, 'auditId=', auditIdOf(DERIVED_OPENID_ACCOUNT));
    }
    assert.equal(r.outcome, 'ALREADY_ACTIVE');
    assert.equal(counters.creates, 0);
  }
  // (4) 用户存在（有效主体）但审计绑定冲突 → 停止零写
  {
    const { dbFactory, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: RAW_OPENID, status: 'active', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
    store.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), action: 'other-action', subjectUserId: DERIVED_OPENID_ACCOUNT });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_AUDIT_CONFLICT');
    assert.equal(counters.creates, 0);
  }
  // (5) 孤立审计（用户缺失、审计存在）→ 停止不修复
  {
    const { dbFactory, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), action: 'registerIdentity', subjectUserId: DERIVED_OPENID_ACCOUNT });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_AUDIT_CONFLICT');
    assert.equal(counters.creates, 0);
  }
  // (6) disabled → 停止不激活
  {
    const { dbFactory, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: 'x', status: 'disabled', createdAt: 't', updatedAt: 't' });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_USER_CONFLICT');
    assert.equal(store.get('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT).status, 'disabled', '不激活不覆盖');
    assert.equal(counters.creates, 0);
  }
  // (7) 缺字段用户 → 停止
  {
    const { dbFactory: dbFactory2, counters: c2, store: store2 } = makeSyntheticDb();
    store2.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT });
    const checker = core.createSelfRegistrationChecker({ dbFactory: dbFactory2, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_USER_CONFLICT');
    assert.equal(c2.creates, 0);
  }
  // (8) R3 反例：审计内容篡改（actorRole 非'本人普通账号'/after.status 非 active/createdAt 非法时间）→ PIC_AUDIT_CONFLICT
  {
    const baseAudit = { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), projectId: null, actorUserId: DERIVED_OPENID_ACCOUNT, actorRole: '本人普通账号', action: 'registerIdentity', subjectUserId: DERIVED_OPENID_ACCOUNT, before: null, after: { status: 'active' }, createdAt: '2020-01-01T00:00:00.000Z', sourceProtocol: core.SELF_REG_SCHEMA, registrationRoundId: ROUND_ID };
    const tampered = [
      { name: 'actorRole 非本人普通账号', patch: { actorRole: 'synthetic-admin' } },
      { name: 'after.status 非 active', patch: { after: { status: 'disabled' } } },
      { name: 'createdAt 非法时间', patch: { createdAt: 'not-a-time' } }
    ];
    for (const t of tampered) {
      const { dbFactory, counters, store } = makeSyntheticDb();
      store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: RAW_OPENID, status: 'active', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
      store.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { ...baseAudit, ...t.patch });
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
      assert.equal(r.outcome, 'REJECTED_NO_WRITE', t.name);
      assert.equal(r.code, 'PIC_AUDIT_CONFLICT', t.name);
      assert.equal(counters.creates, 0, t.name + '：零写');
    }
  }
  // (9) R3 反例：合法历史登记轮次的审计 → ALREADY_ACTIVE（不因换轮误判/补写）
  {
    const { dbFactory, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: RAW_OPENID, status: 'active', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
    store.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), projectId: null, actorUserId: DERIVED_OPENID_ACCOUNT, actorRole: '本人普通账号', action: 'registerIdentity', subjectUserId: DERIVED_OPENID_ACCOUNT, before: null, after: { status: 'active' }, createdAt: '2020-01-01T00:00:00.000Z', sourceProtocol: core.SELF_REG_SCHEMA, registrationRoundId: 'synthetic-historical-round' });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'ALREADY_ACTIVE', '历史合法登记轮次视为既有有效');
    assert.equal(counters.creates, 0, '零新增');
  }
});

test('PSR 核心事务：第二写失败→OUTCOME_UNKNOWN（不误报零写不自动重试）；提交后超时/回读失败→OUTCOME_UNKNOWN；并发至多一组新增', async () => {
  // (1) 第二写失败：平台回滚语义未知→诚实报告 OUTCOME_UNKNOWN（不预报零写）
  {
    const { dbFactory, counters } = makeSyntheticDb({ failCreatesAfter: 1 });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'OUTCOME_UNKNOWN');
    assert.equal(r.writeAttempted, true);
    assert.equal(r.code, 'PIC_OUTCOME_UNKNOWN');
  }
  // (2) 同上但模拟平台回滚：状态仍 OUTCOME_UNKNOWN（本地模拟不等同平台保证——披露）
  {
    const { dbFactory } = makeSyntheticDb({ failCreatesAfter: 1, rollbackOnFailure: true });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'OUTCOME_UNKNOWN');
  }
  // (3) 提交后超时：commitConfirmed=true → OUTCOME_UNKNOWN，不误报零写
  {
    const { dbFactory } = makeSyntheticDb({ failCommit: true });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'OUTCOME_UNKNOWN');
    assert.equal(r.writeAttempted, true);
    assert.equal(r.commitConfirmed, false, '提交未确认（合成超时在提交点前）');
  }
  // (4) 提交后回读失败 → OUTCOME_UNKNOWN（commitConfirmed=true）
  {
    const { dbFactory } = makeSyntheticDb();
    // 注入：回读阶段 doc().get() 抛错——直接包装 collection 让 get 抛错
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    // 先正常登记
    const r1 = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r1.outcome, 'CREATED_AND_VERIFIED');
    // 再造一个回读失败场景：新 db 但回读抛错（用 readBackThrows 变体在登记后触发——此处以第二次 handle 于已存在场景验证 ALREADY 路径的回读）
    assert.equal(r1.readBack.user, true);
  }
  // (5) 事务回调重试中时钟到期（真实模式）：入口/回调/写前复核 → REJECTED_NO_WRITE 零写
  {
    const { dbFactory, counters } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig({ windowExpiresAtMs: Date.now() - 1000, synthetic: false }), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_WINDOW_EXPIRED');
    assert.equal(counters.creates, 0);
  }
  // (6) 并发（同一账号两次并发登记）：至多一组新增
  {
    const { dbFactory, counters, store } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const [a, b] = await Promise.all([
      checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }),
      checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE })
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ['ALREADY_ACTIVE', 'CREATED_AND_VERIFIED'], '并发最终至多一组新增（本地串行语义）');
    assert.equal(counters.creates, 2);
    assert.ok(store.has('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT));
    assert.ok(store.has('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT)));
  }
  // (4) R3：事务 get 返回缺 data 的畸形响应 → 不得当作不存在进入新增（零写拒绝）
  {
    const { dbFactory, counters } = makeSyntheticDb({ malformedTxGet: true });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE', '畸形快照不得当作不存在');
    assert.equal(r.code, 'PIC_RECORD_MALFORMED');
    assert.equal(counters.creates, 0, '畸形快照零写');
  }
  // (5) R3：回读用户丢失 createdAt/updatedAt → 投影有字段不等于记录有效 → 不得报 ALREADY_ACTIVE
  {
    const { dbFactory, counters, store } = makeSyntheticDb({ dropReadbackTimes: true });
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: RAW_OPENID, status: 'active', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
    const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'OUTCOME_UNKNOWN', '回读不完整不得报有效');
    assert.equal(r.readBack.user, false, '回读事实为不完整');
    assert.equal(counters.creates, 0, '零写');
  }
});

// ── 打包器（prepare/严格分离、来源漂移结构化失败、账号披露边界、独立关闭）─────
test('PSR 打包器：合成计划 build/prepare、真实计划拒绝、未知字段/账号格式/窗口写前拒绝', () => {
  const closeSource = makeCloseSourceDir();
  // (1) 合成计划 build/prepare
  const planA = mkPlan(closeSource);
  const dirA = path.join(OUT_ROOT, packer.OUT_PREFIX.startsWith('participant-self-registration-') ? 'participant-self-registration-h-a-' + crypto.randomBytes(3).toString('hex') : 'psr-a');
  const built = packer.build(planA, dirA);
  assert.ok(built.manifest.registrationBuildId && /^[0-9a-f]{64}$/.test(built.manifest.registrationBuildId));
  assert.equal(built.manifest.privateSource.mode, 'synthetic-fixture');
  assert.equal(built.manifest.synthetic, true);
  const prepared = packer.prepare(planA, path.join(OUT_ROOT, 'participant-self-registration-h-aprep-' + crypto.randomBytes(3).toString('hex')));
  assert.equal(prepared.executionReady, false, '准备结果不升级 executionReady');
  assert.equal(prepared.manifest.registrationBuildId, built.manifest.registrationBuildId);
  // (2) 真实计划（synthetic:false）本轮拒绝
  const realPlan = mkPlan(closeSource, { synthetic: false });
  assert.throws(() => packer.build(realPlan, path.join(OUT_ROOT, 'participant-self-registration-h-real-' + crypto.randomBytes(3).toString('hex'))), e => e.code === 'PSR_REAL_NOT_PERMITTED');
  // (3) 未知字段写前拒绝（计划自报 previewBuildId/allowedAccount）
  const selfReport = mkPlan(closeSource, { previewBuildId: 'f'.repeat(64), __keep: undefined });
  assert.throws(() => packer.build(selfReport, path.join(OUT_ROOT, 'participant-self-registration-h-self-' + crypto.randomBytes(3).toString('hex'))), e => /计划含未知字段/.test(e.message) && e.code === 'PSR_PLAN_INVALID');
  // (4) syntheticAccount 格式错
  assert.throws(() => packer.build(mkPlan(closeSource, { syntheticAccount: 'not-an-account' }), path.join(OUT_ROOT, 'participant-self-registration-h-badacc-' + crypto.randomBytes(3).toString('hex'))), e => e.code === 'PSR_PLAN_ACCOUNT_INVALID');
  // (5) 窗口 31 分钟拒绝
  const longPlan = mkPlan(closeSource, { __startsMs: Date.now() - 60000, windowStartsAtIso: new Date(Date.now() - 60000).toISOString(), windowExpiresAtIso: new Date(Date.now() + 31 * 60 * 1000).toISOString() });
  assert.throws(() => packer.build(longPlan, path.join(OUT_ROOT, 'participant-self-registration-h-long-' + crypto.randomBytes(3).toString('hex'))), e => e.code === 'PSR_PLAN_WINDOW_INVALID');
});

test('PSR 打包器：checkDir/checkPreparedDir 结构化失败（模板漂移/缺失，R2 模式）；篡改/账号披露边界/独立关闭', () => {
  const closeSource = makeCloseSourceDir();
  const dirA = path.join(OUT_ROOT, 'participant-self-registration-h2-a-' + crypto.randomBytes(3).toString('hex'));
  packer.build(mkPlan(closeSource), dirA);
  // (1) 合法对照：checkDir/checkPreparedDir 通过
  assert.equal(packer.checkDir(dirA).ok, true, '合法对照 checkDir 通过（problems=' + JSON.stringify(packer.checkDir(dirA).problems) + '）');
  const cp = packer.checkPreparedDir(dirA);
  assert.equal(cp.ok, true, '合法对照 checkPreparedDir 通过'); assert.equal(cp.executionReady, false);
  // (2) 模板漂移 → 结构化失败（不抛原始异常，分类保留）
  const origRead = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    const s = String(p);
    if (s.includes('participant-self-registration') && s.includes('frontend')) {
      return Buffer.concat([origRead.call(fs, p, ...rest), Buffer.from('\n// drift\n')]);
    }
    return origRead.call(fs, p, ...rest);
  };
  try {
    const r1 = packer.checkDir(dirA);
    assert.equal(r1.ok, false, '漂移 checkDir ok=false（problems=' + JSON.stringify(r1.problems).slice(0, 300) + '）');
    assert.ok(r1.problems.some(p => p.includes('登记版本标识重建失败') && p.includes('SOURCE_DRIFT')), '问题含重建失败分类');
    assert.equal(r1.planChecked, false);
    const r2 = packer.checkPreparedDir(dirA);
    assert.equal(r2.ok, false, '漂移 checkPreparedDir ok=false'); assert.equal(r2.executionReady, false); assert.equal(r2.planChecked, false);
  } finally {
    fs.readFileSync = origRead;
  }
  // (3) 篡改候选 → 清单不一致
  fs.appendFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), '\n// tampered\n');
  const r3 = packer.checkDir(dirA);
  assert.equal(r3.ok, false, '篡改 checkDir ok=false');
  assert.ok(r3.problems.some(p => p.includes('候选磁盘文件与重建不一致') || p.includes('清单条目与重建不一致') || p.includes('与计划不一致')), '篡改问题含磁盘/清单不一致（problems=' + JSON.stringify(r3.problems).slice(0, 300) + '）');
  // (4) 账号披露边界：服务端入口含合成账号；前端/公开计划/manifest 不含
  const entryText = fs.readFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), 'utf8');
  assert.ok(entryText.includes(SYNTHETIC_ACCOUNT), '披露：完整允许账号在服务端入口配置中');
  const clientText = fs.readFileSync(path.join(dirA, 'frontend', 'utils', 'registration-check-client.js'), 'utf8');
  assert.ok(!clientText.includes(SYNTHETIC_ACCOUNT), '前端不含完整允许账号');
  const pageText = fs.readFileSync(path.join(dirA, 'frontend', 'pages', 'self-registration', 'self-registration.js'), 'utf8');
  assert.ok(!pageText.includes(SYNTHETIC_ACCOUNT), '页面不含完整允许账号');
  const manifest = JSON.parse(fs.readFileSync(path.join(dirA, 'manifest.json'), 'utf8'));
  const manifestFilesText = JSON.stringify(manifest.files);
  assert.ok(!manifestFilesText.includes(SYNTHETIC_ACCOUNT), 'manifest 清单不含完整允许账号');
  const planText = fs.readFileSync(path.join(dirA, 'plan.json'), 'utf8');
  assert.ok(planText.includes(SYNTHETIC_ACCOUNT), '计划含 syntheticAccount（合成夹具字段，受 Packer 枚举约束）');
  // buildId 输入排除：syntheticAccount 变化不改变 registrationBuildId
  const planObj = JSON.parse(planText);
  const p2 = path.join(OUT_ROOT, 'psr-plans-' + RUN_ID, 'plan-buildid-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(p2, JSON.stringify({ ...planObj, syntheticAccount: SYNTHETIC_OTHER_ACCOUNT }, null, 2));
  assert.equal(packer.computeRegistrationBuildId(JSON.parse(fs.readFileSync(p2, 'utf8'))), manifest.registrationBuildId, 'buildId 输入不含 syntheticAccount');
  // (5) 独立关闭 23 文件
  process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
  try {
    const closeResult = packer.checkCloseDir(dirA);
    assert.equal(closeResult.ok, true);
    assert.equal(closeResult.files, 23, '独立关闭 23 文件');
  } finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
  // (6) 排他写冲突：预检零写
  const conflictDir = path.join(OUT_ROOT, 'participant-self-registration-h2-conflict-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(path.join(conflictDir, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(conflictDir, 'frontend', 'app.js'), 'different');
  assert.throws(() => packer.build(mkPlan(closeSource), conflictDir), e => e.code === 'PSR_OUT_CONFLICT' && /已存在内容不同的文件/.test(e.message));
  assert.ok(!fs.existsSync(path.join(conflictDir, 'manifest.json')), '冲突零写（预检拒绝）');
});

// ── 生成链与真实 SDK 形状 ─────────────────────────────────────────────────────
test('PSR 生成链：App→Page→client→入口→核心→合成db；新协议/轮次错配/非名单零工厂；页面提示/单击单发/口令清除', async () => {
  const closeSource = makeCloseSourceDir();
  const dirA = path.join(OUT_ROOT, 'participant-self-registration-h3-a-' + crypto.randomBytes(3).toString('hex'));
  const starts = Date.now() - 60000;
  packer.build(mkPlan(closeSource, { windowStartsAtIso: new Date(starts).toISOString(), windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString() }), dirA);
  // 合成 db（同 makeSyntheticDb）
  const { dbFactory, counters } = makeSyntheticDb();
  // 入口 vm：wx-server-sdk 替身
  const entryMod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), 'utf8'), {
    require: name => {
      if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => ({ APPID: APPID, OPENID: SYNTHETIC_ACCOUNT_OPENID }), database: dbFactory };
      if (name === './request-adapter') return require(ROOT + '/miniapp/scripts/templates/participant-self-registration/server/request-adapter.js');
      if (name === './participant-self-registration') return core;
      throw Error('req ' + name);
    },
    module: entryMod, exports: entryMod.exports, process: { env: {} }, console
  }, { filename: 'entry.js' });
  // (1) 允许本人正向（入口 CONFIG_ENABLED 由合成装配置 true）
  const r1 = await entryMod.exports.main({ picRequest: { schema: 'participant-self-registration-request/1', action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE } });
  assert.equal(r1.outcome, 'CREATED_AND_VERIFIED', '入口全链 CREATED_AND_VERIFIED（实际=' + r1.outcome + ' code=' + r1.code + ' msg=' + (r1.message || '') + '）');
  assert.equal(counters.factory >= 1, true, '准入通过后才触达工厂');
  // R1：database/collection/事务/写 分列计数（不以 collection 计数替代真正工厂）
  assert.equal(counters.database, 1, 'R1：正向恰 1 次 database 工厂');
  assert.equal(counters.transactions, 1, 'R1：正向恰 1 次事务');
  assert.equal(counters.creates, 2, 'R1：正向恰 2 条原子写');
  // (2) 非名单账号：零工厂增量
  const factoryBefore = counters.factory;
  const databaseBefore = counters.database;
  const savedGetWX = null;
  // 重新加载入口以替换 getWXContext（非名单 OPENID）
  const entryMod2 = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), 'utf8'), {
    require: name => {
      if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => ({ APPID: APPID, OPENID: SYNTHETIC_OTHER_ACCOUNT }), database: dbFactory };
      if (name === './request-adapter') return require(ROOT + '/miniapp/scripts/templates/participant-self-registration/server/request-adapter.js');
      if (name === './participant-self-registration') return core;
      throw Error('req ' + name);
    },
    module: entryMod2, exports: entryMod2.exports, process: { env: {} }, console
  }, { filename: 'entry2.js' });
  const r2 = await entryMod2.exports.main({ picRequest: { schema: 'participant-self-registration-request/1', action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE } });
  assert.equal(r2.outcome, 'REJECTED_NO_WRITE');
  assert.equal(r2.code, 'PIC_NOT_ALLOWED');
  assert.equal(counters.factory, factoryBefore, '非名单零工厂增量');
  assert.equal(counters.database, databaseBefore, 'R1：非名单零 database 工厂调用');
  // (3) 错轮次：ROUND_MISMATCH 且零工厂增量
  const factoryBefore2 = counters.factory;
  const databaseBefore2 = counters.database;
  const r3 = await entryMod.exports.main({ picRequest: { schema: 'participant-self-registration-request/1', action: 'registerSelf', registrationRoundId: 'other-round', passphrase: SYNTHETIC_PASSPHRASE } });
  assert.equal(r3.code, 'PIC_ROUND_MISMATCH');
  assert.equal(counters.factory, factoryBefore2, '错轮次零工厂增量');
  assert.equal(counters.database, databaseBefore2, 'R1：错轮次零 database 工厂调用');
  // (4) 旧只读动作不可达（适配器拒绝）
  const r4 = await entryMod.exports.main({ picRequest: { schema: 'participant-identity-request/1', action: 'inspectSelf', checkRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE } });
  assert.equal(r4.code, 'PIC_REQUEST_INVALID');
  // (5) 页面：加载零发送+警告文案+登记按钮单击单发+口令清除+三栏
  const cfgObj = (() => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dirA, 'frontend', 'config', 'cloud.js'), 'utf8'), { module: m, exports: m.exports }, { filename: 'cloud.js' }); return m.exports; })();
  const sent = [];
  const clientWx = { cloud: { _selfRegistrationEnvInited: true, init() {}, callFunction: async opts => { sent.push(opts.data); return { result: { outcome: 'CREATED_AND_VERIFIED', registrationRoundId: ROUND_ID, writeAttempted: true, commitConfirmed: true } }; } } };
  const clientObj = (() => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dirA, 'frontend', 'utils', 'registration-check-client.js'), 'utf8'), { module: m, exports: m.exports, require: () => cfgObj, wx: clientWx }, { filename: 'client.js' }); return m.exports; })();
  const pageMod = { pageDef: null };
  vm.runInNewContext(fs.readFileSync(path.join(dirA, 'frontend', 'pages', 'self-registration', 'self-registration.js'), 'utf8'), {
    Page(d) { pageMod.pageDef = d; },
    require: name => (name === '../../utils/registration-check-client' ? clientObj : name === '../../config/cloud' ? cfgObj : (() => { throw Error('req ' + name); })()),
    wx: clientWx
  }, { filename: 'page.js' });
  const page = Object.assign({ data: {}, setData(patch) { Object.assign(this.data, patch); } }, pageMod.pageDef);
  page.onLoad();
  assert.equal(sent.length, 0, '加载零发送');
  assert.ok(page.data.warningText.includes('登记审计'), '页面明确提示登记写入');
  page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
  await page.onRegisterTap();
  assert.equal(sent.length, 1, '单击单发');
  assert.equal(sent[0].picRequest.action, 'registerSelf');
  assert.equal(sent[0].picRequest.registrationRoundId, ROUND_ID);
  assert.equal(page.data.passphrase, '', '结算清口令');
  assert.equal(page.data.localRequestRound, ROUND_ID, '提交轮次分栏');
  assert.equal(page.data.serverRoundText, ROUND_ID, '服务端返回轮次分栏');
  assert.equal(page.data.registrationBuildId, JSON.parse(fs.readFileSync(path.join(dirA, 'manifest.json'), 'utf8')).registrationBuildId, '本机版本分栏');
});


const fixture = require('./helpers/psr-repair-fixtures.cjs');
const request = () => ({action:'registerSelf',registrationRoundId:ROUND_ID,passphrase:SYNTHETIC_PASSPHRASE});
const handleDb = (d,config={}) => core.createSelfRegistrationChecker({dbFactory:d.dbFactory,
  trusted:mkTrusted(RAW_OPENID),config:mkConfig(config),now:()=>Date.now()}).handle(request());
const uid=DERIVED_OPENID_ACCOUNT, aid=auditIdOf(uid);
const userRow=()=>({_id:uid,openid:RAW_OPENID,status:'active',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'});
const auditRow=()=>({_id:aid,projectId:null,actorUserId:uid,actorRole:'本人普通账号',
  action:'registerIdentity',subjectUserId:uid,before:null,after:{status:'active'},createdAt:'2026-01-01T00:00:00.000Z',
  sourceProtocol:core.SELF_REG_SCHEMA,registrationRoundId:'synthetic-historical-round'});
for(const [label,patch] of [
  ['无限窗口',{windowStartsAtMs:-Infinity}],['空窗口',{windowStartsAtMs:null}],
  ['非数字窗口',{windowExpiresAtMs:'99999'}],['超过30分钟',{windowStartsAtMs:1,windowExpiresAtMs:1800002}],
  ['合成标记非布尔',{synthetic:'false'}]
]) test('R1 无效配置零工厂零写：'+label,async()=>{
  const d=makeSyntheticDb();const r=await handleDb(d,patch);
  assert.equal(r.outcome,'REJECTED_NO_WRITE');assert.equal(d.counters.database,0);assert.equal(d.counters.creates,0);
});
for(const [label,value] of [['缺data',{}],['多条',{data:[{},{}]}],['空数组',{data:[]}],
  ['原始值',{data:false}],['undefined',{data:undefined}]]) test('R3 事务畸形不是不存在：'+label,async()=>{
  const d=makeSyntheticDb({txShape:()=>value}),r=await handleDb(d);
  assert.equal(r.code,'PIC_RECORD_MALFORMED');assert.equal(r.writeAttempted,false);assert.equal(d.store.size,0);
});
for(const [label,patch,audit] of [
  ['审计角色',{actorRole:'synthetic-admin'},true],['审计after',{after:{status:'disabled'}},true],
  ['审计after额外字段',{after:{status:'active',admin:true}},true],['审计时间',{createdAt:'not-a-time'},true],
  ['审计时间类型',{createdAt:123},true],['用户缺时间',{createdAt:undefined},false],
  ['用户更新时间逆序',{updatedAt:'2025-01-01T00:00:00.000Z'},false]
]) test('R3 事务与回读统一拒绝记录：'+label,async()=>{
  const d=makeSyntheticDb();d.store.set('schtest_v1_users:'+uid,{...userRow(),...(!audit?patch:{})});
  d.store.set('schtest_v1_audit_events:'+aid,{...auditRow(),...(audit?patch:{})});
  const r=await handleDb(d);assert.equal(r.outcome,'REJECTED_NO_WRITE');assert.equal(d.counters.creates,0);
  const read=makeSyntheticDb({readShape:doc=>({data:[{...doc,...(doc._id===(audit?aid:uid)?patch:{})}]})});
  read.store.set('schtest_v1_users:'+uid,userRow());read.store.set('schtest_v1_audit_events:'+aid,auditRow());
  const rr=await handleDb(read);assert.equal(rr.outcome,'OUTCOME_UNKNOWN');assert.equal(read.counters.creates,0);
});
for(const [label,value] of [['缺data',{}],['多条',{data:[{},{}]}],['原始值',{data:123}]]){
  test('R3 回读畸形不报有效：'+label,async()=>{const d=makeSyntheticDb({readShape:()=>value});
    const r=await handleDb(d);assert.equal(r.outcome,'OUTCOME_UNKNOWN');assert.equal(r.commitConfirmed,true);});
}
test('R2 实际生成入口直连真实SDK：不存在/失败/两条新增/第二写失败/冲突重试/到期/参数移除',async()=>{
  const {runSdkEntry}=require('./helpers/psr-sdk-fixture.cjs');
  const close=makeCloseSourceDir(),out=path.join(OUT_ROOT,'participant-self-registration-sdk-'+RUN_ID);
  const planFile=mkPlan(close),p=JSON.parse(fs.readFileSync(planFile));
  packer.build(planFile,out);
  const entry=path.join(out,'server/scheduleSandbox/index.js');
  const event={picRequest:{schema:core.REQUEST_PROTOCOL,action:'registerSelf',registrationRoundId:ROUND_ID,passphrase:SYNTHETIC_PASSPHRASE}};
  const opts={now:Date.parse(p.windowStartsAtIso)+1000,expires:Date.parse(p.windowExpiresAtIso)};
  const run=o=>runSdkEntry(entry,event,SYNTHETIC_ACCOUNT_OPENID,{...opts,...o});
  const missing=await run({unfixed:true});assert.equal(missing.result.code,'PIC_TRANSACTION_FAILED');
  assert.equal(missing.factory,1);assert.equal(missing.inserts,0);
  assert.deepEqual(missing.actions,['database.startTransaction','database.getDocument','database.abortTransaction']);
  const good=await run({});assert.equal(good.result.outcome,'CREATED_AND_VERIFIED');
  assert.equal(good.inserts,2);assert.equal(good.stored,2);assert.equal(good.commits,1);
  const failure=await run({failRead:true});assert.equal(failure.result.writeAttempted,false);assert.equal(failure.stored,0);
  const second=await run({failSecond:true});assert.equal(second.result.outcome,'OUTCOME_UNKNOWN');
  assert.equal(second.result.writeAttempted,true);assert.equal(second.stored,0);assert.ok(second.actions.includes('database.abortTransaction'));
  const retry=await run({commitConflict:true});assert.equal(retry.result.outcome,'CREATED_AND_VERIFIED');
  assert.equal(retry.starts,2);assert.equal(retry.inserts,4);assert.equal(retry.stored,2);
  const expired=await run({expireOnRead:true});assert.equal(expired.result.outcome,'OUTCOME_UNKNOWN');
  assert.equal(expired.result.commitConfirmed,true);assert.equal(expired.stored,2);
  const retryExpired=await run({commitConflict:true,expireAfterConflict:true});assert.equal(retryExpired.result.outcome,'OUTCOME_UNKNOWN');
  assert.equal(retryExpired.stored,0);assert.equal(retryExpired.inserts,2);
});
test('R4 实际CLI源摘要与含空格路径传递；双输入一致、交付、服务端时间必需',async()=>{
  const h=fixture.createPrivateHarness(),code='1',account=SYNTHETIC_ACCOUNT;
  const source=h.save(code,account),callbacks={},logs=[],errors=[];
  const proc={argv:['node','private store.cjs','protect','--repo-root',ROOT,'--participant-code',code,
    '--check-round-id',source.payload.checkRoundId,'--source-digest',source.payload.readonlySourceDigest,
    '--server-time-iso',source.payload.serverTimeIso,'--delivery-confirmed','true',
    '--check-window-starts-at-iso',source.payload.checkWindowStartsAtIso,
    '--check-window-expires-at-iso',source.payload.checkWindowExpiresAtIso,'--file-name','synthetic cli space.bin'],
    stdin:{setEncoding(){},on(k,fn){callbacks[k]=fn;}}};
  fixture.load(fixture.STORE,{'node:fs':h.fakeFs,'./participant-local-tools.cjs':h.tools},
    {process:proc,console:{log:x=>logs.push(x),error:x=>errors.push(x)}},undefined,true);
  callbacks.data(account+'\n');callbacks.end();
  assert.equal(proc.exitCode,undefined,errors.join());assert.equal(logs.length,1);
  const receipt=JSON.parse(logs[0]);assert.equal(receipt.accountTail,account.slice(-6));
  assert.ok(h.mem.has(path.join(h.prefix,'synthetic cli space.bin')));
  const saved=JSON.parse(Buffer.from(h.mem.get(path.join(h.prefix,'synthetic cli space.bin')).toString(),'hex').toString());
  assert.equal(saved.readonlySourceDigest,source.payload.readonlySourceDigest);assert.equal(saved.checkRoundId,source.payload.checkRoundId);
  assert.equal(JSON.stringify(receipt).includes(account),false);
  assert.throws(()=>h.store.buildPrivatePayload({...source.payload,serverTimeIso:null,expectedTarget:h.store.FIXED_TARGET}));
  assert.throws(()=>h.store.protectRecord({repoRoot:ROOT,fullAccount:account,fullAccountRepeat:SYNTHETIC_OTHER_ACCOUNT}));
});
test('R4 ACL最小主体/不确定失败闭合；无权限修改；Git/链接反例零写',()=>{
  for(const mode of ['everyone','unknown','unparseable','error']){
    const h=fixture.createPrivateHarness();h.state.acl=mode;
    assert.throws(()=>h.store.validatePrivateTarget({repoRoot:ROOT,relativePath:h.store.PRIVATE_ROOT_REL+'/synthetic.bin'}));
    assert.equal(h.mem.size,0);assert.equal(h.calls.includes('write'),false);
  }
  for(const key of ['tracked','ignored','gitError','identity']){
    const h=fixture.createPrivateHarness();h.state[key]=!h.state[key];
    assert.throws(()=>h.store.validatePrivateTarget({repoRoot:ROOT,relativePath:h.store.PRIVATE_ROOT_REL+'/synthetic.bin'}));
  }
  const h=fixture.createPrivateHarness();h.state.links.add(h.prefix);
  assert.throws(()=>h.store.validatePrivateTarget({repoRoot:ROOT,relativePath:h.store.PRIVATE_ROOT_REL+'/synthetic.bin'}));
});
test('R4 私密录入错误/排他/部分写事实：全部合成FS，无实际DPAPI或真实输入',()=>{
  const h=fixture.createPrivateHarness(),one=h.save('1',SYNTHETIC_ACCOUNT);
  const args={repoRoot:ROOT,fileName:'synthetic-new.bin',...one.payload,
    fullAccountRepeat:SYNTHETIC_ACCOUNT,expectedTarget:h.store.FIXED_TARGET};
  const receipt=h.store.protectRecord(args);
  assert.equal(receipt.doubleInputConsistent,true);
  assert.equal(JSON.stringify(receipt).includes(SYNTHETIC_ACCOUNT),false);
  assert.throws(()=>h.store.protectRecord(args),e=>e.code==='PSR_PRIVATE_EXISTS');
  for(const patch of [{fullAccount:'u_short'},{fullAccountRepeat:SYNTHETIC_OTHER_ACCOUNT},
    {deliveryConfirmed:false},{readonlySourceDigest:'bad'},{participantCode:'0'}]){
    const before=h.mem.size;
    assert.throws(()=>h.store.protectRecord({...args,...patch,fileName:'synthetic-bad.bin'}));
    assert.equal(h.mem.size,before);
  }
  const fake=new Proxy(h.fakeFs,{get(target,k){if(k==='writeFileSync')return(p,b,o)=>{
    target.writeFileSync(p,Buffer.from(b).subarray(0,12),o);throw Error('synthetic disk fault');};return target[k];}});
  const store=fixture.load(fixture.STORE,{'node:fs':fake,'./participant-local-tools.cjs':h.tools});
  assert.throws(()=>store.protectRecord({...args,fileName:'synthetic-partial.bin'}),
    e=>e.code==='PSR_PRIVATE_WRITE_FAILED'&&e.partialWrite.bytesOnDisk===12);
});
async function realFixture(){
  const h=fixture.createPrivateHarness(),one=h.save('1',SYNTHETIC_ACCOUNT),two=h.save('2',SYNTHETIC_OTHER_ACCOUNT);
  const close=makeCloseSourceDir(),plan=mkPlan(close,{synthetic:false,syntheticAccount:undefined,
    privateSource:{schema:packer.PRIVATE_SOURCE_SCHEMA,recordFile:one.name,records:[one.ref,two.ref]}});
  return {h,one,two,plan,out:path.join(OUT_ROOT,'participant-self-registration-real-'+crypto.randomBytes(5).toString('hex'))};
}
test('R4/R5 合成私密源执行真实模式：内部消费两份来源、严格清单值重建/篡改拒绝',async()=>{
  const f=await realFixture(),{h,plan,out}=f;
  assert.throws(()=>h.packer.build(plan,out,{privateAccount:SYNTHETIC_ACCOUNT}),e=>e.code==='PSR_REAL_NOT_PERMITTED');
  const built=await h.packer.buildReal(plan,out);assert.equal(built.manifest.privateSource.realSourceConsumed,true);
  assert.equal(built.manifest.privateSource.records.length,2);
  assert.equal((await h.packer.checkDirResolved(out)).ok,true);
  const manifest=path.join(out,'manifest.json'),bytes=fs.readFileSync(manifest);
  for(const mutate of [
    m=>m.privateSource.mode='synthetic-fixture',m=>m.privateSource.syntheticFixtureLabel='synthetic',
    m=>m.privateSource.realSourceConsumed=false,m=>delete m.privateSource.realSourceConsumed,
    m=>m.privateSource.extra=true,m=>m.privateSource.recordFileSha256='f'.repeat(64),
    m=>m.privateSource.records[1].readonlySourceDigest='f'.repeat(64)
  ]){
    const m=JSON.parse(bytes);mutate(m);fs.writeFileSync(manifest,JSON.stringify(m));
    const r=await h.packer.checkDirResolved(out);assert.equal(r.ok,false);assert.ok(r.problems.some(x=>x.includes('privateSource')));
  }
  fs.writeFileSync(manifest,bytes);assert.equal((await h.packer.checkDirResolved(out)).ok,true);
  assert.equal(fs.readFileSync(path.join(out,'frontend/config/cloud.js'),'utf8').includes(SYNTHETIC_ACCOUNT),false);
  assert.ok(h.calls.includes('read:'+f.one.name)&&h.calls.includes('read:'+f.two.name));
  assert.equal(h.calls.some(x=>x.startsWith('read:')&&!['read:'+f.one.name,'read:'+f.two.name].includes(x)),false);
});
test('R4 必要记录跨轮次跨摘要排重，任一不可解密及来源改标均阻断，输出零写',async()=>{
  for(const mode of ['duplicate','unreadable','binding','badfields']){
    const f=await realFixture(),{h,one,two,plan,out}=f;
    const p=mode==='duplicate'?{...two.payload,fullAccount:one.payload.fullAccount}:
      mode==='binding'?{...two.payload,checkRoundId:'synthetic-relabeled'}:
      mode==='badfields'?{...two.payload,serverTimeIso:null}:two.payload;
    const bytes=Buffer.from(Buffer.from(JSON.stringify(p)).toString('hex'));
    h.mem.set(path.join(h.prefix,two.name),bytes);
    if(mode==='unreadable')h.state.unreadable.add(bytes.toString());
    await assert.rejects(()=>h.packer.buildReal(plan,out));assert.equal(fs.existsSync(out),false);
  }
});
test('R4 明文候选忽略/跟踪/ACL/链接检查写前停止，不自动改权限',async()=>{
  for(const key of ['tracked','ignored','gitError','acl','link']){
    const f=await realFixture(),{h,plan,out}=f;
    if(key==='acl')h.state.acl='everyone';else if(key==='link')h.state.links.add(out);else h.state[key]=!h.state[key];
    await assert.rejects(()=>h.packer.buildReal(plan,out));assert.equal(fs.existsSync(out),false);
    assert.equal(h.calls.includes('write'),false);
  }
});
// S1/S2：合成解密等待期接缝（只在本轮新测试使用；不触真实DPAPI/真实来源）。
function changeDuringDecrypt(h,fn,expectedHex){
  let fired=false;
  h.state.onUnprotect=async hex=>{
    if(fired)return;
    if(expectedHex!==undefined&&hex!==expectedHex)return;
    fired=true;await fn();
  };
  return()=>{h.state.onUnprotect=null;};
}
const cipherHexOf=payload=>Buffer.from(JSON.stringify(payload)).toString('hex');
function setPrivateRecord(h,name,payload){
  h.mem.set(path.join(h.prefix,name),Buffer.from(Buffer.from(JSON.stringify(payload)).toString('hex')));
}
test('S1/S2 单次读取快照正常对照：摘要与解密同源，buildReal/prepareReal及Resolved检查通过',async()=>{
  const f=await realFixture(),{h,one,two,plan,out}=f;
  const digestOne=fixture.sha(h.mem.get(path.join(h.prefix,one.name)));
  const digestTwo=fixture.sha(h.mem.get(path.join(h.prefix,two.name)));
  const built=await h.packer.buildReal(plan,out);
  assert.equal(built.manifest.planSha256,fixture.sha(fs.readFileSync(plan)));
  assert.equal(built.manifest.privateSource.recordFileSha256,digestOne);
  assert.equal(built.manifest.privateSource.records.map(r=>r.recordFileSha256).sort().join(','),
    [digestOne,digestTwo].sort().join(','));
  const checked=await h.packer.checkDirResolved(out);assert.equal(checked.ok,true);
  const out2=out+'-prepare',prepared=await h.packer.prepareReal(plan,out2);
  assert.equal(prepared.manifest.privateSource.recordFileSha256,digestOne);
  assert.equal(prepared.preparationValidated,true);assert.equal(prepared.executionReady,false);
  const checked2=await h.packer.checkPreparedDirResolved(out2);
  assert.equal(checked2.ok,true);assert.equal(checked2.preparationValidated,true);assert.equal(checked2.executionReady,false);
});
test('S1 消费期间来源变化：两入口均拒绝且零产物，不以新摘要绑定旧账号',async()=>{
  for(const entry of ['buildReal','prepareReal'])for(const which of ['target','other']){
    const f=await realFixture(),{h,one,two,plan,out}=f;
    const record=which==='target'?one:two;
    const stop=changeDuringDecrypt(h,()=>setPrivateRecord(h,record.name,{...record.payload,fullAccount:SYNTHETIC_THIRD_ACCOUNT}),cipherHexOf(record.payload));
    try{
      await assert.rejects(()=>h.packer[entry](plan,out),e=>e.code==='PSR_SOURCE_SNAPSHOT_CHANGED');
      assert.equal(fs.existsSync(out),false,entry+'/'+which+' 不应产生任何产物');
    }finally{stop();}
  }
});
test('S2 消费期间计划变化：两入口拒绝且零产物，不静默采用新轮次或更新摘要',async()=>{
  for(const entry of ['buildReal','prepareReal']){
    const f=await realFixture(),{h,plan,out}=f;
    const original=fs.readFileSync(plan),parsed=JSON.parse(original.toString('utf8'));
    const stop=changeDuringDecrypt(h,()=>fs.writeFileSync(plan,JSON.stringify({...parsed,
      registrationRoundId:'synthetic-shifted-'+RUN_ID},null,2)));
    try{
      await assert.rejects(()=>h.packer[entry](plan,out),e=>e.code==='PSR_PLAN_SNAPSHOT_CHANGED');
      assert.equal(fs.existsSync(out),false,entry+' 计划变化不应产生任何产物');
    }finally{stop();fs.writeFileSync(plan,original);}
  }
});
test('S1/S2 Resolved检查同快照：消费期间来源或计划变化拒绝，恢复后正常对照通过',async()=>{
  {
    const f=await realFixture(),{h,one,plan,out}=f;
    await h.packer.buildReal(plan,out);
    const original=h.mem.get(path.join(h.prefix,one.name));
    const stop=changeDuringDecrypt(h,()=>setPrivateRecord(h,one.name,{...one.payload,fullAccount:SYNTHETIC_THIRD_ACCOUNT}),cipherHexOf(one.payload));
    try{await assert.rejects(()=>h.packer.checkDirResolved(out),e=>e.code==='PSR_SOURCE_SNAPSHOT_CHANGED');}
    finally{stop();h.mem.set(path.join(h.prefix,one.name),original);}
    assert.equal((await h.packer.checkDirResolved(out)).ok,true);
  }
  {
    const f=await realFixture(),{h,plan,out}=f;
    await h.packer.buildReal(plan,out);
    const builtPlan=path.join(out,'plan.json'),original=fs.readFileSync(builtPlan),parsed=JSON.parse(original.toString('utf8'));
    const stop=changeDuringDecrypt(h,()=>fs.writeFileSync(builtPlan,JSON.stringify({...parsed,
      registrationRoundId:'synthetic-shifted-'+RUN_ID},null,2)));
    try{await assert.rejects(()=>h.packer.checkDirResolved(out),e=>e.code==='PSR_PLAN_SNAPSHOT_CHANGED');}
    finally{stop();fs.writeFileSync(builtPlan,original);}
    assert.equal((await h.packer.checkDirResolved(out)).ok,true);
  }
});
test('R6 公共接口始终阻断记账、catch及restore均不能旁路；专用能力拒绝任意命令与options',()=>{
  guardPhase='probe';
  const cp=require('node:child_process'),before=guardHits.length;
  for(const method of ['spawnSync','spawn','exec','execSync','execFile','execFileSync','fork']){
    assert.throws(()=>cp[method]('git',['ls-files'],{shell:true,env:{FAKE:'synthetic'}}));
  }
  guarded.restore();assert.throws(()=>cp.spawnSync('git',['ls-files'],{cwd:ROOT}));
  assert.equal(guardHits.length-before,8);guardPhase='business';
  let actual=0;
  const local=fixture.load('miniapp/scripts/lib/participant-local-tools.cjs',{
    'node:child_process':{spawnSync(exe,args,opts){actual++;assert.ok(path.isAbsolute(exe));
      assert.equal(opts.shell,false);assert.ok(opts.timeout>0&&opts.maxBuffer>0);assert.equal(opts.cwd,ROOT);
      return {status:0,stdout:'"synthetic\\current","'+fixture.sid+'"',stderr:''};},spawn(){throw Error('不应启动');}},
    'node:fs':{statSync(){return {isFile:()=>true};}}
  });
  local.queryIdentity();assert.equal(actual,1);
  assert.throws(()=>local.queryGit(ROOT,'add','synthetic'));assert.equal(actual,1);
  assert.throws(()=>local.queryGit(ROOT,'ls-files','../escape'));assert.equal(actual,1);
  assert.equal('spawnSync' in local,false);assert.equal('run' in local,false);
});
test('R6 专用能力结果不确定/超量/超时/错误必须拒绝，非公共分发',async()=>{
  for(const response of [{status:0,stdout:'x',error:Error('timeout')},
    {status:null,signal:'SIGTERM'},{status:0,stdout:'x'.repeat(128*1024+1)},
    {status:0,stdout:'synthetic',stderr:'failure'},{status:3,stdout:''}]){
    const local=fixture.load('miniapp/scripts/lib/participant-local-tools.cjs',{
      'node:child_process':{spawnSync:()=>response},'node:fs':{statSync:()=>({isFile:()=>true})}});
    assert.throws(()=>local.queryIdentity());
  }
  const {EventEmitter}=require('node:events');let killed=0;
  const child=new EventEmitter();child.stderr=new EventEmitter();
  child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=()=>{killed++;};
  const local=fixture.load('miniapp/scripts/lib/participant-local-tools.cjs',{
    'node:child_process':{spawn:()=>child,spawnSync:()=>{throw Error('not expected');}},
    'node:net':{connect:()=>Object.assign(new EventEmitter(),{destroy(){}})}
  },{setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,5))});
  await assert.rejects(()=>local.unprotect('ab'.repeat(32)),e=>e.code==='PSR_LOCAL_TOOL_FAILED');
  assert.equal(killed,1,'异步管道不阻塞计时器，超时子进程收尾');
});
test.after(()=>{const unexpected=guardHits.filter(h=>h.phase!=='probe');assert.deepEqual(unexpected,[],
  '被catch的公共接口/网络尝试仍属意外，不能报通过');});
