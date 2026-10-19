'use strict';
// 本轮待用户批准；须存在本轮批准记录方可启动。候选/关闭各一次；不调用函数或业务数据库。凭据和下载地址仅在内存。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pins={
 'cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c',
 'cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478',
 'cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb'};
for(const [n,h] of Object.entries(pins)) assert.equal(sha(fs.readFileSync(path.join(root,'miniapp/scripts/lib',n))),h);
const c=require('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs');
const o=require('../../miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs');
const ENV='cloud1-d8gcq5ag39d847723',NAME='scheduleSandbox';
const EXPECTED='947befece75aa7142db2daf05bd82930db9bb8970fc083c3dbf656f17eed6c09';
const mode=process.argv[2];assert(['candidate','closed'].includes(mode));
const prep=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I2固化显示续接轮包准备-20261019.json')));
assert.equal(prep.plan.checkRoundId,'i2display-20261019-49e9564b6313');
const approval=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I2固化显示续接轮批准-20261019.json')));assert.equal(approval.roundId,prep.plan.checkRoundId);assert.equal(approval.approved,true);assert.equal(approval.planSha256,prep.planSha256);assert.equal(approval.manifestSha256,prep.manifestSha256);

const frozen=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I2固化显示续接轮执行脚本冻结-20261019.json')));
assert.equal(frozen.roundId,prep.plan.checkRoundId);assert.equal(frozen.planSha256,prep.planSha256);assert.equal(frozen.manifestSha256,prep.manifestSha256);
for(const item of frozen.scripts)assert.equal(sha(fs.readFileSync(path.join(__dirname,item.name))),item.sha256);
const observation=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I2固化显示续接轮手动预览-20261019.json')));assert.equal(observation.roundId,prep.plan.checkRoundId);assert.equal(observation.manualPreviewReportedSuccess,true);
assert.equal(sha(fs.readFileSync(path.join(root,'miniapp/scripts/package-participant-identity-check.cjs'))),'5769dd7239e990cd223aa47d0540a042931a3792435c21a0cc877f54efdcbe53');
assert.equal(prep.plan.participantCode,'2');
assert.equal(prep.plan.keyDiagnostic,false);assert.equal(prep.plan.requestProtocol,'participant-identity-request/1');
assert.equal(sha(fs.readFileSync(prep.planPath)),'09106337e0dc62a311f77918ab971d4d91566676a9bff5ee9be57b1b487c7446');
assert.equal(sha(fs.readFileSync(path.join(prep.packageDir,'manifest.json'))),'ec4db33e0dcb44e4eb06dea2eebf45a9b488d8a5185d0e8b052b930c41d99f19');
const tool=require('../../miniapp/scripts/package-participant-identity-check.cjs');
const prefix=path.join(__dirname,'Codex参与者I2固化显示续接轮部署关闭-20261019.'+mode);
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
async function main(){
 assert.equal(process.argv.length,3);
 process.env.PIC_CLOSE_SOURCE_DIR=prep.plan.closeSourceDir;
 assert(tool.checkCloseDir(prep.packageDir).ok);
 if(mode==='candidate'){assert(tool.checkDir(prep.packageDir).ok);assert(Date.parse(prep.plan.windowExpiresAtIso)-Date.now()>15*60000);}
 let displayPreflight=null;
 if(mode==='candidate'){
  const raw=require('node:child_process').execFileSync('C:/Users/30591/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe',['-NoProfile','-File',path.join(__dirname,'Codex参与者I2固化显示续接轮口令执行-20261019.ps1'),'-Mode','Check'],{encoding:'utf8',timeout:10000,maxBuffer:16384,windowsHide:true});
  const result=JSON.parse(raw);assert(result.ok&&result.roundId===prep.plan.checkRoundId&&result.timeGuard.allowed&&result.secretRead===false);displayPreflight={ok:true,allowed:true,secretRead:false,timeInputType:result.timeInputType};
 }
 const configInput=prep.configs[mode], sub=mode==='candidate'?'server/scheduleSandbox/':'close/server/scheduleSandbox/';
 function verify(){assert.equal(sha(fs.readFileSync(configInput.path)),configInput.sha256);for(const f of prep.files.filter(x=>x.rel.startsWith(sub))){assert.equal(sha(fs.readFileSync(path.join(prep.packageDir,f.rel))),f.sha256);}}
 verify();
 const ready=await o.runLocalCheck();assert.equal(ready.status,'LOCAL_READY');
 assert(!fs.existsSync(prefix+'.json'));
 const runId='codex-i2-'+mode+'-'+crypto.randomUUID();
 save(prefix+'.started.json',{runId,startedAt:new Date().toISOString(),authorization:approval.userQuote,roundId:prep.plan.checkRoundId,mode,scope:'I2分层只读核验具体执行页第3节；本阶段一批凭据、一次覆盖及回读，不重试部署'});
 const report={runId,reviewedHead:'a276381',mode,roundId:prep.plan.checkRoundId,scriptSha256:sha(fs.readFileSync(__filename)),startedAt:new Date().toISOString(),target:{appId:c.FIXED.wxAppId,envId:ENV,region:'ap-shanghai',functionName:NAME},libraryPins:pins,status:'STARTED',displayPreflight,credentialFetchRequested:0,credentialFetchAttempted:null,apiProcesses:[],downloadAttempted:false,deployCalls:0,functionInvocations:0,businessDatabaseCalls:0,credentialAcquisitionMayRefreshOfficialCache:true};
 let stage='credentialFetch';
 try{
  report.credentialFetchRequested++;
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}});
  report.credentialFetchAttempted=f.fetchAttempted;report.fetchDiagnostics=o.rebuildFetchDiagnostics(f.fetchDiagnostics);
  const s=f.snapshot,dir=o.createIsolationDir(runId,{});o.assertIsolationClean(dir);
  stage='association';console.log(JSON.stringify({stage}));
  const a=await o.runCliAssociation(s,dir,{});
  report.association={matched:a.matched,stoppedEarly:a.stoppedEarly,accountIdSha256:a.accountIdSha256,accountIdTail:a.accountIdTail,uinSha256:a.uinSha256,uinTail:a.uinTail,stages:a.stages.map(x=>({stage:x.stage,ok:x.ok,notExecuted:x.notExecuted===true,exitCode:x.exitCode,timedOut:x.timedOut,overflow:x.overflow,closeNotObserved:x.closeNotObserved,spawnError:x.spawnError,requestId:o.safeRequestId(x.requestId)}))};
  assert.equal(a.matched,true);
  const env=o.buildIsolatedEnv(process.env,s,dir);
  async function api(action,body){
   stage=action;console.log(JSON.stringify({stage}));o.assertCredentialFresh(s,Date.now());
   const rec={action,attempted:false};report.apiProcesses.push(rec);
   const r=await c.spawnBounded(c.FIXED.nodeBin,[c.FIXED.cliEntry,...c.buildStageArgs({key:action,service:'scf',action,apiVersion:'2018-04-16',body:JSON.stringify(body),envArgs:['-e',ENV]})],{cwd:dir,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn:(...args)=>{rec.attempted=true;return require('node:child_process').spawn(...args);}});
   Object.assign(rec,{exitCode:r.code,spawnError:Boolean(r.spawnError),timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:Boolean(r.closeNotObserved),processExited:r.processExited,terminationRequested:r.terminationRequested,terminationConfirmed:r.terminationConfirmed});
   assert(r.code===0&&!r.signal&&!r.spawnError&&!r.timedOut&&!r.overflow&&!r.closeNotObserved);
   o.assertCredentialFresh(s,Date.now());const p=c.parseCliJson(r.stdout,'scf',action,action);rec.requestId=o.safeRequestId(p.RequestId);return p;
  }
  if(mode==='candidate'){
   const baseline=await api('GetFunctionAddress',{FunctionName:NAME,Namespace:ENV});assert.equal(baseline.CodeSha256,EXPECTED);report.closedBaselineMatched=true;
   assert(Date.parse(prep.plan.windowExpiresAtIso)-Date.now()>15*60000);
  }
  verify();o.assertCredentialFresh(s,Date.now());
  if(mode==='candidate'){assert(tool.checkDir(prep.packageDir).ok);assert(Date.parse(prep.plan.windowExpiresAtIso)-Date.now()>15*60000);}
  stage='deployment';
  save(prefix+'.before-write.json',{runId,mode,roundId:prep.plan.checkRoundId,at:new Date().toISOString(),configSha256:configInput.sha256,files:prep.files.filter(x=>x.rel.startsWith(sub))});
  const args=['fn','deploy',NAME,'--env-id',ENV,'--region','ap-shanghai','--config-file',configInput.path,'--dir',path.join(prep.packageDir,sub),'--runtime','Nodejs20.19','--install-dependency','true','--deployMode','zip','--json','--force'];
  console.log(JSON.stringify({stage,mode}));
  const d=await c.spawnBounded(c.FIXED.nodeBin,[c.FIXED.cliEntry,...args],{cwd:path.dirname(configInput.path),env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn:(...args)=>{report.deployCalls++;return require('node:child_process').spawn(...args);}});
  report.deploymentProcess={exitCode:d.code,spawnError:Boolean(d.spawnError),timedOut:d.timedOut,overflow:d.overflow,closeNotObserved:Boolean(d.closeNotObserved),processExited:d.processExited,terminationRequested:d.terminationRequested,terminationConfirmed:d.terminationConfirmed};
  // 即使退出不明确也先回读，禁止盲目重发。
  const config=await api('GetFunction',{FunctionName:NAME,Namespace:ENV,ShowCode:'FALSE'});
  report.config={};
  for(const [k,v] of Object.entries({FunctionName:NAME,Namespace:ENV,Runtime:'Nodejs20.19',MemorySize:256,Timeout:3,Type:'Event',Handler:'index.main',Status:'Active'})){
   report.config[k]={matched:config[k]===v,expected:v};assert.equal(config[k],v);
  }
  const addr=await api('GetFunctionAddress',{FunctionName:NAME,Namespace:ENV});
  assert(typeof addr.CodeSha256==='string'&&/^[a-f0-9]{64}$/.test(addr.CodeSha256));
  const url=new URL(addr.Url);assert(url.protocol==='https:'&&!url.username&&!url.password&&/(?:\.myqcloud\.com|\.tencentcloudapi\.com)$/.test(url.hostname));
  stage='download';console.log(JSON.stringify({stage}));o.assertCredentialFresh(s,Date.now());report.downloadAttempted=true;
  const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(55000)});assert(res.ok);
  let bytes=0;const chunks=[];for await(const b of res.body){bytes+=b.length;assert(bytes<=32*1024*1024);chunks.push(Buffer.from(b));}
  const zip=Buffer.concat(chunks);assert.equal(sha(zip),addr.CodeSha256);
  const artifactDir=path.join(path.dirname(prep.planPath),runId);fs.mkdirSync(artifactDir,{recursive:true});
  const dest=path.join(artifactDir,'remote.zip');fs.writeFileSync(dest,zip,{flag:'wx'});
  report.archive={path:dest,sha256:sha(zip),platformCodeSha256:addr.CodeSha256,bytes};
  report.status='REMOTE_ZIP_OBTAINED_VERIFICATION_PENDING';
 }catch(e){
  report.status=report.deployCalls?'DEPLOY_ATTEMPTED_READBACK_INCOMPLETE':'STOPPED_BEFORE_DEPLOY';report.stoppedStage=stage;
  report.errorClass=stage==='credentialFetch'?o.classifyFetchFailure(e):'EXECUTION_CHECK_FAILED';
  if(stage==='credentialFetch'){report.credentialFetchAttempted=typeof e.fetchAttempted==='boolean'?e.fetchAttempted:null;report.fetchDiagnostics=o.rebuildFetchDiagnostics(e.fetchDiagnostics||e.detail);}
  process.exitCode=1;
 }finally{
  report.finishedAt=new Date().toISOString();save(prefix+'.json',report);
  console.log(JSON.stringify({status:report.status,stoppedStage:report.stoppedStage||null,output:prefix+'.json'}));
 }
}
main().catch(()=>{console.error('LOCAL_PRECHECK_OR_EVIDENCE_SAVE_FAILED');process.exitCode=1;});
