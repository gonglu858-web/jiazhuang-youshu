'use strict';
// Single authorized invocation, not a reusable administrative CLI.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const confirmationObservedAt='2026-10-13T13:40:03.310Z';
const deadline=Date.parse(confirmationObservedAt)+10*60*1000;
const stem=path.join(__dirname,'Codex管理员初始化v3单次执行-20261013');
const proofPath='docs/证据/Codex管理员初始化v3包本地核对-20261013.json';
const packagePath='docs/Codex执行包-管理员初始化v3自助核验-20261013.md';
const pins={
  [proofPath]:'9aaec0d29a9480d314e1f016b12f01c5301e891620da7fdbc54f73bddbfb802f',
  [packagePath]:'792f3121c8d88231a7d7faf20e9dd55ff0e77de023c6cdf4f2acd666cb914615',
  'docs/证据/Codex管理员初始化v3包本地核对-20261013.cjs':'153c38f4dd076c93f80cc91ffc8e39578f25a75b0a2183de0e0d4b082914c3a8'
};
let runOnceInvoked=false;
async function main(){
  assert.deepEqual(process.argv.slice(2),['--confirmed-v3-single-run']);
  assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_PATH);
  assert.ok(Date.now()<deadline,'Confirmation expired');
  for(const [p,h] of Object.entries(pins))assert.equal(sha(fs.readFileSync(path.resolve(root,p))),h);
  const proof=JSON.parse(fs.readFileSync(path.resolve(root,proofPath),'utf8'));
  assert.equal(proof.packageRevision,'primary-20261013-self-01-v3');
  for(const f of [...proof.implementationFiles,...proof.runtimeFiles,...proof.checkedSources,...proof.historicalEvidence])
    assert.equal(sha(fs.readFileSync(path.resolve(root,f.path))),f.sha256,'Pinned file changed');
  assert.equal(process.execPath.toLowerCase(),path.resolve(root,proof.runtimeFiles[0].path).toLowerCase());
  const tree=[];
  function walk(dir){for(const d of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    const p=path.join(dir,d.name);assert.equal(d.isSymbolicLink(),false);
    if(d.isDirectory())walk(p);else{assert.equal(d.isFile(),true);tree.push([path.relative(proof.sdkRoot,p).replace(/\\/g,'/'),sha(fs.readFileSync(p))]);}
  }}
  walk(proof.sdkRoot);assert.equal(tree.length,proof.sdkTreeFiles);assert.equal(sha(JSON.stringify(tree)),proof.sdkTreeSha256);
  const planBytes=fs.readFileSync(path.resolve(root,proof.planFile.path));assert.equal(sha(planBytes),proof.planFile.sha256);
  const plan=JSON.parse(planBytes);assert.deepEqual(plan,proof.plan);
  assert.equal(plan.roundId,'primary-20261013-self-01');
  assert.ok(Date.now()<Math.min(deadline,Date.parse(plan.expiresAt)));
  assert.equal(fs.existsSync(proof.outDir),false);
  for(const ext of ['authorized','result','exception'])assert.equal(fs.existsSync(stem+'.'+ext+'.json'),false);
  const lib=path.join(root,'miniapp/scripts/lib');
  const host=require(path.join(lib,'sandbox-primary-execution-host.cjs'));
  const entry=require(path.join(lib,'sandbox-primary-approved-run.cjs'));
  const p4=require(path.join(lib,'sandbox-primary-bootstrap.cjs'));
  assert.equal(host.realModeOfflineHarnessActive(),false);
  assert.deepEqual(entry.fullFingerprint(),proof.boundFingerprint);
  assert.equal(host.fullPlanDigestOf(plan),proof.fullPlanDigest);
  assert.equal(p4.auditId(plan,p4.inputDigest(plan)),proof.auditId);
  const approvedBy=proof.approvedByTemplate;
  const approval={approvedUserIds:[plan.targetUserId],approvedBy,approvedAt:confirmationObservedAt};
  p4.validatePlan(plan);p4.validateApprovalContext(approval);p4.assertApprovedTarget(approval,plan.targetUserId);
  const approvalExpiresAtMs=Math.min(deadline,Date.parse(plan.expiresAt));
  assert.ok(approvalExpiresAtMs-Date.now()>120000,'Insufficient remaining window');
  fs.writeFileSync(stem+'.authorized.json',JSON.stringify({
    packageRevision:proof.packageRevision,roundId:plan.roundId,confirmationText:'确认',
    confirmationContext:'Direct reply to assistant v3 execution package and its complete quoted confirmation scope.',
    confirmationObservedAt,confirmationTimeMeaning:'Assistant first local clock observation after receiving confirmation; not platform message timestamp.',
    approvedBy,approvalExpiresAt:new Date(approvalExpiresAtMs).toISOString(),
    planSha256:proof.planFile.sha256,packageSha256:pins[packagePath],proofSha256:pins[proofPath],
    alternativeBasisAccepted:true,authorizationBasis:proof.authorizationBasis,principalSourceConfirmed:false,
    bindingPolicyVersion:proof.bindingPolicyVersion,expectedStableIdentityDigest:proof.expectedStableIdentityDigest,
    runnerSha256:sha(fs.readFileSync(__filename)),writeScope:['initializePrimary'],
    invocationAt:new Date().toISOString(),noDependencyInjection:true,platformSuccessNotYetKnown:true
  },null,2)+'\n',{flag:'wx'});
  const approvalSource=host.issueControlledApproval({plan,approval,approvedBy,writeScope:['initializePrimary'],
    expiresAtMs:approvalExpiresAtMs,bindingPolicyVersion:proof.bindingPolicyVersion,
    expectedStableIdentityDigest:proof.expectedStableIdentityDigest,credentialSourceMode:'fixed-real-source'});
  runOnceInvoked=true;
  const result=await entry.runOnce({runId:plan.roundId,outDir:proof.outDir,plan,approvalSource,
    roundId:plan.roundId,credentialSourceMode:'fixed-real-source'});
  fs.writeFileSync(stem+'.result.json',JSON.stringify({finishedAt:new Date().toISOString(),...result},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:result.status,saved:result.saved,report:stem+'.result.json'}));
  if(result.status!=='COMPLETED')process.exitCode=1;
}
main().catch(e=>{
  const allowed=new Set(['APR_TERMINAL_SAVE_FAILED','APR_STARTED_EXISTS','APR_TERMINAL_EXISTS','APR_TERMINAL_DIR_CHECK_FAILED',
    'APR_STARTED_CREATE_FAILED','ERR_ASSERTION','EEXIST','EACCES','EIO','ENOENT']);
  const out={finishedAt:new Date().toISOString(),status:'STOPPED_NO_RETRY',runOnceInvoked,
    errorCode:allowed.has(e.code)?e.code:'UNCLASSIFIED_STOP',
    execution:e.code==='APR_TERMINAL_SAVE_FAILED'&&e.execution?e.execution:null};
  try{fs.writeFileSync(stem+'.exception.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});}catch(_){/* Preserve prior evidence. */}
  console.log(JSON.stringify({status:out.status,errorCode:out.errorCode,runOnceInvoked,hasExecutionFacts:out.execution!==null}));
  process.exitCode=1;
});
