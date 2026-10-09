'use strict';
/**
 * 首次管理员受控执行 worker（固定 SDK + 已验收适配器 + P4 核心）
 * =====================================================
 *
 * 范围（任务 docs/WorkBuddy任务-首次管理员受控接线与本人登记准备-20261009.md §4.3）
 *  - 固定 node-sdk 2.10.0 / database 1.4.1；`sdk.init({env,region,secretId,secretKey,
 *    sessionToken,debug:false})`。**不安装**，不用 `new sdk()`，不用 token别名。
 *  - 先用 P4 的计划/批准校验、`inputDigest`、`auditId` 生成绑定值，**再**创建适配器；
 *    不自造第二套主键或摘要算法。
 *  - 调用既有 `initializePrimary`：用户 active/派生一致；primary及本计划审计不存在；
 *    期限有效；事务内新增 primary 与审计。只读 users，写集合只限测试
 *    app_admins/audit_events。
 *
 * 凭据：只经**私有 stdin 管道**一次传入随即关闭；不进命令行/环境/磁盘/日志。
 * 输出：只投影固定错误码/状态/计数/摘要/合法请求 ID；**不透传**原始 error、
 * message/stack、OPENID 或凭据。
 *
 * 边界：本模块**不**自行获取凭据、不联网决策；调用方（宿主）负责同批凭据与身份核验。
 */

const crypto = require('node:crypto');
const path = require('node:path');

const p4 = require('./sandbox-primary-bootstrap.cjs');
const adapterFactory = require('./sandbox-primary-sdk-adapter.cjs');

// ── 固定值（与已验收模块一致，不重新定义） ──────────────────────────────────
const FIXED_APP_ID = p4.FIXED_APP_ID;
const FIXED_ENV_ID = p4.FIXED_ENV_ID;
const FIXED_REGION = adapterFactory.FIXED_REGION;
const SDK_ROOT = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
const PRIMARY_ID = p4.PRIMARY_ID;
const AUDIT_ID_PREFIX = p4.AUDIT_ID_PREFIX;

/** 本 worker 的固定错误码（只投影这些，不透传任意值）。 */
const ERR = Object.freeze({
  STDIN_INVALID: 'WORKER_STDIN_INVALID',
  CREDENTIAL_MISSING: 'WORKER_CREDENTIAL_MISSING',
  CREDENTIAL_SHAPE_INVALID: 'WORKER_CREDENTIAL_SHAPE_INVALID',
  CREDENTIAL_EXPIRED: 'WORKER_CREDENTIAL_EXPIRED',
  PLAN_EXPIRED: 'WORKER_PLAN_EXPIRED',
  SDK_UNAVAILABLE: 'WORKER_SDK_UNAVAILABLE',
  PLAN_INVALID: 'WORKER_PLAN_INVALID',
  APPROVAL_INVALID: 'WORKER_APPROVAL_INVALID',
  INITIALIZE_REJECTED: 'WORKER_INITIALIZE_REJECTED',
  OBSERVE_REJECTED: 'WORKER_OBSERVE_REJECTED',
  OUTPUT_SERIALIZE_FAILED: 'WORKER_OUTPUT_SERIALIZE_FAILED',
  OUTPUT_OVERFLOW: 'WORKER_OUTPUT_OVERFLOW',
  UNEXPECTED: 'WORKER_UNEXPECTED'
});

/** 输出上限（与已验收限制一致，防止 stdout 无界）。 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 归一化 `initializePrimary` 结论为**固定形状**。
 *
 * 字段名严格对应 P4 实际返回（`ok`/`outcome`/`granted`/`auditId`/`inputDigest`/
 * `existing{userId,status}`），不发明字段。
 *
 * `outcome` 只接受三个已知值：`initialized` / `alreadyPresent` /
 * `auditAlreadyPresent`；其它一律 `UNKNOWN`。
 * **只有** `outcome==='initialized'` 才记 initialized —— `alreadyPresent` 绝不
 * 误报为 initialized（任务 §4.3 明确要求）。
 *
 * @param {object} result P4 返回
 * @param {object} [expect] 本计划的**期望值**（原始计划派生）：
 *   `targetUserId` 用于把 `existing.userId` 与本计划目标**精确比较**（R5-a）；
 *   `auditId` 用于核对 P4 返回的审计键等于本计划确定性键（R5-c）。
 *   缺 `expect` 时不产出这两个布尔，避免无从比较时假装已核对。
 */
