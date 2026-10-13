'use strict';
// 仅离线审查：复用交付的传输夹具，不运行其中任何 test；审查断言与样本独立。
// 不改应用/历史证据。所有夹具临时文件限制在本脚本新建的审查根内。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const originalTmpdir = os.tmpdir;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-identity-review-'));
os.tmpdir = () => temporaryRoot;
const file = path.join(ROOT, 'miniapp/tests/sandbox-primary-approved-run.test.cjs');
const source = fs.readFileSync(file, 'utf8');
const cut = source.indexOf("test('A-1 ");
assert.ok(cut > 0, 'fixture boundary must be explicit');
const fixture = new Module(file, module);
fixture.filename = file;
fixture.paths = Module._nodeModulePaths(path.dirname(file));
fixture._compile(source.slice(0, cut) + '\nmodule.exports={host,approvedRun,identityBinding,offlineChain,installFsVirtualization,GUARD_TOTALS};', file);
const f = fixture.exports;
// 加强防护：拦截未被交付夹具覆盖的同步子进程和直接 Socket/fetch 路径。
const extraGuard = { probes: 0, unexpected: 0 };
let probing = false;
function deny() { extraGuard[probing ? 'probes' : 'unexpected']++; throw new Error('AUDIT_OFFLINE_BLOCK'); }
for (const name of ['spawnSync','execSync','execFileSync']) require('node:child_process')[name] = deny;
require('node:net').Socket.prototype.connect = deny;
globalThis.fetch = deny;
const virtual = f.installFsVirtualization('independent');
const m = f.identityBinding;
const base = { Type:'CAMRole', AccountId:'123456789012', PrincipalId:'123456789012',
  UserId:'4611686018427397919:session-A', Arn:'qcs::sts:123456789012:assumed-role/4611686018427397919',
  RequestId:'00000000-0000-4000-8000-000000000001' };
const different = {...base, PrincipalId:'987654789012'};
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const report = { reviewedCommit:'0c05474', reviewBasisCommit:'9e62eba', reviewDate:'2026-10-13',
  verification:'REAL_APPLICATION_AND_SDK_LOCAL_CONVERSION_WITH_SYNTHETIC_TRANSPORT',
  platformVerified:false, realCredentialFetches:0, productionApprovalIssued:false,
  helperFixtureSha256:sha(source), implementation:f.host.computeImplementationFingerprint(),
  entrySha256:sha(fs.readFileSync(path.join(ROOT,'miniapp/scripts/lib/sandbox-primary-approved-run.cjs'))),
  checks:[], cases:[] };
