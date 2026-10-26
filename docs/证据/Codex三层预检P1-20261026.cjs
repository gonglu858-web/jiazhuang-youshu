'use strict';
// P1 only: fixed host/source checks and one metadata query. No -File, UI,
// DPAPI, identity, ACL, private-directory access, or subsequent phase runner.
const cp = require('node:child_process');
const state = {probes: 0, unexpected: 0, attempts: []};
let probing = false, phase = 'initialization', used = false;
const invokeOnce = (() => {
  const spawn = cp.spawnSync.bind(cp);
  return () => {
    if (used) deny();
    used = true;
    const remaining = 60000 - (Date.now() - started);
    need(remaining > 0, 'BUDGET_EXHAUSTED');
    const env = {...process.env}; delete env.NODE_OPTIONS;
    const a = {attempted: true, completed: false, failed: false, status: null,
      signal: false, launchError: false, stdoutBytes: null, stderrBytes: null,
      timeoutMs: Math.min(10000, remaining)};
    state.attempts.push(a);
    let r;
    try {
      r = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', meta],
        {cwd: ROOT, shell: false, windowsHide: true, env, timeout: a.timeoutMs, maxBuffer: LIMIT});
    } catch (_) { a.completed = true; a.failed = true; a.launchError = true; fail('QUERY_START_FAILED'); }
    a.completed = true; a.status = Number.isInteger(r?.status) ? r.status : null;
    a.signal = !!r?.signal; a.launchError = !!r?.error;
    a.stdoutBytes = Buffer.isBuffer(r?.stdout) ? r.stdout.length : null;
    a.stderrBytes = Buffer.isBuffer(r?.stderr) ? r.stderr.length : null;
    let reason = null;
    if (r?.error?.code === 'ETIMEDOUT') reason = 'QUERY_TIMEOUT';
    else if (r?.error?.code === 'ENOBUFS') reason = 'QUERY_OUTPUT_LIMIT';
    else if (!r || r.error || r.signal || r.status !== 0) reason = 'QUERY_FAILED';
    else if (!Buffer.isBuffer(r.stdout) || !Buffer.isBuffer(r.stderr)) reason = 'QUERY_BUFFER_INVALID';
    else if (r.stdout.length > LIMIT || r.stderr.length > LIMIT) reason = 'QUERY_OUTPUT_LIMIT';
    else if (r.stderr.length !== 0) reason = 'QUERY_STDERR';
    if (reason) {
      a.failed = true;
      if (Buffer.isBuffer(r?.stdout)) r.stdout.fill(0);
      if (Buffer.isBuffer(r?.stderr)) r.stderr.fill(0);
      fail(reason);
    }
    return r.stdout;
  };
})();
function fail(code) { throw Object.assign(new Error(code), {code}); }
function need(ok, code) { if (!ok) fail(code); }
function deny() { if (probing) state.probes++; else state.unexpected++; fail('CAPABILITY_BLOCKED'); }
// Install before source reads or decoder load. No original network references retained.
for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = deny;
for (const id of ['node:http', 'node:https', 'node:tls', 'node:dgram', 'node:dns']) {
  const m = require(id);
  for (const k of Object.keys(m)) if (typeof m[k] === 'function') Object.defineProperty(m, k, {value: deny, configurable: true});
}
for (const k of Object.keys(require('node:dns').promises))
  if (typeof require('node:dns').promises[k] === 'function') require('node:dns').promises[k] = deny;
const net = require('node:net');
net.connect = net.createConnection = net.createServer = deny;
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const NODE = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const NODE_SHA = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const BASIS = 'docs/证据/Codex本机合成预检恢复A-20261025.cjs';
const DECODER = 'miniapp/scripts/lib/participant-native-decoder.cjs';
const PS1 = 'miniapp/scripts/participant-private-input.ps1';
const PINNED = Object.freeze({
  [BASIS]: '629f1170ad0a2e2ea09f7059ed564488032439db0cdb6f4cee5cd96fb18f01f7',
  [DECODER]: '462976b3cf32999fb0079d6b0bbb4cf54cd35ab3d1068fb1052db36f4c05f7d3',
  [PS1]: '9255adb762cd19801805ee19c04204dd8f8a3b384d8fc857ff36d44466db0790'
});
const META_SHA = 'ea2b88407edd8f0e32e700b14390c2ad36995e6a5ba6e073dd378d818e6f1350';
const POLICY = ['Undefined', 'Restricted', 'AllSigned', 'RemoteSigned', 'Unrestricted', 'Bypass', 'Default'];
const SCOPES = ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine'];
const LIMIT = 128 * 1024, started = Date.now();
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
let meta = null, decoder = null, output = null, raw = null, sources = {}, failure = null;
const report = {schema: 'codex-three-layer-p1/1', basisCommit: 'c224b0e', planCommit: 'baefb4d',
  recordedAt: new Date().toISOString(), sourceFacts: [], host: null, fixedBinding: null,
  metadata: null, queryCompleted: false, metadataValidated: false,
  phases: {H: 'not-run', F: 'not-run', P1: 'not-run', L1: 'not-run', L2: 'not-run', P4: 'not-run', DPAPI: 'not-run', UI: 'not-run'},
  dynamicReadiness: 'not-assessed', fullPreflightPassed: false, realInputApproved: false,
  observations: state, failure: null,
  limitations: ['P1 only; PATH-first-match is an observation, not proof of the fixed launch boundary.',
    'Old NODE_FIRST_MATCH gate and failed records are unchanged; H/F do not pass L.',
    'Parent Node guards are not an OS sandbox for PowerShell; only the pinned metadata command is permitted.',
    'No policy changes, -File attempt, identity/ACL/private data access, UI, DPAPI or cloud operations.']};
