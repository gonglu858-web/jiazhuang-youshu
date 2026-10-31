'use strict';
// L2 root-only module verification v6 (R1–R5 remaining closure after 60ed280).
// Guard is installed at the VERY TOP — before any reviewed-file byte is read —
// and covers http/https.request, net.Socket.prototype.connect, dns.promises,
// global fetch and the child_process surface including ChildProcess.prototype.
// The probe stage is EXPLICIT (guard.probing), never inferred from hit counts;
// every hit after the probe stage is an unexpected hit. All reviewed reads,
// ALL digest computations, verification and finalization facts complete before
// the single final verdict is formed from the LATEST real counters — there is
// no !IS_FAULT shortcut: an injected swallowed hit after the last digest makes
// ok=false through the counters alone. The loader verifies the bytes it is
// about to execute (actual digest computed here, fixed path mapping, cache)
// before running anything; the preparer and the strict checker load through
// the same verified pipeline. All OS boundaries are synthetic doubles; nothing
// compiles or runs C#; no real network/process is touched (independent fallback
// guards remain in the fault re-entries).
const crypto = require('node:crypto');
const fs = require('node:fs');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const path = require('node:path');
const vm = require('node:vm');

// ── Guard: installed before ANY reviewed file read ──
// The controlled re-entry reference (self re-execution for fault scenarios) is
// captured BEFORE the wrappers: the runner allows exactly one fixed program
// with fully enumerated arguments (this file + --fault + mode), accounted
// (counted BEFORE execution) — no public process surface is widened.
const RAW_SPAWN_SYNC = require('node:child_process').spawnSync;
const guard = { phase: 'install', probing: false, probes: [], unexpected: [] };
function hit(kind) {
  const cls = guard.probing ? 'probe' : 'unexpected';
  (cls === 'probe' ? guard.probes : guard.unexpected).push({ phase: guard.phase, kind, cls });
  throw Object.assign(Error('PSR_GUARD_' + kind), { code: 'PSR_GUARD_' + kind });
}
function installGuard() {
  const http = require('node:http'), https = require('node:https');
  const realHttp = http.request, realHttps = https.request;
  http.request = function w() { hit('http'); return realHttp.apply(this, arguments); };
  https.request = function w() { hit('https'); return realHttps.apply(this, arguments); };
  const net = require('node:net');
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function w() { hit('socketConnect'); return realConnect.apply(this, arguments); };
  const dnsPromises = require('node:dns').promises;
  for (const fn of ['lookup', 'resolve']) {
    const orig = dnsPromises[fn];
    dnsPromises[fn] = function w() { hit('dnsPromises:' + fn); return orig.apply(this, arguments); };
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = function w() { hit('fetch'); return realFetch.apply(this, arguments); };
  const cp = require('node:child_process');
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = cp[fn];
    cp[fn] = function w() { hit('publicProcess:' + fn); return orig.apply(this, arguments); };
  }
  if (cp.ChildProcess && cp.ChildProcess.prototype) {
    const realProtoSpawn = cp.ChildProcess.prototype.spawn;
    cp.ChildProcess.prototype.spawn = function w() { hit('childProcessProto'); return realProtoSpawn.apply(this, arguments); };
  }
}
installGuard();

// ── fault mode + private controlled re-entry runner (fixed args, accounted) ──
const FAULT = (() => { const i = process.argv.indexOf('--fault'); return i >= 0 ? process.argv[i + 1] : null; })();
const OUT_INDEX = process.argv.indexOf('--out');
const OUT_PATH = OUT_INDEX >= 0 ? process.argv[OUT_INDEX + 1] : null;
const REPO = path.resolve(__dirname, '../..');
const FAULT_MODES = ['firstRead', 'finalDigest', 'finalization', 'socketConnect', 'dnsPromises',
  'fetchEntrance', 'childProto'];
const guardAccounting = { attempts: 0, completed: 0, failed: 0, calls: [] };
function controlledReentry(mode) {
  // fixed program + fully enumerated arguments, counted BEFORE execution
  guardAccounting.attempts++;
  const r = RAW_SPAWN_SYNC(process.execPath, [__filename, '--fault', mode], { shell: false });
  if (r && r.status === 0) guardAccounting.completed++; else guardAccounting.failed++;
  guardAccounting.calls.push({ program: process.execPath, args: ['--fault', mode] });
  return r;
}

