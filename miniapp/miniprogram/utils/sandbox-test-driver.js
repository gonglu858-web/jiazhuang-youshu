// 施工安排独立测试副本：**专用测试驱动**（V06 三对并发 / V07 两次移出）。
//
// 依据：任务文档 §3（门槛）、§4（互斥与未知）、§5（V06）、§6（V07），
// 以及 Codex 复核 R2（固定目标）、R3（真实前提与响应形状）、R4（生命周期）。
//
// 与普通客户端的**根本区别**（不可回退）：
// - 驱动**不写**普通 envelope，也**不读**普通 envelope 作为防重依据；
//   它用自己的一次性持久记录（协调器）保证「一个用例一轮只发一对」。
// - 驱动**不放宽**普通防重：普通未决存在时驱动**拒绝启动**。
// - 驱动占用期间普通入口**反向拒绝**（见 schedule-sandbox-client 的接入点）；
//   普通请求在途时驱动同样被拒（普通入口也持有同一张占用表）。
// - `removeMember`（V07）**没有**服务端 requestId 幂等：只发一次，
//   超时/未知**不重发、不恢复、不清锁**。
//
// 两笔请求的发起方式：只在**单一同步段**内连续调用 send，不先 await 第一笔
// 再发第二笔（§4）。已发出的不能取消；一边失败不自动补发第三笔。
//
// 本文件**不含**任何 wx.cloud 直调之外的副作用；调用必须由真实小程序运行时
// 通过 `wx.cloud.callFunction` 执行。Node 侧只跑离线测试，不扮演真实微信账号。

'use strict';

const driverProof = require('../config/sandbox-test-driver-proof');
const sandboxProof = require('../config/schedule-sandbox-proof');
const coordinator = require('./sandbox-test-coordinator');

/**
 * 报告允许透出的业务错误码白名单。
 * 不在白名单内的码只记录 `UNKNOWN_CODE`，**不序列化底层错误对象**。
 */
const ALLOWED_ERROR_CODES = Object.freeze([
  'SCHEDULE_CONFLICT', 'VERSION_MISMATCH', 'WORKER_HAS_ACTIVE_SCHEDULES',
  'NO_ACCESS', 'IDENTITY_DISABLED', 'IDENTITY_UNAVAILABLE', 'WORKER_INVALID',
  'BAD_INPUT', 'TASK_DIR_NOT_READY', 'TASK_DIR_CAPACITY_EXCEEDED', 'TASK_DIR_INCONSISTENT',
  'PROJECT_NOT_WRITABLE', 'OCCUPANCY_INCONSISTENT', 'SCHEDULE_OPERATION_BUDGET_EXCEEDED',
  'STALE_SCAN', 'CODE_INVALID', 'OWNER_EXISTS', 'ALREADY_EXISTS', 'GUARD_INCONSISTENT',
  'MAINTENANCE_RESTORE_BLOCKED', 'TRANSACTION_UNAVAILABLE', 'SERVER_ERROR'
]);

/** 通用文案：替代底层错误文本，避免泄露 SDK/环境细节。 */
const GENERIC_MESSAGE = '服务端已响应，结果未在允许清单内。';

/**
 * 受保护角色：这些人不能作为 V07 移出目标。
 * 只用 service 真实公开的 `roles` 字段判断，不假造字段、不新增云路由。
 */
const PROTECTED_ROLES = Object.freeze(['负责人', '管家', '主业主']);

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function nowIso(ms) {
  return new Date(ms).toISOString();
}

/** 固定 uid：仅作追踪编号，**不作幂等来源**。 */
function makeTrackingId(prefix, testCaseId, index) {
  return `${prefix}-${testCaseId}-${index}-${Date.now().toString(36)}`;
}

/** 只保留白名单码；其它一律折叠为 UNKNOWN_CODE。 */
function sanitizeCode(code) {
  return ALLOWED_ERROR_CODES.includes(code) ? code : 'UNKNOWN_CODE';
}

/**
 * 公开成功响应的**白名单字段**。
 * 依据已验收 service 的 `publicSchedule`：id / projectId / stage / trade /
 * workerUserId / startDate / endDate / expectedDate / restDays / content /
 * status / version。**不是 scheduleId**。
 */
const PUBLIC_SCHEDULE_FIELDS = Object.freeze([
  'id', 'projectId', 'stage', 'trade', 'workerUserId', 'startDate', 'endDate',
  'expectedDate', 'restDays', 'content', 'status', 'version'
]);

/**
 * 成功响应的**逐字段类型白名单**。
 *
 * S4 返修：此前 `sanitizeResult` 直接把 `content`、`restDays` 等字段
 * **原样复制**进报告与长期存储，于是一个 `{token:...}` 这样的嵌套对象
 * 会一路落盘。现在：类型不符一律不复制，坏成功只留**安全诊断码**。
 */
const PUBLIC_FIELD_TYPES = Object.freeze({
  id: 'text',
  projectId: 'text',
  stage: 'text',
  trade: 'text',
  workerUserId: 'text',
  startDate: 'text',
  endDate: 'text',
  expectedDate: 'text',
  content: 'text',
  status: 'text',
  version: 'positiveInteger',
  restDays: 'stringArray'
});

/** 某字段是否符合白名单类型。 */
function matchesFieldType(field, value) {
  const kind = PUBLIC_FIELD_TYPES[field];
  if (!kind) return false;
  if (kind === 'text') return typeof value === 'string' && value.trim().length > 0;
  if (kind === 'positiveInteger') return Number.isInteger(value) && value >= 1;
  if (kind === 'stringArray') {
    if (!Array.isArray(value)) return false;
    return value.every(v => typeof v === 'string' && v.trim().length > 0);
  }
  return false;
}

/**
 * 按白名单与逐字段类型净化成功响应。
 *
 * - 只复制**类型合法**的公开字段；非法字段**不复制**，并记 `badFields`；
 * - `badFields` 只保留**字段名**（安全诊断码），绝不携带任何原始值；
 * - 没有任何可复制字段时按坏成功处理。
 */
function sanitizeResult(result) {
  if (!isPlainObject(result)) return { ok: false, code: 'BAD_SHAPE' };
  if (result.ok === true) {
    const out = { ok: true };
    const badFields = [];
    for (const field of PUBLIC_SCHEDULE_FIELDS) {
      if (result[field] === undefined) continue;
      if (!matchesFieldType(field, result[field])) {
        badFields.push(field);
        continue;
      }
      out[field] = Array.isArray(result[field]) ? result[field].slice() : result[field];
    }
    // removeMember 的公开成功返回 { userId, status }
    if (result.userId !== undefined) {
      if (typeof result.userId === 'string' && result.userId.trim()) out.userId = result.userId;
      else badFields.push('userId');
    }
    if (badFields.length) {
      // 坏成功：只留字段名作为诊断码，不复制任何原始值
      out.invalidFields = badFields;
      return out;
    }
    if (out.id === undefined && out.userId === undefined) {
      return { ok: false, code: 'BAD_SHAPE' };
    }
    return out;
  }
  return { ok: false, code: sanitizeCode(result.code) };
}

/**
 * 严格核验一份公开成功响应（**按 service 公开契约**）。
 * 任何类型不符、目标不符、字段缺失都判失败 —— 不让未校验的嵌套内容流入报告。
 *
 * @param {object} result 已 sanitize 的成功结果
 * @param {object} expect { projectId, workerUserId, scheduleId?, version? }
 */
function verifyScheduleSuccess(result, expect) {
  if (!isPlainObject(result) || result.ok !== true) return { ok: false, reason: 'NOT_SUCCESS' };
  // S4 返修：sanitize 标记了非法字段 → 直接判坏成功
  // （此前只查 id/version/status，content 等字段的非法类型能一路通过）
  if (Array.isArray(result.invalidFields) && result.invalidFields.length) {
    return { ok: false, reason: `INVALID_FIELD_${result.invalidFields[0]}` };
  }
  const text = v => typeof v === 'string' && v.trim().length > 0;
  if (!text(result.id)) return { ok: false, reason: 'ID_MISSING' };
  if (!/^s_[0-9a-zA-Z]+$/.test(result.id)) return { ok: false, reason: 'ID_MALFORMED' };
  if (expect.projectId !== undefined && result.projectId !== expect.projectId) {
    return { ok: false, reason: 'PROJECT_MISMATCH' };
  }
  if (expect.workerUserId !== undefined && result.workerUserId !== expect.workerUserId) {
    return { ok: false, reason: 'WORKER_MISMATCH' };
  }
  if (result.status !== 'active') return { ok: false, reason: 'STATUS_NOT_ACTIVE' };
  if (!Number.isInteger(result.version) || result.version < 1) {
    return { ok: false, reason: 'VERSION_NOT_POSITIVE_INTEGER' };
  }
  if (expect.scheduleId !== undefined && result.id !== expect.scheduleId) {
    return { ok: false, reason: 'SCHEDULE_MISMATCH' };
  }
  if (expect.version !== undefined && result.version !== expect.version) {
    return { ok: false, reason: 'VERSION_MISMATCH' };
  }
  // 报告里出现过的每个公开字段都必须**已经通过类型白名单**
  for (const field of PUBLIC_SCHEDULE_FIELDS) {
    if (result[field] !== undefined && !matchesFieldType(field, result[field])) {
      return { ok: false, reason: `INVALID_FIELD_${field}` };
    }
  }
  return { ok: true };
}

