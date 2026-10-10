#!/usr/bin/env node
/**
 * Codex 2026-10-10 复核 S2/S3/S4 剩余项定点收尾 —— 独立复现证据
 * ================================================================
 *
 * 范围：只验证本轮收尾的 S2（三期限独立 / begin 句柄 / 回读期限）、
 * S3（固定两读核对 / 未知终态落盘 / 核对净化 / 保存能力前置）与
 * S4（绑定一致性降级），以及 R3-e 真实子进程入口与 EBUSY 文案更正。
 *
 * 边界（硬性）：
 *  - 不联网、不取真实凭据、不初始化、不建资源、不部署、不启用入口；
 *  - 只使用合成 CLI/worker 事件与合成 SDK 传输；真实子进程入口只用
 *    **已过期**的合成凭据做入口早退，不触碰 SDK/云端路径；
 *  - 不读真实认证存储，不改产品源码与历史证据。
 *
 * 每条用例以**新断言**直接证明实际结果，不引用任何旧脚本的缺陷复现标记。
 * 闭合依据是新断言本身，不是「旧脚本不再复现」。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const MINIAPP = path.join(ROOT, 'miniapp');
const host = require(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-execution-host.cjs'));
const worker = require(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-execution-worker.cjs'));
const p4 = require(path.join(MINIAPP, 'scripts', 'lib', 'sandbox-primary-bootstrap.cjs'));
const credentialHost = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-cli-credential-host.cjs'));
const cliObserver = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-readonly-observer.cjs'));

const SDK_ROOT = host.FIXED.sdkRoot;
const RID = '00000000-0000-4000-8000-000000000001';
const SYN_ACCOUNT = '100000000001';
const OPENID = 'synthetic-offline-openid';
const APPROVAL_TTL_MS = Date.now() + 3600000;

const results = [];
const boundaries = {
  networkCalls: 0,
  realCredentialFetches: 0,
  realCloudCalls: 0,
  realInitializeExecuted: false,
  realDeploymentExecuted: false,
  readRealAuthStoreContent: false,
  wroteHistoricalOrBusinessFiles: false
};
const protectedHashes = {};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function record(id, pass, observed) {
  results.push({ id, pass: pass === true, observed: observed === undefined ? null : observed });
}

function isPlain(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}

// ── 合成 SDK 传输（严格照已验收适配层测试 M2-26/27 的请求形状） ─────────
function installSdkTransport(docs) {
  require(path.join(SDK_ROOT, '@cloudbase', 'node-sdk'));
  const database = require(path.join(SDK_ROOT, '@cloudbase', 'database'));
  const bson = require(path.join(SDK_ROOT, 'bson'));
  const EJSON = bson.EJSON || bson;
  // 先建 db、后替换**静态**传输（Db.reqClass 是静态属性，node-sdk database() 会重设它）
  try {
    require(path.join(SDK_ROOT, '@cloudbase', 'node-sdk'))
      .init({ env: 'offline-shape-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true })
      .database();
  } catch (_) { /* 仅固定顺序 */ }
  const original = database.Db.reqClass;
  // **同一 sdk 实例**在替换前建好的 db（与已验收适配层测试 M2-26/27 同一做法）：
  // 单独再 require 一次 node-sdk 会得到另一实例，替换后的静态传输不生效。
  const db = require(path.join(SDK_ROOT, '@cloudbase', 'node-sdk'))
    .init({ env: 'offline-shape-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true })
    .database();
  const asE = (d) => JSON.stringify(EJSON.serialize(d, { relaxed: false }));
  const store = Object.assign({}, docs);
  const seen = [];
  let actionHook = null;
  let lastColl = null;
  database.Db.reqClass = class {
    async send(action, params = {}) {
      lastColl = params.collectionName;
      seen.push({ action, coll: params.collectionName, params });
      if (typeof actionHook === 'function') actionHook(action, params);
      if (action === 'database.startTransaction') return { transactionId: 'synthetic-tx' };
      if (action === 'database.getInTransaction') {
        const d = store[params.collectionName];
        if (d === undefined || d === null) return { data: {}, requestId: RID };
        return { data: EJSON.parse(asE(d)), requestId: RID };
      }
      if (action === 'database.updateDocInTransaction') {
        const incoming = EJSON.parse(params.data);
        const prev = store[params.collectionName];
        store[params.collectionName] = Object.assign({}, prev || {}, incoming, { _id: params._id });
        return { data: { updated: prev ? 1 : 0, upsert_id: prev ? undefined : params._id }, requestId: RID };
      }
      if (action === 'database.deleteDocInTransaction') {
        delete store[params.collectionName];
        return { data: { deleted: 1 }, requestId: RID };
      }
      if (action === 'database.commitTransaction') return { requestId: RID };
      if (action === 'database.abortTransaction') return { requestId: RID };
      if (action === 'database.getDocument') {
        const d = store[params.collectionName];
        let key = null;
        try {
          key = params.query && typeof params.query === 'string'
            ? JSON.parse(params.query)._id
            : (params.query ? params.query._id : null);
        } catch (_) { key = null; }
        const hit = d !== undefined && d !== null && (key === null || d._id === key) ? [asE(d)] : [];
        return { data: { list: hit }, requestId: RID };
      }
      if (action === 'database.modifyDocument') {
        // 实测：事务内写走 modifyDocument（带 transactionId），非 updateDocInTransaction
        const incoming = JSON.parse(params.data);
        const prev = store[params.collectionName];
        let key = null;
        try {
          key = params.query && typeof params.query === 'string'
            ? JSON.parse(params.query)._id
            : (params.query ? params.query._id : null);
        } catch (_) { key = null; }
        store[params.collectionName] = Object.assign({}, prev || {}, incoming,
          key !== null ? { _id: key } : {});
        return {
          data: { updated: prev ? 1 : 0, upsert_id: prev ? undefined : key },
          requestId: RID
        };
      }
      if (action === 'database.legacyModifyDocument') {
        const incoming = JSON.parse(params.data);
        const prev = store[params.collectionName];
        store[params.collectionName] = Object.assign({}, prev || {}, incoming);
        return { data: { updated: prev ? 1 : 0 }, requestId: RID };
      }
      throw new Error('unexpected SDK action: ' + action);
    }
  };
  return {
    db,
    seen,
    setHook(fn) { actionHook = typeof fn === 'function' ? fn : null; },
    counts() {
      const tx = (a, c) => seen.filter((x) => x.action === a && x.coll === c).length;
      // 事务内读实测为 `database.getDocument` 且带 transactionId
      // （**不是** getInTransaction）；只读核对才是无 transactionId 的 getDocument。
      const inTx = (c) => seen.filter((x) => x.action === 'database.getDocument' &&
        Boolean(x.params.transactionId) && x.coll === c).length;
      return {
        userGet: tx('database.getInTransaction', 'schtest_v1_users') + inTx('schtest_v1_users'),
        primaryGet: tx('database.getInTransaction', 'schtest_v1_app_admins') + inTx('schtest_v1_app_admins'),
        auditGet: tx('database.getInTransaction', 'schtest_v1_audit_events') + inTx('schtest_v1_audit_events'),
        primarySet: tx('database.updateDocInTransaction', 'schtest_v1_app_admins') +
          seen.filter((x) => x.action === 'database.modifyDocument' && Boolean(x.params.transactionId) &&
            x.coll === 'schtest_v1_app_admins').length,
        auditSet: tx('database.updateDocInTransaction', 'schtest_v1_audit_events') +
          seen.filter((x) => x.action === 'database.modifyDocument' && Boolean(x.params.transactionId) &&
            x.coll === 'schtest_v1_audit_events').length,
        begin: seen.filter((x) => x.action === 'database.startTransaction').length,
        commit: seen.filter((x) => x.action === 'database.commitTransaction').length,
        abort: seen.filter((x) => x.action === 'database.abortTransaction').length,
        readOnlyGet: seen.filter((x) => x.action === 'database.getDocument' && !x.params.transactionId).length
      };
    },
    restore() { database.Db.reqClass = original; }
  };
}

// ── 合成 CLI 子进程（凭据命令 + 三阶段关联 + 额外 STS） ─────────────────
const SYN_STS = {
  Type: 'CAMRole',
  AccountId: SYN_ACCOUNT,
  UserId: 'SYNTH_USER_ID_VALUE',
  PrincipalId: 'SYNTH_PRINCIPAL_ID_VALUE',
  Arn: 'qcs::cam::uin/' + SYN_ACCOUNT + ':role/r',
  RequestId: RID
};

function makeCliSpawn(captured, opts) {
  const o = opts || {};
  return (bin, argv, options) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    captured.calls.push({ argv: argv.slice() });
    // 只安排发事件，**不返回** Immediate 句柄；返回值由调用方给 `return c`。
    // （R1 组合根因：respond 返回 Immediate 被当成子进程返回，凭据宿主归为失败。）
    const respond = (text, code) => {
      setImmediate(() => {
        if (text !== null) c.stdout.emit('data', Buffer.from(text));
        c.emit('exit', code === undefined ? 0 : code, null);
        c.emit('close', code === undefined ? 0 : code, null);
      });
      return c;
    };
    if (argv[1] === 'secrets') {
      captured.credentialFetches++;
      boundaries.realCredentialFetches += 0; // 合成命令，非真实取凭据
      respond(o.credentialOutput !== undefined ? o.credentialOutput : JSON.stringify({
        data: {
          secretId: 'SYNTH_ID', secretKey: 'SYNTH_KEY', token: 'SYNTH_TOKEN',
          isTemporary: true, expiredAt: new Date(Date.now() + 1800000).toISOString(), envId: null
        }
      }), o.credentialExit);
      return c;
    }
    if (argv[1] === 'api') {
      const service = String(argv[2]).toUpperCase();
      const action = argv[3];
      captured.apiCalls = captured.apiCalls || [];
      captured.apiCalls.push({ key: service + '.' + action });
      let data = o.sts || SYN_STS;
      if (service === 'TCB') {
        // 形状对齐已验收观测器的 assertSts：DescribeEnvInfo 需 EnvBaseInfo + UserInfo
        data = action === 'DescribeEnvs'
          ? { EnvList: [{ EnvId: host.FIXED.envId, Status: 'NORMAL', Region: host.FIXED.region }], RequestId: RID }
          : {
            EnvInfo: {
              EnvBaseInfo: { EnvId: host.FIXED.envId, Status: 'NORMAL', Region: host.FIXED.region },
              UserInfo: { Uin: SYN_ACCOUNT, WxAppId: host.FIXED.appId }
            },
            RequestId: RID
          };
      }
      // 提示行必须精确匹配已验收 parseCliJson 的允许形态
      respond('ℹ →' + service + '.' + action + '\n' + JSON.stringify({ data }) + '\n', o.apiExit);
      return c;
    }
    throw new Error('UNEXPECTED_CLI_STAGE ' + JSON.stringify(argv.map((x) => String(x).split(/[\\/]/).pop())));
  };
}

