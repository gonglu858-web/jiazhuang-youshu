'use strict';
// OS-independent driver tests. Never compiles/runs C#/PowerShell/native helpers.
const cp=require('node:child_process'),net=require('node:net');let fallbackHits=0;
function offline(){fallbackHits++;throw Error('OFFLINE_FALLBACK');}
for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=offline;
for(const id of ['node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:offline,configurable:true});}
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=offline;
net.connect=net.createConnection=net.createServer=offline;net.Socket.prototype.connect=offline;globalThis.fetch=offline;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const ROOT=path.resolve(__dirname,'../..'),DRIVER=path.join(__dirname,'CodexL2固定Node驱动v2-20261027.cjs'),SOURCE=path.join(__dirname,'CodexL2进程树辅助层-20261027.cs');
const NODE='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe',PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCRIPT=path.join(ROOT,'miniapp/scripts/participant-private-input.ps1'),DECODER=path.join(ROOT,'miniapp/scripts/lib/participant-native-decoder.cjs'),HELPER=path.join(ROOT,'artifacts/psr-l2/v1/psr-l2-helper.exe'),OUT=DRIVER.replace(/cjs$/,'json');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const BUILD_CONFIG=path.join(__dirname,'CodexL2固定编译配置-20261027.json'),BUILD_RECORD=path.join(__dirname,'CodexL2单次编译-20261027.json');
const cache=new Map([DRIVER,SOURCE,NODE,PS,SCRIPT,DECODER,HELPER,BUILD_CONFIG,BUILD_RECORD].map(p=>[p,fs.readFileSync(p)]));
const helperBytes=cache.get(HELPER);assert.equal(hash(helperBytes),'d6381e2d009651289c692e60241a197f765d72d35e71f0443d6c01e8ca6ea77d');
const source=cache.get(DRIVER).toString('utf8'),native=cache.get(SOURCE).toString('utf8');
// Independent expected vector from the already committed design, not driver output.
const planBytes=fs.readFileSync(path.join(ROOT,'docs/Codex方案-L2固定Node真实合成参数传输-20261027.md'));
const expected=JSON.parse(planBytes.toString('utf8').match(/```json\r?\n([\s\S]*?)\r?\n```/)[1]);assert.equal(expected.length,20);
assert.equal(expected[15],'');assert.equal(expected[3],'C:\\synthetic L2 root\\');assert.equal(expected[17],'synthetic "quoted" file.json');
const gate="const RELEASE = Object.freeze({ready:true, helperSha256:'d6381e2d009651289c692e60241a197f765d72d35e71f0443d6c01e8ca6ea77d'});";assert(source.includes(gate));
const dirs=new Set();for(const file of cache.keys()){let d=path.dirname(file);while(!dirs.has(d)){dirs.add(d);const parent=path.dirname(d);if(parent===d)break;d=parent;}}
const staticResults=[];function check(name,ok){assert(ok,name);staticResults.push({name,passed:true});}
check('source hashes pinned',source.includes(hash(cache.get(SOURCE))));
check('frozen binary hash and default no-run',source.includes(gate)&&source.includes("execute=args[0]==='--execute'"));
check('native fixed file hash',native.includes('9255adb762cd19801805ee19c04204dd8f8a3b384d8fc857ff36d44466db0790'));
check('native fixed node hash',native.includes('c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19'));
check('native fixed modes only',native.includes('args.Length!=1')&&native.includes('args[0]!="normal"&&args[0]!="timeout"&&args[0]!="transport"'));
check('native no caller executable',native.includes('string app=mode=="transport"?PS:Node;'));
check('native create suspended',native.includes('Suspended|NoWindow|UnicodeEnvironment'));
check('native assign before resume',native.indexOf('Require(AssignProcessToJobObject(')<native.indexOf('Require(ResumeThread('));
check('native assign failure throws',native.includes('Require(AssignProcessToJobObject(job,pi.Process),"JOB_ASSIGN");'));
check('native resume exact previous suspend count',native.includes('Require(ResumeThread(pi.Thread)==1,"RESUME");'));
check('native job not inherited',native.includes('CreateJobObjectW(IntPtr.Zero,null)'));
check('native job limit checked',native.includes('actual.Basic.Flags==KillOnClose'));
check('native no breakaway flag',!native.includes('BREAKAWAY')&&!native.includes('0x01000000'));
check('native separate bounded readers',native.includes('outThread.Start()')&&native.includes('errThread.Start()')&&native.includes('Stdout+Stderr>Limit'));
check('native raw stderr rejected',native.includes('else if (error) Failure="STDERR";'));
check('native kill owned job',native.includes('r.Assigned?TerminateJobObject(job,9009):TerminateProcess(pi.Process,9009)'));
check('native assignment failure owns suspended handle',native.includes('r.Created=true;r.Pid=pi.Pid;'));
check('native reap bounded',native.includes('while(reap.ElapsedMilliseconds<2000)'));
check('native job emptiness queried',native.includes('QueryAccounting(job,1')&&native.includes('r.JobEmpty=a.Active==0'));
check('native pipe parent write ends close',native.includes('Require(Close(ref wr)&Close(ref ew)&Close(ref input),"HANDLE_CLOSE")'));
check('native readers and handles part of cleanup',native.includes('&& JobEmpty && ReadersDone && HandlesClosed'));
check('native zero node options inheritance',native.includes('StringComparison.OrdinalIgnoreCase)) values'));
check('native two-process tree count',native.includes('Require(r.Total==2,"TREE_COUNT")'));
check('native fixed selftest transport',native.includes('"-File", Script, "-SelfTestTransport"'));
check('native no runtime compiler/UI/network',!/(Add-Type|csc\.exe|Set-ExecutionPolicy|HttpClient|WebClient|System\.Net)/.test(native));
check('native no environment write',!native.includes('SetEnvironmentVariable'));
check('native no real store call',!native.includes('save-protect')&&!native.includes('"protect"'));
check('parent kills helper without claiming tree clean',source.includes('if(helper)treeCertain=false;')&&source.includes("cleanupFailure={phase:'after',code:'CLEANUP_UNCONFIRMED'}"));
function meta(kind){return {schema:'codex-l2-environment/1',version:'5.1.26100.9711',effectivePolicy:kind==='temporary'?'RemoteSigned':'Restricted',policies:['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'].map(scope=>({scope,policy:kind==='temporary'&&scope==='Process'?'RemoteSigned':'Undefined'})),...(kind==='before'?{zonePresent:false}:{})};}
function receipt(kind){const timeout=kind==='timeout';const bytes=Buffer.from(timeout?'':kind==='normal'?'L2_NORMAL':JSON.stringify(expected));return {schema:'codex-l2-job/1',mode:kind,outcome:timeout?'expected-timeout':'completed',reason:timeout?'TIMEOUT':'NONE',created:true,assigned:true,resumed:true,pid:300,rootExited:true,rootExit:timeout?9009:0,jobEmpty:true,totalProcesses:2,activeProcesses:0,killRequested:timeout,killAccepted:timeout,readersDone:true,handlesClosed:true,cleanupConfirmed:true,stdoutBytes:bytes.length,stderrBytes:0,stdoutBase64:bytes.toString('base64'),elapsedMs:timeout?2050:100};}
const cases=[
 ['normal',true,6],['default',false,0],['bindingDrift',false,0,'HELPER_HASH'],['normalOut',true,6],
 ['badCli',false,0,'ARGUMENT_INVALID'],['extraCli',false,0,'ARGUMENT_INVALID'],['policyCli',false,0,'ARGUMENT_INVALID'],['helperPathCli',false,0,'ARGUMENT_INVALID'],['outputExists',false,0,'OUTPUT_EXISTS'],
 ['hostPath',false,0,'HOST_PATH'],['nodeDrift',false,0,'SOURCE_DRIFT'],['scriptDrift',false,0,'SOURCE_DRIFT'],['helperSourceDrift',false,0,'SOURCE_DRIFT'],['helperHash',false,0,'HELPER_HASH'],['linkedHelper',false,0,'SOURCE_PATH'],
 ['zone',false,0,'ZONE_PRESENT'],['zoneUnknown',false,0,'ZONE_UNCERTAIN'],['policy',false,1,'POLICY'],['version',false,1,'META_SHAPE'],['scopeDuplicate',false,1,'META_SCOPES'],['metaExtra',false,1,'META_SHAPE'],['metadataOrder',true,6],
 ['temporaryPolicy',false,3,'POLICY'],['afterPolicy',false,6,'POLICY'],
 ['normalBadOutput',false,4,'NORMAL_SELFTEST'],['helperExit',false,4,'HELPER_EXIT'],['receiptMissing',false,3,'RECEIPT_SHAPE'],['receiptType',false,3,'RECEIPT_TYPE'],['receiptContradiction',false,3,'RECEIPT_CONTRADICTION'],['receiptCleanupFalse',false,3,'CLEANUP_UNCONFIRMED'],['receiptExtra',false,3,'RECEIPT_SHAPE'],
 ['treeThree',false,4,'JOB_FACTS'],['treeOne',false,4,'JOB_FACTS'],['childStillActive',false,3,'CLEANUP_UNCONFIRMED'],['handlesOpen',false,3,'CLEANUP_UNCONFIRMED'],['readerOpen',false,3,'CLEANUP_UNCONFIRMED'],['pidZero',false,3,'RECEIPT_CONTRADICTION'],['oversize',false,3,'RECEIPT_LIMIT'],['stderrReceipt',false,4,'JOB_FACTS'],['receiptBudget',false,4,'JOB_BUDGET'],['base64Junk',false,4,'RECEIPT_BASE64'],
 ['timeoutUnexpectedNormal',false,5,'TIMEOUT_SELFTEST'],['timeoutNotKilled',false,5,'TIMEOUT_SELFTEST'],['timeoutZeroExit',false,5,'TIMEOUT_SELFTEST'],['timeoutWrongExit',false,5,'TIMEOUT_SELFTEST'],['timeoutTooEarly',false,5,'TIMEOUT_SELFTEST'],['timeoutHasOutput',false,5,'TIMEOUT_SELFTEST'],
 ['arrayShort',false,6,'ARGV_SHAPE'],['arrayExtra',false,6,'ARGV_SHAPE'],['arrayObject',false,6,'ARGV_SHAPE'],['invalidJson',false,6,'ARGV_DECODE'],['unicodeReplacement',false,6,'ARGV_DECODE'],
 ['beforeThrow',false,1,'PROCESS_START_FAILED'],['normalThrow',false,4,'PROCESS_START_FAILED'],['normalTimeout',false,3,'PROCESS_TIMEOUT'],['normalNoClose',false,3,'PROCESS_NOT_CLOSED'],['normalWireStderr',false,3,'PROCESS_STDERR'],['normalWireLimit',false,3,'OUTPUT_LIMIT'],['normalSignal',false,3,'PROCESS_EXIT'],
 ['stageDrift',false,3,'SOURCE_DRIFT'],['initHit',false,0,'CAPABILITY_BLOCKED'],['digestHit',false,6],['finalizationHit',false,6],['socketHit',false,0,'CAPABILITY_BLOCKED'],['dnsHit',false,0,'CAPABILITY_BLOCKED'],['fetchHit',false,0,'CAPABILITY_BLOCKED'],['publicSpawn',false,0,'CAPABILITY_BLOCKED'],
 ['outputRace',false,6,'EVIDENCE_WRITE_FAILED']
];
for(let i=0;i<20;i++)cases.push(['argv-'+i,false,6,'ARGV_MISMATCH']);
for(const code of ['JOB_CREATE','JOB_SET','JOB_LIMITS','PIPE','STDIN','CREATE','JOB_ASSIGN','HANDLE_CLOSE','RESUME','JOB_QUERY','WAIT','EXIT_CODE','READ','ROOT_EXIT','TREE_COUNT','HELPER_ERROR'])cases.push(['native-'+code,false,4,'HELPER_EXIT']);
cases.push(['defaultBindingDrift',false,0,'HELPER_HASH'],['compileEvidenceDrift',false,0,'SOURCE_DRIFT'],['compileConfigDrift',false,0,'SOURCE_DRIFT']);
const results=[];
async function test([name,positive,count,error]){
  const calls=[],attemptedVectors=[];let output='',writes=0,sharedHit=false,code=source;
  // Entire delivered driver evaluated unchanged. All native APIs are offline substitutes.
  assert.equal(code,source);
  const argv=['node',DRIVER,...(['default','defaultBindingDrift'].includes(name)?[]:['--execute'])];if(name==='normalOut'||name==='outputExists'||name==='outputRace')argv.push('--out',OUT);
  if(name==='badCli')argv.push('--unknown');if(name==='extraCli')argv.push('--execute');if(name==='policyCli')argv.push('--policy','Bypass');if(name==='helperPathCli')argv.push('--helper','C:\\other.exe');
  const proc={execPath:name==='hostPath'?'C:\\other.exe':NODE,argv,env:{NODE_OPTIONS:'SYNTHETIC_SECRET_SENTINEL',SYNTHETIC_KEEP:'keep'},stdout:{write:s=>{output+=s;}},exitCode:undefined};
  const mods=new Map();let ctx;
  function hit(kind){try{if(kind==='socket')new (req('node:net').Socket)().connect();else if(kind==='dns')req('node:dns').promises.lookup();else if(kind==='fetch')ctx.fetch();else if(kind==='process')req('node:child_process').spawn();else req('node:https').request('synthetic');}catch{}}
  function bytesFor(kind){
    let data=kind==='before'||kind==='temporary'||kind==='after'?meta(kind):receipt(kind);
    if(kind==='before'){
      if(name==='policy')data.effectivePolicy='Bypass';if(name==='version')data.version='7.0';if(name==='scopeDuplicate')data.policies[0]=data.policies[1];if(name==='metaExtra')data.extra=true;
    }
    if(name==='metadataOrder'&&data.policies)data.policies.reverse().forEach((p,i,a)=>a[i]={policy:p.policy,scope:p.scope});
    if(name==='temporaryPolicy'&&kind==='temporary')data.effectivePolicy='Restricted';if(name==='afterPolicy'&&kind==='after')data.effectivePolicy='Bypass';
    if(kind==='normal'){
      if(name.startsWith('native-')){data.reason=name.slice(7);data.outcome='failed';data.created=false;data.assigned=false;data.resumed=false;data.pid=0;data.rootExited=false;data.rootExit=259;data.totalProcesses=0;data.stdoutBytes=0;data.stdoutBase64='';}
      if(name==='receiptMissing')delete data.rootExited;if(name==='receiptType')data.pid='300';if(name==='receiptExtra')data.unapproved=true;
      if(name==='receiptContradiction')data.assigned=false;
      if(['receiptCleanupFalse','childStillActive'].includes(name)){data.activeProcesses=1;data.jobEmpty=false;data.cleanupConfirmed=false;}
      if(name==='handlesOpen'){data.handlesClosed=false;data.cleanupConfirmed=false;}if(name==='readerOpen'){data.readersDone=false;data.cleanupConfirmed=false;}
      if(name==='pidZero')data.pid=0;if(name==='treeThree')data.totalProcesses=3;if(name==='treeOne')data.totalProcesses=1;
      if(name==='oversize')data.stdoutBytes=131073;if(name==='stderrReceipt')data.stderrBytes=1;if(name==='receiptBudget')data.elapsedMs=9000;
      if(name==='base64Junk')data.stdoutBase64+='!';if(name==='normalBadOutput'){const b=Buffer.from('bad');data.stdoutBytes=b.length;data.stdoutBase64=b.toString('base64');}
    }
    if(kind==='timeout'){
      if(name==='timeoutUnexpectedNormal'){data.outcome='completed';data.reason='NONE';}if(name==='timeoutNotKilled')data.killAccepted=false;if(name==='timeoutZeroExit')data.rootExit=0;if(name==='timeoutWrongExit')data.rootExit=7;if(name==='timeoutTooEarly')data.elapsedMs=10;
      if(name==='timeoutHasOutput'){data.stdoutBytes=1;data.stdoutBase64='eA==';}
    }
    if(kind==='transport'){
      let payload=[...expected];if(name.startsWith('argv-'))payload[Number(name.slice(5))]='changed';if(name==='arrayShort')payload.pop();if(name==='arrayExtra')payload.push('extra');if(name==='arrayObject')payload={values:payload};
      const b=Buffer.from(name==='invalidJson'?'invalid':name==='unicodeReplacement'?'\ufffd':JSON.stringify(payload));data.stdoutBytes=b.length;data.stdoutBase64=b.toString('base64');
    }
    return Buffer.from(JSON.stringify(data));
  }
  const fakeCp={execSync(){throw Error('raw exec forbidden');},spawn(exe,args,opts){
    const kind=exe===HELPER?args[0]:args.includes('RemoteSigned')?'temporary':calls.length===0?'before':'after';calls.push(kind);
    assert.equal(opts.cwd,ROOT);assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);assert.deepEqual(Array.from(opts.stdio),['ignore','pipe','pipe']);assert.equal(opts.env.NODE_OPTIONS,undefined);assert.equal(opts.env.SYNTHETIC_KEEP,'keep');
    if(exe===HELPER){assert(['normal','timeout','transport'].includes(kind));assert.deepEqual(Array.from(args),[kind]);}
    else{assert.equal(exe,PS);assert.deepEqual(Array.from(args.slice(0,2)),['-NoProfile','-NonInteractive']);assert.equal(args.at(-2),'-Command');assert(args.at(-1).startsWith("$ErrorActionPreference='Stop';Import-Module"));assert(!args.includes('-File'));assert.equal(args.includes('RemoteSigned'),kind==='temporary');}
    attemptedVectors.push({kind,argc:args.length});
    if(name==='beforeThrow'&&kind==='before'||name==='normalThrow'&&kind==='normal')throw Error('SECRET_SENTINEL');
    const child=new EventEmitter();child.pid=100+calls.length;child.stdout=new EventEmitter();child.stderr=new EventEmitter();let closed=false;
    const close=(status,signal)=>{if(!closed){closed=true;child.emit('close',status,signal||null);}};
    child.kill=()=>{if(name==='normalNoClose'&&kind==='normal')return true;queueMicrotask(()=>close(null,'SIGKILL'));return true;};
    setTimeout(()=>{
      if(['normalTimeout','normalNoClose'].includes(name)&&kind==='normal')return;
      if(name==='normalWireStderr'&&kind==='normal'){child.stderr.emit('data',Buffer.from('SECRET_SENTINEL'));return;}
      if(name==='normalWireLimit'&&kind==='normal'){child.stdout.emit('data',Buffer.alloc(128*1024+1));return;}
      child.stdout.emit('data',bytesFor(kind));close((name==='helperExit'||name.startsWith('native-'))&&kind==='normal'?1:0,name==='normalSignal'&&kind==='normal'?'SIGTERM':null);
    },0);return child;
  }};
  const fakeFs={
    readFileSync(file){const p=String(file);let b=cache.get(p);assert(b,'unexpected read '+p);
      if(p===SOURCE&&name==='helperSourceDrift')b=Buffer.concat([b,Buffer.from('drift')]);if(p===NODE&&name==='nodeDrift')b=Buffer.from('drift');if(p===SCRIPT&&name==='scriptDrift')b=Buffer.from('drift');if(p===HELPER&&['helperHash','bindingDrift','defaultBindingDrift'].includes(name))b=Buffer.from('drift');
      if(p===BUILD_RECORD&&name==='compileEvidenceDrift')b=Buffer.from('drift');if(p===BUILD_CONFIG&&name==='compileConfigDrift')b=Buffer.from('drift');
      if(p===SCRIPT&&name==='stageDrift'&&calls.includes('normal'))b=Buffer.from('drift');
      if(p===SOURCE&&!sharedHit&&['initHit','socketHit','dnsHit','fetchHit','publicSpawn'].includes(name)){sharedHit=true;hit({socketHit:'socket',dnsHit:'dns',fetchHit:'fetch',publicSpawn:'process'}[name]);}
      if(p===DRIVER&&name==='finalizationHit'&&!sharedHit){sharedHit=true;hit();}
      return Buffer.from(b);
    },
    lstatSync(p){p=String(p);if(p===OUT&&name==='outputExists')return {isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};if(cache.has(p)||dirs.has(p))return {isFile:()=>cache.has(p),isDirectory:()=>dirs.has(p),isSymbolicLink:()=>p===HELPER&&name==='linkedHelper'};throw Object.assign(Error('missing'),{code:'ENOENT'});},
    openSync(p){assert.equal(p,SCRIPT+':Zone.Identifier');if(name==='zone')return 3;throw Object.assign(Error('zone'),{code:name==='zoneUnknown'?'EACCES':'ENOENT'});},closeSync(fd){assert.equal(fd,3);},
    writeFileSync(p,s,opts){assert.equal(p,OUT);assert.equal(opts.flag,'wx');writes++;if(name==='outputRace')throw Error('EEXIST');assert.equal(typeof s,'string');}
  };
  const fakeCrypto={createHash(algorithm){const h=crypto.createHash(algorithm);return {update(data){if(name==='digestHit'&&calls.includes('after')&&!sharedHit){sharedHit=true;hit();}h.update(data);return this;},digest(enc){return h.digest(enc);}};}};
  function req(id){if(id==='node:child_process')return fakeCp;if(id==='node:fs')return fakeFs;if(id==='node:path')return path;if(id==='node:crypto')return fakeCrypto;if(id==='node:vm')return vm;
    if(!mods.has(id)){const m={request(){throw Error('raw network forbidden');}};if(id==='node:net'){m.Socket=function(){};m.Socket.prototype.connect=()=>{throw Error('raw socket forbidden');};}if(id==='node:dns')m.promises={lookup(){throw Error('raw dns forbidden');}};mods.set(id,m);}return mods.get(id);
  }
  ctx={require:req,process:proc,__dirname,__filename:DRIVER,Buffer,TextDecoder,setTimeout:(f,ms)=>setTimeout(f,ms>=1000?30:ms),clearTimeout,console:{log(){throw Error('unexpected console');}}};
  const promise=vm.runInNewContext(code,ctx,{timeout:2000});await promise;
  const r=JSON.parse(output);assert.equal(r.ok,positive,name);assert.equal(proc.exitCode,r.exitCode,name);assert.equal(r.exitCode,positive?0:name==='default'?2:1,name);assert.equal(calls.length,count,name+': '+calls.join(','));
  if(error)assert.equal(r.failure?.code||r.cleanupFailure?.code,error,name);
  assert(!output.includes('SECRET_SENTINEL')&&!output.includes('synthetic "quoted" file.json'),name+' no raw output');
  if(name!=='outputRace'){assert.equal(r.fullPreflightPassed,false);assert.equal(r.realInputApproved,false);
    if(positive){assert(r.policyComparisonPassed&&r.processTreeCleanupConfirmed&&r.allDirectProcessesClosed);assert.deepEqual(Array.from(r.jobs.transport.matches),Array(20).fill(true));}
    if(['initHit','digestHit','finalizationHit','socketHit','dnsHit','fetchHit','publicSpawn'].includes(name))assert.equal(r.observations.unexpected,1,name);
    if(r.jobs.normal?.cleanupConfirmed===false||['receiptMissing','receiptType','receiptContradiction','receiptExtra','pidZero','oversize','normalTimeout','normalNoClose','normalWireStderr','normalWireLimit','normalSignal'].includes(name))assert(!calls.includes('after'),name+' uncertain cleanup stops after');
  }
  assert.equal(writes,['normalOut','outputRace'].includes(name)?1:0,name);
  results.push({name,expectationMet:true,ok:r.ok,exitCode:r.exitCode,calls,failure:r.failure?.code||r.cleanupFailure?.code||null,unexpected:r.observations?.unexpected??null,vmReleaseSubstitution:false});
}
(async()=>{
  for(const c of cases)await test(c);assert.equal(fallbackHits,0);
  const report={schema:'codex-l2-offline/2',basisCommit:'f1f3d41',driverSha256:hash(cache.get(DRIVER)),nativeSourceSha256:hash(cache.get(SOURCE)),testSha256:hash(fs.readFileSync(__filename)),planSha256:hash(planBytes),staticChecks:staticResults.length,staticResults,checks:results.length,results,fallbackHits,actualOSProcesses:0,actualNetwork:0,helperCompiled:true,helperExecuted:false,releaseFrozen:true,helperBinarySha256:hash(helperBytes),compileEvidenceSha256:hash(cache.get(BUILD_RECORD)),ok:true,
    limitations:['Driver runs in isolated VM with synthetic OS/filesystem/clock boundaries.','Delivered v2 driver is evaluated unchanged, including pinned actual binary hash; no release replacement. Default invocation performs read-only checks and launches zero OS processes.','C# source checks are static; prior separate compile succeeded, but no native helper is executed here. Native failure receipts are simulated, not Win32 control-flow proof.','Windows Job behavior, nested jobs, process inheritance and real argv transport remain unverified; compiler success is a separately pinned historical fact.']};
  const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===__filename.replace(/cjs$/,'json'));
  if(args.length)fs.writeFileSync(args[1],JSON.stringify(report,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify({ok:true,checks:report.checks,staticChecks:report.staticChecks,fallbackHits})+'\n');
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
