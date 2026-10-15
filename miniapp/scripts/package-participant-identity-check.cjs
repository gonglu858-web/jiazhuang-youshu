#!/usr/bin/env node
// 两位参与者「本人身份只读核验包」独立打包器/校验器（仅本地准备，未部署）。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §2/§5/§6
// 方案：docs/Codex执行包草案-三账号P准备窗口-20261015.md §8
//
// 与既有 P/E/X 打包器的关系（刻意不做的每一条）：
// - **不改** package-business-test.cjs，也不扩大它的允许名单或哈希基线；
//   只**调用**它的 checkCloseDir 对用户明确给出的已受审关闭包目录做校验，
//   校验通过后再复制 close/ 内容。
// - 产物目录专用前缀 participant-identity-*，schema 专用
//   participant-identity-check-candidate/1；不冒充也不复用 P/E/X 输出目录。
// - 只做本地准备：不含部署/安装/登录/凭据获取，不触达平台。
//
// 打包纪律：
// - 模板与核心模块为**独立受审来源**，逐字节读取；计划字节原样复制进 plan.json，
//   manifest 记录每条目 bytes/sha256；check 从独立来源 + 目录内严格计划重建。
// - 输出根及相关祖先逐层 lstat（拒绝 junction/symlink）；目录占位/多余目录/
//   额外文件预检零写；排他新建（flag:'wx'）不覆盖；合法复用/续建保留。
// - 部分写/排他竞态如实记录（written/wroteFiles/partialWrites）。
// - 真实模式逐边界重读时钟（真实候选不接受调用者用历史 nowMs 跳过到期）；
//   合成模式清楚标记且不被真实模式认领。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB_PATH = path.join(ROOT, 'miniapp', 'scripts', 'lib', 'participant-identity-check.cjs');
const TEMPLATE_DIR = path.join(ROOT, 'miniapp', 'scripts', 'templates', 'participant-identity-check');
const BUSINESS_TOOL_PATH = path.join(ROOT, 'miniapp', 'scripts', 'package-business-test.cjs');
const OUT_ROOT = path.join(ROOT, 'artifacts', 'schedule-sandbox', 'business-test');

/** 受审固定目标（与核心模块一致，重复声明以便打包器独立校验模板）。 */
const FIXED_TARGET = Object.freeze({
  appId: 'wxfb4db1615ac15531',
  envId: 'cloud1-d8gcq5ag39d847723',
  functionName: 'scheduleSandbox',
  collection: 'schtest_v1_users'
});

const MANIFEST_SCHEMA = 'participant-identity-check-candidate/1';
const PLAN_SCHEMA = 'participant-identity-plan/1';
const OUT_PREFIX = 'participant-identity-';
const MAX_WINDOW_MS = 30 * 60 * 1000;
const RECOMMENDED_WINDOW_MS = 15 * 60 * 1000;
const PASS_ENTROPY_MIN_BITS = 128;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const PARTICIPANT_CODE_RE = /^[12]$/;
const REL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PLAN_FIELDS = Object.freeze([
  'schema', 'synthetic', 'checkRoundId', 'participantCode',
  'appId', 'envId', 'functionName', 'collection',
  'passphraseDigest', 'windowStartsAtIso', 'windowExpiresAtIso',
  'closeSourceDir', 'note'
]);

/** 服务端模板文件（受审来源）。participant-identity-check.js 由核心模块复制而来。 */
const SERVER_TEMPLATE_FILES = Object.freeze(['index.js', 'package.json']);
/** 前端模板文件（完整可导入项目的最小闭包）。 */
const FRONTEND_TEMPLATE_FILES = Object.freeze([
  'app.js', 'app.json', 'app.wxss',
  'config/cloud.js',
  'utils/identity-check-client.js',
  'pages/identity-check/identity-check.js',
  'pages/identity-check/identity-check.json',
  'pages/identity-check/identity-check.wxml',
  'pages/identity-check/identity-check.wxss'
]);

const ERR = Object.freeze({
  PLAN_INVALID: 'PIC_PLAN_INVALID',
  PLAN_WINDOW_INVALID: 'PIC_PLAN_WINDOW_INVALID',
  PLAN_PASSPHRASE_INVALID: 'PIC_PLAN_PASSPHRASE_INVALID',
  PLAN_TARGET_INVALID: 'PIC_PLAN_TARGET_INVALID',
  SOURCE_MISSING: 'PIC_SOURCE_MISSING',
  SOURCE_DRIFT: 'PIC_SOURCE_DRIFT',
  TRANSFORM_ANCHOR_MISSING: 'PIC_TRANSFORM_ANCHOR_MISSING',
  TRANSFORM_ANCHOR_AMBIGUOUS: 'PIC_TRANSFORM_ANCHOR_AMBIGUOUS',
  OUT_CONFLICT: 'PIC_OUT_CONFLICT',
  MANIFEST_INVALID: 'PIC_MANIFEST_INVALID',
  CLOSE_SOURCE_INVALID: 'PIC_CLOSE_SOURCE_INVALID',
  WINDOW_EXPIRED: 'PIC_WINDOW_EXPIRED',
  WINDOW_NOT_OPEN: 'PIC_WINDOW_NOT_OPEN',
  CLOCK_INVALID: 'PIC_CLOCK_INVALID',
  CLOCK_ERROR: 'PIC_CLOCK_ERROR'
});

class IdentityPackageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new IdentityPackageError(code, message); };

const sha256Buffer = b => crypto.createHash('sha256').update(b).digest('hex');
const relOf = p => p.split(path.sep).join('/');

/** 输出根及相关祖先：存在的层必须是真实目录且非符号链接（junction 在 lstat 下即 symlink）。 */
function assertRealDirChain(target, label) {
  const chain = [];
  let current = path.resolve(target);
  for (;;) {
    chain.push(current);
    if (current === ROOT || chain.length > 64) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  chain.reverse();
  for (const p of chain) {
    let st = null;
    try { st = fs.lstatSync(p); } catch (_) { continue; } // 不存在的层由后续 mkdir/写时失败
    if (st.isSymbolicLink()) {
      fail(ERR.OUT_CONFLICT, label + ' 路径含符号链接/junction，拒绝绕过输出边界：' + p);
    }
    if (!st.isDirectory()) {
      fail(ERR.OUT_CONFLICT, label + ' 路径存在非目录占位，不覆盖：' + p);
    }
  }
}

function listExisting(dir) {
  const out = new Map();
  const walk = (base, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const abs = path.join(base, entry.name);
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      let st = null;
      try { st = fs.lstatSync(abs); } catch (_) { st = null; }
      out.set(rel, {
        abs,
        isSymlink: Boolean(st && st.isSymbolicLink()),
        isDir: Boolean(st && st.isDirectory() && !st.isSymbolicLink()),
        isFile: Boolean(st && st.isFile())
      });
      if (st && st.isDirectory() && !st.isSymbolicLink()) walk(abs, rel);
    }
  };
  walk(dir, '');
  return out;
}

function isExpectedPrefix(rel, expectedKeys) {
  return expectedKeys.some(k => k.startsWith(rel + '/'));
}

/**
 * 预检：期望集合之外的一切（额外文件、目录占位、多余目录、符号链接、
 * 已有但字节不同的文件）都在写入前拒绝，零写。
 */
function precheckOutDir(outDir, expected) {
  if (!fs.existsSync(outDir)) return [];
  assertRealDirChain(outDir, '输出目录');
  const existing = listExisting(outDir);
  const reused = [];
  for (const [rel, info] of existing) {
    if (info.isSymlink) fail(ERR.OUT_CONFLICT, '输出目录含符号链接/junction：' + rel);
    if (info.isDir) {
      if (!isExpectedPrefix(rel, [...expected.keys()])) {
        fail(ERR.OUT_CONFLICT, '输出目录含多余目录：' + rel);
      }
      continue;
    }
    const buf = expected.get(rel);
    if (!buf) fail(ERR.OUT_CONFLICT, '输出目录含多余文件：' + rel);
    if (!info.isFile) fail(ERR.OUT_CONFLICT, '输出目录含非普通文件：' + rel);
    let current = null;
    try { current = fs.readFileSync(info.abs); } catch (_) { current = null; }
    if (!current || !current.equals(buf)) {
      fail(ERR.OUT_CONFLICT, '已存在内容不同的文件，不覆盖：' + rel);
    }
    reused.push({ path: info.abs, rel, action: 'reused' });
  }
  return reused;
}

/** 排他新建：竞态 EEXIST 的他人文件不算本轮写入；部分写如实记录。 */
function writeExclusive(abs, buf, io, rel) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.writeFileSync(abs, buf, { flag: 'wx' });
    io.push({ path: abs, rel, action: 'written', partial: false });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      error.sideEffect = 'EEXIST:目标已被他人创建，未计入本轮写入，未覆盖未删除';
      throw error;
    }
    let st = null;
    try { st = fs.lstatSync(abs); } catch (_) { st = null; }
    if (st && st.isFile()) io.push({ path: abs, rel, action: 'written', partial: true, bytesOnDisk: st.size });
    throw error;
  }
}

