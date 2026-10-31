'use strict';
// Independent review of 70b1f76. Real JS modules; inert OS boundaries only.
// Common guard/PE/receipt doubles copied from the prior review, not imported.
// Counterexample success means a reviewed defect reproduced, NOT product approval.
const guard = { probes: 0, unexpected: 0 }; let probing = false;
function deny() { guard[probing ? 'probes' : 'unexpected']++; throw Error('REVIEW_OS_BLOCKED'); }
const cp = require('node:child_process'); cp.ChildProcess.prototype.spawn = deny;
const socketProto = require('node:net').Socket.prototype;
for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = deny;
for (const id of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns']) {
  const m = require(id);
  if (id === 'node:net') m.Socket.prototype.connect = deny;
  if (id === 'node:dns') for (const k of Object.keys(m.promises)) if (typeof m.promises[k] === 'function') m.promises[k] = deny;
  for (const k of Object.keys(m)) if (typeof m[k] === 'function') Object.defineProperty(m, k, { value: deny, configurable: true });
}
globalThis.fetch = deny;
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm'), assert = require('node:assert/strict');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const dir = __dirname, root = path.resolve(dir, '../..');
const names = {
  driver: 'CodexL2单根产物绑定与单次驱动v4-20261031.cjs',
  audit: 'CodexL2单根对照离线核验v6-20261031.cjs',
  ccfg: 'CodexL2单根对照固定编译配置v3-20261031.json',
  contract: 'CodexL2单根对照回执契约v2-20261031.cjs',
  config: 'CodexL2单根对照固定接口v2-20261031.json',
  run: 'CodexL2单根Run合成边界夹具v4-20261031.cs'
};
const read = n => fs.readFileSync(path.join(dir, n));
const results = [];
function test(name, fn) { try { results.push({ name, matched: true, facts: fn() }); } catch (e) { results.push({ name, matched: false, error: e.code || e.message }); } }
function capture(fn) { try { return { value: fn() }; } catch (e) { return { error: e.message, facts: e.facts || null, report: e.report || null }; } }
function product() {
  const b = Buffer.alloc(0x800), pe = 0x80, opt = pe + 24, sect = opt + 240;
  b.write('MZ'); b.writeUInt32LE(pe, 60); b.write('PE\0\0', pe, 'latin1');
  b.writeUInt16LE(0x8664, pe + 4); b.writeUInt16LE(3, pe + 6); b.writeUInt16LE(240, pe + 20); b.writeUInt16LE(0x20b, opt);
  b.writeUInt32LE(0x800, opt + 56); b.writeUInt32LE(0x400, opt + 60);
  for (let i = 0; i < 3; i++) {
    b.writeUInt32LE(0x400, sect + i * 40 + 8); b.writeUInt32LE(0x1000 + i * 0x400, sect + i * 40 + 12);
    b.writeUInt32LE(0x200, sect + i * 40 + 16); b.writeUInt32LE(0x200 + i * 0x200, sect + i * 40 + 20);
  }
  b.writeUInt32LE(0x1000, opt + 112 + 14 * 8); b.writeUInt32LE(0x48, opt + 112 + 14 * 8 + 4);
  b.writeUInt32LE(0x48, 0x200); b.writeUInt16LE(2, 0x204); return b;
}
const configRaw = read(names.config), cfg = JSON.parse(configRaw);
const receipt = {
  schema: 'codex-l2-root-only-job/1', mode: 'rootOnly', outcome: 'completed', reason: 'NONE',
  created: true, assigned: true, resumed: true, pid: 100, rootExited: true, rootExit: 0, jobEmpty: true,
  totalProcesses: 1, activeProcesses: 0, killRequested: false, killAccepted: false, readersDone: true,
  handlesClosed: true, cleanupConfirmed: true, stdoutBytes: 12, stderrBytes: 0,
  stdoutBase64: Buffer.from('L2_ROOT_ONLY').toString('base64'), elapsedMs: 100, accountingLayoutVerified: true,
  observation: { failure: 'NONE', identityCoverage: true, parentEvidenceComplete: false, notificationCompletenessGuaranteed: false,
    stopped: true, handlesClosed: true, duplicateNew: false, finalTotal: 1,
    events: [{ kind: 'NEW', pid: 100 }, { kind: 'EXIT', pid: 100 }, { kind: 'ACTIVE_ZERO', pid: 0 }],
    members: [{ pid: 100, creationTime: '1', image: 'FIXED_NODE', pathClass: 'FIXED_NODE_PATH', state: 'CAPTURED', root: true, parent: 'UNKNOWN', newSeen: true, listed: true, exitSeen: true }] }
};
function boundary(o = {}) {
  const log = { spawn: 0, kill: 0, wait: 0, hold: 0, release: 0, heldPath: null, spawnPath: null, args: null, killAtFirstWait: null };
  return {
    log, productPath: path.join(root,'artifacts/psr-l2/rootonly-v3-helper/rootonly-helper.exe'),
    receiptExistsBefore() { return !!o.exists; }, guardUnexpected() { return 0; },
    digestFile(p) {
      if (o.postDigestThrow && log.spawn) throw Error('SYNTHETIC_DIGEST_ERROR');
      const s = cfg.sources.find(x => x.rel === p); return s ? (o.drift ? 'drift' : s.sha256) : H(product());
    },
    holdProduct(p) { log.hold++; log.heldPath = p; return { sha256: o.badDigest ? 'wrong' : H(product()), holdToken: {} }; },
    releaseHold() { log.release++; if (o.releaseThrow) throw Error('SYNTHETIC_RELEASE_ERROR'); return o.releaseFalse ? false : true; },
    spawn(a) { log.spawn++; log.spawnPath = a.artifactPath; log.args = a.args; return { onData(cb) {
      if (o.subscribeThrow) throw Error('SYNTHETIC_SUBSCRIBE_ERROR');
      cb(false, o.stdout === undefined ? Buffer.from(JSON.stringify(receipt)) : o.stdout);
    } }; },
    awaitExit() {
      log.wait++; if (log.wait === 1) log.killAtFirstWait = log.kill;
      if (o.waitThrow) throw Error('SYNTHETIC_WAIT_ERROR');
      return o.timeout ? { timedOut: true, closed: false } : { status: 0, signal: null, closed: true };
    },
    kill() { log.kill++; if (o.killThrow) throw Error('SYNTHETIC_KILL_ERROR'); return true; }
  };
}

