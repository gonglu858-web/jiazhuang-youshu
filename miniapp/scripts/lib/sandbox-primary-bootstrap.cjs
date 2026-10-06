// 施工安排独立测试副本：P4 首次管理员初始化的**本地事务核心**。
//
// 依据：docs/WorkBuddy任务-独立副本最小测试驱动与首次初始化-20261005.md §7，
// 以及 Codex 复核 R5（固定身份、环境与时效）。
//
// 交付边界（必须分开表述，不得混为一谈）：
// - **已实现**：计划严格验证、固定环境自约束、受限适配器接口、可注入模拟适配器、
//   原子提交核心、用户身份一致性核对、回滚语义、本地 CLI 的计划检查。
// - **未就绪**：真实管理 SDK 事务适配器**未核实**。CLI `--execute` 一律拒绝，
//   零网络、零写入。本文件**不加载** SDK、不读密钥、不联网、不接 IAM。
// - **未执行**：primary 未初始化。
//
// 关键设计：
// 1. 固定集合与固定主键：只允许 schtest_v1_users（读）、schtest_v1_app_admins
//    （primary 主键）、schtest_v1_audit_events（一条确定性审计）。核心**不接收**
//    调用方传入的集合名或原始 SQL。
// 2. 计划**不含 projectId 前置**（建项目在后续阶段）；审计 projectId 为 null。
// 3. 同一事务内：读 users、读 app_admins.primary、读确定性审计主键 → 条件满足后
//    新增 primary 与审计。任一写失败**整体回滚**。
// 4. primary 已存在：**一律零写并停止**（同账号也不重复授予），可返回
//    `alreadyPresent` 观测但不算本次授权成功。
// 5. 审计 `_id` 由固定前缀 + roundId + 输入摘要确定，SDK 回调重入不改变它，
//    因此**不会**产生多条审计。
// 6. 时间与审计 ID 在**一次执行前固定**；事务回调内不做外部副作用。
// 7. `trusted:true` 只能作**测试数据**，不作为生产授权接口。
// 8. 结果未知：命令停止，不自动再执行；观察报告不构成新的写授权。
//
// R5 返修要点：
// - **核心自己**约束固定 AppID / env，不依赖调用方传入的两个值互相相等。
// - 批准主体来自**受控批准上下文**的**完整 userId 精确匹配**；尾号提示不是授权。
// - 同事务内核对 users 记录的 `_id`、`status` 与身份一致性
//   （`u_ + sha256(APPID + ':' + OPENID).slice(0,40)`，按已验收 service 契约在
//   内存核对）；缺失或错配即拒绝，**不导出 OPENID**。
// - 默认使用当前时钟；注入时钟必须是有效有限值且仅供测试/明确受控用途；
//   **首次写入之前再次核验时效**。
// - `observePrimary` 也核验调用者与本计划的确定性审计，给出
//   存在 / 不存在 / 不一致 / 无法确认，**永不**变成写授权。

'use strict';

const crypto = require('node:crypto');

/** 固定 AppID / 环境：**核心自约束**，不作为可配置项。 */
const FIXED_APP_ID = 'wxfb4db1615ac15531';
const FIXED_ENV_ID = 'cloud1-d8gcq5ag39d847723';

/** 固定允许的主键操作前缀白名单：越界一律拒绝。 */
const ALLOWED_COLLECTIONS = Object.freeze([
  'schtest_v1_users',
  'schtest_v1_app_admins',
  'schtest_v1_audit_events'
]);

/** 审计 action 专用值。 */
const AUDIT_ACTION = 'initializeSandboxPrimary';

/** 审计 `_id` 固定前缀。 */
const AUDIT_ID_PREFIX = 'sbx-init-primary:';

/** primary 主键固定值。 */
const PRIMARY_ID = 'primary';

class BootstrapError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

