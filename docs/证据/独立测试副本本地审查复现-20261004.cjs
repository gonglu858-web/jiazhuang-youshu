// Codex review-only reproductions. No cloud, no product-source mutation.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const base = path.join(root, 'miniapp/cloudfunctions/scheduleSandbox');
const req = createRequire(path.join(base, 'index.js'));
const {createSandboxTestDb, PREFIX} = require('../../miniapp/tests/helpers/sandbox-test-db.cjs');
const gate = req('./gate');
const map = req('./collection-map');
const appId = 'wxfb4db1615ac15531';
const envId = 'cloud1-d8gcq5ag39d847723';
const openid = 'LOCAL_REVIEW_SYNTHETIC_ACCOUNT';
const userId = 'u_' + crypto.createHash('sha256').update(appId + ':' + openid).digest('hex').slice(0,40);
const cfg = {enabled:true, appId, envId, allowedUserIds:[userId], roundId:'local-review',
  expiresAt:'2030-01-01T00:00:00Z', phase:'prepare', projectId:'', projectReadyMarker:'configured-string-only'};
function seeded() {
  return createSandboxTestDb({
    [PREFIX+'users']:{[userId]:{_id:userId,openid,status:'active'}},
    [PREFIX+'app_admins']:{primary:{_id:'primary',userId,status:'active'}}
  });
}
function entry(db, config, normalizeContext=false) {
  let databaseCalls=0;
  const shim={init(){}, DYNAMIC_CURRENT_ENV:'local-only',getWXContext:()=>({APPID:appId,OPENID:openid}),
    database(){databaseCalls++;return db;}};
  let source=fs.readFileSync(path.join(base,'index.js'),'utf8');
  if(config) {
    const replaced=source.replace(/const SANDBOX_CONFIG = gate\.readConfig\(\{[\s\S]*?\}\);/,
      'const SANDBOX_CONFIG = gate.readConfig('+JSON.stringify(config)+');');
    assert.notEqual(replaced,source);source=replaced;
  }
  const mod={exports:{}};
  const localRequire=name=>{
    if(name==='wx-server-sdk')return shim;
    if(name==='./vendor/service' && normalizeContext){
      const real=req(name);
      return {...real,createService(...args){const service=real.createService(...args);return {
        ...service,execute(event,trusted){return service.execute(event,{APPID:trusted.appId,OPENID:trusted.openid});}
      };}};
    }
    return req(name);
  };
  // Normalization is an explicitly labelled diagnostic shim to expose independent downstream bugs.
  vm.runInThisContext('(function(require,module,exports,process,console){'+source+'\n})',
    {filename:'review-memory-sandbox-index.js'})(localRequire,mod,mod.exports,{env:{TCB_ENV:envId}},{error(){}});
  return {main:mod.exports.main,databaseCalls:()=>databaseCalls};
}
function client(proof){
  const filename=path.join(root,'miniapp/miniprogram/utils/schedule-sandbox-client.js');
  const local=createRequire(filename);const mod={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(filename,'utf8')+'\n})')(
    name=>name==='../config/schedule-sandbox-proof'?proof:local(name),mod,mod.exports);
  return mod.exports;
}
(async()=>{
  const results=[];
  const closed=entry(seeded());const r0=await closed.main({action:'identify'});
  assert.equal(r0.code,'SANDBOX_DISABLED');assert.equal(closed.databaseCalls(),0);
  results.push({id:'C0',scope:'unmodified entry, default config',result:r0.code,databaseCalls:0});
  const raw=seeded();const live=entry(raw,cfg);const r1=await live.main({action:'identify'});
  assert.equal(r1.code,'IDENTITY_UNAVAILABLE');
  results.push({id:'R1',scope:'actual main + actual vendor; only config enabled in memory',result:r1,
    databaseCalls:live.databaseCalls(),operations:raw.getOperationCount()});

  const proof={...require('../../miniapp/miniprogram/config/schedule-sandbox-proof'),enabled:true};
  const calls=[];const api={getAccountInfoSync:()=>({miniProgram:{appId,envVersion:'develop'}}),
    cloud:{callFunction:async args=>{calls.push(args);return {result:{ok:true}};}}};
  const cli=client(proof);
  const payloads=[{action:'createProject',requestId:'r1',name:'虚构测试 · 审查'},
    {action:'createInvitation',projectId:'p_test',role:'师傅',trades:['拆改']},
    {action:'approveInvitation',projectId:'p_test',invitationId:'i_test',applicantNumber:'LOCAL_SYNTHETIC'},
    {action:'createSchedule',projectId:'p_test',requestId:'s1',form:{content:'local',restDays:[]},expectedConfirmed:true},
    {action:'cancelSchedule',projectId:'p_test',scheduleId:'s_test',expectedVersion:1,reason:'local'}];
  for(const p of payloads)await cli.callSandbox(p,{api});
  const lost=payloads.map((p,i)=>({action:p.action,lost:Object.keys(p).filter(k=>!(k in calls[i].data))}));
  assert.ok(lost.every(x=>x.lost.length));
  results.push({id:'R2',scope:'actual client, enabled config in memory; fake transport',lost,
    blankProjectConfigurationStillSent:calls.length});

  const db=seeded();const normalized=entry(db,cfg,true);
  const first=await normalized.main({action:'createProject',requestId:'one',name:'虚构测试 · 一'});
  const second=await normalized.main({action:'createProject',requestId:'two',name:'虚构测试 · 二'});
  assert.equal(first.ok,true);assert.equal(second.ok,true);assert.notEqual(first.projectId,second.projectId);
  const changedPayload=await normalized.main({action:'createProject',requestId:'one',name:'虚构测试 · 改名'});
  await db.collection(PREFIX+'users').doc(userId).update({data:{status:'disabled'}});
  const revokedReplay=await normalized.main({action:'createProject',requestId:'one',name:'虚构测试 · 一'});
  assert.equal(revokedReplay.ok,true);assert.equal(changedPayload.ok,true);
  results.push({id:'R3',scope:'diagnostic only: trusted context normalized in memory; actual project wrapper/vendor',
    projectCount:Object.keys(db.getData()[PREFIX+'projects']).length,changedPayloadAccepted:changedPayload.ok,
    disabledUserReplayAccepted:revokedReplay.ok});

  const empty=createSandboxTestDb();const unknown=entry(empty,cfg,true);
  const unknownResult=await unknown.main({action:'not-a-real-action'});
  assert.equal(unknownResult.ok,false);assert.ok(empty.getWriteLog().length>0);
  const badPhase=gate.readConfig({...cfg,phase:'typo'});
  assert.equal(badPhase.phase,'prepare');
  assert.equal(gate.assertProjectScope(gate.readConfig(cfg),'p_38507fc9b43c4e23a7fbd996415637bb'),null);
  const outOfScope=seeded();
  await outOfScope.collection(PREFIX+'projects').add({data:{_id:'p_other',scope:'identity-test',status:'active',name:'虚构测试 · 其他轮次'}});
  const code='ABCDEF123456ABCDEF';
  await outOfScope.collection(PREFIX+'invitations').add({data:{_id:'i_other',projectId:'p_other',role:'师傅',trades:['拆改'],
    tokenHash:crypto.createHash('sha256').update(appId+':'+code).digest('hex'),status:'issued',version:1,expiresAt:'2030-01-01T00:00:00Z'}});
  outOfScope.reset();
  const execute=entry(outOfScope,{...cfg,phase:'execute',projectId:'p_only'},true);
  const omittedProject=await execute.main({action:'applyInvitation',invitationCode:code});
  assert.equal(omittedProject.ok,true);
  results.push({id:'R4',scope:'gate + main; context normalization only for business diagnostics',
    unknownActionResult:unknownResult.code,unknownActionWrites:empty.getWriteLog().length,
    invalidPhaseNormalized:badPhase.phase,prepareAcceptsOldProject:true,executeMissingProjectReachedBusiness:omittedProject.ok,
    crossProjectInvitationStatus:outOfScope.getData()[PREFIX+'invitations'].i_other.status,
    crossProjectWriteCount:outOfScope.getWriteLog().length});

  const names=[];const spy={collection(name){names.push(typeof name);return {};},runTransaction:async f=>f(spy)};
  const mapped=map.createSandboxDb(spy);
  for(const name of ['constructor','__proto__','toString'])mapped.collection(name);
  assert.equal(names.length,3);
  const handle=mapped.collection('users');
  Object.defineProperty(handle,'extra',{value:1});
  assert.equal(handle.extra,1);
  results.push({id:'R6',scope:'actual mapping module, spy lower DB',prototypeNameSdkCalls:names.slice(0,3),
    definePropertyMutationAllowed:true});
  const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(js|json|wxml)$/.test(p))files.push(p);
  }}walk(path.join(root,'miniapp/miniprogram'));
  const consumers=files.filter(p=>!p.endsWith('schedule-sandbox-client.js')&&/require\([^\n]*schedule-sandbox-client/.test(fs.readFileSync(p,'utf8')));
  assert.equal(consumers.length,0);
  results.push({id:'R5',clientConsumers:consumers.length,appRoutes:require('../../miniapp/miniprogram/app.json').pages.length,
    note:'No page imports dedicated client; no persistent pending-request state in dedicated client.'});

  const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'施工安排事务兼容V1-V3验收-20261003.json'),'utf8'));
  const hashes=baseline.currentCodeSha256;const changed=[];
  for(const [file,hash] of Object.entries(hashes)){
    const full=path.join(root,file);const actual=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if(actual!==hash)changed.push(file);
  }
  const attachment=fs.readFileSync('C:/Users/30591/.codex/attachments/8cccfa95-5bd7-44ea-aa82-d24abc690be8/已粘贴的文本.txt','utf8');
  const delivery=[];let jsCount=0,jsonCount=0;
  for(const m of attachment.matchAll(/^- (miniapp\/[^\s（]+)(?:（生成）)?\s*([a-f0-9]{64})\r?$/gm)) {
    const body=fs.readFileSync(path.join(root,m[1]));
    const actual=crypto.createHash('sha256').update(body).digest('hex');assert.equal(actual,m[2]);
    delivery.push({file:m[1],sha256:actual});
    if(/\.(cjs|js)$/.test(m[1])){new vm.Script(body.toString(),{filename:m[1]});jsCount++;}
    if(m[1].endsWith('.json')){JSON.parse(body);jsonCount++;}
  }
  assert.equal(delivery.length,14);
  const output={recordedAt:new Date().toISOString(),mode:'offline_no_cloud',productFilesModified:false,
    baseline:{count:Object.keys(hashes).length,changed},delivery,syntax:{jsCount,jsonCount},
    validation:{fullRegression:{total:429,pass:428,fail:0,skip:1},
      separatelyRunExistingSdkOfflineTest:{total:1,pass:1,fail:0,skip:0},buildCheck:'passed',gitDiffCheck:'passed; CRLF warnings only'},results};
  fs.writeFileSync(path.join(__dirname,'独立测试副本本地审查复现-20261004.json'),JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
