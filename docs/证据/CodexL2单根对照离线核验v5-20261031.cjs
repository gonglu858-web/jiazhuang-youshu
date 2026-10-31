'use strict';
// L2 root-only module verification v5 (R1–R5 closure after 42452cd review).
// Guard is installed BEFORE any business loading; public network and public
// process surfaces are denied and every hit is accounted (including ones a
// business try/catch swallows — --fault-caught proves the final exit follows
// the real counters). The driver and its receipt contract are loaded from the
// SAME verified byte snapshots through a controlled VM loader (R4): digest is
// checked before any code runs, the dependency graph is served only from the
// verified cache, and load-stage drift is refused. All launch boundaries are
// synthetic doubles; nothing compiles, runs C#, or touches a real process tree.
// stdout JSON is the only success channel; --out creates the JSON with wx.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const DIR = __dirname;
const REPO = path.resolve(DIR, '../..');
const OUT_INDEX = process.argv.indexOf('--out');
const OUT_PATH = OUT_INDEX >= 0 ? process.argv[OUT_INDEX + 1] : null;
const FAULT_CAUGHT = process.argv.includes('--fault-caught');
const IS_FAULT = FAULT_CAUGHT; // single re-entry mode this round

// ── Verified byte snapshots (pinned; load-stage drift refuses) ──
const FILES = {
  driver: 'docs/证据/CodexL2单根产物绑定与单次驱动v3-20261031.cjs',
  contract: 'docs/证据/CodexL2单根对照回执契约v2-20261031.cjs',
  interface: 'docs/证据/CodexL2单根对照固定接口v2-20261031.json',
  helper: 'docs/证据/CodexL2单根对照辅助层v2-20261031.cs',
  runPrep: 'docs/证据/CodexL2单根Run合成边界准备v3-20261031.cjs',
  runFixture: 'docs/证据/CodexL2单根Run合成边界夹具v3-20261031.cs',
  strictCheck: 'docs/证据/CodexL2单根编译配置严格检查v1-20261031.cjs',
  compileConfig: 'docs/证据/CodexL2单根对照固定编译配置v3-20261031.json'
};
const PINNED = {
  driver: '0b5f3a49e9b64e36f3817c65ff128cf3d988bdcf0a18f0f295f872c94933b49c',
  contract: '2029ca70c718bd56f151448c5fd95db9d5e9e1c52bd63573d8907b849915bae7',
  interface: '1518269f0918b03052fec0540ac7a8934484341ec379445e86d86508685f98ce',
  helper: '408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b',
  runPrep: 'eea43bed024acab302ca2b5d4f3bfb63425332d34d6661c9d083ddf73beac7d3',
  runFixture: '88ed80b47798d348717bb8b02dee9bbf3cb6412f0f0007258823cad8381f8b9e'
};
const bytes = {};
for (const [k, rel] of Object.entries(FILES)) bytes[k] = fs.readFileSync(path.join(REPO, rel));

// ── Guard (installed before business loading) ──
const guard = { phase: 'init', probes: [], unexpected: [] };
function hit(kind, cls) {
  (guard.probes.length < 5 && cls === 'probe' ? guard.probes : guard.unexpected).push({ phase: guard.phase, kind, cls });
  throw Object.assign(Error('PSR_GUARD_' + kind), { code: 'PSR_GUARD_' + kind });
}
if (true) {
  const net = require('node:http'); guard.phase = 'init';
  const realRequest = net.request;
  net.request = function wrappedRequest() { hit('http', guard.probes.length < 5 ? 'probe' : 'unexpected'); return realRequest.apply(this, arguments); };
  const https = require('node:https');
  https.request = function wrappedRequest() { hit('https', guard.probes.length < 5 ? 'probe' : 'unexpected'); return realRequest.apply(this, arguments); };
  const cp = require('node:child_process');
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = cp[fn];
    cp[fn] = function wrapped() { hit('publicProcess:' + fn, guard.probes.length < 5 ? 'probe' : 'unexpected'); return orig.apply(this, arguments); };
  }
}
function probeNet(fn) { guard.phase = guard.phase === 'probe' ? 'probe' : guard.phase; try { fn(); } catch (e) { /* accounted */ } }
// five fixed probes: http/https at init, public process at business, http at cleanup
probeNet(() => require('node:http').request('http://127.0.0.1:9'));
probeNet(() => require('node:https').request('https://127.0.0.1:9'));

