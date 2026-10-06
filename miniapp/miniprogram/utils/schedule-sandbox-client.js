// 施工安排独立测试副本：测试专用客户端。
//
// 方案 §4.3 + Codex 复核 S4 + Codex 复核 T1/T2：
// - 显式调用**固定**环境/函数，不做全局重定向，不接受调用方指定函数名或环境。
// - **禁止失败后回退旧函数**，也禁止回退本机保存。
// - 未知动作与封闭动作**零请求**。
// - 按动作核验**固定目标**：配置目标与请求目标不一致时零请求。
//
// T1（按动作处理未知结果）：
// - 动作分三类，**恢复策略不同**：
//   · READ_ONLY —— 不改变项目业务状态，结果未知可安全重发（identify 仅做幂等登记，不新建第二份账号记录）。
//   · RECEIPT_BACKED —— 服务端对 requestId 有回执幂等（施工四写 + 建项目），
//     结果未知可用**同一编号**重发并取回原结果。
//   · NON_IDEMPOTENT —— 无幂等保障（取号、指定管家、邀请、申请、批准、移出成员），
//     结果未知**不得重发**：保留证据并对本轮写入**上锁**，提示管理端核对。
// - **没有"直接清锁重发"的路径**：解除必须显式声明已在管理端核对，
//   且解除后本轮仍保持写锁，不自动放开新写。
// - 未知结果之后收到的一次权限/窗口拒绝**只说明本次未执行**，
//   不得据此认定第一次未提交，因此不清除未决记录、不放开写锁。
// - 首次请求的**已知业务拒绝**正确分类为可修正（含 SCHEDULE_CONFLICT 等实际码）。
//
// T2（未决记录完整绑定）：
// - 未决记录与快照合并为**单一 envelope**（一个存储键），包含
//   动作 / 项目 / requestId / **可信账号** / 轮次 / 环境 / 快照 + 摘要。
//   不再是两键拼接，半写或半清理**无法拼出合法请求**。
// - 恢复时核验**当前目标与原目标一致**，变化即停止，不覆盖。
// - **普通提交接口绝不静默恢复**；只有显式恢复接口才从原快照重建。
//   普通提交在存在未决时一律阻断，同号变更载荷直接拒绝。
// - 账号绑定来自**服务端 identify 返回的 userId**，不信任表单 actorId。
// - **不清旧缓存**：仍按环境/轮次/账号分键；检测到旧格式残留键时
//   阻断写入并要求人工核对，而不是静默忽略或擅自删除。
//
// R2：按 memberAccess/service.js 与 schedule-service.js 的**实际字段契约**定义白名单，
// 包括嵌套 form。顶层 `content` / `version` **不能**代替真实契约。

'use strict';

const sandboxProof = require('../config/schedule-sandbox-proof');
const { checkEnvGate } = require('./env-gate');
// 专用测试协调器：仅取「本机是否有驱动占用」的只读查询。
// 客户端**不**因此获得任何绕过防重的能力：这里只有一个只读判定，
// 且驱动不 require 客户端（无循环依赖）。
//
// R1 返修：普通入口不再只是「被检查」，而是**也取得并保持同一张占用表**
// 的所有权 —— 否则专用驱动可以在普通 identify 在途时并行发两笔写请求。
// 内部恢复流程再次调用身份刷新时**传递同一所有者**，不形成自锁；
// 也不新增任何 ignoreLock 之类的外部绕过开关。
const coordinator = require('./sandbox-test-coordinator');

/**
 * 普通入口的占用助手。
 *
 * S2 返修：`options.owner` **不再**是「有值就放行」。
 * 它必须通过 `coordinator.verifyOrdinaryOwner` 证明**确实是当前持有的
 * ordinary 占用凭证**；任意对象、空对象、字符串、已释放或 test 的凭证
 * 一律视为「未持有」，走正常竞争路径（因而会被真实占用挡住）。
 * 这样「没有 ignoreLock 字符串」才真正等于「没有绕过入口」。
 *
 * @param {string} reason 'ordinaryCall' | 'ordinaryResume' | 'ordinaryIdentity'
 * @param {object} options { api, owner } owner 为**内部重入凭证**时按上述校验
 * @returns {{blocked: object|null, hold: object|null, release: function|null, owner: object|null}}
 */
function enterOrdinary(reason, options) {
  const opts = options || {};
  if (opts.owner !== undefined && opts.owner !== null) {
    // 内部调用：凭证必须被验证为「当前真正持有的 ordinary 占用」
    const verified = coordinator.verifyOrdinaryOwner(opts.owner);
    if (verified.ok) {
      return { blocked: null, hold: null, release: null, owner: opts.owner };
    }
    // 凭证无效：按未持有处理，继续走下面的真实竞争（并保留拒绝原因）
    opts.invalidOwnerReason = verified.reason;
  }
  const api = opts.api;
  const storage = coordinator.resolveStorage(api);
  const block = coordinator.ordinaryEntryBlock({
    storage,
    envId: sandboxProof.envId,
    roundId: roundOf(),
    actorUserId: ''
  });
  if (block) {
    if (opts.invalidOwnerReason && block.code === 'SANDBOX_TEST_DRIVER_ACTIVE') {
      return {
        blocked: Object.assign({}, block, {
          message: `${block.message}（内部重入凭证无效：${opts.invalidOwnerReason}）`
        }),
        hold: null,
        release: null,
        owner: null
      };
    }
    return { blocked: block, hold: null, release: null, owner: null };
  }
  const hold = coordinator.acquireRuntimeHold(reason, 'ordinary');
  if (!hold.ok) {
    return {
      blocked: { ok: false, code: hold.code, message: hold.message, local: true },
      hold: null,
      release: null,
      owner: null
    };
  }
  return {
    blocked: null,
    hold,
    release: () => coordinator.releaseRuntimeHold(hold.token),
    owner: hold
  };
}

const ALLOWED_VERSIONS = sandboxProof.allowedVersions;

// 顶层字段契约（来自 service.js 实际读取的 event.*）。
// 不含 functionName / envId / appId / isAdmin / openid / collection / actorId。
const TOP_LEVEL_KEYS = Object.freeze([
  'action', 'projectId', 'requestId', 'scheduleId', 'invitationId', 'invitationCode',
  'userId', 'workerUserId', 'role', 'trades', 'name', 'bindingNumber', 'applicantNumber',
  'reason', 'expectedVersion', 'expectedConfirmed', 'status', 'trade', 'date', 'cursor', 'limit'
]);

// 嵌套表单契约（来自 schedule-service.js validateForm 实际读取的 form.*）。
const FORM_KEYS = Object.freeze([
  'stage', 'trade', 'workerUserId', 'startDate', 'endDate', 'expectedDate', 'restDays', 'content'
]);

// **敏感字段**：不进入长期快照，只保存摘要（Codex 复核 S4.5）。
const SENSITIVE_KEYS = Object.freeze(['applicantNumber', 'bindingNumber', 'invitationCode']);

