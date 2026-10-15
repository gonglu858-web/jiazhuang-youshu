'use strict';
// 本地合成反例：从真实打包器新建来源和候选，只改忽略目录内的 manifest。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const business = require(path.join(root, 'miniapp/scripts/package-business-test.cjs'));
const packer = require(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'));
const fixed = require(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs')).FIXED_TARGET;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const run = crypto.randomUUID();
const work = path.join(root, 'artifacts/schedule-sandbox/business-test', 'codex-close-binding-' + run);
fs.mkdirSync(work, { recursive: true });
const writeJson = (name, value) => {
  const target = path.join(work, name);
  fs.writeFileSync(target, JSON.stringify(value, null, 2), { flag: 'wx' });
  return target;
};

function main() {
  const round = 'synthetic-codex-' + run.slice(0, 12);
  const users = Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
    userId: 'u_' + sha(fixed.appId + ':synthetic-' + role + run).slice(0, 40),
    source: 'synthetic fixture'
  }]));
  const businessPlan = writeJson('business-plan.json', {
    schema: 'business-test-plan/1', window: 'P', synthetic: true,
    businessRoundId: round, windowNo: 'P-01', appId: fixed.appId, envId: fixed.envId,
    users, projectReadyMarker: 'ready-' + round,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
  });
  const source = business.build('P', businessPlan, path.join(work, 'source')).outDir;
  assert.equal(business.checkCloseDir(source).ok, true);

  const now = Date.now();
  const identityPlan = writeJson('identity-plan.json', {
    schema: packer.PLAN_SCHEMA, synthetic: true,
    checkRoundId: 'codex-' + run.slice(0, 12), participantCode: '1',
    appId: fixed.appId, envId: fixed.envId, functionName: fixed.functionName,
    collection: fixed.collection, passphraseDigest: sha('synthetic-pass-' + run),
    windowStartsAtIso: new Date(now - 60000).toISOString(),
    windowExpiresAtIso: new Date(now + 600000).toISOString(), closeSourceDir: source
  });
  const out = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-codex-binding-' + run);
  packer.build(identityPlan, out);
  const manifestPath = path.join(out, 'manifest.json');
  const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const put = value => fs.writeFileSync(manifestPath, JSON.stringify(value, null, 2) + '\n');
  assert.equal(packer.checkDir(out).ok, true);
  const checks = [];
  const tryTamper = (name, mutate, expectedProblem, accepted = false) => {
    const altered = structuredClone(original);
    mutate(altered);
    put(altered);
    const result = packer.checkDir(out);
    assert.equal(result.ok, accepted, name);
    if (expectedProblem) assert.ok(result.problems.some(x => x.includes(expectedProblem)), name);
    checks.push({ name, accepted: result.ok });
  };
  const serverRel = original.closePackage.files.find(f => f.rel.startsWith('server/scheduleSandbox/')).rel;
  tryTamper('server sourceRel', m => { m.closePackage.files.find(f => f.rel === serverRel).sourceRel = 'server/other.js'; }, '（sourceRel）');
  tryTamper('mapping', m => { m.closePackage.mapping = 'unrelated mapping'; }, 'closePackage.mapping');
  tryTamper('missing sourceRel', m => { delete m.closePackage.files[0].sourceRel; }, '（sourceRel）');
  tryTamper('unknown field', m => { m.closePackage.files[0].note = 'extra'; }, '未知字段');
  tryTamper('missing entry', m => { m.closePackage.files.splice(0, 1); }, '关闭清单缺少来源映射条目');
  tryTamper('bytes drift', m => { m.closePackage.files[0].bytes++; }, '清单记录与重建不符');
  tryTamper('closePackage.sourceDir metadata', m => { m.closePackage.sourceDir = 'unrelated/source'; }, null, true);
  put(original);
  assert.equal(packer.checkDir(out).ok, true);
  return {
    schema: 'codex-participant-close-binding-review/1', reviewedCommit: '0c2eb99',
    baselineValid: true, checks, restoredValid: true,
    note: 'sourceDir 为关闭清单中的重复说明字段；计划及 manifest 顶部来源字段未改且继续受校验。',
    scope: '仅本地合成包及忽略目录；未访问平台或真实凭据'
  };
}

try {
  const body = JSON.stringify(main(), null, 2) + '\n';
  if (process.argv.length === 2) process.stdout.write(body);
  else if (process.argv.length === 4 && process.argv[2] === '--out') {
    fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
  } else throw new Error('usage: node evidence.cjs [--out <new-path>]');
} catch (error) {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
}