// ── 受审来源读取（模板 + 核心模块），源漂移即拒绝 ────────────────────────────
function readTemplateBytes(rel) {
  const abs = path.join(TEMPLATE_DIR, rel);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (_) { st = null; }
  if (!st || !st.isFile() || st.isSymbolicLink()) {
    fail(ERR.SOURCE_MISSING, '受审模板缺失或非普通文件：' + relOf(path.relative(ROOT, abs)));
  }
  return fs.readFileSync(abs);
}

function readCoreModuleBytes() {
  let st = null;
  try { st = fs.lstatSync(LIB_PATH); } catch (_) { st = null; }
  if (!st || !st.isFile() || st.isSymbolicLink()) fail(ERR.SOURCE_MISSING, '核验核心模块缺失或非普通文件。');
  return fs.readFileSync(LIB_PATH);
}

/** 唯一锚点替换：缺失或多处命中即拒（源码漂移防护）。 */
function anchorReplace(buf, from, to, label) {
  const text = buf.toString('utf8');
  const hits = text.split(from).length - 1;
  if (hits === 0) fail(ERR.TRANSFORM_ANCHOR_MISSING, '装配锚点缺失：' + label);
  if (hits > 1) fail(ERR.TRANSFORM_ANCHOR_AMBIGUOUS, '装配锚点多处命中：' + label);
  return Buffer.from(text.split(from).join(to), 'utf8');
}

// ── 计划严格校验 ────────────────────────────────────────────────────────────
function planDigest(plan) {
  const canonical = JSON.stringify({
    schema: plan.schema,
    synthetic: plan.synthetic,
    checkRoundId: plan.checkRoundId,
    participantCode: plan.participantCode,
    appId: plan.appId,
    envId: plan.envId,
    functionName: plan.functionName,
    collection: plan.collection,
    passphraseDigest: plan.passphraseDigest,
    windowStartsAtIso: plan.windowStartsAtIso,
    windowExpiresAtIso: plan.windowExpiresAtIso,
    closeSourceDir: plan.closeSourceDir,
    note: plan.note || ''
  });
  return sha256Buffer(Buffer.from(canonical));
}

