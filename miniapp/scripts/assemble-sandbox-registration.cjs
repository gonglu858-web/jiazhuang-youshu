#!/usr/bin/env node
/**
 * 本人登记完整测试包与关闭包 —— 本地组装器（L1 / L2）
 * ==================================================
 *
 * 用途：把**已验收**的登记候选制品（服务端八文件＋两份前端配置覆盖）与受审关闭包，
 * 组装成两份**结构完整**的微信小程序项目，用于本地演练与后续受控部署准备：
 *
 *   <out>/registration-project/   登记版：登记服务端 + enabled=true 前端覆盖
 *   <out>/closed-project/         关闭版：受审关闭服务端 + enabled=false 前端覆盖
 *
 * 与既有工具的关系（重要）：
 *  - **不修改** `package-sandbox-registration.cjs`（已验收登记生成器）与
 *    `package-sandbox.cjs`（旧打包器）。本工具只**调用**它们**实际导出**的
 *    受审能力：`checkRegistration`（真实登记校验）、`describeClosedPackage`
 *    （受审关闭包校验）、`readSource` / `resolveInside` / `assertTrustedOutDir` /
 *    `safeReadPackageFile` / `assertTrustedRoot`，以及受审常量。不复制宽松版。
 *  - **不复用**旧打包器的 closed manifest 校验来认定本组装通过。
 *
 * 硬边界：
 *  - 默认仅本地组装/检查：**零云调用、零凭据获取、零网络、不安装依赖**。
 *    CLI 入口安装实际网络拦截（http/https/net/dns），任何调用都会抛错并计数。
 *  - 不存在 deploy / execute / login / upload / preview 等操作，**无 shell 拼接**。
 *  - 输出限定 `artifacts/schedule-sandbox/registration-full-<安全编号>/`，
 *    不得指向源目录、任何既有制品目录或其祖先；不得与输入登记制品重叠。
 *  - **两种本地制品分类**（`artifactKind`，仅为本地标签，不是权限凭据）：
 *      · `synthetic`（默认）：只接受 synthetic=true 合成演练计划，沿用 `/1` 清单契约；
 *      · `real-candidate`：必须**显式**选择，只接受严格 synthetic=false 的完整真实目标
 *        计划，采用**独立** `/2` 清单契约，且 build/check/复用/续建一律按**当前时钟**
 *        判定窗口有效性 —— 不用 generatedAt、文件时间或历史证据时间替代。
 *    两种模式不能互相认领同一目录；不提供跳过检查、改目标或时钟覆盖的绕过开关。
 *  - 不同内容**拒绝覆盖**；缺文件、额外文件、空目录、路径逃逸、链接、伪造 manifest
 *    一律在**任何写入之前**拒绝。**不递归删除**；写入期 I/O 失败保留半成品。
 *  - `deploymentAuthorized=false` / `cloudExecuted=false` 只是**记录**，
 *    **不是**安全授权句柄。真实候选清单同样不表示允许部署、本人已确认或管理员已初始化。
 *
 * 用法：
 *   node scripts/assemble-sandbox-registration.cjs --check --input <登记制品目录>
 *   node scripts/assemble-sandbox-registration.cjs --mode build --plan <plan.json> --input <登记制品目录>
 *   node scripts/assemble-sandbox-registration.cjs --check --input <目录> --target <组装目录>
 *   node scripts/assemble-sandbox-registration.cjs --mode build --artifact-kind real-candidate \
 *        --plan <真实计划.json> --input <登记制品目录>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ── 复用已验收工具的**实际导出**（不修改、不复制宽松版） ─────────────────────
const base = require('./package-sandbox.cjs');
const reg = require('./package-sandbox-registration.cjs');

const ROOT = base.ROOT;
const SOURCE_DIR = base.SOURCE_DIR;
const ARTIFACTS_ROOT = base.ARTIFACTS_ROOT;
const MINIPROGRAM_SRC = path.join(ROOT, 'miniapp', 'miniprogram');
const MINIAPP_SRC = path.join(ROOT, 'miniapp');
const PACKAGE_FILES = reg.PACKAGE_FILES;
const FRONTEND_FILES = reg.FRONTEND_FILES;
const REVIEWED_SOURCE_VERSION = reg.REVIEWED_SOURCE_VERSION;
const CLOSED_DIR = reg.CLOSED_DIR;
const sha256Buffer = reg.sha256Buffer;

/**
 * 组装清单 schema：合成沿用已验收的 /1；真实候选采用**独立** /2。
 * 不原地改 /1 契约，历史合成包继续按 /1 检查与复用。
 */
const ASSEMBLY_MANIFEST_SCHEMA = 'sandbox-registration-full-assembly/1';
const ASSEMBLY_MANIFEST_SCHEMA_REAL = 'sandbox-registration-full-assembly/2';

/**
 * 制品分类（本地标签，**不是**权限凭据）：
 *  - synthetic：默认，只接受 synthetic=true 的合成演练计划；
 *  - real-candidate：必须显式选择，只接受严格 synthetic=false 的完整真实目标计划。
 * 枚举之外的取值、缺参数值、重复或相互矛盾的选项一律在写入前拒绝。
 */
const ARTIFACT_KINDS = Object.freeze(['synthetic', 'real-candidate']);
const DEFAULT_ARTIFACT_KIND = 'synthetic';

/** 离线夹具的核验性质标记：即使走 synthetic=false 分支也不构成真实执行包签发。 */
const VERIFICATION_KIND = 'OFFLINE_CONTRACT_FIXTURE';

/** 输出目录前缀与安全编号形态。 */
const OUT_DIR_PREFIX = 'registration-full-';
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}[a-z0-9]$/;

/** 云函数目录名即函数名（受审固定值，不得把源目录名 `package` 当函数名）。 */
const CLOUD_FUNCTION_NAME = 'scheduleSandbox';

/** 制品唯一页面入口。 */
const ONLY_PAGE = 'pages/schedule-sandbox/schedule-sandbox';

/** 受审源 app.json 的九路由：制品**不得**混入旧业务页面。 */
const SOURCE_PAGES = Object.freeze([
  'pages/index/index',
  'pages/project/project',
  'pages/schedule/schedule',
  'pages/schedule-detail/schedule-detail',
  'pages/record/record',
  'pages/members/members',
  'pages/access/access',
  'pages/permission-check/permission-check',
  ONLY_PAGE
]);

/** project.config.json 固定投影值。 */
const FIXED_APP_ID = 'wxfb4db1615ac15531';
const FIXED_COMPILE_TYPE = 'miniprogram';
const FIXED_MINIPROGRAM_ROOT = 'miniprogram/';
const FIXED_CLOUDFUNCTION_ROOT = 'cloudfunctions/';
const ASSEMBLY_PROJECT_NAME = '装修进度验收-登记演练';

/**
 * project.config.json 保留的编译设置白名单（键必须与受审源完全一致）。
 * 不投影任何开发者个人配置、认证缓存、私密配置或临时源映射。
 */
const PROJECT_SETTING_KEYS = Object.freeze([
  'es6', 'enhance', 'postcss', 'compileWorklet', 'minified', 'uglifyFileName',
  'uploadWithSourceMap', 'packNpmManually', 'packNpmRelationList',
  'minifyWXSS', 'minifyWXML', 'localPlugins', 'disableUseStrict',
  'useCompilerPlugins', 'condition', 'babelSetting'
]);
const BABEL_SETTING_KEYS = Object.freeze(['ignore', 'disablePlugins', 'outputPath']);

/**
 * 本轮**新纳入**文件的独立受审来源基线。
 * 取自 be413a0 的 Git 对象字节，**不是**当前工作区自报指纹。
 */
const PINNED_APP_FILES = Object.freeze({
  'miniapp/miniprogram/app.js': { bytes: 663, sha256: '26ac78fd5a7bd8f852c5c65231b4cb703b6f09e102e9b27991ac1ca1a8c3382d' },
  'miniapp/miniprogram/app.json': { bytes: 517, sha256: '7318ca539c191670b58297ba5008b5403fda5c6b91da99010c35a85434221f80' },
  'miniapp/miniprogram/app.wxss': { bytes: 3360, sha256: 'b548fcaca01f773161315084c6a527eed53338b372af51ae179412811080fd23' },
  'miniapp/miniprogram/config/cloud.js': { bytes: 95, sha256: '4c2a31031ed9e4df513522fdaf7163652b0bdab1896edf49361a1d109d305e93' },
  'miniapp/project.config.json': { bytes: 828, sha256: '4ed4c5556204e4bf936e9c3533013498b9f5612161f2b90faadd4c2c1b033221' }
});

