'use strict';
// Audit harness only. No production code or installed CLI files are modified.
// Parent runs the exact public entry; preload intercepts Node transport before it loads.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const INSTALL = 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli';
const ENTRY = path.join(INSTALL, 'bin/tcb');
const BUNDLE = path.join(INSTALL, 'dist/standalone/cli.js');
const NODE = 'C:/Users/30591/.agent-reach/tools/node-v22.16.0-win-x64/node.exe';
const EXPECTED = '8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97';
const SYN = label => ({ id: 'SYNTHETIC_OFFLINE_ID_' + label, key: 'SYNTHETIC_OFFLINE_KEY_' + label, token: 'SYNTHETIC_OFFLINE_TOKEN_' + label });
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inside = (p, root) => { const rel = path.relative(path.resolve(root), path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

function preload() {
  const http = require('node:http'), https = require('node:https');
  const net = require('node:net'), tls = require('node:tls'), dns = require('node:dns');
  const cp = require('node:child_process');
  const { Writable, Readable } = require('node:stream');
  const runRoot = process.env.CODEX_OFFLINE_ROOT;
  const reportPath = path.join(runRoot, 'transport-proof.json');
  const rawWrite = fs.writeFileSync.bind(fs);
  const report = { kind: 'public-cli-offline-transport', requests: [], hmacKeyLabels: [], blockedNetwork: 0,
    blockedSubprocess: 0, deniedFileReads: 0, deniedFileWrites: 0, realNetworkCalls: 0 };
  const persist = () => rawWrite(reportPath, JSON.stringify(report, null, 2));
  process.on('exit', persist);
  const block = kind => { report[kind]++; persist(); throw Object.assign(new Error('OFFLINE_BOUNDARY'), { code: 'OFFLINE_BOUNDARY' }); };
  for (const key of ['connect', 'createConnection']) net[key] = () => block('blockedNetwork');
  net.Socket.prototype.connect = () => block('blockedNetwork');
  tls.connect = () => block('blockedNetwork');
  for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[key] = () => block('blockedNetwork');
  for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) if (dns.promises[key]) dns.promises[key] = async () => block('blockedNetwork');
  require('node:dgram').createSocket = () => block('blockedNetwork');
  require('node:http2').connect = () => block('blockedNetwork');
  global.fetch = async () => block('blockedNetwork');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = () => block('blockedSubprocess');

  // Do not allow reads of existing user credentials or changes outside this fresh run.
  const readAllowed = p => typeof p === 'number' || inside(String(p), runRoot) || inside(String(p), INSTALL) || path.resolve(String(p)) === __filename;
  function guard(p, write) { if (!(write ? inside(String(p), runRoot) : readAllowed(p))) block(write ? 'deniedFileWrites' : 'deniedFileReads'); }
  for (const key of ['readFileSync', 'readFile', 'createReadStream']) {
    const orig = fs[key]; fs[key] = function(p, ...args) { guard(p, false); return orig.call(this, p, ...args); };
  }
  const readPromise = fs.promises.readFile.bind(fs.promises);
  fs.promises.readFile = async (p, ...args) => { guard(p, false); return readPromise(p, ...args); };
  for (const key of ['open', 'openSync']) {
    const orig = fs[key]; fs[key] = function(p, flags, ...args) { guard(p, typeof flags === 'string' && /[wa+]/.test(flags)); return orig.call(this, p, flags, ...args); };
  }
  for (const key of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'unlinkSync', 'unlink', 'createWriteStream']) {
    const orig = fs[key]; fs[key] = function(p, ...args) { guard(p, true); return orig.call(this, p, ...args); };
  }
  for (const key of ['renameSync', 'rename']) {
    const orig = fs[key]; fs[key] = function(a, b, ...args) { guard(a, true); guard(b, true); return orig.call(this, a, b, ...args); };
  }
  const createHmac = crypto.createHmac;
  crypto.createHmac = function(algorithm, key, ...args) {
    for (const label of ['A', 'B']) if (String(key) === 'TC3' + SYN(label).key) report.hmacKeyLabels.push(label);
    return createHmac.call(this, algorithm, key, ...args);
  };
  function request(input, options, callback) {
    let opts = typeof input === 'string' || input instanceof URL ? { ...new URL(input), ...(options || {}) } : { ...input };
    if (typeof options === 'function') callback = options;
    const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const host = opts.hostname || opts.host || '';
    const action = headers['x-tc-action'];
    const chunks = [];
    const req = new Writable({ write(chunk, enc, done) { chunks.push(Buffer.from(chunk)); done(); }, final(done) {
      const auth = headers.authorization || '';
      const selected = ['A', 'B'].find(label => auth.includes('Credential=' + SYN(label).id + '/')) || null;
      const tokenMatched = selected ? headers['x-tc-token'] === SYN(selected).token : false;
      const body = Buffer.concat(chunks).toString('utf8');
      const captured = { host, action: action || null, method: opts.method || null, selectedLabel: selected,
        tokenMatched, hmacKeyMatched: selected ? report.hmacKeyLabels.includes(selected) : false,
        bodyIsEmptyObject: body === '{}', mocked: true };
      report.requests.push(captured); persist();
      done();
      process.nextTick(() => {
        const serviceCheck = host === 'tcb.tencentcloudapi.com' && action === 'CheckTcbService';
        if (!serviceCheck && (host !== 'sts.tencentcloudapi.com' || action !== 'GetCallerIdentity')) {
          req.emit('error', Object.assign(new Error('OFFLINE_UNEXPECTED_REQUEST'), { code: 'OFFLINE_UNEXPECTED_REQUEST' })); return;
        }
        const response = new Readable({ read() {} });
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        response.rawHeaders = ['Content-Type', 'application/json'];
        response.httpVersion = '1.1';
        if (callback) callback(response);
        req.emit('response', response);
        response.push(JSON.stringify({ Response: serviceCheck
          ? { Initialized: true, RequestId: '00000000-0000-4000-8000-000000000001' }
          : { AccountId: '123456789012', UserId: 'synthetic', PrincipalId: 'synthetic',
            Type: 'CAMRole', Arn: 'synthetic', RequestId: '00000000-0000-4000-8000-000000000001' } }));
        response.push(null);
      });
    } });
    req.setTimeout = () => req; req.setHeader = (k, v) => { headers[k.toLowerCase()] = String(v); };
    req.getHeader = k => headers[k.toLowerCase()]; req.removeHeader = k => { delete headers[k.toLowerCase()]; };
    req.abort = () => req.destroy(); req.flushHeaders = () => {};
    return req;
  }
  http.request = https.request = request;
  http.get = https.get = (...args) => { const r = request(...args); r.end(); return r; };
  persist();
}

