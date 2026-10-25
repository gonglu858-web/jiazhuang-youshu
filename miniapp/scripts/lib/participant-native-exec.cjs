'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// 本包专用固定用途进程/管道能力层（B1，Codex 复查接续 f211469 §2；B1 剩余返修接续
// b102644 复查 §2：按程序固定**完整参数语法/脚本**，拒绝“已批准程序＋未批准操作”）。
// 原始 child_process/net 引用只存于本模块闭包（IIFE 内捕获，装载序列最先执行）；
// 导出仅固定用途能力——程序、参数、cwd、shell/stdio/env、超时/输出限额与命名管道
// 目标一律在能力边界内验证/构造，调用者不能传任意 exe/options，也不能经 getter/
// 工厂取得原始引用。
// B1 返修要点：runProgram 的程序白名单之外，按程序校验完整参数向量——whoami 仅既有
// 身份查询向量；icacls 仅仓库根探针或约定范围内单一只读目标（拒绝选项与越界路径）；
// Git 仅本包同步查询固定形式（[操作, --, 目标]，操作限 check-ignore/ls-files）；
// PowerShell 仅固定参数前缀＋受审 PROTECT/UNPROTECT 完整脚本（逐字节相等，不接受
// 任意 -Command/script，不凭 includes 子串判断）。spawnProgram 仅接受受审 UNPROTECT
// 完整脚本。固定脚本唯一来源：participant-dpapi-scripts.cjs（与本模块无循环依赖）。
// 参数快照契约（45ee875 复查 §2）：调用方参数先在边界内读成自有普通值数组（逐元素
// 索引读取一次，不用可覆盖的 slice/map/every/迭代方法），校验与 spawn 都只消费该
// 快照、不再访问原数组——校验与执行绑定同一份参数值，访问器二次读取到不了 OS 边界。
// 附带实际调用记录（attempts）：区分「尝试 attempted / 完成 completed / spawn 级
// 失败」；异步启动同步抛错如实记失败（completed=true/spawnFailed=true）；completeAsync
// 仅回填异步启动尝试，既有错误事实不可抹除（error 与 close 次序、重复回填均保持事实）。
// 命令状态码语义（如 git check-ignore 的 status 1 = 未忽略，合法）由调用方判定，本层
// 只记录 spawn 失败（error/signal），供证据从实际记录汇总进程次数。
// 记录为净化字段：能力名、程序基名、状态、完成/失败布尔；不含参数内容与输出。
// ═══════════════════════════════════════════════════════════════════════════════
const cp = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const PS_SCRIPTS = require('./participant-dpapi-scripts.cjs');

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
// ── B1：固定用途完整参数语法（按程序；拒绝任意操作/脚本） ──
const WHOAMI_ARGS = Object.freeze(['/user', '/fo', 'csv', '/nh']); // 既有身份查询向量（唯一）
const PS_ARGS_PREFIX = Object.freeze(['-NoProfile', '-NonInteractive', '-Command']);
const ICACLS_REPO_PROBE = '.';                                       // 仓库根探针（cwd 固定仓库根）
const GIT_QUERY_OPS = Object.freeze(['check-ignore', 'ls-files']);   // 同步 Git 查询固定操作（复用只读表前缀）
const MAX_ARGS = 64;                                                  // 参数个数固定上限（合法调用≤4；防超长快照）
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
// B1（45ee875 复查 §2）：参数快照——在能力边界内先把调用方参数读成**自有的普通值数组**，
// 之后全部校验与 spawn 都只消费该快照，不再访问原数组：校验与执行因此绑定同一份参数值。
// 逐元素按索引读取一次（不调用可被覆盖的 slice/map/every/迭代方法，length 也只读一次），
// 访问器属性仅在快照时触发一次——其二次读取值不可能到达 OS 边界。
function snapshotValues(list, label) {
  if (list === null || typeof list !== 'object') boundary(label + ' 不是数组');
  const len = list.length;
  if (typeof len !== 'number' || !Number.isSafeInteger(len) || len < 0 || len > MAX_ARGS) {
    boundary(label + ' 长度不在固定边界');
  }
  const out = [];
  for (let i = 0; i < len; i++) out.push(list[i]);
  return out;
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
// 白名单程序 → 固定键名（按程序校验操作语法用）
function programKey(program) {
  const exe = checkProgram(program);
  return Object.keys(PROGRAMS).find(k => PROGRAMS[k] === exe);
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
// 约定范围：仓库根之内（cwd 固定仓库根；拒绝选项样目标与越界路径）
function checkRepoRelative(target) {
  if (typeof target !== 'string' || !target || target.includes('\0') || target.startsWith('-')) return false;
  const back = path.relative(REPO, path.resolve(REPO, target));
  return !back.startsWith('..') && !path.isAbsolute(back);
}
// ── B1：按程序固定完整参数语法（“已批准程序＋未批准操作”一律拒绝） ──
function checkWhoamiArgs(args) {
  if (args.length !== WHOAMI_ARGS.length || !WHOAMI_ARGS.every((a, i) => args[i] === a)) {
    boundary('whoami 参数不在固定身份查询向量');
  }
}
function checkIcaclsArgs(args) {
  if (args.length !== 1) boundary('icacls 仅接受仓库根探针或单一只读目标');
  if (args[0] === ICACLS_REPO_PROBE) return; // 仓库根探针
  if (!checkRepoRelative(args[0])) boundary('icacls 目标不在约定范围（拒绝选项与越界路径）');
}
function checkGitArgs(args) {
  if (!isCleanStringArray(args, { min: 1 })) boundary('Git 参数不是干净的字符串数组');
  if (!GIT_QUERY_OPS.includes(args[0])) boundary('Git 同步操作不在固定只读集合');
  const prefix = GIT_READONLY_PREFIX[args[0]];
  if (args.length !== prefix.length + 1 || !prefix.every((p, i) => args[i] === p)) {
    boundary('Git 同步查询不在固定只读形式（[操作, --, 目标]）');
  }
  if (!checkRepoRelative(args[args.length - 1])) boundary('Git 查询目标不在约定范围');
}
function checkPowershellArgs(args) {
  if (args.length !== PS_ARGS_PREFIX.length + 1 || !PS_ARGS_PREFIX.every((a, i) => args[i] === a)) {
    boundary('PowerShell 参数不在固定形式');
  }
  const script = args[args.length - 1];
  if (script !== PS_SCRIPTS.PROTECT && script !== PS_SCRIPTS.UNPROTECT) {
    boundary('PowerShell 脚本不是受审固定脚本（拒绝任意 -Command/script 与子串判断）');
  }
}
function checkPurposeArgs(key, args) {
  if (key === 'whoami') return checkWhoamiArgs(args);
  if (key === 'icacls') return checkIcaclsArgs(args);
  if (key === 'git') return checkGitArgs(args);
  if (key === 'powershell') return checkPowershellArgs(args);
  boundary('程序不在固定白名单');
}
// B2：同步抛错如实记失败（attempted=true/completed=true/spawnFailed=true，status 保持 null）
function markAttemptFailed(id) {
  const entry = attempts.find(a => a.id === id);
  entry.completed = true;
  entry.spawnFailed = true;
  entry.status = null;
}

module.exports = Object.freeze({
  ERROR_CODE: BOUNDARY_CODE,

  /**
   * 同步固定进程（local-tools 的 sync 唯一出口）。
   * 边界内构造：固定程序白名单、按程序固定完整参数语法、cwd=仓库根、shell=false、
   * windowsHide=true、默认 stdio、净化 env（删 NODE_OPTIONS）、超时/限额上限。
   * B1（45ee875 复查 §2）：先在边界内形成自有普通参数值快照，再对快照完成全部校验；
   * spawn 只消费同一份快照，之后不再访问原数组——校验与执行绑定同一份参数值。
   */
  runProgram({ program, args, cwd, timeoutMs, maxBuffer, input }) {
    const key = programKey(program);
    const argSnapshot = snapshotValues(args, '参数'); // 先快照（不校验原数组、不用其可覆盖方法）
    checkPurposeArgs(key, argSnapshot);                // 对快照做完整参数语法校验
    const exe = PROGRAMS[key];
    const limits = checkLimits(timeoutMs, maxBuffer);
    const opts = { cwd: checkCwd(cwd), input: checkInput(input), windowsHide: true,
      shell: false, env: sanitizedEnv(), timeout: limits.timeoutMs, maxBuffer: limits.maxBuffer };
    const id = recordAttempt({ kind: 'runProgram', program: baseName(exe),
      attempted: true, completed: false, spawnFailed: false, status: null });
    let r, err;
    try { r = rawRefs.spawnSync(exe, argSnapshot, opts); } catch (e) { err = e; }
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
   * 边界内构造：固定 powershell 白名单、purpose 固定集合、受审 UNPROTECT 完整脚本
   * （逐字节相等）、固定参数前缀、固定 stdio ['pipe','ignore','pipe']、cwd=仓库根、
   * shell=false、windowsHide=true、净化 env。同步抛错如实记失败后向调用方抛出。
   * 返回 { child, attemptId }；完成时由调用方以 completeAsync 回填。
   */
  spawnProgram({ purpose, script, cwd }) {
    if (purpose !== 'dpapi-unprotect') boundary('异步进程用途不在固定集合');
    if (script !== PS_SCRIPTS.UNPROTECT) {
      boundary('异步脚本不是受审固定 UNPROTECT 脚本（逐字节相等；拒绝任意 script 与 includes 子串判断）');
    }
    const exe = PROGRAMS.powershell;
    const opts = { cwd: checkCwd(cwd), windowsHide: true, shell: false,
      env: sanitizedEnv(), stdio: ['pipe', 'ignore', 'pipe'] };
    const id = recordAttempt({ kind: 'spawnProgram', program: baseName(exe),
      attempted: true, completed: false, spawnFailed: false, status: null });
    let child;
    try { child = rawRefs.spawn(exe, [...PS_ARGS_PREFIX, script], opts); }
    catch (e) { markAttemptFailed(id); throw e; }
    return { child, attemptId: id };
  },

  /** 命名管道连接（仅 DPAPI 解密管道；目标格式在边界内构造；同步抛错如实记失败）。 */
  connectNamedPipe({ purpose, name }) {
    if (purpose !== 'dpapi-unprotect') boundary('管道用途不在固定集合');
    if (typeof name !== 'string' || !/^psr-dpapi-[0-9a-f]{32}$/.test(name)) boundary('管道名格式不在固定边界');
    const id = recordAttempt({ kind: 'connect', program: 'named-pipe',
      attempted: true, completed: false, spawnFailed: false, status: null });
    let socket;
    try { socket = rawRefs.connect('\\\\.\\pipe\\' + name); }
    catch (e) { markAttemptFailed(id); throw e; }
    attempts.find(a => a.id === id).completed = true;
    return socket;
  },

  /**
   * 异步进程完成回填（调用方在 child close/error 时调用；不重复计数进程）。
   * B2：仅回填异步启动尝试（kind=spawnProgram）——不同步记录、不修改其他尝试；
   * 既有失败事实不可抹除：已记 spawnFailed（同步抛错或先前 error）后忽略后续回填，
   * error 与 close 的先后次序均保持首先抵达的终态事实，重复回填不改变记录。
   */
  completeAsync(attemptId, { code, signal, error }) {
    const entry = attempts.find(a => a.id === attemptId);
    if (!entry || entry.kind !== 'spawnProgram') return;
    if (entry.spawnFailed) return;
    entry.completed = true;
    entry.spawnFailed = !!(error || signal);
    entry.status = entry.spawnFailed ? null : (code !== undefined ? code : null);
  },

  /**
   * Git 固定只读能力（保护核对唯一出口）：固定程序 + 固定操作前缀；commitish
   * 形状校验；pathspec 拒绝选项注入（'-' 开头）与空值；超时/限额固定。
   * B1（45ee875 复查 §2）：paths 同样先形成自有快照再校验，args 只从快照构建——
   * 校验与执行绑定同一份参数值，访问器二次读取不能把选项注入交给 git。
   */
  gitReadonly({ operation, commitish, paths }) {
    const prefix = Object.hasOwn(GIT_READONLY_PREFIX, operation) ? GIT_READONLY_PREFIX[operation] : null;
    if (!prefix) boundary('Git 操作不在固定只读集合');
    if (commitish !== undefined && (typeof commitish !== 'string' || !GIT_COMMITISH_RE.test(commitish))) {
      boundary('Git commitish 形状不在固定边界');
    }
    let pathSnapshot = null;
    if (paths !== undefined) {
      pathSnapshot = snapshotValues(paths, 'Git paths'); // 先快照，再校验快照
      if (!isCleanStringArray(pathSnapshot, { min: 1 })) boundary('Git paths 不是干净的字符串数组');
      if (pathSnapshot.some(p => p.startsWith('-'))) boundary('Git paths 不允许选项注入');
    }
    const args = [...prefix];
    if (commitish !== undefined) args.push(commitish);
    if (pathSnapshot !== null) args.push('--', ...pathSnapshot); // 只消费快照
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
