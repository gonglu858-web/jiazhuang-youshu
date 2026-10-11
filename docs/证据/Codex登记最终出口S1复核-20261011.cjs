'use strict';
// 离线审查：真实本地组装器，合成计划/事件时钟；stdout only，独立随机夹具不删除。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const asm = require(path.join(ROOT, 'miniapp/scripts/assemble-sandbox-registration.cjs'));
const reg = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));
const guard = asm.installNetworkGuard({});
const T = Date.parse('2026-03-01T12:00:00Z'), E = T + 1200000;
const tag = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
let seq = 0;
const fresh = s => `cx-s1-${tag}-${++seq}-${s}`;
function files(dir) {
  const rows = [];
  if (fs.existsSync(dir)) (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else rows.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  })(dir);
  return rows.sort();
}
const report = { commit: '3a9d90c', cases: [], fixtures: [], realSdk: false, cloudExecuted: false };
try {
  const plan = { purpose: 'offline-fixture-codex-s1', ...reg.FIXED_TARGET,
    allowedUserIds: [reg.CANDIDATE_USER_ID], roundId: fresh('offline-fixture'),
    windowStartsAt: new Date(T).toISOString(), windowExpiresAt: new Date(E).toISOString(),
    sourceVersion: reg.REVIEWED_SOURCE_VERSION, synthetic: false };
  const input = reg.buildRegistration(plan, { outId: fresh('input'), nowMs: T });
  assert.equal(input.ok, true); report.fixtures.push(input.dir);
  for (const mode of ['expired', 'nan', 'throw', 'outer-catch', 'delivered-nan-event']) {
    const outId = fresh(mode), dir = asm.resolveOutDir(outId);
    report.fixtures.push(dir);
    const realNow = Date.now, realParse = Date.parse, realIso = Date.prototype.toISOString;
    let fired = false, atEvent = 0, reads = 0;
    Date.now = () => {
      reads++;
      if (mode === 'delivered-nan-event' && fs.existsSync(path.join(dir, 'manifest.json'))) {
        fired = true; atEvent = files(dir).length; return NaN;
      }
      if (fired && mode === 'throw') throw new Error('synthetic clock unavailable');
      return fired && mode === 'expired' ? E : fired && mode === 'nan' ? NaN : T;
    };
    Date.parse = function(v) {
      const n = realParse(v);
      if (!fired && mode !== 'delivered-nan-event' && n === E &&
          fs.existsSync(path.join(dir, 'manifest.json')) &&
          new Error().stack.includes('assertCandidateNotExpired')) {
        // 写后守卫已读取有效快照；只改变下一次时钟读值，不改守卫返回值。
        fired = true; atEvent = files(dir).length;
      }
      return n;
    };
    Date.prototype.toISOString = function() {
      if (mode === 'outer-catch' && fired) throw new Error('synthetic result projection failure');
      return realIso.call(this);
    };
    let r;
    try { r = asm.buildAssembly({ inputDir: input.dir, plan, outId, artifactKind: 'real-candidate' }); }
    finally { Date.now = realNow; Date.parse = realParse; Date.prototype.toISOString = realIso; }
    assert.equal(fired, true); assert.equal(atEvent, 49); assert.ok(reads > 1);
    assert.equal(r.ok, false); assert.equal(r.wroteFiles, true);
    assert.deepEqual(r.written.slice().sort(), files(dir)); assert.equal(r.written.length, 49);
    if (['expired', 'nan', 'throw'].includes(mode)) assert.equal(r.reason, 'final-check');
    report.cases.push({ mode, filesAtEvent: atEvent, clockReads: reads, factsPreserved: true,
      reason: r.reason || 'outer-catch', clockInvalid: r.clockInvalid ?? null,
      expiredAfterWrite: r.expiredAfterWrite ?? null, problems: r.problems,
      outstandingClockClassification: mode === 'throw' && r.clockInvalid !== true });
  }
  const outId = fresh('control'), opts = { inputDir: input.dir, plan, outId, artifactKind: 'real-candidate', nowMs: T };
  const built = asm.buildAssembly(opts); assert.equal(built.ok, true); report.fixtures.push(built.dir);
  const reused = asm.buildAssembly(opts); assert.equal(reused.ok, true); assert.equal(reused.wroteFiles, false);
  const checked = asm.checkAssembly({ inputDir: input.dir, plan, outDir: built.dir, artifactKind: 'real-candidate', nowMs: T });
  assert.equal(checked.ok, true); assert.equal(checked.wroteFiles, false);
  // 只移除本脚本新建夹具中的两个确定文件，以验证合法续建。
  const missing = `${asm.REGISTRATION_ROOT}/miniprogram/app.wxss`;
  fs.unlinkSync(path.join(built.dir, 'manifest.json')); fs.unlinkSync(path.join(built.dir, missing));
  const resumed = asm.buildAssembly(opts); assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.written.slice().sort(), ['manifest.json', missing].sort());
  const rejected = asm.buildAssembly({ ...opts, outId: fresh('expired-precheck'), nowMs: E });
  assert.equal(rejected.ok, false); assert.equal(rejected.wroteFiles, false);
  report.controls = { normalBuild: true, checkZeroWrite: true, reuseZeroWrite: true,
    resumeExactlyTwoNewFiles: true, precheckZeroWrite: true };
  report.networkAttempts = guard.attempts.length;
  report.summary = { writeFactPathsPassed: 5, controlsPassed: 5,
    remainingImplementationIssues: report.cases.filter(c => c.outstandingClockClassification).length,
    deliveredNanActuallyReaches: report.cases.find(c => c.mode === 'delivered-nan-event').reason };
} finally { asm.restoreNetworkGuard(guard); }
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
