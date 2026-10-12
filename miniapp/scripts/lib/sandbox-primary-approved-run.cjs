'use strict';
/**
 * 最小单次入口 / 本地准备模块（approved-run）
 * ===========================================
 *
 * 职责（M2）：围绕**已验收**的执行宿主（sandbox-primary-execution-host）
 * 提供「一次运行」的本地准备与证据持久化：
 *   1. 固定目标计划检查（复用 P4 原计划白名单 / inputDigest / auditId，
 *      不传含 deadlineMs 的归一化对象回核心）；
 *   2. 受控批准交界（只接受宿主 `issueControlledApproval` 签发、经
 *      `verifyControlledApproval` 核验的句柄；普通 JSON / 环境变量 /
 *      命令行开关不能构成批准）；
 *   3. 排他 started（独占新建，`await` 成功后才启动写 worker；
 *      同轮次再次运行不覆盖、不再写）与不可覆盖终态保存
 *      （COMPLETED / FAILED / RESULT_UNKNOWN 分别新建，不覆盖历史）。
 *
 * **不是**通用管理 CLI：不提供 --execute / --approve 公众开关，
 * 不建批准数据库、签名服务或管理后台。真实写入仍须未来受审本机管理进程
 * 在核对人类具体写确认后调用宿主签发函数；本模块信任边界与宿主一致，
 * 代码无法独立证明聊天授权。
 *
 * 硬边界：
 *  - 默认零写、零网络、零子进程；`executeOnce` 的注入点由调用方显式提供，
 *    仅限离线测试夹具（合成 spawn / 持久化回调）。
 *  - `approvalSource` 只能是宿主签发的不可序列化句柄；本模块**不复制**其内容，
 *    也不提供从 JSON 重建句柄的途径。
 *  - `entryFingerprint`：本模块文件自身的 SHA-256 必须纳入运行证据，
 *    不得把新入口遗漏于最终执行包指纹。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const host = require('./sandbox-primary-execution-host.cjs');
const p4 = require('./sandbox-primary-bootstrap.cjs');

const ERR = Object.freeze({
  RUN_ID_INVALID: 'APR_RUN_ID_INVALID',
  RUN_DIR_INVALID: 'APR_RUN_DIR_INVALID',
  PLAN_REQUIRED: 'APR_PLAN_REQUIRED',
  APPROVAL_REQUIRED: 'APR_APPROVAL_REQUIRED',
  STARTED_EXISTS: 'APR_STARTED_EXISTS',
  STARTED_CREATE_FAILED: 'APR_STARTED_CREATE_FAILED',
  TERMINAL_EXISTS: 'APR_TERMINAL_EXISTS',
  TERMINAL_SAVE_FAILED: 'APR_TERMINAL_SAVE_FAILED',
  STATUS_INVALID: 'APR_STATUS_INVALID'
});

const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'RESULT_UNKNOWN']);

function sha256Of(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 本入口文件自身的指纹（纳入运行证据，不遗漏于最终执行包指纹）。 */
function entryFingerprint() {
  const bytes = fs.readFileSync(__filename);
  return { file: path.basename(__filename), bytes: bytes.length, sha256: sha256Of(bytes) };
}

/** 实现指纹（宿主 4 文件）+ 本入口文件指纹的合并快照。 */
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
    fingerprint: fullFingerprint()
  }, null, 2) + '\n';
  try {
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    const e = new Error('started 记录创建失败：' + String(error && error.message || error));
    e.code = ERR.STARTED_CREATE_FAILED;
    throw e;
  }
}

