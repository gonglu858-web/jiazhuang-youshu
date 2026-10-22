'use strict';
// 参与者私密编号存储辅助（本机专用；不进入任何制品）。
//
// 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §3；
// 返修：docs/Codex复查-指定本人登记与私密输入本地实现-20261021.md §2 R4。
// - 固定私密根 artifacts/schedule-sandbox/.participant-private/（Git 忽略目录）。
// - 写前检查：Git 查询失败闭合、已跟踪、忽略命中、目录/祖先/目标文件非链接、
//   ACL 主体白名单（当前用户身份/SID + SYSTEM/Administrators；其余主体任何授权拒绝）、
//   路径边界；排他新建（wx），EEXIST 竞态归他属（不记自身 partialWrite）。
// - 负载绑定（R4 二次返修）：appId/envId 精确等于受审固定目标、checkRoundId（只读核验
//   轮次）格式、checkWindow 起止为可解析 ISO 且开始<截止、readonlySourceDigest 为只读
//   核验来源摘要（64hex 格式核验；只读核验来源与登记计划分离，不绑定关闭包摘要）、
//   交付确认必须为显式事实（UI 复选框收集）。
// - 1/2 完整编号排重（R4）：同一参与者代码在不同记录文件中不得对应不同账号；
//   同一账号不得同时出现在两个参与者代码下；0 号不存在。
// - Windows CurrentUser DPAPI：加密经 powershell stdin/stdout（输出为密文，非敏感）；
//   解密经 NamedPipe 传输（明文不进 stdout/stderr/argv/env/磁盘，R4）。
// - 公开回执不含完整编号/OPENID/口令/裸编号哈希；标明"人工输入来源，不是平台登记回读"。
// - DPAPI 不防同一已登录用户或同权限本机进程；跨 Windows 账号解密失败属环境验证项。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const local = require('./participant-local-tools.cjs');

const PRIVATE_ROOT_REL = 'artifacts/schedule-sandbox/.participant-private';
const PAYLOAD_SCHEMA = 'participant-self-registration-private-payload/1';
const RECEIPT_SCHEMA = 'participant-self-registration-private-receipt/1';
const ACCOUNT_RE = /^u_[0-9a-f]{40}$/;
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const PARTICIPANT_CODE_RE = /^[12]$/; // 0 号不存在：1/2 之外一律拒绝
// DPAPI 固定脚本（字节级固定；适配层按 SHA-256 精确匹配放行，杜绝注释伪装，R6/R4）
const DPAPI_PROTECT_SCRIPT = local.PROTECT;
const DPAPI_UNPROTECT_PIPE_SCRIPT = local.UNPROTECT;

class PrivateStoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PrivateStoreError(code, message); };
const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const sha256Buffer = b => crypto.createHash('sha256').update(b).digest('hex');
const tailOf = v => (typeof v === 'string' && v.length >= 6 ? v.slice(-6) : '');
const relOf = p => p.split(path.sep).join('/');

function runGit(repoRoot, args) {
  const r = local.queryGit(repoRoot, args[0], args[2]);
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/**
 * 当前进程最小主体集（R4 收紧）：仅当前用户（名称+SID）、SYSTEM、Administrators。
 * 不再把当前令牌的全部组加入允许集合（Everyone/Users 等宽泛组可能是所属组）。
 * 身份查询失败/不确定 → 返回 null（调用方失败闭合）。
 */
let principalCache = null;
function getCurrentPrincipals() {
  if (principalCache !== null) return principalCache;
  try {
    const u = local.queryIdentity();
    if (u.status !== 0) { principalCache = null; return null; }
    const m = String(u.stdout || '').trim().match(/^"([^"]+)","(S-1-5-21-[\d-]+)"$/);
    if (!m) { principalCache = null; return null; } // 解析不确定 → 失败闭合
    const names = new Set([m[1].toLowerCase(), 'nt authority\\system', 'builtin\\administrators']);
    const sids = new Set([m[2], 'S-1-5-18', 'S-1-5-32-544']);
    // 组查询仅用于确认当前用户 SID（不扩大允许集合）
    principalCache = { names, sids };
    return principalCache;
  } catch (_) {
    principalCache = null;
    return null;
  }
}

