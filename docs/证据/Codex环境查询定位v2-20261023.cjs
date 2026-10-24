'use strict';
// One bounded, read-only replay of the previously failed fixed environment query.
// stdout/stderr are classified in memory; neither is copied into evidence.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const cp = require('node:child_process');
const rawSync = cp.spawnSync;
const REPO = path.resolve(__dirname, '../..');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const observed = { probes: 0, unexpected: 0, processes: [] };
let probe = false;
function deny() { observed[probe ? 'probes' : 'unexpected']++; throw new Error('CAPABILITY_BLOCKED'); }
for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = deny;
for (const mod of [require('node:http'), require('node:https'), require('node:tls'), require('node:dns'), require('node:dns').promises]) {
  for (const k of Object.keys(mod)) if (typeof mod[k] === 'function') Object.defineProperty(mod, k, { value: deny });
}
const net = require('node:net');
net.connect = net.createConnection = net.createServer = net.Socket.prototype.connect = deny;
global.fetch = deny;
const report = { schema: 'codex-environment-query-diagnosis/2', basis: 'd56eff4', recordedAt: new Date().toISOString(), observed, privateRecordsRead: 0, privateFilesCreated: 0, policyModified: false, aclModified: false, cloudOperations: 0, temporaryFilesCreated: [] };
function check(v, code) { if (!v) throw Object.assign(new Error(code), { code }); }
let out;
try {
  const argv = process.argv.slice(2);
  check(argv.length === 0 || (argv.length === 2 && argv[0] === '--out' && argv[1]), 'ARGUMENT_INVALID');
  if (argv.length) { out = path.resolve(argv[1]); check(path.dirname(out) === __dirname && path.basename(out).startsWith('Codex环境查询定位-') && out.endsWith('.json') && !fs.existsSync(out), 'OUTPUT_INVALID'); }
  probe = true;
  try { cp.execSync('synthetic-denied'); } catch (_) {}
  try { require('node:https').request('https://synthetic.invalid'); } catch (_) {}
  probe = false;
  const source = fs.readFileSync(path.join(__dirname, 'Codex本机合成验证预检-20261023.cjs'));
  check(hash(source) === '6e9f54d1ed5410c9e34b2a0a825f2c70281703345449965e8421e0c0b7f57fb1', 'SOURCE_DRIFT');
  const match = source.toString('utf8').match(/^const META = ('.*');$/m);
  check(match, 'SOURCE_SHAPE');
  // Only evaluate the hash-pinned string literal, never the original driver.
  const command = vm.runInNewContext(match[1], Object.create(null), { timeout: 100 });
  check(typeof command === 'string', 'SOURCE_SHAPE');
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const r = rawSync(PS, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: REPO, encoding: null, windowsHide: true, shell: false, env, timeout: 10000, maxBuffer: 128 * 1024 });
  observed.processes.push({ kind: 'original-readonly-query', pid: r.pid || null, status: r.status, signal: r.signal || null, launchError: Boolean(r.error), stdoutBytes: Buffer.byteLength(r.stdout || ''), stderrBytes: Buffer.byteLength(r.stderr || '') });
  check(!r.error && !r.signal && [0, 1].includes(r.status), 'PROCESS_FAILED');
  const rawError = r.stderr || Buffer.alloc(0);
  const decoded = ['utf-8', 'utf-16le', 'gb18030'].map(encoding => ({encoding, text: new TextDecoder(encoding).decode(rawError)}));
  const stderr = decoded.map(d => d.text).join('\n');
  report.encodingFacts = decoded.map(d => ({encoding:d.encoding, replacementCharacters:(d.text.match(/\ufffd/g)||[]).length}));
  report.nulBytes = [...rawError].filter(n=>n===0).length;
  report.fixedErrorWords = ['Get-Item','Get-ExecutionPolicy','Get-Command','node','Stop','C:\\Program','UnexpectedToken','Missing','术语','找不到','拒绝','解析','执行策略','参数','位置','无法','字符串','引号','版本'].filter(s=>stderr.includes(s));
  report.errorIdentifiers = [...new Set((stderr.match(/[A-Za-z][A-Za-z0-9]+(?:Exception|Error)/g)||[]))].filter(s=>s.length<90).slice(0,12);
  const classes = ['CommandNotFoundException', 'ParserError', 'ParseException', 'ParameterBindingException', 'MethodInvocationException', 'RuntimeException', 'PSSecurityException', 'UnauthorizedAccessException', 'ItemNotFoundException'];
  report.failureClasses = classes.filter(s => stderr.includes(s));
  // Fixed public command literals only; no arbitrary error text or file/identity values.
  report.fixedLiteralMarkers = {
    stopAsCommand: /(?:^|\r?\n)Stop\s*:/u.test(stderr),
    programPathAsCommand: /(?:^|\r?\n)C:\\Program\s*:/u.test(stderr),
    nodeCommandMissing: /CommandNotFoundException/u.test(stderr) && /Get-Command/u.test(stderr) && /node/u.test(stderr),
    scriptPolicyMarker: /PSSecurityException|UnauthorizedAccess/u.test(stderr)
  };
  report.originalQueryFailed = r.status !== 0 || stderr.trim().length !== 0;
  report.diagnosticCompleted = observed.probes === 2 && observed.unexpected === 0;
  report.preflightPassed = false;
  report.fullLocalValidationPassed = false;
  report.ok = report.diagnosticCompleted;
} catch (e) { report.ok = false; report.failureCode = /^[A-Z0-9_]+$/u.test(e.code || '') ? e.code : 'DIAGNOSTIC_FAILED'; }
report.scriptSha256 = hash(fs.readFileSync(__filename));
report.exitCode = report.ok ? 0 : 1;
const result = JSON.stringify(report, null, 2) + '\n';
if (out && !report.failureCode) fs.writeFileSync(out, result, { flag: 'wx' });
process.stdout.write(result); process.exitCode = report.exitCode;
