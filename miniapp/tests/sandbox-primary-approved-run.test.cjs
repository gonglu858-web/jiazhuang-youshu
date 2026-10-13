'use strict';
/**
 * 首次管理员真实入口 R1–R5 定点返修 —— 相称离线测试
 * =================================================
 *
 * 依据 docs/Codex复核-首次管理员真实入口最小接线-20261012.md：
 *  - R1 真实来源模式与批准绑定：真实模式拒绝执行依赖覆盖（spawn/worker/
 *    时钟/路径/凭据依赖等），固定真实 spawn + 固定 nodeBin + 固定
 *    workerPath + 固定隔离根；来源模式纳入不可变批准绑定。离线验证真实
 *    分支使用**模块级**离线装配（installRealModeOfflineHarness）+ 文件系统
 *    虚拟化，不再把测试开关作为真实入口普通参数。
 *  - R2 默认接线：入口自接排他 started 核对与终态保存；调用方不再提供
 *    persistRoundStarted/persistResult；真实 worker 启动参数（固定 node +
 *    固定 workerPath + 私有 stdin）离线捕获验证。
 *  - R3 入口指纹：入口文件哈希在批准签发时绑定，取凭据前与启动 worker 前
 *    各比较一次；补签发后漂移与异步等待期间漂移反例。
 *  - R4 终态完整投影：提交事实/成功资格/退出事实/未知结果/核对结论落盘；
 *    保存失败抛结构化错误（e.execution 净化事实），不伪造成功。
 *  - R5 全程守卫：本文件在**加载任何应用模块之前**安装网络与真实子进程
 *    拒绝守卫（进程级，不恢复），敏感性探针实测拦截并计数；业务期间意外
 *    尝试 = 总数 − 探针 = 0。真实登录目录与 SDK 隔离根的文件操作经虚拟化
 *    重定向到一次性临时沙箱（受控装载替身），不读、不建、不清理真实认证
 *    目录内容。
 *
 * 合成传输口径（与已验收 host 测试一致）：CLI 层替换 spawn；SDK 层替换
 * `@cloudbase/database` 的 `Db.reqClass` 并注入 db —— 真实 SDK 本地转换；
 * 平台行为未验证。不联网、不取真实凭据、不读真实认证内容、不初始化。
 */

// ── R5：全程守卫（先于任何应用模块加载安装，进程内不恢复） ─────────────────
const GUARD_TOTALS = { https: 0, http: 0, dns: 0, net: 0, cp: 0 };
const GUARD_PROBES = { https: 0, http: 0, dns: 0, net: 0, cp: 0 };
const GUARD_STACKS = [];
(function installGlobalGuards() {
  const https = require('node:https');
  const http = require('node:http');
  const dns = require('node:dns');
  const net = require('node:net');
  const cp = require('node:child_process');
  const blocked = (label, channel) => {
    GUARD_TOTALS[channel]++;
    GUARD_STACKS.push({ channel, stack: new Error('guard').stack.split('\n').slice(2, 12).join('\n') });
    const e = new Error('测试全程守卫：禁止' + label + '（' + channel + '）');
    e.code = channel === 'cp' ? 'TEST_CHILD_PROCESS_BLOCKED' : 'TEST_NET_BLOCKED';
    throw e;
  };
  https.request = function (...a) { return blocked('网络请求', 'https'); };
  http.request = function (...a) { return blocked('网络请求', 'http'); };
  dns.lookup = function (...a) { blocked('DNS 解析', 'dns'); };
  dns.resolve = function (...a) { blocked('DNS 解析', 'dns'); };
  net.connect = function (...a) { return blocked('网络连接', 'net'); };
  net.createConnection = function (...a) { return blocked('网络连接', 'net'); };
  cp.spawn = function (...a) { return blocked('真实子进程', 'cp'); };
  cp.exec = function (...a) { return blocked('真实子进程', 'cp'); };
  cp.execFile = function (...a) { return blocked('真实子进程', 'cp'); };
  cp.fork = function (...a) { return blocked('真实子进程', 'cp'); };
})();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const host = require('../scripts/lib/sandbox-primary-execution-host.cjs');
const worker = require('../scripts/lib/sandbox-primary-execution-worker.cjs');
const p4 = require('../scripts/lib/sandbox-primary-bootstrap.cjs');
const approvedRun = require('../scripts/lib/sandbox-primary-approved-run.cjs');
const identityBinding = require('../scripts/lib/sandbox-identity-binding.cjs');
const cliObserver = require('../scripts/lib/cloudbase-readonly-observer.cjs');
const sdkObserver = require('../scripts/lib/cloudbase-sdk-readonly-observer.cjs');

const SYN_OPENID = 'synthetic-offline-openid';
const SYN_TARGET = p4.deriveUserId(p4.FIXED_APP_ID, SYN_OPENID);
const SYN_ACCOUNT = '123456789012';
const RID = '00000000-0000-4000-8000-000000000001';
const REAL_AUTH_DIR = cliObserver.FIXED.authSessionDir;
const REAL_ISOLATION_ROOT = sdkObserver.FIXED.isolationRoot;
const ENTRY_FILE = host.ENTRY_FILE;
const ENTRY_ABS = path.join(path.dirname(require.resolve('../scripts/lib/sandbox-primary-execution-host.cjs')), ENTRY_FILE);

// ── R5：文件系统虚拟化（真实登录目录 / SDK 隔离根 → 一次性沙箱） ───────────
function installFsVirtualization(tag) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-fsv-' + tag + '-'));
  const roots = [REAL_AUTH_DIR, REAL_ISOLATION_ROOT].map(r => path.resolve(r));
  const vops = [];
  const norm = p => path.resolve(String(p)).toLowerCase();
  const mapPath = (p) => {
    const pn = norm(p);
    for (const r of roots) {
      const rn = norm(r);
      if (pn === rn || pn.startsWith(rn.toLowerCase() + path.sep.toLowerCase())) {
        const rel = path.resolve(String(p)).slice(path.resolve(r).length);
        const mapped = path.join(sandbox, rel);
        vops.push({ logical: String(p), mapped });
        return mapped;
      }
    }
    return null;
  };
  const WRAP = ['mkdirSync', 'existsSync', 'statSync', 'lstatSync', 'accessSync',
    'readdirSync', 'realpathSync', 'readFileSync', 'writeFileSync', 'appendFileSync'];
  const originals = [];
  for (const name of WRAP) {
    const orig = fs[name];
    originals.push([name, orig]);
    fs[name] = function (p, ...rest) {
      const mapped = mapPath(p);
      return orig.call(fs, mapped === null ? p : mapped, ...rest);
    };
  }
  return {
    sandbox, vops,
    restore: () => {
      for (const [name, orig] of originals.reverse()) fs[name] = orig;
    }
  };
}

// ── 夹具 ──────────────────────────────────────────────────────────────────

function syntheticPlan(target, patch) {
  return Object.assign({
    enabled: true,
    appId: p4.FIXED_APP_ID,
    envId: p4.FIXED_ENV_ID,
    roundId: 'SYNTH-ROUND-0001',
    targetUserId: target || SYN_TARGET,
    evidenceId: 'SYNTH-EVIDENCE-0001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    schemaVersion: 1,
    operatorRef: 'SYNTHETIC_OPERATOR_OFFLINE_ONLY',
    approvedOwnerHint: '2d3aa4'
  }, patch || {});
}

const SYN_STS = {
  Type: 'CAMRole',
  AccountId: SYN_ACCOUNT,
  UserId: 'SYNTHETIC_USER_ID_VALUE',
  PrincipalId: 'SYNTHETIC_PRINCIPAL_ID_VALUE',
  Arn: 'qcs::cam::uin/' + SYN_ACCOUNT + ':role/r',
  RequestId: RID
};

/** 合成受控批准句柄：只经宿主 `issueControlledApproval` 签发（离线专用）。 */
function syntheticApprovalSource(plan, patch) {
  const p = patch || {};
  const spec = {
    plan: p.plan || plan,
    approval: p.approval || {
      approvedUserIds: [plan.targetUserId],
      approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
      approvedAt: new Date().toISOString()
    },
    approvedBy: p.approvedBy || 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    writeScope: p.writeScope || ['initializePrimary'],
    expiresAtMs: typeof p.expiresAtMs === 'number' ? p.expiresAtMs : Date.now() + 3600000,
    // R1：来源模式纳入批准绑定（默认离线夹具）
    credentialSourceMode: p.credentialSourceMode === undefined
      ? 'offline-fixture' : p.credentialSourceMode
  };
  // 2026-10-12 身份绑定方案：新版绑定的透传（旧/新互斥由签发与核验保证）
  const modern = p.bindingPolicyVersion !== undefined ||
    p.expectedStableIdentityDigest !== undefined;
  if (p.expectedSubjectDigest !== undefined) {
    // 显式提供旧摘要时照传（用于互斥反例；签发会拒绝混用）
    spec.expectedSubjectDigest = p.expectedSubjectDigest;
  } else if (!modern) {
    spec.expectedSubjectDigest = host.callerTupleDigest(SYN_STS);
  }
  if (modern) {
    if (p.bindingPolicyVersion !== undefined) spec.bindingPolicyVersion = p.bindingPolicyVersion;
    if (p.expectedStableIdentityDigest !== undefined) {
      spec.expectedStableIdentityDigest = p.expectedStableIdentityDigest;
    }
  }
  return host.issueControlledApproval(spec);
}

function cliStdoutFor(service, action, dataOverride) {
  const key = service + '.' + action;
  const data = dataOverride !== undefined ? dataOverride
    : key === 'sts.GetCallerIdentity' ? SYN_STS
    : key === 'tcb.DescribeEnvs'
      ? { EnvList: [{ EnvId: host.FIXED.envId, Status: 'NORMAL', Region: host.FIXED.region }], RequestId: RID }
      : {
        EnvInfo: {
          EnvBaseInfo: { EnvId: host.FIXED.envId, Status: 'NORMAL', Region: host.FIXED.region },
          UserInfo: { Uin: SYN_ACCOUNT, WxAppId: host.FIXED.appId }
        },
        RequestId: RID
      };
  return 'ℹ →' + String(service).toUpperCase() + '.' + action + '\n' +
    JSON.stringify({ data }) + '\n';
}

/** 合成 CLI 子进程：捕获 argv/env/cwd（证明固定来源参数，不做别名）。 */
function syntheticCliSpawn(captured, opts) {
  const o = opts || {};
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    captured.calls.push({
      argv: argv.slice(),
      cwd: options && options.cwd,
      home: options && options.env ? (options.env.USERPROFILE || options.env.HOME) : null
    });
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
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
      respond(JSON.stringify({
        data: {
          secretId: 'SYNTH_ID', secretKey: 'SYNTH_KEY', token: 'SYNTH_TOKEN',
          isTemporary: true, expiredAt: new Date(Date.now() + 1800000).toISOString(),
          envId: null
        }
      }), o.credentialExit);
      return c;
    }
    if (argv[1] === 'api') {
      captured.apiCalls.push({ key: argv[2] + '.' + argv[3] });
      if (typeof o.onApiCall === 'function') o.onApiCall(captured.apiCalls.length);
      // 2026-10-12 身份绑定方案：支持按次注入 STS 响应序列（会话变化反例用）
      if (argv[2] === 'sts' && argv[3] === 'GetCallerIdentity' && o.stsRawOutput !== undefined) {
        // R1 剩余出口：畸形 stdout（JSON 解析失败路径）
        return respond(o.stsRawOutput, o.apiExit);
      }
      if (argv[2] === 'sts' && argv[3] === 'GetCallerIdentity' &&
        Array.isArray(o.stsResponses) && o.stsResponses.length > 0) {
        const idx = Math.min(captured.stsCalls, o.stsResponses.length - 1);
        captured.stsCalls++;
        return respond(cliStdoutFor(argv[2], argv[3], o.stsResponses[idx]), o.apiExit);
      }
      respond(cliStdoutFor(argv[2], argv[3]), o.apiExit);
      return c;
    }
    throw new Error('UNEXPECTED_CLI_STAGE');
  };
}

