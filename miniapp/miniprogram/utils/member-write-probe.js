// 临时开发核验：走现有业务权限入口，不改变云函数或模拟微信身份。
const EXPECTED_MEMBER_DENIAL = '当前微信账号不是该项目成员。';
const EXPECTED_ROLE_DENIAL = '仅项目管家可管理成员。';
const MODE_ROLES = {
  'active-worker': ['师傅'],
  'active-primary-owner': ['主业主'],
  'active-worker-designer': ['师傅', '设计师']
};
const hasExactRoles = (project, roles) => project && Array.isArray(project.roles) &&
  project.roles.length === roles.length && roles.every(role => project.roles.includes(role));
const CHECKS = [
  { action: 'assignManager', label: '指定管家', input: { bindingNumber: '' },
    expectedMessage: '仅负责人可指定管家。' },
  { action: 'approveInvitation', label: '批准申请',
    input: { invitationId: 'i_permission_probe_missing_20260927', applicantNumber: '' } },
  { action: 'removeMember', label: '移出成员', input: { userId: 'u_permission_probe_missing_20260927' } },
  { action: 'createInvitation', label: '生成邀请', input: { role: '师傅', trades: ['拆改'] } }
];

async function runWriteProbe(call, projects, onRow = () => {}, mode = 'outsider') {
  const report = { version: 2, mode, account: '', complete: false, expectedCount: 0,
    preflight: [], skippedProjects: [], results: [], stoppedReason: '' };
  try {
    if (mode !== 'outsider' && !Object.prototype.hasOwnProperty.call(MODE_ROLES, mode)) throw new Error('未知的权限检查模式。');
    const memberMode = mode !== 'outsider';
    const expectedRoles = MODE_ROLES[mode] || [];
    const expectedRole = expectedRoles.join('＋');
    const identity = await call('identify');
    if (identity.isAdmin !== false || typeof identity.userId !== 'string') {
      report.stoppedReason = '请使用已登记的非负责人账号执行此检查。';
      return report;
    }
    report.account = `本人账号 ${identity.userId.slice(-6)}`;
    const list = await call('listMyProjects');
    if (!Array.isArray(list.projects)) throw new Error('项目列表响应无效。');
    const targets = projects.filter(project => memberMode ?
      list.projects.some(item => item.id === project.id && hasExactRoles(item, expectedRoles)) :
      !list.projects.some(item => item.id === project.id));
    report.skippedProjects = projects.filter(project => !targets.includes(project)).map(p => p.id);
    report.expectedCount = targets.length * CHECKS.length;
    if (!targets.length) {
      report.stoppedReason = memberMode ? `没有仅以${expectedRole}角色加入的既有测试项目，已停止。` :
        '当前账号可以访问所有测试项目，没有可核验的越权目标。';
      return report;
    }
    for (const project of targets) {
      if (memberMode) {
        const access = await call('getMembers', { projectId: project.id });
        if (!access.project || access.project.id !== project.id ||
            access.project.scope !== 'identity-test' || access.project.status !== 'active' ||
            !hasExactRoles(access.project, expectedRoles)) throw new Error(`当前项目或${expectedRole}角色与预期不符，已停止。`);
        report.preflight.push({ projectId: project.id, action: 'getMembers', status: 'allowed',
          roles: access.project.roles.slice() });
        try {
          await call('listInvitations', { projectId: project.id });
          report.stoppedReason = `${expectedRole}意外可读取管家申请列表，已停止写入测试。`;
          return report;
        } catch (error) {
          if (error.businessCode !== 'NO_ACCESS' || error.message !== EXPECTED_ROLE_DENIAL) throw error;
          report.preflight.push({ projectId: project.id, action: 'listInvitations', status: 'denied',
            code: error.businessCode, message: error.message });
        }
      } else {
        // 列表可能过时：必须再次收到明确的非成员拒绝，才发送测试请求。
        try {
          await call('getMembers', { projectId: project.id });
          report.stoppedReason = '目标项目仍允许读取，已停止发送写入测试请求。';
          return report;
        } catch (error) {
          if (error.businessCode !== 'NO_ACCESS' || error.message !== EXPECTED_MEMBER_DENIAL) throw error;
          report.preflight.push({ projectId: project.id, code: error.businessCode, message: error.message });
        }
      }
      for (const check of CHECKS) {
        const row = { key: `${project.id}:${check.action}`, projectId: project.id,
          label: `${project.label} · ${check.label}`, action: check.action,
          checkedAt: new Date().toISOString() };
        try {
          const result = await call(check.action, { projectId: project.id, ...check.input });
          // 不复制邀请码或绑定凭据，仅保留核查所需的新资源 ID。
          Object.assign(row, { status: 'unexpected_success', text: '意外成功，已停止', code: '',
            resourceId: result.invitationId || result.memberId || '' });
        } catch (error) {
          const denied = error.businessCode === 'NO_ACCESS' &&
            error.message === (check.expectedMessage || (memberMode ? EXPECTED_ROLE_DENIAL : EXPECTED_MEMBER_DENIAL));
          Object.assign(row, { status: denied ? 'denied' : 'inconclusive',
            text: denied ? '权限拒绝' : '结果异常，已停止', code: error.businessCode || '',
            message: error.message || '请求失败，需核对云端是否发生变更。' });
        }
        report.results.push(row);
        onRow(report.results.slice());
        if (row.status !== 'denied') {
          report.stoppedReason = '请复制结果交给开发协作者核查，不要重试或继续邀请／批准／移出。';
          return report;
        }
      }
    }
    report.complete = report.results.length === report.expectedCount;
  } catch (error) {
    report.stoppedReason = error.message || '检查未完成，未自动重试。';
    report.errorCode = error.businessCode || '';
  }
  return report;
}

