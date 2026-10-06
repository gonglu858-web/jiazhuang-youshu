const test = require('node:test');
const assert = require('node:assert/strict');
const { runValidMemberProbe, MEMBER_TARGET: target } = require('../miniprogram/utils/member-write-probe');
const access = () => ({ project: { id: target.projectId, scope: 'identity-test', status: 'active', roles: ['主业主'] },
  members: [{ id: target.memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] });
function deny(code = 'NO_ACCESS', message = '仅项目管家可管理成员。') {
  throw Object.assign(new Error(message), { businessCode: code });
}
function fixture(overrides = {}) {
  const calls = [];
  const call = async (action, input) => {
    calls.push({ action, input });
    if (overrides[action]) return overrides[action](input, calls);
    if (action === 'identify') return { userId: target.actorId, isAdmin: false };
    if (action === 'getMembers') return access();
    return deny();
  };
  return { call, calls };
}
test('有效目标探针只发一次固定移出请求；明确拒绝且成员仍可见才完成', async () => {
  const { call, calls } = fixture();
  const report = await runValidMemberProbe(call);
  assert.equal(report.complete, true);
  assert.equal(report.results[0].status, 'denied');
  assert.deepEqual(calls.filter(row => row.action === 'removeMember'), [{ action: 'removeMember',
    input: { projectId: target.projectId, userId: target.userId } }]);
  assert.equal(calls.at(-1).action, 'getMembers');
});
test('错误身份、角色、项目、目标缺失或工种变化时不发送移出请求', async () => {
  for (const overrides of [
    { identify: () => ({ userId: 'other', isAdmin: false }) },
    { identify: () => ({ userId: target.actorId, isAdmin: true }) },
    ...[
      a => a.project.roles.push('管家'), a => { a.project.scope = 'production'; },
      a => { a.project.id = 'other'; }, a => { a.members = []; },
      a => a.members.push(a.members[0]), a => { a.members[0].trades = ['拆改']; }
    ].map(change => ({ getMembers: () => { const a = access(); change(a); return a; } })),
    { listInvitations: () => ({ invitations: [] }) }
  ]) {
    const { call, calls } = fixture(overrides);
    assert.equal((await runValidMemberProbe(call)).complete, false);
    assert.ok(calls.every(row => row.action !== 'removeMember'));
  }
});
test('意外成功、网络失败、参数错误均停止，不再发送后续请求', async () => {
  for (const removeMember of [() => ({}), () => deny('BAD_INPUT', '参数无效'),
    () => { throw new Error('network'); }, () => deny('NO_ACCESS', '不匹配的拒绝')]) {
    const { call, calls } = fixture({ removeMember });
    const report = await runValidMemberProbe(call);
    assert.equal(report.complete, false);
    assert.equal(report.results.length, 1);
    assert.notEqual(report.results[0].status, 'denied');
    assert.equal(calls.at(-1).action, 'removeMember');
  }
});
test('明确拒绝后若目标消失，仍记为未完成', async () => {
  let reads = 0;
  const { call } = fixture({ getMembers: () => { const a = access(); if (++reads > 1) a.members = []; return a; } });
  assert.equal((await runValidMemberProbe(call)).complete, false);
});
