'use strict';
// 独立复查；真实受审源码，进程/管道/私密FS均为替身。禁止真实OS查询/DPAPI/UI/网络。
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const assert=require('node:assert/strict'), crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const LOCAL='miniapp/scripts/lib/participant-local-tools.cjs';
const NATIVE='miniapp/scripts/lib/participant-native-exec.cjs';
const DEC='miniapp/scripts/lib/participant-native-decoder.cjs';
const EV='docs/证据/CodeBuddy本地编码模块兼容返修v3-20261024.cjs';
const guard=require(path.join(ROOT,'miniapp/tests/helpers/psr-guard-runner.cjs'));
const outerHits=[];let outerPhase='probe';
function installOuter(){guard.installParentGuardsWithLocalTools({hits:outerHits,getPhase:()=>outerPhase,allowedScripts:[]});}
installOuter();
assert.throws(()=>require('node:https').request('https://synthetic.invalid'));
assert.throws(()=>require('node:child_process').execSync('synthetic-never-run'));
outerPhase='review';
const fixture=require(path.join(ROOT,'miniapp/tests/helpers/psr-repair-fixtures.cjs'));
const decoder=require(path.join(ROOT,DEC));
const original=fs.readFileSync(path.join(ROOT,EV),'utf8');
const privateRoot=path.join(ROOT,'artifacts/schedule-sandbox/.participant-private');
const gbTail=Buffer.concat([Buffer.from([0xd2,0xd1,0xb3,0xc9,0xb9,0xa6,0xb4,0xa6,0xc0,0xed]),Buffer.from(' 1 '),
  Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe]),Buffer.from('; '),Buffer.from([0xb4,0xa6,0xc0,0xed]),Buffer.from(' 0 '),
  Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe,0xca,0xb1,0xca,0xa7,0xb0,0xdc])]);