// 专用的一次有效目标检查，不接受页面输入替换账号、项目或目标。
const MEMBER_TARGET = Object.freeze({
  projectId: 'p_38507fc9b43c4e23a7fbd996415637bb',
  actorId: 'u_15703f790f293a33c184af9eb0b8db9852f182f4',
  userId: 'u_a2acfbaea35f409671860b2c4b13d777a6989a74',
  memberId: 'm_4312a8548b3a432854ade093290e72c6ed5a6f7f'
});
function checkedTarget(access) {
  const project = access && access.project;
  if (!project || project.id !== MEMBER_TARGET.projectId || project.scope !== 'identity-test' ||
      project.status !== 'active' || !hasExactRoles(project, ['主业主']) || !Array.isArray(access.members)) {
    throw new Error('项目或主业主角色不符合本轮条件，已停止。');
  }
  const matches = access.members.filter(row => row.id === MEMBER_TARGET.memberId);
  const target = matches[0];
  if (matches.length !== 1 || target.label !== '成员 989a74' ||
      !hasExactRoles(target, ['师傅', '设计师']) || !Array.isArray(target.trades) ||
      target.trades.length !== 2 || !['拆改', '木工'].every(trade => target.trades.includes(trade))) {
    throw new Error('原师傅成员或工种已变化，已停止，请先核查云端记录。');
  }
  return { memberId: target.id, roles: target.roles.slice(), trades: target.trades.slice() };
}
async function runValidMemberProbe(call) {
  const report = { version: 3, mode: 'valid-member-removal', account: '', complete: false,
    expectedCount: 1, projectId: MEMBER_TARGET.projectId, targetMemberId: MEMBER_TARGET.memberId,
    preflight: [], results: [], stoppedReason: '' };
  try {
    const identity = await call('identify');
    if (identity.isAdmin !== false || identity.userId !== MEMBER_TARGET.actorId) {
      throw new Error('本轮仅供主业主账号 f182f4 执行，未发送移出请求。');
    }
    report.account = '本人账号 f182f4';
    report.preflight.push(checkedTarget(await call('getMembers', { projectId: MEMBER_TARGET.projectId })));
    try {
      await call('listInvitations', { projectId: MEMBER_TARGET.projectId });
      throw new Error('主业主意外可读取管家申请列表，停止检查。');
    } catch (error) {
      if (error.businessCode !== 'NO_ACCESS' || error.message !== EXPECTED_ROLE_DENIAL) throw error;
    }
    const row = { action: 'removeMember', projectId: MEMBER_TARGET.projectId,
      targetMemberId: MEMBER_TARGET.memberId, checkedAt: new Date().toISOString() };
    try {
      await call('removeMember', { projectId: MEMBER_TARGET.projectId, userId: MEMBER_TARGET.userId });
      Object.assign(row, { status: 'unexpected_success', code: '', message: '移出请求意外成功。' });
    } catch (error) {
      Object.assign(row, { status: error.businessCode === 'NO_ACCESS' && error.message === EXPECTED_ROLE_DENIAL ?
        'denied' : 'inconclusive', code: error.businessCode || '', message: error.message || '请求未明确完成。' });
    }
    report.results.push(row);
    if (row.status !== 'denied') throw new Error('已停止。请复制报告，不要重试、重新邀请或批准，等待核对云端。');
    report.after = checkedTarget(await call('getMembers', { projectId: MEMBER_TARGET.projectId }));
    report.complete = true;
  } catch (error) {
    report.stoppedReason = error.message || '检查未完成，未自动重试。';
    report.errorCode = error.businessCode || '';
  }
  return report;
}

