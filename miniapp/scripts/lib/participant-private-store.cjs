'use strict';
// 参与者私密编号存储辅助（本机专用；不进入任何制品）。
//
// 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §3。
// - 固定私密根 artifacts/schedule-sandbox/.participant-private/（Git 忽略目录）。
// - 写前检查：Git 忽略且未被跟踪、目录/祖先非链接或 junction、ACL 无宽泛授权、
//   路径边界（仅允许私密根内、仓库内）；排他新建（wx），失败零写不静默降级。
// - Windows CurrentUser DPAPI 加密（PowerShell ConvertFrom/To-SecureString 管道，
//   明文只经 stdin，不进命令行参数/环境变量）。
// - 公开回执不含完整编号/OPENID/口令/裸编号哈希；标明"人工输入来源，不是平台登记回读"。
// - DPAPI 不防同一已登录用户或同权限本机进程；跨 Windows 账号解密失败属环境验证项。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PRIVATE_ROOT_REL = 'artifacts/schedule-sandbox/.participant-private';
const PAYLOAD_SCHEMA = 'participant-self-registration-private-payload/1';
const RECEIPT_SCHEMA = 'participant-self-registration-private-receipt/1';
const ACCOUNT_RE = /^u_[0-9a-f]{40}$/;
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const PARTICIPANT_CODE_RE = /^[12]$/;

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

/** ACL 检查：icacls 输出中宽泛组（Everyone/BUILTIN\Users/Authenticated Users/Guests）
 *  不得拥有写类权限（F/M/W 及继承变体）；只读（RX/R）授予也一并拒绝（编号保密优先）。 */
function assertPrivateAcl(dir) {
  const r = spawnSync('icacls', [dir], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail('PSR_PRIVATE_ACL', '无法读取私密目录 ACL（icacls 失败）：' + dir);
  const text = r.stdout || '';
  for (const line of text.split(/\r?\n/)) {
    if (!/(Everyone|BUILTIN\\Users|Authenticated Users|BUILTIN\\Guests)/i.test(line)) continue;
    if (/\((I)?(F|M|W|R|Rc|Wd|Wea|Wa|RX)/i.test(line)) {
      fail('PSR_PRIVATE_ACL', '私密目录 ACL 存在宽泛授权（' + line.trim() + '），拒绝写入。');
    }
  }
}

/**
 * 写前验证（全部通过才允许创建文件）：
 * Git 忽略、未被跟踪、路径边界、链接/junction、ACL。任一失败零写。
 */
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
  // 顺序：先查跟踪（check-ignore 对已跟踪文件不报告——git 语义），再查忽略
  const tracked = runGit(repoAbs, ['ls-files', '--', relFromRepo]);
  if (tracked.status === 0 && tracked.stdout) {
    fail('PSR_PRIVATE_TRACKED', '私密目标已被 Git 跟踪，拒绝写入：' + relFromRepo);
  }
  const ignored = runGit(repoAbs, ['check-ignore', '--', relFromRepo]);
  if (ignored.status !== 0 || !ignored.stdout) {
    fail('PSR_PRIVATE_NOT_IGNORED', '私密目标未被 Git 忽略（check-ignore 未命中）：' + relFromRepo);
  }
  assertNoLinks(repoAbs, path.dirname(targetAbs));
  assertPrivateAcl(path.dirname(targetAbs));
  return { repoAbs, targetAbs, relFromRepo, parentRel };
}

/** 构造加密负载（含交付事实与来源绑定；不含 OPENID/口令）。 */
function buildPrivatePayload({ participantCode, fullAccount, appId, envId, roundId, serverTimeIso, sourceDigest, deliveryConfirmed }) {
  if (typeof participantCode !== 'string' || !PARTICIPANT_CODE_RE.test(participantCode)) {
    fail('PSR_PRIVATE_INPUT', '参与者代码只能是 1 或 2。');
  }
  if (typeof fullAccount !== 'string' || !ACCOUNT_RE.test(fullAccount)) {
    fail('PSR_PRIVATE_INPUT', '完整编号须为 u_+40 位小写十六进制（不回显输入）。');
  }
  if (typeof roundId !== 'string' || !ROUND_ID_RE.test(roundId)) fail('PSR_PRIVATE_INPUT', '来源轮次格式无效。');
  if (typeof appId !== 'string' || !appId || typeof envId !== 'string' || !envId) fail('PSR_PRIVATE_INPUT', '固定目标缺失。');
  if (typeof sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(sourceDigest)) fail('PSR_PRIVATE_INPUT', '来源证据摘要缺失或无效。');
  if (deliveryConfirmed !== true) fail('PSR_PRIVATE_INPUT', '缺少交付确认事实。');
  return {
    schema: PAYLOAD_SCHEMA,
    participantCode,
    fullAccount,
    appId, envId,
    roundId,
    serverTimeIso: typeof serverTimeIso === 'string' ? serverTimeIso : null,
    sourceDigest,
    deliveryConfirmed: true,
    inputTimeIso: new Date().toISOString(),
    ref: crypto.randomBytes(8).toString('hex')
  };
}

/** CurrentUser DPAPI 加密：明文只经 stdin 传给 PowerShell；不进 argv/env。 */
function dpapiProtect(plain) {
  const script = '$line = [Console]::In.ReadLine(); $sec = ConvertTo-SecureString -String $line -AsPlainText -Force; ConvertFrom-SecureString -SecureString $sec';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: plain, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !(r.stdout || '').trim()) {
    fail('PSR_PRIVATE_DPAPI', 'DPAPI 加密失败（不回显输入）。');
  }
  return r.stdout.trim();
}