function normalizeBootstrapResult(result, expect) {
  const out = {
    ok: false,
    outcome: 'UNKNOWN',
    granted: false,
    initialized: false,
    auditId: null,
    inputDigest: null,
    existingPrimary: null,
    errorCode: null,
    requestIds: []
  };
  if (!isPlainObject(result)) return out;
  out.ok = result.ok === true;
  const allowed = ['initialized', 'alreadyPresent', 'auditAlreadyPresent'];
  if (typeof result.outcome === 'string' && allowed.includes(result.outcome)) {
    out.outcome = result.outcome;
  }
  out.granted = result.granted === true;
  out.initialized = out.outcome === 'initialized' && out.granted;
  // R5-c：审计 ID 必须**等于**本计划确定性键；仅 startsWith 不足以证明同一审计
  if (expect && typeof expect.auditId === 'string' && expect.auditId.length > 0) {
    out.auditId = result.auditId === expect.auditId ? expect.auditId : null;
  } else if (typeof result.auditId === 'string' && result.auditId.startsWith(AUDIT_ID_PREFIX)) {
    out.auditId = result.auditId;
  }
  // R5-b：P4 `inputDigest` 实测是 **32** 位十六进制（不是 SHA-256 的 64 位）。
  // 此前按 64 位校验会把**每一次成功**的摘要都抹成 null。按核心实际长度精确匹配，
  // 并只接受十六进制 —— 不放宽成任意字符串。
  if (typeof result.inputDigest === 'string' && /^[0-9a-f]{32}$/.test(result.inputDigest)) {
    out.inputDigest = result.inputDigest;
  }
  if (isPlainObject(result.existing)) {
    const status = typeof result.existing.status === 'string' &&
      ['active', 'disabled'].includes(result.existing.status) ? result.existing.status : 'unknown';
    out.existingPrimary = {
      //只保留状态与「是否同一目标」的布尔结论，不回显完整 userId 原值
      status,
      // R5-a：与**本计划 targetUserId 精确比较**。
      // 此前只判断「长得像合法 userId」，导致另一个完全不同的合法 ID 也被判为 true。
      // 无期望值时输出 null（未核对），不是 false（不是「确认不同」）。
      sameAsTarget: (expect && typeof expect.targetUserId === 'string')
        ? result.existing.userId === expect.targetUserId
        : null
    };
  }
  // R5-c：固定错误码**白名单**，不是 `/^[A-Z_]{3,64}$/` 这种形状匹配 ——
  // 形状匹配会让任意外部大写串（如 SYNTHETIC_PRIVATE_TOKEN）原样透出。
  if (typeof result.errorCode === 'string' && CORE_ERROR_CODES.has(result.errorCode)) {
    out.errorCode = result.errorCode;
  }
  if (Array.isArray(result.requestIds)) {
    out.requestIds = result.requestIds
      .filter(v => typeof v === 'string' && REQUEST_ID_UUID_V4.test(v)).slice(0, 8);
  }
  return out;
}

/**
 * P4 核心可能返回的**固定**错误码白名单。
 *
 * 来源：按固定源码核对的核心拒绝码与适配层拒绝码（均为本仓库既有常量）。
 * 不含任何「形状上像错误码」的通配。未知值一律丢弃（`errorCode` 留 null）。
 */
const CORE_ERROR_CODES = new Set([
  // 本 worker 自身的执行期期限码（S2）
  'WORKER_PLAN_EXPIRED', 'WORKER_CREDENTIAL_EXPIRED', 'WORKER_APPROVAL_INVALID',
  // 计划 / 时钟
  'PLAN_INVALID', 'CLOCK_INVALID', 'PLAN_EXPIRED_BEFORE_WRITE',
  // 批准上下文
  'APPROVAL_CONTEXT_MISSING', 'APPROVAL_CONTEXT_INVALID', 'TARGET_NOT_APPROVED',
  // 调用者
  'CALLER_VERIFY_FAILED', 'CALLER_ENV_MISMATCH', 'TRUSTED_FLAG_NOT_ACCEPTED',
  // 目标记录
  'TARGET_USER_NOT_FOUND', 'USER_RECORD_MISMATCH',
  // 事务与提交
  'TX_UNAVAILABLE', 'RESULT_UNKNOWN', 'COMMIT_UNKNOWN', 'ROLLBACK_FAILED',
  'SET_FAILED', 'WRITE_REJECTED',
  // 适配层边界
  'READ_ONLY_SCOPE', 'KEY_OUT_OF_SCOPE', 'READ_TRANSPORT_FAILED',
  'SET_TRANSPORT_FAILED', 'CALLER_VERIFIER_MISSING'
]);

