'use strict';
/**
 * CloudBase数据库 SDK 只读观测编排库（M1/M2/M3）
 * =====================================================
 *
 * 回答两个问题
 * ────────────
 *   1. **M1**：数据库 SDK 使用的云身份是否与本轮 CLI 身份查询**同一批凭据**；
 *   2. **M2**：独立测试副本是否已有主管理员（`primary`），以及**受信指定**的
 *      微信用户记录是否有效。
 *
 * 只做观测，**不授予任何权限**
 * ──────────────────────
 *   - 所有分支 `writeAuthorized = false`；
 *   - `productionCallerVerifierImplemented = false`（**不实现、不替换** P4 `verifyCaller`）；
 *   - 不生成 approval、人员允许名单或初始化计划；CLI 关联匹配**不自动**推导上述任何一项；
 *   - 不调用业务 `identify`/`requestBindingNumber`（可能写库）、`initializePrimary`、
 *     数据库事务/写方法、云函数、原始集合名或任意查询。
 *
 * 与已验收 CLI 观测器的关系
 * ──────────────────────
 * **复用** `cloudbase-readonly-observer.cjs` 已导出的进程收尾（`spawnBounded`）、
 * 解析（`parseCliJson` / `stripAnsi`）与字段核验（`assertSts` 等）能力，
 * **不改其实现或限制、不复制重造一套计时/解析框架**。
 * 但**不复用**它的 `runReadOnlyObservation` 冒充同凭据链 —— 那条路径用的是既有登录目录。
 *
 * 同批凭据（M1）
 * ────────────
 * 1. 一次获取：用既有登录目录调用**一次**官方 `secrets get --json`。stdout/stderr
 *    只进有界内存，**绝不显示、写盘或透传异常**。程序**不直接读 auth.json、不扫描登录缓存**。
 * 2. 严格接受：非空字符串 secretId/secretKey/token、`isTemporary` 严格为 true、
 *    可验证的**未来** expiredAt。未知/缺失有效期、长期密钥、坏 JSON、超限、非零退出 → 停止。
 *    本轮开始门槛：**至少剩余 5 分钟**；每阶段前后各检查一次尚未过期。
 *    这是**本轮门槛，不是对平台有效时长的承诺**。
 * 3. 同一份**内存快照**分别供 CLI 查询与 node-sdk 使用；**获取后不再刷新、不重新获取**。
 *    失效则停止并记录未完成，**不混用新旧结果**。
 *    凭据**不输出摘要、尾号或原值**；只保存随机运行编号与非敏感到期时间。
 *    移除引用**不等于**能保证 JS 内存已物理擦除。
 * 4. CLI 查询使用**本轮新建、无登录记录**的隔离 `USERPROFILE`/`HOME`/`cwd`，
 *    **不使用原登录目录**。不存在性检查只查固定配置/认证文件**位置**，**不读内容**；
 *    发现污染或不能证明隔离即停止，**不删用户文件**。
 *    清除继承的 `CLOUDBASE_*`/`TCB_*`/`TENCENTCLOUD_*`/`NODE_OPTIONS`，
 *    再**仅给该子进程**注入同一份三字段与固定地域；`CI=1`，关闭更新与报告。
 *
 * **认证优先级（源码已核对，非推测）**
 *   `getCredentialData`（bundle 229317）：① 项目级存储 API Key（需 cwd 且 `secretId`+`authSource`）
 *   → ② 全局 `authStore`（`<XDG_CONFIG_HOME|homedir>/.config/.cloudbase/auth.json`）
 *   → ③ `TENCENTCLOUD_*` 环境变量。**环境变量优先级最低**。
 *   而 `xdg-basedir`（模块 46347）的 config = `XDG_CONFIG_HOME || homedir()/.config`，
 *   Windows 下 `os.homedir()` 跟随 `USERPROFILE` → **改写 `USERPROFILE` 确实迁移认证存储位置**。
 *   因此：隔离目录 + 清空登录态 ⇒ 环境变量注入成为**唯一**可用来源。
 *   源码定位与合成路径证据**分别**说明；源码不能替代对真实入口的离线优先级验证。
 *
 * 硬停止点
 * ──────
 * 若无法用合成凭据验证公共 CLI 在干净目录确实选用注入凭据，**或**发现需新增 SDK /
 * 提取内部模块 / 手写签名，则交付具体缺口并停止此路径。
 * **不得**以假的 `verifyCaller` 或 `allowed:true` 继续拼接。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// ── 复用已验收 CLI 观测器的能力（不改其实现、不复制计时/解析框架） ──────────
const cliObserver = require('./cloudbase-readonly-observer.cjs');

/**
 * 固定凭据获取宿主（H2）。
 *
 * 提到模块层而非函数内：本地准备报告要引用 `host.FINGERPRINT` 记录离线
 * 公共入口证明的适用范围，而实际取凭据在另一个函数里 —— 若只在函数内require，
 * 两处作用域互不相通，本地准备会抛 `host is not defined`。
 */
const host = require('./cloudbase-cli-credential-host.cjs');

const FIXED = Object.freeze({
  ...cliObserver.FIXED,
  /** 已取得 SDK 根（本轮）；不用项目依赖、不用全局 PATH 替换 */
  sdkRoot: 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules',
  /** worker 路径（本轮新增，固定） */
  workerPath: 'C:/Users/30591/Documents/ChatGPT/装修进度验收APP/miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs',
  /** 隔离目录前缀：本轮新建、无登录记录 */
  isolationRoot: 'C:/Users/30591/.codex/tmp/cloudbase-sdk-readonly-isolated'
});

/** 沿用已验收限制：每 CLI 子进程 55 秒 / 合并 1 MiB / exit 后 2 秒 close 宽限。 */
const LIMITS = Object.freeze({
  cli: cliObserver.LIMITS,
  worker: Object.freeze({ timeoutMs: 55000, maxOutputBytes: 1024 * 1024 })
});

/** 本轮开始门槛：至少剩余 5 分钟（不是对平台有效时长的承诺）。 */
const MIN_REMAINING_MS = 5 * 60 * 1000;

const SCHEMA_VERSION = 2;

const STATUS = Object.freeze({
  /** 默认本地检查通过（未取凭据、未发起任何云调用）。 */
  LOCAL_READY: 'LOCAL_READY',
  /** 显式只读运行完成，且每层结论均为「已观测」。 */
  OBSERVED: 'OBSERVED',
  /** 有步骤未完成/ 未证实。 */
  INCOMPLETE: 'INCOMPLETE',
  FAILED: 'FAILED'
});

const ERR = Object.freeze({
  // 参数 / 前置
  ARG_UNKNOWN: 'ARG_UNKNOWN',
  ARG_FORBIDDEN: 'ARG_FORBIDDEN',
  TARGET_USER_ID_INVALID: 'TARGET_USER_ID_INVALID',
  // 本地准备
  FIXED_PATH_MISSING: 'FIXED_PATH_MISSING',
  FIXED_HASH_MISMATCH: 'FIXED_HASH_MISMATCH',
  SDK_SOURCE_MISSING: 'SDK_SOURCE_MISSING',
  // 凭据
  CREDENTIAL_FETCH_FAILED: 'CREDENTIAL_FETCH_FAILED',
  CREDENTIAL_SHAPE_INVALID: 'CREDENTIAL_SHAPE_INVALID',
  CREDENTIAL_NOT_TEMPORARY: 'CREDENTIAL_NOT_TEMPORARY',
  CREDENTIAL_EXPIRY_UNKNOWN: 'CREDENTIAL_EXPIRY_UNKNOWN',
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  CREDENTIAL_NOT_YET_VALID: 'CREDENTIAL_NOT_YET_VALID',
  // 隔离
  ISOLATION_DIRTY: 'ISOLATION_DIRTY',
  ISOLATION_UNPROVEN: 'ISOLATION_UNPROVEN',
  // 同批凭据链
  SAME_BATCH_NOT_PROVEN: 'SAME_BATCH_NOT_PROVEN',
  CLI_ASSOCIATION_FAILED: 'CLI_ASSOCIATION_FAILED',
  // worker
  WORKER_FAILED: 'WORKER_FAILED',
  WORKER_OUTPUT_INVALID: 'WORKER_OUTPUT_INVALID',
  WORKER_TIMEOUT: 'WORKER_TIMEOUT',
  WORKER_OVERFLOW: 'WORKER_OVERFLOW',
  WORKER_TERMINATION_UNCONFIRMED: 'WORKER_TERMINATION_UNCONFIRMED',
  WORKER_EXIT_UNCONFIRMED: 'WORKER_EXIT_UNCONFIRMED',
  WORKER_NONZERO_EXIT: 'WORKER_NONZERO_EXIT',
  WORKER_SIGNALED: 'WORKER_SIGNALED',
  WORKER_CLOSE_NOT_OBSERVED: 'WORKER_CLOSE_NOT_OBSERVED',
  WORKER_STDIN_FAILED: 'WORKER_STDIN_FAILED',
  WORKER_WRITE_ATTEMPTED: 'WORKER_WRITE_ATTEMPTED',
  // 公共入口身份来源（硬停止点）
  PUBLIC_ENTRY_IDENTITY_UNPROVEN: 'PUBLIC_ENTRY_IDENTITY_UNPROVEN',
  CREDENTIAL_FETCH_NOT_IMPLEMENTED: 'CREDENTIAL_FETCH_NOT_IMPLEMENTED',
  // 记录核对
  PRIMARY_UNCONFIRMED: 'PRIMARY_UNCONFIRMED',
  PRIMARY_CONFLICT: 'PRIMARY_CONFLICT',
  USER_DISABLED: 'USER_DISABLED',
  USER_DERIVATION_MISMATCH: 'USER_DERIVATION_MISMATCH'
});

/**
 * 阶段序列：**直接复用**已验收 CLI 观测器的 `STAGES`（含 apiVersion / body / envArgs）。
 * 不自行重写 —— 抄一份就会与已验收契约漂移。
 * `callerIdentity` 是既有键名；本库的 `sts` 只是报告里的简称映射。
 */
const STAGES = cliObserver.STAGES;
const STAGE_KEY_ALIAS = Object.freeze({
  callerIdentity: 'sts',
  describeEnvs: 'describeEnvs',
  describeEnvInfo: 'describeEnvInfo'
});

class SdkReadonlyError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'SdkReadonlyError';
    this.code = code;
    this.detail = detail || null;
  }
}

function fail(code, message, detail) {
  throw new SdkReadonlyError(code, message, detail);
}

