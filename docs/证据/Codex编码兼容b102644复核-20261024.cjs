'use strict';
// 仅本地合成复核：真实受审模块/证据源码，OS进程、管道和私密FS全部替身。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const NATIVE='miniapp/scripts/lib/participant-native-exec.cjs',LOCAL='miniapp/scripts/lib/participant-local-tools.cjs';
const DEC='miniapp/scripts/lib/participant-native-decoder.cjs',EV='docs/证据/CodeBuddy本地编码模块兼容返修v4-20261024.cjs';
const outerHits=[];let outerPhase='probe';
const guard=require(path.join(ROOT,'miniapp/tests/helpers/psr-guard-runner.cjs'));
const installOuter=()=>guard.installParentGuardsWithLocalTools({hits:outerHits,getPhase:()=>outerPhase,allowedScripts:[]});
installOuter();assert.throws(()=>require('node:https').request('https://synthetic.invalid'));
assert.throws(()=>require('node:child_process').execSync('synthetic-never-run'));outerPhase='review';
const fixture=require(path.join(ROOT,'miniapp/tests/helpers/psr-repair-fixtures.cjs'));
const decoder=require(path.join(ROOT,DEC)),sourceOriginal=fs.readFileSync(path.join(ROOT,EV),'utf8');
const ok=b=>({status:0,stdout:b,stderr:Buffer.alloc(0)});
const gbTail=Buffer.concat([Buffer.from([0xd2,0xd1,0xb3,0xc9,0xb9,0xa6,0xb4,0xa6,0xc0,0xed]),Buffer.from(' 1 '),
 Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe]),Buffer.from('; '),Buffer.from([0xb4,0xa6,0xc0,0xed]),Buffer.from(' 0 '),
 Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe,0xca,0xb1,0xca,0xa7,0xb0,0xdc])]);
