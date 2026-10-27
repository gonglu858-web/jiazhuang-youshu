'use strict';
// PREPARATION ONLY: executable binding must be separately built/reviewed/pinned.
// Changing this marker in the offline VM is disclosed; production remains disabled.
const RELEASE = Object.freeze({ready:false, helperSha256:null});
const cp=require('node:child_process');
const state={probes:0,unexpected:0,attempts:[]};let probing=false;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(ok,code)=>{if(!ok)fail(code);};
const deny=()=>{state[probing?'probes':'unexpected']++;fail('CAPABILITY_BLOCKED');};
const runFixed=(()=>{
  const spawn=cp.spawn.bind(cp),used=new Set();let active=false;
  return async kind=>{
    need(!active&&!used.has(kind),'RUNNER_SEQUENCE');need(KINDS.includes(kind),'RUNNER_PURPOSE');
    need(RELEASE.ready===true&&/^[a-f0-9]{64}$/.test(RELEASE.helperSha256||''),'EXECUTION_NOT_FROZEN');
    if(kind==='before')need(state.attempts.length===0,'RUNNER_SEQUENCE');
    else if(kind==='temporary')need(report.before!==null,'RUNNER_SEQUENCE');
    else if(kind==='normal')need(report.temporary!==null,'RUNNER_SEQUENCE');
    else if(kind==='timeout')need(report.jobs.normal?.passed===true,'RUNNER_SEQUENCE');
    else if(kind==='transport')need(report.jobs.timeout?.passed===true,'RUNNER_SEQUENCE');
    else need(used.has('temporary')&&state.attempts.every(a=>a.closed||a.spawnFailed)&&treeCertain,'CLEANUP_UNCONFIRMED');
    if(kind!=='after')need(state.unexpected===0,'CAPABILITY_BLOCKED');
    verifySources(true);zoneAbsent();
    const helper=JOBS.includes(kind),exe=helper?HELPER:PS;
    // All command vectors originate here; no caller arrays/path/env overrides.
    const args=helper?[kind]:['-NoProfile','-NonInteractive',...(kind==='temporary'?['-ExecutionPolicy','RemoteSigned']:[]),'-Command',kind==='before'?META_ZONE:META];
    const timeoutMs=helper?(kind==='transport'?20000:10000):10000;
    need(Date.now()-started+timeoutMs<=90000,'BUDGET_EXHAUSTED');
    const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase()==='NODE_OPTIONS')delete env[key];
    const a={kind,attempted:true,pid:null,closed:false,spawnFailed:false,status:null,signal:null,stdoutBytes:0,stderrBytes:0,killRequested:false,killAccepted:null,failed:false,reason:null};
    state.attempts.push(a);used.add(kind);active=true;
    if(helper)treeCertain=false;
    const result=await new Promise(resolve=>{
      let child,done=false,timer,reap,chunks=[],error=null;
      function finish(){if(done)return;done=true;clearTimeout(timer);clearTimeout(reap);a.failed=!!error;a.reason=error;active=!a.closed&&!a.spawnFailed;
        const out=error?null:Buffer.concat(chunks);for(const b of chunks)b.fill(0);chunks=[];resolve({out,error});}
      function stop(code){error||=code;if(done||a.closed||a.spawnFailed)return;if(!a.killRequested){a.killRequested=true;try{a.killAccepted=child.kill('SIGKILL')===true;}catch{a.killAccepted=false;}if(!done)reap=setTimeout(()=>{error='PROCESS_NOT_CLOSED';finish();},1000);}}
      try{child=spawn(exe,args,{cwd:ROOT,shell:false,windowsHide:true,env,stdio:['ignore','pipe','pipe']});}
      catch{a.spawnFailed=true;error='PROCESS_START_FAILED';if(helper)treeCertain=true;finish();return;}
      a.pid=Number.isSafeInteger(child.pid)&&child.pid>0?child.pid:null;
      child.on('error',()=>{if(!a.pid){a.spawnFailed=true;error='PROCESS_START_FAILED';if(helper)treeCertain=true;finish();}else stop('PROCESS_ERROR');});
      child.on('close',(code,signal)=>{a.closed=true;a.status=Number.isInteger(code)?code:null;a.signal=signal||null;
        // A failed helper can still supply a valid cleanup receipt. Parse it before deciding business success.
        if(a.signal||a.status===null||(!helper&&a.status!==0))error||='PROCESS_EXIT';finish();});
      function receive(stream,b){if(done)return;if(!Buffer.isBuffer(b)){stop('OUTPUT_BUFFER');return;}a[stream==='stdout'?'stdoutBytes':'stderrBytes']+=b.length;
        if(a.stdoutBytes+a.stderrBytes>WIRE_LIMIT){stop('OUTPUT_LIMIT');return;}if(stream==='stderr'&&b.length){stop('PROCESS_STDERR');return;}if(!error&&stream==='stdout')chunks.push(Buffer.from(b));}
      if(!child.stdout||!child.stderr)stop('PROCESS_STREAMS');else{
        child.stdout.on('data',b=>receive('stdout',b));child.stderr.on('data',b=>receive('stderr',b));child.stdout.on('error',()=>stop('STREAM_ERROR'));child.stderr.on('error',()=>stop('STREAM_ERROR'));
      }
      if(!done)timer=setTimeout(()=>stop('PROCESS_TIMEOUT'),timeoutMs);
    });
    need(!result.error,result.error);need(a.closed&&a.pid!==null,'PROCESS_NOT_CLOSED');
    return {raw:result.out,status:a.status};
  };
})();
// Independent offline harness also blocks the real OS beneath these guards.
for(const key of Object.keys(cp))if(typeof cp[key]==='function')cp[key]=deny;
for(const id of ['node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const key of Object.keys(m))if(typeof m[key]==='function')Object.defineProperty(m,key,{value:deny,configurable:true});}
for(const key of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[key]==='function')require('node:dns').promises[key]=deny;
const net=require('node:net');net.connect=net.createConnection=net.createServer=deny;net.Socket.prototype.connect=deny;globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const ROOT='C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const NODE='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCRIPT=path.join(ROOT,'miniapp/scripts/participant-private-input.ps1');
const SOURCE=path.join(__dirname,'CodexL2进程树辅助层-20261027.cs');
const HELPER=path.join(ROOT,'artifacts/psr-l2/v1/psr-l2-helper.exe');
const DECODER=path.join(ROOT,'miniapp/scripts/lib/participant-native-decoder.cjs');
const OUT=path.join(__dirname,'CodexL2固定Node驱动-20261027.json');
const PINNED=new Map([
 [NODE,'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19'],
 [PS,'60c9b29843624dd8af6b6a7b26147753be6aeef65098b9a503cc50850afe410f'],
 [SCRIPT,'9255adb762cd19801805ee19c04204dd8f8a3b384d8fc857ff36d44466db0790'],
 [DECODER,'462976b3cf32999fb0079d6b0bbb4cf54cd35ab3d1068fb1052db36f4c05f7d3'],
 [SOURCE,'31fafbe647ae044ff905823815e9c3a699a5840e7387aa4d9bcf8e39c5b551b6']
]);
const EXPECTED=Object.freeze(['C:\\synthetic package with spaces\\participant-private-store.cjs','protect','--repo-root','C:\\synthetic L2 root\\','--participant-code','1','--check-round-id','synthetic-l2-20261027','--source-digest','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','--delivery-confirmed','true','--check-window-starts-at-iso','2026-01-01T00:00:00.000Z','--check-window-expires-at-iso','','--file-name','synthetic "quoted" file.json','--server-time-iso','2026-01-01T00:00:01.000Z']);
const KINDS=['before','temporary','normal','timeout','transport','after'],JOBS=['normal','timeout','transport'];
const SCOPES=['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'];
const META_PREFIX="$ErrorActionPreference='Stop';Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security') -ErrorAction Stop;Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility') -ErrorAction Stop;[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);";
const META_OBJECT="@{schema='codex-l2-environment/1';version=$PSVersionTable.PSVersion.ToString();effectivePolicy=[string](Get-ExecutionPolicy);policies=@(Get-ExecutionPolicy -List | ForEach-Object {@{scope=[string]$_.Scope;policy=[string]$_.ExecutionPolicy}})";
const META=META_PREFIX+META_OBJECT+'} | ConvertTo-Json -Depth 5 -Compress';
const META_ZONE=META_PREFIX+"$z=@(Get-Item -LiteralPath '"+SCRIPT+"' -Stream * -ErrorAction Stop | Where-Object {$_.Stream -ceq 'Zone.Identifier'}).Count;"+META_OBJECT+";zonePresent=($z -gt 0)} | ConvertTo-Json -Depth 5 -Compress";
// The receipt envelope is bounded too; base64 expansion never relaxes 128KB.
const WIRE_LIMIT=128*1024,DATA_LIMIT=128*1024,started=Date.now();
let decoder,phase='arguments',treeCertain=true,execute=false,output=null;
const report={schema:'codex-l2-prepared-driver/1',basisCommit:'1006a81',releaseFrozen:RELEASE.ready,executionRequested:false,before:null,temporary:null,after:null,jobs:{normal:null,timeout:null,transport:null},sourceVerified:false,policyComparisonPassed:false,observations:state,failure:null,cleanupFailure:null,fullPreflightPassed:false,realInputApproved:false};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function chain(file){const full=path.resolve(file),root=path.parse(full).root;let p=root;const parts=full.slice(root.length).split(path.sep).filter(Boolean);const rs=fs.lstatSync(root);need(rs.isDirectory()&&!rs.isSymbolicLink(),'SOURCE_PATH');for(let i=0;i<parts.length;i++){p=path.join(p,parts[i]);const s=fs.lstatSync(p);need(!s.isSymbolicLink()&&(i===parts.length-1?s.isFile():s.isDirectory()),'SOURCE_PATH');}}
function verifySources(binary){need(process.execPath===NODE&&path.resolve(__dirname,'../..')===ROOT,'HOST_PATH');for(const [p,h]of PINNED){chain(p);need(hash(fs.readFileSync(p))===h,'SOURCE_DRIFT');}if(binary){chain(HELPER);need(hash(fs.readFileSync(HELPER))===RELEASE.helperSha256,'HELPER_HASH');}}
function zoneAbsent(){let fd;try{fd=fs.openSync(SCRIPT+':Zone.Identifier','r');}catch(e){if(e.code==='ENOENT')return;fail('ZONE_UNCERTAIN');}try{fs.closeSync(fd);}catch{fail('ZONE_UNCERTAIN');}fail('ZONE_PRESENT');}
function exact(o,keys){return o&&typeof o==='object'&&!Array.isArray(o)&&JSON.stringify(Object.keys(o).sort())===JSON.stringify([...keys].sort());}
function parse(raw){try{return JSON.parse(decoder.decodeUtf8Strict(raw));}catch{fail('OUTPUT_DECODE');}finally{raw.fill(0);}}
function metadata(result,kind){const v=parse(result.raw);const keys=['schema','version','effectivePolicy','policies'];if(kind==='before')keys.push('zonePresent');need(result.status===0&&exact(v,keys)&&v.schema==='codex-l2-environment/1'&&v.version==='5.1.26100.9711','META_SHAPE');need(Array.isArray(v.policies)&&v.policies.length===5&&v.policies.every(p=>exact(p,['scope','policy'])&&SCOPES.includes(p.scope))&&new Set(v.policies.map(p=>p.scope)).size===5,'META_SCOPES');const rows=SCOPES.map(scope=>({scope,policy:v.policies.find(p=>p.scope===scope).policy}));const temp=kind==='temporary';need(rows.every(p=>p.policy===(temp&&p.scope==='Process'?'RemoteSigned':'Undefined'))&&v.effectivePolicy===(temp?'RemoteSigned':'Restricted'),'POLICY');if(kind==='before')need(v.zonePresent===false,'ZONE_PRESENT');return {version:v.version,effectivePolicy:v.effectivePolicy,policies:rows};}
const RECEIPT_KEYS=['schema','mode','outcome','reason','created','assigned','resumed','pid','rootExited','rootExit','jobEmpty','totalProcesses','activeProcesses','killRequested','killAccepted','readersDone','handlesClosed','cleanupConfirmed','stdoutBytes','stderrBytes','stdoutBase64','elapsedMs'];
const REASONS=['NONE','MODE','SOURCE_MISSING','SOURCE_LINK','SOURCE_HASH','JOB_CREATE','JOB_SET','JOB_LIMITS','PIPE','STDIN','CREATE','JOB_ASSIGN','HANDLE_CLOSE','RESUME','JOB_QUERY','WAIT','EXIT_CODE','OUTPUT_LIMIT','STDERR','READ','TIMEOUT','ROOT_EXIT','TREE_COUNT','TIMEOUT_NOT_REACHED','HELPER_ERROR'];
function job(result,kind){
  const v=parse(result.raw);need(exact(v,RECEIPT_KEYS)&&v.schema==='codex-l2-job/1'&&v.mode===kind,'RECEIPT_SHAPE');
  for(const k of ['created','assigned','resumed','rootExited','jobEmpty','killRequested','killAccepted','readersDone','handlesClosed','cleanupConfirmed'])need(typeof v[k]==='boolean','RECEIPT_TYPE');
  for(const k of ['pid','rootExit','totalProcesses','activeProcesses','stdoutBytes','stderrBytes','elapsedMs'])need(Number.isSafeInteger(v[k])&&v[k]>=0,'RECEIPT_TYPE');
  need(['completed','expected-timeout','failed'].includes(v.outcome)&&REASONS.includes(v.reason)&&typeof v.stdoutBase64==='string','RECEIPT_TYPE');
  need(v.stdoutBytes+v.stderrBytes<=DATA_LIMIT&&v.stdoutBase64.length<=Math.ceil(DATA_LIMIT/3)*4,'RECEIPT_LIMIT');
  need(v.assigned? v.created:true,'RECEIPT_CONTRADICTION');need(v.resumed? v.assigned:true,'RECEIPT_CONTRADICTION');
  need(v.created?v.pid>0:v.pid===0,'RECEIPT_CONTRADICTION');need(v.jobEmpty===(v.activeProcesses===0),'RECEIPT_CONTRADICTION');
  const cleaned=(!v.created||v.rootExited)&&v.jobEmpty&&v.readersDone&&v.handlesClosed;
  need(v.cleanupConfirmed===cleaned,'RECEIPT_CONTRADICTION');treeCertain=cleaned;
  report.jobs[kind]={passed:false,outcome:v.outcome,reason:v.reason,created:v.created,assigned:v.assigned,resumed:v.resumed,pid:v.pid,rootExit:v.rootExit,totalProcesses:v.totalProcesses,activeProcesses:v.activeProcesses,cleanupConfirmed:cleaned,killRequested:v.killRequested,killAccepted:v.killAccepted,stdoutBytes:v.stdoutBytes,stderrBytes:v.stderrBytes,elapsedMs:v.elapsedMs};
  need(cleaned,'CLEANUP_UNCONFIRMED');need(result.status===0,'HELPER_EXIT');
  need(v.created&&v.assigned&&v.resumed&&v.rootExited&&v.totalProcesses===2&&v.stderrBytes===0,'JOB_FACTS');
  need(v.elapsedMs<=(kind==='transport'?17500:kind==='normal'?7500:4500),'JOB_BUDGET');
  if(kind==='timeout'){need(v.outcome==='expected-timeout'&&v.reason==='TIMEOUT'&&v.killRequested&&v.killAccepted&&v.rootExit===9009&&v.elapsedMs>=2000&&v.stdoutBytes===0&&v.stdoutBase64==='','TIMEOUT_SELFTEST');}
  else {
    need(v.outcome==='completed'&&v.reason==='NONE'&&v.rootExit===0&&!v.killRequested&&!v.killAccepted,'JOB_RESULT');
    let bytes=Buffer.from(v.stdoutBase64,'base64');try{
      need(bytes.toString('base64')===v.stdoutBase64&&bytes.length===v.stdoutBytes,'RECEIPT_BASE64');
      if(kind==='normal')need(decoder.decodeUtf8Strict(bytes)==='L2_NORMAL','NORMAL_SELFTEST');
      else {const payload=JSON.parse(decoder.decodeUtf8Strict(bytes));need(Array.isArray(payload)&&payload.length===20,'ARGV_SHAPE');const matched=EXPECTED.map((s,i)=>typeof payload[i]==='string'&&payload[i]===s);report.jobs[kind].argumentCount=payload.length;report.jobs[kind].matches=matched;need(matched.every(Boolean),'ARGV_MISMATCH');}
    }catch(e){if(['RECEIPT_BASE64','NORMAL_SELFTEST','ARGV_SHAPE','ARGV_MISMATCH'].includes(e.code))throw e;fail('ARGV_DECODE');}finally{bytes.fill(0);}
  }
  report.jobs[kind].passed=true;
}
const CODES=new Set(('RUNNER_SEQUENCE RUNNER_PURPOSE EXECUTION_NOT_FROZEN CLEANUP_UNCONFIRMED CAPABILITY_BLOCKED BUDGET_EXHAUSTED PROCESS_START_FAILED PROCESS_NOT_CLOSED PROCESS_ERROR PROCESS_EXIT OUTPUT_BUFFER OUTPUT_LIMIT PROCESS_STDERR PROCESS_STREAMS STREAM_ERROR PROCESS_TIMEOUT HOST_PATH SOURCE_DRIFT SOURCE_PATH HELPER_HASH ZONE_UNCERTAIN ZONE_PRESENT OUTPUT_DECODE META_SHAPE META_SCOPES POLICY RECEIPT_SHAPE RECEIPT_TYPE RECEIPT_LIMIT RECEIPT_CONTRADICTION HELPER_EXIT JOB_FACTS JOB_BUDGET TIMEOUT_SELFTEST JOB_RESULT RECEIPT_BASE64 NORMAL_SELFTEST ARGV_SHAPE ARGV_MISMATCH ARGV_DECODE ARGUMENT_INVALID OUTPUT_EXISTS PROBE_FAILED POLICY_COMPARISON').split(' '));
const reason=e=>CODES.has(e?.code)?e.code:'UNEXPECTED_LOCAL_FAILURE';
(async()=>{
  try{
    const args=process.argv.slice(2);need(args.length===0||args.length===1&&args[0]==='--execute'||args.length===3&&args[0]==='--execute'&&args[1]==='--out'&&path.resolve(args[2])===OUT,'ARGUMENT_INVALID');
    execute=args[0]==='--execute';if(args.length===3){let exists=false;try{fs.lstatSync(OUT);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}need(!exists,'OUTPUT_EXISTS');output=OUT;}
    probing=true;try{cp.execSync('synthetic-denied');}catch{}try{require('node:https').request('https://synthetic.invalid');}catch{}probing=false;need(state.probes===2,'PROBE_FAILED');
    phase='sources';verifySources(false);const m={exports:{}};vm.runInNewContext('(function(module){'+fs.readFileSync(DECODER).toString('utf8')+'\n})',{Buffer,TextDecoder},{timeout:1000})(m);decoder=m.exports;report.sourceVerified=true;
    if(execute){phase='release';need(RELEASE.ready===true&&/^[a-f0-9]{64}$/.test(RELEASE.helperSha256||''),'EXECUTION_NOT_FROZEN');
      phase='before';report.before=metadata(await runFixed('before'),'before');phase='temporary';report.temporary=metadata(await runFixed('temporary'),'temporary');
      for(const kind of JOBS){phase=kind;job(await runFixed(kind),kind);verifySources(true);}
    }
  }catch(e){probing=false;report.failure={phase,code:reason(e)};}
  finally {
    if(state.attempts.some(a=>a.kind==='temporary')){
      if(treeCertain&&state.attempts.every(a=>a.closed||a.spawnFailed))try{phase='after';report.after=metadata(await runFixed('after'),'after');report.policyComparisonPassed=JSON.stringify(report.before)===JSON.stringify(report.after);need(report.policyComparisonPassed,'POLICY_COMPARISON');}catch(e){report.cleanupFailure={phase:'after',code:reason(e)};}
      else report.cleanupFailure={phase:'after',code:'CLEANUP_UNCONFIRMED'};
    }
    phase='finalization';try{if(report.sourceVerified)verifySources(execute&&RELEASE.ready);report.digests={driver:hash(fs.readFileSync(__filename)),helperSource:hash(fs.readFileSync(SOURCE)),helperBinary:RELEASE.helperSha256,metadata:hash(META),metadataZone:hash(META_ZONE)};}catch(e){report.failure={phase,code:reason(e)};}
    report.elapsedMs=Date.now()-started;if(report.elapsedMs>90000)report.failure={phase,code:'BUDGET_EXHAUSTED'};
    report.executionRequested=execute;report.processTreeCleanupConfirmed=treeCertain;report.allDirectProcessesClosed=state.attempts.every(a=>a.closed||a.spawnFailed);
    report.notRun=['P4','UI','DPAPI','private-save','cloud'];
    report.ok=execute&&RELEASE.ready&&!report.failure&&!report.cleanupFailure&&report.policyComparisonPassed&&treeCertain&&report.allDirectProcessesClosed&&JOBS.every(k=>report.jobs[k]?.passed)&&state.unexpected===0&&state.attempts.every(a=>!a.failed);
    report.exitCode=report.ok?0:!execute&&!report.failure&&state.unexpected===0?2:1;
    try{const json=JSON.stringify(report,null,2)+'\n';if(output)fs.writeFileSync(output,json,{flag:'wx'});process.stdout.write(json);process.exitCode=report.exitCode;}catch{process.stdout.write('{"ok":false,"exitCode":1,"failure":{"code":"EVIDENCE_WRITE_FAILED"}}\n');process.exitCode=1;}
  }
})();