function deny(code, message, detail) {
  throw new BootstrapError(code, message, detail);
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** 稳定序列化：用于输入摘要，保证同一输入得到同一审计 ID。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/**
 * 按**已验收 service 契约**派生 userId：
 * `u_ + sha256(APPID + ':' + OPENID).slice(0, 40)`。
 * 只在本模块内存中比对，**永不**导出或写回 OPENID。
 */
function deriveUserId(appId, openid) {
  return `u_${sha256(`${appId}:${openid}`).slice(0, 40)}`;
}

/** 计划字段白名单：**不含** collection / sql / secret / token / openid 之类。 */
const PLAN_FIELDS = Object.freeze([
  'enabled', 'appId', 'envId', 'roundId', 'targetUserId', 'evidenceId',
  'expiresAt', 'schemaVersion', 'operatorRef', 'approvedOwnerHint'
]);

/** 明确禁止出现在计划里的字段名（大小写不敏感子串匹配）。 */
const FORBIDDEN_PLAN_FIELDS = Object.freeze([
  'collection', 'sql', 'query', 'secret', 'token', 'openid', 'password',
  'credential', 'accesskey', 'appkey', 'projectid', 'adminid', 'trusted'
]);

// ── 受控批准上下文（R5）──────────────────────────────────────────────────

/**
 * 受控批准上下文：由**受审的负责人名单**注入，核心据此精确匹配批准主体。
 *
 * 边界（必须分开表述）：
 * - 生产环境**尚无**这份名单；动态值留空，本轮不填任何真实 userId。
 * - 合成测试用**受限独立**的批准上下文，不接 IAM、不接真实 SDK。
 * - `approvedOwnerHint`（尾号提示）**不是授权依据**，仅作人工对照。
 *
 * @param {object} approval { approvedUserIds: string[], approvedBy: string, approvedAt: string }
 */
function validateApprovalContext(approval) {
  if (!isPlainObject(approval)) {
    deny('APPROVAL_CONTEXT_MISSING', '缺少受控批准上下文；尾号提示不能作为授权依据，零写入。');
  }
  const problems = [];
  if (!Array.isArray(approval.approvedUserIds) || !approval.approvedUserIds.length) {
    problems.push('approvedUserIds 必须是非空数组。');
  } else {
    for (const id of approval.approvedUserIds) {
      if (typeof id !== 'string' || !/^u_[0-9a-f]{40}$/.test(id)) {
        problems.push('approvedUserIds 只接受完整 userId（u_ + 40 位十六进制）。');
        break;
      }
    }
  }
  if (typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim()) {
    problems.push('缺批准人记录（approvedBy）。');
  }
  if (typeof approval.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt))) {
    problems.push('缺可解析的批准时间（approvedAt）。');
  }
  if (problems.length) {
    deny('APPROVAL_CONTEXT_INVALID', '受控批准上下文不合法，零写入。', problems);
  }
  return deepFreeze({
    approvedUserIds: approval.approvedUserIds.slice(),
    approvedBy: approval.approvedBy.trim(),
    approvedAt: approval.approvedAt
  });
}

/** 精确匹配批准主体（完整 userId）。不接受尾号。 */
function assertApprovedTarget(approval, targetUserId) {
  if (!approval.approvedUserIds.includes(targetUserId)) {
    deny('TARGET_NOT_APPROVED', '目标负责人不在受控批准名单内；尾号提示不构成授权，零写入。');
  }
  return true;
}

// ── 计划验证 ──────────────────────────────────────────────────────────────

/**
 * 严格验证初始化计划。**纯本地，不触碰数据库。**
 * 不合法即抛错，调用方必须零数据库操作。
 *
 * R5 返修：固定 AppID / env 由**核心常量**判定；时钟默认当前时间，
 * 注入值必须是有效有限数。
 *
 * @param {object} rawPlan 调用方提供的计划
 * @param {object} context { approval, nowMs, nowSource }
 */