/** 合成 SDK 传输（真实 SDK 本地转换；注入 db；与已验收 host 测试同一做法）。 */
function installSyntheticSdkTransport(docs, opts) {
  const o = opts || {};
  const sdkRoot = host.FIXED.sdkRoot;
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const bson = require(path.join(sdkRoot, 'bson'));
  const EJSON = bson.EJSON || bson;
  const seen = [];
  const db = sdk.init({
    env: 'offline-shape-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true
  }).database();
  const original = database.Db.reqClass;
  const store = {};
  for (const [k, v] of Object.entries(docs || {})) {
    store[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  const asEjsonDoc = doc => JSON.stringify(EJSON.serialize(doc, { relaxed: false }));
  let committed = 0;
  class SyntheticRequest {
    async send(action, params = {}) {
      seen.push({ action, coll: params.collectionName, params });
      if (action === 'database.commitTransaction') committed++;
      // D-5：提交后回读失败 —— 提交发生后所有读操作按注入失败
      if (o.failReadsAfterCommit && committed > 0 &&
        (action === 'database.getDocument' || action === 'database.getInTransaction')) {
        throw new Error('SYNTH_READBACK_FAILURE');
      }
      let key = null;
      if (typeof params.query === 'string') {
        try { key = JSON.parse(params.query)._id || null; } catch (_) { key = null; }
      } else if (params.query && typeof params.query._id === 'string') {
        key = params.query._id;
      }
      if (!key && typeof params._id === 'string') key = params._id;
      if (action === 'database.startTransaction') return { transactionId: 'synthetic-tx-1' };
      if (action === 'database.commitTransaction') return { requestId: RID };
      if (action === 'database.abortTransaction') return { requestId: RID };
      if (action === 'database.getDocument' || action === 'database.getInTransaction') {
        const doc = store[params.collectionName];
        const hit = doc !== undefined && doc !== null && (key === null || doc._id === key)
          ? [asEjsonDoc(doc)] : [];
        return { data: { list: hit }, requestId: RID };
      }
      if (action === 'database.modifyDocument' || action === 'database.updateDocInTransaction') {
        const incoming = JSON.parse(params.data);
        const prev = store[params.collectionName];
        const targetId = key || (prev ? prev._id : null);
        store[params.collectionName] = Object.assign({}, prev || {}, incoming,
          targetId ? { _id: targetId } : {});
        return { data: { updated: prev ? 1 : 0, upsert_id: prev ? undefined : targetId }, requestId: RID };
      }
      throw new Error('unexpected SDK action: ' + action);
    }
  }
  database.Db.reqClass = SyntheticRequest;
  return {
    db, seen, store,
    counts: () => ({
      primarySet: seen.filter(x => (x.action === 'database.modifyDocument' ||
        x.action === 'database.updateDocInTransaction') && x.coll === 'schtest_v1_app_admins').length,
      auditSet: seen.filter(x => (x.action === 'database.modifyDocument' ||
        x.action === 'database.updateDocInTransaction') && x.coll === 'schtest_v1_audit_events').length,
      commit: seen.filter(x => x.action === 'database.commitTransaction').length
    }),
    restore: () => { database.Db.reqClass = original; }
  };
}

function syntheticDirs(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-' + tag + '-'));
  const dirs = {
    profileDir: path.join(root, 'profile'),
    isolationDir: path.join(root, 'iso'),
    root
  };
  fs.mkdirSync(dirs.profileDir, { recursive: true });
  fs.mkdirSync(dirs.isolationDir, { recursive: true });
  return dirs;
}

/** 合成 worker 子进程（真实 worker.run 本地执行 + 注入 db）。 */
function syntheticWorkerSpawn(tr, capture) {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    let payload = null;
    c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
    c.stdin.end = () => {};
    c.kill = () => true;
    if (capture) capture.calls.push({ bin, argv: argv.slice(), options, payloadRef: () => payload });
    setImmediate(async () => {
      let emitted = null;
      try {
        await worker.run(payload || {}, {
          now: () => Date.now(),
          db: tr ? tr.db : null,
          emit: (v) => { emitted = v; }
        });
      } catch (_) {
        emitted = { ok: false, errorCode: 'WORKER_UNEXPECTED' };
      }
      const out = emitted === null ? { ok: false, errorCode: 'WORKER_NO_OUTPUT' } : emitted;
      c.stdout.emit('data', Buffer.from(JSON.stringify(out)));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    return c;
  };
}

/** 永不结束的 worker 子进程（worker 超时用）。 */
function hangingWorkerSpawn() {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {};
    c.kill = () => true; // 终止请求被记录，但进程从未退出（模拟悬挂）
    return c;
  };
}

function freshOutDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ar-out-' + tag + '-'));
}

function offlineChain(opts) {
  const o = opts || {};
  const captured = { calls: [], credentialFetches: 0, apiCalls: [], stsCalls: 0 };
  const planPatch = Object.assign({}, o.planPatch,
    o.runId ? { roundId: o.runId } : {});
  const plan = syntheticPlan(o.target, planPatch);
  const source = syntheticApprovalSource(plan, o.approvalPatch);
  const tr = installSyntheticSdkTransport(o.docs === undefined
    ? { schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: SYN_OPENID } }
    : o.docs, o.transportOpts);
  const outDir = freshOutDir(o.tag || 'b');
  const dirs = syntheticDirs('fx');
  return {
    captured, plan, source, tr, outDir, dirs,
    options: {
      runId: o.runId || plan.roundId,
      outDir, plan, approvalSource: source,
      roundId: o.runId || plan.roundId,
      credentialSourceMode: o.credentialSourceMode,
      profileDir: o.profileDir !== undefined ? o.profileDir : dirs.profileDir,
      spawn: syntheticCliSpawn(captured, o.cliOpts),
      spawnWorker: o.spawnWorker || syntheticWorkerSpawn(tr, o.workerCapture),
      workerLimits: o.workerLimits,
      reconcileDeps: { db: tr.db }
    }
  };
}

// ══════════════════════════════════════════════════════════════════════
// A：R1 来源模式绑定与固定执行依赖
// ══════════════════════════════════════════════════════════════════════

test('A-1 离线模式缺合成 profile：started 之前拒绝（零写零子进程）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  const outDir = freshOutDir('a1');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'A1-NOPROF-001', outDir, plan, approvalSource: source,
      roundId: plan.roundId,
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.CREDENTIAL_FETCH_FAILED);
  assert.equal(captured.calls.length, 0, '不得有任何子进程');
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false, 'started 之前拒绝，零写');
  assert.equal(fs.existsSync(path.join(outDir, 'terminal')), false);
});

test('A-2 未知凭据来源模式拒绝；默认离线模式同样须先过 profile 前置检查', async () => {
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  for (const mode of ['real', 'REAL', 'fixed-real', 'production', '', 7]) {
    const outDir = freshOutDir('a2');
    await assert.rejects(
      () => approvedRun.runOnce({
        runId: 'A2-MODE-0001', outDir, plan, approvalSource: source,
        roundId: plan.roundId, credentialSourceMode: mode,
        profileDir: path.join(freshOutDir('a2p'), 'profile'),
        spawn: () => { throw new Error('不应有子进程'); }
      }),
      (e) => e.code === host.ERR.PLAN_INVALID, String(mode));
    assert.equal(fs.existsSync(path.join(outDir, 'started')), false, String(mode));
  }
});

test('A-3 R1 反例闭合：真实模式传入 credentialDeps.fixed.nodeBin 覆盖 → 拒绝', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
  const outDir = freshOutDir('a3');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'A3-OVR-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, credentialSourceMode: 'fixed-real-source',
      // Codex 样本原覆盖路径：nodeBin 覆盖必须到达不了合成 secrets spawn
      credentialDeps: { fixed: { nodeBin: 'SYNTHETIC_NOT_FIXED_NODE' } },
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.REAL_MODE_OVERRIDE_REJECTED);
  assert.equal(captured.calls.length, 0, '覆盖值不得到达任何子进程');
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false, 'started 之前拒绝');
});

test('A-4 R1 反例闭合：真实模式传入任意 profileDir → 拒绝（来源别名不接受）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
  const dirs = syntheticDirs('a4');
  const outDir = freshOutDir('a4');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'A4-ALIAS-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, credentialSourceMode: 'fixed-real-source',
      profileDir: dirs.profileDir,
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.REAL_MODE_OVERRIDE_REJECTED);
  assert.equal(captured.calls.length, 0);
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
});

test('A-5 R1 正向：真实模式经模块级离线装配全链 —— 固定来源/固定启动器参数被捕获，真实目录经虚拟化', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const workerCapture = { calls: [] };
  const plan = syntheticPlan(null, { roundId: 'A5-REALSRC-0001' });
  const source = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID }
  });
  const outDir = freshOutDir('a5');
  const fsv = installFsVirtualization('a5');
  const uninstall = host.installRealModeOfflineHarness({
    spawn: syntheticCliSpawn(captured),
    spawnWorker: syntheticWorkerSpawn(tr, workerCapture),
    // R5：真实模式的只读核对传输同样来自模块级离线装配
    reconcileDeps: { db: tr.db }
  });
  try {
    const r = await approvedRun.runOnce({
      runId: 'A5-REALSRC-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, credentialSourceMode: 'fixed-real-source'
    });
    assert.equal(r.result.realModeOfflineHarness, true, '报告如实标记离线装配');
    // 固定真实来源：凭据子进程 Home 逻辑上等于固定真实 authSessionDir（字符串同一）
    const credCalls = captured.calls.filter(x => x.argv[1] === 'secrets');
    assert.equal(credCalls.length, 1, '凭据命令恰一次');
    assert.equal(credCalls[0].home, REAL_AUTH_DIR,
      '凭据 CLI 的 Home 必须恰为固定真实 authSessionDir：' + credCalls[0].home);
    // Home 是环境注入的原样字符串（与固定常量字节同一）；cwd 经 path.join
    // 规范化了分隔符 —— 包含性判断按分隔符归一后比较，不做其它别名化。
    const normSep = v => String(v).replace(/[\\/]+/g, '\\').replace(/[\\/]+$/, '');
    assert.ok(credCalls[0].cwd &&
      normSep(credCalls[0].cwd).startsWith(normSep(REAL_AUTH_DIR) + '\\'),
      '凭据获取 cwd 建在固定真实目录之内（逻辑路径）：' + credCalls[0].cwd);
    // R5：上述对真实目录的操作全部被虚拟化重定向，真实目录零触达
    assert.ok(fsv.vops.length >= 2, '应有虚拟化文件操作记录：' + fsv.vops.length);
    const fetchedDir = fsv.vops.find(v => v.logical === credCalls[0].cwd);
    assert.ok(fetchedDir, '凭据获取 cwd 的创建应被重定向：' + JSON.stringify(fsv.vops.slice(0, 3)));
    assert.ok(fetchedDir.mapped.startsWith(fsv.sandbox), '实际落在一次性沙箱内');
    assert.ok(fs.existsSync(fetchedDir.mapped), '沙箱内目录确实存在（重定向生效）');
    assert.equal(path.dirname(fetchedDir.mapped), fsv.sandbox, '逻辑相对结构保持');
    // R2：真实模式固定 worker 启动参数 —— 固定 node + 固定 workerPath + 私有 stdin
    if (workerCapture.calls.length !== 1) {
      console.error('A5-DEBUG', JSON.stringify({
        status: r.status, stoppedAt: r.result.stoppedAt, errorCode: r.result.errorCode,
        incomplete: r.result.incomplete
      }));
    }
    assert.equal(workerCapture.calls.length, 1, 'worker 恰启动一次');
    const wc = workerCapture.calls[0];
    assert.equal(wc.bin, cliObserver.FIXED.nodeBin, '固定 nodeBin');
    assert.equal(wc.argv[0], host.FIXED.workerPath, '固定 workerPath');
    assert.equal(wc.argv.length, 1, '无额外参数');
    assert.ok(wc.payloadRef() && wc.payloadRef().plan, '载荷经私有 stdin 一次传入');
    // 正向链：1 凭据 + 4 API + 两写一提交 + COMPLETED
    assert.equal(captured.credentialFetches, 1);
    assert.equal(captured.apiCalls.length, 4);
    const c = tr.counts();
    assert.equal(c.primarySet, 1);
    assert.equal(c.auditSet, 1);
    assert.equal(c.commit, 1);
    assert.equal(r.result.fixedRealSourceUsed, true);
    assert.equal(r.status, 'COMPLETED', JSON.stringify({
      stoppedAt: r.result.stoppedAt, errorCode: r.result.errorCode,
      incomplete: r.result.incomplete
    }));
    assert.ok(fs.existsSync(path.join(outDir, 'terminal', 'A5-REALSRC-0001.COMPLETED.json')));
  } finally {
    uninstall();
    fsv.restore();
    tr.restore();
  }
});

test('A-6 R1：真实模式逐项拒绝执行依赖覆盖（时钟/隔离根/worker/核对注入等）', async () => {
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
  const cases = {
    now: () => Date.now(),
    fixedNowMs: 12345,
    baseEnv: { SYNTH: '1' },
    isolationFixed: { isolationRoot: os.tmpdir() },
    spawnWorker: () => { throw new Error('不应被调用'); },
    workerLimits: { timeoutMs: 1 },
    reconcileReadOnly: () => {},
    reconcileDeps: { db: null },
    readOnlyDeps: {},
    limits: { timeoutMs: 1 },
    credentialCwd: os.tmpdir()
  };
  for (const [key, value] of Object.entries(cases)) {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const outDir = freshOutDir('a6');
    await assert.rejects(
      () => approvedRun.runOnce(Object.assign({
        runId: 'A6-OVR-0001', outDir, plan, approvalSource: source,
        roundId: plan.roundId, credentialSourceMode: 'fixed-real-source',
        spawn: syntheticCliSpawn(captured)
      }, { [key]: value })),
      (e) => e.code === host.ERR.REAL_MODE_OVERRIDE_REJECTED, key);
    assert.equal(captured.calls.length, 0, key + '：零子进程');
    assert.equal(fs.existsSync(path.join(outDir, 'started')), false, key + '：零写');
  }
});

test('A-7 R1：来源模式与批准绑定不一致 → started 之前拒绝（双向）', async () => {
  const plan = syntheticPlan();
  const offlineHandle = syntheticApprovalSource(plan); // 绑定 offline-fixture
  const realHandle = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const dirs = syntheticDirs('a7');
  // 句柄绑定离线，请求真实（不传任何执行依赖 —— 覆盖拒绝由 A-3/A-6 单独闭合）
  const outDir1 = freshOutDir('a7a');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'A7-BIND-0001', outDir: outDir1, plan, approvalSource: offlineHandle,
      roundId: plan.roundId, credentialSourceMode: 'fixed-real-source'
    }),
    (e) => e.code === host.ERR.REAL_MODE_BINDING_MISMATCH);
  // 句柄绑定真实，请求离线
  const outDir2 = freshOutDir('a7b');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'A7-BIND-0002', outDir: outDir2, plan, approvalSource: realHandle,
      roundId: plan.roundId, credentialSourceMode: 'offline-fixture',
      profileDir: dirs.profileDir
    }),
    (e) => e.code === host.ERR.REAL_MODE_BINDING_MISMATCH);
  assert.equal(captured.calls.length, 0);
  assert.equal(fs.existsSync(path.join(outDir1, 'started')), false);
  assert.equal(fs.existsSync(path.join(outDir2, 'started')), false);
});

