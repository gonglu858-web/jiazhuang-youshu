'use strict';
// 指定本人登记打包器（participant-self-registration-plan/1；独立于只读核验打包器）。
//
// 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §2/§3/§6。
// 结构沿用已审查的只读打包器（排他写/部分写事实/来源钉定/关闭映射/prepare 分离），不修改旧文件。
// - 本轮仅支持 synthetic:true 计划（合成夹具账号，显式标注）；synthetic:false 一律拒绝
//   （真实登记包需要已核准私密来源与执行批准，未放行）。
// - 完整允许账号只进入服务端入口配置（CONFIG_ALLOWED_ACCOUNT 锚点）与关闭映射的服务端文件，
//   不进入前端/公开计划/manifest 清单/previewBuildId 输入；manifest 记录该披露边界。
// - registrationBuildId 与只读包 previewBuildId 同法：固定排序规范 JSON 的 SHA-256，
//   输入不含口令摘要/账号/synthetic 账号/私密引用/绝对路径/时间/随机数。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_DIR = path.join(ROOT, 'miniapp', 'scripts', 'templates', 'participant-self-registration');
const LIB_PATH = path.join(ROOT, 'miniapp', 'scripts', 'lib', 'participant-self-registration.cjs');
const BUSINESS_TOOL_PATH = path.join(ROOT, 'miniapp', 'scripts', 'package-business-test.cjs');
const OUT_ROOT = path.join(ROOT, 'artifacts', 'schedule-sandbox', 'business-test');
const OUT_PREFIX = 'participant-self-registration-';

const PLAN_SCHEMA = 'participant-self-registration-plan/1';
const MANIFEST_SCHEMA = 'participant-self-registration-manifest/1';
const REQUEST_PROTOCOL = 'participant-self-registration-request/1';
const PREVIEW_EVIDENCE_SCHEMA = 'participant-self-registration-preview-evidence/1';
const PRIVATE_SOURCE_SCHEMA = 'participant-self-registration-private-source/1';
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const ACCOUNT_RE = /^u_[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_WINDOW_MS = 30 * 60 * 1000;
const RECOMMENDED_WINDOW_MS = 15 * 60 * 1000;

const FIXED_TARGET = Object.freeze({
  appId: 'wxfb4db1615ac15531',
  envId: 'cloud1-d8gcq5ag39d847723',
  functionName: 'scheduleSandbox',
  usersCollection: 'schtest_v1_users',
  auditCollection: 'schtest_v1_audit_events'
});

const PLAN_FIELDS = Object.freeze([
  'schema', 'synthetic', 'registrationRoundId', 'participantCode',
  'appId', 'envId', 'functionName', 'usersCollection', 'auditCollection',
  'passphraseDigest', 'windowStartsAtIso', 'windowExpiresAtIso',
  'closeSourceDir', 'requestProtocol', 'note', 'syntheticAccount', 'privateSource'
]);
// R4：真实计划必须携带私密来源引用（固定私密根内的记录文件名；绑定核验在消费时进行）。
// PRIVATE_SOURCE_SCHEMA 常量沿用文件头既有声明。
const PARTICIPANT_CODE_RE = /^[12]$/;

const SERVER_FN_DIR = 'scheduleSandbox';
const SERVER_FN_ROOT = 'server/' + SERVER_FN_DIR + '/';
// 服务端模板（受审来源）：入口/依赖清单位于同名函数子目录（锚点注入/逐字节复制）；
// 适配器在 server/ 根；核心模块由 lib/participant-self-registration.cjs 逐字节复制。
const SERVER_TEMPLATE_FILES = Object.freeze(['scheduleSandbox/index.js', 'scheduleSandbox/package.json', 'request-adapter.js']);
const FRONTEND_TEMPLATE_FILES = Object.freeze([
  'app.js', 'app.json', 'app.wxss', 'sitemap.json',
  'config/cloud.js',
  'utils/registration-check-client.js',
  'pages/self-registration/self-registration.js',
  'pages/self-registration/self-registration.json',
  'pages/self-registration/self-registration.wxml',
  'pages/self-registration/self-registration.wxss'
]);

function adaptCloseRel(sourceRel) {
  return sourceRel.startsWith('server/')
    ? SERVER_FN_ROOT + sourceRel.slice('server/'.length)
    : sourceRel;
}
const CLOSE_MAPPING_DECLARATION =
  'close/server/** -> close/server/scheduleSandbox/**（其余 close/<rel> 逐字节保留）';
const PINNED_WX_SERVER_SDK_VERSION = '3.0.1';

/** 受审内容基线（本包自己的模板/核心；新增来源进入本表，不改旧包哈希）。 */
const PINNED_SOURCES = Object.freeze({
  'miniapp/scripts/lib/participant-self-registration.cjs': '74c006b0238ac5f482c069b40d027b643ff74cdddcf0cd4f8351327226a7c5df',
  'miniapp/scripts/templates/participant-self-registration/project.config.json': '945df870609a93d410a729d218df2a0844185d3c0c631a9f99833494449327be',
  'miniapp/scripts/templates/participant-self-registration/server/scheduleSandbox/index.js': '0bed614862e15331c7723ceb30fc4e2606491a6a66c3ee00d696ea937d3e721e',
  'miniapp/scripts/templates/participant-self-registration/server/scheduleSandbox/package.json': 'f401be55ff4d656d5c86afb59e5f97c8714c6ca2f945293b7fc5984718297d21',
  'miniapp/scripts/templates/participant-self-registration/server/request-adapter.js': 'c256ee48b32547a0b12e02e3d75ae83235aa6a1328e1be0c48a10dfd7ee83ed5',
  'miniapp/scripts/templates/participant-self-registration/frontend/app.js': 'ae4099b3b67d7ab00ec8ed432aa5482495009e1676cda7403c4525a55ec33e41',
  'miniapp/scripts/templates/participant-self-registration/frontend/app.json': 'b8d8b0b5af3c62823de725414dfa118003ecfcc6ac9b7576b4330e29b37b3db7',
  'miniapp/scripts/templates/participant-self-registration/frontend/app.wxss': '7d4d5c3cf7e912f9abfec626c98c564d139a588672787841558b58a4101d3d57',
  'miniapp/scripts/templates/participant-self-registration/frontend/sitemap.json': '83cd820fc77c8de3d105964e57c3aa2c555f2bbc44b9dc696967960a92b781d8',
  'miniapp/scripts/templates/participant-self-registration/frontend/config/cloud.js': 'c14e345205c440fadd3e093ae65057839386dc9bde095bb8f7ff901c3efe9a18',
  'miniapp/scripts/templates/participant-self-registration/frontend/utils/registration-check-client.js': 'e780071d79a47ad1319acfde9cbbca13eedc87cd89e12b75abec7a51608426dc',
  'miniapp/scripts/templates/participant-self-registration/frontend/pages/self-registration/self-registration.js': '85cba98a37db317ed781e36fc2feb663b99ff777e10b8ba71ef8b30b05779f1a',
  'miniapp/scripts/templates/participant-self-registration/frontend/pages/self-registration/self-registration.json': '13b2546519a1e4365ebe3d476a90282454f814909541ab9d1bb647004afdef96',
  'miniapp/scripts/templates/participant-self-registration/frontend/pages/self-registration/self-registration.wxml': '93e4f459e51c1d3a342c23c2bdc1855bde3706953a2229781a5ef3e8d23e1787',
  'miniapp/scripts/templates/participant-self-registration/frontend/pages/self-registration/self-registration.wxss': 'fcd42ebfa5012d155f8ae0f4c4c0d5472df425ca3eaa311b0907fc78b001d999'
});

const ERR = Object.freeze({
  PLAN_INVALID: 'PSR_PLAN_INVALID',
  PLAN_WINDOW_INVALID: 'PSR_PLAN_WINDOW_INVALID',
  PLAN_PASSPHRASE_INVALID: 'PSR_PLAN_PASSPHRASE_INVALID',
  PLAN_TARGET_INVALID: 'PSR_PLAN_TARGET_INVALID',
  PLAN_ACCOUNT_INVALID: 'PSR_PLAN_ACCOUNT_INVALID',
  REAL_NOT_PERMITTED: 'PSR_REAL_NOT_PERMITTED',
  REAL_NOT_PERMITTED: 'PSR_REAL_NOT_PERMITTED',
  SOURCE_MISSING: 'PSR_SOURCE_MISSING',
  SOURCE_DRIFT: 'PSR_SOURCE_DRIFT',
  TRANSFORM_ANCHOR_MISSING: 'PSR_TRANSFORM_ANCHOR_MISSING',
  TRANSFORM_ANCHOR_AMBIGUOUS: 'PSR_TRANSFORM_ANCHOR_AMBIGUOUS',
  OUT_CONFLICT: 'PSR_OUT_CONFLICT',
  MANIFEST_INVALID: 'PSR_MANIFEST_INVALID',
  CLOSE_SOURCE_INVALID: 'PSR_CLOSE_SOURCE_INVALID',
  WINDOW_EXPIRED: 'PSR_WINDOW_EXPIRED',
  WINDOW_NOT_OPEN: 'PSR_WINDOW_NOT_OPEN',
  CLOCK_INVALID: 'PSR_CLOCK_INVALID',
  CLOCK_ERROR: 'PSR_CLOCK_ERROR'
});

class RegistrationPackageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new RegistrationPackageError(code, message); };

