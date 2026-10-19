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

const MANIFEST_SCHEMA = 'participant-identity-check-candidate/2';
const PLAN_SCHEMA = 'participant-identity-plan/2';
/** 请求分层协议版本：计划/manifest/生成前端配置/服务端适配器四方绑定。 */
const REQUEST_PROTOCOL = 'participant-identity-request/1';
/** 手机预览版本证据（2026-10-19 任务 §2.1）：manifest/前端配置绑定的本机受审包标识。 */
const PREVIEW_EVIDENCE_SCHEMA = 'participant-identity-preview-evidence/1';
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
  'closeSourceDir', 'note', 'keyDiagnostic', 'requestProtocol'
]);
/**
 * 受控键诊断协议版本（与核心模块 KEY_DIAGNOSTIC_SCHEMA 逐字一致）；
 * 通过来源字节断言绑定（下方 assertCoreDiagnosticBinding），防止手改绕过。
 */
const KEY_DIAGNOSTIC_SCHEMA = 'participant-identity-key-diagnostic/1';
const KEY_DIAGNOSTIC_SCOPE = 'request-keys-only';

/** 服务端模板文件（受审来源）。participant-identity-check.js 由核心模块复制而来；request-adapter.js 逐字节复制。 */
const SERVER_TEMPLATE_FILES = Object.freeze(['index.js', 'package.json', 'request-adapter.js']);
/**
 * I1/I2 前置核验（部署映射）：cloudfunctionRoot 下的【直接子目录名 = 云函数名】
 * 是微信云开发/CloudBase 的固定约定（既有业务布局 miniapp/cloudfunctions/scheduleSandbox/
 * 即为此形态，且官方接入文档示例一致）。因此候选服务端制品必须装配到
 * server/scheduleSandbox/ 子目录——server/index.js 直接置于 cloudfunctionRoot 根下
 * 无法映射到既有同名函数 scheduleSandbox。
 */
const SERVER_FN_DIR = 'scheduleSandbox';
const SERVER_FN_ROOT = 'server/' + SERVER_FN_DIR + '/';
/**
 * 配对关闭目录映射（Codex 复查 C1）：
 * 关闭来源（业务关闭包）的 server/** 直接位于 close/server/ 根下，与同名函数约定
 * 不符；本包在装配/重建时把来源 server/** 精确映射为 close/server/scheduleSandbox/**，
 * 其余关闭文件（frontend/**、project.config.json）逐字节保留原相对路径。
 * 来源侧校验仍由未改 package-business-test.checkCloseDir 以**来源原布局**执行。
 */
function adaptCloseRel(sourceRel) {
  return sourceRel.startsWith('server/')
    ? SERVER_FN_ROOT + sourceRel.slice('server/'.length)
    : sourceRel;
}
/** C1-a：关闭清单 mapping 的受审固定声明（build 写入、checkDir 精确核对）。 */
const CLOSE_MAPPING_DECLARATION =
  'close/server/** -> close/server/scheduleSandbox/**（其余 close/<rel> 逐字节保留）';
/** C1-a：关闭清单条目的允许字段（精确绑定，未知字段拒绝）。 */
const CLOSE_MANIFEST_FIELDS = Object.freeze(['rel', 'sourceRel', 'bytes', 'sha256']);
/**
 * I1 SDK 精确版本接线（Codex 执行页 §2）：候选直接依赖钉为**精确** 3.0.1——
 * 本机离线实跑的版本（包装层 + @cloudbase/database 1.4.1 三路转换证据）；
 * 波浪号范围（~2.6.3）不能称精确版本。装配与关闭映射不变量双侧核对。
 */
const PINNED_WX_SERVER_SDK_VERSION = '3.0.1';
/** 关闭包内（映射后）必须满足的同名函数目录校验：配置根 + 仅同名子目录 + 入口齐备。 */
function assertCloseMappingInvariants(expectedMap) {
  // 关闭包项目配置所指 server/ 下，所有制品必须全部位于同名函数子目录
  const serverKeys = [...expectedMap.keys()].filter(k => k.startsWith('server/'));
  if (serverKeys.length === 0) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包映射后 server/ 下没有任何制品。');
  for (const k of serverKeys) {
    if (!k.startsWith(SERVER_FN_ROOT)) {
      fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 server/ 根下出现无法映射到同名函数的制品：' + k);
    }
  }
  for (const must of [SERVER_FN_ROOT + 'index.js', SERVER_FN_ROOT + 'package.json']) {
    if (!expectedMap.has(must)) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包同名函数子目录缺少制品：' + must);
  }
  // 关闭包项目配置的 cloudfunctionRoot 必须为 server/（与同名子目录构成可上传函数目录）
  const cfgBuf = expectedMap.get('project.config.json');
  if (!cfgBuf) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包缺少 project.config.json。');
  let cfg = null;
  try { cfg = JSON.parse(cfgBuf.toString('utf8')); } catch (error) {
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 project.config.json 不是合法 JSON：' + error.message);
  }
  if (cfg.cloudfunctionRoot !== 'server/') {
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 project.config.json cloudfunctionRoot 必须为 server/：' + cfg.cloudfunctionRoot);
  }
  // I1 SDK 精确版本：关闭包同名函数目录的 package.json 同样必须精确 3.0.1
  const closePkgBuf = expectedMap.get(SERVER_FN_ROOT + 'package.json');
  if (!closePkgBuf) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包缺少 ' + SERVER_FN_ROOT + 'package.json。');
  let closePkg = null;
  try { closePkg = JSON.parse(closePkgBuf.toString('utf8')); } catch (error) {
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 package.json 不是合法 JSON：' + error.message);
  }
  const closeSdk = closePkg.dependencies && closePkg.dependencies['wx-server-sdk'];
  if (closeSdk !== PINNED_WX_SERVER_SDK_VERSION) {
    fail(ERR.CLOSE_SOURCE_INVALID,
      '关闭包 wx-server-sdk 依赖必须精确为 ' + PINNED_WX_SERVER_SDK_VERSION +
      '（与候选一致、本机已离线验证），实际：' + closeSdk);
  }
}
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