// 本副本开放的合法动作（与 gate 阶段清单的并集）。**未知动作零请求**。
const KNOWN_ACTIONS = Object.freeze([
  'identify', 'listMyProjects', 'requestBindingNumber', 'createProject',
  'assignManager', 'createInvitation', 'applyInvitation', 'approveInvitation', 'removeMember',
  'getMembers', 'listInvitations', 'getScheduleContext',
  'listSchedules', 'getSchedule', 'listScheduleRevisions',
  'createSchedule', 'updateSchedule', 'reassignSchedule', 'cancelSchedule'
]);

// 明确不开放的动作：本地直接拒绝，不发请求。
const CLOSED_ACTIONS = Object.freeze([
  'setScheduleWriteMode', 'restoreReady', 'migration', 'repair', 'rawQuery', 'adminGrant'
]);

// 无需项目目标的动作
const PROJECT_OPTIONAL = Object.freeze([
  'identify', 'listMyProjects', 'requestBindingNumber', 'createProject', 'applyInvitation'
]);

// ── T1：动作分类（决定结果未知时的恢复策略） ────────────────────────────

/**
 * **只读动作**：不改变业务状态，结果未知可安全重发。
 *
 * 注意（U2）：`identify` 归在此类是因为它**不改变项目业务状态**，
 * 但**并非零写** —— 真实 `service.identity()` 首次见到账号时会写
 * `users` 并追加 `registerIdentity` 审计。它按 `userId` 派生主键并带
 * `ALREADY_EXISTS` 兜底，重复调用不会产生第二份账号记录。
 */
const READ_ONLY_ACTIONS = Object.freeze([
  'listMyProjects', 'getMembers', 'listInvitations', 'getScheduleContext',
  'listSchedules', 'getSchedule', 'listScheduleRevisions', 'identify'
]);

/**
 * 服务端对 requestId 有回执幂等的写动作。
 * 依据：schedule-service.js 的 withReceiptFirst/tryReceiptReplay +
 * checkIdempotency（createSchedule/updateSchedule/reassignSchedule/cancelSchedule），
 * 以及本副本 project-guard 的建项目唯一记录 + 回执（createProject）。
 */
const RECEIPT_BACKED_ACTIONS = Object.freeze([
  'createSchedule', 'updateSchedule', 'reassignSchedule', 'cancelSchedule', 'createProject'
]);

/**
 * **无幂等保障的写动作**：vendor 未按 requestId 去重，重发会产生第二份记录。
 * 结果未知时必须停止，不得重发、不得靠清锁重发。
 */
const NON_IDEMPOTENT_ACTIONS = Object.freeze([
  'requestBindingNumber', 'assignManager', 'createInvitation',
  'applyInvitation', 'approveInvitation', 'removeMember'
]);

const ACTION_CLASS = Object.freeze({
  READ_ONLY: 'read-only',
  RECEIPT_BACKED: 'receipt-backed',
  NON_IDEMPOTENT: 'non-idempotent'
});

/** 分类动作；未登记动作一律按最保守处理。 */
function classifyAction(action) {
  if (READ_ONLY_ACTIONS.includes(action)) return ACTION_CLASS.READ_ONLY;
  if (RECEIPT_BACKED_ACTIONS.includes(action)) return ACTION_CLASS.RECEIPT_BACKED;
  if (NON_IDEMPOTENT_ACTIONS.includes(action)) return ACTION_CLASS.NON_IDEMPOTENT;
  return ACTION_CLASS.NON_IDEMPOTENT;
}

/** 结果未知时是否允许用同一编号重发。 */
function retryAllowed(action) {
  const kind = classifyAction(action);
  return kind === ACTION_CLASS.READ_ONLY || kind === ACTION_CLASS.RECEIPT_BACKED;
}

/** 结果未知时的说明文案（按动作区分，不笼统显示"同号重试"）。 */
function unknownGuidance(action) {
  switch (classifyAction(action)) {
    case ACTION_CLASS.READ_ONLY:
      return '结果未知。该操作不改变项目业务状态，可安全重试。';
    case ACTION_CLASS.RECEIPT_BACKED:
      return '结果未知。该操作有服务端回执保障，可用同一请求编号重试并取回原结果。';
    default:
      return '结果未知且该操作没有服务端幂等保障，重发可能产生第二份记录。'
        + '已停止并保留证据，请到管理端核对该编号的结果后再继续。';
  }
}

// ── 结果分类 ────────────────────────────────────────────────────────────

/**
 * 明确的**业务层**拒绝码：请求已进入业务实现并被判定拒绝，结果已确定。
 * 依据：vendor/service.js 与 schedule-service.js 实际抛出的 AppError 码
 * （含 SCHEDULE_CONFLICT、TASK_DIR_NOT_READY、GUARD_INCONSISTENT 等）。
 * 对有回执保障的动作，这类拒绝是对**本次请求**的业务层判定，结果已确定，
 * 因此首次请求可据此清理 envelope 以便修正。但**不能**据此反推此前"结果未知"
 * 的那次提交没有发生——服务端可能在读到回执前就因权限/可写性先返回了该码（见 U1）。
 */
const BUSINESS_REJECTION_CODES = Object.freeze([
  'BAD_INPUT', 'NO_ACCESS', 'IDENTITY_DISABLED', 'IDENTITY_UNAVAILABLE', 'WORKER_INVALID',
  'EXPECTED_DATE_MISMATCH', 'SCHEDULE_RANGE_TOO_LONG', 'SCHEDULE_NO_WORKING_DAY',
  'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD', 'WORKER_HAS_ACTIVE_SCHEDULES', 'VERSION_MISMATCH',
  'TASK_DIR_CAPACITY_EXCEEDED', 'TASK_DIR_INCONSISTENT', 'TASK_DIR_NOT_READY',
  'PROJECT_NOT_WRITABLE', 'OCCUPANCY_INCONSISTENT', 'SCHEDULE_OPERATION_BUDGET_EXCEEDED',
  'STALE_SCAN', 'CODE_INVALID', 'OWNER_EXISTS', 'ALREADY_EXISTS', 'SCHEDULE_CONFLICT',
  'GUARD_INCONSISTENT', 'MAINTENANCE_RESTORE_BLOCKED', 'TRANSACTION_UNAVAILABLE'
]);

/**
 * 门控/本地拒绝码：请求**根本没有进入业务实现**。
 * 这类拒绝只说明"本次未执行"，**不能**证明此前结果未知的请求没有提交，
 * 因此遇到未决记录时**不清除**未决记录、不放开写锁。
 */
