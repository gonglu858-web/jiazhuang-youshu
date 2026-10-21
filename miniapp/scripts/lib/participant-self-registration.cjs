'use strict';
// 独立参与者本人登记核心（participant-self-registration/1）。
//
// 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §4；方案 §4。
// 设计边界（不得放宽）：
// - 每包只允许一个完整允许账号（config.allowedAccount）；可信微信身份只取注入的
//   getWXContext 结果（trusted），派生 u_+sha256(APPID+':'+OPENID)[0:40] 并与其精确
//   匹配；尾号只辅助查错，不作为身份校验。
// - 全部准入检查（协议/动作/轮次/口令摘要/窗口/身份/允许账号）发生在数据库工厂
//   （db.collection / db.runTransaction）之前；非名单账号零工厂零事务零写。
// - 仅固定两集合两主键：本人用户（users 集合，主键=完整允许账号）与确定性登记审计
//   （audit 集合，主键=a_reg_+sha256('participant-self-registration/1:'+appId+':'+envId+':'+完整userId)[0:40]）。
//   不 list/where，不读写项目/邀请/成员/管理员，不加载通用 identify/execute。
// - 用户与审计必须同事务原子新增；已有有效用户零新增且不补写/不修复审计；
//   disabled/缺字段/主体不符/孤立或冲突审计一律停止；禁用 set 覆盖。
// - 并发由确定性主键+事务保证最终至多一组新增；SDK 事务回调自动重试时每次都复核
//   时钟与记录，回调内不做任何外部副作用。
// - 写前失败（REJECTED_NO_WRITE）与已提交后未知（OUTCOME_UNKNOWN）严格区分：
//   保留 writeAttempted/commitConfirmed 等真实事实，已知未提交才可称零写；
//   提交后超时/回读失败不自动重试、不误报零写或成功。
// - 响应净化：不输出 OPENID、完整允许账号、口令、原始 SDK 错误与堆栈。

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
 * 创建本人登记检查器（依赖注入：db/trusted/config/now）。
 * - db：合成或真实 wx-server-sdk 形状（collection(name).doc(id)、runTransaction(cb)）。
 * - trusted：{ appId, envId, OPENID }（仅来自 cloud.getWXContext 及受审运行环境）。
 * - config：{ registrationRoundId, passphraseDigest, allowedAccount, windowStartsAtMs,
 *   windowExpiresAtMs, usersCollection, auditCollection, sourceProtocol }。
 * - now：受审时钟（入口/事务回调入口/每次写前/返回前复核）。
 */