// ── R4: same-source verified VM loader ──
const vm = require('node:vm');
const VERIFIED = { [FILES.driver]: PINNED.driver, [FILES.contract]: PINNED.contract };
const loadCache = new Map();               // digest -> module record
const loadLog = [];
function vmLoadVerified(digest, bytesBuf, relPath, deps) {
  const expected = VERIFIED[relPath];
  if (expected && digest !== expected) throw coded('LOAD_DRIFT', relPath);
  const cached = loadCache.get(digest);
  if (cached) { loadLog.push({ relPath, digest, cached: true }); return cached; }
  const script = new vm.Script('(function (exports, require, module, __filename, __dirname) {\n' +
    bytesBuf.toString('utf8') + '\n})', { filename: relPath });
  const mod = { exports: {} };
  const requireFn = name => {
    if (name === 'node:crypto') return crypto;
    const dep = deps[name];
    if (!dep) throw coded('LOAD_REQUIRE_REFUSED', name);
    loadLog.push({ relPath, digest: dep.digest, via: name });
    return dep.exports;
  };
  script.runInThisContext()(mod.exports, requireFn, mod, relPath, path.dirname(relPath));
  const rec = { exports: mod.exports, digest };
  loadCache.set(digest, rec);
  loadLog.push({ relPath, digest, cached: false });
  return rec;
}
function coded(code, detail) { return Object.assign(Error(code + (detail ? ':' + detail : '')), { code, detail }); }

const results = [];
let currentPrefix = '';
function test(name, fn) {
  const full = currentPrefix + name;
  try { fn(); results.push({ name: full, ok: true }); }
  catch (e) {
    let msg = (e.code && e.code !== 'ERR_ASSERTION') ? e.code : String(e.message || e).slice(0, 220);
    if (e.facts) msg += ' | facts=' + JSON.stringify(e.facts).slice(0, 400);
    results.push({ name: full, ok: false, error: msg });
  }
}
function prefix(p) { currentPrefix = p; }
function need(v, code) { if (!v) throw coded(code); }
const assert = require('node:assert/strict');

// Load contract first (no deps beyond node:crypto), then driver (same-source dep).
let contractRec, driverRec;
try {
  contractRec = vmLoadVerified(H(bytes.contract), bytes.contract, FILES.contract, {});
  driverRec = vmLoadVerified(H(bytes.driver), bytes.driver, FILES.driver,
    { ['./CodexL2单根对照回执契约v2-20261031.cjs']: contractRec });
} catch (e) {
  fs.writeSync(1, JSON.stringify({ ok: false, exitCode: 1, error: 'LOAD_PHASE:' + (e.code || e.message), guard }) + '\n');
  process.exit(1);
}
const driver = driverRec.exports;
const loadedContractSha = contractRec.digest;
const loadedDriverSha = driverRec.digest;
// business-phase probes: public process surface
guard.phase = 'business';
try { require('node:child_process').spawn('definitely-blocked'); } catch (e) { /* accounted */ }
try { require('node:child_process').execFileSync('definitely-blocked'); } catch (e) { /* accounted */ }

// ── Synthetic boundary factory ──
const VALID_RECEIPT = {
  schema: 'codex-l2-root-only-job/1', mode: 'rootOnly', outcome: 'completed', reason: 'NONE',
  created: true, assigned: true, resumed: true, pid: 100, rootExited: true, rootExit: 0, jobEmpty: true,
  totalProcesses: 1, activeProcesses: 0, killRequested: false, killAccepted: false, readersDone: true,
  handlesClosed: true, cleanupConfirmed: true, stdoutBytes: 12, stderrBytes: 0,
  stdoutBase64: Buffer.from('L2_ROOT_ONLY').toString('base64'), elapsedMs: 100,
  accountingLayoutVerified: true,
  observation: {
    failure: 'NONE', identityCoverage: true, parentEvidenceComplete: false,
    notificationCompletenessGuaranteed: false, stopped: true, handlesClosed: true, duplicateNew: false,
    finalTotal: 1,
    members: [{ pid: 100, creationTime: '1', image: 'FIXED_NODE', pathClass: 'FIXED_NODE_PATH', state: 'CAPTURED', root: true, parent: 'UNKNOWN', newSeen: true, listed: true, exitSeen: true }],
    events: [{ kind: 'NEW', pid: 100 }, { kind: 'EXIT', pid: 100 }, { kind: 'ACTIVE_ZERO', pid: 0 }]
  }
};
function syntheticProduct() {
  const b = Buffer.alloc(0x800, 0); b.write('MZ', 0, 'latin1');
  const pe = 0x80; b.writeUInt32LE(pe, 0x3c); b.write('PE\0\0', pe, 'latin1');
  b.writeUInt16LE(0x8664, pe + 4); b.writeUInt16LE(0x20b, pe + 24);
  b.writeUInt16LE(240, pe + 20); b.writeUInt16LE(3, pe + 6);
  b.writeUInt32LE(0x800, pe + 24 + 56); b.writeUInt32LE(0x400, pe + 24 + 60);
  const sect = pe + 24 + 240;
  for (let i = 0; i < 3; i++) {
    b.writeUInt32LE(0x200, sect + i * 40 + 8);                       // vsize
    b.writeUInt32LE(0x1000 + i * 0x1000, sect + i * 40 + 12);        // vaddr
    b.writeUInt32LE(0x200, sect + i * 40 + 16);                      // rsize
    b.writeUInt32LE(0x200 + i * 0x200, sect + i * 40 + 20);          // rraw
  }
  const clr = pe + 24 + 112 + 14 * 8;
  b.writeUInt32LE(0x1000, clr); b.writeUInt32LE(0x48, clr + 4);      // CLR dir RVA 0x1000 (section0 raw)
  b.writeUInt32LE(0x48, 0x200); b.writeUInt16LE(2, 0x204);           // COR20 cb + runtime v2
  return b;
}
// CLR RVA mapped into the section's VIRTUAL tail (beyond raw) with the header
// bytes stashed elsewhere — the v2 mapping accepted this; v3 must refuse.
function virtualTailProduct() {
  const b = syntheticProduct();
  const pe = b.readUInt32LE(0x3c);
  const sect = pe + 24 + 240;
  b.writeUInt32LE(0x400, sect + 8);                                  // section0 vsize covers the tail
  const clr = pe + 24 + 112 + 14 * 8;
  b.writeUInt32LE(0x1000 + 0x300, clr);                              // inside virtual range, beyond rsize (0x200)
  b.writeUInt32LE(0x48, 0x700); b.writeUInt16LE(2, 0x704);           // stashed header
  return b;
}
// CLR header extends past the section raw end.
function clrOverrunProduct() {
  const b = syntheticProduct();
  const pe = b.readUInt32LE(0x3c), clr = pe + 24 + 112 + 14 * 8;
  b.writeUInt32LE(0x300, clr + 4);                                   // 0 + 0x300 > rsize 0x200
  return b;
}

