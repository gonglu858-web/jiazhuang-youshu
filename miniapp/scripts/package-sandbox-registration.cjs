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
const REGISTRATION_MANIFEST_SCHEMA = 'sandbox-registration-candidate/2';

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
  CLOSED_INVALID: 'REG_CLOSED_INVALID',
  FRONTEND_SOURCE_DRIFT: 'REG_FRONTEND_SOURCE_DRIFT',
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


// 独立受审基线来自 be413a0 的 Git 对象；不是当前文件自报指纹。
const REVIEWED_SOURCE_VERSION = "be413a0a29384cacec899bf9eb0eefcf281767a4";
const FRONTEND_FILES = Object.freeze([
  "pages/schedule-sandbox/schedule-sandbox.js",
  "pages/schedule-sandbox/schedule-sandbox.json",
  "pages/schedule-sandbox/schedule-sandbox.wxml",
  "pages/schedule-sandbox/schedule-sandbox.wxss",
  "utils/schedule-sandbox-client.js",
  "utils/env-gate.js",
  "utils/sandbox-test-driver.js",
  "utils/sandbox-test-coordinator.js",
  "config/schedule-sandbox-proof.js",
  "config/schedule-entry-proof.js",
  "config/sandbox-test-driver-proof.js"
]);
const PINNED_FACTS = Object.freeze({
  "miniapp/cloudfunctions/scheduleSandbox/index.js": {
    "bytes": 7752,
    "sha256": "1bec56a38fcec9da89460a32ec34bb55c5607ed740e48692fd6360e5203da048"
  },
  "miniapp/cloudfunctions/scheduleSandbox/gate.js": {
    "bytes": 11484,
    "sha256": "712b6e92b606c321de114f5eed36a66db7ee431dcfc6d4fe7181fb5fd8d0e4cc"
  },
  "miniapp/cloudfunctions/scheduleSandbox/collection-map.js": {
    "bytes": 12303,
    "sha256": "09c5aa9bea3c779aa8c65ea4991c77691db8005380099179ce4281f153046ae6"
  },
  "miniapp/cloudfunctions/scheduleSandbox/project-guard.js": {
    "bytes": 14668,
    "sha256": "c8a2d6f28747bbd343fcbdbb4826ebb880ed0bf89819be4d186204c085c53687"
  },
  "miniapp/cloudfunctions/scheduleSandbox/package.json": {
    "bytes": 303,
    "sha256": "8ffc87ea85fd9767980e9bde06f1693d431acd6b23b64c3b027acc8c133e7e84"
  },
  "miniapp/cloudfunctions/scheduleSandbox/vendor/service.js": {
    "bytes": 26713,
    "sha256": "c5e93d81e0245471efb0bf681836cd94f796fbc6a5547b690d0298a7f6a89e55"
  },
  "miniapp/cloudfunctions/scheduleSandbox/vendor/schedule-service.js": {
    "bytes": 73002,
    "sha256": "da302a7412bb08ce03d18c8486081fcc1e786b2f07f2b3817250fbf88f69cbec"
  },
  "miniapp/cloudfunctions/scheduleSandbox/vendor/MANIFEST.json": {
    "bytes": 728,
    "sha256": "cd711e548e99abf7d086c134f015874f40c34a4c787f637dac4fce50db355830"
  },
  "miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js": {
    "bytes": 31075,
    "sha256": "fbb70b3cb2a9898fe1361804e354c096d457dbfb2cac4bf47e067d7e49e56cd3"
  },
  "miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.json": {
    "bytes": 59,
    "sha256": "7713a1f63aec15f626eef5e42809b1a1cbdae561351d77c54856894ca1cd1609"
  },
  "miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.wxml": {
    "bytes": 10032,
    "sha256": "672f0f9e63d90762914035dc239cd957725221c2eec9599d2e839a03d52b3044"
  },
  "miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.wxss": {
    "bytes": 233,
    "sha256": "d30ca2ab51a2ff15179ace61f1b83a5c8d7a9e8514046262260dd923b25a1eb1"
  },
  "miniapp/miniprogram/utils/schedule-sandbox-client.js": {
    "bytes": 55947,
    "sha256": "fde6107ef00c49b9c34cf8cff507e6c0c5f28ae6e7e9a0913e58dba194ec7409"
  },
  "miniapp/miniprogram/utils/env-gate.js": {
    "bytes": 1546,
    "sha256": "538ec49ec8270ad20fbfd20a5ec073c2cb252ee21daaaa8a36bcd3286ec60aef"
  },
  "miniapp/miniprogram/utils/sandbox-test-driver.js": {
    "bytes": 70929,
    "sha256": "940a89c2bdc3a9fb8143f8d51bff2f311b88c4f1d8bf19409f8312ee9b075bfb"
  },
  "miniapp/miniprogram/utils/sandbox-test-coordinator.js": {
    "bytes": 36589,
    "sha256": "9f17ae44713d58d4b13b021387240e535bbe0dca3b8ca3890acf792e09597c2f"
  },
  "miniapp/miniprogram/config/schedule-sandbox-proof.js": {
    "bytes": 1348,
    "sha256": "724bc3c16ca8d03b84d3d8498b06e011b2ad621599167fc78649b2b378c0cf33"
  },
  "miniapp/miniprogram/config/schedule-entry-proof.js": {
    "bytes": 478,
    "sha256": "85877c2227ac012edca2d4185123b21909bc7973162ca00175e650a2785fec13"
  },
  "miniapp/miniprogram/config/sandbox-test-driver-proof.js": {
    "bytes": 7865,
    "sha256": "15acb49fd8e6838950d56edb2ef0b22c6991103db7026cee817b9776fe59a348"
  }
});
const CLOSED_DIR = 'closed-20261005-r2fix';
const CLOSED_MANIFEST_SHA256 = "8821a459b2f32be1c8d507ec3add0e8306162f84e41b796a875c6f0176ba0277";

