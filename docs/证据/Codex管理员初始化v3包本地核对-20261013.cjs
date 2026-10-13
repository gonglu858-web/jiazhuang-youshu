'use strict';
// Only local preparation: no approval issuance, credential acquisition, worker, SDK initialization or cloud calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const sources = {
  'docs/证据/Codex首次管理员最终包本地核对-20261012.json': 'c24f351d5596547c971dc8368bef9375dcc794e271c5d92aca9de4ac0798acfa',
  'docs/证据/Codex管理员初始化单次执行v2-20261012.result.json': 'd9249018837db009150c1a0041217bd554425b595960788d4b17293358ff81fa',
  'docs/证据/Codex用户GetRole成功结果核对-20261013.json': 'e7210a4657bb5f98f6c8d3befdb017c75caa40d5f3225e00c2d904fb7a03b567',
  'docs/Codex方案-管理员初始化自助核验-20261013.md': '168d753e14397030afe4caeba08675c0c59f312dbedb44b028623ce39442bd95',
  'docs/证据/Codex管理员稳定身份只读基线-20261013.json': '8ac5c2a9bf60004f65933b48d3a8881a789f4dd30775e4d538c7730c305e3579',
  'docs/证据/Codex身份R1剩余出口独立验收-20261013.json': 'bb7abf9c64d19d41004d05f7693a322576e66c08f96800e6a7a6d823fa607073'
};
function record(p) {
  const b = fs.readFileSync(path.resolve(root, p));
  return { path: p, bytes: b.length, sha256: sha(b) };
}
function json(p) { return JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8')); }
const checkedSources = Object.entries(sources).map(([p, digest]) => {
  const r = record(p); assert.equal(r.sha256, digest, 'Source changed: ' + p); return r;
});
const old = json('docs/证据/Codex首次管理员最终包本地核对-20261012.json');
const review = json('docs/证据/Codex身份R1剩余出口独立验收-20261013.json');
const baseline = json('docs/证据/Codex管理员稳定身份只读基线-20261013.json');
const manual = json('docs/证据/Codex用户GetRole成功结果核对-20261013.json');
const previous = json('docs/证据/Codex管理员初始化单次执行v2-20261012.result.json');
assert.equal(previous.status, 'FAILED');
assert.equal(previous.result.workerStarted, false);
assert.equal(previous.result.errorCode, 'CALLER_SUBJECT_MISMATCH');
const expected = Object.fromEntries(old.implementationFiles.map(f => [path.basename(f.path), f.sha256]));
Object.assign(expected, review.implementation);
expected['sandbox-primary-approved-run.cjs'] = review.entrySha256;
const implementationFiles = Object.entries(expected).map(([name, digest]) => {
  const r = record('miniapp/scripts/lib/' + name); assert.equal(r.sha256, digest, 'Implementation changed: ' + name); return r;
});
const runtimeFiles = ['node', 'cliEntry', 'cliBundle'].map(k => {
  const r = record(old.runtime[k].path); assert.equal(r.sha256, old.runtime[k].sha256); return r;
});
assert.equal(path.resolve(process.execPath).toLowerCase(), path.resolve(root, old.runtime.node.path).toLowerCase());
const historicalEvidence = old.historicalEvidence.map(f => {
  const r = record(f.path); assert.equal(r.sha256, f.sha256); return r;
});
const tree = [];
function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const p = path.join(dir, d.name);
    assert.equal(d.isSymbolicLink(), false);
    if (d.isDirectory()) walk(p);
    else { assert.equal(d.isFile(), true); tree.push([path.relative(old.runtime.sdkRoot, p).replace(/\\/g, '/'), sha(fs.readFileSync(p))]); }
  }
}
walk(old.runtime.sdkRoot);
assert.equal(tree.length, old.runtime.sdkTreeFiles);
assert.equal(sha(JSON.stringify(tree)), old.runtime.sdkTreeSha256);
const lib = path.join(root, 'miniapp/scripts/lib');
const p4 = require(path.join(lib, 'sandbox-primary-bootstrap.cjs'));
const host = require(path.join(lib, 'sandbox-primary-execution-host.cjs'));
const entry = require(path.join(lib, 'sandbox-primary-approved-run.cjs'));
const observer = require(path.join(lib, 'cloudbase-readonly-observer.cjs'));
assert.equal(host.realModeOfflineHarnessActive(), false);
const planPath = 'docs/证据/Codex管理员初始化v3计划-20261013.json';
const plan = json(planPath);
assert.deepEqual(plan, {
  enabled: true, appId: old.plan.appId, envId: old.plan.envId,
  roundId: 'primary-20261013-self-01', targetUserId: old.plan.targetUserId,
  evidenceId: 'codex-primary-20261013-self-01-v3', expiresAt: '2026-10-13T14:00:00.000Z',
  schemaVersion: 1, operatorRef: 'Codex-reviewed-local-host', approvedOwnerHint: '2d3aa4'
});
p4.validatePlan(plan); // Uses current time; normalized output is deliberately not passed back to P4.
assert.ok(Date.now() < Date.parse(plan.expiresAt), 'Package expired');
assert.notEqual(plan.roundId, previous.runId);
assert.equal(baseline.stableIdentityConsistent, true);
assert.equal(baseline.association.matched, true);
assert.equal(baseline.first.stableIdentityDigest, baseline.second.stableIdentityDigest);
assert.equal(manual.supplied.roleIdSha256, baseline.first.fields.RoleId.sha256);
assert.equal(manual.supplied.ownerUinSha256, baseline.first.fields.AccountId.sha256);
assert.equal(baseline.association.stages.find(s => s.stage === 'describeEnvInfo').envInfo.wxAppId, plan.appId);
const outDir = path.join(root, 'docs/证据/管理员初始化执行-' + plan.roundId);
entry.assertFreshOutDir(outDir);
assert.equal(fs.existsSync(outDir), false, 'Prior invocation present');
const inputDigest = p4.inputDigest(plan);
const auditId = p4.auditId(plan, inputDigest);
assert.notEqual(auditId, previous.result.auditId);
const proof = {
  schema: 'codex-primary-v3-local-package/1', preparedAt: new Date().toISOString(), sourceCommit: 'a26f0bf',
  reviewedImplementation: review.reviewedCommit, acceptanceCommit: '523c9c6', packageRevision: 'primary-20261013-self-01-v3',
  status: 'PREPARED_AWAITING_EXPLICIT_CONFIRMATION', writeAuthorized: false, approvalIssued: false,
  credentialFetched: false, cloudCallAttempted: false, workerStarted: false, authStoreRead: false, databaseAttempted: false,
  planFile: record(planPath), plan, inputDigest, auditId, fullPlanDigest: host.fullPlanDigestOf(plan),
  bindingPolicyVersion: 'cloud-role-binding/1', expectedStableIdentityDigest: baseline.first.stableIdentityDigest,
  authorizationBasis: 'owner-verified-role-and-pinned-caller/1', alternativeBasisAccepted: false,
  principalSourceConfirmed: false, roleTrustApproved: false,
  credentialSourceMode: 'fixed-real-source', credentialProfile: observer.FIXED.authSessionDir,
  approvalWindow: 'at most 10 minutes after observed explicit user confirmation, no later than plan expiry',
  approvedByTemplate: 'project-owner-chat-confirmation:' + plan.roundId,
  outDir, outDirAbsent: true, implementationFiles, boundFingerprint: entry.fullFingerprint(), runtimeFiles,
  sdkRoot: old.runtime.sdkRoot, sdkTreeFiles: tree.length, sdkTreeSha256: sha(JSON.stringify(tree)),
  checkedSources, historicalEvidence, scriptSha256: sha(fs.readFileSync(__filename)),
  limitations: ['Historical cloud observations are not current cloud state.',
    'PrincipalId internal ownership remains unknown; explicit acceptance of alternative evidence is required.',
    'No live IAM write permission, production worker DB chain, quota or transaction verification.',
    'No deployment or source configuration change; closed status is supported by historical evidence only.']
};
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out'));
if (args.length) fs.writeFileSync(path.resolve(args[1]), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: proof.status, inputDigest, auditId, fullPlanDigest: proof.fullPlanDigest,
  implementationFiles: implementationFiles.length, sdkTreeFiles: tree.length, outDirAbsent: true, writeAuthorized: false }));