const sha256Buffer = b => crypto.createHash('sha256').update(b).digest('hex');
const relOf = p => p.split(path.sep).join('/');

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
    try { st = fs.lstatSync(p); } catch (_) { continue; }
    if (st.isSymbolicLink()) fail(ERR.OUT_CONFLICT, label + ' 路径含符号链接/junction：' + p);
    if (!st.isDirectory()) fail(ERR.OUT_CONFLICT, label + ' 路径存在非目录占位，不覆盖：' + p);
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
      out.set(rel, { abs, isSymlink: Boolean(st && st.isSymbolicLink()), isDir: Boolean(st && st.isDirectory() && !st.isSymbolicLink()), isFile: Boolean(st && st.isFile()) });
      if (st && st.isDirectory() && !st.isSymbolicLink()) walk(abs, rel);
    }
  };
  walk(dir, '');
  return out;
}

function isExpectedPrefix(rel, expectedKeys) {
  return expectedKeys.some(k => k.startsWith(rel + '/'));
}

function precheckOutDir(outDir, expected) {
  if (!fs.existsSync(outDir)) return [];
  assertRealDirChain(outDir, '输出目录');
  const existing = listExisting(outDir);
  const reused = [];
  for (const [rel, info] of existing) {
    if (info.isSymlink) fail(ERR.OUT_CONFLICT, '输出目录含符号链接/junction：' + rel);
    if (info.isDir) {
      if (!isExpectedPrefix(rel, [...expected.keys()])) fail(ERR.OUT_CONFLICT, '输出目录含多余目录：' + rel);
      continue;
    }
    const buf = expected.get(rel);
    if (!buf) fail(ERR.OUT_CONFLICT, '输出目录含多余文件：' + rel);
    if (!info.isFile) fail(ERR.OUT_CONFLICT, '输出目录含非普通文件：' + rel);
    let current = null;
    try { current = fs.readFileSync(info.abs); } catch (_) { current = null; }
    if (!current || !current.equals(buf)) fail(ERR.OUT_CONFLICT, '已存在内容不同的文件，不覆盖：' + rel);
    reused.push({ path: info.abs, rel, action: 'reused' });
  }
  return reused;
}

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

function assertPinnedSource(absPath, buf, label) {
  const key = relOf(path.relative(ROOT, path.resolve(absPath))).split(path.sep).join('/');
  const pinned = Object.prototype.hasOwnProperty.call(PINNED_SOURCES, key) ? PINNED_SOURCES[key] : undefined;
  if (typeof pinned !== 'string' || !SHA256_RE.test(pinned)) {
    fail(ERR.SOURCE_DRIFT, '受审基线缺失或格式无效（须先受审更新）：' + label);
  }
  const actual = sha256Buffer(buf);
  if (actual !== pinned) {
    fail(ERR.SOURCE_DRIFT, '受审来源漂移，拒绝装配/重建（基线 ' + pinned + ' ≠ 实际 ' + actual + '）：' + label);
  }
}

function readTemplateBytes(rel) {
  const abs = path.join(TEMPLATE_DIR, rel);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (_) { st = null; }
  if (!st || !st.isFile() || st.isSymbolicLink()) fail(ERR.SOURCE_MISSING, '受审模板缺失或非普通文件：' + relOf(path.relative(ROOT, abs)));
  const buf = fs.readFileSync(abs);
  assertPinnedSource(abs, buf, '模板 ' + rel);
  return buf;
}

function readCoreModuleBytes() {
  let st = null;
  try { st = fs.lstatSync(LIB_PATH); } catch (_) { st = null; }
  if (!st || !st.isFile() || st.isSymbolicLink()) fail(ERR.SOURCE_MISSING, '登记核心模块缺失或非普通文件。');
  const buf = fs.readFileSync(LIB_PATH);
  assertPinnedSource(LIB_PATH, buf, '登记核心模块');
  const text = buf.toString('utf8');
  for (const marker of [
    "const SELF_REG_SCHEMA = 'participant-self-registration/1';",
    "const AUDIT_ID_PREFIX = 'a_reg_';"
  ]) {
    if (!text.includes(marker)) fail(ERR.SOURCE_DRIFT, '登记核心缺少受审协议绑定（' + marker + '）。');
  }
  return buf;
}