/**
 * ACL 纯解析器（R4 收紧）：只允许明确最小主体（当前用户/SYSTEM/Administrators/登录会话 SID）。
 * 任何其他主体的授权行都算违规；无法解析的非空行一律计违规（解析不确定失败闭合）。
 * icacls 首行格式为「<目标路径> <主体>:(ACE)」——stripPathPrefix 时先剥离目标路径。
 */
function findBroadAclGrants(icaclsOutput, principals, stripPathPrefix) {
  const offenders = [];
  const lines = String(icaclsOutput).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    if (i === 0 && stripPathPrefix && typeof stripPathPrefix === 'string' && line.toLowerCase().startsWith(stripPathPrefix.toLowerCase())) {
      line = line.slice(stripPathPrefix.length).trim();
      if (!line) continue;
    }
    const m = line.match(/^(.+?):((?:\([A-Za-z0-9 ,]+\))+)$/);
    if (!m) {
      // icacls 已知非 ACE 行：末尾处理统计（中英文文案；GBK 环境下中文会乱码）。
      // 结构识别：统计行不含 ACE 的 ":(" 标记且含计数数字——ACE 行必然含 ":("；
      // 其余无 ":(" 且无数字的无法解析行 → 失败闭合。
      if (/^Successfully processed \d+ files; Failed processing 0 files$/i.test(line) || /^已成功处理\s*\d+\s*个文件[;；]\s*处理\s*0\s*个文件时失败[。.]?$/.test(line)) continue;
      offenders.push(line);
      continue;
    }
    const principal = m[1].trim();
    // 登录会话 SID（S-1-5-5-X-Y 或 NT AUTHORITY\LogonSessionId_* 名称形式）：进程令牌
    // 默认 DACL 自动项，会话内最小范围，放行
    const key = principal.toLowerCase();
    const isSid = /^S-1-[\d-]+$/i.test(principal);
    const namePart = key.includes('\\') ? key.split('\\').pop() : key;
    const allowed = principals.names.has(key) || (isSid && principals.sids.has(principal));
    if (!allowed) offenders.push(line);
  }
  if (!lines.some(line => /:\(/.test(line))) offenders.push('缺少可解析权限记录');
  return offenders;
}

/** 链路检查：私密根及其仓库内祖先不得是符号链接/junction，且都必须是真实目录。 */
function assertNoLinks(repoRoot, privateRoot) {
  let current = path.resolve(privateRoot);
  const stop = path.resolve(repoRoot);
  const chain = [];
  for (;;) {
    chain.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current || chain.length > 64) fail('PSR_PRIVATE_PATH_BOUNDARY', '私密根不在仓库目录链内：' + privateRoot);
    current = parent;
  }
  chain.reverse();
  for (const p of chain) {
    let st = null;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; fail('PSR_PRIVATE_PATH_BOUNDARY','无法核实路径'); }
    if (st.isSymbolicLink()) fail('PSR_PRIVATE_LINK', '私密路径含符号链接/junction，拒绝写入：' + p);
    if (!st.isDirectory()) fail('PSR_PRIVATE_PATH_BOUNDARY', '私密路径存在非目录占位：' + p);
  }
}

/**
 * ACL 只读检查（R4 收紧）：目标（目录或已存在的密文文件）不得有非允许主体授权。
 * - 检查函数绝不修改已有权限（收紧是一次性部署步骤，不由检查隐式执行）；
 * - 身份查询/ACL 输出解析不确定 → 失败闭合；
 * - aclReader 注入接缝（离线验证用；默认真实 icacls 固定形状只读查询）。
 */