function text(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 非敏感随机运行编号：只用于把同一次运行的各阶段关联起来。 */
function newRunId() {
  return 'run-' + crypto.randomBytes(6).toString('hex');
}

/* ── M3：参数解析（严格白名单；无任何跳过检查的开关） ──────────────────── */

const FORBIDDEN_ARGS = new Set(['--execute', '--approval', '--init', '--initialize',
  '--deploy', '--force', '--skip-checks', '--no-checks', '--allow', '--yes']);

/**
 * 明确**禁止**的参数前缀：env / 集合 / URL / 认证目录 / 凭据一律不存在。
 * 与「未知参数」区分开是为了让交付报告能明确指出「该能力未开放」而非「拼错」。
 */
const FORBIDDEN_PREFIXES = ['--env', '--collection', '--url', '--endpoint',
  '--secret', '--token', '--credential', '--auth', '--region', '--appid'];

/**
 * 解析命令行参数。
 *
 * 只接受：`--read-only`、`--target-user-id <完整userId>`。
 * 未知参数、禁止开关一律**在任何云调用之前**拒绝。
 * **没有**任何 env /集合 / URL / 认证目录 / 凭据参数。
 */
function parseArgs(argv) {
  const out = { mode: 'local-check', targetUserId: null };
  const list = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (a === '--read-only') {
      out.mode = 'read-only';
      continue;
    }
    if (a === '--target-user-id') {
      const v = list[++i];
      if (typeof v !== 'string' || v.length === 0) {
        fail(ERR.ARG_UNKNOWN, '--target-user-id 需要一个值。');
      }
      out.targetUserId = v;
      continue;
    }
    if (a.startsWith('--target-user-id=')) {
      out.targetUserId = a.slice('--target-user-id='.length);
      continue;
    }
    if (FORBIDDEN_ARGS.has(a) || FORBIDDEN_PREFIXES.some(p => a === p || a.startsWith(p + '='))) {
      fail(ERR.ARG_FORBIDDEN, `不接受该参数：${a.split('=')[0]}`);
    }
    fail(ERR.ARG_UNKNOWN, `未知参数：${a}`);
  }
  // 目标格式：只接受完整 userId，不接受尾号 / 昵称
  if (out.targetUserId !== null && !/^u_[0-9a-f]{40}$/.test(out.targetUserId)) {
    fail(ERR.TARGET_USER_ID_INVALID, 'targetUserId 必须是完整 userId（u_ + 40 位十六进制），不接受尾号或昵称。');
  }
  return out;
}

/* ── 固定值核对（默认本地检查；不取凭据、不发云调用） ──────────────────── */

/**
 * 核对固定程序与本地环境。
 * **记录本轮实际使用的文件哈希**；没有历史受审值的文件**不标**「历史基线已匹配」。
 */
function checkLocalReadiness(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const checks = [];
  const push = (name, ok, info) => checks.push(Object.assign({ name, ok: Boolean(ok) }, info || {}));

  // 1. Node / CLI 入口 / bundle：**复用**已验收校验（含完整字节哈希 + 精确内容）。
  //注意该函数是异步的（内部做 homedir 核验），故此处只登记其 Promise 由
  // `runLocalCheckAsync` 汇总；同步版本在下方 `runLocalCheck` 中提供。
  const cliReady = Promise.resolve()
    .then(() => cliObserver.checkLocalReadiness({ fixed: d.fixed, now }))
    .then(local => {
      for (const c of (local && local.checks) || []) push(c.name, c.ok, { detail: c.detail || null });
      return local;
    })
    .catch(() => {
      push('cli-fixed-checks', false, { detail: '本地固定项检查失败' });
      return null;
    });

  // 2. SDK 来源：核对**实际版本**与**真正公开入口**，不只是「文件存在就算通过」
  const sdkRoot = (d.fixed && d.fixed.sdkRoot) || FIXED.sdkRoot;
  const sdkPkg = path.join(sdkRoot, '@cloudbase', 'node-sdk', 'package.json');
  const sdkEntry = path.join(sdkRoot, '@cloudbase', 'node-sdk', 'lib', 'cloudbase.js');
  const dbPkg = path.join(sdkRoot, '@cloudbase', 'database', 'package.json');
  const sdkIndexJs = path.join(sdkRoot, '@cloudbase', 'node-sdk', 'lib', 'index.js');
  const sdkFiles = [];
  for (const p of [sdkPkg, sdkEntry, dbPkg, sdkIndexJs]) {
    let ok = false;
    let sha = null;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        ok = true;
      }
    } catch (_) { /* 视为缺失 */ }
    push('sdk-source', ok, { file: p, sha256: sha, historicalBaselineMatched: null });
    // 没有历史受审值 → 显式 null，绝不写 true
    sdkFiles.push({ file: p, present: ok, sha256: sha, historicalBaselineMatched: null });
  }

  // 2b. R1：版本必须与本轮固定的契约相符；`@cloudbase/database` 也一样
  const expectedVersions = Object.freeze({ '@cloudbase/node-sdk': '2.10.0', '@cloudbase/database': '1.4.1' });
  const actualVersions = {};
  for (const [name, p] of [['@cloudbase/node-sdk', sdkPkg], ['@cloudbase/database', dbPkg]]) {
    let v = null;
    try {
      if (fs.existsSync(p)) v = JSON.parse(fs.readFileSync(p, 'utf8')).version || null;
    } catch (_) { v = null; }
    actualVersions[name] = v;
    push('sdk-version', v === expectedVersions[name], {
      package: name, expected: expectedVersions[name], actual: v
    });
  }

  // 2c. R1：真实公开入口必须是 `init(config)`（导出是对象，不是构造函数）
  let entryContract = { exportKind: null, hasInit: false, resolved: null, requireError: null };
  try {
    const resolved = require.resolve(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
    entryContract.resolved = resolved;
    const sdkModule = require(resolved);
    entryContract.exportKind = sdkModule && typeof sdkModule === 'object'
      ? (Array.isArray(sdkModule) ? 'array' : 'object') : typeof sdkModule;
    entryContract.hasInit = Boolean(sdkModule && typeof sdkModule.init === 'function');
  } catch (error) {
    entryContract.requireError = (error && error.code) || 'REQUIRE_FAILED';
  }
  push('sdk-public-entry', entryContract.exportKind === 'object' && entryContract.hasInit === true, {
    resolved: entryContract.resolved,
    exportKind: entryContract.exportKind,
    hasInit: entryContract.hasInit,
    note: 'R1：公开入口是 init(config)；对导出对象 new 会抛 TypeError'
  });
  if (entryContract.requireError) push('sdk-require', false, { errorCode: entryContract.requireError });

  // 3. worker 存在性（本轮新增文件）
  const workerPath = (d.fixed && d.fixed.workerPath) || FIXED.workerPath;
  let workerPresent = false;
  let workerSha = null;
  try {
    if (fs.existsSync(workerPath) && fs.statSync(workerPath).isFile()) {
      workerPresent = true;
      workerSha = crypto.createHash('sha256').update(fs.readFileSync(workerPath)).digest('hex');
    }
  } catch (_) { /* 视为缺失 */ }
  push('worker-present', workerPresent, { file: workerPath, sha256: workerSha, historicalBaselineMatched: null });

  // 本地 SDK/worker 项是同步的，先给出「同步部分」结论；CLI 项并入 promise。
  const build = (cliOk) => {
    const all = checks.every(c => c.ok);
    return {
      schemaVersion: SCHEMA_VERSION,
      observedAt: new Date(now()).toISOString(),
      mode: 'local-check',
      status: all ? STATUS.LOCAL_READY : STATUS.FAILED,
      localPreparation: {
        status: all ? 'READY' : 'FAILED',
        checks,
        sdkFiles,
        // R1：真实入口与实际版本结论，不再只报「文件存在」
        sdkPublicEntry: { resolved: entryContract.resolved, exportKind: entryContract.exportKind, hasInit: entryContract.hasInit },
        actualVersions,
        credentialFetched: false,
        cloudCallAttempted: false,
        /**
         * H3：**能力字段**与**运行证据**严格分开。
         * - `credentialFetchHostImplemented`：固定获取宿主**已实现**（H2 本轮交付物）。
         * - `publicEntryIdentityProven`：**只**表明「存在固定范围的离线证据」，
         *   即合成 Web 登录态经真实公共入口可产出快照、命令附加行为已被记录。
         * - `productionSameBatchObserved`：**只有真实执行结果才能成立**，本轮恒为 false。
         * 不得用固定布尔常量或测试 `deps.proven=true` 冒充生产证据。
         *
         * R3 收窄：可刷新分支（`refreshTmpToken`）尚未产出完整快照，
         * 因此**不得**表述为「H1 全部前置通过」。此字段不覆盖刷新分支。
         */
        credentialFetchHostImplemented: true,
        publicEntryIdentityProven: true,
        productionSameBatchObserved: false,
        /** 离线公共入口证明的适用范围（据实限定，不泛化）。 */
        publicEntryEvidence: {
          scope: '固定 Node + 原始 bin/tcb + 原始 bundle；命令 secrets get --json',
          fingerprint: host.FINGERPRINT,
          evidence: 'docs/证据/CodexSecretsGet离线契约审查-20261008.json',
          additionalBehaviorsKnown: true,
          /** 明确列出**未覆盖**的部分，避免把「已知附加行为」读成「全部通过」。 */
          notCovered: [
            'refreshTmpToken 分支尚未产出完整快照，输出契约未定论',
            'Initialized=false 时命令仍输出凭据（固定版本行为，已接受，不代表服务就绪）',
            '真实登录目录的缓存写回未验证',
            '生产同批凭据链、IAM、真实库内容、目标 userId 来源、费用/余量'
          ],
          note: '离线证明只覆盖该命令范围与固定指纹；不证明生产宿主已接上，也不证明任何平台行为'
        }
      },
      sameBatchCredential: { status: 'NOT_ATTEMPTED', proven: false },
      cliAssociation: { status: 'NOT_ATTEMPTED' },
      primaryObservation: { status: 'NOT_ATTEMPTED' },
      targetUserObservation: { status: 'NOT_ATTEMPTED' },
      incomplete: [],
      writeAuthorized: false,
      productionCallerVerifierImplemented: false
    };
  };

  return { cliReady, build, syncChecks: checks };
}

/** 同步包装：默认入口用。CLI 固定项核验失败时如实记FAILED。 */
async function runLocalCheck(deps) {
  const { cliReady, build } = checkLocalReadiness(deps);
  await cliReady;
  return build();
}

/* ── M1-a：一次获取凭据（内存快照，绝不落盘/显示） ────────────────────── */

/**
 * 从 `secrets get --json` 的 **stdout** 严格解析临时凭据。
 *
 * 严格接受：非空字符串 secretId/secretKey/token、`isTemporary` 严格 true、
 * 可验证的**未来** expiredAt（剩余 ≥ 门槛）。
 * 拒绝：长期密钥、未知/缺失有效期、已过期、坏形状。
 *
 * **凭据不输出摘要、尾号或原值**；仅返回供内部使用的快照 + 非敏感到期时间。
 */
function parseSecretsPayload(stdout, nowMs, minRemainingMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const minRemain = typeof minRemainingMs === 'number' ? minRemainingMs : MIN_REMAINING_MS;
  const textOnly = stdout.trim();
  if (!textOnly) fail(ERR.CREDENTIAL_SHAPE_INVALID, '凭据输出为空。');

  let parsed;
  try {
    parsed = JSON.parse(textOnly);
  } catch (_) {
    fail(ERR.CREDENTIAL_SHAPE_INVALID, '凭据输出不是合法 JSON。');
  }
  if (!isPlainObject(parsed)) fail(ERR.CREDENTIAL_SHAPE_INVALID, '凭据输出不是对象。');
  // CLI 的 outputJson 可能带 { data: ... } 包装
  const payload = Object.prototype.hasOwnProperty.call(parsed, 'data') && isPlainObject(parsed.data)
    ? parsed.data : parsed;

  for (const key of ['secretId', 'secretKey', 'token']) {
    if (!text(payload[key])) fail(ERR.CREDENTIAL_SHAPE_INVALID, `凭据字段缺失或类型不符：${key}`);
  }
  // isTemporary 必须**严格**为 true
  if (payload.isTemporary !== true) {
    fail(ERR.CREDENTIAL_NOT_TEMPORARY, '凭据不是严格意义上的临时凭据（长期密钥不接受）。');
  }
  // 有效期：未知/缺失一律拒绝，不猜测
  if (!text(payload.expiredAt)) {
    fail(ERR.CREDENTIAL_EXPIRY_UNKNOWN, '凭据缺少可验证的到期时间。');
  }
  const expiryMs = Date.parse(payload.expiredAt);
  if (!Number.isFinite(expiryMs)) {
    fail(ERR.CREDENTIAL_EXPIRY_UNKNOWN, '凭据到期时间无法解析。');
  }
  if (expiryMs <= now) {
    fail(ERR.CREDENTIAL_EXPIRED, '凭据已过期。');
  }
  if (expiryMs - now < minRemain) {
    fail(ERR.CREDENTIAL_EXPIRED, '凭据剩余有效期不足本轮门槛。');
  }
  return {
    // 仅内存快照；不输出、不落盘
    secretId: payload.secretId,
    secretKey: payload.secretKey,
    sessionToken: payload.token,
    expiresAtMs: expiryMs,
    expiresAtIso: new Date(expiryMs).toISOString(),
    isTemporary: true
  };
}

