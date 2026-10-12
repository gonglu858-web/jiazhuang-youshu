'use strict';
/**
 * 首次管理员真实入口最小接线 —— approved-run 相称离线测试
 * ======================================================
 *
 * 范围（docs/WorkBuddy任务-首次管理员真实入口最小接线-20261012.md §5）：
 *  - M1 固定真实来源与批准交界：credentialSourceMode 两种模式的明确分支、
 *    未知模式拒绝、真实模式 profile 只能是受审只读观测器 FIXED 的固定
 *    authSessionDir、别名/任意 profile 在取凭据前拒绝；
 *  - M2 单次保存与具体计划：排他 started（await 成功后才启动写 worker、
 *    同轮次不覆盖不再写）、终态新建保存不覆盖、重复轮次零额外写；
 *  - 全部离线：合成 spawn 不执行真实 CLI、合成 SDK 传输不联网；
 *    网络与意外真实子进程拦截有敏感性探针。
 *
 * 合成传输替换在哪一层（如实标注，与已验收 host 测试同一口径）：
 *  - CLI 层：`deps.spawn` 替换子进程（凭据命令、三阶段关联、额外 STS 核验）；
 *  - SDK 层：替换 `@cloudbase/database` 的静态 `Db.reqClass` 并注入已建 db。
 *    真实 `sdk.init` / `database()` / 文档序列化 / 事务对象仍走固定 SDK ——
 *    属「真实 SDK 本地转换」；注入 db 不验证生产 worker 自建 db 的同批凭据链，
 *    平台行为未验证。
 *
 * 不联网、不取真实凭据、不读真实认证缓存内容、不初始化、不部署、不启用入口。
 * 本文件不生成真实批准：所有句柄均为离线测试签发的合成句柄。
 */

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

const SYN_OPENID = 'synthetic-offline-openid';
const SYN_TARGET = p4.deriveUserId(p4.FIXED_APP_ID, SYN_OPENID);
const SYN_ACCOUNT = '123456789012';
const RID = '00000000-0000-4000-8000-000000000001';
const REAL_AUTH_DIR = cliObserver.FIXED.authSessionDir;

// ── 夹具（与已验收 host 测试同一形状） ──────────────────────────────────────

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
    expiresAtMs: typeof p.expiresAtMs === 'number' ? p.expiresAtMs : Date.now() + 3600000
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

/** 合成 CLI 子进程：捕获 argv 与 env（证明固定来源参数，不做别名）。 */
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
      respond(cliStdoutFor(argv[2], argv[3]), o.apiExit);
      return c;
    }
    throw new Error('UNEXPECTED_CLI_STAGE');
  };
}

/** 合成 SDK 传输（真实 SDK 本地转换；注入 db；与已验收 host 测试同一做法）。 */
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
      seen.push({ action, coll: params.collectionName, params });
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

