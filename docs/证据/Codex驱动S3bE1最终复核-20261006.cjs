'use strict';
// Local review only. Never run the shell helper or overwrite prior evidence.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const entryFile=path.join(__dirname,'WorkBuddy单一重跑入口-20261006.cjs');
const entry=require(entryFile),history=entry.historySnapshot(root,entry.HISTORY_FILES);
function compile(s,f,req=createRequire(f)){const m={exports:{}};vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${s}\n})`,{filename:f})(req,m,m.exports,path.dirname(f),f);return m.exports;}
(async()=>{
 const old=JSON.parse(fs.readFileSync(path.join(__dirname,'WorkBuddy单一重跑入口-20261006.json'),'utf8'));
 const deliveryIntegrity=old.records.map(r=>({file:r.isolatedResult,recorded:r.producedSha256,actual:hash(path.join(root,r.isolatedResult)),matches:r.producedSha256===hash(path.join(root,r.isolatedResult))}));
 // Reuse the exact prior reviewer counterexamples, not their historical outputs.
 const priorFile=path.join(__dirname,'Codex驱动S3abE1复核-20261006.cjs');let prior=fs.readFileSync(priorFile,'utf8');
 prior=prior.slice(0,prior.lastIndexOf('(async()=>{'))+'\nmodule.exports={driverCases,results};';
 const d=compile(prior,priorFile);await d.driverCases();
 // The actual new entry runs both child scripts once. Unique path, no fallback.
 const runId='codex-final-'+Date.now()+'-'+crypto.randomUUID();
 const actual=entry.orchestrate({root,runId});
 // Replay provided fault checks, redirecting their hard-coded output path only.
 const faultsFile=path.join(__dirname,'WorkBuddyS3bE1复现-20261006.cjs');
 const newFaultOut=path.join(__dirname,'Codex本次E1七项检查-20261006.json');
 const routedFs=new Proxy(fs,{get(t,k){if(k==='writeFileSync')return(p,...args)=>fs.writeFileSync(String(p).endsWith('WorkBuddyS3bE1复现-20261006.json')?newFaultOut:p,...args);return t[k];}});
 compile(fs.readFileSync(faultsFile,'utf8'),faultsFile,n=>n==='node:fs'?routedFs:createRequire(faultsFile)(n));
 // Actual orchestrate must reject partial success; no hand-copied final predicate.
 const entrySource=fs.readFileSync(entryFile,'utf8'),mem=new Map();let starts=0;
 const mfs={...fs,mkdirSync(){},existsSync:f=>mem.has(f),writeFileSync:(f,s)=>mem.set(f,Buffer.from(s)),rmSync:f=>mem.delete(f),readFileSync:(f,...args)=>{if(mem.has(f))return args[0]==='utf8'?mem.get(f).toString():mem.get(f);return fs.readFileSync(f,...args);}};
 const spawn=(_exe,args)=>{starts++;if(starts===2)return{error:{code:'EBUSY',message:'synthetic'},status:null};mem.set(args[0].replace(/\.cjs$/,'.json'),Buffer.from(JSON.stringify({summary:{total:34,sealed:34,unsealed:0,harnessErrors:0}})));return{status:0};};
 const injected=compile(entrySource,entryFile,n=>n==='node:fs'?mfs:n==='node:child_process'?{spawnSync:spawn}:createRequire(entryFile)(n));
 const partial=injected.orchestrate({root,runId:'IN_MEMORY_ONLY'});
 const after=entry.historySnapshot(root,entry.HISTORY_FILES);
 const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'独立测试副本执行包本地基线-20261005.json')));
 const diff=Object.entries(baseline.files).filter(([f,h])=>!fs.existsSync(path.join(root,f))||hash(path.join(root,f))!==h).map(([f])=>f);
 const frozen=o=>!o||typeof o!=='object'||Object.isFrozen(o)&&Object.values(o).every(frozen);
 const configs=Object.fromEntries(['schedule-sandbox-proof','schedule-entry-proof','sandbox-test-driver-proof'].map(n=>{const v=require(path.join(root,'miniapp/miniprogram/config',n));return[n,{value:v,deepFrozen:frozen(v)}];}));
 const out={executedAt:new Date().toISOString(),scope:'actual local driver/entry, synthetic wx/storage and fault injection, no cloud',deliveryIntegrity,driverCounterexamples:d.results,actualEntry:actual,providedFaultChecks:JSON.parse(fs.readFileSync(newFaultOut)).summary,actualPartialOrchestrate:{starts,sealed:partial.sealed,completedCount:partial.completedCount,incompleteCount:partial.incompleteCount},historyDrift:Object.keys(history).filter(k=>history[k]!==after[k]),baseline:{count:110,differences:diff},configs};
 fs.writeFileSync(__filename.replace(/\.cjs$/,'.json'),JSON.stringify(out,null,2)+'\n');
 console.log(JSON.stringify({deliveryIntegrity,driver:d.results.map(r=>({id:r.id,stateRegressed:r.stateRegressed,slotIdentified:r.lateHasSlotIdentifier})),actualEntry:{sealed:actual.sealed,records:actual.records.map(r=>({summary:r.summary,completed:r.completed,executionCount:r.executionCount,reason:r.reason}))},faults:out.providedFaultChecks,partial:out.actualPartialOrchestrate,historyDrift:out.historyDrift},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