/** 每阶段前后检查尚未过期；失效即停止，不混用新旧结果。 */
function assertCredentialFresh(snapshot, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!snapshot || typeof snapshot.expiresAtMs !== 'number') {
    fail(ERR.CREDENTIAL_SHAPE_INVALID, '凭据快照缺失。');
  }
  if (snapshot.expiresAtMs <= now) fail(ERR.CREDENTIAL_EXPIRED, '凭据在运行期间过期。');
  return true;
}

/* ── M1-b：隔离目录与登录态优先级隔离 ───────────────────────────────── */

/**
 * 认证存储位置（由源码核对得出，见文件头）。
 *
 * R4：上一版只检查两个路径，实际取值链还有 `XDG_CONFIG_HOME` 指定位置、
 * 以及 `authStore` 在 `getAsyncDB` 下用的 `cloudbaseConfigDir`。这里把
 * **在本隔离目录上下文下**所有可能落点的位置都列出（含大小写不敏感变体），
 * 由 `assertIsolationClean` 逐个查位置。仍然**只查位置、不读内容**。
 */
function authStatePaths(isolationDir) {
  const bases = [
    isolationDir,
    path.join(isolationDir, '.config'),
    process.env.XDG_CONFIG_HOME || path.join(isolationDir, '.config')
  ];
  const rels = [
    path.join('.cloudbase', 'auth.json'),
    path.join('.config', '.cloudbase', 'auth.json'),
    path.join('.cloudbase', 'tcb-auth.json'),
    path.join('.cloudbase', 'config.json')
  ];
  const seen = new Set();
  const out = [];
  for (const base of bases) {
    for (const rel of rels) {
      const p = path.join(base, rel);
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/**
 * **存在性检查**：只查固定配置/认证文件**位置**，**不读取内容**。
 * 发现已存在即视为污染 → 停止，**不删用户文件**。
 */
function assertIsolationClean(isolationDir) {
  const polluted = [];
  for (const p of authStatePaths(isolationDir)) {
    let exists = false;
    try {
      exists = fs.existsSync(p);
    } catch (_) {
      fail(ERR.ISOLATION_UNPROVEN, '无法确认隔离目录的认证文件位置。');
    }
    if (exists) polluted.push(p);
  }
  if (polluted.length > 0) {
    fail(ERR.ISOLATION_DIRTY, '隔离目录已存在认证文件，无法证明登录态隔离；未删除任何文件。', { pollutedCount: polluted.length });
  }
  return true;
}

/** 新建本轮隔离目录（无登录记录）；**不复用原登录目录**。 */
function createIsolationDir(runId, deps) {
  const d = deps || {};
  const root = (d.fixed && d.fixed.isolationRoot) || FIXED.isolationRoot;
  const dir = path.join(root, `${runId}-${Date.now()}`);
  try {
    fs.mkdirSync(path.join(dir, '.config', '.cloudbase'), { recursive: true });
  } catch (error) {
    fail(ERR.ISOLATION_UNPROVEN, '无法创建隔离目录。');
  }
  // 创建后立刻复核「不存在认证文件」
  assertIsolationClean(dir);
  return dir;
}

/**
 * 构造隔离子进程环境。
 *
 * R4 返修要点：**Windows 环境变量名忽略大小写**。上一版只删除大写 `XDG_*`、只覆写大写
 * `USERPROFILE`，于是 `xdg_config_home`、`UserProfile` 等别名被原样保留 ——
 * 隔离目录的真实性不能只凭两个赋值宣称成立。代理变量也整族继承。
 * 现在按**大小写无关**方式清理并固定所有影响身份、路径、服务目标与代理的变量。
 *
 * **不修改系统环境、不写参数文件**；下面只构造该子进程的环境副本。
 */
function buildIsolatedEnv(baseEnv, snapshot, isolationDir) {
  const out = {};
  /**
   * 命中即**删除**的键（大小写无关）：身份/凭据前缀、Node 启动注入、XDG 全家、
   * 各类代理。删除时连同其**任意大小写别名**一起删，避免留下旁路。
   */
  const dropExact = new Set([
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
    // 代理族：全部清空，隔离目录内不应继承任何代理指向
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'no_proxy'
  ]);
  const dropPrefixes = ['CLOUDBASE_', 'TCB_', 'TENCENTCLOUD_', 'XDG_', 'CLOUD_'];

  for (const [key, value] of Object.entries(baseEnv || {})) {
    const upper = key.toUpperCase();
    if (dropPrefixes.some(p => upper.startsWith(p))) continue;
    if (dropExact.has(upper)) continue;
    out[key] = value;
  }
  // 先把同名**所有大小写别名**彻底移除，再写规范大写形式 —— 避免出现两套大小写并存
  for (const key of Object.keys(out)) {
    const upper = key.toUpperCase();
    if (upper === 'USERPROFILE' || upper === 'HOME' || upper === 'APPDATA' ||
      upper === 'LOCALAPPDATA' || upper === 'HOMEDRIVE' || upper === 'HOMEPATH') {
      delete out[key];
    }
  }
  out.USERPROFILE = isolationDir;
  out.HOME = isolationDir;
  out.APPDATA = path.join(isolationDir, 'AppData', 'Roaming');
  out.LOCALAPPDATA = path.join(isolationDir, 'AppData', 'Local');
  // 显式清空 XDG 变量（含任何大小写别名），避免宿主环境把它指到别处
  for (const key of Object.keys(out)) {
    if (key.toUpperCase().startsWith('XDG_')) delete out[key];
  }
  if (snapshot) {
    out.TENCENTCLOUD_SECRETID = snapshot.secretId;
    out.TENCENTCLOUD_SECRETKEY = snapshot.secretKey;
    out.TENCENTCLOUD_SESSIONTOKEN = snapshot.sessionToken;
  }
  out.TCB_REGION = FIXED.region;
  out.NO_UPDATE_NOTIFIER = '1';
  out.TCB_DISABLE_REPORT = '1';
  out.CI = '1';
  return out;
}

/* ── M1-c：同批凭据的 CLI 关联查询（复用已验收收尾/解析/校验） ───────── */

/**
 * 用**同一份**快照在隔离目录执行已验收的 STS→DescribeEnvs→DescribeEnvInfo 序列。
 *
 * R1 返修要点：上一版把无扩展名的 JS 脚本 `bin/tcb` 直接当**可执行文件** spawn，
 * 参数从 `api` 开始 —— Windows 上它根本不是可执行程序。`spawnBounded` 不会代为补Node。
 * 现按已验收方式启动：**固定 nodeBin + [固定 cliEntry, ...apiArgs]**，shell:false。
 */
async function runCliAssociation(snapshot, isolationDir, deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const spawnFn = d.spawn || spawn;
  const nodeBin = (d.fixed && d.fixed.nodeBin) || FIXED.nodeBin;
  const env = buildIsolatedEnv(d.baseEnv || process.env, snapshot, isolationDir);

  const stages = [];
  /**
   * R4：任一步执行/解析失败**立即停止**后续阶段，保留 not-executed 事实。
   * 上一版失败后仍 `continue` 跑完三阶段（离线样本：第一步 exit1 仍启动全部三项）。
   */
  let stopped = false;
  for (const stage of STAGES) {
    if (stopped) {
      stages.push({
        stage: STAGE_KEY_ALIAS[stage.key] || stage.key, service: stage.service, action: stage.action,
        notExecuted: true, notExecutedReason: '前序阶段失败，未执行',
        exitCode: null, timedOut: false, overflow: false,
        terminationRequested: false, terminationConfirmed: false,
        closeNotObserved: false, spawnError: false, requestId: null, ok: false
      });
      continue;
    }
    assertCredentialFresh(snapshot, now());
    const apiArgs = cliObserver.buildStageArgs(stage);
    const stageKey = STAGE_KEY_ALIAS[stage.key] || stage.key;
    // 固定 Node 启动 JS 入口（已验收方式）
    const r = await cliObserver.spawnBounded(nodeBin, [FIXED.cliEntry, ...apiArgs],
      { cwd: isolationDir, env, shell: false, windowsHide: true },
      {
        spawn: (bin, argv, options) => spawnFn(bin, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
        __limits: LIMITS.cli
      });
    const rec = {
      stage: stageKey, service: stage.service, action: stage.action,
      launchedBy: 'node', entry: path.basename(FIXED.cliEntry),
      exitCode: r.code, timedOut: r.timedOut, overflow: r.overflow,
      terminationRequested: r.terminationRequested, terminationConfirmed: r.terminationConfirmed,
      closeNotObserved: Boolean(r.closeNotObserved), spawnError: Boolean(r.spawnError),
      signal: r.signal || null,
      requestId: null, ok: false, reasons: []
    };
    if (r.spawnError || r.timedOut || r.overflow || r.closeNotObserved ||
      r.code === null || r.code !== 0) {
      if (r.spawnError) rec.reasons.push('子进程启动失败');
      if (r.timedOut) rec.reasons.push('超时');
      if (r.overflow) rec.reasons.push('输出超限');
      if (r.closeNotObserved) rec.reasons.push('close 未观察到');
      if (r.code !== null && r.code !== 0) rec.reasons.push('非零退出');
      if (r.code === null) rec.reasons.push('退出码未确认');
      stopped = true;
      stages.push(rec);
      // R4：失败路径同样要做**阶段后**有效期检查，否则过期窗口会被漏掉
      assertCredentialFresh(snapshot, now());
      break;
    }
    try {
      const payload = cliObserver.parseCliJson(r.stdout, stage.service, stage.action);
      if (stage.key === 'callerIdentity') {
        const sts = cliObserver.assertSts(payload, crypto, stageKey);
        rec.ok = true;
        rec.requestId = sts.requestId;
        rec.accountIdSha256 = sts.accountIdSha256;
        rec.accountIdTail = sts.accountIdTail;
        rec.sts = sts;
      } else if (stage.key === 'describeEnvs') {
        const envs = cliObserver.assertDescribeEnvs(payload, stageKey);
        rec.ok = true;
        rec.requestId = envs.requestId;
        rec.envs = envs;
      } else {
        const stsDigest = (stages.find(s => s.stage === 'sts') || {}).accountIdSha256;
        if (!stsDigest) {
          rec.reasons.push('缺少同批 STS 摘要，未做归属核对');
          stopped = true;
          stages.push(rec);
          assertCredentialFresh(snapshot, now());
          break;
        }
        const info = cliObserver.assertDescribeEnvInfo(payload, stsDigest, crypto, stage.key);
        rec.ok = true;
        rec.requestId = info.requestId;
        rec.uinSha256 = info.uinSha256;
        rec.uinTail = info.uinTail;
        rec.envInfo = info;
      }
    } catch (_) {
      // 解析/校验失败：如实记为未通过，不透传异常文本；**立即停止**后续阶段
      rec.ok = false;
      rec.reasons.push('响应解析或字段核验未通过');
      stopped = true;
    }
    // R4：每阶段**之后**再核对一次有效期。即使本阶段失败/停止也要核对 ——
    // 否则「第一步失败即停止」会跳过所有后检查，过期窗口仍可能被漏掉。
    if (rec.ok) assertCredentialFresh(snapshot, now());
    stages.push(rec);
    if (stopped) {
      // 已停止：如实做一次后检查（可能抛 CREDENTIAL_EXPIRED），不再启动后续阶段
      assertCredentialFresh(snapshot, now());
      break;
    }
  }

  const stsRec = stages.find(s => s.stage === 'sts') || null;
  const envsRec = stages.find(s => s.stage === 'describeEnvs') || null;
  const infoRec = stages.find(s => s.stage === 'describeEnvInfo') || null;
  // 补齐未执行阶段的占位记录：如实保留「未执行」事实，不让阶段列表长度失真
  const executed = new Set(stages.map(s => s.stage));
  for (const stage of STAGES) {
    const key = STAGE_KEY_ALIAS[stage.key] || stage.key;
    if (executed.has(key)) continue;
    stages.push({
      stage: key, service: stage.service, action: stage.action,
      notExecuted: true, notExecutedReason: '前序阶段未通过，未执行',
      launchedBy: 'node', entry: path.basename(FIXED.cliEntry),
      exitCode: null, timedOut: false, overflow: false,
      terminationRequested: false, terminationConfirmed: false,
      closeNotObserved: false, spawnError: false, signal: null,
      requestId: null, ok: false, reasons: ['前序阶段未通过，未执行']
    });
  }
  // 保持 STAGES 声明顺序
  const order = new Map(STAGES.map((s, i) => [STAGE_KEY_ALIAS[s.key] || s.key, i]));
  stages.sort((a, b) => (order.get(a.stage) ?? 99) - (order.get(b.stage) ?? 99));
  const matched = Boolean(stsRec && stsRec.ok && envsRec && envsRec.ok && infoRec && infoRec.ok);
  return {
    matched,
    stoppedEarly: stopped,
    stages,
    // 账号只留摘要/尾号与请求 ID
    accountIdSha256: stsRec ? stsRec.accountIdSha256 || null : null,
    accountIdTail: stsRec ? stsRec.accountIdTail || null : null,
    uinSha256: infoRec ? infoRec.uinSha256 || null : null,
    uinTail: infoRec ? infoRec.uinTail || null : null,
    requestIds: {
      sts: stsRec ? stsRec.requestId : null,
      describeEnvs: envsRec ? envsRec.requestId : null,
      describeEnvInfo: infoRec ? infoRec.requestId : null
    }
  };
}

/* ── M1-d：SDK worker 调用（凭据仅经私有 stdin 管道） ────────────────── */

/** worker 子进程生效的限制：生产用 `LIMITS.worker`；仅模块测试可经 `deps.limits` 注入更小值。 */
function resolveWorkerLimits(deps) {
  const d = deps || {};
  if (!d.limits) return LIMITS.worker;
  return Object.freeze({
    timeoutMs: d.limits.timeoutMs === undefined ? LIMITS.worker.timeoutMs : d.limits.timeoutMs,
    maxOutputBytes: d.limits.maxOutputBytes === undefined ? LIMITS.worker.maxOutputBytes : d.limits.maxOutputBytes,
    closeGraceMs: d.limits.closeGraceMs === undefined ? cliObserver.LIMITS.closeGraceMs : d.limits.closeGraceMs
  });
}

/**
 * 调用 worker：凭据**只**经 stdin 管道一次送入，随即关闭 stdin。
 * 不放命令行、不放环境、不放磁盘。worker 只输出净化结果。
 *
 * R2返修要点（上一版的四处有界缺陷）
 * ────────────────────────────────
 * 1. **计时器只 kill 不 resolve** → kill 返回 false、error 后不 close、exit 后不 close
 *    都可能永久挂起（离线样本 `settledAfterTimer=false` 即此）。现**直接复用已验收的
 *    `cliObserver.spawnBounded`**：它保证超时/超限立即有界收尾、终止只发一次、
 *    exit 后启动 close 宽限、晚到 error 被幂等吸收、保留真实 code/signal。
 *    这也避免复制一份已经修过 T1/S1/S2 的收尾逻辑。
 * 2. **stdout/stderr 各自计数** → 700KB+700KB 可同时低于 1MiB 而合计超限。
 *    `spawnBounded` 的上限对 **stdout+stderr 合并**生效，且**先计数再截断**。
 * 3. **忽略 exit/close 的 code 与 signal** → 非零退出仍可凭JSON 判成功；
 *    超时后 close 且 stdout 含 `ok:true` 也曾返回成功。現由 `interpretWorkerOutput`
 *    以**显式入参**核验退出事实，stdout 自报不再能覆盖终止事实。
 * 4. **stdin 差异**：凭据要经私有管道送入。`spawnBounded` 不管stdin，这里用最小受控
 *    包装把凭据写进 `child.stdin` 并立即 `end()`；**stdin 写失败即让本次调用失败**
 *    （否则等于没送凭据却当成跑完了）。
 */
function runWorker(snapshot, targetUserId, deps) {
  const d = deps || {};
  const spawnFn = d.spawn || spawn;
  const nodeBin = (d.fixed && d.fixed.nodeBin) || FIXED.nodeBin;
  const workerPath = (d.fixed && d.fixed.workerPath) || FIXED.workerPath;
  const limits = resolveWorkerLimits(d);

  let stdinFailure = null;
  const payload = JSON.stringify({
    secretId: snapshot.secretId,
    secretKey: snapshot.secretKey,
    sessionToken: snapshot.sessionToken,
    targetUserId: targetUserId || null,
    // R4：把到期时间一并送入，使 worker 能在**两条读取之间**独立复核同一批凭据
    expiresAtMs: typeof snapshot.expiresAtMs === 'number' ? snapshot.expiresAtMs : null
  });

  const bounded = cliObserver.spawnBounded(nodeBin, [workerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    cwd: (d.fixed && d.fixed.isolationRoot) || FIXED.isolationRoot,
    env: { PATH: '', SystemRoot: process.env.SystemRoot || '' }
  }, {
    // 凭据只在**私有 stdin 管道**里送入一次，随即关闭；不进命令行/环境/磁盘
    spawn: (bin, argv, options) => {
      const child = spawnFn(bin, argv, options);
      if (!child || !child.stdin) {
        stdinFailure = 'no-stdin';
        return child;
      }
      try {
        child.stdin.on('error', () => {
          // 收尾后的管道关闭竞态：只标记，不外传异常文本
          if (!stdinFailure) stdinFailure = 'stdin-error';
        });
        child.stdin.write(payload, 'utf8');
        child.stdin.end();
      } catch (_) {
        stdinFailure = 'stdin-write-failed';
      }
      return child;
    },
    __limits: limits
  });

  return bounded.then(r => interpretWorkerOutput({
    stdout: r.stdout,
    totalBytes: r.totalBytes,
    retainedBytes: r.retainedBytes,
    overflow: r.overflow,
    timedOut: r.timedOut,
    code: r.code,
    signal: r.signal,
    spawnError: r.spawnError,
    terminationRequested: r.terminationRequested,
    terminationConfirmed: r.terminationConfirmed,
    closeNotObserved: r.closeNotObserved,
    stdinFailure,
    // S1：净化 targetUser 需要知道受信目标是谁，才能校验记录键
    targetUserId: targetUserId || null
  }));
}

/**
 * 解释 worker 输出：**只**返回净化结论，不透传 stderr / 原始响应 / stack。
 *
 * R2/R3：这里**逐字段重建**结果，**不再** `Object.assign(base, parsed)` ——
 * 那允许 worker 的任意字段覆盖宿主的终止事实或夹带原始内容。
 * 只有宿主观测到的事实（超时/溢出/退出码/信号/终止确认）才能决定成败，
 * **stdout 自报的 `ok:true` 不能覆盖退出事实**。
 */
function interpretWorkerOutput(state) {
  const s = state || {};
  const base = {
    terminationRequested: Boolean(s.terminationRequested),
    // 「杀进程」不证明平台请求已取消
    terminationConfirmed: Boolean(s.terminationConfirmed),
    processExited: Boolean(s.terminationConfirmed),
    writeAttemptsCount: null,
    primary: null,
    targetUser: null,
    credentialExpiredDuringRun: false
  };
  // 1) 通信/启动失败优先：连一次正常收尾都没发生
  if (s.spawnError) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_FAILED });
  if (s.stdinFailure) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_STDIN_FAILED });
  // 2) 超时 /溢出：即便 stdout 里有合法 JSON 且随后 close，也**不是**成功
  if (s.timedOut) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_TIMEOUT });
  if (s.overflow) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_OVERFLOW });
  // 3) exit 后未等到 close：有界失败，如实保留「已请求终止但未确认」
  if (s.closeNotObserved) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_CLOSE_NOT_OBSERVED });
  // 4) 请求过终止但从未观察到退出：终止未确认（比「退出码未确认」更具体），不得成功
  if (s.terminationRequested && !s.terminationConfirmed) {
    return Object.assign(base, { ok: false, errorCode: ERR.WORKER_TERMINATION_UNCONFIRMED });
  }
  // 5) 必须真的观察到正常退出（code === 0）；非零退出 / 被信号杀死都失败
  if (s.signal) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_SIGNALED });
  if (s.code === null || s.code === undefined) {
    return Object.assign(base, { ok: false, errorCode: ERR.WORKER_EXIT_UNCONFIRMED });
  }
  if (s.code !== 0) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_NONZERO_EXIT });

  const textOut = typeof s.stdout === 'string' ? s.stdout : stdoutToText(s.stdout);
  if (!textOut) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_OUTPUT_INVALID });
  let parsed;
  try {
    parsed = JSON.parse(textOut);
  } catch (_) {
    return Object.assign(base, { ok: false, errorCode: ERR.WORKER_OUTPUT_INVALID });
  }
  if (!isPlainObject(parsed)) return Object.assign(base, { ok: false, errorCode: ERR.WORKER_OUTPUT_INVALID });
  // 6) `ok` 必须**严格**为 true；writeAttemptsCount 必须**严格**为 0
  if (parsed.ok !== true) {
    return Object.assign(base, {
      ok: false,
      // S2：worker 的 errorCode 也走有限映射 —— 上一版任意字符串都能进顶层 errorCode
      errorCode: mapWorkerErrorCode(parsed.errorCode) || ERR.WORKER_FAILED,
      writeAttemptsCount: Number.isInteger(parsed.writeAttemptsCount) ? parsed.writeAttemptsCount : null
    });
  }
  if (parsed.writeAttemptsCount !== 0) {
    return Object.assign(base, {
      ok: false,
      errorCode: ERR.WORKER_WRITE_ATTEMPTED,
      writeAttemptsCount: Number.isInteger(parsed.writeAttemptsCount) ? parsed.writeAttemptsCount : null
    });
  }
  // 7) 逐字段重建记录结论：形状不对就降级为 UNCONFIRMED，**不**原样透传
  // S1：`targetUser` 必须用**users 契约**净化，不能传 null。
  // 上一版传 null 导致：不保留任何状态（docIdMatches 退化）、又默认要求 primary
  // 才有的 userId，于是结构正确的 users 记录在此处就被降级为 UNCONFIRMED；
  // 后续 `interpretTargetUser` 再用正确规则净化时，字段已经丢失，无法恢复。
  return Object.assign(base, {
    ok: true,
    errorCode: null,
    writeAttemptsCount: 0,
    credentialExpiredDuringRun: parsed.credentialExpiredDuringRun === true,
    credentialExpiryMissing: parsed.credentialExpiryMissing === true,
    primary: sanitizeWorkerRecord(parsed.primary, PRIMARY_KEY_EXPECTATION),
    targetUser: sanitizeWorkerRecord(
      parsed.targetUser,
      makeUsersExpectation(s.targetUserId || null)
    )
  });
}

