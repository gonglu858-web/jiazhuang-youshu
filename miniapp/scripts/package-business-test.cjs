#!/usr/bin/env node
// 三账号独立业务测试包：P／E／X 三窗口候选与配对关闭包的本地生成/校验工具。
//
// 任务：docs/WorkBuddy任务-三账号独立业务测试包本地准备-20261013.md
// 方案：docs/Codex方案-独立测试项目与管家师傅业务验证-20261013.md §4
//
// 设计约束：
// 1. **只做受审变换**：服务端仅替换 index.js 的 SANDBOX_CONFIG 配置对象与
//    gate.js 的阶段允许清单（动作收窄）；前端仅替换 schedule-sandbox-proof.js
//    与（仅 X）sandbox-test-driver-proof.js 的启用/绑定字段。其余文件逐字节一致。
// 2. **来源漂移防护**：全部源文件（8 服务端 + 11 前端）先与
//    package-sandbox-registration 的 PINNED_FACTS（受审哈希）核对，不一致即停止。
// 3. **锚定唯一**：每个变换先确认目标片段在源中恰出现一次；缺失/多处即失败。
// 4. **roundId↔projectId 绑定**：E/X 计划的 projectId 必须等于由同一
//    businessRoundId 确定性推导的 `p_sbx_` + 32 位十六进制（project-guard 同算法），
//    且不得指向受保护的原 A/B/C 项目。
// 5. **real / synthetic 双模式**：real 模式要求恰三个不同完整 userId（u_+40hex）
//    且各带非占位来源说明；synthetic 模式产物显式标记 synthetic=true，
//    **不代表真实批准**。两模式都不生成生产批准、不内置真实执行日期。
// 6. **输出安全**：只写 `artifacts/schedule-sandbox/business-test/` 之下；
//    已存在文件逐字节相同则复用（reused），不同则失败——不覆盖、不删除，
//    支持「合法半成品续建」（重跑补齐缺失文件）。
// 7. **配对关闭包**：每窗口同时输出关闭包（服务端=交付源码原样、前端配置=交付
//    原样关闭版），独立 manifest 段可单独核对；不受开启窗口时效影响。
// 8. **不含上传/部署/安装/云端调用**；只读写本地文件。
//
// 用法：
//   node miniapp/scripts/package-business-test.cjs --window P --plan <plan.json> [--out <dir>]
//   node miniapp/scripts/package-business-test.cjs --window E --plan <plan.json>
//   node miniapp/scripts/package-business-test.cjs --window X --plan <plan.json>
//   node miniapp/scripts/package-business-test.cjs --check <dir>
//
// 退出码：0 通过；1 计划/来源/锚点/校验失败。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const base = require('./package-sandbox.cjs');
const registration = require('./package-sandbox-registration.cjs');
const projectGuard = require('../cloudfunctions/scheduleSandbox/project-guard');
const gate = require('../cloudfunctions/scheduleSandbox/gate');

const ROOT = base.ROOT;
const SERVER_BASE = path.join(ROOT, 'miniapp', 'cloudfunctions', 'scheduleSandbox');
const FRONTEND_BASE = path.join(ROOT, 'miniapp', 'miniprogram');
const OUT_ROOT = path.join(base.ARTIFACTS_ROOT, 'business-test');

/** 复用受审固定目标（与既有常量一致，不新增可变目标）。 */
const FIXED_TARGET = Object.freeze({
  appId: 'wxfb4db1615ac15531',
  envId: 'cloud1-d8gcq5ag39d847723',
  functionName: 'scheduleSandbox'
});

/** 受保护原项目（与 gate.js 一致）：任何窗口的计划都不得指向这些 ID。 */
const PROTECTED_PROJECT_IDS = gate.PROTECTED_PROJECT_IDS;

const SERVER_FILES = Object.freeze(base.PACKAGE_FILES.slice());
const FRONTEND_FILES = Object.freeze(registration.FRONTEND_FILES.slice());
const PINNED_FACTS = registration.PINNED_FACTS;