function assertPrivateAcl(target, repoRoot, aclReader) {
  const targetAbs = path.resolve(target);
  // icacls 在中文 Windows 上输出 ANSI/GBK：绝对路径含中文会乱码——
  // 统一以 repoRoot 为 cwd 的相对路径调用（纯 ASCII），输出首行可稳定剥离。
  const repoAbs = repoRoot ? path.resolve(repoRoot) : path.dirname(targetAbs);
  const relOrAbs = relOf(path.relative(repoAbs, targetAbs));
  const read = aclReader || (() => {
    const r = local.queryAcl(repoAbs, relOrAbs);
    return { status: r.status, stdout: r.stdout || '' };
  });
  const r = read(relOrAbs);
  if (!r || r.status !== 0) fail('PSR_PRIVATE_ACL', '无法读取私密路径 ACL（icacls 失败）：' + relOrAbs);
  const principals = getCurrentPrincipals();
  if (!principals) fail('PSR_PRIVATE_ACL', '当前进程身份查询不确定，失败闭合。');
  const offenders = findBroadAclGrants(r.stdout || '', principals, relOrAbs);
  if (offenders.length) {
    fail('PSR_PRIVATE_ACL', '私密路径 ACL 存在非允许主体授权（' + offenders[0] + '），拒绝写入。');
  }
}

function validatePrivateTarget({ repoRoot, relativePath, aclReader }) {
  if (typeof repoRoot !== 'string' || !repoRoot) fail('PSR_PRIVATE_CONFIG', '缺少仓库根。');
  if (typeof relativePath !== 'string' || !relativePath) fail('PSR_PRIVATE_CONFIG', '缺少私密相对路径。');
  const repoAbs = path.resolve(repoRoot);
  const targetAbs = path.resolve(repoAbs, relativePath);
  const rootAbs = path.resolve(repoAbs, PRIVATE_ROOT_REL);
  const relFromRepo = relOf(path.relative(repoAbs, targetAbs));
  if (relFromRepo.startsWith('..') || path.isAbsolute(relFromRepo)) {
    fail('PSR_PRIVATE_PATH_BOUNDARY', '私密目标必须在仓库内：' + relativePath);
  }
  if (!targetAbs.startsWith(rootAbs + path.sep)) {
    fail('PSR_PRIVATE_PATH_BOUNDARY', '私密目标必须在固定私密根 ' + PRIVATE_ROOT_REL + ' 之内：' + relativePath);
  }
  const parentRel = path.dirname(relFromRepo).split(path.sep).join('/');
  // 顺序：先查跟踪（check-ignore 对已跟踪文件不报告——git 语义），再查忽略；查询失败闭合（R4）
  const tracked = runGit(repoAbs, ['ls-files', '--', relFromRepo]);
  if (tracked.status !== 0) fail('PSR_PRIVATE_GIT_FAILED', 'Git 跟踪查询失败：' + (tracked.stderr || ('status ' + tracked.status)));
  if (tracked.stdout) fail('PSR_PRIVATE_TRACKED', '私密目标已被 Git 跟踪，拒绝写入：' + relFromRepo);
  const ignored = runGit(repoAbs, ['check-ignore', '--', relFromRepo]);
  if (ignored.status > 1) fail('PSR_PRIVATE_GIT_FAILED', 'Git 忽略查询失败：' + (ignored.stderr || ('status ' + ignored.status)));
  if (ignored.status !== 0 || !ignored.stdout) {
    fail('PSR_PRIVATE_NOT_IGNORED', '私密目标未被 Git 忽略（check-ignore 未命中）：' + relFromRepo);
  }
  assertNoLinks(repoAbs, path.dirname(targetAbs));
  // 目标文件本体：已存在时不得是链接/目录（R4：不只查父目录）
  let targetSt = null;
  try { targetSt = fs.lstatSync(targetAbs); } catch (e) { if(e.code!=='ENOENT') fail('PSR_PRIVATE_PATH_BOUNDARY','无法核实目标'); targetSt = null; }
  if (targetSt && targetSt.isSymbolicLink()) fail('PSR_PRIVATE_LINK', '私密目标文件为符号链接/junction：' + relFromRepo);
  if (targetSt && !targetSt.isFile()) fail('PSR_PRIVATE_PATH_BOUNDARY', '私密目标位置存在非文件占位：' + relFromRepo);
  assertPrivateAcl(path.dirname(targetAbs), repoAbs, aclReader);
  if (targetSt && targetSt.isFile()) assertPrivateAcl(targetAbs, repoAbs, aclReader);
  return { repoAbs, targetAbs, relFromRepo, parentRel };
}