function validatePlan(rawPlan, context) {
  const ctx = context || {};
  const problems = [];
  if (!isPlainObject(rawPlan)) deny('PLAN_INVALID', '初始化计划必须是对象。');

  // 1) 禁止字段
  for (const key of Object.keys(rawPlan)) {
    const lower = String(key).toLowerCase();
    for (const bad of FORBIDDEN_PLAN_FIELDS) {
      if (lower.includes(bad.toLowerCase())) {
        problems.push(`计划含禁止字段 ${key}`);
      }
    }
  }
  // 2) 未知字段
  for (const key of Object.keys(rawPlan)) {
    if (!PLAN_FIELDS.includes(key)) problems.push(`计划含未登记字段 ${key}`);
  }
  // 3) 开关
  if (rawPlan.enabled !== true) problems.push('计划未启用（enabled 必须为 true）。');
  // 4) **固定目标由核心常量判定**（不与调用方 options 比较）
  if (rawPlan.appId !== FIXED_APP_ID) problems.push('计划 AppID 与固定 AppID 不符。');
  if (rawPlan.envId !== FIXED_ENV_ID) problems.push('计划环境 ID 与固定环境不符。');
  // 5) 动态值完整
  for (const field of ['roundId', 'targetUserId', 'evidenceId', 'expiresAt']) {
    const v = rawPlan[field];
    if (typeof v !== 'string' || !v.trim()) problems.push(`计划缺 ${field}。`);
  }
  // 6) 目标必须是完整 userId（u_ + 40 位十六进制），不接受尾号
  if (typeof rawPlan.targetUserId === 'string' && rawPlan.targetUserId.trim()) {
    if (!/^u_[0-9a-f]{40}$/.test(rawPlan.targetUserId.trim())) {
      problems.push('targetUserId 必须是完整 userId（u_ + 40 位十六进制），不接受尾号或昵称。');
    }
  }
  // 7) 负责人提示仅作人工对照，不是授权依据
  if (rawPlan.approvedOwnerHint !== undefined && rawPlan.approvedOwnerHint !== '2d3aa4') {
    problems.push('approvedOwnerHint 与已审查的负责人提示不一致。');
  }
  // 8) schemaVersion
  if (rawPlan.schemaVersion !== 1) problems.push('schemaVersion 必须为 1。');
  // 9) 窗口：**默认当前时钟**；注入时钟必须是有效有限值
  const deadline = Date.parse(rawPlan.expiresAt);
  if (!Number.isFinite(deadline)) problems.push('expiresAt 不合法。');
  const nowMs = resolveNowMs(ctx);
  if (Number.isFinite(deadline) && nowMs > deadline) problems.push('计划窗口已过期。');
  // 10) operatorRef 不得是凭据形态
  if (typeof rawPlan.operatorRef === 'string' && rawPlan.operatorRef.trim()) {
    if (/[=;]/.test(rawPlan.operatorRef)) problems.push('operatorRef 不得包含凭据形态字符。');
  }

  if (problems.length) {
    deny('PLAN_INVALID', '初始化计划不合法，零数据库操作。', problems);
  }
  return deepFreeze({
    enabled: true,
    appId: FIXED_APP_ID,
    envId: FIXED_ENV_ID,
    roundId: rawPlan.roundId.trim(),
    targetUserId: rawPlan.targetUserId.trim(),
    evidenceId: rawPlan.evidenceId.trim(),
    expiresAt: rawPlan.expiresAt,
    schemaVersion: rawPlan.schemaVersion,
    operatorRef: typeof rawPlan.operatorRef === 'string' ? rawPlan.operatorRef.trim() : '',
    approvedOwnerHint: rawPlan.approvedOwnerHint,
    deadlineMs: deadline
  });
}

/**
 * 解析“现在”。
 * - 默认当前时钟；
 * - 注入值必须是**有效有限数**，否则拒绝（不接受 undefined/NaN/Infinity/未来异常值）。
 */
function resolveNowMs(ctx) {
  const v = ctx.nowMs;
  if (v === undefined || v === null) return Date.now();
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    deny('CLOCK_INVALID', '注入时钟必须是有效有限数（毫秒），零写入。');
  }
  if (v < 0) {
    deny('CLOCK_INVALID', '注入时钟为负值，拒绝；零写入。');
  }
  // 明显不合理的未来值（例如误把微秒/纳秒当毫秒）也拒绝
  if (v > 4102444800000) { // 2100-01-01
    deny('CLOCK_INVALID', '注入时钟超出合理范围，拒绝；零写入。');
  }
  return v;
}

/** 输入摘要（不含凭据），用于审计 ID 与 before/after 之外的关联。 */
function inputDigest(plan) {
  return sha256(stableStringify({
    appId: plan.appId,
    envId: plan.envId,
    roundId: plan.roundId,
    targetUserId: plan.targetUserId,
    evidenceId: plan.evidenceId,
    schemaVersion: plan.schemaVersion
  })).slice(0, 32);
}

