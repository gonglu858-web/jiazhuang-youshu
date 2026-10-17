'use strict';
// 本轮本地具体包；无 CLI、登录、预览或部署。口令只以 Windows CurrentUser DPAPI 密文留在控制目录。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(process.argv.length,4);
const planPath=path.resolve(process.argv[2]),cipherPath=path.resolve(process.argv[3]);
const output=path.join(__dirname,'Codex参与者I2分层就绪轮包准备-20261017.json');assert(!fs.existsSync(output));
const hits=[],restore=[];
function guard(o,k){if(typeof o[k]!=='function')return;const old=o[k];o[k]=()=>{hits.push(k);throw Error('OFFLINE_ONLY');};restore.push(()=>o[k]=old);}
for(const m of ['node:http','node:https'])for(const k of ['request','get'])guard(require(m),k);
for(const k of ['connect','createConnection'])guard(require('node:net'),k);
guard(require('node:tls'),'connect');guard(globalThis,'fetch');
for(const k of ['lookup','resolve','resolve4','resolve6']){guard(require('node:dns'),k);guard(require('node:dns').promises,k);}
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])guard(require('node:child_process'),k);
try{
 assert.throws(()=>require('node:https').request('https://example.invalid'),/OFFLINE_ONLY/);
 assert.throws(()=>require('node:child_process').spawn('node',[]),/OFFLINE_ONLY/);
 const sensitivity=hits.length;
 assert.equal(sha(fs.readFileSync(path.join(root,'miniapp/scripts/package-participant-identity-check.cjs'))),'ba2d0102e483b909432a1f1e3f7b02c093b6d0c1912c828c6dcfc7658c4dd757');
 const tool=require('../../miniapp/scripts/package-participant-identity-check.cjs');
 const plan=tool.readPlan(planPath);assert(!plan.synthetic&&plan.participantCode==='2'&&plan.keyDiagnostic===false&&plan.requestProtocol==='participant-identity-request/1');
 assert.equal(path.dirname(planPath),path.dirname(cipherPath));assert(fs.statSync(cipherPath).size>100);
 const built=tool.build(planPath),checked=tool.checkDir(built.outDir);assert(checked.ok,JSON.stringify(checked.problems));
 process.env.PIC_CLOSE_SOURCE_DIR=plan.closeSourceDir;
 const close=tool.checkCloseDir(built.outDir);assert(close.ok);assert.equal(close.files,23);
 const rows=[];
 function walk(dir,rel=''){for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),r=rel?rel+'/'+n:n,s=fs.lstatSync(p);assert(!s.isSymbolicLink());if(s.isDirectory())walk(p,r);else {const b=fs.readFileSync(p);rows.push({rel:r,bytes:b.length,sha256:sha(b)});}}}
 walk(built.outDir);rows.sort((a,b)=>a.rel.localeCompare(b.rel));assert.equal(rows.length,39);
 const configs={};
 for(const [kind,sub]of [['candidate','server'],['closed','close/server']]){
  const config={envId:plan.envId,functionRoot:path.join(built.outDir,sub).replace(/\\/g,'/'),functions:[{name:plan.functionName,handler:'index.main',runtime:'Nodejs20.19',timeout:3,memorySize:256,type:'Event',installDependency:true,triggers:[]}]};
  const p=path.join(path.dirname(planPath),kind+'.cloudbaserc.json');fs.writeFileSync(p,JSON.stringify(config,null,2)+'\n',{flag:'wx'});configs[kind]={path:p,sha256:sha(fs.readFileSync(p)),config};
 }
 assert.equal(hits.length,sensitivity);
 const remote=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1分层就绪轮部署关闭-20261017.closed.json')));
 const remoteBytes=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1分层就绪轮字节核对-20261017.closed.json')));
 assert.equal(remoteBytes.matched,8);assert.equal(remote.archive.platformCodeSha256,remoteBytes.archiveSha256);
 for(const f of remoteBytes.files){const row=rows.find(x=>x.rel==='close/server/scheduleSandbox/'+f.path);assert(row);assert.equal(row.sha256,f.sha256);assert.equal(row.bytes,f.bytes);}
 assert.notEqual(plan.checkRoundId,remote.roundId);
 const record={schema:'codex-i2-specific-local-package/1',basisCommit:'20e8910',preparedAt:new Date().toISOString(),scriptSha256:sha(fs.readFileSync(__filename)),powershellSha256:sha(fs.readFileSync(__filename.replace(/cjs$/,'ps1'))),plan:JSON.parse(fs.readFileSync(planPath)),planPath,planSha256:sha(fs.readFileSync(planPath)),packageDir:built.outDir,manifestSha256:sha(fs.readFileSync(path.join(built.outDir,'manifest.json'))),files:rows,configs,passphrase:{bits:128,storage:'Windows CurrentUser DPAPI; separate control directory; no plaintext output',encryptedPath:cipherPath,notDelivered:true},checks:{candidateAndManifest:checked.ok,close:close.ok,closeFiles:close.files,totalFiles:rows.length,written:built.io.filter(x=>x.action==='written').length,sensitivityAttempts:sensitivity,unexpectedAttempts:hits.length-sensitivity},manualPreviewObservation:{thisRoundPerformed:false,method:'user manual preview after approval; do not infer this round success from prior QR'},
 remoteBaseline:{source:'Codex参与者I1分层就绪轮部署关闭-20261017.closed.json',observedAt:remote.finishedAt,codeSha256:remote.archive.platformCodeSha256,matchedCloseFiles:8,requeriedThisRound:false},
 executionOrder:['approval','open-new-project','manual-preview-once-while-remote-closed','candidate-deploy-and-readback','participant-one-self-read','paired-close-and-readback'],
 remoteExecuted:false,deploymentApproved:false,limitations:['本轮关闭8个源文件与最近已核远端关闭文件一致；新部署ZIP须另读回，不能推定ZIP字节相同。','本机3.0.1转换已有历史验证，本轮平台实际安装与返回仍须独立读回；本轮停用键诊断；本人绑定须用户同场见证，不能只凭口令。','口令仅限制持有者，不证明本人、不承诺一次性或全局限流。','超时或窗口剩余不足15分钟不开始候选部署；窗口失效需新轮次，不能修改本证据。']};
 fs.writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,roundId:plan.checkRoundId,packageDir:built.outDir,starts:plan.windowStartsAtIso,expires:plan.windowExpiresAtIso,checks:record.checks}));
}finally{for(const f of restore.reverse())f();}
