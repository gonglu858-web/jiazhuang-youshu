'use strict';
/**
 * 最小单次入口 / 本地准备模块（approved-run）
 * ===========================================
 *
 * 职责（M2 + 2026-10-12 复核 R2/R4 定点返修）：围绕**已验收**的执行宿主
 * （sandbox-primary-execution-host）提供「一次运行」的本地准备与证据持久化：
 *   1. 固定目标计划检查（复用 P4 原计划白名单 / inputDigest / auditId，
 *      不传含 deadlineMs 的归一化对象回核心）；
 *   2. 受控批准交界（只接受宿主 `issueControlledApproval` 签发、经
 *      `verifyControlledApproval` 核验的句柄；普通 JSON / 环境变量 /
 *      命令行开关不能构成批准）；
 *   3. 排他 started（独占新建，`await` 成功后才启动写 worker；
 *      同轮次再次运行不覆盖、不再写）与不可覆盖终态保存
 *      （COMPLETED / FAILED / RESULT_UNKNOWN 分别新建，不覆盖历史）；
 *   4. **默认执行/持久化接线由本入口自己完成**（R2）：宿主的
 *      `persistRoundStarted` 回调由本入口核对本轮已独占创建的 started
 *      记录（避免双重创建），`persistResult` 回调由本入口直接执行
 *      终态落盘 —— 不依赖调用方返回 true 冒充持久化，也不用无条件
 *      true 代替保存。调用方不再提供持久化回调。
 *   5. **可本地判定的错误在创建 started 之前拒绝**（2026-10-12 §7）：
 *      来源模式不合法/与批准绑定不一致、离线模式缺合成 profile 或指向
 *      真实登录目录、真实模式执行依赖覆盖、轮次与绑定计划不一致。
 *   6. **S2 收尾（2026-10-12 复核 §4）**：同轮已有任一种终态在创建
 *      started、取凭据之前拒绝；「已尝试保存但失败」与「尚未保存」严格
 *      区分 —— 首次保存失败（EEXIST/部分落盘/目录创建失败/EIO）后不自动
 *      再次保存，抛固定错误码 + causeCode + 净化 e.execution，保留已提交
 *      事实；既有/半截文件不覆盖、不清理。
 *   7. **T1/T2 收尾（2026-10-12 复核 S1–S4 §3/§4）**：终态目录列举失败
 *      （EACCES/EIO 等）不当作「无记录」放行 —— 仅 ENOENT 按无目录处理，
 *      其余在 started/凭据/worker 之前以固定净化错误
 *      （APR_TERMINAL_DIR_CHECK_FAILED + causeCode）停止；成功保存后返回
 *      报告的 resultPersisted/unknownPersisted 按实际保存结果与终态类型
 *      同步（复制报告补齐，不改宿主聚合）。
 *
 * 终态记录（R4）按字段白名单投影宿主已净化报告：保留提交事实
 * （commitFactEstablished）、完整成功资格（fullInitializationSuccess）、
 * initialized/granted、观察确认、worker 进程事实、只读核对结论、
 * 未知标记等；不透传原始异常或凭据。终态落盘失败时抛出带固定错误码
 * （APR_TERMINAL_SAVE_FAILED）与净化执行事实（`e.execution`）的结构化
 * 错误 —— 不伪造保存成功、不重试初始化，使受审调用者能保留未知或已
 * 提交事实。
 *
 * **不是**通用管理 CLI：不提供 --execute / --approve 公众开关，
 * 不建批准数据库、签名服务或管理后台。真实写入仍须未来受审本机管理进程
 * 在核对人类具体写确认后调用宿主签发函数；本模块信任边界与宿主一致，
 * 代码无法独立证明聊天授权。
 *
 * 硬边界：
 *  - 默认零写、零网络、零子进程；离线夹具的注入点（合成 spawn 等）仅
 *    `offline-fixture` 模式可用；真实模式（fixed-real-source）拒绝任何
 *    执行依赖覆盖，其离线验证走宿主的模块级装配
 *    `installRealModeOfflineHarness`（明确隔离，报告如实标记）。
 *  - `approvalSource` 只能是宿主签发的不可序列化句柄；本模块**不复制**其内容，
 *    也不提供从 JSON 重建句柄的途径。
 *  - 入口自身文件哈希由宿主在批准签发时绑定（ENTRY_FILE），并在取凭据前与
 *    启动 worker 前各比较一次（R3）；本模块不另行生成或替换批准指纹。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const host = require('./sandbox-primary-execution-host.cjs');
const p4 = require('./sandbox-primary-bootstrap.cjs');
const cliObserver = require('./cloudbase-readonly-observer.cjs');

const REAL_AUTH_DIR = cliObserver.FIXED.authSessionDir;

const ERR = Object.freeze({
  RUN_ID_INVALID: 'APR_RUN_ID_INVALID',
  RUN_DIR_INVALID: 'APR_RUN_DIR_INVALID',
  PLAN_REQUIRED: 'APR_PLAN_REQUIRED',
  APPROVAL_REQUIRED: 'APR_APPROVAL_REQUIRED',
  ROUND_MISMATCH: 'APR_ROUND_MISMATCH',
  STARTED_EXISTS: 'APR_STARTED_EXISTS',
  STARTED_CREATE_FAILED: 'APR_STARTED_CREATE_FAILED',
  TERMINAL_EXISTS: 'APR_TERMINAL_EXISTS',
  TERMINAL_SAVE_FAILED: 'APR_TERMINAL_SAVE_FAILED',
  STATUS_INVALID: 'APR_STATUS_INVALID',
  TERMINAL_DIR_CHECK_FAILED: 'APR_TERMINAL_DIR_CHECK_FAILED'
});

const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'RESULT_UNKNOWN']);

function sha256Of(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 本入口文件自身的指纹（纳入运行证据；批准绑定与比对由宿主完成）。 */
function entryFingerprint() {
  const bytes = fs.readFileSync(__filename);
  return { file: path.basename(__filename), bytes: bytes.length, sha256: sha256Of(bytes) };
}

