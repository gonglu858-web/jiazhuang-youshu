'use strict';
// 参与者私密编号存储辅助（本机专用；不进入任何制品）。
//
// 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §3；
// 返修：docs/Codex复查-指定本人登记与私密输入本地实现-20261021.md §2 R4。
// - 固定私密根 artifacts/schedule-sandbox/.participant-private/（Git 忽略目录）。
// - 写前检查：Git 查询失败闭合、已跟踪、忽略命中、目录/祖先/目标文件非链接、
//   ACL 主体白名单（当前用户身份/SID + SYSTEM/Administrators；其余主体任何授权拒绝）、
//   路径边界；排他新建（wx），EEXIST 竞态归他属（不记自身 partialWrite）。
// - 负载绑定（R4）：appId/envId 精确等于受审固定目标、roundId 格式、窗口时间为可解析
//   ISO 且开始<截止、sourceDigest 必须等于对受控关闭来源目录重算的确定性摘要、
//   交付确认必须为显式事实（CLI 不再写死）。
// - 1/2 完整编号排重（R4）：同一参与者代码在不同记录文件中不得对应不同账号；
//   同一账号不得同时出现在两个参与者代码下；0 号不存在。
// - Windows CurrentUser DPAPI：加密经 powershell stdin/stdout（输出为密文，非敏感）；
//   解密经 NamedPipe 传输（明文不进 stdout/stderr/argv/env/磁盘，R4）。
// - 公开回执不含完整编号/OPENID/口令/裸编号哈希；标明"人工输入来源，不是平台登记回读"。
// - DPAPI 不防同一已登录用户或同权限本机进程；跨 Windows 账号解密失败属环境验证项。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// 本模块的工具调用（git/icacls/whoami/powershell）一律经 cp.spawnSync 动态分发：
// 证据适配层在运行期替换该属性以实现白名单分发与台账（R6）——此处不得解构捕获原始引用。
const cp = require('node:child_process');
const spawnSync = (...a) => cp.spawnSync(...a);
const spawn = (...a) => cp.spawn(...a);

const PRIVATE_ROOT_REL = 'artifacts/schedule-sandbox/.participant-private';
const PAYLOAD_SCHEMA = 'participant-self-registration-private-payload/1';
const RECEIPT_SCHEMA = 'participant-self-registration-private-receipt/1';
const ACCOUNT_RE = /^u_[0-9a-f]{40}$/;
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const PARTICIPANT_CODE_RE = /^[12]$/; // 0 号不存在：1/2 之外一律拒绝
// DPAPI 固定脚本（字节级固定；适配层按 SHA-256 精确匹配放行，杜绝注释伪装，R6/R4）
const DPAPI_PROTECT_SCRIPT = '$line = [Console]::In.ReadLine(); $sec = ConvertTo-SecureString -String $line -AsPlainText -Force; ConvertFrom-SecureString -SecureString $sec';
const DPAPI_UNPROTECT_PIPE_SCRIPT = '$ErrorActionPreference="Stop"; $cipher = [Console]::In.ReadLine(); $pipeName = [Console]::In.ReadLine(); $sec = ConvertTo-SecureString -String $cipher; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); $null = $plain | ConvertFrom-Json; $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($pipeName, [System.IO.Pipes.PipeDirection]::Out); $pipe.WaitForConnection(); $w = New-Object System.IO.StreamWriter($pipe); $w.Write($plain); $w.Flush(); $pipe.Dispose();';

class PrivateStoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PrivateStoreError(code, message); };
const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const sha256Buffer = b => crypto.createHash('sha256').update(b).digest('hex');
const tailOf = v => (typeof v === 'string' && v.length >= 6 ? v.slice(-6) : '');
const relOf = p => p.split(path.sep).join('/');

function runGit(repoRoot, args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/** 关闭来源目录确定性摘要（R4）：按相对路径排序，对每个普通文件取 sha256，规范串再取总哈希。 */
function computeCloseSourceDigest(closeSourceDir) {
  if (typeof closeSourceDir !== 'string' || !closeSourceDir) fail('PSR_PRIVATE_CONFIG', '缺少关闭来源目录。');
  const abs = path.resolve(closeSourceDir);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (_) { st = null; }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) fail('PSR_PRIVATE_SOURCE', '关闭来源目录缺失或为链接：' + closeSourceDir);
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) fail('PSR_PRIVATE_SOURCE', '关闭来源含符号链接：' + relOf(path.relative(abs, p)));
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push({ rel: relOf(path.relative(abs, p)), sha: sha256Buffer(fs.readFileSync(p)) });
    }
  };
  walk(abs);
  if (files.length === 0) fail('PSR_PRIVATE_SOURCE', '关闭来源目录为空：' + closeSourceDir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return sha256(files.map(f => f.rel + ':' + f.sha).join('\n'));
}