/** primary / targetUser 的字段白名单与契约（`docId` 即固定主键）。 */
const PRIMARY_KEY_EXPECTATION = Object.freeze({
  docId: 'primary',
  classificationValues: ['NOT_FOUND', 'OBSERVED', 'UNCONFIRMED_SHAPE', 'UNCONFIRMED'],
  userIdPattern: /^u_[0-9a-f]{40}$/,
  statusValues: ['active', 'disabled'],
  // primary 必须齐备的字段
  requiredFields: ['docIdMatches', 'userIdShapeValid', 'statusValid']
});

/**
 * S1：users 记录的契约。
 *
 * 与 primary 的**关键差异**：users 记录**本来就没有 `userId` 字段**，
 * 因此不得要求它；身份派生由 `derivationMatches` / `derivationChecked` 表达。
 * `docId` 是请求目标（受信指定的完整 userId），不匹配即判失败。
 *
 * @param {string|null} targetUserId 受信指定的完整 userId；null 表示未指定目标
 */
function makeUsersExpectation(targetUserId) {
  return {
    kind: 'users',
    docId: targetUserId,
    classificationValues: ['NOT_FOUND', 'OBSERVED', 'UNCONFIRMED_SHAPE', 'UNCONFIRMED'],
    // users 记录不含 userId 字段，用永不就绪的模式表达「不适用」
    userIdPattern: null,
    statusValues: ['active', 'disabled'],
    requiredFields: ['docIdMatches', 'statusValid']
  };
}