const MANIFEST_SCHEMA = 'business-test-candidate/1';
const MAX_WINDOW_MS = 2 * 60 * 60 * 1000; // 单窗口操作上限 2 小时（沿用既有方案口径）
const USER_ID_RE = /^u_[0-9a-f]{40}$/;
const PROJECT_ID_RE = /^p_sbx_[0-9a-f]{32}$/;
const PLACEHOLDER_RE = /<[^>]{1,80}>|TODO|待填|待定|占位|PLACEHOLDER/i;
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const WINDOW_NO_RE = /^[PEX]-[0-9A-Za-z-]{1,20}$/;

const ERR = Object.freeze({
  PLAN_INVALID: 'BTP_PLAN_INVALID',
  PLAN_WINDOW_INVALID: 'BTP_PLAN_WINDOW_INVALID',
  PLAN_USER_INVALID: 'BTP_PLAN_USER_INVALID',
  PLAN_PROJECT_INVALID: 'BTP_PLAN_PROJECT_INVALID',
  SOURCE_MISSING: 'BTP_SOURCE_MISSING',
  SOURCE_DRIFT: 'BTP_SOURCE_DRIFT',
  TRANSFORM_ANCHOR_MISSING: 'BTP_TRANSFORM_ANCHOR_MISSING',
  TRANSFORM_ANCHOR_AMBIGUOUS: 'BTP_TRANSFORM_ANCHOR_AMBIGUOUS',
  OUT_CONFLICT: 'BTP_OUT_CONFLICT',
  MANIFEST_INVALID: 'BTP_MANIFEST_INVALID'
});

class BusinessTestError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new BusinessTestError(code, message); };

// ── 各窗口允许动作（方案 §4 的服务端子集收窄） ──────────────────────────────
// P：prepare 全清单剔除 removeMember（14 项）。
const P_ACTIONS = Object.freeze(
  gate.PREPARE_ALLOWED.filter(a => a !== 'removeMember')
);
// E：execute 子集——剔除 requestBindingNumber / reassignSchedule /
//    applyInvitation / removeMember / listInvitations（10 项）。
const E_ACTIONS = Object.freeze([
  'identify', 'listMyProjects', 'getMembers', 'getScheduleContext',
  'listSchedules', 'getSchedule', 'listScheduleRevisions',
  'createSchedule', 'updateSchedule', 'cancelSchedule'
]);
// X：仅必要读取、identify、cancelSchedule、removeMember（9 项）。
const X_ACTIONS = Object.freeze([
  'identify', 'listMyProjects', 'getMembers', 'getScheduleContext',
  'listSchedules', 'getSchedule', 'listScheduleRevisions',
  'cancelSchedule', 'removeMember'
]);
const WINDOW_ACTIONS = Object.freeze({ P: P_ACTIONS, E: E_ACTIONS, X: X_ACTIONS });

// ── 工具函数 ────────────────────────────────────────────────────────────────
function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function countOccurrences(text, needle) {
  let n = 0, at = 0;
  while ((at = text.indexOf(needle, at)) !== -1) { n++; at += needle.length; }
  return n;
}
function js(v) { return JSON.stringify(v); }
function readSourceFile(root, rel) {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs);
  if (!st.isFile()) fail(ERR.SOURCE_DRIFT, rel + ' 不是普通文件。');
  return fs.readFileSync(abs);
}
function isPlaceholder(text) {
  return typeof text !== 'string' || !text.trim() || PLACEHOLDER_RE.test(text.trim());
}
function pinnedKeyFor(root, rel) {
  return root === 'server'
    ? 'miniapp/cloudfunctions/scheduleSandbox/' + rel
    : 'miniapp/miniprogram/' + rel;
}

