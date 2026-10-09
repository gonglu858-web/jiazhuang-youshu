'use strict';
// 仅离线审查：真实模块/SDK 转换，合成凭据、进程和数据库传输。只向 stdout 输出。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
let blockedNetwork = 0;
for (const n of ['http', 'https']) {
  const m = require(n); m.request = m.get = () => { blockedNetwork++; throw Error('AUDIT_NETWORK_BLOCKED'); };
}
for (const n of ['net', 'tls']) {
  const m = require(n); m.connect = m.createConnection = () => { blockedNetwork++; throw Error('AUDIT_NETWORK_BLOCKED'); };
}
const cp = require('node:child_process');
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[k] = () => { throw Error('AUDIT_REAL_PROCESS_BLOCKED'); };
}
const file = path.join(root, 'miniapp/tests/sandbox-primary-execution-host.test.cjs');
const req = createRequire(file);
const fixtureModule = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(file, 'utf8') +
  '\nmodule.exports={host,worker,p4,syntheticPlan,syntheticApproval,syntheticApprovalSource,syntheticDirs,syntheticCliSpawn,syntheticWorkerSpawn,installSyntheticSdkTransport,SYN_TARGET,SYN_OPENID};})', {filename:file})(
  n => n === 'node:test' ? (() => {}) : req(n), fixtureModule, fixtureModule.exports, file, path.dirname(file));