/** V07-B 的公开成功形状：{ userId, status:'left' }。 */
function verifyRemovedSuccess(result, targetUserId) {
  if (!isPlainObject(result) || result.ok !== true) return { ok: false, reason: 'NOT_SUCCESS' };
  if (result.userId !== targetUserId) return { ok: false, reason: 'USER_MISMATCH' };
  if (result.status !== 'left') return { ok: false, reason: 'STATUS_NOT_LEFT' };
  return { ok: true };
}

// ── 门控 ──────────────────────────────────────────────────────────────────

/**
 * 双开关与目标一致性门控（**纯本地，不发请求**）。
 * 驱动开关与旧 sandbox proof 必须**同时**允许。
 *
 * R2 返修：**实际 AppID** 从 getAccountInfoSync 读出并与固定值精确比对。
 *
 * S1 返修：**不再要求运行时返回 CloudBase envId**。
 * 微信官方 `AccountInfo.miniProgram`（`MiniProgram`）只有 `appId`、`envVersion`、
 * `version`，**没有** `envId`；此前要求它等于固定环境，导致按标准接口形状
 * 根本无法运行。CloudBase 目标改由三重保证：
 * 1) 两份 proof 的 `envId` 必须彼此一致且等于固定常量；
 * 2) `sendFixed` 每次调用都显式传 `config.env = 固定环境`；
 * 3) 客户端不提供任何隐式默认环境的回退路径。
 * 运行时**只**校验 AppID 与明确的 develop/trial。
 */
function gate(options) {
  const api = options.api;
  const reasons = [];
  if (driverProof.enabled !== true) reasons.push('专用测试驱动未启用。');
  if (sandboxProof.enabled !== true) reasons.push('测试副本入口未启用。');

  // 固定 AppID / 环境 / 函数名（**先核对固定常量本身**）
  if (driverProof.appId !== 'wxfb4db1615ac15531') reasons.push('驱动配置 AppID 不符固定值。');
  if (driverProof.envId !== 'cloud1-d8gcq5ag39d847723') reasons.push('驱动配置环境不符固定值。');
  if (driverProof.functionName !== 'scheduleSandbox') reasons.push('驱动配置函数名不符固定值。');

  // 两 proof 必需动态字段：**两侧都必须非空**才比较，不允许空值跳过
  for (const field of ['roundId', 'projectId']) {
    const a = driverProof[field];
    const b = field === 'roundId' ? sandboxProof.roundId : sandboxProof.sandboxProjectId;
    if (typeof a !== 'string' || !a.trim()) reasons.push(`驱动配置缺 ${field}，无法与副本配置核对。`);
    if (typeof b !== 'string' || !b.trim()) reasons.push(`副本配置缺 ${field === 'roundId' ? 'roundId' : 'sandboxProjectId'}，无法核对。`);
    if (typeof a === 'string' && typeof b === 'string' && a.trim() && b.trim() && a.trim() !== b.trim()) {
      reasons.push(field === 'roundId' ? '轮次与副本配置不一致。' : '项目与副本配置不一致。');
    }
  }
  if (driverProof.appId !== sandboxProof.appId) reasons.push('AppID 与副本配置不一致。');
  if (driverProof.envId !== sandboxProof.envId) reasons.push('环境与副本配置不一致。');
  if (driverProof.functionName !== sandboxProof.functionName) reasons.push('函数名与副本配置不一致。');

  // 运行时账号信息：**只**校验官方契约里的 appId 与 envVersion
  const info = api && typeof api.getAccountInfoSync === 'function' ? safeAccountInfo(api) : null;
  if (!info) {
    reasons.push('无法读取运行环境信息。');
  } else {
    if (!info.appId) reasons.push('运行环境未返回 AppID。');
    else if (info.appId !== driverProof.appId) reasons.push('实际运行 AppID 与固定 AppID 不一致。');
    if (!info.envVersion || !driverProof.allowedVersions.includes(info.envVersion)) {
      reasons.push('仅开发版/体验版可使用专用测试。');
    }
    // 说明：官方 MiniProgram 不提供 envId；云环境由固定 proof + config.env 保证。
    // 若某个运行时就**额外**提供了 envId，也一律与固定值核对（不静默接受不一致）。
    if (typeof info.extraEnvId === 'string' && info.extraEnvId && info.extraEnvId !== driverProof.envId) {
      reasons.push('运行环境声明的云环境与固定环境不一致。');
    }
  }
  if (reasons.length) {
    return { ok: false, code: 'TEST_DRIVER_GATE_BLOCKED', reasons, actual: info };
  }
  return { ok: true, envVersion: info.envVersion, actual: info };
}

/**
 * 读取运行时账号信息。
 * **只承认官方契约字段** `appId` / `envVersion` / `version`；
 * `envId` 不是官方字段，这里记为 `extraEnvId` 供「若额外提供则核对」使用，
 * 不作为放行条件。
 */
function safeAccountInfo(api) {
  try {
    const raw = api.getAccountInfoSync();
    const mp = (raw && raw.miniProgram) || {};
    return {
      appId: typeof mp.appId === 'string' ? mp.appId : '',
      envVersion: typeof mp.envVersion === 'string' ? mp.envVersion : '',
      version: typeof mp.version === 'string' ? mp.version : '',
      extraEnvId: typeof mp.envId === 'string' ? mp.envId : ''
    };
  } catch (error) {
    return null;
  }
}

/**
 * 专用调用：**每次都显式限定**固定环境 + 固定函数名，**不写普通 envelope**。
 *
 * S1 返修：云环境的保证不依赖运行时账号信息（官方契约不提供 envId），
 * 而是靠这里**每次调用**都把 `config.env` 钉死在固定常量上；
 * 若配置被改成别的环境，直接抛错而不是发出去。
 */
function sendFixed(api, body) {
  if (driverProof.envId !== 'cloud1-d8gcq5ag39d847723') {
    throw new Error('驱动配置环境不符固定值，已阻止发送。');
  }
  if (driverProof.functionName !== 'scheduleSandbox') {
    throw new Error('驱动配置函数名不符固定值，已阻止发送。');
  }
  return api.cloud.callFunction({
    name: driverProof.functionName,
    config: { env: 'cloud1-d8gcq5ag39d847723' },
    data: body
  });
}

// ── 固定目标核对（R2）─────────────────────────────────────────────────────

/**
 * 输入项目必须与固定目标一致，且不得是受保护项目。
 * **在首次请求之前**调用；不一致即零发送。
 */
function verifyFixedTarget(input) {
  const reasons = [];
  const fixed = driverProof.projectId;
  if (typeof fixed !== 'string' || !fixed.trim()) {
    reasons.push('配置缺固定项目。');
    return { ok: false, reasons };
  }
  const got = input && input.projectId;
  if (typeof got !== 'string' || !got.trim()) {
    reasons.push('输入缺项目编号。');
  } else if (got.trim() !== fixed.trim()) {
    // 包括指向 A/B/C 受保护项目：先核对一个项目再操作另一个项目不成立
    reasons.push(`输入项目与固定目标不一致（${got.trim()} ≠ ${fixed.trim()}）。`);
  }
  if (driverProof.protectedProjectIds.includes(fixed.trim())) {
    reasons.push('固定目标指向受保护的原项目。');
  }
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, projectId: fixed.trim() };
}

/**
 * V07 目标核对（**只用 service 公开字段**）。
 * - 必须是配置里的**非空完整**目标，禁止表单兜底；
 * - 目标必须在该项目、角色为师傅、且不是执行人/管家/负责人/主业主。
 *
 * @param {object} input { userId }
 * @param {object} membersResult getMembers 的公开结果
 */
function verifyV07Target(input, membersResult) {
  const reasons = [];
  const fixed = driverProof.v07TargetUserId;
  if (typeof fixed !== 'string' || !fixed.trim()) {
    reasons.push('配置缺 V07 完整目标账号。');
    return { ok: false, reasons };
  }
  if (!/^u_[0-9a-f]{40}$/.test(fixed.trim())) {
    reasons.push('V07 目标必须是完整 userId，不接受尾号或昵称。');
  }
  const got = input && input.userId;
  if (typeof got !== 'string' || !got.trim()) {
    reasons.push('输入缺 V07 目标账号。');
  } else if (got.trim() !== fixed.trim()) {
    reasons.push(`V07 输入目标与固定目标不一致（${got.trim()} ≠ ${fixed.trim()}）。`);
  }
  if (!isPlainObject(membersResult) || !Array.isArray(membersResult.members)) {
    reasons.push('成员公开结果不可用，无法确认 V07 目标。');
    return { ok: false, reasons };
  }
  const target = membersResult.members.find(x => isPlainObject(x) && x.userId === fixed.trim());
  if (!target) {
    reasons.push('V07 目标不在该项目的公开成员列表中。');
    return { ok: false, reasons };
  }
  const roles = Array.isArray(target.roles) ? target.roles : [];
  if (roles.some(r => PROTECTED_ROLES.includes(r))) {
    reasons.push('V07 目标是受保护角色（负责人/管家/主业主），不得作为移出对象。');
  }
  if (!roles.includes('师傅')) {
    reasons.push('V07 目标角色不是师傅。');
  }
  if (fixed.trim() === driverProof.actorUserId) {
    reasons.push('V07 目标是当前执行人，不得自移出。');
  }
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, targetUserId: fixed.trim() };
}