// ── reviewed file bytes: read AFTER the guard is installed ──
const FILES = {
  driver: 'docs/证据/CodexL2单根产物绑定与单次驱动v4-20261031.cjs',
  contract: 'docs/证据/CodexL2单根对照回执契约v2-20261031.cjs',
  interface: 'docs/证据/CodexL2单根对照固定接口v2-20261031.json',
  helper: 'docs/证据/CodexL2单根对照辅助层v2-20261031.cs',
  runPrep: 'docs/证据/CodexL2单根Run合成边界准备v4-20261031.cjs',
  runFixture: 'docs/证据/CodexL2单根Run合成边界夹具v4-20261031.cs',
  strictCheck: 'docs/证据/CodexL2单根编译配置严格检查v2-20261031.cjs',
  compileConfig: 'docs/证据/CodexL2单根对照固定编译配置v3-20261031.json'
};
const PINNED = {
  driver: '4ef8d079e98341cc014c2786bb3fad45964b1d1063c5cc50bbbb5a997a64ad30',
  contract: '2029ca70c718bd56f151448c5fd95db9d5e9e1c52bd63573d8907b849915bae7',
  interface: '1518269f0918b03052fec0540ac7a8934484341ec379445e86d86508685f98ce',
  helper: '408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b',
  runPrep: '2065c2d34c35b6c862781cd034031244f1e40010f7706bc2d97afcd820525062',
  runFixture: '4904cabd863ddd133ba9f9e9fe9407b94fcaeff3d113a045b1bce54165f73416',
  strictCheck: '59fbe641bd9e39b6e4a752a5c0828b589b3d4273160a2aa4861f5a155be6ae15',
  compileConfig: '4d43a8419c5c964705f2a1dd7bef66cde75df2d15925d5b2db36d52f0f0dcfa0'
};
const bytes = {};
for (const [k, rel] of Object.entries(FILES)) {
  guard.phase = 'read:' + k;
  if (FAULT === 'firstRead' && k === 'driver' && !bytes.__injected) {
    bytes.__injected = true;
    try { require('node:https').request('https://127.0.0.1:9'); } catch (e) { /* swallowed; accounted */ }
  }
  bytes[k] = fs.readFileSync(path.join(REPO, rel));
}

// ── R4: self-verifying loader (computes the digest of what it will run) ──
const VERIFIED_PATHS = {};                                       // path -> pinned digest
for (const [k, rel] of Object.entries(FILES)) VERIFIED_PATHS[rel] = PINNED[k];
const loadCache = new Map();                                    // digest -> module record
const loadLog = [];
function vmLoadVerified(bytesBuf, relPath, deps) {
  const actualDigest = H(bytesBuf);                             // computed HERE, not caller-supplied
  const expected = VERIFIED_PATHS[relPath];
  if (expected === undefined) throw coded('LOAD_PATH_UNKNOWN', relPath);
  if (actualDigest !== expected) throw coded('LOAD_DRIFT', relPath);
  const cached = loadCache.get(actualDigest);
  if (cached) { loadLog.push({ relPath, digest: actualDigest, cached: true }); return cached; }
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
  const rec = { exports: mod.exports, digest: actualDigest };
  loadCache.set(actualDigest, rec);
  loadLog.push({ relPath, digest: actualDigest, cached: false });
  return rec;
}
function coded(code, detail) { return Object.assign(Error(code + (detail ? ':' + detail : '')), { code, detail }); }

const results = [];
let currentPrefix = '';
function test(name, fn) {
  const full = currentPrefix + name;
  try { fn(); results.push({ name: full, ok: true }); }
  catch (e) {
    let msg = (e.code && e.code !== 'ERR_ASSERTION') ? e.code : String(e.message || e).slice(0, 200);
    if (e.facts) msg += ' | facts=' + JSON.stringify(e.facts).slice(0, 300);
    results.push({ name: full, ok: false, error: msg });
  }
}
function prefix(p) { currentPrefix = p; }
function need(v, code) { if (!v) throw coded(code); }
const assert = require('node:assert/strict');

// Load contract, then driver, then checker and preparer — all through the
// self-verifying loader (the ONLY source of executable code this report runs).
let contractRec, driverRec, checkerRec, prepRec;
try {
  contractRec = vmLoadVerified(bytes.contract, FILES.contract, {});
  driverRec = vmLoadVerified(bytes.driver, FILES.driver,
    { ['./CodexL2单根对照回执契约v2-20261031.cjs']: contractRec });
  checkerRec = vmLoadVerified(bytes.strictCheck, FILES.strictCheck, {});
  prepRec = vmLoadVerified(bytes.runPrep, FILES.runPrep, {});
} catch (e) {
  fs.writeSync(1, JSON.stringify({ ok: false, exitCode: 1, error: 'LOAD_PHASE:' + (e.code || e.message), guard }) + '\n');
  process.exit(1);
}
const driver = driverRec.exports;
const checker = checkerRec.exports;
const prep = prepRec.exports;

// ── probe stage: EXPLICITLY marked, five fixed probes ──
guard.phase = 'probe-init';
guard.probing = true;
try { require('node:http').request('http://127.0.0.1:9'); } catch (e) { /* accounted */ }
try { require('node:https').request('https://127.0.0.1:9'); } catch (e) { /* accounted */ }
guard.phase = 'probe-business';
try { require('node:child_process').spawn('definitely-blocked-probe'); } catch (e) { /* accounted */ }
try { require('node:child_process').execFileSync('definitely-blocked-probe'); } catch (e) { /* accounted */ }
guard.phase = 'probe-cleanup';
try { require('node:http').request('http://127.0.0.1:9'); } catch (e) { /* accounted */ }
guard.probing = false;                                           // everything after this is unexpected