/** 实现指纹（宿主 4 文件 + 入口文件）的合并快照。 */
function fullFingerprint() {
  return Object.freeze({
    implementation: host.computeImplementationFingerprint(),
    entry: entryFingerprint()
  });
}

/** 规范化轮次标识：仅允许受限字符，防止路径逃逸。 */
function normalizeRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(runId)) {
    const e = new Error('轮次标识不合法（4–64 位字母数字-_，且不以符号开头）。');
    e.code = ERR.RUN_ID_INVALID;
    throw e;
  }
  return runId;
}

/**
 * 检查结果目录是否可安全使用：
 *  - 不存在或为空 → 可用；
 *  - 仅含本模块的 `started` / `terminal` 子目录 → 可重入（排他性由
 *    started 的 `wx` 新建与终态的不可覆盖保证，重复轮次会得到
 *    STARTED_EXISTS / TERMINAL_EXISTS，而不是目录级拒绝）；
 *  - 含任何其它条目 → 拒绝（不覆盖历史证据、不与外来文件混放）。
 */
function assertFreshOutDir(outDir) {
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) {
    const e = new Error('结果目录必须是绝对路径。');
    e.code = ERR.RUN_DIR_INVALID;
    throw e;
  }
  if (fs.existsSync(outDir)) {
    const allowed = new Set(['started', 'terminal']);
    for (const name of fs.readdirSync(outDir)) {
      const abs = path.join(outDir, name);
      if (allowed.has(name) && fs.statSync(abs).isDirectory()) continue;
      const e = new Error('结果目录含非本模块条目；不覆盖历史证据、不与外来文件混放：' + name);
      e.code = ERR.RUN_DIR_INVALID;
      throw e;
    }
  }
}

/**
 * 终态记录的字段白名单（R4）：只允许宿主**已净化**报告中的这些键进入落盘
 * 记录；未列出的键（含任何原始异常、凭据类字段）一律丢弃。
 * 已知键始终出现在记录里（不适用的为 null），便于逐项核对。
 */