/**
 * R3：**独立受审内容基线**。
 * 这些摘要来自受审提交，不是在 build/check 时用当下源码自算，也不是 manifest 自报值。
 * 源码变更必须先受审更新本表；否则 build 与 check 一律 SOURCE_DRIFT 拒绝。
 */
const PINNED_SOURCES = Object.freeze({
  'miniapp/scripts/lib/participant-identity-check.cjs': 'cd4de68150e8d69afc69af43451f7d99c5395e8088e425630604cc8cf9ed92e7',
  'miniapp/scripts/templates/participant-identity-check/project.config.json': 'ac3b591b49378d6aa231eca7b742cad7eb550eca4d8701a8c3916e52f2b64b67',
  'miniapp/scripts/templates/participant-identity-check/server/index.js': '76e5b938612bd9dbb10df37f408923eff990e2198e21ee125bbd557decb07bd9',
  'miniapp/scripts/templates/participant-identity-check/server/request-adapter.js': '06e641fe2bd7e0d711f439979070f5688bac469a723c09f76b96bd622f39a5dc',
  'miniapp/scripts/templates/participant-identity-check/server/package.json': 'e7b16fdd6e5df8b4aa150f456f933be15dbe42bc1f1bce7f003dad09202618d9',
  'miniapp/scripts/templates/participant-identity-check/frontend/app.js': '1034d53f9b0f40f04eaecb7700d7a0bae8db892f10f17e3e4c656afd24b7fa36',
  'miniapp/scripts/templates/participant-identity-check/frontend/app.json': 'c4c2ae031c66b97d072b6e91425d42122a3717b37ffb04876ecb07d558d5fcce',
  'miniapp/scripts/templates/participant-identity-check/frontend/app.wxss': 'a775e064562da8b885d00e224057ed71c50ffa9095c0f68ef2e95c994deca846',
  'miniapp/scripts/templates/participant-identity-check/frontend/config/cloud.js': 'e11e6ced687dc3ffec1bd45973543329fb622dc3a37103aba6dd0b3c461f7ffc',
  'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js': 'd0ad76006ce9aa259bb3281df942f5792305e29c2d4c3b170fdf2a16eebe674f',
  'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js': 'debcf869ffd8bcaacdf8467d436e1b67acc5a9f8aa6cbb91df106aa8edae8fca',
  'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.json': 'e98244d8ae77ed59807799067801efaabcb0d35f0d031759b7ee78af8efd073e',
  'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.wxml': 'a1a59cff10420e557a085c19543e646653a7f553037eccb31231e4e04e1282b4',
  'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.wxss': 'f8970ae650922d44e4c5a53e37aa0dca4b44ae75d3707d6b57ba586c0c74a89b'
});

