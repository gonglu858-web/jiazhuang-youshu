#!/usr/bin/env node
/**
 * 证据脚本：管理员稳定身份接线 R1/R2 事实记录收尾（本地离线）
 * ==========================================================
 *
 * 独立复现本轮收尾的关键行为（依据 docs/Codex复核-管理员稳定身份与会话最小接线-20261013.md §2/§3）：
 *  - R1：首次完整 STS **实际尝试后**，身份不匹配、解析拒绝或子进程非零退出
 *    等早退都必须保留 `cloudCallAttempted=true`；本地前置失败未尝试启动
 *    （helper 直调对照）保持 false。不把「调用已尝试」等同「请求已到平台」。
 *  - R2：`stableIdentityMatched` 是无阶段限定的**最终**结论 —— 第二次完整
 *    STS 不匹配（换 PrincipalId / 换角色）时撤销为 false；仅会话变化而稳定
 *    主体一致时保留 true 且 `sessionContinuityConfirmed=false`。首次通过的
 *    分阶段事实记入新字段 `firstIdentityCheckMatched`。三种情形的返回报告
 *    与 FAILED/COMPLETED 终态逐项交叉核对。
 *
 * 版本口径：本脚本运行时**动态记录**受测实现的内容指纹（批准指纹清单 5 文件
 * 的实际 SHA-256），不硬编码提交号；返修依据为 9e62eba 提交中的复核报告。
 *
 * S4 口径：**默认只输出 stdout**（不自动写结果 JSON；运行中的合成夹具仍有
 * 临时本地文件写入并清理）；另存用 `node 本脚本 --out <绝对路径>`，以 `wx`
 * 独占新建，目标已存在即失败退出，绝不覆盖历史证据。历史文件零改动。
 *
 * 全程守卫（应用模块加载前安装、进程内不恢复）、真实登录目录/SDK 隔离根
 * 文件系统虚拟化（零触达、不清理）保留。分层口径：CLI 层替换 spawn；SDK 层
 * 替换 `@cloudbase/database` 的 `Db.reqClass` 并注入 db —— 真实 SDK 本地转换；
 * 平台行为未验证。不联网、不取真实凭据、不读真实认证内容、不初始化/写库、
 * 不部署；不生成真实批准，不复用 v2 失败轮次。
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
const identityBinding = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-identity-binding.cjs'));
const cliObserver = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
const sdkObserver = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));

const REAL_AUTH_DIR = cliObserver.FIXED.authSessionDir;
const REAL_ISOLATION_ROOT = sdkObserver.FIXED.isolationRoot;
const SYN_OPENID = 'synthetic-offline-openid';
const SYN_TARGET = p4.deriveUserId(p4.FIXED_APP_ID, SYN_OPENID);
const RID = '00000000-0000-4000-8000-000000000001';

// ── 受测实现内容指纹（运行时计算，不硬编码提交号） ─────────────────────────
const implementationContentDigest = (() => {
  const fp = host.computeImplementationFingerprint();
  const canon = Object.keys(fp).sort().map(k => k + ':' + fp[k]).join('\n');
  return { files: fp, combined: crypto.createHash('sha256').update(canon, 'utf8').digest('hex') };
})();

const report = {
  generatedAt: new Date().toISOString(),
  round: '管理员稳定身份接线 R1/R2 事实记录收尾（仅本地实现与离线验证）',
  reviewBasis: 'docs/Codex复核-管理员稳定身份与会话最小接线-20261013.md',
  reviewBasisCommit: '9e62eba',
  reviewedCommit: null,
  reviewedCommitNote: '不硬编码提交号；实际受测实现以 implementationContentDigest 为准（批准指纹清单 5 文件运行时 SHA-256）',
  implementationContentDigest,
  verificationKind: 'OFFLINE_CONTRACT_FIXTURE',
  layers: {
    cliSpawn: 'synthetic (injected)',
    sdkTransport: 'synthetic Db.reqClass + injected db; real sdk.init/database/serialization',
    platformVerified: false,
    realSdkLocalConversion: true,
    note: '合成传输与真实 SDK 本地转换分层如实标注；平台行为未验证。'
  },
  outputMode: OUT.mode,
  outputNote: '默认仅 stdout（不自动写结果 JSON）；运行中的合成夹具有临时本地文件写入并清理。',
  factSemantics: {
    cloudCallAttempted: '实际尝试启动 STS/关联子进程后为 true；本地前置失败未启动保持 false；不等同请求已到平台',
    firstIdentityCheckMatched: '分阶段事实：首次完整 STS 稳定身份匹配',
    stableIdentityMatched: '无阶段限定的最终结论：第二次完整核对（及同一快照复核）通过才为 true，末次不匹配撤销',
    sessionContinuityConfirmed: '同轮会话连续性核对通过才为 true；仅会话变化时稳定匹配可保留 true'
  },
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

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'evf-' + tag + '-')); }
const tempDirs = [];
const track = d => (tempDirs.push(d), d);
function cleanupAll() {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 已清理 */ }
  }
}

