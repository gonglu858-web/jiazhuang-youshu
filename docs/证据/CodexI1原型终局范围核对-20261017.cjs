'use strict';
// 仅本地Git字节/路径核对；不执行历史证据，不调用云端。默认stdout；--out wx。
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
let gitReads = 0;
const git = (...args) => { gitReads++; return cp.execFileSync('git', args, { cwd: root }); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const reviewed = 'e62e256', parent = 'f7cb27f';
const restored = ['docs/证据/CodeBuddyI1入站事件封装离线核实-20261016.cjs', 'docs/证据/CodeBuddy受控诊断R1R4收尾-20261016.cjs'].map(rel => {
  const original = git('show', '347261a:' + rel), tree = git('show', reviewed + ':' + rel), disk = fs.readFileSync(path.join(root, rel));
  assert.ok(original.equals(tree)); assert.ok(original.equals(disk));
  return { rel, bytes: original.length, originalSha256: sha(original), reviewedTreeEqual: true, diskEqual: true };
});
const priorAuditRel='docs/证据/CodeBuddyI1入站审计v7-20261017.cjs';
assert.ok(git('show',parent+':'+priorAuditRel).equals(git('show',reviewed+':'+priorAuditRel)));
const wrapperRel='docs/证据/CodeBuddy受控诊断R1R4收尾v2-20261017.cjs';
const beforeWrapper=git('show',parent+':'+wrapperRel),afterWrapper=git('show',reviewed+':'+wrapperRel);
const expected=beforeWrapper.toString('utf8').replace('// 指向本轮新命名审计脚本 v7；历史 20261016 审计脚本保留为 347261a 字节，不对当前树运行。','// 指向本轮新命名审计脚本 v8；历史 20261016 审计脚本保留为 347261a 字节，v7 保持上一轮已交付字节。').replace("'CodeBuddyI1入站审计v7-20261017.cjs'","'CodeBuddyI1入站审计v8-20261017.cjs'");
assert.ok(Buffer.from(expected).equals(afterWrapper));assert.equal(beforeWrapper.equals(afterWrapper),false);
const historicalWrapper={rel:wrapperRel,unchanged:false,beforeBytes:beforeWrapper.length,afterBytes:afterWrapper.length,beforeSha256:sha(beforeWrapper),afterSha256:sha(afterWrapper),difference:'two lines: audit v7 to v8 and adjacent comment; no other changes'};
const histories = ['docs/进展与待办.md','docs/CodeBuddy开发交接.md'].map(rel => {
  const before = git('show',parent + ':' + rel), after = git('show',reviewed + ':' + rel);
  assert.ok(after.length >= before.length && after.subarray(after.length-before.length).equals(before));
  return {rel, addedBytes:after.length-before.length, oldBlobSuffixEqual:true};
});
const protectedPaths = ['miniapp/scripts/lib','miniapp/cloudfunctions','miniapp/miniprogram','miniapp/pages','miniapp/project.config.json',
  'miniapp/scripts/package-business-test.cjs','miniapp/scripts/package-sandbox.cjs','miniapp/scripts/package-sandbox-registration.cjs',
  'docs/证据/Codex*','docs/Codex复查-I1请求分层兼容实现-20261017.md'];
const protectedChanged = git('diff','--name-only',parent,reviewed,'--',...protectedPaths).toString('utf8').trim();
assert.equal(protectedChanged,'');
const changedExistingJson = git('diff','--name-only','--diff-filter=MDTR',parent,reviewed,'--','docs/证据/*.json').toString('utf8').trim();
assert.equal(changedExistingJson,'');
const core = fs.readFileSync(path.join(root,'miniapp/scripts/lib/participant-identity-check.cjs'));
assert.equal(sha(core),'cd4de68150e8d69afc69af43451f7d99c5395e8088e425630604cc8cf9ed92e7');
const files = ['Codex复跑I1原型终局-20261017.json','Codex复跑I1审计v8-20261017.json'];
const rerun = files.map(name => { const bytes=fs.readFileSync(path.join(__dirname,name)), r=JSON.parse(bytes); assert.equal(r.ok,true); return {name,sha256:sha(bytes),ok:r.ok}; });
const result={schema:'codex-i1-prototype-final-scope/1',reviewed,parent,observedAt:new Date().toISOString(),restored,histories,historicalWrapper,priorAuditUnchanged:true,
  protectedPaths,protectedChanged,changedExistingJson,coreSha256:sha(core),rerun,gitReadCommands:gitReads,
  regressionsObserved:{identity:{pass:35,fail:0,skip:0},business:{pass:18,fail:0,skip:0},sdk:{pass:1,fail:0,skip:0},
    note:'复查本轮已单独运行三个node --test命令；此脚本只记录其终端汇总，不重复测试。'},
  scopeAssertionsPassed:true,allHistoricalScriptsUnchanged:false,remaining:'产品R1闭合；既有收尾v2脚本仍被改两行，需要恢复并以新命名版本承接。',cloudOperationsPerformed:false};
const text=JSON.stringify(result,null,2)+'\n',i=process.argv.indexOf('--out');
if(i>=0){assert.ok(process.argv[i+1]);fs.writeFileSync(process.argv[i+1],text,{flag:'wx'});} console.log(text);