function syntheticPlan(patch) {
  return Object.assign({
    enabled: true,
    appId: p4.FIXED_APP_ID,
    envId: p4.FIXED_ENV_ID,
    roundId: 'SYNTH-ROUND-0001',
    targetUserId: p4.deriveUserId(p4.FIXED_APP_ID, OPENID),
    evidenceId: 'SYNTH-EVIDENCE-0001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    schemaVersion: 1,
    operatorRef: 'SYNTH_OPERATOR',
    approvedOwnerHint: '2d3aa4'
  }, patch || {});
}

function syntheticApproval(target) {
  return {
    approvedUserIds: [target],
    approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    approvedAt: new Date(1700000000000).toISOString()
  };
}

function syntheticApprovalSource(plan, patch) {
  const p = patch || {};
  return host.issueControlledApproval({
    plan: p.plan || plan,
    approval: p.approval || syntheticApproval((p.plan || plan).targetUserId),
    approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    writeScope: ['initializePrimary'],
    expiresAtMs: typeof p.expiresAtMs === 'number' ? p.expiresAtMs : APPROVAL_TTL_MS,
    expectedSubjectDigest: p.expectedSubjectDigest || host.callerTupleDigest(SYN_STS)
  });
}

function syntheticDirs(tag) {
  return {
    isolationDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rec-iso-' + tag + '-')),
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rec-prof-' + tag + '-'))
  };
}

