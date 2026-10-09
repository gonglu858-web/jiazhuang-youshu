'use strict';
// stdout-only; synthetic stdin/data; actual installed SDK document serialization;
// request transport replaced before any collection reference is constructed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const workerPath = path.join(root, 'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs');
const observer = require(path.join(root, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
const workerFunctions = require(workerPath);
const sdkRoot = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
const sdk = require(path.join(sdkRoot, '@cloudbase/node-sdk'));
const database = require(path.join(sdkRoot, '@cloudbase/database'));
const openid = 'synthetic-offline-only';
const target = workerFunctions.deriveUserId('wxfb4db1615ac15531', openid);
const marker = 'SYNTHETIC_PRIVATE_MARKER';
async function executeWorker(expiryMode, requestId = '00000000-0000-4000-8000-000000000001') {
  const original = database.Db.reqClass;
  const calls = [];
  class FakeRequest {
    async send(action, params) {
      assert.equal(action, 'database.getDocument');
      calls.push({ action, collection: params.collectionName });
      const doc = params.collectionName === 'schtest_v1_app_admins'
        ? { _id: 'primary', userId: target, status: 'active' }
        : { _id: target, status: 'active', openid };
      return { data: { list: [JSON.stringify(doc)] }, requestId };
    }
  }
  const input = new PassThrough();
  const mod = { exports: {} };
  const actualRequire = createRequire(workerPath);
  function localRequire(name) {
    if (name.replace(/\\/g, '/').startsWith(sdkRoot + '/@cloudbase/node-sdk')) {
      return { init(config) {
        const app = sdk.init(config);
        return { database() {
          const db = app.database();
          database.Db.reqClass = FakeRequest;
          return db;
        } };
      } };
    }
    return actualRequire(name);
  }
  localRequire.resolve = actualRequire.resolve;
  localRequire.main = mod;
  let resolveOutput;
  const output = new Promise(resolve => { resolveOutput = resolve; });
  const context = { module: mod, exports: mod.exports, require: localRequire, Buffer,
    process: { stdin: input, stdout: { write(s) { resolveOutput(JSON.parse(s)); return true; } } } };
  try {
    vm.runInNewContext(fs.readFileSync(workerPath, 'utf8'), context, { filename: workerPath });
    const payload = { secretId: 'synthetic-id', secretKey: 'synthetic-key', sessionToken: 'synthetic-token', targetUserId: target };
    if (expiryMode === 'valid') payload.expiresAtMs = Date.now() + 600000;
    if (expiryMode === 'expired') payload.expiresAtMs = Date.now() - 1;
    input.end(JSON.stringify(payload) + '\n');
    const result = await output;
    return { result, calls };
  } finally { database.Db.reqClass = original; }
}
function interpret(result) {
  return observer.interpretWorkerOutput({ code: 0, signal: null, stdout: JSON.stringify(result), processExited: true });
}
(async () => {
  const normal = await executeWorker('valid');
  assert.equal(normal.calls.length, 2);
  assert.equal(normal.result.targetUser.userStatus, 'active');
  const normalized = interpret(normal.result);
  const targetReport = observer.interpretTargetUser(normalized, target);
  assert.equal(targetReport.status, 'UNCONFIRMED');
  const statusOnly = JSON.parse(JSON.stringify(normal.result));
  statusOnly.targetUser.status = statusOnly.targetUser.userStatus;
  delete statusOnly.targetUser.userStatus;
  const statusOnlyReport = observer.interpretTargetUser(interpret(statusOnly), target);
  assert.equal(statusOnlyReport.status, 'UNCONFIRMED');
  const rawError = interpret({ ok: false, errorCode: marker, writeAttemptsCount: 0 });
  assert.equal(rawError.errorCode, marker);
  const rawDoc = observer.interpretPrimary(interpret({ ok: true, writeAttemptsCount: 0,
    primary: { classification: 'NOT_FOUND', docId: marker } }), target);
  assert.equal(rawDoc.docId, marker);
  const requestMarker = await executeWorker('valid', marker);
  assert.equal(requestMarker.result.primary.requestId, marker);
  const missingExpiry = await executeWorker('missing');
  assert.equal(missingExpiry.calls.length, 2);
  assert.equal(missingExpiry.result.credentialExpiredDuringRun, false);
  const expired = await executeWorker('expired');
  assert.equal(expired.calls.length, 0);
  console.log(JSON.stringify({ observedAt: new Date().toISOString(),
    mode: 'offline-real-sdk-serialization-synthetic-transport', realNetworkCalls: 0,
    realCredentialFetched: false, productFilesModified: false,
    findings: {
      S1: { actualWorkerReads: normal.calls.length, actualWorkerUserStatus: normal.result.targetUser.userStatus,
        finalTargetStatus: targetReport.status, finalTargetUserStatus: targetReport.userStatus,
        renameOnlyStillFails: statusOnlyReport.status === 'UNCONFIRMED' },
      S2: { arbitraryErrorCodeRetained: rawError.errorCode === marker,
        arbitraryNotFoundDocIdRetained: rawDoc.docId === marker,
        arbitrarySdkRequestIdInWorkerOutput: requestMarker.result.primary.requestId === marker },
      S3: { missingExpiryReads: missingExpiry.calls.length,
        missingExpiryReportedExpired: missingExpiry.result.credentialExpiredDuringRun,
        expiredControlReads: expired.calls.length }
    }, limitations: ['SDK transport is synthetic; no platform behavior is proven.',
      'Parent post-worker expiry omission is a static finding, not simulated here.'] }, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