const REQUEST_ID_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 归一化 `observePrimary` 结论为固定形状。
 *
 * `state` 只接受四个已知值：`present` / `absent` / `inconsistent` / `unconfirmed`。
 * P4 的 `reason`/`note` 是自身字符串，**不**未经核对当作生产事实透出。
 */
function normalizeObserveResult(result) {
  const out = {
    state: 'unconfirmed',
    primaryPresent: null,
    primaryStatus: null,
    auditPresent: null,
    writeAuthorized: false,
    errorCode: null
  };
  if (!isPlainObject(result)) return out;
  const allowed = ['present', 'absent', 'inconsistent', 'unconfirmed'];
  if (typeof result.state === 'string' && allowed.includes(result.state)) {
    out.state = result.state;
  }
  if (typeof result.primaryPresent === 'boolean') out.primaryPresent = result.primaryPresent;
  if (typeof result.auditPresent === 'boolean') out.auditPresent = result.auditPresent;
  if (typeof result.primaryStatus === 'string' &&
    ['active', 'disabled'].includes(result.primaryStatus)) {
    out.primaryStatus = result.primaryStatus;
  }
  // 只读观察**永不**成为写授权
  out.writeAuthorized = false;
  // R5-c：同白名单，不做形状匹配
  if (typeof result.errorCode === 'string' && CORE_ERROR_CODES.has(result.errorCode)) {
    out.errorCode = result.errorCode;
  }
  return out;
}

/**
 * 回读是否可被视为「已核对」。
 *
 * R5：`observePrimary` 在调用者未获核验、计划不可用、适配层缺 `readOnlyGet`
 * 等情况下**正常返回** `state:'unconfirmed'`，并**不**抛错。因此只看异常
 * 不足以表达「回读失败」—— `unconfirmed` / `inconsistent` 都必须计入未确认。
 * `present` 才算核对成功。
 */
function isObservationConfirmed(observed) {
  return Boolean(observed && observed.state === 'present' &&
    observed.primaryPresent === true && observed.auditPresent === true);
}

/**
 * 构建受限适配器（固定 SDK + 已验收适配层）。
 *
 * 凭据只在这里注入 SDK 配置；不写文件、不进命令行、不进环境。
 * `verifyCaller` 由宿主以**当次真实 STS 核验**结果注入 —— 不接受调用方随意传入的
 * 「成功」替代当次查询（见宿主verifyCaller 构造）。
 *
 * @param {object} [options.db] **仅离线合成测试**注入的数据库句柄。
 *   `Db.reqClass` 是**静态属性**，且 node-sdk 的 `database()` 路径会重设它；
 *   本地测试因此按「先建 db、后替换静态传输」的顺序并**注入该 db**。若让本模块
 *   自建 db，它会拿到重设后的真实传输，事务在到达合成层前就抛
 *   `SIGN_PARAM_INVALID`。已验收适配层测试（tests/
 *   sandbox-primary-sdk-adapter.test.cjs M2-26/27）用的是同一做法。
 *   注意：这是该版本 SDK 的具体行为，**不要**推广成「实例固化」的普遍机制。
 *   本worker 同样提供该注入点，使离线测试能覆盖真实 SDK 事务与文档转换。
 *   **生产路径不传此参数** —— 由本模块按固定配置自建，不接受调用方指定句柄。
 */