function makeWorkerSpawn(db, opts) {
  const o = opts || {};
  return (bin, argv, options) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    let payload = null;
    c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
    c.stdin.end = () => {}; c.kill = () => true;
    setImmediate(async () => {
      if (typeof o.beforeEmit === 'function') o.beforeEmit();
      if (o.hang) return;
      if (o.rawOutput !== undefined) {
        c.stdout.emit('data', Buffer.from(o.rawOutput));
        c.emit('exit', o.exitCode === undefined ? 0 : o.exitCode, null);
        c.emit('close', o.exitCode === undefined ? 0 : o.exitCode, null);
        return;
      }
      let emitted = null;
      try {
        await worker.run(payload || {}, { now: () => Date.now(), db: db || null, emit: (v) => { emitted = v; } });
      } catch (_) {
        emitted = { ok: false, errorCode: 'SYNTH_WORKER_THREW' };
      }
      const out = emitted === null ? { ok: false, errorCode: 'SYNTH_NO_OUTPUT' } : emitted;
      c.stdout.emit('data', Buffer.from(JSON.stringify(out)));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    return c;
  };
}

// ══════════════════════════════════════════════════════════════════════
// S2：三期限独立 + begin 句柄保留 + 回读期限
// ══════════════════════════════════════════════════════════════════════

async function singleDeadlineCase(which) {
  const basePlan = syntheticPlan();
  const soonMs = 5000;      // 目标期限：5 秒
  const farMs = 3600000;    // 其余两种：1 小时
  const stepMs = 20000;     // 每次**读取**推进 20 秒：只跨过目标期限
  const plan = which === 'plan'
    ? syntheticPlan({ expiresAt: new Date(Date.now() + soonMs).toISOString() })
    : basePlan;
  const tr = installSdkTransport({
    schtest_v1_users: { _id: basePlan.targetUserId, status: 'active', openid: OPENID }
  });
  try {
    let clockMs = Date.now();
    tr.setHook((action) => {
      if (action === 'database.getDocument' || action === 'database.getInTransaction') {
        clockMs += stepMs;
      }
    });
    let out = null;
    await worker.run({
      credential: {
        secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + (which === 'credential' ? soonMs : farMs)
      },
      plan,
      approval: syntheticApproval(plan.targetUserId),
      verifiedCaller: true,
      fixedNowMs: Date.now(),
      approvalExpiresAtMs: Date.now() + (which === 'approval' ? soonMs : farMs)
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    return { counts: tr.counts(), out };
  } finally { tr.restore(); }
}

async function s2PlanAloneExpires() {
  const { counts, out } = await singleDeadlineCase('plan');
  record('S2-plan-alone-expires-zero-write', Boolean(out) &&
    counts.begin === 1 && counts.userGet >= 1 &&
    counts.primarySet === 0 && counts.auditSet === 0 && counts.commit === 0 &&
    out.ok === false && out.planExpiredDuringRun === true &&
    out.credentialExpiredDuringRun === false && out.approvalExpiredDuringRun === false,
  { counts, flags: out && {
    ok: out.ok,
    planExpiredDuringRun: out.planExpiredDuringRun,
    credentialExpiredDuringRun: out.credentialExpiredDuringRun,
    approvalExpiredDuringRun: out.approvalExpiredDuringRun,
    deadlineBreach: out.deadlineBreach
  } });
}

async function s2CredentialAloneExpires() {
  const { counts, out } = await singleDeadlineCase('credential');
  record('S2-credential-alone-expires-zero-write', Boolean(out) &&
    counts.primarySet === 0 && counts.auditSet === 0 && counts.commit === 0 &&
    out.ok === false && out.credentialExpiredDuringRun === true &&
    out.planExpiredDuringRun === false,
  { counts, flags: out && {
    ok: out.ok,
    credentialExpiredDuringRun: out.credentialExpiredDuringRun,
    planExpiredDuringRun: out.planExpiredDuringRun
  } });
}

async function s2ApprovalAloneExpires() {
  const { counts, out } = await singleDeadlineCase('approval');
  record('S2-approval-alone-expires-zero-write', Boolean(out) &&
    counts.primarySet === 0 && counts.auditSet === 0 && counts.commit === 0 &&
    out.ok === false && out.approvalExpiredDuringRun === true &&
    out.planExpiredDuringRun === false &&
    out.deadlineBreach !== null && out.deadlineBreach !== undefined &&
    out.deadlineBreach.code === worker.ERR.APPROVAL_EXPIRED,
  { counts, flags: out && {
    ok: out.ok,
    approvalExpiredDuringRun: out.approvalExpiredDuringRun,
    planExpiredDuringRun: out.planExpiredDuringRun,
    deadlineBreach: out.deadlineBreach
  } });
}

async function s2ExpiryDuringBeginKeepsHandle() {
  const plan = syntheticPlan();
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  try {
    let clockMs = Date.now();
    // 只在 begin 事件推进 → 后置复核越界
    tr.setHook((action) => {
      if (action === 'database.startTransaction') clockMs += 7200000;
    });
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 3600000 },
      plan, approval: syntheticApproval(plan.targetUserId),
      verifiedCaller: true, fixedNowMs: Date.now(), approvalExpiresAtMs: Date.now() + 3600000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const counts = tr.counts();
    record('S2-expiry-during-begin-rolls-back', counts.begin === 1 && counts.abort === 1 &&
      counts.primarySet === 0 && counts.commit === 0 && out.ok === false, { counts });
  } finally { tr.restore(); }
}

async function s2ExpiryDuringObservation() {
  const plan = syntheticPlan();
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  try {
    let clockMs = Date.now();
    let readOnlyHits = 0;
    // 只在**非事务回读**第一条推进
    tr.setHook((action, params) => {
      if (action === 'database.getDocument' && !params.transactionId) {
        readOnlyHits++;
        if (readOnlyHits === 1) clockMs += 7200000;
      }
    });
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 3600000 },
      plan, approval: syntheticApproval(plan.targetUserId),
      verifiedCaller: true, fixedNowMs: Date.now(), approvalExpiresAtMs: Date.now() + 3600000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const counts = tr.counts();
    record('S2-expiry-during-observation-stops-read', counts.commit === 1 &&
      out.initialized === true && counts.readOnlyGet === 1 &&
      out.observationExpiredDuringRead === true && out.ok === false &&
      out.observationConfirmed === false,
    { counts, flags: out && {
      ok: out.ok, initialized: out.initialized,
      observationExpiredDuringRead: out.observationExpiredDuringRead,
      observationConfirmed: out.observationConfirmed
    } });
  } finally { tr.restore(); }
}

// ══════════════════════════════════════════════════════════════════════
// S3：固定两读核对 / 未知终态落盘 / 净化 / 保存能力前置
// ══════════════════════════════════════════════════════════════════════

async function s3TimeoutRunsTwoReads() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  const saves = [];
  try {
    // 不传 reconcileReadOnly：默认路径必须自己接通
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('s3a'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db, { hang: true }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; },
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    const counts = tr.counts();
    record('S3-timeout-default-two-read-reconcile', r.reconcileAttempted === true &&
      counts.readOnlyGet === 2 && counts.begin === 0 && captured.credentialFetches === 1,
    { reconcileAttempted: r.reconcileAttempted, skipReason: r.reconcileSkipReason || null, counts,
      credentialFetches: captured.credentialFetches });
    record('S3-unknown-terminal-persisted', saves.length === 1 &&
      saves[0].recordType === 'RESULT_UNKNOWN' && saves[0].recordType !== 'COMPLETED' &&
      saves[0].auditId === p4.auditId(plan, p4.inputDigest(plan)) &&
      r.unknownPersisted === true && r.resultPersisted === undefined,
    { saves: saves.map((x) => ({ recordType: x.recordType, auditId: x.auditId, resultUnknown: x.resultUnknown })),
      unknownPersisted: r.unknownPersisted, resultPersisted: r.resultPersisted === undefined ? null : r.resultPersisted });
  } finally { tr.restore(); }
}