function syntheticWorkerSpawn(tr) {
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    let payload = null;
    c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
    c.stdin.end = () => {};
    c.kill = () => true;
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

function freshOutDir(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-out-' + tag + '-'));
  return root;
}

// ══════════════════════════════════════════════════════════════════════
// A：M1 凭据来源模式
// ══════════════════════════════════════════════════════════════════════

test('A-1 默认（offline-fixture）无合成 profile：在取凭据前停止，零凭据零子进程', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  const outDir = freshOutDir('a1');
  const r = await approvedRun.runOnce({
    runId: 'A1-DEFAULT-0001', outDir, plan, approvalSource: source,
    roundId: plan.roundId,
    spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
    persistRoundStarted: () => true, persistResult: () => true
  });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.result.stoppedAt, 'credentialFetch');
  assert.equal(r.result.credentialFetched, false);
  assert.equal(r.result.workerStarted, false);
  assert.equal(captured.calls.length, 0, '不得有任何子进程：' + JSON.stringify(captured.calls));
  assert.match(r.result.incomplete.join(' '), /合成登录 profile/);
  // started 已建、终态 FAILED 已建（不覆盖、如实保存）
  assert.ok(fs.existsSync(path.join(outDir, 'started', 'A1-DEFAULT-0001.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'terminal', 'A1-DEFAULT-0001.FAILED.json')));
});

test('A-2 未知凭据来源模式拒绝；大小写变体不接受；发生在任何写入之前', async () => {
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  for (const mode of ['real', 'REAL', 'fixed-real', 'production', '', 7]) {
    const outDir = freshOutDir('a2');
    await assert.rejects(
      () => approvedRun.runOnce({
        runId: 'A2-MODE-0001', outDir, plan, approvalSource: source,
        roundId: plan.roundId, credentialSourceMode: mode,
        spawn: () => { throw new Error('不应有子进程'); }
      }),
      (e) => e.code === host.ERR.PLAN_INVALID, String(mode));
    // 零写：started/terminal 目录都不应存在
    assert.equal(fs.existsSync(path.join(outDir, 'started')), false, String(mode));
    assert.equal(fs.existsSync(path.join(outDir, 'terminal')), false, String(mode));
  }
  // null/未指定 → 默认 offline-fixture（不拒绝；后续阶段自行处理）
  const outDir = freshOutDir('a2b');
  const r = await approvedRun.runOnce({
    runId: 'A2-DEF-0001', outDir, plan, approvalSource: source,
    roundId: plan.roundId, credentialSourceMode: null,
    spawn: () => { throw new Error('不应有子进程'); }
  });
  assert.equal(r.result.credentialSourceMode, 'offline-fixture');
});

test('A-3 真实模式拒绝任意 profile 别名：调用方 profile 与固定真实来源不一致即停', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  const dirs = syntheticDirs('a3');
  const outDir = freshOutDir('a3');
  // 传入一个合成 profile（离线夹具常用值）：真实模式下必须拒绝 —— 不得借它绕过
  const r = await approvedRun.runOnce({
    runId: 'A3-ALIAS-0001', outDir, plan, approvalSource: source,
    roundId: plan.roundId, credentialSourceMode: 'fixed-real-source',
    profileDir: dirs.profileDir,
    spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
    persistRoundStarted: () => true, persistResult: () => true
  });
  assert.equal(r.result.stoppedAt, 'credentialFetch');
  assert.equal(r.result.credentialFetched, false);
  assert.equal(captured.calls.length, 0, '拒绝必须发生在任何子进程之前');
  assert.match(r.result.incomplete.join(' '), /固定真实来源不一致/);
});

test('A-4 真实模式：底层合成 CLI 捕获的 Home 恰为固定真实 authSessionDir（无别名）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan(null, { roundId: 'A4-REALSRC-0001' });
  const source = syntheticApprovalSource(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID }
  });
  const outDir = freshOutDir('a4');
  try {
    const r = await approvedRun.runOnce({
      runId: 'A4-REALSRC-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, credentialSourceMode: 'fixed-real-source',
      // 不传 profileDir：真实模式下宿主绑定唯一固定真实来源
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr),
      persistRoundStarted: () => true, persistResult: () => true
    });
    // 正向：凭据取一次、三阶段 + 额外 STS
    assert.equal(captured.credentialFetches, 1);
    assert.equal(captured.apiCalls.length, 4, JSON.stringify(captured.apiCalls));
    // 关键断言：**凭据子进程**的 Home 必须精确等于固定真实 authSessionDir。
    // 字符串同一比较 —— 不做大小写/尾斜杠/相对路径规范化，别名一律视为不同。
    // worker 子进程的 cwd 是 SDK 隔离目录（合法地不同于登录 profile），不在此断言内。
    const credCalls = captured.calls.filter(x => x.argv[1] === 'secrets');
    assert.equal(credCalls.length, 1, '凭据命令恰一次：' + JSON.stringify(captured.calls.length));
    assert.equal(credCalls[0].home, REAL_AUTH_DIR,
      '凭据 CLI 的 Home 必须恰为固定真实 authSessionDir：' + credCalls[0].home);
    assert.ok(credCalls[0].cwd && path.relative(REAL_AUTH_DIR, path.resolve(credCalls[0].cwd))
      && !path.relative(REAL_AUTH_DIR, path.resolve(credCalls[0].cwd)).startsWith('..'),
      '凭据获取 cwd 应在固定真实目录内：' + credCalls[0].cwd);
    // 别名检查（结构化，不依赖分隔符方向）：
    // 任何子进程的 Home 若与固定真实目录「解析后同一」，则必须**字节同一** ——
    // 大小写变体 / 尾斜杠 / 相对化都视为别名并拒绝。
    // 凭据子进程（secrets）必须恰为固定真实目录；4 个 api 调用共用一个
    // 不同的隔离目录（既有宿主行为：关联阶段不使用登录 profile 作为 Home）。
    const normPath = v => String(v).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const credCall = captured.calls.find(x => x.argv[1] === 'secrets');
    assert.ok(credCall, '应有凭据子进程');
    assert.equal(credCall.home, REAL_AUTH_DIR,
      '凭据 CLI 的 Home 必须恰为固定真实 authSessionDir：' + credCall.home);
    for (const call of captured.calls) {
      if (!call.home) continue;
      if (normPath(call.home) === normPath(REAL_AUTH_DIR)) {
        assert.equal(call.home, REAL_AUTH_DIR,
          '出现非精确同一的固定来源路径（疑似别名）：' + call.home);
      }
    }
    const apiHomes = new Set(captured.calls.filter(x => x.argv[1] === 'api')
      .map(x => x.home));
    assert.equal(apiHomes.size, 1, '4 个 api 调用应共用同一隔离目录');
    assert.notEqual(normPath(Array.from(apiHomes)[0]), normPath(REAL_AUTH_DIR),
      '关联阶段不得使用登录 profile 作为 Home');
    assert.equal(r.result.fixedRealSourceUsed, true);
    assert.equal(r.result.status, host.STATUS.PLAN_READY, JSON.stringify({
      stoppedAt: r.result.stoppedAt, errorCode: r.result.errorCode,
      outcome: r.result.outcome, incomplete: r.result.incomplete
    }));
    assert.equal(r.status, 'COMPLETED');
  } finally { tr.restore(); }
});

