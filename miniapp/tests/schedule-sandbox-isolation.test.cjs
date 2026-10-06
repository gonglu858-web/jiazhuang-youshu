// 施工安排独立测试副本：准备链、一致提交、归属隔离与集合保护验收。
//
// Codex 复核 S1–S6 返修后的验收范围：
// - S1 真实 main 准备链全程可走通（建项目→取号→指定管家→邀请→申请→批准→核对成员），
//   随后受控切换 execute 执行施工四写与查询；**不使用直接 vendor 写成员跳过准备**。
// - S2 建项目与唯一记录/回执**一致提交**：真实回执写故障注入后不留半套状态；
//   同号/不同号并发取得同一原结果且不重复落库；一个轮次只允许一个项目。
// - S3 记录真实归属优先：请求 ID 不得覆盖；跨项目邀请码在两阶段均拒绝且零写入；
//   列表只限本轮项目。
// - R1/R6 已通过项保持覆盖（身份字段契约、集合原型名与句柄保护）。
// - S6 真实回执写故障注入（非成功后删回执）、并发不得接受 SERVER_ERROR、
//   listMyProjects 实测、事务冲突与回滚语义。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const { PREFIX, LOGICAL_COLLECTIONS, createSandboxDb, SandboxConfigError } =
  require('../cloudfunctions/scheduleSandbox/collection-map');
const gate = require('../cloudfunctions/scheduleSandbox/gate');
const projectGuard = require('../cloudfunctions/scheduleSandbox/project-guard');
const { createSandboxTestDb, UnprefixedCollectionError } =
  require('./helpers/sandbox-test-db.cjs');
const { APPID, OPENIDS, U, loadEntry, openConfig, seededDb, BASE } =
  require('./helpers/sandbox-entry-loader.cjs');

const prepConfig = (overrides = {}) => openConfig({ allowedUserIds: Object.values(U), ...overrides });
const main = (db, config, who = 'owner') =>
  loadEntry(db, config, { appId: APPID, openid: OPENIDS[who || 'owner'] }).main;
const countOf = (db, name) => Object.keys(db.getPrefixedData()[PREFIX + name] || {}).length;

/** 走完准备链的成员准备（建项目→管家→两名师傅），返回 projectId。 */
async function prepareThroughMain(db, config) {
  const created = await main(db, config, 'owner')({
    action: 'createProject', requestId: 'r-create-1', name: '虚构测试 · 独立副本'
  });
  assert.equal(created.ok, true, `建项目失败：${JSON.stringify(created)}`);
  const projectId = created.projectId;
  const number = await main(db, config, 'manager')({ action: 'requestBindingNumber' });
  assert.equal(number.ok, true, '取号应成功');
  const assigned = await main(db, config, 'owner')({
    action: 'assignManager', projectId, bindingNumber: number.bindingNumber
  });
  assert.equal(assigned.ok, true, `指定管家失败：${JSON.stringify(assigned)}`);
  for (const [who, trades] of [['worker', ['拆改']], ['worker2', ['拆改', '木工']]]) {
    const inv = await main(db, config, 'manager')({ action: 'createInvitation', projectId, role: '师傅', trades });
    assert.equal(inv.ok, true, `邀请失败：${JSON.stringify(inv)}`);
    const num = await main(db, config, who)({ action: 'requestBindingNumber' });
    const applied = await main(db, config, who)({ action: 'applyInvitation', invitationCode: inv.invitationCode });
    assert.equal(applied.ok, true, `申请失败：${JSON.stringify(applied)}`);
    const approved = await main(db, config, 'manager')({
      action: 'approveInvitation', projectId, invitationId: inv.invitationId, applicantNumber: num.bindingNumber
    });
    assert.equal(approved.ok, true, `批准失败：${JSON.stringify(approved)}`);
  }
  return projectId;
}

// ===== S1：真实 main 准备链 =====

test('S1.1 从零经真实 main 走完准备链（不使用 vendor 直接写成员）', async () => {
  const db = seededDb();
  const config = prepConfig();
  const projectId = await prepareThroughMain(db, config);

  // 准备期必要查询
  const members = await main(db, config, 'manager')({ action: 'getMembers', projectId });
  assert.equal(members.ok, true, '成员核对应可用');
  assert.ok(members.members.length >= 3, `成员数不足：${members.members.length}`);
  const invitations = await main(db, config, 'manager')({ action: 'listInvitations', projectId });
  assert.equal(invitations.ok, true, '邀请核对应可用');

  for (const name of db.getVisitedCollections()) {
    assert.ok(name.startsWith(PREFIX), `准备链越界访问：${name}`);
  }
});

