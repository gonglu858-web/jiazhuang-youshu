'use strict';
// 独立离线复核，stdout only；不执行旧证据入口、不访问云端。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module'); const {EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'../..'); let networkAttempts=0,blockedProcesses=0;
for(const n of ['http','https']) {const m=require(n);m.request=m.get=()=>{networkAttempts++;throw Error('OFFLINE_ONLY');};}
for(const n of ['net','tls']) {const m=require(n);m.connect=m.createConnection=()=>{networkAttempts++;throw Error('OFFLINE_ONLY');};}
const cp=require('node:child_process');
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[k]=()=>{blockedProcesses++;throw Error('NO_REAL_PROCESS');};
const fixturePath=path.join(root,'miniapp/tests/sandbox-primary-execution-host.test.cjs');
const m={exports:{}};const req=createRequire(fixturePath);
vm.runInThisContext('(function(require,module,exports,__filename,__dirname){'+fs.readFileSync(fixturePath,'utf8')+
 '\nmodule.exports={host,worker,p4,syntheticPlan,syntheticApproval,syntheticApprovalSource,syntheticDirs,syntheticCliSpawn,syntheticWorkerSpawn,installSyntheticSdkTransport,SYN_TARGET,SYN_OPENID};})',{filename:fixturePath})(
 n=>n==='node:test'?(()=>{}):req(n),m,m.exports,fixturePath,path.dirname(fixturePath));
const f=m.exports,{host,worker,p4}=f;
const protectedPaths=[
 'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs','miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs',
 'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs','miniapp/scripts/lib/cloudbase-readonly-observer.cjs',
 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs','miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs',
 'miniapp/scripts/prepare-sandbox-primary.cjs','miniapp/scripts/package-sandbox.cjs',
 'docs/证据/Codex首次管理员R1R6返修复核-20261009.cjs','docs/证据/Codex首次管理员R1R6返修复核-20261009.json',
 'docs/证据/WorkBuddy首次管理员S1S4收尾复现-20261009.cjs','docs/证据/WorkBuddy首次管理员S1S4收尾复现-20261009.json'];
const hashes=()=>Object.fromEntries(protectedPaths.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]));
const before=hashes(); const rows=[];
const docs=()=>({schtest_v1_users:{_id:f.SYN_TARGET,status:'active',openid:f.SYN_OPENID}});
async function sample(id,fn){try{rows.push({id,...await fn()});}catch(e){rows.push({id,harnessError:true,errorClass:e.name,code:e.code||null});}}
function outputSpawn(value){return()=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
 c.stdin.write=()=>true;c.stdin.end=()=>{};c.kill=()=>true;setImmediate(()=>{c.stdout.emit('data',Buffer.from(JSON.stringify(value)));c.emit('exit',0,null);c.emit('close',0,null);});return c;};}
async function chain(patch){const tr=f.installSyntheticSdkTransport(docs()),plan=f.syntheticPlan(),approval=f.syntheticApproval();
 const source=f.syntheticApprovalSource(plan,{approval,approvedBy:approval.approvedBy});
 const captured={calls:[],credentialFetches:0,apiCalls:[]};let saved=0,started=null;
 const o={plan,approval,approvalSource:source,roundId:plan.roundId,fixedNowMs:Date.now(),...f.syntheticDirs('codex-S1S4'),
 spawn:f.syntheticCliSpawn(captured),spawnWorker:f.syntheticWorkerSpawn([],{}, {db:tr.db}),
 persistRoundStarted:async v=>{started=v;return true;},persistResult:async()=>{saved++;return true;}};
 try{if(patch)patch(o,tr);const report=await host.executeOnce(o);return {report,counts:tr.counts(),saved,started,
 credentialFetches:captured.credentialFetches,apiCalls:captured.apiCalls.length,
 auditApprovedBy:tr.store.schtest_v1_audit_events?.approvedBy,auditOperatorRef:tr.store.schtest_v1_audit_events?.operatorRef};}finally{tr.restore();}}
async function timeCase(kind){const tr=f.installSyntheticSdkTransport(docs()),t0=Date.now();let clock=t0,eventCount=0,out;
 const plan=f.syntheticPlan(null,{expiresAt:new Date(t0+(kind==='planOnly'?1000:100000)).toISOString()});
 const credEnd=t0+(['credentialOnly','afterBegin','afterFirstSet','duringObserve'].includes(kind)?1000:100000);
 tr.setHook((action,params)=>{
  const reads=action==='database.getDocument'||action==='database.getInTransaction';
  const match=kind==='afterBegin'?action==='database.startTransaction'
   :kind==='afterFirstSet'?action==='database.modifyDocument'&&params.collectionName==='schtest_v1_app_admins'
   :kind==='duringObserve'?reads&&!params.transactionId&&params.collectionName==='schtest_v1_app_admins'
   :reads&&params.collectionName==='schtest_v1_users';
  if(match){clock=t0+2000;eventCount++;}
 });
 try{await worker.run({credential:{secretId:'SYNTH',secretKey:'SYNTH',sessionToken:'SYNTH',expiresAtMs:credEnd},plan,
 approval:f.syntheticApproval(),verifiedCaller:true,fixedNowMs:t0,approvalExpiresAtMs:t0+(kind==='approvalOnly'?1000:100000)},
 {db:tr.db,now:()=>clock,emit:v=>{out=v;}});return {eventCount,counts:tr.counts(),out};}finally{tr.restore();}}