function anchorReplace(buf, from, to, label) {
  const text = buf.toString('utf8');
  const hits = text.split(from).length - 1;
  if (hits === 0) fail(ERR.TRANSFORM_ANCHOR_MISSING, '装配锚点缺失：' + label);
  if (hits > 1) fail(ERR.TRANSFORM_ANCHOR_AMBIGUOUS, '装配锚点多处命中：' + label);
  return Buffer.from(text.split(from).join(to), 'utf8');
}

function planDigest(plan) {
  const canonical = JSON.stringify({
    schema: plan.schema, synthetic: plan.synthetic,
    registrationRoundId: plan.registrationRoundId, participantCode: plan.participantCode,
    appId: plan.appId, envId: plan.envId, functionName: plan.functionName,
    usersCollection: plan.usersCollection, auditCollection: plan.auditCollection,
    passphraseDigest: plan.passphraseDigest,
    windowStartsAtIso: plan.windowStartsAtIso, windowExpiresAtIso: plan.windowExpiresAtIso,
    closeSourceDir: plan.closeSourceDir, requestProtocol: plan.requestProtocol, note: plan.note || ''
  });
  return sha256Buffer(Buffer.from(canonical));
}

function readPlan(planPath) {
  if (typeof planPath !== 'string' || !planPath) fail(ERR.PLAN_INVALID, '缺少计划文件路径。');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(planPath, 'utf8')); } catch (error) {
    fail(ERR.PLAN_INVALID, '计划文件无法解析：' + error.message);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(ERR.PLAN_INVALID, '计划必须是 JSON 对象。');
  for (const k of Object.keys(raw)) {
    if (!PLAN_FIELDS.includes(k)) fail(ERR.PLAN_INVALID, '计划含未知字段：' + k);
  }
  if (raw.schema !== PLAN_SCHEMA) fail(ERR.PLAN_INVALID, '计划 schema 必须是 ' + PLAN_SCHEMA + '。');
  if (typeof raw.synthetic !== 'boolean') fail(ERR.PLAN_INVALID, '计划缺少 synthetic 布尔字段。');
  if (typeof raw.registrationRoundId !== 'string' || !ROUND_ID_RE.test(raw.registrationRoundId)) {
    fail(ERR.PLAN_INVALID, 'registrationRoundId 须为 4–64 位字母数字-_ 且不以符号开头。');
  }
  if (!PARTICIPANT_CODE_RE.test(String(raw.participantCode))) {
    fail(ERR.PLAN_INVALID, 'participantCode 只能是 1（管家）或 2（师傅）。');
  }
  for (const k of ['appId', 'envId', 'functionName', 'usersCollection', 'auditCollection']) {
    if (raw[k] !== FIXED_TARGET[k]) fail(ERR.PLAN_TARGET_INVALID, k + ' 必须是受审固定值。');
  }
  if (!SHA256_RE.test(raw.passphraseDigest || '')) {
    fail(ERR.PLAN_PASSPHRASE_INVALID, 'passphraseDigest 必须是 64 位十六进制 sha256（服务端只存摘要）。');
  }
  if (raw.requestProtocol !== REQUEST_PROTOCOL) {
    fail(ERR.PLAN_INVALID, 'requestProtocol 必须精确为 ' + REQUEST_PROTOCOL + '。');
  }
  const starts = Date.parse(raw.windowStartsAtIso);
  const expires = Date.parse(raw.windowExpiresAtIso);
  if (!Number.isFinite(starts) || !Number.isFinite(expires)) fail(ERR.PLAN_WINDOW_INVALID, '窗口起止时间无效。');
  if (!(expires > starts)) fail(ERR.PLAN_WINDOW_INVALID, '登记窗口截止时间必须晚于开始时间。');
  if (expires - starts > MAX_WINDOW_MS) fail(ERR.PLAN_WINDOW_INVALID, '登记窗口不得超过 30 分钟（工具上限）。');
  if (raw.synthetic && expires - starts > RECOMMENDED_WINDOW_MS) {
    fail(ERR.PLAN_WINDOW_INVALID, '合成夹具登记窗口不得超过建议的 15 分钟。');
  }
  if (typeof raw.closeSourceDir !== 'string' || !path.isAbsolute(raw.closeSourceDir)) {
    fail(ERR.PLAN_INVALID, 'closeSourceDir 必须是已受审关闭包目录的绝对路径。');
  }
  // 账号来源隔离（R4）：synthetic 计划必须用显式标注的合成夹具账号且不得携带私密引用；
  // 非合成计划（真实模式）必须携带格式合法的私密来源引用——解密与绑定核验在消费时进行，
  // 本轮仅合成来源用于本地全链验证，真实编号录入仍被禁止。
  let privateSource = null;
  if (raw.synthetic === false) {
    const ps = raw.privateSource;
    if (!ps || typeof ps !== 'object' || Array.isArray(ps)) {
      fail(ERR.REAL_NOT_PERMITTED, '真实登记计划必须携带 privateSource（私密来源引用）。');
    }
    for (const k of Object.keys(ps)) {
      if (!['schema', 'recordFile'].includes(k)) fail(ERR.PLAN_INVALID, 'privateSource 含未知字段：' + k);
    }
    if (ps.schema !== PRIVATE_SOURCE_SCHEMA) fail(ERR.PLAN_INVALID, 'privateSource.schema 必须是 ' + PRIVATE_SOURCE_SCHEMA + '。');
    if (typeof ps.recordFile !== 'string' || !/^[A-Za-z0-9._-]+\.bin$/.test(ps.recordFile)) {
      fail(ERR.PLAN_INVALID, 'privateSource.recordFile 必须是固定私密根内的 <名称>.bin。');
    }
    privateSource = Object.freeze({ schema: ps.schema, recordFile: ps.recordFile });
  }
  if (raw.synthetic === true) {
    if (typeof raw.syntheticAccount !== 'string' || !ACCOUNT_RE.test(raw.syntheticAccount)) {
      fail(ERR.PLAN_ACCOUNT_INVALID, '合成计划必须提供格式合法的 syntheticAccount（u_+40 位小写十六进制合成夹具）。');
    }
    if (raw.privateSource !== undefined) fail(ERR.PLAN_INVALID, '合成计划不得携带 privateSource。');
  }
  return Object.freeze({
    schema: raw.schema, synthetic: raw.synthetic,
    registrationRoundId: raw.registrationRoundId, participantCode: String(raw.participantCode),
    appId: raw.appId, envId: raw.envId, functionName: raw.functionName,
    usersCollection: raw.usersCollection, auditCollection: raw.auditCollection,
    passphraseDigest: raw.passphraseDigest,
    windowStartsAtMs: starts, windowExpiresAtMs: expires,
    windowStartsAtIso: raw.windowStartsAtIso, windowExpiresAtIso: raw.windowExpiresAtIso,
    closeSourceDir: path.resolve(raw.closeSourceDir),
    requestProtocol: raw.requestProtocol,
    note: raw.note || '',
    syntheticAccount: raw.synthetic === true ? raw.syntheticAccount : null,
    privateSource
  });
}