/**
 * S2：`requestId` 格式白名单（与 worker 侧同一依据）。
 *
 * 依据：`docs/证据/` 下真实平台只读证据的 190 个 `requestId` 样本**全部**为
 * UUID v4（版本位恒为 `4`，变体位 `8/9/a/b`，符合 RFC 4122）。
 * 该格式是**已核实**的，不是臆造。未通过者一律省略（null），不原样外传。
 */
const REQUEST_ID_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_UUID_V4.test(value) ? value : null;
}

/**
 * R3/S1/S2：净化 worker 的记录结论。
 *
 * R3：worker 在字段缺失时给的是 `null`，只检查 `===false` 会把缺失放行成 OBSERVED；
 * 非法 `userId` 字符串还会原样进入报告。现在：
 * - `classification` 必须在白名单内，否则降级 UNCONFIRMED；
 * - `userId` 必须**匹配完整 userId 形状**才输出，否则一律置 null（不泄露原串）；
 * - `status` 必须在 `{active, disabled}` 内，否则置 null；
 * - `reason` 只接受**固定短语白名单**，不透传任意字符串；
 * - 布尔标志必须是**严格** true 才算通过（不再用 `!== false`）。
 *
 * S1：`expectation` 现在总是提供（users 记录也用 `makeUsersExpectation`），
 * 因此 `docIdMatches` 有明确依据；users 不要求 `userIdShapeValid`。
 *
 * S2：任意文本出口全部收紧：
 * - `errorCode` 走**有限映射**，未知值用固定失败码；
 * - 非 OBSERVED 记录的 `docId` 只能是请求目标，否则置 null；
 * - `requestId` 只保留**已核实格式**（真实证据 190 个样本全为 UUID v4）。
 *
 * @param {object} rec worker 输出的单条记录
 * @param {object} expectation 该记录类型的契约（primary / users）
 */
function sanitizeWorkerRecord(rec, expectation) {
  if (!isPlainObject(rec)) return { classification: null, status: 'UNCONFIRMED', reason: '记录缺失' };
  if (!isPlainObject(expectation)) {
    // 没有契约就**不**保留任何记录的字段值：宁可不报，也不原样外传
    return { classification: 'UNCONFIRMED', status: 'UNCONFIRMED', reason: '记录契约缺失' };
  }
  const reasonWhitelist = new Set([
    '结果不是对象', '出现事务内单对象形状', 'data 不是数组', '文档不是对象',
    '主键与请求不符', '平台返回错误响应', '凭据在读取前已过期',
    '凭据缺少可用截止时间', '集合引用不可用', '主键缺失或类型不符'
  ]);
  const out = {
    classification: null,
    // S2：只保留已核实格式（真实证据中的 UUID v4）的请求标识
    requestId: safeRequestId(rec.requestId),
    docId: null,
    userId: null,
    userIdShapeValid: null,
    status: null,
    statusValid: false,
    openidPresent: rec.openidPresent === true,
    // R3：同样尊重 worker 自己的否定结论（它报false 就不算通过）
    openidShapeValid: rec.openidShapeValid === true,
    derivationMatches: rec.derivationMatches === true,
    derivationChecked: rec.derivationChecked === true,
    hasPlatformError: rec.hasPlatformError === true,
    reason: typeof rec.reason === 'string' && reasonWhitelist.has(rec.reason) ? rec.reason : null,
    // S2：错误码走有限映射，未知值不原样外传
    errorCode: mapWorkerErrorCode(rec.errorCode),
    // 读取失败最小诊断：逐字段重建，缺项为未知
    readDiagnostics: rebuildReadDiagnostics(rec.readDiagnostics),
    docIdMatches: false,
    fieldCompleteness: 'UNKNOWN'
  };
  // classification 必须在白名单内（契约缺失时不再放行）
  const rawClass = rec.classification;
  if (typeof rawClass !== 'string' || !expectation.classificationValues.includes(rawClass)) {
    out.classification = 'UNCONFIRMED';
    out.reason = out.reason || '分类取值非法';
    return out;
  }
  out.classification = rawClass;
  if (rawClass !== 'OBSERVED') {
    // S2：非 OBSERVED 记录的 docId 只能是请求目标，否则置 null
    out.docId = (typeof rec.docId === 'string' && rec.docId === expectation.docId) ? rec.docId : null;
    return out;
  }
  // OBSERVED：文档主键必须与请求一致
  out.docId = typeof rec.docId === 'string' && rec.docId.length > 0 ? rec.docId : null;
  out.docIdMatches = out.docId !== null && out.docId === expectation.docId;
  // userId：仅当该记录类型**要求**它时才校验（users 记录没有这个字段）
  if (expectation.userIdPattern) {
    if (typeof rec.userId === 'string' && expectation.userIdPattern.test(rec.userId)) {
      out.userId = rec.userId;
    }
    /**
     * T1：**必须严格为 `true`**，不能只检查「不是 false」。
     *
     * 上一版写 `rec.userIdShapeValid !== false`，把「缺失 / null / 0 / 空串」
     * 这些**并非明确通过**的损坏协议值一律当成通过 —— 与交付说明和函数注释
     * 声称的「严格 true、不再混用 `!== false`」不一致。
     * 现在只有 worker 明确给出 `true` 才算通过；`userIdPattern` 为 null 的
     * users 记录仍保持「不适用」，不新增 users.userId 要求。
     */
    out.userIdShapeValid = out.userId !== null && rec.userIdShapeValid === true;
  } else {
    out.userIdShapeValid = null; // 不适用（users 记录本来就没有 userId 字段）
  }
  // status：白名单
  if (typeof rec.status === 'string' && expectation.statusValues.includes(rec.status)) {
    out.status = rec.status;
  }
  // T1：同上 —— 只有明确为 true 才算通过
  out.statusValid = out.status !== null && rec.statusValid === true;
  /**
   * 字段完整性：按**记录类型**要求不同字段。
   * `expectation.requiredFields` 明确列出该记录必须具备什么：
   *   - primary：文档主键 + userId 形状 + 状态；
   *   - users  ：文档主键 + 状态（**本来就没有 userId 字段**，
   *     身份派生由 derivationMatches/derivationChecked 表达）。
   */
  const required = Array.isArray(expectation.requiredFields) ? expectation.requiredFields : [];
  out.fieldCompleteness = required.length > 0 && required.every(k => out[k] === true)
    ? 'COMPLETE' : 'INCOMPLETE';
  if (out.fieldCompleteness === 'INCOMPLETE') {
    // 告诉解释层：这不是「形状坏了」，而是**记录本身字段缺失/非法**，
    // 让它能逐项写明原因而不是只给一个笼统分类。
    out.degradedByFieldCompleteness = true;
    out.classification = 'UNCONFIRMED';
  }
  return out;
}

/**
 * S2：worker `errorCode` 的**有限映射**。
 *
 * 只保留本工具自己定义、语义明确的错误码；worker 传来的其它字符串
 * （可能是平台自由文本）一律换成固定失败码，**不原样外传**。
 */
/**
 * 读取失败诊断：**逐字段重建**（worker 与 observer 两层都显式投影）。
 *
 * 只保留四个固定字段：读取阶段（枚举）、有限的异常名称分类（枚举）、
 * 白名单错误码、合法 requestId。
 * 缺项一律归未知（`UNKNOWN` / `OTHER` / `null`）——
 * 不透传 error 对象、message/stack/cause、请求体/头、URL、凭据、OPENID
 * 或任意外部字符串；**不**据此猜测平台拒绝或集合不存在。
 *
 * 白名单以 `@cloudbase/database` 1.4.1 固定源码为依据：
 * `src/const/code.ts` 的 `ERRORS`（源码确定）+ 本工具自有码。
 * 平台侧未验证的错误码不在白名单内，一律归 `OTHER`。
 *
 * 注意：这份白名单与 `WORKER_ERROR_CODE_ALLOWLIST`（记录级 errorCode）**有意不同** ——
 * 后者是worker 自身失败码，这里是 SDK 读取失败时可能出现的码。
 */
const READ_STAGES = Object.freeze(['PRIMARY_READ', 'TARGET_USER_READ']);
const LOCAL_ERROR_CLASSES = Object.freeze([
  'LOCAL_TYPE_ERROR', 'LOCAL_REFERENCE_ERROR', 'LOCAL_SYNTAX_ERROR',
  'NOT_AN_ERROR', 'UNKNOWN'
]);
const READ_ERROR_CODES = Object.freeze(new Set([
  'DATABASE_REQUEST_FAILED', 'DATABASE_TRANSACTION_CONFLICT', 'INVALID_PARAM',
  'CONN_ERROR', 'CREATE_WATCH_NET_ERROR', 'CREATE_WACTH_EXCEED_ERROR',
  'CREATE_WATCH_SERVER_ERROR',
  'SDK_UNAVAILABLE', 'READ_FAILED', 'CREDENTIAL_MISSING',
  'CREDENTIAL_SHAPE_INVALID', 'CREDENTIAL_NOT_TEMPORARY', 'CREDENTIAL_EXPIRED',
  'TARGET_USER_ID_INVALID'
]));

function rebuildReadDiagnostics(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    readStage: READ_STAGES.includes(raw.readStage) ? raw.readStage : 'UNKNOWN',
    localErrorClass: LOCAL_ERROR_CLASSES.includes(raw.localErrorClass)
      ? raw.localErrorClass : 'UNKNOWN',
    errorCode: typeof raw.errorCode === 'string' && READ_ERROR_CODES.has(raw.errorCode)
      ? raw.errorCode : 'OTHER',
    requestId: safeRequestId(raw.requestId)
  };
}

