#!/usr/bin/env node
/**
 * 本人登记制品 —— 独立生成与检查工具（L1）
 * ============================================
 *
 * 用途：为「本人微信身份登记」生成一个**受限候选制品**。登记只让测试副本认识
 * 本人微信账号，**不授予管理员权限**，也不是管理员初始化。
 *
 * 与旧打包器的关系（重要）：
 *  - **不修改** `package-sandbox.cjs`，只**复用**它实际导出的安全能力
 *   （路径包含校验、可信根、真实路径、源文件读取等），不复制一套宽松版。
 *  - 旧打包器的 closed manifest 校验**不**用于认定登记包通过 —— 登记包是
 *    受限差异制品，schema 与差异面都不同。
 *
 * 两处**唯一**变换（其余 6 文件逐字节一致）：
 *  1. `index.js`：仅替换 `SANDBOX_CONFIG` 配置对象（固定环境/AppID、仅一个
 *     完整本人 userId、独立轮次、有限截止时间；projectId/projectReadyMarker
 *     留空 —— 不以创建项目为登记前置）。
 *  2. `gate.js`：仅把 `PREPARE_ALLOWED` 收窄为 `['identify']`。
 *     原 prepare 允许 15 个动作，**不能**当作仅登记权限。
 *
 * 变换安全：先匹配**受审源的完整哈希**，再确认目标片段在源中**唯一**出现；
 * 缺失、多处或源变更即停止 —— **不在不确定源码上做全局替换**。
 *
 * 硬边界：
 *  - 默认仅本地检查/展示缺项：**零云调用、零凭据获取、不安装**；
 *    检查模式**不补文件**。生成必须显式 `--mode build` 并提供完整计划。
 *  - 不存在 deploy / execute / login 等操作，也**没有 shell 拼接**。
 *  - 输出限定 `artifacts/schedule-sandbox/registration-<安全编号>/`，
 *    不得指向源目录、既有关闭目录或其祖先。
 *  - 不同内容**拒绝覆盖**；缺文件、额外文件、路径逃逸、链接、伪造 manifest
 *    一律拒绝。**不递归删除**；真实写盘失败保留半成品并明确未完成。
 *  - `deploymentAuthorized=false` / `cloudExecuted=false` 只是**记录**，
 *    **不是**安全授权句柄。生成 enabled=true 的候选文件只存在于隔离
 *    artifacts 目录，**不等于云端启用**。
 *
 * 用法：
 *   node scripts/package-sandbox-registration.cjs --check
 *   node scripts/package-sandbox-registration.cjs --mode build --plan <plan.json>
 *   node scripts/package-sandbox-registration.cjs --check --target <dir>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ── 复用旧打包器**实际导出**的安全能力（不复制宽松版） ─────────────────────
const base = require('./package-sandbox.cjs');

const ROOT = base.ROOT;
const SOURCE_DIR = base.SOURCE_DIR;
const ARTIFACTS_ROOT = base.ARTIFACTS_ROOT;
const PACKAGE_FILES = Object.freeze(base.PACKAGE_FILES.slice());
const OUT_DIR_ALLOWED_TOP = base.OUT_DIR_ALLOWED_TOP;

/** 登记制品固定目标（与既有受审常量一致，不新增可变目标）。 */
const FIXED_TARGET = Object.freeze({
  appId: 'wxfb4db1615ac15531',
  envId: 'cloud1-d8gcq5ag39d847723',
  region: 'ap-shanghai',
  functionName: 'scheduleSandbox'
});

/** 候选本人账号：完整 userId 形态（`u_` + 40 位十六进制）。 */
const CANDIDATE_USER_ID = 'u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4';

/** 本人登记允许的唯一动作（服务端硬收口）。 */
const REGISTRATION_ALLOWED_ACTIONS = Object.freeze(['identify']);

/** 登记制品独立 schema（**不**复用 closed 的 /2）。 */
const REGISTRATION_MANIFEST_SCHEMA = 'sandbox-registration-candidate/1';

/** 登记输出目录名前缀与安全编号形态。 */
const OUT_DIR_PREFIX = 'registration-';
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}[a-z0-9]$/;

/** 用户窗口操作上限（30 分钟）——是操作上限，不是平台保证。 */
const MAX_WINDOW_MS = 30 * 60 * 1000;

/** 计划字段白名单：固定目标、单一完整用户名单、轮次、窗口、来源版本与用途。 */
const PLAN_FIELDS = Object.freeze([
  'purpose',
  'appId',
  'envId',
  'region',
  'functionName',
  'allowedUserIds',
  'roundId',
  'windowStartsAt',
  'windowExpiresAt',
  'sourceVersion',
  'synthetic'
]);

/** 占位/待定字符串：出现即拒绝，不预填「已批准」。 */
const PLACEHOLDER_RE = /^(todo|tbd|pending|placeholder|changeme|xxx+|待定|待确认)$/i;