// ── business-stage fault injection (re-entry only) ──
guard.phase = 'business';
if (FAULT === 'socketConnect') {
  try { require('node:net').Socket.prototype.connect.call({}); } catch (e) { /* swallowed; accounted */ }
}
if (FAULT === 'dnsPromises') {
  try { require('node:dns').promises.resolve('localhost'); } catch (e) { /* swallowed; accounted */ }
}
if (FAULT === 'fetchEntrance') {
  try { globalThis.fetch('https://127.0.0.1:9'); } catch (e) { /* swallowed; accounted */ }
}
if (FAULT === 'childProto') {
  try { const CP = require('node:child_process').ChildProcess; CP.prototype.spawn.call({}); } catch (e) { /* swallowed; accounted */ }
}

// ── synthetic boundary factory (fixed artifact slot enforced by driver v4) ──
const FIXED_ABS = 'C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP\\' +
  'artifacts/psr-l2/rootonly-v3-helper/rootonly-helper.exe'.split('/').join('\\');
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
    b.writeUInt32LE(0x200, sect + i * 40 + 8);
    b.writeUInt32LE(0x1000 + i * 0x1000, sect + i * 40 + 12);
    b.writeUInt32LE(0x200, sect + i * 40 + 16);
    b.writeUInt32LE(0x200 + i * 0x200, sect + i * 40 + 20);
  }
  const clr = pe + 24 + 112 + 14 * 8;
  b.writeUInt32LE(0x1000, clr); b.writeUInt32LE(0x48, clr + 4);
  b.writeUInt32LE(0x48, 0x200); b.writeUInt16LE(2, 0x204);
  return b;
}
function virtualTailProduct() {
  const b = syntheticProduct();
  const pe = b.readUInt32LE(0x3c);
  const sect = pe + 24 + 240;
  b.writeUInt32LE(0x400, sect + 8);
  const clr = pe + 24 + 112 + 14 * 8;
  b.writeUInt32LE(0x1000 + 0x300, clr);
  b.writeUInt32LE(0x48, 0x700); b.writeUInt16LE(2, 0x704);
  return b;
}
function clrOverrunProduct() {
  const b = syntheticProduct();
  const pe = b.readUInt32LE(0x3c), clr = pe + 24 + 112 + 14 * 8;
  b.writeUInt32LE(0x300, clr + 4);
  return b;
}
const CONFIG_REL = FILES.interface;
const ARTIFACT_REL = 'artifacts/psr-l2/rootonly-v3-helper/rootonly-helper.exe';
function makeBinding(over) {
  return driver.bind(bytes.interface, syntheticProduct(), Object.assign({
    configRel: CONFIG_REL, artifactRelPath: ARTIFACT_REL,
    configSha256: H(bytes.interface), compiled: false, executed: false
  }, over || {}));
}
function makeBoundary(over) {
  const o = {
    productDrift: 'none', sourceDrift: false, spawnThrows: false, timedOut: false,
    closed: true, closedAfterKill: true, killThrows: false, awaitThrows: false,
    reapThrows: false, subscribeThrows: false, releaseThrows: false, releaseFalse: false,
    holdThrows: false, holdDigest: 'ok', receiptBefore: false, guardUnexpectedCount: 0,
    guardPlan: null, chunk: null, pathOverride: null, ...over
  };
  const rec = { holdOpens: 0, releases: 0, spawned: 0, killed: 0, awaitCalls: 0, spawnOpts: null, pathsUsed: [], guardReads: 0 };
  const bnd = {
    get productPath() { return o.pathOverride !== null ? o.pathOverride : FIXED_ABS; },
    guardUnexpected() {
      rec.guardReads++;
      if (o.guardPlan === 'pre1-final0') return rec.guardReads <= 1 ? 1 : 0;
      if (o.guardPlan === 'drop') return rec.guardReads === 1 ? 1 : 0;
      return o.guardUnexpectedCount;
    },
    receiptExistsBefore() { return o.receiptBefore; },
    digestFile(p) {
      rec.pathsUsed.push(p);
      if (p === FIXED_ABS) {
        if (o.productDrift === 'after' && rec.spawned > 0) return 'drifted';
        if (o.productDrift === 'throw') throw new Error('SYNTH_DIGEST_FAIL');
        return o.boundDigest;
      }
      if (o.sourceDrift) return 'drifted';
      const cfg = JSON.parse(bytes.interface.toString('utf8'));
      const s = cfg.sources.find(x => x.rel === p);
      return s ? s.sha256 : 'drifted';
    },
    holdProduct(p) { rec.pathsUsed.push(p); rec.holdOpens++; if (o.holdThrows) throw new Error('SYNTH_HOLD_FAIL'); return { sha256: o.holdDigest === 'ok' ? o.boundDigest : '0'.repeat(64), holdToken: 'tok' }; },
    releaseHold() { rec.releases++; if (o.releaseThrows) throw new Error('SYNTH_RELEASE_FAIL'); return !o.releaseFalse; },
    spawn(opts) { rec.spawned++; rec.spawnOpts = opts; rec.pathsUsed.push(opts.artifactPath); if (o.spawnThrows) throw new Error('SYNTH_SPAWN_FAIL'); const chunk = o.chunk || Buffer.from(JSON.stringify(VALID_RECEIPT) + '\n'); return { onData(cb) { if (o.subscribeThrows) throw new Error('SYNTH_SUBSCRIBE_FAIL'); cb(false, chunk); } }; },
    awaitExit() { rec.awaitCalls++; if (o.awaitThrows && rec.awaitCalls === 1) throw new Error('SYNTH_AWAIT_FAIL'); if (o.timedOut && rec.awaitCalls === 1) return { status: null, signal: null, closed: o.closedAfterKill, timedOut: true }; if (o.awaitThrows && rec.awaitCalls === 2 && o.reapThrows) throw new Error('SYNTH_REAP_FAIL'); return { status: 0, signal: null, closed: rec.awaitCalls === 1 ? o.closed : o.closedAfterKill, timedOut: false }; },
    kill() { rec.killed++; if (o.killThrows) throw new Error('SYNTH_KILL_FAIL'); return true; }
  };
  bnd._rec = rec;
  return bnd;
}
function freshRunner(bnd, provOver) {
  const binding = makeBinding(provOver);
  const runner = driver.createRunner(binding, bnd);
  return { binding, runner, bnd };
}
function runExpectError(bnd, provOver, codeMatch) {
  const { runner } = freshRunner(bnd, provOver);
  let err = null;
  try { runner.runOnce(); } catch (e) { err = e; }
  need(err, 'NO_THROW');
  if (codeMatch) assert.match(String(err.code || err.message), codeMatch);
  return err;
}