/** 当前进程身份（用户名/用户 SID/组 SID，缓存一次）；whoami 为只读本地查询。 */
let principalCache = null;
function getCurrentPrincipals() {
  if (principalCache) return principalCache;
  const names = new Set();
  const sids = new Set(['S-1-5-18', 'S-1-5-32-544']); // SYSTEM / Administrators
  try {
    const u = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    if (u.status === 0) {
      const m = String(u.stdout || '').match(/"([^"]+)","(S-1-[\d-]+)"/);
      if (m) { names.add(m[1].toLowerCase()); sids.add(m[2]); }
    }
    const g = spawnSync('whoami', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    if (g.status === 0) {
      for (const line of String(g.stdout || '').split(/\r?\n/)) {
        const m = line.match(/"([^"]*)","(S-1-[\d-]+)"/);
        if (m) { names.add(m[1].toLowerCase()); sids.add(m[2]); }
      }
    }
  } catch (_) { /* 查询失败时仅允许名称精确匹配的白名单（以实际行为为准） */ }
  names.add('nt authority\\system');
  names.add('builtin\\administrators');
  principalCache = { names, sids };
  return principalCache;
}

/**
 * ACL 纯解析器（R4）：icacls 输出中任何非允许主体（当前用户/其组 SID/SYSTEM/
 * Administrators 之外）的授权行都算违规；不依赖少数英文组名。
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
    }
    const m = line.match(/^(.+?):((?:\([A-Za-z0-9 ]+\))+)$/);
    if (!m) continue;
    const principal = m[1].trim();
    // 登录会话 SID（S-1-5-5-X-Y 或 NT AUTHORITY\LogonSessionId_* 名称形式）：进程令牌
    // 默认 DACL 自动项，会话内最小范围，放行
    if (/^S-1-5-5-\d+-\d+$/i.test(principal) || /^NT AUTHORITY\\LogonSessionId_/i.test(principal)) continue;
    const key = principal.toLowerCase();
    const namePart = key.includes('\\') ? key.split('\\').pop() : key;
    const isSid = /^S-1-[\d-]+$/i.test(principal);
    const allowed = principals.names.has(key) || principals.names.has(namePart) || (isSid && principals.sids.has(principal));
    if (!allowed) offenders.push(line);
  }
  return offenders;
}

/** 当前用户名（icacls 收紧授权用；缓存）。 */
let currentUserNameCache = null;
function getCurrentUserName() {
  if (currentUserNameCache) return currentUserNameCache;
  try { currentUserNameCache = require('node:os').userInfo().username; } catch (_) { currentUserNameCache = null; }
  return currentUserNameCache;
}

/**
 * 私密根 ACL 收紧（R4）：移除继承并仅授予当前用户与 SYSTEM。
 * 固定命令形状：icacls <root> /inheritance:r /grant:r <user>:F /grant:r SYSTEM:F
 * （由证据适配层按形状白名单放行；调用全记账披露）。
 */
function hardenPrivateRootAcl(rootAbs, repoAbs, rootRel) {
  const user = getCurrentUserName();
  if (!user) fail('PSR_PRIVATE_ACL', '无法确定当前用户，无法收紧私密根 ACL。');
  const cwd = repoAbs || path.dirname(rootAbs);
  const rel = rootRel || rootAbs;
  const r = spawnSync('icacls', [rel, '/inheritance:r', '/grant:r', user + ':F', '/grant:r', 'SYSTEM:F'], { encoding: 'utf8', cwd, windowsHide: true });
  if (r.status !== 0) fail('PSR_PRIVATE_ACL', '私密根 ACL 收紧失败（icacls）：' + rel);
  // 收紧后把当前用户身份缓存补全（icacls 显示名可能带域前缀）
  try {
    const principals = getCurrentPrincipals();
    principals.names.add(String(user).toLowerCase());
    const who = spawnSync('whoami', [], { encoding: 'utf8', windowsHide: true });
    if (who.status === 0) principals.names.add(String(who.stdout || '').trim().toLowerCase());
  } catch (_) {}
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
    try { st = fs.lstatSync(p); } catch (e) { continue; } // 不存在的层由创建时失败
    if (st.isSymbolicLink()) fail('PSR_PRIVATE_LINK', '私密路径含符号链接/junction，拒绝写入：' + p);
    if (!st.isDirectory()) fail('PSR_PRIVATE_PATH_BOUNDARY', '私密路径存在非目录占位：' + p);
  }
}

