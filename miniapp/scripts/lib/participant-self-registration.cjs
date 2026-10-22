'use strict';
// 独立参与者本人登记核心（participant-self-registration/1）。
//
// 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §4；方案 §4；
// 返修：docs/Codex复查-指定本人登记与私密输入本地实现-20261021.md §2 R1/R2/R3。
// 设计边界（不得放宽）：
// - 每包只允许一个完整允许账号（config.allowedAccount）；可信微信身份只取注入的
//   getWXContext 结果（trusted），派生 u_+sha256(APPID+':'+OPENID)[0:40] 并与其精确
//   匹配；尾号只辅助查错，不作为身份校验。
// - 全部准入检查（协议/动作/轮次/口令摘要/时钟结构/窗口/身份/允许账号）发生在数据库
//   工厂（dbFactory → db.collection / db.runTransaction）之前；非名单账号零工厂零事务零写。
//   数据库工厂以 dbFactory 注入，仅在准入全部通过后调用一次（R1）。
// - 时钟结构校验（异常/非有限数）在合成与真实模式一律生效；真实模式另受窗口开始/截止
//   约束。复核点：handle 入口、每次事务回调入口、每次写前、回读后最终返回前（R1）。
// - 仅固定两集合两主键：本人用户（users 集合，主键=完整允许账号）与确定性登记审计
//   （audit 集合，主键=a_reg_+sha256('participant-self-registration/1:'+appId+':'+envId+':'+完整userId)[0:40]）。
//   不 list/where，不读写项目/邀请/成员/管理员，不加载通用 identify/execute。
// - 事务接口使用真实 wx-server-sdk 3.0.1 支持的形状（R2）：transaction.collection(name)
//   → .doc(id).get()（事务内返回 {data: 文档|null}）与 .add({data})（insertDocument 原子
//   新增，支持显式 _id）；不使用 set 覆盖，不杜撰 SDK 方法。冲突重试由 SDK
//   runTransaction(callback, times) 内建；回调内不做外部副作用且每次重试全部重查。
// - 用户与审计必须同事务原子新增；已有有效用户零新增且不补写/不修复审计；
//   停用/缺字段/主体（openid 绑定）不符/孤立或冲突审计一律停止；禁用 set 覆盖。
//   审计轮次为历史合法登记轮次时视为既有有效登记（不因换轮补写/覆盖/误判，R3）。
// - 回读使用冻结投影（doc.field(固定投影).get()），校验冻结字段集/类型/主键/可信
//   openid/主体/动作/状态；回读不确定不得报有效（R3）。
// - 写前失败（REJECTED_NO_WRITE）与已提交后未知（OUTCOME_UNKNOWN）严格区分：
//   保留 writeAttempted/commitConfirmed 等真实事实，已知未提交才可称零写；
//   提交后超时/回读失败/返回前时钟复核失败不自动重试、不误报零写或成功；
//   已尝试写后失败保留实际提交事实（R1）。
// - 响应净化：registrationRoundId 恒为本服务端配置轮次（不回填客户端请求值，R3）；
//   SDK/传输错误码白名单净化（非白名单一律 PIC_TRANSACTION_FAILED，不外泄，R3）；
//   不输出 OPENID、完整允许账号、口令、原始 SDK 错误与堆栈。

const crypto = require('node:crypto');

