'use strict';
// Prepared driver. Default only checks files; --execute-once is for a later execution node.
const cp=require('node:child_process'),rawSpawn=cp.spawn.bind(cp);
let unexpected=0,starts=0;
const deny=()=>{unexpected++;throw Error('CAPABILITY_BLOCKED');};
for(const id of ['node:child_process','node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
const net=require('node:net');net.Socket.prototype.connect=deny;net.connect=net.createConnection=net.createServer=deny;globalThis.fetch=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT='C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const DIR=path.join(ROOT,'artifacts/psr-l2/observer-synthetic-v2-finalIdentity'),EXE=path.join(DIR,'observer-test.exe');
const RECEIPT=path.join(ROOT,'docs/证据/CodexL2观察器第二变体运行结果v1-20261029.json');
const HASH='b30a44b7e15fc3cc0af873855da7731823367deffe9b1621589bd77b5e41645a';
const PINS=[
 [EXE,HASH],
 [path.join(ROOT,'docs/证据/CodexL2观察器第二变体只读v1-20261029.json'),'c5e4e5ce3b26c1f4783be9becb44548b296bf46b1ff4234c92b581527d44ff5c'],
 [path.join(ROOT,'docs/证据/CodexL2观察器第二变体只读v1-20261029.cjs'),'7461b3dba817b40d612a3491d1ab1c721678654489cf49312cf16f98f056e7b6'],
 [path.join(ROOT,'docs/证据/CodexL2观察器托管调用清单v1-20261029.json'),'770cdb4dd5dfb4477b3c3b3e7b91e78cf1184cc7cf51f00a419a6dcae37cca24'],
 [path.join(ROOT,'docs/证据/CodexL2观察器单次编译v2-finalIdentity-20261029.json'),'b76ddd2e7cee91a90d13b15077109955e68b2e84d99512c38b09c6c095e93ae1'],
 ['C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe','c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19'],
 [path.join(ROOT,'docs/证据/CodexL2观察器基线运行结果v1-20261029.json'),'3afe46f96d470194f0853624662c8d0e106426841a872d279d11e569e708ff70'],
 [path.join(ROOT,'docs/证据/CodexL2观察器合成夹具v2-20261029.cs'),'d8ad9ff7404a5d5060d57c0ee3872a0957d0ff0f19113cceff6f0d6d55842646']
];
let expectedResults;
const FINAL_FAILURE={name:'final1',ok:false,calls:14,unexpected:2,owned:1,closeAttempts:1,closed:0,closeFailures:1,remainingSteps:0};
// 2 constructor + 6 capture + 3 poll + time + unexpected job + failed port close = 14.
// These two synthetic fixture faults are required; driver guard hits remain forbidden.

const need=(x,c)=>{if(!x)throw Error(c);},hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function chain(p){for(;;){need(!fs.lstatSync(p).isSymbolicLink(),'PATH_LINK');const up=path.dirname(p);if(up===p)break;p=up;}}
function preflight(){
 need(process.execPath===PINS[5][0],'HOST');
 const snapshots=[];for(const [p,h] of PINS){chain(p);need(fs.lstatSync(p).isFile(),'FILE_TYPE');const b=fs.readFileSync(p);need(hash(b)===h,'HASH');snapshots.push(b);}
 const base=JSON.parse(snapshots[6]);need(base.ok===true&&base.process.result.ok===true&&base.process.result.results.length===72,'BASELINE');
 const prefix=base.process.result.results.slice(0,46),names=['classification'];for(let i=0;i<14;i++)names.push('captureBorrowed'+i,'captureOwned'+i);for(let i=0;i<9;i++)names.push('census'+i);for(let i=0;i<7;i++)names.push('queue'+i);names.push('final0');
 need(prefix.every((v,i)=>v.name===names[i]&&v.ok===true),'BASELINE_PREFIX');expectedResults=prefix.concat([FINAL_FAILURE]);
 need(JSON.stringify(fs.readdirSync(DIR).sort())===JSON.stringify(['fixture.cs','observer-test.exe','observer.cs','tmp']),'DIRECTORY_SET');
 chain(path.join(DIR,'tmp'));need(fs.readdirSync(path.join(DIR,'tmp')).length===0,'TEMP_DIRTY');
 const review=JSON.parse(fs.readFileSync(PINS[1][0]));need(review.ok===true&&review.staticCapabilityReviewPassed===true&&review.caseId==='finalIdentity'&&review.mutantSha256===HASH,'REVIEW');
}
function result(b){
 const s=new TextDecoder('utf8',{fatal:true}).decode(b);need(!s.includes('\ufffd'),'UTF8');
 need(/^\{[^\r\n]*\}\r?\n$/.test(s),'ONE_LINE');const r=JSON.parse(s),eq=(x,y)=>JSON.stringify(Object.keys(x).sort())===JSON.stringify(y.sort());
 need(eq(r,['schema','results','ok','nativeExecuted','l2Approved'])&&r.schema==='codex-observer-synthetic/2'&&r.ok===false&&r.nativeExecuted===false&&r.l2Approved===false,'RESULT');
 need(Array.isArray(r.results)&&r.results.length===47,'CASE_COUNT');
 for(let i=0;i<47;i++){
  const v=r.results[i],e=expectedResults[i];need(v!==null&&typeof v==='object'&&eq(v,['name','ok','calls','unexpected','owned','closeAttempts','closed','closeFailures','remainingSteps']),'CASE_FIELDS');
  need(v.name===e.name&&v.ok===e.ok,'CASE');
  for(const k of ['calls','unexpected','owned','closeAttempts','closed','closeFailures','remainingSteps'])need(Number.isSafeInteger(v[k])&&v[k]===e[k],'CASE_FACTS');
 }return r;
}
async function run(){
 need(starts===0,'SECOND_START');starts++;
 const r={attempted:true,pid:null,closed:false,spawnFailed:false,exitCode:null,signal:null,stdoutBytes:0,stderrBytes:0,killRequested:false,killAccepted:null,failure:null,result:null};
 return new Promise(resolve=>{let child,timer,reap,done=false,chunks=[];
  function finish(){if(done)return;done=true;clearTimeout(timer);clearTimeout(reap);if(!r.failure){try{r.result=result(Buffer.concat(chunks));}catch(e){r.failure=e.message;}}chunks=[];resolve(r);}
  function stop(code){r.failure||=code;if(done||r.closed||r.spawnFailed)return;if(!r.killRequested){r.killRequested=true;try{r.killAccepted=child.kill('SIGKILL')===true;}catch{r.killAccepted=false;}if(!done)reap=setTimeout(()=>{r.failure='CLOSE_UNCONFIRMED';finish();},2000);}}
  try{child=rawSpawn(EXE,[],{cwd:DIR,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:path.join(DIR,'tmp'),TMP:path.join(DIR,'tmp')}});}catch{r.spawnFailed=true;r.failure='START_FAILED';finish();return;}
  r.pid=Number.isSafeInteger(child.pid)&&child.pid>0?child.pid:null;
  child.on('error',()=>{if(!r.pid){r.spawnFailed=true;r.failure='START_FAILED';finish();}else stop('PROCESS_ERROR');});
  child.on('close',(code,signal)=>{r.closed=true;r.exitCode=Number.isInteger(code)?code:null;r.signal=signal||null;if(code!==1||signal)r.failure||='PROCESS_EXIT';if(!r.pid)r.failure||='PID_MISSING';finish();});
  if(!child.stdout||!child.stderr)stop('STREAM_MISSING');else for(const k of ['stdout','stderr']){child[k].on('data',b=>{if(done)return;if(!Buffer.isBuffer(b)){stop('OUTPUT_TYPE');return;}r[k+'Bytes']+=b.length;if(r.stdoutBytes+r.stderrBytes>131072){stop('OUTPUT_LIMIT');return;}if(k==='stderr'&&b.length){stop('STDERR');return;}if(k==='stdout')chunks.push(Buffer.from(b));});child[k].on('error',()=>stop('STREAM_ERROR'));}
  if(!done)timer=setTimeout(()=>stop('TIMEOUT'),30000);
 });
}
async function main(args){
 const report={schema:'codex-observer-second-mutant-run/1',basisCommit:'b159541',caseId:'finalIdentity',binarySha256:HASH,executionRequested:false,process:null,failure:null,expectedFailureObserved:false,l2Approved:false,descendantCoverage:'NOT_OBSERVED',directCloseConfirmed:false};let fd;
 try{
  need(args.length===0||(args.length===1&&args[0]==='--execute-once'),'CLI');report.executionRequested=args.length===1;preflight();
  if(report.executionRequested){chain(path.dirname(RECEIPT));fd=fs.openSync(RECEIPT,'wx');preflight();report.process=await run();report.directCloseConfirmed=report.process.closed;try{preflight();report.postcheckPassed=true;}catch{report.postcheckPassed=false;throw Error('POSTCHECK');}need(!report.process.failure,report.process.failure);}
 }catch(e){report.failure=e.message;}
 report.starts=starts;report.guardUnexpected=unexpected;report.ok=!report.failure&&unexpected===0;report.expectedFailureObserved=report.ok&&report.executionRequested;report.exitCode=report.ok?(report.executionRequested?0:2):1;
 const text=JSON.stringify(report,null,2)+'\n';try{if(fd!==undefined)fs.writeSync(fd,text);}catch{report.ok=false;report.expectedFailureObserved=false;report.exitCode=1;report.failure='RECEIPT_WRITE';}finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{report.ok=false;report.expectedFailureObserved=false;report.exitCode=1;report.failure='RECEIPT_CLOSE';}}
 return report;
}
module.exports={main};
if(require.main===module)main(process.argv.slice(2)).then(r=>{fs.writeSync(1,JSON.stringify(r)+'\n');process.exitCode=r.exitCode;},()=>{process.exitCode=1;});
