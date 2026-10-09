'use strict';
// 一次性只读审查；只允许列明的计费/用量查询，无写API、记录读取或自动重试。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expected={
 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478',
 'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c',
 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb'
};
const ENV='cloud1-d8gcq5ag39d847723';
const uuid=x=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(x)?x:null;
const small=x=>typeof x==='string'&&/^[\w\s\-.:/\u4e00-\u9fff]{0,120}$/.test(x)?x:null;
function pick(obj,keys){const out={};for(const k of keys){const v=obj?.[k];out[k]=typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)?v:small(v);}return out;}
async function main(){
 if(process.argv.length!==3||process.argv[2]!=='--run-once'||process.execArgv.length)throw Error('START');
 if(Object.keys(process.env).some(k=>/^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE)$/i.test(k)&&process.env[k]))throw Error('START');
 for(const [p,h] of Object.entries(expected))if(sha(path.join(ROOT,p))!==h)throw Error('HASH');
 const o=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
 const c=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
 if((await o.runLocalCheck()).status!=='LOCAL_READY')throw Error('LOCAL');
 const id='codex-resource-entitlements-'+Date.now()+'-'+crypto.randomUUID();
 const output=path.join(__dirname,id+'.json');
 fs.writeFileSync(path.join(__dirname,'Codex资源权益与TCB路由补查-20261009.started.json'),JSON.stringify({id,output,at:new Date().toISOString()}),{flag:'wx'});
 const report={kind:'RESOURCE_PREPARATION_BILLING_READONLY',startedAt:new Date().toISOString(),envId:ENV,writeAuthorized:false,
  wrapperSha256:sha(__filename),stages:[],observations:{},limitations:['用量值不自动等于剩余额度。','本次只读成功不证明创建/改规则/建索引的写权限。','官方凭据命令可能更新自己的登录缓存；未记录凭据原文。']};
 let current='fetch';
 try{
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}}),snapshot=f.snapshot;
  report.fetch={status:'FETCHED',diagnostics:o.rebuildFetchDiagnostics(f.fetchDiagnostics)};
  const dir=o.createIsolationDir(id,{});o.assertIsolationClean(dir);const env=o.buildIsolatedEnv(process.env,snapshot,dir);
  async function query(stage){
   current=stage.key||stage.action;o.assertCredentialFresh(snapshot,Date.now());
   const fact={action:stage.action,key:current,startedAt:new Date().toISOString(),validated:false};report.stages.push(fact);
   const r=await c.spawnBounded(c.FIXED.nodeBin,[c.FIXED.cliEntry,...c.buildStageArgs(stage)],{cwd:dir,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn:require('node:child_process').spawn});
   Object.assign(fact,{finishedAt:new Date().toISOString(),exitCode:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:r.closeNotObserved,spawnFailed:!!r.spawnError});
   o.assertCredentialFresh(snapshot,Date.now());
   if(r.spawnError||r.code!==0||r.signal||r.timedOut||r.overflow||r.closeNotObserved)throw Error('QUERY');
   const p=c.parseCliJson(r.stdout,stage.service,stage.action,current);fact.requestId=uuid(p.RequestId);return {p,fact};
  }
  let account,instance;
  for(const stage of c.STAGES){const {p,fact}=await query(stage);if(stage.key==='callerIdentity'){const v=c.assertSts(p,crypto,stage.key);account=v.accountIdSha256;report.identity={type:v.type,accountIdSha256:account,accountIdTail:v.accountIdTail};}else if(stage.key==='describeEnvs'){report.environment=c.assertDescribeEnvs(p,stage.key);instance=p.EnvList[0]?.Databases?.[0]?.InstanceId;if(typeof instance!=='string'||!/^tnt-[a-z0-9]+$/.test(instance))throw Error('INSTANCE');}else report.binding=c.assertDescribeEnvInfo(p,account,crypto,stage.key);fact.validated=true;}
  function limits(raw){
   if(typeof raw!=='string'||raw.length>16000)throw Error('LIMITS');const obj=JSON.parse(raw);
   const keys=new Set(['Qps','InvokeNum','Capacity','Cdn','Scf','Concurrency','OutFlux','MemoryUse','Flux','BackFlux','Credits','TimeUnit','Unit','MaxSize','Database','Storage','CollectionNum','IndexNum']);
   function walk(v,depth=0){if(depth>5)return null;if(v&&typeof v==='object'&&!Array.isArray(v)){const z={};for(const k of Object.keys(v))if(keys.has(k))z[k]=walk(v[k],depth+1);return z;}return typeof v==='number'&&Number.isFinite(v)?v:small(v);}
   return {values:walk(obj),availableTopLevelFields:Object.keys(obj).filter(k=>/^[a-zA-Z]{1,40}$/.test(k))};
  }
  const tasks=[
   {action:'DescribeBaasPackageList',body:{EnvId:ENV,PackageName:'baas_personal',Source:'miniapp'},parse:p=>{
    if(!Array.isArray(p.PackageList)||p.PackageList.length!==1||p.PackageList[0].PackageName!=='baas_personal')throw Error('SHAPE');const x=p.PackageList[0];return {...pick(x,['PackageName','PackageTitle','PackageType','UnitPrice']),ResourceLimit:limits(x.ResourceLimit)};}},
   {action:'DescribeCreditsUsageDetail',body:{EnvId:ENV,Modules:['FLEXDB'],StartDate:'2026-10-04',EndDate:'2026-10-09',NeedUsageDetails:false},parse:p=>{
    if(!Array.isArray(p.Usages))throw Error('SHAPE');return {usages:p.Usages.map(x=>{if(x.EnvId!==ENV||x.Module!=='FLEXDB')throw Error('SHAPE');return pick(x,['EnvId','Module','CreditsValue','DeductValue','PackageDeductValue','ReportValue']);})};}},
   {action:'ListTables',body:{EnvId:ENV,Tag:instance,MgoLimit:100,MgoOffset:0,ShowHidden:true},parse:p=>{
    if(!Array.isArray(p.Tables)||!Number.isSafeInteger(p.Pager?.Total)||p.Pager.Offset!==0||p.Pager.Limit!==100)throw Error('SHAPE');
    return {complete:p.Tables.length===p.Pager.Total,total:p.Pager.Total,returned:p.Tables.length,showHidden:true,tables:p.Tables.map(x=>pick(x,['TableName','Count','Size','IndexCount','IndexSize']))};}}
  ];
  for(const task of tasks){const key=task.key||task.action;
   try{const {p,fact}=await query({key,service:'tcb',action:task.action,apiVersion:'2018-06-08',body:JSON.stringify(task.body),envArgs:['-e',ENV]});report.observations[key]=task.parse(p);fact.validated=true;}
   catch(_){report.observations[key]={status:'UNCONFIRMED',reason:'QUERY_OR_SHAPE_NOT_CONFIRMED'};}
  }
  report.status='READONLY_QUERIES_FINISHED';
 }catch(_){report.status='INCOMPLETE';report.stoppedAt=current;}
 report.finishedAt=new Date().toISOString();report.dependenciesUnchanged=Object.entries(expected).every(([p,h])=>sha(path.join(ROOT,p))===h);
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({evidence:output,status:report.status,observations:report.observations},null,2));
}
if(require.main===module)main().catch(()=>{console.error('BILLING_REVIEW_START_OR_SAVE_FAILED');process.exitCode=1;});
