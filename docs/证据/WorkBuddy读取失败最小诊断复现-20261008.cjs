'use strict';
/**
 * 读取失败最小诊断 —— 离线复现（stdout-only，全进程拦截）
 * =====================================================
 * 背景：Codex 首次真实执行（2026-10-08 18:21:38—18:21:45）取得真实凭据并通过
 * 三条 CLI 关联，但 `schtest_v1_app_admins/primary` 为 UNCONFIRMED/READ_FAILED。
 * 根因：worker 的 catch 把任意异常统一转成 READ_FAILED，父层只收到该通用码，
 * 因此无法区分本地 SDK 异常、网络错误、签名/IAM 拒绝、集合不存在。
 *
 * 本脚本只验证**诊断实现**，**不声称真实 READ_FAILED 根因已查明**。
 *
 * 静态契约依据（`@cloudbase/database` 1.4.1，只读核对，未联网）：
 *  - `src/utils/utils.ts:56-77`：`TcbError` 携带 code/message，由 `E({...res})` 构造。
 *  - `src/document.ts:320-360` `get()`：`res.code` 存在时**直接返回 res**（不抛），
 *    该响应可能不含 requestId；否则返回 `{data, requestId, offset, limit}`。
 *  - `src/const/code.ts`：SDK 自身错误码集合（白名单来源）。
 *
 * 硬边界：未执行真实 secrets 命令、未取真实凭据、未读认证存储内容、不联网、
 * 不安装、不初始化、不建资源、不部署、不启用入口。
 * 仅本地合成传输；历史真实执行证据原样保留、未覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MINIAPP = path.join(PROJECT_ROOT, 'miniapp');
const WORKER_PATH = path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs');

const originalSpawn = cp.spawn;
let allowedLocalNodeChecks = 0;
let blockedUnexpectedProcesses = 0;

cp.spawn = function (bin, argv, options) {
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '-e' &&
    argv[1] === 'process.stdout.write(require("node:os").homedir())') {
    allowedLocalNodeChecks++;
    return originalSpawn.call(cp, bin, argv, options);
  }
  blockedUnexpectedProcesses++;
  throw Object.assign(new Error('DIAG_UNEXPECTED_PROCESS_BLOCKED'), { code: 'DIAG_PROCESS_BLOCKED' });
};

const o = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'));
const w = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'));
const cliObserver = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-readonly-observer.cjs'));

const results = [];
function record(id, pass, observed) {
  results.push({ id, pass: Boolean(pass), observed: observed === undefined ? null : observed });
}

const UUID = '5dc5d7cb-6deb-42d5-9c36-36a958d574f8';

/**
 * 运行**真实 worker 主入口**，只把 SDK 请求传输替换为合成只读/抛错传输。
 * 因此产出的诊断来自 worker 源码里的真实 catch，不是手写对象。
 */
async function runRealWorkerMain(opts) {
  const options = opts || {};
  const sdkRoot = o.FIXED.sdkRoot;
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const originalReqClass = database.Db.reqClass;
  const calls = [];
  const docs = options.docs || {};
  const requestId = options.requestId === undefined ? UUID : options.requestId;
  class SyntheticRequest {
    async send(action, params) {
      calls.push(params.collectionName);
      if (options.throwOn) {
        // target 选取：'primary' / 'users' 指定集合；其余值（如 'type'）表示
        // 在 primary 集合上按该模式抛错
        const which = options.throwOn === 'users' ? w.USER_COLLECTION : w.ADMIN_COLLECTION;
        if (params.collectionName === which) {
          const isType = options.throwOn === 'type' || options.throwOn === 'primary-type';
          const err = isType
            ? new TypeError(options.message || 'SYNTHETIC_LOCAL')
            : new Error(options.message || 'SYNTHETIC_GENERIC');
          if (options.errorCode) err.code = options.errorCode;
          if (options.errCode) err.errCode = options.errCode;
          if (options.requestId) err.requestId = options.requestId;
          if (options.extra) for (const k of Object.keys(options.extra)) err[k] = options.extra[k];
          throw err;
        }
      }
      const doc = docs[params.collectionName];
      return { data: { list: doc === undefined ? [] : [JSON.stringify(doc)] }, requestId };
    }
  }
  const input = new PassThrough();
  const mod = { exports: {} };
  const actualRequire = createRequire(WORKER_PATH);
  function localRequire(name) {
    if (name.replace(/\\/g, '/').startsWith(sdkRoot + '/@cloudbase/node-sdk')) {
      return {
        init(config) {
          const app = sdk.init(config);
          return { database() { const db = app.database(); database.Db.reqClass = SyntheticRequest; return db; } };
        }
      };
    }
    return actualRequire(name);
  }
  localRequire.resolve = actualRequire.resolve;
  localRequire.main = mod;
  let resolveOutput;
  const output = new Promise(r => { resolveOutput = r; });
  const context = {
    module: mod, exports: mod.exports, require: localRequire, Buffer,
    process: { stdin: input, stdout: { write(s) { resolveOutput(JSON.parse(s)); return true; } } }
  };
  try {
    vm.runInNewContext(fs.readFileSync(WORKER_PATH, 'utf8'), context, { filename: WORKER_PATH });
    const payload = {
      secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', sessionToken: 'SYNTHETIC_TOKEN',
      targetUserId: options.targetUserId || null,
      expiresAtMs: Date.now() + 600000
    };
    input.end(JSON.stringify(payload) + '\n');
    return { result: await output, calls };
  } finally {
    database.Db.reqClass = originalReqClass;
  }
}

