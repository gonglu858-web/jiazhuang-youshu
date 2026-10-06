// 施工安排独立测试副本：**专用测试协调器**。
//
// 依据：任务文档 §4（双向互斥与未知结果）与 Codex 复核 R1。
//
// 职责（**不含任何云调用**）：
// 1. **运行时占用带所有权**：普通调用、恢复、自动身份刷新与测试调用都在同一
//    占用表里竞争；释放必须出示本方 token，否则不算所有者。
// 2. **普通入口也必须占用**：普通路径在首次 await 之前取得并保持占用，
//    专用驱动因此无法与普通在途请求并行。内部恢复再调身份刷新时**传递
//    同一所有者**，不形成自锁，也不提供任何外部绕过开关。
// 3. **轮次级持久批次**：按「环境 + 业务 roundId」写**一份批次文档**，
//    所有用例写同一份；换账号、重进页面、改配置、换用例都不能隐藏既有
//    consumed / armed / inFlight / candidate / stopped。
// 4. **candidate 需人工接续才放开下一例；stopped / 未知永不放开**。
// 5. **先持久化并回读**，再允许发业务请求；持久化或回读失败 → 零业务发送。
// 6. 存储读取、枚举、回读任一异常**一律失败关闭**，不得视为空集合。
// 7. **不删除、不改写**原普通 envelope，也不把 `resolvePendingAfterExternalCheck`
//    变成解锁按钮。
//
// 重要边界：
// - 这是**同一设备/运行时**的操作互斥，**不是跨设备锁**。
// - 开关切换、配置改动、换号**都不是解锁机制**；consumed 历史一律保留。
// - armed 之后即已占用：重进页面、响应丢失、进程退出都**不自动重发**。
// - 本文件不 require 客户端，不发请求；只有驱动层与客户端接点会调用它。

'use strict';

// 证明配置可以在测试里替换（生产路径始终用磁盘上的默认关闭配置）。
// 协调器**不导出**任何修改开关的入口；测试只能整体替换本模块缓存。
const defaultProof = require('../config/sandbox-test-driver-proof');

/** 当前生效的证明配置（测试可整体替换；生产不变）。 */
let proofRef = defaultProof;

/** 仅供测试整体替换配置引用；不接受部分字段，避免半开状态。 */
function _setProofForTest(nextProof) {
  proofRef = nextProof || defaultProof;
  return proofRef;
}

function driverProof() {
  return proofRef;
}

/**
 * 轮次级批次键：**环境 + 业务 roundId**（不含执行人）。
 *
 * 故意不含 actorUserId：换账号必须命中同一份批次文档，
 * 否则「换号隐藏未完成批次」就会成立。
 */
function batchKey(envId, roundId) {
  return `${driverProof().cachePrefix}batch:${envId}:${roundId}`;
}

/**
 * 历史兼容键：环境 + 轮次 + 执行人。
 * 只用于**读取**上一轮已写入的按人记录并迁移，不作为新的写入目标。
 */
function legacyBatchKey(envId, roundId, actorUserId) {
  return `${driverProof().cachePrefix}legacy-batch:${envId}:${roundId}:${actorUserId || 'unbound'}`;
}

/** 用例状态键：轮次级批次键 + testCaseId。 */
function caseKey(envId, roundId, testCaseId) {
  return `${batchKey(envId, roundId)}:case:${testCaseId}`;
}

/**
 * 同运行时占用（模块级），**带所有权**。
 * owner 取值：'test'（专用驱动）/ 'ordinary'（普通调用、恢复、身份刷新）。
 */
let RUNTIME_HOLD = null;

/** 允许的占用理由（诊断用；不参与授权判断）。 */
const HOLD_REASONS = Object.freeze([
  'preflight', 'identifying', 'membersCheck', 'probing', 'armed', 'inFlight',
  'reviewing', 'ordinaryCall', 'ordinaryResume', 'ordinaryIdentity'
]);

/** 允许的占用所有者。 */
const HOLD_OWNERS = Object.freeze(['test', 'ordinary']);

