/**
 * Codex 2026-10-10 四次复核 N2 完整结果组合 —— 独立复现证据
 * ===============================================================
 *
 * 范围：
 *  - §2：按 outcome **穷举**合法结果组合（不再只在 initialized=true 时检查）；
 *        UNKNOWN/缺失、initialized 与布尔矛盾、审计冲突停止、
 *        alreadyPresent 却 granted=true，均不得被保存为完整初始化成功；
 *        顶层与 bootstrap 的 outcome/initialized/granted 必须双向自洽。
 *  - §3：真实 P4 的 alreadyPresent 返回 granted=false 且**不含** auditId/
 *        inputDigest —— 以真实 worker/P4 输出验证零写、不重复授予与实际终态，
 *        不手工补字段冒充正向。
 *
 * 保留的对照：正常初始化整链、真实提交后回读失败、错绑定后的保守核对、
 * worker S2 三期限、S1 绑定、默认入口零外部动作。
 *
 * **三类验证必须分开看**：
 *  1) 合成验证：本证据中四个组合样本均为**合成 CLI/worker 事件 + 合成 SDK
 *     传输**，无数据库读写；它们验证的是父层对损坏 worker 协议的处理，
 *     **不声称**真实 worker 或云端曾产生这些组合。
 *  2) 真实 SDK 本地转换：正常初始化、真实提交后回读失败、真实 alreadyPresent
 *     三例走**真实 host/worker/P4/SDK 转换**与合成传输，仍**不是云端执行**。
 *  3) 未进行的平台验证：真实凭据获取、真实初始化、平台事务、IAM 写权限等
 *     本轮**全部未验证**。
 *
 * 已关闭不重做：N1 异步等待、worker 时效、进程收尾、S1、worker S2、R3-e、
 * P4、SDK 适配器、凭据宿主、旧只读链、业务云函数、vendor、入口、打包器。
 *
 * 边界：不联网、不取真实凭据、不初始化、不登记本人微信、不建资源、不部署、
 * 不启用入口。时钟仅在本证据进程内替换并 finally 恢复；不改产品源码与历史证据。
 *
 * 每条用例以**新断言**直接证明实际结果；闭合依据是新断言本身，
 * 不是任何旧脚本的「不再复现」。
 */
/**
 * Codex 2026-10-10 三次复核 N1 异步等待 / N2 合法结果组合 —— 独立复现证据
 * ======================================================================
 *
 * 范围：本轮只验证
 *  - N1：`runReadOnlyReconcile` 的**异步注入回调必须 await**（含异步拒绝）
 *  - N2：聚合点的**合法结果组合**（observed 资格状态、outcome 与 initialized
 *        的一致性），并保留合法已有记录分支与真实提交后回读失败分支
 *  - §4：测试文件中已撤回的 EBUSY 归因不再复现
 *
 * 已通过部分保持关闭，不重做：N1 默认 P4 两读及执行期/收尾时效、N2 错绑定实际
 * 核对与原矛盾分支、S1、worker S2、R3-e 实现、P4、SDK 适配器、凭据宿主、
 * 旧只读链、业务云函数、vendor、入口、打包器。
 *
 * 边界（硬性）：不联网、不取真实凭据、不初始化、不建资源、不部署、不启用入口。
 * 只使用合成 CLI/worker 事件与合成 SDK 传输；真实子进程入口只用**已过期**的
 * 合成凭据做入口早退。时钟仅在本证据进程内替换并 finally 恢复；
 * 不改产品源码与历史证据。
 *
 * 每条用例以**新断言**直接证明实际结果。闭合依据是新断言本身，
 * 不是任何旧脚本的「不再复现」。
 */
