'use strict';
/**
 * 首次管理员受控初始化宿主（默认本地检查 / 计划展示）
 * ==================================================
 *
 * 范围（任务 docs/WorkBuddy任务-首次管理员受控接线与本人登记准备-20261009.md §4）
 *
 * 默认关闭与批准边界（§4.1）
 *  - 默认启动**只做**本地路径、版本、指纹和计划字段检查；不取凭据、不联网、
 *    不启动写worker。错误参数在这些外部动作**之前**拒绝。
 *  - **不**增加公共 `--execute`、任意适配器/脚本/URL/集合/凭据参数或云路由。
 *  - 区分四层：候选计划 / 批准上下文 / **当次**云身份核验 / 事务结果。
 *    批准必须由未来受审入口依据真实用户确认绑定完整计划**及文件指纹**；
 *    普通计划 JSON 自报 `approvedBy`/`allowed:true`/`trusted:true`、
 *    环境变量或可序列化「已批准」标志**不能**独立触发真实路径。
 *  - 缺受控批准来源时，在**获取凭据之前**停止。不实现「把开关改 true 即可完成
 *    验收」；也不是无条件拒绝的空实现 —— 离线可走到真实 P4 核心与真实 SDK 转换。
 *  - 不新建签名服务/批准数据库/通用权限系统。信任边界是受审的本地管理进程及其
 *    操作者；**不**宣称能防御拥有相同本机权限、可任意改代码的攻击者。
 *
 * 一批凭据与真实主体核验（§4.2）
 *  - 一次取得临时凭据，所有 CLI 关联与数据库 SDK 使用**同一内存快照**；过期停止，
 *    不取第二批、不重试初始化。
 *  - CLI 用已审路径的**子进程环境**注入；worker 用**私有 stdin** 一次传入随即关闭。
 *    （因此**不得**笼统称「所有进程凭据均不进环境」。）
 *  - 复用三阶段身份/环境关联；`matched` 只说明归属关联，**不是**管理员初始化许可。
 *  - 最小补足：在同一快照下增加**一次固定 STS GetCallerIdentity 只读核验**，
 *    复用既有固定参数构建、spawnBounded、JSON 解析与 STS 字段检查；
 *    只在内存取得 `Type/AccountId/UserId/PrincipalId`，计算
 *    `[Type,AccountId,UserId,PrincipalId]` 的 UTF-8 JSON SHA-256 元组摘要，
 *    与**执行前已受审的预期值**比较。严格保持字符串：不裁尾、不改大小写。
 *  - **预期摘要本轮未取得批准**，不得从本次执行响应自动「学习」为允许值。
 *
 * 单次执行与结果核对（§4.4）
 *  - 真实执行前持久化新轮次 started 记录（不含秘密）；创建失败或同轮次已存在
 *    则**不发写请求**。结果文件**新建**保存；同轮次再次调用只进入核对/停止。
 *  - 超时/退出异常/写结果丢失/提交未知 → 状态**待核对**，保留轮次与确定性审计 ID，
 *    **不**刷新凭据后重新写。
 *
 * 本模块**不**自行执行真实云端动作；`executeOnce` 供未来 Codex 受审单次入口调用，
 * 本轮仅在离线测试中走完整链。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const credentialHost = require('./cloudbase-cli-credential-host.cjs');
const readOnly = require('./cloudbase-sdk-readonly-observer.cjs');
const cliObserver = require('./cloudbase-readonly-observer.cjs');
const p4 = require('./sandbox-primary-bootstrap.cjs');
const executionWorker = require('./sandbox-primary-execution-worker.cjs');

// ── 固定值（全部取自已验收模块，不重新定义） ────────────────────────────────
const FIXED = {
  appId: p4.FIXED_APP_ID,
  envId: p4.FIXED_ENV_ID,
  region: executionWorker.FIXED_REGION,
  primaryId: p4.PRIMARY_ID,
  sdkRoot: executionWorker.SDK_ROOT,
  cliFingerprint: credentialHost.FINGERPRINT,
  // 以下取自已验收 CLI 观测器
  nodeBin: cliObserver.FIXED.nodeBin,
  cliEntry: cliObserver.FIXED.cliEntry,
  cliBundle: cliObserver.FIXED.cliBundle,
  // R3：`isolationRoot` 必须取**实际存在该字段**的模块。
  // 此前取 `cliObserver.FIXED.isolationRoot`，而旧 CLI 观测器**没有**这个键
  // （实测为 undefined），worker cwd 因此无法据此认定固定。
  isolationRoot: readOnly.FIXED.isolationRoot,
  authSessionDir: cliObserver.FIXED.authSessionDir,
  acceptedStsType: cliObserver.FIXED.acceptedStsType,
  workerPath: path.join(__dirname, 'sandbox-primary-execution-worker.cjs')
};

/** 本宿主固定错误码。 */
const ERR = Object.freeze({
  APPROVAL_SOURCE_MISSING: 'APPROVAL_SOURCE_MISSING',
  APPROVAL_PLAN_BINDING_MISMATCH: 'APPROVAL_PLAN_BINDING_MISMATCH',
  FINGERPRINT_MISMATCH: 'FINGERPRINT_MISMATCH',
  PLAN_INVALID: 'PLAN_INVALID',
  CREDENTIAL_FETCH_FAILED: 'CREDENTIAL_FETCH_FAILED',
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  CLI_ASSOCIATION_FAILED: 'CLI_ASSOCIATION_FAILED',
  CALLER_SUBJECT_MISMATCH: 'CALLER_SUBJECT_MISMATCH',
  CALLER_SUBJECT_UNVERIFIED: 'CALLER_SUBJECT_UNVERIFIED',
  STS_TYPE_MISMATCH: 'STS_TYPE_MISMATCH',
  STS_FIELD_MISSING: 'STS_FIELD_MISSING',
  ROUND_ALREADY_STARTED: 'ROUND_ALREADY_STARTED',
  ROUND_START_FAILED: 'ROUND_START_FAILED',
  RESULT_UNKNOWN: 'RESULT_UNKNOWN',
  WORKER_FAILED: 'WORKER_FAILED',
  // S3-4：执行前缺保存能力（外部动作前拒绝，不等提交后才发现）
  SAVE_CAPABILITY_MISSING: 'SAVE_CAPABILITY_MISSING'
});

/** 只接受这三个入口参数；出现其它一律在外部动作前拒绝。 */
const ALLOWED_ARGS = Object.freeze(['--local-check', '--show-plan']);
const FORBIDDEN_ARG_PREFIXES = Object.freeze([
  '--execute', '--approve', '--approval', '--init', '--initialize', '--deploy',
  '--force', '--yes', '--allow', '--skip-checks',
  '--env', '--collection', '--url', '--endpoint', '--script', '--adapter',
  '--secret', '--token', '--credential', '--auth', '--region', '--appid',
  '--user', '--openid', '--primary'
]);

const STATUS = Object.freeze({
  LOCAL_READY: 'LOCAL_READY',
  PLAN_READY: 'PLAN_READY',
  FAILED: 'FAILED'
});

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function sha256Of(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * 入口参数白名单。
 *
 * 未知或禁止参数**一律拒绝**，且拒绝发生在任何凭据/网络/子进程动作之前。
 * 本轮不提供 `--execute`。
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  for (const a of args) {
    if (ALLOWED_ARGS.includes(a)) continue;
    for (const p of FORBIDDEN_ARG_PREFIXES) {
      if (a === p || a.startsWith(p + '=')) {
        return { ok: false, errorCode: ERR.PLAN_INVALID, reason: 'ARG_FORBIDDEN', arg: a };
      }
    }
    return { ok: false, errorCode: ERR.PLAN_INVALID, reason: 'ARG_UNKNOWN', arg: a };
  }
  return { ok: true, errorCode: null, showPlan: args.includes('--show-plan') };
}

/**
 * 受控批准绑定（模块私有登记表）
 * ==================================
 *
 * R4 根因：`approvalSource.controlled === true` 是**可序列化自报字段**。
 * 把整个来源对象 `JSON.parse(JSON.stringify(x))` 复制一份后，所有字段
 * （含 `controlled:true`）原样保留，仍能通过检查。也就是说「批准不能伪造」
 * 在原实现里**没有依据**。
 *
 * 修法（本模块内，不新建签名服务、不引入批准数据库）：
 *  - 由**受审管理入口**调 `issueControlledApproval()` 签发一个对象；
 *  - 该对象登记在本模块私有的 `WeakSet` 里，并**故意**不可 JSON 序列化
 *    （`toJSON` 抛错）。复制、展开、`Object.assign` 出来的副本都不在登记表内；
 *  - 每次核对都**重新计算**完整计划摘要、批准主体、预期主体摘要与**实际**
 *    文件指纹（真的读文件算哈希），任一被换即拒绝。
 *
 * 边界（必须如实表述）：本机制**不**防御拥有相同本机权限、可改代码或可读
 * 本模块内存的攻击者 —— 信任边界仍是受审管理进程及其操作者。它解决的是
 * 「普通计划 JSON / 环境变量 / 可序列化标志不能充当授权」这一具体缺口。
 */

/** 已签发的受控批准对象（WeakSet：不在集合内即非受控来源）。 */
const ISSUED_APPROVALS = new WeakSet();

/** 本模块固定的实现文件清单：批准必须绑定它们的**实际内容**哈希。 */
const FINGERPRINT_FILES = Object.freeze([
  'sandbox-primary-execution-host.cjs',
  'sandbox-primary-execution-worker.cjs',
  'sandbox-primary-bootstrap.cjs',
  'sandbox-primary-sdk-adapter.cjs'
]);

/** 计算固定文件的实际 sha256（真的读磁盘）。 */
function computeImplementationFingerprint() {
  const out = {};
  for (const name of FINGERPRINT_FILES) {
    try {
      out[name] = sha256Of(fs.readFileSync(path.join(__dirname, name)));
    } catch (_) {
      out[name] = null;
    }
  }
  return out;
}

/**
 * 由**受审管理入口**签发受控批准绑定（本轮仅离线测试调用；真实批准未生成）。
 *
 * @param {object} spec
 * @param {object} spec.plan 完整原始计划（会被完整绑定，不只绑定摘要）
 * @param {object} spec.approval P4 批准上下文
 * @param {string} spec.approvedBy 确认人
 * @param {string[]} spec.writeScope 写范围
 * @param {number} spec.expiresAtMs 有效期
 * @param {string} spec.expectedSubjectDigest 执行前受审的完整主体摘要
 * @returns {object} 不可序列化的受控批准句柄
 */
function issueControlledApproval(spec) {
  const s = spec || {};
  const handle = Object.create(null);
  /**
   * S1：内部快照必须**递归冻结**。
   * 此前只对句柄顶层`Object.freeze`，嵌套 `plan`/`approval` 仍可被改写
   * （实测 `signed-handle-nested-mutation`：签发后改 `source.approval.approvedBy`，
   *  核对仍 `ok:true`）。WeakSet 只能证明对象由本模块发出，不能证明其内部未被改。
   */
  handle.plan = deepFreeze(JSON.parse(JSON.stringify(s.plan)));
  handle.approval = deepFreeze(JSON.parse(JSON.stringify(s.approval)));
  handle.approvedBy = s.approvedBy;
  handle.writeScope = Object.freeze(Array.isArray(s.writeScope) ? s.writeScope.slice() : []);
  handle.expiresAtMs = s.expiresAtMs;
  handle.expectedSubjectDigest = s.expectedSubjectDigest;
  handle.cliFingerprint = Object.freeze({
    bundleSha256: FIXED.cliFingerprint.bundleSha256,
    entrySha256: FIXED.cliFingerprint.entrySha256
  });
  // 签发时绑定**实际**实现内容；不是签发者自报
  handle.implementationFingerprint = deepFreeze(computeImplementationFingerprint());
  // 摘要基于原始计划字段（与核心同算法），同时另算「完整计划」规范化摘要
  handle.planDigest = p4.inputDigest(handle.plan);
  handle.fullPlanDigest = sha256Of(JSON.stringify(
    Object.keys(handle.plan).sort().map(k => [k, handle.plan[k]])
  ));
  handle.issuedAtMs = Date.now();
  // **不可 JSON 序列化**：复制即失败，且不泄露内容
  Object.defineProperty(handle, 'toJSON', {
    enumerable: false,
    value() { throw new Error('受控批准句柄不可序列化'); }
  });
  Object.freeze(handle);
  ISSUED_APPROVALS.add(handle);
  return handle;
}

