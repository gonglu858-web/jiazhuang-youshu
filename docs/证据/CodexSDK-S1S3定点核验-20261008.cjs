'use strict';
// Offline only. Synthetic credentials/CLI/worker, actual parent orchestration.
// Creates empty temporary isolation directories; writes results to stdout only.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const o = require(path.join(root, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
const target = 'u_' + 'a'.repeat(40);
const requestId = '00000000-0000-4000-8000-000000000001';
const valid = () => ({ ok: true, writeAttemptsCount: 0, credentialExpiredDuringRun: false,
  primary: { classification: 'OBSERVED', docId: 'primary', userId: target, status: 'active', userIdShapeValid: true, statusValid: true },
  targetUser: { classification: 'OBSERVED', docId: target, status: 'active', statusValid: true,
    openidPresent: true, openidShapeValid: true, derivationChecked: true, derivationMatches: true } });
function interpret(payload) {
  const normalized = o.interpretWorkerOutput({ code: 0, stdout: JSON.stringify(payload), targetUserId: target });
  return { primary: o.interpretPrimary(normalized, target), users: o.interpretTargetUser(normalized, target) };
}
async function finishExpiry(workerFailure, expireOnClose) {
  const base = Date.now();
  let clock = base;
  const stages = [];
  let workerReturned = false;
  const report = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: target }, {
    now: () => clock, baseEnv: {},
    fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sdk-s123-')) },
    fetchCredential: async () => JSON.stringify({ secretId: 'synthetic-id', secretKey: 'synthetic-key', token: 'synthetic-token',
      expiredAt: new Date(base + 600000).toISOString(), isTemporary: true, envId: o.FIXED.envId }),
    spawn: (bin, args) => {
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
      c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
      const isWorker = args.length === 1;
      stages.push(isWorker ? 'worker' : args[2] + '.' + args[3]);
      setImmediate(() => {
        let payload;
        if (isWorker) {
          payload = workerFailure ? { ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 } : valid();
          workerReturned = true;
        } else {
          const account = '123456789012';
          payload = { data: {
            'sts.GetCallerIdentity': { Type: 'CAMRole', AccountId: account, UserId: 'u', PrincipalId: 'p',
              Arn: 'qcs::cam::uin/' + account + ':role/r', RequestId: requestId },
            'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region }], RequestId: requestId },
            'tcb.DescribeEnvInfo': { EnvInfo: { EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
              UserInfo: { Uin: account, WxAppId: o.FIXED.wxAppId } }, RequestId: requestId }
          }[args[2] + '.' + args[3]] };
        }
        c.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
        if (isWorker && expireOnClose) clock = base + 600001;
        c.emit('exit', 0, null); c.emit('close', 0, null);
      });
      return c;
    }
  });
  assert.equal(workerReturned, true);
  assert.equal(stages.length, 4);
  assert.equal(report.writeAuthorized, false);
  return { stages, workerReturned, primary: report.primaryObservation.status, users: report.targetUserObservation.status,
    status: report.status, errorCode: report.errorCode, incomplete: report.incomplete, proven: report.sameBatchCredential.proven };
}
(async () => {
  const flags = [];
  for (const record of ['primary', 'targetUser']) {
    for (const field of record === 'primary' ? ['userIdShapeValid', 'statusValid'] : ['statusValid']) {
      for (const value of [undefined, null, 0, '', false, true]) {
        const payload = valid();
        if (value === undefined) delete payload[record][field]; else payload[record][field] = value;
        const result = interpret(payload);
        const status = record === 'primary' ? result.primary.status : result.users.status;
        flags.push({ record, field, input: value === undefined ? 'missing' : value, observed: status === 'OBSERVED' });
      }
    }
  }
  assert.equal(flags.filter(x => x.observed && x.input !== true).length, 12);
  const noExpiry = await finishExpiry(false, false);
  const successExpiry = await finishExpiry(false, true);
  const failureExpiry = await finishExpiry(true, true);
  assert.equal(noExpiry.incomplete.some(x => x.includes('过期')), false);
  assert.equal(successExpiry.primary, 'OBSERVED');
  assert.equal(successExpiry.users, 'OBSERVED');
  assert.equal(successExpiry.status, 'INCOMPLETE');
  assert.equal(successExpiry.incomplete.some(x => x.includes('过期')), true);
  assert.equal(failureExpiry.errorCode, 'SDK_UNAVAILABLE');
  assert.equal(failureExpiry.incomplete.some(x => x.includes('过期')), true);
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), realNetworkCalls: 0, realCredentialsFetched: false,
    syntheticChildOnly: true, flags, invalidFlagAccepted: 12,
    parentExpiryChecks: { noExpiry, successExpiry, failureExpiry },
    limitations: ['Synthetic child events; no real platform or subprocess timing proven.',
      'flags samples exercise malformed worker output, not an observed production response.'] }, null, 2));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