/**
 * 终态新建保存：COMPLETED / FAILED / RESULT_UNKNOWN 各自独立文件名，
 * 文件已存在即失败（不覆盖历史、不清理后重跑）。
 * 进程结果未知时**不得猜测**：调用方必须如实传 RESULT_UNKNOWN。
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
  const body = JSON.stringify({
    recordType: status,
    runId,
    savedAt: new Date().toISOString(),
    status,
    auditId: payload.auditId,
    planDigest: payload.planDigest,
    outcome: payload.outcome || null,
    stoppedAt: payload.stoppedAt || null,
    errorCode: payload.errorCode || null,
    stages: Array.isArray(payload.stages) ? payload.stages.slice() : [],
    incomplete: Array.isArray(payload.incomplete) ? payload.incomplete.slice() : [],
    networkAttempts: payload.networkAttempts === undefined ? null : payload.networkAttempts,
    fingerprint: fullFingerprint()
  }, null, 2) + '\n';
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
    return { saved: true, file };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const e = new Error('终态记录已存在；不覆盖历史。');
      e.code = ERR.TERMINAL_EXISTS;
      throw e;
    }
    const e = new Error('终态保存失败：' + String(error && error.message || error));
    e.code = ERR.TERMINAL_SAVE_FAILED;
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
 * 一次运行的完整编排（离线验证入口）。
 *
 * 流程：本地检查 → 排他 started → executeOnce（宿主全链） → 终态新建保存。
 * `persistRoundStarted` / `persistTerminal` 之类的宿主持久化回调由调用方
 * 以**注入**方式提供（离线夹具），本模块自身不实现云写入。
 *
 * 关键顺序：started 必须独占新建成功**之后**才调用 executeOnce；
 * executeOnce 返回未知/失败也必须保存真实终态，不清理重跑。
 */
async function runOnce(options) {
  const o = options || {};
  const runId = normalizeRunId(o.runId);
  assertFreshOutDir(o.outDir);

  // 0) 凭据来源模式：在任何写入（含 started）之前校验 —— 未知模式零写
  host.normalizeCredentialSourceMode(o.credentialSourceMode);

  // 1) 计划与批准交界（零写）
  const checked = checkPlanAndApproval({
    plan: o.plan, approvalSource: o.approvalSource,
    now: typeof o.now === 'function' ? o.now : undefined
  });
  const boundPlan = checked.boundPlan;

  // 2) 排他 started（await 成功后才允许启动写 worker）
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
    expectedSubjectDigest: checked.expectedSubjectDigest
  });
  if (!created) {
    const e = new Error('同轮次 started 已存在；不覆盖、不再写。');
    e.code = ERR.STARTED_EXISTS;
    throw e;
  }

  // 3) 执行宿主全链（离线注入由调用方提供）
  const result = await host.executeOnce({
    plan: o.plan,
    approvalSource: o.approvalSource,
    roundId: runId,
    now: typeof o.now === 'function' ? o.now : undefined,
    fixedNowMs: o.fixedNowMs,
    credentialSourceMode: o.credentialSourceMode,
    profileDir: o.profileDir,
    spawn: o.spawn,
    spawnWorker: o.spawnWorker,
    credentialDeps: o.credentialDeps,
    persistRoundStarted: o.persistRoundStarted,
    persistResult: o.persistResult,
    readOnlyDeps: o.readOnlyDeps,
    reconcileDeps: o.reconcileDeps,
    isolationFixed: o.isolationFixed,
    baseEnv: o.baseEnv,
    workerLimits: o.workerLimits
  });

  // 4) 终态新建保存（按宿主报告如实分类，不猜测）
  //    宿主成功口径是 `status === PLAN_READY`（报告无 ok 字段）；
  //    结果未知（resultUnknown / RESULT_UNKNOWN）不得猜测为成功或失败。
  const status = result.status === host.STATUS.PLAN_READY ? 'COMPLETED'
    : (result.resultUnknown === true || result.errorCode === host.ERR.RESULT_UNKNOWN)
      ? 'RESULT_UNKNOWN' : 'FAILED';
  const saved = await saveTerminalExclusive(o.outDir, runId, status, {
    auditId: result.auditId || checked.auditId,
    planDigest: result.planDigest || checked.planDigest,
    outcome: result.outcome || null,
    stoppedAt: result.stoppedAt,
    errorCode: result.errorCode,
    stages: result.stages,
    incomplete: result.incomplete,
    networkAttempts: result.networkAttempts
  });

  return { runId, status, result, saved };
}

module.exports = Object.freeze({
  ERR,
  TERMINAL_STATUSES,
  entryFingerprint,
  fullFingerprint,
  normalizeRunId,
  assertFreshOutDir,
  createStartedExclusive,
  saveTerminalExclusive,
  checkPlanAndApproval,
  runOnce
});
