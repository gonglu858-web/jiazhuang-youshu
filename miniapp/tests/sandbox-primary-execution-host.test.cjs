'use strict';
/**
 * 首次管理员受控接线 —— 相称离线测试
 * ======================================
 *
 * **当前状态：91 项，90 通过 / 0 失败 / 1 显式跳过。**
 *
 * 上一版（84 项，83 通过 / 1 跳过；更早 74/53、53/52、12 通过 / 9 跳过）已过时。
 * 12/9 那一版的组合根因已查明并修复：CLI 替身曾把 `setImmediate()` 句柄当子进程
 * 返回；worker 曾把 `validatePlan` 的归一化结果（含未登记字段 `deadlineMs`）
 * 回传给 P4；worker 替身曾用 `out = await worker.run(...)` 覆盖 `emit` 已收集的结果。
 *
 * **R3-e**（worker 真实子进程入口）：上一版把 worker 复制到临时目录再启动，
 * 破坏了相对 `require`，失败在**模块加载阶段**（不是业务路径失败）；同时把
 * 探针观察到的 EBUSY 归因为「Codex 网络拒绝钩子跨进程残留」—— 该归因
 * **无依据并已撤回**（钩子只在其自身进程内改模块对象，不改磁盘库或全局配置）。
 * 现直接运行原固定路径。**该宿主能否启动子进程是逐次运行的环境条件**：
 * 能启动则全断言；不能启动则显式 skip 并**如实记录该时点的原始错误**，
 * 不预设任何原因（既不写钩子残留，也不写文件占用）。
 *
 * 覆盖：docs/WorkBuddy任务-首次管理员受控接线与本人登记准备-20261009.md §5
 * 组A 默认与拒绝 / B 正向整链 / C 身份 / D 事务门槛 / E 失败接续 /
 * F 重入与留证 / G 净化与边界；另含 R1–R5 定点反例、Codex 复核 S1–S4 反例，
 * 以及 2026-10-10 二次复核的 N1（父进程核对时效）/ N2（绑定与状态聚合）反例、
 * 三次复核的 N1 异步等待 / N2 合法结果组合反例，以及四次复核 §2 完整结果
 * 组合（四例）与 §3 真实 alreadyPresent 对照。
 *
 * 合成传输替换在哪一层（如实标注）：
 *  - CLI 层：`deps.spawn` 替换子进程（凭据命令、三阶段关联、额外 STS 核验）；
 *  - SDK 层：替换 `@cloudbase/database` 的**静态** `Db.reqClass`，并**注入已建好的
 *    db**。注意：`Db.reqClass` 是静态属性，node-sdk 的 `database()` 路径会重设它；
 *    因此本地顺序必须是「先建 db、后替换静态传输」，而不是「实例固化后只影响旧实例」
 *    的普遍机制。真实 `sdk.init` / `database()` / 文档序列化 / 事务对象仍走固定 SDK。
 *  - 因此「真实 SDK 本地转换」是真实发生的；**注入 db 不验证生产 worker 自建 db
 *    的同批凭据链**，平台行为亦**未**验证。
 *
 * 不联网、不取真实凭据、不初始化、不部署、不启用入口。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const host = require('../scripts/lib/sandbox-primary-execution-host.cjs');
const worker = require('../scripts/lib/sandbox-primary-execution-worker.cjs');
const p4 = require('../scripts/lib/sandbox-primary-bootstrap.cjs');
const adapterF = require('../scripts/lib/sandbox-primary-sdk-adapter.cjs');
const readOnly = require('../scripts/lib/cloudbase-sdk-readonly-observer.cjs');
const credentialHost = require('../scripts/lib/cloudbase-cli-credential-host.cjs');
const cliObserver = require('../scripts/lib/cloudbase-readonly-observer.cjs');

// 合成目标由**真实派生算法**得出（非硬编码），与 P4 同一公式
const SYN_OPENID = 'synthetic-offline-openid';
/**
 * S2：合成批准期限（毫秒）。worker 的执行期期限复核**必需**该字段，
 * 缺失即按「无批准期限约束」拒绝 —— 测试夹具统一注入。
 */
const APPROVAL_TTL_MS = Date.now() + 3600000;

const SYN_TARGET = p4.deriveUserId(p4.FIXED_APP_ID, SYN_OPENID);
const SYN_ACCOUNT = '123456789012';
const RID = '00000000-0000-4000-8000-000000000001';

// ── 合成批准与计划（明确标注为合成，不是生产授权） ──────────────────────────
function syntheticApproval(target) {
  return {
    approvedUserIds: [target || SYN_TARGET],
    approvedBy: 'SYNTHETIC_OPERATOR_OFFLINE_ONLY',
    approvedAt: new Date(1700000000000).toISOString()
  };
}
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
/** 受控批准来源（合成）：绑定计划摘要 + 本机固定 CLI 指纹 + 写范围 + 有效期。 */
/**
 * 合成受控批准句柄（**离线测试专用**）。
 *
 * R4：改用宿主的 `issueControlledApproval()` 签发。此前夹具手搓
 * `{controlled:true, planDigest, fileFingerprint}` —— 那正是被 Codex 复现
 * 出「JSON 复制后仍通过」的形状。测试入口签发只用于离线；
 * **真实批准本轮不生成**，生产授权必须由受审管理入口签发。
 */
function syntheticApprovalSource(plan, patch) {
  const p = patch || {};
  const approval = p.approval || {
    approvedUserIds: [plan.targetUserId],
    approvedBy: 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    approvedAt: new Date().toISOString()
  };
  const spec = {
    plan: p.plan || plan,
    approval,
    approvedBy: p.approvedBy || 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
    writeScope: p.writeScope || ['initializePrimary'],
    expiresAtMs: typeof p.expiresAtMs === 'number' ? p.expiresAtMs : Date.now() + 3600000
  };
  // R4：预期主体摘要是**绑定项**。显式传 `undefined` 时必须保持缺失
  //（不能用 `||` 兜底成合法值，否则「缺失」这一情形无法被测）。
  if (!('expectedSubjectDigest' in p)) {
    spec.expectedSubjectDigest = host.callerTupleDigest(SYN_STS);
  } else if (p.expectedSubjectDigest !== undefined) {
    spec.expectedSubjectDigest = p.expectedSubjectDigest;
  }
  return host.issueControlledApproval(spec);
}

const SYN_STS = {
  Type: 'CAMRole',
  AccountId: SYN_ACCOUNT,
  UserId: 'SYNTHETIC_USER_ID_VALUE',
  PrincipalId: 'SYNTHETIC_PRINCIPAL_ID_VALUE',
  Arn: 'qcs::cam::uin/' + SYN_ACCOUNT + ':role/r',
  RequestId: RID
};

/** CLI 合成响应：三阶段关联 + 额外一次 STS 核验。`stsOverride` 可替换 STS 响应。 */
function cliStdoutFor(service, action, stsOverride) {
  const key = service + '.' + action;
  const data =
    key === 'sts.GetCallerIdentity' ? (stsOverride || SYN_STS)
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

/**
 * 合成 CLI 子进程。凭据命令返回合成临时凭据；
 * api 命令按 argv返回对应阶段的合成响应。**不执行任何真实程序。**
 *
 * R1-a 关键修复：原实现里`respond()` **返回 `setImmediate()` 的 Immediate 句柄**，
 * 两处 `return respond(...)` 把该句柄当成子进程返回（不是构造的 EventEmitter `c`）。
 * 实测返回值没有 `.on`，凭据宿主因此归为 `SPAWN_FAILED` —— 与凭据刷新或
 * Node 版本无关。现在 `respond` 只负责**安排**发事件，由调用方`return c`。
 */
function syntheticCliSpawn(captured, opts) {
  const o = opts || {};
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    captured.calls.push({ argv: argv.slice(), cwd: options && options.cwd });
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    // 只安排发事件，**不返回**任何值；返回值由调用方给 `return c`
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
      captured.fetchEnvHasToken = Boolean(options && options.env &&
        options.env.TENCENTCLOUD_SESSIONTOKEN);
      respond(o.credentialOutput !== undefined
        ? o.credentialOutput
        : JSON.stringify({
          data: {
            secretId: 'SYNTH_ID', secretKey: 'SYNTH_KEY', token: 'SYNTH_TOKEN',
            isTemporary: true, expiredAt: new Date(Date.now() + 1800000).toISOString(),
            envId: null
          }
        }), o.credentialExit);
      return c;
    }
    if (argv[1] === 'api') {
      captured.apiCalls.push({
        key: argv[2] + '.' + argv[3],
        sessionToken: options && options.env ? options.env.TENCENTCLOUD_SESSIONTOKEN : null
      });
      respond(cliStdoutFor(argv[2], argv[3], o.sts), o.apiExit);
      return c;
    }
    throw new Error('UNEXPECTED_CLI_STAGE argv=' + JSON.stringify(argv.map(x => String(x).split(/[\\/]/).pop())));
  };
}

/**
 * 合成 SDK 传输：替换 `Db.reqClass`，其余走**真实 SDK**（含真实事务与文档转换）。
 *
 * R1-d 返修：原实现只有一条 `send()` 分支、**所有**响应都返回列表形状，
 * 因此完全不支持事务（`database.startTransaction` / `getInTransaction` /
 * `updateDocInTransaction` / `commitTransaction` / `abortTransaction`），
 * 也没有写入持久化与回读。这样即使修好前三项，也无法证明「3读2写1提交」。
 *
 * 现在按**已验收适配器测试**（tests/sandbox-primary-sdk-adapter.test.cjs M2-26/27）
 * 的固定请求形状实现，并维护一份**可变 store**让写入可被回读：
 *  - 事务 get：`{data: EJSON 序列化的单对象}`（不是 list）
 *  - 事务 set：`{data:{updated, upsert_id}}`
 *  - commit/abort：`{requestId}`
 *  - 非事务 getDocument：`{data:{list:[...]}}`
 *  - modifyDocument：`{data:{updated, upsert_id}}`
 * 事务开始/提交**不**计为集合写（按 action 分类，不混算）。
 */
function installSyntheticSdkTransport(docs, failOn, opts) {
  const sdkRoot = host.FIXED.sdkRoot;
  require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const bson = require(path.join(sdkRoot, 'bson'));
  const EJSON = bson.EJSON || bson;
  const seen = [];
  // S2：动作事件钩子（用例可在真实 SDK 动作发生时推进合成时钟）
  let actionHook = typeof (opts && opts.onAction) === 'function' ? opts.onAction : null;
  /**
   * R1-d 关键顺序与注入方式（依据已验收适配测试 M2-26/27 的实测）：
   *  1. **先** `sdk.init(...).database()` 建出 db；
   *  2. **再** 替换 `Db.reqClass`。准确机制：`Db.reqClass` 是**静态属性**，
   *     而 node-sdk `lib/cloudbase.js` 的 `database()` 路径会**重设**它；
   *     因此「先建 db、后替换静态传输」是本地可行的唯一顺序。替换后再让
   *     worker 自己 `sdk.init().database()`，db 会拿到重设后的真实传输 →
   *     事务前抛 `SIGN_PARAM_INVALID`，表现为 RESULT_UNKNOWN 且传输调用数为 0。
   *     这**不是**「实例固化后只影响旧实例」的普遍机制，不要据此推断。
   *  3. 把这个 db **注入** worker（`deps.db`）—— 与已验收适配层测试同一做法。
   */
  const db = sdk.init({
    env: 'offline-shape-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true
  }).database();
  const original = database.Db.reqClass;
  // 可变 store：写成功后回读能看到（默认来自传入的 docs 深拷贝）
  const store = {};
  for (const [k, v] of Object.entries(docs || {})) store[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const asEjsonDoc = doc => JSON.stringify(EJSON.serialize(doc, { relaxed: false }));

  const failIf = (action) => {
    if (!failOn) return false;
    if (failOn.stage && failOn.stage !== action) return false;
    if (failOn.coll && failOn.coll !== '*' && paramsColl() !== failOn.coll) return false;
    return true;
  };
  let lastColl = null;
  function paramsColl() { return lastColl; }

  class SyntheticRequest {
    async send(action, params = {}) {
      lastColl = params.collectionName;
      seen.push({ action, coll: params.collectionName, params });
      // S2：允许用例在**真实动作事件**上推进合成时钟（不按 now() 次数猜测）
      if (typeof actionHook === 'function') actionHook(action, params);
      if (failIf(action)) {
        throw Object.assign(new Error('SYNTHETIC_SDK_FAILURE'), { code: 'SYNTHETIC_SDK_FAILURE' });
      }
      // 文档主键：真实包把 `query` 发成 JSON 字符串（已验收实测：
      // {"collectionName":..,"query":"{\"_id\":\"u_abc\"}","queryType":"DOC","multi":false}）
      let key = null;
      if (typeof params.query === 'string') {
        try { key = JSON.parse(params.query)._id || null; } catch (_) { key = null; }
      } else if (params.query && typeof params.query._id === 'string') {
        key = params.query._id;
      }
      if (!key && typeof params._id === 'string') key = params._id;

      // ── 事务控制（**不计为集合读写**）──
      if (action === 'database.startTransaction') return { transactionId: 'synthetic-tx-1' };
      if (action === 'database.commitTransaction') return { requestId: RID };
      if (action === 'database.abortTransaction') return { requestId: RID };

      // ── 读：list 形状，按 `_id` 精确命中（未命中 → 空 list）──
      if (action === 'database.getDocument' || action === 'database.getInTransaction') {
        const doc = store[params.collectionName];
        const hit = doc !== undefined && doc !== null && (key === null || doc._id === key)
          ? [asEjsonDoc(doc)] : [];
        return { data: { list: hit }, requestId: RID };
      }

      // ── 写：data 是裸字段的 JSON（无 data 包装），按 `_id` 落到 store ──
      if (action === 'database.modifyDocument' || action === 'database.updateDocInTransaction') {
        const incoming = JSON.parse(params.data);
        const prev = store[params.collectionName];
        const targetId = key || (prev ? prev._id : null);
        store[params.collectionName] = Object.assign({}, prev || {}, incoming,
          targetId ? { _id: targetId } : {});
        return {
          data: { updated: prev ? 1 : 0, upsert_id: prev ? undefined : targetId },
          requestId: RID
        };
      }
      if (action === 'database.deleteDocInTransaction' || action === 'database.deleteDoc') {
        delete store[params.collectionName];
        return { data: { deleted: 1 }, requestId: RID };
      }
      throw new Error('unexpected SDK action: ' + action);
    }
  }
  database.Db.reqClass = SyntheticRequest;
  /**
   * 计数口径（R1-d）：事务控制动作与集合读写**分开**统计，
   * 事务开始/提交不混算成集合写。
   */
  const isTxControl = a => a === 'database.startTransaction' ||
    a === 'database.commitTransaction' || a === 'database.abortTransaction';
  const isRead = a => a === 'database.getDocument' || a === 'database.getInTransaction';
  const isWrite = a => a === 'database.modifyDocument' || a === 'database.updateDocInTransaction';
  return {
    sdk, db, seen, store,
    setHook: (fn) => { actionHook = typeof fn === 'function' ? fn : null; },
    counts: () => ({
      userGet: seen.filter(x => isRead(x.action) && x.coll === 'schtest_v1_users').length,
      primaryGet: seen.filter(x => isRead(x.action) && x.coll === 'schtest_v1_app_admins').length,
      auditGet: seen.filter(x => isRead(x.action) && x.coll === 'schtest_v1_audit_events').length,
      primarySet: seen.filter(x => isWrite(x.action) && x.coll === 'schtest_v1_app_admins').length,
      auditSet: seen.filter(x => isWrite(x.action) && x.coll === 'schtest_v1_audit_events').length,
      commit: seen.filter(x => x.action === 'database.commitTransaction').length,
      abort: seen.filter(x => x.action === 'database.abortTransaction').length,
      begin: seen.filter(x => x.action === 'database.startTransaction').length,
      // 只读观察的非事务读（不带 transactionId）
      readOnlyGet: seen.filter(x => isRead(x.action) && !x.params.transactionId).length
    }),
    restore: () => { database.Db.reqClass = original; }
  };
}

/** 三个隔离目录（合成）：凭据 profile / 关联隔离目录 / worker cwd。 */
function syntheticDirs(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'x-' + tag + '-'));
  const dirs = {
    profileDir: path.join(root, 'profile'),
    isolationDir: path.join(root, 'iso'),
    root
  };
  fs.mkdirSync(dirs.profileDir, { recursive: true });
  fs.mkdirSync(dirs.isolationDir, { recursive: true });
  return dirs;
}

// ══════════════════════════════════════════════════════════════════════
// A 默认与拒绝
// ══════════════════════════════════════════════════════════════════════

