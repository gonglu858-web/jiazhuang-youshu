#!/usr/bin/env node
// 三账号独立业务测试包：P／E／X 三窗口候选与配对关闭包的本地生成/校验工具。
//
// 任务：docs/WorkBuddy任务-三账号独立业务测试包本地准备-20261013.md
// 方案：docs/Codex方案-独立测试项目与管家师傅业务验证-20261013.md §4
// 返修：docs/Codex审查-三账号独立业务测试包本地准备-20261014.md R1–R6
//
// R1：check 从**独立受审来源 + 目录内严格计划**重建预期制品，逐字节比对精确
//     文件集；拒绝空清单、清单同步改哈希的越界变换、模式篡改。关闭包提供
//     独立核对入口（--check-close），不依赖开启候选或其时效。
// R2：真实模式（synthetic=false）在计划读取、写前、逐次写入、最终返回、
//     check 各边界**重新读取当下时钟**；已证明到期 / 时钟无效 / 时钟抛错 /
//     窗口未开始分别以独立错误码记录；所有写入开始后的失败出口保留本次
//     written（相对路径）与 wroteFiles 事实。
// R3：全部变换与预期文件集先算完、既有目录**全量预检**（含符号链接/目录/
//     多余文件）后再开始写；新文件用排他新建（flag:'wx'），不覆盖既有字节。
// R4：组装**完整可导入候选项目**（app.js/app.json/project.config.json/
//     config/cloud.js + 唯一页面入口收窄 + 依赖闭包），页面动作选择器与
//     专用按钮按窗口收窄（唯一锚点变换）。
// R5：真实模式必须携带**可本地核对的参与者回读证据**（per-role）与
//     E/X 的 **P 项目回读证据**（绑定 roundId/projectId/marker/记录摘要）；
//     人工来源声明（source 文本）与回读证据严格区分，缺资料明确拒绝。
//     来源与证据全部计入 planDigest 稳定摘要。
// R5-a：真实模式必须读取**实际来源记录文件**并核对内容摘要、身份/角色、
//     AppID/环境、轮次/项目与持久回执绑定；kind 标签 + 64 位摘要字符串
//     不构成回读核实；记录标记为合成时不得为真实候选背书。
//
// 剩余出口返修（Codex 复查 20261014 §3）：R1-a plan.json 清单条目核对；
// R2-a check 读取边界与最终返回前重查时钟；R3-a 目录占位/多余目录预检零写、
// R3-b 输出根及祖先链接/junction 拒绝、R3-c 部分写副作用事实（竞态 EEXIST
// 不算本轮写入）；R4-a 关闭包同样受审装配变换并由 checkCloseDir 独立重建；
// R5-a 来源记录实体核对；R6-a 由新证据脚本承担（守卫基线前置、被捕获的
// 意外尝试计数、运行时实现摘要定位受测内容）。
//
// 其余约束沿用原版：只做受审变换（唯一锚点替换）、来源漂移防护、
// roundId↔projectId 绑定、配对关闭包、输出仅限 artifacts 之下、
// 不含上传/部署/安装/云端调用。

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
const MINIAPP_BASE = path.join(ROOT, 'miniapp');
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
// 前端候选文件：登记钉定 11 个 + 组装闭合所需的 app.js / app.json / config/cloud.js。
const FRONTEND_FILES = Object.freeze(registration.FRONTEND_FILES.concat(['app.js', 'app.json', 'config/cloud.js']));
const PINNED_FACTS = registration.PINNED_FACTS;

// 组装闭合所需、但不在登记钉定清单内的受审基线文件（2026-10-14 审查基线，
// 来源提交 3cbdd7f/b5aff19 工作树；逐字节钉定，源漂移即拒绝）。
const ASSEMBLY_PINNED = Object.freeze({
  'miniapp/miniprogram/app.js': Object.freeze({ bytes: 663, sha256: '26ac78fd5a7bd8f852c5c65231b4cb703b6f09e102e9b27991ac1ca1a8c3382d' }),
  'miniapp/miniprogram/app.json': Object.freeze({ bytes: 517, sha256: '7318ca539c191670b58297ba5008b5403fda5c6b91da99010c35a85434221f80' }),
  'miniapp/miniprogram/config/cloud.js': Object.freeze({ bytes: 95, sha256: '4c2a31031ed9e4df513522fdaf7163652b0bdab1896edf49361a1d109d305e93' }),
  'miniapp/project.config.json': Object.freeze({ bytes: 828, sha256: '4ed4c5556204e4bf936e9c3533013498b9f5612161f2b90faadd4c2c1b033221' })
});

const MANIFEST_SCHEMA = 'business-test-candidate/2';
const MAX_WINDOW_MS = 2 * 60 * 60 * 1000; // 单窗口操作上限 2 小时（沿用既有方案口径）
const USER_ID_RE = /^u_[0-9a-f]{40}$/;
const PROJECT_ID_RE = /^p_sbx_[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PLACEHOLDER_RE = /<[^>]{1,80}>|TODO|待填|待定|占位|PLACEHOLDER/i;
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const WINDOW_NO_RE = /^[PEX]-[0-9A-Za-z-]{1,20}$/;
const REL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

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
  MANIFEST_INVALID: 'BTP_MANIFEST_INVALID',
  CLOSE_INVALID: 'BTP_CLOSE_INVALID',
  WINDOW_EXPIRED: 'BTP_WINDOW_EXPIRED',
  WINDOW_NOT_OPEN: 'BTP_WINDOW_NOT_OPEN',
  CLOCK_INVALID: 'BTP_CLOCK_INVALID',
  CLOCK_ERROR: 'BTP_CLOCK_ERROR'
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
  if (root === 'server') return 'miniapp/cloudfunctions/scheduleSandbox/' + rel;
  if (root === 'frontend') return 'miniapp/miniprogram/' + rel;
  if (root === 'assembly') return 'miniapp/miniprogram/' + rel;
  if (root === 'root') return 'miniapp/' + rel;
  throw new Error('未知根：' + root);
}
function pinnedFor(root, rel) {
  // 组装闭合文件（app 壳等）虽挂在 frontend/root 名下，但钉定在本工具内
  const key = pinnedKeyFor(root, rel);
  return ASSEMBLY_PINNED[key] || PINNED_FACTS[key];
}
/** 相对路径安全校验（防越界/绝对路径/反斜杠）。 */
function assertSafeRel(rel) {
  if (typeof rel !== 'string' || !REL_PATH_RE.test(rel) || rel.includes('..') || rel.includes('\\')) {
    fail(ERR.MANIFEST_INVALID, '非法相对路径：' + JSON.stringify(rel));
  }
}

// ── 来源读取与漂移防护 ──────────────────────────────────────────────────────
// files：Map<`${root}/${rel}`, {buf, bytes, sha256}>（含组装闭合文件）。
function readPinnedSources() {
  const files = new Map();
  const read = (root, rel, baseDir) => {
    const buf = readSourceFile(baseDir, rel);
    const pinned = pinnedFor(root, rel);
    if (!pinned || buf.length !== pinned.bytes || sha256Buffer(buf) !== pinned.sha256) {
      fail(ERR.SOURCE_DRIFT, root + '/' + rel + ' 与受审基线不一致。');
    }
    files.set(root + '/' + rel, { buf, bytes: buf.length, sha256: sha256Buffer(buf) });
  };
  for (const rel of SERVER_FILES) read('server', rel, SERVER_BASE);
  for (const rel of FRONTEND_FILES) read('frontend', rel, FRONTEND_BASE);
  read('root', 'project.config.json', MINIAPP_BASE);
  return files;
}

