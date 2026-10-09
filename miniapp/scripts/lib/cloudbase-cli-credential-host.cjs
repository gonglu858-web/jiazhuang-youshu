'use strict';
/**
 * 固定临时凭据获取宿主（H2）
 * =====================================================
 *
 * 职责：**仅**封装固定公共 CLI 的 `secrets get --json` 调用 —— 启动、私有有界输出、
 * 净化诊断与严格解析。刻意**不**做：
 * - 不提供任意命令 / 路径 / 环境 / 凭据参数；
 * - 不自建第二套进程生命周期控制（复用已验收的 `spawnBounded`）；
 * - 不迁移、不删除、不修复官方登录缓存；
 * - 不实现刷新器，也不获取第二份凭据；
 * - 不发起登录、不打开浏览器、不初始化、不建资源。
 *
 * 固定命令（源码核对结论，见 docs/证据/CodexSecretsGet离线契约审查-20261008.json）
 * ------------------------------------------------------------------
 *   node <FIXED.cliEntry> secrets get --json
 * `secrets get` 的 JSON 输出被 `outputJson` 包一层 `{ "data": {...} }`，
 * 内含 `secretId/secretKey/token/expiredAt/isTemporary/envId`。
 * `envId` 来自命令的环境参数，**不是**平台证明凭据属于该环境 —— 因此
 * **获取阶段不传 `--env`**，也不把回显 envId 当作归属凭据。
 *
 * `isTemporaryCredential(cred)` 的实现是 `Boolean(cred.refreshToken)` ——
 * 仅注入三项环境变量**无法**让该命令判定为临时凭据；必须存在网页登录态缓存。
 * 因此本宿主固定指向既有登录 profile（只让官方CLI 自己读，我们不读内容）。
 *
 * 已知附加行为（离线审查实测，见审查证据 additionalBehaviors）
 * ------------------------------------------------------------------
 * 1. 一次命令启动 ≠ 内部仅一次请求：会先发 `tcb.CheckTcbService` 自动服务检查，
 *    再由 `checkAuth` 发 `DescribeEnvs`；过期可刷新时还会 POST `tcb_refresh`。
 * 2. refresh 成功后官方 CLI 会**写回自己的登录缓存**。真实运行前不得假定
 *    「官方 CLI 获取过程不刷新缓存」。
 * 3. 固定 bundle 有两份配置目录推导，其中一份**忽略** `XDG_CONFIG_HOME`，
 *    只认 `os.homedir()` —— 因此 `USERPROFILE`/`HOME` 必须一并指向目标 profile。
 *
 * 执行边界（务必如实理解）
 * ------------------------------------------------------------------
 * - 本模块**没有**实现请求级拦截能力。离线审查夹具证明的是「在 Node 运行时
 *   拦截下」的行为；生产宿主只控制：**固定命令、固定指纹、固定环境、有界收尾、
 *   严格解析**。它**不能**称未知请求已被技术阻断。
 * - 仍未知的实际执行分支（例如 refresh 成功后的缓存写回、其它未核对网络目标）
 *   列为真实运行阻断项，见交付记录的阻断缺口。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 复用已验收 CLI 观测器的进程控制与解析能力（不改其实现、不复制计时框架）
const cliObserver = require('./cloudbase-readonly-observer.cjs');

/** 固定安装指纹：获取前必须核对，不符即拒绝（不尝试修复、不重装）。 */
const FINGERPRINT = Object.freeze({
  entrySha256: '328da4af4726c2aa4b20cf9b2e1a3614e4f22bf2e8fb8cb6d601692180de926b',
  bundleSha256: '8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97'
});

/** 固定命令参数。**不接受调用方拼接或追加任何参数。 */
const COMMAND_ARGS = Object.freeze(['secrets', 'get', '--json']);

/** S2：本宿主真实启动凭据命令时的模式标识（与编排层枚举一致）。 */
const FETCH_MODE_REAL = 'REAL_CANDIDATE';

/**
 * 本工具唯一允许的环境。取自已验收的 CLI 观测器 `FIXED`，不重复定义 ——
 * 避免两处漂移。凭据命令虽不传 `--env`，但其输出会回显所选环境，
 * 因此用它做白名单校验（见 `parseSecretsJson`）。
 */
const FIXED_ENV_ID = cliObserver.FIXED.envId;

