'use strict';
/**
 * Codex 复核 S1–S4 收尾复现（2026-10-09）
 * =============================================
 *
 * 只读本地源码 + 合成传输。**不联网、不取真实凭据、不初始化、不建资源、
 * 不部署、不启用入口**。已验收模块（P4 / SDK 适配器 / 凭据宿主 / 只读编排 /
 * 计时器 / 旧 CLI / 业务云函数 / vendor / 入口配置 / 打包器）本轮未改。
 *
 * 与 Codex 那份「缺陷复现脚本」定位不同：那份测**问题是否复现**（改前应为
 * defect=true），本份测**返修后关键反例是否被拒绝**（应pass=true），
 * 并直接断言拒绝 / 零写 / 确定性键 / 绑定快照的实际结果。
 * 旧脚本本轮**未复跑**，其结论不作为闭合依据。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '../..');
const MINI = path.join(ROOT, 'miniapp');
const host = require(path.join(MINI, 'scripts/lib/sandbox-primary-execution-host.cjs'));
const worker = require(path.join(MINI, 'scripts/lib/sandbox-primary-execution-worker.cjs'));
const p4 = require(path.join(MINI, 'scripts/lib/sandbox-primary-bootstrap.cjs'));
const credentialHost = require(path.join(MINI, 'scripts/lib/cloudbase-cli-credential-host.cjs'));

const RID = '00000000-0000-4000-8000-000000000001';
const SYN_ACCOUNT = '123456789012';
const OPENID = 'synthetic-offline-openid';
const SYN_STS = {
  Type: 'CAMRole', AccountId: SYN_ACCOUNT,
  UserId: 'SYNTHETIC_USER_ID_VALUE', PrincipalId: 'SYNTHETIC_PRINCIPAL_ID_VALUE',
  Arn: 'qcs::cam::uin/' + SYN_ACCOUNT + ':role/r', RequestId: RID
};

const results = [];
function record(id, pass, observed) {
  results.push({ id, pass: Boolean(pass), observed: observed === undefined ? null : observed });
  return Boolean(pass);
}
function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }

/** 合成 CLI 子进程（凭据命令 + 固定 API）；不执行任何真实程序。 */
function cliSpawn(captured, opts) {
  const o = opts || {};
  return (bin, argv, options) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    const schedule = (text, code) => setImmediate(() => {
      if (text !== null) c.stdout.emit('data', Buffer.from(text));
      c.emit('exit', code === undefined ? 0 : code, null);
      c.emit('close', code === undefined ? 0 : code, null);
    });
    if (argv[1] === 'secrets') {
      captured.credentialFetches++;
      captured.fetchEnvToken = options && options.env
        ? options.env.TENCENTCLOUD_SESSIONTOKEN : undefined;
      schedule(JSON.stringify({
        data: {
          secretId: 'SYNTH_ID', secretKey: 'SYNTH_KEY', token: 'SYNTH_TOKEN',
          isTemporary: true, expiredAt: new Date(Date.now() + 1800000).toISOString(), envId: null
        }
      }), o.credentialExit);
      return c;
    }
    if (argv[1] === 'api') {
      captured.apiCalls.push({
        key: argv[2] + '.' + argv[3],
        sessionToken: options && options.env ? options.env.TENCENTCLOUD_SESSIONTOKEN : null,
        cwd: options && options.cwd
      });
      const key = argv[2] + '.' + argv[3];
      const data = key === 'sts.GetCallerIdentity' ? (o.sts || SYN_STS)
        : key === 'tcb.DescribeEnvs'
          ? { EnvList: [{ EnvId: host.FIXED.envId, Status: 'NORMAL', Region: host.FIXED.region }], RequestId: RID }
          : {
            EnvInfo: {
              EnvBaseInfo: { EnvId: host.FIXED.envId, Status: 'NORMAL', Region: host.FIXED.region },
              UserInfo: { Uin: SYN_ACCOUNT, WxAppId: host.FIXED.appId }
            }, RequestId: RID
          };
      schedule('ℹ →' + String(argv[2]).toUpperCase() + '.' + argv[3] + '\n' +
        JSON.stringify({ data }) + '\n', o.apiExit);
      return c;
    }
    throw new Error('UNEXPECTED_CLI_STAGE');
  };
}

