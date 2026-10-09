'use strict';
/**
 * CloudBase数据库 SDK **只读** worker（M1/M2）
 * =====================================================
 *
 * 定位
 * ────
 * 本文件是**专用子进程**，在**有界独立 worker** 内用固定 `@cloudbase/node-sdk`
 * 做**两条固定主键的只读 `get`**。它不是授权器，也不执行任何写操作。
 *
 * 为什么单独成文件（而不是父进程里直接 require SDK）
 * ──────────────────────────────────────────────
 * 1. **凭据只走私有 stdin 管道**：父进程一次写入后立即关闭 stdin。对**本worker**而言，
 *    凭据**不进命令行参数、不进环境变量、不进磁盘、不进任何文件**。
 *    （范围说明：这只是 **worker** 的边界。三条公共 CLI 关联阶段是**通过子进程环境变量**
 *    `TENCENTCLOUD_SECRETID/KEY/SESSIONTOKEN` 接收凭据的 —— 那正是已审查的注入路径，
 *    不要把本行的「不进环境」读成整个工具都不经环境传凭据。）
 * 2. **输出只回净化结果**：worker 的 stdout 只写一份净化 JSON；诊断、原始 SDK 响应、
 *    错误 message/stack/cause **一律不外传**。
 * 3. **有界**：父进程对 worker 施加 55 秒 / 1 MiB 上限；worker 自身也拒绝超限输出。
 *
 * 固定目标（写死在源码里，**不接受调用方传入集合名/主键/端点**）
 * ──────────────────────────────────────────────
 *   1. `schtest_v1_app_admins`主键 `primary`，投影 `_id,userId,status`
 *   2. `schtest_v1_users` 主键 `<targetUserId>`，投影 `_id,status,openid`
 *
 * 严禁（**代码级陷阱**，不是靠自觉）
 * ─────────────────────────────
 * 任何写入口（`add`/`set`/`update`/`remove`/`createCollection`/`dropCollection`/
 * 批量写 / 事务 / `startTransaction` / 云函数 / 业务 `identify`/`requestBindingNumber`）
 * 一律替换为**抛错的陷阱函数**并计数。测试与运行时都会断言写次数为 0。
 *
 * 身份派生一致**只证明记录自洽**，不证明现实微信归属。OPENID 仅在本进程内存中比较，
 * **永不输出、永不回传给父进程**。
 */

const readline = require('node:readline');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 固定 SDK 根（本轮已取得；不使用项目依赖、不用全局 PATH 替换）。 */
const SDK_ROOT = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';

/** 固定环境 / AppID / 地域：与已验收 CLI 观测器同源，**不可配置**。 */
const FIXED_ENV = 'cloud1-d8gcq5ag39d847723';
const FIXED_APP_ID = 'wxfb4db1615ac15531';
const FIXED_REGION = 'ap-shanghai';

/** 固定集合与主键。 */
const ADMIN_COLLECTION = 'schtest_v1_app_admins';
const PRIMARY_KEY = 'primary';
const USER_COLLECTION = 'schtest_v1_users';

/** 固定投影：最小字段集。 */
const PRIMARY_PROJECTION = Object.freeze({ _id: true, userId: true, status: true });
const USER_PROJECTION = Object.freeze({ _id: true, status: true, openid: true });

/** worker 自身输出上限（与父进程上限一致；worker 侧再兜一层）。 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** 净化结果里的固定分类（不猜错误码、不解析自由 message）。 */
const CLASS = Object.freeze({
  /** 本次未找到文档（只说明此次未找到，不证明集合从未存在）。 */
  NOT_FOUND: 'NOT_FOUND',
  /** 找到且形状合法。 */
  OBSERVED: 'OBSERVED',
  /** 找到但字段/形状不可信。 */
  UNCONFIRMED_SHAPE: 'UNCONFIRMED_SHAPE',
  /** 已核实的官方错误契约才能用；无法区分的一律 UNCONFIRMED。 */
  UNCONFIRMED: 'UNCONFIRMED'
});

const ERR = Object.freeze({
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  CREDENTIAL_SHAPE_INVALID: 'CREDENTIAL_SHAPE_INVALID',
  CREDENTIAL_NOT_TEMPORARY: 'CREDENTIAL_NOT_TEMPORARY',
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  TARGET_USER_ID_INVALID: 'TARGET_USER_ID_INVALID',
  SDK_UNAVAILABLE: 'SDK_UNAVAILABLE',
  READ_FAILED: 'READ_FAILED'
});

