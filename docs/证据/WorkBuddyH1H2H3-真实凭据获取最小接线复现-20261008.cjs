'use strict';
/**
 * H1/H2/H3 离线复现（stdout-only）
 * ================================
 * 用途：为 Codex 复查提供**本轮实现**的独立可复跑证据。
 *
 * 范围（与任务一致）
 *   H1 离线核验公共 secrets 命令的输出及附加行为 —— 证据在
 *      docs/证据/CodexSecretsGet离线契约审查-20261008.{cjs,json}（Codex 侧已执行）。
 *      本脚本**只读引用**其结论，不重跑、不覆盖该证据。
 *   H2 固定凭据获取宿主（cloudbase-cli-credential-host.cjs）
 *   H3 同一份凭据的传递流程、失败停止、输出净化与分层报告
 *
 * 硬边界
 *   本脚本**不执行**真实凭据获取（不跑 `secrets get --json`）、
 *   不联网、不安装、不初始化、不建资源、不部署、不启用入口。
 *   凭据一律为合成标记值；不读取任何真实认证存储内容。
 *   只写stdout，不写文件（由调用方重定向落盘）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MINIAPP = path.resolve(__dirname, '..', '..', 'miniapp');
const EVIDENCE = __dirname;
const host = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-cli-credential-host.cjs'));
const o = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'));
const cliObserver = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-readonly-observer.cjs'));

const results = [];
function record(id, pass, observed) {
  results.push({ id, pass: Boolean(pass), observed: observed === undefined ? null : observed });
}

/** 合成的 secrets get --json stdout（真实公共入口的输出形状：外层 data 包裹）。 */
function secretsStdout(patch) {
  const payload = Object.assign({
    secretId: 'SYNTH_H2_ID', secretKey: 'SYNTH_H2_KEY', token: 'SYNTH_H2_TOKEN',
    expiredAt: new Date(Date.now() + 1800000).toISOString(), isTemporary: true, envId: null
  }, patch || {});
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }
  return JSON.stringify({ data: payload });
}

