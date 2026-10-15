'use strict';
// 两位参与者「本人身份只读核验包」核心核验模块（仅本地实现，未部署）。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md
// 方案：docs/Codex执行包草案-三账号P准备窗口-20261015.md §8
//
// 设计边界（逐条对应任务 §3/§4）：
// 1. **固定目标**：AppID/环境/函数/测试集合写死；请求中的自报身份、集合、
//    环境、角色、文档键一律不采信，未知字段拒绝。
// 2. **可信输入**：APPID/OPENID 只来自 cloud.getWXContext（由调用方注入 trusted），
//    环境来自受审运行环境；userId 按未改业务算法派生
//    u_ + sha256(APPID + ':' + OPENID).slice(0,40)。
// 3. **单一动作**：仅 inspectSelf；identify/建项目/取号/邀请/批准/安排/移出等
//    业务动作全部拒绝，且拒绝发生在任何数据库访问之前（零 DB）。
// 4. **不写**：不创建用户、不写审计、不授予角色、不取号；本模块只做一次
//    固定集合/固定主键的 doc().get()，不 list/where、不跑事务。
// 5. **口令**：仅限制持有者，**不是现实本人身份凭证**；本轮只用合成口令。
//    服务端只比对摘要；不承诺一次性、不承诺全局限流（零持久写即无法保证）。
// 6. **结果净化**：registrationState 仅 ACTIVE/ABSENT/DISABLED/MISMATCH/UNKNOWN；
//    读取失败一律 UNKNOWN，绝不报「未登记」；不回传 OPENID/UNIONID/凭据，
//    也不透传原始 SDK 异常；userId 只出尾号。
// 7. **时钟**：读前、读后与成功返回前各重读当下时钟；NaN/抛错/过期均不可确认。

/** 受审固定目标：与既有 gate/工具常量一致，不新增可变目标。 */
const FIXED_TARGET = Object.freeze({
  appId: 'wxfb4db1615ac15531',
  envId: 'cloud1-d8gcq5ag39d847723',
  functionName: 'scheduleSandbox',
  collection: 'schtest_v1_users'
});

/** 唯一允许的动作。其余业务动作（identify/createProject/...）一律拒绝。 */
const ALLOWED_ACTIONS = Object.freeze(['inspectSelf']);

/** 登记状态取值闭集；任何未列举情况归 UNKNOWN。 */
const REGISTRATION_STATES = Object.freeze(['ACTIVE', 'ABSENT', 'DISABLED', 'MISMATCH', 'UNKNOWN']);

/**
 * 请求体允许字段：仅 action + 口令 + 可选 checkRoundId（用于轮次不符检测）。
 * 自报 openid/appId/userId/集合/角色/文档键一律不在其中，出现即拒绝。
 */
const REQUEST_FIELDS = Object.freeze(['action', 'passphrase', 'checkRoundId']);

const RESULT_SCHEMA = 'participant-identity-check-result/1';

/** 明确支持的停用状态字面量；其余 status 一律 UNKNOWN。 */
const SUPPORTED_DISABLED_STATUS = 'disabled';
const ACTIVE_STATUS = 'active';

const ERR_CODES = Object.freeze({
  ACTION_REJECTED: 'PIC_ACTION_REJECTED',
  REQUEST_INVALID: 'PIC_REQUEST_INVALID',
  CONTEXT_UNVERIFIED: 'PIC_CONTEXT_UNVERIFIED',
  TARGET_MISMATCH: 'PIC_TARGET_MISMATCH',
  PASSPHRASE_REQUIRED: 'PIC_PASSPHRASE_REQUIRED',
  PASSPHRASE_INVALID: 'PIC_PASSPHRASE_INVALID',
  ROUND_MISMATCH: 'PIC_ROUND_MISMATCH',
  WINDOW_NOT_OPEN: 'PIC_WINDOW_NOT_OPEN',
  WINDOW_EXPIRED: 'PIC_WINDOW_EXPIRED',
  CLOCK_INVALID: 'PIC_CLOCK_INVALID',
  CLOCK_ERROR: 'PIC_CLOCK_ERROR',
  READ_FAILED: 'PIC_READ_FAILED',
  DB_UNAVAILABLE: 'PIC_DB_UNAVAILABLE'
});

class ParticipantIdentityCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParticipantIdentityCheckError';
    this.code = code;
  }
}

const deny = (code, message) => { throw new ParticipantIdentityCheckError(code, message); };

/** 与未改业务逐字一致的 userId 算法（u_ + sha256(APPID:OPENID)[0:40]）。 */
function deriveUserId(appId, openid) {
  const crypto = require('node:crypto');
  return 'u_' + crypto.createHash('sha256').update(`${appId}:${openid}`).digest('hex').slice(0, 40);
}