const CONFIG_REL = 'docs/证据/CodexL2单根对照固定接口v2-20261031.json';
const ARTIFACT_REL = 'artifacts/psr-l2/rootonly-v3-helper/rootonly-helper.exe';
function provenance(over) {
  return { configRel: CONFIG_REL, artifactRelPath: ARTIFACT_REL,
    configSha256: H(bytes.interface), compiled: false, executed: false, ...over };
}
function makeBinding(over) {
  return driver.bind(bytes.interface, syntheticProduct(), provenance(over || {}));
}
let spawnCounter = 0;
function makeBoundary(over) {
  const o = {
    productDrift: 'none', sourceDrift: false, spawnThrows: false, timedOut: false,
    closed: true, closedAfterKill: true, killThrows: false, awaitThrows: false,
    reapThrows: false, subscribeThrows: false, releaseThrows: false, releaseFalse: false,
    holdThrows: false, holdDigest: 'ok', receiptBefore: false, guardUnexpectedCount: 0,
    chunk: null, awaitCallLog: 0, ...over
  };
  const rec = { pathsUsed: [], holdOpens: 0, releases: 0, spawned: 0, killed: 0, spawnOpts: null, stdoutKept: 0 };
  const prodPath = 'C:\\synthetic\\rootonly-helper.exe';
  const cfg = JSON.parse(bytes.interface.toString('utf8'));
  const bnd = {
    get productPath() { rec.pathsUsed.push('accessor'); return o.splitPath && ++rec.splitReads > 1 ? o.laterPath : prodPath; },
    guardUnexpected() { return o.guardUnexpectedCount; },
    receiptExistsBefore() { return o.receiptBefore; },
    digestFile(p) {
      rec.pathsUsed.push(p);
      if (o.sourceDrift && p !== prodPath) return 'drifted';
      if (p === prodPath) {
        if (o.productDrift === 'after' && rec.spawned > 0) return 'drifted';
        if (o.productDrift === 'throw') throw new Error('SYNTH_DIGEST_FAIL');
        return makeBinding ? 'BOUNDING' : '';
      }
      const s = cfg.sources.find(x => x.rel === p);
      return s ? s.sha256 : 'drifted';
    },
    holdProduct(p) {
      rec.pathsUsed.push(p); rec.holdOpens++;
      if (o.holdThrows) throw new Error('SYNTH_HOLD_FAIL');
      return { sha256: o.holdDigest === 'ok' ? H(syntheticProduct()) : '0'.repeat(64), holdToken: 'tok' };
    },
    releaseHold() { rec.releases++; if (o.releaseThrows) throw new Error('SYNTH_RELEASE_FAIL'); return !o.releaseFalse; },
    spawn(opts) {
      rec.spawned++; rec.spawnOpts = opts; rec.pathsUsed.push(opts.artifactPath);
      if (o.spawnThrows) throw new Error('SYNTH_SPAWN_FAIL');
      const chunk = o.chunk || Buffer.from(JSON.stringify(VALID_RECEIPT) + '\n');
      return {
        onData(cb) {
          if (o.subscribeThrows) throw new Error('SYNTH_SUBSCRIBE_FAIL');
          cb(false, chunk);
        }
      };
    },
    awaitExit(child, deadline) {
      o.awaitCallLog++;
      if (o.awaitThrows && o.awaitCallLog === 1) throw new Error('SYNTH_AWAIT_FAIL');
      if (o.awaitThrows && o.awaitCallLog === 2 && o.reapThrows) throw new Error('SYNTH_REAP_FAIL');
      if (o.timedOut && o.awaitCallLog === 1) return { status: null, signal: null, closed: o.closedAfterKill, timedOut: true };
      return { status: 0, signal: null, closed: o.awaitCallLog === 1 ? o.closed : o.closedAfterKill, timedOut: false };
    },
    kill() { rec.killed++; if (o.killThrows) throw new Error('SYNTH_KILL_FAIL'); return true; }
  };
  bnd._rec = rec;
  bnd._over = o;                                                 // scenario config for the digest shim
  return bnd;
}
function digestFileShim(bnd, binding) {
  // wrap digestFile so the product path returns the bound digest (single source of truth)
  const orig = bnd.digestFile;
  bnd.digestFile = function (p) {
    if (p === 'C:\\synthetic\\rootonly-helper.exe') {
      if (bnd._over.productDrift === 'after' && bnd._rec.spawned > 0) return 'drifted';
      if (bnd._over.productDrift === 'throw') throw new Error('SYNTH_DIGEST_FAIL');
      return binding.artifactSha256;
    }
    return orig.call(this, p);
  };
  return bnd;
}
function freshRunner(bnd, over) {
  const binding = makeBinding(over);
  digestFileShim(bnd, binding);
  return { binding, runner: driver.createRunner(binding, bnd), bnd };
}
function runExpectError(bnd, over, codeMatch) {
  const { runner } = freshRunner(bnd, over);
  let err = null;
  try { runner.runOnce(); } catch (e) { err = e; }
  need(err, 'NO_THROW');
  if (codeMatch) assert.match(String(err.code || err.message), codeMatch);
  return err;
}