const ERR = Object.freeze({
  FINGERPRINT_MISMATCH: 'FINGERPRINT_MISMATCH',
  FIXED_PATH_MISSING: 'FIXED_PATH_MISSING',
  SPAWN_FAILED: 'SPAWN_FAILED',
  TIMEOUT: 'CREDENTIAL_COMMAND_TIMEOUT',
  OVERFLOW: 'CREDENTIAL_COMMAND_OVERFLOW',
  CLOSE_NOT_OBSERVED: 'CREDENTIAL_COMMAND_CLOSE_NOT_OBSERVED',
  NONZERO_EXIT: 'CREDENTIAL_COMMAND_NONZERO_EXIT',
  SIGNALED: 'CREDENTIAL_COMMAND_SIGNALED',
  TERMINATION_UNCONFIRMED: 'CREDENTIAL_COMMAND_TERMINATION_UNCONFIRMED',
  OUTPUT_UNPARSEABLE: 'CREDENTIAL_OUTPUT_UNPARSEABLE',
  SHAPE_INVALID: 'CREDENTIAL_SHAPE_INVALID',
  NOT_TEMPORARY: 'CREDENTIAL_NOT_TEMPORARY',
  EXPIRY_UNKNOWN: 'CREDENTIAL_EXPIRY_UNKNOWN',
  EXPIRED: 'CREDENTIAL_EXPIRED',
  ENV_ID_UNEXPECTED: 'CREDENTIAL_ENV_ID_UNEXPECTED',
  // R2：获取专用 cwd 的隔离失败（均在启动凭据命令**之前**停止）
  FETCH_CWD_CREATE_FAILED: 'CREDENTIAL_FETCH_CWD_CREATE_FAILED',
  FETCH_CWD_DISCOVERY_UNSAFE: 'CREDENTIAL_FETCH_CWD_DISCOVERY_UNSAFE'
});

/** 起点门槛：至少剩余 5 分钟。这是**本轮起点要求**，不是对平台有效时长的承诺。 */
const MIN_REMAINING_MS = 5 * 60 * 1000;

/** 沿用已验收限制；`deps.limits` 仅供模块测试离线触发超时/超限。 */
const LIMITS = Object.freeze({
  timeoutMs: 55000,
  maxOutputBytes: 1024 * 1024,
  closeGraceMs: 2000
});

class CredentialHostError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CredentialHostError';
    this.code = code;
    this.detail = detail || null;
  }
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 核对固定安装指纹。
 * 不读取登录内容、不修改安装文件；不符即拒绝。
 */
function verifyFingerprint(fixed) {
  const F = fixed || {};
  const entry = F.cliEntry;
  const bundle = F.cliBundle;
  if (!entry || !bundle) {
    throw new CredentialHostError(ERR.FIXED_PATH_MISSING, '固定 CLI 路径缺失。');
  }
  for (const [p, label] of [[entry, '入口'], [bundle, 'bundle']]) {
    if (!fs.existsSync(p)) {
      throw new CredentialHostError(ERR.FIXED_PATH_MISSING, `固定 CLI ${label}不存在：${p}`);
    }
  }
  const entrySha = sha256Of(entry);
  const bundleSha = sha256Of(bundle);
  if (entrySha !== FINGERPRINT.entrySha256 || bundleSha !== FINGERPRINT.bundleSha256) {
    throw new CredentialHostError(ERR.FINGERPRINT_MISMATCH,
      '固定安装指纹与本轮核对值不一致，拒绝获取凭据。',
      { entrySha256: entrySha, bundleSha256: bundleSha });
  }
  return { entrySha256: entrySha, bundleSha256: bundleSha, verified: true };
}

/**
 * 构造获取阶段的子进程环境。
 *
 * 与后续身份关联阶段的隔离环境**分开**：获取阶段指向官方既有登录 profile，
 * 后续阶段用另一套全新、空认证状态的隔离 profile（由 observer 负责）。
 *
 * 大小写无关地清除身份覆盖、XDG 全家、Node 注入与**所有代理变量**；
 * `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA` 指向同一 profile，
 * 避免出现两个身份源（固定 bundle 里有一份配置目录推导只认 `os.homedir()`）。
 *
 * @param {object} baseEnv 宿主环境（只作为「要清除」的来源）
 * @param {string} profile 官方既有登录 profile 目录
 * @param {string} cwd无项目配置的干净 cwd
 */
