#!/usr/bin/env node
/**
 * 证据脚本：首次管理员真实入口最小接线（本地离线）
 * ================================================
 *
 * 独立复现本轮接线的关键行为，直接断言修后/新增行为；
 * 只输出 stdout，历史证据不改写、不覆盖。
 *
 * 层级如实标注：
 *  - CLI 层：`deps.spawn` 替换子进程（凭据命令、三阶段关联、额外 STS 核验）；
 *  - SDK 层：替换 `@cloudbase/database` 静态 `Db.reqClass` 并注入已建 db；
 *    真实 `sdk.init` / `database()` / 文档序列化 / 事务对象走固定 SDK
 *    —— 属「真实 SDK 本地转换」；**平台行为未验证**，注入 db 不验证
 *    生产 worker 自建 db 的同批凭据链。
 *
 * 不联网、不取真实凭据、不读真实认证缓存内容、不初始化/写库、不部署。
 * 已知副作用（如实记录）：真实模式（fixed-real-source）的凭据宿主会在
 * 固定登录目录内创建一个空隔离工作目录（既有已验收宿主行为，
 * 不读取任何认证文件内容）；本证据只触发 1 次。
 */
'use strict';

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

const HANDOFF_BASELINE = '506ea95';
const REAL_AUTH_DIR = cliObserver.FIXED.authSessionDir;
const SYN_OPENID = 'synthetic-offline-openid';
const SYN_TARGET = p4.deriveUserId(p4.FIXED_APP_ID, SYN_OPENID);
const RID = '00000000-0000-4000-8000-000000000001';
const SYN_STS = {
  Type: 'CAMRole', AccountId: '123456789012', UserId: 'SYNTH_USER',
  PrincipalId: 'SYNTH_PRIN', Arn: 'qcs::cam::uin/123456789012:role/r', RequestId: RID
};

const report = {
  handoffBaseline: HANDOFF_BASELINE,
  verificationKind: 'OFFLINE_CONTRACT_FIXTURE',
  layers: {
    cliSpawn: 'synthetic (injected)',
    sdkTransport: 'synthetic Db.reqClass + injected db; real sdk.init/database/serialization',
    platformVerified: false,
    realSdkLocalConversion: true
  },
  fixedRealSource: { authSessionDirPrefix: '[REAL_AUTH_DIR recorded, content untouched]' },
  sideEffects: {
    isolatedFetchCwdInRealAuthDir: 0,
    note: '真实模式凭据获取会在固定登录目录创建空隔离工作目录（既有宿主行为，不读认证内容）。'
  },
  groups: [],
  protectedBaseline: {}
};
function group(name, checks) {
  report.groups.push({ group: name, total: checks.length, passed: checks.filter(c => c.ok).length, checks });
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
let seq = 0;
const runId0 = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const fresh = s => 'ev-' + runId0 + '-' + (++seq) + '-' + s;

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ev-' + tag + '-')); }
const tempDirs = [];
function track(d) { tempDirs.push(d); return d; }
function cleanupAll() {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 已清理 */ }
  }
}

function snapshotTree(dir) {
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  (function walk(cur, prefix) {
    for (const name of fs.readdirSync(cur).sort()) {
      const rel = prefix ? prefix + '/' + name : name;
      const abs = path.join(cur, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) { rows.push(rel + '/'); walk(abs, rel); }
      else rows.push(rel + ':' + sha256(fs.readFileSync(abs)));
    }
  })(dir, '');
  return rows;
}
function diskFiles(dir) {
  return snapshotTree(dir).filter(x => !x.endsWith('/')).map(x => x.split(':')[0]).sort();
}
function canonicalSorted(list) { return (list || []).slice().sort().join('\n'); }

