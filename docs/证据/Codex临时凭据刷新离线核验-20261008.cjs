'use strict';
// 审查夹具：真实固定公共 CLI + 合成登录/刷新传输。只在新临时目录写合成资料。
// 历史夹具仅取 preload 的源码，固定哈希、唯一替换；不运行历史 main、不改历史文件。
// 输出仅布尔/计数/固定分类，不输出凭据、认证头、请求体或原始 stdout/stderr。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const OLD = path.join(__dirname, 'CodexSecretsGet离线契约审查-20261008.cjs');
const OLD_SHA = '78439101f956b3ac113398e0baadcbd2a9d195f3efb61cf57475a46fa5d34801';
const CLI = 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli';
const NODE = 'C:/Users/30591/.agent-reach/tools/node-v22.16.0-win-x64/node.exe';
const ENTRY = path.join(CLI, 'bin/tcb');
const BUNDLE = path.join(CLI, 'dist/standalone/cli.js');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function replaceOne(src, from, to) {
  assert.equal(src.split(from).length - 1, 1, '审查夹具替换点必须唯一');
  return src.replace(from, to);
}
function preload() {
  assert.equal(sha(OLD), OLD_SHA);
  let src = fs.readFileSync(OLD, 'utf8');
  const cut = src.indexOf('function writeSyntheticAuth(');
  assert(cut > 0);
  src = src.slice(0, cut);
  const start = src.indexOf('? { code: 0, data: {');
  const end = src.indexOf(": isServiceResponse", start);
  assert(start > 0 && end > start);
  src = src.slice(0, start) + '? SYNTH_VALUES.refreshResponse\n            ' + src.slice(end);
  src = replaceOne(src, 'refreshTokenMatched: refreshMatched,', `refreshTokenMatched: refreshMatched,
          signedWithRefreshedId: String(headers.authorization || '').includes(SYNTH_VALUES.current.refreshedSecretId),
          signedWithRefreshedToken: headers['x-tc-token'] === SYNTH_VALUES.current.refreshedToken,`);
  // 只运行受审网络/文件/子进程钩子；官方安装字节不变。
  const Module = require('node:module');
  const m = new Module(__filename, module);
  m.filename = __filename;
  m.paths = module.paths;
  m._compile(src + '\npreload();\n', __filename);
}
async function main() {
  const bounded = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
  const host = require(path.join(ROOT, 'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs'));
  const before = { entry: sha(ENTRY), bundle: sha(BUNDLE), old: sha(OLD),
    oldEvidence: sha(OLD.replace(/\.cjs$/, '.json')) };
  assert.equal(before.entry, '328da4af4726c2aa4b20cf9b2e1a3614e4f22bf2e8fb8cb6d601692180de926b');
  assert.equal(before.bundle, '8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97');
  assert.equal(before.old, OLD_SHA);
  const auditRoot = fs.mkdtempSync('C:/Users/30591/.codex/tmp/refresh-offline-');
  const results = [];
  for (const name of ['full-refresh', 'missing-refresh-token', 'refresh-denied', 'expired-refresh-output']) {
    const dir = path.join(auditRoot, name), profile = path.join(dir, 'profile');
    const cwd = path.join(profile, 'isolated-cwd');
    const authFile = path.join(profile, '.config/.cloudbase/auth.json');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    const now = Date.now();
    const current = {
      secretId: 'SYNTHETIC_SECRETS_ID_OLD', secretKey: 'SYNTHETIC_SECRETS_KEY_OLD',
      token: 'SYNTHETIC_SECRETS_TOKEN_OLD', refreshToken: 'SYNTHETIC_SECRETS_REFRESH_OLD',
      accessTokenExpired: now - 1000, expired: now + 86400000, uin: '100000000001',
      refreshedSecretId: 'SYNTHETIC_SECRETS_ID_NEW', refreshedSecretKey: 'SYNTHETIC_SECRETS_KEY_NEW',
      refreshedToken: 'SYNTHETIC_SECRETS_TOKEN_NEW'
    };
    const auth = Object.fromEntries(Object.entries(current).filter(([k]) => !k.startsWith('refreshed')));
    fs.writeFileSync(authFile, JSON.stringify({ credential: auth }), { flag: 'wx' });
    const authBefore = sha(authFile);
    const data = {
      tmpSecretId: current.refreshedSecretId, tmpSecretKey: current.refreshedSecretKey,
      tmpToken: current.refreshedToken, tmpExpired: now + 3600000,
      refreshToken: 'SYNTHETIC_SECRETS_REFRESH_NEW', expired: now + 172800000, uin: current.uin
    };
    if (name === 'missing-refresh-token') delete data.refreshToken;
    if (name === 'expired-refresh-output') data.tmpExpired = now - 60000;
    const refreshResponse = name === 'refresh-denied'
      ? { code: 'AUTH_FAIL', message: 'synthetic denial' } : { code: 0, data, message: 'ok' };
    const env = {
      SystemRoot: process.env.SystemRoot, PATH: '', USERPROFILE: profile, HOME: profile,
      APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'),
      TEMP: dir, TMP: dir, CI: '1', TCB_REGION: 'ap-shanghai', TCB_DISABLE_REPORT: '1',
      XDG_CONFIG_HOME: path.join(profile, '.config'), CODEX_SECRETS_ROOT: dir,
      CODEX_SECRETS_SCENARIO: name, CODEX_SECRETS_SYNTH: JSON.stringify({ current, refreshResponse })
    };
    const r = await bounded.spawnBounded(NODE, ['--require', __filename, ENTRY, 'secrets', 'get', '--json'],
      { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      { spawn: require('node:child_process').spawn });
    const proofPath = path.join(dir, 'transport-proof.json');
    assert(fs.existsSync(proofPath), '必须取得实际拦截记录');
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    const cache = JSON.parse(fs.readFileSync(authFile, 'utf8')).credential;
    let snapshot = null, hostError = null;
    try { snapshot = host.parseSecretsJson(r.stdout, Date.now()); }
    catch (e) { hostError = Object.values(host.ERR).includes(e.code) ? e.code : 'AUDIT_PARSE_FAILED'; }
    const refresh = proof.requests.filter(x => x.kind === 'refreshTmpToken');
    const row = {
      scenario: name, exitCode: r.code, timedOut: r.timedOut, overflow: r.overflow,
      processExited: r.processExited, closeNotObserved: r.closeNotObserved,
      refreshCount: refresh.length, refreshUsesSyntheticOriginal: refresh.every(x => x.refreshTokenMatched === true),
      requestKinds: proof.requests.map(x => x.kind),
      serviceChecksUsingNewCredential: proof.requests.filter(x => x.signedWithRefreshedId && x.signedWithRefreshedToken).length,
      cacheChanged: sha(authFile) !== authBefore,
      cacheMatchesRefreshResponse: JSON.stringify(cache) === JSON.stringify(data),
      outputAcceptedByHost: snapshot !== null, hostError,
      outputMatchesRefreshedTriple: !!snapshot && snapshot.secretId === data.tmpSecretId && snapshot.secretKey === data.tmpSecretKey && snapshot.token === data.tmpToken,
      outputMatchesRefreshedExpiry: !!snapshot && snapshot.expiresAtMs === data.tmpExpired,
      diagnosticMarkerLeaked: /SYNTHETIC_SECRETS_/.test(r.stderr),
      actualNetworkCalls: proof.realNetworkCalls, blockedNetwork: proof.blockedNetwork,
      deniedFileReads: proof.deniedFileReads, deniedFileWrites: proof.deniedFileWrites,
      unexpectedSubprocesses: proof.blockedSubprocess, initTcbAttempts: proof.initTcbAttempts,
      telemetryAttempts: proof.telemetryAttempts, unknownRequests: proof.unknownRequestShape.length
    };
    row.pass = row.refreshCount === 1 && row.refreshUsesSyntheticOriginal && !r.timedOut && !r.overflow &&
      r.processExited && !r.closeNotObserved && !row.diagnosticMarkerLeaked &&
      [row.actualNetworkCalls, row.blockedNetwork, row.deniedFileReads, row.deniedFileWrites,
        row.unexpectedSubprocesses, row.initTcbAttempts, row.telemetryAttempts, row.unknownRequests].every(x => x === 0) &&
      (name === 'full-refresh' ? r.code === 0 && row.outputMatchesRefreshedTriple && row.outputMatchesRefreshedExpiry && row.cacheMatchesRefreshResponse :
        name === 'missing-refresh-token' ? r.code !== 0 && !snapshot && row.cacheMatchesRefreshResponse :
        name === 'refresh-denied' ? r.code !== 0 && !snapshot && !row.cacheChanged :
        !snapshot && row.hostError === host.ERR.EXPIRED);
    results.push(row);
  }
  const after = { entry: sha(ENTRY), bundle: sha(BUNDLE), old: sha(OLD), oldEvidence: sha(OLD.replace(/\.cjs$/, '.json')) };
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const report = { kind: 'PUBLIC_CLI_REFRESH_OFFLINE_AUDIT', observedAt: new Date().toISOString(),
    auditRoot, fingerprints: before, originalFilesUnchanged: unchanged, results,
    summary: { total: results.length, passed: results.filter(x => x.pass).length },
    realCredentialFetched: false, productionSameBatchObserved: false, writeAuthorized: false,
    limits: ['真实CLI执行；刷新服务与云API全部为传输替身，不证明平台返回形状或IAM。',
      '仅本轮新目录含合成凭据；未读取真实登录内容。',
      '完整响应为按固定源码构造的合成契约；官方CLI会写回缓存，业务宿主仍必须校验最终输出。'] };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!unchanged || results.some(x => !x.pass)) process.exitCode = 1;
}
if (process.env.CODEX_SECRETS_ROOT) preload();
else if (require.main === module) main().catch(() => { process.stderr.write('OFFLINE_AUDIT_FAILED\n'); process.exitCode = 1; });
