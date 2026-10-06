// Codex 复核 T1–T5 返修后的定点验证脚本。
//
// 与审查脚本 `独立测试副本S1-S6-Codex复核-20261004.cjs` 的关系：
// 那份脚本断言的是**返修前**的缺陷现象，本脚本断言**返修后**应有的行为。
// 两份脚本与结果均保留，互不改写。
//
// 范围：仅本地合成内存数据与本地源码；不调用网络、不操作云端、
// 不安装、不取号、不创建资源、不预览、不部署、不发布、不清用户缓存。
// 不输出任何合成或真实原始绑定编号/邀请码。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const rel = p => path.join(root, p);
const H = require(rel('miniapp/tests/helpers/sandbox-entry-loader.cjs'));
const { PREFIX } = require(rel('miniapp/tests/helpers/sandbox-test-db.cjs'));

const clientPath = rel('miniapp/miniprogram/utils/schedule-sandbox-client.js');
const pagePath = rel('miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js');
const req = createRequire(clientPath);
const originalProof = req('../config/schedule-sandbox-proof');
const clone = x => JSON.parse(JSON.stringify(x));
const ENV_ID = H.ENV_ID;
const ROUND = 't1-t5-verify';
const TRUSTED = 'u_trusted_for_t1_t5_verify';

const results = [];
async function verify(id, title, fn) {
  const detail = await fn();
  results.push({ id, title, passed: true, detail });
  console.log(`${id} ${title}: PASS`);
}

const cfg = (over = {}) => H.openConfig({ allowedUserIds: Object.values(H.U), ...over });
const main = (db, config, who = 'owner') => H.loadEntry(db, config, { openid: H.OPENIDS[who] }).main;
const count = (db, c) => Object.keys(db.getData()[PREFIX + c] || {}).length;

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const s = {
    map,
    failRead: false, failWrite: false, failRemove: false,
    getStorageSync(k) { if (s.failRead) throw new Error('READ_FAILED'); return map.get(k); },
    setStorageSync(k, v) { if (s.failWrite) throw new Error('WRITE_FAILED'); map.set(k, clone(v)); },
    removeStorageSync(k) { if (s.failRemove) throw new Error('REMOVE_FAILED'); map.delete(k); }
  };
  return s;
}

/** 载入实际客户端与实际 Page（setData 支持点分路径）。 */
function stack(options = {}) {
  const {
    store = makeStorage(), target = 'p_sbx_target', round = ROUND, envVersion = 'develop',
    handler = async () => { throw new Error('timeout'); },
    identifyResult = { ok: true, sandbox: true, userId: TRUSTED }
  } = options;
  const proof = { ...originalProof, enabled: true, roundId: round, sandboxProjectId: target };
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,wx){' + fs.readFileSync(clientPath, 'utf8') + '\n})')(
    n => (n === '../config/schedule-sandbox-proof' ? proof : req(n)), mod, mod.exports, {});
  const client = mod.exports;
  const calls = [];
  const api = {
    ...store, storage: store,
    getAccountInfoSync: () => ({ miniProgram: { appId: H.APPID, envVersion } }),
    cloud: {
      async callFunction(a) {
        calls.push(clone(a.data));
        if (a.data && a.data.action === 'identify') return { result: clone(identifyResult) };
        return handler(a.data, calls.length);
      }
    }
  };
  let def;
  vm.runInThisContext('(function(require,Page,wx){' + fs.readFileSync(pagePath, 'utf8') + '\n})')(
    n => {
      if (n.includes('schedule-sandbox-client')) return client;
      if (n.includes('config/schedule-sandbox-proof')) return proof;
      return req(n);
    },
    v => { def = v; }, api);
  const page = {
    ...def, data: clone(def.data),
    setData(patch) {
      for (const [k, v] of Object.entries(patch)) {
        const parts = k.split('.'); let o = this.data;
        for (const p of parts.slice(0, -1)) {
          if (o[p] === undefined || o[p] === null) o[p] = {};
          o = o[p];
        }
        o[parts[parts.length - 1]] = v;
      }
    }
  };
  return { proof, store, client, api, page, calls };
}

