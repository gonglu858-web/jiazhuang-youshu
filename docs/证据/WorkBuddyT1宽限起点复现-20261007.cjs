#!/usr/bin/env node
/**
 * WorkBuddy T1 复现（close 宽限起点返修）— 2026-10-07
 *
 * 目的：闭合 docs/Codex复核-CLI事件收尾S1S2-20261007.md 第 2 节 T1。
 * 缺陷：close 宽限定时器写在注册监听之后，进入 spawnBounded 即开始计时，
 *       而非从首次 exit 之后开始 —— 任何正常运行超过 closeGraceMs(2s) 的
 *       查询都会被误判 closeNotObserved=true 而提前失败。
 *
 * 约束（与前几轮一致）：
 *   - 只用合成 ChildProcess，不执行 CLI、不联网、不读认证、不初始化、不部署。
 *   - 时序断言给足余量，不赌毫秒级竞速。
 *   - 结果写入 WorkBuddyT1宽限起点复现-20261007.json，不覆盖任何历史证据。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const OBSERVER = path.resolve(__dirname, '..', '..', 'miniapp', 'scripts', 'lib', 'cloudbase-readonly-observer.cjs');
const o = require(OBSERVER);

function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kills = 0;
  c.kill = () => { c.kills++; return true; };
  return c;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
async function listenersReady() {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

const checks = [];
/** 记录一项检查；detail 可含预计算字段，调用方随后写回check.pass */
function record(id, detail) {
  const c = { id, pass: false, ...(detail || {}) };
  checks.push(c);
  return c;
}

