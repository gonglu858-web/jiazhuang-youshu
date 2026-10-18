// 本地守卫/受控 runner 辅助模块（仅测试与证据脚本使用；非产品代码、不进入任何制品）。
// 依据：docs/Codex复查-提前准备C1C4收尾-20261018.md §2 R2/R3 —— 将守卫、受控 runner 与
// 回执统一校验收敛到单一模块，避免证据脚本与测试各自实现产生遗漏。
// 语义：除显式 probe 阶段外，一切守卫命中（含初始化/setup/业务期，含被 catch 者）都计入意外；
// 公共 child_process API 完全拒绝；唯一原始 spawn 由本模块闭包持有的受控 runner 使用，
// 固定命令=process.execPath、脚本必须在白名单、必须携带守卫 preload 与回执环境变量。
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const EXPECTED_PROBES = 2;

/**
 * 安装父进程离线守卫。网络面：http/https/fetch/tls/dns/dns.promises/net/Socket.prototype.connect；
 * 进程面：child_process 全部公共 API。全部阻断并记账（含被 catch 者——记账先于抛错）。
 * opts.hits：记账数组（元素 {phase, api}）；opts.getPhase()：当前阶段；opts.allowedScripts：runner 可运行脚本的绝对路径白名单。
 * 返回 { runCli, restoreAll, newReceiptPath }。
 */
function installParentGuards(opts) {
  if (!opts || !Array.isArray(opts.hits) || typeof opts.getPhase !== 'function' || !Array.isArray(opts.allowedScripts)) {
    throw Error('installParentGuards 需要 hits/getPhase/allowedScripts');
  }
  const cp = require('node:child_process');
  const origSpawn = cp.spawn; // 原始 spawn 在任何补丁之前捕获；仅本闭包的受控 runner 可用
  const record = api => { opts.hits.push({ phase: opts.getPhase(), api }); };
  const blocked = api => function () { record(api); throw Error('OFFLINE_GUARD:' + api); };
  const restoreFns = [];
  const patch = (obj, k, api) => { const old = obj[k]; obj[k] = blocked(api); restoreFns.push(() => { obj[k] = old; }); };
  for (const m of ['node:http', 'node:https']) {
    const mod = require(m);
    for (const k of ['get', 'request']) patch(mod, k, m + '.' + k);
  }
  try { patch(require('node:tls'), 'connect', 'tls.connect'); } catch (_) {}
  if (typeof globalThis.fetch === 'function') patch(globalThis, 'fetch', 'fetch');
  const dns = require('node:dns');
  for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) patch(dns, k, 'dns.' + k);
  for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) patch(dns.promises, k, 'dns.promises.' + k);
  const net = require('node:net');
  for (const k of ['connect', 'createConnection']) patch(net, k, 'net.' + k);
  patch(net.Socket.prototype, 'connect', 'socket.connect');
  // 进程面：公共 API 一律拒绝（不检查脚本名——绕过受控 runner 的任何尝试都计意外）
  patch(cp, 'spawn', 'child_process.spawn');
  for (const k of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) patch(cp, k, 'cp.' + k);
  return {
    /** 受控 runner：固定命令=process.execPath；scriptPath 必须在 allowedScripts；
     *  必须提供 guardPreload 与 receiptPath（回执由子进程退出钩子写入）。
     *  输出按字节上限截断并标记；超时 SIGKILL；spawn 错误回传；结果含 childPid 供回执核对。 */
    runCli({ scriptPath, args, guardPreload, receiptPath, timeoutMs = 60000, outputLimit = 256 * 1024 }) {
      const fail = reason => Promise.resolve({ code: -1, out: '', err: '', outBounded: false, errBounded: false, timedOut: false, spawnError: reason, receipt: null, receiptError: 'runner 拒绝：' + reason, childPid: null, receiptPath: receiptPath || null, validation: { failures: [reason], childUnexpected: 0 } });
      if (typeof scriptPath !== 'string' || !opts.allowedScripts.includes(scriptPath)) return fail('脚本不在受控白名单');
      if (!guardPreload || !fs.existsSync(guardPreload)) return fail('缺少守卫 preload');
      if (!receiptPath) return fail('缺少回执路径');
      const child = origSpawn(process.execPath, [scriptPath, ...args], {
        env: Object.assign({}, process.env, {
          NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require ' + guardPreload,
          PIC_CLI_GUARD_RECEIPT: receiptPath
        }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return new Promise(resolve => {
        let out = '', err = '', outBounded = false, errBounded = false, timedOut = false;
        child.stdout.on('data', d => { if (out.length < outputLimit) out += d; else outBounded = true; });
        child.stderr.on('data', d => { if (err.length < outputLimit) err += d; else errBounded = true; });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        const base = (code, spawnError) => {
          clearTimeout(timer);
          let receipt = null, receiptError = null;
          try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch (e) { receiptError = e.message; }
          return { code, out, err, outBounded, errBounded, timedOut, spawnError: spawnError || null, receipt, receiptError, childPid: child.pid, receiptPath };
        };
        child.on('error', spawnError => resolve(base(-1, String(spawnError && spawnError.message))));
        child.on('close', code2 => resolve(base(code2, null)));
      });
    },
    newReceiptPath(tag) {
      const dir = path.resolve(__dirname, '..', '..', '..', 'artifacts', 'schedule-sandbox', 'business-test');
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, 'cli-receipt-' + (tag || 'x') + '-' + crypto.randomBytes(5).toString('hex') + '.json');
    },
    /** 受控自反例 runner：白名单脚本的原始 spawn（无 CLI 回执；有超时/有界输出/启动错误处理）。 */
    rawSpawn(scriptPath, args, { timeoutMs = 60000, outputLimit = 256 * 1024, extraEnv } = {}) {
      if (!opts.allowedScripts.includes(scriptPath)) {
        return Promise.resolve({ code: -1, out: '', err: '', spawnError: '脚本不在受控白名单', outBounded: false, errBounded: false, timedOut: false });
      }
      const child = origSpawn(process.execPath, [scriptPath, ...args], {
        env: extraEnv ? Object.assign({}, process.env, extraEnv) : process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return new Promise(resolve => {
        let out = '', err = '', outBounded = false, errBounded = false, timedOut = false;
        child.stdout.on('data', d => { if (out.length < outputLimit) out += d; else outBounded = true; });
        child.stderr.on('data', d => { if (err.length < outputLimit) err += d; else errBounded = true; });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.on('error', spawnError => { clearTimeout(timer); resolve({ code: -1, out, err, spawnError: String(spawnError && spawnError.message), outBounded, errBounded, timedOut }); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, out, err, spawnError: null, outBounded, errBounded, timedOut }); });
      });
    },
    restoreAll() { restoreFns.reverse().forEach(f => f()); }
  };
}

/**
 * 子进程守卫 preload 源码（R3 对齐网络面：含 dns.promises 与 Socket.prototype.connect）。
 * 阻断并计数；进程退出钩子以结构化回执写回（pid/unexpected/exitCode）。
 */
function buildGuardPreloadSource() {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const hits = [];",
    "const blocked = name => { hits.push(name); throw new Error('CLI_OFFLINE_GUARD:' + name); };",
    "for (const m of ['http', 'https']) { const mod = require(m); mod.request = blocked.bind(null, m + '.request'); mod.get = blocked.bind(null, m + '.get'); }",
    "try { const tls = require('node:tls'); tls.connect = blocked.bind(null, 'tls.connect'); } catch (_) {}",
    "if (typeof globalThis.fetch === 'function') globalThis.fetch = blocked.bind(null, 'fetch');",
    "const dns = require('node:dns'); for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[k] = blocked.bind(null, 'dns.' + k);",
    "const dnsp = require('node:dns').promises; for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) dnsp[k] = blocked.bind(null, 'dns.promises.' + k);",
    "const net = require('node:net'); net.connect = blocked.bind(null, 'net.connect'); net.createConnection = blocked.bind(null, 'net.createConnection');",
    "net.Socket.prototype.connect = blocked.bind(null, 'socket.connect');",
    "const cp = require('node:child_process'); for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[k] = blocked.bind(null, 'cp.' + k);",
    "process.on('exit', () => {",
    "  try {",
    "    const p = process.env.PIC_CLI_GUARD_RECEIPT;",
    "    if (p) fs.writeFileSync(p, JSON.stringify({ pid: process.pid, unexpected: hits, exitCode: process.exitCode === undefined ? null : process.exitCode }) + String.fromCharCode(10), { flag: 'wx' });",
    "  } catch (_) {}",
    "});"
  ].join('\n');
}

