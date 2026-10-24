'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// 本包专用固定用途进程/管道能力层（B1，Codex 复查接续 f211469 §2）。
// 原始 child_process/net 引用只存于本模块闭包（IIFE 内捕获，装载序列最先执行）；
// 导出仅固定用途能力——程序、参数、cwd、shell/stdio/env、超时/输出限额与命名管道
// 目标一律在能力边界内验证/构造，调用者不能传任意 exe/options，也不能经 getter/
// 工厂取得原始引用。
// 附带实际调用记录（attempts）：区分「尝试 attempted / 完成 completed / spawn 级
// 失败」；命令状态码语义（如 git check-ignore 的 status 1 = 未忽略，合法）由调用方
// 判定，本层只记录 spawn 失败（error/signal），供证据从实际记录汇总进程次数。
// 记录为净化字段：能力名、程序基名、状态、完成/失败布尔；不含参数内容与输出。
// ═══════════════════════════════════════════════════════════════════════════════
const cp = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../..');
// 能力边界内固定程序白名单（绝对路径常量；按值校验，不解析 PATH）
const PROGRAMS = Object.freeze({
  git: 'C:\\Program Files\\Git\\cmd\\git.exe',
  whoami: 'C:\\Windows\\System32\\whoami.exe',
  icacls: 'C:\\Windows\\System32\\icacls.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
});
// Git 只读固定用途：操作 → 固定参数前缀（尾部 pathspec 由能力校验后追加）
const GIT_READONLY_PREFIX = Object.freeze({
  'check-ignore': Object.freeze(['check-ignore', '--']),
  'ls-files': Object.freeze(['ls-files', '--']),
  'diff': Object.freeze(['diff', '--name-only']),
  'status': Object.freeze(['status', '--porcelain'])
});
const GIT_COMMITISH_RE = /^(?:HEAD|[0-9a-f]{7,40})(?:\.\.HEAD)?$/; // 固定形状：commit 或 <commit>..HEAD
const LIMIT = 128 * 1024, TIMEOUT = 10000;
const BOUNDARY_CODE = 'PSR_NATIVE_EXEC_BOUNDARY';

// ── 闭包：原始引用只存于此；外部不可达 ──
const rawRefs = (() => ({
  spawnSync: cp.spawnSync, spawn: cp.spawn, connect: net.connect, execFileSync: cp.execFileSync
}))();

