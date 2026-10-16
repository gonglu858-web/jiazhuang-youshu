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
// 7. **时钟**：读前、读后与成功返回前各重读当下时钟；NaN/抛错/**now >= expires** 均不可确认。
// 8. **R2 受控完整 ID 交付**：本次有效核验结果（identityConfirmed 且状态可采信）可携带
//    **完整内部 userId**（u_ + 40 位十六进制），供后续执行包绑定允许名单/必要登记/P 证据；
//    页面默认只展示尾号，需显式请求才由服务端返回完整 ID。完整 userId 是标识而非密码：
//    **不是** OPENID/UNIONID，任何情况下都不返回口令、凭据或原始 SDK 异常。
// 9. **R5 轮次绑定**：checkRoundId 由计划写入服务端配置，**必须**由页面→client→服务端逐层
//    带回；缺失/空值/非字符串/与配置不符一律在数据库读取前拒绝，不得靠服务端自述绕过。
// 10. **R6 读取边界**：字段投影只取 _id/openid/status（用 doc().field() 选择字段）；
//    readAttempted 只在实际调用 get() 之前置真；缺字段归 UNKNOWN；错误只输出白名单代码与
//    固定文案（内部错误标记，不看外部错误的 code 前缀）。
// 11. **真实 SDK 形状兼容（I1/I2 前置核验）**：wx-server-sdk（3.0.1 实测源码，2.6.3→3.0.1
//     CHANGELOG 无数据库 API 行为变更）单文档 get() 在入口以 throwOnNotFound:false 构造时：
//     存在 → resolve `{ data: <单个文档对象>, errMsg }`；明确不存在 → resolve `{ data: null }`；
//     权限/读取失败 → reject CloudSDKError。读取结果统一归一为「单文档对象 / 明确无记录 /
//     数组形状（合成替身兼容）」三种，均不误判。
// 12. **受控键诊断（默认关闭）**：仅当 config.keyDiagnostic === true 且请求顶层出现未登记键时，
//     在动作/轮次/口令/可信目标/当下窗口**全部复核通过**后，向 REQUEST_INVALID 失败结果附加
//     `keyDiagnostic`：只含源代码固定候选标签、其它键计数与键名长度分桶（固定边界）。
//     任何原键名、值、前后缀一概不出现；只枚举 Object.keys，不读取值/getter/__proto__；
//     不读数据库、不改 UNKNOWN/PIC_REQUEST_INVALID、不扩 REQUEST_FIELDS；构造异常一律吞掉
//     保持净化失败，不影响读取事实。诊断协议版本 KEY_DIAGNOSTIC_SCHEMA 纳入打包器/manifest 绑定。

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
 * 请求体允许字段：仅 action + 口令 + **必填** checkRoundId（R5 轮次绑定）+ 可选
 * includeFullUserId（R2 受控完整 ID 交付开关；只影响返回，不影响判定）。
 * 自报 openid/appId/userId/集合/角色/文档键一律不在其中，出现即拒绝。
 */
const REQUEST_FIELDS = Object.freeze(['action', 'passphrase', 'checkRoundId', 'includeFullUserId']);

const RESULT_SCHEMA = 'participant-identity-check-result/2';

// ── 受控键诊断（默认关闭；协议版本纳入打包器/manifest/计划绑定） ──────────────
/** 诊断对象协议版本；manifest 与客户端按此固定值验证，未知版本一律不展示。 */
const KEY_DIAGNOSTIC_SCHEMA = 'participant-identity-key-diagnostic/1';
/** 诊断范围固定标签：只描述请求顶层键的枚举统计，不含任何值。 */
const KEY_DIAGNOSTIC_SCOPE = 'request-keys-only';
/**
 * 源代码固定的候选键名→固定标签字典：仅用于识别已知候选键是否出现。
 * 字典中的键名不因此成为允许业务字段或可信身份；字典之外一律只计数/分桶。
 */