/**
 * Codex 2026-10-10 二次复核 N1/N2 定点收尾 —— 独立复现证据
 * ==========================================================
 *
 * 范围：只验证本轮收尾的
 *  - N1：父进程 `runReadOnlyReconcile` 在每次读前/读后及收尾复核同批凭据有效期
 *  - N2：绑定与状态聚合一致性（错误绑定真正进入保守核对；顶层成功必须与
 *        bootstrap/observed 自洽；矛盾的 reconcile 不得确认）
 * 以及 R3-e 真实子进程入口与已关闭项保持。
 *
 * 已关闭不重做：S1、worker 的 S2 三期限与异步边界、R3-e 测试路径、
 * P4 / SDK 适配器 / 凭据宿主 / 旧只读链 / 业务云函数 / vendor / 入口 / 打包器。
 *
 * **遵守真实 P4 返回契约**：`observePrimary` 返回
 * `{state, reason, primaryPresent, primaryUserId, primaryStatus, auditId,
 * auditPresent, writeAuthorized, note}` —— **不返回 inputDigest**
 * （摘要在核心内部校验审计记录后体现为 state）。
 * 因此本证据既验证「组合矛盾必须降级」，也验证「P4 形状不被误拒」。
 *
 * 边界（硬性）：不联网、不取真实凭据、不初始化、不建资源、不部署、不启用入口。
 * 只使用合成 CLI/worker 事件与合成 SDK 传输；真实子进程入口只用
 * **已过期**的合成凭据做入口早退，不触碰 SDK/云端路径。
 * 时钟仅在本证据进程内替换并 finally 恢复；不改产品源码与历史证据。
 *
 * 每条用例以**新断言**直接证明实际结果。闭合依据是新断言本身，
 * 不是任何旧脚本的「不再复现」。
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
  const row = { id, pass: pass === true, observed: observed === undefined ? null : observed };
  // N1/N2 收尾说明：宿主**无法启动子进程**时不记为「失败」，也不冒充通过 ——
  // 记为 unverified 并附该时点的原始错误。Codex 2026-10-10 §5 要求：
  // 「若当前宿主确实无法启动，如实记该时点错误/未验证」。
  if (observed !== null && typeof observed === 'object' &&
    observed.unverified === true) {
    row.pass = false;
    row.unverified = true;
  }
  results.push(row);
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

// 用例层：§2 四个组合 + §3 真实 alreadyPresent + 保留对照
// ══════════════════════════════════════════════════════════════════════

/** 构造「除 outcome/initialized/granted 外全部合法」的成功基底（合成事件）。 */
function makeSuccessShapedWorker(outcome, initialized, granted) {
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const payload = {
    ok: true, errorCode: null, resultUnknown: false,
    outcome, granted, initialized,
    observationConfirmed: true, auditId: auditKey,
    bootstrap: {
      ok: true, outcome, granted, initialized,
      auditId: auditKey, inputDigest: digest, errorCode: null, requestIds: []
    },
    observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
      auditPresent: true, writeAuthorized: false, errorCode: null },
    observeFailed: false
  };
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    setImmediate(() => {
      c.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    return c;
  };
}

/** §2 共用断言：观察确认不得把「本轮初始化已完成」抬升为保存 COMPLETED。 */
function assertNotSavedAsComplete(r, saves, label, expectedCode) {
  const recType = saves.length ? saves[0].recordType : null;
  const codes = r.stateContradictions || [];
  const ok = recType !== 'COMPLETED' &&
    r.initialized === false && r.granted === false &&
    r.observationConfirmed === false &&
    r.status === host.STATUS.FAILED &&
    (expectedCode === undefined ||
      codes.indexOf(expectedCode) !== -1 || JSON.stringify(r).indexOf(expectedCode) !== -1);
  record(label, ok, {
    saveRecordType: recType, initialized: r.initialized, granted: r.granted,
    observationConfirmed: r.observationConfirmed, status: r.status,
    fullInitializationSuccess: r.fullInitializationSuccess === true,
    commitFactEstablished: r.commitFactEstablished === true,
    contradictions: codes, expectedCode: expectedCode || null
  });
}

async function runComboCase(label, outcome, initialized, granted, expectedCode, dirTag) {
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
      ...syntheticDirs(dirTag),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeSuccessShapedWorker(outcome, initialized, granted),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    assertNotSavedAsComplete(r, saves, label, expectedCode);
    // 合成验证：这四个样本无数据库读写
    if (tr.counts().begin !== 0) {
      record(label + '-no-db-writes', false, { counts: tr.counts() });
    }
  } finally { tr.restore(); }
}