function createSelfRegistrationChecker({ db, trusted, config, now }) {
  if (!isPlainObject(trusted) || !isPlainObject(config) || typeof now !== 'function') {
    return invalid('运行环境配置无效');
  }
  const state = { clock: now };
  const clockCheck = at => {
    let t;
    try { t = state.clock(); } catch (e) { return { ok: false, code: 'PIC_CLOCK_ERROR', at }; }
    if (typeof t !== 'number' || !Number.isFinite(t)) return { ok: false, code: 'PIC_CLOCK_INVALID', at };
    if (t >= config.windowExpiresAtMs) return { ok: false, code: 'PIC_WINDOW_EXPIRED', at };
    return { ok: true, now: t };
  };

  function invalid(message) {
    return {
      schema: RESULT_SCHEMA, outcome: 'REJECTED_NO_WRITE', code: 'PIC_REQUEST_INVALID',
      registrationRoundId: null, userIdTail: null, writeAttempted: false, commitConfirmed: false,
      readBack: { user: false, audit: false }, message
    };
  }

  /**
   * 处理一次登记请求（request 已由适配器净化为三字段对象）。
   * 返回净化结果；绝不外露 OPENID/完整允许账号/口令/原始 SDK 错误。
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
    if (request.registrationRoundId !== config.registrationRoundId) {
      const r = { ...invalid('登记轮次与本包配置不一致'), code: 'PIC_ROUND_MISMATCH', registrationRoundId: request.registrationRoundId };
      r.userIdTail = tailOf(deriveUserId(trusted.appId, trusted.OPENID));
      return r;
    }
    if (sha256(request.passphrase) !== config.passphraseDigest) {
      const r = { ...invalid('口令校验未通过'), code: 'PIC_PASSPHRASE_MISMATCH' };
      r.userIdTail = tailOf(deriveUserId(trusted.appId, trusted.OPENID));
      return r;
    }
    // 时钟（入口复核；真实模式才受窗口约束，合成模式跳过时效但保留 NaN/异常拒绝）
    if (!config.synthetic) {
      const c = clockCheck('entry');
      if (!c.ok) return { ...invalid('窗口时效检查未通过'), code: c.code };
    }
    // 身份派生与允许账号精确匹配（尾号不能替代）
    const derivedUserId = deriveUserId(trusted.appId, trusted.OPENID);
    if (!ACCOUNT_RE.test(derivedUserId)) return invalid('派生身份格式无效');
    if (config.allowedAccount !== derivedUserId) {
      const r = { ...invalid('当前微信身份不在本包允许名单'), code: 'PIC_NOT_ALLOWED' };
      r.userIdTail = tailOf(derivedUserId);
      return r;
    }
    const usersCollection = config.usersCollection;
    const auditCollection = config.auditCollection;
    const auditId = deriveRegistrationAuditId(trusted.appId, trusted.envId, derivedUserId);
    const userTail = tailOf(derivedUserId);

    // ── 数据库工厂与事务（准入全部通过后才触达）────────────────────────────
    let usersCol, auditCol;
    try {
      usersCol = db.collection(usersCollection);
      auditCol = db.collection(auditCollection);
    } catch (e) {
      const r = invalid('数据库工厂不可用，未写入');
      r.code = 'PIC_DB_FACTORY_UNAVAILABLE';
      return r;
    }
    const userRef = usersCol.doc(derivedUserId);
    const auditRef = auditCol.doc(auditId);

    const fact = { writeAttempted: false, commitConfirmed: false, callbackThrows: false, createsIssued: 0 };
    const serverNowIso = () => new Date(state.clock()).toISOString();
    let txnRead = { user: null, audit: null };

    let commitError = null;
    let txnOutcome = null; // 事务回调的即时分类（ALREADY_ACTIVE 零新增 / CREATED_PENDING_COMMIT）
    try {
      await db.runTransaction(async transaction => {
        // 事务回调入口复核时钟（SDK 自动重试每次都会重新执行本回调）
        if (!config.synthetic) {
          const c = clockCheck('transaction.callback');
          if (!c.ok) { const e = new Error('窗口时效检查未通过'); e.code = c.code; throw e; }
        }
        const userSnap = await transaction.get(userRef);
        const auditSnap = await transaction.get(auditRef);
        const user = userSnap && userSnap.data ? userSnap.data : null;
        const audit = auditSnap && auditSnap.data ? auditSnap.data : null;
        txnRead = { user, audit };
        const nowIso = serverNowIso();
        const userValid = user && USER_REQUIRED_FIELDS.every(f => Object.prototype.hasOwnProperty.call(user, f))
          && user._id === derivedUserId && typeof user.openid === 'string' && user.openid.length > 0
          && user.status === 'active';
        if (userValid && !audit) {
          // 矩阵第 2 行：已有有效用户、本包审计不存在 → ALREADY_ACTIVE，零新增，不补审计
          txnOutcome = 'ALREADY_ACTIVE';
          return { outcome: 'ALREADY_ACTIVE', created: [] };
        }
        if (userValid && audit) {
          // 矩阵第 3 行：均存在且绑定一致 → ALREADY_ACTIVE，零新增
          const auditConsistent = audit._id === auditId && audit.action === 'registerIdentity'
            && audit.subjectUserId === derivedUserId && audit.actorUserId === derivedUserId
            && audit[SOURCE_PROTOCOL_FIELD] === SELF_REG_SCHEMA
            && audit[REGISTRATION_ROUND_FIELD] === config.registrationRoundId;
          if (!auditConsistent) { const e = new Error('既有审计与本包绑定冲突'); e.code = 'PIC_AUDIT_CONFLICT'; throw e; }
          txnOutcome = 'ALREADY_ACTIVE';
          return { outcome: 'ALREADY_ACTIVE', created: [] };
        }
        if (!user && audit) { const e = new Error('审计存在而用户缺失，不修复'); e.code = 'PIC_AUDIT_CONFLICT'; throw e; }
        if (user && !userValid) { const e = new Error('既有用户状态或主体不符，不激活不覆盖'); e.code = 'PIC_USER_CONFLICT'; throw e; }
        if (user) { const e = new Error('既有用户无法判定'); e.code = 'PIC_USER_CONFLICT'; throw e; }
        // 矩阵第 1 行：同事务原子新增用户与登记审计（恰 2 条）。
        // writeAttempted 在首次写调用前置位：写一旦开始，提交状态即不再可判定为零写。
        if (!config.synthetic) {
          const cw = clockCheck('transaction.write.user');
          if (!cw.ok) { const e = new Error('窗口时效检查未通过'); e.code = cw.code; throw e; }
        }
        fact.writeAttempted = true;
        await transaction.create(userRef, {
          _id: derivedUserId, openid: trusted.OPENID, status: 'active', createdAt: nowIso, updatedAt: nowIso
        });
        fact.createsIssued += 1;
        if (!config.synthetic) {
          const cw = clockCheck('transaction.write.audit');
          if (!cw.ok) { const e = new Error('窗口时效检查未通过'); e.code = cw.code; throw e; }
        }
        await transaction.create(auditRef, {
          _id: auditId, projectId: null, actorUserId: derivedUserId, actorRole: '本人普通账号',
          action: 'registerIdentity', subjectUserId: derivedUserId, before: null, after: { status: 'active' },
          createdAt: nowIso,
          [SOURCE_PROTOCOL_FIELD]: SELF_REG_SCHEMA,
          [REGISTRATION_ROUND_FIELD]: config.registrationRoundId
        });
        fact.createsIssued += 1;
        fact.writeAttempted = true;
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

    // 事务回调在未发出任何写之前失败 → REJECTED_NO_WRITE（可判定零写）
    if (commitError && !fact.writeAttempted) {
      const code = commitError && commitError.code ? commitError.code : 'PIC_TRANSACTION_FAILED';
      const messages = {
        PIC_AUDIT_CONFLICT: '既有登记审计冲突或孤立，不修复不覆盖',
        PIC_USER_CONFLICT: '既有用户状态或主体不符，不激活不覆盖',
        PIC_WINDOW_EXPIRED: '窗口已截止，未写入',
        PIC_CLOCK_INVALID: '时钟无效，未写入',
        PIC_CLOCK_ERROR: '时钟异常，未写入'
      };
      return Object.assign(base, {
        outcome: 'REJECTED_NO_WRITE', code,
        message: messages[code] || '登记事务未开始写入'
      });
    }

    // 已提交（commitConfirmed）但随后异常/超时 → OUTCOME_UNKNOWN，不误报零写、不自动重试
    if (commitError && fact.writeAttempted) {
      return Object.assign(base, {
        outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
        message: '事务回调在写入开始后失败：提交状态未知，不自动重试，请以关闭回读核实'
      });
    }

    // 提交后返回前时钟复核：到期/异常 → 提交事实保留，结果待核实（不自动重试）
    if (!config.synthetic) {
      const c = clockCheck('post.commit');
      if (!c.ok) {
        return Object.assign(base, {
          outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
          message: '提交后时钟复核未通过：提交状态待核实，不自动重试'
        });
      }
    }

    // 提交后同请求内按固定主键回读本人用户与确定性审计（冻结投影）
    try {
      const [userSnap, auditSnap] = await Promise.all([
        Promise.resolve(usersCol.doc(derivedUserId).get()),
        Promise.resolve(auditCol.doc(auditId).get())
      ]);
      const user = userSnap && userSnap.data ? userSnap.data : null;
      const audit = auditSnap && auditSnap.data ? auditSnap.data : null;
      base.readBack.user = Boolean(user && user._id === derivedUserId && user.status === 'active');
      base.readBack.audit = Boolean(audit && audit._id === auditId && audit.action === 'registerIdentity'
        && audit.subjectUserId === derivedUserId && audit[SOURCE_PROTOCOL_FIELD] === SELF_REG_SCHEMA);
    } catch (e) {
      return Object.assign(base, {
        outcome: 'OUTCOME_UNKNOWN', code: 'PIC_OUTCOME_UNKNOWN',
        message: '回读失败：提交状态待核实，不自动重试'
      });
    }

    if (txnOutcome === 'ALREADY_ACTIVE') {
      // 事务回调判定为既有有效：零新增；回读仅作存在确认，不伪称本次创建
      return Object.assign(base, {
        outcome: 'ALREADY_ACTIVE', code: null,
        message: '本人账号已有效存在，本包零新增（不伪造本包创建回执）'
      });
    }
    if (base.readBack.user && base.readBack.audit) {
      return Object.assign(base, {
        outcome: 'CREATED_AND_VERIFIED', code: null, created: true,
        message: '本人用户与登记审计已同事务新增并回读通过'
      });
    }
    // 事务提交但回读未确认两条记录：按未知处理（不伪称新增成功）
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
  SOURCE_PROTOCOL_FIELD,
  REGISTRATION_ROUND_FIELD,
  deriveRegistrationAuditId,
  deriveUserId,
  createSelfRegistrationChecker
});
