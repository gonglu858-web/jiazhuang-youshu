// 仅本地审查：保留历史证据；加载真实源码并注入合成数据库/传输。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const rel = p => path.join(root, p);
const wb = rel('docs/证据/独立测试副本U1-U5返修复现-20261004.cjs');
const source = fs.readFileSync(wb, 'utf8');
const prefix = source.slice(0, source.indexOf('\n(async () => {'));
const h = vm.runInThisContext('(function(require,__dirname){' + prefix +
  '\nreturn {stack,bind,evt,H,PREFIX,cfg,main,count,setup,FORM,ENV_ID};})', {filename: wb})(createRequire(wb), __dirname);
const {stack,bind,evt,H,PREFIX,main,count,setup,FORM,ENV_ID} = h;
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const results = [];
async function record(id, fn) { results.push({id, ...await fn()}); console.log(id + ': verified'); }
const historic = [wb, wb.replace('.cjs','.json'),
  ...['T1-T5返修复现','T1-T5-Codex复核','S1-S6-Codex复核'].flatMap(n =>
    ['cjs','json'].map(e => rel('docs/证据/独立测试副本' + n + '-20261004.' + e)))];
const historicBefore = Object.fromEntries(historic.map(p => [path.relative(root,p), sha(p)]));
(async () => {
  await record('U1-actual-main-denial-retains-and-replays', async () => {
    const cases = [];
    for (const kind of ['maintenance','membership-left','identity-disabled']) {
      const {db,projectId,config} = await setup();
      const s = stack({target:projectId,round:config.roundId}); let drop = true;
      s.api.cloud.callFunction = async args => {
        s.calls.push(args.data);
        const result = await main(db,config,'manager')(args.data);
        if (args.data.action === 'createSchedule' && drop) { drop=false; assert.equal(result.ok,true); throw Error('timeout after commit'); }
        return {result};
      };
      await bind(s);
      assert.equal((await s.client.callSandbox({action:'createSchedule',requestId:'review-'+kind,form:FORM},{api:s.api})).unknown,true);
      const before = s.client.readPending(s.store,ENV_ID,config.roundId).envelope;
      const memberId = H.memberId(projectId,H.U.manager);
      const target = kind === 'maintenance' ? ['projects',projectId,{scheduleWriteMode:'maintenance'},{scheduleWriteMode:'ready'}]
        : kind === 'membership-left' ? ['project_members',memberId,{status:'left'},{status:'active'}]
        : ['users',H.U.manager,{status:'disabled'},{status:'active'}];
      await db.collection(PREFIX+target[0]).doc(target[1]).update({data:target[2]});
      const denied = await s.client.resumePending({api:s.api});
      assert.equal(denied.ok,false);
      assert.deepEqual(s.client.readPending(s.store,ENV_ID,config.roundId).envelope,before);
      assert.equal((await s.client.callSandbox({action:'createSchedule',requestId:'new',form:FORM},{api:s.api})).code,'SANDBOX_PENDING_UNRESOLVED');
      assert.equal(count(db,'schedules'),1);
      await db.collection(PREFIX+target[0]).doc(target[1]).update({data:target[3]});
      assert.equal((await s.client.resumePending({api:s.api})).ok,true);
      assert.equal(count(db,'schedules'),1);
      cases.push({kind,retryCode:denied.code,pendingPreserved:true,schedules:1,replaySucceeded:true});
    }
    return {passed:true,cases};
  });
  await record('U2-current-session-changed-denies', async () => {
    const a=stack({identifyResult:{ok:true,userId:'u_A'}}); await bind(a);
    await a.client.callSandbox({action:'createSchedule',requestId:'A-request',form:FORM},{api:a.api});
    const before=JSON.stringify([...a.store.map]);
    const b=stack({store:a.store,identifyResult:{ok:true,userId:'u_B'}});
    b.page.onLoad(); await b.page.retryPending();
    assert.deepEqual(b.calls.map(x=>x.action),['identify']);
    assert.equal(JSON.stringify([...a.store.map]),before);
    return {passed:true,actions:['identify'],storedStateUnchanged:true,scope:'shared-storage simulation, not a WeChat account-switch experiment'};
  });
  await record('U3-cleared-target-blocked', async () => {
    const a=stack();await bind(a);
    await a.client.callSandbox({action:'createSchedule',requestId:'p',form:FORM},{api:a.api});
    const b=stack({store:a.store,target:''});
    assert.equal((await b.client.resumePending({api:b.api})).code,'SANDBOX_PROJECT_REQUIRED');
    assert.equal(b.calls.length,0);
    return {passed:true,zeroRequests:true};
  });
  await record('U3-regression-page-generates-unresumable-optional-project-envelope', async () => {
    const s=stack();await bind(s);s.page.onLoad();
    await s.page.runAction('listMyProjects');
    assert.equal(s.calls[0].action,'listMyProjects');
    assert.equal(s.calls[0].projectId,'p_sbx_target');
    const pending=s.client.readPending(s.store,ENV_ID,s.proof.roundId);
    assert.equal(pending.available,false);
    const before=s.calls.length;
    const retry=await s.client.resumePending({api:s.api});
    assert.equal(retry.code,'SANDBOX_STORAGE_UNAVAILABLE');
    assert.equal(s.calls.length,before);
    return {reproduced:true,classification:'introduced regression within U3',action:s.calls[0].action,
      projectId:s.calls[0].projectId,reason:pending.reason,retryCode:retry.code,
      implication:'Page builds target for every action; validateEnvelope rejects target on PROJECT_OPTIONAL actions'};
  });
  await record('U5-date-change-invalidates-confirmation', async () => {
    const s=stack();await bind(s);s.page.onLoad();
    s.page.inputForm(evt('endDate','2026-10-09'));s.page.inputForm(evt('expectedDate','2026-10-10'));
    s.page.toggleDateConfirm({detail:{value:true}});
    s.page.inputForm(evt('expectedDate','2026-10-15'));
    assert.equal(s.page.data.dateConfirmed,false);
    return {passed:true,limitation:'boolean handler injection verifies state logic only, not native checkbox event'};
  });
  await record('U5-checkbox-contract-still-incorrect', async () => {
    const s=stack();await bind(s);s.page.onLoad();
    s.page.inputForm(evt('endDate','2026-10-09'));s.page.inputForm(evt('expectedDate','2026-10-10'));
    s.page.toggleDateConfirm({detail:{value:['date-confirm']}});
    assert.equal(s.page.data.dateConfirmed,false);
    await s.page.runAction('createSchedule');assert.equal(s.calls.length,0);
    const wxml=fs.readFileSync(rel('miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.wxml'),'utf8');
    assert.match(wxml,/<checkbox\s[^>]*bindchange="toggleDateConfirm"/);
    assert.doesNotMatch(wxml,/<checkbox-group\b/);
    return {reproduced:true,classification:'U5 existing acceptance requirement unfinished',
      nativeContract:'checkbox-group change detail.value is string[]; boolean belongs to switch change',
      officialTypes:'https://raw.githubusercontent.com/wechat-miniprogram/api-typings/master/types/wx/lib.wx.event.d.ts',
      officialExample:'https://raw.githubusercontent.com/wechat-miniprogram/miniprogram-demo/master/miniprogram/packageComponent/pages/form/checkbox/checkbox.wxml',
      limitation:'source + official contract + handler injection, no simulator click or phone test'};
  });
  // Full WorkBuddy rerun: redirect only output file in memory, never overwrite historical evidence.
  const replayPath=__filename.replace('.cjs','-WorkBuddy复跑.json');
  const adapted=source.replace("fs.writeFileSync(__filename.replace(/\\.cjs$/, '.json'),",'fs.writeFileSync('+JSON.stringify(replayPath)+',');
  assert.notEqual(adapted,source);
  const sourceAwaitable=adapted.replace('\n(async () => {','\nreturn (async () => {');
  await vm.runInThisContext('(function(require,__dirname,__filename){'+sourceAwaitable+'\n})',{filename:wb})(createRequire(wb),__dirname,wb);
  assert.equal(process.exitCode,undefined);
  const replay=JSON.parse(fs.readFileSync(replayPath,'utf8'));
  assert.equal(replay.results.length,12);
  const historicAfter=Object.fromEntries(historic.map(p=>[path.relative(root,p),sha(p)]));
  assert.deepEqual(historicAfter,historicBefore);
  const report={date:'2026-10-04',scope:'local-only',results,workBuddyRerunCount:12,historicalHashes:historicAfter,
    summary:'U1/U2/U4 closed locally; U3 regression and U5 native event contract remain; T5 stays closed',
    officialEvidenceNote:'Official component site unavailable; used official WeChat GitHub event typings and native checkbox example. No third-party claim used as authority.',
    limits:['No cloud, resource, deploy, preview or phone operations','Memory DB is not platform evidence']};
  fs.writeFileSync(__filename.replace('.cjs','.json'),JSON.stringify(report,null,2)+'\n','utf8');
})().catch(e=>{console.error(e);process.exitCode=1;});
