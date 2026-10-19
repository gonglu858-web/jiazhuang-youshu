'use strict';
// 方案依据核对：仅文件读取/摘要；不加载业务代码，不执行SDK/子进程/网络。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=['miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js','miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js','miniapp/scripts/lib/participant-identity-check.cjs','miniapp/scripts/templates/participant-identity-check/server/request-adapter.js','miniapp/scripts/package-participant-identity-check.cjs'];
const text=files.map(f=>fs.readFileSync(path.join(root,f),'utf8'));
assert(text[0].includes('checkRoundId: cloudConfig.checkRoundId'));
assert(text[0].includes('data: payload'));
assert(text[1].includes('checkRoundId: response.checkRoundId'));
assert(text[2].includes('checkRoundId: config.checkRoundId'));
assert(text[2].includes('payload.checkRoundId !== config.checkRoundId'));
assert(text[3].includes('checkRoundId: descs.checkRoundId.value'));
const target='docs/CodeBuddy任务-手机请求轮次与预览版本本地核对-20261019.md';assert(fs.existsSync(path.join(root,target)));
const result={schema:'codex-round-preview-design-basis/1',reviewBasis:'d3a03d0',observedAt:new Date().toISOString(),verificationKind:'static source anchors only; not implementation or platform test',sourceFiles:files.map(f=>({path:f,sha256:sha(fs.readFileSync(path.join(root,f)))})),taskDocument:{path:target,sha256:sha(fs.readFileSync(path.join(root,target)))},sourceAnchorAssertions:6,ok:true,plannedLayers:['local preview build ID','snapshot of round handed to SDK','server returned round'],implemented:false,requiredServerChanges:false,networkFieldsAdded:false,realCloudCalls:0,credentialReads:0,participantsAskedToRetry:false,limitations:['local handoff snapshot cannot prove platform ingress','build ID is package attribution, not official WeChat compilation attestation','new local implementation and independent review still required']};
if(process.argv.length===2)console.log(JSON.stringify(result,null,2));else{assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--out');fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({ok:true,sourceAnchorAssertions:6,implemented:false}));}
