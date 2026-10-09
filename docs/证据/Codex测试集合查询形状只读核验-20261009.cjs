'use strict';
// 一次性受审只读查询证据入口；不是产品代码、业务路由或初始化工具。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..');
const ENV='cloud1-d8gcq5ag39d847723',REGION='ap-shanghai';
const SDK_ROOT='C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
const SHA=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const PROJECT='p_'+ '0'.repeat(32),USER='u_'+'0'.repeat(40),SCHEDULE='s_'+'0'.repeat(32),DIGEST='0'.repeat(64);
const ord=(...fields)=>fields.map(field=>({field,direction:'asc'}));
const specs=[
 ['I01','users',{bindingCodeHash:DIGEST},[],'service.js:119'],
 ['I02','projects',{scope:'identity-test',status:'active'},[],'service.js:161'],
 ['I03','project_members',{userId:USER,status:'active'},[],'service.js:160'],
 ['I04','project_members',{projectId:PROJECT,status:'active'},ord('_id'),'schedule-service.js:417,554'],
 ['I05','invitations',{tokenHash:DIGEST},[],'service.js:247'],
 ['I06','invitations',{projectId:PROJECT,status:'requested'},[],'service.js:274'],
 ['I07','audit_events',{projectId:PROJECT},[{field:'createdAt',direction:'desc'}],'candidate I07: management audit query, not existing business page'],
 ['I08','schedules',{projectId:PROJECT},ord('createdAt','_id'),'schedule-service.js:448-456'],
 ['I09','schedules',{projectId:PROJECT,status:'active'},ord('createdAt','_id'),'schedule-service.js:448-456'],
 ['I10','schedules',{projectId:PROJECT,trade:'水电'},ord('createdAt','_id'),'schedule-service.js:448-456'],
 ['I11','schedules',{projectId:PROJECT,status:'active',trade:'水电'},ord('createdAt','_id'),'schedule-service.js:448-456'],
 ['I12','schedules',{projectId:PROJECT,workerUserId:USER,status:'active'},ord('_id'),'schedule-service.js:283-300'],
 ['I13','schedule_revisions',{scheduleId:SCHEDULE},ord('afterVersion'),'schedule-service.js:505-512']
].map(([id,collection,where,orderBy,source])=>({id,collection:'schtest_v1_'+collection,where,orderBy,limit:100,skip:0,source}));
const queries=specs.concat(specs.filter(x=>['I04','I08','I09','I10','I11','I12','I13'].includes(x.id)).map(x=>({...x,id:x.id+'-skip100',skip:100})));
const uuid=v=>typeof v==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(v)?v:null;
// 不暴露原始引用；只提供固定查询所需的只读链，不提供任何写方法。
function narrow(query){return Object.freeze({where:v=>narrow(query.where(v)),orderBy:(f,d)=>narrow(query.orderBy(f,d)),limit:n=>narrow(query.limit(n)),skip:n=>narrow(query.skip(n)),field:v=>narrow(query.field(v)),get:()=>query.get()});}
async function executeQueries(db,expiresAtMs,now=()=>Date.now()){
 const results=[];
 for(const spec of queries){
  const item={id:spec.id,status:'STARTED',count:null,requestId:null,startedAt:new Date().toISOString()};results.push(item);
  try{
   assert(Number.isFinite(expiresAtMs)&&expiresAtMs>now(),'EXPIRED');
   let q=narrow(db.collection(spec.collection)).where(spec.where);
   for(const o of spec.orderBy)q=q.orderBy(o.field,o.direction);
   q=q.limit(spec.limit).skip(spec.skip).field({_id:true});
   const start=now(),r=await q.get();item.elapsedMs=Math.max(0,now()-start);
   assert(expiresAtMs>now(),'EXPIRED');
   if(!r||r.code||r.errCode||r.error){item.status='READ_FAILED';break;}
   if(!Array.isArray(r.data)||r.data.length>100){item.status='SHAPE_UNCONFIRMED';break;}
   item.count=r.data.length;item.requestId=uuid(r.requestId);
   // 空测试集合出现数据时不保存数据内容、不扩大读取。
   if(item.count!==0){item.status='UNEXPECTED_NONEMPTY';break;}
   item.status='QUERY_SUCCEEDED_EMPTY';
  }catch(_){item.status='READ_OR_EXPIRY_FAILED';break;}
  finally{item.finishedAt=new Date().toISOString();}
 }
 return {results,expectedQueries:queries.length,executedGets:results.length,complete:results.length===queries.length&&results.every(x=>x.status==='QUERY_SUCCEEDED_EMPTY'),indexHitProven:false,nonemptySortingCorrectnessProven:false,writeOperationsInCode:0};
}
async function worker(){
 let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw Error('INPUT');}
 const p=JSON.parse(raw);raw='';
 assert(['secretId','secretKey','sessionToken'].every(k=>typeof p[k]==='string'&&p[k].length>0));assert(Number.isFinite(p.expiresAtMs)&&p.expiresAtMs>Date.now());
 const sdk=require(path.join(SDK_ROOT,'@cloudbase/node-sdk'));assert.equal(require(path.join(SDK_ROOT,'@cloudbase/node-sdk/package.json')).version,'2.10.0');assert.equal(require(path.join(SDK_ROOT,'@cloudbase/database/package.json')).version,'1.4.1');
 const db=sdk.init({env:ENV,region:REGION,secretId:p.secretId,secretKey:p.secretKey,sessionToken:p.sessionToken,debug:false}).database();
 const result=await executeQueries(db,p.expiresAtMs);process.stdout.write(JSON.stringify(result));
}
async function main(){
 assert(process.argv.length===3&&process.argv[2]==='--run-once');assert.equal(process.execArgv.length,0);
 assert(!Object.keys(process.env).some(k=>/^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE)$/i.test(k)&&process.env[k]));
 const expected={
  'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c',
  'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478',
  'miniapp/scripts/lib/cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
  'miniapp/cloudbase/schedule-sandbox-resources.candidate.json':'7a0284d5098375f6910c459fb0ddea3af179fe40876d98cd2807b5cd93a1620b',
  'miniapp/cloudfunctions/scheduleSandbox/vendor/service.js':'c5e93d81e0245471efb0bf681836cd94f796fbc6a5547b690d0298a7f6a89e55',
  'miniapp/cloudfunctions/scheduleSandbox/vendor/schedule-service.js':'da302a7412bb08ce03d18c8486081fcc1e786b2f07f2b3817250fbf88f69cbec'};
 for(const [f,h]of Object.entries(expected))assert.equal(SHA(path.join(ROOT,f)),h);
 const o=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs')),c=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
 assert.equal((await o.runLocalCheck()).status,'LOCAL_READY');
 const runId='codex-query-shapes-'+Date.now()+'-'+crypto.randomUUID(),output=path.join(__dirname,runId+'.json');
 fs.writeFileSync(path.join(__dirname,'Codex测试集合查询形状只读核验-20261009.started.json'),JSON.stringify({runId,output,at:new Date().toISOString()}),{flag:'wx'});
 const report={runId,envId:ENV,region:REGION,startedAt:new Date().toISOString(),queries,writeAuthorized:false,wrapperSha256:SHA(__filename),sourceHashes:{service:SHA(path.join(ROOT,'miniapp/cloudfunctions/scheduleSandbox/vendor/service.js')),schedule:SHA(path.join(ROOT,'miniapp/cloudfunctions/scheduleSandbox/vendor/schedule-service.js'))},status:'STARTED',limitations:['合成查询值并未创建项目、用户或安排。','I07为受控审计查询，非已有业务页。','service原无显式limit的查询加100上限；全部仅投影_id，不输出文档。','分页偏移是直接探测skip=100语法，并非有数据的分页连续性测试。','SDK内部网络重试数未单独观测；未实现包装层重试。','空结果成功不证明实际命中哪个索引、排序值正确、性能达标或唯一约束写入行为。']};
 try{
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}}),snapshot=f.snapshot;
  report.fetch={attempted:true,diagnostics:o.rebuildFetchDiagnostics(f.fetchDiagnostics)};
  const dir=o.createIsolationDir(runId,{});o.assertIsolationClean(dir);
  report.association=await o.runCliAssociation(snapshot,dir,{});assert(report.association.matched);
  o.assertCredentialFresh(snapshot,Date.now());
  let stdinFailed=false;
  const payload=JSON.stringify({secretId:snapshot.secretId,secretKey:snapshot.secretKey,sessionToken:snapshot.sessionToken,expiresAtMs:snapshot.expiresAtMs});
  const r=await c.spawnBounded(c.FIXED.nodeBin,[__filename,'--worker'],{cwd:dir,env:{PATH:'',SystemRoot:process.env.SystemRoot||'C:/Windows'},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']},{spawn:(bin,args,opts)=>{const child=require('node:child_process').spawn(bin,args,opts);child.stdin.on('error',()=>{stdinFailed=true;});try{child.stdin.end(payload,'utf8');}catch(_){stdinFailed=true;}return child;}});
  report.workerExit={code:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:r.closeNotObserved,spawnFailed:!!r.spawnError,stdinFailed};
  o.assertCredentialFresh(snapshot,Date.now());assert(!stdinFailed&&!r.spawnError&&r.code===0&&!r.signal&&!r.timedOut&&!r.overflow&&!r.closeNotObserved);
  const parsed=JSON.parse(r.stdout);assert(Array.isArray(parsed.results)&&parsed.results.length<=queries.length);
  const statuses=new Set(['QUERY_SUCCEEDED_EMPTY','READ_FAILED','SHAPE_UNCONFIRMED','UNEXPECTED_NONEMPTY','READ_OR_EXPIRY_FAILED']);
  report.results=parsed.results.map((x,i)=>{assert.equal(x.id,queries[i].id);assert(statuses.has(x.status));return {id:x.id,status:x.status,count:Number.isSafeInteger(x.count)&&x.count>=0&&x.count<=100?x.count:null,requestId:uuid(x.requestId),elapsedMs:typeof x.elapsedMs==='number'&&Number.isFinite(x.elapsedMs)?x.elapsedMs:null};});
  report.status=report.results.length===queries.length&&report.results.every(x=>x.status==='QUERY_SUCCEEDED_EMPTY')?'ALL_QUERIES_SUCCEEDED_EMPTY':'QUERY_VALIDATION_INCOMPLETE';
 }catch(_){report.status='INCOMPLETE';report.errorClass='READONLY_RUN_NOT_CONFIRMED';}
 report.finishedAt=new Date().toISOString();report.dependenciesUnchanged=Object.entries(expected).every(([f,h])=>SHA(path.join(ROOT,f))===h);
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({evidence:output,status:report.status,results:report.results||[],dependenciesUnchanged:report.dependenciesUnchanged}));
}
module.exports={queries,executeQueries,narrow};
if(require.main===module){(process.argv.length===3&&process.argv[2]==='--worker'?worker():main()).catch(()=>{process.stderr.write('READONLY_QUERY_STOPPED');process.exitCode=1;});}