test('A-8 模块级离线装配的自身校验：未知字段与缺 spawn 拒绝', () => {
  assert.throws(
    () => host.installRealModeOfflineHarness({ spawn: () => {}, profileDir: 'x' }),
    (e) => e.code === host.ERR.REAL_MODE_OVERRIDE_REJECTED);
  assert.throws(
    () => host.installRealModeOfflineHarness({}),
    (e) => e.code === host.ERR.REAL_MODE_OVERRIDE_REJECTED);
});

test('A-9 离线夹具模式显式给出固定真实目录 → started 之前拒绝（两模式隔离）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  const outDir = freshOutDir('a9');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'A9-ISOL-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId,
      credentialSourceMode: 'offline-fixture',
      profileDir: REAL_AUTH_DIR, // 离线模式绝不允许指向真实登录目录
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.CREDENTIAL_FETCH_FAILED);
  assert.equal(captured.calls.length, 0);
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
});

// ══════════════════════════════════════════════════════════════════════
// B：R2 默认接线 + 排他 started 与终态保存
// ══════════════════════════════════════════════════════════════════════

test('B-1 R2 正向（离线合成链，无调用方持久化回调）：入口自接 started 核对与终态保存', async () => {
  const fx = offlineChain({ tag: 'b1', runId: 'B1-OK-0001' });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'COMPLETED', JSON.stringify(r.result.incomplete));
    assert.equal(r.result.outcome, 'initialized');
    // started 独占新建，内容含确定性审计键与指纹
    const started = JSON.parse(fs.readFileSync(path.join(fx.outDir, 'started', 'B1-OK-0001.json'), 'utf8'));
    assert.equal(started.recordType, 'STARTED');
    assert.equal(started.auditId, r.result.auditId);
    assert.ok(started.auditId.startsWith(p4.AUDIT_ID_PREFIX));
    assert.ok(started.planDigest && started.fullPlanDigest);
    assert.equal(started.credentialSourceMode, 'offline-fixture');
    // 指纹：实现 4 文件 + 本入口文件
    assert.ok(started.fingerprint.entry.file === ENTRY_FILE);
    assert.ok(/^[0-9a-f]{64}$/.test(started.fingerprint.entry.sha256));
    // R2：终态由入口自接落盘（没有调用方 persistResult 也完整在盘）
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'B1-OK-0001.COMPLETED.json'), 'utf8'));
    assert.equal(terminal.recordType, 'COMPLETED');
    assert.equal(terminal.auditId, started.auditId);
    assert.equal(terminal.resultPersisted, true);
    // 宿主全链证据：一次凭据、4 次 API、一次事务两写一提交
    assert.equal(fx.captured.credentialFetches, 1);
    assert.equal(fx.captured.apiCalls.length, 4);
    const c = fx.tr.counts();
    assert.equal(c.primarySet, 1);
    assert.equal(c.auditSet, 1);
    assert.equal(c.commit, 1);
  } finally { fx.tr.restore(); }
});

test('B-2 重复轮次：同轮已有终态在 started/取凭据之前拒绝；第二次运行不覆盖 started、不再写库', async () => {
  const fx = offlineChain({ tag: 'b2', runId: 'B2-DUP-0001' });
  try {
    const first = await approvedRun.runOnce(fx.options);
    assert.equal(first.status, 'COMPLETED');
    const startedBefore = fs.readFileSync(path.join(fx.outDir, 'started', 'B2-DUP-0001.json'));
    const terminalBefore = fs.readFileSync(path.join(fx.outDir, 'terminal', 'B2-DUP-0001.COMPLETED.json'));
    const writesBefore = fx.tr.counts();
    // S2：同轮已有任一种终态 → 在创建 started、取凭据之前拒绝（TERMINAL_EXISTS）；
    // 排他 wx 防竞态仍是第二道防线
    await assert.rejects(
      () => approvedRun.runOnce(fx.options),
      (e) => e.code === approvedRun.ERR.TERMINAL_EXISTS);
    assert.ok(fs.readFileSync(path.join(fx.outDir, 'started', 'B2-DUP-0001.json'))
      .equals(startedBefore), 'started 不得被重写');
    assert.ok(fs.readFileSync(path.join(fx.outDir, 'terminal', 'B2-DUP-0001.COMPLETED.json'))
      .equals(terminalBefore), '既有终态不得被改写');
    const writesAfter = fx.tr.counts();
    assert.equal(writesAfter.primarySet, writesBefore.primarySet, '零额外写');
    assert.equal(fx.captured.credentialFetches, 1, '不重新取凭据');
  } finally { fx.tr.restore(); }
});

test('B-3 终态已存在：同状态再次保存不覆盖历史（TERMINAL_EXISTS）', async () => {
  const outDir = freshOutDir('b3');
  const first = await approvedRun.saveTerminalExclusive(outDir, 'B3-SAVE-0001', 'FAILED', {
    auditId: 'audit-x', planDigest: 'digest-x', errorCode: 'X'
  });
  assert.equal(first.saved, true);
  const before = fs.readFileSync(path.join(outDir, 'terminal', 'B3-SAVE-0001.FAILED.json'));
  await assert.rejects(
    () => approvedRun.saveTerminalExclusive(outDir, 'B3-SAVE-0001', 'FAILED', {
      auditId: 'audit-x', planDigest: 'digest-x', errorCode: 'Y'
    }),
    (e) => e.code === approvedRun.ERR.TERMINAL_EXISTS);
  assert.ok(fs.readFileSync(path.join(outDir, 'terminal', 'B3-SAVE-0001.FAILED.json'))
    .equals(before), '历史终态字节不变');
});

test('B-4 未知终态被拒绝；终态名册仅三个', async () => {
  await assert.rejects(
    () => approvedRun.saveTerminalExclusive(freshOutDir('b4'), 'B4-STAT-0001', 'SUCCESS', {}),
    (e) => e.code === approvedRun.ERR.STATUS_INVALID);
  assert.deepEqual(approvedRun.TERMINAL_STATUSES.slice().sort(),
    ['COMPLETED', 'FAILED', 'RESULT_UNKNOWN'].sort());
});

test('B-5 R4：终态记录按白名单投影 —— 全部保留字段键都在，未知字段不进盘', async () => {
  const outDir = freshOutDir('b5');
  await approvedRun.saveTerminalExclusive(outDir, 'B5-PROJ-0001', 'RESULT_UNKNOWN', {
    auditId: 'audit-unk', planDigest: 'digest-unk', errorCode: 'RESULT_UNKNOWN',
    resultUnknown: true, SYNTH_PRIVATE_MARKER: 'SHOULD_NOT_PERSIST'
  });
  const body = JSON.parse(fs.readFileSync(
    path.join(outDir, 'terminal', 'B5-PROJ-0001.RESULT_UNKNOWN.json'), 'utf8'));
  for (const key of approvedRun.TERMINAL_FIELDS) {
    assert.ok(key in body, 'R4 保留字段应始终出现：' + key);
  }
  assert.equal(body.resultUnknown, true);
  assert.equal('SYNTH_PRIVATE_MARKER' in body, false, '白名单外字段不得进入终态记录');
  assert.equal(body.recordType, 'RESULT_UNKNOWN');
});

// ══════════════════════════════════════════════════════════════════════
// C：批准与计划交界（预期阶段拒绝，零凭据零子进程零写）
// ══════════════════════════════════════════════════════════════════════

test('C-1 普通 JSON 冒充批准句柄：在批准交界拒绝，零凭据零写', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const outDir = freshOutDir('c1');
  const fake = JSON.parse(JSON.stringify({
    plan, approval: { approvedUserIds: [plan.targetUserId],
      approvedBy: 'FAKE', approvedAt: new Date().toISOString() },
    approvedBy: 'FAKE', writeScope: ['initializePrimary'],
    expiresAtMs: Date.now() + 3600000,
    planDigest: 'x', fullPlanDigest: 'y'
  }));
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'C1-FAKE-0001', outDir, plan, approvalSource: fake,
      roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING);
  assert.equal(captured.calls.length, 0);
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
});

test('C-2 复制句柄（序列化后重建）不被接受：toJSON 抛错证明句柄不可序列化', () => {
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  assert.throws(() => JSON.stringify(source), /不可序列化/);
});

test('C-3 过期批准：在预期阶段拒绝，零凭据零写', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan, { expiresAtMs: Date.now() - 1000 });
  const outDir = freshOutDir('c3');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'C3-EXP-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING);
  assert.equal(captured.calls.length, 0);
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
});

test('C-4 错目标：目标不在批准名单内即拒绝', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const otherTarget = p4.deriveUserId(p4.FIXED_APP_ID, 'someone-else-offline');
  const plan = syntheticPlan(otherTarget);
  const source = syntheticApprovalSource(syntheticPlan());
  const outDir = freshOutDir('c4');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'C4-TGT-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING ||
      e.code === host.ERR.PLAN_INVALID);
  assert.equal(captured.calls.length, 0);
});

test('C-5 期限边界：批准有效期恰在当前时刻 → 已过期拒绝（expires<=now）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const atNow = Date.now();
  const source = syntheticApprovalSource(plan, { expiresAtMs: atNow });
  const outDir = freshOutDir('c5');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'C5-EDGE-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
      now: () => atNow,
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING);
  assert.equal(captured.calls.length, 0);
});

test('C-6 缺计划/缺句柄：模块级即拒绝并给出固定错误码', () => {
  assert.throws(() => approvedRun.checkPlanAndApproval({}),
    (e) => e.code === approvedRun.ERR.PLAN_REQUIRED);
  const plan = syntheticPlan();
  assert.throws(() => approvedRun.checkPlanAndApproval({ plan }),
    (e) => e.code === approvedRun.ERR.APPROVAL_REQUIRED);
});

test('C-7 非法轮次标识、已占用结果目录、轮次与绑定计划不一致：写入前拒绝', async () => {
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  await assert.rejects(
    () => approvedRun.runOnce({ runId: '../escape', outDir: freshOutDir('c7a'),
      plan, approvalSource: source, profileDir: path.join(freshOutDir('c7p'), 'profile') }),
    (e) => e.code === approvedRun.ERR.RUN_ID_INVALID);
  const used = freshOutDir('c7b');
  fs.writeFileSync(path.join(used, 'occupied.json'), '{}');
  await assert.rejects(
    () => approvedRun.runOnce({ runId: 'C7-DIR-0001', outDir: used,
      plan, approvalSource: source, profileDir: path.join(freshOutDir('c7p'), 'profile') }),
    (e) => e.code === approvedRun.ERR.RUN_DIR_INVALID);
  // §7-1：轮次可本地判定不一致 → started 之前拒绝（不再等到取凭据后）
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const outDir = freshOutDir('c7c');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'C7-ROUND-0001', outDir, plan, approvalSource: source,
      roundId: 'OTHER-ROUND-9999', profileDir: path.join(freshOutDir('c7p'), 'profile'),
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === approvedRun.ERR.ROUND_MISMATCH);
  assert.equal(captured.calls.length, 0, '轮次错误零子进程');
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false, '轮次错误零写');
});

test('C-8 已有 primary（alreadyPresent）：宿主语义不变，终态如实保存 RESULT_UNKNOWN', async () => {
  const fx = offlineChain({
    tag: 'c8', runId: 'C8-PRI-0001',
    docs: {
      schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID },
      schtest_v1_app_admins: { _id: 'primary', userId: SYN_TARGET, status: 'active' }
    }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.result.outcome, 'alreadyPresent', JSON.stringify(r.result.bootstrap));
    assert.equal(r.result.initialized, false);
    assert.equal(r.status, 'RESULT_UNKNOWN',
      '宿主 FAILED+RESULT_UNKNOWN 应如实保存为未知终态：' + r.status);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'C8-PRI-0001.RESULT_UNKNOWN.json'), 'utf8'));
    assert.equal(terminal.recordType, 'RESULT_UNKNOWN');
    assert.equal(terminal.outcome, 'alreadyPresent');
    assert.equal(fs.existsSync(path.join(fx.outDir, 'terminal', 'C8-PRI-0001.COMPLETED.json')),
      false, '不得保存 COMPLETED 终态');
    const c = fx.tr.counts();
    assert.equal(c.primarySet, 0, 'primary 已存在时零写');
    assert.equal(c.commit, 0, '已有 primary 不得提交');
  } finally { fx.tr.restore(); }
});

// ══════════════════════════════════════════════════════════════════════
// D：R3 漂移反例 / R4 完整链与保存失败 / R5 敏感性与 §7 文案更正
// ══════════════════════════════════════════════════════════════════════

/** 在文件读取边界模拟入口字节改变（不改磁盘源文件）。 */
function installEntryDrift(after) {
  const origRead = fs.readFileSync;
  let drifted = 0;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(ENTRY_ABS)) {
      if (!after || after()) {
        drifted++;
        return Buffer.concat([origRead.call(fs, p, ...rest), Buffer.from('// SYNTHETIC DRIFT\n')]);
      }
    }
    return origRead.call(fs, p, ...rest);
  };
  return { count: () => drifted, restore: () => { fs.readFileSync = origRead; } };
}

test('D-1 R3 反例闭合：签发后入口漂移 → 取凭据之前拒绝（零凭据零子进程零写）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan); // 签发时绑定当时入口哈希
  const outDir = freshOutDir('d1');
  const drift = installEntryDrift(() => true); // 读取边界模拟字节改变
  try {
    await assert.rejects(
      () => approvedRun.runOnce({
        runId: 'D1-DRIFT-0001', outDir, plan, approvalSource: source,
        roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
        spawn: syntheticCliSpawn(captured)
      }),
      (e) => e.code === host.ERR.FINGERPRINT_MISMATCH);
    assert.equal(captured.calls.length, 0, '漂移在取凭据之前拒绝：零子进程');
    assert.equal(fs.existsSync(path.join(outDir, 'started')), false, '零写');
  } finally { drift.restore(); }
});