/**
 * 构造加密负载（R4 收紧：只读核验来源与新登记计划分离）：
 * - 绑定的是【只读核验会话】事实：checkRoundId（只读核验轮次）、checkWindow 起止、
 *   readonlySourceDigest（只读核验来源摘要，64hex 格式核验）、deliveryConfirmed（显式交付事实）。
 * - 不再绑定关闭包摘要（关闭包摘要不能证明编号交付来源），也不与新登记轮次做相等绑定
 *   （登记计划轮次是另一事实；消费绑定=参与者代码+固定目标+交付确认+排重）。
 * - appId/envId 必须精确等于 expectedTarget（受审固定目标）；serverTimeIso 必需且必须在只读核验窗口内。
 * - 只读来源摘要由已关闭的只读核验会话记录，本存储不重算（其完整性由只读核验轮纪律保证），
 *   如实披露；格式必须为 64 位小写十六进制。
 */
function buildPrivatePayload({ participantCode, fullAccount, appId, envId, checkRoundId, serverTimeIso, readonlySourceDigest, deliveryConfirmed, expectedTarget, checkWindowStartsAtIso, checkWindowExpiresAtIso }) {
  if (typeof participantCode !== 'string' || !PARTICIPANT_CODE_RE.test(participantCode)) {
    fail('PSR_PRIVATE_INPUT', '参与者代码只能是 1 或 2（0 号不存在）。');
  }
  if (typeof fullAccount !== 'string' || !ACCOUNT_RE.test(fullAccount)) {
    fail('PSR_PRIVATE_INPUT', '完整编号须为 u_+40 位小写十六进制（不回显输入）。');
  }
  if (typeof checkRoundId !== 'string' || !ROUND_ID_RE.test(checkRoundId)) fail('PSR_PRIVATE_INPUT', '只读核验轮次格式无效。');
  if (!isPlainTarget(expectedTarget) || appId !== expectedTarget.appId || envId !== expectedTarget.envId) {
    fail('PSR_PRIVATE_INPUT', '固定目标与受审目标不一致。');
  }
  const iso = v => typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
  if (!iso(checkWindowStartsAtIso) || !iso(checkWindowExpiresAtIso) || !(Date.parse(checkWindowStartsAtIso) < Date.parse(checkWindowExpiresAtIso))) {
    fail('PSR_PRIVATE_INPUT', '只读核验窗口时间缺失或非法（须为可解析 ISO 且开始<截止）。');
  }
  if (deliveryConfirmed !== true) fail('PSR_PRIVATE_INPUT', '缺少交付确认事实（须为显式收集的 true）。');
  if (!iso(serverTimeIso) || Date.parse(serverTimeIso) < Date.parse(checkWindowStartsAtIso) || Date.parse(serverTimeIso) >= Date.parse(checkWindowExpiresAtIso)) {
    fail('PSR_PRIVATE_INPUT', '服务端时间存在但不是可解析 ISO。');
  }
  if (typeof readonlySourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(readonlySourceDigest)) {
    fail('PSR_PRIVATE_INPUT', '只读核验来源摘要须为 64 位小写十六进制（交付会话记录事实）。');
  }
  return {
    schema: PAYLOAD_SCHEMA,
    participantCode,
    fullAccount,
    appId, envId,
    checkRoundId,
    checkWindowStartsAtIso, checkWindowExpiresAtIso,
    serverTimeIso: typeof serverTimeIso === 'string' ? serverTimeIso : null,
    readonlySourceDigest,
    deliveryConfirmed: true,
    inputTimeIso: new Date().toISOString(),
    ref: crypto.randomBytes(8).toString('hex')
  };
}
function isPlainTarget(v) {
  return v !== null && typeof v === 'object' && typeof v.appId === 'string' && v.appId && typeof v.envId === 'string' && v.envId;
}

