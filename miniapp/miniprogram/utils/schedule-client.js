// 施工安排客户端封装：仅向已启用的目标环境发起云调用，失败不回落本机保存。

const proof = require('../config/schedule-entry-proof');
const { checkEnvGate } = require('./env-gate');

const LIST_FILTERS = ['status', 'trade', 'date', 'cursor', 'limit'];
const REVISION_FILTERS = ['cursor', 'limit'];

function uid() {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function checkEntry(projectId, testProof) {
  const cfg = testProof || proof;
  const env = checkEnvGate(cfg.envId);
  if (!env.allowed) return { allowed: false, reason: env.reason };
  if (!cfg.enabled) return { allowed: false, reason: '施工安排入口未启用。' };
  if (!Array.isArray(cfg.allowedProjectIds) || !cfg.allowedProjectIds.includes(projectId)) {
    return { allowed: false, reason: '该项目不在施工安排试点列表中。' };
  }
  return { allowed: true };
}

function pickFilters(filters, allowed) {
  const result = {};
  if (filters && typeof filters === 'object') {
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(filters, key)) result[key] = filters[key];
    }
  }
  return result;
}

// 已知的本地入口/校验错误码（由本模块或 env-gate 显式抛出）
const LOCAL_ENTRY_CODES = ['ENTRY_DISABLED', 'ENV_DENIED', 'IDENTITY_UNAVAILABLE'];
const LOCAL_VALIDATION_CODES = ['BAD_INPUT'];

// callFunction 传输层已知网络/超时/连接类错误码或消息
const NETWORK_CODES = ['TIMEOUT', 'NETWORK', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_INTERNET_DISCONNECTED', 'REQUEST_FAIL', 'FAIL'];
const NETWORK_MESSAGE_RE = /超时|网络|timeout|network|abort|disconnected|offline|请求.*失败|request.*fail|connection/i;

// 服务端明确业务拒绝码：这些是「可纠正」错误，页面可修改后重新提交。
// 新增事务兼容相关码：容量超限、目录结构异常、项目未就绪/维护、并发过期、占用不一致、操作预算超限。
const RECOVERABLE_BUSINESS_CODES = [
  'BAD_INPUT', 'WORKER_INVALID', 'SCHEDULE_CONFLICT', 'EXPECTED_DATE_MISMATCH',
  'SCHEDULE_NO_WORKING_DAY', 'SCHEDULE_RANGE_TOO_LONG', 'REQUEST_ID_REUSED_DIFFERENT_PAYLOAD',
  'WORKER_HAS_ACTIVE_SCHEDULES', 'VERSION_MISMATCH',
  'TASK_DIR_CAPACITY_EXCEEDED', 'TASK_DIR_INCONSISTENT', 'PROJECT_NOT_WRITABLE',
  'STALE_SCAN', 'OCCUPANCY_INCONSISTENT', 'SCHEDULE_OPERATION_BUDGET_EXCEEDED'
];
// 不可恢复的服务端拒绝：重试无意义，须由用户/管理员处理
const BLOCKING_BUSINESS_CODES = ['NO_ACCESS', 'IDENTITY_DISABLED', 'TASK_DIR_NOT_READY', 'SERVER_ERROR', 'TRANSACTION_UNAVAILABLE'];

function classifyBusinessCode(code) {
  if (RECOVERABLE_BUSINESS_CODES.includes(code)) return 'business';
  if (BLOCKING_BUSINESS_CODES.includes(code)) return 'entry';
  // 未列举的业务码保守视为 blocking：不得让未知失败被当成可纠正错误而放开编辑
  return 'entry';
}

function classifyError(error) {
  // 已经被显式标记 kind 的错误（本地入口、本地校验、服务端响应处理后的错误）直接保留
  if (error && typeof error.kind === 'string') {
    return { kind: error.kind, code: error.code || error.kind.toUpperCase(), message: error.message || '' };
  }
  if (!error) {
    return { kind: 'unknown', code: 'UNKNOWN', message: '提交结果未知，请核对后重试。' };
  }
  const code = error.code;
  const msg = String(error.message || '');

  // 本地入口拒绝
  if (code === 'ENTRY_DISABLED' || (typeof code === 'string' && LOCAL_ENTRY_CODES.includes(code))) {
    return { kind: 'entry', code, message: msg };
  }
  // 本地字段校验拒绝
  if (typeof code === 'string' && LOCAL_VALIDATION_CODES.includes(code)) {
    return { kind: 'validation', code, message: msg };
  }
  // callFunction 传输层错误：带已知网络码或网络相关消息，均视为结果未知
  if (typeof code === 'string' && NETWORK_CODES.includes(code)) {
    return { kind: 'unknown', code, message: msg || '网络异常，提交结果未知。' };
  }
  if (NETWORK_MESSAGE_RE.test(msg)) {
    return { kind: 'unknown', code: 'NETWORK', message: msg || '网络异常，提交结果未知。' };
  }
  // 其他未识别异常：保守视为结果未知，不推断服务端未提交
  return { kind: 'unknown', code: 'UNKNOWN', message: msg || '提交结果未知，请核对后重试。' };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]';
}

