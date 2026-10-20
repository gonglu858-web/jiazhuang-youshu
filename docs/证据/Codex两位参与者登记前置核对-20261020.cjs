'use strict';
// 本地源码及已保存证据核对；不加载业务模块、不运行SDK、不连接平台。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const files = [
  'miniapp/scripts/package-sandbox-registration.cjs',
  'miniapp/scripts/package-business-test.cjs',
  'miniapp/cloudfunctions/scheduleSandbox/vendor/service.js',
  'docs/证据/Codex参与者I2夜间版本核对轮结果截图核对-20261020.json',
  'docs/证据/Codex参与者I2夜间版本核对轮字节核对-20261020.closed.json'
];
const buffers = files.map(f => fs.readFileSync(path.join(root, f)));
const registration = buffers[0].toString('utf8');
const business = buffers[1].toString('utf8');
const service = buffers[2].toString('utf8');
const result = JSON.parse(buffers[3]);
const close = JSON.parse(buffers[4]);
assert(registration.includes("if(p.allowedUserIds.length!==1)"));
assert(registration.includes("if(!p.synthetic&&p.allowedUserIds[0]!==CANDIDATE_USER_ID)"));
assert(service.includes("await add('users',"));
assert(service.includes("'registerIdentity'"));
assert(service.includes("const admin = await get('app_admins', 'primary');"));
assert(business.includes("schema: 'business-test-participant-record/1'"));
assert(business.includes('path.isAbsolute(recordPath)'));
assert.equal(result.observation.identityConfirmed, true);
assert.equal(result.observation.registrationState, 'ABSENT');
assert.equal(result.observation.userIdTail, '7dbd6e');
assert.equal(close.roundId, result.roundId);
assert.equal(close.matched, 8);
assert.equal(close.status, 'REMOTE_FILES_MATCH_FROZEN_I2_PACKAGE');
const report = {
  schema: 'codex-participant-registration-prerequisites/1',
  basisCommit: '2f6f0f1',
  observedAt: new Date().toISOString(),
  kind: 'local-static-source-and-saved-evidence-check',
  ok: true,
  sources: files.map((file, i) => ({ file, bytes: buffers[i].length, sha256: sha(buffers[i]) })),
  participant2Handoff: {
    source: '本聊天用户对当面核对及保存问题的明确答复',
    userQuote: '已当面核对并保存',
    personallyCheckedAndSavedByOwner: true,
    fullValueCopiedIntoProject: false,
    machinePrivateInputCompleted: false
  },
  participant1Scheduling: {
    presenceSource: '用户回复：1号现在也在场，可以安排',
    latestDecision: '用户拒绝22:30—23:00建议，回复：太晚了，改天另约；先整理本地方案',
    newWindowAgreed: false,
    newPackageCreated: false
  },
  findings: {
    oldRegistrationRealModeRestrictedToFixedOwner: true,
    oldRegistrationAllowsOneUserOnly: true,
    businessIdentityMayCreateUserAndAudit: true,
    businessIdentityReadsPrimary: true,
    participantEvidenceRequiresLocalRecordBinding: true,
    participant2RegistrationConfirmedAbsentAtObservation: true,
    laterRegistrationStateRefreshed: false
  },
  historicalClosure: {
    source: files[4],
    verifiedAt: close.observedAt,
    sourceFiles: close.matched,
    codeSha256: close.archiveSha256,
    queriedAgainThisTurn: false
  },
  limitations: [
    '静态源码观察不是新登记能力验收，未运行产品测试或SDK。',
    '本地文件结构校验不证明平台记录真实；ABSENT结果不能改写为登记回读。',
    '完整编号交付完成来自用户明确陈述；未复制完整值、未读取剪贴板。',
    '本轮只制定本地方案，没有运行云操作入口。'
  ]
};
const serialized = JSON.stringify(report, null, 2) + '\n';
if (process.argv.length === 2) process.stdout.write(serialized);
else {
  assert.equal(process.argv.length, 4);
  assert.equal(process.argv[2], '--out');
  fs.writeFileSync(process.argv[3], serialized, { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, sources: files.length, output: process.argv[3] }));
}
