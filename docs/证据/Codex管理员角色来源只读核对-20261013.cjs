'use strict';
// 仅 STS/GetRole/STS，凭据与原始响应只留内存。默认本地检查，--observe 单次 wx 留证。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),LIB=path.join(ROOT,'miniapp/scripts/lib');
const BASE='Codex管理员稳定身份只读基线-20261013.json';
const BASE_HASH='8ac5c2a9bf60004f65933b48d3a8881a789f4dd30775e4d538c7730c305e3579';
const UNTIL=Date.parse('2026-10-13T04:00:00Z');
const stem=path.join(__dirname,'Codex管理员角色来源只读核对-20261013');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const field=x=>({sha256:hash(x),tail:x.slice(-4),length:x.length});
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x)?x:null;
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
function projectRole(payload,id){
  const r=payload.RoleInfo;
  if(!r||r.RoleId!==id.roleId||typeof r.PolicyDocument!=='string')fail('ROLE_RESPONSE_INVALID');
  const p=JSON.parse(r.PolicyDocument);
  if(!p||p.version!=='2.0'||!Array.isArray(p.statement))fail('ROLE_POLICY_INVALID');
  const statements=p.statement.map(s=>{
    if(!s||typeof s!=='object')fail('ROLE_POLICY_INVALID');
    const principal=s.principal&&typeof s.principal==='object'?s.principal:{};
    const qcs=Array.isArray(principal.qcs)?principal.qcs:[];
    const services=Array.isArray(principal.service)?principal.service:[];
    const actions=Array.isArray(s.action)?s.action:[s.action];
    return {effect:['allow','deny'].includes(s.effect)?s.effect:'UNKNOWN',
      actions:actions.map(a=>['sts:AssumeRole','name/sts:AssumeRole'].includes(a)?a:'OTHER'),
      conditionPresent:Object.hasOwn(s,'condition'),
      qcsPrincipals:qcs.map(v=>{
        if(typeof v!=='string')return {shape:'UNKNOWN'};
        const m=/^qcs::cam::uin\/(\d+):(root|uin\/\d+)$/.exec(v);
        return {sha256:hash(v),shape:m?'CAM_UIN':'UNKNOWN',
          account:m?field(m[1]):null,accountMatchesCaller:m?m[1]===id.accountId:null,
          accountMatchesPrincipal:m?m[1]===id.principalId:null};
      }),
      services:services.map(v=>typeof v==='string'&&/^[a-z0-9.-]+\.(?:qcloud\.com|tencentcloud\.com|cloud\.tencent\.com)$/.test(v)?v:'OTHER'),
      unrecognizedPrincipalKeys:Object.keys(principal).filter(k=>!['qcs','service'].includes(k)).length};
  });
  return {roleId:field(r.RoleId),roleIdMatchesCaller:true,
    roleName:typeof r.RoleName==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(r.RoleName)?r.RoleName:null,
    roleType:['system','service_linked','user'].includes(r.RoleType)?r.RoleType:'OTHER',
    policySha256:hash(r.PolicyDocument),statements,requestId:uuid(payload.RequestId),
    descriptionOmitted:true,trustApproved:false,principalSourceConfirmed:false};
}
async function main(){
  assert.equal(process.execArgv.length,0);
  assert(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--observe'));
  const b=fs.readFileSync(path.join(__dirname,BASE));assert.equal(hash(b),BASE_HASH);
  const baseline=JSON.parse(b),pins=baseline.pins;
  const checkPins=()=>Object.entries(pins).every(([n,h])=>hash(fs.readFileSync(path.join(LIB,n)))===h);
  assert(checkPins());
  const ro=require(path.join(LIB,'cloudbase-sdk-readonly-observer.cjs'));
  const cli=require(path.join(LIB,'cloudbase-readonly-observer.cjs'));
  const host=require(path.join(LIB,'sandbox-primary-execution-host.cjs'));
  const identity=require(path.join(LIB,'sandbox-identity-binding.cjs'));
  const ch=require(path.join(LIB,'cloudbase-cli-credential-host.cjs'));
  const spawn=require('node:child_process').spawn;
  assert.equal(host.realModeOfflineHarnessActive(),false);
  assert.equal((await ro.runLocalCheck()).status,'LOCAL_READY');
  if(process.argv.length===2){console.log(JSON.stringify({status:'LOCAL_READY',cloudQueryAttempted:false,plannedApis:['sts.GetCallerIdentity','cam.GetRole','sts.GetCallerIdentity']}));return;}
  assert(Date.now()<UNTIL);assert(!fs.existsSync(stem+'.json'));
  const report={schema:'role-source-observation/1',sourceCommit:'9d0638d',startedAt:new Date().toISOString(),
    baseline:{file:BASE,sha256:BASE_HASH},pins,scriptSha256:hash(fs.readFileSync(__filename)),status:'INCOMPLETE',stoppedAt:'credential',
    writeAuthorized:false,approvalIssued:false,workerStarted:false,databaseAttempted:false,initializationAttempted:false,
    roleTrustApproved:false,principalSourceConfirmed:false,credentialFetchFunctionInvocations:0,credentialCommandAttempted:false,
    apiExecutions:[],role:null};
  fs.writeFileSync(stem+'.started.json',JSON.stringify({startedAt:report.startedAt,scriptSha256:report.scriptSha256,
    authorization:'用户确认继续角色与PrincipalId来源只读核对；不包含管理员写入',plannedApis:['sts.GetCallerIdentity','cam.GetRole','sts.GetCallerIdentity'],writeAuthorized:false})+'\n',{flag:'wx'});
  let snapshot;
  const own=['ROLE_RESPONSE_INVALID','ROLE_POLICY_INVALID','ROLE_QUERY_FAILED','BASELINE_MISMATCH','SESSION_CHANGED','WINDOW_EXPIRED'];
  const codes=new Set([...own,...Object.values(ro.ERR),...Object.values(cli.ERR),...Object.values(host.ERR),...Object.values(ch.ERR),...Object.values(identity.ERR)]);
  const fresh=()=>{if(Date.now()>=UNTIL)fail('WINDOW_EXPIRED');ro.assertCredentialFresh(snapshot,Date.now());};
  try{
    report.credentialFetchFunctionInvocations++;
    let fetched;
    try{fetched=await ro.fetchTemporaryCredential({deps:{allowRealCredentialFetch:true}});}
    catch(e){report.credentialCommandAttempted=e.fetchAttempted===true;throw e;}
    report.credentialCommandAttempted=fetched.fetchAttempted===true;snapshot=Object.freeze(fetched.snapshot);fresh();
    const dir=ro.createIsolationDir('role-source-'+Date.now()+'-'+crypto.randomUUID(),{});ro.assertIsolationClean(dir);
    async function sts(stage){
      report.stoppedAt=stage;fresh();
      const s=await host.verifyCallerSubject(snapshot,{spawn,baseEnv:process.env,isolationDir:dir});
      report.apiExecutions.push({stage,action:'sts.GetCallerIdentity',attempted:s.attempted===true,ok:s.ok===true,errorCode:codes.has(s.errorCode)?s.errorCode:null});
      fresh();if(!s.ok)fail(codes.has(s.errorCode)?s.errorCode:'ROLE_QUERY_FAILED');
      const id=identity.parseCallerIdentity(s.stsData),stable=identity.stableIdentityDigest(s.stsData),session=identity.sessionDigest(s.stsData);
      report[stage]={stableIdentityDigest:stable,sessionDigest:session,requestId:uuid(s.requestId),matchesBaseline:stable===baseline.first.stableIdentityDigest};
      if(stable!==baseline.first.stableIdentityDigest)fail('BASELINE_MISMATCH');
      return {id,session};
    }
    const first=await sts('firstIdentity');
    report.stoppedAt='roleQuery';fresh();
    const args=['api','cam','GetRole','--api-version','2019-01-16','--body',JSON.stringify({RoleId:first.id.roleId}),'-r',cli.FIXED.region,'--json'];
    const call={stage:'roleQuery',action:'cam.GetRole',attempted:false,ok:false};report.apiExecutions.push(call);
    const r=await cli.spawnBounded(cli.FIXED.nodeBin,[cli.FIXED.cliEntry,...args],{cwd:dir,
      env:ro.buildIsolatedEnv(process.env,snapshot,dir),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']},
      {spawn:(...a)=>{call.attempted=true;return spawn(...a);},__limits:cli.LIMITS});
    Object.assign(call,{exitCode:r.code,signal:['SIGTERM','SIGKILL'].includes(r.signal)?r.signal:null,
      timedOut:r.timedOut,overflow:r.overflow,processExited:r.processExited,closeNotObserved:r.closeNotObserved,
      terminationRequested:r.terminationRequested,terminationConfirmed:r.terminationConfirmed,totalBytes:r.totalBytes,retainedBytes:r.retainedBytes});
    fresh();
    // 只记录固定诊断词是否出现在CLI输出；不将任意stderr解释为平台返回码。
    const text=String(r.stdout||'')+'\n'+String(r.stderr||'');
    call.diagnosticCodeTokens=['AuthFailure.UnauthorizedOperation','UnauthorizedOperation','InvalidParameter.RoleNotExist','InvalidParameter.ParamError'].filter(c=>text.includes(c));
    if(r.spawnError||r.code!==0||r.signal||r.timedOut||r.overflow||r.closeNotObserved||!r.processExited)fail('ROLE_QUERY_FAILED');
    const payload=cli.parseCliJson(r.stdout,'cam','GetRole','roleQuery');
    report.role=projectRole(payload,first.id);call.ok=true;
    const last=await sts('secondIdentity');
    report.sessionContinuityConfirmed=first.session===last.session;if(!report.sessionContinuityConfirmed)fail('SESSION_CHANGED');
    fresh();report.status='ROLE_DETAILS_OBSERVED_NOT_APPROVED';report.stoppedAt=null;
  }catch(e){report.errorCode=codes.has(e.code)?e.code:'ROLE_SOURCE_UNCONFIRMED';process.exitCode=1;}
  finally{snapshot=null;}
  report.finishedAt=new Date().toISOString();report.dependenciesUnchanged=checkPins();
  if(!report.dependenciesUnchanged){report.status='INCOMPLETE';report.errorCode='DEPENDENCY_DRIFT';process.exitCode=1;}
  report.limitations=['角色详情及信任策略不等于当前PrincipalId已获独立受信来源确认，也不代表IAM写权限',
    '一次凭据命令不等于一次内部网络请求；官方CLI可刷新并写回登录缓存，助手未直接读缓存内容',
    '没有数据库/worker/批准/初始化/登记/部署；政策条件仅记存在性，不推断整份策略生效结果',
    '原始响应/凭据/完整账号与RoleId不落盘；角色名称仅用于核对不是信任依据'];
  fs.writeFileSync(stem+'.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:report.status,errorCode:report.errorCode||null,stoppedAt:report.stoppedAt,output:stem+'.json',writeAuthorized:false}));
}
main().catch(()=>{process.stderr.write('ROLE_SOURCE_PRECHECK_OR_SAVE_FAILED\n');process.exitCode=1;});