/**
 * 写入口陷阱：任何调用都会抛错并**记录名字**。
 *
 * 注意：该数组**不能**冻结 —— 一旦冻结，`push` 自身就会抛
 * 「Cannot add property」TypeError，把「记录到一次越界写」变成「抛出一个不相干的错误」，
 * 反而掩盖真实结论。它只在本进程内存中存在，且输出前只取长度与副本。
 */
const writeAttempts = [];
function trap(name) {
  return function trappedWrite() {
    writeAttempts.push(name);
    const err = new Error('READ_ONLY_TRAP');
    err.code = 'READ_ONLY_TRAP';
    throw err;
  };
}

/**
 * R5：只读**窄包装** —— 与其「改写原引用的方法属性」，不如**只暴露固定 `get` 能力**。
 *
 * 上一版只替换 `doc()` 返回引用上的写方法，但实际 `@cloudbase/database` 的
 * `field(projection)` 会返回**一个全新的 DocumentReference**，其上的写方法从未被封堵，
 * `.doc(...).field(...).set()` 依然可达。
 *
 * 本包装把真实引用**封在闭包里**，只交出 `get`：写方法在窄包装上**根本不存在**
 * （不是「被陷阱拦住」，而是不可达），同时**不**构造通用数据库代理框架。
 * 实际查询仍然是 `doc(...).field(...).get()`，投影与主键都照常传给真实实现。
 *
 * @param {object} coll 真实集合引用（由调用方在封堵前抓到）
 * @param {string} name 集合名，仅用于诊断
 */
function makeReadOnlyHandle(coll, name) {
  if (!coll || typeof coll.doc !== 'function') {
    throw Object.assign(new Error('集合引用不可用'), { code: ERR.SDK_UNAVAILABLE });
  }
  const handle = Object.freeze({
    doc(id) {
      if (typeof id !== 'string' || id.length === 0) {
        throw Object.assign(new Error('主键缺失或类型不符'), { code: ERR.TARGET_USER_ID_INVALID });
      }
      const ref = coll.doc(id);
      return Object.freeze({
        field(projection) {
          // 真实 `field()` 返回新引用；把它留在闭包里，只交出 `get`
          const projected = ref.field(projection);
          return Object.freeze({
            get() {
              return projected.get();
            }
          });
        }
      });
    }
  });
  void name;
  return handle;
}

/**
 * 用陷阱替换 db 上的所有写入口与事务入口，并返回**只读窄包装**。
 *
 * 注意顺序陷阱：本函数**最后**才把 `db.collection` 本身换成陷阱。返回的窄包装在
 * 封堵前就抓好了真实集合引用，因此随后的只读 `get` 不会被自己的陷阱拦住。
 *
 * @returns {{primary: object, users: object}} 只读窄包装（只有 `doc().field().get`）
 */
function installWriteTraps(db, collectionNames) {
  const trapNames = [
    'add', 'set', 'update', 'remove', 'createCollection', 'dropCollection',
    'createCollectionIfNotExists', 'drop', 'insertOne', 'insertMany',
    'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne',
    'bulkWrite', 'removeAll'
  ];
  // 1) 先抓真实集合引用（此时 db.collection 仍是真实实现）
  const raw = {};
  for (const name of collectionNames) {
    try {
      raw[name] = db.collection(name);
    } catch (_) {
      raw[name] = null;
    }
  }
  // 2) 逐个封堵集合上的写方法（`get`/`doc`/`field` 保持可用）
  for (const name of collectionNames) {
    const coll = raw[name];
    if (!coll) continue;
    for (const m of trapNames) {
      if (typeof coll[m] === 'function') coll[m] = trap(`${name}.${m}`);
    }
  }
  // 3) 事务与云函数等一律陷阱
  for (const m of ['startTransaction', 'runTransaction', 'callFunction',
    'invokeFunction', 'uploadFile', 'deleteFile', 'getBucket', 'createBucket']) {
    if (typeof db[m] === 'function') db[m] = trap(`db.${m}`);
  }
  // 4) 最后封堵 collection 工厂（真实引用已在上面抓好并转入闭包）
  try {
    Object.defineProperty(db, 'collection', {
      value: trap('db.collection'), configurable: false, writable: false
    });
  } catch (_) { /* 已冻结则忽略 */ }
  // 5) 交出**窄包装**：业务路径拿不到任何可写引用
  return {
    primary: makeReadOnlyHandle(raw[ADMIN_COLLECTION], ADMIN_COLLECTION),
    users: makeReadOnlyHandle(raw[USER_COLLECTION], USER_COLLECTION)
  };
}

