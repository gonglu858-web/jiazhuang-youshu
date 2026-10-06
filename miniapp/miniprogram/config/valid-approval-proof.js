// 临时开发核验配置：只保存已核实的资源标识和编号散列引用，不保存原始编号或邀请码。
// 本轮使用独立的 bindingProof，避免重新启用已过期的 valid-binding-proof.js（指定管家检查）。

const bindingProof = Object.freeze({
  evidenceId: '6bca2f6d-dbed-4d70-94d7-850c79eb45c3',
  userId: 'u_a2acfbaea35f409671860b2c4b13d777a6989a74',
  digest: 'd75a8ab72434c8615ba0376ce835499049137dd8dcf34ead3370d5f3bb1a2a40',
  expiresAt: '2026-10-01T13:49:09.810Z',
  verifiedAt: '2026-09-30T13:54:59.042978+00:00',
  checkBefore: '2026-10-01T13:49:09.810Z'
});

module.exports = Object.freeze({
  evidenceId: 'valid-approval-renew-d24bf1f2-a57b-4ca1-9d8f-34f3e77e549e',
  projectId: 'p_38507fc9b43c4e23a7fbd996415637bb',
  actorId: 'u_15703f790f293a33c184af9eb0b8db9852f182f4',
  applicantUserId: 'u_a2acfbaea35f409671860b2c4b13d777a6989a74',
  memberId: 'm_4312a8548b3a432854ade093290e72c6ed5a6f7f',
  invitationId: 'i_0e0483488efb40ada6825d259ebc1736',
  issuedByUserId: 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d',
  role: '师傅',
  trades: Object.freeze(['拆改']),
  status: 'requested',
  invitationExpiresAt: '2026-10-07T12:20:14.221Z',
  verifiedAt: '2026-09-30T13:54:59.042978+00:00',
  checkBefore: '2026-10-01T13:49:09.810Z',
  bindingProof
});
