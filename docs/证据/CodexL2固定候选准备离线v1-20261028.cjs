'use strict';
// Install an independent real-OS fallback before loading the preparation module.
let unexpected=0;
function deny(){unexpected++;throw Error('OFFLINE_OS_BLOCKED');}
for(const id of ['node:child_process','node:http','node:https','node:net','node:tls','node:dgram','node:dns']){
  const m=require(id);
  if(id==='node:net')m.Socket.prototype.connect=deny;
  if(id==='node:dns')for(const k of Object.keys(m.promises))if(typeof m.promises[k]==='function')m.promises[k]=deny;
  for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});
}globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const driver=path.join(__dirname,'CodexL2固定候选核验准备v1-20261028.cjs');
const out=path.join(__dirname,'CodexL2固定候选准备离线v1-20261028.json');
const originalRead=fs.readFileSync;
fs.readFileSync=function(p,...args){assert.notEqual(String(p).toLowerCase(),'c:\\windows\\system32\\conhost.exe');return originalRead.call(this,p,...args);};
const api=require(driver),results=[];
const run=(name,fn)=>{fn();results.push({name,passed:true});};
const sample=()=>({schema:'codex-fixed-candidate-synthetic/1',evidenceKind:'synthetic',target:api.LABEL,bytes:4096,sha256:'1'.repeat(64),fileState:'REGULAR_NO_REPARSE',sameHandle:true,stable:true,signature:{status:'POLICY_ACCEPTED',providerCode:0,binding:'SAME_HELD_FILE',networkPolicy:'CACHE_ONLY'},cleanup:{fileClosed:true,trustStateClosed:true}});
try{
  const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===out);if(args.length)assert(!fs.existsSync(out));
  run('default prepares but backend remains disabled',()=>{const r=api.prepare([]);assert(r.preparationValidated&&!r.executionEnabled&&!r.targetOpened);assert.equal(r.exitCode,2);assert.equal(r.reason,'SIGNATURE_BACKEND_UNREVIEWED');});
  for(const args of [['--execute-once'],['--target','C:\\synthetic-secret'],['--out','x'],['--signature'],['']])run('no CLI execution or override '+results.length,()=>{const r=api.prepare(args);assert.equal(r.exitCode,1);assert(!r.targetOpened&&!r.signatureInvoked);});
  run('synthetic positive never becomes authenticity or process proof',()=>{const r=api.inspectSyntheticReceipt(sample());assert(r.contractAccepted);assert(!r.fileAuthenticityConfirmed&&!r.observedProcessBinding&&!r.parentEvidenceComplete&&!r.l2Approved);});
  for(const status of ['POLICY_REJECTED','UNDETERMINED'])run('synthetic negative status '+status,()=>{const r=sample();r.signature.status=status;r.signature.providerCode=-1;const v=api.inspectSyntheticReceipt(r);assert(v.contractAccepted&&!v.fileAuthenticityConfirmed);});
  const mutations=[['missing hash',r=>delete r.sha256],['wrong hash',r=>r.sha256='synthetic-secret'],['uppercase hash',r=>r.sha256='A'.repeat(64)],['raw target',r=>r.target=api.TARGET],['secret extra',r=>r.rawPath='synthetic-secret'],['real evidence claim',r=>r.evidenceKind='real'],['size zero',r=>r.bytes=0],['size over limit',r=>r.bytes=api.MAX_BYTES+1],['unsafe size',r=>r.bytes=Number.MAX_SAFE_INTEGER+1],['reparse',r=>r.fileState='REPARSE'],['second file',r=>r.sameHandle=false],['drift',r=>r.stable=false],['online',r=>r.signature.networkPolicy='ONLINE'],['path-only binding',r=>r.signature.binding='PATH_ONLY'],['zero status rejection',r=>r.signature.status='POLICY_REJECTED'],['nonzero accepted',r=>r.signature.providerCode=1],['unsigned status code',r=>r.signature.providerCode=4294967295],['signature text',r=>r.signature.certificate='synthetic-secret'],['open file',r=>r.cleanup.fileClosed=false],['open trust',r=>r.cleanup.trustStateClosed=false],['wrong schema',r=>r.schema='old']];
  for(const [name,change]of mutations)run('reject '+name,()=>{const r=sample();change(r);const v=api.inspectSyntheticReceipt(r);assert(!v.contractAccepted);assert(!JSON.stringify(v).includes('synthetic-secret'));});
  let getters=0;
  run('accessor not evaluated',()=>{const r=sample();Object.defineProperty(r,'sha256',{enumerable:true,get(){getters++;throw Error('synthetic-secret');}});assert(!api.inspectSyntheticReceipt(r).contractAccepted);assert.equal(getters,0);});
  run('symbol rejected',()=>{const r=sample();r[Symbol('synthetic-secret')]=1;assert(!api.inspectSyntheticReceipt(r).contractAccepted);});
  run('non-enumerable field rejected',()=>{const r=sample();Object.defineProperty(r,'bytes',{value:4096,enumerable:false});assert(!api.inspectSyntheticReceipt(r).contractAccepted);});
  run('proxy exception sanitized',()=>{const r=new Proxy({}, {ownKeys(){throw Error('synthetic-secret');}});assert.deepEqual(api.inspectSyntheticReceipt(r),{contractAccepted:false,reason:'SYNTHETIC_CONTRACT_REJECTED',fileAuthenticityConfirmed:false,l2Approved:false});});
  run('custom prototype rejected',()=>{const r=sample();Object.setPrototypeOf(r,{role:'synthetic'});assert(!api.inspectSyntheticReceipt(r).contractAccepted);});
  run('projection independent after mutation',()=>{const r=sample(),v=api.inspectSyntheticReceipt(r),before=JSON.stringify(v);r.sha256='f'.repeat(64);r.signature.status='UNDETERMINED';assert.equal(JSON.stringify(v),before);});
  run('driver imports no execution or file capability',()=>{const src=fs.readFileSync(driver,'utf8');assert(!/\brequire\s*\(/.test(src));assert(!src.includes('process.binding'));assert(!src.includes('eval('));});
  const h=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const digests={driver:h(driver),test:h(__filename)};
  const report={schema:'codex-fixed-candidate-offline/1',basisCommit:'8667edf',checks:results.length,results,digests,
    unexpectedOS:unexpected,targetRead:false,nativeSignatureExecuted:false,backendImplemented:false,
    limitations:['Actual JS preparation/receipt contract only; OS backend not implemented or invoked','Synthetic status and same-handle fields are fixtures, not Windows API proof','Microsoft documentation reviewed separately; zero persistent cache mutation not established'],ok:unexpected===0};report.exitCode=report.ok?0:1;
  const text=JSON.stringify(report,null,2)+'\n';if(args.length)fs.writeFileSync(out,text,{flag:'wx'});fs.writeSync(1,JSON.stringify({ok:report.ok,checks:results.length,unexpectedOS:unexpected})+'\n');process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,checks:results.length,error:e.message})+'\n');process.exitCode=1;}
