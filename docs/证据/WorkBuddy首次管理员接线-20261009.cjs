'use strict';
/**
 * 首次管理员受控接线 —— 离线复现（stdout-only）
 * ==============================================
 * 依据 docs/WorkBuddy任务-首次管理员受控接线与本人登记准备-20261009.md
 *
 * 合成传输替换在哪一层（如实标注）：
 *  - CLI 层：`deps.spawn` 替换子进程；
 *  - SDK 层：`@cloudbase/database` 的 `Db.reqClass` 替换为合成请求类 ——
 *    真实 sdk.init / database() / 文档序列化 / 事务对象仍走固定 SDK。
 *
 * 硬边界：未联网、未取真实凭据、未读认证缓存内容、未初始化、未建资源、
 * 未部署、未启用入口。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MINIAPP = path.join(PROJECT_ROOT, 'miniapp');
const host = require(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-execution-host.cjs'));
const worker = require(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-execution-worker.cjs'));
const p4 = require(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-bootstrap.cjs'));
const adapterF = require(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-sdk-adapter.cjs'));
const credentialHost = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-cli-credential-host.cjs'));
const cliObserver = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-readonly-observer.cjs'));

const results = [];
function record(id, pass, observed) {
  results.push({ id, pass: Boolean(pass), observed: observed === undefined ? null : observed });
}

const SYN_OPENID = 'synthetic-offline-openid';
const SYN_TARGET = p4.deriveUserId(p4.FIXED_APP_ID, SYN_OPENID);
const RID = '00000000-0000-4000-8000-000000000001';
const SYN_STS = {
  Type: 'CAMRole', AccountId: '123456789012',
  UserId: 'SYNTHETIC_USER_ID_VALUE', PrincipalId: 'SYNTHETIC_PRINCIPAL_ID_VALUE',
  Arn: 'qcs::cam::uin/123456789012:role/r', RequestId: RID
};

function syntheticApproval() {
  return {
    approvedUserIds: [SYN_TARGET],
    approvedBy: 'SYNTHETIC_OPERATOR_OFFLINE_ONLY',
    approvedAt: new Date(1700000000000).toISOString()
  };
}
function syntheticPlan() {
  return {
    enabled: true, appId: p4.FIXED_APP_ID, envId: p4.FIXED_ENV_ID,
    roundId: 'SYNTH-ROUND-0001', targetUserId: SYN_TARGET,
    evidenceId: 'SYNTH-EVIDENCE-0001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    schemaVersion: 1, operatorRef: 'SYNTHETIC_OPERATOR_OFFLINE_ONLY',
    approvedOwnerHint: '2d3aa4'
  };
}
function syntheticApprovalSource(plan) {
  return {
    controlled: true,
    approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    expiresAtMs: Date.now() + 3600000,
    writeScope: ['initializePrimary'],
    planDigest: p4.inputDigest(plan),
    fileFingerprint: {
      cliBundleSha256: credentialHost.FINGERPRINT.bundleSha256,
      cliEntrySha256: credentialHost.FINGERPRINT.entrySha256
    }
  };
}

// ── A 默认与拒绝 ────────────────────────────────────────────────────────
{
  const okLocal = host.parseArgs(['--local-check']).ok === true;
  const forbidden = ['--execute', '--init', '--initialize', '--deploy', '--force', '--yes',
    '--env', '--collection', '--url', '--endpoint', '--script', '--adapter',
    '--secret', '--token', '--credential', '--auth', '--region', '--appid', '--user', '--openid'];
  const allForbidden = forbidden.every(f => host.parseArgs([f]).reason === 'ARG_FORBIDDEN');
  const unknown = host.parseArgs(['--bogus']).reason === 'ARG_UNKNOWN';
  record('A-1-arg-allowlist-no-execute', okLocal && allForbidden && unknown, {
    localCheck: okLocal, forbiddenCount: forbidden.length, allForbidden, unknown
  });
}

(async () => {
  const lc = await host.localCheck({
    cliEntry: cliObserver.FIXED.cliEntry, cliBundle: cliObserver.FIXED.cliBundle
  });
  record('A-2-default-local-check-closed', lc.status === host.STATUS.LOCAL_READY &&
    lc.credentialFetched === false && lc.cloudCallAttempted === false &&
    lc.workerStarted === false, {
    status: lc.status, checks: lc.checks.length,
    credentialFetched: lc.credentialFetched, cloudCallAttempted: lc.cloudCallAttempted,
    workerStarted: lc.workerStarted,
    fixed: { appId: lc.fixed.appId, envId: lc.fixed.envId, region: lc.fixed.region }
  });

  const plan = syntheticPlan();
  const cases = [
    ['无来源', null],
    ['计划摘要不符', Object.assign(syntheticApprovalSource(plan), { planDigest: 'f'.repeat(64) })],
    ['文件指纹不符', Object.assign(syntheticApprovalSource(plan), {
      fileFingerprint: { cliBundleSha256: '0'.repeat(64), cliEntrySha256: '0'.repeat(64) } })],
    ['已过期', Object.assign(syntheticApprovalSource(plan), { expiresAtMs: Date.now() - 1 })],
    ['未声明写范围', Object.assign(syntheticApprovalSource(plan), { writeScope: [] })],
    ['非受控来源', Object.assign(syntheticApprovalSource(plan), { controlled: false })]
  ];
  const rows = [];
  let allRejected = true;
  for (const [label, src] of cases) {
    const r = host.verifyControlledApproval({ approvalSource: src, plan, now: () => Date.now() });
    if (r.ok) allRejected = false;
    rows.push({ label, ok: r.ok, errorCode: r.errorCode });
  }
  const good = host.verifyControlledApproval({
    approvalSource: syntheticApprovalSource(plan), plan, now: () => Date.now()
  });
  record('A-3-controlled-approval-binding', allRejected && good.ok === true, {
    rejected: rows, correctSourceAccepted: good.ok, planDigest: good.planDigest
  });

  // 计划自报批准字段不构成授权
  const tampered = Object.assign({}, plan, { trusted: true, allowed: true, approvedBy: 'ME' });
  const r2 = await host.executeOnce({
    plan: tampered, approval: syntheticApproval(),
    approvalSource: { controlled: true, approvedBy: 'ME', expiresAtMs: Date.now() + 1000 },
    now: () => Date.now(), roundId: 'SYNTH-ROUND-0001',
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rep-a3-')),
    isolationDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rep-a3i-')),
    spawn: () => { throw new Error('MUST_NOT_SPAWN'); }
  });
  record('A-4-plan-self-report-is-not-authorization',
    r2.credentialFetched === false && r2.stoppedAt === 'approvalSource',
    { stoppedAt: r2.stoppedAt, errorCode: r2.errorCode, credentialFetched: r2.credentialFetched });

  // ── B 元组摘要 ──────────────────────────────────────────────────────
  const d1 = host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'A', UserId: 'U', PrincipalId: 'P' });
  const d2 = host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'A', UserId: 'P', PrincipalId: 'U' });
  const d3 = host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'a', UserId: 'U', PrincipalId: 'P' });
  const expect = crypto.createHash('sha256')
    .update(JSON.stringify(['CAMRole', 'A', 'U', 'P']), 'utf8').digest('hex');
  record('B-subject-tuple-digest-fixed', d1 === expect && d1 !== d2 && d1 !== d3 &&
    host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'A', UserId: 'U' }) === null, {
    digest: d1, orderSensitive: d1 !== d2, caseSensitive: d1 !== d3,
    incompleteReturnsNull: true,
    note: '严格保持字符串：不裁尾、不改大小写；与手算一致'
  });

  // ── D 事务门槛（真实 P4 + 真实 SDK 本地转换） ───────────────────────
  const sdkRoot = host.FIXED.sdkRoot;
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const origReq = database.Db.reqClass;
  function installTransport(docs) {
    const seen = [];
    class SyntheticRequest {
      async send(action, params) {
        seen.push({ action, coll: params.collectionName });
        const doc = docs[params.collectionName];
        return { data: { list: doc === undefined ? [] : [JSON.stringify(doc)] }, requestId: RID };
      }
    }
    database.Db.reqClass = SyntheticRequest;
    return { seen, restore: () => { database.Db.reqClass = origReq; } };
  }
  async function runWorkerWithDocs(docs, patch) {
    const t = installTransport(docs);
    let out = null;
    try {
      await worker.run(Object.assign({
        credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
        plan: syntheticPlan(), approval: syntheticApproval(),
        verifiedCaller: true, fixedNowMs: Date.now()
      }, patch || {}), { now: () => Date.now(), emit: (v) => { out = v; } });
      return { out, seen: t.seen };
    } finally { t.restore(); }
  }

  {
    const { out, seen } = await runWorkerWithDocs({});
    const writes = seen.filter(x => x.action !== 'database.getDocument');
    record('D-1-missing-user-zero-write',
      writes.length === 0 && out && out.ok === false && out.bootstrap === null,
      { reads: seen.length, writes: writes.length, errorCode: out && out.errorCode,
        note: '目标用户缺失 → 零 set/commit' });
  }
  {
    const plan = syntheticPlan();
    const auditId = p4.auditId(plan, p4.inputDigest(plan));
    const { out, seen } = await runWorkerWithDocs({
      schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID },
      schtest_v1_audit_events: { _id: auditId, subjectUserId: SYN_TARGET }
    });
    const writes = seen.filter(x => x.action !== 'database.getDocument');
    record('D-3-audit-exists-primary-missing-stops',
      writes.length === 0 && out && out.bootstrap === null && out.ok === false,
      { writes: writes.length, enteredTransaction: out && out.bootstrap !== null,
        errorCode: out && out.errorCode, auditId,
        note: '审计已存在场景下零写；本轮因组合调用缺口未能观察 outcome=auditAlreadyPresent（见 GAP 项）' });
  }
  {
    const { out, seen } = await runWorkerWithDocs({}, {
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() - 1 }
    });
    record('D-4-expired-credential-zero-read', seen.length === 0 &&
      out && out.errorCode === 'WORKER_CREDENTIAL_EXPIRED',
      { reads: seen.length, errorCode: out && out.errorCode });
  }

  // ── G 边界 ───────────────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-execution-worker.cjs'), 'utf8');
  const hostSrc = fs.readFileSync(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-execution-host.cjs'), 'utf8');
  const forbidden = ['schtest_v1_projects', 'createProject', 'identify(',
    'requestBindingNumber', 'callFunction'];
  record('G-1-no-business-route-or-resource-creation',
    forbidden.every(f => src.indexOf(f) === -1) &&
    adapterF.WRITE_COLLECTIONS.slice().sort().join() === 'schtest_v1_app_admins,schtest_v1_audit_events',
    { forbiddenHits: forbidden.filter(f => src.indexOf(f) !== -1),
      writeCollections: adapterF.WRITE_COLLECTIONS.slice(),
      memberAccessIsOnlySdkPath: worker.SDK_ROOT.indexOf('memberAccess-readonly-sdk') !== -1 });

  record('G-2-no-execute-in-public-surface',
    host.ALLOWED_ARGS.indexOf('--execute') === -1 &&
    host.FORBIDDEN_ARG_PREFIXES.indexOf('--execute') !== -1 &&
    host.FORBIDDEN_ARG_PREFIXES.indexOf('--initialize') !== -1,
    { allowedArgs: host.ALLOWED_ARGS.slice(),
      executeIsForbidden: true, initializeIsForbidden: true,
      forbiddenPrefixCount: host.FORBIDDEN_ARG_PREFIXES.length,
      note: '--execute 不在允许集且在禁止集 —— 公共面无执行入口' });

  // ── 接口缺口（如实记录，未通过 skip 冒充） ─────────────────────────
  const combined = [];
  {
    // 组合调用路径：与已通过的模块测试同形
    let out = null;
    try {
      out = await host.executeOnce({
        plan: syntheticPlan(), approval: syntheticApproval(),
        approvalSource: syntheticApprovalSource(syntheticPlan()),
        now: () => Date.now(), roundId: 'SYNTH-ROUND-0001',
        profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rep-g-')),
        isolationDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rep-gi-')),
        spawn: () => { throw new Error('MUST_NOT_SPAWN'); },
        spawnWorker: () => { throw new Error('MUST_NOT_SPAWN'); },
        expectedSubjectDigest: host.callerTupleDigest(SYN_STS),
        persistRoundStarted: () => false
      });
    } catch (e) {
      combined.push({ threw: String(e && e.code) });
    }
    combined.push(out ? { stoppedAt: out.stoppedAt, errorCode: out.errorCode,
      credentialFailureClass: out.credentialFailureClass } : null);
  }
  record('GAP-combined-call-vs-separate-call', false, {
    finding: '宿主/worker 组合调用与分别调用同一模块行为不一致；未查明机制',
    combinedResult: combined,
    excluded: [
      '同一入参单独调用 P4 六函数全部通过',
      '相同 spawn 替身单独调用凭据宿主成功（attempted=true）',
      'argv 形状正确、credDeps 内容正确',
      '已验收模块哈希全部未变'
    ],
    skippedTests: ['B-1', 'C-1', 'C-3', 'C-4', 'D-2', 'D-3', 'E-1', 'E-2', 'E-3'],
    disposition: '按项目规则停止该路径；未改已验收模块迁就测试；交 Codex 裁决'
  });

  const failed = results.filter(r => !r.pass).length;
  const files = [
    'miniapp/scripts/lib/sandbox-primary-execution-host.cjs',
    'miniapp/scripts/lib/sandbox-primary-execution-worker.cjs',
    'miniapp/tests/sandbox-primary-execution-host.test.cjs',
    'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs',
    'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs',
    'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs',
    'miniapp/scripts/lib/cloudbase-readonly-observer.cjs',
    'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs',
    'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs',
    'miniapp/scripts/prepare-sandbox-primary.cjs'
  ];
  process.stdout.write(JSON.stringify({
    observedAt: new Date().toISOString(),
    auditKind: 'offline-wiring-verification-not-production-component',
    scope: 'L1 受控初始化宿主 + L3 本人登记准备稿',
    delivers: '本地受控接线模块 + 操作稿；默认关闭与参数边界已验证',
    doesNotDeliver: '**未执行**真实管理员初始化、**未执行**本人微信登记、**未取得**真实云主体摘要',
    realCredentialFetches: 0, realCloudCalls: 0, realNetworkCalls: 0,
    readRealAuthContent: false, wroteHistoricalOrBusinessFiles: false,
    summary: { total: results.length, passed: results.length - failed, failed },
    results,
    retainedHistoricalEvidence: {
      note: '历史证据与已验收实现均未改写',
      untouchedModules: {
        'sandbox-primary-bootstrap.cjs': '133c21ae4b1081a1',
        'sandbox-primary-sdk-adapter.cjs': '9088e6478b940a4c',
        'cloudbase-cli-credential-host.cjs': 'bccea293069e22ed',
        'cloudbase-readonly-observer.cjs': '3b05a3057afc0206',
        'cloudbase-sdk-readonly-worker.cjs': 'c5368fff5131d6d4',
        'cloudbase-sdk-readonly-observer.cjs': 'f43a557d49b3923e'
      }
    },
    remainingPreconditions: [
      '本人测试记录未执行（当前无 prepare 包，仅两个 closed 制品）',
      '完整云主体元组摘要的真实预期值未取得（只实现算法）',
      '最终写批准与制品绑定（含文件指纹）未形成',
      '部署与关闭能力本轮不具备',
      '实际平台事务与费用未验证'
    ],
    sha256: Object.fromEntries(files.map(f => [f,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJECT_ROOT, f))).digest('hex')]))
  }, null, 2));
})().catch(() => {
  process.stderr.write('REPRO_FAILED_NO_RAW_ERROR\n');
  process.exitCode = 1;
});