async function main() {
  const { spawn } = require('node:child_process');
  if (sha(BUNDLE) !== EXPECTED) throw new Error('Fixed CLI hash mismatch');
  const entryHash = sha(ENTRY);
  const auditRoot = fs.mkdtempSync('C:/Users/30591/.codex/tmp/cli-public-offline-');
  const results = [];
  for (const label of ['A', 'B', 'NONE']) {
    const root = path.join(auditRoot, label), profile = path.join(root, 'profile'), cwd = path.join(root, 'cwd');
    fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
    const env = { SystemRoot: process.env.SystemRoot, PATH: '', USERPROFILE: profile, HOME: profile,
      APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'),
      TEMP: root, TMP: root, CI: '1', TCB_REGION: 'ap-shanghai', TCB_DISABLE_REPORT: '1', CODEX_OFFLINE_ROOT: root };
    if (label !== 'NONE') Object.assign(env, { TENCENTCLOUD_SECRETID: SYN(label).id,
      TENCENTCLOUD_SECRETKEY: SYN(label).key, TENCENTCLOUD_SESSIONTOKEN: SYN(label).token });
    const result = await new Promise(resolve => {
      const child = spawn(NODE, ['--require', __filename, ENTRY, 'api', 'sts', 'GetCallerIdentity', '--api-version', '2018-08-13', '--body', '{}', '--json'],
        { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
      child.stdout.on('data', b => { if (stdout.length < 1048576) stdout += b; });
      child.stderr.on('data', b => { if (stderr.length < 1048576) stderr += b; });
      child.on('error', e => { clearTimeout(timer); resolve({ spawnError: e.code }); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: code, signal, timedOut,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
        outputLooksLikeJson: stdout.includes('AccountId'),
        // Synthetic only, still omit raw CLI diagnostics from saved output.
        credentialMarkerInOutput: /SYNTHETIC_OFFLINE_(?:ID|KEY|TOKEN)/.test(stdout + stderr) }); });
    });
    const proofFile = path.join(root, 'transport-proof.json');
    const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : null;
    results.push({ label, ...result, proof });
    if (result.spawnError || result.timedOut) break;
  }
  const identified = results.filter(r => r.label !== 'NONE');
  const absent = results.find(r => r.label === 'NONE');
  const proven = identified.length === 2 && identified.every(r => r.exitCode === 0 && !r.timedOut &&
    !r.credentialMarkerInOutput && r.proof && r.proof.requests.some(q => q.action === 'GetCallerIdentity') &&
    r.proof.requests.every(q => q.selectedLabel === r.label && q.tokenMatched && q.hmacKeyMatched) &&
    r.proof.deniedFileReads === 0 && r.proof.deniedFileWrites === 0 && r.proof.blockedNetwork === 0) &&
    absent && absent.exitCode !== 0 && absent.proof && absent.proof.requests.length === 0;
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), auditRoot, entryHash, bundleHash: sha(BUNDLE),
    unchanged: sha(ENTRY) === entryHash && sha(BUNDLE) === EXPECTED, results, syntheticOnly: true,
    publicEntrySyntheticIdentityProven: Boolean(proven), productionSameBatchProven: false,
    limitations: ['Node transport hooks, not an OS firewall.', 'No IAM/platform response or production credential chain is verified.'] }, null, 2));
  if (!proven) process.exitCode = 1;
}
if (process.env.CODEX_OFFLINE_ROOT) preload();
else if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
