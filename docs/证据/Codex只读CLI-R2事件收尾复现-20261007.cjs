'use strict';
// 真实被审模块 + 合成 ChildProcess 事件；无 CLI、认证或网络操作。仅 stdout。
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const o = require('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs');
function fake() {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.kill = () => false;
  return c;
}
function run(c, time=100) {
  return o.spawnBounded('fake', [], {}, {spawn:()=>c,__limits:{timeoutMs:time,maxOutputBytes:100}});
}
(async()=>{
  const findings=[];
  for (const [id,first,last] of [
    ['S1-valid-split','{"ok":','true}'],
    ['S1-invalid-tail','{"ok":true}','UNEXPECTED_TAIL']
  ]) {
    const c=fake(); let settled=false;
    const p=run(c).then(r=>{settled=true;return r;});
    c.stdout.emit('data',Buffer.from(first)); c.emit('exit',0,null);
    await Promise.resolve();
    const settledBeforeClose=settled;
    c.stdout.emit('data',Buffer.from(last)); c.emit('close',0,null);
    const r=await p;
    let parserAccepted=false;try{o.parseCliJson(r.stdout,'sts','GetCallerIdentity');parserAccepted=true;}catch{}
    findings.push({id,settledBeforeClose,expectedFullOutput:first+last,observedOutput:r.stdout,
      parserAccepted,exitCode:r.code,processExited:r.processExited,terminationConfirmed:r.terminationConfirmed});
  }
  for(const kind of ['timeout','overflow']) {
    const c=fake(); const p=run(c,5);
    if(kind==='overflow') c.stdout.emit('data',Buffer.alloc(101,120));
    const r=await p;
    let lateErrorThrew=false;
    try{c.emit('error',new Error('SYNTHETIC_LATE_ERROR'));}catch{lateErrorThrew=true;}
    findings.push({id:'S2-late-error-'+kind,timedOut:r.timedOut,overflow:r.overflow,
      errorListeners:c.listenerCount('error'),lateErrorThrew,
      note:'证据脚本外围catch保护自身；实际异步error无监听可成为未捕获异常。'});
  }
  process.stdout.write(JSON.stringify({observedAt:new Date().toISOString(),realNetworkCalls:0,cliExecuted:false,
    observerSha256:crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs'))).digest('hex'),findings},null,2)+'\n');
})().catch(()=>{process.stderr.write('OFFLINE_REPRODUCTION_FAILED\n');process.exitCode=1;});
