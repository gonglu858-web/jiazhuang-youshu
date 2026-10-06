// 施工安排独立测试副本：固定集合映射层。
//
// 目的：把已验收业务实现使用的 11 个「逻辑集合名」固定映射到带
// `schtest_v1_` 前缀的测试集合，使业务代码无需任何改动即可在测试副本中运行，
// 且**不可能**误访问无前缀的旧集合。
//
// 关键约束（方案 §4.1 + Codex 审查 R6）：
// 1. 映射是固定表，不做「任意名称自动加前缀」；表外名称立即拒绝。
// 2. **映射表无原型**（null prototype），并用自有属性严格校验，
//    `constructor` / `__proto__` / `toString` 等继承名一律拒绝，零下层调用。
// 3. 普通读取、查询、写入以及 runTransaction 回调中的事务对象都必须映射。
// 4. SDK 因冲突重入事务时会重新调用回调，每次都必须重新包装事务对象。
// 5. 不暴露原始数据库句柄，业务层无法绕过映射。
// 6. 未实现 API 显式抛错，不静默透传。
// 7. **包装对象不可改写**：set / defineProperty / delete / setPrototypeOf 均被拒绝。
// 8. 返回值限定为已登记的字符串，不把 function/object 传给下层。

'use strict';

// 11 个逻辑集合 → 前缀集合。顺序固定，便于打包与核对。
const PREFIX = 'schtest_v1_';
const LOGICAL_COLLECTIONS = Object.freeze([
  'users',
  'app_admins',
  'projects',
  'project_members',
  'invitations',
  'audit_events',
  'schedules',
  'schedule_revisions',
  'schedule_occupancy',
  'member_task_guard',
  'schedule_receipts'
]);

// 固定映射表：**无原型**对象，冻结。
// 构造时先建空对象再逐项写入，避免任何继承键混入。
const COLLECTION_MAP = Object.freeze(LOGICAL_COLLECTIONS.reduce((acc, name) => {
  acc[name] = PREFIX + name;
  return acc;
}, Object.create(null)));

// 逻辑名集合（同样无原型），用于严格校验。
const LOGICAL_SET = Object.freeze(LOGICAL_COLLECTIONS.reduce((acc, name) => {
  acc[name] = true;
  return acc;
}, Object.create(null)));

class SandboxConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxConfigError';
    this.code = code;
  }
}

function deny(code, message) {
  throw new SandboxConfigError(code, message);
}

// 严格校验：必须是自有属性且值为已登记字符串。
// 不依赖真值判断，杜绝原型链上的 constructor/toString/__proto__ 被当成已登记名称。
function mapCollection(name) {
  if (typeof name !== 'string' || name === '') {
    deny('UNMAPPED_COLLECTION', '集合名必须是非空字符串。');
  }
  // hasOwnProperty 判定，杜绝原型链命中
  if (!Object.prototype.hasOwnProperty.call(LOGICAL_SET, name)) {
    deny('UNMAPPED_COLLECTION', `测试副本未登记集合「${name}」，已拒绝访问。`);
  }
  const mapped = COLLECTION_MAP[name];
  if (typeof mapped !== 'string' || !Object.prototype.hasOwnProperty.call(COLLECTION_MAP, name)) {
    deny('UNMAPPED_COLLECTION', `集合「${name}」的映射值不合法，已拒绝访问。`);
  }
  return mapped;
}

// 已映射的实际名 → 逻辑名。反向映射使用严格相等遍历，不查表，避免原型问题。
function unmapCollection(actual) {
  if (typeof actual !== 'string' || actual === '') {
    deny('UNMAPPED_COLLECTION', '集合名必须是非空字符串。');
  }
  const entry = LOGICAL_COLLECTIONS.find(logical => COLLECTION_MAP[logical] === actual);
  if (!entry) {
    deny('UNMAPPED_COLLECTION', `集合「${actual}」不在测试副本登记表中，已拒绝访问。`);
  }
  return entry;
}

// 业务实现实际使用到的方法。出现表外方法即抛错，不静默透传。
const QUERY_CHAIN_METHODS = Object.freeze(['orderBy', 'limit', 'skip', 'get']);
const COLLECTION_METHODS = Object.freeze(['doc', 'where', 'add']);
const DOC_METHODS = Object.freeze(['get', 'update', 'remove']);