function readPlan(planPath, options) {
  const opts = options || {};
  if (typeof planPath !== 'string' || !planPath) fail(ERR.PLAN_INVALID, '缺少计划文件路径。');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (error) {
    fail(ERR.PLAN_INVALID, '计划文件无法解析：' + error.message);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(ERR.PLAN_INVALID, '计划必须是 JSON 对象。');
  for (const k of Object.keys(raw)) {
    if (!PLAN_FIELDS.includes(k)) fail(ERR.PLAN_INVALID, '计划含未知字段：' + k);
  }
  if (raw.schema !== PLAN_SCHEMA) fail(ERR.PLAN_INVALID, '计划 schema 必须是 ' + PLAN_SCHEMA + '。');
  if (typeof raw.synthetic !== 'boolean') fail(ERR.PLAN_INVALID, '计划缺少 synthetic 布尔字段。');
  if (typeof raw.checkRoundId !== 'string' || !ROUND_ID_RE.test(raw.checkRoundId)) {
    fail(ERR.PLAN_INVALID, 'checkRoundId 须为 4–64 位字母数字-_ 且不以符号开头。');
  }
  if (!PARTICIPANT_CODE_RE.test(String(raw.participantCode))) {
    fail(ERR.PLAN_INVALID, 'participantCode 只能是 1（管家）或 2（师傅）。');
  }
  // 目标绑定：与受审固定值逐字一致；请求自报集合/环境不被接受
  for (const k of ['appId', 'envId', 'functionName', 'collection']) {
    if (raw[k] !== FIXED_TARGET[k]) fail(ERR.PLAN_TARGET_INVALID, k + ' 必须是受审固定值。');
  }
  if (!SHA256_RE.test(raw.passphraseDigest || '')) {
    fail(ERR.PLAN_PASSPHRASE_INVALID, 'passphraseDigest 必须是 64 位十六进制 sha256（服务端只存摘要）。');
  }
  if (raw.synthetic && raw.passphraseDigest !== SHA256_RE.test(raw.passphraseDigest) ? false : false) {
    fail(ERR.PLAN_PASSPHRASE_INVALID, 'passphraseDigest 格式无效。');
  }
  const starts = Date.parse(raw.windowStartsAtIso);
  const expires = Date.parse(raw.windowExpiresAtIso);
  if (!Number.isFinite(starts) || !Number.isFinite(expires)) {
    fail(ERR.PLAN_WINDOW_INVALID, '窗口起止时间无效。');
  }
  if (expires - starts > MAX_WINDOW_MS) {
    fail(ERR.PLAN_WINDOW_INVALID, '核验窗口不得超过 30 分钟（工具上限）。');
  }
  if (raw.synthetic && (expires - starts) > RECOMMENDED_WINDOW_MS) {
    fail(ERR.PLAN_WINDOW_INVALID, '合成夹具核验窗口不得超过建议的 15 分钟。');
  }
  if (typeof raw.closeSourceDir !== 'string' || !path.isAbsolute(raw.closeSourceDir)) {
    fail(ERR.PLAN_INVALID, 'closeSourceDir 必须是已受审关闭包目录的绝对路径。');
  }
  return Object.freeze({
    schema: raw.schema,
    synthetic: raw.synthetic,
    checkRoundId: raw.checkRoundId,
    participantCode: String(raw.participantCode),
    appId: raw.appId, envId: raw.envId, functionName: raw.functionName, collection: raw.collection,
    passphraseDigest: raw.passphraseDigest,
    windowStartsAtMs: starts,
    windowExpiresAtMs: expires,
    windowStartsAtIso: raw.windowStartsAtIso,
    windowExpiresAtIso: raw.windowExpiresAtIso,
    closeSourceDir: path.resolve(raw.closeSourceDir),
    note: raw.note || ''
  });
}

function windowClockCheck(plan, at) {
  let nowMs;
  try {
    nowMs = Date.now();
  } catch (error) {
    fail(ERR.CLOCK_ERROR, '服务端时钟异常[' + at + ']。');
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    fail(ERR.CLOCK_INVALID, '服务端时钟无效[' + at + ']。');
  }
  if (plan.synthetic) return; // 合成模式跳过时效
  if (nowMs < plan.windowStartsAtMs) fail(ERR.WINDOW_NOT_OPEN, '核验窗口尚未开始[' + at + ']。');
  if (nowMs > plan.windowExpiresAtMs) fail(ERR.WINDOW_EXPIRED, '核验窗口已截止[' + at + ']。');
}

/** 关闭包来源校验：调用未改的 checkCloseDir，不改旧生成器、不改其哈希基线。 */
function verifyCloseSource(closeSourceDir) {
  if (typeof closeSourceDir !== 'string' || !closeSourceDir) {
    fail(ERR.CLOSE_SOURCE_INVALID, '计划缺少 closeSourceDir（已受审关闭包目录）。');
  }
  const abs = path.resolve(closeSourceDir);
  assertRealDirChain(abs, '关闭包来源');
  const closeDir = path.join(abs, 'close');
  let st = null;
  try { st = fs.lstatSync(closeDir); } catch (_) { st = null; }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包来源缺少真实 close 目录（不得以链接顶替）：' + relOf(closeDir));
  }
  // 延迟 require：不扩大旧工具的允许名单，只调用其公开的关闭核对入口。
  // eslint-disable-next-line global-require
  const businessTool = require(BUSINESS_TOOL_PATH);
  const result = businessTool.checkCloseDir(abs);
  if (!result || result.ok !== true) {
    fail(ERR.CLOSE_SOURCE_INVALID,
      '关闭包来源未通过未改 package-business-test.checkCloseDir 校验：' +
      JSON.stringify((result && result.problems) || ['未知问题']).slice(0, 600));
  }
  const files = [];
  for (const [rel, info] of listExisting(closeDir)) {
    if (info.isSymlink) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包来源含符号链接：close/' + rel);
    if (info.isDir) continue;
    if (!info.isFile) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包来源含非普通文件：close/' + rel);
    files.push({ rel, buf: fs.readFileSync(info.abs) });
  }
  if (files.length !== result.expectedFiles) {
    fail(ERR.CLOSE_SOURCE_INVALID,
      '关闭包来源文件数与独立核对结果不一致（' + files.length + ' ≠ ' + result.expectedFiles + '）。');
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// ── 制品装配 ─────────────────────────────────────────────────────────────────
function computeArtifacts(plan) {
  const artifacts = new Map();
  // 服务端：核心模块（逐字节复制）+ 入口（唯一锚点替换写入本轮配置）
  const coreBytes = readCoreModuleBytes();
  artifacts.set('server/participant-identity-check.js', coreBytes);
  for (const rel of SERVER_TEMPLATE_FILES) {
    const raw = readTemplateBytes('server/' + rel);
    if (rel !== 'index.js') {
      artifacts.set('server/' + rel, raw);
      continue;
    }
    let buf = anchorReplace(raw, 'const CONFIG_ENABLED = false;',
      'const CONFIG_ENABLED = ' + (!plan.synthetic) + ';', 'server/index.js#CONFIG_ENABLED');
    buf = anchorReplace(buf, "const CONFIG_APP_ID = '';",
      "const CONFIG_APP_ID = '" + plan.appId + "';", 'server/index.js#CONFIG_APP_ID');
    buf = anchorReplace(buf, "const CONFIG_ENV_ID = '';",
      "const CONFIG_ENV_ID = '" + plan.envId + "';", 'server/index.js#CONFIG_ENV_ID');
    buf = anchorReplace(buf, "const CONFIG_CHECK_ROUND_ID = '';",
      "const CONFIG_CHECK_ROUND_ID = '" + plan.checkRoundId + "';", 'server/index.js#CONFIG_CHECK_ROUND_ID');
    buf = anchorReplace(buf, "const CONFIG_PASSPHRASE_DIGEST = '';",
      "const CONFIG_PASSPHRASE_DIGEST = '" + plan.passphraseDigest + "';", 'server/index.js#CONFIG_PASSPHRASE_DIGEST');
    buf = anchorReplace(buf, 'const CONFIG_WINDOW_STARTS_AT_MS = 0;',
      'const CONFIG_WINDOW_STARTS_AT_MS = ' + plan.windowStartsAtMs + ';', 'server/index.js#CONFIG_WINDOW_STARTS_AT_MS');
    buf = anchorReplace(buf, 'const CONFIG_WINDOW_EXPIRES_AT_MS = 0;',
      'const CONFIG_WINDOW_EXPIRES_AT_MS = ' + plan.windowExpiresAtMs + ';', 'server/index.js#CONFIG_WINDOW_EXPIRES_AT_MS');
    artifacts.set('server/index.js', buf);
  }
  // 前端模板：逐字节复制（页面已收窄为唯一核验页面）
  for (const rel of FRONTEND_TEMPLATE_FILES) {
    artifacts.set('frontend/' + rel, readTemplateBytes('frontend/' + rel));
  }
  // 项目配置：受审基线逐字节复制（不改 appid 等固定值）
  const projectConfig = fs.readFileSync(path.join(ROOT, 'miniapp', 'project.config.json'));
  artifacts.set('project.config.json', projectConfig);
  return artifacts;
}

function build(planPath, outOverride) {
  const plan = readPlan(planPath);
  windowClockCheck(plan, 'build.readPlan');
  const closeFiles = verifyCloseSource(plan.closeSourceDir);
  const artifacts = computeArtifacts(plan);
  const planBytes = fs.readFileSync(planPath);
  const digest = planDigest(plan);

  const outDir = outOverride
    ? path.resolve(outOverride)
    : path.join(OUT_ROOT, OUT_PREFIX + plan.checkRoundId.toLowerCase() + '-' + digest.slice(0, 12));
  if (path.dirname(outDir) !== OUT_ROOT || !path.basename(outDir).startsWith(OUT_PREFIX)) {
    fail(ERR.OUT_CONFLICT, '输出目录必须位于 ' + OUT_ROOT + ' 之下且以 ' + OUT_PREFIX + ' 为前缀。');
  }
  assertRealDirChain(outDir, 'build 输出');

  const entries = [];
  for (const [rel, buf] of artifacts) {
    entries.push({ rel, bytes: buf.length, sha256: sha256Buffer(buf) });
  }
  entries.push({ rel: 'plan.json', bytes: planBytes.length, sha256: sha256Buffer(planBytes) });

  const manifest = {
    schema: MANIFEST_SCHEMA,
    synthetic: plan.synthetic,
    checkRoundId: plan.checkRoundId,
    participantCode: plan.participantCode,
    appId: plan.appId, envId: plan.envId, functionName: plan.functionName, collection: plan.collection,
    windowStartsAtIso: plan.windowStartsAtIso,
    windowExpiresAtIso: plan.windowExpiresAtIso,
    windowMinutes: Math.round((plan.windowExpiresAtMs - plan.windowStartsAtMs) / 60000),
    passphraseDigestRecorded: true,
    // 只记摘要，永不记明文口令
    userIdentitySource: 'trusted-wx-context：APPID/OPENID 只来自 cloud.getWXContext，本地产物不含任何 OPENID 或凭据',
    planFile: 'plan.json',
    planSha256: sha256Buffer(planBytes),
    planDigest: digest,
    closeSourceDir: relOf(path.relative(ROOT, plan.closeSourceDir)),
    boundaries: [
      '候选不是部署批准；本轮未部署、未调用平台、未写库。',
      '服务端只含口令摘要；明文口令不进入制品、日志与证据。',
      '口令只限制持有者，不证明持有者是现实中的1号/2号；不承诺一次性或全局限流（零持久写）。',
      '核验只读取调用者本人 schtest_v1_users 一条记录，不创建用户、不写审计、不授予角色、不取号。',
      '结果严格区分 ACTIVE/ABSENT/DISABLED/MISMATCH/UNKNOWN；读取失败一律 UNKNOWN。',
      'SDK 本地转换未执行；真实平台行为完全未验证。'
    ],
    files: entries,
    closePackage: {
      note: '配对关闭包：复制自已受审本地业务关闭包（先经未改 checkCloseDir 独立校验）；关闭端无需口令、不依赖开启窗口时效。',
      sourceDir: relOf(path.relative(ROOT, plan.closeSourceDir)),
      files: closeFiles.map(f => ({ rel: f.rel, bytes: f.buf.length, sha256: sha256Buffer(f.buf) }))
    }
  };

  const expected = new Map();
  for (const [rel, buf] of artifacts) expected.set(rel, buf);
  for (const f of closeFiles) expected.set('close/' + f.rel, f.buf);
  expected.set('plan.json', planBytes);
  expected.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));

  const io = [];
  try {
    windowClockCheck(plan, 'build.precheck');
    const reused = precheckOutDir(outDir, expected);
    for (const r of reused) io.push({ path: r.path, action: 'reused' });
    const reusedRels = new Set(reused.map(r => r.rel));
    for (const [rel, buf] of expected) {
      if (reusedRels.has(rel)) continue;
      windowClockCheck(plan, 'build.write:' + rel);
      writeExclusive(path.join(outDir, rel), buf, io, rel);
    }
    windowClockCheck(plan, 'build.final');
    return { outDir, manifest, io };
  } catch (error) {
    const written = io.filter(x => x.action === 'written').map(x => path.relative(outDir, x.path).split(path.sep).join('/'));
    if (written.length) {
      error.written = written;
      error.wroteFiles = written.length;
    }
    const partials = io.filter(x => x.action === 'written' && x.partial);
    if (partials.length) {
      error.partialWrites = partials.map(x => ({
        rel: path.relative(outDir, x.path).split(path.sep).join('/'),
        bytesOnDisk: x.bytesOnDisk
      }));
    }
    throw error;
  }
}

