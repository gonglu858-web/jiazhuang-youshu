// 审查专用：仅合成内存数据与本地源码；不调用网络，不修改产品实现。
// 这些断言记录本次缺陷，不是期望产品长期保持缺陷的回归测试。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const rel = p => path.join(root, p);
const H = require(rel('miniapp/tests/helpers/sandbox-entry-loader.cjs'));
const { PREFIX } = require(rel('miniapp/tests/helpers/sandbox-test-db.cjs'));
const guard = require(rel('miniapp/cloudfunctions/scheduleSandbox/project-guard'));
const clientPath = rel('miniapp/miniprogram/utils/schedule-sandbox-client.js');
const req = createRequire(clientPath);
const originalProof = req('../config/schedule-sandbox-proof');
const results = [];
const clone = x => JSON.parse(JSON.stringify(x));
const cfg = () => H.openConfig({ allowedUserIds: Object.values(H.U) });
const main = (db, config, who = 'owner') => H.loadEntry(db, config, { openid: H.OPENIDS[who] }).main;
const payload = { action: 'createProject', requestId: 'local-create', name: '虚构测试 · 本地复核' };
const count = (db, c) => Object.keys(db.getData()[PREFIX + c]).length;
function storage() {
  const map = new Map();
  return { map, getStorageSync: k => map.get(k), setStorageSync: (k,v) => map.set(k,clone(v)), removeStorageSync: k => map.delete(k) };
}
function stack({ store = storage(), target = 'p_local_a', round = 'local-review', handler = async () => { throw Error('timeout'); } } = {}) {
  const proof = { ...originalProof, enabled: true, roundId: round, sandboxProjectId: target };
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,wx){' + fs.readFileSync(clientPath,'utf8') + '\n})')(
    n => n === '../config/schedule-sandbox-proof' ? proof : req(n), mod, mod.exports, {});
  const client = mod.exports, calls = [];
  const api = { ...store, storage: store,
    getAccountInfoSync: () => ({ miniProgram: { appId: H.APPID, envVersion: 'develop' } }),
    cloud: { async callFunction(args) { calls.push(clone(args.data)); return handler(args.data); } } };
  let def;
  vm.runInThisContext('(function(require,Page,wx){' + fs.readFileSync(rel('miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js'),'utf8') + '\n})')(
    n => n.includes('schedule-sandbox-client') ? client : proof, v => { def = v; }, api);
  const page = { ...def, data: clone(def.data), setData(patch) {
    for (const [k,v] of Object.entries(patch)) {
      const parts = k.split('.'); let o = this.data;
      for (const p of parts.slice(0,-1)) o = o[p];
      o[parts.at(-1)] = v;
    }
  } };
  return { proof, store, client, api, page, calls };
}
async function check(name, fn) {
  const detail = await fn(); results.push({ name, reproduced: true, detail });
  console.log(name + ': reproduced');
}
(async () => {
  await check('01-page-sensitive-reentry-blocked', async () => {
    const s = stack(), secret = 'LOCAL_SYNTHETIC_SECRET';
    await s.client.callSandbox({ action:'approveInvitation', invitationId:'i_local', applicantNumber:secret, requestId:'approval' }, {api:s.api});
    const t = stack({ store:s.store }); t.page.onLoad();
    t.page.inputField({ currentTarget:{dataset:{field:'applicantNumberInput'}}, detail:{value:secret} });
    await t.page.runAction('approveInvitation');
    assert.equal(t.page.data.applicantNumberInput,''); assert.equal(t.calls.length,0);
    assert.ok(!JSON.stringify([...s.store.map]).includes(secret));
    return { inputAccepted:false, requestsAfterReentry:0, error:t.page.data.lastError, rawCredentialStored:false };
  });
  await check('02-page-discard-allows-new-request', async () => {
    const s = stack(); s.page.onLoad();
    await s.page.runAction('createSchedule'); const old = s.page.data.pendingRequestId;
    s.page.discardPending(); await s.page.runAction('createSchedule');
    assert.equal(s.calls.length,2); assert.notEqual(s.calls[1].requestId,old);
    return { requests:2, differentRequestId:true, firstOutcomeStillUnknown:true };
  });
  await check('03-real-main-invitation-commit-response-lost-retry', async () => {
    const db = H.seededDb(), config = cfg();
    const created = await main(db,config)(payload); assert.equal(created.ok,true);
    const num = await main(db,config,'manager')({action:'requestBindingNumber'});
    const assigned = await main(db,config)({action:'assignManager',projectId:created.projectId,bindingNumber:num.bindingNumber});
    assert.equal(assigned.ok,true);
    let n=0;
    const s = stack({target:created.projectId, round:config.roundId, handler:async data => {
      const result = await main(db,config,'manager')(data); assert.equal(result.ok,true);
      if (++n === 1) throw Error('timeout after server commit');
      return {result};
    }});
    const invite = {action:'createInvitation',projectId:created.projectId,requestId:'same-invite',role:'师傅',trades:['拆改']};
    const a = await s.client.callSandbox(invite,{api:s.api});
    const b = await s.client.callSandbox(invite,{api:s.api});
    assert.equal(a.unknown,true); assert.equal(b.ok,true); assert.equal(count(db,'invitations'),2);
    return { sameRequestId:true, invitationsAfterRetry:2, firstUnknown:a.unknown, secondOk:b.ok };
  });
  await check('04-pending-retry-retargeted-by-new-config', async () => {
    const s = stack();
    await s.client.callSandbox({action:'createSchedule',requestId:'old',form:{content:'old payload'}},{api:s.api});
    const t = stack({store:s.store,target:'p_local_b'});
    await t.client.callSandbox({action:'createSchedule',requestId:'old'},{api:t.api});
    assert.equal(t.calls.length,1); assert.equal(t.calls[0].projectId,'p_local_b');
    return { storedProject:s.calls[0].projectId, retriedProject:t.calls[0].projectId, sameRequestId:true };
  });
  await check('05-half-write-cross-pairs-new-id-old-snapshot', async () => {
    const st = storage(); const remove = st.removeStorageSync, set = st.setStorageSync;
    st.removeStorageSync = k => { if(k.includes('snapshot:')) throw Error('snapshot deletion failure'); return remove(k); };
    const s = stack({store:st,handler:async () => ({result:{ok:true}})});
    await s.client.callSandbox({action:'createSchedule',requestId:'first',form:{content:'first payload'}},{api:s.api});
    st.setStorageSync = (k,v) => { if(k.includes('snapshot:')) throw Error('snapshot write failure'); return set(k,v); };
    // 同一对象的方法替换由 api.storage 读取，无源码修改。
    const failed = await s.client.callSandbox({action:'createSchedule',requestId:'second',form:{content:'second payload'}},{api:s.api});
    assert.equal(failed.code,'SANDBOX_STORAGE_UNAVAILABLE');
    const retry = await s.client.callSandbox({action:'createSchedule',requestId:'second',form:{content:'second payload'}},{api:s.api});
    assert.equal(retry.ok,true); assert.equal(s.calls.length,2);
    assert.equal(s.calls[1].requestId,'second'); assert.equal(s.calls[1].form.content,'first payload');
    return { initialSaveRejected:true, retrySentOldPayloadWithNewId:true, requests:2 };
  });
  await check('06-replay-returns-success-for-missing-project', async () => {
    const db=H.seededDb(), config=cfg(), invoke=main(db,config);
    const first=await invoke(payload); await db.collection(PREFIX+'projects').doc(first.projectId).remove();
    const replay=await invoke(payload); assert.equal(replay.ok,true); assert.equal(count(db,'projects'),0);
    return { replay, projects:0, receipts:count(db,'schedule_receipts') };
  });
  await check('07-concurrent-replay-skips-current-primary-permission', async () => {
    const db=H.seededDb(), config=cfg(), original=db.runTransaction; let interposed=false;
    db.runTransaction=async work => {
      if(!interposed) {
        interposed=true;
        const winner=await main(db,config)(payload); assert.equal(winner.ok,true);
        await db.collection(PREFIX+'app_admins').doc('primary').update({data:{userId:H.U.manager}});
      }
      return original(work);
    };
    const loser=await main(db,config)(payload);
    assert.equal(loser.ok,true); assert.equal(loser.replayed,true);
    assert.equal(db.getData()[PREFIX+'app_admins'].primary.userId,H.U.manager);
    return { oldPrimaryReplaySucceeded:true, result:loser, permissionRevokedBeforeReplay:true };
  });
  await check('08-post-commit-read-failure-falsely-claims-rollback', async () => {
    const db=H.seededDb(), config=cfg(), original=db.collection; let failed=false;
    db.collection=name => {
      const c=original(name); if(name!==PREFIX+'schedule_receipts') return c;
      return {...c,doc(key){const d=c.doc(key); return {...d,async get(){
        if(!failed && count(db,'projects')===1) { failed=true; throw Error('POST_COMMIT_READ_FAILED'); }
        return d.get();
      }};}};
    };
    const result=await main(db,config)(payload);
    assert.equal(result.ok,false); assert.match(result.message,/已整体回滚/);
    assert.equal(count(db,'projects'),1); assert.equal(count(db,'schedule_receipts'),1);
    return { result, projects:1, receipts:1, rollbackClaimFalse:true };
  });
  await check('09-db-fixture-uncommitted-receipt-phantom-success', async () => {
    const db=H.seededDb(), config=cfg(), original=db.runTransaction;
    let signal, release; const reached=new Promise(r=>{signal=r;}), resume=new Promise(r=>{release=r;});
    let first=true;
    db.runTransaction=work => original(async tx => {
      const result=await work(tx);
      if(first) { first=false; signal(); await resume; throw Error('FAIL_BEFORE_COMMIT'); }
      return result;
    });
    const firstResult=main(db,config)(payload); await reached;
    const replay=await main(db,config)(payload); assert.equal(replay.ok,true);
    release(); const failed=await firstResult;
    assert.equal(failed.ok,false); assert.equal(count(db,'projects'),0); assert.equal(count(db,'schedule_receipts'),0);
    return { uncommittedReceiptVisible:true, secondReportedSuccess:replay.ok, firstFailed:!failed.ok, finalProjects:0, finalReceipts:0 };
  });
  await check('10-known-conflict-is-treated-as-unknown', async () => {
    // 传输替身提供真实 service 使用的拒绝码；不声称这里运行了施工冲突事务。
    assert.ok(fs.readFileSync(rel('miniapp/cloudfunctions/scheduleSandbox/vendor/schedule-service.js'),'utf8').includes("'SCHEDULE_CONFLICT'"));
    const s=stack({handler:async()=>({result:{ok:false,code:'SCHEDULE_CONFLICT',message:'施工日期冲突'}})});
    const result=await s.client.callSandbox({action:'createSchedule',requestId:'conflict'},{api:s.api});
    assert.equal(result.unknown,true); assert.ok(s.client.readPending(s.store,H.ENV_ID,s.proof.roundId).record);
    return { code:result.code, unknown:result.unknown, pendingRetained:true, transportStubOnly:true };
  });
  const baseline=JSON.parse(fs.readFileSync(rel('docs/证据/施工安排事务兼容V1-V3验收-20261003.json'),'utf8')).currentCodeSha256;
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(rel(file))).digest('hex');
  const changed=Object.entries(baseline).filter(([p,h])=>sha(p)!==h).map(([p])=>p);
  assert.deepEqual(changed,['miniapp/miniprogram/app.json']);
  const request=fs.readFileSync('C:/Users/30591/.codex/attachments/9f206c28-6918-43d0-9c9c-d15c85dac0da/已粘贴的文本.txt','utf8');
  const claimed=[...request.matchAll(/^- (miniapp\/[^\s（]+)(?:（[^）]+）)?\s*([a-f0-9]{64})\s*$/gm)];
  assert.equal(claimed.length,15);
  for(const [,file,hash] of claimed) assert.equal(sha(file),hash,file);
  const old=req('../config/schedule-entry-proof');
  assert.equal(Object.isFrozen(originalProof),true); assert.equal(Object.isFrozen(originalProof.allowedVersions),true);
  assert.equal(Object.isFrozen(old),true); assert.equal(Object.isFrozen(old.allowedProjectIds),true);
  const report={ date:'2026-10-04',scope:'local synthetic reproduction only',results,
    deliveryHashes:claimed.map(([,file,hash])=>({file,sha256:hash,matched:true})),
    baseline:{files:Object.keys(baseline).length,changed},
    entry:{newEnabled:originalProof.enabled,oldEnabled:old.enabled,oldAllowedProjectIds:old.allowedProjectIds},
    cloudOperationsPerformed:false, productFilesModifiedByReviewer:false,
    limitations:['合成数据库替身不是平台事务模型','不输出合成或真实原始绑定编号/邀请码','既有 SDK 离线测试不证明新副本平台兼容']};
  fs.writeFileSync(__filename.replace(/\.cjs$/,'.json'),JSON.stringify(report,null,2)+'\n','utf8');
  console.log('Evidence written; baseline '+Object.keys(baseline).length+' files, only app.json differs.');
})().catch(e=>{console.error(e);process.exitCode=1;});
