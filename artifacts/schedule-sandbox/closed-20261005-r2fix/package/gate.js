// 施工安排独立测试副本：服务端门槛与两阶段控制。
//
// 方案 §4.2 + Codex 复核 S1/S3：
// - 阶段**允许清单**（不是黑名单）；缺失/未知阶段拒绝，不回落 prepare。
// - **本轮唯一项目**由持久记录（`project-guard` 的唯一记录）确定，而不是配置里的静态 ID。
//   准备期与执行期的项目动作都必须命中**本轮唯一项目**，其他项目一律拒绝。
//   这样准备链（建项目→取号→指定管家→邀请→申请→批准→必要查询）可以走通，
//   又不会变成"禁止所有项目"的死锁（S1）。
// - 归属判定**始终以记录真实归属为准**：请求 projectId 不得覆盖解析出的真实归属；
//   两者同时存在时必须一致（S3）。
// - 邀请码规范化与 vendor 一致：`trim().toUpperCase()` 后哈希查 `tokenHash`。
// - 列表结果只限本轮目标项目（S3）。
// - 已知非法动作、配置与项目参数在**数据库访问前**拒绝；必须读记录才能判定的归属检查
//   属于**受限只读**，拒绝时**零写入**。
// - 原 A/B/C 三个真实项目 ID **硬拒绝**，配置误指这些 ID 也拒绝。

'use strict';

const { SandboxConfigError } = require('./collection-map');

const PHASE_PREPARE = 'prepare';
const PHASE_EXECUTE = 'execute';
const VALID_PHASES = Object.freeze([PHASE_PREPARE, PHASE_EXECUTE]);

// 原 A/B/C 真实项目 ID：任何阶段都硬拒绝，且不得出现在配置或本轮记录中。
const PROTECTED_PROJECT_IDS = Object.freeze([
  'p_38507fc9b43c4e23a7fbd996415637bb',
  'p_a328c08992f7414c812047935bc3c31e',
  'p_4e53f8437dab4ddcb62971d58455acaa'
]);

// 准备期允许的动作：身份类 + 本轮项目的成员筹备 + 必要查询。
// **不含**任何施工安排写动作（施工四写只在执行期）。
const PREPARE_ALLOWED = Object.freeze([
  'identify',
  'listMyProjects',
  'requestBindingNumber',
  'createProject',
  'assignManager',
  'createInvitation',
  'applyInvitation',
  'approveInvitation',
  'removeMember',
  'getMembers',
  'listInvitations',
  'getScheduleContext',
  'listSchedules',
  'getSchedule',
  'listScheduleRevisions'
]);

// 执行期允许的动作：项目内读写，仍受本轮唯一项目限制。
const EXECUTE_ALLOWED = Object.freeze([
  'identify',
  'listMyProjects',
  'requestBindingNumber',
  'createSchedule',
  'updateSchedule',
  'reassignSchedule',
  'cancelSchedule',
  'applyInvitation',
  'removeMember',
  'getMembers',
  'listInvitations',
  'getScheduleContext',
  'listSchedules',
  'getSchedule',
  'listScheduleRevisions'
]);

// 不需要请求携带项目 ID 的动作（身份类 / 建项目 / 按邀请码申请）。
const PROJECT_OPTIONAL_ACTIONS = Object.freeze([
  'identify',
  'listMyProjects',
  'requestBindingNumber',
  'createProject',
  'applyInvitation'
]);

// 明确不开放的动作。
const CLOSED_ACTIONS = Object.freeze([
  'setScheduleWriteMode',
  'restoreReady',
  'migration',
  'repair',
  'rawQuery',
  'adminGrant'
]);

const PHASE_ACTIONS = Object.freeze({
  [PHASE_PREPARE]: PREPARE_ALLOWED,
  [PHASE_EXECUTE]: EXECUTE_ALLOWED
});

function readConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawPhase = source.phase;
  const phase = VALID_PHASES.includes(rawPhase) ? rawPhase : null;
  const projectId = typeof source.projectId === 'string' ? source.projectId.trim() : '';
  const config = {
    enabled: source.enabled === true,
    appId: typeof source.appId === 'string' ? source.appId.trim() : '',
    envId: typeof source.envId === 'string' ? source.envId.trim() : '',
    allowedUserIds: Array.isArray(source.allowedUserIds)
      ? Object.freeze(source.allowedUserIds.filter(v => typeof v === 'string' && v).map(v => v.trim()))
      : Object.freeze([]),
    // projectId 现在只是**期望值**：用于与本轮持久记录交叉校验，不作为唯一依据。
    projectId,
    roundId: typeof source.roundId === 'string' ? source.roundId.trim() : '',
    expiresAt: typeof source.expiresAt === 'string' ? source.expiresAt.trim() : '',
    phase,
    projectReadyMarker: typeof source.projectReadyMarker === 'string' ? source.projectReadyMarker.trim() : ''
  };
  // 配置误指原 A/B/C 时标记为不可用。
  config.projectIdMisconfigured = Boolean(projectId) && PROTECTED_PROJECT_IDS.includes(projectId);
  return Object.freeze(config);
}

