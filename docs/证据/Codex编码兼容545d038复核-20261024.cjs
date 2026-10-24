'use strict';
// 独立审查：实际产品/受审证据源码，进程、私密FS均为替身；不运行原证据的OS能力。
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const assert=require('node:assert/strict'), crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const LOCAL='miniapp/scripts/lib/participant-local-tools.cjs';
const DEC='miniapp/scripts/lib/participant-native-decoder.cjs';
const EV='docs/证据/CodeBuddy本地编码模块兼容返修v2-20261024.cjs';
const outerHits=[];let outerPhase='probe';
const guard=require(path.join(ROOT,'miniapp/tests/helpers/psr-guard-runner.cjs'));
const installOuter=()=>guard.installParentGuardsWithLocalTools({hits:outerHits,getPhase:()=>outerPhase,allowedScripts:[]});
installOuter();
assert.throws(()=>require('node:https').request('https://synthetic.invalid'));
assert.throws(()=>require('node:child_process').execSync('synthetic-never-run'));
outerPhase='review';
const fixture=require(path.join(ROOT,'miniapp/tests/helpers/psr-repair-fixtures.cjs'));
const decoder=require(path.join(ROOT,DEC));
const evSource=fs.readFileSync(path.join(ROOT,EV),'utf8');
const prefix=path.join(ROOT,'artifacts/schedule-sandbox/.participant-private');
const gbTail=Buffer.concat([Buffer.from([0xd2,0xd1,0xb3,0xc9,0xb9,0xa6,0xb4,0xa6,0xc0,0xed]),Buffer.from(' 1 '),
  Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe]),Buffer.from('; '),Buffer.from([0xb4,0xa6,0xc0,0xed]),Buffer.from(' 0 '),
  Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe,0xca,0xb1,0xca,0xa7,0xb0,0xdc])]);
