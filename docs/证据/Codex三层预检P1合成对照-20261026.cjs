'use strict';
// Actual P1 driver in isolated VM. Only OS/FS boundaries are synthetic.
// No real command is available to the test, including metadata queries.
const cp = require('node:child_process'), net = require('node:net');
let fallbackHits = 0;
function offline() { fallbackHits++; throw Error('INDEPENDENT_OFFLINE_BOUNDARY'); }
const cpKeys = Object.keys(cp).filter(k => typeof cp[k] === 'function');
for (const k of cpKeys) cp[k] = offline;
const netIds = ['node:http','node:https','node:tls','node:dgram','node:dns'], networkKeys = {};
for (const id of netIds) {
  const m = require(id); networkKeys[id] = Object.keys(m).filter(k => typeof m[k] === 'function');
  for (const k of networkKeys[id]) Object.defineProperty(m, k, {value: offline, configurable: true});
}
for (const k of Object.keys(require('node:dns').promises)) if (typeof require('node:dns').promises[k] === 'function') require('node:dns').promises[k] = offline;
net.connect = net.createConnection = net.createServer = offline; net.Socket.prototype.connect = offline; globalThis.fetch = offline;
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..'), driver = path.join(__dirname, 'Codex三层预检P1-20261026.cjs');
const outputFile = path.join(__dirname, 'Codex三层预检P1-20261026.json');
const NODE = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const basisFile = path.join(__dirname, 'Codex本机合成预检恢复A-20261025.cjs');
const ps1 = path.join(ROOT, 'miniapp/scripts/participant-private-input.ps1');
const decoder = path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs');
const cache = new Map([driver, basisFile, ps1, decoder, NODE, PS].map(p => [p, fs.readFileSync(p)]));
const source = cache.get(driver).toString('utf8');
const expectedMeta = JSON.parse(cache.get(basisFile).toString('utf8').match(/^const META = (".*");$/m)[1]);
const dirs = new Set();
for (const p of [...cache.keys(), outputFile]) {
  let d = path.dirname(p); while (true) { dirs.add(d); const parent = path.dirname(d); if (parent === d) break; d = parent; }
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const base = () => ({schema: 'psr-local-environment/1', version: '5.1.26100.9711', effectivePolicy: 'RemoteSigned',
  policies: ['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'].map(scope => ({scope, policy: scope === 'CurrentUser' ? 'RemoteSigned' : 'Undefined'})),
  nodeCandidateCount: 4, selectedNodeMatches: false});
const cases = [
  ['normal', null, null], ['firstMatchTrue', v => {v.selectedNodeMatches = true;}, null],
  ['restricted', v => {v.effectivePolicy = 'Restricted'; v.policies.forEach(p => p.policy = 'Undefined');}, 'POLICY_RESTRICTED'],
  ['inheritedBypass', v => {v.effectivePolicy = 'Bypass'; v.policies[2].policy = 'Bypass';}, null],
  ['extra', v => {v.SECRET_SENTINEL = 'SECRET_SENTINEL';}, 'META_KEYS'],
  ['schema', v => {v.schema = 'SECRET_SENTINEL';}, 'META_SCHEMA'],
  ['numericVersion', v => {v.version = 5.1;}, 'META_VERSION'],
  ['versionLong', v => {v.version = '1'.repeat(100);}, 'META_VERSION'],
  ['versionBad', v => {v.version = 'SECRET_SENTINEL';}, 'META_VERSION'],
  ['policyBad', v => {v.effectivePolicy = 'SECRET_SENTINEL';}, 'META_POLICY'],
  ['policyConflict', v => {v.effectivePolicy = 'Bypass';}, 'META_POLICY_CONFLICT'],
  ['firstMatchType', v => {v.selectedNodeMatches = 'false';}, 'META_NODE_MATCH_TYPE'],
  ['countZero', v => {v.nodeCandidateCount = 0;}, 'META_NODE_COUNT'],
  ['countLarge', v => {v.nodeCandidateCount = 65;}, 'META_NODE_COUNT'],
  ['countType', v => {v.nodeCandidateCount = '4';}, 'META_NODE_COUNT'],
  ['scopesMissing', v => {v.policies.pop();}, 'META_SCOPE_COUNT'],
  ['scopesObject', v => {v.policies = {};}, 'META_SCOPE_COUNT'],
  ['scopeDuplicate', v => {v.policies[1].scope = v.policies[0].scope;}, 'META_SCOPE_DUPLICATE'],
  ['scopeUnknown', v => {v.policies[0].scope = 'SECRET_SENTINEL';}, 'META_SCOPE_ROW'],
  ['scopePolicy', v => {v.policies[0].policy = 'SECRET_SENTINEL';}, 'META_SCOPE_ROW'],
  ['scopeExtra', v => {v.policies[0].SECRET_SENTINEL = true;}, 'META_SCOPE_ROW'],
  ['scopeNull', v => {v.policies[0] = null;}, 'META_SCOPE_ROW'],
  ['rootNull', null, 'META_KEYS'], ['utf8', null, 'UTF8_STRICT_FAILED'],
  ['replacement', null, 'UTF8_STRICT_FAILED'], ['json', null, 'JSON_PARSE_FAILED'],
  ['queryExit', null, 'QUERY_FAILED'], ['querySignal', null, 'QUERY_FAILED'],
  ['queryTimeout', null, 'QUERY_TIMEOUT'], ['queryStartThrow', null, 'QUERY_START_FAILED'],
  ['queryBuffer', null, 'QUERY_BUFFER_INVALID'], ['queryStderr', null, 'QUERY_STDERR'],
  ['queryLimit', null, 'QUERY_OUTPUT_LIMIT'], ['queryEnobufs', null, 'QUERY_OUTPUT_LIMIT'],
  ['hostPath', null, 'HOST_PATH_MISMATCH'], ['hostDigest', null, 'HOST_DIGEST_MISMATCH'],
  ['sourceDrift', null, 'SOURCE_DRIFT'], ['decoderDrift', null, 'SOURCE_DRIFT'],
  ['toolLink', null, 'PATH_CHAIN_INVALID'], ['toolMissing', null, 'PREFLIGHT_UNCERTAIN'],
  ['outputExists', null, 'OUTPUT_EXISTS'], ['outputBoundary', null, 'OUTPUT_BOUNDARY'],
  ['earlyHit', null, 'CAPABILITY_BLOCKED'], ['selfDigestHit', null, 'CAPABILITY_BLOCKED'],
  ['psDigestHit', null, 'CAPABILITY_BLOCKED'], ['postSourceDrift', null, 'FINAL_FACTS_UNCERTAIN'],
  ['finalizationHit', null, 'CAPABILITY_BLOCKED'], ['outputRace', null, 'EVIDENCE_WRITE_FAILED'],
  ['normalOut', null, null], ['missingOut', null, 'ARGUMENT_INVALID']
];
const results = [];
for (const [name, mutate, error] of cases) {
  let data = base(); if (mutate) mutate(data); if (name === 'rootNull') data = null;
  let response = Buffer.from(JSON.stringify(data));
  if (name === 'utf8') response = Buffer.from([0xff]);
  if (name === 'replacement') response = Buffer.from('\ufffd');
  if (name === 'json') response = Buffer.from('SECRET_SENTINEL');
  let queryCalls = 0, writes = 0, output = '', didInject = false, saved = null;
  const reads = new Map(), modules = {};
  for (const id of netIds) modules[id] = Object.fromEntries(networkKeys[id].map(k => [k, offline]));
  modules['node:dns'].promises = {lookup: offline};
  function Socket() {} Socket.prototype.connect = offline;
  modules['node:net'] = {Socket, connect: offline, createConnection: offline, createServer: offline};
  function inject() { didInject = true; try { modules['node:https'].request('synthetic'); } catch (_) {} }
  const fc = Object.fromEntries(cpKeys.map(k => [k, offline]));
  fc.spawnSync = (exe, args, opts) => {
    queryCalls++; assert.equal(queryCalls, 1);
    assert.equal(exe, PS); assert.deepEqual(Array.from(args), ['-NoProfile','-NonInteractive','-Command',expectedMeta]);
    assert.equal(opts.cwd, ROOT); assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
    assert.equal(opts.encoding, undefined); assert.equal(opts.env.NODE_OPTIONS, undefined);
    assert.equal(opts.env.SYNTHETIC_ALLOWED, '1'); assert.equal(opts.env.PSExecutionPolicyPreference, undefined);
    assert.ok(opts.timeout > 0 && opts.timeout <= 10000); assert.equal(opts.maxBuffer, 128 * 1024);
    if (name === 'queryStartThrow') throw Error('SECRET_SENTINEL');
    return {status: name === 'queryExit' ? 1 : 0, signal: name === 'querySignal' ? 'SIGTERM' : null,
      error: name === 'queryTimeout' ? {code: 'ETIMEDOUT'} : name === 'queryEnobufs' ? {code: 'ENOBUFS'} : undefined,
      stdout: name === 'queryBuffer' ? 'SECRET_SENTINEL' : name === 'queryLimit' ? Buffer.alloc(128 * 1024 + 1) : Buffer.from(response),
      stderr: name === 'queryStderr' ? Buffer.from('SECRET_SENTINEL') : Buffer.alloc(0)};
  };
  const fakeFs = {
    lstatSync(p) {
      p = path.resolve(p);
      if (p === outputFile) { if (name !== 'outputExists') throw Object.assign(Error('absent'), {code: 'ENOENT'}); }
      else assert.ok(cache.has(p) || dirs.has(p), p);
      if (name === 'toolMissing' && p === PS) throw Object.assign(Error('SECRET_SENTINEL'), {code: 'ENOENT'});
      return {isFile: () => cache.has(p) || p === outputFile, isDirectory: () => dirs.has(p), isSymbolicLink: () => name === 'toolLink' && p === NODE};
    },
    readFileSync(p) {
      p = path.resolve(p); assert.ok(cache.has(p), p); reads.set(p, (reads.get(p) || 0) + 1);
      if (!didInject && ((name === 'earlyHit' && p === NODE) || (name === 'selfDigestHit' && p === driver))) inject();
      let b = cache.get(p);
      if ((name === 'sourceDrift' && p === ps1) || (name === 'decoderDrift' && p === decoder)
          || (name === 'postSourceDrift' && p === ps1 && reads.get(p) === 2)) b = Buffer.concat([b, Buffer.from('//synthetic-drift')]);
      if (name === 'hostDigest' && p === NODE) b = Buffer.from('synthetic-drift');
      return b;
    },
    writeFileSync(p, bytes, opts) {
      writes++; assert.equal(path.resolve(p), outputFile); assert.equal(opts.flag, 'wx');
      if (name === 'outputRace') throw Object.assign(Error('exists'), {code: 'EEXIST'});
      saved = bytes;
    }
  };
  const fakeCrypto = {createHash(kind) {
    const h = crypto.createHash(kind); const wrapper = {update(b) {
      if (!didInject && name === 'psDigestHit' && b === cache.get(ps1)) inject();
      h.update(b); return wrapper;
    }, digest(enc) {return h.digest(enc);}}; return wrapper;
  }};
  const argv = [NODE, driver];
  if (['outputExists','outputRace','normalOut'].includes(name)) argv.push('--out', outputFile);
  if (name === 'outputBoundary') argv.push('--out', path.join(__dirname, 'not-approved.json'));
  if (name === 'missingOut') argv.push('--out');
  const proc = {argv, execPath: name === 'hostPath' ? 'C:\\synthetic\\node.exe' : NODE,
    env: {SYNTHETIC_ALLOWED: '1', NODE_OPTIONS: 'synthetic-to-remove'}, stdout: {write(s) {output += s;}}, exitCode: null};
  const req = id => {
    if (id === 'node:fs') return fakeFs; if (id === 'node:child_process') return fc;
    if (id === 'node:crypto') return fakeCrypto;
    if (modules[id]) return modules[id];
    if (id === 'node:path') return path; if (id === 'node:vm') return vm;
    return offline();
  };
  let code = source;
  if (name === 'finalizationHit') code = source.replace('if (state.unexpected) failure =', "try { require('node:https').request('synthetic'); } catch (_) {}\n  if (state.unexpected) failure =");
  vm.runInNewContext(code, {require: req, __dirname, __filename: driver, Buffer, TextDecoder, process: proc}, {timeout: 10000, filename: driver});
  const r = JSON.parse(output), pass = error === null;
  assert.equal(r.ok, pass, name); assert.equal(r.exitCode, proc.exitCode, name);
  const fault = ['earlyHit','selfDigestHit','psDigestHit','finalizationHit','postSourceDrift','outputRace'].includes(name);
  assert.equal(r.exitCode, pass ? 0 : fault ? 1 : 2, name);
  if (error) assert.equal(r.failure.code, error, name);
  const zeroQuery = ['hostPath','hostDigest','sourceDrift','decoderDrift','toolLink','toolMissing','outputExists','outputBoundary','missingOut','earlyHit','psDigestHit'].includes(name);
  assert.equal(queryCalls, zeroQuery ? 0 : 1, name);
  assert.equal(writes, ['outputRace','normalOut'].includes(name) ? 1 : 0, name);
  assert.equal(saved, name === 'normalOut' ? output : null);
  if (name !== 'outputRace') {
    assert.equal(r.fullPreflightPassed, false); assert.equal(r.realInputApproved, false);
    for (const p of ['L1','L2','P4','DPAPI','UI']) assert.equal(r.phases[p], 'not-run');
    assert.equal(r.observations.unexpected, ['earlyHit','selfDigestHit','psDigestHit','finalizationHit'].includes(name) ? 1 : 0);
    if (pass) {assert.equal(r.metadata.firstMatchUsedAsApproval, false); assert.equal(r.dynamicReadiness, 'pending-policy-and-file-review');}
  }
  assert.equal(output.includes('SECRET_SENTINEL'), false, name);
  assert.equal(output.includes(NODE), false, name); assert.equal(output.includes('SYNTHETIC_ALLOWED'), false, name);
  results.push({name, expectationMet: true, ok: r.ok, exitCode: r.exitCode, queryCalls, writes, error: r.failure?.code || null});
}
assert.equal(fallbackHits, 0);
const report = {schema: 'codex-three-layer-p1-synthetic/1', basisCommit: 'baefb4d',
  driverSha256: sha(cache.get(driver)), testSha256: sha(fs.readFileSync(__filename)), checks: results.length,
  results, fallbackHits, ok: true, actualOSProcesses: 0, actualNetwork: 0,
  limitations: ['Actual driver and pinned decoder; OS/FS boundaries synthetic, no real environment query.',
    'Only P1 capabilities tested; no PS1 dynamic execution, launch-tree cleanup, identity/ACL, UI or DPAPI tests.']};
const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out'));
const json = JSON.stringify(report, null, 2) + '\n';
if (args.length) {
  const p = path.resolve(args[1]); assert.equal(p, path.join(__dirname, 'Codex三层预检P1合成对照-20261026.json'));
  fs.writeFileSync(p, json, {flag: 'wx'});
}
process.stdout.write(JSON.stringify({ok: true, checks: results.length, fallbackHits, driverSha256: report.driverSha256}) + '\n');