/** 按独立基线校验一组来源字节；漂移即 SOURCE_DRIFT（写前调用）。 */
function assertPinnedSource(absPath, buf, label) {
  const key = relOf(path.relative(ROOT, path.resolve(absPath))).split(path.sep).join('/');
  const pinned = Object.prototype.hasOwnProperty.call(PINNED_SOURCES, key) ? PINNED_SOURCES[key] : undefined;
  if (typeof pinned !== 'string' || !/^[0-9a-f]{64}$/.test(pinned)) {
    fail(ERR.SOURCE_DRIFT, '受审基线缺失或格式无效（须先受审更新）：' + label);
  }
  const actual = sha256Buffer(buf);
  if (actual !== pinned) {
    fail(ERR.SOURCE_DRIFT, '受审来源漂移，拒绝装配/重建（基线 ' + pinned + ' ≠ 实际 ' + actual + '）：' + label);
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
  const buf = fs.readFileSync(abs);
  // R3：内容基线校验（写前拒绝）
  assertPinnedSource(abs, buf, '模板 ' + rel);
  return buf;
}

/** 诊断协议绑定：核心字节必须逐字包含固定协议版本/范围标签（来源漂移即拒绝）。 */
function assertCoreDiagnosticBinding(coreBuf) {
  const text = coreBuf.toString('utf8');
  for (const marker of [
    "const KEY_DIAGNOSTIC_SCHEMA = '" + KEY_DIAGNOSTIC_SCHEMA + "';",
    "const KEY_DIAGNOSTIC_SCOPE = '" + KEY_DIAGNOSTIC_SCOPE + "';"
  ]) {
    if (!text.includes(marker)) {
      fail(ERR.SOURCE_DRIFT, '核心模块缺少受审诊断协议绑定（' + marker + '）。');
    }
  }
}

function readCoreModuleBytes() {
  let st = null;
  try { st = fs.lstatSync(LIB_PATH); } catch (_) { st = null; }
  if (!st || !st.isFile() || st.isSymbolicLink()) fail(ERR.SOURCE_MISSING, '核验核心模块缺失或非普通文件。');
  const buf = fs.readFileSync(LIB_PATH);
  // R3：内容基线校验（写前拒绝）
  assertPinnedSource(LIB_PATH, buf, '核验核心模块');
  // 诊断协议版本与核心字节逐字绑定（防手改绕过）
  assertCoreDiagnosticBinding(buf);
  return buf;
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
    note: plan.note || '',
    keyDiagnostic: plan.keyDiagnostic === true,
    requestProtocol: plan.requestProtocol
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
  // R5：必须 expires > starts（0/负窗口不可运行，写前即拒绝）
  if (!(expires > starts)) {
    fail(ERR.PLAN_WINDOW_INVALID, '核验窗口截止时间必须晚于开始时间（expires > starts）。');
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
  // 受控键诊断开关：缺省即关闭；出现则必须为布尔（普通核验包保持关闭）。
  if (raw.keyDiagnostic !== undefined && typeof raw.keyDiagnostic !== 'boolean') {
    fail(ERR.PLAN_INVALID, 'keyDiagnostic 必须是布尔或缺省。');
  }
  // v2：requestProtocol 必填且精确匹配固定协议版本；缺失/旧版本/未知值一律拒绝，禁止自动升级。
  if (raw.requestProtocol !== REQUEST_PROTOCOL) {
    fail(ERR.PLAN_INVALID, 'requestProtocol 必须精确为 ' + REQUEST_PROTOCOL + '（v2 计划必填）。');
  }
  // 新协议不启用键诊断：keyDiagnostic 只允许 false 或缺省 false，true 拒绝。
  if (raw.keyDiagnostic === true) {
    fail(ERR.PLAN_INVALID, '新协议不启用键诊断：keyDiagnostic 只允许 false 或缺省 false。');
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
    note: raw.note || '',
    keyDiagnostic: raw.keyDiagnostic === true,
    requestProtocol: raw.requestProtocol
  });
}

/**
 * 窗口时钟检查（逐边界真实 Date.now 重读）。
 * phase 由公开入口固定选择，不来自计划/清单/环境/命令行以外任何来源：
 * - 'execute'（build/checkDir 默认）：now<starts 拒绝 WINDOW_NOT_OPEN；
 * - 'prepare'（仅 prepare/checkPreparedDir 传入）：允许 now<starts 提前准备；
 * 两类模式均拒绝 now>=expires（WINDOW_EXPIRED）与 NaN/时钟异常（原分类不变）。
 */
function windowClockCheck(plan, at, phase) {
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
  if (phase !== 'prepare' && nowMs < plan.windowStartsAtMs) fail(ERR.WINDOW_NOT_OPEN, '核验窗口尚未开始[' + at + ']。');
  // R5：恰到截止即拒绝（now >= expires），与核心模块口径统一。
  if (nowMs >= plan.windowExpiresAtMs) fail(ERR.WINDOW_EXPIRED, '核验窗口已截止[' + at + ']。');
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
/**
 * R1：装配布局校验——声明的根目录必须真实存在、app.json 页面唯一且四件套齐备、
 * 页面依赖闭包可解析、固定函数目标与受审常量一致。
 * 这些断言针对**磁盘实际产物**，不依赖「文件被复制」或 VM 手动加载即可判定。
 */
function verifyProjectLayout(expected /* Map<rel, Buffer> */) {
  const configBuf = expected.get('project.config.json');
  if (!configBuf) fail(ERR.SOURCE_DRIFT, '装配缺少 project.config.json。');
  let config;
  try { config = JSON.parse(configBuf.toString('utf8')); } catch (error) {
    fail(ERR.MANIFEST_INVALID, 'project.config.json 不是合法 JSON：' + error.message);
  }
  if (config.appid !== FIXED_TARGET.appId) {
    fail(ERR.PLAN_TARGET_INVALID, 'project.config.json appid 与受审固定目标不一致。');
  }
  if (config.miniprogramRoot !== 'frontend/') {
    fail(ERR.PLAN_TARGET_INVALID, 'project.config.json miniprogramRoot 必须为 frontend/：' + config.miniprogramRoot);
  }
  if (config.cloudfunctionRoot !== 'server/') {
    fail(ERR.PLAN_TARGET_INVALID, 'project.config.json cloudfunctionRoot 必须为 server/：' + config.cloudfunctionRoot);
  }
  // 根目录必须真实存在于产物集内
  for (const root of ['frontend/', 'server/']) {
    const has = [...expected.keys()].some(k => k.startsWith(root));
    if (!has) fail(ERR.SOURCE_DRIFT, '声明的根目录没有任何制品：' + root);
  }
  // app.json：唯一页面 + 四件套齐备
  const appJsonBuf = expected.get('frontend/app.json');
  if (!appJsonBuf) fail(ERR.SOURCE_DRIFT, '装配缺少 frontend/app.json。');
  let appJson;
  try { appJson = JSON.parse(appJsonBuf.toString('utf8')); } catch (error) {
    fail(ERR.MANIFEST_INVALID, 'frontend/app.json 不是合法 JSON：' + error.message);
  }
  if (!Array.isArray(appJson.pages) || appJson.pages.length !== 1) {
    fail(ERR.SOURCE_DRIFT, 'frontend/app.json 必须只声明唯一页面，实际 ' + JSON.stringify(appJson.pages));
  }
  const page = appJson.pages[0];
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    if (!expected.has('frontend/' + page + ext)) {
      fail(ERR.SOURCE_DRIFT, '唯一页面缺少依赖文件：frontend/' + page + ext);
    }
  }
  // 页面依赖闭包：页面 → 专用客户端 → 固定目标配置
  const clientRel = 'frontend/utils/identity-check-client.js';
  const cloudRel = 'frontend/config/cloud.js';
  if (!expected.has(clientRel)) fail(ERR.SOURCE_DRIFT, '装配缺少核验客户端：' + clientRel);
  if (!expected.has(cloudRel)) fail(ERR.SOURCE_DRIFT, '装配缺少固定目标配置：' + cloudRel);
  const pageSrc = expected.get('frontend/' + page + '.js').toString('utf8');
  if (!pageSrc.includes("require('../../utils/identity-check-client')")) {
    fail(ERR.SOURCE_DRIFT, '唯一页面未引用受审核验客户端（依赖闭包不可解析）。');
  }
  const clientSrc = expected.get(clientRel).toString('utf8');
  if (!clientSrc.includes("require('../config/cloud')")) {
    fail(ERR.SOURCE_DRIFT, '核验客户端未引用固定目标配置（依赖闭包不可解析）。');
  }
  // 固定函数/环境目标必须与受审常量一致（从合成 config/cloud.js 实际解析）
  const cloudSrc = expected.get(cloudRel).toString('utf8');
  // 从 config/cloud.js 实际源码解析固定函数名与环境（字符串解析，避免正则回溯歧义）
  const readCloudConstant = (key) => {
    const marker = key + ": '";
    const i = cloudSrc.indexOf(marker);
    if (i < 0) return '';
    const j = cloudSrc.indexOf("'", i + marker.length);
    return j < 0 ? '' : cloudSrc.slice(i + marker.length, j);
  };
  const fnName = readCloudConstant('identityCheckFunction');
  const envName = readCloudConstant('envId');
  if (fnName !== FIXED_TARGET.functionName) {
    fail(ERR.PLAN_TARGET_INVALID, '前端固定函数目标与受审常量不一致：' + fnName);
  }
  if (envName !== FIXED_TARGET.envId) {
    fail(ERR.PLAN_TARGET_INVALID, '前端固定环境目标与受审常量不一致：' + envName);
  }
  // 部署映射校验（I1/I2 前置）：cloudfunctionRoot=server/ 下必须有且仅有同名函数
  // 子目录 scheduleSandbox/，且含 index.js 与 package.json——与既有业务布局
  // miniapp/cloudfunctions/scheduleSandbox/ 同构，目录名即远端函数名。
  const fnDirKeys = [...expected.keys()].filter(k => k.startsWith('server/'));
  for (const k of fnDirKeys) {
    if (!k.startsWith(SERVER_FN_ROOT)) {
      fail(ERR.SOURCE_DRIFT, 'server/ 根下出现无法映射到同名函数的制品（须全部位于 ' + SERVER_FN_ROOT + '）：' + k);
    }
  }
  for (const must of [SERVER_FN_ROOT + 'index.js', SERVER_FN_ROOT + 'package.json']) {
    if (!expected.has(must)) fail(ERR.SOURCE_DRIFT, '同名函数子目录缺少制品：' + must);
  }
  // I1 SDK 精确版本：候选函数 package.json 的 wx-server-sdk 必须精确等于本机已验证版本
  const fnPkgBuf = expected.get(SERVER_FN_ROOT + 'package.json');
  if (!fnPkgBuf) fail(ERR.SOURCE_DRIFT, '装配缺少 ' + SERVER_FN_ROOT + 'package.json。');
  let fnPkg = null;
  try { fnPkg = JSON.parse(fnPkgBuf.toString('utf8')); } catch (error) {
    fail(ERR.MANIFEST_INVALID, SERVER_FN_ROOT + 'package.json 不是合法 JSON：' + error.message);
  }
  const declaredSdk = fnPkg.dependencies && fnPkg.dependencies['wx-server-sdk'];
  if (declaredSdk !== PINNED_WX_SERVER_SDK_VERSION) {
    fail(ERR.PLAN_TARGET_INVALID,
      '候选 wx-server-sdk 依赖必须精确为 ' + PINNED_WX_SERVER_SDK_VERSION +
      '（本机已离线验证版本），实际：' + declaredSdk);
  }
  // 服务端固定目标（装配后入口中的常量）
  const entry = expected.get(SERVER_FN_ROOT + 'index.js');
  if (!entry) fail(ERR.SOURCE_DRIFT, '装配缺少 ' + SERVER_FN_ROOT + 'index.js。');
  const entrySrc = entry.toString('utf8');
  if (!entrySrc.includes("const CONFIG_APP_ID = '" + FIXED_TARGET.appId + "';")) {
    fail(ERR.PLAN_TARGET_INVALID, '服务端 appId 常量与受审固定目标不一致。');
  }
  if (!entrySrc.includes("const CONFIG_ENV_ID = '" + FIXED_TARGET.envId + "';")) {
    fail(ERR.PLAN_TARGET_INVALID, '服务端 envId 常量与受审固定目标不一致。');
  }
  // 受控键诊断：入口必须包含诊断开关锚点行（值由装配锚点替换与 check 重建比对保证）。
  if (!entrySrc.includes('const CONFIG_KEY_DIAGNOSTIC = ')) {
    fail(ERR.PLAN_TARGET_INVALID, '服务端入口缺少受控键诊断开关锚点。');
  }
  // 请求分层协议（v2）：入口引用同目录适配器并在 database 工厂前调用；适配器制品在位；
  // 生成前端配置绑定协议版本；客户端使用 picRequest 内层与配置协议。
  if (!entrySrc.includes("require('./request-adapter')")) {
    fail(ERR.SOURCE_DRIFT, '服务端入口未引用请求适配器。');
  }
  if (!entrySrc.includes('requestAdapter.extractBusinessRequest(event)')) {
    fail(ERR.SOURCE_DRIFT, '服务端入口未调用请求适配器。');
  }
  if (!expected.has(SERVER_FN_ROOT + 'request-adapter.js')) {
    fail(ERR.SOURCE_DRIFT, '装配缺少请求适配器制品：' + SERVER_FN_ROOT + 'request-adapter.js');
  }
  if (readCloudConstant('requestProtocol') !== REQUEST_PROTOCOL) {
    fail(ERR.PLAN_TARGET_INVALID, '生成前端配置协议版本与受审固定协议不一致。');
  }
  if (!clientSrc.includes('picRequest') || !clientSrc.includes('cloudConfig.requestProtocol')) {
    fail(ERR.SOURCE_DRIFT, '核验客户端未使用 picRequest 内层协议。');
  }
  return true;
}

/**
 * 手机预览版本标识（2026-10-19 任务 §2.1）：对固定排序的规范 JSON 取小写 SHA-256。
 * 输入字段（对象键顺序即序列化顺序）：previewEvidenceSchema、requestProtocol、
 * checkRoundId、participantCode、appId、envId、functionName、windowStartsAtIso、
 * windowExpiresAtIso、packerSourceSha256（本打包器源码字节摘要）、frontendTemplates
 * （全部已钉定前端模板的相对路径及**注入前**原始字节摘要，按 FRONTEND_TEMPLATE_FILES
 * 固定顺序）。明确排除：口令/口令摘要、用户标识、planDigest、绝对路径、当前时间、
 * 随机数——同输入必然同标识与同字节；轮次/任一前端模板/打包器版本改变都会改变标识。
 * 计划不接受自报 buildId 或证据豁免字段（计划字段严格枚举，未知字段写前拒绝）。
 */
function computePreviewBuildId(plan) {
  const frontendTemplates = FRONTEND_TEMPLATE_FILES.map(rel => ({
    rel: 'frontend/' + rel,
    sha256: sha256Buffer(readTemplateBytes('frontend/' + rel))
  }));
  const canonical = {
    previewEvidenceSchema: PREVIEW_EVIDENCE_SCHEMA,
    requestProtocol: REQUEST_PROTOCOL,
    checkRoundId: plan.checkRoundId,
    participantCode: plan.participantCode,
    appId: plan.appId,
    envId: plan.envId,
    functionName: plan.functionName,
    windowStartsAtIso: plan.windowStartsAtIso,
    windowExpiresAtIso: plan.windowExpiresAtIso,
    packerSourceSha256: sha256Buffer(fs.readFileSync(__filename)),
    frontendTemplates
  };
  return sha256Buffer(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

function computeArtifacts(plan) {
  const artifacts = new Map();
  // 服务端：核心模块（逐字节复制）+ 入口（唯一锚点替换写入本轮配置）
  const coreBytes = readCoreModuleBytes();
  artifacts.set(SERVER_FN_ROOT + 'participant-identity-check.js', coreBytes);
  for (const rel of SERVER_TEMPLATE_FILES) {
    const raw = readTemplateBytes('server/' + rel);
    if (rel !== 'index.js') {
      artifacts.set(SERVER_FN_ROOT + rel, raw);
      continue;
    }
    let buf = anchorReplace(raw, 'const CONFIG_ENABLED = false;',
      'const CONFIG_ENABLED = ' + (!plan.synthetic) + ';', 'server/scheduleSandbox/index.js#CONFIG_ENABLED');
    buf = anchorReplace(buf, "const CONFIG_APP_ID = '';",
      "const CONFIG_APP_ID = '" + plan.appId + "';", 'server/scheduleSandbox/index.js#CONFIG_APP_ID');
    buf = anchorReplace(buf, "const CONFIG_ENV_ID = '';",
      "const CONFIG_ENV_ID = '" + plan.envId + "';", 'server/scheduleSandbox/index.js#CONFIG_ENV_ID');
    buf = anchorReplace(buf, "const CONFIG_CHECK_ROUND_ID = '';",
      "const CONFIG_CHECK_ROUND_ID = '" + plan.checkRoundId + "';", 'server/scheduleSandbox/index.js#CONFIG_CHECK_ROUND_ID');
    buf = anchorReplace(buf, "const CONFIG_PASSPHRASE_DIGEST = '';",
      "const CONFIG_PASSPHRASE_DIGEST = '" + plan.passphraseDigest + "';", 'server/scheduleSandbox/index.js#CONFIG_PASSPHRASE_DIGEST');
    buf = anchorReplace(buf, 'const CONFIG_WINDOW_STARTS_AT_MS = 0;',
      'const CONFIG_WINDOW_STARTS_AT_MS = ' + plan.windowStartsAtMs + ';', 'server/scheduleSandbox/index.js#CONFIG_WINDOW_STARTS_AT_MS');
    buf = anchorReplace(buf, 'const CONFIG_WINDOW_EXPIRES_AT_MS = 0;',
      'const CONFIG_WINDOW_EXPIRES_AT_MS = ' + plan.windowExpiresAtMs + ';', 'server/scheduleSandbox/index.js#CONFIG_WINDOW_EXPIRES_AT_MS');
    // 受控键诊断开关：默认关闭；仅计划显式 keyDiagnostic:true 的诊断轮替换为 true。
    buf = anchorReplace(buf, 'const CONFIG_KEY_DIAGNOSTIC = false;',
      'const CONFIG_KEY_DIAGNOSTIC = ' + (plan.keyDiagnostic === true) + ';', 'server/scheduleSandbox/index.js#CONFIG_KEY_DIAGNOSTIC');
    artifacts.set(SERVER_FN_ROOT + 'index.js', buf);
  }
  // 前端模板：逐字节复制（页面已收窄为唯一核验页面）；
  // config/cloud.js 按唯一锚点注入**本轮核验轮次**（R5 计划→前端绑定）。
  for (const rel of FRONTEND_TEMPLATE_FILES) {
    const raw = readTemplateBytes('frontend/' + rel);
    if (rel !== 'config/cloud.js') {
      artifacts.set('frontend/' + rel, raw);
      continue;
    }
    const withRound = anchorReplace(raw, "  checkRoundId: ''",
      "  checkRoundId: '" + plan.checkRoundId + "'", 'frontend/config/cloud.js#checkRoundId');
    // 手机预览版本标识（2026-10-19 任务 §2.1）：按唯一锚点注入前端本地只读配置
    const withPreview = anchorReplace(withRound, "  previewBuildId: ''",
      "  previewBuildId: '" + computePreviewBuildId(plan) + "'", 'frontend/config/cloud.js#previewBuildId');
    artifacts.set('frontend/' + rel, withPreview);
  }
  // R1：项目配置来自**本次受审模板**，根路径与实际目录一致：
  // miniprogramRoot=frontend/、cloudfunctionRoot=server/。
  // 原 miniapp/project.config.json 保持零改动（不迁就新包）。
  artifacts.set('project.config.json', readTemplateBytes('project.config.json'));
  // R1：装配完成后立即校验布局（配置根/唯一页面/依赖闭包/固定目标）
  verifyProjectLayout(artifacts);
  return artifacts;
}

/**
 * build/prepare 共用装配主体；窗口模式由公开入口固定选择：
 * - 'execute'：旧 build 严格行为（now<starts 拒绝）；
 * - 'prepare'：允许未来窗口提前准备本地制品（now>=expires/NaN/抛错仍拒绝）。
 * 不新增计划/清单字段，不写时间戳进 manifest——prepare 与 build 在相同计划/源码下
 * 生成的候选及关闭制品逐字节一致；准备事实只出现在返回报告与外置证据。
 */
function buildInternal(planPath, outOverride, windowPhase) {
  const plan = readPlan(planPath);
  windowClockCheck(plan, 'build.readPlan', windowPhase);
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
    // 请求分层协议绑定：计划/manifest/生成前端配置/服务端适配器四方一致（participant-identity-request/1）
    requestProtocol: REQUEST_PROTOCOL,
    // 手机预览版本证据（2026-10-19 任务 §2.1）：manifest 绑定 schema 版本与确定性本机包标识
    previewEvidenceSchema: PREVIEW_EVIDENCE_SCHEMA,
    previewBuildId: computePreviewBuildId(plan),
    // 受控键诊断绑定：开关来自计划；协议版本与核心字节逐字绑定（见 assertCoreDiagnosticBinding）
    keyDiagnostic: plan.keyDiagnostic === true,
    keyDiagnosticSchema: KEY_DIAGNOSTIC_SCHEMA,
    keyDiagnosticScope: KEY_DIAGNOSTIC_SCOPE,
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
      'R2：本次有效核验结果可受控取得完整内部 userId（页面默认只展示尾号，需显式勾选）；',
      '      完整 userId 是标识不是密码，不等于 OPENID/UNIONID，也不构成 P 登记证据。',
      'R5：本轮核验轮次由计划写入服务端配置与前端配置，客户端必须原样带回。',
      '请求分层协议 participant-identity-request/1：业务四字段固定放 picRequest 内层并经适配器严格校验；外层附带字段只查自有键名不读值不传播；旧格式混用/冲突名单/内层额外字段/伪造身份一律拒绝；不自动回退旧格式。',
      'keyDiagnostic 在本协议版本固定为 false（请求分层协议停用键诊断）；历史诊断语义仅存在于受审核心与审计记录，本包不携带、不启用。',
      '本次打包不执行 SDK 本地转换（wx-server-sdk 3.0.1 本地转换已有历史验证）；当前真实平台行为完全未验证。'
    ],
    files: entries,
    closePackage: {
      note: '配对关闭包：复制自已受审本地业务关闭包（先经未改 checkCloseDir 独立校验）；' +
            '来源 server/** 已映射为本包 close/server/scheduleSandbox/**（同名函数目录），其余文件逐字节保留；关闭端无需口令、不依赖开启窗口时效。',
      sourceDir: relOf(path.relative(ROOT, plan.closeSourceDir)),
      mapping: CLOSE_MAPPING_DECLARATION,
      files: closeFiles.map(f => ({
        rel: adaptCloseRel(f.rel),
        sourceRel: f.rel,
        bytes: f.buf.length,
        sha256: sha256Buffer(f.buf)
      }))
    }
  };

  const expected = new Map();
  for (const [rel, buf] of artifacts) expected.set(rel, buf);
  for (const f of closeFiles) expected.set('close/' + adaptCloseRel(f.rel), f.buf);
  expected.set('plan.json', planBytes);
  expected.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  // 关闭映射不变量（写前拒绝）：close 内 server/ 下仅同名函数子目录且入口齐备
  assertCloseMappingInvariants(new Map([...expected].filter(([k]) => k.startsWith('close/'))
    .map(([k, v]) => [k.slice('close/'.length), v])));

  const io = [];
  try {
    windowClockCheck(plan, 'build.precheck', windowPhase);
    const reused = precheckOutDir(outDir, expected);
    for (const r of reused) io.push({ path: r.path, action: 'reused' });
    const reusedRels = new Set(reused.map(r => r.rel));
    for (const [rel, buf] of expected) {
      if (reusedRels.has(rel)) continue;
      windowClockCheck(plan, 'build.write:' + rel, windowPhase);
      writeExclusive(path.join(outDir, rel), buf, io, rel);
    }
    windowClockCheck(plan, 'build.final', windowPhase);
    const result = { outDir, manifest, io };
    if (windowPhase === 'prepare') {
      // 提前准备仅表示本地制品完整（preparationValidated）；明确不是执行批准
      //（executionReady=false，即使当前时间已处于窗口内也不升级）。
      result.phase = 'preparation';
      result.preparationValidated = true;
      result.executionReady = false;
    }
    return result;
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

/** 旧严格构建：now<starts 拒绝（行为与既有事实一致；结果结构不变）。 */
function build(planPath, outOverride) {
  return buildInternal(planPath, outOverride, 'execute');
}

/**
 * 提前准备：允许未来窗口的真实模式计划在候选覆盖前完成本地制品准备。
 * 结果 executionReady=false——仅表示本地制品完整，不是执行批准；
 * 严格核对（checkDir）在窗口开启前对同一目录仍拒绝（WINDOW_NOT_OPEN）。
 */
function prepare(planPath, outOverride) {
  return buildInternal(planPath, outOverride, 'prepare');
}

/**
 * check/检查已准备目录共用主体；窗口模式由公开入口固定选择：
 * - 'execute'：旧 checkDir 严格行为（now<starts 拒绝）；
 * - 'prepare'：checkPreparedDir——允许未来窗口（now>=expires/NaN/抛错仍拒绝），
 *   结果附 phase='preparation'/executionReady=false；不得替代 checkDir 作为执行核对。
 */
function checkDirInternal(dir, windowPhase) {
  assertRealDirChain(dir, 'check 输入');
  const problems = [];
  const bad = msg => problems.push(msg);
  // R4：finish() 会被所有早退路径调用，因此它依赖的量必须在此处完成初始化，
  // 不能留在后面的 const 声明里（否则早退会抛 ReferenceError 遮盖原始拒绝原因）。
  let manifest = null;
  let manifestFiles = [];
  let manifestCloseFiles = [];
  let plan = null;
  let clockStopped = false;
  const clockCheck = at => {
    if (!plan || clockStopped) return;
    try {
      windowClockCheck(plan, at, windowPhase);
    } catch (error) {
      bad('窗口时效检查失败[' + (error.code || 'PIC_ERROR') + ']（' + at + '）：' + error.message);
      clockStopped = true;
    }
  };
  const manifestPath = path.join(dir, 'manifest.json');
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(ERR.MANIFEST_INVALID, 'manifest.json 无法读取：' + error.message);
  }
  manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  manifestCloseFiles = manifest.closePackage && Array.isArray(manifest.closePackage.files)
    ? manifest.closePackage.files : [];
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
    closeSourceDir: relOf(path.relative(ROOT, plan.closeSourceDir)),
    keyDiagnostic: plan.keyDiagnostic === true,
    requestProtocol: plan.requestProtocol,
    // 手机预览版本证据（R2/2026-10-19 任务 §2.1）：从受审来源严格重建并比较，
    // 不信任清单自报值；缺失/未知/伪造/配置与清单不一致均拒绝。
    previewEvidenceSchema: PREVIEW_EVIDENCE_SCHEMA,
    previewBuildId: computePreviewBuildId(plan)
  };
  for (const [k, v] of Object.entries(expectFields)) {
    if (JSON.stringify(manifest[k]) !== JSON.stringify(v)) bad('manifest.' + k + ' 与计划不一致');
  }
  if (manifest.passphraseDigestRecorded !== true) bad('manifest 缺少口令摘要存在标记');
  // R3：诊断协议/scope 由 build 恒定写入，check 对 true/false 两种候选**统一**严格核对；
  // 缺失或任何不符值（含无关字符串）均拒绝，普通包不得因开关关闭而豁免清单绑定。
  if (manifest.keyDiagnosticSchema !== KEY_DIAGNOSTIC_SCHEMA) bad('manifest.keyDiagnosticSchema 与受审诊断协议不一致');
  if (manifest.keyDiagnosticScope !== KEY_DIAGNOSTIC_SCOPE) bad('manifest.keyDiagnosticScope 与受审诊断范围不一致');

  let expected;
  let closeFiles;
  try {
    expected = computeArtifacts(plan);
    // C1：来源 server/** 映射为本包 close/server/scheduleSandbox/**，其余逐字节保留；
    // 来源侧校验（未改 checkCloseDir）仍按来源原布局执行。
    closeFiles = verifyCloseSource(plan.closeSourceDir)
      .map(f => ({ rel: adaptCloseRel(f.rel), sourceRel: f.rel, buf: f.buf }));
    assertCloseMappingInvariants(new Map(closeFiles.map(cf => [cf.rel, cf.buf])));
  } catch (error) {
    bad('来源重建失败[' + (error.code || 'PIC_ERROR') + ']：' + error.message);
    return finish();
  }
  const declared = new Set();
  const declaredClose = new Set();
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
  // C1-a：关闭清单来源绑定——mapping 固定声明 + 每条 sourceRel→rel/bytes/sha256
  // 必须与受审来源重建结果精确一致；缺字段/错字段/伪造来源/错映射均拒绝。
  if (manifest.closePackage && manifest.closePackage.mapping !== CLOSE_MAPPING_DECLARATION) {
    bad('closePackage.mapping 与受审固定映射声明不一致');
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

  // C1-a：关闭清单来源绑定——逐条与受审来源重建结果精确比对。
  // 期望集：closeFiles（rel=映射后、sourceRel=来源原相对路径）。
  const expectedCloseByKey = new Map(closeFiles.map(cf => [cf.rel, {
    rel: cf.rel, sourceRel: cf.sourceRel, bytes: cf.buf.length, sha256: sha256Buffer(cf.buf)
  }]));
  for (const rec of manifestCloseFiles) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue; // 非法条目已在上方记录
    const exp = expectedCloseByKey.get(rec.rel);
    if (!exp) { bad('关闭清单条目无法由受审来源重建：' + rec.rel); continue; }
    for (const k of CLOSE_MANIFEST_FIELDS) {
      if (k === 'rel') continue; // rel 已作为键比对
      if (!Object.prototype.hasOwnProperty.call(rec, k) || rec[k] !== exp[k]) {
        bad('关闭清单字段与受审来源重建不符（' + k + '）：' + rec.rel);
      }
    }
    for (const k of Object.keys(rec)) {
      if (!CLOSE_MANIFEST_FIELDS.includes(k)) bad('关闭清单含未知字段（' + k + '）：' + rec.rel);
    }
  }
  for (const exp of expectedCloseByKey.values()) {
    if (!declaredClose.has(exp.rel)) bad('关闭清单缺少来源映射条目：' + exp.rel);
  }

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
    const result = {
      manifest, problems, ok: problems.length === 0,
      files: manifestFiles.length, closeFiles: manifestCloseFiles.length,
      planChecked: problems.length === 0 && Boolean(manifest)
    };
    if (windowPhase === 'prepare') {
      result.phase = 'preparation';
      result.preparationValidated = result.ok;
      result.executionReady = false; // 准备核对通过也不升级为执行批准
    }
    return result;
  }
  return finish();
}

