'use strict';
// 本包专用本地能力。公共 child_process 不参与分发；不提供命令/options 透传接口。
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
// C1：原生命令输出严格解码辅助（编码契约见 docs/证据/CodeBuddy本地编码模块兼容返修-20261024.json S1–S3）
const decoder = require('./participant-native-decoder.cjs');
const rawSync = cp.spawnSync, rawSpawn = cp.spawn, pipeConnect = net.connect;
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
function scope(repo, rel) {
  if (path.resolve(repo) !== REPO || typeof rel !== 'string' || !rel || rel.includes('\0')) fail();
  const abs = path.resolve(REPO, rel), back = path.relative(REPO, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) fail();
  return back.replace(/\\/g, '/');
}
// 通道解码契约（C0 取证确认，见 decoder 模块头注释）：
// - git：ASCII 协议（core.quotepath）；- native：OEM CP 936 严格解码（本机取证）；
// - ps-stdout：hex 密文 UTF-8 协议。原始字节先按真实字节限额，再严格解码。
function decodeChannel(buf, channel) {
  if (channel === 'git') return decoder.decodeAscii(buf);
  if (channel === 'native') return decoder.decodeNative(buf);
  if (channel === 'ps-stdout') return decoder.decodeUtf8Strict(buf);
  return fail();
}
function sync(exe, args, input, outChannel, errChannel) {
  if (!fs.statSync(exe).isFile()) fail();
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  // C1：encoding 移除——spawnSync 返回原始 Buffer；先按真实字节限额，再按通道严格解码。
  const r = rawSync(exe, args, { cwd: REPO, input, windowsHide: true,
    shell: false, env, timeout: TIMEOUT, maxBuffer: LIMIT });
  if (!r || r.error || r.signal || ![0, 1].includes(r.status) ||
    (r.stdout && r.stdout.length > LIMIT) || (r.stderr && r.stderr.length > LIMIT)) fail();
  let out = '', err = '';
  try {
    out = decodeChannel(r.stdout || Buffer.alloc(0), outChannel);
    err = decodeChannel(r.stderr || Buffer.alloc(0), errChannel);
  } catch (_) {
    // 解码不确定与命令失败分开记录（decoder 固定错误码），对外仍为固定错误，不透出原始内容。
    return fail();
  }
  return { status: r.status, stdout: out, stderr: err };
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
  const r = sync(EXES.icacls, [scope(repo, rel)], undefined, 'native', 'native');
  if (r.status !== 0 || r.stderr.trim() || !r.stdout.trim()) fail(); return r;
}
function queryIdentity() {
  const r = sync(EXES.whoami, ['/user', '/fo', 'csv', '/nh'], undefined, 'native', 'native');
  if (r.status !== 0 || r.stderr.trim() || !r.stdout.trim()) fail(); return r;
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
module.exports = Object.freeze({ queryGit, queryAcl, queryIdentity, protect, unprotect,
  PROTECT, UNPROTECT, TIMEOUT, LIMIT, PSHOME_MODULE_INIT, decoder });