test('A-1 参数白名单：只接受 --local-check/--show-plan，无 --execute', () => {
  assert.deepEqual(host.parseArgs(['--local-check']).ok, true);
  assert.deepEqual(host.parseArgs(['--show-plan']).ok, true);
  for (const bad of ['--execute', '--approve', '--init', '--initialize', '--deploy',
    '--force', '--yes', '--allow', '--env', '--collection', '--url', '--endpoint',
    '--script', '--adapter', '--secret', '--token', '--credential', '--auth',
    '--region', '--appid', '--user', '--openid', '--primary']) {
    const r = host.parseArgs([bad]);
    assert.equal(r.ok, false, bad + ' 应被拒绝');
    assert.equal(r.reason, 'ARG_FORBIDDEN', bad);
  }
  assert.equal(host.parseArgs(['--bogus']).reason, 'ARG_UNKNOWN');
  assert.equal(host.parseArgs(['--execute=1']).reason, 'ARG_FORBIDDEN');
});

test('A-2 默认本地检查：零取凭据/零联网/零 worker', async () => {
  const r = await host.localCheck({ cliEntry: cliObserver.FIXED.cliEntry, cliBundle: cliObserver.FIXED.cliBundle });
  assert.equal(r.status, host.STATUS.LOCAL_READY);
  assert.equal(r.credentialFetched, false);
  assert.equal(r.cloudCallAttempted, false);
  assert.equal(r.workerStarted, false);
  assert.ok(r.checks.every(c => c.ok), JSON.stringify(r.checks));
  // 固定值来自已验收模块
  assert.equal(r.fixed.appId, 'wxfb4db1615ac15531');
  assert.equal(r.fixed.envId, 'cloud1-d8gcq5ag39d847723');
  assert.equal(r.fixed.region, 'ap-shanghai');
  // **零参数**调用也必须可用：默认取已验收观测器的固定路径。
  // 修复前 `verifyFingerprint` 拿不到路径即抛 FIXED_PATH_MISSING，默认入口恒 FAILED。
  const bare = await host.localCheck({});
  assert.equal(bare.status, host.STATUS.LOCAL_READY,
    '零参数调用须就绪：' + JSON.stringify(bare.checks));
  assert.equal(bare.credentialFetched, false);
  assert.equal(bare.cloudCallAttempted, false);
  assert.equal(bare.workerStarted, false);
});

test('A-3 缺受控批准来源：在获取凭据之前停止（未取凭据、未联网）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  // 不提供 approvalSource
  const r = await host.executeOnce({
    plan, approval: syntheticApproval(),
    now: () => Date.now(),
    roundId: 'SYNTH-ROUND-0001',
    spawn: syntheticCliSpawn(captured)
  });
  assert.equal(r.status, host.STATUS.FAILED);
  assert.equal(r.stoppedAt, 'approvalSource');
  assert.equal(r.errorCode, host.ERR.APPROVAL_SOURCE_MISSING);
  assert.equal(r.credentialFetched, false, '不得在批准缺失时取凭据');
  assert.equal(captured.credentialFetches, 0, '凭据命令零次');
  assert.equal(captured.apiCalls.length, 0, 'API 零次');
});

test('A-4 计划 JSON 自报批准字段不构成授权来源', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  // 计划里塞 approvedBy/allowed/trusted —— 应被 P4 禁止字段拒绝，且不构成批准
  const tampered = Object.assign({}, plan, { trusted: true, allowed: true, approvedBy: 'ME' });
  const r = await host.executeOnce({
    plan: tampered, approval: syntheticApproval(),
    approvalSource: { controlled: true, approvedBy: 'ME', expiresAtMs: Date.now() + 1000 },
    now: () => Date.now(),
    roundId: 'SYNTH-ROUND-0001', spawn: syntheticCliSpawn(captured)
  });
  assert.equal(r.status, host.STATUS.FAILED);
  assert.equal(r.credentialFetched, false);
  assert.equal(captured.credentialFetches, 0);
});

test('A-5 批准必须绑定计划摘要与本机文件指纹（R4：不可序列化签发句柄）', () => {
  const plan = syntheticPlan();
  const base = syntheticApprovalSource(plan);
  const now = () => Date.now();

  // 正确签发的句柄通过
  assert.equal(host.verifyControlledApproval({ approvalSource: base, plan, now }).ok, true);

  // R4-a：JSON 复制（`controlled:true` 原样保留）**不再**被接受
  let copy = null;
  try {
    copy = JSON.parse(JSON.stringify(Object.assign({}, base, { controlled: true })));
  } catch (_) {
    copy = null; // toJSON 抛错也算拒绝
  }
  if (copy !== null) {
    assert.equal(host.verifyControlledApproval({ approvalSource: copy, plan, now }).ok, false,
      'JSON 复制品不得通过批准核对');
  }

  // R4-b：计划字段被换（摘要绑定）
  for (const [label, bad] of [
    ['换 operatorRef', Object.assign({}, plan, { operatorRef: 'SOMEONE_ELSE' })],
    ['延长期限', Object.assign({}, plan,
      { expiresAt: new Date(Date.now() + 99999999).toISOString() })],
    ['换 roundId', Object.assign({}, plan, { roundId: 'SYNTH-ROUND-OTHER' })],
    ['换目标', Object.assign({}, plan, { targetUserId: 'u_' + 'b'.repeat(40) })]
  ]) {
    const r = host.verifyControlledApproval({ approvalSource: base, plan: bad, now });
    assert.equal(r.ok, false, label + ' 必须被拒绝');
  }

  // R4-c：实现文件指纹按**实际内容**核对
  const impl = host.computeImplementationFingerprint();
  assert.ok(Object.keys(impl).length >= 4, '应绑定本模块/P4/适配器/worker');
  for (const name of Object.keys(impl)) {
    assert.equal(typeof impl[name], 'string', name + ' 指纹应可计算');
    assert.equal(impl[name].length, 64);
  }

  // 过期 / 未声明写范围（用签发入口直接构造这些情况）
  const expired = syntheticApprovalSource(plan, { expiresAtMs: Date.now() - 1 });
  assert.equal(host.verifyControlledApproval({ approvalSource: expired, plan, now }).ok, false);
  const noScope = syntheticApprovalSource(plan, { writeScope: [] });
  assert.equal(host.verifyControlledApproval({ approvalSource: noScope, plan, now }).ok, false);
});

// ══════════════════════════════════════════════════════════════════════
// B 正向整链（真实 P4 核心 + 真实 SDK 本地转换）
// ══════════════════════════════════════════════════════════════════════

test('B-1 完整正向链：一次凭据 → 三阶段关联 → 当次STS → 真实P4事务 → 回读', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const source = syntheticApprovalSource(plan);
  // 合成 SDK 传输：用户 active/派生一致、primary 与审计均不存在
  const openid = 'synthetic-offline-openid';
  const userId = p4.deriveUserId(p4.FIXED_APP_ID, openid);
  assert.equal(userId, SYN_TARGET, '派生须与合成目标一致（sha256 前40位）');
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: userId, status: 'active', openid }
  });
  const docs = tr.seen;
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(userId), approvalSource: source,
      now: () => Date.now(),
      roundId: 'SYNTH-ROUND-0001',
      ...syntheticDirs('X'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr.seen, docs, { db: tr.db }),
      expectedSubjectDigest: host.callerTupleDigest(SYN_STS),
      fixedNowMs: Date.now(),
      persistRoundStarted: () => true,
      persistResult: () => true
    });
    // 凭据只取一次
    assert.equal(captured.credentialFetches, 1);
    // 三阶段关联 + 一次固定 STS 核验
    const keys = captured.apiCalls.map(x => x.key);
    assert.ok(keys.includes('sts.GetCallerIdentity'), JSON.stringify(keys));
    assert.ok(keys.includes('tcb.DescribeEnvs'));
    assert.ok(keys.includes('tcb.DescribeEnvInfo'));
    // R2：CLI 三阶段 + 额外 STS 共 4 次固定 API，都带**同一批凭据**
    assert.equal(captured.apiCalls.length, 4,
      '三阶段关联 + 额外 STS 应共 4 次：' + JSON.stringify(keys));
    for (const a of captured.apiCalls) {
      assert.equal(a.sessionToken, 'SYNTH_TOKEN', a.key + ' 未收到同批凭据');
    }
    // 真实 P4 完成事务并回读
    assert.equal(r.status, host.STATUS.PLAN_READY, JSON.stringify({
      stoppedAt: r.stoppedAt, errorCode: r.errorCode,
      outcome: r.outcome, observeFailed: r.observeFailed, observed: r.observed,
      counts: tr.counts()
    }));
    assert.equal(r.outcome, 'initialized', JSON.stringify(r.bootstrap));
    assert.equal(r.initialized, true);
    assert.equal(r.observeFailed, false);
    assert.equal(r.observationConfirmed, true);
    assert.equal(r.observed.state, 'present', JSON.stringify(r.observed));
    assert.equal(r.observed.primaryStatus, 'active');
    assert.ok(r.auditId.startsWith(p4.AUDIT_ID_PREFIX));

    // R1-d：逐项断言「3读2写1提交」，且事务开始/提交**不**混算成集合写。
    // 计数口径：事务内读与只读回读都读 primary/审计，故各 2 次
    //（1 次事务内 + 1 次回读）；users 只在事务内读 1 次。
    const c = tr.counts();
    assert.equal(c.userGet, 1, '事务内读 users 恰好一次：' + JSON.stringify(c));
    assert.equal(c.primaryGet, 2, 'primary：事务内 1 + 回读 1：' + JSON.stringify(c));
    assert.equal(c.auditGet, 2, '审计：事务内 1 + 回读 1：' + JSON.stringify(c));
    assert.equal(c.primarySet, 1, 'primary 恰好写一次：' + JSON.stringify(c));
    assert.equal(c.auditSet, 1, '审计恰好写一次：' + JSON.stringify(c));
    assert.equal(c.commit, 1, '恰好提交一次：' + JSON.stringify(c));
    assert.equal(c.abort, 0, '成功路径不得回滚：' + JSON.stringify(c));
    assert.equal(c.begin, 1, '只开启一个事务：' + JSON.stringify(c));
    // 回读：observePrimary 的两条非事务读取（primary + 本计划审计）
    assert.equal(c.readOnlyGet, 2, '回读恰好两条：' + JSON.stringify(c));

    // 写集合只限测试 app_admins/audit_events（按 action 分类，不含事务控制）
    const writes = tr.seen.filter(x => x.action === 'database.modifyDocument' ||
      x.action === 'database.updateDocInTransaction');
    assert.equal(writes.length, 2, '恰好两条集合写：' + JSON.stringify(writes.map(x => x.action)));
    for (const w of writes) {
      assert.ok(['schtest_v1_app_admins', 'schtest_v1_audit_events'].includes(w.coll),
        '越界写集合：' + w.coll);
    }
    // users 只被读，从未被写
    assert.equal(tr.seen.filter(x => x.coll === 'schtest_v1_users' &&
      x.action === 'database.updateDocInTransaction').length, 0, 'users 不得被写');
    assert.equal(r.writeAuthorized, undefined, '初始化报告不自称写授权');
    assert.equal(r.resultPersisted, true, '结果应新建保存');
  } finally {
    tr.restore();
  }
});

test('B-2 元组摘要：固定有序数组 UTF-8 JSON SHA-256，不裁尾不改大小写', () => {
  const a = host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'ACC1', UserId: 'U1', PrincipalId: 'P1' });
  const b = host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'ACC1', UserId: 'U1', PrincipalId: 'P1' });
  assert.equal(a, b, '同输入须同摘要');
  assert.equal(a.length, 64);
  //顺序敏感
  const c = host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'ACC1', UserId: 'P1', PrincipalId: 'U1' });
  assert.notEqual(a, c, 'UserId/PrincipalId 互换须得不同摘要');
  // 大小写敏感
  const d = host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'acc1', UserId: 'U1', PrincipalId: 'P1' });
  assert.notEqual(a, d, '不得改大小写');
  // 缺字段 → null
  assert.equal(host.callerTupleDigest({ Type: 'CAMRole', AccountId: 'A', UserId: 'U' }), null);
  // 与手工计算一致
  const crypto = require('node:crypto');
  const expect = crypto.createHash('sha256')
    .update(JSON.stringify(['CAMRole', 'ACC1', 'U1', 'P1']), 'utf8').digest('hex');
  assert.equal(a, expect);
});

// ══════════════════════════════════════════════════════════════════════
// C 身份
// ══════════════════════════════════════════════════════════════════════

test('C-1 同主账号但完整主体不同 → 拒绝，不自动放宽', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  // 只改 UserId（其余元组相同）→ 同一主账号、不同完整主体
  const otherSts = Object.assign({}, SYN_STS, { UserId: 'SYNTHETIC_USER_ID_OTHER' });
  const r = await host.executeOnce({
    plan, approval: syntheticApproval(),
    // R4：预期摘要**绑定在批准里**（同主账号的旧主体），不再是独立入参
    approvalSource: syntheticApprovalSource(plan),
    now: () => Date.now(),
    roundId: 'SYNTH-ROUND-0001',
    ...syntheticDirs('C1'),
    spawn: syntheticCliSpawn(captured, { sts: otherSts }),
    spawnWorker: () => { throw new Error('MUST_NOT_START_WORKER'); },
    persistRoundStarted: () => true
  });
  assert.equal(r.status, host.STATUS.FAILED);
  assert.equal(r.stoppedAt, 'callerSubject', JSON.stringify({
    stoppedAt: r.stoppedAt, errorCode: r.errorCode
  }));
  assert.equal(r.errorCode, host.ERR.CALLER_SUBJECT_MISMATCH);
  assert.equal(r.workerStarted, false, '主体不符不得启动写 worker');
});

test('C-2 尾号相同不能绕过：仅尾号信息不足以充当主体核对', () => {
  // 已验收投影只有尾号；本宿主要求完整元组摘要
  assert.equal(typeof host.callerTupleDigest(SYN_STS), 'string');
  // 只给尾号字段无法构成元组
  assert.equal(host.callerTupleDigest({ Type: 'CAMRole', accountIdTail: '789012', userIdTail: 'abcd' }), null);
});

test('C-3 未绑定预期主体摘要即拒绝，不得从本次响应自学习', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  // R4：预期主体摘要必须**绑定在受控批准里**。缺失时 `issueControlledApproval`
  // 产出的句柄不满足绑定要求 → 批准核对阶段就拒绝，且**先于取凭据**。
  const r = await host.executeOnce({
    plan, approval: syntheticApproval(),
    // 显式传 undefined：预期摘要这一绑定项**缺失**
    approvalSource: syntheticApprovalSource(plan, { expectedSubjectDigest: undefined }),
    now: () => Date.now(),
    roundId: 'SYNTH-ROUND-0001',
    ...syntheticDirs('C3'),
    spawn: syntheticCliSpawn(captured),
    spawnWorker: () => { throw new Error('MUST_NOT_START_WORKER'); },
    persistRoundStarted: () => true
  });
  assert.equal(r.stoppedAt, 'approvalSource', JSON.stringify({
    stoppedAt: r.stoppedAt, errorCode: r.errorCode
  }));
  assert.equal(r.errorCode, host.ERR.CALLER_SUBJECT_UNVERIFIED);
  assert.equal(r.credentialFetched, false, '缺绑定必须在取凭据之前停止');
  assert.equal(captured.credentialFetches, 0, '不得发起凭据命令');
  assert.equal(r.workerStarted, false);
  // 核对：未提供摘要的句柄确实不被接受
  const noDigest = host.verifyControlledApproval({
    approvalSource: syntheticApprovalSource(plan, { expectedSubjectDigest: undefined }),
    plan, now: () => Date.now()
  });
  assert.equal(noDigest.ok, false);
});

test('C-4 STS 类型/字段不符即拒绝', async () => {
  const bad = [
    [{ Type: 'UnknownRole', AccountId: 'A', UserId: 'U', PrincipalId: 'P', Arn: 'x' }, host.ERR.STS_TYPE_MISMATCH],
    [{ Type: 'CAMRole', AccountId: 'A', UserId: 'U', Arn: 'x' }, host.ERR.STS_FIELD_MISSING]
  ];
  for (const [sts, expect] of bad) {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    const r = await host.verifyCallerSubject(
      { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      {
        spawn: syntheticCliSpawn(captured, { sts }),
        baseEnv: {},
        // R2：第三参数是隔离目录（已验收签名 (baseEnv, snapshot, isolationDir)）
        isolationDir: fs.mkdtempSync(path.join(os.tmpdir(), 'c4-iso-'))
      }
    );
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, expect, JSON.stringify(r));
  }
});

// ══════════════════════════════════════════════════════════════════════
// D 事务门槛（真实 P4 核心，合成 SDK 传输）
// ══════════════════════════════════════════════════════════════════════