function validateSuccessResponse(action, res) {
  // 写成功响应必须包含协议要求的字段
  if (['createSchedule', 'updateSchedule', 'reassignSchedule', 'cancelSchedule'].includes(action)) {
    if (typeof res.scheduleId !== 'string' || typeof res.version !== 'number' || typeof res.status !== 'string') {
      return false;
    }
  }
  if (action === 'getSchedule') {
    if (!isPlainObject(res.schedule)) return false;
  }
  if (action === 'listSchedules') {
    if (!Array.isArray(res.schedules) || !isPlainObject(res.pagination)) return false;
  }
  if (action === 'listScheduleRevisions') {
    if (!Array.isArray(res.revisions) || !isPlainObject(res.pagination)) return false;
  }
  if (action === 'getScheduleContext') {
    if (!isPlainObject(res.project) || typeof res.isManager !== 'boolean' || !Array.isArray(res.trades) || !Array.isArray(res.workers)) {
      return false;
    }
  }
  return true;
}

async function call(action, projectId, body) {
  let result;
  try {
    result = await wx.cloud.callFunction({
      name: 'memberAccess',
      data: { action, projectId, ...body }
    });
  } catch (error) {
    const classified = classifyError(error);
    const e = new Error(classified.message);
    e.code = classified.code;
    e.kind = classified.kind;
    throw e;
  }
  // 校验 callFunction 响应结构
  if (!isPlainObject(result) || !isPlainObject(result.result)) {
    const e = new Error('提交结果未知，请核对后重试。');
    e.code = 'RESPONSE_UNKNOWN';
    e.kind = 'unknown';
    throw e;
  }
  const res = result.result;
  // ok 必须严格为布尔 true；非布尔成功标记拒绝作为成功
  if (res.ok !== true) {
    // 明确业务拒绝必须包含符合协议的业务码；缺项/畸形不伪装成业务失败
    if (res.ok === false && isPlainObject(res) && typeof res.code === 'string' && res.code.length > 0) {
      const error = new Error(typeof res.message === 'string' ? res.message : '操作失败');
      error.code = res.code;
      // 按业务码分类：可纠正 -> business（页面允许修改后重提）；其余 -> entry（阻塞）
      error.kind = classifyBusinessCode(res.code);
      throw error;
    }
    const e = new Error('提交结果未知，请核对后重试。');
    e.code = 'RESPONSE_UNKNOWN';
    e.kind = 'unknown';
    throw e;
  }
  if (!validateSuccessResponse(action, res)) {
    const e = new Error('提交结果未知，请核对后重试。');
    e.code = 'RESPONSE_MALFORMED';
    e.kind = 'unknown';
    throw e;
  }
  return res;
}

function listSchedules(projectId, filters = {}, testProof) {
  const entry = checkEntry(projectId, testProof);
  if (!entry.allowed) throw entryError(entry.reason);
  return call('listSchedules', projectId, pickFilters(filters, LIST_FILTERS));
}

function getSchedule(projectId, scheduleId, testProof) {
  const entry = checkEntry(projectId, testProof);
  if (!entry.allowed) throw entryError(entry.reason);
  return call('getSchedule', projectId, { scheduleId });
}

function listScheduleRevisions(projectId, scheduleId, filters = {}, testProof) {
  const entry = checkEntry(projectId, testProof);
  if (!entry.allowed) throw entryError(entry.reason);
  return call('listScheduleRevisions', projectId, { scheduleId, ...pickFilters(filters, REVISION_FILTERS) });
}

function getScheduleContext(projectId, testProof) {
  const entry = checkEntry(projectId, testProof);
  if (!entry.allowed) throw entryError(entry.reason);
  return call('getScheduleContext', projectId, {});
}

function createSchedule(projectId, form, options = {}, testProof) {
  const entry = checkEntry(projectId, testProof);
  if (!entry.allowed) throw entryError(entry.reason);
  const requestId = options.requestId || uid();
  return call('createSchedule', projectId, { requestId, form, expectedConfirmed: options.expectedConfirmed });
}

function updateSchedule(projectId, scheduleId, expectedVersion, form, reason, options = {}, testProof) {
  const entry = checkEntry(projectId, testProof);
  if (!entry.allowed) throw entryError(entry.reason);
  const requestId = options.requestId || uid();
  return call('updateSchedule', projectId, { scheduleId, expectedVersion, requestId, form, reason, expectedConfirmed: options.expectedConfirmed });
}

function reassignSchedule(projectId, scheduleId, expectedVersion, workerUserId, reason, options = {}, testProof) {
  const entry = checkEntry(projectId, testProof);
  if (!entry.allowed) throw entryError(entry.reason);
  const requestId = options.requestId || uid();
  return call('reassignSchedule', projectId, { scheduleId, expectedVersion, requestId, workerUserId, reason });
}

function cancelSchedule(projectId, scheduleId, expectedVersion, reason, options = {}, testProof) {
  const entry = checkEntry(projectId, testProof);
  if (!entry.allowed) throw entryError(entry.reason);
  const requestId = options.requestId || uid();
  return call('cancelSchedule', projectId, { scheduleId, expectedVersion, requestId, reason });
}

function entryError(reason) {
  const error = new Error(reason);
  error.code = 'ENTRY_DISABLED';
  error.kind = 'entry';
  return error;
}

module.exports = {
  checkEntry,
  listSchedules,
  getSchedule,
  listScheduleRevisions,
  getScheduleContext,
  createSchedule,
  updateSchedule,
  reassignSchedule,
  cancelSchedule,
  uid,
  classifyError,
  classifyBusinessCode,
  RECOVERABLE_BUSINESS_CODES,
  BLOCKING_BUSINESS_CODES
};
