'use strict';
// 本核验包专用请求适配器（participant-identity-request/1 协议）。
//
// 职责：解析固定 picRequest 外壳并严格校验内层，仅构造「原四字段」数据对象交给
// 未改核心（participant-identity-check.cjs 字节不变）。
//
// 边界（设计 §3，不得放宽）：
// - 外层附带字段只查自有键名（含 Symbol 与非枚举），不读值/getter、不输出键名或值、
//   不拷贝、不序列化、不传播到核心/日志/结果/错误；这不是信任平台元数据。
// - 冲突名单（旧格式混用/自报身份与目标/原型歧义）仅比较自有键名即拒绝，非枚举同名也拒绝。
// - 内层仅允许 schema 与原四字段；额外自有键、Symbol、非枚举字段、访问器、危险属性、
//   自定义原型一律拒绝；schema 精确匹配，不做字符串化/大小写变换/自动纠正。
// - 只对固定允许的数据属性读取 descriptor.value；禁止 spread/Object.assign/整 event 克隆。
// - 不做旧格式回退；元操作抛错一律以 ok:false 净化返回，不外露原始异常。
// - 原型判定（R1 终局，严格）：外层/内层对象原型必须是 null、本仓库 Object.prototype，
//   或经验证的跨仓库真实 Object.prototype 根——联合验证该根自有 constructor 数据属性
//   （非枚举函数）与其所属真实 Object 构造器的原生表示一致（Function.prototype.toString，
//   不只看 constructor.name），且该构造器自有不可改（writable=false/configurable=false）的
//   prototype 数据属性精确回指此根。自造方法、复制 Object.prototype 描述符、伪造构造器
//   手工自关联三类仿造一律拒绝；不做任意原型深度检查，不读取属性值。

const REQUEST_SCHEMA = 'participant-identity-request/1';

/** 内层唯一允许字段（schema + 原四业务字段）。 */
const INNER_ALLOWED = Object.freeze(['schema', 'action', 'checkRoundId', 'passphrase', 'includeFullUserId']);

/** 外层冲突拒绝名单（仅自有键名比较，不读值；命中即拒绝）。 */
const OUTER_CONFLICT_NAMES = Object.freeze([
  // 旧顶层格式混用
  'action', 'passphrase', 'checkRoundId', 'includeFullUserId', 'schema',
  // 自报身份/业务目标
  'openid', 'OPENID', 'unionid', 'UNIONID', 'appId', 'APPID',
  'userId', 'role', 'roles', 'collection', 'docId', 'envId', 'functionName',
  // 原型/构造歧义
  '__proto__', 'prototype', 'constructor'
]);
const OUTER_CONFLICT = Object.freeze(OUTER_CONFLICT_NAMES.reduce((m, k) => { m[k] = true; return m; }, Object.create(null)));

/**
 * 跨仓库普通对象的根验证（R1 终局，联合真实性校验；与复查参考谓词 referencePlainRecord 一致）：
 *   1) 候选根自身原型必须为 null（真实领域根，而非挂在自定义对象上的伪装）；
 *   2) 通过 getOwnPropertyDescriptor 取根自有 constructor 数据属性——拒绝访问器；
 *   3) 用受信 Function.prototype.toString 验证它与受信 Object 构造器的原生表示一致
 *      （不是只看 constructor.name；自造方法/复制描述符/伪造构造器均无法同时满足）；
 *   4) 再读取该构造器自有 prototype 数据属性：值必须精确等于候选根，且
 *      writable=false/configurable=false（真实 Object 构造器的不可改原型对应关系）。
 * 不调用该构造器或任何方法，不读取输入 getter；元操作抛错由外层净化拒绝。
 */
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

/** 普通对象判定（R1 终局）：null 原型 / 本仓库 Object.prototype / 已验证的跨仓库真实根。 */
function isPlainRecord(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto === null) return true;
  if (proto === Object.prototype) return true;
  return isCrossRealmCanonicalRoot(proto);
}

/**
 * 解析并校验请求；返回 { ok:true, request } 或 { ok:false }。
 * request 是逐项构造的新对象，仅含原四字段（schema 不进入核心），不带外层或内层
 * 未知数据、原型或访问器。
 */
function extractBusinessRequest(event) {
  try {
    if (!isPlainRecord(event)) return { ok: false };
    // 外层自有键检查（Reflect.ownKeys 覆盖 Symbol 与非枚举）：Symbol 一律拒绝；冲突名单仅比较键名
    const outerKeys = Reflect.ownKeys(event);
    for (const k of outerKeys) {
      if (typeof k !== 'string') return { ok: false };
      if (Object.prototype.hasOwnProperty.call(OUTER_CONFLICT, k)) return { ok: false };
    }
    // picRequest：自有、可枚举的数据属性（禁止继承取得与 getter/setter；descriptor.value 之外不读）
    const outerDesc = Object.getOwnPropertyDescriptor(event, 'picRequest');
    if (!outerDesc || outerDesc.enumerable !== true || outerDesc.get !== undefined || outerDesc.set !== undefined) {
      return { ok: false };
    }
    const pic = outerDesc.value;
    if (!isPlainRecord(pic)) return { ok: false };
    // 内层自有键：仅允许名单；非枚举/访问器/Symbol/未知键一律拒绝
    const innerKeys = Reflect.ownKeys(pic);
    const descs = Object.create(null);
    for (const k of innerKeys) {
      if (typeof k !== 'string' || !INNER_ALLOWED.includes(k)) return { ok: false };
      if (Object.prototype.hasOwnProperty.call(descs, k)) return { ok: false };
      const d = Object.getOwnPropertyDescriptor(pic, k);
      if (!d || d.enumerable !== true || d.get !== undefined || d.set !== undefined) return { ok: false };
      if (k === 'includeFullUserId') {
        if (typeof d.value !== 'boolean') return { ok: false };
      } else if (typeof d.value !== 'string') {
        return { ok: false };
      }
      descs[k] = d;
    }
    // schema 精确等于固定协议版本；三个必填字符串字段必须存在
    if (!descs.schema || descs.schema.value !== REQUEST_SCHEMA) return { ok: false };
    if (!descs.action || !descs.checkRoundId || !descs.passphrase) return { ok: false };
    // 逐项构造新的原四字段对象（includeFullUserId 可缺省；缺省与 false 同义，均不请求完整 ID）
    const request = {
      action: descs.action.value,
      checkRoundId: descs.checkRoundId.value,
      passphrase: descs.passphrase.value
    };
    if (descs.includeFullUserId) request.includeFullUserId = descs.includeFullUserId.value;
    return { ok: true, request };
  } catch (_) {
    // 键枚举/描述符等元操作抛错（含 Proxy）：一律净化拒绝，不外露原始异常
    return { ok: false };
  }
}

module.exports = Object.freeze({ REQUEST_SCHEMA, extractBusinessRequest });