// ── 固定错误码（不外传任意字符串） ────────────────────────────────────────
const ERR = Object.freeze({
  PLAN_MISSING: 'ASM_PLAN_MISSING',
  PLAN_SYNTHETIC_ONLY: 'ASM_PLAN_SYNTHETIC_ONLY',
  PLAN_SYNTHETIC_IN_REAL: 'ASM_PLAN_SYNTHETIC_IN_REAL',
  ARTIFACT_KIND_UNKNOWN: 'ASM_ARTIFACT_KIND_UNKNOWN',
  ARTIFACT_KIND_DUPLICATE: 'ASM_ARTIFACT_KIND_DUPLICATE',
  ARTIFACT_KIND_MISSING_VALUE: 'ASM_ARTIFACT_KIND_MISSING_VALUE',
  ARTIFACT_KIND_CONFLICT: 'ASM_ARTIFACT_KIND_CONFLICT',
  PLAN_REQUIRED_FOR_REAL: 'ASM_PLAN_REQUIRED_FOR_REAL',
  WINDOW_EXPIRED: 'ASM_WINDOW_EXPIRED',
  INPUT_MISSING: 'ASM_INPUT_MISSING',
  INPUT_INVALID: 'ASM_INPUT_INVALID',
  INPUT_OVERLAP: 'ASM_INPUT_OVERLAP',
  SOURCE_DRIFT: 'ASM_SOURCE_DRIFT',
  SOURCE_SHAPE: 'ASM_SOURCE_SHAPE',
  APP_JSON_INVALID: 'ASM_APP_JSON_INVALID',
  PROJECT_CONFIG_INVALID: 'ASM_PROJECT_CONFIG_INVALID',
  CLOSURE_UNKNOWN: 'ASM_CLOSURE_UNKNOWN',
  CLOSURE_EXTERNAL: 'ASM_CLOSURE_EXTERNAL',
  PROJECT_SEMANTICS: 'ASM_PROJECT_SEMANTICS',
  OUT_DIR_UNSAFE: 'ASM_OUT_DIR_UNSAFE',
  ENTRY_SYMLINK: 'ASM_ENTRY_SYMLINK',
  EXTRA_ENTRY: 'ASM_EXTRA_ENTRY',
  CONFLICT: 'ASM_ARTIFACT_CONFLICT',
  INCOMPLETE: 'ASM_ARTIFACT_INCOMPLETE',
  MANIFEST_INVALID: 'ASM_MANIFEST_INVALID',
  MANIFEST_MISMATCH: 'ASM_MANIFEST_MISMATCH',
  WRITE_FAILED: 'ASM_WRITE_FAILED',
  INPUT_REJECTED: 'ASM_INPUT_REJECTED',
  FAILED: 'ASM_FAILED'
});

class AssemblyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail || '';
  }
}

function fail(code, detail) {
  throw new AssemblyError(code, detail);
}

// ── 网络实际拦截（不是硬写零：任何调用都会抛错并计数） ──────────────────────
const NET_GUARD_TARGETS = Object.freeze([
  ['http', 'request'], ['https', 'request'],
  ['net', 'connect'], ['net', 'createConnection'],
  ['dns', 'lookup'], ['dns', 'resolve']
]);

function installNetworkGuard(state) {
  state.attempts = [];
  state.restore = [];
  for (const [modName, fnName] of NET_GUARD_TARGETS) {
    let mod;
    try { mod = require('node:' + modName); } catch (_) { continue; }
    const original = mod[fnName];
    if (typeof original !== 'function') continue;
    Object.defineProperty(mod, fnName, {
      configurable: true,
      writable: true,
      value: function guardedNetworkCall(...args) {
        const label = `${modName}.${fnName}`;
        state.attempts.push(label);
        throw new AssemblyError(ERR.INPUT_REJECTED, `组装器禁止网络访问：${label}`);
      }
    });
    state.restore.push(() => {
      Object.defineProperty(mod, fnName, { configurable: true, writable: true, value: original });
    });
  }
  return state;
}

function restoreNetworkGuard(state) {
  if (state && Array.isArray(state.restore)) {
    for (const undo of state.restore) undo();
    state.restore = [];
  }
}

// ── 通用小工具 ────────────────────────────────────────────────────────────
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n');
}

