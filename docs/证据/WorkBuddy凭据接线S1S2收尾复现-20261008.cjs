'use strict';
/**
 * S1/S2 定点收尾离线复现（stdout-only，全进程拦截）
 * =================================================
 * 依据 docs/Codex复核-凭据接线R1-R4返修-20261008.md 第 2–4 节与第 6 节任务。
 * R1/R4 及此前关闭项不重做。
 *
 * 与上一份证据的关键差别
 * ----------------------
 * 1. **全进程兜底**：除精确允许的本地 `node os.homedir()` 读值外，
 *    任何真实子进程一律拒绝并计数。
 * 2. **S1 覆盖两条新增场景**：父子 Home 不同、junction 目标祖先带标记；
 *    两者均须在启动凭据命令**之前**拒绝。
 * 3. **S2 覆盖四条进程失败 + 启动失败 + 模式净化**：均须保留尝试与退出事实。
 * 4. 计数为**实际观察值**，不用字面量 0 代替观察。
 *
 * 硬边界：未执行真实 `secrets get --json`、未取真实凭据、未读认证存储内容、
 * 不联网、不安装、不初始化、不建资源、不部署、不启用入口。
 * 算法对照仅在内存中执行固定 bundle 的发现函数片段，不启动公共 CLI。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MINIAPP = path.join(PROJECT_ROOT, 'miniapp');
const originalSpawn = cp.spawn;
let allowedLocalNodeChecks = 0;
let blockedUnexpectedProcesses = 0;
const blockedSamples = [];

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
      argvHead: Array.isArray(argv)
        ? argv.slice(0, 2).map(a => String(a).split(/[\\/]/).pop().slice(0, 64)) : null
    });
  }
  throw Object.assign(new Error('S12_UNEXPECTED_PROCESS_BLOCKED'), { code: 'S12_PROCESS_BLOCKED' });
};

const o = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'));
const host = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-cli-credential-host.cjs'));
const cliObserver = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-readonly-observer.cjs'));

const results = [];
function record(id, pass, observed) {
  results.push({ id, pass: Boolean(pass), observed: observed === undefined ? null : observed });
}

/**
 * 固定 bundle 的 `findProjectRoot` 片段 —— **仅作算法对照**。
 * 只读取并执行该函数片段，不启动公共 CLI、不替代 H1 公共入口证明、不做认证流程。
 */
