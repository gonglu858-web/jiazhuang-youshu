'use strict';
// 单次只读观测：一次凭据获取、三阶段关联、额外固定STS；无数据库/批准/初始化调用。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),lib=path.join(root,'miniapp/scripts/lib');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const stem=path.join(__dirname,'Codex管理员主体差异只读核对-20261012');
const report={startedAt:new Date().toISOString(),status:'INCOMPLETE',writeAuthorized:false,approvalIssued:false,
 initializationAttempted:false,databaseAttempted:false,credentialFetchAttempted:false,extraStsAttempted:false};
async function main(){
 assert.equal(process.argv.length,2);assert.equal(process.execArgv.length,0);
 const pins=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex管理员执行包窗口更新-20261012.json'),'utf8'));
 for(const f of pins.checkedFiles)assert.equal(sha(fs.readFileSync(path.resolve(root,f.path))),f.sha256,'指纹漂移');
 const historical=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex管理员初始化准备主体只读核对-20261012.json'),'utf8'));
 const ro=require(path.join(lib,'cloudbase-sdk-readonly-observer.cjs'));
 const cli=require(path.join(lib,'cloudbase-readonly-observer.cjs'));
 const host=require(path.join(lib,'sandbox-primary-execution-host.cjs'));
 const spawn=require('node:child_process').spawn;
 assert.equal(host.realModeOfflineHarnessActive(),false);
 assert.equal(fs.existsSync(stem+'.json'),false);
 fs.writeFileSync(stem+'.started.json',JSON.stringify({startedAt:report.startedAt,scriptSha256:sha(fs.readFileSync(__filename)),writeAuthorized:false})+'\n',{flag:'wx'});
 try{
  assert.equal((await ro.runLocalCheck()).status,'LOCAL_READY');
  report.credentialFetchAttempted=true;
  const fetched=await ro.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}});
  const snapshot=fetched.snapshot;
  const dir=ro.createIsolationDir('subject-difference-'+Date.now()+'-'+crypto.randomUUID(),{});ro.assertIsolationClean(dir);
  report.association=await ro.runCliAssociation(snapshot,dir,{});assert.equal(report.association.matched,true);
  ro.assertCredentialFresh(snapshot,Date.now());
  const stage=cli.STAGES.find(s=>s.key==='callerIdentity');assert.ok(stage);
  const env=ro.buildIsolatedEnv({},snapshot,dir);
  report.extraStsAttempted=true;
  const r=await cli.spawnBounded(cli.FIXED.nodeBin,[cli.FIXED.cliEntry,...cli.buildStageArgs(stage,cli.FIXED)],
   {cwd:dir,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},{spawn,__limits:cli.LIMITS});
  report.process={exitCode:r.code,signal:r.signal,timedOut:r.timedOut,overflow:r.overflow,closeNotObserved:r.closeNotObserved,processExited:r.processExited};
  assert.ok(!r.spawnError&&!r.timedOut&&!r.overflow&&!r.closeNotObserved&&!r.signal&&r.code===0);
  ro.assertCredentialFresh(snapshot,Date.now());
  const payload=cli.parseCliJson(r.stdout,stage.service,stage.action,'extraSts');
  const data=payload&&payload.data&&typeof payload.data==='object'?payload.data:payload;
  cli.assertSts(data,crypto,'extraSts');
  const fields={};for(const key of ['Type','AccountId','UserId','PrincipalId','Arn'])fields[key]={sha256:sha(data[key]),tail:data[key].slice(-4),length:data[key].length};
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  report.subject={type:data.Type,subjectDigest:host.callerTupleDigest(data),fields,requestId:uuid.test(data.RequestId)?data.RequestId:null};
  const oldSts=historical.association.stages.find(s=>s.stage==='sts').sts;
  report.historicalComparison={reference:'Codex管理员初始化准备主体只读核对-20261012.json',
   tupleEqual:report.subject.subjectDigest===historical.subject.subjectDigest,
   typeEqual:data.Type===oldSts.type,accountFullHashEqual:fields.AccountId.sha256===historical.subject.accountIdSha256,
   userIdTailEqual:fields.UserId.tail===oldSts.userIdTail,principalIdTailEqual:fields.PrincipalId.tail===oldSts.principalIdTail,
   historicalUserIdTail:oldSts.userIdTail,historicalPrincipalIdTail:oldSts.principalIdTail,
   userIdFullComparison:'UNAVAILABLE',principalIdFullComparison:'UNAVAILABLE',arnComparison:'UNAVAILABLE'};
  const cur=report.association.stages.find(s=>s.stage==='sts').sts;
  report.sameBatchComparison={accountFullHashEqual:cur.accountIdSha256===fields.AccountId.sha256,
   userIdTailEqual:cur.userIdTail===fields.UserId.tail,principalIdTailEqual:cur.principalIdTail===fields.PrincipalId.tail,
   fullTupleComparison:'UNAVAILABLE_FIRST_STS_IS_PROJECTED'};
  report.status='READONLY_DIFFERENCE_OBSERVED_NOT_APPROVED';
 }catch(_){report.errorClass='READONLY_SUBJECT_NOT_CONFIRMED';process.exitCode=1;}
 report.finishedAt=new Date().toISOString();
 report.dependenciesUnchanged=pins.checkedFiles.every(f=>sha(fs.readFileSync(path.resolve(root,f.path)))===f.sha256);
 report.limitations=['这是新的只读凭据批次，不能重建21:12失败时的完整原始响应','尾号相等不能证明字段完整相等；尾号不同能证明字符串不同',
  '不得自动替换批准预期；未验证IAM写权限、事务、费用或数据库记录','官方CLI内部刷新与请求次数未单独计量；没有主动再次获取凭据'];
 fs.writeFileSync(stem+'.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:report.status,subject:report.subject,comparison:report.historicalComparison,output:stem+'.json'}));
}
main().catch(()=>{process.stderr.write('READONLY_SUBJECT_PRECHECK_STOPPED\n');process.exitCode=1;});