// ── 固定错误码（不外传任意字符串） ────────────────────────────────────────
const ERR = Object.freeze({
  MODE_INVALID: 'REG_MODE_INVALID',
  PLAN_MISSING: 'REG_PLAN_MISSING',
  PLAN_FIELD_UNKNOWN: 'REG_PLAN_FIELD_UNKNOWN',
  PLAN_FIELD_MISSING: 'REG_PLAN_FIELD_MISSING',
  PLAN_TARGET_MISMATCH: 'REG_PLAN_TARGET_MISMATCH',
  PLAN_USER_INVALID: 'REG_PLAN_USER_INVALID',
  PLAN_USER_NOT_UNIQUE: 'REG_PLAN_USER_NOT_UNIQUE',
  PLAN_PLACEHOLDER: 'REG_PLAN_PLACEHOLDER',
  PLAN_WINDOW_INVALID: 'REG_PLAN_WINDOW_INVALID',
  PLAN_WINDOW_TOO_LONG: 'REG_PLAN_WINDOW_TOO_LONG',
  PLAN_WINDOW_EXPIRED: 'REG_PLAN_WINDOW_EXPIRED',
  PLAN_SOURCE_DRIFT: 'REG_PLAN_SOURCE_DRIFT',
  OUT_DIR_UNSAFE: 'REG_OUT_DIR_UNSAFE',
  SOURCE_MISSING: 'REG_SOURCE_MISSING',
  TRANSFORM_ANCHOR_MISSING: 'REG_TRANSFORM_ANCHOR_MISSING',
  TRANSFORM_ANCHOR_AMBIGUOUS: 'REG_TRANSFORM_ANCHOR_AMBIGUOUS',
  ARTIFACT_EXISTS_DIFFERENT: 'REG_ARTIFACT_EXISTS_DIFFERENT',
  ARTIFACT_INCOMPLETE: 'REG_ARTIFACT_INCOMPLETE',
  ARTIFACT_EXTRA_FILE: 'REG_ARTIFACT_EXTRA_FILE',
  ARTIFACT_SYMLINK: 'REG_ARTIFACT_SYMLINK',
  MANIFEST_INVALID: 'REG_MANIFEST_INVALID',
  MANIFEST_MISMATCH: 'REG_MANIFEST_MISMATCH',
  WRITE_FAILED: 'REG_WRITE_FAILED',
  PLAN_INVALID_FALLBACK: 'REG_PLAN_INVALID'
});

class RegistrationError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail || '';
  }
}

function fail(code, detail) {
  throw new RegistrationError(code, detail);
}