const KEY_DIAGNOSTIC_CANDIDATES = Object.freeze({ userInfo: 'CANDIDATE_USERINFO' });
/** 候选标签输出上限；超过即截断并置 truncated（当前字典为 1，实际不可达，保留协议字段）。 */
const KEY_DIAGNOSTIC_MAX_LABELS = 8;
/** 键名长度分桶边界（源代码固定）；超过最后边界归 lenOver32。 */
const KEY_DIAGNOSTIC_LENGTH_BUCKETS = Object.freeze([
  Object.freeze({ max: 4, label: 'len<=4' }),
  Object.freeze({ max: 8, label: 'len5-8' }),
  Object.freeze({ max: 16, label: 'len9-16' }),
  Object.freeze({ max: 32, label: 'len17-32' })
]);
const KEY_DIAGNOSTIC_OVERFLOW_LABEL = 'lenOver32';

/** R6：错误白名单——只有本模块产生的错误才允许其 code 与文案外传。 */
const ERROR_PUBLIC_TEXT = Object.freeze({
  PIC_ACTION_REJECTED: '本入口只提供本人身份只读核验（inspectSelf）。',
  PIC_REQUEST_INVALID: '请求含未登记字段。',
  PIC_CONTEXT_UNVERIFIED: '无法确认当前微信身份，请重新进入。',
  PIC_TARGET_MISMATCH: '当前小程序身份或环境与受审目标不一致。',
  PIC_PASSPHRASE_REQUIRED: '需要本窗口的核验口令。',
  PIC_PASSPHRASE_INVALID: '核验口令不正确。',
  PIC_ROUND_REQUIRED: '缺少核验轮次。',
  PIC_ROUND_MISMATCH: '核验轮次与本窗口不一致。',
  PIC_WINDOW_NOT_OPEN: '核验窗口尚未开始。',
  PIC_WINDOW_EXPIRED: '核验窗口已截止。',
  PIC_CLOCK_INVALID: '服务端时钟无效。',
  PIC_CLOCK_ERROR: '服务端时钟不可用。',
  PIC_READ_FAILED: '读取本人测试账号记录失败（结果未知）。',
  PIC_FIELD_PROJECTION_UNAVAILABLE: '无法按最小字段范围读取（结果未知）。',
  PIC_DB_UNAVAILABLE: '固定测试集合或主键读取不可用（结果未知）。'
});
/** 未在白名单内的内部错误：统一净化为结果未知。 */
const GENERIC_CODE = 'PIC_RESULT_UNKNOWN';
const GENERIC_TEXT = '核验未完成（结果未知）。';

/** R2：可对外返回完整内部 userId 的登记状态（这些结果不构成 P 登记证据）。 */
const FULL_ID_STATES = Object.freeze(['ACTIVE', 'ABSENT', 'DISABLED', 'MISMATCH']);

/** R6 内部错误标记键（Symbol，不可被外部伪造）。 */
const INTERNAL_ERROR = Symbol.for('participant-identity-check.internal-error');

/** 明确支持的停用状态字面量；其余 status 一律 UNKNOWN。 */
const SUPPORTED_DISABLED_STATUS = 'disabled';
const ACTIVE_STATUS = 'active';

/** R6：最小字段投影——只取 _id/openid/status（任务书 §4 要求）。 */
const READ_FIELD_PROJECTION = Object.freeze({ _id: true, openid: true, status: true });