const TERMINAL_FIELDS = Object.freeze([
  'auditId', 'planDigest', 'fullPlanDigest', 'roundId',
  'outcome', 'stoppedAt', 'errorCode',
  'stages', 'incomplete', 'networkAttempts',
  'initialized', 'granted',
  'commitFactEstablished', 'fullInitializationSuccess',
  'observationConfirmed', 'resultUnknown',
  'bootstrap', 'observed', 'observeFailed',
  'stateContradictions', 'bindingMismatch',
  'workerProcess',
  'reconcile', 'reconcileAttempted', 'reconcileConfirmed',
  'credentialSourceMode', 'fixedRealSourceUsed', 'realModeOfflineHarness',
  'credentialFailureClass',
  // 2026-10-12 身份绑定方案：固定枚举与核对结论（不含身份原值/会话名）
  'bindingPolicyVersion', 'stableIdentityMatched', 'sessionContinuityConfirmed',
  'resultPersisted', 'unknownPersisted'
]);

/** 按白名单投影宿主报告/持久化载荷（不透传未知字段、不透传异常对象）。 */
function projectTerminalPayload(payload) {
  const out = {};
  for (const key of TERMINAL_FIELDS) {
    const v = payload ? payload[key] : undefined;
    if (v === undefined) { out[key] = null; continue; }
    if (Array.isArray(v)) { out[key] = v.slice(); continue; }
    out[key] = v;
  }
  return out;
}

/**
 * S2（2026-10-12 复核 §4）：查找同轮次已存在的任一种终态记录。
 * 返回文件路径（存在）或 null。用于在创建 started、取凭据**之前**发现
 * 「本轮已有终态」这一可本地判定的冲突，而不是等到写文件碰撞才发现。
 */
function findExistingTerminalRecord(outDir, runId) {
  const dir = path.join(outDir, 'terminal');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // T1（2026-10-12 复核 §3）：仅明确的目录不存在可按「无记录」处理；
    // EACCES/EIO 等只能证明检查未完成，不能当作检查通过放行 —— 在创建
    // started、取凭据及启动 worker 之前以固定净化错误停止（不带原始异常
    // 文本；实际错误类别经 causeCode 保留）。
    if (error && error.code === 'ENOENT') return null;
    const e = new Error('终态目录检查失败；无法确认同轮终态状态，未创建 started、未取凭据、未启动 worker。');
    e.code = ERR.TERMINAL_DIR_CHECK_FAILED;
    e.causeCode = String(error && error.code || 'UNKNOWN');
    throw e;
  }
  const prefix = runId + '.';
  for (const name of names) {
    if (name.startsWith(prefix)) return path.join(dir, name);
  }
  return null;
}

/**
 * 排他新建 started 记录（`wx` flag：文件已存在即失败，绝不覆盖）。
 * 返回 true 表示本进程独占创建成功；false 表示同轮次已存在。
 * 注意：调用方必须 `await` 本函数成功后才允许启动写 worker。
 */
async function createStartedExclusive(outDir, runId, meta) {
  const startedDir = path.join(outDir, 'started');
  fs.mkdirSync(startedDir, { recursive: true });
  const file = path.join(startedDir, runId + '.json');
  const payload = JSON.stringify({
    recordType: 'STARTED',
    runId,
    savedAt: new Date().toISOString(),
    auditId: meta.auditId,
    planDigest: meta.planDigest,
    fullPlanDigest: meta.fullPlanDigest,
    targetUserId: meta.targetUserId,
    evidenceId: meta.evidenceId,
    operatorRef: meta.operatorRef,
    planExpiresAt: meta.planExpiresAt,
    approvalExpiresAtMs: meta.approvalExpiresAtMs,
    approvedBy: meta.approvedBy,
    expectedSubjectDigest: meta.expectedSubjectDigest,
    bindingPolicyVersion: meta.bindingPolicyVersion,
    credentialSourceMode: meta.credentialSourceMode,
    fingerprint: fullFingerprint()
  }, null, 2) + '\n';
  try {
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    const e = new Error('started 记录创建失败：' + String(error && error.code || error));
    e.code = ERR.STARTED_CREATE_FAILED;
    throw e;
  }
}

/**
 * R2：核对**本轮已独占创建**的 started 记录与宿主要求一致。
 * 这是宿主 `persistRoundStarted` 回调的默认实现：不重复创建（入口已在
 * 启动执行前独占新建），只核对既有记录的轮次/审计键/摘要 —— 一致才
 * 返回 true，不一致或读取失败一律 false（不发写请求）。
 */
