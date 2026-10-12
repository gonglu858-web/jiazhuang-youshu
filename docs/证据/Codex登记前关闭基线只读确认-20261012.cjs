'use strict';
// 仅身份/环境关联及SCF配置和代码摘要读取；无部署/函数调用/数据库写入。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 assert(process.argv.length===2&&process.execArgv.length===0);
 const pins={'cloudbase-cli-credential-host.cjs':'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c','cloudbase-sdk-readonly-observer.cjs':'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478','cloudbase-readonly-observer.cjs':'3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb'};
 for(const [n,h]of Object.entries(pins))assert.equal(sha(fs.readFileSync(path.join(ROOT,'miniapp/scripts/lib',n))),h);
 const o=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs')),c=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
 const prior=JSON.parse(fs.readFileSync(path.join(__dirname,'codex-self-closed-1791717637828-a8f4af43-1684-4b0b-9d3c-0493bd5f079b.verified.json'),'utf8'));
 assert.equal(prior.matched,8);assert.equal(prior.archiveSha256,'69891172866cc5b95d9bac52c31a8574163afa1566211ff91c41758f22325a65');
 const output=path.join(__dirname,'Codex登记前关闭基线只读确认-20261012.json');assert(!fs.existsSync(output));
 const runId='codex-closed-observe-'+Date.now()+'-'+crypto.randomUUID();
 fs.writeFileSync(path.join(__dirname,'Codex登记前关闭基线只读确认-20261012.started.json'),JSON.stringify({runId,startedAt:new Date().toISOString()})+'\n',{flag:'wx'});
 const report={runId,startedAt:new Date().toISOString(),scriptSha256:sha(fs.readFileSync(__filename)),status:'INCOMPLETE',writeAuthorized:false,deploymentAttempts:0,businessInvocations:0,stages:[]};
 try{
  assert.equal((await o.runLocalCheck()).status,'LOCAL_READY');const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}}),s=f.snapshot,dir=o.createIsolationDir(runId,{});o.assertIsolationClean(dir);
  report.association=await o.runCliAssociation(s,dir,{});assert(report.association.matched);const env=o.buildIsolatedEnv(process.env,s,dir);
  async function api(action,body){o.assertCredentialFresh(s,Date.now());const stage={key:action,service:'scf',action,apiVersion:'2018-04-16',body:JSON.stringify(body),envArgs:['-e','cloud1-d8gcq5ag39d847723']};const r=await c.spawnBounded(c.FIXED.nodeBin,[c.FIXED.cliEntry,...c.buildStageArgs(stage)],{cwd:dir,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn:require('node:child_process').spawn});report.stages.push({action,exitCode:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:r.closeNotObserved,spawnFailed:!!r.spawnError});assert(r.code===0&&!r.signal&&!r.spawnError&&!r.timedOut&&!r.overflow&&!r.closeNotObserved);o.assertCredentialFresh(s,Date.now());return c.parseCliJson(r.stdout,'scf',action,action);}
  const expected={FunctionName:'scheduleSandbox',Namespace:'cloud1-d8gcq5ag39d847723',Runtime:'Nodejs20.19',MemorySize:256,Timeout:3,Type:'Event',Handler:'index.main',Status:'Active'};
  const d=await api('GetFunction',{FunctionName:expected.FunctionName,Namespace:expected.Namespace,ShowCode:'FALSE'});for(const [k,v]of Object.entries(expected))assert.equal(d[k],v);report.functionDetail=expected;
  const a=await api('GetFunctionAddress',{FunctionName:expected.FunctionName,Namespace:expected.Namespace});assert.equal(a.CodeSha256,prior.archiveSha256);report.remoteCodeSha256=a.CodeSha256;report.matchesPreviouslyVerifiedClosedArchive=true;report.status='CLOSED_BASELINE_CONFIRMED';
 }catch(_){report.status='INCOMPLETE';report.errorClass='READONLY_CHECK_NOT_CONFIRMED';}
 report.finishedAt=new Date().toISOString();report.limitations=['本轮只读平台摘要匹配上次已核验八文件的关闭ZIP，未重新下载ZIP。','不证明无在途请求或数据库状态；未调用业务函数。'];fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,status:report.status,remoteCodeSha256:report.remoteCodeSha256,stages:report.stages}));
}
main().catch(()=>{console.error('CLOSED_READONLY_PRECHECK_OR_SAVE_FAILED');process.exitCode=1;});
