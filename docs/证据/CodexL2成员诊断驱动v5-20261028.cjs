'use strict';
// Bound normal-only capability; default read-only. This delivery does not execute it.
const RELEASE=Object.freeze({ready:true,helperSha256:'f9287194c037aeba592b5c5eccc23d98fd403fe59040248b4455993171134d96'});
const state={probes:0,unexpected:0,attempts:[]};let probing=false;
function deny(){state[probing?'probes':'unexpected']++;throw Error('OS_BLOCKED');}
const cp=require('node:child_process'),RawChild=cp.ChildProcess,spawnChild=RawChild.prototype.spawn;
let pipeAllowance=0,pipeSink=null;
for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const id of ['node:http','node:https','node:net','node:tls','node:dgram','node:dns']){
  const m=require(id);let pipeSocket;
  if(id==='node:net'){
    const Socket=m.Socket;Socket.prototype.connect=deny;
    pipeSocket=function(options){
      if(pipeAllowance<=0||!options||Object.getPrototypeOf(options)!==Object.prototype)return deny();
      const d=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(d);
      if(keys.length!==2||!d.handle||!d.readable||!Object.hasOwn(d.handle,'value')||!Object.hasOwn(d.readable,'value')||d.readable.value!==true||!(d.handle.value===null||typeof d.handle.value==='object'))return deny();
      pipeAllowance--;const socket=Socket(options);if(pipeSink)pipeSink(socket);return socket;
    };
    // Do not expose the captured constructor through wrapper.prototype.constructor.
    pipeSocket.prototype=Object.create(null);pipeSocket.prototype.connect=deny;
  }
  if(id==='node:dns')for(const k of Object.keys(m.promises))if(typeof m.promises[k]==='function')m.promises[k]=deny;
  for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});
  if(pipeSocket)Object.defineProperty(m,'Socket',{value:pipeSocket,configurable:true});
}globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT='C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const NODE='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const CONFIG=path.join(__dirname,'CodexL2成员诊断编译草案v3-20261028.json');
const CONFIG_HASH='739605e1cada171173921bfd3c5bffbcc5c82674b5a3ed1b656c21b9fbb17b25';
const H=b=>crypto.createHash('sha256').update(b).digest('hex');
function need(v,code){if(!v)throw Object.assign(Error(code),{code});}
function exact(o,keys){return o&&typeof o==='object'&&!Array.isArray(o)&&JSON.stringify(Object.keys(o).sort())===JSON.stringify(keys.slice().sort());}
function uint(x){return Number.isSafeInteger(x)&&x>=0&&x<=4294967295;}
const BASE=['schema','mode','outcome','reason','created','assigned','resumed','pid','rootExited','rootExit','jobEmpty','totalProcesses','activeProcesses','killRequested','killAccepted','readersDone','handlesClosed','cleanupConfirmed','stdoutBytes','stderrBytes','stdoutBase64','elapsedMs','accountingLayoutVerified','observation'];
const OBS=['failure','identityCoverage','parentEvidenceComplete','notificationCompletenessGuaranteed','stopped','handlesClosed','duplicateNew','finalTotal','events','members'];
const MEMBER=['pid','creationTime','image','pathClass','state','root','parent','newSeen','listed','exitSeen'];
const OBS_CODES=['NONE','OBS_ASSOCIATE','OBS_MEMBER_LIMIT','OBS_QUEUE','OBS_EVENT_LIMIT','OBS_KEY','OBS_EVENT_TYPE','OBS_PID','OBS_CENSUS','OBS_CENSUS_SIZE','OBS_CENSUS_PID','OBS_QUERY_EXCEPTION','OBS_FINAL_QUERY','OBS_CLOSE'];
const REASONS=['NONE','MODE','SOURCE_MISSING','SOURCE_LINK','SOURCE_HASH','JOB_CREATE','JOB_SET','JOB_LIMITS','PIPE','STDIN','CREATE','JOB_ASSIGN','HANDLE_CLOSE','RESUME','JOB_QUERY','WAIT','EXIT_CODE','OUTPUT_LIMIT','STDERR','READ','TIMEOUT','ROOT_EXIT','TREE_COUNT','TIMEOUT_NOT_REACHED','HELPER_ERROR','OBS_LAYOUT','OBS_PORT','OBS_FAILURE','OBS_MEMBER_LIMIT'];
function inspectReceipt(v,status){
  need(exact(v,BASE)&&v.schema==='codex-l2-member-job/2'&&v.mode==='normal','RECEIPT_SHAPE');
  for(const k of ['created','assigned','resumed','rootExited','jobEmpty','killRequested','killAccepted','readersDone','handlesClosed','cleanupConfirmed','accountingLayoutVerified'])need(typeof v[k]==='boolean','RECEIPT_TYPE');
  for(const k of ['pid','rootExit','totalProcesses','activeProcesses','stdoutBytes','stderrBytes','elapsedMs'])need(uint(v[k]),'RECEIPT_TYPE');
  need([0,1].includes(status)&&['completed','failed'].includes(v.outcome)&&REASONS.includes(v.reason),'RESULT_TYPE');
  need(v.activeProcesses<=v.totalProcesses&&v.jobEmpty===(v.activeProcesses===0),'COUNT_CONTRADICTION');
  need((!v.assigned||v.created)&&(!v.resumed||v.assigned)&&(v.created?v.pid>0:v.pid===0)&&(!v.killAccepted||v.killRequested),'STATE_CONTRADICTION');
  need(v.stdoutBytes+v.stderrBytes<=131072&&typeof v.stdoutBase64==='string'&&v.stdoutBase64.length<=174764&&v.elapsedMs<=7500,'LIMIT');
  const o=v.observation;
  if(o!==null){
    need(exact(o,OBS)&&OBS_CODES.includes(o.failure),'OBS_SHAPE');
    for(const k of ['identityCoverage','parentEvidenceComplete','notificationCompletenessGuaranteed','stopped','handlesClosed','duplicateNew'])need(typeof o[k]==='boolean','OBS_TYPE');
    need(o.parentEvidenceComplete===false&&o.notificationCompletenessGuaranteed===false,'UNPROVEN_CLAIM');
    need(uint(o.finalTotal)&&o.finalTotal===v.totalProcesses&&Array.isArray(o.members)&&o.members.length<=16&&Array.isArray(o.events)&&o.events.length<=128,'OBS_LIMIT');
    const ids=new Set();let roots=0;
    for(const m of o.members){
      need(exact(m,MEMBER)&&uint(m.pid)&&m.pid>0&&!ids.has(m.pid),'MEMBER_SHAPE');ids.add(m.pid);
      need(['FIXED_NODE','OTHER_IMAGE','UNKNOWN'].includes(m.image)&&['UNKNOWN','UNAVAILABLE','MEMBERSHIP_UNKNOWN','EXITED_BEFORE_CAPTURE','TIME_UNKNOWN','IMAGE_UNKNOWN','IDENTITY_CHANGED','EXIT_WITHOUT_IDENTITY','CAPTURED'].includes(m.state),'MEMBER_LABEL');
      need(m.parent==='UNKNOWN'&&(m.creationTime===null||typeof m.creationTime==='string'&&/^[1-9][0-9]{0,19}$/.test(m.creationTime)),'MEMBER_IDENTITY');
      for(const k of ['root','newSeen','listed','exitSeen'])need(typeof m[k]==='boolean','MEMBER_TYPE');
      need(m.root===(m.pid===v.pid),'ROOT_IDENTITY');if(m.root)roots++;
      need(m.state==='CAPTURED'?m.creationTime!==null&&m.image!=='UNKNOWN':m.creationTime===null&&m.image==='UNKNOWN','MEMBER_CONTRADICTION');
      need(m.state==='CAPTURED'?(m.image==='FIXED_NODE'?m.pathClass==='FIXED_NODE_PATH':['WINDOWS_CONHOST_PATH_CANDIDATE','OTHER_PATH'].includes(m.pathClass)):m.pathClass==='UNKNOWN','PATH_CLASS_CONTRADICTION');
    }
    if(o.members.length)need(roots===1,'ROOT_MISSING');
    for(const e of o.events)need(exact(e,['kind','pid'])&&['NEW','EXIT','ABNORMAL_EXIT','ACTIVE_ZERO'].includes(e.kind)&&uint(e.pid)&&(e.kind==='ACTIVE_ZERO'?e.pid===0:ids.has(e.pid)),'EVENT_SHAPE');
    const newCounts=new Map();for(const e of o.events)if(e.kind==='NEW')newCounts.set(e.pid,(newCounts.get(e.pid)||0)+1);
    need(o.duplicateNew===[...newCounts.values()].some(n=>n>1),'EVENT_DUPLICATE');
    for(const m of o.members)need(m.newSeen===newCounts.has(m.pid)&&m.exitSeen===o.events.some(e=>e.pid===m.pid&&['EXIT','ABNORMAL_EXIT'].includes(e.kind)),'EVENT_FLAGS');
    if(o.identityCoverage)need(o.failure==='NONE'&&o.stopped&&o.handlesClosed&&!o.duplicateNew&&o.members.length===v.totalProcesses&&v.totalProcesses>0&&o.members.every(m=>m.state==='CAPTURED'),'IDENTITY_COVERAGE');
  }
  const cleaned=(!v.created||v.rootExited)&&v.jobEmpty&&v.readersDone&&v.handlesClosed&&(o===null||o.handlesClosed);
  need(v.cleanupConfirmed===cleaned,'CLEANUP_CONTRADICTION');
  // Receipt failures may carry useful observations; never convert them into a passed self-test.
  if(v.outcome==='completed'){
    need(status===0&&v.reason==='NONE'&&cleaned&&v.created&&v.assigned&&v.resumed&&v.rootExited&&v.rootExit===0&&v.totalProcesses===2&&!v.killRequested&&!v.killAccepted&&v.stderrBytes===0&&v.accountingLayoutVerified&&o!==null&&o.failure==='NONE'&&o.stopped,'NORMAL_CONTRADICTION');
    const b=Buffer.from(v.stdoutBase64,'base64');need(b.toString('base64')===v.stdoutBase64&&b.length===v.stdoutBytes&&b.toString('hex')===Buffer.from('L2_NORMAL').toString('hex'),'NORMAL_OUTPUT');
  }else need(status===1&&v.stdoutBase64===''&&(v.reason!=='NONE'||!cleaned),'FAILED_EXIT');
  return {diagnosticCollected:cleaned&&o!==null&&o.stopped&&o.failure==='NONE',identityCoverage:!!o?.identityCoverage,parentEvidenceComplete:false,originalNormalPassed:v.outcome==='completed',sourceChainComplete:false,l2Approved:false,transportRun:false,cleanupConfirmed:cleaned};
}
function parseReceipt(raw,status){need(Buffer.isBuffer(raw)&&raw.length<=131072,'WIRE');const s=new TextDecoder('utf-8',{fatal:true}).decode(raw);need(!s.includes('\ufffd'),'WIRE');return inspectReceipt(JSON.parse(s),status);}
function chain(p){let q=path.resolve(p);for(;;){const st=fs.lstatSync(q);need(!st.isSymbolicLink(),'SOURCE_LINK');const up=path.dirname(q);if(up===q)break;q=up;}}
const HELPER=path.join(ROOT,'artifacts/psr-l2/member-diag-v3/psr-l2-member-diag.exe');
const COMPILE=path.join(__dirname,'CodexL2成员诊断单次编译v3-20261028.json');
const OUTPUT=path.join(__dirname,'CodexL2成员诊断运行v5-20261028.json');
function verify(){
  need(process.execPath===NODE&&process.cwd()===ROOT&&path.resolve(__dirname,'../..')===ROOT,'HOST');
  need(H(process.binding('natives')['internal/child_process'])==='4a8a847aaf6f63b482bb2d99cf27a6718db6ba1724d56bc02a77dd6d2aa601a6','NODE_INTERNAL_DRIFT');
  chain(CONFIG);const raw=fs.readFileSync(CONFIG);need(H(raw)===CONFIG_HASH,'CONFIG_DRIFT');const c=JSON.parse(raw);
  for(const f of [c.host,c.compiler,c.compilerConfig,...c.references,...c.sources,c.definitionRecord]){chain(f.path);need(fs.lstatSync(f.path).isFile()&&H(fs.readFileSync(f.path))===f.sha256,'SOURCE_DRIFT');}
  need(RELEASE.ready===true,'ARTIFACT_NOT_BOUND');
  chain(COMPILE);need(H(fs.readFileSync(COMPILE))==='25460fe6161c58c33a084e0f71641adb9e810ad9bd188377f3a3fb1c0bf85eca','COMPILE_DRIFT');
  chain(HELPER);const b=fs.readFileSync(HELPER);need(fs.lstatSync(HELPER).isFile()&&b.length===24576&&H(b)===RELEASE.helperSha256,'HELPER_DRIFT');
  need(H(fs.readFileSync(path.join(ROOT,'AGENTS.md')))==='67870feaec75dd6694ba782e593f70009db9a4c2253bec564602f7955c535c4c','WORKSPACE_DRIFT');
  return {config:H(raw),helper:H(b),artifactBound:true,driver:H(fs.readFileSync(__filename))};
}
// Private single-purpose runner. All vectors originate here; nothing accepts overrides.
async function runNormal(){
  need(RELEASE.ready===true,'ARTIFACT_NOT_BOUND');
  need(state.attempts.length===0&&state.unexpected===0,'RUNNER_SEQUENCE');verify();
  const a={attempted:true,spawnCallEntered:false,spawnReturned:false,creationState:'not-attempted',pid:null,closed:false,status:null,signal:null,stdoutBytes:0,stderrBytes:0,killRequested:false,killAccepted:null,unrefRequested:false,pipeDestroyRequests:0,localReleaseError:false,failure:null};state.attempts.push(a);
  return new Promise(resolve=>{
    let child,done=false,timer,reap,chunks=[],setupPipes=[];
    function finish(){if(done)return;done=true;clearTimeout(timer);clearTimeout(reap);
      // Release only locally retained wait handles. This is NOT Job cleanup proof.
      if(a.failure){for(const s of setupPipes){a.pipeDestroyRequests++;try{s.destroy();}catch{a.localReleaseError=true;}}if(child){a.unrefRequested=true;try{child.unref();}catch{a.localReleaseError=true;}}}
      const raw=a.failure?null:Buffer.concat(chunks);for(const b of chunks)b.fill(0);chunks=[];resolve({raw,a});}
    function observePid(){a.pid=Number.isSafeInteger(child.pid)&&child.pid>0?child.pid:null;if(a.pid)a.creationState='pid-observed';}
    function stop(code){a.failure||=code;if(done||a.closed)return;if(!a.killRequested){a.killRequested=true;try{a.killAccepted=child.kill('SIGKILL')===true;}catch{a.killAccepted=false;}if(!done)reap=setTimeout(()=>{a.failure='PROCESS_NOT_CLOSED';finish();},1000);}}
    try{child=new RawChild();}catch{a.failure='CHILD_CONSTRUCTOR_FAILED';finish();return;}
    child.on('error',()=>{observePid();stop('PROCESS_ERROR');});
    child.on('close',(code,signal)=>{a.closed=true;a.status=code;a.signal=signal||null;if(![0,1].includes(code)||signal||!a.pid)a.failure||='PROCESS_EXIT';finish();});
    // Use the pinned Node ChildProcess API. The object is retained before native spawn.
    // args includes argv[0]; envPairs replaces inherited environment. No shell normalization.
    try{
      a.spawnCallEntered=true;a.creationState='unknown';pipeAllowance=2;pipeSink=s=>{setupPipes.push(s);s.on('error',()=>stop('STREAM_ERROR'));};
      spawnChild.call(child,{file:HELPER,args:[HELPER,'normal'],cwd:ROOT,detached:false,windowsHide:true,windowsVerbatimArguments:false,envPairs:['SystemRoot=C:\\Windows','WINDIR=C:\\Windows'],stdio:['ignore','pipe','pipe']});
      a.spawnReturned=true;observePid();
    }catch{observePid();stop('SPAWN_SETUP_FAILED');return;}finally{pipeAllowance=0;pipeSink=null;}
    function receive(key,b){if(done)return;if(!Buffer.isBuffer(b)){stop('OUTPUT_TYPE');return;}a[key+'Bytes']+=b.length;if(a.stdoutBytes+a.stderrBytes>131072){stop('OUTPUT_LIMIT');return;}if(key==='stderr'&&b.length){stop('STDERR');return;}if(!a.failure&&key==='stdout')chunks.push(Buffer.from(b));}
    if(!child.stdout||!child.stderr)stop('STREAM_MISSING');else for(const key of ['stdout','stderr']){child[key].on('data',b=>receive(key,b));child[key].on('error',()=>stop('STREAM_ERROR'));}
    if(!done)timer=setTimeout(()=>stop('TIMEOUT'),10000);
  });
}
async function main(){
  const report={schema:'codex-l2-member-bound-driver/5',basisCommit:'c537b8d',executionRequested:false,preparationValidated:false,receipt:null,assessment:null,treeCleanupConfirmed:false,failure:null,l2Approved:false,transportRun:false,realInputApproved:false};let writable=false;
  try{
    const args=process.argv.slice(2);need(args.length===0||args.length===1&&args[0]==='--execute-normal-once','CLI');report.executionRequested=args.length===1;
    need(RELEASE.ready===true,'ARTIFACT_NOT_BOUND');
    chain(path.dirname(OUTPUT));need(!fs.existsSync(OUTPUT),'EVIDENCE_EXISTS');writable=report.executionRequested;
    probing=true;try{cp.spawn('denied');}catch{}try{require('node:https').request('denied');}catch{}probing=false;need(state.probes===2,'PROBES');
    report.inputsBefore=verify();need(state.unexpected===0,'OS_BLOCKED');
    if(report.executionRequested){const r=await runNormal();need(!r.a.failure,r.a.failure);need(r.a.closed,'PROCESS_NOT_CLOSED');
      try{report.assessment=parseReceipt(r.raw,r.a.status);report.receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.raw));}finally{if(r.raw)r.raw.fill(0);}
      report.treeCleanupConfirmed=report.assessment.cleanupConfirmed;
      need(report.assessment.originalNormalPassed,'NORMAL_FAILED');
    }
  }catch(e){probing=false;report.failure={code:e.code||'LOCAL_FAILURE'};}
  try{report.inputsFinal=verify();}catch(e){report.failure||={code:e.code||'FINAL_CHECK_FAILED'};}
  report.observations=state;
  report.preparationValidated=!report.executionRequested&&!report.failure&&state.unexpected===0&&state.attempts.length===0;
  report.ok=report.executionRequested&&!report.failure&&state.unexpected===0&&state.attempts.length===1&&report.treeCleanupConfirmed;
  report.exitCode=report.ok?0:report.preparationValidated?2:1;
  try{const text=JSON.stringify(report,null,2)+'\n';if(writable)fs.writeFileSync(OUTPUT,text,{flag:'wx'});fs.writeSync(1,text);process.exitCode=report.exitCode;}catch{fs.writeSync(1,'{"ok":false,"exitCode":1,"failure":"OUTPUT_WRITE_FAILED"}\n');process.exitCode=1;}
}
module.exports={inspectReceipt,parseReceipt};if(require.main===module)main();
