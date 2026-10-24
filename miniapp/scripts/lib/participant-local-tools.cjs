'use strict';
// 本包专用本地能力。公共 child_process 不参与分发；不提供命令/options 透传接口。
// A2（Codex 复查接续 545d038）：原始进程/管道引用经 participant-native-exec 捕获层
// 获取（该层在本包装载序列中最先执行）；本模块不直接触碰公共 cp/net 方法。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// C1：原生命令输出严格解码辅助（编码契约由本模块 verifyNativeEncodingContract 受控建立）
const decoder = require('./participant-native-decoder.cjs');
// A2：原始引用捕获层（spawnSync/spawn/connect；含实际调用记录）
const nativeExec = require('./participant-native-exec.cjs');
const rawSync = nativeExec.spawnSync, rawSpawn = nativeExec.spawn, pipeConnect = nativeExec.connect;
const REPO = path.resolve(__dirname, '../../..');
const EXES = Object.freeze({ git: 'C:\\Program Files\\Git\\cmd\\git.exe',
  whoami: 'C:\\Windows\\System32\\whoami.exe', icacls: 'C:\\Windows\\System32\\icacls.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
const LIMIT = 128 * 1024, TIMEOUT = 10000;
// C2：固定 Windows PowerShell 程序的 $PSHOME 内置系统模块显式初始化（失败即停止）。
// PROTECT/UNPROTECT 实际所需 cmdlet：ConvertTo/ConvertFrom-SecureString（Security 模块）、
// ConvertFrom-Json（Utility 模块）。按 -Name 固定 $PSHOME 路径加载，不遍历模块、
// 不按 PATH/可覆盖模块名选择、不改 PSModulePath、失败无回退（ErrorAction=Stop）。
const PSHOME_MODULE_INIT = '$ErrorActionPreference = "Stop"; ' +
  'Import-Module -Name (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security") -ErrorAction Stop; ' +
  'Import-Module -Name (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Utility") -ErrorAction Stop; ';
const PROTECT = PSHOME_MODULE_INIT + '$line = [Console]::In.ReadLine(); $sec = ConvertTo-SecureString -String $line -AsPlainText -Force; ConvertFrom-SecureString -SecureString $sec';
const UNPROTECT = PSHOME_MODULE_INIT + '$ErrorActionPreference="Stop"; $cipher = [Console]::In.ReadLine(); $pipeName = [Console]::In.ReadLine(); $sec = ConvertTo-SecureString -String $cipher; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); $null = $plain | ConvertFrom-Json; $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($pipeName, [System.IO.Pipes.PipeDirection]::Out); $pipe.WaitForConnection(); $w = New-Object System.IO.StreamWriter($pipe); $w.Write($plain); $w.Flush(); $pipe.Dispose();';
function fail() { const e = new Error('本地工具未完成或结果不确定'); e.code = 'PSR_LOCAL_TOOL_FAILED'; throw e; }
// R3：解码不确定与命令失败以固定无敏感文本原因区分（不含原始身份/ACL/stderr）。
function failDecode() { const e = new Error('本地工具输出解码不确定'); e.code = 'PSR_NATIVE_DECODE_UNCERTAIN'; throw e; }
function scope(repo, rel) {
  if (path.resolve(repo) !== REPO || typeof rel !== 'string' || !rel || rel.includes('\0')) fail();
  const abs = path.resolve(REPO, rel), back = path.relative(REPO, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) fail();
  return back.replace(/\\/g, '/');
}
// 通道解码契约（C0 取证 + R1 受控检查确认；见 verifyNativeEncodingContract）：
// - git：ASCII 协议（core.quotepath）；- native：OEM CP 936 严格解码（工具实际输出
//   语义锚定受控建立，非代码页推导）；- ps-stdout：hex 密文 UTF-8 协议。
// 原始字节先按真实字节限额，再严格解码。
function decodeChannel(buf, channel) {
  if (channel === 'git') return decoder.decodeAscii(buf);
  if (channel === 'native') return decoder.decodeNative(buf);
  if (channel === 'ps-stdout') return decoder.decodeUtf8Strict(buf);
  return fail();
}
// R1：统一结果核验——全部固定命令一律检查启动错误、超时/信号、状态、stdout/stderr
// 的 Buffer 类型与字节上限；native 通道统一要求 stderr 为空（命令失败与解码不确定
// 分别以固定原因分类，不含原始内容）。
function sync(exe, args, input, outChannel, errChannel) {
  if (!fs.statSync(exe).isFile()) fail();
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  // C1：encoding 移除——spawnSync 返回原始 Buffer；先按真实字节限额，再按通道严格解码。
  const r = rawSync(exe, args, { cwd: REPO, input, windowsHide: true,
    shell: false, env, timeout: TIMEOUT, maxBuffer: LIMIT });
  if (!r || r.error || r.signal || ![0, 1].includes(r.status) ||
    (r.stdout !== undefined && !Buffer.isBuffer(r.stdout)) ||
    (r.stderr !== undefined && !Buffer.isBuffer(r.stderr)) ||
    (r.stdout && r.stdout.length > LIMIT) || (r.stderr && r.stderr.length > LIMIT)) fail();
  let out = '', err = '';
  try {
    out = decodeChannel(r.stdout || Buffer.alloc(0), outChannel);
    err = decodeChannel(r.stderr || Buffer.alloc(0), errChannel);
  } catch (e) {
    // R3：解码不确定单独分类（固定文本），与命令失败区分；均不透出原始内容。
    if (e && e.code === decoder.ERROR_CODE) throw failDecode();
    return fail();
  }
  if (err.trim()) fail(); // 固定命令不接受任何 stderr 输出（统一规则）
  // outRaw/outHighBytes 仅用于编码契约受控检查（内存内，不外传原始内容）。
  return { status: r.status, stdout: out, stderr: err,
    outRaw: r.stdout || Buffer.alloc(0), outHighBytes: r.stdout ? [...r.stdout].filter(b => b >= 0x80).length : 0 };
}
// ── R1/A3：原生命令输出编码适用性受控检查（产品调用前强制；固定只读探针） ──
// 契约依据 = 工具实际输出（icacls 对仓库根的**完整统计行**语义锚定 + 双编码可区分性），
// 不使用 Console/ANSI 代码页推导。契约**按程序/输出通道限定**：icacls 探针只授权
// icacls 管道输出；whoami 无独立非 ASCII 证据时保守要求 ASCII-only 输出（身份查询
// 本身是唯一来源，查询后按实际字节判定；本机当前为 ASCII）。
// blocked 不猜编码、不改代码页、无回退。
// A3：统计行**完整行级锚定**（行首行尾+唯一+失败数 0+无矛盾统计行），拒绝前后垃圾。
const STATS_LINE_RE = /^(?:已成功处理\s*(\d+)\s*个文件[;；]\s*处理\s*(\d+)\s*个文件时失败[。.]?|Successfully processed (\d+) files; Failed processing (\d+) files[.]?)$/gm;
const STATS_LINE_LOOSE_RE = /(?:已成功处理\s*\d+\s*个文件[;；]\s*处理\s*\d+\s*个文件时失败|Successfully processed \d+ files; Failed processing \d+ files)/g;
/** 完整统计行锚定：恰一条完整统计行、失败数 0、且无矛盾/垃圾统计变体。 */
function anchorVerdict(text) {
  const norm = String(text).replace(/\r\n/g, '\n'); // 原生命令 CRLF 行尾归一化（仅用于锚定判定）
  const strict = [...norm.matchAll(STATS_LINE_RE)].map(m => ({
    processed: Number(m[1] !== undefined ? m[1] : m[3]),
    failed: Number(m[2] !== undefined ? m[2] : m[4])
  }));
  const loose = (norm.match(STATS_LINE_LOOSE_RE) || []).length;
  return { count: strict.length, failedZero: strict.length === 1 && strict[0].failed === 0,
    noContradiction: strict.length === loose, // 严格=宽松 ⇒ 无部分匹配垃圾/矛盾行
    anchored: strict.length === 1 && strict[0].failed === 0 && strict.length === loose };
}
const nativeContractState = { icaclsPipe: null }; // null=未检查；{state,basis,probe,highBytes,utf8Decoded,utf8Anchor}
function contractBlocked(reason) {
  const e = new Error('原生命令输出编码契约未建立（blocked）：' + reason);
  e.code = 'PSR_NATIVE_CONTRACT_BLOCKED';
  throw e;
}
function verifyIcaclsPipeContract() {
  const st = nativeContractState.icaclsPipe;
  if (st) {
    if (st.state === 'established') return;
    return contractBlocked(st.reason);
  }
  let r = null;
  try { r = sync(EXES.icacls, ['.'], undefined, 'native', 'native'); }
  catch (e) {
    nativeContractState.icaclsPipe = { state: 'blocked', reason: 'contract_probe_command_failed' };
    throw e;
  }
  // 探针命令失败（status≠0/无输出）按命令失败分类 blocked，不进入编码判定。
  if (r.status !== 0 || !r.stdout.trim()) {
    nativeContractState.icaclsPipe = { state: 'blocked', reason: 'contract_probe_command_failed' };
    return fail();
  }
  // 双编码可区分性判定（原始字节，仅内存；A3：utf8 解码成功与锚定分列）
  const highBytes = r.outHighBytes;
  let utf8Decoded = false, utf8Anchor = false, utf8Text = null;
  try {
    utf8Text = decoder.decodeUtf8Strict(r.outRaw);
    utf8Decoded = true;
    utf8Anchor = anchorVerdict(utf8Text).anchored;
  } catch (_) { utf8Decoded = false; }
  const gb = anchorVerdict(r.stdout);
  if (highBytes === 0) {
    nativeContractState.icaclsPipe = { state: 'blocked', reason: 'probe_output_all_ascii_undecidable' };
  } else if (gb.anchored && !utf8Anchor) {
    nativeContractState.icaclsPipe = { state: 'established', basis: 'tool_output_anchor',
      probe: 'icacls <repoRoot>', channel: 'icacls.pipe', highBytes,
      utf8Decoded, utf8Anchor, gbCount: gb.count };
  } else {
    nativeContractState.icaclsPipe = { state: 'blocked',
      reason: gb.anchored ? 'both_decodes_anchor_ambiguous'
        : (utf8Anchor ? 'utf8_only_contradicts_gb18030_contract' : 'no_complete_stats_line_anchor') };
  }
  if (nativeContractState.icaclsPipe.state !== 'established') contractBlocked(nativeContractState.icaclsPipe.reason);
}
/** A3：whoami 通道独立保守规则——输出必须 ASCII-only（非 ASCII 未独立证明即 blocked）。 */
function verifyWhoamiChannel(outHighBytes) {
  if (outHighBytes !== 0) {
    contractBlocked('whoami_non_ascii_not_independently_verified');
  }
}
function queryGit(repo, operation, rel) {
  if (!['check-ignore', 'ls-files'].includes(operation)) fail();
  const p = scope(repo, rel), r = sync(EXES.git, [operation, '--', p], undefined, 'git', 'git');
  if (r.stderr.trim() || (operation === 'ls-files' && r.status !== 0)) fail();
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.some(line => operation === 'check-ignore' ? line !== p : line !== p && !line.startsWith(p + '/'))) fail();
  if ((r.status === 1 && lines.length) || (operation === 'check-ignore' && r.status === 0 && lines.length !== 1)) fail();
  return r;
}
function queryAcl(repo, rel) {
  verifyIcaclsPipeContract(); // R1/A3：icacls 管道通道契约（探针缓存；只授权 icacls）
  const r = sync(EXES.icacls, [scope(repo, rel)], undefined, 'native', 'native');
  if (r.status !== 0 || r.stderr.trim() || !r.stdout.trim()) fail(); return r;
}
function queryIdentity() {
  // A3：whoami 通道不依赖 icacls 探针——身份输出必须 ASCII-only（本机当前事实），
  // 非 ASCII 未独立证明即保守 blocked，不猜编码、不放宽权限。
  const r = sync(EXES.whoami, ['/user', '/fo', 'csv', '/nh'], undefined, 'native', 'native');
  if (r.status !== 0 || r.stderr.trim() || !r.stdout.trim()) fail();
  verifyWhoamiChannel(r.outHighBytes);
  return r;
}
function protect(plain) {
  if (typeof plain !== 'string' || /[\r\n]/.test(plain) || Buffer.byteLength(plain) > LIMIT) fail();
  const r = sync(EXES.powershell, ['-NoProfile', '-NonInteractive', '-Command', PROTECT], plain + '\n', 'ps-stdout', 'ps-stdout');
  const cipher = r.stdout.trim();
  if (r.status !== 0 || r.stderr.trim() || !/^[0-9a-f]{32,}$/i.test(cipher)) fail(); return cipher;
}
function unprotect(cipher) {
  if (typeof cipher !== 'string' || !/^[0-9a-f]{32,}$/i.test(cipher) || cipher.length > LIMIT) return Promise.reject(new Error('密文无效'));
  // 异步管道读取，禁止 fs.readFileSync(pipe) 阻塞事件循环导致超时失效。
  return new Promise((resolve, reject) => {
    const name = 'psr-dpapi-' + crypto.randomBytes(16).toString('hex');
    let child, socket, retry, settled = false, chunks = [], size = 0, stderr = 0, value, closed = false;
    const maybeFinish = () => { if (closed && value !== undefined) finish(false, value); };
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(retry);
      if (socket) socket.destroy(); if (child) child.kill();
      if (error) reject(Object.assign(new Error('DPAPI管道未完成'), { code: 'PSR_LOCAL_TOOL_FAILED' })); else resolve(value);
    };
    const timer = setTimeout(() => finish(true), TIMEOUT);
    try {
      child = rawSpawn(EXES.powershell, ['-NoProfile', '-NonInteractive', '-Command', UNPROTECT],
        { cwd: REPO, windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
      child.on('error', () => finish(true));
      child.on('close', (code, signal) => { if (code !== 0 || signal) finish(true); else { closed = true; maybeFinish(); } });
      child.stderr.on('data', b => { stderr += b.length; finish(true); });
      child.stdin.on('error', () => finish(true)); child.stdin.end(cipher + '\n' + name + '\n');
      const connect = () => {
        if (settled) return;
        socket = pipeConnect('\\\\.\\pipe\\' + name);
        socket.on('error', () => { socket.destroy(); if (!settled) retry = setTimeout(connect, 25); });
        socket.on('data', b => { size += b.length; if (size > LIMIT) finish(true); else chunks.push(b); });
        socket.on('end', () => {
          try { value = Buffer.concat(chunks).toString('utf8'); JSON.parse(value); if (stderr > 0) finish(true); else maybeFinish(); }
          catch (_) { finish(true); }
        });
      }; connect();
    } catch (_) { finish(true); }
  });
}
// R1/A3：契约状态快照（按程序/通道限定；供证据/测试核对；不含原始身份/ACL 内容）
function nativeEncodingContract() {
  return Object.freeze({
    icaclsPipe: nativeContractState.icaclsPipe === null
      ? { state: 'unchecked' } : Object.freeze({ ...nativeContractState.icaclsPipe }),
    whoami: { rule: 'ascii_only_output_required', scope: 'whoami.pipe',
      note: '身份输出非 ASCII 即 blocked（非 ASCII 编码未独立证明；不依赖 icacls 探针授权）' }
  });
}
module.exports = Object.freeze({ queryGit, queryAcl, queryIdentity, protect, unprotect,
  PROTECT, UNPROTECT, TIMEOUT, LIMIT, PSHOME_MODULE_INIT, decoder, nativeEncodingContract,
  anchorVerdict,
  ERROR_CODES: Object.freeze({ TOOL: 'PSR_LOCAL_TOOL_FAILED', DECODE_UNCERTAIN: 'PSR_NATIVE_DECODE_UNCERTAIN', CONTRACT_BLOCKED: 'PSR_NATIVE_CONTRACT_BLOCKED' }) });
