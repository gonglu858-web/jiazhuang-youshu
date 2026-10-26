'use strict';
// Independent review: actual v4 JS, isolated VM and recursive child-JS reentry.
// All OS/network boundaries are synthetic; PS1 is read as text, never evaluated.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const target = path.join(__dirname, 'CodeBuddy固定Node绑定返修v4-20261026.cjs');
const psFile = path.join(ROOT, 'miniapp/scripts/participant-private-input.ps1');
const testFile = path.join(ROOT, 'miniapp/tests/participant-self-registration.test.cjs');
const fixedNode = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const oldFiles = ['CodeBuddy固定Node绑定返修-20261026.cjs', 'CodeBuddy固定Node绑定返修-20261026.json',
  'CodeBuddy固定Node绑定返修v2-20261026.cjs', 'CodeBuddy固定Node绑定返修v2-20261026.json', 'CodeBuddy固定Node绑定返修v3-20261026.cjs', 'CodeBuddy固定Node绑定返修v3-20261026.json'].map(p => path.join(__dirname, p));
const cache = new Map([target, psFile, testFile, fixedNode, ...oldFiles].map(p => [p, fs.readFileSync(p)]));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(cache.get(target)), '3b2d02d7298107a0a3167bfeccdf209c65809bef921354d58a5ad1d33a4530eb');
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
      if (exe === 'git' && args.join(' ') === 'rev-parse --short=7 HEAD') return {status: 0, stdout: 'a980380\n', stderr: ''};
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
  // Inject at the actual Buffer hashing operation; v4 must include this hit in its final verdict.
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
  let code = !fault && injections[name] ? source.replace(marker, injections[name] + '\n' + marker) : source;
  if (!fault && name === 'finalization') {
    const finalMarker = "const latestUnexpected = guard.hits.filter(h => h.class === 'unexpected');";
    assert.equal(source.split(finalMarker).length, 2);
    code = source.replace(finalMarker, "try { require('node:https').request('synthetic.invalid'); } catch (_) {}\n" + finalMarker);
  }
  try { vm.runInContext(code, context, {timeout: 15000, filename: target}); }
  catch (e) { if (e !== stop) throw e; }
  assert.notEqual(exitCode, null);
  const report = JSON.parse(logs.at(-1));
  const actualUnexpected = vm.runInContext("guard.hits.filter(h => h.class === 'unexpected').length", context);
  return {name, exitCode, report, actualUnexpected, injected, fallbackHits, processCalls};
}
const results = ['normal', 'testRead', 'selfRead', 'latePsHash', 'lateHistoryHash', 'finalization'].map(n => execute(n));
results.push(execute('builtInLateAfterVerdict', 'lateAfterVerdict'));
for (const r of results) {
  const fail = r.name !== 'normal';
  assert.equal(r.exitCode, fail ? 1 : 0);
  assert.equal(r.report.exitCode, r.exitCode);
  assert.equal(r.report.ok, !fail);
  assert.equal(r.report.verdict.ok, !fail);
  assert.equal(r.actualUnexpected, fail ? 1 : 0);
  assert.equal(r.report.verdict.guardAccounting.unexpectedHits.length, r.actualUnexpected);
  assert.equal(r.fallbackHits.length, 0);
  assert.equal(r.processCalls, r.name === 'builtInLateAfterVerdict' ? 2 : 13);
  assert.equal(r.report.staticChecks.failed, 0);
  assert.equal(Object.hasOwn(r.report, 'finalOk'), false);
  assert.equal(Object.hasOwn(r.report, 'realExitOk'), false);
  if (r.name !== 'builtInLateAfterVerdict') assert.equal(r.report.faultProofs.filter(f => f.passed).length, 11);
  if (['testRead','selfRead','latePsHash','lateHistoryHash'].includes(r.name)) assert.equal(r.injected, true);
}
const finalPart=source.slice(source.indexOf('const okFinal ='));
assert.equal(/readFileSync|createHash|\bsha\(/.test(finalPart), false);
assert.ok(finalPart.includes('process.exit(okFinal ? 0 : 1)'));
const report={schema:'codex-fixed-node-s1-acceptance/1',reviewedCommit:'a980380',baseline:'0da6af0',
  s1Accepted:true,realExecutionApproved:false,
  results:results.map(r=>({name:r.name,ok:r.report.ok,exitCode:r.exitCode,reportedExitCode:r.report.exitCode,
    actualUnexpected:r.actualUnexpected,reportedUnexpected:r.report.verdict.guardAccounting.unexpectedHits.length,
    independentFallbackHits:r.fallbackHits.length,actualBoundaryInjection:r.injected,syntheticProcessCalls:r.processCalls})),
  sourceFacts:{noReadsOrHashesAfterFinalVerdict:true,oneFinalBooleanFeedsReportAndExit:true},
  digests:{source:sha(cache.get(target)),ps1:sha(cache.get(psFile)),self:sha(fs.readFileSync(__filename))},
  boundaries:{actualNetwork:0,actualOSProcesses:0,ps1Executed:false,privateDataRead:false,policyQueriedOrChanged:false},
  limitations:['Actual v4 JavaScript and recursive child JavaScript; OS/FS/ASCII decoder are synthetic.',
    'Four injections occur inside actual read/hash boundary substitutes, not only built-in pre-operation probes.',
    'Finalization injection is immediately before latest guard snapshot. S2/S3 and product correctness are not re-audited.',
    'Seven PowerShell scenarios, real argv transport, UI, DPAPI and OS file-lock behavior remain unverified.']};
const args=process.argv.slice(2);assert.ok(args.length===0||(args.length===2&&args[0]==='--out'&&args[1]));
const json=JSON.stringify(report,null,2)+'\n';
if(args.length)fs.writeFileSync(path.resolve(args[1]),json,{flag:'wx'});else process.stdout.write(json);