const GATE_REJECTION_CODES = Object.freeze([
  'SANDBOX_DISABLED', 'SANDBOX_CONFIG_INCOMPLETE', 'SANDBOX_CONFIG_INVALID',
  'SANDBOX_ENV_UNVERIFIED', 'SANDBOX_ENV_MISMATCH', 'SANDBOX_APPID_UNVERIFIED',
  'SANDBOX_APPID_MISMATCH', 'SANDBOX_ACCOUNT_NOT_ALLOWED', 'SANDBOX_EXPIRED',
  'SANDBOX_PHASE_UNKNOWN', 'SANDBOX_PHASE_LOCKED', 'SANDBOX_ACTION_CLOSED',
  'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE', 'SANDBOX_ACTION_UNKNOWN', 'SANDBOX_PROJECT_INVALID',
  'SANDBOX_PROJECT_PROTECTED', 'SANDBOX_PROJECT_MISMATCH', 'SANDBOX_PROJECT_NOT_READY',
  'SANDBOX_PROJECT_PAYLOAD_MISMATCH', 'SANDBOX_PROJECT_STATE_CONFLICT',
  'SANDBOX_ACCOUNT_NOT_ACTIVE', 'SANDBOX_NOT_PRIMARY_ADMIN', 'SANDBOX_PROJECT_REQUIRED',
  'SANDBOX_ENTRY_DISABLED', 'SANDBOX_ENV_DENIED', 'SERVER_ERROR'
]);

// 本地入口错误码（不进入业务层）
const LOCAL_ENTRY_CODES = ['SANDBOX_ENTRY_DISABLED', 'SANDBOX_ENV_DENIED', 'SANDBOX_PROJECT_REQUIRED'];

const NETWORK_MESSAGE_RE = /超时|网络|timeout|network|abort|disconnected|offline|请求.*失败|request.*fail|connection/i;

