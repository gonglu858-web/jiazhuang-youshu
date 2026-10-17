'use strict';
// C1证据版本复核：仅本地git/字节比较；默认stdout，--out wx新建。测试实测汇总单独标注。
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),parent='acd0641',reviewed='446fe95';
const git=(...a)=>cp.execFileSync('git',a,{cwd:root}),blob=(rev,rel)=>git('show',rev+':'+rel),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const v2='docs/证据/CodeBuddy受控诊断R1R4收尾v2-20261017.cjs',v3=v2.replace('v2-','v3-');
const original=blob('f7cb27f',v2),tree=blob(reviewed,v2),disk=fs.readFileSync(path.join(root,v2));
assert.ok(original.equals(tree));assert.ok(original.equals(disk));assert.equal(original.length,24548);
const oldCurrent=blob(parent,v2).toString('utf8'),newVersion=blob(reviewed,v3).toString('utf8');
assert.equal(newVersion.slice(newVersion.indexOf('\n')+1),oldCurrent.slice(oldCurrent.indexOf('\n')+1));
// 用两次ls-tree比较全部历史Git blob ID；相同ID指向同一保存的blob，避免逐文件启动Git。
const entries=rev=>new Map(git('ls-tree','-r','-z',rev,'--','docs/证据').toString().split('\0').filter(Boolean).map(line=>{const t=line.indexOf('\t');return [line.slice(t+1),line.slice(0,t)];}));
const beforeEntries=entries(parent),afterEntries=entries(reviewed);
const changedHistory=[];let protectedEvidenceCount=0;
for(const [rel,id] of beforeEntries){if(rel===v2)continue;assert.equal(afterEntries.get(rel),id,rel);protectedEvidenceCount++;}
const protectedPaths=['miniapp/scripts','miniapp/cloudfunctions','miniapp/miniprogram','miniapp/pages','miniapp/project.config.json','docs/Codex*'];
assert.equal(git('diff','--name-only',parent,reviewed,'--',...protectedPaths).toString().trim(),'');
const histories=['docs/进展与待办.md','docs/CodeBuddy开发交接.md'].map(rel=>{const a=blob(parent,rel),b=blob(reviewed,rel);assert.ok(b.subarray(b.length-a.length).equals(a));return {rel,addedBytes:b.length-a.length,oldBlobSuffixEqual:true};});
const testRel='miniapp/tests/participant-identity-check.test.cjs';
let expectedTest=blob(parent,testRel).toString('utf8');
expectedTest=expectedTest.replace("test('D7 收尾证据v2外层判定：","test('D7 收尾证据v3外层判定：");
expectedTest=expectedTest.replace('（历史20261016脚本保留为347261a字节）\', async () => {','（v2 已按 f7cb27f 字节恢复为历史版本；历史20261016脚本保留为347261a字节）\', async () => {');
expectedTest=expectedTest.replace("'CodeBuddy受控诊断R1R4收尾v2-20261017.cjs'","'CodeBuddy受控诊断R1R4收尾v3-20261017.cjs'");
assert.equal(blob(reviewed,testRel).toString('utf8'),expectedTest);
const rerunFile='Codex复跑I1收尾v3-20261017.json',rerunBytes=fs.readFileSync(path.join(__dirname,rerunFile)),r=JSON.parse(rerunBytes);
assert.equal(r.ok,true);assert.deepEqual(r.guardCounters,{sensitivityAttempts:2,businessPhaseGuardAttempts:0,total:2});
assert.deepEqual([r.r1.baseline.exitCode,r.r1.caughtAttempt.exitCode,r.r1.sourceDrift.exitCode],[0,1,1]);
const changed=git('-c','core.quotepath=false','diff','--name-only',parent,reviewed).toString().trim().split('\n');
assert.deepEqual(changed.sort(),[v2,v3,v3.replace('.cjs','.json'),testRel,'docs/当前状态.md','docs/进展与待办.md','docs/CodeBuddy开发交接.md'].sort());
const result={schema:'codex-i1-evidence-version-review/1',reviewed,parent,observedAt:new Date().toISOString(),ok:true,
 restored:{rel:v2,baseline:'f7cb27f',bytes:tree.length,sha256:sha(tree),treeAndDiskEqual:true},
 newVersion:{rel:v3,onlyFirstCommentDiffersFromParentActiveVersion:true,sha256:sha(blob(reviewed,v3))},
 protectedEvidenceCount,changedHistory,protectedPaths,productDiffEmpty:true,testAssertionsUnchanged:true,histories,changedFiles:changed,
 rerun:{file:rerunFile,sha256:sha(rerunBytes),ok:r.ok,guardCounters:r.guardCounters,auditExitCodes:[0,1,1]},
 testsObserved:{command:"node --test --test-name-pattern='^D[67] ' miniapp/tests/participant-identity-check.test.cjs",pass:2,fail:0,skip:0,exitCode:0,note:'本轮已单独运行；D6覆盖审计正常/被catch意外/漂移，D7覆盖v3外层正常/被catch意外。本脚本不重复执行。'},
 cloudOperations:0,limits:'仅本地C1版本整理通过；沿用上轮产品复查，不代表真实平台验证或真实执行批准。'};
const text=JSON.stringify(result,null,2)+'\n',i=process.argv.indexOf('--out');if(i>=0){assert.ok(process.argv[i+1]);fs.writeFileSync(process.argv[i+1],text,{flag:'wx'});}console.log(text);
