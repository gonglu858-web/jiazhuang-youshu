'use strict';
// 本次审查专用：固定四条主键读取；无业务路由、事务或写库方法。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),ENV='cloud1-d8gcq5ag39d847723',APP='wxfb4db1615ac15531';
const TARGET='u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4';
const SDK='C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
const specs=[['oldPrimary','app_admins','primary',false],['oldUser','users',TARGET,true],['testUser','schtest_v1_users',TARGET,true],['testPrimary','schtest_v1_app_admins','primary',false]];
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(v)?v:null;
function project(r,s){
 const out={id:s[0],collection:s[1],key:s[2],status:'UNCONFIRMED',active:null,keyMatches:null,targetMatches:null,openidDerivationMatches:null,requestId:uuid(r&&r.requestId)};
 if(!r||r.code||r.errCode||r.error||!Array.isArray(r.data)||r.data.length>1)return out;
 if(!r.data.length){out.status='NOT_FOUND';return out;}
 const row=r.data[0];if(!row||typeof row!=='object'||Array.isArray(row))return out;
 out.status='OBSERVED';out.keyMatches=row._id===s[2];out.active=row.status==='active';
 if(s[3]){out.targetMatches=row._id===TARGET;out.openidDerivationMatches=typeof row.openid==='string'&&row.openid.length>0&&'u_'+crypto.createHash('sha256').update(APP+':'+row.openid).digest('hex').slice(0,40)===TARGET;}
 else out.targetMatches=row.userId===TARGET;
 return out;
}
async function readFour(db,expiresAtMs){
 const results=[];
 for(const s of specs){
  assert(Number.isFinite(expiresAtMs)&&expiresAtMs>Date.now());
  let r;try{r=await db.collection(s[1]).doc(s[2]).field(s[3]?{_id:true,status:true,openid:true}:{_id:true,userId:true,status:true}).get();}catch(_){results.push({...project(null,s),status:'READ_FAILED'});break;}
  assert(expiresAtMs>Date.now());const v=project(r,s);results.push(v);if(v.status==='UNCONFIRMED')break;
 }
 return results;
}
async function worker(){
 let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>16384)throw Error('INPUT');}
 const p=JSON.parse(raw);raw='';assert(['secretId','secretKey','sessionToken'].every(k=>typeof p[k]==='string'&&p[k]));
 assert.equal(require(path.join(SDK,'@cloudbase/node-sdk/package.json')).version,'2.10.0');
 assert.equal(require(path.join(SDK,'@cloudbase/database/package.json')).version,'1.4.1');
 const db=require(path.join(SDK,'@cloudbase/node-sdk')).init({env:ENV,region:'ap-shanghai',secretId:p.secretId,secretKey:p.secretKey,sessionToken:p.sessionToken,debug:false}).database();
 process.stdout.write(JSON.stringify(await readFour(db,p.expiresAtMs)));
}
async function main(){
 assert(process.argv.length===3&&process.argv[2]==='--run-once');assert.equal(process.execArgv.length,0);
 assert(!Object.keys(process.env).some(k=>/^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE)$/i.test(k)&&process.env[k]));
 const expected={
 'cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c',
 'cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478',
 'cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb'};
 const lib=path.join(ROOT,'miniapp/scripts/lib');for(const [f,h]of Object.entries(expected))assert.equal(sha(path.join(lib,f)),h);
 const o=require(path.join(lib,'cloudbase-sdk-readonly-observer.cjs')),c=require(path.join(lib,'cloudbase-readonly-observer.cjs'));
 assert.equal((await o.runLocalCheck()).status,'LOCAL_READY');
 const runId='codex-primary-target-'+Date.now()+'-'+crypto.randomUUID(),output=path.join(__dirname,runId+'.json');
 fs.writeFileSync(path.join(__dirname,'Codex首次管理员目标只读核对-20261009.started.json'),JSON.stringify({runId,output,at:new Date().toISOString()}),{flag:'wx'});
 const report={runId,envId:ENV,appId:APP,targetUserId:TARGET,startedAt:new Date().toISOString(),wrapperSha256:sha(__filename),writeAuthorized:false,status:'STARTED',limitations:['四次读取非原子快照。','派生一致仅证明存储身份一致，不独立证明现实操作者归属。','SDK底层重试未单独计数；包装层不重试。','本脚本只有固定get；不能证明写权限或真实事务行为。']};
 try{
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}}),p=f.snapshot;
  report.fetch={diagnostics:o.rebuildFetchDiagnostics(f.fetchDiagnostics)};
  const dir=o.createIsolationDir(runId,{});o.assertIsolationClean(dir);
  report.association=await o.runCliAssociation(p,dir,{});assert(report.association.matched);o.assertCredentialFresh(p,Date.now());
  let inputFailed=false;
  const payload=JSON.stringify({secretId:p.secretId,secretKey:p.secretKey,sessionToken:p.sessionToken,expiresAtMs:p.expiresAtMs});
  const r=await c.spawnBounded(c.FIXED.nodeBin,[__filename,'--worker'],{cwd:dir,env:{PATH:'',SystemRoot:process.env.SystemRoot||'C:/Windows'},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']},{spawn:(b,a,opt)=>{const ch=require('node:child_process').spawn(b,a,opt);ch.stdin.on('error',()=>{inputFailed=true;});try{ch.stdin.end(payload);}catch(_){inputFailed=true;}return ch;}});
  report.workerExit={code:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:r.closeNotObserved,spawnFailed:!!r.spawnError,inputFailed};
  o.assertCredentialFresh(p,Date.now());assert(!inputFailed&&!r.spawnError&&r.code===0&&!r.signal&&!r.timedOut&&!r.overflow&&!r.closeNotObserved);
  const rows=JSON.parse(r.stdout);assert(Array.isArray(rows)&&rows.length<=4);
  report.results=rows.map((v,i)=>{assert(v.id===specs[i][0]);assert(['UNCONFIRMED','NOT_FOUND','OBSERVED','READ_FAILED'].includes(v.status));const out={id:v.id,collection:specs[i][1],key:specs[i][2],status:v.status,requestId:uuid(v.requestId)};for(const k of ['active','keyMatches','targetMatches','openidDerivationMatches'])out[k]=typeof v[k]==='boolean'?v[k]:null;return out;});
  report.status=rows.length===4&&rows.every(v=>['NOT_FOUND','OBSERVED'].includes(v.status))?'RECORD_OBSERVATIONS_OBTAINED':'INCOMPLETE';
 }catch(_){report.status='INCOMPLETE';report.errorClass='READONLY_RUN_NOT_CONFIRMED';}
 report.finishedAt=new Date().toISOString();report.dependenciesUnchanged=Object.entries(expected).every(([f,h])=>sha(path.join(lib,f))===h);
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({evidence:output,status:report.status,results:report.results||[],dependenciesUnchanged:report.dependenciesUnchanged}));
}
module.exports={project,readFour,specs};
if(require.main===module)(process.argv[2]==='--worker'?worker():main()).catch(()=>{process.stderr.write('TARGET_READONLY_STOPPED');process.exitCode=1;});
