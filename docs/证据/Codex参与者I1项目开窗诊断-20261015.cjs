'use strict';
// 本地复核开窗诊断附件与冻结字节，不重放 IDE 或云端操作。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const prep=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1具体包准备-20261015.json')));
const screenshot=path.join(path.dirname(prep.planPath),'opened-project-diagnostic.jpg');
for(const f of prep.files)assert.equal(sha(fs.readFileSync(path.join(prep.packageDir,f.rel))),f.sha256);
const app=fs.readFileSync(path.join(prep.packageDir,'frontend/app.js'),'utf8');
const page=fs.readFileSync(path.join(prep.packageDir,'frontend/pages/identity-check/identity-check.js'),'utf8');
assert(app.includes('onLaunch()'));assert(page.includes('onLoad()')&&page.includes('onShow()'));
const r={schema:'codex-i1-window-diagnosis/1',basisCommit:'bc44c0a',observedAt:new Date().toISOString(),roundId:prep.plan.checkRoundId,project:prep.packageDir,frozenFileHashesMatched:prep.files.length,screenshot:{path:screenshot,sha256:sha(fs.readFileSync(screenshot)),bytes:fs.statSync(screenshot).size},scope:'offline artifact verification only; IDE observations recorded separately in report; no cloud or preview replay'};
assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--out');
fs.writeFileSync(path.resolve(process.argv[3]),JSON.stringify(r,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({frozenFileHashesMatched:r.frozenFileHashesMatched,screenshotExists:true,remoteCalls:0}));
