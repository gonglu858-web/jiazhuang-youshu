'use strict';
// Independent real-OS fallback. This test never compiles/loads native code.
let fallbackHits=0;function deny(){fallbackHits++;throw Error('REAL_OS_DENIED');}
const cp=require('node:child_process');for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const id of ['node:http','node:https','node:net','node:tls','node:dgram','node:dns']){const m=require(id);if(id==='node:net')m.Socket.prototype.connect=deny;if(id==='node:dns')for(const k of Object.keys(m.promises))if(typeof m.promises[k]==='function')m.promises[k]=deny;for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const DIR=__dirname,ROOT=path.resolve(DIR,'../..'),DRIVER=path.join(DIR,'CodexL2成员诊断驱动-20261028.cjs'),OUT=path.join(DIR,'CodexL2成员诊断离线-20261028.json');
const source=fs.readFileSync(DRIVER,'utf8'),H=b=>crypto.createHash('sha256').update(b).digest('hex');
const runner=fs.readFileSync(path.join(DIR,'CodexL2成员诊断辅助层-20261028.cs'),'utf8'),observer=fs.readFileSync(path.join(DIR,'CodexL2成员观察器-20261028.cs'),'utf8');
const config=JSON.parse(fs.readFileSync(path.join(DIR,'CodexL2成员诊断编译草案-20261028.json')));
const definitions=JSON.parse(fs.readFileSync(config.definitionRecord.path));
const results=[],staticChecks=[];
function test(name,fn){fn();results.push({name,passed:true});}
function stat(name,yes){assert(yes,name);staticChecks.push({name,passed:true,kind:'source-observation-not-native-execution'});}
function context(args=null,mode='normal'){
  const mods=new Map(),calls=[];let text='',ctx,hit=false;
  function inject(){try{mods.get('node:https').request();}catch{}}
  function req(id){
    if(id==='node:fs')return {writeSync(fd,s){if(fd!==1)throw Error('BAD_FD');text+=s;},lstatSync:fs.lstatSync,existsSync:fs.existsSync,readFileSync(p){
      if(!hit&&((mode==='readHit'&&p===DRIVER)||(mode==='earlyHit'&&String(p).includes('编译草案')))){hit=true;inject();}
      const b=fs.readFileSync(p);if(mode==='configDrift'&&String(p).includes('编译草案'))return Buffer.concat([b,Buffer.from(' ')]);return b;
    }};
    if(id==='node:path')return path;if(id==='node:crypto')return crypto;
    if(!mods.has(id)){const f=()=>{calls.push(id);throw Error('FAKE_OS_CALLED');};const m={spawn:f,execSync:f,request:f,connect:f};if(id==='node:net'){m.Socket=function(){};m.Socket.prototype.connect=f;}if(id==='node:dns')m.promises={lookup:f};mods.set(id,m);}return mods.get(id);
  }
  const module={exports:{}};req.main=args===null?{}:module;
  const process={execPath:config.host.path,argv:[config.host.path,DRIVER,...(args||[])],stdout:{write:s=>{text+=s;}},exitCode:undefined};
  ctx=vm.createContext({require:req,module,__dirname:DIR,__filename:DRIVER,process,Buffer,TextDecoder,console:undefined});
  vm.runInContext(source,ctx,{timeout:3000});return {api:module.exports,report:text?JSON.parse(text):null,exit:process.exitCode,calls};
}
const api=context().api;
function member(pid,root){return {pid,creationTime:String(100000+pid),image:'FIXED_NODE',state:'CAPTURED',root,parent:'UNKNOWN',newSeen:true,listed:true,exitSeen:true};}
function receipt(n=2){const members=Array.from({length:n},(_,i)=>member(100+i,i===0));return {schema:'codex-l2-member-job/1',mode:'normal',outcome:n===2?'completed':'failed',reason:n===2?'NONE':'TREE_COUNT',created:true,assigned:true,resumed:true,pid:100,rootExited:true,rootExit:0,jobEmpty:true,totalProcesses:n,activeProcesses:0,killRequested:n!==2,killAccepted:n!==2,readersDone:true,handlesClosed:true,cleanupConfirmed:true,stdoutBytes:9,stderrBytes:0,stdoutBase64:n===2?Buffer.from('L2_NORMAL').toString('base64'):'',elapsedMs:500,accountingLayoutVerified:true,observation:{failure:'NONE',identityCoverage:true,parentEvidenceComplete:false,notificationCompletenessGuaranteed:false,stopped:true,handlesClosed:true,duplicateNew:false,finalTotal:n,events:members.flatMap(m=>[{kind:'NEW',pid:m.pid},{kind:'EXIT',pid:m.pid}]),members}};}
function reject(name,change,status=0){test('reject '+name,()=>{const r=receipt();change(r);assert.throws(()=>api.inspectReceipt(r,status));});}
let report;
try{
  const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===OUT);if(args.length)assert(!fs.existsSync(OUT));
  test('prepared CLI zero OS and exit2',()=>{const x=context([]);assert(x.report.preparationValidated);assert.equal(x.exit,2);assert.equal(x.calls.length,0);assert.equal(x.report.executionReady,false);assert.equal(x.report.observations.probes,2);});
  for(const a of [['--execute'],['normal'],['--out','elsewhere'],['--mode','transport'],['--helper','other'],['--pid','1'],['--policy','RemoteSigned']])test('CLI rejects '+a[0]+':'+(a[1]||''),()=>{const x=context(a);assert.equal(x.exit,1);assert.equal(x.report.failure,'EXECUTION_DISABLED');assert.equal(x.calls.length,0);});
  for(const mode of ['configDrift','earlyHit','readHit'])test('guard/drift '+mode,()=>{const x=context([],mode);assert.equal(x.exit,1);assert(!x.report.preparationValidated);assert.equal(x.calls.length,0);if(mode!=='configDrift')assert.equal(x.report.observations.unexpected,1);});
  test('normal receipt does not approve L2 or parent chain',()=>{const r=api.inspectReceipt(receipt(),0);assert(r.originalNormalPassed&&r.identityCoverage&&r.diagnosticCollected);assert(!r.l2Approved&&!r.parentEvidenceComplete&&!r.sourceChainComplete&&!r.transportRun);});
  test('four known members remain original failure',()=>{const r=api.inspectReceipt(receipt(4),1);assert(r.diagnosticCollected&&r.identityCoverage&&!r.originalNormalPassed&&!r.l2Approved);});
  test('short-lived member unknown is preserved',()=>{const r=receipt(4);r.observation.identityCoverage=false;Object.assign(r.observation.members[3],{state:'EXIT_WITHOUT_IDENTITY',image:'UNKNOWN',creationTime:null});assert(!api.inspectReceipt(r,1).identityCoverage);});
  test('missed members never coverage',()=>{const r=receipt(4);r.observation.identityCoverage=false;r.observation.members.pop();r.observation.events=r.observation.events.filter(e=>e.pid!==103);assert(!api.inspectReceipt(r,1).identityCoverage);});
  test('other image not silently approved',()=>{const r=receipt(4);r.observation.members[3].image='OTHER_IMAGE';const v=api.inspectReceipt(r,1);assert(!v.l2Approved&&!v.sourceChainComplete);});
  test('unknown parent explicit even normal',()=>assert.equal(api.inspectReceipt(receipt(),0).parentEvidenceComplete,false));
  const variants=[
    ['wrong schema',r=>r.schema='old'],['wrong mode',r=>r.mode='transport'],['extra field',r=>r.secret='synthetic'],['missing total',r=>delete r.totalProcesses],['string count',r=>r.totalProcesses='2'],['negative pid',r=>r.pid=-1],['active over total',r=>r.activeProcesses=3],['empty contradiction',r=>r.jobEmpty=false],['resumed without assigned',r=>r.assigned=false],['kill accepted without request',r=>r.killAccepted=true],['oversized output',r=>r.stdoutBytes=131073],['over budget',r=>r.elapsedMs=7501],['cleanup lied',r=>r.cleanupConfirmed=false],['open pipe',r=>r.readersDone=false],['open handles',r=>r.handlesClosed=false],['layout missing',r=>r.accountingLayoutVerified=false],['wrong root exit',r=>r.rootExit=3],['base64 invalid',r=>r.stdoutBase64+='!'],['wrong output',r=>r.stdoutBase64=Buffer.from('BAD').toString('base64')],['stderr',r=>r.stderrBytes=1],
    ['observation missing',r=>r.observation=null],['obs extra',r=>r.observation.path='synthetic'],['parent claim',r=>r.observation.parentEvidenceComplete=true],['event completeness claim',r=>r.observation.notificationCompletenessGuaranteed=true],['obs total mismatch',r=>r.observation.finalTotal=4],['member capacity',r=>r.observation.members=Array.from({length:17},(_,i)=>member(100+i,i===0))],['event capacity',r=>r.observation.events=Array(129).fill({kind:'NEW',pid:100})],['duplicate identity',r=>r.observation.members[1].pid=100],['arbitrary image path',r=>r.observation.members[1].image='C:\\synthetic-secret.exe'],['arbitrary state',r=>r.observation.members[1].state='trusted-system'],['invented parent',r=>r.observation.members[1].parent=100],['invalid time',r=>r.observation.members[1].creationTime='0'],['captured missing time',r=>r.observation.members[1].creationTime=null],['unknown with image',r=>r.observation.members[1].state='UNAVAILABLE'],['wrong root',r=>r.observation.members[1].root=true],['duplicate NEW lie',r=>r.observation.events.push({kind:'NEW',pid:100})],['event unknown pid',r=>r.observation.events.push({kind:'NEW',pid:999})],['event flags lie',r=>r.observation.members[1].newSeen=false],['obs not stopped',r=>r.observation.stopped=false],['obs handles open',r=>r.observation.handlesClosed=false],['obs failure',r=>r.observation.failure='OBS_QUEUE'],['coverage missing member',r=>{r.observation.members.pop();r.observation.events=r.observation.events.filter(e=>e.pid===100);}]
  ];for(const [n,f]of variants)reject(n,f);
  test('duplicated new fact prevents coverage but retained',()=>{const r=receipt(4);r.observation.events.push({kind:'NEW',pid:100});r.observation.duplicateNew=true;r.observation.identityCoverage=false;assert(!api.inspectReceipt(r,1).identityCoverage);});
  test('reordered events are not invented parent evidence',()=>{const r=receipt();r.observation.events.reverse();assert(!api.inspectReceipt(r,0).parentEvidenceComplete);});
  test('failed native exit cannot be exit0',()=>assert.throws(()=>api.inspectReceipt(receipt(4),0)));
  test('completed cannot be exit1',()=>assert.throws(()=>api.inspectReceipt(receipt(),1)));
  test('failed with no cause and clean receipt rejected',()=>{const r=receipt();r.outcome='failed';r.stdoutBase64='';assert.throws(()=>api.inspectReceipt(r,1));});
  for(const raw of [Buffer.from([0xff]),Buffer.from('\ufffd'),Buffer.from('{'),Buffer.alloc(131073), 'not-buffer'])test('wire rejection '+results.length,()=>assert.throws(()=>api.parseReceipt(raw,0)));
  test('strict wire valid receipt',()=>assert(api.parseReceipt(Buffer.from(JSON.stringify(receipt())),0).originalNormalPassed));
  test('non-symmetric accounting byte oracle (JS only)',()=>{const b=Buffer.alloc(48);[11n,22n,33n,44n].forEach((v,i)=>b.writeBigInt64LE(v,i*8));[55,4,0,2].forEach((v,i)=>b.writeUInt32LE(v,32+i*4));assert.equal(b.readUInt32LE(36),4);assert.equal(b.readUInt32LE(40),0);assert.equal(b.readUInt32LE(44),2);assert.notEqual(b.readUInt32LE(32),b.readUInt32LE(36));});
  const old=fs.readFileSync(path.join(DIR,'CodexL2进程树辅助层-20261027.cs'),'utf8');
  const normal=s=>s.split(/\r?\n/).find(l=>l.includes('if (mode == "normal") return'));
  stat('normal payload byte-identical',normal(old)===normal(runner));
  stat('single normal entry',runner.includes('args[0]!="normal"')&&!/SelfTestTransport|RemoteSigned|PSHash/.test(runner));
  stat('strict total2 retained',runner.includes('Require(r.Total==2,"TREE_COUNT")'));
  stat('observer before assign/resume',runner.indexOf('new L2MemberObserver(job)')<runner.indexOf('Require(AssignProcessToJobObject')&&runner.indexOf('r.Observer.Root')<runner.indexOf('Require(ResumeThread'));
  stat('root borrowed, no reopen',observer.includes('Capture(m,handle)')&&observer.includes('if(h==IntPtr.Zero) {h=OpenProcess'));
  stat('query minimal rights',observer.includes('OpenProcess(0x1000|0x00100000,false,m.Pid)'));
  stat('no arbitrary OS enumeration/files',!/(Toolhelp|ManagementObject|Process.GetProcesses|File\.|FileStream|ReadAll|SHA256|GetEnvironment|NtQuery)/.test(observer));
  stat('bounded members/events/census',observer.includes('MemberLimit=16, EventLimit=128')&&observer.includes('count>MemberLimit')&&observer.includes('OBS_EVENT_LIMIT'));
  stat('observer no thread/no sleeping',!/(new Thread|Thread.Sleep|Task\.)/.test(observer));
  stat('state frozen against reopen',observer.includes('if(m.State!="UNKNOWN")return;')&&observer.includes('m.State="UNAVAILABLE";'));
  stat('membership and creation rechecked',observer.includes('c2.Value!=c.Value')&&observer.includes('IsProcessInJob(h,job,out inJob)'));
  stat('unknown parent explicit',observer.includes('parentEvidenceComplete\\\":false')&&observer.includes('parent\\\":\\\"UNKNOWN'));
  stat('no notification completeness claim',observer.includes('notificationCompletenessGuaranteed\\\":false'));
  stat('root handle retained until observer stop',runner.indexOf('r.Observer.Stop(r.Total)')<runner.indexOf('r.HandlesClosed=Close(ref pi.Thread)'));
  stat('layout runtime probe pending',runner.includes('Marshal.SizeOf(typeof(Accounting))==48')&&runner.includes('Marshal.PtrToStructure')&&runner.includes('a.Total==4&&a.Active==0&&a.Terminated==2'));
  stat('suspended flags unchanged',runner.includes('Suspended|NoWindow|UnicodeEnvironment'));
  stat('owned Job termination retained',runner.includes('r.Assigned?TerminateJobObject(job,9009):TerminateProcess(pi.Process,9009)'));
  stat('time limits retained',runner.includes('int budget=5000;')&&runner.includes('while(reap.ElapsedMilliseconds<2000)'));
  stat('closed driver has no private spawn',!source.includes('cp.spawn.bind')&&!source.includes('spawn(exe')&&source.includes('ready:false,helperSha256:null'));
  for(const f of definitions.files)test('SDK definition '+path.basename(f.file),()=>{const b=fs.readFileSync(f.file);assert.equal(H(b),f.sha256);const lines=b.toString().split(/\r?\n/);for(const a of f.anchors)assert(lines[a.line-1].includes(a.name));});
  test('draft exact fixed args and no old output',()=>{assert.equal(config.executionAuthorized,false);assert.equal(config.helperExecutionAuthorized,false);assert.equal(config.args.filter(a=>a.startsWith('/out:')).length,1);assert(config.args.includes('/main:L2MemberRunner'));assert.deepEqual(config.args.slice(-2),config.sources.map(f=>f.path));assert.equal(config.outputFile,path.join(ROOT,'artifacts/psr-l2/member-diag-v1/psr-l2-member-diag.exe'));assert(!fs.existsSync(config.outputRoot));assert.equal(config.spawn.maxDirectCompilerStarts,1);assert.equal(config.postcheck.executeOutput,false);
    const frame='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';assert.deepEqual(config.args,['/nologo','/noconfig','/nostdlib+','/target:exe','/platform:x64','/langversion:5','/codepage:65001','/utf8output','/optimize+','/debug-','/warn:4','/warnaserror+','/errorreport:none','/nowin32manifest','/main:L2MemberRunner','/reference:'+frame+'\\mscorlib.dll','/reference:'+frame+'\\System.dll','/out:'+config.outputFile,...config.sources.map(f=>f.path)]);
  });
  test('source and draft pin binding',()=>{for(const f of [...config.sources,config.definitionRecord])assert.equal(H(fs.readFileSync(f.path)),f.sha256);assert(source.includes(H(fs.readFileSync(path.join(DIR,'CodexL2成员诊断编译草案-20261028.json')))));});
  const digests={driver:H(fs.readFileSync(DRIVER)),runner:H(Buffer.from(runner)),observer:H(Buffer.from(observer)),script:H(fs.readFileSync(__filename)),config:H(fs.readFileSync(path.join(DIR,'CodexL2成员诊断编译草案-20261028.json')))};
  report={schema:'codex-l2-member-offline/1',basisCommit:'2627a0a',tests:results.length,results,staticChecks,definitions:definitions.files.map(f=>({file:f.file,sha256:f.sha256})),digests,actualOSStarts:0,compiled:false,nativeLoaded:false,fallbackHits,limitations:['C# not compiled or executed; source observations only','Marshal and native observer state machine not dynamically tested','Receipt rejection tests execute real JavaScript validator with synthetic native facts','Parent relations deliberately UNKNOWN; notification completeness not guaranteed','No private OS runner exists in preparation driver; later executable binding needs new review']};
  report.ok=fallbackHits===0;report.exitCode=report.ok?0:1;
  const json=JSON.stringify(report,null,2)+'\n';if(args.length)fs.writeFileSync(OUT,json,{flag:'wx'});fs.writeSync(1,args.length?JSON.stringify({ok:report.ok,tests:results.length,staticChecks:staticChecks.length,fallbackHits})+'\n':json);process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,tests:results.length,staticChecks:staticChecks.length,fallbackHits,error:String(e.message).slice(0,200)})+'\n');process.exitCode=1;}
