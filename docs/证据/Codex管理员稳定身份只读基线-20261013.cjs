'use strict';
// 单次只读稳定身份观测：没有批准签发、executeOnce、worker、数据库或部署调用。
// 默认仅本地检查；--observe 执行已授权的单次观测；started/result 均 wx，禁止覆盖和自动重跑。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),LIB=path.join(ROOT,'miniapp/scripts/lib');
const PINS={
  "sandbox-primary-execution-host.cjs": "0c0b856a3cd56194047d49b742d3b506d1477b8661333b01f64daa7e8ee7bd58",
  "sandbox-primary-execution-worker.cjs": "c12b791f2ae653b28dfd530bc5d23aa7a8043c4cad4bef6619d574925ac7c6e8",
  "sandbox-primary-bootstrap.cjs": "133c21ae4b1081a1e716422862730d518a2194cc8620eb0956a9459a44765614",
  "sandbox-primary-sdk-adapter.cjs": "9088e6478b940a4c2db06737effbb9264f12fd1b62778e64cdb3990ef2ec9f1d",
  "sandbox-identity-binding.cjs": "c110a13deedcbcba426826ad45048a9a2b881bf700ed22a38fe9f3af02cc9a9a",
  "cloudbase-cli-credential-host.cjs": "bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c",
  "cloudbase-sdk-readonly-observer.cjs": "f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478",
  "cloudbase-readonly-observer.cjs": "3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb"
};
const HIST="Codex管理员主体差异只读核对-20261012.json",HIST_HASH='7edf5a015e3b7f3a65b5b0d0bdee19ccde9080b9bfeb3c60979eb4f29b079918';
const VALID_UNTIL=1791863215858;
const stem=path.join(__dirname,'Codex管理员稳定身份只读基线-20261013');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)?v:null;
const field=v=>({sha256:hash(v),tail:v.slice(-4),length:v.length});
async function main(){
 assert(process.execArgv.length===0);
 assert(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--observe'));
 for(const [n,h] of Object.entries(PINS))assert.equal(hash(fs.readFileSync(path.join(LIB,n))),h);
 assert.equal(hash(fs.readFileSync(path.join(__dirname,HIST))),HIST_HASH);
 const historical=JSON.parse(fs.readFileSync(path.join(__dirname,HIST),'utf8'));
 const ro=require(path.join(LIB,'cloudbase-sdk-readonly-observer.cjs'));
 const cli=require(path.join(LIB,'cloudbase-readonly-observer.cjs'));
 const host=require(path.join(LIB,'sandbox-primary-execution-host.cjs'));
 const identity=require(path.join(LIB,'sandbox-identity-binding.cjs'));
 const credentialHost=require(path.join(LIB,'cloudbase-cli-credential-host.cjs'));
 const spawn=require('node:child_process').spawn;
 assert.equal(host.realModeOfflineHarnessActive(),false);
 const ready=await ro.runLocalCheck();assert.equal(ready.status,'LOCAL_READY');
 if(process.argv.length===2){console.log(JSON.stringify({status:ready.status,readOnly:true,cloudObservationPerformed:false,plannedCredentialFetches:1,plannedExplicitApis:5}));return;}
 assert(Date.now()<VALID_UNTIL,'OBSERVATION_WINDOW_EXPIRED');
 assert(!fs.existsSync(stem+'.json'));
 const report={schema:'stable-identity-observation/1',sourceCommit:'523c9c6',reviewedImplementation:'e4ee7ee',
  startedAt:new Date().toISOString(),status:'INCOMPLETE',pins:PINS,scriptSha256:hash(fs.readFileSync(__filename)),
  writeAuthorized:false,approvalIssued:false,initializationAttempted:false,databaseAttempted:false,workerStarted:false,
  credentialFetchFunctionInvocations:0,credentialCommandAttempted:false,cloudQueryAttempted:false,stoppedAt:'credential',
  fixedTarget:{envId:cli.FIXED.envId,appId:cli.FIXED.wxAppId,region:cli.FIXED.region},
  credentialSource:'FIXED_CLI_AUTH_SESSION',bindingPolicyVersion:identity.BINDING_POLICY_VERSION,
  roleTrustApproved:false,principalSourceConfirmed:false,first:null,second:null,association:null,
  stableIdentityConsistent:false,sessionContinuityConfirmed:false,productionWorkerSameBatchProven:false};
 fs.writeFileSync(stem+'.started.json',JSON.stringify({startedAt:report.startedAt,scriptSha256:report.scriptSha256,pins:PINS,
  authorization:'用户确认开始下一步，沿用既有只读授权；不包含管理员写入',writeAuthorized:false})+'\n',{flag:'wx'});
 let snapshot=null;
 const fresh=()=>{assert(Date.now()<VALID_UNTIL,'OBSERVATION_WINDOW_EXPIRED');ro.assertCredentialFresh(snapshot,Date.now());};
 const allowedCodes=new Set([...Object.values(host.ERR),...Object.values(identity.ERR),...Object.values(credentialHost.ERR),...Object.values(ro.ERR)]);
 function project(sub){
   const id=identity.parseCallerIdentity(sub.stsData);
   return {type:id.type,stableIdentityDigest:identity.stableIdentityDigest(sub.stsData),sessionDigest:identity.sessionDigest(sub.stsData),
    tupleDigest:sub.subjectDigest,fields:{AccountId:field(id.accountId),PrincipalId:field(id.principalId),RoleId:field(id.roleId),Arn:field(id.arn)},
    requestId:uuid(sub.requestId)};
 }
 try{
   report.credentialFetchFunctionInvocations++;
   let fetched;
   try{fetched=await ro.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}});}
   catch(e){report.credentialCommandAttempted=e.fetchAttempted===true;throw e;}
   report.credentialCommandAttempted=fetched.fetchAttempted===true;
   snapshot=Object.freeze(fetched.snapshot);fresh();
   report.stoppedAt='isolation';
   const dir=ro.createIsolationDir('stable-baseline-'+Date.now()+'-'+crypto.randomUUID(),{});ro.assertIsolationClean(dir);
   async function getIdentity(stage){
     report.stoppedAt=stage;fresh();
     const sub=await host.verifyCallerSubject(snapshot,{spawn,baseEnv:process.env,isolationDir:dir});
     if(sub.attempted===true)report.cloudQueryAttempted=true;
     report[stage+'Call']={attempted:sub.attempted===true,ok:sub.ok===true,errorCode:allowedCodes.has(sub.errorCode)?sub.errorCode:null};
     fresh();if(!sub.ok){const e=new Error('IDENTITY_QUERY_FAILED');e.code=sub.errorCode;throw e;}
     return project(sub);
   }
   report.first=await getIdentity('firstIdentity');
   report.stoppedAt='association';fresh();
   report.association=await ro.runCliAssociation(snapshot,dir,{});fresh();
   assert.equal(report.association.matched,true);
   assert.equal(report.association.accountIdSha256,report.first.fields.AccountId.sha256);
   report.second=await getIdentity('secondIdentity');
   report.stableIdentityConsistent=report.first.stableIdentityDigest===report.second.stableIdentityDigest;
   report.sessionContinuityConfirmed=report.first.sessionDigest===report.second.sessionDigest;
   fresh();assert(report.stableIdentityConsistent&&report.sessionContinuityConfirmed);
   report.historicalComparison={reference:HIST,sha256:HIST_HASH,fields:{}};
   for(const k of ['AccountId','PrincipalId','Arn'])report.historicalComparison.fields[k]={fullHashEqual:report.first.fields[k].sha256===historical.subject.fields[k].sha256};
   report.historicalComparison.fullTupleEqual=report.first.tupleDigest===historical.subject.subjectDigest;
   report.historicalComparison.oldSessionDigestUnavailable=true;
   report.status='STABLE_IDENTITY_OBSERVED_NOT_APPROVED';report.stoppedAt=null;
 }catch(e){report.errorCode=allowedCodes.has(e.code)?e.code:'READONLY_BASELINE_UNCONFIRMED';process.exitCode=1;}
 finally{snapshot=null;}
 report.finishedAt=new Date().toISOString();
 report.dependenciesUnchanged=Object.entries(PINS).every(([n,h])=>hash(fs.readFileSync(path.join(LIB,n)))===h);
 if(!report.dependenciesUnchanged){report.status='INCOMPLETE';report.errorCode='DEPENDENCY_DRIFT';process.exitCode=1;}
 report.limitations=['独立只读观测，不是批准或允许名单；角色及PrincipalId受信来源仍须明确',
 '官方CLI可能内部查询、刷新并写回官方登录缓存；本轮未计量网络总请求数',
 '同批内存快照供CLI使用；未执行数据库worker，不证明生产worker自建db同批链',
 '未核实IAM写权限、数据库记录、平台事务、当前费用或前后端远端关闭指纹',
 '不保存原始身份、会话名、秘密或原始stdout；首次与末次完整摘要一致不代表原子快照'];
 fs.writeFileSync(stem+'.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:report.status,stoppedAt:report.stoppedAt,errorCode:report.errorCode||null,
  credentialCommandAttempted:report.credentialCommandAttempted,cloudQueryAttempted:report.cloudQueryAttempted,
  stableIdentityConsistent:report.stableIdentityConsistent,sessionContinuityConfirmed:report.sessionContinuityConfirmed,
  output:stem+'.json',writeAuthorized:false}));
}
main().catch(()=>{process.stderr.write('READONLY_BASELINE_PRECHECK_OR_SAVE_FAILED\n');process.exitCode=1;});
