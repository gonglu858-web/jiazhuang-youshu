// 指定本人登记与私密输入本地实现证据（2026-10-21 任务 §5；合成数据；非平台验证、非执行批准）。
// 依据：docs/CodeBuddy任务-指定本人登记与私密输入本地实现-20261021.md §1–§6 与
// docs/Codex方案-指定本人登记与私密编号输入-20261021.md §6。
// 守卫在业务 require 之前安装；除显式探针外一切命中（含被 catch 者）计入意外；
// 子进程（自反例）经共享受审辅助模块 runner（回执/超时/有界输出/白名单）核验；
// 全部实际计数经真实判定出口 verdictFor 决定 ok/exit。历史证据不回写。
// PS1 私密输入器 SelfTestCheck 由测试文件覆盖（证据不启动非白名单进程，如实披露）。
'use strict';
const root = 'C:/Users/30591/Documents/ChatGPT/装修进度验收APP';
const SELF = __filename;
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const guardHelper = require(root + '/miniapp/tests/helpers/pic-guard-runner.cjs');
const psrGuard = require(root + '/miniapp/tests/helpers/psr-guard-runner.cjs');
const privateStoreEarly = require(root + '/miniapp/scripts/lib/participant-private-store.cjs');

const outIdx = process.argv.indexOf('--out');
const outPath = outIdx !== -1 ? path.resolve(process.argv[outIdx + 1] || '') : null;
const fault = process.env.PIC_PREP_EVIDENCE_FAULT || null; // 变量名与受审 runner 的 extraEnv 白名单一致

const guardHits = [];
let phase = 'unexpected';
// 适配层：共享守卫 + 本地只读工具白名单（git 只读查询/icacls 只读/固定 DPAPI 脚本；全记账披露）
const guarded = psrGuard.installParentGuardsWithLocalTools({
    hits: guardHits, getPhase: () => phase, allowedScripts: [SELF],
    allowedScriptHashes: [sha(privateStoreEarly.DPAPI_PROTECT_SCRIPT), sha(privateStoreEarly.DPAPI_UNPROTECT_PIPE_SCRIPT)]
  });
const guard = guarded.guard;
const toolCalls = guarded.toolCalls;

if (fault === 'earlyRequire') {
  try { require('node:https').request('https://example.invalid'); } catch (_) {}
}

const core = require(root + '/miniapp/scripts/lib/participant-self-registration.cjs');
const packer = require(root + '/miniapp/scripts/package-participant-self-registration.cjs');
const privateStore = require(root + '/miniapp/scripts/lib/participant-private-store.cjs');
const business = require(root + '/miniapp/scripts/package-business-test.cjs');

function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
const sha256Buffer = b => crypto.createHash('sha256').update(b).digest('hex');
const ROOT = root;
const OUT_ROOT = path.join(root, 'artifacts', 'schedule-sandbox', 'business-test');
const REPO_ROOT = root;
const RUN_ID = 'ev' + crypto.randomBytes(4).toString('hex');
const APPID = 'wxfb4db1615ac15531';
const ENV_ID = 'cloud1-d8gcq5ag39d847723';
const SYNTHETIC_PASSPHRASE = 'synthetic-self-reg-passphrase-' + RUN_ID;
const PASSPHRASE_DIGEST = sha(SYNTHETIC_PASSPHRASE);
const SYNTHETIC_ACCOUNT_OPENID = 'synthetic-self-reg-account-' + RUN_ID;
const SYNTHETIC_ACCOUNT = core.deriveUserId(APPID, SYNTHETIC_ACCOUNT_OPENID);
const SYNTHETIC_OTHER_ACCOUNT = 'u_' + sha('synthetic-self-reg-other-' + RUN_ID).slice(0, 40);
const RAW_OPENID = 'synthetic-openid-raw-' + RUN_ID;
const DERIVED_OPENID_ACCOUNT = core.deriveUserId(APPID, RAW_OPENID);
const ROUND_ID = 'synthetic-self-reg-' + RUN_ID;

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

const auditIdOf = userId => core.deriveRegistrationAuditId(APPID, ENV_ID, userId);

