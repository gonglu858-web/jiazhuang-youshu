'use strict';
// 只用真实模块与合成事件，无CLI、认证、网络。只输出stdout。
const {EventEmitter}=require('node:events');
const o=require('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs');
const fs=require('node:fs');const crypto=require('node:crypto');
function child(){const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kills=0;c.kill=()=>{c.kills++;return false;};return c;}
(async()=>{
 const results=[];
 // 不发exit/close，使用完整生产限制：不依赖毫秒级事件竞速。
 const c=child();const start=Date.now();
 const r=await o.spawnBounded('fake',[],{},{spawn:()=>c,__limits:o.LIMITS});
 results.push({id:'no-exit-production-limits',elapsedMs:Date.now()-start,processExited:r.processExited,
  closeNotObserved:r.closeNotObserved,timedOut:r.timedOut,killCalls:c.kills,
  expected:'未exit时应由55秒总超时负责，而不是2秒close宽限提前结束'});
 // 复核旧样本直接注入__limits缺字段，不把undefined定时器当5ms竞速。
 const d=child();const t=Date.now();const q=await o.spawnBounded('fake',[],{},
  {spawn:()=>d,__limits:{timeoutMs:100,maxOutputBytes:100}});
 results.push({id:'partial-direct-limits',elapsedMs:Date.now()-t,processExited:q.processExited,
  closeNotObserved:q.closeNotObserved,timedOut:q.timedOut,
  note:'__limits未提供closeGraceMs；直接进入setTimeout(undefined)，resolveLimits未被调用。'});
 // 原修复正向：exit后仍收集尾部；晚到error被吸收。
 const e=child();let done=false;const p=o.spawnBounded('fake',[],{},
  {spawn:()=>e,__limits:{timeoutMs:1000,maxOutputBytes:100,closeGraceMs:500}}).then(x=>{done=true;return x;});
 e.stdout.emit('data',Buffer.from('{"ok":'));e.emit('exit',0,null);await Promise.resolve();
 const beforeClose=done;e.stdout.emit('data',Buffer.from('true}'));e.emit('close',0,null);const z=await p;
 let threw=false;try{e.emit('error',new Error('SYNTHETIC'));}catch{threw=true;}
 results.push({id:'prior-fixes-remain',settledBeforeClose:beforeClose,stdout:z.stdout,lateErrorThrew:threw});
 console.log(JSON.stringify({observedAt:new Date().toISOString(),realNetworkCalls:0,
  observerSha256:crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs'))).digest('hex'),results},null,2));
})().catch(()=>{process.stderr.write('OFFLINE_REPRODUCTION_FAILED\n');process.exitCode=1;});
