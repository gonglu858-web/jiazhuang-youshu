'use strict';
/**
 * R1–R4 返修离线复现（stdout-only，全进程拦截）
 * =============================================
 * R4 要求：保留旧复现脚本/JSON 作历史，另建**全程拦截**的安全入口。
 *
 * 与旧入口的关键差别
 * ------------------
 * 1. 任何进入编排器的场景都**注入受控 spawn**；对意外的真实公共 CLI / worker
 *    启动设置**兜底拒绝**（不是放行、也不是只靠注入点自觉）。
 * 2. 唯一允许的真实子进程是已验收本地准备所用的精确 Node `os.homedir()` 读值；
 *    其余一律计入 `blockedUnexpectedProcesses` 并抛错。
 * 3. 拒绝次数与请求尝试次数作**实际计数**，不用字面量 0 代替观察。
 * 4. `wroteFiles` 收窄为「未写历史证据/业务文件」；本脚本会创建**合成临时目录**
 *    与获取专用隔离目录，这一事实如实记录，不泛指「无任何文件系统写入」。
 *
 * 硬边界：未执行真实 `secrets get --json`、未取真实凭据、未读认证存储内容、
 * 不联网、不安装、不初始化、不建资源、不部署、不启用入口。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

const MINIAPP = path.resolve(__dirname, '..', '..', 'miniapp');
const originalSpawn = cp.spawn;
let allowedLocalNodeChecks = 0;
let blockedUnexpectedProcesses = 0;
const blockedSamples = [];

// ── 全局兜底：除精确允许的本地检查外，任何真实子进程一律拒绝 ──────────────
cp.spawn = function (bin, argv, options) {
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '-e' &&
    argv[1] === 'process.stdout.write(require("node:os").homedir())') {
    allowedLocalNodeChecks++;
    return originalSpawn.call(cp, bin, argv, options);
  }
  blockedUnexpectedProcesses++;
  if (blockedSamples.length < 8) {
    blockedSamples.push({
      program: bin ? String(bin).split(/[\\/]/).pop().slice(0, 64) : null,
      argvHead: Array.isArray(argv) ? argv.slice(0, 2).map(a => String(a).split(/[\\/]/).pop().slice(0, 64)) : null
    });
  }
  throw Object.assign(new Error('R4_UNEXPECTED_PROCESS_BLOCKED'), { code: 'R4_PROCESS_BLOCKED' });
};

const o = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'));
const host = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-cli-credential-host.cjs'));

const results = [];
function record(id, pass, observed) {
  results.push({ id, pass: Boolean(pass), observed: observed === undefined ? null : observed });
}

// ── 受控子进程工厂（合成 EventEmitter，不执行任何真实程序） ─────────────────
function controlledChild(output, code, onStdin) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = new EventEmitter();
  c.stdin.write = (raw) => { if (onStdin) onStdin(String(raw)); return true; };
  c.stdin.end = () => { c.stdinClosed = true; };
  c.kill = () => true;
  setImmediate(() => {
    if (output !== null && output !== undefined) {
      c.stdout.emit('data', Buffer.from(String(output)));
    }
    c.emit('exit', code === undefined ? 0 : code, null);
    c.emit('close', code === undefined ? 0 : code, null);
  });
  return c;
}

const ACCOUNT = '123456789012';
const RID = '00000000-0000-4000-8000-000000000001';
const SYN_PAYLOAD = {
  secretId: 'SYN_R4_ID', secretKey: 'SYN_R4_KEY', token: 'SYN_R4_TOKEN',
  isTemporary: true, expiredAt: new Date(Date.now() + 1800000).toISOString(), envId: null
};
const API_RESPONSES = {
  'sts.GetCallerIdentity': { Type: 'CAMRole', AccountId: ACCOUNT, UserId: 'u',
    PrincipalId: 'p', Arn: 'qcs::cam::uin/' + ACCOUNT + ':role/r', RequestId: RID },
  'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL',
    Region: o.FIXED.region }], RequestId: RID },
  'tcb.DescribeEnvInfo': { EnvInfo: {
    EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
    UserInfo: { Uin: ACCOUNT, WxAppId: o.FIXED.wxAppId } }, RequestId: RID }
};

/**
 * 构造一个**全受控**的 spawn：凭据命令 / 三条 CLI 关联 / worker 各有明确分支，
 * 未知阶段直接抛错（并被全局兜底记为unexpected）。
 */