async function main(){
 await sample('positive-chain',async()=>{const x=await chain();return {passed:x.counts.commit===1&&x.counts.readOnlyGet===2&&x.report.resultPersisted===true,...x};});
 await sample('S1-bound-approval-and-plan',async()=>{const x=await chain(o=>{o.approval={...o.approval,approvedBy:'SYNTH_WRONG'};o.persistRoundStarted=async()=>{o.plan.operatorRef='SYNTH_WRONG';return true;};});
 return {passed:x.counts.commit===1&&x.auditApprovedBy!=='SYNTH_WRONG'&&x.auditOperatorRef!=='SYNTH_WRONG',...x};});
 await sample('S1-deep-frozen',async()=>{const p=f.syntheticPlan(),s=f.syntheticApprovalSource(p);let rejected=false;try{s.approval.approvedBy='SYNTH_WRONG';}catch(_){rejected=true;}
 return {passed:rejected&&Object.isFrozen(s.approval.approvedUserIds)&&Object.isFrozen(s.implementationFingerprint)};});
 await sample('S2-plan-alone-expires',async()=>{const x=await timeCase('planOnly');return {defect:x.eventCount>0&&x.counts.commit===1,...x};});
 await sample('S2-credential-expiry-control',async()=>{const x=await timeCase('credentialOnly');return {passed:x.eventCount>0&&x.counts.primarySet===0&&x.counts.abort===1&&x.counts.readOnlyGet===0,...x};});
 await sample('S2-approval-expiry-control',async()=>{const x=await timeCase('approvalOnly');return {passed:x.eventCount>0&&x.counts.primarySet===0&&x.counts.abort===1,...x};});
 await sample('S2-expiry-after-first-set-control',async()=>{const x=await timeCase('afterFirstSet');return {passed:x.eventCount>0&&x.counts.primarySet===1&&x.counts.auditSet===0&&x.counts.commit===0&&x.counts.abort===1,...x};});
 await sample('S2-expiry-during-begin-loses-handle',async()=>{const x=await timeCase('afterBegin');return {defect:x.counts.begin===1&&x.counts.abort===0&&x.eventCount>0,...x};});
 await sample('S2-expiry-during-observation',async()=>{const x=await timeCase('duringObserve');return {defect:x.eventCount>0&&x.counts.readOnlyGet===2&&x.out.ok===true,...x};});
 await sample('S2-original-test-never-reads',async()=>{const tr=f.installSyntheticSdkTransport(docs()),plan=f.syntheticPlan();let hits=0,out;
  tr.setHook(()=>{hits++;});try{await worker.run({credential:{secretId:'S',secretKey:'K',sessionToken:'T',expiresAtMs:Date.now()+3600000},
   plan,approval:f.syntheticApproval(plan),verifiedCaller:true,fixedNowMs:Date.now(),approvalExpiresAtMs:Date.now()+3600000},
   {db:tr.db,now:Date.now,emit:v=>{out=v;}});return {defect:hits===0,hits,out,counts:tr.counts()};}finally{tr.restore();}});
 await sample('S3-timeout-no-reconcile-no-save',async()=>{const x=await chain(o=>{o.spawnWorker=f.syntheticWorkerSpawn([],{}, {hang:true});o.workerLimits={timeoutMs:30,maxOutputBytes:4096,closeGraceMs:10};});
 return {defect:x.report.reconcileSkipReason==='NO_RECONCILE_CAPABILITY'&&x.saved===0,idsRetained:Boolean(x.report.auditId&&x.report.roundId),...x};});
 await sample('S3-reconcile-raw-result-leak',async()=>{const x=await chain(o=>{o.spawnWorker=f.syntheticWorkerSpawn([],{}, {hang:true});o.workerLimits={timeoutMs:30,maxOutputBytes:4096,closeGraceMs:10};
  o.reconcileReadOnly=async()=>({ok:true,state:'present',extra:'SYNTH_PRIVATE_MARKER'});});
  return {defect:JSON.stringify(x.report).includes('SYNTH_PRIVATE_MARKER')&&x.report.reconcileConfirmed===true,...x};});
 await sample('S3-missing-save-detected-after-commit',async()=>{const x=await chain(o=>{delete o.persistResult;});return {defect:x.counts.commit===1&&x.report.resultPersisted!==true,...x};});
 await sample('S4-wrong-ids-still-success',async()=>{const x=await chain(o=>{o.spawnWorker=outputSpawn({ok:true,resultUnknown:false,outcome:'initialized',initialized:true,granted:true,observationConfirmed:true,
 auditId:p4.AUDIT_ID_PREFIX+'ffffffffffffffffffffffffffffffff',bootstrap:{ok:true,outcome:'initialized',initialized:true,granted:true,auditId:p4.AUDIT_ID_PREFIX+'ffffffffffffffffffffffffffffffff',inputDigest:'f'.repeat(32)},
 observed:{state:'present',primaryPresent:true,auditPresent:true,primaryStatus:'active'}});});
 return {defect:x.report.resultPersisted===true&&x.report.initialized===true&&x.report.bootstrap.auditId===null,...x};});
 const after=hashes();process.stdout.write(JSON.stringify({observedAt:new Date().toISOString(),scope:'OFFLINE_SYNTHETIC_ONLY',
 networkAttempts,blockedProcesses,realCredentialFetches:0,realCloudCalls:0,syntheticTempDirsCreated:true,
 historicalAndClosedFilesUnchanged:JSON.stringify(before)===JSON.stringify(after),protectedHashes:after,
 summary:{total:rows.length,passedControls:rows.filter(x=>x.passed).length,reproduced:rows.filter(x=>x.defect).length,harnessErrors:rows.filter(x=>x.harnessError).length},rows},null,2)+'\n');
}
main().catch(e=>{process.stderr.write(e.name+'\n');process.exitCode=1;});
