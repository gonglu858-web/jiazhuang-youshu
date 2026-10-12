'use strict';
// Offline review: stdout only. Guard all real network/process calls. No auth contents.
// The delivered evidence's fixed output write is intercepted into memory, not executed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const vm=require('node:vm'),Module=require('node:module'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const before={};for(const k of Object.keys(fs))before[k]=fs[k];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-entry-recheck-'));
const report={reviewedCommit:'da30720',baseline:'b4da00c',verificationKind:'APPLICATION_AND_SDK_LOCAL_CONVERSION_SYNTHETIC_TRANSPORT',samples:[],realCredentialFetches:0,realCloudCalls:0,realAuthContentsRead:false};
const guard={network:0,child:0};
const deny=kind=>()=>{guard[kind]++;throw Object.assign(new Error('REVIEW_BLOCKED'),{code:'REVIEW_BLOCKED'});};
for(const [mod,keys] of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:dns',['lookup','resolve','resolve4','resolve6']],['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]]){
 const o=require(mod);for(const k of keys)o[k]=deny(mod.includes('child_process')?'child':'network');
}
require('node:net').Socket.prototype.connect=deny('network');globalThis.fetch=deny('network');
// All mkdtemp calls in these reviewed fixtures are scratch output/profile directories.
fs.mkdtempSync=(prefix,...args)=>before.mkdtempSync(path.join(tmp,path.basename(prefix)),...args);
const historical=path.join(__dirname,'首次管理员真实入口R1-R5定点返修-20261012.json');
const historicalSha=()=>crypto.createHash('sha256').update(before.readFileSync(historical)).digest('hex');
const hashBefore=historicalSha();
async function replay(){
 let resolve;
 const done=new Promise(r=>{resolve=r;});
 const priorWrite=fs.writeFileSync;
 let redirects=0;
 fs.writeFileSync=function(p,data,...args){
   if(path.resolve(String(p))===historical){redirects++;resolve(JSON.parse(String(data)));return;}
   return priorWrite(p,data,...args);
 };
 require(path.join(__dirname,'首次管理员真实入口R1-R5定点返修-20261012.cjs'));
 const outcome=await done;
 fs.writeFileSync=priorWrite;
 report.deliveredEvidenceReplay={summary:outcome.summary,guards:outcome.guards,fixedOutputWritesIntercepted:redirects,oldBytesUnchanged:historicalSha()===hashBefore};
}
function loadFixtures(){
 const file=path.join(ROOT,'miniapp/tests/sandbox-primary-approved-run.test.cjs');
 const req=Module.createRequire(file),m={exports:{}};
 const src=before.readFileSync(file,'utf8')+'\nmodule.exports={offlineChain,syntheticPlan,syntheticApprovalSource,installFsVirtualization,GUARD_TOTALS,GUARD_PROBES};';
 const wrappedRequire=Object.assign(id=>id==='node:test'?(()=>{}):req(id),req);
 vm.runInThisContext(Module.wrap(src),{filename:file})(m.exports,wrappedRequire,m,file,path.dirname(file));
 return m.exports;
}
async function sample(name,fn){try{report.samples.push({name,checked:true,...await fn()});}catch(e){report.samples.push({name,checked:false,errorCode:e.code||null,message:String(e.message).slice(0,220)});}}
(async()=>{
 await replay();
 const f=loadFixtures();
 const host=require(path.join(ROOT,'miniapp/scripts/lib/sandbox-primary-execution-host.cjs'));
 const entry=require(path.join(ROOT,'miniapp/scripts/lib/sandbox-primary-approved-run.cjs'));
 const fsv=f.installFsVirtualization('codex-all');
 try{
 await sample('S1-host-reverse-mode-binding',async()=>{
   const fx=f.offlineChain({tag:'binding',runId:'COD-RMODE-001',approvalPatch:{credentialSourceMode:'fixed-real-source'}});
   try{
     const opts={...fx.options,credentialSourceMode:'offline-fixture',roundId:fx.plan.roundId,persistRoundStarted:()=>true,persistResult:()=>true};
     const r=await host.executeOnce(opts);
     assert.equal(r.status,host.STATUS.PLAN_READY);assert.equal(fx.tr.counts().commit,1);
     let entryError;try{await entry.runOnce({...fx.options,credentialSourceMode:'offline-fixture'});}catch(e){entryError=e;}
     assert.equal(entryError.code,host.ERR.REAL_MODE_BINDING_MISMATCH);
     return {defectReproduced:true,entryProperlyRejects:true,hostStatus:r.status,boundMode:fx.source.credentialSourceMode,requestedMode:opts.credentialSourceMode,credentialFetches:fx.captured.credentialFetches,counts:fx.tr.counts()};
   }finally{fx.tr.restore();}
 });
 await sample('S2-partial-terminal-write-then-EIO',async()=>{
   const fx=f.offlineChain({tag:'partial',runId:'COD-PARTIAL-001'}),orig=fs.writeFileSync;
   let terminalAttempts=0;
   try{
     fs.writeFileSync=function(p,data,opts){
       if(String(p).includes(path.join('terminal','COD-PARTIAL-001'))){terminalAttempts++;
         if(terminalAttempts===1){orig(p,String(data).slice(0,20),opts);throw Object.assign(new Error('synthetic EIO after partial write'),{code:'EIO'});}
       }
       return orig(p,data,opts);
     };
     let error;try{await entry.runOnce(fx.options);}catch(e){error=e;}
     assert.equal(error.code,entry.ERR.TERMINAL_EXISTS);assert.equal(fx.tr.counts().commit,1);assert.equal(error.execution,undefined);
     const bytes=fs.readFileSync(path.join(fx.outDir,'terminal','COD-PARTIAL-001.COMPLETED.json'),'utf8');
     assert.throws(()=>JSON.parse(bytes));
     return {defectReproduced:true,errorCode:error.code,executionAttached:!!error.execution,terminalWriteAttempts:terminalAttempts,partialFilePreserved:true,counts:fx.tr.counts(),credentialFetches:fx.captured.credentialFetches};
   }finally{fs.writeFileSync=orig;fx.tr.restore();}
 });
 await sample('S2-existing-terminal-with-no-started',async()=>{
   const fx=f.offlineChain({tag:'occupied',runId:'COD-OCCUPIED-001'});
   try{
     const file=path.join(fx.outDir,'terminal','COD-OCCUPIED-001.COMPLETED.json');
     fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'{"recordType":"COMPLETED","prior":true}');
     const prior=fs.readFileSync(file);
     let error;try{await entry.runOnce(fx.options);}catch(e){error=e;}
     assert.equal(error.code,entry.ERR.TERMINAL_EXISTS);assert.equal(fx.tr.counts().commit,1);assert.equal(error.execution,undefined);assert.ok(prior.equals(fs.readFileSync(file)));
     return {defectReproduced:true,counts:fx.tr.counts(),credentialFetches:fx.captured.credentialFetches,errorCode:error.code,executionAttached:!!error.execution,priorTerminalUnchanged:true};
   }finally{fx.tr.restore();}
 });
 await sample('S3-success-persistence-flags',async()=>{
   const fx=f.offlineChain({tag:'flags',runId:'COD-FLAGS-001'});
   try{
     const r=await entry.runOnce(fx.options),disk=JSON.parse(fs.readFileSync(r.saved.file,'utf8'));
     assert.equal(r.status,'COMPLETED');assert.equal(disk.unknownPersisted,true);assert.notEqual(r.result.unknownPersisted,true);
     return {defectReproduced:true,status:r.status,resultUnknown:r.result.resultUnknown===true,terminalUnknownPersisted:disk.unknownPersisted,reportUnknownPersisted:r.result.unknownPersisted??null,terminalFieldAllowlistCount:entry.TERMINAL_FIELDS.length,counts:fx.tr.counts()};
   }finally{fx.tr.restore();}
 });
 await sample('closed-positive-and-repeat-round',async()=>{
   const fx=f.offlineChain({tag:'positive',runId:'COD-POSITIVE-001'});
   try{
     const r=await entry.runOnce(fx.options),terminal=JSON.parse(fs.readFileSync(r.saved.file,'utf8'));
     assert.equal(r.status,'COMPLETED');assert.equal(terminal.commitFactEstablished,true);assert.equal(terminal.fullInitializationSuccess,true);assert.equal(terminal.workerProcess.exitCode,0);
     await assert.rejects(()=>entry.runOnce(fx.options),e=>e.code===entry.ERR.STARTED_EXISTS);
     assert.equal(fx.captured.credentialFetches,1);assert.equal(fx.tr.counts().commit,1);
     return {passed:true,status:r.status,credentialFetches:fx.captured.credentialFetches,apiCalls:fx.captured.apiCalls.length,counts:fx.tr.counts(),commitFactsPersisted:true,duplicateRejected:true};
   }finally{fx.tr.restore();}
 });
 report.customFixtureGuardTotals=f.GUARD_TOTALS;
 report.outerGuardUnexpected=guard;
 report.virtualizedFsCalls=fsv.vops.length;
 report.originalEvidenceUnchanged=historicalSha()===hashBefore;
 report.originalEvidenceSha256=hashBefore;
 }finally{fsv.restore();}
 report.summary={samples:report.samples.length,checked:report.samples.filter(s=>s.checked).length};
})().catch(e=>{report.harnessError={name:e.name,code:e.code||null,message:String(e.message).slice(0,200)};process.exitCode=1;}).finally(()=>{
 for(const k of Object.keys(before))if(typeof before[k]==='function')fs[k]=before[k];
 const resolved=path.resolve(tmp);
 if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('codex-entry-recheck-'))before.rmSync(resolved,{recursive:true,force:true});
 report.finishedAt=new Date().toISOString();
 console.log('CODEX_REVIEW_JSON_BEGIN');process.stdout.write(JSON.stringify(report,null,2)+'\n');
 if(report.harnessError||report.samples.some(s=>!s.checked))process.exitCode=1;
});
