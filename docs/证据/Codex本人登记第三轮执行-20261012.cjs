'use strict';
// 仅本次已批准轮次：登记更新一次，随后关闭更新一次。无业务调用/初始化。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),ENV='cloud1-d8gcq5ag39d847723',NAME='scheduleSandbox',TARGET='u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4';
const prep=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex本人登记第三轮具体包准备-20261012.json'),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pins={'cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c','cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478','cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb'};
const facts=r=>({exitCode:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:r.closeNotObserved,spawnFailed:!!r.spawnError,processExited:r.processExited,terminationConfirmed:r.terminationConfirmed});
const complete=r=>r.code===0&&!r.signal&&!r.spawnError&&!r.timedOut&&!r.overflow&&!r.closeNotObserved;
async function main(){
 const mode=process.argv[2];assert(['registration','closed'].includes(mode)&&process.argv.length===3&&process.execArgv.length===0);
 for(const [p,h]of Object.entries(pins))assert.equal(sha(fs.readFileSync(path.join(ROOT,'miniapp/scripts/lib',p))),h);
 const o=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs')),c=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
 const config=prep.configs[mode],project=path.join(prep.assemblyDir,mode==='registration'?'registration-project':'closed-project'),fn=path.join(project,'cloudfunctions',NAME);
 function verify(){assert.equal(sha(fs.readFileSync(config.path)),config.sha256);for(const f of prep.files){assert.equal(sha(fs.readFileSync(path.join(prep.assemblyDir,f.path))),f.sha256);}}
 verify();assert.equal(sha(fs.readFileSync(c.FIXED.cliEntry)),'328da4af4726c2aa4b20cf9b2e1a3614e4f22bf2e8fb8cb6d601692180de926b');assert.equal(sha(fs.readFileSync(path.resolve(c.FIXED.cliEntry,'../../dist/standalone/cli.js'))),'8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97');
 if(mode==='registration'){
  assert(Date.parse(prep.plan.windowExpiresAt)-Date.now()>=15*60000);
  const asm=require(path.join(ROOT,'miniapp/scripts/assemble-sandbox-registration.cjs')),g=asm.installNetworkGuard({});
  try{const r=asm.checkAssembly({plan:prep.plan,inputDir:prep.inputDir,outDir:prep.assemblyDir,artifactKind:'real-candidate',networkGuard:g});assert(r.ok);}finally{asm.restoreNetworkGuard(g);}
 }
 const runId='codex-self-'+mode+'-'+Date.now()+'-'+crypto.randomUUID(),output=path.join(__dirname,runId+'.json');
 fs.writeFileSync(path.join(__dirname,'Codex本人登记第三轮执行-20261012.'+mode+'.started.json'),JSON.stringify({runId,output,at:new Date().toISOString(),roundId:prep.plan.roundId})+'\n',{flag:'wx'});
 const report={runId,mode,roundId:prep.plan.roundId,startedAt:new Date().toISOString(),scriptSha256:sha(fs.readFileSync(__filename)),deploymentAttempts:0,businessInvocations:0,stages:[],status:'INCOMPLETE'};let current='credential';
 try{
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}}),s=f.snapshot,dir=o.createIsolationDir(runId,{});o.assertIsolationClean(dir);
  report.association=await o.runCliAssociation(s,dir,{});assert(report.association.matched);const env=o.buildIsolatedEnv(process.env,s,dir);
  async function invoke(args,cwd,label){o.assertCredentialFresh(s,Date.now());const row={stage:label,startedAt:new Date().toISOString()};report.stages.push(row);const r=await c.spawnBounded(c.FIXED.nodeBin,[c.FIXED.cliEntry,...args],{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn:require('node:child_process').spawn});Object.assign(row,facts(r),{finishedAt:new Date().toISOString()});o.assertCredentialFresh(s,Date.now());return r;}
  async function api(action,body){const st={key:action,service:'scf',action,apiVersion:'2018-04-16',body:JSON.stringify(body),envArgs:['-e',ENV]},r=await invoke(c.buildStageArgs(st),dir,action);assert(complete(r));return c.parseCliJson(r.stdout,'scf',action,action);}
  async function records(){
   const sdk='C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/@cloudbase/node-sdk';assert.equal(require(path.join(sdk,'package.json')).version,'2.10.0');
   const db=require(sdk).init({env:ENV,region:'ap-shanghai',secretId:s.secretId,secretKey:s.secretKey,sessionToken:s.sessionToken,debug:false}).database();
   const four=await require('./Codex首次管理员目标只读核对-20261009.cjs').readFour(db,s.expiresAtMs);
   const audit={complete:false,rows:[],pages:0};
   for(let skip=0;skip<1000;skip+=100){o.assertCredentialFresh(s,Date.now());const r=await db.collection('schtest_v1_audit_events').where({actorUserId:TARGET,subjectUserId:TARGET,action:'registerIdentity'}).field({_id:true,projectId:true,actorUserId:true,subjectUserId:true,actorRole:true,action:true,createdAt:true,'after.status':true}).orderBy('_id','asc').skip(skip).limit(100).get();o.assertCredentialFresh(s,Date.now());assert(r&&!r.code&&!r.errCode&&Array.isArray(r.data));audit.pages++;for(const v of r.data){assert(typeof v._id==='string'&&/^a_[a-f0-9]+$/.test(v._id));assert(v.actorUserId===TARGET&&v.subjectUserId===TARGET&&v.action==='registerIdentity');audit.rows.push({id:v._id,projectIdNull:v.projectId===null,actorMatches:true,subjectMatches:true,action:'registerIdentity',afterStatusActive:v.after?.status==='active',createdAt:typeof v.createdAt==='number'?v.createdAt:typeof v.createdAt==='string'&&/^[\dT:Z.+-]+$/.test(v.createdAt)?v.createdAt:null});}if(r.data.length<100){audit.complete=true;break;}}
   return {at:new Date().toISOString(),four,audit};
  }
  if(mode==='registration'){
   current='closedBaseline';const a=await api('GetFunctionAddress',{FunctionName:NAME,Namespace:ENV});assert.equal(a.CodeSha256,'69891172866cc5b95d9bac52c31a8574163afa1566211ff91c41758f22325a65');report.closedBaselineSha256=a.CodeSha256;
   current='recordBaseline';report.recordsBefore=await records();const rr=report.recordsBefore.four;assert(rr.length===4&&rr.slice(0,2).every(v=>v.status==='OBSERVED'&&v.active&&v.keyMatches&&v.targetMatches)&&rr[1].openidDerivationMatches&&rr.slice(2).every(v=>v.status==='NOT_FOUND')&&report.recordsBefore.audit.complete&&report.recordsBefore.audit.rows.length===0);
   assert(Date.parse(prep.plan.windowExpiresAt)-Date.now()>=15*60000);
  }
  verify();current='deployment';const args=['fn','deploy',NAME,'--env-id',ENV,'--region','ap-shanghai','--config-file',config.path,'--dir',fn,'--runtime','Nodejs20.19','--install-dependency','true','--deployMode','zip','--json','--force'];
  fs.writeFileSync(path.join(__dirname,runId+'.before-write.json'),JSON.stringify({runId,roundId:prep.plan.roundId,at:new Date().toISOString(),mode,args,configSha256:config.sha256,recordsBefore:report.recordsBefore},null,2)+'\n',{flag:'wx'});
  report.deploymentAttempts=1;const d=await invoke(args,path.dirname(config.path),'deploy');report.deploymentProcess=facts(d);
  current='readback';const det=await api('GetFunction',{FunctionName:NAME,Namespace:ENV,ShowCode:'FALSE'});for(const [k,v]of Object.entries({FunctionName:NAME,Namespace:ENV,Runtime:'Nodejs20.19',MemorySize:256,Timeout:3,Type:'Event',Handler:'index.main',Status:'Active'}))assert.equal(det[k],v);
  report.functionDetail=Object.fromEntries(['FunctionName','Namespace','Runtime','MemorySize','Timeout','Type','Handler','Status'].map(k=>[k,det[k]]));
  const a=await api('GetFunctionAddress',{FunctionName:NAME,Namespace:ENV}),url=new URL(a.Url);assert(url.protocol==='https:'&&!url.username&&!url.password&&/(?:\.myqcloud\.com|\.tencentcloudapi\.com)$/.test(url.hostname));
  const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(55000)});assert(res.ok);let bytes=0;const chunks=[];for await(const b of res.body){bytes+=b.length;assert(bytes<=32*1024*1024);chunks.push(Buffer.from(b));}const zip=Buffer.concat(chunks);assert.equal(sha(zip),a.CodeSha256);const dest=path.join(path.dirname(config.path),runId+'.zip');fs.writeFileSync(dest,zip,{flag:'wx'});report.archive={path:dest,sha256:sha(zip),bytes,platformCodeSha256:a.CodeSha256};report.status='REMOTE_ZIP_OBTAINED_NEEDS_BYTE_VERIFICATION';
  if(mode==='closed'){current='recordsAfterClosure';report.recordsAfter=await records();}
 }catch(e){report.stoppedAt=current;report.status=report.deploymentAttempts?'DEPLOY_ATTEMPTED_NEEDS_READBACK':'STOPPED_BEFORE_DEPLOYMENT';report.errorClass=e?.name==='AssertionError'?'CHECK_NOT_SATISFIED':'OPERATION_FAILED';}
 report.finishedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,status:report.status,stoppedAt:report.stoppedAt,deploymentAttempts:report.deploymentAttempts,recordsBefore:report.recordsBefore,recordsAfter:report.recordsAfter,archive:report.archive,stages:report.stages},null,2));
}
if(require.main===module)main().catch(()=>{console.error('REGISTRATION_EXECUTION_PRECHECK_OR_SAVE_FAILED');process.exitCode=1;});
