'use strict';
/**
 * CloudBase CLI 身份与环境**只读观测**库（L1/L2）
 * =====================================================
 *
 * 定位（重要）
 * ────────────
 * 本文件把已实测的官方 CLI 只读通道封装为一个**本地只读观测工具**，回答三件事：
 *   1. 当前签名调用者（STS GetCallerIdentity）是什么身份类型；
 *   2. 指定环境是否存在、状态是否正常、地域是否匹配；
 *   3. 该环境的归属账号与微信 AppID 是否与 STS 结果相符。
 *
 * 它**不是**授权器：
 *   - 不实现、不替换 P4 的 `verifyCaller`，不接入初始化调用链；
 *   - 所有分支 `writeAuthorized = false`，永不输出 `allowed:true`；
 *   - 不生成初始化计划、approval、人员允许名单或可供 P4 执行的凭据；
 *   - 身份只保留 SHA-256 摘要 / 尾号，不输出完整 AccountId、UserId、
 *     PrincipalId、Arn，也不传播原始 CLI 返回。
 *
 * 固定边界（L1）
 * ─────────────
 * - Node、CLI 入口、**入口完整字节哈希与内容**、bundle、bundle SHA-256、官方登录目录、
 *   环境、地域、微信 AppID 全部是**本机已验收的固定值**（见 FIXED）。这是本机约束，
 *   **不是通用安装发现器**，也不宣传为可自动定位任何安装。
 *   入口校验为**完整字节**比对（哈希 + 精确内容），不再用片段 `includes`：片段匹配可被
 *   「require 后追加可执行语句」或「require 只写在注释里」绕过，而真实执行正是从该入口开始。
 * - 缺失或不符即停止：**不自动下载、不修复、不换版本**。
 * - 子进程：独立参数数组 + `shell:false`，**不拼PowerShell/cmd 字符串**，
 *   **不调用全局 PATH 中的 tcb**；cwd 固定为独立登录目录；只对子进程设置
 *   USERPROFILE，并验证该子进程 `os.homedir()` 等于固定目录（不改系统永久变量）。
 *   实现用**异步 `spawn`**：交付当时本机实测 `spawnSync` 返回 `EBUSY`（同参数 `spawn` 正常
 *   退出 0），而 homedir 核验与三项查询都必须真实执行，**不放宽检查来绕过环境问题**。
 *   该现象是**交付当时的环境事实**，不是跨时点永久性质。
 * - 环境变量：清除继承的 `CLOUDBASE_*` / `TCB_*` / `TENCENTCLOUD_*` / `NODE_OPTIONS`，
 *   再显式设置 `TCB_REGION` / `NO_UPDATE_NOTIFIER=1` / `TCB_DISABLE_REPORT=1` / `CI=1`。
 *   `CI=1` 的依据：本机已安装 bundle 的公共鉴权分支仅在 `autoRunLogin && !process.env.CI`
 *   时自动打开登录，无登录且 CI 时抛错（静态源码核对，**不等于已实测所有过期刷新分支**）。
 * - 每条查询：最多 55 秒、**stdout+stderr 合并原始字节**最多 1 MiB；超时 / 启动失败 /
 *   超限 / 退出非零**立即停止后续查询**，不包装无限重试。输出按 Buffer 收集、收尾时一次性
 *   解码，跨 chunk 的 UTF-8 不被逐 chunk 转换破坏；收尾后不再保留数据、不再二次 kill。
 *   **区分「已请求终止」与「已观察退出」**：只有真实的 `close`/`exit` 才算进程退出证据，
 *   `kill()` 无效时如实记为终止未确认，不声称已终止。
 *   `exit` **只记录退出事实**——进程退出不代表 stdout/stderr 已关闭；正常结果一律等`close`
 *   后按**完整受限输出**解析。若 `close` 迟迟不来，则在**首次 exit 之后**启动的宽限定时器
 *   会**有界失败**（`SPAWN_CLOSE_UNCONFIRMED`），不把半截输出当成功、不无限等待。
 *   该宽限**从 exit 起算**，不是从 spawn 起算：未观察到 `exit` 的进程继续只受总超时约束，
 *   正常运行超过宽限值的查询不会被误判提前失败。宽限不会延长总超时。
 *   收尾时**保留** child 的 `error` 监听作为幂等吸收器：晚到 `error` 既不抛出也不打印，
 *   不追加输出、不改报告、不二次 kill（无 error 监听的 EventEmitter 发射 error 会抛错）。
 *   CLI 内部凭据刷新或重试**不由本工具声称为零次**。
 * - 不暴露任意 service/action/body/env/region/可执行路径/认证目录选项；
 *   依赖替换仅供模块测试注入，**不通过命令行提供跳过检查的开关**。
 * - 不加载项目 cloudbaserc、不提取认证缓存、不把 CLI 凭据复制给 node-sdk；
 *   **不读取或输出密钥、Token、OPENID**。
 * - **字段类型契约（C1，窄适配）**：`EnvInfo.UserInfo.Uin` 真实实测为 `number`
 *   （`Number.isSafeInteger` 为 true），历史字符串形态亦需继续支持。故该字段**只**接受
 *   「十进制正整数字符串」（保留原始字节：不trim、不去前导零、不数值化）或
 *   「有限正安全整数 number」（以 `String(value)` 作摘要输入）；`null` / `undefined` / 布尔 /
 *   对象 / 数组及其它类型，以及不安全整数 / 小数 / 负数 / 零 / `NaN` / `Infinity`
 *   **全部拒绝**，不使用任意 `String(value)` 让对象蒙混过关。该适配**仅**用于环境归属 Uin，
 *   **不放宽 STS `AccountId`**（仍须字符串），也不改 `WxAppId` 与地域检查。
 *
 * 解析契约（L2）
 * ─────────────
 * 已核对的 CLI 输出结构（来源：`dist/standalone/cli.js` 源码）：
 *   - `log.info` 先打印一行固定动作提示：`ℹ → STS.GetCallerIdentity`
 *     （源码 `ApiCallCommand.execute`：`${symbols.info} ${bold.cyan('→')} ${bold(SERVICE.ACTION)}`）；
 *   - `--json` 时 `outputJson(result)` 打印 **单根对象** `{ "data": <result> }`
 *     —— 外层 `data` 包装由 CLI 加，`result` 本身是云API 的 `Response` 内容
 *     （`commonService.call` 已剥离 `data.Response`）。
 *
 * 因此本模块**不接受**「第一个 `{` 到最后一个 `}`」式无条件提取，也**不**从多个对象里
 * 挑看起来成功的那个：清理 ANSI 显示控制序列后，**仅**根对象之前/之后允许**与当前 action
 * 相符**的固定提示行与空白；根对象内部**逐字保留**交给 `JSON.parse`，内部混入提示一律拒绝。
 * 多根、截断、数组/null 根、平台错误对象、未知前后文本一律先失败。
 * 不兼容输出**先失败**，不扩大到任意文本提取。
 *
 * 未验证（不得当作通过）
 * ─────────────────────
 * - 真实平台上 `Type` / `EnvList` / `EnvInfo` 的确切字段形态未由本轮实测确认，
 *   依据是上述本机源码与既有安全记录；若本机源码与既有记录不能确定某个字段类型，
 *   本模块**不做猜测转换**，交付时明确说明。
 * - 同一登录目录**不证明**三次调用使用同一份未刷新的临时凭据；本模块也**不能**
 *   完成数据库 SDK 的同凭据核验。
 * - 本工具不核实费用/余量：三接口不提供计费余额或可用配额。
 */

