// 不同主业主申请并发唯一性检查：两个不同申请人争取同一项目唯一主业主位置。
// 默认禁用，启用后仍受凭据、时间窗、账号、项目、成员及 listInvitations 预检限制。
// 不保存原始编号；报告只含固定目标、证据标识、账号标签、起止时间、结果码及只读事后状态。
const { sha256Hex } = require('./sha256-hex');
const { bindingDigest } = require('./binding-digest');

const TARGET_APPID = 'wxfb4db1615ac15531';
const TARGET_ENVID = 'cloud1-d8gcq5ag39d847723';
const EXPECTED_ACTOR_ID = 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d';
const EXPECTED_OWNER_ID = 'u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4';
const EXPECTED_CANDIDATE_A_ID = 'u_a2acfbaea35f409671860b2c4b13d777a6989a74';
const EXPECTED_CANDIDATE_B_ID = 'u_15703f790f293a33c184af9eb0b8db9852f182f4';
const EXPECTED_CANDIDATE_A_LABEL = '候选甲';
const EXPECTED_CANDIDATE_B_LABEL = '候选乙';
const EXPECTED_MANAGER_ROLES = Object.freeze(['管家']);
const EXPECTED_ROLE = '主业主';
const EXPECTED_TRADES = Object.freeze([]);
const FORBIDDEN_PROJECTS = Object.freeze(new Set([
  'p_38507fc9b43c4e23a7fbd996415637bb',
  'p_a328c08992f7414c812047935bc3c31e'
]));
const EXPECTED_INVITATION_VERSION = 2;

class ProbeStop extends Error {}

function sameSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every(value => actual.includes(value));
}

function isNonEmptyString(value) { return typeof value === 'string' && value.length > 0; }

function parseFinite(date) { return isNonEmptyString(date) ? Date.parse(date) : NaN; }

function deriveMemberId(projectId, userId) {
  return 'm_' + sha256Hex(`${projectId}:${userId}`).slice(0, 40);
}

function deriveApplicantLabel(userId) {
  return `成员 ${userId.slice(-6)}`;
}