function safeOutId(seed) {
  const raw = String(seed || '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
  const candidate = cleaned.length >= 2 ? cleaned : 'local';
  return SAFE_ID_RE.test(candidate) ? candidate : 'local';
}

/**
 * 默认输出编号：轮次前缀 + 随机后缀，保证每次组装落在**新目录**。
 * 这样重复组装同一计划不会误命中历史目录（复用只应发生在显式指定同一 outId 时）。
 */
function uniqueOutId(seed) {
  const prefix = safeOutId(seed).slice(0, 20);
  const suffix = crypto.randomBytes(8).toString('hex');
  return safeOutId(`${prefix}-${suffix}`);
}

function facts(rel, buf) {
  return { rel, bytes: buf.length, sha256: sha256Buffer(buf) };
}

/**
 * 受审来源读取：先比对 be413a0 派生的独立基线，再返回字节。
 * 11 个既有前端文件沿用生成器的受审基线；5 个新纳入文件用本轮独立基线。
 */
function readPinnedSource(relKey) {
  const expected = PINNED_APP_FILES[relKey] || reg.PINNED_FACTS[relKey];
  if (!expected) fail(ERR.SOURCE_DRIFT, `未纳入受审基线：${relKey}`);
  const isMini = relKey.startsWith('miniapp/miniprogram/');
  const rel = isMini ? relKey.slice('miniapp/miniprogram/'.length) : relKey.slice('miniapp/'.length);
  const dir = isMini ? MINIPROGRAM_SRC : MINIAPP_SRC;
  let buf;
  try {
    buf = base.readSource(rel, dir);
  } catch (error) {
    fail(ERR.SOURCE_DRIFT, `${relKey} 读取失败：${String(error.message).slice(0, 120)}`);
  }
  if (buf.length !== expected.bytes || sha256Buffer(buf) !== expected.sha256) {
    fail(ERR.SOURCE_DRIFT, `${relKey} 与受审基线不符。`);
  }
  return buf;
}

// ── 受控变换：app.json / project.config.json ────────────────────────────────

/**
 * app.json 受控变换：保留受审源的 `window`，`pages` 精确为唯一测试页。
 * 源九路由**不改**（仓库源文件不动），只约束制品内路由面。
 */
function buildAppJson(sourceBuf) {
  let parsed;
  try { parsed = JSON.parse(sourceBuf.toString('utf8')); }
  catch (_) { fail(ERR.APP_JSON_INVALID, '受审源 app.json 不是合法 JSON。'); }
  if (!isPlainObject(parsed)) fail(ERR.APP_JSON_INVALID, '受审源 app.json 不是对象。');
  const keys = Object.keys(parsed).sort();
  if (canonical(keys) !== canonical(['pages', 'window'])) {
    fail(ERR.APP_JSON_INVALID, `受审源 app.json 顶层键不符：${keys.join(',')}`);
  }
  if (canonical(parsed.pages) !== canonical(SOURCE_PAGES)) {
    fail(ERR.APP_JSON_INVALID, '受审源 app.json 的九路由与基线不符。');
  }
  if (!isPlainObject(parsed.window)) fail(ERR.APP_JSON_INVALID, '受审源 app.json 缺 window。');
  const out = { pages: [ONLY_PAGE], window: parsed.window };
  const buf = jsonBytes(out);
  return { buf, windowSha256: sha256Buffer(Buffer.from(JSON.stringify(parsed.window))) };
}

/**
 * project.config.json 从固定模板 + 受审源白名单投影。
 * 固定 AppID / compileType / miniprogramRoot / cloudfunctionRoot；
 * 保留白名单编译设置；不投影 private config、认证缓存或开发者个人参数。
 */
function buildProjectConfig(sourceBuf) {
  let parsed;
  try { parsed = JSON.parse(sourceBuf.toString('utf8')); }
  catch (_) { fail(ERR.PROJECT_CONFIG_INVALID, '受审源 project.config.json 不是合法 JSON。'); }
  if (!isPlainObject(parsed)) fail(ERR.PROJECT_CONFIG_INVALID, '受审源 project.config.json 不是对象。');
  for (const [key, expected] of [
    ['appid', FIXED_APP_ID],
    ['compileType', FIXED_COMPILE_TYPE],
    ['miniprogramRoot', FIXED_MINIPROGRAM_ROOT],
    ['cloudfunctionRoot', FIXED_CLOUDFUNCTION_ROOT]
  ]) {
    if (parsed[key] !== expected) fail(ERR.PROJECT_CONFIG_INVALID, `受审源 ${key} 与固定值不符。`);
  }
  if (!isPlainObject(parsed.setting)) fail(ERR.PROJECT_CONFIG_INVALID, '受审源缺 setting。');
  const missing = PROJECT_SETTING_KEYS.filter(k => !(k in parsed.setting));
  if (missing.length) fail(ERR.PROJECT_CONFIG_INVALID, `setting 缺键：${missing.join(',')}`);
  if (!isPlainObject(parsed.setting.babelSetting)) fail(ERR.PROJECT_CONFIG_INVALID, 'setting.babelSetting 无效。');
  const babelMissing = BABEL_SETTING_KEYS.filter(k => !(k in parsed.setting.babelSetting));
  if (babelMissing.length) fail(ERR.PROJECT_CONFIG_INVALID, `babelSetting 缺键：${babelMissing.join(',')}`);

  const setting = {};
  for (const key of PROJECT_SETTING_KEYS) {
    setting[key] = key === 'babelSetting'
      ? { ignore: parsed.setting.babelSetting.ignore.slice(), disablePlugins: parsed.setting.babelSetting.disablePlugins.slice(), outputPath: parsed.setting.babelSetting.outputPath }
      : parsed.setting[key];
  }
  const out = {
    appid: FIXED_APP_ID,
    projectname: ASSEMBLY_PROJECT_NAME,
    compileType: FIXED_COMPILE_TYPE,
    miniprogramRoot: FIXED_MINIPROGRAM_ROOT,
    cloudfunctionRoot: FIXED_CLOUDFUNCTION_ROOT,
    setting,
    simulatorPluginLibVersion: isPlainObject(parsed.simulatorPluginLibVersion) ? {} : {},
    packOptions: {
      ignore: Array.isArray(parsed.packOptions && parsed.packOptions.ignore) ? parsed.packOptions.ignore.slice() : [],
      include: Array.isArray(parsed.packOptions && parsed.packOptions.include) ? parsed.packOptions.include.slice() : []
    },
    editorSetting: isPlainObject(parsed.editorSetting) ? {} : {}
  };
  const changedFromSource = Object.keys(out).filter(k => canonical(out[k]) !== canonical(parsed[k]));
  return { buf: jsonBytes(out), settingKeys: PROJECT_SETTING_KEYS.slice(), changedFromSource };
}

// ── 依赖闭包扫描（require / usingComponents / WXML import-include / WXSS） ──
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const USING_COMPONENTS_RE = /"usingComponents"\s*:\s*(\{[\s\S]*?\})\s*[,}\n]/;
const COMPONENT_PATH_RE = /"([^"]+)"\s*:\s*"([^"]+)"/g;
const WXML_SRC_RE = /<(?:import|include)\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/g;
const WXSS_IMPORT_RE = /@import\s+['"]([^'"]+)['"]/g;

function resolveRelative(fromRel, request) {
  const fromDir = path.posix.dirname(fromRel);
  let joined = path.posix.normalize(path.posix.join(fromDir, request));
  if (joined.startsWith('../') || joined === '..' || joined.startsWith('/')) return null;
  if (path.posix.isAbsolute(request)) return null;
  if (!path.posix.extname(joined)) {
    if (hasFile(joined + '.js')) return joined + '.js';
    if (hasFile(joined + '/index.js')) return joined + '/index.js';
    return null;
  }
  return hasFile(joined) ? joined : null;
}

let FILE_INDEX = new Set();
function hasFile(rel) { return FILE_INDEX.has(rel); }

/**
 * 递归检查**前端**依赖闭包。未知依赖**先报告再拒绝**，不自动复制整个旧业务目录。
 * 云函数（`cloudfunctions/`）是 Node 侧平台依赖，本轮不安装、不纳入前端闭包，
 * 其 require 由既有受审登记制品与关闭包保证，不在此重复判定。
 * 返回可审查的边集合；前端非相对 require 视为外部依赖，必须为空。
 */
function scanDependencyClosure(files) {
  FILE_INDEX = new Set(Array.from(files.keys()).filter(rel => !rel.startsWith('cloudfunctions/')));
  const edges = [];
  const external = [];
  const unknown = [];
  for (const rel of Array.from(FILE_INDEX).sort()) {
    const buf = files.get(rel);
    if (rel.endsWith('.js')) {
      const text = buf.toString('utf8');
      let m;
      REQUIRE_RE.lastIndex = 0;
      while ((m = REQUIRE_RE.exec(text)) !== null) {
        const request = m[1];
        if (!request.startsWith('.')) { external.push({ from: rel, request }); continue; }
        const target = resolveRelative(rel, request);
        if (!target) { unknown.push({ from: rel, request }); continue; }
        edges.push({ from: rel, to: target });
      }
    } else if (rel.endsWith('.json')) {
      let parsed = null;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; }
      if (isPlainObject(parsed) && isPlainObject(parsed.usingComponents)) {
        for (const [name, target] of Object.entries(parsed.usingComponents)) {
          if (typeof target !== 'string') { unknown.push({ from: rel, request: name }); continue; }
          edges.push({ from: rel, to: target, kind: 'usingComponents:' + name });
        }
      }
    } else if (rel.endsWith('.wxml')) {
      const text = buf.toString('utf8');
      let m;
      WXML_SRC_RE.lastIndex = 0;
      while ((m = WXML_SRC_RE.exec(text)) !== null) {
        const request = m[1];
        if (!request.startsWith('.')) { external.push({ from: rel, request }); continue; }
        const target = resolveRelative(rel, request);
        if (!target) { unknown.push({ from: rel, request }); continue; }
        edges.push({ from: rel, to: target });
      }
    } else if (rel.endsWith('.wxss')) {
      const text = buf.toString('utf8');
      let m;
      WXSS_IMPORT_RE.lastIndex = 0;
      while ((m = WXSS_IMPORT_RE.exec(text)) !== null) {
        const request = m[1];
        if (!request.startsWith('.')) { external.push({ from: rel, request }); continue; }
        const target = resolveRelative(rel, request);
        if (!target) { unknown.push({ from: rel, request }); continue; }
        edges.push({ from: rel, to: target });
      }
    }
  }
  if (unknown.length) {
    fail(ERR.CLOSURE_UNKNOWN, `依赖无法在制品内解析（不自动复制）：${unknown.slice(0, 5).map(e => e.from + '→' + e.request).join('; ')}`);
  }
  if (external.length) {
    fail(ERR.CLOSURE_EXTERNAL, `存在非相对（npm/内置）依赖，当前无前端依赖基线：${external.slice(0, 5).map(e => e.from + '→' + e.request).join('; ')}`);
  }
  // 可达性：从 app.js 与唯一页面出发确认闭包完整可达
  const adjacency = new Map();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from).push(e.to);
  }
  const entry = 'miniprogram/app.js';
  const pageEntry = 'miniprogram/' + ONLY_PAGE + '.js';
  const reachable = new Set();
  const queue = [entry, pageEntry];
  while (queue.length) {
    const cur = queue.shift();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const next of (adjacency.get(cur) || [])) if (!reachable.has(next)) queue.push(next);
  }
  return {
    scope: 'miniprogram 前端；云函数为 Node 侧平台依赖，本轮不安装',
    scannedFiles: FILE_INDEX.size,
    edges: edges.length,
    reachableFromAppAndPage: reachable.size,
    externalRequires: external.length,
    unresolved: unknown.length,
    sortedFiles: Array.from(FILE_INDEX).sort()
  };
}

// ── 输出树与文件集 ──────────────────────────────────────────────────────────
const PROJECT_FRONTEND_FILES = Object.freeze(
  ['miniprogram/app.js', 'miniprogram/app.json', 'miniprogram/app.wxss', 'miniprogram/config/cloud.js']
    .concat(FRONTEND_FILES.map(r => 'miniprogram/' + r))
    .sort()
);
const PROJECT_CLOUD_FILES = Object.freeze(
  PACKAGE_FILES.map(r => `cloudfunctions/${CLOUD_FUNCTION_NAME}/${r}`).sort()
);
const PROJECT_FILES = Object.freeze(
  ['project.config.json'].concat(PROJECT_FRONTEND_FILES, PROJECT_CLOUD_FILES)
);
const REGISTRATION_ROOT = 'registration-project';
const CLOSED_ROOT = 'closed-project';
const ASSEMBLY_FILES = Object.freeze(
  [REGISTRATION_ROOT, CLOSED_ROOT]
    .flatMap(root => PROJECT_FILES.map(rel => `${root}/${rel}`))
    .concat(['manifest.json'])
    .sort()
);

function allowedDirSet(relFiles) {
  const dirs = new Set();
  for (const rel of relFiles) {
    let d = path.posix.dirname(rel);
    while (d !== '.') { dirs.add(d); d = path.posix.dirname(d); }
  }
  return dirs;
}

/**
 * 整棵树预检：含空目录、链接和非普通文件，全部在**任何写入之前**拒绝。
 * 返回已存在的普通文件字节（Map）。
 */
function inspectTree(dir, allowedFiles) {
  base.assertTrustedRoot(dir, '组装根', { allowMissing: true });
  const allowed = new Set(allowedFiles);
  const dirs = allowedDirSet(allowedFiles);
  const existing = new Map();
  if (!fs.existsSync(dir)) return existing;
  function walk(cur, prefix) {
    for (const name of fs.readdirSync(cur).sort()) {
      const rel = prefix ? prefix + '/' + name : name;
      // 逐级 lstat：底层安全函数拒绝链接/联接时映射为本工具的固定码
      let abs;
      try {
        abs = base.resolveInside(dir, rel, '组装条目');
      } catch (error) {
        if (/符号链接|目录联接/.test(String(error.message))) fail(ERR.ENTRY_SYMLINK, rel);
        throw error;
      }
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) fail(ERR.ENTRY_SYMLINK, rel);
      if (st.isDirectory()) {
        if (!dirs.has(rel)) fail(ERR.EXTRA_ENTRY, `目录不在允许清单（含空目录）：${rel}`);
        walk(abs, rel);
      } else if (st.isFile()) {
        if (!allowed.has(rel)) fail(ERR.EXTRA_ENTRY, rel);
        existing.set(rel, base.safeReadPackageFile(dir, rel).buffer);
      } else {
        fail(ERR.EXTRA_ENTRY, `${rel} 非普通文件。`);
      }
    }
  }
  walk(dir, '');
  return existing;
}

// ── 输出目录解析 ────────────────────────────────────────────────────────────
function resolveOutDir(id) {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) fail(ERR.OUT_DIR_UNSAFE, '输出编号非法。');
  const dir = path.resolve(ARTIFACTS_ROOT, OUT_DIR_PREFIX + id);
  base.assertTrustedOutDir(dir, SOURCE_DIR);
  if (path.dirname(dir) !== path.resolve(ARTIFACTS_ROOT)) fail(ERR.OUT_DIR_UNSAFE, '组装目录必须直接位于制品根下。');
  if (fs.existsSync(dir)) {
    const real = fs.realpathSync(dir);
    if (real !== dir) fail(ERR.OUT_DIR_UNSAFE, '组装目录真实路径与解析结果不符（可能经链接）。');
  }
  return dir;
}