function chain(file, isFile) {
  const full = path.resolve(file), root = path.parse(full).root;
  let current = root;
  const pieces = full.slice(root.length).split(path.sep).filter(Boolean);
  const rootStat = fs.lstatSync(root);
  need(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'PATH_CHAIN_INVALID');
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]); const st = fs.lstatSync(current);
    need(!st.isSymbolicLink(), 'PATH_CHAIN_INVALID');
    need(i === pieces.length - 1 && isFile ? st.isFile() : st.isDirectory(), 'PATH_TYPE_INVALID');
  }
}
function checkSources(cache) {
  for (const [rel, expected] of Object.entries(PINNED)) {
    chain(path.join(ROOT, rel), true);
    const b = fs.readFileSync(path.join(ROOT, rel));
    need(hash(b) === expected, 'SOURCE_DRIFT');
    if (cache) { sources[rel] = b; report.sourceFacts.push({rel, bytes: b.length, sha256: expected}); }
  }
}
function keys(v, expected) {
  return v && typeof v === 'object' && !Array.isArray(v)
    && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...expected].sort());
}
function parseMetadata(buffer) {
  let text, v;
  try { text = decoder.decodeUtf8Strict(buffer); } catch (_) { fail('UTF8_STRICT_FAILED'); }
  try { v = JSON.parse(text); } catch (_) { fail('JSON_PARSE_FAILED'); } finally { text = null; }
  need(keys(v, ['schema','version','effectivePolicy','policies','nodeCandidateCount','selectedNodeMatches']), 'META_KEYS');
  need(v.schema === 'psr-local-environment/1', 'META_SCHEMA');
  need(typeof v.version === 'string' && /^\d+(\.\d+){1,3}$/.test(v.version) && v.version.length <= 32, 'META_VERSION');
  need(POLICY.includes(v.effectivePolicy), 'META_POLICY');
  need(typeof v.selectedNodeMatches === 'boolean', 'META_NODE_MATCH_TYPE');
  need(Number.isSafeInteger(v.nodeCandidateCount) && v.nodeCandidateCount >= 1 && v.nodeCandidateCount <= 64, 'META_NODE_COUNT');
  need(Array.isArray(v.policies) && v.policies.length === 5, 'META_SCOPE_COUNT');
  need(v.policies.every(p => keys(p, ['scope','policy']) && SCOPES.includes(p.scope) && POLICY.includes(p.policy)), 'META_SCOPE_ROW');
  need(new Set(v.policies.map(p => p.scope)).size === 5, 'META_SCOPE_DUPLICATE');
  const policies = SCOPES.map(scope => ({scope, policy: v.policies.find(p => p.scope === scope).policy}));
  const firstDefined = policies.find(p => p.policy !== 'Undefined');
  if (firstDefined && firstDefined.policy !== 'Default')
    need(v.effectivePolicy === firstDefined.policy, 'META_POLICY_CONFLICT');
  // No dynamic eligibility inferred from a structurally valid policy response.
  return {version: v.version, effectivePolicy: v.effectivePolicy, policies,
    nodeCandidateCount: v.nodeCandidateCount, selectedNodeMatches: v.selectedNodeMatches,
    firstMatchUsedAsApproval: false};
}
try {
  const args = process.argv.slice(2);
  need(args.length === 0 || (args.length === 2 && args[0] === '--out' && typeof args[1] === 'string' && args[1]), 'ARGUMENT_INVALID');
  if (args.length) {
    const p = path.resolve(args[1]);
    need(path.dirname(p) === __dirname && path.basename(p) === 'Codex三层预检P1-20261026.json', 'OUTPUT_BOUNDARY');
    chain(__dirname, false);
    let exists = false; try { fs.lstatSync(p); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    need(!exists, 'OUTPUT_EXISTS'); output = p;
  }
  probing = true;
  try { cp.execSync('synthetic-denied'); } catch (_) {}
  try { require('node:https').request('https://synthetic.invalid'); } catch (_) {}
  probing = false; need(state.probes === 2, 'GUARD_PROBE_FAILED');
  phase = 'host';
  need(process.execPath === NODE, 'HOST_PATH_MISMATCH');
  chain(NODE, true); need(hash(fs.readFileSync(NODE)) === NODE_SHA, 'HOST_DIGEST_MISMATCH');
  report.host = {execPathMatches: true, digestMatches: true, nodeSha256: NODE_SHA}; report.phases.H = 'pass';
  phase = 'fixed-source'; checkSources(true);
  const src = sources[PS1].toString('utf8');
  need(src.includes("$FixedNodePath = '" + NODE + "'") && src.includes("$FixedNodeSha256 = '" + NODE_SHA + "'"), 'FIXED_BINDING_MISMATCH');
  report.fixedBinding = {sourcePinned: true, hostMatchesFixedDefinition: true, sourceSha256: PINNED[PS1], dynamicVerified: false};
  report.phases.F = 'pass';
  const match = sources[BASIS].toString('utf8').match(/^const META = (".*");$/m);
  need(match, 'QUERY_CONSTANT_MISSING'); meta = JSON.parse(match[1]); need(hash(meta) === META_SHA, 'QUERY_DRIFT');
  report.querySha256 = META_SHA;
  chain(PS, true); report.powershellSha256Informational = hash(fs.readFileSync(PS));
  const m = {exports: {}};
  vm.runInNewContext('(function(module){' + sources[DECODER].toString('utf8') + '\n})', {Buffer, TextDecoder}, {timeout: 1000})(m);
  decoder = m.exports;
  need(state.unexpected === 0, 'CAPABILITY_BLOCKED');
  phase = 'environment'; report.phases.P1 = 'running';
  raw = invokeOnce(); report.queryCompleted = true;
  report.metadata = parseMetadata(raw); report.metadataValidated = true;
  report.phases.P1 = 'pass';
  report.dynamicReadiness = report.metadata.effectivePolicy === 'Restricted' ? 'blocked-policy' : 'pending-policy-and-file-review';
  if (report.metadata.effectivePolicy === 'Restricted') fail('POLICY_RESTRICTED');
} catch (e) {
  probing = false;
  const allowed = /^(ARGUMENT_INVALID|OUTPUT_BOUNDARY|OUTPUT_EXISTS|GUARD_PROBE_FAILED|HOST_PATH_MISMATCH|HOST_DIGEST_MISMATCH|PATH_CHAIN_INVALID|PATH_TYPE_INVALID|SOURCE_DRIFT|FIXED_BINDING_MISMATCH|QUERY_CONSTANT_MISSING|QUERY_DRIFT|CAPABILITY_BLOCKED|QUERY_START_FAILED|QUERY_TIMEOUT|QUERY_OUTPUT_LIMIT|QUERY_FAILED|QUERY_BUFFER_INVALID|QUERY_STDERR|UTF8_STRICT_FAILED|JSON_PARSE_FAILED|META_KEYS|META_SCHEMA|META_VERSION|META_POLICY|META_POLICY_CONFLICT|META_NODE_MATCH_TYPE|META_NODE_COUNT|META_SCOPE_COUNT|META_SCOPE_ROW|META_SCOPE_DUPLICATE|POLICY_RESTRICTED|BUDGET_EXHAUSTED)$/;
  failure = {stage: phase, code: typeof e.code === 'string' && allowed.test(e.code) ? e.code : 'PREFLIGHT_UNCERTAIN'};
} finally {
  if (raw) raw.fill(0); raw = null; decoder = null; sources = {};
  phase = 'finalization';
  try {
    // All source/host/hash checks complete before the final actual guard snapshot.
    if (report.phases.F === 'pass') checkSources(false);
    if (report.phases.H === 'pass') { chain(NODE, true); need(hash(fs.readFileSync(NODE)) === NODE_SHA, 'HOST_DIGEST_MISMATCH'); }
    report.driverSha256 = hash(fs.readFileSync(__filename));
  } catch (_) { failure = {stage: phase, code: 'FINAL_FACTS_UNCERTAIN'}; }
  report.elapsedMs = Date.now() - started;
  if (report.elapsedMs > 60000) failure = {stage: phase, code: 'BUDGET_EXHAUSTED'};
  if (state.unexpected) failure = {stage: phase, code: 'CAPABILITY_BLOCKED'};
  report.failure = failure;
  if (failure) report.phases.P1 = state.unexpected || failure.code === 'FINAL_FACTS_UNCERTAIN' ? 'fail' : 'blocked';
  report.ok = !failure && report.phases.H === 'pass' && report.phases.F === 'pass'
    && report.metadataValidated && state.attempts.length === 1 && state.attempts[0].completed && !state.attempts[0].failed;
  report.exitCode = report.ok ? 0 : state.unexpected || failure?.code === 'FINAL_FACTS_UNCERTAIN' ? 1 : 2;
  try {
    const json = JSON.stringify(report, null, 2) + '\n';
    if (output) fs.writeFileSync(output, json, {flag: 'wx'});
    process.stdout.write(json); process.exitCode = report.exitCode;
  } catch (_) { process.stdout.write('{"ok":false,"failure":{"code":"EVIDENCE_WRITE_FAILED"},"exitCode":1}\n'); process.exitCode = 1; }
}
