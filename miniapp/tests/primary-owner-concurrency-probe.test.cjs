const test = require('node:test');
const assert = require('node:assert/strict');
const { bindingDigest } = require('../miniprogram/utils/binding-digest');
const { sha256Hex } = require('../miniprogram/utils/sha256-hex');
const { createPrimaryOwnerConcurrencyProbe } = require('../miniprogram/utils/primary-owner-concurrency-probe');

const numberA = '1234567890';
const numberB = '0987654321';
const digestA = bindingDigest(numberA);
const digestB = bindingDigest(numberB);

const managerId = 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d';
const ownerId = 'u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4';
const applicantA = 'u_a2acfbaea35f409671860b2c4b13d777a6989a74';
const applicantB = 'u_15703f790f293a33c184af9eb0b8db9852f182f4';
const projectId = 'p_owner_concurrency_c';
const invitationA = 'i_owner_concurrency_a';
const invitationB = 'i_owner_concurrency_b';

function memberId(userId) { return 'm_' + sha256Hex(`${projectId}:${userId}`).slice(0, 40); }
function labelFor(userId) { return `成员 ${userId.slice(-6)}`; }

const ownerMemberId = memberId(ownerId);
const managerMemberId = memberId(managerId);
const memberA = memberId(applicantA);
const memberB = memberId(applicantB);

function bindingProof(userId, digest) {
  return {
    evidenceId: 'binding-' + userId.slice(-6),
    userId,
    digest,
    expiresAt: '2026-09-30T13:00:00Z',
    verifiedAt: '2026-09-30T11:00:00Z',
    checkBefore: '2026-09-30T13:00:00Z'
  };
}

function candidate(label, applicant, invitation, digest) {
  return {
    label,
    invitationId: invitation,
    applicantUserId: applicant,
    expectedMemberId: memberId(applicant),
    role: '主业主',
    trades: [],
    status: 'requested',
    invitationVersion: 2,
    invitationExpiresAt: '2026-09-30T13:00:00Z',
    issuedByUserId: managerId,
    bindingProof: bindingProof(applicant, digest)
  };
}

function makeProof(overrides = {}) {
  const base = {
    enabled: true,
    evidenceId: 'synthetic-poc',
    appId: 'wxfb4db1615ac15531',
    envId: 'cloud1-d8gcq5ag39d847723',
    projectId,
    projectName: '虚构测试 · 主业主并发唯一性',
    projectScope: 'identity-test',
    projectVersion: 1,
    actorId: managerId,
    baselineAt: '2026-09-30T12:00:00Z',
    verifiedAt: '2026-09-30T11:00:00Z',
    checkBefore: '2026-09-30T13:00:00Z',
    primaryOwnerUserId: '',
    expectedMembers: [
      { userId: ownerId, memberId: ownerMemberId, roles: ['负责人'], trades: [] },
      { userId: managerId, memberId: managerMemberId, roles: ['管家'], trades: [] }
    ],
    candidates: [
      candidate('候选甲', applicantA, invitationA, digestA),
      candidate('候选乙', applicantB, invitationB, digestB)
    ]
  };
  if (overrides.candidates) {
    return { ...base, ...overrides };
  }
  return { ...base, ...overrides };
}

const now = Date.parse('2026-09-30T12:30:00Z');

function projectAccess() {
  return {
    project: {
      id: projectId,
      name: '虚构测试 · 主业主并发唯一性',
      scope: 'identity-test',
      status: 'active',
      roles: ['管家']
    },
    members: [
      { id: ownerMemberId, userId: ownerId, label: labelFor(ownerId), roles: ['负责人'], trades: [], joinedAt: '2026-09-30T10:00:00Z' },
      { id: managerMemberId, userId: managerId, label: labelFor(managerId), roles: ['管家'], trades: [], joinedAt: '2026-09-30T10:00:00Z' }
    ]
  };
}