const ERR_CODES = Object.freeze({
  ACTION_REJECTED: 'PIC_ACTION_REJECTED',
  REQUEST_INVALID: 'PIC_REQUEST_INVALID',
  CONTEXT_UNVERIFIED: 'PIC_CONTEXT_UNVERIFIED',
  TARGET_MISMATCH: 'PIC_TARGET_MISMATCH',
  PASSPHRASE_REQUIRED: 'PIC_PASSPHRASE_REQUIRED',
  PASSPHRASE_INVALID: 'PIC_PASSPHRASE_INVALID',
  ROUND_REQUIRED: 'PIC_ROUND_REQUIRED',
  ROUND_MISMATCH: 'PIC_ROUND_MISMATCH',
  WINDOW_NOT_OPEN: 'PIC_WINDOW_NOT_OPEN',
  WINDOW_EXPIRED: 'PIC_WINDOW_EXPIRED',
  CLOCK_INVALID: 'PIC_CLOCK_INVALID',
  CLOCK_ERROR: 'PIC_CLOCK_ERROR',
  READ_FAILED: 'PIC_READ_FAILED',
  FIELD_PROJECTION_UNAVAILABLE: 'PIC_FIELD_PROJECTION_UNAVAILABLE',
  DB_UNAVAILABLE: 'PIC_DB_UNAVAILABLE'
});

class ParticipantIdentityCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParticipantIdentityCheckError';
    this.code = code;
    // R6：内部错误标记。用 Symbol 而非 code 前缀——外部异常可以伪造 code。
    this[INTERNAL_ERROR] = true;
  }
}

const deny = (code, message) => { throw new ParticipantIdentityCheckError(code, message); };
const isInternalError = e => Boolean(e && e[INTERNAL_ERROR] === true);

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
 * 受控键诊断构建（默认关闭路径不会调用）：
 * - 只对请求顶层键做**枚举**（Object.keys 不读取值、不触发 getter、不触碰 __proto__）；
 * - 候选键名按固定字典映射为固定标签（不回显原键名）；
 * - 其余未登记键只输出计数与键名长度分桶（固定边界）；
 * - 输出对象形状固定、总大小有界（≤ 数十字节级），截断以 truncated 标志表达；
 * - 绝不输出任意原键名、值或前后缀，不记录原始 event。
 */
