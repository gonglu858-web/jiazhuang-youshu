#!/usr/bin/env node
/**
 * 证据脚本：首次管理员真实入口 T1/T2 定点收尾（本地离线）
 * ======================================================
 *
 * 独立复现本轮收尾的关键行为（依据 docs/Codex复查-首次管理员真实入口S1-S4收尾-20261012.md）：
 *  - T1（P1）：approved-run 的 `findExistingTerminalRecord` 仅把 ENOENT 按
 *    「目录不存在」处理；EACCES/EIO 等列举失败在 started/凭据/worker 之前
 *    以固定净化错误（APR_TERMINAL_DIR_CHECK_FAILED + causeCode）停止；
 *    保留无 terminal 目录与可读无同轮记录的正常路径及三类已有终态拒绝。
 *  - T2（P2）：入口成功保存后，返回报告的 resultPersisted/unknownPersisted
 *    按实际保存结果与终态类型同步（COMPLETED/FAILED → true/false；
 *    RESULT_UNKNOWN → true/true），文件与返回逐项交叉核对；保存失败异常
 *    保持两个标记 false 与净化执行事实。
 *
 * 版本口径：reviewedCommit 是**实际受测实现版本**；本脚本的返修依据是
 * `7ad03b4` 提交中的复查报告（两者区分，不混用标签）。
 *
 * S4 口径沿用：**默认只输出 stdout**（不自动写结果 JSON；运行中的临时
 * 合成夹具仍有本地文件写入并清理）；如需另存，用
 * `node 本脚本 --out <绝对路径>`，以 `wx` 独占新建 —— 目标已存在即失败
 * 退出，绝不覆盖历史证据。历史文件零改动。
 *
 * 全程守卫（应用模块加载前安装、进程内不恢复）、真实登录目录/SDK 隔离根
 * 文件系统虚拟化（零触达、不清理）保留。分层口径：CLI 层替换 spawn；
 * SDK 层替换 `@cloudbase/database` 的 `Db.reqClass` 并注入 db —— 真实 SDK
 * 本地转换；平台行为未验证。不联网、不取真实凭据、不读真实认证内容、
 * 不初始化/写库、不部署。
 */
'use strict';

// ── 全程守卫（先于任何应用模块加载安装，进程内不恢复） ─────────────────────
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

// ── S4：输出模式解析（默认 stdout；--out 用 wx 新建，绝不覆盖） ────────────
function parseOutArg(argv) {
  const i = argv.indexOf('--out');
  if (i === -1) return { mode: 'stdout', outPath: null };
  const p = argv[i + 1];
  if (typeof p !== 'string' || !path.isAbsolute(p)) {
    throw new Error('--out 必须提供绝对路径（避免相对路径误写历史文件）。');
  }
  return { mode: 'file', outPath: p };
}
const OUT = parseOutArg(process.argv);

const ROOT = path.resolve(__dirname, '../..');
const host = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-execution-host.cjs'));
const worker = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-execution-worker.cjs'));
const p4 = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs'));
const approvedRun = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-approved-run.cjs'));
const cliObserver = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
const sdkObserver = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));

const REAL_AUTH_DIR = cliObserver.FIXED.authSessionDir;
const REAL_ISOLATION_ROOT = sdkObserver.FIXED.isolationRoot;
const SYN_OPENID = 'synthetic-offline-openid';
const SYN_TARGET = p4.deriveUserId(p4.FIXED_APP_ID, SYN_OPENID);
const SYN_ACCOUNT = '123456789012';
const RID = '00000000-0000-4000-8000-000000000001';