function createPrimaryOwnerConcurrencyProbe(proof) {
  let requestStarted = false;

  function validate(numberA, numberB, now = Date.now()) {
    if (!proof || proof.enabled !== true) {
      throw new ProbeStop('主业主并发唯一性检查默认禁用，缺少执行凭据，未发送请求。');
    }
    if (!isNonEmptyString(proof.evidenceId) || !isNonEmptyString(proof.projectId) ||
        !isNonEmptyString(proof.projectName) || !isNonEmptyString(proof.projectScope) ||
        !isNonEmptyString(proof.actorId) || !isNonEmptyString(proof.baselineAt) ||
        !isNonEmptyString(proof.checkBefore) || !Array.isArray(proof.candidates) ||
        proof.candidates.length !== 2) {
      throw new ProbeStop('主业主并发唯一性检查凭据不完整，未发送请求。');
    }
    if (proof.appId !== TARGET_APPID || proof.envId !== TARGET_ENVID) {
      throw new ProbeStop('本轮检查目标小程序或云环境与已核实范围不符，未发送请求。');
    }
    if (proof.projectScope !== 'identity-test' || FORBIDDEN_PROJECTS.has(proof.projectId)) {
      throw new ProbeStop('本轮检查目标项目或执行账号与已核实范围不符，未发送请求。');
    }
    if (proof.actorId !== EXPECTED_ACTOR_ID) {
      throw new ProbeStop('本轮仅供管家账号 64193d 执行，未发送请求。');
    }
    if (proof.primaryOwnerUserId !== '') {
      throw new ProbeStop('执行前项目主业主基线应为空，未发送请求。');
    }
    if (!Number.isInteger(proof.projectVersion) || proof.projectVersion <= 0) {
      throw new ProbeStop('项目版本基线无效，未发送请求。');
    }

    const [a, b] = proof.candidates;
    const expectedIdSet = new Set();
    if (!Array.isArray(proof.expectedMembers) || proof.expectedMembers.length !== 2) {
      throw new ProbeStop('预期成员基线不完整，未发送请求。');
    }
    for (const m of proof.expectedMembers) {
      if (!isNonEmptyString(m.userId) || !isNonEmptyString(m.memberId) ||
          !Array.isArray(m.roles) || !Array.isArray(m.trades) ||
          expectedIdSet.has(m.userId) || expectedIdSet.has(m.memberId)) {
        throw new ProbeStop('预期成员基线结构或唯一性不符，未发送请求。');
      }
      expectedIdSet.add(m.userId);
      expectedIdSet.add(m.memberId);
      const derivedMemberId = deriveMemberId(proof.projectId, m.userId);
      if (m.memberId !== derivedMemberId) {
        throw new ProbeStop('预期成员标识与项目确定性算法不符，未发送请求。');
      }
      const expectedRoles = m.userId === EXPECTED_OWNER_ID ? ['负责人'] : ['管家'];
      if (!sameSet(m.roles, expectedRoles) || !sameSet(m.trades, EXPECTED_TRADES)) {
        throw new ProbeStop('预期成员角色或工种与基线不符，未发送请求。');
      }
    }
    const ownerPresent = proof.expectedMembers.some(m => m.userId === EXPECTED_OWNER_ID);
    const managerPresent = proof.expectedMembers.some(m => m.userId === EXPECTED_ACTOR_ID);
    if (!ownerPresent || !managerPresent) {
      throw new ProbeStop('预期成员须包含负责人和管家，未发送请求。');
    }

    if (!a || !b || a.label === b.label || a.applicantUserId === b.applicantUserId ||
        a.invitationId === b.invitationId || a.expectedMemberId === b.expectedMemberId) {
      throw new ProbeStop('两份申请人或邀请凭据不独立，未发送请求。');
    }

    const candidateMap = [
      [EXPECTED_CANDIDATE_A_LABEL, EXPECTED_CANDIDATE_A_ID],
      [EXPECTED_CANDIDATE_B_LABEL, EXPECTED_CANDIDATE_B_ID]
    ];
    for (const cand of [a, b]) {
      if (!isNonEmptyString(cand.label) || !isNonEmptyString(cand.invitationId) ||
          !isNonEmptyString(cand.applicantUserId) || !isNonEmptyString(cand.expectedMemberId) ||
          cand.role !== EXPECTED_ROLE || cand.status !== 'requested' ||
          !sameSet(cand.trades, EXPECTED_TRADES) ||
          cand.issuedByUserId !== proof.actorId ||
          cand.invitationVersion !== EXPECTED_INVITATION_VERSION ||
          !isNonEmptyString(cand.invitationExpiresAt) ||
          !cand.bindingProof ||
          !isNonEmptyString(cand.bindingProof.evidenceId) ||
          !isNonEmptyString(cand.bindingProof.userId) ||
          !isNonEmptyString(cand.bindingProof.digest) ||
          !isNonEmptyString(cand.bindingProof.expiresAt) ||
          !isNonEmptyString(cand.bindingProof.verifiedAt) ||
          !isNonEmptyString(cand.bindingProof.checkBefore)) {
        throw new ProbeStop('主业主并发唯一性检查候选人凭据不完整，未发送请求。');
      }
      const expectedId = candidateMap.find(pair => pair[0] === cand.label);
      if (!expectedId || cand.applicantUserId !== expectedId[1]) {
        throw new ProbeStop('候选人标签与既定申请人账号不对应，未发送请求。');
      }
      if (cand.bindingProof.userId !== cand.applicantUserId) {
        throw new ProbeStop('候选人编号归属与申请人不一致，未发送请求。');
      }
      const derivedMemberId = deriveMemberId(proof.projectId, cand.applicantUserId);
      if (cand.expectedMemberId !== derivedMemberId) {
        throw new ProbeStop('候选人预期成员标识与项目确定性算法不符，未发送请求。');
      }
      if (expectedIdSet.has(cand.applicantUserId) || expectedIdSet.has(cand.expectedMemberId)) {
        throw new ProbeStop('候选人标识与预期成员冲突，未发送请求。');
      }
      if ([EXPECTED_OWNER_ID, EXPECTED_ACTOR_ID].includes(cand.applicantUserId)) {
        throw new ProbeStop('申请人不得为负责人或管家账号，未发送请求。');
      }
    }

    const dates = [now, parseFinite(proof.verifiedAt), parseFinite(proof.checkBefore),
      parseFinite(proof.baselineAt)];
    const deadlines = [parseFinite(proof.checkBefore)];
    const verifieds = [parseFinite(proof.verifiedAt)];

    for (const cand of [a, b]) {
      dates.push(parseFinite(cand.invitationExpiresAt),
        parseFinite(cand.bindingProof.expiresAt),
        parseFinite(cand.bindingProof.verifiedAt),
        parseFinite(cand.bindingProof.checkBefore));
      deadlines.push(parseFinite(cand.invitationExpiresAt),
        parseFinite(cand.bindingProof.expiresAt),
        parseFinite(cand.bindingProof.checkBefore));
      verifieds.push(parseFinite(cand.bindingProof.verifiedAt));
    }

    if (!dates.every(Number.isFinite)) {
      throw new ProbeStop('凭据日期格式无效，未发送请求。');
    }
    if (now < Math.max(...verifieds)) {
      throw new ProbeStop('核验时间在未来，未发送请求。');
    }
    if (now < parseFinite(proof.baselineAt)) {
      throw new ProbeStop('基线时间在未来，未发送请求。');
    }
    const earliestDeadline = Math.min(...deadlines);
    if (now >= earliestDeadline) {
      throw new ProbeStop('本轮编号或邀请核验窗口已结束，未发送请求。');
    }
    if (parseFinite(proof.checkBefore) > earliestDeadline) {
      throw new ProbeStop('总体截止时间不得晚于任一邀请或编号有效期，未发送请求。');
    }

    let digestA, digestB;
    try { digestA = bindingDigest(numberA); }
    catch (_) { throw new ProbeStop('请输入候选甲本人提供的十位绑定编号。'); }
    try { digestB = bindingDigest(numberB); }
    catch (_) { throw new ProbeStop('请输入候选乙本人提供的十位绑定编号。'); }
    if (digestA === digestB || digestA !== a.bindingProof.digest || digestB !== b.bindingProof.digest) {
      throw new ProbeStop('输入的编号与本轮管理端核验不一致，未发送请求。');
    }

    return {
      evidenceId: proof.evidenceId,
      checkBefore: new Date(earliestDeadline).toISOString(),
      validationSource: '管理端事前核实；事后仍须复核项目、成员、邀请和审计'
    };
  }

  function checkedProject(project) {
    if (!project || project.id !== proof.projectId || project.name !== proof.projectName ||
        project.scope !== proof.projectScope || project.status !== 'active' ||
        !sameSet(project.roles, EXPECTED_MANAGER_ROLES)) {
      throw new ProbeStop('当前项目或管家身份不符合本轮基线，已停止。');
    }
    return {
      projectId: project.id,
      projectName: project.name,
      scope: project.scope,
      roles: project.roles.slice()
    };
  }

  function checkedMembers(access) {
    if (!Array.isArray(access.members)) throw new ProbeStop('成员列表响应无效，已停止。');
    if (access.members.length !== proof.expectedMembers.length) {
      throw new ProbeStop('项目成员数量与基线不符，已停止。');
    }
    const seenUserIds = new Set();
    const seenMemberIds = new Set();
    for (const expected of proof.expectedMembers) {
      const matches = access.members.filter(row => row.userId === expected.userId);
      if (matches.length !== 1) throw new ProbeStop('负责人或管家成员与基线不符，已停止。');
      const row = matches[0];
      if (row.id !== expected.memberId || !sameSet(row.roles, expected.roles) ||
          !Array.isArray(row.trades) || !sameSet(row.trades, EXPECTED_TRADES)) {
        throw new ProbeStop('负责人或管家成员标识、角色或工种与基线不符，已停止。');
      }
      if (seenUserIds.has(row.userId) || seenMemberIds.has(row.id)) {
        throw new ProbeStop('项目成员存在重复标识，已停止。');
      }
      seenUserIds.add(row.userId);
      seenMemberIds.add(row.id);
    }
    for (const cand of proof.candidates) {
      if (access.members.some(row => row.userId === cand.applicantUserId || row.id === cand.expectedMemberId)) {
        throw new ProbeStop('候选人已是项目成员，不满足并发唯一性前置条件，已停止。');
      }
    }
    return {
      expectedPresent: proof.expectedMembers.map(e => e.userId),
      candidatesAbsent: proof.candidates.map(c => c.applicantUserId)
    };
  }

  function checkedInvitations(invitations) {
    if (!Array.isArray(invitations)) throw new ProbeStop('待核对申请列表响应无效，已停止。');
    if (invitations.length !== proof.candidates.length) {
      throw new ProbeStop('待核对申请数量与基线不符，已停止。');
    }
    const seenIds = new Set();
    const result = [];
    for (const cand of proof.candidates) {
      const matches = invitations.filter(row => row.id === cand.invitationId);
      if (matches.length !== 1) throw new ProbeStop(`目标申请 ${cand.label} 不唯一或缺失，已停止。`);
      const inv = matches[0];
      if (inv.role !== EXPECTED_ROLE || !Array.isArray(inv.trades) ||
          !sameSet(inv.trades, EXPECTED_TRADES) ||
          inv.applicantLabel !== deriveApplicantLabel(cand.applicantUserId) ||
          !isNonEmptyString(inv.requestedAt) || !Number.isFinite(parseFinite(inv.requestedAt))) {
        throw new ProbeStop(`目标申请 ${cand.label} 与公开基线不符，已停止。`);
      }
      if (seenIds.has(inv.id)) throw new ProbeStop('待核对申请存在重复标识，已停止。');
      seenIds.add(inv.id);
      result.push({
        label: cand.label,
        invitationId: inv.id,
        snapshot: {
          id: inv.id,
          role: inv.role,
          trades: inv.trades.slice(),
          applicantLabel: inv.applicantLabel,
          requestedAt: inv.requestedAt
        }
      });
    }
    return result;
  }

  function checkedApprovalResult(result, expectedInvitationId) {
    if (result && result.invitationId === expectedInvitationId && result.status === 'approved') {
      return { ok: true, invitationId: result.invitationId, status: result.status };
    }
    return { ok: false };
  }

  function summarizeError(error) {
    const businessCode = error && error.businessCode;
    if (businessCode === 'OWNER_EXISTS') {
      return { status: 'business_denied', code: 'OWNER_EXISTS', message: '目标项目已存在主业主。' };
    }
    if (businessCode === 'CODE_INVALID') {
      return { status: 'business_denied', code: 'CODE_INVALID', message: '邀请未待核对或编号已失效。' };
    }
    if (businessCode === 'NO_ACCESS') {
      return { status: 'business_denied', code: 'NO_ACCESS', message: '权限拒绝。' };
    }
    return { status: 'inconclusive', code: '', message: '结果未明确，请核对云端，不要重试。' };
  }

  const ALLOWED_AFTER_READ_CODES = Object.freeze(new Set(['OWNER_EXISTS', 'CODE_INVALID', 'NO_ACCESS']));

  function safeAfterReadError(error) {
    const code = error && error.businessCode;
    return {
      message: '事后只读观察失败，请核对云端，不要重试。',
      code: ALLOWED_AFTER_READ_CODES.has(code) ? code : ''
    };
  }

  function checkedAfterState(access, invitationsResponse, report) {
    if (!access || !Array.isArray(access.members) || !access.project ||
        !invitationsResponse || !Array.isArray(invitationsResponse.invitations)) {
      throw new ProbeStop('事后只读响应格式无效，已停止。');
    }
    const project = access.project;
    if (project.id !== proof.projectId || project.name !== proof.projectName ||
        project.scope !== proof.projectScope || project.status !== 'active' ||
        !sameSet(project.roles, EXPECTED_MANAGER_ROLES)) {
      throw new ProbeStop('事后项目或管家身份与基线不符，已停止。');
    }

    const winnerResult = report.results.find(row => row.status === 'success');
    const loserResult = report.results.find(row => row.status === 'business_denied' && row.code === 'OWNER_EXISTS');
    const winner = winnerResult && proof.candidates.find(c => c.label === winnerResult.candidate);
    const loser = loserResult && proof.candidates.find(c => c.label === loserResult.candidate);

    if (!winner || !loser) throw new ProbeStop('无法从结果中确定胜败方，已停止。');

    if (access.members.length !== proof.expectedMembers.length + 1) {
      throw new ProbeStop('事后成员数量与预期不符，已停止。');
    }
    const seenUserIds = new Set();
    const seenMemberIds = new Set();
    for (const expected of proof.expectedMembers) {
      const matches = access.members.filter(row => row.userId === expected.userId);
      if (matches.length !== 1) throw new ProbeStop('事后原负责人或管家成员缺失，已停止。');
      const row = matches[0];
      if (row.id !== expected.memberId || !sameSet(row.roles, expected.roles) ||
          !Array.isArray(row.trades) || !sameSet(row.trades, EXPECTED_TRADES)) {
        throw new ProbeStop('事后原负责人或管家成员状态改变，已停止。');
      }
      if (seenUserIds.has(row.userId) || seenMemberIds.has(row.id)) {
        throw new ProbeStop('事后项目成员存在重复标识，已停止。');
      }
      seenUserIds.add(row.userId);
      seenMemberIds.add(row.id);
    }

    const winnerMember = access.members.find(row =>
      row.userId === winner.applicantUserId && row.id === winner.expectedMemberId);
    if (!winnerMember || !sameSet(winnerMember.roles, [EXPECTED_ROLE]) ||
        !Array.isArray(winnerMember.trades) || !sameSet(winnerMember.trades, EXPECTED_TRADES)) {
      throw new ProbeStop('胜方成员状态与预期不符，已停止。');
    }
    if (seenUserIds.has(winnerMember.userId) || seenMemberIds.has(winnerMember.id)) {
      throw new ProbeStop('胜方成员标识与原有成员冲突，已停止。');
    }
    seenUserIds.add(winnerMember.userId);
    seenMemberIds.add(winnerMember.id);

    const loserMember = access.members.find(row =>
      row.userId === loser.applicantUserId || row.id === loser.expectedMemberId);
    if (loserMember) throw new ProbeStop('败方仍出现在项目成员中，已停止。');

    const pending = invitationsResponse.invitations;
    if (pending.length !== 1 || pending[0].id !== loser.invitationId) {
      throw new ProbeStop('事后败方待核对申请不唯一或缺失，已停止。');
    }
    const loserInvitation = pending[0];
    const preflightInvitations = report.preflight[2];
    const loserSnapshotItem = preflightInvitations && preflightInvitations.find(item => item.label === loser.label);
    const loserSnapshot = loserSnapshotItem && loserSnapshotItem.snapshot;
    if (!loserSnapshot) throw new ProbeStop('缺少预检申请快照，已停止。');
    if (loserInvitation.id !== loserSnapshot.id ||
        loserInvitation.role !== loserSnapshot.role ||
        !Array.isArray(loserInvitation.trades) ||
        !sameSet(loserInvitation.trades, loserSnapshot.trades) ||
        loserInvitation.applicantLabel !== loserSnapshot.applicantLabel ||
        loserInvitation.requestedAt !== loserSnapshot.requestedAt) {
      throw new ProbeStop('事后败方待核对申请公开字段与基线不符，已停止。');
    }
    if (pending.some(row => row.id === winner.invitationId)) {
      throw new ProbeStop('胜方申请仍在待核对列表，与一次成功的结果矛盾，已停止。');
    }

    return {
      winner: {
        candidate: winner.label,
        userId: winnerMember.userId,
        memberId: winnerMember.id,
        roles: winnerMember.roles.slice(),
        trades: (winnerMember.trades || []).slice()
      },
      loser: {
        candidate: loser.label,
        invitationStillPending: true,
        memberFound: false
      },
      projectPrimaryOwnerUserId: '管理端事后核验',
      otherPendingInvitations: pending
        .filter(row => row.id !== loser.invitationId)
        .map(item => ({ id: item.id, role: item.role, applicantLabel: item.applicantLabel }))
    };
  }

  async function run(call, numberA, numberB, storage = { get: () => {}, set: () => {} }, now = () => Date.now()) {
    let candidateLabels = [];
    let candidatesMalformed = false;
    if (proof && Array.isArray(proof.candidates)) {
      for (let i = 0; i < proof.candidates.length; i++) {
        const c = proof.candidates[i];
        if (!c || typeof c !== 'object') {
          candidatesMalformed = true;
          break;
        }
        candidateLabels.push(typeof c.label === 'string' ? c.label : '');
      }
    } else {
      candidatesMalformed = true;
    }

    const report = {
      version: 1,
      mode: 'primary-owner-concurrency',
      account: '',
      complete: false,
      expectedCount: 2,
      projectId: proof && proof.projectId || '',
      projectName: proof && proof.projectName || '',
      actorId: proof && proof.actorId || '',
      candidateLabels,
      credential: null,
      preflight: [],
      results: [],
      after: null,
      stoppedReason: '',
      candidate: null
    };

    if (candidatesMalformed) {
      report.stoppedReason = '候选人凭据结构异常，未发送请求。';
      return report;
    }

    try {
      report.credential = validate(numberA, numberB, now());
      const identity = await call('identify');
      if (!identity || identity.isAdmin !== false || identity.userId !== EXPECTED_ACTOR_ID) {
        throw new ProbeStop('本轮仅供管家账号 64193d 检查，未发送批准请求。');
      }
      report.account = '本人账号 64193d';

      const membersAccess = await call('getMembers', { projectId: proof.projectId });
      if (!membersAccess || !membersAccess.project || !Array.isArray(membersAccess.members)) {
        throw new ProbeStop('项目成员响应结构无效，已停止。');
      }
      report.preflight.push(checkedProject(membersAccess.project));
      report.preflight.push(checkedMembers(membersAccess));

      const listResult = await call('listInvitations', { projectId: proof.projectId });
      if (!listResult || !Array.isArray(listResult.invitations)) {
        throw new ProbeStop('待核对申请列表响应无效，已停止。');
      }
      report.preflight.push(checkedInvitations(listResult.invitations));
      report.credential = validate(numberA, numberB, now());

      let marker;
      try { marker = storage.get('yf-primary-owner-concurrency-' + proof.evidenceId); }
      catch (_) { throw new ProbeStop('本机防重标记读取失败，未发送批准请求。'); }
      if (requestStarted || (marker && marker.started)) {
        throw new ProbeStop('本机已发送过本轮并发检查，不自动重试。');
      }
      requestStarted = true;

      const newMarker = { started: true, evidenceId: proof.evidenceId, at: new Date(now()).toISOString() };
      try { storage.set('yf-primary-owner-concurrency-' + proof.evidenceId, newMarker); }
      catch (_) { throw new ProbeStop('本机防重标记保存失败，未发送批准请求。'); }

      const launchedAt = new Date(now()).toISOString();
      const makeCall = async (cand, number) => {
        const startedAt = new Date(now()).toISOString();
        try {
          const result = await call('approveInvitation', {
            projectId: proof.projectId,
            invitationId: cand.invitationId,
            applicantNumber: number
          });
          const checked = checkedApprovalResult(result, cand.invitationId);
          if (checked.ok) {
            return {
              candidate: cand.label,
              invitationId: cand.invitationId,
              applicantUserId: cand.applicantUserId,
              status: 'success',
              code: '',
              message: '批准请求成功。',
              resourceId: checked.invitationId,
              startedAt,
              completedAt: new Date(now()).toISOString()
            };
          }
          return {
            candidate: cand.label,
            invitationId: cand.invitationId,
            applicantUserId: cand.applicantUserId,
            status: 'inconclusive',
            code: '',
            message: '响应结构不符合预期，请核对云端，不要重试。',
            resourceId: '',
            startedAt,
            completedAt: new Date(now()).toISOString()
          };
        } catch (error) {
          const summary = summarizeError(error);
          return {
            candidate: cand.label,
            invitationId: cand.invitationId,
            applicantUserId: cand.applicantUserId,
            ...summary,
            resourceId: '',
            startedAt,
            completedAt: new Date(now()).toISOString()
          };
        }
      };

      report.results = await Promise.all([
        makeCall(proof.candidates[0], numberA),
        makeCall(proof.candidates[1], numberB)
      ]);
      report.launchedAt = launchedAt;

      const successes = report.results.filter(row => row.status === 'success');
      const ownerExists = report.results.filter(row =>
        row.status === 'business_denied' && row.code === 'OWNER_EXISTS');
      if (successes.length === 1 && ownerExists.length === 1) {
        report.candidate = {
          summary: '一成功、一OWNER_EXISTS',
          verifiedByCloudBaseline: false,
          winner: successes[0].candidate,
          loser: ownerExists[0].candidate
        };
      } else if (successes.length === 0) {
        throw new ProbeStop('两次批准请求均未成功，停止并等待管理端核对。');
      } else if (successes.length === 2) {
        throw new ProbeStop('两次批准请求均返回成功，停止并等待管理端核对。');
      } else {
        throw new ProbeStop('存在结果未明确的调用，停止并等待管理端核对。');
      }

      try {
        const afterMembers = await call('getMembers', { projectId: proof.projectId });
        const afterInvitations = await call('listInvitations', { projectId: proof.projectId });
        report.after = checkedAfterState(afterMembers, afterInvitations, report);
      } catch (error) {
        if (error instanceof ProbeStop) throw error;
        report.afterReadError = safeAfterReadError(error);
        report.complete = false;
        report.stoppedReason = '事后只读观察失败，停止并等待管理端核对。';
        return report;
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

module.exports = { createPrimaryOwnerConcurrencyProbe };