// 本地验收。保留 WorkBuddy/历史证据；只输出新的 Codex 证据。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),rel=p=>path.join(root,p);
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const wb=rel('docs/证据/独立测试副本U3U5收尾-20261004.cjs');
const source=fs.readFileSync(wb,'utf8');
const prefix=source.slice(0,source.indexOf('// ── 验收清单执行'));
const {loadStack,bindAccount,inputEvent,ENV_ID,ROUND}=vm.runInThisContext(
  '(function(require,__dirname){'+prefix+';return {loadStack,bindAccount,inputEvent,ENV_ID,ROUND};})',
  {filename:wb})(createRequire(wb),__dirname);
const results=[];
async function rec(id,fn){results.push({id,...await fn()});console.log(id+': verified');}
const prior=JSON.parse(fs.readFileSync(rel('docs/证据/独立测试副本U1-U5-Codex复核-20261004.json'),'utf8'));
const historical={...prior.historicalHashes};
for(const p of [wb,wb.replace('.cjs','.json')])historical[path.relative(root,p)]=sha(p);
for(const [p,hash] of Object.entries(historical))assert.equal(sha(rel(p)),hash,p);
const required=['miniapp/miniprogram/utils/schedule-sandbox-client.js','miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js',
 'miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.wxml','miniapp/tests/schedule-sandbox-frontend.test.cjs'];