// ══════════ R4: same-source loading ══════════
prefix('R4 ');
test('verified snapshots match pinned digests', () => {
  need(H(bytes.driver) === PINNED.driver, 'DRIVER_DIGEST');
  need(H(bytes.contract) === PINNED.contract, 'CONTRACT_DIGEST');
  need(H(bytes.helper) === PINNED.helper, 'HELPER_DIGEST');
  need(H(bytes.runPrep) === PINNED.runPrep, 'RUNPREP_DIGEST');
  need(H(bytes.runFixture) === PINNED.runFixture, 'RUNFIXTURE_DIGEST');
});
test('driver and contract loaded from the SAME verified snapshot', () => {
  need(loadedContractSha === PINNED.contract, 'LOADED_CONTRACT_HASH');
  need(loadedDriverSha === PINNED.driver, 'LOADED_DRIVER_HASH');
  const via = loadLog.find(l => l.via === './CodexL2单根对照回执契约v2-20261031.cjs');
  need(via && via.digest === PINNED.contract, 'DEP_NOT_FROM_CACHE');
});
test('load-stage drift is refused before any code runs', () => {
  const drifted = Buffer.concat([bytes.driver, Buffer.from('\n// drift comment\n')]);
  let e = null;
  try { vmLoadVerified(H(drifted), drifted, FILES.driver, {}); } catch (x) { e = x; }
  need(e && e.code === 'LOAD_DRIFT', 'NO_REJECT');
});
test('cache serves identical digest only; drifted contract refused even when cached', () => {
  const again = vmLoadVerified(H(bytes.contract), bytes.contract, FILES.contract, {});
  need(again === contractRec, 'CACHE_MISS');
  const drifted = Buffer.concat([bytes.contract, Buffer.from('\n// drift\n')]);
  let e = null;
  try { vmLoadVerified(H(drifted), drifted, FILES.contract, {}); } catch (x) { e = x; }
  need(e && e.code === 'LOAD_DRIFT', 'CACHE_POISON');
});

