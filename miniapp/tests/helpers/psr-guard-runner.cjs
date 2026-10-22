// 私密存储证据适配层 v2（不改已受审共享辅助模块；R6 返修版）。
// 依据：docs/Codex复查-指定本人登记与私密输入本地实现-20261021.md §2 R6。
// 政策：
// - 公共 child_process API 由共享守卫默认阻断并记账；本适配层替换共享守卫的
//   spawnSync 补丁为「白名单分发器」：仅放行下述固定形状的本地只读工具，
//   其余调用一律先记账（opts.hits，被 catch 也可见）再抛 OFFLINE_GUARD。
// - 白名单（全部只读）：
//     git check-ignore|ls-files（字符串参数）；
//     icacls <绝对路径>（单参数只读查询；无 grant/deny/reset）；
//     whoami /user|/groups /fo csv /nh（当前进程身份，固定参数集）；
//     powershell.exe -NoProfile -NonInteractive -Command <script>，其中 script 的
//     SHA-256 必须命中 allowedScriptHashes（字节级精确匹配——注释/尾随空白/伪装
//     标记都会改变哈希而被拒绝，R6）。
// - 放行调用全部记账（toolCalls，随证据 JSON 披露），不计入意外。
// - restore() 回到「共享守卫阻断态」（不恢复无守卫公共 API）；完全解除只应发生在
//   证据收尾的 guard.restoreAll()。
'use strict';
const cp = require('node:child_process');
const crypto = require('node:crypto');
const origSpawnSync = cp.spawnSync; // 原始调用（任何补丁之前捕获；仅白名单分发器可用）
const origSpawn = cp.spawn; // 原始异步 spawn（DPAPI 管道子进程；仅白名单分发器可用）

const WHOAMI_ARGSETS = [
  ['/user', '/fo', 'csv', '/nh'],
  ['/groups', '/fo', 'csv', '/nh'],
  [] // 当前用户显示名（harden 后缓存补全）
];
const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function isAllowedToolCall(cmd, args, allowedScriptHashes) {
  if (typeof cmd !== 'string' || !Array.isArray(args) || !args.every(a => typeof a === 'string')) return false;
  if (cmd === 'git') {
    return args.length >= 1 && ['check-ignore', 'ls-files'].includes(args[0]);
  }
  if (cmd === 'icacls') {
    // 只读查询：绝对路径或仓库内相对路径（无 .. 穿越）
    const pathOk = p => (typeof p === 'string' && p.length > 0
      && (/^[A-Za-z]:[\\/]/.test(p) || (!p.startsWith('.') && !p.includes('..'))));
    if (args.length === 1 && pathOk(args[0])) return true;
    // 收紧固定形状（R4/R6）：[path, /inheritance:r, /grant:r, <user>:F, /grant:r, SYSTEM:F]
    if (args.length === 6 && pathOk(args[0])
      && args[1] === '/inheritance:r' && args[2] === '/grant:r' && args[4] === '/grant:r'
      && /^[^\\/":*?<>|]+:F$/.test(args[3]) && args[5] === 'SYSTEM:F') return true;
    return false;
  }
  if (cmd === 'whoami') {
    return WHOAMI_ARGSETS.some(set => args.length === set.length && set.every((v, i) => args[i] === v));
  }
  if (cmd === 'powershell.exe') {
    return args.length === 4
      && args[0] === '-NoProfile' && args[1] === '-NonInteractive' && args[2] === '-Command'
      && allowedScriptHashes.includes(sha256(args[3]));
  }
  return false;
}

/**
 * 与共享 installParentGuards 相同的守卫 + 本地只读工具白名单分发器。
 * opts：{ hits, getPhase, allowedScripts, allowedScriptHashes }。
 * 返回 { guard, toolCalls, restore }；restore 回到阻断态（不解除守卫）。
 */
function installParentGuardsWithLocalTools(opts) {
  if (!opts || !Array.isArray(opts.hits) || typeof opts.getPhase !== 'function' || !Array.isArray(opts.allowedScripts)) {
    throw Error('缺少守卫配置');
  }
  if (!Array.isArray(opts.allowedScriptHashes) || opts.allowedScriptHashes.length === 0
    || !opts.allowedScriptHashes.every(h => /^[0-9a-f]{64}$/.test(h))) {
    throw Error('缺少 PowerShell 脚本字节哈希白名单（R6：精确匹配，不接受子串/标记匹配）');
  }
  const guard = (require('./pic-guard-runner.cjs').installParentGuards)(opts);
  const allowedScriptHashes = opts.allowedScriptHashes;
  const toolCalls = [];
  const recordAndThrow = () => {
    opts.hits.push({ phase: opts.getPhase(), api: 'cp.spawnSync' });
    const e = new Error('OFFLINE_GUARD:cp.spawnSync（非白名单本地工具调用）');
    e.code = 'OFFLINE_GUARD';
    throw e;
  };
  const dispatch = (cmd, args, toolOpts) => {
    if (isAllowedToolCall(cmd, args, opts.allowedScriptHashes)) {
      toolCalls.push({ tool: cmd, argv0: args[0], argc: args.length });
      return origSpawnSync(cmd, args, toolOpts);
    }
    recordAndThrow();
  };
  cp.spawnSync = dispatch;
  // R6：异步 spawn 仅放行 DPAPI 管道子进程固定形状（脚本哈希精确匹配；管道名经 stdin）
  cp.spawn = function patchedSpawn(cmd, args, toolOpts) {
    const ok = cmd === 'powershell.exe' && Array.isArray(args) && args.length === 4
      && args[0] === '-NoProfile' && args[1] === '-NonInteractive' && args[2] === '-Command'
      && allowedScriptHashes.includes(sha256(args[3]));
    if (ok) {
      toolCalls.push({ tool: cmd, argv0: args[0], argc: args.length });
      return origSpawn(cmd, args, toolOpts);
    }
    opts.hits.push({ phase: opts.getPhase(), api: 'cp.spawn' });
    const e = new Error('OFFLINE_GUARD:cp.spawn');
    e.code = 'OFFLINE_GUARD';
    throw e;
  };
  // R6：restore 回到阻断态（记账+抛错），不直接恢复无守卫公共 API
  const restore = () => {
    cp.spawnSync = dispatch;
    cp.spawn = function (cmd, args) {
      opts.hits.push({ phase: opts.getPhase(), api: 'cp.spawn' });
      const e = new Error('OFFLINE_GUARD:cp.spawn');
      e.code = 'OFFLINE_GUARD';
      throw e;
    };
  };
  return { guard, toolCalls, restore };
}

module.exports = Object.freeze({ installParentGuardsWithLocalTools, isAllowedToolCall });