/** 合成 worker 子进程：走真实 worker main（真实 SDK + 真实 P4）。 */
function syntheticWorkerSpawn(seen, docs, opts) {
  const o = opts || {};
  // db 注入：与已验收适配层测试同一做法（见 installSyntheticSdkTransport 注释）
  return (bin, argv, options) => {
    const { EventEmitter } = require('node:events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    let payload = null;
    c.stdin.write = (raw) => {
      payload = JSON.parse(String(raw));
      // S1：用例需要看到**实际送进 worker 的载荷**
      if (typeof o.onPayload === 'function') o.onPayload(payload);
      return true;
    };
    c.stdin.end = () => {};
    c.kill = () => true;
    setImmediate(async () => {
      if (o.hang) return; // 模拟超时/不 close
      // R1-c：worker.run 通过 emit 输出且返回 undefined。
      // 原写法 `out = await worker.run(..., emit: v => out = v)` 会用
      // undefined **覆盖** emit 已收集的结果，下一步 JSON.stringify(undefined)
      // 抛 ERR_INVALID_ARG_TYPE。现在只 await，输出一律取 emit 收集值。
      let emitted = null;
      try {
        await worker.run(payload || {}, {
          now: () => Date.now(),
          db: o.db || null,
          emit: (v) => { emitted = v; }
        });
      } catch (e) {
        emitted = { ok: false, errorCode: 'WORKER_UNEXPECTED' };
      }
      const out = emitted === null ? { ok: false, errorCode: 'WORKER_NO_OUTPUT' } : emitted;
      c.stdout.emit('data', Buffer.from(JSON.stringify(out)));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    return c;
  };
}

test('D-1 目标用户缺失 → 零 set/commit，状态为拒绝', async () => {
  const isWriteAct = a => a === 'database.modifyDocument' || a === 'database.updateDocInTransaction';
  const tr = installSyntheticSdkTransport({}); // users 也缺失
  try {
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      plan: syntheticPlan(), approval: syntheticApproval(),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: APPROVAL_TTL_MS
    }, { now: () => Date.now(), db: tr.db, emit: (v) => { out = v; } });
    const isWriteAct = a => a === 'database.modifyDocument' || a === 'database.updateDocInTransaction';
    // R1 返修：断言**真实到达的阶段** —— 事务已开启、读过 users，随后零写。
    const c = tr.counts();
    assert.equal(c.begin, 1, '事务应已开启：' + JSON.stringify(c));
    assert.equal(c.userGet, 1, '应真实读取过 users：' + JSON.stringify(c));
    const written = tr.seen.filter(x => isWriteAct(x.action));
    assert.equal(written.length, 0, '用户缺失时零写：' + JSON.stringify(tr.seen));
    assert.equal(c.commit, 0, '不得提交');
    assert.equal(out.ok, false);
    assert.equal(out.bootstrap, null, '未产出提交结论');
    assert.ok(/^[A-Z_]{3,64}$/.test(String(out.errorCode)), '固定错误码：' + out.errorCode);
  } finally { tr.restore(); }
});

test('D-2 primary 已存在 → 零写且不误报 initialized', async () => {
  const isWriteAct = a => a === 'database.modifyDocument' || a === 'database.updateDocInTransaction';
  const openid = 'synthetic-offline-openid';
  const userId = p4.deriveUserId(p4.FIXED_APP_ID, openid);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: userId, status: 'active', openid },
    schtest_v1_app_admins: { _id: 'primary', userId, status: 'active' }
  });
  try {
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      plan: syntheticPlan(userId), approval: syntheticApproval(userId),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: APPROVAL_TTL_MS
    }, { now: () => Date.now(), db: tr.db, emit: (v) => { out = v; } });
    assert.equal(out.bootstrap.outcome, 'alreadyPresent');
    assert.equal(out.bootstrap.initialized, false, 'alreadyPresent 绝不可报 initialized');
    assert.equal(out.bootstrap.granted, false);
    const writes = tr.seen.filter(x => isWriteAct(x.action));
    assert.equal(writes.length, 0, 'primary 已存在时零写');
    assert.equal(out.bootstrap.existingPrimary.status, 'active');
  } finally { tr.restore(); }
});

test('D-3 审计已存在但 primary 缺失 → 停止，不补写', async () => {
  const isWriteAct = a => a === 'database.modifyDocument' || a === 'database.updateDocInTransaction';
  const openid = 'synthetic-offline-openid';
  const userId = p4.deriveUserId(p4.FIXED_APP_ID, openid);
  const plan = syntheticPlan(userId);
  const auditId = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: userId, status: 'active', openid },
    schtest_v1_audit_events: { _id: auditId, subjectUserId: userId }
  });
  try {
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      plan, approval: syntheticApproval(userId), verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: APPROVAL_TTL_MS
    }, { now: () => Date.now(), db: tr.db, emit: (v) => { out = v; } });
    assert.equal(out.bootstrap.outcome, 'auditAlreadyPresent');
    assert.equal(out.bootstrap.initialized, false);
    const writes = tr.seen.filter(x => isWriteAct(x.action));
    assert.equal(writes.length, 0, '审计已存在时零写，绝不补写');
  } finally { tr.restore(); }
});

test('D-4 凭据过期 → worker 零读取', async () => {
  const tr = installSyntheticSdkTransport({});
  try {
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() - 1 },
      plan: syntheticPlan(), approval: syntheticApproval(),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: APPROVAL_TTL_MS
    }, { now: () => Date.now(), db: tr.db, emit: (v) => { out = v; } });
    assert.equal(out.errorCode, 'WORKER_CREDENTIAL_EXPIRED');
    assert.equal(tr.seen.length, 0, '过期凭据零读取');
  } finally { tr.restore(); }
});

// ══════════════════════════════════════════════════════════════════════
// E 失败接续
// ══════════════════════════════════════════════════════════════════════

test('E-1 started 未新建 / 能力缺失 / 轮次不符 / 异步失败 → 零写请求', async () => {
  const base = (patch) => {
    const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
    const plan = syntheticPlan();
    return { captured, plan, opts: Object.assign({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(),
      roundId: 'SYNTH-ROUND-0001',
      ...syntheticDirs('E1'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: () => { throw new Error('MUST_NOT_START_WORKER'); },
      persistRoundStarted: () => true
    }, patch || {}) };
  };

  // (1) 返回 false（同轮次已存在）
  let r = await host.executeOnce(base({ persistRoundStarted: () => false }).opts);
  assert.equal(r.stoppedAt, 'roundStarted', 'stages=' + JSON.stringify(r.stages));
  assert.equal(r.errorCode, host.ERR.ROUND_ALREADY_STARTED);
  assert.equal(r.workerStarted, false, '未新建轮次不得启动写 worker');

  // (2) 抛错
  r = await host.executeOnce(base({
    persistRoundStarted: () => { throw new Error('SYNTHETIC_PERSIST_THREW'); }
  }).opts);
  assert.equal(r.stoppedAt, 'roundStarted');
  assert.equal(r.workerStarted, false, '持久化异常同样零写 worker');

  // (3) 返回异步 Promise（修复前未 await，会被当成已成功）
  r = await host.executeOnce(base({ persistRoundStarted: () => Promise.resolve(false) }).opts);
  assert.equal(r.stoppedAt, 'roundStarted',
    '异步失败必须被等待：stages=' + JSON.stringify(r.stages));
  assert.equal(r.workerStarted, false, '异步未成功不得启动写 worker');

  // (4) 轮次与计划不一致
  r = await host.executeOnce(base({ roundId: 'SYNTH-ROUND-OTHER' }).opts);
  assert.equal(r.stoppedAt, 'roundStarted', '轮次与计划不符须停止');
  assert.equal(r.errorCode, host.ERR.ROUND_START_FAILED);
  assert.equal(r.workerStarted, false, '轮次不符不得启动写 worker');

  // (5) 完全不提供持久化能力 —— R4 起它是**必需**
  const captured5 = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan5 = syntheticPlan();
  r = await host.executeOnce({
    plan: plan5, approval: syntheticApproval(),
    approvalSource: syntheticApprovalSource(plan5),
    now: () => Date.now(), roundId: 'SYNTH-ROUND-0001',
    ...syntheticDirs('E1b'),
    spawn: syntheticCliSpawn(captured5),
    spawnWorker: () => { throw new Error('MUST_NOT_START_WORKER'); }
  });
  assert.equal(r.stoppedAt, 'roundStarted', '缺持久化能力须停止');
  assert.equal(r.errorCode, host.ERR.ROUND_START_FAILED);
  assert.equal(r.workerStarted, false);
});

test('E-2 worker 超时不 close → 结果未知，保留轮次与审计 ID，不重试', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({});
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(),
      roundId: 'SYNTH-ROUND-0001',
      ...syntheticDirs('E2'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      persistRoundStarted: () => true,
      // S3-2（Codex 2026-10-10）：未知结果**也要落盘**，类型显式区分
      persistResult: (v) => { saves.push(v); return true; },
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(r.status, host.STATUS.FAILED);
    assert.equal(r.errorCode, host.ERR.RESULT_UNKNOWN);
    assert.equal(r.resultUnknown, true, '超时属结果未知');
    assert.equal(r.workerStarted, true);
    assert.equal(captured.credentialFetches, 1, '不得为重试再取第二批凭据');
    // 不保存为**完成**
    assert.equal(r.resultPersisted, undefined, '未知结果不得记为已完成');
    // 但必须保存为**未知终态**，否则执行事实随进程丢失
    assert.equal(saves.length, 1, '未知结果应落盘一次');
    assert.equal(saves[0].recordType, 'RESULT_UNKNOWN', '终态类型须显式区分');
    assert.notEqual(saves[0].recordType, 'COMPLETED');
    assert.equal(r.unknownPersisted, true);
    // 无第二次初始化
    assert.equal(tr.counts().begin, 0, '不得再次进入初始化');
  } finally { tr.restore(); }
});

test('E-3 提交成功但回读未确认 → 不抹去提交事实，不重试写，不报成功', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  // N2：夹具必须用**本计划的确定性键与摘要**。原用
  // `sbx-init-primary:synthetic`（属他计划/未绑定回执），在 N2 聚合点会被判为
  // 不可信结果并撤销 initialized —— 那是 §3.1 要求的另一条语义，
  // 由 S4-1 / S4-2 单独覆盖。本用例要验证的是「绑定正确但回读未确认」。
  const boundAuditId = p4.auditId(plan, p4.inputDigest(plan));
  const boundDigest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(),
      roundId: 'SYNTH-ROUND-0001',
      ...syntheticDirs('E3'),
      spawn: syntheticCliSpawn(captured),
      // 合成 worker：报告已提交，但回读 state=unconfirmed（R5 场景）
      spawnWorker: () => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        let payload = null;
        c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
        c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: false, errorCode: null, resultUnknown: false,
            outcome: 'initialized', granted: true, initialized: true,
            bootstrap: {
              ok: true, outcome: 'initialized', granted: true, initialized: true,
              auditId: boundAuditId, inputDigest: boundDigest
            },
            observed: { state: 'unconfirmed', primaryPresent: null, primaryStatus: null,
              auditPresent: null, writeAuthorized: true, errorCode: null },
            observeFailed: true,
            observationConfirmed: false,
            auditId: boundAuditId, planDigest: boundDigest
          })));
          c.emit('exit', 0, null); c.emit('close', 0, null);
        });
        return c;
      },
      persistRoundStarted: () => true,
      persistResult: () => true
    });
    // R5：提交事实保留
    assert.equal(r.initialized, true, '已提交事实不得被回读未确认抹去');
    assert.equal(r.outcome, 'initialized');
    /**
     * S3：审计 ID 必须是**启动前由受控计划算出的确定性键**，
     * 而不是合成 worker 自报的 `sbx-init-primary:synthetic`
     * （S4 要求父层逐项精确核对，不据子进程输出采信）。
     */
    assert.equal(r.auditId, boundAuditId, '审计 ID 必须是本计划确定性键');
    // R5：回读未确认不算成功
    assert.equal(r.observeFailed, true);
    assert.equal(r.observationConfirmed, false);
    assert.equal(r.status, host.STATUS.FAILED, '回读未确认不得报成功');
    assert.equal(r.resultUnknown, true);
    assert.equal(r.resultPersisted, undefined, '未确认不保存为已完成');
    // 父层强制只读观察永不成为写授权
    assert.equal(r.observed.writeAuthorized, false, '只读观察不得成为写授权');
  } finally { tr.restore(); }
});

// ══════════════════════════════════════════════════════════════════════
// F/G 净化与边界
// ══════════════════════════════════════════════════════════════════════

test('G-1 合成秘密标记不出现在任何输出/证据', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const r = await host.executeOnce({
    plan, approval: syntheticApproval(), approvalSource: syntheticApprovalSource(plan),
    now: () => Date.now(),
    roundId: 'SYNTH-ROUND-0001',
    isolationDir: fs.mkdtempSync(path.join(os.tmpdir(), 'g1-iso-')),
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'g1-prof-')),
    spawn: syntheticCliSpawn(captured),
    spawnWorker: syntheticWorkerSpawn([], {}, { db: installSyntheticSdkTransport({}).db }),
    expectedSubjectDigest: host.callerTupleDigest(SYN_STS),
    persistRoundStarted: () => true
  });
  const dumped = JSON.stringify(r);
  for (const secret of ['SYNTH_ID', 'SYNTH_KEY', 'SYNTH_TOKEN']) {
    assert.equal(dumped.includes(secret), false, '凭据原值泄漏：' + secret);
  }
  // 不含完整 STS 主体原值
  assert.equal(dumped.includes(SYN_STS.UserId), false, 'UserId 原值泄漏');
  assert.equal(dumped.includes(SYN_STS.PrincipalId), false, 'PrincipalId 原值泄漏');
});

test('G-2 旧集合/业务路由/建资源命中 0；默认入口仍关闭', async () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'sandbox-primary-execution-worker.cjs'), 'utf8');
  // 注意：'memberAccess' 只出现在**本机固定 SDK 目录名**里，不是业务路由调用；
  // 因此只断言不出现业务调用与云路由。
  for (const forbidden of ['schtest_v1_projects', 'createProject', 'identify(',
    'requestBindingNumber', 'callFunction', 'cloudbase.init']) {
    assert.equal(src.includes(forbidden), false, '越界命中：' + forbidden);
  }
  // 固定 SDK 路径必须是已核对的只读副本目录
  assert.ok(worker.SDK_ROOT.includes('memberAccess-readonly-sdk'), 'SDK 路径偏离固定只读副本');
  // 写集合只限两个（由已验收适配层常量保证）
  assert.deepEqual(adapterF.WRITE_COLLECTIONS.slice().sort(),
    ['schtest_v1_app_admins', 'schtest_v1_audit_events']);
  // 默认本地检查不启动 worker
  const lc = await host.localCheck({
    cliEntry: cliObserver.FIXED.cliEntry, cliBundle: cliObserver.FIXED.cliBundle
  });
  assert.equal(lc.workerStarted, false);
});

test('G-3 prepare-sandbox-primary --execute 拒绝保持不变', () => {
  // 本轮不修改该入口；只做静态确认其仍拒绝 --execute
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'prepare-sandbox-primary.cjs'), 'utf8');
  assert.ok(src.includes('--execute'), '该入口仍识别 --execute');
  assert.ok(/execute[\s\S]{0,200}(拒绝|refuse|不支持|not supported|EXIT|exitCode)/i.test(src),
    '该入口仍对 --execute 给出拒绝路径');
});
// ══════════════════════════════════════════════════════════════════════
// 第 2 组：R1–R5 定点反例（Codex 复核 R1–R5 的关键反例）
// ══════════════════════════════════════════════════════════════════════

test('R1 原始计划进入 P4：归一化计划的 deadlineMs 不得被当作原始计划', () => {
  const p4mod = require('../scripts/lib/sandbox-primary-bootstrap.cjs');
  const plan = syntheticPlan();
  const approval = { approvedUserIds: [plan.targetUserId], approvedBy: 'S', approvedAt: new Date().toISOString() };
  const normalized = p4mod.validatePlan(plan, { approval, nowMs: Date.now() });
  assert.equal(Object.keys(normalized).length, Object.keys(plan).length + 1,
    '归一化计划应恰好多一个派生字段');
  assert.ok('deadlineMs' in normalized, 'P4 会补 deadlineMs');
  assert.equal('deadlineMs' in plan, false, '原始计划不含 deadlineMs');
  assert.throws(() => p4mod.validatePlan(normalized, { approval, nowMs: Date.now() }),
    e => e.code === 'PLAN_INVALID', '把归一化计划回传必须被拒 —— 这正是 R1-b 的根因');
  assert.equal(p4mod.validatePlan(plan, { approval, nowMs: Date.now() }).roundId, plan.roundId);
});

test('R3-a worker 时钟默认真实 Date.now：缺 deps.now 不再抛 TypeError', async () => {
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      plan, approval: syntheticApproval(), verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: APPROVAL_TTL_MS
    }, { db: tr.db, emit: (v) => { out = v; } });
    assert.notEqual(out, null, '应产出输出而非抛错');
    assert.equal(out.outcome, 'initialized', JSON.stringify(out).slice(0, 200));
  } finally { tr.restore(); }
});