/** 旧严格核对：now<starts 拒绝（行为与既有事实一致；结果结构不变）。 */
function checkDir(dir) {
  return checkDirInternal(dir, 'execute');
}

/**
 * 已准备目录核对：允许未来窗口（now>=expires/NaN/抛错仍按原分类拒绝）。
 * 成功仅表示本地制品完整（executionReady=false），不能替代 checkDir 的执行前核对。
 */
function checkPreparedDir(dir) {
  return checkDirInternal(dir, 'prepare');
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
  // C1：独立核验同样按映射后布局重建预期（server/** -> server/scheduleSandbox/**），
  // 并要求映射后满足同名函数目录不变量；不读 manifest/计划/时钟。
  let expectedMap;
  try {
    expectedMap = new Map(sourceFiles.map(f => [adaptCloseRel(f.rel), f.buf]));
    assertCloseMappingInvariants(expectedMap);
  } catch (error) {
    return { ok: false, problems: ['关闭映射不变量失败[' + (error.code || 'PIC_ERROR') + ']：' + error.message], files: 0 };
  }
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

const CLI_USAGE = [
  '用法：',
  '  node package-participant-identity-check.cjs --plan <计划绝对路径> [--out <输出目录>]',
  '  node package-participant-identity-check.cjs --check <候选目录绝对路径>',
  '  node package-participant-identity-check.cjs --check-close <候选目录绝对路径> --close-source <已受审关闭包目录>',
  '  node package-participant-identity-check.cjs --prepare <计划绝对路径> [--out <输出目录>]',
  '  node package-participant-identity-check.cjs --check-prepared <已准备候选目录绝对路径>'
].join('\n');

/**
 * CLI 严格参数解析（C1）：逐项解析，纯函数不做任何 IO，全部拒绝发生在
 * readPlan/build/prepare 之前（零产物）。拒绝：额外位置参数、未知选项、
 * 重复选项、缺值（缺下一个令牌或下一个令牌是选项）、模式缺失/多种模式、
 * 不适用组合（--close-source 仅配 --check-close；--out 仅配 --plan/--prepare）。
 * 合法旧语法不变：--plan X [--out Y] | --check D | --check-close D --close-source S
 * | --prepare X [--out Y] | --check-prepared D。
 */
function parseCliArgs(argv) {
  const KNOWN = ['--plan', '--out', '--check', '--check-close', '--close-source', '--prepare', '--check-prepared'];
  const MODE_FLAGS = ['--plan', '--check', '--check-close', '--prepare', '--check-prepared'];
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) return { error: '[用法错误] 出现额外位置参数：' + tok + '。本工具只接受「选项 值」形式。' };
    if (!KNOWN.includes(tok)) return { error: '[用法错误] 未知选项：' + tok };
    if (values.has(tok)) return { error: '[用法错误] 重复选项：' + tok };
    if (i + 1 >= argv.length) return { error: '[用法错误] 选项缺少值：' + tok };
    const value = argv[i + 1];
    if (value.startsWith('--')) return { error: '[用法错误] 选项缺少值（下一个令牌是选项）：' + tok };
    // R4：空字符串值在解析阶段拒绝，不得默认为未提供（缺值语义），也不得触发默认输出目录
    if (value === '') return { error: '[用法错误] 选项值为空字符串：' + tok + '。如未确定路径请省略该选项。' };
    values.set(tok, value);
    i++;
  }
  const modeFlags = MODE_FLAGS.filter(f => values.has(f));
  if (modeFlags.length === 0) return { error: '[用法错误] 缺少模式参数（--plan/--check/--check-close/--prepare/--check-prepared 之一）。' };
  if (modeFlags.length > 1) return { error: '[用法错误] 同时给定多种模式参数（' + modeFlags.join(', ') + '）；一次只能执行一种模式。' };
  const mode = modeFlags[0];
  if (values.has('--close-source') && mode !== '--check-close') return { error: '[用法错误] --close-source 仅可与 --check-close 搭配。' };
  // R4：--check-close 必须显式配对非空 --close-source（空值已被上方拒绝；此处拒绝缺失）
  if (mode === '--check-close' && !values.has('--close-source')) return { error: '[用法错误] --check-close 必须显式搭配非空 --close-source <已受审关闭包目录>。' };
  if (values.has('--out') && mode !== '--plan' && mode !== '--prepare') return { error: '[用法错误] --out 仅可与 --plan 或 --prepare 搭配。' };
  return { mode, values };
}