/** 合成 SDK 传输（替换静态 Db.reqClass）+ 注入 db；事务控制与集合读写分开计数。 */
function installSdkTransport(docs) {
  const sdkRoot = host.FIXED.sdkRoot;
  require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const bson = require(path.join(sdkRoot, 'bson'));
  const EJSON = bson.EJSON || bson;
  const asE = doc => JSON.stringify(EJSON.serialize(doc, { relaxed: false }));
  // 顺序：先建 db，后替换静态传输（Db.reqClass 是静态属性，database() 会重设它）
  const db = sdk.init({
    env: 'offline-shape-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true
  }).database();
  const original = database.Db.reqClass;
  const store = {};
  for (const [k, v] of Object.entries(docs || {})) {
    store[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  const seen = [];
  let actionHook = null;
  database.Db.reqClass = class {
    async send(action, params = {}) {
      seen.push({ action, coll: params.collectionName, params });
      if (typeof actionHook === 'function') actionHook(action, params);
      let key = null;
      try {
        key = typeof params.query === 'string'
          ? (JSON.parse(params.query)._id || null)
          : (params.query && params.query._id) || params._id || null;
      } catch (_) { key = params._id || null; }
      if (action === 'database.startTransaction') return { transactionId: 'synthetic-tx-1' };
      if (action === 'database.commitTransaction') return { requestId: RID };
      if (action === 'database.abortTransaction') return { requestId: RID };
      if (action === 'database.getDocument' || action === 'database.getInTransaction') {
        const d = store[params.collectionName];
        return {
          data: {
            list: (d !== undefined && d !== null && (key === null || d._id === key)) ? [asE(d)] : []
          },
          requestId: RID
        };
      }
      if (action === 'database.modifyDocument' || action === 'database.updateDocInTransaction') {
        const incoming = JSON.parse(params.data);
        const prev = store[params.collectionName];
        const id = key || (prev ? prev._id : null);
        store[params.collectionName] = Object.assign({}, prev || {}, incoming, id ? { _id: id } : {});
        return { data: { updated: prev ? 1 : 0, upsert_id: prev ? undefined : id }, requestId: RID };
      }
      throw new Error('unexpected SDK action: ' + action);
    }
  };
  const isRead = a => a === 'database.getDocument' || a === 'database.getInTransaction';
  const isWrite = a => a === 'database.modifyDocument' || a === 'database.updateDocInTransaction';
  return {
    db, seen, store,
    setHook: (fn) => { actionHook = typeof fn === 'function' ? fn : null; },
    counts: () => ({
      userGet: seen.filter(x => isRead(x.action) && x.coll === 'schtest_v1_users').length,
      primarySet: seen.filter(x => isWrite(x.action) && x.coll === 'schtest_v1_app_admins').length,
      auditSet: seen.filter(x => isWrite(x.action) && x.coll === 'schtest_v1_audit_events').length,
      commit: seen.filter(x => x.action === 'database.commitTransaction').length,
      abort: seen.filter(x => x.action === 'database.abortTransaction').length,
      begin: seen.filter(x => x.action === 'database.startTransaction').length,
      readOnlyGet: seen.filter(x => isRead(x.action) && !x.params.transactionId).length
    }),
    restore: () => { database.Db.reqClass = original; }
  };
}

function syntheticPlan(patch) {
  return Object.assign({
    enabled: true, appId: p4.FIXED_APP_ID, envId: p4.FIXED_ENV_ID,
    roundId: 'SYNTH-ROUND-0001',
    targetUserId: p4.deriveUserId(p4.FIXED_APP_ID, OPENID),
    evidenceId: 'SYNTH-EVIDENCE-0001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    schemaVersion: 1, operatorRef: 'SYNTHETIC_OPERATOR_OFFLINE_ONLY',
    approvedOwnerHint: '2d3aa4'
  }, patch || {});
}
function approvalOf(plan) {
  return {
    approvedUserIds: [plan.targetUserId],
    approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    approvedAt: new Date().toISOString()
  };
}
function issueFor(plan, patch) {
  const p = patch || {};
  return host.issueControlledApproval({
    plan, approval: p.approval || approvalOf(plan),
    approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    writeScope: p.writeScope || ['initializePrimary'],
    expiresAtMs: typeof p.expiresAtMs === 'number' ? p.expiresAtMs : Date.now() + 3600000,
    expectedSubjectDigest: p.expectedSubjectDigest || host.callerTupleDigest(SYN_STS)
  });
}
function dirs(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's14-' + tag + '-'));
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  return { profileDir, root };
}
/** 合成 worker 子进程：走真实 worker.run（真实 P4 + 注入的 db）。 */
function workerSpawn(tr, opts) {
  const o = opts || {};
  return (bin, argv, options) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    let payload = null;
    c.stdin.write = (raw) => {
      payload = JSON.parse(String(raw));
      if (typeof o.onPayload === 'function') o.onPayload(payload);
      return true;
    };
    c.stdin.end = () => {};
    c.kill = () => true;
    setImmediate(async () => {
      if (o.hang) return;
      let emitted = null;
      try {
        await worker.run(payload || {}, {
          now: () => Date.now(), db: tr.db, emit: (v) => { emitted = v; }
        });
      } catch (e) { emitted = { ok: false, errorCode: 'WORKER_UNEXPECTED' }; }
      c.stdout.emit('data', Buffer.from(JSON.stringify(
        emitted === null ? { ok: false, errorCode: 'WORKER_NO_OUTPUT' } : emitted)));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    return c;
  };
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  // ── S1：绑定快照 ────────────────────────────────────────────────────
  {
    const plan = syntheticPlan();
    const handle = issueFor(plan);
    let writeRejected = false;
    try { handle.approval.approvedBy = 'SYNTH_TAMPERED'; }
    catch (e) { writeRejected = /read only|Cannot assign|not extensible/i.test(String(e && e.message)); }
    const snap = host.boundSnapshot(handle, plan);
    record('S1-1-handle-nested-immutable',
      handle.approval.approvedBy === 'SYNTHETIC_REVIEWER_OFFLINE_ONLY' &&
      Object.isFrozen(handle.approval) && Object.isFrozen(handle.plan) &&
      Object.isFrozen(handle.implementationFingerprint) &&
      (writeRejected || Object.isFrozen(handle.approval)) &&
      snap !== null && snap.approval.approvedBy === 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
      {
        approvedByUnchanged: handle.approval.approvedBy === 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
        approvalFrozen: Object.isFrozen(handle.approval),
        planFrozen: Object.isFrozen(handle.plan),
        fingerprintFrozen: Object.isFrozen(handle.implementationFingerprint),
        writeRejectedOrFrozen: writeRejected || Object.isFrozen(handle.approval),
        snapshotApprovalBy: snap ? snap.approval.approvedBy : null
      });
  }
  {
    // 调用方计划与绑定快照不同 → boundSnapshot 必须拒绝（不静默替换）
    const plan = syntheticPlan();
    const handle = issueFor(plan);
    const other = Object.assign({}, plan, { operatorRef: 'SOMEONE_ELSE' });
    const snapSame = host.boundSnapshot(handle, plan);
    const snapDiff = host.boundSnapshot(handle, other);
    record('S1-2-plan-difference-rejected',
      snapSame !== null && snapDiff === null,
      { samePlanAccepted: snapSame !== null, differentPlanRejected: snapDiff === null });
  }
  {
    // 端到端：调用方 o.approval 的 approvedBy 不同 → worker 载荷仍是绑定快照的值
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const tr = installSdkTransport({ schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID } });
    let sent = null;
    try {
      const r = await host.executeOnce({
        plan,
        approval: { approvedUserIds: [plan.targetUserId],
          approvedBy: 'SYNTH_DIFFERENT_REVIEWER', approvedAt: new Date().toISOString() },
        approvalSource: issueFor(plan),
        now: () => Date.now(), roundId: plan.roundId,
        ...dirs('S1e'),
        spawn: cliSpawn(captured),
        spawnWorker: workerSpawn(tr, { onPayload: (x) => { sent = x; } }),
        persistRoundStarted: () => true,
        persistResult: () => true
      });
      record('S1-3-worker-payload-from-bound-snapshot',
        sent !== null &&
        sent.approval.approvedBy === 'SYNTHETIC_REVIEWER_OFFLINE_ONLY' &&
        sent.approval.approvedBy !== 'SYNTH_DIFFERENT_REVIEWER' &&
        r.observationConfirmed === true,
        {
          payloadApprovedBy: sent ? sent.approval.approvedBy : null,
          observationConfirmed: r.observationConfirmed,
          status: r.status
        });
    } finally { tr.restore(); }
  }
  {
    // started 之后改调用方计划 → 执行原绑定快照
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const tr = installSdkTransport({ schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID } });
    let sent = null;
    try {
      const mutable = JSON.parse(JSON.stringify(plan));
      const r = await host.executeOnce({
        plan: mutable,
        approval: approvalOf(plan),
        approvalSource: issueFor(plan),
        now: () => Date.now(), roundId: plan.roundId,
        ...dirs('S1f'),
        spawn: cliSpawn(captured),
        spawnWorker: workerSpawn(tr, { onPayload: (x) => { sent = x; } }),
        persistRoundStarted: () => {
          mutable.operatorRef = 'SYNTH_TAMPERED_OPERATOR_REF';
          return true;
        },
        persistResult: () => true
      });
      record('S1-4-plan-change-after-started-ignored',
        sent !== null &&
        sent.plan.operatorRef === plan.operatorRef &&
        sent.plan.operatorRef !== 'SYNTH_TAMPERED_OPERATOR_REF' &&
        r.observationConfirmed === true,
        {
          payloadOperatorRef: sent ? sent.plan.operatorRef : null,
          tamperedValue: 'SYNTH_TAMPERED_OPERATOR_REF',
          observationConfirmed: r.observationConfirmed
        });
    } finally { tr.restore(); }
  }

  // ── S2：执行期时效 ──────────────────────────────────────────────────
  {
    const plan = syntheticPlan();
    const tr = installSdkTransport({ schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID } });
    try {
      let clockMs = Date.now();
      let out = null;
      // 在 SDK 读取动作事件上推进合成时钟（不按 now() 次数猜测）
      tr.setHook((action) => {
        if (action === 'database.getInTransaction' || action === 'database.getDocument') {
          clockMs += 7200000;
        }
      });
      await worker.run({
        credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 3600000 },
        plan, approval: approvalOf(plan), verifiedCaller: true,
        fixedNowMs: Date.now(), approvalExpiresAtMs: Date.now() + 3600000
      }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
      const c = tr.counts();
      record('S2-1-expire-after-tx-read-zero-write',
        c.primarySet === 0 && c.auditSet === 0 && c.commit === 0 && out.ok === false,
        {
          sdkCounts: c, ok: out.ok, errorCode: out.errorCode,
          credentialExpiredDuringRun: out.credentialExpiredDuringRun,
          planExpiredDuringRun: out.planExpiredDuringRun
        });
    } finally { tr.restore(); }
  }
  {
    const tr = installSdkTransport({ schtest_v1_users: { _id: syntheticPlan().targetUserId, status: 'active', openid: OPENID } });
    try {
      let out = null;
      const plan = syntheticPlan();
      await worker.run({
        credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 3600000 },
        plan, approval: approvalOf(plan), verifiedCaller: true,
        fixedNowMs: Date.now(), approvalExpiresAtMs: Date.now() - 1
      }, { db: tr.db, emit: (v) => { out = v; } });
      record('S2-2-expire-before-begin',
        tr.counts().begin === 0 && out.ok === false,
        { begin: tr.counts().begin, errorCode: out.errorCode, expiredAtStage: out.expiredAtStage });
    } finally { tr.restore(); }
  }
  {
    const tr = installSdkTransport({});
    try {
      let out = null;
      await worker.run({
        credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
        plan: syntheticPlan(), approval: syntheticApprovalUnused(), verifiedCaller: true,
        fixedNowMs: Date.now()
      }, { db: tr.db, emit: (v) => { out = v; } });
      record('S2-3-missing-approval-deadline-rejected',
        out.errorCode === worker.ERR.APPROVAL_INVALID && tr.seen.length === 0,
        { errorCode: out.errorCode, transportCalls: tr.seen.length });
    } finally { tr.restore(); }
  }

  // ── S3：异常后的核对与留证 ──────────────────────────────────────────
  {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const expectedAuditId = p4.auditId(plan, p4.inputDigest(plan));
    const tr = installSdkTransport({ schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID } });
    const started = [];
    const saves = [];
    try {
      const r = await host.executeOnce({
        plan, approval: approvalOf(plan), approvalSource: issueFor(plan),
        now: () => Date.now(), roundId: plan.roundId,
        ...dirs('S3a'),
        spawn: cliSpawn(captured),
        spawnWorker: (() => {
          const mk = () => {
            const c = new EventEmitter();
            c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
            c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
            return c; // 不 close、不 exit → 触发超时
          };
          return mk;
        })(),
        persistRoundStarted: (v) => { started.push(v); return true; },
        persistResult: (v) => { saves.push(v); return true; },
        workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
      });
      record('S3-1-timeout-keeps-reconcile-keys',
        r.errorCode === host.ERR.RESULT_UNKNOWN && r.resultUnknown === true &&
        r.auditId === expectedAuditId && r.roundId === plan.roundId &&
        started.length === 1 && started[0].auditId === expectedAuditId &&
        saves.length === 0,
        {
          errorCode: r.errorCode, resultUnknown: r.resultUnknown,
          auditIdKept: r.auditId === expectedAuditId,
          roundIdKept: r.roundId === plan.roundId,
          startedAuditId: started.length ? started[0].auditId : null,
          resultSaves: saves.length,
          reconcileAttempted: r.reconcileAttempted === true,
          reconcileSkipReason: r.reconcileSkipReason || null
        });
    } finally { tr.restore(); }
  }
  {
    const r = await host.runExecutionWorker({
      snapshot: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      plan: syntheticPlan(), approval: approvalOf(syntheticPlan()), verifiedCaller: true,
      fixedNowMs: Date.now(), approvalExpiresAtMs: Date.now() + 60000,
      cwd: os.tmpdir(),
      spawn: () => {
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from('{ not json at all'));
          c.emit('exit', 0, null); c.emit('close', 0, null);
        });
        return c;
      },
      limits: { timeoutMs: 5000, maxOutputBytes: 65536, closeGraceMs: 20 }
    });
    record('S3-2-malformed-output-is-unknown',
      r.ok === false && r.resultUnknown === true && r.reason === 'MALFORMED_OUTPUT',
      { ok: r.ok, resultUnknown: r.resultUnknown, reason: r.reason,
        exitCode: r.processFacts.exitCode });
  }
  {
    const r = host.projectWorkerOutput(
      { ok: false, errorCode: 'RESULT_UNKNOWN', resultUnknown: true,
        outcome: 'UNKNOWN', granted: false, initialized: false, observationConfirmed: false },
      { spawnError: false, timedOut: false, overflow: false, signal: null,
        exitCode: 0, closeNotObserved: false, terminationRequested: false, terminationConfirmed: true },
      false, null, { auditId: 'sbx-init-primary:x', inputDigest: 'a'.repeat(32) });
    record('S3-3-declared-unknown-not-overwritten', r.resultUnknown === true,
      { resultUnknown: r.resultUnknown, ok: r.ok });
  }

  // ── S4：字段值限定 ──────────────────────────────────────────────────
  {
    const marker = 'SYNTH_PRIVATE_MARKER';
    const expected = { auditId: 'sbx-init-primary:expected', inputDigest: 'a'.repeat(32) };
    const facts = { spawnError: false, timedOut: false, overflow: false, signal: null,
      exitCode: 0, closeNotObserved: false, terminationRequested: false, terminationConfirmed: true };
    const r = host.projectWorkerOutput({
      ok: true, outcome: marker, granted: true, initialized: true,
      observationConfirmed: true, auditId: 'sbx-init-primary:expected',
      bootstrap: { ok: true, outcome: marker, granted: true, initialized: true,
        auditId: 'sbx-init-primary:expected', inputDigest: marker,
        errorCode: marker, requestIds: [marker],
        existingPrimary: { status: marker, sameAsTarget: 'yes' } },
      observed: { state: marker, primaryPresent: 'true', primaryStatus: marker,
        auditPresent: 'no', writeAuthorized: true, errorCode: marker }
    }, facts, false, null, expected);
    const dumped = JSON.stringify(r);
    record('S4-1-illegal-values-in-known-fields-dropped',
      dumped.includes(marker) === false &&
      r.outcome === 'UNKNOWN' && r.bootstrap.inputDigest === null &&
      r.bootstrap.errorCode === null && r.bootstrap.requestIds.length === 0 &&
      r.observed.state === 'unconfirmed' && r.observed.errorCode === null &&
      r.observed.writeAuthorized === false,
      {
        markerLeaked: dumped.includes(marker),
        outcome: r.outcome, bootstrapOutcome: r.bootstrap.outcome,
        inputDigest: r.bootstrap.inputDigest, requestIds: r.bootstrap.requestIds.length,
        observedState: r.observed.state, writeAuthorized: r.observed.writeAuthorized
      });
  }
  {
    const auditId = 'sbx-init-primary:expected';
    const digest = 'a'.repeat(32);
    const rid = RID;
    const facts = { spawnError: false, timedOut: false, overflow: false, signal: null,
      exitCode: 0, closeNotObserved: false, terminationRequested: false, terminationConfirmed: true };
    const r = host.projectWorkerOutput({
      ok: true, errorCode: null, resultUnknown: false, outcome: 'initialized',
      granted: true, initialized: true, observationConfirmed: true, auditId,
      bootstrap: { ok: true, outcome: 'initialized', granted: true, initialized: true,
        auditId, inputDigest: digest, errorCode: null, requestIds: [rid], existingPrimary: null },
      observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
        auditPresent: true, writeAuthorized: true, errorCode: null },
      observeFailed: false
    }, facts, false, null, { auditId, inputDigest: digest });
    record('S4-2-legit-values-pass',
      r.ok === true && r.outcome === 'initialized' && r.auditId === auditId &&
      r.bootstrap.inputDigest === digest && r.bootstrap.requestIds.length === 1 &&
      r.observed.state === 'present' && r.observed.primaryStatus === 'active',
      { ok: r.ok, outcome: r.outcome, auditId: r.auditId,
        inputDigest: r.bootstrap.inputDigest, requestIds: r.bootstrap.requestIds.length,
        observedState: r.observed.state });
  }
  {
    const facts = { spawnError: false, timedOut: false, overflow: false, signal: null,
      exitCode: 0, closeNotObserved: false, terminationRequested: false, terminationConfirmed: true };
    const r = host.projectWorkerOutput({
      ok: true, outcome: 'initialized', granted: true, initialized: true,
      observationConfirmed: true, auditId: 'sbx-init-primary:OTHER_SAME_PREFIX'
    }, facts, false, null,
    { auditId: 'sbx-init-primary:expected', inputDigest: 'a'.repeat(32) });
    record('S4-3-audit-key-prefix-only-rejected', r.auditId === null,
      { auditId: r.auditId });
  }
  {
    const hostCodes = new Set(Object.values(credentialHost.ERR));
    const all = hostCodes.size === host.CREDENTIAL_FAILURE_CODES.size;
    for (const c of hostCodes) {
      if (!host.CREDENTIAL_FAILURE_CODES.has(c)) all = false;
    }
    record('S4-4-credential-failure-allowlist-from-host',
      all &&
      host.CREDENTIAL_FAILURE_CODES.has('SYNTHETIC_ARBITRARY_TOKEN') === false &&
      host.CREDENTIAL_FAILURE_CODES.has('A'.repeat(64)) === false,
      { hostCodeCount: hostCodes.size,
        allowlistSize: host.CREDENTIAL_FAILURE_CODES.size,
        arbitraryTokenRejected: true });
  }

  // ── 成功对照 ────────────────────────────────────────────────────────
  {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const expectedAuditId = p4.auditId(plan, p4.inputDigest(plan));
    const tr = installSdkTransport({ schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID } });
    const saves = [];
    try {
      const r = await host.executeOnce({
        plan, approval: approvalOf(plan), approvalSource: issueFor(plan),
        now: () => Date.now(), roundId: plan.roundId,
        ...dirs('SOK'),
        spawn: cliSpawn(captured),
        spawnWorker: workerSpawn(tr),
        persistRoundStarted: () => true,
        persistResult: (v) => { saves.push(v); return true; }
      });
      const c = tr.counts();
      record('S-positive-control-full-chain',
        r.status === host.STATUS.PLAN_READY && r.outcome === 'initialized' &&
        r.initialized === true && r.observationConfirmed === true && r.resultPersisted === true &&
        r.auditId === expectedAuditId && saves.length === 1 && saves[0].auditId === expectedAuditId &&
        r.resultUnknown !== true &&
        c.begin === 1 && c.primarySet === 1 && c.auditSet === 1 && c.commit === 1 &&
        c.abort === 0 && c.readOnlyGet === 2 && captured.credentialFetches === 1,
        {
          status: r.status, outcome: r.outcome, observationConfirmed: r.observationConfirmed,
          resultPersisted: r.resultPersisted, auditId: r.auditId,
          sdkCounts: c, credentialCommands: captured.credentialFetches,
          fixedApiCalls: captured.apiCalls.length,
          sameSnapshotEveryApiCall: captured.apiCalls.every(a => a.sessionToken === 'SYNTH_TOKEN')
        });
    } finally { tr.restore(); }
  }

  // ── 源文件哈希 ──────────────────────────────────────────────────────
  const sourceHashes = {};
  for (const f of [
    'miniapp/scripts/lib/sandbox-primary-execution-host.cjs',
    'miniapp/scripts/lib/sandbox-primary-execution-worker.cjs',
    'miniapp/tests/sandbox-primary-execution-host.test.cjs',
    'docs/首次管理员受控接线与本人登记操作稿-20261009.md'
  ]) {
    sourceHashes[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
  }
  const historicalHashes = {};
  for (const f of [
    'docs/证据/Codex首次管理员R1R6返修复核-20261009.json',
    'docs/证据/WorkBuddy首次管理员接线R1R6返修复现-20261009.json'
  ]) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) {
      historicalHashes[f] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  }

  const passed = results.filter(r => r.pass).length;
  process.stdout.write(JSON.stringify({
    observedAt: new Date().toISOString(),
    scope: 'OFFLINE_SYNTHETIC_ONLY',
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
    sourceHashes,
    historicalEvidenceHashes: historicalHashes,
    boundaries: {
      realCredentialFetches: 0,
      realCloudCalls: 0,
      readRealAuthStoreContent: false,
      wroteHistoricalOrBusinessFiles: false,
      realInitializeExecuted: false,
      realDeploymentExecuted: false
    },
    statedLimitations: [
      '本证据只证明**返修后的离线行为**：合成凭据 + 合成 CLI 子进程 + 合成 SDK 传输。',
      '平台侧签名/IAM/事务行为**未验证**；注入 db 不验证生产 worker 自建 db 的同批凭据链。',
      'Codex 那份缺陷复现脚本本轮**未复跑**；其 reproduced=false 不作为闭合依据，',
      '  本证据改以新断言直接证明拒绝/零写/确定性键/绑定快照的实际结果。',
      '受控批准句柄由本模块 issueControlledApproval 签发，仅供离线；**真实批准未生成**。'
    ]
  }, null, 2) + '\n');
}

/** S2-c 专用：故意使用与计划目标不匹配的批准（仍在批准名单内，用于缺期限分支）。 */
function syntheticApprovalUnused() {
  const plan = syntheticPlan();
  return { approvedUserIds: [plan.targetUserId],
    approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY', approvedAt: new Date().toISOString() };
}

main().catch(() => { process.exit(1); });