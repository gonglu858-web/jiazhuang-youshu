'use strict';
// Preparation contract only: no fs, native, process or network capability imported.
// Synthetic contract acceptance is NOT file measurement or signature verification.
const TARGET='C:\\Windows\\System32\\conhost.exe';
const LABEL='WINDOWS_CONHOST_FIXED_FILE';
const MAX_BYTES=32*1024*1024;
const need=(v)=>{if(!v)throw Error('SYNTHETIC_CONTRACT_REJECTED');};
function record(o,keys){
  need(o!==null&&typeof o==='object'&&!Array.isArray(o));
  const p=Object.getPrototypeOf(o);need(p===null||p===Object.prototype);
  const ds=Object.getOwnPropertyDescriptors(o),names=Reflect.ownKeys(ds);
  need(names.length===keys.length&&names.every(k=>typeof k==='string'&&keys.includes(k)));
  const result=Object.create(null);
  for(const k of keys){const d=ds[k];need(d&&d.enumerable&&Object.hasOwn(d,'value'));result[k]=d.value;}
  return result;
}
function inspectSyntheticReceipt(input){
  // Fixed schema, no free-form errors, certificate text or paths in output.
  try{
    const r=record(input,['schema','evidenceKind','target','bytes','sha256','fileState','sameHandle','stable','signature','cleanup']);
    need(r.schema==='codex-fixed-candidate-synthetic/1'&&r.evidenceKind==='synthetic');
    need(r.target===LABEL&&Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=MAX_BYTES);
    need(typeof r.sha256==='string'&&/^[0-9a-f]{64}$/.test(r.sha256));
    need(r.fileState==='REGULAR_NO_REPARSE'&&r.sameHandle===true&&r.stable===true);
    const sig=record(r.signature,['status','providerCode','binding','networkPolicy']);
    need(sig.binding==='SAME_HELD_FILE'&&sig.networkPolicy==='CACHE_ONLY');
    need(Number.isInteger(sig.providerCode)&&sig.providerCode>=-2147483648&&sig.providerCode<=2147483647);
    need(['POLICY_ACCEPTED','POLICY_REJECTED','UNDETERMINED'].includes(sig.status));
    need((sig.status==='POLICY_ACCEPTED')===(sig.providerCode===0));
    const cleanup=record(r.cleanup,['fileClosed','trustStateClosed']);
    need(cleanup.fileClosed===true&&cleanup.trustStateClosed===true);
    return {contractAccepted:true,evidenceKind:'synthetic',target:LABEL,bytes:r.bytes,sha256:r.sha256,
      signatureStatus:sig.status,fileAuthenticityConfirmed:false,observedProcessBinding:false,
      parentEvidenceComplete:false,l2Approved:false};
  }catch{return {contractAccepted:false,reason:'SYNTHETIC_CONTRACT_REJECTED',fileAuthenticityConfirmed:false,l2Approved:false};}
}
function prepare(argv){
  const base={schema:'codex-fixed-candidate-preparation/1',target:LABEL,executionEnabled:false,
    targetOpened:false,signatureInvoked:false,childStarts:0,networkCalls:0,cacheWrites:0,
    backendImplemented:false,executionApproved:false,l2Approved:false};
  if(!Array.isArray(argv)||argv.length!==0)return {...base,preparationValidated:false,reason:'EXECUTION_DISABLED',exitCode:1};
  return {...base,preparationValidated:true,reason:'SIGNATURE_BACKEND_UNREVIEWED',exitCode:2};
}
module.exports=Object.freeze({TARGET,LABEL,MAX_BYTES,prepare,inspectSyntheticReceipt});
if(require.main===module){const result=prepare(process.argv.slice(2));process.stdout.write(JSON.stringify(result,null,2)+'\n');process.exitCode=result.exitCode;}