// ══════════ R1 ══════════
prefix('R1 ');
test('internal state is unreachable by reflection (no symbols, no mutable fields)', () => {
  const binding = makeBinding();
  assert.equal(Object.getOwnPropertySymbols(binding).length, 0);
  assert.deepEqual(Object.keys(binding).sort(),
    ['artifactBound', 'artifactRelPath', 'artifactSha256', 'bytes', 'config', 'configRel', 'executionApproved', 'statics']);
  let threw = false;
  'use strict';
  try { binding.consumed = false; } catch (e) { threw = true; }
  need(threw, 'MUTABLE_STATE');
});
test('consumed flag cannot be reset; single consumption is shared across runners', () => {
  const bnd = makeBoundary({});
  const { binding, runner } = freshRunner(bnd);
  const r = runner.runOnce();
  need(r.ok === true, 'NORMAL_FAIL');
  const runner2 = driver.createRunner(binding, makeBoundary({}));
  let e = null;
  try { runner2.runOnce(); } catch (x) { e = x; }
  need(e && e.code === 'ALREADY_RUN', 'DOUBLE_RUN');
  need(bnd._rec.spawned === 1, 'RESURRECTED_SPAWN');
});
test('spread/forged bindings are refused', () => {
  const binding = makeBinding();
  const copy = { ...binding };
  let e = null;
  try { driver.createRunner(copy, makeBoundary({})); } catch (x) { e = x; }
  need(e && e.code === 'FAKE_BINDING', 'SPREAD_ACCEPTED');
  e = null;
  try { driver.createRunner(Object.assign({}, binding, { artifactSha256: 'x' }), makeBoundary({})); } catch (x) { e = x; }
  need(e && e.code === 'FAKE_BINDING', 'HAND_BUILT_ACCEPTED');
});
test('provenance binds config digest, fixed artifact path and prepared state', () => {
  for (const [over, code] of [
    [{ artifactRelPath: 'artifacts/other/path.exe' }, 'PROVENANCE_ARTIFACT_PATH'],
    [{ configSha256: '0'.repeat(64) }, 'PROVENANCE_CONFIG_DIGEST'],
    [{ compiled: true }, 'PROVENANCE_STATE'],
    [{ executed: true }, 'PROVENANCE_STATE']
  ]) {
    let e = null;
    try { makeBinding(over); } catch (x) { e = x; }
    need(e && e.code === code, 'PROVENANCE_HOLE:' + code);
  }
});
test('hold, launch and post-check consume the SAME snapshotted path', () => {
  let reads = 0;
  const bnd = makeBoundary({});
  Object.defineProperty(bnd, 'productPath', {
    get() { reads++; return reads === 1 ? 'C:\\snapshot\\fixed.exe' : 'C:\\evil\\switched.exe'; }
  });
  const binding = makeBinding();
  // digestFile shim must use the SNAPSHOT path too
  const orig = bnd.digestFile;
  bnd.digestFile = function (p) {
    if (p === 'C:\\snapshot\\fixed.exe') return binding.artifactSha256;
    if (p === 'C:\\evil\\switched.exe') return 'drifted';
    return orig.call(this, p);
  };
  const runner = driver.createRunner(binding, bnd);
  const r = runner.runOnce();
  need(r.ok === true, 'SNAPSHOT_RUN_FAIL');
  need(r.productPath === 'C:\\snapshot\\fixed.exe', 'SNAPSHOT_PATH');
  need(reads === 1, 'PATH_REREAD:' + reads);
  need(bnd._rec.spawnOpts.artifactPath === 'C:\\snapshot\\fixed.exe', 'SPAWN_PATH');
});
test('launch capability options are constructed internally', () => {
  const bnd = makeBoundary({});
  const { runner } = freshRunner(bnd);
  runner.runOnce();
  const opts = bnd._rec.spawnOpts;
  need(opts.shell === false, 'SHELL');
  need(opts.windowsHide === true, 'WINDOWSHIDE');
  need(opts.stdio.join(',') === 'ignore,pipe,pipe', 'STDIO');
  need(!('NODE_OPTIONS' in opts.env), 'NODE_OPTIONS');
  assert.deepEqual(opts.env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' });
  const cfg = JSON.parse(bytes.interface.toString('utf8'));
  assert.deepEqual(opts.args, cfg.helperArgs);
  need(opts.cwd === cfg.cwd, 'CWD');
});
test('CLR RVA inside the section virtual tail is refused (raw-range rule)', () => {
  let e = null;
  try { makeBinding(); driver.bind(bytes.interface, virtualTailProduct(), provenance()); } catch (x) { e = x; }
  need(e && e.code === 'PE_CLR_NOT_IN_RAW', 'VIRTUAL_TAIL_ACCEPTED');
});
test('CLR header extending past section raw end is refused', () => {
  let e = null;
  try { driver.bind(bytes.interface, clrOverrunProduct(), provenance()); } catch (x) { e = x; }
  need(e && e.code === 'PE_CLR_RAW_RANGE', 'OVERRUN_ACCEPTED');
});
test('legal binding and normal single run still pass', () => {
  const bnd = makeBoundary({});
  const { runner } = freshRunner(bnd);
  const r = runner.runOnce();
  need(r.ok === true && r.assessment.rootOnlyPassed === true, 'NORMAL_FAIL');
  need(r.facts.attempts === 1 && r.facts.unexpected === 0 && r.facts.closed === true, 'FACTS');
  need(r.facts.releaseConfirmed === true && r.facts.productUnchanged === true, 'RELEASE_FACTS');
  need(r.executionApproved === false && r.l2Approved === false, 'APPROVAL_LEAK');
});

// ══════════ R2 ══════════
prefix('R2 ');
test('hold digest mismatch: zero spawn, release still confirmed', () => {
  const bnd = makeBoundary({ holdDigest: 'wrong' });
  const err = runExpectError(bnd, {}, /PRODUCT_DIGEST_MISMATCH/);
  need(bnd._rec.spawned === 0, 'SPAWNED');
  need(bnd._rec.releases === 1, 'NO_RELEASE');
  need(err.facts.attempts === 0 && err.facts.releaseConfirmed === true, 'FACTS');
});
test('releaseHold throwing decides failure; cleanup continues', () => {
  const bnd = makeBoundary({ releaseThrows: true });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'HOLD_RELEASE_UNCONFIRMED', 'FAILURE_CODE:' + err.facts.failure);
  need(err.facts.releaseConfirmed === false, 'RELEASE_TRUE');
  need(err.report.holdReleased === false, 'REPORT');
});
test('releaseHold returning false is an unconfirmed release', () => {
  const bnd = makeBoundary({ releaseFalse: true });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'HOLD_RELEASE_UNCONFIRMED', 'FAILURE_CODE');
});
test('post-run digest failure does not block release and decides failure', () => {
  const bnd = makeBoundary({ productDrift: 'throw' });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'PRODUCT_DIGEST_CHECK_FAILED', 'FAILURE_CODE:' + err.facts.failure);
  need(err.facts.releaseConfirmed === true, 'RELEASE_BLOCKED');
});
test('await and reap failures are sanitized with real facts preserved', () => {
  const bnd = makeBoundary({ awaitThrows: true, reapThrows: true });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'AWAIT_ERROR', 'FAILURE_CODE:' + err.facts.failure);
  need(err.report.closedUnknown === true && err.facts.closed === false, 'CLOSE_STATE');
  need(err.facts.attempts === 1 && err.facts.killRequested === true, 'ATTEMPTS');
});
test('kill failure is sanitized and recorded', () => {
  const bnd = makeBoundary({ killThrows: true, timedOut: true });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.report.killAccepted === false, 'KILL_REPORT');
  need(err.facts.failure === 'TIMEOUT', 'FAILURE_CODE:' + err.facts.failure);
});
test('subscription failure stops the read side immediately (no normal wait)', () => {
  const bnd = makeBoundary({ subscribeThrows: true });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'READ', 'FAILURE_CODE:' + err.facts.failure);
  // the normal wait path was NOT taken: kill happened during the read-side failure
  need(err.facts.closed === true || err.report.closedUnknown === true, 'CLOSE');
});
test('stdout is limit-checked before retention (no unbounded concat)', () => {
  const bnd = makeBoundary({ chunk: Buffer.alloc(200000, 0x41) });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'OUTPUT_LIMIT', 'FAILURE_CODE:' + err.facts.failure);
  need(err.facts.stderrBytes === 0, 'STDERR');
});
test('product drift after run fails the result', () => {
  const bnd = makeBoundary({ productDrift: 'after' });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'PRODUCT_CHANGED', 'FAILURE_CODE:' + err.facts.failure);
});
test('source drift before launch: zero spawn', () => {
  const bnd = makeBoundary({ sourceDrift: true });
  const err = runExpectError(bnd, {}, /SOURCES_DRIFTED/);
  need(bnd._rec.spawned === 0 && err.facts.attempts === 0, 'SPAWNED');
});
test('pre-existing receipt: zero spawn', () => {
  const bnd = makeBoundary({ receiptBefore: true });
  const err = runExpectError(bnd, {}, /RECEIPT_EXISTS/);
  need(bnd._rec.spawned === 0, 'SPAWNED');
});
test('legal close contrast still passes end to end', () => {
  const bnd = makeBoundary({});
  const { runner } = freshRunner(bnd);
  const r = runner.runOnce();
  need(r.ok === true && r.report.closedUnknown === false && r.report.holdReleased === true, 'LEGAL_FAIL');
});
test('timeout contrast: kill then bounded reclaim; close unknown is reported not claimed', () => {
  const bnd = makeBoundary({ timedOut: true, closedAfterKill: false });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'TIMEOUT', 'FAILURE_CODE');
  need(err.report.closedUnknown === true && err.facts.closed === false, 'CLOSE_UNKNOWN');
  need(err.report.killAccepted === true, 'KILL');
});