/** 确定性审计主键：固定前缀 + roundId + 输入摘要。重试不产生多条。 */
function auditId(plan, digest) {
  return `${AUDIT_ID_PREFIX}${sha256(`${plan.roundId}:${digest}`).slice(0, 32)}`;
}

// ── 受限适配器边界 ────────────────────────────────────────────────────────

/**
 * 校验适配器实现是否只暴露**固定主键操作**。
 * 核心不接收调用方集合名，也不接受原始 SQL。
 */
function assertAdapterBoundary(adapter) {
  const required = ['verifyCaller', 'beginTransaction', 'getDoc', 'setDoc', 'commit', 'rollback'];
  for (const name of required) {
    if (!adapter || typeof adapter[name] !== 'function') {
      deny('ADAPTER_INVALID', `受限适配器缺少必需方法 ${name}。`);
    }
  }
  return true;
}

/** 集合白名单：越界拒绝。 */
function assertCollectionAllowed(name) {
  if (!ALLOWED_COLLECTIONS.includes(name)) {
    deny('COLLECTION_NOT_ALLOWED', `集合不在固定白名单内，已拒绝：${name}`);
  }
  return name;
}

// ── 用户记录身份一致性（R5）──────────────────────────────────────────────

/**
 * 核对 users 记录的身份一致性（**同事务内**）。
 *
 * 按已验收 service 契约：`_id === u_ + sha256(APPID + ':' + OPENID).slice(0,40)`。
 * - 记录缺少身份字段 → 拒绝（不猜、不补）
 * - 记录 `_id` 与主键不一致 → 拒绝
 * - 派生结果与记录 `_id` 不一致 → 拒绝
 * - **OPENID 只在本函数内存里参与比对，绝不写回、绝不进入错误详情或审计**
 */
function verifyUserRecordIdentity(userDoc, key, appId) {
  const problems = [];
  if (!isPlainObject(userDoc)) {
    deny('USER_RECORD_INVALID', '用户记录结构无效，零写入。');
  }
  if (userDoc._id !== key) {
    problems.push('记录 _id 与查询主键不一致');
  }
  if (userDoc.status !== 'active') {
    problems.push('不是 active 状态');
  }
  const hasOpenid = typeof userDoc.openid === 'string' && userDoc.openid.length > 0;
  if (!hasOpenid) {
    // 缺失身份字段：无法确认一致性 → 拒绝
    deny('USER_IDENTITY_UNVERIFIABLE', '用户记录缺少身份字段，无法核对身份一致性，零写入。', problems);
  }
  const derived = deriveUserId(appId, userDoc.openid);
  if (derived !== key || userDoc._id !== derived) {
    problems.push('身份派生值与记录 _id 不一致');
  }
  if (problems.length) {
    deny('USER_IDENTITY_MISMATCH', '用户记录身份一致性核对失败，零写入。', problems);
  }
  return true;
}

// ── 事务核心 ──────────────────────────────────────────────────────────────

/**
 * 在**同一事务**内完成首次 primary 初始化。
 *
 * 流程（§7.2 + R5）：
 * 1. 受控批准上下文校验与批准主体精确匹配（纯本地）
 * 2. 计划验证（固定 AppID/env 由核心常量判定；默认当前时钟）
 * 3. 适配器边界验证当前管理调用者权限/实际环境
 * 4. 同事务读 users / primary / 确定性审计主键，并核对用户身份一致性
 * 5. **首写之前再次核验时效**
 * 6. 同事务新增 primary 与一条关联审计
 * 7. 任一写失败整体回滚
 * 8. primary 已存在 → 一律零写并停止
 * 9. 结果未知 → 停止，不自动再执行
 *
 * @param {object} options { plan, adapter, approval, nowMs, fixedNowMs, allowTrustedForTest }
 */