let tokenSeq = 0;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 与客户端一致的轻量散列：仅用于本地记录绑定与比对，不作安全用途。 */
function digest(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function snapshotDigest(snapshot) {
  return digest(stableStringify(snapshot));
}

/**
 * 本地存储包装。
 * **必须**同时提供 getStorageInfoSync：没有枚举能力就无法证明
 * 「没有别的账号的未完成批次」，此时上层必须失败关闭而不是当作空。
 */
function resolveStorage(api) {
  if (api && api.storage && typeof api.storage.getStorageSync === 'function') {
    if (typeof api.storage.getStorageInfoSync !== 'function') {
      const wrapped = Object.create(api.storage);
      wrapped.getStorageInfoSync = () => ({ keys: [] });
      wrapped.__enumerationUnavailable = true;
      return wrapped;
    }
    return api.storage;
  }
  if (typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function') {
    return {
      getStorageSync: key => wx.getStorageSync(key),
      setStorageSync: (key, value) => wx.setStorageSync(key, value),
      removeStorageSync: key => wx.removeStorageSync(key),
      // 真实 wx 提供 getStorageInfoSync；缺失时如实标记，交上层失败关闭
      getStorageInfoSync: typeof wx.getStorageInfoSync === 'function'
        ? () => wx.getStorageInfoSync()
        : undefined,
      __enumerationUnavailable: typeof wx.getStorageInfoSync !== 'function'
    };
  }
  return null;
}

/** 枚举是否可用。不可用时上层**不得**当作「没有其它批次」。 */
function canEnumerate(storage) {
  return Boolean(storage && typeof storage.getStorageInfoSync === 'function' && !storage.__enumerationUnavailable);
}

function readJson(storage, key) {
  if (!storage || typeof storage.getStorageSync !== 'function') {
    return { status: 'error', reason: '本地存储不可用。' };
  }
  let raw;
  try {
    raw = storage.getStorageSync(key);
  } catch (error) {
    return { status: 'error', reason: '读取本地状态失败。' };
  }
  if (raw === '' || raw === null || raw === undefined) {
    return { status: 'none' };
  }
  let doc;
  try {
    doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return { status: 'error', reason: '本地状态损坏，已按不可用处理。' };
  }
  if (!isPlainObject(doc)) return { status: 'error', reason: '本地状态结构无效。' };
  return { status: 'ok', record: doc };
}

function writeJson(storage, key, value) {
  if (!storage || typeof storage.setStorageSync !== 'function') return false;
  try {
    storage.setStorageSync(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

// ── 运行时占用（带所有权）────────────────────────────────────────────────

/**
 * 取得运行时占用（**同步**，首次 await 之前）。
 *
 * @param {string} reason 占用理由（HOLD_REASONS 之一）
 * @param {string} owner 'test' | 'ordinary'
 * @param {string} testCaseId 用例编号（owner='test' 时必填）
 * @returns {{ok:true, token:string, owner:string}|{ok:false, code:string, message:string, holder?:object}}
 */
function acquireRuntimeHold(reason, owner, testCaseId) {
  if (!HOLD_OWNERS.includes(owner)) {
    return { ok: false, code: 'TEST_DRIVER_BAD_OWNER', message: '未知的占用所有者。' };
  }
  if (!HOLD_REASONS.includes(reason)) {
    return { ok: false, code: 'TEST_DRIVER_BAD_REASON', message: '未知的占用理由。' };
  }
  if (owner === 'test' && !testCaseId) {
    return { ok: false, code: 'TEST_DRIVER_BAD_REASON', message: '测试占用必须指明用例。' };
  }
  if (RUNTIME_HOLD) {
    return {
      ok: false,
      code: owner === 'test' ? 'TEST_DRIVER_BUSY' : 'SANDBOX_TEST_DRIVER_ACTIVE',
      message: owner === 'test'
        ? '专用测试或普通操作正在本机运行，已阻止并发启动。'
        : '本机已有进行中的操作，本轮已阻止并发普通请求以避免互相打断。',
      holder: describeHold()
    };
  }
  tokenSeq++;
  const token = `${owner}:${reason}:${testCaseId || ''}:${tokenSeq}`;
  RUNTIME_HOLD = { token, reason, owner, testCaseId: testCaseId || '', at: Date.now() };
  return { ok: true, token, owner };
}

/**
 * 释放运行时占用。
 * **必须出示本方 token**：不是持有者一律不释放（防止跨用例/跨路径误释放）。
 */
function releaseRuntimeHold(token) {
  if (!RUNTIME_HOLD) return false;
  if (RUNTIME_HOLD.token !== token) return false;
  RUNTIME_HOLD = null;
  return true;
}

/** 只读查询占用情况（含所有者，供诊断与阻断判断）。 */
function peekRuntimeHold() {
  return RUNTIME_HOLD ? { held: true, owner: RUNTIME_HOLD.owner, reason: RUNTIME_HOLD.reason, token: RUNTIME_HOLD.token } : { held: false };
}

/**
 * 校验一个「内部重入凭证」是否**确实**是当前持有的 ordinary 占用。
 *
 * S2 返修：此前 `if (opts.owner)` 直接放行，任意 truthy 对象都能跳锁。
 * 现在必须出示 `acquireRuntimeHold` 返回的**完整凭证**（token + owner='ordinary'），
 * 且该 token 必须**当前仍被持有**。以下一律拒绝：
 * - 空对象 / 任意对象 / 字符串 / 数字
 * - token 不匹配（含过期 token、已释放 token）
 * - owner 为 'test' 的占用凭证（专用测试持有时不允许普通路径借道）
 *
 * @returns {{ok:true, token:string}|{ok:false, reason:string}}
 */
function verifyOrdinaryOwner(owner) {
  if (!isPlainObject(owner)) {
    return { ok: false, reason: '内部重入凭证无效。' };
  }
  const { token, owner: claimed } = owner;
  if (typeof token !== 'string' || !token) {
    return { ok: false, reason: '内部重入凭证缺少 token。' };
  }
  if (claimed !== 'ordinary') {
    return { ok: false, reason: '内部重入凭证的持有者不是普通占用。' };
  }
  if (!RUNTIME_HOLD || RUNTIME_HOLD.token !== token) {
    return { ok: false, reason: '内部重入凭证不是当前持有的普通占用。' };
  }
  if (RUNTIME_HOLD.owner !== 'ordinary') {
    return { ok: false, reason: '当前占用不是普通占用。' };
  }
  return { ok: true, token };
}

/**
 * 升级占用理由（**保持同一 token**）。
 * 用于同一次执行内从 preflight → identifying → membersCheck → inFlight 推进，
 * 避免释放再竞争时出现窗口。不是解锁机制，也不是外部绕过开关。
 */
function upgradeRuntimeHoldReason(token, reason) {
  if (!RUNTIME_HOLD || RUNTIME_HOLD.token !== token) return false;
  if (!HOLD_REASONS.includes(reason)) return false;
  RUNTIME_HOLD.reason = reason;
  return true;
}

function describeHold() {
  return RUNTIME_HOLD ? { owner: RUNTIME_HOLD.owner, reason: RUNTIME_HOLD.reason, testCaseId: RUNTIME_HOLD.testCaseId } : null;
}

/** 仅供测试复位模块级占用。生产路径不提供。 */
function _resetRuntimeHoldForTest() {
  RUNTIME_HOLD = null;
  tokenSeq = 0;
}

// ── 轮次级批次文档 ───────────────────────────────────────────────────────

/**
 * 轮次级批次文档的**固定 kind**（用于识别损坏或异种记录）。
 */
const BATCH_KIND = 'sandbox-test-driver-batch/2';

/** 用例记录允许的状态（与 proof.caseStates 一致，用于识别未知状态）。 */
const KNOWN_CASE_STATES = Object.freeze([
  'ready', 'preflight', 'armed', 'inFlight', 'candidate', 'stopped', 'reviewed'
]);

/**
 * 严格验证批次文档结构。
 *
 * S2 返修：**存在但损坏必须阻断**，不重置、不覆盖、不把未知状态当作已完成。
 * 具体覆盖：`kind` 不符、`envId`/`roundId` 与当前不符、`cases` 不是字典
 * （例如 JSON 数组 `[]` —— 它可解析但不是字典）、用例项不是对象、
 * 状态不在已知集合内、绑定字段缺失。
 *
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
function validateBatchDoc(doc, ctx) {
  if (!isPlainObject(doc)) {
    return { ok: false, reason: '批次记录结构无效。' };
  }
  if (doc.kind !== BATCH_KIND) {
    return { ok: false, reason: `批次记录 kind 不符（${String(doc.kind)}）。` };
  }
  if (doc.envId !== ctx.envId) {
    return { ok: false, reason: '批次记录的环境与当前环境不符。' };
  }
  if (doc.roundId !== ctx.roundId) {
    return { ok: false, reason: '批次记录的轮次与当前轮次不符。' };
  }
  // cases 必须是**字典**；JSON 数组（可解析但不是字典）在此被拒
  if (!isPlainObject(doc.cases)) {
    const actual = Array.isArray(doc.cases) ? '数组' : typeof doc.cases;
    return { ok: false, reason: `批次记录的 cases 不是字典（实际 ${actual}）。` };
  }
  for (const [id, rec] of Object.entries(doc.cases)) {
    if (!isPlainObject(rec)) {
      return { ok: false, reason: `批次记录用例 ${id} 结构无效。` };
    }
    if (typeof rec.testCaseId !== 'string' || !rec.testCaseId) {
      return { ok: false, reason: `批次记录用例 ${id} 缺 testCaseId。` };
    }
    if (rec.testCaseId !== id) {
      return { ok: false, reason: `批次记录用例键与 testCaseId 不一致（${id}）。` };
    }
    if (!KNOWN_CASE_STATES.includes(rec.state)) {
      return { ok: false, reason: `批次记录用例 ${id} 状态未知（${String(rec.state)}）。` };
    }
    if (rec.state !== 'ready' && !isPlainObject(rec.binding)) {
      return { ok: false, reason: `批次记录用例 ${id} 缺绑定信息。` };
    }
    if (isPlainObject(rec.binding)) {
      if (rec.binding.envId !== ctx.envId || rec.binding.roundId !== ctx.roundId) {
        return { ok: false, reason: `批次记录用例 ${id} 的绑定与当前轮次不符。` };
      }
    }
    if (rec.state !== 'ready' && typeof rec.snapshotDigest !== 'string') {
      return { ok: false, reason: `批次记录用例 ${id} 缺快照摘要。` };
    }
  }
  return { ok: true };
}

/**
 * 严格验证**历史按人批次键**的文档（上一轮格式）。
 * S2 返修：识别到即**保守阻断**；不写迁移器、不删除记录。
 */
function validateLegacyBatchDoc(doc, ctx) {
  if (!isPlainObject(doc)) return { ok: false, reason: '历史批次记录结构无效。' };
  if (doc.kind !== BATCH_KIND) {
    return { ok: false, reason: `历史批次记录 kind 不符（${String(doc.kind)}）。` };
  }
  if (!isPlainObject(doc.cases)) {
    return { ok: false, reason: '历史批次记录的 cases 不是字典。' };
  }
  for (const [id, rec] of Object.entries(doc.cases)) {
    if (!isPlainObject(rec)) return { ok: false, reason: `历史批次记录用例 ${id} 结构无效。` };
    if (!KNOWN_CASE_STATES.includes(rec.state)) {
      return { ok: false, reason: `历史批次记录用例 ${id} 状态未知（${String(rec.state)}）。` };
    }
  }
  return { ok: true };
}

/**
 * 读取轮次级批次文档。
 * 结构：{ kind, envId, roundId, createdAt, cases: { [testCaseId]: caseRecord } }
 * **所有用例写同一份文档**，不按用例或按账号分裂。
 *
 * S2 返修：不再用 `{}` 兜底掩盖损坏的 `cases`；结构不符即返回 error，
 * 由调用方失败关闭。历史按人键只用于**发现并阻断**，不作为正常读取来源。
 */
function readBatch(ctx) {
  const key = batchKey(ctx.envId, ctx.roundId);
  const got = readJson(ctx.storage, key);
  got.key = key;
  if (got.status === 'ok') {
    const valid = validateBatchDoc(got.record, ctx);
    if (!valid.ok) {
      return { status: 'error', reason: valid.reason, key };
    }
    return got;
  }
  return got;
}

/** 读取某用例的持久状态（从轮次级批次文档内取）。 */
function readCase(ctx, testCaseId) {
  const batch = readBatch(ctx);
  if (batch.status === 'error') return { status: 'error', reason: batch.reason, key: batch.key };
  if (batch.status !== 'ok') return { status: 'none', key: caseKey(ctx.envId, ctx.roundId, testCaseId) };
  const cases = batch.record.cases;
  const rec = cases[testCaseId];
  if (!isPlainObject(rec)) return { status: 'none', key: caseKey(ctx.envId, ctx.roundId, testCaseId) };
  return { status: 'ok', record: rec, key: caseKey(ctx.envId, ctx.roundId, testCaseId), batch: batch.record };
}

/** 该用例本轮是否已被启动过（consumed）。配置关闭或改动都不清除。 */
function isConsumed(ctx, testCaseId) {
  const got = readCase(ctx, testCaseId);
  if (got.status === 'error') return { consumed: true, unusable: true, reason: got.reason };
  if (got.status !== 'ok') return { consumed: false, unusable: false };
  return { consumed: got.record.state !== 'ready', unusable: false, state: got.record.state, record: got.record };
}

/**
 * 轮次级阻断：**任何**用例处于未完成状态都阻断下一例。
 * - armed / inFlight：已占用，绝不放开。
 * - candidate：需完成人工接续（→ reviewed）才放开。
 * - stopped / 未知：永不放开（人工核对也不能解锁）。
 */
function blockingCases(ctx) {
  const batch = readBatch(ctx);
  if (batch.status === 'error') return { status: 'error', reason: batch.reason, blocking: [] };
  if (batch.status !== 'ok') return { status: 'ok', blocking: [] };
  const cases = batch.record.cases; // 已由 validateBatchDoc 保证是字典且逐项合法
  const blocking = [];
  for (const [id, rec] of Object.entries(cases)) {
    if (['armed', 'inFlight', 'candidate', 'stopped', 'preflight'].includes(rec.state)) {
      blocking.push({ testCaseId: id, state: rec.state });
    }
  }
  return { status: 'ok', blocking };
}

/** 枚举同 环境+roundId 下其它历史键（失败关闭，不当作空）。 */
function listRoundKeys(ctx, roundId) {
  const storage = ctx.storage;
  if (!canEnumerate(storage)) {
    return { ok: false, reason: '本地存储无法枚举，已按不可确认处理。' };
  }
  let info;
  try {
    info = storage.getStorageInfoSync();
  } catch (error) {
    return { ok: false, reason: '枚举本地存储失败，已按不可确认处理。' };
  }
  const keys = info && Array.isArray(info.keys) ? info.keys : null;
  if (!keys) return { ok: false, reason: '本地存储枚举结果无效，已按不可确认处理。' };
  const prefix = `${driverProof().cachePrefix}`;
  return { ok: true, keys: keys.filter(k => typeof k === 'string' && k.startsWith(prefix) && k.includes(`:${roundId}`)) };
}

/**
 * 同轮次其它账号/历史键/旧按人键的未完成批次。
 *
 * S2 返修：**不再跳过 `:case:` 键**。上一轮真实写入过
 * `...legacy-batch:env:round:actor:case:V06-a`（kind=...case/1）与
 * `...batch:env:round:actor:case:...` 这类**单用例键**；跳过它们等于
 * 把历史未决藏起来。现在一律读出并保守阻断（不写迁移器、不删除记录）。
 *
 * **枚举失败或不可用时返回 blocked=true**（失败关闭），而不是空集合。
 */
function pendingBatchesForRound(ctx, roundId) {
  const listed = listRoundKeys(ctx, roundId);
  if (!listed.ok) return { blocked: true, reason: listed.reason, pending: [] };
  const pending = [];
  for (const key of listed.keys) {
    // 轮次级主键由 blockingCases / readBatch 负责，不在此重复
    if (key === batchKey(ctx.envId, roundId)) continue;
    const got = readJson(ctx.storage, key);
    if (got.status === 'error') {
      return { blocked: true, reason: `历史批次记录损坏（${got.reason}），已按不可确认处理。`, pending: [] };
    }
    if (got.status !== 'ok') continue;
    const doc = got.record;
    // 单用例记录（历史 case/1 或按人 case 键）
    if (isPlainObject(doc) && typeof doc.testCaseId === 'string') {
      if (!KNOWN_CASE_STATES.includes(doc.state)) {
        return { blocked: true, reason: `历史用例记录 ${key} 状态未知（${String(doc.state)}），已按不可确认处理。`, pending: [] };
      }
      if (['preflight', 'armed', 'inFlight', 'candidate', 'stopped'].includes(doc.state)) {
        pending.push({ key, testCaseId: doc.testCaseId, state: doc.state, shape: 'single-case' });
      }
      continue;
    }
    // 历史按人批次文档
    const valid = validateLegacyBatchDoc(doc, ctx);
    if (!valid.ok) {
      return { blocked: true, reason: `历史批次记录 ${key} ${valid.reason}`, pending: [] };
    }
    for (const [id, rec] of Object.entries(doc.cases)) {
      if (['preflight', 'armed', 'inFlight', 'candidate', 'stopped'].includes(rec.state)) {
        pending.push({ key, testCaseId: id, state: rec.state, shape: 'legacy-batch' });
      }
    }
  }
  return { blocked: false, pending };
}

/**
 * 启动前的本地门槛（**纯本地，不发请求**）。
 * 顺序固定，任一不通过即 ok:false，调用方必须零发送。
 */
function preflight(ctx, testCaseId) {
  const reasons = [];
  const proof = driverProof();

  // 1) 驱动开关
  if (proof.enabled !== true) reasons.push('专用测试驱动未启用。');
  // 2) 动态值完整（**不能靠空值跳过比较**）
  for (const field of ['roundId', 'projectId', 'actorUserId', 'expiresAt', 'evidenceId', 'v07TargetUserId']) {
    const v = proof[field];
    if (typeof v !== 'string' || !v.trim()) reasons.push(`配置缺 ${field}。`);
  }
  // 3) 固定目标
  if (proof.appId !== 'wxfb4db1615ac15531') reasons.push('驱动配置 AppID 不符。');
  if (proof.envId !== 'cloud1-d8gcq5ag39d847723') reasons.push('驱动配置环境不符。');
  if (proof.functionName !== 'scheduleSandbox') reasons.push('驱动配置函数名不符。');
  // 4) 窗口
  const deadline = Date.parse(proof.expiresAt);
  if (!Number.isFinite(deadline)) reasons.push('配置窗口截止时间不合法。');
  else if (ctx.nowMs > deadline) reasons.push('配置窗口已过期。');
  // 5) 受保护项目
  if (proof.protectedProjectIds.includes(proof.projectId)) reasons.push('配置指向受保护的原项目。');
  // 6) 本用例存在且是固定用例
  const spec = proof.testCases.find(c => c.testCaseId === testCaseId);
  if (!spec) reasons.push('不是固定用例。');
  // 7) 本轮该用例未启动过
  const consumed = isConsumed(ctx, testCaseId);
  if (consumed.unusable) reasons.push(consumed.reason);
  else if (consumed.consumed) reasons.push(`用例 ${testCaseId} 本轮已启动过，不重复运行。`);

  // 8) **轮次级阻断**：任何未完成用例都阻断，含本账号自己的其它用例
  if (!reasons.length) {
    const round = blockingCases(ctx);
    if (round.status === 'error') reasons.push(round.reason);
    else if (round.blocking.length) {
      const detail = round.blocking.map(x => `${x.testCaseId}=${x.state}`).join('、');
      reasons.push(`本轮仍有未完成用例（${detail}）；candidate 需先完成人工接续，stopped/未知永不解锁。`);
    }
  }

  // 9) 同轮次其它账号/历史键的未完成批次（枚举失败即失败关闭）
  if (!reasons.length) {
    const others = pendingBatchesForRound(ctx, proof.roundId);
    if (others.blocked) reasons.push(others.reason);
    else if (others.pending.length) {
      const detail = others.pending.map(x => `${x.testCaseId}=${x.state}`).join('、');
      reasons.push(`同轮次其它批次存在未完成用例（${detail}），已停止以免隐藏未决。`);
    }
  }

  // 10) 存储必须可枚举（无法证明「没有别的未完成批次」时不得放行）
  if (!reasons.length && !canEnumerate(ctx.storage)) {
    reasons.push('本地存储无法枚举，未完成批次不可确认，已停止。');
  }

  if (reasons.length) {
    return { ok: false, code: 'TEST_DRIVER_PREFLIGHT_BLOCKED', message: reasons.join(' '), reasons };
  }
  return { ok: true, spec };
}

// ── 持久化与回读 ─────────────────────────────────────────────────────────

/**
 * 构造并写入轮次级批次文档骨架（首次写入时创建）。
 *
 * S2 返修：**不再把损坏的 `cases` 重置成 `{}`**。
 * 已存在但结构不符 → 直接失败关闭，既不重置也不覆盖原记录。
 */
function ensureBatchDoc(ctx, patch) {
  const key = batchKey(ctx.envId, ctx.roundId);
  const current = readJson(ctx.storage, key);
  if (current.status === 'error') {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: current.reason };
  }
  let base;
  if (current.status === 'ok') {
    // 已存在：必须通过严格校验，否则拒绝（不修复、不覆盖）
    const valid = validateBatchDoc(current.record, ctx);
    if (!valid.ok) {
      return {
        ok: false,
        code: 'TEST_DRIVER_STORAGE_UNAVAILABLE',
        message: `轮次批次记录已存在但${valid.reason}已停止，不重置也不覆盖，请人工核对后整体移走。`
      };
    }
    base = current.record;
  } else {
    base = {
      kind: BATCH_KIND,
      envId: ctx.envId,
      roundId: ctx.roundId,
      createdAt: Date.now(),
      cases: {}
    };
  }
  const next = Object.assign({}, base, patch || {});
  next.updatedAt = Date.now();
  if (!writeJson(ctx.storage, key, next)) {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: '无法保存轮次批次记录，已阻止发送。' };
  }
  const got = readJson(ctx.storage, key);
  if (got.status !== 'ok') {
    return {
      ok: false,
      code: 'TEST_DRIVER_STORAGE_UNAVAILABLE',
      message: `轮次批次记录回读失败（${got.reason || '未知'}），已阻止发送。`
    };
  }
  const valid = validateBatchDoc(got.record, ctx);
  if (!valid.ok) {
    return {
      ok: false,
      code: 'TEST_DRIVER_STORAGE_UNAVAILABLE',
      message: `轮次批次记录回读${valid.reason}已阻止发送。`
    };
  }
  return { ok: true, key, record: got.record };
}

/**
 * 写入并**回读**用例的启动记录（armed 之前完成）。
 * 回读时**对实际记录重算摘要**并核对全部绑定字段，不信自报的 digest 字符串。
 *
 * @param {object} ctx { storage, envId, roundId, actorUserId }
 * @param {object} record { testCaseId, snapshot, binding, ... }
 */
function persistArmedRecord(ctx, record) {
  const binding = Object.assign({}, record.binding || {});
  const snapshot = record.snapshot;
  // 自报摘要仅作对照；核对以**重算值**为准
  const recomputed = snapshotDigest(snapshot);
  const payload = {
    testCaseId: record.testCaseId,
    state: 'armed',
    kind: 'sandbox-test-driver-case/2',
    binding,
    snapshot,
    snapshotDigest: recomputed,
    requestIds: Array.isArray(record.requestIds) ? record.requestIds.slice() : [],
    planDigest: typeof record.planDigest === 'string' ? record.planDigest : digest(stableStringify(record.snapshot && record.snapshot.plan)),
    armedAt: Date.now()
  };
  const ensured = ensureBatchDoc(ctx, {});
  if (!ensured.ok) return ensured;
  ensured.record.cases[record.testCaseId] = payload;
  const key = ensured.key;
  if (!writeJson(ctx.storage, key, ensured.record)) {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: '无法保存启动记录，已阻止发送。' };
  }

  // 回读：对**实际记录**重算并逐项核对
  const got = readJson(ctx.storage, key);
  if (got.status !== 'ok') {
    return {
      ok: false,
      code: 'TEST_DRIVER_STORAGE_UNAVAILABLE',
      message: `启动记录回读失败（${got.reason || '未知'}），已阻止发送。`
    };
  }
  const rec = isPlainObject(got.record.cases) ? got.record.cases[record.testCaseId] : null;
  if (!isPlainObject(rec)) {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: '启动记录回读缺失，已阻止发送。' };
  }
  const problems = [];
  if (rec.state !== 'armed') problems.push(`状态不符（${rec.state}）`);
  if (rec.testCaseId !== record.testCaseId) problems.push('用例编号不符');
  // 不信自报 digest：重算后比对
  const actualDigest = snapshotDigest(rec.snapshot);
  if (actualDigest !== recomputed) problems.push('快照内容与写入时不一致');
  if (rec.snapshotDigest !== recomputed) problems.push('快照摘要字段与重算值不一致');
  if (stableStringify(rec.binding) !== stableStringify(binding)) problems.push('绑定字段与写入时不一致');
  if (stableStringify(rec.requestIds) !== stableStringify(payload.requestIds)) problems.push('请求号与写入时不一致');
  if (problems.length) {
    return {
      ok: false,
      code: 'TEST_DRIVER_STORAGE_UNAVAILABLE',
      message: `启动记录回读不一致（${problems.join('；')}），已阻止发送。`
    };
  }
  return { ok: true, key, record: rec };
}