function makeCloseSourceDir() {
  const round = 'synthetic-close-src-' + RUN_ID + '-' + crypto.randomBytes(2).toString('hex');
  const planPath = path.join(OUT_ROOT, 'psre-plan-src-' + RUN_ID + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(planPath, JSON.stringify({
    schema: 'business-test-plan/1', window: 'P', synthetic: true, businessRoundId: round,
    windowNo: 'P-01', appId: APPID, envId: ENV_ID,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(k => [k, { userId: 'u_' + sha(APPID + ':synthetic-' + k + RUN_ID).slice(0, 40), source: 'synthetic' }])),
    projectReadyMarker: 'ready-' + round, windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
  }, null, 2));
  if (fault === 'duringCloseSource') {
    try { require('node:https').request('https://example.invalid'); } catch (_) {} // 反例注入：关闭来源构建期间的被 catch 尝试（计入意外）
  }
  const outDir = path.join(OUT_ROOT, 'psre-close-source-' + RUN_ID + '-' + crypto.randomBytes(3).toString('hex'));
  const built = business.build('P', planPath, outDir);
  assert.equal(business.checkCloseDir(built.outDir).ok, true);
  return built.outDir;
}
function mkPlan(closeSource, overrides) {
  fs.mkdirSync(path.join(OUT_ROOT, 'psre-plans-' + RUN_ID), { recursive: true });
  const file = path.join(OUT_ROOT, 'psre-plans-' + RUN_ID, 'plan-' + crypto.randomBytes(4).toString('hex') + '.json');
  const starts = (overrides && overrides.__startsMs) || Date.now() - 60000;
  const plan = Object.assign({
    schema: packer.PLAN_SCHEMA, synthetic: true, registrationRoundId: ROUND_ID, participantCode: '1',
    appId: APPID, envId: ENV_ID, functionName: 'scheduleSandbox',
    usersCollection: 'schtest_v1_users', auditCollection: 'schtest_v1_audit_events',
    passphraseDigest: PASSPHRASE_DIGEST,
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString(),
    closeSourceDir: closeSource, requestProtocol: packer.REQUEST_PROTOCOL,
    syntheticAccount: SYNTHETIC_ACCOUNT, note: '合成夹具计划（非真实口令/非真实编号）'
  }, overrides || {});
  delete plan.__startsMs;
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}
function makeSyntheticDb({ failCreatesAfter = null, failCommit = false, rollbackOnFailure = false } = {}) {
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
                  return { data: [projected] };
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

const mkTrusted = openid => ({ appId: APPID, envId: ENV_ID, OPENID: openid });
async function main() {
  // ── 自反例/短流程模式（PIC_PREP_EVIDENCE_FAULT 存在即短流程）────────────────
  if (fault !== null) {
    phase = 'probe';
    assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
    assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
    phase = 'unexpected';
    if (fault === 'duringCloseSource') { makeCloseSourceDir(); }
    if (fault === 'businessHit') { try { require('node:https').request('https://example.invalid'); } catch (_) {} }
    if (fault === 'nonWhitelistSpawn') { try { require('node:child_process').execSync('echo synthetic-non-whitelist'); } catch (_) {} }
    if (fault === 'publicSpawnBypass') { try { require('node:child_process').spawn(__filename, []); } catch (_) {} }
    const counters = { probes: guardHits.filter(h => h.phase === 'probe').length, parentUnexpected: guardHits.filter(h => h.phase !== 'probe').length, childUnexpectedTotal: 0, receiptFailures: 0 };
    const verdict = guardHelper.verdictFor(counters);
    console.log(JSON.stringify({ schema: 'codebuddy-self-registration-evidence-v1-selftest/1', faultMode: fault, guardCounters: counters, verdict }, null, 2));
    process.exitCode = verdict.exitCode;
    return;
  }

  // ── 显式探针 ─────────────────────────────────────────────────────────────
  phase = 'probe';
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  phase = 'unexpected';

  const closeSource = makeCloseSourceDir();
  const privateFileName = 'evidence-' + RUN_ID + '.bin';
  const closeSourceDigest = privateStore.computeCloseSourceDigest(closeSource);
  const sectionA = {};
  // ── A：私密存储（DPAPI 往返/排他新建/净化回执/写前拒绝；PS1 SelfTestCheck 由测试文件覆盖并披露）──
  {
    const privDir = path.join(REPO_ROOT, 'artifacts', 'schedule-sandbox', '.participant-private');
    fs.mkdirSync(privDir, { recursive: true });
    const fileName = privateFileName;
    const receipt = privateStore.protectRecord({ repoRoot: REPO_ROOT, fileName, participantCode: '1', fullAccount: SYNTHETIC_ACCOUNT, fullAccountRepeat: SYNTHETIC_ACCOUNT, appId: APPID, envId: ENV_ID, roundId: ROUND_ID, serverTimeIso: null, closeSourceDir: closeSource, expectedTarget: privateStore.FIXED_TARGET, windowStartsAtIso: '2030-01-01T00:00:00Z', windowExpiresAtIso: '2030-01-01T00:10:00Z', sourceDigest: closeSourceDigest, deliveryConfirmed: true });
    const record = await privateStore.readRecordAsync({ repoRoot: REPO_ROOT, relativePath: privateStore.PRIVATE_ROOT_REL + '/' + fileName });
    sectionA.dpapiRoundtrip = record.fullAccount === SYNTHETIC_ACCOUNT;
    sectionA.exclusive = 'PSR_PRIVATE_EXISTS';
    let threw = '';
    try { privateStore.protectRecord({ repoRoot: REPO_ROOT, fileName, participantCode: '1', fullAccount: SYNTHETIC_OTHER_ACCOUNT, fullAccountRepeat: SYNTHETIC_OTHER_ACCOUNT, appId: APPID, envId: ENV_ID, roundId: ROUND_ID, serverTimeIso: null, closeSourceDir: closeSource, expectedTarget: privateStore.FIXED_TARGET, windowStartsAtIso: '2030-01-01T00:00:00Z', windowExpiresAtIso: '2030-01-01T00:10:00Z', sourceDigest: closeSourceDigest, deliveryConfirmed: true }); } catch (e) { threw = e.code || ''; }
    sectionA.exclusiveRejected = threw === 'PSR_PRIVATE_EXISTS';
    sectionA.receiptSanitized = !JSON.stringify(receipt).includes(SYNTHETIC_ACCOUNT);
    sectionA.tailOnly = receipt.accountTail === SYNTHETIC_ACCOUNT.slice(-6);
    sectionA.boundary = 'PSR_PRIVATE_PATH_BOUNDARY';
    let bCode = '';
    try { privateStore.validatePrivateTarget({ repoRoot: REPO_ROOT, relativePath: 'docs/x.bin' }); } catch (e) { bCode = e.code || ''; }
    sectionA.boundaryRejected = bCode === sectionA.boundary;
    // R4：来源摘要必须与受控关闭来源重算一致；交付确认必须显式
    let sourceCode = '';
    try { privateStore.buildPrivatePayload({ participantCode: '1', fullAccount: SYNTHETIC_ACCOUNT, appId: APPID, envId: ENV_ID, roundId: ROUND_ID, serverTimeIso: null, sourceDigest: sha('wrong'), deliveryConfirmed: true, closeSourceDir: closeSource, expectedTarget: privateStore.FIXED_TARGET, windowStartsAtIso: '2030-01-01T00:00:00Z', windowExpiresAtIso: '2030-01-01T00:10:00Z' }); } catch (e) { sourceCode = e.code || ''; }
    sectionA.sourceBindingRejected = sourceCode === 'PSR_PRIVATE_SOURCE';
    let deliveryCode = '';
    try { privateStore.buildPrivatePayload({ participantCode: '1', fullAccount: SYNTHETIC_ACCOUNT, appId: APPID, envId: ENV_ID, roundId: ROUND_ID, serverTimeIso: null, sourceDigest: closeSourceDigest, deliveryConfirmed: false, closeSourceDir: closeSource, expectedTarget: privateStore.FIXED_TARGET, windowStartsAtIso: '2030-01-01T00:00:00Z', windowExpiresAtIso: '2030-01-01T00:10:00Z' }); } catch (e) { deliveryCode = e.code || ''; }
    sectionA.deliveryRequired = deliveryCode === 'PSR_PRIVATE_INPUT';
    // 同尾不同账号
    const flipped = SYNTHETIC_ACCOUNT.slice(-7, -6) === '0' ? '1' : '0';
    const sameTailOther = SYNTHETIC_ACCOUNT.slice(0, -7) + flipped + SYNTHETIC_ACCOUNT.slice(-6);
    sectionA.sameTailDifferentAccount = privateStore.tailOf(sameTailOther) === privateStore.tailOf(SYNTHETIC_ACCOUNT) && sameTailOther !== SYNTHETIC_ACCOUNT;
    assert.equal(sectionA.dpapiRoundtrip, true); assert.equal(sectionA.exclusiveRejected, true);
    assert.equal(sectionA.receiptSanitized, true); assert.equal(sectionA.tailOnly, true);
    assert.equal(sectionA.boundaryRejected, true); assert.equal(sectionA.sameTailDifferentAccount, true);
    assert.equal(sectionA.sourceBindingRejected, true); assert.equal(sectionA.deliveryRequired, true);
  }

  // ── B：非名单/缺身份/错App/错env/错轮次/错口令/窗口过期 → 零工厂零事务零写 ──
  const sectionB = { cases: [] };
  {
    const cases = [
      { name: '非名单账号', trusted: mkTrusted('synthetic-not-allowed-openid'), config: mkConfig(), req: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_NOT_ALLOWED' },
      { name: '缺身份', trusted: { appId: APPID, envId: ENV_ID, OPENID: '' }, config: mkConfig(), req: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_REQUEST_INVALID' },
      { name: '错AppID', trusted: { appId: 'wxfb4db1615ac15532', envId: ENV_ID, OPENID: 'synthetic-x' }, config: mkConfig(), req: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_REQUEST_INVALID' },
      { name: '错轮次', trusted: mkTrusted(RAW_OPENID), config: mkConfig(), req: { action: 'registerSelf', registrationRoundId: 'other-round', passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_ROUND_MISMATCH' },
      { name: '错口令', trusted: mkTrusted(RAW_OPENID), config: mkConfig(), req: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: 'wrong-passphrase' }, expectCode: 'PIC_PASSPHRASE_MISMATCH' },
      { name: '窗口过期', trusted: mkTrusted(RAW_OPENID), config: mkConfig({ windowExpiresAtMs: Date.now() - 1000, synthetic: false }), req: { action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }, expectCode: 'PIC_WINDOW_EXPIRED' }
    ];
    for (const c of cases) {
      const { dbFactory, counters } = makeSyntheticDb();
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: c.trusted, config: c.config, now: () => Date.now() });
      const r = await checker.handle(c.req);
      const rec = { name: c.name, outcome: r.outcome, code: r.code, factory: counters.factory, transactions: counters.transactions, creates: counters.creates };
      sectionB.cases.push(rec);
      assert.equal(r.outcome, 'REJECTED_NO_WRITE', c.name + ' REJECTED');
      assert.equal(r.code, c.expectCode, c.name + ' 分类');
      assert.equal(counters.factory, 0, c.name + ' 零工厂'); assert.equal(counters.transactions, 0, c.name + ' 零事务');
      assert.equal(counters.creates, 0, c.name + ' 零写');
    }
  }

  // ── C：原子两条/回滚/并发；无效状态零写 ──────────────────────────────────
  const sectionC = {};
  {
    { // 新账号恰两条并回读
      const { dbFactory, counters, store } = makeSyntheticDb();
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
      sectionC.created = { outcome: r.outcome, creates: counters.creates, userOk: store.get('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT).status === 'active', auditOk: Boolean(store.get('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT))) };
      assert.equal(sectionC.created.outcome, 'CREATED_AND_VERIFIED'); assert.equal(sectionC.created.creates, 2);
      assert.equal(sectionC.created.userOk, true); assert.equal(sectionC.created.auditOk, true);
    }
    { // 已有有效用户+无本包审计 → ALREADY_ACTIVE 零新增
      const { dbFactory, counters, store } = makeSyntheticDb();
      store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: RAW_OPENID, status: 'active', createdAt: '2020-01-01', updatedAt: '2020-01-01' });
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
      sectionC.alreadyActive = { outcome: r.outcome, creates: counters.creates };
      assert.equal(sectionC.alreadyActive.outcome, 'ALREADY_ACTIVE'); assert.equal(sectionC.alreadyActive.creates, 0);
    }
    { // 停用/缺字段/孤立审计/主体不符/审计冲突 → 零写
      const zero = async setup => {
        const { dbFactory, counters, store } = makeSyntheticDb();
        setup(store);
        const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
        const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
        return { outcome: r.outcome, code: r.code, creates: counters.creates };
      };
      sectionC.zeroWrite = {
        disabled: await zero(s => s.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: 'x', status: 'disabled', createdAt: 't', updatedAt: 't' })),
        missingFields: await zero(s => s.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT })),
        orphanAudit: await zero(s => s.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), action: 'registerIdentity', subjectUserId: DERIVED_OPENID_ACCOUNT })),
        auditConflict: await zero(s => { s.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: 'x', status: 'active', createdAt: 't', updatedAt: 't' }); s.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), action: 'other', subjectUserId: DERIVED_OPENID_ACCOUNT }); })
      };
      for (const k of ['disabled', 'missingFields', 'orphanAudit', 'auditConflict']) {
        assert.equal(sectionC.zeroWrite[k].outcome, 'REJECTED_NO_WRITE'); assert.equal(sectionC.zeroWrite[k].creates, 0);
      }
    }
    { // 回滚：第二写失败 → 事务抛出 → 合成运行器回滚（模拟平台原子性，如实披露）
      const { dbFactory, counters, store } = makeSyntheticDb({ failCreatesAfter: 1, rollbackOnFailure: true });
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
      sectionC.rollback = { outcome: r.outcome, users: store.has('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT) };
      assert.equal(sectionC.rollback.outcome, 'OUTCOME_UNKNOWN');
      assert.equal(sectionC.rollback.users, false, '失败事务不留半套新增（模拟回滚）');
    }
    { // 并发（本地串行模型）：至多一组新增
      const { dbFactory, counters, store } = makeSyntheticDb();
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      const rs = await Promise.all([1, 2].map(() => checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE }).catch(e => ({ outcome: 'ERROR', code: String(e && e.code) }))));
      const outcomes = rs.map(r => r.outcome).sort();
      sectionC.concurrent = { outcomes, creates: counters.creates };
      assert.equal(sectionC.concurrent.creates, 2, '并发最终至多一组新增（两条）');
      assert.deepEqual(outcomes, ['ALREADY_ACTIVE', 'CREATED_AND_VERIFIED']);
    }
  }

  // ── D：提交未知事实（不误报零写、不自动重试）──────────────────────────────
  const sectionD = {};
  {
    { // 第二写失败：writeAttempted=true + OUTCOME_UNKNOWN
      const { dbFactory, counters } = makeSyntheticDb({ failCreatesAfter: 1 });
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
      sectionD.secondWriteFail = { outcome: r.outcome, writeAttempted: r.writeAttempted, commitConfirmed: r.commitConfirmed };
      assert.equal(sectionD.secondWriteFail.outcome, 'OUTCOME_UNKNOWN');
      assert.equal(sectionD.secondWriteFail.writeAttempted, true, '写已开始，不误报零写');
      assert.equal(sectionD.secondWriteFail.commitConfirmed, false);
    }
    { // 提交超时
      const { dbFactory } = makeSyntheticDb({ failCommit: true });
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
      sectionD.commitTimeout = { outcome: r.outcome, writeAttempted: r.writeAttempted };
      assert.equal(sectionD.commitTimeout.outcome, 'OUTCOME_UNKNOWN');
      assert.equal(sectionD.commitTimeout.writeAttempted, true);
    }
    { // 提交后回读失败
      const { dbFactory, db } = makeSyntheticDb();
      const origCollection = db.collection;
      db.collection = name => {
        const col = origCollection.call(db, name);
        return {
          doc(id) {
            const ref = col.doc(id);
            return {
              __col: name, __id: id,
              field(p) { return { async get() { throw new Error('synthetic-readback-failure'); } }; },
              async get() { throw new Error('synthetic-readback-failure'); }
            };
          }
        };
      };
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
      sectionD.readbackFail = { outcome: r.outcome, commitConfirmed: r.commitConfirmed };
      assert.equal(sectionD.readbackFail.outcome, 'OUTCOME_UNKNOWN');
      assert.equal(sectionD.readbackFail.commitConfirmed, true, '提交事实保留');
    }
    { // 无自动重试：单次 handle 恰一次事务回调
      const { dbFactory, counters } = makeSyntheticDb({ failCommit: true });
      const checker = core.createSelfRegistrationChecker({ dbFactory, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
      await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
      sectionD.noAutoRetry = { callbackRuns: counters.callbackRuns };
      assert.equal(sectionD.noAutoRetry.callbackRuns, 1, '核心不内部重试');
    }
  }

  // ── E：版本/轮次绑定与窗口（合成计划 build/prepare；真实计划拒绝）──────────
  const sectionE = {};
  {
    const planA = mkPlan(closeSource);
    const dirA = path.join(OUT_ROOT, 'participant-self-registration-ev-a-' + crypto.randomBytes(3).toString('hex'));
    const b1 = packer.build(planA, dirA);
    const b2 = packer.build(planA, path.join(OUT_ROOT, 'participant-self-registration-ev-b-' + crypto.randomBytes(3).toString('hex')));
    const prep = packer.prepare(planA, path.join(OUT_ROOT, 'participant-self-registration-ev-p-' + crypto.randomBytes(3).toString('hex')));
    sectionE.deterministic = { sameBuild: b2.manifest.registrationBuildId === b1.manifest.registrationBuildId, samePrepare: prep.manifest.registrationBuildId === b1.manifest.registrationBuildId, executionReady: prep.executionReady };
    assert.equal(sectionE.deterministic.sameBuild, true); assert.equal(sectionE.deterministic.samePrepare, true);
    assert.equal(sectionE.deterministic.executionReady, false, '准备不升级执行批准');
    const planObjA = JSON.parse(fs.readFileSync(planA, 'utf8'));
    const p2 = path.join(OUT_ROOT, 'psre-plans-' + RUN_ID, 'plan-buildid-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(p2, JSON.stringify(Object.assign({}, planObjA, { syntheticAccount: SYNTHETIC_OTHER_ACCOUNT }), null, 2));
    sectionE.accountNotInvolved = packer.computeRegistrationBuildId(JSON.parse(fs.readFileSync(p2, 'utf8'))) === b1.manifest.registrationBuildId;
    assert.equal(sectionE.accountNotInvolved, true, 'buildId 输入不含允许账号');
    const p3 = path.join(OUT_ROOT, 'psre-plans-' + RUN_ID, 'plan-round-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(p3, JSON.stringify(Object.assign({}, planObjA, { registrationRoundId: 'other-round-x' }), null, 2));
    sectionE.roundSensitive = packer.computeRegistrationBuildId(JSON.parse(fs.readFileSync(p3, 'utf8'))) !== b1.manifest.registrationBuildId;
    assert.equal(sectionE.roundSensitive, true);
    assert.throws(() => packer.build(mkPlan(closeSource, { synthetic: false }), path.join(OUT_ROOT, 'participant-self-registration-ev-real-' + crypto.randomBytes(3).toString('hex'))), e => e.code === 'PSR_REAL_NOT_PERMITTED', '真实模式计划本轮写前拒绝（无私密来源执行包）');
    assert.throws(() => packer.build(mkPlan(closeSource, { registrationRoundId: 'x' }), path.join(OUT_ROOT, 'participant-self-registration-ev-round-' + crypto.randomBytes(3).toString('hex'))), e => e.code === 'PSR_PLAN_INVALID', '非法轮次写前拒绝');
    assert.throws(() => packer.build(mkPlan(closeSource, { __startsMs: Date.now() - 60000, windowStartsAtIso: new Date(Date.now() - 60000).toISOString(), windowExpiresAtIso: new Date(Date.now() + 31 * 60 * 1000).toISOString() }), path.join(OUT_ROOT, 'participant-self-registration-ev-win-' + crypto.randomBytes(3).toString('hex'))), e => e.code === 'PSR_PLAN_WINDOW_INVALID', '窗口跨度写前拒绝');
    // R4：真实模式消费链（仅合成来源）：记录→consumePrivateSource→prepare(privateAccount)→checkPreparedDirResolved
    {
      const planObjA2 = JSON.parse(fs.readFileSync(mkPlan(closeSource), 'utf8'));
      const realPlanFile = path.join(OUT_ROOT, 'psre-plans-' + RUN_ID, 'plan-real-' + crypto.randomBytes(3).toString('hex') + '.json');
      fs.writeFileSync(realPlanFile, JSON.stringify(Object.assign({}, planObjA2, {
        synthetic: false,
        syntheticAccount: undefined,
        privateSource: { schema: 'participant-self-registration-private-source/1', recordFile: privateFileName },
        windowStartsAtIso: '2030-01-01T00:00:00Z',
        windowExpiresAtIso: '2030-01-01T00:10:00Z',
        note: '真实模式计划（合成私密来源夹具；真实编号录入仍被禁止）'
      }), null, 2));
      const mismatchFile = path.join(OUT_ROOT, 'psre-plans-' + RUN_ID, 'plan-real-mismatch-' + crypto.randomBytes(3).toString('hex') + '.json');
      fs.writeFileSync(mismatchFile, JSON.stringify(Object.assign({}, planObjA2, {
        synthetic: false, syntheticAccount: undefined,
        privateSource: { schema: 'participant-self-registration-private-source/1', recordFile: privateFileName },
        registrationRoundId: 'other-round-x',
        windowStartsAtIso: '2030-01-01T00:00:00Z', windowExpiresAtIso: '2030-01-01T00:10:00Z'
      }), null, 2));
      let mismatchCode = '';
      try { await packer.consumePrivateSource(mismatchFile, { repoRoot: REPO_ROOT }); } catch (e) { mismatchCode = e.code || ''; }
      sectionE.consumeBindingRejected = mismatchCode === 'PSR_REAL_NOT_PERMITTED';
      assert.equal(sectionE.consumeBindingRejected, true, '私密来源绑定核验（轮次不符拒绝，实际code=' + mismatchCode + '）');
      const consumed = await packer.consumePrivateSource(realPlanFile, { repoRoot: REPO_ROOT });
      sectionE.consumed = { accountOk: consumed.account === SYNTHETIC_ACCOUNT, participantCode: consumed.participantCode };
      assert.equal(sectionE.consumed.accountOk, true, '消费链解析出绑定账号');
      let requireCode = '';
      try { packer.prepare(realPlanFile, path.join(OUT_ROOT, 'participant-self-registration-ev-real-np-' + crypto.randomBytes(3).toString('hex'))); } catch (e) { requireCode = e.code || ''; }
      sectionE.privateAccountRequired = requireCode === 'PSR_REAL_NOT_PERMITTED';
      assert.equal(sectionE.privateAccountRequired, true, '真实装配必须携带解析账号');
      const realPrep = packer.prepare(realPlanFile, path.join(OUT_ROOT, 'participant-self-registration-ev-real-' + crypto.randomBytes(3).toString('hex')), { privateAccount: SYNTHETIC_ACCOUNT });
      const entryText = fs.readFileSync(path.join(realPrep.outDir, 'server', 'scheduleSandbox', 'index.js'), 'utf8');
      sectionE.realAssembly = { entryContainsAccount: entryText.includes(SYNTHETIC_ACCOUNT), executionReady: realPrep.executionReady };
      assert.equal(sectionE.realAssembly.entryContainsAccount, true, '私密装配：解析账号进入服务端入口配置（如实披露）');
      assert.equal(sectionE.realAssembly.executionReady, false);
      const realCheck = await packer.checkPreparedDirResolved(realPrep.outDir, { repoRoot: REPO_ROOT });
      sectionE.realCheck = { ok: realCheck.ok, planChecked: realCheck.planChecked, executionReady: realCheck.executionReady };
      assert.equal(sectionE.realCheck.ok, true, '真实模式（合成来源）检查通过');
      assert.equal(sectionE.realCheck.executionReady, false);
      privateStore.protectRecord({ repoRoot: REPO_ROOT, fileName: 'evidence-dup-' + RUN_ID + '.bin', participantCode: '2', fullAccount: SYNTHETIC_ACCOUNT, fullAccountRepeat: SYNTHETIC_ACCOUNT, appId: APPID, envId: ENV_ID, roundId: ROUND_ID, serverTimeIso: null, closeSourceDir: closeSource, expectedTarget: privateStore.FIXED_TARGET, windowStartsAtIso: '2030-01-01T00:00:00Z', windowExpiresAtIso: '2030-01-01T00:10:00Z', sourceDigest: privateStore.computeCloseSourceDigest(closeSource), deliveryConfirmed: true });
      let dupCode = '';
      try { await packer.consumePrivateSource(realPlanFile, { repoRoot: REPO_ROOT }); } catch (e) { dupCode = e.code || ''; }
      sectionE.dedupRejected = dupCode === 'PSR_REAL_NOT_PERMITTED';
      assert.equal(sectionE.dedupRejected, true, '1/2 完整编号排重（同账号跨码拒绝，实际code=' + dupCode + '）');
    }
  }

  // ── F：来源漂移结构化失败/篡改/多余文件/独立关闭 23 ───────────────────────
  const sectionF = {};
  {
    const dirA = path.join(OUT_ROOT, 'participant-self-registration-ev-f-' + crypto.randomBytes(3).toString('hex'));
    packer.build(mkPlan(closeSource), dirA);
    const origRead = fs.readFileSync;
    const withTemplateRead = (fn, mode) => {
      fs.readFileSync = function (p, ...rest) {
        const s = String(p);
        if (s.includes('participant-self-registration') && s.includes('frontend')) {
          if (mode === 'drift') return Buffer.concat([origRead.call(fs, p, ...rest), Buffer.from('\n// synthetic-source-drift\n')]);
          if (mode === 'missing') { const e = new Error('ENOENT: no such file or directory, open ' + s); e.code = 'ENOENT'; throw e; }
        }
        return origRead.call(fs, p, ...rest);
      };
      try { return fn(); } finally { fs.readFileSync = origRead; }
    };
    sectionF.drift = [];
    for (const [name, mode, classification] of [['前端模板漂移', 'drift', 'SOURCE_DRIFT'], ['前端模板缺失', 'missing', 'ENOENT']]) {
      const rec = withTemplateRead(() => {
        const r1 = packer.checkDir(dirA);
        const r2 = packer.checkPreparedDir(dirA);
        return { checkDirOkFalse: r1.ok === false, classified: r1.problems.some(p => p.includes('登记版本标识重建失败') && p.includes(classification)), planCheckedFalse: r1.planChecked === false, preparedOkFalse: r2.ok === false, executionReadyFalse: r2.executionReady === false };
      }, mode);
      sectionF.drift.push(Object.assign({ name }, rec));
      assert.equal(rec.checkDirOkFalse, true, name); assert.equal(rec.classified, true, name);
      assert.equal(rec.planCheckedFalse, true, name); assert.equal(rec.preparedOkFalse, true, name);
      assert.equal(rec.executionReadyFalse, true, name);
    }
    sectionF.legalControl = packer.checkDir(dirA).ok === true;
    assert.equal(sectionF.legalControl, true, '合法对照通过');
    fs.appendFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), '\n// tampered\n');
    sectionF.tamperDetected = packer.checkDir(dirA).ok === false;
    assert.equal(sectionF.tamperDetected, true, '磁盘篡改拒绝');
    fs.writeFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), fs.readFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), 'utf8').replace('\n// tampered\n', ''));
    sectionF.restoredOk = packer.checkDir(dirA).ok === true;
    assert.equal(sectionF.restoredOk, true, '还原一致');
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    try {
      const closeResult = packer.checkCloseDir(dirA);
      sectionF.closeIndependent = { ok: closeResult.ok, files: closeResult.files, expectedFiles: closeResult.expectedFiles };
      assert.equal(sectionF.closeIndependent.ok, true);
      assert.equal(sectionF.closeIndependent.files, 23);
    } finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
  }

  // ── G：生成链（App→Page→client→入口→核心→合成db）──────────────────────────
  const sectionG = {};
  {
    const dirA = path.join(OUT_ROOT, 'participant-self-registration-ev-g-' + crypto.randomBytes(3).toString('hex'));
    const starts = Date.now() - 60000;
    packer.build(mkPlan(closeSource, { windowStartsAtIso: new Date(starts).toISOString(), windowExpiresAtIso: new Date(starts + 10 * 60 * 1000).toISOString() }), dirA);
    const { dbFactory, counters } = makeSyntheticDb();
    const mkEntry = openid => {
      const m = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), 'utf8'), {
        require: name => {
          if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => ({ APPID: APPID, OPENID: openid }), database: dbFactory };
          if (name === './request-adapter') return require(root + '/miniapp/scripts/templates/participant-self-registration/server/request-adapter.js');
          if (name === './participant-self-registration') return core;
          throw Error('req ' + name);
        },
        module: m, exports: m.exports, process: { env: {} }, console
      }, { filename: 'entry.js' });
      return m.exports;
    };
    const entry = mkEntry(SYNTHETIC_ACCOUNT_OPENID);
    const r1 = await entry.main({ picRequest: { schema: 'participant-self-registration-request/1', action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE } });
    sectionG.fullChain = { outcome: r1.outcome, writeAttempted: r1.writeAttempted };
    assert.equal(sectionG.fullChain.outcome, 'CREATED_AND_VERIFIED');
    // R1：database/collection/事务/写 分列计数
    assert.equal(counters.database, 1, 'R1：正向恰 1 次 database 工厂（实际 ' + counters.database + '）');
    assert.equal(counters.transactions, 1, 'R1：正向恰 1 次事务');
    assert.equal(counters.creates, 2, 'R1：正向恰 2 条原子写');
    const factoryAfterCreate = counters.factory;
    const r2 = await mkEntry(SYNTHETIC_OTHER_ACCOUNT).main({ picRequest: { schema: 'participant-self-registration-request/1', action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE } });
    sectionG.notAllowed = { code: r2.code, factoryDelta: counters.factory - factoryAfterCreate };
    assert.equal(sectionG.notAllowed.code, 'PIC_NOT_ALLOWED'); assert.equal(sectionG.notAllowed.factoryDelta, 0, '非名单零工厂');
    const r3 = await entry.main({ picRequest: { schema: 'participant-self-registration-request/1', action: 'registerSelf', registrationRoundId: 'other-round', passphrase: SYNTHETIC_PASSPHRASE } });
    sectionG.wrongRound = { code: r3.code };
    assert.equal(sectionG.wrongRound.code, 'PIC_ROUND_MISMATCH');
    const r4 = await entry.main({ picRequest: { schema: 'participant-identity-request/1', action: 'inspectSelf', checkRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE } });
    sectionG.oldActionUnreachable = r4.code;
    assert.equal(sectionG.oldActionUnreachable, 'PIC_REQUEST_INVALID');
    // 页面链：加载零发送+写入提示+单击单发+口令清除+三栏+服务端不能覆盖本机证据
    const cfgObj = (() => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dirA, 'frontend', 'config', 'cloud.js'), 'utf8'), { module: m, exports: m.exports }, { filename: 'cloud.js' }); return m.exports; })();
    const manifest = JSON.parse(fs.readFileSync(path.join(dirA, 'manifest.json'), 'utf8'));
    const sent = [];
    const clientWx = { cloud: { _selfRegistrationEnvInited: true, init() {}, callFunction: async opts => { sent.push(opts.data); return { result: { outcome: 'CREATED_AND_VERIFIED', registrationRoundId: ROUND_ID, writeAttempted: true, commitConfirmed: true, localRequestEvidence: { schema: 'participant-self-registration-local/1', requestRoundId: 'forged-server-round', handoffAttempted: true }, previewBuildId: 'f'.repeat(64) } }; } } };
    const clientObj = (() => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dirA, 'frontend', 'utils', 'registration-check-client.js'), 'utf8'), { module: m, exports: m.exports, require: () => cfgObj, wx: clientWx }, { filename: 'client.js' }); return m.exports; })();
    const pageMod = { pageDef: null };
    vm.runInNewContext(fs.readFileSync(path.join(dirA, 'frontend', 'pages', 'self-registration', 'self-registration.js'), 'utf8'), {
      Page(d) { pageMod.pageDef = d; },
      require: name => (name === '../../utils/registration-check-client' ? clientObj : name === '../../config/cloud' ? cfgObj : (() => { throw Error('req ' + name); })()),
      wx: clientWx
    }, { filename: 'page.js' });
    const page = Object.assign({ data: {}, setData(patch) { Object.assign(this.data, patch); } }, pageMod.pageDef);
    page.onLoad();
    sectionG.page = { zeroSendOnLoad: sent.length === 0, warningDisclosesWrite: Boolean(page.data.warningText && page.data.warningText.includes('登记审计')), buildIdVisible: page.data.registrationBuildId === manifest.registrationBuildId, configRoundVisible: page.data.configRegistrationRoundId === ROUND_ID };
    assert.equal(sectionG.page.zeroSendOnLoad, true); assert.equal(sectionG.page.warningDisclosesWrite, true);
    assert.equal(sectionG.page.buildIdVisible, true); assert.equal(sectionG.page.configRoundVisible, true);
    page.onPassphraseInput({ detail: { value: SYNTHETIC_PASSPHRASE } });
    await page.onRegisterTap();
    sectionG.page.singleSend = sent.length === 1;
    sectionG.page.payloadRound = sent[0] && sent[0].picRequest.registrationRoundId;
    sectionG.page.passphraseCleared = page.data.passphrase === '';
    sectionG.page.localRound = page.data.localRequestRound;
    sectionG.page.serverRoundText = page.data.serverRoundText;
    assert.equal(sectionG.page.singleSend, true); assert.equal(sectionG.page.payloadRound, ROUND_ID);
    assert.equal(sectionG.page.passphraseCleared, true);
    assert.equal(sectionG.page.localRound, ROUND_ID); assert.equal(sectionG.page.serverRoundText, ROUND_ID);
    // 服务端伪造不覆盖本机快照
    const clientObj2 = (() => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dirA, 'frontend', 'utils', 'registration-check-client.js'), 'utf8'), { module: m, exports: m.exports, require: () => cfgObj, wx: clientWx }, { filename: 'client2.js' }); return m.exports; })();
    const envelope = await clientObj2.callSelfRegistration({ action: 'registerSelf', passphrase: SYNTHETIC_PASSPHRASE });
    sectionG.evidenceNotOverwritten = envelope.localRequestEvidence.requestRoundId === ROUND_ID && envelope.localRequestEvidence.registrationBuildId === manifest.registrationBuildId && !JSON.stringify(envelope.localRequestEvidence).includes('forged-server-round');
    assert.equal(sectionG.evidenceNotOverwritten, true);
    // 披露边界
    sectionG.disclosure = {
      entryContainsAccount: fs.readFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), 'utf8').includes(SYNTHETIC_ACCOUNT),
      clientClean: !fs.readFileSync(path.join(dirA, 'frontend', 'utils', 'registration-check-client.js'), 'utf8').includes(SYNTHETIC_ACCOUNT),
      pageClean: !fs.readFileSync(path.join(dirA, 'frontend', 'pages', 'self-registration', 'self-registration.js'), 'utf8').includes(SYNTHETIC_ACCOUNT),
      manifestClean: !JSON.stringify(manifest.files).includes(SYNTHETIC_ACCOUNT),
      planContainsFixture: fs.readFileSync(path.join(dirA, 'plan.json'), 'utf8').includes(SYNTHETIC_ACCOUNT)
    };
    assert.equal(sectionG.disclosure.entryContainsAccount, true, '完整允许账号在服务端入口（如实披露）');
    assert.equal(sectionG.disclosure.clientClean, true); assert.equal(sectionG.disclosure.pageClean, true);
    assert.equal(sectionG.disclosure.manifestClean, true);
    assert.equal(sectionG.disclosure.planContainsFixture, true, '计划含合成夹具账号字段');
  }

  // ── H：敏感性自反例（独立分组；真实判定出口）─────────────────────────────
  const guardPreload = path.join(OUT_ROOT, 'psre-cli-guard-' + crypto.randomBytes(3).toString('hex') + '.cjs');
  fs.writeFileSync(guardPreload, guardHelper.buildGuardPreloadSource(), { flag: 'wx' });
  const runSelf = faultMode2 => guard.runCli({ scriptPath: SELF, args: [], guardPreload, receiptPath: guard.newReceiptPath('psre-self'), group: 'sensitivity', extraEnv: faultMode2 ? { PIC_PREP_EVIDENCE_FAULT: faultMode2 } : {} });
  const sectionH = {};
  {
    const normal = await runSelf('normal');
    const normalJ = JSON.parse(normal.out);
    sectionH.normal = { code: normal.code, verdictExitCode: normalJ.verdict.exitCode, probes: normalJ.guardCounters.probes, parentUnexpected: normalJ.guardCounters.parentUnexpected };
    assert.equal(sectionH.normal.code, 0); assert.equal(sectionH.normal.verdictExitCode, 0);
    assert.equal(sectionH.normal.probes, 2); assert.equal(sectionH.normal.parentUnexpected, 0);
    for (const faultName of ['earlyRequire', 'duringCloseSource', 'businessHit', 'nonWhitelistSpawn', 'publicSpawnBypass']) {
      const r = await runSelf(faultName);
      const j = JSON.parse(r.out);
      const v = guardHelper.verdictFor({ probes: j.guardCounters.probes, parentUnexpected: j.guardCounters.parentUnexpected, childUnexpectedTotal: 0, receiptFailures: 0 });
      sectionH[faultName] = { code: r.code, parentUnexpected: j.guardCounters.parentUnexpected, verdictExitCode: v.exitCode };
      assert.equal(r.code, 1, faultName + '：exit1');
      assert.equal(j.guardCounters.parentUnexpected, 1, faultName + '：意外恰 1');
      assert.equal(v.exitCode, 1, faultName + '：真实判定出口 exit1');
    }
  }

  // ── 汇总与真实判定出口 ────────────────────────────────────────────────────
  const normalSummary = guard.summary('normal');
  const sensitivitySummary = guard.summary('sensitivity');
  const actualCounters = {
    probes: guardHits.filter(h => h.phase === 'probe').length,
    parentUnexpected: guardHits.filter(h => h.phase !== 'probe').length,
    childUnexpectedTotal: normalSummary.childUnexpectedTotal,
    receiptFailures: normalSummary.receiptFailures
  };
  const verdict = guardHelper.verdictFor(actualCounters);
  const result = {
    schema: 'codebuddy-self-registration-evidence/1',
    observedAt: new Date().toISOString(),
    basisCommit: 'b639d7c',
    reviewBasis: 'docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §1–§6；docs/Codex复查-指定本人登记与私密输入本地实现-20261021.md §2–§3（R1–R6 返修验证）',
    verificationKind: 'offline evidence; synthetic plans/accounts/passphrases and synthetic wx/db; NOT platform verification, NOT an execution approval; NO real number entry, NO cloud registration',
    ok: verdict.ok,
    guardCounters: Object.assign({}, actualCounters, { total: actualCounters.probes + actualCounters.parentUnexpected }),
    localToolCalls: { policy: 'git check-ignore|ls-files / icacls read-only / fixed DPAPI ConvertTo|From-SecureString scripts (plaintext via stdin); everything else blocked as unexpected', count: toolCalls.length, calls: toolCalls.slice(0, 200) },
    verdict,
    sections: { a: sectionA, b: sectionB, c: sectionC, d: sectionD, e: sectionE, f: sectionF, g: sectionG, h: sectionH },
    runtimeDigests: {
      packerSha256: sha(fs.readFileSync(root + '/miniapp/scripts/package-participant-self-registration.cjs')),
      coreSha256: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-self-registration.cjs')),
      privateStoreSha256: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-private-store.cjs'))
    },
    evidenceKinds: {
      sourceObservation: 'pre-send validation, local evidence capture, atomic two-write transaction and disclosure boundaries read from product source',
      syntheticChain: 'sections B–G use synthetic accounts/passphrases/windows and synthetic wx/db (serialized local transaction model)',
      privateStore: 'DPAPI (CurrentUser) roundtrip via node on Windows; PS1 SelfTestCheck covered by the test file (evidence does not spawn non-whitelisted processes)',
      localCli: 'section H self-runs only the whitelisted evidence script via the shared audited runner with guard preload and receipts',
      selfFaults: 'five fault modes with independent accounting through the real verdict exit',
      platform: 'none — whether the SDK would actually deliver/commit on the platform remains unverified; no real number entry; no cloud registration'
    },
    cloudOperations: 0,
    limitations: [
      'The private-source real-mode assembly (synthetic:false) is rejected at plan level in this round; it requires a separately approved execution package.',
      'Concurrency is modeled by serialized local transactions; the platform relies on transaction conflict detection + retry for the same at-most-one-set guarantee.',
      'writeAttempted/commitConfirmed describe the program reaching the SDK write call; OUTCOME_UNKNOWN after submit is not retried automatically.'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[指定本人登记与私密输入证据摘要] ok=' + verdict.ok + ' A.私密存储 DPAPI/排他/净化/边界 B.准入6例零工厂零写 C.原子两条/回滚/并发/无效零写 D.提交未知3例+无自动重试 E.版本轮次绑定/窗口/真实计划拒绝 F.漂移结构化+篡改+还原+关闭23 G.全链/非名单/错轮次/旧动作/页面/披露边界 H.自反例5类 计数：探针=' + actualCounters.probes + ' 父意外=' + actualCounters.parentUnexpected + ' normal子意外合计=' + actualCounters.childUnexpectedTotal + ' normal回执失败=' + actualCounters.receiptFailures + ' 敏感性组=' + JSON.stringify(sensitivitySummary) + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  process.exitCode = verdict.exitCode;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => { guarded.restore(); guard.restoreAll(); });