function windowClockCheck(plan, at, phase) {
  let nowMs;
  try { nowMs = Date.now(); } catch (error) { fail(ERR.CLOCK_ERROR, '服务端时钟异常[' + at + ']。'); }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) fail(ERR.CLOCK_INVALID, '服务端时钟无效[' + at + ']。');
  if (plan.synthetic) return;
  if (phase !== 'prepare' && nowMs < plan.windowStartsAtMs) fail(ERR.WINDOW_NOT_OPEN, '登记窗口尚未开始[' + at + ']。');
  if (nowMs >= plan.windowExpiresAtMs) fail(ERR.WINDOW_EXPIRED, '登记窗口已截止[' + at + ']。');
}

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
  const businessTool = require(BUSINESS_TOOL_PATH);
  const result = businessTool.checkCloseDir(abs);
  if (!result || result.ok !== true) {
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包来源未通过未改 package-business-test.checkCloseDir 校验：' +
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
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包来源文件数与独立核对结果不一致（' + files.length + ' ≠ ' + result.expectedFiles + '）。');
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function assertCloseMappingInvariants(expectedMap) {
  const serverKeys = [...expectedMap.keys()].filter(k => k.startsWith('server/'));
  if (serverKeys.length === 0) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包映射后 server/ 下没有任何制品。');
  for (const k of serverKeys) {
    if (!k.startsWith(SERVER_FN_ROOT)) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 server/ 根下出现无法映射到同名函数的制品：' + k);
  }
  for (const must of [SERVER_FN_ROOT + 'index.js', SERVER_FN_ROOT + 'package.json']) {
    if (!expectedMap.has(must)) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包同名函数子目录缺少制品：' + must);
  }
  const cfgBuf = expectedMap.get('project.config.json');
  if (!cfgBuf) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包缺少 project.config.json。');
  let cfg = null;
  try { cfg = JSON.parse(cfgBuf.toString('utf8')); } catch (error) {
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 project.config.json 不是合法 JSON：' + error.message);
  }
  if (cfg.cloudfunctionRoot !== 'server/') fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 project.config.json cloudfunctionRoot 必须为 server/。');
  const closePkgBuf = expectedMap.get(SERVER_FN_ROOT + 'package.json');
  if (!closePkgBuf) fail(ERR.CLOSE_SOURCE_INVALID, '关闭包缺少 ' + SERVER_FN_ROOT + 'package.json。');
  let closePkg = null;
  try { closePkg = JSON.parse(closePkgBuf.toString('utf8')); } catch (error) {
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 package.json 不是合法 JSON：' + error.message);
  }
  const closeSdk = closePkg.dependencies && closePkg.dependencies['wx-server-sdk'];
  if (closeSdk !== PINNED_WX_SERVER_SDK_VERSION) {
    fail(ERR.CLOSE_SOURCE_INVALID, '关闭包 wx-server-sdk 依赖必须精确为 ' + PINNED_WX_SERVER_SDK_VERSION + '，实际：' + closeSdk);
  }
}

/**
 * 登记包本机版本标识：固定排序规范 JSON 的 SHA-256。
 * 输入不含口令摘要/允许账号/synthetic 账号/私密引用/绝对路径/时间/随机数。
 */
function computeRegistrationBuildId(plan) {
  const frontendTemplates = FRONTEND_TEMPLATE_FILES.map(rel => ({
    rel: 'frontend/' + rel,
    sha256: sha256Buffer(readTemplateBytes('frontend/' + rel))
  }));
  const canonical = {
    previewEvidenceSchema: PREVIEW_EVIDENCE_SCHEMA,
    requestProtocol: REQUEST_PROTOCOL,
    registrationRoundId: plan.registrationRoundId,
    participantCode: plan.participantCode,
    appId: plan.appId, envId: plan.envId, functionName: plan.functionName,
    usersCollection: plan.usersCollection, auditCollection: plan.auditCollection,
    windowStartsAtIso: plan.windowStartsAtIso, windowExpiresAtIso: plan.windowExpiresAtIso,
    packerSourceSha256: sha256Buffer(fs.readFileSync(__filename)),
    frontendTemplates
  };
  return sha256Buffer(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

function computeArtifacts(plan, account) {
  const artifacts = new Map();
  const coreBytes = readCoreModuleBytes();
  artifacts.set(SERVER_FN_ROOT + 'participant-self-registration.js', coreBytes);
  for (const rel of SERVER_TEMPLATE_FILES) {
    const raw = readTemplateBytes('server/' + rel);
    const target = SERVER_FN_ROOT + rel.replace('scheduleSandbox/', '');
    if (rel !== 'scheduleSandbox/index.js') { artifacts.set(target, raw); continue; }
    // 装配即启用入口（CONFIG_ENABLED=true）：合成装配以 CONFIG_SYNTHETIC=true 标记；
    // 真实装配另由计划层的私密来源与执行批准门槛把关（synthetic:false 本轮未放行）。
    let buf = anchorReplace(raw, 'const CONFIG_ENABLED = false;', 'const CONFIG_ENABLED = true;', 'index.js#CONFIG_ENABLED');
    buf = anchorReplace(buf, "const CONFIG_APP_ID = '';", "const CONFIG_APP_ID = '" + plan.appId + "';", 'index.js#CONFIG_APP_ID');
    buf = anchorReplace(buf, "const CONFIG_ENV_ID = '';", "const CONFIG_ENV_ID = '" + plan.envId + "';", 'index.js#CONFIG_ENV_ID');
    buf = anchorReplace(buf, "const CONFIG_REGISTRATION_ROUND_ID = '';", "const CONFIG_REGISTRATION_ROUND_ID = '" + plan.registrationRoundId + "';", 'index.js#CONFIG_REGISTRATION_ROUND_ID');
    buf = anchorReplace(buf, "const CONFIG_PASSPHRASE_DIGEST = '';", "const CONFIG_PASSPHRASE_DIGEST = '" + plan.passphraseDigest + "';", 'index.js#CONFIG_PASSPHRASE_DIGEST');
    buf = anchorReplace(buf, 'const CONFIG_WINDOW_STARTS_AT_MS = 0;', 'const CONFIG_WINDOW_STARTS_AT_MS = ' + plan.windowStartsAtMs + ';', 'index.js#CONFIG_WINDOW_STARTS_AT_MS');
    buf = anchorReplace(buf, 'const CONFIG_WINDOW_EXPIRES_AT_MS = 0;', 'const CONFIG_WINDOW_EXPIRES_AT_MS = ' + plan.windowExpiresAtMs + ';', 'index.js#CONFIG_WINDOW_EXPIRES_AT_MS');
    // 完整允许账号仅进入服务端入口配置（真实装配由私密来源解密注入；合成装配用标注夹具）
    buf = anchorReplace(buf, "const CONFIG_ALLOWED_ACCOUNT = '';", "const CONFIG_ALLOWED_ACCOUNT = '" + account + "';", 'index.js#CONFIG_ALLOWED_ACCOUNT');
    buf = anchorReplace(buf, "const CONFIG_USERS_COLLECTION = 'schtest_v1_users';", "const CONFIG_USERS_COLLECTION = '" + plan.usersCollection + "';", 'index.js#CONFIG_USERS_COLLECTION');
    buf = anchorReplace(buf, "const CONFIG_AUDIT_COLLECTION = 'schtest_v1_audit_events';", "const CONFIG_AUDIT_COLLECTION = '" + plan.auditCollection + "';", 'index.js#CONFIG_AUDIT_COLLECTION');
    buf = anchorReplace(buf, 'const CONFIG_SYNTHETIC = false;', 'const CONFIG_SYNTHETIC = ' + Boolean(plan.synthetic) + ';', 'index.js#CONFIG_SYNTHETIC');
    artifacts.set(SERVER_FN_ROOT + 'index.js', buf);
  }
  for (const rel of FRONTEND_TEMPLATE_FILES) {
    const raw = readTemplateBytes('frontend/' + rel);
    if (rel !== 'config/cloud.js') { artifacts.set('frontend/' + rel, raw); continue; }
    const withRound = anchorReplace(raw, "  registrationRoundId: ''", "  registrationRoundId: '" + plan.registrationRoundId + "'", 'frontend/config/cloud.js#registrationRoundId');
    const withBuild = anchorReplace(withRound, "  registrationBuildId: ''", "  registrationBuildId: '" + computeRegistrationBuildId(plan) + "'", 'frontend/config/cloud.js#registrationBuildId');
    artifacts.set('frontend/' + rel, withBuild);
  }
  artifacts.set('project.config.json', readTemplateBytes('project.config.json'));
  return artifacts;
}

/**
 * build/prepare 共用装配主体（窗口模式由公开入口固定选择）。
 * opts.privateAccount：真实模式（synthetic:false）必须由 consumePrivateSource 解析后注入；
 * 合成模式使用计划内标注夹具账号。manifest 不含时间戳；prepare 与 build 同计划同源码逐字节一致。
 */
function buildInternal(planPath, outOverride, windowPhase, opts) {
  const options = opts || {};
  const plan = readPlan(planPath);
  windowClockCheck(plan, 'build.readPlan', windowPhase);
  let account = null;
  if (plan.synthetic === true) {
    account = plan.syntheticAccount;
  } else {
    // R4：真实装配必须携带经私密来源解析的账号（不接受计划自报）
    if (typeof options.privateAccount !== 'string' || !ACCOUNT_RE.test(options.privateAccount)) {
      fail(ERR.REAL_NOT_PERMITTED, '真实装配必须先经 consumePrivateSource 解析私密来源并提供 privateAccount。');
    }
    account = options.privateAccount;
  }
  const closeFiles = verifyCloseSource(plan.closeSourceDir);
  const artifacts = computeArtifacts(plan, account);
  const planBytes = fs.readFileSync(planPath);
  const digest = planDigest(plan);

  const outDir = outOverride ? path.resolve(outOverride)
    : path.join(OUT_ROOT, OUT_PREFIX + plan.registrationRoundId.toLowerCase() + '-' + digest.slice(0, 12));
  if (path.dirname(outDir) !== OUT_ROOT || !path.basename(outDir).startsWith(OUT_PREFIX)) {
    fail(ERR.OUT_CONFLICT, '输出目录必须位于 ' + OUT_ROOT + ' 之下且以 ' + OUT_PREFIX + ' 为前缀。');
  }
  assertRealDirChain(outDir, 'build 输出');

  const entries = [];
  for (const [rel, buf] of artifacts) entries.push({ rel, bytes: buf.length, sha256: sha256Buffer(buf) });
  entries.push({ rel: 'plan.json', bytes: planBytes.length, sha256: sha256Buffer(planBytes) });

  const manifest = {
    schema: MANIFEST_SCHEMA,
    synthetic: plan.synthetic,
    registrationRoundId: plan.registrationRoundId,
    participantCode: plan.participantCode,
    appId: plan.appId, envId: plan.envId, functionName: plan.functionName,
    usersCollection: plan.usersCollection, auditCollection: plan.auditCollection,
    windowStartsAtIso: plan.windowStartsAtIso, windowExpiresAtIso: plan.windowExpiresAtIso,
    windowMinutes: Math.round((plan.windowExpiresAtMs - plan.windowStartsAtMs) / 60000),
    passphraseDigestRecorded: true,
    userIdentitySource: 'trusted-wx-context：APPID/OPENID 只来自 cloud.getWXContext，本地产物不含任何 OPENID 或凭据',
    requestProtocol: REQUEST_PROTOCOL,
    previewEvidenceSchema: PREVIEW_EVIDENCE_SCHEMA,
    registrationBuildId: computeRegistrationBuildId(plan),
    // 私密来源绑定（披露边界）：完整允许账号只进入服务端入口配置与远端代码，
    // 不进入前端/公开计划/manifest 清单/previewBuildId 输入。
    privateSource: {
      schema: PRIVATE_SOURCE_SCHEMA,
      mode: plan.synthetic ? 'synthetic-fixture' : 'real-private-source',
      syntheticFixtureLabel: plan.synthetic ? 'synthetic-fixture-not-real-number' : null,
      realSourceConsumed: false,
      disclosure: '真实装配时完整允许账号会写入服务端候选配置并随函数上传至远端代码；不承诺只在内存。'
    },
    planFile: 'plan.json',
    planSha256: sha256Buffer(planBytes),
    planDigest: digest,
    closeSourceDir: relOf(path.relative(ROOT, plan.closeSourceDir)),
    boundaries: [
      '候选不是登记执行批准；本轮未部署、未调用平台、未写库。',
      '服务端只含口令摘要与（真实装配时的）允许账号；明文口令/完整编号不进入前端、公开计划、manifest 清单、证据或 previewBuildId 输入。',
      '真实装配时完整允许账号会进入服务端候选源文件、上传 ZIP 与远端函数代码，并写入数据库登记记录；不承诺只在内存或远端不可见。',
      '本协议仅 registerSelf 单一动作；全部准入检查在数据库工厂之前；非名单账号零工厂零事务零写。',
      '用户与登记审计同事务原子新增（恰 2 条）；已有有效用户零新增；并发由确定性主键与事务保证至多一组新增。',
      '提交后超时/回读失败结果为 OUTCOME_UNKNOWN：不误报零写、不自动重试。',
      '合成夹具窗口跳过时效；真实窗口>15 分钟剩余才允许覆盖启动，不得更改系统时钟延长窗口。'
    ],
    files: entries,
    closePackage: {
      note: '配对关闭包：复制自已受审本地业务关闭包（先经未改 checkCloseDir 独立校验）；来源 server/** 已映射为本包 close/server/scheduleSandbox/**（同名函数目录），其余文件逐字节保留；关闭端无需口令、不依赖开启窗口时效。',
      sourceDir: relOf(path.relative(ROOT, plan.closeSourceDir)),
      mapping: CLOSE_MAPPING_DECLARATION,
      files: closeFiles.map(f => ({ rel: adaptCloseRel(f.rel), sourceRel: f.rel, bytes: f.buf.length, sha256: sha256Buffer(f.buf) }))
    }
  };

  const expected = new Map();
  for (const [rel, buf] of artifacts) expected.set(rel, buf);
  for (const f of closeFiles) expected.set('close/' + adaptCloseRel(f.rel), f.buf);
  expected.set('plan.json', planBytes);
  expected.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  assertCloseMappingInvariants(new Map([...expected].filter(([k]) => k.startsWith('close/')).map(([k, v]) => [k.slice('close/'.length), v])));

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
      result.phase = 'preparation';
      result.preparationValidated = true;
      result.executionReady = false;
    }
    return result;
  } catch (error) {
    const written = io.filter(x => x.action === 'written').map(x => path.relative(outDir, x.path).split(path.sep).join('/'));
    if (written.length) { error.written = written; error.wroteFiles = written.length; }
    const partials = io.filter(x => x.action === 'written' && x.partial);
    if (partials.length) {
      error.partialWrites = partials.map(x => ({ rel: path.relative(outDir, x.path).split(path.sep).join('/'), bytesOnDisk: x.bytesOnDisk }));
    }
    throw error;
  }
}

function build(planPath, outOverride, opts) { return buildInternal(planPath, outOverride, 'execute', opts); }
function prepare(planPath, outOverride, opts) { return buildInternal(planPath, outOverride, 'prepare', opts); }

/**
 * R4：受控来源→解密→绑定核验→账号解析（完整消费链；仅合成来源用于本轮本地验证）。
 * - 计划必须为 synthetic:false 且携带 privateSource；
 * - 枚举固定私密根全部记录并 1/2 排重；
 * - 逐项绑定核验：参与者代码/appId/envId/登记轮次/窗口起止/来源摘要（对 closeSourceDir
 *   重算）/交付确认；
 * - 返回 { account }（仅内存使用；不写日志/证据）。
 */
async function consumePrivateSource(planPath, { repoRoot } = {}) {
  const plan = readPlan(planPath);
  if (plan.synthetic !== false || !plan.privateSource) {
    fail(ERR.REAL_NOT_PERMITTED, 'consumePrivateSource 仅适用于真实模式计划（synthetic:false + privateSource）。');
  }
  const store = require('./lib/participant-private-store.cjs');
  const records = await store.readAllRecordsAsync({ repoRoot: repoRoot || ROOT });
  if (records.length === 0) fail(ERR.REAL_NOT_PERMITTED, '固定私密根内没有可消费的私密记录。');
  const target = records.find(r => r.fileName === plan.privateSource.recordFile);
  if (!target) fail(ERR.REAL_NOT_PERMITTED, '私密来源引用的记录文件不存在：' + plan.privateSource.recordFile);
  // R4：1/2 排重——先核验目标记录绑定，再对同码/同账号执行排重（历史残留不阻断当前核验）
  const p = target.payload;
  const bindingFailures = [];
  if (p.participantCode !== plan.participantCode) bindingFailures.push('参与者代码');
  if (p.appId !== plan.appId || p.envId !== plan.envId) bindingFailures.push('固定目标');
  if (p.roundId !== plan.registrationRoundId) bindingFailures.push('登记轮次');
  if (p.windowStartsAtIso !== plan.windowStartsAtIso || p.windowExpiresAtIso !== plan.windowExpiresAtIso) bindingFailures.push('窗口起止');
  if (p.sourceDigest !== store.computeCloseSourceDigest(plan.closeSourceDir)) bindingFailures.push('来源摘要');
  if (p.deliveryConfirmed !== true) bindingFailures.push('交付确认');
  if (bindingFailures.length) {
    fail(ERR.REAL_NOT_PERMITTED, '私密来源绑定核验未通过：' + bindingFailures.join('/'));
  }
  // R4：排重——仅对同来源（同 sourceDigest）的记录执行 1/2 排重
  const sameSource = records.filter(r => r.payload.sourceDigest === p.sourceDigest);
  const sameCode = sameSource.filter(r => r.payload.participantCode === p.participantCode);
  const codeAccounts = new Set(sameCode.map(r => r.payload.fullAccount));
  if (codeAccounts.size > 1) fail(ERR.REAL_NOT_PERMITTED, '同一参与者代码对应不同账号（跨记录排重）。');
  const crossCode = sameSource.find(r => r.payload.fullAccount === p.fullAccount && r.payload.participantCode !== p.participantCode);
  if (crossCode) fail(ERR.REAL_NOT_PERMITTED, '同一账号同时挂在多个参与者代码下。');
  return { account: p.fullAccount, recordRef: p.ref, participantCode: p.participantCode };
}

/**
 * check/检查已准备目录共用主体（与只读包同构；previewBuildId 换为 registrationBuildId，
 * 其来源依赖计算在受控重建出口内——漂移/缺失/读取异常返回结构化失败）。
 */
function checkDirInternal(dir, windowPhase, account) {
  assertRealDirChain(dir, 'check 输入');
  const problems = [];
  const bad = msg => problems.push(msg);
  let manifest = null;
  let manifestFiles = [];
  let manifestCloseFiles = [];
  let plan = null;
  let clockStopped = false;
  const clockCheck = at => {
    if (!plan || clockStopped) return;
    try { windowClockCheck(plan, at, windowPhase); } catch (error) {
      bad('窗口时效检查失败[' + (error.code || 'PSR_ERROR') + ']（' + at + '）：' + error.message);
      clockStopped = true;
    }
  };
  const manifestPath = path.join(dir, 'manifest.json');
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (error) {
    bad('manifest.json 无法读取：' + error.message);
    return finish();
  }
  manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  manifestCloseFiles = manifest.closePackage && Array.isArray(manifest.closePackage.files) ? manifest.closePackage.files : [];
  if (manifest.schema !== MANIFEST_SCHEMA) bad('manifest schema 不符。');
  // R5：manifest 顶层字段集严格重建（未知字段/缺失字段拒绝；不以自报值为准）
  {
    const MANIFEST_KEYS = ['schema', 'synthetic', 'registrationRoundId', 'participantCode', 'appId', 'envId',
      'functionName', 'usersCollection', 'auditCollection', 'windowStartsAtIso', 'windowExpiresAtIso',
      'windowMinutes', 'passphraseDigestRecorded', 'userIdentitySource', 'requestProtocol',
      'previewEvidenceSchema', 'registrationBuildId', 'privateSource', 'planFile', 'planSha256',
      'planDigest', 'closeSourceDir', 'boundaries', 'files', 'closePackage'];
    for (const k of Object.keys(manifest)) {
      if (!MANIFEST_KEYS.includes(k)) bad('manifest 含未知字段：' + k);
    }
    for (const k of MANIFEST_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(manifest, k)) bad('manifest 缺少字段：' + k);
    }
    // privateSource 字段集与合成/真实模式匹配
    const ps = manifest.privateSource;
    if (!ps || typeof ps !== 'object' || Array.isArray(ps)) {
      bad('manifest.privateSource 缺失');
    } else {
      const PS_KEYS = ['schema', 'mode', 'syntheticFixtureLabel', 'realSourceConsumed', 'disclosure'];
      for (const k of Object.keys(ps)) if (!PS_KEYS.includes(k)) bad('manifest.privateSource 含未知字段：' + k);
      for (const k of PS_KEYS) if (!Object.prototype.hasOwnProperty.call(ps, k)) bad('manifest.privateSource 缺少字段：' + k);
    }
    // closePackage 字段集与映射声明严格重建（R5：伪造 mapping/未知字段拒绝）
    const cp = manifest.closePackage;
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
      bad('manifest.closePackage 缺失');
    } else {
      const CP_KEYS = ['note', 'sourceDir', 'mapping', 'files'];
      for (const k of Object.keys(cp)) if (!CP_KEYS.includes(k)) bad('manifest.closePackage 含未知字段：' + k);
      for (const k of CP_KEYS) if (!Object.prototype.hasOwnProperty.call(cp, k)) bad('manifest.closePackage 缺少字段：' + k);
      if (cp.mapping !== CLOSE_MAPPING_DECLARATION) bad('closePackage.mapping 与受审映射声明不一致：' + JSON.stringify(cp.mapping).slice(0, 120));
    }
  }
  if (manifest.planFile !== undefined && manifest.planFile !== 'plan.json') bad('manifest.planFile 必须固定为 plan.json。');
  const planPath = path.join(dir, 'plan.json');
  if (!fs.existsSync(planPath)) { bad('缺少目录内计划 plan.json'); return finish(); }
  const planBytes = fs.readFileSync(planPath);
  if (manifest.planSha256 !== sha256Buffer(planBytes)) { bad('plan.json 与 manifest.planSha256 不一致'); return finish(); }
  try { plan = readPlan(planPath); } catch (error) {
    bad('计划校验失败[' + (error.code || 'PSR_ERROR') + ']：' + error.message);
    return finish();
  }
  clockCheck('check.start');
  if (clockStopped) return finish();
  if (planDigest(plan) !== manifest.planDigest) bad('planDigest 与目录内计划重算不一致');
  const expectFields = {
    registrationRoundId: plan.registrationRoundId, participantCode: plan.participantCode,
    synthetic: plan.synthetic, appId: plan.appId, envId: plan.envId, functionName: plan.functionName,
    usersCollection: plan.usersCollection, auditCollection: plan.auditCollection,
    windowStartsAtIso: plan.windowStartsAtIso, windowExpiresAtIso: plan.windowExpiresAtIso,
    closeSourceDir: relOf(path.relative(ROOT, plan.closeSourceDir)),
    requestProtocol: plan.requestProtocol,
    previewEvidenceSchema: PREVIEW_EVIDENCE_SCHEMA
  };
  // R2 模式：registrationBuildId 依赖受审来源，纳入受控重建出口（结构化失败不抛原始异常）
  try {
    expectFields.registrationBuildId = computeRegistrationBuildId(plan);
  } catch (error) {
    bad('登记版本标识重建失败[' + (error.code || 'PSR_ERROR') + ']：' + error.message);
    return finish();
  }
  for (const [k, v] of Object.entries(expectFields)) {
    if (JSON.stringify(manifest[k]) !== JSON.stringify(v)) bad('manifest.' + k + ' 与计划不一致');
  }
  if (manifest.passphraseDigestRecorded !== true) bad('manifest 缺少口令摘要存在标记');
  const privateSource = manifest.privateSource;
  if (!privateSource || privateSource.schema !== PRIVATE_SOURCE_SCHEMA) {
    bad('manifest.privateSource 缺失或 schema 不符');
  } else if (plan.synthetic) {
    if (privateSource.mode !== 'synthetic-fixture' || privateSource.syntheticFixtureLabel !== 'synthetic-fixture-not-real-number' || privateSource.realSourceConsumed !== false) {
      bad('manifest.privateSource 与合成计划不一致（不得伪造真实私密来源）');
    }
  }
  let expected;
  let closeFiles;
  // R4：真实模式重建必须携带经私密来源解析的账号（缺失=调用方错误，结构化失败）
  if (plan.synthetic === false && !account) {
    bad('真实模式核对必须先经 consumePrivateSource 解析私密来源账号（checkDirResolved）');
    return finish();
  }
  try {
    expected = computeArtifacts(plan, plan.synthetic === true ? plan.syntheticAccount : account);
    closeFiles = verifyCloseSource(plan.closeSourceDir)
      .map(f => ({ rel: adaptCloseRel(f.rel), sourceRel: f.rel, buf: f.buf }));
    for (const f of closeFiles) expected.set('close/' + f.rel, f.buf);
    assertCloseMappingInvariants(new Map(closeFiles.map(cf => [cf.rel, cf.buf])));
  } catch (error) {
    bad('来源重建失败[' + (error.code || 'PSR_ERROR') + ']：' + error.message);
    return finish();
  }
  const declared = new Set();
  const declaredClose = new Set();
  if (manifestFiles.length === 0) bad('files 清单为空');
  if (manifestCloseFiles.length === 0) bad('closePackage.files 清单为空');
  expected.set('plan.json', planBytes); // plan.json 参与清单交叉核对（与 manifest.json 一样单独核对字节）
  for (const f of manifestFiles) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) { bad('files 清单含非法条目'); continue; }
    // R5：条目字段集严格（未知字段如 note 拒绝）
    for (const k of Object.keys(f)) if (!['rel', 'bytes', 'sha256'].includes(k)) bad('files 条目含未知字段：' + f.rel + ':' + k);
    if (!f || typeof f.rel !== 'string' || !/^[A-Za-z0-9_.\-/]+$/.test(f.rel)
      || !Number.isInteger(f.bytes) || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) { bad('files 清单含非法条目'); continue; }
    if (declared.has(f.rel)) bad('重复清单条目：' + f.rel);
    declared.add(f.rel);
    const buf = expected.get(f.rel);
    if (!buf) { bad('files 清单声明了非预期文件：' + f.rel); continue; }
    if (f.bytes !== buf.length || f.sha256 !== sha256Buffer(buf)) bad('清单条目与重建不一致：' + f.rel);
  }
  for (const f of manifestCloseFiles) {
    // 关闭清单条目 rel 为映射后路径（不含 close/ 前缀）；查找时补前缀；字段集严格（R5）
    if (!f || typeof f !== 'object' || Array.isArray(f)) { bad('关闭清单含非法条目'); continue; }
    for (const k of Object.keys(f)) if (!['rel', 'sourceRel', 'bytes', 'sha256'].includes(k)) bad('关闭条目含未知字段：' + (f.rel || '?') + ':' + k);
    if (!f || typeof f.rel !== 'string' || f.sourceRel === undefined || adaptCloseRel(f.sourceRel) !== f.rel
      || !Number.isInteger(f.bytes) || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) {
      bad('关闭清单含非法条目');
      continue;
    }
    const closeRel = 'close/' + f.rel;
    if (declaredClose.has(closeRel)) bad('重复关闭清单条目：' + closeRel);
    declaredClose.add(closeRel);
    const buf = expected.get(closeRel);
    if (!buf) { bad('关闭清单声明了非预期文件：' + closeRel); continue; }
    if (f.bytes !== buf.length || f.sha256 !== sha256Buffer(buf)) bad('关闭清单条目与重建不一致：' + closeRel);
  }
  for (const [rel] of expected) {
    if (rel === 'manifest.json') continue;
    if (!declared.has(rel) && !declaredClose.has(rel)) bad('实际产物缺少清单声明：' + rel);
  }
  for (const rel of declared) {
    if (!expected.has(rel)) bad('清单声明了非预期文件：' + rel);
  }
  for (const rel of declaredClose) {
    if (!expected.has(rel)) bad('关闭清单声明了非预期文件：' + rel);
  }
  // 磁盘字节核对：候选与关闭的实际磁盘文件必须与重建一致（缺失/字节不符拒绝）
  for (const f of manifestFiles) {
    if (!f || typeof f.rel !== 'string' || !declared.has(f.rel) || f.rel === 'plan.json') continue;
    let disk = null;
    try { disk = fs.readFileSync(path.join(dir, f.rel)); } catch (e) { bad('候选磁盘文件缺失或不可读：' + f.rel); continue; }
    const exp = expected.get(f.rel);
    if (!exp) continue;
    if (disk.length !== exp.length || !disk.equals(exp)) bad('候选磁盘文件与重建不一致：' + f.rel);
  }
  for (const f of manifestCloseFiles) {
    if (!f || typeof f.rel !== 'string' || !declaredClose.has('close/' + f.rel)) continue;
    let disk = null;
    try { disk = fs.readFileSync(path.join(dir, 'close', f.rel)); } catch (e) { bad('关闭磁盘文件缺失或不可读：close/' + f.rel); continue; }
    const exp = expected.get('close/' + f.rel);
    if (!exp) continue;
    if (disk.length !== exp.length || !disk.equals(exp)) bad('关闭磁盘文件与重建不一致：close/' + f.rel);
  }
  // 盘上多余文件：未声明的一切文件拒绝（含根下散文件）；链接/junction 拒绝（R5）
  const extra = new Set();
  const links = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) { links.push(rel); continue; }
      if (e.isDirectory()) walk(p); else extra.add(rel);
    }
  };
  try { walk(dir); } catch (e) { bad('候选目录遍历失败：' + e.message); }
  for (const rel of links) bad('候选目录含符号链接/junction：' + rel);
  for (const rel of extra) {
    if (rel === 'plan.json' || rel === 'manifest.json') continue;
    if (declared.has(rel)) continue;
    if (rel.startsWith('close/') && declaredClose.has(rel)) continue;
    bad('盘上存在未声明文件：' + rel);
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
      result.executionReady = false;
    }
    return result;
  }
  return finish();
}

