'use strict';
// Offline review only. Prints JSON; never rewrites historical evidence.
// All file mutations are confined to fresh, ignored registration-codex-* fixtures.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const TOOL = path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs');
const reg = require(TOOL);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const runId = 'codex-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const NOW = Date.now();
const plan = extra => ({ purpose: 'offline-review-only', ...reg.FIXED_TARGET,
  allowedUserIds: [reg.CANDIDATE_USER_ID], roundId: 'CODEX-LOCAL-REVIEW',
  windowStartsAt: new Date(NOW).toISOString(), windowExpiresAt: new Date(NOW + 1200000).toISOString(),
  sourceVersion: 'unverified-source-label', synthetic: true, ...extra });
let seq = 0;
const id = () => runId + '-' + (++seq);
const built = () => reg.buildRegistration(plan(), { outId: id(), nowMs: NOW });
const manifestPath = b => path.join(b.dir, 'manifest.json');
const readManifest = b => JSON.parse(fs.readFileSync(manifestPath(b), 'utf8'));
const writeManifest = (b, m) => fs.writeFileSync(manifestPath(b), JSON.stringify(m));
const rows = [];
const sample = (name, fn) => { try { rows.push({ name, ...fn() }); } catch(e) { rows.push({ name, harnessError: e.code || e.name }); } };
const protectedPaths = [TOOL,
  ...reg.PACKAGE_FILES.map(r => path.join(reg.SOURCE_DIR, r)),
  ...reg.PACKAGE_FILES.map(r => path.join(reg.ARTIFACTS_ROOT, 'closed-20261005-r2fix/package', r)),
  path.join(reg.ARTIFACTS_ROOT, 'closed-20261005-r2fix/manifest.json'),
  path.join(ROOT, 'miniapp/miniprogram/config/schedule-sandbox-proof.js'),
  path.join(ROOT, 'docs/证据/WorkBuddy本人登记制品本地准备复现-20261010.json')];
const before = protectedPaths.map(p => hash(fs.readFileSync(p)));

sample('positive-current-artifact', () => { const b = built(); return { controlPassed: reg.checkRegistration({ outDir: b.dir }).ok }; });
sample('R1-multiple-real-targets', () => ({ defectObserved:
  reg.validatePlan(plan({ synthetic: false, allowedUserIds: [reg.CANDIDATE_USER_ID, 'u_' + 'a'.repeat(40)] }), { nowMs: NOW }).allowedUserIds.length === 2 }));
sample('R1-other-real-target', () => ({ defectObserved:
  reg.validatePlan(plan({ synthetic: false, allowedUserIds: ['u_' + 'b'.repeat(40)] }), { nowMs: NOW }).allowedUserIds[0] !== reg.CANDIDATE_USER_ID }));