/**
 * check：从独立受审来源 + 目录内严格计划重建，逐字节比对精确文件集。
 * 固定计划文件名 plan.json；拒绝改名/别名/越界；逐读取边界与最终返回前重读时钟。
 */
function checkDir(dir) {
  assertRealDirChain(dir, 'check 输入');
  const problems = [];
  const bad = msg => problems.push(msg);
  let plan = null;
  let clockStopped = false;
  const clockCheck = at => {
    if (!plan || clockStopped) return;
    try {
      windowClockCheck(plan, at);
    } catch (error) {
      bad('窗口时效检查失败[' + (error.code || 'PIC_ERROR') + ']（' + at + '）：' + error.message);
      clockStopped = true;
    }
  };
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(ERR.MANIFEST_INVALID, 'manifest.json 无法读取：' + error.message);
  }
  if (manifest.schema !== MANIFEST_SCHEMA) fail(ERR.MANIFEST_INVALID, 'manifest schema 不符。');
  if (manifest.planFile !== undefined && manifest.planFile !== 'plan.json') {
    fail(ERR.MANIFEST_INVALID, 'manifest.planFile 必须固定为 plan.json：' + manifest.planFile);
  }
  const planRel = 'plan.json';
  const planPath = path.join(dir, planRel);
  if (!fs.existsSync(planPath)) { bad('缺少目录内计划 plan.json'); return finish(); }
  const planBytes = fs.readFileSync(planPath);
  if (manifest.planSha256 !== sha256Buffer(planBytes)) { bad('plan.json 与 manifest.planSha256 不一致'); return finish(); }
  try {
    plan = readPlan(planPath);
  } catch (error) {
    bad('计划校验失败[' + (error.code || 'PIC_ERROR') + ']：' + error.message);
    return finish();
  }
  clockCheck('check.start');
  if (clockStopped) return finish();

  if (planDigest(plan) !== manifest.planDigest) bad('planDigest 与目录内计划重算不一致');
  const expectFields = {
    checkRoundId: plan.checkRoundId, participantCode: plan.participantCode,
    synthetic: plan.synthetic, appId: plan.appId, envId: plan.envId,
    functionName: plan.functionName, collection: plan.collection,
    windowStartsAtIso: plan.windowStartsAtIso, windowExpiresAtIso: plan.windowExpiresAtIso,
    closeSourceDir: relOf(path.relative(ROOT, plan.closeSourceDir))
  };
  for (const [k, v] of Object.entries(expectFields)) {
    if (JSON.stringify(manifest[k]) !== JSON.stringify(v)) bad('manifest.' + k + ' 与计划不一致');
  }
  if (manifest.passphraseDigestRecorded !== true) bad('manifest 缺少口令摘要存在标记');

  let expected;
  let closeFiles;
  try {
    expected = computeArtifacts(plan);
    closeFiles = verifyCloseSource(plan.closeSourceDir);
  } catch (error) {
    bad('来源重建失败[' + (error.code || 'PIC_ERROR') + ']：' + error.message);
    return finish();
  }
  const declared = new Set();
  const declaredClose = new Set();
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const manifestCloseFiles = manifest.closePackage && Array.isArray(manifest.closePackage.files)
    ? manifest.closePackage.files : [];
  if (manifestFiles.length === 0) bad('files 清单为空');
  if (manifestCloseFiles.length === 0) bad('closePackage.files 清单为空');
  // 候选清单与关闭清单是两个独立命名空间（关闭条目 rel 不带 close/ 前缀）
  for (const f of manifestFiles) {
    if (!f || typeof f.rel !== 'string' || !REL_PATH_RE.test(f.rel)) { bad('files 清单含非法条目'); continue; }
    if (declared.has(f.rel)) bad('重复清单条目：' + f.rel);
    declared.add(f.rel);
  }
  for (const f of manifestCloseFiles) {
    if (!f || typeof f.rel !== 'string' || !REL_PATH_RE.test(f.rel)) { bad('closePackage.files 清单含非法条目'); continue; }
    if (declaredClose.has(f.rel)) bad('重复关闭清单条目：' + f.rel);
    declaredClose.add(f.rel);
  }
  const checkOne = (rel, expectedBuf, isClose) => {
    const list = isClose ? manifestCloseFiles : manifestFiles;
    const rec = list.find(f => f && f.rel === rel);
    if (!rec) { bad('缺失清单记录：' + rel); return; }
    if (rec.bytes !== expectedBuf.length || rec.sha256 !== sha256Buffer(expectedBuf)) {
      bad('清单记录与重建不符：' + rel);
      return;
    }
    const diskRel = isClose ? 'close/' + rel : rel;
    const abs = path.join(dir, diskRel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch (_) { st = null; }
    if (!st || !st.isFile() || st.isSymbolicLink()) { bad('缺失或非普通文件：' + diskRel); return; }
    const buf = fs.readFileSync(abs);
    if (buf.length !== expectedBuf.length || sha256Buffer(buf) !== sha256Buffer(expectedBuf)) {
      bad('盘上字节/哈希与重建不符：' + diskRel);
    }
    clockCheck('check.read:' + rel);
  };
  for (const [rel, buf] of expected) checkOne(rel, buf, false);
  for (const f of closeFiles) checkOne(f.rel, f.buf, true);

  const planRec = manifestFiles.find(f => f && f.rel === planRel);
  if (!planRec) bad('清单未声明 plan.json');
  else if (planRec.bytes !== planBytes.length || planRec.sha256 !== sha256Buffer(planBytes)) {
    bad('清单 plan.json 条目与实际计划不符');
  }

  // 精确文件集：候选制品 + plan.json + 关闭包（close/ 前缀）+ manifest.json
  const closeKeys = closeFiles.map(f => 'close/' + f.rel);
  const expectedKeys = [...expected.keys(), planRel, ...closeKeys];
  for (const [rel, info] of listExisting(dir)) {
    if (rel === 'manifest.json') continue;
    if (info.isSymlink) { bad('符号链接/junction：' + rel); continue; }
    if (info.isDir) {
      if (!isExpectedPrefix(rel, expectedKeys)) bad('额外目录：' + rel);
      continue;
    }
    if (!expectedKeys.includes(rel)) bad('额外文件：' + rel);
  }
  for (const rel of declared) {
    if (!expectedKeys.includes(rel)) bad('清单声明了非预期文件：' + rel);
  }
  for (const rel of declaredClose) {
    if (!closeKeys.includes('close/' + rel)) bad('关闭清单声明了非预期文件：close/' + rel);
  }
  function finish() {
    clockCheck('check.final');
    return {
      manifest, problems, ok: problems.length === 0,
      files: manifestFiles.length, closeFiles: manifestCloseFiles.length,
      planChecked: problems.length === 0
    };
  }
  return finish();
}