// ── 请求组包（固定计划绑定，不提供任意 JSON）──────────────────────────────

/**
 * 按用例与固定计划构造两笔请求。
 * 字段必须由计划提供；缺字段即失败，不以默认值糊过去。
 *
 * R3 返修：
 * - b 强制两个请求号**不同**；c 也强制不同；
 * - c 的 expectedVersion 必须是**正整数**；
 * - 不自动授予日期确认（expectedDate 收窄为 endDate，不一致即拒绝）。
 */
function buildPair(spec, input) {
  const out = { requests: [], ok: false };
  const missing = [];
  for (const field of ['projectId', 'actorUserId', 'stage', 'trade', 'workerUserId', 'startDate', 'endDate']) {
    const v = input[field];
    if (typeof v !== 'string' || !v.trim()) missing.push(field);
  }
  if (spec.pair === 'createSchedule') {
    if (missing.length) { out.missing = missing; return out; }
    for (const field of ['expectedDate', 'content']) {
      if (typeof input[field] !== 'string' || !input[field].trim()) missing.push(field);
    }
    if (missing.length) { out.missing = missing; return out; }
    // 日期确认**不自动授予**：本固定计划收窄为 expectedDate === endDate
    if (input.expectedDate !== input.endDate) {
      out.dateMismatch = { expectedDate: input.expectedDate, endDate: input.endDate };
      return out;
    }
    if (!input.requestId1 || !input.requestId2) { out.missing = ['requestId1', 'requestId2']; return out; }
    if (!spec.sameRequestId && input.requestId1 === input.requestId2) {
      out.sameRequestIdRejected = true;
      return out;
    }
    const form = {
      stage: input.stage,
      trade: input.trade,
      workerUserId: input.workerUserId,
      startDate: input.startDate,
      endDate: input.endDate,
      expectedDate: input.endDate,
      restDays: Array.isArray(input.restDays) ? input.restDays.slice() : [],
      content: input.content
    };
    const requestIdA = spec.sameRequestId ? input.requestId1 : input.requestId1;
    const requestIdB = spec.sameRequestId ? input.requestId1 : input.requestId2;
    out.requests = [
      { action: 'createSchedule', projectId: input.projectId, requestId: requestIdA, form: clone(form) },
      { action: 'createSchedule', projectId: input.projectId, requestId: requestIdB, form: clone(form) }
    ];
    out.ok = true;
    return out;
  }
  if (spec.pair === 'updateSchedule') {
    for (const field of ['scheduleId', 'content1', 'content2', 'reason']) {
      const v = input[field];
      if (typeof v !== 'string' || !v.trim()) missing.push(field);
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      out.badVersion = input.expectedVersion;
      out.missing = ['expectedVersion(正整数)'];
      return out;
    }
    if (missing.length) { out.missing = missing; return out; }
    if (!input.requestId1 || !input.requestId2) { out.missing = ['requestId1', 'requestId2']; return out; }
    if (input.requestId1 === input.requestId2) { out.sameRequestIdRejected = true; return out; }
    // 内容必须**确实不同**，否则不构成版本冲突用例
    if (input.content1 === input.content2) { out.sameContentRejected = true; return out; }
    const base = {
      stage: input.stage,
      trade: input.trade,
      workerUserId: input.workerUserId,
      startDate: input.startDate,
      endDate: input.endDate,
      // S4 返修：采用**读取到的当前 expectedDate**，不再用 endDate 覆盖它。
      // 本固定测试计划收窄为「日期相等」，因此调用方必须在读取后确认
      // 当前 expectedDate === endDate；不等时明确停止（见 runCase）。
      expectedDate: input.expectedDate,
      // 休息日必须是**读到**的数组；缺字段不得用空数组替代
      restDays: Array.isArray(input.restDays) ? input.restDays.slice() : null
    };
    if (typeof base.expectedDate !== 'string' || !base.expectedDate.trim()) {
      out.missing = ['expectedDate(来自当前安排)'];
      return out;
    }
    if (base.restDays === null) {
      out.missing = ['restDays(来自当前安排)'];
      return out;
    }
    out.requests = [
      {
        action: 'updateSchedule', projectId: input.projectId, scheduleId: input.scheduleId,
        requestId: input.requestId1, expectedVersion: input.expectedVersion,
        reason: input.reason, form: Object.assign(clone(base), { content: input.content1 })
      },
      {
        action: 'updateSchedule', projectId: input.projectId, scheduleId: input.scheduleId,
        requestId: input.requestId2, expectedVersion: input.expectedVersion,
        reason: input.reason, form: Object.assign(clone(base), { content: input.content2 })
      }
    ];
    out.ok = true;
    return out;
  }
  out.missing = ['unsupportedPair'];
  return out;
}

/** 移出组包：顶层 userId（不是 memberId）。目标由 verifyV07Target 固定。 */
function buildRemoveMember(input) {
  const missing = [];
  for (const field of ['projectId', 'userId']) {
    const v = input[field];
    if (typeof v !== 'string' || !v.trim()) missing.push(field);
  }
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    requests: [{
      action: 'removeMember',
      projectId: input.projectId,
      userId: input.userId,
      requestId: input.requestId || makeTrackingId('t', 'V07', 1)
    }]
  };
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// ── 结果判定（只认明确码与有效形状）────────────────────────────────────────

/**
 * 判定 V06 两笔结果。
 * - a：两次成功、目标一致、**版本均为 1**、关键字段完全相同 → candidate
 * - b/c：任意顺序的一成功 + 指定冲突码 → candidate
 * - 其它一切组合（双成功、双拒绝、未知码、坏形状、SERVER_ERROR）→ stopped
 */
function judgeV06(spec, left, right) {
  if ([left, right].some(r => !isPlainObject(r))) {
    return { verdict: 'stopped', stoppedReason: 'BAD_SUCCESS_SHAPE' };
  }
  const oks = [left, right].filter(r => r.ok === true);
  const conflictCode = spec.expect.conflictCode;
  const expect = {
    projectId: spec.expect.projectId,
    workerUserId: spec.expect.workerUserId,
    scheduleId: spec.expect.scheduleId,
    version: spec.expect.version
  };
  if (spec.expect.bothOk) {
    if (oks.length !== 2) return { verdict: 'stopped', stoppedReason: 'EXPECTED_BOTH_OK' };
    // 严格形状核验：对象型字段、非标状态、非正整数版本一律停止
    const shapeProblems = [];
    for (const r of [left, right]) {
      const v = verifyScheduleSuccess(r, expect);
      if (!v.ok) shapeProblems.push(v.reason);
    }
    if (shapeProblems.length) {
      return { verdict: 'stopped', stoppedReason: `BAD_SUCCESS_SHAPE_${shapeProblems[0]}` };
    }
    if (left.version !== 1 || right.version !== 1) {
      return { verdict: 'stopped', stoppedReason: 'VERSION_NOT_ONE' };
    }
    // 只比较**标量**判定字段；嵌套内容不参与相等判定
    const fields = spec.expect.compareFields;
    const scalar = fields.filter(f => {
      const v = left[f];
      return v === null || typeof v !== 'object';
    });
    if (scalar.length !== fields.length) {
      return { verdict: 'stopped', stoppedReason: 'COMPARE_FIELD_NOT_SCALAR' };
    }
    const same = scalar.every(f => left[f] !== undefined && left[f] === right[f]);
    if (!same) return { verdict: 'stopped', stoppedReason: 'RESULT_FIELDS_DIFFER' };
    return { verdict: 'candidate' };
  }
  // b/c：一成一败，且败方必须是**明确**的冲突码
  if (oks.length !== 1) {
    return { verdict: 'stopped', stoppedReason: oks.length === 0 ? 'BOTH_REJECTED' : 'BOTH_OK' };
  }
  const winner = oks[0];
  const shape = verifyScheduleSuccess(winner, expect);
  if (!shape.ok) return { verdict: 'stopped', stoppedReason: `BAD_SUCCESS_SHAPE_${shape.reason}` };
  const loser = [left, right].find(r => r.ok !== true);
  if (!loser || loser.code === 'UNKNOWN_CODE' || loser.code === 'SERVER_ERROR') {
    return { verdict: 'stopped', stoppedReason: 'LOSER_CODE_NOT_ALLOWED' };
  }
  if (loser.code !== conflictCode) {
    return { verdict: 'stopped', stoppedReason: `LOSER_CODE_${loser.code}` };
  }
  return { verdict: 'candidate' };
}

/** 判定 V07-A：必须是被允许的明确拒绝码。 */
function judgeV07A(result) {
  if (!isPlainObject(result)) return { verdict: 'stopped', stoppedReason: 'BAD_SHAPE' };
  if (result.ok === true) return { verdict: 'stopped', stoppedReason: 'UNEXPECTED_SUCCESS' };
  if (result.code === 'UNKNOWN_CODE' || result.code === 'SERVER_ERROR') {
    return { verdict: 'stopped', stoppedReason: 'CODE_NOT_ALLOWED' };
  }
  if (result.code !== 'WORKER_HAS_ACTIVE_SCHEDULES') {
    return { verdict: 'stopped', stoppedReason: `CODE_${result.code}` };
  }
  return { verdict: 'candidate' };
}