function invitationsList(extra = []) {
  return {
    invitations: [
      { id: invitationA, role: '主业主', trades: [], applicantLabel: labelFor(applicantA), requestedAt: '2026-09-30T11:30:00Z' },
      { id: invitationB, role: '主业主', trades: [], applicantLabel: labelFor(applicantB), requestedAt: '2026-09-30T11:31:00Z' }
    ].concat(extra)
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const call = async (action, input) => {
    calls.push({ action, input });
    if (overrides[action]) return overrides[action](input, calls);
    if (action === 'identify') return { userId: managerId, isAdmin: false };
    if (action === 'getMembers') return projectAccess();
    if (action === 'listInvitations') return invitationsList();
    throw Object.assign(new Error('权限拒绝。'), { businessCode: 'NO_ACCESS' });
  };
  return { call, calls };
}

function storageWith(marker) {
  const store = marker === undefined ? {} : { 'yf-primary-owner-concurrency-synthetic-poc': marker };
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

function assertNoRawNumbers(report) {
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(numberA), false);
  assert.equal(serialized.includes(numberB), false);
}

test('默认禁用或凭据不完整时不发送任何请求', async () => {
  for (const proof of [
    makeProof({ enabled: false }),
    makeProof({ enabled: true, evidenceId: '' }),
    makeProof({ enabled: true, projectId: '' }),
    makeProof({ enabled: true, actorId: '' }),
    makeProof({ enabled: true, checkBefore: '' }),
    makeProof({ enabled: true, candidates: [] })
  ]) {
    const { call, calls } = fixture();
    const report = await createPrimaryOwnerConcurrencyProbe(proof).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false);
    assert.equal(calls.length, 0);
  }
});

function withCandidateOverrides(proof, index, overrides) {
  const next = { ...proof, candidates: proof.candidates.map((c, i) => i === index ? { ...c, ...overrides, bindingProof: { ...c.bindingProof, ...(overrides.bindingProof || {}) } } : c) };
  return next;
}

test('旧项目A/B、错执行人、同申请人/同邀请、两编号对调、过期或未来核验不发送请求', async () => {
  const base = makeProof({ enabled: true });
  const cases = [
    [makeProof({ enabled: true, projectId: 'p_38507fc9b43c4e23a7fbd996415637bb' }), numberA, numberB, now],
    [makeProof({ enabled: true, projectId: 'p_a328c08992f7414c812047935bc3c31e' }), numberA, numberB, now],
    [makeProof({ enabled: true, actorId: 'u_other' }), numberA, numberB, now],
    [makeProof({ enabled: true, candidates: [candidate('候选甲', applicantA, invitationA, digestA), candidate('候选乙', applicantA, invitationB, digestB)] }), numberA, numberB, now],
    [makeProof({ enabled: true, candidates: [candidate('候选甲', applicantA, invitationA, digestA), candidate('候选乙', applicantB, invitationA, digestB)] }), numberA, numberB, now],
    [base, numberB, numberA, now],
    [base, numberA, numberB, Date.parse(base.checkBefore)],
    [base, numberA, numberB, Date.parse(base.verifiedAt) - 1],
    [withCandidateOverrides(base, 1, { bindingProof: { expiresAt: new Date(now).toISOString() } }), numberA, numberB, now]
  ];
  for (const [p, a, b, time] of cases) {
    const { call, calls } = fixture();
    const report = await createPrimaryOwnerConcurrencyProbe(p).run(call, a, b, storageWith(), () => time);
    assert.equal(report.complete, false);
    assert.equal(calls.length, 0);
    if (a && b && (a !== numberA || b !== numberB)) {
      assert.equal(JSON.stringify(report).includes(a), false);
    }
  }
});

