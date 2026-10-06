const test = require('node:test');
const assert = require('node:assert/strict');
const { bindingDigest } = require('../miniprogram/utils/binding-digest');
const { createConcurrentApprovalProbe } = require('../miniprogram/utils/concurrent-approval-probe');

const number = '1234567890'; // 合成测试编号，不是用户凭据。
const managerId = 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d';
const applicantId = 'u_a2acfbaea35f409671860b2c4b13d777a6989a74';
const projectId = 'p_38507fc9b43c4e23a7fbd996415637bb';
const memberId = 'm_4312a8548b3a432854ade093290e72c6ed5a6f7f';
const invitationId = 'i_0e0483488efb40ada6825d259ebc1736';

function makeProof(overrides = {}) {
  const base = { evidenceId: 'synthetic-concurrent', projectId, actorId: managerId,
    applicantUserId: applicantId, memberId, invitationId, issuedByUserId: managerId,
    role: '师傅', trades: ['拆改'], status: 'requested',
    invitationExpiresAt: '2026-10-07T12:20:14.221Z',
    verifiedAt: '2026-09-30T12:00:00Z', checkBefore: '2026-09-30T13:00:00Z',
    bindingProof: { evidenceId: 'synthetic-binding', userId: applicantId,
      digest: bindingDigest(number), verifiedAt: '2026-09-30T11:59:00Z',
      expiresAt: '2026-09-30T13:00:00Z', checkBefore: '2026-09-30T13:00:00Z' } };
  return { ...base, ...overrides, bindingProof: { ...base.bindingProof, ...(overrides.bindingProof || {}) } };
}

const now = Date.parse('2026-09-30T12:30:00Z');
const membersAccess = { project: { id: projectId, scope: 'identity-test', status: 'active', roles: ['管家'] },
  members: [{ id: memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] };
const invitationsList = { invitations: [{ id: invitationId, role: '师傅', trades: ['拆改'], applicantLabel: '成员 989a74' }] };

function fixture(overrides = {}) {
  const calls = [];
  const call = async (action, input) => {
    calls.push({ action, input });
    if (overrides[action]) return overrides[action](input, calls);
    if (action === 'identify') return { userId: managerId, isAdmin: false };
    if (action === 'getMembers') return membersAccess;
    if (action === 'listInvitations') return invitationsList;
    throw Object.assign(new Error('仅项目管家可管理成员。'), { businessCode: 'NO_ACCESS' });
  };
  return { call, calls };
}

function storageWith(marker) {
  const store = marker === undefined ? {} : { 'yf-concurrent-approval-synthetic-concurrent': marker };
  return { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function withTimeout(ms, promise) {
  return Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('测试超时')), ms))]);
}

async function waitFor(condition, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('等待条件未满足');
}

test('默认禁用或凭据不完整时不发送任何请求', async () => {
  for (const proof of [
    makeProof({ enabled: false }),
    makeProof({ enabled: true, evidenceId: '' }),
    makeProof({ enabled: true, projectId: '' }),
    makeProof({ enabled: true, actorId: '' }),
    makeProof({ enabled: true, bindingProof: { evidenceId: '' } }),
    makeProof({ enabled: true, bindingProof: { digest: '' } })
  ]) {
    const { call, calls } = fixture();
    const report = await createConcurrentApprovalProbe(proof).run(call, number, storageWith(), () => now);
    assert.equal(report.complete, false, `expected incomplete for ${JSON.stringify(proof).slice(0, 80)}`);
    assert.equal(calls.length, 0);
  }
});