/** ACL 检查：目标（目录或已存在的密文文件）不得有非允许主体授权。
 *  违规时若目标位于固定私密根内，先一次性收紧（私密根与目标本体：仅当前用户+SYSTEM，
 *  移除继承），再复核；仍违规则拒绝。收紧命令为固定形状（证据适配层按形状白名单放行）。 */
function assertPrivateAcl(target, repoRoot) {
  const targetAbs = path.resolve(target);
  // icacls 在中文 Windows 上输出 ANSI/GBK：绝对路径含中文会乱码——
  // 统一以 repoRoot 为 cwd 的相对路径调用（纯 ASCII），输出首行可稳定剥离。
  const repoAbs = repoRoot ? path.resolve(repoRoot) : path.dirname(targetAbs);
  const relOrAbs = relOf(path.relative(repoAbs, targetAbs));
  const icaclsOpts = { encoding: 'utf8', cwd: repoAbs, windowsHide: true };
  const read = () => spawnSync('icacls', [relOrAbs], icaclsOpts);
  let r = read();
  if (r.status !== 0) fail('PSR_PRIVATE_ACL', '无法读取私密路径 ACL（icacls 失败）：' + relOrAbs);
  let offenders = findBroadAclGrants(r.stdout || '', getCurrentPrincipals(), relOrAbs);
  if (offenders.length) {
    const marker = PRIVATE_ROOT_REL.split('/').pop(); // .participant-private
    const idx = targetAbs.toLowerCase().indexOf(marker.toLowerCase());
    if (idx !== -1) {
      const rootAbs = targetAbs.slice(0, idx + marker.length);
      const rootRel = relOf(path.relative(repoAbs, rootAbs));
      hardenPrivateRootAcl(rootAbs, repoAbs, rootRel);
      let targetSt = null;
      try { targetSt = fs.lstatSync(targetAbs); } catch (_) { targetSt = null; }
      if (targetSt) hardenPrivateRootAcl(targetAbs, repoAbs, relOrAbs); // 文件本体同样收紧
      r = read();
      if (r.status !== 0) fail('PSR_PRIVATE_ACL', '无法读取私密路径 ACL（icacls 失败）：' + relOrAbs);
      offenders = findBroadAclGrants(r.stdout || '', getCurrentPrincipals(), relOrAbs);
    }
  }
  if (offenders.length) {
    fail('PSR_PRIVATE_ACL', '私密路径 ACL 存在非允许主体授权（' + offenders[0] + '），拒绝写入。');
  }
}

function validatePrivateTarget({ repoRoot, relativePath }) {
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
  try { targetSt = fs.lstatSync(targetAbs); } catch (_) { targetSt = null; }
  if (targetSt && targetSt.isSymbolicLink()) fail('PSR_PRIVATE_LINK', '私密目标文件为符号链接/junction：' + relFromRepo);
  if (targetSt && !targetSt.isFile()) fail('PSR_PRIVATE_PATH_BOUNDARY', '私密目标位置存在非文件占位：' + relFromRepo);
  assertPrivateAcl(path.dirname(targetAbs), repoAbs);
  if (targetSt && targetSt.isFile()) assertPrivateAcl(targetAbs, repoAbs);
  return { repoAbs, targetAbs, relFromRepo, parentRel };
}

/**
 * 构造加密负载（R4：来源/目标/轮次时间/摘要/交付绑定全部核验）：
 * - appId/envId 必须精确等于 expectedTarget（受审固定目标）；
 * - roundId 格式合法；windowStartsAtIso/windowExpiresAtIso 必须为可解析 ISO 且开始<截止；
 * - sourceDigest 必须等于对 closeSourceDir 重算的确定性摘要；
 * - deliveryConfirmed 必须为显式 true（调用方收集的交付事实，不代写）；
 * - serverTimeIso 可为 null 或可解析 ISO。
 */
