'use strict';
/**
 * WorkBuddy R2 剩余 S1/S2 事件收尾返修复现（离线，另存新证据）
 * ===============================================================
 *
 * 依据：docs/Codex复核-CLI只读接入R1-R4返修-20261007.md 第 2、3 节。
 * R1/R3/R4 已通过关闭，本轮不重做。
 *
 * 本脚本加载**真实被改模块**，子进程为**合成 EventEmitter 事件源**：
 *   - 不执行 CLI、不接认证、不联网（realNetworkCalls 恒为 0）；
 *   - 不运行 --read-only、不安装、不初始化、不部署；
 *   - 只向 stdout 输出，调用者另存为新的证据 JSON。
 *
 * S1：exit 只记录退出事实，收尾等 close；exit 后 close 不来则有界失败。
 * S2：收尾保留 error 幂等吸收器，晚到 error 不抛、不打印、不改报告、不二次 kill。
 *
 * **不覆盖** Codex 原报告与原证据JSON/cjs。
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');

const o = require('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs');

const findings = [];
const record = (id, expected, actual, ok, note) => {
  findings.push({ id, expected, actual, closed: ok === true, note: note || '' });
};

/** 合成 ChildProcess：真正的 EventEmitter，使「无 error 监听时 emit 会抛」可被观察到 */
function fake() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kills = 0;
  c.kill = () => { c.kills++; return false; };
  return c;
}

const limits = (over) => Object.assign({ timeoutMs: 5000, maxOutputBytes: 4096, closeGraceMs: 5000 }, over || {});

