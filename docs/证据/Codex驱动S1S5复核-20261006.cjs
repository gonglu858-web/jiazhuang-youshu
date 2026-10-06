'use strict';
// Review harness only. Real local modules; synthetic wx/storage. Never runs cloud operations.
// Historical evidence output is redirected; nested prior-script execution is replaced by
// the result of the separately awaited fresh run, avoiding duplicate asynchronous execution.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..');
const prior=path.join(__dirname,'WorkBuddy返修R1R5复现-20261005.cjs');
const fresh=path.join(__dirname,'WorkBuddy返修S1S5复现-20261006.cjs');
const mappings=new Map([
 [prior.replace(/\.cjs$/,'.json'),path.join(__dirname,'Codex重跑前轮34条-20261006.json')],
 [fresh.replace(/\.cjs$/,'.json'),path.join(__dirname,'Codex重跑本轮18条-20261006.json')]
]);
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const protectedFiles=fs.readdirSync(__dirname).filter(n=>/20261005|WorkBuddy返修S1S5复现-20261006/.test(n)).map(n=>path.join(__dirname,n)).filter(f=>fs.statSync(f).isFile());
const before=Object.fromEntries(protectedFiles.map(f=>[f,hash(f)]));
async function rerun(file){
 const native=createRequire(file),m={exports:{}};
 const routedFs=new Proxy(fs,{get(target,key){
   if(key==='writeFileSync')return (p,...args)=>fs.writeFileSync(mappings.get(path.resolve(p))||p,...args);
   if(key==='readFileSync')return (p,...args)=>{const q=mappings.get(path.resolve(p));return fs.readFileSync(q&&fs.existsSync(q)?q:p,...args);};
   return target[key];
 }});
 const req=n=>{
   if(n==='node:fs')return routedFs;
   if(path.isAbsolute(n)&&path.resolve(n)===prior)return {};
   if(n==='node:child_process')return {...native(n),execFileSync:(exe,args,...rest)=>{
     if(args&&path.resolve(args[0])===prior)return ''; // already rerun and awaited above
     return native(n).execFileSync(exe,args,...rest);
   }};
   return native(n);
 };
 const source=fs.readFileSync(file,'utf8').replace('(async () => {','module.exports = (async () => {');
 vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${source}\n})`,{filename:file})(req,m,m.exports,path.dirname(file),file);
 await m.exports;
}
function helpers(){const file=path.join(root,'miniapp/tests/sandbox-test-driver.test.cjs'),src=fs.readFileSync(file,'utf8'),m={exports:{}};
 vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${src.slice(0,src.indexOf('\ntest('))}\nmodule.exports={loadDriver,openProof,baseInput,makeStorage,makeApi,resetAll,ctxFor,coordinator,scheduleOk,IDENTIFY_OK,MEMBERS_OK};})`,{filename:file})(createRequire(file),m,m.exports,path.dirname(file),file);return m.exports;}
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 await rerun(prior); await rerun(fresh);
 const d=helpers(),results=[];
 function setup(){d.resetAll();const storage=d.makeStorage(),proof=d.openProof(),driver=d.loadDriver(proof),api=d.makeApi({storage});return{storage,proof,driver,api};}
 function baseRead(args){if(args.data.action==='identify')return Promise.resolve({result:d.IDENTIFY_OK});if(args.data.action==='getMembers')return Promise.resolve({result:d.MEMBERS_OK});return null;}
 // Must use a non-async callFunction: throwing inside the standard async fixture
 // would test a rejected Promise, not the synchronous branch.
 for(const testCaseId of ['V06-a','V07-B']){
  const x=setup();let invoked=0,completed=false;
  x.api.cloud.callFunction=args=>{const read=baseRead(args);if(read)return read;
   if(args.data.action==='listSchedules')return Promise.resolve({result:{ok:true,schedules:[],pagination:{hasMore:false,nextCursor:''}}});
   invoked++;throw new Error('synthetic synchronous transport failure');};
  const input=testCaseId==='V06-a'?d.baseInput():{projectId:x.proof.projectId,userId:x.proof.v07TargetUserId};
  x.driver.runCase({api:x.api,testCaseId,input}).then(()=>{completed=true;},()=>{completed=true;});
  await new Promise(r=>setTimeout(r,80));
  const rec=d.coordinator.readCase(d.ctxFor(x.storage),testCaseId);
  results.push({id:'all-sync-throw-'+testCaseId,invoked,completed,storedState:rec.record?.state,storedOutcomes:rec.record?.responses?.map(r=>r.outcome),runtimeHeld:d.coordinator.peekRuntimeHold().held,defect:!completed&&invoked>0});
 }
 // Timeout then late success: should retain a supplemental response without changing
 // the stopped verdict or releasing the persistent barrier.
 {
  const x=setup();let resolveLate,n=0;const timeouts=new Map();let timerId=0;
  const timers={setTimeout(fn){const id=++timerId;timeouts.set(id,fn);return id;},clearTimeout(id){timeouts.delete(id);}};
  x.api.cloud.callFunction=args=>baseRead(args)||(++n===1?new Promise(r=>{resolveLate=r;}):Promise.resolve({result:d.scheduleOk()}));
  const run=x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput(),timers});
  for(let i=0;i<20&&n<2;i++)await tick();await tick();
  for(const [id,fn] of [...timeouts]){timeouts.delete(id);fn();}
  const r=await run,old=JSON.stringify(x.storage.store);
  resolveLate({result:d.scheduleOk()});await tick();await tick();
  const rec=d.coordinator.readCase(d.ctxFor(x.storage),'V06-a');
  results.push({id:'late-success-after-timeout',verdict:r.report.verdict,stoppedReason:r.report.stoppedReason,storedState:rec.record?.state,storageChangedAfterLate:old!==JSON.stringify(x.storage.store),responses:rec.record?.responses,defect:old===JSON.stringify(x.storage.store)});
 }
 d.resetAll();
 const preserved=protectedFiles.every(f=>hash(f)===before[f]);
 const out={executedAt:new Date().toISOString(),scope:'local review, synthetic API/storage, no cloud calls',previous34:JSON.parse(fs.readFileSync(mappings.get(prior.replace(/\.cjs$/,'.json')),'utf8')).summary,current18:JSON.parse(fs.readFileSync(mappings.get(fresh.replace(/\.cjs$/,'.json')),'utf8')).summary,historicalFilesChecked:protectedFiles.length,historicalFilesPreserved:preserved,results};
 fs.writeFileSync(__filename.replace(/\.cjs$/,'.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
})().catch(e=>{console.error(e);process.exitCode=1;});
