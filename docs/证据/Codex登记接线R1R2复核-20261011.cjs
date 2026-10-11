'use strict';
// 仅本地复核；真实组装器 + 历史时钟/合成制品，不加载 SDK。
// stdout only。历史模块由 git show b274da4 原字节导出，通过 OLD_ASM_SRC 提供。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const asmPath = path.join(ROOT, 'miniapp/scripts/assemble-sandbox-registration.cjs');
const asm = require(asmPath);
const reg = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const tracked = JSON.parse(fs.readFileSync(process.env.CODEX_REVIEW_TRACKED_LIST, 'utf8'));
const baseline = new Map(tracked.map(p => [p, sha(fs.readFileSync(path.join(ROOT, p)))]));
const guard = asm.installNetworkGuard({});
const T = Date.parse('2026-03-01T12:00:00Z'), E = T + 1200000;
const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
let seq = 0;
const fresh = s => `cxr-${runId}-${++seq}-${s}`;
const report = { reviewCommit: 'c6d40b9', cases: [], fixtures: [], cloudExecuted: false, sdkExecuted: false };
function snap(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(dir, p).replace(/\\/g, '/');
      if (e.isDirectory()) walk(p); else out[rel] = sha(fs.readFileSync(p));
    }
  }
  walk(dir); return out;
}
function input(synthetic = false) {
  const plan = { purpose: 'offline-fixture-codex-review', ...reg.FIXED_TARGET,
    allowedUserIds: [reg.CANDIDATE_USER_ID], roundId: fresh('offline-fixture'),
    windowStartsAt: new Date(T).toISOString(), windowExpiresAt: new Date(E).toISOString(),
    sourceVersion: reg.REVIEWED_SOURCE_VERSION, synthetic };
  const r = reg.buildRegistration(plan, { outId: fresh('input'), nowMs: T });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  report.fixtures.push(r.dir); return { plan, inputDir: r.dir };
}
function options(i) {
  const outId = fresh('out'); report.fixtures.push(asm.resolveOutDir(outId));
  return { ...i, outId, artifactKind: 'real-candidate' };
}
function summary(r) {
  return { ok: r.ok, reused: r.reused, wroteFiles: r.wroteFiles,
    expiredAfterWrite: r.expiredAfterWrite || false, written: r.written || null, problems: r.problems };
}
function clockEvent(operation, trigger, dir, invalid = false) {
  const realNow = Date.now, realParse = Date.parse, realRead = fs.readFileSync, realWrite = fs.writeFileSync;
  let now = T, reads = 0, fired = false, filesAtEvent = null;
  Date.now = () => { reads++; return now; };
  fs.readFileSync = function(p, ...args) {
    const b = realRead.call(fs, p, ...args);
    if (trigger === 'source' && path.resolve(String(p)) === path.join(asm.MINIPROGRAM_SRC, 'app.js')) {
      fired = true; now = E;
    }
    return b;
  };
  fs.writeFileSync = function(p, ...args) {
    const r = realWrite.call(fs, p, ...args);
    if (trigger === 'write' && path.resolve(String(p)).startsWith(dir + path.sep)) { fired = true; now = E; }
    return r;
  };
  // 事件屏障：49文件已存在，写后守卫读取截止时间时，其 now 快照已取。
  // 此处推进外部时钟；不改守卫返回值，不按 Date.now 调用次数猜阶段。
  Date.parse = function(value) {
    const parsed = realParse(value);
    if (trigger === 'after-postcheck-snapshot' && !fired && parsed === E &&
        fs.existsSync(path.join(dir, 'manifest.json')) &&
        new Error().stack.includes('assertCandidateNotExpired')) {
      filesAtEvent = Object.keys(snap(dir)).length;
      fired = true; now = invalid ? NaN : E;
    }
    return parsed;
  };
  let result;
  try { result = operation(); }
  finally { Date.now = realNow; Date.parse = realParse; fs.readFileSync = realRead; fs.writeFileSync = realWrite; }
  assert.equal(fired, true, 'event barrier not reached');
  assert.ok(reads > 1);
  return { result: summary(result), clockReads: reads, barrierHit: fired, filesAtEvent,
    filesAfter: Object.keys(snap(dir)).length };
}
try {
  const i = input();
  for (const [id, trigger] of [['prewrite', 'source'], ['postwrite', 'write']]) {
    const o = options(i), dir = asm.resolveOutDir(o.outId);
    const r = clockEvent(() => asm.buildAssembly(o), trigger, dir);
    assert.equal(r.result.ok, false);
    assert.equal(r.result.wroteFiles, id === 'postwrite');
    assert.equal(r.filesAfter, id === 'postwrite' ? 49 : 0);
    report.cases.push({ id, passed: true, ...r });
  }
  const o = options(i), dir = asm.resolveOutDir(o.outId);
  assert.equal(asm.buildAssembly({ ...o, nowMs: T }).ok, true);
  const complete = snap(dir);
  for (const id of ['check', 'reuse']) {
    const r = clockEvent(() => id === 'check'
      ? asm.checkAssembly({ ...i, outDir: dir, artifactKind: 'real-candidate' })
      : asm.buildAssembly(o), 'source', dir);
    assert.equal(r.result.ok, false); assert.equal(r.result.wroteFiles, false);
    assert.deepEqual(snap(dir), complete);
    report.cases.push({ id, passed: true, unchanged: true, ...r });
  }
  const removed = 'registration-project/miniprogram/app.wxss';
  fs.unlinkSync(path.join(dir, 'manifest.json')); fs.unlinkSync(path.join(dir, removed));
  const partial = snap(dir);
  const resume = clockEvent(() => asm.buildAssembly(o), 'source', dir);
  assert.equal(resume.result.ok, false); assert.deepEqual(snap(dir), partial);
  report.cases.push({ id: 'resume-expired', passed: true, unchanged: true, ...resume });
  const resumed = asm.buildAssembly({ ...o, nowMs: T });
  assert.equal(resumed.ok, true); assert.equal(resumed.written.length, 2);
  const edge = options(i), edgeDir = asm.resolveOutDir(edge.outId);
  assert.equal(asm.buildAssembly({ ...edge, nowMs: E }).ok, false);
  assert.equal(Object.keys(snap(edgeDir)).length, 0);
  report.cases.push({ id: 'valid-resume-and-equal-deadline', passed: true, resumedFiles: resumed.written });
  for (const invalid of [false, true]) {
    const last = options(i), lastDir = asm.resolveOutDir(last.outId);
    const r = clockEvent(() => asm.buildAssembly(last), 'after-postcheck-snapshot', lastDir, invalid);
    assert.equal(r.result.ok, false); assert.equal(r.filesAtEvent, 49); assert.equal(r.filesAfter, 49);
    report.cases.push({ id: invalid ? 'final-clock-invalid' : 'final-deadline', ...r,
      writtenFactLost: r.result.wroteFiles === false && r.result.written === null });
  }
  const oldBytes = fs.readFileSync(process.env.OLD_ASM_SRC);
  const blob = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${oldBytes.length}\0`), oldBytes])).digest('hex');
  assert.equal(blob, '6724cd8422daf21016633fb194ac0976ab9b698b');
  const m = new Module(asmPath, module); m.filename = asmPath; m.paths = Module._nodeModulePaths(path.dirname(asmPath));
  m._compile(oldBytes.toString('utf8'), asmPath); const old = m.exports;
  const si = input(true), oldId = fresh('old'), oo = { ...si, outId: oldId, nowMs: T };
  const built = old.buildAssembly(oo); assert.equal(built.ok, true); report.fixtures.push(built.dir);
  const original = snap(built.dir), manifestPath = path.join(built.dir, 'manifest.json');
  const originalManifest = fs.readFileSync(manifestPath), oldManifest = JSON.parse(originalManifest);
  assert.equal(Object.keys(oldManifest).length, 19);
  assert.equal(asm.checkAssembly({ ...si, outDir: built.dir }).ok, true);
  for (const kind of [undefined, 'synthetic']) {
    const r = asm.buildAssembly({ ...oo, artifactKind: kind });
    assert.equal(r.ok, true); assert.equal(r.reused, true); assert.equal(r.wroteFiles, false);
    assert.deepEqual(snap(built.dir), original);
  }
  const newBuilt = asm.buildAssembly({ ...si, outId: fresh('new'), nowMs: T });
  assert.equal(newBuilt.ok, true); report.fixtures.push(newBuilt.dir);
  assert.ok(fs.readFileSync(path.join(newBuilt.dir, 'manifest.json')).equals(originalManifest));
  report.cases.push({ id: 'actual-historical-schema1', passed: true, gitBlob: blob, fields: 19,
    defaultAndExplicitReuse: true, byteIdentical: true });
  for (const [id, alter] of [
    ['old-required-field', x => { delete x.cloudFunctionName; }],
    ['old-extra-candidate-field', x => { x.artifactKind = 'synthetic'; }]
  ]) {
    const tampered = JSON.parse(originalManifest); alter(tampered);
    fs.writeFileSync(manifestPath, JSON.stringify(tampered)); const before = snap(built.dir);
    const r = asm.checkAssembly({ ...si, outDir: built.dir });
    assert.equal(r.ok, false); assert.deepEqual(snap(built.dir), before);
    report.cases.push({ id, passed: true, result: summary(r), unchanged: true });
  }
  fs.writeFileSync(manifestPath, originalManifest);
  const realPath = path.join(dir, 'manifest.json'), realBytes = fs.readFileSync(realPath);
  for (const key of ['artifactKind', 'verificationKind']) {
    const tampered = JSON.parse(realBytes); delete tampered[key]; fs.writeFileSync(realPath, JSON.stringify(tampered));
    const before = snap(dir);
    const r = asm.checkAssembly({ ...i, outDir: dir, artifactKind: 'real-candidate', nowMs: T });
    assert.equal(r.ok, false); assert.deepEqual(snap(dir), before);
    report.cases.push({ id: 'candidate-missing-' + key, passed: true, result: summary(r) });
  }
  fs.writeFileSync(realPath, realBytes);
  for (const [from, opts] of [
    ['/1-to-/2', { ...si, outDir: built.dir, artifactKind: 'real-candidate', nowMs: T }],
    ['/2-to-/1', { ...i, outDir: dir, artifactKind: 'synthetic', nowMs: T }]
  ]) { const r = asm.checkAssembly(opts); assert.equal(r.ok, false); report.cases.push({ id: from, passed: true, result: summary(r) }); }
  const drift = tracked.filter(p => !fs.existsSync(path.join(ROOT,p)) || baseline.get(p) !== sha(fs.readFileSync(path.join(ROOT,p))));
  assert.deepEqual(drift, []); assert.equal(guard.attempts.length, 0);
  report.protected = { count: tracked.length, drift }; report.networkAttempts = guard.attempts.length;
  report.summary = { cases: report.cases.length, passed: report.cases.filter(x => x.passed).length,
    writtenFactLossReproduced: report.cases.filter(x => x.writtenFactLost).length };
} finally { asm.restoreNetworkGuard(guard); }
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