function uid() {
  return `sbx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── T2：单一 envelope 存储 ─────────────────────────────────────────────

/** 可信账号绑定：只来自服务端 identify 返回的 userId，不信任表单。 */
function accountKey(envId, roundId) {
  return `${sandboxProof.cachePrefix}account:${envId}:${roundId}`;
}

/** 未决 envelope 键：按 环境 + 轮次 + 可信账号 隔离。 */
function envelopeKey(envId, roundId, accountId) {
  return `${sandboxProof.cachePrefix}envelope:${envId}:${roundId}:${accountId || 'unbound'}`;
}

/** 旧格式（两键）残留检测键。**只读不删**：不清用户缓存。 */
function legacyKeys(envId, roundId) {
  return [
    `${sandboxProof.cachePrefix}pending:${envId}:${roundId}`,
    `${sandboxProof.cachePrefix}snapshot:${envId}:${roundId}`
  ];
}

function resolveStorage(api) {
  if (api && api.storage && typeof api.storage.getStorageSync === 'function') {
    return api.storage;
  }
  if (typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function') {
    return {
      getStorageSync: key => wx.getStorageSync(key),
      setStorageSync: (key, value) => wx.setStorageSync(key, value),
      removeStorageSync: key => wx.removeStorageSync(key)
    };
  }
  return null;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 稳定序列化（键排序），用于计算提交摘要。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// 轻量散列：仅用于本地记录绑定与比对，**不作安全用途**。
function digest(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

function snapshotDigest(snapshot) {
  return digest(stableStringify(snapshot));
}

/** 构造提交快照：敏感字段只留摘要。 */
function buildSnapshot(payload) {
  const snap = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (key === 'requestId') continue;
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    if (SENSITIVE_KEYS.includes(key)) {
      snap[key] = { redacted: true, digest: digest(String(payload[key])) };
      continue;
    }
    snap[key] = payload[key];
  }
  if (isPlainObject(payload.form)) {
    const form = {};
    for (const key of FORM_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload.form, key)) form[key] = payload.form[key];
    }
    snap.form = form;
  }
  return snap;
}

/** 由快照重建请求体；敏感字段必须由调用方重新提供且摘要匹配。 */
function bodyFromSnapshot(snapshot, sensitiveValues) {
  const body = {};
  for (const key of Object.keys(snapshot)) {
    if (key === 'form') continue;
    const value = snapshot[key];
    if (isPlainObject(value) && value.redacted === true) {
      const provided = sensitiveValues ? sensitiveValues[key] : undefined;
      if (typeof provided !== 'string' || provided === '') return { error: 'SENSITIVE_REQUIRED', key };
      if (digest(provided) !== value.digest) return { error: 'SENSITIVE_MISMATCH', key };
      body[key] = provided;
      continue;
    }
    body[key] = value;
  }
  if (snapshot.form) body.form = { ...snapshot.form };
  return { body };
}

// 入口判定。环境与版本校验必须在任何提前返回之前完成。
function checkSandboxEntry(api) {
  if (!sandboxProof.enabled) {
    return { allowed: false, reason: '施工安排独立测试副本未启用。' };
  }
  if (!sandboxProof.functionName || typeof sandboxProof.functionName !== 'string') {
    return { allowed: false, reason: '测试副本函数名未配置。' };
  }
  const env = checkEnvGate(sandboxProof.envId, api);
  if (!env.allowed) return { allowed: false, reason: env.reason };
  if (!ALLOWED_VERSIONS.includes(env.envVersion)) {
    return { allowed: false, reason: '仅开发版/体验版可使用独立测试副本。' };
  }
  const target = sandboxProof.sandboxProjectId || '';
  return {
    allowed: true,
    reason: target ? '' : '尚未登记测试项目ID，仅身份准备动作可用。',
    projectReady: Boolean(target),
    targetProjectId: target,
    appId: env.appId,
    envVersion: env.envVersion
  };
}

/**
 * 把传入对象解析为存储句柄。
 * 兼容两种传法：直接传 storage，或传 wx / api（其上有 storage 或 getStorageSync）。
 */
function asStorage(target) {
  if (!target) return null;
  if (typeof target.getStorageSync === 'function') return target;
  if (target.storage && typeof target.storage.getStorageSync === 'function') return target.storage;
  return null;
}

function roundOf() {
  return sandboxProof.roundId || 'default';
}

/** 读取当前可信账号绑定（只来自服务端 identify 返回值）。 */
function readBoundAccount(target, envId, roundId) {
  const storage = asStorage(target);
  if (!storage) return { status: 'error', reason: '无存储能力，无法确认当前可信账号。' };
  let raw;
  try {
    raw = storage.getStorageSync(accountKey(envId, roundId));
  } catch (error) {
    return { status: 'error', reason: '读取可信账号绑定失败。' };
  }
  if (raw === undefined || raw === null || raw === '') return { status: 'none', accountId: '' };
  if (typeof raw !== 'string') return { status: 'error', reason: '可信账号绑定记录损坏。' };
  return { status: 'ok', accountId: raw };
}

/**
 * 记录可信账号绑定。**只接受服务端 identify 返回的 userId**。
 * 客户端其它路径不得调用本函数写入账号。
 *
 * 写后读回比对：绑定是恢复身份的前置，**存储部分失败不得沿用旧身份**（U2）。
 */
function bindAccount(target, envId, roundId, userId) {
  const storage = asStorage(target);
  if (!storage) return false;
  if (typeof userId !== 'string' || !userId) return false;
  try {
    storage.setStorageSync(accountKey(envId, roundId), userId);
    return storage.getStorageSync(accountKey(envId, roundId)) === userId;
  } catch (error) {
    return false;
  }
}

/**
 * 刷新当前会话身份（U2）。
 *
 * 独立向云函数发一次 `identify`，用**服务端返回的 userId** 确认当前执行人。
 * - 'same'    本地绑定与当前会话一致
 * - 'bound'   本地原无绑定，本次建立
 * - 'changed' 当前会话与本地绑定**不同**（不覆盖任何已有未决记录）
 * - 'unknown' 身份请求失败或未返回可信 userId（**不得**当作通过）
 *
 * 该调用**不经过 callSandbox**，因此：
 * - 不会被旧未决记录锁死（身份刷新必须能独立完成）；
 * - 不会写入或覆盖任何 envelope（identify 不占用未决槽）。
 */
async function refreshSessionIdentity(api, internalOwner) {
  const entry = checkSandboxEntry(api);
  if (!entry.allowed) {
    return { status: 'unknown', reason: entry.reason };
  }
  // 专用测试驱动占用期间**旁路也不允许**：页面 onShow 的自动身份刷新
  // 不能绕过互斥去发请求（§4 方向 2）。同步检查 + 取得普通占用，
  // 在任何 await 之前。内部恢复再调本函数时传入 internalOwner，不自锁。
  const ordinary = enterOrdinary('ordinaryIdentity', { api, owner: internalOwner });
  if (ordinary.blocked) {
    return { status: 'unknown', reason: ordinary.blocked.message };
  }
  try {
    return await refreshSessionIdentityHeld(api);
  } finally {
    if (ordinary.release) ordinary.release();
  }
}

/** 已持有普通占用后的身份刷新主体。 */
async function refreshSessionIdentityHeld(api) {
  if (!api || typeof api.cloud !== 'object' || typeof api.cloud.callFunction !== 'function') {
    return { status: 'unknown', reason: '云调用能力不可用，无法确认当前身份。' };
  }
  const envId = sandboxProof.envId;
  const roundId = roundOf();
  const storage = resolveStorage(api);

  let response;
  try {
    response = await sendRequest(api, { action: 'identify', requestId: uid() });
  } catch (error) {
    return { status: 'unknown', reason: '身份确认请求失败，无法确认当前执行人。' };
  }
  const result = (response && response.result) ? response.result : {};
  if (result.ok !== true || typeof result.userId !== 'string' || !result.userId) {
    return { status: 'unknown', reason: '身份确认未返回可信账号，无法确认当前执行人。' };
  }
  const current = result.userId;
  const bound = readBoundAccount(storage, envId, roundId);
  if (bound.status === 'error') return { status: 'unknown', reason: bound.reason };

  if (bound.status === 'none' || !bound.accountId) {
    // 首次建立绑定。写不进去就**不能**继续，否则会把身份缺失当作已确认。
    if (!bindAccount(storage, envId, roundId, current)) {
      return { status: 'unknown', reason: '无法保存可信账号绑定，已阻止后续操作。' };
    }
    return { status: 'bound', accountId: current, changed: false };
  }
  if (bound.accountId === current) {
    return { status: 'same', accountId: current, changed: false };
  }
  // 身份已变：**保留**原有绑定与未决记录，交人工处理，不在此覆盖。
  return {
    status: 'changed',
    accountId: current,
    previousAccountId: bound.accountId,
    changed: true
  };
}

/** envelope 结构校验：任何一项不符即视为损坏，**不得**当作"没有未决"。 */
function validateEnvelope(raw, envId, roundId, accountId) {
  if (!isPlainObject(raw)) return { ok: false, reason: '未决记录损坏，无法确认请求内容。' };
  if (raw.kind !== 'sandbox-envelope' || raw.version !== 1) {
    return { ok: false, reason: '未决记录版本无法识别，已阻止发送。' };
  }
  if (typeof raw.requestId !== 'string' || !raw.requestId) {
    return { ok: false, reason: '未决记录缺少请求编号。' };
  }
  if (typeof raw.action !== 'string' || !KNOWN_ACTIONS.includes(raw.action)) {
    return { ok: false, reason: '未决记录的动作不是本副本开放的动作，已阻止发送。' };
  }
  if (typeof raw.projectId !== 'string') {
    return { ok: false, reason: '未决记录的项目字段类型不正确，已阻止发送。' };
  }
  if (raw.envId !== envId || raw.roundId !== roundId) {
    return { ok: false, reason: '未决记录与当前环境或轮次不一致，已阻止发送。' };
  }
  if (typeof raw.accountId !== 'string' || !raw.accountId) {
    return { ok: false, reason: '未决记录缺少可信账号绑定，已阻止发送。' };
  }
  // 键归属核验：记录必须确实属于**它被读出的那个账号键**。
  // 否则改一下存储键就能跨账号读到别人的请求。
  if (typeof accountId === 'string' && accountId && raw.accountId !== accountId) {
    return { ok: false, reason: '未决记录与所在存储键的账号不一致，已阻止发送。' };
  }
  if (!isPlainObject(raw.snapshot)) {
    return { ok: false, reason: '未决记录缺少提交快照，已阻止发送。' };
  }
  if (raw.snapshotDigest !== snapshotDigest(raw.snapshot)) {
    return { ok: false, reason: '提交快照校验失败，已阻止发送。' };
  }
  if (raw.actionClass !== classifyAction(raw.action)) {
    return { ok: false, reason: '未决记录的动作分类与当前实现不一致，已阻止发送。' };
  }
  // 顶层与快照必须互相印证（U3）。单键存储解决了半写拼接，
  // 但**不会**自动保证顶层元数据与快照内容一致。
  if (raw.snapshot.action !== raw.action) {
    return { ok: false, reason: '未决记录顶层动作与快照动作不一致，已停止。' };
  }
  const snapshotProject = typeof raw.snapshot.projectId === 'string' ? raw.snapshot.projectId : '';
  if (snapshotProject !== raw.projectId) {
    return { ok: false, reason: '未决记录顶层项目与快照项目不一致，已停止。' };
  }
  if (raw.snapshot.requestId !== undefined) {
    return { ok: false, reason: '提交快照不应包含请求编号，已停止。' };
  }
  // 动作与目标必须自洽：项目必需动作的快照必须有项目，无项目动作必须没有
  const needsProject = !PROJECT_OPTIONAL.includes(raw.action);
  if (needsProject && !raw.projectId) {
    return { ok: false, reason: '未决记录的项目类动作缺少目标，已停止。' };
  }
  if (!needsProject && raw.projectId) {
    return { ok: false, reason: '未决记录的无项目动作却带有目标，已停止。' };
  }
  return { ok: true };
}

/**
 * 读取未决 envelope。
 * status: 'none' | 'ok' | 'error'
 *
 * - 记录不存在 → 'none'
 * - 读失败 / 结构损坏 / 快照摘要不匹配 → 'error'（**不得**当作"没有未决"）
 * - 旧格式残留键存在但无 envelope → 'error'（不删除旧缓存，但不得静默忽略）
 *
 * @param allowLegacyResidual identify 用来建立可信账号绑定，
 *   必须能在旧残留状态下完成，否则用户永远无法恢复；其余动作一律阻断。
 */
function readEnvelopeRaw(target, envId, roundId, accountId, allowLegacyResidual = false) {
  const storage = asStorage(target);
  if (!storage) return { status: 'error', reason: '无存储能力，无法确认是否存在未决请求。' };
  let raw;
  try {
    raw = storage.getStorageSync(envelopeKey(envId, roundId, accountId));
  } catch (error) {
    return { status: 'error', reason: '读取未决请求失败，无法确认是否存在未决请求。' };
  }
  if (raw === undefined || raw === null || raw === '') {
    // 没有 envelope：若旧格式残留键还在，说明历史状态无法确认 → 阻断而不是忽略
    for (const key of legacyKeys(envId, roundId)) {
      let legacy;
      try {
        legacy = storage.getStorageSync(key);
      } catch (error) {
        return { status: 'error', reason: '读取旧格式未决记录失败，已阻止发送。' };
      }
      if (legacy !== undefined && legacy !== null && legacy !== '') {
        if (allowLegacyResidual) break;
        return {
          status: 'error',
          reason: '检测到旧格式未决记录残留，无法确认历史请求结果，已阻止发送；请人工核对后处理（本副本不自动删除旧缓存）。'
        };
      }
    }
    return { status: 'none' };
  }
  const checked = validateEnvelope(raw, envId, roundId, accountId);
  if (!checked.ok) return { status: 'error', reason: checked.reason };
  return { status: 'ok', envelope: raw };
}

/** 供页面使用：读取未决记录（带可用性、说明与可信账号）。 */
function readPending(target, envId, roundId) {
  const bound = readBoundAccount(target, envId, roundId);
  if (bound.status === 'error') {
    return { available: false, reason: bound.reason, envelope: null, record: null, snapshot: null, accountId: '' };
  }
  const accountId = bound.status === 'ok' ? bound.accountId : '';
  const result = readEnvelopeRaw(target, envId, roundId, accountId);
  if (result.status === 'error') {
    return { available: false, reason: result.reason, envelope: null, record: null, snapshot: null, accountId };
  }
  if (result.status === 'none') {
    return { available: true, envelope: null, record: null, snapshot: null, accountId };
  }
  const env = result.envelope;
  return {
    available: true,
    envelope: env,
    record: {
      requestId: env.requestId,
      action: env.action,
      actionClass: env.actionClass,
      projectId: env.projectId,
      accountId: env.accountId,
      roundId: env.roundId,
      writeLocked: env.writeLocked === true,
      externallyVerified: env.externallyVerified === true,
      at: env.at
    },
    snapshot: env.snapshot,
    accountId
  };
}

/**
 * 保存 envelope（单键）；写后读回**完整关键绑定**校验，失败返回 false。
 *
 * U3：不能只查 requestId 与快照摘要 —— 顶层 action/projectId/accountId 任一
 * 未真正落盘都必须视为写入失败，否则会用一个"半正确"的记录继续恢复。
 */
function writeEnvelope(target, envId, roundId, envelope) {
  const storage = asStorage(target);
  if (!storage) return false;
  const key = envelopeKey(envId, roundId, envelope.accountId);
  try {
    storage.setStorageSync(key, envelope);
    const back = storage.getStorageSync(key);
    if (!isPlainObject(back)) return false;
    for (const field of ['kind', 'version', 'requestId', 'action', 'actionClass', 'projectId', 'accountId', 'roundId', 'envId', 'snapshotDigest']) {
      if (back[field] !== envelope[field]) return false;
    }
    if (!isPlainObject(back.snapshot)) return false;
    if (snapshotDigest(back.snapshot) !== envelope.snapshotDigest) return false;
    if (back.snapshot.action !== envelope.action) return false;
    return true;
  } catch (error) {
    return false;
  }
}

function clearEnvelope(target, envId, roundId, accountId) {
  const storage = asStorage(target);
  if (!storage) return;
  try {
    storage.removeStorageSync(envelopeKey(envId, roundId, accountId));
  } catch (error) {
    // 忽略：不影响本次结果判定
  }
}

function pickTopLevel(payload) {
  const result = {};
  if (isPlainObject(payload)) {
    for (const key of TOP_LEVEL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) result[key] = payload[key];
    }
  }
  return result;
}

function pickForm(form) {
  if (!isPlainObject(form)) return undefined;
  const out = {};
  for (const key of FORM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(form, key)) out[key] = form[key];
  }
  return out;
}

/** 组装请求体（白名单裁剪）。 */
function buildBody(payload, action, requestId, effectiveProjectId) {
  const base = pickTopLevel(payload);
  base.action = action;
  // 项目目标**只**来自门控后的有效目标：PROJECT_OPTIONAL 动作契约上不携带项目，
  // 即使调用方在 payload 里塞了 projectId，也按"无项目组包"归一（U3 P1）。
  // 否则 pickTopLevel 会把裸 projectId 带进请求体，进而保存一个稍后被
  // validateEnvelope 判为"无项目动作却带目标"的 envelope。
  if (effectiveProjectId) base.projectId = effectiveProjectId;
  else delete base.projectId;
  const form = pickForm(payload && payload.form);
  if (form && Object.keys(form).length) base.form = form;
  const body = { ...base };
  for (const key of SENSITIVE_KEYS) {
    if (isPlainObject(payload) && typeof payload[key] === 'string' && payload[key] !== '') body[key] = payload[key];
  }
  body.action = action;
  body.requestId = requestId;
  return body;
}

/** 门控与固定目标核验，返回 { ok, body 基础 } 或 { ok:false, response }。 */
function preflight(action, payload, api, entry) {
  if (!entry.allowed) {
    return { ok: false, response: { ok: false, code: 'SANDBOX_ENTRY_DISABLED', message: entry.reason, local: true } };
  }
  if (!api || typeof api.cloud !== 'object' || typeof api.cloud.callFunction !== 'function') {
    return { ok: false, response: { ok: false, code: 'SANDBOX_ENV_DENIED', message: '云调用能力不可用。', local: true } };
  }
  if (typeof action !== 'string' || action === '') {
    return { ok: false, response: { ok: false, code: 'BAD_INPUT', message: '操作名称缺失。', local: true } };
  }
  if (CLOSED_ACTIONS.includes(action)) {
    return { ok: false, response: { ok: false, code: 'SANDBOX_ACTION_CLOSED', message: `操作「${action}」不在开放范围内。`, local: true } };
  }
  if (!KNOWN_ACTIONS.includes(action)) {
    return { ok: false, response: { ok: false, code: 'SANDBOX_ACTION_UNKNOWN', message: `未知操作「${action}」，未发送请求。`, local: true } };
  }
  const needsProject = !PROJECT_OPTIONAL.includes(action);
  const supplied = isPlainObject(payload) && typeof payload.projectId === 'string' ? payload.projectId.trim() : '';
  let effectiveProjectId = '';
  if (needsProject) {
    if (!entry.targetProjectId) {
      return { ok: false, response: { ok: false, code: 'SANDBOX_PROJECT_REQUIRED', message: '尚未登记测试项目ID，未发送请求。', local: true } };
    }
    if (supplied && supplied !== entry.targetProjectId) {
      return {
        ok: false,
        response: { ok: false, code: 'SANDBOX_PROJECT_MISMATCH', local: true, message: '请求项目与已登记测试项目不一致，未发送请求。' }
      };
    }
    effectiveProjectId = entry.targetProjectId;
  } else {
    // PROJECT_OPTIONAL 动作：契约上**不携带**项目目标。
    // 调用方传入的 projectId 一律按"无项目组包"处理（忽略），避免保存一个
    // 稍后被 validateEnvelope 判为"无项目动作却带目标"的 envelope（U3 P1）。
    // 这是发送前可预测的统一处理，不会在保存后才判坏。
    effectiveProjectId = '';
  }
  return { ok: true, effectiveProjectId };
}

/**
 * 从已保存快照重建请求体（显式恢复路径专用）。
 *
 * U3：**绝不把当前目标补进原本无目标的提交**，也绝不改写原目标。
 * 项目必需动作缺少原目标时视为损坏（由 validateEnvelope 拦下），
 * 这里只做快照到请求体的机械重建。
 */
function rebuildFromEnvelope(envelope, sensitiveValues) {
  const rebuilt = bodyFromSnapshot(envelope.snapshot, sensitiveValues);
  if (rebuilt.error === 'SENSITIVE_REQUIRED') {
    return {
      ok: false,
      response: {
        ok: false, code: 'SANDBOX_SNAPSHOT_INVALID', local: true,
        message: `恢复该请求需要重新提供「${rebuilt.key}」，已阻止发送。`,
        requestId: envelope.requestId, needSensitive: true, sensitiveKey: rebuilt.key
      }
    };
  }
  if (rebuilt.error === 'SENSITIVE_MISMATCH') {
    return {
      ok: false,
      response: {
        ok: false, code: 'SANDBOX_SNAPSHOT_INVALID', local: true,
        message: `重新提供的「${rebuilt.key}」与原请求不一致，已阻止发送。`,
        requestId: envelope.requestId, needSensitive: true, sensitiveKey: rebuilt.key
      }
    };
  }
  // **原目标优先**：不因当前配置变化而改写去向；无项目动作不补目标。
  const body = { ...rebuilt.body, action: envelope.action, requestId: envelope.requestId };
  if (envelope.projectId) body.projectId = envelope.projectId;
  else delete body.projectId;
  return { ok: true, body };
}

function sendRequest(api, body) {
  return api.cloud.callFunction({
    name: sandboxProof.functionName,
    config: { env: sandboxProof.envId },
    data: body
  });
}

/**
 * 唯一出口（**普通提交**）：固定环境 + 固定函数名。**没有旧函数回退分支。**
 *
 * 存在未决记录时**一律阻断**：普通提交不静默恢复、不改写目标、
 * 不同号拒绝、同号变更载荷也拒绝（走显式恢复接口 resumePending）。
 */
async function callSandbox(payload, options = {}) {
  const api = options.api;
  // 专用测试驱动占用 → 普通提交拒绝（§4 方向 2）。
  // R1 返修：普通提交**也取得并保持占用**，直到 dispatch 返回；
  // 同步进行，**在首次 await 之前**；不提供 ignoreLock 之类开关。
  const ordinary = enterOrdinary('ordinaryCall', { api, owner: options.internalOwner });
  if (ordinary.blocked) return ordinary.blocked;
  try {
    return await callSandboxHeld(payload, options);
  } finally {
    if (ordinary.release) ordinary.release();
  }
}

/** 已持有普通占用后的普通提交主体。 */
async function callSandboxHeld(payload, options = {}) {
  const api = options.api;
  const entry = checkSandboxEntry(api);
  const action = payload && payload.action;
  const pre = preflight(action, payload, api, entry);
  if (!pre.ok) return pre.response;

  const envId = sandboxProof.envId;
  const roundId = roundOf();
  const storage = resolveStorage(api);

  const bound = readBoundAccount(storage, envId, roundId);
  if (bound.status === 'error') {
    return { ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', message: bound.reason, local: true };
  }
  const accountId = bound.status === 'ok' ? bound.accountId : '';

  // identify 是建立可信账号绑定的来源，必须能在旧残留状态下完成，
  // 否则用户永远无法恢复；其它动作一律被旧残留阻断。
  const pending = readEnvelopeRaw(storage, envId, roundId, accountId, action === 'identify');
  if (pending.status === 'error') {
    return { ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', message: pending.reason, local: true };
  }
  if (pending.status === 'ok') {
    const env = pending.envelope;
    // 同号也**不**在普通提交里恢复：内容是否一致由显式恢复接口判定
    return {
      ok: false, code: 'SANDBOX_PENDING_UNRESOLVED', local: true,
      message: retryAllowed(env.action)
        ? '存在结果未知的请求，请用「核对并重试」按同一请求编号恢复。'
        : '存在结果未知且无幂等保障的请求，已停止写入；请先到管理端核对该编号的结果。',
      requestId: env.requestId,
      pendingAction: env.action,
      pendingActionClass: env.actionClass,
      writeLocked: env.writeLocked === true
    };
  }

  // 首次提交：需要可信账号绑定，否则未决记录无法隔离到人。
  // `identify` 是绑定来源本身，由服务端返回 userId，因此**豁免**该前置条件。
  if (!accountId && action !== 'identify') {
    return {
      ok: false, code: 'SANDBOX_ACCOUNT_UNBOUND', local: true,
      message: '尚未通过服务端身份登记确认当前账号，未发送请求。'
    };
  }

  const requestId = (isPlainObject(payload) && typeof payload.requestId === 'string' && payload.requestId.trim())
    || uid();
  const body = buildBody(payload, action, requestId, pre.effectiveProjectId);
  const snapshot = buildSnapshot({ ...body, requestId: undefined });

  const envelope = {
    kind: 'sandbox-envelope',
    version: 1,
    requestId,
    action,
    actionClass: classifyAction(action),
    projectId: body.projectId || '',
    // identify 发生在绑定之前，用服务端即将确认的账号作为占位绑定
    accountId: accountId || '',
    roundId,
    envId,
    at: Date.now(),
    writeLocked: false,
    snapshot,
    snapshotDigest: snapshotDigest(snapshot)
  };
  // identify 的 envelope 在拿到 userId 前无法完成账号绑定校验：
  // 发送后由 dispatch 绑定账号并**改写** envelope；绑定失败则按未知结果保留。
  if (accountId && !writeEnvelope(storage, envId, roundId, envelope)) {
    return {
      ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', local: true,
      message: '无法保存防重记录，已阻止发送以避免重复提交。'
    };
  }
  return dispatch({ api, storage, envId, roundId, accountId, envelope, body, retry: false });
}

/**
 * 显式恢复入口：从**原完整快照**重建并按原编号重发。
 *
 * - 核验当前可信账号与 envelope 绑定一致（不信任表单 actorId）。
 * - 核验**当前目标与原目标一致**；变化即停止，不覆盖。
 * - **无幂等保障的动作拒绝恢复**（T1）：不提供清锁重发路径。
 * - 敏感凭据必须重新提供且摘要匹配。
 */
async function resumePending(options = {}) {
  const api = options.api;
  // 专用测试驱动占用 → 恢复入口同样拒绝（§4 方向 2）。
  // **不改变**谁能恢复、恢复什么内容，只增加互斥限制。
  // R1 返修：恢复路径**也取得并保持占用**；主体内部再调身份刷新时
  // 传递同一所有者，避免自锁。
  const ordinary = enterOrdinary('ordinaryResume', { api, owner: options.internalOwner });
  if (ordinary.blocked) return ordinary.blocked;
  try {
    return await resumePendingHeld(options, ordinary.owner);
  } finally {
    if (ordinary.release) ordinary.release();
  }
}

/** 已持有普通占用后的恢复主体。 */
async function resumePendingHeld(options = {}, internalOwner) {
  const api = options.api;
  const entry = checkSandboxEntry(api);
  if (!entry.allowed) {
    return { ok: false, code: 'SANDBOX_ENTRY_DISABLED', message: entry.reason, local: true };
  }
  if (!api || typeof api.cloud !== 'object' || typeof api.cloud.callFunction !== 'function') {
    return { ok: false, code: 'SANDBOX_ENV_DENIED', message: '云调用能力不可用。', local: true };
  }
  const envId = sandboxProof.envId;
  const roundId = roundOf();
  const storage = resolveStorage(api);

  const bound = readBoundAccount(storage, envId, roundId);
  if (bound.status === 'error') {
    return { ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', message: bound.reason, local: true };
  }
  const accountId = bound.status === 'ok' ? bound.accountId : '';
  if (!accountId) {
    return { ok: false, code: 'SANDBOX_ACCOUNT_UNBOUND', local: true, message: '尚未通过服务端身份登记确认当前账号。' };
  }
  const pending = readEnvelopeRaw(storage, envId, roundId, accountId);
  if (pending.status === 'error') {
    return { ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', message: pending.reason, local: true };
  }
  if (pending.status === 'none') {
    return { ok: false, code: 'SANDBOX_NO_PENDING', local: true, message: '当前没有需要恢复的未决请求。' };
  }
  const envelope = pending.envelope;

  // ── U3：按动作执行恢复前置（**纯本地判定，不发请求**）──────────────
  // 项目必需动作：当前登记为空**也必须停止**（普通提交同样会拒绝，
  // 恢复不能绕过这项门槛）；非空则须与原目标严格一致。
  const needsProject = !PROJECT_OPTIONAL.includes(envelope.action);
  const currentTarget = entry.targetProjectId || '';
  if (needsProject) {
    if (!currentTarget) {
      return {
        ok: false, code: 'SANDBOX_PROJECT_REQUIRED', local: true,
        message: '当前未登记测试项目ID，无法确认原请求目标，已停止恢复；原记录已保留。',
        requestId: envelope.requestId
      };
    }
    if (envelope.projectId !== currentTarget) {
      return {
        ok: false, code: 'SANDBOX_TARGET_CHANGED', local: true,
        message: '当前登记的测试项目与原请求目标不一致，已停止恢复；请先核对原请求结果。',
        requestId: envelope.requestId
      };
    }
  } else if (envelope.projectId) {
    // 无项目动作带了目标：validateEnvelope 已拦，这里是双保险
    return {
      ok: false, code: 'SANDBOX_TARGET_CHANGED', local: true,
      message: '未决记录的项目目标与该动作不符，已停止恢复。',
      requestId: envelope.requestId
    };
  }

  // 凭据校验**先于**安全性判断：填错的凭据必须按"凭据不符"拒绝，
  // 而不是被"不能重发"掩盖（T4）。
  const rebuilt = rebuildFromEnvelope(envelope, options.sensitive);
  if (!rebuilt.ok) return rebuilt.response;
  // T1：无幂等保障的动作拒绝重发。这里凭据已校验通过，
  // 但**仍不发送**——不提供"清锁重发"路径。
  if (!retryAllowed(envelope.action)) {
    return {
      ok: false, code: 'SANDBOX_RETRY_UNSAFE', local: true,
      message: unknownGuidance(envelope.action), requestId: envelope.requestId
    };
  }

  // ── U2：发送前最后一步，确认**当前会话**身份 ──────────────────────
  // 本地 account 缓存是**历史值**，不能自证当前执行人仍是它；
  // 上面几项都是纯本地判定，只有真正要发出业务请求时才需要这次网络核实。
  // 身份未确认或与记录不符 → 保留原 envelope 且**不发出业务请求**。
  const identity = await refreshSessionIdentity(api, internalOwner);
  if (identity.status === 'unknown') {
    return {
      ok: false, code: 'SANDBOX_IDENTITY_UNCONFIRMED', local: true,
      message: `${identity.reason} 未决记录已保留，未发送业务请求。`,
      requestId: envelope.requestId
    };
  }
  if (identity.status === 'changed' || identity.accountId !== envelope.accountId) {
    return {
      ok: false, code: 'SANDBOX_ACCOUNT_MISMATCH', local: true,
      message: '当前登录账号与该未决请求的执行人不同，已停止恢复；原记录已保留，未发送业务请求。',
      requestId: envelope.requestId
    };
  }

  return dispatch({
    api, storage, envId, roundId, accountId, envelope, body: rebuilt.body, retry: true
  });
}

/**
 * 统一发送与结果分类。
 *
 * - 成功 → 清除 envelope
 * - **重试**（原结果未知后的恢复）：非成功响应**一律保留** envelope。
 *   原因（U1）：`schedule-service.js` 的 `tryReceiptReplay` 先做
 *   `verifyActorInTransaction` 与 `assertProjectWritable`、外层 `identity`
 *   也先于回执，因此 NO_ACCESS / IDENTITY_DISABLED / PROJECT_NOT_WRITABLE
 *   等业务码可能在**根本没读原回执**时返回。业务码名称本身
 *   **不构成**"原提交未发生"的证据。
 * - 门控/本地拒绝 → **不清除**：只说明本次未执行
 * - 结果未知 → 保留 envelope；无幂等保障的动作额外**锁写**
 */
async function dispatch(ctx) {
  const { api, storage, envId, roundId, body, retry } = ctx;
  let { envelope, accountId } = ctx;
  // identify 绑定后可能切换到新的账号键
  let boundAccountId = accountId;
  let response;
  try {
    response = await sendRequest(api, body);
  } catch (error) {
    const message = String((error && error.message) || '');
    const locked = !retryAllowed(envelope.action);
    if (locked) markWriteLocked(storage, envId, roundId, boundAccountId, envelope);
    return {
      ok: false,
      code: NETWORK_MESSAGE_RE.test(message) ? 'SANDBOX_RESULT_UNKNOWN' : 'SANDBOX_REQUEST_FAILED',
      message: unknownGuidance(envelope.action),
      requestId: envelope.requestId,
      action: envelope.action,
      actionClass: envelope.actionClass,
      retryAllowed: retryAllowed(envelope.action),
      writeLocked: locked,
      unknown: true
    };
  }

  const result = (response && response.result) ? response.result : {};

  // 服务端 identify 返回的 userId 是**唯一**可信账号来源。
  // 绑定后把 envelope 改写到该账号的键下，使后续未决记录按人隔离。
  if (envelope.action === 'identify' && result.ok === true && typeof result.userId === 'string') {
    if (!bindAccount(storage, envId, roundId, result.userId)) {
      return {
        ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', local: true,
        message: '无法保存可信账号绑定，已阻止后续写入。', unknown: true
      };
    }
    const rebound = { ...envelope, accountId: result.userId };
    if (!writeEnvelope(storage, envId, roundId, rebound)) {
      return {
        ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', local: true,
        message: '无法保存防重记录，已阻止后续写入。', unknown: true
      };
    }
    envelope = rebound;
    boundAccountId = result.userId;
  }

  if (result.ok === true) {
    clearEnvelope(storage, envId, roundId, boundAccountId);
    return { ...result, requestId: envelope.requestId, replayed: retry };
  }

  const code = typeof result.code === 'string' ? result.code : '';

  // ── U1：恢复（重试）路径的非成功响应一律保留原 envelope ────────────
  // 业务码名称**不能**证明原提交未发生：tryReceiptReplay 在读回执之前
  // 先做 verifyActorInTransaction + assertProjectWritable，外层 identity
  // 也先于回执，因此维护/失权/停用都可能返回而根本没看原回执。
  if (retry) {
    const definite = code === 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD'
      || code === 'SANDBOX_PROJECT_PAYLOAD_MISMATCH';
    if (definite) {
      // 载荷冲突是**关于原记录本身**的确定结论，可以结束未决状态。
      clearEnvelope(storage, envId, roundId, boundAccountId);
      return {
        ...result, local: LOCAL_ENTRY_CODES.includes(code), definite: true,
        requestId: envelope.requestId
      };
    }
    return {
      ok: false,
      code: code || 'SANDBOX_RESULT_UNKNOWN',
      message: (result.message || '本次重试被拒绝。')
        + '（本次拒绝只说明这次未执行，不能证明此前结果未知的请求没有提交；'
        + '原未决记录已保留，恢复条件具备后请按同一编号重试。）',
      requestId: envelope.requestId,
      action: envelope.action,
      actionClass: envelope.actionClass,
      retryAllowed: retryAllowed(envelope.action),
      writeLocked: envelope.writeLocked === true || !retryAllowed(envelope.action),
      retryDenied: true,
      unknown: true
    };
  }

  if (BUSINESS_REJECTION_CODES.includes(code)) {
    // **首次**请求的业务层拒绝：结果确定，清理 envelope 以便修正
    clearEnvelope(storage, envId, roundId, boundAccountId);
    return { ...result, local: LOCAL_ENTRY_CODES.includes(code), definite: true };
  }
  if (GATE_REJECTION_CODES.includes(code) || code === '') {
    // 门控/未知错误码：只说明本次未执行，**保留** envelope 与写锁
    return {
      ok: false,
      code: code || 'SANDBOX_RESULT_UNKNOWN',
      message: (result.message ? `${result.message}（本次未执行，不代表此前未知的请求未提交。）` : '本次未执行。'),
      requestId: envelope.requestId,
      action: envelope.action,
      actionClass: envelope.actionClass,
      retryAllowed: retryAllowed(envelope.action),
      writeLocked: envelope.writeLocked === true || !retryAllowed(envelope.action),
      unknown: true
    };
  }
  return {
    ok: false,
    code,
    message: result.message || '结果未知。',
    requestId: envelope.requestId,
    action: envelope.action,
    actionClass: envelope.actionClass,
    retryAllowed: retryAllowed(envelope.action),
    writeLocked: envelope.writeLocked === true || !retryAllowed(envelope.action),
    unknown: true
  };
}

/** 标记本轮写锁：无幂等保障的动作结果未知后，停止一切新写。 */
function markWriteLocked(storage, envId, roundId, accountId, envelope) {
  if (!storage) return;
  const locked = { ...envelope, writeLocked: true };
  writeEnvelope(storage, envId, roundId, locked);
}

/**
 * 解除未决记录：**必须显式声明已在管理端核对**。
 *
 * - 不提供"直接清锁重发"路径：解除后本轮**仍保持写锁**，
 *   新的写动作必须由维护流程在管理端处理，客户端不自动放开。
 * - 不删除旧缓存，也不触碰其它环境/轮次/账号的记录。
 */
function resolvePendingAfterExternalCheck(target, options = {}) {
  const storage = asStorage(target);
  if (!storage) return { ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', message: '无存储能力。' };
  if (options.externallyVerified !== true) {
    return {
      ok: false,
      code: 'SANDBOX_VERIFICATION_REQUIRED',
      message: '解除未决记录前必须显式确认已在管理端核对该请求结果。'
    };
  }
  const envId = sandboxProof.envId;
  const roundId = roundOf();
  const bound = readBoundAccount(storage, envId, roundId);
  if (bound.status !== 'ok') {
    return { ok: false, code: 'SANDBOX_ACCOUNT_UNBOUND', message: '尚未确认当前可信账号。' };
  }
  const accountId = bound.accountId;
  const pending = readEnvelopeRaw(storage, envId, roundId, accountId);
  if (pending.status === 'error') {
    return { ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', message: pending.reason };
  }
  if (pending.status === 'none') {
    return { ok: false, code: 'SANDBOX_NO_PENDING', message: '当前没有未决记录。' };
  }
  // 记录人工核对事实，并**继续锁写**：解除记录 ≠ 放开新写
  const resolved = {
    ...pending.envelope,
    writeLocked: true,
    externallyVerified: true,
    verifiedAt: Date.now()
  };
  if (!writeEnvelope(storage, envId, roundId, resolved)) {
    return { ok: false, code: 'SANDBOX_STORAGE_UNAVAILABLE', message: '无法保存核对结论，已阻止解除。' };
  }
  return { ok: true, requestId: pending.envelope.requestId, writeLocked: true };
}

function cacheKey(key) {
  return `${sandboxProof.cachePrefix}${String(key)}`;
}

module.exports = {
  checkSandboxEntry,
  callSandbox,
  resumePending,
  refreshSessionIdentity,
  resolvePendingAfterExternalCheck,
  cacheKey,
  uid,
  TOP_LEVEL_KEYS,
  FORM_KEYS,
  SENSITIVE_KEYS,
  KNOWN_ACTIONS,
  CLOSED_ACTIONS,
  READ_ONLY_ACTIONS,
  RECEIPT_BACKED_ACTIONS,
  NON_IDEMPOTENT_ACTIONS,
  ACTION_CLASS,
  classifyAction,
  retryAllowed,
  unknownGuidance,
  BUSINESS_REJECTION_CODES,
  GATE_REJECTION_CODES,
  LOCAL_ENTRY_CODES,
  readPending,
  readEnvelopeRaw,
  writeEnvelope,
  clearEnvelope,
  bindAccount,
  readBoundAccount,
  accountKey,
  envelopeKey,
  legacyKeys,
  buildSnapshot,
  snapshotDigest,
  stableStringify
};
