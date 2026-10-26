'use strict';
// Explicit --execute only. Fixed L1 synthetic PS1 branch, never L2/UI/DPAPI.
// User authorization: per-child RemoteSigned, no persistent policy changes.
const cp = require('node:child_process');
const state = {probes: 0, unexpected: 0, attempts: []};
let probing = false;
function fail(code) { throw Object.assign(new Error(code), {code}); }
function need(ok, code) { if (!ok) fail(code); }
function deny() { state[probing ? 'probes' : 'unexpected']++; fail('CAPABILITY_BLOCKED'); }
const runFixed = (() => {
  const spawn = cp.spawn.bind(cp), used = new Set();
  let active = false;
  return async kind => {
    need(!active && !used.has(kind), 'RUNNER_SEQUENCE');
    const scene = NAMES.includes(kind);
    need(['before','temporary','after'].includes(kind) || scene, 'RUNNER_PURPOSE');
    if (kind === 'before') need(state.attempts.length === 0, 'RUNNER_SEQUENCE');
    if (kind === 'temporary') need(report.before !== null, 'RUNNER_SEQUENCE');
    if (scene) need(report.temporary !== null && NAMES.slice(0, NAMES.indexOf(kind)).every(n => report.scenarios[n]?.passed), 'RUNNER_SEQUENCE');
    if (kind === 'after') need(used.has('temporary') && state.attempts.every(a => a.closed || a.spawnFailed), 'RUNNER_SEQUENCE');
    if (kind !== 'after') need(state.unexpected === 0, 'CAPABILITY_BLOCKED');
    verifySources();
    if (scene) zoneAbsent();
    const remaining = Math.min(120000 - (Date.now() - started), scene ? 90000 - (Date.now() - sceneStart) : 10000);
    need(remaining > 0, 'BUDGET_EXHAUSTED');
    const args = ['-NoProfile', '-NonInteractive'];
    if (kind === 'temporary' || scene) args.push('-ExecutionPolicy', 'RemoteSigned');
    if (scene) args.push('-File', PS1, '-SelfTestSynthetic', '-SelfTestScenario', kind);
    else args.push('-Command', kind === 'before' ? META_ZONE : META);
    const env = {...process.env}; delete env.NODE_OPTIONS;
    const a = {kind, attempted: true, pid: null, closed: false, spawnFailed: false,
      status: null, signal: null, stdoutBytes: 0, stderrBytes: 0, failed: false,
      killRequested: false, killAccepted: null, reason: null, timeoutMs: Math.min(10000, remaining)};
    state.attempts.push(a); used.add(kind); active = true;
    let child;
    const result = await new Promise(resolve => {
      let done = false, deadline, reap, chunks = [], failure = null;
      function finish() {
        if (done) return; done = true; clearTimeout(deadline); clearTimeout(reap);
        a.failed = !!failure; a.reason = failure; active = !a.closed && !a.spawnFailed;
        const out = failure ? null : Buffer.concat(chunks);
        for (const b of chunks) b.fill(0); chunks = [];
        resolve({out, failure});
      }
      function stop(code) {
        failure ||= code;
        if (done || a.closed || a.spawnFailed) return;
        if (!a.killRequested) {
          a.killRequested = true;
          try { a.killAccepted = child.kill('SIGKILL') === true; } catch (_) { a.killAccepted = false; }
          // Separate bounded reap; do not claim cleanup until a close event.
          if (!done) reap = setTimeout(() => { failure = 'PROCESS_NOT_CLOSED'; finish(); }, 1000);
        }
      }
      try {
        child = spawn(PS, args, {cwd: ROOT, shell: false, windowsHide: true, env, stdio: ['ignore','pipe','pipe']});
      } catch (_) { a.spawnFailed = true; failure = 'PROCESS_START_FAILED'; finish(); return; }
      a.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
      child.on('error', () => {
        if (!a.pid) { a.spawnFailed = true; failure = 'PROCESS_START_FAILED'; finish(); }
        else stop('PROCESS_ERROR');
      });
      child.on('close', (code, signal) => {
        a.closed = true; a.status = Number.isInteger(code) ? code : null; a.signal = signal || null;
        if (a.status !== 0 || a.signal) failure ||= 'PROCESS_EXIT';
        finish();
      });
      function receive(channel, data) {
        if (done) return;
        if (!Buffer.isBuffer(data)) { stop('OUTPUT_BUFFER'); return; }
        a[channel === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += data.length;
        if (a.stdoutBytes + a.stderrBytes > LIMIT) { stop('OUTPUT_LIMIT'); return; }
        if (channel === 'stderr' && data.length) { stop('PROCESS_STDERR'); return; }
        if (!failure && channel === 'stdout') chunks.push(Buffer.from(data));
      }
      if (!child.stdout || !child.stderr) stop('PROCESS_STREAMS');
      else {
        child.stdout.on('data', b => receive('stdout', b));
        child.stderr.on('data', b => receive('stderr', b));
        child.stdout.on('error', () => stop('STREAM_ERROR'));
        child.stderr.on('error', () => stop('STREAM_ERROR'));
      }
      if (!done) deadline = setTimeout(() => stop('PROCESS_TIMEOUT'), a.timeoutMs);
    });
    need(!result.failure, result.failure);
    need(a.closed && a.pid !== null, 'PROCESS_NOT_CLOSED');
    try { verifySources(); } catch (e) { result.out.fill(0); throw e; }
    return result.out;
  };
})();
// Guards precede all business/source loading. Retain only private fixed spawn.
for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = deny;
for (const id of ['node:http','node:https','node:tls','node:dgram','node:dns']) {
  const m = require(id);
  for (const k of Object.keys(m)) if (typeof m[k] === 'function') Object.defineProperty(m, k, {value: deny, configurable: true});
}
for (const k of Object.keys(require('node:dns').promises))
  if (typeof require('node:dns').promises[k] === 'function') require('node:dns').promises[k] = deny;
const net = require('node:net'); net.connect = net.createConnection = net.createServer = deny; net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const ROOT = 'C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const NODE = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const NODE_SHA = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PS1 = path.join(ROOT, 'miniapp/scripts/participant-private-input.ps1');
const PS1_SHA = '9255adb762cd19801805ee19c04204dd8f8a3b384d8fc857ff36d44466db0790';
const DECODER = path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs');
const DECODER_SHA = '462976b3cf32999fb0079d6b0bbb4cf54cd35ab3d1068fb1052db36f4c05f7d3';
const OUT = path.join(__dirname, 'Codex临时策略L1-20261026.json');
const NAMES = ['N1_SAVE','N1_ECHO','N2_DECL','N3_FILE','N4_DRIFT','N5_STARTFAIL','N6_TRANSPORT'];
const COUNTER_KEYS = ['fileProbe','digestProbe','digestHold','holdOpens','holdCloses','startCalls','starts','stdinWrites'];
const EXPECT_COUNTS = [19,15,15,34,12,9,17];
const EXPECT_COUNTERS = [[1,0,1,1,1,1,1,1],[1,0,1,1,1,1,1,0],[0,0,0,0,0,0,0,0],
  [1,1,0,0,0,0,0,0],[1,0,1,1,1,1,1,1],[1,0,1,1,1,1,0,0],[1,0,1,1,1,1,1,0]];
const SCOPES = ['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'];
const META_PREFIX = "$ErrorActionPreference='Stop';Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security') -ErrorAction Stop;Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility') -ErrorAction Stop;[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);";
const META_OBJECT = "@{schema='codex-l1-environment/1';version=$PSVersionTable.PSVersion.ToString();effectivePolicy=[string](Get-ExecutionPolicy);policies=@(Get-ExecutionPolicy -List | ForEach-Object {@{scope=[string]$_.Scope;policy=[string]$_.ExecutionPolicy}})";
const META = META_PREFIX + META_OBJECT + '} | ConvertTo-Json -Depth 5 -Compress';
const META_ZONE = META_PREFIX + "$zone=@(Get-Item -LiteralPath '" + PS1 + "' -Stream * -ErrorAction Stop | Where-Object {$_.Stream -ceq 'Zone.Identifier'}).Count;" + META_OBJECT + ";zonePresent=($zone -gt 0)} | ConvertTo-Json -Depth 5 -Compress";
const LIMIT = 128 * 1024, started = Date.now();
let sceneStart = 0, expected = {}, decoder = null, psHash = null, output = null, execute = false, phase = 'arguments';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const report = {schema: 'codex-temporary-policy-l1/1', basisCommit: 'e02b1a8', recordedAt: new Date().toISOString(),
  before: null, temporary: null, after: null, hostAndSourceVerified: false, policyComparisonPassed: false,
  scenarios: Object.fromEntries(NAMES.map(n => [n, {status:'not-run',passed:false}])), observations: state,
  failure: null, cleanupFailure: null, fullPreflightPassed: false, realInputApproved: false,
  notRun: ['L2','P4','UI','DPAPI','private-save','cloud'],
  limitations: ['L1 executes real PowerShell semantics; file and Node launch boundaries inside the pinned PS1 are synthetic.',
    'Parent JS guards are not an OS network sandbox. No real descendants are expected from the pinned synthetic branch.',
    'RemoteSigned is per process, may be inherited by descendants; no persistent policy or parent environment writes.',
    'Successful policy comparison proves queried policy values, not absence of all system changes.']};
function chain(file) {
  const full = path.resolve(file), root = path.parse(full).root;
  let current = root; const pieces = full.slice(root.length).split(path.sep).filter(Boolean);
  const r = fs.lstatSync(root); need(r.isDirectory() && !r.isSymbolicLink(), 'PATH_INVALID');
  for (let i=0; i<pieces.length; i++) {
    current = path.join(current,pieces[i]); const s = fs.lstatSync(current);
    need(!s.isSymbolicLink() && (i===pieces.length-1 ? s.isFile() : s.isDirectory()), 'PATH_INVALID');
  }
}
function verifySources() {
  need(process.execPath === NODE && path.resolve(__dirname,'../..') === ROOT, 'HOST_PATH');
  for (const [file, sha] of [[NODE,NODE_SHA],[PS1,PS1_SHA],[DECODER,DECODER_SHA]]) {
    chain(file); need(hash(fs.readFileSync(file)) === sha, 'SOURCE_DRIFT');
  }
  chain(PS); const h = hash(fs.readFileSync(PS));
  if (psHash !== null) need(h === psHash, 'HOST_DRIFT'); else psHash = h;
}
function zoneAbsent() {
  chain(PS1); let fd;
  try { fd=fs.openSync(PS1+':Zone.Identifier','r'); }
  catch (e) { if(e.code==='ENOENT') return; fail('ZONE_UNCERTAIN'); }
  try { fs.closeSync(fd); } catch (_) { fail('ZONE_UNCERTAIN'); }
  fail('ZONE_PRESENT');
}
function exactKeys(v, keys) {
  return v && typeof v==='object' && !Array.isArray(v) && JSON.stringify(Object.keys(v).sort())===JSON.stringify([...keys].sort());
}
function parse(raw) {
  try { return JSON.parse(decoder.decodeUtf8Strict(raw)); }
  catch (_) { fail('OUTPUT_DECODE'); } finally { raw.fill(0); }
}
function metadata(raw, kind) {
  const v = parse(raw), keys=['schema','version','effectivePolicy','policies'];
  if(kind==='before') keys.push('zonePresent');
  need(exactKeys(v,keys) && v.schema==='codex-l1-environment/1', 'META_SHAPE');
  need(v.version==='5.1.26100.9711', 'META_VERSION');
  need(Array.isArray(v.policies) && v.policies.length===5, 'META_SCOPES');
  need(v.policies.every(p=>exactKeys(p,['scope','policy']) && SCOPES.includes(p.scope)) && new Set(v.policies.map(p=>p.scope)).size===5,'META_SCOPES');
  const rows=SCOPES.map(scope=>v.policies.find(p=>p.scope===scope));
  const temporary=kind==='temporary';
  need(rows.every(p=>p.policy===(temporary && p.scope==='Process' ? 'RemoteSigned':'Undefined'))
    && v.effectivePolicy===(temporary ? 'RemoteSigned':'Restricted'), 'POLICY_CHANGED_OR_BLOCKED');
  if(kind==='before') need(v.zonePresent===false, 'ZONE_PRESENT_OR_UNCERTAIN');
  return {version:v.version,effectivePolicy:v.effectivePolicy,policies:rows,...(kind==='before'?{zonePresent:false}:{})};
}
function assertionNames(source) {
  for(let i=0;i<NAMES.length;i++) {
    const name=NAMES[i], start=source.indexOf("  if ($SelfTestScenario -eq '"+name+"') {");
    const end=i+1<NAMES.length ? source.indexOf("  if ($SelfTestScenario -eq '"+NAMES[i+1]+"') {",start+1) : source.indexOf('  $failedChecks =',start);
    need(start>=0 && end>start,'ASSERTION_SOURCE');
    let names=Array.from(source.slice(start,end).matchAll(/Add-Check '([^']+)'/g),m=>m[1]);
    if(name==='N2_DECL') names.splice(2,0,...['explicit-empty','relative','other-exe','other-node','splice-suffix','splice-space','nul','newline'].map(n=>'decl-reject-'+n));
    if(name==='N3_FILE') names.unshift(...['missing','directory','reparse-file','reparse-chain','facts-read-fail','hold-open-fail','digest-mismatch','digest-read-fail'].flatMap(n=>['rejected','label-exact','zero-start-stdin','hold-count'].map(s=>'n3-'+n+'-'+s)));
    need(names.length===EXPECT_COUNTS[i] && new Set(names).size===names.length,'ASSERTION_SOURCE');
    expected[name]=names;
  }
}
function scenario(raw,name) {
  const v=parse(raw), index=NAMES.indexOf(name), names=expected[name];
  need(exactKeys(v,['scenario','passed','checkTotal','checkFailed','counters','checks']) && v.scenario===name,'SCENE_SHAPE');
  need(typeof v.passed==='boolean' && Number.isSafeInteger(v.checkFailed) && v.checkFailed>=0 && v.checkFailed<=names.length && v.checkTotal===names.length,'SCENE_COUNTS');
  need(Array.isArray(v.checks) && v.checks.length===names.length && v.checks.every((c,i)=>exactKeys(c,['name','passed']) && c.name===names[i] && typeof c.passed==='boolean'),'SCENE_ASSERTIONS');
  need(exactKeys(v.counters,COUNTER_KEYS) && COUNTER_KEYS.every(k=>Number.isSafeInteger(v.counters[k]) && v.counters[k]>=0),'SCENE_COUNTERS');
  const failed=v.checks.filter(c=>!c.passed).map(c=>c.name);
  need(v.checkFailed===failed.length && v.passed===(failed.length===0),'SCENE_CONTRADICTION');
  report.scenarios[name]={status:v.passed?'passed':'failed',passed:v.passed,checkTotal:v.checkTotal,failedChecks:failed,counters:v.counters};
  need(v.passed,'SCENE_FAILED');
  need(COUNTER_KEYS.every((k,i)=>v.counters[k]===EXPECT_COUNTERS[index][i]),'SCENE_COUNTERS');
}
function reason(e) {
  const allowed = new Set(('RUNNER_SEQUENCE RUNNER_PURPOSE CAPABILITY_BLOCKED BUDGET_EXHAUSTED PROCESS_NOT_CLOSED PROCESS_START_FAILED PROCESS_ERROR PROCESS_EXIT OUTPUT_BUFFER OUTPUT_LIMIT PROCESS_STDERR PROCESS_STREAMS STREAM_ERROR PROCESS_TIMEOUT HOST_PATH SOURCE_DRIFT HOST_DRIFT PATH_INVALID ZONE_UNCERTAIN ZONE_PRESENT OUTPUT_DECODE META_SHAPE META_VERSION META_SCOPES POLICY_CHANGED_OR_BLOCKED ZONE_PRESENT_OR_UNCERTAIN ASSERTION_SOURCE SCENE_SHAPE SCENE_COUNTS SCENE_ASSERTIONS SCENE_COUNTERS SCENE_CONTRADICTION SCENE_FAILED ARGUMENT_INVALID OUTPUT_EXISTS PROBE_FAILED FIXED_BINDING POLICY_COMPARISON').split(' '));
  return allowed.has(e?.code) ? e.code : 'UNEXPECTED_LOCAL_FAILURE';
}
// Single promise returned for the OS-boundary synthetic harness; no injectable production capabilities.
(async () => {
  try {
    const args=process.argv.slice(2);
    need(args.length===0 || (args[0]==='--execute' && (args.length===1 || (args.length===3 && args[1]==='--out' && path.resolve(args[2])===OUT))),'ARGUMENT_INVALID');
    execute=args[0]==='--execute';
    if(args.length===3) {
      let exists=false; try {fs.lstatSync(OUT);exists=true;} catch(e){if(e.code!=='ENOENT')throw e;}
      need(!exists,'OUTPUT_EXISTS'); output=OUT;
    }
    probing=true;
    try{cp.execSync('synthetic-denied');}catch(_){}
    try{require('node:https').request('https://synthetic.invalid');}catch(_){}
    probing=false; need(state.probes===2,'PROBE_FAILED');
    phase='sources'; verifySources();
    const source=fs.readFileSync(PS1).toString('utf8');
    need(source.includes("$FixedNodePath = '"+NODE+"'") && source.includes("$FixedNodeSha256 = '"+NODE_SHA+"'"),'FIXED_BINDING');
    assertionNames(source);
    const m={exports:{}};
    vm.runInNewContext('(function(module){'+fs.readFileSync(DECODER).toString('utf8')+'\n})',{Buffer,TextDecoder},{timeout:1000})(m);
    decoder=m.exports; report.hostAndSourceVerified=true;
    if(execute) {
      phase='before'; report.before=metadata(await runFixed('before'),'before'); zoneAbsent();
      phase='temporary'; report.temporary=metadata(await runFixed('temporary'),'temporary');
      sceneStart=Date.now();
      for(const name of NAMES) {
        phase=name; report.scenarios[name].status='running';
        const raw=await runFixed(name); scenario(raw,name);
      }
    }
  } catch(e) {
    probing=false; report.failure={phase,code:reason(e)};
    if(NAMES.includes(phase)) {report.scenarios[phase].status='failed';report.scenarios[phase].passed=false;}
  } finally {
    // After-policy check is cleanup only. Never resume scenes after a failure.
    if(state.attempts.some(a=>a.kind==='temporary')) {
      if(state.attempts.every(a=>a.closed||a.spawnFailed)) {
        try {
          phase='after'; report.after=metadata(await runFixed('after'),'after');
          const before={...report.before}; delete before.zonePresent;
          report.policyComparisonPassed=JSON.stringify(before)===JSON.stringify(report.after);
          need(report.policyComparisonPassed,'POLICY_COMPARISON');
        } catch(e) {report.cleanupFailure={phase:'after',code:reason(e)};}
      } else report.cleanupFailure={phase:'after',code:'PROCESS_NOT_CLOSED'};
    }
    phase='finalization';
    try {
      if(report.hostAndSourceVerified) verifySources();
      report.digests={node:NODE_SHA,ps1:PS1_SHA,decoder:DECODER_SHA,powershellInformational:psHash,
        metadata:hash(META),metadataWithZone:hash(META_ZONE),driver:hash(fs.readFileSync(__filename))};
    } catch(e){report.failure={phase,code:reason(e)};}
    report.elapsedMs=Date.now()-started;
    if(report.elapsedMs>120000) report.failure={phase,code:'BUDGET_EXHAUSTED'};
    report.executionRequested=execute;
    report.allDirectProcessesClosed=state.attempts.every(a=>a.closed||a.spawnFailed);
    report.ok=execute && !report.failure && !report.cleanupFailure && state.unexpected===0
      && report.policyComparisonPassed && NAMES.every(n=>report.scenarios[n].passed)
      && report.allDirectProcessesClosed && state.attempts.every(a=>!a.failed);
    report.exitCode=report.ok ? 0 : !execute && !report.failure && state.unexpected===0 ? 2 : 1;
    try {
      const json=JSON.stringify(report,null,2)+'\n';
      if(output) fs.writeFileSync(output,json,{flag:'wx'});
      process.stdout.write(json); process.exitCode=report.exitCode;
    } catch(_) {process.stdout.write('{"ok":false,"exitCode":1,"failure":{"code":"EVIDENCE_WRITE_FAILED"}}\n');process.exitCode=1;}
  }
})();