/* ── 本机已验收固定值（L1） ──────────────────────────────────────────── */

const FIXED = Object.freeze({
  /** 已验收的本机 Node */
  nodeBin: 'C:/Users/30591/.agent-reach/tools/node-v22.16.0-win-x64/node.exe',
  /** 已验收的 CLI 入口（转发到 bundle） */
  cliEntry: 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/bin/tcb',
  /** 已验收的 bundle */
  cliBundle: 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/dist/standalone/cli.js',
  /** bundle SHA-256（与安装核验记录一致） */
  cliBundleSha256: '8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97',
  /** 已验收的 CLI 版本 */
  cliVersion: '3.8.4',
  /**
   * 已验收入口文件的**完整字节** SHA-256（57 字节：shebang + 转发 require）。
   *
   * R1 返修：此前只做 `includes('require(...)')` 片段匹配，可被「require 后追加可执行
   * 语句」或「require 只写在注释里」两种合成反例绕过；bundle 哈希并不能约束启动文件，
   * 因为真实执行正是从这个入口文件开始。
   */
  cliEntrySha256: '328da4af4726c2aa4b20cf9b2e1a3614e4f22bf2e8fb8cb6d601692180de926b',
  /** 已验收入口文件的完整字节内容（精确相等，不接受额外语句、注释冒充或缺失） */
  cliEntryExactBytes: "#!/usr/bin/env node\nrequire('../dist/standalone/cli.js')\n",
  /** 官方登录隔离目录（cwd 与 USERPROFILE 目标） */
  authSessionDir: 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/auth-session-20261007',
  envId: 'cloud1-d8gcq5ag39d847723',
  region: 'ap-shanghai',
  wxAppId: 'wxfb4db1615ac15531',
  /** 已核验的调用者身份类型；本轮只接受这一个 */
  acceptedStsType: 'CAMRole'
});

/** 子进程超时与输出上限 */
const LIMITS = Object.freeze({
  timeoutMs: 55000,
  maxOutputBytes: 1024 * 1024,
  /**
   * 观察到**首次** `exit` 之后等待 `close` 的宽限毫秒数（计时从 exit 起算，不是从 spawn）。
   *
   * S1：`exit` 只说明进程结束，**不代表 stdout/stderr 已关闭**；正常结果必须等 `close`
   * 才收尾，否则会丢弃尚在管道里的输出。若 `close` 迟迟不来，则在宽限后**有界失败**。
   *
   * T1：这是**本机保守失败阈值**，不是平台耗时承诺；也**不是**从 spawn 起算的总时限——
   * 总时限始终是上面的 `timeoutMs`。未出现 `exit` 的进程不会启动该计时器。
   */
  closeGraceMs: 2000
});

/** 唯一允许的三项查询，按次序执行；不可参数化 */
const STAGES = Object.freeze([
  Object.freeze({
    key: 'callerIdentity',
    service: 'sts',
    action: 'GetCallerIdentity',
    apiVersion: '2018-08-13',
    /** STS 无环境选择参数 —— 不能把它说成环境限定的身份凭据 */
    envArgs: Object.freeze([]),
    body: null
  }),
  Object.freeze({
    key: 'describeEnvs',
    service: 'tcb',
    action: 'DescribeEnvs',
    apiVersion: '2018-06-08',
    envArgs: Object.freeze(['-e', FIXED.envId]),
    body: '{"EnvId":"cloud1-d8gcq5ag39d847723"}'
  }),
  Object.freeze({
    key: 'describeEnvInfo',
    service: 'tcb',
    action: 'DescribeEnvInfo',
    apiVersion: '2018-06-08',
    envArgs: Object.freeze(['-e', FIXED.envId]),
    body: '{"EnvId":"cloud1-d8gcq5ag39d847723"}'
  })
]);

const SCHEMA_VERSION = 1;

/** 状态取值 */
const STATUS = Object.freeze({
  LOCAL_READY: 'LOCAL_READY',
  LOCAL_NOT_READY: 'LOCAL_NOT_READY',
  ASSOCIATION_OBSERVED: 'ASSOCIATION_OBSERVED',
  FAILED: 'FAILED'
});

/** 错误码（本层定义，非平台错误码清单） */
const ERR = Object.freeze({
  ARGS_INVALID: 'ARGS_INVALID',
  ARGS_CONFLICT: 'ARGS_CONFLICT',
  LOCAL_NODE_MISSING: 'LOCAL_NODE_MISSING',
  LOCAL_CLI_MISSING: 'LOCAL_CLI_MISSING',
  LOCAL_BUNDLE_MISSING: 'LOCAL_BUNDLE_MISSING',
  LOCAL_BUNDLE_HASH_MISMATCH: 'LOCAL_BUNDLE_HASH_MISMATCH',
  LOCAL_ENTRY_MISMATCH: 'LOCAL_ENTRY_MISMATCH',
  LOCAL_VERSION_MISMATCH: 'LOCAL_VERSION_MISMATCH',
  LOCAL_HOMEDIR_MISMATCH: 'LOCAL_HOMEDIR_MISMATCH',
  LOCAL_HOMEDIR_CHECK_FAILED: 'LOCAL_HOMEDIR_CHECK_FAILED',
  SPAWN_FAILED: 'SPAWN_FAILED',
  SPAWN_TIMEOUT: 'SPAWN_TIMEOUT',
  SPAWN_SIGNALLED: 'SPAWN_SIGNALLED',
  SPAWN_CLOSE_UNCONFIRMED: 'SPAWN_CLOSE_UNCONFIRMED',
  SPAWN_OUTPUT_LIMIT: 'SPAWN_OUTPUT_LIMIT',
  CLI_NONZERO_EXIT: 'CLI_NONZERO_EXIT',
  CLI_OUTPUT_UNPARSEABLE: 'CLI_OUTPUT_UNPARSEABLE',
  PLATFORM_ERROR_OBJECT: 'PLATFORM_ERROR_OBJECT',
  STS_TYPE_UNVERIFIED: 'STS_TYPE_UNVERIFIED',
  STS_FIELD_INVALID: 'STS_FIELD_INVALID',
  ENVS_NOT_SINGLE: 'ENVS_NOT_SINGLE',
  ENVS_FIELD_INVALID: 'ENVS_FIELD_INVALID',
  ENVS_FIELD_MISMATCH: 'ENVS_FIELD_MISMATCH',
  ENV_INFO_FIELD_INVALID: 'ENV_INFO_FIELD_INVALID',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  WX_APP_ID_MISMATCH: 'WX_APP_ID_MISMATCH'
});

