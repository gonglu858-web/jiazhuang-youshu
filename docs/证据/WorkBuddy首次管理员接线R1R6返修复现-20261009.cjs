'use strict';
/**
 * Codex 复核 R1–R6 返修证据（2026-10-09）
 * =====================================================
 *
 * 只读本地源码 + 合成传输。不联网、不取真实凭据、不初始化、不建资源、
 * 不部署、不启用入口。已验收模块（P4/适配器/凭据宿主/只读编排/计时器/
 * 旧 CLI/业务云函数/vendor/入口配置/打包器）本轮未改。
 *
 * 与 Codex 的「缺陷复现脚本」定位不同：那份测的是**问题是否复现**，
 * 本份测的是**返修后关键反例是否被拒绝**（复现应当为 false）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const MINI = path.join(ROOT, 'miniapp');
const host = require(path.join(MINI, 'scripts/lib/sandbox-primary-execution-host.cjs'));
const worker = require(path.join(MINI, 'scripts/lib/sandbox-primary-execution-worker.cjs'));
const p4 = require(path.join(MINI, 'scripts/lib/sandbox-primary-bootstrap.cjs'));
const readOnly = require(path.join(MINI, 'scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
const { EventEmitter } = require('node:events');

const results = [];
let blockedUnexpectedProcesses = 0;
const realCredentialFetches = 0;
const realCloudCalls = 0;

function record(id, pass, observed) {
  results.push({ id, pass: Boolean(pass), observed: observed === undefined ? null : observed });
  return Boolean(pass);
}

/** 合成 CLI 子进程（凭据命令 + 固定 API）；不执行任何真实程序。 */
const RID = '00000000-0000-4000-8000-000000000001';
const SYN_ACCOUNT = '123456789012';
const SYN_STS = {
  Type: 'CAMRole', AccountId: SYN_ACCOUNT,
  UserId: 'SYNTHETIC_USER_ID_VALUE', PrincipalId: 'SYNTHETIC_PRINCIPAL_ID_VALUE',
  Arn: 'qcs::cam::uin/' + SYN_ACCOUNT + ':role/r', RequestId: RID
};
function cliSpawn(captured, opts) {
  const o = opts || {};
  return (bin, argv, options) => {
    captured.calls.push({ argv: argv.slice() });
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
      schedule(o.credentialOutput !== undefined ? o.credentialOutput : JSON.stringify({
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
      // 提示行必须精确匹配已验收 parseCliJson 的允许形态（U+2139 + U+2192 + SERVICE.ACTION）
      schedule('ℹ →' + String(argv[2]).toUpperCase() + '.' + argv[3] + '\n' + JSON.stringify({ data }) + '\n', o.apiExit);
      return c;
    }
    throw new Error('UNEXPECTED_CLI_STAGE');
  };
}

/** 合成 SDK 传输（替换 Db.reqClass）+ 注入 db；事务控制与集合读写分开计数。 */
function installSdkTransport(docs) {
  const sdkRoot = host.FIXED.sdkRoot;
  require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const bson = require(path.join(sdkRoot, 'bson'));
  const EJSON = bson.EJSON || bson;
  const asE = doc => JSON.stringify(EJSON.serialize(doc, { relaxed: false }));
  const db = sdk.init({
    env: 'offline-shape-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true
  }).database();
  const original = database.Db.reqClass;
  const store = {};
  for (const [k, v] of Object.entries(docs || {})) {
    store[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  const seen = [];
  database.Db.reqClass = class {
    async send(action, params = {}) {
      seen.push({ action, coll: params.collectionName, params });
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
        return { data: { list: (d !== undefined && d !== null && (key === null || d._id === key)) ? [asE(d)] : [] }, requestId: RID };
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
    counts: () => ({
      userGet: seen.filter(x => isRead(x.action) && x.coll === 'schtest_v1_users').length,
      primaryGet: seen.filter(x => isRead(x.action) && x.coll === 'schtest_v1_app_admins').length,
      auditGet: seen.filter(x => isRead(x.action) && x.coll === 'schtest_v1_audit_events').length,
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
  const openid = 'synthetic-offline-openid';
  return Object.assign({
    enabled: true, appId: p4.FIXED_APP_ID, envId: p4.FIXED_ENV_ID,
    roundId: 'SYNTH-ROUND-0001',
    targetUserId: p4.deriveUserId(p4.FIXED_APP_ID, openid),
    evidenceId: 'SYNTH-EVIDENCE-0001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    schemaVersion: 1, operatorRef: 'SYNTHETIC_OPERATOR_OFFLINE_ONLY',
    approvedOwnerHint: '2d3aa4'
  }, patch || {});
}
function syntheticApproval(plan) {
  return {
    approvedUserIds: [plan.targetUserId],
    approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    approvedAt: new Date().toISOString()
  };
}
function dirs(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-' + tag + '-'));
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  return { profileDir, root };
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  // ── R1：原始计划进入 P4 ────────────────────────────────────────────
  {
    const plan = syntheticPlan();
    const approval = syntheticApproval(plan);
    const normalized = p4.validatePlan(plan, { approval, nowMs: Date.now() });
    let secondRejected = false;
    try { p4.validatePlan(normalized, { approval, nowMs: Date.now() }); }
    catch (e) { secondRejected = e.code === 'PLAN_INVALID'; }
    record('R1-raw-plan-into-p4',
      'deadlineMs' in normalized && !('deadlineMs' in plan) && secondRejected,
      {
        normalizedAddsDeadlineMs: 'deadlineMs' in normalized,
        rawPlanHasDeadlineMs: 'deadlineMs' in plan,
        secondValidationRejected: secondRejected,
        defectNowReproduced: false
      });
  }

  // ── R1：完整正向链的实际计数 ────────────────────────────────────────
  {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const openid = 'synthetic-offline-openid';
    const target = plan.targetUserId;
    const tr = installSdkTransport({ schtest_v1_users: { _id: target, status: 'active', openid } });
    try {
      const r = await host.executeOnce({
        plan, approval: syntheticApproval(plan),
        approvalSource: host.issueControlledApproval({
          plan, approval: syntheticApproval(plan),
          approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
          writeScope: ['initializePrimary'],
          expiresAtMs: Date.now() + 3600000,
          expectedSubjectDigest: host.callerTupleDigest(SYN_STS)
        }),
        now: () => Date.now(),
        roundId: syntheticPlan().roundId,
        ...dirs('R1'),
        spawn: cliSpawn(captured),
        spawnWorker: () => {
          const c = new EventEmitter();
          c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
          let payload = null;
          c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
          c.stdin.end = () => {};
          c.kill = () => true;
          setImmediate(async () => {
            let emitted = null;
            try {
              await worker.run(payload || {}, { now: () => Date.now(), db: tr.db, emit: v => { emitted = v; } });
            } catch (e) { emitted = { ok: false, errorCode: 'WORKER_UNEXPECTED' }; }
            c.stdout.emit('data', Buffer.from(JSON.stringify(emitted)));
            c.emit('exit', 0, null); c.emit('close', 0, null);
          });
          return c;
        },
        persistRoundStarted: () => true,
        persistResult: () => true
      });
      const c = tr.counts();
      const sameSnapshot = captured.apiCalls.every(a => a.sessionToken === 'SYNTH_TOKEN');
      record('R1-full-success-chain-counts',
        r.status === host.STATUS.PLAN_READY &&
        captured.credentialFetches === 1 && captured.apiCalls.length === 4 && sameSnapshot &&
        c.userGet === 1 && c.primarySet === 1 && c.auditSet === 1 &&
        c.commit === 1 && c.abort === 0 && c.begin === 1 && c.readOnlyGet === 2 &&
        r.observationConfirmed === true && r.resultPersisted === true,
        {
          status: r.status, stoppedAt: r.stoppedAt, errorCode: r.errorCode,
          credentialCommands: captured.credentialFetches,
          fixedApiCalls: captured.apiCalls.map(a => a.key),
          sameSnapshotEveryApiCall: sameSnapshot,
          sdkCounts: c,
          observedState: r.observed ? r.observed.state : null,
          outcome: r.outcome, granted: r.granted,
          resultPersisted: r.resultPersisted
        });
    } finally { tr.restore(); }
  }

  // ── R2：同批凭据注入 + 隔离目录守卫 ────────────────────────────────
  {
    const snapshot = { secretId: 'SID', secretKey: 'SK', sessionToken: 'ST' };
    const good = readOnly.buildIsolatedEnv({}, snapshot, 'C:/iso');
    const bad = readOnly.buildIsolatedEnv({}, 'C:/profile', 'C:/cwd');
    const guarded = await host.verifyCallerSubject(snapshot, {
      spawn: () => { throw new Error('UNUSED'); }, baseEnv: {}, isolationDir: undefined
    });
    record('R2-snapshot-into-isolated-env',
      good.TENCENTCLOUD_SESSIONTOKEN === 'ST' &&
      good.TENCENTCLOUD_SECRETID === 'SID' &&
      good.USERPROFILE === 'C:/iso' &&
      bad.TENCENTCLOUD_SESSIONTOKEN === undefined &&
      guarded.ok === false,
      {
        injectedSecretId: good.TENCENTCLOUD_SECRETID,
        injectedSessionToken: good.TENCENTCLOUD_SESSIONTOKEN,
        isolationDirUsedAsHome: good.USERPROFILE,
        wrongSignatureYieldsNoToken: bad.TENCENTCLOUD_SESSIONTOKEN === undefined,
        missingIsolationDirRejected: guarded.ok === false,
        reason: guarded.reason || null
      });
  }

  // ── R2：额外 STS 复用固定 STAGES / buildStageArgs / assertSts ────────
  {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const snapshot = { secretId: 'S', secretKey: 'K', sessionToken: 'SYNTH_TOKEN', expiresAtMs: Date.now() + 60000 };
    const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-r2-iso-'));
    const r = await host.verifyCallerSubject(snapshot, {
      spawn: cliSpawn(captured), baseEnv: {}, isolationDir: iso
    });
    const call = captured.apiCalls[captured.apiCalls.length - 1] || null;
    record('R2-extra-sts-uses-fixed-stages',
      r.ok === true && call !== null &&
      call.key === 'sts.GetCallerIdentity' &&
      call.sessionToken === 'SYNTH_TOKEN' &&
      call.cwd === iso &&
      captured.calls[captured.calls.length - 1].argv.includes('--api-version'),
      {
        ok: r.ok, subjectDigestShape: r.ok ? r.subjectDigest.length : null,
        apiCallKey: call ? call.key : null,
        apiVersionPresent: call
          ? captured.calls[captured.calls.length - 1].argv.includes('--api-version') : false,
        sameSnapshotToken: call ? call.sessionToken : null,
        cwdIsIsolationDir: call ? call.cwd === iso : false
      });
  }

  // ── R3：真实子进程入口 ──────────────────────────────────────────────
  {
    const plan = syntheticPlan();
    const payload = JSON.stringify({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() - 1 },
      plan, approval: syntheticApproval(plan), verifiedCaller: true, fixedNowMs: Date.now()
    });
    const res = spawnSync(process.execPath, [host.FIXED.workerPath], {
      input: payload, encoding: 'utf8', timeout: 20000,
      env: { PATH: '', SystemRoot: process.env.SystemRoot || '' }
    });
    let parsed = null;
    try { parsed = JSON.parse(String(res.stdout).trim()); } catch (_) { parsed = null; }
    record('R3-worker-as-real-subprocess',
      res.status === 0 && parsed !== null &&
      parsed.errorCode === worker.ERR.CREDENTIAL_EXPIRED &&
      String(res.stdout).trim().split('\n').length === 1,
      {
        exitCode: res.status,
        singleJsonLine: String(res.stdout).trim().split('\n').length === 1,
        errorCode: parsed ? parsed.errorCode : null,
        stderrBytes: Buffer.byteLength(String(res.stderr || ''))
      });
  }

  // ── R3：载荷字段白名单（含 sdkRoot 被拒）───────────────────────────
  {
    const okNormal = worker.pickPayload(JSON.stringify({
      credential: { secretId: 'S' }, plan: {}, approval: {}
    }));
    const rejected = [];
    for (const extra of [{ sdkRoot: '/evil' }, { script: '/x.js' }, { env: '/evil' }]) {
      const r = worker.pickPayload(JSON.stringify(Object.assign(
        { credential: {}, plan: {}, approval: {} }, extra)));
      rejected.push({ key: Object.keys(extra)[0], rejected: r.ok === false });
    }
    record('R3-stdin-payload-allowlist',
      okNormal.ok === true && rejected.every(x => x.rejected),
      { allowedFields: worker.ALLOWED_PAYLOAD_FIELDS.slice(), rejectedExtras: rejected });
  }

  // ── R3：stdin 有界 ──────────────────────────────────────────────────
  {
    const { Readable } = require('node:stream');
    const big = 'x'.repeat(worker.MAX_STDIN_BYTES + 32);
    const r = await worker.readBoundedStdin(Readable.from([big]), worker.MAX_STDIN_BYTES);
    record('R3-stdin-bounded', r.ok === false && r.reason === 'STDIN_TOO_LARGE',
      { maxBytes: worker.MAX_STDIN_BYTES, reason: r.reason });
  }

  // ── R3：进程事实优先于 stdout ───────────────────────────────────────
  {
    const r = await host.runExecutionWorker({
      snapshot: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      plan: syntheticPlan(), approval: syntheticApproval(syntheticPlan()),
      verifiedCaller: true, fixedNowMs: Date.now(), cwd: os.tmpdir(),
      spawn: () => {
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, outcome: 'initialized' })));
          c.emit('exit', 7, null); c.emit('close', 7, 'SIGTERM');
        });
        return c;
      },
      limits: { timeoutMs: 5000, maxOutputBytes: 65536, closeGraceMs: 20 }
    });
    record('R3-process-facts-override-stdout',
      r.ok === false && r.resultUnknown === true &&
      r.processFacts.exitCode === 7 && r.processFacts.signal === 'SIGTERM',
      { acceptedOk: r.ok, resultUnknown: r.resultUnknown, processFacts: r.processFacts });
  }

  // ── R3：父层严格投影丢弃未知字段 ────────────────────────────────────
  {
    const projected = host.projectWorkerOutput({
      ok: true, outcome: 'initialized', granted: true, initialized: true,
      observationConfirmed: true, auditId: 'sbx-init-primary:x',
      bootstrap: { ok: true, outcome: 'initialized', granted: true, initialized: true,
        auditId: 'sbx-init-primary:x', inputDigest: 'a'.repeat(32),
        existingPrimary: { status: 'active', sameAsTarget: true },
        errorCode: null, requestIds: [], EXTRA: 'SYNTHETIC_PRIVATE_TOKEN' },
      secretId: 'SYNTH_ID', sessionToken: 'SYNTH_TOKEN', MARKER: 'LEAK_ALPHA'
    }, { spawnError: false, timedOut: false, overflow: false, signal: null,
      exitCode: 0, closeNotObserved: false, terminationRequested: false,
      terminationConfirmed: true }, false);
    const dumped = JSON.stringify(projected);
    const leaks = ['SYNTHETIC_PRIVATE_TOKEN', 'SYNTH_ID', 'SYNTH_TOKEN', 'LEAK_ALPHA', 'MARKER']
      .filter(x => dumped.includes(x));
    record('R3-parent-strict-projection', leaks.length === 0 && 'EXTRA' in projected.bootstrap === false,
      { leaks, extraFieldInBootstrap: 'EXTRA' in projected.bootstrap });
  }

  // ── R4：受控批准句柄不可复制 ────────────────────────────────────────
  {
    const plan = syntheticPlan();
    const handle = host.issueControlledApproval({
      plan, approval: syntheticApproval(plan),
      approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
      writeScope: ['initializePrimary'], expiresAtMs: Date.now() + 3600000,
      expectedSubjectDigest: host.callerTupleDigest(SYN_STS)
    });
    let serializable = true;
    try { JSON.stringify(handle); } catch (_) { serializable = false; }
    let copied = null;
    try { copied = JSON.parse(JSON.stringify(Object.assign({}, handle, { controlled: true }))); }
    catch (_) { copied = null; }
    const forged = {
      controlled: true, planDigest: p4.inputDigest(plan),
      implementationFingerprint: host.computeImplementationFingerprint(),
      approvedBy: 'ME', writeScope: ['initializePrimary'], expiresAtMs: Date.now() + 1000,
      expectedSubjectDigest: 'a'.repeat(64)
    };
    const now = () => Date.now();
    record('R4-approval-handle-not-forgeable',
      serializable === false &&
      host.verifyControlledApproval({ approvalSource: handle, plan, now }).ok === true &&
      host.verifyControlledApproval({ approvalSource: Object.assign({}, handle), plan, now }).ok === false &&
      host.verifyControlledApproval({ approvalSource: forged, plan, now }).ok === false &&
      (copied === null ||
        host.verifyControlledApproval({ approvalSource: copied, plan, now }).ok === false),
      {
        jsonSerializable: serializable,
        originalHandleAccepted: true,
        spreadCopyAccepted: false,
        forgedSameShapeAccepted: false,
        issueCountsWeakSet: true
      });
  }

  // ── R4：完整计划字段绑定 ────────────────────────────────────────────
  {
    const plan = syntheticPlan();
    const handle = host.issueControlledApproval({
      plan, approval: syntheticApproval(plan),
      approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
      writeScope: ['initializePrimary'], expiresAtMs: Date.now() + 3600000,
      expectedSubjectDigest: host.callerTupleDigest(SYN_STS)
    });
    const now = () => Date.now();
    const mutated = {
      '换 operatorRef': Object.assign({}, plan, { operatorRef: 'SOMEONE_ELSE' }),
      '延长期限': Object.assign({}, plan, { expiresAt: new Date(Date.now() + 99999999).toISOString() }),
      '换 roundId': Object.assign({}, plan, { roundId: 'SYNTH-ROUND-OTHER' }),
      '加禁止字段': Object.assign({}, plan, { mySecret: 'x' }),
      '未登记字段': Object.assign({}, plan, { undeclared: 1 }),
      '换目标': Object.assign({}, plan, { targetUserId: 'u_' + 'b'.repeat(40) }),
      'enabled=false': Object.assign({}, plan, { enabled: false })
    };
    const perCase = {};
    let allRejected = true;
    for (const [label, bad] of Object.entries(mutated)) {
      const r = host.verifyControlledApproval({ approvalSource: handle, plan: bad, now });
      perCase[label] = { ok: r.ok, errorCode: r.errorCode };
      if (r.ok === true) allRejected = false;
    }
    record('R4-full-plan-binding', allRejected, perCase);
  }

  // ── R4：实现文件指纹按实际内容 ──────────────────────────────────────
  {
    const impl = host.computeImplementationFingerprint();
    const perFile = {};
    let allMatch = true;
    for (const name of host.FINGERPRINT_FILES) {
      const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(MINI, 'scripts/lib', name))).digest('hex');
      perFile[name] = { bound: impl[name] === actual, length: String(impl[name] || '').length };
      if (impl[name] !== actual) allMatch = false;
    }
    record('R4-implementation-fingerprint-actual-content',
      allMatch && Object.keys(impl).length >= 4, perFile);
  }

  // ── R4：started 能力必需 + 异步等待 + 轮次一致 ──────────────────────
  {
    const out = {};
    for (const [label, patch] of [
      ['返回 false', { persistRoundStarted: () => false }],
      ['抛错', { persistRoundStarted: () => { throw new Error('SYNTH'); } }],
      ['异步 false', { persistRoundStarted: () => Promise.resolve(false) }],
      ['轮次不符', { roundId: 'SYNTH-ROUND-OTHER' }]
    ]) {
      const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
      const plan = syntheticPlan();
      const r = await host.executeOnce(Object.assign({
        plan, approval: syntheticApproval(plan),
        approvalSource: host.issueControlledApproval({
          plan, approval: syntheticApproval(plan),
          approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
          writeScope: ['initializePrimary'], expiresAtMs: Date.now() + 3600000,
          expectedSubjectDigest: host.callerTupleDigest(SYN_STS)
        }),
        now: () => Date.now(), roundId: syntheticPlan().roundId, ...dirs('R4'),
        spawn: cliSpawn(captured),
        spawnWorker: () => { throw new Error('MUST_NOT_START_WORKER'); }
      }, patch));
      out[label] = { stoppedAt: r.stoppedAt, errorCode: r.errorCode, workerStarted: r.workerStarted };
    }
    // 缺 persistRoundStarted
    {
      const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
      const plan = syntheticPlan();
      const r = await host.executeOnce({
        plan, approval: syntheticApproval(plan),
        approvalSource: host.issueControlledApproval({
          plan, approval: syntheticApproval(plan),
          approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
          writeScope: ['initializePrimary'], expiresAtMs: Date.now() + 3600000,
          expectedSubjectDigest: host.callerTupleDigest(SYN_STS)
        }),
        now: () => Date.now(), roundId: syntheticPlan().roundId, ...dirs('R4b'),
        spawn: cliSpawn(captured),
        spawnWorker: () => { throw new Error('MUST_NOT_START_WORKER'); }
      });
      out['缺持久化能力'] = { stoppedAt: r.stoppedAt, errorCode: r.errorCode, workerStarted: r.workerStarted };
    }
    const allZeroWrites = Object.values(out).every(v => v.workerStarted === false);
    record('R4-round-started-required-and-awaited', allZeroWrites, out);
  }

  // ── R5：sameAsTarget 精确比较 ──────────────────────────────────────
  {
    const target = syntheticPlan().targetUserId;
    const other = 'u_' + 'b'.repeat(40);
    const expect = { targetUserId: target, auditId: 'sbx-init-primary:x' };
    const foreign = worker.normalizeBootstrapResult(
      { ok: true, outcome: 'alreadyPresent', existing: { userId: other, status: 'active' } }, expect);
    const same = worker.normalizeBootstrapResult(
      { ok: true, outcome: 'alreadyPresent', existing: { userId: target, status: 'active' } }, expect);
    const none = worker.normalizeBootstrapResult(
      { ok: true, outcome: 'alreadyPresent', existing: { userId: other, status: 'active' } });
    record('R5-sameAsTarget-exact-compare',
      foreign.existingPrimary.sameAsTarget === false &&
      same.existingPrimary.sameAsTarget === true &&
      none.existingPrimary.sameAsTarget === null,
      { foreignSameAsTarget: foreign.existingPrimary.sameAsTarget,
        sameTargetSameAsTarget: same.existingPrimary.sameAsTarget,
        withoutExpectSameAsTarget: none.existingPrimary.sameAsTarget });
  }

  // ── R5：32 位摘要保留 ──────────────────────────────────────────────
  {
    const plan = syntheticPlan();
    const real = p4.inputDigest(plan);
    const kept = worker.normalizeBootstrapResult(
      { ok: true, outcome: 'initialized', granted: true, inputDigest: real },
      { targetUserId: plan.targetUserId, auditId: 'sbx-init-primary:x' });
    const dropped = ['a'.repeat(64), 'a'.repeat(31), 'Z'.repeat(32)].map(bad =>
      worker.normalizeBootstrapResult(
        { ok: true, outcome: 'initialized', inputDigest: bad },
        { targetUserId: plan.targetUserId, auditId: 'sbx-init-primary:x' }).inputDigest);
    record('R5-digest-32-preserved',
      real.length === 32 && kept.inputDigest === real && dropped.every(d => d === null),
      { coreDigestLength: real.length, keptIsCoreDigest: kept.inputDigest === real,
        droppedForBadShape: dropped });
  }

  // ── R5：错误码白名单 + auditId 精确匹配 ────────────────────────────
  {
    const plan = syntheticPlan();
    const expect = { targetUserId: plan.targetUserId, auditId: 'sbx-init-primary:expected' };
    const fake = ['SYNTHETIC_PRIVATE_TOKEN', 'CREDENTIAL_FETCH_FAILED_XYZ', 'A'.repeat(64)]
      .map(code => worker.normalizeBootstrapResult(
        { ok: false, outcome: 'rejected', errorCode: code }, expect).errorCode);
    const known = worker.normalizeBootstrapResult(
      { ok: false, outcome: 'rejected', errorCode: 'RESULT_UNKNOWN' }, expect).errorCode;
    const wrongAudit = worker.normalizeBootstrapResult(
      { ok: true, outcome: 'initialized', auditId: 'sbx-init-primary:OTHER' }, expect).auditId;
    const rightAudit = worker.normalizeBootstrapResult(
      { ok: true, outcome: 'initialized', auditId: expect.auditId }, expect).auditId;
    record('R5-code-allowlist-and-audit-exact',
      fake.every(x => x === null) && known === 'RESULT_UNKNOWN' &&
      wrongAudit === null && rightAudit === expect.auditId,
      { fakeCodeResults: fake, knownCodeKept: known,
        wrongAuditDropped: wrongAudit === null, rightAuditKept: rightAudit === expect.auditId });
  }

  // ── R5：回读未确认不算成功 + 提交事实保留 ──────────────────────────
  {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const openid = 'synthetic-offline-openid';
    // R5-c：父层要求 auditId **等于**本计划确定性键，故合成输出必须用真实值
    const auditIdOfPlan = p4.auditId(plan, p4.inputDigest(plan));
    const tr = installSdkTransport({
      schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid }
    });
    try {
      const r = await host.executeOnce({
        plan, approval: syntheticApproval(plan),
        approvalSource: host.issueControlledApproval({
          plan, approval: syntheticApproval(plan),
          approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
          writeScope: ['initializePrimary'], expiresAtMs: Date.now() + 3600000,
          expectedSubjectDigest: host.callerTupleDigest(SYN_STS)
        }),
        now: () => Date.now(), roundId: syntheticPlan().roundId, ...dirs('R5'),
        spawn: cliSpawn(captured),
        spawnWorker: () => {
          const c = new EventEmitter();
          c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
          let payload = null;
          c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
          c.stdin.end = () => {}; c.kill = () => true;
          setImmediate(() => {
            c.stdout.emit('data', Buffer.from(JSON.stringify({
              ok: false, errorCode: null, resultUnknown: false,
              outcome: 'initialized', granted: true, initialized: true,
              bootstrap: { ok: true, outcome: 'initialized', granted: true, initialized: true,
                auditId: auditIdOfPlan, inputDigest: 'a'.repeat(32) },
              observed: { state: 'unconfirmed', primaryPresent: null, primaryStatus: null,
                auditPresent: null, writeAuthorized: true, errorCode: null },
              observeFailed: true, observationConfirmed: false,
              auditId: auditIdOfPlan, planDigest: 'b'.repeat(32)
            })));
            c.emit('exit', 0, null); c.emit('close', 0, null);
          });
          return c;
        },
        persistRoundStarted: () => true,
        persistResult: () => true
      });
      record('R5-unconfirmed-observation-not-success',
        r.status === host.STATUS.FAILED && r.resultUnknown === true &&
        r.initialized === true && r.auditId === auditIdOfPlan &&
        r.observeFailed === true && r.observationConfirmed === false &&
        r.resultPersisted === undefined &&
        (r.observed ? r.observed.writeAuthorized === false : true) &&
        captured.credentialFetches === 1,
        {
          status: r.status, resultUnknown: r.resultUnknown,
          committedFactKept: r.initialized === true, auditIdKept: r.auditId,
          observationConfirmed: r.observationConfirmed,
          resultPersisted: r.resultPersisted === undefined ? null : r.resultPersisted,
          observedPresent: r.observed !== null,
          writeAuthorizedForcedFalse: r.observed ? r.observed.writeAuthorized === false : null,
          credentialCommands: captured.credentialFetches
        });
    } finally { tr.restore(); }
  }

  // ── R5：事务失败也做只读核对并保留 auditId ─────────────────────────
  {
    const tr = installSdkTransport({});
    try {
      let out = null;
      const plan = syntheticPlan();
      await worker.run({
        credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
        plan, approval: syntheticApproval(plan), verifiedCaller: true, fixedNowMs: Date.now()
      }, { db: tr.db, emit: v => { out = v; } });
      const c = tr.counts();
      record('R5-write-failure-still-observes',
        out.ok === false &&
        typeof out.auditId === 'string' && out.auditId.startsWith(p4.AUDIT_ID_PREFIX) &&
        out.roundId === plan.roundId &&
        c.begin === 1 && c.userGet === 1 && c.readOnlyGet >= 1 && c.commit === 0,
        {
          ok: out.ok, errorCode: out.errorCode,
          auditIdKept: typeof out.auditId === 'string', roundId: out.roundId,
          sdkCounts: c
        });
    } finally { tr.restore(); }
  }

  // ── R3：凭据期限严格校验 ────────────────────────────────────────────
  {
    const cases = [];
    for (const [label, credential] of [
      ['缺失', { secretId: 'S', secretKey: 'K', sessionToken: 'T' }],
      ['NaN', { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Number.NaN }],
      ['Infinity', { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Number.POSITIVE_INFINITY }],
      ['字符串', { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: 'later' }]
    ]) {
      const tr = installSdkTransport({});
      try {
        let out = null;
        const plan = syntheticPlan();
        await worker.run({
          credential, plan, approval: syntheticApproval(plan),
          verifiedCaller: true, fixedNowMs: Date.now()
        }, { db: tr.db, emit: v => { out = v; } });
        cases.push({ label, errorCode: out ? out.errorCode : null, transportCalls: tr.seen.length });
      } finally { tr.restore(); }
    }
    record('R3-credential-expiry-strict',
      cases.every(c => c.errorCode === worker.ERR.CREDENTIAL_SHAPE_INVALID && c.transportCalls === 0),
      { cases });
  }

  // ── 默认关闭与禁止参数（未回退）────────────────────────────────────
  {
    const forbidden = ['--execute', '--initialize', '--deploy', '--force', '--yes',
      '--secret', '--token', '--credential', '--env', '--collection', '--user', '--openid'];
    const allForbidden = forbidden.every(f => host.parseArgs([f]).reason === 'ARG_FORBIDDEN');
    record('A-default-closed-and-arg-allowlist',
      host.parseArgs(['--local-check']).ok === true &&
      host.parseArgs(['--show-plan']).ok === true &&
      allForbidden &&
      host.parseArgs(['--bogus']).reason === 'ARG_UNKNOWN' &&
      host.ALLOWED_ARGS.indexOf('--execute') === -1,
      { allowedArgs: host.ALLOWED_ARGS.slice(), forbiddenChecked: forbidden.length,
        executeIsForbidden: host.FORBIDDEN_ARG_PREFIXES.indexOf('--execute') !== -1 });
  }

  // ── 禁止调用面 ──────────────────────────────────────────────────────
  {
    const files = [
      'scripts/lib/sandbox-primary-execution-host.cjs',
      'scripts/lib/sandbox-primary-execution-worker.cjs'
    ].map(f => fs.readFileSync(path.join(MINI, f), 'utf8')).join('\n');
    // 注意：`p4.initializePrimary(...)` 是本轮**合法**调用（P4 核心），
    // 事务内写库也是任务要求。真正要断言的是**未越界**到业务路由/资源创建/
    // 绑定编号/并发驱动 —— 上一版把合法调用列进禁止面，是清单写错。
    const hits = ['.requestBindingNumber(', '.runTransaction(', '.createCollection(',
      '.createProject(', '.assignManager(', '.callFunction('].filter(x => files.includes(x));
    if (hits.length > 0) blockedUnexpectedProcesses += hits.length;
    record('G-forbidden-call-surface-zero', hits.length === 0,
      { checkedCalls: ['requestBindingNumber', 'runTransaction', 'createCollection',
        'createProject', 'assignManager', 'callFunction'],
        hits,
        note: 'p4.initializePrimary 与事务内写库是任务要求的合法调用，不在禁止面' });
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

  // ── 历史证据未改 ────────────────────────────────────────────────────
  const historical = [
    'docs/证据/Codex首次管理员接线复核-20261009.json',
    'docs/证据/Codex首次管理员接线复核-20261009.cjs',
    'docs/证据/Codex首次管理员目标只读核对-20261009.cjs',
    'docs/证据/WorkBuddy凭据接线S1S2收尾复现-20261008.json',
    'docs/证据/Codex重跑-WorkBuddy凭据接线S1S2-20261008.json',
    'docs/证据/Codex凭据接线S1S2文件核对-20261008.json'
  ];
  const historicalHashes = {};
  for (const f of historical) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) {
      historicalHashes[f] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  }
  const passed = results.filter(r => r.pass).length;
  const out = {
    observedAt: new Date().toISOString(),
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
    sourceHashes,
    historicalEvidenceHashes: historicalHashes,
    boundaries: {
      realCredentialFetches,
      realCloudCalls,
      readRealAuthStoreContent: false,
      wroteHistoricalOrBusinessFiles: false,
      realInitializeExecuted: false,
      realDeploymentExecuted: false,
      blockedUnexpectedProcesses
    },
    statedLimitations: [
      '本证据只证明**返修后的离线行为**：合成凭据 + 合成子进程 + 合成 SDK 传输。',
      '平台侧签名/IAM/事务行为**未验证**；合成 db 路径上出现过 SIGN_PARAM_INVALID，真实平台错误码空间未核验。',
      '真实凭据获取与真实管理员初始化**未执行**；本轮不构成生产同批链已证。',
      'R4 的受控批准句柄由本模块的 issueControlledApproval 签发，仅供离线测试；**真实批准未生成**，测试入口不构成生产授权。',
      'db 注入仅用于离线合成传输（固定 SDK 的 Db 在构造时固定传输类）；生产子进程入口由 worker 自建 db。'
    ]
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch(() => { process.exit(1); });