/**
 * 关闭包独立核验：按受审固定输入（已受审业务关闭包的 close 内容）重建预期，
 * 不读 manifest/计划/时钟，不受开启候选损坏或窗口过期影响。
 */
function checkCloseDir(closePackageDir) {
  assertRealDirChain(closePackageDir, 'check-close 输入');
  const closeDir = path.join(closePackageDir, 'close');
  const problems = [];
  let st = null;
  try { st = fs.lstatSync(closeDir); } catch (_) { st = null; }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    return { ok: false, problems: ['close 根缺失或为符号链接/junction'], files: 0 };
  }
  let sourceFiles;
  try {
    // 关闭包的受审固定输入：调用者必须明确给出已受审来源目录（计划或环境变量外的显式参数）
    const sourceDir = process.env.PIC_CLOSE_SOURCE_DIR;
    if (!sourceDir) return { ok: false, problems: ['缺少受审关闭包来源（须显式提供来源目录）'], files: 0 };
    sourceFiles = verifyCloseSource(sourceDir);
  } catch (error) {
    return { ok: false, problems: ['来源重建失败：' + error.message], files: 0 };
  }
  let files = 0;
  const expectedMap = new Map(sourceFiles.map(f => [f.rel, f.buf]));
  for (const [rel, expectedBuf] of expectedMap) {
    const abs = path.join(closeDir, rel);
    let fst = null;
    try { fst = fs.lstatSync(abs); } catch (_) { fst = null; }
    if (!fst || !fst.isFile() || fst.isSymbolicLink()) { problems.push('缺失：close/' + rel); continue; }
    files++;
    const buf = fs.readFileSync(abs);
    if (buf.length !== expectedBuf.length || sha256Buffer(buf) !== sha256Buffer(expectedBuf)) {
      problems.push('与受审来源重建不一致：close/' + rel);
    }
  }
  for (const [rel, info] of listExisting(closeDir)) {
    if (info.isSymlink) { problems.push('符号链接/junction：close/' + rel); continue; }
    if (info.isDir) {
      if (!isExpectedPrefix(rel, [...expectedMap.keys()])) problems.push('多余目录：close/' + rel);
      continue;
    }
    if (!expectedMap.has(rel)) problems.push('额外文件：close/' + rel);
  }
  return { ok: problems.length === 0, problems, files, expectedFiles: expectedMap.size };
}