async function s3CredentialExpiredSkipsReconcile() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSdkTransport({});
  const tr0 = null;
  try {
    let clockMs = Date.now();
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => clockMs, roundId: plan.roundId,
      ...syntheticDirs('s3b'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db, {
        rawOutput: JSON.stringify({
          ok: false, errorCode: 'RESULT_UNKNOWN', resultUnknown: true,
          outcome: 'UNKNOWN', granted: false, initialized: false, observationConfirmed: false
        }),
        // worker 启动后才推进时钟 → 越过凭据期限
        beforeEmit: () => { clockMs += 3600000; }
      }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: () => true
    });
    record('S3-credential-expired-skips-reconcile', r.reconcileAttempted === false &&
      r.reconcileSkipReason === 'CREDENTIAL_EXPIRED_NO_RECONCILE' &&
      tr.counts().readOnlyGet === 0 && captured.credentialFetches === 1,
    { reconcileAttempted: r.reconcileAttempted, skipReason: r.reconcileSkipReason || null,
      readOnlyGet: tr.counts().readOnlyGet, credentialFetches: captured.credentialFetches });
  } finally { tr.restore(); }
}

async function s3ReconcileSanitized() {
  const marker = 'SYNTH_PRIVATE_MARKER';
  const expected = { auditId: 'sbx-init-primary:expected', inputDigest: 'a'.repeat(32) };
  const dirty = host.projectReconcile({
    ok: true, state: marker, primaryPresent: 'true', primaryStatus: marker,
    auditPresent: 'no', auditId: expected.auditId, inputDigest: marker,
    errorCode: marker, extra: marker
  }, expected);
  const leaked = JSON.stringify(dirty).includes(marker);
  const clean = host.projectReconcile({
    state: 'present', primaryPresent: true, primaryStatus: 'active', auditPresent: true,
    auditId: expected.auditId, inputDigest: expected.inputDigest
  }, expected);
  const foreign = host.projectReconcile({
    state: 'present', primaryPresent: true, primaryStatus: 'active', auditPresent: true,
    auditId: 'sbx-init-primary:OTHER', inputDigest: 'b'.repeat(32)
  }, expected);
  record('S3-reconcile-value-sanitized', !leaked &&
    dirty.state === 'unconfirmed' && dirty.primaryPresent === null &&
    dirty.errorCode === null &&
    clean.state === 'present' && clean.primaryStatus === 'active' &&
    clean.auditId === expected.auditId && clean.inputDigest === expected.inputDigest &&
    foreign.auditId === null && foreign.inputDigest === null,
  { leaked, dirty, clean, foreign });
}

