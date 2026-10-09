'use strict';
// 固定环境一次性控制面只读审查，不调用数据库SDK记录读取，不创建资源。
// ListTables参数依据固定CLI DatabaseService：flexdb/2018-11-27，Tag来自当前DescribeEnvs。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expected={
 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478',
 'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c',
 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb'
};
const fixedEnv='cloud1-d8gcq5ag39d847723',target='schtest_v1_app_admins';
const onlySafeRequestId=x=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(x)?x:null;
async function main(){
 if(process.argv.length!==3||process.argv[2]!=='--run-once'||process.execArgv.length)throw Error('START_BLOCKED');
 if(Object.keys(process.env).some(k=>/^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE)$/i.test(k)&&process.env[k]))throw Error('START_BLOCKED');
 const fingerprints=Object.entries(expected).map(([p,h])=>{if(sha(path.join(ROOT,p))!==h)throw Error('HASH');return {path:p,sha256:h};});
 const o=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
 const c=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
 const local=await o.runLocalCheck();if(local.status!=='LOCAL_READY')throw Error('LOCAL');
 const runId='codex-collection-metadata-'+Date.now()+'-'+crypto.randomUUID();
 const output=path.join(__dirname,runId+'.json');
 fs.writeFileSync(path.join(__dirname,'Codex测试集合元数据只读核验-20261009.started.json'),JSON.stringify({runId,output,startedAt:new Date().toISOString()}),{flag:'wx'});
 const report={kind:'REAL_READONLY_COLLECTION_METADATA',runId,startedAt:new Date().toISOString(),envId:fixedEnv,
  targetCollection:target,wrapperSha256:sha(__filename),fingerprints,status:'INCOMPLETE',stages:[],
  writeAuthorized:false,recordReadsPerformed:false,credentialRawSaved:false,rawOutputsSaved:false,
  limitations:['清单是查询时点的元数据观测，不是历史存在性或业务记录快照。','未知错误不当作空集合。','未核验SDK读取权限、平台事务、费用或部署就绪。']};
 let currentStage='credentialFetch';
 try{
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}});
  const snapshot=f.snapshot;
  report.credentialFetch={status:'FETCHED',attempted:f.fetchAttempted===true,diagnostics:o.rebuildFetchDiagnostics(f.fetchDiagnostics),refreshDuringFetchObserved:null};
  const dir=o.createIsolationDir(runId,{});o.assertIsolationClean(dir);
  const env=o.buildIsolatedEnv(process.env,snapshot,dir);
  async function query(stage){
   currentStage=stage.action;o.assertCredentialFresh(snapshot,Date.now());
   const facts={service:stage.service,action:stage.action,startedAt:new Date().toISOString(),validated:false};report.stages.push(facts);
   const r=await c.spawnBounded(c.FIXED.nodeBin,[c.FIXED.cliEntry,...c.buildStageArgs(stage)],
    {cwd:dir,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn:require('node:child_process').spawn});
   Object.assign(facts,{finishedAt:new Date().toISOString(),exitCode:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,
    closeNotObserved:r.closeNotObserved,spawnFailed:!!r.spawnError,terminationConfirmed:r.terminationConfirmed});
   if(r.spawnError||r.timedOut||r.overflow||r.closeNotObserved||r.code!==0||r.signal)throw Error('PROCESS');
   o.assertCredentialFresh(snapshot,Date.now());
   const p=c.parseCliJson(r.stdout,stage.service,stage.action,stage.action);
   facts.requestId=onlySafeRequestId(p.RequestId);return {p,facts};
  }
  let accountDigest=null,instance=null;
  for(const stage of c.STAGES){
   const {p,facts}=await query(stage);
   if(stage.key==='callerIdentity'){
    const v=c.assertSts(p,crypto,stage.key);accountDigest=v.accountIdSha256;
    report.identity={type:v.type,accountIdSha256:v.accountIdSha256,accountIdTail:v.accountIdTail};
   }else if(stage.key==='describeEnvs'){
    report.environment=c.assertDescribeEnvs(p,stage.key);
    const dbs=p.EnvList[0].Databases;
    if(!Array.isArray(dbs)||dbs.length!==1||typeof dbs[0].InstanceId!=='string'||!/^tnt-[a-z0-9]+$/.test(dbs[0].InstanceId))throw Error('DATABASE_SHAPE');
    instance=dbs[0].InstanceId;report.databaseInstanceId=instance;
   }else report.environmentBinding=c.assertDescribeEnvInfo(p,accountDigest,crypto,stage.key);
   facts.validated=true;
  }
  if(!instance)throw Error('DATABASE_SHAPE');
  const stage={key:'listTables',service:'flexdb',action:'ListTables',apiVersion:'2018-11-27',
   body:JSON.stringify({Tag:instance,MgoLimit:100,MgoOffset:0}),envArgs:['-e',fixedEnv]};
  report.metadataQuery={service:stage.service,action:stage.action,apiVersion:stage.apiVersion,Tag:instance,MgoLimit:100,MgoOffset:0};
  const {p,facts}=await query(stage);
  // 不在异常里输出平台原始响应；保留字段存在性以识别不可下结论的情况。
  report.metadataShape={tablesArray:Array.isArray(p.Tables),tablesNull:p.Tables===null,
   pagerObject:!!p.Pager&&typeof p.Pager==='object',totalType:typeof p.Pager?.Total};
  if(!p.Pager||!Number.isSafeInteger(p.Pager.Total)||p.Pager.Total<0||p.Pager.Offset!==0||p.Pager.Limit!==100)throw Error('METADATA_SHAPE');
  const tables=p.Tables===null&&p.Pager.Total===0?[]:p.Tables;
  if(!Array.isArray(tables))throw Error('METADATA_SHAPE');
  const names=tables.map(t=>{
   if(!t||typeof t.TableName!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(t.TableName))throw Error('METADATA_SHAPE');
   return t.TableName;
  });
  if(new Set(names).size!==names.length||names.length>100||names.length>p.Pager.Total)throw Error('METADATA_SHAPE');
  const complete=names.length===p.Pager.Total;
  report.collections={names,total:p.Pager.Total,returned:names.length,complete,
   targetPresent:names.includes(target)?true:complete?false:null,
   targetStatus:names.includes(target)?'PRESENT':complete?'NOT_LISTED_IN_COMPLETE_CURRENT_RESULT':'UNCONFIRMED',
   prefixed:names.filter(n=>n.startsWith('schtest_v1_'))};
  facts.validated=true;report.status=complete?'METADATA_OBSERVED_COMPLETE':'METADATA_OBSERVED_PARTIAL';
 }catch(_){
  report.status='INCOMPLETE';report.stoppedAt=currentStage;report.errorClass='QUERY_OR_VALIDATION_NOT_CONFIRMED';
 }
 report.finishedAt=new Date().toISOString();
 report.codeUnchangedAfter=Object.entries(expected).every(([p,h])=>sha(path.join(ROOT,p))===h);
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 process.stdout.write(JSON.stringify({evidence:output,status:report.status,stoppedAt:report.stoppedAt||null,collections:report.collections||null,shape:report.metadataShape||null},null,2)+'\n');
}
if(require.main===module)main().catch(()=>{process.stderr.write('METADATA_REVIEW_START_OR_SAVE_FAILED\n');process.exitCode=1;});