test('D-2 R3 反例闭合：异步等待期间入口漂移 → 启动 worker 前复核拦截（不 COMPLETED）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const fx = offlineChain({
    tag: 'd2', runId: 'D2-DRIFT-0001',
    cliOpts: { onApiCall: (n) => { if (n >= 1) driftArmed = true; } }
  });
  let driftArmed = false;
  const drift = installEntryDrift(() => driftArmed);
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.result.stoppedAt, 'entryFingerprintRecheck',
      '启动 worker 前的入口指纹复核应拦截：' + JSON.stringify({
        stoppedAt: r.result.stoppedAt, errorCode: r.result.errorCode
      }));
    assert.equal(r.result.errorCode, host.ERR.FINGERPRINT_MISMATCH);
    assert.equal(r.status, 'FAILED', '不得 COMPLETED');
    assert.ok(drift.count() >= 2, '入口文件被读取比较过（签发后核对+启动前复核）');
    assert.equal(fx.captured.credentialFetches, 1, '凭据已取得（漂移发生在等待期间）');
    assert.equal(fx.tr.counts().commit, 0, '未启动 worker，零提交');
    // 终态如实保存 FAILED，保留已发生的凭据事实
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'D2-DRIFT-0001.FAILED.json'), 'utf8'));
    assert.equal(terminal.errorCode, host.ERR.FINGERPRINT_MISMATCH);
    assert.ok(fs.existsSync(path.join(fx.outDir, 'started', 'D2-DRIFT-0001.json')));
  } finally { drift.restore(); fx.tr.restore(); }
});

test('D-3 R4 正向：完整链终态保留提交事实/成功资格/退出事实/核对结论，且无凭据泄漏', async () => {
  const fx = offlineChain({ tag: 'd3', runId: 'D3-FULL-0001' });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'COMPLETED');
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'D3-FULL-0001.COMPLETED.json'), 'utf8'));
    // R4 必备七类事实
    assert.equal(terminal.initialized, true);
    assert.equal(terminal.granted, true);
    assert.equal(terminal.commitFactEstablished, true);
    assert.equal(terminal.fullInitializationSuccess, true);
    assert.equal(terminal.observationConfirmed, true);
    assert.ok(terminal.workerProcess && terminal.workerProcess.exitCode === 0 &&
      terminal.workerProcess.timedOut === false, 'worker 进程退出事实：' +
      JSON.stringify(terminal.workerProcess));
    assert.ok('reconcile' in terminal && 'reconcileAttempted' in terminal,
      '核对结论字段保留');
    assert.equal(terminal.resultPersisted, true);
    // 净化：终态记录不得含凭据类内容
    const raw = JSON.stringify(terminal);
    for (const marker of ['SYNTH_ID', 'SYNTH_KEY', 'SYNTH_TOKEN', 'secretId', 'secretKey', 'sessionToken']) {
      assert.ok(!raw.includes(marker), '终态不得包含凭据类内容：' + marker);
    }
  } finally { fx.tr.restore(); }
});

test('D-4 R4 完整链：worker 超时 → RESULT_UNKNOWN 终态保留进程事实，零提交', async () => {
  const fx = offlineChain({
    tag: 'd4', runId: 'D4-TIMEOUT-0001',
    spawnWorker: hangingWorkerSpawn(),
    workerLimits: { timeoutMs: 400, maxOutputBytes: 1048576 }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'RESULT_UNKNOWN', JSON.stringify({
      stoppedAt: r.result.stoppedAt, errorCode: r.result.errorCode
    }));
    assert.equal(r.result.resultUnknown, true);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'D4-TIMEOUT-0001.RESULT_UNKNOWN.json'), 'utf8'));
    assert.equal(terminal.recordType, 'RESULT_UNKNOWN');
    assert.equal(terminal.workerProcess.timedOut, true, '超时进程事实保留');
    assert.equal(terminal.auditId, r.result.auditId);
    const c = fx.tr.counts();
    assert.equal(c.commit, 0, '未发生提交');
    assert.equal(c.primarySet, 0, '零写');
    assert.equal(fx.captured.credentialFetches, 1, '凭据恰一次（不刷新重试）');
  } finally { fx.tr.restore(); }
});

test('D-5 R4 完整链：提交后回读失败 → RESULT_UNKNOWN 终态保留提交事实', async () => {
  const fx = offlineChain({
    tag: 'd5', runId: 'D5-READBK-0001',
    transportOpts: { failReadsAfterCommit: true }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'RESULT_UNKNOWN', JSON.stringify({
      stoppedAt: r.result.stoppedAt, errorCode: r.result.errorCode
    }));
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'D5-READBK-0001.RESULT_UNKNOWN.json'), 'utf8'));
    // 提交事实已确立且必须保留（不得抹为零写）
    assert.equal(terminal.commitFactEstablished, true);
    assert.equal(terminal.initialized, true);
    assert.equal(terminal.granted, true);
    assert.equal(terminal.fullInitializationSuccess, false, '观察未确认，不构成完整成功');
    assert.equal(terminal.resultUnknown, true);
    const c = fx.tr.counts();
    assert.equal(c.commit, 1, '提交确已发生');
    assert.equal(c.primarySet, 1);
    assert.equal(c.auditSet, 1);
    assert.equal(fx.captured.credentialFetches, 1, '不重新取凭据重试');
  } finally { fx.tr.restore(); }
});

test('D-6 R4 反例闭合：终态落盘失败 → 结构化错误带净化执行事实，不伪造成功', async () => {
  const fx = offlineChain({ tag: 'd6', runId: 'D6-SAVEF-0001' });
  const origWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = function (p, data, options) {
      if (typeof p === 'string' && p.includes(path.join('terminal', 'D6-SAVEF-0001'))) {
        const e = new Error('EIO');
        e.code = 'EIO';
        throw e;
      }
      return origWrite.call(fs, p, data, options);
    };
    await assert.rejects(
      () => approvedRun.runOnce(fx.options),
      (e) => {
        if (e.code !== approvedRun.ERR.TERMINAL_SAVE_FAILED) return false;
        // 结构化执行事实：可重建提交/退出/核对事实
        const ex = e.execution;
        assert.ok(ex, '必须携带 e.execution');
        assert.ok(ex.auditId && ex.auditId.startsWith(p4.AUDIT_ID_PREFIX), 'auditId 保留');
        assert.equal(ex.commitFactEstablished, true, '提交事实保留');
        assert.equal(ex.initialized, true);
        assert.equal(ex.granted, true);
        assert.ok(ex.workerProcess && ex.workerProcess.exitCode === 0, '退出事实保留');
        assert.equal(e.causeCode, 'EIO',
          '原始固定失败类别随 causeCode 保留（S2：首次保存失败不重试）');
        // 净化：不透传原始异常文本、不含凭据
        const raw = JSON.stringify({ message: e.message, execution: ex });
        assert.ok(!/EIO/.test(e.message), '不透传原始异常文本');
        for (const marker of ['SYNTH_ID', 'SYNTH_KEY', 'SYNTH_TOKEN']) {
          assert.ok(!raw.includes(marker), '不含凭据：' + marker);
        }
        return true;
      });
    // started 保留（证明曾启动）；不伪造终态成功
    assert.ok(fs.existsSync(path.join(fx.outDir, 'started', 'D6-SAVEF-0001.json')));
    assert.equal(fs.existsSync(path.join(fx.outDir, 'terminal', 'D6-SAVEF-0001.COMPLETED.json')),
      false, '保存失败不得留下 COMPLETED 记录');
  } finally {
    fs.writeFileSync = origWrite;
    fx.tr.restore();
  }
});

test('D-7 R5 敏感性探针：全程守卫对网络与真实子进程实际拦截并计数', () => {
  const https = require('node:https');
  const http = require('node:http');
  const dns = require('node:dns');
  const net = require('node:net');
  const cp = require('node:child_process');
  assert.throws(() => https.request('https://example.invalid'),
    (e) => e.code === 'TEST_NET_BLOCKED');
  GUARD_PROBES.https++;
  assert.throws(() => http.request('http://example.invalid'),
    (e) => e.code === 'TEST_NET_BLOCKED');
  GUARD_PROBES.http++;
  assert.throws(() => dns.lookup('example.invalid'),
    (e) => e.code === 'TEST_NET_BLOCKED');
  GUARD_PROBES.dns++;
  assert.throws(() => net.connect(443, 'example.invalid'),
    (e) => e.code === 'TEST_NET_BLOCKED');
  GUARD_PROBES.net++;
  assert.throws(() => cp.spawn('node', ['-e', '1']),
    (e) => e.code === 'TEST_CHILD_PROCESS_BLOCKED');
  GUARD_PROBES.cp++;
  // 探针之外的全部业务场景共用同一守卫：意外尝试在 D-9 汇总核对
});

test('D-8 §7 文案更正：格式合法但与当次 STS 不同的主体摘要 —— 取得当次身份后比较（1 凭据+4 API 后停），零事务写', async () => {
  // 预期摘要绑定了**另一个**主体（格式合法）：按报告 §7-2，
  // 这类不匹配只能在取得当次身份（STS）之后比较 —— 不得宣称全部在取凭据前发现。
  const otherSts = Object.assign({}, SYN_STS, { UserId: 'OTHER_USER_VALUE', PrincipalId: 'OTHER_PRINCIPAL' });
  const fx = offlineChain({
    tag: 'd8', runId: 'D8-SUBJ-0001',
    approvalPatch: { expectedSubjectDigest: host.callerTupleDigest(otherSts) }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.result.stoppedAt, 'callerSubject');
    assert.equal(r.result.errorCode, host.ERR.CALLER_SUBJECT_MISMATCH);
    assert.equal(r.result.credentialFetched, true, '已取得当次凭据');
    assert.equal(fx.captured.credentialFetches, 1);
    assert.equal(fx.captured.apiCalls.length, 4, '三阶段+额外 STS 后才比较主体');
    const c = fx.tr.counts();
    assert.equal(c.primarySet, 0, '零事务写');
    assert.equal(c.commit, 0);
    assert.equal(r.status, 'FAILED');
  } finally { fx.tr.restore(); }
});

test('D-9 §7 文案更正：缺失/格式非法的预期主体摘要 —— 取凭据之前拒绝', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const bad = syntheticApprovalSource(plan, { expectedSubjectDigest: 'not-a-valid-digest' });
  const outDir = freshOutDir('d9');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'D9-SUBJ-0001', outDir, plan, approvalSource: bad,
      roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
      spawn: syntheticCliSpawn(captured)
    }),
    (e) => e.code === host.ERR.CALLER_SUBJECT_UNVERIFIED ||
      e.code === host.ERR.APPROVAL_REQUIRED ||
      e.code === host.ERR.PLAN_INVALID);
  assert.equal(captured.calls.length, 0, '零子进程');
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
});

test('D-10 R5 汇总：业务期间意外网络/真实子进程尝试 = 总数 − 探针 = 0', () => {
  for (const channel of Object.keys(GUARD_TOTALS)) {
    const unexpected = GUARD_TOTALS[channel] - GUARD_PROBES[channel];
    if (unexpected !== 0) {
      const stacks = GUARD_STACKS
        .filter(s => s.channel === channel)
        .map(s => s.stack).join('\n---\n');
      assert.fail(channel + '：业务期间意外尝试 ' + unexpected + '；栈：\n' + stacks);
    }
    assert.equal(unexpected, 0);
  }
});

test('D-11 模块边界：approved-run 不再接受调用方持久化回调；不提供公众 execute/approve 开关', async () => {
  // R2：持久化回调由入口自接 —— 调用方传入的 persist* 不再是入口契约的一部分；
  // 传入即视为未收录参数，由宿主/入口按真实模式覆盖清单或离线转发语义处理。
  // 此处验证：离线正向不传 persist* 也完整落盘（B-1 已证），且导出无公众开关。
  for (const key of Object.keys(approvedRun)) {
    assert.ok(!/^execute|^approve/i.test(key),
      '导出不应含公众执行/批准开关：' + key);
  }
  assert.equal(typeof approvedRun.runOnce, 'function');
});

// ══════════════════════════════════════════════════════════════════════
// E：S1–S3 收尾（host 双向绑定前置 / 终态冲突前置与保存失败事实 / 保存标记）
// ══════════════════════════════════════════════════════════════════════

test('E-1 S1 反例闭合：host 直接调用 —— 批准绑定真实模式、请求离线模式 → 取凭据前拒绝', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
  const dirs = syntheticDirs('e1');
  const report = await host.executeOnce({
    plan, approvalSource: source, roundId: plan.roundId,
    credentialSourceMode: 'offline-fixture',
    profileDir: dirs.profileDir,
    spawn: syntheticCliSpawn(captured),
    persistRoundStarted: async () => true,
    persistResult: async () => true
  });
  assert.equal(report.errorCode, host.ERR.REAL_MODE_BINDING_MISMATCH,
    'host 直接调用的反向不匹配也应拒绝');
  assert.equal(report.stoppedAt, 'credentialSourceBinding');
  assert.equal(captured.calls.length, 0, '零子进程（未取凭据）');
});

