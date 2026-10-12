'use strict';
// 当次用户明确确认后的受审调用记录，不是可复用管理CLI。
// 固定批准接收时点/截止，排他调用标记及既有 started 双重防止重跑。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const confirmationObservedAt='2026-10-12T13:11:00.000Z';
const approvalDeadline=Date.parse(confirmationObservedAt)+10*60*1000;
const stem=path.join(__dirname,'Codex管理员初始化单次执行v2-20261012');
async function main(){
 assert.deepEqual(process.argv.slice(2),['--confirmed-v2-single-run']);
 assert.ok(Date.now()<approvalDeadline,'当次批准已失效');
 const proof=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex管理员执行包窗口更新-20261012.json'),'utf8'));
 assert.equal(proof.packageRevision,'primary-20261012-final-01-v2');
 for(const f of proof.checkedFiles)assert.equal(sha(fs.readFileSync(path.resolve(root,f.path))),f.sha256,'文件漂移');
 const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex首次管理员最终包本地核对-20261012.json'),'utf8'));
 assert.equal(process.execPath.toLowerCase(),path.resolve(root,baseline.runtime.node.path).toLowerCase());
 const items=[];
 function walk(dir){for(const d of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
  const p=path.join(dir,d.name);assert.equal(d.isSymbolicLink(),false);
  if(d.isDirectory())walk(p);else if(d.isFile())items.push([path.relative(baseline.runtime.sdkRoot,p).replace(/\\/g,'/'),sha(fs.readFileSync(p))]);else throw new Error('依赖形状异常');
 }}
 walk(baseline.runtime.sdkRoot);assert.equal(sha(JSON.stringify(items)),proof.sdkTreeSha256);
 const planBytes=fs.readFileSync(path.join(__dirname,proof.planFile));assert.equal(sha(planBytes),proof.planSha256);
 const plan=JSON.parse(planBytes);assert.equal(plan.roundId,'primary-20261012-final-01');
 assert.ok(Date.now()<Date.parse(plan.expiresAt));assert.equal(fs.existsSync(proof.outDir),false,'发现既有运行目录');
 const lib=path.join(root,'miniapp/scripts/lib');
 const host=require(path.join(lib,'sandbox-primary-execution-host.cjs'));
 const entry=require(path.join(lib,'sandbox-primary-approved-run.cjs'));
 const p4=require(path.join(lib,'sandbox-primary-bootstrap.cjs'));
 assert.equal(host.realModeOfflineHarnessActive(),false);
 const approvedBy='project-owner-chat-confirmation:primary-20261012-final-01';
 const approval={approvedUserIds:[plan.targetUserId],approvedBy,approvedAt:confirmationObservedAt};
 p4.validateApprovalContext(approval);p4.validatePlan(plan);p4.assertApprovedTarget(approval,plan.targetUserId);
 const authorization={packageRevision:proof.packageRevision,roundId:plan.roundId,
  confirmationObservedAt,confirmationTimeMeaning:'本助手本轮首次读取时钟的接收记录；不是平台提供的聊天发送时间',
  confirmationText:'同意执行管理员初始化v2：尾号2d3aa4，仅新增两条记录，允许本次凭据获取与核对，接受现有套餐用量消耗，保持入口关闭。',
  approvedBy,approvalExpiresAt:new Date(approvalDeadline).toISOString(),
  planSha256:proof.planSha256,expectedSubjectDigest:proof.expectedSubjectDigest,
  runnerSha256:sha(fs.readFileSync(__filename)),invocationAt:new Date().toISOString(),
  noDependencyInjection:true,writeScope:['initializePrimary'],platformSuccessNotYetKnown:true};
 fs.writeFileSync(stem+'.authorized.json',JSON.stringify(authorization,null,2)+'\n',{flag:'wx'});
 const approvalSource=host.issueControlledApproval({plan,approval,approvedBy,writeScope:['initializePrimary'],
  expiresAtMs:Math.min(approvalDeadline,Date.parse(plan.expiresAt)),expectedSubjectDigest:proof.expectedSubjectDigest,credentialSourceMode:'fixed-real-source'});
 const result=await entry.runOnce({runId:plan.roundId,outDir:proof.outDir,plan,approvalSource,roundId:plan.roundId,credentialSourceMode:'fixed-real-source'});
 // 仅保存入口/宿主已净化结果，不持久化句柄或凭据。
 const report={finishedAt:new Date().toISOString(),...result};
 fs.writeFileSync(stem+'.result.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 process.stdout.write(JSON.stringify({status:result.status,saved:result.saved,report:stem+'.result.json'})+'\n');
 if(result.status!=='COMPLETED')process.exitCode=1;
}
main().catch(e=>{
 const allowed=new Set(['APR_TERMINAL_SAVE_FAILED','APR_STARTED_EXISTS','APR_TERMINAL_EXISTS','APR_TERMINAL_DIR_CHECK_FAILED',
  'APR_STARTED_CREATE_FAILED','ERR_ASSERTION','EEXIST','EACCES','EIO','ENOENT']);
 const out={finishedAt:new Date().toISOString(),status:'STOPPED_NO_RETRY',errorCode:allowed.has(e.code)?e.code:'UNCLASSIFIED_STOP',
  execution:e.code==='APR_TERMINAL_SAVE_FAILED'&&e.execution?e.execution:null};
 try{fs.writeFileSync(stem+'.exception.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});}catch(_){/*不覆盖或重复保存*/}
 process.stdout.write(JSON.stringify({status:out.status,errorCode:out.errorCode,hasExecutionFacts:out.execution!==null})+'\n');process.exitCode=1;
});