async function initializePrimary(options) {
  const adapter = options.adapter;
  // 0) 受控批准上下文 + 批准主体精确匹配（**先于任何数据库操作**）
  const approval = validateApprovalContext(options.approval);

  // 1) 计划验证（固定环境由核心常量判定）
  const nowForPlan = resolveNowMs({ nowMs: options.nowMs });
  const plan = validatePlan(options.plan, { approval, nowMs: nowForPlan });
  assertApprovedTarget(approval, plan.targetUserId);

  // 2) 适配器边界
  assertAdapterBoundary(adapter);

  // 一次执行前固定时间与审计 ID：SDK 回调重入不改变它们
  const fixedNowMs = typeof options.fixedNowMs === 'number' ? options.fixedNowMs : nowForPlan;
  if (!Number.isFinite(fixedNowMs)) {
    deny('CLOCK_INVALID', '固定审计时间必须是有效有限数，零写入。');
  }
  const digest = inputDigest(plan);
  const fixedAuditId = auditId(plan, digest);

  // 适配器侧的调用者权限/环境核验（本轮由模拟适配器代替真实 IAM）
  let caller;
  try {
    caller = await adapter.verifyCaller({ envId: FIXED_ENV_ID, appId: FIXED_APP_ID });
  } catch (error) {
    deny('CALLER_VERIFY_FAILED', '管理调用者权限或环境核验失败，零写入。', String(error && error.message));
  }
  if (!caller || caller.allowed !== true) {
    deny('CALLER_VERIFY_FAILED', '管理调用者未获核验，零写入。');
  }
  // 调用者报告的环境必须与**固定**环境一致（不与计划互相校对）
  if (caller.appId !== undefined && caller.appId !== FIXED_APP_ID) {
    deny('CALLER_ENV_MISMATCH', '管理调用者环境与固定 AppID 不一致，零写入。');
  }
  if (caller.envId !== undefined && caller.envId !== FIXED_ENV_ID) {
    deny('CALLER_ENV_MISMATCH', '管理调用者环境与固定环境不一致，零写入。');
  }
  // trusted 只是测试数据标记，不能当作生产授权
  if (caller.trusted === true && options.allowTrustedForTest !== true) {
    deny('TRUSTED_FLAG_NOT_ACCEPTED', 'trusted 标记只能作测试数据，本路径不接受。');
  }

  let tx = null;
  let committed = false;
  try {
    tx = await adapter.beginTransaction();
    if (!tx) deny('TX_UNAVAILABLE', '无法开启数据库事务，零写入。');

    // 3) 同事务读
    assertCollectionAllowed('schtest_v1_users');
    assertCollectionAllowed('schtest_v1_app_admins');
    assertCollectionAllowed('schtest_v1_audit_events');

    const user = await adapter.getDoc(tx, 'schtest_v1_users', plan.targetUserId);
    if (!user) {
      deny('TARGET_USER_NOT_FOUND', '目标负责人在副本 users 中不存在；必须先由本人微信 identify 建立。');
    }
    // 4) 身份一致性核对：_id、active、派生值（不导出 OPENID）
    verifyUserRecordIdentity(user, plan.targetUserId, FIXED_APP_ID);

    const existingPrimary = await adapter.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID);
    if (existingPrimary) {
      // 5) 已存在 → 一律零写并停止（同账号也不重复授予）
      await adapter.rollback(tx);
      tx = null;
      return {
        ok: true,
        outcome: 'alreadyPresent',
        granted: false,
        reason: 'primary 已存在，本次零写入；不重复授予，需人工核对是否为同一次授权。',
        existing: { userId: existingPrimary.userId || '', status: existingPrimary.status || '' }
      };
    }

    // 确定性审计主键：已存在说明此前已提交过，**不重复**
    const existingAudit = await adapter.getDoc(tx, 'schtest_v1_audit_events', fixedAuditId);
    if (existingAudit) {
      await adapter.rollback(tx);
      tx = null;
      return {
        ok: true,
        outcome: 'auditAlreadyPresent',
        granted: false,
        reason: '对应审计已存在但 primary 缺失，状态冲突；已停止，绝不自动补写或删除。',
        auditId: fixedAuditId
      };
    }

    // 6) **首写之前再次核验时效**（预检耗时不得穿越截止后写入）
    const beforeWrite = resolveNowMs({ nowMs: options.nowMs });
    if (beforeWrite > plan.deadlineMs) {
      await adapter.rollback(tx);
      tx = null;
      deny('PLAN_EXPIRED_BEFORE_WRITE', '预检期间计划窗口已过期，首写之前已停止；零写入。');
    }

    // 7) 同事务新增 primary 与审计
    const primaryDoc = { _id: PRIMARY_ID, userId: plan.targetUserId, status: 'active' };
    const auditDoc = {
      _id: fixedAuditId,
      projectId: null,
      actorUserId: null,
      actorRole: '受控管理端初始化',
      action: AUDIT_ACTION,
      subjectUserId: plan.targetUserId,
      before: null,
      // after 只含管理员资格字段
      after: { userId: plan.targetUserId, status: 'active' },
      // 不含凭据的关联信息
      operatorRef: plan.operatorRef,
      roundId: plan.roundId,
      evidenceId: plan.evidenceId,
      inputDigest: digest,
      envId: FIXED_ENV_ID,
      appId: FIXED_APP_ID,
      schemaVersion: plan.schemaVersion,
      approvedBy: approval.approvedBy,
      createdAt: new Date(fixedNowMs).toISOString()
    };

    await adapter.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID, primaryDoc);
    await adapter.setDoc(tx, 'schtest_v1_audit_events', fixedAuditId, auditDoc);

    // 8) 提交；失败整体回滚
    await adapter.commit(tx);
    committed = true;
    tx = null;

    return {
      ok: true,
      outcome: 'initialized',
      granted: true,
      auditId: fixedAuditId,
      inputDigest: digest,
      note: '本地事务核心已完成模拟提交；真实平台执行仍未接通，不得据此认为云端已初始化。'
    };
  } catch (error) {
    if (tx && !committed) {
      try {
        await adapter.rollback(tx);
      } catch (rollbackError) {
        // 回滚失败必须如实报告，不吞掉
        deny('ROLLBACK_FAILED', '事务失败且回滚未成功，状态需人工核对。', {
          cause: String(error && error.message),
          rollback: String(rollbackError && rollbackError.message)
        });
      }
    }
    if (error instanceof BootstrapError) throw error;
    // 未知错误按「结果未知」处理：停止，不自动再执行
    deny('RESULT_UNKNOWN', '初始化结果未知，命令已停止；请只读核对 primary 与审计后再决定，不自动重跑。', {
      cause: String(error && error.message)
    });
  }
}