class ObserverError extends Error {
  constructor(code, message, extra) {
    super(`[readonly-observer] ${message}`);
    this.name = 'ObserverError';
    this.code = code;
    if (extra && extra.stage) this.stage = extra.stage;
    // R4：净化执行诊断（退出码/超时/终止确认），不含原始 stdout/stderr
    if (extra && extra.diag) this.diag = extra.diag;
  }
}

function fail(code, message, stage, diag) {
  throw new ObserverError(code, message, {
    stage: stage || undefined,
    diag: diag || undefined
  });
}

function text(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 生效的固定值。
 *
 * 生产使用 `FIXED`；**仅模块测试**可经 `deps.fixed` 注入合成路径与合成哈希，
 * 以便在离线环境里真实执行「存在性/ 入口转发内容 / 版本 / 源码哈希 / homedir」
 * 每项检查，而不是把它们跳掉。**命令行不提供任何跳过检查的开关。**
 */
function resolveFixed(deps) {
  const d = deps || {};
  if (!d.fixed) return FIXED;
  const merged = Object.assign({}, FIXED, d.fixed);
  return Object.freeze(merged);
}

/* ── 参数解析（L1：未知/冲突参数在启动任何子进程前拒绝） ────────────── */

/**
 * 只接受两种形态：无参数（默认本地检查）或恰好一个 `--read-only`。
 * 写入类（`--execute` / `--approval`）、未知开关与额外位置参数一律拒绝。
 *
 * @param {string[]} argv 完整参数数组（含前两项）
 * @returns {{mode: 'local-check'|'read-only'}}
 */
function parseObserverArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.length < 2) fail(ERR.ARGS_INVALID, '参数数组无效。');
  const rest = args.slice(2);
  for (const arg of rest) {
    if (arg === '--execute' || arg === '--approval' || arg === '--init') {
      fail(ERR.ARGS_CONFLICT, '不接受写入类参数：写入授权不在本工具范围内。');
    }
  }
  const unknown = rest.filter(a => a !== '--read-only');
  if (unknown.length > 0) {
    fail(ERR.ARGS_INVALID, '存在未知或多余参数，已在启动子进程前拒绝。');
  }
  if (rest.length > 1) {
    fail(ERR.ARGS_CONFLICT, '`--read-only` 不得重复或与其它参数并列。');
  }
  return { mode: rest.length === 1 ? 'read-only' : 'local-check' };
}

/* ── 本地准备条件检查（L1，不启动任何云命令、不读认证内容） ────────── */

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    fs: require('node:fs'),
    path: require('node:path'),
    crypto: require('node:crypto'),
    spawn: require('node:child_process').spawn
  };
}

/**
 * 生效的超时与输出上限。
 *
 * 生产使用 `LIMITS`（55 秒 / 1 MiB）；**仅模块测试**可经 `deps.limits` 注入更小的值，
 * 以便在离线环境里**真实触发**超时与输出上限分支，而不是把它们跳过或靠长等待。
 * **命令行不提供任何放宽限制的开关。**
 */
function resolveLimits(deps) {
  const d = deps || {};
  if (!d.limits) return LIMITS;
  return Object.freeze({
    timeoutMs: d.limits.timeoutMs === undefined ? LIMITS.timeoutMs : d.limits.timeoutMs,
    maxOutputBytes: d.limits.maxOutputBytes === undefined ? LIMITS.maxOutputBytes : d.limits.maxOutputBytes,
    closeGraceMs: d.limits.closeGraceMs === undefined ? LIMITS.closeGraceMs : d.limits.closeGraceMs
  });
}

/**
 * 运行一个子进程并受限收集输出。
 *
 * 用**异步 spawn**：交付当时本机实测 `spawnSync` 返回 `EBUSY`（同参数 `spawn` 正常退出 0），
 * 因此不放宽检查，改用不会触发该问题的执行方式。该现象是**交付当时的环境事实**，
 * 不是跨时点永久性质。
 *
 * R2 返修要点：
 *   1. **stdout + stderr 合并原始字节**累计上限（不是各自上限）；**先计数再保留**，
 *      保留缓冲不越限；按 Buffer 收集、**收尾时一次性解码**，跨 chunk 的 UTF-8 不会被
 *      逐 chunk String 转换破坏。
 *   2. 超时/超限/失败一旦收尾，**停止追加**、不再二次 kill；移除监听并清理计时器。
 *   3. **区分「已请求终止」与「已观察退出」**：只把真实的 `close`/`exit` 当作进程退出
 *      证据。`kill()` 返回 false 或抛错时终止**未确认**，如实记录，不声称已终止。
 *   4. 不引入无限终止循环：终止请求只发一次。
 *
 * 原始 stdout/stderr 只在本函数内存中处理，不打印、不落库。
 *
 * @returns {Promise<{
 *   code: number|null, signal: string|null, stdout: string, stderr: string,
 *   timedOut: boolean, overflow: boolean, spawnError: Error|null,
 *   terminationRequested: boolean, processExited: boolean, terminationConfirmed: boolean,
 *   retainedBytes: number, totalBytes: number
 * }>}
 */
