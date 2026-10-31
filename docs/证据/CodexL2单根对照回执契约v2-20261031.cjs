'use strict';
// Pure preparation contract; no filesystem, network or launch API.
// Receipt grammar derived from pinned v5, without importing its executable driver.
const FIXED={
  "schema": "codex-l2-root-only-preparation/1",
  "mode": "rootOnly",
  "executionReady": false,
  "artifactBound": false,
  "root": "C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP",
  "node": "C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe",
  "nodeSha256": "c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19",
  "nodeArgs": [
    "-e",
    "process.stdout.write('L2_ROOT_ONLY');"
  ],
  "helperArgs": [
    "rootOnly"
  ],
  "expectedProcesses": 1,
  "output": "L2_ROOT_ONLY",
  "creationFlags": 134218756,
  "environmentPairs": [
    "SystemRoot=C:\\Windows",
    "WINDIR=C:\\Windows"
  ],
  "cwd": "C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP",
  "memberLimit": 16,
  "eventLimit": 128,
  "workBudgetMs": 5000,
  "cleanupBudgetMs": 2000,
  "receiptElapsedLimitMs": 7500,
  "driverTimeoutMs": 10000,
  "outputLimitBytes": 131072,
  "sources": [
    {
      "rel": "docs/证据/CodexL2单根对照辅助层v2-20261031.cs",
      "sha256": "408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b"
    },
    {
      "rel": "docs/证据/CodexL2成员观察器v3-20261028.cs",
      "sha256": "722d28e9e2f145d9bcf4e00fb82ee4837ec4b365d53bdd86b4472a6228fd9019"
    }
  ]
};
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
freeze(FIXED);
function validateConfig(raw){need(Buffer.isBuffer(raw)&&raw.length<=16384,'CONFIG_WIRE');const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);need(!text.includes('\ufffd'),'CONFIG_WIRE');const parsed=JSON.parse(text);need(JSON.stringify(parsed)===JSON.stringify(FIXED),'CONFIG_MISMATCH');return FIXED;}
function need(v,code){if(!v)throw Object.assign(Error(code),{code});}
function exact(o,keys){return o&&typeof o==='object'&&!Array.isArray(o)&&JSON.stringify(Object.keys(o).sort())===JSON.stringify(keys.slice().sort());}
function uint(x){return Number.isSafeInteger(x)&&x>=0&&x<=4294967295;}
const BASE=['schema','mode','outcome','reason','created','assigned','resumed','pid','rootExited','rootExit','jobEmpty','totalProcesses','activeProcesses','killRequested','killAccepted','readersDone','handlesClosed','cleanupConfirmed','stdoutBytes','stderrBytes','stdoutBase64','elapsedMs','accountingLayoutVerified','observation'];
const OBS=['failure','identityCoverage','parentEvidenceComplete','notificationCompletenessGuaranteed','stopped','handlesClosed','duplicateNew','finalTotal','events','members'];
const MEMBER=['pid','creationTime','image','pathClass','state','root','parent','newSeen','listed','exitSeen'];
const OBS_CODES=['NONE','OBS_ASSOCIATE','OBS_MEMBER_LIMIT','OBS_QUEUE','OBS_EVENT_LIMIT','OBS_KEY','OBS_EVENT_TYPE','OBS_PID','OBS_CENSUS','OBS_CENSUS_SIZE','OBS_CENSUS_PID','OBS_QUERY_EXCEPTION','OBS_FINAL_QUERY','OBS_CLOSE'];
const REASONS=['NONE','MODE','SOURCE_MISSING','SOURCE_LINK','SOURCE_HASH','JOB_CREATE','JOB_SET','JOB_LIMITS','PIPE','STDIN','CREATE','JOB_ASSIGN','HANDLE_CLOSE','RESUME','JOB_QUERY','WAIT','EXIT_CODE','OUTPUT_LIMIT','STDERR','READ','TIMEOUT','ROOT_EXIT','TREE_COUNT','TIMEOUT_NOT_REACHED','HELPER_ERROR','OBS_LAYOUT','OBS_PORT','OBS_FAILURE','OBS_MEMBER_LIMIT'];
function inspectReceipt(v,status){
  need(exact(v,BASE)&&v.schema==='codex-l2-root-only-job/1'&&v.mode==='rootOnly','RECEIPT_SHAPE');
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
    need(status===0&&v.reason==='NONE'&&cleaned&&v.created&&v.assigned&&v.resumed&&v.rootExited&&v.rootExit===0&&v.totalProcesses===1&&!v.killRequested&&!v.killAccepted&&v.stderrBytes===0&&v.accountingLayoutVerified&&o!==null&&o.failure==='NONE'&&o.stopped&&o.identityCoverage&&o.members.length===1&&o.members[0].root&&o.members[0].image==='FIXED_NODE'&&o.members[0].pathClass==='FIXED_NODE_PATH','ROOT_ONLY_CONTRADICTION');
    const b=Buffer.from(v.stdoutBase64,'base64');need(b.toString('base64')===v.stdoutBase64&&b.length===v.stdoutBytes&&b.toString('hex')===Buffer.from('L2_ROOT_ONLY').toString('hex'),'ROOT_ONLY_OUTPUT');
  }else need(status===1&&v.stdoutBase64===''&&(v.reason!=='NONE'||!cleaned),'FAILED_EXIT');
  return {diagnosticCollected:cleaned&&o!==null&&o.stopped&&o.failure==='NONE',identityCoverage:!!o?.identityCoverage,parentEvidenceComplete:false,rootOnlyPassed:v.outcome==='completed',sourceChainComplete:false,l2Approved:false,transportRun:false,cleanupConfirmed:cleaned};
}
function parseReceipt(raw,status){need(Buffer.isBuffer(raw)&&raw.length<=131072,'WIRE');const s=new TextDecoder('utf-8',{fatal:true}).decode(raw);need(!s.includes('\ufffd'),'WIRE');return inspectReceipt(JSON.parse(s),status);}

// Only bounded serialized JSON enters the public assessment interface.
function assess(raw,status,factsRaw){
  const a=parseReceipt(raw,status);
  need(Buffer.isBuffer(factsRaw)&&factsRaw.length<=4096,'FACTS_WIRE');
  const s=new TextDecoder('utf-8',{fatal:true}).decode(factsRaw);need(!s.includes('\ufffd'),'FACTS_WIRE');const f=JSON.parse(s);
  need(exact(f,['attempts','unexpected','closed','status','signal','failure','killRequested','stderrBytes','receiptExistsBefore','sourcesBefore','sourcesAfter']),'FACTS_SHAPE');
  need(f.attempts===1&&f.unexpected===0&&f.closed===true&&f.status===status&&f.signal===null&&f.failure===null&&f.killRequested===false&&f.stderrBytes===0&&f.receiptExistsBefore===false&&f.sourcesBefore===true&&f.sourcesAfter===true,'DRIVER_FAILED');
  return Object.freeze({...a,ok:a.rootOnlyPassed,executionApproved:false,realInputApproved:false});
}
module.exports=Object.freeze({validateConfig,parseReceipt,assess});