const ok=stdout=>({status:0,stdout,stderr:Buffer.alloc(0)});
async function evidenceCase(mode){
  installOuter();outerPhase=mode==='preGuardHit'?'sensitivity':'review';
  const beforeOuter=outerHits.length;let syncCalls=0,gitCalls=0,evidenceGuard;
  const local=fixture.load(LOCAL,{'node:fs':{statSync:()=>({isFile:()=>true})},
    'node:child_process':{spawnSync(exe,args){syncCalls++;
      if(exe.endsWith('icacls.exe'))return ok(Buffer.concat([Buffer.from(args[0]+' '+fixture.sid+':(F)\n'),gbTail]));
      if(exe.endsWith('whoami.exe')){
        if(mode==='identityFailure')return {status:1,stdout:Buffer.alloc(0),stderr:Buffer.from('synthetic failure')};
        return ok(Buffer.from(mode==='identityMalformed'?'not-csv':'"synthetic\\current","'+fixture.sid+'"'));
      }
      assert.ok(exe.endsWith('git.exe'));return ok(Buffer.from(args[2]+'\n'));
    },spawn(){throw Error('REAL_ASYNC_FORBIDDEN');}}});
  const fakeCp={execFileSync(exe,args,opts){assert.equal(exe,'C:\\Program Files\\Git\\cmd\\git.exe');assert.equal(args[0],'diff');assert.equal(opts.cwd,ROOT);gitCalls++;return '';}};
  const fakeFs={existsSync(p){assert.equal(p,prefix);return true;},statSync(p){assert.equal(p,prefix);return {isDirectory:()=>true};},
    readFileSync(p,...args){assert.ok([LOCAL,DEC].some(rel=>p===path.join(ROOT,rel)));return fs.readFileSync(p,...args);},
    writeFileSync(){throw Error('VM_WRITE_FORBIDDEN');}};
  const attempt="try { require('node:https').request('https://synthetic-caught.invalid'); } catch (_) {}\n";
  let src=evSource;
  if(mode==='preGuardHit')src=src.replace("const localTools = require(",attempt+"const localTools = require(");
  if(mode==='setupHit')src=src.replace('const report = {',attempt+'const report = {');
  if(mode==='doneHit')src=src.replace("phase = 'done';","phase = 'done';\n"+attempt);
  if(mode==='businessHit')src=src.replace('let gitFact = null;',attempt+'let gitFact = null;');
  let stdout='',stderr='',finish;
  const done=new Promise(resolve=>finish=resolve);
  const proc={env:{},argv:['node',path.join(ROOT,EV)],exitCode:0,
    stdout:{write(s){stdout+=s;finish();}},stderr:{write(s){stderr+=s;finish();}}};
  const sandboxRequire=n=>{
    if(n==='node:fs')return fakeFs;
    if(n==='node:child_process')return Object.assign({},require(n),fakeCp);
    if(n===path.join(ROOT,LOCAL))return local;
    if(n===path.join(ROOT,DEC))return decoder;
    if(n===path.join(ROOT,'miniapp/tests/helpers/psr-guard-runner.cjs'))return {installParentGuardsWithLocalTools(opts){evidenceGuard=opts;return guard.installParentGuardsWithLocalTools(opts);}};
    if(n===path.join(ROOT,'miniapp/tests/helpers/psr-repair-fixtures.cjs'))return fixture;
    assert.ok(['node:path','node:crypto','node:assert/strict','node:events','node:https','node:dns'].includes(n));return require(n);
  };
  vm.runInNewContext(src,{require:sandboxRequire,__dirname:path.join(ROOT,'docs/证据'),__filename:path.join(ROOT,EV),
    process:proc,Buffer,TextDecoder,setTimeout,clearTimeout,queueMicrotask},{timeout:5000});
  await done;assert.equal(stderr,'');const r=JSON.parse(stdout);
  const s1=r.results.find(x=>x.id==='S1_native_encoding_contract_controlled');
  const observed={mode,ok:r.ok,exit:proc.exitCode||0,s1Passed:s1.passed,s1Error:s1.actual.s1Error,
    identityShape:s1.actual.identityFacts&&s1.actual.identityFacts.csvShapeOk,
    guardHits:evidenceGuard.hits.map(h=>({phase:h.phase,api:h.api})),
    reportedUnexpected:r.guardAccounting.businessUnexpected,
    preGuardOuterHits:outerHits.length-beforeOuter,
    observedSyncCalls:syncCalls,observedGitCalls:gitCalls,observedTotal:syncCalls+gitCalls,
    reportedTotal:r.processFacts.totalChildProcesses};
  assert.equal(observed.observedTotal,7);assert.equal(observed.reportedTotal,6);
  if(mode==='businessHit'){assert.equal(r.ok,false);assert.equal(proc.exitCode,1);}
  else{assert.equal(r.ok,true);assert.equal(proc.exitCode||0,0);}
  if(mode==='preGuardHit')assert.equal(observed.preGuardOuterHits,1);
  if(mode==='identityFailure')assert.equal(s1.actual.s1Error.code,'PSR_LOCAL_TOOL_FAILED');
  if(mode==='identityMalformed')assert.equal(observed.identityShape,false);
  return observed;
}
async function main(){
  const cases=[];for(const mode of ['normal','identityFailure','identityMalformed','setupHit','doneHit','preGuardHit','businessHit'])cases.push(await evidenceCase(mode));
  installOuter();outerPhase='review';
  // 缓存正常GBK探针后实际身份/ACL为UTF-8：两份同样乱码能通过现有权限主体比较。
  const h=fixture.createPrivateHarness();let queries=0;
  const local=fixture.load(LOCAL,{'node:fs':{statSync:()=>({isFile:()=>true})},'node:child_process':{spawnSync(exe,args){queries++;
    if(exe.endsWith('icacls.exe')&&args[0]==='.')return ok(Buffer.concat([Buffer.from('. '+fixture.sid+':(F)\n'),gbTail]));
    if(exe.endsWith('whoami.exe'))return ok(Buffer.from('"synthetic\\中文","'+fixture.sid+'"','utf8'));
    return ok(Buffer.from(args[0]+' synthetic\\中文:(F)\nSuccessfully processed 1 files; Failed processing 0 files','utf8'));
  }}});
  h.tools.queryIdentity=local.queryIdentity;h.tools.queryAcl=local.queryAcl;
  assert.doesNotThrow(()=>h.store.validatePrivateTarget({repoRoot:ROOT,relativePath:h.store.PRIVATE_ROOT_REL+'/synthetic.bin'}));
  assert.notEqual(decoder.decodeNative(Buffer.from('中文')),'中文');assert.equal(h.mem.size,0);
  // 不是完整统计行：前缀、非法尾部和非统计内容中的锚点都仍建立契约。
  const malformedProbe=Buffer.concat([Buffer.from([0xd2,0xd1,0xb3,0xc9,0xb9,0xa6]),Buffer.from('junkSuccessfully processed 1 files; Failed processing 0 filesTRAILER')]);
  const probeLocal=fixture.load(LOCAL,{'node:fs':{statSync:()=>({isFile:()=>true})},'node:child_process':{spawnSync(exe,args){return ok(exe.endsWith('icacls.exe')?malformedProbe:Buffer.from('"synthetic\\current","'+fixture.sid+'"'));}}});
  probeLocal.queryIdentity();assert.equal(probeLocal.nativeEncodingContract().state,'established');
  const closed=[];
  for(const [label,fn,b] of [['utf8Ufffd',decoder.decodeUtf8Strict,Buffer.from([0xef,0xbf,0xbd])],['gbUfffd',decoder.decodeNative,Buffer.from([0x84,0x31,0xa4,0x37])]]){assert.throws(()=>fn(b),e=>e.code==='PSR_NATIVE_DECODE_FAILED');closed.push(label);}
  const unexpected=outerHits.filter(h=>!['probe','sensitivity'].includes(h.phase)).length;assert.equal(unexpected,0);
  const report={schema:'codex-local-compat-r1r3-review/1',reviewedCommit:'545d038',baseline:'d123828',
    runtimeDigests:Object.fromEntries([LOCAL,DEC,EV].map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,p))).digest('hex')])),
    evidenceVm:cases,productChains:{cachedProbeThenDifferentEncoding:{accepted:true,contract:local.nativeEncodingContract().state,queries,writes:0},malformedProbeAccepted:true},
    confirmedClosed:closed,outerAccounting:{probes:outerHits.filter(h=>h.phase==='probe').length,sensitivities:outerHits.filter(h=>h.phase==='sensitivity').length,unexpected},
    realOsQueries:0,dpapi:0,cloud:0,ok:unexpected===0,
    limitations:['全部OS/私密FS边界为合成替身，未执行原证据真实查询。','VM中实际使用既有守卫安装器及受审源码；业务期对照确实exit1，setup/done漏记反例仍exit0。','不同工具/缓存后编码变化为合成反例，不证明本机当前命令确实混用编码或已越权。','ok仅表示复核反例如预期复现，非产品验收通过。']};
  const body=JSON.stringify(report,null,2)+'\n';
  if(process.argv.length===2)process.stdout.write(body);
  else if(process.argv.length===4&&process.argv[2]==='--out')fs.writeFileSync(path.resolve(process.argv[3]),body,{flag:'wx'});
  else throw Error('usage: node script [--out new-path]');
}
main().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});
