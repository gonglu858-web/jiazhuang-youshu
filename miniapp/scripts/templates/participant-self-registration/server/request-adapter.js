'use strict';
// 本登记包专用请求适配器（participant-self-registration-request/1 协议）。
//
// 职责：解析固定 picRequest 外壳并严格校验内层，仅构造「三字段」数据对象交给
// 未改登记核心（participant-self-registration.cjs）。沿用已审查的分层规则，不放宽：
// - 外层附带字段只查自有键名（含 Symbol 与非枚举），不读值/getter、不输出、不传播。
// - 冲突名单（旧格式混用/自报身份与目标/原型歧义）仅比较自有键名即拒绝。
// - 内层仅允许 schema/action/registrationRoundId/passphrase；额外自有键、Symbol、
//   非枚举字段、访问器、自定义原型一律拒绝；schema 精确匹配。
// - 只对固定允许的数据属性读取 descriptor.value；禁止 spread/整 event 克隆。
// - 不做旧格式回退（无 identify/inspectSelf 兼容）；元操作抛错一律净化拒绝。
// - 原型判定与只读包一致（isCrossRealmCanonicalRoot 联合验证，三类仿造拒绝）。

const REQUEST_SCHEMA = 'participant-self-registration-request/1';

const INNER_ALLOWED = Object.freeze(['schema', 'action', 'registrationRoundId', 'passphrase']);

const OUTER_CONFLICT_NAMES = Object.freeze([
  // 旧顶层格式混用（含只读协议动作——本包不兼容旧动作）
  'action', 'passphrase', 'schema', 'checkRoundId', 'registrationRoundId', 'includeFullUserId',
  // 自报身份/业务目标
  'openid', 'OPENID', 'unionid', 'UNIONID', 'appId', 'APPID',
  'userId', 'role', 'roles', 'collection', 'docId', 'envId', 'functionName',
  'allowedAccount', 'allowedUserIds',
  // 原型/构造歧义
  '__proto__', 'prototype', 'constructor'
]);
const OUTER_CONFLICT = Object.freeze(OUTER_CONFLICT_NAMES.reduce((m, k) => { m[k] = true; return m; }, Object.create(null)));

function isCrossRealmCanonicalRoot(p) {
  if (Object.getPrototypeOf(p) !== null) return false;
  const c = Object.getOwnPropertyDescriptor(p, 'constructor');
  if (!c || !Object.prototype.hasOwnProperty.call(c, 'value') || typeof c.value !== 'function' || c.enumerable !== false) {
    return false;
  }
  if (Function.prototype.toString.call(c.value) !== Function.prototype.toString.call(Object)) {
    return false;
  }
  const q = Object.getOwnPropertyDescriptor(c.value, 'prototype');
  return !!q && Object.prototype.hasOwnProperty.call(q, 'value') && q.value === p && q.writable === false && q.configurable === false;
}

function isPlainRecord(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto === null) return true;
  if (proto === Object.prototype) return true;
  return isCrossRealmCanonicalRoot(proto);
}

/**
 * 解析并校验请求；返回 { ok:true, request } 或 { ok:false }。
 * request 是逐项构造的新对象，仅含 action/registrationRoundId/passphrase（schema 不进入核心）。
 */
function extractBusinessRequest(event) {
  try {
    if (!isPlainRecord(event)) return { ok: false };
    const outerKeys = Reflect.ownKeys(event);
    for (const k of outerKeys) {
      if (typeof k !== 'string') return { ok: false };
      if (Object.prototype.hasOwnProperty.call(OUTER_CONFLICT, k)) return { ok: false };
    }
    const outerDesc = Object.getOwnPropertyDescriptor(event, 'picRequest');
    if (!outerDesc || outerDesc.enumerable !== true || outerDesc.get !== undefined || outerDesc.set !== undefined) {
      return { ok: false };
    }
    const pic = outerDesc.value;
    if (!isPlainRecord(pic)) return { ok: false };
    const innerKeys = Reflect.ownKeys(pic);
    const descs = Object.create(null);
    for (const k of innerKeys) {
      if (typeof k !== 'string' || !INNER_ALLOWED.includes(k)) return { ok: false };
      if (Object.prototype.hasOwnProperty.call(descs, k)) return { ok: false };
      const d = Object.getOwnPropertyDescriptor(pic, k);
      if (!d || d.enumerable !== true || d.get !== undefined || d.set !== undefined) return { ok: false };
      if (typeof d.value !== 'string') return { ok: false };
      descs[k] = d;
    }
    if (!descs.schema || descs.schema.value !== REQUEST_SCHEMA) return { ok: false };
    if (!descs.action || !descs.registrationRoundId || !descs.passphrase) return { ok: false };
    const request = {
      action: descs.action.value,
      registrationRoundId: descs.registrationRoundId.value,
      passphrase: descs.passphrase.value
    };
    return { ok: true, request };
  } catch (_) {
    return { ok: false };
  }
}

module.exports = { extractBusinessRequest, REQUEST_SCHEMA };
