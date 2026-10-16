'use strict';
// Independent local review of 5ef7d96. No credentials, platform calls or source edits.
// Counterexamples describe observations; a reproduced defect is not a passing product gate.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const auditFile = path.join(__dirname, 'CodeBuddyI1入站事件封装离线核实-20261016.cjs');
const auditSource = fs.readFileSync(auditFile, 'utf8');
function auditVariant(kind) {
  let source = auditSource;
  if (kind === 'caughtAttempt') {
    const anchor = 'const businessStart = guardHits.length;';
    assert.equal(source.split(anchor).length, 2);
    source = source.replace(anchor, anchor + "\ntry { require('node:https').request('https://example.invalid'); } catch (_) {}");
  }
  const processStub = { argv: ['node', auditFile], exitCode: 0 };
  const outputs = [], errors = [];
  const nativeRequire = createRequire(auditFile);
  const fsProxy = new Proxy(fs, { get(target, key) {
    if (key !== 'readFileSync' || kind !== 'sourceDrift') return target[key];
    return (p, ...args) => {
      const b = target.readFileSync(p, ...args);
      if (path.resolve(String(p)) !== path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs')) return b;
      return Buffer.isBuffer(b) ? Buffer.concat([b, Buffer.from('\n// synthetic drift\n')]) : b + '\n// synthetic drift\n';
    };
  }});
  const context = { require: n => n === 'node:fs' ? fsProxy : nativeRequire(n),
    __dirname: path.dirname(auditFile), __filename: auditFile, Buffer, process: processStub,
    console: { log: s => outputs.push(s), error: (...s) => errors.push(s.join(' ')) } };
  vm.runInNewContext(source, context, { filename: auditFile, timeout: 15000 });
  const result = JSON.parse(outputs[0]);
  return { exitCode: processStub.exitCode, counters: result.counters, driftHits: result.sourcePins.driftHits };
}
async function main() {
  const baseline = auditVariant('baseline');
  const caughtAttempt = auditVariant('caughtAttempt');
  const sourceDrift = auditVariant('sourceDrift');
  assert.equal(baseline.exitCode, 0);
  assert.equal(caughtAttempt.counters.businessPhaseGuardAttempts, 1);
  assert.equal(caughtAttempt.exitCode, 0); // observed missing failure condition
  assert.equal(sourceDrift.driftHits, 1);
  assert.equal(sourceDrift.exitCode, 1);

  const core = require(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs'));
  const passphrase = 'synthetic-review-passphrase-only';
  const makeRequest = () => ({ action: 'inspectSelf', checkRoundId: 'synthetic-review-round', passphrase, userInfo: {} });
  const diagnosticCases = [];
  for (const endState of ['unchanged', 'expires', 'NaN', 'throws']) {
    let phase = 0, enumerations = 0, clockReads = 0, dbCalls = 0;
    const checker = core.createIdentityChecker({
      db: { collection() { dbCalls++; throw Error('DB forbidden'); } },
      trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, openid: 'synthetic-openid' },
      config: { checkRoundId: 'synthetic-review-round', passphraseDigest: sha(passphrase),
        windowStartsAtMs: 1000, windowExpiresAtMs: 2000, keyDiagnostic: true },
      now() { clockReads++; if (!phase || endState === 'unchanged') return 1500;
        if (endState === 'throws') throw Error('synthetic-clock-unavailable');
        return endState === 'NaN' ? NaN : 2000; }
    });
    // Synthetic scheduling hook advances the clock at diagnostic enumeration, after its initial gate.
    // This is not a claim that real platform events contain Proxy objects.
    const event = new Proxy(makeRequest(), { ownKeys(t) {
      if (++enumerations === 2) phase = 1;
      return Reflect.ownKeys(t);
    }});
    const result = await checker.handle(event);
    assert.equal(result.code, 'PIC_REQUEST_INVALID');
    assert.equal(dbCalls, 0);
    diagnosticCases.push({ endState, clockReads, enumerations, diagnosticReturned: !!result.keyDiagnostic, dbCalls,
      readAttempted: result.readAttempted, registrationState: result.registrationState });
  }

  const clientFile = path.join(root, 'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js');
  const malformed = { schema: core.KEY_DIAGNOSTIC_SCHEMA, diagnosticScope: core.KEY_DIAGNOSTIC_SCOPE,
    otherKeyCount: 9, otherKeyNameLengthBuckets: { 'len<=4': 0, 'len5-8': 0, 'len9-16': 0, 'len17-32': 0, lenOver32: 0 },
    candidateLabels: 'synthetic-invalid-type', truncated: false };
  const clientCtx = { module: { exports: {} }, require: () => ({ checkRoundId: 'synthetic-review-round' }),
    wx: { cloud: { init() {}, callFunction: async () => ({ result: { keyDiagnostic: malformed } }) } } };
  vm.runInNewContext(fs.readFileSync(clientFile, 'utf8'), clientCtx, { filename: clientFile });
  const clientResult = await clientCtx.module.exports.callIdentityCheck(makeRequest());
  const clientMalformedAccepted = !!clientResult.keyDiagnostic;

  const business = require(path.join(root, 'miniapp/scripts/package-business-test.cjs'));
  const packer = require(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'));
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'codex-diag-review-' + crypto.randomBytes(6).toString('hex'));
  assert.ok(scratch.startsWith(path.join(root, 'artifacts') + path.sep));
  fs.mkdirSync(scratch, { recursive: true });
  const write = (name, obj) => { const p = path.join(scratch, name); fs.writeFileSync(p, JSON.stringify(obj), { flag: 'wx' }); return p; };
  const round = 'synthetic-codex-diag-review';
  const sourcePlan = write('source-plan.json', { schema: 'business-test-plan/1', window: 'P', synthetic: true,
    businessRoundId: round, windowNo: 'P-01', appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(k => [k, { userId: 'u_' + sha(k).slice(0,40), source: 'synthetic' }])),
    projectReadyMarker: 'ready-' + round, windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z' });
  const source = business.build('P', sourcePlan, path.join(scratch, 'close-source'));
  const picPlan = write('pic-plan.json', { schema: packer.PLAN_SCHEMA, synthetic: true, checkRoundId: round,
    participantCode: '1', ...core.FIXED_TARGET, passphraseDigest: sha(passphrase),
    windowStartsAtIso: '2030-01-01T00:00:00Z', windowExpiresAtIso: '2030-01-01T00:10:00Z', closeSourceDir: source.outDir });
  const candidate = path.join(path.dirname(scratch), 'participant-identity-' + path.basename(scratch));
  packer.build(picPlan, candidate);
  assert.equal(packer.checkDir(candidate).ok, true);
  const manifestFile = path.join(candidate, 'manifest.json');
  const original = fs.readFileSync(manifestFile);
  const edited = JSON.parse(original);
  edited.keyDiagnosticSchema = 'synthetic-unrelated-protocol'; edited.keyDiagnosticScope = 'synthetic-unrelated-scope';
  fs.writeFileSync(manifestFile, JSON.stringify(edited));
  const falseModeManifestAccepted = packer.checkDir(candidate).ok;
  fs.writeFileSync(manifestFile, original);
  assert.equal(packer.checkDir(candidate).ok, true);
  const result = { reviewedCommit: '5ef7d96', verificationKind: 'offline synthetic independent counterexamples',
    audit: { baseline, caughtAttempt, sourceDrift }, diagnosticCases, clientMalformedAccepted, falseModeManifestAccepted,
    coreSha256: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
    packerSha256: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    cloudOperations: 0, productSourcesChanged: false,
    limitations: ['Clock advancement is a synthetic enumeration hook, not platform evidence.', 'Client malformed data is a synthetic response, not observed cloud output.'] };
  const arg = process.argv.indexOf('--out');
  if (arg !== -1) fs.writeFileSync(path.resolve(process.argv[arg + 1]), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