test('错编号、错身份归属、错成员或邀请、过期及未来核验不发送请求', async () => {
  const base = makeProof({ enabled: true });
  for (const [p, input, time] of [
    [base, '9999999999', now],
    [base, '', now],
    [{ ...base, actorId: 'u_other' }, number, now],
    [{ ...base, applicantUserId: 'u_other' }, number, now],
    [{ ...base, invitationId: 'i_other' }, number, now],
    [{ ...base, role: '设计师' }, number, now],
    [{ ...base, trades: ['木工'] }, number, now],
    [{ ...base, status: 'approved' }, number, now],
    [{ ...base, invitationExpiresAt: new Date(now).toISOString() }, number, now],
    [base, number, Date.parse(base.checkBefore)],
    [base, number, Date.parse(base.verifiedAt) - 1],
    [{ ...base, bindingProof: { ...base.bindingProof, expiresAt: new Date(now).toISOString() } }, number, now]
  ]) {
    const { call, calls } = fixture();
    const report = await createConcurrentApprovalProbe(p).run(call, input, storageWith(), () => time);
    assert.equal(report.complete, false);
    assert.equal(calls.length, 0);
    if (input) assert.equal(JSON.stringify(report).includes(input), false);
  }
});

test('非管家账号、项目角色不符、成员工种变化及目标邀请不符均不发送批准请求', async () => {
  const base = makeProof({ enabled: true });
  for (const overrides of [
    { identify: () => ({ userId: 'u_other', isAdmin: false }) },
    { identify: () => ({ userId: managerId, isAdmin: true }) },
    { getMembers: () => ({ project: { ...membersAccess.project, roles: ['管家', '主业主'] }, members: membersAccess.members }) },
    { getMembers: () => ({ ...membersAccess, members: [{ ...membersAccess.members[0], trades: ['木工'] }] }) },
    { getMembers: () => ({ ...membersAccess, members: [] }) },
    { listInvitations: () => ({ invitations: [{ id: invitationId, role: '师傅', trades: ['拆改'], applicantLabel: '成员 其他' }] }) },
    { listInvitations: () => ({ invitations: [{ id: invitationId, role: '设计师', trades: [], applicantLabel: '成员 989a74' }] }) }
  ]) {
    const { call, calls } = fixture(overrides);
    assert.equal((await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now)).complete, false);
    assert.ok(calls.every(row => row.action !== 'approveInvitation'));
  }
});

test('一次执行同时发送两个参数相同的 approveInvitation', async () => {
  const base = makeProof({ enabled: true });
  const d1 = deferred();
  const d2 = deferred();
  let startedCount = 0;
  const { call, calls } = fixture({ approveInvitation: () => {
    startedCount++;
    if (startedCount === 1) return d1.promise;
    return d2.promise;
  } });
  const running = withTimeout(2000, createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now));
  await waitFor(() => calls.filter(c => c.action === 'approveInvitation').length === 2, 1000);
  assert.equal(startedCount, 2, '两条请求都应已启动');
  const approvals = calls.filter(c => c.action === 'approveInvitation');
  assert.deepEqual(approvals[0].input, approvals[1].input);
  assert.deepEqual(approvals[0].input, { projectId, invitationId, applicantNumber: number });
  d1.resolve({ invitationId, status: 'approved' });
  d2.resolve({ invitationId, status: 'approved' });
  const report = await running;
  assert.equal(report.complete, false, '两成功应停止');
  assert.equal(report.results.filter(row => row.status === 'success').length, 2);
  assert.equal(JSON.stringify(report).includes(number), false);
});

test('一次成功、一次 CODE_INVALID 后目标消失，输出候选和事后观察', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let afterCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) return { invitationId, status: 'approved' };
      throw Object.assign(new Error('邀请未待核对或编号已失效。'), { businessCode: 'CODE_INVALID' });
    },
    listInvitations: () => {
      afterCalls++;
      if (afterCalls > 1) return { invitations: [] }; // 批准后目标从待核对列表消失
      return invitationsList;
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, true);
  assert.equal(report.results.filter(row => row.status === 'success').length, 1);
  assert.equal(report.results.filter(row => row.status === 'business_denied' && row.code === 'CODE_INVALID').length, 1);
  assert.equal(report.candidate.summary, '一次成功、一次业务拒绝');
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
  assert.ok(calls.some(row => row.action === 'getMembers' && calls.indexOf(row) < calls.findIndex(c => c.action === 'approveInvitation')));
  assert.ok(report.after && report.after.member.memberId === memberId);
  assert.deepEqual(report.after.invitations, []);
  assert.equal(report.after.targetRemoved, true);
});