function deny(code, message) {
  throw new SandboxConfigError(code, message);
}

// 能在访问数据库之前判定的条件，必须零数据库访问。
function checkPreDatabase(config, trusted) {
  if (config.enabled !== true) deny('SANDBOX_DISABLED', '施工安排测试副本未开启。');

  if (!config.envId) deny('SANDBOX_CONFIG_INCOMPLETE', '测试副本环境ID未配置。');
  if (!trusted || typeof trusted.envId !== 'string' || trusted.envId.trim() === '') {
    deny('SANDBOX_ENV_UNVERIFIED', '无法确认当前运行环境。');
  }
  if (trusted.envId.trim() !== config.envId) {
    deny('SANDBOX_ENV_MISMATCH', '当前环境不在测试副本允许范围内。');
  }

  if (!config.appId) deny('SANDBOX_CONFIG_INCOMPLETE', '测试副本 AppID 未配置。');
  if (!trusted || typeof trusted.appId !== 'string' || trusted.appId.trim() === '') {
    deny('SANDBOX_APPID_UNVERIFIED', '无法确认当前小程序身份。');
  }
  if (trusted.appId.trim() !== config.appId) {
    deny('SANDBOX_APPID_MISMATCH', '当前小程序不在测试副本允许范围内。');
  }

  if (!config.roundId) deny('SANDBOX_CONFIG_INCOMPLETE', '测试轮次未配置。');
  if (!config.expiresAt) deny('SANDBOX_CONFIG_INCOMPLETE', '测试窗口截止时间未配置。');
  const deadline = Date.parse(config.expiresAt);
  if (!Number.isFinite(deadline)) deny('SANDBOX_CONFIG_INVALID', '测试窗口截止时间不合法。');
  const nowMs = typeof trusted.nowMs === 'number' ? trusted.nowMs : Date.now();
  if (nowMs > deadline) deny('SANDBOX_EXPIRED', '测试窗口已截止，拒绝新的请求。');

  if (config.allowedUserIds.length === 0) {
    deny('SANDBOX_CONFIG_INCOMPLETE', '测试副本允许账号列表未配置。');
  }
  if (config.projectIdMisconfigured) {
    deny('SANDBOX_PROJECT_PROTECTED', '配置指向受保护的原项目，已拒绝。');
  }
  return true;
}

function checkPhase(config) {
  if (!config.phase) {
    deny('SANDBOX_PHASE_UNKNOWN', '测试副本阶段未配置或无法识别，已拒绝。');
  }
  if (config.phase === PHASE_EXECUTE && !config.projectReadyMarker) {
    deny('SANDBOX_CONFIG_INCOMPLETE', '执行期缺少本轮项目已建立的持久标记配置。');
  }
  return config.phase;
}

function assertActionAllowed(config, action) {
  if (typeof action !== 'string' || action === '') {
    deny('BAD_INPUT', '操作名称缺失。');
  }
  const closed = Object.assign(Object.create(null), CLOSED_ACTIONS);
  if (Object.prototype.hasOwnProperty.call(closed, action)) {
    deny('SANDBOX_ACTION_CLOSED', `操作「${action}」不在施工安排测试副本的开放范围内。`);
  }
  if (!config.phase) {
    deny('SANDBOX_PHASE_UNKNOWN', '测试副本阶段未确认，拒绝任何业务动作。');
  }
  const allowed = PHASE_ACTIONS[config.phase] || [];
  if (!allowed.includes(action)) {
    deny('SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE',
      `操作「${action}」在 ${config.phase} 阶段不允许执行。`);
  }
  return action;
}

function assertCreateProjectAllowed(config) {
  if (config.phase !== PHASE_PREPARE) {
    deny('SANDBOX_PHASE_LOCKED', '执行期禁止再创建项目。');
  }
  if (!config.projectReadyMarker) {
    deny('SANDBOX_CONFIG_INCOMPLETE', '缺少本轮项目持久标记配置。');
  }
  return true;
}