test('R3-b 凭据期限严格校验：缺失 / NaN / Infinity 一律拒绝（不再跳过）', async () => {
  const cases = [
    ['缺失 expiresAtMs', { secretId: 'S', secretKey: 'K', sessionToken: 'T' }],
    ['NaN', { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Number.NaN }],
    ['Infinity', { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Number.POSITIVE_INFINITY }],
    ['非数字', { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: 'later' }]
  ];
  for (const [label, credential] of cases) {
    const tr = installSyntheticSdkTransport({});
    try {
      let out = null;
      await worker.run({
        credential,
        plan: syntheticPlan(), approval: syntheticApproval(),
        verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: APPROVAL_TTL_MS
      }, { db: tr.db, emit: (v) => { out = v; } });
      assert.equal(out.errorCode, worker.ERR.CREDENTIAL_SHAPE_INVALID, label + ' 应被拒');
      assert.equal(tr.seen.length, 0, label + ' 时零读取');
    } finally { tr.restore(); }
  }
});

test('R3-c 私有 stdin 入口存在，且载荷字段受限（含 sdkRoot 被拒）', () => {
  assert.equal(typeof worker.main, 'function', '必须有 main 入口');
  assert.equal(typeof worker.readBoundedStdin, 'function');
  assert.equal(typeof worker.MAX_STDIN_BYTES, 'number');
  assert.deepEqual(worker.ALLOWED_PAYLOAD_FIELDS.slice().sort(),
    ['approval', 'approvalExpiresAtMs', 'credential', 'fixedNowMs', 'plan', 'verifiedCaller'],
    'S2：批准到期时刻是执行期复核的必需绑定项');
  for (const extra of [{ sdkRoot: '/evil' }, { script: '/evil.js' }, { cwd: '/evil' }]) {
    const payload = Object.assign(
      { credential: { secretId: 'S' }, plan: {}, approval: {} }, extra);
    const r = worker.pickPayload(JSON.stringify(payload));
    assert.equal(r.ok, false, Object.keys(extra).join() + ' 应被拒');
    assert.equal(r.errorCode, worker.ERR.STDIN_INVALID);
  }
  assert.equal(worker.pickPayload(JSON.stringify({
    credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T' },
    plan: { roundId: 'R' }, approval: { approvedBy: 'X' }
  })).ok, true);
});

test('R3-d stdin 有界：超出字节上限即拒绝，不无界读取', async () => {
  const { Readable } = require('node:stream');
  const big = 'x'.repeat(worker.MAX_STDIN_BYTES + 64);
  const r = await worker.readBoundedStdin(Readable.from([big]), worker.MAX_STDIN_BYTES);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'STDIN_TOO_LARGE');
});

/**
 * R3-e：worker 作为**真实子进程**可运行（有界 stdin → 单次 JSON 输出）。
 *
 * 直接运行原固定 worker 路径（保留其相对 `require`）。上一版曾把 worker 复制到
 * 临时目录再启动，破坏了相对依赖，失败在**模块加载阶段**（`Cannot find module`），
 * 并非 worker 业务路径失败 —— 该做法已纠正。
 *
 * 曾把观察到的 EBUSY 归因为「Codex 审查时装入的网络拒绝钩子连带影响」——
 * 该归因**无依据并已撤回**（钩子只在其自身 Node 进程内修改模块对象，
 * 不改磁盘库、系统网络或全局 Node 配置）。**该EBUSY 的原因至今未判定。**
 * 本宿主能否启动子进程是**逐次运行的环境条件**：不同环境结果不互相替代
 * （有的环境 74/74 含本项通过，有的环境本项显式跳过）。
 *
 * 按「不冒充通过」原则：能跑就跑并全断言；跑不了就**显式 skip 并如实记录
 * 该时点的原始错误**，不预设任何原因，不用替身假装真实入口已验证。
 */
test('R3-e worker 作为真实子进程可运行（有界 stdin → 单次 JSON 输出）', (t) => {
  const { spawnSync } = require('node:child_process');
  const payload = JSON.stringify({
    credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() - 1 },
    plan: syntheticPlan(), approval: syntheticApproval(),
    verifiedCaller: true, fixedNowMs: Date.now(),
    approvalExpiresAtMs: APPROVAL_TTL_MS
  });
  /**
   * R3-e（2026-10-10 更正）：**直接运行原固定 worker 路径**，保留其相对 require。
   *
   * 上一版把 worker 复制到临时目录再启动，破坏了 `./sandbox-primary-bootstrap.cjs`
   * 等相对依赖，失败发生在**模块加载阶段**（`Cannot find module`），
   * 并非 worker 业务路径失败。
   *
   * 同时撤回上一版的 EBUSY 归因：当时探针显示「spawnSync 对任意 node 都 EBUSY」，
   * 被归因为「Codex 审查装入的网络拒绝钩子跨进程残留」—— 该断言**无依据**。
   * 钩子只在它自身 Node 进程内改模块对象，进程结束即失效，不改磁盘库、
   * 系统网络或全局 Node 配置。Codex 2026-10-10 独立实测原路径 exit 0；
   * 本机复测亦为 exit 0 / stderr 0 字节。
   *
   * 若宿主真的无法启动，**如实记录该时点的错误原文**并显式 skip，
   * 不预设为任何原因（既不写「Codex 钩子残留」，也不写「文件被占用」）。
   * 能跑就跑并全断言；跑不了就写明「本轮未验证」，不用替身假装已验证。
   */
  const res = spawnSync(process.execPath, [host.FIXED.workerPath], {
    input: payload, encoding: 'utf8', timeout: 20000,
    env: { PATH: '', SystemRoot: process.env.SystemRoot || '' }
  });
  if (res.error !== undefined) {
    t.skip('本宿主此刻无法启动该子进程（原始错误如实记录）：' +
      String(res.error.message).slice(0, 200) +
      '；真实子进程入口本轮**未验证**，不以替身冒充。原因未判定。');
    return;
  }
  assert.equal(res.status, 0,
    '入口自身应正常退出：status=' + res.status + ' stderr=' + String(res.stderr).slice(0, 200));
  const out = JSON.parse(String(res.stdout).trim());
  assert.equal(out.errorCode, worker.ERR.CREDENTIAL_EXPIRED, String(res.stdout).slice(0, 200));
  assert.equal(String(res.stdout).trim().split('\n').length, 1);
  assert.equal(String(res.stdout).includes('SYNTH_TOKEN'), false);
});

test('R3-f 进程事实优先于 stdout：非零退出不得因 ok:true 被接受', async () => {
  const r = await host.runExecutionWorker({
    snapshot: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
    plan: syntheticPlan(), approval: syntheticApproval(), verifiedCaller: true,
    fixedNowMs: Date.now(), cwd: os.tmpdir(),
    spawn: () => {
      const { EventEmitter } = require('node:events');
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
      c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, outcome: 'initialized' })));
        c.emit('exit', 7, null);
        c.emit('close', 7, 'SIGTERM');
      });
      return c;
    },
    limits: { timeoutMs: 5000, maxOutputBytes: 65536, closeGraceMs: 20 }
  });
  assert.equal(r.ok, false, '非零退出不得被接受为成功');
  assert.equal(r.resultUnknown, true, '退出异常且已启动 → 结果未知');
  assert.equal(r.processFacts.exitCode, 7);
  assert.equal(r.processFacts.signal, 'SIGTERM');
});

test('R3-g 父层严格投影：worker 输出的未知字段一律丢弃', () => {
  const projected = host.projectWorkerOutput({
    ok: true, outcome: 'initialized', granted: true, initialized: true,
    observationConfirmed: true, auditId: 'sbx-init-primary:x',
    bootstrap: { ok: true, outcome: 'initialized', granted: true, initialized: true,
      auditId: 'sbx-init-primary:x', inputDigest: 'a'.repeat(32),
      existingPrimary: { status: 'active', sameAsTarget: true },
      errorCode: null, requestIds: [],
      SECRET_EXTRA_FIELD: 'SYNTHETIC_PRIVATE_TOKEN' },
    // N2：顶层 observationConfirmed=true 必须由 observed 的 present 支撑，
    // 否则聚合点判为矛盾。本用例验证「未知字段被丢弃」，故给出**自洽**的 observed，
    // 另在专用用例里单独验证矛盾降级。
    observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
      auditPresent: true, writeAuthorized: true, errorCode: null },
    secretId: 'SYNTH_ID', sessionToken: 'SYNTH_TOKEN',
    PRIVATE_MARKER: 'LEAK_ALPHA'
  }, { spawnError: false, timedOut: false, overflow: false, signal: null,
    exitCode: 0, closeNotObserved: false, terminationRequested: false,
    terminationConfirmed: true }, false, null,
  // S4（2026-10-10）：成功路径必须提供并精确匹配本计划的关键键/摘要。
  // 本用例验证的是**未知字段被丢弃**，故提供匹配的 expected；
  // 缺 expected 时的降级行为由 S4-c 单独覆盖。
  { auditId: 'sbx-init-primary:x', inputDigest: 'a'.repeat(32) });
  const dumped = JSON.stringify(projected);
  for (const leak of ['SYNTHETIC_PRIVATE_TOKEN', 'SYNTH_ID', 'SYNTH_TOKEN', 'LEAK_ALPHA',
    'SECRET_EXTRA_FIELD', 'PRIVATE_MARKER', 'secretId', 'sessionToken']) {
    assert.equal(dumped.includes(leak), false, '父层不得透传：' + leak);
  }
  assert.equal(projected.ok, true);
  assert.equal(projected.observationConfirmed, true);
  assert.equal('SECRET_EXTRA_FIELD' in projected.bootstrap, false);
});

test('R4-a 受控批准句柄不可 JSON 序列化，复制品不被接受', () => {
  const plan = syntheticPlan();
  const handle = syntheticApprovalSource(plan);
  assert.throws(() => JSON.stringify(handle), /不可序列化|not serializable|Circular/i,
    '句柄必须无法 JSON 序列化');
  const spread = Object.assign({}, handle);
  assert.equal(host.verifyControlledApproval({ approvalSource: spread, plan, now: () => Date.now() }).ok,
    false, '展开复制不得被接受');
  const forged = {
    controlled: true, planDigest: p4.inputDigest(plan),
    implementationFingerprint: host.computeImplementationFingerprint(),
    approvedBy: 'ME', writeScope: ['initializePrimary'], expiresAtMs: Date.now() + 1000,
    expectedSubjectDigest: 'a'.repeat(64)
  };
  const r = host.verifyControlledApproval({ approvalSource: forged, plan, now: () => Date.now() });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, host.ERR.APPROVAL_SOURCE_MISSING);
});

test('R4-b 批准先经 P4 完整校验：禁止字段 / 未登记字段 / 换目标都被拒', () => {
  const plan = syntheticPlan();
  const handle = syntheticApprovalSource(plan);
  const now = () => Date.now();
  const withSecret = Object.assign({}, plan, { mySecretField: 'x' });
  assert.equal(host.verifyControlledApproval({ approvalSource: handle, plan: withSecret, now }).ok,
    false, '含禁止字段须被 P4 校验拒绝');
  const otherPlan = Object.assign({}, plan, { targetUserId: 'u_' + 'c'.repeat(40) });
  assert.equal(host.verifyControlledApproval({ approvalSource: handle, plan: otherPlan, now }).ok,
    false, '目标未获批准须被拒');
  const extraField = Object.assign({}, plan, { undeclaredField: 1 });
  assert.equal(host.verifyControlledApproval({ approvalSource: handle, plan: extraField, now }).ok,
    false, '未登记字段须被拒');
  const disabled = Object.assign({}, plan, { enabled: false });
  assert.equal(host.verifyControlledApproval({ approvalSource: handle, plan: disabled, now }).ok, false);
});

test('R4-c 实现文件指纹按实际内容核对', () => {
  const plan = syntheticPlan();
  const handle = syntheticApprovalSource(plan);
  const crypto = require('node:crypto');
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  for (const name of host.FINGERPRINT_FILES) {
    const actual = crypto.createHash('sha256').update(
      fs2.readFileSync(path2.join(__dirname, '..', 'scripts', 'lib', name))).digest('hex');
    assert.equal(handle.implementationFingerprint[name], actual,
      name + ' 指纹应等于实际文件内容');
  }
  const srcText = fs2.readFileSync(path2.join(__dirname, '..', 'scripts', 'lib',
    'sandbox-primary-execution-host.cjs'), 'utf8');
  for (const name of host.FINGERPRINT_FILES) {
    assert.ok(srcText.includes(name), '清单项应真实存在：' + name);
  }
});

test('R4-d 结果保存：新建成功才记完成；保存失败保留 started 并停止', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    const saved = [];
    let r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: 'SYNTH-ROUND-0001',
      ...syntheticDirs('R4d'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], { db: tr.db }),
      persistRoundStarted: () => true,
      persistResult: (v) => { saved.push(v); return false; }
    });
    assert.equal(r.observationConfirmed, true, '前提：核对已确认');
    assert.equal(r.resultPersisted, false, '保存失败不得记为已持久化');
    assert.equal(saved.length, 1, '结果保存只尝试一次（禁止重试初始化）');
    assert.equal(saved[0].roundId, 'SYNTH-ROUND-0001');
    assert.equal(saved[0].auditId, r.auditId, '保存内容含确定性 auditId');
    assert.equal(saved[0].recordType, 'COMPLETED', '成功完成须显式标记终态类型');

    // S3-4（Codex 2026-10-10）：缺保存能力在**外部动作前**拒绝。
    // 此前完整链照样 commit=1，随后才说「未提供保存能力」。
    const before = tr.counts();
    r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: syntheticPlan().roundId,
      ...syntheticDirs('R4d2'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], { db: tr.db }),
      persistRoundStarted: () => true
      // 故意不提供 persistResult
    });
    assert.equal(r.errorCode, host.ERR.SAVE_CAPABILITY_MISSING,
      '缺保存能力须在发起写请求前拒绝：' + r.errorCode);
    assert.equal(r.stoppedAt, 'saveCapability');
    assert.equal(r.workerStarted, false, '未启动写 worker');
    const after = tr.counts();
    assert.equal(after.begin, before.begin, '缺保存能力时零事务开启');
    assert.equal(after.commit, before.commit, '缺保存能力时零提交');
    assert.equal(r.resultPersisted, undefined, '未走到保存，不谎称已保存');
  } finally { tr.restore(); }
});

test('R5-a 已有他人 primary：sameAsTarget 必须为 false', () => {
  const target = 'u_' + 'a'.repeat(40);
  const other = 'u_' + 'b'.repeat(40);
  const n = worker.normalizeBootstrapResult(
    { ok: true, outcome: 'alreadyPresent', existing: { userId: other, status: 'active' } },
    { targetUserId: target, auditId: 'sbx-init-primary:x' });
  assert.equal(n.existingPrimary.sameAsTarget, false,
    '另一个完全不同的合法 userId 不得被判为同一目标');
  const same = worker.normalizeBootstrapResult(
    { ok: true, outcome: 'alreadyPresent', existing: { userId: target, status: 'active' } },
    { targetUserId: target, auditId: 'sbx-init-primary:x' });
  assert.equal(same.existingPrimary.sameAsTarget, true);
  const noExpect = worker.normalizeBootstrapResult(
    { ok: true, outcome: 'alreadyPresent', existing: { userId: other, status: 'active' } });
  assert.equal(noExpect.existingPrimary.sameAsTarget, null);
});

test('R5-b 真实 32 位 inputDigest 被保留，非法长度被丢弃', () => {
  const p4mod = require('../scripts/lib/sandbox-primary-bootstrap.cjs');
  const plan = syntheticPlan();
  const realDigest = p4mod.inputDigest(plan);
  assert.equal(realDigest.length, 32, '核心摘要实测为 32 位十六进制');
  const kept = worker.normalizeBootstrapResult(
    { ok: true, outcome: 'initialized', granted: true, inputDigest: realDigest },
    { targetUserId: plan.targetUserId, auditId: 'sbx-init-primary:x' });
  assert.equal(kept.inputDigest, realDigest, '真实摘要不得被抹成 null');
  for (const bad of ['a'.repeat(64), 'a'.repeat(31), 'Z'.repeat(32), 123]) {
    const r = worker.normalizeBootstrapResult(
      { ok: true, outcome: 'initialized', inputDigest: bad },
      { targetUserId: plan.targetUserId, auditId: 'sbx-init-primary:x' });
    assert.equal(r.inputDigest, null, '非法摘要应被丢弃');
  }
});

test('R5-c 错误码白名单：未知大写码与 auditId 不匹配都被丢弃', () => {
  const plan = syntheticPlan();
  const expect = { targetUserId: plan.targetUserId, auditId: 'sbx-init-primary:expected' };
  assert.equal(worker.normalizeBootstrapResult(
    { ok: false, outcome: 'rejected', errorCode: 'RESULT_UNKNOWN' }, expect).errorCode,
    'RESULT_UNKNOWN');
  for (const fake of ['SYNTHETIC_PRIVATE_TOKEN', 'CREDENTIAL_FETCH_FAILED_XYZ', 'A'.repeat(64)]) {
    assert.equal(worker.normalizeBootstrapResult(
      { ok: false, outcome: 'rejected', errorCode: fake }, expect).errorCode, null,
      '白名单外码不得透出');
  }
  assert.equal(worker.normalizeBootstrapResult(
    { ok: true, outcome: 'initialized', auditId: 'sbx-init-primary:OTHER' }, expect).auditId, null);
  assert.equal(worker.normalizeBootstrapResult(
    { ok: true, outcome: 'initialized', auditId: expect.auditId }, expect).auditId, expect.auditId);
  assert.equal(worker.normalizeObserveResult({ state: 'present', errorCode: 'FAKE_CODE_X' }).errorCode, null);
});

