'use strict';
// Local independent review; synthetic input and memory-only evidence injection.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function runEvidence(injected) {
  const file = path.join(__dirname, 'CodeBuddy受控诊断R1R4收尾-20261016.cjs');
  let source = fs.readFileSync(file, 'utf8');
  if (injected) {
    const anchor = '  const businessStart = guardHits.length;';
    assert.equal(source.split(anchor).length, 2);
    source = source.replace(anchor, anchor + "\n  try { require('node:https').request('https://example.invalid'); } catch (_) {}");
  }
  // Share only the synthetic close-source setting with the packer loaded outside this VM.
  const envProxy = new Proxy({}, { get: (_, k) => k === 'PIC_CLOSE_SOURCE_DIR' ? process.env[k] : undefined,
    set: (_, k, v) => { assert.equal(k, 'PIC_CLOSE_SOURCE_DIR'); process.env[k] = v; return true; },
    deleteProperty: (_, k) => { assert.equal(k, 'PIC_CLOSE_SOURCE_DIR'); delete process.env[k]; return true; } });
  const logs = [], errors = [], processStub = { argv: ['node', file], env: envProxy, exitCode: 0 };
  const ctx = { require: createRequire(file), __dirname: path.dirname(file), __filename: file, Buffer,
    process: processStub, console: { log: s => logs.push(s), error: (...s) => errors.push(s.join(' ')) } };
  await vm.runInNewContext(source, ctx, { filename: file, timeout: 30000 });
  assert.ok(logs[0], errors.join('\n'));
  const output = JSON.parse(logs[0]);
  const summary = errors.find(s => s.includes('[收尾证据摘要]')) || '';
  const match = summary.match(/业务期意外=(\d+)/);
  return { exitCode: processStub.exitCode, unexpectedFromSummary: match ? Number(match[1]) : null,
    jsonHasGuardCounters: Object.hasOwn(output, 'counters'), jsonHasOk: Object.hasOwn(output, 'ok'),
    innerAudit: output.r1, r2: output.r2Cases, r3: output.r3, r4: output.r4 };
}
async function main() {
  const normal = await runEvidence(false), caught = await runEvidence(true);
  assert.equal(normal.exitCode, 0); assert.equal(normal.unexpectedFromSummary, 0);
  assert.equal(caught.unexpectedFromSummary, 1); assert.equal(caught.exitCode, 0);
  const core = require(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs'));
  const passphrase = 'synthetic-codex-final-clock';
  const finalClock = [];
  for (const mode of ['valid', 'expired', 'notOpen', 'NaN', 'throw']) {
    let reads = 0, dbCalls = 0;
    const checker = core.createIdentityChecker({
      db: { collection() { dbCalls++; throw Error('DB forbidden'); } },
      trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, openid: 'synthetic-openid' },
      config: { checkRoundId: 'synthetic-final-clock', passphraseDigest: sha(passphrase),
        windowStartsAtMs: 1000, windowExpiresAtMs: 2000, keyDiagnostic: true },
      now() { reads++; if (reads < 3 || mode === 'valid') return 1500;
        if (mode === 'throw') throw Error('synthetic clock');
        return mode === 'NaN' ? NaN : mode === 'notOpen' ? 999 : 2000; }
    });
    const r = await checker.handle({ action: 'inspectSelf', passphrase, checkRoundId: 'synthetic-final-clock', userInfo: {} });
    assert.equal(!!r.keyDiagnostic, mode === 'valid'); assert.equal(dbCalls, 0);
    assert.equal(r.code, 'PIC_REQUEST_INVALID'); assert.equal(r.readAttempted, false);
    assert.equal(r.registrationState, 'UNKNOWN');
    finalClock.push({ mode, reads, diagnostic: !!r.keyDiagnostic, dbCalls });
  }
  const clientFile = path.join(root, 'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js');
  let diagnostic;
  const ctx = { module: { exports: {} }, require: () => ({ checkRoundId: 'synthetic-review' }),
    wx: { cloud: { init() {}, callFunction: async () => ({ result: { code: 'PIC_REQUEST_INVALID', keyDiagnostic: diagnostic } }) } } };
  vm.runInNewContext(fs.readFileSync(clientFile, 'utf8'), ctx, { filename: clientFile });
  const truncation = [];
  for (const labels of [[], ['CANDIDATE_USERINFO']]) for (const truncated of [false, true]) {
    diagnostic = { schema: core.KEY_DIAGNOSTIC_SCHEMA, diagnosticScope: core.KEY_DIAGNOSTIC_SCOPE,
      otherKeyCount: 1, otherKeyNameLengthBuckets: { 'len<=4': 1, 'len5-8': 0, 'len9-16': 0, 'len17-32': 0, lenOver32: 0 },
      candidateLabels: labels, truncated };
    const r = await ctx.module.exports.callIdentityCheck({ action: 'inspectSelf', passphrase: 'synthetic' });
    truncation.push({ labels, truncated, accepted: !!r.keyDiagnostic });
  }
  assert.ok(truncation.every(r => r.accepted));
  const result = { reviewedCommit: '97bc3ff', verificationKind: 'local synthetic independent review, no cloud',
    normal, caught, finalClock, truncation,
    digests: { core: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
      client: sha(fs.readFileSync(clientFile)), packer: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'))) },
    cloudOperations: 0, sourceChanged: false,
    note: 'Observed counterexamples are recorded, not passing product assertions. Injected https call was blocked before transport.' };
  const i = process.argv.indexOf('--out');
  if (i >= 0) fs.writeFileSync(path.resolve(process.argv[i + 1]), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ normalExit: normal.exitCode, caughtExit: caught.exitCode, caughtUnexpected: caught.unexpectedFromSummary, finalClock, truncation }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