function planFor(runId) {
  return {
    enabled: true, appId: p4.FIXED_APP_ID, envId: p4.FIXED_ENV_ID,
    roundId: runId, targetUserId: SYN_TARGET,
    evidenceId: 'EVID-' + runId,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    schemaVersion: 1, operatorRef: 'SYNTHETIC_OPERATOR_OFFLINE_ONLY',
    approvedOwnerHint: '2d3aa4'
  };
}
function approvalSourceFor(plan, patch) {
  const p = patch || {};
  const spec = {
    plan, approval: p.approval || {
      approvedUserIds: [plan.targetUserId], approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
      approvedAt: new Date().toISOString()
    },
    approvedBy: p.approvedBy || 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    writeScope: ['initializePrimary'],
    expiresAtMs: typeof p.expiresAtMs === 'number' ? p.expiresAtMs : Date.now() + 3600000,
    expectedSubjectDigest: host.callerTupleDigest(SYN_STS)
  };
  return host.issueControlledApproval(spec);
}

function syntheticCliSpawn(captured) {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    captured.calls.push({ argv: argv.map(String), cwd: options && options.cwd,
      home: options && options.env ? (options.env.USERPROFILE || options.env.HOME) : null });
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    const respond = (text) => setImmediate(() => {
      if (text !== null) c.stdout.emit('data', Buffer.from(text));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    if (argv[1] === 'secrets') {
      captured.credentialFetches++;
      respond(JSON.stringify({ data: { secretId: 'SYNTH_ID', secretKey: 'SYNTH_KEY',
        token: 'SYNTH_TOKEN', isTemporary: true,
        expiredAt: new Date(Date.now() + 1800000).toISOString(), envId: null } }));
      return c;
    }
    if (argv[1] === 'api') {
      captured.apiCalls.push(argv[2] + '.' + argv[3]);
      const key = argv[2] + '.' + argv[3];
      const data = key === 'sts.GetCallerIdentity' ? SYN_STS
        : key === 'tcb.DescribeEnvs'
          ? { EnvList: [{ EnvId: host.FIXED.envId, Status: 'NORMAL', Region: host.FIXED.region }], RequestId: RID }
          : { EnvInfo: { EnvBaseInfo: { EnvId: host.FIXED.envId, Status: 'NORMAL', Region: host.FIXED.region },
              UserInfo: { Uin: '123456789012', WxAppId: host.FIXED.appId } }, RequestId: RID };
      respond('ℹ →' + String(argv[2]).toUpperCase() + '.' + argv[3] + '\n' + JSON.stringify({ data }) + '\n');
      return c;
    }
    throw new Error('UNEXPECTED_STAGE');
  };
}

function installSyntheticSdkTransport(docs) {
  const sdkRoot = host.FIXED.sdkRoot;
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const bson = require(path.join(sdkRoot, 'bson'));
  const EJSON = bson.EJSON || bson;
  const seen = [];
  const db = sdk.init({ env: 'offline-shape-only', secretId: 'SYNTHETIC',
    secretKey: 'SYNTHETIC', throwOnCode: true }).database();
  const original = database.Db.reqClass;
  const store = {};
  for (const [k, v] of Object.entries(docs || {})) {
    store[k] = JSON.parse(JSON.stringify(v));
  }
  const asE = d => JSON.stringify(EJSON.serialize(d, { relaxed: false }));
  database.Db.reqClass = class {
    async send(action, params = {}) {
      seen.push({ action, coll: params.collectionName });
      let key = null;
      if (typeof params.query === 'string') { try { key = JSON.parse(params.query)._id; } catch (_) {} }
      else if (params.query && params.query._id) key = params.query._id;
      if (!key && typeof params._id === 'string') key = params._id;
      if (action === 'database.startTransaction') return { transactionId: 't1' };
      if (action === 'database.commitTransaction') return { requestId: RID };
      if (action === 'database.abortTransaction') return { requestId: RID };
      if (action === 'database.getDocument' || action === 'database.getInTransaction') {
        const doc = store[params.collectionName];
        const hit = doc && (key === null || doc._id === key) ? [asE(doc)] : [];
        return { data: { list: hit }, requestId: RID };
      }
      if (action === 'database.modifyDocument' || action === 'database.updateDocInTransaction') {
        const inc = JSON.parse(params.data);
        const prev = store[params.collectionName];
        const tid = key || (prev ? prev._id : null);
        store[params.collectionName] = Object.assign({}, prev || {}, inc, tid ? { _id: tid } : {});
        return { data: { updated: prev ? 1 : 0, upsert_id: tid }, requestId: RID };
      }
      throw new Error('unexpected ' + action);
    }
  };
  return {
    db, seen,
    counts: () => ({
      primarySet: seen.filter(x => (x.action === 'database.modifyDocument' ||
        x.action === 'database.updateDocInTransaction') && x.coll === 'schtest_v1_app_admins').length,
      auditSet: seen.filter(x => (x.action === 'database.modifyDocument' ||
        x.action === 'database.updateDocInTransaction') && x.coll === 'schtest_v1_audit_events').length,
      commit: seen.filter(x => x.action === 'database.commitTransaction').length,
      abort: seen.filter(x => x.action === 'database.abortTransaction').length
    }),
    restore: () => { database.Db.reqClass = original; }
  };
}

function synthWorker(tr) {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    let payload = null;
    c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
    c.stdin.end = () => {}; c.kill = () => true;
    setImmediate(async () => {
      let emitted = null;
      try { await worker.run(payload, { now: () => Date.now(), db: tr.db, emit: v => { emitted = v; } }); }
      catch (_) { emitted = { ok: false, errorCode: 'WORKER_UNEXPECTED' }; }
      const out = emitted || { ok: false, errorCode: 'WORKER_NO_OUTPUT' };
      c.stdout.emit('data', Buffer.from(JSON.stringify(out)));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    return c;
  };
}

const netStateBefore = (() => {
  // 本证据不安装全局守卫（套件离线安全来自注入）；记录探测基线即可。
  return { note: '本证据全部子进程经注入合成 spawn；SDK 传输为合成 reqClass。' };
})();
report.networkGuard = netStateBefore;

// ═══════════════════════════════════════════════════════════════════════════
// 分组 1：固定真实来源与模式隔离
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  // 1) 默认离线模式：无合成 profile → 取凭据前停止
  {
    const runId = fresh('def');
    const plan = planFor(runId);
    const source = approvalSourceFor(plan);
    const outDir = track(mkTmp('def'));
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const r = await approvedRun.runOnce({
      runId, outDir, plan, approvalSource: source, roundId: runId,
      spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
      persistRoundStarted: () => true, persistResult: () => true
    });
    check('默认离线：无合成 profile 在取凭据前停止', r.result.stoppedAt === 'credentialFetch'
      && r.result.credentialFetched === false);
    check('默认离线：零子进程', captured.calls.length === 0);
    check('默认离线：终态 FAILED 如实保存',
      fs.existsSync(path.join(outDir, 'terminal', runId + '.FAILED.json')));
  }

  // 2) 未知模式在任何写入前拒绝
  {
    const plan = planFor(fresh('mode'));
    const source = approvalSourceFor(plan);
    let rejected = 0;
    for (const mode of ['real', 'REAL', 'production', '']) {
      const outDir = track(mkTmp('mode'));
      try {
        await approvedRun.runOnce({ runId: fresh('m'), outDir, plan, approvalSource: source,
          credentialSourceMode: mode, spawn: () => { throw new Error('不应有子进程'); } });
      } catch (e) {
        if (e.code === host.ERR.PLAN_INVALID) rejected++;
      }
      if (!fs.existsSync(path.join(outDir, 'started'))) rejected++;
    }
    check('未知模式（含大小写变体）零写拒绝', rejected === 8, 'rejected=' + rejected);
  }

  // 3) 真实模式拒绝任意 profile 别名
  {
    const runId = fresh('alias');
    const plan = planFor(runId);
    const source = approvalSourceFor(plan);
    const outDir = track(mkTmp('alias'));
    const profile = track(mkTmp('aliasprofile'));
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const r = await approvedRun.runOnce({
      runId, outDir, plan, approvalSource: source, roundId: runId,
      credentialSourceMode: 'fixed-real-source', profileDir: profile,
      spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
      persistRoundStarted: () => true, persistResult: () => true
    });
    check('真实模式拒绝外来 profile', r.result.stoppedAt === 'credentialFetch'
      && /固定真实来源不一致/.test(r.result.incomplete.join(' ')), r.result.incomplete.join(' '));
    check('真实模式拒绝外来 profile 时零子进程', captured.calls.length === 0);
  }

  // 4) 真实模式正向（合成 CLI 捕获固定来源参数；合成 SDK 传输）
  {
    const runId = fresh('real');
    const plan = planFor(runId);
    const source = approvalSourceFor(plan);
    const outDir = track(mkTmp('real'));
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const beforeFetchDirs = fs.existsSync(REAL_AUTH_DIR)
      ? fs.readdirSync(REAL_AUTH_DIR).filter(n => n.startsWith('cloudbase-credential-fetch-')).length : 0;
    const tr = installSyntheticSdkTransport({
      schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID }
    });
    try {
      const r = await approvedRun.runOnce({
        runId, outDir, plan, approvalSource: source, roundId: runId,
        credentialSourceMode: 'fixed-real-source',
        spawn: syntheticCliSpawn(captured), spawnWorker: synthWorker(tr),
        reconcileDeps: { db: tr.db },
        persistRoundStarted: () => true, persistResult: () => true
      });
      const credCall = captured.calls.find(x => x.argv[1] === 'secrets');
      check('真实模式正向：宿主 PLAN_READY', r.result.status === host.STATUS.PLAN_READY,
        JSON.stringify({ stoppedAt: r.result.stoppedAt, errorCode: r.result.errorCode,
          incomplete: r.result.incomplete }));
      check('真实模式正向：COMPLETED 终态新建', r.status === 'COMPLETED');
      check('真实模式：凭据恰取一次', captured.credentialFetches === 1);
      check('真实模式：三阶段 + 额外 STS 共 4 次', captured.apiCalls.length === 4,
        JSON.stringify(captured.apiCalls));
      // 固定来源参数：凭据子进程的 Home 精确等于固定真实 authSessionDir
      check('真实模式：凭据 CLI Home 恰为固定真实来源', credCall && credCall.home === REAL_AUTH_DIR,
        credCall ? credCall.home : 'missing');
      const normPath = v => String(v).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
      let aliasFound = false;
      for (const call of captured.calls) {
        if (call.home && normPath(call.home) === normPath(REAL_AUTH_DIR)
          && call.home !== REAL_AUTH_DIR) aliasFound = true;
      }
      check('真实模式：无路径别名变体', !aliasFound);
      check('真实模式：关联阶段不使用登录 profile 作为 Home',
        captured.calls.filter(x => x.argv[1] === 'api')
          .every(x => normPath(x.home) !== normPath(REAL_AUTH_DIR)));
      // 副作用记录
      const afterFetchDirs = fs.existsSync(REAL_AUTH_DIR)
        ? fs.readdirSync(REAL_AUTH_DIR).filter(n => n.startsWith('cloudbase-credential-fetch-')).length : 0;
      report.sideEffects.isolatedFetchCwdInRealAuthDir = afterFetchDirs - beforeFetchDirs;
      check('副作用记录：隔离目录新增数已记录', report.sideEffects.isolatedFetchCwdInRealAuthDir >= 0);
      // 一次事务两写一提交
      const c = tr.counts();
      check('真实模式正向：一次事务两写一提交',
        c.primarySet === 1 && c.auditSet === 1 && c.commit === 1, JSON.stringify(c));
      // started / 终态含入口指纹
      const started = JSON.parse(fs.readFileSync(path.join(outDir, 'started', runId + '.json'), 'utf8'));
      check('started 含确定性 auditId', started.auditId === r.result.auditId);
      check('started 含入口文件指纹（不遗漏于执行包指纹）',
        started.fingerprint.entry.file === 'sandbox-primary-approved-run.cjs'
        && /^[0-9a-f]{64}$/.test(started.fingerprint.entry.sha256));
      const terminal = JSON.parse(fs.readFileSync(
        path.join(outDir, 'terminal', runId + '.COMPLETED.json'), 'utf8'));
      check('终态 COMPLETED 与 started 审计键一致', terminal.auditId === started.auditId);
      report.realModeRun = { runId, auditId: r.result.auditId };
    } finally { tr.restore(); }
  }

  // 5) 重复轮次：started 独占，不覆盖不再写
  {
    const runId = fresh('dup');
    const plan = planFor(runId);
    const source = approvalSourceFor(plan);
    const outDir = track(mkTmp('dup'));
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const tr = installSyntheticSdkTransport({
      schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID }
    });
    try {
      const base = {
        runId, outDir, plan, approvalSource: source, roundId: runId,
        credentialSourceMode: 'offline-fixture',
        profileDir: track(mkTmp('dupprofile')),
        spawn: syntheticCliSpawn(captured), spawnWorker: synthWorker(tr),
        reconcileDeps: { db: tr.db },
        persistRoundStarted: () => true, persistResult: () => true
      };
      const first = await approvedRun.runOnce(base);
      assert.equal(first.status, 'COMPLETED');
      const startedBefore = fs.readFileSync(path.join(outDir, 'started', runId + '.json'));
      const writesBefore = tr.counts();
      await assert.rejects(() => approvedRun.runOnce(base),
        (e) => e.code === approvedRun.ERR.STARTED_EXISTS);
      check('重复轮次：STARTED_EXISTS 拒绝', true);
      check('重复轮次：started 字节不变',
        fs.readFileSync(path.join(outDir, 'started', runId + '.json')).equals(startedBefore));
      const writesAfter = tr.counts();
      check('重复轮次：零额外写',
        writesAfter.primarySet === writesBefore.primarySet
        && writesAfter.auditSet === writesBefore.auditSet);
      check('重复轮次：不重新取凭据', captured.credentialFetches === 1);
    } finally { tr.restore(); }
  }

  // 6) 普通 JSON 冒充批准：批准交界拒绝，零子进程零 started
  {
    const runId = fresh('fake');
    const plan = planFor(runId);
    const fake = JSON.parse(JSON.stringify({
      plan, approval: { approvedUserIds: [plan.targetUserId], approvedBy: 'FAKE',
        approvedAt: new Date().toISOString() },
      approvedBy: 'FAKE', writeScope: ['initializePrimary'],
      expiresAtMs: Date.now() + 3600000
    }));
    const outDir = track(mkTmp('fake'));
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    await assert.rejects(
      () => approvedRun.runOnce({ runId, outDir, plan, approvalSource: fake, roundId: runId,
        profileDir: path.join(outDir, 'profile'),
        spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
        persistRoundStarted: () => true, persistResult: () => true }),
      (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING);
    check('普通 JSON 冒充批准：交界拒绝', true);
    check('普通 JSON 冒充批准：零子进程零 started',
      captured.calls.length === 0 && !fs.existsSync(path.join(outDir, 'started')));
  }

  // 7) 已有 primary：宿主保守语义不变，终态 RESULT_UNKNOWN 如实保存
  {
    const runId = fresh('pri');
    const plan = planFor(runId);
    const source = approvalSourceFor(plan);
    const outDir = track(mkTmp('pri'));
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const tr = installSyntheticSdkTransport({
      schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID },
      schtest_v1_app_admins: { _id: 'primary', userId: SYN_TARGET, status: 'active' }
    });
    try {
      const hostSaves = [];
      const r = await approvedRun.runOnce({
        runId, outDir, plan, approvalSource: source, roundId: runId,
        credentialSourceMode: 'offline-fixture',
        profileDir: track(mkTmp('priprofile')),
        spawn: syntheticCliSpawn(captured), spawnWorker: synthWorker(tr),
        reconcileDeps: { db: tr.db },
        persistRoundStarted: () => true,
        persistResult: (v) => { hostSaves.push(v); return true; }
      });
      check('已有 primary：outcome=alreadyPresent 且零写',
        r.result.outcome === 'alreadyPresent' && tr.counts().primarySet === 0);
      check('已有 primary：宿主持久化不记 COMPLETED',
        hostSaves.length > 0 ? hostSaves[0].recordType !== 'COMPLETED' : false);
      check('已有 primary：终态 RESULT_UNKNOWN 如实保存',
        fs.existsSync(path.join(outDir, 'terminal', runId + '.RESULT_UNKNOWN.json'))
        && !fs.existsSync(path.join(outDir, 'terminal', runId + '.COMPLETED.json')));
    } finally { tr.restore(); }
  }

  // 8) 网络与子进程拦截敏感性（自装守卫，先拦截后探针）
  {
    const https = require('node:https');
    const net = require('node:net');
    const dns = require('node:dns');
    const originals = [];
    const blocked = { https: 0, dns: 0, net: 0 };
    const patch = (obj, name, label) => {
      originals.push([obj, name, obj[name]]);
      obj[name] = function () {
        blocked[label]++;
        const e = new Error('证据守卫：禁止网络访问（' + label + '）');
        e.code = 'EV_NET_BLOCKED';
        throw e;
      };
    };
    patch(https, 'request', 'https');
    patch(net, 'connect', 'net');
    patch(net, 'createConnection', 'net');
    patch(dns, 'lookup', 'dns');
    patch(dns, 'resolve', 'dns');
    try {
      assert.throws(() => https.request('https://example.invalid'),
        (e) => e.code === 'EV_NET_BLOCKED');
      assert.throws(() => dns.lookup('example.invalid'), (e) => e.code === 'EV_NET_BLOCKED');
      assert.throws(() => net.connect(443, 'example.invalid'), (e) => e.code === 'EV_NET_BLOCKED');
      check('网络拦截敏感性：三面实测拒绝并计数（非硬写零）',
        blocked.https === 1 && blocked.dns === 1 && blocked.net >= 1, JSON.stringify(blocked));
    } finally {
      for (const [obj, name, orig] of originals.reverse()) obj[name] = orig;
    }
    report.networkGuard.sensitivity = blocked;
  }

  group('M1M2-固定真实来源、批准交界与单次保存', checks);
})().then(() => {
  // 受保护文件基线
  let files = null;
  try {
    files = require('node:child_process').execFileSync('git', ['ls-files', '-z'],
      { cwd: ROOT, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
  } catch (_) { files = null; }
  report.protectedBaseline = {
    note: files === null
      ? '本进程未能调用 git（spawnSync 偶发 EBUSY），已跟踪文件基线未验证，如实记录。'
      : '已跟踪文件清单已获取；运行前后字节比较由运行方以 git status/diff 另行核对，本脚本不重复自证。',
    trackedFiles: files === null ? 0 : files.length
  };
  cleanupAll();
  report.unverified = [
    '平台事务行为、IAM 写权限、真实费用消耗（本轮全部为本地合成验证）。',
    '生产 worker 自建 db 的同批凭据链（测试注入 db；真实 SDK 本地转换真实发生）。',
    '远端代码回读、完整构建/真机、真实批准签发流程。',
    '实际登记轮次与窗口（本轮不产出真实执行包，不生成真实写批准）。',
    '首次未绑定 identify 未知结果仍无持久防重（既有边界）。'
  ];
  report.finishedAt = new Date().toISOString();
  report.summary = {
    groups: report.groups.length,
    checks: report.groups.reduce((n, g) => n + g.total, 0),
    passed: report.groups.reduce((n, g) => n + g.passed, 0),
    failed: report.groups.reduce((n, g) => n + (g.total - g.passed), 0)
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}).catch((e) => {
  cleanupAll();
  process.stderr.write('证据脚本失败：' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exitCode = 1;
});