test('A-5 离线夹具模式显式给出固定真实目录 → 仍拒绝（两模式隔离）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  const outDir = freshOutDir('a5');
  const r = await approvedRun.runOnce({
    runId: 'A5-ISOLATE-0001', outDir, plan, approvalSource: source,
    roundId: plan.roundId,
    credentialSourceMode: 'offline-fixture',
    profileDir: REAL_AUTH_DIR,  // 离线模式绝不允许指向真实登录目录
    spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
    persistRoundStarted: () => true, persistResult: () => true
  });
  assert.equal(r.result.stoppedAt, 'credentialFetch');
  assert.equal(captured.calls.length, 0);
  assert.match(r.result.incomplete.join(' '), /合成登录 profile/);
});

// ══════════════════════════════════════════════════════════════════════
// B：M2 排他 started 与终态保存
// ══════════════════════════════════════════════════════════════════════

function offlineChain(opts) {
  const o = opts || {};
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  // 宿主要求 roundId 与绑定计划完全一致：显式 runId 时同步写进计划
  const planPatch = Object.assign({}, o.planPatch,
    o.runId ? { roundId: o.runId } : {});
  const plan = syntheticPlan(o.target, planPatch);
  const source = syntheticApprovalSource(plan, o.approvalPatch);
  const tr = installSyntheticSdkTransport(o.docs === undefined
    ? { schtest_v1_users: { _id: plan.targetUserId, status: 'active', openid: SYN_OPENID } }
    : o.docs);
  const outDir = freshOutDir(o.tag || 'b');
  return {
    captured, plan, source, tr, outDir, dirs: syntheticDirs('fx'),
    options: {
      runId: o.runId || plan.roundId,
      outDir, plan, approvalSource: source,
      roundId: o.runId || plan.roundId,
      credentialSourceMode: o.credentialSourceMode,
      profileDir: o.profileDir !== undefined ? o.profileDir : syntheticDirs('fx').profileDir,
      spawn: syntheticCliSpawn(captured, o.cliOpts),
      spawnWorker: o.spawnWorker || syntheticWorkerSpawn(tr),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: o.persistRoundStarted || (() => true),
      persistResult: o.persistResult || (() => true)
    }
  };
}