test('零成功、超时或未知异常停止，不将 inconclusive 计为已拒绝', async () => {
  const base = makeProof({ enabled: true });
  for (const approveInvitation of [
    () => { throw Object.assign(new Error('网络超时'), { businessCode: 'NETWORK_ERROR' }); },
    () => { throw Object.assign(new Error('事务冲突'), { businessCode: 'TRANSACTION_CONFLICT' }); },
    () => { throw new Error('结果丢失: ' + number); },
    () => { throw Object.assign(new Error(number), { businessCode: 'CODE_INVALID' }); }
  ]) {
    const { call, calls } = fixture({ approveInvitation });
    const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
    assert.equal(report.complete, false);
    const approvals = calls.filter(row => row.action === 'approveInvitation');
    assert.equal(approvals.length, 2);
    if (approveInvitation.toString().includes('CODE_INVALID')) {
      // 两次都是业务拒绝 => 零成功
      assert.equal(report.results.filter(row => row.status === 'success').length, 0);
    } else {
      assert.ok(report.results.every(row => row.status === 'inconclusive'));
    }
    assert.equal(JSON.stringify(report).includes(number), false);
  }
});

test('无效批准响应不计为成功：undefined、空对象、错ID、错status', async () => {
  const base = makeProof({ enabled: true });
  for (const [label, response] of [
    ['undefined', undefined],
    ['null', null],
    ['空对象', {}],
    ['缺少status', { invitationId }],
    ['缺少invitationId', { status: 'approved' }],
    ['错 invitationId', { invitationId: 'i_other', status: 'approved' }],
    ['非 approved 状态', { invitationId, status: 'requested' }],
    ['未知状态', { invitationId, status: 'rejected' }]
  ]) {
    const { call, calls } = fixture({ approveInvitation: () => response });
    const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
    assert.equal(report.complete, false, label);
    assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
    assert.equal(report.results.filter(row => row.status === 'success').length, 0, label);
    assert.ok(report.results.every(row => row.status === 'inconclusive'), label);
  }
});

test('单成功配未知结果时不产生候选且 complete 为 false', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  const { call, calls } = fixture({ approveInvitation: () => {
    callIndex++;
    if (callIndex === 1) return { invitationId, status: 'approved' };
    throw Object.assign(new Error('任意底层内容 ' + number), { businessCode: 'UNKNOWN_CODE' });
  } });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(report.results.filter(row => row.status === 'success').length, 1);
  assert.equal(report.results.filter(row => row.status === 'inconclusive').length, 1);
  assert.equal(report.candidate, null);
  assert.equal(JSON.stringify(report).includes('UNKNOWN_CODE'), false);
  assert.equal(JSON.stringify(report).includes(number), false);
});

test('两条结果顺序互换仍识别一次成功一次业务拒绝', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let afterCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) throw Object.assign(new Error('邀请未待核对或编号已失效。'), { businessCode: 'CODE_INVALID' });
      return { invitationId, status: 'approved' };
    },
    listInvitations: () => {
      afterCalls++;
      if (afterCalls > 1) return { invitations: [] };
      return invitationsList;
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, true);
  assert.equal(report.results.filter(row => row.status === 'success').length, 1);
  assert.equal(report.results.filter(row => row.status === 'business_denied').length, 1);
  assert.equal(report.candidate.summary, '一次成功、一次业务拒绝');
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
  assert.equal(report.after.targetRemoved, true);
});

test('存储读取失败或已有标记时不发送批准请求', async () => {
  const base = makeProof({ enabled: true });
  const { call: call1, calls: calls1 } = fixture();
  const report1 = await createConcurrentApprovalProbe(base).run(call1, number,
    { get: () => { throw new Error('storage read failure'); }, set: () => {} }, () => now);
  assert.equal(report1.complete, false);
  assert.equal(report1.stoppedReason, '本机防重标记读取失败，未发送批准请求。');
  assert.equal(calls1.filter(row => row.action === 'approveInvitation').length, 0);

  const { call: call2, calls: calls2 } = fixture();
  const report2 = await createConcurrentApprovalProbe(base).run(call2, number,
    storageWith({ started: true }), () => now);
  assert.equal(report2.complete, false);
  assert.equal(calls2.filter(row => row.action === 'approveInvitation').length, 0);
});