function assertKnownMethod(kind, method, allowed) {
  if (typeof method !== 'string' || method === '') {
    deny('UNSUPPORTED_DB_API', `${kind} 调用缺少方法名。`);
  }
  if (allowed.includes(method)) return;
  deny('UNSUPPORTED_DB_API', `${kind} 方法「${method}」未在测试副本适配层实现，已拒绝（不静默透传）。`);
}

// 冻结保护：拒绝 set / defineProperty / deleteProperty / setPrototypeOf。
// 注意：**先冻结底层目标对象，再包代理**——若对代理本身调用 Object.freeze，
// 会触发本代理的 defineProperty 陷阱而抛错。
function sealWrapper(target, logicalName, kind, allowed) {
  // 双重保证：底层目标冻结（数据不可变）+ 代理拦截写类操作（行为不可绕过）
  Object.freeze(target);
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === '__sandboxLogicalName') return logicalName;
      if (prop === '__sandboxKind') return kind;
      if (typeof prop === 'symbol') return obj[prop];
      if (Object.prototype.hasOwnProperty.call(obj, prop)) return obj[prop];
      // 表外方法名：显式拒绝，不返回 undefined 造成难懂的 TypeError
      if (prop === 'then' || prop === 'constructor' || prop === 'toString' || prop === '__proto__') {
        // 这些不是业务方法，返回 undefined 即可；不进入 SDK
        return undefined;
      }
      assertKnownMethod(kind, prop, allowed);
      return undefined;
    },
    set() {
      deny('SANDBOX_READONLY_HANDLE', '测试副本数据库句柄不可被改写。');
    },
    defineProperty() {
      deny('SANDBOX_READONLY_HANDLE', '测试副本数据库句柄不可被改写。');
    },
    deleteProperty() {
      deny('SANDBOX_READONLY_HANDLE', '测试副本数据库句柄不可被改写。');
    },
    setPrototypeOf() {
      deny('SANDBOX_READONLY_HANDLE', '测试副本数据库句柄不可被改写。');
    },
    getPrototypeOf(target) {
      // 目标已冻结，代理必须返回其真实原型，否则引擎抛错。
      // 真正的原型防护在 mapCollection 的严格自有属性校验，不依赖此陷阱。
      return Object.getPrototypeOf(target);
    }
  });
}

// 文档级包装：get / update / remove。
function wrapDoc(logicalName, docRef) {
  const wrapped = {};
  for (const method of DOC_METHODS) {
    if (typeof docRef[method] !== 'function') continue;
    wrapped[method] = (...args) => docRef[method](...args);
  }
  return sealWrapper(wrapped, logicalName, 'doc', DOC_METHODS);
}

// 查询链包装：orderBy / limit / skip / get。
function wrapQueryChain(logicalName, chain) {
  const wrapped = {};
  for (const method of ['orderBy', 'limit', 'skip']) {
    if (typeof chain[method] !== 'function') continue;
    wrapped[method] = (...args) => wrapQueryChain(logicalName, chain[method](...args));
  }
  if (typeof chain.get === 'function') {
    wrapped.get = (...args) => chain.get(...args);
  }
  return sealWrapper(wrapped, logicalName, 'where', QUERY_CHAIN_METHODS);
}

// 集合级包装：doc / where / add。三个入口都先经过映射。
function wrapCollection(source, logicalName) {
  const actualName = mapCollection(logicalName); // 先映射，未登记即拒
  const collectionRef = source.collection(actualName);
  // 只接受对象/函数句柄，字符串以外一律拒绝（R6：不再把非字符串传给下层）
  if (collectionRef === null || (typeof collectionRef !== 'object' && typeof collectionRef !== 'function')) {
    deny('BAD_DB_HANDLE', `集合「${logicalName}」的底层句柄不可用。`);
  }
  const wrapped = {};

  if (typeof collectionRef.doc === 'function') {
    wrapped.doc = key => {
      if (typeof key !== 'string' || key === '') {
        deny('BAD_DOC_KEY', '文档主键必须是非空字符串。');
      }
      return wrapDoc(logicalName, collectionRef.doc(key));
    };
  }
  if (typeof collectionRef.where === 'function') {
    wrapped.where = query => {
      if (!query || typeof query !== 'object' || Array.isArray(query)) {
        deny('BAD_QUERY', '条件查询参数必须是非数组对象。');
      }
      return wrapQueryChain(logicalName, collectionRef.where(query));
    };
  }
  if (typeof collectionRef.add === 'function') {
    wrapped.add = args => {
      if (!args || typeof args !== 'object' || !args.data || typeof args.data !== 'object') {
        deny('BAD_ADD_PAYLOAD', '写入参数必须包含 data 对象。');
      }
      return collectionRef.add(args);
    };
  }
  return sealWrapper(wrapped, logicalName, 'collection', COLLECTION_METHODS);
}