/** CurrentUser DPAPI 加密：明文只经 stdin 传给 PowerShell；输出为密文（非敏感）。 */
function dpapiProtect(plain) {
  try { return local.protect(plain); } catch (_) { fail('PSR_PRIVATE_DPAPI', 'DPAPI加密失败'); }
}
async function dpapiUnprotectAsync(cipherHex) {
  try {
    const plain = await local.unprotect(cipherHex.trim());
    if (JSON.parse(plain).schema !== PAYLOAD_SCHEMA) throw new Error('schema');
    return plain;
  } catch (_) { fail('PSR_PRIVATE_DPAPI', 'DPAPI解密失败'); }
}

/**
 * 完整录入管线：校验 → 构造绑定负载 → DPAPI 加密 → 排他新建（wx）→ 净化回执。
 * EEXIST 竞态归他属（PSR_PRIVATE_EXISTS，不记自身 partialWrite，R4）。
 */
function protectRecord({ repoRoot, fileName, participantCode, fullAccount, fullAccountRepeat, appId, envId, checkRoundId, serverTimeIso, readonlySourceDigest, expectedTarget, checkWindowStartsAtIso, checkWindowExpiresAtIso, deliveryConfirmed, aclReader }) {
  if (typeof fullAccount !== 'string' || fullAccount !== fullAccountRepeat) {
    fail('PSR_PRIVATE_INPUT', '两次输入不一致（不回显输入）。');
  }
  const { repoAbs, targetAbs, relFromRepo } = validatePrivateTarget({ repoRoot, relativePath: PRIVATE_ROOT_REL + '/' + (fileName || ('participant-' + participantCode + '-' + crypto.randomBytes(4).toString('hex') + '.bin')), aclReader });
  const payload = buildPrivatePayload({ participantCode, fullAccount, appId, envId, checkRoundId, serverTimeIso, readonlySourceDigest, expectedTarget, checkWindowStartsAtIso, checkWindowExpiresAtIso, deliveryConfirmed });
  const cipherHex = dpapiProtect(JSON.stringify(payload));
  const cipherBuf = Buffer.from(cipherHex, 'utf8');
  if (fs.existsSync(targetAbs)) fail('PSR_PRIVATE_EXISTS', '同名私密记录已存在，不覆盖（输入有误请新建版本）。');
  try {
    fs.writeFileSync(targetAbs, cipherBuf, { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // 竞态：他人文件先到——归他属，不记自身部分写（R4）
      fail('PSR_PRIVATE_EXISTS', '同名私密记录已存在（并发），不覆盖。');
    }
    let st = null;
    try { st = fs.lstatSync(targetAbs); } catch (_) { st = null; }
    const err = new PrivateStoreError('PSR_PRIVATE_WRITE_FAILED', '私密记录写入失败（如磁盘留有字节将如实记账）。');
    if (st && st.isFile() && st.size > 0) err.partialWrite = { rel: relFromRepo, bytesOnDisk: st.size };
    throw err;
  }
  // 净化回执：不含完整编号/OPENID/口令/裸编号哈希
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    participantCode,
    accountTail: tailOf(fullAccount),
    checkRoundId: payload.checkRoundId,
    ref: payload.ref,
    cipherSha256: sha256Buffer(cipherBuf),
    doubleInputConsistent: true,
    encrypted: 'dpapi-currentuser',
    gitIgnored: true,
    source: 'manual-input-not-platform-readback',
    fileRel: relFromRepo
  });
}

