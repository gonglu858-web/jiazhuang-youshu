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
  if (!('expectedSubjectDigest' in p)) {
    spec.expectedSubjectDigest = host.callerTupleDigest(SYN_STS);
  } else if (p.expectedSubjectDigest !== undefined) {
    spec.expectedSubjectDigest = p.expectedSubjectDigest;
  }
  return host.issueControlledApproval(spec);
}

function cliStdoutFor(service, action) {
  const key = service + '.' + action;
  const data = key === 'sts.GetCallerIdentity' ? SYN_STS
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
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
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

test('B-2 重复轮次：第二次运行不覆盖 started、不再写库、终态不新增', async () => {
  const fx = offlineChain({ tag: 'b2', runId: 'B2-DUP-0001' });
  try {
    const first = await approvedRun.runOnce(fx.options);
    assert.equal(first.status, 'COMPLETED');
    const startedBefore = fs.readFileSync(path.join(fx.outDir, 'started', 'B2-DUP-0001.json'));
    const terminalBefore = fs.readFileSync(path.join(fx.outDir, 'terminal', 'B2-DUP-0001.COMPLETED.json'));
    const writesBefore = fx.tr.counts();
    await assert.rejects(
      () => approvedRun.runOnce(fx.options),
      (e) => e.code === approvedRun.ERR.STARTED_EXISTS);
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
        assert.equal(e.causeCode, 'APR_TERMINAL_SAVE_FAILED',
          '内层保存失败的固定错误码如实保留');
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