function buildKeyDiagnostic(event) {
  const keys = Object.keys(Object(event));
  const buckets = {};
  for (const b of KEY_DIAGNOSTIC_LENGTH_BUCKETS) buckets[b.label] = 0;
  buckets[KEY_DIAGNOSTIC_OVERFLOW_LABEL] = 0;
  let otherKeyCount = 0;
  const candidateLabels = [];
  let truncated = false;
  for (const k of keys) {
    if (REQUEST_FIELDS.includes(k)) continue;
    const label = Object.prototype.hasOwnProperty.call(KEY_DIAGNOSTIC_CANDIDATES, k)
      ? KEY_DIAGNOSTIC_CANDIDATES[k]
      : null;
    if (typeof label === 'string') {
      if (!candidateLabels.includes(label)) {
        if (candidateLabels.length >= KEY_DIAGNOSTIC_MAX_LABELS) truncated = true;
        else candidateLabels.push(label);
      }
      continue;
    }
    otherKeyCount++;
    const len = k.length;
    let placed = false;
    for (const b of KEY_DIAGNOSTIC_LENGTH_BUCKETS) {
      if (len <= b.max) { buckets[b.label]++; placed = true; break; }
    }
    if (!placed) buckets[KEY_DIAGNOSTIC_OVERFLOW_LABEL]++;
  }
  return Object.freeze({
    schema: KEY_DIAGNOSTIC_SCHEMA,
    diagnosticScope: KEY_DIAGNOSTIC_SCOPE,
    otherKeyCount,
    otherKeyNameLengthBuckets: Object.freeze(buckets),
    candidateLabels: Object.freeze(candidateLabels),
    truncated
  });
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

  // 受控键诊断开关：缺省即关闭；非布尔配置一律拒绝（防手改绕过协议绑定）。
  if (config.keyDiagnostic !== undefined && typeof config.keyDiagnostic !== 'boolean') {
    deny(ERR_CODES.TARGET_MISMATCH, '诊断开关无效。');
  }
  const keyDiagnosticEnabled = config.keyDiagnostic === true;

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
    // R5：恰到截止即拒绝（now >= expires），与打包器口径统一。
    if (t >= config.windowExpiresAtMs) deny(ERR_CODES.WINDOW_EXPIRED, '核验窗口已截止。');
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

  /**
   * 请求键门槛仍为第一道检查（行为与既有事实一致：错口令+额外键等组合仍返回
   * PIC_REQUEST_INVALID）。onUnknownKey 仅在首个未登记键出现时被调用一次：
   * 由 handle 注入受控诊断收集器（其内部复核其余全部门槛，任何异常吞掉）。
   */
  function assertRequest(event, onUnknownKey) {
    const payload = event && typeof event === 'object' ? event : {};
    for (const k of Object.keys(payload)) {
      if (!REQUEST_FIELDS.includes(k)) {
        if (typeof onUnknownKey === 'function') onUnknownKey(payload);
        deny(ERR_CODES.REQUEST_INVALID, '请求含未登记字段：' + k);
      }
    }
    if (payload.action !== 'inspectSelf') {
      deny(ERR_CODES.ACTION_REJECTED, '本入口只提供本人身份只读核验（inspectSelf）。');
    }
    // R5：轮次必须由客户端逐层带回，缺失/空值/非字符串/不符一律在读取前拒绝。
    if (payload.checkRoundId === undefined || payload.checkRoundId === null || payload.checkRoundId === '') {
      deny(ERR_CODES.ROUND_REQUIRED, '缺少核验轮次。');
    }
    if (typeof payload.checkRoundId !== 'string') {
      deny(ERR_CODES.ROUND_REQUIRED, '核验轮次格式无效。');
    }
    if (payload.checkRoundId !== config.checkRoundId) {
      deny(ERR_CODES.ROUND_MISMATCH, '核验轮次与本窗口不一致。');
    }
    assertPassphrase(payload);
  }

  /**
   * 单次固定读取（R6 收紧）：
   * - 固定集合 + 固定主键 + **字段投影**（只取 _id/openid/status），不 list/where、
   *   不读其它集合、不跑事务；
   * - readAttempted 只在**实际调用 get() 之前**置真：集合/主键构造失败或无 get 方法时为 false；
   * - 外部异常一律净化为固定代码/文案，绝不透传原始 message 或未列举 code。
   */
  async function readRegistration(userId, openid, onGetAttempt) {
    let collection = null;
    let docRef = null;
    try {
      collection = db.collection(FIXED_TARGET.collection);
    } catch (_) {
      deny(ERR_CODES.DB_UNAVAILABLE, '固定测试集合不可用。');
    }
    if (!collection || typeof collection.doc !== 'function') {
      deny(ERR_CODES.DB_UNAVAILABLE, '固定测试集合不可用。');
    }
    try {
      docRef = collection.doc(userId);
    } catch (_) {
      deny(ERR_CODES.DB_UNAVAILABLE, '固定主键读取不可用。');
    }
    if (!docRef || typeof docRef.get !== 'function') {
      deny(ERR_CODES.DB_UNAVAILABLE, '固定主键读取不可用。');
    }
    // R6+S2 最小读取：**必须**用 field() 选择字段；筛选能力缺失/调用失败/返回无 get
    // 时保守返回 UNKNOWN 且**不发 get**——绝不回退读取整份用户记录
    //（读取范围最小化是任务硬性要求，不能用「响应投影」替代「读取范围最小化」）。
    if (typeof docRef.field !== 'function') {
      deny(ERR_CODES.FIELD_PROJECTION_UNAVAILABLE, '无法按最小字段范围读取（结果未知）。');
    }
    let queryRef = null;
    try {
      queryRef = docRef.field(READ_FIELD_PROJECTION);
    } catch (_) {
      deny(ERR_CODES.FIELD_PROJECTION_UNAVAILABLE, '无法按最小字段范围读取（结果未知）。');
    }
    if (!queryRef || typeof queryRef.get !== 'function') {
      deny(ERR_CODES.FIELD_PROJECTION_UNAVAILABLE, '无法按最小字段范围读取（结果未知）。');
    }
    // 到这里才置「已发起读取」——构造阶段失败保持 false。
    onGetAttempt();
    let response = null;
    try {
      response = await queryRef.get();
    } catch (_) {
      // 数据库错误/权限/超时：不得当作不存在，也不得回传原始异常
      deny(ERR_CODES.READ_FAILED, '读取本人测试账号记录失败（结果未知）。');
    }
    // 归一化读取结果（真实 SDK 转换 + 合成替身兼容）：
    // - 真实 wx-server-sdk 单文档 get()（入口以 throwOnNotFound:false 构造 database）：
    //   存在 → data 为【单个文档对象】；明确不存在 → data 为【null】；失败 → reject（上方 catch）。
    // - 合成替身/测试形状：data 为数组（0 条=不存在、1 条=命中、多条=不可采信）。
    let row = null;
    let explicitlyAbsent = false;
    if (response && response.data === null) {
      // 真实 SDK：明确无记录（throwOnNotFound=false 时的 data:null）
      explicitlyAbsent = true;
    } else if (response && Array.isArray(response.data)) {
      if (response.data.length === 0) {
        explicitlyAbsent = true; // 数组形状的明确无记录
      } else if (response.data.length === 1) {
        row = response.data[0];
      } else {
        // 多条：单文档读取不应出现，形状不可采信
        return { state: 'UNKNOWN', recordMatched: null };
      }
    } else if (response && response.data && typeof response.data === 'object') {
      row = response.data; // 真实 SDK：单文档对象
    } else {
      deny(ERR_CODES.READ_FAILED, '读取结果形状未知（结果未知）。');
    }
    if (explicitlyAbsent) {
      // 明确无记录（真实 SDK data:null 或数组形状空结果）
      return { state: 'ABSENT', recordMatched: null };
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { state: 'UNKNOWN', recordMatched: null };
    // R6：字段缺失属未知（形状不可采信），不是归属不符。
    if (!Object.prototype.hasOwnProperty.call(row, '_id') || row._id === undefined || row._id === null) {
      return { state: 'UNKNOWN', recordMatched: null };
    }
    if (!Object.prototype.hasOwnProperty.call(row, 'openid') || row.openid === undefined || row.openid === null) {
      return { state: 'UNKNOWN', recordMatched: null };
    }
    if (!Object.prototype.hasOwnProperty.call(row, 'status') || typeof row.status !== 'string') {
      return { state: 'UNKNOWN', recordMatched: null };
    }
    // 字段齐备但与当前上下文不一致 → 归属不符（绝不回传原值）
    if (row._id !== userId || row.openid !== openid) {
      return { state: 'MISMATCH', recordMatched: false };
    }
    if (row.status === ACTIVE_STATUS) return { state: 'ACTIVE', recordMatched: true };
    if (row.status === SUPPORTED_DISABLED_STATUS) return { state: 'DISABLED', recordMatched: true };
    // 未知 status：归 UNKNOWN
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
      // R2：完整内部 userId 仅在有效结果且显式请求时出现；默认缺省（不返回）。
      userId: null,
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
    const markGetAttempt = () => { readAttempted = true; };
    // 受控键诊断（默认关闭）：仅在 REQUEST_INVALID 路径上由 collectKeyDiagnostic 填充；
    // 其内部复核动作/轮次/口令/可信目标/当下窗口，全部通过才构建，任何异常吞掉。
    let keyDiagnostic = null;
    const collectKeyDiagnostic = payload => {
      if (!keyDiagnosticEnabled) return;
      try {
        if (payload.action !== 'inspectSelf') return;
        if (payload.checkRoundId !== config.checkRoundId) return;
        assertPassphrase(payload);
        assertTrustedTarget();
        assertWindowOpen();
        keyDiagnostic = buildKeyDiagnostic(payload);
      } catch (_) {
        keyDiagnostic = null; // 缺上下文/错轮次/错口令/过期/时钟异常/构建失败：诊断为空
      }
    };
    try {
      // 1) 请求与目标门槛（全部在数据库访问之前）
      assertRequest(event, collectKeyDiagnostic);
      assertTrustedTarget();
      assertWindowOpen();
      userId = deriveUserId(FIXED_TARGET.appId, trusted.openid);

      // 2) 至多一次固定集合/固定主键/最小字段投影读取
      const outcome = await readRegistration(userId, trusted.openid, markGetAttempt);

      // 3) 读后与成功返回前重读时钟；到期/无效即不可确认
      const serverNowMs = assertWindowOpen();

      // R2：受控完整 ID 交付。仅在「本次有效核验结果」且调用方显式请求时携带；
      // 与 checkRoundId + serverTimeIso 一起构成后续执行包可核对的绑定事实。
      // ABSENT/UNKNOWN 也可交付完整 ID（ABSENT 无落盘记录可反查，UNKNOWN 需人工核对）。
      const wantFullId = Boolean(event && typeof event === 'object' && event.includeFullUserId === true);
      const fullIdDeliverable = wantFullId && FULL_ID_STATES.includes(outcome.state);
      const result = baseResult({
        ok: true,
        identityConfirmed: true,
        registrationState: outcome.state,
        recordMatched: outcome.recordMatched,
        readAttempted: true,
        userIdTail: userIdTail(userId),
        serverTimeIso: new Date(serverNowMs).toISOString(),
        message: '本人身份只读核验完成。'
      });
      if (fullIdDeliverable) result.userId = userId;
      return result;
    } catch (error) {
      // R6：只输出白名单代码与固定文案；外部异常（含伪造 PIC_ code）一律净化。
      const internal = isInternalError(error);
      const code = internal && Object.prototype.hasOwnProperty.call(ERROR_PUBLIC_TEXT, error.code)
        ? error.code
        : GENERIC_CODE;
      // 失败结果不构成可采信绑定：不返回完整 userId，仅保留尾号（供人工核对）。
      const failure = baseResult({
        identityConfirmed: false,
        registrationState: 'UNKNOWN',
        recordMatched: null,
        readAttempted: readAttempted,
        userIdTail: userId ? userIdTail(userId) : '',
        code: code,
        message: internal ? ERROR_PUBLIC_TEXT[error.code] || GENERIC_TEXT : GENERIC_TEXT
      });
      // 受控键诊断：仅在 REQUEST_INVALID 且收集器全门槛复核通过后存在；
      // 不改变 UNKNOWN/PIC_REQUEST_INVALID 语义，不改变读取事实，默认关闭时字段缺席。
      if (keyDiagnostic !== null && code === ERR_CODES.REQUEST_INVALID) {
        failure.keyDiagnostic = keyDiagnostic;
      }
      return failure;
    }
  }

  return Object.freeze({ handle, readNowMs, FIXED_TARGET, ALLOWED_ACTIONS, REGISTRATION_STATES });
}

module.exports = Object.freeze({
  FIXED_TARGET,
  ALLOWED_ACTIONS,
  REGISTRATION_STATES,
  REQUEST_FIELDS,
  FULL_ID_STATES,
  READ_FIELD_PROJECTION,
  ERROR_PUBLIC_TEXT,
  GENERIC_CODE,
  RESULT_SCHEMA,
  ERR_CODES,
  KEY_DIAGNOSTIC_SCHEMA,
  KEY_DIAGNOSTIC_SCOPE,
  KEY_DIAGNOSTIC_CANDIDATES,
  KEY_DIAGNOSTIC_MAX_LABELS,
  KEY_DIAGNOSTIC_LENGTH_BUCKETS,
  MAX_WINDOW_MS: 30 * 60 * 1000,
  ParticipantIdentityCheckError,
  createIdentityChecker,
  buildKeyDiagnostic,
  deriveUserId,
  userIdTail
});