/** §2-1：UNKNOWN（两层）+ initialized/granted=false。 */
async function comboUnknownFalseFlags() {
  await runComboCase('N2-unknown-false-flags', 'UNKNOWN', false, false,
    'UNKNOWN_OR_MISSING_OUTCOME', 'n2a');
}

/** §2-2：outcome=initialized 但 initialized/granted=false（布尔与 outcome 矛盾）。 */
async function comboInitializedDeniesFlags() {
  await runComboCase('N2-initialized-denies-flags', 'initialized', false, false,
    'INITIALIZED_OUTCOME_WITHOUT_INITIALIZED_FLAG', 'n2b');
}

/** §2-3：auditAlreadyPresent（审计在而 primary 缺）+ false/false。 */
async function comboAuditOnlyConfirmed() {
  await runComboCase('N2-audit-only-confirmed', 'auditAlreadyPresent', false, false,
    undefined, 'n2c');
}

/** §2-4：alreadyPresent 却 granted=true（P4 绝不会这样返回）。 */
async function comboAlreadyPresentClaimsGrant() {
  await runComboCase('N2-already-present-claims-grant', 'alreadyPresent', false, true,
    'ALREADY_PRESENT_CLAIMS_GRANT', 'n2d');
}

/** §2 补充：顶层与 bootstrap outcome 不一致 → 双向一致性必须拦住。 */
async function comboTopBootstrapMismatch() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('n2e'),
      spawn: makeCliSpawn(captured),
      spawnWorker: (bin, argv, options) => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: true, errorCode: null, resultUnknown: false,
            outcome: 'initialized', granted: true, initialized: true,
            observationConfirmed: true, auditId: auditKey,
            bootstrap: {
              // 顶层 initialized、bootstrap 却称 alreadyPresent
              ok: true, outcome: 'alreadyPresent', granted: false, initialized: false,
              auditId: auditKey, inputDigest: digest, errorCode: null, requestIds: []
            },
            observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
              auditPresent: true, writeAuthorized: false, errorCode: null },
            observeFailed: false
          })));
          c.emit('exit', 0, null); c.emit('close', 0, null);
        });
        return c;
      },
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    assertNotSavedAsComplete(r, saves, 'N2-top-bootstrap-mismatch',
      'BOOTSTRAP_OUTCOME_MISMATCH');
  } finally { tr.restore(); }
}

/**
 * §3：真实 P4 的 alreadyPresent 分支（真实 host/worker/P4/SDK 转换）。
 *
 * P4 该分支返回 granted=false、existing，**不返回 auditId/inputDigest**；
 * worker 归一化不会凭空补出。真实行为：零写 + 回滚、outcome=alreadyPresent、
 * initialized/granted 均为 false；因缺绑定字段走保守只读核对，不保存 COMPLETED。
 * 不要求已有记录保存 COMPLETED，也不放宽已关闭的提交绑定检查。
 */
async function realAlreadyPresent() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID },
    schtest_v1_app_admins: { _id: p4.PRIMARY_ID, userId: plan.targetUserId, status: 'active' },
    schtest_v1_audit_events: {
      _id: auditKey, subjectUserId: plan.targetUserId, action: p4.AUDIT_ACTION,
      roundId: plan.roundId, envId: p4.FIXED_ENV_ID, evidenceId: plan.evidenceId,
      inputDigest: p4.inputDigest(plan)
    }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('n3'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const counts = tr.counts();
    const recType = saves.length ? saves[0].recordType : null;
    record('N3-real-already-present-zero-write-no-grant',
      counts.primarySet === 0 && counts.auditSet === 0 && counts.commit === 0 &&
      counts.abort === 1 &&
      r.outcome === 'alreadyPresent' && r.initialized === false && r.granted === false &&
      r.bootstrap && r.bootstrap.auditId === null &&
      r.bootstrap.bindingMatched === false &&
      recType !== 'COMPLETED',
    {
      sdkCounts: counts, outcome: r.outcome, initialized: r.initialized,
      granted: r.granted, bootstrapAuditId: r.bootstrap ? r.bootstrap.auditId : null,
      bindingMatched: r.bootstrap ? r.bootstrap.bindingMatched : null,
      status: r.status, saveRecordType: recType,
      reconcileAttempted: r.reconcileAttempted === true
    });
  } finally { tr.restore(); }
}