const report = {
  generatedAt: new Date().toISOString(),
  round: '首次管理员真实入口 T1/T2 定点收尾',
  reviewBasis: 'docs/Codex复查-首次管理员真实入口S1-S4收尾-20261012.md',
  reviewBasisCommit: '7ad03b4',
  reviewedCommit: '3e6a7c3',
  reviewedCommitNote: '实际受测实现版本（依据版本 7ad03b4 中的复查报告，两者区分）',
  verificationKind: 'OFFLINE_CONTRACT_FIXTURE',
  layers: {
    cliSpawn: 'synthetic (injected)',
    sdkTransport: 'synthetic Db.reqClass + injected db; real sdk.init/database/serialization',
    platformVerified: false,
    realSdkLocalConversion: true
  },
  outputMode: OUT.mode,
  outputNote: '默认仅 stdout（不自动写结果 JSON）；运行中的合成夹具有临时本地文件写入并清理。',
  guards: {
    channels: Object.keys(GUARD_TOTALS),
    installedBeforeAppModules: true,
    note: '进程级不恢复；探针计数与业务意外尝试分离，意外 = 总数 − 探针。'
  },
  fsVirtualization: {
    note: '真实登录目录与 SDK 隔离根的全部 fs 操作重定向一次性沙箱并验证；零触达、不清理。'
  },
  groups: [],
  summary: { total: 0, passed: 0, failed: [] }
};

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'evt-' + tag + '-')); }
const tempDirs = [];
const track = d => (tempDirs.push(d), d);
function cleanupAll() {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 已清理 */ }
  }
}

// ── 文件系统虚拟化（真实登录目录 / SDK 隔离根 → 一次性沙箱） ───────────────
function installFsVirtualization(tag) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-fsv-' + tag + '-'));
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

function syntheticCliSpawn(captured) {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    captured.calls.push({ argv: argv.slice() });
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    const respond = (text) => {
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from(text));
        c.emit('exit', 0, null); c.emit('close', 0, null);
      });
      return c;
    };
    if (argv[1] === 'secrets') {
      captured.credentialFetches++;
      return respond(JSON.stringify({
        data: {
          secretId: 'SYNTH_ID', secretKey: 'SYNTH_KEY', token: 'SYNTH_TOKEN',
          isTemporary: true, expiredAt: new Date(Date.now() + 1800000).toISOString(),
          envId: null
        }
      }));
    }
    if (argv[1] === 'api') {
      captured.apiCalls.push({ key: argv[2] + '.' + argv[3] });
      return respond(cliStdoutFor(argv[2], argv[3]));
    }
    throw new Error('UNEXPECTED_CLI_STAGE');
  };
}

