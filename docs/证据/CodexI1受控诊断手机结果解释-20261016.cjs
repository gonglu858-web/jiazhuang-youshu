'use strict';
// Offline interpretation only. Screenshot fields are manually transcribed from the user attachment.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pins = {
  'miniapp/scripts/lib/participant-identity-check.cjs': '7eadbd64ad17dedc57fd648c56ba2672a25e9af11a31ce555bac3536e59c5a09',
  'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js': '85a941fa7b30a722abcd6a96c4c55f515e2442143fd40a29e8d20fba2ff202f5',
  'miniapp/scripts/package-participant-identity-check.cjs': '141c252cec8af3051d8baf4ef23dc507a30f95de0b96b4b57ef56c092ea41029'
};
for (const [p, h] of Object.entries(pins)) assert.equal(sha(fs.readFileSync(path.join(root, p))), h);
const core = require(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs'));
async function main() {
  const prep = JSON.parse(fs.readFileSync(path.join(__dirname, 'Codex参与者I1受控诊断包准备-20261016.json')));
  const screenshot = path.join(path.dirname(prep.planPath), 'participant-result-82583d63.png');
  const probes = [];
  for (const keys of [['userInfo'], ['syntheticOther'], ['userInfo', 'syntheticOther'], ['userInfo', 'wxCloudApiToken']]) {
    let dbCalls = 0, valueReads = 0;
    const passphrase = 'synthetic-screen-interpretation';
    const checker = core.createIdentityChecker({
      db: { collection() { dbCalls++; throw Error('NO_DB'); } },
      trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, openid: 'synthetic-openid' },
      config: { checkRoundId: 'synthetic-round', passphraseDigest: sha(passphrase), windowStartsAtMs: 1000, windowExpiresAtMs: 2000, keyDiagnostic: true },
      now: () => 1500
    });
    const event = { action: 'inspectSelf', passphrase, checkRoundId: 'synthetic-round' };
    for (const k of keys) Object.defineProperty(event, k, { enumerable: true, get() { valueReads++; throw Error('VALUE_MUST_NOT_BE_READ'); } });
    const result = await checker.handle(event);
    assert.equal(result.code, 'PIC_REQUEST_INVALID'); assert.equal(result.registrationState, 'UNKNOWN');
    assert.equal(result.readAttempted, false); assert.equal(dbCalls, 0); assert.equal(valueReads, 0);
    const expectedOther = keys.filter(k => k !== 'userInfo').length;
    assert.equal(result.keyDiagnostic.otherKeyCount, expectedOther);
    assert.equal(result.keyDiagnostic.otherKeyNameLengthBuckets['len9-16'], expectedOther);
    assert.deepEqual(result.keyDiagnostic.candidateLabels, keys.includes('userInfo') ? ['CANDIDATE_USERINFO'] : []);
    probes.push({ syntheticInputKeys: keys, keyDiagnostic: result.keyDiagnostic, dbCalls, valueReads });
  }
  // Static SDK source only: do not require this SDK or invoke its credential/context helpers.
  const sdkBase = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/@cloudbase/node-sdk';
  const sdkAnchors = [];
  for (const rel of ['lib/utils/wxCloudToken.js', 'lib/utils/httpRequest.js', 'types/index.d.ts']) {
    const b = fs.readFileSync(path.join(sdkBase, rel));
    assert(b.toString().includes('wxCloudApiToken'));
    sdkAnchors.push({ rel, sha256: sha(b), containsCandidateName: true });
  }
  const record = {
    schema: 'codex-i1-phone-diagnostic-interpretation/1', basisCommit: 'f7d45fe', roundId: prep.plan.checkRoundId,
    recordedAt: new Date().toISOString(), screenshot: { path: screenshot, bytes: fs.statSync(screenshot).size, sha256: sha(fs.readFileSync(screenshot)), source: 'user-provided attachment; manual visual transcription, not raw API response' },
    displayed: { deviceTime: '21:17', identityConfirmed: false, registrationState: 'UNKNOWN', recordMatched: 'unverified', readAttempted: false, userIdTail: null, serverTimeIso: null, code: 'PIC_REQUEST_INVALID', fullIdCheckboxChecked: false, candidateLabels: ['CANDIDATE_USERINFO'], otherKeyCount: 1, otherKeyNameLengthBuckets: { 'len<=4': 0, 'len5-8': 0, 'len9-16': 1, 'len17-32': 0, lenOver32: 0 } },
    interpretation: { recognizedExtraKey: 'userInfo', additionalUnknownKeys: 1, additionalKeyLengthRange: [9,16], totalExtraKeys: 2, actualUnknownKeyName: null, injectionSource: null, registrationEstablished: false },
    candidateForFutureLocalDiagnostic: { name: 'wxCloudApiToken', length: 'wxCloudApiToken'.length, status: 'hypothesis only; SDK outgoing-request anchor does not prove phone inbound field', sdkAnchors },
    probes, sourcePins: pins, networkOperations: 0, credentialFetches: 0, cloudOperations: 0, productSourceChanged: false,
    remoteState: 'retain verified closed state from previous execution; not queried again',
    limitation: 'Identical count/bucket output can arise from syntheticOther or wxCloudApiToken. This ambiguity is directly demonstrated and cannot be resolved by length alone.'
  };
  const i = process.argv.indexOf('--out');
  if (i >= 0) fs.writeFileSync(path.resolve(process.argv[i + 1]), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(record, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