// ── 来源读取与漂移防护 ──────────────────────────────────────────────────────
// sources：Map<`${root}/${rel}`, {buf, bytes, sha256}>
function readPinnedSources() {
  const sources = new Map();
  const read = (root, rel, baseDir) => {
    const buf = readSourceFile(baseDir, rel);
    const pinned = PINNED_FACTS[pinnedKeyFor(root, rel)];
    if (!pinned || buf.length !== pinned.bytes || sha256Buffer(buf) !== pinned.sha256) {
      fail(ERR.SOURCE_DRIFT, root + '/' + rel + ' 与受审基线不一致。');
    }
    sources.set(root + '/' + rel, { buf, bytes: buf.length, sha256: sha256Buffer(buf) });
  };
  for (const rel of SERVER_FILES) read('server', rel, SERVER_BASE);
  for (const rel of FRONTEND_FILES) read('frontend', rel, FRONTEND_BASE);
  return sources;
}

// ── 计划校验 ────────────────────────────────────────────────────────────────
function readPlan(planPath, windowId) {
  if (typeof planPath !== 'string' || !planPath) fail(ERR.PLAN_INVALID, '缺少 --plan 计划文件。');
  if (!['P', 'E', 'X'].includes(windowId)) fail(ERR.PLAN_INVALID, '--window 必须是 P/E/X。');
  const raw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  if (raw.schema !== 'business-test-plan/1') fail(ERR.PLAN_INVALID, '计划 schema 必须是 business-test-plan/1。');
  if (raw.window !== windowId) fail(ERR.PLAN_INVALID, '计划 window 与 --window 不一致。');
  if (typeof raw.synthetic !== 'boolean') fail(ERR.PLAN_INVALID, '计划缺少 synthetic 布尔字段。');
  if (typeof raw.businessRoundId !== 'string' || !ROUND_ID_RE.test(raw.businessRoundId)) {
    fail(ERR.PLAN_INVALID, 'businessRoundId 须为 4–64 位字母数字-_，且不以符号开头。');
  }
  if (typeof raw.windowNo !== 'string' || !WINDOW_NO_RE.test(raw.windowNo)) {
    fail(ERR.PLAN_INVALID, 'windowNo 须形如 P-01 / E-01 / X-01。');
  }
  for (const k of ['appId', 'envId']) {
    if (raw[k] !== FIXED_TARGET[k]) fail(ERR.PLAN_INVALID, k + ' 必须是受审固定值。');
  }
  // 用户：恰三个不同完整 userId；real 模式各带非占位来源说明
  const users = raw.users || {};
  const roles = ['owner', 'manager', 'worker'];
  for (const role of roles) {
    const u = users[role];
    if (!u || !USER_ID_RE.test(u.userId || '')) {
      fail(ERR.PLAN_USER_INVALID, role + ' 缺少完整 userId（u_ + 40 位十六进制）。');
    }
    if (!raw.synthetic && isPlaceholder(u.source)) {
      fail(ERR.PLAN_USER_INVALID, role + ' 真实候选缺少来源说明（不得为占位）。');
    }
  }
  const ids = roles.map(r => users[r].userId);
  if (new Set(ids).size !== 3) fail(ERR.PLAN_USER_INVALID, '三个账号必须互不相同。');
  // 窗口时效
  const starts = Date.parse(raw.windowStartsAt);
  const expires = Date.parse(raw.windowExpiresAt);
  if (!Number.isFinite(starts) || !Number.isFinite(expires) || expires <= starts) {
    fail(ERR.PLAN_WINDOW_INVALID, '窗口时间无效。');
  }
  if (expires - starts > MAX_WINDOW_MS) fail(ERR.PLAN_WINDOW_INVALID, '窗口超过 2 小时上限。');
  if (!raw.synthetic && expires <= Date.now()) fail(ERR.PLAN_WINDOW_INVALID, '真实窗口已过期。');
  // 标记
  if (isPlaceholder(raw.projectReadyMarker)) {
    fail(ERR.PLAN_INVALID, '缺少 projectReadyMarker（本轮项目持久标记配置）。');
  }
  if (raw.projectReadyMarker.length > 128) fail(ERR.PLAN_INVALID, 'projectReadyMarker 过长。');
  // projectId：P 为空；E/X 必填且必须与 roundId 确定性绑定
  let projectId = '';
  if (windowId === 'P') {
    if (raw.projectId) fail(ERR.PLAN_PROJECT_INVALID, 'P 窗口建项目前不得预填 projectId。');
  } else {
    if (typeof raw.projectId !== 'string' || !PROJECT_ID_RE.test(raw.projectId)) {
      fail(ERR.PLAN_PROJECT_INVALID,
        'E/X 计划必须携带 P 窗口真实回读的 projectId（p_sbx_ + 32 位十六进制）。');
    }
    if (PROTECTED_PROJECT_IDS.includes(raw.projectId)) {
      fail(ERR.PLAN_PROJECT_INVALID, '计划指向受保护的原项目，已拒绝。');
    }
    const derived = projectGuard.roundProjectId(raw.businessRoundId);
    if (derived !== raw.projectId) {
      fail(ERR.PLAN_PROJECT_INVALID,
        'projectId 与 businessRoundId 不绑定（应为 ' + derived + '）；不得指向其他轮次的项目。');
    }
    projectId = raw.projectId;
  }
  return Object.freeze({
    window: windowId,
    synthetic: raw.synthetic,
    businessRoundId: raw.businessRoundId,
    windowNo: raw.windowNo,
    appId: FIXED_TARGET.appId,
    envId: FIXED_TARGET.envId,
    allowedUserIds: Object.freeze(ids),
    users: Object.freeze(roles.map(r => Object.freeze({
      role: r, userId: users[r].userId, source: String(users[r].source || '')
    }))),
    projectId,
    projectReadyMarker: String(raw.projectReadyMarker),
    windowStartsAt: new Date(starts).toISOString(),
    windowExpiresAt: new Date(expires).toISOString(),
    actions: WINDOW_ACTIONS[windowId]
  });
}