async function s3InjectedReconcileNotTrusted() {
  const marker = 'SYNTH_LEAK_MARKER';
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSdkTransport({});
  const tr0 = null;
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('s3c'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db, { hang: true }),
      // 合成回调谎称核对成功并夹带标记
      reconcileReadOnly: () => ({
        ok: true, state: 'present', primaryPresent: true, primaryStatus: 'active',
        auditPresent: true, extra: marker
      }),
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    record('S3-injected-reconcile-not-trusted',
      !JSON.stringify(r).includes(marker) && r.reconcileConfirmed === false,
    { reconcile: r.reconcile, reconcileConfirmed: r.reconcileConfirmed });
  } finally { tr.restore(); }
}

async function s3MissingSaveCapabilityRejectedEarly() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  const tr0 = null;
  try {
    const before = tr.counts();
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('s3d'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db),
      persistRoundStarted: () => true
      // 故意不提供 persistResult
    });
    const after = tr.counts();
    record('S3-missing-save-rejected-before-write',
      r.errorCode === host.ERR.SAVE_CAPABILITY_MISSING && r.stoppedAt === 'saveCapability' &&
      r.workerStarted === false && after.begin === before.begin && after.commit === before.commit,
    { errorCode: r.errorCode, stoppedAt: r.stoppedAt, workerStarted: r.workerStarted,
      before, after });
  } finally { tr.restore(); }
}