// ── 计划校验（R5 严格计划：未知字段拒绝、窗口编号对应、回读证据绑定） ────────
const PLAN_FIELDS = Object.freeze([
  'schema', 'window', 'synthetic', 'businessRoundId', 'windowNo',
  'appId', 'envId', 'users', 'projectReadyMarker',
  'windowStartsAt', 'windowExpiresAt', 'projectId',
  'participantEvidence', 'projectReadback'
]);
const ROLES = Object.freeze(['owner', 'manager', 'worker']);
const EVIDENCE_KIND = 'readback-record';

/** 校验单个角色回读证据结构（真实模式必填；合成模式可选但出现即须合规）。 */
function checkEvidence(role, ev, ctx) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    fail(ERR.PLAN_USER_INVALID, role + ' 缺少回读证据对象（participantEvidence 或 users[role].sourceEvidence）。');
  }
  const keys = Object.keys(ev);
  for (const k of keys) {
    if (!['kind', 'recordSha256', 'recordPath', 'note'].includes(k)) {
      fail(ERR.PLAN_USER_INVALID, role + ' 回读证据含未知字段：' + k);
    }
  }
  if (ev.kind !== EVIDENCE_KIND) {
    fail(ERR.PLAN_USER_INVALID, role + ' 回读证据 kind 必须是 ' + EVIDENCE_KIND + '（人工声明不算回读证据）。');
  }
  if (!SHA256_RE.test(ev.recordSha256 || '')) {
    fail(ERR.PLAN_USER_INVALID, role + ' 回读证据缺少 64 位十六进制 recordSha256（来源记录文件摘要）。');
  }
  if (ev.note !== undefined && isPlaceholder(ev.note)) {
    fail(ERR.PLAN_USER_INVALID, role + ' 回读证据 note 为占位。');
  }
  const info = { kind: ev.kind, recordSha256: ev.recordSha256, recordPath: null, note: ev.note || '' };
  if (ev.recordPath !== undefined) {
    // R5-a：实际读取来源记录并核对内容摘要与绑定（两种模式一致；真实模式必查）
    const r = verifyEvidenceRecord(role + ' 回读记录', ERR.PLAN_USER_INVALID, ev.recordPath,
      ev.recordSha256, ctx.baseDir, {
        schema: 'business-test-participant-record/1',
        subject: { role, userId: ctx.userId },
        businessRoundId: ctx.businessRoundId,
        requireReceipt: false
      });
    info.recordPath = r.abs;
  } else if (!ctx.synthetic) {
    fail(ERR.PLAN_USER_INVALID,
      role + ' 真实候选必须提供可本地核对的来源记录文件（recordPath）；' +
      '64 位摘要字符串或 kind 标签不等于已核对记录。');
  }
  return info;
}

/**
 * R5-a：读取并核对一份来源记录文件（participant / project-readback 通用）。
 * 核对：文件存在且为普通文件；内容 SHA-256 与声明一致；JSON 结构与未知字段；
 * 记录未标记合成；AppID/环境、轮次、身份/角色/项目绑定与计划一致；非占位正文。
 */
function verifyEvidenceRecord(label, errCode, recordPath, expectSha, baseDir, bind) {
  if (typeof recordPath !== 'string' || !recordPath.trim()) {
    fail(errCode, label + ' 缺少可本地核对的来源记录文件路径（recordPath）。');
  }
  const abs = path.isAbsolute(recordPath) ? path.resolve(recordPath) : path.resolve(baseDir, recordPath);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (_) { st = null; }
  if (!st || !st.isFile()) fail(errCode, label + ' 来源记录文件不存在或不是普通文件：' + abs);
  const buf = fs.readFileSync(abs);
  if (sha256Buffer(buf) !== expectSha) {
    fail(errCode, label + ' 来源记录内容摘要与声明 recordSha256 不一致（自报摘要不等于已核对记录）。');
  }
  let rec;
  try { rec = JSON.parse(buf.toString('utf8')); } catch (error) {
    fail(errCode, label + ' 来源记录不是合法 JSON：' + error.message);
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    fail(errCode, label + ' 来源记录必须是 JSON 对象。');
  }
  const allowed = ['schema', 'synthetic', 'appId', 'envId', 'businessRoundId',
    'subject', 'projectId', 'projectReadyMarker', 'capturedAt', 'content', 'persistentReceipt', 'note'];
  for (const k of Object.keys(rec)) {
    if (!allowed.includes(k)) fail(errCode, label + ' 来源记录含未知字段：' + k);
  }
  if (rec.schema !== bind.schema) {
    fail(errCode, label + ' 来源记录 schema 必须是 ' + bind.schema + '。');
  }
  if (rec.synthetic !== false) {
    fail(errCode, label + ' 来源记录标记为合成或未声明真实，不能为真实候选背书。');
  }
  if (rec.appId !== FIXED_TARGET.appId || rec.envId !== FIXED_TARGET.envId) {
    fail(errCode, label + ' 来源记录 AppID/环境与受审固定目标不一致。');
  }
  if (rec.businessRoundId !== bind.businessRoundId) {
    fail(errCode, label + ' 来源记录轮次与计划 businessRoundId 不一致。');
  }
  const subject = rec.subject || {};
  for (const k of Object.keys(subject)) {
    if (!['role', 'userId'].includes(k)) fail(errCode, label + ' subject 含未知字段：' + k);
  }
  if (subject.role !== bind.subject.role || subject.userId !== bind.subject.userId) {
    fail(errCode, label + ' 来源记录身份/角色（' + JSON.stringify(subject) +
      '）与计划绑定（' + JSON.stringify(bind.subject) + '）不一致。');
  }
  if (bind.projectId !== undefined && rec.projectId !== bind.projectId) {
    fail(errCode, label + ' 来源记录 projectId 与计划不一致。');
  }
  if (bind.projectReadyMarker !== undefined && rec.projectReadyMarker !== bind.projectReadyMarker) {
    fail(errCode, label + ' 来源记录 projectReadyMarker 与计划持久标记不一致。');
  }
  if (typeof rec.capturedAt !== 'string' || !Number.isFinite(Date.parse(rec.capturedAt))) {
    fail(errCode, label + ' 来源记录缺少有效 capturedAt。');
  }
  if (isPlaceholder(rec.content)) {
    fail(errCode, label + ' 来源记录缺少非占位回读正文（content）。');
  }
  if (rec.persistentReceipt !== undefined) {
    const pr = rec.persistentReceipt;
    if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
      fail(errCode, label + ' persistentReceipt 必须是对象。');
    }
    for (const k of Object.keys(pr)) {
      if (!['recordId', 'note'].includes(k)) fail(errCode, label + ' persistentReceipt 含未知字段：' + k);
    }
    if (typeof pr.recordId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{5,}$/.test(pr.recordId)) {
      fail(errCode, label + ' persistentReceipt.recordId 缺失或格式无效（project-guard 业务项目记录回执编号）。');
    }
  } else if (bind.requireReceipt) {
    fail(errCode, label + ' 缺少持久回执关联（persistentReceipt.recordId）。');
  }
  return { abs, rec };
}