// ── 变换构造（锚定唯一） ────────────────────────────────────────────────────
function buildIndexTransform(plan) {
  const phaseExpr = plan.window === 'P' ? 'gate.PHASE_PREPARE' : 'gate.PHASE_EXECUTE';
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
  const users = plan.allowedUserIds.map(u => `    ${js(u)}`).join(',\n');
  const anchorTo = [
    `// 三账号业务测试候选（窗口 ${plan.windowNo}${plan.synthetic ? '，synthetic 样本' : ''}）：`,
    '// 允许账号恰三个（负责人/管家/师傅），动作收窄见 gate.js 变换；',
    '// projectReadyMarker 为窗口配置的持久标记；本候选不构成部署或写入批准。',
    'const SANDBOX_CONFIG = gate.readConfig({',
    '  enabled: true,',
    `  appId: ${js(plan.appId)},`,
    `  envId: ${js(plan.envId)},`,
    '  allowedUserIds: [',
    users,
    '  ],',
    plan.projectId
      ? `  projectId: ${js(plan.projectId)},`
      : '  // P 窗口建项目前未知：projectId 保持为空。',
    `  roundId: ${js(plan.businessRoundId)},`,
    `  expiresAt: ${js(plan.windowExpiresAt)},`,
    `  phase: ${phaseExpr},`,
    `  projectReadyMarker: ${js(plan.projectReadyMarker)}`,
    '});'
  ].join('\n');
  return { root: 'server', file: 'index.js', from: anchorFrom, to: anchorTo, label: 'SANDBOX_CONFIG' };
}

function gateListTransform(listName, fromActions, toActions, headerComment) {
  const fromList = fromActions
    .map(a => `  '${a}'${a === fromActions[fromActions.length - 1] ? '' : ','}`).join('\n');
  const toList = toActions
    .map(a => `  '${a}'${a === toActions[toActions.length - 1] ? '' : ','}`).join('\n');
  const anchorFrom = [`const ${listName} = Object.freeze([`, fromList, ']);'].join('\n');
  const anchorTo = [headerComment, `const ${listName} = Object.freeze([`, toList, ']);'].join('\n');
  return { root: 'server', file: 'gate.js', from: anchorFrom, to: anchorTo, label: listName };
}