/** 从 stdin 读取**一行** JSON（凭据只经此私有管道）。 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let buf = '';
    rl.on('line', line => { buf += line; rl.close(); });
    rl.on('close', () => {
      try {
        resolve(buf.trim() ? JSON.parse(buf) : null);
      } catch (error) {
        reject(Object.assign(new Error('stdin 不是合法 JSON'), { code: 'BAD_STDIN' }));
      }
    });
    rl.on('error', reject);
  });
}

/** 严格校验三字段：非空字符串。 */
function assertCredentialShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('凭据载荷缺失或不是对象'), { code: ERR.CREDENTIAL_MISSING });
  }
  const out = {};
  for (const key of ['secretId', 'secretKey', 'sessionToken']) {
    const v = input[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw Object.assign(new Error(`凭据字段缺失或类型不符：${key}`), { code: ERR.CREDENTIAL_SHAPE_INVALID });
    }
    out[key] = v;
  }
  return out;
}

/**
 * M1 关键映射：CLI 的 `secrets get --json` 输出字段是 **`token`**，
 * 而 `node-sdk` 的构造参数名是 **`sessionToken`**（`lib/cloudbase.js:135-139`）。
 * 这里**显式**改名，不照抄 CLI 示例里的 `token`，也不依赖任何隐式回退。
 */
function buildSdkConfig(cred, deps) {
  return {
    secretId: cred.secretId,
    secretKey: cred.secretKey,
    // token → sessionToken：唯一一次映射，别处不得再出现 token 字样
    sessionToken: cred.sessionToken,
    env: FIXED_ENV,
    // R1：报告固定声称 ap-shanghai，就必须**真的**把它传给 SDK，
    // 不能用常量冒充已核实的请求地域。worker 只读、不传自定义 endpoint / 代理。
    region: FIXED_REGION,
    debug: false,
    ...(deps.fixedOverrides || {})
  };
}

/** `u_ + sha256(appId + ':' + openid).slice(0, 40)`（与已验收核心同公式的窄复刻）。 */
function deriveUserId(appId, openid) {
  return `u_${crypto.createHash('sha256').update(String(appId) + ':' + String(openid)).digest('hex').slice(0, 40)}`;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * S2：`requestId` 输出格式白名单。
 *
 * 依据：`docs/证据/` 下真实平台只读证据的 190 个 `requestId` 样本**全部**为
 * UUID v4 形式（版本位恒为 `4`，变体位为 `8/9/a/b`，符合 RFC 4122）。
 * 该格式因此是**已核实**的，不是臆造。
 *
 * 未通过白名单的值**一律置 null**（省略），不原样输出 —— worker 收到什么
 * 就透传什么，等于留了一个自由文本出口。
 */
const REQUEST_ID_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 只在符合已核实格式时保留 `requestId`，否则 null。 */
function safeRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_UUID_V4.test(value) ? value : null;
}

/* ── 读取失败最小诊断（只增诊断，不改失败关闭行为） ──────────────────────
 *
 * 为什么不保留原始异常：Codex 首次真实执行得到 `UNCONFIRMED/READ_FAILED`，
 * 但 worker 的 catch 把任意异常统一转成 READ_FAILED，父层只收到该通用码 ——
 * 因此无法区分本地 SDK 异常、网络错误、签名/IAM 拒绝、集合不存在。
 *
 * 静态契约依据（`@cloudbase/database` 1.4.1 固定源码，只读核对）：
 *  - `src/utils/utils.ts:56-77`：`TcbError` 携带 `code` 与 `message`，
 *    由 `E({...res})` 构造；`processReturn` 在 `throwOnCode !== false` 时抛出。
 *  - `src/document.ts:320-360` `get()`：若 `res.code` 存在则**直接返回 res**
 *    （不抛），此时响应**可能不含 requestId**；否则返回
 *    `{data: documents, requestId, offset, limit}`。
 *  - `src/const/code.ts`：SDK 自身的错误码集合（`DATABASE_REQUEST_FAILED` 等）。
 *
 * 因此白名单只收**源码可确定**的错误码；平台侧未验证的码一律归`OTHER`。
 * 不从 message 猜因果，不新增「任意错误字符串放行」规则。
 */

/** 读取阶段标识（固定枚举）。 */
const READ_STAGE = Object.freeze({
  PRIMARY: 'PRIMARY_READ',
  TARGET_USER: 'TARGET_USER_READ'
});

/**
 * 已核实的错误码白名单。
 *
 * 来源仅两类：
 *  1. SDK 自身 `src/const/code.ts` 的 `ERRORS`（源码确定）；
 *  2. 本工具自己的错误码。
 * **不含**任何平台侧未验证的错误码 —— 那些一律归`OTHER`。
 */