/** 判定 V07-B：必须成功且返回 { userId: 目标, status: 'left' }。 */
function judgeV07B(result, targetUserId) {
  if (!isPlainObject(result)) return { verdict: 'stopped', stoppedReason: 'BAD_SHAPE' };
  if (result.ok !== true) {
    if (result.code === 'UNKNOWN_CODE' || result.code === 'SERVER_ERROR') {
      return { verdict: 'stopped', stoppedReason: 'CODE_NOT_ALLOWED' };
    }
    return { verdict: 'stopped', stoppedReason: `CODE_${result.code}` };
  }
  const v = verifyRemovedSuccess(result, targetUserId);
  if (!v.ok) return { verdict: 'stopped', stoppedReason: v.reason };
  return { verdict: 'candidate' };
}

// ── 前置读取（V06-c 的真实 getSchedule、V07 的 listSchedules）─────────────

/**
 * 用**完整分页**读取项目的 active 安排（V07 前提）。
 * 只用公开 listSchedules 契约；分页未读完视为前提无法确认。
 *
 * S4 返修：严格化 —— 之前把「可解析但不可信」的结果当成空集合，
 * 导致 V07-B 在无法确认前提时仍然发出移出请求。现在：
 * - `ok` 必须为 true；
 * - `schedules` 必须是数组，且**每一行**都要能通过公开契约校验
 *   （id 形态、projectId 一致、status 与筛选一致、版本为正整数、
 *   必填文本字段、restDays 为字符串数组）；**坏行不静默丢弃**；
 * - `pagination.hasMore` 必须是**显式布尔**；为 true 时 `nextCursor`
 *   必须存在、合法且**不与上一次相同**（防循环）；
 * - 任何不完整/循环/错误一律「前提未知」，绝不当作 EMPTY。
 */
async function readAllActiveSchedules(api, projectId, timers) {
  const collected = [];
  const seenCursors = new Set();
  let cursor = '';
  for (let round = 0; round < 20; round++) {
    const got = await withTimeout(
      sendFixed(api, { action: 'listSchedules', projectId, status: 'active', cursor, limit: 100 }),
      driverProof.uiTimeoutSeconds * 1000, timers
    );
    if (got.timedOut) return { ok: false, reason: 'LIST_SCHEDULES_TIMEOUT' };
    if (got.error) return { ok: false, reason: 'LIST_SCHEDULES_FAILED' };
    const result = got.value && got.value.result;
    if (!isPlainObject(result)) return { ok: false, reason: 'LIST_SCHEDULES_BAD_SHAPE' };
    if (result.ok !== true) return { ok: false, reason: 'LIST_SCHEDULES_NOT_OK' };
    if (!Array.isArray(result.schedules)) return { ok: false, reason: 'LIST_SCHEDULES_BAD_SHAPE' };
    if (!isPlainObject(result.pagination)) return { ok: false, reason: 'LIST_SCHEDULES_PAGINATION_MISSING' };
    // 逐行严格校验：坏行 → 前提未知（不丢弃）
    for (const item of result.schedules) {
      const row = verifyListedSchedule(item, projectId);
      if (!row.ok) return { ok: false, reason: `LIST_SCHEDULES_BAD_ROW_${row.reason}` };
      collected.push(item);
    }
    // hasMore 必须是显式布尔
    const hasMore = result.pagination.hasMore;
    if (typeof hasMore !== 'boolean') return { ok: false, reason: 'LIST_SCHEDULES_HASMORE_NOT_BOOLEAN' };
    if (hasMore === false) {
      return { ok: true, schedules: collected, pages: round + 1 };
    }
    const next = result.pagination.nextCursor;
    if (typeof next !== 'string' || !next.trim()) {
      return { ok: false, reason: 'LIST_SCHEDULES_CURSOR_MISSING' };
    }
    if (seenCursors.has(next)) {
      // 游标不推进 → 循环，前提无法确认
      return { ok: false, reason: 'LIST_SCHEDULES_CURSOR_LOOP' };
    }
    seenCursors.add(next);
    cursor = next;
  }
  // 分页未读完：前提无法确认，**不**当作「没有安排」
  return { ok: false, reason: 'LIST_SCHEDULES_PAGES_EXHAUSTED' };
}

/**
 * 校验 listSchedules 的一行（只用公开契约字段）。
 * 任何类型/归属/状态不符都判失败，**不**返回部分结果。
 */
function verifyListedSchedule(item, projectId) {
  if (!isPlainObject(item)) return { ok: false, reason: 'NOT_OBJECT' };
  if (typeof item.id !== 'string' || !/^s_[0-9a-zA-Z]+$/.test(item.id)) return { ok: false, reason: 'BAD_ID' };
  if (item.projectId !== projectId) return { ok: false, reason: 'PROJECT_MISMATCH' };
  // 状态必须与筛选一致（本用例固定筛 active）
  if (item.status !== 'active') return { ok: false, reason: 'STATUS_MISMATCH' };
  if (!Number.isInteger(item.version) || item.version < 1) return { ok: false, reason: 'BAD_VERSION' };
  for (const f of ['stage', 'trade', 'workerUserId', 'startDate', 'endDate', 'content']) {
    if (typeof item[f] !== 'string' || !item[f].trim()) return { ok: false, reason: `BAD_FIELD_${f}` };
  }
  if (!Array.isArray(item.restDays)) return { ok: false, reason: 'BAD_FIELD_restDays' };
  for (const day of item.restDays) {
    if (typeof day !== 'string' || !day.trim()) return { ok: false, reason: 'BAD_FIELD_restDays' };
  }
  return { ok: true };
}

/**
 * 读取同项目当前安排（V06-c）。
 * 返回公开契约的完整 form 与版本；失败即前提不成立。
 */
async function readCurrentSchedule(api, projectId, scheduleId, timers) {
  const got = await withTimeout(
    sendFixed(api, { action: 'getSchedule', projectId, scheduleId }),
    driverProof.uiTimeoutSeconds * 1000, timers
  );
  if (got.timedOut) return { ok: false, reason: 'GET_SCHEDULE_TIMEOUT' };
  if (got.error) return { ok: false, reason: 'GET_SCHEDULE_FAILED' };
  const result = got.value && got.value.result;
  if (!isPlainObject(result) || !isPlainObject(result.schedule)) {
    return { ok: false, reason: 'GET_SCHEDULE_BAD_SHAPE' };
  }
  const s = result.schedule;
  const text = v => typeof v === 'string' && v.trim().length > 0;
  if (result.ok !== true) return { ok: false, reason: 'GET_SCHEDULE_NOT_OK' };
  if (!text(s.id) || s.id !== scheduleId) return { ok: false, reason: 'GET_SCHEDULE_ID_MISMATCH' };
  if (s.projectId !== projectId) return { ok: false, reason: 'GET_SCHEDULE_PROJECT_MISMATCH' };
  if (s.status !== 'active') return { ok: false, reason: 'GET_SCHEDULE_NOT_ACTIVE' };
  if (!Number.isInteger(s.version) || s.version < 1) return { ok: false, reason: 'GET_SCHEDULE_BAD_VERSION' };
  for (const f of ['stage', 'trade', 'workerUserId', 'startDate', 'endDate', 'content']) {
    if (!text(s[f])) return { ok: false, reason: `GET_SCHEDULE_FIELD_${f}` };
  }
  // S4 返修：**不再用 endDate 兜底**。当前安排的 expectedDate 必须真实存在，
  // 缺字段就停止（不能悄悄改写当前安排的语义）。
  if (!text(s.expectedDate)) return { ok: false, reason: 'GET_SCHEDULE_FIELD_expectedDate' };
  // restDays 必须是字符串数组；缺失/含非字符串都停止（不用空数组替代）
  if (!Array.isArray(s.restDays)) return { ok: false, reason: 'GET_SCHEDULE_FIELD_restDays' };
  for (const day of s.restDays) {
    if (typeof day !== 'string' || !day.trim()) return { ok: false, reason: 'GET_SCHEDULE_FIELD_restDays' };
  }
  return {
    ok: true,
    schedule: {
      scheduleId: s.id,
      projectId: s.projectId,
      version: s.version,
      stage: s.stage,
      trade: s.trade,
      workerUserId: s.workerUserId,
      startDate: s.startDate,
      endDate: s.endDate,
      // 原样采用当前值，绝不替换
      expectedDate: s.expectedDate,
      restDays: s.restDays.slice(),
      content: s.content
    }
  };
}

/**
 * 执行编排 ────────────────────────────────────────────────────────────── */

/**
 * 可注入时钟的有限等待。
 * 默认 UI 30 秒；**与云函数 3 秒超时不是同一个概念**，本轮不改云函数配置。
 */
function withTimeout(promise, timeoutMs, timers) {
  const setTimer = (timers && timers.setTimeout) || setTimeout;
  const clearTimer = (timers && timers.clearTimeout) || clearTimeout;
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    Promise.resolve(promise).then(
      value => {
        if (settled) return; // 晚响应：只作证据，不改判定
        settled = true;
        clearTimer(timer);
        resolve({ timedOut: false, value });
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve({ timedOut: false, error });
      }
    );
  });
}