function buildGateTransform(plan) {
  if (plan.window === 'P') {
    return gateListTransform('PREPARE_ALLOWED', gate.PREPARE_ALLOWED, plan.actions,
      '// P 窗口候选：成员准备动作子集（剔除 removeMember；安排写动作不在 prepare）。\n' +
      "// 注：phase 固定为 prepare，EXECUTE_ALLOWED 在本候选不可达。\n");
  }
  const header = plan.window === 'E'
    ? '// E 窗口候选：执行动作子集（正常安排与查询；剔除取号/改派/邀请/移出）。\n' +
      "// 注：phase 固定为 execute，PREPARE_ALLOWED 在本候选不可达。\n"
    : '// X 窗口候选：移出验证动作子集（必要读取 + identify + cancelSchedule + removeMember）。\n' +
      '// 禁止 create/update/reassign；V06 并发不在本窗口开放。\n' +
      "// 注：phase 固定为 execute，PREPARE_ALLOWED 在本候选不可达。\n";
  return gateListTransform('EXECUTE_ALLOWED', gate.EXECUTE_ALLOWED, plan.actions, header);
}

function buildProofTransforms(plan) {
  const transforms = [];
  const push = (label, from, to) => transforms.push(
    { root: 'frontend', file: 'config/schedule-sandbox-proof.js', from, to, label });
  push('proof.enabled', '  enabled: false,', '  enabled: true,');
  push('proof.roundId', "  roundId: '',", `  roundId: ${js(plan.businessRoundId)},`);
  if (plan.projectId) {
    push('proof.sandboxProjectId', "  sandboxProjectId: '',",
      `  sandboxProjectId: ${js(plan.projectId)}, // P 窗口真实回读后登记的期望值`);
  }
  return transforms;
}

function buildDriverTransforms(plan) {
  // 仅 X 窗口：启用驱动并绑定本轮管家/师傅，用例收窄为 V07-A/B（V06 不附带开放）。
  const manager = plan.users.find(u => u.role === 'manager').userId;
  const worker = plan.users.find(u => u.role === 'worker').userId;
  const t = [];
  const push = (label, from, to) => t.push(
    { root: 'frontend', file: 'config/sandbox-test-driver-proof.js', from, to, label });
  push('driver.enabled', '  enabled: false,', '  enabled: true,');
  push('driver.roundId', "  roundId: '',", `  roundId: ${js(plan.businessRoundId)},`);
  push('driver.projectId', "  projectId: '',", `  projectId: ${js(plan.projectId)},`);
  push('driver.actorUserId', "  actorUserId: '',",
    `  actorUserId: ${js(manager)}, // 本轮管家（完整 userId，非尾号）`);
  push('driver.expiresAt', "  expiresAt: '',", `  expiresAt: ${js(plan.windowExpiresAt)},`);
  push('driver.evidenceId', "  evidenceId: '',", `  evidenceId: ${js(plan.windowNo)},`);
  push('driver.v07TargetUserId', "  v07TargetUserId: '',",
    `  v07TargetUserId: ${js(worker)}, // 本轮唯一师傅（完整 userId，非历史尾号）`);
  push('driver.testCases',
    'const TEST_CASES = Object.freeze([...V06_CASES, ...V07_CASES]);',
    '// X 窗口收窄：V06 并发用例不随本候选开放；仅保留两次移出用例。\n' +
    'const TEST_CASES = Object.freeze(V07_CASES);');
  push('driver.v06Cases', '  v06Cases: V06_CASES,', '  v06Cases: Object.freeze([]),');
  return t;
}

