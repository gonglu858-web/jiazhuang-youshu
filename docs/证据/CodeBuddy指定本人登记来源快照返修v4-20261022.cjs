'use strict';
// S1/S2 来源快照定点返修证据（v4）。v1/v2/v3及Codex反例不改，另建本文件。
// 默认stdout，--out仅wx新建；先装守卫再加载业务。正常/敏感性分列，实际父出口决定ok/exit。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),SELF=__filename;
const shared=require(path.join(ROOT,'miniapp/tests/helpers/pic-guard-runner.cjs'));
const helper=require(path.join(ROOT,'miniapp/tests/helpers/psr-guard-runner.cjs'));
const hits=[];let phase='business';
const guarded=helper.installParentGuardsWithLocalTools({hits,getPhase:()=>phase,allowedScripts:[]});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const workerIndex=process.argv.indexOf('--worker');
const outIndex=process.argv.indexOf('--out');
const fault=workerIndex<0?null:process.argv[workerIndex+1];
function probes(){phase='probe';for(const f of [()=>require('node:https').request('https://example.invalid'),
  ()=>require('node:child_process').spawn('synthetic-blocked',[])]){try{f();}catch(_){}}phase='business';}
function verdict(){return shared.verdictFor({probes:hits.filter(h=>h.phase==='probe').length,
  parentUnexpected:hits.filter(h=>h.phase!=='probe').length,childUnexpectedTotal:0,receiptFailures:0});}