/**
 * 递归冻结（S1）：把对象与其**所有**嵌套对象/数组都冻结。
 *
 * 只冻结顶层时，嵌套属性仍可被赋值 —— 这正是 S1 样本 2 的可复现路径。
 * 数组元素也逐个冻结，避免 `writeScope`/`approvedUserIds` 被 `push`。
 * 非对象（字符串、数字、布尔、null）原样返回。
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = value[key];
    // 跳过原始 json 字符串（writeScope 是字符串数组，逐字符递归没有意义且会退化）
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  }
  return value;
}

/**
 * 取句柄里**已核验**的不可变快照（S1）。
 *
 * 这是 worker 载荷的唯一来源：`executeOnce` 必须用它，而不是另取调用方
 * 传入的 `o.plan`/`o.approval`。此前「核验一份、执行另一份」导致：
 *  - 样本 1：只改 `o.approval.approvedBy`，审计里落的是**未绑定值**；
 *  - 样本 3：在 `persistRoundStarted` 回调里改 `o.plan.operatorRef`，同样落库。
 */
function boundSnapshot(approvalSource, plan) {
  const src = approvalSource;
  if (!src || !ISSUED_APPROVALS.has(src)) return null;
  // 计划：句柄内的冻结副本优先；调用方传入的 plan 只用于比对，不用于执行
  const planSnapshot = src.plan;
  if (!isPlainObject(planSnapshot)) return null;
  if (isPlainObject(plan) && fullPlanDigestOf(plan) !== src.fullPlanDigest) {
    // 调用方计划与绑定快照不同：**拒绝**，不静默替换审计身份
    return null;
  }
  return {
    plan: planSnapshot,
    approval: src.approval,
    planDigest: src.planDigest,
    fullPlanDigest: src.fullPlanDigest,
    auditId: p4.auditId(planSnapshot, src.planDigest),
    expiresAtMs: src.expiresAtMs,
    expectedSubjectDigest: src.expectedSubjectDigest
  };
}

/** 覆盖全部字段的规范化摘要（与签发时同一算法）。 */
function fullPlanDigestOf(plan) {
  return sha256Of(JSON.stringify(
    Object.keys(plan).sort().map(k => [k, plan[k]])
  ));
}

/**
 * 核对受控批准绑定：登记表 + 完整计划 + 批准主体 + 主体摘要 + 实际文件指纹。
 *
 * 任一不符即拒绝，且**先于任何凭据/网络动作**。
 */
function verifyControlledApproval(options) {
  const o = options || {};
  const source = o.approvalSource;
  const plan = o.plan;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();

  // R4：必须是本模块签发过的对象。复制品 / 普通对象 / 环境变量都不在登记表内。
  if (!isPlainObject(source) && typeof source !== 'object') {
    return { ok: false, errorCode: ERR.APPROVAL_SOURCE_MISSING,
      reason: '缺少受控批准绑定；计划 JSON 自报字段不构成授权。' };
  }
  if (source === null || !ISSUED_APPROVALS.has(source)) {
    return { ok: false, errorCode: ERR.APPROVAL_SOURCE_MISSING,
      reason: '批准绑定非本模块受审入口签发（复制或自造对象不被接受）。' };
  }
  if (!isPlainObject(plan)) {
    return { ok: false, errorCode: ERR.PLAN_INVALID, reason: '缺少计划。' };
  }

  // R4：**先**用 P4 完整校验计划与批准，再谈绑定。此前宿主完全不调 P4 校验，
  // 于是「延长期限 / 替换 operatorRef / 加禁止字段」都能通过宿主批准检查。
  let validatedPlan;
  let validatedApproval;
  try {
    validatedApproval = p4.validateApprovalContext(source.approval);
    const nowForPlan = p4.resolveNowMs({ nowMs: now() });
    validatedPlan = p4.validatePlan(plan, { approval: validatedApproval, nowMs: nowForPlan });
    p4.assertApprovedTarget(validatedApproval, validatedPlan.targetUserId);
  } catch (error) {
    const code = String(error && error.code);
    const known = new Set(['PLAN_INVALID', 'CLOCK_INVALID', 'APPROVAL_CONTEXT_MISSING',
      'APPROVAL_CONTEXT_INVALID', 'TARGET_NOT_APPROVED']);
    return {
      ok: false,
      errorCode: known.has(code) ? ERR.PLAN_INVALID : ERR.APPROVAL_SOURCE_MISSING,
      reason: '计划或批准未通过核心校验。'
    };
  }

  // 计划**完整字段**绑定：既有 P4 摘要（核心算法）＋ 覆盖全部字段的规范化摘要
  let digest;
  let fullDigest;
  try {
    digest = p4.inputDigest(plan);
    fullDigest = fullPlanDigestOf(plan);
  } catch (_) {
    return { ok: false, errorCode: ERR.PLAN_INVALID, reason: '计划摘要计算失败。' };
  }
  if (source.planDigest !== digest || source.fullPlanDigest !== fullDigest) {
    return { ok: false, errorCode: ERR.APPROVAL_PLAN_BINDING_MISMATCH,
      reason: '批准绑定的计划摘要与当前计划不一致（含未覆盖字段）。' };
  }

  /**
   * S1：批准人要**真实一致**，不只是类型检查。
   * 此前只检查 `typeof === 'string'`，注释写「与签发时一致」但实际没比值。
   * 现在要求 `approval.approvedBy` 与句柄顶层 `approvedBy` 相等，
   * 且句柄内部快照必须处于冻结状态（防止签发后被改写）。
   */
  if (typeof source.approvedBy !== 'string' || source.approvedBy.length === 0 ||
    typeof source.approval.approvedBy !== 'string') {
    return { ok: false, errorCode: ERR.APPROVAL_SOURCE_MISSING, reason: '批准缺少确认人。' };
  }
  if (source.approval.approvedBy !== source.approvedBy) {
    return { ok: false, errorCode: ERR.APPROVAL_SOURCE_MISSING,
      reason: '批准上下文与绑定确认人不一致。' };
  }
  if (!Object.isFrozen(source.approval) || !Object.isFrozen(source.plan)) {
    return { ok: false, errorCode: ERR.APPROVAL_SOURCE_MISSING,
      reason: '批准绑定内部快照未被冻结，拒绝执行。' };
  }

  // 有效期：取**绑定值**与当前时刻比较，不用调用方传入的另一次读数
  if (typeof source.expiresAtMs !== 'number' || !Number.isFinite(source.expiresAtMs)) {
    return { ok: false, errorCode: ERR.APPROVAL_SOURCE_MISSING, reason: '批准缺少有效期。' };
  }
  if (source.expiresAtMs <= now()) {
    return { ok: false, errorCode: ERR.APPROVAL_SOURCE_MISSING, reason: '批准已过期。' };
  }

  // 写范围必须显式声明且只覆盖初始化
  if (!Array.isArray(source.writeScope) || source.writeScope.indexOf('initializePrimary') === -1) {
    return { ok: false, errorCode: ERR.APPROVAL_SOURCE_MISSING,
      reason: '批准未显式声明 initializePrimary 写范围。' };
  }

  // 文件指纹：CLI 两项 **＋** 本模块/P4/适配器/worker 的实际内容哈希。
  // 此前只比两项 CLI 常量，换掉实现文件照过；`fileFingerprint` 阶段也只是 push 名称。
  const actualImpl = computeImplementationFingerprint();
  for (const name of FINGERPRINT_FILES) {
    const expected = source.implementationFingerprint ? source.implementationFingerprint[name] : null;
    if (typeof expected !== 'string' || expected.length !== 64) {
      return { ok: false, errorCode: ERR.FINGERPRINT_MISMATCH,
        reason: '批准未绑定实现文件指纹：' + name };
    }
    if (actualImpl[name] === null || actualImpl[name] !== expected) {
      return { ok: false, errorCode: ERR.FINGERPRINT_MISMATCH,
        reason: '批准绑定的实现文件指纹与本机实际内容不一致：' + name };
    }
  }
  if (!isPlainObject(source.cliFingerprint) ||
    source.cliFingerprint.bundleSha256 !== FIXED.cliFingerprint.bundleSha256 ||
    source.cliFingerprint.entrySha256 !== FIXED.cliFingerprint.entrySha256) {
    return { ok: false, errorCode: ERR.FINGERPRINT_MISMATCH,
      reason: '批准绑定的文件指纹与本机固定安装不一致。' };
  }

  // 预期主体摘要：R4 要求绑定到受控批准，而不是只作为 options 传入
  if (typeof source.expectedSubjectDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(source.expectedSubjectDigest)) {
    return { ok: false, errorCode: ERR.CALLER_SUBJECT_UNVERIFIED,
      reason: '批准未绑定执行前受审的主体摘要预期值。' };
  }

  /**
   * S1/S3：返回**已核验的绑定快照**与预先算好的确定性 auditId。
   *
   * auditId 在这里由受控计划 + P4 算法得出，**不依赖子进程输出**。
   * S3 要求 started 与所有终态都能保留它 —— 此前它只在 worker 成功输出里
   * 才拿得到，超时/坏输出时整份报告的 `auditId` 为 null。
   */
  const snapshot = boundSnapshot(source, plan);
  if (snapshot === null) {
    return { ok: false, errorCode: ERR.APPROVAL_PLAN_BINDING_MISMATCH,
      reason: '批准绑定快照不可用或与当前计划不一致。' };
  }

  return {
    ok: true, errorCode: null, planDigest: digest, fullPlanDigest: fullDigest,
    approvedBy: source.approvedBy, expiresAtMs: source.expiresAtMs,
    expectedSubjectDigest: source.expectedSubjectDigest,
    // S1：worker 载荷的唯一来源
    boundPlan: snapshot.plan,
    boundApproval: snapshot.approval,
    // S3：确定性审计键，启动前即已确定
    auditId: snapshot.auditId
  };
}

/**
 * 计算完整云主体元组摘要：`[Type,AccountId,UserId,PrincipalId]` 的 UTF-8 JSON SHA-256。
 *
 * 严格保持字符串：不裁尾、不改大小写、不去空白。
 * 原值**不持久化**，只输出摘要。
 */
function callerTupleDigest(sts) {
  const parts = [sts.Type, sts.AccountId, sts.UserId, sts.PrincipalId];
  for (const p of parts) {
    if (typeof p !== 'string' || p.length === 0) return null;
  }
  return sha256Of(JSON.stringify(parts));
}