function createValidBindingProbe(proof) {
  const { bindingDigest } = require('./binding-digest');
  function validate(number, now = Date.now()) {
    const digest = bindingDigest(number);
    const expiry = Date.parse(proof.expiresAt), deadline = Date.parse(proof.checkBefore);
    const verified = Date.parse(proof.verifiedAt);
    if (proof.userId !== MEMBER_TARGET.userId || digest !== proof.digest) {
      throw new Error('编号与本轮核验不符，未发送请求。请使用师傅刚才提供的编号。');
    }
    if (![now, expiry, deadline, verified].every(Number.isFinite) || now < verified ||
        now >= expiry || now >= deadline) throw new Error('本轮核验窗口已结束，请联系开发协作者重新只读核对。');
    return { digest, evidenceId: proof.evidenceId, expiresAt: proof.expiresAt,
      checkBefore: proof.checkBefore, validationSource: '管理端事前核验，事后须再核对编号仍有效且未消费' };
  }
  async function run(call, number, now = () => Date.now()) {
    const report = { version: 4, mode: 'valid-binding-assign-manager', account: '', complete: false,
      expectedCount: 1, projectId: MEMBER_TARGET.projectId, targetMemberId: MEMBER_TARGET.memberId,
      preflight: [], results: [], stoppedReason: '' };
    try {
      report.credential = validate(number, now());
      const identity = await call('identify');
      if (identity.isAdmin !== false || identity.userId !== MEMBER_TARGET.actorId) {
        throw new Error('本轮仅供主业主账号 f182f4 检查，未发送指定管家请求。');
      }
      report.account = '本人账号 f182f4';
      report.preflight.push(checkedTarget(await call('getMembers', { projectId: MEMBER_TARGET.projectId })));
      validate(number, now());
      const row = { action: 'assignManager', projectId: MEMBER_TARGET.projectId,
        targetMemberId: MEMBER_TARGET.memberId, checkedAt: new Date(now()).toISOString() };
      try {
        await call('assignManager', { projectId: MEMBER_TARGET.projectId, bindingNumber: number });
        Object.assign(row, { status: 'unexpected_success', code: '', message: '指定管家请求意外成功，已停止。' });
      } catch (error) {
        const denied = error.businessCode === 'NO_ACCESS' && error.message === '仅负责人可指定管家。';
        // 不复制底层错误或请求体，防止网络错误回显编号。
        Object.assign(row, { status: denied ? 'denied' : 'inconclusive',
          code: denied ? 'NO_ACCESS' : '', message: denied ? '仅负责人可指定管家。' : '结果未明确，请核对云端，不要重试。' });
      }
      report.results.push(row);
      if (row.status !== 'denied') throw new Error('已停止，请复制报告；不要继续指定、邀请或批准。');
      report.after = checkedTarget(await call('getMembers', { projectId: MEMBER_TARGET.projectId }));
      report.complete = true;
    } catch (error) {
      const message = error.message || '检查未完成，请勿重试。';
      report.stoppedReason = number ? message.split(number).join('[编号已隐藏]') : message;
    }
    return report;
  }
  return { run, validate };
}

module.exports = { runWriteProbe, runValidMemberProbe, MEMBER_TARGET, createValidBindingProbe };