function canonical(v) {
  if(Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
const js=v=>JSON.stringify(v).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
function validatePlan(p,o={}) {
  const now=o.nowMs===undefined?Date.now():o.nowMs;
  if(!Number.isFinite(now)) fail(ERR.PLAN_WINDOW_INVALID,'时钟无效。');
  if(!isPlainObject(p)) fail(ERR.PLAN_MISSING,'计划必须为对象。');
  for(const k of Object.keys(p)) if(!PLAN_FIELDS.includes(k)) fail(ERR.PLAN_FIELD_UNKNOWN,k);
  for(const k of PLAN_FIELDS) if(!(k in p)) fail(ERR.PLAN_FIELD_MISSING,k);
  if(typeof p.synthetic!=='boolean') fail(ERR.PLAN_FIELD_MISSING,'synthetic 必须为布尔值。');
  for(const [k,v] of Object.entries(FIXED_TARGET)) if(p[k]!==v) fail(ERR.PLAN_TARGET_MISMATCH,k);
  for(const k of ['purpose','roundId','sourceVersion']) {
    if(typeof p[k]!=='string'||!p[k].trim()) fail(ERR.PLAN_FIELD_MISSING,k);
    if(PLACEHOLDER_RE.test(p[k].trim())) fail(ERR.PLAN_PLACEHOLDER,k);
    if(p[k].length>200) fail(ERR.PLAN_FIELD_UNKNOWN,k+' 过长。');
  }
  if(p.sourceVersion!==REVIEWED_SOURCE_VERSION) fail(ERR.PLAN_SOURCE_DRIFT,'来源必须是受审 be413a0。');
  if(!Array.isArray(p.allowedUserIds)||!p.allowedUserIds.length||
    p.allowedUserIds.some(u=>typeof u!=='string'||!/^u_[0-9a-f]{40}$/.test(u))) fail(ERR.PLAN_USER_INVALID,'须为完整单一用户。');
  if(p.allowedUserIds.length!==1) fail(ERR.PLAN_USER_NOT_UNIQUE,'仅允许一个用户。');
  if(!p.synthetic&&p.allowedUserIds[0]!==CANDIDATE_USER_ID) fail(ERR.PLAN_USER_INVALID,'真实制品仅允许固定本人。');
  const starts=Date.parse(p.windowStartsAt),expires=Date.parse(p.windowExpiresAt);
  if(typeof p.windowStartsAt!=='string'||typeof p.windowExpiresAt!=='string'||
    !Number.isFinite(starts)||!Number.isFinite(expires)||expires<=starts) fail(ERR.PLAN_WINDOW_INVALID,'窗口无效。');
  if(expires-starts>MAX_WINDOW_MS) fail(ERR.PLAN_WINDOW_TOO_LONG,'窗口超过 30 分钟。');
  if(!p.synthetic&&expires<=now) fail(ERR.PLAN_WINDOW_EXPIRED,'真实窗口已过期。');
  return Object.freeze({purpose:p.purpose.trim(),...FIXED_TARGET,allowedUserIds:Object.freeze(p.allowedUserIds.slice()),
    roundId:p.roundId.trim(),windowStartsAt:new Date(starts).toISOString(),windowExpiresAt:new Date(expires).toISOString(),
    sourceVersion:REVIEWED_SOURCE_VERSION,synthetic:p.synthetic});
}
function assertReviewedSources(sources) {
  if(!(sources instanceof Map)||sources.size!==PACKAGE_FILES.length) fail(ERR.PLAN_SOURCE_DRIFT,'来源集合无效。');
  for(const r of PACKAGE_FILES) {
    const e=sources.get(r),p=PINNED_FACTS['miniapp/cloudfunctions/scheduleSandbox/'+r];
    if(!e||!Buffer.isBuffer(e.buf)||e.buf.length!==p.bytes||sha256Buffer(e.buf)!==p.sha256) fail(ERR.PLAN_SOURCE_DRIFT,r+' 来源漂移。');
  }
}
function readReviewedSources() {
  const sources=new Map(PACKAGE_FILES.map(r=>{
    const buf=base.readSource(r,SOURCE_DIR);return [r,{buf,bytes:buf.length,sha256:sha256Buffer(buf)}];
  }));
  assertReviewedSources(sources);
  base.verifyAgainstBaseline(PACKAGE_FILES.map(r=>({sourceKey:'miniapp/cloudfunctions/scheduleSandbox/'+r,sha256:sources.get(r).sha256})));
  return sources;
}
function sourceSetDigest(sources) {
  return sha256Buffer(Buffer.from(PACKAGE_FILES.map(r=>r+':'+sha256Buffer(sources.get(r).buf)).join('\n')));
}
function readFrontendSources() {
  return {version:REVIEWED_SOURCE_VERSION,files:FRONTEND_FILES.map(r=>{
    const buf=base.readSource(r,path.join(ROOT,'miniapp/miniprogram')),p=PINNED_FACTS['miniapp/miniprogram/'+r];
    if(buf.length!==p.bytes||sha256Buffer(buf)!==p.sha256) fail(ERR.FRONTEND_SOURCE_DRIFT,r+' 前端来源漂移。');
    return {rel:r,bytes:buf.length,sha256:sha256Buffer(buf)};
  })};
}
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
  const users = normalizedPlan.allowedUserIds.map((u) => `    ${js(u)}`).join(',\n');
  const anchorTo = [
    'const SANDBOX_CONFIG = gate.readConfig({',
    '  enabled: true,',
    `  appId: ${js(normalizedPlan.appId)},`,
    `  envId: ${js(normalizedPlan.envId)},`,
    '  allowedUserIds: [',
    users,
    '  ],',
    '  // 登记不以创建项目为前置：项目字段保持为空。',
    "  projectId: '',",
    `  roundId: ${js(normalizedPlan.roundId)},`,
    `  expiresAt: ${js(normalizedPlan.windowExpiresAt)},`,
    '  phase: gate.PHASE_PREPARE,',
    "  projectReadyMarker: ''",
    '});'
  ].join('\n');
  return { file: 'index.js', from: anchorFrom, to: anchorTo, label: 'SANDBOX_CONFIG' };
}

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


function applyTransform(sources,t,expectedSourceSha) {
  const e=sources.get(t.file);if(!e) fail(ERR.SOURCE_MISSING,t.file);
  const approved=PINNED_FACTS['miniapp/cloudfunctions/scheduleSandbox/'+t.file],sha=sha256Buffer(e.buf);
  if(!approved||sha!==approved.sha256||(expectedSourceSha&&expectedSourceSha!==approved.sha256)) fail(ERR.PLAN_SOURCE_DRIFT,t.file+' 来源漂移。');
  const text=e.buf.toString('utf8'),n=countOccurrences(text,t.from);
  if(!n) fail(ERR.TRANSFORM_ANCHOR_MISSING,t.file);
  if(n!==1) fail(ERR.TRANSFORM_ANCHOR_AMBIGUOUS,t.file);
  const at=text.indexOf(t.from),buf=Buffer.from(text.slice(0,at)+t.to+text.slice(at+t.from.length));
  return {file:t.file,buf,bytes:buf.length,sha256:sha256Buffer(buf),sourceSha256:sha};
}
function computeArtifacts(sources,p) {
  assertReviewedSources(sources);
  if(p.sourceVersion!==REVIEWED_SOURCE_VERSION) fail(ERR.PLAN_SOURCE_DRIFT,'版本不符。');
  const transforms=[buildIndexTransform(p),buildGateTransform()],differences=[];
  const artifacts=PACKAGE_FILES.map(r=>{
    const e=sources.get(r),t=transforms.find(x=>x.file===r);
    const a=t?applyTransform(sources,t):{buf:e.buf,bytes:e.buf.length,sha256:sha256Buffer(e.buf)};
    if(t) differences.push({file:r,anchor:t.label,sourceSha256:sha256Buffer(e.buf),
      artifactSha256:a.sha256,sourceBytes:e.buf.length,artifactBytes:a.bytes});
    return {rel:r,buf:a.buf,bytes:a.bytes,sha256:a.sha256};
  });
  return {artifacts,differences};
}
// 计划动态值安全序列化；两份同目标、同轮次的覆盖文件。
function buildFrontendOverride(p,version=REVIEWED_SOURCE_VERSION,enabled=true) {
  if(version!==REVIEWED_SOURCE_VERSION||typeof enabled!=='boolean') fail(ERR.PLAN_SOURCE_DRIFT,'前端版本不符。');
  const cfg={enabled,envId:p.envId,appId:p.appId,functionName:p.functionName,sandboxProjectId:'',
    roundId:p.roundId,cachePrefix:'schtest_v1:',sourceVersion:version,synthetic:p.synthetic,
    description:p.synthetic?'合成登记覆盖，仅离线验证。':'本人登记候选覆盖，未部署。'};
  const body="// 本地覆盖文件，非完整预览包。合成制品不得作为真实候选复用。\n'use strict';\n"+
    'module.exports = Object.freeze({\n'+Object.entries(cfg).map(([k,v])=>'  '+k+': '+js(v)+',').join('\n')+
    "\n  allowedVersions: Object.freeze(['develop', 'trial'])\n});\n";
  const buf=Buffer.from(body);
  return {rel:(enabled?'frontend':'frontend-closed')+'/config/schedule-sandbox-proof.js',buf,bytes:buf.length,sha256:sha256Buffer(buf)};
}
function resolveOutDir(id,existingClosedDirs=[]) {
  if(!SAFE_ID_RE.test(id)||['cloudfunctions','miniprogram','scripts','tests','config','artifacts'].includes(id)||
    existingClosedDirs.includes(id)) fail(ERR.OUT_DIR_UNSAFE,'输出编号非法。');
  const dir=path.resolve(ARTIFACTS_ROOT,OUT_DIR_PREFIX+id);base.assertTrustedOutDir(dir,SOURCE_DIR);return dir;
}
function checkedTarget(dir) {
  const resolved=path.resolve(dir),name=path.basename(resolved),id=name.slice(OUT_DIR_PREFIX.length);
  if(path.dirname(resolved)!==path.resolve(ARTIFACTS_ROOT)||!name.startsWith(OUT_DIR_PREFIX)||!SAFE_ID_RE.test(id)) fail(ERR.OUT_DIR_UNSAFE,'仅检查登记制品目录。');
  base.assertTrustedOutDir(resolved,SOURCE_DIR);return resolved;
}
// 整棵树含空目录、链接和非普通文件，写入前完成检查。
function inspectTree(dir,allowedFiles) {
  base.assertTrustedRoot(dir,'制品根',{allowMissing:true});
  const allowed=new Set(allowedFiles),dirs=new Set(),existing=new Map();
  for(const r of allowed){let d=path.posix.dirname(r);while(d!=='.'){dirs.add(d);d=path.posix.dirname(d);}}
  function walk(cur,prefix) {
    for(const name of fs.readdirSync(cur)) {
      const r=prefix?prefix+'/'+name:name,abs=base.resolveInside(dir,r,'制品条目'),st=fs.lstatSync(abs);
      if(st.isSymbolicLink()) fail(ERR.ARTIFACT_SYMLINK,r);
      if(st.isDirectory()){if(!dirs.has(r)) fail(ERR.ARTIFACT_EXTRA_FILE,r);walk(abs,r);}
      else if(st.isFile()){if(!allowed.has(r)) fail(ERR.ARTIFACT_EXTRA_FILE,r);existing.set(r,base.safeReadPackageFile(dir,r).buffer);}
      else fail(ERR.ARTIFACT_EXTRA_FILE,r+' 非普通文件。');
    }
  }
  if(fs.existsSync(dir)) walk(dir,'');
  return existing;
}
function describeClosedPackage(name=CLOSED_DIR) {
  if(name!==CLOSED_DIR) fail(ERR.CLOSED_INVALID,'关闭引用不符。');
  const dir=path.join(ARTIFACTS_ROOT,CLOSED_DIR);
  try {
    const existing=inspectTree(dir,['manifest.json',...PACKAGE_FILES.map(r=>'package/'+r)]);
    if(existing.size!==PACKAGE_FILES.length+1) fail(ERR.CLOSED_INVALID,'关闭包不完整。');
    if(sha256Buffer(existing.get('manifest.json'))!==CLOSED_MANIFEST_SHA256) fail(ERR.CLOSED_INVALID,'关闭 manifest 漂移。');
    const checked=base.buildPackage({outDir:dir,checkOnly:true});
    if(checked.mode!=='check'||checked.entryState.enabled!==false) fail(ERR.CLOSED_INVALID,'未关闭。');
    const files=PACKAGE_FILES.map(r=>{
      const buf=existing.get('package/'+r),p=PINNED_FACTS['miniapp/cloudfunctions/scheduleSandbox/'+r];
      if(buf.length!==p.bytes||sha256Buffer(buf)!==p.sha256) fail(ERR.CLOSED_INVALID,r+' 漂移。');
      return {rel:r,present:true,bytes:buf.length,sha256:sha256Buffer(buf)};
    });
    return {dir:CLOSED_DIR,schema:base.MANIFEST_SCHEMA,present:true,manifestSha256:CLOSED_MANIFEST_SHA256,
      totalBytes:files.reduce((n,f)=>n+f.bytes,0),setDigest:sha256Buffer(Buffer.from(files.map(f=>f.rel+':'+f.sha256).join('\n'))),
      files,entryState:checked.entryState,verification:'旧工具 checkOnly + 独立受审字节'};
  }catch(e){fail(ERR.CLOSED_INVALID,'关闭包校验失败：'+String(e.message).slice(0,180));}
}
const factsOf=a=>({rel:a.rel,bytes:a.bytes,sha256:a.sha256});
function buildManifest(p,artifacts,differences,front,closed,sources,frontClosed,deps,generatedAt) {
  return {schema:REGISTRATION_MANIFEST_SCHEMA,deploymentAuthorized:false,cloudExecuted:false,synthetic:p.synthetic,
    generatedAt,plan:{...p,allowedUserIds:Array.from(p.allowedUserIds),windowMaxMs:MAX_WINDOW_MS},
    effectiveActions:['identify'],prepareAllowedSource:'gate.js PREPARE_ALLOWED 收窄为 [identify]',allowedUsers:Array.from(p.allowedUserIds),
    reviewedSource:{version:REVIEWED_SOURCE_VERSION,setDigest:sourceSetDigest(sources),
      files:PACKAGE_FILES.map(r=>({rel:r,...PINNED_FACTS['miniapp/cloudfunctions/scheduleSandbox/'+r]}))},
    artifacts:artifacts.map(factsOf),differences,frontendOverride:factsOf(front),frontendClosedOverride:factsOf(frontClosed),
    frontendDependencies:deps,closedPackage:closed,
    limitations:['仅本地候选清单，不构成部署授权或云端证明。','合成制品不得复用为真实制品。',
      '两份前端覆盖文件均非完整可预览包。','真实应用代码＋合成SDK/数据库；平台、部署、登记未验证未放行。',
      'identify 首次写测试 users 与 registerIdentity 审计；不写 primary、不取号、不建项目。']};
}
function expectedBundle(plan,nowMs) {
  const p=validatePlan(plan,{nowMs}),sources=readReviewedSources(),computed=computeArtifacts(sources,p),deps=readFrontendSources();
  const front=buildFrontendOverride(p),frontClosed=buildFrontendOverride(p,REVIEWED_SOURCE_VERSION,false),closed=describeClosedPackage();
  const expected=new Map([...computed.artifacts,front,frontClosed].map(a=>['package/'+a.rel,a.buf]));
  return {normalized:p,computed,expected,manifestAt:at=>buildManifest(p,computed.artifacts,computed.differences,front,closed,sources,frontClosed,deps,at)};
}
function planFromManifest(m) {
  if(!isPlainObject(m)||!isPlainObject(m.plan)) fail(ERR.MANIFEST_INVALID,'计划无效。');
  const p={...m.plan};delete p.windowMaxMs;return p;
}
function verifyExisting(existing,bundle,complete) {
  for(const [r,b] of existing) if(r!=='manifest.json'&&(!bundle.expected.has(r)||!b.equals(bundle.expected.get(r)))) fail(ERR.MANIFEST_MISMATCH,r+' 字节不符。');
  if(complete) for(const r of bundle.expected.keys()) if(!existing.has(r)) fail(ERR.ARTIFACT_INCOMPLETE,r);
}
function validateManifest(existing,bundle) {
  let m;try{m=JSON.parse(existing.get('manifest.json'));}catch(_){fail(ERR.MANIFEST_INVALID,'manifest 无效。');}
  if(!isPlainObject(m)) fail(ERR.MANIFEST_INVALID,'manifest 必须是对象。');
  if(typeof m.generatedAt!=='string'||!Number.isFinite(Date.parse(m.generatedAt))||
    new Date(Date.parse(m.generatedAt)).toISOString()!==m.generatedAt) fail(ERR.MANIFEST_INVALID,'生成时间无效。');
  if(canonical(m)!==canonical(bundle.manifestAt(m.generatedAt))) fail(ERR.MANIFEST_MISMATCH,'manifest 完整契约不符。');
  verifyExisting(existing,bundle,true);return m;
}
function checkRegistration(o={}) {
  if(!o.outDir){
    const candidates=fs.existsSync(ARTIFACTS_ROOT)?fs.readdirSync(ARTIFACTS_ROOT).filter(n=>n.startsWith(OUT_DIR_PREFIX)):[];
    return {ok:candidates.length===0,mode:'check',candidates,problems:candidates.length?
      [{code:ERR.ARTIFACT_EXISTS_DIFFERENT,detail:'请指定 --target 逐项检查。'}]:[],wroteFiles:false,cloudCalled:false};
  }
  let dir;try {
    dir=checkedTarget(o.outDir);
    const existing=inspectTree(dir,['manifest.json',...PACKAGE_FILES.map(r=>'package/'+r),
      'package/frontend/config/schedule-sandbox-proof.js','package/frontend-closed/config/schedule-sandbox-proof.js']);
    if(!existing.has('manifest.json')) fail(ERR.MANIFEST_INVALID,'缺 manifest。');
    let m;try{m=JSON.parse(existing.get('manifest.json'));}catch(_){fail(ERR.MANIFEST_INVALID,'非法 JSON。');}
    const bundle=expectedBundle(o.plan||planFromManifest(m),o.nowMs);validateManifest(existing,bundle);
    return {ok:true,mode:'check',dir,differences:bundle.computed.differences,problems:[],wroteFiles:false,cloudCalled:false};
  }catch(e){return {ok:false,mode:'check',dir,problems:[{code:e.code||ERR.MANIFEST_INVALID,detail:String(e.message).slice(0,200)}],wroteFiles:false,cloudCalled:false};}
}
function buildRegistration(plan,o={}) {
  const now=o.nowMs===undefined?Date.now():o.nowMs,id=o.outId===undefined?safeOutId(plan&&plan.roundId):o.outId;
  const dir=resolveOutDir(id,[CLOSED_DIR]),bundle=expectedBundle(plan,now);
  const existing=inspectTree(dir,['manifest.json',...bundle.expected.keys()]);
  if(existing.has('manifest.json')){
    let m;try{m=validateManifest(existing,bundle);}catch(e){fail(ERR.ARTIFACT_EXISTS_DIFFERENT,'完整计划/字节不符：'+e.message);}
    return {ok:true,mode:'build',dir,reused:true,manifest:m,differences:bundle.computed.differences,wroteFiles:false,cloudCalled:false};
  }
  verifyExisting(existing,bundle,false);
  const manifest=bundle.manifestAt(new Date(now).toISOString()),written=[];
  const missing=new Map([...bundle.expected].filter(([r])=>!existing.has(r)));
  missing.set('manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
  try {
    for(const [r,b] of missing){
      const abs=base.resolveInside(dir,r,'登记文件',{allowMissingBase:true});
      fs.mkdirSync(path.dirname(abs),{recursive:true});base.resolveInside(dir,r,'登记写点');
      fs.writeFileSync(abs,b,{flag:'wx'});written.push(r);
    }
  }catch(e){return {ok:false,mode:'build',dir,incomplete:true,written,problems:[{code:ERR.WRITE_FAILED,detail:'写入期 I/O 失败，半成品保留，未递归清理。'}],wroteFiles:written.length>0,cloudCalled:false};}
  return {ok:true,mode:'build',dir,reused:false,manifest,differences:bundle.computed.differences,written,
    reusedFiles:Array.from(existing.keys()),wroteFiles:true,cloudCalled:false};
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
module.exports=Object.freeze({ROOT,SOURCE_DIR,ARTIFACTS_ROOT,PACKAGE_FILES,OUT_DIR_ALLOWED_TOP,
 FIXED_TARGET,CANDIDATE_USER_ID,REGISTRATION_ALLOWED_ACTIONS,REGISTRATION_MANIFEST_SCHEMA,
 MAX_WINDOW_MS,PLAN_FIELDS,ERR,RegistrationError,REVIEWED_SOURCE_VERSION,FRONTEND_FILES,PINNED_FACTS,
 CLOSED_DIR,CLOSED_MANIFEST_SHA256,validatePlan,readReviewedSources,assertReviewedSources,readFrontendSources,
 sourceSetDigest,buildIndexTransform,buildGateTransform,applyTransform,computeArtifacts,buildFrontendOverride,
 describeClosedPackage,buildManifest,resolveOutDir,checkRegistration,buildRegistration,safeOutId,sha256Buffer,
 countOccurrences,parseArgs,main});
if(require.main===module)process.exit(main(process.argv.slice(2)));
