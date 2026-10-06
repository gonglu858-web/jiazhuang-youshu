'use strict';
// Independent local review: real modules, synthetic API/storage/transaction adapter.
// Does not load a platform SDK, contact cloud services, or edit implementation files.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
function helpers(rel, names) {
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  const prefix = source.slice(0, source.indexOf('\ntest('));
  const m = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${prefix}\nmodule.exports={${names}};})`, {filename:file})(createRequire(file),m,m.exports,path.dirname(file),file);
  return m.exports;
}
const d = helpers('miniapp/tests/sandbox-test-driver.test.cjs', 'loadDriver,openProof,baseInput,makeStorage,makeApi,resetAll,ctxFor,coordinator,IDENTIFY_OK,MEMBERS_OK,MANAGER,WORKER_B,PROJECT');
const p = helpers('miniapp/tests/sandbox-primary-bootstrap.test.cjs', 'bootstrap,makeAdapter,goodPlan,run,OWNER,APP_ID,ENV_ID');
const results=[];
async function record(id, fn) {
  try { results.push({id, ...await fn()}); }
  catch(e) { results.push({id,harnessError:String(e.stack)}); }
}
function setup(respond, overrides) {
  d.resetAll();
  const storage=d.makeStorage();
  const proof=d.openProof(overrides);
  const driver=d.loadDriver(proof);
  const api=d.makeApi({storage,handler:async data=>{
    if(data.action==='identify')return {result:d.IDENTIFY_OK};
    if(data.action==='getMembers')return {result:d.MEMBERS_OK};
    return {result:respond(data)};
  }});
  return {storage,proof,driver,api};
}
const ok={ok:true,scheduleId:'s-review',version:1,status:'active'};
const writes=api=>api.__calls.filter(x=>['createSchedule','updateSchedule','removeMember'].includes(x.action));
(async()=>{
  await record('R1-ordinary-identity-inflight-does-not-block-driver',async()=>{
    const x=setup(()=>ok);
    const file=path.join(root,'miniapp/miniprogram/utils/schedule-sandbox-client.js');
    const m={exports:{}};
    vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file,'utf8')}\n})`)(name=>{
      if(name.includes('config/schedule-sandbox-proof'))return {...createRequire(file)(name),enabled:true,roundId:x.proof.roundId,sandboxProjectId:x.proof.projectId};
      return createRequire(file)(name);
    },m,m.exports);
    let release;let held=false;
    const call=x.api.cloud.callFunction;
    x.api.cloud.callFunction=args=>{
      if(args.data.action==='identify'&&!held){held=true;return new Promise(resolve=>{release=()=>resolve({result:d.IDENTIFY_OK});});}
      return call(args);
    };
    const pending=m.exports.refreshSessionIdentity(x.api);
    const r=await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});
    const sent=writes(x.api).length;
    if(release)release();await pending;
    return {ordinaryWasInflight:held,driverVerdict:r.report.verdict,businessRequestsWhileOrdinaryInflight:sent,defect:held&&sent===2};
  });
  await record('R1-candidate-does-not-block-next-case',async()=>{
    const x=setup(()=>ok);
    const a=await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});
    const block=d.coordinator.ordinaryEntryBlock();
    await x.driver.runCase({api:x.api,testCaseId:'V06-b',input:d.baseInput({requestId1:'b1',requestId2:'b2'})});
    return {a:a.report.verdict,ordinaryBlock:block,businessRequests:writes(x.api).length,keys:Object.keys(x.storage.store),defect:a.report.verdict==='candidate'&&!block&&writes(x.api).length===4};
  });
  await record('R1-stopped-reload-does-not-block-next-case',async()=>{
    const x=setup(()=>({ok:false,code:'SERVER_ERROR'}));
    const a=await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});
    d.coordinator._resetRuntimeHoldForTest();
    const driver=d.loadDriver(x.proof);
    await driver.runCase({api:x.api,testCaseId:'V06-b',input:d.baseInput()});
    return {a:a.report.verdict,businessRequests:writes(x.api).length,defect:a.report.verdict==='stopped'&&writes(x.api).length===4};
  });
  await record('R2-wrong-runtime-appid',async()=>{
    const x=setup(()=>ok);
    x.api.getAccountInfoSync=()=>({miniProgram:{appId:'wx_wrong_runtime',envVersion:'develop'}});
    const r=await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});
    return {verdict:r.report.verdict,totalRequests:x.api.__calls.length,businessRequests:writes(x.api).length,defect:writes(x.api).length===2};
  });
  await record('R2-input-project-overrides-proof',async()=>{
    const x=setup(()=>ok);
    await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput({projectId:'p_38507fc9b43c4e23a7fbd996415637bb'})});
    return {precheckProject:x.api.__calls.find(c=>c.action==='getMembers').projectId,sentProjects:writes(x.api).map(c=>c.projectId),defect:writes(x.api).some(c=>c.projectId!==x.proof.projectId)};
  });
  await record('R2-v07-input-target-not-validated',async()=>{
    const x=setup(()=>({ok:false,code:'WORKER_HAS_ACTIVE_SCHEDULES'}));
    const r=await x.driver.runCase({api:x.api,testCaseId:'V07-A',input:{projectId:d.PROJECT,userId:d.MANAGER}});
    return {verdict:r.report.verdict,configuredTarget:x.proof.v07TargetUserId,sentTarget:writes(x.api)[0]?.userId,defect:writes(x.api)[0]?.userId===d.MANAGER};
  });
  await record('R3-real-page-c-without-review-or-getSchedule',async()=>{
    let updates=0;
    const x=setup(data=>data.action==='updateSchedule'?(++updates===1?{...ok,version:2}:{ok:false,code:'VERSION_MISMATCH'}):ok);
    await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});
    const file=path.join(root,'miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js');
    let page;
    vm.runInThisContext(`(function(require,Page,wx){${fs.readFileSync(file,'utf8')}\n})`,{filename:file})(name=>{
      if(name.includes('sandbox-test-driver-proof'))return x.proof;
      if(name.includes('sandbox-test-coordinator'))return d.coordinator;
      if(name.includes('utils/sandbox-test-driver'))return x.driver;
      return createRequire(file)(name);
    },definition=>{page=definition;},x.api);
    page.data=JSON.parse(JSON.stringify(page.data));
    page.setData=function(patch){Object.assign(this.data,patch);};
    page.data.form={...d.baseInput(),restDaysText:''};
    await page.runTestCase({currentTarget:{dataset:{case:'V06-c'}}});
    return {aState:d.coordinator.readCase(d.ctxFor(x.storage),'V06-a').record.state,verdict:page.data.testReport?.verdict,getScheduleRequests:x.api.__calls.filter(c=>c.action==='getSchedule').length,updates,defect:updates===2&&!x.api.__calls.some(c=>c.action==='getSchedule')};
  });
  await record('R3-malformed-success-is-candidate',async()=>{
    let n=0;const x=setup(()=>++n===1?{ok:true}:{ok:false,code:'SCHEDULE_CONFLICT'});
    const r=await x.driver.runCase({api:x.api,testCaseId:'V06-b',input:d.baseInput()});
    return {report:r.report,defect:r.report.verdict==='candidate'};
  });
  await record('R4-expiry-during-member-check',async()=>{
    const original=Date.now;const start=original();
    const x=setup(()=>ok,{expiresAt:new Date(start+10000).toISOString()});
    const call=x.api.cloud.callFunction;
    x.api.cloud.callFunction=async args=>{const r=await call(args);if(args.data.action==='getMembers')Date.now=()=>start+20000;return r;};
    try {const r=await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});return {verdict:r.report.verdict,businessRequests:writes(x.api).length,defect:writes(x.api).length===2};}
    finally{Date.now=original;}
  });
  await record('R4-second-send-synchronous-throw',async()=>{
    const x=setup(()=>ok);let n=0;const call=x.api.cloud.callFunction;
    x.api.cloud.callFunction=args=>{if(args.data.action==='createSchedule'&&++n===2)throw new Error('synthetic synchronous send failure');return call(args);};
    let thrown=false;try{await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});}catch(e){thrown=true;}
    const c=d.coordinator.readCase(d.ctxFor(x.storage),'V06-a');
    return {thrown,businessRequests:writes(x.api).length,persistedState:c.record.state,persistedResponses:c.record.responses,ordinaryBlock:d.coordinator.ordinaryEntryBlock(),defect:thrown&&writes(x.api).length===1&&c.record.state==='inFlight'};
  });
  await record('R4-response-storage-failure-still-candidate',async()=>{
    const x=setup(()=>ok);const set=x.storage.setStorageSync;
    x.storage.setStorageSync=(key,value)=>{if(JSON.parse(value).state==='candidate')throw new Error('synthetic full storage');set(key,value);};
    const r=await x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});
    return {verdict:r.report.verdict,persistedState:d.coordinator.readCase(d.ctxFor(x.storage),'V06-a').record.state,defect:r.report.verdict==='candidate'};
  });
  await record('R5-missing-user-identity-is-granted',async()=>{
    const a=p.makeAdapter({users:{[p.OWNER]:{_id:p.OWNER,status:'active'}}});const r=await p.run(a);
    return {outcome:r.outcome,granted:r.granted,commits:a.__commits.length,defect:r.granted===true};
  });
  await record('R5-wrong-record-id-is-granted',async()=>{
    const a=p.makeAdapter({users:{[p.OWNER]:{_id:'u_wrong',status:'active',openid:'inconsistent-fixture-only'}}});const r=await p.run(a);
    return {outcome:r.outcome,granted:r.granted,defect:r.granted===true};
  });
  await record('R5-expired-plan-no-injected-clock',async()=>{
    const a=p.makeAdapter();const r=await p.bootstrap.initializePrimary({adapter:a,plan:p.goodPlan({expiresAt:'2020-01-01T00:00:00Z'}),appId:p.APP_ID,envId:p.ENV_ID});
    return {outcome:r.outcome,granted:r.granted,defect:r.granted===true};
  });
  await record('R5-caller-supplied-wrong-fixed-environment',async()=>{
    const a=p.makeAdapter();const r=await p.bootstrap.initializePrimary({adapter:a,plan:p.goodPlan({appId:'wx_other',envId:'env_other'}),appId:'wx_other',envId:'env_other',nowMs:Date.now()});
    return {outcome:r.outcome,granted:r.granted,defect:r.granted===true};
  });
  d.resetAll();
  const crypto=require('node:crypto');
  const hash=rel=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,rel))).digest('hex');
  const baseline=JSON.parse(fs.readFileSync(path.join(root,'docs/证据/独立测试副本执行包本地基线-20261005.json'),'utf8'));
  const differences=[];const missing=[];
  for(const [rel,expected] of Object.entries(baseline.files)){if(!fs.existsSync(path.join(root,rel)))missing.push(rel);else if(hash(rel)!==expected)differences.push(rel);}
  const frozen=v=>!v||typeof v!=='object'||Object.isFrozen(v)&&Object.values(v).every(frozen);
  const configs={};
  for(const name of ['sandbox-test-driver-proof','schedule-sandbox-proof','schedule-entry-proof']){const v=require(path.join(root,'miniapp/miniprogram/config',name));configs[name]={value:v,deepFrozen:frozen(v)};}
  const retainedHashes={};
  for(const rel of ['miniapp/scripts/package-sandbox.cjs','miniapp/cloudbase/schedule-sandbox-resources.candidate.json','artifacts/schedule-sandbox/closed-20261005/manifest.json','artifacts/schedule-sandbox/closed-20261005-r2fix/manifest.json'])retainedHashes[rel]=hash(rel);
  const output={executedAt:new Date().toISOString(),scope:'local real-module control-flow review; synthetic APIs/storage/transactions only; no platform execution',summary:{total:results.length,reproduced:results.filter(x=>x.defect).length,harnessErrors:results.filter(x=>x.harnessError).length},baseline:{count:Object.keys(baseline.files).length,missing,differences},retainedHashes,configs,results};
  const out=__filename.replace(/\.cjs$/,'.json');fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output.summary));
})().catch(e=>{console.error(e);process.exitCode=1;});