const probe=Buffer.concat([Buffer.from('synthetic:(F)\r\n'),gbTail,Buffer.from('\r\n')]);
const ok=b=>({status:0,stdout:b,stderr:Buffer.alloc(0)});
function nativeBoundaryCase(){
  const calls=[];
  const fakeCp={spawnSync(...a){calls.push({api:'spawnSync',args:a});return ok(Buffer.alloc(0));},
    spawn(...a){calls.push({api:'spawn',args:a});return {};},
    execFileSync(...a){calls.push({api:'execFileSync',args:a});return Buffer.alloc(0);}};
  const native=fixture.load(NATIVE,{'node:child_process':fakeCp,'node:net':{connect(...a){calls.push({api:'connect',args:a});return {};}}});
  // 原始引用捕获后公共接口阻断；受审导出的包装仍把任意参数交给捕获的边界替身。
  for(const k of Object.keys(fakeCp))fakeCp[k]=()=>{throw Error('synthetic public blocked');};
  assert.throws(()=>fakeCp.spawnSync('synthetic-unapproved'));
  native.spawnSync('synthetic-unapproved.exe',['arbitrary'],{shell:true,timeout:0});
  native.spawn('synthetic-unapproved.exe',['arbitrary'],{shell:true});
  native.execFile('synthetic-unapproved.exe',['arbitrary'],{});
  native.connect('synthetic-not-a-named-pipe');
  assert.equal(calls.length,4);
  const statuses=fixture.load(NATIVE,{'node:child_process':{
    spawnSync(){return {status:1,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};},
    spawn(){return {};},execFileSync(){return Buffer.alloc(0);}},'node:net':{connect(){return {};}}});
  statuses.spawnSync('synthetic.exe',[],{});statuses.spawn('synthetic.exe',[],{});
  const facts=statuses.attempts();
  assert.equal(facts[0].failed,false);assert.equal(facts[1].failed,true);
  return {publicBlocked:true,unapprovedBoundaryCalls:calls.map(c=>c.api),
    status1ReportedFailed:facts[0].failed,asyncNotYetFailedReportedFailed:facts[1].failed,
    realProcesses:0,realConnections:0};
}
async function evidenceCase(mode){
  installOuter();
  let source=original, stdout='',stderr='',resolveDone;
  if(mode==='s9Mismatch')source=source.replace("['normal', true, 0]", "['normal', false, 1]");
  const full=['normalFull','s9Mismatch','postS9Hit'].includes(mode);
  if(mode==='postS9Hit')source=source.replace('  const body = JSON.stringify(rep, null, 2)',
    "  if (!process.argv.includes('--vm-child')) { try { require('node:https').request('https://synthetic-late.invalid'); } catch (_) {} }\n  const body = JSON.stringify(rep, null, 2)");
  const done=new Promise(r=>resolveDone=r), installs=[], calls=[];
  const proc={env:{},version:process.version,argv:['node',path.join(ROOT,EV),...(full?[]:['--vm-child'])],exitCode:0,
    stdout:{write(s){stdout+=s;resolveDone();}},stderr:{write(s){stderr+=s;resolveDone();}}};
  let gitInjection=false;
  const cp={spawnSync(exe,args,opts){
    calls.push({api:'spawnSync',program:path.win32.basename(exe)});
    assert.equal(opts.shell,false);assert.ok(opts.timeout>0&&opts.maxBuffer>0);
    if(exe.endsWith('icacls.exe'))return ok(probe);
    if(exe.endsWith('whoami.exe'))return mode==='identityFail'
      ?{status:1,stdout:Buffer.alloc(0),stderr:Buffer.from('synthetic failure')}
      :ok(Buffer.from(mode==='identityNotCsv'?'not-csv':'"synthetic\\current","'+fixture.sid+'"'));
    assert.ok(exe.endsWith('git.exe'));assert.equal(args[0],'check-ignore');return ok(Buffer.from(args[2]+'\n'));
  },spawn(){throw Error('REAL_ASYNC_FORBIDDEN');},execFileSync(exe,args,opts){
    calls.push({api:'execFileSync',program:path.win32.basename(exe)});
    assert.equal(exe,'C:\\Program Files\\Git\\cmd\\git.exe');assert.ok(['diff','status'].includes(args[0]));
    assert.ok(opts.timeout>0&&opts.maxBuffer>0);
    if(mode==='lateGitHit'&&!gitInjection){gitInjection=true;try{require('node:https').request('https://synthetic-late.invalid');}catch(_){}}
    if(mode==='committedHistoryChange'&&args[0]==='diff'){
      const historical='docs/证据/CodeBuddy本地编码模块兼容返修v2-20261024.json';
      const paths=args.slice(args.indexOf('--')+1);
      if(paths.some(p=>historical===p||historical.startsWith(p+'/')))return Buffer.from(historical+'\n');
    }
    return Buffer.alloc(0);
  }};
  const native=fixture.load(NATIVE,{'node:child_process':cp,'node:net':{connect(){throw Error('REAL_PIPE_FORBIDDEN');}}});
  const fakeFs={existsSync(p){assert.equal(p,privateRoot);return true;},
    statSync(p){return {isDirectory:()=>p===privateRoot,isFile:()=>p!==privateRoot};},
    readFileSync(p,...args){
      assert.ok([EV,LOCAL,NATIVE,DEC].some(rel=>path.join(ROOT,rel)===p));
      if(p===path.join(ROOT,EV))return typeof args[0]==='string'?source:Buffer.from(source);
      return fs.readFileSync(p,...args);
    },writeFileSync(){throw Error('VM_WRITE_FORBIDDEN');}};
  const local=fixture.load(LOCAL,{'node:fs':fakeFs,'./participant-native-exec.cjs':native});
  const guardWrapper={installParentGuardsWithLocalTools(opts){installs.push(opts);return guard.installParentGuardsWithLocalTools(opts);}};
  const sandboxRequire=n=>{
    if(n==='node:fs')return fakeFs;
    if(n===path.join(ROOT,NATIVE))return native;
    if(n===path.join(ROOT,LOCAL))return local;
    if(n===path.join(ROOT,DEC))return decoder;
    if(n===path.join(ROOT,'miniapp/tests/helpers/psr-repair-fixtures.cjs'))return fixture;
    if(n===path.join(ROOT,'miniapp/tests/helpers/psr-guard-runner.cjs'))return guardWrapper;
    assert.ok(['node:path','node:crypto','node:assert/strict','node:events','node:https','node:dns','node:vm','node:child_process'].includes(n));
    return require(n);
  };
  vm.runInNewContext(source,{require:sandboxRequire,__dirname:path.join(ROOT,'docs/证据'),__filename:path.join(ROOT,EV),
    process:proc,Buffer,TextDecoder,setTimeout,clearTimeout,queueMicrotask,console},{timeout:5000});
  let timeout;await Promise.race([done,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('VM_TIMEOUT')),10000);})]).finally(()=>clearTimeout(timeout));
  assert.equal(stderr,'');const r=JSON.parse(stdout);
  const s7=r.results.find(x=>x.id.startsWith('S7')),s8=r.results.find(x=>x.id.startsWith('S8')),s9=r.results.find(x=>x.id.startsWith('S9'));
  const item={mode,ok:r.ok,exit:proc.exitCode||0,s1Passed:!!r.results[1].passed,
    identityReadFact:r.onlyReadFacts.identityRead,
    reportedProcessTotal:s7.actual.processFacts.total,observedParentProcesses:calls.length,
    parentActualGuardHits:installs[0].hits.length,reportedUnexpected:r.guardAccounting.unexpectedHits,
    latestGuardHits:installs.at(-1).hits.length,latestGuardPhases:installs.at(-1).hits.map(h=>h.phase),
    s8Passed:s8.passed,s9Passed:s9?s9.passed:null,
    s9Scenarios:s9?s9.actual.scenarios.map(s=>({mode:s.mode,passed:s.passed,got:s.got})):null};
  assert.equal(item.reportedProcessTotal,4);assert.equal(item.observedParentProcesses,7);
  if(['identityFail','identityNotCsv'].includes(mode)){assert.equal(r.ok,false);assert.equal(proc.exitCode,1);}
  else{assert.equal(r.ok,true);assert.equal(proc.exitCode||0,0);}
  if(mode==='lateGitHit'){assert.equal(item.parentActualGuardHits,5);assert.equal(item.reportedUnexpected,0);}
  if(mode==='s9Mismatch')assert.equal(s9.passed,false);
  if(mode==='postS9Hit'){assert.equal(item.parentActualGuardHits,4);assert.equal(item.latestGuardHits,6);}
  return item;
}
async function main(){
  const boundary=nativeBoundaryCase();
  const cases=[];
  for(const mode of ['normal','identityFail','identityNotCsv','lateGitHit','committedHistoryChange','normalFull','s9Mismatch','postS9Hit'])cases.push(await evidenceCase(mode));
  installOuter();
  const unexpected=outerHits.filter(h=>h.phase!=='probe').length;assert.equal(unexpected,0);
  const report={schema:'codex-native-compat-f211469-review/1',reviewedCommit:'f211469',baseline:'e7dde01',
    runtimeDigests:Object.fromEntries([LOCAL,NATIVE,DEC,EV].map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,p))).digest('hex')])),
    nativeBoundary:boundary,evidenceVm:cases,outerAccounting:{probes:outerHits.length,unexpected},
    realOsQueries:0,realDpapi:0,cloud:0,ok:true,
    limitations:['ok表示独立反例与关闭对照符合预期，不表示受审实现通过。',
      '实际native-exec/local-tools/证据源码在VM运行；进程、管道与私密FS全为替身。',
      's9Mismatch只在内存把正常场景的预期改为失败，真实S9比较得false后仍exit0；磁盘受审脚本未改。',
      'committedHistoryChange模拟保护清单外历史文件已提交且工作树干净；未改写任何历史文件。',
      '外层及证据使用实际守卫安装器；S9重复安装导致后续命中记到最后子场景的事实单列。']};
  const body=JSON.stringify(report,null,2)+'\n';
  if(process.argv.length===2)process.stdout.write(body);
  else if(process.argv.length===4&&process.argv[2]==='--out')fs.writeFileSync(path.resolve(process.argv[3]),body,{flag:'wx'});
  else throw Error('usage: node script [--out new-path]');
}
main().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});