/** 旧严格核对：now<starts 拒绝（行为与既有事实一致；结果结构不变）。
 *  真实模式计划（synthetic:false）必须改用 checkDirResolved（私密来源解析账号后重建）。 */
function checkDir(dir) { return checkDirInternal(dir, 'execute', null); }
function checkPreparedDir(dir) { return checkDirInternal(dir, 'prepare', null); }

/** R4：真实模式核对——先经 consumePrivateSource 解析账号再严格重建（execute 相位）。 */
async function checkDirResolved(dir, opts) {
  const planPath = path.join(path.resolve(dir), 'plan.json');
  const plan = readPlan(planPath);
  if (plan.synthetic === true) return checkDirInternal(dir, 'execute', null);
  const { account } = await consumePrivateSource(planPath, opts);
  return checkDirInternal(dir, 'execute', account);
}

/** R4：真实模式准备核对（prepare 相位；executionReady 仍恒 false）。 */
async function checkPreparedDirResolved(dir, opts) {
  const planPath = path.join(path.resolve(dir), 'plan.json');
  const plan = readPlan(planPath);
  if (plan.synthetic === true) return checkDirInternal(dir, 'prepare', null);
  const { account } = await consumePrivateSource(planPath, opts);
  return checkDirInternal(dir, 'prepare', account);
}