/**
 * 回执统一校验（R2）：所有子进程结果无差别核验（预期 CLI 业务 exit1 不豁免）。
 * 核对：结构完整（pid 数值、unexpected 数组、exitCode 字段）、pid 与实际子进程一致、
 * 回执 exitCode 与实际退出状态一致、意外计数、超时/spawn 错误/输出越界。
 * 返回 { failures: [描述], childUnexpected: 数值 }。
 */
function validateChildResult(r) {
  const failures = [];
  if (r.validation && Array.isArray(r.validation.failures)) return { failures: r.validation.failures.slice(), childUnexpected: 0 };
  if (r.spawnError) failures.push('spawn 错误：' + r.spawnError);
  if (r.timedOut) failures.push('子进程超时被杀');
  if (r.outBounded || r.errBounded) failures.push('输出超过上限被截断');
  if (!r.receipt) {
    failures.push('回执缺失或畸形' + (r.receiptError ? '：' + r.receiptError : ''));
  } else {
    if (typeof r.receipt.pid !== 'number') failures.push('回执缺少数值 pid');
    else if (r.childPid !== undefined && r.receipt.pid !== r.childPid) failures.push('回执 pid 与实际子进程不符');
    if (!Array.isArray(r.receipt.unexpected)) failures.push('回执缺少 unexpected 数组');
    else if (r.receipt.unexpected.length > 0) failures.push('子意外 ' + r.receipt.unexpected.length + ' 项：' + r.receipt.unexpected.join(', '));
    if (!Object.prototype.hasOwnProperty.call(r.receipt, 'exitCode')) failures.push('回执缺少 exitCode 字段');
    else {
      const exitOk = r.receipt.exitCode === null ? r.code === 0 : r.receipt.exitCode === r.code;
      if (!exitOk) failures.push('回执 exitCode 与实际退出状态不一致（回执=' + r.receipt.exitCode + '，实际=' + r.code + '）');
    }
  }
  return { failures, childUnexpected: r.receipt && Array.isArray(r.receipt.unexpected) ? r.receipt.unexpected.length : 0 };
}

/**
 * 真实判定出口（R2）：同一函数既用于证据最终 ok/exit 设置，也用于敏感性断言。
 * 探针数必须恰为期望值；父意外、子意外合计、回执失败必须全为 0。
 */
function verdictFor({ probes, parentUnexpected, childUnexpectedTotal, receiptFailures, expectedProbes = EXPECTED_PROBES }) {
  const ok = probes === expectedProbes && parentUnexpected === 0 && childUnexpectedTotal === 0 && receiptFailures === 0;
  return { ok, exitCode: ok ? 0 : 1 };
}

module.exports = Object.freeze({
  EXPECTED_PROBES,
  installParentGuards,
  buildGuardPreloadSource,
  validateChildResult,
  verdictFor
});
