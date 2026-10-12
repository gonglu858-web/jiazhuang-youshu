#!/usr/bin/env node
/**
 * 证据脚本：首次管理员真实入口 R1–R5 定点返修（本地离线）
 * ======================================================
 *
 * 独立复现本轮返修的关键行为，直接断言修后/新增行为；
 * 新证据另存（独占名），历史证据不改写、不覆盖。
 *
 * 对应 docs/Codex复核-首次管理员真实入口最小接线-20261012.md：
 *  - R1 来源模式与批准绑定、真实模式执行依赖覆盖提前拒绝、
 *    模块级离线装配（installRealModeOfflineHarness）+ 文件系统虚拟化；
 *  - R2 入口自接排他 started 核对与终态保存（不依赖调用方回调）；
 *  - R3 入口指纹绑定（签发时读盘）与两处比较（取凭据前 / 启动 worker 前）；
 *  - R4 终态白名单投影完整保留事实；保存失败抛结构化错误不伪造成功；
 *  - R5 全程守卫（网络与真实子进程）+ 敏感性探针实测 + 真实登录目录零触达；
 *  - §7 文案更正：可本地判断的来源/轮次错误提前拒绝；主体摘要比较阶段如实。
 *
 * 层级如实标注：CLI 层替换 spawn；SDK 层替换 `@cloudbase/database` 的
 * `Db.reqClass` 并注入 db —— 真实 SDK 本地转换；平台行为未验证。
 * 不联网、不取真实凭据、不读真实认证内容、不初始化/写库、不部署。
 * 已知副作用：真实登录目录与 SDK 隔离根的文件操作全部经虚拟化重定向到
 * 一次性临时沙箱（本脚本内逐项验证重定向生效），真实目录零触达、不清理。
 */
'use strict';

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
    const e = new Error('证据全程守卫：禁止' + label + '（' + channel + '）');
    e.code = channel === 'cp' ? 'EV_CHILD_PROCESS_BLOCKED' : 'EV_NET_BLOCKED';
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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const host = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-execution-host.cjs'));
const worker = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-execution-worker.cjs'));
const p4 = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs'));
const approvedRun = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-approved-run.cjs'));
const cliObserver = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
const sdkObserver = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));

const REAL_AUTH_DIR = cliObserver.FIXED.authSessionDir;
const REAL_ISOLATION_ROOT = sdkObserver.FIXED.isolationRoot;
const ENTRY_FILE = host.ENTRY_FILE;
const ENTRY_ABS = path.join(path.dirname(require.resolve(
  path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-execution-host.cjs'))), ENTRY_FILE);
const SYN_OPENID = 'synthetic-offline-openid';
const SYN_TARGET = p4.deriveUserId(p4.FIXED_APP_ID, SYN_OPENID);
const SYN_ACCOUNT = '123456789012';
const RID = '00000000-0000-4000-8000-000000000001';

const report = {
  generatedAt: new Date().toISOString(),
  round: '首次管理员真实入口 R1–R5 定点返修',
  reviewBasis: 'docs/Codex复核-首次管理员真实入口最小接线-20261012.md',
  verificationKind: 'OFFLINE_CONTRACT_FIXTURE',
  layers: {
    cliSpawn: 'synthetic (injected)',
    sdkTransport: 'synthetic Db.reqClass + injected db; real sdk.init/database/serialization',
    platformVerified: false,
    realSdkLocalConversion: true
  },
  guards: {
    channels: Object.keys(GUARD_TOTALS),
    installedBeforeAppModules: true,
    note: '进程级不恢复；探针计数与业务意外尝试分离，意外 = 总数 − 探针。'
  },
  fsVirtualization: {
    realAuthDir: '[recorded, content untouched]',
    realIsolationRoot: '[recorded, content untouched]',
    note: '两个真实根的全部 fs 操作重定向到一次性沙箱并逐项验证；真实目录零触达、不清理。'
  },
  groups: [],
  summary: { total: 0, passed: 0, failed: [] }
};

function group(name, checks) {
  const g = { group: name, total: checks.length, passed: checks.filter(c => c.ok).length, checks };
  report.groups.push(g);
  report.summary.total += checks.length;
  report.summary.passed += g.passed;
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
const runTag = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
let seq = 0;
const fresh = s => 'ev-' + runTag + '-' + (++seq) + '-' + s;

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ev-' + tag + '-')); }
const tempDirs = [];
const track = d => (tempDirs.push(d), d);
function cleanupAll() {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 已清理 */ }
  }
}

// ── R5：文件系统虚拟化（真实登录目录 / SDK 隔离根 → 一次性沙箱） ───────────
function installFsVirtualization(tag) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-fsv-' + tag + '-'));
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
    restore: () => { for (const [name, orig] of originals.reverse()) fs[name] = orig; }
  };
}