/**
 * 更新用例状态（不改变 consumed 历史，不做解锁）。
 *
 * S3 返修：回读必须核对**本次拟写的完整非敏感数据**
 * （responses / binding / requestIds / snapshot / snapshotDigest / state），
 * 而不只是「状态一样」和「自报摘要自洽」。
 * 任何一项与实际回读不一致 → 保守失败，绝不返回 ok。
 */
function setCaseState(ctx, testCaseId, state, patch) {
  if (!driverProof().caseStates.includes(state)) {
    return { ok: false, code: 'TEST_DRIVER_BAD_STATE', message: '未知用例状态。' };
  }
  const ensured = ensureBatchDoc(ctx, {});
  if (!ensured.ok) return ensured;
  const current = ensured.record.cases[testCaseId];
  if (!isPlainObject(current)) {
    return { ok: false, code: 'TEST_DRIVER_NO_RECORD', message: '没有该用例的启动记录。' };
  }
  const next = Object.assign({}, current, patch || {}, { state, updatedAt: Date.now() });
  ensured.record.cases[testCaseId] = next;
  if (!writeJson(ctx.storage, ensured.key, ensured.record)) {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: '无法保存用例状态。' };
  }
  // 回读核对：逐项比对本次拟写内容与**实际记录**
  const got = readJson(ctx.storage, ensured.key);
  if (got.status !== 'ok' || !isPlainObject(got.record)) {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: '用例状态回读失败。' };
  }
  const validDoc = validateBatchDoc(got.record, ctx);
  if (!validDoc.ok) {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: `用例状态回读${validDoc.reason}` };
  }
  const rec = got.record.cases[testCaseId];
  if (!isPlainObject(rec)) {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: '用例状态回读缺失。' };
  }
  const problems = [];
  if (rec.state !== state) problems.push(`状态不符（${String(rec.state)}）`);
  if (rec.testCaseId !== testCaseId) problems.push('用例编号不符');
  // 本次拟写的每一条 patch 键都必须与回读**完全相等**（含 responses）
  for (const [field, value] of Object.entries(patch || {})) {
    if (stableStringify(rec[field]) !== stableStringify(value)) {
      problems.push(`证据字段 ${field} 与写入时不一致`);
    }
  }
  // 绑定与请求号也不得被回读改动
  if (stableStringify(rec.binding) !== stableStringify(next.binding)) problems.push('绑定与写入时不一致');
  if (stableStringify(rec.requestIds) !== stableStringify(next.requestIds)) problems.push('请求号与写入时不一致');
  // 摘要：不信自报值，按实际快照重算
  if (isPlainObject(next.snapshot)) {
    const actualDigest = snapshotDigest(rec.snapshot);
    if (actualDigest !== snapshotDigest(next.snapshot)) problems.push('快照内容与写入时不一致');
    if (rec.snapshotDigest !== snapshotDigest(next.snapshot)) problems.push('快照摘要字段与重算值不一致');
  }
  if (problems.length) {
    return {
      ok: false,
      code: 'TEST_DRIVER_STORAGE_UNAVAILABLE',
      message: `用例状态回读不一致（${problems.join('；')}）。`
    };
  }
  return { ok: true, key: ensured.key, record: rec };
}

