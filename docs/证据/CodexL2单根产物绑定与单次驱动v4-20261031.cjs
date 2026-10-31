'use strict';
// L2 root-only artifact binding + private single-run driver v3 (R1/R2 closure).
// Internal state lives in a module-private WeakMap: the returned binding exposes
// no Symbol and no mutable property, so the consumed flag cannot be read or
// reset through reflection. Every external input is snapshotted once at
// createRunner time; hold, launch and post-run checks consume that SAME object.
// The launch capability options (shell/env/stdio/limits) are constructed
// internally, never taken from caller objects. Cleanup runs in one finally with
// independent per-item release: an unconfirmed release or a failed digest
// re-check decides the overall failure. No child_process/net/http/tls/dgram/dns
// imports; every OS capability arrives through the explicit boundary argument.
// Prepared-until-compile provenance: bind() requires a provenance record that
// matches the pinned fixed paths; this is interface preparation only — no
// compile or run approval exists or is implied.
const contract = require('./CodexL2单根对照回执契约v2-20261031.cjs');
const crypto = require('node:crypto');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
function need(v, code) { if (!v) throw Object.assign(Error(code), { code }); }
function freeze(v) { if (v && typeof v === 'object' && !Buffer.isBuffer(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
// Module-private state: unreachable from the returned binding object by any
// reflection (Object.getOwnPropertySymbols/values/entries all miss WeakMap).
const INTERNALS = new WeakMap();
const TAG = 'codex-l2-rootonly-binding/3';
// Pinned provenance constants (prepared-until-compile; no execution approval).
// configRel/configSha256 tie the binding to the reviewed fixed-interface config
// actually validated below; artifactRelPath is the fixed output path declared by
// the reviewed compile config and FIXED_ARTIFACT_ABS is the corresponding fixed
// repository-root path — the ACTUAL hold/launch/post-check path must equal it.
const FIXED_CONFIG_REL = 'docs/证据/CodexL2单根对照固定接口v2-20261031.json';
const FIXED_ARTIFACT_REL = 'artifacts/psr-l2/rootonly-v3-helper/rootonly-helper.exe';
const FIXED_REPO_ROOT = 'C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const FIXED_ARTIFACT_ABS = FIXED_REPO_ROOT + '\\' + FIXED_ARTIFACT_REL.split('/').join('\\');

// Substantive PE/CLR static inspection. The CLR directory RVA must map INSIDE
// the section's raw file range: a virtual-tail RVA with the header bytes
// stashed elsewhere in the file is rejected (PE_CLR_NOT_IN_RAW / PE_CLR_RAW_RANGE).
function inspectProduct(b) {
  need(Buffer.isBuffer(b) && b.length > 0 && b.length <= 1048576, 'PRODUCT_WIRE');
  need(b.length >= 64 && b.toString('latin1', 0, 2) === 'MZ', 'PE_MAGIC');
  const pe = b.readUInt32LE(0x3c);
  need(pe > 0 && pe + 24 + 240 <= b.length && b.toString('latin1', pe, pe + 4) === 'PE\0\0', 'PE_SIG');
  const machine = b.readUInt16LE(pe + 4);
  need(machine === 0x8664, 'PE_MACHINE');                       // AMD64 only
  const opt = pe + 24, magic = b.readUInt16LE(opt);
  need(magic === 0x20b, 'PE_OPTIONAL');                         // PE32+ only
  const sizeOfOpt = b.readUInt16LE(pe + 20);
  need(sizeOfOpt >= 112 + 16 * 8, 'PE_HEADERS');
  const sections = b.readUInt16LE(pe + 6);
  need(sections > 0 && sections <= 96, 'PE_SECTIONS');
  const sizeOfHeaders = b.readUInt32LE(opt + 60);
  const sizeOfImage = b.readUInt32LE(opt + 56);
  need(sizeOfHeaders > 0 && sizeOfHeaders <= b.length && sizeOfImage >= sizeOfHeaders && sizeOfImage <= 1048576, 'PE_IMAGE');
  const clrDirRva = b.readUInt32LE(opt + 112 + 14 * 8), clrDirSize = b.readUInt32LE(opt + 112 + 14 * 8 + 4);
  need(clrDirRva !== 0 && clrDirSize >= 0x48, 'PE_CLR');        // CLR directory present with real length
  const sect = opt + sizeOfOpt;
  need(sect + sections * 40 <= b.length, 'PE_SECTIONS');
  let clrFileOff = -1;
  for (let i = 0; i < sections; i++) {
    const s = sect + i * 40, vsize = b.readUInt32LE(s + 8), vaddr = b.readUInt32LE(s + 12);
    const rsize = b.readUInt32LE(s + 16), rraw = b.readUInt32LE(s + 20);
    need(rraw + rsize <= b.length, 'PE_SECTION_MAP');           // raw section inside file
    if (clrFileOff < 0 && clrDirRva >= vaddr && clrDirRva < vaddr + vsize) {
      const inSec = clrDirRva - vaddr;
      need(inSec < rsize, 'PE_CLR_NOT_IN_RAW');                 // inside the section's RAW range, not the virtual tail
      need(inSec + clrDirSize <= rsize, 'PE_CLR_RAW_RANGE');    // whole CLR header inside the raw bytes
      clrFileOff = rraw + inSec;
    }
  }
  need(clrFileOff > 0 && clrFileOff + 0x48 <= b.length, 'PE_CLR_MAP');
  const cb = b.readUInt32LE(clrFileOff);
  const major = b.readUInt16LE(clrFileOff + 4);
  need(cb >= 0x48 && major >= 2, 'PE_CLR_HEADER');              // COR20 header length/runtime version
  return Object.freeze({
    size: b.length, machine: 'AMD64', magic: 'PE32+',
    sections, sizeOfImage, clrDirectoryRva: clrDirRva, clrDirectorySize: clrDirSize,
    clrHeaderCb: cb, clrRuntimeMajor: major, clrHeaderPresent: true
  });
}

// Bind the validated fixed configuration to one concrete product image with a
// reviewed provenance record. The record ties this binding to the pinned
// compile-config file and the fixed artifact output path from that config; a
// self-reported digest for arbitrary bytes without that record is not a
// reviewed source. The bytes are copied internally; the state object is only
// reachable through the module-private WeakMap.
function bind(configRaw, productBytes, provenance) {
  need(provenance && typeof provenance === 'object', 'PROVENANCE_REQUIRED');
  need(provenance.configRel === FIXED_CONFIG_REL, 'PROVENANCE_CONFIG_PATH');
  need(provenance.artifactRelPath === FIXED_ARTIFACT_REL, 'PROVENANCE_ARTIFACT_PATH');
  need(provenance.configSha256 === H(configRaw), 'PROVENANCE_CONFIG_DIGEST');
  need(provenance.compiled === false && provenance.executed === false, 'PROVENANCE_STATE');
  const config = contract.validateConfig(configRaw);
  need(config.mode === 'rootOnly' && config.executionReady === false && config.artifactBound === false, 'CONFIG_STATE');
  need(Buffer.isBuffer(productBytes) && productBytes.length > 0, 'PRODUCT_WIRE');
  const statics = inspectProduct(productBytes);
  const bytes = Buffer.from(productBytes);                       // internal copy
  const digest = H(bytes);
  // Provenance fields are copied into ordinary immutable values at bind time:
  // the binding's getters never read the caller's provenance object again, so
  // mutating that object afterwards cannot change the public source facts.
  const provenanceSnapshot = Object.freeze({
    configRel: String(provenance.configRel),
    artifactRelPath: String(provenance.artifactRelPath),
    configSha256: String(provenance.configSha256),
    compiled: false, executed: false
  });
  const internal = {
    tag: TAG, consumed: false, digest, config, bytes, statics, snapshot: null, provenanceSnapshot
  };
  const binding = Object.freeze({
    config,
    get artifactSha256() { return digest; },
    get statics() { return statics; },
    get artifactRelPath() { return internal.provenanceSnapshot.artifactRelPath; },
    get configRel() { return internal.provenanceSnapshot.configRel; },
    get artifactBound() { return true; },
    get executionApproved() { return false; },
    get bytes() { return Buffer.from(bytes); }                   // copy leaves the module
  });
  INTERNALS.set(binding, internal);
  return binding;
}

// Child environment constructed internally: fixed entries only, NODE_OPTIONS removed.
function childEnv() {
  const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' };
  return Object.freeze(env);
}

// Private single-run driver. boundary must provide (all synthetic this round):
//   productPath, guardUnexpected(), receiptExistsBefore(), digestFile(relOrPath),
//   holdProduct(path)->{sha256, holdToken}, releaseHold(token)->truthy on confirmed release,
//   spawn(opts)->child{onData(cb), }, awaitExit(child,deadline)->{status,signal,closed,timedOut},
//   kill(child)->bool
function createRunner(binding, boundary) {
  const internal = INTERNALS.get(binding);
  need(internal && internal.tag === TAG && typeof internal.consumed === 'boolean', 'FAKE_BINDING');
  const productPath = boundary.productPath;                      // read exactly ONCE, then validated
  need(boundary && typeof boundary === 'object' &&
    typeof productPath === 'string' && productPath.length > 0 &&
    typeof boundary.spawn === 'function' && typeof boundary.awaitExit === 'function' &&
    typeof boundary.kill === 'function' && typeof boundary.digestFile === 'function' &&
    typeof boundary.holdProduct === 'function' && typeof boundary.releaseHold === 'function' &&
    typeof boundary.receiptExistsBefore === 'function' && typeof boundary.guardUnexpected === 'function', 'BOUNDARY_REQUIRED');
  // One-time controlled snapshot of every external input consumed later. The
  // boundary product path is read exactly ONCE, validated against the pinned
  // fixed artifact slot, and then frozen: a declared provenance slot that does
  // not match the actual hold/launch path is refused BEFORE any launch.
  need(productPath === FIXED_ARTIFACT_ABS,
    'PROVENANCE_PATH_MISMATCH');                                 // declared slot vs actual path
  const snapshot = Object.freeze({
    productPath,
    cwd: internal.config.cwd,
    args: Object.freeze([...internal.config.helperArgs]),
    timeoutMs: internal.config.driverTimeoutMs,
    outputLimitBytes: internal.config.outputLimitBytes,
    cleanupBudgetMs: internal.config.cleanupBudgetMs || 2000,
    sources: Object.freeze(internal.config.sources.map(s => Object.freeze({ rel: s.rel, sha256: s.sha256 }))),
    env: childEnv()
  });
  internal.snapshot = snapshot;
  return Object.freeze({
    get artifactSha256() { return binding.artifactSha256; },
    get productPath() { return snapshot.productPath; },
    get consumed() { return internal.consumed; },
    runOnce() { return runOnce(internal, boundary, snapshot); }
  });
}

// Private single-run execution. Structure (R2):
//   1. pre-launch refusals (zero-launch rule), each sanitized;
//   2. hold acquired BEFORE the protective block — from that point every
//      acquired resource is released in one finally with INDEPENDENT per-item
//      try/catch, so no failure short-circuits a later release;
//   3. release contract is fixed (must return true); unconfirmed release,
//      product drift or source drift after the run decide the overall failure;
//   4. wait/kill/reap/digest/guard exceptions are sanitized into facts with
//      the first failure and the real close-unknown state preserved;
//   5. stdout chunks are limit-checked BEFORE retention (no unbounded concat).
function runOnce(internal, boundary, snap) {
  // Single consumption per binding: shared across runners, set before any check.
  need(internal.consumed === false, 'ALREADY_RUN');
  internal.consumed = true;
  const f = {
    attempts: 0, unexpected: null, closed: false, status: 0, signal: null,
    failure: null, killRequested: false, killAccepted: null, stderrBytes: 0,
    receiptExistsBefore: null, sourcesBefore: null, sourcesAfter: null,
    holdAcquired: false, holdDigestChecked: false, releaseConfirmed: false,
    closedUnknown: false, timedOut: false, productUnchanged: null
  };
  let hold = null, child = null, killAccepted = null;
  let timedOut = false, closedUnknown = false, stopReading = false;
  const stdoutParts = [];
  let stdoutBytes = 0;
  const firstFail = code => { if (f.failure === null) f.failure = code; };
  const refuse = code => {
    // pre-launch refusals still carry the sanitized facts collected so far
    throw Object.assign(Error(code), { code,
      facts: Object.freeze({ ...f }),
      report: Object.freeze({ killAccepted: null, closedUnknown: false, holdReleased: false, timedOut: false }) });
  };
  const guardedKill = () => {
    if (!child || f.killRequested) return;
    f.killRequested = true;
    try { killAccepted = boundary.kill(child) === true; } catch (e) { killAccepted = false; }
    f.killAccepted = killAccepted;
  };
  const boundedReap = () => {
    // bounded reclaim after kill; close state may remain unknown — never claimed
    try {
      const r = boundary.awaitExit(child, snap.cleanupBudgetMs);
      f.closed = r && r.closed === true;
      if (!f.closed) closedUnknown = true;
    } catch (e) { f.closed = false; closedUnknown = true; }
  };
  // -- pre-launch refusals, each sanitized, all before any spawn attempt --
  let guardInitial = null;
  try {
    guardInitial = boundary.guardUnexpected();
    f.unexpected = typeof guardInitial === 'number' ? guardInitial : null;
  } catch (e) { firstFail('GUARD_READ_FAILED'); }
  // An unexpected hit observed BEFORE launch refuses the launch outright.
  if (f.failure === null && (f.unexpected || 0) !== 0) refuse('GUARD_UNEXPECTED_PRE');
  try { f.receiptExistsBefore = boundary.receiptExistsBefore() === true; } catch (e) { firstFail('RECEIPT_CHECK_FAILED'); }
  if (f.failure === null && f.receiptExistsBefore !== false) refuse(f.failure || 'RECEIPT_EXISTS');
  try { f.sourcesBefore = snap.sources.every(s => boundary.digestFile(s.rel) === s.sha256); }
  catch (e) { firstFail('SOURCES_CHECK_FAILED'); }
  if (f.failure === null && f.sourcesBefore !== true) refuse(f.failure || 'SOURCES_DRIFTED');
  try { hold = boundary.holdProduct(snap.productPath); } catch (e) { firstFail('HOLD_FAILED'); }
  if (f.failure === null && !(hold && typeof hold.holdToken !== 'undefined' && hold.holdToken !== null)) refuse(f.failure || 'HOLD_FAILED');
  if (hold !== null) f.holdAcquired = true;
  // -- protective block: hold digest check, launch, observation --
  let innerError = null, assessed = null;
  try {
    if (f.failure === null) {
      need(hold.sha256 === internal.digest, 'PRODUCT_DIGEST_MISMATCH');
      f.holdDigestChecked = true;
      // launch with internally fixed capability options (never caller-supplied)
      try {
        child = boundary.spawn({
          cwd: snap.cwd, artifactPath: snap.productPath, args: [...snap.args],
          shell: false, windowsHide: true, env: { ...snap.env },
          timeoutMs: snap.timeoutMs, outputLimitBytes: snap.outputLimitBytes,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        f.attempts = 1;
        try {
          child.onData((isErr, buf) => {
            try {
              if (stopReading || f.failure !== null) return;
              if (!Buffer.isBuffer(buf)) { firstFail('READ'); }
              else if (isErr) {
                f.stderrBytes += buf.length;
                if (f.stderrBytes > 0) firstFail('STDERR');
              } else if (stdoutBytes + buf.length + f.stderrBytes > snap.outputLimitBytes) {
                firstFail('OUTPUT_LIMIT');                       // limit check BEFORE retention
              } else { stdoutParts.push(buf); stdoutBytes += buf.length; }
              if (f.failure !== null) { guardedKill(); stopReading = true; }
            } catch (e) { firstFail('READ'); stopReading = true; guardedKill(); }
          });
        } catch (e) {
          firstFail('READ');                                     // subscription failed: fail fast below
        }
      } catch (e) {
        f.attempts = 1;                                          // the launch attempt happened and failed
        firstFail('SPAWN_FAILED'); closedUnknown = true;         // close state unknowable, never claimed
      }
      if (child !== null && f.failure === null) {
        // normal wait path only when the read side established cleanly
        try {
          const w = boundary.awaitExit(child, snap.timeoutMs);
          if (w && w.timedOut) {
            timedOut = true; f.timedOut = true; firstFail('TIMEOUT');
            guardedKill(); boundedReap();
          } else {
            f.status = w ? w.status : 0; f.signal = w ? w.signal : null;
            f.closed = !!(w && w.closed === true);
            if (!f.closed) {
              // Close-unknown on the normal wait is a failure just like any
              // other: terminate and reclaim within the bounded budget, keep
              // the first failure and the real close-unknown fact.
              closedUnknown = true; firstFail('CLOSE_UNCONFIRMED');
              guardedKill(); boundedReap();
            }
          }
        } catch (e) {
          firstFail('AWAIT_ERROR'); closedUnknown = true;
          guardedKill(); boundedReap();
        }
      } else if (child !== null) {
        // read-side failure: immediate failure reclamation, NOT the normal wait
        guardedKill(); boundedReap();
      }
    }
  } catch (e) { innerError = e; }
  finally {
    // independent per-item release; earlier failures never short-circuit later ones
    try {
      f.sourcesAfter = f.sourcesBefore === true
        ? snap.sources.every(s => boundary.digestFile(s.rel) === s.sha256) : null;
    } catch (e) { f.sourcesAfter = false; firstFail('SOURCES_CHECK_FAILED_AFTER'); }
    let digestAfter = null;
    try { digestAfter = boundary.digestFile(snap.productPath); }
    catch (e) { digestAfter = null; firstFail('PRODUCT_DIGEST_CHECK_FAILED'); }
    f.productUnchanged = digestAfter === null ? null : digestAfter === internal.digest;
    if (hold !== null) {
      let rel = false;
      try { rel = boundary.releaseHold(hold.holdToken) === true; } catch (e) { rel = false; }
      f.releaseConfirmed = rel;
      if (!rel) firstFail('HOLD_RELEASE_UNCONFIRMED');           // unconfirmed release decides failure
    }
    let g1 = null;
    try { g1 = boundary.guardUnexpected(); } catch (e) { firstFail('GUARD_READ_FAILED'); }
    if (typeof g1 === 'number') {
      // A falling counter must not erase an already-observed unexpected hit.
      if (guardInitial !== null && g1 < guardInitial) firstFail('GUARD_COUNT_DROPPED');
      f.unexpected = Math.max(typeof guardInitial === 'number' ? guardInitial : 0, g1);
    } else if (typeof guardInitial === 'number') {
      f.unexpected = guardInitial;                                 // read failure keeps the first observation
    }
  }
  if (f.productUnchanged === false) firstFail('PRODUCT_CHANGED');
  if (f.sourcesBefore === true && f.sourcesAfter !== true) firstFail('SOURCES_DRIFTED_AFTER');
  // Receipt assessment happens AFTER all cleanup, with the FINAL facts: the
  // public projection (11 reviewed fields) is built from post-cleanup reality.
  let assessError = null;
  if (f.failure === null && f.closed === true && (f.unexpected || 0) === 0 &&
      f.releaseConfirmed === true && f.productUnchanged === true && f.sourcesAfter === true) {
    const projected = {
      attempts: f.attempts, unexpected: f.unexpected, closed: f.closed, status: f.status,
      signal: f.signal, failure: f.failure, killRequested: f.killRequested, stderrBytes: f.stderrBytes,
      receiptExistsBefore: f.receiptExistsBefore, sourcesBefore: f.sourcesBefore, sourcesAfter: f.sourcesAfter
    };
    try { assessed = contract.assess(Buffer.concat(stdoutParts), f.status, Buffer.from(JSON.stringify(projected))); }
    catch (e) { assessError = e; }
  }
  const report = Object.freeze({
    killAccepted: f.killAccepted, closedUnknown, holdReleased: f.releaseConfirmed, timedOut
  });
  // -- final decision from the latest real counters --
  if (f.failure !== null || (f.unexpected || 0) > 0 || f.closed === false ||
      !f.releaseConfirmed || f.productUnchanged !== true || !assessed) {
    if (innerError && innerError.code && innerError.code !== 'DRIVER_FAILED' && !innerError.facts) {
      // domain refusal (e.g. receipt schema): attach sanitized facts and rethrow
      innerError.facts = Object.freeze({ ...f });
      innerError.report = report;
      throw innerError;
    }
    const e = Object.assign(Error('DRIVER_FAILED'), { code: 'DRIVER_FAILED' });
    e.facts = Object.freeze({ ...f });
    e.report = report;
    throw e;
  }
  if (innerError) {                                              // domain refusal from the protected block
    if (!innerError.facts) innerError.facts = Object.freeze({ ...f });
    if (!innerError.report) innerError.report = report;
    throw innerError;
  }
  if (assessError) {                                             // receipt-schema refusal with final facts
    if (!assessError.facts) assessError.facts = Object.freeze({ ...f });
    if (!assessError.report) assessError.report = report;
    throw assessError;
  }
  return freeze({
    ok: assessed.ok === true,
    assessment: assessed,
    facts: Object.freeze({ ...f }),
    report,
    artifactSha256: internal.digest,
    productPath: snap.productPath,
    executionApproved: false, realInputApproved: false, l2Approved: false
  });
}

module.exports = Object.freeze({ inspectProduct, bind, createRunner });