test('B-1 完整正向（离线合成链）：排他 started → 宿主全链 → COMPLETED 终态新建', async () => {
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
    assert.equal(started.targetUserId, fx.plan.targetUserId);
    // 指纹：实现 4 文件 + 本入口文件，新入口不得遗漏于最终执行包指纹
    assert.ok(started.fingerprint.entry.file === 'sandbox-primary-approved-run.cjs');
    assert.ok(started.fingerprint.entry.sha256 && started.fingerprint.entry.sha256.length === 64);
    for (const k of Object.keys(started.fingerprint.implementation)) {
      assert.ok(/^[0-9a-f]{64}$/.test(started.fingerprint.implementation[k]), k);
    }
    // 终态 COMPLETED 新建
    const terminal = JSON.parse(fs.readFileSync(
      path.join(fx.outDir, 'terminal', 'B1-OK-0001.COMPLETED.json'), 'utf8'));
    assert.equal(terminal.recordType, 'COMPLETED');
    assert.equal(terminal.auditId, started.auditId);
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

    // 同轮次再次运行：started 已存在 → 拒绝，不进入宿主、零凭据零子进程零写
    await assert.rejects(
      () => approvedRun.runOnce(fx.options),
      (e) => e.code === approvedRun.ERR.STARTED_EXISTS);
    const startedAfter = fs.readFileSync(path.join(fx.outDir, 'started', 'B2-DUP-0001.json'));
    assert.ok(startedBefore.equals(startedAfter), 'started 不得被重写');
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
  // 同状态再次保存：拒绝，不覆盖
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

test('B-5 RESULT_UNKNOWN 如实保存：进程结果未知不得猜测', async () => {
  const outDir = freshOutDir('b5');
  await approvedRun.saveTerminalExclusive(outDir, 'B5-UNK-0001', 'RESULT_UNKNOWN', {
    auditId: 'audit-unk', planDigest: 'digest-unk', errorCode: 'RESULT_UNKNOWN'
  });
  const body = JSON.parse(fs.readFileSync(
    path.join(outDir, 'terminal', 'B5-UNK-0001.RESULT_UNKNOWN.json'), 'utf8'));
  assert.equal(body.recordType, 'RESULT_UNKNOWN');
  assert.equal(body.status, 'RESULT_UNKNOWN');
});

// ══════════════════════════════════════════════════════════════════════
// C：批准与计划交界（预期阶段拒绝，零凭据零子进程零写）
// ══════════════════════════════════════════════════════════════════════

test('C-1 普通 JSON 冒充批准句柄：在批准交界拒绝，零凭据零写', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const outDir = freshOutDir('c1');
  // 手搓一个"像句柄"的普通 JSON（不受 WeakSet 保护）
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
      spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
      persistRoundStarted: () => true, persistResult: () => true
    }),
    (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING);
  assert.equal(captured.calls.length, 0);
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false,
    '批准拒绝发生在 started 之前，零写');
  assert.equal(fs.existsSync(path.join(outDir, 'terminal')), false);
});

test('C-2 复制句柄（序列化后重建）不被接受：toJSON 抛错证明句柄不可序列化', () => {
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  assert.throws(() => JSON.stringify(source), /不可序列化/,
    '受控句柄必须不可序列化 —— 复制即失败');
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
      spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
      persistRoundStarted: () => true, persistResult: () => true
    }),
    (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING);
  assert.equal(captured.calls.length, 0);
  assert.equal(fs.existsSync(path.join(outDir, 'started')), false);
});

test('C-4 错目标：目标不在批准名单内即拒绝（换合成派生目标）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const otherOpenid = 'someone-else-offline';
  const otherTarget = p4.deriveUserId(p4.FIXED_APP_ID, otherOpenid);
  const plan = syntheticPlan(otherTarget);
  // 批准名单里是 SYN_TARGET，计划目标却是 otherTarget
  const source = syntheticApprovalSource(syntheticPlan());
  const outDir = freshOutDir('c4');
  await assert.rejects(
    () => approvedRun.runOnce({
      runId: 'C4-TGT-0001', outDir, plan, approvalSource: source,
      roundId: plan.roundId, profileDir: path.join(outDir, 'profile'),
      spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
      persistRoundStarted: () => true, persistResult: () => true
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
      spawn: syntheticCliSpawn(captured), spawnWorker: () => { throw new Error('不应启动'); },
      persistRoundStarted: () => true, persistResult: () => true
    }),
    (e) => e.code === host.ERR.APPROVAL_SOURCE_MISSING);
  assert.equal(captured.calls.length, 0);
});

test('C-6 缺计划/缺句柄：模块级即拒绝并给出固定错误码', async () => {
  assert.throws(() => approvedRun.checkPlanAndApproval({}),
    (e) => e.code === approvedRun.ERR.PLAN_REQUIRED);
  const plan = syntheticPlan();
  assert.throws(() => approvedRun.checkPlanAndApproval({ plan }),
    (e) => e.code === approvedRun.ERR.APPROVAL_REQUIRED);
});

test('C-7 非法轮次标识与已占用结果目录：写入前拒绝', async () => {
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  await assert.rejects(
    () => approvedRun.runOnce({ runId: '../escape', outDir: freshOutDir('c7a'),
      plan, approvalSource: source }),
    (e) => e.code === approvedRun.ERR.RUN_ID_INVALID);
  const used = freshOutDir('c7b');
  fs.writeFileSync(path.join(used, 'occupied.json'), '{}');
  await assert.rejects(
    () => approvedRun.runOnce({ runId: 'C7-DIR-0001', outDir: used,
      plan, approvalSource: source }),
    (e) => e.code === approvedRun.ERR.RUN_DIR_INVALID);
});