function record(name, observed, ok) { report.checks.push({name,observed,pass:ok === true}); }
async function scenario(name, responses, extra={}) {
  const capture = {calls:[]};
  const fx = f.offlineChain({tag:name,runId:'AUDIT-'+name,
    approvalPatch:{bindingPolicyVersion:m.BINDING_POLICY_VERSION,
      expectedStableIdentityDigest:m.stableIdentityDigest(base)},
    cliOpts:{stsResponses:responses,...extra},workerCapture:capture});
  const cli = fx.options.spawn, worker = fx.options.spawnWorker;
  const apiKeys=[], tokens=[];
  fx.options.spawn=(bin,argv,opts)=>{
    if(argv[1]==='api'){ apiKeys.push(argv[2]+'.'+argv[3]);
      tokens.push(opts.env.TENCENTCLOUD_SECRETID === 'SYNTH_ID' &&
        opts.env.TENCENTCLOUD_SECRETKEY === 'SYNTH_KEY' && opts.env.TENCENTCLOUD_SESSIONTOKEN === 'SYNTH_TOKEN'); }
    return cli(bin,argv,opts);
  };
  fx.options.spawnWorker=(...args)=>worker(...args);
  try {
    const run=await f.approvedRun.runOnce(fx.options);
    const started=JSON.parse(fs.readFileSync(path.join(fx.outDir,'started',fx.plan.roundId+'.json'),'utf8'));
    const terminal=JSON.parse(fs.readFileSync(path.join(fx.outDir,'terminal',fx.plan.roundId+'.'+run.status+'.json'),'utf8'));
    const row={name,status:run.status,errorCode:run.result.errorCode,
      stoppedAt:run.result.stoppedAt, credentialFetches:fx.captured.credentialFetches,
      apiKeys,workerCalls:capture.calls.length,db:fx.tr.counts(),
      cloudCallAttempted:run.result.cloudCallAttempted,
      firstIdentityCheckMatched:run.result.firstIdentityCheckMatched,
      terminalFirstIdentityCheckMatched:terminal.firstIdentityCheckMatched,
      terminalSessionContinuityConfirmed:terminal.sessionContinuityConfirmed,
      stableIdentityMatched:run.result.stableIdentityMatched ?? null,
      sessionContinuityConfirmed:run.result.sessionContinuityConfirmed ?? null,
      terminalStableIdentityMatched:terminal.stableIdentityMatched,
      bindingVersion:started.bindingPolicyVersion,
      startedHasExpectedStableDigest:Object.hasOwn(started,'expectedStableIdentityDigest'),
      startedLegacyExpectedIsNull:started.expectedSubjectDigest===null,
      terminalHasExpectedStableDigest:Object.hasOwn(terminal,'expectedStableIdentityDigest'),
      cliSnapshotAllEqual:tokens.length>0&&tokens.every(Boolean),
      workerSnapshotEqual:capture.calls.length===0 ? null : (()=>{
        const p=capture.calls[0].payloadRef();
        const str=JSON.stringify(p); return str.includes('SYNTH_TOKEN')&&str.includes('SYNTH_KEY')&&str.includes('SYNTH_ID');
      })(),
      resultPersisted:run.result.resultPersisted,unknownPersisted:run.result.unknownPersisted};
    report.cases.push(row);return row;
  } finally {fx.tr.restore();}
}
async function main(){
  const parsed=m.parseCallerIdentity(base);
  record('exact versioned digest and large decimal preservation',parsed.roleId,
    parsed.roleId==='4611686018427397919' && m.stableIdentityDigest(base)===sha(JSON.stringify([
      'cloud-role-binding/1',base.Type,base.AccountId,base.PrincipalId,parsed.roleId,base.Arn])) &&
    m.sessionDigest(base)===sha(JSON.stringify(['cloud-role-session/1',base.Type,base.AccountId,base.UserId,base.PrincipalId,base.Arn])));
  const anotherSession={...base,UserId:parsed.roleId+':session-B'};
  record('cross-batch session separation',null,m.stableIdentityDigest(base)===m.stableIdentityDigest(anotherSession)&&m.sessionDigest(base)!==m.sessionDigest(anotherSession));
  const bad=[...['\n','\r','\u2028',' ',':','*'].map(s=>({...base,UserId:base.UserId+s})),
    {...base,UserId:parsed.roleId+':a'}, {...base,UserId:parsed.roleId+':'+'a'.repeat(129)},
    {...base,AccountId:123456789012},{...base,PrincipalId:null},
    {...base,Arn:base.Arn+'0'}, {...base,Type:'CAMUser'}];
  let refused=0;for(const b of bad){try{m.parseCallerIdentity(b);}catch(e){if(Object.values(m.ERR).includes(e.code))refused++;}}
  record('strict malformed field matrix',{total:bad.length,refused},refused===bad.length);
  const ok=await scenario('POSITIVE',[base]);
  record('full positive five APIs and two writes',null,ok.status==='COMPLETED'&&ok.credentialFetches===1&&ok.workerCalls===1&&
    ok.db.primarySet===1&&ok.db.auditSet===1&&ok.db.commit===1&&ok.cliSnapshotAllEqual&&ok.workerSnapshotEqual&&
    JSON.stringify(ok.apiKeys)===JSON.stringify(['sts.GetCallerIdentity','sts.GetCallerIdentity','tcb.DescribeEnvs','tcb.DescribeEnvInfo','sts.GetCallerIdentity']));
  const first=await scenario('FIRST_MISMATCH',[different]);
  record('first mismatch stops before further APIs/worker',null,first.errorCode==='STABLE_IDENTITY_MISMATCH'&&first.apiKeys.length===1&&first.workerCalls===0&&first.db.commit===0);
  record('first attempted STS is reported as attempted',first.cloudCallAttempted,first.cloudCallAttempted===true);
  const second=await scenario('SECOND_MISMATCH',[base,base,different]);
  record('second mismatch stops worker',null,second.errorCode==='STABLE_IDENTITY_MISMATCH'&&second.apiKeys.length===5&&second.workerCalls===0&&second.db.commit===0);
  record('second mismatch cannot leave aggregate matched true',second.stableIdentityMatched,second.stableIdentityMatched!==true&&second.terminalStableIdentityMatched!==true);
  const drift=await scenario('SESSION_CHANGE',[base,base,anotherSession]);
  record('session change stops worker',null,drift.errorCode==='SESSION_CONTINUITY_BROKEN'&&drift.workerCalls===0&&drift.db.commit===0);
  const malformed=await scenario('FIRST_BAD',[{...base,UserId:parsed.roleId+':bad*name'}]);
  record('malformed identity fails closed',null,malformed.errorCode==='IDENT_UNPARSEABLE'&&malformed.apiKeys.length===1&&malformed.workerCalls===0);
  record('malformed STS still records attempted call',malformed.cloudCallAttempted,malformed.cloudCallAttempted===true);
  // 本轮独立补查：字段校验位于 JSON 解析和严格身份解析之间。
  const rejected=[];
  for(const field of ['AccountId','PrincipalId','Arn','RequestId']) {
    const data={...base};delete data[field];
    const row=await scenario('MISSING_'+field,[data]);rejected.push(row);
    record('R1 missing '+field+' retains attempted fact',
      {attempted:row.cloudCallAttempted,apiCalls:row.apiKeys.length,errorCode:row.errorCode},
      row.cloudCallAttempted===true && row.apiKeys.length===1 && row.errorCode==='STS_FIELD_MISSING');
  }
  const type=await scenario('WRONG_TYPE',[{...base,Type:'CAMUser'}]);rejected.push(type);
  record('R1 unsupported STS type retains attempted fact',
    {attempted:type.cloudCallAttempted,apiCalls:type.apiKeys.length,errorCode:type.errorCode},
    type.cloudCallAttempted===true && type.apiKeys.length===1 && type.errorCode==='STS_TYPE_MISMATCH');
  record('all field/type failures remain zero worker and zero transaction writes',null,
    rejected.every(r=>r.status==='FAILED'&&r.workerCalls===0&&r.db.primarySet===0&&r.db.auditSet===0&&r.db.commit===0));
  const exit=await scenario('NONZERO',[base],{apiExit:1});
  record('nonzero exit retains attempted and rejects before worker',null,
    exit.cloudCallAttempted===true&&exit.apiKeys.length===1&&exit.workerCalls===0&&exit.db.commit===0);
  const role={...base,UserId:'4611686018427397920:session-A',Arn:'qcs::sts:123456789012:assumed-role/4611686018427397920'};
  const roleRow=await scenario('SECOND_ROLE',[base,base,role]);
  for(const row of [second,roleRow]) record('R2 '+row.name+' return and saved facts agree',null,
    row.firstIdentityCheckMatched===true&&row.terminalFirstIdentityCheckMatched===true&&
    row.stableIdentityMatched===false&&row.terminalStableIdentityMatched===false&&
    row.sessionContinuityConfirmed===false&&row.terminalSessionContinuityConfirmed===false&&
    row.workerCalls===0&&row.db.commit===0);
  for(const row of [ok,drift]) record('R2 '+row.name+' preserves correct staged facts',null,
    row.firstIdentityCheckMatched===true&&row.terminalFirstIdentityCheckMatched===true&&
    row.stableIdentityMatched===true&&row.terminalStableIdentityMatched===true&&
    row.sessionContinuityConfirmed===(row===ok)&&row.terminalSessionContinuityConfirmed===(row===ok));
  record('all reports and saved records contain explicit boolean identity facts',null,
    report.cases.every(r=>['firstIdentityCheckMatched','terminalFirstIdentityCheckMatched','stableIdentityMatched',
      'terminalStableIdentityMatched','sessionContinuityConfirmed','terminalSessionContinuityConfirmed'].every(k=>typeof r[k]==='boolean')));
  const {EventEmitter}=require('node:events');
  const helperDir=fs.mkdtempSync(path.join(temporaryRoot,'helper-'));
  const snapshot={secretId:'SYNTH_ID',secretKey:'SYNTH_KEY',sessionToken:'SYNTH_TOKEN'};
  let helperCalls=0;
  function rawSpawn(raw) {return ()=>{
    helperCalls++;const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();
    c.kill=()=>true;setImmediate(()=>{c.stdout.emit('data',Buffer.from(raw));c.emit('exit',0,null);c.emit('close',0,null);});return c;
  };}
  const missing={...base};delete missing.AccountId;
  const helperBad=await f.host.verifyCallerSubject(snapshot,{isolationDir:helperDir,spawn:rawSpawn(JSON.stringify(missing))});
  record('R1 helper field rejection retains attempted after one synthetic spawn',
    {attempted:helperBad.attempted,calls:helperCalls,errorCode:helperBad.errorCode},helperBad.attempted===true&&helperCalls===1);
  const parse=await f.host.verifyCallerSubject(snapshot,{isolationDir:helperDir,spawn:rawSpawn('not-json')});
  record('helper JSON parsing rejection retains attempted',null,parse.attempted===true&&parse.reason==='STS_PARSE_FAILED'&&helperCalls===2);
  const before=helperCalls;
  const pre=await f.host.verifyCallerSubject(null,{isolationDir:helperDir,spawn:rawSpawn('{}')});
  record('helper local precondition remains unattempted',null,pre.attempted===false&&helperCalls===before);
  // 既有非阻断观察仅保留，不扩成本轮新增要求。
  report.auditObservation={expectedStableDigestPersisted:ok.startedHasExpectedStableDigest||ok.terminalHasExpectedStableDigest,
    note:'new-policy started keeps version and null legacy digest; expected stable identity is absent from started and terminal'};
  probing=true;for(const fn of [()=>fetch('https://example.invalid'),()=>require('node:child_process').spawnSync('node',['-e','1'])]){try{fn();}catch{}}
  probing=false;
  report.guards={fixtureUnexpected:f.GUARD_TOTALS,additional:extraGuard};
  record('guard counters',null,Object.values(f.GUARD_TOTALS).every(n=>n===0)&&extraGuard.unexpected===0&&extraGuard.probes===2);
  report.summary={checks:report.checks.length,pass:report.checks.filter(c=>c.pass).length,
    findings:report.checks.filter(c=>!c.pass).map(c=>c.name)};
}
main().then(()=>{
  const out=process.argv.indexOf('--out');const json=JSON.stringify(report,null,2)+'\n';
  if(out<0) process.stdout.write(json);
  else {const dest=process.argv[out+1];assert.ok(path.isAbsolute(dest));fs.writeFileSync(dest,json,{flag:'wx'});console.log(JSON.stringify(report.summary));}
}).catch(e=>{console.error('AUDIT_HARNESS_FAILED',e.code||e.name);process.exitCode=1;}).finally(()=>{
  virtual.restore();os.tmpdir=originalTmpdir;
  const resolved=path.resolve(temporaryRoot), allowed=path.resolve(originalTmpdir());
  if(path.dirname(resolved).toLowerCase()!==allowed.toLowerCase()||!path.basename(resolved).startsWith('codex-identity-review-'))throw new Error('CLEANUP_BOUNDARY');
  fs.rmSync(resolved,{recursive:true,force:true});
});