function buildFetchEnv(baseEnv, profile, cwd) {
  const out = {};
  const dropPrefixes = ['CLOUDBASE_', 'TCB_', 'TENCENTCLOUD_', 'XDG_', 'CLOUD_', 'TCBUI_'];
  const dropExact = new Set([
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_REPL_EXTERNAL_MODULES',
    // 代理整族：获取阶段不继承任何代理指向
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'no_proxy',
    // CloudBase 自身的其它开关
    'TCB_IS_INTL'
  ]);
  for (const [key, value] of Object.entries(baseEnv || {})) {
    const upper = key.toUpperCase();
    if (dropPrefixes.some(p => upper.startsWith(p))) continue;
    if (dropExact.has(upper)) continue;
    out[key] = value;
  }
  // 先删光同名**所有大小写别名**，再写规范大写形式
  for (const key of Object.keys(out)) {
    const upper = key.toUpperCase();
    if (upper === 'USERPROFILE' || upper === 'HOME' || upper === 'APPDATA' ||
      upper === 'LOCALAPPDATA' || upper === 'HOMEDRIVE' || upper === 'HOMEPATH') {
      delete out[key];
    }
  }
  out.USERPROFILE = profile;
  out.HOME = profile;
  out.APPDATA = path.join(profile, 'AppData', 'Roaming');
  out.LOCALAPPDATA = path.join(profile, 'AppData', 'Local');
  // XDG 一并显式清空（另一份推导认它，设空等价于不指定）
  for (const key of Object.keys(out)) {
    if (key.toUpperCase().startsWith('XDG_')) delete out[key];
  }
  out.TCB_REGION = 'ap-shanghai';
  out.CI = '1';
  // 显式关闭遥测（固定 bundle 中确有该分支）
  out.TCB_DISABLE_REPORT = '1';
  out.NO_UPDATE_NOTIFIER = '1';
  return out;
}

/**
 * 严格解析 `secrets get --json` 的输出。
 *
 * 接受：`{ "data": {...} }` 包装（`outputJson` 的实际形状）或裸对象。
 * 严格要求：三字段非空字符串、`isTemporary` **严格 true**、合法**未来** `expiredAt`
 * 且起点剩余 ≥ 门槛；`expiredAt` 若是固定源码里的 `'未知'` 兜底字面量，
 * 按「无法解析到期时间」拒绝（**不得**为通过而放宽）。
 * 拒绝多根、截断、永久密钥、无效日期与缺字段。
 *
 * **不收集 refreshToken**，不返回原始输出。
 *
 * @returns {{secretId:string, secretKey:string, token:string,
 *            expiresAtMs:number, expiresAtIso:string, isTemporary:true}}
 */
function parseSecretsJson(stdout, nowMs, minRemainingMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const minRemain = typeof minRemainingMs === 'number' ? minRemainingMs : MIN_REMAINING_MS;
  const raw = typeof stdout === 'string' ? stdout.trim() : '';
  if (!raw) throw new CredentialHostError(ERR.OUTPUT_UNPARSEABLE, '凭据命令输出为空。');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new CredentialHostError(ERR.OUTPUT_UNPARSEABLE, '凭据命令输出不是合法 JSON。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialHostError(ERR.SHAPE_INVALID, '凭据命令输出不是对象。');
  }
  // `outputJson` 包一层 data；同时兼容裸对象
  const payload = (Object.prototype.hasOwnProperty.call(parsed, 'data') &&
    parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data))
    ? parsed.data
    : parsed;

  for (const key of ['secretId', 'secretKey', 'token']) {
    const v = payload[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new CredentialHostError(ERR.SHAPE_INVALID, `凭据字段缺失或类型不符：${key}`);
    }
  }
  // isTemporary 必须**严格**为 true
  if (payload.isTemporary !== true) {
    throw new CredentialHostError(ERR.NOT_TEMPORARY, '凭据不是严格意义上的临时凭据（不接受长期密钥）。');
  }
  /**
   * `envId` 只是命令所选环境的回显，**不是**归属证明（固定源码：
   * `envId: envId || null`）。本宿主是固定环境工具，不接受任意环境选择，
   * 因此只允许「未回显」或「正好等于本工具固定环境」两种取值 ——
   * 出现第三个值说明命令实际选中了别的环境，属来源异常，如实停止而不放行。
   */
  const echoedEnvId = typeof payload.envId === 'string' ? payload.envId : null;
  if (echoedEnvId !== null && echoedEnvId !== FIXED_ENV_ID) {
    throw new CredentialHostError(ERR.ENV_ID_UNEXPECTED,
      '凭据命令回显了非固定环境，与本工具的固定环境不一致，已停止。');
  }

  const expiryRaw = payload.expiredAt;
  if (typeof expiryRaw !== 'string' || expiryRaw.trim().length === 0) {
    throw new CredentialHostError(ERR.EXPIRY_UNKNOWN, '凭据缺少到期时间。');
  }
  // 固定源码里 formatExpiredAt 的兜底字面量是中文「未知」
  if (expiryRaw.trim() === '未知') {
    throw new CredentialHostError(ERR.EXPIRY_UNKNOWN, '凭据到期时间为未知，无法核实有效期。');
  }
  const expiryMs = Date.parse(expiryRaw);
  if (!Number.isFinite(expiryMs)) {
    throw new CredentialHostError(ERR.EXPIRY_UNKNOWN, '凭据到期时间无法解析。');
  }
  if (expiryMs <= now) {
    throw new CredentialHostError(ERR.EXPIRED, '凭据已过期。');
  }
  if (expiryMs - now < minRemain) {
    throw new CredentialHostError(ERR.EXPIRED, '凭据剩余有效期不足本轮起点门槛。');
  }
  return {
    secretId: payload.secretId,
    secretKey: payload.secretKey,
    token: payload.token,
    // 统一字段名：token → token（由调用方映射为 SDK 的 sessionToken）
    expiresAtMs: expiryMs,
    expiresAtIso: new Date(expiryMs).toISOString(),
    isTemporary: true,
    /** 如实记录 CLI 回显的 envId（可能为 null）；**不作为凭据归属证明**。 */
    echoedEnvId
  };
}