test('非管家账号、项目角色不符、项目已有主业主、成员或邀请预检异常均不发送请求', async () => {
  const base = makeProof({ enabled: true });
  const overridesList = [
    { identify: () => ({ userId: 'u_other', isAdmin: false }) },
    { identify: () => ({ userId: managerId, isAdmin: true }) },
    { getMembers: () => ({ project: { ...projectAccess().project, roles: ['负责人'] }, members: projectAccess().members }) },
    { getMembers: () => ({ project: projectAccess().project, members: [...projectAccess().members, { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }] }) },
    { getMembers: () => ({ project: projectAccess().project, members: [] }) },
    { getMembers: () => ({ project: projectAccess().project, members: [projectAccess().members[0]] }) },
    { getMembers: () => ({ project: projectAccess().project, members: [{ ...projectAccess().members[0], roles: ['负责人', '管家'] }, projectAccess().members[1]] }) },
    { listInvitations: () => ({ invitations: [] }) },
    { listInvitations: () => invitationsList([{ id: invitationA, role: '主业主', trades: [], applicantLabel: labelFor(applicantA), requestedAt: '2026-09-30T11:30:00Z' }]) },
    { listInvitations: () => ({ invitations: [{ id: invitationA, role: '师傅', trades: [], applicantLabel: labelFor(applicantA), requestedAt: '2026-09-30T11:30:00Z' }] }) }
  ];
  for (const overrides of overridesList) {
    const { call, calls } = fixture(overrides);
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false, JSON.stringify(overrides).slice(0, 80));
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 0);
  }
});

test('配置校验拒绝错误AppID/env/版本/基线/成员/候选', async () => {
  const base = makeProof({ enabled: true });
  const cases = [
    makeProof({ appId: 'wrong' }),
    makeProof({ envId: 'wrong' }),
    makeProof({ projectVersion: '' }),
    makeProof({ projectVersion: 0 }),
    makeProof({ projectVersion: '1' }),
    makeProof({ primaryOwnerUserId: 'u_someone' }),
    makeProof({ baselineAt: new Date(Date.now() + 86400000).toISOString() }),
    makeProof({ expectedMembers: [] }),
    makeProof({ expectedMembers: [{ userId: ownerId, memberId: ownerMemberId, roles: ['负责人'], trades: [] }] }),
    makeProof({ expectedMembers: [
      { userId: ownerId, memberId: ownerMemberId, roles: ['负责人'], trades: [] },
      { userId: ownerId, memberId: managerMemberId, roles: ['管家'], trades: [] }
    ] }),
    makeProof({ expectedMembers: [
      { userId: ownerId, memberId: 'm_wrong', roles: ['负责人'], trades: [] },
      { userId: managerId, memberId: managerMemberId, roles: ['管家'], trades: [] }
    ] }),
    makeProof({ candidates: [candidate('候选甲', applicantA, invitationA, digestA), candidate('候选乙', applicantA, invitationB, digestB)] }),
    makeProof({ candidates: [candidate('候选乙', applicantB, invitationB, digestB), candidate('候选甲', applicantA, invitationA, digestA)] }),
    withCandidateOverrides(base, 0, { expectedMemberId: 'm_wrong' }),
    withCandidateOverrides(base, 0, { invitationVersion: 1 })
  ];
  for (const proof of cases) {
    const { call, calls } = fixture();
    const report = await createPrimaryOwnerConcurrencyProbe(proof).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false);
    assert.equal(calls.length, 0);
  }
});

test('两次请求同时在途，参数分别对应正确候选', async () => {
  const base = makeProof({ enabled: true });
  const d1 = deferred();
  const d2 = deferred();
  let startedCount = 0;
  const { call, calls } = fixture({ approveInvitation: () => {
    startedCount++;
    if (startedCount === 1) return d1.promise;
    return d2.promise;
  } });
  const running = withTimeout(2000, createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now));
  await waitFor(() => calls.filter(c => c.action === 'approveInvitation').length === 2, 1000);
  assert.equal(startedCount, 2);
  const approvals = calls.filter(c => c.action === 'approveInvitation');
  assert.deepEqual(approvals[0].input, { projectId, invitationId: invitationA, applicantNumber: numberA });
  assert.deepEqual(approvals[1].input, { projectId, invitationId: invitationB, applicantNumber: numberB });
  d1.resolve({ invitationId: invitationA, status: 'approved' });
  d2.resolve({ invitationId: invitationB, status: 'approved' });
  const report = await running;
  assert.equal(report.complete, false);
  assert.equal(report.results.filter(r => r.status === 'success').length, 2);
  assertNoRawNumbers(report);
});

