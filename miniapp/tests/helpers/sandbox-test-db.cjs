// 施工安排独立测试副本：测试替身。
//
// 这是隔离验证的核心装置（方案 §5.2 + Codex 审查 R6/R7 + Codex 复核 T5）：
// - 底层替身**只接受带 schtest_v1_ 前缀的集合名**；遇到任何无前缀集合立即抛错。
// - 记录全部集合访问与写入，供断言"访问过哪些集合""是否零写入"。
// - **add 拒绝重复主键**（模拟平台唯一约束），支撑本轮唯一项目与幂等结论。
// - runTransaction 支持**同一次调用内重入回调**（模拟 SDK 冲突重试），
//   并提供可控屏障/提交前暂停用于并发测试。
// - **并发事务提交有冲突检测**：基于版本号的乐观并发控制，
//   提交时若基线版本已变化则抛冲突，不静默覆盖。
//
// T5 修复的核心（此前版本把事务数据放在**共享** data 上，导致脏读）：
// - `data` 只保存**已提交**数据。
// - 每个事务 attempt 拥有**自己的写集**（overlay），事务内的读写只作用于该 overlay。
// - 事务内的读**能**看到本 attempt 已写、**看不到**其它 attempt 未提交的内容，
//   事务外与其他事务同样看不到（提交前对外不可见）。
// - 提交成功才把 overlay 落进 `data` 并把本 attempt 的写日志并入全局 writeLog。
// - 失败/冲突只**丢弃本 attempt 的 overlay 与写日志**，
//   既不回滚共享数据，也不截断其它事务已提交的写日志。
//
// 重要边界：本替身**不是**平台事务模型，只是内存近似。
// 不据此声称已验证平台事务语义。

'use strict';

const { PREFIX, LOGICAL_COLLECTIONS } = require('../../cloudfunctions/scheduleSandbox/collection-map');

class UnprefixedCollectionError extends Error {
  constructor(name) {
    super(`测试副本访问了未加前缀的集合「${name}」，隔离已被破坏。`);
    this.name = 'UnprefixedCollectionError';
    this.code = 'UNPREFIXED_COLLECTION_ACCESS';
  }
}

class DuplicateKeyError extends Error {
  constructor(collection, key) {
    super(`集合「${collection}」已存在主键「${key}」，写入被拒绝。`);
    this.name = 'DuplicateKeyError';
    this.code = 'DUPLICATE_KEY';
  }
}