(async () => {
  const results = [];
  const src = fs.readFileSync(OBSERVER);

  // ── 1. 未发exit/close：完整生产限制下必须由 55 秒总超时负责，而非 2 秒宽限 ──
  {
    const c = child();
    const start = Date.now();
    const r = await o.spawnBounded('fake', [], {}, { spawn: () => c, __limits: o.LIMITS });
    const elapsedMs = Date.now() - start;
    const pass = record('no-exit-production-limits', {
      elapsedMs, processExited: r.processExited, closeNotObserved: r.closeNotObserved,
      timedOut: r.timedOut, killCalls: c.kills,
      expected: '未 exit 时由 55 秒总超时负责；不得被 2 秒 close 宽限提前结束'
    });
    pass.pass = r.timedOut === true && r.closeNotObserved === false
      && r.processExited === false && c.kills === 1 && elapsedMs >= 54000;
    results.push({ id: 'no-exit-production-limits', elapsedMs, pass: pass.pass,
      processExited: r.processExited, closeNotObserved: r.closeNotObserved,
      timedOut: r.timedOut, killCalls: c.kills });
  }

  // ── 2. 旧样本的「缺字段直注 __limits」夹具：归一化必须补齐 closeGraceMs ──
  {
    const c = child();
    const start = Date.now();
    const r = await o.spawnBounded('fake', [], {}, {
      spawn: () => c, __limits: { timeoutMs: 100, maxOutputBytes: 100 }
    });
    const elapsedMs = Date.now() - start;
    // 修复前：closeGraceMs=undefined → setTimeout(cb, undefined) 立即触发，
    //表现为 elapsed≈0 且 closeNotObserved=true。修复后：归一化补上 2 秒宽限，
    // 未 exit 不启动宽限，因此由 100ms 总超时兜底。
    const pass = r.timedOut === true && r.closeNotObserved === false
      && r.processExited === false && elapsedMs >= 90;
    record('partial-direct-limits-normalized', { elapsedMs, pass });
    results.push({ id: 'partial-direct-limits-normalized', elapsedMs, pass,
      processExited: r.processExited, closeNotObserved: r.closeNotObserved,
      timedOut: r.timedOut, killCalls: c.kills,
      note: '旧夹具未提供 closeGraceMs。修复前绕过 resolveLimits 导致 setTimeout(undefined) 立即触发；'
        + '修复后 spawnBounded 统一走 resolveLimits 归一化，不再出现 undefined 延时。' });
  }

  // ── 3. 晚exit：宽限必须从 exit 起算，重复 exit 不刷新 ──
  {
    const c = child();
    const start = Date.now();
    const p = o.spawnBounded('fake', [], {}, {
      spawn: () => c, __limits: { timeoutMs: 8000, maxOutputBytes: 4096, closeGraceMs: 300 }
    });
    await listenersReady();
    await delay(600);                       // 静默600ms，远大于 300ms 宽限
    const beforeExitSettled = false;
    c.stdout.emit('data', Buffer.from('{"partial":1}', 'utf8'));
    c.emit('exit', 0, null);                // 宽限从此刻起算
    await delay(120);
    c.emit('exit', 0, null);                // 重复 exit：不得刷新宽限
    const r = await p;
    const elapsedMs = Date.now() - start;
    // 若宽限从 spawn 起算，600ms 就会失败；正确行为是 600+300 附近才失败。
    const pass = r.closeNotObserved === true && r.timedOut === false
      && r.processExited === true && r.code === 0
      && r.stdout === '{"partial":1}' && elapsedMs >= 880 && elapsedMs < 1400;
    record('grace-starts-at-exit', { elapsedMs, beforeExitSettled, pass });
    results.push({ id: 'grace-starts-at-exit', elapsedMs, pass,
      closeNotObserved: r.closeNotObserved, timedOut: r.timedOut,
      processExited: r.processExited, exitCode: r.code, stdout: r.stdout, killCalls: c.kills,
      note: '静默 600ms 后才 exit。若宽限从 spawn 起算会在~300ms 失败；实测≈900ms 失败，'
        + '证明宽限从 exit 起算，且重复 exit 未把宽限推后。' });
  }

  // ── 4. 宽限不得延长总超时（宽限 500ms 晚于总超时 100ms） ──
  {
    const c = child();
    const start = Date.now();
    const p = o.spawnBounded('fake', [], {}, {
      spawn: () => c, __limits: { timeoutMs: 100, maxOutputBytes: 4096, closeGraceMs: 500 }
    });
    await listenersReady();
    c.emit('exit', 0, null);                // exit 已到，close 永不发生
    const r = await p;
    const elapsedMs = Date.now() - start;
    const pass = r.timedOut === true && r.closeNotObserved === false
      && c.kills === 1 && elapsedMs >= 90 && elapsedMs < 450;
    record('grace-cannot-extend-total-timeout', { elapsedMs, pass });
    results.push({ id: 'grace-cannot-extend-total-timeout', elapsedMs, pass,
      timedOut: r.timedOut, closeNotObserved: r.closeNotObserved, killCalls: c.kills,
      note: '总超时 100ms 先于宽限 500ms 到达；宽限既未提前标记 close 未观察到，也未把失败推后。' });
  }

  // ── 5. 前序修复不回退：exit 后仍收尾部；晚到 error 被吸收 ──
  {
    const c = child();
    let settledFlag = false;
    const p = o.spawnBounded('fake', [], {}, {
      spawn: () => c, __limits: { timeoutMs: 3000, maxOutputBytes: 4096, closeGraceMs: 800 }
    }).then(x => { settledFlag = true; return x; });
    await listenersReady();
    c.stdout.emit('data', Buffer.from('{"ok":', 'utf8'));
    c.emit('exit', 0, null);
    // S1：exit 之后 Promise 不得收尾，管道尾部仍要收
    await Promise.resolve();
    const settledBeforeClose = settledFlag;
    c.stdout.emit('data', Buffer.from('true}', 'utf8'));
    c.emit('close', 0, null);
    const r = await p;
    // S2：收尾之后的晚到 error 必须被吸收（不抛、不改报告）
    let lateErrorThrew = false;
    try { c.emit('error', new Error('late')); } catch (_) { lateErrorThrew = true; }
    const pass = settledBeforeClose === false && r.stdout === '{"ok":true}'
      && lateErrorThrew === false && r.closeNotObserved === false && r.timedOut === false;
    record('prior-s1-s2-intact', { settledBeforeClose, pass });
    results.push({ id: 'prior-s1-s2-intact', pass, settledBeforeClose,
      stdout: r.stdout, lateErrorThrew, closeNotObserved: r.closeNotObserved, timedOut: r.timedOut,
      note: 'exit 后 Promise 未收尾（settledBeforeClose=false）、尾部收全为 {"ok":true}；'
        + '收尾后发射 error 不抛且不改报告。' });
  }

  // ── 6. 常量未被调大掩盖问题 ──
  {
    const pass = o.LIMITS.closeGraceMs === 2000 && o.LIMITS.timeoutMs === 55000;
    record('limits-not-inflated', { pass });
    results.push({ id: 'limits-not-inflated', pass,
      closeGraceMs: o.LIMITS.closeGraceMs, timeoutMs: o.LIMITS.timeoutMs,
      note: 'closeGraceMs 仍为 2000、timeoutMs 仍为 55000；缺陷由计时起点修复，未靠调大数值掩盖。' });
  }

  const out = {
    observedAt: new Date().toISOString(),
    scope: 'T1 close 宽限起点返修（CLI 只读接入事件收尾第 3 轮）',
    constraints: {
      network: false, executedCli: false, readAuth: false,
      installed: false, initialized: false, deployed: false
    },
    realNetworkCalls: 0,
    observerFile: path.relative(path.resolve(__dirname, '..', '..'), OBSERVER).split(path.sep).join('/'),
    observerSha256: crypto.createHash('sha256').update(src).digest('hex'),
    productionLimits: { timeoutMs: o.LIMITS.timeoutMs, maxOutputBytes: o.LIMITS.maxOutputBytes, closeGraceMs: o.LIMITS.closeGraceMs },
    results,
    checks,
    summary: {
      total: results.length,
      passed: results.filter(r => r.pass).length,
      failed: results.filter(r => !r.pass).length
    }
  };

  const dest = path.join(__dirname, 'WorkBuddyT1宽限起点复现-20261007.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.stdout.write('\n[written] ' + dest + '\n');
})().catch(error => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exitCode = 1;
});