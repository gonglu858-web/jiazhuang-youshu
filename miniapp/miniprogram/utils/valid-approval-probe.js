// 主业主针对一条真实待批准申请的临时权限探针；不查询管家的申请列表。
const { bindingDigest } = require('./binding-digest');
const { MEMBER_TARGET } = require('./member-write-probe');

const INVITATION_ID = 'i_0e0483488efb40ada6825d259ebc1736';
const MANAGER_ID = 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d';
const DENIAL = '仅项目管家可管理成员。';

class ProbeStop extends Error {}
const sameSet = (actual, expected) => Array.isArray(actual) && actual.length === expected.length &&
  expected.every(value => actual.includes(value));

function createValidApprovalProbe(proof) {
  let requestStarted = false;
  function validate(number, now = Date.now()) {
    if (!proof || proof.projectId !== MEMBER_TARGET.projectId ||
        proof.actorId !== MEMBER_TARGET.actorId || proof.applicantUserId !== MEMBER_TARGET.userId ||
        proof.memberId !== MEMBER_TARGET.memberId || proof.invitationId !== INVITATION_ID ||
        proof.issuedByUserId !== MANAGER_ID || proof.role !== '师傅' ||
        !sameSet(proof.trades, ['拆改']) || proof.status !== 'requested' ||
        typeof proof.evidenceId !== 'string' || !proof.evidenceId ||
        !proof.bindingProof || proof.bindingProof.userId !== MEMBER_TARGET.userId) {
      throw new ProbeStop('本轮邀请或申请人配置与已核实目标不符，未发送请求。');
    }
    let digest;
    try { digest = bindingDigest(number); }
    catch (_) { throw new ProbeStop('请输入师傅本人提供的十位绑定编号。'); }
    if (digest !== proof.bindingProof.digest) {
      throw new ProbeStop('编号与本轮管理端核验不一致，未发送请求。');
    }
    const verified = Date.parse(proof.verifiedAt);
    const bindingVerified = Date.parse(proof.bindingProof.verifiedAt);
    const bindingExpiry = Date.parse(proof.bindingProof.expiresAt);
    const invitationExpiry = Date.parse(proof.invitationExpiresAt);
    const deadline = Date.parse(proof.checkBefore);
    const bindingDeadline = Date.parse(proof.bindingProof.checkBefore);
    if (![now, verified, bindingVerified, bindingExpiry, invitationExpiry, deadline,
      bindingDeadline].every(Number.isFinite) || now < Math.max(verified, bindingVerified) ||
      now >= Math.min(bindingExpiry, invitationExpiry, deadline, bindingDeadline)) {
      throw new ProbeStop('本轮有效申请或编号核验窗口已结束，未发送请求。');
    }
    return { evidenceId: proof.evidenceId, bindingEvidenceId: proof.bindingProof.evidenceId,
      invitationId: proof.invitationId, invitationExpiresAt: proof.invitationExpiresAt,
      bindingExpiresAt: proof.bindingProof.expiresAt,
      checkBefore: new Date(Math.min(bindingExpiry, invitationExpiry, deadline, bindingDeadline)).toISOString(),
      validationSource: '管理端事前核实；事后仍须复核申请、编号、成员和审计' };
  }
  function checkedTarget(access) {
    const project = access && access.project;
    if (!project || project.id !== proof.projectId || project.scope !== 'identity-test' ||
        project.status !== 'active' || !sameSet(project.roles, ['主业主']) ||
        !Array.isArray(access.members)) {
      throw new ProbeStop('当前项目或主业主身份不符合本轮条件，已停止。');
    }
    const matches = access.members.filter(row => row.id === proof.memberId);
    const member = matches[0];
    if (matches.length !== 1 || member.label !== '成员 989a74' ||
        !sameSet(member.roles, ['师傅', '设计师']) ||
        !sameSet(member.trades, ['拆改', '木工'])) {
      throw new ProbeStop('申请人现有成员角色或工种发生变化，已停止。');
    }
    return { projectId: project.id, roles: project.roles.slice(),
      memberId: member.id, memberRoles: member.roles.slice(), memberTrades: member.trades.slice() };
  }
  async function run(call, number, now = () => Date.now()) {
    const report = { version: 1, mode: 'valid-pending-approval-owner-denial',
      account: '', complete: false, expectedCount: 1, projectId: MEMBER_TARGET.projectId,
      invitationId: INVITATION_ID, targetMemberId: MEMBER_TARGET.memberId,
      credential: null, preflight: [], results: [], stoppedReason: '' };
    try {
      report.credential = validate(number, now());
      const identity = await call('identify');
      if (!identity || identity.isAdmin !== false || identity.userId !== MEMBER_TARGET.actorId) {
        throw new ProbeStop('本轮仅供主业主账号 f182f4 检查，未发送批准请求。');
      }
      report.account = '本人账号 f182f4';
      report.preflight.push(checkedTarget(await call('getMembers', { projectId: proof.projectId })));
      validate(number, now());
      if (requestStarted) throw new ProbeStop('本机已发送过本轮批准检查，不自动重试。');
      requestStarted = true;
      const row = { action: 'approveInvitation', projectId: proof.projectId,
        invitationId: proof.invitationId, targetMemberId: proof.memberId,
        checkedAt: new Date(now()).toISOString() };
      try {
        await call('approveInvitation', { projectId: proof.projectId,
          invitationId: proof.invitationId, applicantNumber: number });
        Object.assign(row, { status: 'unexpected_success', code: '',
          message: '批准请求意外成功，已停止。' });
      } catch (error) {
        const denied = error && error.businessCode === 'NO_ACCESS' && error.message === DENIAL;
        Object.assign(row, { status: denied ? 'denied' : 'inconclusive',
          code: denied ? 'NO_ACCESS' : '',
          message: denied ? DENIAL : '结果未明确，请核对云端，不要重试。' });
      }
      report.results.push(row);
      if (row.status !== 'denied') throw new ProbeStop('已停止；不要再次批准或重试，等待管理端核对。');
      report.after = checkedTarget(await call('getMembers', { projectId: proof.projectId }));
      report.complete = true;
    } catch (error) {
      // 只输出本地固定提示，不转发云端／网络异常中的请求体或原始编号。
      report.stoppedReason = error instanceof ProbeStop ? error.message :
        '检查未完成，详情已隐藏；不要重试，等待管理端核对。';
    }
    return report;
  }
  return { validate, run };
}

module.exports = { createValidApprovalProbe };