function isProjectOptional(action) {
  return PROJECT_OPTIONAL_ACTIONS.includes(action);
}

/**
 * 项目范围判定（S1/S3）。
 *
 * @param config         配置
 * @param requestedId    请求携带的 projectId（可为空）
 * @param roundProjectId 本轮持久记录中的唯一项目 ID（未建立时为 null）
 * @param action         动作名
 * @returns {string|null} 本轮唯一项目 ID
 *
 * 规则：
 * 1. 受保护 ID 任何时候都拒绝。
 * 2. 执行期要求本轮项目已建立，且与配置期望交叉一致。
 * 3. 请求带 ID 时必须**等于**本轮唯一项目（不得覆盖）。
 * 4. 需要项目的动作在未建立本轮项目时拒绝；不需项目的动作放行。
 */
function assertProjectScope(config, requestedId, roundProjectId, action) {
  const needsProject = !isProjectOptional(action);

  if (config.phase === PHASE_EXECUTE) {
    if (!roundProjectId) {
      deny('SANDBOX_PROJECT_NOT_READY', '执行期尚未建立本轮测试项目，无法执行项目操作。');
    }
    if (config.projectId && config.projectId !== roundProjectId) {
      deny('SANDBOX_PROJECT_STATE_CONFLICT', '本轮项目记录与配置不一致，已停止。');
    }
  }

  const hasRequested = requestedId !== undefined && requestedId !== null && requestedId !== '';
  if (hasRequested) {
    if (typeof requestedId !== 'string') {
      deny('SANDBOX_PROJECT_INVALID', '项目编号必须是非空字符串。');
    }
    if (PROTECTED_PROJECT_IDS.includes(requestedId)) {
      deny('SANDBOX_PROJECT_PROTECTED', '原项目不在测试副本可操作范围内，已拒绝。');
    }
    if (!roundProjectId) {
      deny('SANDBOX_PROJECT_NOT_READY', '本轮尚未建立测试项目，拒绝指定项目操作。');
    }
    if (requestedId !== roundProjectId) {
      deny('SANDBOX_PROJECT_MISMATCH', '请求的项目不是本轮测试项目，已拒绝。');
    }
    return roundProjectId;
  }

  if (needsProject) {
    if (!roundProjectId) {
      deny('SANDBOX_PROJECT_NOT_READY', '本轮尚未建立测试项目，无法执行项目操作。');
    }
    return roundProjectId;
  }
  return roundProjectId || null;
}

/**
 * 记录归属核验（受限只读，拒绝时零写入）。
 * `resolvedProjectId` 必须是**从记录解析出的真实归属**，
 * 请求 ID 若存在必须与之一致。
 */
function assertRecordOwnership(roundProjectId, requestedId, resolvedProjectId) {
  if (PROTECTED_PROJECT_IDS.includes(resolvedProjectId || '')) {
    deny('SANDBOX_PROJECT_PROTECTED', '记录归属指向受保护的原项目，已拒绝。');
  }
  if (!resolvedProjectId) {
    deny('SANDBOX_PROJECT_NOT_READY', '无法确定记录归属，已拒绝。');
  }
  if (!roundProjectId || resolvedProjectId !== roundProjectId) {
    deny('SANDBOX_PROJECT_MISMATCH', '记录归属不是本轮测试项目，已拒绝。');
  }
  if (requestedId && requestedId !== resolvedProjectId) {
    deny('SANDBOX_PROJECT_MISMATCH', '请求项目与记录真实归属不一致，已拒绝。');
  }
  return resolvedProjectId;
}

// 列表结果只限本轮目标项目（S3）；未建立目标时返回空列表。
function filterRoundProjects(roundProjectId, projects) {
  if (!roundProjectId) return [];
  return (projects || []).filter(p => p && p.id === roundProjectId);
}

module.exports = Object.freeze({
  PHASE_PREPARE,
  PHASE_EXECUTE,
  VALID_PHASES,
  PROTECTED_PROJECT_IDS,
  PREPARE_ALLOWED,
  EXECUTE_ALLOWED,
  PROJECT_OPTIONAL_ACTIONS,
  CLOSED_ACTIONS,
  PHASE_ACTIONS,
  readConfig,
  checkPreDatabase,
  checkPhase,
  assertActionAllowed,
  assertCreateProjectAllowed,
  isProjectOptional,
  assertProjectScope,
  assertRecordOwnership,
  filterRoundProjects
});
