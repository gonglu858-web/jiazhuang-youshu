// Offline generated entry/client reproduction; injected envelope keys are hypotheses, not captured platform payloads.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const out=__filename.replace(/cjs$/,'json');assert(!fs.existsSync(out));
const prep=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1同场就绪轮准备-20261016.json')));
const hashes={};
for(const rel of ['server/scheduleSandbox/index.js','server/scheduleSandbox/participant-identity-check.js','frontend/utils/identity-check-client.js','frontend/config/cloud.js']){
 const bytes=fs.readFileSync(path.join(prep.packageDir,rel));const expected=prep.files.find(x=>x.rel===rel);assert.equal(sha(bytes),expected.sha256);hashes[rel]=sha(bytes);
}
const guardHits=[],restore=[];function guard(obj,k){const old=obj[k];if(typeof old!=='function')return;obj[k]=()=>{guardHits.push(k);throw Error('OFFLINE_GUARD');};restore.push(()=>obj[k]=old);}
for(const m of ['node:http','node:https'])for(const k of ['get','request'])guard(require(m),k);
for(const k of ['connect','createConnection'])guard(require('node:net'),k);guard(require('node:tls'),'connect');guard(globalThis,'fetch');
for(const k of ['lookup','resolve','resolve4','resolve6']){guard(require('node:dns'),k);guard(require('node:dns').promises,k);}
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])guard(require('node:child_process'),k);
async function main(){
 assert.throws(()=>require('node:https').request('https://example.invalid'),/OFFLINE_GUARD/);assert.throws(()=>require('node:net').connect(1),/OFFLINE_GUARD/);const probes=guardHits.length;
 const core=require('../../miniapp/scripts/lib/participant-identity-check.cjs');
 const pass='synthetic-local-request-probe';const digest=sha(pass);
 const original=fs.readFileSync(path.join(prep.packageDir,'server/scheduleSandbox/index.js'),'utf8');
 assert(original.includes(prep.plan.passphraseDigest));const entry=original.replace(prep.plan.passphraseDigest,digest);
 const trustedOpenid='synthetic-i1-envelope-openid';
 const config={envId:prep.plan.envId,identityCheckFunction:prep.plan.functionName,checkRoundId:prep.plan.checkRoundId};
 const rows=[];
 for(const spec of [{name:'plain_no_full_id',full:false},{name:'plain_full_id',full:true},{name:'injected_userInfo',full:true,extra:{userInfo:{openId:'synthetic-untrusted',appId:'synthetic-untrusted'}}},{name:'injected_arbitrary_key',full:false,extra:{syntheticExtra:true}},{name:'bad_pass_plus_extra',full:false,extra:{userInfo:{}},badPass:true}]){
  let reads=0,collections=0,fields=[],sentKeys=[];
  const db = {
    collection(name) {
      collections++; assert.equal(name, core.FIXED_TARGET.collection);
      return { doc(id) {
        assert.equal(id, core.deriveUserId(prep.plan.appId, trustedOpenid));
        return {
          get() { throw Error('unprojected get'); },
          field(projection) {
            fields.push(projection);
            return { async get() { reads++; return {data:null}; } };
          }
        };
      } };
    }
  };
  const fakeCloud={DYNAMIC_CURRENT_ENV:'synthetic-dynamic-env',init(){},getWXContext(){return{APPID:prep.plan.appId,OPENID:trustedOpenid}},database(opts){assert.equal(opts.throwOnNotFound,false);return db}};
  const exports={};vm.runInNewContext(entry,{exports,process:{env:{TCB_ENV:prep.plan.envId}},require(n){if(n==='wx-server-sdk')return fakeCloud;if(n==='./participant-identity-check')return {...core,createIdentityChecker(opts){return core.createIdentityChecker({...opts,now:()=>Date.parse(prep.plan.windowStartsAtIso)+1000});}};throw Error('Unexpected require');}});
  const module={exports:{}};const wx={cloud:{init(){},async callFunction(req){assert.equal(req.name,prep.plan.functionName);sentKeys=Object.keys(req.data);return{result:await exports.main({...req.data,...spec.extra})};}}};
  vm.runInNewContext(fs.readFileSync(path.join(prep.packageDir,'frontend/utils/identity-check-client.js'),'utf8'),{module,exports:module.exports,wx,require(n){assert.equal(n,'../config/cloud');return config;}});
  const result=await module.exports.callIdentityCheck({action:'inspectSelf',passphrase:spec.badPass?'synthetic-wrong':pass,includeFullUserId:spec.full});
  if(spec.extra){assert.equal(result.code,'PIC_REQUEST_INVALID');assert.equal(result.readAttempted,false);assert.equal(reads,0);assert.equal(collections,0);assert.equal(result.userId,null);assert.equal(result.registrationState,'UNKNOWN');assert.equal(result.serverTimeIso,undefined);}
  else{assert.equal(result.ok,true);assert.equal(result.registrationState,'ABSENT');assert.equal(reads,1);assert.equal(result.readAttempted,true);assert.deepEqual(JSON.parse(JSON.stringify(fields)),[{_id:true,openid:true,status:true}]);}
  rows.push({case:spec.name,clientSentKeys:sentKeys,syntheticAddedKeys:Object.keys(spec.extra||{}),code:result.code,state:result.registrationState,identityConfirmed:result.identityConfirmed,readAttempted:result.readAttempted,reads,collections,fullIdReturned:typeof result.userId==='string'});
 }
 assert.equal(guardHits.length,probes);
 const result={schema:'codex-i1-request-field-reproduction/1',observedAt:new Date().toISOString(),basisCommit:'af9a2c0',roundId:prep.plan.checkRoundId,sourceHashes:hashes,verificationKind:'generated client and generated server entry + actual core; synthetic wx/db/context/clock/passphrase/transport; not platform envelope capture',cases:rows,checksPassed:rows.length,sensitivityAttempts:probes,unexpectedAttempts:guardHits.length-probes,cloudOperations:0,limitations:['Actual extra field name not known. userInfo is a synthetic hypothesis only.','Screenshot code maps to unknown top-level request key; no platform logs read.','includeFullUserId true succeeds in local normal control; do not blame opt-in checkbox.','Request-key validation precedes passphrase, context and clock checks; those gates are not proven by screenshot.']};
 fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({checksPassed:rows.length,sensitivityAttempts:probes,unexpectedAttempts:guardHits.length-probes,cases:rows}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>restore.reverse().forEach(f=>f()));
