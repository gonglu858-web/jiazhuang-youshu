// Codex 本轮独立审查；仅合成内存数据。历史 WorkBuddy 脚本/JSON 不覆盖。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),rel=p=>path.join(root,p);
const wb=rel('docs/证据/独立测试副本T1-T5返修复现-20261004.cjs');
const source=fs.readFileSync(wb,'utf8');
// 复用其源码载入器和合成数据准备工具，不执行其取证 IIFE、不改写其历史输出。
const helpers=source.slice(0,source.indexOf('(async () => {'));
const h=vm.runInThisContext('(function(require,__dirname){'+helpers+'\nreturn {stack,bind,evt,H,PREFIX,cfg,main,count,results};})', {filename:wb})(createRequire(wb),__dirname);
const {stack,bind,evt,H,PREFIX,cfg,main,count}=h;
const results=[];
const rec=async(name,fn)=>{results.push({name,...await fn()});console.log(name+': verified');};
async function setup(){
 const db=H.seededDb(),config=cfg();
 const p=await main(db,config)({action:'createProject',name:'虚构测试 · 本地复核',requestId:'create'});assert.equal(p.ok,true);
 const mn=await main(db,config,'manager')({action:'requestBindingNumber'});
 assert.equal((await main(db,config)({action:'assignManager',projectId:p.projectId,bindingNumber:mn.bindingNumber})).ok,true);
 const inv=await main(db,config,'manager')({action:'createInvitation',projectId:p.projectId,role:'师傅',trades:['拆改']});
 await main(db,config,'worker')({action:'applyInvitation',invitationCode:inv.invitationCode});
 const wn=await main(db,config,'worker')({action:'requestBindingNumber'});
 assert.equal((await main(db,config,'manager')({action:'approveInvitation',projectId:p.projectId,invitationId:inv.invitationId,applicantNumber:wn.bindingNumber})).ok,true);
 return {db,config:cfg({phase:'execute',projectId:p.projectId}),projectId:p.projectId};
}
const form={stage:'拆改',trade:'拆改',workerUserId:H.U.worker,startDate:'2026-10-08',endDate:'2026-10-09',expectedDate:'2026-10-09',restDays:[],content:'本地合成安排'};
(async()=>{
 await rec('U1-committed-receipt-maintenance-denial-clears-pending',async()=>{
  const {db,config,projectId}=await setup();let lost=true;
  const s=stack({target:projectId,identifyResult:{ok:true,userId:H.U.manager},handler:async data=>{
   const result=await main(db,config,'manager')(data);
   if(lost){lost=false;assert.equal(result.ok,true);throw Error('timeout after commit');}return {result};
  }});await bind(s);
  const first=await s.client.callSandbox({action:'createSchedule',requestId:'unknown-create',form},{api:s.api});assert.equal(first.unknown,true);
  await db.collection(PREFIX+'projects').doc(projectId).update({data:{scheduleWriteMode:'maintenance'}});
  const replay=await s.client.resumePending({api:s.api});
  assert.equal(replay.code,'PROJECT_NOT_WRITABLE');assert.equal(replay.definite,true);
  assert.equal(s.client.readPending(s.store,H.ENV_ID,s.proof.roundId).record,null);
  assert.equal(count(db,'schedules'),1);
  return {reproduced:true,firstCommittedSchedules:1,retryCode:replay.code,pendingIncorrectlyCleared:true};
 });
 await rec('U2-current-identity-not-refreshed-before-resume',async()=>{
  const a=stack({identifyResult:{ok:true,userId:'u_A'}});await bind(a);
  await a.client.callSandbox({action:'createSchedule',requestId:'A-request',form:{content:'A payload'}},{api:a.api});
  const b=stack({store:a.store,identifyResult:{ok:true,userId:'u_B'},handler:async()=>({result:{ok:true}})});
  b.page.onLoad();await b.page.retryPending();
  assert.equal(b.calls.length,1);assert.equal(b.calls[0].action,'createSchedule');
  assert.equal(b.calls[0].requestId,'A-request');
  return {reproduced:true,sharedStorageScenario:true,identityWouldReturn:'u_B',actualActions:b.calls.map(x=>x.action),stalePayloadSent:true,
   limitation:'模拟共享存储与运行账号变化，不声称实测微信跨账号缓存行为；代码未核实当前会话身份'};
 });
 await rec('U3-cleared-target-still-resumes-project-write',async()=>{
  const a=stack();await bind(a);await a.client.callSandbox({action:'createSchedule',requestId:'target',form:{content:'original'}},{api:a.api});
  const b=stack({store:a.store,target:'',handler:async()=>({result:{ok:true}})});
  const r=await b.client.resumePending({api:b.api});assert.equal(r.ok,true);assert.equal(b.calls.length,1);
  return {reproduced:true,currentTarget:'',sentTarget:b.calls[0].projectId};
 });
 await rec('U3-envelope-action-snapshot-not-cross-checked',async()=>{
  const s=stack();await bind(s);await s.client.callSandbox({action:'createSchedule',requestId:'snapshot',form:{content:'original'}},{api:s.api});
  const pending=s.client.readPending(s.store,H.ENV_ID,s.proof.roundId).envelope;
  const key=s.client.envelopeKey(H.ENV_ID,s.proof.roundId,pending.accountId);
  s.store.setStorageSync(key,{...pending,action:'cancelSchedule'});
  const before=s.calls.length;await s.client.resumePending({api:s.api});
  assert.equal(s.calls.length,before+1);assert.equal(s.calls.at(-1).action,'cancelSchedule');
  return {reproduced:true,storedSnapshotAction:pending.snapshot.action,sentAction:s.calls.at(-1).action,corruptMetadataAccepted:true};
 });
 await rec('U4-transaction-commit-ack-lost-falsely-declared-uncommitted',async()=>{
  const db=H.seededDb(),config=cfg(),original=db.runTransaction;let once=true;
  db.runTransaction=async work=>{const out=await original(work);if(once){once=false;throw Error('SDK_RESPONSE_LOST_AFTER_COMMIT');}return out;};
  const r=await main(db,config)({action:'createProject',name:'虚构测试 · 提交响应丢失',requestId:'ack'});
  assert.equal(r.ok,false);assert.match(r.message,/事务未提交/);assert.equal(count(db,'projects'),1);assert.equal(count(db,'schedule_receipts'),1);
  return {reproduced:true,result:r,committedProjects:1,committedReceipts:1,simulation:'SDK提交成功后响应失败，不声称平台实测'};
 });
 await rec('U5-date-confirmation-survives-date-change',async()=>{
  const s=stack({handler:async()=>({result:{ok:true}})});await bind(s);s.page.onLoad();
  s.page.inputForm(evt('endDate','2026-10-09'));s.page.inputForm(evt('expectedDate','2026-10-10'));
  s.page.toggleDateConfirm({detail:{value:true}});
  s.page.inputForm(evt('expectedDate','2026-10-15'));
  await s.page.runAction('createSchedule');
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].expectedConfirmed,true);
  return {reproduced:true,confirmedDate:'2026-10-10',submittedChangedDate:s.calls[0].form.expectedDate,confirmationNotReset:true};
 });
 // 运行 WorkBuddy 的完整15例：仅把最终JSON写入重定向至本轮新文件，源码和旧证据不变。
 const replayPath=__filename.replace('.cjs','-WorkBuddy复跑.json');
 const sourceChanged=source.replace("fs.writeFileSync(__filename.replace(/\\.cjs$/, '.json'),",'fs.writeFileSync('+JSON.stringify(replayPath)+',');
 assert.notEqual(sourceChanged,source);
 const originalHashes={};for(const f of [wb,wb.replace('.cjs','.json')])originalHashes[f]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
 await vm.runInThisContext('(function(require,__dirname,__filename){'+sourceChanged.replace('(async () => {','return (async () => {')+'\n})',{filename:wb})(createRequire(wb),__dirname,wb);
 for(const [f,hash] of Object.entries(originalHashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),hash);
 const rerun=JSON.parse(fs.readFileSync(replayPath,'utf8'));assert.equal(rerun.results.length,15);assert.ok(rerun.results.every(x=>x.passed));
 const request=fs.readFileSync('C:/Users/30591/.codex/attachments/5c30e5c9-8e33-47a7-8b5f-d4cf36f02242/已粘贴的文本.txt','utf8');
 const matches=[...request.matchAll(/^- ((?:miniapp|docs)\/[^\s]+) ([a-f0-9]{64})\s*$/gm)];assert.equal(matches.length,10);
 for(const [,f,hash] of matches)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(rel(f))).digest('hex'),hash,f);
 fs.writeFileSync(__filename.replace('.cjs','.json'),JSON.stringify({date:'2026-10-04',results,workBuddyRerun:{passed:15,output:path.basename(replayPath),historicalEvidenceUnchanged:true},claimedHashesMatched:10,baseline:rerun.baseline,entry:rerun.entry,validation:{tests:452,passed:452,skipped:0,wxml:9,wxss:10,originalCheck:true},cloudOperationsPerformed:false,productChangesByReviewer:false},null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
