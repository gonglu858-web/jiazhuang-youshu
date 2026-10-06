const test = require('node:test');
const assert = require('node:assert/strict');
const { bindingDigest } = require('../miniprogram/utils/binding-digest');
const { createValidApprovalProbe } = require('../miniprogram/utils/valid-approval-probe');
const actual = require('../miniprogram/config/valid-approval-proof');

const number = '1234567890'; // 合成测试编号，不是用户凭据。
const now = Date.parse('2026-09-30T12:30:00Z');
const proof = { ...actual, evidenceId: 'synthetic-approval', verifiedAt: '2026-09-30T12:00:00Z',
  invitationExpiresAt: '2026-10-07T12:00:00Z', checkBefore: '2026-09-30T13:00:00Z',
  bindingProof: { evidenceId: 'synthetic-binding', userId: actual.applicantUserId,
    digest: bindingDigest(number), verifiedAt: '2026-09-30T11:59:00Z',
    expiresAt: '2026-09-30T13:00:00Z', checkBefore: '2026-09-30T13:00:00Z' } };
const access = () => ({ project: { id: proof.projectId, scope: 'identity-test', status: 'active',
  roles: ['主业主'] }, members: [{ id: proof.memberId, label: '成员 989a74',
  roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] });
function fixture(overrides = {}) {
  const calls = [];
  const call = async (action, input) => {
    calls.push({ action, input });
    if (overrides[action]) return overrides[action](input, calls);
    if (action === 'identify') return { userId: proof.actorId, isAdmin: false };
    if (action === 'getMembers') return access();
    throw Object.assign(new Error('仅项目管家可管理成员。'), { businessCode: 'NO_ACCESS' });
  };
  return { call, calls };
}

test('固定真实邀请与有效编号仅发一次批准请求，报告不包含编号或邀请码', async () => {
  const { call, calls } = fixture();
  const report = await createValidApprovalProbe(proof).run(call, number, () => now);
  assert.equal(report.complete, true);
  assert.equal(report.results[0].status, 'denied');
  assert.deepEqual(calls.map(row => row.action), ['identify', 'getMembers', 'approveInvitation', 'getMembers']);
  assert.deepEqual(calls[2].input, { projectId: proof.projectId,
    invitationId: proof.invitationId, applicantNumber: number });
  assert.equal(JSON.stringify(report).includes(number), false);
  assert.ok(calls.every(row => row.action !== 'listInvitations'));
});

test('错编号、错邀请或归属、过期及未来核验不发送任何云端请求', async () => {
  for (const [p, input, time] of [
    [proof, '9999999999', now], [proof, '', now],
    [{ ...proof, invitationId: 'i_other' }, number, now],
    [{ ...proof, applicantUserId: 'u_other' }, number, now],
    [{ ...proof, role: '设计师' }, number, now],
    [{ ...proof, trades: ['木工'] }, number, now],
    [{ ...proof, status: 'approved' }, number, now],
    [{ ...proof, invitationExpiresAt: new Date(now).toISOString() }, number, now],
    [proof, number, Date.parse(proof.checkBefore)],
    [proof, number, Date.parse(proof.verifiedAt) - 1],
    [{ ...proof, bindingProof: { ...proof.bindingProof, expiresAt: new Date(now).toISOString() } }, number, now]
  ]) {
    const { call, calls } = fixture();
    const report = await createValidApprovalProbe(p).run(call, input, () => time);
    assert.equal(report.complete, false);
    assert.equal(calls.length, 0);
    if (input) assert.equal(JSON.stringify(report).includes(input), false);
  }
});

test('错微信、错项目角色、成员工种变化及预检期间过期均不发送批准请求', async () => {
  for (const overrides of [
    { identify: () => ({ userId: 'u_other', isAdmin: false }) },
    { identify: () => ({ userId: proof.actorId, isAdmin: true }) },
    { getMembers: () => ({ ...access(), project: { ...access().project, roles: ['主业主', '管家'] } }) },
    { getMembers: () => ({ ...access(), members: [{ ...access().members[0], trades: ['木工'] }] }) },
    { getMembers: () => ({ ...access(), members: [] }) }
  ]) {
    const { call, calls } = fixture(overrides);
    assert.equal((await createValidApprovalProbe(proof).run(call, number, () => now)).complete, false);
    assert.ok(calls.every(row => row.action !== 'approveInvitation'));
  }
  let ticks = 0;
  const { call, calls } = fixture();
  const report = await createValidApprovalProbe(proof).run(call, number,
    () => ++ticks === 1 ? now : Date.parse(proof.checkBefore));
  assert.equal(report.complete, false);
  assert.ok(calls.every(row => row.action !== 'approveInvitation'));
});

test('网络不确定、不同拒绝或意外成功均停机且不泄露底层请求内容', async () => {
  for (const approveInvitation of [
    () => ({}),
    () => { throw Object.assign(new Error(number), { businessCode: 'NO_ACCESS' }); },
    () => { throw Object.assign(new Error('其他拒绝'), { businessCode: 'NO_ACCESS' }); },
    () => { throw new Error('network request: ' + number); }
  ]) {
    const { call, calls } = fixture({ approveInvitation });
    const probe = createValidApprovalProbe(proof);
    const report = await probe.run(call, number, () => now);
    assert.equal(report.complete, false);
    assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 1);
    assert.equal(JSON.stringify(report).includes(number), false);
    await probe.run(call, number, () => now);
    assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 1);
  }
});

test('同一探针并发调用也只发送一次批准请求', async () => {
  const { call, calls } = fixture();
  const probe = createValidApprovalProbe(proof);
  const reports = await Promise.all([probe.run(call, number, () => now), probe.run(call, number, () => now)]);
  assert.equal(calls.filter(row => row.action === 'approveInvitation').length, 1);
  assert.equal(reports.filter(row => row.complete).length, 1);
});