/**
 * 「已完成本例管理端核对」接续。
 * - 仅接受 `reviewableStates`（candidate）；stopped/unknown **不行**。
 * - 必须填核对记录 ID；该 ID 只是**人工声明**，不构成管理端自动验真。
 * - **不改变** verifiedByCloudBaseline，也不解开其它用例的阻断
 *   （轮次里若有 stopped 仍然阻断）。
 */
function acceptCloudReview(ctx, testCaseId, reviewRecordId) {
  if (typeof reviewRecordId !== 'string' || !reviewRecordId.trim()) {
    return { ok: false, code: 'TEST_DRIVER_REVIEW_ID_REQUIRED', message: '必须填写管理端核对记录 ID。' };
  }
  const got = readCase(ctx, testCaseId);
  if (got.status !== 'ok') {
    return { ok: false, code: 'TEST_DRIVER_NO_RECORD', message: '没有该用例的启动记录。' };
  }
  if (!driverProof().reviewableStates.includes(got.record.state)) {
    return {
      ok: false,
      code: 'TEST_DRIVER_REVIEW_NOT_ALLOWED',
      message: `当前状态 ${got.record.state} 不能接续；停止或未知状态不可通过核对放开。`
    };
  }
  const outcome = setCaseState(ctx, testCaseId, 'reviewed', {
    reviewRecordId: reviewRecordId.trim(),
    // **人工声明**：不改变 verifiedByCloudBaseline
    verifiedByCloudBaseline: false,
    reviewKind: 'manual-declaration',
    reviewedAt: Date.now()
  });
  if (!outcome.ok) return outcome;
  // 接续后仍须复核轮次级阻断（若有其它 stopped 用例，仍不得进入下一例）
  const round = blockingCases(ctx);
  if (round.status === 'error') {
    return { ok: false, code: 'TEST_DRIVER_STORAGE_UNAVAILABLE', message: round.reason };
  }
  return Object.assign({}, outcome, { remainingBlocking: round.blocking });
}

