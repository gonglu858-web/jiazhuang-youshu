'use strict';
// Offline source review + isolated VM sensitivity. Never executes PS1, OS processes,
// network, DPAPI or UI. PS1 observations are STATIC, not PowerShell semantic tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const target = path.join(__dirname, 'CodeBuddy固定Node绑定返修-20261026.cjs');
const psFile = path.join(ROOT, 'miniapp/scripts/participant-private-input.ps1');
const testFile = path.join(ROOT, 'miniapp/tests/participant-self-registration.test.cjs');
const fixedNode = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const cache = new Map([target, psFile, testFile, fixedNode].map(p => [path.resolve(p), fs.readFileSync(p)]));
const source = cache.get(target).toString('utf8');
const ps = cache.get(psFile).toString('utf8');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const lineAt = token => {
  const i = ps.indexOf(token); assert.notEqual(i, -1, token);
  return ps.slice(0, i).split('\n').length;
};
function runVariant(name, injection, late = false) {
  const osCalls = [], fallbackHits = [], stdout = [];
  const stop = Symbol('exit');
  let exitCode = 0;
  function blocked(kind) { fallbackHits.push(kind); throw Error('OFFLINE_FALLBACK'); }
  const fakeCp = {
    spawnSync(exe, args) {
      osCalls.push({exe, args: [...args]});
      if (exe === 'git' && args.join(' ') === 'rev-parse --short=7 HEAD')
        return {status: 0, stdout: '1ca7c81\n', stderr: ''};
      if (exe === 'powershell.exe' && args.includes('-Command'))
        return {status: 0, stdout: Buffer.from('parse-ok\n'), stderr: Buffer.alloc(0)};
      if (exe === 'powershell.exe' && args.includes('-File'))
        return {status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('running scripts is disabled UnauthorizedAccess')};
      return blocked('unexpected-process');
    },
    execSync() { return blocked('public-execSync'); }
  };
  const fakeFs = {readFileSync(p, encoding) {
    const b = cache.get(path.resolve(p));
    if (!b) return blocked('unexpected-file-read');
    return encoding ? b.toString(encoding) : Buffer.from(b);
  }};
  const moduleMap = {
    'node:fs': fakeFs, 'node:path': path, 'node:crypto': crypto,
    'node:child_process': fakeCp, 'node:assert/strict': assert,
    'node:https': {request() { return blocked('https.request'); }}
  };
  const fakeProcess = {argv: ['node', target], exit(code) {exitCode = code; throw stop;}};
  const ctx = {
    __dirname: path.dirname(target), __filename: target, Buffer,
    console: {log(...v) {stdout.push(v.join(' '));}}, process: fakeProcess,
    require(id) {
      if (id === path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'))
        return {decodeNative: b => b.toString('utf8')}; // ASCII fixture only; not decoder validation
      if (Object.hasOwn(moduleMap, id)) return moduleMap[id];
      return blocked('unexpected-require');
    }
  };
  const marker = late ? 'const report = {' : 'const allChecksPass =';
  assert.equal(source.split(marker).length, 2);
  const code = source.replace(marker, injection + '\n' + marker);
  try {vm.runInNewContext(code, ctx, {timeout: 5000, filename: target});}
  catch (e) {if (e !== stop) throw e;}
  const report = JSON.parse(stdout.at(-1));
  return {name, ok: report.ok, exitCode, reported: report.guardAccounting,
    actualStubProcessCalls: osCalls.length,
    processPolicyArgument: osCalls.find(c => c.args.includes('-File')).args.slice(1, 3),
    offlineFallbackHits: fallbackHits};
}
const variants = [
  runVariant('normal', ''),
  runVariant('caughtNetwork', "try { require('node:https').request(); } catch (_) {}"),
  runVariant('caughtPublicProcess', "try { require('node:child_process').execSync('synthetic-denied'); } catch (_) {}"),
  runVariant('lateNetworkAfterVerdict', "try { require('node:https').request(); } catch (_) {}", true)
];
assert.equal(variants[0].actualStubProcessCalls, 3);
assert.equal(variants[0].reported.attempts, 2);
for (const [i, v] of variants.entries()) {
  assert.equal(v.ok, true);
  assert.equal(v.exitCode, 0);
  assert.equal(v.reported.unexpected.length, 0);
  assert.equal(v.offlineFallbackHits.length, i === 0 ? 0 : 1);
}
const hashClose = lineAt('$fs.Dispose()');
const hashCall = lineAt('$binding = Test-FixedNodeBinding');
const holdOpen = lineAt('$handle = & $script:BoundaryOpenHold $binding.NodePath');
const start = lineAt('$proc = & $script:BoundaryStart $psi');
assert.ok(hashCall < holdOpen && holdOpen < start);
const between = ps.slice(ps.indexOf('$handle = & $script:BoundaryOpenHold $binding.NodePath'),
  ps.indexOf('$proc = & $script:BoundaryStart $psi'));
assert.equal(/ComputeHash|Test-FixedNodeBinding|BoundaryProbeNodeDigest/.test(between), false);
const saveBody = ps.slice(ps.indexOf('function Invoke-SaveProtect'), ps.indexOf('function Invoke-SelfTestEcho'));
assert.ok(saveBody.includes("Join-Path $PSScriptRoot 'lib\\participant-private-store.cjs'"));
assert.ok(ps.includes("Add-Check 'fixture-space-path-quoted' ($psi.Arguments.Contains('\"C:\\synthetic package with spaces\\participant-private-store.cjs\"'))"));
assert.equal(/\$PSScriptRoot\s*=/.test(ps), false);
const report = {
  schema: 'codex-fixed-node-review/1', reviewedCommit: '1ca7c81', baseline: '953f20e',
  reproductionAssertionsPassed: true, productAccepted: false,
  kinds: ['static PS1 source trace', 'actual evidence JavaScript in isolated VM with OS/FS stubs'],
  digests: {ps1: hash(cache.get(psFile)), reviewedEvidence: hash(cache.get(target)), self: hash(fs.readFileSync(__filename))},
  staticFindings: {
    hashHandleClosedBeforeSeparateHold: {hashCloseLine: hashClose, bindingCallLine: hashCall, holdOpenLine: holdOpen, startLine: start, noHashUnderHeldHandle: true},
    n6ChecksEchoFixtureWhileCallingSave: {savePathFromPSScriptRoot: true, psScriptRootReassigned: false}
  }, variants,
  boundaries: {actualChildProcesses: 0, actualNetwork: 0, ps1Executed: false, policyQueriedOrChanged: false, privateDataRead: false},
  limitations: ['No PowerShell semantic execution; no file-race experiment.', 'VM raw child-process/decoder outcomes are synthetic; only evidence verdict sensitivity is exercised.']
};
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out' && args[1]));
const text = JSON.stringify(report, null, 2) + '\n';
if (args.length) fs.writeFileSync(path.resolve(args[1]), text, {flag: 'wx'});
else process.stdout.write(text);