test('存储失败时不发送批准请求', async () => {
  const base = makeProof({ enabled: true });
  const { call, calls } = fixture();
  const report = await createConcurrentApprovalProbe(base).run(call, number,
    { get: () => {}, set: () => { throw new Error('storage failure'); } }, () => now);
  assert.equal(report.complete, false);
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 0);
});

test('同一探针实例先后调用只发送一次并发对', async () => {
  const base = makeProof({ enabled: true });
  const store = {};
  const storage = { get: k => store[k], set: (k, v) => { store[k] = v; } };
  const { call: call1, calls: calls1 } = fixture({ approveInvitation: () => ({ invitationId, status: 'approved' }) });
  const probe = createConcurrentApprovalProbe(base);
  const report1 = await probe.run(call1, number, storage, () => now);
  assert.equal(report1.complete, false);
  assert.equal(calls1.filter(row => row.action === 'approveInvitation').length, 2);

  const { call: call2, calls: calls2 } = fixture();
  const report2 = await probe.run(call2, number, storage, () => now);
  assert.equal(report2.complete, false);
  assert.equal(calls2.filter(row => row.action === 'approveInvitation').length, 0);
});

test('同实例重入和跨存储标记均不追加请求', async () => {
  const base = makeProof({ enabled: true });
  const store = {};
  const storage = { get: k => store[k], set: (k, v) => { store[k] = v; } };
  const { call: call1, calls: calls1 } = fixture({ approveInvitation: () => ({ invitationId, status: 'approved' }) });
  const probe = createConcurrentApprovalProbe(base);
  await probe.run(call1, number, storage, () => now);
  assert.equal(calls1.filter(row => row.action === 'approveInvitation').length, 2);

  const { call: call2, calls: calls2 } = fixture();
  const report2 = await probe.run(call2, number, storage, () => now);
  assert.equal(report2.complete, false);
  assert.equal(calls2.filter(row => row.action === 'approveInvitation').length, 0);

  const { call: call3, calls: calls3 } = fixture();
  const freshStore = { 'yf-concurrent-approval-synthetic-concurrent': { started: true } };
  const report3 = await createConcurrentApprovalProbe(base).run(call3, number,
    { get: k => freshStore[k], set: () => {} }, () => now);
  assert.equal(report3.complete, false);
  assert.equal(calls3.filter(row => row.action === 'approveInvitation').length, 0);
});

test('后置只读观察失败不重发写入请求且错误不含编号，未知码置空', async () => {
  const base = makeProof({ enabled: true });
  let afterCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: (input, list) => {
      if (list.filter(row => row.action === 'approveInvitation').length === 1) return { invitationId, status: 'approved' };
      throw Object.assign(new Error('邀请未待核对或编号已失效。'), { businessCode: 'CODE_INVALID' });
    },
    listInvitations: () => {
      afterCalls++;
      if (afterCalls > 1) throw Object.assign(new Error('after read failed ' + number), { businessCode: 'UNKNOWN_AFTER' });
      return invitationsList;
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, true);
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
  assert.ok(report.afterReadError);
  assert.equal(report.afterReadError.message, '事后只读观察失败，请核对云端，不要重试。');
  assert.equal(report.afterReadError.code, '');
  assert.equal(JSON.stringify(report).includes('UNKNOWN_AFTER'), false);
  assert.equal(JSON.stringify(report).includes(number), false);
});

