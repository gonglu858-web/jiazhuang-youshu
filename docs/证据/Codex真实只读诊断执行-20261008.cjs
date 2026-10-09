// R1/R2复核通过后的第二次受审观测；仅更新已验收指纹与独立输出/启动标记。
'use strict';
// 仅本次受审观测入口：不替换任何凭据、进程、时钟或响应；不输出原始子进程内容。
// 对应 Codex核验-临时凭据刷新离线与真实只读安排-20261008.md §4。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const files = {
  'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs': 'bccea293069e22ed97ea7a3648772e0b1dd11b26fda9f85295cf4b3002ab509c',
  'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs': 'f43a557d49b3923eb75f686b477b8cb047be560bff6040c0e36857a3cc4d0478',
  'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs': 'c5368fff5131d6d43e99d2fdbcbdc2270b4a8c19c8444d347cd2f2e5059100d5',
  'miniapp/scripts/lib/cloudbase-readonly-observer.cjs': '3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
  'miniapp/scripts/check-cloudbase-sdk-readonly.cjs': '1a0ea9d6eced919d9d4f67d712a4886be2eef0a568ac4a255c0a9ac3e69f2b3c',
  'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/bin/tcb': '328da4af4726c2aa4b20cf9b2e1a3614e4f22bf2e8fb8cb6d601692180de926b',
  'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/dist/standalone/cli.js': '8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97'
};
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-once') throw new Error('STOP');
  if (process.execArgv.length || Object.keys(process.env).some(k => /^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE)$/i.test(k) && process.env[k])) throw new Error('STOP');
  const fingerprints = Object.entries(files).map(([p, expected]) => {
    const actual = sha(path.isAbsolute(p) ? p : path.join(ROOT, p));
    if (actual !== expected) throw new Error('STOP');
    return { path: p, sha256: actual };
  });
  const observer = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
  const local = await observer.runLocalCheck();
  if (local.status !== 'LOCAL_READY') throw new Error('STOP');
  const runId = 'codex-real-readonly-diagnostic-' + Date.now() + '-' + crypto.randomUUID();
  const file = path.join(__dirname, runId + '.json');
  // 留存启动标记，禁止无意重跑本入口。不自动删除或复用。
  fs.writeFileSync(path.join(__dirname, 'Codex真实只读诊断执行-20261008.started.json'),
    JSON.stringify({ runId, startedAt: new Date().toISOString(), evidence: path.basename(file) }, null, 2), { flag: 'wx' });
  const out = {
    kind: 'REVIEWED_REAL_READONLY_ATTEMPT', runId, startedAt: new Date().toISOString(),
    wrapperSha256: sha(__filename), fingerprints, localPreparation: local,
    targetUserId: null, dependencyOverrides: ['allowRealCredentialFetch=true'],
    syntheticCredentialOrTransportInjected: false, writeAuthorized: false,
    notes: ['原编排报告不改写proven/status。', '未指定受信微信用户，跳过users；本次只允许固定副本primary读取。',
      '获取过程中官方CLI可能读取并刷新登录缓存，是否发生未单独观测。',
      '子进程启动不等于请求到达平台；请求尝试次数与平台响应事实分开解释。']
  };
  try {
    out.observation = await observer.runReadOnlyObservation({ targetUserId: null }, { allowRealCredentialFetch: true });
  } catch (_) {
    out.wrapperError = 'OBSERVATION_THROWN_WITHOUT_RAW_DETAILS';
  }
  out.finishedAt = new Date().toISOString();
  out.codeUnchangedAfter = Object.entries(files).every(([p, expected]) => sha(path.isAbsolute(p) ? p : path.join(ROOT, p)) === expected);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', { flag: 'wx' });
  const r = out.observation || {};
  process.stdout.write(JSON.stringify({ evidence: file, localReady: true, status: r.status || 'FAILED',
    stoppedAt: r.stoppedAt || null, errorCode: r.errorCode || out.wrapperError || null,
    fetchAttempted: r.sameBatchCredential?.fetchSubprocessAttempted || false,
    association: r.cliAssociation?.status || null, primary: r.primaryObservation?.status || null,
    targetUser: r.targetUserObservation?.status || null, codeUnchangedAfter: out.codeUnchangedAfter }, null, 2) + '\n');
  if (out.wrapperError || r.status === 'FAILED') process.exitCode = 1;
}
if (require.main === module) main().catch(() => { process.stderr.write('REVIEWED_RUN_STOPPED_NO_RAW_DETAILS\n'); process.exitCode = 1; });