function verifyStartedRecord(outDir, runId, expected) {
  try {
    const file = path.join(outDir, 'started', runId + '.json');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    return body.recordType === 'STARTED' &&
      body.runId === runId &&
      body.auditId === expected.auditId &&
      body.planDigest === expected.planDigest;
  } catch (_) {
    return false;
  }
}

/**
 * 终态新建保存：COMPLETED / FAILED / RESULT_UNKNOWN 各自独立文件名，
 * 文件已存在即失败（不覆盖历史、不清理后重跑）。
 * 进程结果未知时**不得猜测**：调用方必须如实传 RESULT_UNKNOWN。
 * 载荷经 `projectTerminalPayload` 白名单投影后再落盘。
 */
async function saveTerminalExclusive(outDir, runId, status, payload) {
  if (!TERMINAL_STATUSES.includes(status)) {
    const e = new Error('未知终态：' + String(status));
    e.code = ERR.STATUS_INVALID;
    throw e;
  }
  const terminalDir = path.join(outDir, 'terminal');
  fs.mkdirSync(terminalDir, { recursive: true });
  const file = path.join(terminalDir, runId + '.' + status + '.json');
  const body = JSON.stringify(Object.assign({
    recordType: status,
    runId,
    savedAt: new Date().toISOString(),
    status
  }, projectTerminalPayload(payload), {
    fingerprint: fullFingerprint()
  }), null, 2) + '\n';
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
    return { saved: true, file };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const e = new Error('终态记录已存在；不覆盖历史。');
      e.code = ERR.TERMINAL_EXISTS;
      throw e;
    }
    const e = new Error('终态保存失败：' + String(error && error.code || 'UNKNOWN'));
    e.code = ERR.TERMINAL_SAVE_FAILED;
    // S2：原始固定失败类别随 causeCode 保留（EIO/EACCES/ENOSPC 等），不丢失
    e.causeCode = String(error && error.code || 'UNKNOWN');
    throw e;
  }
}

/**
 * 计划与批准的交界检查（**纯本地，零写零网络**）。
 * 复用 P4 原白名单与宿主核验；不把归一化后的对象回传核心。
 */
function checkPlanAndApproval(options) {
  const o = options || {};
  if (!o.plan) {
    const e = new Error('缺少完整原始计划。');
    e.code = ERR.PLAN_REQUIRED;
    throw e;
  }
  if (!o.approvalSource) {
    const e = new Error('缺少受控批准句柄；普通 JSON / 环境变量 / 命令行开关不构成批准。');
    e.code = ERR.APPROVAL_REQUIRED;
    throw e;
  }
  // 宿主核验：内部先走 P4 validatePlan / validateApprovalContext / assertApprovedTarget
  const checked = host.verifyControlledApproval({
    approvalSource: o.approvalSource, plan: o.plan,
    now: typeof o.now === 'function' ? o.now : undefined
  });
  if (!checked.ok) {
    const e = new Error('批准或计划未通过核验：' + String(checked.reason || checked.errorCode));
    e.code = checked.errorCode || ERR.APPROVAL_REQUIRED;
    e.detail = checked.reason;
    throw e;
  }
  return checked;
}

/**
 * R1：真实模式在创建 started 之前就拒绝调用方执行依赖覆盖。
 * 与宿主 `executeOnce` 的覆盖清单保持一致（提前拒绝，零写零子进程）。
 */
const REAL_MODE_OVERRIDE_KEYS = Object.freeze([
  'spawn', 'spawnWorker', 'baseEnv', 'isolationFixed', 'credentialDeps',
  'profileDir', 'credentialProfileDir', 'credentialCwd', 'limits',
  'workerLimits', 'reconcileReadOnly', 'reconcileDeps', 'readOnlyDeps',
  'now', 'fixedNowMs'
]);

/** 按宿主报告分类终态（宿主成功口径是 status === PLAN_READY）。 */
function classifyStatus(report) {
  return report.status === host.STATUS.PLAN_READY ? 'COMPLETED'
    : (report.resultUnknown === true || report.errorCode === host.ERR.RESULT_UNKNOWN)
      ? 'RESULT_UNKNOWN' : 'FAILED';
}

