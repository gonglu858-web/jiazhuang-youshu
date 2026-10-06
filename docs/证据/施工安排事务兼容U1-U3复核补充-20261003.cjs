'use strict';
// Reviewer-only offline replays. VM mutations never change product files.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const testFile=path.resolve('miniapp/tests/schedule-service.test.cjs');
const scheduleFile=path.resolve('miniapp/cloudfunctions/memberAccess/schedule-service.js');
const memberFile=path.resolve('miniapp/cloudfunctions/memberAccess/service.js');
const source=fs.readFileSync(scheduleFile,'utf8'), tests=fs.readFileSync(testFile,'utf8');
function compile(file,text,overrides={}){const m={exports:{}},req=createRequire(file);vm.runInThisContext('(function(require,module,exports){'+text+'\n})',{filename:file})(n=>overrides[n]||req(n),m,m.exports);return m.exports;}
function harness(scheduleSource=source){const registered=[];const s=compile(scheduleFile,scheduleSource);const member=compile(memberFile,fs.readFileSync(memberFile,'utf8'),{'./schedule-service':s});const h=compile(testFile,tests+'\nmodule.exports={createConflictMockDb,seedConflictProject,createConflictService,makeBarrier,memberId,userIdFromOpenid,hash,APPID,createPlatformLimitedMockDb,seedReady,compatForm};',{'node:test':(name,fn)=>registered.push({name,fn}),'../cloudfunctions/memberAccess/schedule-service':s,'../cloudfunctions/memberAccess/service':member});return {h,s,member,registered};}
const results=[];
async function record(name,fn){try{results.push({name,...await fn(),passed:true});}catch(e){results.push({name,passed:false,code:e.code,message:e.message});process.exitCode=1;}}
async function outcome(fn){try{return{result:await fn()};}catch(e){return{code:e.code};}}
const plain=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 const removed=source.replace(/        const committed = await checkIdempotency\(tx, requestId, payload, actor\);\r?\n        if \(committed\) return committed;\r?\n/g,'');
 assert.equal((source.match(/const committed = await checkIdempotency/g)||[]).length,4);
 assert.equal((removed.match(/const committed = await checkIdempotency/g)||[]).length,0);
 const mutated=harness(removed);
 for(const t of mutated.registered.filter(t=>/^U1[a-d]:/.test(t.name)))await record('mutation_survives_'+t.name,async()=>{await t.fn();return{meaning:'Permanent test still passes with all four actual-write receipt checks removed; regression gap only.'};});
 const {h,s,member}=harness();
 for(const action of ['createSchedule','updateSchedule','reassignSchedule','cancelSchedule'])await record('both_fast_transactions_returned_null_'+action,async()=>{
  const db=h.createConflictMockDb(),ids=h.seedConflictProject(db,'p1','mgr','worker','worker2','水电');
  const a=h.createConflictService(db).call,b=h.createConflictService(db).call;
  const form=h.compatForm(ids.workerUserId,'2026-10-01','2026-10-02');
  let body={projectId:'p1',requestId:'review_same_id',form};
  if(action!=='createSchedule'){const created=await a('mgr','createSchedule',{projectId:'p1',requestId:'seed',form});body={...body,scheduleId:created.scheduleId,expectedVersion:1,reason:'review',workerUserId:ids.worker2UserId,form:{...form,content:'changed'}};}
  const before=plain(db.getData()),original=db.runTransaction;let started=0,finished=0,release;const gate=new Promise(r=>release=r);
  db.runTransaction=async work=>{const n=++started;const result=await original(work);if(n<=2){assert.equal(result,null);finished++;if(finished===2)release();await gate;}return result;};
  const outcomes=await Promise.all([a('mgr',action,body),b('mgr',action,body)]);assert.deepEqual(outcomes[0],outcomes[1]);assert.equal(finished,2);
  const d=db.getData(),count=(data,c)=>Object.keys(data[c]||{}).length;
  for(const c of ['schedule_receipts','schedule_revisions','audit_events'])assert.equal(count(d,c)-count(before,c),1);
  assert.equal(count(d,'schedules'),1);assert.equal(Object.values(d.schedules)[0].version,action==='createSchedule'?1:2);
  return{outcomes,fastNullReturns:finished,delta:{receipts:1,revisions:1,audits:1},scheduleVersion:Object.values(d.schedules)[0].version};
 });
 for(const action of ['approveInvitation','assignManager'])for(const first of ['member','maintenance'])await record(action+'_'+first+'_commits_first',async()=>{
  const db=h.createConflictMockDb();h.seedConflictProject(db,'p1','mgr','worker',null,'水电');
  const target=h.userIdFromOpenid('target'),owner=h.userIdFromOpenid('owner');const number='1234567890'; // synthetic fixture only
  await db.collection('users').add({data:{_id:target,status:'active',openid:'target',bindingCodeHash:h.hash(h.APPID+':'+number),bindingCodeExpiresAt:'2030-01-01T00:00:00Z'}});
  await db.collection('users').add({data:{_id:owner,status:'active',openid:'owner'}});
  await db.collection('app_admins').add({data:{_id:'primary',userId:owner,status:'active'}});
  await db.collection('invitations').add({data:{_id:'fixture_inv',projectId:'p1',status:'requested',applicantUserId:target,role:'设计师',trades:[],expiresAt:'2030-01-01T00:00:00Z',version:2}});
  const service=member.createService(db,{now:()=>new Date('2026-10-03T02:00:00Z')});
  const call=(who,action,body)=>service.execute({action,...body},{APPID:h.APPID,OPENID:who});
  const business=()=>call(action==='assignManager'?'owner':'mgr',action,{projectId:'p1',invitationId:'fixture_inv',applicantNumber:number,bindingNumber:number});
  const maintain=()=>call('mgr','setScheduleWriteMode',{projectId:'p1',mode:'maintenance'});
  const barrier=h.makeBarrier();let paused=false,attempts=0;
  db.setAttemptObserver(async()=>{attempts++;});
  db.setHooks({beforeCommit:async tx=>{if(paused)return;const memberWrite=tx.writeSet.has('project_members');const projectWrite=tx.writeSet.has('projects');if((first==='member'&&projectWrite&&!memberWrite)||(first==='maintenance'&&memberWrite)){paused=true;barrier.signal();await barrier.wait;}}});
  const pending=outcome(first==='member'?maintain:business);
  await Promise.race([barrier.reached,new Promise((_,reject)=>setTimeout(()=>reject(new Error('barrier timeout')),2000))]);
  db.clearHooks();const other=await outcome(first==='member'?business:maintain);barrier.resume();const resumed=await pending;
  const d=db.getData(),m=d.project_members[h.memberId('p1',target)];
  assert.equal(d.projects.p1.scheduleWriteMode,'maintenance');assert.ok(attempts>=3);
  assert.ok(other.result);
  if(first==='member'){assert.ok(resumed.result);assert.ok(m);assert.equal(d.projects.p1.scheduleEpoch,3);assert.equal(Object.values(d.audit_events).filter(a=>a.action===action).length,1);assert.equal(d.users[target].bindingCodeHash,null);assert.equal(m.taskDirGeneration,0);assert.equal(m.taskDirSchemaVersion,1);}
  else {assert.equal(resumed.code,'PROJECT_NOT_WRITABLE');assert.equal(m,undefined);assert.equal(d.projects.p1.scheduleEpoch,2);assert.equal(Object.values(d.audit_events).filter(a=>a.action===action).length,0);assert.ok(d.users[target].bindingCodeHash);}
  assert.equal(d.invitations.fixture_inv.status,action==='approveInvitation'&&first==='member'?'approved':'requested');
  return{other,resumed,attempts,mode:d.projects.p1.scheduleWriteMode,epoch:d.projects.p1.scheduleEpoch,targetPresent:!!m};
 });
 await record('actual_create_precheck_overbudget_zero_write',async()=>{
  const injected=source.replace('const FIXED_CREATE = 18','const FIXED_CREATE = 90');assert.notEqual(injected,source);
  const x=harness(injected),db=x.h.createPlatformLimitedMockDb({}, {appBudget:null});x.h.seedReady(db,'p1',[{openid:'mgr',roles:['管家']},{openid:'worker',roles:['师傅'],trades:['水电']}]);
  const service=x.member.createService(db,{now:()=>new Date('2026-10-03T02:00:00Z')});
  const before=JSON.stringify(db.getData());db.resetWriteCount();
  const result=await outcome(()=>service.execute({action:'createSchedule',projectId:'p1',requestId:'review_budget',form:x.h.compatForm(x.h.userIdFromOpenid('worker'),'2026-10-05','2026-10-05')},{APPID:x.h.APPID,OPENID:'mgr'}));
  assert.equal(result.code,'SCHEDULE_OPERATION_BUDGET_EXCEEDED');assert.equal(db.getWriteCount(),0);assert.equal(JSON.stringify(db.getData()),before);
  return{...result,attemptedWrites:db.getWriteCount(),allCollectionsUnchanged:true,injection:'VM-only FIXED_CREATE 18 -> 90'};
 });
 const out=path.join(process.env.TEMP||require('node:os').tmpdir(),'yf-u123-additional.json');fs.writeFileSync(out,JSON.stringify({recordedAt:new Date().toISOString(),scope:'offline synthetic; VM mutations only; no cloud',results:plain(results)},null,2)+'\n');console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