test('R5-d observePrimary 正常返回 unconfirmed/inconsistent 也算未确认', () => {
  assert.equal(worker.isObservationConfirmed(
    { state: 'present', primaryPresent: true, auditPresent: true }), true);
  for (const bad of [
    { state: 'unconfirmed', primaryPresent: null, auditPresent: null },
    { state: 'inconsistent', primaryPresent: true, auditPresent: false },
    { state: 'absent', primaryPresent: false, auditPresent: false },
    { state: 'present', primaryPresent: true, auditPresent: false },
    null
  ]) {
    assert.equal(worker.isObservationConfirmed(bad), false,
      '未确认态不得判为已核对：' + JSON.stringify(bad));
  }
});

test('R5-e 事务失败也必须做只读核对并保留 auditId 与轮次', async () => {
  const tr = installSyntheticSdkTransport({});
  try {
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      plan: syntheticPlan(), approval: syntheticApproval(),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: APPROVAL_TTL_MS
    }, { db: tr.db, emit: (v) => { out = v; } });
    assert.equal(out.ok, false);
    assert.ok(out.auditId.startsWith(p4.AUDIT_ID_PREFIX), '失败路径须保留 auditId');
    assert.equal(out.roundId, syntheticPlan().roundId);
    const readOnly = tr.counts().readOnlyGet;
    assert.ok(readOnly >= 1, '事务失败后仍应只读核对，实际 ' + readOnly + ' 条');
  } finally { tr.restore(); }
});

test('R2 同批凭据注入隔离环境；错传 profile 时确实拿不到凭据', async () => {
  const readOnly = require('../scripts/lib/cloudbase-sdk-readonly-observer.cjs');
  const snapshot = { secretId: 'SID', secretKey: 'SK', sessionToken: 'ST' };
  const env = readOnly.buildIsolatedEnv({}, snapshot, 'C:/iso');
  assert.equal(env.TENCENTCLOUD_SECRETID, 'SID');
  assert.equal(env.TENCENTCLOUD_SECRETKEY, 'SK');
  assert.equal(env.TENCENTCLOUD_SESSIONTOKEN, 'ST');
  assert.equal(env.USERPROFILE, 'C:/iso');
  const bad = readOnly.buildIsolatedEnv({}, 'C:/profile', 'C:/cwd');
  assert.equal(bad.TENCENTCLOUD_SESSIONTOKEN, undefined,
    '错传 profile 时确实拿不到凭据（缺陷形态可复现）');
  const r = await host.verifyCallerSubject(snapshot, {
    spawn: () => { throw new Error('UNUSED'); },
    baseEnv: {}, isolationDir: 'C:/iso-does-not-exist'
  });
  assert.equal(r.ok, false, '隔离目录缺失须被守卫');
});

// ══════════════════════════════════════════════════════════════════════
// 第 3 组：Codex 复核 S1-S4 反例 + 成功对照
// 每条用**新断言**直接证明拒绝 / 零写 / 确定性键 / 绑定快照的实际结果，
// 不依赖任何旧脚本的 reproduced 标记。
// ══════════════════════════════════════════════════════════════════════

test('S1-a 调用方批准与绑定快照不同 → 送进 worker 的是绑定快照', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  let sentToWorker = null;
  try {
    const r = await host.executeOnce({
      plan,
      // 调用方自带的批准：approvedBy 与绑定句柄**不同**
      approval: { approvedUserIds: [plan.targetUserId],
        approvedBy: 'SYNTH_DIFFERENT_REVIEWER', approvedAt: new Date().toISOString() },
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(),
      roundId: plan.roundId,
      ...syntheticDirs('S1a'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], {
        db: tr.db,
        onPayload: (x) => { sentToWorker = x; }
      }),
      persistRoundStarted: () => true,
      persistResult: () => true
    });
    assert.notEqual(sentToWorker, null, '应已启动 worker');
    assert.equal(sentToWorker.approval.approvedBy, 'SYNTHETIC_REVIEWER_OFFLINE_ONLY',
      'worker 载荷必须取自绑定快照');
    assert.notEqual(sentToWorker.approval.approvedBy, 'SYNTH_DIFFERENT_REVIEWER',
      '未绑定的批准人不得被送进 worker');
    assert.equal(r.observationConfirmed, true, '正常成功链应保留：' + r.errorCode);
  } finally { tr.restore(); }
});

test('S1-b 句柄嵌套不可改写且处于冻结状态', () => {
  const plan = syntheticPlan();
  const handle = syntheticApprovalSource(plan);
  let writeRejected = false;
  try {
    handle.approval.approvedBy = 'SYNTH_TAMPERED_APPROVER';
  } catch (e) {
    writeRejected = /read only|Cannot assign|not extensible/i.test(String(e && e.message));
  }
  assert.equal(handle.approval.approvedBy,
    'SYNTHETIC_REVIEWER_OFFLINE_ONLY', '批准人必须保持签发时的值');
  assert.equal(Object.isFrozen(handle.approval), true, '嵌套批准必须冻结');
  assert.equal(Object.isFrozen(handle.plan), true, '内部计划快照必须冻结');
  assert.equal(Object.isFrozen(handle.implementationFingerprint), true, '指纹快照必须冻结');
  assert.equal(Object.isFrozen(handle.writeScope), true);
  assert.equal(writeRejected || Object.isFrozen(handle.approval), true);
  const r = host.verifyControlledApproval({ approvalSource: handle, plan, now: () => Date.now() });
  assert.equal(r.ok, true, '未改动的句柄仍应通过');
});

test('S1-c started 之后改计划 → 执行原绑定快照，改动值不落库', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  let sentToWorker = null;
  try {
    const mutablePlan = JSON.parse(JSON.stringify(plan));
    const r = await host.executeOnce({
      plan: mutablePlan,
      approval: syntheticApproval(plan),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(),
      roundId: plan.roundId,
      ...syntheticDirs('S1c'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], {
        db: tr.db,
        onPayload: (x) => { sentToWorker = x; }
      }),
      persistRoundStarted: () => {
        // 在异步边界之后改调用方持有的计划对象
        mutablePlan.operatorRef = 'SYNTH_TAMPERED_OPERATOR_REF';
        return true;
      },
      persistResult: () => true
    });
    assert.notEqual(sentToWorker, null, '应已启动 worker');
    assert.equal(sentToWorker.plan.operatorRef, plan.operatorRef,
      'worker 必须收到绑定快照里的 operatorRef');
    assert.notEqual(sentToWorker.plan.operatorRef, 'SYNTH_TAMPERED_OPERATOR_REF',
      '回调里改的值不得落进执行载荷');
    assert.equal(r.observationConfirmed, true, 'errorCode=' + r.errorCode);
  } finally { tr.restore(); }
});

test('S2-a 事务中途过期 → 零 set/commit 且不报成功', async () => {
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    let clockMs = Date.now();
    let out = null;
    // 在 SDK 的**读取动作事件**上推进合成时钟（不按 now() 次数猜测）
    tr.setHook((action) => {
      if (action === 'database.getInTransaction' || action === 'database.getDocument') {
        clockMs += 7200000; // 推进 2 小时：跨越凭据与批准期限
      }
    });
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + 3600000 },
      // S2-4（Codex 2026-10-10 更正）：原为 `syntheticApproval(plan)`，把**计划对象**
      // 当成 userId 传入（该函数需要目标字符串）→ 入口即 WORKER_APPROVAL_INVALID，
      // begin=0、SDK 事件=0，用例却因「零写 + ok=false」而通过，实际从未走到读取。
      // 现用正确夹具，并断言读取**确实发生**（下方 begin/readOnlyGet）。
      plan, approval: syntheticApproval(plan.targetUserId), verifiedCaller: true,
      fixedNowMs: Date.now(), approvalExpiresAtMs: Date.now() + 3600000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const c = tr.counts();
    // 前提断言：确实进入了事务并发生了读取（否则本用例无意义）
    assert.equal(c.begin, 1, '应真实开启事务：' + JSON.stringify(c));
    assert.equal(c.userGet, 1, '应真实读取 users：' + JSON.stringify(c));
    // 时钟在首个读取事件推进 → 守卫在该读之后立刻阻断，
    // 因此不会再有 primary/audit 的事务内读取（fail-fast，不是漏读）。
    assert.ok(c.primaryGet + c.auditGet <= 2);
    assert.equal(c.primarySet, 0, '过期后不得写 primary：' + JSON.stringify(c));
    assert.equal(c.auditSet, 0, '过期后不得写审计：' + JSON.stringify(c));
    assert.equal(c.commit, 0, '过期后不得提交：' + JSON.stringify(c));
    assert.equal(c.abort, 1, '过期后应真实回滚：' + JSON.stringify(c));
    assert.equal(out.ok, false, '过期后不得报成功');
  } finally { tr.restore(); }
});

test('S2-b 入口即过期 → 零 begin', async () => {
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    let out = null;
    const plan = syntheticPlan();
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + 3600000 },
      plan, approval: syntheticApproval(plan), verifiedCaller: true,
      fixedNowMs: Date.now(),
      approvalExpiresAtMs: Date.now() - 1
    }, { db: tr.db, emit: (v) => { out = v; } });
    assert.equal(tr.counts().begin, 0, '入口即过期不得开启事务');
    assert.equal(out.ok, false);
  } finally { tr.restore(); }
});

test('S2-c 缺批准期限 → 拒绝且零读取', async () => {
  const tr = installSyntheticSdkTransport({});
  try {
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
      plan: syntheticPlan(), approval: syntheticApproval(),
      verifiedCaller: true, fixedNowMs: Date.now()
      // 故意不传 approvalExpiresAtMs
    }, { db: tr.db, emit: (v) => { out = v; } });
    assert.equal(out.errorCode, worker.ERR.APPROVAL_INVALID, '缺批准期限须拒绝：' + out.errorCode);
    assert.equal(tr.seen.length, 0, '拒绝前零读取');
  } finally { tr.restore(); }
});

test('S3-a worker 超时 → 仍保留轮次与确定性 auditId', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const expectedAuditId = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const started = [];
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('S3a'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      // S3-1：注入已建好的 db，使默认核对路径走真实 P4 observePrimary 两读
      reconcileDeps: { db: tr.db },
      persistRoundStarted: (v) => { started.push(v); return true; },
      persistResult: (v) => { saves.push(v); return true; },
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(r.errorCode, host.ERR.RESULT_UNKNOWN);
    assert.equal(r.resultUnknown, true);
    assert.equal(r.auditId, expectedAuditId,
      '超时时审计键须为本计划确定性键：' + r.auditId);
    assert.equal(r.roundId, plan.roundId, '轮次必须保留');
    assert.equal(started.length, 1);
    assert.equal(started[0].auditId, expectedAuditId,
      'started 须保存确定性审计键，不依赖子进程输出');
    // S3-2（Codex 2026-10-10）：未知结果也要落盘，类型显式区分，不覆盖既有记录
    assert.equal(saves.length, 1, '未知终态应独立保存一次');
    assert.equal(saves[0].recordType, 'RESULT_UNKNOWN');
    assert.equal(saves[0].auditId, expectedAuditId);
    assert.equal(saves[0].roundId, plan.roundId);
    assert.equal(r.unknownPersisted, true);
    // S3-1：同批凭据仍有效 → 必须真正走两条固定只读核对
    assert.equal(r.reconcileAttempted, true,
      '超时且凭据有效时必须核对：' + JSON.stringify(r.reconcileSkipReason || null));
    assert.equal(tr.counts().readOnlyGet, 2,
      '核对须是两条固定读取：' + JSON.stringify(tr.counts()));
    // 无第二次初始化、无第二批凭据
    assert.equal(tr.counts().begin, 0, '不得再次进入初始化');
    assert.equal(captured.credentialFetches, 1, '不得取第二批凭据');
  } finally { tr.restore(); }
});

test('S3-b 退出码 0 但 stdout 坏 JSON → 结果未知', async () => {
  const r = await host.runExecutionWorker({
    snapshot: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 60000 },
    plan: syntheticPlan(), approval: syntheticApproval(), verifiedCaller: true,
    fixedNowMs: Date.now(), approvalExpiresAtMs: Date.now() + 60000,
    cwd: os.tmpdir(),
    spawn: () => {
      const { EventEmitter } = require('node:events');
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
      c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from('{ not json at all'));
        c.emit('exit', 0, null); c.emit('close', 0, null);
      });
      return c;
    },
    limits: { timeoutMs: 5000, maxOutputBytes: 65536, closeGraceMs: 20 }
  });
  assert.equal(r.ok, false);
  assert.equal(r.resultUnknown, true,
    '退出码 0 不证明提交结果；坏输出须保守留作待核对');
  assert.equal(r.reason, 'MALFORMED_OUTPUT');
});

test('S3-c worker 声明 resultUnknown → 父层不得覆盖为 false', () => {
  const r = host.projectWorkerOutput(
    { ok: false, errorCode: 'RESULT_UNKNOWN', resultUnknown: true,
      outcome: 'UNKNOWN', granted: false, initialized: false, observationConfirmed: false },
    { spawnError: false, timedOut: false, overflow: false, signal: null,
      exitCode: 0, closeNotObserved: false, terminationRequested: false,
      terminationConfirmed: true },
    false, null, { auditId: 'sbx-init-primary:x', inputDigest: 'a'.repeat(32) });
  assert.equal(r.resultUnknown, true, 'worker 声明的未知必须被保守合并');
});

test('S4-a 已知字段内的非法值一律丢弃', () => {
  const marker = 'SYNTH_PRIVATE_MARKER';
  const expected = { auditId: 'sbx-init-primary:expected', inputDigest: 'a'.repeat(32) };
  const facts = { spawnError: false, timedOut: false, overflow: false, signal: null,
    exitCode: 0, closeNotObserved: false, terminationRequested: false,
    terminationConfirmed: true };
  const r = host.projectWorkerOutput({
    ok: true, outcome: marker, granted: true, initialized: true,
    observationConfirmed: true, auditId: 'sbx-init-primary:expected',
    bootstrap: {
      ok: true, outcome: marker, granted: true, initialized: true,
      auditId: 'sbx-init-primary:expected', inputDigest: marker,
      errorCode: marker, requestIds: [marker],
      existingPrimary: { status: marker, sameAsTarget: 'yes' }
    },
    observed: {
      state: marker, primaryPresent: 'true', primaryStatus: marker,
      auditPresent: 'no', writeAuthorized: true, errorCode: marker
    }
  }, facts, false, null, expected);
  assert.equal(JSON.stringify(r).includes(marker), false,
    '已知字段内的非法值不得保留：' + JSON.stringify(r).slice(0, 200));
  assert.equal(r.outcome, 'UNKNOWN');
  assert.equal(r.bootstrap.outcome, 'UNKNOWN');
  assert.equal(r.bootstrap.inputDigest, null);
  assert.equal(r.bootstrap.errorCode, null);
  assert.deepEqual(r.bootstrap.requestIds, []);
  assert.equal(r.bootstrap.existingPrimary.status, 'unknown');
  assert.equal(r.bootstrap.existingPrimary.sameAsTarget, null);
  assert.equal(r.observed.state, 'unconfirmed');
  assert.equal(r.observed.primaryPresent, null);
  assert.equal(r.observed.primaryStatus, null);
  assert.equal(r.observed.errorCode, null);
  assert.equal(r.observed.writeAuthorized, false, '只读观察永不成为写授权');
});

test('S4-b 正常值必须通过（不得把成功状态错误净化掉）', () => {
  const auditId = 'sbx-init-primary:expected';
  const digest = 'a'.repeat(32);
  const rid = '00000000-0000-4000-8000-000000000001';
  const facts = { spawnError: false, timedOut: false, overflow: false, signal: null,
    exitCode: 0, closeNotObserved: false, terminationRequested: false,
    terminationConfirmed: true };
  const r = host.projectWorkerOutput({
    ok: true, errorCode: null, resultUnknown: false, outcome: 'initialized',
    granted: true, initialized: true, observationConfirmed: true, auditId,
    bootstrap: { ok: true, outcome: 'initialized', granted: true, initialized: true,
      auditId, inputDigest: digest, errorCode: null, requestIds: [rid],
      existingPrimary: null },
    observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
      auditPresent: true, writeAuthorized: true, errorCode: null },
    observeFailed: false
  }, facts, false, null, { auditId, inputDigest: digest });
  assert.equal(r.ok, true, '正常成功链不得被净化掉');
  assert.equal(r.outcome, 'initialized');
  assert.equal(r.auditId, auditId);
  assert.equal(r.bootstrap.inputDigest, digest);
  assert.deepEqual(r.bootstrap.requestIds, [rid]);
  assert.equal(r.observed.state, 'present');
  assert.equal(r.observed.primaryStatus, 'active');
});