const optional=['identify','listMyProjects','requestBindingNumber','createProject','applyInvitation'];
(async()=>{
 await rec('U3-all-optional-actions-no-outbound-target',async()=>{
  const cases=[];
  for(const target of ['', 'p_sbx_target']) for(const action of optional){
   const s=loadStack({target});await bindAccount(s);s.page.onLoad();
   s.page.inputField(inputEvent('invitationCodeInput','synthetic-invite'));
   assert.equal(Object.hasOwn(s.page.buildPayload(action),'projectId'),false);
   await s.page.runAction(action);
   assert.equal(s.calls.length,1);assert.equal(Object.hasOwn(s.calls[0],'projectId'),false);
   // Direct client input must be normalized too (fresh stack, no prior pending).
   const d=loadStack({target});await bindAccount(d);
   await d.client.callSandbox({action,projectId:'p_untrusted_input',requestId:'direct',invitationCode:'synthetic-invite'},{api:d.api});
   assert.equal(d.calls.length,1);assert.equal(Object.hasOwn(d.calls[0],'projectId'),false);
   cases.push({targetConfigured:!!target,action,pageOmitsTarget:true,clientOmitsTarget:true});
  }
  return {passed:true,cases};
 });
 await rec('U3-real-page-unknown-and-retry-contract',async()=>{
  const cases=[];
  for(const action of ['listMyProjects','createProject','requestBindingNumber','applyInvitation']){
   const s=loadStack();await bindAccount(s);s.page.onLoad();
   s.page.inputField(inputEvent('invitationCodeInput','synthetic-invite'));
   await s.page.runAction(action);
   const p=s.client.readPending(s.store,ENV_ID,ROUND);assert.equal(p.available,true);assert.ok(p.record);
   assert.equal(p.envelope.projectId,'');assert.equal(Object.hasOwn(p.snapshot,'projectId'),false);
   const r=loadStack({store:s.store,handler:async()=>({result:{ok:true}})});r.page.onLoad();
   if(action==='applyInvitation')r.page.inputCredential(inputEvent('invitationCodeInput','synthetic-invite'));
   await r.page.retryPending();
   if(['requestBindingNumber','applyInvitation'].includes(action)){
    assert.equal(r.calls.length,0);assert.match(r.page.data.lastError,/SANDBOX_RETRY_UNSAFE/);
    assert.deepEqual(r.client.readPending(s.store,ENV_ID,ROUND).envelope,p.envelope);
   }else{
    assert.deepEqual(r.calls.map(x=>x.action),['identify',action]);
    assert.equal(r.calls[1].requestId,p.record.requestId);assert.deepEqual(r.calls[1],s.calls[0]);
    assert.equal(r.client.readPending(s.store,ENV_ID,ROUND).record,null);
   }
   cases.push({action,readablePending:true,behavior:['requestBindingNumber','applyInvitation'].includes(action)?'unsafe-retry-denied':'same-request-restored'});
  }
  return {passed:true,cases};
 });
 await rec('U3-required-target-and-corruption-still-denied',async()=>{
  const s=loadStack();await bindAccount(s);
  await s.client.callSandbox({action:'createSchedule',requestId:'req',form:{content:'local'}},{api:s.api});
  const before=JSON.stringify([...s.store.map]);
  for(const target of ['', 'p_changed']){
   const r=loadStack({store:s.store,target});const out=await r.client.resumePending({api:r.api});
   assert.equal(out.code,target?'SANDBOX_TARGET_CHANGED':'SANDBOX_PROJECT_REQUIRED');assert.equal(r.calls.length,0);
   assert.equal(JSON.stringify([...s.store.map]),before);
  }
  const key=[...s.store.map.keys()].find(k=>k.includes(':envelope:'));
  s.store.map.set(key,{...s.store.map.get(key),action:'cancelSchedule'});
  const r=loadStack({store:s.store});assert.equal((await r.client.resumePending({api:r.api})).code,'SANDBOX_STORAGE_UNAVAILABLE');
  assert.equal(r.calls.length,0);
  return {passed:true};
 });
 await rec('U5-array-event-confirmation-and-reset',async()=>{
  const s=loadStack({handler:async()=>({result:{ok:true}})});await bindAccount(s);s.page.onLoad();
  s.page.inputForm(inputEvent('endDate','2026-10-09'));s.page.inputForm(inputEvent('expectedDate','2026-10-10'));
  for(const value of [[],true,'date-confirm',['other'],undefined]){
   s.page.toggleDateConfirm({detail:{value}});assert.equal(s.page.data.dateConfirmed,false);
   const before=s.calls.length;await s.page.runAction('createSchedule');assert.equal(s.calls.length,before);
  }
  s.page.toggleDateConfirm({detail:{value:['date-confirm']}});assert.equal(s.page.data.dateConfirmed,true);
  await s.page.runAction('createSchedule');assert.equal(s.calls.at(-1).expectedConfirmed,true);
  for(const field of ['endDate','expectedDate']){
   s.page.toggleDateConfirm({detail:{value:['date-confirm']}});
   s.page.inputForm(inputEvent(field,'2026-10-15'));assert.equal(s.page.data.dateConfirmed,false);
  }
  s.page.toggleDateConfirm({detail:{value:['date-confirm']}});s.page.onShow();assert.equal(s.page.data.dateConfirmed,false);
  // Record wording boundary, not a real event from the single-checkbox template.
  s.page.toggleDateConfirm({detail:{value:['date-confirm','other']}});
  const mixedArrayAccepted=s.page.data.dateConfirmed;
  assert.equal(mixedArrayAccepted,true);
  const wxml=fs.readFileSync(rel('miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.wxml'),'utf8');
  assert.match(wxml,/<checkbox-group[^>]*bindchange="toggleDateConfirm"[^>]*>\s*<checkbox\s+value="date-confirm"[^>]*\/>\s*<\/checkbox-group>/);
  assert.doesNotMatch(wxml,/<checkbox(?!-group)\b[^>]*bindchange="toggleDateConfirm"/);
  return {passed:true,mixedArrayAccepted,note:'includes semantics; only the fixed checkbox exists in actual template. Claim rejecting every mixed array is too strong. No simulator clicks.'};
 });
 const baseline=JSON.parse(fs.readFileSync(rel('docs/证据/施工安排事务兼容V1-V3验收-20261003.json'),'utf8')).currentCodeSha256;
 const changed=Object.entries(baseline).filter(([p,h])=>sha(rel(p))!==h).map(([p])=>p);
 assert.deepEqual(changed,['miniapp/miniprogram/app.json']);
 const stableFull={
  'miniapp/cloudfunctions/scheduleSandbox/project-guard.js':'c8a2d6f28747bbd343fcbdbb4826ebb880ed0bf89819be4d186204c085c53687',
  'miniapp/tests/schedule-sandbox-isolation.test.cjs':'731d9a8e76c5af19657029c61c2bd61d50a16eff6eb4be4dc23704b404be610a'};
 for(const [p,h]of Object.entries(stableFull))assert.equal(sha(rel(p)),h);
 const stablePrefixes={'collection-map.js':'09c5aa9b','gate.js':'712b6e92','index.js':'1bec56a3'};
 for(const[p,h]of Object.entries(stablePrefixes))assert.ok(sha(rel('miniapp/cloudfunctions/scheduleSandbox/'+p)).startsWith(h));
 assert.ok(sha(rel('miniapp/tests/helpers/sandbox-test-db.cjs')).startsWith('61642c17'));
 const fresh=require(rel('miniapp/miniprogram/config/schedule-sandbox-proof.js'));
 const old=require(rel('miniapp/miniprogram/config/schedule-entry-proof.js'));
 assert.equal(fresh.enabled,false);assert.equal(fresh.sandboxProjectId,'');assert.equal(fresh.roundId,'');assert.equal(old.enabled,false);assert.deepEqual(old.allowedProjectIds,[]);
 for(const x of [fresh,fresh.allowedVersions,old,old.allowedVersions,old.allowedProjectIds])assert.equal(Object.isFrozen(x),true);
 // No fallback PASS strings: failure remains unverified.
 const staticChecks={};
 for(const[name,args]of Object.entries({vendor:['miniapp/scripts/build-sandbox.cjs','--check'],compile:['miniapp/scripts/check.cjs','D:/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec'],structure:['miniapp/scripts/check-pages.cjs']})){
  try{staticChecks[name]={status:'passed',output:execFileSync(process.execPath,args,{cwd:root,encoding:'utf8'}).trim()};}
  catch(e){staticChecks[name]={status:'not_verified',code:e.code||'',message:String(e.message)};}
 }
 // Re-run WB evidence without overwriting it. Preserve fallback labels exactly, never treat them as executed checks.
 const replayPath=__filename.replace('.cjs','-WorkBuddy复跑.json');
 const adapted=source.replace("const jsonPath = path.join(__dirname, '独立测试副本U3U5收尾-20261004.json');",'const jsonPath = '+JSON.stringify(replayPath)+';').replace('\n(async () => {','\nreturn (async () => {');
 assert.notEqual(adapted,source);
 await vm.runInThisContext('(function(require,__dirname){'+adapted+'\n})',{filename:wb})(createRequire(wb),__dirname);
 const replay=JSON.parse(fs.readFileSync(replayPath,'utf8'));assert.equal(replay.summary.passed,12);assert.equal(replay.summary.failed,0);
 for(const[p,h]of Object.entries(historical))assert.equal(sha(rel(p)),h,p);
 const output={date:'2026-10-04',scope:'local',results,staticChecks,baseline:{count:Object.keys(baseline).length,changed},
  files:Object.fromEntries(required.map(p=>[p,sha(rel(p))])),stableFull,stablePrefixes,historicalHashes:historical,
  entry:{newEnabled:fresh.enabled,newSandboxProjectId:fresh.sandboxProjectId,newRoundId:fresh.roundId,oldEnabled:old.enabled,oldAllowedProjectIds:old.allowedProjectIds,frozen:true},
  workBuddyChecks:replay.summary,verdict:'U3/U5 functional local acceptance passed; evidence wording corrections recorded separately',
  limits:['No cloud/deployment/device/installation actions','No complete pre-edit file snapshot: historical hashes and current source checked, not a full per-round line diff','WB hardcoded spawn fallback is not execution evidence; regex is not native compilation']};
 fs.writeFileSync(__filename.replace('.cjs','.json'),JSON.stringify(output,null,2)+'\n','utf8');
})().catch(e=>{console.error(e);process.exitCode=1;});
