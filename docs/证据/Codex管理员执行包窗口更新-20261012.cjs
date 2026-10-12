'use strict';
// 本地窗口更新核对；不签发批准、不启动子进程、不读取认证目录。
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const old=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex首次管理员最终包本地核对-20261012.json'),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const checked=[];
for(const f of [...old.implementationFiles,old.runtime.node,old.runtime.cliEntry,old.runtime.cliBundle,...old.historicalEvidence]){
 const p=path.resolve(root,f.path); assert.equal(sha(fs.readFileSync(p)),f.sha256,f.path); checked.push(f);
}
const items=[];
function walk(dir){for(const d of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
 const p=path.join(dir,d.name); assert.equal(d.isSymbolicLink(),false);
 if(d.isDirectory())walk(p); else if(d.isFile())items.push([path.relative(old.runtime.sdkRoot,p).replace(/\\/g,'/'),sha(fs.readFileSync(p))]);else throw new Error('非普通依赖项');
}}
walk(old.runtime.sdkRoot); assert.equal(sha(JSON.stringify(items)),old.runtime.sdkTreeSha256);
assert.equal(fs.existsSync(old.outDir),false,'已有执行目录，停止更新');
const oldPlanPath=path.join(__dirname,'Codex首次管理员最终计划-20261012.json');
const oldBytes=fs.readFileSync(oldPlanPath); assert.deepEqual(JSON.parse(oldBytes),old.plan);
const plan={...old.plan,expiresAt:'2026-10-12T14:00:00.000Z'};
const p4=require(path.join(root,'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs'));
p4.validatePlan(plan);
assert.equal(p4.inputDigest(plan),old.inputDigest);
assert.equal(p4.auditId(plan,p4.inputDigest(plan)),old.auditId);
const planName='Codex首次管理员最终计划-20261012-v2.json';
const planBytes=Buffer.from(JSON.stringify(plan,null,2).replace(/\n/g,'\r\n')+'\r\n');
const result={status:'PREPARED_AWAITING_RECONFIRMATION',observedAt:new Date().toISOString(),packageRevision:'primary-20261012-final-01-v2',
 writeAuthorized:false,approvalIssued:false,credentialFetched:false,cloudCallAttempted:false,initializationAttempted:false,
 oldPlanActualSha256:sha(oldBytes),oldPlanRecordedSha256:old.planFile.sha256,
 oldPlanBytesMatchRecorded:sha(oldBytes)===old.planFile.sha256,
 oldPlanSemanticMatch:true,oldPlanExpired:Date.now()>Date.parse(old.plan.expiresAt),
 planFile:planName,planSha256:sha(planBytes),plan,inputDigest:p4.inputDigest(plan),auditId:old.auditId,
 fullPlanDigest:sha(JSON.stringify(Object.keys(plan).sort().map(k=>[k,plan[k]]))),
 expectedSubjectDigest:old.expectedSubjectDigest,outDir:old.outDir,outDirAbsent:true,
 checkedFiles:checked,sdkTreeFiles:items.length,sdkTreeSha256:sha(JSON.stringify(items)),
 notes:['同一轮次和审计键，仅变更截止时间，未签发批准','本地无执行目录不等于重新查询云端；执行前仍走事务内检查','若旧计划哈希失配但字段一致，保留差异，不回写旧证据']};
const args=process.argv.slice(2);
assert.ok(args.length===0||(args.length===1&&args[0]==='--save-new'));
if(args.length){
 fs.writeFileSync(path.join(__dirname,planName),planBytes,{flag:'wx'});
 fs.writeFileSync(path.join(__dirname,'Codex管理员执行包窗口更新-20261012.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
}
process.stdout.write(JSON.stringify(result,null,2)+'\n');
