'use strict';
// Review-only: stdout; all credentials and transports are synthetic.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const vm=require('node:vm'),Module=require('node:module'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'), original={...fs};
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'codex-s1s4-review-'));
const guard={network:0,child:0};
const deny=k=>()=>{guard[k]++;throw Object.assign(new Error('REVIEW_BLOCKED'),{code:'REVIEW_BLOCKED'});};
for(const [m,keys] of [['node:https',['request','get']],['node:http',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:dns',['lookup','resolve','resolve4','resolve6']],['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]]){
 for(const k of keys)require(m)[k]=deny(m.includes('child_process')?'child':'network');
}
require('node:net').Socket.prototype.connect=deny('network');globalThis.fetch=deny('network');
fs.mkdtempSync=(prefix,...rest)=>original.mkdtempSync(path.join(scratch,path.basename(prefix)),...rest);
const fixtureFile=path.join(ROOT,'miniapp/tests/sandbox-primary-approved-run.test.cjs');
const req=Module.createRequire(fixtureFile),mod={exports:{}};
const wrappedRequire=Object.assign(id=>id==='node:test'?(()=>{}):req(id),req);
const src=original.readFileSync(fixtureFile,'utf8')+'\nmodule.exports={offlineChain,installFsVirtualization,hangingWorkerSpawn,syntheticApprovalSource,SYN_STS,GUARD_TOTALS};';
vm.runInThisContext(Module.wrap(src),{filename:fixtureFile})(mod.exports,wrappedRequire,mod,fixtureFile,path.dirname(fixtureFile));
const f=mod.exports,host=req('../scripts/lib/sandbox-primary-execution-host.cjs'),entry=req('../scripts/lib/sandbox-primary-approved-run.cjs');
const fsv=f.installFsVirtualization('independent');
const report={reviewedCommit:'b537402',baseline:'7ad03b4',kind:'REAL_APPLICATION_AND_SDK_LOCAL_CONVERSION_SYNTHETIC_TRANSPORT',samples:[]};
let seq=0;
async function sample(name,fn){
 const fx=f.offlineChain({tag:'review',runId:'COD-S14-'+String(++seq).padStart(4,'0')});
 try{report.samples.push({name,checked:true,...await fn(fx)});}catch(e){report.samples.push({name,checked:false,errorCode:e.code||null,message:String(e.message).slice(0,220)});}finally{fx.tr.restore();}
}
const catchRun=async o=>{try{return {value:await entry.runOnce(o)};}catch(error){return {error};}};
function facts(fx){return {credentialFetches:fx.captured.credentialFetches,apiCalls:fx.captured.apiCalls.length,counts:fx.tr.counts(),started:fs.existsSync(path.join(fx.outDir,'started'))};}
function flags(r){return {resultPersisted:r.resultPersisted??null,unknownPersisted:r.unknownPersisted??null};}
(async()=>{
 for(const [bound,requested] of [['fixed-real-source','offline-fixture'],['offline-fixture','fixed-real-source']]){
 await sample('S1-binding-'+bound+'-to-'+requested,async fx=>{
  const source=f.syntheticApprovalSource(fx.plan,{credentialSourceMode:bound});
  const r=await host.executeOnce({...fx.options,approvalSource:source,credentialSourceMode:requested,persistRoundStarted:()=>true,persistResult:()=>true});
  assert.equal(r.errorCode,host.ERR.REAL_MODE_BINDING_MISMATCH);assert.equal(fx.captured.calls.length,0);
  return {passed:true,errorCode:r.errorCode,...facts(fx)};
 });}
 for(const status of entry.TERMINAL_STATUSES){await sample('S2-existing-'+status,async fx=>{
  const file=path.join(fx.outDir,'terminal',fx.plan.roundId+'.'+status+'.json');
  fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'synthetic-prior-bytes');
  const {error}=await catchRun(fx.options);assert.equal(error.code,entry.ERR.TERMINAL_EXISTS);
  assert.equal(fx.captured.calls.length,0);assert.equal(fs.existsSync(path.join(fx.outDir,'started')),false);
  assert.equal(fs.readFileSync(file,'utf8'),'synthetic-prior-bytes');
  return {passed:true,errorCode:error.code,oldBytesUnchanged:true,...facts(fx)};
 });}
 for(const failure of ['partial-EIO','race-EEXIST','mkdir-EACCES']){await sample('S2-'+failure,async fx=>{
  const oldWrite=fs.writeFileSync,oldMkdir=fs.mkdirSync;let attempts=0;
  const terminal=path.join(fx.outDir,'terminal'),file=path.join(terminal,fx.plan.roundId+'.COMPLETED.json');
  if(failure==='mkdir-EACCES')fs.mkdirSync=function(p,...a){if(String(p)===terminal){attempts++;throw Object.assign(new Error('synthetic'),{code:'EACCES'});}return oldMkdir(p,...a);};
  else fs.writeFileSync=function(p,data,opts){if(String(p)===file){attempts++;if(failure==='partial-EIO'){oldWrite(p,Buffer.from(String(data)).subarray(0,20),opts);throw Object.assign(new Error('synthetic'),{code:'EIO'});}oldWrite(p,'synthetic-racer',{flag:'wx'});}return oldWrite(p,data,opts);};
  let result;try{result=await catchRun(fx.options);}finally{fs.writeFileSync=oldWrite;fs.mkdirSync=oldMkdir;}
  const e=result.error;assert.equal(e.code,entry.ERR.TERMINAL_SAVE_FAILED);assert.equal(e.execution.commitFactEstablished,true);assert.equal(e.execution.resultPersisted,false);assert.equal(e.execution.unknownPersisted,false);assert.equal(attempts,1);assert.equal(fx.tr.counts().commit,1);
  return {passed:true,errorCode:e.code,causeCode:e.causeCode,commitFactEstablished:e.execution.commitFactEstablished,saveAttempts:attempts,retainedBytes:fs.existsSync(file)?fs.statSync(file).size:0,...facts(fx)};
 });}
 for(const injectedCode of ['EACCES','EIO']){await sample('T1-terminal-scan-'+injectedCode,async fx=>{
  const dir=path.join(fx.outDir,'terminal'),file=path.join(dir,fx.plan.roundId+'.COMPLETED.json');
  fs.mkdirSync(dir);fs.writeFileSync(file,'synthetic-prior-bytes');
  const old=fs.readdirSync;let scans=0;
  fs.readdirSync=function(p,...args){if(String(p)===dir){scans++;throw Object.assign(new Error('synthetic inaccessible terminal listing'),{code:injectedCode});}return old(p,...args);};
  let r;try{r=await catchRun(fx.options);}finally{fs.readdirSync=old;}
  assert.equal(r.error.code,entry.ERR.TERMINAL_DIR_CHECK_FAILED);assert.equal(r.error.causeCode,injectedCode);assert.equal(fx.captured.calls.length,0);assert.equal(fx.tr.counts().commit,0);assert.equal(fx.tr.counts().primarySet,0);assert.equal(fx.tr.counts().auditSet,0);assert.equal(fs.existsSync(path.join(fx.outDir,'started')),false);assert.equal(fs.readFileSync(file,'utf8'),'synthetic-prior-bytes');
  return {passed:true,errorCode:r.error.code,causeCode:r.error.causeCode,scanAttempts:scans,oldBytesUnchanged:true,executionAttached:!!r.error.execution,...facts(fx)};
 });}
 await sample('S3-COMPLETED-and-repeat',async fx=>{
  const r=await entry.runOnce(fx.options),disk=JSON.parse(fs.readFileSync(r.saved.file,'utf8'));
  assert.equal(r.status,'COMPLETED');assert.equal(r.result.status,host.STATUS.PLAN_READY);assert.equal(r.result.errorCode??null,null);assert.equal(r.result.commitFactEstablished,true);assert.equal(disk.unknownPersisted,false);assert.equal(r.result.resultPersisted,true);assert.equal(r.result.unknownPersisted,false);
  const repeat=await catchRun(fx.options);assert.equal(repeat.error.code,entry.ERR.TERMINAL_EXISTS);assert.equal(fx.tr.counts().commit,1);
  return {passed:true,status:r.status,disk:flags(disk),returned:flags(r.result),repeatError:repeat.error.code,...facts(fx)};
 });
 await sample('S3-early-FAILED',async fx=>{
  const expected=host.callerTupleDigest({...f.SYN_STS,UserId:'SYNTH-OTHER',PrincipalId:'SYNTH-OTHER'});
  fx.options.approvalSource=f.syntheticApprovalSource(fx.plan,{expectedSubjectDigest:expected});
  const r=await entry.runOnce(fx.options),disk=JSON.parse(fs.readFileSync(r.saved.file,'utf8'));
  assert.equal(r.status,'FAILED');assert.equal(r.result.errorCode,host.ERR.CALLER_SUBJECT_MISMATCH);assert.equal(disk.resultPersisted,true);assert.equal(r.result.resultPersisted,true);assert.equal(r.result.unknownPersisted,false);assert.deepEqual(flags(disk),flags(r.result));
  return {passed:true,status:r.status,disk:flags(disk),returned:flags(r.result),...facts(fx)};
 });
 await sample('S3-RESULT_UNKNOWN',async fx=>{
  fx.options.spawnWorker=f.hangingWorkerSpawn();fx.options.workerLimits={timeoutMs:100,maxOutputBytes:1048576};
  const r=await entry.runOnce(fx.options),disk=JSON.parse(fs.readFileSync(r.saved.file,'utf8'));
  assert.equal(r.status,'RESULT_UNKNOWN');assert.equal(r.result.commitFactEstablished,false);assert.equal(disk.unknownPersisted,true);assert.equal(r.result.unknownPersisted,true);assert.equal(r.result.resultPersisted,true);assert.deepEqual(flags(disk),flags(r.result));
  return {passed:true,status:r.status,disk:flags(disk),returned:flags(r.result),...facts(fx)};
 });
 await sample('T1-readable-other-round',async fx=>{
  const dir=path.join(fx.outDir,'terminal');fs.mkdirSync(dir);const file=path.join(dir,'OTHER-ROUND.FAILED.json');fs.writeFileSync(file,'synthetic-existing-other-round');
  const r=await entry.runOnce(fx.options);assert.equal(r.status,'COMPLETED');assert.equal(fx.tr.counts().commit,1);assert.equal(fs.readFileSync(file,'utf8'),'synthetic-existing-other-round');
  return {passed:true,otherRoundBytesUnchanged:true,...facts(fx)};
 });
 report.implementationSha256=require('node:crypto').createHash('sha256').update(original.readFileSync(path.join(ROOT,'miniapp/scripts/lib/sandbox-primary-approved-run.cjs'))).digest('hex');
 report.guards={fixture:f.GUARD_TOTALS,outer:guard};report.virtualizedFsCalls=fsv.vops.length;
 report.summary={samples:report.samples.length,checked:report.samples.filter(s=>s.checked).length};
})().catch(e=>{report.harnessError={code:e.code||null,message:String(e.message).slice(0,200)};}).finally(()=>{
 fsv.restore();for(const k of Object.keys(original))if(typeof original[k]==='function')fs[k]=original[k];
 if(path.dirname(path.resolve(scratch))===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('codex-s1s4-review-'))original.rmSync(scratch,{recursive:true,force:true});
 report.finishedAt=new Date().toISOString();console.log(JSON.stringify(report,null,2));
 if(report.harnessError||report.samples.some(s=>!s.checked))process.exitCode=1;
});