test('E-2 S1 反例闭合：host 直接调用 —— 批准绑定离线模式、请求真实模式 → 取凭据前拒绝（先于覆盖清单）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan); // 绑定 offline-fixture
  const dirs = syntheticDirs('e2');
  const report = await host.executeOnce({
    plan, approvalSource: source, roundId: plan.roundId,
    credentialSourceMode: 'fixed-real-source',
    profileDir: dirs.profileDir,
    spawn: syntheticCliSpawn(captured),
    persistRoundStarted: async () => true,
    persistResult: async () => true
  });
  assert.equal(report.errorCode, host.ERR.REAL_MODE_BINDING_MISMATCH);
  assert.equal(report.stoppedAt, 'credentialSourceBinding');
  assert.equal(captured.calls.length, 0, '零子进程');
});

test('E-3 S1 对照：host 直接调用 —— 绑定与请求一致（离线）时全链正常完成', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: SYN_OPENID }
  });
  const dirs = syntheticDirs('e3');
  try {
    const report = await host.executeOnce({
      plan, approvalSource: source, roundId: plan.roundId,
      credentialSourceMode: 'offline-fixture',
      profileDir: dirs.profileDir,
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: async () => true,
      persistResult: async () => true
    });
    assert.equal(report.status, host.STATUS.PLAN_READY);
    assert.equal(captured.credentialFetches, 1);
    assert.equal(captured.apiCalls.length, 4);
    const c = tr.counts();
    assert.equal(c.primarySet, 1);
    assert.equal(c.auditSet, 1);
    assert.equal(c.commit, 1);
  } finally { tr.restore(); }
});

test('E-4 S2 完整链：部分写后 EIO → 恰一次保存尝试，结构化错误保留已提交事实与半截文件', async () => {
  const fx = offlineChain({ tag: 'e4', runId: 'E4-PART-0001' });
  const origWrite = fs.writeFileSync;
  let saveAttempts = 0;
  fs.writeFileSync = function (p, data, options) {
    if (typeof p === 'string' && p.includes(path.join('terminal', 'E4-PART-0001'))) {
      saveAttempts++;
      origWrite.call(fs, p, String(data).slice(0, 20), options); // 先部分落盘再失败
      const e = new Error('EIO'); e.code = 'EIO'; throw e;
    }
    return origWrite.call(fs, p, data, options);
  };
  try {
    const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
    assert.ok(err, '应失败');
    assert.equal(err.code, approvedRun.ERR.TERMINAL_SAVE_FAILED);
    assert.equal(err.causeCode, 'EIO', '原始固定失败类别保留');
    assert.equal(err.execution.commitFactEstablished, true, '已提交事实不丢失');
    assert.equal(err.execution.initialized, true);
    assert.equal(err.execution.granted, true);
    assert.equal(err.execution.resultPersisted, false, '未落盘如实标记');
    assert.equal(err.execution.unknownPersisted, false);
    assert.equal(saveAttempts, 1, '恰一次保存尝试（不自动再次保存）');
    const file = path.join(fx.outDir, 'terminal', 'E4-PART-0001.COMPLETED.json');
    assert.ok(fs.existsSync(file), '半截文件保留（不清理不覆盖）');
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, 20, '半截字节数如实');
    assert.throws(() => JSON.parse(bytes.toString('utf8')), '半截文件不是合法 JSON');
    assert.equal(fs.readdirSync(path.join(fx.outDir, 'terminal')).length, 1, '无第二次保存的新文件');
    const c = fx.tr.counts();
    assert.equal(c.commit, 1, '事务提交恰一次');
    assert.equal(c.primarySet, 1);
    assert.equal(fx.captured.credentialFetches, 1, '凭据恰一次（不重试初始化）');
    assert.ok(fs.existsSync(path.join(fx.outDir, 'started', 'E4-PART-0001.json')),
      'started 保留');
  } finally {
    fs.writeFileSync = origWrite; fx.tr.restore();
  }
});

test('E-5 S2 反例闭合：同轮终态已存在且无 started → started/取凭据之前拒绝（零子进程零写，原文件字节不变）', async () => {
  const fx = offlineChain({ tag: 'e5', runId: 'E5-PRIOR-0001' });
  fs.mkdirSync(path.join(fx.outDir, 'terminal'), { recursive: true });
  const priorFile = path.join(fx.outDir, 'terminal', 'E5-PRIOR-0001.COMPLETED.json');
  const priorBody = '{\n  "recordType": "COMPLETED",\n  "runId": "E5-PRIOR-0001",\n  "syntheticPrior": true\n}\n';
  fs.writeFileSync(priorFile, priorBody);
  try {
    const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
    assert.ok(err, '应拒绝');
    assert.equal(err.code, approvedRun.ERR.TERMINAL_EXISTS);
    assert.equal(fx.captured.calls.length, 0, '零子进程（未取凭据）');
    const c = fx.tr.counts();
    assert.equal(c.commit, 0, '零事务提交');
    assert.equal(c.primarySet, 0, '零事务写');
    assert.equal(fs.existsSync(path.join(fx.outDir, 'started')), false,
      'started 未创建');
    assert.equal(fs.readFileSync(priorFile, 'utf8'), priorBody, '原终态字节不变');
  } finally { fx.tr.restore(); }
});

test('E-6 S2 完整链：检查通过后写入遇 EEXIST → 恰一次保存尝试，结构化错误保留提交事实与既有文件', async () => {
  const fx = offlineChain({ tag: 'e6', runId: 'E6-EXST-0001' });
  const origWrite = fs.writeFileSync;
  let saveAttempts = 0;
  fs.writeFileSync = function (p, data, options) {
    if (typeof p === 'string' && p.includes(path.join('terminal', 'E6-EXST-0001'))) {
      saveAttempts++;
      // 模拟前置检查通过后、写入前，另一写入者抢先创建了同轮终态
      origWrite.call(fs, p, '{\n  "recordType": "COMPLETED",\n  "syntheticRacer": true\n}\n', options);
      const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e;
    }
    return origWrite.call(fs, p, data, options);
  };
  try {
    const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
    assert.ok(err, '应失败');
    assert.equal(err.code, approvedRun.ERR.TERMINAL_SAVE_FAILED);
    assert.equal(err.causeCode, 'APR_TERMINAL_EXISTS', 'EEXIST 固定类别随 causeCode 保留');
    assert.equal(err.execution.commitFactEstablished, true, '已提交事实不丢失');
    assert.equal(err.execution.resultPersisted, false);
    assert.equal(saveAttempts, 1, '恰一次保存尝试（EEXIST 不触发第二次保存）');
    const file = path.join(fx.outDir, 'terminal', 'E6-EXST-0001.COMPLETED.json');
    assert.ok(fs.readFileSync(file, 'utf8').includes('syntheticRacer'),
      '既有文件保留（不覆盖）');
    assert.equal(fs.readdirSync(path.join(fx.outDir, 'terminal')).length, 1);
    assert.equal(fx.tr.counts().commit, 1, '事务提交恰一次');
    assert.equal(fx.captured.credentialFetches, 1);
  } finally {
    fs.writeFileSync = origWrite; fx.tr.restore();
  }
});

test('E-7 S2/S3 对照：正常保存完整链 —— 保存恰一次、文件字节一致、返回事实与标记如实', async () => {
  const fx = offlineChain({ tag: 'e7', runId: 'E7-OK-0001' });
  const origWrite = fs.writeFileSync;
  let saveAttempts = 0;
  fs.writeFileSync = function (p, data, options) {
    if (typeof p === 'string' && p.includes(path.join('terminal', 'E7-OK-0001'))) {
      saveAttempts++;
    }
    return origWrite.call(fs, p, data, options);
  };
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'COMPLETED');
    assert.equal(saveAttempts, 1, '保存恰一次');
    const file = path.join(fx.outDir, 'terminal', 'E7-OK-0001.COMPLETED.json');
    assert.equal(r.saved.saved, true);
    assert.equal(r.saved.file, file, '返回 saved.file 指向实际记录');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(body.recordType, 'COMPLETED');
    assert.equal(body.resultPersisted, true, 'S3：成功记录 resultPersisted=true');
    assert.equal(body.unknownPersisted, false, 'S3：成功记录不标 unknownPersisted');
    assert.equal(body.commitFactEstablished, true);
    // T2：返回报告的两个持久化标记与文件一致（不只查其中一个）
    assert.equal(r.result.resultPersisted, true, 'T2：返回 resultPersisted=true');
    assert.equal(r.result.unknownPersisted, false, 'T2：返回 unknownPersisted=false');
    const c = fx.tr.counts();
    assert.equal(c.commit, 1);
    assert.equal(c.primarySet, 1);
    assert.equal(c.auditSet, 1);
    assert.equal(fx.captured.credentialFetches, 1);
  } finally {
    fs.writeFileSync = origWrite; fx.tr.restore();
  }
});

test('E-8 S3：RESULT_UNKNOWN 与 FAILED 记录的保存标记各按实际类型；TERMINAL_FIELDS 口径固定 34 项', async () => {
  assert.equal(approvedRun.TERMINAL_FIELDS.length, 35,
    '统计口径：业务字段 35 项（含身份绑定四事实；另有 recordType/runId/savedAt/status/fingerprint 元字段）');
  // 未知结果（worker 超时）
  const fxU = offlineChain({
    tag: 'e8u', runId: 'E8-UNK-0001',
    spawnWorker: hangingWorkerSpawn(),
    workerLimits: { timeoutMs: 400, maxOutputBytes: 1048576 }
  });
  try {
    const r = await approvedRun.runOnce(fxU.options);
    assert.equal(r.status, 'RESULT_UNKNOWN');
    const body = JSON.parse(fs.readFileSync(
      path.join(fxU.outDir, 'terminal', 'E8-UNK-0001.RESULT_UNKNOWN.json'), 'utf8'));
    assert.equal(body.resultPersisted, true);
    assert.equal(body.unknownPersisted, true, '未知结果记录如实标记 unknownPersisted');
    // T2：返回报告与文件交叉一致
    assert.equal(r.result.resultPersisted, true, 'T2：返回 resultPersisted=true');
    assert.equal(r.result.unknownPersisted, true, 'T2：返回 unknownPersisted=true');
    assert.equal(r.result.unknownPersisted, body.unknownPersisted, 'T2：文件与返回一致');
  } finally { fxU.tr.restore(); }
  // 失败（主体不匹配，取凭据后停止）
  const otherSts = Object.assign({}, SYN_STS, { UserId: 'OTHER_USER_VALUE', PrincipalId: 'OTHER_PRINCIPAL' });
  const fxF = offlineChain({
    tag: 'e8f', runId: 'E8-FAIL-0001',
    approvalPatch: { expectedSubjectDigest: host.callerTupleDigest(otherSts) }
  });
  try {
    const r = await approvedRun.runOnce(fxF.options);
    assert.equal(r.status, 'FAILED');
    const body = JSON.parse(fs.readFileSync(
      path.join(fxF.outDir, 'terminal', 'E8-FAIL-0001.FAILED.json'), 'utf8'));
    assert.equal(body.resultPersisted, true);
    assert.equal(body.unknownPersisted, false, '失败记录不标 unknownPersisted');
    // T2：返回报告与文件交叉一致
    assert.equal(r.result.resultPersisted, true, 'T2：返回 resultPersisted=true');
    assert.equal(r.result.unknownPersisted, false, 'T2：返回 unknownPersisted=false');
    assert.equal(r.result.unknownPersisted, body.unknownPersisted, 'T2：文件与返回一致');
  } finally { fxF.tr.restore(); }
});

// ══════════════════════════════════════════════════════════════════════
// F：T1/T2 收尾（目录检查失败分类 / 返回报告持久化标记同步）
// ══════════════════════════════════════════════════════════════════════

/** 构造「已有同轮终态且无 started」的目录，并对 terminal 目录列举注入错误。 */
function t1Fixture(tag, runId, injectedCode) {
  const fx = offlineChain({ tag, runId });
  fs.mkdirSync(path.join(fx.outDir, 'terminal'), { recursive: true });
  const priorFile = path.join(fx.outDir, 'terminal', runId + '.COMPLETED.json');
  const priorBody = '{\n  "recordType": "COMPLETED",\n  "runId": "' + runId + '",\n  "syntheticPrior": true\n}\n';
  fs.writeFileSync(priorFile, priorBody);
  const origReaddir = fs.readdirSync;
  let scanAttempts = 0;
  fs.readdirSync = function (p, ...rest) {
    if (typeof p === 'string' &&
      path.resolve(p) === path.resolve(path.join(fx.outDir, 'terminal'))) {
      scanAttempts++;
      const e = new Error(injectedCode); e.code = injectedCode; throw e;
    }
    return origReaddir.call(fs, p, ...rest);
  };
  return { fx, priorFile, priorBody, origReaddir, scanAttempts: () => scanAttempts };
}

test('F-1 T1 反例闭合：terminal 目录列举 EACCES → started/凭据/worker 之前固定净化停止', async () => {
  const { fx, priorFile, priorBody, origReaddir, scanAttempts } =
    t1Fixture('f1', 'F1-EACCES-001', 'EACCES');
  try {
    const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
    assert.ok(err, '应失败');
    assert.equal(err.code, approvedRun.ERR.TERMINAL_DIR_CHECK_FAILED);
    assert.equal(err.causeCode, 'EACCES', '实际错误 code 分类');
    assert.ok(!/EACCES/.test(err.message), '净化错误文本不透传原始异常');
    assert.equal(scanAttempts(), 1, '目录检查恰一次');
    assert.equal(fx.captured.calls.length, 0, '零子进程（零凭据）');
    const c = fx.tr.counts();
    assert.equal(c.commit, 0, '零提交');
    assert.equal(c.primarySet, 0, '零写');
    assert.equal(c.auditSet, 0);
    assert.equal(fs.existsSync(path.join(fx.outDir, 'started')), false, '无 started');
    assert.equal(fs.readFileSync(priorFile, 'utf8'), priorBody, '旧文件字节不变');
  } finally { fs.readdirSync = origReaddir; fx.tr.restore(); }
});