test('甲成功、乙OWNER_EXISTS，且胜方成为唯一主业主，败方申请仍待核对', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let listCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) return { invitationId: invitationA, status: 'approved' };
      throw Object.assign(new Error('目标项目已存在主业主。'), { businessCode: 'OWNER_EXISTS' });
    },
    getMembers: (input, allCalls) => {
      if (allCalls.filter(c => c.action === 'approveInvitation').length >= 2) {
        return {
          project: projectAccess().project,
          members: [
            ...projectAccess().members,
            { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }
          ]
        };
      }
      return projectAccess();
    },
    listInvitations: () => {
      listCalls++;
      return { invitations: listCalls > 1 ? [invitationsList().invitations[1]] : invitationsList().invitations };
    }
  });
  const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
  assert.equal(report.complete, true);
  assert.equal(report.results.filter(r => r.status === 'success').length, 1);
  assert.equal(report.results.filter(r => r.status === 'business_denied' && r.code === 'OWNER_EXISTS').length, 1);
  assert.equal(report.candidate.summary, '一成功、一OWNER_EXISTS');
  assert.equal(report.after.winner.memberId, memberA);
  assert.equal(report.after.winner.userId, applicantA);
  assert.equal(report.after.loser.invitationStillPending, true);
  assert.deepEqual(report.after.otherPendingInvitations, []);
  assertNoRawNumbers(report);
});

test('乙成功、甲OWNER_EXISTS，结果顺序交换仍识别候选', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let listCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) throw Object.assign(new Error('目标项目已存在主业主。'), { businessCode: 'OWNER_EXISTS' });
      return { invitationId: invitationB, status: 'approved' };
    },
    getMembers: (input, allCalls) => {
      if (allCalls.filter(c => c.action === 'approveInvitation').length >= 2) {
        return {
          project: projectAccess().project,
          members: [
            ...projectAccess().members,
            { id: memberB, userId: applicantB, label: labelFor(applicantB), roles: ['主业主'], trades: [], joinedAt: '' }
          ]
        };
      }
      return projectAccess();
    },
    listInvitations: () => {
      listCalls++;
      return { invitations: listCalls > 1 ? [invitationsList().invitations[0]] : invitationsList().invitations };
    }
  });
  const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
  assert.equal(report.complete, true);
  assert.equal(report.results.filter(r => r.status === 'success').length, 1);
  assert.equal(report.results.filter(r => r.status === 'business_denied' && r.code === 'OWNER_EXISTS').length, 1);
  assert.equal(report.candidate.summary, '一成功、一OWNER_EXISTS');
  assert.equal(report.after.winner.memberId, memberB);
  assert.equal(report.after.loser.invitationStillPending, true);
  assertNoRawNumbers(report);
});

test('双成功、零成功、超时或未知错误停止且不重发', async () => {
  const base = makeProof({ enabled: true });
  for (const approveInvitation of [
    () => ({ invitationId: invitationA, status: 'approved' }),
    () => { throw Object.assign(new Error('网络超时'), { businessCode: 'NETWORK_ERROR' }); },
    () => { throw Object.assign(new Error('事务冲突'), { businessCode: 'TRANSACTION_CONFLICT' }); },
    () => { throw Object.assign(new Error('结果丢失: ' + numberA), { businessCode: 'UNKNOWN' }); }
  ]) {
    const { call, calls } = fixture({ approveInvitation });
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false);
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
    assertNoRawNumbers(report);
  }
});

test('仅OWNER_EXISTS组合可通过，CODE_INVALID/NO_ACCESS/未知错误不通过', async () => {
  const base = makeProof({ enabled: true });
  for (const error of [
    Object.assign(new Error('邀请未待核对'), { businessCode: 'CODE_INVALID' }),
    Object.assign(new Error('权限拒绝'), { businessCode: 'NO_ACCESS' }),
    Object.assign(new Error('任意错误'), { businessCode: 'UNKNOWN' })
  ]) {
    const { call, calls } = fixture({ approveInvitation: () => { throw error; } });
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false);
    assert.equal(report.candidate, null);
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
  }
});

