'use strict';
// Read-only review. Target launches are exclusively synthetic; no native fallback.
const guard={probes:0,unexpected:0};let probing=false;
function deny(){guard[probing?'probes':'unexpected']++;throw Error('REVIEW_OS_BLOCKED');}
const cp=require('node:child_process');cp.ChildProcess.prototype.spawn=deny;
const socketProto=require('node:net').Socket.prototype;
for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const id of ['node:http','node:https','node:net','node:tls','node:dgram','node:dns']){
  const m=require(id);if(id==='node:net')m.Socket.prototype.connect=deny;
  if(id==='node:dns')for(const k of Object.keys(m.promises))if(typeof m.promises[k]==='function')m.promises[k]=deny;
  for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});
}globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const H=b=>crypto.createHash('sha256').update(b).digest('hex'),B=x=>Buffer.from(JSON.stringify(x));
const dir=__dirname,modName='CodexL2单根产物绑定与单次驱动v1-20261031.cjs',auditName='CodexL2单根对照离线核验v3-20261031.cjs',compileName='CodexL2单根对照固定编译配置v1-20261031.json',contractName='CodexL2单根对照回执契约v2-20261031.cjs';
const read=n=>fs.readFileSync(path.join(dir,n));const results=[];
function test(name,fn){try{const observation=fn();results.push({name,reproduced:true,observation});}catch(e){results.push({name,reproduced:false,error:e.code||e.message});}}
function product(){const b=Buffer.alloc(1024);b.write('MZ');b.writeUInt32LE(128,60);b.write('PE\0\0',128,'latin1');b.writeUInt16LE(0x8664,132);b.writeUInt16LE(0x20b,152);b.writeUInt32LE(0x1000,128+24+112+14*8);return b;}
const receipt={schema:'codex-l2-root-only-job/1',mode:'rootOnly',outcome:'completed',reason:'NONE',created:true,assigned:true,resumed:true,pid:100,rootExited:true,rootExit:0,jobEmpty:true,totalProcesses:1,activeProcesses:0,killRequested:false,killAccepted:false,readersDone:true,handlesClosed:true,cleanupConfirmed:true,stdoutBytes:12,stderrBytes:0,stdoutBase64:Buffer.from('L2_ROOT_ONLY').toString('base64'),elapsedMs:100,accountingLayoutVerified:true,observation:{failure:'NONE',identityCoverage:true,parentEvidenceComplete:false,notificationCompletenessGuaranteed:false,stopped:true,handlesClosed:true,duplicateNew:false,finalTotal:1,events:[{kind:'NEW',pid:100},{kind:'EXIT',pid:100},{kind:'ACTIVE_ZERO',pid:0}],members:[{pid:100,creationTime:'1',image:'FIXED_NODE',pathClass:'FIXED_NODE_PATH',state:'CAPTURED',root:true,parent:'UNKNOWN',newSeen:true,listed:true,exitSeen:true}]}};
const configRaw=read('CodexL2单根对照固定接口v2-20261031.json'),cfg=JSON.parse(configRaw);
function boundary(opts={}){
  const log={spawn:0,wait:0,kill:0,digests:[],args:null,partialCreation:false};
  return {log,productPath:'C:\\synthetic\\not-the-bound-image.exe',
    digestFile(p){log.digests.push(p);return opts.drift?'mismatch':cfg.sources.find(s=>s.rel===p)?.sha256;},
    receiptExistsBefore(){return !!opts.exists;},
    spawn(a){log.spawn++;log.args=a;if(opts.spawnThrow){log.partialCreation=true;throw Error('SYNTHETIC_PARTIAL_SPAWN');}return {onData(cb){if(opts.subscribeThrow)throw Error('SYNTHETIC_SUBSCRIBE');if(opts.stdout!==null)cb(false,opts.stdout||Buffer.from('not-a-receipt'));}};},
    awaitExit(){log.wait++;if(opts.waitThrow)throw Error('SYNTHETIC_WAIT');return opts.timeout?{timedOut:true}:{status:0,signal:null,closed:true};},
    kill(){log.kill++;return true;},receipt(){return B(receipt);}
  };
}
function capture(fn){try{return {returned:fn()};}catch(e){return {error:e.message,facts:e.facts||null};}}

