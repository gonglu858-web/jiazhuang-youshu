'use strict';
// Local generated-artifact review only. Existing historical close source is read, never changed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const hits = [];
const guard = require('../../miniapp/tests/helpers/pic-guard-runner.cjs')
  .installParentGuards({ hits, getPhase: () => 'review', allowedScripts: [] });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  const packer = require('../../miniapp/scripts/package-participant-identity-check.cjs');
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'Codex参与者I2固化显示续接轮包准备-20261019.json')));
  const outRoot = path.join(root, 'artifacts/schedule-sandbox/business-test');
  const suffix = crypto.randomUUID();
  const scratch = path.join(outRoot, 'codex-round-repair-' + suffix);
  const candidate = path.join(outRoot, 'participant-identity-review-' + suffix);
  fs.mkdirSync(scratch, { recursive: true });
  const plan = { ...reference.plan, synthetic: true, checkRoundId: 'synthetic-codex-round-repair',
    passphraseDigest: sha('synthetic-review-secret'),
    windowStartsAtIso: '2030-01-01T00:00:00.000Z', windowExpiresAtIso: '2030-01-01T00:10:00.000Z' };
  const planPath = path.join(scratch, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan), { flag: 'wx' });
  const built = packer.build(planPath, candidate);
  const cfgModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(candidate, 'frontend/config/cloud.js'), 'utf8'), { module: cfgModule });
  const source = fs.readFileSync(path.join(candidate, 'frontend/utils/identity-check-client.js'), 'utf8');
  async function runClient(label, patch, result = { result: { synthetic: true } }) {
    let calls = 0, envelope = null, rejected = false;
    const config = { ...cfgModule.exports, ...patch };
    const module = { exports: {} };
    const wx = { cloud: { init() {}, callFunction(opts) {
      calls++;
      assert.equal(opts.name, 'scheduleSandbox');
      assert.deepEqual(Object.keys(opts.data), ['picRequest']);
      return Promise.resolve(result);
    } } };
    vm.runInNewContext(source, { module, wx, require: n => {
      assert.equal(n, '../config/cloud'); return config;
    } });
    try {
      envelope = await module.exports.callIdentityCheck({ action: 'inspectSelf', passphrase: 'synthetic-review-secret' });
    } catch (_) { rejected = true; }
    return { label, calls, rejected, evidencePresent: !!envelope?.localRequestEvidence,
      handoffAttempted: envelope?.localRequestEvidence?.handoffAttempted === true,
      transportOutcome: envelope?.transportOutcome || null, responsePresent: !!envelope?.response };
  }
  const cases = [];
  for (const [label, patch] of [
    ['valid', {}], ['missingBuildId', { previewBuildId: undefined }],
    ['malformedBuildId', { previewBuildId: 'invalid' }], ['invalidRound', { checkRoundId: '!' }],
    ['wrongProtocol', { requestProtocol: 'unapproved-protocol/9' }],
    ['wrongFunction', { identityCheckFunction: 'unapprovedFunction' }]
  ]) cases.push(await runClient(label, patch));
  assert.equal(cases[0].calls, 1); assert(cases[0].handoffAttempted);
  for (const c of cases.slice(1)) {
    assert.equal(c.calls, 0); assert(c.rejected); assert.equal(c.evidencePresent, false);
    assert.equal(c.handoffAttempted, false);
  }
  const missingResult = await runClient('missingResult', {}, {});
  assert.equal(missingResult.transportOutcome, 'returned');
  assert.equal(missingResult.responsePresent, false); assert(missingResult.handoffAttempted);
  const template = path.join(root, 'miniapp/scripts/templates/participant-identity-check/frontend/config/cloud.js');
  const before = fs.readFileSync(template), realRead = fs.readFileSync, failures = [];
  for (const mode of ['drift', 'ENOENT', 'EACCES']) {
    try {
      fs.readFileSync = function (p, ...args) {
        if (typeof p === 'string' && path.resolve(p) === template) {
          if (mode !== 'drift') { const e = new Error('synthetic read failure'); e.code = mode; throw e; }
          const b = realRead.call(fs, p, ...args);
          return Buffer.isBuffer(b) ? Buffer.concat([b, Buffer.from('\n// synthetic drift')]) : b + '\n// synthetic drift';
        }
        return realRead.call(fs, p, ...args);
      };
      for (const method of ['checkDir', 'checkPreparedDir']) {
        const r = packer[method](candidate);
        assert.equal(r.ok, false); assert.equal(r.planChecked, false);
        assert(r.problems.some(p => p.includes(mode === 'drift' ? 'PIC_SOURCE_DRIFT' : mode)));
        if (method === 'checkPreparedDir') assert.equal(r.executionReady, false);
        failures.push({ mode, method, ok: r.ok, planChecked: r.planChecked,
          executionReady: r.executionReady ?? null, classified: true });
      }
    } finally { fs.readFileSync = realRead; }
  }
  assert(fs.readFileSync(template).equals(before));
  assert(packer.checkDir(candidate).ok);
  const prepared = packer.checkPreparedDir(candidate);
  assert(prepared.ok); assert.equal(prepared.executionReady, false);
  const previousCloseEnv = process.env.PIC_CLOSE_SOURCE_DIR;
  let close;
  try {
    process.env.PIC_CLOSE_SOURCE_DIR = plan.closeSourceDir;
    close = packer.checkCloseDir(candidate); assert(close.ok); assert.equal(close.files, 23);
  } finally {
    if (previousCloseEnv === undefined) delete process.env.PIC_CLOSE_SOURCE_DIR;
    else process.env.PIC_CLOSE_SOURCE_DIR = previousCloseEnv;
  }
  const result = { schema: 'codex-phone-round-repair-review/1', reviewedCommit: '7f4dcf3',
    reviewBasis: 'a32ebdd R1/R2/C1', observedAt: new Date().toISOString(),
    verificationKind: 'generated client + synthetic wx; in-memory source failures; no platform activity',
    cases, missingResult, sourceFailures: failures, legalControls: true, closeFiles: close.files,
    sourceBytesUnchanged: true, packerSha256: sha(realRead(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    clientSha256: sha(realRead(path.join(root, 'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js'))),
    temporaryDirectories: [scratch, built.outDir], unexpectedGuardHits: hits.length, ok: hits.length === 0 };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (process.argv.length === 2) console.log(json);
  else {
    assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--out');
    fs.writeFileSync(process.argv[3], json, { flag: 'wx' });
    console.log(JSON.stringify({ ok: result.ok, clientCases: cases.length, sourceFailures: failures.length,
      temporaryDirectories: result.temporaryDirectories, unexpected: hits.length }));
  }
  process.exitCode = result.ok ? 0 : 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => guard.restoreAll());