test('S1.2 准备期不放行施工写动作；切换 execute 后施工四写与查询可用', async () => {
  const db = seededDb();
  const config = prepConfig();
  const projectId = await prepareThroughMain(db, config);

  // 准备期仍拒绝施工写
  const blocked = await main(db, config, 'manager')({
    action: 'createSchedule', projectId, requestId: 's0',
    form: {
      stage: '拆改', trade: '拆改', workerUserId: U.worker,
      startDate: '2026-10-05', endDate: '2026-10-06', expectedDate: '2026-10-06',
      restDays: [], content: '准备期不应放行'
    }
  });
  assert.equal(blocked.ok, false, '准备期不得放行施工写动作');
  assert.equal(blocked.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE', blocked.code);

  // 切换执行期
  const execConfig = prepConfig({ phase: 'execute', projectId });
  const form = {
    stage: '拆改', trade: '拆改', workerUserId: U.worker,
    startDate: '2026-10-05', endDate: '2026-10-07', expectedDate: '2026-10-07',
    restDays: [], content: '执行期首条安排'
  };
  const c = await main(db, execConfig, 'manager')({ action: 'createSchedule', projectId, requestId: 's1', form, expectedConfirmed: true });
  assert.equal(c.ok, true, `执行期新增应成功：${JSON.stringify(c)}`);
  const u = await main(db, execConfig, 'manager')({
    action: 'updateSchedule', projectId, scheduleId: c.scheduleId, expectedVersion: c.version,
    requestId: 's2', reason: '调整演练', form: { ...form, content: '调整后' }, expectedConfirmed: true
  });
  assert.equal(u.ok, true, '调整应成功');
  const r = await main(db, execConfig, 'manager')({
    action: 'reassignSchedule', projectId, scheduleId: c.scheduleId, expectedVersion: u.version,
    requestId: 's3', workerUserId: U.worker2, reason: '改派演练'
  });
  assert.equal(r.ok, true, '改派应成功');
  const x = await main(db, execConfig, 'manager')({
    action: 'cancelSchedule', projectId, scheduleId: c.scheduleId, expectedVersion: r.version,
    requestId: 's4', reason: '收尾'
  });
  assert.equal(x.ok, true, '取消应成功');
  const list = await main(db, execConfig, 'manager')({ action: 'listSchedules', projectId });
  assert.equal(list.ok, true, '列表查询应成功');
  const history = await main(db, execConfig, 'manager')({ action: 'listScheduleRevisions', projectId, scheduleId: c.scheduleId });
  assert.equal(history.ok, true, '历史查询应成功');
  assert.ok(history.revisions.length > 0, '应有变更历史');
});

test('S1.3 准备期不接受外部指定项目（范围控制而非全盘拒绝）', async () => {
  const db = seededDb();
  const r = await main(db, prepConfig(), 'owner')({ action: 'listMyProjects', projectId: 'p_external' });
  assert.equal(r.ok, false);
  assert.ok(['SANDBOX_PROJECT_MISMATCH', 'SANDBOX_PROJECT_NOT_READY'].includes(r.code), r.code);
  assert.equal(db.getWriteLog().length, 0);
});

test('S1.4 未知阶段与未知动作仍被拒绝，零写入', async () => {
  for (const phase of ['typo', '']) {
    const db = seededDb();
    const r = await main(db, prepConfig({ phase }), 'owner')({ action: 'identify' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SANDBOX_PHASE_UNKNOWN', r.code);
    assert.equal(db.getOperationCount(), 0, '未知阶段不得访问数据库');
  }
  const db2 = seededDb();
  const r2 = await main(db2, prepConfig(), 'owner')({ action: 'not-a-real-action' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE', r2.code);
  assert.equal(db2.getWriteLog().length, 0, '未知动作零写入');
});

// ===== S2：一致提交与并发幂等 =====

test('S2.1 真实回执写故障注入：不留半套状态，重试取得原结果', async () => {
  const db = seededDb();
  // **真实注入**：在替身写回执的那一刻抛错（不是成功后手动删回执）。
  // 注入点在数据层，因此事务视图与普通视图都会命中。
  db.failNextWrite(PREFIX + 'schedule_receipts', 'add', 'INJECTED_RECEIPT_FAILURE');
  const payload = { action: 'createProject', requestId: 'receipt', name: '虚构测试 · 回执失败' };
  const first = await main(db, prepConfig(), 'owner')(payload);
  assert.notEqual(first.ok, true, `回执写失败时不得报告成功：${JSON.stringify(first)}`);
  // 一致提交：项目、成员、审计、回执**全部回滚**
  assert.equal(countOf(db, 'projects'), 0, `回执失败后不应留下项目，实际 ${countOf(db, 'projects')}`);
  assert.equal(countOf(db, 'project_members'), 0, '不应留下初始成员');
  assert.equal(countOf(db, 'schedule_receipts'), 0, '不应留下回执');

  const retry = await main(db, prepConfig(), 'owner')(payload);
  assert.equal(retry.ok, true, `重试应成功：${JSON.stringify(retry)}`);
  assert.equal(countOf(db, 'projects'), 1);
  assert.equal(countOf(db, 'schedule_receipts'), 1);
});

test('S2.2 同号并发取得同一原结果且不重复落库（不接受 SERVER_ERROR）', async () => {
  const db = seededDb();
  const payload = { action: 'createProject', requestId: 'same', name: '虚构测试 · 并发' };
  const results = await Promise.all([
    main(db, prepConfig(), 'owner')(payload),
    main(db, prepConfig(), 'owner')(payload)
  ]);
  for (const r of results) {
    assert.equal(r.ok, true, `并发结果不得失败：${JSON.stringify(r)}`);
  }
  assert.equal(new Set(results.map(r => r.projectId)).size, 1, '并发应返回同一项目');
  assert.equal(countOf(db, 'projects'), 1);
  assert.equal(countOf(db, 'schedule_receipts'), 1);
});

test('S2.3 不同号并发同样只产生一个项目', async () => {
  const db = seededDb();
  const results = await Promise.all([
    main(db, prepConfig(), 'owner')({ action: 'createProject', requestId: 'a', name: '虚构测试 · 并发甲' }),
    main(db, prepConfig(), 'owner')({ action: 'createProject', requestId: 'b', name: '虚构测试 · 并发甲' })
  ]);
  for (const r of results) assert.equal(r.ok, true, `结果不得失败：${JSON.stringify(r)}`);
  assert.equal(new Set(results.map(r => r.projectId)).size, 1);
  assert.equal(countOf(db, 'projects'), 1);
});

test('S2.4 一个轮次只允许一个项目：primary 改绑后也不得新建', async () => {
  const db = seededDb();
  const first = await main(db, prepConfig(), 'owner')({
    action: 'createProject', requestId: 'one', name: '虚构测试 · 唯一'
  });
  assert.equal(first.ok, true);
  // primary 改绑到另一位允许账号
  db.collection(PREFIX + 'app_admins').doc('primary').update({ data: { userId: U.manager } });
  const second = await main(db, prepConfig(), 'manager')({
    action: 'createProject', requestId: 'two', name: '虚构测试 · 唯一'
  });
  assert.equal(second.ok, true, '已建立的执行人变更后应走回放');
  assert.equal(second.projectId, first.projectId, '不得产生第二个项目');
  assert.equal(countOf(db, 'projects'), 1, '本轮只允许一个项目');
});

test('S2.5 同载荷不同 requestId 走回放；不同载荷明确拒绝', async () => {
  const db = seededDb();
  const first = await main(db, prepConfig(), 'owner')({
    action: 'createProject', requestId: 'r1', name: '虚构测试 · 原名'
  });
  const same = await main(db, prepConfig(), 'owner')({
    action: 'createProject', requestId: 'r2', name: '虚构测试 · 原名'
  });
  assert.equal(same.projectId, first.projectId, '换号同载荷应回放');
  assert.equal(same.replayed, true);
  const changed = await main(db, prepConfig(), 'owner')({
    action: 'createProject', requestId: 'r1', name: '虚构测试 · 改名'
  });
  assert.equal(changed.ok, false, '不同载荷必须拒绝');
  assert.equal(changed.code, 'SANDBOX_PROJECT_PAYLOAD_MISMATCH', changed.code);
  assert.equal(countOf(db, 'projects'), 1);
});

test('S2.6 回放先重验当前权限：失权与停用均拒绝', async () => {
  for (const revoke of ['disable-user', 'revoke-primary']) {
    const db = seededDb();
    const first = await main(db, prepConfig(), 'owner')({
      action: 'createProject', requestId: 'r1', name: '虚构测试 · 权限'
    });
    assert.equal(first.ok, true);
    if (revoke === 'disable-user') {
      db.collection(PREFIX + 'users').doc(U.owner).update({ data: { status: 'disabled' } });
    } else {
      db.collection(PREFIX + 'app_admins').doc('primary').update({ data: { userId: U.manager } });
    }
    const replay = await main(db, prepConfig(), 'owner')({
      action: 'createProject', requestId: 'r1', name: '虚构测试 · 权限'
    });
    assert.equal(replay.ok, false, `${revoke} 后回放必须被拒绝`);
    assert.ok(['SANDBOX_ACCOUNT_NOT_ACTIVE', 'SANDBOX_NOT_PRIMARY_ADMIN'].includes(replay.code), replay.code);
  }
});

test('S2.7 唯一记录缺失但项目存在时停止（损坏检测，不是正常恢复）', async () => {
  const db = seededDb();
  const created = await main(db, prepConfig(), 'owner')({
    action: 'createProject', requestId: 'r1', name: '虚构测试 · 损坏'
  });
  assert.equal(created.ok, true);
  db.collection(PREFIX + 'schedule_receipts')
    .doc(projectGuard.roundRecordId('sandbox-round-1')).remove();
  const again = await main(db, prepConfig(), 'owner')({
    action: 'createProject', requestId: 'r2', name: '虚构测试 · 损坏'
  });
  assert.equal(again.ok, false, '唯一记录缺失必须停止而非重建');
  assert.equal(again.code, 'SANDBOX_PROJECT_STATE_CONFLICT', again.code);
  assert.equal(countOf(db, 'projects'), 1, '不得重建出第二个项目');
});

// ===== S3：记录真实归属与列表隔离 =====

async function invitationDb(code = 'ABCDEF123456ABCDEF') {
  const db = seededDb();
  for (const id of ['p_allowed', 'p_other']) {
    await db.collection(PREFIX + 'projects').add({ data: {
      _id: id, name: '虚构测试 · 本地', scope: 'identity-test', status: 'active',
      version: 1, ownerUserId: U.owner
    } });
  }
  await db.collection(PREFIX + 'invitations').add({ data: {
    _id: 'i_other', projectId: 'p_other', role: '师傅', trades: ['拆改'],
    tokenHash: crypto.createHash('sha256').update(`${APPID}:${code}`).digest('hex'),
    status: 'issued', version: 1, expiresAt: '2030-01-01T00:00:00Z'
  } });
  db.reset();
  return { db, code };
}

test('S3.1 跨项目邀请码：带允许ID、不带ID、带错ID均被拒且零写入', async () => {
  for (const phase of ['prepare', 'execute']) {
    for (const variant of ['with-allowed-id', 'without-id', 'with-wrong-id']) {
      const { db, code } = await invitationDb();
      const config = prepConfig({ phase, projectId: phase === 'execute' ? 'p_allowed' : '' });
      const payload = { action: 'applyInvitation', invitationCode: code };
      if (variant === 'with-allowed-id') payload.projectId = 'p_allowed';
      if (variant === 'with-wrong-id') payload.projectId = 'p_other';
      const r = await main(db, config, 'worker')(payload);
      assert.equal(r.ok, false, `${phase}/${variant} 跨项目邀请必须被拒绝（实际 ${JSON.stringify(r)}）`);
      assert.equal(db.getWriteLog().length, 0, `${phase}/${variant} 拒绝时必须零写入`);
      assert.equal(db.getPrefixedData()[PREFIX + 'invitations'].i_other.status, 'issued', '邀请状态不得被改写');
    }
  }
});

test('S3.2 邀请码大小写与空格变体按 vendor 规范化后同样被拒', async () => {
  for (const raw of [' abcdef123456abcdef ', 'ABCDEF123456ABCDEF', 'AbCdEf123456AbCdEf']) {
    const { db } = await invitationDb();
    const r = await main(db, prepConfig({ phase: 'execute', projectId: 'p_allowed' }), 'worker')({
      action: 'applyInvitation', invitationCode: raw
    });
    assert.equal(r.ok, false, `变体「${raw}」应被拒绝`);
    assert.equal(db.getWriteLog().length, 0);
  }
});

test('S3.3 listMyProjects 只返回本轮项目（实测列表接口）', async () => {
  {
    const { db } = await invitationDb();
    const r = await main(db, prepConfig({ phase: 'execute', projectId: 'p_allowed' }), 'owner')({ action: 'listMyProjects' });
    assert.equal(r.ok, false, '未建立本轮项目时不应返回其它项目');
    assert.equal(r.code, 'SANDBOX_PROJECT_NOT_READY', r.code);
  }
  {
    const db = seededDb();
    const created = await main(db, prepConfig(), 'owner')({
      action: 'createProject', requestId: 'r1', name: '虚构测试 · 本轮'
    });
    await db.collection(PREFIX + 'projects').add({ data: {
      _id: 'p_other_round', name: '虚构测试 · 其他轮次', scope: 'identity-test',
      status: 'active', version: 1, ownerUserId: U.owner
    } });
    const r = await main(db, prepConfig({ phase: 'execute', projectId: created.projectId }), 'owner')({
      action: 'listMyProjects'
    });
    assert.equal(r.ok, true, `列表应可用：${JSON.stringify(r)}`);
    const ids = (r.projects || []).map(p => p.id);
    assert.deepEqual(ids, [created.projectId], `列表只应含本轮项目，实际 ${JSON.stringify(ids)}`);
  }
});

test('S3.4 原 A/B/C 项目 ID 在两阶段与误配下均被硬拒绝', async () => {
  assert.equal(gate.PROTECTED_PROJECT_IDS.length, 3);
  {
    const db = seededDb();
    for (const id of gate.PROTECTED_PROJECT_IDS) {
      const r = await main(db, prepConfig(), 'owner')({ action: 'getMembers', projectId: id });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'SANDBOX_PROJECT_PROTECTED', r.code);
      assert.equal(db.getWriteLog().length, 0);
    }
  }
  for (const id of gate.PROTECTED_PROJECT_IDS) {
    const db = seededDb();
    const r = await main(db, prepConfig({ phase: 'execute', projectId: id }), 'owner')({
      action: 'listSchedules', projectId: id
    });
    assert.equal(r.ok, false, `误配 ${id} 应被拒绝`);
    assert.equal(db.getOperationCount(), 0, '误配配置应在数据库访问前拒绝');
  }
});

// ===== R1 / R6：已通过项保持覆盖 =====

test('R1.1 经实际 main 完成身份登记（可信身份字段契约）', async () => {
  const db = seededDb();
  const newcomerOpenid = 'openid-brand-new';
  const newcomerId = require('./helpers/sandbox-entry-loader.cjs').userIdFor(newcomerOpenid);
  // 以**新账号本人**的上下文调用 identify（首次见到该账号会走完整身份初始化）
  const entry = loadEntry(db, prepConfig({ allowedUserIds: [newcomerId] }),
    { appId: APPID, openid: newcomerOpenid });
  const r = await entry.main({ action: 'identify' });
  assert.equal(r.ok, true, `身份登记应成功：${JSON.stringify(r)}`);
  const users = db.getPrefixedData()[PREFIX + 'users'];
  assert.ok(Object.values(users).some(u => u.openid === newcomerOpenid), '新账号应落在测试 users');
  assert.equal(db.getPrefixedData()['users'], undefined, '不得写入无前缀集合');
});

test('R1.2 缺失身份与错环境在最早阶段拒绝，零数据库访问', async () => {
  for (const [label, ctx, expected] of [
    ['缺 APPID', { appId: '', openid: OPENIDS.owner }, 'SANDBOX_APPID_UNVERIFIED'],
    ['缺 OPENID', { appId: APPID, openid: '' }, 'IDENTITY_UNAVAILABLE']
  ]) {
    const db = seededDb();
    const entry = loadEntry(db, prepConfig({ allowedUserIds: [U.owner] }), ctx);
    const r = await entry.main({ action: 'identify' });
    assert.equal(r.ok, false, `${label} 应被拒绝`);
    assert.equal(r.code, expected, r.code);
    assert.equal(entry.databaseCalls(), 0, `${label} 不得建立数据库连接`);
    assert.equal(db.getOperationCount(), 0);
  }
  const db2 = seededDb();
  const wrongEnv = loadEntry(db2, prepConfig({ allowedUserIds: [U.owner] }),
    { appId: APPID, openid: OPENIDS.owner }, 'other-env');
  const r2 = await wrongEnv.main({ action: 'identify' });
  assert.equal(r2.code, 'SANDBOX_ENV_MISMATCH');
  assert.equal(db2.getOperationCount(), 0);
});

test('R6.1 原型名与未登记名在事务内外均零下层调用', async () => {
  const names = [];
  const spy = { collection(n) { names.push(typeof n); return {}; }, runTransaction: async f => f(spy) };
  const mapped = createSandboxDb(spy);
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'unknown']) {
    assert.throws(() => mapped.collection(bad), SandboxConfigError, `应拒绝：${bad}`);
  }
  await mapped.runTransaction(async tx => {
    for (const bad of ['constructor', '__proto__', 'toString']) {
      assert.throws(() => tx.collection(bad), SandboxConfigError);
    }
  });
  assert.equal(names.length, 0, `原型名不得穿透到下层，实际 ${names.length} 次`);
});

test('R6.2 句柄不可被 set / defineProperty / delete / setPrototypeOf 改写', () => {
  const db = createSandboxDb(seededDb());
  const handle = db.collection('users');
  for (const mutate of [
    () => { handle.extra = 1; },
    () => Object.defineProperty(handle, 'extra2', { value: 2 }),
    () => { delete handle.doc; },
    () => Object.setPrototypeOf(handle, { injected: true })
  ]) {
    assert.throws(mutate, SandboxConfigError, '句柄改写必须被拒绝');
  }
  assert.equal(typeof handle.doc, 'function');
  assert.equal(typeof handle.where, 'function');
  assert.ok(!Object.prototype.hasOwnProperty.call(handle, 'extra'));
  assert.ok(!Object.prototype.hasOwnProperty.call(handle, 'extra2'));
});

test('R6.3 正常 SDK 方法与事务仍可用（未被过度拦截）', async () => {
  const raw = seededDb();
  const db = createSandboxDb(raw);
  await db.collection('users').add({ data: { _id: 'ok1', status: 'active' } });
  const got = await db.collection('users').doc('ok1').get();
  assert.equal(got.data.status, 'active');
  const q = await db.collection('users').where({ status: 'active' }).orderBy('_id', 'asc').limit(10).skip(0).get();
  assert.ok(Array.isArray(q.data));
  await db.runTransaction(async tx => {
    await tx.collection('users').doc('ok1').update({ data: { status: 'disabled' } });
  });
  assert.equal((await db.collection('users').doc('ok1').get()).data.status, 'disabled');
});

test('R6.4 替身对无前缀集合立即报错；映射表无原型', () => {
  const raw = createSandboxTestDb();
  assert.throws(() => raw.collection('users'), UnprefixedCollectionError);
  assert.throws(() => raw.collection(PREFIX + 'not_registered'), UnprefixedCollectionError);
  assert.equal(LOGICAL_COLLECTIONS.length, 11);
  const mapModule = require('../cloudfunctions/scheduleSandbox/collection-map');
  assert.equal(Object.getPrototypeOf(mapModule.COLLECTION_MAP), null, '映射表必须无原型');
});

// ===== S6：替身语义 =====

test('S6.1 事务提交有冲突检测，失败时只撤销本次写入并保留他事务提交', async () => {
  // 真实并发交错：外层事务的 attempt 0 在提交前被注入冲突（模拟 SDK 冲突重入），
  // 与此同时另一个事务已提交并推进版本；因此 attempt 0 必须被拒绝，
  // 且**不得**把他人已提交的记录误当作本次回滚。
  let releaseOuter;
  const gate = new Promise(resolve => { releaseOuter = resolve; });
  let reachedBarrier;
  const reached = new Promise(resolve => { reachedBarrier = resolve; });
  let injected = false;

  const raw = createSandboxTestDb({}, {
    // 第一个事务的 attempt 0 暂停，等待另一个事务提交后再继续
    barrier: async current => {
      if (current === 0 && !injected) {
        injected = true;
        reachedBarrier();
        await gate;
      }
    }
  });
  raw.collection(PREFIX + 'users').add({ data: { _id: 'u1', status: 'active' } });
  const db = createSandboxDb(raw);

  // 事务 A：先写入 u1（其 attempt 0 会在提交前暂停）
  const txA = raw.runTransaction(async tx => {
    await tx.collection(PREFIX + 'users').doc('u1').update({ data: { status: 'b1' } });
  });
  await reached;
  // 事务 B：在 A 暂停期间提交，**推进全局版本**
  await raw.runTransaction(async tx => {
    await tx.collection(PREFIX + 'users').add({ data: { _id: 'u2', status: 'x' } });
  });
  releaseOuter();

  // A 的 attempt 0 提交时基线已变化 → 冲突；重试后应成功
  await txA;

  const users = raw.getPrefixedData()[PREFIX + 'users'];
  assert.ok(injected, '屏障必须命中（否则本用例无效）');
  assert.ok(raw.getAttempts().length >= 2, '应发生过重入');
  // 关键：事务 B 的提交必须保留，不能被 A 的回滚抹掉
  assert.equal(users.u2.status, 'x', '另一事务的提交必须保留，不被误当本次回滚');
  // 事务 A 重试成功后 u1 应为 b1
  assert.equal(users.u1.status, 'b1', '重试成功后本次写入应生效');
});

test('S6.2 替身拒绝重复主键', () => {
  const raw = createSandboxTestDb();
  raw.collection(PREFIX + 'users').add({ data: { _id: 'dup', status: 'active' } });
  assert.throws(() => raw.collection(PREFIX + 'users').add({ data: { _id: 'dup', status: 'other' } }));
  assert.equal(raw.getPrefixedData()[PREFIX + 'users'].dup.status, 'active', '原记录不得被覆盖');
});

test('S6.3 重入由模拟 SDK 在同一次 runTransaction 内重调回调', async () => {
  const raw = createSandboxTestDb({}, { reentry: 1 });
  raw.collection(PREFIX + 'users').add({ data: { _id: 'u1', status: 'active' } });
  const db = createSandboxDb(raw);
  let invocations = 0;
  await db.runTransaction(async tx => {
    invocations++;
    await tx.collection('users').doc('u1').update({ data: { status: 'active' } });
  });
  assert.equal(invocations, 2, 'SDK 应在同一 runTransaction 内重调回调两次');
  for (const name of raw.getVisitedCollections()) assert.ok(name.startsWith(PREFIX));
});

test('S6.4 变异实际适配器后同一业务路径必须失败', async () => {
  const mapPath = path.join(BASE, 'collection-map.js');
  const original = fs.readFileSync(mapPath, 'utf8');
  const mutated = original.replace(
    /const view = Object\.freeze\(\{\s*collection\(logicalName\) \{\s*return wrapCollection\(rawTx, logicalName\);\s*\}\s*\}\);/,
    'const view = { collection(logicalName) { return rawTx.collection(logicalName); } };'
  );
  assert.notEqual(mutated, original, '未能注入事务映射变异（源码结构已变化）');
  const raw = seededDb();
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${mutated}\n})`)(
    name => (name === './collection-map' ? mod.exports : require(path.join(BASE, name))),
    mod, mod.exports);
  const broken = mod.exports.createSandboxDb(raw);
  let detected = false;
  try {
    await broken.runTransaction(async tx => { await tx.collection('users').doc(U.owner).get(); });
  } catch (error) {
    detected = error instanceof UnprefixedCollectionError || error.code === 'UNPREFIXED_COLLECTION_ACCESS';
  }
  assert.equal(detected, true, '事务映射被破坏后同一路径必须被检出');
});

// ===== T3：创建回放的状态与当前权限核验 =====

test('T3.1 回执在但项目已删除：停止而非宣称成功', async () => {
  const db = seededDb();
  const invoke = main(db, prepConfig());
  const payload = { action: 'createProject', requestId: 'r-del', name: '虚构测试 · 回放核验' };
  const first = await invoke(payload);
  assert.equal(first.ok, true);
  // 只删项目，保留回执
  await db.collection(PREFIX + 'projects').doc(first.projectId).remove();
  const replay = await invoke(payload);
  assert.notEqual(replay.ok, true, '项目不存在时不得报成功');
  assert.equal(replay.code, 'SANDBOX_PROJECT_STATE_CONFLICT', replay.code);
  assert.equal(countOf(db, 'projects'), 0, '不得重建项目覆盖损坏状态');
});

test('T3.2 并发回放同样重验当前权限：primary 已改绑则拒绝', async () => {
  const db = seededDb();
  const config = prepConfig();
  const original = db.runTransaction;
  let interposed = false;
  db.runTransaction = async work => {
    if (!interposed) {
      interposed = true;
      // 另一个请求先建好项目，并把 primary 改绑
      const winner = await main(db, config)({ action: 'createProject', requestId: 'winner', name: '虚构测试 · 回放核验' });
      assert.equal(winner.ok, true, '胜出请求应成功');
      await db.collection(PREFIX + 'app_admins').doc('primary').update({ data: { userId: U.manager } });
    }
    return original(work);
  };
  const loser = await main(db, config)({ action: 'createProject', requestId: 'loser', name: '虚构测试 · 回放核验' });
  assert.ok(interposed, '并发交错必须真的发生（否则本用例无效）');
  assert.equal(db.getData()[PREFIX + 'app_admins'].primary.userId, U.manager, 'primary 确实已改绑');
  assert.notEqual(loser.ok, true, '失权后并发回放不得报成功');
  assert.equal(loser.code, 'SANDBOX_NOT_PRIMARY_ADMIN', loser.code);
  assert.equal(countOf(db, 'projects'), 1, '只应有胜出请求建的一个项目');
});

test('T3.3 提交后回执读取失败：不得声称已整体回滚，同号可取回原结果', async () => {
  const db = seededDb();
  const invoke = main(db, prepConfig());
  const payload = { action: 'createProject', requestId: 'r-postcommit', name: '虚构测试 · 提交后读失败' };
  // 只在项目已存在（即事务已提交）时命中读失败
  db.failNextRead(PREFIX + 'schedule_receipts', 'doc.get', 'POST_COMMIT_READ_FAILED',
    () => countOf(db, 'projects') === 1);
  const failed = await invoke(payload);
  assert.notEqual(failed.ok, true);
  assert.equal(failed.code, 'SANDBOX_PROJECT_STATE_CONFLICT', failed.code);
  assert.doesNotMatch(failed.message, /已整体回滚/, '未确认回滚时不得声称已整体回滚');
  assert.doesNotMatch(failed.message, /事务未提交/, 'U4：未收到成功返回不等于未提交');
  assert.match(failed.message, /已收到事务成功返回/, '已确认成功返回时必须如实说明');
  assert.match(failed.message, /待核对|按同一请求编号重试/, '必须提示按原编号核对');
  assert.equal(countOf(db, 'projects'), 1, '项目确实已提交');
  assert.equal(countOf(db, 'schedule_receipts'), 1, '回执确实已提交');
  // 同号重试取回原结果，且不重复落库
  const replay = await invoke(payload);
  assert.equal(replay.ok, true, '同号重试应取回原结果：' + JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(countOf(db, 'projects'), 1, '不得重复落库');
  assert.equal(countOf(db, 'schedule_receipts'), 1, '不得重复落库');
});

test('T3.4 轮次记录字段/确定性 ID 不一致一律停止', async () => {
  const recordId = projectGuard.roundRecordId('sandbox-round-1');
  const projectId = projectGuard.roundProjectId('sandbox-round-1');
  const digest = projectGuard.inputDigest('虚构测试 · 轮次核验');
  const base = {
    _id: recordId, projectId, actorUserId: U.owner, roundId: 'sandbox-round-1',
    action: 'createProject', inputDigest: digest, requestId: 'r',
    result: { projectId }, createdAt: '2026-01-01T00:00:00.000Z'
  };
  const mutations = [
    ['roundId 不符', { roundId: 'another-round' }],
    ['action 不符', { action: 'somethingElse' }],
    ['projectId 与唯一键不符', { projectId: 'p_sbx_deadbeef' }],
    ['result 与唯一键不符', { result: { projectId: 'p_sbx_deadbeef' } }],
    ['主键不符', { _id: recordId + 'x' }]
  ];
  for (const [label, patch] of mutations) {
    const db = seededDb();
    await db.collection(PREFIX + 'projects').add({ data: { _id: projectId, name: '虚构测试', scope: 'identity-test', status: 'active', version: 1 } });
    await db.collection(PREFIX + 'schedule_receipts').add({ data: Object.assign({}, base, patch) });
    const result = await main(db, prepConfig())({ action: 'createProject', requestId: 'r', name: '虚构测试 · 轮次核验' });
    assert.notEqual(result.ok, true, label + ' 时不得报成功');
    assert.equal(result.code, 'SANDBOX_PROJECT_STATE_CONFLICT', label + ' 应停止：' + result.code);
  }
});

test('T3.5 正常已提交回放、失败后再试、同轮次换执行人唯一性', async () => {
  {
    const db = seededDb();
    const invoke = main(db, prepConfig());
    const payload = { action: 'createProject', requestId: 'r-ok', name: '虚构测试 · 正常回放' };
    const first = await invoke(payload);
    const replay = await invoke(payload);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.projectId, first.projectId);
    assert.equal(countOf(db, 'projects'), 1);
  }
  {
    const db = seededDb();
    const invoke = main(db, prepConfig());
    const payload = { action: 'createProject', requestId: 'r-retry', name: '虚构测试 · 失败后再试' };
    db.failNextWrite(PREFIX + 'schedule_receipts', 'add', 'INJECTED_RECEIPT_FAILURE');
    const failed = await invoke(payload);
    assert.notEqual(failed.ok, true);
    assert.equal(countOf(db, 'projects'), 0, '事务失败不得留下项目');
    const retry = await invoke(payload);
    assert.equal(retry.ok, true, '失败后再试应成功：' + JSON.stringify(retry));
    assert.equal(countOf(db, 'projects'), 1);
    assert.equal(countOf(db, 'schedule_receipts'), 1);
  }
  {
    const db = seededDb();
    const config = prepConfig();
    const payload = { action: 'createProject', requestId: 'r-same', name: '虚构测试 · 换执行人' };
    await main(db, config, 'owner')(payload);
    // 把 primary 改绑给 manager（仍是允许账号）
    await db.collection(PREFIX + 'app_admins').doc('primary').update({ data: { userId: U.manager } });
    const other = await main(db, config, 'manager')(Object.assign({}, payload, { requestId: 'r-same-2' }));
    assert.equal(other.ok, true, '换执行人后应回放原结果');
    assert.equal(other.replayed, true);
    assert.equal(countOf(db, 'projects'), 1, '一个轮次只允许一个项目');
    assert.equal(countOf(db, 'schedule_receipts'), 1);
  }
});

test('T3.6 范围解析与创建回放共享同一状态核验（currentRoundProjectId）', async () => {
  const db = seededDb();
  const invoke = main(db, prepConfig());
  const created = await invoke({ action: 'createProject', requestId: 'r-scope', name: '虚构测试 · 范围核验' });
  assert.equal(created.ok, true);
  const sdb = createSandboxDb(db);
  assert.equal(await projectGuard.currentRoundProjectId(sdb, 'sandbox-round-1'), created.projectId);
  // 记录被破坏：范围解析必须停止而不是返回未核验的 ID
  await db.collection(PREFIX + 'schedule_receipts')
    .doc(projectGuard.roundRecordId('sandbox-round-1'))
    .update({ data: { result: { projectId: 'p_sbx_wrong' } } });
  let stopped = null;
  try {
    await projectGuard.currentRoundProjectId(sdb, 'sandbox-round-1');
  } catch (error) {
    stopped = error;
  }
  assert.ok(stopped, '记录损坏时范围解析必须停止');
  assert.equal(stopped.code, 'SANDBOX_PROJECT_STATE_CONFLICT', stopped.code);
});

// ===== T5：事务替身未提交写入不可见 =====

test('T5.1 事务未提交的写入对事务外与其他事务不可见', async () => {
  let signal; let release;
  const reached = new Promise(r => { signal = r; });
  const resume = new Promise(r => { release = r; });
  const raw = createSandboxTestDb({}, { pauseBeforeCommit: async () => { signal(); await resume; } });
  await raw.collection(PREFIX + 'users').add({ data: { _id: 'u1', status: 'active' } });
  const db = createSandboxDb(raw);
  const tx = db.runTransaction(async t => {
    await t.collection('users').add({ data: { _id: 'u-uncommitted', status: 'draft' } });
  });
  await reached;
  // 事务外看不到
  assert.equal(raw.getData()[PREFIX + 'users']['u-uncommitted'], undefined, '未提交写入不得对事务外可见');
  const outsideRead = await raw.collection(PREFIX + 'users').doc('u-uncommitted').get();
  assert.equal(outsideRead.data, null, '事务外读取未提交记录必须为空');
  // 另一个事务也看不到
  let otherSaw = 'unset';
  await raw.runTransaction(async t => {
    otherSaw = (await t.collection(PREFIX + 'users').doc('u-uncommitted').get()).data;
  });
  assert.equal(otherSaw, null, '另一个事务不得看到未提交写入');
  // 写日志同样不含未提交写入
  assert.equal(raw.getWriteLog().some(w => w.key === 'u-uncommitted'), false, '未提交写入不得进全局写日志');
  release();
  await tx;
  // 提交后才可见
  assert.equal(raw.getData()[PREFIX + 'users']['u-uncommitted'].status, 'draft', '提交后应可见');
  assert.equal(raw.getWriteLog().some(w => w.key === 'u-uncommitted'), true, '提交后写日志才记录');
});

test('T5.2 一事务回滚不会让另一请求假成功（交错失败后他事务数据保留）', async () => {
  const db = seededDb();
  const config = prepConfig();
  const original = db.runTransaction;
  let signal; let release; let first = true;
  const reached = new Promise(r => { signal = r; });
  const resume = new Promise(r => { release = r; });
  // 第一个请求：事务跑完但停在提交前，然后失败
  db.runTransaction = work => original(async tx => {
    const result = await work(tx);
    if (first) { first = false; signal(); await resume; throw new Error('FAIL_BEFORE_COMMIT'); }
    return result;
  });
  const payload = { action: 'createProject', requestId: 'same', name: '虚构测试 · 交错' };
  const failing = main(db, config)(payload);
  await reached;
  // 交错窗口内：第二请求既读不到未提交回执，也建不了同轮次项目
  const second = await main(db, config)(payload);
  release();
  const failed = await failing;
  assert.equal(failed.ok, false, '第一个请求应失败');
  assert.equal(second.ok, true, '第二个请求在无回执时应能自己建立项目');
  assert.equal(second.replayed, false, '第二个请求不得声称回放了不存在的记录');
  assert.equal(countOf(db, 'projects'), 1, '失败事务不得留下项目，最终只应有第二个请求建的');
  assert.equal(countOf(db, 'schedule_receipts'), 1, '回执只应有第二个请求写的');
});

test('T5.3 事务失败只丢弃本 attempt 写集，不回滚他事务数据与写日志', async () => {
  let signal; let release;
  const reached = new Promise(r => { signal = r; });
  const resume = new Promise(r => { release = r; });
  let injected = false;
  const raw = createSandboxTestDb({}, {
    barrier: async current => {
      if (current === 0 && !injected) { injected = true; signal(); await resume; }
    }
  });
  await raw.collection(PREFIX + 'users').add({ data: { _id: 'u1', status: 'active' } });
  const db = createSandboxDb(raw);
  // 事务 A：attempt 0 在提交前暂停，随后会被冲突拒绝
  const txA = raw.runTransaction(async tx => {
    await tx.collection(PREFIX + 'users').add({ data: { _id: 'from-A', status: 'a' } });
  });
  await reached;
  // 事务 B 在 A 暂停期间提交
  await raw.runTransaction(async tx => {
    await tx.collection(PREFIX + 'users').add({ data: { _id: 'from-B', status: 'b' } });
  });
  release();
  await txA;
  const users = raw.getData()[PREFIX + 'users'];
  assert.ok(injected, '屏障必须命中（否则本用例无效）');
  assert.equal(users['from-B'].status, 'b', 'B 的提交必须保留');
  assert.ok(users['from-A'], 'A 重试成功后写入应生效');
  // 写日志必须同时包含两者（未被全局截断）
  const keys = raw.getWriteLog().filter(w => w.op === 'add').map(w => w.key);
  assert.ok(keys.includes('from-A') && keys.includes('from-B'), '写日志应保留两事务的记录：' + keys.join(','));
  // A 的 attempt 0 写入不得重复出现在日志里
  assert.equal(keys.filter(k => k === 'from-A').length, 1, '被丢弃的 attempt 写入不得留在日志里');
});

test('T5.4 并发成功必须看到已提交回执；双方都先看到无回执再竞争', async () => {
  const db = seededDb();
  const config = prepConfig();
  const payload = { action: 'createProject', requestId: 'race', name: '虚构测试 · 并发竞争' };
  const results = await Promise.all([
    main(db, config)(payload),
    main(db, config)(Object.assign({}, payload, { requestId: 'race-2' }))
  ]);
  const a = results[0];
  const b = results[1];
  assert.equal(a.ok, true, 'A 应成功：' + JSON.stringify(a));
  assert.equal(b.ok, true, 'B 应成功：' + JSON.stringify(b));
  assert.equal(a.projectId, b.projectId, '并发必须得到同一项目');
  assert.equal(countOf(db, 'projects'), 1, '只应有一个项目');
  assert.equal(countOf(db, 'schedule_receipts'), 1, '只应有一条唯一记录');
  // 首次方 replayed=false，回放方 replayed=true
  assert.equal(a.replayed !== b.replayed, true, '必须恰好一方是回放');
});

test('T5.5 SDK 冲突重入后 enlist 写入仍与业务同事务提交', async () => {
  const raw = seededDb();
  const inner = raw.runTransaction;
  let attempt = 0;
  raw.runTransaction = work => {
    const wrapped = async tx => {
      attempt++;
      if (attempt === 1) {
        await work(tx);
        throw Object.assign(new Error('模拟 SDK 冲突'), { code: 'TRANSACTION_CONFLICT' });
      }
      return work(tx);
    };
    return inner(wrapped);
  };
  const result = await main(raw, prepConfig())({
    action: 'createProject', requestId: 'reentry', name: '虚构测试 · 重入'
  });
  assert.equal(result.ok, true, '重入后应成功：' + JSON.stringify(result));
  assert.ok(attempt >= 2, '应真的发生过重入');
  assert.equal(countOf(raw, 'schedule_receipts'), 1, '唯一记录必须只写一次');
  assert.equal(countOf(raw, 'projects'), 1);
});

// ===== U4：未收到事务成功返回，不等于事务未提交 =====

test('U4.1 提交确认响应丢失：不得断言未提交，同号可取回已提交结果', async () => {
  const db = seededDb();
  const config = prepConfig();
  const original = db.runTransaction;
  let once = true;
  // 真实创建事务**已提交**，随后 SDK 替身抛"提交响应丢失"。
  // 这只模拟该故障边界，不冒称 CloudBase 已实测。
  db.runTransaction = async work => {
    const out = await original(work);
    if (once) { once = false; throw new Error('SDK_RESPONSE_LOST_AFTER_COMMIT'); }
    return out;
  };
  const payload = { action: 'createProject', requestId: 'u4-ack', name: '虚构测试 · 提交响应丢失' };
  const result = await main(db, config)(payload);
  assert.notEqual(result.ok, true, '响应丢失时不得报成功');
  assert.equal(result.code, 'SANDBOX_PROJECT_CREATE_FAILED', result.code);
  assert.doesNotMatch(result.message, /事务未提交/, 'U4：未收到成功返回不等于未提交');
  assert.doesNotMatch(result.message, /未留下半套状态/, '不得断言未留下半套状态');
  assert.match(result.message, /未确认|待核对|按同一请求编号重试/, '必须按"结果未确认"表述并提示核对');
  // 实际已提交
  assert.equal(countOf(db, 'projects'), 1, '项目确实已提交');
  assert.equal(countOf(db, 'schedule_receipts'), 1, '回执确实已提交');
  // 同号重试取回已提交结果，且不重复落库
  const retry = await main(db, config)(payload);
  assert.equal(retry.ok, true, '同号重试应取回已提交结果：' + JSON.stringify(retry));
  assert.equal(retry.replayed, true);
  assert.equal(countOf(db, 'projects'), 1, '不得重复创建');
  assert.equal(countOf(db, 'schedule_receipts'), 1, '不得重复写回执');
});

test('U4.2 事务内明确失败：说明事实且不谎称已提交', async () => {
  const db = seededDb();
  const invoke = main(db, prepConfig());
  const payload = { action: 'createProject', requestId: 'u4-fail', name: '虚构测试 · 事务内失败' };
  // 在真实事务写入时注入失败
  db.failNextWrite(PREFIX + 'projects', 'add', 'INJECTED_PROJECT_WRITE_FAILURE');
  const failed = await invoke(payload);
  assert.notEqual(failed.ok, true);
  // 措辞里的"可能已提交"是诚实的不确定性表述；不得断言"已提交/未提交"
  assert.doesNotMatch(failed.message, /事务已提交|事务未提交/, '不得断言提交与否');
  assert.match(failed.message, /未确认|按同一请求编号重试/, '必须按"结果未确认"表述');
  assert.equal(countOf(db, 'projects'), 0, '事务失败不得留下项目');
  assert.equal(countOf(db, 'schedule_receipts'), 0, '事务失败不得留下回执');
  const retry = await invoke(payload);
  assert.equal(retry.ok, true, '失败后再试应成功：' + JSON.stringify(retry));
  assert.equal(countOf(db, 'projects'), 1);
});

test('U4.3 提交后读失败仍正确说明"已收到成功返回"', async () => {
  const db = seededDb();
  const invoke = main(db, prepConfig());
  const payload = { action: 'createProject', requestId: 'u4-post', name: '虚构测试 · 提交后读失败' };
  db.failNextRead(PREFIX + 'schedule_receipts', 'doc.get', 'POST_COMMIT_READ_FAILED',
    () => countOf(db, 'projects') === 1);
  const failed = await invoke(payload);
  assert.notEqual(failed.ok, true);
  assert.equal(failed.code, 'SANDBOX_PROJECT_STATE_CONFLICT', failed.code);
  assert.match(failed.message, /已收到事务成功返回/, '已确认成功时必须如实说明');
  assert.match(failed.message, /按同一请求编号重试/, '必须提示按原编号重试');
  assert.equal(countOf(db, 'projects'), 1);
  assert.equal(countOf(db, 'schedule_receipts'), 1);
});

test('U4.4 三种情形分别说明事实，均不出现"未提交/已整体回滚"的断言', async () => {
  const messages = {};
  {
    const db = seededDb();
    db.failNextRead(PREFIX + 'schedule_receipts', 'doc.get', 'POST_COMMIT_READ_FAILED',
      () => countOf(db, 'projects') === 1);
    messages.postCommitRead = (await main(db, prepConfig())({
      action: 'createProject', requestId: 'u4-a', name: '虚构测试 · 提交后读失败'
    })).message;
  }
  {
    const db = seededDb();
    const original = db.runTransaction;
    let once = true;
    db.runTransaction = async work => {
      const out = await original(work);
      if (once) { once = false; throw new Error('SDK_RESPONSE_LOST_AFTER_COMMIT'); }
      return out;
    };
    messages.ackLost = (await main(db, prepConfig())({
      action: 'createProject', requestId: 'u4-b', name: '虚构测试 · 响应丢失'
    })).message;
  }
  {
    const db = seededDb();
    db.failNextWrite(PREFIX + 'projects', 'add', 'INJECTED_PROJECT_WRITE_FAILURE');
    messages.txFailed = (await main(db, prepConfig())({
      action: 'createProject', requestId: 'u4-c', name: '虚构测试 · 事务内失败'
    })).message;
  }
  for (const [label, message] of Object.entries(messages)) {
    assert.ok(typeof message === 'string' && message, label + ' 必须有说明');
    assert.doesNotMatch(message, /事务未提交/, label + ' 不得断言未提交');
    assert.doesNotMatch(message, /已整体回滚/, label + ' 不得断言已整体回滚');
  }
  assert.match(messages.postCommitRead, /已收到事务成功返回/, '提交后读失败必须说明已收到成功返回');
  assert.match(messages.ackLost, /未收到事务成功返回/, '响应丢失必须说明未收到成功返回');
  assert.match(messages.txFailed, /未收到事务成功返回/, '事务内失败同样不推断提交状态');
  // 三条文案互不相同（分别说明不同事实）
  assert.equal(new Set(Object.values(messages)).size, 3, '三种情形应分别说明各自的事实');
});

test('U4.5 响应丢失不触发重复创建，也不改动创建协议', async () => {
  // 同号重试走的是既有回放路径，不新增任何"补偿创建"分支
  const db = seededDb();
  const config = prepConfig();
  const original = db.runTransaction;
  let once = true;
  db.runTransaction = async work => {
    const out = await original(work);
    if (once) { once = false; throw new Error('SDK_RESPONSE_LOST_AFTER_COMMIT'); }
    return out;
  };
  const payload = { action: 'createProject', requestId: 'u4-idem', name: '虚构测试 · 响应丢失幂等' };
  await main(db, config)(payload);
  for (let i = 0; i < 3; i++) {
    const again = await main(db, config)(Object.assign({}, payload, { requestId: 'u4-idem-' + i }));
    assert.equal(again.ok, true, '换号重试也应回放原结果');
    assert.equal(again.replayed, true);
  }
  assert.equal(countOf(db, 'projects'), 1, '无论重试几次都只有一个项目');
  assert.equal(countOf(db, 'schedule_receipts'), 1, '无论重试几次都只有一条唯一记录');
  // 协议未变：仍是 enlist 同事务
  const guardSrc = fs.readFileSync(path.join(BASE, 'project-guard.js'), 'utf8');
  assert.ok(guardSrc.includes('db.enlist'), '仍使用 enlist 同事务提交');
  assert.ok(!/补偿|forceCreate|repairCreate/.test(guardSrc), '不得引入补偿性重建分支');
});