test('一成功配非OWNER_EXISTS业务拒绝不通过', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) return { invitationId: invitationA, status: 'approved' };
      throw Object.assign(new Error('邀请未待核对'), { businessCode: 'CODE_INVALID' });
    }
  });
  const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(report.results.filter(r => r.status === 'success').length, 1);
  assert.equal(report.results.filter(r => r.status === 'business_denied').length, 1);
  assert.equal(report.candidate, null);
  assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
});

test('无效成功响应不计为成功', async () => {
  const base = makeProof({ enabled: true });
  for (const response of [
    undefined,
    null,
    {},
    { invitationId: invitationA },
    { status: 'approved' },
    { invitationId: invitationA, status: 'requested' },
    { invitationId: 'i_other', status: 'approved' }
  ]) {
    const { call, calls } = fixture({ approveInvitation: () => response });
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false, JSON.stringify(response));
    assert.equal(report.results.filter(r => r.status === 'success').length, 0);
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
  }
});

test('存储失败、已有标记或同实例重入不发送请求', async () => {
  const base = makeProof({ enabled: true });
  const { call: call1, calls: calls1 } = fixture();
  const report1 = await createPrimaryOwnerConcurrencyProbe(base).run(call1, numberA, numberB,
    { get: () => { throw new Error('storage read failure'); }, set: () => {} }, () => now);
  assert.equal(report1.complete, false);
  assert.equal(calls1.filter(c => c.action === 'approveInvitation').length, 0);

  const { call: call2, calls: calls2 } = fixture();
  const report2 = await createPrimaryOwnerConcurrencyProbe(base).run(call2, numberA, numberB,
    storageWith({ started: true }), () => now);
  assert.equal(report2.complete, false);
  assert.equal(calls2.filter(c => c.action === 'approveInvitation').length, 0);

  const { call: call3, calls: calls3 } = fixture({ approveInvitation: () => ({ invitationId: invitationA, status: 'approved' }) });
  const probe = createPrimaryOwnerConcurrencyProbe(base);
  await probe.run(call3, numberA, numberB, storageWith(), () => now);
  const { call: call4, calls: calls4 } = fixture();
  const report4 = await probe.run(call4, numberA, numberB, storageWith(), () => now);
  assert.equal(report4.complete, false);
  assert.equal(calls4.filter(c => c.action === 'approveInvitation').length, 0);
});

test('事后状态矛盾停止、保留结果且不计完成', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let getMembersCount = 0;
  let listInvitationsCount = 0;
  const contradictions = [
    () => ({ project: projectAccess().project, members: projectAccess().members }),
    () => ({ project: projectAccess().project, members: [...projectAccess().members,
      { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' },
      { id: memberB, userId: applicantB, label: labelFor(applicantB), roles: ['主业主'], trades: [], joinedAt: '' }] }),
    () => ({ project: projectAccess().project, members: [projectAccess().members[0],
      { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }] })
  ];
  for (const afterMembers of contradictions) {
    callIndex = 0;
    getMembersCount = 0;
    listInvitationsCount = 0;
    const { call, calls } = fixture({
      approveInvitation: () => {
        callIndex++;
        if (callIndex === 1) return { invitationId: invitationA, status: 'approved' };
        throw Object.assign(new Error('目标项目已存在主业主。'), { businessCode: 'OWNER_EXISTS' });
      },
      getMembers: () => {
        getMembersCount++;
        if (getMembersCount >= 3) return afterMembers();
        return projectAccess();
      },
      listInvitations: () => {
        listInvitationsCount++;
        if (listInvitationsCount >= 2) return invitationsList();
        return invitationsList();
      }
    });
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false);
    assert.equal(report.results.filter(r => r.status === 'success').length, 1);
    assert.equal(report.results.filter(r => r.status === 'business_denied' && r.code === 'OWNER_EXISTS').length, 1);
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
  }
});

test('候选人已是项目成员时预检停止且不发送请求', async () => {
  const base = makeProof({ enabled: true });
  const { call, calls } = fixture({
    getMembers: () => ({ project: projectAccess().project, members: [...projectAccess().members, { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }] })
  });
  const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 0);
});

