"use strict";
// 人工截图转录核对；不调用平台、不重新执行本人核验。默认 stdout，--out 排他新建。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const imagePath='C:/Users/30591/Documents/xwechat_files/yufei9_8211/temp/RWTemp/2026-10/9697ae5b74f558019bb3ccfa87f8af97/18e2dba0573ff43ea5bfbcc322ccaf26.jpg';
const prior=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1分层就绪轮执行与关闭结果-20261017.json'),'utf8'));
const plan=JSON.parse(fs.readFileSync(path.join(__dirname,'Codex参与者I1分层就绪轮包准备-20261017.json'),'utf8'));
const observed={checkRoundId:'i1layer-20261017-15ab022372bf',identityConfirmed:true,registrationState:'ABSENT',recordMatched:null,readAttempted:true,userIdTail:'dc619c',serverTimeIso:'2026-10-17T08:32:47.432Z',fullUserIdVisible:false,includeFullUserIdCheckboxChecked:false,errorCodeVisible:false};
assert.equal(observed.checkRoundId,prior.roundId);
assert.ok(Date.parse(observed.serverTimeIso)>Date.parse(prior.candidate.deployedAt));
assert.ok(Date.parse(observed.serverTimeIso)<Date.parse(prior.closed.deployedAt));
assert.equal(prior.closed.matchedFiles,8);
const core=fs.readFileSync(path.join(root,'miniapp/scripts/lib/participant-identity-check.cjs'),'utf8');
assert.ok(core.includes("return { state: 'ABSENT', recordMatched: null }"));
assert.ok(core.includes('response.data === null'));
const result={schema:'codex-i1-layer-phone-result-review/1',reviewedAt:new Date().toISOString(),roundId:prior.roundId,source:{kind:'human-supplied-phone-screenshot-manually-transcribed',fileName:path.basename(imagePath),sha256:crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex'),imageNotCopiedIntoRepository:true,transcriptionIsNotAutomatedOcr:true},observed,checks:6,ok:true,interpretation:{identity:'Trusted application identity confirmed by displayed result, with same-person attendance reported by user; not civil identity certification.',registration:'No record returned for this caller in schtest_v1_users at the displayed time; not evidence of absence from other collections.',recordOwnership:'No existing record to compare; null does not mean mismatch.',compatibility:'This one real phone run reached the read-result path; no claim all platform variants work.',fullUserId:'Not obtained; tail alone cannot authorize registration or role binding.'},closed:prior.closed,boundaries:{newCloudOperations:0,registrationPerformed:false,roleGranted:false,I2Started:false,PStarted:false,platformLogsQueried:false,actualPhoneCallCountIndependentlyMeasured:false},previousEvidencePreserved:true};
const text=JSON.stringify(result,null,2)+'\n';
const args=process.argv.slice(2);if(args.length){assert.equal(args.length,2);assert.equal(args[0],'--out');fs.writeFileSync(args[1],text,{flag:'wx'});}else process.stdout.write(text);