const READ_ERROR_CODE_ALLOWLIST = Object.freeze(new Set([
  // SDK 自身错误码（src/const/code.ts）
  'DATABASE_REQUEST_FAILED',
  'DATABASE_TRANSACTION_CONFLICT',
  'INVALID_PARAM',
  'CONN_ERROR',
  'CREATE_WATCH_NET_ERROR',
  'CREATE_WACTH_EXCEED_ERROR',
  'CREATE_WATCH_SERVER_ERROR',
  // 本工具自有
  'SDK_UNAVAILABLE',
  'READ_FAILED',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_SHAPE_INVALID',
  'CREDENTIAL_NOT_TEMPORARY',
  'CREDENTIAL_EXPIRED',
  'TARGET_USER_ID_INVALID'
]));

/**
 * 有限的**异常名称分类**（不据此断定来源）。
 *
 * 只输出观察到的 `error.name` 类别：`TypeError`/`ReferenceError`/`SyntaxError`
 * 归为本地代码问题候选，其余一律 `UNKNOWN`。
 *
 * **重要限制**：这只是**名称分类**，不能可靠证明异常实际来源于本地代码 ——
 * 任何对象都可以自报 `name: 'TypeError'`。因此不得据此断定平台拒绝、集合不存在
 * 或权限问题。
 *
 * 实现要点：按 `error.name` 而**非** `instanceof` 判断。
 * **范围说明（勿混同两种情形）**：
 *  - **独立子进程**（生产形态）：异常不会以活对象跨 IPC 传给父进程 —— worker 序列化
 *    的只是净化后的诊断字段，因此本函数不存在「跨进程 instanceof」问题。
 *  - **VM/夹具**（离线测试形态）：worker 源码在 VM 中运行时，同一进程内可能存在
 *    多个 realm，各 realm 的 `Error` 构造函数彼此不同，此时 `instanceof` 会失效。
 *    `name` 在两种情形下都稳定，故按 `name` 判断。
 *
 * R2：`name` 缺失时**不再读 `error.message`**（message getter 可能抛错，使诊断
 * 构造本身失败）；`name` 读取本身也有 try 保护。未知 `name` 归 `UNKNOWN`，
 * `NOT_AN_ERROR` 仅限 null / 非对象输入。
 */
function classifyLocalError(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return 'NOT_AN_ERROR';
  }
  let name = null;
  try {
    name = typeof error.name === 'string' ? error.name : null;
  } catch (_) {
    // name getter 抛错：视为无法识别，不递归展开原异常
    return 'UNKNOWN';
  }
  if (name === null) return 'UNKNOWN';
  if (name === 'TypeError') return 'LOCAL_TYPE_ERROR';
  if (name === 'ReferenceError') return 'LOCAL_REFERENCE_ERROR';
  if (name === 'SyntaxError') return 'LOCAL_SYNTAX_ERROR';
  // 未知名称（含 SDK 自己的 TcbError 等）：仍是一个错误对象，类别未知。
  // 不归 NOT_AN_ERROR —— 那是「不是错误」，与「是错误但类别未知」不同。
  return 'UNKNOWN';
}

/**
 * 从异常对象提取**白名单内**的错误码。
 *
 * SDK 的 `TcbError` 用 `code`；部分形状用 `errCode`。只接受字符串且在白名单内，
 * 否则归 `OTHER`。**不返回**原始字符串。
 */
function safeErrorCode(error) {
  if (error === null || typeof error !== 'object') return 'OTHER';
  for (const key of ['code', 'errCode']) {
    let v = null;
    // 属性访问放进try：异常对象可能带抛错的 getter，不能因此让诊断本身失败
    try { v = error[key]; } catch (_) { v = null; }
    if (typeof v === 'string' && READ_ERROR_CODE_ALLOWLIST.has(v)) return v;
  }
  return 'OTHER';
}

/**
 * 构造读取失败诊断（**固定形状**）。
 *
 * 只含四个字段：读取阶段、有限的异常名称分类、白名单错误码、合法 requestId。
 * 缺项一律 `UNKNOWN`/`OTHER`/`null` —— 不猜测，也不透传message/stack/cause/
 * 请求体/头/URL/凭据/OPENID 或任意外部字符串。
 */