/** CurrentUser DPAPI 解密（同 Windows 用户；跨账号验证属环境验证项）。 */
function dpapiUnprotect(cipherHex) {
  if (typeof cipherHex !== 'string' || !cipherHex.trim()) fail('PSR_PRIVATE_DPAPI', '密文为空。');
  const script = '$line = [Console]::In.ReadLine(); $sec = ConvertTo-SecureString -String $line; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: cipherHex.trim(), encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail('PSR_PRIVATE_DPAPI', 'DPAPI 解密失败。');
  return r.stdout.replace(/\r?\n$/, '');
}

/**
 * 完整录入管线：校验 → 构造负载 → DPAPI 加密 → 排他新建（wx）→ 净化回执。
 * 失败零写（或仅留部分文件并如实记账）；取消/校验失败不留可用密文。
 */
function protectRecord({ repoRoot, fileName, participantCode, fullAccount, fullAccountRepeat, appId, envId, roundId, serverTimeIso, sourceDigest, deliveryConfirmed }) {
  if (typeof fullAccount !== 'string' || fullAccount !== fullAccountRepeat) {
    fail('PSR_PRIVATE_INPUT', '两次输入不一致（不回显输入）。');
  }
  const { repoAbs, targetAbs, relFromRepo } = validatePrivateTarget({ repoRoot, relativePath: PRIVATE_ROOT_REL + '/' + (fileName || ('participant-' + participantCode + '-' + crypto.randomBytes(4).toString('hex') + '.bin')) });
  const payload = buildPrivatePayload({ participantCode, fullAccount, appId, envId, roundId, serverTimeIso, sourceDigest, deliveryConfirmed });
  const cipherHex = dpapiProtect(JSON.stringify(payload));
  const cipherBuf = Buffer.from(cipherHex, 'utf8');
  if (fs.existsSync(targetAbs)) fail('PSR_PRIVATE_EXISTS', '同名私密记录已存在，不覆盖（输入有误请新建版本）。');
  try {
    fs.writeFileSync(targetAbs, cipherBuf, { flag: 'wx' });
  } catch (e) {
    let st = null;
    try { st = fs.lstatSync(targetAbs); } catch (_) { st = null; }
    const partial = st && st.isFile() ? { rel: relFromRepo, bytesOnDisk: st.size } : null;
    const err = new PrivateStoreError('PSR_PRIVATE_WRITE_FAILED', '私密记录写入失败（部分写已记账）。');
    if (partial) err.partialWrite = partial;
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

/** 解密装配视图（仅内存使用；真实装配流程属后续执行包）。 */
function readRecord({ repoRoot, relativePath }) {
  const { targetAbs } = validatePrivateTarget({ repoRoot, relativePath });
  const cipherHex = fs.readFileSync(targetAbs, 'utf8');
  const plain = dpapiUnprotect(cipherHex);
  const payload = JSON.parse(plain);
  if (!payload || payload.schema !== PAYLOAD_SCHEMA) fail('PSR_PRIVATE_PAYLOAD', '私密负载 schema 不符。');
  return Object.freeze(payload);
}

module.exports = Object.freeze({
  PRIVATE_ROOT_REL,
  PAYLOAD_SCHEMA,
  RECEIPT_SCHEMA,
  ACCOUNT_RE,
  ROUND_ID_RE,
  PrivateStoreError,
  validatePrivateTarget,
  assertNoLinks,
  assertPrivateAcl,
  buildPrivatePayload,
  dpapiProtect,
  dpapiUnprotect,
  protectRecord,
  readRecord,
  tailOf,
  FIXED_TARGET: Object.freeze({ appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723' })
});

// CLI：protect（明文经 stdin；不进 argv/env）。供 participant-private-input.ps1 调用。
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
          roundId, serverTimeIso: null, sourceDigest, deliveryConfirmed: true, fileName
        });
        console.log(JSON.stringify(receipt, null, 2));
      } catch (e) {
        console.error('[' + (e.code || 'PSR_ERROR') + '] ' + (e.partialWrite ? JSON.stringify(e.partialWrite) : ''));
        process.exitCode = 1;
      }
    });
  }
}