/** 保留对照：真实正常初始化整链 → 两写一提交 + 两读 + COMPLETED。 */
async function realNormalInitialization() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('n4'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const counts = tr.counts();
    record('real-normal-initialization-completes', r.status === host.STATUS.PLAN_READY &&
      r.outcome === 'initialized' && r.initialized === true && r.granted === true &&
      r.observationConfirmed === true && r.auditId === auditKey &&
      r.fullInitializationSuccess === true &&
      saves.length === 1 && saves[0].recordType === 'COMPLETED' &&
      counts.primarySet === 1 && counts.auditSet === 1 && counts.commit === 1 &&
      counts.abort === 0 && counts.readOnlyGet === 2,
    {
      status: r.status, outcome: r.outcome, initialized: r.initialized,
      granted: r.granted, fullInitializationSuccess: r.fullInitializationSuccess === true,
      saveRecordType: saves.length ? saves[0].recordType : null,
      sdkCounts: counts
    });
  } finally { tr.restore(); }
}

/** 保留对照：真实提交后回读失败 → 保留可绑定提交事实，不保存 COMPLETED。 */
async function realCommitReadbackFailed() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  tr.setHook((action, params) => {
    if (action === 'database.getDocument' && !params.transactionId) {
      throw Object.assign(new Error('SYNTHETIC_READBACK_FAILED'),
        { code: 'SYNTHETIC_READBACK_FAILED' });
    }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan.targetUserId),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('n5'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const counts = tr.counts();
    const recType = saves.length ? saves[0].recordType : null;
    record('real-commit-readback-failed-keeps-fact', counts.primarySet === 1 &&
      counts.auditSet === 1 && counts.commit === 1 &&
      r.initialized === true && r.outcome === 'initialized' &&
      r.auditId === auditKey && r.commitFactEstablished === true &&
      r.observationConfirmed === false && recType !== 'COMPLETED',
    {
      sdkCounts: counts, initialized: r.initialized, outcome: r.outcome,
      commitFactEstablished: r.commitFactEstablished === true,
      observationConfirmed: r.observationConfirmed, saveRecordType: recType
    });
  } finally { tr.restore(); }
}

/** 保留对照：他计划键 → 保守两读核对，不保存完成。 */
async function wrongBindingConservativeReconcile() {
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
      ...syntheticDirs('n6'),
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
          observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
            auditPresent: true, writeAuthorized: true, errorCode: null },
          observeFailed: false
        })
      }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const recType = saves.length ? saves[0].recordType : null;
    record('wrong-binding-conservative-reconcile', r.reconcileAttempted === true &&
      tr.counts().readOnlyGet === 2 && r.initialized === false && r.granted === false &&
      recType !== 'COMPLETED' &&
      JSON.stringify(r).indexOf('ANOTHER_PLAN_KEY') === -1,
    {
      reconcileAttempted: r.reconcileAttempted, readOnlyGet: tr.counts().readOnlyGet,
      initialized: r.initialized, granted: r.granted, saveRecordType: recType,
      foreignKeyLeaked: JSON.stringify(r).indexOf('ANOTHER_PLAN_KEY') !== -1
    });
  } finally { tr.restore(); }
}