function checkedTarget(dir) {
  const resolved = path.resolve(dir);
  const name = path.basename(resolved);
  if (!name.startsWith(OUT_DIR_PREFIX)) fail(ERR.OUT_DIR_UNSAFE, '仅检查本组装器的输出目录。');
  if (!SAFE_ID_RE.test(name.slice(OUT_DIR_PREFIX.length))) fail(ERR.OUT_DIR_UNSAFE, '组装目录编号非法。');
  base.assertTrustedOutDir(resolved, SOURCE_DIR);
  return resolved;
}

/**
 * 输出目录不得与输入登记制品、关闭包、源目录或任何既有制品重叠。
 * 只把**非本组装器命名空间**的既有制品视为冲突；同前缀的其他组装目录是
 * 各自独立的安全隔离输出（同一父目录下互不嵌套即无重叠）。
 */
function assertNoOverlap(dir, inputDir) {
  const resolved = path.resolve(dir);
  const closedDir = path.resolve(ARTIFACTS_ROOT, CLOSED_DIR);
  // 受审输入与源目录：输出目录**本身就是**其中之一也判冲突（不得改写它们）
  const protectedPaths = [inputDir, closedDir, SOURCE_DIR, MINIPROGRAM_SRC, MINIAPP_SRC]
    .filter(Boolean).map(p => path.resolve(p));
  for (const o of protectedPaths) {
    if (resolved === o || resolved.startsWith(o + path.sep) || o.startsWith(resolved + path.sep)) {
      fail(ERR.INPUT_OVERLAP, `组装目录与受审来源重叠：${o}`);
    }
  }
  // 其他既有制品（非本组装器命名空间）：不得落入或包含它们
  if (fs.existsSync(ARTIFACTS_ROOT)) {
    for (const name of fs.readdirSync(ARTIFACTS_ROOT)) {
      if (name.startsWith(OUT_DIR_PREFIX)) continue;
      const other = path.resolve(ARTIFACTS_ROOT, name);
      if (resolved === other || resolved.startsWith(other + path.sep) || other.startsWith(resolved + path.sep)) {
        fail(ERR.INPUT_OVERLAP, `组装目录与既有制品重叠：${other}`);
      }
    }
  }
  // 同命名空间内仍禁止互相嵌套（防止把 A 的产物写进 B）
  if (fs.existsSync(ARTIFACTS_ROOT)) {
    for (const name of fs.readdirSync(ARTIFACTS_ROOT)) {
      if (!name.startsWith(OUT_DIR_PREFIX)) continue;
      const other = path.resolve(ARTIFACTS_ROOT, name);
      if (other === resolved) continue;
      if (resolved.startsWith(other + path.sep)) {
        fail(ERR.INPUT_OVERLAP, `组装目录嵌套在另一组装目录内：${other}`);
      }
    }
  }
}

// ── 输入校验：调用真实 checkRegistration（绑定完整计划与清单） ────────────────
function resolveInputDir(inputDir) {
  if (typeof inputDir !== 'string' || !inputDir.trim()) fail(ERR.INPUT_MISSING, '必须显式指定 --input 登记制品目录（不扫描取最新）。');
  const resolved = path.resolve(inputDir);
  const name = path.basename(resolved);
  if (path.dirname(resolved) !== path.resolve(ARTIFACTS_ROOT) || !name.startsWith('registration-')) {
    fail(ERR.INPUT_INVALID, '输入必须是制品根下以 registration- 开头的单个登记制品目录。');
  }
  if (resolved.startsWith(path.resolve(ARTIFACTS_ROOT) + path.sep + OUT_DIR_PREFIX)) {
    fail(ERR.INPUT_INVALID, '输入不得是本组装器的输出目录。');
  }
  return resolved;
}

/**
 * 登记制品 → 服务端八文件 + 两份前端覆盖（读取受审安全读点）。
 *
 * 时钟：真实候选分支必须把**当前时钟**传给生成器，使已过期的登记输入在
 * 第一次输出写入之前就被拒绝；合成模式不传，保持既有可复验行为。
 */
function readRegistrationInput(inputDir, plan, options = {}) {
  const checkOptions = { outDir: inputDir, plan };
  if (options.nowMs !== undefined) checkOptions.nowMs = options.nowMs;
  const checked = reg.checkRegistration(checkOptions);
  if (!checked.ok) {
    const first = checked.problems && checked.problems[0];
    fail(ERR.INPUT_REJECTED, `登记制品校验未通过：${first ? first.code : 'unknown'} ${first ? first.detail : ''}`.slice(0, 220));
  }
  if (checked.wroteFiles || checked.cloudCalled) fail(ERR.INPUT_REJECTED, '登记校验不应写盘或调用云端。');

  const server = new Map();
  for (const rel of PACKAGE_FILES) {
    const buf = readInputFile(inputDir, 'package/' + rel);
    const pinned = reg.PINNED_FACTS['miniapp/cloudfunctions/scheduleSandbox/' + rel];
    if (!pinned) fail(ERR.INPUT_REJECTED, `登记服务端文件未纳入受审基线：${rel}`);
    if (rel === 'index.js' || rel === 'gate.js') {
      // 这两个是登记变换产物：逐字节等于「本次完整计划」的确定性变换结果，
      // 由 checkRegistration 内部重算校验；此处再确认非空且为普通文件。
      if (buf.length === 0) fail(ERR.INPUT_REJECTED, `登记服务端文件为空：${rel}`);
    } else if (buf.length !== pinned.bytes || sha256Buffer(buf) !== pinned.sha256) {
      fail(ERR.INPUT_REJECTED, `登记服务端未变换文件与受审字节不符：${rel}`);
    }
    server.set(rel, buf);
  }
  const frontEnabled = readInputFile(inputDir, 'package/frontend/config/schedule-sandbox-proof.js');
  const frontClosed = readInputFile(inputDir, 'package/frontend-closed/config/schedule-sandbox-proof.js');
  const manifestBuf = readInputFile(inputDir, 'manifest.json');
  return { dir: path.basename(inputDir), server, frontEnabled, frontClosed, manifestBuf };
}

function readInputFile(inputDir, rel) {
  let read;
  try {
    read = base.safeReadPackageFile(inputDir, rel);
  } catch (error) {
    if (/符号链接|目录联接/.test(String(error.message))) fail(ERR.ENTRY_SYMLINK, rel);
    throw error;
  }
  if (!read.exists) fail(ERR.INPUT_REJECTED, `登记制品缺文件：${rel}`);
  return read.buffer;
}

/** 受审关闭包八文件（复用受审校验，不改关闭包）。 */
function readClosedInput() {
  const described = reg.describeClosedPackage();
  const dir = path.join(ARTIFACTS_ROOT, CLOSED_DIR);
  const server = new Map();
  for (const f of described.files) {
    const buf = base.safeReadPackageFile(dir, 'package/' + f.rel).buffer;
    if (buf.length !== f.bytes || sha256Buffer(buf) !== f.sha256) {
      fail(ERR.INPUT_REJECTED, `关闭包文件漂移：${f.rel}`);
    }
    server.set(f.rel, buf);
  }
  return { dir: CLOSED_DIR, described, server };
}

// ── 计划 ────────────────────────────────────────────────────────────────────
/**
 * 校验制品分类。未知取值、缺值、非字符串一律拒绝。
 * `artifactKind` 只是本地制品分类，不是权限凭据，也不代表部署批准。
 */
function normalizeArtifactKind(value) {
  if (value === undefined || value === null) return DEFAULT_ARTIFACT_KIND;
  if (typeof value !== 'string' || value === '') {
    fail(ERR.ARTIFACT_KIND_MISSING_VALUE, 'artifactKind 必须是非空字符串。');
  }
  if (!ARTIFACT_KINDS.includes(value)) {
    fail(ERR.ARTIFACT_KIND_UNKNOWN, `artifactKind 仅允许 ${ARTIFACT_KINDS.join(' / ')}。`);
  }
  return value;
}

/**
 * 按模式校验完整计划。**不放宽**生成器的任何契约：
 * 仍调用真实 `reg.validatePlan`（固定目标、单一本人、来源版本、≤30 分钟窗口）。
 *  - synthetic（默认）：只接受 synthetic=true，保留 ASM_PLAN_SYNTHETIC_ONLY 防线；
 *  - real-candidate：只接受严格 synthetic=false，合成计划不得改标记后默许通过。
 */
function normalizeAssemblyPlan(plan, options = {}) {
  if (!isPlainObject(plan)) fail(ERR.PLAN_MISSING, '计划必须为对象。');
  const kind = normalizeArtifactKind(options.artifactKind);
  // 与生成器同一校验，并支持注入时钟以便离线复跑（生产命令行取 Date.now()）
  const normalized = reg.validatePlan(plan, options.nowMs === undefined ? {} : { nowMs: options.nowMs });
  if (kind === 'synthetic') {
    if (normalized.synthetic !== true) {
      fail(ERR.PLAN_SYNTHETIC_ONLY,
        '默认合成模式只接受 synthetic=true 的合成演练计划；真实候选须显式选择 real-candidate 模式。');
    }
  } else if (normalized.synthetic !== false) {
    fail(ERR.PLAN_SYNTHETIC_IN_REAL,
      'real-candidate 模式只接受严格 synthetic=false 的完整计划，不接受合成计划。');
  }
  return { kind, plan: normalized };
}