/**
 * 用**同一凭据快照**执行一次固定 STS GetCallerIdentity 只读核验。
 *
 * 复用既有：固定参数构建（`cliObserver`）、`spawnBounded`、JSON 解析
 * （`parseCliJson`）与 STS 字段检查（字段名对齐已验收投影）。
 * 只在内存取得四个字段并算摘要；**不修改旧观测器的输出契约**，不重写计时器。
 */
async function verifyCallerSubject(snapshot, deps) {
  const d = deps || {};
  const cryptoMod = d.crypto || crypto;
  const spawnFn = d.spawn;
  const limits = d.limits || cliObserver.LIMITS;
  if (typeof spawnFn !== 'function') {
    return { ok: false, errorCode: ERR.WORKER_FAILED, reason: 'NO_SPAWN' };
  }
  if (!snapshot || !snapshot.secretId || !snapshot.secretKey || !snapshot.sessionToken) {
    return { ok: false, errorCode: ERR.CREDENTIAL_FETCH_FAILED, reason: 'NO_SNAPSHOT' };
  }
  /**
   * R2：隔离目录必须存在且已核对。`buildIsolatedEnv` 会用 `isolationDir` 拼
   * APPDATA/LOCALAPPDATA，缺参会抛 `ERR_INVALID_ARG_TYPE` —— 未捕获地冒到
   * `executeOnce` 之外。这里显式守卫，缺目录即按固定错误码停止。
   */
  if (typeof d.isolationDir !== 'string' || d.isolationDir.length === 0) {
    return { ok: false, errorCode: ERR.CLI_ASSOCIATION_FAILED, reason: 'NO_ISOLATION_DIR' };
  }
  /**
   * R2：隔离环境必须用**已验收实现的真实签名** `(baseEnv, snapshot, isolationDir)`。
   * 此前误传 `(baseEnv, d.profileDir, d.cwd)` —— 第二参数被当成 snapshot，
   * 结果 `TENCENTCLOUD_SECRETID/SESSIONTOKEN` 全是 undefined，
   * STS 是「无凭据调用」，却因 mock 忽略凭据而看不出来。
   */
  const env = readOnly.buildIsolatedEnv(
    d.baseEnv || process.env,
    snapshot,
    d.isolationDir
  );
  // 同批凭据的三项必须真的注入；缺任一项即视为传参错误，就地停止
  for (const key of ['TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN']) {
    if (typeof env[key] !== 'string' || env[key].length === 0) {
      return { ok: false, errorCode: ERR.CREDENTIAL_FETCH_FAILED, reason: 'ENV_SNAPSHOT_MISSING', key };
    }
  }

  // R2：复用固定 STAGES 与 buildStageArgs，**不**手写参数/字段校验。
  const stage = cliObserver.STAGES.find(s => s.key === 'callerIdentity');
  if (!stage) {
    return { ok: false, errorCode: ERR.STS_FIELD_MISSING, reason: 'STS_STAGE_ABSENT' };
  }
  const apiArgs = cliObserver.buildStageArgs(stage, cliObserver.FIXED);
  const r = await cliObserver.spawnBounded(
    cliObserver.FIXED.nodeBin,
    [cliObserver.FIXED.cliEntry, ...apiArgs],
    { cwd: d.isolationDir, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    {
      spawn: (bin, argv, options) => spawnFn(bin, argv, options),
      __limits: limits
    }
  );
  if (r.spawnError || r.timedOut || r.overflow || r.closeNotObserved ||
    r.code === null || r.code === undefined || r.code !== 0) {
    return { ok: false, errorCode: ERR.CLI_ASSOCIATION_FAILED, reason: 'STS_CALL_FAILED' };
  }
  let payload;
  try {
    payload = cliObserver.parseCliJson(r.stdout, stage.service, stage.action);
  } catch (_) {
    return { ok: false, errorCode: ERR.STS_FIELD_MISSING, reason: 'STS_PARSE_FAILED' };
  }
  const data = isPlainObject(payload) && isPlainObject(payload.data) ? payload.data : payload;
  /**
   * R2：字段与身份类型检查同样走**既有校验器** `assertSts`，不重复手写。
   * 完整四元组只在内存中取用（原值不落报告）。
   */
  let sts;
  try {
    sts = cliObserver.assertSts(data, cryptoMod, 'extraSts');
  } catch (_) {
    // assertSts 的错误码是既有常量；映射到本宿主固定码，不外传其 message
    const typeBad = isPlainObject(data) && data.Type !== cliObserver.FIXED.acceptedStsType;
    return {
      ok: false,
      errorCode: typeBad ? ERR.STS_TYPE_MISMATCH : ERR.STS_FIELD_MISSING,
      reason: typeBad ? 'STS_TYPE' : 'STS_FIELD'
    };
  }
  // 完整主体元组摘要（原值只在内存）
  const digest = callerTupleDigest(data);
  if (digest === null) {
    return { ok: false, errorCode: ERR.CALLER_SUBJECT_UNVERIFIED, reason: 'TUPLE_INCOMPLETE' };
  }
  return {
    ok: true, errorCode: null, subjectDigest: digest,
    accountIdSha256: sts.accountIdSha256,
    accountIdTail: sts.accountIdTail,
    requestId: typeof sts.requestId === 'string' ? sts.requestId : null
  };
}

/**
 * 默认本地检查：只做路径、版本、指纹与计划字段检查。
 * **不**取凭据、不联网、不启动写 worker。
 */
async function localCheck(options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || null });

  // 1) 固定 SDK 文件存在性 + 指纹（只读文件哈希，不加载执行）
  let sdkOk = false;
  try {
    sdkOk = fs.existsSync(path.join(FIXED.sdkRoot, '@cloudbase', 'node-sdk'));
  } catch (_) { sdkOk = false; }
  push('sdk-path-present', sdkOk);

  // 2) 凭据宿主 / 适配器 / P4 核心可加载（加载不等于联网）
  //
  // `verifyFingerprint` 需要 `cliEntry`/`cliBundle` 两个**路径**；不传即抛
  // FIXED_PATH_MISSING，默认入口会一直 FAILED。这里默认取已验收观测器的固定
  // 路径，调用方仍可显式覆盖（离线测试用合成路径）。
  let modsOk = true;
  let fpDetail = null;
  try {
    credentialHost.verifyFingerprint({
      cliEntry: o.cliEntry || FIXED.cliEntry,
      cliBundle: o.cliBundle || FIXED.cliBundle
    });
  } catch (error) {
    modsOk = false;
    // 只记固定失败码，不外传 message / stack
    fpDetail = /^[A-Z_]{3,64}$/.test(String(error && error.code))
      ? String(error.code) : 'UNKNOWN';
  }
  push('cli-fingerprint-verified', modsOk, fpDetail);

  // 3) 计划字段（若提供）——只校验结构，不写任何地方
  if (o.plan !== undefined) {
    let planOk = false;
    try {
      p4.validatePlan(o.plan, {
        approval: o.approval || { approvedUserIds: ['u_' + '0'.repeat(40)], approvedBy: 'local-check', expiresAtMs: now() + 1000 },
        nowMs: now()
      });
      planOk = true;
    } catch (_) { planOk = false; }
    push('plan-fields-valid', planOk);
  }

  const all = checks.every(c => c.ok);
  return {
    status: all ? STATUS.LOCAL_READY : STATUS.FAILED,
    checks,
    credentialFetched: false,
    cloudCallAttempted: false,
    workerStarted: false,
    fixed: {
      appId: FIXED.appId, envId: FIXED.envId, region: FIXED.region,
      primaryId: FIXED.primaryId, cliFingerprint: FIXED.cliFingerprint
    }
  };
}

/**
 * 单次受控执行入口（供未来 Codex 受审入口调用；本轮仅离线测试使用）。
 *
 * 顺序：核对批准来源 → 核对文件指纹 → 一次取凭据 → 三阶段关联 →
 * **当次** STS 主体摘要核验 → 轮次 started → worker → 回读。
 *
 * 任一环节失败即停止，**不**取第二批凭据、不重试初始化。
 */