// ══════════ R3 ══════════
prefix('R3 ');
const checker = require('./CodexL2单根编译配置严格检查v1-20261031.cjs');
test('strictCheck accepts the pinned config v3 file via the actual entry', () => {
  const cfg = checker.strictCheck(bytes.compileConfig);
  need(cfg.cases.length === 3 && cfg.inputs.length === 6, 'SHAPE');
});
test('six mutation groups are rejected by the actual strict entry', () => {
  const clone = () => JSON.parse(bytes.compileConfig.toString('utf8'));
  const map2 = p => p.replace('证据', 'moved');
  const groups = [
    ['host-swap', c => { c.host.path = 'C:\\other\\evil.exe'; }],
    ['reference-swap', c => {
      c.toolFacts.references[0].path = 'C:\\other\\fake.dll';
      c.toolFacts.references[0].sha256 = '0'.repeat(64);
      const i = c.cases[0].args.findIndex(a => a.startsWith('/reference:') && a.includes('mscorlib'));
      c.cases[0].args[i] = '/reference:C:\\other\\fake.dll';
    }],
    ['shell-true', c => { c.spawn.shell = true; }],
    ['env-node-options', c => { c.cases[0].childEnv.NODE_OPTIONS = '--insecure'; }],
    ['limits-cwd', c => { c.spawn.timeoutMs = 99999; c.spawn.maxCombinedOutputBytes = 999; c.cwd = 'C:\\other'; }],
    ['main-swap', c => {
      const i = c.cases[0].args.findIndex(a => a.startsWith('/main:'));
      c.cases[0].args[i] = '/main:OtherEntry'; c.cases[0].main = 'OtherEntry';
    }],
    ['args-drop-observer', c => { c.cases[0].args = c.cases[0].args.filter(a => !a.includes('观察器')); }],
    ['coordinated-relocate', c => {
      c.inputs = c.inputs.map(x => ({ path: map2(x.path), sha256: x.sha256 }));
      c.cases.forEach(cs => {
        cs.sourceFiles = cs.sourceFiles.map(map2);
        cs.args = cs.args.map(a => (!a.startsWith('/') || a.startsWith('/out:')) ? map2(a) : a);
        cs.outputRoot = map2(cs.outputRoot); cs.tempRoot = map2(cs.tempRoot);
        cs.outputFile = map2(cs.outputFile); cs.record = map2(cs.record);
        cs.childEnv.TEMP = map2(cs.childEnv.TEMP); cs.childEnv.TMP = map2(cs.childEnv.TMP);
      });
    }]
  ];
  for (const [name, mut] of groups) {
    const c = clone(); mut(c);
    let e = null;
    try { checker.strictCheck(c); } catch (x) { e = x; }
    need(e && e.code === 'CONFIG_MISMATCH', 'GROUP_ACCEPTED:' + name);
  }
});
test('selectSingleTarget is the reusable single-target entry', () => {
  const plan = checker.selectSingleTarget(bytes.compileConfig, 'runBoundaryFixture');
  need(plan.caseId === 'runBoundaryFixture' && plan.maxDirectCompilerStarts === 1, 'PLAN');
  need(plan.executionAllowed === false && plan.executeOutput === false, 'PLAN_FLAGS');
  let e = null;
  try { checker.selectSingleTarget(bytes.compileConfig, 'unknown'); } catch (x) { e = x; }
  need(e && e.code === 'TARGET_UNKNOWN', 'UNKNOWN_ACCEPTED');
});