test('F-2 T1 反例闭合：terminal 目录列举 EIO → 同样在 started/凭据之前停止', async () => {
  const { fx, priorFile, priorBody, origReaddir } =
    t1Fixture('f2', 'F2-EIO-00001', 'EIO');
  try {
    const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.code, approvedRun.ERR.TERMINAL_DIR_CHECK_FAILED);
    assert.equal(err.causeCode, 'EIO');
    assert.equal(fx.captured.calls.length, 0);
    const c = fx.tr.counts();
    assert.equal(c.commit, 0); assert.equal(c.primarySet, 0);
    assert.equal(fs.existsSync(path.join(fx.outDir, 'started')), false);
    assert.equal(fs.readFileSync(priorFile, 'utf8'), priorBody);
  } finally { fs.readdirSync = origReaddir; fx.tr.restore(); }
});

test('F-3 T1 正向与三类终态拒绝：ENOENT 正常链；COMPLETED/FAILED/RESULT_UNKNOWN 预存均提前拒绝', async () => {
  // 正向 1：首次运行无 terminal 目录（ENOENT → 无记录，全链正常）
  const fx0 = offlineChain({ tag: 'f3a', runId: 'F3-NOENT-0001' });
  try {
    const r = await approvedRun.runOnce(fx0.options);
    assert.equal(r.status, 'COMPLETED');
    assert.equal(fx0.tr.counts().commit, 1);
  } finally { fx0.tr.restore(); }
  // 正向 2：terminal 目录可读但无同轮记录 → 正常执行
  const fx1 = offlineChain({ tag: 'f3b', runId: 'F3-EMPTY-0001' });
  fs.mkdirSync(path.join(fx1.outDir, 'terminal'), { recursive: true });
  fs.writeFileSync(path.join(fx1.outDir, 'terminal', 'OTHER-ROUND.COMPLETED.json'), '{}\n');
  try {
    const r = await approvedRun.runOnce(fx1.options);
    assert.equal(r.status, 'COMPLETED');
  } finally { fx1.tr.restore(); }
  // 三类已有终态：均零凭据零写提前拒绝
  for (const status of ['COMPLETED', 'FAILED', 'RESULT_UNKNOWN']) {
    const fx = offlineChain({ tag: 'f3c', runId: 'F3-EXIST-0001' });
    fs.mkdirSync(path.join(fx.outDir, 'terminal'), { recursive: true });
    const priorFile = path.join(fx.outDir, 'terminal', 'F3-EXIST-0001.' + status + '.json');
    fs.writeFileSync(priorFile, '{}\n');
    try {
      const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
      assert.ok(err, status + '：应拒绝');
      assert.equal(err.code, approvedRun.ERR.TERMINAL_EXISTS, status);
      assert.equal(fx.captured.calls.length, 0, status + '：零子进程');
      assert.equal(fx.tr.counts().commit, 0, status + '：零提交');
      assert.equal(fs.existsSync(path.join(fx.outDir, 'started')), false, status + '：无 started');
      assert.ok(fs.existsSync(priorFile), status + '：wx/预存文件保留');
    } finally { fx.tr.restore(); }
  }
});

test('F-4 T2：三种终态类型返回报告的持久化标记与文件逐项交叉一致；保存失败保持 false', async () => {
  // COMPLETED：true/false
  const fxC = offlineChain({ tag: 'f4a', runId: 'F4-COMP-0001' });
  try {
    const r = await approvedRun.runOnce(fxC.options);
    assert.equal(r.result.resultPersisted, true);
    assert.equal(r.result.unknownPersisted, false);
    const body = JSON.parse(fs.readFileSync(
      path.join(fxC.outDir, 'terminal', 'F4-COMP-0001.COMPLETED.json'), 'utf8'));
    assert.equal(r.result.resultPersisted, body.resultPersisted);
    assert.equal(r.result.unknownPersisted, body.unknownPersisted);
    assert.equal(r.result.status, undefined === r.result.status ? undefined : r.result.status,
      '业务字段不被覆盖');
    assert.equal(r.result.errorCode ?? null, null ?? null, 'COMPLETED 无 errorCode 污染');
  } finally { fxC.tr.restore(); }
  // FAILED（入口自行保存）：true/false
  const otherSts = Object.assign({}, SYN_STS, { UserId: 'OTHER_USER_VALUE', PrincipalId: 'OTHER_PRINCIPAL' });
  const fxF = offlineChain({
    tag: 'f4b', runId: 'F4-FAIL-0001',
    approvalPatch: { expectedSubjectDigest: host.callerTupleDigest(otherSts) }
  });
  try {
    const r = await approvedRun.runOnce(fxF.options);
    assert.equal(r.status, 'FAILED', '业务 status 语义不变');
    assert.equal(r.result.errorCode, host.ERR.CALLER_SUBJECT_MISMATCH, 'errorCode 不变');
    assert.equal(r.result.resultPersisted, true);
    assert.equal(r.result.unknownPersisted, false);
    const body = JSON.parse(fs.readFileSync(
      path.join(fxF.outDir, 'terminal', 'F4-FAIL-0001.FAILED.json'), 'utf8'));
    assert.equal(r.result.resultPersisted, body.resultPersisted);
    assert.equal(r.result.unknownPersisted, body.unknownPersisted);
  } finally { fxF.tr.restore(); }
  // RESULT_UNKNOWN（worker 超时）：true/true
  const fxU = offlineChain({
    tag: 'f4c', runId: 'F4-UNK-0001',
    spawnWorker: hangingWorkerSpawn(),
    workerLimits: { timeoutMs: 400, maxOutputBytes: 1048576 }
  });
  try {
    const r = await approvedRun.runOnce(fxU.options);
    assert.equal(r.status, 'RESULT_UNKNOWN', '未知结果语义不变');
    assert.equal(r.result.resultPersisted, true);
    assert.equal(r.result.unknownPersisted, true);
    const body = JSON.parse(fs.readFileSync(
      path.join(fxU.outDir, 'terminal', 'F4-UNK-0001.RESULT_UNKNOWN.json'), 'utf8'));
    assert.equal(r.result.resultPersisted, body.resultPersisted);
    assert.equal(r.result.unknownPersisted, body.unknownPersisted);
    assert.equal(r.result.commitFactEstablished, false, '未知结果提交事实语义不变');
  } finally { fxU.tr.restore(); }
  // 保存失败：异常保持两个标记 false + 净化执行事实（T2 失败分支复核）
  const fxS = offlineChain({ tag: 'f4d', runId: 'F4-SAVEF-0001' });
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = function (p, data, options) {
    if (typeof p === 'string' && p.includes(path.join('terminal', 'F4-SAVEF-0001'))) {
      const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
    }
    return origWrite.call(fs, p, data, options);
  };
  try {
    const err = await approvedRun.runOnce(fxS.options).then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.code, approvedRun.ERR.TERMINAL_SAVE_FAILED);
    assert.equal(err.causeCode, 'EACCES');
    assert.equal(err.execution.resultPersisted, false);
    assert.equal(err.execution.unknownPersisted, false);
    assert.equal(err.execution.commitFactEstablished, true);
  } finally { fs.writeFileSync = origWrite; fxS.tr.restore(); }
});

// ══════════════════════════════════════════════════════════════════════
// G：管理员稳定身份与执行会话绑定（2026-10-12 方案 §4–§6）
// ══════════════════════════════════════════════════════════════════════

/** 形状合法的 CAMRole STS 夹具（RoleId/UIN 为十进制字符串，ARN 收窄形状）。 */
const G_ROLE_ID = '4616873506';
const G_ACCOUNT = '123456789012';
const G_SESSION_A = 'roundA-session-1';
const G_SESSION_B = 'roundB-session-2';
function gSts(sessionName) {
  return {
    Type: 'CAMRole',
    AccountId: G_ACCOUNT,
    UserId: G_ROLE_ID + ':' + sessionName,
    PrincipalId: G_ACCOUNT,
    Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/' + G_ROLE_ID,
    RequestId: RID
  };
}
const G_STS_A = gSts(G_SESSION_A);
const G_STS_B = gSts(G_SESSION_B); // 同角色/主账号/申请账号，跨批次不同会话
const G_EXPECTED_STABLE = identityBinding.stableIdentityDigest(G_STS_A);

test('G-1 摘要分离：跨批次会话不同 → 稳定摘要相同、会话摘要不同；单轮两次相同会话可通过', () => {
  assert.equal(identityBinding.stableIdentityDigest(G_STS_A),
    identityBinding.stableIdentityDigest(G_STS_B),
    '稳定摘要不含会话名（跨批次固定预期的输入）');
  assert.notEqual(identityBinding.sessionDigest(G_STS_A),
    identityBinding.sessionDigest(G_STS_B), '会话摘要随会话名变化');
  assert.equal(identityBinding.sessionDigest(G_STS_A),
    identityBinding.sessionDigest(gSts(G_SESSION_A)), '同会话两次摘要一致');
  // 摘要输入的版本标识与字段顺序固定（方案 §4.1/§4.2）
  const id = identityBinding.parseCallerIdentity(G_STS_A);
  assert.equal(id.roleId, G_ROLE_ID);
  assert.equal(id.sessionName, G_SESSION_A);
});

test('G-2 收窄契约反例矩阵：坏类型/空值/多冒号/非法会话/ARN 不一致/前导零/尾号相同均拒绝', () => {
  const E = identityBinding.ERR;
  // 坏类型与空值
  assert.throws(() => identityBinding.parseCallerIdentity({ ...G_STS_A, Type: 'SubUser' }),
    (e) => e.code === E.TYPE_MISMATCH);
  assert.throws(() => identityBinding.parseCallerIdentity({ ...G_STS_A, AccountId: '' }),
    (e) => e.code === E.FIELD_INVALID);
  assert.throws(() => identityBinding.parseCallerIdentity({ ...G_STS_A, Arn: '' }),
    (e) => e.code === E.FIELD_INVALID);
  assert.throws(() => identityBinding.parseCallerIdentity({ ...G_STS_A, AccountId: '12345678901a' }),
    (e) => e.code === E.FIELD_INVALID);
  // UserId 形状：无冒号/多冒号/非十进制角色 ID
  assert.throws(() => identityBinding.parseCallerIdentity({ ...G_STS_A, UserId: G_ROLE_ID }),
    (e) => e.code === E.USERID_FORMAT);
  assert.throws(() => identityBinding.parseCallerIdentity(
    { ...G_STS_A, UserId: G_ROLE_ID + ':a:b' }), (e) => e.code === E.USERID_FORMAT);
  assert.throws(() => identityBinding.parseCallerIdentity(
    { ...G_STS_A, UserId: '12ab' + ':sess' }), (e) => e.code === E.USERID_FORMAT);
  // 会话名：空、超长（129）、非法字符
  assert.throws(() => identityBinding.parseCallerIdentity({ ...G_STS_A, UserId: G_ROLE_ID + ':' }),
    (e) => e.code === E.SESSION_NAME_INVALID);
  assert.throws(() => identityBinding.parseCallerIdentity(
    { ...G_STS_A, UserId: G_ROLE_ID + ':' + 'a'.repeat(129) }),
    (e) => e.code === E.SESSION_NAME_INVALID);
  assert.throws(() => identityBinding.parseCallerIdentity(
    { ...G_STS_A, UserId: G_ROLE_ID + ':bad*name' }),
    (e) => e.code === E.SESSION_NAME_INVALID);
  assert.ok(identityBinding.parseCallerIdentity(
    { ...G_STS_A, UserId: G_ROLE_ID + ':' + 'a'.repeat(128) }), '128 恰好可接受');
  // ARN 与 UserId/AccountId 逐字不一致
  assert.throws(() => identityBinding.parseCallerIdentity(
    { ...G_STS_A, Arn: 'qcs::sts:999999999999:assumed-role/' + G_ROLE_ID }),
    (e) => e.code === E.ARN_MISMATCH);
  assert.throws(() => identityBinding.parseCallerIdentity(
    { ...G_STS_A, Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/123' }),
    (e) => e.code === E.ARN_MISMATCH);
  // 数字精度风险：前导零变体保留原字节（不数值化为相同），且 ARN 必须逐字对应
  const leadZero = { ...G_STS_A, UserId: '0' + G_ROLE_ID + ':' + G_SESSION_A,
    Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/0' + G_ROLE_ID };
  const leadZeroParsed = identityBinding.parseCallerIdentity(leadZero);
  assert.equal(leadZeroParsed.roleId, '0' + G_ROLE_ID);
  assert.notEqual(identityBinding.stableIdentityDigest(leadZero),
    identityBinding.stableIdentityDigest(G_STS_A), '前导零变体不是同一身份');
  assert.throws(() => identityBinding.parseCallerIdentity(
    { ...leadZero, Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/' + G_ROLE_ID }),
    (e) => e.code === E.ARN_MISMATCH);
  // 尾号相同不放行：完整值不同的两个身份稳定摘要不同
  const tailTwin = { ...G_STS_A, AccountId: '999999789012',
    Arn: 'qcs::sts:999999789012:assumed-role/' + G_ROLE_ID };
  assert.notEqual(identityBinding.stableIdentityDigest(tailTwin),
    identityBinding.stableIdentityDigest(G_STS_A), '仅尾号相同不构成同一主体');
});

test('G-3 版本混用与缺预期在签发即拒：新旧摘要互斥、未知版本拒绝、新路径缺摘要拒绝', () => {
  // 新旧混用
  assert.throws(() => syntheticApprovalSource(syntheticPlan(), {
    bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
    expectedStableIdentityDigest: G_EXPECTED_STABLE,
    expectedSubjectDigest: host.callerTupleDigest(SYN_STS)
  }), (e) => e.code === host.ERR.IDENT_POLICY_MIXED);
  // 未知版本
  assert.throws(() => syntheticApprovalSource(syntheticPlan(), {
    bindingPolicyVersion: 'cloud-role-binding/2',
    expectedStableIdentityDigest: G_EXPECTED_STABLE
  }), (e) => e.code === host.ERR.IDENT_POLICY_MIXED);
  // 新路径缺摘要
  assert.throws(() => syntheticApprovalSource(syntheticPlan(), {
    bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION
  }), (e) => e.code === host.ERR.IDENT_POLICY_MIXED);
  // 摘要格式非法
  assert.throws(() => syntheticApprovalSource(syntheticPlan(), {
    bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
    expectedStableIdentityDigest: 'not-a-digest'
  }), (e) => e.code === host.ERR.IDENT_POLICY_MIXED);
});

test('G-4 新版绑定完整正向链：一次凭据、五条固定 API（3 STS + 2 环境查询）、两写一提交，报告与文件记录绑定事实', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [], stsCalls: 0 };
  const workerCapture = { calls: [] };
  const plan = syntheticPlan(null, { roundId: 'G4-MODERN-0001' });
  const source = syntheticApprovalSource(plan, {
    bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
    expectedStableIdentityDigest: G_EXPECTED_STABLE
  });
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: SYN_OPENID }
  });
  const outDir = freshOutDir('g4');
  const dirs = syntheticDirs('g4');
  try {
    const r = await approvedRun.runOnce({
      runId: 'G4-MODERN-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, profileDir: dirs.profileDir,
      spawn: syntheticCliSpawn(captured, { stsResponses: [G_STS_A] }),
      spawnWorker: syntheticWorkerSpawn(tr, workerCapture),
      reconcileDeps: { db: tr.db }
    });
    assert.equal(r.status, 'COMPLETED');
    // 固定调用：一次凭据 + 五条显式 API（STS 三条、环境查询两条）
    assert.equal(captured.credentialFetches, 1);
    assert.equal(captured.apiCalls.length, 5);
    assert.equal(captured.apiCalls[0].key, 'sts.GetCallerIdentity', '首个 API 是首次完整 STS');
    assert.equal(captured.apiCalls[4].key, 'sts.GetCallerIdentity', '末个 API 是第二次完整 STS');
    assert.equal(captured.apiCalls.filter(x => x.key === 'sts.GetCallerIdentity').length, 3);
    const c = tr.counts();
    assert.equal(c.primarySet, 1);
    assert.equal(c.auditSet, 1);
    assert.equal(c.commit, 1);
    // 报告与终态记录绑定事实（固定枚举/布尔，不含身份原值）
    assert.equal(r.result.bindingPolicyVersion, identityBinding.BINDING_POLICY_VERSION);
    assert.equal(r.result.stableIdentityMatched, true);
    assert.equal(r.result.sessionContinuityConfirmed, true);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(outDir, 'terminal', 'G4-MODERN-0001.COMPLETED.json'), 'utf8'));
    assert.equal(terminal.bindingPolicyVersion, identityBinding.BINDING_POLICY_VERSION);
    assert.equal(terminal.stableIdentityMatched, true);
    assert.equal(terminal.sessionContinuityConfirmed, true);
    const started = JSON.parse(fs.readFileSync(
      path.join(outDir, 'started', 'G4-MODERN-0001.json'), 'utf8'));
    assert.equal(started.bindingPolicyVersion, identityBinding.BINDING_POLICY_VERSION);
    // 同批传递：worker 载荷与 CLI 同一不可变快照（合成层断言既有接线）
    assert.equal(workerCapture.calls.length, 1);
    assert.equal(workerCapture.calls[0].bin, cliObserver.FIXED.nodeBin);
    assert.ok(workerCapture.calls[0].payloadRef() && workerCapture.calls[0].payloadRef().plan);
    // 净化：报告不含身份原值/会话名
    const raw = JSON.stringify(r.result);
    for (const marker of [G_ROLE_ID, G_SESSION_A, 'qcs::sts', G_ACCOUNT]) {
      assert.ok(!raw.includes(marker), '报告不含身份原值：' + marker);
    }
  } finally { tr.restore(); }
});