function buildReadDiagnostics(stage, error) {
  // R2：`requestId` 读取与 code/errCode 同样用 try 保护 —— 异常对象可能带抛错的
  // getter，那会让**诊断构造本身**失败并丢失本次全部分类事实。
  // 读取失败时固定 null（不递归展开原异常，也不扩成通用异常框架）。
  let requestId = null;
  if (error !== null && typeof error === 'object') {
    try { requestId = error.requestId; } catch (_) { requestId = null; }
  }
  return {
    readStage: stage,
    localErrorClass: classifyLocalError(error),
    errorCode: safeErrorCode(error),
    requestId: safeRequestId(requestId)
  };
}

/**
 * R1：把「`get()` 返回带 code 的错误响应」也纳入同一套诊断。
 *
 * 固定源码事实（`src/document.ts:337`）：`res.code` 存在时 `get()` **直接返回
 * res** 而不抛 —— 因此这条路径**不会经过 catch**，必须在响应归一化处就地
 * 构造诊断，否则诊断会在组包时被丢弃。记录级语义仍是 `UNCONFIRMED` +
 * `READ_FAILED`（读取失败），与抛异常路径一致。
 *
 * 只在**已识别的错误响应分支**调用；`NOT_FOUND` / 坏形状等路径**不**泛加
 * 平台错误含义。
 */
function readDiagnosticsFromResponse(stage, norm) {
  return {
    readStage: stage,
    // 响应对象不是 JS 异常，没有可分类的 name → 固定 UNKNOWN
    localErrorClass: 'UNKNOWN',
    errorCode: typeof norm.errorCode === 'string' &&
      READ_ERROR_CODE_ALLOWLIST.has(norm.errorCode) ? norm.errorCode : 'OTHER',
    requestId: safeRequestId(norm.requestId)
  };
}

/**
 * 归一化一次只读 `get` 的结果。
 *
 * 非事务 `doc(id).field(projection).get()` 返回 **`{data: [...], requestId}`**（数组，
 * 见 `@cloudbase/database` `src/document.ts:320-360`）；事务内才返回单对象。
 * 本工具**不使用事务**，因此只接受 0/1 条；多条或坏形状一律 UNCONFIRMED_SHAPE。
 *
 * R3：平台**错误响应优先于** `data` 形状 —— 带 `code`/`errCode` 的响应即便 `data` 为空
 * 数组也**不是**「未找到」，而是读取失败。上一版先看 `data` 长度，把
 * `{code:..., data:[]}` 误判为 NOT_FOUND。
 */
function normalizeReadResult(res, expectedId) {
  if (!isPlainObject(res)) return { classification: CLASS.UNCONFIRMED_SHAPE, reason: '结果不是对象' };
  // R3：错误响应优先 —— 不猜具体错误码，只如实标记「读取失败」
  //固定源码 `document.ts:337`：`res.code` 存在时 get() **直接返回 res**（不抛），
  // 该响应可能不含 requestId。此路径同样给出最小诊断。
  const platformError = res.code || res.errCode || res.error || null;
  if (platformError !== null && platformError !== undefined && platformError !== 0 && platformError !== '') {
return {
    classification: CLASS.UNCONFIRMED,
    reason: '平台返回错误响应',
    hasPlatformError: true,
    // R1：显式标记这是**读取失败**，供组包阶段据此设记录级 READ_FAILED
    readFailed: true,
    // 平台错误响应走这里：只保留白名单码与合法 requestId，其余归 OTHER/null
    errorCode: typeof platformError === 'string' &&
      READ_ERROR_CODE_ALLOWLIST.has(platformError) ? platformError : 'OTHER',
    requestId: safeRequestId(res.requestId)
  };
  }
  // 事务形状（data 为单对象）在本工具中属越界
  if (isPlainObject(res.data)) return { classification: CLASS.UNCONFIRMED_SHAPE, reason: '出现事务内单对象形状' };
  if (!Array.isArray(res.data)) return { classification: CLASS.UNCONFIRMED_SHAPE, reason: 'data 不是数组' };
  if (res.data.length === 0) return { classification: CLASS.NOT_FOUND, requestId: safeRequestId(res.requestId) };
  if (res.data.length > 1) return { classification: CLASS.UNCONFIRMED_SHAPE, reason: `返回 ${res.data.length} 条` };
  const doc = res.data[0];
  if (!isPlainObject(doc)) return { classification: CLASS.UNCONFIRMED_SHAPE, reason: '文档不是对象' };
  if (doc._id !== expectedId) return { classification: CLASS.UNCONFIRMED_SHAPE, reason: '主键与请求不符' };
  return { classification: CLASS.OBSERVED, doc, requestId: safeRequestId(res.requestId) };
}