function buildTransforms(plan) {
  const t = [buildIndexTransform(plan), buildGateTransform(plan), ...buildProofTransforms(plan)];
  if (plan.window === 'X') t.push(...buildDriverTransforms(plan));
  return t;
}

function applyTransform(sources, t) {
  const key = t.root + '/' + t.file;
  const e = sources.get(key);
  if (!e) fail(ERR.SOURCE_MISSING, key);
  const approved = PINNED_FACTS[pinnedKeyFor(t.root, t.file)];
  if (!approved || e.sha256 !== approved.sha256) fail(ERR.SOURCE_DRIFT, key + ' 来源漂移。');
  const text = e.buf.toString('utf8');
  const n = countOccurrences(text, t.from);
  if (n === 0) fail(ERR.TRANSFORM_ANCHOR_MISSING, key + '：' + t.label);
  if (n !== 1) fail(ERR.TRANSFORM_ANCHOR_AMBIGUOUS, key + '：' + t.label);
  const at = text.indexOf(t.from);
  const buf = Buffer.from(text.slice(0, at) + t.to + text.slice(at + t.from.length));
  return { buf, bytes: buf.length, sha256: sha256Buffer(buf), sourceSha256: e.sha256 };
}

/**
 * 按声明顺序把**同一文件的多个变换**串联应用。
 * 每一步都在上一步产物上锚定唯一匹配；任一步失败即停止（不写盘）。
 */
function applyFileTransforms(sources, root, rel, transforms) {
  const ts = transforms.filter(x => x.root === root && x.file === rel);
  const src = sources.get(root + '/' + rel);
  if (!src) fail(ERR.SOURCE_MISSING, root + '/' + rel);
  if (ts.length === 0) {
    return { buf: src.buf, bytes: src.bytes, sha256: src.sha256, sourceSha256: src.sha256, steps: [] };
  }
  const approved = PINNED_FACTS[pinnedKeyFor(root, rel)];
  if (!approved || src.sha256 !== approved.sha256) fail(ERR.SOURCE_DRIFT, root + '/' + rel + ' 来源漂移。');
  const sourceSha256 = src.sha256;
  let cur = { buf: src.buf, bytes: src.bytes, sha256: src.sha256 };
  const steps = [];
  for (const t of ts) {
    const text = cur.buf.toString('utf8');
    const n = countOccurrences(text, t.from);
    if (n === 0) fail(ERR.TRANSFORM_ANCHOR_MISSING, root + '/' + rel + '：' + t.label);
    if (n !== 1) fail(ERR.TRANSFORM_ANCHOR_AMBIGUOUS, root + '/' + rel + '：' + t.label);
    const at = text.indexOf(t.from);
    const buf = Buffer.from(text.slice(0, at) + t.to + text.slice(at + t.from.length));
    cur = { buf, bytes: buf.length, sha256: sha256Buffer(buf) };
    steps.push({
      label: t.label,
      fromSha: sha256Buffer(Buffer.from(t.from)),
      toSha: sha256Buffer(Buffer.from(t.to)),
      resultSha256: cur.sha256
    });
  }
  return { buf: cur.buf, bytes: cur.bytes, sha256: cur.sha256, sourceSha256, steps };
}

// ── 组装与写出 ──────────────────────────────────────────────────────────────
function planDigest(plan) {
  const canon = JSON.stringify({
    w: plan.window, r: plan.businessRoundId, n: plan.windowNo,
    u: plan.allowedUserIds, p: plan.projectId,
    e: plan.windowExpiresAt, s0: plan.windowStartsAt,
    m: plan.projectReadyMarker, s: plan.synthetic
  });
  return sha256Buffer(Buffer.from(canon));
}