/**
 * 当前时效复核（仅真实候选分支）。
 *
 * **不得**用 generatedAt、文件时间或历史证据时间替代当前时钟 —— 那样会让已过期
 * 的候选包通过检查。真实候选的 build / check / 复用 / 续建一律按调用时刻判定：
 * `expires <= now` 即失效。合成模式不启用本函数，保持既有可复验逻辑。
 */
function assertCandidateNotExpired(plan, nowMs, stage) {
  if (!Number.isFinite(nowMs)) fail(ERR.WINDOW_EXPIRED, `${stage}：时钟无效。`);
  const expires = Date.parse(plan.windowExpiresAt);
  if (!Number.isFinite(expires)) fail(ERR.WINDOW_EXPIRED, `${stage}：窗口截止无效。`);
  if (expires <= nowMs) {
    fail(ERR.WINDOW_EXPIRED,
      `${stage}：登记候选窗口已于 ${plan.windowExpiresAt} 截止（当前 ${new Date(nowMs).toISOString()}），不再有效。`);
  }
  return true;
}

// ── 项目文件集装配 ──────────────────────────────────────────────────────────
function buildProjectFiles(ctx, variant) {
  const files = new Map();
  const cloudRoot = `cloudfunctions/${CLOUD_FUNCTION_NAME}/`;

  // 受审前端闭包：11 文件按实际依赖闭包保留（与生成器同一基线）
  for (const rel of FRONTEND_FILES) {
    if (rel === 'config/schedule-sandbox-proof.js') continue; // 由覆盖提供
    files.set('miniprogram/' + rel, readPinnedSource('miniapp/miniprogram/' + rel));
  }
  // 唯一允许被替换的前端配置：登记/关闭覆盖
  files.set(
    'miniprogram/config/schedule-sandbox-proof.js',
    variant === 'registration' ? ctx.registration.frontEnabled : ctx.registration.frontClosed
  );
  // 新纳入的 App 入口文件
  files.set('miniprogram/app.js', readPinnedSource('miniapp/miniprogram/app.js'));
  files.set('miniprogram/app.wxss', readPinnedSource('miniapp/miniprogram/app.wxss'));
  files.set('miniprogram/config/cloud.js', readPinnedSource('miniapp/miniprogram/config/cloud.js'));
  files.set('miniprogram/app.json', ctx.appJson.buf);
  files.set('project.config.json', ctx.projectConfig.buf);

  // 服务端八文件：目录名即函数名；逐字节取自对应受审输入
  const source = variant === 'registration' ? ctx.registration.server : ctx.closed.server;
  for (const rel of PACKAGE_FILES) files.set(cloudRoot + rel, source.get(rel));

  // 输出树必须与声明的文件集逐项一致
  const got = Array.from(files.keys()).sort();
  if (canonical(got) !== canonical(PROJECT_FILES.slice().sort())) {
    fail(ERR.SOURCE_SHAPE, '项目文件集与声明不符。');
  }
  return files;
}

// ── 制品语义校验（既验字节也验配置意义） ────────────────────────────────────
function assertProjectSemantics(files, variant) {
  const readJson = rel => {
    try { return JSON.parse(files.get(rel).toString('utf8')); }
    catch (_) { fail(ERR.PROJECT_SEMANTICS, `${rel} 不是合法 JSON。`); }
  };
  const appJson = readJson('miniprogram/app.json');
  if (canonical(appJson.pages) !== canonical([ONLY_PAGE])) {
    fail(ERR.PROJECT_SEMANTICS, 'app.json 页面路由不是唯一测试页。');
  }
  if (!isPlainObject(appJson.window)) fail(ERR.PROJECT_SEMANTICS, 'app.json 缺 window。');
  if (canonical(Object.keys(appJson).sort()) !== canonical(['pages', 'window'])) {
    fail(ERR.PROJECT_SEMANTICS, 'app.json 顶层键不符。');
  }
  const pc = readJson('project.config.json');
  if (pc.appid !== FIXED_APP_ID) fail(ERR.PROJECT_SEMANTICS, 'project.config.json appid 不符。');
  if (pc.compileType !== FIXED_COMPILE_TYPE) fail(ERR.PROJECT_SEMANTICS, 'compileType 不符。');
  if (pc.miniprogramRoot !== FIXED_MINIPROGRAM_ROOT) fail(ERR.PROJECT_SEMANTICS, 'miniprogramRoot 不符。');
  if (pc.cloudfunctionRoot !== FIXED_CLOUDFUNCTION_ROOT) fail(ERR.PROJECT_SEMANTICS, 'cloudfunctionRoot 不符。');
  if (!isPlainObject(pc.setting)) fail(ERR.PROJECT_SEMANTICS, 'project.config.json 缺 setting。');
  for (const key of PROJECT_SETTING_KEYS) if (!(key in pc.setting)) fail(ERR.PROJECT_SEMANTICS, `setting 缺 ${key}。`);
  if (Object.keys(pc.setting).sort().join(',') !== PROJECT_SETTING_KEYS.slice().sort().join(',')) {
    fail(ERR.PROJECT_SEMANTICS, 'setting 含白名单外键。');
  }
  const forbidden = ['private', 'condition', 'packNpmManuallySecret'];
  for (const key of Object.keys(pc)) {
    if (key === 'projectname') continue;
    if (forbidden.includes(key)) fail(ERR.PROJECT_SEMANTICS, `project.config.json 含禁止键 ${key}。`);
  }
  if (JSON.stringify(pc).includes('project.private.config')) {
    fail(ERR.PROJECT_SEMANTICS, 'project.config.json 混入 private config 引用。');
  }
  // 云函数目录名即函数名，且八文件齐全、无 package/frontend 覆盖目录混入
  for (const rel of PACKAGE_FILES) {
    if (!files.has(`cloudfunctions/${CLOUD_FUNCTION_NAME}/${rel}`)) {
      fail(ERR.PROJECT_SEMANTICS, `云函数缺文件：${rel}`);
    }
  }
  for (const rel of files.keys()) {
    if (!rel.startsWith('cloudfunctions/')) continue;
    if (!rel.startsWith(`cloudfunctions/${CLOUD_FUNCTION_NAME}/`)) fail(ERR.PROJECT_SEMANTICS, `云函数目录名不符：${rel}`);
    if (rel.includes('/frontend')) fail(ERR.PROJECT_SEMANTICS, '覆盖目录不得进入云函数。');
  }
  // 唯一页面入口的四个文件齐全
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    if (!files.has(`miniprogram/${ONLY_PAGE}${ext}`)) fail(ERR.PROJECT_SEMANTICS, `唯一页面缺 ${ext}。`);
  }
  // 旧 access / 旧业务页面不得混入
  for (const rel of files.keys()) {
    if (/^miniprogram\/pages\//.test(rel) && !rel.startsWith(`miniprogram/pages/schedule-sandbox/`)) {
      fail(ERR.PROJECT_SEMANTICS, `混入旧业务页面：${rel}`);
    }
    if (/^miniprogram\/utils\/.*probe\.js$/.test(rel)) fail(ERR.PROJECT_SEMANTICS, `混入旧探测工具：${rel}`);
  }
  // 前端覆盖的 enabled 必须与变体一致
  const proof = files.get('miniprogram/config/schedule-sandbox-proof.js').toString('utf8');
  const enabledMatch = /enabled:\s*(true|false)/.exec(proof);
  if (!enabledMatch) fail(ERR.PROJECT_SEMANTICS, '前端覆盖缺 enabled 字段。');
  const expectedEnabled = variant === 'registration';
  if ((enabledMatch[1] === 'true') !== expectedEnabled) {
    fail(ERR.PROJECT_SEMANTICS, `前端覆盖 enabled 与${variant === 'registration' ? '登记' : '关闭'}版本不符。`);
  }
  if (!/functionName:\s*"scheduleSandbox"/.test(proof)) fail(ERR.PROJECT_SEMANTICS, '前端覆盖函数名不符。');
  if (!/envId:\s*"cloud1-d8gcq5ag39d847723"/.test(proof)) fail(ERR.PROJECT_SEMANTICS, '前端覆盖环境不符。');
  return { onlyPage: ONLY_PAGE, appid: FIXED_APP_ID, functionName: CLOUD_FUNCTION_NAME, frontendEnabled: expectedEnabled };
}

// ── 清单 ────────────────────────────────────────────────────────────────────
/**
 * 组装清单。合成沿用已验收的 /1 契约与字段；真实候选采用独立 /2 并显式记录
 * `artifactKind=real-candidate`、`synthetic=false`。
 *
 * 两种模式的清单都**不包含**"允许部署""本人已确认""管理员已初始化"这类断言；
 * `deploymentAuthorized/cloudExecuted/uploaded/previewed` 恒为 false。
 * `verificationKind` 标明这是离线契约夹具核验，不是真实执行包签发。
 */
