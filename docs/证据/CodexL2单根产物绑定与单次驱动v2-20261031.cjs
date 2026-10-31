'use strict';
// L2 root-only artifact binding + private single-run driver v2 (R1/R2 rework).
// Same controlled chain: config -> sources -> artifact digest -> hold/re-check ->
// spawn -> bounded observation -> receipt from THIS run's collected output.
// No child_process/net/http/tls/dgram/dns imports; every OS capability arrives
// through the explicit boundary argument. Forged bindings are refused.
const contract = require('./CodexL2单根对照回执契约v2-20261031.cjs');
const crypto = require('node:crypto');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
function need(v, code) { if (!v) throw Object.assign(Error(code), { code }); }
function freeze(v) { if (v && typeof v === 'object' && !Buffer.isBuffer(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
const BRAND = Symbol('codex-l2-rootonly-binding');   // not exported: cannot be forged

// Substantive PE/CLR static inspection: section table mapping, not just flags.
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
    if (clrFileOff < 0 && clrDirRva >= vaddr && clrDirRva < vaddr + Math.max(vsize, rsize)) {
      clrFileOff = clrDirRva - vaddr + rraw;                    // RVA mapped through this section
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

// Bind the validated fixed configuration to one concrete product image.
// The bytes are copied internally: caller-side mutation cannot diverge the
// stored digest from the launched content; the brand symbol is not exported.
function bind(configRaw, productBytes) {
  const config = contract.validateConfig(configRaw);
  need(config.mode === 'rootOnly' && config.executionReady === false && config.artifactBound === false, 'CONFIG_STATE');
  need(Buffer.isBuffer(productBytes) && productBytes.length > 0, 'PRODUCT_WIRE');
  const statics = inspectProduct(productBytes);
  const bytes = Buffer.from(productBytes);                       // internal copy
  const digest = H(bytes);
  const internal = { consumed: false, tag: 'codex-l2-rootonly-binding/2', digest };
  const binding = {
    config,
    get artifactSha256() { return digest; },
    get statics() { return statics; },
    get artifactBound() { return true; },
    get executionApproved() { return false; },
    get bytes() { return Buffer.from(bytes); },                  // copy leaves the module
    [BRAND]: internal
  };
  return Object.freeze(binding);
}

function assertGenuine(binding) {
  const it = binding ? binding[BRAND] : null;
  need(it && it.tag === 'codex-l2-rootonly-binding/2' && typeof it.consumed === 'boolean' && typeof it.digest === 'string', 'FAKE_BINDING');
  return it;
}

// Private single-run driver. boundary must provide (all synthetic this round):
//   productPath, guardUnexpected(), receiptExistsBefore(), digestFile(relOrPath),
//   holdProduct(path)->{sha256, holdToken}, releaseHold(token),
//   spawn(opts)->child{onData(cb), }, awaitExit(child,deadline)->{status,signal,closed,timedOut},
//   kill(child)->bool
function createRunner(binding, boundary) {
  const internal = assertGenuine(binding);
  need(boundary && typeof boundary === 'object' &&
    typeof boundary.productPath === 'string' && boundary.productPath.length > 0 &&
    typeof boundary.spawn === 'function' && typeof boundary.awaitExit === 'function' &&
    typeof boundary.kill === 'function' && typeof boundary.digestFile === 'function' &&
    typeof boundary.holdProduct === 'function' && typeof boundary.releaseHold === 'function' &&
    typeof boundary.receiptExistsBefore === 'function' && typeof boundary.guardUnexpected === 'function', 'BOUNDARY_REQUIRED');
  const cfg = binding.config;
  return Object.freeze({
    get artifactSha256() { return binding.artifactSha256; },
    get consumed() { return internal.consumed; },
    runOnce() {
      // Pre-launch refusals happen BEFORE any spawn attempt (zero-launch rule).
      need(!internal.consumed, 'ALREADY_RUN');                    // single consumption per binding, shared across runners
      internal.consumed = true;
      const receiptExistedBefore = boundary.receiptExistsBefore() === true;
      need(!receiptExistedBefore, 'RECEIPT_EXISTS');
      const sourcesBefore = cfg.sources.every(s => boundary.digestFile(s.rel) === s.sha256);
      need(sourcesBefore, 'SOURCES_DRIFTED');
      // Hold + digest re-check of the ACTUAL launch file against the bound digest.
      const hold = boundary.holdProduct(boundary.productPath);
      need(hold && hold.holdToken && hold.sha256 === binding.artifactSha256, 'PRODUCT_DIGEST_MISMATCH');
      let child = null, timedOut = false, killAccepted = null, closedUnknown = false;
      let holdReleased = false, stopReading = false, stdout = Buffer.alloc(0), stderrBytes = 0, productUnchanged = false;
      const facts = {
        attempts: 0, unexpected: boundary.guardUnexpected(), closed: false, status: 0, signal: null,
        failure: null, killRequested: false, stderrBytes: 0,
        receiptExistsBefore: receiptExistedBefore, sourcesBefore, sourcesAfter: false
      };
      try {
        try {
          child = boundary.spawn({
            cwd: cfg.cwd, artifactPath: boundary.productPath, args: cfg.helperArgs,
            timeoutMs: cfg.driverTimeoutMs, outputLimitBytes: cfg.outputLimitBytes
          });
          facts.attempts = 1;                                     // one real launch attempt was made
          try {
            child.onData((isErr, buf) => {
              try {
                if (stopReading) return;
                if (isErr) { facts.stderrBytes += buf.length; if (facts.stderrBytes > 0) facts.failure = facts.failure || 'STDERR'; }
                else stdout = Buffer.concat([stdout, buf]);
                if (stdout.length + facts.stderrBytes > cfg.outputLimitBytes) { facts.failure = facts.failure || 'OUTPUT_LIMIT'; stopReading = true; }
                if (facts.failure) { facts.killRequested = true; killAccepted = boundary.kill(child) === true; stopReading = true; }
              } catch (e) { facts.failure = facts.failure || 'READ'; stopReading = true; }
            });
          } catch (e) {
            facts.failure = facts.failure || 'READ'; stopReading = true;  // subscription failure is a read-side failure
          }
        } catch (e) {
          facts.attempts = 1;                                     // the launch attempt itself happened and failed
          facts.failure = 'SPAWN_FAILED'; closedUnknown = true;   // close state is unknowable, never claimed
        }
        if (child) {
          try {
            const w = boundary.awaitExit(child, cfg.driverTimeoutMs);
            if (w.timedOut) {
              timedOut = true; facts.failure = facts.failure || 'TIMEOUT';
              facts.killRequested = true; killAccepted = boundary.kill(child) === true;
              const reaped = boundary.awaitExit(child, cfg.cleanupBudgetMs || 2000);
              facts.closed = reaped.closed === true;              // bounded reclaim after kill
              if (!facts.closed) closedUnknown = true;
            } else {
              facts.status = w.status; facts.signal = w.signal; facts.closed = w.closed === true;
              if (!facts.closed && !facts.failure) facts.failure = 'CLOSE_UNCONFIRMED';
            }
          } catch (e) {
            facts.failure = facts.failure || 'AWAIT_ERROR'; closedUnknown = true;
            facts.killRequested = true; killAccepted = boundary.kill(child) === true;
            const reaped = boundary.awaitExit(child, cfg.cleanupBudgetMs || 2000);
            facts.closed = reaped.closed === true;
          }
        }
      } finally {
        // Unified cleanup: sources re-check and product digest after this run.
        facts.sourcesAfter = sourcesBefore ? cfg.sources.every(s => boundary.digestFile(s.rel) === s.sha256) : false;
        const digestAfter = boundary.digestFile(boundary.productPath);
        productUnchanged = digestAfter === binding.artifactSha256;
        if (hold) { try { boundary.releaseHold(hold.holdToken); holdReleased = true; } catch (e) { holdReleased = false; } }
        facts.unexpected = boundary.guardUnexpected();
      }
      const receiptRaw = stdout;                                  // receipt IS this run's collected stdout
      // A run whose launch/cleanup already failed never reaches receipt parsing:
      // the sanitized refusal carries the runner-collected facts.
      if (facts.failure !== null || facts.unexpected > 0 || facts.closed === false) {
        const e = Object.assign(Error('DRIVER_FAILED'), { code: 'DRIVER_FAILED' });
        e.facts = Object.freeze({ ...facts });
        e.report = { killAccepted, closedUnknown, holdReleased, timedOut };
        throw e;
      }
      let assessed;
      try {
        assessed = contract.assess(receiptRaw, facts.status, Buffer.from(JSON.stringify(facts)));
      } catch (e) {
        e.facts = Object.freeze({ ...facts });
        e.report = { killAccepted, closedUnknown, holdReleased, timedOut };
        throw e;
      }
      return freeze({
        ok: assessed.ok === true && facts.failure === null && productUnchanged,
        assessment: assessed,
        facts: Object.freeze({ ...facts }),
        killAccepted, closedUnknown, holdReleased, timedOut,
        artifactSha256: binding.artifactSha256,
        productUnchanged,
        executionApproved: false, realInputApproved: false, l2Approved: false
      });
    }
  });
}

module.exports = Object.freeze({ inspectProduct, bind, createRunner });