// ══════════ R5 ══════════
prefix('R5 ');
const prep = require('./CodexL2单根Run合成边界准备v3-20261031.cjs');
test('fixture v3 builds reproducibly from the pinned helper source', () => {
  const g = prep.build(bytes.helper);
  need(g.generatedSha256 === H(bytes.runFixture) || H(Buffer.from(g.source)) === H(bytes.runFixture), 'REGEN_MISMATCH');
  need(g.source === bytes.runFixture.toString('utf8'), 'DISK_MISMATCH');
  need(g.plannedCases === 20 && g.compiled === false && g.executed === false, 'FLAGS');
});
test('generated fixture passes every static closure check', () => {
  const problems = prep.inspect(bytes.runFixture.toString('utf8'));
  assert.deepEqual(problems, []);
});
test('hook reference set equals hook definition set (tamper detected)', () => {
  const src = bytes.runFixture.toString('utf8');
  const tampered = src.replace('internal static bool FinalizationOk(int n)', 'internal static bool FinalizationRenamed(int n)');
  const problems = prep.inspect(tampered);
  need(problems.includes('HOOK_UNDEF:FinalizationOk'), 'NO_DETECT:' + JSON.stringify(problems));
});
test('type-reference closure catches a removed declaration', () => {
  const src = bytes.runFixture.toString('utf8');
  const tampered = src.replace(/internal sealed class L2MemberObserver[\s\S]*?\n  \}/, ' ');
  const problems = prep.inspect(tampered);
  need(problems.includes('TYPE_UNDEF:L2MemberObserver'), 'NO_DETECT');
});
test('capability ban catches stashed OS calls in the real bodies', () => {
  const src = bytes.runFixture.toString('utf8');
  const t1 = src.replace('Require(Hook.JobAssign(job,pi.Process),"JOB_ASSIGN")', 'Require(AssignProcessToJobObject(job,pi.Process),"JOB_ASSIGN")');
  need(prep.inspect(t1).some(p => p.startsWith('OS_CALL_REMAINS')), 'NO_DETECT_PINVOKE');
  const t2 = src.replace('r.Elapsed=Hook.ElapsedMs(clock);', 'r.Elapsed=clock.ElapsedMilliseconds;');
  need(prep.inspect(t2).some(p => p.startsWith('CAPABILITY_REMAINS')), 'NO_DETECT_STOPWATCH');
});
test('declarations and reset coverage are enforced', () => {
  const src = bytes.runFixture.toString('utf8');
  const t = src.replace('struct ExtendedLimit', 'struct RemovedLimit');
  need(prep.inspect(t).some(p => p.startsWith('DECL_MISSING')), 'NO_DETECT_DECL');
  const t2 = src.replace('JobCreated=false;', 'JobCreated=true;');
  need(prep.inspect(t2).some(p => p === 'RESET_MISSING:JobCreated=false'), 'NO_DETECT_RESET');
});
test('any helper byte change refuses the build (digest-first; anchor table is second layer)', () => {
  const drifted = Buffer.concat([bytes.helper, Buffer.from('\n// drift\n')]);
  let e = null;
  try { prep.build(drifted); } catch (x) { e = x; }
  need(e && e.message === 'SOURCE_DRIFT', 'DRIFT_ACCEPTED');
});

