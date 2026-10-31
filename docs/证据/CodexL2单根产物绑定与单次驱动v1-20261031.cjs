'use strict';
// L2 root-only artifact binding + private single-run driver (offline preparation).
// No child_process/net/http/tls/dgram/dns imports: every launch/IO capability is
// supplied by an explicit boundary argument. Unbound artifacts are refused.
const contract = require('./CodexL2单根对照回执契约v2-20261031.cjs');
const crypto = require('node:crypto');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
function need(v, code) { if (!v) throw Object.assign(Error(code), { code }); }
function freeze(v) { if (v && typeof v === 'object' && !Buffer.isBuffer(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

// PE static inspection: file bytes only; no CLR loading, no execution.
function inspectProduct(b) {
  need(Buffer.isBuffer(b) && b.length > 0 && b.length <= 1048576, 'PRODUCT_WIRE');
  need(b.length >= 64 && b.toString('latin1', 0, 2) === 'MZ', 'PE_MAGIC');
  const pe = b.readUInt32LE(0x3c);
  need(pe > 0 && pe + 264 <= b.length && b.toString('latin1', pe, pe + 4) === 'PE\0\0', 'PE_SIG');
  const machine = b.readUInt16LE(pe + 4);
  need(machine === 0x8664, 'PE_MACHINE');               // AMD64 only
  const magic = b.readUInt16LE(pe + 24);
  need(magic === 0x20b, 'PE_OPTIONAL');                 // PE32+ only
  const clrOff = pe + 24 + 112 + 14 * 8;                // PE32+ data directory 14 = CLR
  need(b.readUInt32LE(clrOff) !== 0, 'PE_CLR');         // managed image required
  return Object.freeze({ size: b.length, machine: 'AMD64', magic: 'PE32+', clrHeaderPresent: true });
}

// Bind a real product image to the validated fixed configuration.
// The digest is computed from the provided bytes; nothing is invented.
function bind(configRaw, productBytes) {
  const config = contract.validateConfig(configRaw);
  need(config.mode === 'rootOnly' && config.executionReady === false && config.artifactBound === false, 'CONFIG_STATE');
  need(Buffer.isBuffer(productBytes) && productBytes.length > 0, 'PRODUCT_WIRE');
  const statics = inspectProduct(productBytes);
  return freeze({
    config,
    productBytes,
    artifactSha256: H(productBytes),
    statics,
    artifactBound: true,
    executionApproved: false
  });
}

// Private single-run driver. `boundary` must explicitly provide every OS-facing
// capability (spawn/awaitExit/kill/digestFile/receipt...); this module itself has
// no public process or network surface, so unbound or synthetic-free use is impossible.
function createRunner(binding, boundary) {
  need(binding && binding.artifactBound === true && binding.productBytes, 'ARTIFACT_NOT_BOUND');
  need(boundary && typeof boundary === 'object' &&
    typeof boundary.spawn === 'function' && typeof boundary.awaitExit === 'function' &&
    typeof boundary.kill === 'function' && typeof boundary.digestFile === 'function' &&
    typeof boundary.receipt === 'function' && typeof boundary.receiptExistsBefore === 'function' &&
    typeof boundary.productPath === 'string' && boundary.productPath.length > 0, 'BOUNDARY_REQUIRED');
  const cfg = binding.config;
  let consumed = false;
  return Object.freeze({
    get artifactSha256() { return binding.artifactSha256; },
    get consumed() { return consumed; },
    runOnce() {
      need(!consumed, 'ALREADY_RUN');            // single run per binding
      consumed = true;
      const sourcesBefore = cfg.sources.every(s => boundary.digestFile(s.rel) === s.sha256);
      const facts = {
        attempts: 1, unexpected: 0, closed: false, status: 0, signal: null, failure: null,
        killRequested: false, stderrBytes: 0, receiptExistsBefore: !!boundary.receiptExistsBefore(),
        sourcesBefore, sourcesAfter: false
      };
      let child = null, timedOut = false, stdoutBytes = 0, killAccepted = false;
      try {
        child = boundary.spawn({
          cwd: cfg.cwd, artifactPath: boundary.productPath, args: cfg.helperArgs,
          timeoutMs: cfg.driverTimeoutMs, outputLimitBytes: cfg.outputLimitBytes
        });
      } catch (e) {
        facts.failure = 'SPAWN_FAILED'; facts.closed = true;
      }
      if (child) {
        child.onData((isErr, buf) => {
          if (isErr) facts.stderrBytes += buf.length;
          else stdoutBytes += buf.length;
          if (stdoutBytes + facts.stderrBytes > cfg.outputLimitBytes && !facts.failure) facts.failure = 'OUTPUT_LIMIT';
        });
        const w = boundary.awaitExit(child, cfg.driverTimeoutMs);
        if (w.timedOut) {
          timedOut = true; facts.failure = facts.failure || 'TIMEOUT';
          facts.killRequested = true; killAccepted = boundary.kill(child) === true;
        } else {
          facts.status = w.status; facts.signal = w.signal; facts.closed = w.closed === true;
        }
        if (facts.stderrBytes > 0) {
          facts.failure = facts.failure || 'STDERR';
          if (!facts.killRequested) { facts.killRequested = true; killAccepted = boundary.kill(child) === true; }
        }
        if (!facts.closed && !facts.failure) facts.failure = 'CLOSE_UNCONFIRMED';
      }
      facts.sourcesAfter = sourcesBefore ? cfg.sources.every(s => boundary.digestFile(s.rel) === s.sha256) : false;
      const receiptRaw = boundary.receipt({ timedOut, failure: facts.failure });
      let assessed;
      try {
        assessed = contract.assess(receiptRaw, facts.status, Buffer.from(JSON.stringify(facts)));
      } catch (e) {
        e.facts = Object.freeze({ ...facts });   // runner-collected facts remain inspectable
        throw e;
      }
      return freeze({
        ok: assessed.ok === true,
        assessment: assessed,
        facts: Object.freeze({ ...facts }),
        artifactSha256: binding.artifactSha256,
        executionApproved: false, realInputApproved: false, l2Approved: false
      });
    }
  });
}

module.exports = Object.freeze({ inspectProduct, bind, createRunner });