class TransactionConflictError extends Error {
  constructor(message) {
    super(message || '事务提交冲突');
    this.name = 'TransactionConflictError';
    this.code = 'TRANSACTION_CONFLICT';
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// 深拷贝一层集合内容（每份文档单独拷贝，避免共享引用）。
function cloneValues(source) {
  const out = {};
  for (const name of Object.keys(source)) {
    const bucket = {};
    for (const key of Object.keys(source[name])) bucket[key] = clone(source[name][key]);
    out[name] = bucket;
  }
  return out;
}

function createSandboxTestDb(seed = {}, options = {}) {
  // 预置数据同样只放在带前缀的集合下。
  let data = {};
  for (const logical of LOGICAL_COLLECTIONS) data[PREFIX + logical] = {};
  for (const [key, value] of Object.entries(seed)) {
    if (!key.startsWith(PREFIX)) throw new UnprefixedCollectionError(key);
    data[key] = value;
  }

  const accessLog = [];
  const writeLog = [];
  let operationCount = 0;
  // 一次性故障注入（failNextWrite / failNextRead）
  let failOnce = null;

  // 全局版本号：只在**已提交**状态变化时推进，用于乐观并发冲突检测。
  let globalVersion = 0;

  // reentry: 指定第 N 次 attempt 制造冲突（0 基）。模拟 SDK 在同次 runTransaction 内重调回调。
  const reentryPlan = options.reentry || null;
  let attemptIndex = 0;
  const attempts = [];

  // barrier: 可控屏障，在回调完成、提交之前让出，用于制造真实并发交错。
  const barrier = options.barrier || null;
  // pauseBeforeCommit: 只暂停 attempt 0，用于验证"未提交写入对外不可见"。
  const pauseBeforeCommit = options.pauseBeforeCommit || null;

  function buildQuery(items, query) {
    let list = Object.values(items)
      .filter(item => Object.entries(query).every(([k, v]) => item[k] === v))
      .map(clone);
    const orderBy = [];
    let limit = null;
    let skip = 0;
    const chain = {
      orderBy: (field, direction = 'asc') => { orderBy.push({ field, direction }); return chain; },
      limit: n => { limit = n; return chain; },
      skip: n => { skip = n; return chain; },
      get: async () => {
        if (orderBy.length) {
          list.sort((a, b) => {
            for (const o of orderBy) {
              const va = a[o.field];
              const vb = b[o.field];
              if (va === undefined && vb === undefined) continue;
              if (va === undefined) return o.direction === 'desc' ? 1 : -1;
              if (vb === undefined) return o.direction === 'desc' ? -1 : 1;
              if (va < vb) return o.direction === 'desc' ? 1 : -1;
              if (va > vb) return o.direction === 'desc' ? -1 : 1;
            }
            return 0;
          });
        }
        let out = list.slice(skip);
        if (typeof limit === 'number') out = out.slice(0, limit);
        return { data: out };
      }
    };
    return chain;
  }

  // 命中注入点则抛出并清除（一次性）
  function maybeFailWrite(collectionName, op) {
    if (!failOnce || failOnce.kind !== 'write') return;
    if (failOnce.collection !== collectionName || failOnce.op !== op) return;
    const message = failOnce.message;
    failOnce = null;
    const error = new Error(message);
    error.code = 'INJECTED_WRITE_FAILURE';
    throw error;
  }

  function maybeFailRead(collectionName, op) {
    if (!failOnce || failOnce.kind !== 'read') return;
    if (failOnce.collection !== collectionName || failOnce.op !== op) return;
    // 可选前置条件：只在条件成立时命中（用于精确命中"提交后"的那次读）
    if (typeof failOnce.when === 'function' && !failOnce.when()) return;
    const message = failOnce.message;
    failOnce = null;
    const error = new Error(message);
    error.code = 'INJECTED_READ_FAILURE';
    throw error;
  }

  function assertKnownCollection(actualName) {
    // 隔离闸门：只接受带前缀且已登记的集合名。
    if (typeof actualName !== 'string' || !actualName.startsWith(PREFIX)) {
      throw new UnprefixedCollectionError(String(actualName));
    }
    if (!Object.prototype.hasOwnProperty.call(data, actualName)) {
      // 未登记的带前缀集合同样拒绝：映射表与替身必须一致。
      throw new UnprefixedCollectionError(actualName);
    }
  }

  /**
   * 包装一个集合视图。
   * @param values  读写的目标（事务 attempt 的 overlay，或已提交的 data）
   * @param actualName 带前缀的集合名
   * @param attempt  事务 attempt 上下文；非事务视图传 null
   */
  function wrapCollection(values, actualName, attempt) {
    assertKnownCollection(actualName);
    const record = entry => {
      if (!attempt) writeLog.push(entry);
      else attempt.writes.push(entry);
    };
    return {
      doc: key => ({
        get: async () => {
          operationCount++;
          accessLog.push({ op: 'doc.get', collection: actualName, key });
          maybeFailRead(actualName, 'doc.get');
          const found = Object.prototype.hasOwnProperty.call(values[actualName], key)
            ? values[actualName][key] : null;
          return { data: found ? clone(found) : null };
        },
        update: async ({ data: patch }) => {
          operationCount++;
          accessLog.push({ op: 'doc.update', collection: actualName, key });
          maybeFailWrite(actualName, 'update');
          if (!Object.prototype.hasOwnProperty.call(values[actualName], key)) throw new Error('doc not found');
          if (Object.prototype.hasOwnProperty.call(patch, '_id')) {
            const error = new Error('不能更新_id的值');
            error.code = 'INVALID_PARAM';
            throw error;
          }
          values[actualName][key] = { ...values[actualName][key], ...clone(patch) };
          record({ op: 'update', collection: actualName, key, data: clone(patch) });
        },
        remove: async () => {
          operationCount++;
          accessLog.push({ op: 'doc.remove', collection: actualName, key });
          maybeFailWrite(actualName, 'remove');
          delete values[actualName][key];
          record({ op: 'remove', collection: actualName, key });
        }
      }),
      where: query => {
        operationCount++;
        accessLog.push({ op: 'where', collection: actualName });
        maybeFailRead(actualName, 'where');
        return buildQuery(values[actualName], query);
      },
      add: ({ data: value }) => {
        operationCount++;
        accessLog.push({ op: 'add', collection: actualName });
        maybeFailWrite(actualName, 'add');
        // **拒绝重复主键**：模拟平台唯一约束，支撑本轮唯一项目结论
        if (value && value._id !== undefined
          && Object.prototype.hasOwnProperty.call(values[actualName], value._id)) {
          throw new DuplicateKeyError(actualName, value._id);
        }
        values[actualName][value._id] = clone(value);
        record({ op: 'add', collection: actualName, key: value && value._id, data: clone(value) });
        return Promise.resolve({ _id: value._id });
      }
    };
  }

  // 事务外的普通集合视图：直接作用于已提交数据，提交即推进版本。
  // 真实平台中「事务对象」与「数据库句柄」不是同一份状态，
  // 因此这里**不跟随**任何 attempt 的 overlay。
  function directCollection(actualName) {
    assertKnownCollection(actualName);
    const bump = fn => (...args) => {
      const out = fn(...args);
      if (out && typeof out.then === 'function') {
        return out.then(v => { globalVersion++; return v; }, e => { throw e; });
      }
      globalVersion++;
      return out;
    };
    return {
      doc: key => {
        const inner = wrapCollection(data, actualName, null).doc(key);
        return { get: inner.get, update: bump(inner.update), remove: bump(inner.remove) };
      },
      where: query => wrapCollection(data, actualName, null).where(query),
      add: bump(wrapCollection(data, actualName, null).add)
    };
  }

  /**
   * 执行一次事务 attempt。
   * 写集是**本 attempt 独占**的 overlay；提交前对外不可见。
   */
  async function runTransactionOnce(work) {
    const current = attemptIndex++;
    attempts.push(current);
    const attempt = { index: current, baseVersion: globalVersion, overlay: cloneValues(data), writes: [] };
    const tx = { collection: name => wrapCollection(attempt.overlay, name, attempt) };
    try {
      const result = await work(tx);
      // 提交前让出：用于制造真实并发交错与"未提交不可见"验证
      if (barrier) await barrier(current, attempt);
      if (pauseBeforeCommit && current === 0) await pauseBeforeCommit(attempt);
      if (reentryPlan && current < reentryPlan) {
        // 模拟 SDK 冲突：丢弃本 attempt 写集，要求重入回调
        throw new TransactionConflictError('模拟 SDK 冲突，需重入回调');
      }
      commitAttempt(attempt);
      return result;
    } catch (error) {
      // 失败/冲突：**只丢弃本 attempt 的 overlay 与写日志**。
      // 共享的已提交数据与其它事务的写日志完全不动。
      attempt.overlay = null;
      attempt.writes.length = 0;
      throw error;
    }
  }

  /** 提交：先做冲突检测，通过后才把 overlay 落进已提交数据。 */
  function commitAttempt(attempt) {
    if (attempt.baseVersion !== globalVersion) {
      throw new TransactionConflictError('事务基线版本已变化，提交被拒绝。');
    }
    data = attempt.overlay;
    for (const entry of attempt.writes) writeLog.push(entry);
    attempt.writes.length = 0;
    globalVersion++;
  }

  async function runTransaction(work) {
    if (typeof work !== 'function') throw new Error('transaction work must be function');
    // **同一次 runTransaction 调用内重入回调**（模拟 SDK 行为），而非外部重新调用。
    // 冲突与重复主键都会触发 SDK 重入，因此两者都要重试。
    const maxAttempts = reentryPlan ? reentryPlan + 2 : 3;
    let lastError = null;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await runTransactionOnce(work);
      } catch (error) {
        if (error instanceof TransactionConflictError || (error && error.code === 'DUPLICATE_KEY')) {
          lastError = error;
          continue; // SDK 会用同一个 work 回调重入
        }
        throw error;
      }
    }
    throw lastError || new TransactionConflictError('事务反复冲突');
  }

