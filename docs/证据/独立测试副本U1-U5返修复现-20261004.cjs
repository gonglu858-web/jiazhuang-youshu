// Codex 复核 U1–U5 返修后的定点验证脚本。
//
// 与审查脚本的关系：
// - `独立测试副本T1-T5-Codex复核-20261004.cjs` 断言的是**返修前**的缺陷现象，保留不改写。
// - 本脚本断言**返修后**应有的行为，并**复用**上一轮 WorkBuddy 验证脚本的载入器
//   与合成数据工具（只取 helpers，不执行其取证 IIFE、不触碰其历史输出）。
//
// 范围：仅本地合成内存数据与本地源码；不调用网络、不操作云端、不安装、不取号、
// 不创建资源、不预览、不部署、不发布、不清用户缓存。不输出任何原始编号或邀请码。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const rel = p => path.join(root, p);
const wbScript = rel('docs/证据/独立测试副本T1-T5返修复现-20261004.cjs');
const wbSource = fs.readFileSync(wbScript, 'utf8');
// 只取 helpers 部分（不执行其取证 IIFE）
const helperSource = wbSource.slice(0, wbSource.indexOf('(async () => {'));
const h = vm.runInThisContext(
  '(function(require,__dirname){' + helperSource + '\nreturn {stack,bind,evt,H,PREFIX,cfg,main,count,ENV_ID,ROUND,TRUSTED,makeStorage};})',
  { filename: wbScript }
)(createRequire(wbScript), __dirname);
const { stack, bind, evt, H, PREFIX, cfg, main, count, ENV_ID, ROUND, TRUSTED, makeStorage } = h;

const guard = require(rel('miniapp/cloudfunctions/scheduleSandbox/project-guard'));
const results = [];
async function verify(id, title, fn) {
  const detail = await fn();
  results.push({ id, title, passed: true, detail });
  console.log(`${id} ${title}: PASS`);
}
const business = s => s.calls.filter(c => c.action !== 'identify');
const assert = (cond, message) => { if (!cond) throw new Error(message); };

/** 走完真实 main 准备链，返回可施工的 projectId。 */
async function setup() {
  const db = H.seededDb();
  const config = cfg();
  const created = await main(db, config)({ action: 'createProject', requestId: 'u-create', name: '虚构测试 · U 复核' });
  assert(created.ok === true, '建项目失败：' + JSON.stringify(created));
  const num = await main(db, config, 'manager')({ action: 'requestBindingNumber' });
  assert((await main(db, config)({ action: 'assignManager', projectId: created.projectId, bindingNumber: num.bindingNumber })).ok === true, '指定管家失败');
  const inv = await main(db, config, 'manager')({ action: 'createInvitation', projectId: created.projectId, role: '师傅', trades: ['拆改'] });
  await main(db, config, 'worker')({ action: 'applyInvitation', invitationCode: inv.invitationCode });
  const wn = await main(db, config, 'worker')({ action: 'requestBindingNumber' });
  const approved = await main(db, config, 'manager')({
    action: 'approveInvitation', projectId: created.projectId, invitationId: inv.invitationId, applicantNumber: wn.bindingNumber
  });
  assert(approved.ok === true, '批准失败：' + JSON.stringify(approved));
  return { db, projectId: created.projectId, config: cfg({ phase: 'execute', projectId: created.projectId }) };
}
const FORM = {
  stage: '拆改', trade: '拆改', workerUserId: H.U.worker,
  startDate: '2026-10-08', endDate: '2026-10-09', expectedDate: '2026-10-09',
  restDays: [], content: '本地合成安排'
};