/** 校验 E/X 的 P 项目回读证据（绑定 roundId/projectId/marker/记录摘要 + 实体记录核对）。 */
function checkProjectReadback(raw, projectId, ctx) {
  const rb = raw.projectReadback;
  if (!rb || typeof rb !== 'object' || Array.isArray(rb)) {
    fail(ERR.PLAN_PROJECT_INVALID, 'E/X 计划缺少 projectReadback（P 项目回读证据）；ID 公式推算不等于已回读。');
  }
  for (const k of Object.keys(rb)) {
    if (!['source', 'projectId', 'businessRoundId', 'projectReadyMarker', 'recordSha256', 'recordPath', 'note'].includes(k)) {
      fail(ERR.PLAN_PROJECT_INVALID, 'projectReadback 含未知字段：' + k);
    }
  }
  if (rb.source !== 'readback') {
    fail(ERR.PLAN_PROJECT_INVALID, 'projectReadback.source 必须是 "readback"（人工说明不算回读证据）。');
  }
  if (rb.projectId !== projectId) {
    fail(ERR.PLAN_PROJECT_INVALID, 'projectReadback.projectId 与计划 projectId 不一致。');
  }
  if (rb.businessRoundId !== raw.businessRoundId) {
    fail(ERR.PLAN_PROJECT_INVALID, 'projectReadback.businessRoundId 与计划轮次不一致。');
  }
  if (rb.projectReadyMarker !== raw.projectReadyMarker) {
    fail(ERR.PLAN_PROJECT_INVALID, 'projectReadback.projectReadyMarker 与计划持久标记不一致。');
  }
  if (!SHA256_RE.test(rb.recordSha256 || '')) {
    fail(ERR.PLAN_PROJECT_INVALID, 'projectReadback 缺少 64 位十六进制 recordSha256（P 回读记录摘要）。');
  }
  if (rb.note !== undefined && isPlaceholder(rb.note)) {
    fail(ERR.PLAN_PROJECT_INVALID, 'projectReadback.note 为占位。');
  }
  const info = {
    source: rb.source, projectId: rb.projectId, businessRoundId: rb.businessRoundId,
    projectReadyMarker: rb.projectReadyMarker, recordSha256: rb.recordSha256,
    recordPath: null, note: rb.note || ''
  };
  if (rb.recordPath !== undefined) {
    // R5-a：实际核对 P 项目回读记录（内容摘要、AppID/环境、轮次/项目/标记、持久回执）
    const r = verifyEvidenceRecord('P 项目回读记录', ERR.PLAN_PROJECT_INVALID, rb.recordPath,
      rb.recordSha256, ctx.baseDir, {
        schema: 'business-test-project-readback-record/1',
        subject: { role: 'owner', userId: ctx.ownerUserId },
        businessRoundId: raw.businessRoundId,
        projectId,
        projectReadyMarker: raw.projectReadyMarker,
        requireReceipt: true
      });
    info.recordPath = r.abs;
  } else if (!raw.synthetic) {
    fail(ERR.PLAN_PROJECT_INVALID,
      '真实候选必须提供可本地核对的 P 项目回读记录文件（recordPath）；' +
      '项目 ID 公式与自报摘要不等于已核对记录。');
  }
  return info;
}

function readPlan(planPath, windowId) {
  if (typeof planPath !== 'string' || !planPath) fail(ERR.PLAN_INVALID, '缺少 --plan 计划文件。');
  if (!['P', 'E', 'X'].includes(windowId)) fail(ERR.PLAN_INVALID, '--window 必须是 P/E/X。');
  const raw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  if (raw.schema !== 'business-test-plan/1') fail(ERR.PLAN_INVALID, '计划 schema 必须是 business-test-plan/1。');
  // 未知顶层字段拒绝（严格计划校验）
  for (const k of Object.keys(raw)) {
    if (!PLAN_FIELDS.includes(k)) fail(ERR.PLAN_INVALID, '计划含未知字段：' + k);
  }
  if (raw.window !== windowId) fail(ERR.PLAN_INVALID, '计划 window 与 --window 不一致。');
  if (typeof raw.synthetic !== 'boolean') fail(ERR.PLAN_INVALID, '计划缺少 synthetic 布尔字段。');
  if (typeof raw.businessRoundId !== 'string' || !ROUND_ID_RE.test(raw.businessRoundId)) {
    fail(ERR.PLAN_INVALID, 'businessRoundId 须为 4–64 位字母数字-_，且不以符号开头。');
  }
  if (typeof raw.windowNo !== 'string' || !WINDOW_NO_RE.test(raw.windowNo)) {
    fail(ERR.PLAN_INVALID, 'windowNo 须形如 P-01 / E-01 / X-01。');
  }
  if (!raw.windowNo.startsWith(windowId + '-')) {
    fail(ERR.PLAN_INVALID, 'windowNo 必须以窗口号 ' + windowId + '- 开头。');
  }
  for (const k of ['appId', 'envId']) {
    if (raw[k] !== FIXED_TARGET[k]) fail(ERR.PLAN_INVALID, k + ' 必须是受审固定值。');
  }
  // 用户：恰三个角色、无多余键、各带完整 userId 与非占位来源声明
  const users = raw.users || {};
  for (const k of Object.keys(users)) {
    if (!ROLES.includes(k)) fail(ERR.PLAN_USER_INVALID, 'users 含未知角色：' + k);
  }
  for (const role of ROLES) {
    const u = users[role];
    if (!u || !USER_ID_RE.test(u.userId || '')) {
      fail(ERR.PLAN_USER_INVALID, role + ' 缺少完整 userId（u_ + 40 位十六进制）。');
    }
    if (isPlaceholder(u.source)) {
      fail(ERR.PLAN_USER_INVALID, role + ' 缺少来源说明（人工声明；不得为占位）。');
    }
  }
  const ids = ROLES.map(r => users[r].userId);
  if (new Set(ids).size !== 3) fail(ERR.PLAN_USER_INVALID, '三个账号必须互不相同。');
  // 回读证据（R5）：真实模式必填且必须附实际记录文件；合成模式可选但出现即须合规
  const evidenceCtx = {
    synthetic: raw.synthetic,
    baseDir: path.dirname(path.resolve(planPath)),
    businessRoundId: raw.businessRoundId
  };
  let evidenceBound = false;
  const evidence = {};
  for (const role of ROLES) {
    const ev = users[role].sourceEvidence
      || (raw.participantEvidence && raw.participantEvidence[role]);
    if (ev) {
      evidence[role] = checkEvidence(role, ev, { ...evidenceCtx, userId: users[role].userId });
      evidenceBound = true;
    } else if (!raw.synthetic) {
      fail(ERR.PLAN_USER_INVALID, role + ' 真实候选缺少可核对的回读证据；非空来源声明不等于来源核实。');
    }
  }
  // 窗口时效（此处为首次读取时钟；build/check/写入各边界另行重读）
  const starts = Date.parse(raw.windowStartsAt);
  const expires = Date.parse(raw.windowExpiresAt);
  if (!Number.isFinite(starts) || !Number.isFinite(expires) || expires <= starts) {
    fail(ERR.PLAN_WINDOW_INVALID, '窗口时间无效。');
  }
  if (expires - starts > MAX_WINDOW_MS) fail(ERR.PLAN_WINDOW_INVALID, '窗口超过 2 小时上限。');
  // 标记
  if (isPlaceholder(raw.projectReadyMarker)) {
    fail(ERR.PLAN_INVALID, '缺少 projectReadyMarker（本轮项目持久标记配置）。');
  }
  if (raw.projectReadyMarker.length > 128) fail(ERR.PLAN_INVALID, 'projectReadyMarker 过长。');
  // projectId：P 为空；E/X 必填、与 roundId 确定性绑定、非受保护、且须带 P 回读证据
  let projectId = '';
  let projectReadback = null;
  if (windowId === 'P') {
    if (raw.projectId) fail(ERR.PLAN_PROJECT_INVALID, 'P 窗口建项目前不得预填 projectId。');
    if (raw.projectReadback) fail(ERR.PLAN_PROJECT_INVALID, 'P 窗口建项目前不得携带 projectReadback。');
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
    // P 项目回读证据：真实模式必填且必须附实际记录文件；合成模式可选但出现即须绑定一致
    if (!raw.synthetic || raw.projectReadback) {
      projectReadback = checkProjectReadback(raw, projectId, {
        ...evidenceCtx,
        ownerUserId: users.owner.userId
      });
    }
  }
  return Object.freeze({
    window: windowId,
    synthetic: raw.synthetic,
    businessRoundId: raw.businessRoundId,
    windowNo: raw.windowNo,
    appId: FIXED_TARGET.appId,
    envId: FIXED_TARGET.envId,
    allowedUserIds: Object.freeze(ids),
    users: Object.freeze(ROLES.map(r => Object.freeze({
      role: r, userId: users[r].userId, source: String(users[r].source || ''),
      evidence: evidence[r] || null
    }))),
    evidenceBound,
    projectId,
    projectReadback: projectReadback ? Object.freeze(projectReadback) : null,
    projectReadyMarker: String(raw.projectReadyMarker),
    windowStartsAt: new Date(starts).toISOString(),
    windowExpiresAt: new Date(expires).toISOString(),
    actions: WINDOW_ACTIONS[windowId]
  });
}