/**
 * 一次运行的完整编排。
 *
 * 流程：本地检查（模式/来源/轮次 —— 可本地判定的错误在 started 之前拒绝）
 * → 排他 started → executeOnce（宿主全链，持久化由本入口自接）→
 * 终态新建保存（不覆盖、失败抛结构化错误）。
 *
 * R2：调用方**不再提供**持久化回调或 worker 启动器：
 *  - `persistRoundStarted` 由本入口核对已独占创建的 started（避免双重创建）；
 *  - `persistResult` 由本入口直接执行终态落盘；
 *  - 真实模式的 worker 启动器是宿主固定实现（固定 node + 固定 workerPath +
 *    原私有 stdin）；离线夹具模式下才允许显式注入合成 spawn。
 */
async function runOnce(options) {
  const o = options || {};
  const runId = normalizeRunId(o.runId);
  assertFreshOutDir(o.outDir);

  // 0) 凭据来源模式：在任何写入（含 started）之前校验 —— 未知模式零写
  const mode = host.normalizeCredentialSourceMode(o.credentialSourceMode);

  // R1：真实模式的执行依赖覆盖在创建 started 之前拒绝（零写）
  if (mode === 'fixed-real-source') {
    for (const key of REAL_MODE_OVERRIDE_KEYS) {
      if (o[key] !== undefined) {
        const e = new Error('真实模式不接受执行依赖覆盖（' + key + '）；使用固定真实来源与固定启动器。');
        e.code = host.ERR.REAL_MODE_OVERRIDE_REJECTED;
        throw e;
      }
    }
  }

  // 1) 计划与批准交界（零写）
  const checked = checkPlanAndApproval({
    plan: o.plan, approvalSource: o.approvalSource,
    now: mode === 'fixed-real-source' ? undefined
      : (typeof o.now === 'function' ? o.now : undefined)
  });
  const boundPlan = checked.boundPlan;

  // R1：批准绑定的来源模式与请求模式必须一致（可本地判定，started 之前拒绝）
  if (checked.credentialSourceMode !== mode) {
    const e = new Error('批准绑定的凭据来源模式与请求模式不一致；未取凭据、未写 started。');
    e.code = host.ERR.REAL_MODE_BINDING_MISMATCH;
    throw e;
  }

  // §7-1：离线模式缺合成 profile 或指向真实登录目录 —— started 之前拒绝
  if (mode === 'offline-fixture') {
    const profile = o.profileDir;
    if (typeof profile !== 'string' || profile.length === 0 || profile === REAL_AUTH_DIR) {
      const e = new Error('离线夹具模式必须提供合成登录 profile，且不得指向真实登录目录；未取凭据、未写 started。');
      e.code = host.ERR.CREDENTIAL_FETCH_FAILED;
      throw e;
    }
  }

  // §7-1：轮次与绑定计划不一致 —— 可本地判定，started 之前拒绝
  if (typeof boundPlan.roundId === 'string' && boundPlan.roundId !== runId) {
    const e = new Error('本轮轮次标识与绑定计划不一致；未取凭据、未写 started。');
    e.code = ERR.ROUND_MISMATCH;
    throw e;
  }

  // 2) S2：同轮已有任一种终态 → 在创建 started、取凭据之前拒绝。
  //    （本轮已不可能再产生新终态；不靠后续写文件碰撞发现，零凭据零写。
  //    started 的既有 STARTED_EXISTS 语义与竞态防护仍由 createStartedExclusive
  //    的 `wx` 独占新建保持 —— 这是第二道防线，不是唯一手段。）
  const existingTerminal = findExistingTerminalRecord(o.outDir, runId);
  if (existingTerminal !== null) {
    const e = new Error('同轮次终态记录已存在；在创建 started、取凭据之前停止：' +
      path.basename(existingTerminal));
    e.code = ERR.TERMINAL_EXISTS;
    throw e;
  }

  // 3) 排他 started（await 成功后才允许启动写 worker）
  const created = await createStartedExclusive(o.outDir, runId, {
    auditId: checked.auditId,
    planDigest: checked.planDigest,
    fullPlanDigest: checked.fullPlanDigest,
    targetUserId: boundPlan.targetUserId,
    evidenceId: boundPlan.evidenceId,
    operatorRef: boundPlan.operatorRef,
    planExpiresAt: boundPlan.expiresAt,
    approvalExpiresAtMs: checked.expiresAtMs,
    approvedBy: o.approvalSource.approvedBy,
    expectedSubjectDigest: checked.expectedSubjectDigest || null,
    // 2026-10-12 身份绑定方案：新版绑定时的策略版本（旧路径为 null）
    bindingPolicyVersion: checked.bindingPolicyVersion || null,
    credentialSourceMode: mode
  });
  if (!created) {
    const e = new Error('同轮次 started 已存在；不覆盖、不再写。');
    e.code = ERR.STARTED_EXISTS;
    throw e;
  }

  // 4) 执行宿主全链（持久化由本入口自接，R2）
  //
  // 离线夹具模式的注入点仅在 offline-fixture 分支转发；真实模式只传
  // 必需字段（执行依赖由宿主固定，任何覆盖已被上面拒绝）。
  const isReal = mode === 'fixed-real-source';
  let hostSavedTerminal = null; // 宿主 persistResult 成功落盘的终态
  /**
   * S2：区分「尚未保存」与「已尝试保存但失败」。
   * 首次终态保存失败时记录固定失败类别与净化执行事实；后续**不得**因
   * 首次失败（含部分落盘）而把同一轮次当作「尚未尝试」再次保存 —— 否则
   * 第二次保存会变成 EEXIST 且丢失首次已提交事实。
   */
  let hostTerminalSaveFailure = null;
  const hostOptions = {
    plan: o.plan,
    approvalSource: o.approvalSource,
    roundId: runId,
    credentialSourceMode: mode,
    // R2：持久化回调由本入口自接 —— 不依赖调用方返回 true 冒充持久化
    persistRoundStarted: (p) => verifyStartedRecord(o.outDir, runId, {
      auditId: checked.auditId, planDigest: checked.planDigest
    }),
    persistResult: (p) => {
      // 宿主持久化载荷 recordType 直接映射终态状态；落盘经白名单投影。
      const status = TERMINAL_STATUSES.includes(p && p.recordType)
        ? p.recordType : classifyStatus(p || {});
      const payload = Object.assign({}, p, {
        fullPlanDigest: checked.fullPlanDigest,
        credentialSourceMode: mode,
        // S3：落盘标记按实际保存类型表达 —— 保存成功即结果已在盘；
        // 「未知结果已保存」只对 RESULT_UNKNOWN 记录成立。
        resultPersisted: true,
        unknownPersisted: status === 'RESULT_UNKNOWN'
      });
      return saveTerminalExclusive(o.outDir, runId, status, payload).then((saved) => {
        hostSavedTerminal = { status, file: saved.file };
        return true;
      }).catch((error) => {
        // S2：已尝试保存但失败 —— 记录首次失败事实，返回 false（宿主如实
        // 标记未持久化）；不在此处重试，也不让外层把本轮当「尚未保存」。
        hostTerminalSaveFailure = Object.freeze({
          status,
          causeCode: String(error && error.causeCode || error && error.code || 'UNKNOWN'),
          execution: Object.freeze(projectTerminalPayload(Object.assign({}, payload, {
            // 实际未落盘：标记如实为 false，不与文件矛盾
            resultPersisted: false,
            unknownPersisted: false
          })))
        });
        return false;
      });
    }
  };
  if (!isReal) {
    hostOptions.now = typeof o.now === 'function' ? o.now : undefined;
    hostOptions.fixedNowMs = o.fixedNowMs;
    hostOptions.profileDir = o.profileDir;
    hostOptions.spawn = o.spawn;
    hostOptions.spawnWorker = o.spawnWorker;
    hostOptions.credentialDeps = o.credentialDeps;
    hostOptions.baseEnv = o.baseEnv;
    hostOptions.isolationFixed = o.isolationFixed;
    hostOptions.limits = o.limits;
    hostOptions.workerLimits = o.workerLimits;
    hostOptions.reconcileReadOnly = o.reconcileReadOnly;
    hostOptions.reconcileDeps = o.reconcileDeps;
    hostOptions.readOnlyDeps = o.readOnlyDeps;
    hostOptions.credentialCwd = o.credentialCwd;
  }
  const result = await host.executeOnce(hostOptions);

  // 5) 终态新建保存（不覆盖、不猜测、不自动重试）
  let status;
  let saved;
  if (hostSavedTerminal !== null) {
    // 宿主 persistResult 已由本入口落盘成功：复核文件在盘即可，不重复保存
    status = hostSavedTerminal.status;
    if (!fs.existsSync(hostSavedTerminal.file)) {
      const e = new Error('终态记录落盘复核失败：文件不在盘。');
      e.code = ERR.TERMINAL_SAVE_FAILED;
      e.execution = Object.freeze(projectTerminalPayload(Object.assign({}, result, {
        roundId: runId, fullPlanDigest: checked.fullPlanDigest,
        credentialSourceMode: mode
      })));
      throw e;
    }
    saved = { saved: true, file: hostSavedTerminal.file };
  } else if (hostTerminalSaveFailure !== null) {
    /**
     * S2：首次终态保存**已尝试但失败**（EEXIST/部分落盘/目录创建失败/EIO
     * 等）—— 不把本轮当「尚未保存」再次保存（避免二次碰撞 EEXIST 且丢失
     * 首次已提交事实）；抛出固定错误码 + 原始固定失败类别（causeCode）+
     * 首次保存时捕获的净化执行事实。半截/既有文件保留，不清理、不覆盖、
     * 不重试初始化。
     */
    const f = hostTerminalSaveFailure;
    const e = new Error('终态保存已尝试但失败；保留 started 与首次保存的净化执行事实，不重复保存、不重试初始化。');
    e.code = ERR.TERMINAL_SAVE_FAILED;
    e.causeCode = f.causeCode;
    e.execution = f.execution;
    throw e;
  } else {
    // 宿主未请求落盘（执行在 started 后提前停止等）：本入口直接保存一次。
    status = classifyStatus(result);
    const payload = Object.assign({}, result, {
      roundId: runId,
      fullPlanDigest: checked.fullPlanDigest,
      credentialSourceMode: mode,
      fixedRealSourceUsed: result.fixedRealSourceUsed === true,
      // S3：保存成功前的标记按将要写入的实际类型表达
      resultPersisted: true,
      unknownPersisted: status === 'RESULT_UNKNOWN'
    });
    try {
      saved = await saveTerminalExclusive(o.outDir, runId, status, payload);
    } catch (error) {
      /**
       * R4/S2：终态落盘失败（含 EEXIST）—— 不伪造保存成功、不重试初始化，
       * 统一抛出带固定错误码、原始固定失败类别（causeCode）与**净化执行
       * 事实**（e.execution）的结构化错误；不透传原始异常对象或其文本。
       */
      const e = new Error('终态保存失败；保留 started 与净化执行事实，不伪造保存成功、不重试初始化。');
      e.code = ERR.TERMINAL_SAVE_FAILED;
      e.causeCode = String(error && error.causeCode || error && error.code || 'UNKNOWN');
      e.execution = Object.freeze(projectTerminalPayload(Object.assign({}, payload, {
        resultPersisted: false,
        unknownPersisted: false
      })));
      throw e;
    }
  }

  // T2（2026-10-12 复核 §4）：入口已完成终态保存 —— 返回报告的持久化标记
  // 按**实际保存结果与终态类型**同步（COMPLETED/FAILED → true/false；
  // RESULT_UNKNOWN → true/true）。复制宿主报告后补齐两个字段，不改宿主
  // 既有聚合；业务 status/errorCode/提交事实/未知结果语义不变。
  // 保存失败路径不经过这里：异常保持 e.execution 内两个标记为 false。
  const finalResult = Object.assign({}, result, {
    resultPersisted: true,
    unknownPersisted: status === 'RESULT_UNKNOWN'
  });
  return { runId, status, result: finalResult, saved };
}

module.exports = Object.freeze({
  ERR,
  TERMINAL_STATUSES,
  TERMINAL_FIELDS,
  projectTerminalPayload,
  entryFingerprint,
  fullFingerprint,
  normalizeRunId,
  assertFreshOutDir,
  createStartedExclusive,
  verifyStartedRecord,
  findExistingTerminalRecord,
  saveTerminalExclusive,
  checkPlanAndApproval,
  classifyStatus,
  runOnce
});