function buildPrivatePayload({ participantCode, fullAccount, appId, envId, roundId, serverTimeIso, sourceDigest, deliveryConfirmed, closeSourceDir, expectedTarget, windowStartsAtIso, windowExpiresAtIso }) {
  if (typeof participantCode !== 'string' || !PARTICIPANT_CODE_RE.test(participantCode)) {
    fail('PSR_PRIVATE_INPUT', '参与者代码只能是 1 或 2（0 号不存在）。');
  }
  if (typeof fullAccount !== 'string' || !ACCOUNT_RE.test(fullAccount)) {
    fail('PSR_PRIVATE_INPUT', '完整编号须为 u_+40 位小写十六进制（不回显输入）。');
  }
  if (typeof roundId !== 'string' || !ROUND_ID_RE.test(roundId)) fail('PSR_PRIVATE_INPUT', '来源轮次格式无效。');
  if (!isPlainTarget(expectedTarget) || appId !== expectedTarget.appId || envId !== expectedTarget.envId) {
    fail('PSR_PRIVATE_INPUT', '固定目标与受审目标不一致。');
  }
  const iso = v => typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
  if (!iso(windowStartsAtIso) || !iso(windowExpiresAtIso) || !(Date.parse(windowStartsAtIso) < Date.parse(windowExpiresAtIso))) {
    fail('PSR_PRIVATE_INPUT', '窗口时间缺失或非法（须为可解析 ISO 且开始<截止）。');
  }
  if (deliveryConfirmed !== true) fail('PSR_PRIVATE_INPUT', '缺少交付确认事实（须为显式收集的 true）。');
  if (serverTimeIso !== null && serverTimeIso !== undefined && !iso(serverTimeIso)) {
    fail('PSR_PRIVATE_INPUT', '服务端时间存在但不是可解析 ISO。');
  }
  if (typeof closeSourceDir !== 'string' || !closeSourceDir) fail('PSR_PRIVATE_INPUT', '缺少受控关闭来源目录。');
  const recomputed = computeCloseSourceDigest(closeSourceDir);
  if (typeof sourceDigest !== 'string' || sourceDigest !== recomputed) {
    fail('PSR_PRIVATE_SOURCE', '来源摘要与受控关闭来源重算不一致（不核实来源不落盘）。');
  }
  return {
    schema: PAYLOAD_SCHEMA,
    participantCode,
    fullAccount,
    appId, envId,
    roundId,
    windowStartsAtIso, windowExpiresAtIso,
    serverTimeIso: typeof serverTimeIso === 'string' ? serverTimeIso : null,
    sourceDigest: recomputed,
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
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT_SCRIPT], { input: plain, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !(r.stdout || '').trim()) {
    fail('PSR_PRIVATE_DPAPI', 'DPAPI 加密失败（不回显输入）。');
  }
  return r.stdout.trim();
}

/**
 * CurrentUser DPAPI 解密（R4）：NamedPipe 传输——明文只在 PowerShell 进程内存与
 * 内核管道之间移动，不进 stdout/stderr/argv/env/磁盘；错误只回固定标记。
 */
function dpapiUnprotectAsync(cipherHex) {
  return new Promise((resolve, reject) => {
    if (typeof cipherHex !== 'string' || !cipherHex.trim()) {
      reject(new PrivateStoreError('PSR_PRIVATE_DPAPI', '密文为空。'));
      return;
    }
    const pipeName = 'psr-dpapi-' + crypto.randomBytes(6).toString('hex');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT_PIPE_SCRIPT], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    child.stderr.on('data', () => {}); // 只吞掉（固定错误文案，不透出内容）
    child.on('error', e => reject(new PrivateStoreError('PSR_PRIVATE_DPAPI', 'DPAPI 解密进程启动失败。')));
    // stdin 两行：第一行=密文；第二行=管道名（管道名不进 argv，脚本字节固定可哈希）
    child.stdin.write(cipherHex.trim() + '\n' + pipeName + '\n');
    child.stdin.end();
    const deadline = Date.now() + 10000;
    const tryRead = () => {
      let data = null;
      try {
        data = fs.readFileSync('\\\\.\\pipe\\' + pipeName);
      } catch (e) {
        if (Date.now() < deadline) { setTimeout(tryRead, 25); return; }
        try { child.kill(); } catch (_) {}
        reject(new PrivateStoreError('PSR_PRIVATE_DPAPI', 'DPAPI 解密失败（管道通道超时）。'));
        return;
      }
      try {
        const plain = data.toString('utf8');
        const payload = JSON.parse(plain);
        if (!payload || payload.schema !== PAYLOAD_SCHEMA) throw new Error('schema');
        resolve(plain);
      } catch (_) {
        reject(new PrivateStoreError('PSR_PRIVATE_PAYLOAD', '私密负载 schema 不符或解密失败。'));
      }
    };
    tryRead();
  });
}