const SELF_REG_SCHEMA = 'participant-self-registration/1';
const REQUEST_PROTOCOL = 'participant-self-registration-request/1';
const RESULT_SCHEMA = 'participant-self-registration-result/1';
const ACTION = 'registerSelf';
const AUDIT_ID_PREFIX = 'a_reg_';
const AUDIT_SEED = 'participant-self-registration/1';
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const ACCOUNT_RE = /^u_[0-9a-f]{40}$/;
// 用户与审计字段的最小完整集（兼容既有业务结构：_id/openid/status/createdAt/updatedAt；
// 审计：_id/projectId/actorUserId/actorRole/action/subjectUserId/before/after/createdAt）
const USER_REQUIRED_FIELDS = Object.freeze(['_id', 'openid', 'status', 'createdAt', 'updatedAt']);
const AUDIT_REQUIRED_FIELDS = Object.freeze(['_id', 'projectId', 'actorUserId', 'actorRole', 'action', 'subjectUserId', 'before', 'after', 'createdAt']);
// 受控附加字段（来源绑定，冻结写入；消费者按既有结构读取其余字段不受影响）
const SOURCE_PROTOCOL_FIELD = 'sourceProtocol';
const REGISTRATION_ROUND_FIELD = 'registrationRoundId';
// 回读冻结投影（R3：强制投影，不做整文档回退读取）
const USER_READBACK_PROJECTION = Object.freeze({ _id: 1, openid: 1, status: 1, createdAt: 1, updatedAt: 1 });
const AUDIT_READBACK_PROJECTION = Object.freeze({
  _id: 1, projectId: 1, actorUserId: 1, actorRole: 1, action: 1,
  subjectUserId: 1, before: 1, after: 1, createdAt: 1,
  [SOURCE_PROTOCOL_FIELD]: 1, [REGISTRATION_ROUND_FIELD]: 1
});
// 本核心自有错误码白名单（R3：非白名单 SDK/传输错误码一律净化）
const OWN_ERROR_CODES = Object.freeze(new Set([
  'PIC_REQUEST_INVALID', 'PIC_ROUND_MISMATCH', 'PIC_PASSPHRASE_MISMATCH',
  'PIC_NOT_ALLOWED', 'PIC_CLOCK_INVALID', 'PIC_CLOCK_ERROR', 'PIC_WINDOW_EXPIRED', 'PIC_WINDOW_NOT_OPEN',
  'PIC_AUDIT_CONFLICT', 'PIC_USER_CONFLICT', 'PIC_DB_FACTORY_UNAVAILABLE', 'PIC_TRANSACTION_FAILED',
  'PIC_RECORD_MALFORMED', 'PIC_OUTCOME_UNKNOWN'
]));

// R1：窗口最长时长上限（毫秒）。配置侧（打包器）约束更严；此处为核心失败闭合上限。
const MAX_WINDOW_MS = 30 * 60 * 1000;
// R1：固定集合（核心配置失败闭合——不依赖打包器约束）
const FIXED_USERS_COLLECTION = 'schtest_v1_users';
const FIXED_AUDIT_COLLECTION = 'schtest_v1_audit_events';

const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const tailOf = v => (typeof v === 'string' && v.length >= 6 ? v.slice(-6) : '');

/** 确定性登记审计主键（方案 §4.2；表达式被测试与证据锁定）。 */
function deriveRegistrationAuditId(appId, envId, fullUserId) {
  return AUDIT_ID_PREFIX + sha256(AUDIT_SEED + ':' + appId + ':' + envId + ':' + fullUserId).slice(0, 40);
}

