'use strict';
// Approved plan phase A only. No crypto, UI, private-file reads, ACL/policy changes.
// Run once on the actual host; downstream phases require an explicit pass here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const net = require('node:net');
const REPO = path.resolve(__dirname, '../..');
const ROOT = 'artifacts/schedule-sandbox/.participant-private';
const EXES = Object.freeze({
  git: 'C:\\Program Files\\Git\\cmd\\git.exe',
  whoami: 'C:\\Windows\\System32\\whoami.exe',
  icacls: 'C:\\Windows\\System32\\icacls.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
});
const NODE = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const NODE_SHA = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19';
const FACTS = 'docs/证据/CodeBuddy指定本人登记来源快照返修v4-20261022.json';
const FACTS_SHA = '58a2cb8d6bdf886700265afb74e1dd45457bfd7046915cc4f83d45acc5b88689';
const META = "$ErrorActionPreference='Stop'; Import-Module -Name ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $ErrorActionPreference=\"Stop\"; [pscustomobject]@{version=$PSVersionTable.PSVersion.ToString(); os=[Environment]::OSVersion.Version.ToString(); effectivePolicy=(Get-ExecutionPolicy).ToString(); policies=@(Get-ExecutionPolicy -List | ForEach-Object { [pscustomobject]@{scope=$_.Scope.ToString();policy=$_.ExecutionPolicy.ToString()} }); nodePath=(Get-Command node -CommandType Application).Source; gitVersion=(Get-Item -LiteralPath \"C:\\Program Files\\Git\\cmd\\git.exe\").VersionInfo.FileVersion; whoamiVersion=(Get-Item -LiteralPath \"C:\\Windows\\System32\\whoami.exe\").VersionInfo.FileVersion; icaclsVersion=(Get-Item -LiteralPath \"C:\\Windows\\System32\\icacls.exe\").VersionInfo.FileVersion } | ConvertTo-Json -Compress -Depth 4";
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const state = { probes: 0, unexpected: 0, processCalls: [], privateFilesRead: 0, privateFilesCreated: 0, temporaryFilesCreated: [] };
let probe = false, lease = false, aclOutput = '', principals;
const rawSync = cp.spawnSync;
function deny() {
  if (probe) state.probes++; else state.unexpected++;
  throw Object.assign(new Error('Blocked local capability'), { code: 'LOCAL_CAPABILITY_BLOCKED' });
}
// Install before application require. No public general-purpose process runner.
for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = deny;
for (const mod of [require('node:http'), require('node:https'), require('node:tls'), require('node:dns'), require('node:dns').promises]) {
  for (const k of Object.keys(mod)) if (typeof mod[k] === 'function') Object.defineProperty(mod, k, { value: deny, writable: false, configurable: true });
}
net.connect = net.createConnection = net.createServer = deny;
net.Socket.prototype.connect = deny;
global.fetch = deny;
const started = Date.now();
const runId = 'synthetic-local-private-' + crypto.randomBytes(6).toString('hex');
const target = ROOT + '/' + runId + '-ui.bin';
function requireFact(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
function dispatch(exe, args, options) {
  let kind;
  if (exe === EXES.git && (same(args, ['ls-files', '--', target]) || same(args, ['check-ignore', '--', target]))) kind = 'git-' + args[0];
  if (exe === EXES.whoami && same(args, ['/user', '/fo', 'csv', '/nh'])) kind = 'identity';
  if (exe === EXES.icacls && same(args, [ROOT])) kind = 'acl-root';
  if (exe === EXES.powershell && same(args, ['-NoProfile', '-NonInteractive', '-Command', META])) kind = 'environment';
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const expected = { cwd: REPO, input: undefined, encoding: 'utf8', windowsHide: true, shell: false, env, timeout: 10000, maxBuffer: 128 * 1024 };
  if (!lease || !kind || !same(options, expected) || Date.now() - started > 60000) return deny();
  // Reconstruct options: never forward arbitrary shell/environment/arguments/options.
  const result = rawSync(exe, args.slice(), expected);
  state.processCalls.push({ kind, pid: result.pid || null, status: result.status, signal: result.signal || null, launchError: Boolean(result.error), stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || '') });
  requireFact(!result.error && !result.signal && [0, 1].includes(result.status) && Buffer.byteLength(result.stdout || '') <= 128 * 1024 && Buffer.byteLength(result.stderr || '') <= 128 * 1024, 'LOCAL_PROCESS_FAILED');
  if (kind === 'acl-root') aclOutput = result.stdout || '';
  return result;
}
cp.spawnSync = dispatch;
function withLease(fn) { lease = true; try { return fn(); } finally { lease = false; } }
function classifyAcl(store) {
  if (!principals || !aclOutput) return { classified: false };
  const offenders = store.findBroadAclGrants(aclOutput, principals, ROOT);
  return {
    classified: true,
    rejectedRows: offenders.length,
    disallowedPrincipalRows: offenders.filter(s => /^(.+?):((?:\([A-Za-z0-9 ,]+\))+)$/u.test(s)).length,
    unparsedRows: offenders.filter(s => !/^(.+?):((?:\([A-Za-z0-9 ,]+\))+)$/u.test(s)).length,
    utf8ReplacementObserved: aclOutput.includes('\ufffd')
  };
}
const report = {
  schema: 'codex-private-local-preflight/4', runId, recordedAt: new Date().toISOString(),
  reviewedCommit: 'fea22e0f3cf69bc853aa75b93d2ad05c9459590f', planBasis: 'cbc889b', continuationBasis: 'd56eff4', securityModuleSelection: 'explicit PSHOME built-in; no environment or policy mutation',
  preflightStatus: 'not-run', ok: false, fullLocalValidationPassed: false,
  sourceFacts: [], binaries: [], observations: state,
  phases: { A: 'not-run', B: 'not-run', C: 'not-run', D: 'not-run', E: 'not-run' },
  targetRelativePath: target,
  boundaries: { existingPrivateRecordsRead: false, policyModified: false, aclModified: false, cloudOperations: false, syntheticOnly: true },
  limitations: ['This driver only performs phase A; a pass is not full validation or real-input approval.', 'No DPAPI, UI, cross-account or platform verification is performed by this driver.']
};
let store;
try {
  const argv = process.argv.slice(2);
  requireFact(argv.length === 0 || (argv.length === 2 && argv[0] === '--out' && argv[1]), 'ARGUMENT_INVALID');
  if (argv.length) {
    const out = path.resolve(argv[1]);
    requireFact(path.dirname(out) === __dirname && path.basename(out).startsWith('Codex本机合成验证预检-') && out.endsWith('.json'), 'OUTPUT_BOUNDARY');
    requireFact(!fs.existsSync(out), 'OUTPUT_EXISTS');
  }
  probe = true;
  try { cp.execSync('synthetic-denied'); } catch (_) { /* explicit probe */ }
  try { require('node:https').request('https://synthetic.invalid'); } catch (_) { /* explicit probe */ }
  probe = false;
  requireFact(state.probes === 2, 'GUARD_PROBE_FAILED');
  const factsBytes = fs.readFileSync(path.join(REPO, FACTS));
  requireFact(hash(factsBytes) === FACTS_SHA, 'FACTS_DRIFT');
  for (const f of JSON.parse(factsBytes).sourceFacts) {
    const bytes = fs.readFileSync(path.join(REPO, f.rel));
    report.sourceFacts.push({ rel: f.rel, sha256: hash(bytes), matches: hash(bytes) === f.sha256 && bytes.length === f.bytes });
  }
  requireFact(report.sourceFacts.length === 10 && report.sourceFacts.every(f => f.matches), 'SOURCE_DRIFT');
  requireFact(process.execPath === NODE && hash(fs.readFileSync(NODE)) === NODE_SHA, 'NODE_DRIFT');
  for (const [kind, exe] of Object.entries({ ...EXES, node: NODE })) {
    requireFact(fs.lstatSync(exe).isFile() && !fs.lstatSync(exe).isSymbolicLink(), 'PROGRAM_PATH_INVALID');
    report.binaries.push({ kind, path: exe, sha256: hash(fs.readFileSync(exe)) });
  }
  report.nodeVersion = process.version;
  store = require('../../miniapp/scripts/lib/participant-private-store.cjs');
  store.assertNoLinks(REPO, path.join(REPO, ROOT));
  requireFact(fs.lstatSync(path.join(REPO, ROOT)).isDirectory(), 'PRIVATE_ROOT_MISSING');
  let exists = false;
  try { fs.lstatSync(path.join(REPO, target)); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  requireFact(!exists, 'TARGET_EXISTS');
  report.targetAbsent = true; report.directoryChainNoLinks = true;
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const metadata = withLease(() => dispatch(EXES.powershell, ['-NoProfile', '-NonInteractive', '-Command', META], { cwd: REPO, input: undefined, encoding: 'utf8', windowsHide: true, shell: false, env, timeout: 10000, maxBuffer: 128 * 1024 }));
  requireFact(metadata.status === 0 && !metadata.stderr.trim(), 'ENVIRONMENT_QUERY_FAILED');
  const m = JSON.parse(metadata.stdout.replace(/^\uFEFF/u, ''));
  const nodeCandidates = Array.isArray(m.nodePath) ? m.nodePath : [m.nodePath];
  const allNodesMatch = nodeCandidates.length > 0 && nodeCandidates.every(p => typeof p === 'string' && path.resolve(p).toLowerCase() === NODE.toLowerCase());
  const selectedNodeMatches = typeof nodeCandidates[0] === 'string' && path.resolve(nodeCandidates[0]).toLowerCase() === NODE.toLowerCase();
  report.environmentShape = { nodePathWasArray: Array.isArray(m.nodePath), nodeCandidateCount: nodeCandidates.length, allNodesMatch, selectedNodeMatches, selectionRule: 'first Application returned by Get-Command; NODE absolute path and hash separately verified', policiesArray: Array.isArray(m.policies), versionString: typeof m.version === 'string' };
  requireFact(selectedNodeMatches && Array.isArray(m.policies) && typeof m.version === 'string', 'ENVIRONMENT_PARSE_FAILED');
  report.environment = { powershellVersion: m.version, osVersion: m.os, effectivePolicy: m.effectivePolicy, policies: m.policies, nodePathMatches: true, gitVersion: m.gitVersion, whoamiVersion: m.whoamiVersion, icaclsVersion: m.icaclsVersion, scriptExecutionTested: false };
  principals = withLease(() => store.getCurrentPrincipals());
  requireFact(principals !== null, 'IDENTITY_UNCERTAIN'); report.identityParsed = true;
  withLease(() => store.validatePrivateTarget({ repoRoot: REPO, relativePath: target }));
  report.acl = classifyAcl(store);
  requireFact(report.acl.rejectedRows === 0, 'ACL_UNCERTAIN');
  requireFact(state.unexpected === 0, 'UNEXPECTED_CAPABILITY');
  report.preflightStatus = 'pass'; report.phases.A = 'pass'; report.ok = true;
} catch (e) {
  probe = false;
  report.failureCode = typeof e.code === 'string' && /^[A-Z0-9_]+$/u.test(e.code) ? e.code : 'PREFLIGHT_UNCERTAIN';
  report.preflightStatus = state.unexpected ? 'fail' : 'blocked'; report.phases.A = report.preflightStatus;
  if (store) report.acl = classifyAcl(store);
} finally {
  aclOutput = ''; principals = undefined;
  report.phases.E = 'pass-no-temporary-files';
  report.elapsedMs = Date.now() - started;
  report.scriptSha256 = hash(fs.readFileSync(__filename));
  if (state.unexpected) report.ok = false;
  report.exitCode = report.ok ? 0 : (state.unexpected ? 1 : 2);
  const output = JSON.stringify(report, null, 2) + '\n';
  // Public API guards remain installed. Evidence alone is persisted, exclusively.
  if (process.argv[2] === '--out' && !['ARGUMENT_INVALID', 'OUTPUT_BOUNDARY', 'OUTPUT_EXISTS'].includes(report.failureCode)) fs.writeFileSync(path.resolve(process.argv[3]), output, { flag: 'wx' });
  process.stdout.write(output); process.exitCode = report.exitCode;
}