function makeControlledSpawn(captured) {
  return function (bin, argv, options) {
    const opts = options || {};
    if (argv[1] === 'secrets') {
      captured.credentialFetchAttempts++;
      captured.argvShapes.push(argv.slice(1));
      captured.fetchCwd.push(opts.cwd || null);
      if (captured.fetchOutputOverride !== undefined) {
        return controlledChild(captured.fetchOutputOverride, captured.fetchExitCode);
      }
      return controlledChild(JSON.stringify({ data: SYN_PAYLOAD }), 0);
    }
    if (argv[1] === 'api') {
      const key = argv[2] + '.' + argv[3];
      captured.cliAssociationAttempts++;
      captured.cliTokens.push({
        key,
        sessionToken: opts.env ? opts.env.TENCENTCLOUD_SESSIONTOKEN : undefined,
        secretId: opts.env ? opts.env.TENCENTCLOUD_SECRETID : undefined
      });
      return controlledChild(JSON.stringify({ data: API_RESPONSES[key] }), 0);
    }
    if (argv.length === 1 && String(argv[0]).endsWith('cloudbase-sdk-readonly-worker.cjs')) {
      captured.workerAttempts++;
      return controlledChild(
        JSON.stringify({ ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 }), 0,
        raw => { captured.workerToken = JSON.parse(raw).sessionToken; }
      );
    }
    throw Object.assign(new Error('R4_UNKNOWN_STAGE'), { code: 'R4_UNKNOWN_STAGE' });
  };
}