const attempts = [];
let seq = 0;
const baseName = exe => String(exe).split('\\').pop();
function boundary(reason) {
  const e = new Error('本地能力边界拒绝（固定原因）：' + reason);
  e.code = BOUNDARY_CODE;
  throw e;
}
function recordAttempt(entry) {
  attempts.push(Object.assign({ id: ++seq }, entry));
  return seq;
}
function isCleanStringArray(v, { min = 0 } = {}) {
  return Array.isArray(v) && v.length >= min && v.every(x => typeof x === 'string' && x.length > 0 && !x.includes('\0'));
}
function sanitizedEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return env;
}
function checkCwd(cwd) {
  if (cwd === undefined) return REPO;
  if (typeof cwd !== 'string' || path.resolve(cwd) !== REPO) boundary('cwd 不在固定仓库根边界内');
  return REPO;
}
function checkProgram(program) {
  if (typeof program !== 'string') boundary('程序不在固定白名单');
  if (Object.hasOwn(PROGRAMS, program)) return PROGRAMS[program]; // 键名
  const hit = Object.values(PROGRAMS).find(v => v === program); // 等值绝对路径（同一常量）
  if (hit) return hit;
  boundary('程序不在固定白名单');
}
function checkLimits(timeoutMs, maxBuffer) {
  if (timeoutMs === undefined) timeoutMs = TIMEOUT;
  if (maxBuffer === undefined) maxBuffer = LIMIT;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT) boundary('超时超出固定边界');
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0 || maxBuffer > LIMIT) boundary('输出限额超出固定边界');
  return { timeoutMs, maxBuffer };
}
function checkInput(input) {
  if (input === undefined || Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  return boundary('输入类型不在固定边界');
}

module.exports = Object.freeze({
  ERROR_CODE: BOUNDARY_CODE,

  /**
   * 同步固定进程（local-tools 的 sync 唯一出口）。
   * 边界内构造：固定程序白名单、参数干净字符串数组、cwd=仓库根、shell=false、
   * windowsHide=true、默认 stdio、净化 env（删 NODE_OPTIONS）、超时/限额上限。
   */
  runProgram({ program, args, cwd, timeoutMs, maxBuffer, input }) {
    const exe = checkProgram(program);
    if (!isCleanStringArray(args, { min: 1 })) boundary('参数不是干净的字符串数组');
    const limits = checkLimits(timeoutMs, maxBuffer);
    const opts = { cwd: checkCwd(cwd), input: checkInput(input), windowsHide: true,
      shell: false, env: sanitizedEnv(), timeout: limits.timeoutMs, maxBuffer: limits.maxBuffer };
    const id = recordAttempt({ kind: 'runProgram', program: baseName(exe),
      attempted: true, completed: false, spawnFailed: false, status: null });
    let r, err;
    try { r = rawRefs.spawnSync(exe, args, opts); } catch (e) { err = e; }
    const entry = attempts.find(a => a.id === id);
    entry.completed = true;
    entry.spawnFailed = !!(err || !r || r.error || r.signal);
    entry.status = r && r.status !== undefined ? r.status : null;
    if (err) throw err;
    if (!r) boundary('进程未返回结果');
    return r;
  },

  /**
   * 异步固定进程（仅 DPAPI 解密管道命令）。
   * 边界内构造：固定 powershell 白名单、purpose 固定集合、固定 stdio
   * ['pipe','ignore','pipe']、cwd=仓库根、shell=false、windowsHide=true、净化 env。
   * 返回 { child, attemptId }；完成时由调用方以 completeAsync 回填。
   */
  spawnProgram({ purpose, script, cwd }) {
    if (purpose !== 'dpapi-unprotect') boundary('异步进程用途不在固定集合');
    if (typeof script !== 'string' || !script.includes('Import-Module -Name (Join-Path $PSHOME')) {
      boundary('异步脚本未含固定 PSHOME 初始化');
    }
    const exe = PROGRAMS.powershell;
    const opts = { cwd: checkCwd(cwd), windowsHide: true, shell: false,
      env: sanitizedEnv(), stdio: ['pipe', 'ignore', 'pipe'] };
    const id = recordAttempt({ kind: 'spawnProgram', program: baseName(exe),
      attempted: true, completed: false, spawnFailed: false, status: null });
    return { child: rawRefs.spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], opts), attemptId: id };
  },

  /** 命名管道连接（仅 DPAPI 解密管道；目标格式在边界内构造）。 */
  connectNamedPipe({ purpose, name }) {
    if (purpose !== 'dpapi-unprotect') boundary('管道用途不在固定集合');
    if (typeof name !== 'string' || !/^psr-dpapi-[0-9a-f]{32}$/.test(name)) boundary('管道名格式不在固定边界');
    const id = recordAttempt({ kind: 'connect', program: 'named-pipe',
      attempted: true, completed: false, spawnFailed: false, status: null });
    const socket = rawRefs.connect('\\\\.\\pipe\\' + name);
    attempts.find(a => a.id === id).completed = true;
    return socket;
  },

  /** 异步进程完成回填（调用方在 child close/error 时调用；不重复计数进程）。 */
  completeAsync(attemptId, { code, signal, error }) {
    const entry = attempts.find(a => a.id === attemptId);
    if (!entry) return;
    entry.completed = true;
    entry.spawnFailed = !!(error || signal);
    entry.status = code !== undefined ? code : null;
  },

  /**
   * Git 固定只读能力（保护核对唯一出口）：固定程序 + 固定操作前缀；commitish
   * 形状校验；pathspec 拒绝选项注入（'-' 开头）与空值；超时/限额固定。
   */
  gitReadonly({ operation, commitish, paths }) {
    const prefix = Object.hasOwn(GIT_READONLY_PREFIX, operation) ? GIT_READONLY_PREFIX[operation] : null;
    if (!prefix) boundary('Git 操作不在固定只读集合');
    if (commitish !== undefined && (typeof commitish !== 'string' || !GIT_COMMITISH_RE.test(commitish))) {
      boundary('Git commitish 形状不在固定边界');
    }
    if (paths !== undefined && !isCleanStringArray(paths, { min: 1 })) boundary('Git paths 不是干净的字符串数组');
    if (paths && paths.some(p => p.startsWith('-'))) boundary('Git paths 不允许选项注入');
    const args = [...prefix];
    if (commitish !== undefined) args.push(commitish);
    if (paths !== undefined) args.push('--', ...paths);
    const id = recordAttempt({ kind: 'gitReadonly', program: 'git.exe',
      attempted: true, completed: false, spawnFailed: false, status: null });
    let r, err;
    try { r = rawRefs.execFileSync(PROGRAMS.git, args, { cwd: REPO, timeout: TIMEOUT,
      maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }); } catch (e) { err = e; }
    const entry = attempts.find(a => a.id === id);
    entry.completed = true;
    entry.spawnFailed = !!err;
    entry.status = err ? null : 0;
    if (err) throw err;
    return r;
  },

  /** 实际调用记录快照（净化字段；证据据此汇总进程次数，不手工填写）。 */
  attempts() { return attempts.map(a => ({ ...a })); }
});