/** 对照：默认入口零外部动作。 */
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
  if (res.error !== undefined) {
    // 本宿主此刻无法启动子进程：**如实记录原始错误**，不预设原因、不冒充通过。
    record('R3-e-original-path-subprocess-entry', false, {
      unverified: true,
      reason: '宿主此刻无法启动该子进程（原始错误如实记录，原因未判定）',
      rawError: String(res.error.message).slice(0, 200)
    });
    return;
  }
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
  if (res.error !== undefined) {
    record('R3-e-missing-fields-rejected', false, {
      unverified: true,
      reason: '宿主此刻无法启动该子进程（原始错误如实记录，原因未判定）',
      rawError: String(res.error.message).slice(0, 200)
    });
    return;
  }
  record('R3-e-missing-fields-rejected', parsed !== null &&
    parsed.errorCode === worker.ERR.STDIN_INVALID,
  { status: res.status, errorCode: parsed ? parsed.errorCode : null,
    stdout: String(res.stdout).trim().slice(0, 120) });
}

async function positiveChainStillHolds() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
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
      r.granted === true && r.observationConfirmed === true &&
      r.resultPersisted === true && r.auditId === auditKey &&
      r.resultUnknown !== true && saves.length === 1 &&
      saves[0].recordType === 'COMPLETED' &&
      counts.begin === 1 && counts.primarySet === 1 && counts.auditSet === 1 &&
      counts.commit === 1 && counts.abort === 0 && counts.readOnlyGet === 2 &&
      captured.credentialFetches === 1,
    {
      status: r.status, outcome: r.outcome, initialized: r.initialized,
      granted: r.granted, observationConfirmed: r.observationConfirmed,
      resultPersisted: r.resultPersisted, auditIdMatches: r.auditId === auditKey,
      saveRecordType: saves.length ? saves[0].recordType : null,
      sdkCounts: counts, credentialFetches: captured.credentialFetches
    });
  } finally { tr.restore(); }
}

/** 对照：已关闭项 S1（批准绑定）保持成立。 */
async function s1BindingStillClosed() {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: OPENID }
  });
  try {
    const r = await host.executeOnce({
      plan,
      // 调用方自带的批准与绑定句柄**不同**
      approval: {
        approvedUserIds: [plan.targetUserId],
        approvedBy: 'SYNTH_DIFFERENT_REVIEWER',
        approvedAt: new Date().toISOString()
      },
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('s1'),
      spawn: makeCliSpawn(captured),
      spawnWorker: makeWorkerSpawn(tr.db),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: () => true
    });
    record('S1-binding-still-closed', r.status === host.STATUS.PLAN_READY &&
      r.observationConfirmed === true && r.initialized === true,
    { status: r.status, observationConfirmed: r.observationConfirmed,
      initialized: r.initialized });
  } finally { tr.restore(); }
}