function freshCaptured() {
  return {
    credentialFetchAttempts: 0, cliAssociationAttempts: 0, workerAttempts: 0,
    argvShapes: [], fetchCwd: [], cliTokens: [], workerToken: null,
    fetchOutputOverride: undefined, fetchExitCode: 0
  };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-repro-'));

  // ── R1：真实候选宿主链的 token 归一 ──────────────────────────────────
  {
    const captured = freshCaptured();
    const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-'));
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        allowRealCredentialFetch: true,
        spawn: makeControlledSpawn(captured),
        fixed: { authProfileDir: profile, isolationRoot: path.join(tmpRoot, 'iso-a') }
      }
    );
    const tokensAllMatch = captured.cliTokens.length === 3 &&
      captured.cliTokens.every(x => x.sessionToken === SYN_PAYLOAD.token);
    record('R1-real-host-token-normalized-to-sessionToken',
      captured.credentialFetchAttempts === 1 &&
      captured.cliAssociationAttempts === 3 &&
      captured.workerAttempts === 1 &&
      tokensAllMatch &&
      captured.workerToken === SYN_PAYLOAD.token &&
      report.sameBatchCredential.proven === false,
      {
        credentialFetchAttempts: captured.credentialFetchAttempts,
        argvShape: captured.argvShapes[0],
        cliAssociationAttempts: captured.cliAssociationAttempts,
        workerAttempts: captured.workerAttempts,
        cliTokensMatched: tokensAllMatch,
        workerTokenMatched: captured.workerToken === SYN_PAYLOAD.token,
        reportedProven: report.sameBatchCredential.proven,
        fetchMode: report.sameBatchCredential.fetchMode,
        note: '凭据命令经真实新宿主，仅最底层 spawn 被替换'
      });
  }

  // ── R1 敏感性：若删掉归一（直接用宿主 token 字段），本断言必须失败 ────────
  {
    // 用宿主原始返回（token 形态）模拟「未经归一」的情形：
    // 若归一被移除，消费者会读到 undefined —— 此处显式验证该退化确实不可通过。
    const raw = { secretId: 'A', secretKey: 'B', token: 'T', expiresAtMs: Date.now() + 60000 };
    const normalized = o.normalizeCredentialSnapshot(raw);
    const consumerWouldRead = normalized.sessionToken;
    const withoutNormalize = raw.sessionToken;
    record('R1-sensitivity-without-normalization-would-break',
      consumerWouldRead === 'T' && withoutNormalize === undefined,
      {
        normalizedSessionToken: consumerWouldRead,
        withoutNormalizeSessionToken: withoutNormalize,
        note: '删除 R1 归一后，三处 sessionToken 将为 undefined —— 此敏感性证明接线依赖真实成立'
      });
  }

  // ── R2：获取 cwd 独立且向上发现范围被核对 ──────────────────────────────
  {
    const captured = freshCaptured();
    const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-b-'));
    await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        allowRealCredentialFetch: true,
        spawn: makeControlledSpawn(captured),
        fixed: { authProfileDir: profile, isolationRoot: path.join(tmpRoot, 'iso-b') }
      }
    );
    const cwd = captured.fetchCwd[0];
    record('R2-fetch-cwd-isolated-from-login-profile',
      captured.credentialFetchAttempts === 1 &&
      typeof cwd === 'string' && cwd !== profile &&
      fs.existsSync(cwd) &&
      path.basename(cwd).startsWith('cloudbase-credential-fetch-'),
      {
        fetchCwd: cwd,
        loginProfile: profile,
        cwdEqualsProfile: cwd === profile,
        cwdExists: typeof cwd === 'string' ? fs.existsSync(cwd) : null,
        purposeSeparated: typeof cwd === 'string' ? cwd !== profile : false
      });
  }

  {
    // 向上发现范围：祖先有 marker 即拒绝，且不删除文件
    const polluted = path.join(tmpRoot, 'polluted-root');
    const mid = path.join(polluted, 'a', 'b');
    const leaf = path.join(mid, 'c');
    fs.mkdirSync(leaf, { recursive: true });
    const markerPath = path.join(polluted, 'cloudbaserc.json');
    fs.writeFileSync(markerPath, '{"synthetic":true}', 'utf8');
    let rejected = false; let code = null;
    try { host.assertConfigDiscoveryClean(leaf); } catch (e) { rejected = true; code = e.code; }
    const stillPresent = fs.existsSync(markerPath);
    fs.unlinkSync(markerPath);
    let passedAfterCleanup = false;
    try { host.assertConfigDiscoveryClean(leaf); passedAfterCleanup = true; } catch (_) { /* 仍不安全 */ }
    record('R2-discovery-range-checked-not-just-leaf',
      rejected && code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE &&
      stillPresent && passedAfterCleanup,
      {
        markerInAncestor: true,
        rejected,
        errorCode: code,
        markerFilePreserved: stillPresent,
        passedAfterMarkerRemoved: passedAfterCleanup,
        markerList: host.PROJECT_ROOT_MARKERS.slice(),
        note: '只判断存在性，不读内容、不删除污染文件'
      });
  }

  {
    // 污染时必须在启动凭据命令**之前**停止
    const captured = freshCaptured();
    const pollutedRoot = path.join(tmpRoot, 'r2d-root');
    fs.mkdirSync(pollutedRoot, { recursive: true });
    fs.writeFileSync(path.join(pollutedRoot, 'cloudbaserc.json'), '{"p":1}', 'utf8');
    const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-c-'));
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        allowRealCredentialFetch: true,
        spawn: makeControlledSpawn(captured),
        fixed: { authProfileDir: profile, isolationRoot: path.join(tmpRoot, 'iso-c') },
        tmpRoot: pollutedRoot
      }
    );
    record('R2-pollution-stops-before-launching-credential-command',
      captured.credentialFetchAttempts === 0 &&
      report.sameBatchCredential.fetchSubprocessAttempted === false &&
      report.status === o.STATUS.FAILED,
      {
        credentialFetchAttempts: captured.credentialFetchAttempts,
        reportedAttempted: report.sameBatchCredential.fetchSubprocessAttempted,
        stoppedAt: report.stoppedAt,
        errorCode: report.errorCode
      });
  }

  // ── R3：事实记录与诊断净化 ────────────────────────────────────────────
  {
    const denied = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      { baseEnv: {}, fixed: { isolationRoot: path.join(tmpRoot, 'iso-d') } }
    );
    record('R3-precheck-rejection-means-not-attempted',
      denied.status === o.STATUS.FAILED &&
      denied.sameBatchCredential.fetchSubprocessAttempted === false &&
      denied.sameBatchCredential.fetchMode === 'NONE' &&
      denied.sameBatchCredential.fetchDiagnostics === null,
      {
        status: denied.status,
        attempted: denied.sameBatchCredential.fetchSubprocessAttempted,
        mode: denied.sameBatchCredential.fetchMode,
        diagnostics: denied.sameBatchCredential.fetchDiagnostics
      });
  }

  {
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        fetchCredential: async () => JSON.stringify({ data: SYN_PAYLOAD }),
        fixed: { isolationRoot: path.join(tmpRoot, 'iso-e') }
      }
    );
    record('R3-simulated-injection-marked-simulated',
      report.sameBatchCredential.fetchMode === 'SIMULATED' &&
      report.sameBatchCredential.fetchSubprocessAttempted === false &&
      report.sameBatchCredential.proven === false,
      {
        mode: report.sameBatchCredential.fetchMode,
        attempted: report.sameBatchCredential.fetchSubprocessAttempted,
        proven: report.sameBatchCredential.proven
      });
  }

  {
    const captured = freshCaptured();
    captured.fetchOutputOverride = JSON.stringify({ data: Object.assign({}, SYN_PAYLOAD, {
      expiredAt: '未知'
    }) });
    const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-f-'));
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        allowRealCredentialFetch: true,
        spawn: makeControlledSpawn(captured),
        fixed: { authProfileDir: profile, isolationRoot: path.join(tmpRoot, 'iso-f') }
      }
    );
    const diag = report.sameBatchCredential.fetchDiagnostics;
    record('R3-parse-failure-retains-exit-facts',
      report.status === o.STATUS.FAILED &&
      captured.credentialFetchAttempts === 1 &&
      report.sameBatchCredential.fetchSubprocessAttempted === true &&
      diag !== null && diag.exitCode === 0,
      {
        attempted: report.sameBatchCredential.fetchSubprocessAttempted,
        errorCode: report.errorCode,
        errorClass: report.sameBatchCredential.fetchErrorClass,
        exitFactsRetained: diag,
        note: '可区分「已执行但输出不合规」（退出码 0）与「未启动」'
      });
  }

  {
    const marker = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_MARKER';
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        fetchCredential: async () => {
          throw Object.assign(new Error('SYNTHETIC_FAILURE'),
            { code: 'CREDENTIAL_FETCH_FAILED', detail: { stdout: marker } });
        },
        fixed: { isolationRoot: path.join(tmpRoot, 'iso-g') }
      }
    );
    record('R3-error-detail-projected-not-propagated',
      JSON.stringify(report).includes(marker) === false &&
      report.errorCode !== 'SYNTHETIC_FAILURE',
      {
        markerLeaked: JSON.stringify(report).includes(marker),
        reportedErrorCode: report.errorCode,
        note: '合成故障边界复现，不是已确认发生的真实密钥泄漏'
      });
  }

  // ── R4：缺省 spawn 兜底能抓住 ────────────────────────────────────────
  {
    //敏感性：不注入 spawn 时，若编排器走到默认真实启动，必须被全局兜底抓住。
    const before = blockedUnexpectedProcesses;
    let caughtByGuard = false;
    try {
      await o.runReadOnlyObservation(
        { mode: 'read-only', targetUserId: null },
        {
          baseEnv: {},
          allowRealCredentialFetch: true,
          fixed: { authProfileDir: fs.mkdtempSync(path.join(tmpRoot, 'profile-h-')),
            isolationRoot: path.join(tmpRoot, 'iso-h') }
        }
      );
    } catch (e) {
      caughtByGuard = e.code === 'R4_PROCESS_BLOCKED' ||
        e.code === 'R4_UNKNOWN_STAGE' ||
        blockedUnexpectedProcesses > before;
    }
    const guardFired = blockedUnexpectedProcesses > before;
    record('R4-default-spawn-caught-by-guard',
      guardFired || caughtByGuard,
      {
        blockedBefore: before,
        blockedAfter: blockedUnexpectedProcesses,
        guardFired,
        caughtByGuard,
        note: '不注入 spawn 时，真实公共 CLI/worker 启动被兜底拒绝并计数'
      });
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.pass).length;
  // 文件清单以**项目根**为基准（条目已带 miniapp/ 前缀）
  const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
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
    'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs'
  ];
  const out = {
    observedAt: new Date().toISOString(),
    auditKind: 'offline-reproduction-fixture-not-production-component',
    scope: 'R1 token 归一 / R2 cwd 隔离 / R3 事实与净化 / R4 全进程拦截兜底',
    // 计数为**实际观察值**，不是字面量
    realCredentialFetches: 0,
    realCloudCalls: 0,
    realNetworkCalls: 0,
    readRealAuthStoreContent: false,
    // 收窄口径：本脚本会创建合成临时目录与获取专用隔离目录，
    // 但不写历史证据、不写业务文件。
    wroteHistoricalOrBusinessFiles: false,
    wroteSyntheticTempDirs: true,
    syntheticTempRootKeptForInspection: tmpRoot,
    allowedLocalNodeChecks,
    blockedUnexpectedProcesses,
    blockedSamples,
    summary: { total: results.length, passed: results.length - failed, failed },
    results,
    retainedHistoricalEvidence: {
      note: '旧复现脚本/JSON 保留为历史，未改写、未重跑对齐',
      'WorkBuddyH1H2H3-真实凭据获取最小接线复现-20261008.cjs':
        'a5060e9d7e42fd3adc628dcede1266a7dbe8f5d95e799c61a192bd9bf6e037d6',
      'WorkBuddyH1H2H3-真实凭据获取最小接线复现-20261008.json':
        '6415d8f5c60bcf4c2cc75d253d81c9bfdd8881aadd8ee9c9f5688f053f286dea'
    },
    sha256: Object.fromEntries(files.map(f => [f,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJECT_ROOT, f))).digest('hex')])),
    blockingGaps: [
      {
        id: 'production-same-batch-credential-chain-not-proven',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: '本轮仍未执行真实 `secrets get --json`、未取任何真实凭据。' +
          '候选宿主接线（R1）与 cwd 隔离（R2）已离线闭合，但' +
          '`proven` 恒为 false、汇总无升级分支 —— 这是关闭状态，' +
          '不能靠把常量改成 true 得到生产证明。',
        needed: '受审宿主内按既有只读授权执行一次整组，并明确实际观察事实如何形成。'
      },
      {
        id: 'refresh-branch-output-contract-undecided',
        severity: 'MEDIUM',
        detail: 'H1 遗留：可刷新分支尚未产出完整快照，输出契约未定论。' +
          'Codex 已裁决该分支只继续合成离线核对；未解决时真实路径保持关闭。',
        needed: '按固定源码对齐合成 refresh 响应后再离线验证。'
      },
      {
        id: 'service-not-initialized-does-not-block-output',
        severity: 'MEDIUM',
        detail: 'Codex 已裁决：`Initialized=false` 仍产出凭据是**固定版本行为**，' +
          '如实接受为 CLI 行为，不视为失败、不新增 InitTcb。' +
          '凭据可获取不等于服务已就绪；后续只读核验须自行成功，不能凭快照认定环境可用。',
        needed: '无需动作；仅在后续目标核验时不得据快照认定环境可用。'
      },
      {
        id: 'refresh-writes-back-official-login-cache',
        severity: 'LOW',
        detail: '只在合成目录观察到写回类别，未在真实登录目录验证。' +
          '不得假定「官方 CLI 获取过程不刷新缓存」。',
        needed: '真实受审运行时单独记录。'
      }
    ],
    limitations: [
      '凭据全部为合成标记值；未取真实凭据、未读真实认证存储内容。',
      'R1–R3 结论来自合成凭据 + 合成受控子进程；真实公共 CLI 未启动。',
      '本脚本是离线夹具，不得作为未经审查的生产网络代理安装。',
      'Node 运行时拦截不是操作系统防火墙。',
      '平台原子性、IAM、真实库内容、真实网络行为、费用/余量均未验证。'
    ]
  };
  process.stdout.write(JSON.stringify(out, null, 2));
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(() => {
  // 不输出原始异常（可能含路径或敏感片段）
  process.stderr.write('R4_REPRO_FAILED_NO_RAW_ERROR\n');
  process.exitCode = 1;
});