test('S4-c 审计键仅前缀相同 → 不采信', () => {
  const facts = { spawnError: false, timedOut: false, overflow: false, signal: null,
    exitCode: 0, closeNotObserved: false, terminationRequested: false,
    terminationConfirmed: true };
  const r = host.projectWorkerOutput({
    ok: true, outcome: 'initialized', granted: true, initialized: true,
    observationConfirmed: true,
    auditId: 'sbx-init-primary:OTHER_KEY_SAME_PREFIX',
  }, facts, false, null,
  { auditId: 'sbx-init-primary:expected', inputDigest: 'a'.repeat(32) });
  assert.equal(r.auditId, null,
    '仅前缀相同不够，必须与本计划确定性键精确一致');
});

test('S4-d 凭据失败类别走实际枚举（不是大写正则）', () => {
  const hostCodes = new Set(Object.values(require('../scripts/lib/cloudbase-cli-credential-host.cjs').ERR));
  assert.equal(host.CREDENTIAL_FAILURE_CODES.size, hostCodes.size);
  for (const c of hostCodes) {
    assert.equal(host.CREDENTIAL_FAILURE_CODES.has(c), true, '应含宿主码：' + c);
  }
  assert.equal(host.CREDENTIAL_FAILURE_CODES.has('SYNTHETIC_ARBITRARY_TOKEN'), false);
  assert.equal(host.CREDENTIAL_FAILURE_CODES.has('A'.repeat(64)), false);
});

test('S-成功对照：S1-S4 收尾后完整正向链仍成立', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const expectedAuditId = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(plan),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('SOK'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], { db: tr.db }),
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const c = tr.counts();
    assert.equal(r.status, host.STATUS.PLAN_READY, JSON.stringify({
      stoppedAt: r.stoppedAt, errorCode: r.errorCode, incomplete: r.incomplete }));
    assert.equal(r.outcome, 'initialized');
    assert.equal(r.initialized, true);
    assert.equal(r.observationConfirmed, true);
    assert.equal(r.resultPersisted, true);
    assert.equal(r.auditId, expectedAuditId);
    assert.equal(saves[0].auditId, expectedAuditId);
    assert.notEqual(r.resultUnknown, true);
    assert.equal(c.begin, 1);
    assert.equal(c.primarySet, 1);
    assert.equal(c.auditSet, 1);
    assert.equal(c.commit, 1);
    assert.equal(c.abort, 0);
    assert.equal(c.readOnlyGet, 2);
    assert.equal(captured.credentialFetches, 1);
  } finally { tr.restore(); }
});

// ══════════════════════════════════════════════════════════════════════
// 第 4 组：Codex 2026-10-10 复核 S2/S3/S4 剩余项反例 + 成功对照
// 每条用**新断言**直接证明零写 / 两读 / 确定性键 / 绑定一致性的实际结果。
// 三种期限**分别**只让一种过期，其余保持有效（Codex §2.1 要求）。
// ══════════════════════════════════════════════════════════════════════

test('S2-1a 仅计划到期 → 零 set/commit 且不报成功（Codex 样本 4）', async () => {
  const plan = syntheticPlan();
  // 目标期限 5 秒；凭据与批准给 1 小时。每次动作推进 20 秒：
  // 只跨过目标期限，不会把另外两种也跨过（Codex §2.1「分别只让一种过期」）。
  const planToUse = Object.assign({}, plan, {
    expiresAt: new Date(Date.now() + 5000).toISOString()
  });
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    let clockMs = Date.now();
    // 只在**读取**事件推进：确保确实读到 users 之后才越界（不是开事务就拦下）
    tr.setHook((action) => {
      if (action === 'database.getDocument' || action === 'database.getInTransaction') {
        clockMs += 20000;
      }
    });
    let out = null;
    await worker.run({
      // 凭据与批准都给足余量：只让计划先到期
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + 3600000 },
      plan: planToUse, approval: syntheticApproval(planToUse.targetUserId),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: Date.now() + 3600000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const c = tr.counts();
    // 前提断言：确实走到了读取（Codex §2.4 要求，不能只断言零写）
    assert.equal(c.begin, 1, '应已开启事务：' + JSON.stringify(c));
    assert.ok(c.userGet >= 1, '应真实读取：' + JSON.stringify(c));
    assert.equal(c.primarySet, 0, '计划过期后不得写 primary：' + JSON.stringify(c));
    assert.equal(c.auditSet, 0, '计划过期后不得写审计：' + JSON.stringify(c));
    assert.equal(c.commit, 0, '计划过期后不得提交：' + JSON.stringify(c));
    assert.equal(out.ok, false, '计划过期后不得报成功');
    // 三种期限各自如实报告（此前 planExpiredDuringRun 实为批准期限，会误报）
    assert.equal(out.planExpiredDuringRun, true, '应报告计划已过期');
    assert.equal(out.credentialExpiredDuringRun, false, '凭据未过期不得误报');
  } finally { tr.restore(); }
});

test('S2-1b 仅凭据到期 → 零 set/commit（对照）', async () => {
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    let clockMs = Date.now();
    // 凭据 5 秒后过期；计划与批准给 1 小时。每次推进 20 秒，只跨过凭据。
    tr.setHook(() => { clockMs += 20000; });
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + 5000 },
      plan, approval: syntheticApproval(plan.targetUserId),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: Date.now() + 3600000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const c = tr.counts();
    assert.equal(c.primarySet, 0, JSON.stringify(c));
    assert.equal(c.auditSet, 0, JSON.stringify(c));
    assert.equal(c.commit, 0, JSON.stringify(c));
    assert.equal(out.credentialExpiredDuringRun, true, '应报告凭据已过期');
    assert.equal(out.planExpiredDuringRun, false, '计划未过期不得误报');
    assert.equal(out.ok, false);
  } finally { tr.restore(); }
});

test('S2-1c 仅批准到期 → 零 set/commit 且用独立固定码（对照）', async () => {
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    let clockMs = Date.now();
    // 批准 5 秒后过期；凭据与计划给 1 小时。每次推进 20 秒，只跨过批准。
    tr.setHook(() => { clockMs += 20000; });
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + 3600000 },
      plan, approval: syntheticApproval(plan.targetUserId),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: Date.now() + 5000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const c = tr.counts();
    assert.equal(c.primarySet, 0, JSON.stringify(c));
    assert.equal(c.auditSet, 0, JSON.stringify(c));
    assert.equal(c.commit, 0, JSON.stringify(c));
    assert.equal(out.approvalExpiredDuringRun, true, '应报告批准已过期');
    assert.equal(out.planExpiredDuringRun, false, '计划未过期不得误报');
    assert.equal(out.credentialExpiredDuringRun, false, '凭据未过期不得误报');
    // P4 会把守卫抛错统一包成 RESULT_UNKNOWN（核心既有行为，不改核心）；
    // 实际期限归因由本层的 deadlineBreach 如实记录。
    assert.ok(out.deadlineBreach && typeof out.deadlineBreach.code === 'string',
      '应记录越界的实际期限：' + JSON.stringify(out.deadlineBreach));
    assert.equal(out.deadlineBreach.code, worker.ERR.APPROVAL_EXPIRED,
      '批准过期用独立固定码：' + JSON.stringify(out.deadlineBreach));
  } finally { tr.restore(); }
});

test('S2-2 begin 事件过期 → 保留句柄并真实回滚（Codex 样本 8）', async () => {
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    let clockMs = Date.now();
    // 只在 begin 事件推进 → 后置复核越界
    tr.setHook((action) => {
      if (action === 'database.startTransaction') clockMs += 7200000;
    });
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + 3600000 },
      plan, approval: syntheticApproval(plan.targetUserId),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: Date.now() + 3600000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const c = tr.counts();
    assert.equal(c.begin, 1, 'begin 应已发生：' + JSON.stringify(c));
    // 关键：句柄不丢，必须真实回滚
    assert.equal(c.abort, 1, 'begin 后过期必须尝试回滚（句柄不得遗失）：' + JSON.stringify(c));
    assert.equal(c.primarySet, 0, JSON.stringify(c));
    assert.equal(c.commit, 0, JSON.stringify(c));
    assert.equal(out.ok, false);
  } finally { tr.restore(); }
});

test('S2-3 回读期间凭据过期 → 停止后续读、保留提交事实、不报成功（Codex 样本 9）', async () => {
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    let clockMs = Date.now();
    // 只在**非事务回读**（readOnlyGet 的第一条）推进
    let hits = 0;
    tr.setHook((action, params) => {
      if (action === 'database.getDocument' && !params.transactionId) {
        hits++;
        if (hits === 1) clockMs += 7200000;
      }
    });
    let out = null;
    await worker.run({
      credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T',
        expiresAtMs: Date.now() + 3600000 },
      plan, approval: syntheticApproval(plan.targetUserId),
      verifiedCaller: true, fixedNowMs: Date.now(),
      approvalExpiresAtMs: Date.now() + 3600000
    }, { db: tr.db, now: () => clockMs, emit: (v) => { out = v; } });
    const c = tr.counts();
    // 提交本身合规：事实保留
    assert.equal(c.commit, 1, '提交应已完成：' + JSON.stringify(c));
    assert.equal(out.initialized, true, '提交事实不得被抹去');
    // 过期后不得再发第二条读取
    assert.equal(c.readOnlyGet, 1, '过期后应停止后续读取：' + JSON.stringify(c));
    assert.equal(out.observationExpiredDuringRead, true, '应标记核对期间过期');
    assert.equal(out.ok, false, '核对未完成不得报成功');
    assert.equal(out.observationConfirmed, false);
  } finally { tr.restore(); }
});

test('S3-1 超时路径走真实两条只读核对，不靠可选回调（Codex 样本 11）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    // 不传 reconcileReadOnly：默认路径必须自己接通
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('S31'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(r.reconcileAttempted, true,
      '默认核对能力应接通：' + JSON.stringify(r.reconcileSkipReason || null));
    assert.equal(tr.counts().readOnlyGet, 2, '必须是两条固定读取');
    // 无第二次初始化、无第二批凭据
    assert.equal(tr.counts().begin, 0);
    assert.equal(captured.credentialFetches, 1);
  } finally { tr.restore(); }
});

test('S3-2 凭据过期时明确跳过核对，不补取另一批（Codex §2.3 要求）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({});
  let clockMs = Date.now();
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      // 核对时点已越过凭据期限（CLI 替身给 now+30min）
      // 时钟在 worker 启动后才推进：凭据/批准在此之前都是有效的，
      // 推进后越过凭据期限（CLI 替身给 now+30min），核对必须跳过。
      now: () => clockMs, roundId: plan.roundId,
      ...syntheticDirs('S33'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: (bin, argv, options) => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        clockMs += 3600000; // worker 已启动后才推进：越过凭据期限
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: false, errorCode: 'RESULT_UNKNOWN', resultUnknown: true,
            outcome: 'UNKNOWN', granted: false, initialized: false,
            observationConfirmed: false, credentialExpiredDuringRun: true
          })));
          c.emit('exit', 0, null); c.emit('close', 0, null);
        });
        return c;
      },
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: () => true
    });
    assert.equal(r.reconcileAttempted, false, '凭据过期不得核对');
    assert.equal(r.reconcileSkipReason, 'CREDENTIAL_EXPIRED_NO_RECONCILE');
    assert.equal(tr.counts().readOnlyGet, 0, '零核对读取');
    assert.equal(captured.credentialFetches, 1, '不得补取第二批凭据');
  } finally { tr.restore(); }
});

test('S3-3 未知终态独立保存、不记为完成、类型显式区分（Codex 样本 11）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({});
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('S32'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; },
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(saves.length, 1, '未知终态应保存一次');
    assert.equal(saves[0].recordType, 'RESULT_UNKNOWN');
    assert.notEqual(saves[0].recordType, 'COMPLETED');
    assert.equal(saves[0].resultUnknown, true);
    assert.equal(saves[0].auditId, p4.auditId(plan, p4.inputDigest(plan)));
    // 保留核对结论与进程事实，不随进程丢失
    assert.ok('reconcile' in saves[0]);
    assert.ok('workerProcess' in saves[0]);
    assert.equal(r.unknownPersisted, true);
    assert.equal(r.resultPersisted, undefined, '不得记为已完成');
  } finally { tr.restore(); }
});

test('S3-4 核对返回值逐字段逐值净化，恶意额外字段不入报告（Codex 样本 12）', async () => {
  const marker = 'SYNTH_PRIVATE_MARKER';
  const expected = { auditId: 'sbx-init-primary:expected', inputDigest: 'a'.repeat(32) };
  const clean = host.projectReconcile({
    ok: true, state: marker, primaryPresent: 'true', primaryStatus: marker,
    auditPresent: 'no', auditId: expected.auditId, inputDigest: marker,
    errorCode: marker, extra: marker
  }, expected);
  assert.equal(JSON.stringify(clean).includes(marker), false,
    '净化后不得残留任意文本：' + JSON.stringify(clean));
  assert.equal(clean.state, 'unconfirmed');
  assert.equal(clean.primaryPresent, null);
  assert.equal(clean.primaryStatus, null);
  assert.equal(clean.errorCode, null);
  // 正常值通过（不得把成功状态错误净化掉）
  const good = host.projectReconcile({
    state: 'present', primaryPresent: true, primaryStatus: 'active',
    auditPresent: true, auditId: expected.auditId, inputDigest: expected.inputDigest
  }, expected);
  assert.equal(good.state, 'present');
  assert.equal(good.primaryStatus, 'active');
  assert.equal(good.auditId, expected.auditId);
  assert.equal(good.inputDigest, expected.inputDigest);
  // 摘要/审计键不属于本计划 → 归 null，不据回调自述采信
  const other = host.projectReconcile({
    state: 'present', primaryPresent: true, primaryStatus: 'active', auditPresent: true,
    auditId: 'sbx-init-primary:OTHER', inputDigest: 'b'.repeat(32)
  }, expected);
  assert.equal(other.auditId, null);
  assert.equal(other.inputDigest, null);
});

test('S3-5 executeOnce 核对路径不采信注入回调的额外字段', async () => {
  const marker = 'SYNTH_LEAK_MARKER';
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({});
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('S35'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      // 合成回调谎称核对成功并夹带标记
      reconcileReadOnly: () => ({
        ok: true, state: 'present', primaryPresent: true, primaryStatus: 'active',
        auditPresent: true, extra: marker
      }),
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(JSON.stringify(r).includes(marker), false,
      '注入回调的额外字段不得进入报告：' + JSON.stringify(r.reconcile));
    // 缺少本计划审计归属与摘要 → 不得判为核对确认
    assert.equal(r.reconcileConfirmed, false,
      '无本计划审计归属的回调不得确认核对：' + JSON.stringify(r.reconcile));
  } finally { tr.restore(); }
});

test('S3-6 缺保存能力在发写请求前被拒（Codex 样本 13）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('S34'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], { db: tr.db }),
      persistRoundStarted: () => true
      // 故意不提供 persistResult
    });
    assert.equal(r.errorCode, host.ERR.SAVE_CAPABILITY_MISSING);
    assert.equal(r.stoppedAt, 'saveCapability');
    assert.equal(r.workerStarted, false, '不得启动写 worker');
    const c = tr.counts();
    assert.equal(c.begin, 0, '零事务：' + JSON.stringify(c));
    assert.equal(c.commit, 0, '零提交：' + JSON.stringify(c));
  } finally { tr.restore(); }
});

test('S4-1 关键键/摘要属于另一计划 → 不得判成功（Codex 样本 14）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    // 合成 worker：干净退出 + ok=true，但审计键与摘要属于另一计划
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('S41'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: (bin, argv, options) => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: true, errorCode: null, resultUnknown: false,
            outcome: 'initialized', granted: true, initialized: true,
            observationConfirmed: true,
            auditId: 'sbx-init-primary:ANOTHER_PLAN_KEY',
            bootstrap: {
              ok: true, outcome: 'initialized', granted: true, initialized: true,
              auditId: 'sbx-init-primary:ANOTHER_PLAN_KEY',
              inputDigest: 'f'.repeat(32), errorCode: null, requestIds: []
            },
            observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
              auditPresent: true, writeAuthorized: true, errorCode: null },
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
    // 不匹配 → 降级为未确认，进入保守核对；不仅丢值后采信成功
    assert.equal(r.observationConfirmed, false,
      '绑定不匹配不得判为已核对：' + JSON.stringify({
        ok: r.ok, initialized: r.initialized, incomplete: r.incomplete
      }));
    assert.equal(r.status, host.STATUS.FAILED);
    assert.notEqual(saves.length && saves[0].recordType, 'COMPLETED',
      '不得把绑定不匹配的结果保存为完成');
    // 报告里不得出现另一计划的键
    assert.equal(JSON.stringify(r).includes('ANOTHER_PLAN_KEY'), false,
      '不属于本计划的审计键不得进入报告');
  } finally { tr.restore(); }
});