/**
 * 完整录入管线：校验 → 构造绑定负载 → DPAPI 加密 → 排他新建（wx）→ 净化回执。
 * EEXIST 竞态归他属（PSR_PRIVATE_EXISTS，不记自身 partialWrite，R4）。
 */
function protectRecord({ repoRoot, fileName, participantCode, fullAccount, fullAccountRepeat, appId, envId, roundId, serverTimeIso, sourceDigest, closeSourceDir, expectedTarget, windowStartsAtIso, windowExpiresAtIso, deliveryConfirmed }) {
  if (typeof fullAccount !== 'string' || fullAccount !== fullAccountRepeat) {
    fail('PSR_PRIVATE_INPUT', '两次输入不一致（不回显输入）。');
  }
  const { repoAbs, targetAbs, relFromRepo } = validatePrivateTarget({ repoRoot, relativePath: PRIVATE_ROOT_REL + '/' + (fileName || ('participant-' + participantCode + '-' + crypto.randomBytes(4).toString('hex') + '.bin')) });
  const payload = buildPrivatePayload({ participantCode, fullAccount, appId, envId, roundId, serverTimeIso, sourceDigest, closeSourceDir, expectedTarget, windowStartsAtIso, windowExpiresAtIso, deliveryConfirmed });
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
    roundId,
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
  return Object.freeze(payload);
}

/**
 * 枚举私密根内全部记录并解密（R4：1/2 排重的输入）。
 * 返回 [{ fileName, payload }]；排除非 .bin 文件。
 */
async function readAllRecordsAsync({ repoRoot }) {
  const rootAbs = path.resolve(path.resolve(repoRoot), PRIVATE_ROOT_REL);
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(rootAbs, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.bin')) continue;
    try {
      const payload = await readRecordAsync({ repoRoot, relativePath: PRIVATE_ROOT_REL + '/' + e.name });
      out.push({ fileName: e.name, payload });
    } catch (_) { /* 不可读/不可解密的历史文件跳过（R4：仅可消费的记录参与绑定与排重） */ }
  }
  return out;
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
  computeCloseSourceDigest,
  buildPrivatePayload,
  dpapiProtect,
  dpapiUnprotectAsync,
  protectRecord,
  readRecordAsync,
  readAllRecordsAsync,
  verifyParticipantDedup,
  tailOf,
  FIXED_TARGET: Object.freeze({ appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723' })
});

// CLI：protect（明文经 stdin；不进 argv/env）。供 participant-private-input.ps1 调用。
// R4：交付确认必须显式传 --delivery-confirmed true；来源摘要对 --close-source-dir 重算核验。
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
    const roundId = getArg('round-id');
    const sourceDigest = getArg('source-digest');
    const closeSourceDir = getArg('close-source-dir');
    const deliveryConfirmed = getArg('delivery-confirmed') === 'true';
    const serverTimeIso = getArg('server-time-iso');
    const fileName = getArg('file-name');
    let plain = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { plain += d; });
    process.stdin.on('end', () => {
      try {
        const receipt = protectRecord({
          repoRoot, participantCode,
          fullAccount: plain.replace(/\r?\n$/, ''),
          fullAccountRepeat: plain.replace(/\r?\n$/, ''),
          appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723',
          roundId, serverTimeIso: serverTimeIso === null ? null : (serverTimeIso || null),
          closeSourceDir, expectedTarget: { appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723' },
          windowStartsAtIso: getArg('window-starts-at-iso') || undefined,
          windowExpiresAtIso: getArg('window-expires-at-iso') || undefined,
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