function buildManifest(ctx, plan, projects, closure, delta, generatedAt, kind = DEFAULT_ARTIFACT_KIND) {
  const isReal = kind === 'real-candidate';
  const base = {
    schema: isReal ? ASSEMBLY_MANIFEST_SCHEMA_REAL : ASSEMBLY_MANIFEST_SCHEMA,
    generatedAt,
    synthetic: isReal ? false : true,
    deploymentAuthorized: false,
    cloudExecuted: false,
    uploaded: false,
    previewed: false,
    networkAttempts: 0,
    artifactKind: kind,
    verificationKind: VERIFICATION_KIND,
    cloudFunctionName: CLOUD_FUNCTION_NAME,
    onlyPage: ONLY_PAGE,
    plan: { ...plan, allowedUserIds: Array.from(plan.allowedUserIds) },
    planDigest: ctx.planDigest,
    input: {
      registrationArtifact: {
        dir: ctx.registration.dir,
        manifestSha256: sha256Buffer(ctx.registration.manifestBuf),
        verification: '真实 checkRegistration 绑定完整计划与清单重算'
      },
      closedPackage: {
        dir: ctx.closed.dir,
        manifestSha256: ctx.closed.described.manifestSha256,
        setDigest: ctx.closed.described.setDigest,
        totalBytes: ctx.closed.described.totalBytes,
        verification: ctx.closed.described.verification
      },
      reviewedSource: { version: REVIEWED_SOURCE_VERSION, setDigest: reg.sourceSetDigest(reg.readReviewedSources()) },
      frontendBaseline: { version: REVIEWED_SOURCE_VERSION, files: FRONTEND_FILES.slice() },
      appBaseline: { version: REVIEWED_SOURCE_VERSION, keys: Object.keys(PINNED_APP_FILES).slice() }
    },
    controlledTransforms: {
      appJson: {
        sourcePages: SOURCE_PAGES.slice(),
        artifactPages: [ONLY_PAGE],
        sourceSha256: PINNED_APP_FILES['miniapp/miniprogram/app.json'].sha256,
        artifactSha256: sha256Buffer(ctx.appJson.buf),
        windowSha256: ctx.appJson.windowSha256,
        note: '仅保留 window 并收窄 pages；仓库源九路由未改。'
      },
      projectConfig: {
        fixed: {
          appid: FIXED_APP_ID, compileType: FIXED_COMPILE_TYPE,
          miniprogramRoot: FIXED_MINIPROGRAM_ROOT, cloudfunctionRoot: FIXED_CLOUDFUNCTION_ROOT
        },
        settingKeys: ctx.projectConfig.settingKeys,
        changedFromSource: ctx.projectConfig.changedFromSource,
        sourceSha256: PINNED_APP_FILES['miniapp/project.config.json'].sha256,
        artifactSha256: sha256Buffer(ctx.projectConfig.buf),
        note: '固定模板 + 受审白名单投影；未投影 private config、认证缓存或个人参数。'
      }
    },
    projects: {
      registration: {
        root: REGISTRATION_ROOT,
        fileCount: projects.registration.size,
        totalBytes: Array.from(projects.registration.values()).reduce((n, b) => n + b.length, 0),
        files: Array.from(projects.registration.keys()).sort().map(rel => facts(rel, projects.registration.get(rel)))
      },
      closed: {
        root: CLOSED_ROOT,
        fileCount: projects.closed.size,
        totalBytes: Array.from(projects.closed.values()).reduce((n, b) => n + b.length, 0),
        files: Array.from(projects.closed.keys()).sort().map(rel => facts(rel, projects.closed.get(rel)))
      }
    },
    projectDelta: delta,
    dependencyClosure: closure,
    allowedDifferences: [
      'miniprogram/config/schedule-sandbox-proof.js：登记 enabled=true / 关闭 enabled=false。',
      'cloudfunctions/scheduleSandbox/index.js 与 gate.js：登记服务端为受控变换产物；其余六文件与关闭版逐字节相同。',
      '两份项目其余文件逐字节相同；app.json 两份完全相同（同一受控变换）。'
    ],
    limitations: (isReal ? [
      '真实候选模式：本地文件契约有效，**不是**部署授权、云端证明、本人身份复核或真实执行批准。',
      '本清单不表示允许部署、本人已确认或管理员已初始化；检查通过仅说明本时点字节与计划一致且窗口未过期。',
      '窗口过期只否定登记候选当前可用，**不代表关闭包失效**；关闭依据独立受审关闭制品与实际字节回读。',
      '关闭包不靠重新开启登记窗口获得使用资格。',
      'windowStartsAt 不是服务端的「未到时不可调用」守卫；启用时间须由未来部署流程控制，本轮未改 gate。',
      '未安装 wx-server-sdk、无 node_modules；依赖安装与平台运行时留作后续具体执行包。',
      '未部署、未预览、未上传、未联网、未取凭据、未本人登记、未初始化管理员。',
      '首次尚未绑定账号的 identify 未知结果无持久防重：只证明不自动重发，必须停止并核对。'
    ] : [
      '本地组装结果，不是部署授权、云端证明或真实执行批准。',
      '本轮只接受 synthetic=true 合成计划；合成包不得转为真实包或上传。',
      '未安装 wx-server-sdk、无 node_modules、依赖安装与平台运行时留作后续具体执行包。',
      '未部署、未预览、未上传、未联网、未取凭据、未本人登记、未初始化管理员。',
      '页面仍保留既有动作选择器；唯一页面不等于唯一按钮，登记期服务端仅允许 identify。',
      '旧入口与前端驱动开关保持关闭；完整包不含 access 与旧业务页面。',
      '首次尚未绑定账号的 identify 未知结果无持久防重：只证明不自动重发，必须停止并核对。',
      'WXML/WXSS 本机编译通过不等于完整微信构建、真机或平台通过。',
      '云函数目录名即函数名，部署时不得提交名为 package 的目录。'
    ])
  };
  return base;
}

function computeDelta(projects) {
  const delta = [];
  const a = projects.registration;
  const b = projects.closed;
  for (const rel of PROJECT_FILES.slice().sort()) {
    const left = a.get(rel);
    const right = b.get(rel);
    if (!left || !right) fail(ERR.SOURCE_SHAPE, `项目缺文件：${rel}`);
    if (left.equals(right)) continue;
    delta.push({
      rel,
      registrationSha256: sha256Buffer(left),
      closedSha256: sha256Buffer(right),
      side: rel.startsWith('cloudfunctions/') ? 'server' : 'frontend'
    });
  }
  const expectedFrontend = ['miniprogram/config/schedule-sandbox-proof.js'];
  const expectedServer = ['cloudfunctions/scheduleSandbox/gate.js', 'cloudfunctions/scheduleSandbox/index.js'];
  const actualFrontend = delta.filter(d => d.side === 'frontend').map(d => d.rel).sort();
  const actualServer = delta.filter(d => d.side === 'server').map(d => d.rel).sort();
  if (canonical(actualFrontend) !== canonical(expectedFrontend.slice().sort())) {
    fail(ERR.SOURCE_SHAPE, `前端差异面不符：${actualFrontend.join(',')}`);
  }
  if (canonical(actualServer) !== canonical(expectedServer.slice().sort())) {
    fail(ERR.SOURCE_SHAPE, `服务端差异面不符：${actualServer.join(',')}`);
  }
  return delta.sort((x, y) => (x.rel < y.rel ? -1 : 1));
}

// ── 期望内容（check 与 build 共用，从受审来源与完整输入重算） ────────────────
function computeExpected(plan, inputDir, options = {}) {
  const { kind, plan: normalized } = normalizeAssemblyPlan(plan, options);
  const registration = readRegistrationInput(inputDir, normalized, { nowMs: options.nowMs });
  const closed = readClosedInput();
  const appJson = buildAppJson(readPinnedSource('miniapp/miniprogram/app.json'));
  const projectConfig = buildProjectConfig(readPinnedSource('miniapp/project.config.json'));
  const ctx = {
    registration, closed, appJson, projectConfig,
    planDigest: sha256Buffer(Buffer.from(canonical({
      purpose: normalized.purpose, roundId: normalized.roundId,
      windowStartsAt: normalized.windowStartsAt, windowExpiresAt: normalized.windowExpiresAt,
      allowedUserIds: Array.from(normalized.allowedUserIds), synthetic: normalized.synthetic,
      sourceVersion: normalized.sourceVersion
    })))
  };
  const projects = {
    registration: buildProjectFiles(ctx, 'registration'),
    closed: buildProjectFiles(ctx, 'closed')
  };
  assertProjectSemantics(projects.registration, 'registration');
  assertProjectSemantics(projects.closed, 'closed');
  const closure = scanDependencyClosure(projects.registration);
  const delta = computeDelta(projects);

  const expected = new Map();
  expected.set('manifest.json', null); // 最后写，内容依赖既有 generatedAt
  for (const [root, files] of [[REGISTRATION_ROOT, projects.registration], [CLOSED_ROOT, projects.closed]]) {
    for (const [rel, buf] of files) expected.set(`${root}/${rel}`, buf);
  }
  const manifestAt = at => buildManifest(ctx, normalized, projects, closure, delta, at, kind);
  return { kind, normalized, ctx, projects, closure, delta, expected, manifestAt };
}

