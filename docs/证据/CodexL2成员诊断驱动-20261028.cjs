'use strict';
// Preparation-only entry: no captured OS runner and no execution escape hatch.
const RELEASE=Object.freeze({ready:false,helperSha256:null});
const state={probes:0,unexpected:0};let probing=false;
function deny(){state[probing?'probes':'unexpected']++;throw Error('OS_BLOCKED');}
const cp=require('node:child_process');for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const id of ['node:http','node:https','node:net','node:tls','node:dgram','node:dns']){
  const m=require(id);if(id==='node:net')m.Socket.prototype.connect=deny;
  if(id==='node:dns')for(const k of Object.keys(m.promises))if(typeof m.promises[k]==='function')m.promises[k]=deny;
  for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});
}globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT='C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const NODE='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const CONFIG=path.join(__dirname,'CodexL2成员诊断编译草案-20261028.json');
const CONFIG_HASH='aa42d0ec2d1fc9641f50556edcf3fc81f5f3031525541481c51308cf21c7c70a';
const H=b=>crypto.createHash('sha256').update(b).digest('hex');
function need(v,code){if(!v)throw Object.assign(Error(code),{code});}
function exact(o,keys){return o&&typeof o==='object'&&!Array.isArray(o)&&JSON.stringify(Object.keys(o).sort())===JSON.stringify(keys.slice().sort());}
function uint(x){return Number.isSafeInteger(x)&&x>=0&&x<=4294967295;}
const BASE=['schema','mode','outcome','reason','created','assigned','resumed','pid','rootExited','rootExit','jobEmpty','totalProcesses','activeProcesses','killRequested','killAccepted','readersDone','handlesClosed','cleanupConfirmed','stdoutBytes','stderrBytes','stdoutBase64','elapsedMs','accountingLayoutVerified','observation'];
const OBS=['failure','identityCoverage','parentEvidenceComplete','notificationCompletenessGuaranteed','stopped','handlesClosed','duplicateNew','finalTotal','events','members'];
const MEMBER=['pid','creationTime','image','state','root','parent','newSeen','listed','exitSeen'];
const OBS_CODES=['NONE','OBS_ASSOCIATE','OBS_MEMBER_LIMIT','OBS_QUEUE','OBS_EVENT_LIMIT','OBS_KEY','OBS_EVENT_TYPE','OBS_PID','OBS_CENSUS','OBS_CENSUS_SIZE','OBS_CENSUS_PID','OBS_QUERY_EXCEPTION','OBS_FINAL_QUERY','OBS_CLOSE'];
const REASONS=['NONE','MODE','SOURCE_MISSING','SOURCE_LINK','SOURCE_HASH','JOB_CREATE','JOB_SET','JOB_LIMITS','PIPE','STDIN','CREATE','JOB_ASSIGN','HANDLE_CLOSE','RESUME','JOB_QUERY','WAIT','EXIT_CODE','OUTPUT_LIMIT','STDERR','READ','TIMEOUT','ROOT_EXIT','TREE_COUNT','TIMEOUT_NOT_REACHED','HELPER_ERROR','OBS_LAYOUT','OBS_PORT','OBS_FAILURE','OBS_MEMBER_LIMIT'];
function inspectReceipt(v,status){
  need(exact(v,BASE)&&v.schema==='codex-l2-member-job/1'&&v.mode==='normal','RECEIPT_SHAPE');
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
function verify(){
  need(process.execPath===NODE&&path.resolve(__dirname,'../..')===ROOT,'HOST');
  chain(CONFIG);const raw=fs.readFileSync(CONFIG);need(H(raw)===CONFIG_HASH,'CONFIG_DRIFT');const c=JSON.parse(raw);
  need(c.executionAuthorized===false&&c.helperExecutionAuthorized===false&&c.schema==='codex-l2-member-compile-draft/1','CONFIG');
  for(const f of [c.host,c.compiler,c.compilerConfig,...c.references,...c.sources,c.definitionRecord]){chain(f.path);need(H(fs.readFileSync(f.path))===f.sha256,'SOURCE_DRIFT');}
  need(!fs.existsSync(c.outputRoot),'OUTPUT_ALREADY_EXISTS');return H(raw);
}
function main(){
  let failure=null,digests=null;
  try {
    need(process.argv.length===2,'EXECUTION_DISABLED');
    probing=true;try{cp.spawn('denied');}catch{}try{require('node:https').request('denied');}catch{}probing=false;
    need(state.probes===2,'PROBES');const config=verify();digests={config,driver:H(fs.readFileSync(__filename))};
  }catch(e){probing=false;failure=e.code||'PREPARATION_FAILED';}
  const preparationValidated=!failure&&state.unexpected===0;
  const r={schema:'codex-l2-member-preparation/1',preparationValidated,release:RELEASE,executionReady:false,actualOSStarts:0,observations:state,digests,failure,ok:false,exitCode:preparationValidated?2:1};
  fs.writeSync(1,JSON.stringify(r,null,2)+'\n');process.exitCode=r.exitCode;
}
module.exports={inspectReceipt,parseReceipt};if(require.main===module)main();