function buildAdapter(options) {
  const o = options || {};
  // R3：sdkRoot **不接受调用方覆盖** —— 固定指向已核对副本。
  // 此前 `o.sdkRoot || SDK_ROOT` 允许载荷改写加载路径，等于让调用方决定加载哪份代码。
  const sdkRoot = SDK_ROOT;
  let db = o.db || null;
  if (db === null) {
    let sdk;
    try {
      sdk = require(require.resolve(path.join(sdkRoot, '@cloudbase', 'node-sdk')));
    } catch (_) {
      throw new Error(ERR.SDK_UNAVAILABLE);
    }
    const config = {
      secretId: o.credential.secretId,
      secretKey: o.credential.secretKey,
      // CLI 输出字段是 token；SDK 参数名是 sessionToken（唯一映射点）
      sessionToken: o.credential.sessionToken,
      env: FIXED_ENV_ID,
      region: FIXED_REGION,
      debug: false
    };
    const app = sdk.init(config);
    db = app.database();
  }

  /**
   * `verifyCaller` 使用宿主提供的**当次真实核验**结论。
   *
   * 适配层要求 `verifyCaller` 为函数（`CALLER_VERIFIER_MISSING` 时拒绝建层），
   * 这里传入一个闭包：只核对固定环境/AppID，返回值由 `setCaller` 依据宿主当次
   * STS 主体摘要核验结果设置。**不接受调用方传入的字符串「成功」替代当次查询**。
   */
  let callerAllowed = false;
  const adapter = adapterFactory.createAdapter({
    appId: FIXED_APP_ID,
    envId: FIXED_ENV_ID,
    region: FIXED_REGION,
    targetUserId: o.targetUserId,
    auditId: o.auditId,
    db,
    verifyCaller: (args) => {
      if (!args || args.envId !== FIXED_ENV_ID || args.appId !== FIXED_APP_ID) {
        return { allowed: false };
      }
      return { allowed: callerAllowed };
    }
  });
  // S2：执行期边界守卫（仅本层包裹，不改 P4/适配层）
  const guarded = typeof o.deadlineCheck === 'function'
    ? withExecutionDeadlineGuard(adapter, o.deadlineCheck)
    : adapter;
  return { adapter: guarded, setCaller: (v) => { callerAllowed = v === true; } };
}

/**
 * 主入口：读 stdin 的合成载荷 → 走 P4 核心 → 投影固定形状输出。
 *
 * 载荷字段（全部由宿主提供）：credential / plan / approval / verifiedCaller /
 * fixedNowMs / sdkRoot。**不含**任何调用方可随意伪造的授权开关。
 */