function verifyExisting(existing, bundle, complete) {
  for (const [rel, buf] of existing) {
    if (rel === 'manifest.json') continue;
    const want = bundle.expected.get(rel);
    if (!want || !buf.equals(want)) fail(ERR.CONFLICT, `${rel} 已存在且字节不符，拒绝覆盖。`);
  }
  if (complete) {
    for (const rel of bundle.expected.keys()) {
      if (rel === 'manifest.json') continue;
      if (!existing.has(rel)) fail(ERR.INCOMPLETE, `已带 manifest 但缺文件，拒绝补写：${rel}`);
    }
  }
}

/**
 * 清单校验：按**本次调用的模式**校验，不接受磁盘 manifest 自报模式。
 * 合成模式只认 /1；真实候选只认 /2。模式/schema/计划不一致一律拒绝。
 */
function validateManifest(existing, bundle) {
  let m;
  try { m = JSON.parse(existing.get('manifest.json').toString('utf8')); }
  catch (_) { fail(ERR.MANIFEST_INVALID, 'manifest 不是合法 JSON。'); }
  if (!isPlainObject(m)) fail(ERR.MANIFEST_INVALID, 'manifest 必须是对象。');
  if (typeof m.generatedAt !== 'string' || !Number.isFinite(Date.parse(m.generatedAt))
    || new Date(Date.parse(m.generatedAt)).toISOString() !== m.generatedAt) {
    fail(ERR.MANIFEST_INVALID, '生成时间无效。');
  }
  if (m.deploymentAuthorized !== false || m.cloudExecuted !== false || m.uploaded !== false
    || m.previewed !== false || m.networkAttempts !== 0) {
    fail(ERR.MANIFEST_INVALID, '清单的未部署标记被改动。');
  }
  // 模式与 schema 必须与本次调用一致：候选与合成不能互相认领同一目录
  const isReal = bundle.kind === 'real-candidate';
  const expectedSchema = isReal ? ASSEMBLY_MANIFEST_SCHEMA_REAL : ASSEMBLY_MANIFEST_SCHEMA;
  if (m.schema !== expectedSchema) {
    fail(ERR.ARTIFACT_KIND_CONFLICT,
      `清单 schema 为 ${m.schema}，与本次 ${bundle.kind} 模式要求的 ${expectedSchema} 不符。`);
  }
  const declaredKind = isReal ? 'real-candidate' : 'synthetic';
  if (m.artifactKind !== declaredKind) {
    fail(ERR.ARTIFACT_KIND_CONFLICT,
      `清单 artifactKind 为 ${m.artifactKind}，与本次 ${bundle.kind} 模式不符。`);
  }
  if (m.synthetic !== (isReal ? false : true)) {
    fail(ERR.MANIFEST_INVALID, '清单的合成标记与模式不符。');
  }
  if (canonical(m) !== canonical(bundle.manifestAt(m.generatedAt))) {
    fail(ERR.MANIFEST_MISMATCH, 'manifest 完整契约不符（改轮次/目标/窗口/合成标记等均拒绝）。');
  }
  verifyExisting(existing, bundle, true);
  return m;
}

// ── 对外 API ────────────────────────────────────────────────────────────────
/**
 * 本地检查：零写入、零云调用、零网络。从受审来源与完整输入重算内容。
 *
 * 时钟口径：
 *  - 合成：沿用 manifest.generatedAt（仅用于可复验的历史合成包），可被显式覆盖；
 *  - 真实候选：**必须**用当前时钟，且**必须**由调用方提供外部完整 plan
 *    （不只取 manifest.plan 自证）。生成后回拨 generatedAt 不能救活过期包。
 */
function checkAssembly(options = {}) {
  const netState = options.networkGuard === undefined ? null : options.networkGuard;
  const kind = (() => {
    try { return normalizeArtifactKind(options.artifactKind); }
    catch (error) {
      return {
        ok: false, mode: 'check', wroteFiles: false, cloudCalled: false,
        networkAttempts: netState ? netState.attempts.length : 0,
        problems: [{ code: error.code || ERR.FAILED, detail: String(error.detail || error.message).slice(0, 220) }]
      };
    }
  })();
  if (typeof kind === 'object') return kind;
  const isReal = kind === 'real-candidate';
  let dir;
  try {
    const inputDir = resolveInputDir(options.inputDir);
    dir = checkedTarget(options.outDir);
    assertNoOverlap(dir, inputDir);
    const existing = inspectTree(dir, ASSEMBLY_FILES);
    if (!existing.has('manifest.json')) fail(ERR.MANIFEST_INVALID, '缺 manifest。');
    let m;
    try { m = JSON.parse(existing.get('manifest.json').toString('utf8')); }
    catch (_) { fail(ERR.MANIFEST_INVALID, 'manifest 不是合法 JSON。'); }
    // 候选检查必须提供外部完整计划；不能由磁盘 manifest 自报模式或计划开启
    let plan = options.plan || null;
    if (isReal && !isPlainObject(plan)) {
      fail(ERR.PLAN_REQUIRED_FOR_REAL, '真实候选检查必须由调用方提供外部完整 plan，不接受仅凭 manifest.plan 自证。');
    }
    if (!plan) plan = isPlainObject(m.plan) ? { ...m.plan } : null;
    if (!plan) fail(ERR.MANIFEST_INVALID, '无法确定完整计划。');

    // 时钟：候选用当前时钟；合成沿用生成时刻以保持历史可复验
    const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
    const checkNowMs = isReal ? nowMs
      : (options.nowMs === undefined ? Date.parse(m.generatedAt) : options.nowMs);

    const bundle = computeExpected(plan, inputDir, { nowMs: checkNowMs, artifactKind: kind });
    // 第一次复核：来源检查与整树预检之后
    if (isReal) assertCandidateNotExpired(bundle.normalized, nowMs, '检查（预检后）');
    validateManifest(existing, bundle);
    // 返回成功前再复核一次
    if (isReal) assertCandidateNotExpired(bundle.normalized, nowMs, '检查（返回前）');
    return {
      ok: true, mode: 'check', dir, inputDir, artifactKind: kind,
      schema: bundle.kind === 'real-candidate' ? ASSEMBLY_MANIFEST_SCHEMA_REAL : ASSEMBLY_MANIFEST_SCHEMA,
      checkedAt: new Date(nowMs).toISOString(),
      projects: {
        registration: { files: bundle.projects.registration.size, root: REGISTRATION_ROOT },
        closed: { files: bundle.projects.closed.size, root: CLOSED_ROOT }
      },
      projectDelta: bundle.delta.map(d => d.rel),
      dependencyClosure: bundle.closure,
      problems: [], wroteFiles: false, cloudCalled: false,
      networkAttempts: netState ? netState.attempts.length : 0
    };
  } catch (error) {
    return {
      ok: false, mode: 'check', dir, artifactKind: kind, wroteFiles: false, cloudCalled: false,
      networkAttempts: netState ? netState.attempts.length : 0,
      problems: [{ code: error.code || ERR.FAILED, detail: String(error.detail || error.message).slice(0, 220) }]
    };
  }
}

/**
 * 本地组装：全部可预知失败发生在任何写入之前。
 *
 * 真实候选的时效复核共三次：
 *  1. 来源检查与整树预检之后、**第一次写输出之前**；
 *  2. 写入完成之后（此时过期则保留已写产物，如实报告，不删目录、不伪称零写）；
 *  3. 返回成功之前。
 */
