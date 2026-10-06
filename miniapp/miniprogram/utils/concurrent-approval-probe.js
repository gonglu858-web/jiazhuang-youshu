// 同一邀请重复批准并发检查：一次发送两条参数完全相同的 approveInvitation。
// 默认禁用，启用后仍受凭据、时间窗、账号、项目、成员及 listInvitations 预检限制。
// 不保存原始编号；报告只含固定目标、证据标识、真实账号标签、起止时间、结果码及只读事后状态。
const { bindingDigest } = require('./binding-digest');
const { MEMBER_TARGET } = require('./member-write-probe');

const EXPECTED_INVITATION_ID = 'i_0e0483488efb40ada6825d259ebc1736';
const EXPECTED_MANAGER_ID = 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d';
const EXPECTED_APPLICANT_ID = 'u_a2acfbaea35f409671860b2c4b13d777a6989a74';
const EXPECTED_MEMBER_ID = 'm_4312a8548b3a432854ade093290e72c6ed5a6f7f';
const EXPECTED_PROJECT_ID = 'p_38507fc9b43c4e23a7fbd996415637bb';
const EXPECTED_ROLE = '师傅';
const EXPECTED_TRADES = Object.freeze(['拆改']);
const EXPECTED_ROLES = Object.freeze(['师傅', '设计师']);
const EXPECTED_TRADES_MEMBER = Object.freeze(['拆改', '木工']);

class ProbeStop extends Error {}

function sameSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every(value => actual.includes(value));
}

function isNonEmptyString(value) { return typeof value === 'string' && value.length > 0; }

