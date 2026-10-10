'use strict';
// 一次只读准备审查；不部署、不调用业务函数、不写数据库。凭据只在内存/私有管道及受审 CLI 子进程环境。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),ENV='cloud1-d8gcq5ag39d847723';
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pins={
 'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c',
 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478',
 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
 'docs/证据/Codex首次管理员目标只读核对-20261009.cjs':'8efffd3734ba66d87226d49e2cf5c50e374f8aad590089f13881724e5fe99ce1'
};
const uuid=x=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(x)?x:null;
function fields(v,keys){return Object.fromEntries(keys.map(k=>{const x=v?.[k];return[k,typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x)?x:typeof x==='string'&&/^[\w\s\-.:/\u4e00-\u9fff]{0,120}$/.test(x)?x:null];}));}
function exitFacts(r){return {exitCode:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:r.closeNotObserved,spawnFailed:!!r.spawnError};}
function completed(r){return !r.spawnError&&r.code===0&&!r.signal&&!r.timedOut&&!r.overflow&&!r.closeNotObserved;}
async function main(){
 assert.deepEqual(process.argv.slice(2),['--run-once']);assert.equal(process.execArgv.length,0);
 assert(!Object.keys(process.env).some(k=>/^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE)$/i.test(k)&&process.env[k]));
 for(const [p,h]of Object.entries(pins))assert.equal(sha(path.join(ROOT,p)),h);
 const o=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
 const c=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
 const targetWorker=path.join(ROOT,'docs/证据/Codex首次管理员目标只读核对-20261009.cjs');
 const {specs}=require(targetWorker);
 assert.equal((await o.runLocalCheck()).status,'LOCAL_READY');
 const runId='codex-registration-readonly-'+Date.now()+'-'+crypto.randomUUID(),output=path.join(__dirname,runId+'.json');
 fs.writeFileSync(path.join(__dirname,'Codex登记执行准备只读核对-20261010.started.json'),JSON.stringify({runId,output,at:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
 const report={runId,startedAt:new Date().toISOString(),scriptSha256:sha(__filename),envId:ENV,writeAuthorized:false,stages:[],observations:{},limitations:[
  '非原子分次观测；不证明现实微信操作者归属、写权限或平台事务。',
  'DbSizepkg 是容量用量；DbReadpkg/DbWritepkg 是平台该指标用量，不直接换算月剩余额度或余额。',
  '官方凭据获取可能刷新官方登录缓存；不保存凭据、原始响应和错误文本。',
  '包装层只取一批凭据、不重试；SDK内部请求重试未单独计数。'
 ]};
 let current='credential';
 try{
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}}),snapshot=f.snapshot;
  report.fetch={diagnostics:o.rebuildFetchDiagnostics(f.fetchDiagnostics)};
  const dir=o.createIsolationDir(runId,{});o.assertIsolationClean(dir);
  report.association=await o.runCliAssociation(snapshot,dir,{});assert(report.association.matched);
  o.assertCredentialFresh(snapshot,Date.now());current='fourRecords';
  let inputFailed=false;
  const input=JSON.stringify({secretId:snapshot.secretId,secretKey:snapshot.secretKey,sessionToken:snapshot.sessionToken,expiresAtMs:snapshot.expiresAtMs});
  const r=await c.spawnBounded(c.FIXED.nodeBin,[targetWorker,'--worker'],{cwd:dir,env:{PATH:'',SystemRoot:process.env.SystemRoot||'C:/Windows'},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']},{spawn:(b,a,opt)=>{const ch=require('node:child_process').spawn(b,a,opt);ch.stdin.on('error',()=>{inputFailed=true;});try{ch.stdin.end(input);}catch(_){inputFailed=true;}return ch;}});
  report.worker={...exitFacts(r),inputFailed};o.assertCredentialFresh(snapshot,Date.now());assert(!inputFailed&&completed(r));
  const rows=JSON.parse(r.stdout);assert(Array.isArray(rows)&&rows.length<=4);
  report.records=rows.map((v,i)=>{assert.equal(v.id,specs[i][0]);assert(['UNCONFIRMED','NOT_FOUND','OBSERVED','READ_FAILED'].includes(v.status));const p={id:v.id,collection:specs[i][1],key:specs[i][2],status:v.status,requestId:uuid(v.requestId)};for(const k of ['active','keyMatches','targetMatches','openidDerivationMatches'])p[k]=typeof v[k]==='boolean'?v[k]:null;return p;});
  const env=o.buildIsolatedEnv(process.env,snapshot,dir);
  const tasks=[
   {key:'billing',action:'DescribeBillingInfo',body:{EnvIds:[ENV],Limit:10,Offset:0},project:p=>{assert(Array.isArray(p.EnvBillingInfoList)&&p.EnvBillingInfoList.length===1);assert.equal(p.EnvBillingInfoList[0].EnvId,ENV);return fields(p.EnvBillingInfoList[0],['EnvId','PackageId','PackageName','PayMode','Status','ExpireTime','IsAutoRenew','EnableOverrun']);}},
   {key:'cycle',action:'DescribeEnvAccountCircle',body:{EnvId:ENV},project:p=>fields(p,['StartTime','EndTime'])},
   ...['DbSizepkg','DbReadpkg','DbWritepkg'].map(key=>({key,action:'DescribeQuotaData',body:{EnvId:ENV,MetricName:key},project:p=>{assert.equal(p.MetricName,key);assert(Number.isFinite(p.Value));return fields(p,['MetricName','Value','SubValue']);}}))
  ];
  for(const task of tasks){
   current=task.key;o.assertCredentialFresh(snapshot,Date.now());
   const fact={key:task.key,action:task.action,startedAt:new Date().toISOString(),validated:false};report.stages.push(fact);
   try{
    const stage={key:task.key,service:'tcb',action:task.action,apiVersion:'2018-06-08',body:JSON.stringify(task.body),envArgs:['-e',ENV]};
    const q=await c.spawnBounded(c.FIXED.nodeBin,[c.FIXED.cliEntry,...c.buildStageArgs(stage)],{cwd:dir,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn:require('node:child_process').spawn});
    Object.assign(fact,exitFacts(q));o.assertCredentialFresh(snapshot,Date.now());assert(completed(q));
    const p=c.parseCliJson(q.stdout,'tcb',task.action,task.key);report.observations[task.key]=task.project(p);fact.requestId=uuid(p.RequestId);fact.validated=true;
   }catch(_){report.observations[task.key]={status:'UNCONFIRMED'};}
   fact.finishedAt=new Date().toISOString();
  }
  report.status=report.records.length===4&&report.records.every(v=>['OBSERVED','NOT_FOUND'].includes(v.status))&&report.stages.every(v=>v.validated)?'READONLY_OBSERVATIONS_OBTAINED':'PARTIAL';
 }catch(_){report.status='INCOMPLETE';report.stoppedAt=current;}
 report.finishedAt=new Date().toISOString();report.dependenciesUnchanged=Object.entries(pins).every(([p,h])=>sha(path.join(ROOT,p))===h);
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,status:report.status,records:report.records||[],observations:report.observations,dependenciesUnchanged:report.dependenciesUnchanged},null,2));
}
if(require.main===module)main().catch(()=>{console.error('REGISTRATION_READONLY_START_OR_SAVE_FAILED');process.exitCode=1;});