async function run(payload, deps) {
  const d = deps || {};
  const emit = d.emit || ((obj) => process.stdout.write(JSON.stringify(obj)));
  // R3-a：时钟**默认**为真实 `Date.now`。此前直接调用 `d.now()`，
  // 未注入测试时钟时抛 TypeError（真实子进程入口根本没有 deps）。
  // 注入仅用于离线测试；生产路径走默认分支。
  const now = typeof d.now === 'function' ? d.now : () => Date.now();

  if (!isPlainObject(payload)) {
    emit({ ok: false, errorCode: ERR.STDIN_INVALID });
    return;
  }
  const cred = payload.credential;
  if (!isPlainObject(cred) ||
    typeof cred.secretId !== 'string' || typeof cred.secretKey !== 'string' ||
    typeof cred.sessionToken !== 'string') {
    emit({ ok: false, errorCode: ERR.CREDENTIAL_MISSING });
    return;
  }
  // R3：有效期**必须**是有限数才校验。
  // 此前条件是 `typeof === 'number' && Number.isFinite(...)`，于是缺失 / NaN /
  // Infinity 三种情况**跳过**检查直接放行 —— 相当于凭据无期限约束。
  if (typeof cred.expiresAtMs !== 'number' || !Number.isFinite(cred.expiresAtMs)) {
    emit({ ok: false, errorCode: ERR.CREDENTIAL_SHAPE_INVALID });
    return;
  }
  if (cred.expiresAtMs <= now()) {
    emit({ ok: false, errorCode: ERR.CREDENTIAL_EXPIRED });
    return;
  }
  // 计划期限（原始计划的 expiresAt）也必须有明确有效期；缺失即拒绝，
  // 不让「无期限计划」进入事务。
  const rawPlanForDeadline = payload.plan;
  if (!isPlainObject(rawPlanForDeadline) ||
    typeof rawPlanForDeadline.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(rawPlanForDeadline.expiresAt))) {
    emit({ ok: false, errorCode: ERR.PLAN_INVALID });
    return;
  }
  // S2：批准句柄自身的期限由宿主传入，执行期一并复核；
  // 缺该值即按「无批准期限约束」拒绝（不静默放行）。
  if (typeof payload.approvalExpiresAtMs !== 'number' ||
    !Number.isFinite(payload.approvalExpiresAtMs)) {
    emit({ ok: false, errorCode: ERR.APPROVAL_INVALID });
    return;
  }

  // 先做 P4 计划/批准校验并生成绑定值，**再**建适配器（不自造摘要/主键）
  //
  // R1-b：`rawPlan` 与 `normalizedPlan` **必须分开**。
  //  - `rawPlan` 是宿主送来的原始计划，只含 `PLAN_FIELDS` 登记字段。
  //  - `normalizedPlan` 是 `validatePlan` 的返回值，**额外**含派生字段 `deadlineMs`。
  // P4 的 `initializePrimary` / `observePrimary` 内部会**再次**对传入计划跑
  // `validatePlan`（含「计划含未登记字段」检查）。因此必须把**原始**计划交给它们；
  // 把含 `deadlineMs` 的归一化计划传下去必然得到 `PLAN_INVALID`。
  // 归一化计划只用于本模块自己读取 `targetUserId` 等绑定值。
  let normalizedPlan = null;
  let approval;
  let digest;
  let auditId;
  try {
    approval = p4.validateApprovalContext(payload.approval);
    const nowForPlan = p4.resolveNowMs({ nowMs: payload.fixedNowMs });
    normalizedPlan = p4.validatePlan(payload.plan, { approval, nowMs: nowForPlan });
    p4.assertApprovedTarget(approval, normalizedPlan.targetUserId);
    // 摘要与审计 ID 基于**原始**计划字段（与核心内部算法同输入）
    digest = p4.inputDigest(payload.plan);
    auditId = p4.auditId(payload.plan, digest);
  } catch (error) {
    const code = String(error && error.code);
    const APPROVAL_CODES = new Set(['APPROVAL_CONTEXT_MISSING', 'APPROVAL_CONTEXT_INVALID',
      'TARGET_NOT_APPROVED']);
    const PLAN_CODES = new Set(['PLAN_INVALID', 'CLOCK_INVALID']);
    // 不属于上述两类的固定码归入「初始化前置拒绝」，不猜测
    const errorCode = APPROVAL_CODES.has(code)
      ? ERR.APPROVAL_INVALID
      : (PLAN_CODES.has(code) ? ERR.PLAN_INVALID : ERR.INITIALIZE_REJECTED);
    emit({ ok: false, errorCode });
    return;
  }

  let built;
  try {
    built = buildAdapter({
      credential: cred,
      targetUserId: normalizedPlan.targetUserId,
      auditId,
      // 仅离线合成测试注入；生产子进程入口不传，worker 按固定配置自建
      db: d.db || null,
      // S2：把执行期期限复核接到适配层边界守卫上
      deadlineCheck: () => assertWithinDeadlines('EXECUTION_BOUNDARY') !== null
    });
  } catch (_) {
    emit({ ok: false, errorCode: ERR.SDK_UNAVAILABLE });
    return;
  }
  // 当次真实核验结论由宿主注入；不接受调用方传入的「成功」替代
  built.setCaller(payload.verifiedCaller === true);

  /**
   * S2 时效常量（须在 `assertWithinDeadlines` 之前求值）。
   * - `credentialDeadlineMs`：同批凭据到期时刻
   * - `approvalDeadlineMs`：**宿主传入的受控批准到期时刻**
   *   （此前从计划 `expiresAt` 推导，等于没把批准句柄的期限纳入执行期复核）
   */
  const credentialDeadlineMs = cred.expiresAtMs;
  const approvalDeadlineMs = payload.approvalExpiresAtMs;

  /**
   * S2：凭据期限与**批准期限**的执行期复核。
   *
   * `fixedNowMs` 只作审计记录时间；**不**用它给 P4 做有效期校验。
   * Codex 实测：事务中途过期仍两写一提交并报成功 —— 因为给 P4 的
   * `nowMs` 是起点常量，核心自己的「首写前再核验」一直看到起点时间。
   *
   * P4 的 `resolveNowMs` 只接受数字（不改核心），因此这里在**每次**调用
   * 前取一次实时时钟传入，使核心的多次校验看到推进后的真实时间。
   *
   * @returns {null|{code:string}} 过期时返回固定错误码，否则 null
   */
  function assertWithinDeadlines(stage) {
    const nowMs = now();
    if (credentialDeadlineMs <= nowMs) {
      return { code: ERR.CREDENTIAL_EXPIRED, stage };
    }
    if (approvalDeadlineMs <= nowMs) {
      return { code: ERR.PLAN_EXPIRED, stage };
    }
    return null;
  }

  // 事务接线：调用既有 initializePrimary，不重写核心。
  // 传**原始**计划（`payload.plan`），理由见上方 R1-b 说明。
  //
  // R5：事务失败/结果未知**不得立即返回** —— 写请求可能已到达服务端，
  // 因此必须用**同一批上下文**做一次固定的两条只读核对（primary + 本计划审计），
  // 并保留已确定的 auditId 与轮次，供宿主判定「待核对」。
  // 不取第二批凭据、不重试写。
  let bootstrap = null;
  let writeErrorCode = null;
  let resultUnknown = false;
  let writeReachedCore = false;
  /**
   * S2：进入核心**前**再核一次期限（开事务边界）。
   * 核心自己还会在首写前复核，但那时事务已开；此处能在开事务前就停下。
   */
  const beforeBegin = assertWithinDeadlines('BEFORE_TRANSACTION');
  if (beforeBegin !== null) {
    emit({
      ok: false, errorCode: beforeBegin.code, resultUnknown: false,
      bootstrap: null, observed: null, observeFailed: false,
      outcome: 'UNKNOWN', granted: false, initialized: false,
      observationConfirmed: false,
      expiredAtStage: beforeBegin.stage,
      auditId, planDigest: digest,
      roundId: typeof payload.plan.roundId === 'string' ? payload.plan.roundId : null,
      credentialExpiredDuringRun: false,
      planExpiredDuringRun: beforeBegin.code === ERR.PLAN_EXPIRED,
      sdkRetryLimits: {
        maxSetRetries: adapterFactory.MAX_SET_RETRIES,
        maxCommitRetries: adapterFactory.MAX_COMMIT_RETRIES,
        wrapperRerunsTransaction: false
      }
    });
    return;
  }
  try {
    writeReachedCore = true;
    bootstrap = await p4.initializePrimary({
      adapter: built.adapter,
      plan: payload.plan,
      approval,
      // S2：传**实时**时钟（每次调用重新取值），不用起点常量
      nowMs: now(),
      // 审计记录时间仍用固定值（不改核心语义）
      fixedNowMs: payload.fixedNowMs
    });
  } catch (error) {
    const code = String(error && error.code);
    writeErrorCode = CORE_ERROR_CODES.has(code) ? code : ERR.INITIALIZE_REJECTED;
    // 提交结果未知是最需要核对的一类；其余失败同样核对，不猜测是否已写入
    resultUnknown = true;
  }

  const normalized = bootstrap === null ? null
    : normalizeBootstrapResult(bootstrap, { targetUserId: normalizedPlan.targetUserId, auditId });

  /**
   * S2 时效事实（如实报告）。
   */
  const credentialExpiredDuringRun = credentialDeadlineMs <= now();
  const planExpiredDuringRun = approvalDeadlineMs <= now();

  /**
   * 何时需要只读核对：
   *  - 提交成功（`initialized` / `alreadyPresent`）：核对已写入的事实；
   *  - 事务抛错（`writeReachedCore` 且 bootstrap 为 null）：提交可能已到达，
   *    **必须**核对，不能因报错就断言「没写」。
   * 纯前置拒绝（未进入核心）不发核对请求。
   *
   * S2：**同批凭据已过期时不核对** —— 过期的凭据无法确认平台状态，
   * 此时明确留待只读接续，**不补取第二批重写**。
   * （此前注释写「过期仍照常核对」，Codex 要求删除该行为与注释。）
   */
  const credentialUsable = !credentialExpiredDuringRun;
  const needObservation = writeReachedCore && credentialUsable;
  let observed = null;
  let observeFailed = false;
  let observationSkippedReason = null;
  if (writeReachedCore && !credentialUsable) {
    observationSkippedReason = 'CREDENTIAL_EXPIRED_NO_OBSERVE';
    observeFailed = true;
  }
  if (needObservation) {
    try {
      const obs = await p4.observePrimary({
        adapter: built.adapter,
        plan: payload.plan,
        approval,
        // S2：实时时钟（observePrimary 内部同样校验计划有效期）
        nowMs: now()
      });
      observed = normalizeObserveResult(obs);
      // R5：`observePrimary` 正常返回 `unconfirmed`/`inconsistent` 而不抛错；
      // 只看异常会把这些当成「已核对」。统一按 `isObservationConfirmed` 判定。
      observeFailed = !isObservationConfirmed(observed);
    } catch (_) {
      // 回读失败**不得抹去已提交事实**，更不得重试写
      observeFailed = true;
    }
  }

  const confirmed = isObservationConfirmed(observed);

  /**
   * S2：若提交已发生、随后才过期，**保留提交事实**并区分「核对未完成」，
   * 不能把成功提交抹成零写。
   */
  const expiredAfterWrite = writeReachedCore && (credentialExpiredDuringRun || planExpiredDuringRun);

  emit({
    // R5：只有「事务已提交 **且** 核对确认」才算成功。
    ok: writeErrorCode === null && confirmed && !expiredAfterWrite,
    errorCode: writeErrorCode !== null
      ? writeErrorCode
      : (expiredAfterWrite
        ? (credentialExpiredDuringRun ? ERR.CREDENTIAL_EXPIRED : ERR.PLAN_EXPIRED)
        : null),
    resultUnknown,
    bootstrap: normalized,
    observed,
    observeFailed,
    observationSkippedReason,
    // R5：`PLAN_READY` 不是成功分类。分别记录四件事：
    //  本地计划是否有效、提交事实、回读 state、是否已授予。
    outcome: normalized ? normalized.outcome : 'UNKNOWN',
    granted: normalized ? normalized.granted : false,
    initialized: normalized ? normalized.initialized : false,
    observationConfirmed: confirmed,
    // S2：执行过程中的时效事实（如实报告，不用于替代核对）
    credentialExpiredDuringRun,
    planExpiredDuringRun,
    // S2：提交已发生后又过期 —— 提交事实保留，仅标记核对未完成
    expiredAfterWrite,
    // 已确定的审计 ID 与计划摘要**始终**带出（含失败路径），供宿主核对
    auditId,
    planDigest: digest,
    roundId: typeof payload.plan.roundId === 'string' ? payload.plan.roundId : null,
    // SDK 底层重试上限来自所用固定实现的实际设置（如实披露，不隐藏）
    sdkRetryLimits: {
      maxSetRetries: adapterFactory.MAX_SET_RETRIES,
      maxCommitRetries: adapterFactory.MAX_COMMIT_RETRIES,
      wrapperRerunsTransaction: false
    }
  });
}

