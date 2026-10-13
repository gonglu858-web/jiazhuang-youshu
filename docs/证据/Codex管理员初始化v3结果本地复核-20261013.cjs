'use strict';
// Rechecks saved evidence only. Never invokes the execution runner or any cloud SDK.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const prefix='docs/证据/Codex管理员初始化v3单次执行-20261013';
const proof=read('docs/证据/Codex管理员初始化v3包本地核对-20261013.json');
const auth=read(prefix+'.authorized.json'),result=read(prefix+'.result.json');
const runRoot='docs/证据/管理员初始化执行-primary-20261013-self-01';
const started=read(runRoot+'/started/primary-20261013-self-01.json');
const terminal=read(runRoot+'/terminal/primary-20261013-self-01.COMPLETED.json');
const checks=[];
function check(name,fn){fn();checks.push({name,pass:true});}
check('approval binds reviewed package and actual invocation',()=>{
  assert.equal(auth.packageRevision,proof.packageRevision);assert.equal(auth.alternativeBasisAccepted,true);
  assert.equal(auth.principalSourceConfirmed,false);assert.equal(auth.confirmationText,'确认');
  assert.equal(auth.runnerSha256,sha(fs.readFileSync(path.join(root,prefix+'.cjs'))));
  assert.equal(auth.packageSha256,sha(fs.readFileSync(path.join(root,'docs/Codex执行包-管理员初始化v3自助核验-20261013.md'))));
  assert.equal(auth.proofSha256,sha(fs.readFileSync(path.join(root,'docs/证据/Codex管理员初始化v3包本地核对-20261013.json'))));
  assert.equal(auth.planSha256,proof.planFile.sha256);
  assert.equal(auth.expectedStableIdentityDigest,proof.expectedStableIdentityDigest);
  assert.equal(auth.bindingPolicyVersion,'cloud-role-binding/1');
});
check('completion within approved window',()=>{
  assert.ok(Date.parse(started.savedAt)>=Date.parse(auth.confirmationObservedAt));
  assert.ok(Date.parse(result.finishedAt)<Date.parse(auth.approvalExpiresAt));
  assert.ok(Date.parse(auth.approvalExpiresAt)<=Date.parse(proof.plan.expiresAt));
});
check('new round and deterministic audit binding',()=>{
  for(const x of [started,terminal,result.result]){
    assert.equal(x.auditId,proof.auditId);assert.equal(x.planDigest,proof.inputDigest);
  }
  assert.equal(started.targetUserId,proof.plan.targetUserId);
  assert.equal(started.runId,proof.plan.roundId);assert.equal(terminal.runId,proof.plan.roundId);assert.equal(result.runId,proof.plan.roundId);
  assert.equal(terminal.fullPlanDigest,proof.fullPlanDigest);
});
check('real source and identity continuity confirmed',()=>{
  for(const x of [result.result,terminal]){
    assert.equal(x.fixedRealSourceUsed,true);assert.equal(x.credentialSourceMode,'fixed-real-source');
    assert.equal(x.firstIdentityCheckMatched,true);assert.equal(x.stableIdentityMatched,true);assert.equal(x.sessionContinuityConfirmed,true);
  }
  assert.equal(auth.noDependencyInjection,true);
});
check('bound initialization committed and read back',()=>{
  for(const x of [result.result,terminal]){
    assert.equal(x.bootstrap.outcome,'initialized');assert.equal(x.bootstrap.bindingMatched,true);
    assert.equal(x.bootstrap.auditId,proof.auditId);assert.equal(x.bootstrap.inputDigest,proof.inputDigest);
    assert.equal(x.commitFactEstablished,true);assert.equal(x.fullInitializationSuccess,true);
    assert.equal(x.granted,true);assert.equal(x.initialized,true);assert.equal(x.observationConfirmed,true);
    assert.equal(x.observed.state,'present');assert.equal(x.observed.primaryPresent,true);
    assert.equal(x.observed.primaryStatus,'active');assert.equal(x.observed.auditPresent,true);
    assert.equal(x.observeFailed,false);assert.equal(x.bindingMismatch,false);
  }
});
check('worker ended successfully without timeout',()=>{
  assert.equal(result.result.workerStarted,true);
  assert.equal(result.result.workerProcess.exitCode,0);assert.equal(result.result.workerProcess.timedOut,false);
  assert.equal(result.result.workerProcess.spawnError,false);assert.equal(result.result.workerProcess.closeNotObserved,false);
});
check('completed persisted once with no unknown or failure terminal',()=>{
  assert.equal(result.status,'COMPLETED');assert.equal(terminal.recordType,'COMPLETED');assert.equal(result.saved.saved,true);
  assert.equal(result.result.resultPersisted,true);assert.equal(terminal.resultPersisted,true);
  assert.equal(result.result.unknownPersisted,false);assert.equal(terminal.unknownPersisted,false);
  assert.deepEqual(fs.readdirSync(path.join(root,runRoot,'terminal')),['primary-20261013-self-01.COMPLETED.json']);
  assert.equal(fs.existsSync(path.join(root,prefix+'.exception.json')),false);
});
check('implementation and historical source bytes preserved',()=>{
  for(const f of [...proof.implementationFiles,...proof.runtimeFiles,...proof.checkedSources,...proof.historicalEvidence])
    assert.equal(sha(fs.readFileSync(path.resolve(root,f.path))),f.sha256);
  assert.deepEqual(started.fingerprint,proof.boundFingerprint);assert.deepEqual(terminal.fingerprint,proof.boundFingerprint);
});
const files=[prefix+'.cjs',prefix+'.authorized.json',prefix+'.result.json',runRoot+'/started/primary-20261013-self-01.json',runRoot+'/terminal/primary-20261013-self-01.COMPLETED.json'];
const report={schema:'primary-v3-result-crosscheck/1',checkedAt:new Date().toISOString(),
  status:'COMPLETED_EVIDENCE_CONSISTENT',checks,
  evidence:files.map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))})),
  scriptSha256:sha(fs.readFileSync(__filename)),checkerCloudCalls:0,checkerCredentialFetches:0,
  limitations:['This checker reads saved execution evidence, not a second live cloud observation.',
    'No raw database network traces or SDK request IDs were retained; no measured network/transaction count is claimed.',
    'No new remote closed-code readback. This execution did not deploy or enable an entry.',
    'Success is scoped to this authorized initialization, not general IAM or application acceptance.']};
const args=process.argv.slice(2);assert.ok(args.length===0||(args.length===2&&args[0]==='--out'));
if(args.length)fs.writeFileSync(path.resolve(args[1]),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,checks:checks.length,passed:checks.filter(c=>c.pass).length,checkerCloudCalls:0}));
