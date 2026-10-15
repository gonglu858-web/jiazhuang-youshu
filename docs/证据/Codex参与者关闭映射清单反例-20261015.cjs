'use strict';
// 独立反例：只改新生成的忽略目录 manifest，检查来源映射声明是否被 checkDir 核对。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const business = require(path.join(root, 'miniapp/scripts/package-business-test.cjs'));
const identity = require(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'));
const fixed = require(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs')).FIXED_TARGET;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const run = crypto.randomUUID();
const base = path.join(root, 'artifacts/schedule-sandbox/business-test');
const work = path.join(base, 'codex-close-manifest-' + run);
fs.mkdirSync(work, { recursive: true });
const write = (name, obj) => {
  const target = path.join(work, name);
  fs.writeFileSync(target, JSON.stringify(obj, null, 2), { flag: 'wx' });
  return target;
};

function main() {
  const businessRound = 'synthetic-codex-' + run.slice(0, 12);
  const users = Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
    userId: 'u_' + sha(fixed.appId + ':synthetic-' + role + run).slice(0, 40),
    source: 'synthetic fixture'
  }]));
  const sourcePlan = write('business-plan.json', {
    schema: 'business-test-plan/1', window: 'P', synthetic: true,
    businessRoundId: businessRound, windowNo: 'P-01',
    appId: fixed.appId, envId: fixed.envId, users,
    projectReadyMarker: 'ready-' + businessRound,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
  });
  const source = business.build('P', sourcePlan, path.join(base, 'codex-close-source-' + run)).outDir;
  assert.equal(business.checkCloseDir(source).ok, true);
  const now = Date.now();
  const plan = write('identity-plan.json', {
    schema: identity.PLAN_SCHEMA, synthetic: true,
    checkRoundId: 'codex-' + run.slice(0, 12), participantCode: '1',
    appId: fixed.appId, envId: fixed.envId,
    functionName: fixed.functionName, collection: fixed.collection,
    passphraseDigest: sha('synthetic-pass-' + run),
    windowStartsAtIso: new Date(now - 60000).toISOString(),
    windowExpiresAtIso: new Date(now + 600000).toISOString(),
    closeSourceDir: source
  });
  const output = path.join(base, 'participant-identity-codex-manifest-' + run);
  identity.build(plan, output);
  const manifestPath = path.join(output, 'manifest.json');
  const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(identity.checkDir(output).ok, true);
  const altered = structuredClone(original);
  altered.closePackage.files[0].sourceRel = 'server/nonexistent.js';
  altered.closePackage.mapping = 'unrelated mapping';
  fs.writeFileSync(manifestPath, JSON.stringify(altered, null, 2) + '\n');
  const accepted = identity.checkDir(output);
  assert.equal(accepted.ok, true, '当前实现确实漏查 sourceRel 和 mapping');
  altered.closePackage.files[0].bytes++;
  fs.writeFileSync(manifestPath, JSON.stringify(altered, null, 2) + '\n');
  const control = identity.checkDir(output);
  assert.equal(control.ok, false, '对照：bytes 篡改应被拒');
  return {
    schema: 'codex-participant-close-manifest-counterexample/1',
    reviewedCommit: '10e47f9',
    baselineValid: true,
    sourceRelAndMappingTamperedAccepted: accepted.ok,
    tamperedSourceRel: altered.closePackage.files[0].sourceRel,
    tamperedMapping: altered.closePackage.mapping,
    bytesTamperControlRejected: !control.ok,
    diskSourceUnchanged: business.checkCloseDir(source).ok,
    scope: '本地合成计划及忽略目录；未访问平台或凭据'
  };
}

try { process.stdout.write(JSON.stringify(main(), null, 2) + '\n'); }
catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
