'use strict';
// 本轮具体制品离线复核；无真实批准时部署入口须在凭据前停止。默认stdout，--out wx。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const prep=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1分层核验包准备-20261017.json'))),frozen=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1分层核验执行脚本冻结-20261017.json')));
const hits=[],restore=[];function guard(o,k){if(typeof o[k]!=='function')return;const prev=o[k];o[k]=()=>{hits.push(k);throw Error('OFFLINE_ONLY');};restore.push(()=>o[k]=prev);}
for(const m of ['http','https'])for(const k of ['request','get'])guard(require('node:'+m),k);
for(const k of ['connect','createConnection'])guard(require('node:net'),k);guard(require('node:net').Socket.prototype,'connect');guard(require('node:tls'),'connect');guard(globalThis,'fetch');
for(const k of ['lookup','resolve','resolve4','resolve6']){guard(require('node:dns'),k);guard(require('node:dns').promises,k);}
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])guard(require('node:child_process'),k);
try{
assert.throws(()=>require('node:https').request('https://example.invalid'),/OFFLINE_ONLY/);assert.throws(()=>require('node:child_process').spawn('node'),/OFFLINE_ONLY/);const probes=hits.length;
assert.equal(sha(fs.readFileSync(prep.planPath)),prep.planSha256);assert.equal(sha(fs.readFileSync(path.join(prep.packageDir,'manifest.json'))),prep.manifestSha256);
const packer=require('../../miniapp/scripts/package-participant-identity-check.cjs');assert(packer.checkDir(prep.packageDir).ok);process.env.PIC_CLOSE_SOURCE_DIR=prep.plan.closeSourceDir;assert(packer.checkCloseDir(prep.packageDir).ok);
assert.equal(prep.plan.schema,'participant-identity-plan/2');assert.equal(prep.plan.keyDiagnostic,false);assert.equal(prep.plan.requestProtocol,'participant-identity-request/1');
for(const f of prep.files){const b=fs.readFileSync(path.join(prep.packageDir,f.rel));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}assert.equal(prep.files.length,39);
for(const f of frozen.scripts)assert.equal(sha(fs.readFileSync(path.join(__dirname,f.name))),f.sha256);
const script=path.join(__dirname,frozen.scripts[0].name),src=fs.readFileSync(script,'utf8');
const failures=[];for(const mode of ['candidate','closed']){
let error;try{vm.runInNewContext(src,{require:createRequire(script),__dirname,path,process:{argv:['node',script,mode],env:process.env},console,Buffer,URL,AbortSignal,fetch});}catch(e){error=e;}
assert.equal(error&&error.code,'ENOENT');assert.equal(path.basename(error.path),'Codex参与者I1分层核验批准-20261017.json');failures.push({mode,rejectedBeforeMain:true,reason:'missing new round approval'});
}
assert.equal(hits.length-probes,0);
const result={schema:'codex-i1-layer-specific-preflight/1',basis:'f20009a',roundId:prep.plan.checkRoundId,planSha256:prep.planSha256,manifestSha256:prep.manifestSha256,files:39,candidateFiles:15,closeFiles:23,checked:true,missingApproval:failures,guardCounters:{sensitivity:probes,unexpected:hits.length-probes},remoteExecuted:false,credentialsFetched:false,approvalCreated:false,windowExpiredAt:new Date(prep.plan.windowExpiresAtIso).toISOString()};
const text=JSON.stringify(result,null,2)+'\n',i=process.argv.indexOf('--out');if(i>=0){assert(process.argv[i+1]);fs.writeFileSync(process.argv[i+1],text,{flag:'wx'});}console.log(text);
}finally{restore.reverse().forEach(f=>f());}