/** 解密装配视图（async；NamedPipe 传输；仅内存使用）。 */
async function readRecordAsync({ repoRoot, relativePath }) {
  const { targetAbs } = validatePrivateTarget({ repoRoot, relativePath });
  const cipherHex = fs.readFileSync(targetAbs, 'utf8');
  const plain = await dpapiUnprotectAsync(cipherHex);
  const payload = JSON.parse(plain);
  if (!payload || payload.schema !== PAYLOAD_SCHEMA) fail('PSR_PRIVATE_PAYLOAD', '私密负载 schema 不符。');
  validatePayload(payload);
  return Object.freeze(payload);
}

function validatePayload(payload) {
  const expected = ['schema','participantCode','fullAccount','appId','envId','checkRoundId',
    'checkWindowStartsAtIso','checkWindowExpiresAtIso','serverTimeIso','readonlySourceDigest',
    'deliveryConfirmed','inputTimeIso','ref'];
  if (!payload || Object.keys(payload).sort().join(',') !== expected.sort().join(',') ||
    payload.schema !== PAYLOAD_SCHEMA || !/^[0-9a-f]{16}$/.test(payload.ref || '') ||
    !Number.isFinite(Date.parse(payload.inputTimeIso))) fail('PSR_PRIVATE_PAYLOAD', '私密记录字段不完整');
  buildPrivatePayload({ ...payload, expectedTarget: { appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723' } });
  return payload;
}

// 明文候选输出只读预检：不存在的叶路径检查其最近已有祖先；已有整树逐项检查ACL。
function assertPrivateOutput(repoRoot, outDir) {
  const abs = path.resolve(outDir), rel = path.relative(path.resolve(repoRoot), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('PSR_PRIVATE_PATH_BOUNDARY', '输出越界');
  const tracked = runGit(repoRoot, ['ls-files','--',relOf(rel)]);
  const ignored = runGit(repoRoot, ['check-ignore','--',relOf(rel)]);
  if (tracked.status !== 0 || tracked.stdout || ignored.status !== 0 || !ignored.stdout) fail('PSR_PRIVATE_TRACKED', '明文输出未忽略或已跟踪');
  assertNoLinks(repoRoot, abs);
  let ancestor = abs;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assertPrivateAcl(ancestor, repoRoot);
  const walk = p => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) fail('PSR_PRIVATE_LINK', '候选存在链接或非普通条目');
    assertPrivateAcl(p, repoRoot);
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p,name));
  };
  if (fs.existsSync(abs)) walk(abs);
}

/**
 * 枚举私密根内全部记录并解密（R4：1/2 排重的输入）。
 * 返回 [{ fileName, payload }]；排除非 .bin 文件。
 */
async function readAllRecordsAsync({ repoRoot, recordFiles }) {
  if (!Array.isArray(recordFiles) || recordFiles.length !== 2 || new Set(recordFiles).size !== 2 || !recordFiles.every(f => /^[A-Za-z0-9_-]+\.bin$/.test(f))) fail('PSR_PRIVATE_PAYLOAD', '必须明确指定本次1/2两份必要记录，禁止扫描历史根');
  return Promise.all(recordFiles.map(async fileName => ({ fileName, payload: await readRecordAsync({ repoRoot, relativePath: PRIVATE_ROOT_REL + '/' + fileName }) })));
}
/**
 * 1/2 完整编号排重（R4）：同一参与者代码在不同记录文件中不得对应不同账号；
 * 同一账号不得同时挂在两个参与者代码下；0 号不存在（构造期已拒）。
 */
