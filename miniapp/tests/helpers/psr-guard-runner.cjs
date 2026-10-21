// 私密存储证据适配层（不改已受审共享辅助模块；仅扩展本地只读工具白名单）。
// 依据任务 §2："共享已受审守卫优先原样调用；需要不同功能新增适配层，不修改历史辅助模块影响旧证据。"
// 政策：child_process 其余一切仍被共享守卫阻断并计意外；本适配层仅放行——
//   git check-ignore / git ls-files（只读索引查询）；
//   icacls <绝对路径>（只读 ACL 查询；禁 /grant /deny /remove /reset /inheritance）；
//   powershell.exe 仅限固定形状的 DPAPI CurrentUser 转换脚本（ConvertTo/From-SecureString，
//   明文经 stdin 传递，不经 argv/环境变量）。
// 每次放行调用记账（toolCalls，随证据 JSON 披露），不计入意外；其余一切照旧阻断。
'use strict';
const cp = require('node:child_process');
const origSpawnSync = cp.spawnSync; // 在共享守卫打补丁之前捕获

const GIT_READONLY_SUBCOMMANDS = ['check-ignore', 'ls-files'];
const ICACLS_FORBIDDEN = ['/grant', '/grant:r', '/deny', '/remove', '/reset', '/inheritance'];
const DPAPI_MARKERS = ['ConvertFrom-SecureString', 'ConvertTo-SecureString'];
const POWERSHELL_FORBIDDEN = ['Invoke-', 'Download', 'Net.WebClient', 'curl', 'wget', 'Start-Process', 'Remove-Item', 'Set-Item', 'New-Item'];

function isAllowedToolCall(cmd, args) {
  if (typeof cmd !== 'string' || !Array.isArray(args) || !args.every(a => typeof a === 'string')) return false;
  if (cmd === 'git') return args.length >= 1 && GIT_READONLY_SUBCOMMANDS.includes(args[0]);
  if (cmd === 'icacls') {
    if (args.length !== 1 && args.length !== 2) return false;
    if (!pathIsAbsolute(args[0])) return false;
    return !args.some(a => ICACLS_FORBIDDEN.includes(String(a).toLowerCase()));
  }
  if (cmd === 'powershell.exe') {
    if (args.length !== 4) return false;
    if (args[0] !== '-NoProfile' || args[1] !== '-NonInteractive' || args[2] !== '-Command') return false;
    const script = args[3];
    if (!DPAPI_MARKERS.some(m => script.includes(m))) return false;
    return !POWERSHELL_FORBIDDEN.some(m => script.includes(m));
  }
  return false;
}
function pathIsAbsolute(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * 与共享 installParentGuards 相同的守卫，另加本地只读工具白名单。
 * 返回 { guard, toolCalls, restore }：toolCalls 为放行调用台账；restore 还原全部补丁。
 */
function installParentGuardsWithLocalTools(opts) {
  const guard = (require('./pic-guard-runner.cjs').installParentGuards)(opts);
  const toolCalls = [];
  cp.spawnSync = function patchedSpawnSync(cmd, args, toolOpts) {
    if (isAllowedToolCall(cmd, args)) {
      toolCalls.push({ tool: cmd, argv0: args[0], argc: args.length });
      return origSpawnSync(cmd, args, toolOpts);
    }
    const e = new Error('OFFLINE_GUARD:cp.spawnSync（非白名单本地工具调用）');
    e.code = 'OFFLINE_GUARD';
    throw e;
  };
  const restore = () => { cp.spawnSync = origSpawnSync; };
  return { guard, toolCalls, restore };
}

module.exports = Object.freeze({ installParentGuardsWithLocalTools, isAllowedToolCall });