function installSyntheticSdkTransport(docs) {
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
  class SyntheticRequest {
    async send(action, params = {}) {
      seen.push({ action, coll: params.collectionName });
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
    db,
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
  const dirs = { profileDir: path.join(root, 'profile'), root };
  fs.mkdirSync(dirs.profileDir, { recursive: true });
  return dirs;
}

function syntheticWorkerSpawn(tr) {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    let payload = null;
    c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
    c.stdin.end = () => {}; c.kill = () => true;
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
  const plan = syntheticPlan(Object.assign({}, o.planPatch,
    o.runId ? { roundId: o.runId } : {}));
  const source = syntheticApprovalSource(plan, o.approvalPatch);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: SYN_OPENID }
  });
  const outDir = freshOutDir(o.tag || 'b');
  const dirs = syntheticDirs('fx');
  return {
    captured, plan, source, tr, outDir, dirs,
    options: {
      runId: o.runId || plan.roundId,
      outDir, plan, approvalSource: source,
      roundId: o.runId || plan.roundId,
      credentialSourceMode: o.credentialSourceMode,
      profileDir: dirs.profileDir,
      spawn: syntheticCliSpawn(captured),
      spawnWorker: o.spawnWorker || syntheticWorkerSpawn(tr),
      workerLimits: o.workerLimits,
      reconcileDeps: { db: tr.db }
    }
  };
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
  // ══ T1：终态目录列举失败分类 ══
  await check('T1-1 反例闭合：terminal 目录列举 EACCES → started/凭据/worker 之前固定净化停止', async () => {
    const fx = offlineChain({ tag: 't1a', runId: 'T1A-EACCES-001' });
    fs.mkdirSync(path.join(fx.outDir, 'terminal'), { recursive: true });
    const priorFile = path.join(fx.outDir, 'terminal', 'T1A-EACCES-001.COMPLETED.json');
    const priorBody = '{\n  "recordType": "COMPLETED",\n  "syntheticPrior": true\n}\n';
    fs.writeFileSync(priorFile, priorBody);
    const origReaddir = fs.readdirSync;
    let scanAttempts = 0;
    fs.readdirSync = function (p, ...rest) {
      if (typeof p === 'string' &&
        path.resolve(p) === path.resolve(path.join(fx.outDir, 'terminal'))) {
        scanAttempts++;
        const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
      }
      return origReaddir.call(fs, p, ...rest);
    };
    try {
      const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
      assert.ok(err, '应失败');
      assert.equal(err.code, approvedRun.ERR.TERMINAL_DIR_CHECK_FAILED);
      assert.equal(err.causeCode, 'EACCES', '按实际错误 code 分类');
      assert.ok(!/EACCES/.test(err.message), '净化错误文本不透传原始异常');
      assert.equal(scanAttempts, 1, '目录检查恰一次');
      assert.equal(fx.captured.calls.length, 0, '零凭据零子进程');
      assert.equal(fx.captured.apiCalls.length, 0, '零 API');
      const c = fx.tr.counts();
      assert.equal(c.commit, 0); assert.equal(c.primarySet, 0); assert.equal(c.auditSet, 0);
      assert.equal(fs.existsSync(path.join(fx.outDir, 'started')), false, '无 started');
      assert.equal(fs.readFileSync(priorFile, 'utf8'), priorBody, '旧文件字节不变');
    } finally { fs.readdirSync = origReaddir; fx.tr.restore(); }
  });

  await check('T1-2 反例闭合：terminal 目录列举 EIO → 同样在 started/凭据之前停止', async () => {
    const fx = offlineChain({ tag: 't1b', runId: 'T1B-EIO-00001' });
    fs.mkdirSync(path.join(fx.outDir, 'terminal'), { recursive: true });
    const priorFile = path.join(fx.outDir, 'terminal', 'T1B-EIO-00001.COMPLETED.json');
    const priorBody = '{}\n';
    fs.writeFileSync(priorFile, priorBody);
    const origReaddir = fs.readdirSync;
    fs.readdirSync = function (p, ...rest) {
      if (typeof p === 'string' &&
        path.resolve(p) === path.resolve(path.join(fx.outDir, 'terminal'))) {
        const e = new Error('EIO'); e.code = 'EIO'; throw e;
      }
      return origReaddir.call(fs, p, ...rest);
    };
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

  await check('T1-3 正向与三类终态拒绝：ENOENT 正常链；可读无同轮记录正常链；COMPLETED/FAILED/RESULT_UNKNOWN 预存均提前拒绝', async () => {
    // 无 terminal 目录（ENOENT）→ 全链正常
    const fx0 = offlineChain({ tag: 't1c1', runId: 'T1C-NOENT-0001' });
    try {
      const r = await approvedRun.runOnce(fx0.options);
      assert.equal(r.status, 'COMPLETED');
      assert.equal(fx0.tr.counts().commit, 1);
    } finally { fx0.tr.restore(); }
    // 可读但无同轮记录 → 正常执行
    const fx1 = offlineChain({ tag: 't1c2', runId: 'T1C-EMPTY-0001' });
    fs.mkdirSync(path.join(fx1.outDir, 'terminal'), { recursive: true });
    fs.writeFileSync(path.join(fx1.outDir, 'terminal', 'OTHER-ROUND.COMPLETED.json'), '{}\n');
    try {
      const r = await approvedRun.runOnce(fx1.options);
      assert.equal(r.status, 'COMPLETED');
    } finally { fx1.tr.restore(); }
    // 三类已有终态：均零凭据零写提前拒绝，预存文件保留
    for (const status of ['COMPLETED', 'FAILED', 'RESULT_UNKNOWN']) {
      const fx = offlineChain({ tag: 't1c3', runId: 'T1C-EXIST-0001' });
      fs.mkdirSync(path.join(fx.outDir, 'terminal'), { recursive: true });
      const priorFile = path.join(fx.outDir, 'terminal', 'T1C-EXIST-0001.' + status + '.json');
      fs.writeFileSync(priorFile, '{}\n');
      try {
        const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
        assert.ok(err, status);
        assert.equal(err.code, approvedRun.ERR.TERMINAL_EXISTS, status);
        assert.equal(fx.captured.calls.length, 0, status + '：零子进程');
        assert.equal(fx.tr.counts().commit, 0, status + '：零提交');
        assert.equal(fs.existsSync(path.join(fx.outDir, 'started')), false, status + '：无 started');
        assert.ok(fs.existsSync(priorFile), status + '：预存文件保留');
      } finally { fx.tr.restore(); }
    }
  });

  // ══ T2：返回报告持久化标记同步 ══
  await check('T2-1 三种终态类型：返回报告的 resultPersisted/unknownPersisted 与文件逐项交叉一致；业务语义不变', async () => {
    // COMPLETED：true/false
    const fxC = offlineChain({ tag: 't2a', runId: 'T2A-COMP-0001' });
    try {
      const r = await approvedRun.runOnce(fxC.options);
      assert.equal(r.status, 'COMPLETED');
      assert.equal(r.result.resultPersisted, true);
      assert.equal(r.result.unknownPersisted, false);
      const body = JSON.parse(fs.readFileSync(
        path.join(fxC.outDir, 'terminal', 'T2A-COMP-0001.COMPLETED.json'), 'utf8'));
      assert.equal(r.result.resultPersisted, body.resultPersisted);
      assert.equal(r.result.unknownPersisted, body.unknownPersisted);
      assert.equal(r.result.commitFactEstablished, true, '提交事实语义不变');
    } finally { fxC.tr.restore(); }
    // FAILED（入口自行保存）：true/false
    const otherSts = Object.assign({}, SYN_STS,
      { UserId: 'OTHER_USER_VALUE', PrincipalId: 'OTHER_PRINCIPAL' });
    const fxF = offlineChain({
      tag: 't2b', runId: 'T2B-FAIL-0001',
      approvalPatch: { expectedSubjectDigest: host.callerTupleDigest(otherSts) }
    });
    try {
      const r = await approvedRun.runOnce(fxF.options);
      assert.equal(r.status, 'FAILED', '业务 status 语义不变');
      assert.equal(r.result.errorCode, host.ERR.CALLER_SUBJECT_MISMATCH, 'errorCode 不变');
      assert.equal(r.result.resultPersisted, true);
      assert.equal(r.result.unknownPersisted, false);
      const body = JSON.parse(fs.readFileSync(
        path.join(fxF.outDir, 'terminal', 'T2B-FAIL-0001.FAILED.json'), 'utf8'));
      assert.equal(r.result.resultPersisted, body.resultPersisted);
      assert.equal(r.result.unknownPersisted, body.unknownPersisted);
    } finally { fxF.tr.restore(); }
    // RESULT_UNKNOWN（worker 超时）：true/true
    const fxU = offlineChain({
      tag: 't2c', runId: 'T2C-UNK-0001',
      spawnWorker: hangingWorkerSpawn(),
      workerLimits: { timeoutMs: 400, maxOutputBytes: 1048576 }
    });
    try {
      const r = await approvedRun.runOnce(fxU.options);
      assert.equal(r.status, 'RESULT_UNKNOWN', '未知结果语义不变');
      assert.equal(r.result.resultPersisted, true);
      assert.equal(r.result.unknownPersisted, true);
      const body = JSON.parse(fs.readFileSync(
        path.join(fxU.outDir, 'terminal', 'T2C-UNK-0001.RESULT_UNKNOWN.json'), 'utf8'));
      assert.equal(r.result.resultPersisted, body.resultPersisted);
      assert.equal(r.result.unknownPersisted, body.unknownPersisted);
      assert.equal(fxU.tr.counts().commit, 0, '未知结果零提交语义不变');
    } finally { fxU.tr.restore(); }
  });

  await check('T2-2 保存失败异常：两个标记保持 false 且携带净化执行事实（e.execution）', async () => {
    const fx = offlineChain({ tag: 't2d', runId: 'T2D-SAVEF-0001' });
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = function (p, data, options) {
      if (typeof p === 'string' && p.includes(path.join('terminal', 'T2D-SAVEF-0001'))) {
        const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
      }
      return origWrite.call(fs, p, data, options);
    };
    try {
      const err = await approvedRun.runOnce(fx.options).then(() => null, (e) => e);
      assert.ok(err);
      assert.equal(err.code, approvedRun.ERR.TERMINAL_SAVE_FAILED);
      assert.equal(err.causeCode, 'EACCES');
      assert.equal(err.execution.resultPersisted, false);
      assert.equal(err.execution.unknownPersisted, false);
      assert.equal(err.execution.commitFactEstablished, true);
      assert.ok(err.execution.auditId, '净化执行事实保留');
    } finally { fs.writeFileSync = origWrite; fx.tr.restore(); }
  });

  // ══ 守卫敏感性 ══
  await check('R5 探针：全程守卫对网络与真实子进程实际拦截并计数', () => {
    const https = require('node:https');
    const http = require('node:http');
    const dns = require('node:dns');
    const net = require('node:net');
    const cp = require('node:child_process');
    assert.throws(() => https.request('https://example.invalid'), (e) => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.https++;
    assert.throws(() => http.request('http://example.invalid'), (e) => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.http++;
    assert.throws(() => dns.lookup('example.invalid'), (e) => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.dns++;
    assert.throws(() => net.connect(443, 'example.invalid'), (e) => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.net++;
    assert.throws(() => cp.spawn('node', ['-e', '1']), (e) => e.code === 'EV_CHILD_PROCESS_BLOCKED');
    GUARD_PROBES.cp++;
  });

  await check('R5 汇总：业务期间意外网络/真实子进程尝试 = 总数 − 探针 = 0', () => {
    for (const channel of Object.keys(GUARD_TOTALS)) {
      const unexpected = GUARD_TOTALS[channel] - GUARD_PROBES[channel];
      if (unexpected !== 0) {
        const stacks = GUARD_STACKS
          .filter(s => s.channel === channel).map(s => s.stack).join('\n---\n');
        assert.fail(channel + '：业务期间意外尝试 ' + unexpected + '；栈：\n' + stacks);
      }
    }
  });

  report.groups.push({ group: 'T1/T2 + 守卫', total: checks.length, passed: checks.filter(c => c.ok).length, checks });
  report.summary.total = checks.length;
  report.summary.passed = checks.filter(c => c.ok).length;
  report.guards.totals = GUARD_TOTALS;
  report.guards.probes = GUARD_PROBES;
  report.guards.unexpectedAttempts =
    Object.fromEntries(Object.keys(GUARD_TOTALS).map(k => [k, GUARD_TOTALS[k] - GUARD_PROBES[k]]));
  cleanupAll();
}

main().then(() => {
  report.finishedAt = new Date().toISOString();
  const json = JSON.stringify(report, null, 2);
  if (OUT.mode === 'stdout') {
    console.log(json);
    console.error('汇总：', report.summary.total, '项检查，',
      report.summary.passed, '通过，', report.summary.total - report.summary.passed, '失败',
      '（仅 stdout，未写结果文件；另存请用 --out <绝对路径>，wx 新建不覆盖）');
    process.exitCode = report.summary.passed === report.summary.total ? 0 : 1;
  } else {
    let fd;
    try {
      fd = fs.openSync(OUT.outPath, 'wx');
      fs.writeFileSync(fd, json + '\n', 'utf8');
      fs.closeSync(fd);
      console.error('证据已写出（wx 新建）：', OUT.outPath);
      console.error('汇总：', report.summary.total, '项检查，',
        report.summary.passed, '通过，', report.summary.total - report.summary.passed, '失败');
      process.exitCode = report.summary.passed === report.summary.total ? 0 : 1;
    } catch (e) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* 忽略 */ } }
      console.error('未写出：目标已存在或不可创建（wx 语义，不覆盖历史）：', OUT.outPath);
      console.error('如需另存新证据，请换一个未使用的新编号文件名。');
      process.exitCode = 1;
    }
  }
}).catch((e) => {
  console.error('证据脚本异常退出：', e && e.stack || e);
  cleanupAll();
  process.exitCode = 1;
});