(async () => {
  /* ── S1：exit 提前完成会丢弃尚未读完的输出 ─────────────────────────── */
  // S1 样本 1：`{"ok":` → exit(0) → `true}` → close(0)，应收全有效 JSON
  const c1 = fake();
  let settled1 = false;
  const p1 = o.spawnBounded('fake', [], {}, { spawn: () => c1, __limits: limits() })
    .then(r => { settled1 = true; return r; });
  c1.stdout.emit('data', Buffer.from('{"ok":'));
  c1.emit('exit', 0, null);
  await Promise.resolve();
  const settledBeforeClose1 = settled1;
  c1.stdout.emit('data', Buffer.from('true}'));
  c1.emit('close', 0, null);
  const r1 = await p1;
  let parser1 = false;
  try { o.parseCliJson(r1.stdout, 'sts', 'GetCallerIdentity'); parser1 = true; } catch { parser1 = false; }
  record('S1-valid-split', '收全 {"ok":true}，不在 close 前完成',
    {
      settledBeforeClose: settledBeforeClose1,
      observedOutput: r1.stdout, parserAccepted: parser1,
      exitCode: r1.code, processExited: r1.processExited,
      terminationConfirmed: r1.terminationConfirmed, closeNotObserved: r1.closeNotObserved
    },
    settledBeforeClose1 === false && r1.stdout === '{"ok":true}' && parser1 === true,
    '此前在 close 前 finish，只保留前半，解析失败。');

  // S1 样本 2：合法 JSON → exit(0) → 非法尾部 → close(0)，应收全后被解析器拒绝
  const c2 = fake();
  let settled2 = false;
  const p2 = o.spawnBounded('fake', [], {}, { spawn: () => c2, __limits: limits() })
    .then(r => { settled2 = true; return r; });
  c2.stdout.emit('data', Buffer.from('{"ok":true}'));
  c2.emit('exit', 0, null);
  await Promise.resolve();
  const settledBeforeClose2 = settled2;
  c2.stdout.emit('data', Buffer.from('UNEXPECTED_TAIL'));
  c2.emit('close', 0, null);
  const r2 = await p2;
  let parser2 = false;
  try { o.parseCliJson(r2.stdout, 'sts', 'GetCallerIdentity'); parser2 = true; } catch { parser2 = false; }
  record('S1-invalid-tail', '收全含尾部，并由解析器拒绝未知尾部',
    {
      settledBeforeClose: settledBeforeClose2,
      observedOutput: r2.stdout, parserAccepted: parser2,
      exitCode: r2.code, processExited: r2.processExited
    },
    settledBeforeClose2 === false
      && r2.stdout === '{"ok":true}UNEXPECTED_TAIL' && parser2 === false,
    '此前尾部丢失，解析器反而接受。');

  // S1 样本 3：普通完整输出 → exit → close
  const c3 = fake();
  const p3 = o.spawnBounded('fake', [], {}, { spawn: () => c3, __limits: limits() });
  c3.stdout.emit('data', Buffer.from('{"a":1}'));
  c3.emit('exit', 0, null);
  c3.emit('close', 0, null);
  const r3 = await p3;
  record('S1-normal-exit-close', '语义与注释一致：退出已确认、无信号、未请求终止',
    {
      stdout: r3.stdout, code: r3.code, signal: r3.signal,
      processExited: r3.processExited, terminationConfirmed: r3.terminationConfirmed,
      closeNotObserved: r3.closeNotObserved, kills: c3.kills
    },
    r3.stdout === '{"a":1}' && r3.code === 0 && r3.signal === null
      && r3.processExited === true && r3.terminationConfirmed === true
      && r3.closeNotObserved === false && c3.kills === 0,
    'exit 的 0 不是信号；正常退出不得请求终止。');

  // S1 样本 4：exit 后 close 迟迟不来 → 有界失败，半截输出不当成功
  const c4 = fake();
  const p4 = o.spawnBounded('fake', [], {}, { spawn: () => c4, __limits: limits({ closeGraceMs: 60 }) });
  c4.stdout.emit('data', Buffer.from('{"partial":'));
  c4.emit('exit', 0, null);
  const r4 = await p4;
  record('S1-exit-without-close', '有界失败：不把半截输出当成功，不无限等待',
    {
      stdout: r4.stdout, processExited: r4.processExited,
      terminationConfirmed: r4.terminationConfirmed,
      closeNotObserved: r4.closeNotObserved, timedOut: r4.timedOut, exitCode: r4.code
    },
    r4.processExited === true && r4.closeNotObserved === true
      && r4.timedOut === false && r4.code === 0,
    '宽限到期失败，与总超时区分；exit 记录的 code 仍保留。');

  /* ── S2：收尾移除 error 监听 → 晚到 error 变未捕获异常 ───────────────── */
  for (const kind of ['timeout', 'overflow', 'first-error']) {
    const c = fake();
    let r;
    if (kind === 'first-error') {
      const p = o.spawnBounded('fake', [], {}, { spawn: () => c, __limits: limits() });
      c.emit('error', new Error('SYNTHETIC_FIRST_ERROR'));
      r = await p;
    } else {
      const p = o.spawnBounded('fake', [], {}, {
        spawn: () => c, __limits: limits(kind === 'timeout' ? { timeoutMs: 20 } : { maxOutputBytes: 100 })
      });
      if (kind === 'overflow') c.stdout.emit('data', Buffer.alloc(101, 120));
      r = await p;
    }
    const killsBefore = c.kills;
    const snapshot = JSON.stringify(r);
    let lateThrew = false;
    try { c.emit('error', new Error('SYNTHETIC_LATE_ERROR')); } catch { lateThrew = true; }
    let repeatThrew = false;
    try { c.emit('error', new Error('SYNTHETIC_REPEAT_ERROR')); } catch { repeatThrew = true; }
    const dumped = snapshot + JSON.stringify(r);
    record('S2-late-error-' + kind, '晚到/重复 error 均被吸收：不抛、不改报告、不二次 kill',
      {
        timedOut: r.timedOut, overflow: r.overflow,
        hasSpawnError: Boolean(r.spawnError),
        errorListeners: c.listenerCount('error'),
        lateErrorThrew: lateThrew, repeatErrorThrew: repeatThrew,
        killsBefore, killsAfter: c.kills,
        reportUnchanged: JSON.stringify(r) === snapshot,
        leaksSensitiveMarker: dumped.includes('SYNTHETIC_LATE_ERROR')
          || dumped.includes('SYNTHETIC_REPEAT_ERROR')
      },
      lateThrew === false && repeatThrew === false
        && c.listenerCount('error') >= 1 && c.kills === killsBefore
        && JSON.stringify(r) === snapshot
        && !(dumped.includes('SYNTHETIC_LATE_ERROR') || dumped.includes('SYNTHETIC_REPEAT_ERROR')),
      '此前收尾移除 error 监听，emit 会抛并可能成为未捕获异常。');
  }

  // S2 补充：收尾后继续到达 data / exit / close 也不得抛错或改报告
  const c5 = fake();
  const p5 = o.spawnBounded('fake', [], {}, { spawn: () => c5, __limits: limits({ timeoutMs: 20 }) });
  const r5 = await p5;
  const snap5 = JSON.stringify(r5);
  let threw = false;
  try {
    c5.stdout.emit('data', Buffer.from('late data'));
    c5.emit('exit', 0, null);
    c5.emit('close', 0, null);
  } catch { threw = true; }
  record('S2-post-close-events', '收尾后晚到 data/exit/close 不抛错、不改报告',
    { threw, reportUnchanged: JSON.stringify(r5) === snap5, totalBytes: r5.totalBytes },
    threw === false && JSON.stringify(r5) === snap5 && r5.totalBytes === 0,
    '只移除会累积数据的 data 监听。');

  const allClosed = findings.every(f => f.closed === true);
  process.stdout.write(JSON.stringify({
    schema: 1,
    observedAt: new Date().toISOString(),
    basis: 'docs/Codex复核-CLI只读接入R1-R4返修-20261007.md 第2、3节',
    scope: 'R2 剩余 S1/S2 事件收尾返修复现（R1/R3/R4 已通过，未重做）',
    realNetworkCalls: 0,
    cliExecuted: false,
    authRead: false,
    readOnlyModeRun: false,
    installed: false,
    officialInstallModified: false,
    historicalEvidenceOverwritten: false,
    observerSha256: crypto.createHash('sha256')
      .update(fs.readFileSync(require.resolve('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs')))
      .digest('hex'),
    findingsTotal: findings.length,
    findingsClosed: findings.filter(f => f.closed === true).length,
    allClosed,
    findings
  }, null, 2) + '\n');
})().catch(() => {
  process.stderr.write('OFFLINE_REPRODUCTION_FAILED\n');
  process.exitCode = 1;
});