async function main() {
  const deps = { sdkRoot: SDK_ROOT, loadSdk: null, now: () => Date.now() };
  let credentialInput;
  try {
    credentialInput = await readStdin();
  } catch (_) {
    emit({ ok: false, errorCode: ERR.CREDENTIAL_MISSING, writeAttemptsCount: writeAttempts.length });
    return;
  }

  let cred;
  try {
    cred = assertCredentialShape(credentialInput);
  } catch (error) {
    // 不回传message（可能含值）；只回固定错误码
    emit({ ok: false, errorCode: error.code || ERR.CREDENTIAL_SHAPE_INVALID, writeAttemptsCount: writeAttempts.length });
    return;
  }

  const targetUserId = typeof credentialInput.targetUserId === 'string' && credentialInput.targetUserId
    ? credentialInput.targetUserId : null;
  if (targetUserId !== null && !/^u_[0-9a-f]{40}$/.test(targetUserId)) {
    emit({ ok: false, errorCode: ERR.TARGET_USER_ID_INVALID, writeAttemptsCount: writeAttempts.length });
    return;
  }

  // 加载固定 SDK：只按路径 require，不解析 npm、不安装、不联网取包
  // R1：真实公开入口是 `init(config)`。上一版写 `new CloudBase(config)`，而
  // `lib/index.js` 的导出是**对象**（含 init / request / version / ...），
  // 对它 `new` 会抛 TypeError，真实 worker 会停在 SDK_UNAVAILABLE。
  // 这里**只**用实际包公开入口，不另装 SDK、不提取内部模块。
  let sdk;
  try {
    const sdkPath = path.join(deps.sdkRoot, '@cloudbase', 'node-sdk');
    const entry = require.resolve(sdkPath);
    sdk = require(entry);
  } catch (_) {
    emit({ ok: false, errorCode: ERR.SDK_UNAVAILABLE, writeAttemptsCount: writeAttempts.length });
    return;
  }
  if (!sdk || typeof sdk.init !== 'function') {
    emit({ ok: false, errorCode: ERR.SDK_UNAVAILABLE, writeAttemptsCount: writeAttempts.length });
    return;
  }

  const config = buildSdkConfig(cred, deps);
  let app, db;
  try {
    app = sdk.init(config);
    if (!app || typeof app.database !== 'function') throw new Error('init 未返回可用实例');
    db = app.database();
  } catch (_) {
    emit({ ok: false, errorCode: ERR.SDK_UNAVAILABLE, writeAttemptsCount: writeAttempts.length });
    return;
  }

  const primaryCollection = ADMIN_COLLECTION;
  const userCollection = USER_COLLECTION;
  // 先抓真实引用再封堵；返回的是**只读窄包装**（只有 doc().field().get）
  const handles = installWriteTraps(db, [primaryCollection, userCollection]);

  const out = {
    ok: true,
    // 凭据**不落任何摘要/尾号/原值**：只报告形状结论
    credential: { mappedToSessionToken: true, fieldsProvided: Object.keys(cred).sort() },
    fixed: { env: FIXED_ENV, region: FIXED_REGION, appId: FIXED_APP_ID },
    // R4：worker 也独立复核同批凭据有效期（两次读取之间 + 结束后）
    credentialExpiredDuringRun: false,
    // S3：截止时间缺失/非法 → 零读取
    credentialExpiryMissing: false,
    primary: null,
    targetUser: null,
    writeAttempts: [],
    writeAttemptsCount: 0
  };

  /**
   * S3：worker 侧有效期检查。父进程把 `expiresAtMs` 一并经 stdin 送来，
   * 使**两条读取之间**也能核对同批凭据仍然有效。
   *
   * **截止时间缺失或非法时直接停止，零读取。**
   * 上一版 `expiresAtMs === null → return true`，把「没有期限」当成「尚未过期」，
   * 于是在完全没有时效约束的情况下执行了两条 get；`Infinity` 这类非法值也会
   * 充当「永远有效」。缺失不是「尚未过期」，非法截止值不是有效期限。
   */
  const rawExpiry = credentialInput.expiresAtMs;
  const expiresAtMs = (typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)) ? rawExpiry : null;
  const expiryUsable = expiresAtMs !== null;
  const stillFresh = () => expiryUsable && expiresAtMs > deps.now();

  if (!expiryUsable) {
    // 无可用截止时间：零读取，如实回报固定原因
    out.credentialExpiredDuringRun = false;
    out.credentialExpiryMissing = true;
    out.primary = { classification: CLASS.UNCONFIRMED, docId: PRIMARY_KEY, reason: '凭据缺少可用截止时间' };
    out.targetUser = targetUserId
      ? { classification: CLASS.UNCONFIRMED, docId: targetUserId, reason: '凭据缺少可用截止时间' }
      : null;
    out.writeAttempts = writeAttempts.slice();
    out.writeAttemptsCount = writeAttempts.length;
    emit(out);
    return;
  }
  if (!stillFresh()) {
    out.credentialExpiredDuringRun = true;
    out.primary = { classification: CLASS.UNCONFIRMED, docId: PRIMARY_KEY, reason: '凭据在读取前已过期' };
    out.targetUser = targetUserId
      ? { classification: CLASS.UNCONFIRMED, docId: targetUserId, reason: '凭据在读取前已过期' }
      : null;
    out.writeAttempts = writeAttempts.slice();
    out.writeAttemptsCount = writeAttempts.length;
    emit(out);
    return;
  }

  // ── 1. primary（固定主键） ──
  try {
    if (!stillFresh()) {
      out.primary = { classification: CLASS.UNCONFIRMED, docId: PRIMARY_KEY, reason: '凭据在读取前已过期' };
    } else {
      const res = await handles.primary.doc(PRIMARY_KEY).field(PRIMARY_PROJECTION).get();
      if (!stillFresh()) out.credentialExpiredDuringRun = true;
      const norm = normalizeReadResult(res, PRIMARY_KEY);
      if (norm.classification === CLASS.OBSERVED) {
        const doc = norm.doc;
        const userId = typeof doc.userId === 'string' ? doc.userId : null;
        const status = typeof doc.status === 'string' ? doc.status : null;
        out.primary = {
          classification: CLASS.OBSERVED,
          requestId: norm.requestId,
          docId: PRIMARY_KEY,
          // R3：userId / status 必须**形状合法**才输出；非法值一律置 null，
          // 并且 userIdShapeValid / statusValid 直接给 **false**（不再是 null）。
          // 「缺失/null 不算通过」由这两个布尔与解释器共同保证。
          userId: userId !== null && /^u_[0-9a-f]{40}$/.test(userId) ? userId : null,
          userIdPresent: userId !== null,
          userIdShapeValid: /^u_[0-9a-f]{40}$/.test(String(userId)),
          status: ['active', 'disabled'].includes(status) ? status : null,
          statusPresent: status !== null,
          statusValid: typeof status === 'string' && ['active', 'disabled'].includes(status)
        };
} else {
          // R1：`get()` 返回带 code 的错误响应时（不抛），诊断必须在这里接上，
          // 否则会被组包丢弃。记录级设 READ_FAILED 表示「读取失败」，
          // 不改变 UNCONFIRMED 语义；`NOT_FOUND` / 坏形状路径不泛加平台错误含义。
          out.primary = norm.readFailed
            ? {
              classification: norm.classification,
              requestId: norm.requestId || null,
              docId: PRIMARY_KEY,
              reason: norm.reason || null,
              hasPlatformError: norm.hasPlatformError === true,
              errorCode: ERR.READ_FAILED,
              readDiagnostics: readDiagnosticsFromResponse(READ_STAGE.PRIMARY, norm)
            }
            : {
              classification: norm.classification,
              requestId: norm.requestId || null,
              docId: PRIMARY_KEY,
              // reason 只取**本文件自己写下的固定短语**（净化白名单），不透传任意字符串
              reason: norm.reason || null,
              hasPlatformError: norm.hasPlatformError === true
            };
        }
    }
  } catch (error) {
    // 权限拒绝 / 网络失败 / 集合未确认：都不当作空记录，也不猜错误码。
    // 保留 `READ_FAILED` 这一失败关闭语义，只**附加**最小诊断：
    // 读取阶段、有限异常名称分类、白名单错误码、合法 requestId。
    out.primary = {
      classification: CLASS.UNCONFIRMED,
      docId: PRIMARY_KEY,
      errorCode: ERR.READ_FAILED,
      readDiagnostics: buildReadDiagnostics(READ_STAGE.PRIMARY, error)
    };
  }

  // ── 2. 指定 users（仅当有受信目标时才查） ──
  if (targetUserId) {
    try {
      if (!stillFresh()) {
        out.targetUser = { classification: CLASS.UNCONFIRMED, docId: targetUserId, reason: '凭据在读取前已过期' };
      } else {
        const res = await handles.users.doc(targetUserId).field(USER_PROJECTION).get();
        if (!stillFresh()) out.credentialExpiredDuringRun = true;
        const norm = normalizeReadResult(res, targetUserId);
        if (norm.classification === CLASS.OBSERVED) {
          const doc = norm.doc;
          const status = typeof doc.status === 'string' ? doc.status : null;
          const openid = typeof doc.openid === 'string' ? doc.openid : null;
          // 派生一致性：OPENID 只在本进程内存比较，绝不输出
          const derivedMatches = openid === null ? null
            : deriveUserId(FIXED_APP_ID, openid) === targetUserId;
          out.targetUser = {
            classification: CLASS.OBSERVED,
            requestId: norm.requestId,
            docId: targetUserId,
            // S1：字段契约与 primary **一致**都用 `status`。
            // 上一版这里叫 `userStatus`，而父进程净化器读 `status`，
            // 于是正常记录在父进程被判成「状态缺失」→ 误降级为 UNCONFIRMED。
            status: ['active', 'disabled'].includes(status) ? status : null,
            // R3：缺失/非法一律 false，不留 null 当「未失败」
            statusPresent: status !== null,
            statusValid: typeof status === 'string' && ['active', 'disabled'].includes(status),
            // 只输出布尔结论，不输出 openid 本身或其派生原文
            openidPresent: openid !== null,
            openidShapeValid: typeof openid === 'string' && openid.length > 0,
            derivationMatches: openid === null ? false : derivedMatches === true,
            derivationChecked: openid !== null,
            note: '派生一致仅证明记录自洽，不证明现实微信归属'
          };
        } else {
          // R1：与 primary 对称 —— 错误响应路径接上诊断并设记录级 READ_FAILED，
          // 避免用户读取失败被通用兜底误报成「派生不匹配」。
          out.targetUser = norm.readFailed
            ? {
              classification: norm.classification,
              requestId: norm.requestId || null,
              docId: targetUserId,
              reason: norm.reason || null,
              hasPlatformError: norm.hasPlatformError === true,
              errorCode: ERR.READ_FAILED,
              readDiagnostics: readDiagnosticsFromResponse(READ_STAGE.TARGET_USER, norm)
            }
            : {
              classification: norm.classification,
              requestId: norm.requestId || null,
              docId: targetUserId,
              reason: norm.reason || null,
              hasPlatformError: norm.hasPlatformError === true
            };
        }
      }
    } catch (error) {
      // 同 primary：保留 READ_FAILED 关闭语义，只附加最小诊断
      out.targetUser = {
        classification: CLASS.UNCONFIRMED,
        docId: targetUserId,
        errorCode: ERR.READ_FAILED,
        readDiagnostics: buildReadDiagnostics(READ_STAGE.TARGET_USER, error)
      };
    }
  }

  // R4：结束前再复核一次；过期事实如实带回，不升级为完整核验
  if (!stillFresh()) out.credentialExpiredDuringRun = true;

  out.writeAttempts = writeAttempts.slice();
  out.writeAttemptsCount = writeAttempts.length;
  emit(out);
}

