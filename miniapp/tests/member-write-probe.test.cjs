const test = require('node:test');
const assert = require('node:assert/strict');
const { runWriteProbe } = require('../miniprogram/utils/member-write-probe');
const projects = [{ id: 'p_a', label: '甲' }, { id: 'p_b', label: '乙' }];
function deny(action, code = 'NO_ACCESS', message) {
  const error = new Error(message || (action === 'assignManager' ?
    '仅负责人可指定管家。' : '当前微信账号不是该项目成员。'));
  error.businessCode = code;
  throw error;
}
function caller(options = {}) {
  const calls = [];
  return { calls, call: async (action, input) => {
    calls.push({ action, input });
    if (action === 'identify') return { isAdmin: !!options.admin, userId: 'u_64193d' };
    if (action === 'listMyProjects') return { projects: options.owned || [] };
    if (options.respond) return options.respond(action, input);
    return deny(action);
  } };
}
test('管家跳过所属项目，只检测隔离项目；负责人不发起写检查', async () => {
  const manager = caller({ owned: [projects[0]] });
  const result = await runWriteProbe(manager.call, projects);
  assert.equal(result.complete, true);
  assert.equal(result.results.length, 4);
  assert.deepEqual(result.skippedProjects, ['p_a']);
  assert.ok(manager.calls.filter(c => c.input).every(c => c.input.projectId === 'p_b'));
  const owner = caller({ admin: true });
  assert.equal((await runWriteProbe(owner.call, projects)).complete, false);
  assert.equal(owner.calls.length, 1);
});
test('预检读取成功或网络失败时，不发送任何写请求', async () => {
  for (const respond of [async () => ({ ok: true }), async () => { throw new Error('network failed'); }]) {
    const probe = caller({ respond });
    const result = await runWriteProbe(probe.call, projects);
    assert.equal(result.complete, false);
    assert.equal(result.results.length, 0);
    assert.deepEqual(probe.calls.map(c => c.action), ['identify', 'listMyProjects', 'getMembers']);
  }
});
test('后置校验拒绝和网络失败均不是前置鉴权通过证据，停止后续请求', async () => {
  for (const fail of [
    () => deny('assignManager', 'BAD_INPUT', '请输入十位身份绑定编号。'),
    () => deny('assignManager', 'NO_ACCESS', '该成员不能通过此入口移出。'),
    () => { throw new Error('network failed'); }
  ]) {
    const probe = caller({ respond: async action => action === 'getMembers' ? deny(action) : fail() });
    const result = await runWriteProbe(probe.call, projects);
    assert.equal(result.complete, false);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, 'inconclusive');
    assert.equal(probe.calls.length, 4);
  }
});
test('意外成功立即停止，不复制邀请码，只保留资源 ID', async () => {
  const probe = caller({ respond: async action => action === 'createInvitation' ?
    { invitationId: 'i_unexpected', invitationCode: 'DO_NOT_COPY' } : deny(action) });
  const report = await runWriteProbe(probe.call, projects);
  assert.equal(report.complete, false);
  assert.equal(report.results.length, 4);
  assert.equal(report.results[3].status, 'unexpected_success');
  assert.equal(report.results[3].resourceId, 'i_unexpected');
  assert.equal(JSON.stringify(report).includes('DO_NOT_COPY'), false);
  assert.ok(probe.calls.filter(c => c.input).every(c => c.input.projectId === 'p_a'));
});

for (const [mode, expectedRoles] of [
  ['active-worker', ['师傅']], ['active-primary-owner', ['主业主']],
  ['active-worker-designer', ['师傅', '设计师']]
]) {
const role = expectedRoles.join('＋');
test(`${role}模式排除管家兼任角色及未加入项目`, async () => {
  for (const roles of [['管家'], [...expectedRoles, '管家'], ['家庭成员'], [], ...(expectedRoles.length > 1 ? [['师傅'], ['设计师'], ['师傅', '师傅']] : [])]) {
    const probe = caller({ owned: [{ ...projects[0], roles }] });
    const result = await runWriteProbe(probe.call, projects, () => {}, mode);
    assert.equal(result.complete, false);
    assert.equal(result.results.length, 0);
    assert.equal(probe.calls.length, 2);
  }
});

test(`${role}读取预检角色变化、非成员拒绝或管家列表意外允许均停止写请求`, async () => {
  for (const scenario of ['role-changed', 'left', 'invitations-allowed']) {
    const probe = caller({ owned: [{ ...projects[0], roles: expectedRoles }], respond: async action => {
      if (action === 'getMembers') {
        if (scenario === 'left') return deny(action);
        return { project: { ...projects[0], scope: 'identity-test', status: 'active',
          roles: scenario === 'role-changed' ? [...expectedRoles, '管家'] : expectedRoles } };
      }
      if (action === 'listInvitations') return { invitations: [] };
      throw new Error('不应调用写接口');
    } });
    const report = await runWriteProbe(probe.call, projects, () => {}, mode);
    assert.equal(report.complete, false);
    assert.equal(report.results.length, 0);
    assert.ok(probe.calls.every(c => ['identify', 'listMyProjects', 'getMembers', 'listInvitations'].includes(c.action)));
  }
});

test(`${role}模式只接受角色级拒绝，非成员拒绝不能冒充项目内角色验证通过`, async () => {
  const probe = caller({ owned: [{ ...projects[0], roles: expectedRoles }], respond: async action => {
    if (action === 'getMembers') return { project: { ...projects[0], scope: 'identity-test',
      status: 'active', roles: expectedRoles } };
    if (action === 'listInvitations') return deny(action, 'NO_ACCESS', '仅项目管家可管理成员。');
    return deny(action);
  } });
  const report = await runWriteProbe(probe.call, projects, () => {}, mode);
  assert.equal(report.complete, false);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].status, 'denied');
  assert.equal(report.results[1].status, 'inconclusive');
});
}
