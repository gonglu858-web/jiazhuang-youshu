// 临时开发核验配置：同一邀请重复批准并发检查。
// 本轮已执行完毕，配置已关闭，凭据已清空；历史真实值保留在 docs/证据/ 中，不再作为可执行配置。
// 不保存原始编号或邀请码。

const bindingProof = Object.freeze({
  evidenceId: '',
  userId: '',
  digest: '',
  expiresAt: '',
  verifiedAt: '',
  checkBefore: ''
});

module.exports = Object.freeze({
  enabled: false,
  evidenceId: '',
  projectId: '',
  actorId: '',
  applicantUserId: '',
  memberId: '',
  invitationId: '',
  issuedByUserId: '',
  role: '师傅',
  trades: Object.freeze([]),
  status: 'requested',
  invitationExpiresAt: '',
  verifiedAt: '',
  checkBefore: '',
  bindingProof
});