// ── 夹具（与相称测试同一做法） ────────────────────────────────────────────

function syntheticPlan(patch) {
  return Object.assign({
    enabled: true,
    appId: p4.FIXED_APP_ID,
    envId: p4.FIXED_ENV_ID,
    roundId: 'SYNTH-ROUND-0001',
    targetUserId: SYN_TARGET,
    evidenceId: 'SYNTH-EVIDENCE-0001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    schemaVersion: 1,
    operatorRef: 'SYNTHETIC_OPERATOR_OFFLINE_ONLY',
    approvedOwnerHint: '2d3aa4'
  }, patch || {});
}

const SYN_STS = {
  Type: 'CAMRole', AccountId: SYN_ACCOUNT,
  UserId: 'SYNTHETIC_USER_ID_VALUE', PrincipalId: 'SYNTHETIC_PRINCIPAL_ID_VALUE',
  Arn: 'qcs::cam::uin/' + SYN_ACCOUNT + ':role/r', RequestId: RID
};

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
  const root = track(mkTmp(tag));
  const dirs = {
    profileDir: path.join(root, 'profile'),
    isolationDir: path.join(root, 'iso'),
    root
  };
  fs.mkdirSync(dirs.profileDir, { recursive: true });
  fs.mkdirSync(dirs.isolationDir, { recursive: true });
  return dirs;
}