async function bind(s) {
  const r = await s.client.callSandbox({ action: 'identify', requestId: 'bind-verify' }, { api: s.api });
  if (r.ok !== true) throw new Error('身份登记失败：' + JSON.stringify(r));
  s.calls.length = 0;
}

const evt = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });

(async () => {
  // ── T1 ────────────────────────────────────────────────────────────────
  await verify('T1-a', '无幂等保障的邀请：提交成功→响应丢失后同号重试不产生第二份', async () => {
    const db = H.seededDb(), config = cfg();
    const created = await main(db, config)({ action: 'createProject', requestId: 'rc', name: '虚构测试 · T1' });
    const num = await main(db, config, 'manager')({ action: 'requestBindingNumber' });
    const assigned = await main(db, config)({ action: 'assignManager', projectId: created.projectId, bindingNumber: num.bindingNumber });
    if (assigned.ok !== true) throw new Error('准备链失败：' + JSON.stringify(assigned));
    let n = 0;
    const s = stack({
      target: created.projectId, round: config.roundId,
      handler: async d => {
        const r = await main(db, config, 'manager')(d);
        if (++n === 1) throw new Error('timeout after server commit');
        return { result: r };
      }
    });
    await bind(s);
    const invite = { action: 'createInvitation', projectId: created.projectId, requestId: 'same-invite', role: '师傅', trades: ['拆改'] };
    const first = await s.client.callSandbox(invite, { api: s.api });
    const retry = await s.client.resumePending({ api: s.api });
    const invitations = count(db, 'invitations');
    if (invitations !== 1) throw new Error('产生了 ' + invitations + ' 份邀请');
    if (retry.code !== 'SANDBOX_RETRY_UNSAFE') throw new Error('应拒绝重发，实际 ' + retry.code);
    if (s.calls.length !== 1) throw new Error('云调用次数应仍为 1，实际 ' + s.calls.length);
    return {
      invitationsAfterRetry: invitations, firstUnknown: first.unknown === true,
      retryCode: retry.code, cloudCalls: s.calls.length, writeLocked: first.writeLocked === true
    };
  });

  await verify('T1-b', '没有直接清锁重发路径：解除需显式核对且解除后仍锁写', async () => {
    const s = stack();
    await bind(s);
    const unknown = await s.client.callSandbox(
      { action: 'createInvitation', projectId: 'p_sbx_target', requestId: 'inv-1', role: '师傅', trades: ['拆改'] },
      { api: s.api });
    const blind = s.client.resolvePendingAfterExternalCheck(s.store, {});
    const resolved = s.client.resolvePendingAfterExternalCheck(s.store, { externallyVerified: true });
    const after = s.client.readPending(s.store, ENV_ID, ROUND);
    const resend = await s.client.callSandbox(
      { action: 'createInvitation', projectId: 'p_sbx_target', requestId: 'inv-2', role: '师傅', trades: ['拆改'] },
      { api: s.api });
    if (blind.code !== 'SANDBOX_VERIFICATION_REQUIRED') throw new Error('未确认核对竟被接受');
    if (resolved.ok !== true || resolved.writeLocked !== true) throw new Error('确认后应解除但保持锁写');
    if (after.record.writeLocked !== true) throw new Error('解除后必须仍锁写');
    if (resend.code !== 'SANDBOX_PENDING_UNRESOLVED') throw new Error('解除后仍发出新写：' + resend.code);
    return {
      unknownCode: unknown.code, retryAllowed: unknown.retryAllowed, blindCode: blind.code,
      resolvedKeepsWriteLock: resolved.writeLocked, resendCode: resend.code, cloudCalls: s.calls.length
    };
  });

  await verify('T1-c', '取号未知即停止；施工回执重试不重复；首次日期冲突可修改', async () => {
    // 取号：无幂等保障，未知即停止
    const a = stack();
    await bind(a);
    const numberUnknown = await a.client.callSandbox({ action: 'requestBindingNumber', requestId: 'bn-1' }, { api: a.api });
    const numberRetry = await a.client.resumePending({ api: a.api });
    if (numberUnknown.retryAllowed !== false) throw new Error('取号不得声称可重发');
    if (numberRetry.code !== 'SANDBOX_RETRY_UNSAFE') throw new Error('取号重试应被拒：' + numberRetry.code);
    if (a.calls.length !== 1) throw new Error('取号不得重发，云调用 ' + a.calls.length);

    // 施工：首次日期冲突 → 明确拒绝并清理，可修改后再发
    let mode = 'conflict';
    const b = stack({
      handler: async () => (mode === 'conflict'
        ? { result: { ok: false, code: 'SCHEDULE_CONFLICT', message: '施工日期冲突' } }
        : { result: { ok: true, sandbox: true, scheduleId: 'sch-ok' } })
    });
    await bind(b);
    const conflicted = await b.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'sc-1', form: { content: 'x' } }, { api: b.api });
    const pendingAfter = b.client.readPending(b.store, ENV_ID, ROUND);
    mode = 'ok';
    const fixed = await b.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'sc-2', form: { content: '修正后' } }, { api: b.api });
    if (conflicted.definite !== true) throw new Error('SCHEDULE_CONFLICT 应为明确拒绝');
    if (pendingAfter.record !== null) throw new Error('明确拒绝后应清理未决记录以便修正');
    if (fixed.ok !== true) throw new Error('修正后应可提交：' + JSON.stringify(fixed));
    return {
      bindingNumberRetryCode: numberRetry.code, bindingNumberCloudCalls: a.calls.length,
      conflictDefinite: conflicted.definite === true, pendingClearedAfterConflict: true,
      fixedRequestId: b.calls[b.calls.length - 1].requestId
    };
  });

  await verify('T1-d', '未知之后的窗口/权限拒绝不被当作原提交未发生', async () => {
    const s = stack({ handler: async () => ({ result: { ok: false, code: 'SANDBOX_EXPIRED', message: '测试窗口已结束' } }) });
    await bind(s);
    await s.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'sch-1', form: { content: 'x' } }, { api: s.api });
    const beforeReject = s.client.readPending(s.store, ENV_ID, ROUND);
    // 换成拒绝传输
    s.api.cloud.callFunction = async a => {
      s.calls.push(clone(a.data));
      if (a.data.action === 'identify') return { result: { ok: true, userId: TRUSTED } };
      return { result: { ok: false, code: 'SANDBOX_EXPIRED', message: '测试窗口已结束' } };
    };
    const denied = await s.client.resumePending({ api: s.api });
    const after = s.client.readPending(s.store, ENV_ID, ROUND);
    if (denied.unknown !== true) throw new Error('门控拒绝应仍标为结果未知');
    if (after.record === null) throw new Error('门控拒绝不得清除未决记录');
    if (after.record.requestId !== beforeReject.record.requestId) throw new Error('未决记录被换掉了');
    return {
      denialCode: denied.code, stillUnknown: denied.unknown === true,
      pendingRetained: true, sameRequestId: after.record.requestId
    };
  });

  // ── T2 ────────────────────────────────────────────────────────────────
  await verify('T2-a', '未决记录是单一 envelope：半写/半清理拼不出合法请求', async () => {
    const s = stack({ handler: async () => { throw new Error('timeout'); } });
    await bind(s);
    await s.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'rs-1', form: { content: '原内容' } }, { api: s.api });
    const keys = [...s.store.map.keys()];
    const envelopeKey = keys.find(k => k.includes(':envelope:'));
    if (keys.length !== 2 || !envelopeKey) throw new Error('应只有账号键 + 单一 envelope 键：' + keys.join(','));
    const env = s.store.map.get(envelopeKey);
    const required = ['requestId', 'action', 'actionClass', 'projectId', 'accountId', 'roundId', 'envId', 'snapshot', 'snapshotDigest'];
    const missing = required.filter(f => !Object.prototype.hasOwnProperty.call(env, f));
    if (missing.length) throw new Error('envelope 缺字段：' + missing.join(','));

    // 半清理：删不掉 envelope → 仍必须拦着新写
    const t = stack({ store: s.store, handler: async () => ({ result: { ok: true } }) });
    t.store.failRemove = true;
    await t.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'rs-2', form: { content: '第二次' } }, { api: t.api });
    t.store.failRemove = false;
    const before = t.calls.length;
    const mixed = await t.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'rs-3', form: { content: '第三次' } }, { api: t.api });
    if (mixed.code !== 'SANDBOX_PENDING_UNRESOLVED') throw new Error('半清理后仍发出新写：' + mixed.code);
    if (t.calls.length !== before) throw new Error('不得发出新编号 + 旧载荷的混合请求');
    return {
      storageKeys: keys.length, envelopeFields: required.length,
      halfCleanupResendCode: mixed.code, mixedRequestSent: false
    };
  });

  await verify('T2-b', '同轮次换目标、账号切换、读失败与旧残留全部阻止错误发送', async () => {
    const store = makeStorage();
    const a = stack({ store, handler: async () => { throw new Error('timeout'); } });
    await bind(a);
    await a.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'old', form: { content: '原目标载荷' } }, { api: a.api });

    // 同轮次换目标
    const b = stack({ store, target: 'p_sbx_other', handler: async () => ({ result: { ok: true } }) });
    const retargeted = await b.client.resumePending({ api: b.api });
    if (retargeted.code !== 'SANDBOX_TARGET_CHANGED') throw new Error('换目标未被拦：' + retargeted.code);
    if (b.calls.length !== 0) throw new Error('换目标后仍发出请求');

    // 账号切换
    store.setStorageSync(`${originalProof.cachePrefix}account:${ENV_ID}:${ROUND}`, 'u_someone_else');
    const c = stack({ store, handler: async () => ({ result: { ok: true } }) });
    const switched = await c.client.resumePending({ api: c.api });
    if (switched.ok !== false || c.calls.length !== 0) throw new Error('换账号仍恢复了他人记录');
    store.setStorageSync(`${originalProof.cachePrefix}account:${ENV_ID}:${ROUND}`, TRUSTED);

    // 读失败
    const d = stack({ store, handler: async () => ({ result: { ok: true } }) });
    d.store.failRead = true;
    const readFail = await d.client.callSandbox(
      { action: 'listSchedules', projectId: 'p_sbx_target', requestId: 'rf' }, { api: d.api });
    if (readFail.code !== 'SANDBOX_STORAGE_UNAVAILABLE') throw new Error('读失败未阻断：' + readFail.code);
    d.store.failRead = false;

    // 旧格式残留（只阻断不删除）：用**干净存储**模拟"只有旧残留、没有 envelope"
    const legacyStore = makeStorage();
    const legacyBootstrap = stack({ store: legacyStore, handler: async () => ({ result: { ok: true } }) });
    await bind(legacyBootstrap);
    const legacyKey = `${originalProof.cachePrefix}pending:${ENV_ID}:${ROUND}`;
    legacyStore.setStorageSync(legacyKey, { requestId: 'legacy' });
    const e = stack({ store: legacyStore, handler: async () => ({ result: { ok: true } }) });
    const before = e.calls.length;
    const legacy = await e.client.callSandbox(
      { action: 'listSchedules', projectId: 'p_sbx_target', requestId: 'lg' }, { api: e.api });
    if (legacy.code !== 'SANDBOX_STORAGE_UNAVAILABLE') throw new Error('旧残留未阻断：' + legacy.code);
    if (e.calls.length !== before) throw new Error('旧残留下仍发出请求');
    if (!legacyStore.map.has(legacyKey)) throw new Error('旧缓存被擅自删除（不允许）');
    return {
      retargetCode: retargeted.code, accountSwitchCode: switched.code || 'no-pending',
      readFailCode: readFail.code, legacyCode: legacy.code, legacyCachePreserved: true
    };
  });

  // ── T3 ────────────────────────────────────────────────────────────────
  await verify('T3-a', '回执在但项目已删除：停止而非宣称成功', async () => {
    const db = H.seededDb(), invoke = main(db, cfg());
    const payload = { action: 'createProject', requestId: 'r-del', name: '虚构测试 · 回放核验' };
    const first = await invoke(payload);
    await db.collection(PREFIX + 'projects').doc(first.projectId).remove();
    const replay = await invoke(payload);
    if (replay.ok === true) throw new Error('项目已删除却报成功');
    if (replay.code !== 'SANDBOX_PROJECT_STATE_CONFLICT') throw new Error('错误码：' + replay.code);
    return { replayCode: replay.code, projects: count(db, 'projects'), receipts: count(db, 'schedule_receipts') };
  });

  await verify('T3-b', '并发回放重新核验当前 primary 权限', async () => {
    const db = H.seededDb(), config = cfg(), original = db.runTransaction;
    let interposed = false;
    db.runTransaction = async work => {
      if (!interposed) {
        interposed = true;
        const winner = await main(db, config)({ action: 'createProject', requestId: 'winner', name: '虚构测试 · 回放核验' });
        if (winner.ok !== true) throw new Error('胜出请求失败');
        await db.collection(PREFIX + 'app_admins').doc('primary').update({ data: { userId: H.U.manager } });
      }
      return original(work);
    };
    const loser = await main(db, config)({ action: 'createProject', requestId: 'loser', name: '虚构测试 · 回放核验' });
    if (!interposed) throw new Error('并发交错未发生');
    if (loser.ok === true) throw new Error('失权后并发回放仍报成功');
    return { loserCode: loser.code, primaryNow: db.getData()[PREFIX + 'app_admins'].primary.userId === H.U.manager, projects: count(db, 'projects') };
  });

  await verify('T3-c', '提交后读失败不谎称已回滚，同号可取回原结果', async () => {
    const db = H.seededDb(), invoke = main(db, cfg());
    const payload = { action: 'createProject', requestId: 'r-pc', name: '虚构测试 · 提交后读失败' };
    db.failNextRead(PREFIX + 'schedule_receipts', 'doc.get', 'POST_COMMIT_READ_FAILED',
      () => count(db, 'projects') === 1);
    const failed = await invoke(payload);
    if (failed.ok === true) throw new Error('读失败却报成功');
    if (/已整体回滚/.test(failed.message || '')) throw new Error('错误信息谎称已回滚：' + failed.message);
    const projects = count(db, 'projects'), receipts = count(db, 'schedule_receipts');
    const replay = await invoke(payload);
    if (replay.ok !== true || replay.replayed !== true) throw new Error('同号重试未取回原结果');
    if (count(db, 'projects') !== 1 || count(db, 'schedule_receipts') !== 1) throw new Error('重试造成重复落库');
    return {
      firstCode: failed.code, rollbackClaim: false, message: failed.message,
      committedProjects: projects, committedReceipts: receipts,
      replayRecovered: true, finalProjects: count(db, 'projects')
    };
  });

  await verify('T3-d', '轮次记录字段与确定性 ID 不一致一律停止', async () => {
    const guard = require(rel('miniapp/cloudfunctions/scheduleSandbox/project-guard'));
    const recordId = guard.roundRecordId('sandbox-round-1');
    const projectId = guard.roundProjectId('sandbox-round-1');
    const digest = guard.inputDigest('虚构测试 · 轮次核验');
    const base = {
      _id: recordId, projectId, actorUserId: H.U.owner, roundId: 'sandbox-round-1',
      action: 'createProject', inputDigest: digest, requestId: 'r',
      result: { projectId }, createdAt: '2026-01-01T00:00:00.000Z'
    };
    const mutations = [
      ['roundId', { roundId: 'another-round' }],
      ['action', { action: 'somethingElse' }],
      ['projectId', { projectId: 'p_sbx_deadbeef' }],
      ['result', { result: { projectId: 'p_sbx_deadbeef' } }],
      ['_id', { _id: recordId + 'x' }]
    ];
    const codes = [];
    for (const [, patch] of mutations) {
      const db = H.seededDb();
      await db.collection(PREFIX + 'projects').add({ data: { _id: projectId, name: '虚构测试', scope: 'identity-test', status: 'active', version: 1 } });
      await db.collection(PREFIX + 'schedule_receipts').add({ data: Object.assign({}, base, patch) });
      const r = await main(db, cfg())({ action: 'createProject', requestId: 'r', name: '虚构测试 · 轮次核验' });
      if (r.ok === true) throw new Error('损坏状态却报成功：' + JSON.stringify(patch));
      codes.push(r.code);
    }
    return { mutations: mutations.length, codes };
  });

  // ── T4 ────────────────────────────────────────────────────────────────
  await verify('T4-a', '带凭据的恢复不再卡死；错误凭据拒绝；休息日与邀请编号回填', async () => {
    const store = makeStorage();
    const secret = 'LOCAL_SYNTHETIC_SECRET';
    const first = stack({ store, handler: async () => { throw new Error('timeout'); } });
    await bind(first);
    await first.client.callSandbox(
      { action: 'approveInvitation', projectId: 'p_sbx_target', invitationId: 'inv-local', applicantNumber: secret, requestId: 'ap-1' },
      { api: first.api });

    // 退出重进
    const second = stack({ store, handler: async () => ({ result: { ok: true } }) });
    second.page.onLoad();
    if (second.page.data.pendingRequestId !== 'ap-1') throw new Error('未恢复请求编号');
    // 业务字段仍锁定
    second.page.inputField(evt('invitationIdInput', 'inv-changed'));
    if (second.page.data.invitationIdInput !== 'inv-local') throw new Error('业务字段未锁定');
    // 只需补录本次所需凭据
    second.page.inputCredential(evt('applicantNumberInput', secret));
    if (second.page.data.applicantNumberInput !== secret) throw new Error('凭据未补录成功');
    const raw = JSON.stringify([...store.map.values()]);
    if (raw.includes(secret)) throw new Error('原始凭据落盘了');
    // 正确凭据 → 进入该动作允许的恢复路径（无幂等保障 → 停止重发，不清锁）
    await second.page.retryPending();
    if (second.calls.length !== 0) throw new Error('无幂等保障的动作竟重发');
    if (!/没有服务端幂等保障/.test(second.page.data.lastError)) throw new Error('提示不明：' + second.page.data.lastError);

    // 错误凭据
    const third = stack({ store, handler: async () => ({ result: { ok: true } }) });
    third.page.onLoad();
    third.page.inputCredential(evt('applicantNumberInput', 'WRONG'));
    await third.page.retryPending();
    if (third.calls.length !== 0) throw new Error('错误凭据仍发出请求');
    if (!/与原请求不一致/.test(third.page.data.lastError)) throw new Error('未提示凭据不符：' + third.page.data.lastError);

    // 休息日回填到 restDaysText
    const fourth = stack({ store: makeStorage(), handler: async () => { throw new Error('timeout'); } });
    await bind(fourth);
    await fourth.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'rs', form: { content: '施工内容', restDays: ['2026-01-02', '2026-01-03'] } },
      { api: fourth.api });
    const fifth = stack({ store: fourth.store });
    fifth.page.onLoad();
    if (fifth.page.data.form.restDaysText !== '2026-01-02,2026-01-03') {
      throw new Error('restDays 未回填到 restDaysText：' + fifth.page.data.form.restDaysText);
    }
    return {
      credentialInputAccepted: true, businessFieldsLocked: true,
      rawCredentialStored: raw.includes(secret), correctCredentialResend: second.calls.length,
      wrongCredentialResend: third.calls.length,
      restDaysText: fifth.page.data.form.restDaysText
    };
  });

  await verify('T4-b', '日期不一致未确认则拒绝发送；确认后才发送 expectedConfirmed=true', async () => {
    const s = stack({ handler: async () => ({ result: { ok: true } }) });
    await bind(s);
    s.page.onLoad();
    s.page.inputForm(evt('startDate', '2026-02-01'));
    s.page.inputForm(evt('endDate', '2026-02-10'));
    s.page.inputForm(evt('expectedDate', '2026-02-20'));
    if (s.page.data.dateMismatch !== true) throw new Error('未识别日期不一致');
    await s.page.runAction('createSchedule');
    const unconfirmedCalls = s.calls.length;
    if (unconfirmedCalls !== 0) throw new Error('未确认仍发送');
    s.page.toggleDateConfirm({ detail: { value: true } });
    await s.page.runAction('createSchedule');
    if (s.calls.length !== 1) throw new Error('确认后未发送');
    if (s.calls[0].expectedConfirmed !== true) throw new Error('确认后未发送 expectedConfirmed=true');
    // 源码层面确认不再无条件 true
    const src = fs.readFileSync(pagePath, 'utf8');
    if (/payload\.expectedConfirmed = true/.test(src)) throw new Error('源码仍有无条件 expectedConfirmed=true');
    return {
      dateMismatchDetected: true, requestsWithoutConfirm: unconfirmedCalls,
      requestsAfterConfirm: s.calls.length, expectedConfirmed: s.calls[0].expectedConfirmed
    };
  });

  // ── T5 ────────────────────────────────────────────────────────────────
  await verify('T5-a', '事务未提交写入对外与对其它事务均不可见', async () => {
    let signal; let release;
    const reached = new Promise(r => { signal = r; });
    const resume = new Promise(r => { release = r; });
    const raw = H.seededDb({}, { pauseBeforeCommit: async () => { signal(); await resume; } });
    const { createSandboxDb } = require(rel('miniapp/cloudfunctions/scheduleSandbox/collection-map'));
    const db = createSandboxDb(raw);
    const tx = db.runTransaction(async t => { await t.collection('schedule_receipts').add({ data: { _id: 'uncommitted', roundId: 'x' } }); });
    await reached;
    const outside = await raw.collection(PREFIX + 'schedule_receipts').doc('uncommitted').get();
    let otherSaw = 'unset';
    await raw.runTransaction(async t => {
      otherSaw = (await t.collection(PREFIX + 'schedule_receipts').doc('uncommitted').get()).data;
    });
    const logBefore = raw.getWriteLog().some(w => w.key === 'uncommitted');
    release();
    await tx;
    const afterCommit = raw.getData()[PREFIX + 'schedule_receipts'].uncommitted;
    if (outside.data !== null) throw new Error('事务外读到未提交记录');
    if (otherSaw !== null) throw new Error('其它事务读到未提交记录');
    if (logBefore) throw new Error('未提交写入进了全局写日志');
    if (!afterCommit) throw new Error('提交后仍不可见');
    return {
      visibleOutsideTransaction: false, visibleToOtherTransaction: false,
      writeLogBeforeCommit: false, visibleAfterCommit: true
    };
  });

  await verify('T5-b', '一事务回滚不让另一请求假成功；交错失败后他事务数据保留', async () => {
    const db = H.seededDb(), config = cfg(), original = db.runTransaction;
    let signal; let release; let first = true;
    const reached = new Promise(r => { signal = r; });
    const resume = new Promise(r => { release = r; });
    db.runTransaction = work => original(async tx => {
      const result = await work(tx);
      if (first) { first = false; signal(); await resume; throw new Error('FAIL_BEFORE_COMMIT'); }
      return result;
    });
    const payload = { action: 'createProject', requestId: 'same', name: '虚构测试 · 交错' };
    const failing = main(db, config)(payload);
    await reached;
    const second = await main(db, config)(payload);
    release();
    const failed = await failing;
    if (second.ok !== true) throw new Error('第二请求失败：' + JSON.stringify(second));
    if (second.replayed !== false) throw new Error('第二请求声称回放了不存在的记录');
    if (failed.ok !== false) throw new Error('第一请求应失败');
    if (count(db, 'projects') !== 1 || count(db, 'schedule_receipts') !== 1) {
      throw new Error('最终状态异常：项目 ' + count(db, 'projects') + ' 回执 ' + count(db, 'schedule_receipts'));
    }
    return {
      firstFailed: true, secondReportedSuccess: true, secondReplayed: false,
      finalProjects: count(db, 'projects'), finalReceipts: count(db, 'schedule_receipts')
    };
  });

  await verify('T5-c', '并发成功必须看到已提交回执，双方先看到无回执再竞争', async () => {
    const db = H.seededDb(), config = cfg();
    const payload = { action: 'createProject', requestId: 'race', name: '虚构测试 · 并发竞争' };
    const [a, b] = await Promise.all([
      main(db, config)(payload),
      main(db, config)(Object.assign({}, payload, { requestId: 'race-2' }))
    ]);
    if (a.ok !== true || b.ok !== true) throw new Error('并发双方应都成功');
    if (a.projectId !== b.projectId) throw new Error('并发得到不同项目');
    if (count(db, 'projects') !== 1 || count(db, 'schedule_receipts') !== 1) throw new Error('出现重复落库');
    if (a.replayed === b.replayed) throw new Error('应恰好一方是回放');
    return {
      bothSucceeded: true, sameProject: true, projects: count(db, 'projects'),
      receipts: count(db, 'schedule_receipts'), exactlyOneReplayed: true
    };
  });

  // ── 基线与入口 ────────────────────────────────────────────────────────
  const baseline = JSON.parse(fs.readFileSync(rel('docs/证据/施工安排事务兼容V1-V3验收-20261003.json'), 'utf8')).currentCodeSha256;
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(rel(file))).digest('hex');
  const changed = Object.entries(baseline).filter(([p, h]) => sha(p) !== h).map(([p]) => p);
  const oldProof = req('../config/schedule-entry-proof');
  const entry = {
    newEnabled: originalProof.enabled,
    newSandboxProjectId: originalProof.sandboxProjectId,
    oldEnabled: oldProof.enabled,
    oldAllowedProjectIds: oldProof.allowedProjectIds,
    newProofFrozen: Object.isFrozen(originalProof),
    oldProofFrozen: Object.isFrozen(oldProof)
  };

  const report = {
    date: '2026-10-04',
    scope: 'local synthetic verification of T1-T5 fixes; no network, no cloud, no install',
    supersedes: null,
    companionHistoricalEvidence: 'docs/证据/独立测试副本S1-S6-Codex复核-20261004.cjs（断言返修前缺陷，保留不改写）',
    results,
    baseline: { files: Object.keys(baseline).length, changed },
    entry,
    cloudOperationsPerformed: false,
    resourcesCreated: false,
    installed: false,
    deployed: false,
    userCacheCleared: false,
    limitations: [
      '合成数据库替身不是平台事务模型：T5 的隔离/冲突结论基于内存交错，未实测真实平台 runTransaction',
      '页面仅结构解析通过，未在微信开发者工具或真机编译运行（本机未找到 wcc/wcsc）',
      '真实 SDK 请求形状、3 秒超时、100 操作、32 KiB 限制未实测',
      '并发结论基于 Promise 并发与替身冲突检测；真实平台并发未实测',
      '11 个带前缀集合与索引尚未创建；新副本仍只是部署候选',
      '费用未核实，不承诺 0 元'
    ]
  };
  fs.writeFileSync(__filename.replace(/\.cjs$/, '.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n证据已写入：${path.basename(__filename).replace(/\.cjs$/, '.json')}`);
  console.log(`通过 ${results.length}/${results.length} 条；基线 ${Object.keys(baseline).length} 文件，仅 ${changed.join(',') || '（无）'} 变化。`);
})().catch(error => { console.error(error); process.exitCode = 1; });