(async () => {
  // ── U1 ────────────────────────────────────────────────────────────────
  await verify('U1-a', '真实 main：已提交响应丢失→转维护→重试被拒仍保留原未决状态', async () => {
    const { db, projectId, config } = await setup();
    const call = data => main(db, config, 'manager')(data);
    let lost = true;
    const s = stack({
      target: projectId, round: config.roundId,
      identifyResult: { ok: true, userId: H.U.manager },
      handler: async data => {
        const result = await call(data);
        if (lost) { lost = false; assert(result.ok === true, '首次提交应成功'); throw Error('timeout after server commit'); }
        return { result };
      }
    });
    await bind(s);
    const first = await s.client.callSandbox(
      { action: 'createSchedule', projectId, requestId: 'u1-req', form: FORM }, { api: s.api });
    assert(first.unknown === true, '首次应留下未决记录');
    const schedulesAfterCommit = count(db, 'schedules');

    // 项目转入维护
    await db.collection(PREFIX + 'projects').doc(projectId).update({ data: { scheduleWriteMode: 'maintenance' } });
    const retry = await s.client.resumePending({ api: s.api });
    assert(retry.code === 'PROJECT_NOT_WRITABLE', '应返回维护拒绝码，实际 ' + retry.code);
    assert(retry.definite !== true, '不得把重试拒绝当作原请求的确定结论');
    assert(retry.unknown === true, '原结果仍未知');
    const pending = s.client.readPending(s.store, ENV_ID, config.roundId);
    assert(pending.record !== null, '原未决记录必须保留');
    assert(pending.record.requestId === 'u1-req', '必须仍是原来那次请求');
    assert(count(db, 'schedules') === schedulesAfterCommit, '原提交仍在库中');
    // 不放开新写
    const before = business(s).length;
    const fresh = await s.client.callSandbox(
      { action: 'listSchedules', projectId, requestId: 'brand-new' }, { api: s.api });
    assert(fresh.code === 'SANDBOX_PENDING_UNRESOLVED', '原记录未结束前不得放开新写');
    assert(business(s).length === before, '不得发出新业务请求');
    // 恢复维护后同号可取回原结果
    await db.collection(PREFIX + 'projects').doc(projectId).update({ data: { scheduleWriteMode: 'ready' } });
    const recovered = await s.client.resumePending({ api: s.api });
    assert(recovered.ok === true, '恢复条件具备后同号应取回原结果：' + JSON.stringify(recovered));
    assert(count(db, 'schedules') === schedulesAfterCommit, '不得重复创建安排');
    return {
      firstUnknown: true, retryCode: retry.code, pendingRetained: true,
      newWriteBlocked: true, recoveredBySameId: true, schedules: count(db, 'schedules')
    };
  });

  await verify('U1-b', '首次确定的业务拒绝仍可修正（U1 不放宽首次请求）', async () => {
    const s = stack({ handler: async () => ({ result: { ok: false, code: 'SCHEDULE_CONFLICT', message: '施工日期冲突' } }) });
    await bind(s);
    const first = await s.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'u1-first', form: { content: 'x' } }, { api: s.api });
    assert(first.definite === true, '首次确定拒绝应可修正');
    assert(s.client.readPending(s.store, ENV_ID, ROUND).record === null, '首次确定拒绝应清理未决记录');
    return { definite: first.definite === true, pendingCleared: true };
  });

  // ── U2 ────────────────────────────────────────────────────────────────
  await verify('U2-a', '传输层返回不同身份时恢复零业务发送，原记录与绑定都不被覆盖', async () => {
    const store = makeStorage();
    const a = stack({ store, identifyResult: { ok: true, userId: 'u_A' } });
    await bind(a);
    await a.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'A-request', form: { content: 'A 载荷' } }, { api: a.api });
    const accountKey = `${require(rel('miniapp/miniprogram/config/schedule-sandbox-proof')).cachePrefix}account:${ENV_ID}:${ROUND}`;
    const envelopeKey = [...store.map.keys()].find(k => k.includes(':envelope:'));
    const before = JSON.stringify(store.map.get(envelopeKey));

    // 另一账号进入同一存储：服务端 identify 返回 u_B
    const b = stack({ store, identifyResult: { ok: true, userId: 'u_B' }, handler: async () => ({ result: { ok: true } }) });
    b.page.onLoad();
    await b.page.retryPending();
    assert(business(b).length === 0, '身份不符时不得发出业务请求，实际 ' + business(b).length);
    assert(b.page.data.lastError.includes('执行人不同'), '应说明身份不符：' + b.page.data.lastError);
    assert(JSON.stringify(store.map.get(envelopeKey)) === before, '原未决记录不得被覆盖');
    assert(store.map.get(accountKey) === 'u_A', '账号绑定不得被另一账号覆盖');
    // 同身份仍可恢复
    const c = stack({ store, identifyResult: { ok: true, userId: 'u_A' }, handler: async () => ({ result: { ok: true } }) });
    const same = await c.client.resumePending({ api: c.api });
    assert(same.ok === true, '同身份应可恢复：' + JSON.stringify(same));
    return {
      identityChangedBusinessSends: business(b).length, pendingPreserved: true,
      bindingPreserved: true, sameIdentityRecovered: true
    };
  });

  await verify('U2-b', '身份请求失败保留原记录；身份刷新独立完成且不覆盖未决记录', async () => {
    const store = makeStorage();
    const a = stack({ store, handler: async () => { throw Error('timeout'); } });
    await bind(a);
    await a.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'u2-req', form: { content: '原内容' } }, { api: a.api });
    const envelopeKey = [...store.map.keys()].find(k => k.includes(':envelope:'));
    const before = JSON.stringify(store.map.get(envelopeKey));

    // 身份请求失败（网络）
    const b = stack({ store, handler: async () => ({ result: { ok: true } }) });
    b.api.cloud.callFunction = async args => { b.calls.push(JSON.parse(JSON.stringify(args.data))); throw Error('network down'); };
    const denied = await b.client.resumePending({ api: b.api });
    assert(denied.code === 'SANDBOX_IDENTITY_UNCONFIRMED', '应报身份未确认：' + denied.code);
    assert(business(b).length === 0, '身份未确认必须零业务发送');
    assert(b.client.readPending(store, ENV_ID, ROUND).record !== null, '原记录必须保留');

    // 身份刷新独立完成：不被旧未决锁死、不覆盖未决记录
    const c = stack({ store, handler: async () => ({ result: { ok: true } }) });
    const identity = await c.client.refreshSessionIdentity(c.api);
    assert(identity.status === 'same', '同身份刷新应返回 same：' + JSON.stringify(identity));
    assert(JSON.stringify(store.map.get(envelopeKey)) === before, '身份刷新不得覆盖未决记录');
    return {
      identityFailureCode: denied.code, businessSends: business(b).length,
      pendingPreserved: true, refreshStatus: identity.status, refreshDidNotTouchPending: true
    };
  });

  await verify('U2-c', 'identify 零写说明已更正为 vendor 实际行为', async () => {
    const clientSrc = fs.readFileSync(rel('miniapp/miniprogram/utils/schedule-sandbox-client.js'), 'utf8');
    assert(!/只读动作：结果未知可安全重发，因为不会产生写入/.test(clientSrc), '不得再声称 identify 零写');
    assert(clientSrc.includes('并非零写'), '必须说明 identify 首次会写 users 与审计');
    const serviceSrc = fs.readFileSync(rel('miniapp/cloudfunctions/scheduleSandbox/vendor/service.js'), 'utf8');
    assert(/add\('users'/.test(serviceSrc), 'vendor identity 确实会写 users');
    assert(serviceSrc.includes('registerIdentity'), 'vendor identity 确实会写注册审计');
    return { claimCorrected: true, vendorWritesUsers: true, vendorWritesAudit: true };
  });

  // ── U3 ────────────────────────────────────────────────────────────────
  await verify('U3-a', '当前登记目标为空时恢复零请求；同目标恢复正常', async () => {
    const store = makeStorage();
    const a = stack({ store, handler: async () => { throw Error('timeout'); } });
    await bind(a);
    await a.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'u3-target', form: { content: '原内容' } }, { api: a.api });
    const cleared = stack({ store, target: '', handler: async () => ({ result: { ok: true } }) });
    const stopped = await cleared.client.resumePending({ api: cleared.api });
    assert(stopped.code === 'SANDBOX_PROJECT_REQUIRED', '目标清空应停止：' + stopped.code);
    assert(cleared.calls.length === 0, '目标校验是纯本地判定，必须零请求（实际 ' + cleared.calls.length + '）');
    const restored = stack({ store, target: 'p_sbx_target', handler: async () => ({ result: { ok: true } }) });
    const ok = await restored.client.resumePending({ api: restored.api });
    assert(ok.ok === true, '同目标应可恢复');
    assert(business(restored)[0].projectId === 'p_sbx_target', '必须发往原目标');
    return { clearedTargetCode: stopped.code, requestsWhenCleared: cleared.calls.length, restoredOk: true };
  });

  await verify('U3-b', 'envelope 顶层与快照/存储键不一致一律停止且不修补', async () => {
    const mutations = ['action', 'projectId', 'accountId'];
    const codes = {};
    for (const field of mutations) {
      const store = makeStorage();
      const s = stack({ store, handler: async () => { throw Error('timeout'); } });
      await bind(s);
      await s.client.callSandbox(
        { action: 'createSchedule', projectId: 'p_sbx_target', requestId: `u3-${field}`, form: { content: 'x' } }, { api: s.api });
      const key = [...store.map.keys()].find(k => k.includes(':envelope:'));
      const stored = store.map.get(key);
      const tampered = field === 'action' ? { ...stored, action: 'cancelSchedule' }
        : field === 'projectId' ? { ...stored, projectId: 'p_sbx_another' }
          : { ...stored, accountId: 'u_someone_else' };
      store.map.set(key, tampered);
      const before = business(s).length;
      const resumed = await s.client.resumePending({ api: s.api });
      assert(resumed.ok === false, field + ' 不一致时不得恢复');
      assert(business(s).length === before, field + ' 不一致时零业务发送');
      // 不得被静默改写
      const raw = store.map.get(key);
      assert(raw[field] === tampered[field], field + ' 不得被静默改写');
      assert(JSON.stringify(raw.snapshot) === JSON.stringify(stored.snapshot), '快照不得被改写');
      codes[field] = resumed.code;
    }
    return { mutations: mutations.length, codes, patchedSilently: false };
  });

  await verify('U3-c', '无项目动作不把当前目标补进原本无目标的提交', async () => {
    const store = makeStorage();
    const a = stack({ store, handler: async () => { throw Error('timeout'); } });
    await bind(a);
    await a.client.callSandbox({ action: 'listMyProjects', requestId: 'u3-np' }, { api: a.api });
    const b = stack({ store, target: 'p_sbx_target', handler: async () => ({ result: { ok: true, projects: [] } }) });
    const resumed = await b.client.resumePending({ api: b.api });
    assert(resumed.ok === true, '无项目动作应可恢复：' + JSON.stringify(resumed));
    const sent = business(b);
    assert(sent.length === 1 && sent[0].action === 'listMyProjects', '必须按原动作恢复');
    assert(sent[0].projectId === undefined, '无项目动作不得被补进当前目标');
    return { action: sent[0].action, projectIdInjected: false };
  });

  // ── U4 ────────────────────────────────────────────────────────────────
  await verify('U4-a', '提交确认响应丢失：不得断言未提交，同号取回已提交结果且不重建', async () => {
    const db = H.seededDb(), config = cfg();
    const original = db.runTransaction;
    let once = true;
    // 真实创建事务已提交，随后 SDK 替身抛响应丢失（仅模拟该故障边界）
    db.runTransaction = async work => {
      const out = await original(work);
      if (once) { once = false; throw Error('SDK_RESPONSE_LOST_AFTER_COMMIT'); }
      return out;
    };
    const payload = { action: 'createProject', requestId: 'u4-ack', name: '虚构测试 · 提交响应丢失' };
    const failed = await main(db, config)(payload);
    assert(failed.ok !== true, '响应丢失时不得报成功');
    assert(!/事务未提交/.test(failed.message), '不得断言事务未提交：' + failed.message);
    assert(!/已整体回滚/.test(failed.message), '不得断言已整体回滚：' + failed.message);
    assert(/未确认|待核对|按同一请求编号重试/.test(failed.message), '必须按结果未确认表述：' + failed.message);
    const committed = { projects: count(db, 'projects'), receipts: count(db, 'schedule_receipts') };
    assert(committed.projects === 1 && committed.receipts === 1, '实际已提交');
    const retry = await main(db, config)(payload);
    assert(retry.ok === true && retry.replayed === true, '同号重试应取回原结果：' + JSON.stringify(retry));
    assert(count(db, 'projects') === 1 && count(db, 'schedule_receipts') === 1, '不得重复落库');
    return {
      result: failed, committedProjects: committed.projects, committedReceipts: committed.receipts,
      rollbackClaim: false, uncommittedClaim: false, replayRecovered: true,
      simulation: 'SDK 提交成功后响应失败，不声称平台实测'
    };
  });

  await verify('U4-b', '三种情形分别说明事实（提交后读失败 / 响应丢失 / 事务内失败）', async () => {
    const messages = {};
    {
      const db = H.seededDb();
      db.failNextRead(PREFIX + 'schedule_receipts', 'doc.get', 'POST_COMMIT_READ_FAILED',
        () => count(db, 'projects') === 1);
      messages.postCommitRead = (await main(db, cfg())({ action: 'createProject', requestId: 'u4-a', name: '虚构测试 · 提交后读失败' })).message;
    }
    {
      const db = H.seededDb(), original = db.runTransaction;
      let once = true;
      db.runTransaction = async work => { const out = await original(work); if (once) { once = false; throw Error('SDK_RESPONSE_LOST_AFTER_COMMIT'); } return out; };
      messages.ackLost = (await main(db, cfg())({ action: 'createProject', requestId: 'u4-b', name: '虚构测试 · 响应丢失' })).message;
    }
    {
      const db = H.seededDb();
      db.failNextWrite(PREFIX + 'projects', 'add', 'INJECTED_PROJECT_WRITE_FAILURE');
      messages.txFailed = (await main(db, cfg())({ action: 'createProject', requestId: 'u4-c', name: '虚构测试 · 事务内失败' })).message;
    }
    for (const [label, message] of Object.entries(messages)) {
      assert(typeof message === 'string' && message, label + ' 必须有说明');
      assert(!/事务未提交/.test(message), label + ' 不得断言未提交');
      assert(!/已整体回滚/.test(message), label + ' 不得断言已整体回滚');
    }
    assert(/已收到事务成功返回/.test(messages.postCommitRead), '提交后读失败必须说明已收到成功返回');
    assert(/未收到事务成功返回/.test(messages.ackLost), '响应丢失必须说明未收到成功返回');
    assert(new Set(Object.values(messages)).size === 3, '三种情形应分别说明各自的事实');
    return { distinctMessages: true, postCommitRead: messages.postCommitRead, ackLost: messages.ackLost };
  });

  // ── U5 ────────────────────────────────────────────────────────────────
  await verify('U5-a', '确认后修改相关日期必须重新确认（真实 Page 事件）', async () => {
    const s = stack({ handler: async () => ({ result: { ok: true } }) });
    await bind(s);
    s.page.onLoad();
    s.page.inputForm(evt('endDate', '2026-10-09'));
    s.page.inputForm(evt('expectedDate', '2026-10-10'));
    s.page.toggleDateConfirm({ detail: { value: true } });
    assert(s.page.data.dateConfirmed === true, '确认应生效');
    assert(s.page.data.dateConfirmedFor === '2026-10-09|2026-10-10', '确认必须绑定日期组合');
    // 改预计日 → 旧确认失效
    s.page.inputForm(evt('expectedDate', '2026-10-15'));
    assert(s.page.data.dateConfirmed === false, '相关日期变化后必须清除旧确认');
    const before = business(s).length;
    await s.page.runAction('createSchedule');
    assert(business(s).length === before, '未重新确认不得发送');
    assert(/重新勾选显式确认/.test(s.page.data.lastError), '应提示重新确认：' + s.page.data.lastError);
    // 重新确认后可发送，且发的是新日期
    s.page.toggleDateConfirm({ detail: { value: true } });
    await s.page.runAction('createSchedule');
    const sent = business(s);
    assert(sent.length === before + 1, '重新确认后应发送一次');
    assert(sent[sent.length - 1].expectedConfirmed === true, '确认后应发送 expectedConfirmed=true');
    assert(sent[sent.length - 1].form.expectedDate === '2026-10-15', '必须发新日期');
    return {
      confirmedFor: '2026-10-09|2026-10-10', confirmationResetOnChange: true,
      requestsWithoutReconfirm: 0, submittedDate: sent[sent.length - 1].form.expectedDate
    };
  });

  await verify('U5-b', '重进/切动作不沿用旧确认；日期一致不额外阻断；控件事件契约一致', async () => {
    const store = makeStorage();
    const a = stack({ store, handler: async () => ({ result: { ok: true } }) });
    await bind(a);
    a.page.onLoad();
    a.page.inputForm(evt('endDate', '2026-10-09'));
    a.page.inputForm(evt('expectedDate', '2026-10-10'));
    a.page.toggleDateConfirm({ detail: { value: true } });
    a.page.changeAction({ detail: { value: 0 } });
    const afterSwitch = a.page.data.dateConfirmed;
    a.page.toggleDateConfirm({ detail: { value: true } });
    const b = stack({ store, handler: async () => ({ result: { ok: true } }) });
    b.page.onLoad();
    const afterReentry = b.page.data.dateConfirmed;
    // 非布尔事件值按未确认处理
    b.page.inputForm(evt('endDate', '2026-10-09'));
    b.page.inputForm(evt('expectedDate', '2026-10-10'));
    b.page.toggleDateConfirm({ detail: { value: 'true' } });
    const afterString = b.page.data.dateConfirmed;
    // 日期一致不额外阻断
    const c = stack({ handler: async () => ({ result: { ok: true } }) });
    await bind(c);
    c.page.onLoad();
    c.page.inputForm(evt('endDate', '2026-10-10'));
    c.page.inputForm(evt('expectedDate', '2026-10-10'));
    const before = business(c).length;
    await c.page.runAction('createSchedule');
    const consistentSends = business(c).length - before;
    // 模板契约
    const wxml = fs.readFileSync(rel('miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.wxml'), 'utf8');
    const checkboxBindchange = /<checkbox[^>]*bindchange="toggleDateConfirm"/.test(wxml);
    const notTap = !/bindtap="toggleDateConfirm"/.test(wxml);
    const dateInputs = ['endDate', 'expectedDate'].every(f => wxml.includes(`data-field="${f}" bindinput="inputForm"`));
    assert(afterSwitch === false, '切动作必须清除确认');
    assert(afterReentry === false, '重进不得沿用旧确认');
    assert(afterString === false, '非布尔值不得当作已确认');
    assert(consistentSends === 1, '日期一致不应额外阻断');
    assert(checkboxBindchange && notTap && dateInputs, '模板事件契约不符');
    return {
      clearedOnActionSwitch: afterSwitch === false, clearedOnReentry: afterReentry === false,
      nonBooleanRejected: afterString === false, sendsWhenDatesMatch: consistentSends,
      templateUsesCheckboxBindchange: checkboxBindchange, templateNotTap: notTap
    };
  });

  // ── 基线与入口 ────────────────────────────────────────────────────────
  const baseline = JSON.parse(fs.readFileSync(rel('docs/证据/施工安排事务兼容V1-V3验收-20261003.json'), 'utf8')).currentCodeSha256;
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(rel(file))).digest('hex');
  const changed = Object.entries(baseline).filter(([p, hash]) => sha(p) !== hash).map(([p]) => p);
  const oldProof = require(rel('miniapp/miniprogram/config/schedule-entry-proof'));
  const newProof = require(rel('miniapp/miniprogram/config/schedule-sandbox-proof'));
  const entry = {
    newEnabled: newProof.enabled,
    newSandboxProjectId: newProof.sandboxProjectId,
    newRoundId: newProof.roundId,
    oldEnabled: oldProof.enabled,
    oldAllowedProjectIds: oldProof.allowedProjectIds,
    proofsFrozen: Object.isFrozen(newProof) && Object.isFrozen(oldProof)
  };
  // 历史证据未被改写
  const historyIntact = [
    'docs/证据/独立测试副本S1-S6-Codex复核-20261004.cjs',
    'docs/证据/独立测试副本S1-S6-Codex复核-20261004.json',
    'docs/证据/独立测试副本T1-T5-Codex复核-20261004.cjs',
    'docs/证据/独立测试副本T1-T5-Codex复核-20261004.json',
    'docs/证据/独立测试副本T1-T5-Codex复核-20261004-WorkBuddy复跑.json',
    'docs/证据/独立测试副本T1-T5返修复现-20261004.cjs'
  ].every(f => fs.existsSync(rel(f)));

  const report = {
    date: '2026-10-04',
    scope: 'local synthetic verification of U1-U5 fixes; no network, no cloud, no install',
    companionHistoricalEvidence: [
      'docs/证据/独立测试副本T1-T5-Codex复核-20261004.cjs（断言返修前缺陷，保留不改写）',
      'docs/证据/独立测试副本T1-T5返修复现-20261004.cjs（T1–T5 验证，本轮未改写其源码）'
    ],
    results,
    baseline: { files: Object.keys(baseline).length, changed },
    entry,
    historicalEvidencePresent: historyIntact,
    cloudOperationsPerformed: false,
    resourcesCreated: false,
    installed: false,
    deployed: false,
    userCacheCleared: false,
    limitations: [
      '合成数据库替身不是平台事务模型：U1 的服务端拒绝顺序、U4 的提交响应丢失均为本地模拟',
      'U2 只在内存中模拟共享存储与账号变化，不声称实测微信跨账号缓存行为；本副本仍只做本地模拟',
      '未取得 wx-server-sdk 实际路径，原 SDK 离线用例本轮仍为跳过（未安装、未伪造通过）',
      '页面仅结构解析与真实 Page 事件验证，未在微信开发者工具或真机编译运行（本机无 wcc/wcsc）',
      '真实 SDK 请求形状、3 秒超时、100 操作、32 KiB 限制未实测',
      '11 个带前缀集合与索引尚未创建；新副本仍只是部署候选',
      '费用未核实，不承诺 0 元'
    ]
  };
  fs.writeFileSync(__filename.replace(/\.cjs$/, '.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n证据已写入：${path.basename(__filename).replace(/\.cjs$/, '.json')}`);
  console.log(`通过 ${results.length}/${results.length} 条；基线 ${Object.keys(baseline).length} 文件，仅 ${changed.join(',') || '（无）'} 变化。`);
})().catch(error => { console.error(error); process.exitCode = 1; });
