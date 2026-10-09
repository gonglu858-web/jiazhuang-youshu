'use strict';
// 审查夹具：真实模块 + 合成子进程；stdout-only。新临时目录仅含合成文件，不读取认证内容。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const originalSpawn = cp.spawn;
let realLocalNodeChecks = 0;
let blockedUnexpectedProcesses = 0;
// 唯一真实子进程是已验收本地准备所用的 Node os.homedir() 读值。公共CLI/worker一律不给真实运行。
cp.spawn = function (bin, argv, opts) {
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '-e' &&
      argv[1] === 'process.stdout.write(require("node:os").homedir())') {
    realLocalNodeChecks++;
    return originalSpawn.call(cp, bin, argv, opts);
  }
  blockedUnexpectedProcesses++;
  throw Object.assign(new Error('AUDIT_UNEXPECTED_PROCESS_BLOCKED'), { code: 'AUDIT_PROCESS_BLOCKED' });
};
const o = require(path.join(root, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
const h = require(path.join(root, 'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs'));
const rows = [];
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-h123-review-'));
const profile = path.join(temporaryRoot, 'synthetic-profile');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'audit-synthetic-project' }), { flag: 'wx' });
const marker = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_MARKER';
const payload = { secretId: 'AUDIT_SYNTH_ID', secretKey: 'AUDIT_SYNTH_KEY', token: 'AUDIT_SYNTH_TOKEN',
  isTemporary: true, expiredAt: new Date(Date.now() + 1800000).toISOString(), envId: null };
function child(output, code = 0) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
  c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
  setImmediate(() => { c.stdout.emit('data', Buffer.from(output)); c.emit('exit', code, null); c.emit('close', code, null); });
  return c;
}
async function main() {
  const captured = { gets: 0, apis: [], workerTokenPresent: null, fetchCwdEqualsProfile: null };
  const account = '123456789012';
  const rid = '00000000-0000-4000-8000-000000000001';
  const responses = {
    'sts.GetCallerIdentity': { Type: 'CAMRole', AccountId: account, UserId: 'user', PrincipalId: 'principal',
      Arn: 'qcs::cam::uin/' + account + ':role/r', RequestId: rid },
    'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region }], RequestId: rid },
    'tcb.DescribeEnvInfo': { EnvInfo: { EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
      UserInfo: { Uin: account, WxAppId: o.FIXED.wxAppId } }, RequestId: rid }
  };
  const spawn = (bin, argv, opts) => {
    if (argv[1] === 'secrets') {
      captured.gets++;
      captured.fetchCwdEqualsProfile = opts.cwd === profile;
      return child(JSON.stringify({ data: payload }));
    }
    if (argv[1] === 'api') {
      const key = argv[2] + '.' + argv[3];
      captured.apis.push({ key, tokenMatches: opts.env.TENCENTCLOUD_SESSIONTOKEN === payload.token });
      return child(JSON.stringify({ data: responses[key] }));
    }
    if (argv.length === 1 && argv[0].endsWith('cloudbase-sdk-readonly-worker.cjs')) {
      const c = child(JSON.stringify({ ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 }));
      c.stdin.write = raw => { captured.workerTokenPresent = JSON.parse(raw).sessionToken === payload.token; return true; };
      return c;
    }
    throw new Error('UNEXPECTED_SYNTHETIC_STAGE');
  };
  const report = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {
    allowRealCredentialFetch: true, spawn, baseEnv: {}, fixed: { authProfileDir: profile, isolationRoot: temporaryRoot }
  });
  rows.push({ id: 'R1-real-host-candidate-chain-token', observed: captured, stoppedAt: report.stoppedAt,
    defectReproduced: captured.gets === 1 && captured.apis.length === 3 &&
      captured.apis.every(x => !x.tokenMatches) && captured.workerTokenPresent === false });
  rows.push({ id: 'R2-fetch-cwd-not-isolated', hasSyntheticPackageJson: true,
    acceptedPollutedProfileAsCwd: captured.fetchCwdEqualsProfile, defectReproduced: captured.fetchCwdEqualsProfile === true });

  const denied = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {
    baseEnv: {}, spawn: () => { throw new Error('MUST_NOT_SPAWN'); }
  });
  rows.push({ id: 'R3-no-getter-still-reports-attempt', stoppedAt: denied.stoppedAt,
    reportsAttempt: denied.sameBatchCredential.fetchSubprocessAttempted,
    defectReproduced: denied.stoppedAt === 'sameBatchCredential' && denied.sameBatchCredential.fetchSubprocessAttempted === true });

  const injected = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {
    baseEnv: {}, fetchCredential: async () => {
      throw Object.assign(new Error('SYNTHETIC_FAILURE'), { code: 'CREDENTIAL_FETCH_FAILED', detail: { stdout: marker } });
    }
  });
  rows.push({ id: 'R3-error-detail-not-projected', markerRetained: JSON.stringify(injected).includes(marker),
    defectReproduced: JSON.stringify(injected).includes(marker), limitation: '合成getter异常；不是已发生的真实凭据泄漏' });

  const evidenceSource = fs.readFileSync(path.join(root, 'docs/证据/WorkBuddyH1H2H3-真实凭据获取最小接线复现-20261008.cjs'), 'utf8');
  const i = evidenceSource.indexOf('// H3-4 输出净化');
  const end = evidenceSource.indexOf('// ── 未改项', i);
  const chunk = evidenceSource.slice(i, end);
  rows.push({ id: 'R4-evidence-last-case-no-spawn-stub', sourceOnly: true,
    callsObservation: chunk.includes('o.runReadOnlyObservation('), injectsCredential: chunk.includes('fetchCredential:'),
    injectsSpawn: /\bspawn\s*:/.test(chunk), hasLiteralZeroNetworkClaim: evidenceSource.includes('realNetworkCalls: 0'),
    defectReproduced: chunk.includes('fetchCredential:') && !/\bspawn\s*:/.test(chunk),
    note: '未运行该脚本，不推断历史是否到达平台；此调用可进入默认真实CLI启动路径' });

  const files = [
    'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs',
    'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs',
    'miniapp/tests/cloudbase-sdk-readonly-observer.test.cjs',
    'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs',
    'miniapp/scripts/check-cloudbase-sdk-readonly.cjs',
    'miniapp/scripts/lib/cloudbase-readonly-observer.cjs',
    'miniapp/scripts/check-cloudbase-readonly.cjs',
    'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs',
    'miniapp/scripts/prepare-sandbox-primary.cjs',
    'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs',
    'docs/证据/CodexSecretsGet离线契约审查-20261008.cjs',
    'docs/证据/CodexSecretsGet离线契约审查-20261008.json',
    'docs/证据/WorkBuddyH1H2H3-真实凭据获取最小接线复现-20261008.cjs',
    'docs/证据/WorkBuddyH1H2H3-真实凭据获取最小接线复现-20261008.json'
  ];
  process.stdout.write(JSON.stringify({ observedAt: new Date().toISOString(), kind: 'offline-review',
    realCredentialFetches: 0, realCloudCalls: 0, readRealAuthContent: false,
    wroteSyntheticLocalFixtures: true, realLocalNodeChecks, blockedUnexpectedProcesses,
    rows, sha256: Object.fromEntries(files.map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]))
  }, null, 2) + '\n');
}
main().catch(() => { process.stderr.write('AUDIT_FAILED_NO_RAW_ERROR\n'); process.exitCode = 1; });
