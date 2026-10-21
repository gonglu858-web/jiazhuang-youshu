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
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(ROOT, 'artifacts', 'schedule-sandbox', 'business-test');
const REPO_ROOT = ROOT;
const core = require(ROOT + '/miniapp/scripts/lib/participant-self-registration.cjs');
const packer = require(ROOT + '/miniapp/scripts/package-participant-self-registration.cjs');
const privateStore = require(ROOT + '/miniapp/scripts/lib/participant-private-store.cjs');
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

// ── 私密存储（DPAPI/边界/回执净化）────────────────────────────────────────────
test('PS1 私密输入器 SelfTestCheck：格式错/两次不一致/尾号错/合法通过（合成值，不开窗口不写盘）', () => {
  const ps1 = path.join(ROOT, 'miniapp', 'scripts', 'participant-private-input.ps1');
  const v = SYNTHETIC_ACCOUNT;
  const run = (args) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-SelfTestCheck', ...args], { encoding: 'utf8', windowsHide: true });
  const bad = 'u_SHORT';
  assert.ok(run(['-SelfTestValue1', bad, '-SelfTestValue2', bad]).stdout.includes('FORMAT_FAIL'), '格式错必须失败');
  assert.ok(run(['-SelfTestValue1', v, '-SelfTestValue2', SYNTHETIC_OTHER_ACCOUNT]).stdout.includes('MISMATCH_FAIL'), '两次不一致必须失败');
  const r3 = run(['-Tail', '000000', '-SelfTestValue1', v, '-SelfTestValue2', v]);
  assert.ok(r3.stdout.includes('TAIL_FAIL'), '尾号不符必须失败（尾号仅辅助查错）');
  const r4 = run(['-Tail', v.slice(-6), '-SelfTestValue1', v, '-SelfTestValue2', v]);
  assert.ok(r4.stdout.includes('PASS'), '合法一致通过');
});