function writeFileReuse(abs, buf, io) {
  if (fs.existsSync(abs)) {
    const existing = fs.readFileSync(abs);
    if (existing.equals(buf)) {
      io.push({ path: abs, action: 'reused' });
      return;
    }
    fail(ERR.OUT_CONFLICT, '已存在内容不同的文件，不覆盖：' + abs);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  io.push({ path: abs, action: 'written' });
}

function build(windowId, planPath, outOverride) {
  const plan = readPlan(planPath, windowId);
  const sources = readPinnedSources();
  const transforms = buildTransforms(plan);
  const digest = planDigest(plan);
  const outDir = outOverride
    ? path.resolve(outOverride)
    : path.join(OUT_ROOT, plan.window.toLowerCase() + '-' + digest.slice(0, 12));
  if (!outDir.startsWith(OUT_ROOT + path.sep)) {
    fail(ERR.OUT_CONFLICT, '输出目录必须位于 ' + OUT_ROOT + ' 之下。');
  }
  const io = [];
  const entries = [];

  // 服务端候选（index.js / gate.js 为变换产物，其余逐字节一致）
  for (const rel of SERVER_FILES) {
    const src = applyFileTransforms(sources, 'server', rel, transforms);
    writeFileReuse(path.join(outDir, 'server', rel), src.buf, io);
    entries.push({
      rel: 'server/' + rel, bytes: src.bytes, sha256: src.sha256,
      sourceSha256: src.sourceSha256 === src.sha256 ? null : src.sourceSha256,
      transform: src.steps.length ? src.steps.map(s => s.label) : null,
      transformSteps: src.steps.length ? src.steps : null
    });
  }
  // 前端候选（proof /（X）driver-proof 为变换产物，其余逐字节一致）
  for (const rel of FRONTEND_FILES) {
    const src = applyFileTransforms(sources, 'frontend', rel, transforms);
    writeFileReuse(path.join(outDir, 'frontend', rel), src.buf, io);
    entries.push({
      rel: 'frontend/' + rel, bytes: src.bytes, sha256: src.sha256,
      sourceSha256: src.sourceSha256 === src.sha256 ? null : src.sourceSha256,
      transform: src.steps.length ? src.steps.map(s => s.label) : null,
      transformSteps: src.steps.length ? src.steps : null
    });
  }
  // 配对关闭包（源码原样，配置默认关闭；独立核对，不受开启窗口时效影响）
  const closeEntries = [];
  for (const rel of SERVER_FILES) {
    const e = sources.get('server/' + rel);
    writeFileReuse(path.join(outDir, 'close', 'server', rel), e.buf, io);
    closeEntries.push({ rel: 'close/server/' + rel, bytes: e.buf.length, sha256: e.sha256 });
  }
  for (const rel of FRONTEND_FILES) {
    const e = sources.get('frontend/' + rel);
    writeFileReuse(path.join(outDir, 'close', 'frontend', rel), e.buf, io);
    closeEntries.push({ rel: 'close/frontend/' + rel, bytes: e.buf.length, sha256: e.sha256 });
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    window: plan.window,
    windowNo: plan.windowNo,
    synthetic: plan.synthetic,
    businessRoundId: plan.businessRoundId,
    projectId: plan.projectId || null,
    projectReadyMarker: plan.projectReadyMarker,
    windowStartsAt: plan.windowStartsAt,
    windowExpiresAt: plan.windowExpiresAt,
    allowedUserIds: plan.allowedUserIds,
    userSourceNote: plan.synthetic
      ? 'synthetic 样本：账号为合成值，不代表真实人员或批准。'
      : 'real 候选：三个完整 userId 均带来源说明（见用户来源摘要）。',
    userSources: plan.users.map(u => ({ role: u.role, userIdTail: u.userId.slice(-6), source: u.source })),
    planDigest: digest,
    actions: plan.actions,
    transforms: transforms.map(t => ({
      root: t.root, file: t.file, label: t.label,
      fromSha: sha256Buffer(Buffer.from(t.from)),
      toSha: sha256Buffer(Buffer.from(t.to))
    })),
    files: entries,
    closePackage: {
      note: '配对关闭包：交付源码原样（服务端开关默认关闭、前端配置默认关闭）；独立可核对。',
      files: closeEntries
    },
    boundaries: [
      '候选不是部署批准；不含任何真实批准或自动延期。',
      '服务端依赖安装、完整构建、平台部署与真实调用未验证。',
      'synthetic 样本不构成真实批准；real 候选须以参与者来源核实为前提。'
    ]
  };
  writeFileReuse(path.join(outDir, 'manifest.json'),
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), io);
  return { outDir, manifest, io };
}

