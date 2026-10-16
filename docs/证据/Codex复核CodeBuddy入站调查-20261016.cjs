// Re-run reviewed audit in memory: redirect only its fixed JSON output; never overwrite historical evidence.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const target=path.join(__dirname,'CodeBuddyI1入站事件封装离线核实-20261016.cjs'),output=target.replace(/cjs$/,'json'),source=fs.readFileSync(target,'utf8'),localRequire=createRequire(target),root=path.resolve(__dirname,'../..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function rerun(mutate){
 let saved,fail=[],assertions=0;const processProxy={exitCode:0};
 const fsProxy=new Proxy(fs,{get(o,k){if(k==='existsSync')return p=>path.resolve(p)===output?false:o.existsSync(p);
 if(k==='writeFileSync')return(p,b,opts)=>{assert.equal(path.resolve(p),output);assert.equal(opts.flag,'wx');saved=JSON.parse(b);};
 if(k==='readFileSync')return(p,...args)=>{const b=o.readFileSync(p,...args);if(mutate&&path.resolve(p)===path.join(root,'miniapp/scripts/lib/participant-identity-check.cjs'))return Buffer.concat([Buffer.from(b),Buffer.from('\n// synthetic in-memory drift\n')]);return b;};return o[k];}});
 const assertProxy=new Proxy(localRequire('node:assert/strict'),{get(o,k){const v=o[k];return typeof v==='function'?function(...a){assertions++;return v.apply(o,a);}:v;}});
 const done=new Promise(resolve=>{
 const instrumented=source.replace('.finally(() => restore.reverse().forEach(f => f()));','.finally(() => { restore.reverse().forEach(f => f()); __done(); });');assert.notEqual(instrumented,source);
 vm.runInNewContext(instrumented,{__filename:target,__dirname,require(n){if(n==='node:fs')return fsProxy;if(n==='node:assert/strict')return assertProxy;return localRequire(n);},process:processProxy,console:{log(){},error(s){fail.push(String(s));}},Buffer,__done:resolve});
 });await done;assert.equal(processProxy.exitCode,0,fail.join('\n'));assert(saved);
 return {assertionCalls:assertions,reportedChecks:saved.checksPassed,guardUnexpected:saved.unexpectedGuardAttempts,saved};
}
(async()=>{
 const original=JSON.parse(fs.readFileSync(output));const baseline=await rerun(false),drift=await rerun(true);
 assert.deepEqual(baseline.saved.projectFiles,original.projectFiles);assert.deepEqual(baseline.saved.sdkFacts,original.sdkFacts);
 const key='miniapp/scripts/lib/participant-identity-check.cjs';assert.notEqual(drift.saved.projectFiles[key].sha256,baseline.saved.projectFiles[key].sha256);
 const packer=fs.readFileSync(path.join(root,'miniapp/scripts/package-participant-identity-check.cjs'),'utf8');
 const pinMatches=Object.entries(original.projectFiles).map(([rel,row])=>({rel,actualMatchesRecorded:sha(fs.readFileSync(path.join(root,rel)))===row.sha256,hashAppearsInPacker:packer.includes(row.sha256)}));
 assert(pinMatches.every(x=>x.actualMatchesRecorded));
 const result={reviewedCommit:'0fd3094',scriptSha256:sha(Buffer.from(source)),method:'memory wrapper redirects fixed output; native fs source unchanged; second run appends comment in readFileSync only',baseline:{assertionCalls:baseline.assertionCalls,reportedChecks:baseline.reportedChecks,guardUnexpected:baseline.guardUnexpected,recordedFactsMatch:true},drift:{assertionCalls:drift.assertionCalls,reportedChecks:drift.reportedChecks,guardUnexpected:drift.guardUnexpected,changedHashRecordedButNotRejected:true},projectPins:pinMatches,diagnosticPlanCounterexample:{syntheticKey:'synthetic_secret_in_key',proposedRawKeyTruncationWouldPreserve:true,realSecretsUsed:false},platformCalls:0,limitations:['SDK server-side outgoing callFunction does not exercise phone inbound transport.','Unknown actual extra key remains unresolved.','32 is a hard-coded reported count; wrapper counts assert method calls, not a claim of 32 behavioral test cases.']};
 fs.writeFileSync(__filename.replace(/cjs$/,'json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({baseline:result.baseline,drift:result.drift,pins:pinMatches}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
