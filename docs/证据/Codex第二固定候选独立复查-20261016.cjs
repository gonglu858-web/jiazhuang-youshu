'use strict';
// 本地复查；Git 只读在守卫安装前完成，核心/客户端运行时无网络或子进程。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),vm=require('node:vm'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const git=(...a)=>cp.execFileSync('git',a,{cwd:root});
const changed=git('diff','--name-only','-z','196f91c','f0b7fa9').toString().split('\0').filter(Boolean);
const protectedPaths=['miniapp/cloudfunctions','miniapp/miniprogram','miniapp/pages','miniapp/project.config.json','miniapp/scripts/package-business-test.cjs','miniapp/scripts/package-sandbox.cjs','miniapp/scripts/package-sandbox-registration.cjs'];
assert.equal(git('diff','196f91c','f0b7fa9','--',...protectedPaths).length,0);
assert(!changed.some(x=>x.startsWith('miniapp/scripts/lib/sandbox-')));
const history={};for(const p of ['docs/进展与待办.md','docs/CodeBuddy开发交接.md']){const old=git('show','196f91c:'+p),next=git('show','f0b7fa9:'+p);assert(next.subarray(next.length-old.length).equals(old));history[p]={oldBytes:old.length,addedBytes:next.length-old.length,exactSuffix:true};}
const previousJson=git('ls-tree','-r','--name-only','-z','196f91c','docs/证据').toString().split('\0').filter(x=>x.endsWith('.json'));
assert(!previousJson.some(x=>changed.includes(x)));
const hits=[],restores=[];function guard(o,k){if(typeof o[k]!=='function')return;const old=o[k];o[k]=()=>{hits.push(k);throw Error('OFFLINE_GUARD');};restores.push(()=>o[k]=old);}
for(const m of ['node:http','node:https'])for(const k of ['request','get'])guard(require(m),k);
for(const k of ['connect','createConnection'])guard(require('node:net'),k);guard(require('node:tls'),'connect');guard(globalThis,'fetch');
for(const k of ['lookup','resolve','resolve4','resolve6']){guard(require('node:dns'),k);guard(require('node:dns').promises,k);}
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])guard(cp,k);
(async()=>{try{
 assert.throws(()=>require('node:https').request('https://example.invalid'),/OFFLINE_GUARD/);assert.throws(()=>cp.spawn('node'),/OFFLINE_GUARD/);const probes=hits.length;
 const core=require('../../miniapp/scripts/lib/participant-identity-check.cjs');
 assert.deepEqual(core.REQUEST_FIELDS,['action','passphrase','checkRoundId','includeFullUserId']);
 assert.deepEqual({...core.KEY_DIAGNOSTIC_CANDIDATES},{userInfo:'CANDIDATE_USERINFO',wxCloudApiToken:'CANDIDATE_WX_CLOUD_API_TOKEN'});
 const config={checkRoundId:'synthetic-codex-second-key',passphraseDigest:sha('synthetic-pass'),windowStartsAtMs:100,windowExpiresAtMs:1000,keyDiagnostic:true};
 const trusted={appId:core.FIXED_TARGET.appId,envId:core.FIXED_TARGET.envId,openid:'synthetic-openid'};
 let dbCalls=0,getters=0;const db={collection(){dbCalls++;throw Error('synthetic-db-forbidden');}};
 const base=()=>({action:'inspectSelf',checkRoundId:config.checkRoundId,passphrase:'synthetic-pass'});
 const run=(event,opts={})=>core.createIdentityChecker({db,trusted:opts.trusted||trusted,config:{...config,...opts.config},now:opts.now||(()=>500)}).handle(event);
 const rows=[];async function fail(name,event,opts,has){const r=await run(event,opts);assert.equal(r.code,'PIC_REQUEST_INVALID');assert.equal(r.registrationState,'UNKNOWN');assert.equal(r.readAttempted,false);assert.equal(r.identityConfirmed,false);assert.equal(!!r.keyDiagnostic,has);assert.equal(dbCalls,0);rows.push({name,diagnostic:!!r.keyDiagnostic,dbCalls,code:r.code});return r;}
 const e=base();for(const k of ['userInfo','wxCloudApiToken'])Object.defineProperty(e,k,{enumerable:true,get(){getters++;throw Error('synthetic-secret-value');}});
 const dual=await fail('dual-getters',e,{},true);assert.equal(getters,0);assert.equal(dual.keyDiagnostic.otherKeyCount,0);assert.equal(dual.keyDiagnostic.candidateLabels.length,2);
 const secret='synthetic-private-key-'+ 'z'.repeat(40);const s=await fail('secret-and-forged-identity',{...base(),userInfo:null,wxCloudApiToken:null,[secret]:'synthetic-secret-value',openid:'synthetic-forged',role:'synthetic-owner'}, {},true);assert.equal(s.keyDiagnostic.otherKeyCount,3);assert(!JSON.stringify(s).includes(secret));assert(!JSON.stringify(s).includes('synthetic-forged'));assert(!JSON.stringify(s).includes('synthetic-secret-value'));
 const similar=await fail('similar-names',{...base(),WXCloudApiToken:0,wxcloudapitoken:0,wxCloudApiTokenX:0},{},true);assert.equal(similar.keyDiagnostic.candidateLabels.length,0);assert.equal(similar.keyDiagnostic.otherKeyNameLengthBuckets['len9-16'],3);
 const own=base();Object.setPrototypeOf(own,{wxCloudApiToken:'synthetic-inherited'});Object.defineProperty(own,'userInfo',{value:0,enumerable:false});own.extra=0;const or=await fail('own-enumerable-only',own,{},true);assert.equal(or.keyDiagnostic.candidateLabels.length,0);assert.equal(or.keyDiagnostic.otherKeyCount,1);
 for(const [name,event,opts]of [['disabled',e,{config:{keyDiagnostic:false}}],['password',{...base(),passphrase:'synthetic-wrong',wxCloudApiToken:0},{}],['round',{...base(),checkRoundId:'synthetic-wrong',wxCloudApiToken:0},{}],['context',e,{trusted:{...trusted,openid:''}}]])await fail(name,event,opts,false);
 for(const index of [2,3])for(const mode of ['expired','nan','throw']){let n=0;await fail('clock-'+index+'-'+mode,e,{now:()=>{if(++n!==index)return 500;if(mode==='throw')throw Error('synthetic-clock');return mode==='nan'?NaN:1000;}},false);}
 const clientPath='miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js';let reply;const box={module:{exports:{}},require:n=>{assert.equal(n,'../config/cloud');return {envId:trusted.envId,checkRoundId:config.checkRoundId,identityCheckFunction:'scheduleSandbox'};},wx:{cloud:{init(){},callFunction:async()=>({result:reply})}}};vm.runInNewContext(fs.readFileSync(path.join(root,clientPath),'utf8'),box);
 const client=[];for(const [name,diag,want]of [['valid',dual.keyDiagnostic,true],['truncated',{...dual.keyDiagnostic,truncated:true},false],['duplicate',{...dual.keyDiagnostic,candidateLabels:['CANDIDATE_WX_CLOUD_API_TOKEN','CANDIDATE_WX_CLOUD_API_TOKEN']},false],['unknown',{...dual.keyDiagnostic,candidateLabels:['synthetic-unknown-label']},false]]){reply={code:'PIC_REQUEST_INVALID',registrationState:'UNKNOWN',readAttempted:false,keyDiagnostic:diag};const r=await box.module.exports.callIdentityCheck(base());assert.equal(!!r.keyDiagnostic,want);assert.equal(r.code,'PIC_REQUEST_INVALID');assert.equal(r.readAttempted,false);client.push({name,retained:!!r.keyDiagnostic});}
 const frozen=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1受控诊断包准备-20261016.json')));let frozenFiles=0;for(const f of frozen.files){assert.equal(sha(fs.readFileSync(path.join(frozen.packageDir,f.rel))),f.sha256);frozenFiles++;}assert.equal(frozenFiles,38);
 const pins={};for(const p of ['miniapp/scripts/lib/participant-identity-check.cjs',clientPath,'miniapp/scripts/package-participant-identity-check.cjs'])pins[p]=sha(fs.readFileSync(path.join(root,p)));
 const result={schema:'codex-second-key-review/1',reviewedCommit:'f0b7fa9',basis:'196f91c',pins,coreCases:rows,clientCases:client,getterReads:getters,dbCalls,history,previousJsonFilesPreserved:previousJson.length,protectedPathsUnchanged:true,frozenFiles,guard:{sensitivityAttempts:probes,unexpectedAttempts:hits.length-probes,total:hits.length},ok:hits.length===probes,limitations:['All runtime inputs synthetic; no platform verification or real identity conclusion.','SDK regression is a separate local run; this script does not obtain credentials.']};
 const out=process.argv[2];if(out){assert.equal(process.argv.length,3);fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});}else console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}finally{for(const f of restores.reverse())f();}})().catch(e=>{console.error(e);process.exitCode=1;});