/**
 * 单次发送：把**同步抛错**与 promise 拒绝都变成可记录的结果。
 * 已调用但结果未知 ≠ 未调用。
 */
function attemptSend(sendFn) {
  try {
    const p = sendFn();
    if (p && typeof p.then === 'function') {
      return { invoked: true, promise: p };
    }
    return { invoked: true, promise: Promise.resolve(p) };
  } catch (error) {
    // 同步抛错：**已调用**（可能已到达服务端），但结果未知
    return { invoked: true, synchronousThrow: String(error && error.message) };
  }
}

/**
 * 启动一个用例。
 *
 * 严格顺序（任一步失败即返回，**零业务发送**）：
 * 1. 门控（双开关 + 实际 AppID + 版本 + 目标一致）
 * 2. 本机同步占用（首次 await 之前，带所有权）
 * 3. 本地门槛（配置/存储/普通未决/轮次阻断/窗口/受保护项目/未启动过）
 * 4. 组包（含固定目标与日期确认核对）
 * 5. 持久化一次性启动记录并回读（重算摘要 + 全绑定核对）
 * 6. identify 核实真实 userId
 * 7. getMembers 确认当前仍是该项目管家；V07 另核对目标角色
 * 8. V06-c 真实 getSchedule 取当前 form/版本；V07 读 active 安排前提
 * 9. **重验 gate + 窗口 + 冻结计划**，之后在单一同步段发起请求
 * 10. 逐笔独立处理、独立持久化与判定
 *
 * @param {object} options { api, testCaseId, input, timers, nowMs, priorCaseRecord }
 */