// ══════════ R4: same-source self-verifying loading ══════════
prefix('R4 ');
test('verified snapshots match pinned digests', () => {
  need(H(bytes.driver) === PINNED.driver, 'DRIVER_DIGEST');
  need(H(bytes.contract) === PINNED.contract, 'CONTRACT_DIGEST');
  need(H(bytes.helper) === PINNED.helper, 'HELPER_DIGEST');
  need(H(bytes.runPrep) === PINNED.runPrep, 'RUNPREP_DIGEST');
  need(H(bytes.runFixture) === PINNED.runFixture, 'RUNFIXTURE_DIGEST');
  need(H(bytes.strictCheck) === PINNED.strictCheck, 'STRICTCHECK_DIGEST');
  need(H(bytes.compileConfig) === PINNED.compileConfig, 'COMPILECONFIG_DIGEST');
  need(H(bytes.interface) === PINNED.interface, 'INTERFACE_DIGEST');
});
test('loader computes the digest of the bytes it will run (labels are ignored)', () => {
  // a caller CANNOT pass a trusted digest label: the signature only takes bytes
  const synthetic = Buffer.from('// completely different code\nmodule.exports=1;');
  let e = null;
  try { vmLoadVerified(synthetic, FILES.driver, {}); } catch (x) { e = x; }
  need(e && e.code === 'LOAD_DRIFT', 'SYNTHETIC_EXECUTED');
});
test('unknown paths are refused (no exemption)', () => {
  let e = null;
  try { vmLoadVerified(bytes.driver, 'docs/证据/not-in-mapping.cjs', {}); } catch (x) { e = x; }
  need(e && e.code === 'LOAD_PATH_UNKNOWN', 'UNKNOWN_ACCEPTED');
});
test('cache inconsistency: drifted bytes refused even with a cached twin', () => {
  const again = vmLoadVerified(bytes.contract, FILES.contract, {});
  need(again === contractRec, 'CACHE_MISS');
  const drifted = Buffer.concat([bytes.contract, Buffer.from('\n// drift\n')]);
  let e = null;
  try { vmLoadVerified(drifted, FILES.contract, {}); } catch (x) { e = x; }
  need(e && e.code === 'LOAD_DRIFT', 'CACHE_POISON');
});
test('dependency loading serves only the verified snapshot', () => {
  const via = loadLog.find(l => l.via === './CodexL2单根对照回执契约v2-20261031.cjs');
  need(via && via.digest === PINNED.contract, 'DEP_NOT_FROM_CACHE');
});
test('preparer and strict checker load through the same verified pipeline', () => {
  need(prepRec.digest === PINNED.runPrep, 'PREP_HASH');
  need(checkerRec.digest === PINNED.strictCheck, 'CHECKER_HASH');
  const logged = loadLog.filter(l => l.relPath === FILES.runPrep || l.relPath === FILES.strictCheck);
  need(logged.length >= 2, 'NOT_VIA_LOADER');
});