// ── 通用小工具 ────────────────────────────────────────────────────────────
function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 统计一段文本中某个片段出现的次数（用于「唯一片段」校验）。 */
function countOccurrences(haystack, needle) {
  if (needle === '') return -1;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** 生成安全的输出编号（仅小写字母/数字/连字符）。 */
function safeOutId(seed) {
  const raw = String(seed || '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
  const candidate = cleaned.length >= 2 ? cleaned : 'local';
  return SAFE_ID_RE.test(candidate) ? candidate : 'local';
}

// ── 计划校验（字段白名单 + 固定目标 + 窗口） ──────────────────────────────
/**
 * 校验登记执行计划。**只接受白名单字段**，禁止任意环境/函数/集合/运行时/
 * 依赖/源码路径。
 *
 * @param {object} plan 合成或真实计划
 * @param {object} [options] `{ nowMs, synthetic }`
 * @returns {object} 归一化计划
 */
function validatePlan(plan, options) {
  const o = options || {};
  const nowMs = typeof o.nowMs === 'number' && Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const synthetic = plan && plan.synthetic === true;

  if (!isPlainObject(plan)) fail(ERR.PLAN_MISSING, '计划必须是对象。');

  // 字段白名单：多一个键都拒绝
  for (const key of Object.keys(plan)) {
    if (PLAN_FIELDS.indexOf(key) === -1) fail(ERR.PLAN_FIELD_UNKNOWN, key);
  }

  // 必填
  for (const key of ['purpose', 'appId', 'envId', 'region', 'functionName',
    'allowedUserIds', 'roundId', 'windowStartsAt', 'windowExpiresAt', 'sourceVersion']) {
    if (!(key in plan)) fail(ERR.PLAN_FIELD_MISSING, key);
  }

  // 固定目标：不可由计划改写环境/函数/地域
  if (plan.appId !== FIXED_TARGET.appId ||
    plan.envId !== FIXED_TARGET.envId ||
    plan.region !== FIXED_TARGET.region ||
    plan.functionName !== FIXED_TARGET.functionName) {
    fail(ERR.PLAN_TARGET_MISMATCH, '目标必须等于固定 AppID/环境/地域/函数名。');
  }

  // 占位字符串不预填「已批准」
  for (const key of ['purpose', 'roundId', 'sourceVersion']) {
    if (typeof plan[key] !== 'string' || plan[key].trim() === '') {
      fail(ERR.PLAN_FIELD_MISSING, key);
    }
    if (PLACEHOLDER_RE.test(plan[key].trim())) fail(ERR.PLAN_PLACEHOLDER, key);
  }

  // 允许用户：必须是**完整** userId 且唯一；登记不接受空名单
  if (!Array.isArray(plan.allowedUserIds)) fail(ERR.PLAN_USER_INVALID, 'allowedUserIds 必须是数组。');
  const users = plan.allowedUserIds.map((v) => (typeof v === 'string' ? v.trim() : ''));
  if (users.length === 0) fail(ERR.PLAN_USER_INVALID, '登记窗口不接受空名单。');
  for (const u of users) {
    if (!/^u_[0-9a-f]{40}$/.test(u)) fail(ERR.PLAN_USER_INVALID, '必须是完整 userId 形态：' + u);
  }
  if (new Set(users).size !== users.length) fail(ERR.PLAN_USER_NOT_UNIQUE, '允许用户必须唯一。');

  // 窗口：有效、未过期、且不超过操作上限
  const startsAt = Date.parse(plan.windowStartsAt);
  const expiresAt = Date.parse(plan.windowExpiresAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt)) {
    fail(ERR.PLAN_WINDOW_INVALID, '窗口时间必须是可解析的 ISO 时间。');
  }
  if (expiresAt <= startsAt) fail(ERR.PLAN_WINDOW_INVALID, '截止必须晚于开始。');
  if (expiresAt - startsAt > MAX_WINDOW_MS) {
    fail(ERR.PLAN_WINDOW_TOO_LONG, '窗口超过 30 分钟操作上限。');
  }
  // 合成计划可用合成时钟；真实计划必须尚未过期
  if (!synthetic && expiresAt <= nowMs) fail(ERR.PLAN_WINDOW_EXPIRED, '窗口已过期。');

  return Object.freeze({
    purpose: plan.purpose.trim(),
    appId: plan.appId,
    envId: plan.envId,
    region: plan.region,
    functionName: plan.functionName,
    allowedUserIds: Object.freeze(users.slice()),
    roundId: plan.roundId.trim(),
    windowStartsAt: new Date(startsAt).toISOString(),
    windowExpiresAt: new Date(expiresAt).toISOString(),
    sourceVersion: plan.sourceVersion.trim(),
    synthetic: synthetic === true
  });
}

// ── 受审源读取（复用旧打包器） ────────────────────────────────────────────
/**
 * 读取并记录受审源文件的字节与哈希。**不修改源文件**。
 */
function readReviewedSources() {
  const out = new Map();
  for (const rel of PACKAGE_FILES) {
    // readSource 内部已做排除项 + 路径包含 + 真实路径校验
    const buf = base.readSource(rel, SOURCE_DIR);
    out.set(rel, { bytes: buf.length, sha256: sha256Buffer(buf), buf });
  }
  return out;
}

/** 受审源整体指纹（用于计划 sourceVersion 漂移检测与 manifest 绑定）。 */
function sourceSetDigest(sources) {
  const parts = PACKAGE_FILES.map((rel) => {
    const e = sources.get(rel);
    return `${rel}:${e.sha256}`;
  });
  return sha256Buffer(Buffer.from(parts.join('\n'), 'utf8'));
}

// ── 两处精确变换 ──────────────────────────────────────────────────────────
/**
 * 构造 `index.js` 的 `SANDBOX_CONFIG` 源片段与目标片段。
 * 源片段必须与受审源**逐字节一致**且**唯一**出现。
 */
function buildIndexTransform(normalizedPlan) {
  const anchorFrom = [
    'const SANDBOX_CONFIG = gate.readConfig({',
    '  enabled: false,',
    "  appId: '',",
    "  envId: '',",
    '  allowedUserIds: [],',
    "  projectId: '',",
    "  roundId: '',",
    "  expiresAt: '',",
    '  phase: gate.PHASE_PREPARE,',
    "  projectReadyMarker: ''",
    '});'
  ].join('\n');
  const users = normalizedPlan.allowedUserIds.map((u) => `    '${u}'`).join(',\n');
  const anchorTo = [
    'const SANDBOX_CONFIG = gate.readConfig({',
    '  enabled: true,',
    `  appId: '${normalizedPlan.appId}',`,
    `  envId: '${normalizedPlan.envId}',`,
    '  allowedUserIds: [',
    users,
    '  ],',
    '  // 登记不以创建项目为前置：项目字段保持为空。',
    "  projectId: '',",
    `  roundId: '${normalizedPlan.roundId}',`,
    `  expiresAt: '${normalizedPlan.windowExpiresAt}',`,
    '  phase: gate.PHASE_PREPARE,',
    "  projectReadyMarker: ''",
    '});'
  ].join('\n');
  return { file: 'index.js', from: anchorFrom, to: anchorTo, label: 'SANDBOX_CONFIG' };
}

/**
 * 构造 `gate.js` 的 `PREPARE_ALLOWED` 源片段与目标片段。
 * 目标精确收窄为 `['identify']`；**不触碰** EXECUTE_ALLOWED。
 */
function buildGateTransform() {
  const actions = REGISTRATION_ALLOWED_ACTIONS;
  const fromList = [
    'identify', 'listMyProjects', 'requestBindingNumber', 'createProject',
    'assignManager', 'createInvitation', 'applyInvitation', 'approveInvitation',
    'removeMember', 'getMembers', 'listInvitations', 'getScheduleContext',
    'listSchedules', 'getSchedule', 'listScheduleRevisions'
  ].map((a) => `  '${a}'${a === 'listScheduleRevisions' ? '' : ','}`).join('\n');
  const toList = actions.map((a, i) => `  '${a}'${i === actions.length - 1 ? '' : ','}`).join('\n');
  const anchorFrom = [
    'const PREPARE_ALLOWED = Object.freeze([',
    fromList,
    ']);'
  ].join('\n');
  const anchorTo = [
    '// 本人登记候选制品：prepare 阶段**仅**允许身份登记。',
    '// 其余 prepare 动作与施工写动作一律在数据库访问前拒绝。',
    'const PREPARE_ALLOWED = Object.freeze([',
    toList,
    ']);'
  ].join('\n');
  return { file: 'gate.js', from: anchorFrom, to: anchorTo, label: 'PREPARE_ALLOWED' };
}

/**
 * 对单个文件执行一次**唯一**变换。
 * 先确认源完整哈希匹配受审记录，再确认片段唯一；否则停止。
 */
function applyTransform(sources, transform, expectedSourceSha) {
  const entry = sources.get(transform.file);
  if (!entry) fail(ERR.SOURCE_MISSING, transform.file);
  const actualSha = sha256Buffer(entry.buf);
  if (expectedSourceSha && actualSha !== expectedSourceSha) {
    fail(ERR.PLAN_SOURCE_DRIFT, `${transform.file} 源已变化。`);
  }
  const text = entry.buf.toString('utf8');
  const occurrences = countOccurrences(text, transform.from);
  if (occurrences === 0) fail(ERR.TRANSFORM_ANCHOR_MISSING, `${transform.file}/${transform.label}`);
  if (occurrences > 1) fail(ERR.TRANSFORM_ANCHOR_AMBIGUOUS, `${transform.file}/${transform.label}`);
  const idx = text.indexOf(transform.from);
  const outText = text.slice(0, idx) + transform.to + text.slice(idx + transform.from.length);
  const outBuf = Buffer.from(outText, 'utf8');
  return {
    file: transform.file,
    buf: outBuf,
    bytes: outBuf.length,
    sha256: sha256Buffer(outBuf),
    sourceSha256: actualSha
  };
}

/**
 * 由受审源计算完整目标产物字节集（不写盘）。
 * 两个变换文件用变换结果，其余 6 个文件**逐字节一致**。
 */
function computeArtifacts(sources, normalizedPlan) {
  const transforms = [buildIndexTransform(normalizedPlan), buildGateTransform()];
  const artifacts = [];
  const differences = [];
  for (const rel of PACKAGE_FILES) {
    const entry = sources.get(rel);
    if (!entry) fail(ERR.SOURCE_MISSING, rel);
    const t = transforms.find((x) => x.file === rel);
    if (t) {
      const applied = applyTransform(sources, t, entry.sha256);
      artifacts.push({ rel, buf: applied.buf, bytes: applied.bytes, sha256: applied.sha256 });
      differences.push({
        file: rel,
        anchor: t.label,
        sourceSha256: applied.sourceSha256,
        artifactSha256: applied.sha256,
        sourceBytes: entry.bytes,
        artifactBytes: applied.bytes
      });
    } else {
      // 其余文件：逐字节一致
      artifacts.push({ rel, buf: entry.buf, bytes: entry.bytes, sha256: entry.sha256 });
    }
  }
  return { artifacts, differences };
}

// ── 前端覆盖文件（L2） ────────────────────────────────────────────────────
/**
 * 生成前端 `config/schedule-sandbox-proof.js` 的**覆盖文件**。
 *
 * 边界（重要）：这不是完整可预览小程序包。
 *  - 复用既有页面/client/协调器，**不改**其逻辑、路由、缓存与 env-gate。
 *  - 仅登记覆盖文件 enabled=true；旧业务入口与专用测试驱动仍为 false。
 *  - `sandboxProjectId` 保持为空；**不新增**不存在的 phase 字段。
 *  - 列出所依赖的当前前端源码版本及哈希，供后续在独立构建目录组装。
 */
function buildFrontendOverride(normalizedPlan, sourceVersion) {
  const body = `// 本人登记候选制品：前端覆盖文件（${REGISTRATION_MANIFEST_SCHEMA}）
//
// **这不是完整可预览小程序包。**
// 它只是对既有 config/schedule-sandbox-proof.js 的**覆盖文件**：
// 未来必须在独立构建目录组装、编译并审查完整客户端包后才能预览。
// 本文件不复制私有工作区、不生成二维码、不上传、不调用开发者工具。
//
// 复用既有 pages/schedule-sandbox、client 与协调器；
// 不改页面逻辑、路由、缓存或 env-gate，也不指向 pages/access。

'use strict';

module.exports = Object.freeze({
  // 仅登记窗口内开启；窗口外由服务端 gate 按 deadline 拒绝。
  enabled: true,
  // 固定目标：客户端不接受请求体或用户输入指定。
  envId: '${normalizedPlan.envId}',
  appId: '${normalizedPlan.appId}',
  functionName: '${normalizedPlan.functionName}',
  // 正式版与未识别版本不在其中。
  allowedVersions: Object.freeze(['develop', 'trial']),
  // 登记不以创建项目为前置：保持为空。
  sandboxProjectId: '',
  // 必须与服务端配置的轮次一致（未决请求按 环境 + 轮次 分键）。
  roundId: '${normalizedPlan.roundId}',
  // 独立缓存键前缀：不与旧缓存混用，也不清旧缓存。
  cachePrefix: 'schtest_v1:',
  // 所依赖的当前前端源码版本（组装完整客户端包时须核对）。
  sourceVersion: '${sourceVersion}',
  description: '本人微信身份登记候选覆盖文件（本地制品，未部署）。'
});
`;
  const buf = Buffer.from(body, 'utf8');
  return {
    rel: 'frontend/config/schedule-sandbox-proof.js',
    buf,
    bytes: buf.length,
    sha256: sha256Buffer(buf)
  };
}

/**
 * 读取受审关闭包的内容摘要（**只引用/校验，不覆盖**）。
 * 关闭服务端使用受审 closed-20261005-r2fix（schema /2）8 文件。
 */
function describeClosedPackage(dirName) {
  const dir = path.join(ARTIFACTS_ROOT, dirName);
  const files = [];
  let totalBytes = 0;
  const parts = [];
  for (const rel of PACKAGE_FILES) {
    const abs = path.join(dir, 'package', rel);
    if (!fs.existsSync(abs)) {
      files.push({ rel, present: false, bytes: null, sha256: null });
      continue;
    }
    const buf = fs.readFileSync(abs);
    const sha = sha256Buffer(buf);
    totalBytes += buf.length;
    parts.push(`${rel}:${sha}`);
    files.push({ rel, present: true, bytes: buf.length, sha256: sha });
  }
  return {
    dir: dirName,
    present: files.every((f) => f.present),
    files,
    totalBytes,
    setDigest: sha256Buffer(Buffer.from(parts.join('\n'), 'utf8'))
  };
}

// ── manifest ──────────────────────────────────────────────────────────────
function buildManifest(normalizedPlan, artifacts, differences, frontend, closed, sources) {
  return {
    schema: REGISTRATION_MANIFEST_SCHEMA,
    // 仅为记录，不是安全授权句柄
    deploymentAuthorized: false,
    cloudExecuted: false,
    synthetic: normalizedPlan.synthetic === true,
    generatedAt: new Date().toISOString(),
    plan: {
      purpose: normalizedPlan.purpose,
      appId: normalizedPlan.appId,
      envId: normalizedPlan.envId,
      region: normalizedPlan.region,
      functionName: normalizedPlan.functionName,
      allowedUserIds: normalizedPlan.allowedUserIds.slice(),
      roundId: normalizedPlan.roundId,
      windowStartsAt: normalizedPlan.windowStartsAt,
      windowExpiresAt: normalizedPlan.windowExpiresAt,
      sourceVersion: normalizedPlan.sourceVersion,
      windowMaxMs: MAX_WINDOW_MS
    },
    // 有效动作面（服务端硬收口）
    effectiveActions: REGISTRATION_ALLOWED_ACTIONS.slice(),
    prepareAllowedSource: 'gate.js PREPARE_ALLOWED 收窄为 [identify]',
    allowedUsers: normalizedPlan.allowedUserIds.slice(),
    reviewedSource: {
      setDigest: sourceSetDigest(sources),
      files: PACKAGE_FILES.map((rel) => {
        const e = sources.get(rel);
        return { rel, bytes: e.bytes, sha256: e.sha256 };
      })
    },
    artifacts: artifacts.map((a) => ({
      rel: a.rel, bytes: a.bytes, sha256: a.sha256
    })),
    // 两处精确差异（不含 manifest 自身哈希，避免循环自哈希）
    differences: differences.slice(),
    frontendOverride: {
      rel: frontend.rel, bytes: frontend.bytes, sha256: frontend.sha256,
      note: '覆盖文件，非完整可预览小程序包；未来须在独立构建目录组装后审查'
    },
    closedPackage: {
      dir: closed.dir, present: closed.present, totalBytes: closed.totalBytes,
      setDigest: closed.setDigest,
      files: closed.files,
      note: '只引用/校验，不覆盖；不使用 /1 包冒充 /2'
    },
    limitations: [
      '本 manifest 记录本地候选制品，不是云端部署证明',
      'deploymentAuthorized=false 与 cloudExecuted=false 仅为记录，不构成安全授权',
      '生成 enabled=true 的候选文件不等于云端已启用',
      '前端覆盖文件不是完整可预览小程序包，未生成二维码、未上传',
      'identify 首次会写测试 users 与 registerIdentity 审计；不写 primary、不取号、不建项目',
      '真实时间窗口与最终制品留到执行包阶段生成并重新审查指纹'
    ]
  };
}

// ── 输出目录安全 ──────────────────────────────────────────────────────────
/**
 * 校验输出目录：必须在 ARTIFACTS_ROOT 下、前缀为 registration-，
 * 且**不得**指向源目录、既有关闭目录或其祖先。
 */
function resolveOutDir(outId, existingClosedDirs) {
  if (!SAFE_ID_RE.test(outId)) fail(ERR.OUT_DIR_UNSAFE, '输出编号形态非法：' + outId);
  // 保留名：不得占用源目录或既有关闭/候选目录的名字
  const RESERVED = ['cloudfunctions', 'miniprogram', 'scripts', 'tests', 'config', 'artifacts'];
  if (RESERVED.indexOf(outId) !== -1) fail(ERR.OUT_DIR_UNSAFE, '输出编号为保留名：' + outId);
  for (const closed of existingClosedDirs || []) {
    if (outId === closed) fail(ERR.OUT_DIR_UNSAFE, '不得使用既有目录名：' + outId);
  }
  const dir = path.resolve(ARTIFACTS_ROOT, OUT_DIR_PREFIX + outId);
  // 复用旧打包器的可信根与真实路径校验
  base.assertTrustedOutDir(dir, SOURCE_DIR);
  // 必须在 artifacts 根之内
  const realRoot = fs.realpathSync(path.resolve(ARTIFACTS_ROOT));
  if (!dir.startsWith(realRoot + path.sep)) fail(ERR.OUT_DIR_UNSAFE, '输出目录越出 artifacts 根。');
  // 不得是既有关闭目录或源目录
  for (const closed of existingClosedDirs) {
    const closedDir = path.resolve(ARTIFACTS_ROOT, closed);
    if (dir === closedDir || dir.startsWith(closedDir + path.sep)) {
      fail(ERR.OUT_DIR_UNSAFE, '不得指向既有关闭目录。');
    }
  }
  if (dir === path.resolve(SOURCE_DIR) || dir.startsWith(path.resolve(SOURCE_DIR) + path.sep)) {
    fail(ERR.OUT_DIR_UNSAFE, '不得指向源目录。');
  }
  return dir;
}

/** 目录内不得有链接（逐级检查）。 */
function assertNoSymlink(dir) {
  let cursor = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(cursor)) {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink()) fail(ERR.ARTIFACT_SYMLINK, cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

/** 列出目录内全部文件（相对路径），用于「额外文件」检查。 */
function listAllFiles(dir) {
  const out = [];
  const walk = (cur, rel) => {
    for (const name of fs.readdirSync(cur)) {
      const abs = path.join(cur, name);
      const st = fs.lstatSync(abs);
      const relPath = rel ? `${rel}/${name}` : name;
      if (st.isSymbolicLink()) fail(ERR.ARTIFACT_SYMLINK, relPath);
      if (st.isDirectory()) walk(abs, relPath);
      else out.push(relPath);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

// ── 检查（默认模式：零写盘） ──────────────────────────────────────────────
/**
 * 检查既有登记产物：重算产物与受审源转换结果的一致性，
 * **不信 manifest 自报「通过」**。
 *
 * @param {object} [options] `{ outDir }`
 */
function checkRegistration(options) {
  const o = options || {};
  const problems = [];
  let dir = o.outDir || null;
  if (!dir) {
    // 未指定：报告候选目录是否存在（只列缺项，不补文件）
    const candidates = fs.existsSync(ARTIFACTS_ROOT)
      ? fs.readdirSync(ARTIFACTS_ROOT).filter((n) => n.startsWith(OUT_DIR_PREFIX))
      : [];
    return {
      ok: candidates.length === 0,
      mode: 'check',
      candidates,
      problems: candidates.length === 0 ? [] : [{
        code: ERR.ARTIFACT_EXISTS_DIFFERENT,
        detail: '存在候选目录，请用 --target 指定后逐项核对：' + candidates.join(', ')
      }],
      wroteFiles: false,
      cloudCalled: false
    };
  }
  dir = path.resolve(dir);
  assertNoSymlink(dir);
  if (!fs.existsSync(dir)) {
    return {
      ok: false, mode: 'check', dir, problems: [{ code: ERR.ARTIFACT_INCOMPLETE, detail: '目录不存在' }],
      wroteFiles: false, cloudCalled: false
    };
  }
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false, mode: 'check', dir,
      problems: [{ code: ERR.MANIFEST_INVALID, detail: '缺 manifest.json' }],
      wroteFiles: false, cloudCalled: false
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    return {
      ok: false, mode: 'check', dir,
      problems: [{ code: ERR.MANIFEST_INVALID, detail: 'manifest 不是合法 JSON' }],
      wroteFiles: false, cloudCalled: false
    };
  }
  if (!isPlainObject(manifest) || manifest.schema !== REGISTRATION_MANIFEST_SCHEMA) {
    return {
      ok: false, mode: 'check', dir,
      problems: [{ code: ERR.MANIFEST_INVALID, detail: 'schema 不符' }],
      wroteFiles: false, cloudCalled: false
    };
  }
  // 由 manifest 的计划重建期望产物（不信任 manifest 的哈希自报）
  let normalized;
  try {
    normalized = validatePlan({
      purpose: manifest.plan.purpose,
      appId: manifest.plan.appId,
      envId: manifest.plan.envId,
      region: manifest.plan.region,
      functionName: manifest.plan.functionName,
      allowedUserIds: manifest.plan.allowedUserIds,
      roundId: manifest.plan.roundId,
      windowStartsAt: manifest.plan.windowStartsAt,
      windowExpiresAt: manifest.plan.windowExpiresAt,
      sourceVersion: manifest.plan.sourceVersion,
      synthetic: manifest.synthetic === true
    }, { nowMs: Date.parse(manifest.generatedAt) });
  } catch (error) {
    return {
      ok: false, mode: 'check', dir,
      problems: [{ code: error.code || ERR.MANIFEST_INVALID, detail: String(error.detail || '') }],
      wroteFiles: false, cloudCalled: false
    };
  }
  // 受审源若已漂移，直接记录
  let sources;
  try {
    sources = readReviewedSources();
  } catch (error) {
    problems.push({ code: ERR.SOURCE_MISSING, detail: String(error.detail || error.message) });
    return { ok: false, mode: 'check', dir, problems, wroteFiles: false, cloudCalled: false };
  }
  const expected = computeArtifacts(sources, normalized);

  // 实际文件集合：不得多、不得少。
  // 期望集合 = 8 个服务端文件 + 前端覆盖文件（它也在 package/ 下，但不是服务端包成员）。
  const actualFiles = listAllFiles(path.join(dir, 'package'));
  const expectedRels = expected.artifacts.map((a) => a.rel).sort();
  const frontendRel = 'frontend/config/schedule-sandbox-proof.js';
  const allowedRels = expectedRels.concat([frontendRel]).sort();
  const extra = actualFiles.filter((f) => allowedRels.indexOf(f) === -1);
  if (extra.length > 0) {
    problems.push({ code: ERR.ARTIFACT_EXTRA_FILE, detail: extra.join(', ') });
  }
  const missing = allowedRels.filter((f) => actualFiles.indexOf(f) === -1);
  if (missing.length > 0) {
    problems.push({ code: ERR.ARTIFACT_INCOMPLETE, detail: missing.join(', ') });
  }
  // 逐个重算字节并比对
  for (const a of expected.artifacts) {
    const abs = path.join(dir, 'package', a.rel);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    const sha = sha256Buffer(buf);
    if (sha !== a.sha256) {
      problems.push({ code: ERR.MANIFEST_MISMATCH, detail: `${a.rel} 字节与受审源转换结果不一致` });
      continue;
    }
    // manifest 自报也必须一致（防伪造）
    const claimed = (manifest.artifacts || []).find((x) => x.rel === a.rel);
    if (!claimed || claimed.sha256 !== sha) {
      problems.push({ code: ERR.MANIFEST_MISMATCH, detail: `${a.rel} manifest 记录与实际不符` });
    }
  }
  // 前端覆盖文件
  const frontendAbs = path.join(dir, 'package', 'frontend', 'config', 'schedule-sandbox-proof.js');
  if (fs.existsSync(frontendAbs)) {
    const sha = sha256Buffer(fs.readFileSync(frontendAbs));
    const claimed = manifest.frontendOverride;
    if (!claimed || claimed.sha256 !== sha) {
      problems.push({ code: ERR.MANIFEST_MISMATCH, detail: '前端覆盖文件与 manifest 不符' });
    }
  } else {
    problems.push({ code: ERR.ARTIFACT_INCOMPLETE, detail: '缺前端覆盖文件' });
  }

  return {
    ok: problems.length === 0,
    mode: 'check',
    dir,
    differences: expected.differences,
    problems,
    wroteFiles: false,
    cloudCalled: false
  };
}

// ── 生成（必须显式 --mode build + 完整计划） ──────────────────────────────
/**
 * 生成登记候选制品。
 *
 * 预检失败 → **零新文件**；真实写盘失败 → **保留半成品**并明确未完成，
 * **不递归清理**。
 *
 * @param {object} plan 执行计划
 * @param {object} [options] `{ outId, nowMs }`
 */
function buildRegistration(plan, options) {
  const o = options || {};
  const nowMs = typeof o.nowMs === 'number' && Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const outId = safeOutId(o.outId || (plan && plan.roundId) || 'local');

  const existingClosedDirs = fs.existsSync(ARTIFACTS_ROOT)
    ? fs.readdirSync(ARTIFACTS_ROOT).filter((n) => !n.startsWith(OUT_DIR_PREFIX))
    : [];
  const dir = resolveOutDir(outId, existingClosedDirs);

  // 预检：全部成功后才写盘
  const normalized = validatePlan(plan, { nowMs });
  const sources = readReviewedSources();
  const computed = computeArtifacts(sources, normalized);
  const frontend = buildFrontendOverride(normalized, normalized.sourceVersion);
  const closed = describeClosedPackage('closed-20261005-r2fix');
  const manifest = buildManifest(normalized, computed.artifacts, computed.differences, frontend, closed, sources);

  // 复用判定：**同一目录 + 同一计划 + 同内容**才可复用；不同内容拒绝覆盖。
  // 注意：不能只靠 checkRegistration（它按 manifest 自报的计划重建，永远自洽），
  // 必须先把 manifest 记录的计划与**本次请求的计划**逐项比较。
  const reuse = { reused: false, dir };
  if (fs.existsSync(path.join(dir, 'manifest.json'))) {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch (_) {
      existing = null;
    }
    const samePlan = isPlainObject(existing) && isPlainObject(existing.plan) &&
      existing.plan.roundId === normalized.roundId &&
      existing.plan.purpose === normalized.purpose &&
      existing.plan.windowExpiresAt === normalized.windowExpiresAt &&
      existing.plan.sourceVersion === normalized.sourceVersion &&
      JSON.stringify(existing.plan.allowedUserIds || []) ===
        JSON.stringify(normalized.allowedUserIds.slice());
    if (!samePlan) {
      // 内容不同 → 拒绝覆盖（不递归删除，保留原目录）
      fail(ERR.ARTIFACT_EXISTS_DIFFERENT, `目录已存在且计划不同，拒绝覆盖：${dir}`);
    }
    const existing_check = checkRegistration({ outDir: dir });
    if (existing_check.ok) {
      reuse.reused = true;
      return {
        ok: true, mode: 'build', ...reuse, manifest: existing,
        differences: computed.differences, wroteFiles: false, cloudCalled: false
      };
    }
    // 计划相同但字节被改动 → 同样拒绝覆盖（不静默修复）
    fail(ERR.ARTIFACT_EXISTS_DIFFERENT,
      `目录已存在且内容与受审源转换结果不一致，拒绝覆盖：${dir}`);
  }

  // 写盘：逐文件；失败保留半成品
  const written = [];
  try {
    const pkgDir = path.join(dir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const a of computed.artifacts) {
      const abs = base.resolveInside(pkgDir, a.rel, '登记产物条目');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, a.buf);
      written.push(a.rel);
    }
    const frontendAbs = base.resolveInside(pkgDir, frontend.rel, '前端覆盖文件');
    fs.mkdirSync(path.dirname(frontendAbs), { recursive: true });
    fs.writeFileSync(frontendAbs, frontend.buf);
    written.push(frontend.rel);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    written.push('manifest.json');
  } catch (error) {
    // 保留半成品、明确未完成，不递归清理
    return {
      ok: false, mode: 'build', dir, incomplete: true,
      written,
      problems: [{
        code: ERR.WRITE_FAILED,
        detail: `写盘失败，已保留半成品（${written.length} 个文件），未递归清理：${String(error.message).slice(0, 200)}`
      }],
      wroteFiles: written.length > 0,
      cloudCalled: false
    };
  }

  return {
    ok: true,
    mode: 'build',
    dir,
    reused: false,
    manifest,
    differences: computed.differences,
    wroteFiles: true,
    cloudCalled: false
  };
}

// ── CLI（无 shell 拼接、无 deploy/execute/login） ─────────────────────────
function parseArgs(argv) {
  const out = { mode: 'check', planPath: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.mode = 'check';
    else if (a === '--mode') { out.mode = argv[i + 1]; i++; }
    else if (a === '--plan') { out.planPath = argv[i + 1]; i++; }
    else if (a === '--target') { out.target = argv[i + 1]; i++; }
    else fail(ERR.MODE_INVALID, '未知参数：' + a);
  }
  if (out.mode !== 'check' && out.mode !== 'build') {
    fail(ERR.MODE_INVALID, 'mode 仅允许 check 或 build。');
  }
  // 明确拒绝 deploy/execute/login 类操作
  for (const a of argv) {
    if (/^--(deploy|execute|login|upload|preview)$/.test(a)) {
      fail(ERR.MODE_INVALID, '本工具不含部署/执行/登录/上传/预览操作。');
    }
  }
  return out;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    // 参数错误也走结构化输出，不抛栈
    process.stdout.write(JSON.stringify({
      ok: false, mode: 'check',
      problems: [{ code: error.code || ERR.MODE_INVALID, detail: String(error.detail || error.message) }],
      wroteFiles: false, cloudCalled: false
    }, null, 2) + '\n');
    return 1;
  }
  if (args.mode === 'check') {
    const r = checkRegistration(args.target ? { outDir: args.target } : {});
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return r.ok ? 0 : 1;
  }
  // build：必须显式提供完整计划文件
  if (!args.planPath) {
    const r = {
      ok: false, mode: 'build',
      problems: [{ code: ERR.PLAN_MISSING, detail: 'build 模式必须提供 --plan <plan.json>' }],
      wroteFiles: false, cloudCalled: false
    };
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return 1;
  }
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(path.resolve(args.planPath), 'utf8'));
  } catch (_) {
    const r = {
      ok: false, mode: 'build',
      problems: [{ code: ERR.PLAN_MISSING, detail: '计划文件不可读或不是合法 JSON' }],
      wroteFiles: false, cloudCalled: false
    };
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return 1;
  }
  let r;
  try {
    r = buildRegistration(plan, {});
  } catch (error) {
    // 预检失败 → 零新文件，结构化报告固定错误码
    r = {
      ok: false, mode: 'build',
      problems: [{
        code: error.code || ERR.PLAN_INVALID_FALLBACK || 'REG_FAILED',
        detail: String(error.detail || error.message).slice(0, 300)
      }],
      wroteFiles: false, cloudCalled: false
    };
  }
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  return r.ok ? 0 : 1;
}

module.exports = Object.freeze({
  ROOT,
  SOURCE_DIR,
  ARTIFACTS_ROOT,
  PACKAGE_FILES,
  OUT_DIR_ALLOWED_TOP,
  FIXED_TARGET,
  CANDIDATE_USER_ID,
  REGISTRATION_ALLOWED_ACTIONS,
  REGISTRATION_MANIFEST_SCHEMA,
  MAX_WINDOW_MS,
  PLAN_FIELDS,
  ERR,
  RegistrationError,
  validatePlan,
  readReviewedSources,
  sourceSetDigest,
  buildIndexTransform,
  buildGateTransform,
  applyTransform,
  computeArtifacts,
  buildFrontendOverride,
  describeClosedPackage,
  buildManifest,
  resolveOutDir,
  checkRegistration,
  buildRegistration,
  safeOutId,
  sha256Buffer,
  countOccurrences,
  parseArgs,
  main
});

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}