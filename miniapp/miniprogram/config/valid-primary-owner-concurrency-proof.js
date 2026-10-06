// 临时开发核验配置：不同申请人争取同一项目唯一主业主位置的并发唯一性检查。
// 默认禁用，启用前须经管理端审查并填入实际凭据；不保存原始绑定编号或邀请码。

const bindingProofA = Object.freeze({
  evidenceId: '',
  userId: 'u_a2acfbaea35f409671860b2c4b13d777a6989a74',
  digest: '',
  expiresAt: '',
  verifiedAt: '',
  checkBefore: ''
});

const bindingProofB = Object.freeze({
  evidenceId: '',
  userId: 'u_15703f790f293a33c184af9eb0b8db9852f182f4',
  digest: '',
  expiresAt: '',
  verifiedAt: '',
  checkBefore: ''
});

const candidateA = Object.freeze({
  label: '候选甲',
  invitationId: '',
  applicantUserId: 'u_a2acfbaea35f409671860b2c4b13d777a6989a74',
  expectedMemberId: '',
  role: '主业主',
  trades: Object.freeze([]),
  status: 'requested',
  invitationVersion: 2,
  invitationExpiresAt: '',
  issuedByUserId: 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d',
  bindingProof: bindingProofA
});

const candidateB = Object.freeze({
  label: '候选乙',
  invitationId: '',
  applicantUserId: 'u_15703f790f293a33c184af9eb0b8db9852f182f4',
  expectedMemberId: '',
  role: '主业主',
  trades: Object.freeze([]),
  status: 'requested',
  invitationVersion: 2,
  invitationExpiresAt: '',
  issuedByUserId: 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d',
  bindingProof: bindingProofB
});

module.exports = Object.freeze({
  enabled: false,
  evidenceId: '',
  appId: 'wxfb4db1615ac15531',
  envId: 'cloud1-d8gcq5ag39d847723',
  projectId: '',
  projectName: '',
  projectScope: 'identity-test',
  projectVersion: '',
  actorId: 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d',
  baselineAt: '',
  verifiedAt: '',
  checkBefore: '',
  primaryOwnerUserId: '',
  expectedMembers: Object.freeze([
    Object.freeze({ userId: 'u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4', memberId: '', roles: Object.freeze(['负责人']), trades: Object.freeze([]) }),
    Object.freeze({ userId: 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d', memberId: '', roles: Object.freeze(['管家']), trades: Object.freeze([]) })
  ]),
  candidates: Object.freeze([candidateA, candidateB])
});