sample('R1-plan-string-executed-as-code', () => {
  const p = reg.validatePlan(plan({ roundId: "x' + (globalThis.__reviewMarker = 1) + '" }), { nowMs: NOW });
  const f = reg.buildFrontendOverride(p, p.sourceVersion);
  const context = { module: { exports: {} } };
  vm.runInNewContext(f.buf.toString('utf8'), context);
  return { defectObserved: context.__reviewMarker === 1, executedOnlyInIsolatedVm: true };
});
sample('R1-source-drift-outside-anchor', () => {
  const sources = reg.readReviewedSources();
  const original = sources.get('index.js');
  const buf = Buffer.concat([original.buf, Buffer.from('\n// synthetic source drift\n')]);
  sources.set('index.js', { buf, bytes: buf.length, sha256: hash(buf) });
  const result = reg.computeArtifacts(sources, reg.validatePlan(plan(), { nowMs: NOW }));
  return { defectObserved: result.artifacts.find(a => a.rel === 'index.js').buf.includes('synthetic source drift'), sourceDiskChanged: false };
});
sample('R2-unmanifested-conflict-overwritten', () => {
  const outId = id(); const dir = path.join(reg.ARTIFACTS_ROOT, 'registration-' + outId);
  fs.mkdirSync(path.join(dir, 'package'), { recursive: true });
  const gate = path.join(dir, 'package/gate.js'); fs.writeFileSync(gate, 'synthetic-existing-conflict');
  const result = reg.buildRegistration(plan(), { outId, nowMs: NOW });
  return { defectObserved: result.ok && fs.readFileSync(gate, 'utf8') !== 'synthetic-existing-conflict', indexCreated: fs.existsSync(path.join(dir, 'package/index.js')) };
});
sample('R2-link-detected-after-writes', () => {
  const outId = id(); const dir = path.join(reg.ARTIFACTS_ROOT, 'registration-' + outId);
  const target = path.join(reg.ARTIFACTS_ROOT, 'registration-' + id());
  fs.mkdirSync(path.join(dir, 'package'), { recursive: true }); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'sentinel'), 'unchanged');
  try { fs.symlinkSync(target, path.join(dir, 'package/vendor'), 'junction'); }
  catch(e) { return { unverified: e.code }; }
  let rejected = false; try { rejected = reg.buildRegistration(plan(), { outId, nowMs: NOW }).ok === false; } catch (_) { rejected = true; }
  return { defectObserved: rejected && fs.existsSync(path.join(dir, 'package/index.js')), rejected,
    junctionTargetUnwritten: fs.readdirSync(target).length === 1 && fs.readFileSync(path.join(target, 'sentinel'), 'utf8') === 'unchanged' };
});
sample('R3-frontend-self-reported-hash', () => {
  const b = built(); const m = readManifest(b); const p = path.join(b.dir, 'package', m.frontendOverride.rel);
  const buf = Buffer.from(fs.readFileSync(p, 'utf8') + '\nmodule.exports = { enabled: true, functionName: "synthetic-wrong-function" };\n');
  fs.writeFileSync(p, buf); m.frontendOverride.sha256 = hash(buf); m.frontendOverride.bytes = buf.length; writeManifest(b, m);
  return { defectObserved: reg.checkRegistration({ outDir: b.dir }).ok };
});
sample('R3-manifest-critical-metadata', () => {
  const b = built(); const m = readManifest(b);
  m.deploymentAuthorized = true; m.cloudExecuted = true; m.effectiveActions = ['createProject'];
  m.reviewedSource = null; m.closedPackage = null; m.differences = []; m.artifacts[0].bytes = -1;
  m.artifacts.push({ rel: 'unlisted.js', bytes: 1, sha256: 'bad' }); writeManifest(b, m);
  return { defectObserved: reg.checkRegistration({ outDir: b.dir }).ok };
});
sample('R3-extra-top-level-file', () => {
  const b = built(); fs.writeFileSync(path.join(b.dir, 'unexpected.txt'), 'synthetic');
  return { defectObserved: reg.checkRegistration({ outDir: b.dir }).ok };
});
sample('R3-incomplete-plan-reuse', () => {
  const outId = id(); const b = reg.buildRegistration(plan(), { outId, nowMs: NOW });
  const p = plan({ windowStartsAt: new Date(NOW + 60000).toISOString(), synthetic: false });
  const reused = reg.buildRegistration(p, { outId, nowMs: NOW });
  return { defectObserved: reused.reused === true && reused.manifest.synthetic === true && reused.manifest.plan.windowStartsAt !== p.windowStartsAt };
});
sample('R4-missing-closed-package-does-not-block', () => {
  const req = createRequire(TOOL); const realExists = fs.existsSync;
  const closed = path.join(reg.ARTIFACTS_ROOT, 'closed-20261005-r2fix');
  const fakeFs = Object.assign({}, fs, { existsSync: p => String(p).startsWith(closed + path.sep) ? false : realExists(p) });
  const mod = { exports: {} }; const customRequire = n => n === 'node:fs' ? fakeFs : req(n);
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(TOOL,'utf8').replace(/^#![^\n]*\n/, '') + '\n})')(customRequire, mod, mod.exports, TOOL, path.dirname(TOOL));
  const result = mod.exports.buildRegistration(plan(), { outId: id(), nowMs: NOW });
  return { defectObserved: result.ok && result.manifest.closedPackage.present === false, historicalClosedPackageChanged: false };
});
sample('R4-missing-closed-frontend-and-dependency-hashes', () => {
  const b = built(); const m = readManifest(b);
  return { defectObserved: !m.frontendClosedOverride && !m.frontendDependencies,
    frontendFileNames: fs.readdirSync(path.join(b.dir, 'package/frontend/config')), manifestKeys: Object.keys(m) };
});
sample('R5-client-test-fallback', () => ({ defectObserved: !fs.existsSync(path.join(ROOT,'miniapp/miniprogram/client/cloud-api.js')),
  actualPageExists: fs.existsSync(path.join(ROOT,'miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js')),
  actualClientExists: fs.existsSync(path.join(ROOT,'miniapp/miniprogram/utils/schedule-sandbox-client.js')) }));

const after = protectedPaths.map(p => hash(fs.readFileSync(p)));
process.stdout.write(JSON.stringify({ runId, observedAt: new Date().toISOString(),
  verificationKind: 'OFFLINE_REAL_BUILDER_WITH_ISOLATED_FILES_AND_SELECTED_MEMORY_FIXTURES',
  networkCalls: 0, credentialFetches: 0, cloudCalls: 0, protectedFilesUnchanged: before.every((h,i)=>h===after[i]),
  wroteSyntheticArtifacts: true, historicalEvidenceOverwritten: false, rows,
  summary: { total: rows.length, defectsObserved: rows.filter(r=>r.defectObserved).length,
    harnessErrors: rows.filter(r=>r.harnessError).length, unverified: rows.filter(r=>r.unverified).length }
}, null, 2) + '\n');
