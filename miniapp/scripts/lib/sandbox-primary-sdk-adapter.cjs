'use strict';
/**
 * 首次管理员初始化：SDK 薄适配层（node-sdk 2.10.0 / @cloudbase/database 1.4.1）
 *
 * 定位与边界
 * ─────────
 * 本文件**只做参数转换与边界校验**，把 P4 业务核心（sandbox-primary-bootstrap.cjs）
 * 已固定的调用契约映射到已取得的 CloudBase 手动事务接口。它**不**：
 *   - 读取任何认证文件、环境变量或凭据；
 *   - 猜测或选择环境、加载全局 SDK、初始化 SDK；
 *   - 联网、自己创建数据库实例；
 *   - 判定调用者身份（由受控宿主注入的核验函数负责）；
 *   - 改变核心的「已有 primary 不覆盖 / 审计恰好一条 / 未知结果停止」语义。
 *
 * 依赖注入（db + verifyCaller）**只是本地边界，不是安全授权机制，
 * 也不是生产受信来源**。生产调用者核验尚未实现：缺少核验函数或核验未通过时，
 * 在**开始事务之前**就拒绝。绝不硬编码 allowed:true，也不把 CLI/计划里的
 * approvedBy、operatorRef、批准名单或 trusted 标记当成平台身份。
 *
 * 真实包离线核对结论（本机实测，见 docs/首次管理员SDK适配说明-20261006.md）
 * ────────────────────────────────────────────────────────────────────────
 *  1. 实际入口是 database `dist/commonjs/index.js` 引用的 `./transaction/index`。
 *  2. `db.startTransaction()` → `tx.collection(name).doc(id).get()/set()`
 *     → `tx.commit()` / `tx.rollback()`。
 *  3. 合成成功空列表经真实 SDK 转换后：事务读取为 `{data:null}`，
 *     非事务读取为 `{data:[]}`。这是**转换实测，不是平台缺记录实测**。
 *  4. `doc(id).set(fields)` 用**裸字段对象**。注意：要求是**本适配层不得错误地
 *     再嵌套一层** `{data: fields}` —— SDK 可能把它当作业务字段保存，并不必然
 *     替我们拦截。`_id` 必须与独立 id 参数核对一致，再从**新复制**的写对象里剔除，
 *     绝不改动核心传来的对象。
 *  5. 真实 SDK 的 `set({_id:...})` 在发到传输层前就会拒绝（本条为实测结论；
 *     但这不意味着「错误的嵌套写法」也会被 SDK 拦截，见第 4 条）。
 *  6. 文档方法可能返回**含 code 的错误对象**；不得用 `result.data || null`
 *     把拒绝或异常变成「记录不存在」。
 *  7. commit 的含 code 错误会抛出；rollback 调用 abortTransaction。
 *     未知提交结果不得描述为已回滚，不得自动再次初始化。
 */

const PREFIX = '[sdk-adapter] ';

// 与 P4 核心一致的固定常量（核心自约束，本层再做一次防御性核对）
const FIXED_APP_ID = 'wxfb4db1615ac15531';
const FIXED_ENV_ID = 'cloud1-d8gcq5ag39d847723';
const FIXED_REGION = 'ap-shanghai';

const READ_COLLECTIONS = Object.freeze([
  'schtest_v1_users',
  'schtest_v1_app_admins',
  'schtest_v1_audit_events'
]);
const WRITE_COLLECTIONS = Object.freeze([
  'schtest_v1_app_admins',
  'schtest_v1_audit_events'
]);
const PRIMARY_ID = 'primary';

const MAX_SET_RETRIES = 0; // 明确：不重试
const MAX_COMMIT_RETRIES = 0; // 明确：不重试