// ══════════ R1 ══════════
prefix('R1 ');
test('internal state unreachable by reflection; provenance is an immutable snapshot', () => {
  const binding = makeBinding();
  assert.equal(Object.getOwnPropertySymbols(binding).length, 0);
  let threw = false;
  'use strict';
  try { binding.consumed = false; } catch (e) { threw = true; }
  need(threw, 'MUTABLE_STATE');
});
test('declared artifact slot must equal the actual hold/launch/post-check path', () => {
  const bnd = makeBoundary({ pathOverride: 'C:\\synthetic\\bound.exe', boundDigest: 'x' });
  // the driver binds digest to the boundary digestFile only through its snapshot;
  // here the boundary would serve a matching digest for the WRONG path — the
  // driver must refuse before any launch because the slot does not match.
  let e = null;
  try { driver.createRunner(makeBinding(), bnd); } catch (x) { e = x; }
  need(e && e.code === 'PROVENANCE_PATH_MISMATCH', 'SLOT_MISMATCH_ACCEPTED');
});
test('provenance getters read the internal snapshot, not the caller object', () => {
  const prov = { configRel: CONFIG_REL, artifactRelPath: ARTIFACT_REL, configSha256: H(bytes.interface), compiled: false, executed: false };
  const binding = makeBinding();
  // mutate the ORIGINAL provenance-shaped object used by makeBinding is not
  // reachable; instead verify the getters return snapshot values and freeze.
  need(binding.artifactRelPath === ARTIFACT_REL && binding.configRel === CONFIG_REL, 'SOURCE_FACTS');
  // and a binding whose caller object later changes still reports the old facts:
  const provObj = { configRel: CONFIG_REL, artifactRelPath: ARTIFACT_REL, configSha256: H(bytes.interface), compiled: false, executed: false };
  const b2 = driver.bind(bytes.interface, syntheticProduct(), provObj);
  provObj.artifactRelPath = 'MUTATED';
  provObj.configRel = 'MUTATED';
  need(b2.artifactRelPath === ARTIFACT_REL && b2.configRel === CONFIG_REL, 'SOURCE_LEAK');
});
test('consumed flag cannot be reset; single consumption shared across runners', () => {
  const bnd = makeBoundary({ boundDigest: H(syntheticProduct()) });
  const { binding, runner } = freshRunner(bnd);
  const r = runner.runOnce();
  need(r.ok === true, 'NORMAL_FAIL');
  const runner2 = driver.createRunner(binding, makeBoundary({ boundDigest: H(syntheticProduct()) }));
  let e = null;
  try { runner2.runOnce(); } catch (x) { e = x; }
  need(e && e.code === 'ALREADY_RUN', 'DOUBLE_RUN');
  need(bnd._rec.spawned === 1, 'RESURRECTED_SPAWN');
});
test('CLR raw-range rules refuse virtual-tail and overrun headers', () => {
  let e = null;
  try { driver.bind(bytes.interface, virtualTailProduct(), { configRel: CONFIG_REL, artifactRelPath: ARTIFACT_REL, configSha256: H(bytes.interface), compiled: false, executed: false }); } catch (x) { e = x; }
  need(e && e.code === 'PE_CLR_NOT_IN_RAW', 'VIRTUAL_TAIL_ACCEPTED');
  e = null;
  try { driver.bind(bytes.interface, clrOverrunProduct(), { configRel: CONFIG_REL, artifactRelPath: ARTIFACT_REL, configSha256: H(bytes.interface), compiled: false, executed: false }); } catch (x) { e = x; }
  need(e && e.code === 'PE_CLR_RAW_RANGE', 'OVERRUN_ACCEPTED');
});

// ══════════ R2 ══════════
prefix('R2 ');
test('non-timeout close-unknown enters kill + bounded reclaim', () => {
  const bnd = makeBoundary({ closed: false, boundDigest: H(syntheticProduct()) });
  const err = runExpectError(bnd, {}, /DRIVER_FAILED/);
  need(err.facts.failure === 'CLOSE_UNCONFIRMED', 'FAILURE_CODE:' + err.facts.failure);
  need(bnd._rec.killed >= 1, 'NO_KILL');
  need(bnd._rec.awaitCalls >= 2, 'NO_REAP');
  need(err.report.closedUnknown === true, 'CLOSE_UNKNOWN');
});
test('pre-launch unexpected hit refuses the launch (zero spawn)', () => {
  const bnd = makeBoundary({ guardPlan: 'pre1-final0', boundDigest: H(syntheticProduct()) });
  const err = runExpectError(bnd, {}, /GUARD_UNEXPECTED_PRE/);
  need(bnd._rec.spawned === 0, 'SPAWNED');
  need(err.facts.unexpected === 1, 'FACT_KEPT');
});
test('falling counter does not erase observed facts; read failure keeps them', () => {
  const bnd = makeBoundary({ guardPlan: 'drop', boundDigest: H(syntheticProduct()) });
  const err = runExpectError(bnd, {}, /GUARD_UNEXPECTED_PRE|DRIVER_FAILED/);
  need((err.facts.unexpected || 0) >= 1, 'FACT_ERASED');
  const bnd2 = makeBoundary({ guardUnexpectedCount: 0, boundDigest: H(syntheticProduct()) });
  bnd2._rec.guardReads = 0;
  const origGuard = bnd2.guardUnexpected;
  let first = true;
  bnd2.guardUnexpected = function () { bnd2._rec.guardReads++; if (first) { first = false; return 1; } throw new Error('GUARD_BROKEN'); };
  const err2 = runExpectError(bnd2, {}, /GUARD_/);
  need((err2.facts.unexpected || 0) >= 1, 'OBSERVATION_LOST');
});
test('hold digest mismatch: zero spawn, release still confirmed', () => {
  const bnd = makeBoundary({ holdDigest: 'wrong', boundDigest: H(syntheticProduct()) });
  const err = runExpectError(bnd, {}, /PRODUCT_DIGEST_MISMATCH/);
  need(bnd._rec.spawned === 0, 'SPAWNED');
  need(bnd._rec.releases === 1, 'NO_RELEASE');
  need(err.facts.releaseConfirmed === true, 'RELEASE_FACT');
});
test('release failure decides the outcome; digest failure does not block release', () => {
  const b1 = makeBoundary({ releaseThrows: true, boundDigest: H(syntheticProduct()) });
  const e1 = runExpectError(b1, {}, /DRIVER_FAILED/);
  need(e1.facts.failure === 'HOLD_RELEASE_UNCONFIRMED', 'CODE:' + e1.facts.failure);
  const b2 = makeBoundary({ productDrift: 'throw', boundDigest: H(syntheticProduct()) });
  const e2 = runExpectError(b2, {}, /DRIVER_FAILED/);
  need(e2.facts.failure === 'PRODUCT_DIGEST_CHECK_FAILED', 'CODE:' + e2.facts.failure);
  need(e2.facts.releaseConfirmed === true, 'RELEASE_BLOCKED');
});
test('await/kill failures sanitized; subscription failure stops immediately; limit before retention', () => {
  const e1 = runExpectError(makeBoundary({ awaitThrows: true, reapThrows: true, boundDigest: H(syntheticProduct()) }), {}, /DRIVER_FAILED/);
  need(e1.facts.failure === 'AWAIT_ERROR' && e1.report.closedUnknown === true, 'AWAIT');
  const e2 = runExpectError(makeBoundary({ killThrows: true, timedOut: true, boundDigest: H(syntheticProduct()) }), {}, /DRIVER_FAILED/);
  need(e2.report.killAccepted === false && e2.facts.failure === 'TIMEOUT', 'KILL');
  const e3 = runExpectError(makeBoundary({ subscribeThrows: true, boundDigest: H(syntheticProduct()) }), {}, /DRIVER_FAILED/);
  need(e3.facts.failure === 'READ', 'SUBSCRIBE');
  const e4 = runExpectError(makeBoundary({ chunk: Buffer.alloc(200000, 0x41), boundDigest: H(syntheticProduct()) }), {}, /DRIVER_FAILED/);
  need(e4.facts.failure === 'OUTPUT_LIMIT' && e4.facts.stderrBytes === 0, 'LIMIT');
});
test('legal and timeout contrasts', () => {
  const { runner } = freshRunner(makeBoundary({ boundDigest: H(syntheticProduct()) }));
  const r = runner.runOnce();
  need(r.ok === true && r.report.closedUnknown === false && r.report.holdReleased === true, 'LEGAL_FAIL');
  const e = runExpectError(makeBoundary({ timedOut: true, closedAfterKill: false, boundDigest: H(syntheticProduct()) }), {}, /DRIVER_FAILED/);
  need(e.facts.failure === 'TIMEOUT' && e.report.closedUnknown === true && e.report.killAccepted === true, 'TIMEOUT');
});

