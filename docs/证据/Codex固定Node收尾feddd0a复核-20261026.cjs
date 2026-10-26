'use strict';
// Independent review: actual v3 JS, isolated VM and recursive child-JS reentry.
// All OS/network boundaries are synthetic; PS1 is read as text, never evaluated.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const target = path.join(__dirname, 'CodeBuddy固定Node绑定返修v3-20261026.cjs');
const psFile = path.join(ROOT, 'miniapp/scripts/participant-private-input.ps1');
const testFile = path.join(ROOT, 'miniapp/tests/participant-self-registration.test.cjs');
const fixedNode = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const oldFiles = ['CodeBuddy固定Node绑定返修-20261026.cjs', 'CodeBuddy固定Node绑定返修-20261026.json',
  'CodeBuddy固定Node绑定返修v2-20261026.cjs', 'CodeBuddy固定Node绑定返修v2-20261026.json'].map(p => path.join(__dirname, p));
const cache = new Map([target, psFile, testFile, fixedNode, ...oldFiles].map(p => [p, fs.readFileSync(p)]));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(cache.get(target)), 'c7c4bf4cb07a7aeab23a4409a72377cd435bdea14baafff16a970e615bfcd478');
assert.equal(sha(cache.get(psFile)), '9255adb762cd19801805ee19c04204dd8f8a3b384d8fc857ff36d44466db0790');
const source = cache.get(target).toString('utf8');
const injections = {
  socket: "try { new (require('node:net').Socket)().connect('synthetic-denied'); } catch (_) {}",
  dnsPromises: "try { require('node:dns').promises.lookup('synthetic.invalid').catch(() => {}); } catch (_) {}",
  fetch: "try { fetch('https://synthetic.invalid').catch(() => {}); } catch (_) {}"
};
function execute(name, fault = null) {
  const fallbackHits = [], logs = [], reads = new Map(), modules = {};
  let exitCode = null, injected = false, processCalls = 0;
  const stop = Symbol('exit');
  function fallback(kind) { fallbackHits.push(kind); throw Error('INDEPENDENT_OFFLINE_FALLBACK'); }
  const stub = kind => () => fallback(kind);
  const cp = {
    spawnSync(exe, args) {
      processCalls++;
      if (exe === 'git' && args.join(' ') === 'rev-parse --short=7 HEAD') return {status: 0, stdout: 'feddd0a\n', stderr: ''};
      if (exe === 'powershell.exe' && args.length === 3 && args[0] === '-NoProfile' && args[1] === '-Command'
          && args[2].includes('Parser]::ParseFile')) return {status: 0, stdout: Buffer.from('parse-ok\n'), stderr: Buffer.alloc(0)};
      if (!fault && exe === fixedNode && args.length === 3 && args[0] === target && args[1] === '--fault') {
        const child = execute('child', args[2]);
        assert.equal(child.fallbackHits.length, 0);
        return {status: child.exitCode, stdout: JSON.stringify(child.report), stderr: ''};
      }
      return fallback('unapproved-process');
    },
    execSync: stub('execSync'), spawn: stub('spawn'), exec: stub('exec'), fork: stub('fork')
  };
  function Socket() {}
  Socket.prototype.connect = stub('Socket.prototype.connect');
  modules['node:net'] = {Socket, connect: stub('net.connect'), createConnection: stub('net.createConnection'), createServer: stub('net.createServer')};
  modules['node:http'] = {request: stub('http.request'), get: stub('http.get')};
  modules['node:https'] = {request: stub('https.request'), get: stub('https.get')};
  modules['node:tls'] = {connect: stub('tls.connect'), createServer: stub('tls.createServer')};
  modules['node:dgram'] = {createSocket: stub('dgram.createSocket')};
  modules['node:dns'] = {lookup: stub('dns.lookup'), resolve: stub('dns.resolve'), resolve4: stub('dns.resolve4'), resolve6: stub('dns.resolve6'), promises: {lookup: stub('dns.promises.lookup')}};
  function caughtHit() { injected = true; try { modules['node:https'].request('synthetic.invalid'); } catch (_) {} }
  const fakeFs = {readFileSync(p, encoding) {
    const key = path.resolve(p), b = cache.get(key);
    if (!b) return fallback('unapproved-read');
    reads.set(key, (reads.get(key) || 0) + 1);
    if (!fault && !injected && ((name === 'testRead' && key === testFile)
        || (name === 'selfRead' && key === target && reads.get(key) === 2))) caughtHit();
    return encoding ? b.toString(encoding) : b;
  }};
  // Delegate hashing unchanged, inject only at the actual report digest update.
  // These buffers are not hashed earlier by v3; this is after realExitOk freezes.
  const fakeCrypto = {createHash(algorithm) {
    const h = crypto.createHash(algorithm);
    const wrapped = {update(value) {
      if (!fault && !injected && ((name === 'latePsHash' && value === cache.get(psFile))
          || (name === 'lateHistoryHash' && value === cache.get(oldFiles[3])))) caughtHit();
      h.update(value); return wrapped;
    }, digest(encoding) { return h.digest(encoding); }};
    return wrapped;
  }};
  Object.assign(modules, {'node:child_process': cp, 'node:fs': fakeFs, 'node:path': path, 'node:crypto': fakeCrypto});
  const context = vm.createContext({__dirname, __filename: target, Buffer, fetch: stub('fetch'),
    process: {argv: [fixedNode, target, ...(fault ? ['--fault', fault] : [])], execPath: fixedNode, exit(code) { exitCode = code; throw stop; }},
    console: {log(value) { logs.push(value); }},
    require(id) {
      if (id === path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs')) return {decodeNative: b => b.toString('utf8')};
      if (Object.hasOwn(modules, id)) return modules[id];
      return fallback('unapproved-require');
    }
  });
  const marker = 'const staticAllPass = staticChecks.every(c => c.passed);';
  assert.equal(source.split(marker).length, 2);
  const code = !fault && injections[name] ? source.replace(marker, injections[name] + '\n' + marker) : source;
  try { vm.runInContext(code, context, {timeout: 15000, filename: target}); }
  catch (e) { if (e !== stop) throw e; }
  assert.notEqual(exitCode, null);
  const report = JSON.parse(logs.at(-1));
  const actualUnexpected = vm.runInContext("guard.hits.filter(h => h.class === 'unexpected').length", context);
  return {name, exitCode, report, actualUnexpected, injected, fallbackHits, processCalls};
}
const results = ['normal', 'testRead', 'selfRead', 'socket', 'dnsPromises', 'fetch', 'latePsHash', 'lateHistoryHash'].map(n => execute(n));
for (const r of results) {
  const late = r.name === 'latePsHash' || r.name === 'lateHistoryHash';
  const shouldFail = r.name !== 'normal' && !late;
  assert.equal(r.exitCode, shouldFail ? 1 : 0);
  assert.equal(r.report.finalOk, !shouldFail);
  assert.equal(r.report.realExitOk, !shouldFail);
  assert.equal(r.actualUnexpected, r.name === 'normal' ? 0 : 1);
  assert.equal(r.report.verdict.guardAccounting.unexpectedHits.length, shouldFail ? 1 : 0);
  assert.equal(r.report.hitsAfterFinalOk, shouldFail ? 1 : 0);
  assert.equal(r.fallbackHits.length, 0);
  assert.equal(r.processCalls, 11);
  assert.equal(r.report.staticChecks.failed, 0);
  assert.equal(r.report.faultProofs.filter(f => f.passed).length, 9);
}
const frozenFault = execute('builtInLateAfterVerdict', 'lateAfterVerdict');
assert.equal(frozenFault.exitCode, 1);
assert.equal(frozenFault.report.finalOk, true);
assert.equal(frozenFault.report.realExitOk, false);
assert.equal(frozenFault.actualUnexpected, 1);
assert.equal(frozenFault.fallbackHits.length, 0);
const ps = cache.get(psFile).toString('utf8');
const n4 = ps.slice(ps.indexOf("'N4_DRIFT'"), ps.indexOf("'N5_STARTFAIL'"));
// Select actual N4 text directly if switch label formatting differs.
assert.ok(ps.includes("Add-Check 'replace-attempt-denied-start-ok' ($r3.Ok -and $r3.ExitCode -eq 0"));
assert.equal(ps.includes('$r3.Started'), false);
assert.ok(ps.includes('$expectedEchoArgv.Count -eq 22'));
assert.ok(ps.includes('$expectedEchoRecvArgv.Count -eq 20'));
assert.equal(ps.includes('$expectedEchoArgv.Count -eq 20'), false);
const output = {
  schema: 'codex-fixed-node-finalization-review/1', reviewedCommit: 'feddd0a', baseline: 'e9a3e75',
  reproductionAssertionsPassed: true, fullAcceptance: false,
  results: [...results, frozenFault].map(r => ({name: r.name, exitCode: r.exitCode,
    finalOk: r.report.finalOk, realExitOk: r.report.realExitOk, actualUnexpected: r.actualUnexpected,
    reportedUnexpected: r.report.verdict.guardAccounting.unexpectedHits.length,
    hitsAfterFinalOk: r.report.hitsAfterFinalOk, injected: r.injected, independentFallbackHits: r.fallbackHits.length,
    staticPassed: r.report.staticChecks.total, processCallsSynthetic: r.processCalls})),
  staticFacts: {n4UsesOkExitCodeInsteadOfMissingStarted: true, n6Launch22Receive20: true, ps1NotExecuted: true},
  digests: {source: sha(cache.get(target)), ps1: sha(cache.get(psFile)), self: sha(fs.readFileSync(__filename))},
  boundaries: {realOSProcesses: 0, realNetwork: 0, privateDataRead: false, policyQueriedOrChanged: false},
  limitations: ['Actual v3 JS with synthetic FS/OS/ASCII decoder; child JS is recursively executed, not canned verdicts.',
    'Hash injection delegates real SHA256 unchanged and adds one caught guard hit at actual update; no production source change.',
    'S3 is static source verification, not PowerShell runtime, OS lock, DPAPI or argv transport validation.']
};
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out' && args[1]));
const json = JSON.stringify(output, null, 2) + '\n';
if (args.length) fs.writeFileSync(path.resolve(args[1]), json, {flag: 'wx'});
else process.stdout.write(json);