// ── R2 时钟守卫：真实模式各边界重读当下时钟；时钟异常与到期分别记录 ─────────
function windowClockCheck(plan, at) {
  if (plan.synthetic) return; // 合成模式不做平台时效守卫（计划时间可为任意合成值）
  let now;
  try {
    now = Date.now();
  } catch (error) {
    fail(ERR.CLOCK_ERROR, '[' + at + '] 当下时钟读取抛错，真实候选停止：' + error.message);
  }
  if (!Number.isFinite(now)) {
    fail(ERR.CLOCK_INVALID, '[' + at + '] 当下时钟无效（非有限数值），真实候选停止。');
  }
  const expires = Date.parse(plan.windowExpiresAt);
  if (expires <= now) {
    fail(ERR.WINDOW_EXPIRED, '[' + at + '] 真实窗口已到期（expiresAt <= 当下时钟），候选停止。');
  }
  const starts = Date.parse(plan.windowStartsAt);
  if (starts > now) {
    fail(ERR.WINDOW_NOT_OPEN, '[' + at + '] 真实窗口尚未开始（startsAt > 当下时钟），候选停止。');
  }
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

// ── 页面动作选择器与专用按钮收窄（R4：页面与服务端各自受限） ────────────────
// 源页面（受审基线）的固定清单；锚点必须与源逐字符一致。
const PAGE_TEST_CASES_ANCHOR = [
  '/** 专用卡片按钮：固定五个用例，不加入普通动作选择器。 */',
  'const TEST_CASE_LABELS = Object.freeze([',
  "  { id: 'V06-a', label: '并发幂等（两次同号新增）' },",
  "  { id: 'V06-b', label: '占用冲突（不同号同工种同日）' },",
  "  { id: 'V06-c', label: '版本冲突（同版本两份内容）' },",
  "  { id: 'V07-A', label: '移出：有未完成安排（应拒绝）' },",
  "  { id: 'V07-B', label: '移出：任务已清空（应成功）' }",
  ']);'
].join('\n');
const PAGE_TEST_CASES_X = [
  '/** 专用卡片按钮：X 窗口收窄——仅 V07-A/B 两次移出用例；V06 并发不随候选开放。 */',
  'const TEST_CASE_LABELS = Object.freeze([',
  "  { id: 'V07-A', label: '移出：有未完成安排（应拒绝）' },",
  "  { id: 'V07-B', label: '移出：任务已清空（应成功）' }",
  ']);'
].join('\n');
const PAGE_ACTION_ENTRIES = Object.freeze([
  { key: 'identify', label: '身份登记', phase: 'prepare' },
  { key: 'requestBindingNumber', label: '取绑定编号', phase: 'prepare' },
  { key: 'createProject', label: '建立本轮测试项目', phase: 'prepare' },
  { key: 'assignManager', label: '指定管家（填绑定编号）', phase: 'prepare' },
  { key: 'createInvitation', label: '发出邀请（填角色与工种）', phase: 'prepare' },
  { key: 'applyInvitation', label: '申请加入（填邀请码）', phase: 'prepare' },
  { key: 'approveInvitation', label: '批准加入（填邀请编号与申请者编号）', phase: 'prepare' },
  { key: 'getMembers', label: '核对成员', phase: 'prepare' },
  { key: 'listInvitations', label: '核对邀请', phase: 'prepare' },
  { key: 'createSchedule', label: '新增施工安排', phase: 'execute' },
  { key: 'updateSchedule', label: '调整施工安排（填编号与版本）', phase: 'execute' },
  { key: 'reassignSchedule', label: '改派施工安排（填编号与版本）', phase: 'execute' },
  { key: 'cancelSchedule', label: '取消施工安排（填编号与版本）', phase: 'execute' },
  { key: 'listSchedules', label: '查看安排列表', phase: 'execute' },
  { key: 'getSchedule', label: '查看单条安排（填编号）', phase: 'execute' },
  { key: 'listScheduleRevisions', label: '查看变更历史（填编号）', phase: 'execute' },
  { key: 'getScheduleContext', label: '查看施工上下文', phase: 'execute' }
]);
const PAGE_ACTIONS_ANCHOR = 'const ACTIONS = [\n' + PAGE_ACTION_ENTRIES
  .map((e, i) => `  { key: '${e.key}', label: '${e.label}', phase: '${e.phase}' }${i === PAGE_ACTION_ENTRIES.length - 1 ? '' : ','}`)
  .join('\n') + '\n];';

function buildPageTransforms(plan) {
  const t = [];
  const push = (label, from, to) => t.push(
    { root: 'frontend', file: 'pages/schedule-sandbox/schedule-sandbox.js', from, to, label });
  // 1) 普通动作选择器收窄：仅保留窗口允许且页面原有条目（不新增动作）
  const kept = PAGE_ACTION_ENTRIES.filter(e => plan.actions.includes(e.key));
  if (kept.length === 0) fail(ERR.PLAN_INVALID, '窗口动作与页面清单无交集。');
  const toActions = 'const ACTIONS = [\n' + kept
    .map((e, i) => `  { key: '${e.key}', label: '${e.label}', phase: '${e.phase}' }${i === kept.length - 1 ? '' : ','}`)
    .join('\n') + '\n];';
  push('page.ACTIONS', PAGE_ACTIONS_ANCHOR, toActions);
  // 2) X 窗口：专用按钮收窄为 V07-A/B（V06 按钮不显示；绕过 UI 仍被驱动零发送拒绝）
  if (plan.window === 'X') {
    push('page.TEST_CASE_LABELS', PAGE_TEST_CASES_ANCHOR, PAGE_TEST_CASES_X);
  }
  return t;
}

// ── 完整项目组装（R4：app 壳 + 唯一页面入口 + 固定目标） ────────────────────
const APP_JSON_PAGES_ANCHOR = [
  '  "pages": [',
  '    "pages/index/index",',
  '    "pages/project/project",',
  '    "pages/schedule/schedule",',
  '    "pages/schedule-detail/schedule-detail",',
  '    "pages/record/record",',
  '    "pages/members/members",',
  '    "pages/access/access",',
  '    "pages/permission-check/permission-check",',
  '    "pages/schedule-sandbox/schedule-sandbox"',
  '  ],'
].join('\n');

function buildAssemblyTransforms(plan) {
  const t = [];
  // app.json：唯一页面入口收窄（仅施工安排独立测试副本页）。JSON 不加注释。
  // 注：app.json 属于前端候选文件（FRONTEND_FILES），root 为 frontend。
  t.push({
    root: 'frontend', file: 'app.json', label: 'app.json.pages',
    from: APP_JSON_PAGES_ANCHOR,
    to: '  "pages": [\n    "pages/schedule-sandbox/schedule-sandbox"\n  ],'
  });
  // project.config.json：候选根指向 frontend/server 固定目标
  const push = (label, from, to) => t.push({ root: 'root', file: 'project.config.json', from, to, label });
  push('project.config.miniprogramRoot',
    '  "miniprogramRoot": "miniprogram/",', '  "miniprogramRoot": "frontend/",');
  push('project.config.cloudfunctionRoot',
    '  "cloudfunctionRoot": "cloudfunctions/",', '  "cloudfunctionRoot": "server/",');
  push('project.config.projectname',
    '  "projectname": "装修进度验收-开发",',
    `  "projectname": ${js('三账号独立业务测试候选-' + plan.windowNo + (plan.synthetic ? '-synthetic' : ''))},`);
  return t;
}

function buildTransforms(plan) {
  const t = [
    buildIndexTransform(plan),
    buildGateTransform(plan),
    ...buildProofTransforms(plan),
    ...buildPageTransforms(plan),
    ...buildAssemblyTransforms(plan)
  ];
  if (plan.window === 'X') t.push(...buildDriverTransforms(plan));
  return t;
}

function applyFileTransforms(files, root, rel, transforms) {
  const ts = transforms.filter(x => x.root === root && x.file === rel);
  const src = files.get(root + '/' + rel);
  if (!src) fail(ERR.SOURCE_MISSING, root + '/' + rel);
  const approved = pinnedFor(root, rel);
  if (!approved || src.sha256 !== approved.sha256) fail(ERR.SOURCE_DRIFT, root + '/' + rel + ' 来源漂移。');
  if (ts.length === 0) {
    return { buf: src.buf, bytes: src.bytes, sha256: src.sha256, sourceSha256: src.sha256, steps: [] };
  }
  const sourceSha256 = src.sha256;
  let cur = { buf: src.buf, bytes: src.bytes, sha256: src.sha256 };
  const steps = [];
  for (const t of ts) {
    const text = cur.buf.toString('utf8');
    // 锚点行尾自适应：源为 CRLF 时把 \n 锚点按 CRLF 匹配/替换，产物保持源行尾风格
    const crlf = text.includes('\r\n') && !t.from.includes('\r');
    const from = crlf ? t.from.replaceAll('\n', '\r\n') : t.from;
    const to = crlf ? t.to.replaceAll('\n', '\r\n') : t.to;
    const n = countOccurrences(text, from);
    if (n === 0) fail(ERR.TRANSFORM_ANCHOR_MISSING, root + '/' + rel + '：' + t.label);
    if (n !== 1) fail(ERR.TRANSFORM_ANCHOR_AMBIGUOUS, root + '/' + rel + '：' + t.label);
    const at = text.indexOf(from);
    const buf = Buffer.from(text.slice(0, at) + to + text.slice(at + from.length));
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

// ── 计划摘要（R5：来源与证据一并纳入稳定摘要） ──────────────────────────────
function planDigest(plan) {
  const canon = JSON.stringify({
    schema: 'business-test-plan/1',
    w: plan.window, r: plan.businessRoundId, n: plan.windowNo,
    a: [plan.appId, plan.envId],
    u: plan.users.map(u => ({ role: u.role, userId: u.userId, source: u.source, evidence: u.evidence })),
    p: plan.projectId, rb: plan.projectReadback,
    e: plan.windowExpiresAt, s0: plan.windowStartsAt,
    m: plan.projectReadyMarker, s: plan.synthetic
  });
  return sha256Buffer(Buffer.from(canon));
}

// ── R3：全量预检 + 排他新建 ─────────────────────────────────────────────────
/**
 * 递归枚举 dir 下现有条目（rel 用 '/'）。目录与符号链接本身也登记，
 * 预检可见目录占位/多余目录/链接（R3-a）。dir 本身不存在时返回空表。
 */
function listExisting(dir) {
  const out = new Map(); // rel -> {abs, isSymlink, isDir, isFile}
  const walk = d => {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) { out.set(rel, { abs, isSymlink: true, isDir: false, isFile: false }); continue; }
      if (st.isDirectory()) { out.set(rel, { abs, isSymlink: false, isDir: true, isFile: false }); walk(abs); continue; }
      out.set(rel, { abs, isSymlink: false, isDir: false, isFile: st.isFile() });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const isExpectedPrefix = (rel, expectedKeys) =>
  expectedKeys.some(k => k.startsWith(rel + '/'));

/**
 * R3-b：输出根及其祖先链的实际文件系统核对——每一层存在则必须是真实目录
 * 且不是符号链接/junction（junction 在 lstat 下即符号链接），拒绝借链接
 * 绕过输出边界；不跟随链接、不清理任何目录。不存在的前缀层交由后续创建。
 */
function assertRealDirChain(target, label) {
  const chain = [];
  let cur = path.resolve(target);
  for (;;) {
    chain.push(cur);
    if (cur === ROOT || chain.length > 64) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
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

/**
 * 全量预检：既有文件必须属于预期集、内容逐字节一致；目录占位（含目录冒名
 * 预期文件）、多余目录、符号链接一律冲突。**预检阶段零写入**——预存冲突
 * 目录全树快照保持不变。
 */
function precheckOutDir(outDir, expected) {
  const io = [];
  const existing = listExisting(outDir);
  const expectedKeys = [...expected.keys()];
  for (const [rel, info] of existing) {
    if (info.isSymlink) fail(ERR.OUT_CONFLICT, '输出位置存在符号链接/junction，不跟随、不覆盖：' + rel);
    if (info.isDir) {
      if (!isExpectedPrefix(rel, expectedKeys)) {
        fail(ERR.OUT_CONFLICT, '输出位置存在目录占位/多余目录（不清理、不覆盖）：' + rel);
      }
      continue;
    }
    if (!info.isFile) fail(ERR.OUT_CONFLICT, '输出位置存在非常规文件系统对象：' + rel);
    if (!expected.has(rel)) fail(ERR.OUT_CONFLICT, '输出目录已存在不属于本计划的文件：' + rel);
    const current = fs.readFileSync(info.abs);
    if (!current.equals(expected.get(rel))) {
      fail(ERR.OUT_CONFLICT, '已存在内容不同的文件，不覆盖：' + rel);
    }
    io.push({ path: info.abs, rel, action: 'reused' });
  }
  return io;
}

/**
 * 排他新建：预检确认缺失后仍用 flag:'wx'，竞态下宁可失败不覆盖。
 * R3-c：副作用事实——已独占创建但写入失败（部分写/完整写后报错）的文件
 * 记入 io（partial 标记）；竞态 EEXIST 的他人文件不算本轮写入，也不覆盖/
 * 删除解决冲突。
 */
function writeExclusive(abs, buf, io, rel) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.writeFileSync(abs, buf, { flag: 'wx' });
    io.push({ path: abs, rel, action: 'written', partial: false });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      // 他人（或并发进程）抢先创建：不是本轮写入，不覆盖、不删除。
      error.sideEffect = 'EEXIST:目标已被他人创建，未计入本轮写入，未覆盖未删除';
      throw error;
    }
    let st = null;
    try { st = fs.lstatSync(abs); } catch (_) { st = null; }
    if (st && st.isFile()) {
      // 本次排他创建已生效但写入失败：磁盘留下本轮创建的（部分）文件，如实记录
      io.push({ path: abs, rel, action: 'written', partial: true, bytesOnDisk: st.size });
    }
    throw error;
  }
}

// ── 组装与写出 ──────────────────────────────────────────────────────────────
/** 计算某窗口全部预期制品（23 个：8 服务端 + 14 前端 + 根 project.config.json）。 */
function computeArtifacts(plan, files, transforms) {
  const artifacts = new Map(); // rel('/'分隔) -> {buf, bytes, sha256, sourceSha256, steps}
  const push = (rel, r) => artifacts.set(rel, r);
  for (const rel of SERVER_FILES) {
    push('server/' + rel, applyFileTransforms(files, 'server', rel, transforms));
  }
  for (const rel of FRONTEND_FILES) {
    push('frontend/' + rel, applyFileTransforms(files, 'frontend', rel, transforms));
  }
  push('project.config.json', applyFileTransforms(files, 'root', 'project.config.json', transforms));
  return artifacts;
}

/** 关闭包条目：受审**装配变换**（正确根路径 + 唯一关闭页面；服务端/前端开关保持默认关闭）。 */
const CLOSE_ASSEMBLY_TRANSFORMS = Object.freeze([
  {
    root: 'frontend', file: 'app.json', label: 'app.json.pages',
    from: APP_JSON_PAGES_ANCHOR,
    to: '  "pages": [\n    "pages/schedule-sandbox/schedule-sandbox"\n  ],'
  },
  {
    root: 'root', file: 'project.config.json', label: 'project.config.miniprogramRoot',
    from: '  "miniprogramRoot": "miniprogram/",', to: '  "miniprogramRoot": "frontend/",'
  },
  {
    root: 'root', file: 'project.config.json', label: 'project.config.cloudfunctionRoot',
    from: '  "cloudfunctionRoot": "cloudfunctions/",', to: '  "cloudfunctionRoot": "server/",'
  }
]);

function computeCloseArtifacts(files) {
  const close = new Map();
  for (const rel of SERVER_FILES) {
    close.set('close/server/' + rel, applyFileTransforms(files, 'server', rel, []));
  }
  for (const rel of FRONTEND_FILES) {
    close.set('close/frontend/' + rel, applyFileTransforms(files, 'frontend', rel, CLOSE_ASSEMBLY_TRANSFORMS));
  }
  close.set('close/project.config.json', applyFileTransforms(files, 'root', 'project.config.json', CLOSE_ASSEMBLY_TRANSFORMS));
  return close;
}

function build(windowId, planPath, outOverride) {
  const plan = readPlan(planPath, windowId);
  windowClockCheck(plan, 'build.readPlan');
  const files = readPinnedSources();
  const transforms = buildTransforms(plan);
  const digest = planDigest(plan);
  const outDir = outOverride
    ? path.resolve(outOverride)
    : path.join(OUT_ROOT, plan.window.toLowerCase() + '-' + digest.slice(0, 12));
  if (!outDir.startsWith(OUT_ROOT + path.sep)) {
    fail(ERR.OUT_CONFLICT, '输出目录必须位于 ' + OUT_ROOT + ' 之下。');
  }
  // R3-b：输出根及相关祖先的实际路径/链接边界（junction/symlink 绕过即拒绝）
  assertRealDirChain(outDir, 'build 输出');
  const io = [];
  try {
    // ── 全部变换与预期文件集先算完（未写盘）──
    const artifacts = computeArtifacts(plan, files, transforms);
    const closeArtifacts = computeCloseArtifacts(files);
    const planBytes = fs.readFileSync(planPath);
    const entries = [];
    const closeEntries = [];
    for (const [rel, a] of artifacts) {
      entries.push({
        rel, bytes: a.bytes, sha256: a.sha256,
        sourceSha256: a.sourceSha256 === a.sha256 ? null : a.sourceSha256,
        transform: a.steps.length ? a.steps.map(s => s.label) : null,
        transformSteps: a.steps.length ? a.steps : null
      });
    }
    for (const [rel, a] of closeArtifacts) {
      closeEntries.push({ rel, bytes: a.bytes, sha256: a.sha256 });
    }
    entries.push({
      rel: 'plan.json', bytes: planBytes.length, sha256: sha256Buffer(planBytes),
      sourceSha256: null, transform: null, transformSteps: null
    });
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
      userSourceBinding: plan.synthetic
        ? 'synthetic-declaration-only：账号为合成值，仅人工声明来源，不代表真实人员或批准。'
        : 'readback-records-verified：三账号与 P 项目回读记录文件已本地逐条核对（内容摘要、身份/角色、AppID/环境、轮次/项目与持久回执绑定一致）；本地核对不替代平台侧核验。',
      userSources: plan.users.map(u => ({
        role: u.role, userIdTail: u.userId.slice(-6), source: u.source,
        evidence: u.evidence ? { kind: u.evidence.kind, recordSha256: u.evidence.recordSha256 } : null
      })),
      projectReadback: plan.projectReadback,
      planFile: 'plan.json',
      planSha256: sha256Buffer(planBytes),
      planDigest: digest,
      actions: plan.actions,
      transforms: transforms.map(t => ({
        root: t.root, file: t.file, label: t.label,
        fromSha: sha256Buffer(Buffer.from(t.from)),
        toSha: sha256Buffer(Buffer.from(t.to))
      })),
      files: entries,
      closePackage: {
        note: '配对关闭包：受审装配变换（正确根路径 + 唯一关闭页面）；服务端/前端开关保持默认关闭，原门槛不变；可用 --check-close 独立重建核对，不受开启候选或窗口时效影响。',
        files: closeEntries
      },
      boundaries: [
        '候选不是部署批准；不含任何真实批准或自动延期。',
        '服务端依赖安装、完整构建、平台部署与真实调用未验证。',
        'synthetic 样本不构成真实批准；real 候选须以参与者来源回读证据为前提。',
        'project-guard 创建业务项目记录不等于创建数据库或集合；集合初始化未执行。'
      ]
    };
    // ── 预期完整文件集（制品 + plan.json + manifest.json）──
    const expected = new Map();
    for (const [rel, a] of artifacts) expected.set(rel, a.buf);
    for (const [rel, a] of closeArtifacts) expected.set(rel, a.buf);
    expected.set('plan.json', planBytes);
    expected.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    // ── R2 写前时钟守卫 ──
    windowClockCheck(plan, 'build.precheck');
    // ── R3 全量预检（零写入）──
    const reusedRels = new Set();
    for (const r of precheckOutDir(outDir, expected)) {
      io.push({ path: r.path, action: 'reused' });
      reusedRels.add(r.rel);
    }
    // ── 排他新建缺失文件（每次写前重读时钟；副作用事实由 writeExclusive 记入 io）──
    for (const [rel, buf] of expected) {
      if (reusedRels.has(rel)) continue;
      windowClockCheck(plan, 'build.write:' + rel);
      writeExclusive(path.join(outDir, rel), buf, io, rel);
    }
    // ── R2 最终返回前时钟守卫 ──
    windowClockCheck(plan, 'build.final');
    return { outDir, manifest, io };
  } catch (error) {
    // R2/R3：写入开始后的所有失败出口保留准确已写事实（不统称零写）
    const written = io.filter(x => x.action === 'written')
      .map(x => path.relative(outDir, x.path).split(path.sep).join('/'));
    if (written.length) {
      error.written = written;
      error.wroteFiles = written.length;
      error.writtenFacts = { outDir: path.relative(ROOT, outDir).split(path.sep).join('/'), note: '以上为本次实际新写的文件；既有不同字节未被覆盖。' };
    }
    throw error;
  }
}

// ── R1：check 从独立受审来源 + 目录内严格计划重建预期制品 ───────────────────
function checkDir(dir) {
  // R3-b：检查入口不得认领符号链接/junction 绕过输出边界的目录
  assertRealDirChain(dir, 'check 输入');
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(ERR.MANIFEST_INVALID, 'manifest.json 无法读取（缺失或目录占位等）：' + error.message);
  }
  if (manifest.schema !== MANIFEST_SCHEMA) fail(ERR.MANIFEST_INVALID, 'manifest schema 不符（须 ' + MANIFEST_SCHEMA + '）。');
  const problems = [];
  const bad = msg => problems.push(msg);
  // R2-a：check 各读取边界与最终成功返回前都重查当下时钟（中途到期/NaN/抛错均不得带成功结论）
  let plan = null;
  let clockStopped = false;
  const clockCheck = at => {
    if (!plan || clockStopped) return;
    try {
      windowClockCheck(plan, at);
    } catch (error) {
      bad('窗口时效检查失败[' + (error.code || 'BTP_ERROR') + ']（' + at + '）：' + error.message);
      clockStopped = true;
    }
  };
  // 1) 目录内严格计划：plan.json 必须存在且与 manifest.planSha256 一致
  const planPath = path.join(dir, manifest.planFile || 'plan.json');
  if (!fs.existsSync(planPath)) { bad('缺少目录内计划 plan.json'); return finish(); }
  const planBytes = fs.readFileSync(planPath);
  if (manifest.planSha256 !== sha256Buffer(planBytes)) { bad('plan.json 与 manifest.planSha256 不一致'); return finish(); }
  // 2) 重新执行严格计划校验（真实模式在此重读当下时钟，过期即失败）
  try {
    plan = readPlan(planPath, manifest.window);
  } catch (error) {
    bad('计划校验失败[' + (error.code || 'BTP_ERROR') + ']：' + error.message);
    return finish();
  }
  clockCheck('check.start');
  if (clockStopped) return finish();
  // 3) 计划摘要一致（来源与证据计入摘要）
  if (planDigest(plan) !== manifest.planDigest) bad('planDigest 与目录内计划重算不一致');
  // 4) manifest 核心字段与计划一致（模式/账号/动作/窗口不可被清单侧篡改）
  const expectFields = {
    windowNo: plan.windowNo, synthetic: plan.synthetic,
    businessRoundId: plan.businessRoundId, projectId: plan.projectId || null,
    projectReadyMarker: plan.projectReadyMarker,
    windowStartsAt: plan.windowStartsAt, windowExpiresAt: plan.windowExpiresAt
  };
  for (const [k, v] of Object.entries(expectFields)) {
    if (JSON.stringify(manifest[k]) !== JSON.stringify(v)) bad('manifest.' + k + ' 与计划不一致');
  }
  if (JSON.stringify(manifest.allowedUserIds) !== JSON.stringify(plan.allowedUserIds)) bad('manifest.allowedUserIds 与计划不一致');
  if (JSON.stringify(manifest.actions) !== JSON.stringify(plan.actions)) bad('manifest.actions 与计划不一致');
  const expectUserSources = plan.users.map(u => ({
    role: u.role, userIdTail: u.userId.slice(-6), source: u.source,
    evidence: u.evidence ? { kind: u.evidence.kind, recordSha256: u.evidence.recordSha256 } : null
  }));
  if (JSON.stringify(manifest.userSources) !== JSON.stringify(expectUserSources)) bad('manifest.userSources 与计划不一致');
  if (JSON.stringify(manifest.projectReadback || null) !== JSON.stringify(plan.projectReadback)) bad('manifest.projectReadback 与计划不一致');
  // 5) 从独立受审来源重建预期制品，逐字节比对精确文件集
  let files, transforms, artifacts, closeArtifacts;
  try {
    files = readPinnedSources();
    transforms = buildTransforms(plan);
    artifacts = computeArtifacts(plan, files, transforms);
    closeArtifacts = computeCloseArtifacts(files);
  } catch (error) {
    bad('来源/变换重建失败[' + (error.code || 'BTP_ERROR') + ']：' + error.message);
    return finish();
  }
  if (JSON.stringify(manifest.transforms) !== JSON.stringify(transforms.map(t => ({
    root: t.root, file: t.file, label: t.label,
    fromSha: sha256Buffer(Buffer.from(t.from)),
    toSha: sha256Buffer(Buffer.from(t.to))
  })))) bad('manifest.transforms 与计划重建变换不一致');
  // 清单完整性：非空、无重复、路径安全
  const declared = new Set();
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const manifestCloseFiles = manifest.closePackage && Array.isArray(manifest.closePackage.files) ? manifest.closePackage.files : [];
  const verifyDeclared = (list, label) => {
    if (!Array.isArray(list) || list.length === 0) { bad(label + ' 清单为空'); return; }
    for (const f of list) {
      if (!f || typeof f.rel !== 'string') { bad(label + ' 清单含非法条目'); continue; }
      assertSafeRel(f.rel);
      if (declared.has(f.rel)) bad('重复清单条目：' + f.rel);
      declared.add(f.rel);
    }
  };
  verifyDeclared(manifest.files, 'files');
  verifyDeclared(manifest.closePackage.files, 'closePackage.files');
  // 6) 期望集 = 制品 + 关闭包 + plan.json（manifest 自身不重建，但须在盘上）
  const expected = new Map();
  for (const [rel, a] of artifacts) expected.set(rel, a);
  for (const [rel, a] of closeArtifacts) expected.set(rel, a);
  const recordOf = rel => manifestFiles.concat(manifestCloseFiles).find(f => f && f.rel === rel);
  for (const [rel, a] of expected) {
    const rec = recordOf(rel);
    if (!rec) { bad('缺失清单记录：' + rel); continue; }
    if (rec.sha256 !== a.sha256 || rec.bytes !== a.bytes) { bad('清单记录与重建不符：' + rel); continue; }
    const abs = path.join(dir, rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch (_) { st = null; }
    if (!st || !st.isFile()) { bad('缺失或非普通文件：' + rel); continue; }
    const buf = fs.readFileSync(abs);
    if (buf.length !== a.bytes || sha256Buffer(buf) !== a.sha256) bad('盘上字节/哈希与重建不符：' + rel);
    // R2-a：逐文件读取边界重查时钟
    clockCheck('check.read:' + rel);
    if (clockStopped) return finish();
  }
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) bad('缺失 manifest.json');
  // R1-a：plan.json 自身的清单条目同样纳入精确核对（顶层 planSha256 正确不代表整条清单正确）
  const planRel = manifest.planFile || 'plan.json';
  const planRec = manifestFiles.find(f => f && f.rel === planRel);
  if (!planRec) {
    bad('清单未声明 ' + planRel);
  } else if (planRec.bytes !== planBytes.length || planRec.sha256 !== sha256Buffer(planBytes)) {
    bad('清单 ' + planRel + ' 条目与实际计划不符（bytes/sha256 必须与目录内计划一致）');
  }
  // 7) 精确文件集：多余文件/多余目录/链接拒绝
  const existing = listExisting(dir);
  for (const [rel, info] of existing) {
    if (rel === 'manifest.json') continue;
    if (info.isSymlink) { bad('符号链接/junction：' + rel); continue; }
    if (info.isDir) {
      const expectedKeys = [...expected.keys(), planRel];
      if (!isExpectedPrefix(rel, expectedKeys)) bad('额外目录：' + rel);
      continue;
    }
    if (!expected.has(rel) && rel !== planRel) bad('额外文件：' + rel);
  }
  for (const rel of declared) {
    if (!expected.has(rel) && rel !== planRel) bad('清单声明了非预期文件：' + rel);
  }
  // 8) 每文件的变换步骤标签与重建一致
  for (const [rel, a] of artifacts) {
    const rec = recordOf(rel);
    if (!rec) continue;
    const wantLabels = a.steps.length ? a.steps.map(s => s.label) : null;
    if (JSON.stringify(rec.transform || null) !== JSON.stringify(wantLabels)) bad('transform 标签与重建不符：' + rel);
  }
  function finish() {
    // R2-a：最终成功返回前重查时钟（含逐文件读取后到期/NaN/抛错情形）
    clockCheck('check.final');
    return {
      manifest, problems, ok: problems.length === 0,
      files: manifest.files ? manifest.files.length : 0,
      closeFiles: manifest.closePackage && manifest.closePackage.files ? manifest.closePackage.files.length : 0,
      planChecked: problems.length === 0
    };
  }
  return finish();
}

/**
 * R1/R4-a：关闭包独立核对入口——从独立受审来源 + 固定受审**装配变换**
 * （正确根路径 + 唯一关闭页面）重建关闭包预期制品，逐字节比对精确文件集。
 * 不读 manifest、不读计划、不受开启候选损坏或窗口过期影响。
 */
function checkCloseDir(dir) {
  assertRealDirChain(dir, 'check-close 输入');
  const closeDir = path.join(dir, 'close');
  const problems = [];
  let files = 0;
  let expected;
  try {
    expected = computeCloseArtifacts(readPinnedSources());
  } catch (error) {
    problems.push('来源/装配重建失败[' + (error.code || 'BTP_ERROR') + ']：' + error.message);
    return { ok: false, problems, files: 0, expectedFiles: 0 };
  }
  for (const [relFull, a] of expected) {
    const rel = relFull.startsWith('close/') ? relFull.slice('close/'.length) : relFull;
    const abs = path.join(closeDir, rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch (_) { st = null; }
    if (!st || !st.isFile()) { problems.push('缺失：close/' + rel); continue; }
    files++;
    const buf = fs.readFileSync(abs);
    if (buf.length !== a.bytes || sha256Buffer(buf) !== a.sha256) {
      problems.push('与受审装配重建不一致：close/' + rel);
    }
  }
  for (const [relFull, info] of listExisting(closeDir)) {
    const rel = relFull;
    if (info.isSymlink) { problems.push('符号链接/junction：close/' + rel); continue; }
    if (info.isDir) {
      const innerKeys = [...expected.keys()].map(k => k.startsWith('close/') ? k.slice('close/'.length) : k);
      if (!isExpectedPrefix(rel, innerKeys)) problems.push('多余目录：close/' + rel);
      continue;
    }
    const stripped = rel;
    const has = [...expected.keys()].some(k => (k.startsWith('close/') ? k.slice('close/'.length) : k) === stripped);
    if (!has) problems.push('额外文件：close/' + rel);
  }
  return { ok: problems.length === 0, problems, files, expectedFiles: expected.size };
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
        planChecked: r.planChecked, problems: r.problems
      }, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (argv[0] === '--check-close') {
      const dir = argv[1];
      if (!dir) { console.error('用法：--check-close <候选根目录>'); process.exitCode = 1; return; }
      const r = checkCloseDir(dir);
      console.log(JSON.stringify({ ok: r.ok, dir, files: r.files, expectedFiles: r.expectedFiles, problems: r.problems }, null, 2));
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
    if (error.wroteFiles) {
      console.error('[已写事实] 本次已写入 ' + error.wroteFiles + ' 个文件：' + error.written.join(', '));
    }
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
  ASSEMBLY_PINNED,
  CLOSE_ASSEMBLY_TRANSFORMS,
  MANIFEST_SCHEMA,
  MAX_WINDOW_MS,
  readPlan,
  build,
  checkDir,
  checkCloseDir,
  planDigest
});