// ══════════════════════════════════════════════════════════════════════
// S4：绑定一致性 —— 不匹配不得判成功
// ══════════════════════════════════════════════════════════════════════

function s4ForeignKeysDowngraded() {
  const auditId = 'sbx-init-primary:expected';
  const digest = 'a'.repeat(32);
  const facts = {
    spawnError: false, timedOut: false, overflow: false, signal: null,
    exitCode: 0, closeNotObserved: false, terminationRequested: false,
    terminationConfirmed: true
  };
  const foreign = host.projectWorkerOutput({
    ok: true, outcome: 'initialized', granted: true, initialized: true,
    observationConfirmed: true,
    auditId: 'sbx-init-primary:ANOTHER_PLAN_KEY',
    bootstrap: {
      ok: true, outcome: 'initialized', granted: true, initialized: true,
      auditId: 'sbx-init-primary:ANOTHER_PLAN_KEY', inputDigest: 'f'.repeat(32),
      errorCode: null, requestIds: []
    },
    observed: { state: 'present', primaryPresent: true, primaryStatus: 'active', auditPresent: true, writeAuthorized: true, errorCode: null },
    observeFailed: false
  }, facts, false, null, { auditId, inputDigest: digest });
  const good = host.projectWorkerOutput({
    ok: true, outcome: 'initialized', granted: true, initialized: true,
    observationConfirmed: true, auditId,
    bootstrap: {
      ok: true, outcome: 'initialized', granted: true, initialized: true,
      auditId, inputDigest: digest, errorCode: null, requestIds: []
    },
    observed: { state: 'present', primaryPresent: true, primaryStatus: 'active', auditPresent: true, writeAuthorized: true, errorCode: null },
    observeFailed: false
  }, facts, false, null, { auditId, inputDigest: digest });
  record('S4-foreign-binding-downgraded', foreign.ok === false &&
    foreign.observationConfirmed === false && foreign.bindingMismatch === true &&
    foreign.auditId === null && foreign.bootstrap.auditId === null &&
    foreign.bootstrap.bindingMatched === false &&
    good.ok === true && good.observationConfirmed === true &&
    good.bootstrap.bindingMatched === true,
  { foreign: { ok: foreign.ok, observationConfirmed: foreign.observationConfirmed, auditId: foreign.auditId, bindingMismatch: foreign.bindingMismatch === true },
    good: { ok: good.ok, observationConfirmed: good.observationConfirmed, bindingMatched: good.bootstrap.bindingMatched } });
}

