'use strict';
// 准备阶段只读主体摘要观测：无executeOnce、批准签发、worker、数据库或部署调用。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..');
const PINS={
  "sandbox-primary-execution-host.cjs": "dc1881e8d7daa8caf4dfa7ebb8c4f9e3deb49dc85fdc977c461ef13c054fad4b",
  "sandbox-primary-execution-worker.cjs": "c12b791f2ae653b28dfd530bc5d23aa7a8043c4cad4bef6619d574925ac7c6e8",
  "sandbox-primary-bootstrap.cjs": "133c21ae4b1081a1e716422862730d518a2194cc8620eb0956a9459a44765614",
  "sandbox-primary-sdk-adapter.cjs": "9088e6478b940a4c2db06737effbb9264f12fd1b62778e64cdb3990ef2ec9f1d",
  "cloudbase-cli-credential-host.cjs": "bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c",
  "cloudbase-sdk-readonly-observer.cjs": "f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478",
  "cloudbase-readonly-observer.cjs": "3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb"
};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 assert(process.argv.length===2&&process.execArgv.length===0);
 for(const [n,h] of Object.entries(PINS))assert.equal(hash(fs.readFileSync(path.join(ROOT,'miniapp/scripts/lib',n))),h);
 const o=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
 const h=require(path.join(ROOT,'miniapp/scripts/lib/sandbox-primary-execution-host.cjs'));
 const output=path.join(__dirname,'Codex管理员初始化准备主体只读核对-20261012.json');assert(!fs.existsSync(output));
 fs.writeFileSync(path.join(__dirname,'Codex管理员初始化准备主体只读核对-20261012.started.json'),JSON.stringify({startedAt:new Date().toISOString(),writeAuthorized:false})+'\n',{flag:'wx'});
 const report={startedAt:new Date().toISOString(),scriptSha256:hash(fs.readFileSync(__filename)),pins:PINS,status:'INCOMPLETE',writeAuthorized:false,approvalIssued:false,initializationAttempted:false,credentialFetchAttempted:false,subject:null};
 try{
  assert.equal((await o.runLocalCheck()).status,'LOCAL_READY');
  report.credentialFetchAttempted=true;
  const f=await o.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}}),s=f.snapshot;
  const dir=o.createIsolationDir('primary-preparation-'+Date.now()+'-'+crypto.randomUUID(),{});o.assertIsolationClean(dir);
  report.association=await o.runCliAssociation(s,dir,{});assert(report.association.matched);
  o.assertCredentialFresh(s,Date.now());
  const sub=await h.verifyCallerSubject(s,{spawn:require('node:child_process').spawn,baseEnv:process.env,isolationDir:dir});
  o.assertCredentialFresh(s,Date.now());assert(sub.ok&&/^[a-f0-9]{64}$/.test(sub.subjectDigest));
  report.subject={subjectDigest:sub.subjectDigest,accountIdSha256:sub.accountIdSha256,accountIdTail:sub.accountIdTail,requestId:typeof sub.requestId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sub.requestId)?sub.requestId:null};
  report.status='SUBJECT_OBSERVED_NOT_APPROVED';
 }catch(_){report.status='INCOMPLETE';report.errorClass='READONLY_SUBJECT_NOT_CONFIRMED';}
 report.finishedAt=new Date().toISOString();report.dependenciesUnchanged=Object.entries(PINS).every(([n,v])=>hash(fs.readFileSync(path.join(ROOT,'miniapp/scripts/lib',n)))===v);
 report.limitations=['此摘要是独立只读观测，不是批准名单；不得自动登记为预期主体。','之后需绑定具体写批准并重新比较；角色会话变化导致不符即停止，不自动刷新预期值。','未调用数据库、初始化或签发受控批准；未检查IAM写权限或费用。'];
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,status:report.status,subject:report.subject,dependenciesUnchanged:report.dependenciesUnchanged}));
}
main().catch(()=>{process.stderr.write('READONLY_PREPARATION_STOPPED');process.exitCode=1;});