test('S4-2 正常成功链（含精确匹配的键/摘要）继续通过', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditId = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('S42'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: (bin, argv, options) => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: true, errorCode: null, resultUnknown: false,
            outcome: 'initialized', granted: true, initialized: true,
            observationConfirmed: true, auditId,
            bootstrap: {
              ok: true, outcome: 'initialized', granted: true, initialized: true,
              auditId, inputDigest: digest, errorCode: null, requestIds: []
            },
            observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
              auditPresent: true, writeAuthorized: true, errorCode: null },
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
    assert.equal(r.status, host.STATUS.PLAN_READY, JSON.stringify({
      stoppedAt: r.stoppedAt, errorCode: r.errorCode, incomplete: r.incomplete
    }));
    assert.equal(r.observationConfirmed, true, '正常值不得被错误净化掉');
    assert.equal(r.resultPersisted, true);
    assert.equal(saves[0].recordType, 'COMPLETED');
    assert.equal(saves[0].auditId, auditId);
  } finally { tr.restore(); }
});

// ══════════════════════════════════════════════════════════════════════
// 第 5 组：Codex 2026-10-10 二次复核 N1/N2 定点反例 + 真实 P4 正向对照
// N1：父进程核对期间的同批凭据时效（用事件屏障推进时钟，不靠 now() 次数）
// N2：绑定/状态聚合一致性（顶层成功必须与 bootstrap/observed 自洽）
// ══════════════════════════════════════════════════════════════════════

test('N1-a 父进程核对：第一读事件凭据过期 → 只读 1 条且不确认', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  let clockMs = Date.now();
  try {
    // 事件屏障：在真实 SDK 第一条**非事务回读**（primary）发生时推进时钟
    let readOnlyHits = 0;
    tr.setHook((action, params) => {
      if (action === 'database.getDocument' && !params.transactionId) {
        readOnlyHits++;
        if (readOnlyHits === 1) clockMs += 3600000; // 越过本批凭据期限
      }
    });
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => clockMs, roundId: plan.roundId,
      ...syntheticDirs('N1a'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    const c = tr.counts();
    assert.equal(c.readOnlyGet, 1, '过期后不得再发第二条读取：' + JSON.stringify(c));
    assert.equal(r.reconcileConfirmed, false, '过期不得确认核对结论');
    assert.equal(r.observationConfirmed, false, '过期不得标记已核对');
    assert.ok(r.reconcileExpiredAtStage, '应记录过期发生的阶段：' + JSON.stringify(r.reconcile));
    assert.equal(r.reconcile.state, 'unconfirmed');
    // 保留未知终态与进程事实
    assert.equal(r.resultUnknown, true);
    assert.equal(r.status, host.STATUS.FAILED);
    // 不重新取凭据、不重新初始化
    assert.equal(captured.credentialFetches, 1);
    assert.equal(c.begin, 0);
  } finally { tr.restore(); }
});

test('N1-b 父进程核对：凭据有效 → 真实两条读取并按真实记录确认（对照）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' },
    // 合成库中已存在本计划的 primary 与审计 → P4 observePrimary 应判 present
    schtest_v1_app_admins: {
      _id: p4.PRIMARY_ID, userId: SYN_TARGET, status: 'active'
    },
    schtest_v1_audit_events: (() => {
      const aid = p4.auditId(plan, p4.inputDigest(plan));
      return {
        _id: aid, subjectUserId: plan.targetUserId, action: p4.AUDIT_ACTION,
        roundId: plan.roundId, envId: p4.FIXED_ENV_ID, evidenceId: plan.evidenceId,
        inputDigest: p4.inputDigest(plan)
      };
    })()
  });
  try {
    let readOnlyHits = 0;
    tr.setHook((action, params) => {
      if (action === 'database.getDocument' && !params.transactionId) readOnlyHits++;
    });
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N1b'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    const c = tr.counts();
    assert.equal(readOnlyHits, 2, '有效凭据下应是两条真实读取：' + JSON.stringify(c));
    assert.equal(c.readOnlyGet, 2);
    assert.equal(r.reconcileExpiredAtStage, undefined, '凭据有效不应记过期');
    // 真实 P4 observePrimary 走通（readOnlyGet=2 即已证明进入了核心契约）
    assert.equal(r.reconcileAttempted, true);
    assert.notEqual(r.reconcile.source, undefined, '应记录结论来源');
    // 按真实记录决定是否确认：不得因 source 是 P4 就无条件确认
    assert.equal(r.reconcileConfirmed,
      r.reconcile.state === 'present' && r.reconcile.selfConsistent === true,
      '确认必须与真实记录一致：' + JSON.stringify(r.reconcile));
    // P4 不返回 inputDigest —— 不得因此被误判为矛盾
    assert.equal(r.reconcile.inputDigest, null, 'P4 不返回摘要，净化后应为 null');
    assert.notEqual(r.reconcile.contradiction, 'INPUT_DIGEST_MISMATCH',
      '不得因缺失摘要而判矛盾：' + JSON.stringify(r.reconcile));
  } finally { tr.restore(); }
});

test('N1-c 父进程核对：注入路径同样受同批凭据时效约束', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({});
  let clockMs = Date.now();
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => clockMs, roundId: plan.roundId,
      ...syntheticDirs('N1c'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      // 注入回调在返回「present」前把时钟推过凭据期限
      reconcileReadOnly: () => {
        clockMs += 3600000;
        return {
          state: 'present', primaryPresent: true, primaryStatus: 'active',
          auditPresent: true, auditId: p4.auditId(plan, p4.inputDigest(plan))
        };
      },
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(r.reconcileConfirmed, false, '凭据过期后注入的 present 也不得确认');
    assert.ok(r.reconcileExpiredAtStage, '应记录过期阶段');
    assert.equal(r.observationConfirmed, false);
  } finally { tr.restore(); }
});

test('N2-a 他计划键/摘要 → 撤销未验证的 initialized/granted 并真正进入核对', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2a'),
      spawn: syntheticCliSpawn(captured),
      // 合成 worker：干净退出 + 自报成功，但键与摘要属于**另一计划**
      spawnWorker: (bin, argv, options) => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
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
          })));
          c.emit('exit', 0, null); c.emit('close', 0, null);
        });
        return c;
      },
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    // 未验证的授予/初始化必须撤销
    assert.equal(r.initialized, false, '不得采信他计划回执自报的 initialized');
    assert.equal(r.granted, false, '不得采信他计划回执自报的 granted');
    assert.equal(r.observationConfirmed, false);
    // **真正**进入核对：两读
    assert.equal(r.reconcileAttempted, true,
      '绑定不匹配必须进入保守核对：' + JSON.stringify(r.reconcileSkipReason || null));
    assert.equal(tr.counts().readOnlyGet, 2, '保守核对应是两条读取');
    assert.equal(r.resultUnknown, true, '执行是否发生仍不确定');
    // 保存载荷不得声称 initialized
    assert.equal(saves.length, 1);
    assert.notEqual(saves[0].recordType, 'COMPLETED');
    assert.equal(saves[0].initialized, false, '保存载荷不得声称已初始化');
    assert.equal(saves[0].granted, false);
    // 报告不得含他计划键
    assert.equal(JSON.stringify(r).includes('ANOTHER_PLAN_KEY'), false);
  } finally { tr.restore(); }
});

test('N2-b 键/摘要精确匹配但观察矛盾 → 不保存 COMPLETED', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const boundAuditId = p4.auditId(plan, p4.inputDigest(plan));
  const boundDigest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2b'),
      spawn: syntheticCliSpawn(captured),
      // 键/摘要精确匹配，但 bootstrap 与 observed 全部否认成功
      spawnWorker: (bin, argv, options) => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: true, errorCode: null, resultUnknown: false,
            outcome: 'initialized', granted: true, initialized: true,
            observationConfirmed: true, auditId: boundAuditId,
            bootstrap: {
              ok: false, outcome: 'UNKNOWN', granted: false, initialized: false,
              auditId: boundAuditId, inputDigest: boundDigest, errorCode: null, requestIds: []
            },
            observed: { state: 'unconfirmed', primaryPresent: false, primaryStatus: 'disabled',
              auditPresent: false, writeAuthorized: true, errorCode: null },
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
    // 顶层自报成功但组合矛盾 → 必须降级
    assert.equal(r.observationConfirmed, false,
      'bootstrap/observed 否认成功时不得判已核对');
    assert.equal(r.initialized, false);
    assert.equal(r.status, host.STATUS.FAILED, JSON.stringify({
      stoppedAt: r.stoppedAt, errorCode: r.errorCode, incomplete: r.incomplete
    }));
    // 保存载荷不得是 COMPLETED
    assert.equal(saves.length, 1);
    assert.notEqual(saves[0].recordType, 'COMPLETED',
      '矛盾结果不得保存为 COMPLETED：' + saves[0].recordType);
    assert.equal(saves[0].observationConfirmed, false);
  } finally { tr.restore(); }
});

test('N2-c reconcile 存在性/摘要矛盾 → 不确认（注入路径自洽校验）', async () => {
  const marker = 'SYNTH_LEAK_MARKER';
  const plan = syntheticPlan();
  const boundAuditId = p4.auditId(plan, p4.inputDigest(plan));
  // 单元级：state=present 但存在性为 false → 组合矛盾
  const contradictory = host.projectReconcile({
    state: 'present', primaryPresent: false, primaryStatus: 'active',
    auditPresent: false, auditId: boundAuditId, extra: marker
  }, { auditId: boundAuditId, inputDigest: p4.inputDigest(plan) }, { source: 'INJECTED' });
  assert.equal(contradictory.state, 'inconsistent',
    '组合矛盾必须降级：' + JSON.stringify(contradictory));
  assert.equal(contradictory.selfConsistent, false);
  assert.equal(contradictory.contradiction, 'PRESENCE_CONTRADICTS_PRESENT');
  assert.equal(JSON.stringify(contradictory).includes(marker), false, '私密标记仍须丢弃');

  // present 但 status 非 active → 同样矛盾
  const badStatus = host.projectReconcile({
    state: 'present', primaryPresent: true, primaryStatus: 'disabled',
    auditPresent: true, auditId: boundAuditId
  }, { auditId: boundAuditId, inputDigest: p4.inputDigest(plan) }, { source: 'INJECTED' });
  assert.equal(badStatus.state, 'inconsistent');
  assert.equal(badStatus.contradiction, 'STATUS_NOT_ACTIVE');

  // 真实 P4 契约形状（无 inputDigest、存在性自洽）→ 正常通过
  const p4Shaped = host.projectReconcile({
    state: 'present', reason: 'primary 与本计划的确定性审计均存在且内容一致（含 active 资格状态）。',
    primaryPresent: true, primaryUserId: plan.targetUserId, primaryStatus: 'active',
    auditId: boundAuditId, auditPresent: true, writeAuthorized: false,
    note: '本结果为只读观察，不构成新的写授权。'
  }, { auditId: boundAuditId, inputDigest: p4.inputDigest(plan) }, { source: 'P4_OBSERVE' });
  assert.equal(p4Shaped.state, 'present', '真实 P4 形状不得被误拒：' + JSON.stringify(p4Shaped));
  assert.equal(p4Shaped.selfConsistent, true);
  assert.equal(p4Shaped.inputDigest, null, 'P4 不返回摘要，不应判矛盾');
  assert.equal(p4Shaped.contradiction, null);
  assert.equal(p4Shaped.source, 'P4_OBSERVE');
});

test('N2-d executeOnce：矛盾 reconcile 不确认，且不重写不重新初始化', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2d'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      reconcileReadOnly: () => ({
        state: 'present', primaryPresent: false, primaryStatus: 'active',
        auditPresent: false, auditId: p4.auditId(plan, p4.inputDigest(plan))
      }),
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(r.reconcileConfirmed, false,
      '组合矛盾的 reconcile 不得确认：' + JSON.stringify(r.reconcile));
    assert.equal(r.observationConfirmed, false);
    assert.equal(r.reconcile.state, 'inconsistent');
    // 不重写、不重新初始化、不取第二批凭据
    assert.equal(tr.counts().begin, 0);
    assert.equal(captured.credentialFetches, 1);
  } finally { tr.restore(); }
});

test('N2-e 真实 P4 present 正向不回归（executeOnce 贯穿对照）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const boundAuditId = p4.auditId(plan, p4.inputDigest(plan));
  const boundDigest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2e'),
      spawn: syntheticCliSpawn(captured),
      // 键/摘要精确匹配 + bootstrap/observed 完全自洽的 present
      spawnWorker: (bin, argv, options) => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: true, errorCode: null, resultUnknown: false,
            outcome: 'initialized', granted: true, initialized: true,
            observationConfirmed: true, auditId: boundAuditId,
            bootstrap: {
              ok: true, outcome: 'initialized', granted: true, initialized: true,
              auditId: boundAuditId, inputDigest: boundDigest, errorCode: null, requestIds: []
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
    assert.equal(r.status, host.STATUS.PLAN_READY, JSON.stringify({
      stoppedAt: r.stoppedAt, errorCode: r.errorCode, incomplete: r.incomplete
    }));
    assert.equal(r.initialized, true, '自洽的 present 不得被误降级');
    assert.equal(r.granted, true);
    assert.equal(r.observationConfirmed, true);
    assert.equal(r.resultPersisted, true);
    assert.equal(saves[0].recordType, 'COMPLETED');
    assert.equal(saves[0].initialized, true);
  } finally { tr.restore(); }
});
// ══════════════════════════════════════════════════════════════════════
// 第 6 组：Codex 2026-10-10 三次复核 N1 异步等待 / N2 合法结果组合
// N1：异步注入回调必须 await（有效正向、事件屏障后过期、异步拒绝）
// N2：observed 非 active/缺状态不得确认；UNKNOWN outcome 与 initialized 冲突
//     不得保存 COMPLETED；合法已有记录分支与真实提交后回读失败须保留
// ══════════════════════════════════════════════════════════════════════

test('N1-c1 异步注入有效 present → 必须等待完成并可确认', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const boundAuditId = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSyntheticSdkTransport({});
  let callbackFinished = false;
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N1c1'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      // 合法**异步** present 结果：此前未 await，结果被丢失
      reconcileReadOnly: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        callbackFinished = true;
        return {
          state: 'present', primaryPresent: true, primaryStatus: 'active',
          auditPresent: true, auditId: boundAuditId
        };
      },
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(callbackFinished, true, '宿主必须等待回调真正完成');
    // 合法异步结果不得被误丢
    assert.equal(r.reconcile.state, 'present',
      '异步 present 应被接受：' + JSON.stringify(r.reconcile));
    assert.equal(r.reconcileConfirmed, true,
      '合法异步 present 应可确认：' + JSON.stringify(r.reconcile));
    assert.equal(r.reconcile.selfConsistent, true);
    assert.equal(r.reconcileExpiredAtStage, undefined);
  } finally { tr.restore(); }
});

test('N1-c2 异步回调内推进时钟越过期限 → 等待后做后置检查、停止确认', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const boundAuditId = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSyntheticSdkTransport({});
  let clockMs = Date.now();
  let released = false;
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => clockMs, roundId: plan.roundId,
      ...syntheticDirs('N1c2'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      // 事件屏障：宿主若未 await，收尾检查会在回调结束前跑完（拿到 null）
      reconcileReadOnly: async () => {
        await new Promise((resolve) => {
          released = true;
          setTimeout(resolve, 5);
        });
        // 回调**内部**推进时钟越过凭据期限
        clockMs += 3600000;
        return {
          state: 'present', primaryPresent: true, primaryStatus: 'active',
          auditPresent: true, auditId: boundAuditId
        };
      },
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(released, true, '屏障应被触发');
    // 后置时效检查必须在回调完成之后 → 应记录过期阶段
    assert.ok(r.reconcileExpiredAtStage,
      '回调内越期必须被后置检查捕获：' + JSON.stringify(r.reconcile));
    assert.equal(r.reconcileConfirmed, false, '过期不得确认');
    assert.equal(r.observationConfirmed, false);
    assert.equal(r.reconcile.state, 'unconfirmed');
  } finally { tr.restore(); }
});

test('N1-c3 异步注入 rejection → 纳入异常处理，不产生未处理拒绝、不确认', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({});
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N1c3'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn([], {}, { hang: true }),
      // 异步拒绝：此前同一 try/catch 捕获不到
      reconcileReadOnly: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('SYNTHETIC_ASYNC_REJECTION');
      },
      persistRoundStarted: () => true,
      persistResult: () => true,
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    // 让微任务队列排空，确认没有未处理拒绝
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.length, 0,
      '异步拒绝必须被捕获，不得成为未处理拒绝：' + JSON.stringify(unhandled.map(String)));
    assert.equal(r.reconcileConfirmed, false, '拒绝后不得确认');
    assert.equal(r.reconcile.state, 'unconfirmed');
    assert.equal(r.observationConfirmed, false);
    // 保留未知终态，不重写
    assert.equal(r.resultUnknown, true);
    assert.equal(tr.counts().begin, 0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    tr.restore();
  }
});