test('后置 listInvitations 缺少 invitations 字段不视为申请消失', async () => {
  const base = makeProof({ enabled: true });
  let afterCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: (input, list) => {
      if (list.filter(row => row.action === 'approveInvitation').length === 1) return { invitationId, status: 'approved' };
      throw Object.assign(new Error('邀请未待核对或编号已失效。'), { businessCode: 'CODE_INVALID' });
    },
    listInvitations: () => {
      afterCalls++;
      if (afterCalls > 1) return { badField: [] }; // 缺少 invitations
      return invitationsList;
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
  assert.equal(report.after, null);
  assert.equal(report.stoppedReason, '待核对申请列表响应无效，已停止。');
});

test('一成功一拒绝后只剩其他合法待申请仍完整输出候选', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let afterCalls = 0;
  const otherInvitation = { id: 'i_other', role: '师傅', trades: ['拆改'], applicantLabel: '成员 其他' };
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) return { invitationId, status: 'approved' };
      throw Object.assign(new Error('邀请未待核对或编号已失效。'), { businessCode: 'CODE_INVALID' });
    },
    listInvitations: () => {
      afterCalls++;
      if (afterCalls > 1) return { invitations: [otherInvitation] };
      return invitationsList;
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, true);
  assert.equal(report.results.filter(row => row.status === 'success').length, 1);
  assert.equal(report.results.filter(row => row.status === 'business_denied').length, 1);
  assert.equal(report.candidate.summary, '一次成功、一次业务拒绝');
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
  assert.equal(report.after.invitations.length, 1);
  assert.equal(report.after.invitations[0].id, 'i_other');
  assert.equal(report.after.targetRemoved, true);
});

test('一成功一拒绝后目标仍在待核对列表则标记矛盾并停止', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) return { invitationId, status: 'approved' };
      throw Object.assign(new Error('邀请未待核对或编号已失效。'), { businessCode: 'CODE_INVALID' });
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(report.results.filter(row => row.status === 'success').length, 1);
  assert.equal(report.results.filter(row => row.status === 'business_denied').length, 1);
  assert.equal(report.candidate.summary, '一次成功、一次业务拒绝');
  assert.equal(report.stoppedReason, '目标申请仍在待核对列表，与一次成功的结果矛盾，已停止。');
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
});

test('后置 listInvitations 返回非数组时停止且不视为消失', async () => {
  const base = makeProof({ enabled: true });
  let afterCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: (input, list) => {
      if (list.filter(row => row.action === 'approveInvitation').length === 1) return { invitationId, status: 'approved' };
      throw Object.assign(new Error('邀请未待核对或编号已失效。'), { businessCode: 'CODE_INVALID' });
    },
    listInvitations: () => {
      afterCalls++;
      if (afterCalls > 1) return { invitations: 'not-an-array' };
      return invitationsList;
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
  assert.equal(report.after, null);
  assert.equal(report.stoppedReason, '待核对申请列表响应无效，已停止。');
});

test('后置读取未知错误码及重复合成编号不泄露到报告', async () => {
  const base = makeProof({ enabled: true });
  const repeated = number + number;
  let afterCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: (input, list) => {
      if (list.filter(row => row.action === 'approveInvitation').length === 1) return { invitationId, status: 'approved' };
      throw Object.assign(new Error('邀请未待核对或编号已失效。'), { businessCode: 'CODE_INVALID' });
    },
    listInvitations: () => {
      afterCalls++;
      if (afterCalls > 1) throw Object.assign(new Error('raw after failure ' + repeated + ' body ' + number),
        { businessCode: 'UNEXPECTED_AFTER_' + number });
      return invitationsList;
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, true);
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
  assert.ok(report.afterReadError);
  assert.equal(report.afterReadError.message, '事后只读观察失败，请核对云端，不要重试。');
  assert.equal(report.afterReadError.code, '');
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(number), false);
  assert.equal(serialized.includes('UNEXPECTED_AFTER'), false);
  assert.equal(serialized.includes('raw after failure'), false);
});

test('报告和错误摘要不泄露原始编号或任意请求内容', async () => {
  const base = makeProof({ enabled: true });
  const repeated = number + number;
  const { call, calls } = fixture({
    approveInvitation: () => {
      throw Object.assign(new Error('raw response: ' + repeated + ' body: ' + number),
        { businessCode: 'UNEXPECTED_ERROR' });
    }
  });
  const report = await createConcurrentApprovalProbe(base).run(call, number, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 2);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(number), false);
  assert.equal(serialized.includes('UNEXPECTED_ERROR'), false);
  assert.equal(serialized.includes('raw response'), false);
  assert.ok(report.results.every(row => row.code === ''));
});