// 数据库视图：事务外使用。collection 必须登记；runTransaction 包装回调内的 tx。
//
// 事务委托（Codex 复核 S2）：包装层需要把「本轮唯一记录」与「业务创建项目」放进
// **同一次真实事务**，而真实事务由**业务实现**发起（`createProject` 内部调用
// `db.runTransaction`）。因此这里不自己开事务，而是：
// 1. 业务层开启事务时，在**同一个**事务回调内先执行「已登记的 enlist 写入」；
// 2. enlist 写入与业务工作在同一次事务内，一起提交或一起回滚。
// 这样保持**单层真实事务**、原业务权限检查、操作预算与失败整体回滚。
//
// **每个请求必须用 `createSandboxDb` 单独创建视图**：enlist 槽是每视图一个，
// 并发请求各写各的槽，互不抢占（共享一个视图会导致并发请求互相消费 enlist）。
function createSandboxDb(rawDb) {
  if (!rawDb || typeof rawDb.collection !== 'function') {
    deny('BAD_DB_HANDLE', '缺少可用的数据库句柄。');
  }
  if (typeof rawDb.runTransaction !== 'function') {
    deny('TRANSACTION_UNAVAILABLE', '当前数据库不支持所需的原子操作，已停止写入。');
  }

  // 本视图待 enlist 的写入（只影响下一个真实事务）
  let pendingEnlist = null;

  return Object.freeze({
    collection(logicalName) {
      return wrapCollection(rawDb, logicalName);
    },
    /**
     * 登记 enlist 写入，返回释放函数。
     * 必须在业务层 runTransaction 之前调用；写入会在该事务内、且早于业务工作执行。
     */
    enlist(writeFn) {
      if (typeof writeFn !== 'function') {
        deny('BAD_ENLIST', 'enlist 需要一个写入函数。');
      }
      if (pendingEnlist) {
        deny('BAD_ENLIST', '本视图已有待提交的唯一记录写入。');
      }
      pendingEnlist = writeFn;
      return () => { pendingEnlist = null; };
    },
    hasEnlist() {
      return pendingEnlist !== null;
    },
    runTransaction(work) {
      if (typeof work !== 'function') {
        deny('BAD_TRANSACTION_WORK', '事务回调必须是函数。');
      }
      // enlist 槽在**整个 runTransaction 调用期间保留**：
      // SDK 因冲突重入会重新调用回调，每次 attempt 都必须重新执行 enlist 写入，
      // 否则重试的那次 attempt 会漏写唯一记录。
      const enlist = pendingEnlist;
      return rawDb.runTransaction(rawTx => {
        if (!rawTx || typeof rawTx.collection !== 'function') {
          deny('BAD_TRANSACTION_HANDLE', '事务句柄不可用。');
        }
        // 事务对象同样只暴露映射后的集合；业务层拿不到 rawTx。
        const view = Object.freeze({
          collection(logicalName) {
            return wrapCollection(rawTx, logicalName);
          }
        });
        // enlist 写入与业务工作在**同一事务**内，且 enlist 先执行。
        // 业务工作抛错时，enlist 写入随事务一起回滚（真实平台语义）。
        return (async () => {
          if (enlist) await enlist(view);
          return work(view);
        })();
      }).finally(() => {
        // 事务最终结束（成功或失败）后释放槽位
        if (pendingEnlist === enlist) pendingEnlist = null;
      });
    }
  });
}

module.exports = Object.freeze({
  PREFIX,
  LOGICAL_COLLECTIONS,
  COLLECTION_MAP,
  SandboxConfigError,
  mapCollection,
  unmapCollection,
  createSandboxDb
});