/** userId 尾号：内部 userId 是标识而非密码，公开展示只给尾号。 */
function userIdTail(userId) {
  return typeof userId === 'string' ? userId.slice(-6) : '';
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 构造核验器。
 *
 * @param {object} deps
 * @param {object} deps.db        已映射/替身数据库句柄（本模块只读 users 集合）
 * @param {object} deps.trusted   { appId, envId, openid }（来自 getWXContext/运行环境）
 * @param {object} deps.config    { checkRoundId, passphraseDigest, windowStartsAtMs, windowExpiresAtMs }
 * @param {function} [deps.now]   取当下毫秒；默认 Date.now（测试可注入推进时钟）
 */
function createIdentityChecker(deps) {
  const { db, trusted, config } = deps || {};
  const now = typeof deps.now === 'function' ? deps.now : Date.now;

  if (!db || typeof db.collection !== 'function') deny(ERR_CODES.DB_UNAVAILABLE, '数据库句柄不可用。');
  if (!trusted || typeof trusted !== 'object') deny(ERR_CODES.CONTEXT_UNVERIFIED, '可信微信上下文不可用。');
  if (!config || typeof config !== 'object') deny(ERR_CODES.TARGET_MISMATCH, '核验配置缺失。');
  if (!isNonEmptyString(config.checkRoundId)) deny(ERR_CODES.TARGET_MISMATCH, '核验配置缺少轮次。');
  if (!isSha256Hex(config.passphraseDigest)) deny(ERR_CODES.TARGET_MISMATCH, '核验配置缺少口令摘要。');
  for (const k of ['windowStartsAtMs', 'windowExpiresAtMs']) {
    if (typeof config[k] !== 'number' || !Number.isFinite(config[k])) {
      deny(ERR_CODES.TARGET_MISMATCH, '核验配置窗口时间无效。');
    }
  }
  if (config.windowExpiresAtMs <= config.windowStartsAtMs) deny(ERR_CODES.TARGET_MISMATCH, '核验窗口时限无效。');

  const MAX_WINDOW_MS = 30 * 60 * 1000;
  if (config.windowExpiresAtMs - config.windowStartsAtMs > MAX_WINDOW_MS) {
    deny(ERR_CODES.TARGET_MISMATCH, '核验窗口不得超过 30 分钟。');
  }

  // 时钟读取：NaN/抛错各自独立归类，不与「未登记」混淆。
  function readNowMs() {
    let value;
    try {
      value = now();
    } catch (error) {
      deny(ERR_CODES.CLOCK_ERROR, '服务端时钟不可用。');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      deny(ERR_CODES.CLOCK_INVALID, '服务端时钟无效。');
    }
    return value;
  }

  function assertWindowOpen() {
    const t = readNowMs();
    if (t < config.windowStartsAtMs) deny(ERR_CODES.WINDOW_NOT_OPEN, '核验窗口尚未开始。');
    if (t > config.windowExpiresAtMs) deny(ERR_CODES.WINDOW_EXPIRED, '核验窗口已截止。');
    return t;
  }

  /** 目标绑定：可信 APPID/环境必须命中受审固定值；OPENID 缺失即不可确认。 */
  function assertTrustedTarget() {
    if (trusted.appId !== FIXED_TARGET.appId) deny(ERR_CODES.TARGET_MISMATCH, '当前小程序身份与受审目标不一致。');
    if (trusted.envId !== FIXED_TARGET.envId) deny(ERR_CODES.TARGET_MISMATCH, '当前环境与受审目标不一致。');
    if (!isNonEmptyString(trusted.openid)) deny(ERR_CODES.CONTEXT_UNVERIFIED, '无法确认当前微信身份，请重新进入。');
  }

  /** 口令准入：只比对摘要；不记录、不回显、不参与身份判断。 */
  function assertPassphrase(payload) {
    const given = payload.passphrase;
    if (given === undefined || given === null || given === '') {
      deny(ERR_CODES.PASSPHRASE_REQUIRED, '需要本窗口的核验口令。');
    }
    if (typeof given !== 'string') deny(ERR_CODES.PASSPHRASE_INVALID, '核验口令格式无效。');
    const crypto = require('node:crypto');
    const digest = crypto.createHash('sha256').update(given).digest('hex');
    if (digest !== config.passphraseDigest) deny(ERR_CODES.PASSPHRASE_INVALID, '核验口令不正确。');
  }

  function assertRequest(event) {
    const payload = event && typeof event === 'object' ? event : {};
    for (const k of Object.keys(payload)) {
      if (!REQUEST_FIELDS.includes(k)) deny(ERR_CODES.REQUEST_INVALID, '请求含未登记字段：' + k);
    }
    if (payload.action !== 'inspectSelf') {
      deny(ERR_CODES.ACTION_REJECTED, '本入口只提供本人身份只读核验（inspectSelf）。');
    }
    if (isNonEmptyString(payload.checkRoundId) && payload.checkRoundId !== config.checkRoundId) {
      deny(ERR_CODES.ROUND_MISMATCH, '核验轮次与本窗口不一致。');
    }
    assertPassphrase(payload);
  }

  /**
   * 单次固定读取：db.collection('schtest_v1_users').doc(userId).get()
   * 不 list/where、不读其它集合、不跑事务。返回分类结果。
   */
  async function readRegistration(userId, openid) {
    let response;
    try {
      const collection = db.collection(FIXED_TARGET.collection);
      if (!collection || typeof collection.doc !== 'function') {
        deny(ERR_CODES.DB_UNAVAILABLE, '固定测试集合不可用。');
      }
      const docRef = collection.doc(userId);
      if (!docRef || typeof docRef.get !== 'function') {
        deny(ERR_CODES.DB_UNAVAILABLE, '固定主键读取不可用。');
      }
      response = await docRef.get();
    } catch (error) {
      if (error && error.code && String(error.code).startsWith('PIC_')) throw error;
      // 数据库错误/权限/超时/异常形状：不得当作不存在
      deny(ERR_CODES.READ_FAILED, '读取本人测试账号记录失败（结果未知）。');
    }
    const rows = response && Array.isArray(response.data) ? response.data : null;
    if (rows === null) deny(ERR_CODES.READ_FAILED, '读取结果形状未知（结果未知）。');
    if (rows.length === 0) {
      // 明确无记录（SDK 以空数组表示文档不存在）
      return { state: 'ABSENT', recordMatched: null };
    }
    if (rows.length > 1) return { state: 'UNKNOWN', recordMatched: null };
    const row = rows[0];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { state: 'UNKNOWN', recordMatched: null };
    if (row._id !== userId || row.openid !== openid) {
      // 归属不符：绝不回传原值
      return { state: 'MISMATCH', recordMatched: false };
    }
    if (row.status === ACTIVE_STATUS) return { state: 'ACTIVE', recordMatched: true };
    if (row.status === SUPPORTED_DISABLED_STATUS) return { state: 'DISABLED', recordMatched: true };
    // 未知 status / 字段缺失：归 UNKNOWN
    return { state: 'UNKNOWN', recordMatched: true };
  }

  function baseResult(extra) {
    return Object.assign({
      schema: RESULT_SCHEMA,
      checkRoundId: config.checkRoundId,
      ok: false,
      identityConfirmed: false,
      registrationState: 'UNKNOWN',
      recordMatched: null,
      readAttempted: false,
      userIdTail: '',
      code: '',
      message: ''
    }, extra);
  }

  /**
   * 主入口：先过全部门槛（零 DB），再至多一次固定读取，最后重读时钟才确认。
   * 任何失败都不携带可采信的身份结论。
   */
  async function handle(event) {
    let userId = '';
    let readAttempted = false;
    try {
      // 1) 请求与目标门槛（DB 前）
      assertRequest(event);
      assertTrustedTarget();
      assertWindowOpen();
      userId = deriveUserId(FIXED_TARGET.appId, trusted.openid);

      // 2) 至多一次固定集合/固定主键读取
      readAttempted = true;
      const outcome = await readRegistration(userId, trusted.openid);

      // 3) 读后与成功返回前重读时钟；过期/无效即不可确认
      const serverNowMs = assertWindowOpen();

      return baseResult({
        ok: true,
        identityConfirmed: true,
        registrationState: outcome.state,
        recordMatched: outcome.recordMatched,
        readAttempted: true,
        userIdTail: userIdTail(userId),
        serverTimeIso: new Date(serverNowMs).toISOString(),
        message: '本人身份只读核验完成。'
      });
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'PIC_ERROR';
      const message = error && typeof error.message === 'string' ? error.message : '核验未完成。';
      // 读后失败：保留已可信取得的身份事实（尾号），但状态一律 UNKNOWN
      return baseResult({
        identityConfirmed: false,
        registrationState: 'UNKNOWN',
        recordMatched: null,
        readAttempted: readAttempted,
        userIdTail: userId ? userIdTail(userId) : '',
        code: code.startsWith('PIC_') ? code : 'PIC_ERROR',
        // 不透传原始 SDK 异常文本；只保留本模块自身定义的净化文案
        message: code.startsWith('PIC_') ? message : '核验未完成（结果未知）。'
      });
    }
  }

  return Object.freeze({ handle, readNowMs, FIXED_TARGET, ALLOWED_ACTIONS, REGISTRATION_STATES });
}

module.exports = Object.freeze({
  FIXED_TARGET,
  ALLOWED_ACTIONS,
  REGISTRATION_STATES,
  REQUEST_FIELDS,
  RESULT_SCHEMA,
  ERR_CODES,
  MAX_WINDOW_MS: 30 * 60 * 1000,
  ParticipantIdentityCheckError,
  createIdentityChecker,
  deriveUserId,
  userIdTail
});