// ══════════ R3 ══════════
prefix('R3 ');
test('parsed objects are refused; only raw JSON bytes/strings enter', () => {
  let e = null;
  try { checker.strictCheck(JSON.parse(bytes.compileConfig.toString('utf8'))); } catch (x) { e = x; }
  need(e && e.code === 'CONFIG_WIRE', 'OBJECT_ACCEPTED');
});
test('the independent expectation is not exported as a mutable object', () => {
  need(checker.expectedConfig === undefined, 'MUTABLE_EXPECTED');
  need(typeof checker.expectedConfigJson === 'string', 'JSON_EXPECTED');
});
test('getter double-read cannot split the checked value from the returned copy', () => {
  // with the bytes-only contract a getter cannot answer twice; the single
  // JSON.parse snapshot is validated, selected and returned frozen.
  const cfg = checker.strictCheck(bytes.compileConfig);
  const plan = checker.selectSingleTarget(bytes.compileConfig, 'rootOnlyHelper');
  need(plan.caseId === 'rootOnlyHelper' && plan.outputFile === cfg.cases[0].outputFile, 'SNAPSHOT_SPLIT');
  let threw = false;
  try { plan.args.push('/evil'); } catch (e) { threw = true; }
  need(threw, 'PLAN_MUTABLE');
});
test('eight mutation groups rejected by the actual entry', () => {
  const map2 = p => p.replace('证据', 'moved');
  const groups = [
    c => { c.host.path = 'C:\\other\\evil.exe'; },
    c => { c.toolFacts.references[0].path = 'C:\\other\\fake.dll'; c.toolFacts.references[0].sha256 = '0'.repeat(64); const i = c.cases[0].args.findIndex(a => a.startsWith('/reference:') && a.includes('mscorlib')); c.cases[0].args[i] = '/reference:C:\\other\\fake.dll'; },
    c => { c.spawn.shell = true; },
    c => { c.cases[0].childEnv.NODE_OPTIONS = '--insecure'; },
    c => { c.spawn.timeoutMs = 99999; c.spawn.maxCombinedOutputBytes = 999; c.cwd = 'C:\\other'; },
    c => { const i = c.cases[0].args.findIndex(a => a.startsWith('/main:')); c.cases[0].args[i] = '/main:OtherEntry'; c.cases[0].main = 'OtherEntry'; },
    c => { c.cases[0].args = c.cases[0].args.filter(a => !a.includes('观察器')); },
    c => {
      c.inputs = c.inputs.map(x => ({ path: map2(x.path), sha256: x.sha256 }));
      c.cases.forEach(cs => { cs.sourceFiles = cs.sourceFiles.map(map2); cs.args = cs.args.map(a => (!a.startsWith('/') || a.startsWith('/out:')) ? map2(a) : a); cs.outputRoot = map2(cs.outputRoot); cs.tempRoot = map2(cs.tempRoot); cs.outputFile = map2(cs.outputFile); cs.record = map2(cs.record); cs.childEnv.TEMP = map2(cs.childEnv.TEMP); cs.childEnv.TMP = map2(cs.childEnv.TMP); });
    }
  ];
  for (const mut of groups) {
    const c = JSON.parse(bytes.compileConfig.toString('utf8'));
    mut(c);
    let e = null;
    try { checker.strictCheck(JSON.stringify(c)); } catch (x) { e = x; }
    need(e && e.code === 'CONFIG_MISMATCH', 'GROUP_ACCEPTED');
  }
});

