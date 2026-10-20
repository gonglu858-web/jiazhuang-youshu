'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),base='Codex参与者I1编号补交轮',sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hits=[];let phase='setup';const guard=require('../../miniapp/tests/helpers/pic-guard-runner.cjs').installParentGuards({hits,getPhase:()=>phase,allowedScripts:[]});
try{
 phase='probe';assert.throws(()=>require('https').request('https://example.invalid'),/OFFLINE_GUARD/);assert.throws(()=>require('child_process').spawn('node',[]),/OFFLINE_GUARD/);phase='business';
 const prep=JSON.parse(fs.readFileSync(path.join(__dirname,base+'包准备-20261020.json'))),frozen=JSON.parse(fs.readFileSync(path.join(__dirname,base+'执行脚本冻结-20261020.json')));
 assert.equal(prep.plan.checkRoundId,'i1handoff-20261020-863ca4553633');assert.equal(prep.plan.participantCode,'1');assert.equal(prep.plan.synthetic,false);
 assert.equal(prep.plan.keyDiagnostic,false);assert.equal(prep.plan.requestProtocol,'participant-identity-request/1');
 assert.equal(sha(fs.readFileSync(prep.planPath)),prep.planSha256);assert.equal(sha(fs.readFileSync(path.join(prep.packageDir,'manifest.json'))),prep.manifestSha256);
 assert.equal(frozen.roundId,prep.plan.checkRoundId);assert.equal(frozen.planSha256,prep.planSha256);assert.equal(frozen.manifestSha256,prep.manifestSha256);
 for(const f of prep.files){const p=path.join(prep.packageDir,f.rel);assert(fs.lstatSync(p).isFile());const b=fs.readFileSync(p);assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
 assert.equal(prep.files.length,39);assert.equal(new Set(prep.files.map(f=>f.rel)).size,39);
 for(const cfg of Object.values(prep.configs))assert.equal(sha(fs.readFileSync(cfg.path)),cfg.sha256);
 for(const f of frozen.scripts)assert.equal(sha(fs.readFileSync(path.join(__dirname,f.name))),f.sha256);
 const deploy=fs.readFileSync(path.join(__dirname,base+'部署关闭-20261020.cjs'),'utf8');new vm.Script(deploy);
 const phoneGate=deploy.match(/function assertMobilePreview\(observation, prep\) \{[\s\S]*?\n\}/);
 assert(phoneGate);assert(deploy.includes("if(mode==='candidate') assertMobilePreview(observation,prep);"));
 const sandbox={assert};vm.runInNewContext(phoneGate[0]+';globalThis.gate=assertMobilePreview;',sandbox);
 const validPhone={mobilePreviewConfirmed:true,mobilePreviewBuildId:prep.preview.previewBuildId,mobileConfiguredRound:prep.plan.checkRoundId,participantCode:'1'};
 sandbox.gate(validPhone,prep);
 for(const patch of [{mobilePreviewConfirmed:false},{mobilePreviewBuildId:'0'.repeat(64)},{mobileConfiguredRound:'synthetic-other-round'},{participantCode:'2'}])assert.throws(()=>sandbox.gate({...validPhone,...patch},prep));
 const localCfgModule={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(prep.packageDir,'frontend/config/cloud.js'),'utf8'),{module:localCfgModule});
 assert.equal(localCfgModule.exports.previewBuildId,prep.preview.previewBuildId);
 assert.equal(localCfgModule.exports.checkRoundId,prep.plan.checkRoundId);
 assert(deploy.includes(prep.plan.checkRoundId)&&deploy.includes(prep.planSha256)&&deploy.includes(prep.manifestSha256));
 assert(deploy.includes("if(mode==='candidate'){assert(tool.checkDir(prep.packageDir).ok);assert(Date.parse(prep.plan.windowExpiresAtIso)-Date.now()>15*60000);}"));
 assert(!fs.existsSync(path.join(__dirname,base+'批准-20261020.json')));assert(!fs.existsSync(path.join(__dirname,base+'手动预览-20261020.json')));
 assert(!fs.existsSync(path.join(__dirname,base+'部署关闭-20261020.candidate.json')));assert(!fs.existsSync(path.join(__dirname,base+'部署关闭-20261020.closed.json')));
 assert.equal(sha(fs.readFileSync(path.join(root,'miniapp/scripts/package-participant-identity-check.cjs'))),'695e0d0c8bee68b5379470ffca85d2492c3102ae1974b5510e1f0c1bce8b04e6');
 const tool=require('../../miniapp/scripts/package-participant-identity-check.cjs');process.env.PIC_CLOSE_SOURCE_DIR=prep.plan.closeSourceDir;
 const prepared=tool.checkPreparedDir(prep.packageDir);assert(prepared.ok);assert.equal(prepared.executionReady,false);
 const strict=tool.checkDir(prep.packageDir);assert(!strict.ok&&JSON.stringify(strict).includes('PIC_WINDOW_NOT_OPEN'));
 const close=tool.checkCloseDir(prep.packageDir);assert(close.ok);assert.equal(close.files,23);
 assert.equal(hits.filter(x=>x.phase==='probe').length,2);assert.equal(hits.filter(x=>x.phase!=='probe').length,0);
 const result={schema:'codex-i1-local-preflight/1',reviewedCommit:'1923158',observedAt:new Date().toISOString(),roundId:prep.plan.checkRoundId,ok:true,preparationValidated:true,executionReady:false,strictBeforeWindowRejected:true,packageFiles:39,candidateServerFiles:prep.files.filter(f=>f.rel.startsWith('server/')).length,closeFiles:close.files,closedServerFiles:prep.files.filter(f=>f.rel.startsWith('close/server/')).length,allFileHashesMatched:true,scriptsMatched:true,scriptSyntaxChecked:'Node vm.Script only; no execution of cloud entry',approvalPresent:false,previewPerformed:false,remoteQueried:false,remoteExecuted:false,guard:{probes:2,unexpected:0},scriptSha256:sha(fs.readFileSync(__filename))};
 result.mobilePreviewGate={source:'extracted exact function from frozen deployment script; VM synthetic records',validAccepted:true,negativeCases:4,candidateOnly:true,configMatchesManifest:true,actualPhoneObserved:false};
 if(process.argv.length===2)console.log(JSON.stringify(result,null,2));else {assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--out');fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({ok:true,roundId:result.roundId,output:process.argv[3]}));}
}finally{guard.restoreAll();}