function sha256Of(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ── H1：引用Codex 侧已完成的离线契约审查（只读，不重跑） ─────────────────
const H1_PATH = path.join(EVIDENCE, 'CodexSecretsGet离线契约审查-20261008.json');
let h1 = null;
try {
  h1 = JSON.parse(fs.readFileSync(H1_PATH, 'utf8'));
} catch (_) { h1 = null; }

record('H1-offline-audit-present-and-unmodified',
  h1 !== null && h1.cliUnmodified === true && h1.realNetworkCalls === 0, {
    evidence: path.basename(H1_PATH),
    cliUnmodified: h1 ? h1.cliUnmodified : null,
    realNetworkCalls: h1 ? h1.realNetworkCalls : null,
    positiveScenario: h1 ? (h1.scenarios.find(s => s.scenario === 'valid-web-temp') || {}).scenario : null,
    note: '只读引用；本轮未重跑、未覆盖该证据'
  });

record('H1-additional-behaviors-recorded',
  h1 !== null && Array.isArray(h1.additionalBehaviors) && h1.additionalBehaviors.length >= 6, {
    count: h1 ? h1.additionalBehaviors.length : 0,
    ids: h1 ? h1.additionalBehaviors.map(a => a.id) : [],
    why: '任务要求「输出及附加行为」；一次命令 ≠ 内部仅一次请求'
  });

record('H1-gaps-reported-not-papered-over',
  h1 !== null && Array.isArray(h1.gaps) && h1.gaps.length >= 3, {
    count: h1 ? h1.gaps.length : 0,
    ids: h1 ? h1.gaps.map(g => g.id) : [],
    note: '含两条 MEDIUM：refresh 分支输出契约未定论；Initialized=false 未阻断凭据输出'
  });

// ── H2：固定宿主 ────────────────────────────────────────────────────────
record('H2-1-command-and-fingerprint-are-fixed', (() => {
  const argsOk = host.COMMAND_ARGS.length === 3 &&
    host.COMMAND_ARGS[0] === 'secrets' && host.COMMAND_ARGS[1] === 'get' &&
    host.COMMAND_ARGS[2] === '--json';
  const shaOk = host.FINGERPRINT.entrySha256.length === 64 &&
    host.FINGERPRINT.bundleSha256.length === 64;
  // 固定指纹须与磁盘上真实 CLI 一致
  const onDisk = sha256Of(cliObserver.FIXED.cliBundle) === host.FINGERPRINT.bundleSha256;
  return {
    pass: argsOk && shaOk && onDisk,
    observed: {
      commandArgs: host.COMMAND_ARGS,
      entrySha256: host.FINGERPRINT.entrySha256.slice(0, 16),
      bundleSha256: host.FINGERPRINT.bundleSha256.slice(0, 16),
      bundleMatchesInstalledCli: onDisk,
      noArbitraryEnvArg: !host.COMMAND_ARGS.some(a => a === '--env'),
      limits: host.LIMITS
    }
  };
})().pass, (() => {
  const r = results[results.length - 1];
  return r.observed;
})());

try {
  const fp = host.verifyFingerprint({
    cliEntry: cliObserver.FIXED.cliEntry, cliBundle: cliObserver.FIXED.cliBundle
  });
  record('H2-2-fingerprint-verified-against-installed-cli', fp.verified === true, {
    verified: fp.verified,
    entrySha256: fp.entrySha256.slice(0, 16),
    bundleSha256: fp.bundleSha256.slice(0, 16)
  });
} catch (error) {
  record('H2-2-fingerprint-verified-against-installed-cli', false, { errorCode: error.code || null });
}

// 解析器：正向 + token → sessionToken 映射
{
  const s = host.parseSecretsJson(secretsStdout(), Date.now());
  const mapped = host.toSdkCredentialFields(s);
  record('H2-3-parse-accepts-temporary-and-maps-token-to-sessionToken',
    s.isTemporary === true && mapped.sessionToken === 'SYNTH_H2_TOKEN' &&
    !Object.prototype.hasOwnProperty.call(mapped, 'token'),
    {
      isTemporary: s.isTemporary,
      echoedEnvId: s.echoedEnvId,
      expiresAtIso: s.expiresAtIso,
      mappedKeys: Object.keys(mapped).sort(),
      note: 'CLI 输出字段是 token，SDK 参数名是 sessionToken，此处为唯一映射点'
    });
}

// 解析器反例
{
  const future = () => new Date(Date.now() + 1800000).toISOString();
  const cases = [
    ['expiredAt=未知 字面量', { expiredAt: '未知' }, host.ERR.EXPIRY_UNKNOWN],
    ['expiredAt 非日期', { expiredAt: 'tomorrow' }, host.ERR.EXPIRY_UNKNOWN],
    ['isTemporary=false', { isTemporary: false }, host.ERR.NOT_TEMPORARY],
    ['isTemporary="true"', { isTemporary: 'true' }, host.ERR.NOT_TEMPORARY],
    ['isTemporary 缺失', { isTemporary: undefined }, host.ERR.NOT_TEMPORARY],
    ['缺 token', { token: undefined }, host.ERR.SHAPE_INVALID],
    ['缺 secretId', { secretId: '' }, host.ERR.SHAPE_INVALID],
    ['缺 secretKey', { secretKey: '' }, host.ERR.SHAPE_INVALID],
    ['已过期', { expiredAt: new Date(Date.now() - 1000).toISOString() }, host.ERR.EXPIRED],
    ['剩余不足 5 分钟', { expiredAt: new Date(Date.now() + 60000).toISOString() }, host.ERR.EXPIRED],
    ['回显非固定环境', { envId: 'cloud1-not-the-fixed-one' }, host.ERR.ENV_ID_UNEXPECTED]
  ];
  const outcomes = [];
  let allRejected = true;
  for (const [label, patch, expect] of cases) {
    let got = null;
    try {
      host.parseSecretsJson(secretsStdout(patch), Date.now());
      got = 'ACCEPTED';
    } catch (error) {
      got = error.code || 'UNKNOWN';
    }
    const ok = got === expect;
    if (!ok) allRejected = false;
    outcomes.push({ label, expected: expect, got, matched: ok });
  }
  // 结构性坏输出
  for (const bad of ['{bad', '[]', '', 'null', '{"data":[]}']) {
    let got = 'ACCEPTED';
    try { host.parseSecretsJson(bad, Date.now()); } catch (error) { got = error.code || 'UNKNOWN'; }
    if (got === 'ACCEPTED') allRejected = false;
    outcomes.push({ label: '坏输出 ' + JSON.stringify(bad), expected: '任意错误码', got, matched: got !== 'ACCEPTED' });
  }
  record('H2-4-parser-rejects-every-invalid-shape', allRejected, {
    total: outcomes.length,
    allRejected,
    outcomes
  });
}

// 隔离环境
{
  const env = host.buildFetchEnv({
    PATH: 'C:/Windows',
    xdg_config_home: 'C:/outside', XDG_CONFIG_HOME: 'C:/outside',
    UserProfile: 'C:/outside', USERPROFILE: 'C:/outside', HOME: 'C:/outside',
    Http_Proxy: 'http://p', HTTP_PROXY: 'http://p', https_proxy: 'http://p',
    ALL_PROXY: 'http://p', no_proxy: 'x',
    TENCENTCLOUD_SECRETID: 'OLD', tcb_region: 'ap-guangzhou',
    CLOUDBASE_API_KEY: 'X', NODE_OPTIONS: '--x', Node_Options: '--y'
  }, path.join(os.tmpdir(), 'repro-profile'), path.join(os.tmpdir(), 'repro-cwd'));

  const offenders = [];
  for (const key of Object.keys(env)) {
    const u = key.toUpperCase();
    if (u.startsWith('TENCENTCLOUD_') || u.startsWith('CLOUDBASE_') || u.startsWith('TCB_') ||
      u.startsWith('XDG_') || u === 'NODE_OPTIONS' || u.includes('PROXY')) {
      // 固定控制变量（TCB_REGION / TCB_DISABLE_REPORT）是本工具主动设置的允许项
      if (u === 'TCB_REGION' || u === 'TCB_DISABLE_REPORT') continue;
      offenders.push(key);
    }
  }
  const nonCanonicalHome = Object.keys(env).filter(k => {
    const u = k.toUpperCase();
    return (u === 'USERPROFILE' || u === 'HOME' || u === 'APPDATA' || u === 'LOCALAPPDATA') && k !== u;
  });
  record('H2-5-isolation-env-case-insensitive-cleared',
    offenders.length === 0 && nonCanonicalHome.length === 0 &&
    env.USERPROFILE !== 'C:/outside' && env.TCB_DISABLE_REPORT === '1',
    {
      offenders, nonCanonicalHome,
      userProfile: env.USERPROFILE,
      telemetryDisabled: env.TCB_DISABLE_REPORT === '1',
      region: env.TCB_REGION,
      inheritedCredentialPresent: Object.prototype.hasOwnProperty.call(env, 'TENCENTCLOUD_SECRETID')
    });
}

// ── H3：同批传递与分层报告 ────────────────────────────────────────────────
/** 构造合成子进程（EventEmitter），用于观测父进程如何把凭据交给 worker。 */
function fakeChild() {
  const { EventEmitter } = require('node:events');
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = new EventEmitter();
  c.stdinBytes = '';
  c.stdinClosed = false;
  c.kills = 0;
  c.stdin.write = (s) => { c.stdinBytes += String(s); return true; };
  c.stdin.end = () => { c.stdinClosed = true; };
  c.kill = () => { c.kills++; return true; };
  return c;
}
function listenersReady() {
  return new Promise(r => setImmediate(() => setImmediate(r)));
}

const sectionH3 = (async () => {
  // H3-1 同一份快照 → 私有 stdin 管道 → worker；不进命令行/环境/磁盘
  {
    const c = fakeChild();
    const snapshot = {
      secretId: 'SYNTH_S', secretKey: 'SYNTH_K', sessionToken: 'SYNTH_T',
      expiresAtMs: Date.now() + 600000
    };
    const p = o.runWorker(snapshot, 'u_' + 'a'.repeat(40), {
      spawn: () => c,
      limits: { timeoutMs: 1000, closeGraceMs: 40, maxOutputBytes: 4096 }
    });
    await listenersReady();
    const sent = JSON.parse(c.stdinBytes);
    const argvHasCredential = c.stdinBytes.includes('--secret') || c.stdinBytes.includes('--token');
    c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
    c.emit('exit', 0, null);
    c.emit('close', 0, null);
    const res = await p;
    record('H3-1-credential-passed-only-via-private-stdin-pipe',
      sent.secretId === 'SYNTH_S' && sent.sessionToken === 'SYNTH_T' &&
      typeof sent.expiresAtMs === 'number' && c.stdinClosed === true &&
      !argvHasCredential && res.ok === true,
      {
        payloadFields: Object.keys(sent).sort(),
        stdinClosed: c.stdinClosed,
        carriesExpiryForTwoReadRecheck: typeof sent.expiresAtMs === 'number',
        credentialInArgv: argvHasCredential,
        note: '一次送入随即关闭；不落命令行/环境/磁盘'
      });
  }

  // H3-2 未获授权时如实停止（候选实现存在 ≠ 允许运行）
  {
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'repro-h3-')) }
      }
    );
    record('H3-2-stops-honestly-without-authorization',
      report.status === o.STATUS.FAILED &&
      report.sameBatchCredential.proven === false &&
      report.writeAuthorized === false &&
      Array.isArray(report.incomplete) && report.incomplete.length > 0,
      {
        status: report.status,
        stoppedAt: report.stoppedAt,
        errorCode: report.errorCode,
        proven: report.sameBatchCredential.proven,
        writeAuthorized: report.writeAuthorized,
        incompleteCount: report.incomplete.length
      });
  }

  // H3-3 注入合成凭据仍不产生生产 proven
  {
    const { EventEmitter } = require('node:events');
    const fc = () => {
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
      c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
      return c;
    };
    const account = '123456789012';
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: 'u_' + 'a'.repeat(40) },
      {
        baseEnv: {},
        fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'repro-h33-')) },
        fetchCredential: async () => secretsStdout(),
        spawn: (bin, argv) => {
          const c = fc();
          if (argv.length === 1) {
            setImmediate(() => {
              c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
              c.emit('exit', 0, null); c.emit('close', 0, null);
            });
            return c;
          }
          const api = argv[2]; const act = argv[3];
          const U = '00000000-0000-4000-8000-000000000001';
          const p = {
            'sts.GetCallerIdentity': { Type: 'CAMRole', AccountId: account, UserId: 'u',
              PrincipalId: 'p', Arn: 'qcs::cam::uin/' + account + ':role/r', RequestId: U },
            'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL',
              Region: o.FIXED.region }], RequestId: U },
            'tcb.DescribeEnvInfo': { EnvInfo: {
              EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
              UserInfo: { Uin: account, WxAppId: o.FIXED.wxAppId } }, RequestId: U }
          };
          setImmediate(() => {
            c.stdout.emit('data', Buffer.from(
              '\u2139 \u2192' + String(api).toUpperCase() + '.' + act + '\n' +
              JSON.stringify({ data: p[api + '.' + act] })));
            c.emit('exit', 0, null); c.emit('close', 0, null);
          });
          return c;
        }
      }
    );
    record('H3-3-synthetic-injection-never-produces-production-proven',
      report.sameBatchCredential.proven === false &&
      report.sameBatchCredential.evidenceKind === 'SYNTHETIC_INJECTION' &&
      report.status !== o.STATUS.OBSERVED &&
      report.writeAuthorized === false,
      {
        status: report.status,
        proven: report.sameBatchCredential.proven,
        evidenceKind: report.sameBatchCredential.evidenceKind,
        source: report.sameBatchCredential.source,
        refreshed: report.sameBatchCredential.refreshed,
        writeAuthorized: report.writeAuthorized
      });
  }

  // H3-4 输出净化：凭据原值与合成标记不得出现在任何报告字段
  {
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'repro-h34-')) },
        fetchCredential: async () => secretsStdout()
      }
    );
    const dumped = JSON.stringify(report);
    const probes = ['SYNTH_H2_ID', 'SYNTH_H2_KEY', 'SYNTH_H2_TOKEN'];
    record('H3-4-no-credential-values-in-report', probes.every(x => dumped.includes(x) === false), {
      probesChecked: probes,
      anyLeaked: probes.some(x => dumped.includes(x)),
      writeAuthorized: report.writeAuthorized,
      productionSameBatchObserved: report.localPreparation
        ? report.localPreparation.productionSameBatchObserved : null
    });
  }
})();