const WORKER_ERROR_CODE_ALLOWLIST = new Set([
  'CREDENTIAL_MISSING', 'CREDENTIAL_SHAPE_INVALID', 'CREDENTIAL_NOT_TEMPORARY',
  'CREDENTIAL_EXPIRED', 'TARGET_USER_ID_INVALID', 'SDK_UNAVAILABLE', 'READ_FAILED',
  'OUTPUT_SERIALIZE_FAILED', 'OUTPUT_OVERFLOW', 'WORKER_UNEXPECTED', 'BAD_STDIN'
]);

/** 已知错误码原样保留，未知/缺失一律映射为固定失败码。 */
function mapWorkerErrorCode(code) {
  if (typeof code !== 'string' || code.length === 0) return null;
  return WORKER_ERROR_CODE_ALLOWLIST.has(code) ? code : ERR.WORKER_FAILED;
}

function stdoutToText(buf) {
  if (!buf || buf.length === 0) return '';
  try {
    return Buffer.concat(Array.isArray(buf) ? buf : [buf]).toString('utf8');
  } catch (_) {
    return '';
  }
}

/* ── M2：记录核对（只读固定目标） ───────────────────────────────────── */

/**
 * 归一化 `primary` 观测结论。
 *
 * R3 返修要点：上一版只检查 `userIdShapeValid === false`，而 worker 在字段缺失时
 * 给的是 `null`，于是 `userId:null, status:null` 被放行成 OBSERVED。
 * 现在**只信任净化后的严格布尔**：`userIdShapeValid`/`statusValid`/`docIdMatches`
 * 必须**严格为 true**，否则直接降级 UNCONFIRMED 并写明原因。
 *
 * - 0 条 → 本次未找到（**不**推出集合从未存在或历史无人初始化），单列 NOT_FOUND；
 * - 1 条 → 要求主键为 `primary`、`userId` 完整、状态合法；
 * - 多条 / 坏形状 → 不可信。
 */
function interpretPrimary(workerResult, targetUserId) {
  if (!workerResult || workerResult.ok !== true) {
    const out = { status: 'UNCONFIRMED', classification: null, docId: null, userId: null, status_field: null, conflictsWithTarget: false, reasons: [] };
    out.errorCode = (workerResult && workerResult.errorCode) || ERR.PRIMARY_UNCONFIRMED;
    out.reasons.push('worker 未成功完成，primary 结论不可用');
    return out;
  }
  if (!workerResult.primary) {
    const out = { status: 'UNCONFIRMED', classification: null, docId: null, userId: null, status_field: null, conflictsWithTarget: false, reasons: [] };
    out.errorCode = ERR.PRIMARY_UNCONFIRMED;
    out.reasons.push('worker 未返回 primary 记录');
    return out;
  }
  // S1：已净化记录直接复用（净化幂等），不再净化一次丢原因
  const rawPrimary = workerResult.primary;
  const p = isSanitizedRecord(rawPrimary)
    ? rawPrimary
    : sanitizeWorkerRecord(rawPrimary, PRIMARY_KEY_EXPECTATION);
  const out = {
    status: 'UNCONFIRMED',
    classification: p.classification,
    docId: p.docId,
    userId: p.userId,
    status_field: p.status,
    conflictsWithTarget: false,
    reasons: [],
    fieldCompleteness: p.fieldCompleteness,
    hasPlatformError: p.hasPlatformError === true,
    // 读取失败最小诊断：两层各自重建后贯穿到顶层（非读取失败时为 null）
    readDiagnostics: p.readDiagnostics || null
  };
  // R3：净化层因**字段缺失/非法**而降级时，仍须逐项写明原因，
  // 不能只留一个笼统的「UNCONFIRMED」让调用方看不出缺了什么。
  if (p.degradedByFieldCompleteness === true) {
    if (p.docIdMatches !== true) out.reasons.push('文档主键与请求不符');
    if (p.userIdShapeValid !== true) out.reasons.push('userId 缺失或不是完整 userId');
    if (p.statusValid !== true) out.reasons.push('状态缺失或取值非法');
    if (p.status !== 'active') out.reasons.push('primary 状态不是 active');
    if (targetUserId && p.userId && p.userId !== targetUserId) {
      out.conflictsWithTarget = true;
      out.reasons.push('primary 已绑定其他人');
    }
    out.errorCode = out.conflictsWithTarget ? ERR.PRIMARY_CONFLICT : ERR.PRIMARY_UNCONFIRMED;
    return out;
  }
  if (p.classification !== 'OBSERVED') {
    out.status = p.classification === 'NOT_FOUND' ? 'NOT_FOUND' : 'UNCONFIRMED';
    if (p.reason) out.reasons.push(p.reason);
    if (p.hasPlatformError) out.reasons.push('平台返回错误响应（不作为空记录）');
    if (out.status === 'UNCONFIRMED') out.errorCode = p.errorCode || ERR.PRIMARY_UNCONFIRMED;
    return out;
  }
  // 到这里 classification 必为 OBSERVED；但字段完整性必须**逐项**再确认
  if (p.docIdMatches !== true) out.reasons.push('文档主键与请求不符');
  if (p.userIdShapeValid !== true) out.reasons.push('userId 缺失或不是完整 userId');
  if (p.statusValid !== true) out.reasons.push('状态缺失或取值非法');
  if (p.status !== 'active') out.reasons.push('primary 状态不是 active');
  // primary 绑定的人与「受信指定目标」是**两件事**：不自动把当前绑定者选作目标
  if (targetUserId && p.userId && p.userId !== targetUserId) {
    out.conflictsWithTarget = true;
    out.reasons.push('primary 已绑定其他人');
  }
  if (out.reasons.length > 0) {
    out.status = 'UNCONFIRMED';
    out.errorCode = out.conflictsWithTarget ? ERR.PRIMARY_CONFLICT : ERR.PRIMARY_UNCONFIRMED;
  } else {
    // R3：只有**每一项**都通过才是 OBSERVED；不得因为「没写原因」而默认通过，
    // 也不得因为「初始化为 UNCONFIRMED」而永远无法通过。
    out.status = 'OBSERVED';
    out.errorCode = null;
  }
  return out;
}

/**
 * 判断一条记录是否**已经**被 `sanitizeWorkerRecord` 净化过。
 *
 * S1：净化是**幂等**的。把已净化的记录再净化一次会丢掉失败原因 ——
 * 第二次净化时 `classification` 已是 `UNCONFIRMED`（不再是 OBSERVED），
 * 于是走「非 OBSERVED」早退分支，`reasons` 全丢，只剩一个笼统分类。
 * 这正是 Codex 报告的「两层处理丢失失败原因」。
 */
function isSanitizedRecord(rec) {
  return isPlainObject(rec) && Object.prototype.hasOwnProperty.call(rec, 'fieldCompleteness') &&
    Object.prototype.hasOwnProperty.call(rec, 'docIdMatches');
}

/**
 * 归一化指定 users 观测结论。派生一致**只**证明记录自洽。
 *
 * R3：同 primary —— `statusValid`/`openidShapeValid`/`derivationMatches` 必须**严格**
 * 为 true；`derivationMatches:false` 必须写明失败原因，不允许「既报 false 又无原因」。
 */
function interpretTargetUser(workerResult, targetUserId) {
  if (!targetUserId) {
    return { status: 'NOT_EXECUTED_TARGET_UNCONFIRMED', classification: null, docId: null, userStatus: null, derivationMatches: null, reasons: [] };
  }
  if (!workerResult || workerResult.ok !== true || !workerResult.targetUser) {
    const out = { status: 'UNCONFIRMED', classification: null, docId: targetUserId, userStatus: null, derivationMatches: null, reasons: ['worker 未成功完成，users 结论不可用'] };
    out.errorCode = (workerResult && workerResult.errorCode) || ERR.PRIMARY_UNCONFIRMED;
    return out;
  }
  // S1：与 `interpretWorkerOutput` 用**同一个** users 契约；
  // 若记录已被净化过则**直接复用**，不再净化一次（净化是幂等的）
  const raw = workerResult.targetUser;
  const u = isSanitizedRecord(raw)
    ? raw
    : sanitizeWorkerRecord(raw, makeUsersExpectation(targetUserId));
  const out = {
    status: 'UNCONFIRMED',
    classification: u.classification,
    docId: targetUserId,
    userStatus: u.status,
    derivationMatches: u.derivationMatches,
    derivationChecked: u.derivationChecked === true,
    // 只透出**布尔结论**，绝不透出 openid 原值或其派生原文
    openidPresent: u.openidPresent === true,
    reasons: [],
    fieldCompleteness: u.fieldCompleteness,
    hasPlatformError: u.hasPlatformError === true,
    // 读取失败最小诊断（同primary，两层各自重建）
    readDiagnostics: u.readDiagnostics || null
  };
  // R3：与 primary 同理 —— 字段缺失/非法须逐项写明原因
  const userReasons = [];
  if (u.docIdMatches !== true) userReasons.push('文档主键与请求不符');
  if (u.statusValid !== true) userReasons.push('状态缺失或取值非法');
  if (u.status !== 'active') userReasons.push('用户已停用或状态非法');
  if (u.openidShapeValid !== true) userReasons.push('openid 缺失，无法核对身份派生');
  if (u.derivationChecked !== true) userReasons.push('未执行身份派生核对');
  else if (u.derivationMatches !== true) userReasons.push('身份派生不一致');
  if (u.degradedByFieldCompleteness === true) {
    out.reasons = userReasons;
    out.errorCode = u.derivationMatches === false ? ERR.USER_DERIVATION_MISMATCH : ERR.PRIMARY_UNCONFIRMED;
    return out;
  }
  if (u.classification !== 'OBSERVED') {
    out.status = u.classification === 'NOT_FOUND' ? 'NOT_FOUND' : 'UNCONFIRMED';
    if (u.reason) out.reasons.push(u.reason);
    if (u.hasPlatformError) out.reasons.push('平台返回错误响应（不作为空记录）');
    if (out.status === 'UNCONFIRMED') out.errorCode = u.errorCode || ERR.USER_DERIVATION_MISMATCH;
    return out;
  }
  out.reasons = userReasons;
  if (out.reasons.length > 0) {
    out.status = 'UNCONFIRMED';
    out.errorCode = u.derivationMatches === false ? ERR.USER_DERIVATION_MISMATCH : ERR.PRIMARY_UNCONFIRMED;
  } else {
    out.status = 'OBSERVED';
    out.errorCode = null;
  }
  return out;
}

/* ── M3：编排入口 ──────────────────────────────────────────────────── */

/**
 * 显式只读运行（M1+M2）。
 *
 * 顺序：本地准备 → 取**一次**凭据 → 同批 CLI 关联 → 同批 SDK 读取 → 记录核对。
 * 每阶段前后检查凭据未过期；失效即停止并记录未完成，**不混用新旧结果**。
 */