test('事后读取失败保留候选并隐藏原始编号，且不标记完成', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) return { invitationId: invitationA, status: 'approved' };
      throw Object.assign(new Error('目标项目已存在主业主。'), { businessCode: 'OWNER_EXISTS' });
    },
    listInvitations: (input, allCalls) => {
      if (allCalls.filter(c => c.action === 'approveInvitation').length >= 2) {
        throw Object.assign(new Error('after failed ' + numberA + numberB), { businessCode: 'UNKNOWN_AFTER' });
      }
      return invitationsList();
    }
  });
  const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(report.stoppedReason, '事后只读观察失败，停止并等待管理端核对。');
  assert.equal(report.results.filter(r => r.status === 'success').length, 1);
  assert.equal(report.results.filter(r => r.status === 'business_denied' && r.code === 'OWNER_EXISTS').length, 1);
  assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
  assert.ok(report.afterReadError);
  assert.equal(report.afterReadError.code, '');
  assertNoRawNumbers(report);
});

test('报告和错误摘要不泄露原始编号', async () => {
  const base = makeProof({ enabled: true });
  const repeated = numberA + numberB;
  const { call, calls } = fixture({
    approveInvitation: () => { throw Object.assign(new Error('raw response: ' + repeated), { businessCode: 'UNEXPECTED_ERROR' }); }
  });
  const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
  assert.equal(report.complete, false);
  assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
  assertNoRawNumbers(report);
  assert.equal(JSON.stringify(report).includes('UNEXPECTED_ERROR'), false);
  assert.equal(JSON.stringify(report).includes('raw response'), false);
  assert.ok(report.results.every(r => r.code === ''));
});

test('严格采用service公开投影结构的正向路径通过', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let listCalls = 0;
  const { call, calls } = fixture({
    approveInvitation: () => {
      callIndex++;
      if (callIndex === 1) return { invitationId: invitationA, status: 'approved' };
      throw Object.assign(new Error('目标项目已存在主业主。'), { businessCode: 'OWNER_EXISTS' });
    },
    getMembers: (input, allCalls) => {
      if (allCalls.filter(c => c.action === 'approveInvitation').length >= 2) {
        return {
          project: projectAccess().project,
          members: [
            ...projectAccess().members,
            { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }
          ]
        };
      }
      return projectAccess();
    },
    listInvitations: () => {
      listCalls++;
      return { invitations: listCalls > 1 ? [invitationsList().invitations[1]] : invitationsList().invitations };
    }
  });
  const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
  assert.equal(report.complete, true);
  assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
});

test('预检额外成员/第三份申请/项目名称变化/缺字段均不发送请求', async () => {
  const base = makeProof({ enabled: true });
  const overridesList = [
    { getMembers: () => ({ project: projectAccess().project, members: [...projectAccess().members, { id: 'm_extra', userId: 'u_extra', label: '成员 extra', roles: ['师傅'], trades: ['水电'], joinedAt: '' }] }) },
    { listInvitations: () => invitationsList([{ id: 'i_extra', role: '主业主', trades: [], applicantLabel: '成员 extra', requestedAt: '2026-09-30T11:30:00Z' }]) },
    { getMembers: () => ({ project: { ...projectAccess().project, name: '改名项目' }, members: projectAccess().members }) },
    { getMembers: () => ({ project: projectAccess().project, members: projectAccess().members.map(m => ({ ...m, userId: undefined })) }) },
    { listInvitations: () => ({ invitations: invitationsList().invitations.map(inv => ({ ...inv, role: undefined })) }) }
  ];
  for (const overrides of overridesList) {
    const { call, calls } = fixture(overrides);
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false, JSON.stringify(overrides).slice(0, 80));
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 0);
  }
});