test('C-8 已有 primary（alreadyPresent）：宿主语义不变，终态如实保存', async () => {
  const openid = SYN_OPENID;
  const fx = offlineChain({
    tag: 'c8', runId: 'C8-PRI-0001',
    docs: {
      schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid },
      schtest_v1_app_admins: { _id: 'primary', userId: SYN_TARGET, status: 'active' }
    }
  });
  try {
    const hostSaves = [];
    const options = Object.assign({}, fx.options, {
      persistResult: (v) => { hostSaves.push(v); return true; }
    });
    const r = await approvedRun.runOnce(options);
    // 已验收语义（N2-c4）：alreadyPresent 是保守停止 —— status=FAILED、
    // errorCode=RESULT_UNKNOWN、宿主持久化 recordType 不是 COMPLETED。
    assert.equal(r.result.outcome, 'alreadyPresent', JSON.stringify(r.result.bootstrap));
    assert.equal(r.result.initialized, false);
    assert.equal(r.status, 'RESULT_UNKNOWN',
      '宿主 FAILED+RESULT_UNKNOWN 应如实保存为未知终态：' + r.status);
    assert.equal(hostSaves.length > 0 ? hostSaves[0].recordType : null, 'RESULT_UNKNOWN',
      '宿主持久化不得把已有 primary 存成 COMPLETED');
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
// D：拦截敏感性与边界
// ══════════════════════════════════════════════════════════════════════

test('D-1 拦截敏感性与意外真实子进程拦截（自装守卫，先拦截后探针）', () => {
  // 本套件的离线安全来自 spawn/传输注入；此用例**自装**网络守卫再探测，
  // 证明拦截真实生效（非硬写零）。守卫先于任何探针安装，探针不可能发出真实请求。
  const https = require('node:https');
  const net = require('node:net');
  const dns = require('node:dns');
  const originals = [];
  const blocked = { https: 0, dns: 0, net: 0 };
  const patch = (obj, name, label) => {
    originals.push([obj, name, obj[name]]);
    obj[name] = function (...args) {
      blocked[label]++;
      const e = new Error('测试守卫：禁止网络访问（' + label + '）');
      e.code = 'TEST_NET_BLOCKED';
      throw e;
    };
  };
  patch(https, 'request', 'https');
  patch(net, 'connect', 'net');
  patch(net, 'createConnection', 'net');
  patch(dns, 'lookup', 'dns');
  patch(dns, 'resolve', 'dns');
  try {
    // 敏感性探针：三个面各触发一次，全部同步拒绝并计数
    assert.throws(() => https.request('https://example.invalid'),
      (e) => e.code === 'TEST_NET_BLOCKED');
    assert.throws(() => dns.lookup('example.invalid'),
      (e) => e.code === 'TEST_NET_BLOCKED');
    assert.throws(() => net.connect(443, 'example.invalid'),
      (e) => e.code === 'TEST_NET_BLOCKED');
    assert.equal(blocked.https, 1);
    assert.equal(blocked.dns, 1);
    assert.ok(blocked.net >= 1, 'net 拦截应计数：' + JSON.stringify(blocked));
    // 意外真实子进程：本套件全部子进程都经注入的合成 spawn
    //（结构性保证），此处如实记录探测事实，不冒充产品级证明。
    assert.equal(typeof approvedRun.runOnce, 'function');
  } finally {
    for (const [obj, name, orig] of originals.reverse()) obj[name] = orig;
  }
});

test('D-2 本入口指纹纳入证据：entry sha256 与实现指纹分离', () => {
  const fp = approvedRun.fullFingerprint();
  assert.ok(fp.entry.file === 'sandbox-primary-approved-run.cjs');
  assert.match(fp.entry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.keys(fp.implementation).length >= 4, '宿主实现 4 文件');
  // 入口文件指纹 ≠ 实现指纹里任何一项（不得遗漏、不得混同）
  for (const v of Object.values(fp.implementation)) {
    assert.notEqual(v, fp.entry.sha256);
  }
});

test('D-3 模块边界：approved-run 不提供 execute/approve 公众开关', () => {
  for (const key of Object.keys(approvedRun)) {
    assert.ok(!/execute|approve/i.test(key) || key === 'checkPlanAndApproval',
      '导出不应含公众执行/批准开关：' + key);
  }
  assert.equal(typeof approvedRun.runOnce, 'function');
});