async function runReadOnlyObservation(options, deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const runId = newRunId();
  const targetUserId = (options && options.targetUserId) || null;

  const report = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    observedAt: new Date(now()).toISOString(),
    mode: 'read-only',
    status: STATUS.INCOMPLETE,
    stoppedAt: null,
    errorCode: null,
    // 分层输出
    localPreparation: { status: 'UNKNOWN', checks: [], sdkFiles: [] },
    sameBatchCredential: { status: 'NOT_ATTEMPTED', proven: false, expiresAtIso: null, refreshed: false },
    cliAssociation: { status: 'NOT_ATTEMPTED' },
    primaryObservation: { status: 'NOT_ATTEMPTED' },
    targetUserObservation: { status: 'NOT_EXECUTED_TARGET_UNCONFIRMED' },
    incomplete: [],
    // 恒定边界
    writeAuthorized: false,
    productionCallerVerifierImplemented: false
  };

  // ── 步骤 1：本地准备 ──
  let local;
  try {
    local = await runLocalCheck({ fixed: d.fixed, now });
  } catch (error) {
    report.stoppedAt = 'localPreparation';
    report.errorCode = error.code || ERR.FIXED_PATH_MISSING;
    report.status = STATUS.FAILED;
    return report;
  }
  report.localPreparation = local.localPreparation;
  if (local.status !== STATUS.LOCAL_READY) {
    report.stoppedAt = 'localPreparation';
    report.errorCode = ERR.FIXED_PATH_MISSING;
    report.status = STATUS.FAILED;
    report.incomplete.push('本地固定项未通过，未取凭据、未发起任何云调用。');
    return report;
  }

  // ── 步骤 2：取一次凭据（内存快照；H2 固定宿主） ──
  let snapshot = null;
  try {
    const fetched = await fetchTemporaryCredential({ deps: d, now });
    snapshot = fetched.snapshot;
    report.sameBatchCredential = {
      status: fetched.evidenceKind === 'SYNTHETIC_INJECTION' ? 'FETCHED_SYNTHETIC' : 'FETCHED',
      // R3/H3：只有真实受审宿主执行才可能为 true；依赖注入固定为 false
      proven: fetched.proven === true,
      evidenceKind: fetched.evidenceKind || null,
      expiresAtIso: snapshot.expiresAtIso,
      /**
       * H3：`refreshed:false` 只指**取得快照之后**。
       * 官方 CLI 在获取过程中**是否**刷新过自己的登录缓存，本轮未观测 → 标 `null`（未知），
       * **不得**由「取得后未刷新」推断「获取过程绝不刷新」。
       */
      refreshed: false,
      refreshDuringFetchObserved: null,
      source: fetched.source || null,
      /**
       * R3：由**实际启动点**回报，不再写死。
       * - 未获准/前置拒绝 → 未启动子进程 → false；
       * - 合成注入 → 明确标注「模拟」，不是实际启动；
       * - 真实宿主候选 → 启动过凭据命令 → true。
       *
       * 启动子进程 ≠ 请求已到达平台，故未知请求数**不填 0**。
       */
      fetchSubprocessAttempted: fetched.fetchAttempted === true,
      fetchMode: fetched.fetchMode || 'NONE',
      fetchRequestCountKnown: false,
      // 成功分支也保留已发生的退出/计数事实（R3）
      fetchDiagnostics: rebuildFetchDiagnostics(fetched.fetchDiagnostics)
    };
  } catch (error) {
    report.stoppedAt = 'sameBatchCredential';
    report.status = STATUS.FAILED;
    // R3：错误码白名单化；**不**传播 error.code / error.detail 的任意值
    report.errorCode = classifyFetchFailure(error);
    report.sameBatchCredential = {
      status: 'FAILED',
      proven: false,
      evidenceKind: null,
      expiresAtIso: null,
      refreshed: false,
      refreshDuringFetchObserved: null,
      source: null,
      // 前置拒绝（未获准/指纹不符/cwd不安全）时为 false：确实没启动过子进程
      fetchSubprocessAttempted: error.fetchAttempted === true,
      // S2：fetchMode 按固定枚举重建 —— 异常对象上的任意字符串不得原样进入报告
      fetchMode: normalizeFetchMode(error.fetchMode),
      fetchRequestCountKnown: false,
      fetchErrorClass: normalizeFetchErrorClass(error),
      // 逐字段重建固定事实；解析失败时也保留已发生的退出码/计数
      fetchDiagnostics: rebuildFetchDiagnostics(error.fetchExitFacts)
    };
    report.incomplete.push('未能取得合规临时凭据，未进入后续身份关联与数据库读取。');
    return report;
  }

  // ── 步骤 3：同批 CLI 关联（隔离目录） ──
  let association = null;
  let isolationDir = null;
  try {
    assertCredentialFresh(snapshot, now());
    isolationDir = createIsolationDir(runId, d);
    assertIsolationClean(isolationDir);
    association = await runCliAssociation(snapshot, isolationDir, d);
    report.cliAssociation = {
      status: association.matched ? 'MATCHED' : 'FAILED',
      accountIdSha256: association.accountIdSha256,
      accountIdTail: association.accountIdTail,
      uinSha256: association.uinSha256,
      uinTail: association.uinTail,
      requestIds: association.requestIds,
      stages: association.stages
    };
  } catch (error) {
    report.stoppedAt = 'cliAssociation';
    report.errorCode = error.code || ERR.CLI_ASSOCIATION_FAILED;
    report.status = STATUS.FAILED;
    report.incomplete.push('CLI 关联未完成，未进入数据库读取。');
    return report;
  }
  if (!association.matched) {
    report.stoppedAt = 'cliAssociation';
    report.errorCode = ERR.CLI_ASSOCIATION_FAILED;
    report.status = STATUS.FAILED;
    report.incomplete.push('账号/环境/AppID 关联未通过，按失败处理且不进入数据库读取。');
    return report;
  }
  // R4：CLI 关联**之后**再核对一次有效期（任务要求的前后检查）
  try {
    assertCredentialFresh(snapshot, now());
  } catch (error) {
    report.stoppedAt = 'cliAssociation';
    report.errorCode = error.code || ERR.CREDENTIAL_EXPIRED;
    report.status = STATUS.FAILED;
    report.incomplete.push('CLI 关联完成后凭据已过期，未进入数据库读取；已完成部分保留为带时间的部分事实。');
    return report;
  }

  // ── 步骤 4：同批 SDK 读取 ──
  let workerResult;
  try {
    assertCredentialFresh(snapshot, now());
    workerResult = await runWorker(snapshot, targetUserId, d);
  } catch (error) {
    report.stoppedAt = 'primaryObservation';
    report.errorCode = error.code || ERR.WORKER_FAILED;
    report.status = STATUS.FAILED;
    report.incomplete.push('SDK 只读 worker 未完成。');
    // S3：抛错路径同样要做时效复核；保留原始失败原因，不重新获取凭据
    try {
      assertCredentialFresh(snapshot, now());
    } catch (_) {
      report.incomplete.push('worker 失败收尾时复核发现凭据已过期：原始失败原因按原样保留。');
    }
    return report;
  }

  /**
   * S3：worker **返回之后**，父进程用当前时钟**再核对一次**同批凭据。
   *
   * 上一版只依赖 worker 回报的 `credentialExpiredDuringRun` 布尔值 ——
   * worker 最后一次检查之后到父进程汇总之间的那段过期完全没被覆盖。
   * 这里用父进程自己的时钟复核，并保留 worker 的原始失败原因与退出事实。
   *
   * 过期时**不丢弃**已完成的部分事实：把记录结论保留为「带时间标记的部分观测」，
   * 同时明确不得升级为完整核验。
   */
  let expiredAfterWorker = false;
  try {
    // 只取**一次**时钟快照：同一检查里多次调用 now() 会让受控时钟口径漂移，
    // 也让「检查发生的时刻」变得不确定。
    assertCredentialFresh(snapshot, now());
  } catch (_) {
    expiredAfterWorker = true;
  }

  // R3：worker 失败必须**先**反映到顶层，不能让 UNCONFIRMED 记录被汇总成 OBSERVED
  if (!workerResult || workerResult.ok !== true) {
    const wc = (workerResult && workerResult.errorCode) || ERR.WORKER_FAILED;
    report.stoppedAt = 'primaryObservation';
    report.errorCode = wc;
    report.status = STATUS.FAILED;
    report.primaryObservation = {
      status: 'UNCONFIRMED', classification: null, docId: null, userId: null,
      status_field: null, conflictsWithTarget: false,
      reasons: ['worker 未成功完成，记录核对无结论'],
      errorCode: wc, writeAttemptsCount: workerResult ? workerResult.writeAttemptsCount : null
    };
    report.targetUserObservation = targetUserId
      ? { status: 'UNCONFIRMED', classification: null, docId: targetUserId, userStatus: null, derivationMatches: null, reasons: ['worker 未成功完成，记录核对无结论'], errorCode: wc }
      : { status: 'NOT_EXECUTED_TARGET_UNCONFIRMED', classification: null, docId: null, userStatus: null, derivationMatches: null, reasons: [] };
    report.incomplete.push(`SDK 只读 worker 未成功完成（${wc}），未取得任何可用记录结论。`);
    // S3：失败收尾也要核时效 —— 保留原始失败，不因过期改写它
    if (expiredAfterWorker) {
      report.incomplete.push('worker 返回后复核发现凭据已过期：以上失败事实按原样保留，不重新获取凭据。');
    }
    return report;
  }
  // 写次数必须**严格**为 0（代码级窄包装 + 陷阱的结果）
  if (workerResult.writeAttemptsCount !== 0) {
    report.stoppedAt = 'primaryObservation';
    report.errorCode = ERR.WORKER_WRITE_ATTEMPTED;
    report.status = STATUS.FAILED;
    report.incomplete.push('检测到写入口调用，本工具为只读，立即停止。');
    if (expiredAfterWorker) {
      report.incomplete.push('worker 返回后复核发现凭据已过期：写次数事实按原样保留。');
    }
    return report;
  }
  // R4/S3：worker 自报过期 **或** 父进程复核发现过期 → 不升级为完整核验
  const expiredDuringRun = workerResult.credentialExpiredDuringRun === true || expiredAfterWorker;

  report.primaryObservation = Object.assign(
    interpretPrimary(workerResult, targetUserId),
    { writeAttemptsCount: workerResult.writeAttemptsCount }
  );
  report.targetUserObservation = interpretTargetUser(workerResult, targetUserId);

  // ── 步骤 5：汇总 ──
  const incomplete = [];
  // R3：同批链的两种证据**分开**表述；测试注入不得产生生产 proven
  if (report.sameBatchCredential.proven !== true) {
    incomplete.push('同批凭据链在本次离线实现中**未获生产证实**（需受审宿主真实执行）。');
  }
  if (!targetUserId) {
    incomplete.push('未提供受信指定目标：users 记 NOT_EXECUTED_TARGET_UNCONFIRMED，整体记录核对**不得**标完整。');
  }
  // R3：任何非 OBSERVED 的记录结论都必须进入总状态，不得被汇总掩盖
  if (report.primaryObservation.status !== 'OBSERVED') {
    incomplete.push(`primary 结论为 ${report.primaryObservation.status}，整体记录核对不得标完整。`);
  }
  if (targetUserId && report.targetUserObservation.status !== 'OBSERVED') {
    incomplete.push(`指定用户结论为 ${report.targetUserObservation.status}，整体记录核对不得标完整。`);
  }
  if (report.primaryObservation.conflictsWithTarget) {
    incomplete.push('primary 已绑定其他人：报告冲突，不覆盖、不新增。');
  }
  if (expiredDuringRun) {
    // S3：区分「worker 运行期间」与「worker 返回后父进程复核」两个来源
    incomplete.push(expiredAfterWorker
      ? 'worker 返回后父进程复核发现凭据已过期：已完成观测只作为带时间的部分事实，不升级为完整核验。'
      : '凭据在 worker 运行期间过期：已完成观测只作为带时间的部分事实，不升级为完整核验。');
  }
  if (workerResult.credentialExpiryMissing === true) {
    incomplete.push('worker 未获得可用截止时间，零读取：记录核对无任何观测。');
  }
  report.incomplete = incomplete;
  report.status = incomplete.length === 0 ? STATUS.OBSERVED : STATUS.INCOMPLETE;
  return report;
}

