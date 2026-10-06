'use strict';
// 仅在新建临时目录复现；不修改交付产物/源码，不联网，不删除目录。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const p = require(path.join(root, 'miniapp/scripts/package-sandbox.cjs'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-package-review-'));
const findings = [];
function trial(name, fn) {
  try { findings.push({ name, returned: fn(), threw: false }); }
  catch (e) { findings.push({ name, threw: true, error: e.message }); }
}
function make(name) {
  const out = path.join(tmp, name);
  p.buildPackage({ outDir: out });
  return out;
}
trial('manifest-invalid-json-is-accepted-by-check', () => {
  const out = make('manifest');
  fs.writeFileSync(path.join(out, 'manifest.json'), 'NOT JSON');
  return p.buildPackage({ outDir: out, checkOnly: true }).mode;
});
trial('missing-baseline-is-accepted', () => {
  const result = p.buildPackage({ outDir: path.join(tmp, 'missing-baseline'), baselinePath: path.join(tmp, 'absent.json') });
  return { mode: result.mode, baselineChecked: result.baseline.checked };
});
trial('extra-file-is-accepted-in-generation', () => {
  const out = path.join(tmp, 'extra');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'unexpected.txt'), 'unexpected');
  const result = p.buildPackage({ outDir: out });
  return { mode: result.mode, extraFiles: result.extraFiles };
});
trial('later-conflict-leaves-earlier-new-file', () => {
  const out = path.join(tmp, 'partial');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'gate.js'), 'different');
  let error;
  try { p.buildPackage({ outDir: out }); } catch (e) { error = e.message; }
  return { rejected: !!error, indexCreatedBeforeRejection: fs.existsSync(path.join(out, 'package', 'index.js')) };
});
const candidate = JSON.parse(fs.readFileSync(p.CANDIDATE_PATH, 'utf8'));
for (const [name, mutate] of [
  ['index-field-order-reversed', d => d.indexes.find(i => i.id === 'I04').keys.reverse()],
  ['index-direction-changed', d => d.indexes.find(i => i.id === 'I07').keys[1].direction = 'asc'],
  ['token-unique-removed', d => d.indexes.find(i => i.id === 'I05').unique = false],
  ['index-id-replaced', d => d.indexes[0].id = 'I99'],
  ['runtime-removed', d => delete d.function.runtime],
]) {
  trial(name, () => { const d = structuredClone(candidate); mutate(d); return p.validateCandidateDocument(d, [], name); });
}
trial('out-root-junction', () => {
  const actual = path.join(tmp, 'junction-actual');
  const alias = path.join(tmp, 'junction-out');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias, 'junction');
  const markedLink = fs.lstatSync(alias).isSymbolicLink();
  if (!markedLink) return { linkVerified: false, outcome: 'inconclusive' };
  const result = p.buildPackage({ outDir: alias });
  return { linkVerified: true, mode: result.mode, wroteBehindLink: fs.existsSync(path.join(actual, 'manifest.json')) };
});
const pageSource = fs.readFileSync(path.join(root, 'miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js'), 'utf8');
const actionBlock = pageSource.match(/const ACTIONS = \[([\s\S]*?)\];/)[1];
const baseline = JSON.parse(fs.readFileSync(p.BASELINE_PATH, 'utf8'));
const changed = Object.entries(baseline.files).filter(([name, hash]) => {
  const file = path.join(root, name);
  return !fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash;
}).map(([name]) => name);
const result = {
  date: '2026-10-05', scope: 'local review only; synthetic temporary copies', tmp,
  findings, pageRemoveMemberSelectable: actionBlock.includes("key: 'removeMember'"),
  baselineFiles: Object.keys(baseline.files).length, changed,
  reviewedFiles: ['miniapp/scripts/package-sandbox.cjs', 'miniapp/cloudbase/schedule-sandbox-resources.candidate.json', 'miniapp/tests/sandbox-package.test.cjs', 'docs/独立副本有限测试操作稿-20261005.md', 'artifacts/schedule-sandbox/closed-20261005/manifest.json'].map(name => ({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') })),
};
fs.writeFileSync(path.join(__dirname, '本地制品准备Codex复现-20261005.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