// ── 私有 stdin 子进程入口（R3-e） ─────────────────────────────────────────

/** stdin 载荷字节上限：凭据+计划的固定形状远小于此；超出即拒绝，避免无界读取。 */
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * 私有 stdin 入口：读**一次**载荷、跑 `run`、写**一次**输出，随即退出。
 *
 * 严格边界：
 *  - 载荷**只**接受固定字段（credential / plan / approval / verifiedCaller /
 *    fixedNowMs）。**不接受** `sdkRoot` 或任何脚本路径 —— 那会让调用方决定
 *    加载哪份代码。`buildAdapter` 的 `sdkRoot` 只在本进程内取固定常量。
 *  - 字节上限 + 计数上限，超限即 `STDIN_INVALID`。
 *  - 输出只写一次，且末尾换行；不打印任何凭据或原始异常。
 *  - 退出码固定：0 表示已产出输出（业务结论看 JSON），非 0 表示入口自身失败。
 */
function readBoundedStdin(readable, limit) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      resolve(ok ? { ok: true, text: Buffer.concat(chunks).toString('utf8') }
        : { ok: false, reason });
    };
    readable.on('data', (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > limit) { finish(false, 'STDIN_TOO_LARGE'); return; }
      chunks.push(buf);
    });
    readable.on('end', () => finish(true, null));
    readable.on('error', () => finish(false, 'STDIN_READ_FAILED'));
  });
}

