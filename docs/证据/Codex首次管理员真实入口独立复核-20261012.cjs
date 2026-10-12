'use strict';
// Offline review only. Stdout JSON; never replaces prior evidence.
// Execute unchanged application modules and original test callbacks under whole-run
// network/process guards. All filesystem operations under authSessionDir/isolationRoot
// are redirected to new empty synthetic directories, preserving logical path strings.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const lib = path.join(ROOT, 'miniapp/scripts/lib');
const entryFile = path.join(lib, 'sandbox-primary-approved-run.cjs');
const host = require(path.join(lib, 'sandbox-primary-execution-host.cjs'));
const entry = require(entryFile);
const cli = require(path.join(lib, 'cloudbase-readonly-observer.cjs'));
const readonly = require(path.join(lib, 'cloudbase-sdk-readonly-observer.cjs'));
const originalFs = {};
for (const k of Object.keys(fs)) originalFs[k] = fs[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-primary-entry-review-'));
const authShadow = path.join(tmp, 'auth-shadow');
const isoShadow = path.join(tmp, 'isolation-shadow');
fs.mkdirSync(authShadow); fs.mkdirSync(isoShadow);
const mappings = [[cli.FIXED.authSessionDir, authShadow], [readonly.FIXED.isolationRoot, isoShadow]];
const counters = {network: 0, subprocess: 0, virtualAuthFs: 0};
const patched = [];
let entryDrift = false, terminalFail = false;
function patch(obj, key, value) { patched.push([obj,key,obj[key]]); obj[key] = value; }
function deny(label) { return () => { counters[label]++; throw Object.assign(new Error('AUDIT_BLOCKED'), {code:'AUDIT_BLOCKED'}); }; }
for (const [mod, keys] of [
  ['node:http',['request','get']], ['node:https',['request','get']],
  ['node:net',['connect','createConnection']], ['node:tls',['connect']],
  ['node:dns',['lookup','resolve','resolve4','resolve6']],
  ['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]
]) { const m = require(mod); for (const k of keys) patch(m,k,deny(mod.includes('child_process')?'subprocess':'network')); }
patch(require('node:net').Socket.prototype,'connect',deny('network'));
patch(globalThis,'fetch',deny('network'));
function mapped(p) {
  if (typeof p !== 'string') return p;
  const full = path.resolve(p);
  for (const [src,dst] of mappings) {
    const rel = path.relative(src,full);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (src === cli.FIXED.authSessionDir) counters.virtualAuthFs++;
      return path.join(dst,rel);
    }
  }
  return p;
}
function logical(p) {
  for (const [src,dst] of mappings) {
    const rel = path.relative(dst,p);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return path.join(src,rel);
  }
  return p;
}
for (const k of ['existsSync','accessSync','statSync','lstatSync','readdirSync','readFileSync','writeFileSync','mkdirSync','rmSync','rmdirSync','unlinkSync','openSync']) {
  patch(fs,k,function(p,...a) {
    if (k==='readFileSync' && entryDrift && p===entryFile) return Buffer.concat([originalFs.readFileSync(p),Buffer.from('\n// synthetic fingerprint drift\n')]);
    if (k==='writeFileSync' && terminalFail && String(p).includes(path.sep+'terminal'+path.sep)) throw Object.assign(new Error('synthetic disk failure'),{code:'EIO'});
    return originalFs[k](mapped(p),...a);
  });
}
patch(fs,'realpathSync',function(p,...a) { return logical(originalFs.realpathSync(mapped(p),...a)); });
patch(fs,'mkdtempSync',function(p,...a) {
  const mp=mapped(p);
  if(mp!==p) return logical(originalFs.mkdtempSync(mp,...a));
  return originalFs.mkdtempSync(path.join(tmp,path.basename(p)),...a);
});
const tests=[];
const testFile=path.join(ROOT,'miniapp/tests/sandbox-primary-approved-run.test.cjs');
const localRequire=Module.createRequire(testFile);
const moduleFixture={exports:{}};
const testSource=originalFs.readFileSync(testFile,'utf8');
vm.runInThisContext(Module.wrap(testSource+'\nmodule.exports={offlineChain,syntheticPlan,syntheticApprovalSource,syntheticCliSpawn,SYN_TARGET};'),{filename:testFile})(
  moduleFixture.exports, id=>id==='node:test'?((name,fn)=>tests.push({name,fn})):localRequire(id), moduleFixture,testFile,path.dirname(testFile));
const fixture=moduleFixture.exports;
const report={reviewedCommit:'60bdd92',baseline:'506ea95',verificationKind:'REAL_APPLICATION_AND_SDK_LOCAL_CONVERSION_WITH_SYNTHETIC_TRANSPORT_AND_FS',
  limitations:['All real-auth filesystem calls redirected to a newly created empty shadow; not an unmodified native test-runner replay.',
    'Synthetic credentials only; worker is invoked in-process by the existing test transport. No production worker self-created-db credential chain verified.',
    'Defect samples assert current defective behavior; sample pass is not product acceptance.'],
  originalTests:[],samples:[],sensitivity:{},realCredentialFetches:0,realCloudCalls:0,realAuthStoreContentRead:false,realAuthDirectoryModified:false};
async function sample(name,fn) {
  try { report.samples.push({name,checked:true,...await fn()}); }
  catch(e) { report.samples.push({name,checked:false,errorName:e.name,errorCode:e.code||null,message:String(e.message).slice(0,180)}); }
  finally { entryDrift=false; terminalFail=false; }
}
async function chain(name,change,inspect) {
  const fx=fixture.offlineChain({tag:name,runId:'AUDIT-'+name});
  try { change(fx); const r=await entry.runOnce(fx.options); return await inspect(fx,r); }
  finally {fx.tr.restore();}
}
(async()=>{
  for(const [label,fn] of Object.entries({https:()=>require('node:https').request('https://example.invalid'),dns:()=>require('node:dns').lookup('example.invalid'),net:()=>require('node:net').connect(443,'example.invalid'),child:()=>require('node:child_process').spawn(process.execPath,['-e','0'])})) {
    assert.throws(fn,e=>e.code==='AUDIT_BLOCKED'); report.sensitivity[label]=true;
  }
  const guardBase={...counters};
  for(const t of tests) {
    try {await t.fn();report.originalTests.push({name:t.name,pass:true});}
    catch(e){report.originalTests.push({name:t.name,pass:false,error:String(e.message).slice(0,150)});}
  }
  await sample('R1-mode-not-bound-and-runtime-overrides',()=>chain('MODE',fx=>{
    fx.options.credentialSourceMode='fixed-real-source'; delete fx.options.profileDir;
    const wrapped=fx.options.spawn;
    fx.options.credentialDeps={fixed:{nodeBin:'SYNTHETIC_NOT_FIXED_NODE'},spawn:(bin,args,opts)=>{fx.usedBin=bin;return wrapped(bin,args,opts);}};
  },(fx,r)=>{
    assert.equal(r.status,'COMPLETED'); assert.equal(fx.usedBin,'SYNTHETIC_NOT_FIXED_NODE');
    assert.equal(Object.hasOwn(fx.source,'credentialSourceMode'),false);
    return {defectReproduced:true,status:r.status,credentialFetches:fx.captured.credentialFetches,apiCalls:fx.captured.apiCalls.length,counts:fx.tr.counts(),overriddenNodeReachedSyntheticSpawn:true,approvalModeBound:false};
  }));
  await sample('R2-no-caller-persistence-callbacks',()=>chain('NOCB',fx=>{
    delete fx.options.persistRoundStarted;delete fx.options.persistResult;
  },(fx,r)=>{
    assert.equal(r.result.stoppedAt,'roundStarted');assert.equal(fx.tr.counts().commit,0);
    return {defectReproduced:true,status:r.status,errorCode:r.result.errorCode,startedExists:fs.existsSync(path.join(fx.outDir,'started',fx.options.runId+'.json')),credentialFetches:fx.captured.credentialFetches,apiCalls:fx.captured.apiCalls.length,counts:fx.tr.counts()};
  }));
  await sample('R2-no-worker-spawn-wiring',()=>chain('NOWORKER',fx=>{delete fx.options.spawnWorker;},(fx,r)=>{
    assert.notEqual(r.status,'COMPLETED');assert.equal(fx.tr.counts().commit,0);
    return {defectReproduced:true,status:r.status,workerStartedReported:r.result.workerStarted,errorCode:r.result.errorCode,counts:fx.tr.counts()};
  }));
  await sample('R3-entry-drift-not-rejected',()=>chain('ENTRYDRIFT',()=>{entryDrift=true;},(fx,r)=>{
    assert.equal(r.status,'COMPLETED');
    return {defectReproduced:true,status:r.status,entryBytesDriftSimulatedOnly:true,credentialFetches:fx.captured.credentialFetches,counts:fx.tr.counts(),approvalFingerprintFiles:Object.keys(fx.source.implementationFingerprint)};
  }));
  await sample('R4-terminal-drops-committed-facts',()=>chain('SAVEFIELDS',()=>{},(fx,r)=>{
    const disk=JSON.parse(fs.readFileSync(r.saved.file,'utf8'));
    const keys=['initialized','granted','observationConfirmed','commitFactEstablished','fullInitializationSuccess','workerProcess','reconcile'];
    const missing=keys.filter(k=>!Object.hasOwn(disk,k)); assert.equal(missing.length,keys.length);
    assert.equal(r.result.initialized,true);assert.equal(fx.tr.counts().commit,1);
    return {defectReproduced:true,status:r.status,inMemoryInitialized:r.result.initialized,inMemoryObservationConfirmed:r.result.observationConfirmed,missingFromTerminal:missing,counts:fx.tr.counts()};
  }));
  await sample('R4-save-failure-loses-returned-execution-report',async()=>{
    const fx=fixture.offlineChain({tag:'diskfail',runId:'AUDIT-DISKFAIL'});
    try {
      terminalFail=true; let error;
      try {await entry.runOnce(fx.options);}catch(e){error=e;}
      assert.equal(error.code,entry.ERR.TERMINAL_SAVE_FAILED);assert.equal(fx.tr.counts().commit,1);
      return {defectReproduced:true,errorCode:error.code,counts:fx.tr.counts(),errorHasExecutionReport:Object.hasOwn(error,'result'),errorHasAuditId:Object.hasOwn(error,'auditId'),startedExists:fs.existsSync(path.join(fx.outDir,'started','AUDIT-DISKFAIL.json'))};
    }finally{fx.tr.restore();}
  });
  await sample('R5-profile-preflight-happens-after-started',()=>chain('BADPROFILE',fx=>{fx.options.credentialSourceMode='fixed-real-source';},(fx,r)=>{
    assert.equal(fx.captured.credentialFetches,0);assert.equal(r.result.stoppedAt,'credentialFetch');
    const started=fs.existsSync(path.join(fx.outDir,'started','AUDIT-BADPROFILE.json'));assert.equal(started,true);
    return {defectReproduced:true,credentialFetches:0,startedCreated:started,status:r.status};
  }));
  await sample('subject-mismatch-is-post-fetch-not-pre-fetch',()=>chain('BADSUBJECT',fx=>{
    fx.options.approvalSource=fixture.syntheticApprovalSource(fx.plan,{expectedSubjectDigest:'0'.repeat(64)});
  },(fx,r)=>{
    assert.equal(r.result.stoppedAt,'callerSubject');assert.equal(fx.captured.credentialFetches,1);assert.equal(fx.tr.counts().commit,0);
    return {documentationCorrection:true,credentialFetches:fx.captured.credentialFetches,apiCalls:fx.captured.apiCalls.length,stoppedAt:r.result.stoppedAt,counts:fx.tr.counts()};
  }));
  report.guardUnexpectedDuringWork={network:counters.network-guardBase.network,subprocess:counters.subprocess-guardBase.subprocess};
  report.virtualAuthFsCalls=counters.virtualAuthFs;
  report.summary={originalPassed:report.originalTests.filter(x=>x.pass).length,originalTotal:tests.length,samplesChecked:report.samples.filter(x=>x.checked).length,samplesTotal:report.samples.length};
})().catch(e=>{report.harnessFailure={name:e.name,code:e.code||null,message:String(e.message).slice(0,200)};process.exitCode=1;}).finally(()=>{
  for(const [obj,key,value] of patched.reverse())obj[key]=value;
  // Only this invocation's exact newly allocated temporary root; never user data.
  const resolved=path.resolve(tmp), parent=path.resolve(os.tmpdir());
  if(path.dirname(resolved)===parent && path.basename(resolved).startsWith('codex-primary-entry-review-'))originalFs.rmSync(resolved,{recursive:true,force:true});
  report.finishedAt=new Date().toISOString();
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(report.harnessFailure||report.samples.some(x=>!x.checked)||report.originalTests.some(x=>!x.pass))process.exitCode=1;
});