function main() {
  const argv = process.argv.slice(2);
  const parsed = parseCliArgs(argv); // 纯解析；任何拒绝都不触碰文件系统
  if (parsed.error) {
    console.error(parsed.error);
    console.error(CLI_USAGE);
    process.exitCode = 1;
    return;
  }
  const mode = parsed.mode;
  const values = parsed.values;
  try {
    if (mode === '--check') {
      const dir = values.get('--check');
      const r = checkDir(dir);
      console.log(JSON.stringify({
        ok: r.ok, dir, checkRoundId: r.manifest.checkRoundId,
        participantCode: r.manifest.participantCode, synthetic: r.manifest.synthetic,
        files: r.files, closeFiles: r.closeFiles, planChecked: r.planChecked, problems: r.problems
      }, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (mode === '--check-close') {
      const dir = values.get('--check-close');
      const source = values.get('--close-source');
      process.env.PIC_CLOSE_SOURCE_DIR = source;
      const r = checkCloseDir(dir);
      console.log(JSON.stringify({ ok: r.ok, dir, files: r.files, expectedFiles: r.expectedFiles, problems: r.problems }, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (mode === '--check-prepared') {
      const dir = values.get('--check-prepared');
      const r = checkPreparedDir(dir);
      console.log(JSON.stringify({
        ok: r.ok, phase: r.phase, preparationValidated: r.preparationValidated,
        executionReady: r.executionReady, dir, checkRoundId: r.manifest ? r.manifest.checkRoundId : null,
        participantCode: r.manifest ? r.manifest.participantCode : null,
        files: r.files, closeFiles: r.closeFiles, problems: r.problems
      }, null, 2));
      console.error('提示：executionReady=false——准备核对只表示本地制品完整，不是执行批准；执行前仍须 checkDir。');
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (mode === '--prepare') {
      const planPath = values.get('--prepare');
      const outOverride = values.get('--out');
      const result = prepare(planPath, outOverride);
      const written = result.io.filter(f => f.action === 'written').length;
      const reused = result.io.filter(f => f.action === 'reused').length;
      console.log(JSON.stringify({
        ok: true, phase: result.phase, preparationValidated: result.preparationValidated,
        executionReady: result.executionReady, outDir: result.outDir,
        checkRoundId: result.manifest.checkRoundId, participantCode: result.manifest.participantCode,
        synthetic: result.manifest.synthetic, files: result.manifest.files.length,
        closeFiles: result.manifest.closePackage.files.length, written, reused
      }, null, 2));
      console.error('提示：提前准备仅表示本地制品完整（executionReady=false），不是执行批准；未部署、未调用平台，执行前仍须 checkDir 与剩余时间门槛。');
      return;
    }
    // mode === '--plan'（严格构建）
    const planPath = values.get('--plan');
    const outOverride = values.get('--out');
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
  SERVER_FN_DIR,
  SERVER_FN_ROOT,
  verifyProjectLayout,
  computeArtifacts,
  assertCloseMappingInvariants,
  adaptCloseRel,
  CLOSE_MAPPING_DECLARATION,
  PINNED_WX_SERVER_SDK_VERSION,
  KEY_DIAGNOSTIC_SCHEMA,
  KEY_DIAGNOSTIC_SCOPE,
  REQUEST_PROTOCOL,
  PREVIEW_EVIDENCE_SCHEMA,
  computePreviewBuildId,
  FRONTEND_TEMPLATE_FILES,
  IdentityPackageError,
  readPlan,
  planDigest,
  build,
  prepare,
  checkDir,
  checkPreparedDir,
  checkCloseDir,
  parseCliArgs
});