/**
 * 只读观察：primary 与**本计划确定性审计**的实际状态。
 *
 * R5 返修：
 * - 也核验调用者与固定环境；
 * - **只按本计划的确定性审计主键查询**，不扫描运维系统；
 * - 给出 present / absent / inconsistent / unconfirmed 四态；
 * - **永不**变成写授权。
 *
 * @param {object} options { adapter, plan, approval, nowMs }
 */
async function observePrimary(options) {
  const adapter = options.adapter;
  assertAdapterBoundary(adapter);
  assertCollectionAllowed('schtest_v1_app_admins');
  assertCollectionAllowed('schtest_v1_audit_events');

  // 核验当前调用者与固定环境（无权限即无法确认，不降级为「不存在」）
  let callerOk = true;
  let callerReason = '';
  try {
    const caller = await adapter.verifyCaller({ envId: FIXED_ENV_ID, appId: FIXED_APP_ID });
    callerOk = Boolean(caller && caller.allowed === true
      && (caller.appId === undefined || caller.appId === FIXED_APP_ID)
      && (caller.envId === undefined || caller.envId === FIXED_ENV_ID));
    if (!callerOk) callerReason = '调用者未获核验或环境不符。';
  } catch (error) {
    callerOk = false;
    callerReason = '调用者核验失败。';
  }
  if (!callerOk) {
    return Object.freeze({
      state: 'unconfirmed',
      reason: callerReason,
      writeAuthorized: false,
      note: '本结果为只读观察，不构成新的写授权。'
    });
  }

  // 计划必须合法才能定位确定性审计主键
  let plan;
  let approval;
  try {
    approval = validateApprovalContext(options.approval);
    const nowForPlan = resolveNowMs({ nowMs: options.nowMs });
    plan = validatePlan(options.plan, { approval, nowMs: nowForPlan });
  } catch (error) {
    return Object.freeze({
      state: 'unconfirmed',
      reason: `计划不可用：${error.code || 'PLAN_INVALID'}`,
      writeAuthorized: false,
      note: '本结果为只读观察，不构成新的写授权。'
    });
  }

  const expectedAuditId = auditId(plan, inputDigest(plan));
  const readOnlyGet = typeof adapter.readOnlyGet === 'function'
    ? adapter.readOnlyGet.bind(adapter)
    : null;
  if (!readOnlyGet) {
    return Object.freeze({
      state: 'unconfirmed',
      reason: '适配器未提供只读查询能力。',
      writeAuthorized: false,
      note: '本结果为只读观察，不构成新的写授权。'
    });
  }

  let primary;
  let audit;
  try {
    primary = await readOnlyGet('schtest_v1_app_admins', PRIMARY_ID);
    audit = await readOnlyGet('schtest_v1_audit_events', expectedAuditId);
  } catch (error) {
    return Object.freeze({
      state: 'unconfirmed',
      reason: '只读查询失败，无法确认状态。',
      writeAuthorized: false,
      note: '本结果为只读观察，不构成新的写授权。'
    });
  }

  let state;
  let reason = '';
  if (!primary && !audit) {
    state = 'absent';
    reason = '本计划对应的 primary 与确定性审计都不存在。';
  } else if (primary && audit) {
    // S5 返修：`present` 必须表示「本计划初始化的 primary 与确定性审计
    // **内容一致**」，因此除目标/动作/轮次外，还要核对：
    // - primary：固定主键、目标一致、**资格状态为 active**
    // - audit：固定键、目标、action、轮次，以及本计划必要关联
    //   （环境、证据编号、输入摘要）
    // 此前只比对了目标与 action，导致 `status:'disabled'` 的 primary
    // 也会被判为「与本计划一致」，结论自相矛盾。
    const problems = [];
    if (primary._id !== PRIMARY_ID) problems.push('primary 主键不符');
    if (primary.userId !== plan.targetUserId) problems.push('primary 目标不符');
    if (primary.status !== 'active') problems.push(`primary 资格状态不是 active（${String(primary.status)}）`);
    if (audit._id !== expectedAuditId) problems.push('审计主键不符');
    if (audit.subjectUserId !== plan.targetUserId) problems.push('审计目标不符');
    if (audit.action !== AUDIT_ACTION) problems.push('审计 action 不符');
    if (audit.roundId !== plan.roundId) problems.push('审计轮次不符');
    if (audit.envId !== FIXED_ENV_ID) problems.push('审计环境不符');
    if (audit.evidenceId !== plan.evidenceId) problems.push('审计证据编号不符');
    if (audit.inputDigest !== inputDigest(plan)) problems.push('审计输入摘要不符');
    if (problems.length) {
      state = 'inconsistent';
      reason = `primary 或审计与本计划不一致：${problems.join('、')}。需人工核对。`;
    } else {
      state = 'present';
      reason = 'primary 与本计划的确定性审计均存在且内容一致（含 active 资格状态）。';
    }
  } else {
    state = 'inconsistent';
    reason = primary
      ? 'primary 存在但本计划的确定性审计缺失。'
      : '本计划的确定性审计存在但 primary 缺失。';
  }

  return Object.freeze({
    state,
    reason,
    primaryPresent: Boolean(primary),
    primaryUserId: primary ? (primary.userId || '') : '',
    primaryStatus: primary ? (primary.status || '') : '',
    auditId: expectedAuditId,
    auditPresent: Boolean(audit),
    // 明确标注：这只是观察
    writeAuthorized: false,
    note: '本结果为只读观察，不构成新的写授权。'
  });
}

module.exports = Object.freeze({
  FIXED_APP_ID,
  FIXED_ENV_ID,
  ALLOWED_COLLECTIONS,
  PLAN_FIELDS,
  FORBIDDEN_PLAN_FIELDS,
  AUDIT_ACTION,
  AUDIT_ID_PREFIX,
  PRIMARY_ID,
  BootstrapError,
  deriveUserId,
  validateApprovalContext,
  assertApprovedTarget,
  resolveNowMs,
  verifyUserRecordIdentity,
  validatePlan,
  inputDigest,
  auditId,
  assertAdapterBoundary,
  assertCollectionAllowed,
  initializePrimary,
  observePrimary,
  stableStringify,
  deepFreeze
});