// ── 未改项与禁止调用面 ──────────────────────────────────────────────────
function sha256(rel) {
  return sha256Of(path.join(MINIAPP, rel));
}
record('untouched-files-unchanged', (() => {
  const expected = {
    'scripts/lib/cloudbase-readonly-observer.cjs': '3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
    'scripts/check-cloudbase-readonly.cjs': '552dc12269989ec271338153fba036331cc37a27facc13189c3c2a8d0a17ae3a',
    'scripts/lib/sandbox-primary-bootstrap.cjs': '133c21ae4b1081a1e716422862730d518a2194cc8620eb0956a9459a44765614',
    'scripts/prepare-sandbox-primary.cjs': '608aa8854a4213fc81659f2892634cd29e4ba691db1253d34a8e66778c7046e4',
    'scripts/lib/sandbox-primary-sdk-adapter.cjs': '9088e6478b940a4c2db06737effbb9264f12fd1b62778e64cdb3990ef2ec9f1d'
  };
  const rows = [];
  let allOk = true;
  for (const [rel, want] of Object.entries(expected)) {
    const got = sha256(rel);
    const ok = got === want;
    if (!ok) allOk = false;
    rows.push({ file: rel, expected: want.slice(0, 16), actual: got.slice(0, 16), matched: ok });
  }
  return { pass: allOk, rows };
})().pass, (() => results[results.length - 1].observed)());

