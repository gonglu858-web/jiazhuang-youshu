'use strict';
// Review-only: load actual local modules; synthetic API/storage/transaction data.
// Does not write application files or contact any cloud service.
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..');
function helpers(rel,names){const file=path.join(root,rel),src=fs.readFileSync(file,'utf8'),m={exports:{}};vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${src.slice(0,src.indexOf('\ntest('))}\nmodule.exports={${names}};})`,{filename:file})(createRequire(file),m,m.exports,path.dirname(file),file);return m.exports;}
const d=helpers('miniapp/tests/sandbox-test-driver.test.cjs','loadDriver,loadPage,openProof,baseInput,makeStorage,makeApi,resetAll,ctxFor,coordinator,scheduleOk,IDENTIFY_OK,MEMBERS_OK,MANAGER,WORKER_B,PROJECT');
const p=helpers('miniapp/tests/sandbox-primary-bootstrap.test.cjs','bootstrap,makeAdapter,goodPlan,goodApproval,OWNER');
const results=[];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function record(id,fn){try{results.push({id,...await fn()});}catch(e){results.push({id,harnessError:String(e.stack)});}}
function setup(handler){d.resetAll();const storage=d.makeStorage(),proof=d.openProof(),driver=d.loadDriver(proof);const api=d.makeApi({storage,handler:async data=>{
  if(data.action==='identify')return {result:d.IDENTIFY_OK};
  if(data.action==='getMembers')return {result:d.MEMBERS_OK};
  return handler?handler(data):{result:d.scheduleOk()};
}});return {storage,proof,driver,api};}
const writes=api=>api.__calls.filter(x=>['createSchedule','updateSchedule','removeMember'].includes(x.action));
const runA=x=>x.driver.runCase({api:x.api,testCaseId:'V06-a',input:d.baseInput()});
(async()=>{
  await record('S1-official-account-info-shape-blocked',async()=>{
    const x=setup();x.api.getAccountInfoSync=()=>({miniProgram:{appId:x.proof.appId,envVersion:'develop',version:''}});
    const r=await runA(x);return {code:r.code,reasons:r.report.gateReasons,calls:x.api.__calls.length,defect:r.code==='TEST_DRIVER_GATE_BLOCKED'&&r.report.gateReasons.includes('运行环境未返回环境 ID。')};
  });
  await record('S2-malformed-batch-cases-silently-reset',async()=>{
    const x=setup();const key=d.coordinator.batchKey(x.proof.envId,x.proof.roundId);
    x.storage.store[key]=JSON.stringify({kind:'sandbox-test-driver-batch/2',envId:x.proof.envId,roundId:x.proof.roundId,cases:[]});
    const r=await runA(x);return {verdict:r.report.verdict,businessRequests:writes(x.api).length,defect:writes(x.api).length===2};
  });
  await record('S2-legacy-stopped-case-hidden',async()=>{
    const x=setup();const key=d.coordinator.legacyBatchKey(x.proof.envId,x.proof.roundId,d.MANAGER)+':case:V06-a';
    x.storage.store[key]=JSON.stringify({kind:'sandbox-test-driver-case/1',testCaseId:'V06-a',state:'stopped',responses:[{outcome:'timeout'}]});
    const r=await runA(x);return {oldKey:key,verdict:r.report.verdict,businessRequests:writes(x.api).length,legacyPreserved:!!x.storage.store[key],defect:writes(x.api).length===2};
  });
  await record('S2-forged-internal-owner-bypasses-runtime-hold',async()=>{
    const x=setup();const file=path.join(root,'miniapp/miniprogram/utils/schedule-sandbox-client.js'),m={exports:{}};
    vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file,'utf8')}\n})`)(name=>name.includes('config/schedule-sandbox-proof')?{...createRequire(file)(name),enabled:true,roundId:x.proof.roundId,sandboxProjectId:x.proof.projectId}:createRequire(file)(name),m,m.exports);
    const hold=d.coordinator.acquireRuntimeHold('inFlight','test','V06-a');
    try{const r=await m.exports.refreshSessionIdentity(x.api,{});return {status:r.status,calls:x.api.__calls.length,holdStillHeld:d.coordinator.peekRuntimeHold().held,defect:x.api.__calls.length===1};}finally{d.coordinator.releaseRuntimeHold(hold.token);}
  });
  await record('S3-second-response-not-persisted-until-first',async()=>{
    let resolveFirst,secondResolved=false,n=0;
    const x=setup(data=>{if(data.action==='createSchedule'&&++n===1)return new Promise(resolve=>{resolveFirst=resolve;});secondResolved=true;return {result:d.scheduleOk()};});
    const running=runA(x);for(let i=0;i<12&&!secondResolved;i++)await tick();await tick();
    const before=d.coordinator.readCase(d.ctxFor(x.storage),'V06-a');const saved=before.record?.responses?.length||0;
    resolveFirst({result:d.scheduleOk()});const r=await running;
    return {secondResolved,rowsSavedBeforeFirst:saved,finalVerdict:r.report.verdict,defect:secondResolved&&saved===0};
  });
  await record('S3-candidate-readback-lost-responses-accepted',async()=>{
    const x=setup(),set=x.storage.setStorageSync;let injected=false;
    x.storage.setStorageSync=(key,value)=>{const v=JSON.parse(value);if(v.cases?.['V06-a']?.state==='candidate'){delete v.cases['V06-a'].responses;injected=true;}set(key,JSON.stringify(v));};
    const r=await runA(x),rec=d.coordinator.readCase(d.ctxFor(x.storage),'V06-a').record;
    return {injected,verdict:r.report.verdict,persistedResponseCount:rec.responses?.length||0,defect:injected&&r.report.verdict==='candidate'&&!rec.responses};
  });
  await record('S4-current-expected-date-overwritten',async()=>{
    let n=0;const current=d.scheduleOk({version:7,expectedDate:'2026-11-05'});
    const x=setup(data=>data.action==='getSchedule'?{result:{ok:true,schedule:current}}:data.action==='updateSchedule'?{result:++n===1?d.scheduleOk({version:8}):{ok:false,code:'VERSION_MISMATCH'}}:{result:d.scheduleOk()});
    await runA(x);d.coordinator.acceptCloudReview(d.ctxFor(x.storage),'V06-a','synthetic-review');
    const page=d.loadPage(x.api,x.driver,x.proof);page.data.form={...d.baseInput(),restDaysText:''};
    await page.runTestCase({currentTarget:{dataset:{case:'V06-c'}}});
    const updates=writes(x.api).filter(c=>c.action==='updateSchedule');
    return {currentExpectedDate:current.expectedDate,currentEndDate:current.endDate,sentExpectedDates:updates.map(c=>c.form.expectedDate),verdict:page.data.testReport.verdict,defect:updates.length===2&&updates.every(c=>c.form.expectedDate!==current.expectedDate)};
  });
  await record('S4-invalid-pagination-treated-as-empty',async()=>{
    const x=setup(data=>data.action==='listSchedules'?{result:{ok:false,schedules:[{unexpected:'invalid-row'}],pagination:{}}}:{result:{ok:true,userId:d.WORKER_B,status:'left'}});
    const r=await x.driver.runCase({api:x.api,testCaseId:'V07-B',input:{projectId:d.PROJECT,userId:d.WORKER_B}});
    return {verdict:r.report.verdict,businessRequests:writes(x.api).length,defect:writes(x.api).length===1&&r.report.verdict==='candidate'};
  });
  await record('S4-unvalidated-nested-field-persists',async()=>{
    const x=setup(()=>({result:d.scheduleOk({content:{token:'SYNTHETIC_SECRET_MARKER'}})}));const r=await runA(x);
    return {verdict:r.report.verdict,markerInStorage:JSON.stringify(x.storage.store).includes('SYNTHETIC_SECRET_MARKER'),defect:r.report.verdict==='candidate'&&JSON.stringify(x.storage.store).includes('SYNTHETIC_SECRET_MARKER')};
  });
  await record('S5-disabled-primary-observed-as-consistent',async()=>{
    const adapter=p.makeAdapter(),plan=p.goodPlan(),approval=p.goodApproval();
    await p.bootstrap.initializePrimary({adapter,plan,approval});adapter.__data.schtest_v1_app_admins.primary.status='disabled';
    const r=await p.bootstrap.observePrimary({adapter,plan,approval});return {state:r.state,primaryStatus:'disabled',defect:r.state==='present'};
  });
  d.resetAll();
  const output={executedAt:new Date().toISOString(),scope:'local real-module review; synthetic API/storage/transaction data; no platform calls',summary:{total:results.length,reproduced:results.filter(x=>x.defect).length,harnessErrors:results.filter(x=>x.harnessError).length},results};
  fs.writeFileSync(__filename.replace(/\.cjs$/,'.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output.summary));
})().catch(e=>{console.error(e);process.exitCode=1;});
