'use strict';
// 可复用本地边界证明：给核验包测试和新版证据调用，始终使用合成材料。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const helperPath=require.resolve('./pic-guard-runner.cjs');
const helper=require(helperPath);
async function runBoundaryProof(){
  const dir=fs.mkdtempSync(path.resolve(__dirname,'../../../artifacts/schedule-sandbox/business-test/guard-boundary-'));
  const fixture=path.join(dir,'fixture.cjs'),preload=path.join(dir,'guard.cjs');
  fs.writeFileSync(preload,helper.buildGuardPreloadSource(),{flag:'wx'});
  fs.writeFileSync(fixture,`const m=process.argv[2];if(m==='output'){process.stdout.write('界'.repeat(10000));process.stderr.write('界'.repeat(10000));}else if(m==='wait'){setTimeout(()=>{},10000);}else if(m==='network'){for(const f of [()=>require('dns').promises.lookup('example.invalid'),()=>new(require('net').Socket)().connect(1)]){try{f()}catch(_){}}}`,{flag:'wx'});
  const hits=[],guard=helper.installParentGuards({hits,getPhase:()=> 'sensitivity',allowedScripts:[fixture]});
  const run=mode=>guard.runCli({scriptPath:fixture,args:[mode],guardPreload:preload,receiptPath:guard.newReceiptPath(mode),group:'sensitivity',...(mode==='output'?{outputLimit:64}:{}),...(mode==='wait'?{timeoutMs:150}:{})});
  const result={};
  try{
    assert.equal(guard.rawSpawn,undefined,'不存在无preload通道');
    for(const f of [()=>require('child_process').spawn(process.execPath,[fixture]),()=>require('dns').promises.lookup('example.invalid'),()=>new(require('net').Socket)().connect(1)])assert.throws(f,/OFFLINE_GUARD/);
    assert.equal(hits.length,3);result.parentExpectedProbes=hits.map(h=>h.api);
    const clean=await run('clean');assert.deepEqual(clean.validation.failures,[]);result.clean=clean.code;
    const output=await run('output');assert.equal(output.outBytes,64);assert.equal(output.errBytes,64);
    assert(output.outBounded&&output.errBounded);assert(Buffer.byteLength(output.out)<=64&&Buffer.byteLength(output.err)<=64);
    assert(output.validation.failures.some(s=>s.includes('输出')));result.output={retainedOutBytes:output.outBytes,retainedErrBytes:output.errBytes,bothBounded:true};
    const timeout=await run('wait');assert(timeout.timedOut);assert(timeout.validation.failures.some(s=>s.includes('超时')));result.timeout={timedOut:true,rejected:true};
    const network=await run('network');assert.equal(network.validation.childUnexpected,2);result.childExpectedProbes=network.receipt.unexpected;
    const badReceipts=[null,{},[],{unexpected:[]},{...clean.receipt,pid:clean.childPid+1},{...clean.receipt,exitCode:1},{...clean.receipt,unexpected:'bad'},{...clean.receipt,unexpected:[4]},{...clean.receipt,pid:NaN},{...clean.receipt,note:'unknown'}];
    for(const receipt of badReceipts)assert(helper.validateChildResult({...clean,receipt}).failures.length>0);
    result.malformedReceiptsRejected=badReceipts.length;
    result.allRunsAccounted=guard.summary('sensitivity').runs;assert.equal(result.allRunsAccounted,4);
  }finally{guard.restoreAll();}
  // 启动错误用VM依赖注入：同步throw/合成error→close事件；不冒称真实平台/OS启动失败。
  for(const mode of ['syncThrow','asyncErrorSynthetic']){
    const module={exports:{}};const realRequire=createRequire(helperPath);
    const localRequire=n=>n==='node:child_process'?{spawn(){
      if(mode==='syncThrow')throw Error('synthetic-spawn-throw');
      const {EventEmitter}=require('node:events'),child=new EventEmitter();
      child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
      queueMicrotask(()=>{child.emit('error',Error('synthetic-ENOENT'));child.emit('close',-2,null);});return child;
    }}:realRequire(n);
    vm.runInNewContext(fs.readFileSync(helperPath,'utf8'),{module,exports:module.exports,require:localRequire,__filename:helperPath,__dirname:path.dirname(helperPath),process:{env:process.env,execPath:process.execPath},Buffer,setTimeout,clearTimeout},{filename:helperPath});
    const h=module.exports,g=h.installParentGuards({hits:[],getPhase:()=> 'unexpected',allowedScripts:[fixture]});
    try{const r=await g.runCli({scriptPath:fixture,args:['clean'],guardPreload:preload,receiptPath:g.newReceiptPath(mode)});assert(r.spawnError);assert(r.validation.failures.length>0);result[mode]={spawnErrorObserved:true,rejected:true};}finally{g.restoreAll();}
  }
  return result;
}
module.exports={runBoundaryProof};
