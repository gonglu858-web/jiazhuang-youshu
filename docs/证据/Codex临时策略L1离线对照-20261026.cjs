'use strict';
// Actual driver inside isolated VM; no real OS command or policy operation.
const cp=require('node:child_process'), net=require('node:net');
let fallbackHits=0;
function offline(){fallbackHits++;throw Error('OFFLINE_FALLBACK');}
const cpKeys=Object.keys(cp).filter(k=>typeof cp[k]==='function');
for(const k of cpKeys)cp[k]=offline;
const netIds=['node:http','node:https','node:tls','node:dgram','node:dns'], netKeys={};
for(const id of netIds){const m=require(id);netKeys[id]=Object.keys(m).filter(k=>typeof m[k]==='function');for(const k of netKeys[id])Object.defineProperty(m,k,{value:offline,configurable:true});}
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=offline;
net.connect=net.createConnection=net.createServer=offline;net.Socket.prototype.connect=offline;globalThis.fetch=offline;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const ROOT=path.resolve(__dirname,'../..'),DRIVER=path.join(__dirname,'Codex临时策略L1-20261026.cjs'),OUT=DRIVER.replace(/\.cjs$/,'.json');
const NODE='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe',PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PS1=path.join(ROOT,'miniapp/scripts/participant-private-input.ps1'),DECODER=path.join(ROOT,'miniapp/scripts/lib/participant-native-decoder.cjs');
const cache=new Map([DRIVER,NODE,PS,PS1,DECODER].map(p=>[p,fs.readFileSync(p)]));
const source=cache.get(DRIVER).toString('utf8'),ps1Source=cache.get(PS1).toString('utf8');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const names=['N1_SAVE','N1_ECHO','N2_DECL','N3_FILE','N4_DRIFT','N5_STARTFAIL','N6_TRANSPORT'];
const counts=[19,15,15,34,12,9,17];
const counters=[[1,0,1,1,1,1,1,1],[1,0,1,1,1,1,1,0],[0,0,0,0,0,0,0,0],[1,1,0,0,0,0,0,0],[1,0,1,1,1,1,1,1],[1,0,1,1,1,1,0,0],[1,0,1,1,1,1,1,0]];
const keys=['fileProbe','digestProbe','digestHold','holdOpens','holdCloses','startCalls','starts','stdinWrites'];
const expected={};
for(let i=0;i<names.length;i++){
  const begin=ps1Source.indexOf("  if ($SelfTestScenario -eq '"+names[i]+"') {");
  const end=i+1<names.length?ps1Source.indexOf("  if ($SelfTestScenario -eq '"+names[i+1]+"') {",begin+1):ps1Source.indexOf('  $failedChecks =',begin);
  const a=Array.from(ps1Source.slice(begin,end).matchAll(/Add-Check '([^']+)'/g),m=>m[1]);
  if(i===2)a.splice(2,0,...['explicit-empty','relative','other-exe','other-node','splice-suffix','splice-space','nul','newline'].map(n=>'decl-reject-'+n));
  if(i===3)a.unshift(...['missing','directory','reparse-file','reparse-chain','facts-read-fail','hold-open-fail','digest-mismatch','digest-read-fail'].flatMap(n=>['rejected','label-exact','zero-start-stdin','hold-count'].map(s=>'n3-'+n+'-'+s)));
  assert.equal(a.length,counts[i]);expected[names[i]]=a;
}
const dirs=new Set();for(const p of cache.keys()){let d=path.dirname(p);while(!dirs.has(d)){dirs.add(d);const up=path.dirname(d);if(up===d)break;d=up;}}
function meta(kind){return {schema:'codex-l1-environment/1',version:'5.1.26100.9711',effectivePolicy:kind==='temporary'?'RemoteSigned':'Restricted',policies:['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'].map(scope=>({scope,policy:kind==='temporary'&&scope==='Process'?'RemoteSigned':'Undefined'})),...(kind==='before'?{zonePresent:false}:{})};}
function scene(n){const i=names.indexOf(n);return {scenario:n,passed:true,checkTotal:counts[i],checkFailed:0,counters:Object.fromEntries(keys.map((k,j)=>[k,counters[i][j]])),checks:expected[n].map(name=>({name,passed:true}))};}
const cases=[
  ['normal',null,10],['defaultNoExecute',null,0],['normalOut',null,10],
  ['badCli','ARGUMENT_INVALID',0],['policyCli','ARGUMENT_INVALID',0],['extraCli','ARGUMENT_INVALID',0],['badOut','ARGUMENT_INVALID',0],['outputExists','OUTPUT_EXISTS',0],
  ['hostPath','HOST_PATH',0],['nodeDrift','SOURCE_DRIFT',0],['ps1Drift','SOURCE_DRIFT',0],['decoderDrift','SOURCE_DRIFT',0],['hostLink','PATH_INVALID',0],
  ['baselinePolicy','POLICY_CHANGED_OR_BLOCKED',1],['groupPolicy','POLICY_CHANGED_OR_BLOCKED',1],['version','META_VERSION',1],['metaExtra','META_SHAPE',1],['scopes','META_SCOPES',1],['zoneReported','ZONE_PRESENT_OR_UNCERTAIN',1],
  ['zoneLocal','ZONE_PRESENT',1],['zoneError','ZONE_UNCERTAIN',1],['temporaryPolicy','POLICY_CHANGED_OR_BLOCKED',3],['afterPolicy', 'POLICY_CHANGED_OR_BLOCKED',10],
  ['beforeThrow','PROCESS_START_FAILED',1],['beforeError','PROCESS_START_FAILED',1],['beforeExit','PROCESS_EXIT',1],['beforeTimeout','PROCESS_TIMEOUT',1],['beforeNoClose','PROCESS_NOT_CLOSED',1],
  ['temporaryTimeout','PROCESS_TIMEOUT',3],['temporaryNoClose','PROCESS_NOT_CLOSED',2],['sceneNoClose','PROCESS_NOT_CLOSED',3],
  ['sceneSignal','PROCESS_EXIT',4],['sceneExit','PROCESS_EXIT',4],['sceneStderr','PROCESS_STDERR',4],['sceneLimit','OUTPUT_LIMIT',4],['sceneBuffer','OUTPUT_BUFFER',4],['sceneStream','STREAM_ERROR',4],
  ['sceneJson','OUTPUT_DECODE',4],['sceneUtf8','OUTPUT_DECODE',4],['sceneReplacement','OUTPUT_DECODE',4],['sceneWrong','SCENE_SHAPE',4],['sceneMissing','SCENE_ASSERTIONS',4],
  ['sceneDuplicate','SCENE_ASSERTIONS',4],['sceneType','SCENE_ASSERTIONS',4],['sceneFail','SCENE_FAILED',4],['sceneContradiction','SCENE_CONTRADICTION',4],['sceneCount','SCENE_COUNTS',4],['sceneCounter','SCENE_COUNTERS',4],
  ['stageDrift','SOURCE_DRIFT',1],['preSceneZone','ZONE_PRESENT',3],['lastSceneFail','SCENE_FAILED',10],
  ['initHit','CAPABILITY_BLOCKED',0],['businessHit',null,4],['finalDigestHit',null,10],['digestComputeHit',null,10],['finalizationHit',null,10],
  ['publicSpawn',null,4],['socketHit',null,4],['dnsHit',null,4],['fetchHit',null,4],['outputRace','EVIDENCE_WRITE_FAILED',10]
];
const results=[];
async function test([name,error,callCount]){
  const modules={};for(const id of netIds)modules[id]=Object.fromEntries(netKeys[id].map(k=>[k,offline]));
  modules['node:dns'].promises={lookup:offline};function Socket(){} Socket.prototype.connect=offline;
  modules['node:net']={Socket,connect:offline,createConnection:offline,createServer:offline};
  const fakeCp=Object.fromEntries(cpKeys.map(k=>[k,offline]));let context,output='',saved=null,calls=[],writes=0,reads=new Map(),injected=false,opens=0;
  function inject(type='https'){
    if(injected)return;injected=true;
    try{if(type==='spawn')fakeCp.spawn('SECRET_SENTINEL',[]);else if(type==='socket')new modules['node:net'].Socket().connect(1);else if(type==='dns')modules['node:dns'].promises.lookup('synthetic');else if(type==='fetch')vm.runInContext("fetch('synthetic')",context);else modules['node:https'].request('synthetic');}catch(_){}
  }
  fakeCp.spawn=(exe,args,opts)=>{
    assert.equal(exe,PS);assert.equal(opts.cwd,ROOT);assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);assert.deepEqual(Array.from(opts.stdio),['ignore','pipe','pipe']);
    assert.equal(opts.env.NODE_OPTIONS,undefined);assert.equal(opts.env.SYNTHETIC_KEEP,'1');assert.equal(opts.env.PSExecutionPolicyPreference,undefined);assert.equal(opts.encoding,undefined);
    let kind;
    if(args.includes('-File'))kind=args.at(-1);
    else kind=args.includes('-ExecutionPolicy')?'temporary':calls.length===0?'before':'after';
    const metadataString=vm.runInContext(kind==='before'?'META_ZONE':'META',context);
    const want=['-NoProfile','-NonInteractive',...((names.includes(kind)||kind==='temporary')?['-ExecutionPolicy','RemoteSigned']:[]),...(names.includes(kind)?['-File',PS1,'-SelfTestSynthetic','-SelfTestScenario',kind]:['-Command',metadataString])];
    assert.deepEqual(Array.from(args),want);assert(!args.includes('Bypass'));calls.push(kind);
    if(name==='beforeThrow'&&kind==='before')throw Error('SECRET_SENTINEL');
    const child=new EventEmitter();child.pid=5000+calls.length;child.stdout=new EventEmitter();child.stderr=new EventEmitter();let closed=false;
    const noClose=(name==='beforeNoClose'&&kind==='before')||(name==='temporaryNoClose'&&kind==='temporary')||(name==='sceneNoClose'&&kind===names[0]);
    const close=(code=0,signal=null)=>{if(!closed){closed=true;child.emit('close',code,signal);}};
    child.kill=signal=>{assert.equal(signal,'SIGKILL');if(!noClose)queueMicrotask(()=>close(null,'SIGKILL'));return !noClose;};
    if(name==='beforeError'&&kind==='before')child.pid=undefined;
    queueMicrotask(()=>{
      if(name==='beforeError'&&kind==='before'){child.emit('error',Error('SECRET_SENTINEL'));return;}
      if(noClose || (name==='beforeTimeout'&&kind==='before') || (name==='temporaryTimeout'&&kind==='temporary'))return;
      let data=names.includes(kind)?scene(kind):meta(kind);let code=0,signal=null;
      if(kind==='before'){
        if(name==='baselinePolicy')data.effectivePolicy='RemoteSigned';
        if(name==='groupPolicy')data.policies[0].policy='Restricted';
        if(name==='version')data.version='7.0';if(name==='metaExtra')data.SECRET_SENTINEL=true;
        if(name==='scopes')data.policies.pop();if(name==='zoneReported')data.zonePresent=true;
        if(name==='beforeExit')code=1;
      }
      if(kind==='temporary'&&name==='temporaryPolicy')data.policies[2].policy='Bypass';
      if(kind==='after'&&name==='afterPolicy')data.policies[3].policy='RemoteSigned';
      if(kind===names[0]){
        if(name==='sceneWrong')data.scenario=names[1];if(name==='sceneMissing')data.checks.pop();
        if(name==='sceneDuplicate')data.checks[1]=data.checks[0];if(name==='sceneType')data.checks[0].passed='true';
        if(name==='sceneFail'){data.passed=false;data.checkFailed=1;data.checks[0].passed=false;}
        if(name==='sceneContradiction')data.checkFailed=1;if(name==='sceneCount')data.checkTotal--;
        if(name==='sceneCounter')data.counters.starts=2;if(name==='sceneExit')code=1;if(name==='sceneSignal')signal='SIGTERM';
        if(name==='businessHit')inject();if(name==='publicSpawn')inject('spawn');if(name==='socketHit')inject('socket');if(name==='dnsHit')inject('dns');if(name==='fetchHit')inject('fetch');
        if(name==='sceneStderr'){child.stderr.emit('data',Buffer.from('SECRET_SENTINEL'));return;}
        if(name==='sceneLimit'){child.stdout.emit('data',Buffer.alloc(128*1024+1));return;}
        if(name==='sceneBuffer'){child.stdout.emit('data','SECRET_SENTINEL');return;}
        if(name==='sceneStream'){child.stdout.emit('error',Error('SECRET_SENTINEL'));return;}
      }
      if(kind===names.at(-1)&&name==='lastSceneFail'){data.passed=false;data.checkFailed=1;data.checks[0].passed=false;}
      let b=Buffer.from(JSON.stringify(data));
      if(kind===names[0]){if(name==='sceneJson')b=Buffer.from('SECRET_SENTINEL');if(name==='sceneUtf8')b=Buffer.from([255]);if(name==='sceneReplacement')b=Buffer.from('\ufffd');}
      child.stdout.emit('data',b);close(code,signal);
    });return child;
  };
  const fakeFs={
    lstatSync(p){p=path.resolve(p);if(p===OUT){if(name!=='outputExists')throw Object.assign(Error('missing'),{code:'ENOENT'});}else assert(cache.has(p)||dirs.has(p),p);
      return {isFile:()=>cache.has(p)||p===OUT,isDirectory:()=>dirs.has(p),isSymbolicLink:()=>name==='hostLink'&&p===NODE};},
    readFileSync(p){p=path.resolve(p);assert(cache.has(p),p);reads.set(p,(reads.get(p)||0)+1);
      if(name==='initHit'&&p===NODE)inject();if(name==='finalDigestHit'&&p===DRIVER)inject();
      if(name==='nodeDrift'&&p===NODE||name==='ps1Drift'&&p===PS1||name==='decoderDrift'&&p===DECODER||name==='stageDrift'&&p===PS1&&calls.length>0)return Buffer.from('synthetic-drift');
      return cache.get(p);},
    openSync(p,mode){assert.equal(p,PS1+':Zone.Identifier');assert.equal(mode,'r');opens++;
      if(name==='zoneError')throw Object.assign(Error('SECRET_SENTINEL'),{code:'EACCES'});
      if(name==='zoneLocal'||name==='preSceneZone'&&opens>1)return 123;
      throw Object.assign(Error('absent'),{code:'ENOENT'});},
    closeSync(fd){assert.equal(fd,123);},
    writeFileSync(p,s,opts){writes++;assert.equal(p,OUT);assert.equal(opts.flag,'wx');if(name==='outputRace')throw Error('SECRET_SENTINEL');saved=s;}
  };
  const fakeCrypto={createHash(type){const h=crypto.createHash(type);const w={update(b){if(name==='digestComputeHit'&&b===cache.get(DRIVER))inject();h.update(b);return w;},digest(enc){return h.digest(enc);}};return w;}};
  const argv=[NODE,DRIVER,...(name==='defaultNoExecute'?[]:['--execute'])];
  if(name==='badCli')argv[2]='--run';if(name==='policyCli')argv.push('-ExecutionPolicy','Bypass');if(name==='extraCli')argv.push('extra');
  if(['normalOut','outputExists','outputRace'].includes(name))argv.push('--out',OUT);if(name==='badOut')argv.push('--out',path.join(ROOT,'bad.json'));
  const proc={argv,execPath:name==='hostPath'?'C:\\synthetic\\node.exe':NODE,env:{NODE_OPTIONS:'synthetic',SYNTHETIC_KEEP:'1'},stdout:{write(s){output+=s;}},exitCode:null};
  function req(id){if(id==='node:fs')return fakeFs;if(id==='node:child_process')return fakeCp;if(id==='node:crypto')return fakeCrypto;if(modules[id])return modules[id];if(id==='node:path')return path;if(id==='node:vm')return vm;return offline();}
  context=vm.createContext({require:req,__dirname,__filename:DRIVER,Buffer,TextDecoder,process:proc,setTimeout:(f,ms)=>setTimeout(f,Math.min(ms,15)),clearTimeout});
  let code=source;
  if(name==='finalizationHit')code=code.replace('report.executionRequested=execute;',"try{require('node:https').request('synthetic');}catch(_){}\n    report.executionRequested=execute;");
  await vm.runInContext(code,context,{timeout:10000,filename:DRIVER});
  const r=JSON.parse(output),positive=['normal','normalOut'].includes(name),dry=name==='defaultNoExecute';
  assert.equal(r.ok,positive,name);assert.equal(proc.exitCode,r.exitCode,name);assert.equal(r.exitCode,positive?0:dry?2:1,name);assert.equal(calls.length,callCount,name+' calls '+calls.join(','));
  if(error)assert.equal(r.failure?.code||r.cleanupFailure?.code,error,name);
  assert(!output.includes('SECRET_SENTINEL'),name);assert(!output.includes('SYNTHETIC_KEEP'),name);
  if(name!=='outputRace'){
    assert.equal(r.fullPreflightPassed,false);assert.equal(r.realInputApproved,false);
    if(positive){assert.equal(r.policyComparisonPassed,true);assert.equal(r.allDirectProcessesClosed,true);assert.equal(r.observations.unexpected,0);assert.equal(Object.values(r.scenarios).filter(s=>s.passed).length,7);}
    if(['initHit','businessHit','finalDigestHit','digestComputeHit','finalizationHit','publicSpawn','socketHit','dnsHit','fetchHit'].includes(name))assert.equal(r.observations.unexpected,1,name);
    if(name.includes('NoClose'))assert.equal(r.allDirectProcessesClosed,false);
    if(calls.includes('temporary')&&!name.includes('NoClose')&&name!=='stageDrift')assert.equal(calls.at(-1),'after',name);
  }
  assert.equal(writes,['normalOut','outputRace'].includes(name)?1:0,name);assert.equal(saved,name==='normalOut'?output:null,name);
  results.push({name,expectationMet:true,ok:r.ok,exitCode:r.exitCode,calls,unexpected:r.observations?.unexpected??null,failure:r.failure?.code||r.cleanupFailure?.code||null});
}
(async()=>{
  for(const c of cases)await test(c);
  assert.equal(fallbackHits,0);
  const report={schema:'codex-temporary-policy-l1-offline/1',basisCommit:'e02b1a8',driverSha256:sha(cache.get(DRIVER)),testSha256:sha(fs.readFileSync(__filename)),checks:results.length,results,fallbackHits,actualOSProcesses:0,actualNetwork:0,ok:true,
    limitations:['Actual driver and decoder in VM; OS/FS boundaries and all PS output are synthetic.','Does not execute PowerShell, alter policy or prove seven real PS scenarios.']};
  const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===__filename.replace(/\.cjs$/,'.json'));
  if(args.length)fs.writeFileSync(args[1],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({ok:true,checks:results.length,fallbackHits,driverSha256:report.driverSha256})+'\n');
})().catch(e=>{process.stderr.write(String(e.stack)+'\n');process.exitCode=1;});