function verifyParticipantDedup(records) {
  const byCode = new Map();
  const byAccount = new Map();
  for (const { fileName, payload } of records) {
    if (!PARTICIPANT_CODE_RE.test(String(payload.participantCode))) {
      fail('PSR_PRIVATE_DEDUP', '记录含非法参与者代码（0 号不存在）：' + fileName);
    }
    const prev = byCode.get(payload.participantCode);
    if (prev && prev !== payload.fullAccount) {
      fail('PSR_PRIVATE_DEDUP', '同一参与者代码对应了不同账号（' + fileName + '），拒绝装配。');
    }
    const prevCode = byAccount.get(payload.fullAccount);
    if (prevCode && prevCode !== payload.participantCode) {
      fail('PSR_PRIVATE_DEDUP', '同一账号同时挂在多个参与者代码下，拒绝装配。');
    }
    byCode.set(payload.participantCode, payload.fullAccount);
    byAccount.set(payload.fullAccount, payload.participantCode);
  }
  return { byCode, byAccount };
}

module.exports = Object.freeze({
  PRIVATE_ROOT_REL,
  PAYLOAD_SCHEMA,
  RECEIPT_SCHEMA,
  ACCOUNT_RE,
  ROUND_ID_RE,
  PARTICIPANT_CODE_RE,
  DPAPI_PROTECT_SCRIPT,
  DPAPI_UNPROTECT_PIPE_SCRIPT,
  PrivateStoreError,
  validatePrivateTarget,
  assertNoLinks,
  assertPrivateAcl,
  findBroadAclGrants,
  getCurrentPrincipals,
  buildPrivatePayload,
  dpapiProtect,
  dpapiUnprotectAsync,
  protectRecord,
  readRecordAsync,
  readAllRecordsAsync,
  verifyParticipantDedup,
  validatePayload, assertPrivateOutput,
  tailOf,
  FIXED_TARGET: Object.freeze({ appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723' })
});

// CLI：protect（明文经 stdin；不进 argv/env）。供 participant-private-input.ps1 调用。
// R4：交付确认必须显式传 --delivery-confirmed true；来源摘要独立绑定只读核验事实，不复用关闭包摘要。
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = name => {
    const i = args.indexOf('--' + name);
    return i === -1 ? null : args[i + 1];
  };
  if (args[0] !== 'protect') {
    console.error('[PSR_PRIVATE_CONFIG] 仅支持 protect 管线。');
    process.exitCode = 1;
  } else {
    const repoRoot = getArg('repo-root');
    const participantCode = getArg('participant-code');
    const checkRoundId = getArg('check-round-id');
    const readonlySourceDigest = getArg('source-digest');
    const deliveryConfirmed = getArg('delivery-confirmed') === 'true';
    const serverTimeIso = getArg('server-time-iso');
    const fileName = getArg('file-name');
    let plain = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { plain += d; });
    process.stdin.on('end', () => {
      try {
        // R4 修复：CLI 必须把全部来源事实传给 protectRecord（此前 sourceDigest 被漏传，
        // 实际 UI→CLI 管线在 DPAPI 写入前即 PSR_PRIVATE_SOURCE 失败）。
        const receipt = protectRecord({
          repoRoot, participantCode,
          fullAccount: plain.replace(/\r?\n$/, ''),
          fullAccountRepeat: plain.replace(/\r?\n$/, ''),
          appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723',
          checkRoundId,
          readonlySourceDigest,
          serverTimeIso: serverTimeIso === null ? null : (serverTimeIso || null),
          expectedTarget: { appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723' },
          checkWindowStartsAtIso: getArg('check-window-starts-at-iso') || undefined,
          checkWindowExpiresAtIso: getArg('check-window-expires-at-iso') || undefined,
          deliveryConfirmed, fileName
        });
        console.log(JSON.stringify(receipt, null, 2));
      } catch (e) {
        console.error('[' + (e.code || 'PSR_ERROR') + '] ' + (e.partialWrite ? JSON.stringify(e.partialWrite) : ''));
        process.exitCode = 1;
      }
    });
  }
}