function main() {
  const argv = process.argv.slice(2);
  try {
    const arg = (name) => {
      const i = argv.indexOf(name);
      return i === -1 ? null : argv[i + 1];
    };
    if (argv[0] === '--check') {
      const dir = arg('--check');
      if (!dir) { console.error('用法：--check <候选目录>'); process.exitCode = 1; return; }
      const r = checkDir(dir);
      console.log(JSON.stringify({
        ok: r.ok, dir, checkRoundId: r.manifest.checkRoundId,
        participantCode: r.manifest.participantCode, synthetic: r.manifest.synthetic,
        files: r.files, closeFiles: r.closeFiles, planChecked: r.planChecked, problems: r.problems
      }, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (argv[0] === '--check-close') {
      const dir = arg('--check-close');
      const source = arg('--close-source');
      if (!dir || !source) { console.error('用法：--check-close <候选目录> --close-source <已受审关闭包目录>'); process.exitCode = 1; return; }
      process.env.PIC_CLOSE_SOURCE_DIR = source;
      const r = checkCloseDir(dir);
      console.log(JSON.stringify({ ok: r.ok, dir, files: r.files, expectedFiles: r.expectedFiles, problems: r.problems }, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    const planPath = arg('--plan');
    const outOverride = arg('--out');
    if (!planPath) { console.error('用法：--plan <计划绝对路径> [--out <输出目录>]'); process.exitCode = 1; return; }
    const result = build(planPath, outOverride);
    const written = result.io.filter(f => f.action === 'written').length;
    const reused = result.io.filter(f => f.action === 'reused').length;
    console.log(JSON.stringify({
      ok: true, outDir: result.outDir, checkRoundId: result.manifest.checkRoundId,
      participantCode: result.manifest.participantCode, synthetic: result.manifest.synthetic,
      files: result.manifest.files.length, closeFiles: result.manifest.closePackage.files.length,
      written, reused
    }, null, 2));
    console.error('提示：候选不是部署批准；本轮未部署、未调用平台、未写库，明文口令不进入任何制品。');
  } catch (error) {
    console.error('[' + (error.code || 'PIC_ERROR') + ']', error.message);
    if (error.wroteFiles) console.error('[已写事实] 本次已写入 ' + error.wroteFiles + ' 个文件：' + error.written.join(', '));
    if (error.partialWrites) {
      console.error('[部分写事实] ' + error.partialWrites.map(p => p.rel + '(' + p.bytesOnDisk + 'B)').join(', '));
    }
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  ERR,
  FIXED_TARGET,
  MANIFEST_SCHEMA,
  PLAN_SCHEMA,
  OUT_PREFIX,
  MAX_WINDOW_MS,
  RECOMMENDED_WINDOW_MS,
  PASS_ENTROPY_MIN_BITS,
  TEMPLATE_DIR,
  SERVER_TEMPLATE_FILES,
  FRONTEND_TEMPLATE_FILES,
  IdentityPackageError,
  readPlan,
  planDigest,
  build,
  checkDir,
  checkCloseDir
});