/** 载荷字段白名单：出现其它字段即拒绝。 */
const ALLOWED_PAYLOAD_FIELDS = Object.freeze([
  'credential', 'plan', 'approval', 'verifiedCaller', 'fixedNowMs', 'approvalExpiresAtMs'
]);

function pickPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { ok: false, errorCode: ERR.STDIN_INVALID };
  }
  if (!isPlainObject(parsed)) return { ok: false, errorCode: ERR.STDIN_INVALID };
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_PAYLOAD_FIELDS.includes(key)) {
      // 不回显字段值（可能含敏感），只报「载荷字段不被接受」
      return { ok: false, errorCode: ERR.STDIN_INVALID };
    }
  }
  if (!isPlainObject(parsed.credential)) return { ok: false, errorCode: ERR.STDIN_INVALID };
  if (!isPlainObject(parsed.plan)) return { ok: false, errorCode: ERR.STDIN_INVALID };
  if (!isPlainObject(parsed.approval)) return { ok: false, errorCode: ERR.STDIN_INVALID };
  return { ok: true, payload: parsed };
}

/** 作为独立进程运行时的入口（宿主用固定 node 启动本文件并写 stdin）。 */
async function main() {
  const writeOut = (obj) => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };
  const input = await readBoundedStdin(process.stdin, MAX_STDIN_BYTES);
  if (!input.ok) {
    writeOut({ ok: false, errorCode: ERR.STDIN_INVALID });
    process.exitCode = 2;
    return;
  }
  const picked = pickPayload(input.text);
  if (!picked.ok) {
    writeOut({ ok: false, errorCode: picked.errorCode });
    process.exitCode = 2;
    return;
  }
  let out = null;
  await run(picked.payload, {
    now: () => Date.now(),
    emit: (v) => { out = v; }
  });
  writeOut(out === null ? { ok: false, errorCode: ERR.UNEXPECTED } : out);
}