/** 可信微信身份派生：u_+sha256(APPID+':'+OPENID)[0:40]。 */
function deriveUserId(appId, openid) {
  return 'u_' + sha256(appId + ':' + openid).slice(0, 40);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 创建本人登记检查器（依赖注入：dbFactory/trusted/config/now）。
 * - dbFactory：返回真实 wx-server-sdk 形状数据库的工厂（collection(name).doc(id).get()/
 *   .field(p).get()、collection(name).add({data})、runTransaction(cb)）。仅在全部准入
 *   通过后由 handle 调用一次（R1）；准入拒绝时零工厂零事务零写。
 * - trusted：{ appId, envId, OPENID }（仅来自 cloud.getWXContext 及受审运行环境）。
 * - config：{ registrationRoundId, passphraseDigest, allowedAccount, windowStartsAtMs,
 *   windowExpiresAtMs, usersCollection, auditCollection, sourceProtocol, synthetic }。
 * - now：受审时钟（入口/事务回调入口/每次写前/回读后最终返回前复核）。
 */
function createSelfRegistrationChecker({ dbFactory, trusted, config, now }) {
  if (!isPlainObject(trusted) || !isPlainObject(config) || typeof now !== 'function') {
    return invalid('运行环境配置无效');
  }
  if (typeof dbFactory !== 'function') {
    return invalid('数据库工厂配置无效');
  }
  const state = { clock: now };
  /**
   * 时钟复核（R1）：结构校验（异常/非有限数）在合成与真实模式一律生效；
   * 真实模式另查开始（now<starts）与截止（now>=expires）；合成模式只跳过窗口比较。
   */
  const clockCheck = at => {
    let t;
    try { t = state.clock(); } catch (e) { return { ok: false, code: 'PIC_CLOCK_ERROR', at }; }
    if (typeof t !== 'number' || !Number.isFinite(t)) return { ok: false, code: 'PIC_CLOCK_INVALID', at };
    if (config.synthetic !== true) {
      if (t < config.windowStartsAtMs) return { ok: false, code: 'PIC_WINDOW_NOT_OPEN', at };
      if (t >= config.windowExpiresAtMs) return { ok: false, code: 'PIC_WINDOW_EXPIRED', at };
    }
    return { ok: true, now: t };
  };

  function invalid(message) {
    return {
      schema: RESULT_SCHEMA, outcome: 'REJECTED_NO_WRITE', code: 'PIC_REQUEST_INVALID',
      registrationRoundId: null, userIdTail: null, writeAttempted: false, commitConfirmed: false,
      readBack: { user: false, audit: false }, message
    };
  }

  // 错误码白名单净化（R3：SDK/传输原始错误码不外泄）
  const safeCode = e => (e && typeof e.code === 'string' && OWN_ERROR_CODES.has(e.code)) ? e.code : 'PIC_TRANSACTION_FAILED';

  const malformed = () => { const e = new Error('记录形状畸形（缺 data/多条/非对象），不能当作不存在'); e.code = 'PIC_RECORD_MALFORMED'; return e; };

  /**
   * R3：事务内读取（真实 SDK 事务形状 {data: 文档|null}）。
   * 明确不存在仅接受 data===null；缺 data、data 为数组/原始值/多条均属畸形 → 抛错停止，
   * 不得当作不存在进入新增分支。
   */
  const docOfTx = snap => {
    if (!isPlainObject(snap) || !Object.prototype.hasOwnProperty.call(snap, 'data')) throw malformed();
    const d = snap.data;
    if (d === null) return null;
    if (isPlainObject(d)) return d;
    throw malformed();
  };

  /**
   * R3：回读读取（已确认的两种 SDK 形状）：
   * - wx 包装非事务 get（含 field 投影）：{data: 文档|null}（throwOnNotFound:false 时未命中=data:null）；
   * - @cloudbase/database 内层投影 get：{data: [文档...]}（空数组=明确不存在）。
   * 多条、缺 data、元素非对象=畸形 → 抛错（回读失败按未知处理，不得当作不存在或有效）。
   */
  const docOfReadback = snap => {
    if (!isPlainObject(snap) || !Object.prototype.hasOwnProperty.call(snap, 'data')) throw malformed();
    const d = snap.data;
    if (d === null) return null; // wx 包装形状：明确不存在
    if (Array.isArray(d)) {
      if (d.length === 0) return null; // 内层投影形状：明确不存在
      if (d.length > 1) throw malformed();
      if (d[0] === null || !isPlainObject(d[0])) throw malformed();
      return d[0];
    }
    if (isPlainObject(d)) return d; // wx 包装形状：存在
    throw malformed();
  };

  /** R3：合法 ISO 8601 时间字符串（可解析且有限；date-only 亦合法，垃圾串必然 NaN）。 */
  const isIsoTime = v => typeof v === 'string' && Number.isFinite(Date.parse(v))
    && new Date(Date.parse(v)).toISOString() === v;

  /** R3：用户记录完整校验（事务内与回读统一）：字段集/类型/主键/主体/状态/时间。 */
  function userWellFormed(user, derivedUserId, openid) {
    return Boolean(user
      && USER_REQUIRED_FIELDS.every(f => Object.prototype.hasOwnProperty.call(user, f))
      && user._id === derivedUserId
      && typeof user.openid === 'string' && user.openid === openid
      && user.status === 'active'
      && isIsoTime(user.createdAt) && isIsoTime(user.updatedAt)
      && Date.parse(user.updatedAt) >= Date.parse(user.createdAt));
  }

  /** 审计既有记录的结构与绑定校验（R3）：字段集/类型/主键/主体/动作/协议/角色/时间/after 状态。 */
  function auditWellFormed(audit, auditId, derivedUserId) {
    return Boolean(audit && AUDIT_REQUIRED_FIELDS.every(f => Object.prototype.hasOwnProperty.call(audit, f))
      && audit._id === auditId
      && audit.projectId === null && audit.before === null
      && audit.action === 'registerIdentity'
      && audit.subjectUserId === derivedUserId && audit.actorUserId === derivedUserId
      && audit.actorRole === '本人普通账号'
      && isIsoTime(audit.createdAt)
      && isPlainObject(audit.after) && Object.keys(audit.after).join(',') === 'status' && audit.after.status === 'active'
      && audit[SOURCE_PROTOCOL_FIELD] === SELF_REG_SCHEMA
      && typeof audit[REGISTRATION_ROUND_FIELD] === 'string'
      && ROUND_ID_RE.test(audit[REGISTRATION_ROUND_FIELD]));
  }

  /**
   * 处理一次登记请求（request 已由适配器净化为三字段对象）。
   * 返回净化结果；registrationRoundId 恒为本服务端配置轮次；
   * 绝不外露 OPENID/完整允许账号/口令/非白名单 SDK 错误码。
   */
  async function handle(request) {
    // ── 准入检查（全部在数据库工厂之前）─────────────────────────────────────
    if (!isPlainObject(request)) return invalid('请求参数无效');
    if (request.action !== ACTION) return invalid('本客户端只提供本人登记动作');
    if (typeof request.registrationRoundId !== 'string' || !ROUND_ID_RE.test(request.registrationRoundId)) {
      return invalid('登记轮次格式无效');
    }
    if (typeof request.passphrase !== 'string' || request.passphrase.length === 0) return invalid('口令缺失');
    // 目标绑定（受审固定值；trusted 只来自 getWXContext 及受审运行环境）
    if (trusted.appId !== 'wxfb4db1615ac15531' || trusted.envId !== 'cloud1-d8gcq5ag39d847723') {
      return invalid('运行环境与受审固定目标不一致');
    }
    if (typeof trusted.OPENID !== 'string' || trusted.OPENID.length === 0) return invalid('缺少可信微信身份');
    if (config.sourceProtocol !== SELF_REG_SCHEMA) return invalid('登记来源协议不符');
    if (typeof config.synthetic !== 'boolean') return invalid('合成标记必须为布尔值');
    // ── R1：核心配置失败闭合（工厂前；不依赖打包器约束，不依靠 NaN 比较结果）────
    if (config.usersCollection !== FIXED_USERS_COLLECTION || config.auditCollection !== FIXED_AUDIT_COLLECTION) {
      return invalid('固定集合配置不符');
    }
    if (!Number.isFinite(config.windowStartsAtMs) || !Number.isFinite(config.windowExpiresAtMs)) {
      return invalid('窗口边界必须为有限数值');
    }
    if (!(config.windowStartsAtMs < config.windowExpiresAtMs)) return invalid('窗口起止顺序无效');
    if (config.windowExpiresAtMs - config.windowStartsAtMs > MAX_WINDOW_MS) return invalid('窗口时长超过上限');
    if (typeof config.allowedAccount !== 'string' || !ACCOUNT_RE.test(config.allowedAccount)) return invalid('允许账号配置格式无效');
    if (typeof config.passphraseDigest !== 'string' || !/^[0-9a-f]{64}$/.test(config.passphraseDigest)) return invalid('口令摘要配置无效');
    if (typeof config.registrationRoundId !== 'string' || !ROUND_ID_RE.test(config.registrationRoundId)) return invalid('登记轮次配置无效');
    // 时钟结构校验（合成/真实一律生效）；真实模式另查窗口开始/截止（R1：开始时间闭合）
    {
      const c = clockCheck('handle.start');
      if (!c.ok) {
        const r = { ...invalid('窗口时效检查未通过'), code: c.code };
        r.registrationRoundId = config.registrationRoundId;
        return r;
      }
    }
    if (request.registrationRoundId !== config.registrationRoundId) {
      // R3：registrationRoundId 恒为本服务端配置轮次（不回填客户端请求值）
      const r = { ...invalid('登记轮次与本包配置不一致'), code: 'PIC_ROUND_MISMATCH', registrationRoundId: config.registrationRoundId };
      r.userIdTail = tailOf(deriveUserId(trusted.appId, trusted.OPENID));
      return r;
    }
    if (sha256(request.passphrase) !== config.passphraseDigest) {
      const r = { ...invalid('口令校验未通过'), code: 'PIC_PASSPHRASE_MISMATCH', registrationRoundId: config.registrationRoundId };
      r.userIdTail = tailOf(deriveUserId(trusted.appId, trusted.OPENID));
      return r;
    }
    // 身份派生与允许账号精确匹配（尾号不能替代）
    const derivedUserId = deriveUserId(trusted.appId, trusted.OPENID);
    if (!ACCOUNT_RE.test(derivedUserId)) return invalid('派生身份格式无效');
    if (config.allowedAccount !== derivedUserId) {
      const r = { ...invalid('当前微信身份不在本包允许名单'), code: 'PIC_NOT_ALLOWED', registrationRoundId: config.registrationRoundId };
      r.userIdTail = tailOf(derivedUserId);
      return r;
    }
    const usersCollection = config.usersCollection;
    const auditCollection = config.auditCollection;
    const auditId = deriveRegistrationAuditId(trusted.appId, trusted.envId, derivedUserId);
    const userTail = tailOf(derivedUserId);

    // ── 数据库工厂（R1：准入全部通过后才调用恰一次）──────────────────────────
    let db;
    try {
      db = dbFactory();
      if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
        throw new Error('bad db');
      }
    } catch (e) {
      const r = invalid('数据库工厂不可用，未写入');
      r.code = 'PIC_DB_FACTORY_UNAVAILABLE';
      r.registrationRoundId = config.registrationRoundId;
      return r;
    }
    const usersCol = db.collection(usersCollection);
    const auditCol = db.collection(auditCollection);
    const userRef = usersCol.doc(derivedUserId);
    const auditRef = auditCol.doc(auditId);

    const fact = { writeAttempted: false, commitConfirmed: false, createsIssued: 0 };
    const serverNowIso = () => new Date(state.clock()).toISOString();

    let commitError = null;
    let txnOutcome = null; // 事务回调的即时分类（每次重试覆盖，不残留，R3）
    try {
      await db.runTransaction(async transaction => {
        // 每次回调重置本次分类（SDK 自动重试时分类不残留上次结果，R3）
        txnOutcome = null;
        // 事务回调入口复核时钟（真实模式受窗口约束；结构校验一律生效）
        {
          const c = clockCheck('transaction.callback');
          if (!c.ok) { const e = new Error('窗口时效检查未通过'); e.code = c.code; throw e; }
        }
        // R2：真实 SDK 事务接口 —— transaction.collection(name).doc(id).get() /
        // transaction.collection(name).add({data})
        const usersTx = transaction.collection(usersCollection);
        const auditTx = transaction.collection(auditCollection);
        const userSnap = await usersTx.doc(derivedUserId).get();
        const auditSnap = await auditTx.doc(auditId).get();
        // R3：明确不存在仅接受事务形状 data===null；缺 data/多条/非对象畸形 → 抛错停止（不进入新增）
        const user = docOfTx(userSnap);
        const audit = docOfTx(auditSnap);
        const nowIso = serverNowIso();
        // 用户有效性：字段集/类型/主键/可信 openid 主体绑定/状态/时间（R3：事务与回读统一）
        const userValid = userWellFormed(user, derivedUserId, trusted.OPENID);
        if (userValid && !audit) {
          // 已有有效用户、本包审计不存在 → ALREADY_ACTIVE，零新增，不补审计
          // （回读要求：仅用户存在即可；审计本就不存在，readBack.audit=false 属实）
          txnOutcome = 'ALREADY_ACTIVE_NO_AUDIT';
          return { outcome: 'ALREADY_ACTIVE', created: [] };
        }
        if (userValid && audit) {
          // 均存在：结构+绑定校验（R3：AUDIT_REQUIRED_FIELDS 实际用于检查）。
          // 审计轮次为历史合法登记轮次时视为既有有效登记（R3：不因换轮误判/补写/覆盖）。
          if (!auditWellFormed(audit, auditId, derivedUserId)) {
            const e = new Error('既有登记审计与本包绑定冲突'); e.code = 'PIC_AUDIT_CONFLICT'; throw e;
          }
          txnOutcome = 'ALREADY_ACTIVE';
          return { outcome: 'ALREADY_ACTIVE', created: [] };
        }
        if (!user && audit) { const e = new Error('审计存在而用户缺失，不修复'); e.code = 'PIC_AUDIT_CONFLICT'; throw e; }
        if (user && !userValid) { const e = new Error('既有用户状态或主体不符，不激活不覆盖'); e.code = 'PIC_USER_CONFLICT'; throw e; }
        if (user) { const e = new Error('既有用户无法判定'); e.code = 'PIC_USER_CONFLICT'; throw e; }
        // 原子新增用户与登记审计（恰 2 条）。
        // writeAttempted 在首次写调用前置位：写一旦开始，提交状态即不再可判定为零写。
        {
          const cw = clockCheck('transaction.write.user');
          if (!cw.ok) { const e = new Error('窗口时效检查未通过'); e.code = cw.code; throw e; }
        }
        fact.writeAttempted = true;
        await usersTx.add({ data: {
          _id: derivedUserId, openid: trusted.OPENID, status: 'active', createdAt: nowIso, updatedAt: nowIso
        } });
        fact.createsIssued += 1;
        {
          const cw = clockCheck('transaction.write.audit');
          if (!cw.ok) { const e = new Error('窗口时效检查未通过'); e.code = cw.code; throw e; }
        }
        await auditTx.add({ data: {
          _id: auditId, projectId: null, actorUserId: derivedUserId, actorRole: '本人普通账号',
          action: 'registerIdentity', subjectUserId: derivedUserId, before: null, after: { status: 'active' },
          createdAt: nowIso,
          [SOURCE_PROTOCOL_FIELD]: SELF_REG_SCHEMA,
          [REGISTRATION_ROUND_FIELD]: config.registrationRoundId
        } });
        fact.createsIssued += 1;
        return { outcome: 'CREATED_PENDING_COMMIT', created: ['user', 'audit'] };
      });
      fact.commitConfirmed = true;
    } catch (e) {
      commitError = e;
    }

    const base = {
      schema: RESULT_SCHEMA, registrationRoundId: config.registrationRoundId,
      userIdTail: userTail, auditIdTail: tailOf(auditId),
      writeAttempted: fact.writeAttempted, commitConfirmed: fact.commitConfirmed,
      readBack: { user: false, audit: false }
    };

    // 事务回调在未发出任何写之前失败 → REJECTED_NO_WRITE（可判定零写）。
    // R3：错误码白名单净化——非本核心自有码一律 PIC_TRANSACTION_FAILED，不外泄。
    if (commitError && !fact.writeAttempted) {
      const code = safeCode(commitError);
      const messages = {
        PIC_AUDIT_CONFLICT: '既有登记审计冲突或孤立，不修复不覆盖',
        PIC_USER_CONFLICT: '既有用户状态或主体不符，不激活不覆盖',
        PIC_WINDOW_EXPIRED: '窗口已截止，未写入',
        PIC_WINDOW_NOT_OPEN: '窗口未开始，未写入',
        PIC_CLOCK_INVALID: '时钟无效，未写入',
        PIC_CLOCK_ERROR: '时钟异常，未写入',
        PIC_RECORD_MALFORMED: '既有记录形状畸形（缺 data/多条/非对象），不能判定存在性，未写入',
        PIC_TRANSACTION_FAILED: '登记事务未开始写入'
      };
      return Object.assign(base, {
        outcome: 'REJECTED_NO_WRITE', code,
        message: messages[code] || '登记事务未开始写入'
      });
    }

    // 已尝试写后失败/提交后返回前时钟复核失败 → OUTCOME_UNKNOWN（R1：保留实际提交事实）
    if (commitError && fact.writeAttempted) {
      return Object.assign(base, {
        outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
        message: '事务回调在写入开始后失败：提交状态未知，不自动重试，请以关闭回读核实'
      });
    }

    // 提交后同请求内按固定主键回读本人用户与确定性审计（冻结投影，R3：强制投影）
    try {
      const [userSnap, auditSnap] = await Promise.all([
        Promise.resolve(usersCol.doc(derivedUserId).field(USER_READBACK_PROJECTION).get()),
        Promise.resolve(auditCol.doc(auditId).field(AUDIT_READBACK_PROJECTION).get())
      ]);
      // R3：回读形状严格化——空数组=明确不存在；多条/缺 data/非对象=畸形 → 抛错按未知
      const user = docOfReadback(userSnap);
      const audit = docOfReadback(auditSnap);
      // 回读事实与事务内统一：完整字段集/类型/时间/主键/主体/状态（R3：投影有字段不等于记录有效）
      base.readBack.user = userWellFormed(user, derivedUserId, trusted.OPENID);
      base.readBack.audit = auditWellFormed(audit, auditId, derivedUserId);
    } catch (e) {
      return Object.assign(base, {
        outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
        message: '回读失败：提交状态待核实，不自动重试'
      });
    }

    // 回读后最终返回前时钟复核（R1）：失败保留提交事实，结果待核实
    {
      const c = clockCheck('readback.final');
      if (!c.ok) {
        // 零新增路径（ALREADY）：未写可安全拒绝；已提交路径保留事实报未知
        if (txnOutcome === 'ALREADY_ACTIVE') {
          return Object.assign(base, {
            outcome: 'REJECTED_NO_WRITE', code: c.code,
            message: '返回前时钟复核未通过：本包零新增'
          });
        }
        return Object.assign(base, {
          outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
          message: '回读后时钟复核未通过：提交状态待核实，不自动重试'
        });
      }
    }

    if (txnOutcome === 'ALREADY_ACTIVE_NO_AUDIT') {
      // R3：ALREADY（无本包审计）以用户回读事实确认为前提；审计本就不存在
      if (base.readBack.user) {
        return Object.assign(base, {
          outcome: 'ALREADY_ACTIVE', code: null,
          message: '本人账号已有效存在（无本包审计），本包零新增（不伪造本包创建回执）'
        });
      }
      return Object.assign(base, {
        outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
        message: '既有有效判定与回读事实不一致：状态待核实，不自动重试'
      });
    }
    if (txnOutcome === 'ALREADY_ACTIVE') {
      // R3：ALREADY（含本包审计）必须以双记录回读事实确认为前提
      if (base.readBack.user && base.readBack.audit) {
        return Object.assign(base, {
          outcome: 'ALREADY_ACTIVE', code: null,
          message: '本人账号已有效存在，本包零新增（不伪造本包创建回执）'
        });
      }
      return Object.assign(base, {
        outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
        message: '既有有效判定与回读事实不一致：状态待核实，不自动重试'
      });
    }
    if (base.readBack.user && base.readBack.audit) {
      return Object.assign(base, {
        outcome: 'CREATED_AND_VERIFIED', code: null, created: true,
        message: '本人用户与登记审计已同事务新增并回读通过'
      });
    }
    // 事务提交但回读未确认两条记录：按未知处理（不伪称新增成功，R3）
    return Object.assign(base, {
      outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
      message: '提交后回读未确认本人用户与登记审计：状态待核实，不自动重试'
    });
  }

  return Object.freeze({ handle, schema: SELF_REG_SCHEMA, action: ACTION, deriveRegistrationAuditId, deriveUserId });
}

module.exports = Object.freeze({
  SELF_REG_SCHEMA,
  REQUEST_PROTOCOL,
  RESULT_SCHEMA,
  ACTION,
  ROUND_ID_RE,
  ACCOUNT_RE,
  USER_REQUIRED_FIELDS,
  AUDIT_REQUIRED_FIELDS,
  USER_READBACK_PROJECTION,
  AUDIT_READBACK_PROJECTION,
  SOURCE_PROTOCOL_FIELD,
  REGISTRATION_ROUND_FIELD,
  deriveRegistrationAuditId,
  deriveUserId,
  createSelfRegistrationChecker
});
