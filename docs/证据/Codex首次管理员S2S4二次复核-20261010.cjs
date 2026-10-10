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
 'docs/证据/WorkBuddy首次管理员S1S4收尾复现-20261009.cjs','docs/证据/WorkBuddy首次管理员S1S4收尾复现-20261009.json','docs/证据/WorkBuddy首次管理员S2S3S4二次收尾复现-20261010.cjs','docs/证据/WorkBuddy首次管理员S2S3S4二次收尾复现-20261010.json'];
const hashes=()=>Object.fromEntries(protectedPaths.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]));
const before=hashes(); const rows=[];
const docs=()=>({schtest_v1_users:{_id:f.SYN_TARGET,status:'active',openid:f.SYN_OPENID}});
async function sample(id,fn){try{rows.push({id,...await fn()});}catch(e){rows.push({id,harnessError:true,errorClass:e.name,code:e.code||null});}}
function outputSpawn(value){return()=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
 c.stdin.write=()=>true;c.stdin.end=()=>{};c.kill=()=>true;setImmediate(()=>{c.stdout.emit('data',Buffer.from(JSON.stringify(value)));c.emit('exit',0,null);c.emit('close',0,null);});return c;};}
async function chain(patch){const tr=f.installSyntheticSdkTransport(docs()),plan=f.syntheticPlan(),approval=f.syntheticApproval();
 const source=f.syntheticApprovalSource(plan,{approval,approvedBy:approval.approvedBy});
 const captured={calls:[],credentialFetches:0,apiCalls:[]};let saved=0,started=null;const saves=[];
 const o={plan,approval,approvalSource:source,roundId:plan.roundId,fixedNowMs:Date.now(),...f.syntheticDirs('codex-S1S4'),
 spawn:f.syntheticCliSpawn(captured),spawnWorker:f.syntheticWorkerSpawn([],{}, {db:tr.db}),
 persistRoundStarted:async v=>{started=v;return true;},reconcileDeps:{db:tr.db},persistResult:async v=>{saved++;saves.push(v);return true;}};
 try{if(patch)patch(o,tr);const report=await host.executeOnce(o);return {report,counts:tr.counts(),saved,saves,started,
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

function hang(o){o.spawnWorker=f.syntheticWorkerSpawn([],{}, {hang:true});o.workerLimits={timeoutMs:30,maxOutputBytes:4096,closeGraceMs:10};}
function successPayload(plan){const auditId=p4.auditId(plan,p4.inputDigest(plan));return {
 ok:true,errorCode:null,resultUnknown:false,outcome:'initialized',initialized:true,granted:true,
 observationConfirmed:true,observeFailed:false,auditId,
 bootstrap:{ok:true,outcome:'initialized',initialized:true,granted:true,auditId,inputDigest:p4.inputDigest(plan),errorCode:null,requestIds:[]},
 observed:{state:'present',primaryPresent:true,auditPresent:true,primaryStatus:'active',writeAuthorized:false}
};}
function seedPresent(tr,plan){tr.store.schtest_v1_app_admins={_id:'primary',userId:plan.targetUserId,status:'active'};
 tr.store.schtest_v1_audit_events={_id:p4.auditId(plan,p4.inputDigest(plan)),subjectUserId:plan.targetUserId,
 action:p4.AUDIT_ACTION,roundId:plan.roundId,envId:plan.envId,evidenceId:plan.evidenceId,inputDigest:p4.inputDigest(plan)};}
async function main(){
 await sample('normal-complete-chain',async()=>{const x=await chain();return {passed:x.counts.commit===1&&x.counts.readOnlyGet===2&&x.saves[0]?.recordType==='COMPLETED',...x};});
 for(const kind of ['planOnly','credentialOnly','approvalOnly','afterBegin','duringObserve']){
  await sample('S2-'+kind,async()=>{const x=await timeCase(kind);const c=x.counts;
   const passed=x.eventCount>0&&x.out.ok===false&&(kind==='duringObserve'
    ?c.commit===1&&c.readOnlyGet===1&&x.out.observationExpiredDuringRead===true
    :c.commit===0&&c.primarySet===0&&c.abort===1);
   return {passed,...x};});
 }
 await sample('S3-timeout-two-reads-and-unknown-save',async()=>{const x=await chain(hang);return {
  passed:x.counts.readOnlyGet===2&&x.counts.begin===0&&x.saved===1&&x.saves[0].recordType==='RESULT_UNKNOWN'&&x.report.resultUnknown===true,...x};});
 await sample('S3-save-capability-before-worker',async()=>{const x=await chain(o=>{delete o.persistResult;});return {
  passed:x.counts.begin===0&&x.counts.commit===0&&x.report.workerStarted===false&&x.report.errorCode==='SAVE_CAPABILITY_MISSING',...x};});
 await sample('S3-default-reconcile-expires-mid-read',async()=>{
  const originalNow=Date.now;let clock=originalNow(),hits=0;Date.now=()=>clock;
  try{const x=await chain((o,tr)=>{hang(o);seedPresent(tr,o.plan);tr.setHook((action,params)=>{
   if(action==='database.getDocument'&&!params.transactionId&&params.collectionName==='schtest_v1_app_admins'){
    clock+=31*60*1000;hits++;
   }
  });});return {defect:hits===1&&x.counts.readOnlyGet===2&&x.report.reconcileConfirmed===true,hits,...x};}
  finally{Date.now=originalNow;}
 });
 await sample('S3-injected-inconsistent-reconcile-confirmed',async()=>{const x=await chain(o=>{
  hang(o);o.reconcileReadOnly=async()=>({state:'present',primaryStatus:'active',auditId:p4.auditId(o.plan,p4.inputDigest(o.plan)),
   primaryPresent:false,auditPresent:false,inputDigest:'f'.repeat(32),extra:'SYNTH_PRIVATE_MARKER'});
 });return {defect:x.report.reconcileConfirmed===true&&x.report.reconcile.primaryPresent===false,
  privateMarkerDropped:!JSON.stringify(x.report).includes('SYNTH_PRIVATE_MARKER'),...x};});
 await sample('S4-wrong-binding-skips-reconcile-and-keeps-initialized',async()=>{const x=await chain(o=>{
  const v=successPayload(o.plan);v.auditId='sbx-init-primary:OTHER';v.bootstrap.auditId=v.auditId;v.bootstrap.inputDigest='f'.repeat(32);
  o.spawnWorker=outputSpawn(v);
 });return {defect:x.counts.readOnlyGet===0&&x.report.initialized===true&&x.report.resultUnknown===false,
  noCompletedSave:x.saves[0]?.recordType!=='COMPLETED',...x};});
 await sample('S4-correct-binding-contradictory-observation-saves-completed',async()=>{const x=await chain(o=>{
  const v=successPayload(o.plan);v.observed={state:'unconfirmed',primaryPresent:false,auditPresent:false,primaryStatus:'disabled'};
  v.bootstrap.ok=false;v.bootstrap.initialized=false;v.bootstrap.granted=false;
  o.spawnWorker=outputSpawn(v);
 });return {defect:x.report.resultPersisted===true&&x.saves[0]?.recordType==='COMPLETED'&&x.report.observed.state==='unconfirmed',...x};});
 const after=hashes();const result={observedAt:new Date().toISOString(),scope:'OFFLINE_SYNTHETIC_ONLY',
  realCredentialFetches:0,realCloudCalls:0,networkAttempts,blockedProcesses,syntheticTempDirsCreated:true,
  historicalAndClosedFilesUnchanged:JSON.stringify(before)===JSON.stringify(after),protectedHashes:after,
  summary:{total:rows.length,passedControls:rows.filter(x=>x.passed).length,reproduced:rows.filter(x=>x.defect).length,harnessErrors:rows.filter(x=>x.harnessError).length},rows};
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
 if(result.summary.harnessErrors)process.exitCode=1;
}
main().catch(e=>{process.stderr.write(e.name+'\n');process.exitCode=1;});
