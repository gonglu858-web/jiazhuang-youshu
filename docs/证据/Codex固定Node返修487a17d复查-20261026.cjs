'use strict';
// Review only: static PS1 source facts and actual v2 evidence JS in isolated VM.
// No PS1 evaluation, OS process, network, private-data or policy access here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const target = path.join(__dirname, 'CodeBuddy固定Node绑定返修v2-20261026.cjs');
const psFile = path.join(ROOT, 'miniapp/scripts/participant-private-input.ps1');
const testFile = path.join(ROOT, 'miniapp/tests/participant-self-registration.test.cjs');
const fixedNode = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const inputs = [target, psFile, testFile, fixedNode,
  path.join(__dirname, 'CodeBuddy固定Node绑定返修-20261026.cjs'),
  path.join(__dirname, 'CodeBuddy固定Node绑定返修-20261026.json')];
const cache = new Map(inputs.map(p => [path.resolve(p), fs.readFileSync(p)]));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(cache.get(target)), 'f5bd8868a2ace7ae606bd7e20b112a7c5597ee05eeb4116fcad91ceecbfd412a');
assert.equal(sha(cache.get(psFile)), 'ddeb479aac72b71a393abf32ef6c7c10e8541c883b7b0709a992d6c4cc72e84c');
const source = cache.get(target).toString('utf8');
const ps = cache.get(psFile).toString('utf8');
const injections = {
  coveredHttps: "try { require('node:https').request('synthetic.invalid'); } catch (_) {}",
  socket: "try { new (require('node:net').Socket)().connect('synthetic-denied'); } catch (_) {}",
  dnsPromises: "try { require('node:dns').promises.lookup('synthetic.invalid'); } catch (_) {}",
  fetch: "try { fetch('https://synthetic.invalid'); } catch (_) {}"
};
function execute(name, fault = null) {
  const calls = [], fallbackHits = [], logs = [], reads = new Map();
  let exitCode = null, lateInjected = false;
  const stop = Symbol('exit');
  function fallback(kind) { fallbackHits.push(kind); throw Error('OFFLINE_FALLBACK'); }
  const modules = {};
  const fakeCp = {
    spawnSync(exe, args) {
      calls.push({exe, args: [...args]});
      if (exe === 'git' && args.join(' ') === 'rev-parse --short=7 HEAD') return {status: 0, stdout: '487a17d\n', stderr: ''};
      if (exe === 'powershell.exe' && args.length === 3 && args[1] === '-Command')
        return {status: 0, stdout: Buffer.from('parse-ok\n'), stderr: Buffer.alloc(0)};
      if (exe === fixedNode && args[0] === target && args[1] === '--fault' && args.length === 3 && !fault) {
        // The actual child JS is re-entered in its own isolated VM, not canned JSON.
        const child = execute('child', args[2]);
        assert.equal(child.fallbackHits.length, 0);
        return {status: child.exitCode, stdout: JSON.stringify(child.report), stderr: ''};
      }
      return fallback('unapproved-process');
    },
    execSync() { return fallback('public-execSync'); },
    spawn() { return fallback('public-spawn'); },
    exec() { return fallback('public-exec'); },
    fork() { return fallback('public-fork'); }
  };
  function Socket() {}
  Socket.prototype.connect = function () { return fallback('Socket.prototype.connect'); };
  const stub = label => () => fallback(label);
  modules['node:net'] = {Socket, connect: stub('net.connect'), createConnection: stub('net.createConnection'), createServer: stub('net.createServer')};
  modules['node:http'] = {request: stub('http.request'), get: stub('http.get')};
  modules['node:https'] = {request: stub('https.request'), get: stub('https.get')};
  modules['node:tls'] = {connect: stub('tls.connect'), createServer: stub('tls.createServer')};
  modules['node:dgram'] = {createSocket: stub('dgram.createSocket')};
  modules['node:dns'] = {lookup: stub('dns.lookup'), resolve: stub('dns.resolve'), resolve4: stub('dns.resolve4'), resolve6: stub('dns.resolve6'), promises: {lookup: stub('dns.promises.lookup')}};
  const fakeFs = {readFileSync(p, encoding) {
    const key = path.resolve(p), b = cache.get(key);
    if (!b) return fallback('unapproved-file-read');
    reads.set(key, (reads.get(key) || 0) + 1);
    const hit = !fault && !lateInjected && ((name === 'lateTestDigest' && key === testFile)
      || (name === 'lateSelfDigest' && key === target && reads.get(key) === 2));
    if (hit) {
      lateInjected = true;
      // Use evidence's installed https guard. Its hit must affect final verdict.
      try {modules['node:https'].request('synthetic.invalid');} catch (_) {}
    }
    return encoding ? b.toString(encoding) : b;
  }};
  Object.assign(modules, {'node:child_process': fakeCp, 'node:fs': fakeFs, 'node:path': path, 'node:crypto': crypto});
  const context = vm.createContext({
    __dirname: path.dirname(target), __filename: target, Buffer,
    fetch: stub('fetch'),
    process: {argv: [fixedNode, target, ...(fault ? ['--fault', fault] : [])], execPath: fixedNode, exit(code) {exitCode = code; throw stop;}},
    console: {log(v) {logs.push(v);}},
    require(id) {
      if (id === path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'))
        return {decodeNative: b => b.toString('utf8')}; // ASCII fixture only, no decoder claim
      if (Object.hasOwn(modules, id)) return modules[id];
      return fallback('unapproved-require');
    }
  });
  const marker = 'const staticAllPass = staticChecks.every(c => c.passed);';
  assert.equal(source.split(marker).length, 2);
  const code = !fault && injections[name] ? source.replace(marker, injections[name] + '\n' + marker) : source;
  try {vm.runInContext(code, context, {timeout: 15000, filename: target});}
  catch (e) {if (e !== stop) throw e;}
  assert.notEqual(exitCode, null);
  const report = JSON.parse(logs.at(-1));
  const actualUnexpected = vm.runInContext("guard.hits.filter(h => h.class === 'unexpected').length", context);
  return {name, exitCode, report, actualUnexpected, fallbackHits, lateInjected, stubProcessCalls: calls.length};
}
const names = ['normal', 'coveredHttps', 'socket', 'dnsPromises', 'fetch', 'lateTestDigest', 'lateSelfDigest'];
const results = names.map(name => execute(name));
for (const r of results) {
  assert.equal(r.report.staticChecks.failed, 0);
  assert.equal(r.report.faultProofs.length, 4);
  assert.equal(r.report.faultProofs.every(f => f.passed), true);
  assert.equal(r.stubProcessCalls, 6);
  const covered = r.name === 'coveredHttps', late = r.name.startsWith('late');
  assert.equal(r.exitCode, covered ? 1 : 0);
  assert.equal(r.report.finalOk, !covered);
  assert.equal(r.actualUnexpected, covered || late ? 1 : 0);
  assert.equal(r.report.postVerdictUnexpected, covered ? 1 : 0);
  assert.equal(r.fallbackHits.length, ['socket', 'dnsPromises', 'fetch'].includes(r.name) ? 1 : 0);
  assert.equal(r.lateInjected, late);
}
// Static PS1 facts only. Do not execute/translate PS1 as a substitute for allowed -File tests.
const startBody = ps.slice(ps.indexOf('function Start-FixedNode('), ps.indexOf('function Invoke-SaveProtect('));
assert.ok(startBody.indexOf('BoundaryOpenHold') < startBody.indexOf('BoundaryProbeNodeDigestFromHold'));
assert.ok(startBody.indexOf('BoundaryProbeNodeDigestFromHold') < startBody.indexOf('BoundaryStart'));
assert.equal(startBody.includes('Test-FixedNodeBinding'), false);
assert.match(ps, /ComputeHash\(\$holdStream\)/);
const saveBody = ps.slice(ps.indexOf('function Invoke-SaveProtect('), ps.indexOf('function Invoke-SelfTestEcho'));
assert.ok(saveBody.includes("return @{ Ok = $true; Stdout = $stdout; ExitCode = $proc.ExitCode; Label = '' }"));
assert.equal(saveBody.includes('Started ='), false);
assert.ok(ps.includes("Add-Check 'replace-attempt-denied-start-ok' ($r3.Started -and $r3.Ok)"));
const resultArray = ps.match(/\$result = @\(([^]*?)\)\r?\n  if \(\$ServerTimeIso\)/)[1];
const baseCount = resultArray.split(',').length;
assert.equal(baseCount, 18);
assert.ok(ps.includes("$ServerTimeIso = 'synthetic-2026-10-26T00:00:00Z'"));
assert.ok(ps.includes("$expectedEchoArgv = @('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))') + @(Get-StoreArguments $fixtureScript)"));
assert.ok(ps.includes('$expectedEchoArgv.Count -eq 20'));
const report = {
  schema: 'codex-fixed-node-repair-review/1', reviewedCommit: '487a17d', baseline: 'e918835',
  reproductionAssertionsPassed: true, fullAcceptance: false,
  kinds: ['static PS1 source/dataflow review', 'actual v2 evidence JS with recursive child-JS VM reentry; all OS/FS boundaries synthetic'],
  digests: {ps1: sha(cache.get(psFile)), reviewedEvidence: sha(cache.get(target)), self: sha(fs.readFileSync(__filename))},
  staticFacts: {r1HoldDigestStartSequenceCorrect: true, n4ReadsMissingStartedField: true,
    n6BaseArgCount: baseCount, serverTimePairCount: 2, nodeEvalPrefixCount: 2, n6ActualTotal: baseCount + 2 + 2, n6AssertedTotal: 20},
  results: results.map(r => ({name: r.name, exitCode: r.exitCode, finalOk: r.report.finalOk,
    actualUnexpected: r.actualUnexpected, reportedUnexpected: r.report.postVerdictUnexpected,
    fallbackHits: r.fallbackHits, lateInjected: r.lateInjected, staticPassed: r.report.staticChecks.total,
    builtInFaultsPassed: r.report.faultProofs.filter(f => f.passed).length, stubProcessCalls: r.stubProcessCalls})),
  boundaries: {ps1Executed: false, actualChildProcesses: 0, actualNetwork: 0, policyQueriedOrChanged: false, privateDataRead: false},
  limitations: ['PS1 arithmetic/dataflow conclusions are static, not seven-scenario execution.', 'Socket/DNS/fetch fallback throws are synthetic and no real IO occurred.', 'Actual normal v2 rerun and regression totals are documented separately in review.']
};
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out' && args[1]));
const output = JSON.stringify(report, null, 2) + '\n';
if (args.length) fs.writeFileSync(path.resolve(args[1]), output, {flag: 'wx'});
else process.stdout.write(output);