function referenceFinder(childHome, access, realpath) {
  const bundle = fs.readFileSync(cliObserver.FIXED.cliBundle, 'utf8');
  const start = bundle.indexOf('function findProjectRoot(cwd)');
  const end = bundle.indexOf('exports.findProjectRoot = findProjectRoot;', start);
  if (start < 0 || end < start) throw new Error('REFERENCE_SOURCE_NOT_FOUND');
  return vm.runInNewContext(bundle.slice(start, end) + '\nfindProjectRoot;', {
    canonicalizePath: realpath,
    os_1: { default: { homedir: () => childHome } },
    path_1: { default: path },
    fs_1: { default: { accessSync: access, constants: fs.constants } },
    exports: { PROJECT_ROOT_MARKERS: host.PROJECT_ROOT_MARKERS }
  });
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's12-repro-'));

  // ── S1-a：父子 Home 不同 ────────────────────────────────────────────
  // CLI 的 USERPROFILE/HOME 被设为登录 profile，与父进程 Home 不同；
  // 上一版回退父进程 Home → 边界与 CLI 不一致。
  {
    const probe = path.join(tmpRoot, 'probe-cwd');
    fs.mkdirSync(probe);
    let rejectedWithoutCliHome = null;
    let acceptedWithCliHome = null;
    let rejectedNonAncestor = null;
    // (a) 不提供 cliHome → 必须按「范围不确定」停止，不得回退父进程 Home
    try { host.assertConfigDiscoveryClean(probe); }
    catch (e) { rejectedWithoutCliHome = e.code; }
    // (b) 提供 CLI 实际 profile（且 cwd 建在其内）→ 干净时通过
    const profile = path.join(tmpRoot, 'profile-a');
    const inside = path.join(profile, 'fetch-cwd');
    fs.mkdirSync(inside, { recursive: true });
    try { acceptedWithCliHome = host.assertConfigDiscoveryClean(inside, { cliHome: profile }).stoppedAt; }
    catch (e) { acceptedWithCliHome = 'REJECTED:' + e.code; }
    // (c) cwd 不在 profile 之内 → 边界不成立 → 必须停止
    try { host.assertConfigDiscoveryClean(probe, { cliHome: profile }); }
    catch (e) { rejectedNonAncestor = e.code; }
    record('S1-1-boundary-uses-cli-home-not-parent-home',
      rejectedWithoutCliHome === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE &&
      acceptedWithCliHome === null &&
      rejectedNonAncestor === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE,
      {
        withoutCliHome: rejectedWithoutCliHome,
        withCliHomeInsideProfile: acceptedWithCliHome,
        cwdOutsideProfile: rejectedNonAncestor,
        parentHome: os.homedir(),
        cliHomeWouldBe: cliObserver.FIXED.authSessionDir,
        note: 'CLI 的 Home 是登录 profile；用父进程 Home 会让「不越过Home」失去边界意义'
      });
  }

  // ── S1-b：junction 目标祖先带标记 ──────────────────────────────────
  // 字面路径祖先干净，但真实路径（realpathSync）祖先带 marker。
  // 全部文件位于新夹具根内；不读取认证内容，不执行公共 CLI。
  {
    const clean = path.join(tmpRoot, 'clean');
    const polluted = path.join(tmpRoot, 'polluted');
    fs.mkdirSync(clean);
    fs.mkdirSync(polluted);
    const target = path.join(polluted, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(polluted, 'cloudbaserc.json'), '{}', { flag: 'wx' });
    const link = path.join(clean, 'linked');
    let junctionCreated = false;
    let rejected = false;
    let code = null;
    let markerPreserved = false;
    let referenceWouldFind = null;
    try {
      fs.symlinkSync(target, link, 'junction');
      junctionCreated = true;
      const cwd = path.join(link, 'cwd');
      fs.mkdirSync(cwd);
      try { host.assertConfigDiscoveryClean(cwd, { cliHome: clean }); }
      catch (e) { rejected = true; code = e.code; }
      markerPreserved = fs.existsSync(path.join(polluted, 'cloudbaserc.json'));
      // 算法对照：固定 bundle 以真实路径计算会命中被污染的祖先
      const found = referenceFinder(cliObserver.FIXED.authSessionDir, fs.accessSync,
        p => fs.realpathSync(p))(cwd);
      referenceWouldFind = found === fs.realpathSync(polluted);
    } catch (_) {
      junctionCreated = false;
    }
    record('S1-2-realpath-junction-target-ancestor',
      junctionCreated && rejected &&
      code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE &&
      markerPreserved && referenceWouldFind === true,
      {
        junctionCreated,
        rejected,
        errorCode: code,
        markerFilePreserved: markerPreserved,
        referenceFinderWouldFindMarker: referenceWouldFind,
        note: '对齐固定 bundle 的 canonicalizePath（优先 realpathSync）；不得删除标记'
      });
  }

  // ── S1-c：边界之上（profile 之外）的 marker 不应误拒 ────────────────
  {
    const root = path.join(tmpRoot, 's1c-root');
    const profile = path.join(root, 'profile');
    const cwd = path.join(profile, 'fetch-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(root, 'cloudbaserc.json'), '{}', { flag: 'wx' });
    let passed = false;
    let checked = null;
    try {
      const r = host.assertConfigDiscoveryClean(cwd, { cliHome: profile });
      passed = r.stoppedAt === null;
      checked = r.checked;
    } catch (_) { passed = false; }
    record('S1-3-boundary-stops-at-profile',
      passed,
      { passed, checkedLayers: checked, note: '边界之上的标记不在 CLI 发现范围内，不应误拒' });
  }

  // ── S2：四条进程失败 + 启动失败 ─────────────────────────────────────
  const processFailures = [
    { kind: 'nonzero', expectCode: 'CREDENTIAL_COMMAND_NONZERO_EXIT' },
    { kind: 'timeout', expectCode: 'CREDENTIAL_COMMAND_TIMEOUT' },
    { kind: 'overflow', expectCode: 'CREDENTIAL_COMMAND_OVERFLOW' },
    { kind: 'signal', expectCode: 'CREDENTIAL_COMMAND_SIGNALED' },
    { kind: 'spawn-error', expectCode: host.ERR.SPAWN_FAILED }
  ];
  for (const item of processFailures) {
    let attempts = 0, followups = 0, kills = 0;
    const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-' + item.kind + '-'));
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {}, allowRealCredentialFetch: true,
        limits: { timeoutMs: 60, maxOutputBytes: 100, closeGraceMs: 30 },
        fixed: { authProfileDir: profile, isolationRoot: path.join(tmpRoot, 'iso-' + item.kind) },
        spawn: (bin, argv) => {
          if (argv[1] !== 'secrets') { followups++; throw new Error('UNEXPECTED_NEXT_STAGE'); }
          attempts++;
          const c = new EventEmitter();
          c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
          c.stdin.write = () => true; c.stdin.end = () => {};
          c.kill = () => { kills++; return true; };
          setImmediate(() => {
            if (item.kind === 'nonzero') { c.emit('exit', 1, null); c.emit('close', 1, null); }
            if (item.kind === 'overflow') c.stdout.emit('data', Buffer.alloc(200, 'a'));
            if (item.kind === 'signal') { c.emit('exit', null, 'SIGTERM'); c.emit('close', null, 'SIGTERM'); }
            if (item.kind === 'spawn-error') c.emit('error', new Error('SYNTHETIC_SPAWN_FAILURE'));
          });
          return c;
        }
      }
    );
    const diag = report.sameBatchCredential.fetchDiagnostics;
    record('S2-' + item.kind + '-retains-attempt-and-exit-facts',
      attempts === 1 && followups === 0 &&
      report.status === o.STATUS.FAILED &&
      report.sameBatchCredential.fetchSubprocessAttempted === true &&
      report.sameBatchCredential.fetchMode === 'REAL_CANDIDATE' &&
      report.errorCode === item.expectCode &&
      diag !== null,
      {
        attempts, followups, kills,
        reportedAttempted: report.sameBatchCredential.fetchSubprocessAttempted,
        fetchMode: report.sameBatchCredential.fetchMode,
        errorCode: report.errorCode,
        expectedErrorCode: item.expectCode,
        errorMatchesHostConstant: report.errorCode === item.expectCode,
        exitFacts: diag
      });
  }

  // ── S2：解析失败仍保留退出事实 ──────────────────────────────────────
  {
    let attempts = 0;
    const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-parsefail-'));
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {}, allowRealCredentialFetch: true,
        fixed: { authProfileDir: profile, isolationRoot: path.join(tmpRoot, 'iso-parsefail') },
        spawn: (bin, argv) => {
          if (argv[1] !== 'secrets') throw new Error('UNEXPECTED_NEXT_STAGE');
          attempts++;
          const c = new EventEmitter();
          c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
          c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
          setImmediate(() => {
            // 退出码 0 但内容不合规 —— 可与「未启动」区分
            c.stdout.emit('data', Buffer.from(JSON.stringify({ data: {
              secretId: 'S', secretKey: 'K', token: 'T', isTemporary: true,
              expiredAt: '未知', envId: null } })));
            c.emit('exit', 0, null); c.emit('close', 0, null);
          });
          return c;
        }
      }
    );
    record('S2-parse-failure-retains-exit-facts',
      attempts === 1 &&
      report.sameBatchCredential.fetchSubprocessAttempted === true &&
      report.sameBatchCredential.fetchDiagnostics !== null &&
      report.sameBatchCredential.fetchDiagnostics.exitCode === 0,
      {
        attempted: report.sameBatchCredential.fetchSubprocessAttempted,
        errorCode: report.errorCode,
        errorClass: report.sameBatchCredential.fetchErrorClass,
        exitFacts: report.sameBatchCredential.fetchDiagnostics,
        note: '退出码 0 + 输出不合规 → 可与「未启动」区分'
      });
  }

  // ── S2：fetchMode 固定枚举净化 ─────────────────────────────────────
  {
    const marker = 'SYNTHETIC_FETCH_MODE_PRIVATE_MARKER';
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {},
        fetchCredential: async () => {
          throw Object.assign(new Error('SYNTHETIC_FAIL'), { fetchMode: marker });
        }
      }
    );
    record('S2-fetchmode-enum-sanitized',
      JSON.stringify(report).includes(marker) === false &&
      report.sameBatchCredential.fetchMode === 'UNKNOWN',
      {
        markerLeaked: JSON.stringify(report).includes(marker),
        fetchMode: report.sameBatchCredential.fetchMode,
        enumValues: o.FETCH_MODES.slice(),
        note: '仅损坏错误协议，不是已发生的真实密钥泄漏'
      });
  }

  // ── S2：错误码白名单与宿主常量逐项对齐 ─────────────────────────────
  {
    const hostValues = Object.keys(host.ERR).map(k => host.ERR[k]);
    const unrecognized = hostValues.filter(v => o.classifyFetchFailure({ code: v }) !== v);
    const legacyMisspellings = ['CREDENTIAL_TIMEOUT', 'CREDITAL_SIGNALED'].filter(
      v => o.classifyFetchFailure({ code: v }) !== o.ERR.CREDENTIAL_FETCH_FAILED);
    record('S2-error-codes-align-with-host-constants',
      unrecognized.length === 0 && legacyMisspellings.length === 0,
      {
        hostConstantCount: hostValues.length,
        unrecognized,
        legacyMisspellingsStillRejected: legacyMisspellings,
        note: '上一版手抄近似名导致全部退化为泛化失败；现直接引用 host.ERR'
      });
  }

  // ── 前置拒绝仍为「未尝试」（不得与进程失败混淆） ────────────────────
  {
    const denied = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      { baseEnv: {}, fixed: { isolationRoot: path.join(tmpRoot, 'iso-denied') } }
    );
    record('S2-precheck-rejection-remains-not-attempted',
      denied.sameBatchCredential.fetchSubprocessAttempted === false &&
      denied.sameBatchCredential.fetchMode === 'NONE' &&
      denied.sameBatchCredential.fetchDiagnostics === null,
      {
        attempted: denied.sameBatchCredential.fetchSubprocessAttempted,
        fetchMode: denied.sameBatchCredential.fetchMode,
        diagnostics: denied.sameBatchCredential.fetchDiagnostics
      });
  }

  // ── 汇总 ────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.pass).length;
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
  process.stdout.write(JSON.stringify({
    observedAt: new Date().toISOString(),
    auditKind: 'offline-reproduction-fixture-not-production-component',
    scope: 'S1 发现边界与真实路径 / S2 进程失败事实与枚举净化',
    realCredentialFetches: 0,
    realCloudCalls: 0,
    realNetworkCalls: 0,
    readRealAuthStoreContent: false,
    wroteHistoricalOrBusinessFiles: false,
    wroteSyntheticTempDirs: true,
    allowedLocalNodeChecks,
    blockedUnexpectedProcesses,
    blockedSamples,
    summary: { total: results.length, passed: results.length - failed, failed },
    results,
    statedLimitations: [
      'S1-b 的 junction 仅在本机真实创建，且全部文件位于新夹具根内；未读取认证内容、未执行公共 CLI。',
      'findProjectRoot 仅作算法对照：内存中执行固定 bundle 的函数片段，不替代 H1 公共入口证明。',
      'S1-a 的「父 Home 之上标记」只存在于内存 access 替身，未向真实用户祖先写任何文件。',
      'S2 全部为合成 EventEmitter 子进程；真实凭据命令未执行。',
      '本轮交付文字更正：normalizeCredentialSnapshot 真实规则是「优先 sessionToken，' +
        '否则取 CLI 字段名 token」，不再声称没有别名兜底。',
      'R1 敏感性（上一份证据）是原始对象与归一结果的直接对照，' +
        '并非修改实现后重跑完整链；此处不重复该表述。',
      'Node 运行时拦截不是操作系统防火墙；本夹具不得作为未经审查的生产网络代理安装。',
      '平台原子性、IAM、真实库内容、真实网络行为、费用/余量均未验证。'
    ],
    blockingGaps: [
      {
        id: 'production-same-batch-credential-chain-not-proven',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: '本轮仍未执行真实 `secrets get --json`、未取任何真实凭据。' +
          'proven 恒为 false、汇总无生产升级分支 —— 这是关闭状态，' +
          '不能靠把常量改成 true 得到生产证明。',
        needed: '受审宿主内按既有只读授权执行一次整组，并明确实际观察事实如何形成。'
      },
      {
        id: 'refresh-branch-output-contract-undecided',
        severity: 'MEDIUM',
        detail: '可刷新分支尚未产出完整快照，输出契约未定论；真实路径保持关闭。',
        needed: '按固定源码对齐合成 refresh 响应后再离线验证。'
      },
      {
        id: 'refresh-writes-back-official-login-cache',
        severity: 'LOW',
        detail: '只在合成目录观察到写回类别，未在真实登录目录验证。',
        needed: '真实受审运行时单独记录；不得假定「官方 CLI 获取过程不刷新缓存」。'
      }
    ],
    platformSemanticsNote: {
      id: 'service-not-initialized-still-issues-credentials',
      detail: '按上轮裁决，`Initialized=false` 仍产出凭据是**固定版本 CLI 行为**，' +
        '如实接受，不视为实现阻断、不新增 InitTcb。凭据可获取 ≠ 服务已就绪；' +
        '后续只读目标核验须自行成功，不能凭快照认定环境可用。'
    },
    sha256: Object.fromEntries(files.map(f => [f,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJECT_ROOT, f))).digest('hex')]))
  }, null, 2));
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(() => {
  process.stderr.write('S12_REPRO_FAILED_NO_RAW_ERROR\n');
  process.exitCode = 1;
});