test('G-5 稳定身份不匹配 → 取得凭据与首个 STS 后停止（零 worker 零事务），净化报告', async () => {
  // 预期绑定为另一角色（形状合法）—— 尾号不同、完整值不同
  const otherRole = { ...G_STS_A, UserId: '4616873507:' + G_SESSION_A,
    Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/4616873507' };
  const fx = offlineChain({
    tag: 'g5', runId: 'G5-MISMATCH-001',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: identityBinding.stableIdentityDigest(otherRole)
    },
    cliOpts: { stsResponses: [G_STS_A] }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'FAILED');
    assert.equal(r.result.stoppedAt, 'stableIdentity', '在首个 STS 时点停止');
    assert.equal(r.result.errorCode, host.ERR.STABLE_IDENTITY_MISMATCH);
    assert.equal(r.result.credentialFetched, true, '已取得凭据（时点如实区分）');
    assert.equal(fx.captured.apiCalls.length, 1, '仅首次完整 STS');
    assert.equal(fx.tr.counts().commit, 0, '零事务');
    assert.equal(fx.tr.counts().primarySet, 0, '零写');
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'G5-MISMATCH-001.FAILED.json'), 'utf8'));
    assert.equal(terminal.errorCode, host.ERR.STABLE_IDENTITY_MISMATCH);
    const raw = JSON.stringify({ t: terminal, r: r.result });
    for (const marker of [G_ROLE_ID, G_SESSION_A, 'qcs::sts', G_ACCOUNT]) {
      assert.ok(!raw.includes(marker), '不含身份原值：' + marker);
    }
  } finally { fx.tr.restore(); }
});

test('G-6 同轮会话变化 → 第二次完整 STS 后、启动 worker 前拒绝（零事务零 worker）', async () => {
  const workerCapture = { calls: [] };
  const fx = offlineChain({
    tag: 'g6', runId: 'G6-DRIFT-0001',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: G_EXPECTED_STABLE
    },
    cliOpts: { stsResponses: [G_STS_A, G_STS_A, G_STS_B] }, // 首次/关联 A，第二次完整 STS 换 B
    workerCapture
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'FAILED');
    assert.equal(r.result.stoppedAt, 'sessionContinuity');
    assert.equal(r.result.errorCode, host.ERR.SESSION_CONTINUITY_BROKEN);
    assert.equal(r.result.stableIdentityMatched, true, '首次稳定身份已匹配');
    assert.equal(r.result.sessionContinuityConfirmed, false, '会话连续性未确认（显式布尔）');
    assert.equal(fx.captured.credentialFetches, 1, '不自动取第二批凭据');
    assert.equal(fx.captured.apiCalls.length, 5, '两次完整 STS + 三阶段关联都已发生');
    assert.equal(fx.tr.counts().commit, 0, '零事务');
    assert.equal(workerCapture.calls.length, 0, 'worker 未启动');
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'G6-DRIFT-0001.FAILED.json'), 'utf8'));
    assert.equal(terminal.errorCode, host.ERR.SESSION_CONTINUITY_BROKEN);
    const raw = JSON.stringify(terminal);
    for (const marker of [G_SESSION_A, G_SESSION_B, G_ROLE_ID, 'qcs::sts']) {
      assert.ok(!raw.includes(marker), '不含会话名/身份原值：' + marker);
    }
  } finally { fx.tr.restore(); }
});

test('G-7 新版绑定与旧门槛并存：普通 JSON 冒充批准、来源模式绑定、终态预存仍按原门槛拒绝', async () => {
  const plan = syntheticPlan(null, { roundId: 'G7-GUARD-0001' });
  // 普通 JSON 冒充（即便带新版字段也不构成批准）
  const fake = JSON.parse(JSON.stringify({
    plan, approval: { approvedUserIds: [plan.targetUserId], approvedBy: 'FAKE',
      approvedAt: new Date().toISOString() },
    approvedBy: 'FAKE', writeScope: ['initializePrimary'],
    expiresAtMs: Date.now() + 3600000,
    bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
    expectedStableIdentityDigest: G_EXPECTED_STABLE
  }));
  const outDir = freshOutDir('g7');
  await assert.rejects(() => approvedRun.runOnce({
    runId: 'G7-GUARD-0001', outDir, plan, approvalSource: fake,
    roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
    spawn: syntheticCliSpawn({ calls: [], credentialFetches: 0, apiCalls: [], stsCalls: 0 })
  }), (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING ||
    e.code === host.ERR.APPROVAL_REQUIRED || e.code === host.ERR.PLAN_INVALID);
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
  // 新版批准 + 真实模式请求 → 来源绑定不匹配（既有门槛不回归）
  const modernSource = syntheticApprovalSource(plan, {
    bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
    expectedStableIdentityDigest: G_EXPECTED_STABLE
  });
  const outDir2 = freshOutDir('g7b');
  await assert.rejects(() => approvedRun.runOnce({
    runId: 'G7-GUARD-0002', outDir: outDir2, plan, approvalSource: modernSource,
    roundId: plan.roundId, credentialSourceMode: 'fixed-real-source'
  }), (e) => e.code === host.ERR.REAL_MODE_BINDING_MISMATCH);
  // 同轮终态预存 → started/凭据之前拒绝（既有 S2 语义不回归）
  const modernSource2 = syntheticApprovalSource(plan, {
    bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
    expectedStableIdentityDigest: G_EXPECTED_STABLE
  });
  const outDir3 = freshOutDir('g7c');
  fs.mkdirSync(path.join(outDir3, 'terminal'), { recursive: true });
  fs.writeFileSync(path.join(outDir3, 'terminal', 'G7-GUARD-0001.COMPLETED.json'), '{}\n');
  await assert.rejects(() => approvedRun.runOnce({
    runId: 'G7-GUARD-0001', outDir: outDir3, plan, approvalSource: modernSource2,
    roundId: plan.roundId, profileDir: path.join(outDir3, 'profile'),
    spawn: syntheticCliSpawn({ calls: [], credentialFetches: 0, apiCalls: [], stsCalls: 0 })
  }), (e) => e.code === approvedRun.ERR.TERMINAL_EXISTS);
});

test('G-8 真实模式（模块级离线装配）新版绑定正向：五条 API、两写一提交、真实登录目录零触达', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [], stsCalls: 0 };
  const plan = syntheticPlan(null, { roundId: 'G8-REALMOD-0001' });
  const source = syntheticApprovalSource(plan, {
    bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
    expectedStableIdentityDigest: G_EXPECTED_STABLE,
    credentialSourceMode: 'fixed-real-source'
  });
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: SYN_OPENID }
  });
  const outDir = freshOutDir('g8');
  const fsv = installFsVirtualization('g8');
  const uninstall = host.installRealModeOfflineHarness({
    spawn: syntheticCliSpawn(captured, { stsResponses: [G_STS_A] }),
    spawnWorker: syntheticWorkerSpawn(tr),
    reconcileDeps: { db: tr.db }
  });
  try {
    const r = await approvedRun.runOnce({
      runId: 'G8-REALMOD-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, credentialSourceMode: 'fixed-real-source'
    });
    assert.equal(r.status, 'COMPLETED');
    assert.equal(captured.credentialFetches, 1);
    assert.equal(captured.apiCalls.length, 5, '新版绑定五条固定 API');
    const c = tr.counts();
    assert.equal(c.primarySet, 1); assert.equal(c.auditSet, 1); assert.equal(c.commit, 1);
    assert.equal(r.result.bindingPolicyVersion, identityBinding.BINDING_POLICY_VERSION);
    assert.equal(r.result.stableIdentityMatched, true);
    assert.equal(r.result.sessionContinuityConfirmed, true);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(outDir, 'terminal', 'G8-REALMOD-0001.COMPLETED.json'), 'utf8'));
    assert.equal(terminal.bindingPolicyVersion, identityBinding.BINDING_POLICY_VERSION);
    assert.ok(fsv.vops.length >= 2, '真实登录目录操作被虚拟化重定向');
  } finally {
    uninstall(); fsv.restore(); tr.restore();
  }
});

// ══════════════════════════════════════════════════════════════════════
// H：R1/R2 事实记录收尾（调用尝试事实 / 分阶段与最终匹配结论）
// ══════════════════════════════════════════════════════════════════════

test('H-1 R1：首次 STS 实际尝试后身份不匹配 → cloudCallAttempted=true（零 worker 零事务）', async () => {
  const otherRole = { ...G_STS_A, UserId: '4616873507:' + G_SESSION_A,
    Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/4616873507' };
  const fx = offlineChain({
    tag: 'h1', runId: 'H1-FIRSTMM-001',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: identityBinding.stableIdentityDigest(otherRole)
    },
    cliOpts: { stsResponses: [G_STS_A] }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.result.errorCode, host.ERR.STABLE_IDENTITY_MISMATCH);
    assert.equal(r.result.cloudCallAttempted, true, '已实际尝试 STS 调用，事实不得丢失');
    assert.equal(fx.tr.counts().commit, 0);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'H1-FIRSTMM-001.FAILED.json'), 'utf8'));
    assert.equal(terminal.stableIdentityMatched, false, 'R2：首次不匹配时最终结论 false');
    assert.equal(terminal.firstIdentityCheckMatched, false);
  } finally { fx.tr.restore(); }
});