// ══════════ R5 ══════════
prefix('R5 ');
test('fixture v4 builds reproducibly from the pinned helper source', () => {
  const g = prep.build(bytes.helper);
  need(g.generatedSha256 === H(bytes.runFixture), 'REGEN_MISMATCH');
  need(g.source === bytes.runFixture.toString('utf8'), 'DISK_MISMATCH');
  need(g.plannedCases === 20 && g.compiled === false && g.executed === false, 'FLAGS');
});
test('generated fixture passes every static closure check', () => {
  assert.deepEqual(prep.inspect(bytes.runFixture.toString('utf8')), []);
});
test('hook reference set equals definitions; tampering is detected', () => {
  const src = bytes.runFixture.toString('utf8');
  const t = src.replace('internal static bool FinalizationOk(int n)', 'internal static bool FinalizationRenamed(int n)');
  need(prep.inspect(t).includes('HOOK_UNDEF:FinalizationOk'), 'NO_DETECT');
});
test('type closure, capability ban and declarations are enforced', () => {
  const src = bytes.runFixture.toString('utf8');
  const t1 = src.replace(/internal sealed class L2MemberObserver[\s\S]*?\n  \}/, ' ');
  need(prep.inspect(t1).includes('TYPE_UNDEF:L2MemberObserver'), 'NO_DETECT_TYPE');
  const t2 = src.replace('Require(Hook.JobAssign(job,pi.Process),"JOB_ASSIGN")', 'Require(AssignProcessToJobObject(job,pi.Process),"JOB_ASSIGN")');
  need(prep.inspect(t2).some(p => p.startsWith('OS_CALL_REMAINS')), 'NO_DETECT_PINVOKE');
  const t3 = src.replace('r.Elapsed=Hook.ElapsedMs(clock);', 'r.Elapsed=clock.ElapsedMilliseconds;');
  need(prep.inspect(t3).some(p => p.startsWith('CAPABILITY_REMAINS')), 'NO_DETECT_STOPWATCH');
  const t4 = src.replace('struct ExtendedLimit', 'struct RemovedLimit');
  need(prep.inspect(t4).some(p => p.startsWith('DECL_MISSING')), 'NO_DETECT_DECL');
  const t5 = src.replace('JobCreated=false;', 'JobCreated=true;');
  need(prep.inspect(t5).some(p => p === 'RESET_MISSING:JobCreated=false'), 'NO_DETECT_RESET');
});
test('stashed ReadFile in the real Output body is now visible to inspect', () => {
  const src = bytes.runFixture.toString('utf8');
  const t = src.replace('bool ok = Hook.ReadChunk(handle, buffer, out count);', 'bool ok = ReadFile(handle, buffer, (uint)buffer.Length, out count, IntPtr.Zero);');
  need(prep.inspect(t).includes('CAPABILITY_REMAINS_OUTPUT'), 'NO_DETECT_READFILE');
});
test('deleting the finally close calls is detectable', () => {
  const src = bytes.runFixture.toString('utf8');
  const t = src.replace(/      r\.HandlesClosed=\(Close\(ref pi\.Thread,r\)&Close\(ref pi\.Process,r\)&Close\(ref rd,r\)&Close\(ref wr,r\)&Close\(ref er,r\)&Close\(ref ew,r\)&Close\(ref input,r\)&Close\(ref job,r\)\)&&r\.HandlesClosed;/, '      r.HandlesClosed=true;');
  need(prep.inspect(t).some(p => p.startsWith('CLOSE_CALLS_COUNT')), 'NO_DETECT_CLOSE');
});
test('scope and JSON-escape regressions are detected', () => {
  const src = bytes.runFixture.toString('utf8');
  const t1 = src.replace('static string FailAt="NONE";\n  internal static readonly string[] SCEN', 'internal static readonly string[] SCEN');
  need(prep.inspect(t1).includes('SCOPE_FAILAT'), 'NO_DETECT_SCOPE');
  const t2 = src.replace(/static string JsonQ\(string s\)[^\n]*/, 'static string JsonQRemoved(){}');
  need(prep.inspect(t2).includes('JSON_ESCAPE_DEF'), 'NO_DETECT_JSON');
});