function checkDir(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail(ERR.MANIFEST_INVALID, '缺少 manifest.json：' + dir);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA) fail(ERR.MANIFEST_INVALID, 'manifest schema 不符。');
  const problems = [];
  const declared = new Set();
  const verify = rel => {
    declared.add(rel);
    const abs = path.join(dir, rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch (_) { st = null; }
    if (!st || !st.isFile()) { problems.push(rel + ' 缺失'); return; }
    const buf = fs.readFileSync(abs);
    const rec = manifest.files.concat(manifest.closePackage.files).find(f => f.rel === rel);
    if (!rec) { problems.push(rel + ' 不在 manifest'); return; }
    if (buf.length !== rec.bytes || sha256Buffer(buf) !== rec.sha256) {
      problems.push(rel + ' 字节/哈希不符');
    }
  };
  for (const f of manifest.files) verify(f.rel);
  for (const f of manifest.closePackage.files) verify(f.rel);
  const walk = (d, prefix) => {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name);
      const rel = (prefix ? prefix + '/' : '') + name;
      if (fs.statSync(abs).isDirectory()) { walk(abs, rel); continue; }
      if (rel === 'manifest.json') continue;
      if (!declared.has(rel)) problems.push('额外文件：' + rel);
    }
  };
  walk(dir, '');
  return {
    manifest, problems, ok: problems.length === 0,
    files: manifest.files.length, closeFiles: manifest.closePackage.files.length
  };
}

function main() {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === '--check') {
      const dir = argv[1];
      if (!dir) { console.error('用法：--check <目录>'); process.exitCode = 1; return; }
      const r = checkDir(dir);
      console.log(JSON.stringify({
        ok: r.ok, dir, window: r.manifest.window, windowNo: r.manifest.windowNo,
        synthetic: r.manifest.synthetic, businessRoundId: r.manifest.businessRoundId,
        projectId: r.manifest.projectId, files: r.files, closeFiles: r.closeFiles,
        problems: r.problems
      }, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    const windowIdx = argv.indexOf('--window');
    const planIdx = argv.indexOf('--plan');
    const outIdx = argv.indexOf('--out');
    const windowId = windowIdx !== -1 ? argv[windowIdx + 1] : null;
    const planPath = planIdx !== -1 ? argv[planIdx + 1] : null;
    const outOverride = outIdx !== -1 ? argv[outIdx + 1] : undefined;
    const result = build(windowId, planPath, outOverride);
    const reused = result.io.filter(f => f.action === 'reused').length;
    const written = result.io.filter(f => f.action === 'written').length;
    console.log(JSON.stringify({
      ok: true, outDir: result.outDir, window: result.manifest.window,
      windowNo: result.manifest.windowNo, synthetic: result.manifest.synthetic,
      businessRoundId: result.manifest.businessRoundId,
      projectId: result.manifest.projectId, actions: result.manifest.actions,
      files: result.manifest.files.length, closeFiles: result.manifest.closePackage.files.length,
      written, reused
    }, null, 2));
    console.error('提示：候选不是部署批准；synthetic 样本不代表真实人员或批准。');
  } catch (error) {
    console.error('[' + (error.code || 'BTP_ERROR') + ']', error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  ERR,
  WINDOW_ACTIONS,
  P_ACTIONS,
  E_ACTIONS,
  X_ACTIONS,
  SERVER_FILES,
  FRONTEND_FILES,
  MANIFEST_SCHEMA,
  MAX_WINDOW_MS,
  readPlan,
  build,
  checkDir,
  planDigest
});