// ── 普通入口的反向阻断 ───────────────────────────────────────────────────

/**
 * 判断普通客户端是否应被阻止（**在普通入口首次 await 之前**调用）。
 *
 * 两个来源都查：
 * 1. 运行时占用（专用测试正在进行）；
 * 2. 轮次级持久批次（专用测试已 armed/inFlight/candidate/stopped，
 *    即便驱动已退出、页面已重进、账号已换）。
 *
 * @param {object} [options] { storage, envId, roundId, actorUserId }
 *        提供时**额外**读持久批次；不提供时只查运行时占用。
 */
function ordinaryEntryBlock(options) {
  if (RUNTIME_HOLD && RUNTIME_HOLD.owner === 'test') {
    return {
      ok: false,
      code: 'SANDBOX_TEST_DRIVER_ACTIVE',
      local: true,
      message: '专用测试驱动正在运行，本轮已阻止普通操作以避免互相打断。'
    };
  }
  if (!options || !options.storage) return null;
  const got = blockingCases(options);
  if (got.status === 'error') {
    // 读不到批次记录 ≠ 驱动在运行：如实报存储不可用（不冒充互斥码）
    return {
      ok: false,
      code: 'SANDBOX_STORAGE_UNAVAILABLE',
      local: true,
      message: `无法确认本轮专用测试批次状态（${got.reason}），已阻止普通操作。`
    };
  }
  if (got.blocking.length) {
    const detail = got.blocking.map(x => `${x.testCaseId}=${x.state}`).join('、');
    return {
      ok: false,
      code: 'SANDBOX_TEST_DRIVER_ACTIVE',
      local: true,
      message: `本轮专用测试尚未结束（${detail}）；candidate 需先完成人工接续，stopped/未知永不解锁。`
    };
  }
  return null;
}

module.exports = Object.freeze({
  BATCH_KIND,
  KNOWN_CASE_STATES,
  batchKey,
  legacyBatchKey,
  caseKey,
  digest,
  snapshotDigest,
  stableStringify,
  validateBatchDoc,
  validateLegacyBatchDoc,
  resolveStorage,
  canEnumerate,
  acquireRuntimeHold,
  releaseRuntimeHold,
  upgradeRuntimeHoldReason,
  verifyOrdinaryOwner,
  peekRuntimeHold,
  readBatch,
  readCase,
  isConsumed,
  blockingCases,
  listRoundKeys,
  preflight,
  persistArmedRecord,
  setCaseState,
  acceptCloudReview,
  ordinaryEntryBlock,
  pendingBatchesForRound,
  _resetRuntimeHoldForTest,
  _setProofForTest
});