async function runCase(options) {
  const api = options.api;
  const testCaseId = options.testCaseId;
  const spec = driverProof.testCases.find(c => c.testCaseId === testCaseId);
  const timers = options.timers || {};
  const startedAt = options.nowMs || Date.now();
  const report = {
    testCaseId,
    startedAtIso: nowIso(startedAt),
    // 来源标注：不是本地只跑；sent>0 表示运行期确有真实发送
    source: 'runtime-real-wx-cloud',
    localOnly: false,
    verifiedByCloudBaseline: false,
    sent: 0,
    invokedCount: 0,
    requests: [],
    responses: [],
    preflightReads: [],
    verdict: 'stopped',
    stoppedReason: null
  };

  const fail = (code, message, extra) => {
    report.verdict = 'stopped';
    report.stoppedReason = code;
    report.message = message;
    if (extra) Object.assign(report, extra);
    return { ok: false, code, message, report };
  };

  if (!spec) return fail('TEST_DRIVER_UNKNOWN_CASE', '不是固定用例。');

  // 1) 门控
  const g = gate({ api });
  if (!g.ok) return fail('TEST_DRIVER_GATE_BLOCKED', g.reasons.join(' '), { gateReasons: g.reasons });

  const storage = coordinator.resolveStorage(api);
  if (!storage) return fail('TEST_DRIVER_STORAGE_UNAVAILABLE', '本地存储不可用。');
  const ctx = {
    storage,
    envId: driverProof.envId,
    roundId: driverProof.roundId,
    actorUserId: driverProof.actorUserId,
    nowMs: startedAt
  };

  // 2) 本机同步占用（**必须在首次 await 之前**）
  const hold = coordinator.acquireRuntimeHold('preflight', 'test', testCaseId);
  if (!hold.ok) return fail(hold.code, hold.message);
  const releaseHold = () => coordinator.releaseRuntimeHold(hold.token);

  /** 升级占用理由（保持同一 token，不重新竞争）。 */
  const upgradeHold = reason => {
    coordinator.upgradeRuntimeHoldReason(hold.token, reason);
  };

  try {
    // 3) 本地门槛
    const pre = coordinator.preflight(ctx, testCaseId);
    if (!pre.ok) return fail(pre.code, pre.message, { preflightReasons: pre.reasons });

    // 普通未决存在 → 驱动拒绝启动（不放宽普通防重）
    const ordinary = readOrdinaryEnvelope(ctx);
    if (ordinary.blocked) {
      return fail('TEST_DRIVER_ORDINARY_PENDING', ordinary.message);
    }

    const input = Object.assign({}, options.input || {});

    // 4) 固定目标核对（**先于任何请求**）
    const target = verifyFixedTarget(input);
    if (!target.ok) return fail('TEST_DRIVER_TARGET_MISMATCH', target.reasons.join(' '), { targetReasons: target.reasons });
    input.projectId = target.projectId;

    // V06-c：只接受已人工核对的 a 结果（不靠手填 ID 绕过）
    if (testCaseId === 'V06-c') {
      const prior = verifyPriorReviewed(ctx, options.priorCaseRecord);
      if (!prior.ok) return fail('TEST_DRIVER_PRIOR_NOT_REVIEWED', prior.message, { priorReasons: prior.reasons });
      input.scheduleId = prior.scheduleId;
    }

    // 组包（缺字段即失败，不以默认值糊过去）
    // R3 返修：V06-c 的完整 form 与版本来自**真实 getSchedule**，
    // 因此这一轮只校验「已知必需字段」，组包推迟到读取之后。
    let pair;
    if (testCaseId === 'V06-c') {
      const missing = [];
      for (const field of ['projectId', 'actorUserId', 'scheduleId', 'content1', 'content2', 'reason']) {
        const v = input[field];
        if (typeof v !== 'string' || !v.trim()) missing.push(field);
      }
      if (missing.length) {
        return fail('TEST_DRIVER_INPUT_INCOMPLETE', `固定计划字段缺失：${missing.join(', ')}`, { missing });
      }
      if (input.content1 === input.content2) {
        return fail('TEST_DRIVER_CONTENT_NOT_DISTINCT', '本用例要求两份不同内容，未发任何请求。');
      }
      if (!input.requestId1 || !input.requestId2) {
        return fail('TEST_DRIVER_INPUT_INCOMPLETE', '固定计划字段缺失：requestId1, requestId2', { missing: ['requestId1', 'requestId2'] });
      }
      if (input.requestId1 === input.requestId2) {
        return fail('TEST_DRIVER_REQUEST_ID_NOT_DISTINCT', '本用例要求两个不同请求号，未发任何请求。');
      }
    } else if (testCaseId.startsWith('V06-')) {
      pair = buildPair(spec, input);
    } else {
      pair = buildRemoveMember(input);
    }
    if (pair && !pair.ok) {
      if (pair.sameRequestIdRejected) {
        return fail('TEST_DRIVER_REQUEST_ID_NOT_DISTINCT', '本用例要求两个不同请求号，未发任何请求。');
      }
      if (pair.sameContentRejected) {
        return fail('TEST_DRIVER_CONTENT_NOT_DISTINCT', '本用例要求两份不同内容，未发任何请求。');
      }
      if (pair.dateMismatch) {
        // 不自动授予日期确认
        return fail('TEST_DRIVER_DATE_NOT_CONFIRMED', '日期与预计完工日期不一致，本固定计划不自动确认，未发任何请求。', {
          dateMismatch: pair.dateMismatch
        });
      }
      return fail('TEST_DRIVER_INPUT_INCOMPLETE', `固定计划字段缺失：${(pair.missing || []).join(', ')}`, { missing: pair.missing });
    }

    // 5) 持久化一次性启动记录并回读（失败 → 零业务发送）
    //    快照必须覆盖**全部非敏感请求语义字段**
    //    V06-c 的完整计划要等真实 getSchedule 之后才知道，这里先落**占位快照**
    //    以占用本轮一次性标记（读取不是业务写请求）；随后按当前 form 重写并回读。
    const buildSnapshot = requests => ({
      testCaseId,
      plan: requests.map(r => ({
        action: r.action,
        projectId: r.projectId,
        requestId: r.requestId,
        scheduleId: r.scheduleId || null,
        expectedVersion: r.expectedVersion === undefined ? null : r.expectedVersion,
        reason: r.reason || null,
        userId: r.userId || null
      })),
      forms: requests.map(r => (r.form ? clone(r.form) : null))
    });
    const requestsForSnapshot = pair ? pair.requests : [{
      action: spec.pair,
      projectId: target.projectId,
      requestId: input.requestId1 || null,
      scheduleId: input.scheduleId || null,
      expectedVersion: null,
      reason: input.reason || null,
      userId: input.userId || null,
      form: null
    }];
    const snapshot = buildSnapshot(requestsForSnapshot);
    const binding = {
      envId: driverProof.envId,
      roundId: driverProof.roundId,
      projectId: target.projectId,
      actorUserId: driverProof.actorUserId,
      evidenceId: driverProof.evidenceId,
      appId: driverProof.appId,
      functionName: driverProof.functionName,
      v07TargetUserId: testCaseId.startsWith('V07-') ? driverProof.v07TargetUserId : null
    };
    const persisted = coordinator.persistArmedRecord(ctx, {
      testCaseId,
      snapshot,
      binding,
      requestIds: requestsForSnapshot.map(r => r.requestId).filter(Boolean)
    });
    if (!persisted.ok) return fail(persisted.code, persisted.message);
    report.binding = clone(binding);

    /** 状态写入 + 回读都必须成功，否则不得显示 candidate。 */
    const step = (state, patch, code, message) => {
      const r = coordinator.setCaseState(ctx, testCaseId, state, patch || {});
      if (!r.ok) {
        report.stoppedReason = code;
        report.message = message;
        report.verdict = 'stopped';
        return false;
      }
      return true;
    };

    // 6) identify 核实真实身份（**可能写 users/审计**）
    upgradeHold('identifying');
    const identified = await withTimeout(
      attemptSend(() => sendFixed(api, { action: 'identify', requestId: makeTrackingId('id', testCaseId, 0) })).promise,
      driverProof.uiTimeoutSeconds * 1000, timers
    );
    if (identified.timedOut) {
      if (!step('stopped', { stoppedReason: 'IDENTITY_TIMEOUT' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '身份核实超时，状态未能持久化。')) {
        return { ok: false, code: 'TEST_DRIVER_STOPPED', message: report.message, report };
      }
      return fail('TEST_DRIVER_TIMEOUT', '身份核实超时，未发业务请求。');
    }
    if (identified.error) {
      step('stopped', { stoppedReason: 'IDENTITY_ERROR' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '身份核实失败，状态未能持久化。');
      return fail('TEST_DRIVER_IDENTITY_FAILED', '身份核实请求失败，未发业务请求。');
    }
    const idResult = identified.value && identified.value.result;
    if (!idResult || idResult.ok !== true || typeof idResult.userId !== 'string' || !idResult.userId) {
      step('stopped', { stoppedReason: 'IDENTITY_UNVERIFIED' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '身份未核实，状态未能持久化。');
      return fail('TEST_DRIVER_IDENTITY_FAILED', '服务端未返回可信账号，未发业务请求。');
    }
    if (idResult.userId !== driverProof.actorUserId) {
      step('stopped', { stoppedReason: 'ACCOUNT_MISMATCH' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '账号不一致，状态未能持久化。');
      return fail('TEST_DRIVER_ACCOUNT_MISMATCH', '当前微信账号与配置执行人不一致，未发业务请求。');
    }

    // 7) getMembers 确认当前仍是该项目管家（公开字段）
    upgradeHold('membersCheck');
    const members = await withTimeout(
      attemptSend(() => sendFixed(api, { action: 'getMembers', projectId: target.projectId })).promise,
      driverProof.uiTimeoutSeconds * 1000, timers
    );
    if (members.timedOut) {
      step('stopped', { stoppedReason: 'MEMBERS_TIMEOUT' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '成员核对超时，状态未能持久化。');
      return fail('TEST_DRIVER_TIMEOUT', '成员核对超时，未发业务请求。');
    }
    if (members.error) {
      step('stopped', { stoppedReason: 'MEMBERS_ERROR' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '成员核对失败，状态未能持久化。');
      return fail('TEST_DRIVER_MEMBERS_FAILED', '成员核对请求失败，未发业务请求。');
    }
    const mResult = members.value && members.value.result;
    if (!mResult || mResult.ok !== true || !Array.isArray(mResult.members)) {
      step('stopped', { stoppedReason: 'MEMBERS_BAD_SHAPE' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '成员结果不可用，状态未能持久化。');
      return fail('TEST_DRIVER_MEMBERS_FAILED', '成员核对未返回可用结果，未发业务请求。');
    }
    const self = mResult.members.find(x => isPlainObject(x) && x.userId === driverProof.actorUserId);
    if (!self || !Array.isArray(self.roles) || !self.roles.includes('管家')) {
      step('stopped', { stoppedReason: 'NOT_MANAGER' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '非管家，状态未能持久化。');
      return fail('TEST_DRIVER_NOT_MANAGER', '当前账号不是该项目管家，未发业务请求。');
    }

    // 7b) V07 目标核对与安排前提（**在事务外公开查询**）
    let v07Target = '';
    if (testCaseId === 'V07-A' || testCaseId === 'V07-B') {
      const vt = verifyV07Target(input, mResult);
      if (!vt.ok) {
        step('stopped', { stoppedReason: 'V07_TARGET_INVALID' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', 'V07 目标未通过核对，状态未能持久化。');
        return fail('TEST_DRIVER_V07_TARGET_INVALID', vt.reasons.join(' '), { v07Reasons: vt.reasons });
      }
      v07Target = vt.targetUserId;
      input.userId = v07Target;
      // 前提：完整分页确认目标在该项目是否有 active 安排
      upgradeHold('probing');
      const probe = await readAllActiveSchedules(api, target.projectId, timers);
      report.preflightReads.push({ action: 'listSchedules', ok: probe.ok, reason: probe.reason || null, pages: probe.pages || 0 });
      if (!probe.ok) {
        step('stopped', { stoppedReason: 'V07_PROBE_UNCONFIRMED' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '前提查询失败，状态未能持久化。');
        return fail('TEST_DRIVER_V07_PRECONDITION_UNKNOWN', `无法确认 V07 前提（${probe.reason}），未发移出请求。`);
      }
      const hasActive = probe.schedules.some(s => s.workerUserId === v07Target);
      if (testCaseId === 'V07-A' && !hasActive) {
        step('stopped', { stoppedReason: 'V07A_NO_ACTIVE' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '前提不成立，状态未能持久化。');
        return fail('TEST_DRIVER_V07_PRECONDITION_MISSING', 'V07-A 需要目标存在 active 安排；公开查询未确认到，未发移出请求。');
      }
      if (testCaseId === 'V07-B' && hasActive) {
        step('stopped', { stoppedReason: 'V07B_HAS_ACTIVE' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '前提不成立，状态未能持久化。');
        return fail('TEST_DRIVER_V07_PRECONDITION_MISSING', 'V07-B 需要目标已无 active 安排；公开查询仍查到，未发移出请求。');
      }
    }

    // 7c) V06-c：真实 getSchedule 取当前 form/版本（读取纳入互斥与超时）
    if (testCaseId === 'V06-c') {
      upgradeHold('probing');
      const cur = await readCurrentSchedule(api, target.projectId, input.scheduleId, timers);
      report.preflightReads.push({ action: 'getSchedule', ok: cur.ok, reason: cur.reason || null });
      if (!cur.ok) {
        step('stopped', { stoppedReason: 'CURRENT_SCHEDULE_UNAVAILABLE' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '当前安排不可读，状态未能持久化。');
        return fail('TEST_DRIVER_CURRENT_SCHEDULE_UNKNOWN', `无法读取当前安排（${cur.reason}），未发业务请求。`);
      }
      // 用**当前** form 重建两份仅内容不同的请求（不用旧结果代替）
      input.stage = cur.schedule.stage;
      input.trade = cur.schedule.trade;
      input.workerUserId = cur.schedule.workerUserId;
      input.startDate = cur.schedule.startDate;
      input.endDate = cur.schedule.endDate;
      input.restDays = cur.schedule.restDays;
      // S4 返修：原样采用**当前** expectedDate，不覆盖
      input.expectedDate = cur.schedule.expectedDate;
      input.expectedVersion = cur.schedule.version;
      // S4 返修：本固定测试计划收窄为「日期相等」。
      // 当前安排的 expectedDate ≠ endDate 时**明确停止**，零 update；
      // 既不修改业务安排来让测试通过，也不自动补日期确认。
      if (cur.schedule.expectedDate !== cur.schedule.endDate) {
        step('stopped', { stoppedReason: 'CURRENT_DATES_NOT_EQUAL' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '当前安排日期不一致，状态未能持久化。');
        return fail(
          'TEST_DRIVER_CURRENT_DATES_NOT_EQUAL',
          `当前安排的预计日期（${cur.schedule.expectedDate}）与完工日期（${cur.schedule.endDate}）不一致；本固定计划不覆盖该语义，未发任何更新请求。`,
          { currentDates: { expectedDate: cur.schedule.expectedDate, endDate: cur.schedule.endDate } }
        );
      }
      pair = buildPair(spec, input);
      if (!pair.ok) {
        step('stopped', { stoppedReason: 'CURRENT_FORM_UNUSABLE' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '当前 form 不可用，状态未能持久化。');
        return fail('TEST_DRIVER_INPUT_INCOMPLETE', `当前安排字段不满足固定计划：${(pair.missing || []).join(', ')}`);
      }
      // 快照与绑定必须按**更新后**的计划重写并回读
      const reSnapshot = buildSnapshot(pair.requests);
      const rePersisted = coordinator.persistArmedRecord(ctx, {
        testCaseId,
        snapshot: reSnapshot,
        binding,
        requestIds: pair.requests.map(r => r.requestId)
      });
      if (!rePersisted.ok) {
        return fail(rePersisted.code, rePersisted.message);
      }
    }

    report.requests = pair
      ? pair.requests.map(r => ({ action: r.action, requestId: r.requestId }))
      : report.requests;

    // 8) **重验门控 / 窗口 / 冻结计划**（前置耗时不得穿越截止后发送）
    const g2 = gate({ api });
    if (!g2.ok) {
      step('stopped', { stoppedReason: 'GATE_CHANGED_BEFORE_SEND' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '门控变化，状态未能持久化。');
      return fail('TEST_DRIVER_GATE_BLOCKED', `发送前门控复核失败：${g2.reasons.join(' ')}`, { gateReasons: g2.reasons });
    }
    const deadline = Date.parse(driverProof.expiresAt);
    if (!Number.isFinite(deadline) || Date.now() > deadline) {
      step('stopped', { stoppedReason: 'EXPIRED_BEFORE_SEND' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '窗口过期，状态未能持久化。');
      return fail('TEST_DRIVER_EXPIRED', '身份与成员预检期间窗口已过期，未发业务请求。');
    }
    // 冻结计划：快照必须仍与当前组包一致（与持久化时**同一结构**）
    const frozen = coordinator.snapshotDigest(buildSnapshot(pair.requests));
    const storedRec = coordinator.readCase(ctx, testCaseId);
    if (storedRec.status !== 'ok' || storedRec.record.snapshotDigest !== frozen) {
      step('stopped', { stoppedReason: 'SNAPSHOT_DRIFT' }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '快照漂移，状态未能持久化。');
      return fail('TEST_DRIVER_SNAPSHOT_DRIFT', '持久化快照与当前计划不一致，已停止。');
    }

    // 9) armed → 发起（在**单一同步段**内连续调用，不先 await 第一笔）
    step('armed', {}, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '无法记录 armed 状态。');
    const stateAfterArm = coordinator.readCase(ctx, testCaseId);
    if (stateAfterArm.status !== 'ok' || stateAfterArm.record.state !== 'armed') {
      return fail('TEST_DRIVER_STORAGE_UNAVAILABLE', 'armed 状态未能持久化回读，未发业务请求。');
    }
    upgradeHold('inFlight');
    if (!step('inFlight', { sentAt: Date.now() }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '无法记录 inFlight 状态。')) {
      return { ok: false, code: 'TEST_DRIVER_STOPPED', message: report.message, report };
    }

    const timeoutMs = driverProof.uiTimeoutSeconds * 1000;
    // **独立**处理每次调用：同步抛错也记为「已调用、结果未知」
    const attempts = pair.requests.map(req => attemptSend(() => sendFixed(api, {
      action: req.action,
      projectId: req.projectId,
      requestId: req.requestId,
      ...(req.form ? { form: req.form } : {}),
      ...(req.scheduleId ? { scheduleId: req.scheduleId } : {}),
      ...(req.expectedVersion !== undefined ? { expectedVersion: req.expectedVersion } : {}),
      ...(req.reason ? { reason: req.reason } : {}),
      ...(req.userId ? { userId: req.userId } : {})
    })));
    report.sent = attempts.length;
    report.invokedCount = attempts.filter(a => a.invoked).length;
    step('inFlight', { sentCount: attempts.length }, 'TEST_DRIVER_STORAGE_UNAVAILABLE', '无法记录发出计数。');

    // S3 返修：两笔在**同一同步段**内启动后，**立即为每一笔**装上
    // 完成/拒绝处理器与超时计时器，并各自在完成时立刻把证据写入自己的槽位。
    // 旧实现用 `for (let i…) await`，导致：
    //  - 第二笔即使已返回，也要等第一笔结束才被保存；
    //  - 第二笔的超时计时从「循环轮到它」才开始；
    //  - 第二笔先拒绝时那一段还没有 rejection handler。
    // 现在改为：先全部启动并挂监听，再等待「全部有结果或全部超时」。
    const slots = attempts.map((a, i) => ({
      index: i,
      requestId: pair.requests[i].requestId,
      // 同步抛错：已调用、结果未知，立即落槽
      row: a.synchronousThrow
        ? {
          // 稳定槽位编号：主响应与晚到证据都用它关联，
          // **不用 requestId 或时间戳代替**（同 requestId 的两笔必须可区分）
          slotIndex: i,
          requestId: pair.requests[i].requestId,
          outcome: 'sync-throw',
          invoked: true,
          resultUnknown: true,
          sentAtIso: nowIso(Date.now()),
          arrivedAtIso: nowIso(Date.now())
        }
        : null,
      settled: Boolean(a.synchronousThrow),
      // 该笔的超时起点 = 实际发送时刻（不是循环轮到它的时刻）
      startedAtMs: Date.now()
    }));

    const setTimer = (timers && timers.setTimeout) || setTimeout;
    const clearTimer = (timers && timers.clearTimeout) || clearTimeout;
    const persistFailure = { hit: false };

    // 先备好「全部落槽」的信号，再挂监听（避免回调里引用未初始化的绑定）
    let resolveDone = null;
    const allDone = new Promise(resolve => { resolveDone = resolve; });
    const notify = () => {
      if (resolveDone && slots.every(s => s.settled)) resolveDone();
    };

    /**
     * 把已落槽的证据独立持久化一次（**先到先留证**，不等其它笔）。
     *
     * S3-b 返修（读失败不得回写）：
     * - 状态**只能来自本次实际读到的记录**；读不到（含 error/none）时
     *   **立即放弃本次补存**，绝不默认 inFlight 或任何状态；
     * - 放弃时只记内存失败标记，已有存储保持原样；
     * - 不取消、不补发、不改判、不解锁。
     *
     * @param {string} [stateOverride] 调用方**已确认**的状态；
     *          仅发送阶段（状态本就是 inFlight）显式传入。
     * @returns {boolean} 本次是否真的写入成功
     */
    const persistSlot = stateOverride => {
      // S3-b 关键：**不得回写状态**。发送阶段的状态本就是 inFlight；
      // 晚到补存时用例可能已经落到 stopped/candidate，因此必须沿用
      // 当前已持久化的状态，否则会把 stopped 改回 inFlight。
      let state = stateOverride;
      if (!state) {
        const current = coordinator.readCase(ctx, testCaseId);
        if (current.status !== 'ok' || !current.record || !current.record.state) {
          // 无法确认当前记录与状态 → 停止本次补存，不写回、不默认状态
          persistFailure.hit = true;
          persistFailure.reason = persistFailure.reason
            || `无法确认当前持久状态（readCase=${current.status}${current.reason ? '：' + current.reason : ''}），已放弃本次补存，未写入任何内容。`;
          return false;
        }
        state = current.record.state;
      }
      const patch = {
        responses: slots.filter(s => s.row).map(s => s.row),
        lastArrivedAt: Date.now()
      };
      // S3-b：晚到证据与主 responses 并存写入（state 不变、判定不变）
      const late = [];
      for (const slot of slots) {
        if (Array.isArray(slot.lateArrivals)) late.push(...slot.lateArrivals);
      }
      if (late.length) patch.lateArrivals = late;
      const partial = coordinator.setCaseState(ctx, testCaseId, state, patch);
      if (!partial.ok) {
        persistFailure.hit = true;
        persistFailure.reason = persistFailure.reason || (partial.message || '状态写入失败');
      }
      return partial.ok;
    };

    /**
     * 把某一笔的完成结果落槽并**立即**留证。
     *
     * @returns {boolean} 本次调用是否真的让该槽位完成（重复调用返回 false）
     */
    const settleSlot = (slot, row) => {
      if (slot.settled) return false;
      slot.settled = true;
      slot.row = Object.assign(
        // slotIndex 在最前：主响应与晚到证据的第一关联键
        { slotIndex: slot.index, sentAtIso: nowIso(slot.startedAtMs) },
        row,
        { arrivedAtIso: nowIso(Date.now()) }
      );
      // 关键：落槽即持久化，不等另一笔
      // 状态仍从存储读（发送阶段读到的是 inFlight），**不**由这里强制指定
      persistSlot();
      return true;
    };

    // 为每一笔立即挂上处理器 + 计时器（超时起点 = 该笔实际发出的时刻）
    attempts.forEach((a, i) => {
      const slot = slots[i];
      if (a.synchronousThrow) return; // 同步抛错在下面统一落槽
      let timer = null;
      let done = false;
      /**
       * S3-b 返修：超时之后的**晚到**成功/拒绝不再直接丢弃。
       *
       * 规则（不得放宽）：
       * - 只**补存经过现有净化规则**的槽位证据（成功仍走 sanitizeResult）；
       * - **保留原 timeout/unknown 判定**：不改写 slot.row、不改候选结论；
       * - **不回写** inFlight/candidate、**不补发、不解锁**下一例；
       * - 晚到证据记在独立的 lateArrivals 里，与主 responses 并存；
       * - 补存失败仍按保守停止处理（persistFailure）。
       * - 相同 requestId 的两笔按**各自槽位**区分，不按 requestId 归并。
       */
      const recordLateArrival = row => {
        slot.lateArrivals = Array.isArray(slot.lateArrivals) ? slot.lateArrivals : [];
        slot.lateArrivals.push(Object.assign(
          // slotIndex 同样是第一关联键：同 requestId 的两笔靠它区分
          { slotIndex: slot.index, sentAtIso: nowIso(slot.startedAtMs), late: true },
          row,
          { arrivedAtIso: nowIso(Date.now()) }
        ));
        // 补存走同一套持久化；state 仍取自当前持久记录，绝不升级判定
        persistSlot();
      };
      const finish = row => {
        if (done) {
          // 晚到：只补留证，不改判、不改槽位主结论
          recordLateArrival(row);
          return;
        }
        done = true;
        if (timer) clearTimer(timer);
        settleSlot(slot, row);
        notify();
      };
      timer = setTimer(() => {
        finish({ requestId: slot.requestId, outcome: 'timeout', invoked: true, resultUnknown: true });
      }, timeoutMs);
      Promise.resolve(a.promise).then(
        value => finish({
          requestId: slot.requestId,
          outcome: 'responded',
          invoked: true,
          resultUnknown: false,
          result: sanitizeResult(value && value.result)
        }),
        () => finish({
          requestId: slot.requestId,
          outcome: 'network-error',
          invoked: true,
          resultUnknown: true
        })
      );
    });

    /**
     * S3-a 返修：同步抛错的槽位在创建时已 settled，监听循环会跳过它们。
     * 此前这里只 `persistSlot()` 而**不触发完成检查** —— 若全部槽位都是同步抛错，
     * 就没有任何异步 finish() 会调用 notify()，`await allDone` 永远不结束，
     * 运行时占用也无法按 finally 释放。
     * 现在统一走 settleSlot → persistSlot → notify 的顺序。
     */
    for (const slot of slots) {
      if (slot.settled) {
        // settleSlot 对已 settled 的槽位是幂等的 no-op，这里只补齐完成检查
        persistSlot();
      }
    }
    // 兜底：所有槽位若已全部落槽（含全同步抛错），立即唤醒等待者
    notify();

    // 等待全部落槽（每笔各自计时，先到先留证）
    await allDone;
    // 收尾再落一次，确保最后一批证据已持久化
    persistSlot();

    // 晚到证据：与主 responses 并存保存（若有）
    const lateArrivals = [];
    for (const slot of slots) {
      if (Array.isArray(slot.lateArrivals)) lateArrivals.push(...slot.lateArrivals);
    }

    const responses = slots.filter(s => s.row).map(s => s.row);
    report.responses = responses;
    if (lateArrivals.length) report.lateArrivals = lateArrivals;
    report.localOnly = false; // 已确有真实发送，不得再声称 localOnly

    if (persistFailure.hit) {
      report.persistFailure = persistFailure.reason || '响应证据未能完整持久化。';
      step('stopped', { stoppedReason: 'TEST_DRIVER_STORAGE_UNAVAILABLE', responses, finishedAt: Date.now() },
        'TEST_DRIVER_STORAGE_UNAVAILABLE', '停止状态未能持久化。');
      report.verdict = 'stopped';
      report.stoppedReason = 'TEST_DRIVER_STORAGE_UNAVAILABLE';
      report.message = '响应证据未能完整持久化，已保守停止；不显示候选、不解锁、不补发。';
      return { ok: false, code: 'TEST_DRIVER_STOPPED', message: report.message, report };
    }

    // 10) 判定
    const anyUnknown = responses.some(r => r.outcome !== 'responded');
    if (anyUnknown) {
      step('stopped', { stoppedReason: 'UNKNOWN_RESULT', responses, finishedAt: Date.now() },
        'TEST_DRIVER_STORAGE_UNAVAILABLE', '停止状态未能持久化。');
      report.verdict = 'stopped';
      report.stoppedReason = 'UNKNOWN_RESULT';
      report.message = '存在同步异常、超时或网络失败，已停止并保留证据；不重发、不恢复、不清锁。';
      return { ok: false, code: 'TEST_DRIVER_STOPPED', message: report.message, report };
    }

    // 固定期望（供严格形状核验使用）
    const judgeSpec = Object.assign({}, spec, {
      expect: Object.assign({}, spec.expect, {
        projectId: target.projectId,
        workerUserId: input.workerUserId,
        scheduleId: testCaseId === 'V06-c' ? input.scheduleId : undefined,
        version: testCaseId === 'V06-c' ? input.expectedVersion + 1 : undefined
      })
    });

    let judged;
    if (testCaseId.startsWith('V06-')) {
      judged = judgeV06(judgeSpec, responses[0].result, responses[1].result);
    } else if (testCaseId === 'V07-A') {
      judged = judgeV07A(responses[0].result);
    } else {
      judged = judgeV07B(responses[0].result, v07Target);
    }

    if (judged.verdict !== 'candidate') {
      step('stopped', { stoppedReason: judged.stoppedReason, responses, finishedAt: Date.now() },
        'TEST_DRIVER_STORAGE_UNAVAILABLE', '停止状态未能持久化。');
      report.verdict = 'stopped';
      report.stoppedReason = judged.stoppedReason;
      report.message = '结果组合不在允许清单内，已停止。';
      return { ok: false, code: 'TEST_DRIVER_STOPPED', message: report.message, report };
    }

    // candidate 也必须写入并回读成功才显示
    const done = step('candidate', { responses, finishedAt: Date.now() },
      'TEST_DRIVER_STORAGE_UNAVAILABLE', '候选状态未能持久化。');
    if (!done) {
      report.verdict = 'stopped';
      report.stoppedReason = 'TEST_DRIVER_STORAGE_UNAVAILABLE';
      return { ok: false, code: 'TEST_DRIVER_STOPPED', message: report.message, report };
    }
    report.verdict = 'candidate';
    report.message = '客户端结果符合候选判定；仍需管理端事后核对，驱动不会自动进入下一例。';
    report.verifiedByCloudBaseline = false;
    return { ok: true, code: 'TEST_DRIVER_CANDIDATE', message: report.message, report };
  } finally {
    releaseHold();
  }
}

/**
 * V06-c 的前提：V06-a 必须已 **reviewed**（人工接续完成）。
 * 仅有 candidate 不够 —— candidate 需先完成允许的人工接续。
 */
function verifyPriorReviewed(ctx, provided) {
  const reasons = [];
  let rec = null;
  if (isPlainObject(provided) && provided.record) {
    rec = provided.record;
  } else {
    const got = coordinator.readCase(ctx, 'V06-a');
    if (got.status === 'error') return { ok: false, reasons: [got.reason], message: got.reason };
    rec = got.status === 'ok' ? got.record : null;
  }
  if (!rec) return { ok: false, reasons: ['本机没有 V06-a 的持久记录。'], message: '本机没有 V06-a 的持久记录，未发任何请求。' };
  if (rec.state !== 'reviewed') {
    return {
      ok: false,
      reasons: [`V06-a 当前状态 ${rec.state}，需先完成管理端人工接续（reviewed）才能构造版本冲突用例。`],
      message: 'V06-a 尚未完成人工接续，不能构造版本冲突用例；未发任何请求。'
    };
  }
  if (!rec.reviewRecordId || typeof rec.reviewRecordId !== 'string' || !rec.reviewRecordId.trim()) {
    reasons.push('V06-a 的人工接续记录 ID 缺失。');
  }
  const responses = Array.isArray(rec.responses) ? rec.responses : [];
  const okResp = responses.find(r => r && r.outcome === 'responded' && r.result && r.result.ok === true);
  if (!okResp || !okResp.result.id || !Number.isInteger(okResp.result.version)) {
    reasons.push('V06-a 的持久结果缺少有效安排 ID 或版本。');
  }
  if (reasons.length) return { ok: false, reasons, message: reasons.join(' ') };
  return { ok: true, scheduleId: okResp.result.id, version: okResp.result.version };
}

/**
 * 只读检查普通未决记录（驱动启动前）。
 * **只读不删**：普通 envelope 存在或损坏都阻止驱动启动。
 */
function readOrdinaryEnvelope(ctx) {
  const envId = sandboxProof.envId;
  const roundId = sandboxProof.roundId || driverProof.roundId;
  const prefix = sandboxProof.cachePrefix;
  const storage = ctx.storage;
  if (typeof storage.getStorageSync !== 'function') {
    return { blocked: true, message: '本地存储不可用。' };
  }
  // 旧格式两键残留
  for (const key of [`${prefix}pending:${envId}:${roundId}`, `${prefix}snapshot:${envId}:${roundId}`]) {
    let raw = '';
    try {
      raw = storage.getStorageSync(key);
    } catch (error) {
      return { blocked: true, message: '读取普通未决记录失败。' };
    }
    if (raw !== '' && raw !== null && raw !== undefined) {
      return { blocked: true, message: '存在旧格式普通未决记录，驱动不启动；请先按普通流程处理。' };
    }
  }
  // 当前格式：按可信账号键 + unbound 键都看一眼
  for (const suffix of [ctx.actorUserId, 'unbound']) {
    const key = `${prefix}envelope:${envId}:${roundId}:${suffix}`;
    let raw = '';
    try {
      raw = storage.getStorageSync(key);
    } catch (error) {
      return { blocked: true, message: '读取普通未决记录失败。' };
    }
    if (raw !== '' && raw !== null && raw !== undefined) {
      return { blocked: true, message: '存在普通未决记录，驱动不启动；普通防重不放宽。' };
    }
  }
  return { blocked: false };
}

module.exports = Object.freeze({
  ALLOWED_ERROR_CODES,
  GENERIC_MESSAGE,
  PROTECTED_ROLES,
  PUBLIC_SCHEDULE_FIELDS,
  PUBLIC_FIELD_TYPES,
  matchesFieldType,
  sanitizeCode,
  sanitizeResult,
  verifyScheduleSuccess,
  verifyRemovedSuccess,
  verifyListedSchedule,
  verifyFixedTarget,
  verifyV07Target,
  gate,
  sendFixed,
  buildPair,
  buildRemoveMember,
  judgeV06,
  judgeV07A,
  judgeV07B,
  readAllActiveSchedules,
  readCurrentSchedule,
  verifyPriorReviewed,
  withTimeout,
  attemptSend,
  runCase,
  readOrdinaryEnvelope,
  makeTrackingId,
  nowIso
});