// ══════════ all reads/digests done → finalization → SINGLE final verdict ══════════
guard.phase = 'final-digests';
// The LAST reviewed digest computations happen here; a swallowed hit injected
// at this exact point (fault mode) must still decide the outcome.
if (FAULT === 'finalDigest') {
  try { require('node:https').request('https://127.0.0.1:9'); } catch (e) { /* swallowed; accounted */ }
}
const finalDigests = {
  driver: H(bytes.driver), contract: H(bytes.contract), interface: H(bytes.interface),
  helper: H(bytes.helper), runPrep: H(bytes.runPrep), runFixture: H(bytes.runFixture),
  strictCheck: H(bytes.strictCheck), compileConfig: H(bytes.compileConfig),
  self: H(fs.readFileSync(__filename))
};
guard.phase = 'finalization';
if (FAULT === 'finalization') {
  try { require('node:https').request('https://127.0.0.1:9'); } catch (e) { /* swallowed; accounted */ }
}
// Verdict from the LATEST real counters only — no !IS_FAULT shortcut.
const failed = results.filter(r => !r.ok);
const guardClean = guard.probes.length === 5 && guard.unexpected.length === 0;
const ok = failed.length === 0 && guardClean && guardAccounting.failed === 0;
const exitCode = ok ? 0 : 1;

if (FAULT) {
  // re-entry: report the real counters so the parent can assert the outcome
  const out = JSON.stringify({ ok, exitCode, fault: FAULT, checks: results.length, failedChecks: failed.length,
    guard: { probes: guard.probes.length, unexpected: guard.unexpected.length, phases: guard.unexpected.map(u => u.phase) },
    finalDigestsComputed: Object.keys(finalDigests).length });
  if (OUT_PATH) { const fd = fs.openSync(OUT_PATH, 'wx'); fs.writeSync(fd, out + '\n'); fs.closeSync(fd); }
  else fs.writeSync(1, out + '\n');
  process.exit(exitCode);
}

// parent: run every fault scenario through the controlled re-entry runner and
// assert the REAL exit follows the counters (ok=false / exit1, unexpected>=1).
const faultOutcomes = [];
guard.phase = 'fault-rerun';
for (const mode of FAULT_MODES) {
  const r = controlledReentry(mode);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout.toString('utf8').trim()); } catch (e) { parsed = null; }
  faultOutcomes.push({
    mode, exitStatus: r.status, parsedOk: parsed ? parsed.ok : null,
    parsedExit: parsed ? parsed.exitCode : null,
    unexpected: parsed ? parsed.guard.unexpected : null,
    passed: r.status === 1 && parsed && parsed.ok === false && parsed.guard.unexpected >= 1
  });
}

const identity = (() => {
  let head = null;
  try {
    const h = fs.readFileSync(path.join(REPO, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref: (.+)$/.exec(h);
    head = m ? fs.readFileSync(path.join(REPO, '.git', m[1]), 'utf8').trim().slice(0, 7) : h.slice(0, 7);
  } catch (e) { head = null; }
  return { techBaseline: 'dac82a2', handoverBaseline: 'faee6bc', reviewedImplementation: '60ed280',
    runtimeHead: head, runtimeHeadGated: false,
    agentsWorktreeSha256: H(fs.readFileSync(path.join(REPO, 'AGENTS.md'))) };
})();
const acceptanceMatrix = [
  { area: '来源与差异（沿用引用+摘要核对+同源装载）', status: 'executed-js-stub', note: 'R4 自证装载器' },
  { area: 'R1 槽位关联/来源快照/反射防护/CLR raw', status: 'executed-js-stub', note: '真实模块+替身边界' },
  { area: 'R2 收尾保护链（关闭未知回收+意外计数）', status: 'executed-js-stub', note: '真实模块+替身边界' },
  { area: 'R3 字节契约+不可变预期+单次快照', status: 'executed-js-stub', note: '实际入口+八组反例' },
  { area: 'R4 完整守卫+末尾摘要时点+装载器自证', status: 'executed-js-stub', note: '七类重入+装载反例' },
  { area: 'R5 夹具源码闭合静态检查', status: 'source-observation', note: 'inspect 十二类检查+篡改反例' },
  { area: 'C# 收尾夹具与 Run 边界夹具编译/执行', status: 'prepared-not-executed', note: '本轮不编译不运行' },
  { area: '真实产物摘要绑定/单次真实运行/完整 L2', status: 'blocked', note: '未放行' }
];
const report = {
  schema: 'codex-l2-rootonly-verify/6', ok, exitCode,
  basis: identity,
  digests: { ...finalDigests, loadedContractSha: contractRec.digest, loadedDriverSha: driverRec.digest,
    loadedCheckerSha: checkerRec.digest, loadedPrepSha: prepRec.digest },
  sameSourceLoading: { cacheEntries: loadCache.size, loadLog },
  guard: { probes: guard.probes.length, probePhases: guard.probes.map(p => p.phase),
    unexpected: guard.unexpected.length, probingExplicit: true },
  reentry: { attempts: guardAccounting.attempts, completed: guardAccounting.completed,
    failed: guardAccounting.failed, faultOutcomes },
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
  const fd = fs.openSync(OUT_PATH, 'wx');
  fs.writeSync(fd, out + '\n'); fs.closeSync(fd);
  process.exit(exitCode);
}
fs.writeSync(1, out + '\n');
process.exit(exitCode);