function checkCloseDir(closePackageDir) {
  assertRealDirChain(closePackageDir, 'check-close 输入');
  const closeDir = path.join(closePackageDir, 'close');
  const problems = [];
  let st = null;
  try { st = fs.lstatSync(closeDir); } catch (_) { st = null; }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    return { ok: false, problems: ['缺少真实 close 目录（不得以链接顶替）'], files: 0, expectedFiles: 0 };
  }
  // 受审固定输入：调用者必须显式提供已受审关闭来源目录（环境变量契约与只读包一致）
  const sourceDir = process.env.PIC_CLOSE_SOURCE_DIR;
  if (!sourceDir) return { ok: false, problems: ['缺少受审关闭包来源（须显式提供来源目录）'], files: 0, expectedFiles: 0 };
  let sourceFiles;
  try { sourceFiles = verifyCloseSource(sourceDir); } catch (error) {
    return { ok: false, problems: ['来源重建失败：' + error.message], files: 0, expectedFiles: 0 };
  }
  let expectedMap;
  try {
    expectedMap = new Map(sourceFiles.map(f => [adaptCloseRel(f.rel), f.buf]));
    assertCloseMappingInvariants(expectedMap);
  } catch (error) {
    return { ok: false, problems: ['关闭映射不变量失败[' + (error.code || 'PSR_ERROR') + ']：' + error.message], files: 0, expectedFiles: 0 };
  }
  let files = 0;
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
    if (info.isDir) continue;
    if (!expectedMap.has(rel)) problems.push('close 目录多余文件：close/' + rel);
  }
  return { ok: problems.length === 0, problems, files, expectedFiles: expectedMap.size };
}

const OUT_CONFLICT = ERR.OUT_CONFLICT;

module.exports = Object.freeze({
  ERR, OUT_CONFLICT, OUT_PREFIX,
  PLAN_SCHEMA, MANIFEST_SCHEMA, REQUEST_PROTOCOL, PREVIEW_EVIDENCE_SCHEMA, PRIVATE_SOURCE_SCHEMA,
  FIXED_TARGET,
  build, prepare, checkDir, checkPreparedDir, checkCloseDir,
  checkDirResolved, checkPreparedDirResolved, consumePrivateSource,
  readPlan, planDigest, computeRegistrationBuildId
});
