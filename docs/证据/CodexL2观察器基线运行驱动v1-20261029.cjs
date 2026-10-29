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
const DIR=path.join(ROOT,'artifacts/psr-l2/observer-synthetic-v2-baseline'),EXE=path.join(DIR,'observer-test.exe');
const RECEIPT=path.join(ROOT,'docs/证据/CodexL2观察器基线运行结果v1-20261029.json');
const HASH='d6c3fdfca6893ede87afb8c866dbc637c5c45e36def2ac8140266d08b3ba215b';
const PINS=[
 [EXE,HASH],
 [path.join(ROOT,'docs/证据/CodexL2观察器托管能力只读v1-20261029.json'),'d90e75dedbe6c69faf991aff19f16177f52d39f3868a10878890eb7af5606116'],
 [path.join(ROOT,'docs/证据/CodexL2观察器托管能力只读v1-20261029.cjs'),'474d8aebdcc7f686440ac5587ec94bf0def67a5cc6f104b8b3d27d91dfa7d8db'],
 [path.join(ROOT,'docs/证据/CodexL2观察器托管调用清单v1-20261029.json'),'770cdb4dd5dfb4477b3c3b3e7b91e78cf1184cc7cf51f00a419a6dcae37cca24'],
 [path.join(ROOT,'docs/证据/CodexL2观察器单次编译v2-baseline-20261029.json'),'a0d33fe1a57c43b9011f9fa09ee3f7fec74207fb67fe278aa7041d578c4a02b9'],
 ['C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe','c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19']
];
const need=(x,c)=>{if(!x)throw Error(c);},hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function chain(p){for(;;){need(!fs.lstatSync(p).isSymbolicLink(),'PATH_LINK');const up=path.dirname(p);if(up===p)break;p=up;}}
function preflight(){
 need(process.execPath===PINS[5][0],'HOST');
 for(const [p,h] of PINS){chain(p);need(fs.lstatSync(p).isFile(),'FILE_TYPE');need(hash(fs.readFileSync(p))===h,'HASH');}
 need(JSON.stringify(fs.readdirSync(DIR).sort())===JSON.stringify(['fixture.cs','observer-test.exe','observer.cs','tmp']),'DIRECTORY_SET');
 chain(path.join(DIR,'tmp'));need(fs.readdirSync(path.join(DIR,'tmp')).length===0,'TEMP_DIRTY');
 const review=JSON.parse(fs.readFileSync(PINS[1][0]));need(review.ok===true&&review.staticCapabilityReviewPassed===true&&review.binarySha256===HASH,'REVIEW');
}
function names(){const a=['classification'];for(let i=0;i<14;i++)a.push('captureBorrowed'+i,'captureOwned'+i);for(const [p,n] of [['census',9],['queue',7],['final',6],['port',4]])for(let i=0;i<n;i++)a.push(p+i);a.push('exitBeforeNew');for(const [p,n] of [['limit',2],['owned',7]])for(let i=0;i<n;i++)a.push(p+i);return a.concat(['rootException','twoMembers','zero','portMissing','imageException','candidateCapture','otherCapture']);}
function result(b){
 const s=new TextDecoder('utf8',{fatal:true}).decode(b);need(!s.includes('\ufffd'),'UTF8');
 need(/^\{[^\r\n]*\}\r?\n$/.test(s),'ONE_LINE');const r=JSON.parse(s),eq=(x,y)=>JSON.stringify(Object.keys(x).sort())===JSON.stringify(y.sort());
 need(eq(r,['schema','results','ok','nativeExecuted','l2Approved'])&&r.schema==='codex-observer-synthetic/2'&&r.ok===true&&r.nativeExecuted===false&&r.l2Approved===false,'RESULT');
 need(Array.isArray(r.results)&&r.results.length===72,'CASE_COUNT');
 const expected=names();r.results.forEach((v,i)=>{need(eq(v,['name','ok','calls','unexpected','owned','closeAttempts','closed','closeFailures','remainingSteps']),'CASE_FIELDS');need(v.name===expected[i]&&v.ok===true,'CASE');for(const k of ['calls','unexpected','owned','closeAttempts','closed','closeFailures','remainingSteps'])need(Number.isSafeInteger(v[k])&&v[k]>=0,'CASE_COUNTER');need(v.unexpected===0&&v.remainingSteps===0&&v.closed+v.closeFailures<=v.closeAttempts,'CASE_FACTS');});return r;
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
  child.on('close',(code,signal)=>{r.closed=true;r.exitCode=Number.isInteger(code)?code:null;r.signal=signal||null;if(code!==0||signal)r.failure||='PROCESS_EXIT';if(!r.pid)r.failure||='PID_MISSING';finish();});
  if(!child.stdout||!child.stderr)stop('STREAM_MISSING');else for(const k of ['stdout','stderr']){child[k].on('data',b=>{if(done)return;if(!Buffer.isBuffer(b)){stop('OUTPUT_TYPE');return;}r[k+'Bytes']+=b.length;if(r.stdoutBytes+r.stderrBytes>131072){stop('OUTPUT_LIMIT');return;}if(k==='stderr'&&b.length){stop('STDERR');return;}if(k==='stdout')chunks.push(Buffer.from(b));});child[k].on('error',()=>stop('STREAM_ERROR'));}
  if(!done)timer=setTimeout(()=>stop('TIMEOUT'),30000);
 });
}
async function main(args){
 const report={schema:'codex-observer-baseline-run/1',basisCommit:'24f1305',binarySha256:HASH,executionRequested:false,process:null,failure:null,l2Approved:false,descendantCoverage:'NOT_OBSERVED',directCloseConfirmed:false};let fd;
 try{
  need(args.length===0||(args.length===1&&args[0]==='--execute-once'),'CLI');report.executionRequested=args.length===1;preflight();
  if(report.executionRequested){chain(path.dirname(RECEIPT));fd=fs.openSync(RECEIPT,'wx');preflight();report.process=await run();report.directCloseConfirmed=report.process.closed;try{preflight();report.postcheckPassed=true;}catch{report.postcheckPassed=false;throw Error('POSTCHECK');}need(!report.process.failure,report.process.failure);}
 }catch(e){report.failure=e.message;}
 report.starts=starts;report.guardUnexpected=unexpected;report.ok=!report.failure&&unexpected===0;report.exitCode=report.ok?(report.executionRequested?0:2):1;
 const text=JSON.stringify(report,null,2)+'\n';try{if(fd!==undefined)fs.writeSync(fd,text);}catch{report.ok=false;report.exitCode=1;report.failure='RECEIPT_WRITE';}finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{report.ok=false;report.exitCode=1;report.failure='RECEIPT_CLOSE';}}
 return report;
}
module.exports={main};
if(require.main===module)main(process.argv.slice(2)).then(r=>{fs.writeSync(1,JSON.stringify(r)+'\n');process.exitCode=r.exitCode;},()=>{process.exitCode=1;});