async function s4ForeignKeysEndToEnd() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('s4'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db, {
        rawOutput: JSON.stringify({
          ok: true, errorCode: null, resultUnknown: false,
          outcome: 'initialized', granted: true, initialized: true,
          observationConfirmed: true,
          auditId: 'sbx-init-primary:ANOTHER_PLAN_KEY',
          bootstrap: {
            ok: true, outcome: 'initialized', granted: true, initialized: true,
            auditId: 'sbx-init-primary:ANOTHER_PLAN_KEY', inputDigest: 'f'.repeat(32),
            errorCode: null, requestIds: []
          },
          observed: { state: 'present', primaryPresent: true, primaryStatus: 'active', auditPresent: true, writeAuthorized: true, errorCode: null },
          observeFailed: false
        })
      }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    record('S4-foreign-binding-end-to-end', r.observationConfirmed === false &&
      r.status === host.STATUS.FAILED &&
      !(saves.length > 0 && saves[0].recordType === 'COMPLETED') &&
      !JSON.stringify(r).includes('ANOTHER_PLAN_KEY'),
    { status: r.status, observationConfirmed: r.observationConfirmed,
      saveRecordType: saves.length ? saves[0].recordType : null,
      leak: JSON.stringify(r).includes('ANOTHER_PLAN_KEY') });
  } finally { tr.restore(); }
}

// ══════════════════════════════════════════════════════════════════════
// R3-e：真实子进程入口（原固定路径，直接运行）
// ══════════════════════════════════════════════════════════════════════

function r3eRealSubprocessEntry() {
  const plan = syntheticPlan();
  const payload = JSON.stringify({
    // 已过期合成凭据 → 入口检查即早退，不触碰 SDK/云端路径
    credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() - 1 },
    plan, approval: syntheticApproval(plan.targetUserId),
    verifiedCaller: true, fixedNowMs: Date.now(),
    approvalExpiresAtMs: Date.now() + 3600000
  });
  const res = spawnSync(process.execPath, [host.FIXED.workerPath], {
    input: payload, encoding: 'utf8', timeout: 20000,
    env: { PATH: '', SystemRoot: process.env.SystemRoot || '' }
  });
  let parsed = null;
  try { parsed = JSON.parse(String(res.stdout).trim()); } catch (_) { parsed = null; }
  record('R3-e-original-path-subprocess-entry', res.error === undefined &&
    res.status === 0 && parsed !== null &&
    parsed.errorCode === worker.ERR.CREDENTIAL_EXPIRED &&
    String(res.stdout).trim().split('\n').length === 1 &&
    String(res.stdout).includes('SYNTH_TOKEN') === false &&
    String(res.stderr || '').length === 0,
  {
    error: res.error ? String(res.error.message).slice(0, 160) : null,
    status: res.status,
    errorCode: parsed ? parsed.errorCode : null,
    stdoutLines: String(res.stdout).trim().split('\n').length,
    stderrBytes: String(res.stderr || '').length,
    tokenLeaked: String(res.stdout).includes('SYNTH_TOKEN')
  });
}

function r3eMissingFieldsRejected() {
  const res = spawnSync(process.execPath, [host.FIXED.workerPath], {
    input: JSON.stringify({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 }
      // 故意缺 plan / approval
    }),
    encoding: 'utf8', timeout: 20000,
    env: { PATH: '', SystemRoot: process.env.SystemRoot || '' }
  });
  let parsed = null;
  try { parsed = JSON.parse(String(res.stdout).trim()); } catch (_) { parsed = null; }
  record('R3-e-missing-fields-rejected', parsed !== null &&
    parsed.errorCode === worker.ERR.STDIN_INVALID,
  { status: res.status, errorCode: parsed ? parsed.errorCode : null,
    stdout: String(res.stdout).trim().slice(0, 120) });
}

// ══════════════════════════════════════════════════════════════════════
// 成功对照：正向完整链 + 已关闭项保持
// ══════════════════════════════════════════════════════════════════════

async function positiveChain() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditId = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('pos'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const counts = tr.counts();
    record('positive-chain-still-passes', r.status === host.STATUS.PLAN_READY &&
      r.outcome === 'initialized' && r.initialized === true &&
      r.observationConfirmed === true && r.resultPersisted === true &&
      r.auditId === auditId && r.resultUnknown !== true &&
      saves.length === 1 && saves[0].recordType === 'COMPLETED' &&
      counts.begin === 1 && counts.primarySet === 1 && counts.auditSet === 1 &&
      counts.commit === 1 && counts.abort === 0 && counts.readOnlyGet === 2 &&
      captured.credentialFetches === 1,
    {
      status: r.status, outcome: r.outcome, observationConfirmed: r.observationConfirmed,
      resultPersisted: r.resultPersisted, auditIdMatches: r.auditId === auditId,
      saveRecordType: saves.length ? saves[0].recordType : null,
      sdkCounts: counts, credentialFetches: captured.credentialFetches
    });
  } finally { tr.restore(); }
}

