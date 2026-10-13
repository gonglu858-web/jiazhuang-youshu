'use strict';
/**
 * 纯身份解析/摘要模块（管理员稳定身份与执行会话绑定，2026-10-12 方案 §4）
 * =====================================================================
 *
 * 依据 docs/Codex方案-管理员稳定身份与执行会话绑定-20261012.md 的官方字段
 * 语义核对（STS GetCallerIdentity / AssumeRole 腾讯云公开文档）：
 *  - CAMRole 的 UserId 由 roleId 与 roleSessionName 以冒号组成；会话名不是
 *    永久人员编号。因此「事先批准的稳定云主体」与「当次执行会话」必须
 *    **分开绑定**：稳定摘要不含会话名，会话摘要用于同轮连续性核对。
 *  - 不自动学习当次响应作为预期；不仅看主账号或尾号；不改变旧
 *    expectedSubjectDigest（完整四元组）字段的含义。
 *
 * 本地收窄契约（不是官方对全部真实形状的断言）：
 *  - Type 只接受本轮受审类别 `CAMRole`；
 *  - 所有原始身份字段必须是非空字符串；不 trim、不转数字、不改大小写、
 *    不按尾号比较；
 *  - RoleId / UIN 用十进制字符串严格校验并保留原字节（不用 JS Number，
 *    角色 ID 可能超过安全整数范围；前导零变体不数值化为相同）；
 *  - UserId 只接受恰一个冒号：合法角色 ID + 合法非空会话名；会话名按
 *    AssumeRole 字符规则收窄为白名单 `[A-Za-z0-9_+=,.@-]{2,128}`（本工具
 *    接收规则，用测试固定）；
 *  - ARN 只接受文档角色示例对应形状 `qcs::sts:<AccountId>:assumed-role/<RoleId>`，
 *    且 AccountId/RoleId 与字段逐字相等；未识别形状即停止。
 *
 * 稳定主体摘要输入（固定顺序、带版本标识的 JSON 数组）：
 *   ["cloud-role-binding/1", Type, AccountId, PrincipalId, RoleId, Arn]
 * 会话摘要输入：
 *   ["cloud-role-session/1", Type, AccountId, UserId, PrincipalId, Arn]
 *
 * 「稳定」指不把会话名称纳入跨批次批准；不是官方对账号、角色或权限
 * 永不变化的保证。角色被替换、申请账号变化、ARN 改变都必须重新批准。
 *
 * 错误码为固定枚举，错误文本不含任何身份原值（净化）。
 * 本模块零网络、零子进程、零文件访问；不读全局状态。
 */

const crypto = require('node:crypto');

const BINDING_POLICY_VERSION = 'cloud-role-binding/1';
const SESSION_POLICY_VERSION = 'cloud-role-session/1';
const ACCEPTED_TYPE = 'CAMRole';
/** 本地接收的会话名白名单（AssumeRole 规则的收窄子集；测试固定）。 */
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_+=,.@-]{2,128}$/;
/** UIN / RoleId 的十进制字符串严格校验（保留原字节，不用 Number）。 */
const DECIMAL_PATTERN = /^[0-9]+$/;

const ERR = Object.freeze({
  FIELD_INVALID: 'IDENT_FIELD_INVALID',
  TYPE_MISMATCH: 'IDENT_TYPE_MISMATCH',
  USERID_FORMAT: 'IDENT_USERID_FORMAT',
  SESSION_NAME_INVALID: 'IDENT_SESSION_NAME_INVALID',
  ARN_MISMATCH: 'IDENT_ARN_MISMATCH'
});

function sha256Of(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function fail(code) {
  const e = new Error('调用者身份未通过本地收窄契约校验。');
  e.code = code;
  throw e;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 严格解析 CAMRole 调用者身份。任何形状不符即抛固定枚举错误（净化），
 * 绝不从截断摘要、旧尾号、昵称或运行时当前响应补齐预期。
 *
 * @returns {object} frozen { type, accountId, roleId, sessionName, principalId, arn }
 */
function parseCallerIdentity(sts) {
  const o = sts || {};
  if (!isNonEmptyString(o.Type) || !isNonEmptyString(o.AccountId) ||
    !isNonEmptyString(o.UserId) || !isNonEmptyString(o.PrincipalId) ||
    !isNonEmptyString(o.Arn)) {
    fail(ERR.FIELD_INVALID);
  }
  if (o.Type !== ACCEPTED_TYPE) fail(ERR.TYPE_MISMATCH);
  // UserId：角色类型恰一个冒号（roleId:sessionName）；多冒号/无冒号即拒
  const firstColon = o.UserId.indexOf(':');
  if (firstColon === -1 || firstColon !== o.UserId.lastIndexOf(':')) {
    fail(ERR.USERID_FORMAT);
  }
  const roleId = o.UserId.slice(0, firstColon);
  const sessionName = o.UserId.slice(firstColon + 1);
  if (!DECIMAL_PATTERN.test(roleId)) fail(ERR.USERID_FORMAT);
  if (!SESSION_NAME_PATTERN.test(sessionName)) fail(ERR.SESSION_NAME_INVALID);
  // UIN（主账号 / 申请凭据账号）：十进制字符串严格校验，保留原字节
  if (!DECIMAL_PATTERN.test(o.AccountId) || !DECIMAL_PATTERN.test(o.PrincipalId)) {
    fail(ERR.FIELD_INVALID);
  }
  // ARN 收窄形状逐字核对（主账号与角色 ID 都必须与字段一致）
  if (o.Arn !== 'qcs::sts:' + o.AccountId + ':assumed-role/' + roleId) {
    fail(ERR.ARN_MISMATCH);
  }
  return Object.freeze({
    type: o.Type,
    accountId: o.AccountId,
    roleId,
    sessionName,
    principalId: o.PrincipalId,
    arn: o.Arn
  });
}

/**
 * 事先批准的稳定主体摘要：不含会话名（跨批次固定预期的输入）。
 * 预期值必须来自单独受审的只读准备记录，不由当次响应自学习。
 */
function stableIdentityDigest(sts) {
  const id = parseCallerIdentity(sts);
  return sha256Of(JSON.stringify([
    BINDING_POLICY_VERSION, id.type, id.accountId, id.principalId, id.roleId, id.arn
  ]));
}

/**
 * 当次执行会话摘要：含完整 UserId（角色 ID + 会话名）。
 * 只用于同轮连续性比较（内存见证），不是新的允许名单。
 */
function sessionDigest(sts) {
  const id = parseCallerIdentity(sts);
  return sha256Of(JSON.stringify([
    SESSION_POLICY_VERSION, id.type, id.accountId, sts.UserId, id.principalId, id.arn
  ]));
}

module.exports = Object.freeze({
  ERR,
  BINDING_POLICY_VERSION,
  SESSION_POLICY_VERSION,
  ACCEPTED_TYPE,
  SESSION_NAME_PATTERN,
  DECIMAL_PATTERN,
  parseCallerIdentity,
  stableIdentityDigest,
  sessionDigest
});