test('事后原成员角色改变/胜方角色工种错误/败方仍在/待申请字段错误均不计完成', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let listCalls = 0;
  const afterOverrides = [
    { members: [projectAccess().members[0], { ...projectAccess().members[1], roles: ['负责人', '管家'] }, { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }] },
    { members: [projectAccess().members[0], projectAccess().members[1], { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主', '师傅'], trades: ['水电'], joinedAt: '' }] },
    { members: [projectAccess().members[0], projectAccess().members[1], { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }, { id: memberB, userId: applicantB, label: labelFor(applicantB), roles: ['主业主'], trades: [], joinedAt: '' }] },
    { invitations: [{ id: invitationB, role: '师傅', trades: [], applicantLabel: labelFor(applicantB), requestedAt: '2026-09-30T11:30:00Z' }] },
    { invitations: [invitationsList().invitations[1], invitationsList().invitations[0]] }
  ];
  for (const afterOverride of afterOverrides) {
    callIndex = 0;
    listCalls = 0;
    const { call, calls } = fixture({
      approveInvitation: () => {
        callIndex++;
        if (callIndex === 1) return { invitationId: invitationA, status: 'approved' };
        throw Object.assign(new Error('目标项目已存在主业主。'), { businessCode: 'OWNER_EXISTS' });
      },
      getMembers: (input, allCalls) => {
        if (allCalls.filter(c => c.action === 'approveInvitation').length >= 2) {
          return { project: projectAccess().project, members: afterOverride.members || [...projectAccess().members, { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }] };
        }
        return projectAccess();
      },
      listInvitations: (input, allCalls) => {
        if (allCalls.filter(c => c.action === 'approveInvitation').length >= 2) {
          return { invitations: afterOverride.invitations || [invitationsList().invitations[1]] };
        }
        return invitationsList();
      }
    });
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false);
    assert.equal(report.results.filter(r => r.status === 'success').length, 1);
    assert.equal(report.results.filter(r => r.status === 'business_denied' && r.code === 'OWNER_EXISTS').length, 1);
  }
});

test('预检成员 trades 缺失或非数组不发送请求', async () => {
  const base = makeProof({ enabled: true });
  const overridesList = [
    { getMembers: () => ({ project: projectAccess().project, members: projectAccess().members.map(m => ({ ...m, trades: undefined })) }) },
    { getMembers: () => ({ project: projectAccess().project, members: projectAccess().members.map(m => ({ ...m, trades: null })) }) },
    { getMembers: () => ({ project: projectAccess().project, members: projectAccess().members.map(m => ({ ...m, trades: ['水电'] })) }) },
    { getMembers: () => ({ project: projectAccess().project, members: projectAccess().members.map(m => ({ ...m, trades: 'invalid' })) }) }
  ];
  for (const overrides of overridesList) {
    const { call, calls } = fixture(overrides);
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false, JSON.stringify(overrides).slice(0, 80));
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 0);
  }
});

test('预检邀请 trades 缺失或非数组、requestedAt 缺失或无效不发送请求', async () => {
  const base = makeProof({ enabled: true });
  const overridesList = [
    { listInvitations: () => ({ invitations: invitationsList().invitations.map(inv => ({ ...inv, trades: undefined })) }) },
    { listInvitations: () => ({ invitations: invitationsList().invitations.map(inv => ({ ...inv, trades: null })) }) },
    { listInvitations: () => ({ invitations: invitationsList().invitations.map(inv => ({ ...inv, trades: ['水电'] })) }) },
    { listInvitations: () => ({ invitations: invitationsList().invitations.map(inv => ({ ...inv, trades: 'invalid' })) }) },
    { listInvitations: () => ({ invitations: invitationsList().invitations.map(inv => ({ ...inv, requestedAt: undefined })) }) },
    { listInvitations: () => ({ invitations: invitationsList().invitations.map(inv => ({ ...inv, requestedAt: 'not-a-date' })) }) }
  ];
  for (const overrides of overridesList) {
    const { call, calls } = fixture(overrides);
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false, JSON.stringify(overrides).slice(0, 80));
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 0);
  }
});