const probe=Buffer.concat([Buffer.from('synthetic:(F)\r\n'),gbTail,Buffer.from('\r\n')]);
function boundaryCases(){
 const calls=[];
 const cp={spawnSync(exe,args,opts){calls.push({api:'spawnSync',program:path.win32.basename(exe),args:[...args]});return ok(Buffer.alloc(0));},
  spawn(exe,args,opts){calls.push({api:'spawn',program:path.win32.basename(exe),args:[...args]});return {};},
  execFileSync(){return '';}};
 const cap=fixture.load(NATIVE,{'node:child_process':cp,'node:net':{connect(){return {};}}});
 for(const k of Object.keys(cp))cp[k]=()=>{throw Error('synthetic public blocked');};
 assert.throws(()=>cp.spawnSync());
 const requests=[
  ['arbitraryPowerShell',()=>cap.runProgram({program:'powershell',args:['-NoProfile','-Command','Write-Output synthetic-unapproved']})],
  ['gitWriteOperation',()=>cap.runProgram({program:'git',args:['config','--local','synthetic.probe','true']})],
  ['aclMutation',()=>cap.runProgram({program:'icacls',args:['synthetic-target','/grant','Everyone:F']})],
  ['asyncCommentAnchor',()=>cap.spawnProgram({purpose:'dpapi-unprotect',script:'# Import-Module -Name (Join-Path $PSHOME\nWrite-Output synthetic-unapproved'})]
 ];
 const results=[];for(const [label,fn] of requests){const before=calls.length;fn();assert.equal(calls.length-before,1);results.push({label,accepted:true,osStubCalls:1});}
 const faultCap=fixture.load(NATIVE,{'node:child_process':{spawn(){throw Error('synthetic spawn failure');},spawnSync(){return ok(Buffer.alloc(0));}},'node:net':{connect(){throw Error('synthetic connect failure');}}});
 assert.throws(()=>faultCap.spawnProgram({purpose:'dpapi-unprotect',script:'# Import-Module -Name (Join-Path $PSHOME'}));
 const failureRecord=faultCap.attempts()[0];assert.equal(failureRecord.spawnFailed,false);assert.equal(failureRecord.completed,false);
 const overwrite=fixture.load(NATIVE,{'node:child_process':{spawn(){return {};},spawnSync(){return ok(Buffer.alloc(0));}},'node:net':{}});
 const spawned=overwrite.spawnProgram({purpose:'dpapi-unprotect',script:'# Import-Module -Name (Join-Path $PSHOME'});
 overwrite.completeAsync(spawned.attemptId,{error:Error('synthetic failure')});
 overwrite.completeAsync(spawned.attemptId,{code:0});
 assert.equal(overwrite.attempts()[0].spawnFailed,false);
 return {requests:results,publicBlocked:true,synchronousSpawnFailureRecord:failureRecord,errorThenCloseZeroRecord:overwrite.attempts()[0],realProcesses:0};
}
async function evidenceCase(mode){
 installOuter();let source=sourceOriginal;
 const full=['normalFull','postS9Hit','s9Mismatch'].includes(mode);
 if(mode==='s9Mismatch')source=source.replace("const expectOk = mode === 'normal' && !fault;","const expectOk = false;");
 if(mode==='postS9Hit')source=source.replace('  // 进程计数下账反例',"  if (!IS_VM_CHILD) { try { require('node:https').request('https://synthetic-post-s9.invalid'); } catch (_) {} }\n  // 进程计数下账反例");
 const privateRoot=path.join(ROOT,'artifacts/schedule-sandbox/.participant-private');
 const calls=[],installs=[];let injected=false,stdout='',stderr='',complete;
 const done=new Promise(r=>complete=r);
 const proc={env:{},version:process.version,argv:['node',path.join(ROOT,EV),...(full?[]:['--vm-child'])],exitCode:0,
  stdout:{write(s){stdout+=s;complete();}},stderr:{write(s){stderr+=s;complete();}}};
 const historical='docs/证据/Codex编码兼容545d038复核-20261024.json';
 const cp={spawnSync(exe,args,opts){
  calls.push({kind:'sync',program:path.win32.basename(exe)});assert.equal(opts.shell,false);
  if(exe.endsWith('icacls.exe'))return ok(probe);
  if(exe.endsWith('whoami.exe'))return mode==='identityFail'?{status:1,stdout:Buffer.alloc(0),stderr:Buffer.from('synthetic failure')}:ok(Buffer.from('"synthetic\\current","'+fixture.sid+'"'));
  assert.ok(exe.endsWith('git.exe'));assert.equal(args[0],'check-ignore');return ok(Buffer.from(args[2]+'\n'));
 },spawn(){throw Error('REAL_ASYNC_FORBIDDEN');},execFileSync(exe,args,opts){
  calls.push({kind:'git',program:path.win32.basename(exe)});assert.equal(exe,'C:\\Program Files\\Git\\cmd\\git.exe');assert.ok(opts.timeout>0);
  if(mode==='lateGitHit'&&!injected){injected=true;try{require('node:https').request('https://synthetic-late-git.invalid');}catch(_){}}
  if(mode==='committedHistoryChange'&&args[0]==='diff'){
   const sep=args.indexOf('--'),paths=sep<0?[]:args.slice(sep+1);
   if(paths.length===0||paths.some(p=>historical===p||historical.startsWith(p+'/')))return historical+'\n';
  }
  return '';
 }};
 const native=fixture.load(NATIVE,{'node:child_process':cp,'node:net':{connect(){throw Error('REAL_PIPE_FORBIDDEN');}}});
 const fakeFs={existsSync(p){assert.equal(p,privateRoot);return true;},statSync(p){return {isDirectory:()=>p===privateRoot,isFile:()=>p!==privateRoot};},
  readFileSync(p,...args){
   assert.ok([EV,LOCAL,NATIVE,DEC,'AGENTS.md'].some(rel=>path.join(ROOT,rel)===p));
   if(mode==='runtimeDigestHit'&&p===path.join(ROOT,NATIVE)&&!injected){injected=true;try{require('node:https').request('https://synthetic-digest.invalid');}catch(_){}}
   if(p===path.join(ROOT,EV))return typeof args[0]==='string'?source:Buffer.from(source);
   return fs.readFileSync(p,...args);
  },writeFileSync(){throw Error('VM_WRITE_FORBIDDEN');}};
 const local=fixture.load(LOCAL,{'node:fs':fakeFs,'./participant-native-exec.cjs':native});
 const guardWrapper={installParentGuardsWithLocalTools(opts){installs.push(opts);return guard.installParentGuardsWithLocalTools(opts);}};
 const requireVm=n=>{
  if(n==='node:fs')return fakeFs;
  if(n===path.join(ROOT,NATIVE))return native;if(n===path.join(ROOT,LOCAL))return local;if(n===path.join(ROOT,DEC))return decoder;
  if(n===path.join(ROOT,'miniapp/tests/helpers/psr-guard-runner.cjs'))return guardWrapper;
  if(n===path.join(ROOT,'miniapp/tests/helpers/psr-repair-fixtures.cjs'))return fixture;
  assert.ok(['node:path','node:crypto','node:assert/strict','node:events','node:vm','node:https','node:dns','node:child_process'].includes(n));return require(n);
 };
 // 子模式仅禁重入S9；外层仍安装实际守卫，用于独立证据case。
 if(!full)source=source.replace('if (!IS_VM_CHILD) {\n  guardRunner.installParentGuardsWithLocalTools','if (true) {\n  guardRunner.installParentGuardsWithLocalTools');
 vm.runInNewContext(source,{require:requireVm,__dirname:path.join(ROOT,'docs/证据'),__filename:path.join(ROOT,EV),
  process:proc,Buffer,TextDecoder,Date,setTimeout,clearTimeout,queueMicrotask,console},{timeout:5000});
 let timeout;await Promise.race([done,new Promise((_,rej)=>{timeout=setTimeout(()=>rej(Error('VM_TIMEOUT')),15000);})]).finally(()=>clearTimeout(timeout));
 assert.equal(stderr,'');const r=JSON.parse(stdout);
 const s8=r.results.find(x=>x.id.startsWith('S8')),s9=r.results.find(x=>x.id.startsWith('S9')),s10=r.results.find(x=>x.id.startsWith('S10'));
 const expectedFalse=['identityFail','lateGitHit','postS9Hit','s9Mismatch'].includes(mode);
 assert.equal(r.ok,!expectedFalse);assert.equal(proc.exitCode||0,expectedFalse?1:0);
 assert.equal(calls.length,7);assert.equal(s10.actual.liveAttempts,7);assert.equal(installs.length,1);
 if(mode==='runtimeDigestHit'){assert.equal(installs[0].hits.length,5);assert.equal(r.guardAccounting.unexpectedHits,0);}
 if(mode==='s9Mismatch')assert.equal(s9.passed,false);
 if(mode==='postS9Hit'){assert.equal(s9.passed,true);assert.equal(r.guardAccounting.unexpectedHits,1);}
 return {mode,ok:r.ok,exit:proc.exitCode||0,identityRead:r.onlyReadFacts.identityRead,
  actualProcesses:calls.length,reportedFinalProcesses:s10.actual.liveAttempts,
  actualParentHits:installs[0].hits.length,reportedUnexpected:r.guardAccounting.unexpectedHits,
  guardInstallations:installs.length,s8Passed:s8.passed,s9Passed:s9.passed,
  vmScenarioCount:s9.actual.scenarios?s9.actual.scenarios.length:0,
  failedResults:r.results.filter(x=>!x.passed).map(x=>x.id)};
}
async function main(){
 const boundary=boundaryCases(),cases=[];
 for(const mode of ['normal','identityFail','lateGitHit','committedHistoryChange','runtimeDigestHit','normalFull','postS9Hit','s9Mismatch'])cases.push(await evidenceCase(mode));
 installOuter();const unexpected=outerHits.filter(h=>h.phase!=='probe').length;assert.equal(unexpected,0);
 const report={schema:'codex-native-compat-b102644-review/1',reviewedCommit:'b102644',basis:'acb6ecf',
  runtimeDigests:Object.fromEntries([LOCAL,NATIVE,DEC,EV].map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,p))).digest('hex')])),
  boundary,evidenceVm:cases,outerGuard:{probes:outerHits.length,unexpected},realOsQueries:0,dpapi:0,cloud:0,ok:true,
  limitations:['ok仅指独立对照符合预期，不是产品验收通过。','实际受审能力层/本地工具/证据源码，底层进程、管道及私密FS全为替身；没有真实执行写操作。',
   'committedHistoryChange模拟未在PROTECTED中的已有Codex历史JSON被修改且工作区干净，未触真实历史文件。',
   's9Mismatch只在内存改变正常场景预期，实际S9比较失败，验证最终exit1；不改磁盘脚本。',
   'runtimeDigestHit在受审明确运行步骤（摘要读取）触发被catch命中，父实际记录但较早guardAccounting快照漏计。']};
 const body=JSON.stringify(report,null,2)+'\n';if(process.argv.length===2)process.stdout.write(body);
 else if(process.argv.length===4&&process.argv[2]==='--out')fs.writeFileSync(path.resolve(process.argv[3]),body,{flag:'wx'});
 else throw Error('usage: node script [--out new-path]');
}
main().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});