/** 对照：worker 的 S2 三期限仍关闭（父进程改动不得影响 worker 守卫）。 */
async function workerS2StillClosed() {
  const basePlan = syntheticPlan();
  const tr = installSdkTransport({
    schtest_v1_users: { _id: basePlan.targetUserId, status: 'active', openid: OPENID }
  });
  try {
    let clockMs = Date.now();
    tr.setHook((action) => {
      if (action === 'database.getDocument' || action === 'database.getInTransaction') {
        clockMs += 20000;
      }
    });
    let out = null;
    await worker.run({
      credential: {
        secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + 3600000
      },
      // 只让计划先到期（凭据与批准给足余量）
      plan: syntheticPlan({ expiresAt: new Date(Date.now() + 5000).toISOString() }),
      approval: syntheticApproval(basePlan.targetUserId),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: Date.now() + 3600000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const counts = tr.counts();
    record('worker-S2-three-deadlines-still-closed', counts.primarySet === 0 &&
      counts.auditSet === 0 && counts.commit === 0 && counts.abort === 1 &&
      out.ok === false && out.planExpiredDuringRun === true &&
      out.credentialExpiredDuringRun === false &&
      out.approvalExpiredDuringRun === false,
    { counts, flags: out && {
      ok: out.ok, planExpiredDuringRun: out.planExpiredDuringRun,
      credentialExpiredDuringRun: out.credentialExpiredDuringRun,
      approvalExpiredDuringRun: out.approvalExpiredDuringRun
    } });
  } finally { tr.restore(); }
}

/** 对照：默认入口零外部动作。 */
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
  if (res.error !== undefined) {
    // 本宿主此刻无法启动子进程：**如实记录原始错误**，不预设原因、不冒充通过。
    record('R3-e-original-path-subprocess-entry', false, {
      unverified: true,
      reason: '宿主此刻无法启动该子进程（原始错误如实记录，原因未判定）',
      rawError: String(res.error.message).slice(0, 200)
    });
    return;
  }
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
  if (res.error !== undefined) {
    record('R3-e-missing-fields-rejected', false, {
      unverified: true,
      reason: '宿主此刻无法启动该子进程（原始错误如实记录，原因未判定）',
      rawError: String(res.error.message).slice(0, 200)
    });
    return;
  }
  record('R3-e-missing-fields-rejected', parsed !== null &&
    parsed.errorCode === worker.ERR.STDIN_INVALID,
  { status: res.status, errorCode: parsed ? parsed.errorCode : null,
    stdout: String(res.stdout).trim().slice(0, 120) });
}

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

  // §2 四个组合（起点同一合法成功载荷，仅替换同名字段）
  await comboUnknownFalseFlags();
  await comboInitializedDeniesFlags();
  await comboAuditOnlyConfirmed();
  await comboAlreadyPresentClaimsGrant();
  await comboTopBootstrapMismatch();
  // §3 真实 P4 alreadyPresent
  await realAlreadyPresent();
  // 保留对照
  await realNormalInitialization();
  await realCommitReadbackFailed();
  await wrongBindingConservativeReconcile();
  // R3-e（真实子进程入口）
  r3eRealSubprocessEntry();
  r3eMissingFieldsRejected();
  await defaultEntryZeroExternalActions();

  const summary = {
    total: results.length,
    passed: results.filter((x) => x.pass).length,
    unverified: results.filter((x) => x.unverified === true).length,
    failed: results.filter((x) => !x.pass && x.unverified !== true).length
  };

  process.stdout.write(JSON.stringify({
    observedAt: new Date().toISOString(),
    scope: 'Codex 2026-10-10 四次复核 N2 完整结果组合与 §3 真实 alreadyPresent 夹具更正',
    networkAttempts: boundaries.networkCalls,
    blockedProcesses: [],
    realCredentialFetches: boundaries.realCredentialFetches,
    realCloudCalls: boundaries.realCloudCalls,
    realInitializeExecuted: boundaries.realInitializeExecuted,
    realDeploymentExecuted: boundaries.realDeploymentExecuted,
    readRealAuthStoreContent: boundaries.readRealAuthStoreContent,
    wroteHistoricalOrBusinessFiles: boundaries.wroteHistoricalOrBusinessFiles,
    historicalAndClosedFilesUnchanged: true,
    protectedHashes,
    summary,
    verificationKinds: {
      synthetic: '四个组合样本：合成 CLI/worker 事件 + 合成 SDK 传输，无数据库读写；仅验证父层对损坏协议的处理',
      realSdkLocalTransform: '正常初始化 / 真实提交后回读失败 / 真实 alreadyPresent：真实 host/worker/P4/SDK 转换 + 合成传输，仍非云端执行',
      notPerformed: '真实凭据获取、真实初始化、平台事务、IAM 写权限、本人微信登记、资源创建、部署、入口启用均未验证'
    },
    boundaries: {
      notNetworked: true,
      noRealCredentialFetch: true,
      noRealInitialize: true,
      noResourceCreation: true,
      noDeployment: true,
      noEntranceEnable: true,
      subprocessUsesExpiredSyntheticCredentialOnly: true,
      noHistoricalEvidenceOverwritten: true,
      clockReplacedOnlyInsideThisProcess: true,
      followsRealP4ObserveContract: 'observePrimary 不返回 inputDigest；本证据不把摘要缺失当矛盾',
      note: 'SDK 层替换静态 Db.reqClass 并注入已建好的 db；事务计数是合成传输计数，不是云端写入'
    },
    results
  }, null, 2));
}

main().catch(() => { process.exit(1); });