const f = fixtureModule.exports;
const { host, worker, p4 } = f;
const rows = [];
const protectedFiles = [
  'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs', 'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs',
  'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs', 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs',
  'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs', 'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs',
  'miniapp/scripts/prepare-sandbox-primary.cjs', 'miniapp/scripts/package-sandbox.cjs',
  'docs/证据/Codex首次管理员接线复核-20261009.cjs', 'docs/证据/Codex首次管理员接线复核-20261009.json'
];
const hashes = () => Object.fromEntries(protectedFiles.map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]));
const before = hashes();
async function sample(id, fun) {
  try { rows.push({id, ...await fun()}); }
  catch(e) { rows.push({id, harnessError: true, errorClass:e.name, code:e.code || null}); }
}
const docs = () => ({ schtest_v1_users:{_id:f.SYN_TARGET, status:'active', openid:f.SYN_OPENID} });
function childOutput(text, code=0) {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
  c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
  setImmediate(() => { c.stdout.emit('data',Buffer.from(text)); c.emit('exit',code,null); c.emit('close',code,null); });
  return c;
}
async function chain(patch) {
  const tr = f.installSyntheticSdkTransport(docs());
  const plan=f.syntheticPlan(); const approval=f.syntheticApproval();
  const source=f.syntheticApprovalSource(plan,{approval,approvedBy:approval.approvedBy});
  const captured={calls:[],credentialFetches:0,apiCalls:[]}; let started=null; let saves=0;
  const o={plan, approval, approvalSource:source, roundId:plan.roundId, fixedNowMs:Date.now(),
    ...f.syntheticDirs('codex-R1R6'), spawn:f.syntheticCliSpawn(captured),
    spawnWorker:f.syntheticWorkerSpawn([],{}, {db:tr.db}),
    persistRoundStarted: async v => { started=v; return true; },
    persistResult:async () => { saves++; return true; }};
  try {
    if(patch) patch(o,tr);
    const r=await host.executeOnce(o);
    return {r, counts:tr.counts(), captured:{credentialFetches:captured.credentialFetches,apiCalls:captured.apiCalls.length},
      started, saves, auditApprovedBy:tr.store.schtest_v1_audit_events?.approvedBy,
      auditOperatorRef:tr.store.schtest_v1_audit_events?.operatorRef};
  } finally { tr.restore(); }
}
async function main() {
  await sample('positive-real-core',async()=>{const x=await chain(); return {passed:x.r.initialized===true && x.counts.commit===1 && x.counts.readOnlyGet===2,...x};});
  await sample('approval-not-bound-to-worker',async()=>{
    const x=await chain(o=>{o.approval={...o.approval,approvedBy:'SYNTH_DIFFERENT_REVIEWER'};});
    return {defect:x.counts.commit===1 && x.auditApprovedBy==='SYNTH_DIFFERENT_REVIEWER',...x};
  });
  await sample('signed-handle-nested-mutation',async()=>{
    const plan=f.syntheticPlan(), s=f.syntheticApprovalSource(plan);
    s.approval.approvedBy='SYNTH_CHANGED_AFTER_ISSUE';
    const r=host.verifyControlledApproval({approvalSource:s,plan});
    return {defect:r.ok===true, nestedFrozen:Object.isFrozen(s.approval), r};
  });
  await sample('plan-change-after-started',async()=>{
    const x=await chain(o=>{o.persistRoundStarted=async()=>{o.plan.operatorRef='SYNTH_CHANGED_AFTER_APPROVAL';return true;};});
    return {defect:x.counts.commit===1 && x.auditOperatorRef==='SYNTH_CHANGED_AFTER_APPROVAL',...x};
  });
  for(const type of ['plan','credential']) await sample(type+'-expires-after-tx-read',async()=>{
    const tr=f.installSyntheticSdkTransport(docs());
    const database=require(path.join(host.FIXED.sdkRoot,'@cloudbase/database'));
    const Base=database.Db.reqClass; const t0=Date.now(); let clock=t0, event=false, out;
    database.Db.reqClass=class extends Base {async send(action,params){const v=await super.send(action,params);
      if(action==='database.getDocument' && params.collectionName==='schtest_v1_users'){clock=t0+2000;event=true;} return v;}};
    try {
      await worker.run({credential:{secretId:'SYNTH',secretKey:'SYNTH',sessionToken:'SYNTH',expiresAtMs:t0+(type==='credential'?1000:100000)},
        plan:f.syntheticPlan(null,{expiresAt:new Date(t0+(type==='plan'?1000:100000)).toISOString()}),
        approval:f.syntheticApproval(),verifiedCaller:true,fixedNowMs:t0}, {db:tr.db,now:()=>clock,emit:v=>{out=v;}});
      return {defect:event && tr.counts().commit===1,expiryEventReached:event,counts:tr.counts(),out};
    } finally {tr.restore();}
  });
  await sample('worker-timeout-loses-reconcile-keys',async()=>{
    const x=await chain(o=>{o.spawnWorker=f.syntheticWorkerSpawn([],{}, {hang:true});o.workerLimits={timeoutMs:30,maxOutputBytes:4096,closeGraceMs:10};});
    return {defect:x.r.auditId===null && x.counts.readOnlyGet===0, roundIdInReport:x.r.roundId ?? null,...x};
  });
  await sample('malformed-output-clean-exit',async()=>{
    const x=await chain(o=>{o.spawnWorker=()=>childOutput('{broken');});
    return {defect:x.r.resultUnknown===false,...x};
  });
  await sample('worker-declared-unknown-lost',async()=>{
    const facts={spawnError:false,timedOut:false,overflow:false,signal:null,exitCode:0,closeNotObserved:false,terminationRequested:false,terminationConfirmed:false};
    const r=host.projectWorkerOutput({ok:false,errorCode:'RESULT_UNKNOWN',resultUnknown:true,observeFailed:false},facts,false);
    return {defect:r.resultUnknown===false,r};
  });
  await sample('known-field-projection-leak',async()=>{
    const marker='SYNTH_PRIVATE_MARKER'; const facts={spawnError:false,timedOut:false,overflow:false,signal:null,exitCode:0};
    const r=host.projectWorkerOutput({outcome:marker,auditId:p4.AUDIT_ID_PREFIX+marker,
      bootstrap:{outcome:marker,errorCode:marker,requestIds:[marker],inputDigest:marker},
      observed:{state:marker,errorCode:marker,primaryStatus:marker}},facts,false);
    return {defect:JSON.stringify(r).includes(marker),r};
  });
  const after=hashes();
  process.stdout.write(JSON.stringify({observedAt:new Date().toISOString(),scope:'OFFLINE_SYNTHETIC_ONLY',
    blockedNetwork,realCloudCalls:0,realCredentialFetches:0,syntheticTempDirsCreated:true,
    historicalEvidenceUnchanged:JSON.stringify(before)===JSON.stringify(after),protectedHashes:after,
    summary:{total:rows.length,defects:rows.filter(x=>x.defect).length,positivePassed:rows.filter(x=>x.passed).length,harnessErrors:rows.filter(x=>x.harnessError).length},rows},null,2)+'\n');
}
main().catch(e=>{process.stderr.write(e.name+'\n');process.exitCode=1;});