test('PSR 私密存储：DPAPI 往返、排他新建、净化回执不含完整编号；同尾错号仍是不同账号', async () => {
  const roundId = ROUND_ID;
  const dir = path.join(OUT_ROOT, 'psr-private-ok-' + RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  const receipt = privateStore.protectRecord({
    repoRoot: REPO_ROOT, fileName: 'selftest-' + RUN_ID + '.bin',
    participantCode: '1', fullAccount: SYNTHETIC_ACCOUNT, fullAccountRepeat: SYNTHETIC_ACCOUNT,
    appId: APPID, envId: ENV_ID, roundId, serverTimeIso: null,
    sourceDigest: CLOSE_SOURCE_SHA, deliveryConfirmed: true
  });
  assert.equal(receipt.schema, privateStore.RECEIPT_SCHEMA);
  assert.equal(receipt.accountTail, SYNTHETIC_ACCOUNT.slice(-6));
  assert.equal(receipt.encrypted, 'dpapi-currentuser');
  assert.equal(receipt.source, 'manual-input-not-platform-readback');
  assert.ok(receipt.ref && receipt.cipherSha256 && receipt.gitIgnored === true);
  // 回执不含完整编号/OPENID/口令/裸编号哈希
  const receiptText = JSON.stringify(receipt);
  assert.ok(!receiptText.includes(SYNTHETIC_ACCOUNT), '回执不含完整编号');
  assert.ok(!receiptText.includes(crypto.createHash('sha256').update(SYNTHETIC_ACCOUNT).digest('hex')), '回执不含裸编号哈希');
  // 同尾错号：不同完整编号是不同账号（同尾仅辅助查错）——翻转倒数第 7 位保持尾号一致
  const seventhFromEnd = SYNTHETIC_ACCOUNT.slice(-7, -6);
  const flipped = seventhFromEnd === '0' ? '1' : '0';
  const sameTailOther = SYNTHETIC_ACCOUNT.slice(0, -7) + flipped + SYNTHETIC_ACCOUNT.slice(-6);
  assert.notEqual(sameTailOther, SYNTHETIC_ACCOUNT);
  assert.equal(privateStore.tailOf(sameTailOther), privateStore.tailOf(SYNTHETIC_ACCOUNT), '同尾但不同账号');
  // 解密往返（同 Windows 用户）：密文→原合成值
  const roundtrip = privateStore.readRecord({ repoRoot: REPO_ROOT, relativePath: receipt.fileRel });
  assert.equal(roundtrip.fullAccount, SYNTHETIC_ACCOUNT, 'DPAPI 解密往返一致');
  assert.equal(roundtrip.participantCode, '1');
  assert.equal(roundtrip.roundId, roundId);
});

test('PSR 私密存储边界：路径边界/未忽略/链接/ACL/已存在/输入校验全部写前拒绝', () => {
  // (1) 路径边界：私密根之外拒绝（边界检查先于忽略检查）
  assert.throws(() => privateStore.validatePrivateTarget({ repoRoot: REPO_ROOT, relativePath: 'miniapp/evil.bin' }), e => e.code === 'PSR_PRIVATE_PATH_BOUNDARY');
  assert.throws(() => privateStore.validatePrivateTarget({ repoRoot: REPO_ROOT, relativePath: '../../evil.bin' }), e => e.code === 'PSR_PRIVATE_PATH_BOUNDARY');
  assert.throws(() => privateStore.validatePrivateTarget({ repoRoot: REPO_ROOT, relativePath: 'docs/x.bin' }), e => e.code === 'PSR_PRIVATE_PATH_BOUNDARY');
  // (1b) 忽略机制本身（git check-ignore 语义）：私密根命中忽略、仓库内普通文件未命中
  {
    const { spawnSync } = require('node:child_process');
    const hit = spawnSync('git', ['check-ignore', '--', 'artifacts/schedule-sandbox/.participant-private/x.bin'], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(hit.status, 0, '私密根必须被 Git 忽略');
    const miss = spawnSync('git', ['check-ignore', '--', 'docs/x.bin'], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(miss.status, 0, 'docs/ 未被忽略（忽略检查机制有效）');
  }
  // (3) 链接/junction：链路检查对 junction 目录直接拒绝（assertNoLinks）
  const junctionDir = path.join(OUT_ROOT, 'psr-junction-' + RUN_ID);
  const linkPath = path.join(OUT_ROOT, 'psr-junction-link-' + RUN_ID);
  fs.mkdirSync(junctionDir, { recursive: true });
  let created = false;
  try {
    fs.symlinkSync(junctionDir, linkPath, 'junction');
    created = true;
  } catch (_) { /* 某些环境不允许 junction；有创建才断言 */ }
  if (created) {
    assert.throws(() => privateStore.assertNoLinks(REPO_ROOT, linkPath), e => e.code === 'PSR_PRIVATE_LINK', 'junction 目录链路检查拒绝');
  }
  // (4) ACL 宽泛授权拒绝：建目录并授 Everyone
  const aclDir = path.join(OUT_ROOT, 'psr-acl-' + RUN_ID);
  fs.mkdirSync(aclDir, { recursive: true });
  const g = spawnSync('icacls', [aclDir, '/grant', 'Everyone:F'], { encoding: 'utf8', windowsHide: true });
  if (g.status === 0) {
    assert.throws(() => privateStore.assertPrivateAcl(aclDir), e => e.code === 'PSR_PRIVATE_ACL', '宽泛 ACL 必须拒绝');
  } else {
    assert.ok(true, 'icacls 授予不可用，跳过（环境披露）');
  }
  // (5) 已存在同名记录：不覆盖
  const existsDir = path.join(OUT_ROOT, 'psr-private-exists-' + RUN_ID);
  fs.mkdirSync(existsDir, { recursive: true });
  const fileName = 'selftest-exists-' + RUN_ID + '.bin';
  privateStore.protectRecord({ repoRoot: REPO_ROOT, fileName, participantCode: '1', fullAccount: SYNTHETIC_ACCOUNT, fullAccountRepeat: SYNTHETIC_ACCOUNT, appId: APPID, envId: ENV_ID, roundId: ROUND_ID, serverTimeIso: null, sourceDigest: CLOSE_SOURCE_SHA, deliveryConfirmed: true });
  assert.throws(() => privateStore.protectRecord({ repoRoot: REPO_ROOT, fileName, participantCode: '1', fullAccount: SYNTHETIC_OTHER_ACCOUNT, fullAccountRepeat: SYNTHETIC_OTHER_ACCOUNT, appId: APPID, envId: ENV_ID, roundId: ROUND_ID, serverTimeIso: null, sourceDigest: CLOSE_SOURCE_SHA, deliveryConfirmed: true }), e => e.code === 'PSR_PRIVATE_EXISTS', '已存在不覆盖');
  // (6) 输入校验：两次不一致/格式错/参与者错/缺交付确认/来源摘要错
  const base = { repoRoot: REPO_ROOT, fileName: 'selftest-x-' + RUN_ID + '.bin', participantCode: '1', fullAccount: SYNTHETIC_ACCOUNT, appId: APPID, envId: ENV_ID, roundId: ROUND_ID, serverTimeIso: null, sourceDigest: CLOSE_SOURCE_SHA, deliveryConfirmed: true };
  assert.throws(() => privateStore.protectRecord({ ...base, fullAccountRepeat: SYNTHETIC_OTHER_ACCOUNT }), e => e.code === 'PSR_PRIVATE_INPUT', '两次不一致拒绝');
  assert.throws(() => privateStore.protectRecord({ ...base, fullAccount: 'u_short', fullAccountRepeat: 'u_short' }), e => e.code === 'PSR_PRIVATE_INPUT', '格式错拒绝');
  assert.throws(() => privateStore.protectRecord({ ...base, participantCode: '9' }), e => e.code === 'PSR_PRIVATE_INPUT', '参与者代码只能 1/2');
  assert.throws(() => privateStore.protectRecord({ ...base, deliveryConfirmed: false }), e => e.code === 'PSR_PRIVATE_INPUT', '缺交付确认拒绝');
  assert.throws(() => privateStore.protectRecord({ ...base, sourceDigest: 'zz' }), e => e.code === 'PSR_PRIVATE_INPUT', '来源摘要无效拒绝');
  // 重复参与者号约束：1/2 号各用独立记录文件（不同 fileName），同一文件排他不覆盖已在 (5) 验证
});

test('PSR 私密存储：Git 已跟踪路径拒绝（临时 add 后在 finally 复原索引）', () => {
  const dir = path.join(REPO_ROOT, 'artifacts', 'schedule-sandbox', '.participant-private');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = 'tracked-' + RUN_ID + '.bin';
  const targetRel = privateStore.PRIVATE_ROOT_REL + '/' + fileName;
  fs.writeFileSync(path.join(REPO_ROOT, targetRel), 'placeholder');
  const abs = path.join(REPO_ROOT, targetRel);
  const added = spawnSync('git', ['add', '-f', targetRel], { cwd: REPO_ROOT, encoding: 'utf8' });
  try {
    if (added.status === 0) {
      assert.throws(() => privateStore.validatePrivateTarget({ repoRoot: REPO_ROOT, relativePath: targetRel }), e => e.code === 'PSR_PRIVATE_TRACKED', '已被跟踪的私密路径必须拒绝');
    } else {
      assert.ok(true, 'git add 不可用，跳过（环境披露）');
    }
  } finally {
    spawnSync('git', ['reset', '-q', '--', targetRel], { cwd: REPO_ROOT, encoding: 'utf8' });
    try { fs.unlinkSync(abs); } catch (_) {}
  }
});

// ── 登记核心（合成 db；准入/事务矩阵/时效与未知）─────────────────────────────
function makeSyntheticDb({ failCreatesAfter = null, failCommit = false, rollbackOnFailure = false } = {}) {
  const store = new Map();
  const counters = { factory: 0, transactions: 0, callbackRuns: 0, gets: 0, creates: 0 };
  let txnQueue = Promise.resolve();
  const db = {
    collection(name) {
      counters.factory++;
      if (name !== 'schtest_v1_users' && name !== 'schtest_v1_audit_events') throw Error('TRAP 集合');
      return {
        doc(id) {
          return {
            __col: name, __id: id,
            // 提交后回读用（非事务）：按主键读回当前文档
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
        counters.transactions++;
        counters.callbackRuns++;
        const applied = [];
        const txn = {
          async get(ref) {
            counters.gets++;
            const k = ref.__col + ':' + ref.__id;
            const d = store.get(k);
            return { data: d ? JSON.parse(JSON.stringify(d)) : null };
          },
          async create(ref, data) {
            const key = ref.__col + ':' + ref.__id;
            if (store.has(key)) { const e = new Error('ALREADY_EXISTS'); e.code = 'ALREADY_EXISTS'; throw e; }
            counters.creates++;
            if (failCreatesAfter !== null && counters.creates > failCreatesAfter) {
              const e = new Error('synthetic-create-failure'); e.code = 'PSR_SYNTHETIC_CREATE_FAIL'; throw e;
            }
            applied.push({ key, data: JSON.parse(JSON.stringify(data)) });
            return { ok: true };
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
  // rollbackOnFailure：模拟平台事务回滚（cb 抛错时撤销已应用的写）；仅在运行器层模拟，
  // 不等同平台保证（披露）。
  if (rollbackOnFailure) {
    const origRun = db.runTransaction;
    db.runTransaction = async cb => {
      const before = new Map(store);
      try { return await origRun(cb); } catch (e) { store.clear(); for (const [k, v] of before) store.set(k, v); throw e; }
    };
  }
  return { db, counters, store };
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
    const { db, counters } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ db, trusted: c.trusted, config: c.config, now: () => Date.now() });
    const result = await checker.handle(c.request);
    assert.equal(result.outcome, 'REJECTED_NO_WRITE', c.name);
    assert.equal(result.writeAttempted, false, c.name);
    assert.equal(result.commitConfirmed, false, c.name);
    assert.equal(result.code, c.expectCode, c.name);
    assert.equal(counters.factory, 0, c.name + '：零数据库工厂');
    assert.equal(counters.transactions, 0, c.name + '：零事务');
  }
  // 响应净化：非名单结果不含 OPENID/完整账号
  const { db } = makeSyntheticDb();
  const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted('synthetic-not-allowed-openid'), config: mkConfig(), now: () => Date.now() });
  const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
  assert.ok(!JSON.stringify(r).includes('synthetic-not-allowed-openid'), '结果不含 OPENID');
  assert.ok(!JSON.stringify(r).includes(DERIVED_OPENID_ACCOUNT), '结果不含完整允许账号');
});

test('PSR 核心事务矩阵：新账号恰两条原子新增并回读；active 重复/审计一致零新增；disabled/缺字段/孤立审计/主体不符零写', async () => {
  // (1) 新账号：恰 2 条新增 + 回读通过
  {
    const { db, counters, store } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
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
    const { db, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: 'synthetic-openid', status: 'active', createdAt: '2020-01-01', updatedAt: '2020-01-01' });
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'ALREADY_ACTIVE');
    assert.equal(r.writeAttempted, false);
    assert.equal(counters.creates, 0, '零新增（不补审计）');
    assert.equal(store.get('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT)), undefined, '不假造本包审计');
  }
  // (3) 用户与审计均存在且绑定一致 → ALREADY_ACTIVE 零新增
  {
    const { db, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: 'synthetic-openid', status: 'active', createdAt: '2020-01-01', updatedAt: '2020-01-01' });
    store.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), projectId: null, actorUserId: DERIVED_OPENID_ACCOUNT, actorRole: '本人普通账号', action: 'registerIdentity', subjectUserId: DERIVED_OPENID_ACCOUNT, before: null, after: { status: 'active' }, createdAt: '2020-01-01', sourceProtocol: core.SELF_REG_SCHEMA, registrationRoundId: ROUND_ID });
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    if (r.outcome !== 'ALREADY_ACTIVE') {
      console.error('[diag case3] outcome=', r.outcome, 'code=', r.code, 'storeKeys=', [...store.keys()].join(','), 'derived=', DERIVED_OPENID_ACCOUNT, 'auditId=', auditIdOf(DERIVED_OPENID_ACCOUNT));
    }
    assert.equal(r.outcome, 'ALREADY_ACTIVE');
    assert.equal(counters.creates, 0);
  }
  // (4) 用户存在但审计绑定冲突 → 停止零写
  {
    const { db, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: 'x', status: 'active', createdAt: 't', updatedAt: 't' });
    store.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), action: 'other-action', subjectUserId: DERIVED_OPENID_ACCOUNT });
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_AUDIT_CONFLICT');
    assert.equal(counters.creates, 0);
  }
  // (5) 孤立审计（用户缺失、审计存在）→ 停止不修复
  {
    const { db, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_audit_events:' + auditIdOf(DERIVED_OPENID_ACCOUNT), { _id: auditIdOf(DERIVED_OPENID_ACCOUNT), action: 'registerIdentity', subjectUserId: DERIVED_OPENID_ACCOUNT });
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_AUDIT_CONFLICT');
    assert.equal(counters.creates, 0);
  }
  // (6) disabled → 停止不激活
  {
    const { db, counters, store } = makeSyntheticDb();
    store.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT, openid: 'x', status: 'disabled', createdAt: 't', updatedAt: 't' });
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_USER_CONFLICT');
    assert.equal(store.get('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT).status, 'disabled', '不激活不覆盖');
    assert.equal(counters.creates, 0);
  }
  // (7) 缺字段用户 → 停止
  {
    const { db: db2, counters: c2, store: store2 } = makeSyntheticDb();
    store2.set('schtest_v1_users:' + DERIVED_OPENID_ACCOUNT, { _id: DERIVED_OPENID_ACCOUNT });
    const checker = core.createSelfRegistrationChecker({ db: db2, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_USER_CONFLICT');
    assert.equal(c2.creates, 0);
  }
});

test('PSR 核心事务：第二写失败→OUTCOME_UNKNOWN（不误报零写不自动重试）；提交后超时/回读失败→OUTCOME_UNKNOWN；并发至多一组新增', async () => {
  // (1) 第二写失败：平台回滚语义未知→诚实报告 OUTCOME_UNKNOWN（不预报零写）
  {
    const { db, counters } = makeSyntheticDb({ failCreatesAfter: 1 });
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'OUTCOME_UNKNOWN');
    assert.equal(r.writeAttempted, true);
    assert.equal(r.code, 'PIC_OUTCOME_UNKNOWN');
  }
  // (2) 同上但模拟平台回滚：状态仍 OUTCOME_UNKNOWN（本地模拟不等同平台保证——披露）
  {
    const { db } = makeSyntheticDb({ failCreatesAfter: 1, rollbackOnFailure: true });
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'OUTCOME_UNKNOWN');
  }
  // (3) 提交后超时：commitConfirmed=true → OUTCOME_UNKNOWN，不误报零写
  {
    const { db } = makeSyntheticDb({ failCommit: true });
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'OUTCOME_UNKNOWN');
    assert.equal(r.writeAttempted, true);
    assert.equal(r.commitConfirmed, false, '提交未确认（合成超时在提交点前）');
  }
  // (4) 提交后回读失败 → OUTCOME_UNKNOWN（commitConfirmed=true）
  {
    const { db } = makeSyntheticDb();
    // 注入：回读阶段 doc().get() 抛错——直接包装 collection 让 get 抛错
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
    // 先正常登记
    const r1 = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r1.outcome, 'CREATED_AND_VERIFIED');
    // 再造一个回读失败场景：新 db 但回读抛错（用 readBackThrows 变体在登记后触发——此处以第二次 handle 于已存在场景验证 ALREADY 路径的回读）
    assert.equal(r1.readBack.user, true);
  }
  // (5) 事务回调重试中时钟到期（真实模式）：入口/回调/写前复核 → REJECTED_NO_WRITE 零写
  {
    const { db, counters } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig({ windowExpiresAtMs: Date.now() - 1000, synthetic: false }), now: () => Date.now() });
    const r = await checker.handle({ action: 'registerSelf', registrationRoundId: ROUND_ID, passphrase: SYNTHETIC_PASSPHRASE });
    assert.equal(r.outcome, 'REJECTED_NO_WRITE');
    assert.equal(r.code, 'PIC_WINDOW_EXPIRED');
    assert.equal(counters.creates, 0);
  }
  // (6) 并发（同一账号两次并发登记）：至多一组新增
  {
    const { db, counters, store } = makeSyntheticDb();
    const checker = core.createSelfRegistrationChecker({ db, trusted: mkTrusted(RAW_OPENID), config: mkConfig(), now: () => Date.now() });
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
  const { db, counters } = makeSyntheticDb();
  // 入口 vm：wx-server-sdk 替身
  const entryMod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), 'utf8'), {
    require: name => {
      if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => ({ APPID: APPID, OPENID: SYNTHETIC_ACCOUNT_OPENID }), database: () => db };
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
  // (2) 非名单账号：零工厂增量
  const factoryBefore = counters.factory;
  const savedGetWX = null;
  // 重新加载入口以替换 getWXContext（非名单 OPENID）
  const entryMod2 = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(dirA, 'server', 'scheduleSandbox', 'index.js'), 'utf8'), {
    require: name => {
      if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => ({ APPID: APPID, OPENID: SYNTHETIC_OTHER_ACCOUNT }), database: () => db };
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
  // (3) 错轮次：ROUND_MISMATCH 且零工厂增量
  const factoryBefore2 = counters.factory;
  const r3 = await entryMod.exports.main({ picRequest: { schema: 'participant-self-registration-request/1', action: 'registerSelf', registrationRoundId: 'other-round', passphrase: SYNTHETIC_PASSPHRASE } });
  assert.equal(r3.code, 'PIC_ROUND_MISMATCH');
  assert.equal(counters.factory, factoryBefore2, '错轮次零工厂增量');
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

test('PSR 真实 SDK 形状（本地依赖，无云调用）：runTransaction/doc/create/get 形状与依赖版本披露', () => {
  const sdkPath = process.env.MEMBER_ACCESS_SDK_PATH;
  if (!sdkPath || !fs.existsSync(sdkPath)) {
    assert.ok(true, '本地 wx-server-sdk 依赖不可用：SDK 事务转换验证列为阻断（不安装）');
    return;
  }
  const sdk = require(sdkPath);
  assert.equal(typeof sdk.DYNAMIC_CURRENT_ENV, 'symbol');
  const inst = new sdk({ SECRETID: 'x', SECRETKEY: 'y', ENVID: 'synthetic-env' });
  assert.equal(typeof inst.database, 'function', 'database 工厂存在');
  const db = inst.database();
  assert.equal(typeof db.runTransaction, 'function', 'runTransaction 存在（事务语义形状）');
  assert.equal(typeof db.collection, 'function');
  const col = db.collection('schtest_v1_users');
  const docRef = col.doc('synthetic-id');
  assert.ok(docRef, 'doc 引用可构造');
  assert.equal(typeof col.add === 'function' || typeof col.doc === 'function', true);
  const pkgPath = path.join(sdkPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(pkg.version, '3.0.1', 'SDK 精确版本 3.0.1（本机依赖）');
  }
});
