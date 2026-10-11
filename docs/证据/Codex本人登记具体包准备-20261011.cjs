'use strict';
// 本地真实候选制品准备；不部署、不预览、不联网。实际当前时钟，不伪造 generatedAt。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const reg=require(path.join(ROOT,'miniapp/scripts/package-sandbox-registration.cjs'));
const asm=require(path.join(ROOT,'miniapp/scripts/assemble-sandbox-registration.cjs'));
const output=path.join(__dirname,'Codex本人登记具体包准备-20261011.json');
assert(!fs.existsSync(output),'Evidence already exists; do not overwrite or rebuild silently.');
const guard=asm.installNetworkGuard({});
try{
 const started=Date.now(),id='self-'+started+'-'+crypto.randomBytes(8).toString('hex');
 const plan={purpose:'本人微信一次登记，匹配固定名单后登记并立即关闭，不授予管理员权限',...reg.FIXED_TARGET,allowedUserIds:[reg.CANDIDATE_USER_ID],roundId:id,windowStartsAt:new Date(started).toISOString(),windowExpiresAt:new Date(started+30*60*1000).toISOString(),sourceVersion:reg.REVIEWED_SOURCE_VERSION,synthetic:false};
 const control=path.join(ROOT,'artifacts/schedule-sandbox/registration-control-'+id);fs.mkdirSync(control,{recursive:false});
 const planPath=path.join(control,'plan.json');fs.writeFileSync(planPath,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
 const a=reg.buildRegistration(plan,{outId:id});assert(a.ok,JSON.stringify(a.problems));
 const b=asm.buildAssembly({plan,inputDir:a.dir,artifactKind:'real-candidate',outId:id,networkGuard:guard});assert(b.ok,JSON.stringify(b.problems));
 const check=asm.checkAssembly({plan,inputDir:a.dir,outDir:b.dir,artifactKind:'real-candidate',networkGuard:guard});assert(check.ok,JSON.stringify(check.problems));
 const files=[];function scan(dir,rel=''){for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),r=rel?rel+'/'+n:n;assert(!fs.lstatSync(p).isSymbolicLink());if(fs.statSync(p).isDirectory())scan(p,r);else {const bytes=fs.readFileSync(p);files.push({path:r,bytes:bytes.length,sha256:sha(bytes)});}}}scan(b.dir);assert.equal(files.length,49);
 const base=JSON.parse(fs.readFileSync(path.join(ROOT,'artifacts/schedule-sandbox/registration-closed-baseline-20261011/cloudbaserc.json'),'utf8'));
 const configs={};for(const [kind,sub]of [['registration','registration-project'],['closed','closed-project']]){const p=path.join(control,kind+'.cloudbaserc.json'),cfg={...base,functionRoot:path.join(b.dir,sub,'cloudfunctions').replace(/\\/g,'/')};fs.writeFileSync(p,JSON.stringify(cfg,null,2)+'\n',{flag:'wx'});configs[kind]={path:p,sha256:sha(fs.readFileSync(p))};}
 assert.equal(guard.attempts.length,0);
 const record={schema:'specific-registration-local-preparation/1',preparedAt:new Date().toISOString(),scriptSha256:sha(fs.readFileSync(__filename)),plan,planPath,planSha256:sha(fs.readFileSync(planPath)),inputDir:a.dir,assemblyDir:b.dir,configs,files,checks:{registrationBuilt:a.ok,assemblyBuilt:b.ok,currentTimeCheckPassed:check.ok,fileCount:files.length,networkAttempts:guard.attempts.length},toolStateObserved:{success:true,loginExpired:false,versionRelation:'equal',cliTokenRequired:false,source:'本轮只读微信工具状态安全字段投影'},deploymentAuthorized:false,registrationAuthorized:false,cloudExecuted:false,limitations:['真实候选生成/check通过不是部署授权。','本轮没有扫码、预览或真实SDK业务调用。','首次未绑定identify未知结果仍无持久防重，必须停止，不重发。','实际窗口已开始计时，到期停止并重新准备，不能改时钟或覆盖历史证据。']};
 fs.writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,assemblyDir:b.dir,planPath,windowExpiresAt:plan.windowExpiresAt,files:files.length,checks:record.checks},null,2));
}finally{asm.restoreNetworkGuard(guard);}
