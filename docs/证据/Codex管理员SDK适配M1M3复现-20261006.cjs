'use strict';
// 独立离线反例；仅使用合成 db，不加载 SDK、不联网，输出 stdout。
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const m=require(path.join(root,'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs'));
const core=require(path.join(root,'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs'));
const marker='SYNTHETIC_SENSITIVE_MARKER';
const openid='synthetic-review-only';
const user=core.deriveUserId(m.FIXED_APP_ID,openid);
const plan={enabled:true,appId:m.FIXED_APP_ID,envId:m.FIXED_ENV_ID,roundId:'review-m1-m3',targetUserId:user,evidenceId:'review-only',expiresAt:'2030-01-01T00:00:00Z',schemaVersion:1,operatorRef:'local-review',approvedOwnerHint:'2d3aa4'};
const approval={approvedUserIds:[user],approvedBy:'synthetic-review',approvedAt:'2026-10-06T00:00:00Z'};
const audit=core.auditId(plan,core.inputDigest(plan));
function fixture(o={}){
 const count={begin:0,write:0,commit:0,rollback:0};
 const doc=(col,key,plain)=>({async get(){
  if(o.readError)throw o.readError;
  if(o.plain!==undefined&&plain)return o.plain;
  if(col==='schtest_v1_users')return {data:{_id:user,status:'active',openid}};
  return o.read===undefined?{data:null}:o.read;
 },async set(){count.write++;return o.set===undefined?{updated:0,upserted:[{_id:key}],requestId:'fake'}:o.set;}});
 const db={collection(col){return{doc(key){return doc(col,key,true);}};},async startTransaction(){count.begin++;return{collection(col){return{doc(key){return doc(col,key,false);}};},async commit(){count.commit++;if(o.commitThrow)throw new Error('fake timeout');return {requestId:'fake'};},async rollback(){count.rollback++;return{requestId:'fake'};}};}};
 const adapter=m.createAdapter({db,verifyCaller:async()=>o.caller||{allowed:true,envId:m.FIXED_ENV_ID},targetUserId:user,auditId:audit,appId:m.FIXED_APP_ID,envId:m.FIXED_ENV_ID,region:m.FIXED_REGION});
 return {adapter,count};
}
async function initialize(o){const f=fixture(o);try{const r=await core.initializePrimary({adapter:f.adapter,plan,approval});return{outcome:r.outcome,granted:r.granted,...f.count};}catch(e){return{code:e.code,...f.count};}}
(async()=>{
 const cases=[];
 for(const [id,o] of [
 ['R1-missing-data',{read:{requestId:'fake'}}],
 ['R1-undefined-data',{read:{data:undefined}}],
 ['R2-false-updatedCount',{set:{updatedCount:false}}],
 ['R2-zero-no-upsert',{set:{updated:0}}],
 ['R3-wrong-appId',{caller:{allowed:true,envId:m.FIXED_ENV_ID,appId:'wrong-app'}}],
 ['R3-trusted-test-marker',{caller:{allowed:true,envId:m.FIXED_ENV_ID,trusted:true}}]
 ])cases.push({id,result:await initialize(o)});
 const p=fixture({plain:{data:[{_id:'wrong-key',userId:user,status:'active'}]}});
 cases.push({id:'R1-wrong-key-read',accepted:await p.adapter.readOnlyGet('schtest_v1_app_admins','primary')});
 const a=fixture({commitThrow:true}),b=fixture();const tx=await a.adapter.beginTransaction();await a.adapter.commit(tx).catch(()=>{});
 await b.adapter.rollback(tx);cases.push({id:'R4-cross-adapter-unknown',foreignRollbackInvoked:a.count.rollback,ownRollbackInvoked:b.count.rollback});
 let spoof=0;await b.adapter.rollback({__commitUnknown:true,__tx:{async rollback(){spoof++;}}});
 cases.push({id:'R4-forged-unknown',foreignCallbackInvoked:spoof});
 const e=new Error('hidden');e.name=marker;const f=fixture({readError:e});
 const err=await f.adapter.readOnlyGet('schtest_v1_app_admins','primary').catch(x=>x);
 cases.push({id:'R5-error-name',markerLeaked:JSON.stringify(err).includes(marker)});
 const injected=new m.AdapterError('INJECTED',marker);const g=fixture({readError:injected});
 const direct=await g.adapter.readOnlyGet('schtest_v1_app_admins','primary').catch(x=>x);
 const r=await core.initializePrimary({adapter:g.adapter,plan,approval}).catch(x=>x);
 cases.push({id:'R5-adapter-error',directMarkerLeaked:JSON.stringify(direct).includes(marker),coreMarkerLeaked:JSON.stringify(r).includes(marker),coreCode:r.code});
 console.log(JSON.stringify({observedAt:new Date().toISOString(),scope:'synthetic local counterexamples only; no platform calls',cases,total:cases.length},null,2));
})().catch(e=>{console.error('HARNESS_FAILED',e.code||e.name);process.exitCode=1;});