// ── 文件系统虚拟化（真实登录目录 / SDK 隔离根 → 一次性沙箱） ───────────────
function installFsVirtualization(tag) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'evf-fsv-' + tag + '-'));
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
const G_STS_B = gSts(G_SESSION_B);
const G_EXPECTED_STABLE = identityBinding.stableIdentityDigest(G_STS_A);

const SYN_STS = {
  Type: 'CAMRole',
  AccountId: '123456789012',
  UserId: 'SYNTHETIC_USER_ID_VALUE',
  PrincipalId: '123456789012',
  Arn: 'qcs::cam::uin/123456789012:role/r',
  RequestId: RID
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
  const modern = p.bindingPolicyVersion !== undefined ||
    p.expectedStableIdentityDigest !== undefined;
  if (p.expectedSubjectDigest !== undefined) {
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
          UserInfo: { Uin: '123456789012', WxAppId: host.FIXED.appId }
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
    captured.calls.push({ argv: argv.slice() });
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    const respond = (text, code) => {
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from(text));
        c.emit('exit', code === undefined ? 0 : code, null);
        c.emit('close', code === undefined ? 0 : code, null);
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
      if (argv[2] === 'sts' && argv[3] === 'GetCallerIdentity' &&
        Array.isArray(o.stsResponses) && o.stsResponses.length > 0) {
        const idx = Math.min(captured.stsCalls, o.stsResponses.length - 1);
        captured.stsCalls++;
        return respond(cliStdoutFor(argv[2], argv[3], o.stsResponses[idx]), o.apiExit);
      }
      return respond(cliStdoutFor(argv[2], argv[3]), o.apiExit);
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

function freshOutDir(tag) { return track(mkTmp('out-' + tag)); }

function offlineChain(opts) {
  const o = opts || {};
  const captured = { calls: [], credentialFetches: 0, apiCalls: [], stsCalls: 0 };
  const planPatch = Object.assign({}, o.planPatch, o.runId ? { roundId: o.runId } : {});
  const plan = syntheticPlan(planPatch);
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
      spawn: syntheticCliSpawn(captured, o.cliOpts),
      spawnWorker: o.spawnWorker || syntheticWorkerSpawn(tr),
      workerLimits: o.workerLimits,
      reconcileDeps: { db: tr.db }
    }
  };
}