  return {
    runTransaction,
    collection: name => directCollection(name),
    // 只读快照：**已提交**数据（不含任何未提交写集）。
    getData: () => cloneValues(data),
    getPrefixedData: () => cloneValues(data),
    getAccessLog: () => accessLog.slice(),
    getWriteLog: () => writeLog.slice(),
    getOperationCount: () => operationCount,
    getAttempts: () => attempts.slice(),
    // 故障注入：命中时在下一次对应写/读操作上抛错（用于**真实**回执写失败、
    // 提交后回执读取失败等场景）。一次性生效，命中后自动清除。
    failNextWrite(collectionName, op, message) {
      failOnce = { kind: 'write', collection: collectionName, op, message: message || 'INJECTED_WRITE_FAILURE' };
    },
    failNextRead(collectionName, op, message, when) {
      failOnce = { kind: 'read', collection: collectionName, op, message: message || 'INJECTED_READ_FAILURE', when: when || null };
    },
    getGlobalVersion: () => globalVersion,
    getVisitedCollections: () => [...new Set(accessLog.map(x => x.collection))].sort(),
    reset: () => { accessLog.length = 0; writeLog.length = 0; operationCount = 0; }
  };
}

module.exports = {
  createSandboxTestDb,
  UnprefixedCollectionError,
  DuplicateKeyError,
  TransactionConflictError,
  PREFIX
};