// Execute the actual submitted audit and its modules in a separate VM realm.
// Builtin process/network providers are inert local mocks; filesystem is whitelist read-only.
function auditVm(compileMutation,contractComment){
  const allowed=new Set([modName,auditName,compileName,contractName,'CodexL2单根对照辅助层v2-20261031.cs','CodexL2单根对照固定接口v2-20261031.json','CodexL2单根对照离线核验v2-20261031.json','CodexL2单根收尾夹具准备v1-20261031.cjs','CodexL2单根收尾合成夹具v1-20261031.cs']);
  const compiled=JSON.parse(read(compileName));if(compileMutation)compileMutation(compiled);
  let output='';const processMock={argv:['synthetic-node',path.join(dir,auditName)],exitCode:0};
  const context=vm.createContext({Buffer,TextDecoder,process:processMock});const cache=new Map();
  const forbidden=()=>{throw Error('VM_FALLBACK_BLOCKED');};const mocks={};
  for(const id of ['child_process','http','https','net','tls','dgram','dns'])mocks['node:'+id]={spawn:forbidden,request:forbidden,connect:forbidden,createConnection:forbidden,lookup:forbidden};
  mocks['node:child_process'].ChildProcess=function(){};mocks['node:child_process'].ChildProcess.prototype.spawn=forbidden;
  mocks['node:net'].Socket=function(){};mocks['node:net'].Socket.prototype.connect=forbidden;mocks['node:dns'].promises={lookup:forbidden};
  function bytes(p){const resolved=path.resolve(String(p)),n=path.basename(resolved);assert.equal(path.dirname(resolved),dir);assert.ok(allowed.has(n));if(n===compileName)return B(compiled);const b=read(n);return n===contractName&&contractComment?Buffer.concat([b,Buffer.from('\n// synthetic source drift\n')]):b;}
  const mockFs={readFileSync(p,encoding){const b=bytes(p);return encoding?b.toString(encoding):b;},existsSync(){return false;},writeFileSync:forbidden,writeSync(fd,data){assert.equal(fd,1);output+=String(data);}};
  function load(n){if(cache.has(n))return cache.get(n).exports;const module={exports:{}};cache.set(n,module);const source=bytes(path.join(dir,n)).toString('utf8');
    const requireMock=id=>{if(id==='node:fs')return mockFs;if(id==='node:path')return path;if(id==='node:crypto')return crypto;if(id==='node:assert/strict')return assert;if(mocks[id])return mocks[id];assert.ok(id.startsWith('./'));return load(path.basename(id));};
    context.__load={module,requireMock,filename:path.join(dir,n),dirname:dir};
    new vm.Script('(function(require,module,exports,__filename,__dirname){'+source+'\n})(__load.requireMock,__load.module,__load.module.exports,__load.filename,__load.dirname);',{filename:n}).runInContext(context,{timeout:3000});return module.exports;
  }
  load(auditName);const report=JSON.parse(output);return {ok:report.ok,exit:processMock.exitCode,checks:report.checks,failed:report.results?.filter(x=>!x.ok).map(x=>x.name),basis:report.basisCommit,implementation:report.reviewedImplementation};
}
try{
  const args=process.argv.slice(2);assert.ok(args.length===0||args.length===2&&args[0]==='--out'&&args[1].trim()&&!args[1].startsWith('--'));if(args.length)assert.equal(fs.existsSync(args[1]),false);
  probing=true;for(const fn of [()=>cp.spawn('blocked'),()=>require('node:https').request('blocked'),()=>socketProto.connect(),()=>require('node:dns').promises.lookup('blocked'),()=>fetch('blocked')])assert.throws(fn,/REVIEW_OS_BLOCKED/);probing=false;
  assert.equal(H(read(modName)),'9896ed2c5345c5e495d349ef7a512d1777f304490909781ca02c764189fbeff6');
  assert.equal(H(read(auditName)),'a54d162229441c2176fe9f8bb1769e6134bb3467b5a9025873ce564442ca2586');
  const m=require('./'+modName),bind=()=>m.bind(configRaw,product());
  test('normal synthetic control',()=>{const b=boundary(),r=m.createRunner(bind(),b).runOnce();assert.equal(r.ok,true);return {ok:r.ok,spawn:b.log.spawn};});
  for(const [name,opts]of [['source drift before spawn',{drift:true}],['receipt exists before spawn',{exists:true}]])test(name,()=>{const b=boundary(opts),r=capture(()=>m.createRunner(bind(),b).runOnce());assert.equal(b.log.spawn,1);assert.equal(r.error,'DRIVER_FAILED');return {spawn:b.log.spawn,error:r.error};});
  test('unbound target path never hashed',()=>{const binding=bind(),b=boundary();const r=m.createRunner(binding,b).runOnce();assert.equal(r.ok,true);assert.equal(b.log.digests.includes(b.productPath),false);return {ok:r.ok,targetPathChecked:false,digestQueries:b.log.digests.length};});
  test('forged binding overrides purpose and removes source checks',()=>{const b=boundary(),fake={artifactBound:true,productBytes:true,artifactSha256:'invented',config:{...cfg,sources:[],cwd:'C:\\synthetic\\other',helperArgs:['not-rootOnly']}};const r=m.createRunner(fake,b).runOnce();assert.equal(r.ok,true);assert.deepEqual(b.log.args.args,['not-rootOnly']);return {ok:r.ok,unapprovedArgsDelivered:true,digestQueries:b.log.digests.length};});
  test('bound byte buffer mutable after hashing',()=>{const bytes=product(),binding=m.bind(configRaw,bytes);bytes.fill(0);assert.notEqual(H(binding.productBytes),binding.artifactSha256);const r=m.createRunner(binding,boundary()).runOnce();assert.equal(r.ok,true);return {ok:r.ok,storedHashDiffersFromBytes:true};});
  test('same binding creates two successful runners',()=>{const binding=bind(),a=boundary(),b=boundary();assert.equal(m.createRunner(binding,a).runOnce().ok,true);assert.equal(m.createRunner(binding,b).runOnce().ok,true);return {spawns:a.log.spawn+b.log.spawn};});
  test('minimal PE with no sections or CLR bytes binds',()=>{const b=product(),r=m.inspectProduct(b);assert.equal(b.readUInt16LE(134),0);assert.equal(b.readUInt16LE(148),0);return {accepted:r.clrHeaderPresent,sectionCount:0,optionalHeaderSize:0,clrRvaBeyondFile:true};});
  test('no stdout yet unrelated valid receipt gives success',()=>{const r=m.createRunner(bind(),boundary({stdout:null})).runOnce();assert.equal(r.ok,true);return {ok:r.ok,observedStdoutBytes:0};});
  test('wrong stdout yet unrelated valid receipt gives success',()=>{const r=m.createRunner(bind(),boundary({stdout:Buffer.from('wrong')})).runOnce();assert.equal(r.ok,true);return {ok:r.ok,observedStdoutBytes:5};});
  for(const [name,opts,error]of [['subscribe throws',{subscribeThrow:true},'SYNTHETIC_SUBSCRIBE'],['wait throws',{waitThrow:true},'SYNTHETIC_WAIT']])test(name,()=>{const b=boundary(opts),r=capture(()=>m.createRunner(bind(),b).runOnce());assert.equal(r.error,error);assert.equal(b.log.kill,0);assert.equal(r.facts,null);return {spawn:b.log.spawn,kill:b.log.kill,error:r.error,factsAttached:false};});
  test('output overflow does not stop the synthetic child',()=>{const b=boundary({stdout:Buffer.alloc(131073)}),r=capture(()=>m.createRunner(bind(),b).runOnce());assert.equal(r.facts.failure,'OUTPUT_LIMIT');assert.equal(b.log.kill,0);return {failure:r.facts.failure,kill:b.log.kill};});
  test('timeout kill has no subsequent close observation',()=>{const b=boundary({timeout:true}),r=capture(()=>m.createRunner(bind(),b).runOnce());assert.equal(b.log.kill,1);assert.equal(b.log.wait,1);assert.equal(r.facts.closed,false);return {kill:1,wait:1,closed:false,killAcceptedRecorded:Object.hasOwn(r.facts,'killAccepted')};});
  test('spawn setup throw is labelled closed without observing close',()=>{const b=boundary({spawnThrow:true}),r=capture(()=>m.createRunner(bind(),b).runOnce());assert.equal(r.facts.closed,true);assert.equal(b.log.wait,0);assert.equal(b.log.kill,0);return {partialCreation:b.log.partialCreation,closedClaim:true,wait:0,kill:0};});
  test('compile source closure missing observer',()=>{const c=JSON.parse(read(compileName)),s=read('CodexL2单根对照辅助层v2-20261031.cs').toString('utf8'),h=c.cases.find(x=>x.id==='rootOnlyHelper');assert.ok(s.includes('new L2MemberObserver(job)'));assert.equal(h.sourceFiles.length,1);assert.equal(h.args.some(x=>x.includes('观察器')),false);return {helperNeedsObserver:true,observerSourceInArgs:false,observerHashInInputs:c.inputs.some(x=>x.path.includes('观察器'))};});
  test('actual audit VM normal control',()=>{const r=auditVm();assert.equal(r.ok,true);assert.equal(r.checks,41);return r;});
  for(const [name,change]of [
    ['compiler path override',c=>c.toolFacts.compiler.path='C:\\synthetic\\unapproved.exe'],
    ['extra source and unsafe argument',c=>{c.cases[0].args.push('/unsafe+','C:\\synthetic\\unapproved.cs');}],
    ['environment and timeout override',c=>{c.cases[0].childEnv.NODE_OPTIONS='unapproved';c.spawn.timeoutMs=999999;}],
    ['input absolute path moved but same basename',c=>{c.inputs[0].path='C:\\synthetic\\'+path.basename(c.inputs[0].path);}],
    ['contract bytes drift',null]
  ])test('audit accepts '+name,()=>{const r=auditVm(change,name==='contract bytes drift');assert.equal(r.ok,true);assert.equal(r.exit,0);assert.equal(r.checks,41);return r;});
  const runtimeDigests={module:H(read(modName)),audit:H(read(auditName)),compileConfig:H(read(compileName)),contract:H(read(contractName)),self:H(fs.readFileSync(__filename))};
  const ok=results.every(x=>x.reproduced)&&guard.unexpected===0;
  const report={schema:'codex-rootonly-review-counterexamples/1',reviewedCommit:'4dbb317',basis:'7ed221f',kind:'source review plus actual JS modules with synthetic boundaries; VM audit uses read-only substitutions',checks:results.length,results,guard,runtimeDigests,ok,exitCode:ok?0:1,compiled:false,nativeLaunched:false,executionApproved:false};
  const text=JSON.stringify(report,null,2)+'\n';if(args.length)fs.writeFileSync(args[1],text,{flag:'wx'});fs.writeSync(1,text);process.exitCode=report.exitCode;
}catch(e){probing=false;fs.writeSync(1,JSON.stringify({ok:false,error:e.code||e.message,guard})+'\n');process.exitCode=1;}
