'use strict';
// 用户已明确批准关闭版；本脚本含唯一一次真实部署。独占 started 防止重跑。
// 不调用业务函数；原始输出、凭据和下载 URL 不写证据或 stdout。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),ENV='cloud1-d8gcq5ag39d847723',NAME='scheduleSandbox';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pins={
 'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c',
 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478',
 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb'};
const uuid=x=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(x)?x:null;
const facts=r=>({exitCode:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:r.closeNotObserved,spawnFailed:!!r.spawnError,processExited:r.processExited,terminationConfirmed:r.terminationConfirmed});
const completed=r=>r.code===0&&!r.signal&&!r.spawnError&&!r.timedOut&&!r.overflow&&!r.closeNotObserved;
async function main(){
 assert.deepEqual(process.argv.slice(2),['--approved-closed-once']);assert.equal(process.execArgv.length,0);
 for(const [p,h]of Object.entries(pins))assert.equal(sha(fs.readFileSync(path.join(ROOT,p))),h);
 const o=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
 const c=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
 const prep=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex关闭基线部署准备-20261011.json'),'utf8'));
 const cwd=path.join(ROOT,prep.artifactDir),fn=path.join(cwd,'cloudfunctions',NAME),config=path.join(cwd,'cloudbaserc.json');
 assert.equal(sha(fs.readFileSync(c.FIXED.cliEntry)),'328da4af4726c2aa4b20cf9b2e1a3614e4f22bf2e8fb8cb6d601692180de926b');
 assert.equal(sha(fs.readFileSync(path.resolve(c.FIXED.cliEntry,'../../dist/standalone/cli.js'))),prep.cliBundleSha256);
 function verify(){assert.equal(sha(fs.readFileSync(config)),prep.configSha256);for(const f of prep.files){assert.equal(sha(fs.readFileSync(path.join(fn,f.path))),f.sha256);assert.equal(sha(fs.readFileSync(path.join(ROOT,f.sourceKey))),f.sha256);}}
 verify();assert.equal((await o.runLocalCheck()).status,'LOCAL_READY');
 const runId='codex-closed-deploy-'+Date.now()+'-'+crypto.randomUUID(),output=path.join(__dirname,runId+'.json');
 fs.writeFileSync(path.join(__dirname,'Codex关闭基线单次部署-20261011.started.json'),JSON.stringify({runId,output,at:new Date().toISOString(),scope:'scheduleSandbox closed only'},null,2)+'\n',{flag:'wx'});
 const report={runId,startedAt:new Date().toISOString(),scriptSha256:sha(fs.readFileSync(__filename)),envId:ENV,functionName:NAME,authorizedScope:'CREATE_CLOSED_FUNCTION_AND_CLOUD_DEPENDENCIES_ONLY',deploymentAttempts:0,businessInvocations:0,stages:[],status:'INCOMPLETE'};
 let current='credential';
 try{
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}}),snapshot=f.snapshot;
  report.fetchDiagnostics=o.rebuildFetchDiagnostics(f.fetchDiagnostics);
  const dir=o.createIsolationDir(runId,{});o.assertIsolationClean(dir);
  report.association=await o.runCliAssociation(snapshot,dir,{});assert(report.association.matched);
  const env=o.buildIsolatedEnv(process.env,snapshot,dir);
  async function invoke(args,workdir,stage){
   o.assertCredentialFresh(snapshot,Date.now());const rec={stage,startedAt:new Date().toISOString()};report.stages.push(rec);
   const r=await c.spawnBounded(c.FIXED.nodeBin,[c.FIXED.cliEntry,...args],{cwd:workdir,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn:require('node:child_process').spawn});
   Object.assign(rec,facts(r),{finishedAt:new Date().toISOString()});o.assertCredentialFresh(snapshot,Date.now());return r;
  }
  async function api(action,body){
   const s={key:action,service:'scf',action,apiVersion:'2018-04-16',body:JSON.stringify(body),envArgs:['-e',ENV]};
   const r=await invoke(c.buildStageArgs(s),dir,action);assert(completed(r));return c.parseCliJson(r.stdout,'scf',action,action);
  }
  current='absenceCheck';
  const listed=await api('ListFunctions',{Namespace:ENV,Limit:100,Offset:0});
  assert(Array.isArray(listed.Functions));assert(Number.isInteger(listed.TotalCount)&&listed.TotalCount===listed.Functions.length&&listed.TotalCount<100);
  assert(listed.Functions.every(v=>typeof v.FunctionName==='string'));assert(!listed.Functions.some(v=>v.FunctionName===NAME));
  report.absence={confirmed:true,totalCount:listed.TotalCount,requestId:uuid(listed.RequestId)};
  verify();current='deployment';
  const args=['fn','deploy',NAME,'--env-id',ENV,'--region','ap-shanghai','--config-file',config,'--dir',fn,'--runtime','Nodejs20.19','--install-dependency','true','--deployMode','zip','--json'];
  report.deploymentAttempts=1;report.deploymentArgs=args;
  fs.writeFileSync(path.join(__dirname,runId+'.before-write.json'),JSON.stringify({runId,at:new Date().toISOString(),envId:ENV,functionName:NAME,args,configSha256:prep.configSha256,files:prep.files},null,2)+'\n',{flag:'wx'});
  const deployed=await invoke(args,cwd,'deploy');report.deploymentProcess= facts(deployed);
  // 任何部署返回后先只读核对，绝不重发部署；不把进程退出码当最终部署证据。
  current='readbackDetails';const detail=await api('GetFunction',{FunctionName:NAME,Namespace:ENV,ShowCode:'FALSE'});
  const keys=['FunctionName','Namespace','Runtime','MemorySize','Timeout','Type','Handler','Status','CodeSize','ModTime'];
  report.functionDetail=Object.fromEntries(keys.map(k=>[k,typeof detail[k]==='number'?detail[k]:typeof detail[k]==='string'&&/^[\w.:\- /]{0,100}$/.test(detail[k])?detail[k]:null]));
  report.functionDetail.requestId=uuid(detail.RequestId);
  assert.equal(detail.FunctionName,NAME);assert.equal(detail.Namespace,ENV);assert.equal(detail.Runtime,'Nodejs20.19');assert.equal(detail.MemorySize,256);assert.equal(detail.Timeout,3);assert.equal(detail.Type,'Event');assert.equal(detail.Handler,'index.main');assert.equal(detail.Status,'Active');
  current='downloadAddress';const address=await api('GetFunctionAddress',{FunctionName:NAME,Namespace:ENV});
  assert(typeof address.Url==='string');const url=new URL(address.Url);assert.equal(url.protocol,'https:');assert(!url.username&&!url.password);assert(/(?:\.myqcloud\.com|\.tencentcloudapi\.com)$/.test(url.hostname));
  current='downloadArchive';const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(55000)});assert(response.ok);
  const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;assert(bytes<=32*1024*1024);chunks.push(Buffer.from(chunk));}const archive=Buffer.concat(chunks);assert(archive.length>0);
  const dest=path.join(cwd,runId+'.remote.zip');fs.writeFileSync(dest,archive,{flag:'wx'});
  report.archive={path:path.relative(ROOT,dest),bytes,sha256:sha(archive),platformCodeSha256:typeof address.CodeSha256==='string'&&/^[a-f\d]{64}$/i.test(address.CodeSha256)?address.CodeSha256:null,requestId:uuid(address.RequestId)};
  report.status='REMOTE_ARCHIVE_OBTAINED_VERIFICATION_PENDING';
 }catch(e){report.stoppedAt=current;report.status=report.deploymentAttempts?'DEPLOYMENT_ATTEMPTED_READBACK_INCOMPLETE':'STOPPED_BEFORE_DEPLOYMENT';report.errorClass=e?.name==='AssertionError'?'CHECK_NOT_SATISFIED':'OPERATION_FAILED';}
 report.finishedAt=new Date().toISOString();report.dependenciesUnchanged=Object.entries(pins).every(([p,h])=>sha(fs.readFileSync(path.join(ROOT,p)))===h);
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,status:report.status,stoppedAt:report.stoppedAt,deploymentAttempts:report.deploymentAttempts,functionDetail:report.functionDetail,archive:report.archive,stages:report.stages},null,2));
}
if(require.main===module)main().catch(()=>{console.error('CLOSED_DEPLOY_START_OR_SAVE_FAILED');process.exitCode=1;});