async function executeOnce(options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const report = {
    status: STATUS.FAILED,
    stoppedAt: null,
    errorCode: null,
    credentialFetched: false,
    cloudCallAttempted: false,
    workerStarted: false,
    stages: [],
    incomplete: []
  };

  // 1) 受控批准来源（**先于任何凭据/网络**）
  const approvalCheck = verifyControlledApproval({
    approvalSource: o.approvalSource, plan: o.plan, now
  });
  if (!approvalCheck.ok) {
    report.stoppedAt = 'approvalSource';
    report.errorCode = approvalCheck.errorCode;
    report.incomplete.push('未取得受控批准来源；在获取凭据之前停止，未发起任何外部动作。');
    return report;
  }
  report.stages.push('approvalSource');

  /**
   * S1：执行范围就此**冻结**为绑定快照。
   * 后续所有阶段（含跨多次 await 之后）只用 `boundPlan`/`boundApproval`，
   * 绝不再用调用方传入的 `o.plan`/`o.approval` —— 否则「核验一份、执行另一份」，
   * 改动值会落进审计（Codex 样本 1 与样本 3）。
   */
  const boundPlan = approvalCheck.boundPlan;
  const boundApproval = approvalCheck.boundApproval;
  // S3：确定性审计键此刻已确定，先放进报告；任何终态都能保留
  report.auditId = approvalCheck.auditId;
  report.roundId = typeof o.roundId === 'string' ? o.roundId : null;
  report.planDigest = approvalCheck.planDigest;

  // 2) 文件指纹（受控来源绑定 + 本机固定值一致）
  report.stages.push('fileFingerprint');

  // 3) 一次取凭据（同批快照）
  let snapshot;
  try {
    const credDeps = Object.assign({}, o.credentialDeps || {});
    // 复用同一注入点：CLI 阶段的 spawn 替身同样用于凭据命令（仅离线测试注入）
    if (!credDeps.spawn && typeof o.spawn === 'function') credDeps.spawn = o.spawn;
    // profile 是凭据宿主的固定入参：缺失时会回退到本机真实 authSessionDir，
    // 因此离线必须显式给合成 profile，避免指向真实登录目录。
    if (!credDeps.fixed) credDeps.fixed = {};
    if (!credDeps.fixed.authProfileDir) {
      const profile = o.profileDir || o.credentialProfileDir || null;
      if (profile) credDeps.fixed.authProfileDir = profile;
    }
    // 安全闸：若最终仍会回退到本机真实登录目录，本轮**不执行**（不读真实认证内容）
    const effectiveProfile = credDeps.fixed.authProfileDir;
    if (!effectiveProfile || effectiveProfile === cliObserver.FIXED.authSessionDir) {
      report.stoppedAt = 'credentialFetch';
      report.errorCode = ERR.CREDENTIAL_FETCH_FAILED;
      report.incomplete.push('未提供合成登录 profile 边界；为避免触及真实登录目录，在取凭据之前停止。');
      return report;
    }
    const fetched = await credentialHost.fetchTemporaryCredential({
      deps: credDeps, cwd: o.credentialCwd || null
    });
    if (fetched.attempted !== true) {
      report.stoppedAt = 'credentialFetch';
      report.errorCode = ERR.CREDENTIAL_FETCH_FAILED;
      report.incomplete.push('凭据命令未确认启动；未发起后续动作。');
      return report;
    }
    snapshot = readOnly.normalizeCredentialSnapshot(fetched.snapshot);
    report.credentialFetched = true;
    report.stages.push('credentialFetch');
  } catch (error) {
    report.stoppedAt = 'credentialFetch';
    report.errorCode = ERR.CREDENTIAL_FETCH_FAILED;
    /**
     * S4：使用凭据宿主的**实际固定错误码枚举**，不是大写正则。
     * `/^[A-Z_]{3,64}$/` 会把任意大写串当作合法失败类别透出。
     */
    const credentialCode = String(error && error.code);
    report.credentialFailureClass = CREDENTIAL_FAILURE_CODES.has(credentialCode)
      ? credentialCode : 'UNKNOWN';
    report.incomplete.push('未能取得合规临时凭据；未发起后续动作。');
    return report;
  }

  // 4) 三阶段身份/环境关联（matched 只说明归属，不是初始化许可）
  //
  // R2：本轮隔离目录**必须新建并经既有 `createIsolationDir` 核对**
  // （内部会 `assertIsolationClean` 复核「不存在认证文件」）。
  // 此前直接接受调用方传入的 `isolationDir` 且从不核对，
  // 于是 cwd 可能受项目认证或旧缓存影响。
  let isolationDir = null;
  try {
    isolationDir = readOnly.createIsolationDir('sandbox-primary-exec', {
      fixed: { isolationRoot: (o.isolationFixed && o.isolationFixed.isolationRoot) || FIXED.isolationRoot }
    });
  } catch (_) {
    report.stoppedAt = 'isolationDir';
    report.errorCode = ERR.CLI_ASSOCIATION_FAILED;
    report.incomplete.push('本轮隔离目录未能新建或未通过认证文件核对；未发起关联请求。');
    return report;
  }
  report.isolationDirCreated = true;

  let association;
  try {
    association = await readOnly.runCliAssociation(snapshot, isolationDir, {
      spawn: o.spawn,
      baseEnv: o.baseEnv || {}
    });
  } catch (_) {
    association = { matched: false };
  }
  report.cloudCallAttempted = true;
  if (!association || association.matched !== true) {
    report.stoppedAt = 'cliAssociation';
    report.errorCode = ERR.CLI_ASSOCIATION_FAILED;
    report.incomplete.push('归属关联未通过；未进入主体核验与事务。');
    return report;
  }
  report.stages.push('cliAssociation');

  // 5) 当次 STS 完整主体元组核验（**同一快照**，一次固定调用）
  const subject = await verifyCallerSubject(snapshot, {
    spawn: o.spawn, baseEnv: o.baseEnv, isolationDir,
    limits: o.limits
  });
  if (!subject.ok) {
    report.stoppedAt = 'callerSubject';
    report.errorCode = subject.errorCode;
    report.incomplete.push('当次云主体核验未通过；未进入事务。');
    return report;
  }
  // 与**受控批准绑定的**预期值比较（R4：不再是 options 传入的独立值，
  // 也不是从本次响应自动「学习」）
  if (approvalCheck.expectedSubjectDigest !== subject.subjectDigest) {
    // 同主账号但主体不同 → 停止，不自动放宽
    report.stoppedAt = 'callerSubject';
    report.errorCode = ERR.CALLER_SUBJECT_MISMATCH;
    report.incomplete.push('当次完整云主体与批准绑定的预期不一致（可能是角色会话变更）；已停止，未自动放宽。');
    return report;
  }
  report.stages.push('callerSubject');

  // 6) 轮次 started（不含秘密）；必须存在、await 成功、轮次完全匹配
  //
  // R4：此前 `persistRoundStarted` 是**可选**回调 —— 不提供也照样
  // push('roundStarted') 并启动 worker；`o.roundId` 也可与 `plan.roundId` 不同；
  // 返回 Promise 也没 await。实测「两个绕过同时出现、worker 仍启动 1 次」。
  const round = o.roundId;
  if (typeof round !== 'string' || round.length === 0) {
    report.stoppedAt = 'roundStarted';
    report.errorCode = ERR.ROUND_START_FAILED;
    report.incomplete.push('缺少本轮轮次标识；未发起写请求。');
    return report;
  }
  // 轮次必须与**绑定快照**里的轮次完全一致（不是任意取一个，也不是调用方可改的）
  if (typeof boundPlan.roundId === 'string' && boundPlan.roundId !== round) {
    report.stoppedAt = 'roundStarted';
    report.errorCode = ERR.ROUND_START_FAILED;
    report.incomplete.push('本轮轮次标识与绑定计划不一致；未发起写请求。');
    return report;
  }
  if (typeof o.persistRoundStarted !== 'function') {
    report.stoppedAt = 'roundStarted';
    report.errorCode = ERR.ROUND_START_FAILED;
    report.incomplete.push('未提供轮次 started 持久化能力；按规则不发写请求。');
    return report;
  }
  let created;
  try {
    // S3：确定性 auditId 此刻已算出并写入 started，不依赖子进程输出
    created = await o.persistRoundStarted({
      roundId: round,
      planDigest: approvalCheck.planDigest,
      auditId: approvalCheck.auditId
    });
  } catch (_) {
    created = false;
  }
  if (created !== true) {
    report.stoppedAt = 'roundStarted';
    report.errorCode = ERR.ROUND_ALREADY_STARTED;
    report.incomplete.push('轮次 started 记录未新建（同轮次已存在或创建失败）；按规则不发写请求、不重新初始化。');
    return report;
  }
  report.stages.push('roundStarted');

  /**
   * S1：worker 启动**前**复核批准有效期与**实际**实施文件绑定。
   * 前面已消耗凭据与关联耗时，实现文件也可能在此期间变化。
   */
  if (approvalCheck.expiresAtMs <= now()) {
    report.stoppedAt = 'approvalRecheck';
    report.errorCode = ERR.APPROVAL_SOURCE_MISSING;
    report.incomplete.push('异步耗时后批准已过期；未启动写 worker。');
    return report;
  }
  // 当次主体摘要必须与**批准绑定**的预期值一致（不再是 options 传入的独立值）
  if (approvalCheck.expectedSubjectDigest !== subject.subjectDigest) {
    report.stoppedAt = 'callerSubject';
    report.errorCode = ERR.CALLER_SUBJECT_MISMATCH;
    report.incomplete.push('当次完整云主体与批准绑定的预期不一致；已停止，未自动放宽。');
    return report;
  }
  // S1：启动前再核一次实际实现文件指纹（签发后文件可能已被改动）
  {
    const actualNow = computeImplementationFingerprint();
    for (const name of FINGERPRINT_FILES) {
      if (actualNow[name] === null ||
        actualNow[name] !== o.approvalSource.implementationFingerprint[name]) {
        report.stoppedAt = 'fileFingerprintRecheck';
        report.errorCode = ERR.FINGERPRINT_MISMATCH;
        report.incomplete.push('启动前复核发现实现文件已变化；未启动写 worker：' + name);
        return report;
      }
    }
  }
  report.stages.push('implementationRecheck');

  /**
   * S3-4（Codex 2026-10-10）：**外部动作前**确认结果保存能力。
   * 此前 `persistResult` 存在性在成功提交后才检查 —— 删除该回调时完整链照样
   * commit=1，随后才说「未提供保存能力」。保存能力缺失应在发写请求前拒绝。
   */
  if (typeof o.persistResult !== 'function') {
    report.stoppedAt = 'saveCapability';
    report.errorCode = ERR.SAVE_CAPABILITY_MISSING;
    report.incomplete.push('未提供结果保存能力；按规则在发起写请求前停止，未启动写 worker。');
    return report;
  }

  // 7) 启动写 worker（同批凭据经私有 stdin 一次传入随即关闭）
  report.workerStarted = true;
  /**
   * S1：载荷取自**绑定快照**，不是调用方传入的 `o.plan`/`o.approval`。
   * S2：把凭据期限与批准期限一并传入，由 worker 在**执行期**各操作边界复核
   * （`fixedNowMs` 只作审计记录时间，P4 的有效期校验改用实时 now）。
   */
  const workerResult = await runExecutionWorker({
    snapshot, plan: boundPlan, approval: boundApproval,
    verifiedCaller: true, fixedNowMs: o.fixedNowMs,
    roundId: round,
    // S2：执行期期限由 worker 复核
    approvalExpiresAtMs: approvalCheck.expiresAtMs,
    expectedAuditId: approvalCheck.auditId,
    // S4：父层按本计划确定性键逐项核对 worker 输出的摘要/审计键
    expected: {
      auditId: approvalCheck.auditId,
      inputDigest: approvalCheck.planDigest
    },
    // R2/R3：worker cwd 绑定到**本次新建并经核对**的隔离目录
    cwd: isolationDir,
    spawn: o.spawnWorker, limits: o.workerLimits
  });

  /**
   * S3：worker 消失（超时/信号/坏输出）时，轮次与确定性 auditId 仍必须保留。
   * 此前这些值只在子进程成功输出里才拿得到；此处**不再**用worker 的输出
   * 覆盖已在启动前确定的键。
   */
  report.planDigest = approvalCheck.planDigest;
  report.auditId = approvalCheck.auditId;
  report.roundId = round;
  if (workerResult && typeof workerResult.auditId === 'string' &&
    workerResult.auditId !== approvalCheck.auditId) {
    // S4：worker 输出的审计键与本计划不一致 —— 不升级为成功，如实记录
    report.incomplete.push('worker 输出的审计键与本计划确定性键不一致，未采信。');
    workerResult.auditIdMismatch = true;
  }
  report.bootstrap = workerResult && workerResult.bootstrap ? workerResult.bootstrap : null;
  report.observed = workerResult && workerResult.observed ? workerResult.observed : null;
  report.observeFailed = Boolean(workerResult && workerResult.observeFailed);
  report.outcome = workerResult && workerResult.outcome ? workerResult.outcome : 'UNKNOWN';
  report.granted = workerResult && workerResult.granted === true;
  report.initialized = workerResult && workerResult.initialized === true;
  report.observationConfirmed = workerResult && workerResult.observationConfirmed === true;
  // N2：组合矛盾码与两个聚合结论如实带到报告（供核对与交付核对）
  report.stateContradictions = workerResult && Array.isArray(workerResult.stateContradictions)
    ? workerResult.stateContradictions.slice()
    : null;
  report.commitFactEstablished = workerResult && workerResult.commitFactEstablished === true;
  report.fullInitializationSuccess = workerResult && workerResult.fullInitializationSuccess === true;
  report.bindingMismatch = workerResult && workerResult.bindingMismatch === true;
  report.workerProcess = workerResult && workerResult.processFacts
    ? workerResult.processFacts : null;

  /**
   * S3：结果未知时，父层用**同批仍有效的凭据**做固定两条只读核对
   * （primary + 本计划审计），绝不再次进入 initializePrimary。
   * 「子进程是否已退出」与「平台事务是否仍在途」分别记录 ——
   * 未确认终止时，一次「暂时没读到」不能升级为确定未提交。
   *
   * S3-1（Codex 2026-10-10）：核对**不是**可选回调。上一版只接受外部注入的
   * `o.reconcileReadOnly`，超时样本同批凭据仍有效却记 `NO_RECONCILE_CAPABILITY`、
   * 实际两读为 0。现在默认走 P4 `observePrimary` 的真实契约（真正发出两条
   * 固定读取）；外部回调仅作为**合成测试注入点**覆盖默认实现。
   *
   * S3-3（Codex 2026-10-10）：核对返回值逐字段/逐值净化，不让普通返回对象
   * 里的任意文本进入报告。
   */
  /**
   * N2（Codex §2）：只有**完整初始化成功**才进入保存成功分支。
   * `fullInitializationSuccess` 由聚合点按 outcome 穷举 + 双向一致性 + 绑定
   * + 观察完整算出；`ok` 与 `observationConfirmed` 是它的必要条件，
   * 这里显式并列，避免仅凭回执布尔或观察布尔放行。
   */
  if (!workerResult || workerResult.ok !== true ||
    report.observationConfirmed !== true ||
    report.fullInitializationSuccess !== true) {
    /**
   * N2（Codex 2026-10-10 §3.1）：`mayHaveWritten` 的判定。
   *
   * 绑定不匹配（他计划键/摘要）或组合矛盾时，回执属**不可信结果**：
   * 执行**可能**已发生（只是回执无法绑定本计划），因此必须进入同批上下文的
   * 保守只读核对。此前这两项**未**纳入本判定 → 跳过核对，
   * 却声称「进入保守核对」（实测 readOnlyGet=0）。
   *
   * 注意：worker 进程事实本身干净（正常退出、无信号）时，
   * 仍按不可信处理 —— 干净退出只说明进程结束，不说明数据库提交结果。
   */
  const mayHaveWritten = Boolean(workerResult && workerResult.resultUnknown) ||
    report.observeFailed === true ||
    (workerResult && workerResult.bindingMismatch === true) ||
    (workerResult && Array.isArray(workerResult.stateContradictions) &&
      workerResult.stateContradictions.length > 0) ||
    (workerResult && workerResult.processFacts
      ? (workerResult.processFacts.timedOut || workerResult.processFacts.signal !== null ||
         workerResult.processFacts.closeNotObserved ||
         workerResult.processFacts.terminationRequested === true ||
         workerResult.processFacts.terminationConfirmed === false)
      : false);
  report.resultUnknown = mayHaveWritten;
    // 同批凭据是否仍可用（过期则不做核对，明确留待只读接续）
    const credentialUsable = Number.isFinite(snapshot.expiresAtMs) && snapshot.expiresAtMs > now();
    if (mayHaveWritten && credentialUsable) {
      let rec = null;
      try {
        rec = await runReadOnlyReconcile({
          snapshot,
          plan: boundPlan,
          approval: boundApproval,
          isolationDir,
          auditId: approvalCheck.auditId,
          // 合成测试可注入实现（离线）；生产路径用默认 P4 两读
          inject: o.reconcileReadOnly,
          deps: o.reconcileDeps,
          // N1：统一时钟（测试可在读取事件上推进）
          now
        });
      } catch (_) { rec = null; }
      const expiredAtStage = rec && typeof rec.expiredAtStage === 'string'
        ? rec.expiredAtStage : null;
      // S3-3：净化后才进入报告 —— 合成回调返回的 `extra` 之类一律丢弃。
      // N2：按真实来源标记，并要求组合自洽（不靠单个 state 放行）。
      report.reconcile = projectReconcile(rec ? rec.raw : null, {
        auditId: approvalCheck.auditId,
        inputDigest: approvalCheck.planDigest
      }, {
        source: o.reconcileReadOnly ? 'INJECTED' : 'P4_OBSERVE'
      });
      report.reconcileAttempted = true;
      // 如实表达「未确认」为 false，而不是 undefined（不谎称已确认）
      report.reconcileConfirmed = false;
      /**
       * N1：核对期间同批凭据过期 → **不确认**。
       * 保留 worker 进程事实、既有提交事实与未知终态；
       * 不重新取凭据、不重新初始化、不重写。
       */
      if (expiredAtStage !== null) {
        report.reconcileExpiredAtStage = expiredAtStage;
        report.reconcile.state = 'unconfirmed';
        report.incomplete.push('核对期间同批凭据已过期（' + expiredAtStage +
          '）：停止后续读取、不确认结论；保留未知终态，待只读接续。');
      } else if (report.reconcile.selfConsistent === true &&
        report.reconcile.state === 'present' &&
        report.reconcile.auditId === approvalCheck.auditId &&
        report.reconcile.primaryStatus === 'active') {
        report.observationConfirmed = true;
        report.reconcileConfirmed = true;
      } else if (report.reconcile.contradiction !== null) {
        // N2：组合矛盾（如 state=present 但存在性为 false）不确认
        report.incomplete.push('核对结论组合矛盾（' + report.reconcile.contradiction +
          '）：已降级为未确认，不采信注入或矛盾字段。');
      }
    } else if (mayHaveWritten) {
      report.reconcileAttempted = false;
      report.reconcileSkipReason = 'CREDENTIAL_EXPIRED_NO_RECONCILE';
    }
    report.stoppedAt = 'worker';
    report.errorCode = report.resultUnknown ? ERR.RESULT_UNKNOWN : ERR.WORKER_FAILED;
    report.incomplete.push(report.resultUnknown
      ? '事务结果未知或核对未完成：保留轮次与审计 ID，待只读核对；不刷新凭据后重写。'
      : '写 worker 未成功完成；未重试初始化。');
    /**
     * S3-2：结果未知**也要落盘**。「不保存为成功」不等于「不保存未知结果」。
     * 上一版直接 return，执行事实、终止状态与核对结论会随进程丢失。
     * 保存类型显式区分，不覆盖既有记录，不自动重试初始化。
     */
    if (typeof o.persistResult === 'function') {
      let savedUnknown;
      try {
        savedUnknown = await o.persistResult({
          roundId: round,
          planDigest: approvalCheck.planDigest,
          auditId: approvalCheck.auditId,
          // 终态类型：未知结果**不是**成功
          recordType: report.resultUnknown ? 'RESULT_UNKNOWN' : 'FAILED',
          outcome: report.outcome,
          initialized: report.initialized,
          granted: report.granted,
          observationConfirmed: report.observationConfirmed,
          resultUnknown: report.resultUnknown,
          reconcileAttempted: report.reconcileAttempted === true,
          reconcileConfirmed: report.reconcileConfirmed === true,
          reconcile: report.reconcile,
          workerProcess: report.workerProcess
        });
      } catch (_) {
        savedUnknown = false;
      }
      report.unknownPersisted = savedUnknown === true;
      if (savedUnknown !== true) {
        report.incomplete.push('未知结果落盘未新建成功；保留 started 记录，禁止重试初始化。');
      }
    } else {
      report.unknownPersisted = false;
      report.incomplete.push('未提供结果保存能力，未知结果仅在内存中产出。');
    }
    return report;
  }

  // 8) 结果保存：**新建**保存；失败则保留 started 并停止，不重试初始化
  // （保存能力已在启动 worker 前确认存在，此处不再重复缺失分支）
  let saved;
  try {
    saved = await o.persistResult({
      roundId: round,
      planDigest: approvalCheck.planDigest,
      auditId: report.auditId,
      // 终态类型：成功完成（未知结果走另一分支，绝不记为完成）
      recordType: 'COMPLETED',
      outcome: report.outcome,
      observationConfirmed: report.observationConfirmed,
      // N2（§3.2）：保存载荷与报告状态保持一致 —— 授予事实与初始化事实
      // 必须成对出现，避免落盘记录与报告互相矛盾。
      initialized: report.initialized,
      granted: report.granted
    });
  } catch (_) {
    saved = false;
  }
  if (saved !== true) {
    report.status = STATUS.PLAN_READY;
    report.resultPersisted = false;
    report.incomplete.push('结果保存未新建成功；保留 started 记录并停止，禁止重试初始化。');
    return report;
  }
  report.resultPersisted = true;
  report.stages.push('worker');
  report.stages.push('resultPersisted');
  report.status = STATUS.PLAN_READY;
  return report;
}

