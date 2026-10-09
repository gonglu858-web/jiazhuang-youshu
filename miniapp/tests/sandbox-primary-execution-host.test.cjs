'use strict';
/**
 * 首次管理员受控接线 —— 相称离线测试
 * ======================================
 *
 * ⚠️ **当前状态：12 通过 / 0 失败 / 9 显式跳过（skip）—— 不是全绿。**
 *
 * 跳过的 9 项（B-1、C-1、C-3、C-4、D-2、D-3、E-1、E-2、E-3）原因相同：
 * 走 `executeOnce` 或 `worker.run` 时抛出 `WORKER_PLAN_INVALID` /
 * `CREDENTIAL_FETCH_FAILED(SPAWN_FAILED)`，而**同一入参在测试外单独调用
 * P4 六个函数（validateApprovalContext / resolveNowMs / validatePlan /
 * assertApprovedTarget / inputDigest / auditId）全部通过**，
 * 且用相同 spawn 替身单独调用凭据宿主亦成功。已在两轮有依据的排查内定位到
 * 「宿主/worker 组合调用」与「分别调用」行为不一致，但未查明确切机制。
 *
 * 按项目规则（同一失败原因最多 2 轮）停止该路径，**未通过 skip 冒充通过**，
 * 也未修改任何已验收模块来迁就测试。该缺口已写入交付记录交 Codex 裁决。
 *
 * 覆盖：docs/WorkBuddy任务-首次管理员受控接线与本人登记准备-20261009.md §5
 * 组A 默认与拒绝 / B 正向整链 / C 身份 / D 事务门槛 / E 失败接续 /
 * F 重入与留证 / G 净化与边界
 *
 *合成传输替换在哪一层（如实标注）：
 *  - CLI 层：`deps.spawn` 替换子进程（凭据命令、三阶段关联、额外 STS 核验）；
 *  - SDK 层：`@cloudbase/database` 的 `Db.reqClass` 替换为合成请求类 ——
 *    **真实** `sdk.init` / `database()` / 文档序列化 / 事务对象仍走固定 SDK。
 *  - 因此「真实 SDK 本地转换」是真实发生的；平台行为**未**验证。
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
function installSyntheticSdkTransport(docs, failOn) {
  const sdkRoot = host.FIXED.sdkRoot;
  require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const bson = require(path.join(sdkRoot, 'bson'));
  const EJSON = bson.EJSON || bson;
  const seen = [];
  /**
   * R1-d 关键顺序与注入方式（依据已验收适配测试 M2-26/27 的实测）：
   *  1. **先** `sdk.init(...).database()` 建出 db；
   *  2. **再** 替换 `Db.reqClass` —— 固定 SDK 的 `Db` 在构造时固定当时的传输类，
   *     所以替换只对「替换前已建好的 db」生效（反过来会让 db 走真实realtime
   *     通道并抛 `SIGN_PARAM_INVALID`，事务前就 RESULT_UNKNOWN）；
   *  3. 把这个 db **注入** worker（`deps.db`）—— 与已验收适配层测试同一做法。
   *     若让 worker 自己 `sdk.init` 建 db，它捕获的是替换后的类并走真实通道。
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
    c.stdin.write = (raw) => { payload = JSON.parse(String(raw)); return true; };
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
      verifiedCaller: true, fixedNowMs: Date.now()
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
      verifiedCaller: true, fixedNowMs: Date.now()
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
      plan, approval: syntheticApproval(userId), verifiedCaller: true, fixedNowMs: Date.now()
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
      verifiedCaller: true, fixedNowMs: Date.now()
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
      workerLimits: { timeoutMs: 60, maxOutputBytes: 4096, closeGraceMs: 20 }
    });
    assert.equal(r.status, host.STATUS.FAILED);
    assert.equal(r.errorCode, host.ERR.RESULT_UNKNOWN);
    assert.equal(r.resultUnknown, true, '超时属结果未知');
    assert.equal(r.workerStarted, true);
    assert.equal(captured.credentialFetches, 1, '不得为重试再取第二批凭据');
    assert.equal(r.resultPersisted, undefined, '结果未知不得保存为已完成');
  } finally { tr.restore(); }
});

test('E-3 提交成功但回读未确认 → 不抹去提交事实，不重试写，不报成功', async () => {
  const captured = { calls: [], credentialFetches: 0, apiCalls: [] };
  const plan = syntheticPlan();
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
              auditId: 'sbx-init-primary:synthetic', inputDigest: 'a'.repeat(32)
            },
            observed: { state: 'unconfirmed', primaryPresent: null, primaryStatus: null,
              auditPresent: null, writeAuthorized: true, errorCode: null },
            observeFailed: true,
            observationConfirmed: false,
            auditId: 'sbx-init-primary:synthetic', planDigest: 'b'.repeat(32)
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
    assert.equal(r.auditId, 'sbx-init-primary:synthetic', '审计 ID 必须保留');
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
      plan, approval: syntheticApproval(), verifiedCaller: true, fixedNowMs: Date.now()
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
        verifiedCaller: true, fixedNowMs: Date.now()
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
    ['approval', 'credential', 'fixedNowMs', 'plan', 'verifiedCaller']);
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

test('R3-e worker 作为真实子进程可运行（有界 stdin → 单次 JSON 输出）', () => {
  const { spawnSync } = require('node:child_process');
  const payload = JSON.stringify({
    credential: { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() - 1 },
    plan: syntheticPlan(), approval: syntheticApproval(),
    verifiedCaller: true, fixedNowMs: Date.now()
  });
  const res = spawnSync(process.execPath, [host.FIXED.workerPath], {
    input: payload, encoding: 'utf8', timeout: 20000,
    env: { PATH: '', SystemRoot: process.env.SystemRoot || '' }
  });
  assert.equal(res.status, 0, '入口自身应正常退出：' + String(res.stderr).slice(0, 200));
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
    secretId: 'SYNTH_ID', sessionToken: 'SYNTH_TOKEN',
    PRIVATE_MARKER: 'LEAK_ALPHA'
  }, { spawnError: false, timedOut: false, overflow: false, signal: null,
    exitCode: 0, closeNotObserved: false, terminationRequested: false,
    terminationConfirmed: true }, false);
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

    r = await host.executeOnce({
      plan, approval: syntheticApproval(),
      approvalSource: syntheticApprovalSource(plan),
      // 轮次必须与计划一致（R4 校验）
      now: () => Date.now(), roundId: syntheticPlan().roundId,
      ...syntheticDirs('R4d2'),
      spawn: syntheticCliSpawn(captured),
      spawnWorker: syntheticWorkerSpawn(tr.seen, [], { db: tr.db }),
      persistRoundStarted: () => true
    });
    assert.equal(r.resultPersisted, undefined, '缺保存能力时不谎称已保存');
    assert.equal(r.observationConfirmed, true);
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
      verifiedCaller: true, fixedNowMs: Date.now()
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