const sourceFiles=[
  'miniapp/scripts/lib/participant-self-registration.cjs',
  'miniapp/scripts/lib/participant-private-store.cjs','miniapp/scripts/lib/participant-local-tools.cjs',
  'miniapp/scripts/package-participant-self-registration.cjs','miniapp/scripts/participant-private-input.ps1',
  'miniapp/scripts/templates/participant-self-registration/server/scheduleSandbox/index.js',
  'miniapp/tests/participant-self-registration.test.cjs','miniapp/tests/helpers/psr-guard-runner.cjs',
  'miniapp/tests/helpers/psr-repair-fixtures.cjs','miniapp/tests/helpers/psr-sdk-fixture.cjs'
];
const ps1ReceiptRel='docs/证据/CodeBuddy指定登记PS1合成传输补验v4-20261022.json';
function facts(files){return files.map(rel=>{const b=fs.readFileSync(path.join(ROOT,rel));return{rel,bytes:b.length,sha256:sha(b)};});}
function loadBusiness(){
  const Module=require('node:module'),original=Module._load;
  Module._load=function(name,...rest){
    if(fault==='earlyRequire'&&String(name).endsWith('participant-private-store.cjs')){
      try{require('node:https').request('https://example.invalid');}catch(_){}
    }
    return original.call(this,name,...rest);
  };
  try{
    require(path.join(ROOT,'miniapp/scripts/lib/participant-private-store.cjs'));
    require(path.join(ROOT,'miniapp/scripts/package-participant-self-registration.cjs'));
  }finally{Module._load=original;}
}
function worker(){
  probes();loadBusiness();
  const cp=require('node:child_process');
  if(fault==='publicGit')try{cp.spawnSync('git',['ls-files'],{shell:true,env:{FAKE:'synthetic'}});}catch(_){}
  if(fault==='publicSpawn')try{cp.spawn('icacls',['C:\\synthetic-outside','/grant','Everyone:F']);}catch(_){}
  if(fault==='publicExec')try{cp.execFileSync(process.execPath,['-e','throw Error()']);}catch(_){}
  if(fault==='afterRestore'){guarded.restore();try{cp.spawnSync('git',['ls-files']);}catch(_){}}
  return {schema:'psr-v4-worker/1',fault,...verdict(),probes:hits.filter(h=>h.phase==='probe').length,
    unexpected:hits.filter(h=>h.phase!=='probe'),actualExternalToolExecutions:0};
}
async function main(){
  if(workerIndex>=0){if(!['normal',...helper.FAULTS].includes(fault))throw Error('未知worker');return worker();}
  if(process.argv.slice(2).length && !(outIndex===2&&process.argv.length===4))throw Error('仅支持--out新路径');
  probes();loadBusiness();
  const before=facts(sourceFiles);
  const dir=path.join(ROOT,'artifacts/schedule-sandbox/business-test');fs.mkdirSync(dir,{recursive:true});
  const directoryBefore=new Set(fs.readdirSync(dir));
  const tag='psr-v4-'+crypto.randomBytes(6).toString('hex');
  const preload=path.join(dir,tag+'-preload.cjs');fs.writeFileSync(preload,"'use strict';\n",{flag:'wx'});
  const temporaryFiles=[preload],guard=guarded.guard;
  async function run(scriptPath,args,group){
    const receiptPath=guard.newReceiptPath(tag);temporaryFiles.push(receiptPath);
    const r=await guard.runCli({scriptPath,args,guardPreload:preload,receiptPath,group});
    return r;
  }
  const suite=await run(path.join(ROOT,'miniapp/tests/participant-self-registration.test.cjs'),[],'normal');
  const tap=suite.out,counts={};
  for(const key of ['tests','pass','fail','skipped','cancelled']){
    const m=tap.match(new RegExp('^# '+key+' (\\d+)$','m'));counts[key]=m?Number(m[1]):null;
  }
  const testOK=suite.code===0&&suite.validation.failures.length===0&&counts.tests>0&&counts.pass===counts.tests&&counts.fail===0&&counts.skipped===0;
  const rows=Array.from(tap.matchAll(/^(not ok|ok) (\d+) - (.+)$/gm),m=>({passed:m[1]==='ok',number:Number(m[2]),name:m[3]}));
  // S1/S2 定点返修用例（名称前缀固定）：正常对照与等待期来源/计划变化反例的实测出口。
  const snapshotTests=rows.filter(r=>/^S[12][/ ]/.test(r.name));
  const sensitivity=[];
  for(const f of ['normal',...helper.FAULTS]){
    const r=await run(SELF,['--worker',f],f==='normal'?'normal':'sensitivity');
    let data;try{data=JSON.parse(r.out);}catch(_){data=null;}
    const expected=f==='normal'?0:1;
    sensitivity.push({fault:f,passed:r.code===expected&&r.validation.failures.length===0&&!!data&&
      data.ok===(f==='normal')&&data.probes===2&&data.unexpected.length===(f==='normal'?0:1),
      exitCode:r.code,worker:data,receiptValidation:r.validation});
  }
  assert.deepEqual(facts(sourceFiles),before,'测试后来源字节漂移');
  const tally=guard.summary('normal');
  const observed={probes:hits.filter(h=>h.phase==='probe').length,
    parentUnexpected:hits.filter(h=>h.phase!=='probe').length,
    childUnexpectedTotal:tally.childUnexpectedTotal,
    receiptFailures:tally.receiptFailures+(testOK?0:1)+sensitivity.filter(s=>!s.passed).length};
  const decision=shared.verdictFor(observed);
  const sdkBase=path.join(process.env.USERPROFILE,'.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules');
  const sdkFiles=['wx-server-sdk/index.js','@cloudbase/database/dist/commonjs/transaction/index.js'];
  for(const name of fs.readdirSync(dir)){
    if(!directoryBefore.has(name)&&name.endsWith('.cjs'))temporaryFiles.push(path.join(dir,name));
  }
  const ps1Receipt=JSON.parse(fs.readFileSync(path.join(ROOT,ps1ReceiptRel),'utf8'));
  return {schema:'participant-registration-local-evidence/4',executor:'本地页面开发（S1/S2来源快照定点返修）',
    baseline:'master e986728（受审 921b07e）',recordedAt:new Date().toISOString(),...decision,observed,
    tests:{...counts,exitCode:suite.code,rows,tapSha256:sha(Buffer.from(tap)),
      failures:suite.validation.failures,stderr:suite.err},
    snapshotRepair:{tests:snapshotTests,passed:snapshotTests.filter(r=>r.passed).length,total:snapshotTests.length,
      design:'计划与每份密文各只读一次形成快照；解密结果与其摘要同源；异步消费后写前复核计划字节与两份来源摘要，变化拒绝且零产物；Resolved检查共用同一计划快照。',
      storageApi:'readRecordSnapshotAsync（新增）；readRecordAsync/readAllRecordsAsync 保留原签名并改用快照。'},
    ps1Transport:{receipt:ps1ReceiptRel,receiptSha256:sha(fs.readFileSync(path.join(ROOT,ps1ReceiptRel))),
      executed:true,exitCode:ps1Receipt.exitCode,expected:ps1Receipt.counts.expected,actual:ps1Receipt.counts.actual,
      positionalMatch:ps1Receipt.positionalMatch,scriptSha256:ps1Receipt.script.sha256,nodeSha256:ps1Receipt.node.sha256,
      hostPolicy:ps1Receipt.host.executionPolicyProcessScope,
      note:'宿主shell已带Process作用域Bypass（本轮未改策略、未加Bypass参数）；成功只关闭PS1→Node参数边界，不外推UI/真实DPAPI/ACL。'},
    sensitivity,sourceFacts:before,
    runtimeFacts:sdkFiles.map(rel=>{const b=fs.readFileSync(path.join(sdkBase,rel));return{rel,bytes:b.length,sha256:sha(b)};}),
    boundaries:{syntheticInputOnly:true,realSdkConversion:true,transportAndContextSynthetic:true,
      actualPlatformTransactionVerified:false,realPrivateRecordsRead:0,aclMutations:0,gitIndexMutations:0,
      networkAttempts:observed.parentUnexpected+observed.childUnexpectedTotal,explicitProbes:observed.probes,
      actualCloudCalls:0,realRegistration:false,roleGrants:false,executionApproved:false,policyModified:false},
    unverified:[{item:'真实DPAPI管线、跨Windows账号、原生窗口人工体验',reason:'本轮只用合成私密记录；未触真实编号/认证缓存；PS1仅合成参数回显。'},
      {item:'受限执行策略机器上的PS1运行',reason:'本轮宿主Process作用域已为Bypass（继承），不据此推断默认Restricted主机可运行。'},
      {item:'IAM、平台事务/并发、登记、部署及P',reason:'未授权未执行；1/2号核验不重做。'}],
    disclosure:'真实应用代码及真实SDK包装/事务/EJSON，传输与数据为合成；不等于平台提交/原子性证明。ok由实测父出口决定，S1/S2用例计数来自TAP逐条结果。',
    evidenceScriptSha256:sha(fs.readFileSync(SELF)),temporaryFiles:Array.from(new Set(temporaryFiles)),
    temporaryFilesLifecycle:'运行后由本轮集中清理（仅本文件登记的preload/回执）',
    next:'本地自测通过待Codex复查，真实录入及执行未放行；S1/S2已定点返修，1/2号核验与P未重做。'};
}
main().then(result=>{
  const text=JSON.stringify(result,null,2)+'\n';
  if(outIndex>=0)fs.writeFileSync(path.resolve(process.argv[outIndex+1]),text,{flag:'wx'});
  process.stdout.write(text);process.exitCode=result.ok?0:1;
}).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:String(e.message),exitCode:1})+'\n');process.exitCode=1;});