/**
 * 启动写 worker 子进程：凭据只经私有 stdin 一次传入随即关闭。
 *
 * R3 返修要点（此前这一段是**另写的一套**不可靠收尾）：
 *  - 不再自己实现计时器 / 输出监听 —— 改为**复用**已验收的 `spawnBounded`
 *    （stderr 也读、合并输出限额、close 的 code/signal 都核）。
 *  - 退出事实**优先于 stdout**：非零退出 / 信号 / 超时 / 溢出 / 启动失败一律
 *    直接判失败，绝不因 stdout 里写着 `ok:true` 就接受成功。
 *  - 超时属「写请求可能已发出」→ 归**结果未知**，保留 auditId 与轮次，
 *    不重试写。
 *  - worker 输出经**逐字段重建**投影，不透传对象（未知字段直接丢弃）。
 */
async function runExecutionWorker(options) {
  const o = options || {};
  const spawnFn = o.spawn;
  if (typeof spawnFn !== 'function') {
    return { ok: false, errorCode: ERR.WORKER_FAILED, reason: 'NO_SPAWN', resultUnknown: false };
  }
  const limits = o.limits || cliObserver.LIMITS.cli;

  /**
   * 凭据载荷：只经**私有 stdin** 一次写入随即关闭，不进命令行 / 环境 / 磁盘。
   * 字段与 worker 的 `ALLOWED_PAYLOAD_FIELDS` 一致；**不含** sdkRoot 等可改加载路径的键。
   */
  const payload = JSON.stringify({
    credential: {
      secretId: o.snapshot.secretId,
      secretKey: o.snapshot.secretKey,
      sessionToken: o.snapshot.sessionToken,
      expiresAtMs: o.snapshot.expiresAtMs
    },
    plan: o.plan,
    approval: o.approval,
    verifiedCaller: o.verifiedCaller === true,
    fixedNowMs: o.fixedNowMs,
    // S2：受控批准的到期时刻必须随载荷传给 worker，由其在执行期各边界复核。
    // 缺该字段 worker 会按「无批准期限约束」拒绝执行。
    approvalExpiresAtMs: o.approvalExpiresAtMs
  });
  // stdin 写入失败必须**如实记录**（此前完全忽略）
  let stdinFailure = null;

  const r = await cliObserver.spawnBounded(
    FIXED.nodeBin,
    [FIXED.workerPath],
    {
      cwd: o.cwd,
      env: { PATH: '', SystemRoot: process.env.SystemRoot || '' },
      shell: false, windowsHide: true
    },
    {
      spawn: (bin, argv, spawnOptions) => {
        const child = spawnFn(bin, argv, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
        if (child && child.stdin && typeof child.stdin.write === 'function') {
          try {
            child.stdin.on('error', () => { stdinFailure = 'STDIN_STREAM_ERROR'; });
            child.stdin.write(payload, 'utf8');
            child.stdin.end();
          } catch (_) {
            stdinFailure = 'STDIN_WRITE_FAILED';
          }
        } else {
          stdinFailure = 'STDIN_UNAVAILABLE';
        }
        return child;
      },
      __limits: limits
    }
  );

  /**
   * S3：stdin 失败**不能**单凭该错误断言「载荷必未送达/零写」。
   * stdin 写失败可能发生在管道已部分接收之后；子进程已启动即可能已执行。
   * 因此保守判定为「可能已写」→ 结果未知，交父层只读核对。
   * 只有 spawnError（根本没启动）才允许确定未写。
   */
  if (stdinFailure !== null && !r.spawnError) {
    return projectWorkerOutput(null, {
      spawnError: false, timedOut: false, overflow: false,
      signal: null, exitCode: (r.code === undefined ? null : r.code),
      closeNotObserved: Boolean(r.closeNotObserved),
      terminationRequested: Boolean(r.terminationRequested),
      terminationConfirmed: Boolean(r.terminationConfirmed)
    }, true, stdinFailure, o.expected);
  }

  // R3-b/d：**先**判退出事实。stdout 内容不能覆盖进程事实。
  const processFacts = {
    spawnError: Boolean(r.spawnError),
    timedOut: Boolean(r.timedOut),
    overflow: Boolean(r.overflow),
    signal: r.signal || null,
    exitCode: (r.code === undefined ? null : r.code),
    closeNotObserved: Boolean(r.closeNotObserved),
    terminationRequested: Boolean(r.terminationRequested),
    terminationConfirmed: Boolean(r.terminationConfirmed)
  };

  // 写请求**可能已经发出**（子进程已启动）的情况：退出事实异常或超时
  const mayHaveWritten = !processFacts.spawnError;
  const resultUnknown = mayHaveWritten && (
    processFacts.timedOut ||
    processFacts.signal !== null ||
    processFacts.exitCode !== 0 ||
    processFacts.closeNotObserved
  );

  /**
   * S3：退出码 0 **不**证明数据库提交结果确定。
   * - 超时 / 信号 / 非零 / close 未观察到 → 结果未知；
   * - **stdout 解析失败也按未知处理**（此前判 `WORKER_FAILED/resultUnknown=false`，
   *   等于断言「没写」，Codex 样本 `malformed-output-clean-exit`）；
   * - 启动失败（spawnError）才允许确定未写。
   */
  if (processFacts.spawnError) {
    return projectWorkerOutput(null, processFacts, false, null, o.expected);
  }
  if (resultUnknown) {
    return projectWorkerOutput(null, processFacts, true, null, o.expected);
  }
  if (processFacts.timedOut || processFacts.overflow) {
    return projectWorkerOutput(null, processFacts, mayHaveWritten, null, o.expected);
  }

  /**
   * 只有退出事实干净时才读 stdout。
   * `expected` 传入本计划的确定性键，供 S4 逐项精确核对。
   */
  let parsed = null;
  try {
    parsed = JSON.parse(String(r.stdout || ''));
  } catch (_) {
    parsed = null;
  }
  // S3：退出干净但输出坏/缺 → 保守留作待核对
  if (!isPlainObject(parsed)) {
    return projectWorkerOutput(null, processFacts, true, 'MALFORMED_OUTPUT', o.expected);
  }
  return projectWorkerOutput(parsed, processFacts, false, null, o.expected);
}

/**
 * S4：凭据失败类别白名单，**直接取自凭据宿主的实际导出**（不手抄近似名）。
 * 手抄/正则会在宿主新增或改名时失配，也会放过任意大写串。
 */
const CREDENTIAL_FAILURE_CODES = new Set(Object.values(credentialHost.ERR));

/** S4：有限枚举（值白名单，与 worker 层同一套，不新增任意字符串放行规则）。 */
const PARENT_OUTCOMES = Object.freeze(['initialized', 'alreadyPresent', 'auditAlreadyPresent']);
/**
 * N2 §3.2：判断一个 outcome 是否属于**合法**集合。
 * `'UNKNOWN'` 与缺失**不**合法 —— 未知不能承载「已初始化」的肯定事实。
 */
function legalOutcomeFor(outcome) {
  return typeof outcome === 'string' && PARENT_OUTCOMES.indexOf(outcome) !== -1;
}
const PARENT_OBSERVED_STATES = Object.freeze(['present', 'absent', 'inconsistent', 'unconfirmed']);
const PARENT_PRIMARY_STATUS = Object.freeze(['active', 'disabled']);
const DIGEST_HEX_32 = /^[0-9a-f]{32}$/;
const REQUEST_ID_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 父层严格投影：**字段名与字段值都限定**。
 *
 * R3-c：此前直接透传 worker 对象，未知字段会原样进入报告。
 * S4：仅限定字段名还不够 —— `outcome`、`bootstrap.errorCode/inputDigest/requestIds`、
 *      `observed.state/primaryStatus/errorCode` 等**已知字段内**可放任意字符串
 *      （Codex 样本 `known-field-projection-leak`实测 `SYNTH_PRIVATE_MARKER` 全被保留）。
 * 现在这些字段一律走有限枚举/格式校验，非法值归固定未知值。
 *
 * @param {object} parsed worker 输出（可能为 null）
 * @param {object} facts 进程事实
 * @param {boolean} unknown 父层判定的「可能已写」
 * @param {string} [reason] 失败类别（仅固定短语，不透传任意字符串）
 * @param {object} [expected] 本计划的期望值 `{auditId, inputDigest}`，逐项精确核对
 */
function projectWorkerOutput(parsed, facts, unknown, reason, expected) {
  const base = {
    ok: false,
    errorCode: ERR.WORKER_FAILED,
    // S3：worker 声明的未知与父层判定**保守合并**，父层正常退出不覆盖业务未知
    resultUnknown: Boolean(unknown),
    processFacts: Object.freeze({
      spawnError: facts.spawnError, timedOut: facts.timedOut, overflow: facts.overflow,
      signal: facts.signal, exitCode: facts.exitCode, closeNotObserved: facts.closeNotObserved,
      terminationRequested: facts.terminationRequested,
      terminationConfirmed: facts.terminationConfirmed
    }),
    bootstrap: null, observed: null, observeFailed: false,
    outcome: 'UNKNOWN', granted: false, initialized: false,
    observationConfirmed: false, auditId: null,
    reason: typeof reason === 'string' ? reason : null
  };
  if (!isPlainObject(parsed)) return base;

  // 逐字段重建；未列出的字段（无论叫什么）都不进入结果
  const out = Object.assign({}, base);
  // S3：worker 自己声明 resultUnknown:true 时**必须**保守合并，不能被父层 false 覆盖
  if (parsed.resultUnknown === true) out.resultUnknown = true;
  /**
   * S4（Codex 2026-10-10）：成功路径必须**提供且精确匹配**本计划的关键键/摘要。
   * 顶层 `auditId` 与 `bootstrap` 的绑定都要匹配，否则不得升级为成功 ——
   * 交给 executeOnce 进入保守只读核对，而不是仅把字段置 null 后照旧采信 `ok:true`。
   */
  out.auditId = (expected && typeof expected.auditId === 'string' &&
    parsed.auditId === expected.auditId) ? expected.auditId : null;
  out.ok = parsed.ok === true && out.resultUnknown === false;
  if (typeof parsed.errorCode === 'string' && executionWorker.CORE_ERROR_CODES.has(parsed.errorCode)) {
    out.errorCode = parsed.errorCode;
  } else if (out.resultUnknown) {
    out.errorCode = ERR.RESULT_UNKNOWN;
  }
  if (isPlainObject(parsed.bootstrap)) out.bootstrap = projectBootstrap(parsed.bootstrap, expected);
  if (isPlainObject(parsed.observed)) out.observed = projectObserved(parsed.observed);
  out.observeFailed = parsed.observeFailed === true;
  // S4：outcome 走有限枚举
  out.outcome = typeof parsed.outcome === 'string' && PARENT_OUTCOMES.indexOf(parsed.outcome) !== -1
    ? parsed.outcome : 'UNKNOWN';
  out.granted = parsed.granted === true;
  out.initialized = parsed.initialized === true;
  out.observationConfirmed = parsed.observationConfirmed === true;

  /**
   * N2（Codex 2026-10-10 §3.1/§3.2）：**一个明确的聚合点**判定成功。
   *
   * 字段各自合法不等于组合结论成立。此前顶层 `ok/initialized/granted/
   * observationConfirmed` 被独立采信，实测两种漏检：
   *  - 他计划键+ 摘要 → 只把键置 null，`initialized/granted` 仍为 true，
   *    且 `bindingMismatch` **未**纳入 mayHaveWritten → 跳过核对
   *    （实测 readOnlyGet=0，却声称「进入保守核对」）；
   *  - 键/摘要精确匹配但 `bootstrap.ok/initialized/granted=false`、
   *    `observed.state=unconfirmed`、存在性全 false → 顶层自报成功仍被接受，
   *    实测保存为 COMPLETED。
   *
   * 现在：顶层成功必须与**已净化的 bootstrap / observed 相互一致**；
   * 不一致或缺项一律降级，并把「绑定不匹配」当作**不可信结果**
   * （可能已执行 → 交 executeOnce 做保守只读核对），而不是确定未写。
   * 同时撤销未经核实的 initialized/granted —— 不把回执自报当成已证实事实。
   */
  const bs = out.bootstrap;
  const ob = out.observed;
  const topLevelBinding = out.auditId !== null;
  const bindingMatched = topLevelBinding && bs !== null && bs.bindingMatched === true;

  // 组合一致性：顶层声称的每件事都必须在 bootstrap/observed 里有对应支撑
  const contradictions = [];
  if (bindingMatched) {
    if (bs.ok !== true) contradictions.push('BOOTSTRAP_NOT_OK');
    if (out.initialized === true && bs.initialized !== true) contradictions.push('INITIALIZED_NOT_IN_BOOTSTRAP');
    if (out.granted === true && bs.granted !== true) contradictions.push('GRANTED_NOT_IN_BOOTSTRAP');
    if (out.outcome === 'initialized' && bs.outcome !== 'initialized') contradictions.push('OUTCOME_MISMATCH');
  }
  if (out.observationConfirmed === true) {
    /**
     * N2 §3.1：「已核对确认」必须由 observed **完整**支撑 ——
     * state=present + 两条存在性 + **primaryStatus='active'**。
     * 此前只检查前两项，`primaryStatus='disabled'` 或该字段缺失时仍被确认，
     * 实测两例都 `resultPersisted=true` 且保存 COMPLETED。
     *
     * 说明：`projectReconcile` 已有 STATUS_NOT_ACTIVE 检查，但它**不能替代**
     * 本处 —— 那是父进程核对路径，本处是 worker 正常返回路径。
     */
    if (ob === null || ob.state !== 'present') contradictions.push('OBSERVED_NOT_PRESENT');
    else {
      if (ob.primaryPresent !== true) contradictions.push('OBSERVED_PRIMARY_ABSENT');
      if (ob.auditPresent !== true) contradictions.push('OBSERVED_AUDIT_ABSENT');
      // 资格状态必须**存在且为 active**：缺失或非 active 都不得确认
      if (typeof ob.primaryStatus !== 'string') contradictions.push('OBSERVED_PRIMARY_STATUS_MISSING');
      else if (ob.primaryStatus !== 'active') contradictions.push('OBSERVED_PRIMARY_STATUS_NOT_ACTIVE');
    }
  }
  // 顶层 initialized 但 bootstrap 明确否认 → 不采信顶层自报
  if (bs !== null && bs.initialized === false && out.initialized === true) {
    contradictions.push('TOP_LEVEL_INITIALIZED_DENIED_BY_BOOTSTRAP');
  }

  /**
   * N2（Codex 2026-10-10 §2）：**完整结果组合规则**。
   *
   * 前一版的检查大多位于 `if (out.initialized === true)` 之内 ——
   * initialized=false 时，UNKNOWN outcome、denied initialized outcome 等
   * 仍可搭配顶层 ok=true / observationConfirmed=true 被保存为 COMPLETED。
   * 实测四个组合（两层同名字段、其余沿用成功载荷）：
   *   UNKNOWN+false/false、initialized+false/false、
   *   auditAlreadyPresent+false/false、alreadyPresent+false/**true**
   * 全部 `observationConfirmed=true` 且保存 COMPLETED。
   *
   * 现在改为**按 outcome 穷举合法组合**（不看 initialized 的取值）：
   *
   * | P4 原始分支        | outcome             | granted | initialized | 可保存完整成功 |
   * |--------------------|---------------------|---------|-------------|----------------|
   * | 首建并提交          | initialized         | true    | true        | 是（需绑定+观察完整）|
   * | primary 已存在      | alreadyPresent      | false   | false       | 否（保守停止/核对）|
   * | 审计在而 primary 缺  | auditAlreadyPresent | false   | false       | 否（冲突停止）    |
   * | 未知/缺失/组合矛盾  | UNKNOWN 或非法       | —       | —           | 否              |
   *
   * 依据 P4 `initializePrimary` 的三个真实返回：
   *  - initialized：返回 granted=true、auditId、inputDigest；
   *  - alreadyPresent：返回 granted=false、existing，**不返回 auditId/inputDigest**；
   *  - auditAlreadyPresent：返回 granted=false、auditId，**不返回 inputDigest**。
   * worker 的 `normalizeBootstrapResult` 不会凭空补出缺失字段，
   * 因此后两分支天然**不满足绑定**，应走保守核对而非伪装成初始化成功。
   *
   * 同时核对**顶层与 bootstrap 双向一致**（不只检查「true 是否有支撑」，
   * 也要拦住相反方向的矛盾）。
   */
  // 双向一致性：顶层与 bootstrap 的 outcome/initialized/granted 必须相互一致
  if (bs !== null) {
    if (bs.outcome !== out.outcome) contradictions.push('BOOTSTRAP_OUTCOME_MISMATCH');
    if (bs.initialized !== out.initialized) contradictions.push('BOOTSTRAP_INITIALIZED_MISMATCH');
    if (bs.granted !== out.granted) contradictions.push('BOOTSTRAP_GRANTED_MISMATCH');
  }

  // 未知/缺失 outcome：**任何**取值下都不能承载完整初始化成功
  if (!legalOutcomeFor(out.outcome)) {
    contradictions.push('UNKNOWN_OR_MISSING_OUTCOME');
    // 明确否定肯定事实，避免 ok=true 与 observationConfirmed 单独放行
    if (out.initialized === true) contradictions.push('INITIALIZED_WITH_UNKNOWN_OUTCOME');
    if (out.granted === true) contradictions.push('GRANTED_WITH_UNKNOWN_OUTCOME');
  } else if (bs !== null && !legalOutcomeFor(bs.outcome)) {
    contradictions.push('BOOTSTRAP_OUTCOME_UNKNOWN');
  }

  // 按 outcome 穷举该分支的合法布尔组合
  switch (out.outcome) {
    case 'initialized':
      // 首建并提交：两层都必须 granted+initialized，且绑定精确
      if (out.granted !== true) contradictions.push('INITIALIZED_WITHOUT_GRANTED');
      if (out.initialized !== true) contradictions.push('INITIALIZED_OUTCOME_WITHOUT_INITIALIZED_FLAG');
      break;
    case 'alreadyPresent':
      // 已有 primary：P4 明确 granted=false、零写入、不重复授予
      if (out.granted === true) contradictions.push('ALREADY_PRESENT_CLAIMS_GRANT');
      if (out.initialized === true) contradictions.push('ALREADY_PRESENT_CLAIMS_INITIALIZED');
      break;
    case 'auditAlreadyPresent':
      // 审计在而 primary 缺：P4 因状态冲突停止，不是成功初始化
      if (out.granted === true) contradictions.push('AUDIT_ONLY_CLAIMS_GRANT');
      if (out.initialized === true) contradictions.push('AUDIT_ONLY_CLAIMS_INITIALIZED');
      break;
    default:
      // UNKNOWN / 缺失 / 非法：上面的未知分支已记录矛盾
      break;
  }
  // bootstrap 侧同样按分支核对（防止顶层合规、bootstrap 越界）
  if (bs !== null) {
    if (bs.outcome === 'alreadyPresent' &&
      (bs.granted === true || bs.initialized === true)) {
      contradictions.push('BOOTSTRAP_ALREADY_PRESENT_CLAIMS_FACTS');
    }
    if (bs.outcome === 'auditAlreadyPresent' &&
      (bs.granted === true || bs.initialized === true)) {
      contradictions.push('BOOTSTRAP_AUDIT_ONLY_CLAIMS_FACTS');
    }
    if (bs.outcome === 'initialized' &&
      (bs.granted !== true || bs.initialized !== true)) {
      contradictions.push('BOOTSTRAP_INITIALIZED_MISSING_FACTS');
    }
  }

  if (!bindingMatched) {
    // 绑定不匹配 = **不可信结果**：可能已执行（他计划/坏回执自报成功），
    // 交 executeOnce 在同批上下文做保守核对；不声称已初始化。
    out.ok = false;
    out.observationConfirmed = false;
    out.bindingMismatch = true;
    // N2（Codex §3.1）：干净退出只说明进程结束，不说明数据库提交结果。
    // 绑定不匹配时**必须**视为「结果未知」，否则 executeOnce 会跳过保守核对
    // （实测 readOnlyGet=0 却声称进入核对）。
    out.resultUnknown = true;
    // 撤销未经验证的授予/初始化事实（保留「回执自报过」这一原始形态）
    out.rawSelfReportedInitialized = parsed.initialized === true;
    out.rawSelfReportedGranted = parsed.granted === true;
    out.initialized = false;
    out.granted = false;
    if (out.errorCode === null) out.errorCode = ERR.RESULT_UNKNOWN;
  }

  if (contradictions.length > 0) {
    out.ok = false;
    out.observationConfirmed = false;
    out.stateContradictions = Object.freeze(contradictions.slice(0, 8));
    // 组合矛盾同样意味着「无法确证是否已提交」
    out.resultUnknown = true;
    out.initialized = false;
    out.granted = false;
    if (out.errorCode === null) out.errorCode = ERR.RESULT_UNKNOWN;
  }

  /**
   * N2（Codex §2）：区分「**提交事实已确立**」与「**完整初始化成功**」。
   *
   * 提交事实已确立（可绑定、可保留）：
   *   绑定精确匹配 + 无组合矛盾 + 两层 outcome 均为 initialized +
   *   两层 granted/initialized 均为 true。
   *   此时**即使观察未确认**（回读失败/过期），已发生的提交事实**保留**，
   *   不得抹为零写（Codex §2 表格 initialized 行明确要求）。
   *
   * 完整初始化成功（可保存 COMPLETED）：在上述基础上，
   *   **还必须**观察完整 —— present + 两条存在性 + active。
   *
   * 其余分支（alreadyPresent / auditAlreadyPresent / UNKNOWN / 缺失 / 矛盾）
   * 既不确立提交事实也不构成完整成功：后续观察到有效记录只是**观察结论**，
   * 不能把 P4 的「零写停止」或「冲突停止」提升为「本轮初始化已完成」。
   */
  const commitFactEstablished = Boolean(
    bindingMatched &&
    contradictions.length === 0 &&
    out.outcome === 'initialized' &&
    out.initialized === true && out.granted === true &&
    bs !== null && bs.outcome === 'initialized' &&
    bs.initialized === true && bs.granted === true
  );
  out.commitFactEstablished = commitFactEstablished;
  out.fullInitializationSuccess = Boolean(
    commitFactEstablished && out.observationConfirmed === true
  );

  if (!commitFactEstablished) {
    // 未经绑定与组合校验的回执**不构成**已确立事实：撤销肯定事实，
    // 但保留 raw* 字段如实记录「回执曾自报过」。
    out.ok = false;
    out.initialized = false;
    out.granted = false;
    out.observationConfirmed = false;
  } else if (!out.fullInitializationSuccess) {
    // 提交事实成立但观察未完成：**不报成功**，但**保留** initialized/granted。
    out.ok = false;
    out.observationConfirmed = false;
  }
  // 结果未知必须有固定错误码（此前此分支可能仍是 WORKER_FAILED）
  if (out.resultUnknown === true && out.errorCode !== ERR.RESULT_UNKNOWN &&
    (out.bindingMismatch === true ||
      (Array.isArray(out.stateContradictions) && out.stateContradictions.length > 0))) {
    out.errorCode = ERR.RESULT_UNKNOWN;
  }
  return out;
}

/**
 * S3-1：默认的**固定两条只读核对**接线。
 *
 * Codex 2026-10-10 指出：核对此前只是可选注入回调，超时样本同批凭据仍有效
 * 却记 `NO_RECONCILE_CAPABILITY`、实际两读为 0 —— 核对路径事实上没接通。
 *
 * 现在默认实现复用 **P4 `observePrimary` 的真实契约**（同一身份核验、
 * 同一计划/批准、两条固定读取），不新增云路由、不建通用恢复系统。
 * `inject` 仅供离线合成测试覆盖；生产路径不传。
 *
 * @returns {Promise<object|null>} P4 观察结论的原始对象，或 null（无法核对）
 */
async function runReadOnlyReconcile(options) {
  const o = options || {};
  const clock = typeof o.now === 'function' ? o.now : () => Date.now();
  const snapshot = o.snapshot || {};
  /**
   * N1：核对期间的**同批凭据**时效。
   *
   * worker 的期限守卫已关闭，但父层这条新增路径此前**没有**等效保护：
   * 只在核对前检查一次凭据，自建 adapter 时也没传 deadlineCheck，
   * 且核对完成后不复查 —— 实测在第一条 primary 读取事件推进时钟越过期限后，
   * 仍读第二条并 `reconcileConfirmed=true`。
   *
   * 现在：在**每次读前 / 读后 / 收尾**三个边界复核同批凭据；
   * 越界即停止后续读取、不确认。保留 worker 进程事实、既有提交事实与
   * 未知终态，不重新取凭据、不重新初始化。
   *
   * 不重做已关闭的 worker 守卫、P4 与 SDK 适配器。
   */
  const credentialDeadlineMs = snapshot.expiresAtMs;
  let expiredStage = null;
  const checkDeadline = (stage) => {
    if (expiredStage !== null) return false;
    if (Number.isFinite(credentialDeadlineMs) && credentialDeadlineMs <= clock()) {
      expiredStage = stage;
      return false;
    }
    return true;
  };
  /** 收尾复核：最后一读完成到父层判定之间过期也不确认。 */
  const finalizeDeadline = () => {
    if (expiredStage === null &&
      Number.isFinite(credentialDeadlineMs) && credentialDeadlineMs <= clock()) {
      expiredStage = 'AFTER_RECONCILE';
    }
    return expiredStage;
  };

  if (typeof o.inject === 'function') {
    // 合成注入点：返回**未净化**的原始对象，由调用方 projectReconcile 净化。
    // 注入路径同样受时效约束（否则注入可用过期凭据伪造核对结论）。
    if (!checkDeadline('BEFORE_INJECTED_RECONCILE')) {
      return { raw: null, expiredAtStage: finalizeDeadline() };
    }
    let injected = null;
    try {
      /**
       * N1（Codex 2026-10-10 §2）：异步注入回调**必须 await**。
       *
       * 原实现 `injected = o.inject(...)` 没有 await，函数随即执行
       * AFTER_INJECTED_RECONCILE 与 finalizeDeadline 并返回 —— async 函数
       * **不会**自动等待返回对象内部的 Promise。后果有两项：
       *  - 正常异步结果**丢失**（raw 仍是 Promise，净化后成 unconfirmed）；
       *  - 后置时效检查发生在回调结束**之前**，越界无法被捕获。
       * 此外同一 try/catch 也捕获不到异步 rejection。
       *
       * 现在：等待回调真正完成；成功与异步拒绝都纳入既有异常处理，
       * 随后再做后置时效检查。不扩大注入权限、不新增生产调用入口。
       */
      injected = await o.inject({
        snapshot,
        plan: o.plan,
        approval: o.approval,
        isolationDir: o.isolationDir,
        auditId: o.auditId,
        targetUserId: o.plan && o.plan.targetUserId
      });
    } catch (_) {
      // 同步抛出与异步 rejection 走同一处理：不确认任何结论
      injected = null;
    }
    /**
     * 后置时效检查必须在回调**完成之后**。若回调内部推进了时钟越过凭据期限，
     * 此处即停止后续确认（返回 raw:null + expiredAtStage）。
     */
    if (!checkDeadline('AFTER_INJECTED_RECONCILE')) {
      return { raw: null, expiredAtStage: finalizeDeadline() };
    }
    // 防御：await 之后不应再有 Promise 流入净化层
    if (injected !== null && typeof injected.then === 'function') {
      return { raw: null, expiredAtStage: finalizeDeadline() };
    }
    return { raw: injected, expiredAtStage: finalizeDeadline() };
  }

  // 默认路径：同一批凭据 + 同一 SDK 适配层做只读核对
  let adapter;
  try {
    const built = executionWorker.buildAdapter({
      credential: snapshot,
      targetUserId: o.plan && o.plan.targetUserId,
      auditId: o.auditId,
      // 仅离线合成测试注入；生产路径由适配层自建
      db: (o.deps && o.deps.db) || null,
      // N1：把同批凭据时效接到适配层边界守卫（每次 readOnlyGet 前后）
      deadlineCheck: (stage, forObservation) => {
        if (stage === 'BEFORE_READ_ONLY' || stage === 'AFTER_READ_ONLY') {
          return !checkDeadline(stage);
        }
        // 写入类边界在只读核对中不应触发；仍按凭据时效保守处理
        return !checkDeadline(String(stage || 'RECONCILE_BOUNDARY'));
      }
    });
    // 当次主体核验已在executeOnce 前完成且与批准绑定值精确一致
    built.setCaller(true);
    adapter = built.adapter;
  } catch (_) {
    return { raw: null, expiredAtStage: finalizeDeadline() };
  }
  if (!checkDeadline('BEFORE_RECONCILE')) {
    return { raw: null, expiredAtStage: finalizeDeadline() };
  }
  let observed = null;
  try {
    observed = await p4.observePrimary({
      adapter,
      plan: o.plan,
      approval: o.approval,
      nowMs: clock()
    });
  } catch (_) {
    observed = null;
  }
  if (!checkDeadline('AFTER_RECONCILE')) {
    // 过期：保留「读到过什么」由净化层归一为未确认，不确认任何结论
    return { raw: null, expiredAtStage: finalizeDeadline() };
  }
  return { raw: observed, expiredAtStage: finalizeDeadline() };
}

/**
 * S3-3：核对结果**逐字段 + 逐值**净化。
 *
 * 此前 `report.reconcile = rec` 原样透传：合成回调返回
 * `{ok:true,state:'present',extra:'SYNTH_PRIVATE_MARKER'}` 时标记原样进入报告，
 * 并得到 `reconcileConfirmed=true`。普通返回对象不得替代核对事实。
 *
 * N2（Codex 2026-10-10 §3.3）：**遵守真实 P4 `observePrimary` 返回契约**。
 * 实测核心返回 `{state, reason, primaryPresent, primaryUserId, primaryStatus,
 * auditId, auditPresent, writeAuthorized, note}` —— **不返回 inputDigest**
 * （摘要在核心内部校验审计记录后体现为 state）。
 * 因此：
 *  - `inputDigest` 不是必填，缺失**不**导致正常结果被拒；
 *  - `source` 记录结论来源（`P4_OBSERVE` / `INJECTED`），用于区分
 *    「实际两读形成的结论」与「注入对象」——这是聚合判断的依据之一；
 *  - **自洽校验**：`state='present'` 必须在存在性上自洽
 *    （primaryPresent 与 auditPresent 都为 true、primaryStatus 为 active）。
 *    字段各自合法但组合矛盾（如 state=present 却 primaryPresent=false）
 *    一律降级为 `inconsistent`，不得据以确认。
 */
function projectReconcile(rec, expected, meta) {
  const m = meta || {};
  const out = {
    state: 'unconfirmed',
    primaryPresent: null,
    primaryStatus: null,
    auditPresent: null,
    auditId: null,
    inputDigest: null,
    errorCode: null,
    source: m.source === 'INJECTED' ? 'INJECTED' : 'P4_OBSERVE',
    selfConsistent: false,
    contradiction: null
  };
  if (!isPlainObject(rec)) return out;
  if (typeof rec.state === 'string' && PARENT_OBSERVED_STATES.indexOf(rec.state) !== -1) {
    out.state = rec.state;
  }
  if (typeof rec.primaryPresent === 'boolean') out.primaryPresent = rec.primaryPresent;
  if (typeof rec.auditPresent === 'boolean') out.auditPresent = rec.auditPresent;
  if (typeof rec.primaryStatus === 'string' &&
    PARENT_PRIMARY_STATUS.indexOf(rec.primaryStatus) !== -1) {
    out.primaryStatus = rec.primaryStatus;
  }
  // 审计键：格式合法**且**与本计划精确一致才保留
  if (expected && typeof expected.auditId === 'string' && rec.auditId === expected.auditId) {
    out.auditId = expected.auditId;
  }
  // 摘要：**可选**。真实 P4 不返回它；仅当提供了且合法且与本计划一致时保留。
  // 不把它当必填 —— 否则真实正向路径会被误拒。
  if (expected && typeof expected.inputDigest === 'string' &&
    typeof rec.inputDigest === 'string' && DIGEST_HEX_32.test(rec.inputDigest)) {
    out.inputDigest = rec.inputDigest === expected.inputDigest ? expected.inputDigest : null;
    if (out.inputDigest === null) out.contradiction = 'INPUT_DIGEST_MISMATCH';
  }
  if (typeof rec.errorCode === 'string' && executionWorker.CORE_ERROR_CODES.has(rec.errorCode)) {
    out.errorCode = rec.errorCode;
  }

  /**
   * 自洽校验：字段各自合法不等于组合结论成立（N2 §3.3）。
   * 只在「已实际执行两读」的路径上要求存在性自洽；注入路径同样要求，
   * 否则受控注入可凭组合矛盾的对象骗取确认。
   */
  if (out.state === 'present') {
    if (out.primaryPresent !== true || out.auditPresent !== true) {
      out.contradiction = out.contradiction || 'PRESENCE_CONTRADICTS_PRESENT';
    } else if (out.primaryStatus !== 'active') {
      out.contradiction = out.contradiction || 'STATUS_NOT_ACTIVE';
    }
  }
  out.selfConsistent = out.contradiction === null;
  // 矛盾时状态降级为 inconsistent —— 不让 `state=present` 单独放行
  if (!out.selfConsistent && out.state === 'present') {
    out.state = 'inconsistent';
  }
  return out;
}

/**
 * bootstrap 字段白名单投影（固定形状 + **值也限定**）。
 *
 * S4（Codex 2026-10-10 更正）：不匹配**不能只丢值后仍采信成功布尔**。
 * 此前错误审计键/摘要被置 null 后，`ok/observationConfirmed` 保持不变，
 * 于是「属于另一计划」的结果照样 `initialized=true/resultPersisted=true`。
 * 现在不匹配时把该记录标记为 `bindingMatched=false`，
 * 由 `projectWorkerOutput` 据此**降低**成功状态（见该函数）。
 *
 * S4：此前 `outcome`/`errorCode`/`inputDigest`/`requestIds`/`existingPrimary.status`
 * 只做了 `typeof === 'string'` 检查 —— 任意文本都能原样进入报告。
 * 现在：枚举走有限集合、摘要须 32 位十六进制、请求 ID 须 UUID v4、
 * 错误码走核心白名单；非法值一律归固定未知值。
 * `expected` 存在时，auditId/inputDigest 还须与**本计划**逐项精确一致。
 */
function projectBootstrap(b, expected) {
  const out = {
    ok: b.ok === true,
    outcome: typeof b.outcome === 'string' && PARENT_OUTCOMES.indexOf(b.outcome) !== -1
      ? b.outcome : 'UNKNOWN',
    granted: b.granted === true,
    initialized: b.initialized === true,
    auditId: null,
    inputDigest: null,
    existingPrimary: isPlainObject(b.existingPrimary) ? {
      status: typeof b.existingPrimary.status === 'string' &&
        PARENT_PRIMARY_STATUS.indexOf(b.existingPrimary.status) !== -1
        ? b.existingPrimary.status : 'unknown',
      sameAsTarget: typeof b.existingPrimary.sameAsTarget === 'boolean'
        ? b.existingPrimary.sameAsTarget : null
    } : null,
    errorCode: typeof b.errorCode === 'string' && executionWorker.CORE_ERROR_CODES.has(b.errorCode)
      ? b.errorCode : null,
    requestIds: Array.isArray(b.requestIds)
      ? b.requestIds.filter(v => typeof v === 'string' && REQUEST_ID_UUID_V4.test(v)).slice(0, 8)
      : [],
    // S4：关键键/摘要是否与本计划**精确**匹配。缺期望值时为 false
    // （不据worker 自述采信成功），由上层降低成功状态。
    bindingMatched: false
  };
  // 摘要：格式合法，且（若有期望值）须与本计划一致
  if (typeof b.inputDigest === 'string' && DIGEST_HEX_32.test(b.inputDigest)) {
    out.inputDigest = (expected && typeof expected.inputDigest === 'string' &&
      b.inputDigest !== expected.inputDigest) ? null : b.inputDigest;
  }
  // 审计键：精确匹配本计划（缺期望值则丢弃，不据 worker 自述采信）
  if (expected && typeof expected.auditId === 'string' && b.auditId === expected.auditId) {
    out.auditId = expected.auditId;
  }
  // S4：成功路径要求**两者都提供且精确匹配**；否则不算绑定成功
  out.bindingMatched = Boolean(
    expected && typeof expected.auditId === 'string' && typeof expected.inputDigest === 'string' &&
    out.auditId === expected.auditId && out.inputDigest === expected.inputDigest
  );
  return out;
}

/** observed 字段白名单投影（值同样走枚举/白名单）。 */
function projectObserved(o2) {
  return {
    state: typeof o2.state === 'string' && PARENT_OBSERVED_STATES.indexOf(o2.state) !== -1
      ? o2.state : 'unconfirmed',
    primaryPresent: typeof o2.primaryPresent === 'boolean' ? o2.primaryPresent : null,
    primaryStatus: typeof o2.primaryStatus === 'string' &&
      PARENT_PRIMARY_STATUS.indexOf(o2.primaryStatus) !== -1
      ? o2.primaryStatus : null,
    auditPresent: typeof o2.auditPresent === 'boolean' ? o2.auditPresent : null,
    // 只读观察永不成为写授权，父层强制为 false
    writeAuthorized: false,
    errorCode: typeof o2.errorCode === 'string' && executionWorker.CORE_ERROR_CODES.has(o2.errorCode)
      ? o2.errorCode : null
  };
}

module.exports = Object.freeze({
  FIXED, ERR, STATUS, ALLOWED_ARGS, FORBIDDEN_ARG_PREFIXES,
  FINGERPRINT_FILES,
  parseArgs,
  issueControlledApproval,
  computeImplementationFingerprint,
  deepFreeze,
  boundSnapshot,
  fullPlanDigestOf,
  verifyControlledApproval,
  callerTupleDigest,
  verifyCallerSubject,
  localCheck,
  executeOnce,
  runExecutionWorker,
  projectWorkerOutput,
  projectBootstrap,
  projectObserved,
  projectReconcile,
  runReadOnlyReconcile,
  legalOutcomeFor,
  CREDENTIAL_FAILURE_CODES,
  PARENT_OUTCOMES,
  PARENT_OBSERVED_STATES,
  PARENT_PRIMARY_STATUS
});