function createConcurrentApprovalProbe(proof) {
  let requestStarted = false;

  function validate(number, now = Date.now()) {
    if (!proof || proof.enabled !== true) {
      throw new ProbeStop('并发批准检查默认禁用，缺少执行凭据，未发送请求。');
    }
    if (!isNonEmptyString(proof.evidenceId) || !isNonEmptyString(proof.projectId) ||
        !isNonEmptyString(proof.actorId) || !isNonEmptyString(proof.applicantUserId) ||
        !isNonEmptyString(proof.memberId) || !isNonEmptyString(proof.invitationId) ||
        !isNonEmptyString(proof.issuedByUserId) || !isNonEmptyString(proof.verifiedAt) ||
        !isNonEmptyString(proof.checkBefore) || !isNonEmptyString(proof.invitationExpiresAt) ||
        !isNonEmptyString(proof.bindingProof.evidenceId) ||
        !isNonEmptyString(proof.bindingProof.userId) ||
        !isNonEmptyString(proof.bindingProof.digest) ||
        !isNonEmptyString(proof.bindingProof.expiresAt) ||
        !isNonEmptyString(proof.bindingProof.verifiedAt) ||
        !isNonEmptyString(proof.bindingProof.checkBefore)) {
      throw new ProbeStop('并发批准检查凭据不完整，未发送请求。');
    }
    if (proof.projectId !== EXPECTED_PROJECT_ID || proof.actorId !== EXPECTED_MANAGER_ID ||
        proof.applicantUserId !== EXPECTED_APPLICANT_ID || proof.memberId !== EXPECTED_MEMBER_ID ||
        proof.invitationId !== EXPECTED_INVITATION_ID || proof.issuedByUserId !== EXPECTED_MANAGER_ID ||
        proof.role !== EXPECTED_ROLE || !sameSet(proof.trades, EXPECTED_TRADES) ||
        proof.status !== 'requested' || proof.bindingProof.userId !== EXPECTED_APPLICANT_ID) {
      throw new ProbeStop('本轮并发检查目标与已核实范围不符，未发送请求。');
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
    if (![now, verified, bindingVerified, bindingExpiry, invitationExpiry, deadline, bindingDeadline]
        .every(Number.isFinite) ||
        now < Math.max(verified, bindingVerified) ||
        now >= Math.min(bindingExpiry, invitationExpiry, deadline, bindingDeadline)) {
      throw new ProbeStop('本轮编号或邀请核验窗口已结束，未发送请求。');
    }
    return { evidenceId: proof.evidenceId, bindingEvidenceId: proof.bindingProof.evidenceId,
      invitationId: proof.invitationId, invitationExpiresAt: proof.invitationExpiresAt,
      bindingExpiresAt: proof.bindingProof.expiresAt,
      checkBefore: new Date(Math.min(bindingExpiry, invitationExpiry, deadline, bindingDeadline)).toISOString(),
      validationSource: '管理端事前核实；事后仍须复核申请、编号、成员和审计' };
  }

  function checkedProject(access) {
    const project = access && access.project;
    if (!project || project.id !== proof.projectId || project.scope !== 'identity-test' ||
        project.status !== 'active' || !sameSet(project.roles, ['管家'])) {
      throw new ProbeStop('当前项目或管家身份不符合本轮条件，已停止。');
    }
    return { projectId: project.id, roles: project.roles.slice() };
  }

  function checkedMember(access) {
    if (!Array.isArray(access.members)) throw new ProbeStop('成员列表响应无效，已停止。');
    const matches = access.members.filter(row => row.id === proof.memberId);
    const member = matches[0];
    if (matches.length !== 1 || member.label !== '成员 989a74' ||
        !sameSet(member.roles, EXPECTED_ROLES) || !sameSet(member.trades, EXPECTED_TRADES_MEMBER)) {
      throw new ProbeStop('申请人现有成员角色或工种发生变化，已停止。');
    }
    return { memberId: member.id, roles: member.roles.slice(), trades: member.trades.slice() };
  }

  function checkedInvitation(invitations) {
    if (!Array.isArray(invitations)) throw new ProbeStop('待核对申请列表响应无效，已停止。');
    const matches = invitations.filter(row => row.id === proof.invitationId);
    const invitation = matches[0];
    if (matches.length !== 1 || invitation.role !== EXPECTED_ROLE ||
        !sameSet(invitation.trades, EXPECTED_TRADES) ||
        invitation.applicantLabel !== '成员 989a74') {
      throw new ProbeStop('目标待核对申请与已核实范围不符，已停止。');
    }
    return { invitations, invitationId: invitation.id, role: invitation.role, trades: invitation.trades.slice(),
      applicantLabel: invitation.applicantLabel };
  }

  function checkedApprovalResult(result) {
    if (result && result.invitationId === proof.invitationId && result.status === 'approved') {
      return { ok: true, invitationId: result.invitationId, status: result.status };
    }
    return { ok: false };
  }

  function summarizeError(error) {
    const businessCode = error && error.businessCode;
    if (businessCode === 'CODE_INVALID') return { status: 'business_denied', code: 'CODE_INVALID', message: '邀请未待核对或编号已失效。' };
    if (businessCode === 'NO_ACCESS') return { status: 'business_denied', code: 'NO_ACCESS', message: '权限拒绝。' };
    // 未知错误码、原始消息或任意底层内容均不透传。
    return { status: 'inconclusive', code: '', message: '结果未明确，请核对云端，不要重试。' };
  }

  const ALLOWED_AFTER_READ_CODES = Object.freeze(new Set(['CODE_INVALID', 'NO_ACCESS']));

  function safeAfterReadError(error) {
    const code = error && error.businessCode;
    return { message: '事后只读观察失败，请核对云端，不要重试。',
      code: ALLOWED_AFTER_READ_CODES.has(code) ? code : '' };
  }

  // 事后只读观察：验证列表响应结构合法，记录目标是否仍在待核对列表。
  // 批准后目标应从此列表消失；空数组或只剩其他申请均是合法响应。
  function checkedAfterInvitations(afterInvitations) {
    if (!afterInvitations || !Array.isArray(afterInvitations.invitations)) {
      throw new ProbeStop('待核对申请列表响应无效，已停止。');
    }
    const stillThere = afterInvitations.invitations.some(row => row.id === proof.invitationId);
    const others = afterInvitations.invitations
      .filter(row => row.id !== proof.invitationId)
      .map(item => ({ id: item.id, role: item.role, applicantLabel: item.applicantLabel }));
    return { stillThere, others };
  }

  async function run(call, number, storage = { get: () => {}, set: () => {} }, now = () => Date.now()) {
    const report = { version: 1, mode: 'concurrent-approval',
      account: '', complete: false, expectedCount: 2,
      projectId: EXPECTED_PROJECT_ID, invitationId: EXPECTED_INVITATION_ID,
      targetMemberId: EXPECTED_MEMBER_ID, targetUserId: EXPECTED_APPLICANT_ID,
      credential: null, preflight: [], results: [], after: null, stoppedReason: '',
      candidate: null };
    try {
      report.credential = validate(number, now());
      const identity = await call('identify');
      if (!identity || identity.isAdmin !== false || identity.userId !== EXPECTED_MANAGER_ID) {
        throw new ProbeStop('本轮仅供管家账号 64193d 检查，未发送批准请求。');
      }
      report.account = '本人账号 64193d';
      report.preflight.push(checkedProject(await call('getMembers', { projectId: proof.projectId })));
      report.preflight.push(checkedMember(await call('getMembers', { projectId: proof.projectId })));
      const listResult = await call('listInvitations', { projectId: proof.projectId });
      if (!listResult || !Array.isArray(listResult.invitations)) {
        throw new ProbeStop('待核对申请列表响应无效，已停止。');
      }
      report.preflight.push(checkedInvitation(listResult.invitations));
      validate(number, now());

      // 本机轮次防重：读取失败、已存在标记或同实例已启动均不发送。
      let marker;
      try { marker = storage.get('yf-concurrent-approval-' + proof.evidenceId); }
      catch (_) { throw new ProbeStop('本机防重标记读取失败，未发送批准请求。'); }
      if (requestStarted || (marker && marker.started)) {
        throw new ProbeStop('本机已发送过本轮并发检查，不自动重试。');
      }
      requestStarted = true;

      // 不含原始编号的独立轮次防重标记；存储失败则不发送。
      const newMarker = { started: true, evidenceId: proof.evidenceId, at: new Date(now()).toISOString() };
      try { storage.set('yf-concurrent-approval-' + proof.evidenceId, newMarker); }
      catch (_) { throw new ProbeStop('本机防重标记保存失败，未发送批准请求。'); }

      const input = { projectId: proof.projectId, invitationId: proof.invitationId, applicantNumber: number };
      const launchedAt = new Date(now()).toISOString();
      const makeCall = async () => {
        const startedAt = new Date(now()).toISOString();
        try {
          const result = await call('approveInvitation', input);
          const checked = checkedApprovalResult(result);
          if (checked.ok) {
            return { status: 'success', code: '', message: '批准请求成功。',
              resourceId: checked.invitationId, startedAt,
              completedAt: new Date(now()).toISOString() };
          }
          return { status: 'inconclusive', code: '', message: '响应结构不符合预期，请核对云端，不要重试。',
            resourceId: '', startedAt, completedAt: new Date(now()).toISOString() };
        } catch (error) {
          const summary = summarizeError(error);
          return { ...summary, resourceId: '', startedAt, completedAt: new Date(now()).toISOString() };
        }
      };
      report.results = await Promise.all([makeCall(), makeCall()]);
      report.launchedAt = launchedAt;

      // 正常候选结果：一条成功、一条明确业务拒绝；其余情况均停止并交管理端核对。
      const successes = report.results.filter(row => row.status === 'success');
      const businessDenials = report.results.filter(row => row.status === 'business_denied');
      if (successes.length === 1 && businessDenials.length === 1) {
        report.candidate = { summary: '一次成功、一次业务拒绝', verifiedByCloudBaseline: false };
      } else if (successes.length === 0) {
        throw new ProbeStop('两次批准请求均未成功，停止并等待管理端核对。');
      } else if (successes.length === 2) {
        throw new ProbeStop('两次批准请求均返回成功，停止并等待管理端核对。');
      } else {
        throw new ProbeStop('存在结果未明确的调用，停止并等待管理端核对。');
      }

      try {
        const afterMember = await call('getMembers', { projectId: proof.projectId });
        const afterInvitations = await call('listInvitations', { projectId: proof.projectId });
        const checkedAfter = checkedAfterInvitations(afterInvitations);
        if (checkedAfter.stillThere) {
          throw new ProbeStop('目标申请仍在待核对列表，与一次成功的结果矛盾，已停止。');
        }
        report.after = {
          member: checkedMember(afterMember),
          invitations: checkedAfter.others,
          targetRemoved: true
        };
      } catch (error) {
        // 结构验证失败属于检查失败，必须停止；其他读取失败记录安全摘要但保留候选结果。
        if (error instanceof ProbeStop) throw error;
        report.afterReadError = safeAfterReadError(error);
      }
      report.complete = true;
    } catch (error) {
      report.stoppedReason = error instanceof ProbeStop ? error.message :
        '检查未完成，详情已隐藏；不要重试，等待管理端核对。';
    }
    return report;
  }

  return { validate, run };
}

module.exports = { createConcurrentApprovalProbe };