names.checker = 'CodexL2单根编译配置严格检查v2-20261031.cjs';
names.prep = 'CodexL2单根Run合成边界准备v4-20261031.cjs';
function auditVm(mode='normal',fault=null) {
  let output='',fallback=0,injected=false;
  const cache=new Map(),mocks={},calls=[];
  const no=()=>{fallback++;throw Error('INDEPENDENT_VM_OS_BLOCKED');};
  for(const id of ['child_process','http','https','net','tls','dgram','dns']){
    mocks['node:'+id]={};
    for(const k of ['request','get','connect','createConnection','createSocket','lookup','resolve','resolve4','spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])mocks['node:'+id][k]=no;
  }
  mocks['node:child_process'].ChildProcess=function(){};mocks['node:child_process'].ChildProcess.prototype.spawn=no;
  mocks['node:net'].Socket=function(){};mocks['node:net'].Socket.prototype.connect=no;
  mocks['node:dns'].promises={lookup:no,resolve:no,resolve4:no};
  const exe='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
  const vmExit={};
  const proc={execPath:exe,argv:[exe,path.join(dir,names.audit)],exitCode:null,exit(n){this.exitCode=n;throw vmExit;}};
  if(fault)proc.argv.push('--fault',fault);
  mocks['node:child_process'].spawnSync=(program,args,opts)=>{
    assert.equal(program,exe);assert.equal(args[0],path.join(dir,names.audit));assert.equal(args[1],'--fault');assert.equal(args.length,3);
    calls.push({args:args.slice(),options:opts});
    if(mode==='childMismatch')return {status:0,stdout:Buffer.from('{"ok":true,"exitCode":0,"guard":{"unexpected":0}}'),stderr:Buffer.alloc(0)};
    if(mode==='childMalformed')return {status:1,stdout:Buffer.from('not-json'),stderr:Buffer.alloc(0)};
    const r=auditVm('child',args[2]);assert.equal(r.fallback,0);return {status:r.exit,stdout:Buffer.from(JSON.stringify(r.report)),stderr:Buffer.alloc(0)};
  };
  const ctx=vm.createContext({Buffer,TextDecoder,process:proc,fetch:no});
  const meta=new Set([path.join(root,'AGENTS.md'),path.join(root,'.git','HEAD')]);
  const head=fs.readFileSync(path.join(root,'.git','HEAD'),'utf8').trim();if(head.startsWith('ref: '))meta.add(path.join(root,'.git',head.slice(5)));
  const fakeFs={readFileSync(p,enc){p=path.resolve(String(p));assert.ok(meta.has(p)||path.dirname(p)===dir&&/^CodexL2.*\.(cs|cjs|json)$/.test(path.basename(p)),'VM_READ_SCOPE');
    if(mode==='lateIdentity'&&!injected&&p===path.join(root,'AGENTS.md')){injected=true;try{mocks['node:https'].request('synthetic-denied');}catch(_){}}
    const b=fs.readFileSync(p);return enc?b.toString(enc):b;
  },writeSync(fd,s){assert.equal(fd,1);output+=String(s);},existsSync(){return false;},openSync:no,writeFileSync:no,closeSync:no};
  const fakeVm={Script:class{constructor(s,o){this.s=new vm.Script(s,o);}runInThisContext(){return this.s.runInContext(ctx,{timeout:3000});}}};
  function req(id){if(id==='node:fs')return fakeFs;if(id==='node:path')return path;if(id==='node:crypto')return crypto;if(id==='node:vm')return fakeVm;if(id==='node:assert/strict')return assert;if(mocks[id])return mocks[id];assert.ok(id.startsWith('./'));return load(path.basename(id));}
  function load(n){if(cache.has(n))return cache.get(n).exports;const mod={exports:{}};cache.set(n,mod);let s=fakeFs.readFileSync(path.join(dir,n),'utf8');
    if(n===names.audit&&mode==='dnsResolve4')s=s.replace('const failed = results.filter',"try {require('node:dns').promises.resolve4('synthetic');}catch(_){}\nconst failed = results.filter");
    const fn=new vm.Script('(function(require,module,exports,__dirname,__filename){\n'+s+'\n})',{filename:n}).runInContext(ctx,{timeout:3000});fn(req,mod,mod.exports,dir,path.join(dir,n));return mod.exports;}
  try{load(names.audit);}catch(e){if(e!==vmExit)throw e;}return {report:JSON.parse(output.trim()),exit:proc.exitCode,fallback,injected,calls};
}
try{
 const argv=process.argv.slice(2);assert.ok(argv.length===0||argv.length===2&&argv[0]==='--out'&&argv[1].trim());if(argv.length)assert.equal(fs.existsSync(argv[1]),false);
 probing=true;for(const f of [()=>cp.spawn('blocked'),()=>require('node:https').request('blocked'),()=>socketProto.connect(),()=>require('node:dns').promises.lookup('blocked'),()=>fetch('blocked')])assert.throws(f,/REVIEW_OS_BLOCKED/);probing=false;
 const pins={driver:'4ef8d079e98341cc014c2786bb3fad45964b1d1063c5cc50bbbb5a997a64ad30',checker:'59fbe641bd9e39b6e4a752a5c0828b589b3d4273160a2aa4861f5a155be6ae15',prep:'2065c2d34c35b6c862781cd034031244f1e40010f7706bc2d97afcd820525062',run:'4904cabd863ddd133ba9f9e9fe9407b94fcaeff3d113a045b1bce54165f73416'};
 pins.audit='03ff20b3e54aa6321c34e3cb2994cc8caffc5cbe0021e38816f9068c2113e3e8';
 for(const[k,v]of Object.entries(pins))assert.equal(H(read(names[k])),v,'REVIEW_SOURCE_DRIFT:'+k);
 const m=require('./'+names.driver),checker=require('./'+names.checker),prep=require('./'+names.prep);
 const provenance=()=>({configRel:'docs/证据/'+names.config,artifactRelPath:'artifacts/psr-l2/rootonly-v3-helper/rootonly-helper.exe',configSha256:H(configRaw),compiled:false,executed:false});
 const bind=()=>m.bind(configRaw,product(),provenance());
 test('closed R1: fixed path and ordinary provenance mutation',()=>{const p=provenance(),b=m.bind(configRaw,product(),p);p.configRel='changed';assert.notEqual(b.configRel,'changed');const wrong=boundary();wrong.productPath='C:\\synthetic\\other.exe';assert.throws(()=>m.createRunner(b,wrong),/PROVENANCE_PATH_MISMATCH/);assert.equal(wrong.log.spawn,0);assert.equal(m.createRunner(bind(),boundary()).runOnce().ok,true);return {closed:true};});
 test('R1 provenance validates before second read snapshot',()=>{const p=provenance(),original=p.configRel;let reads=0;Object.defineProperty(p,'configRel',{get(){return ++reads===1?original:'synthetic-unreviewed';}});const b=m.bind(configRaw,product(),p);assert.equal(b.configRel,'synthetic-unreviewed');assert.equal(reads,2);return {acceptedWrongProvenance:true,reads};});
 test('closed R2: unconfirmed close reaps and positive initial counter refuses',()=>{const b=boundary();b.awaitExit=()=>{b.log.wait++;return {closed:false,status:0};};const r=capture(()=>m.createRunner(bind(),b).runOnce());assert.equal(r.facts.failure,'CLOSE_UNCONFIRMED');assert.equal(b.log.kill,1);assert.equal(b.log.wait,2);const pre=boundary();pre.guardUnexpected=()=>1;assert.equal(capture(()=>m.createRunner(bind(),pre).runOnce()).error,'GUARD_UNEXPECTED_PRE');assert.equal(pre.log.spawn,0);return b.log;});
 for(const mode of ['invalidInitial','invalidFinal'])test('R2 invalid guard observation accepted: '+mode,()=>{const b=boundary();let n=0;b.guardUnexpected=()=>++n===(mode==='invalidInitial'?1:2)?'synthetic-invalid':0;const r=m.createRunner(bind(),b).runOnce();assert.equal(r.ok,true);return {ok:r.ok,unexpected:r.facts.unexpected,launches:b.log.spawn};});
 test('closed R3: object/getter/toJSON rejected without invocation and immutable selection',()=>{let reads=0;const x={get host(){reads++;throw Error('getter');},toJSON(){reads++;throw Error('toJSON');}};assert.throws(()=>checker.strictCheck(x),/CONFIG_WIRE/);assert.equal(reads,0);assert.equal(checker.expectedConfig,undefined);assert.equal(typeof checker.expectedConfigJson,'string');const p=checker.selectSingleTarget(read(names.ccfg),'runBoundaryFixture');assert.throws(()=>p.args.push('unapproved'));return {closed:true};});
 test('R5 compile selection still targets previous broken fixture',()=>{const p=checker.selectSingleTarget(read(names.ccfg),'runBoundaryFixture');assert.ok(p.sourceFiles.some(x=>x.endsWith('夹具v3-20261031.cs')));assert.equal(p.sourceFiles.some(x=>x.endsWith('夹具v4-20261031.cs')),false);return {selected:p.sourceFiles,currentReviewedFixture:names.run};});
 for(const mode of ['normal','childMismatch','childMalformed','lateIdentity','dnsResolve4'])test('R4 actual parent verdict in isolated full-script VM: '+mode,()=>{const r=auditVm(mode);assert.equal(r.report.checks,29);assert.equal(r.report.failedChecks.length,0);assert.equal(r.report.ok,true);assert.equal(r.exit,0);
  if(mode==='normal'){assert.equal(r.report.reentry.attempts,7);assert.equal(r.report.reentry.failed,7);assert.ok(r.report.reentry.faultOutcomes.every(x=>x.passed));}
  if(mode==='childMismatch'||mode==='childMalformed')assert.ok(r.report.reentry.faultOutcomes.every(x=>!x.passed));
  if(mode==='lateIdentity')assert.equal(r.report.guard.unexpected,1);
  if(mode==='dnsResolve4'){assert.equal(r.fallback,1);assert.equal(r.report.guard.unexpected,0);}else assert.equal(r.fallback,0);
  assert.ok(r.calls.every(x=>x.options.timeout===undefined&&x.options.maxBuffer===undefined&&x.options.env===undefined));
  return {ok:r.report.ok,exit:r.exit,guard:r.report.guard,reentry:r.report.reentry,fallback:r.fallback,runnerOptions:r.calls[0].options};
 });
 const src=read(names.run).toString('utf8');
 test('closed R5: corrected scope/env, Output and close removal detected',()=>{assert.equal(prep.ENV_FREE_EXPECT[0],1);assert.deepEqual(prep.inspect(src),[]);assert.ok(prep.inspect(src.replace('Hook.ReadChunk(handle, buffer, out count)','ReadFile(handle, buffer, out count)')).includes('CAPABILITY_REMAINS_OUTPUT'));const bad=src.replace(/r\.HandlesClosed=\(Close\(ref pi\.Thread,r\)[^;]+;/,'r.HandlesClosed=true;');assert.notEqual(bad,src);assert.ok(prep.inspect(bad).some(x=>x.startsWith('CLOSE_CALLS_COUNT')));return {sourceChecksOnly:true};});
 test('R5 Pipe failure produces unowned handles used by real finally',()=>{assert.ok(src.includes('r=new IntPtr(30+pipeSeq*2);w=new IntPtr(31+pipeSeq*2);pipeSeq++'));assert.ok(src.includes('if(!Want("PIPE")){Opened.Add(r);Opened.Add(w);return true;}'));assert.ok(src.includes('foreach(IntPtr x in Closed){bool known=false;'));assert.ok(src.includes('Close(ref rd,r)&Close(ref wr,r)'));return {sourceOnly:true,failedPipeOutputs:[30,31],opened:[],finallyAttemptsCloseUnowned:true,csharpExecuted:false};});
 test('R5 JSON scalar fields now encoded as strings',()=>{assert.ok(src.includes('static string J(string k,string v){return JsonQ(k)+":"+JsonQ(v);}'));assert.ok(src.includes('J("ok","false")'));assert.ok(src.includes('J("passed",passed.ToString())'));const projected=JSON.parse('{"ok":"false","passed":"1","executedProductionHelper":"false"}');assert.equal(typeof projected.ok,'string');assert.equal(Boolean(projected.ok),true);return {sourceProjection:projected,csharpExecuted:false};});
 test('R5 source accessibility remains inconsistent',()=>{for(const t of ['ExtendedLimit','Startup','ProcessInfo'])assert.ok(src.includes('struct '+t+' {'));assert.ok(src.includes('internal static class Hook'));assert.ok(src.includes('public static bool JobSet(ExtendedLimit l)'));assert.ok(src.includes('public static object StartReader(Output o,'));assert.ok(src.includes('sealed class Output {'));return {sourceOnly:true,privateNestedTypesInInternalPublicSignatures:true,csharpCompiled:false};});
 const digests=Object.fromEntries(Object.entries(names).map(([k,n])=>[k,H(read(n))]));
 const ok=results.every(x=>x.matched)&&guard.probes===5&&guard.unexpected===0;const report={schema:'codex-l2-70b1f76-independent-review/1',reviewedCommit:'70b1f76',ok,exitCode:ok?0:1,checks:results.length,guard,digests,results,limitations:['VM child re-entry runs actual submitted JS recursively in inert realms; zero real process starts.','C# findings are source analysis, not compiler/runtime results.','Matched counterexamples are not acceptance or execution approval.']};
 const out=JSON.stringify(report,null,2)+'\n';if(argv.length)fs.writeFileSync(argv[1],out,{flag:'wx'});else fs.writeSync(1,out);process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,error:e.message,guard})+'\n');process.exitCode=1;}