function spawnBounded(bin, args, options, deps) {
  const d = deps;
  // 归一化：直接注入 `__limits`（如旧夹具只给 timeoutMs/maxOutputBytes）时也补齐缺省字段，
  // 避免 `setTimeout(cb, undefined)` 被当作 0/1ms 立即触发。生产走 LIMITS。
  const limits = resolveLimits({ limits: d.__limits });
  return new Promise(resolve => {
    const emptyResult = (extra) => Object.assign({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      overflow: false,
      spawnError: null,
      terminationRequested: false,
      processExited: false,
      terminationConfirmed: false,
      closeNotObserved: false,
      retainedBytes: 0,
      totalBytes: 0
    }, extra || {});

    let child;
    try {
      child = d.spawn(bin, args, options);
    } catch (error) {
      resolve(emptyResult({ spawnError: error }));
      return;
    }
    if (!child || typeof child.on !== 'function') {
      resolve(emptyResult({ spawnError: new Error('spawn returned no handle') }));
      return;
    }

    // 原始字节缓冲：只保留上限内的部分，超限部分计数但丢弃
    const outChunks = [];
    const errChunks = [];
    let totalBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let terminationRequested = false;
    let processExited = false;
    let terminationConfirmed = false;
    // S1：exit 记录到的 code/signal，仅用于 exit 后 close 未到时的有界失败
    let exitCode = null;
    let exitSignal = null;

    /**
     * 先按字节计数，再只保留仍在**合并上限**内的部分。
     * 上限对 stdout+stderr **合并**生效：两个流各自低于上限但合计超限，同样拒绝。
     * @returns {boolean} 本次写入是否使合并保留量达到/超过上限
     */
    const keep = (chunks, incoming) => {
      const buf = Buffer.isBuffer(incoming) ? incoming : Buffer.from(String(incoming), 'utf8');
      totalBytes += buf.length;
      let held = 0;
      for (const c of outChunks) held += c.length;
      for (const c of errChunks) held += c.length;
      const room = limits.maxOutputBytes - held;
      if (room <= 0) return true;
      if (buf.length <= room) {
        chunks.push(buf);
        return false;
      }
      chunks.push(buf.subarray(0, room));
      return true;
    };

    const decode = (chunks) => {
      if (chunks.length === 0) return '';
      return Buffer.concat(chunks).toString('utf8');
    };

    const retained = () => {
      const a = outChunks.reduce((n, c) => n + c.length, 0);
      const b = errChunks.reduce((n, c) => n + c.length, 0);
      return a + b;
    };

    /**
     * 幂等收尾：解析报告、清理计时器、停止累积数据，并**安全吸收晚到事件**。
     *
     * S2：这里**不**移除 child 的 `error` 监听。超时/超限只是请求 kill，进程未确认退出时
     * 仍可能随后发出 `error`；Node 事件对象在没有 error 监听时会**抛错**，那不是「安全
     * 丢弃晚到事件」。因此保留一个幂等的吸收器：晚到 error 既不追加输出、不改最终报告，
     * 也不二次 kill、不重试、不发后续请求。
     *
     * 只移除会**累积数据**的 data 监听（stdout/stderr）；「所有监听都为零」不是正确性目标。
     */
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      // 仅移除会累积数据的处理器
      for (const stream of [child.stdout, child.stderr]) {
        if (stream && typeof stream.removeListener === 'function') {
          stream.removeListener('data', onOut);
          stream.removeListener('data', onErr);
        }
      }
      if (typeof child.removeListener === 'function') {
        child.removeListener('close', onClose);
        child.removeListener('exit', onExit);
      }
      // 注意：**保留** onError 作为晚到 error 的幂等吸收器（S2）
      resolve(emptyResult(Object.assign({
        stdout: decode(outChunks),
        stderr: decode(errChunks),
        timedOut,
        overflow,
        terminationRequested,
        processExited,
        terminationConfirmed,
        retainedBytes: retained(),
        totalBytes
      }, extra || {})));
    };

    /** R2-3：只发一次终止请求；返回是否观察到进程真的退出 */
    const requestTermination = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      try {
        child.kill();
      } catch (error) {
        // 抛错同样只说明「终止请求未生效」，不伪造已终止
      }
    };

    /** 记录一个来源的字节；返回是否越界 */
    const feed = (chunks, buf) => {
      if (keep(chunks, buf)) {
        overflow = true;
        return true;
      }
      return false;
    };

    function onOut(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (feed(outChunks, buf)) {
        requestTermination();
        finish({ code: null, signal: null });
      }
    }

    function onErr(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (feed(errChunks, buf)) {
        requestTermination();
        finish({ code: null, signal: null });
      }
    }

    /**
     * S2：`error` 事件的幂等吸收器。
     * 首次 error（子进程启动/通信失败）作为结果返回；**收尾后的晚到 error 只被吸收**，
     * 不抛出、不打印、不追加输出、不改最终报告、不二次 kill。
     */
    function onError(error) {
      if (settled) return;
      finish({ spawnError: error, code: null, signal: null });
    }

    function onClose(code, signal) {
      if (settled) return;
      // 只有真实的 close 才意味着 stdout/stderr 已读完，可以收尾并按完整输出解析
      processExited = true;
      terminationConfirmed = true;
      finish({ code: code === undefined ? null : code, signal: signal || null });
    }

    /**
     * S1/T1：`exit` **只记录退出事实**，不把「stdout 已读完」当作既成事实。
     *
     * 进程退出事件并不意味着 stdout/stderr 已关闭 —— 管道里可能还有内容。因此这里不收尾，
     * 由 `close` 完成最终收尾；close 宽限定时器也**只在这里（首次 exit 之后）**启动。
     */
    //监听在下方统一注册一次（不可重复注册，否则收尾时 removeListener 摘不干净）
    /**
     * S1：观察到 `exit` **之后**才启动的 close 宽限定时器。
     *
     * T1 返修：句柄初始为 `null`，计时**只由首次真实 exit 事件启动**。此前该
     * `setTimeout` 写在注册监听之后，进入 `spawnBounded` 就开始计时，于是任何正常运行
     * 超过 closeGraceMs 的查询都会被误判「close 未确认」而提前失败。重复 exit 既不刷新
     * 也不重复启动该计时器。
     */
    let graceTimer = null;

    function onExit(code, signal) {
      if (settled) return;
      // 记录「确实退出过」这一事实，但不合成 signal、也不假设输出已读完
      processExited = true;
      if (code !== null && code !== undefined) exitCode = code;
      if (signal) exitSignal = signal;
      if (exitCode !== null || exitSignal !== null) terminationConfirmed = true;
      // T1：仅首次 exit 启动 close 宽限；已启动则不刷新
      if (graceTimer === null) {
        graceTimer = setTimeout(() => {
          if (settled) return;
          // 回调只可能对应「已观察 exit、尚未 close」的情形：
          // 未退出进程的宽限计时器根本不会启动，因此不会被标成该错误。
          finish({ code: exitCode, signal: exitSignal || null, closeNotObserved: true });
        }, limits.closeGraceMs);
      }
    }

    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', onOut);
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', onErr);
    child.on('error', onError);
    child.on('close', onClose);
    child.on('exit', onExit);

    //总超时从 spawn 起算，贯穿整个等待期（含 exit 后等 close 的阶段）；
    // 与 close 宽限以先达到者有界失败，宽限不会延长总超时。
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      requestTermination();
      // 即使终止未被确认也立即结束等待：失败关闭、不重试，但如实记录未确认
      finish({ code: null, signal: null });
    }, limits.timeoutMs);
  });
}

/** 构造子进程环境：先清除继承的认证/配置变量，再显式设置固定值。 */
function buildChildEnv(baseEnv, fixed) {
  const F = fixed || FIXED;
  const out = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    const upper = key.toUpperCase();
    if (upper.startsWith('CLOUDBASE_') || upper.startsWith('TCB_')
      || upper.startsWith('TENCENTCLOUD_') || upper === 'NODE_OPTIONS') {
      continue;
    }
    out[key] = value;
  }
  out.USERPROFILE = F.authSessionDir;
  out.HOME = F.authSessionDir;
  out.TCB_REGION = F.region;
  out.NO_UPDATE_NOTIFIER = '1';
  out.TCB_DISABLE_REPORT = '1';
  out.CI = '1';
  return out;
}