test('N2-c1 observed.primaryStatus=disabled → 不得确认、不得保存 COMPLETED', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2c1'),
      spawn: syntheticCliSpawn(captured),
      // 键/摘要、bootstrap 与其余字段全沿用成功对照，**只**改 observed.primaryStatus
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
              ok: true, outcome: 'initialized', granted: true, initialized: true,
              auditId: auditKey, inputDigest: digest, errorCode: null, requestIds: []
            },
            observed: { state: 'present', primaryPresent: true, primaryStatus: 'disabled',
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
    assert.equal(r.observationConfirmed, false,
      'primaryStatus=disabled 不得确认：' + JSON.stringify(r.observed));
    assert.equal(r.status, host.STATUS.FAILED);
    assert.equal(saves.length, 1);
    assert.notEqual(saves[0].recordType, 'COMPLETED',
      'disabled 不得保存 COMPLETED：' + saves[0].recordType);
    // 报告如实保留 disabled，不抹掉
    assert.equal(r.observed.primaryStatus, 'disabled');
  } finally { tr.restore(); }
});

test('N2-c2 observed 缺 primaryStatus → 不得确认、不得保存 COMPLETED', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2c2'),
      spawn: syntheticCliSpawn(captured),
      // **删除** observed.primaryStatus
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
              ok: true, outcome: 'initialized', granted: true, initialized: true,
              auditId: auditKey, inputDigest: digest, errorCode: null, requestIds: []
            },
            observed: { state: 'present', primaryPresent: true,
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
    assert.equal(r.observationConfirmed, false,
      '缺 primaryStatus 不得确认：' + JSON.stringify(r.observed));
    assert.equal(r.status, host.STATUS.FAILED);
    assert.notEqual(saves[0].recordType, 'COMPLETED',
      '缺状态不得保存 COMPLETED：' + saves[0].recordType);
    // 缺项如实呈现为 null，不伪造 active
    assert.equal(r.observed.primaryStatus, null);
  } finally { tr.restore(); }
});

test('N2-c3 outcome=UNKNOWN 且 initialized=true → 不得保存 COMPLETED', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2c3'),
      spawn: syntheticCliSpawn(captured),
      // 顶层与 bootstrap.outcome **同时**为 UNKNOWN，两层 initialized 仍 true
      spawnWorker: (bin, argv, options) => {
        const { EventEmitter } = require('node:events');
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: true, errorCode: null, resultUnknown: false,
            outcome: 'UNKNOWN', granted: true, initialized: true,
            observationConfirmed: true, auditId: auditKey,
            bootstrap: {
              ok: true, outcome: 'UNKNOWN', granted: true, initialized: true,
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
    assert.equal(r.status, host.STATUS.FAILED,
      'UNKNOWN outcome 不得判成功：' + r.status);
    assert.equal(saves.length, 1);
    assert.notEqual(saves[0].recordType, 'COMPLETED',
      'UNKNOWN + initialized 冲突不得保存 COMPLETED：' + saves[0].recordType);
  } finally { tr.restore(); }
});

test('N2-c4 真实 alreadyPresent 分支：零写、不重复授予、走保守核对（Codex §3 更正）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  /**
   * N2（Codex 2026-10-10 §3）：本用例改用**真实 worker/P4/SDK 转换**输出。
   *
   * 上一版手工构造 alreadyPresent + granted=true，并给 bootstrap 补上
   * auditId/inputDigest 冒充正向 —— 这不是实际既有分支：
   *  P4 initializePrimary 的「primary 已存在」分支返回
   *  granted=false、existing，**不返回 auditId/inputDigest**；
   *  worker normalizeBootstrapResult 不会凭空补出这两个字段。
   *
   * 真实行为（下方预置本计划自洽的既有 primary 与审计）：
   *  primarySet/auditSet/commit 均 0（零写）、abort=1（回滚）、
   *  outcome=alreadyPresent、initialized=false、granted=false；
   *  因缺 bootstrap 绑定字段而走**保守只读核对**，不保存 COMPLETED。
   *
   * 本用例断言的是**真实字段与真实终态**，不要求已有记录保存 COMPLETED，
   * 也不放宽已关闭的提交绑定检查。
   */
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' },
    schtest_v1_app_admins: { _id: p4.PRIMARY_ID, userId: SYN_TARGET, status: 'active' },
    schtest_v1_audit_events: {
      _id: auditKey, subjectUserId: plan.targetUserId, action: p4.AUDIT_ACTION,
      roundId: plan.roundId, envId: p4.FIXED_ENV_ID, evidenceId: plan.evidenceId,
      inputDigest: p4.inputDigest(plan)
    }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2c4'),
      spawn: syntheticCliSpawn(captured),
      // 真实 worker：走 P4 事务，命中既有 primary 后零写停止
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], { db: tr.db }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const c = tr.counts();
    // 真实零写：既不写审计也不提交，并真实回滚
    assert.equal(c.primarySet, 0, '已有 primary 不得重复写入：' + JSON.stringify(c));
    assert.equal(c.auditSet, 0, '已有 primary 不得写审计：' + JSON.stringify(c));
    assert.equal(c.commit, 0, '已有 primary 不得提交：' + JSON.stringify(c));
    assert.equal(c.abort, 1, '应真实回滚：' + JSON.stringify(c));
    // 真实字段：outcome=alreadyPresent、不重复授予
    assert.equal(r.outcome, 'alreadyPresent', '真实 outcome：' + r.outcome);
    assert.equal(r.initialized, false, '已有记录不是本轮初始化');
    assert.equal(r.granted, false, 'P4 已有分支 granted=false，不得制造 granted=true');
    // bootstrap 不含绑定字段 → 父层不得据此判完整初始化成功
    assert.equal(r.bootstrap.auditId, null,
      '真实 alreadyPresent 不含 auditId，父层应归 null：' + JSON.stringify(r.bootstrap.auditId));
    assert.equal(r.bootstrap.bindingMatched, false);
    // 终态：保守停止 / 未知，**不**保存 COMPLETED
    assert.notEqual(saves.length ? saves[0].recordType : null, 'COMPLETED',
      '已有记录分支不得保存为完整初始化成功：' + (saves.length ? saves[0].recordType : null));
    assert.equal(r.status, host.STATUS.FAILED, JSON.stringify({
      status: r.status, errorCode: r.errorCode, outcome: r.outcome
    }));
  } finally { tr.restore(); }
});

test('N2-c4b alreadyPresent 却 granted=true → 损坏协议，不得当正向（Codex §3）', () => {
  // 反例：P4 真实 alreadyPresent 绝不 granted=true。手工构造该组合时
  // 父层必须按损坏协议拒绝，不得保存为完整初始化成功。
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const facts = {
    spawnError: false, timedOut: false, overflow: false, signal: null,
    exitCode: 0, closeNotObserved: false, terminationRequested: false,
    terminationConfirmed: true
  };
  const r = host.projectWorkerOutput({
    ok: true, errorCode: null, resultUnknown: false,
    outcome: 'alreadyPresent', granted: true, initialized: false,
    observationConfirmed: true, auditId: auditKey,
    bootstrap: {
      ok: true, outcome: 'alreadyPresent', granted: true, initialized: false,
      auditId: auditKey, inputDigest: digest, errorCode: null, requestIds: []
    },
    observed: { state: 'present', primaryPresent: true, primaryStatus: 'active',
      auditPresent: true, writeAuthorized: false, errorCode: null },
    observeFailed: false
  }, facts, false, null, { auditId: auditKey, inputDigest: digest });
  const codes = r.stateContradictions || [];
  assert.equal(r.ok, false, 'alreadyPresent+granted=true 不得判成功');
  assert.equal(r.granted, false, '不得保留伪造的 granted');
  assert.equal(r.initialized, false);
  assert.equal(r.fullInitializationSuccess, false);
  assert.equal(r.commitFactEstablished, false,
    '已有分支不得确立「提交事实」（它是零写停止，不是提交）');
  assert.ok(codes.indexOf('ALREADY_PRESENT_CLAIMS_GRANT') !== -1,
    '应记录 ALREADY_PRESENT_CLAIMS_GRANT：' + JSON.stringify(codes));
});test('N2-c5 正常初始化（initialized + active present）→ 不回归', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2c5'),
      spawn: syntheticCliSpawn(captured),
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
              ok: true, outcome: 'initialized', granted: true, initialized: true,
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
    assert.equal(r.status, host.STATUS.PLAN_READY, JSON.stringify({
      stoppedAt: r.stoppedAt, errorCode: r.errorCode, incomplete: r.incomplete
    }));
    assert.equal(r.initialized, true);
    assert.equal(r.granted, true);
    assert.equal(r.observationConfirmed, true);
    assert.equal(saves[0].recordType, 'COMPLETED');
  } finally { tr.restore(); }
});

test('N2-c6 真实提交后回读失败 → 保留可绑定的提交事实，不误判为未写', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  // 事务两写一提交**真实发生**，随后只读回读失败 —— 提交事实必须保留。
  // failIf 用 onAction 钩子实现：只在**非事务** database.getDocument
  // （即只读核对的两条读取）时抛错；事务内的读写不受影响。
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  }, null, {
    onAction: (action, params) => {
      if (action === 'database.getDocument' && !params.transactionId) {
        throw Object.assign(new Error('SYNTHETIC_READBACK_FAILED'),
          { code: 'SYNTHETIC_READBACK_FAILED' });
      }
    }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2c6'),
      spawn: syntheticCliSpawn(captured),
      // 真实 worker 事务提交成功，但回读 unconfirmed（observeFailed=true）
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], { db: tr.db }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const c = tr.counts();
    // 真实事务：两写一提交
    assert.equal(c.primarySet, 1, '真实提交应保留：' + JSON.stringify(c));
    assert.equal(c.auditSet, 1, JSON.stringify(c));
    assert.equal(c.commit, 1, JSON.stringify(c));
    // 提交事实保留（未被回读失败抹成零写）
    assert.equal(r.initialized, true,
      '回读失败不得抹去已发生的提交事实：' + JSON.stringify({
        initialized: r.initialized, outcome: r.outcome
      }));
    assert.equal(r.outcome, 'initialized');
    assert.equal(r.auditId, auditKey);
    // 但回读未确认 → 不报成功、不保存完成
    assert.equal(r.observationConfirmed, false,
      '回读失败不得确认：' + JSON.stringify(r.observed));
    assert.notEqual(saves.length ? saves[0].recordType : null, 'COMPLETED');
    // 不重写
    assert.equal(c.primarySet, 1, '不得重试初始化');
  } finally { tr.restore(); }
});

test('N2-c7 legalOutcomeFor：只有三个真实 outcome 合法', () => {
  for (const ok of ['initialized', 'alreadyPresent', 'auditAlreadyPresent']) {
    assert.equal(host.legalOutcomeFor(ok), true, '应合法：' + ok);
  }
  for (const bad of ['UNKNOWN', 'rejected', 'present', '', null, undefined, 123]) {
    assert.equal(host.legalOutcomeFor(bad), false,
      '非法 outcome 须被拒：' + JSON.stringify(bad));
  }
});
// ══════════════════════════════════════════════════════════════════════
// 第 7 组：Codex 2026-10-10 四次复核 §2 —— 四个仍被保存为完成的组合
// 起点为同一「合法成功载荷」，保持本计划 auditId/inputDigest 与 active/present
// 观察，分别替换顶层与 bootstrap 的同名字段，贯穿 executeOnce 至保存回调。
// 四例均无数据库读写：验证的是父层对损坏 worker 协议的处理，
// 不声称真实 worker 或云端曾产生这些组合。
// ══════════════════════════════════════════════════════════════════════

/** 构造「除 outcome/initialized/granted 外全部合法」的成功基底。 */
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

/**
 * §2 共用断言：无论 outcome/布尔如何搭配，**observationConfirmed=true 的观察
 * 都不能把「本轮初始化已完成」抬升为保存 COMPLETED**。
 */
function assertNotSavedAsComplete(r, saves, label, expectedCode) {
  assert.notEqual(saves.length ? saves[0].recordType : null, 'COMPLETED',
    label + '：不得保存为完整初始化成功，实际 ' + (saves.length ? saves[0].recordType : null));
  assert.equal(r.initialized, false,
    label + '：不得声称已初始化');
  assert.equal(r.granted, false,
    label + '：不得声称已授予');
  assert.equal(r.observationConfirmed, false,
    label + '：观察确认不得独立放行');
  assert.equal(r.status, host.STATUS.FAILED, label + '：终态应为 FAILED');
  if (expectedCode) {
    assert.ok((r.stateContradictions || []).indexOf(expectedCode) !== -1 ||
      JSON.stringify(r).indexOf(expectedCode) !== -1,
      label + '：应记录 ' + expectedCode + '，实际 ' + JSON.stringify(r.stateContradictions));
  }
}

test('N2-d1 outcome=UNKNOWN（两层）+ initialized/granted=false → 不得保存完成', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2d1'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: makeSuccessShapedWorker('UNKNOWN', false, false),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    assertNotSavedAsComplete(r, saves, 'unknown-false-flags', 'UNKNOWN_OR_MISSING_OUTCOME');
    // 无数据库读写
    assert.equal(tr.counts().begin, 0, JSON.stringify(tr.counts()));
  } finally { tr.restore(); }
});

test('N2-d2 outcome=initialized 但 initialized/granted=false → 不得保存完成', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2d2'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: makeSuccessShapedWorker('initialized', false, false),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    assertNotSavedAsComplete(r, saves, 'initialized-denies-flags',
      'INITIALIZED_OUTCOME_WITHOUT_INITIALIZED_FLAG');
    assert.equal(tr.counts().begin, 0, JSON.stringify(tr.counts()));
  } finally { tr.restore(); }
});

test('N2-d3 outcome=auditAlreadyPresent + initialized/granted=false → 冲突停止不得抬升', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2d3'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: makeSuccessShapedWorker('auditAlreadyPresent', false, false),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    // 关键：即使随后观察到有效记录（observationConfirmed 由基底给出），
    // 也**不得**把 P4 的「审计在而 primary 缺」冲突停止提升为初始化完成。
    assertNotSavedAsComplete(r, saves, 'audit-only-confirmed');
    assert.equal(tr.counts().begin, 0, JSON.stringify(tr.counts()));
  } finally { tr.restore(); }
});

test('N2-d4 outcome=alreadyPresent + granted=true → 不得保存完成（损坏协议）', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2d4'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: makeSuccessShapedWorker('alreadyPresent', false, true),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    assertNotSavedAsComplete(r, saves, 'already-present-claims-grant',
      'ALREADY_PRESENT_CLAIMS_GRANT');
    assert.equal(r.granted, false, 'P4 已有分支绝不 granted=true');
    assert.equal(tr.counts().begin, 0, JSON.stringify(tr.counts()));
  } finally { tr.restore(); }
});

test('N2-d5 顶层与 bootstrap 不一致（outcome 不同）→ 不得保存完成', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const digest = p4.inputDigest(plan);
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2d5'),
      spawn: syntheticCliSpawn(captured),
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
    assertNotSavedAsComplete(r, saves, 'top-bootstrap-outcome-mismatch',
      'BOOTSTRAP_OUTCOME_MISMATCH');
  } finally { tr.restore(); }
});

test('N2-d6 真实 P4 正常初始化正向对照 → 仍保存 COMPLETED', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
  const auditKey = p4.auditId(plan, p4.inputDigest(plan));
  const tr = installSyntheticSdkTransport({
    schtest_v1_users: { _id: SYN_TARGET, status: 'active', openid: 'synthetic-offline-openid' }
  });
  const saves = [];
  try {
    const r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      now: () => Date.now(), roundId: plan.roundId,
      ...syntheticDirs('N2d6'),
      spawn: syntheticCliSpawn(captured),
      // 真实 worker/P4/SDK：两写一提交 + 两条回读
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], { db: tr.db }),
      reconcileDeps: { db: tr.db },
      persistRoundStarted: () => true,
      persistResult: (v) => { saves.push(v); return true; }
    });
    const c = tr.counts();
    assert.equal(r.status, host.STATUS.PLAN_READY, JSON.stringify({
      stoppedAt: r.stoppedAt, errorCode: r.errorCode, incomplete: r.incomplete
    }));
    assert.equal(r.outcome, 'initialized');
    assert.equal(r.initialized, true);
    assert.equal(r.granted, true);
    assert.equal(r.observationConfirmed, true);
    assert.equal(r.auditId, auditKey);
    assert.equal(saves[0].recordType, 'COMPLETED');
    assert.equal(c.primarySet, 1, JSON.stringify(c));
    assert.equal(c.auditSet, 1, JSON.stringify(c));
    assert.equal(c.commit, 1, JSON.stringify(c));
    assert.equal(c.abort, 0, JSON.stringify(c));
    assert.equal(c.readOnlyGet, 2, JSON.stringify(c));
  } finally { tr.restore(); }
});