test('事后成员或胜方 trades 缺失或非数组不计完成', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let listCalls = 0;
  const afterMembersVariations = [
    [projectAccess().members[0], projectAccess().members[1], { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: undefined, joinedAt: '' }],
    [projectAccess().members[0], projectAccess().members[1], { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: null, joinedAt: '' }],
    [projectAccess().members[0], projectAccess().members[1], { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: ['水电'], joinedAt: '' }],
    [{ ...projectAccess().members[0], trades: undefined }, projectAccess().members[1], { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }]
  ];
  for (const afterMembers of afterMembersVariations) {
    callIndex = 0;
    listCalls = 0;
    const { call, calls } = fixture({
      approveInvitation: () => {
        callIndex++;
        if (callIndex === 1) return { invitationId: invitationA, status: 'approved' };
        throw Object.assign(new Error('目标项目已存在主业主。'), { businessCode: 'OWNER_EXISTS' });
      },
      getMembers: (input, allCalls) => {
        if (allCalls.filter(c => c.action === 'approveInvitation').length >= 2) {
          return { project: projectAccess().project, members: afterMembers };
        }
        return projectAccess();
      },
      listInvitations: () => {
        listCalls++;
        return { invitations: listCalls > 1 ? [invitationsList().invitations[1]] : invitationsList().invitations };
      }
    });
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false);
    assert.equal(report.results.filter(r => r.status === 'success').length, 1);
    assert.equal(report.results.filter(r => r.status === 'business_denied' && r.code === 'OWNER_EXISTS').length, 1);
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
  }
});

test('事后败方邀请 requestedAt 改变、缺失或无效不计完成', async () => {
  const base = makeProof({ enabled: true });
  let callIndex = 0;
  let listCalls = 0;
  const afterInvitationsVariations = [
    [{ id: invitationB, role: '主业主', trades: [], applicantLabel: labelFor(applicantB), requestedAt: new Date(now + 1000).toISOString() }],
    [{ id: invitationB, role: '主业主', trades: [], applicantLabel: labelFor(applicantB), requestedAt: undefined }],
    [{ id: invitationB, role: '主业主', trades: [], applicantLabel: labelFor(applicantB), requestedAt: 'invalid-date' }]
  ];
  for (const afterInvitations of afterInvitationsVariations) {
    callIndex = 0;
    listCalls = 0;
    const { call, calls } = fixture({
      approveInvitation: () => {
        callIndex++;
        if (callIndex === 1) return { invitationId: invitationA, status: 'approved' };
        throw Object.assign(new Error('目标项目已存在主业主。'), { businessCode: 'OWNER_EXISTS' });
      },
      getMembers: (input, allCalls) => {
        if (allCalls.filter(c => c.action === 'approveInvitation').length >= 2) {
          return { project: projectAccess().project, members: [...projectAccess().members, { id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: '' }] };
        }
        return projectAccess();
      },
      listInvitations: () => {
        listCalls++;
        return { invitations: listCalls > 1 ? afterInvitations : invitationsList().invitations };
      }
    });
    const report = await createPrimaryOwnerConcurrencyProbe(base).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false, JSON.stringify(afterInvitations));
    assert.equal(report.results.filter(r => r.status === 'success').length, 1);
    assert.equal(report.results.filter(r => r.status === 'business_denied' && r.code === 'OWNER_EXISTS').length, 1);
    assert.equal(calls.filter(c => c.action === 'approveInvitation').length, 2);
  }
});

test('候选数组含 null、undefined、稀疏数组或非对象元素时安全停止', async () => {
  const base = makeProof({ enabled: true });
  const sparse = [base.candidates[0]];
  sparse.length = 2;
  const cases = [
    { ...base, candidates: [null, base.candidates[1]] },
    { ...base, candidates: [base.candidates[0], undefined] },
    { ...base, candidates: [base.candidates[0], 123] },
    { ...base, candidates: [base.candidates[0], 'string'] },
    { ...base, candidates: sparse }
  ];
  for (const proof of cases) {
    const { call, calls } = fixture();
    const report = await createPrimaryOwnerConcurrencyProbe(proof).run(call, numberA, numberB, storageWith(), () => now);
    assert.equal(report.complete, false);
    assert.equal(calls.length, 0);
    assert.equal(report.stoppedReason, '候选人凭据结构异常，未发送请求。');
  }
});
