'use strict';
// 本包专用原始进程/管道引用捕获层（A2，Codex 复查接续 545d038 §2）。
// 职责单一：在本包任何守卫/业务装载之前，最先捕获原始 child_process/net 引用，
// 并仅以受限包装导出——不暴露原始 cp/net 对象，不提供任意命令分发入口；
// 命令/参数/目标/限额约束由调用方（local-tools 的 sync、v3 的保护核对封装）负责。
// 附带实际调用记录（attempts）：每次 spawnSync/spawn/execFile 连接尝试均记录
// 程序名/状态/是否失败（含 error/signal/超时），供证据从实际调用汇总进程次数，
// 不手工填写总数；记录不含参数内容与输出（净化：仅程序基名+状态+失败布尔）。
const cp = require('node:child_process');
const net = require('node:net');
const rawSpawnSync = cp.spawnSync, rawSpawn = cp.spawn, rawConnect = net.connect,
  rawExecFile = cp.execFileSync;
const attempts = [];
const baseName = exe => String(exe).split('\\').pop();
function record(kind, exe, r, error) {
  attempts.push({ kind, program: baseName(exe),
    status: r && r.status !== undefined ? r.status : null,
    failed: !!(error || !r || r.error || r.signal) });
}
module.exports = Object.freeze({
  /** 同步进程（local-tools sync / 保护核对封装）；固定命令与限额由调用方约束。 */
  spawnSync(exe, args, opts) {
    let r, err;
    try { r = rawSpawnSync(exe, args, opts); } catch (e) { err = e; }
    record('spawnSync', exe, r, err);
    if (err) throw err;
    return r;
  },
  /** 异步进程（仅 local-tools unprotect 的固定 DPAPI 管道命令）。 */
  spawn(exe, args, opts) {
    record('spawn', exe, null, null);
    return rawSpawn(exe, args, opts);
  },
  /** 命名管道连接（仅 local-tools unprotect 的固定 \\.\pipe\psr-dpapi-* 目标）。 */
  connect(pipePath) {
    attempts.push({ kind: 'connect', program: 'named-pipe', status: null, failed: false });
    return rawConnect(pipePath);
  },
  /** 保护核对专用（固定 git 路径 + 固定子命令 + 限额，由调用方约束）。 */
  execFile(exe, args, opts) {
    let r, err;
    try { r = rawExecFile(exe, args, opts); } catch (e) { err = e; }
    record('execFile', exe, r, err);
    if (err) throw err;
    return r;
  },
  /** 实际调用记录快照（净化字段；证据据此汇总进程次数，不手工填写）。 */
  attempts() { return attempts.slice(); }
});