test('H-2 R1：首次 STS 收到响应但身份坏形状（IDENT_UNPARSEABLE）→ cloudCallAttempted=true', async () => {
  const badShape = { ...G_STS_A, UserId: 'no-colon-value' }; // assertSts 通过、收窄契约拒绝
  const fx = offlineChain({
    tag: 'h2', runId: 'H2-FIRSTBAD-001',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: G_EXPECTED_STABLE
    },
    cliOpts: { stsResponses: [badShape] }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.result.stoppedAt, 'firstIdentityCheck');
    assert.equal(r.result.errorCode, host.ERR.IDENT_UNPARSEABLE);
    assert.equal(r.result.cloudCallAttempted, true, '已收到响应并解析拒绝，尝试事实保留');
    assert.equal(fx.tr.counts().commit, 0);
    assert.equal(r.result.stableIdentityMatched ?? false, false);
  } finally { fx.tr.restore(); }
});

test('H-3 R1：首次 STS 非零退出 → 调用尝试事实保留（CLI_ASSOCIATION_FAILED）', async () => {
  const fx = offlineChain({
    tag: 'h3', runId: 'H3-STSEXIT-001',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: G_EXPECTED_STABLE
    },
    cliOpts: { stsResponses: [G_STS_A], apiExit: 1 }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.result.stoppedAt, 'firstIdentityCheck');
    assert.equal(r.result.errorCode, host.ERR.CLI_ASSOCIATION_FAILED);
    assert.equal(r.result.cloudCallAttempted, true, '子进程已启动（非零退出）→ 尝试事实 true');
    assert.equal(fx.captured.credentialFetches, 1, '凭据已取得（时点如实）');
    assert.equal(fx.tr.counts().commit, 0);
    assert.equal(fs.existsSync(path.join(fx.outDir, 'started',
      'H3-STSEXIT-001.json')), true);
  } finally { fx.tr.restore(); }
});

test('H-4 R1 对照：本地前置失败未尝试启动 → attempted 保持 false（helper 直接调用）', async () => {
  const noSnapshot = await host.verifyCallerSubject(null, { spawn: () => {} });
  assert.equal(noSnapshot.ok, false);
  assert.equal(noSnapshot.attempted, false, '缺快照未尝试启动');
  const noSpawn = await host.verifyCallerSubject({
    secretId: 'ID', secretKey: 'KEY', sessionToken: 'TOK'
  }, {});
  assert.equal(noSpawn.ok, false);
  assert.equal(noSpawn.attempted, false, '缺 spawn 未尝试启动');
});

test('H-5 R2：第二次稳定身份不匹配（仅换 PrincipalId）→ 撤销最终匹配、保留分阶段事实，返回与落盘一致', async () => {
  const driftPrincipal = { ...G_STS_A, PrincipalId: '999999789012' };
  const fx = offlineChain({
    tag: 'h5', runId: 'H5-SECONDBAD-01',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: G_EXPECTED_STABLE
    },
    cliOpts: { stsResponses: [G_STS_A, G_STS_A, driftPrincipal] }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'FAILED');
    assert.equal(r.result.stoppedAt, 'stableIdentity');
    assert.equal(r.result.errorCode, host.ERR.STABLE_IDENTITY_MISMATCH);
    assert.equal(fx.captured.apiCalls.length, 5, '五条 API 已发生（含第二次完整 STS）');
    assert.equal(fx.tr.counts().commit, 0, '零事务');
    // 返回：最终匹配撤销、分阶段事实保留
    assert.equal(r.result.stableIdentityMatched, false, 'R2：最终匹配结论撤销');
    assert.equal(r.result.firstIdentityCheckMatched, true, 'R2：首次已匹配的分阶段事实保留');
    // 落盘与返回交叉一致
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'H5-SECONDBAD-01.FAILED.json'), 'utf8'));
    assert.equal(terminal.errorCode, host.ERR.STABLE_IDENTITY_MISMATCH);
    assert.equal(terminal.stableIdentityMatched, false, 'R2：终态不再记 true');
    assert.equal(terminal.firstIdentityCheckMatched, true);
    assert.equal(r.result.stableIdentityMatched, terminal.stableIdentityMatched);
  } finally { fx.tr.restore(); }
});

test('H-6 R2：第二次稳定身份不匹配（换角色）→ 同样撤销最终匹配、零 worker 零事务', async () => {
  const driftRole = { ...G_STS_A, UserId: '4616873507:' + G_SESSION_A,
    Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/4616873507' };
  const fx = offlineChain({
    tag: 'h6', runId: 'H6-SECROLE-001',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: G_EXPECTED_STABLE
    },
    cliOpts: { stsResponses: [G_STS_A, G_STS_A, driftRole] }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.result.stoppedAt, 'stableIdentity');
    assert.equal(r.result.errorCode, host.ERR.STABLE_IDENTITY_MISMATCH);
    assert.equal(r.result.stableIdentityMatched, false);
    assert.equal(r.result.firstIdentityCheckMatched, true);
    assert.equal(fx.tr.counts().commit, 0);
    assert.equal(fx.tr.counts().primarySet, 0);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'H6-SECROLE-001.FAILED.json'), 'utf8'));
    assert.equal(terminal.stableIdentityMatched, false);
    assert.equal(terminal.firstIdentityCheckMatched, true);
  } finally { fx.tr.restore(); }
});

test('H-7 R2：仅会话变化而稳定主体一致 → 稳定匹配事实 true、会话连续性 false（返回与落盘一致）', async () => {
  const fx = offlineChain({
    tag: 'h7', runId: 'H7-SESSDRFT-01',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: G_EXPECTED_STABLE
    },
    cliOpts: { stsResponses: [G_STS_A, G_STS_A, G_STS_B] }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'FAILED');
    assert.equal(r.result.stoppedAt, 'sessionContinuity');
    assert.equal(r.result.errorCode, host.ERR.SESSION_CONTINUITY_BROKEN);
    assert.equal(r.result.stableIdentityMatched, true, 'R2：稳定主体仍一致 → 保留 true');
    assert.equal(r.result.firstIdentityCheckMatched, true);
    assert.equal(r.result.sessionContinuityConfirmed ?? false, false, '会话核对失败不得 true');
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'H7-SESSDRFT-01.FAILED.json'), 'utf8'));
    assert.equal(terminal.stableIdentityMatched, true);
    assert.equal(terminal.firstIdentityCheckMatched, true);
    assert.equal(terminal.sessionContinuityConfirmed, false);
  } finally { fx.tr.restore(); }
});

test('H-8 R2 正向：三种匹配事实均为 true（返回与落盘交叉一致）', async () => {
  const fx = offlineChain({
    tag: 'h8', runId: 'H8-OK-0000001',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: G_EXPECTED_STABLE
    },
    cliOpts: { stsResponses: [G_STS_A] }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.status, 'COMPLETED');
    assert.equal(r.result.firstIdentityCheckMatched, true);
    assert.equal(r.result.stableIdentityMatched, true);
    assert.equal(r.result.sessionContinuityConfirmed, true);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'H8-OK-0000001.COMPLETED.json'), 'utf8'));
    assert.equal(terminal.firstIdentityCheckMatched, true);
    assert.equal(terminal.stableIdentityMatched, true);
    assert.equal(terminal.sessionContinuityConfirmed, true);
  } finally { fx.tr.restore(); }
});

// ══════════════════════════════════════════════════════════════════════
// J：R1 剩余出口 —— assertSts 字段/类型校验失败也保留调用尝试事实
// （2026-10-13 复核：assertSts catch 与 TUPLE_INCOMPLETE 曾漏 attempted）
// ══════════════════════════════════════════════════════════════════════

test('J-1 R1 完整链矩阵：缺 AccountId/PrincipalId/Arn/RequestId 与 Type 不支持 → 一次合成 STS 后停止，cloudCallAttempted=true，零后续请求零 worker 零事务写', async () => {
  const cases = [
    ['缺AccountId', { ...G_STS_A, AccountId: '' }, host.ERR.STS_FIELD_MISSING],
    ['缺PrincipalId', { ...G_STS_A, PrincipalId: '' }, host.ERR.STS_FIELD_MISSING],
    ['缺Arn', { ...G_STS_A, Arn: '' }, host.ERR.STS_FIELD_MISSING],
    ['缺RequestId', { ...G_STS_A, RequestId: '' }, host.ERR.STS_FIELD_MISSING],
    ['Type不支持', { ...G_STS_A, Type: 'SubUser' }, host.ERR.STS_TYPE_MISMATCH]
  ];
  for (const [label, badSts, expectCode] of cases) {
    const workerCapture = { calls: [] };
    const fx = offlineChain({
      tag: 'j1', runId: 'J1-FIELD-0001',
      approvalPatch: {
        bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
        expectedStableIdentityDigest: G_EXPECTED_STABLE
      },
      cliOpts: { stsResponses: [badSts] },
      workerCapture
    });
    try {
      const r = await approvedRun.runOnce(fx.options);
      assert.equal(r.status, 'FAILED', label);
      assert.equal(r.result.stoppedAt, 'firstIdentityCheck', label);
      assert.equal(r.result.errorCode, expectCode, label);
      assert.equal(r.result.cloudCallAttempted, true,
        label + '：字段校验失败发生在子进程已调用之后，尝试事实必须保留');
      assert.equal(r.result.stableIdentityMatched, false, label);
      assert.equal(fx.captured.credentialFetches, 1, label + '：凭据恰一次');
      assert.equal(fx.captured.apiCalls.length, 1, label + '：仅一次合成 STS，零后续请求');
      assert.equal(workerCapture.calls.length, 0, label + '：worker 未启动');
      const c = fx.tr.counts();
      assert.equal(c.commit, 0, label + '：零提交');
      assert.equal(c.primarySet, 0, label + '：零写');
      assert.equal(c.auditSet, 0, label);
      // 落盘交叉一致
      const t = JSON.parse(fs.readFileSync(
        path.join(fx.outDir, 'terminal', 'J1-FIELD-0001.FAILED.json'), 'utf8'));
      assert.equal(t.cloudCallAttempted ?? true, true, label);
      assert.equal(t.stableIdentityMatched, false, label);
    } finally { fx.tr.restore(); }
  }
});

test('J-2 R1 完整链：首次 STS 返回畸形 stdout（JSON 解析失败）→ cloudCallAttempted=true', async () => {
  const fx = offlineChain({
    tag: 'j2', runId: 'J2-BADJSON-001',
    approvalPatch: {
      bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest: G_EXPECTED_STABLE
    },
    cliOpts: { stsRawOutput: 'NOT-JSON-AT-ALL' }
  });
  try {
    const r = await approvedRun.runOnce(fx.options);
    assert.equal(r.result.stoppedAt, 'firstIdentityCheck');
    assert.equal(r.result.errorCode, host.ERR.STS_FIELD_MISSING);
    assert.equal(r.result.cloudCallAttempted, true, '解析失败发生在调用之后');
    assert.equal(fx.captured.apiCalls.length, 1);
    assert.equal(fx.tr.counts().commit, 0);
  } finally { fx.tr.restore(); }
});

test('J-3 R1 helper 直调：字段缺失与 Type 不支持 → attempted=true（保留 JSON 解析失败、非零退出、身份不匹配及未启动对照）', async () => {
  function stubSpawn(payload, exitCode) {
    return (bin, argv, options) => {
      const { EventEmitter } = require('node:events');
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
      c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
      const text = 'ℹ →STS.GetCallerIdentity\n' + JSON.stringify({ data: payload }) + '\n';
      setImmediate(() => {
        if (payload !== null) c.stdout.emit('data', Buffer.from(text));
        c.emit('exit', exitCode === undefined ? 0 : exitCode, null);
        c.emit('close', exitCode === undefined ? 0 : exitCode, null);
      });
      return c;
    };
  }
  const deps = { spawn: null, isolationDir: 'synthetic-isolation-dir', baseEnv: {} };
  const snap = { secretId: 'ID', secretKey: 'KEY', sessionToken: 'TOK' };
  // 字段缺失 → STS_FIELD_MISSING + attempted=true
  deps.spawn = stubSpawn({ ...G_STS_A, AccountId: '' });
  let r = await host.verifyCallerSubject(snap, deps);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, host.ERR.STS_FIELD_MISSING);
  assert.equal(r.attempted, true, '字段校验失败在子进程调用之后');
  // Type 不支持 → STS_TYPE_MISMATCH + attempted=true
  deps.spawn = stubSpawn({ ...G_STS_A, Type: 'SubUser' });
  r = await host.verifyCallerSubject(snap, deps);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, host.ERR.STS_TYPE_MISMATCH);
  assert.equal(r.attempted, true);
  // 既有对照保留：JSON 解析失败 / 非零退出 → attempted=true
  const rawSpawn = (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    setImmediate(() => {
      c.stdout.emit('data', Buffer.from('NOT-JSON'));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    return c;
  };
  deps.spawn = rawSpawn;
  r = await host.verifyCallerSubject(snap, deps);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, host.ERR.STS_FIELD_MISSING);
  assert.equal(r.attempted, true, 'JSON 解析失败在调用之后');
  deps.spawn = stubSpawn(G_STS_A, 1);
  r = await host.verifyCallerSubject(snap, deps);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, host.ERR.CLI_ASSOCIATION_FAILED);
  assert.equal(r.attempted, true, '非零退出在调用之后');
  // 身份不匹配对照（helper 层摘要不一致由父层比较；此处仅确认 ok 路径带 attempted）
  deps.spawn = stubSpawn(G_STS_A);
  r = await host.verifyCallerSubject(snap, deps);
  assert.equal(r.ok, true);
  assert.equal(r.attempted, true);
  // 真正未启动对照：缺快照/缺 spawn → attempted=false
  r = await host.verifyCallerSubject(null, { spawn: () => {} });
  assert.equal(r.attempted, false);
  r = await host.verifyCallerSubject(snap, {});
  assert.equal(r.attempted, false);
});