function buildAssembly(options = {}) {
  const now = options.nowMs === undefined ? Date.now() : options.nowMs;
  const netState = options.networkGuard === undefined ? null : options.networkGuard;
  let kind;
  try { kind = normalizeArtifactKind(options.artifactKind); }
  catch (error) {
    return {
      ok: false, mode: 'build', wroteFiles: false, cloudCalled: false,
      networkAttempts: netState ? netState.attempts.length : 0,
      problems: [{ code: error.code || ERR.FAILED, detail: String(error.detail || error.message).slice(0, 220) }]
    };
  }
  const isReal = kind === 'real-candidate';
  let dir;
  try {
    const inputDir = resolveInputDir(options.inputDir);
    if (isReal && !isPlainObject(options.plan)) {
      fail(ERR.PLAN_REQUIRED_FOR_REAL, '真实候选组装必须由调用方提供外部完整 plan。');
    }
    // 输出编号必须**唯一**：同一轮次重复组装不应命中历史目录。
    // 轮次只作为可读前缀，真正区分靠调用方显式 outId 或随机后缀。
    const id = (options.outId === undefined || options.outId === null)
      ? uniqueOutId(options.plan && options.plan.roundId)
      : options.outId;
    dir = resolveOutDir(id);
    assertNoOverlap(dir, inputDir);
    const bundle = computeExpected(options.plan, inputDir, { nowMs: now, artifactKind: kind });
    const existing = inspectTree(dir, ASSEMBLY_FILES);
    // 第一次复核：预检后、写入前
    if (isReal) assertCandidateNotExpired(bundle.normalized, now, '组装（写入前）');

    if (existing.has('manifest.json')) {
      let m;
      try { m = validateManifest(existing, bundle); }
      catch (error) { fail(ERR.CONFLICT, '完整计划或字节不符，拒绝覆盖：' + error.message); }
      if (isReal) assertCandidateNotExpired(bundle.normalized, now, '复用（返回前）');
      return {
        ok: true, mode: 'build', dir, inputDir, reused: true, manifest: m, artifactKind: kind,
        projectDelta: bundle.delta.map(d => d.rel), dependencyClosure: bundle.closure,
        problems: [], wroteFiles: false, cloudCalled: false,
        networkAttempts: netState ? netState.attempts.length : 0
      };
    }

    // 无 manifest 的合法半成品：只补缺项
    verifyExisting(existing, bundle, false);
    if (isReal) assertCandidateNotExpired(bundle.normalized, now, '续建（写入前）');

    const written = [];
    const missing = new Map();
    for (const [rel, buf] of bundle.expected) {
      if (rel === 'manifest.json') continue;
      if (!existing.has(rel)) missing.set(rel, buf);
    }
    try {
      for (const [rel, buf] of missing) {
        const abs = base.resolveInside(dir, rel, '组装写点', { allowMissingBase: true });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        base.resolveInside(dir, rel, '组装写点');
        fs.writeFileSync(abs, buf, { flag: 'wx' });
        written.push(rel);
      }
      const manifestBuf = jsonBytes(bundle.manifestAt(new Date(now).toISOString()));
      const abs = base.resolveInside(dir, 'manifest.json', '组装清单', { allowMissingBase: true });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      base.resolveInside(dir, 'manifest.json', '组装清单');
      fs.writeFileSync(abs, manifestBuf, { flag: 'wx' });
      written.push('manifest.json');
    } catch (error) {
      return {
        ok: false, mode: 'build', dir, inputDir, incomplete: true, written, artifactKind: kind,
        problems: [{ code: ERR.WRITE_FAILED, detail: '写入期 I/O 失败，半成品保留供审查，未递归清理。' }],
        wroteFiles: written.length > 0, cloudCalled: false,
        networkAttempts: netState ? netState.attempts.length : 0
      };
    }

    // 第二次复核：写入后若已过期，保留产物并如实报告，不删目录、不伪称零写
    if (isReal) {
      try {
        assertCandidateNotExpired(bundle.normalized, now, '组装（写后）');
      } catch (error) {
        return {
          ok: false, mode: 'build', dir, inputDir, artifactKind: kind, expiredAfterWrite: true,
          written, wroteFiles: true, cloudCalled: false,
          networkAttempts: netState ? netState.attempts.length : 0,
          problems: [{
            code: error.code || ERR.WINDOW_EXPIRED,
            detail: String(error.detail || error.message).slice(0, 220)
              + ' 产物已写入并保留（未删除、未清理），不可作为当前有效登记候选。'
          }]
        };
      }
    }

    return {
      ok: true, mode: 'build', dir, inputDir, reused: false, artifactKind: kind,
      manifest: bundle.manifestAt(new Date(now).toISOString()),
      written, reusedFiles: Array.from(existing.keys()).sort(),
      projectDelta: bundle.delta.map(d => d.rel), dependencyClosure: bundle.closure,
      problems: [], wroteFiles: true, cloudCalled: false,
      networkAttempts: netState ? netState.attempts.length : 0
    };
  } catch (error) {
    return {
      ok: false, mode: 'build', dir, wroteFiles: false, cloudCalled: false,
      networkAttempts: netState ? netState.attempts.length : 0,
      problems: [{ code: error.code || ERR.FAILED, detail: String(error.detail || error.message).slice(0, 260) }]
    };
  }
}

// ── CLI（无 shell 拼接、无 deploy/execute/login/upload/preview） ────────────
/**
 * 参数解析。默认 synthetic；候选必须显式 `--artifact-kind real-candidate` 且带 `--plan`。
 * 不提供 --force / 跳过检查 / 改目标 / 时钟覆盖等绕过开关。
 */
function parseArgs(argv) {
  const out = {
    mode: 'check', planPath: null, input: null, target: null, outId: null,
    artifactKind: DEFAULT_ARTIFACT_KIND, artifactKindSeen: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.mode = 'check';
    else if (a === '--mode') { out.mode = argv[i + 1]; i++; }
    else if (a === '--plan') { out.planPath = argv[i + 1]; i++; }
    else if (a === '--input') { out.input = argv[i + 1]; i++; }
    else if (a === '--target') { out.target = argv[i + 1]; i++; }
    else if (a === '--out-id') { out.outId = argv[i + 1]; i++; }
    else if (a === '--artifact-kind') {
      // 重复、缺值与未知取值一律在写入前拒绝；不接受相互矛盾或隐式开启
      if (out.artifactKindSeen) fail(ERR.ARTIFACT_KIND_DUPLICATE, '--artifact-kind 不得重复指定。');
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        fail(ERR.ARTIFACT_KIND_MISSING_VALUE, '--artifact-kind 必须紧跟取值。');
      }
      out.artifactKind = value;
      out.artifactKindSeen = true;
      i++;
    }
    else fail(ERR.PLAN_MISSING, '未知参数：' + a);
  }
  if (out.mode !== 'check' && out.mode !== 'build') fail(ERR.PLAN_MISSING, 'mode 仅允许 check 或 build。');
  // 显式校验模式取值；默认 synthetic，候选必须显式选择
  out.artifactKind = normalizeArtifactKind(out.artifactKind);
  if (out.artifactKind === 'real-candidate' && !out.planPath) {
    // 候选 check/build 都必须提供外部完整计划，不允许只靠 manifest 自证
    fail(ERR.PLAN_REQUIRED_FOR_REAL, 'real-candidate 模式必须提供 --plan <plan.json>。');
  }
  for (const a of argv) {
    if (/^--(deploy|execute|login|upload|preview|install|init|force|skip-verify|override-clock|set-time)$/.test(a)) {
      fail(ERR.PLAN_MISSING, '本工具不含部署/执行/登录/上传/预览/安装/初始化或跳过检查/时钟覆盖操作。');
    }
  }
  return out;
}

function main(argv) {
  const netState = installNetworkGuard({});
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    restoreNetworkGuard(netState);
    process.stdout.write(JSON.stringify({
      ok: false, mode: 'check', wroteFiles: false, cloudCalled: false,
      networkAttempts: netState.attempts.length,
      problems: [{ code: error.code || ERR.PLAN_MISSING, detail: String(error.detail || error.message) }]
    }, null, 2) + '\n');
    return 1;
  }
  let plan;
  if (args.planPath) {
    try {
      plan = JSON.parse(fs.readFileSync(path.resolve(args.planPath), 'utf8'));
    } catch (_) {
      restoreNetworkGuard(netState);
      process.stdout.write(JSON.stringify({
        ok: false, mode: args.mode, wroteFiles: false, cloudCalled: false,
        networkAttempts: netState.attempts.length,
        problems: [{ code: ERR.PLAN_MISSING, detail: '计划文件不可读或不是合法 JSON' }]
      }, null, 2) + '\n');
      return 1;
    }
  }
  let result;
  if (args.mode === 'check') {
    result = checkAssembly({
      inputDir: args.input, outDir: args.target, plan,
      artifactKind: args.artifactKind, networkGuard: netState
    });
  } else {
    if (!plan) {
      restoreNetworkGuard(netState);
      process.stdout.write(JSON.stringify({
        ok: false, mode: 'build', wroteFiles: false, cloudCalled: false,
        networkAttempts: netState.attempts.length,
        problems: [{ code: ERR.PLAN_MISSING, detail: 'build 模式必须提供 --plan <plan.json>' }]
      }, null, 2) + '\n');
      return 1;
    }
    // 候选分支使用当前时钟（Date.now()），不开放 CLI 时钟覆盖
    result = buildAssembly({
      inputDir: args.input, outDir: null, outId: args.outId, plan,
      artifactKind: args.artifactKind, nowMs: Date.now(), networkGuard: netState
    });
  }
  restoreNetworkGuard(netState);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.ok ? 0 : 1;
}

module.exports = Object.freeze({
  ROOT, SOURCE_DIR, ARTIFACTS_ROOT, MINIPROGRAM_SRC, PACKAGE_FILES, FRONTEND_FILES,
  REVIEWED_SOURCE_VERSION, CLOSED_DIR, ASSEMBLY_MANIFEST_SCHEMA, ASSEMBLY_MANIFEST_SCHEMA_REAL,
  ARTIFACT_KINDS, DEFAULT_ARTIFACT_KIND, VERIFICATION_KIND, OUT_DIR_PREFIX,
  CLOUD_FUNCTION_NAME, ONLY_PAGE, SOURCE_PAGES, FIXED_APP_ID, FIXED_COMPILE_TYPE,
  FIXED_MINIPROGRAM_ROOT, FIXED_CLOUDFUNCTION_ROOT, PROJECT_SETTING_KEYS, PINNED_APP_FILES,
  PROJECT_FRONTEND_FILES, PROJECT_CLOUD_FILES, PROJECT_FILES, ASSEMBLY_FILES,
  REGISTRATION_ROOT, CLOSED_ROOT, ERR, AssemblyError,
  installNetworkGuard, restoreNetworkGuard, readPinnedSource, buildAppJson, buildProjectConfig,
  scanDependencyClosure, inspectTree, resolveOutDir, checkedTarget, assertNoOverlap,
  resolveInputDir, readRegistrationInput, readClosedInput, normalizeAssemblyPlan,
  normalizeArtifactKind, assertCandidateNotExpired,
  buildProjectFiles, assertProjectSemantics, computeDelta, computeExpected, validateManifest,
  buildManifest, checkAssembly, buildAssembly, parseArgs, main, canonical, sha256Buffer, safeOutId, uniqueOutId
});

if (require.main === module) process.exit(main(process.argv.slice(2)));