/**
 * 执行一次固定凭据获取命令。
 *
 * 流程：核对固定指纹 → 构造环境 → `spawnBounded` 有界执行 → 先判退出事实、
 * **再**解析。超限 / 超时 / 非零退出 / 信号 / close 未确认 / 终止未确认，
 * 一律**在解析成功之前**拒绝，且**不自动重试**。
 *
 * 原始 stdout/stderr 只在 `spawnBounded` 的私有有界内存中流转，
 * **不**继承到终端、**不**重定向到文件、**不**放进 Error/message/stack/cause。
 * 对外只返回解析后的快照与**重建的固定诊断字段**。
 *
 * @param {object} options.deps  注入点（仅测试）：spawn / now / fixed / limits
 * @returns {Promise<{snapshot:object, diagnostics:object}>}
 */
async function fetchTemporaryCredential(options) {
  const opts = options || {};
  const d = opts.deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const spawnFn = d.spawn || require('node:child_process').spawn;
  const F = Object.assign({}, cliObserver.FIXED, d.fixed || {});

  // 1) 固定安装指纹
  const fingerprint = verifyFingerprint(F);

  // 2) 目录用途**严格分离**
  //    - profile：官方既有登录 profile，**只**作为认证来源，并作为发现范围的
  //      Home 停止点（这正是将传给 CLI 的 USERPROFILE/HOME）；
  //    - cwd：获取专用**全新**目录，不得回退 profile 或项目根。
  //    固定源码事实（`findProjectRoot`）：从 cwd 逐级向上找
  //    `cloudbaserc.json` / `cloudbaserc.js` / `.cloudbaserc` / `.git`，
  //    **不越过 Home 目录**，找不到时兜底用 cwd 本身；起点先经`canonicalizePath`
  //    （优先 `realpathSync`）。项目根决定项目级 auth 的落点，而项目级 API Key
  //    的优先级高于 authStore —— 因此只看「叶子目录为空」不够。
  const profile = (d.fixed && d.fixed.authProfileDir) || F.authSessionDir;
  if (!profile) {
    throw new CredentialHostError(ERR.FIXED_PATH_MISSING, '未提供登录 profile 目录。');
  }
  const cwd = createIsolatedFetchCwd(d, profile);
  // S1：停止点用**实际传给 CLI 的 profile**，不是父进程 Home；
  //  cwd 建在 profile 之内，保证「不越过 Home」是真实边界。
  assertConfigDiscoveryClean(cwd, { cliHome: profile });

  // 我们**只核对路径**，不读取现有 auth.json 内容
  const env = buildFetchEnv(d.baseEnv || process.env, profile, cwd);

  // 3) 有界执行：复用已验收的 spawnBounded（55 秒 / 合计 1 MiB / exit 后 2 秒 close 宽限）
  const r = await cliObserver.spawnBounded(
    F.nodeBin,
    [F.cliEntry, ...COMMAND_ARGS],
    { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    {
      spawn: (bin, argv, options2) => spawnFn(bin, argv, options2),
      __limits: d.limits || LIMITS
    }
  );

  // 4) 先判退出事实（**stdout 自报不能覆盖退出事实**），全部失败均不重试
  const diagnostics = buildFixedDiagnostics(r);
  if (r.spawnError) {
    throw failWithFacts(ERR.SPAWN_FAILED, '凭据命令子进程启动失败。', diagnostics);
  }
  if (r.timedOut) {
    throw failWithFacts(ERR.TIMEOUT, '凭据命令超时。', diagnostics);
  }
  if (r.overflow) {
    throw failWithFacts(ERR.OVERFLOW, '凭据命令输出超限。', diagnostics);
  }
  if (r.closeNotObserved) {
    throw failWithFacts(ERR.CLOSE_NOT_OBSERVED, '凭据命令退出后未观察到 close。', diagnostics);
  }
  if (r.terminationRequested && !r.terminationConfirmed) {
    throw failWithFacts(ERR.TERMINATION_UNCONFIRMED, '凭据命令终止未确认。', diagnostics);
  }
  if (r.signal) {
    throw failWithFacts(ERR.SIGNALED, '凭据命令被信号终止。', diagnostics);
  }
  if (r.code === null || r.code === undefined) {
    throw failWithFacts(ERR.NONZERO_EXIT, '凭据命令退出码未确认。', diagnostics);
  }
  if (r.code !== 0) {
    throw failWithFacts(ERR.NONZERO_EXIT, '凭据命令非零退出。', diagnostics);
  }

  // 5) 退出事实通过后才解析
  //S2：解析失败同样保留**已发生的进程事实**（退出码/计数），否则上层无法区分
  // 「未启动」与「已执行但输出不合规」。
  try {
    const snapshot = parseSecretsJson(r.stdout, now(), MIN_REMAINING_MS);
    return { snapshot, diagnostics, attempted: true, exitFacts: diagnostics };
  } catch (error) {
    // 只把**已重建的固定字段**带出去：错误码白名单化，附加对象不传播。
    error.fetchAttempted = true;
    error.fetchExitFacts = diagnostics;
    error.errorClass = classifyFetchError(error.code);
    error.fetchMode = FETCH_MODE_REAL;
    throw error;
  }
}


/**
 * S2：构造一个**携带进程事实**的失败。
 *
 * 上一版只有 JSON 解析的 catch 会带上 `fetchAttempted`/`fetchExitFacts`，
 * 而超时/溢出/信号/非零/启动失败等分支从 try 外抛出 —— 虽有 `detail`，
 * 但父层只读 `fetchExitFacts`，于是这四种已 spawn 的失败被记成
 * `attempted=false / mode=NONE / diagnostics=null`。
 *
 * 现在统一走这里：**只要已调用 spawnBounded，一律记为已尝试**，
 * 并附上同一套重建过的退出/计数事实；父层仍逐字段投影，不重新透传 detail。
 *
 * @param {string} code宿主固定错误码
 * @param {string} message 固定文案
 * @param {object} facts  由 buildFixedDiagnostics 重建的固定事实
 */
function failWithFacts(code, message, facts) {
  const err = new CredentialHostError(code, message, facts);
  // 已调用 spawnBounded → 确实尝试启动过凭据命令
  err.fetchAttempted = true;
  err.fetchExitFacts = facts || null;
  err.errorClass = classifyFetchError(code);
  err.fetchMode = FETCH_MODE_REAL;
  return err;
}

/**
 * R3：把错误码收敛成**固定分类**供报告使用。
 * 未知码统一为 `OTHER`；不返回任意原始字符串。
 */
function classifyFetchError(code) {
  const known = new Set([
    ERR.SPAWN_FAILED, ERR.TIMEOUT, ERR.OVERFLOW, ERR.CLOSE_NOT_OBSERVED,
    ERR.TERMINATION_UNCONFIRMED, ERR.SIGNALED, ERR.NONZERO_EXIT,
    ERR.OUTPUT_UNPARSEABLE, ERR.SHAPE_INVALID, ERR.NOT_TEMPORARY,
    ERR.EXPIRY_UNKNOWN, ERR.EXPIRED, ERR.ENV_ID_UNEXPECTED,
    ERR.FIXED_PATH_MISSING, ERR.FINGERPRINT_MISMATCH,
    ERR.FETCH_CWD_CREATE_FAILED, ERR.FETCH_CWD_DISCOVERY_UNSAFE
  ]);
  return typeof code === 'string' && known.has(code) ? code : 'OTHER';
}

/**
 * **重建**固定诊断字段。
 * 只保留计数与布尔结论，**不**含 stdout/stderr 原文、路径内容或任何凭据片段。
 * 上层不能把包含原始输出的执行对象序列化。
 */
function buildFixedDiagnostics(r) {
  return {
    exitCode: typeof r.code === 'number' ? r.code : null,
    signal: r.signal || null,
    timedOut: r.timedOut === true,
    overflow: r.overflow === true,
    closeNotObserved: r.closeNotObserved === true,
    terminationRequested: r.terminationRequested === true,
    terminationConfirmed: r.terminationConfirmed === true,
    spawnFailed: Boolean(r.spawnError),
    // 字节数只留计数，不留内容
    stdoutBytes: typeof r.stdout === 'string' ? Buffer.byteLength(r.stdout, 'utf8') : 0,
    stderrBytes: typeof r.stderr === 'string' ? Buffer.byteLength(r.stderr, 'utf8') : 0
  };
}

/** 把快照的 `token` 映射为 SDK 的 `sessionToken`（唯一映射点）。 */
function toSdkCredentialFields(snapshot) {
  return {
    secretId: snapshot.secretId,
    secretKey: snapshot.secretKey,
    // CLI 输出字段是 token；node-sdk 参数名是 sessionToken
    sessionToken: snapshot.token
  };
}

/**
 * 项目根发现标记（固定源码事实：`exports.PROJECT_ROOT_MARKERS`）。
 * 命中任一个即被CLI 当作项目根，其下的项目级 auth 优先级高于 authStore。
 */
const PROJECT_ROOT_MARKERS = Object.freeze([
  'cloudbaserc.json', 'cloudbaserc.js', '.cloudbaserc', '.git'
]);

/**
 * 创建获取专用 cwd（**全新**目录，建在登录 profile **之内**）。
 *
 * S1 要点：
 *  - 不得回退 profile 本身或项目根：`profile` 只作认证来源，cwd 是新建子目录；
 *  - **必须建在 profile 之内**：CLI 的向上发现「不越过 Home」，而 Home 就是
 *    profile。若 cwd 建在别处（如系统临时目录），profile 就不在 cwd 的祖先链上，
 *    「不越过 Home」等于**没有边界** —— 检查会一直走到文件系统根，而 CLI 沿
 *    真实路径仍可能命中更上层的项目配置标记。建在 profile 之内，边界才真正生效；
 *  - 与后续 CLI 关联阶段使用的目录用途不同（那里是编排器新建的隔离目录）；
 *  - 不接受调用方任意传入 cwd 覆盖（不新增 CLI cwd/profile 参数）。
 *
 * @param {object} d        依赖（仅测试可注入 tmpRoot）
 * @param {string} profile  作为 Home 边界的登录 profile
 * @returns {string} 新建目录的绝对路径
 */
function createIsolatedFetchCwd(d, profile) {
  const deps = d || {};
  // 优先建在 profile 之内；仅测试可指定合成 profile 根。
  const base = profile || deps.tmpRoot || os.tmpdir();
  // 用随机名避免与既有目录重名；本工具不删除任何既有目录。
  const name = 'cloudbase-credential-fetch-' + crypto.randomBytes(8).toString('hex');
  const dir = path.join(base, name);
  try {
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new CredentialHostError(ERR.FETCH_CWD_CREATE_FAILED,
      '无法创建凭据获取专用工作目录，已在启动凭据命令前停止。');
  }
  return dir;
}

/**
 * 核对 CLI 的**整个向上配置发现范围**干净。
 *
 * 固定源码事实（`findProjectRoot`）：从 cwd 逐级向上找
 * `cloudbaserc.json` / `cloudbaserc.js` / `.cloudbaserc` / `.git`，
 * **不越过 Home 目录**，找不到时兜底用 cwd 本身；项目根决定项目级 auth 的落点，
 * 而项目级 API Key 的优先级高于 authStore —— 因此只看「叶子目录为空」不够。
 *
 * 发现范围由 cwd 自身决定，所以这里复刻同一向上规则做前置核对：
 * 范围内**任一层**出现 marker 就停止（不读 marker 内容、不删除文件）。
 *
 * @returns {{checked: number, stoppedAt: string|null}}
 */
function assertConfigDiscoveryClean(cwd, options) {
  const opts = options || {};
  // S1-1：停止点必须是**将传给 CLI 的实际 profile/Home**，不是父进程的 Home。
  //  `buildFetchEnv` 会把 USERPROFILE/HOME 指向 profile，因此子进程看到的 Home
  //  与父进程不同；用父进程 Home 会让检查在用户 Home 处停下，而 CLI 仍会继续
  //  向上，可能命中更上层的项目配置标记。
  //  **刻意不回退 `os.homedir()`**：父进程 Home 不是 CLI 的 Home，回退等于退回
  //  上一版的缺陷。未显式给出 profile 时直接停止（范围不确定）。
  if (typeof opts.cliHome !== 'string' || opts.cliHome.length === 0) {
    throw new CredentialHostError(ERR.FETCH_CWD_DISCOVERY_UNSAFE,
      '未提供将传给 CLI 的登录 profile 边界，向上发现范围不确定，已在启动凭据命令前停止。');
  }
  const home = path.resolve(opts.cliHome);
  // S1-1b：若 profile 不是 cwd 的祖先，则「不越过 Home」这个边界**不成立**
  //（CLI 仍会越过它继续向上）。此时范围不确定 → 按要求**启动前停止**，
  // 而不是当作「无边界」照常检查。
  const rel = path.relative(home, path.resolve(cwd));
  const homeIsAncestor = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!homeIsAncestor) {
    throw new CredentialHostError(ERR.FETCH_CWD_DISCOVERY_UNSAFE,
      '凭据获取工作目录不在登录 profile 之内，向上发现范围不确定，已在启动凭据命令前停止。');
  }
  // S1-2：起点用**真实路径**（对齐固定源码的 `canonicalizePath`：优先 realpathSync）。
  //  上一版用 `path.resolve`（纯字面），遇到 junction 时字面祖先干净、
  //  而 CLI 沿真实路径会看到带标记的祖先。
  const resolved = canonicalizePath(cwd);
  let dir = resolved;
  let checked = 0;
  let stoppedAt = null;
  // 与固定源码一致：逐级向上，命中 marker 立即返回；不越过 Home；到根停止。
  for (;;) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      const p = path.join(dir, marker);
      // 只判断**存在性**，不读取内容
      let exists = false;
      try {
        fs.accessSync(p, fs.constants.F_OK);
        exists = true;
      } catch (_) {
        exists = false;
      }
      if (exists) {
        // 该层即项目根；cwd 本身若是 marker 也算命中（兜底会用 cwd）
        stoppedAt = p;
        break;
      }
    }
    if (stoppedAt) break;
    checked++;
    if (dir === home) break;         // 不越过 Home（与源码一致）
    const parent = path.dirname(dir);
    if (parent === dir) break;       // 已到文件系统根
    dir = parent;
  }
  if (stoppedAt) {
    throw new CredentialHostError(ERR.FETCH_CWD_DISCOVERY_UNSAFE,
      '凭据获取工作目录的向上配置发现范围内存在项目配置标记，身份来源不唯一，已在启动凭据命令前停止。');
  }
  return { checked, stoppedAt: null, resolvedFrom: resolved, homeBoundary: home };
}

/**
 * S1-2：与固定 bundle 的 `canonicalizePath` 同策略 ——
 * 优先 `fs.realpathSync`（这正是 junction 被看穿的关键），失败则退回 `path.resolve`。
 */
function canonicalizePath(p) {
  try {
    return path.resolve(fs.realpathSync(p));
  } catch (_) {
    return path.resolve(p);
  }
}

module.exports = Object.freeze({
  FINGERPRINT,
  COMMAND_ARGS,
  MIN_REMAINING_MS,
  LIMITS,
  ERR,
  CredentialHostError,
  verifyFingerprint,
  buildFetchEnv,
  parseSecretsJson,
  fetchTemporaryCredential,
  toSdkCredentialFields,
  buildFixedDiagnostics,
  createIsolatedFetchCwd,
  assertConfigDiscoveryClean,
  PROJECT_ROOT_MARKERS
});