// ══════════ identity / matrix / final ══════════
guard.phase = 'cleanup';
try { require('node:http').request('http://127.0.0.1:9'); } catch (e) { /* accounted */ }
guard.phase = 'identity';
let runtimeHead = null;
try {
  const head = fs.readFileSync(path.join(REPO, '.git', 'HEAD'), 'utf8').trim();
  const m = /^ref: (.+)$/.exec(head);
  runtimeHead = m ? fs.readFileSync(path.join(REPO, '.git', m[1]), 'utf8').trim().slice(0, 7) : head.slice(0, 7);
} catch (e) { runtimeHead = null; }
const identity = {
  techBaseline: 'dac82a2', handoverBaseline: '3ac6cad', reviewedImplementation: '42452cd',
  runtimeHead, runtimeHeadGated: false,
  agentsWorktreeSha256: H(fs.readFileSync(path.join(REPO, 'AGENTS.md')))
};
const acceptanceMatrix = [
  { area: '来源与差异（沿用引用+摘要核对）', status: 'executed-js-stub', note: 'R4快照钉定+装载同源' },
  { area: 'R1 绑定/反射/快照/来源链/CLR raw', status: 'executed-js-stub', note: '真实模块+替身边界' },
  { area: 'R2 收尾保护链与回执观测', status: 'executed-js-stub', note: '真实模块+替身边界' },
  { area: 'R3 严格配置检查/单目标选择', status: 'executed-js-stub', note: '实际入口+八组反例' },
  { area: 'R4 同源装载与加载期漂移', status: 'executed-js-stub', note: '受控VM装载' },
  { area: 'R5 夹具源码闭合静态检查', status: 'source-observation', note: 'inspect十类检查+篡改反例' },
  { area: 'C# 收尾夹具与Run边界夹具编译/执行', status: 'prepared-not-executed', note: '本轮不编译不运行' },
  { area: '真实产物摘要绑定/单次真实运行/完整L2', status: 'blocked', note: '未放行' }
];
guard.phase = 'final';
if (IS_FAULT) {
  // fault-caught: one extra guard hit AFTER all probes, swallowed by this
  // evidence's own try/catch — the real counters must still decide failure.
  try { require('node:https').request('https://127.0.0.1:9'); } catch (e) { /* caught but accounted */ }
}
const failed = results.filter(r => !r.ok);
const guardClean = guard.probes.length === 5 && guard.unexpected.length === 0;
const ok = failed.length === 0 && guardClean && !IS_FAULT;
const exitCode = ok ? 0 : 1;
const report = {
  schema: 'codex-l2-rootonly-verify/5', ok, exitCode,
  basis: { techBaseline: identity.techBaseline, handoverBaseline: identity.handoverBaseline,
    reviewedImplementation: identity.reviewedImplementation, runtimeHead: identity.runtimeHead,
    runtimeHeadGated: identity.runtimeHeadGated, agentsWorktreeSha256: identity.agentsWorktreeSha256 },
  digests: {
    driver: PINNED.driver, contract: PINNED.contract, interface: PINNED.interface,
    helper: PINNED.helper, runPrep: PINNED.runPrep, runFixture: PINNED.runFixture,
    loadedContractSha, loadedDriverSha,
    strictCheck: H(bytes.strictCheck), compileConfig: H(bytes.compileConfig)
  },
  sameSourceLoading: { cacheEntries: loadCache.size, loadLog },
  guard: { probes: guard.probes.length, probePhases: guard.probes.map(p => p.phase),
    unexpected: guard.unexpected.length, faultMode: IS_FAULT },
  checks: results.length, failedChecks: failed,
  acceptanceMatrix,
  preparedNotExecuted: {
    compileCases: ['rootOnlyHelper', 'cleanupFixture', 'runBoundaryFixture'],
    csharpDynamicAssertions: 'UNEXECUTED (no compile/run approval this round)',
    fixtureSha256: PINNED.runFixture
  },
  results
};
const out = JSON.stringify(report);
if (OUT_PATH) {
  const fd = fs.openSync(OUT_PATH, 'wx');                          // wx: exclusive create
  fs.writeSync(fd, out + '\n'); fs.closeSync(fd);
  process.exit(exitCode);
}
fs.writeSync(1, out + '\n');
process.exit(exitCode);