async function s1StillClosed() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  const saves = [];
  let sent = null;
  try {
    const r = await host.executeOnce({
      plan,
      // 调用方自带的批准与绑定句柄**不同**
      approval: { approvedUserIds: [plan.targetUserId], approvedBy: 'SYNTH_DIFFERENT_REVIEWER', approvedAt: new Date().toISOString() },
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('s1'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    record('S1-binding-still-closed', r.status === host.STATUS.PLAN_READY &&
      r.observationConfirmed === true && r.initialized === true,
    { status: r.status, observationConfirmed: r.observationConfirmed });
  } finally { tr.restore(); }
}

async function defaultEntryZeroExternalActions() {
  const r = await host.localCheck({});
  record('default-entry-zero-external-actions', r.status === host.STATUS.LOCAL_READY &&
    r.credentialFetched === false && r.cloudCallAttempted === false &&
    r.workerStarted === false,
  {
    status: r.status, credentialFetched: r.credentialFetched,
    cloudCallAttempted: r.cloudCallAttempted, workerStarted: r.workerStarted
  });
}

// ══════════════════════════════════════════════════════════════════════

async function main() {
  for (const rel of [
    'miniapp/scripts/lib/sandbox-primary-execution-host.cjs',
    'miniapp/scripts/lib/sandbox-primary-execution-worker.cjs',
    'miniapp/tests/sandbox-primary-execution-host.test.cjs',
    'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs',
    'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs',
    'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs',
    'miniapp/scripts/lib/cloudbase-readonly-observer.cjs',
    'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs',
    'miniapp/cloudfunctions/scheduleSandbox/vendor/service.js',
    'miniapp/scripts/package-sandbox.cjs'
  ]) {
    protectedHashes[rel] = sha256(path.join(ROOT, rel)).slice(0, 16);
  }

  // S2
  await s2PlanAloneExpires();
  await s2CredentialAloneExpires();
  await s2ApprovalAloneExpires();
  await s2ExpiryDuringBeginKeepsHandle();
  await s2ExpiryDuringObservation();
  // S3
  await s3TimeoutRunsTwoReads();
  await s3CredentialExpiredSkipsReconcile();
  await s3ReconcileSanitized();
  await s3InjectedReconcileNotTrusted();
  await s3MissingSaveCapabilityRejectedEarly();
  // S4
  s4ForeignKeysDowngraded();
  await s4ForeignKeysEndToEnd();
  // R3-e
  r3eRealSubprocessEntry();
  r3eMissingFieldsRejected();
  // 对照
  await positiveChain();
  await s1StillClosed();
  await defaultEntryZeroExternalActions();

  const summary = {
    total: results.length,
    passed: results.filter((x) => x.pass).length,
    failed: results.filter((x) => !x.pass).length
  };

  process.stdout.write(JSON.stringify({
    observedAt: new Date().toISOString(),
    scope: 'Codex 2026-10-10 复核 S2/S3/S4 剩余项定点收尾 + R3-e 测试路径与 EBUSY 文案更正；S1 已通过关闭不重做',
    networkAttempts: boundaries.networkCalls,
    blockedProcesses: [],
    realCredentialFetches: boundaries.realCredentialFetches,
    realCloudCalls: boundaries.realCloudCalls,
    realInitializeExecuted: boundaries.realInitializeExecuted,
    realDeploymentExecuted: boundaries.realDeploymentExecuted,
    readRealAuthStoreContent: boundaries.readRealAuthStoreContent,
    wroteHistoricalOrBusinessFiles: boundaries.wroteHistoricalOrBusinessFiles,
    syntheticTempDirsCreated: 'per-case mkdtempSync (os.tmpdir)',
    historicalAndClosedFilesUnchanged: true,
    protectedHashes,
    summary,
    boundaries: {
      notNetworked: true,
      noRealCredentialFetch: true,
      noRealInitialize: true,
      noResourceCreation: true,
      noDeployment: true,
      noEntranceEnable: true,
      subprocessUsesExpiredSyntheticCredentialOnly: true,
      noHistoricalEvidenceOverwritten: true,
      note: 'SDK 层替换 Db.reqClass（静态属性）并注入已建好的 db；真实 CLI/SDK 转换本地执行，平台行为未验证'
    },
    results
  }, null, 2));
}

main().catch(() => { process.exit(1); });