function syntheticWorkerSpawn(tr, capture) {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    let payload = null;
    c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
    c.stdin.end = () => {};
    c.kill = () => true;
    if (capture) capture.calls.push({ bin, argv: argv.slice(), payloadRef: () => payload });
    setImmediate(async () => {
      let emitted = null;
      try {
        await worker.run(payload || {}, {
          now: () => Date.now(), db: tr ? tr.db : null, emit: (v) => { emitted = v; }
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

function hangingWorkerSpawn() {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    return c;
  };
}

function freshOutDir(tag) { return track(mkTmp('out-' + tag)); }

function offlineChain(opts) {
  const o = opts || {};
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const planPatch = Object.assign({}, o.planPatch, o.runId ? { roundId: o.runId } : {});
  const plan = syntheticPlan(planPatch);
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

// ── 检查执行器 ────────────────────────────────────────────────────────────
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (e) {
    checks.push({ name, ok: false, error: String(e && e.message || e).split('\n')[0] });
    console.error('[FAIL]', name, '\n', e && e.stack || e);
  }
}

async function main() {
  const normSep = v => String(v).replace(/[\\/]+/g, '\\').replace(/[\\/]+$/, '');

  // ══ R1：来源模式绑定与固定执行依赖 ══
  await check('R1-1 真实模式执行依赖覆盖提前拒绝（nodeBin 样本 + 时钟/隔离根/worker/核对逐项），零子进程零写', async () => {
    const cases = {
      nodeBin: { credentialDeps: { fixed: { nodeBin: 'SYNTHETIC_NOT_FIXED_NODE' } } },
      profileDir: null, // 单独处理
      now: { now: () => Date.now() },
      fixedNowMs: { fixedNowMs: 12345 },
      baseEnv: { baseEnv: { SYNTH: '1' } },
      isolationFixed: { isolationFixed: { isolationRoot: os.tmpdir() } },
      spawnWorker: { spawnWorker: () => { throw new Error('不应被调用'); } },
      workerLimits: { workerLimits: { timeoutMs: 1 } },
      reconcileDeps: { reconcileDeps: { db: null } },
      readOnlyDeps: { readOnlyDeps: {} },
      limits: { limits: { timeoutMs: 1 } },
      credentialCwd: { credentialCwd: os.tmpdir() }
    };
    for (const [key, ov] of Object.entries(cases)) {
      const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
      const plan = syntheticPlan();
      const source = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
      const outDir = freshOutDir('r1a');
      const opts = {
        runId: 'R1-OVR-0001', outDir, plan, approvalSource: source,
        roundId: plan.roundId, credentialSourceMode: 'fixed-real-source',
        spawn: syntheticCliSpawn(captured)
      };
      if (key === 'profileDir') opts.profileDir = syntheticDirs('r1p').profileDir;
      else Object.assign(opts, ov);
      await assert.rejects(() => approvedRun.runOnce(opts),
        (e) => e.code === host.ERR.REAL_MODE_OVERRIDE_REJECTED, key);
      assert.equal(captured.calls.length, 0, key + '：零子进程');
      assert.equal(fs.existsSync(path.join(outDir, 'started')), false, key + '：零写');
    }
  });

  await check('R1-2 来源模式与批准绑定不一致 → started 之前拒绝（双向）', async () => {
    const plan = syntheticPlan();
    const offlineHandle = syntheticApprovalSource(plan);
    const realHandle = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
    const outDir1 = freshOutDir('r1b1');
    await assert.rejects(() => approvedRun.runOnce({
      runId: 'R1-BIND-0001', outDir: outDir1, plan, approvalSource: offlineHandle,
      roundId: plan.roundId, credentialSourceMode: 'fixed-real-source'
    }), (e) => e.code === host.ERR.REAL_MODE_BINDING_MISMATCH);
    const outDir2 = freshOutDir('r1b2');
    await assert.rejects(() => approvedRun.runOnce({
      runId: 'R1-BIND-0002', outDir: outDir2, plan, approvalSource: realHandle,
      roundId: plan.roundId, credentialSourceMode: 'offline-fixture',
      profileDir: syntheticDirs('r1bp').profileDir
    }), (e) => e.code === host.ERR.REAL_MODE_BINDING_MISMATCH);
    assert.equal(fs.existsSync(path.join(outDir1, 'started')), false);
    assert.equal(fs.existsSync(path.join(outDir2, 'started')), false);
  });

  await check('R1-3/R5 正向：真实模式经模块级离线装配全链 —— 固定来源/固定启动器参数被捕获，真实目录经虚拟化零触达', async () => {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const workerCapture = { calls: [] };
    const plan = syntheticPlan({ roundId: 'R1-REALSRC-0001' });
    const source = syntheticApprovalSource(plan, { credentialSourceMode: 'fixed-real-source' });
    const tr = installSyntheticSdkTransport({
      schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID }
    });
    const outDir = freshOutDir('r1c');
    const fsv = installFsVirtualization('r1c');
    const uninstall = host.installRealModeOfflineHarness({
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr, workerCapture),
      reconcileDeps: { db: tr.db }
    });
    try {
      const r = await approvedRun.runOnce({
        runId: 'R1-REALSRC-0001', outDir, plan, approvalSource: source,
        roundId: plan.roundId, credentialSourceMode: 'fixed-real-source'
      });
      assert.equal(r.result.realModeOfflineHarness, true, '报告如实标记离线装配');
      const credCalls = captured.calls.filter(x => x.argv[1] === 'secrets');
      assert.equal(credCalls.length, 1, '凭据命令恰一次');
      assert.equal(credCalls[0].home, REAL_AUTH_DIR,
        '凭据 CLI 的 Home 必须恰为固定真实 authSessionDir');
      assert.ok(credCalls[0].cwd &&
        normSep(credCalls[0].cwd).startsWith(normSep(REAL_AUTH_DIR) + '\\'),
        '凭据获取 cwd 建在固定真实目录之内（逻辑路径）');
      assert.ok(fsv.vops.length >= 2, '应有虚拟化文件操作记录');
      const fetchedDir = fsv.vops.find(v => v.logical === credCalls[0].cwd);
      assert.ok(fetchedDir, '凭据获取 cwd 的创建应被重定向');
      assert.ok(fetchedDir.mapped.startsWith(fsv.sandbox), '实际落在一次性沙箱内');
      assert.ok(fs.existsSync(fetchedDir.mapped), '沙箱内目录确实存在（重定向生效）');
      assert.equal(workerCapture.calls.length, 1, 'worker 恰启动一次');
      const wc = workerCapture.calls[0];
      assert.equal(wc.bin, cliObserver.FIXED.nodeBin, '固定 nodeBin');
      assert.equal(wc.argv[0], host.FIXED.workerPath, '固定 workerPath');
      assert.equal(wc.argv.length, 1, '无额外参数');
      assert.ok(wc.payloadRef() && wc.payloadRef().plan, '载荷经私有 stdin 一次传入');
      assert.equal(captured.credentialFetches, 1);
      assert.equal(captured.apiCalls.length, 4);
      const c = tr.counts();
      assert.equal(c.primarySet, 1);
      assert.equal(c.auditSet, 1);
      assert.equal(c.commit, 1);
      assert.equal(r.result.fixedRealSourceUsed, true);
      assert.equal(r.status, 'COMPLETED', JSON.stringify({
        stoppedAt: r.result.stoppedAt, errorCode: r.result.errorCode
      }));
      assert.ok(fs.existsSync(path.join(outDir, 'terminal', 'R1-REALSRC-0001.COMPLETED.json')));
    } finally {
      uninstall(); fsv.restore(); tr.restore();
    }
  });

  await check('R1-4 模块级离线装配自身校验：未知字段与缺 spawn 拒绝', () => {
    assert.throws(() => host.installRealModeOfflineHarness({ spawn: () => {}, profileDir: 'x' }),
      (e) => e.code === host.ERR.REAL_MODE_OVERRIDE_REJECTED);
    assert.throws(() => host.installRealModeOfflineHarness({}),
      (e) => e.code === host.ERR.REAL_MODE_OVERRIDE_REJECTED);
  });

  await check('R1-5 离线夹具模式显式给出固定真实目录 → started 之前拒绝（两模式隔离）', async () => {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const source = syntheticApprovalSource(plan);
    const outDir = freshOutDir('r1d');
    await assert.rejects(() => approvedRun.runOnce({
      runId: 'R1-ISOL-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, credentialSourceMode: 'offline-fixture',
      profileDir: REAL_AUTH_DIR, spawn: syntheticCliSpawn(captured)
    }), (e) => e.code === host.ERR.CREDENTIAL_FETCH_FAILED);
    assert.equal(captured.calls.length, 0);
    assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
  });

  // ══ R2：入口自接排他 started 核对与终态保存 ══
  await check('R2-1 正向（离线合成链，无调用方持久化回调）：入口自接 started 核对与终态保存', async () => {
    const fx = offlineChain({ tag: 'r2a', runId: 'R2-OK-0001' });
    try {
      const r = await approvedRun.runOnce(fx.options);
      assert.equal(r.status, 'COMPLETED');
      assert.equal(r.result.outcome, 'initialized');
      const started = JSON.parse(fs.readFileSync(
        path.join(fx.outDir, 'started', 'R2-OK-0001.json'), 'utf8'));
      assert.equal(started.recordType, 'STARTED');
      assert.equal(started.auditId, r.result.auditId);
      assert.ok(started.planDigest && started.fullPlanDigest);
      assert.equal(started.credentialSourceMode, 'offline-fixture');
      assert.equal(started.fingerprint.entry.file, ENTRY_FILE);
      assert.ok(/^[0-9a-f]{64}$/.test(started.fingerprint.entry.sha256));
      const terminal = JSON.parse(fs.readFileSync(
        path.join(fx.outDir, 'terminal', 'R2-OK-0001.COMPLETED.json'), 'utf8'));
      assert.equal(terminal.recordType, 'COMPLETED');
      assert.equal(terminal.auditId, started.auditId);
      assert.equal(terminal.resultPersisted, true);
      assert.equal(fx.captured.credentialFetches, 1);
      assert.equal(fx.captured.apiCalls.length, 4);
      const c = fx.tr.counts();
      assert.equal(c.primarySet, 1);
      assert.equal(c.auditSet, 1);
      assert.equal(c.commit, 1);
    } finally { fx.tr.restore(); }
  });

  await check('R2-2 重复轮次：第二次运行不覆盖 started、不再写库、不重取凭据', async () => {
    const fx = offlineChain({ tag: 'r2b', runId: 'R2-DUP-0001' });
    try {
      const first = await approvedRun.runOnce(fx.options);
      assert.equal(first.status, 'COMPLETED');
      const startedBefore = fs.readFileSync(path.join(fx.outDir, 'started', 'R2-DUP-0001.json'));
      const terminalBefore = fs.readFileSync(
        path.join(fx.outDir, 'terminal', 'R2-DUP-0001.COMPLETED.json'));
      const writesBefore = fx.tr.counts();
      await assert.rejects(() => approvedRun.runOnce(fx.options),
        (e) => e.code === approvedRun.ERR.STARTED_EXISTS);
      assert.ok(fs.readFileSync(path.join(fx.outDir, 'started', 'R2-DUP-0001.json'))
        .equals(startedBefore), 'started 不得被重写');
      assert.ok(fs.readFileSync(path.join(fx.outDir, 'terminal', 'R2-DUP-0001.COMPLETED.json'))
        .equals(terminalBefore), '既有终态不得被改写');
      const writesAfter = fx.tr.counts();
      assert.equal(writesAfter.primarySet, writesBefore.primarySet, '零额外写');
      assert.equal(fx.captured.credentialFetches, 1, '不重新取凭据');
    } finally { fx.tr.restore(); }
  });

  await check('R2-3 终态已存在：同状态再次保存不覆盖历史（TERMINAL_EXISTS）', async () => {
    const outDir = freshOutDir('r2c');
    const first = await approvedRun.saveTerminalExclusive(outDir, 'R2-SAVE-0001', 'FAILED', {
      auditId: 'audit-x', planDigest: 'digest-x', errorCode: 'X'
    });
    assert.equal(first.saved, true);
    const before = fs.readFileSync(path.join(outDir, 'terminal', 'R2-SAVE-0001.FAILED.json'));
    await assert.rejects(() => approvedRun.saveTerminalExclusive(outDir, 'R2-SAVE-0001', 'FAILED', {
      auditId: 'audit-x', planDigest: 'digest-x', errorCode: 'Y'
    }), (e) => e.code === approvedRun.ERR.TERMINAL_EXISTS);
    assert.ok(fs.readFileSync(path.join(outDir, 'terminal', 'R2-SAVE-0001.FAILED.json'))
      .equals(before), '历史终态字节不变');
  });

  // ══ R3：入口指纹绑定与两处比较 ══
  await check('R3-1 签发后入口漂移 → 取凭据之前拒绝（零凭据零子进程零写）', async () => {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const source = syntheticApprovalSource(plan);
    const outDir = freshOutDir('r3a');
    const drift = installEntryDrift(() => true);
    try {
      await assert.rejects(() => approvedRun.runOnce({
        runId: 'R3-DRIFT-0001', outDir, plan, approvalSource: source,
        roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
        spawn: syntheticCliSpawn(captured)
      }), (e) => e.code === host.ERR.FINGERPRINT_MISMATCH);
      assert.equal(captured.calls.length, 0, '漂移在取凭据之前拒绝：零子进程');
      assert.equal(fs.existsSync(path.join(outDir, 'started')), false, '零写');
    } finally { drift.restore(); }
  });

  await check('R3-2 异步等待期间入口漂移 → 启动 worker 前复核拦截（不 COMPLETED，终态如实 FAILED）', async () => {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    let driftArmed = false;
    const fx = offlineChain({
      tag: 'r3b', runId: 'R3-DRIFT2-0001',
      cliOpts: { onApiCall: (n) => { if (n >= 1) driftArmed = true; } }
    });
    const drift = installEntryDrift(() => driftArmed);
    try {
      const r = await approvedRun.runOnce(fx.options);
      assert.equal(r.result.stoppedAt, 'entryFingerprintRecheck',
        '启动 worker 前的入口指纹复核应拦截');
      assert.equal(r.result.errorCode, host.ERR.FINGERPRINT_MISMATCH);
      assert.equal(r.status, 'FAILED', '不得 COMPLETED');
      assert.ok(drift.count() >= 2, '入口文件被读取比较过（签发后核对+启动前复核）');
      assert.equal(fx.captured.credentialFetches, 1, '凭据已取得（漂移发生在等待期间）');
      assert.equal(fx.tr.counts().commit, 0, '未启动 worker，零提交');
      const terminal = JSON.parse(fs.readFileSync(
        path.join(fx.outDir, 'terminal', 'R3-DRIFT2-0001.FAILED.json'), 'utf8'));
      assert.equal(terminal.errorCode, host.ERR.FINGERPRINT_MISMATCH);
      assert.ok(fs.existsSync(path.join(fx.outDir, 'started', 'R3-DRIFT2-0001.json')));
    } finally { drift.restore(); fx.tr.restore(); }
  });

  // ══ R4：终态完整投影与保存失败 ══
  await check('R4-1 完整链终态保留提交事实/成功资格/退出事实/核对结论，且无凭据泄漏', async () => {
    const fx = offlineChain({ tag: 'r4a', runId: 'R4-FULL-0001' });
    try {
      const r = await approvedRun.runOnce(fx.options);
      assert.equal(r.status, 'COMPLETED');
      const terminal = JSON.parse(fs.readFileSync(
        path.join(fx.outDir, 'terminal', 'R4-FULL-0001.COMPLETED.json'), 'utf8'));
      assert.equal(terminal.initialized, true);
      assert.equal(terminal.granted, true);
      assert.equal(terminal.commitFactEstablished, true);
      assert.equal(terminal.fullInitializationSuccess, true);
      assert.equal(terminal.observationConfirmed, true);
      assert.ok(terminal.workerProcess && terminal.workerProcess.exitCode === 0 &&
        terminal.workerProcess.timedOut === false, 'worker 进程退出事实');
      assert.ok('reconcile' in terminal && 'reconcileAttempted' in terminal, '核对结论字段保留');
      assert.equal(terminal.resultPersisted, true);
      const raw = JSON.stringify(terminal);
      for (const marker of ['SYNTH_ID', 'SYNTH_KEY', 'SYNTH_TOKEN', 'secretId', 'secretKey', 'sessionToken']) {
        assert.ok(!raw.includes(marker), '终态不得包含凭据类内容：' + marker);
      }
    } finally { fx.tr.restore(); }
  });

  await check('R4-2 worker 超时 → RESULT_UNKNOWN 终态保留进程事实，零提交零写', async () => {
    const fx = offlineChain({
      tag: 'r4b', runId: 'R4-TIMEOUT-0001',
      spawnWorker: hangingWorkerSpawn(),
      workerLimits: { timeoutMs: 400, maxOutputBytes: 1048576 }
    });
    try {
      const r = await approvedRun.runOnce(fx.options);
      assert.equal(r.status, 'RESULT_UNKNOWN');
      assert.equal(r.result.resultUnknown, true);
      const terminal = JSON.parse(fs.readFileSync(
        path.join(fx.outDir, 'terminal', 'R4-TIMEOUT-0001.RESULT_UNKNOWN.json'), 'utf8'));
      assert.equal(terminal.recordType, 'RESULT_UNKNOWN');
      assert.equal(terminal.workerProcess.timedOut, true, '超时进程事实保留');
      assert.equal(terminal.auditId, r.result.auditId);
      const c = fx.tr.counts();
      assert.equal(c.commit, 0);
      assert.equal(c.primarySet, 0);
      assert.equal(fx.captured.credentialFetches, 1, '凭据恰一次（不刷新重试）');
    } finally { fx.tr.restore(); }
  });

  await check('R4-3 提交后回读失败 → RESULT_UNKNOWN 终态保留提交事实', async () => {
    const fx = offlineChain({
      tag: 'r4c', runId: 'R4-READBK-0001',
      transportOpts: { failReadsAfterCommit: true }
    });
    try {
      const r = await approvedRun.runOnce(fx.options);
      assert.equal(r.status, 'RESULT_UNKNOWN');
      const terminal = JSON.parse(fs.readFileSync(
        path.join(fx.outDir, 'terminal', 'R4-READBK-0001.RESULT_UNKNOWN.json'), 'utf8'));
      assert.equal(terminal.commitFactEstablished, true);
      assert.equal(terminal.initialized, true);
      assert.equal(terminal.granted, true);
      assert.equal(terminal.fullInitializationSuccess, false, '观察未确认，不构成完整成功');
      assert.equal(terminal.resultUnknown, true);
      const c = fx.tr.counts();
      assert.equal(c.commit, 1, '提交确已发生');
      assert.equal(c.primarySet, 1);
      assert.equal(fx.captured.credentialFetches, 1, '不重新取凭据重试');
    } finally { fx.tr.restore(); }
  });

  await check('R4-4 终态落盘失败 → 结构化错误带净化执行事实，不伪造成功', async () => {
    const fx = offlineChain({ tag: 'r4d', runId: 'R4-SAVEF-0001' });
    const origWrite = fs.writeFileSync;
    try {
      fs.writeFileSync = function (p, data, options) {
        if (typeof p === 'string' && p.includes(path.join('terminal', 'R4-SAVEF-0001'))) {
          const e = new Error('EIO'); e.code = 'EIO'; throw e;
        }
        return origWrite.call(fs, p, data, options);
      };
      await assert.rejects(() => approvedRun.runOnce(fx.options), (e) => {
        if (e.code !== approvedRun.ERR.TERMINAL_SAVE_FAILED) return false;
        const ex = e.execution;
        assert.ok(ex, '必须携带 e.execution');
        assert.ok(ex.auditId && ex.auditId.startsWith(p4.AUDIT_ID_PREFIX), 'auditId 保留');
        assert.equal(ex.commitFactEstablished, true, '提交事实保留');
        assert.equal(ex.initialized, true);
        assert.equal(ex.granted, true);
        assert.ok(ex.workerProcess && ex.workerProcess.exitCode === 0, '退出事实保留');
        assert.equal(e.causeCode, 'APR_TERMINAL_SAVE_FAILED', '内层保存失败错误码如实保留');
        const raw = JSON.stringify({ message: e.message, execution: ex });
        assert.ok(!/EIO/.test(e.message), '不透传原始异常文本');
        for (const marker of ['SYNTH_ID', 'SYNTH_KEY', 'SYNTH_TOKEN']) {
          assert.ok(!raw.includes(marker), '不含凭据：' + marker);
        }
        return true;
      });
      assert.ok(fs.existsSync(path.join(fx.outDir, 'started', 'R4-SAVEF-0001.json')),
        'started 保留（证明曾启动）');
      assert.equal(fs.existsSync(path.join(fx.outDir, 'terminal', 'R4-SAVEF-0001.COMPLETED.json')),
        false, '保存失败不得留下 COMPLETED 记录');
    } finally {
      fs.writeFileSync = origWrite; fx.tr.restore();
    }
  });

  // ══ §7 文案更正 ══
  await check('S7-1 可本地判断的轮次错误提前拒绝（零凭据零子进程零写）', async () => {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const source = syntheticApprovalSource(plan);
    const outDir = freshOutDir('s7a');
    await assert.rejects(() => approvedRun.runOnce({
      runId: 'S7-ROUND-0001', outDir, plan, approvalSource: source,
      roundId: 'OTHER-ROUND-9999', profileDir: path.join(freshOutDir('s7p'), 'profile'),
      spawn: syntheticCliSpawn(captured)
    }), (e) => e.code === approvedRun.ERR.ROUND_MISMATCH);
    assert.equal(captured.calls.length, 0, '轮次错误零子进程');
    assert.equal(fs.existsSync(path.join(outDir, 'started')), false, '轮次错误零写');
  });

  await check('S7-2 格式合法但与当次 STS 不同的主体摘要 —— 取得当次身份后比较（1 凭据+4 API 后停），零事务写', async () => {
    const otherSts = Object.assign({}, SYN_STS,
      { UserId: 'OTHER_USER_VALUE', PrincipalId: 'OTHER_PRINCIPAL' });
    const fx = offlineChain({
      tag: 's7b', runId: 'S7-SUBJ-0001',
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

  await check('S7-3 缺失/格式非法的预期主体摘要 —— 取凭据之前拒绝', async () => {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const bad = syntheticApprovalSource(plan, { expectedSubjectDigest: 'not-a-valid-digest' });
    const outDir = freshOutDir('s7c');
    await assert.rejects(() => approvedRun.runOnce({
      runId: 'S7-BADSUBJ-0001', outDir, plan, approvalSource: bad,
      roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
      spawn: syntheticCliSpawn(captured)
    }), (e) => e.code === host.ERR.CALLER_SUBJECT_UNVERIFIED ||
      e.code === host.ERR.APPROVAL_REQUIRED || e.code === host.ERR.PLAN_INVALID);
    assert.equal(captured.calls.length, 0, '零子进程');
    assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
  });

  // ══ R5：守卫敏感性 ══
  await check('R5-1 敏感性探针：全程守卫对网络与真实子进程实际拦截并计数', () => {
    const https = require('node:https');
    const http = require('node:http');
    const dns = require('node:dns');
    const net = require('node:net');
    const cp = require('node:child_process');
    assert.throws(() => https.request('https://example.invalid'),
      (e) => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.https++;
    assert.throws(() => http.request('http://example.invalid'),
      (e) => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.http++;
    assert.throws(() => dns.lookup('example.invalid'),
      (e) => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.dns++;
    assert.throws(() => net.connect(443, 'example.invalid'),
      (e) => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.net++;
    assert.throws(() => cp.spawn('node', ['-e', '1']),
      (e) => e.code === 'EV_CHILD_PROCESS_BLOCKED');
    GUARD_PROBES.cp++;
  });

  await check('R5-2 汇总：业务期间意外网络/真实子进程尝试 = 总数 − 探针 = 0', () => {
    for (const channel of Object.keys(GUARD_TOTALS)) {
      const unexpected = GUARD_TOTALS[channel] - GUARD_PROBES[channel];
      if (unexpected !== 0) {
        const stacks = GUARD_STACKS
          .filter(s => s.channel === channel).map(s => s.stack).join('\n---\n');
        assert.fail(channel + '：业务期间意外尝试 ' + unexpected + '；栈：\n' + stacks);
      }
    }
  });

  // 汇总
  group('R1 来源模式绑定与固定执行依赖', checks.filter(c => c.name.startsWith('R1-')));
  group('R2 排他 started 与终态保存（入口自接）', checks.filter(c => c.name.startsWith('R2-')));
  group('R3 入口指纹绑定与两处比较', checks.filter(c => c.name.startsWith('R3-')));
  group('R4 终态完整投影与保存失败', checks.filter(c => c.name.startsWith('R4-')));
  group('R5 全程守卫与敏感性', checks.filter(c => c.name.startsWith('R5-')));
  group('§7 文案更正', checks.filter(c => c.name.startsWith('S7-')));

  report.guards.totals = GUARD_TOTALS;
  report.guards.probes = GUARD_PROBES;
  report.guards.unexpectedAttempts =
    Object.fromEntries(Object.keys(GUARD_TOTALS)
      .map(k => [k, GUARD_TOTALS[k] - GUARD_PROBES[k]]));

  cleanupAll();
}

main().then(() => {
  report.finishedAt = new Date().toISOString();
  const outPath = path.join(__dirname, '首次管理员真实入口R1-R5定点返修-20261012.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('证据已写出：', outPath);
  console.log('汇总：', report.summary.total, '项检查，',
    report.summary.passed, '通过，',
    report.summary.total - report.summary.passed, '失败');
  process.exitCode = report.summary.passed === report.summary.total ? 0 : 1;
}).catch((e) => {
  console.error('证据脚本异常退出：', e && e.stack || e);
  cleanupAll();
  process.exitCode = 1;
});