/** 父进程完整链：worker 输出 → interpretWorkerOutput → interpretPrimary/TargetUser。 */
function parentChain(workerResult, targetUserId) {
  const normalized = o.interpretWorkerOutput({
    code: 0, signal: null, stdout: JSON.stringify(workerResult),
    terminationConfirmed: true, targetUserId: targetUserId || null
  });
  return {
    normalized,
    primary: o.interpretPrimary(normalized, targetUserId),
    target: o.interpretTargetUser(normalized, targetUserId)
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-repro-'));
  const target = w.deriveUserId(o.FIXED.wxAppId, 'synthetic-offline-only');
  const userDoc = { [w.USER_COLLECTION]: { _id: target, status: 'active', openid: 'synthetic-offline-only' } };

  // ── 1. 真实 worker catch → 父进程顶层：白名单码与 requestId 贯穿 ────────
  {
    const { result } = await runRealWorkerMain({
      targetUserId: target, throwOn: 'primary',
      errorCode: 'DATABASE_REQUEST_FAILED', requestId: UUID,
      message: 'SENSITIVE_MESSAGE_MUST_NOT_LEAK',
      extra: { stack: 'STACK_LEAK', cause: { secret: 'CAUSE_LEAK' },
        url: 'https://secret.example/x', headers: { authorization: 'BEARER_LEAK' } },
      docs: userDoc
    });
    const chain = parentChain(result, target);
    const d = chain.primary.readDiagnostics;
    const dumped = JSON.stringify(result) + JSON.stringify(chain.primary);
    const leaks = ['SENSITIVE_MESSAGE_MUST_NOT_LEAK', 'STACK_LEAK', 'CAUSE_LEAK',
      'secret.example', 'BEARER_LEAK']
      .filter(x => dumped.includes(x));
    record('D1-allowlisted-code-and-requestid-flow-to-toplevel',
      result.primary.classification === 'UNCONFIRMED' &&
      result.primary.errorCode === 'READ_FAILED' &&
      chain.primary.status === 'UNCONFIRMED' &&
      d && d.readStage === 'PRIMARY_READ' &&
      d.errorCode === 'DATABASE_REQUEST_FAILED' &&
      d.requestId === UUID &&
      leaks.length === 0,
      {
        workerClassification: result.primary.classification,
        workerErrorCode: result.primary.errorCode,
        topLevelStatus: chain.primary.status,
        diagnostics: d,
        leakMarkers: leaks,
        note: '失败关闭语义保留（UNCONFIRMED/READ_FAILED），诊断只是附加信息'
      });
  }

  // ── 2. 未知 code/errCode 一律 OTHER ────────────────────────────────────
  {
    const cases = [
      { label: 'unknown-code', opts: { errorCode: 'PLATFORM_MARKER_XYZ' }, expect: 'OTHER' },
      { label: 'unknown-errCode', opts: { errCode: 'ANOTHER_UNKNOWN_123' }, expect: 'OTHER' },
      { label: 'numeric-code', opts: { errorCode: 12345 }, expect: 'OTHER' },
      { label: 'allowlisted', opts: { errorCode: 'INVALID_PARAM' }, expect: 'INVALID_PARAM' }
    ];
    const rows = [];
    let allOk = true;
    for (const c of cases) {
      const { result } = await runRealWorkerMain({
        targetUserId: target, throwOn: 'primary',
        message: 'LEAK_' + c.label, docs: userDoc, ...c.opts
      });
      const got = result.primary.readDiagnostics.errorCode;
      const leaked = JSON.stringify(result).includes('LEAK_' + c.label);
      const ok = got === c.expect && leaked === false;
      if (!ok) allOk = false;
      rows.push({ label: c.label, expected: c.expect, got, messageLeaked: leaked });
    }
    record('D2-unknown-codes-collapse-to-other', allOk, { rows });
  }

  // ── 3. 本地异常类别区分有限 ────────────────────────────────────────────
  {
    const rows = [];
    let allOk = true;
    const expectations = [
      { make: () => new TypeError('x'), expect: 'LOCAL_TYPE_ERROR' },
      { make: () => new ReferenceError('x'), expect: 'LOCAL_REFERENCE_ERROR' },
      { make: () => new SyntaxError('x'), expect: 'LOCAL_SYNTAX_ERROR' },
      { make: () => new Error('x'), expect: 'UNKNOWN' },
      { make: () => 'string-not-error', expect: 'NOT_AN_ERROR' },
      { make: () => null, expect: 'NOT_AN_ERROR' }
    ];
    for (const e of expectations) {
      const layer1 = w.classifyLocalError(e.make());
      const layer2 = o.rebuildReadDiagnostics({
        readStage: 'PRIMARY_READ', localErrorClass: layer1,
        errorCode: 'READ_FAILED', requestId: null
      }).localErrorClass;
      const ok = layer1 === e.expect && layer2 === e.expect;
      if (!ok) allOk = false;
      rows.push({ expected: e.expect, layer1, layer2, matched: ok });
    }
    // 真实 worker 抛 TypeError 的情形
    const { result, calls } = await runRealWorkerMain({
      targetUserId: target, throwOn: 'type', docs: userDoc, message: 'SYNTH_TYPE'
    });
    // 防假阳性：必须确认 primary 真的失败了
    const primaryFailed = result.primary.classification === 'UNCONFIRMED' &&
      result.primary.errorCode === 'READ_FAILED';
    if (!primaryFailed) allOk = false;
    const realClass = result.primary.readDiagnostics.localErrorClass;
    if (realClass !== 'LOCAL_TYPE_ERROR') allOk = false;
    rows.push({ expected: 'LOCAL_TYPE_ERROR', viaRealWorker: realClass,
      primaryClassification: result.primary.classification, primaryFailed,
      readsObserved: calls.length,
      note: 'worker 两条读取相互独立，primary 失败后仍读 users（既有设计）' });
    record('D3-local-error-classes-bounded', allOk, {
      classes: o.LOCAL_ERROR_CLASSES.slice(), rows,
      note: '只区分本地代码问题，不据此推断平台拒绝或集合不存在'
    });
  }

  // ── 4. 平台错误响应路径（get() 返回 res 而非抛出） ─────────────────────
  {
    const n1 = w.normalizeReadResult({ code: 'DATABASE_REQUEST_FAILED' }, 'primary');
    const n2 = w.normalizeReadResult({ code: 'WEIRD_PLATFORM_CODE', requestId: UUID }, 'primary');
    const chain = parentChain({
      ok: true, writeAttemptsCount: 0, errorCode: null,
      primary: { classification: 'UNCONFIRMED', docId: 'primary', errorCode: 'READ_FAILED',
        hasPlatformError: true,
        readDiagnostics: { readStage: 'PRIMARY_READ', localErrorClass: 'UNKNOWN',
          errorCode: n1.errorCode, requestId: n1.requestId } }
    }, null);
    record('D4-platform-error-response-path',
      n1.classification === 'UNCONFIRMED' && n1.hasPlatformError === true &&
      n1.errorCode === 'DATABASE_REQUEST_FAILED' && n1.requestId === null &&
      n2.errorCode === 'OTHER' && n2.requestId === UUID &&
      chain.primary.errorCode === 'READ_FAILED' &&
      chain.primary.readDiagnostics.errorCode === 'DATABASE_REQUEST_FAILED',
      {
        allowlisted: { code: n1.errorCode, requestId: n1.requestId },
        unknownPlatform: { code: n2.errorCode, requestId: n2.requestId },
        note: '固定源码 document.ts:337 —— res.code 存在时 get() 直接返回 res，可能无 requestId'
      });
  }

  // ── 5. 缺字段仍为已知未知，不崩不猜 ──────────────────────────────────
  {
    const bare = w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, new Error('x'));
    const nullErr = w.buildReadDiagnostics(w.READ_STAGE.TARGET_USER, null);
    const badUuid = (() => { const e = new Error('x'); e.requestId = 'not-a-uuid'; return w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, e); })();
    record('D5-missing-fields-become-unknown',
      bare.localErrorClass === 'UNKNOWN' && bare.errorCode === 'OTHER' && bare.requestId === null &&
      nullErr.errorCode === 'OTHER' && nullErr.requestId === null &&
      badUuid.requestId === null &&
      o.rebuildReadDiagnostics(null) === null &&
      o.rebuildReadDiagnostics('READ_FAILED') === null,
      { bare, nullErr, badUuid });
  }

  // ── 6. 字段集固定：不得出现 message/stack/cause/头/URL ────────────────
  {
    const e = new Error('SENSITIVE');
    e.code = 'DATABASE_REQUEST_FAILED';
    e.stack = 'STACK_LEAK';
    e.cause = { secret: 'CAUSE_LEAK' };
    e.requestId = UUID;
    e.url = 'https://secret.example/x';
    e.headers = { authorization: 'BEARER_LEAK' };
    e.openid = 'OPENID_MUST_NOT_LEAK';
    const d1 = w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, e);
    const d2 = o.rebuildReadDiagnostics(d1);
    const keys = ['errorCode', 'localErrorClass', 'readStage', 'requestId'];
    const dumped = JSON.stringify(d1) + JSON.stringify(d2);
    const leaks = ['SENSITIVE', 'STACK_LEAK', 'CAUSE_LEAK', 'secret.example',
      'BEARER_LEAK', 'OPENID_MUST_NOT_LEAK'].filter(x => dumped.includes(x));
    record('D6-field-set-fixed-four-keys',
      JSON.stringify(Object.keys(d1).sort()) === JSON.stringify(keys.slice().sort()) &&
      JSON.stringify(Object.keys(d2).sort()) === JSON.stringify(keys.slice().sort()) &&
      leaks.length === 0,
      { keys, leaks });
  }

  // ── 7. 正常只读路径不回归 ──────────────────────────────────────────────
  {
    const { result, calls } = await runRealWorkerMain({
      targetUserId: target,
      docs: {
        [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
        [w.USER_COLLECTION]: { _id: target, status: 'active', openid: 'synthetic-offline-only' }
      }
    });
    const chain = parentChain(result, target);
    record('D7-normal-readonly-path-not-regressed',
      calls.length === 2 && result.ok === true &&
      result.primary.classification === 'OBSERVED' &&
      result.targetUser.classification === 'OBSERVED' &&
      chain.primary.status === 'OBSERVED' && chain.target.status === 'OBSERVED' &&
      chain.primary.readDiagnostics === null && chain.target.readDiagnostics === null,
      {
        reads: calls.length,
        primary: chain.primary.status,
        targetUser: chain.target.status,
        diagnosticsWhenNormal: [chain.primary.readDiagnostics, chain.target.readDiagnostics]
      });
  }

  // ── 8. 白名单只含源码可确定的码；平台侧未验证码不在内 ──────────────────
  {
    const src = fs.readFileSync(WORKER_PATH, 'utf8');
    const sdkCodeSrc = fs.readFileSync(
      path.join(o.FIXED.sdkRoot, '@cloudbase', 'database', 'src', 'const', 'code.ts'), 'utf8');
    // 从固定 SDK 源码里提取 code 字面量，确认白名单与之相符
    const sdkCodes = new Set();
    const re = /code:\s*'([A-Z_]+)'/g;
    let m;
    while ((m = re.exec(sdkCodeSrc)) !== null) sdkCodes.add(m[1]);
    const whitelist = Array.from(w.READ_ERROR_CODE_ALLOWLIST);
    const sdkDerived = whitelist.filter(x => sdkCodes.has(x));
    record('D8-whitelist-traced-to-fixed-sdk-source',
      sdkCodes.size > 0 && sdkDerived.length >= 5 &&
      whitelist.includes('READ_FAILED') &&
      // 平台侧常见猜测码不得在白名单内
      !whitelist.includes('PERMISSION_DENIED') &&
      !whitelist.includes('COLLECTION_NOT_EXIST') &&
      !whitelist.includes('UNAUTHENTICATED'),
      {
        sdkSourceCodeCount: sdkCodes.size,
        sdkCodesInWhitelist: sdkDerived,
        whitelistSize: whitelist.length,
        workerDeclaresAllowlist: src.includes('READ_ERROR_CODE_ALLOWLIST'),
        excludedGuesses: ['PERMISSION_DENIED', 'COLLECTION_NOT_EXIST', 'UNAUTHENTICATED'],
        note: '白名单来源为 SDK src/const/code.ts + 本工具自有码；平台侧猜测码一律不入'
      });
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.pass).length;
  const files = [
    'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs',
    'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs',
    'miniapp/tests/cloudbase-sdk-readonly-observer.test.cjs',
    'miniapp/scripts/check-cloudbase-sdk-readonly.cjs',
    'miniapp/scripts/lib/cloudbase-readonly-observer.cjs',
    'miniapp/scripts/check-cloudbase-readonly.cjs',
    'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs',
    'miniapp/scripts/prepare-sandbox-primary.cjs',
    'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs'
  ];
  process.stdout.write(JSON.stringify({
    observedAt: new Date().toISOString(),
    auditKind: 'offline-diagnosis-verification-not-production-component',
    scope: '读取失败最小诊断：worker catch → observer 双层投影 → 顶层',
    delivers: '诊断实现已离线验证',
    doesNotDeliver: '**真实 READ_FAILED 根因未查明**；本次未联网复验，未执行真实 secrets 命令',
    realCredentialFetches: 0,
    realCloudCalls: 0,
    realNetworkCalls: 0,
    readRealAuthStoreContent: false,
    wroteHistoricalOrBusinessFiles: false,
    wroteSyntheticTempDirs: true,
    allowedLocalNodeChecks,
    blockedUnexpectedProcesses,
    summary: { total: results.length, passed: results.length - failed, failed },
    results,
    sdkContractBasis: {
      version: require(path.join(o.FIXED.sdkRoot, '@cloudbase', 'database', 'package.json')).version,
      sources: [
        'src/utils/utils.ts:56-77 — TcbError 携带 code/message，由 E({...res}) 构造',
        'src/document.ts:320-360 — get() 在 res.code 存在时直接返回 res（不抛），可能无 requestId',
        'src/const/code.ts — SDK 自身错误码集合（白名单来源）'
      ],
      staticVsUnverified: '以上为固定源码静态契约；平台侧实际错误码与 requestId 形状**未经真实调用验证**'
    },
    preservedFailureSemantics: {
      classification: 'UNCONFIRMED',
      errorCode: 'READ_FAILED',
      noAutoRetry: true,
      noSecondCredentialFetch: true,
      noCollectionOrIndexCreation: true,
      note: '诊断只是附加信息，不改变失败关闭行为'
    },
    retainedHistoricalEvidence: {
      note: 'Codex 首次真实执行的脚本/启动标记/原始报告原样保留，未覆盖、未改写',
      files: [
        '证据/Codex真实只读单次执行-20261008.cjs',
        '证据/Codex真实只读单次执行-20261008.started.json',
        '证据/codex-real-readonly-1791454898466-e3f10f47-5e43-44d7-aff7-5db0ddac8714.json'
      ]
    },
    remainingOpen: [
      {
        id: 'real-read-failed-root-cause-unknown',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: '首次真实执行的 READ_FAILED 根因**仍未查明**。新诊断提供了区分维度' +
          '（读取阶段/本地异常类别/白名单码/合法 requestId），但要确定实际原因' +
          '仍需受审宿主内再执行一次只读诊断观测。',
        needed: 'Codex 复核本诊断实现通过后，另存一次真实只读诊断证据。'
      },
      {
        id: 'platform-error-code-space-unverified',
        severity: 'MEDIUM',
        detail: '白名单只含 SDK 源码可确定的码；平台侧实际返回的错误码与 requestId 形状' +
          '未经真实调用验证，命中即归OTHER。',
        needed: '真实诊断观测后按实际观测补充白名单，不得凭猜测扩充。'
      },
      {
        id: 'production-same-batch-chain-not-proven',
        severity: 'MEDIUM',
        detail: '真实凭据获取与三条 CLI 关联已通过，但 SDK 未取得可用数据库结果，' +
          '完整生产同批链仍不能判通过；proven 恒 false。',
        needed: '数据库读取可用后再评估；不得据凭据输出认定环境可用。'
      }
    ],
    limitations: [
      '全部为合成传输与合成凭据；未执行真实云请求。',
      'SDK 契约为固定源码静态核对，不等于平台实际行为已验证。',
      'Node 运行时拦截不是操作系统防火墙。',
      '不改变集合是否存在、权限状态或初始化需求 —— 这些仍未结论化。'
    ],
    sha256: Object.fromEntries(files.map(f => [f,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJECT_ROOT, f))).digest('hex')]))
  }, null, 2));
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(() => {
  process.stderr.write('DIAG_REPRO_FAILED_NO_RAW_ERROR\n');
  process.exitCode = 1;
});