/**
 * 取一次临时凭据。
 *
 * R1 返修要点：交付状态必须诚实。
 * 上一版的生产路径**始终**抛 `SAME_BATCH_NOT_PROVEN`，看起来像「完整实现后的平台验证缺口」，
 * 实际是**获取宿主根本没实现** —— `--read-only` 再执行一次也不可能完成。
 * 现在分成两件明确的事：
 *
 * 1. **公共入口身份来源已有限度离线证据**（不再写「本轮未完成」）：合成 Web 登录态
 *    经真实公共入口可产出快照，命令附加行为已记录（见 `publicEntryEvidence.notCovered`
 *    列出的未覆盖项，含仍未解决的刷新分支）。但这**不等于**生产身份接入已证实。
 * 2. **依赖注入不是生产证据**：`deps.fetchCredential` 只供离线测试。
 *    R3：注入得到的快照**不得**把 `proven` 置为 true。上一版仅提供注入函数即
 *    `proven:true`，同批链还没执行就标已证实。
 */
/**
 * 取一次临时凭据（H2 宿主接线）。
 *
 * 三条路径，结论**分开**表述：
 * 1. `deps.fetchCredential`：**仅**离线测试/受审宿主注入。产出固定为
 *    `proven:false` + `evidenceKind:'SYNTHETIC_INJECTION'` —— 依赖注入**不是**生产证据。
 * 2. 固定公共 CLI 宿主已实现，离线前置有**有限度**证据（合成 Web 登录正向与附加行为，
 *    但刷新分支仍未产出完整快照）：
 *    走 `credentialHost.fetchTemporaryCredential`，产出 `proven:false` +
 *    `evidenceKind:'PUBLIC_ENTRY_CANDIDATE'`。**候选实现未经真实运行**，
 *    且「一次调用链同批」还需真实受审宿主实测才能成立。
 *    R3 提醒：把 `proven` 改成 true 并**不能**得到生产证明 —— 汇总层当前没有任何
 *    升级分支，`proven` 所有返回恒为 false；真实接续前仍须明确实际观察事实如何形成。
 * 3. 候选路径尚未放行 / 前置未齐时：如实停止，**不**自动放通。
 *    这是实现前置状态，**不是**「用户未给只读授权」，不要求用户重复授权。
 */
async function fetchTemporaryCredential(options) {
  const opts = options || {};
  const d = opts.deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();

  // 路径 1：注入点（仅离线测试/受审宿主）
  if (typeof d.fetchCredential === 'function') {
    const stdout = await d.fetchCredential({ now, limits: LIMITS.cli });
    const snapshot = parseSecretsPayload(stdout, now(), MIN_REMAINING_MS);
    return {
      snapshot, proven: false,
      evidenceKind: 'SYNTHETIC_INJECTION',
      source: 'deps:fetchCredential',
      // R3：注入**没有启动**任何子进程 → attempted 必须为 false，并标注为模拟。
      // 这样报告能区分「未尝试 / 模拟 / 实际启动」，不会把注入当成真实执行。
      fetchAttempted: false,
      fetchMode: 'SIMULATED',
      fetchDiagnostics: null
    };
  }

  // 未获准执行真实获取：保持关闭。
  // R3：这是**候选路径尚未放行 / 前置未齐**，不是「用户没给只读授权」——
  // 既有只读授权不消除实现前置缺口，因此不要求用户重复授权。
  if (d.allowRealCredentialFetch !== true) {
    // 前置拒绝发生在**启动凭据命令之前** → attempted 明确为 false
    const closed = new SdkReadonlyError(ERR.PUBLIC_ENTRY_IDENTITY_UNPROVEN,
      '真实凭据获取路径尚未放行：候选宿主实现存在，但真实执行前置尚未齐备（公共 CLI 身份选择' +
      '与刷新分支输出契约仍有未解决缺口）。既有只读授权不消除这些实现前置，因此无需重复授权。');
    closed.fetchAttempted = false;
    closed.fetchMode = 'NONE';
    throw closed;
  }

  // 路径 2：固定宿主候选实现（真实执行需受审宿主显式开启）
  // `host` 已在模块层 require（本地准备报告也要引用它的指纹）
  const fetched = await host.fetchTemporaryCredential({
    deps: d,
    cwd: opts.cwd || null
  });
  return {
    // R1 归一（唯一交界处）：宿主按 CLI 输出字段名返回 `token`，而本编排库的
    // 快照契约是 `sessionToken`（CLI 关联环境与 worker stdin 都读它）。
    // 在这里归一，**不改** worker、不让消费者兼容第二套字段名、不放宽身份校验。
    snapshot: normalizeCredentialSnapshot(fetched.snapshot),
    proven: false,
    evidenceKind: 'PUBLIC_ENTRY_CANDIDATE',
    source: 'host:secrets-get-json',
    fetchDiagnostics: fetched.diagnostics,
    // R3：由**实际启动点**回报，不是固定值
    fetchAttempted: fetched.attempted === true,
    fetchMode: 'REAL_CANDIDATE',
    fetchExitFacts: fetched.exitFacts || null
  };
}

/**
 * R3：把获取阶段的进程事实**逐字段重建**为固定形状。
 *
 * 绝不直接透传 `error.detail` —— 那是附加对象，可能含原始 stdout、路径内凭据
 * 或任意文本。只保留：有限计数、布尔结论、退出码（数字）与信号（固定白名单）。
 * 任何缺失一律记为 `null`，不猜 0。
 */
function rebuildFetchDiagnostics(raw) {
  if (!isPlainObject(raw)) return null;
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const signals = new Set([null, 'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']);
  return {
    exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    signal: signals.has(raw.signal) ? raw.signal : null,
    timedOut: bool(raw.timedOut),
    overflow: bool(raw.overflow),
    closeNotObserved: bool(raw.closeNotObserved),
    terminationRequested: bool(raw.terminationRequested),
    terminationConfirmed: bool(raw.terminationConfirmed),
    spawnFailed: bool(raw.spawnFailed),
    stdoutBytes: count(raw.stdoutBytes),
    stderrBytes: count(raw.stderrBytes)
  };
}

/**
 * S2：获取模式的**固定枚举**。
 *
 * 只有这三种取值合法。异常对象上的任意字符串（例如合成的私有标记）一律
 * 归为 `UNKNOWN`，**不保留原字符串** —— detail 已净化不代表新增字段也净化。
 */
const FETCH_MODES = Object.freeze(['NONE', 'SIMULATED', 'REAL_CANDIDATE']);

/**
 * S2：`fetchMode` 枚举过滤。
 * 未知/缺失/非字符串 → `UNKNOWN`（固定分类，不回传原值）。
 */
function normalizeFetchMode(value) {
  return typeof value === 'string' && FETCH_MODES.includes(value) ? value : 'UNKNOWN';
}

/**
 * S2：获取失败分类。
 *
 * 白名单**直接取自宿主实际导出的 `ERR` 常量值**（`host.ERR`），不再手抄一组
 * 近似名字 —— 上一轮手抄导致 `CREDENTIAL_COMMAND_TIMEOUT` 被误写成
 * `CREDENTIAL_TIMEOUT`、`CREDITAL_SIGNALED` 又有拼写残留，全部退化为泛化失败。
 * 另加本模块自身的两个错误码。未知值一律映射为 `CREDENTIAL_FETCH_FAILED`。
 */
const FETCH_ERROR_CLASSES = Object.freeze(
  Object.keys(host.ERR).map(k => host.ERR[k]).filter(v => typeof v === 'string')
    .concat([ERR.CREDENTIAL_FETCH_FAILED, ERR.PUBLIC_ENTRY_IDENTITY_UNPROVEN])
);

function classifyFetchFailure(error) {
  if (!error || typeof error !== 'object') return ERR.CREDENTIAL_FETCH_FAILED;
  // 优先用宿主已收敛过的分类
  if (typeof error.errorClass === 'string' && FETCH_ERROR_CLASSES.includes(error.errorClass)) {
    return error.errorClass;
  }
  if (typeof error.code === 'string' && FETCH_ERROR_CLASSES.includes(error.code)) {
    return error.code;
  }
  return ERR.CREDENTIAL_FETCH_FAILED;
}

/**
 * S2：错误对象上的分类同样要走白名单。
 * 防止异常把任意 `errorClass` 伪装成已知码带进报告。
 */
function normalizeFetchErrorClass(error) {
  const code = classifyFetchFailure(error);
  return FETCH_ERROR_CLASSES.includes(code) ? code : ERR.CREDENTIAL_FETCH_FAILED;
}

/**
 * R1：把宿主快照归一为本编排库的既有契约。
 *
 * 两种获取路径（合成注入与真实宿主候选）必须得到**同一**内部结构：
 * `secretId` / `secretKey` / `sessionToken` / `expiresAtMs` / `expiresAtIso`。
 * 时效字段原样保留 —— worker 依赖 `expiresAtMs` 在两条读取之间独立复核。
 *
 * **真实归一规则（如实描述）**：优先接受已是快照契约的 `sessionToken`；
 * 否则取 CLI 输出字段名 `token` —— 这正是公共`secrets get --json` 的实际形状，
 * 也是本函数存在的目的。两者都缺失才拒绝。
 *
 * 刻意**不**做形状之外的「修复」：`secretId` / `secretKey` / 到期时间缺失或类型不符
 * 一律拒绝，不用其它来源补齐。`token` 在此是**受控的映射来源**，不是静默兜底 ——
 * 它只在唯一预期的一种来源形状下生效。
 */
function normalizeCredentialSnapshot(raw) {
  if (!isPlainObject(raw)) {
    fail(ERR.CREDENTIAL_FETCH_FAILED, '凭据来源未返回可用快照。');
  }
  const token = typeof raw.sessionToken === 'string' && raw.sessionToken.length > 0
    ? raw.sessionToken
    : (typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : null);
  if (typeof raw.secretId !== 'string' || raw.secretId.length === 0 ||
    typeof raw.secretKey !== 'string' || raw.secretKey.length === 0 ||
    token === null || typeof raw.expiresAtMs !== 'number' || !Number.isFinite(raw.expiresAtMs)) {
    fail(ERR.CREDENTIAL_FETCH_FAILED, '凭据快照字段不完整，未做补齐即停止。');
  }
  return {
    secretId: raw.secretId,
    secretKey: raw.secretKey,
    sessionToken: token,
    expiresAtMs: raw.expiresAtMs,
    expiresAtIso: typeof raw.expiresAtIso === 'string'
      ? raw.expiresAtIso
      : new Date(raw.expiresAtMs).toISOString()
  };
}

module.exports = Object.freeze({
  FIXED,
  LIMITS,
  MIN_REMAINING_MS,
  SCHEMA_VERSION,
  STATUS,
  ERR,
  STAGES,
  SdkReadonlyError,
  parseArgs,
  checkLocalReadiness,
  runLocalCheck,
  parseSecretsPayload,
  assertCredentialFresh,
  authStatePaths,
  assertIsolationClean,
  createIsolationDir,
  buildIsolatedEnv,
  runCliAssociation,
  runWorker,
  interpretWorkerOutput,
  sanitizeWorkerRecord,
  PRIMARY_KEY_EXPECTATION,
  normalizeCredentialSnapshot,
  rebuildFetchDiagnostics,
  classifyFetchFailure,
  normalizeFetchMode,
  rebuildReadDiagnostics,
  READ_STAGES,
  LOCAL_ERROR_CLASSES,
  READ_ERROR_CODES,
  normalizeFetchErrorClass,
  FETCH_MODES,
  makeUsersExpectation,
  isSanitizedRecord,
  mapWorkerErrorCode,
  safeRequestId,
  REQUEST_ID_UUID_V4,
  interpretPrimary,
  interpretTargetUser,
  fetchTemporaryCredential,
  runReadOnlyObservation
});