record('forbidden-calls-absent', (() => {
  const files = [
    'scripts/lib/cloudbase-cli-credential-host.cjs',
    'scripts/lib/cloudbase-sdk-readonly-worker.cjs',
    'scripts/lib/cloudbase-sdk-readonly-observer.cjs'
  ].map(f => fs.readFileSync(path.join(MINIAPP, f), 'utf8')).join('\n');
  const probes = ['.requestBindingNumber(', '.initializePrimary(', '.runTransaction(', '.createCollection('];
  const hits = {};
  for (const p of probes) hits[p] = (files.split(p).length - 1);
  const legacy = (files.match(/collection\('(users|app_admins)'\)/g) || []).length;
  const total = Object.values(hits).reduce((a, b) => a + b, 0) + legacy;
  return { pass: total === 0, hits, legacyCollectionCalls: legacy };
})().pass, (() => results[results.length - 1].observed)());

// ── 汇总 ─────────────────────────────────────────────────────────────────
sectionH3.then(() => {
  const failed = results.filter(r => !r.pass).length;
  const out = {
    observedAt: new Date().toISOString(),
    auditKind: 'offline-reproduction-fixture-not-production-component',
    scope: 'H1 只读引用 / H2 固定宿主 / H3 同批传递与分层报告',
    realNetworkCalls: 0,
    realCredentialFetches: 0,
    readRealAuthStoreContent: false,
    wroteFiles: false,
    historicalEvidenceOverwritten: false,
    summary: {
      total: results.length,
      passed: results.length - failed,
      failed
    },
    results,
    blockingGaps: [
      {
        id: 'production-same-batch-credential-chain-not-proven',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: '本轮**未执行** `secrets get --json`、未获取任何真实凭据。H2 宿主只是**候选实现**，' +
          'H1 只是离线契约证明；两者都不等于生产同批凭据链已成立。' +
          '报告中 `productionSameBatchObserved` 恒为 false、注入路径 proven 恒为 false。',
        needed: '在受审宿主内按既有只读授权执行一次整组，另存脱敏证据。'
      },
      {
        id: 'refresh-branch-output-contract-undecided',
        severity: 'MEDIUM',
        detail: 'H1 中 `expired-refreshable` 场景确实发出一次 refreshTmpToken（合成传输已拦截），' +
          '但命令最终失败、快照未产出，合成响应的 tmp* 字段与 resolveCredential 的对齐尚未验证通过。',
        needed: '按固定源码核对 resolveCredential 对 refresh 返回 data 的字段期望后再离线复核；不为此使用真实凭据。'
      },
      {
        id: 'service-not-initialized-does-not-block-output',
        severity: 'MEDIUM',
        detail: 'H1 中 CheckTcbService 返回 Initialized=false 时命令**仍继续**并输出快照（合成条件下观测）。' +
          '本轮未观察到 InitTcb 或任何开通动作，但这与「服务未初始化必须停止」的预期不同。',
        needed: '请 Codex 确认该版本语义：Initialized=false 是否本就不阻断凭据输出。'
      },
      {
        id: 'refresh-writes-back-official-login-cache',
        severity: 'LOW',
        detail: 'H1 观测到 refreshTmpToken 成功后 authStore.set(\'credential\', ...) 会写回官方登录缓存。' +
          '本轮只在合成目录观察到该写回类别，未在真实登录目录执行。',
        needed: '真实受审运行时单独记录，并在审查中列明该已知行为；不得假定「官方 CLI 获取过程不刷新缓存」。'
      }
    ],
    limitations: [
      '凭据全部为合成标记值；未取真实凭据、未读真实认证存储内容。',
      'H2 宿主的解析与传递链已离线验证，但**未真实执行**过该命令。',
      '本脚本是离线夹具，不得作为未经审查的生产网络代理安装。',
      '平台原子性、IAM、真实库内容、真实网络行为、费用/余量均未验证。'
    ]
  };
  process.stdout.write(JSON.stringify(out, null, 2));
  process.exitCode = failed > 0 ? 1 : 0;
});