/** 只输出净化 JSON，并自行兜住 1 MiB 上限。 */
function emit(obj) {
  let s;
  try {
    s = JSON.stringify(obj);
  } catch (_) {
    s = JSON.stringify({ ok: false, errorCode: 'OUTPUT_SERIALIZE_FAILED' });
  }
  if (Buffer.byteLength(s, 'utf8') > MAX_OUTPUT_BYTES) {
    s = JSON.stringify({ ok: false, errorCode: 'OUTPUT_OVERFLOW' });
  }
  process.stdout.write(s);
}

// 作为入口被 spawn 时才执行 main；被 require 时只导出纯函数供离线测试复用。
if (require.main === module) {
  main().catch(() => {
    // 兜底：任何未预期异常都不外传 stack/cause
    emit({ ok: false, errorCode: 'WORKER_UNEXPECTED', writeAttemptsCount: writeAttempts.length });
  });
}

module.exports = Object.freeze({
  SDK_ROOT,
  FIXED_ENV,
  FIXED_APP_ID,
  FIXED_REGION,
  ADMIN_COLLECTION,
  PRIMARY_KEY,
  USER_COLLECTION,
  PRIMARY_PROJECTION,
  USER_PROJECTION,
  MAX_OUTPUT_BYTES,
  CLASS,
  ERR,
  assertCredentialShape,
  buildSdkConfig,
  deriveUserId,
  normalizeReadResult,
  safeRequestId,
  buildReadDiagnostics,
  classifyLocalError,
  safeErrorCode,
  READ_STAGE,
  READ_ERROR_CODE_ALLOWLIST,
  REQUEST_ID_UUID_V4,
  installWriteTraps,
  makeReadOnlyHandle,
  isPlainObject
});