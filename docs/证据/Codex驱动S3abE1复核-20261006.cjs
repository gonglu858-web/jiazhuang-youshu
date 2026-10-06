'use strict';
// Review-only. Actual driver and evidence assertions; synthetic storage/API and
// an in-memory filesystem for failure injection into safeRerun. No cloud calls.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'), results=[];
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const history=fs.readdirSync(__dirname).filter(n=>/\.(cjs|json)$/.test(n)&&!n.startsWith('Codex驱动S3abE1')&&!n.startsWith('Codex本次S3ab')).map(n=>path.join(__dirname,n));
const before=Object.fromEntries(history.map(f=>[f,hash(f)]));
function compile(source,file,extras={}){const m={exports:{}};vm.runInThisContext(`(function(require,module,exports,__dirname,__filename,__rerun){${source}\n})`,{filename:file})(createRequire(file),m,m.exports,path.dirname(file),file,extras.rerun);return m.exports;}
function helpers(){const file=path.join(root,'miniapp/tests/sandbox-test-driver.test.cjs'),s=fs.readFileSync(file,'utf8');return compile(s.slice(0,s.indexOf('\ntest('))+'\nmodule.exports={loadDriver,openProof,baseInput,makeStorage,makeApi,resetAll,ctxFor,coordinator,scheduleOk,IDENTIFY_OK,MEMBERS_OK};',file);}
const tick=()=>new Promise(r=>setImmediate(r));
async function rerunAssertions(){
 const prior=path.join(__dirname,'WorkBuddy返修R1R5复现-20261005.cjs');
 const priorOutput=path.join(__dirname,'Codex本次S3ab前轮34-20261006.cjs');
 await compile(fs.readFileSync(prior,'utf8').replace('(async () => {','module.exports=(async () => {'),priorOutput);
 const p=JSON.parse(fs.readFileSync(priorOutput.replace(/cjs$/,'json'),'utf8'));
 const current=path.join(__dirname,'WorkBuddy返修S1S5复现-20261006.cjs');
 const currentOutput=path.join(__dirname,'Codex本次S3ab上轮18-20261006.cjs');
 // Prior was already executed and awaited; omit duplicate nested execution.
 let s=fs.readFileSync(current,'utf8').replace('async function safeRerun(options) {','async function safeRerun(options) { return __rerun(options);').replace('(async () => {','module.exports=(async () => {');
 await compile(s,currentOutput,{rerun:async()=>({reran:true,awaited:true,summary:p.summary,executionMode:'reviewer separately awaited current run',output:priorOutput.replace(/cjs$/,'json')})});
 const c=JSON.parse(fs.readFileSync(currentOutput.replace(/cjs$/,'json'),'utf8'));
 const eight=path.join(__dirname,'WorkBuddy安全重跑与S3ab复现-20261006.cjs');
 s=fs.readFileSync(eight,'utf8');
 const end=s.indexOf('  // ── E1：安全重跑',s.indexOf('(async () => {'));
 s=s.slice(0,end)+`\n d.resetAll(); module.exports.results=results; return results; })();`;
 const r=await compile(s.replace('(async () => {','module.exports=(async () => {'),eight);
 return {previous34:p.summary,previous18:c.summary,current8:{total:r.length,sealed:r.filter(v=>v.sealed).length,harnessErrors:r.filter(v=>v.harnessError).length},eightResults:r};
}
async function driverCases(){
 const d=helpers();
 for(const transientReadFailure of [false,true]){
  d.resetAll(); const storage=d.makeStorage(),driver=d.loadDriver(d.openProof()),api=d.makeApi({storage});
  const controls=[],timers=new Map();let tid=0;
  const clock={setTimeout(fn){timers.set(++tid,fn);return tid;},clearTimeout(id){timers.delete(id);}};
  api.cloud.callFunction=args=>{
   if(args.data.action==='identify')return Promise.resolve({result:d.IDENTIFY_OK});
   if(args.data.action==='getMembers')return Promise.resolve({result:d.MEMBERS_OK});
   return new Promise((resolve,reject)=>controls.push({resolve,reject}));
  };
  const running=driver.runCase({api,testCaseId:'V06-a',input:d.baseInput(),timers:clock});
  for(let i=0;i<30&&controls.length<2;i++)await tick();
  for(const [id,fn] of [...timers]){timers.delete(id);fn();}
  const outcome=await running;
  const stateBefore=d.coordinator.readCase(d.ctxFor(storage),'V06-a').record.state;
  let throws=0;
  if(transientReadFailure){const get=storage.getStorageSync;storage.getStorageSync=k=>{if(throws++===0)throw new Error('one synthetic read failure');return get(k);};}
  // Only slot 1 (the second request) has a late response. Both share requestId.
  controls[1].resolve({result:d.scheduleOk({content:'SECOND_SLOT_LATE'})});await tick();await tick();
  const rec=d.coordinator.readCase(d.ctxFor(storage),'V06-a').record;
  results.push({id:transientReadFailure?'late-first-read-fails-once':'same-id-two-timeouts-second-slot-late',stateBefore,stateAfter:rec.state,verdict:outcome.report.verdict,responses:rec.responses,lateArrivals:rec.lateArrivals,lateHasSlotIdentifier:rec.lateArrivals?.every(v=>Number.isInteger(v.slotIndex)||Number.isInteger(v.index)),stateRegressed:stateBefore==='stopped'&&rec.state==='inFlight'});
 }
 d.resetAll();
}
async function replayFailureCases(){
 const file=path.join(__dirname,'WorkBuddy安全重跑与S3ab复现-20261006.cjs'),s=fs.readFileSync(file,'utf8');
 const fn=s.slice(s.indexOf('async function safeRerun(options) {'),s.indexOf('// ── 合成 API'));
 for(const code of ['ETIMEDOUT','EBUSY']){
  const files=new Map(),src=path.join(root,'docs/证据/synthetic-evidence.cjs');files.set(src,'synthetic-source');
  let starts=0,taskCompleted=false;
  const fakeFs={readFileSync:p=>files.get(p),existsSync:p=>files.has(p),mkdirSync(){},copyFileSync(a,b){files.set(b,files.get(a));},rmSync:p=>files.delete(p),statSync:p=>({size:String(files.get(p)).length,mtimeMs:1})};
  const fakeHash=p=>crypto.createHash('sha256').update(String(files.get(p))).digest('hex');
  const fakeRequire=n=>{
   if(n==='node:child_process')return{spawnSync(){if(code==='ETIMEDOUT')starts++;return{error:{code},status:null};}};
   starts++;files.set(n.replace(/\.cjs$/,'.json'),JSON.stringify({summary:{total:1,sealed:1},executedAt:'synthetic'}));
   // Publishing a JSON file is not equivalent to completion of this task.
   taskCompleted=false;return {};
  };
  const call=vm.runInThisContext(`(function(fs,path,root,sha256File,require,process,setTimeout){${fn};return safeRerun;})`)(fakeFs,path,root,fakeHash,fakeRequire,process,(cb)=>setImmediate(cb));
  const r=await call({label:'synthetic',sourceScript:'docs/证据/synthetic-evidence.cjs'});
  results.push({id:'e1-'+code,syntheticExecutionsStarted:starts,actualTaskCompleted:taskCompleted,claimedReran:r.reran,claimedAwaited:r.awaited,executionMode:r.executionMode});
 }
}
(async()=>{
 const reruns=await rerunAssertions();await driverCases();await replayFailureCases();
 const drift=history.filter(f=>hash(f)!==before[f]);
 const out={executedAt:new Date().toISOString(),scope:'local actual modules; synthetic failures; no cloud',reruns,historyChecked:history.length,historyDrift:drift,results};
 fs.writeFileSync(__filename.replace(/\.cjs$/,'.json'),JSON.stringify(out,null,2)+'\n');
 console.log(JSON.stringify({reruns:{previous34:reruns.previous34,previous18:reruns.previous18,current8:reruns.current8},historyDrift:drift,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
