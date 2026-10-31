'use strict';
// Local preparation only: public process/network APIs are blocked before contract load.
const guard={probes:0,unexpected:0};let probing=false;
function deny(){guard[probing?'probes':'unexpected']++;throw Error('OFFLINE_BLOCKED');}
const cp=require('node:child_process');cp.ChildProcess.prototype.spawn=deny;
const socketPrototype=require('node:net').Socket.prototype;
for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const id of ['node:http','node:https','node:net','node:tls','node:dgram','node:dns']){
  const m=require(id);
  if(id==='node:net')m.Socket.prototype.connect=deny;
  if(id==='node:dns')for(const k of Object.keys(m.promises))if(typeof m.promises[k]==='function')m.promises[k]=deny;
  for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});
}globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const H=b=>crypto.createHash('sha256').update(b).digest('hex'),B=v=>Buffer.from(JSON.stringify(v));
const results=[];function test(name,fn){try{fn();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:e.code||'ASSERTION_FAILED'});}}
function one(s,a,b){assert.equal(s.split(a).length,2);return s.replace(a,()=>b);}
const dir=__dirname,read=n=>fs.readFileSync(path.join(dir,n));
const names={helper:'CodexL2单根对照辅助层v2-20261031.cs',config:'CodexL2单根对照固定接口v2-20261031.json',contract:'CodexL2单根对照回执契约v2-20261031.cjs'};
function verdict(){return results.every(x=>x.ok)&&guard.unexpected===0;}
let report;
try{
  const args=process.argv.slice(2),fault=args.length===1&&args[0]==='--fault-caught';
  assert.ok(args.length===0||fault||args.length===2&&args[0]==='--out'&&args[1].trim()&&!args[1].startsWith('--'));
  if(args.length===2)assert.equal(fs.existsSync(args[1]),false);
  probing=true;
  for(const fn of [()=>cp.spawn('denied'),()=>require('node:https').request('denied'),()=>socketPrototype.connect(),()=>require('node:dns').promises.lookup('denied'),()=>fetch('denied')])assert.throws(fn,/OFFLINE_BLOCKED/);
  probing=false;assert.equal(guard.probes,5);
  const c=require('./'+names.contract),config=JSON.parse(read(names.config));
  const old=read('CodexL2成员诊断辅助层v2-20261028.cs').toString('utf8');
  const driver=read('CodexL2成员诊断驱动v5-20261028.cjs').toString('utf8');
  test('pinned legacy sources',()=>{
    assert.equal(H(Buffer.from(old)),'0e67ee083cdcbe67773362ff62f4ee766e6cc083c4ed2a7f26e6eab696cba2ce');
    assert.equal(H(Buffer.from(driver)),'da90314446680bd986054c532e9721f4b7560d1bc05a1a0dec71308681611354');
    assert.equal(H(read('CodexL2成员观察器v3-20261028.cs')),'722d28e9e2f145d9bcf4e00fb82ee4837ec4b365d53bdd86b4472a6228fd9019');
  });
  test('helper four root-only replacements plus two cleanup fixes',()=>{
    const line=old.split(/\r?\n/).find(l=>l.includes('if (mode == "normal") return'));
    let expected=one(old,line,'    if (mode == "rootOnly") return new string[] { "-e", "process.stdout.write(\'L2_ROOT_ONLY\');" };');
    expected=one(expected,'r.Total==2','r.Total==1');expected=one(expected,'args[0]!="normal"','args[0]!="rootOnly"');expected=one(expected,'codex-l2-member-job/2','codex-l2-root-only-job/1');
    assert.equal(H(Buffer.from(expected)),'70acb6cf355b815a7b91e9a80d242844b905a7d0c56e3c3c96dd90a8fa2dbf37');
    assert.equal(read('CodexL2单根对照辅助层v1-20261031.cs').toString('utf8'),expected);
    expected=one(expected,'  static bool Close(ref IntPtr h) { if(h==IntPtr.Zero || h==Invalid) {h=IntPtr.Zero; return true;} bool ok=CloseHandle(h);h=IntPtr.Zero;return ok; }',[
      '  static bool Close(ref IntPtr h, Receipt r) {',
      '    if(h==IntPtr.Zero || h==Invalid) {h=IntPtr.Zero; return true;}',
      '    bool ok=false;',
      '    try {ok=CloseHandle(h);} catch {ok=false;} finally {h=IntPtr.Zero;}',
      '    if(!ok)r.HandlesClosed=false;',
      '    return ok;',
      '  }'].join('\n'));
    let calls=0;expected=expected.replace(/Close\(ref (wr|ew|input|pi.Thread|pi.Process|rd|er|job)\)/g,(_,h)=>{calls++;return 'Close(ref '+h+',r)';});assert.equal(calls,11);
    expected=one(expected,'r.HandlesClosed=Close(ref pi.Thread,r)&Close(ref pi.Process,r)&Close(ref rd,r)&Close(ref wr,r)&Close(ref er,r)&Close(ref ew,r)&Close(ref input,r)&Close(ref job,r);','r.HandlesClosed=(Close(ref pi.Thread,r)&Close(ref pi.Process,r)&Close(ref rd,r)&Close(ref wr,r)&Close(ref er,r)&Close(ref ew,r)&Close(ref input,r)&Close(ref job,r))&&r.HandlesClosed;');
    expected=one(expected,'if(r.Reason!="NONE"||!r.Cleanup)r.Outcome="failed";','if(r.Reason!="NONE"||!r.Cleanup){r.Outcome="failed";r.Stdout="";}');
    assert.equal(read(names.helper).toString('utf8'),expected);
    assert.equal(config.sources[0].sha256,H(read(names.helper)));
  });
  test('receipt grammar exact adaptation of pinned driver',()=>{
    let s=driver.slice(driver.indexOf('function need('),driver.indexOf('function chain('));
    for(const [a,b]of [["v.schema==='codex-l2-member-job/2'&&v.mode==='normal'","v.schema==='codex-l2-root-only-job/1'&&v.mode==='rootOnly'"],['v.totalProcesses===2','v.totalProcesses===1'],["Buffer.from('L2_NORMAL')","Buffer.from('L2_ROOT_ONLY')"],["o.failure==='NONE'&&o.stopped,'NORMAL_CONTRADICTION'","o.failure==='NONE'&&o.stopped&&o.identityCoverage&&o.members.length===1&&o.members[0].root&&o.members[0].image==='FIXED_NODE'&&o.members[0].pathClass==='FIXED_NODE_PATH','ROOT_ONLY_CONTRADICTION'"],["'NORMAL_OUTPUT'","'ROOT_ONLY_OUTPUT'"],["originalNormalPassed:v.outcome==='completed'","rootOnlyPassed:v.outcome==='completed'"]])s=one(s,a,b);
    const actual=read(names.contract).toString('utf8');assert.equal(actual.slice(actual.indexOf('function need('),actual.indexOf('// Only bounded serialized JSON')),s+'\n');
    assert.doesNotMatch(actual,/\brequire\s*\(|\bprocess\.(?:binding|mainModule)|\beval\s*\(|\bFunction\s*\(/);
  });
  test('fixed config accepted and deeply frozen',()=>{const v=c.validateConfig(read(names.config));assert.equal(v.executionReady,false);assert.equal(v.artifactBound,false);assert.ok(Object.isFrozen(v.nodeArgs));assert.equal(v.creationFlags,0x08000000|4|0x400);});
  for(const [key,value]of [['mode','normal'],['node','other.exe'],['nodeArgs',['-e','unapproved']],['helperArgs',['rootOnly','normal']],['expectedProcesses',4],['output','L2_NORMAL'],['creationFlags',0],['environmentPairs',['NODE_OPTIONS=bad']],['memberLimit',17],['eventLimit',129],['driverTimeoutMs',10001],['executionReady',true],['artifactBound',true],['sources',[]],['exemption',true]])test('config rejects '+key,()=>assert.throws(()=>c.validateConfig(B({...config,[key]:value})),/CONFIG_MISMATCH/));
  const v={schema:'codex-l2-root-only-job/1',mode:'rootOnly',outcome:'completed',reason:'NONE',created:true,assigned:true,resumed:true,pid:100,rootExited:true,rootExit:0,jobEmpty:true,totalProcesses:1,activeProcesses:0,killRequested:false,killAccepted:false,readersDone:true,handlesClosed:true,cleanupConfirmed:true,stdoutBytes:12,stderrBytes:0,stdoutBase64:Buffer.from('L2_ROOT_ONLY').toString('base64'),elapsedMs:100,accountingLayoutVerified:true,observation:{failure:'NONE',identityCoverage:true,parentEvidenceComplete:false,notificationCompletenessGuaranteed:false,stopped:true,handlesClosed:true,duplicateNew:false,finalTotal:1,events:[{kind:'NEW',pid:100},{kind:'EXIT',pid:100},{kind:'ACTIVE_ZERO',pid:0}],members:[{pid:100,creationTime:'1',image:'FIXED_NODE',pathClass:'FIXED_NODE_PATH',state:'CAPTURED',root:true,parent:'UNKNOWN',newSeen:true,listed:true,exitSeen:true}]}};
  const f={attempts:1,unexpected:0,closed:true,status:0,signal:null,failure:null,killRequested:false,stderrBytes:0,receiptExistsBefore:false,sourcesBefore:true,sourcesAfter:true};
  test('valid single root is diagnostic only',()=>{const a=c.assess(B(v),0,B(f));assert.equal(a.ok,true);for(const k of ['l2Approved','transportRun','sourceChainComplete','parentEvidenceComplete','executionApproved','realInputApproved'])assert.equal(a[k],false);});
  const clone=()=>JSON.parse(JSON.stringify(v));
  function rejects(name,change){test(name,()=>{const x=clone();change(x);assert.throws(()=>c.assess(B(x),0,B(f)));});}
  for(const n of [0,2,4])rejects('count '+n+' rejected',x=>{x.totalProcesses=n;x.observation.finalTotal=n;x.observation.identityCoverage=false;});
  rejects('candidate cannot become single root success',x=>{x.observation.members[0].image='OTHER_IMAGE';x.observation.members[0].pathClass='WINDOWS_CONHOST_PATH_CANDIDATE';});
  for(const [key,value]of [['schema','codex-l2-member-job/2'],['mode','normal'],['mode','timeout'],['mode','transport'],['rootExit',1],['killRequested',true],['readersDone',false],['handlesClosed',false],['cleanupConfirmed',false],['accountingLayoutVerified',false],['stderrBytes',1],['elapsedMs',7501],['stdoutBytes',131073],['stdoutBase64',''],['observation',null],['extra','secret']])rejects('receipt '+key+' '+String(value),x=>{x[key]=value;});
  rejects('same length wrong output',x=>x.stdoutBase64=Buffer.from('L2_ROOT_ONLX').toString('base64'));
  rejects('active count contradicts empty',x=>x.activeProcesses=1);
  rejects('parent claim rejected',x=>x.observation.parentEvidenceComplete=true);
  rejects('observer not stopped',x=>x.observation.stopped=false);
  rejects('identity coverage missing',x=>x.observation.identityCoverage=false);
  rejects('observer close failed',x=>x.observation.handlesClosed=false);
  rejects('event/member disagreement',x=>x.observation.members[0].exitSeen=false);
  rejects('unknown member property',x=>x.observation.members[0].rawPath='secret');
  for(const [key,value]of [['attempts',0],['attempts',2],['unexpected',1],['closed',false],['status',1],['signal','SIGKILL'],['failure','TIMEOUT'],['failure','SPAWN_FAILED'],['failure','OUTPUT_LIMIT'],['killRequested',true],['stderrBytes',1],['receiptExistsBefore',true],['sourcesBefore',false],['sourcesAfter',false]])test('runner '+key+' '+value,()=>assert.throws(()=>c.assess(B(v),0,B({...f,[key]:value})),/DRIVER_FAILED/));
  for(const raw of [Buffer.from([0xff]),Buffer.alloc(131073),Buffer.from('{'),v])test('invalid bounded receipt '+results.length,()=>assert.throws(()=>c.assess(raw,0,B(f))));
  for(const reason of ['TREE_COUNT','TIMEOUT','SOURCE_HASH','CREATE','OUTPUT_LIMIT'])test('failed '+reason+' remains failed',()=>{const x=clone();x.outcome='failed';x.reason=reason;x.stdoutBase64='';const a=c.assess(B(x),1,B({...f,status:1}));assert.equal(a.ok,false);assert.equal(a.l2Approved,false);});
  test('contract exports no launch or raw object inspection',()=>assert.deepEqual(Object.keys(c).sort(),['assess','parseReceipt','validateConfig']));
  test('old early-close failure shape can overclaim cleanup',()=>{
    const x=clone();Object.assign(x,{outcome:'failed',reason:'HANDLE_CLOSE',resumed:false,rootExit:9009,killRequested:true,killAccepted:true,stdoutBytes:0,stdoutBase64:''});
    // Source-derived counterexample shape, NOT observed C# execution.
    const a=c.parseReceipt(B(x),1);assert.equal(a.rootOnlyPassed,false);assert.equal(a.cleanupConfirmed,true);
    x.handlesClosed=false;x.cleanupConfirmed=false;const fixed=c.parseReceipt(B(x),1);assert.equal(fixed.cleanupConfirmed,false);
  });
  for(const late of ['observer','helper'])test('late '+late+' failure requires cleared body',()=>{
    const x=clone();x.outcome='failed';x.cleanupConfirmed=false;
    if(late==='observer'){x.reason='OBS_FAILURE';x.observation.failure='OBS_CLOSE';x.observation.handlesClosed=false;x.observation.identityCoverage=false;}else{x.handlesClosed=false;}
    assert.throws(()=>c.parseReceipt(B(x),1),/FAILED_EXIT/);
    x.stdoutBase64='';const a=c.parseReceipt(B(x),1);assert.equal(a.rootOnlyPassed,false);assert.equal(a.cleanupConfirmed,false);assert.equal(x.stdoutBytes,12);
  });
  const prep=require('./CodexL2单根收尾夹具准备v1-20261031.cjs');
  test('uncompiled fixture preserves selected helper source',()=>{const g=prep.build(read(names.helper));assert.equal(read('CodexL2单根收尾合成夹具v1-20261031.cs').toString('utf8'),g.source);assert.equal(g.plannedCases,13);assert.equal(g.compiled,false);assert.equal(g.executed,false);});
  test('fixture refuses source drift',()=>assert.throws(()=>prep.build(Buffer.concat([read(names.helper),Buffer.from(' ')])),/SOURCE_DRIFT/));
  test('fixture contains no production launch or native APIs',()=>{const g=prep.build(read(names.helper));assert.doesNotMatch(g.source,/DllImport|static extern|Process\.Start|File\.|Environment\.|Thread\.|Stopwatch\.|Marshal\./);assert.equal((g.source.match(/case [0-9]+:/g)||[]).length,13);});
  function startupOrder(source){
    const start=source.indexOf('  static Receipt Run(string mode) {'),end=source.indexOf('      int budget=5000;',start);assert.ok(start>=0&&end>start);const s=source.slice(start,end);
    const steps=['string[] args=Arguments(mode);nodeHold=Hold(Node,NodeHash);','VerifyAccountingLayout();','job=CreateJobObjectW(','SetInformationJobObject(','QueryLimits(','r.Observer=new L2MemberObserver(job);','CreatePipe(out rd,','CreatePipe(out er,','input=CreateFileW("NUL",','env=EnvironmentBlock();Require(CreateProcessW(','r.Created=true;r.Pid=pi.Pid;','Require(AssignProcessToJobObject(job,pi.Process),"JOB_ASSIGN");r.Assigned=true;','r.Observer.Root(pi.Pid,pi.Process);','Require(Close(ref wr,r)&Close(ref ew,r)&Close(ref input,r),"HANDLE_CLOSE");','outThread.Start();','errThread.Start();','Require(ResumeThread(pi.Thread)==1,"RESUME");r.Resumed=true;'];
    let previous=-1;for(const step of steps){assert.equal(s.split(step).length,2);const at=s.indexOf(step);assert.ok(at>previous);previous=at;}
    assert.ok(source.includes('if(args.Length!=1 || args[0]!="rootOnly")'));return true;
  }
  test('startup ordering source check only',()=>assert.equal(startupOrder(read(names.helper).toString('utf8')),true));
  test('startup source sensitivity: removed held hash gate',()=>assert.throws(()=>startupOrder(read(names.helper).toString('utf8').replace('nodeHold=Hold(Node,NodeHash);',''))));
  test('startup source sensitivity: resume before assignment',()=>{
    let s=read(names.helper).toString('utf8');const resume='Require(ResumeThread(pi.Thread)==1,"RESUME");r.Resumed=true;';s=s.replace(resume,'');s=s.replace('Require(AssignProcessToJobObject(job,pi.Process)',resume+'Require(AssignProcessToJobObject(job,pi.Process)');assert.throws(()=>startupOrder(s));
  });
  // All reads and digest computations precede the sole final verdict.
  const runtimeDigests=Object.fromEntries(Object.entries(names).map(([k,n])=>[k,H(read(n))]));runtimeDigests.evidence=H(fs.readFileSync(__filename));runtimeDigests.fixtureBuilder=H(read('CodexL2单根收尾夹具准备v1-20261031.cjs'));runtimeDigests.fixture=H(read('CodexL2单根收尾合成夹具v1-20261031.cs'));
  if(fault){try{require('node:https').request('denied');}catch{}}
  report={schema:'codex-l2-root-only-offline/2',basisCommit:'32fd8c8',kind:'synthetic receipt validation and source comparison only',fault,checks:results.length,results,guard,runtimeDigests,limitations:['No helper or 13-case cleanup fixture compilation/execution','No Job, pipe or C# control flow dynamically tested','No runner exists yet: facts are synthetic, not authenticated runtime evidence','Old normal requires two; real four-member result remains failed'],ok:verdict(),executionApproved:false};
  report.exitCode=report.ok?0:1;
  const text=JSON.stringify(report,null,2)+'\n';if(args.length===2)fs.writeFileSync(args[1],text,{flag:'wx'});fs.writeSync(1,text);process.exitCode=report.exitCode;
}catch(e){probing=false;fs.writeSync(1,JSON.stringify({ok:false,exitCode:1,error:e.code||'OFFLINE_FAILURE',guard})+'\n');process.exitCode=1;}