function readTerminal(outDir, runId, status) {
  return JSON.parse(fs.readFileSync(
    path.join(outDir, 'terminal', runId + '.' + status + '.json'), 'utf8'));
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
  // ══ R1：调用尝试事实 ══
  await check('R1-1 首次 STS 实际尝试后身份不匹配 → cloudCallAttempted=true；最终匹配 false；零 worker 零事务', async () => {
    const otherRole = { ...G_STS_A, UserId: '4616873507:' + G_SESSION_A,
      Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/4616873507' };
    const fx = offlineChain({
      tag: 'r1a', runId: 'R1A-MISMATCH-01',
      approvalPatch: {
        bindingPolicyVersion: identityBinding.BINDING_POLICY_VERSION,
        expectedStableIdentityDigest: identityBinding.stableIdentityDigest(otherRole)
      },
      cliOpts: { stsResponses: [G_STS_A] }
    });
    try {
      const r = await approvedRun.runOnce(fx.options);
      assert.equal(r.status, 'FAILED');
      assert.equal(r.result.errorCode, host.ERR.STABLE_IDENTITY_MISMATCH);
      assert.equal(r.result.cloudCallAttempted, true, '已实际尝试，事实不得丢失');
      assert.equal(fx.tr.counts().commit, 0);
      const t = readTerminal(fx.outDir, 'R1A-MISMATCH-01', 'FAILED');
      assert.equal(t.cloudCallAttempted ?? r.result.cloudCallAttempted, true);
      assert.equal(t.stableIdentityMatched, false);
      assert.equal(t.firstIdentityCheckMatched, false);
    } finally { fx.tr.restore(); }
  });

  await check('R1-2 首次 STS 收到响应但身份坏形状（IDENT_UNPARSEABLE）→ cloudCallAttempted=true', async () => {
    const badShape = { ...G_STS_A, UserId: 'no-colon-value' };
    const fx = offlineChain({
      tag: 'r1b', runId: 'R1B-FIRSTBAD-01',
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
      assert.equal(r.result.cloudCallAttempted, true, '已收到响应并解析拒绝');
      assert.equal(fx.tr.counts().commit, 0);
      assert.equal(r.result.stableIdentityMatched, false);
    } finally { fx.tr.restore(); }
  });

  await check('R1-3 首次 STS 子进程非零退出 → 调用尝试事实保留（CLI_ASSOCIATION_FAILED）', async () => {
    const fx = offlineChain({
      tag: 'r1c', runId: 'R1C-STSEXIT-001',
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
      assert.equal(r.result.cloudCallAttempted, true, '子进程已启动（非零退出）');
      assert.equal(fx.captured.credentialFetches, 1, '凭据已取得（时点如实）');
      assert.equal(fx.tr.counts().commit, 0);
    } finally { fx.tr.restore(); }
  });

  await check('R1-4 对照：本地前置失败未尝试启动 → attempted=false（helper 直调）', async () => {
    const noSnapshot = await host.verifyCallerSubject(null, { spawn: () => {} });
    assert.equal(noSnapshot.ok, false);
    assert.equal(noSnapshot.attempted, false, '缺快照未尝试启动');
    const noSpawn = await host.verifyCallerSubject(
      { secretId: 'ID', secretKey: 'KEY', sessionToken: 'TOK' }, {});
    assert.equal(noSpawn.ok, false);
    assert.equal(noSpawn.attempted, false, '缺 spawn 未尝试启动');
  });

  // ══ R2：分阶段与最终匹配结论 ══
  await check('R2-1 第二次不匹配（仅换 PrincipalId）→ 撤销最终匹配、保留分阶段事实；返回与落盘一致；零事务', async () => {
    const driftPrincipal = { ...G_STS_A, PrincipalId: '999999789012' };
    const fx = offlineChain({
      tag: 'r2a', runId: 'R2A-PRINCHG-01',
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
      assert.equal(fx.captured.apiCalls.length, 5);
      assert.equal(fx.tr.counts().commit, 0);
      assert.equal(r.result.stableIdentityMatched, false, '最终匹配结论撤销');
      assert.equal(r.result.firstIdentityCheckMatched, true, '分阶段事实保留');
      const t = readTerminal(fx.outDir, 'R2A-PRINCHG-01', 'FAILED');
      assert.equal(t.stableIdentityMatched, false, '终态不再记 true');
      assert.equal(t.firstIdentityCheckMatched, true);
      assert.equal(r.result.stableIdentityMatched, t.stableIdentityMatched);
    } finally { fx.tr.restore(); }
  });

  await check('R2-2 第二次不匹配（换角色）→ 同样撤销最终匹配；零 worker 零事务', async () => {
    const driftRole = { ...G_STS_A, UserId: '4616873507:' + G_SESSION_A,
      Arn: 'qcs::sts:' + G_ACCOUNT + ':assumed-role/4616873507' };
    const fx = offlineChain({
      tag: 'r2b', runId: 'R2B-ROLECHG-01',
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
      const t = readTerminal(fx.outDir, 'R2B-ROLECHG-01', 'FAILED');
      assert.equal(t.stableIdentityMatched, false);
      assert.equal(t.firstIdentityCheckMatched, true);
    } finally { fx.tr.restore(); }
  });

  await check('R2-3 仅会话变化而稳定主体一致 → 稳定匹配 true、会话连续性 false（返回与落盘一致）', async () => {
    const fx = offlineChain({
      tag: 'r2c', runId: 'R2C-SESSDRFT-01',
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
      assert.equal(r.result.stableIdentityMatched, true, '稳定主体仍一致 → 保留 true');
      assert.equal(r.result.firstIdentityCheckMatched, true);
      assert.equal(r.result.sessionContinuityConfirmed, false, '会话核对失败不得 true');
      const t = readTerminal(fx.outDir, 'R2C-SESSDRFT-01', 'FAILED');
      assert.equal(t.stableIdentityMatched, true);
      assert.equal(t.firstIdentityCheckMatched, true);
      assert.equal(t.sessionContinuityConfirmed, false);
    } finally { fx.tr.restore(); }
  });

  await check('R2-4 正向：firstIdentityCheckMatched/stableIdentityMatched/sessionContinuityConfirmed 均为 true（返回与落盘交叉一致）', async () => {
    const fx = offlineChain({
      tag: 'r2d', runId: 'R2D-OK-0000001',
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
      const t = readTerminal(fx.outDir, 'R2D-OK-0000001', 'COMPLETED');
      assert.equal(t.firstIdentityCheckMatched, true);
      assert.equal(t.stableIdentityMatched, true);
      assert.equal(t.sessionContinuityConfirmed, true);
      const c = fx.tr.counts();
      assert.equal(c.primarySet, 1); assert.equal(c.auditSet, 1); assert.equal(c.commit, 1);
    } finally { fx.tr.restore(); }
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

  report.groups.push({ group: 'R1/R2 事实记录 + 守卫', total: checks.length, passed: checks.filter(c => c.ok).length, checks });
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
