"use strict";
// 只读本地诊断现有打包器；使用合成身份材料、真实模式标志证明未来窗口在写前拒绝。
// 默认 stdout；--out wx。不会修改真实冻结包、系统时钟或受审源文件。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const hits=[],restore=[];function guard(o,k){if(typeof o[k]!=='function')return;const f=o[k];o[k]=()=>{hits.push(k);throw Error('OFFLINE_ONLY');};restore.push(()=>o[k]=f);}
for(const m of ['http','https'])for(const k of ['get','request'])guard(require('node:'+m),k);
for(const k of ['connect','createConnection'])guard(require('node:net'),k);guard(require('node:net').Socket.prototype,'connect');guard(require('node:tls'),'connect');guard(globalThis,'fetch');
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])guard(require('node:child_process'),k);
for(const k of ['lookup','resolve','resolve4','resolve6']){guard(require('node:dns'),k);guard(require('node:dns').promises,k);}
try{
 assert.throws(()=>require('node:https').request('https://example.invalid'),/OFFLINE_ONLY/);assert.throws(()=>require('node:child_process').spawn('node'),/OFFLINE_ONLY/);const probes=hits.length;
 const source=path.join(root,'miniapp/scripts/package-participant-identity-check.cjs'),before=hash(fs.readFileSync(source));const tool=require(source);
 const prep=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I2分层就绪轮包准备-20261017.json')));
 const round='future-window-local-'+crypto.randomBytes(6).toString('hex');const t=Date.now();
 const dir=path.join(root,'artifacts/schedule-sandbox/business-test',tool.OUT_PREFIX+round);assert(!fs.existsSync(dir));
 const planPath=path.join(root,'artifacts/schedule-sandbox',round+'.json');
 const plan={...prep.plan,checkRoundId:round,passphraseDigest:hash('synthetic-future-window-no-real-secret'),windowStartsAtIso:new Date(t+3600000).toISOString(),windowExpiresAtIso:new Date(t+5400000).toISOString(),note:'Local synthetic materials; synthetic=false solely tests real-mode future-window admission. Not a real execution package.'};
 fs.writeFileSync(planPath,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
 assert.equal(tool.readPlan(planPath).synthetic,false);
 let code;try{tool.build(planPath,dir);}catch(e){code=e.code;}
 assert.equal(code,tool.ERR.WINDOW_NOT_OPEN);assert(!fs.existsSync(dir));assert.equal(hash(fs.readFileSync(source)),before);
 const unexpected=hits.length-probes;assert.equal(unexpected,0);
 const result={schema:'codex-future-window-preparation-block/1',basisCommit:'d4c3205',observedAt:new Date().toISOString(),implementationSha256:before,syntheticMaterials:true,realExecutionPackage:false,systemClockModified:false,findings:{planAccepted:true,buildError:code,outputDirectoryCreated:false,sourceUnchanged:true},guardCounters:{sensitivity:probes,unexpected,total:hits.length},newCloudOperations:0,ok:code===tool.ERR.WINDOW_NOT_OPEN&&unexpected===0};
 const args=process.argv.slice(2),text=JSON.stringify(result,null,2)+'\n';if(args.length){assert.equal(args.length,2);assert.equal(args[0],'--out');fs.writeFileSync(args[1],text,{flag:'wx'});}else process.stdout.write(text);
}finally{restore.reverse().forEach(f=>f());}