function sha256Of(fs, crypto, file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 默认本地检查：只核对非敏感安装元数据与源码哈希，并用固定 Node 跑一次
 * `os.homedir()` 确认子进程用户目录。
 *
 * **不启动任何 CLI 云命令、不读取认证文件内容、不宣称「登录有效」。**
 *
 * @returns {Promise<{ok: boolean, checks: Array<{name: string, ok: boolean}>}>}
 */
async function checkLocalReadiness(deps) {
  const d = Object.assign(defaultDeps(), deps || {});
  const F = resolveFixed(deps);
  d.__limits = resolveLimits(deps);
  const checks = [];
  const record = async (name, fn) => {
    let ok = false;
    let code = '';
    try {
      ok = (await fn()) === true;
    } catch (error) {
      ok = false;
      code = error && error.code ? String(error.code) : 'LOCAL_CHECK_FAILED';
    }
    checks.push(ok ? { name, ok: true } : { name, ok: false, code });
    return ok;
  };

  await record('node-binary', async () => d.fs.existsSync(F.nodeBin) && d.fs.statSync(F.nodeBin).isFile());
  await record('cli-entry', async () => d.fs.existsSync(F.cliEntry) && d.fs.statSync(F.cliEntry).isFile());
  await record('cli-bundle', async () => d.fs.existsSync(F.cliBundle) && d.fs.statSync(F.cliBundle).isFile());
  await record('cli-entry-content', async () => {
    // R1：完整字节校验（哈希 + 精确内容），拒绝额外语句、注释冒充与缺失
    const buf = d.fs.readFileSync(F.cliEntry);
    const digest = d.crypto.createHash('sha256').update(buf).digest('hex');
    if (digest.toLowerCase() !== String(F.cliEntrySha256).toLowerCase()) return false;
    return buf.toString('utf8') === F.cliEntryExactBytes;
  });
  await record('cli-bundle-hash', async () =>
    sha256Of(d.fs, d.crypto, F.cliBundle).toLowerCase() === String(F.cliBundleSha256).toLowerCase());
  await record('cli-version', async () => {
    const pkg = JSON.parse(d.fs.readFileSync(d.path.join(d.path.dirname(F.cliEntry), '..', 'package.json'), 'utf8'));
    return pkg && String(pkg.version) === F.cliVersion;
  });
  // 只对子进程设置 USERPROFILE，并用同一 Node 验证该子进程看到的主目录
  await record('auth-session-homedir', async () => {
    const r = await spawnBounded(F.nodeBin,
      ['-e', 'process.stdout.write(require("node:os").homedir())'],
      {
        cwd: F.authSessionDir,
        env: buildChildEnv(d.baseEnv || process.env, F),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }, d);
    if (r.spawnError || r.timedOut || r.overflow || r.code !== 0) return false;
    return String(r.stdout || '').trim() === F.authSessionDir;
  });

  return { ok: checks.every(c => c.ok), checks };
}

/* ── 输出解析（L2） ────────────────────────────────────────────────── */

// ANSI 显示控制序列（含颜色/加粗）。CLI 用 chalk 打印提示行，必须先清理。
const ANSI_PATTERN = /[][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><]/g;

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

/**
 * 解析单个 JSON 根对象。
 *
 * 允许的额外内容：**仅**根对象之前/之后的空白 + 与当前 action 相符的固定提示行。
 * R3 返修：提示行**不得**出现在根对象内部。此前实现按行全局删除提示行，会把根对象内部
 * 混入提示的非法输出「修好」后当作成功，继续参与关联判断。现在根对象内部**逐字保留**
 * 交给 `JSON.parse`，内部混入任何提示一律拒绝。
 *
 * 拒绝：多个根对象、截断 JSON、数组/null 根、平台错误对象、根内混入提示、其它文本。
 *
 * @param {string} stdout 子进程 stdout
 * @param {string} service
 * @param {string} action
 * @param {string} [stage] 出错时绑定的阶段键（R4）
 * @returns {object} 实际结果对象（已剥离 CLI 的 `data` 包装）
 */
function parseCliJson(stdout, service, action, stage) {
  const cleaned = stripAnsi(stdout === undefined || stdout === null ? '' : stdout).replace(/\r\n/g, '\n');
  const lines = cleaned.split('\n');
  const allowedHint = new RegExp('^\\s*[\\u2139i]\\s*\\u2192\\s*'
    + service.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '\\.' + action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');

  // ── 1. 跳过根对象**之前**的空白与允许提示行 ────────────────────────
  let start = 0;
  while (start < lines.length
    && (lines[start].trim() === '' || allowedHint.test(lines[start]))) {
    start++;
  }
  if (start >= lines.length) {
    fail(ERR.CLI_OUTPUT_UNPARSEABLE, '输出中没有可解析的 JSON 根对象。', stage);
  }
  const head = lines[start].trim();
  if (head[0] === '[' || head === 'null') {
    fail(ERR.CLI_OUTPUT_UNPARSEABLE, '输出根不是对象。', stage);
  }
  if (head[0] !== '{') {
    fail(ERR.CLI_OUTPUT_UNPARSEABLE, '输出中存在未知的前后文本。', stage);
  }

  // ── 2. 从根对象首字符起做括号配对（字符串内花括号不计） ─────────────
  // 这里在**原始行**上配对：根对象内部任何一行都不被删除或改写。
  const joined = lines.join('\n');
  const baseOffset = lines.slice(0, start).reduce((n, l) => n + l.length + 1, 0);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = baseOffset; i < joined.length; i++) {
    const ch = joined[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (depth !== 0 || end < 0) {
    fail(ERR.CLI_OUTPUT_UNPARSEABLE, 'JSON 根对象被截断。', stage);
  }

  const rootText = joined.slice(baseOffset, end + 1);

  // ── 3. 根对象**之后**只允许空白与允许提示行；多根因此被拒 ──────────
  for (const line of joined.slice(end + 1).split('\n')) {
    if (line.trim() === '') continue;
    if (allowedHint.test(line)) continue;
    fail(ERR.CLI_OUTPUT_UNPARSEABLE, '根对象之后存在额外内容（多根或未知文本）。', stage);
  }

  let parsed;
  try {
    // R3：逐字解析；根对象内部混入提示会在这里失败
    parsed = JSON.parse(rootText);
  } catch (error) {
    fail(ERR.CLI_OUTPUT_UNPARSEABLE, 'JSON 解析失败。', stage);
  }
  if (!isPlainObject(parsed)) {
    fail(ERR.CLI_OUTPUT_UNPARSEABLE, 'JSON 根不是对象。', stage);
  }
  // 平台错误对象：即使退出码为0也不当作成功
  if (parsed.Error !== undefined || parsed.Code !== undefined) {
    fail(ERR.PLATFORM_ERROR_OBJECT, '响应是平台错误对象，不作为成功结果。', stage);
  }
  // CLI 的 `outputJson` 会加一层 { data: <result> }
  const payload = Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed;
  if (!isPlainObject(payload)) {
    fail(ERR.CLI_OUTPUT_UNPARSEABLE, '结果载荷不是对象。', stage);
  }
  if (payload.Error !== undefined || payload.Code !== undefined) {
    fail(ERR.PLATFORM_ERROR_OBJECT, '响应是平台错误对象，不作为成功结果。', stage);
  }
  return payload;
}

/* ── 字段校验与关联（L2） ──────────────────────────────────────────── */

/** 身份值摘要：AccountId 与 Uin 使用**同算法、同字节输入**。 */
function digestOf(crypto, value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** 尾号：仅末 4 位。 */
function tailOf(value) {
  const s = String(value);
  return s.length <= 4 ? s : s.slice(-4);
}

/**十进制正整数字符串：仅数字组成、长度 ≥ 1，且不全为 0（值为正整数）。 */
const DECIMAL_POSITIVE_INTEGER = /^[0-9]+$/;

/**
 * C1：环境归属 `Uin` 的**窄**类型适配 —— 只接受平台已实测的两种形态。
 *
 * 背景：真实只读执行中`EnvInfo.UserInfo.Uin` 实测为 `number`（且
 * `Number.isSafeInteger` 为 true），而此前`text()` 只接受非空字符串，导致整组
 * 在 `describeEnvInfo` 以`ENV_INFO_FIELD_INVALID` 停止。原任务「未核验类型不猜测
 * 转换」在无实测证据时停止是正确的；现在有了真实响应证据，故补一条**明确且窄**的
 * 契约，而不是把校验整体放宽。
 *
 * 允许规则（除此之外一律拒绝）：
 *   1. **十进制正整数字符串**：保留**原始字节**。不 trim、不去前导零、不作数值化。
 *      因此 `"00123"` 的摘要输入仍是 `"00123"`，不会与 `"123"` 匹配。
 *   2. **number**：仅接受有限、正数且 `Number.isSafeInteger` 成立的整数，
 *      以 `String(value)` 产生十进制摘要输入。不安全整数 / 小数 / 负数 / 零 /
 *      `NaN` / `Infinity` 全部拒绝。
 *
 * 明确拒绝：`null`、`undefined`、布尔、对象、数组、Symbol、BigInt 及其它类型。
 * 绝不使用任意 `String(value)` 让对象/数组等蒙混过关 —— 那会把 `[object Object]`
 * 之类的字符串当成合法账号摘要输入。
 *
 * 该适配**只用于环境归属 Uin**，不放宽 STS `AccountId`（仍必须是字符串）、
 * 不改`WxAppId` 与地域检查。返回值只用于计算摘要与尾号，原始 Uin 不落入报告。
 *
 * @returns {string} 摘要/尾号的统一字节输入
 */
function normalizeEnvUin(value, stage) {
  if (typeof value === 'string') {
    // 注意：这里刻意**不 trim**，也不去前导零 —— 原始字节即摘要输入
    if (!DECIMAL_POSITIVE_INTEGER.test(value)) {
      fail(ERR.ENV_INFO_FIELD_INVALID,
        '环境归属账号字段不是十进制正整数字符串：Uin', stage);
    }
    // 全为 0（如 "0" / "000"）表示零，不是正整数
    if (/^0+$/.test(value)) {
      fail(ERR.ENV_INFO_FIELD_INVALID,
        '环境归属账号字段不是正整数：Uin', stage);
    }
    return value;
  }
  if (typeof value === 'number') {
    // C1：仅接受有限、正数、安全整数。Number.isSafeInteger 已排除 NaN/±Infinity/小数，
    // 但仍需单独确认有限性与正数语义，避免依赖隐式转换。
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
      fail(ERR.ENV_INFO_FIELD_INVALID,
        '环境归属账号数值不是有限正安全整数：Uin', stage);
    }
    return String(value);
  }
  // 其余类型（含 null/undefined/布尔/对象/数组/Symbol/BigInt）一律拒绝
  fail(ERR.ENV_INFO_FIELD_INVALID,
    '环境归属账号字段类型不符：Uin', stage);
}

function assertSts(payload, crypto, stage) {
  if (payload.Type !== FIXED.acceptedStsType) {
    // 未核验的身份类型**不猜测转换**
    fail(ERR.STS_TYPE_UNVERIFIED, '调用者身份类型不是本轮已核验的类型。', stage);
  }
  const required = ['AccountId', 'UserId', 'PrincipalId', 'RequestId'];
  for (const key of required) {
    if (!text(payload[key])) {
      fail(ERR.STS_FIELD_INVALID, `调用者身份字段缺失或类型不符：${key}`, stage);
    }
  }
  if (!text(payload.Arn)) {
    fail(ERR.STS_FIELD_INVALID, '调用者身份字段缺失或类型不符：Arn', stage);
  }
  return {
    type: payload.Type,
    accountIdSha256: digestOf(crypto, payload.AccountId),
    accountIdTail: tailOf(payload.AccountId),
    userIdTail: tailOf(payload.UserId),
    principalIdTail: tailOf(payload.PrincipalId),
    requestId: payload.RequestId
    // 完整 AccountId / UserId / PrincipalId / Arn **不落入公开报告**
  };
}

function assertDescribeEnvs(payload, stage) {
  const list = payload.EnvList;
  if (!Array.isArray(list)) {
    fail(ERR.ENVS_FIELD_INVALID, '环境列表字段缺失或类型不符。', stage);
  }
  // 恰好一条：重复或额外环境一律停止
  if (list.length !== 1) {
    fail(ERR.ENVS_NOT_SINGLE, '目标环境不是唯一一条，拒绝。', stage);
  }
  const env = list[0];
  if (!isPlainObject(env)) {
    fail(ERR.ENVS_FIELD_INVALID, '环境记录不是对象。', stage);
  }
  if (env.EnvId !== FIXED.envId) {
    fail(ERR.ENVS_FIELD_MISMATCH, '环境 ID 与固定值不精确匹配。', stage);
  }
  if (env.Status !== 'NORMAL') {
    fail(ERR.ENVS_FIELD_MISMATCH, '环境状态不是 NORMAL。', stage);
  }
  if (env.Region !== FIXED.region) {
    fail(ERR.ENVS_FIELD_MISMATCH, '环境地域与固定值不匹配。', stage);
  }
  return { envId: env.EnvId, status: env.Status, region: env.Region, requestId: text(payload.RequestId) ? payload.RequestId : null };
}

function assertDescribeEnvInfo(payload, stsAccountDigest, crypto, stage) {
  const info = payload.EnvInfo;
  if (!isPlainObject(info)) {
    fail(ERR.ENV_INFO_FIELD_INVALID, '环境详情字段缺失或类型不符。', stage);
  }
  const base = info.EnvBaseInfo;
  if (!isPlainObject(base)) {
    fail(ERR.ENV_INFO_FIELD_INVALID, '环境基础信息缺失或类型不符。', stage);
  }
  if (base.EnvId !== FIXED.envId) fail(ERR.ENVS_FIELD_MISMATCH, '环境详情的 EnvId 不匹配。', stage);
  if (base.Status !== 'NORMAL') fail(ERR.ENVS_FIELD_MISMATCH, '环境详情的状态不是 NORMAL。', stage);
  if (base.Region !== FIXED.region) fail(ERR.ENVS_FIELD_MISMATCH, '环境详情的地域不匹配。', stage);

  const user = info.UserInfo;
  if (!isPlainObject(user)) {
    fail(ERR.ENV_INFO_FIELD_INVALID, '环境归属用户信息缺失或类型不符。', stage);
  }
  // C1：Uin 允许「十进制正整数字符串」或「有限正安全整数number」两种已实测形态，
  // 其余类型/数值一律拒绝。规范化结果只用于摘要与尾号，原始 Uin 不落入报告。
  const uinInput = normalizeEnvUin(user.Uin, stage);
  // 精确比较：同算法、同字节输入的摘要
  const uinDigest = digestOf(crypto, uinInput);
  if (uinDigest !== stsAccountDigest) {
    fail(ERR.ACCOUNT_MISMATCH, '环境归属账号与调用者账号不一致。', stage);
  }
  // 只用 WxAppId 校验微信 AppID；**不能用数字型 AppId 替代**
  if (user.WxAppId !== FIXED.wxAppId) {
    fail(ERR.WX_APP_ID_MISMATCH, '环境的微信 AppID 与固定值不匹配。', stage);
  }
  return {
    envId: base.EnvId,
    status: base.Status,
    region: base.Region,
    uinSha256: uinDigest,
    uinTail: tailOf(uinInput),
    wxAppId: user.WxAppId,
    requestId: text(payload.RequestId) ? payload.RequestId : null
  };
}

/* ── 子进程执行（L1） ──────────────────────────────────────────────── */

function buildStageArgs(stage, fixed) {
  const F = fixed || FIXED;
  const args = ['api', stage.service, stage.action, '--api-version', stage.apiVersion];
  if (stage.body !== null) args.push('--body', stage.body);
  args.push(...stage.envArgs, '-r', F.region, '--json');
  return args;
}

/**
 * 执行一条查询。**原始 stdout/stderr 只在受限内存处理**：
 * 不打印、不落库、不作为异常 cause 拼入结果。
 *
 * R4 返修：返回净化后的**执行诊断**（退出码 / 是否超时 / 终止请求与确认 / 输出字节），
 * 解析错误绑定当前 stage；失败时把净化诊断挂到 ObserverError 上，供上层如实记录
 * 「API 子进程已尝试」这一事实。
 *
 * @returns {Promise<{payload: object, diag: object}>}
 */
async function runStage(stage, deps) {
  const d = deps;
  const F = d.__fixed || FIXED;
  const args = buildStageArgs(stage, F);
  const startedAt = new Date().toISOString();
  const r = await spawnBounded(F.nodeBin, [F.cliEntry, ...args], {
    cwd: F.authSessionDir,
    env: buildChildEnv(d.baseEnv || process.env, F),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }, d);

  // 只含本层固定字段的净化诊断：不透传原始 stdout/stderr 或不可信文本
  const diag = {
    stage: stage.key,
    service: stage.service,
    action: stage.action,
    startedAt,
    finishedAt: null,
    spawnAttempted: true,
    exitCode: r.code,
    signal: r.signal,
    timedOut: r.timedOut,
    overflow: r.overflow,
    terminationRequested: r.terminationRequested,
    processExited: r.processExited,
    terminationConfirmed: r.terminationConfirmed,
    closeNotObserved: r.closeNotObserved,
    retainedBytes: r.retainedBytes,
    totalOutputBytes: r.totalBytes
  };

  if (r.spawnError) {
    fail(ERR.SPAWN_FAILED, '查询子进程启动失败。', stage.key, diag);
  }
  if (r.overflow) {
    fail(ERR.SPAWN_OUTPUT_LIMIT, '查询输出超出合并上限，已停止且未重试。', stage.key, diag);
  }
  if (r.timedOut) {
    // 措辞与事实一致：只说明请求过终止，不声称进程已退出
    fail(ERR.SPAWN_TIMEOUT, '查询子进程超时，已请求终止且未重试。', stage.key, diag);
  }
  if (r.signal) {
    fail(ERR.SPAWN_SIGNALLED, '查询子进程被信号终止。', stage.key, diag);
  }
  // S1：观察到 exit 但 stdout/stderr 未确认读完（close 未到），输出可能不完整，
  // **不得**当作成功结果继续解析。
  if (r.closeNotObserved) {
    fail(ERR.SPAWN_CLOSE_UNCONFIRMED, '查询子进程已退出但输出未确认读完，已按失败处理且未重试。', stage.key, diag);
  }
  if (r.code !== 0) {
    // 只暴露退出码，不透传不可信 stderr 文本
    fail(ERR.CLI_NONZERO_EXIT, '查询子进程退出码非零。', stage.key, diag);
  }
  diag.finishedAt = new Date().toISOString();
  // R3/R4：解析失败也绑定当前 stage，并**带上已发生的执行事实**（子进程确实已启动并退出）
  try {
    const payload = parseCliJson(r.stdout, stage.service, stage.action, stage.key);
    return { payload, diag };
  } catch (error) {
    if (error instanceof ObserverError) error.diag = diag;
    throw error;
  }
}

/* ── 结果投影（L2：只输出白名单字段） ──────────────────────────────── */

function baseReport(mode) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    complete: false,
    status: STATUS.FAILED,
    stoppedAt: null,
    errorCode: null,
    observedAt: null,
    // R4：三个语义分明的只读事实，任何一个都不代表授权或平台已处理
    cloudQueryAttempted: false,
    cloudResponseValidated: false,
    cloudObservationPerformed: false,
    callerIdentity: null,
    describeEnvs: null,
    describeEnvInfo: null,
    associationMatched: false,
    writeAuthorized: false,
    productionCallerVerifierImplemented: false,
    isAuthorizationMechanism: false,
    stageExecutions: null
  };
}

/**
 * 默认本地检查（**不执行任何云调用**）。
 * @returns {Promise<object>} 净化后的结果
 */
async function runLocalCheck(deps) {
  const readiness = await checkLocalReadiness(deps);
  const report = baseReport('local-check');
  report.status = readiness.ok ? STATUS.LOCAL_READY : STATUS.LOCAL_NOT_READY;
  report.complete = true;
  report.observedAt = new Date().toISOString();
  if (!readiness.ok) {
    report.errorCode = 'LOCAL_PRECONDITION_NOT_MET';
    report.stoppedAt = 'local-precondition';
  }
  report.localChecks = readiness.checks;
  // 默认检查从不声称登录有效，也从未尝试任何云查询
  report.cloudQueryAttempted = false;
  report.cloudResponseValidated = false;
  report.cloudObservationPerformed = false;
  report.stageExecutions = [];
  report.notes = '仅核对本机非敏感安装元数据与源码哈希；未启动任何云命令，未读取认证内容，未确认登录有效性。';
  return report;
}

/**
 * 三项只读观测（**仅在显式 `--read-only` 且本地准备条件通过时**执行）。
 * 顺序执行；前一步不合格立即停止，不重试。
 *
 * R4 返修的语义（重要）：
 *   - `cloudQueryAttempted`：是否**已尝试**启动过至少一个 API 子进程；
 *   - `cloudResponseValidated`：是否**取得并通过**了校验的响应；
 *   - `cloudObservationPerformed`：保留字段，语义明确为「已尝试且至少一个阶段校验通过」。
 *   三者都**不表示**网络请求已到达平台，也不表示任何授权。
 *   逐阶段保留开始/完成时间、退出码与终止确认；未发送的阶段标为 `not-executed`。
 *
 * @returns {Promise<object>} 净化后的结果
 */
async function runReadOnlyObservation(deps) {
  const d = Object.assign(defaultDeps(), deps || {});
  const F = resolveFixed(deps);
  d.__fixed = F;
  d.__limits = resolveLimits(deps);
  const report = baseReport('read-only');
  const startedAt = new Date().toISOString();
  const stageRecords = STAGES.map(s => ({
    stage: s.key,
    status: 'not-executed',
    startedAt: null,
    finishedAt: null,
    validationPassed: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    terminationRequested: false,
    terminationConfirmed: false,
    closeNotObserved: false,
    errorCode: null
  }));

  const readiness = await checkLocalReadiness(d);
  if (!readiness.ok) {
    report.errorCode = 'LOCAL_PRECONDITION_NOT_MET';
    report.stoppedAt = 'local-precondition';
    report.localChecks = readiness.checks;
    report.stageExecutions = stageRecords;
    report.notes = '本机固定载体缺失或不符，已在启动任何云命令前停止；未自动下载、修复或换版本。';
    return report;
  }

  let validatedAny = false;
  let attemptedAny = false;
  const runOne = async (index, validate) => {
    const stage = STAGES[index];
    const rec = stageRecords[index];
    // R4：无论成功失败，都记录「已尝试」这一事实
    attemptedAny = true;
    rec.status = 'attempted';
    const started = await runStage(stage, d);
    rec.startedAt = started.diag.startedAt;
    rec.finishedAt = started.diag.finishedAt;
    rec.exitCode = started.diag.exitCode;
    rec.signal = started.diag.signal;
    rec.timedOut = started.diag.timedOut;
    rec.terminationRequested = started.diag.terminationRequested;
    rec.terminationConfirmed = started.diag.terminationConfirmed;
    rec.closeNotObserved = started.diag.closeNotObserved;
    rec.status = 'responded';
    const projected = validate(started.payload);
    rec.validationPassed = true;
    rec.status = 'validated';
    validatedAny = true;
    return projected;
  };

  try {
    report.callerIdentity = await runOne(0, payload => assertSts(payload, d.crypto, STAGES[0].key));
    report.describeEnvs = await runOne(1, payload => assertDescribeEnvs(payload, STAGES[1].key));
    report.describeEnvInfo = await runOne(2, payload =>
      assertDescribeEnvInfo(payload, report.callerIdentity.accountIdSha256, d.crypto, STAGES[2].key));

    report.associationMatched = true;
    report.complete = true;
    report.status = STATUS.ASSOCIATION_OBSERVED;
    report.observedAt = new Date().toISOString();
    report.startedAt = startedAt;
  } catch (error) {
    const known = error instanceof ObserverError;
    report.errorCode = known ? error.code : 'UNEXPECTED_FAILURE';
    report.stoppedAt = known && error.stage ? error.stage : 'unknown';
    report.complete = false;
    report.status = STATUS.FAILED;
    report.observedAt = new Date().toISOString();
    report.startedAt = startedAt;
    // R4：把净化诊断落到对应阶段；后续未发送的阶段保持 not-executed
    if (known && error.stage) {
      const idx = STAGES.findIndex(s => s.key === error.stage);
      const rec = stageRecords[idx];
      if (rec) {
        rec.status = 'failed';
        rec.errorCode = error.code;
        if (error.diag) {
          rec.startedAt = error.diag.startedAt;
          rec.finishedAt = error.diag.finishedAt || new Date().toISOString();
          rec.exitCode = error.diag.exitCode;
          rec.signal = error.diag.signal;
          rec.timedOut = error.diag.timedOut;
          rec.terminationRequested = error.diag.terminationRequested;
          rec.terminationConfirmed = error.diag.terminationConfirmed;
          rec.closeNotObserved = error.diag.closeNotObserved;
        }
      }
    }
    // 不透传不可信错误文本：只保留本层固定文案
    report.errorCategory = known ? 'OBSERVER_REJECTED' : 'UNEXPECTED';
  }

  report.stageExecutions = stageRecords;
  // R4：三个语义分明的布尔事实
  report.cloudQueryAttempted = attemptedAny;
  report.cloudResponseValidated = validatedAny;
  report.cloudObservationPerformed = validatedAny;
  report.notes = [
    '本工具只做只读观测：所有分支 writeAuthorized=false，未生成初始化计划、approval 或人员允许名单。',
    'cloudQueryAttempted 只表示已尝试启动查询进程，不表示网络请求已到达平台；逐阶段 exitCode/超时/终止确认见 stageExecutions。',
    '同一登录目录不证明三次调用使用同一份未刷新的临时凭据；本工具也未完成数据库 SDK 的同凭据核验。',
    '身份摘要仅供内部关联核对，不是签名，也不是授权证书。'
  ].join('');
  return report;
}

module.exports = Object.freeze({
  FIXED,
  LIMITS,
  STAGES,
  STATUS,
  ERR,
  SCHEMA_VERSION,
  ObserverError,
  parseObserverArgs,
  checkLocalReadiness,
  spawnBounded,
  resolveLimits,
  buildChildEnv,
  buildStageArgs,
  parseCliJson,
  stripAnsi,
  assertSts,
  assertDescribeEnvs,
  assertDescribeEnvInfo,
  digestOf,
  tailOf,
  normalizeEnvUin,
  runLocalCheck,
  runReadOnlyObservation
});