class AdapterError extends Error {
  constructor(code, message, detail) {
    super(PREFIX + message);
    this.name = 'AdapterError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * 允许保留的异常类型名白名单（R5）。
 *
 * 依赖边界抛出的异常，其 `name` **可以是任意字符串**，因此不能原样透出
 * ——否则合成敏感标记会经originalErrorName 进入本层的公开输出。
 * 不在白名单内的一律归一为 'Error'。
 */
const ALLOWED_ERROR_NAMES = Object.freeze(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);

/**
 * 对外净化（R5）：**依赖边界抛出的任意异常只映射为本层固定码与固定文案**。
 *
 * - 不信任异常的 `message`（可能含路径、主机、凭据片段或合成标记）；
 * - 不信任异常的 `code`（可能是外部构造的任意值）；
 * - **不凭 instanceof 信任自由 message/code**：即便异常是本模块导出的
 *   AdapterError，只要它来自依赖边界（SDK 或注入依赖抛出），同样按固定文案处理。
 *   本层自己生成的固定错误由 `deny()` 抛出，不经此函数。
 * - `name` 只保留白名单内的名称，否则统一 'Error'。
 *
 * @returns {{code: string, message: string, originalErrorName: string}}
 */
function sanitizeFailure(error, fallbackCode, fallbackMessage) {
  const rawName = (error && typeof error.name === 'string') ? error.name : '';
  const safeName = ALLOWED_ERROR_NAMES.includes(rawName) ? rawName : 'Error';
  return {
    code: fallbackCode,
    message: fallbackMessage,
    originalErrorName: safeName
  };
}

function deny(code, message) {
  throw new AdapterError(code, message);
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function text(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 稳定的浅拷贝：剔除 _id 时**不动**调用方对象。 */
function copyWithoutId(doc) {
  if (!isPlainObject(doc)) deny('DOC_NOT_OBJECT', '写入文档必须是对象。');
  const out = {};
  for (const key of Object.keys(doc)) {
    if (key === '_id') continue;
    out[key] = doc[key];
  }
  return out;
}

/**
 * 核对写对象的 _id 与独立 id 参数一致。
 * 规则：缺 _id 视为「调用方未声明主键」→ 由适配层按独立 id 补齐后再剔除；
 *       带 _id 且不一致 → 拒绝（不猜测、不覆盖）。
 */
function reconcileId(id, doc) {
  if (!text(id)) deny('DOC_ID_INVALID', '文档主键必须是非空字符串。');
  if (!isPlainObject(doc)) deny('DOC_NOT_OBJECT', '写入文档必须是对象。');
  if (!Object.prototype.hasOwnProperty.call(doc, '_id')) {
    return copyWithoutId(doc);
  }
  if (doc._id !== id) {
    deny('DOC_ID_MISMATCH', '写对象的 _id 与独立主键参数不一致，已拒绝。');
  }
  return copyWithoutId(doc);
}

/**
 * 把真实 SDK 的文档读取结果转成核心期望的形状。
 *
 * R1 修正：**只接受当前 SDK 已核实的两种成功空形状**，不做兼容性猜测。
 *   - 事务读取：成功空仅 `data === null`（真实 SDK 转换实测）
 *   - 非事务读取：成功空仅 `data` 为 `[]`（真实 SDK 转换实测）
 * `data` 缺失、为 `undefined`、或任何其它结构 → 拒绝。
 * 事务读返回数组、普通读返回裸对象这些**未核实**的形状本轮不再接受。
 *
 * 另：**非空记录必须带与查询 key 一致的 `_id`**。主键不匹配即拒绝，
 * 不能把别的记录当成本计划的记录继续用。
 *
 * 关键：**含 code 的对象是拒绝，不是缺记录**。
 *
 * @param {object} result    真实 SDK 的文档方法返回值
 * @param {object} options   { mode: 'transaction'|'plain', expectedKey: string }
 */
function normalizeDoc(result, options) {
  const opts = options || {};
  const mode = opts.mode === 'plain' ? 'plain' : 'transaction';
  const expectedKey = opts.expectedKey;

  if (!isPlainObject(result)) {
    // 非对象（含 undefined/null）：无法判断是缺记录还是异常 → 拒绝
    deny('READ_SHAPE_INVALID', '文档读取返回的不是对象，无法确认是缺记录还是异常。');
  }
  if (result.code !== undefined && result.code !== null) {
    // 真实 SDK 的错误对象：data 为 undefined。绝不能归一化成「不存在」。
    deny('READ_REJECTED_BY_SERVER', '文档读取被拒绝（返回错误码），不是记录不存在。');
  }
  // R1：**必须显式有 data 字段**。缺 data（undefined）说明形状不对，
  // 不能与「显式 null = 无记录」混为一谈。
  if (!Object.prototype.hasOwnProperty.call(result, 'data')) {
    deny('READ_SHAPE_INVALID', '文档读取结果缺少 data 字段，无法确认是缺记录还是异常。');
  }
  const data = result.data;

  if (mode === 'transaction') {
    // 事务成功空：仅接受显式 null
    if (data === null) return null;
    // 事务返回非空记录：必须是对象且主键匹配
    if (isPlainObject(data)) return assertKeyMatch(data, expectedKey);
    deny('READ_SHAPE_INVALID', '事务读取的数据形状未核实，不予接受。');
  }

  // 非事务成功空：仅接受空数组
  if (!Array.isArray(data)) {
    deny('READ_SHAPE_INVALID', '非事务读取的 data 不是数组，形状未核实，不予接受。');
  }
  if (data.length === 0) return null;
  if (data.length > 1) {
    deny('READ_SHAPE_INVALID', '非事务读取返回了多条记录，无法确认主键，拒绝。');
  }
  if (!isPlainObject(data[0])) {
    deny('READ_SHAPE_INVALID', '非事务读取返回的记录不是对象，拒绝。');
  }
  return assertKeyMatch(data[0], expectedKey);
}

/** 非空记录必须带与查询 key 一致的 _id（R1）。 */
function assertKeyMatch(doc, expectedKey) {
  if (!text(expectedKey)) {
    deny('READ_KEY_UNSPECIFIED', '读取未指定期望主键，无法核对记录身份，拒绝。');
  }
  if (doc._id === undefined || doc._id === null) {
    deny('READ_KEY_MISSING', '读取到的记录缺少 _id，无法确认身份，拒绝。');
  }
  if (doc._id !== expectedKey) {
    deny('READ_KEY_MISMATCH', '读取到的记录 _id 与查询主键不一致，拒绝。');
  }
  return doc;
}

/**
 * set 的成功判定（R2 修正）。
 *
 * 以**当前真实 SDK 的最终返回形状**为准：事务 set 转换后返回
 * `{ updated, upserted: [...], requestId }`。
 * 判定规则：
 *   - 必须是对象；含 code → 拒绝；
 *   - `updated` 必须是**有限非负整数**（拒绝 NaN / 负数 / 非整数）；
 *   - `updated` 至多为 1（单文档语义）；
 *   - `updated === 0` 时必须有 `upserted` 数组且其中含**与目标主键一致**的插入结果；
 *   - **不接受**未核实的 `updatedCount` 或底层 `upsert_id` 作为替代成功凭据。
 *
 * @param {object} result
 * @param {string} expectedKey 本次写入的目标主键
 */
function assertSetSuccess(result, expectedKey) {
  if (!isPlainObject(result)) {
    deny('SET_SHAPE_INVALID', '写入返回的不是对象，无法确认是否成功。');
  }
  if (result.code !== undefined && result.code !== null) {
    deny('SET_REJECTED_BY_SERVER', '写入被拒绝（返回错误码）。');
  }
  // R2：只认已核实的最终返回形状；updatedCount / upsert_id 不作为替代凭据
  if (result.updatedCount !== undefined) {
    deny('SET_SHAPE_INVALID', '写入结果含未核实的 updatedCount 字段，不作为成功凭据。');
  }
  if (result.upsert_id !== undefined && !Array.isArray(result.upserted)) {
    deny('SET_SHAPE_INVALID', '写入结果只有底层 upsert_id，缺少已核实的 upserted 数组，不予接受。');
  }
  if (result.updated === undefined) {
    deny('SET_SHAPE_INVALID', '写入结果缺少已核实的 updated 字段，不允许核心继续提交。');
  }
  const updated = result.updated;
  if (typeof updated !== 'number' || !Number.isFinite(updated) || !Number.isInteger(updated)) {
    deny('SET_SHAPE_INVALID', '写入结果 updated 不是有限非负整数。');
  }
  if (updated < 0) {
    deny('SET_SHAPE_INVALID', '写入结果 updated 为负数。');
  }
  if (updated > 1) {
    deny('SET_SHAPE_INVALID', '写入结果 updated 超过 1，与单文档语义不符。');
  }
  if (updated === 0) {
    // 零更新必须伴随一条与目标主键一致的插入结果，否则不算成功
    const upserted = result.upserted;
    if (!Array.isArray(upserted) || upserted.length === 0) {
      deny('SET_SHAPE_INVALID', '写入零更新且没有插入结果，无法确认是否成功。');
    }
    const matched = upserted.some(item => (isPlainObject(item) ? item._id : item) === expectedKey);
    if (!matched) {
      deny('SET_KEY_MISMATCH', '写入插入结果的主键与目标主键不一致。');
    }
  }
  return true;
}

/** 集合与主键边界：读三、写二；users 永不可写。 */
function assertReadAllowed(collection, key) {
  if (!READ_COLLECTIONS.includes(collection)) {
    deny('COLLECTION_NOT_ALLOWED', `集合不在只读白名单内，已拒绝：${collection}`);
  }
  if (!text(key)) deny('DOC_ID_INVALID', '读取主键必须是非空字符串。');
  return { collection, key };
}

function assertWriteAllowed(collection, key) {
  if (!WRITE_COLLECTIONS.includes(collection)) {
    // 单独点名 users，避免「只读集合被误当可写」时信息含糊
    if (collection === 'schtest_v1_users') {
      deny('USERS_WRITE_FORBIDDEN', '副本 users 集合只读，本层拒绝任何写入。');
    }
    deny('COLLECTION_NOT_WRITABLE', `集合不在可写白名单内，已拒绝：${collection}`);
  }
  if (!text(key)) deny('DOC_ID_INVALID', '写入主键必须是非空字符串。');
  return { collection, key };
}

/**
 * 创建 SDK 薄适配层。
 *
 * @param {object} options
 *   - db            {object}  **必须**由受控宿主提供；本层不创建、不初始化
 *   - verifyCaller  {function} **必须**由受控宿主提供；返回 {allowed:boolean, envId?}
 *   - targetUserId  {string}  本计划完整目标用户（绑定，只读本计划目标的 users 记录）
 *   - auditId       {string}  本计划的确定性审计主键（绑定）
 *   - appId / envId / region  必须与固定值逐字相同
 *   - primaryId     {string}  默认 'primary'
 * @returns {object} 满足 P4 核心 assertAdapterBoundary 的适配器
 */
function createAdapter(options) {
  const opts = options || {};

  // ── 固定值自校验：先核对固定常量本身，再核对入参 ──
  if (opts.appId !== FIXED_APP_ID) {
    deny('APP_ID_MISMATCH', 'AppID 不等于本轮固定值，已拒绝创建适配层。');
  }
  if (opts.envId !== FIXED_ENV_ID) {
    deny('ENV_ID_MISMATCH', '环境不等于本轮固定值，已拒绝创建适配层。');
  }
  if (opts.region !== FIXED_REGION) {
    deny('REGION_MISMATCH', '地域不等于本轮固定值，已拒绝创建适配层。');
  }
  if (!text(opts.targetUserId)) {
    deny('TARGET_USER_REQUIRED', '必须绑定本计划的完整目标用户 ID。');
  }
  if (!text(opts.auditId)) {
    deny('AUDIT_ID_REQUIRED', '必须绑定本计划的确定性审计主键。');
  }
  if (opts.primaryId !== undefined && opts.primaryId !== PRIMARY_ID) {
    deny('PRIMARY_ID_MISMATCH', 'primary 主键不等于固定值，已拒绝创建适配层。');
  }
  if (!opts.db || typeof opts.db.startTransaction !== 'function') {
    deny('DB_NOT_INJECTED', '必须由受控宿主注入数据库实例；本层不创建、不初始化、不联网。');
  }
  if (typeof opts.db.collection !== 'function') {
    deny('DB_NOT_INJECTED', '注入的数据库实例缺少 collection 方法，不是可用的数据库句柄。');
  }
  // 调用者核验是**硬要求**：没有它就不能开始任何事务
  if (typeof opts.verifyCaller !== 'function') {
    deny('CALLER_VERIFIER_MISSING', '缺少受控宿主提供的调用者核验函数，开始事务前即拒绝；不得以 allowed:true 代替身份核验。');
  }

  const targetUserId = opts.targetUserId;
  const auditId = opts.auditId;
  const primaryId = PRIMARY_ID;

  /**
   * R4：**归属与状态全部放在本实例的私有登记里**，句柄对象上不再放任何标志。
   *
   * 旧实现把 `__commitUnknown` 放在句柄上，rollback 又把它当作「可放行」的依据，
   * 于是 (a) 跨适配器句柄能被B 用来回滚 A 的事务，(b) 伪造 `{__commitUnknown:true,__tx}`
   * 就能授权任意底层回调。现在：
   *   - `REGISTRY` 是本实例私有的 WeakMap，key 是本层返回的**冻结句柄**；
   *   - 底层 SDK 事务引用存在登记项里，**外部无法读取或替换**；
   *   - 状态只有 active / commitUnknown / finished 三种，均由本层维护。
   * 外来句柄、伪造句柄、跨实例句柄一律不命中登记，直接拒绝。
   */
  const REGISTRY = new WeakMap();

  const STATE_ACTIVE = 'active';
  const STATE_COMMIT_UNKNOWN = 'commitUnknown';
  const STATE_FINISHED = 'finished';

  /** 取出本实例登记的句柄记录；未登记即拒绝（不检查句柄上的任何属性）。 */
  function lookupOwn(tx) {
    if (!tx || typeof tx !== 'object') {
      deny('TX_HANDLE_INVALID', '事务句柄缺失或不是对象。');
    }
    const entry = REGISTRY.get(tx);
    if (!entry) {
      deny('TX_NOT_OWNED', '事务句柄不属于本适配器，拒绝使用外来或伪造句柄。');
    }
    return entry;
  }

  /** 活动事务：仅 active 状态可读写与提交。 */
  function assertOwnLiveTransaction(tx) {
    const entry = lookupOwn(tx);
    if (entry.state === STATE_FINISHED) {
      deny('TX_ALREADY_FINISHED', '事务句柄已结束，不能继续使用。');
    }
    if (entry.state === STATE_COMMIT_UNKNOWN) {
      deny('TX_COMMIT_UNKNOWN', '事务提交结果未知，不再允许读写或再次提交。');
    }
    return entry;
  }

  /** 事务内的读取；只允许本计划相关的三个主键。 */
  function assertKeyAllowed(collection, key) {
    assertReadAllowed(collection, key);
    if (collection === 'schtest_v1_users' && key !== targetUserId) {
      deny('KEY_OUT_OF_SCOPE', '只允许读取本计划目标用户的 users 记录。');
    }
    if (collection === 'schtest_v1_app_admins' && key !== primaryId) {
      deny('KEY_OUT_OF_SCOPE', 'app_admins 只允许读取 primary。');
    }
    if (collection === 'schtest_v1_audit_events' && key !== auditId) {
      deny('KEY_OUT_OF_SCOPE', 'audit_events 只允许读取本计划的确定性审计主键。');
    }
  }

  const adapter = {
    /** 只读观察用的非事务读取；仅 primary 与本计划审计，且不接受事务句柄。 */
    readOnlyGet: async function readOnlyGet(collection, key) {
      // 只读观察**比事务读更窄**：仅 primary 与本计划的确定性审计两条。
      // 事务内读 users 是初始化必需；只读观察不需要，故不开放。
      if (collection === 'schtest_v1_users') {
        deny('READ_ONLY_SCOPE', '只读观察仅允许 primary 与本计划确定性审计，不开放 users 读取。');
      }
      assertReadAllowed(collection, key);
      if (collection === 'schtest_v1_app_admins' && key !== primaryId) {
        deny('KEY_OUT_OF_SCOPE', 'app_admins 只允许读取 primary。');
      }
      if (collection === 'schtest_v1_audit_events' && key !== auditId) {
        deny('KEY_OUT_OF_SCOPE', 'audit_events 只允许读取本计划的确定性审计主键。');
      }
      let result;
      try {
        result = await opts.db.collection(collection).doc(key).get();
      } catch (error) {
        const f = sanitizeFailure(error, 'READ_TRANSPORT_FAILED', '只读读取失败，状态无法确认。');
        const err = new AdapterError(f.code, f.message);
        err.originalErrorName = f.originalErrorName;
        throw err;
      }
      // R1：传入期望主键，非空记录必须 _id 匹配
      return normalizeDoc(result, { mode: 'plain', expectedKey: key });
    },

    /**
     * 调用者核验：委托给受控宿主提供的函数。
     * **只把核验结论返回给核心**，不硬编码 allowed，不解释 approvedBy 等字段。
     */
    verifyCaller: async function verifyCaller(context) {
      if (context && context.envId && context.envId !== FIXED_ENV_ID) {
        deny('ENV_ID_MISMATCH', '核验上下文的环境不等于固定值。');
      }
      if (context && context.appId && context.appId !== FIXED_APP_ID) {
        deny('APP_ID_MISMATCH', '核验上下文的 AppID 不等于固定值。');
      }
      let result;
      try {
        result = await opts.verifyCaller({ envId: FIXED_ENV_ID, appId: FIXED_APP_ID });
      } catch (error) {
        const f = sanitizeFailure(error, 'CALLER_VERIFY_FAILED', '调用者核验抛出异常，未获核验。');
        const err = new AdapterError(f.code, f.message);
        err.originalErrorName = f.originalErrorName;
        throw err;
      }
      if (!isPlainObject(result)) {
        deny('CALLER_VERIFY_FAILED', '调用者核验未返回结构化结论，未获核验。');
      }
      if (result.allowed !== true) {
        deny('CALLER_VERIFY_FAILED', '调用者未获核验。');
      }
      // R3：**在输出白名单净化之前**先核对这些字段。
      // 净化只输出 {allowed, envId}，若不先核对，核验方报告的错 appId 或
      // trusted 标记会被净化「删掉」，等于取消了核心本有的拒绝依据。
      if (result.envId !== undefined && result.envId !== FIXED_ENV_ID) {
        deny('CALLER_ENV_MISMATCH', '调用者核验报告的环境与固定环境不一致。');
      }
      if (result.appId !== undefined && result.appId !== FIXED_APP_ID) {
        deny('CALLER_APP_ID_MISMATCH', '调用者核验报告的 AppID 与固定 AppID 不一致。');
      }
      if (result.trusted === true) {
        // 核心的 trusted 标记默认只作测试数据拒绝；适配层不得因净化而放行
        deny('CALLER_TRUSTED_FLAG_REJECTED', '调用者核验返回 trusted 标记，本层不接受该标记作为授权。');
      }
      // 通过后只输出白名单字段，不透传任何自由字段（含凭据类字段）
      return { allowed: true, envId: FIXED_ENV_ID };
    },

    beginTransaction: async function beginTransaction() {
      let tx;
      try {
        tx = await opts.db.startTransaction();
      } catch (error) {
        const f = sanitizeFailure(error, 'TX_BEGIN_FAILED', '开始事务失败，未做任何写入。');
        const err = new AdapterError(f.code, f.message);
        err.originalErrorName = f.originalErrorName;
        throw err;
      }
      if (!tx || typeof tx.collection !== 'function'
        || typeof tx.commit !== 'function' || typeof tx.rollback !== 'function') {
        deny('TX_BEGIN_FAILED', '开始事务未返回可用的手动事务句柄。');
      }
      // R4：**不重绑真实 SDK 对象的方法**（旧实现会污染宿主 SDK 的事务对象）。
      // 底层引用只放进私有登记；返回给核心的是一个**空壳冻结句柄**，
      // 外部既读不到底层引用，也无法替换它。
      const handle = Object.freeze({});
      REGISTRY.set(handle, {
        inner: tx,
        state: STATE_ACTIVE,
        collection: tx.collection.bind(tx),
        commit: tx.commit.bind(tx),
        rollback: tx.rollback.bind(tx)
      });
      return handle;
    },

    getDoc: async function getDoc(tx, collection, key) {
      const entry = assertOwnLiveTransaction(tx);
      assertKeyAllowed(collection, key);
      let result;
      try {
        result = await entry.collection(collection).doc(key).get();
      } catch (error) {
        const f = sanitizeFailure(error, 'READ_TRANSPORT_FAILED', '事务内读取失败，状态无法确认。');
        const err = new AdapterError(f.code, f.message);
        err.originalErrorName = f.originalErrorName;
        throw err;
      }
      // R1：传入期望主键，非空记录必须 _id 匹配
      return normalizeDoc(result, { mode: 'transaction', expectedKey: key });
    },

    setDoc: async function setDoc(tx, collection, key, doc) {
      const entry = assertOwnLiveTransaction(tx);
      assertWriteAllowed(collection, key);
      assertKeyAllowed(collection, key);
      // 核对 _id 一致后**复制剔除**，绝不改动核心传来的对象
      const fields = reconcileId(key, doc);
      let result;
      try {
        result = await entry.collection(collection).doc(key).set(fields);
      } catch (error) {
        const f = sanitizeFailure(error, 'SET_TRANSPORT_FAILED', '写入失败，未提交事务。');
        const err = new AdapterError(f.code, f.message);
        err.originalErrorName = f.originalErrorName;
        throw err;
      }
      // R2：成功形状必须核验；缺字段、含 code、计数异常或零更新无合法插入
      // 都会抛错，核心因此不会继续 commit
      assertSetSuccess(result, key);
      return true;
    },

    commit: async function commit(tx) {
      const entry = assertOwnLiveTransaction(tx);
      // 明确不重试：未知提交结果不得自动再次初始化
      if (MAX_COMMIT_RETRIES !== 0) deny('INTERNAL_POLICY', '提交重试策略异常。');
      try {
        await entry.commit();
      } catch (error) {
        // 提交结果未知：状态转commitUnknown（禁止读写与再提交，但**允许回滚**）。
        // 核心据此区分「回滚成功 → RESULT_UNKNOWN」与「回滚也失败 → ROLLBACK_FAILED」。
        entry.state = STATE_COMMIT_UNKNOWN;
        const f = sanitizeFailure(error, 'COMMIT_UNKNOWN', '提交结果未知；未自动重试，也未描述为已回滚。');
        const err = new AdapterError(f.code, f.message);
        err.originalErrorName = f.originalErrorName;
        throw err;
      }
      entry.state = STATE_FINISHED;
      return true;
    },

    rollback: async function rollback(tx) {
      // R4：**先核对归属**。跨实例句柄、伪造句柄都不命中本实例登记，直接拒绝。
      const entry = lookupOwn(tx);
      if (entry.state === STATE_FINISHED) {
        deny('TX_ALREADY_FINISHED', '事务已结束，回滚无意义。');
      }
      // active 与 commitUnknown 都允许回滚：回滚是既有的恢复动作，不是新写入。
      // 但只能回滚**一次**。
      try {
        await entry.rollback();
      } catch (error) {
        entry.state = STATE_FINISHED;
        const f = sanitizeFailure(error, 'ROLLBACK_FAILED', '回滚失败；未谎报已回滚，请人工核对。');
        const err = new AdapterError(f.code, f.message);
        err.originalErrorName = f.originalErrorName;
        throw err;
      }
      entry.state = STATE_FINISHED;
      return true;
    },

    // 只读常量，供测试与文档核对（不参与业务判定）
    __meta: Object.freeze({
      appId: FIXED_APP_ID,
      envId: FIXED_ENV_ID,
      region: FIXED_REGION,
      boundTargetUserId: targetUserId,
      boundAuditId: auditId,
      readCollections: READ_COLLECTIONS,
      writeCollections: WRITE_COLLECTIONS,
      setRetries: MAX_SET_RETRIES,
      commitRetries: MAX_COMMIT_RETRIES,
      productionCallerVerifierImplemented: false,
      isAuthorizationMechanism: false
    })
  };

  return Object.freeze(adapter);
}

module.exports = Object.freeze({
  FIXED_APP_ID,
  FIXED_ENV_ID,
  FIXED_REGION,
  PRIMARY_ID,
  READ_COLLECTIONS,
  WRITE_COLLECTIONS,
  MAX_SET_RETRIES,
  MAX_COMMIT_RETRIES,
  AdapterError,
  createAdapter,
  sanitizeFailure,
  normalizeDoc,
  reconcileId,
  assertSetSuccess,
  assertReadAllowed,
  assertWriteAllowed
});