// 仅在被作为**主模块**启动时进入子进程入口；被 require 时只导出函数。
if (require.main === module) {
  main().catch(() => {
    try {
      process.stdout.write(JSON.stringify({ ok: false, errorCode: ERR.UNEXPECTED }) + '\n');
    } catch (_) { /* stdout 不可用时仅设退出码 */ }
    process.exitCode = 1;
  });
}

/**
 * S2 执行期边界守卫（**只包裹本worker 交给 P4 的适配层句柄**，不改 P4/适配层）。
 *
 * 实测根因：P4 的「首写前再核验」取 `resolveNowMs({nowMs: options.nowMs})`，
 * 而 `options.nowMs` 是我们在调用时传入的**单个数值**——事务执行期间时钟推进
 * 后，核心内部再解析仍得到同一个常量，于是「首写前复核」始终看到起点时间，
 * 事务中途过期依然两写一提交。
 *
 * 任务明确要求不改 P4/适配器，因此在本层按**实际操作边界**复核：
 *开启事务前、每次读之后、每次写之前、提交之前。截止后立即抛错，
 * 由P4 既有流程执行回滚（只如实报告结果，不承诺撤销已提交的平台事务）。
 *
 * @param {object} adapter 已验收适配层句柄
 * @param {function} check 每次边界调用前执行，返回 true 表示已越界
 */
function withExecutionDeadlineGuard(adapter, check) {
  const guard = (stage) => {
    if (check(stage)) {
      const err = new Error('EXECUTION_DEADLINE_EXCEEDED');
      err.code = 'EXECUTION_DEADLINE_EXCEEDED';
      err.deadlineStage = stage;
      throw err;
    }
  };
  const wrapTx = (fn, stage) => async (...args) => {
    guard(stage);
    const r = await fn(...args);
    // 读之后同样复核：事务中途过期必须在此刻就被发现
    guard(stage + '_AFTER');
    return r;
  };
  const writeTx = async (tx, collection, key, doc) => {
    guard('BEFORE_WRITE');
    const r = await adapter.setDoc(tx, collection, key, doc);
    guard('AFTER_WRITE');
    return r;
  };
  const commitTx = async (tx) => {
    guard('BEFORE_COMMIT');
    return adapter.commit(tx);
  };
  return Object.freeze({
    verifyCaller: adapter.verifyCaller,
    beginTransaction: wrapTx(adapter.beginTransaction.bind(adapter), 'BEGIN_TRANSACTION'),
    getDoc: wrapTx(adapter.getDoc.bind(adapter), 'READ'),
    setDoc: writeTx,
    commit: commitTx,
    rollback: adapter.rollback.bind(adapter),
    readOnlyGet: adapter.readOnlyGet.bind(adapter),
    __meta: adapter.__meta
  });
}

module.exports = Object.freeze({
  FIXED_APP_ID, FIXED_ENV_ID, FIXED_REGION, SDK_ROOT,
  PRIMARY_ID, ERR, MAX_OUTPUT_BYTES, MAX_STDIN_BYTES,
  ALLOWED_PAYLOAD_FIELDS,
  CORE_ERROR_CODES,
  run,
  main,
  buildAdapter,
  normalizeBootstrapResult,
  normalizeObserveResult,
  isObservationConfirmed,
  pickPayload,
  readBoundedStdin
});