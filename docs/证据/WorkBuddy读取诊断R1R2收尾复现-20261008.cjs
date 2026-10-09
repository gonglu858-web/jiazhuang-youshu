'use strict';
/**
 * R1/R2 定点收尾离线复现（stdout-only，全进程拦截）
 * =================================================
 * 依据 docs/Codex复核-读取失败最小诊断-20261008.md 第 2、3 节与第 4 节文案。
 * 上一轮已通过的抛异常诊断路径、正常读取路径、凭据/进程收尾/初始化均保留不重做。
 *
 * R1：返回错误对象的路径（`get()` 直接返回带 code 的 res，不抛）诊断未接到最终报告。
 * R2：`classifyLocalError` 读 error.message、`buildReadDiagnostics` 读 error.requestId
 *     未防护 —— 损坏异常对象的 getter 抛错会让**诊断构造本身**失败。
 *
 * 硬边界：未联网、未取真实凭据、未读认证存储内容、未安装、未初始化、未建资源、
 * 未部署、未启用入口。仅本地合成 SDK 传输；历史证据原样保留、未覆盖。
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
  throw Object.assign(new Error('R12_UNEXPECTED_PROCESS_BLOCKED'), { code: 'R12_PROCESS_BLOCKED' });
};

const o = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'));
const w = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'));

const results = [];
function record(id, pass, observed) {
  results.push({ id, pass: Boolean(pass), observed: observed === undefined ? null : observed });
}

const UUID = '5dc5d7cb-6deb-42d5-9c36-36a958d574f8';

/** 运行真实 worker main，仅替换 SDK 请求传输。 */
async function runRealWorkerMain(opts) {
  const options = opts || {};
  const sdkRoot = o.FIXED.sdkRoot;
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const originalReqClass = database.Db.reqClass;
  const calls = [];
  const docs = options.docs || {};
  class SyntheticRequest {
    async send(action, params) {
      calls.push(params.collectionName);
      // R1：合成传输**返回**带 code 的响应（不抛）—— 对应固定源码 document.ts:337
      if (options.returnErrorResponse) {
        const which = options.returnErrorResponse === 'users'
          ? w.USER_COLLECTION : w.ADMIN_COLLECTION;
        if (params.collectionName === which) {
          return {
            code: options.responseCode,
            requestId: options.responseRequestId,
            data: { list: [] }
          };
        }
      }
      const doc = docs[params.collectionName];
      return { data: { list: doc === undefined ? [] : [JSON.stringify(doc)] }, requestId: UUID };
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
          return {
            database() {
              const db = app.database();
              database.Db.reqClass = SyntheticRequest;
              return db;
            }
          };
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
    input.end(JSON.stringify({
      secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', sessionToken: 'SYNTHETIC_TOKEN',
      targetUserId: options.targetUserId || null,
      expiresAtMs: Date.now() + 600000
    }) + '\n');
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
    primary: o.interpretPrimary(normalized, targetUserId),
    target: o.interpretTargetUser(normalized, targetUserId)
  };
}

async function main() {
  const target = w.deriveUserId(o.FIXED.wxAppId, 'synthetic-offline-only');
  const userDoc = { [w.USER_COLLECTION]: { _id: target, status: 'active', openid: 'synthetic-offline-only' } };
  const adminDoc = { [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' } };

  // ── R1-1 primary 返回错误响应：诊断须贯穿，码原样保留 ──────────────────
  {
    const { result } = await runRealWorkerMain({
      targetUserId: target, returnErrorResponse: 'primary',
      responseCode: 'DATABASE_REQUEST_FAILED', responseRequestId: UUID, docs: userDoc
    });
    const chain = parentChain(result, target);
    const d = result.primary.readDiagnostics;
    record('R1-1-primary-returned-error-response',
      result.primary.classification === 'UNCONFIRMED' &&
      result.primary.errorCode === 'READ_FAILED' &&
      d && d.readStage === 'PRIMARY_READ' &&
      d.errorCode === 'DATABASE_REQUEST_FAILED' &&
      d.requestId === UUID &&
      chain.primary.errorCode === 'READ_FAILED' &&
      chain.primary.readDiagnostics &&
      chain.primary.readDiagnostics.errorCode === 'DATABASE_REQUEST_FAILED',
      {
        workerErrorCode: result.primary.errorCode,
        workerDiagnostics: d,
        topLevelErrorCode: chain.primary.errorCode,
        topLevelDiagnostics: chain.primary.readDiagnostics,
        beforeFix: 'readDiagnostics=null 且 errorCode=PRIMARY_UNCONFIRMED'
      });
  }

  // ── R1-2 users 返回错误响应：不得被误报为派生不匹配 ────────────────────
  {
    const { result } = await runRealWorkerMain({
      targetUserId: target, returnErrorResponse: 'users',
      responseCode: 'DATABASE_REQUEST_FAILED', docs: adminDoc
    });
    const chain = parentChain(result, target);
    const d = result.targetUser.readDiagnostics;
    record('R1-2-users-returned-error-response-not-derivation-mismatch',
      result.targetUser.errorCode === 'READ_FAILED' &&
      d && d.readStage === 'TARGET_USER_READ' &&
      d.errorCode === 'DATABASE_REQUEST_FAILED' &&
      chain.target.errorCode === 'READ_FAILED' &&
      chain.target.errorCode !== o.ERR.USER_DERIVATION_MISMATCH,
      {
        workerErrorCode: result.targetUser.errorCode,
        workerDiagnostics: d,
        topLevelErrorCode: chain.target.errorCode,
        derivationMismatch: chain.target.errorCode === o.ERR.USER_DERIVATION_MISMATCH,
        beforeFix: 'readDiagnostics=null 且 errorCode=USER_DERIVATION_MISMATCH'
      });
  }

  // ── R1-3 未知码一律 OTHER，但仍 READ_FAILED ────────────────────────────
  {
    const rows = [];
    let allOk = true;
    for (const spec of [
      { which: 'primary', code: 'WEIRD_PLATFORM_CODE', expectDiag: 'OTHER' },
      { which: 'users', code: 'MYSTERY_CODE', expectDiag: 'OTHER' },
      { which: 'primary', code: 'INVALID_PARAM', expectDiag: 'INVALID_PARAM' }
    ]) {
      const { result } = await runRealWorkerMain({
        targetUserId: target, returnErrorResponse: spec.which,
        responseCode: spec.code,
        docs: spec.which === 'primary' ? userDoc : adminDoc
      });
      const rec = spec.which === 'primary' ? result.primary : result.targetUser;
      const diag = rec.readDiagnostics;
      const ok = rec.errorCode === 'READ_FAILED' && diag &&
        diag.errorCode === spec.expectDiag &&
        JSON.stringify(result).includes(spec.code) === (spec.expectDiag !== 'OTHER');
      if (!ok) allOk = false;
      rows.push({
        which: spec.which, responseCode: spec.code,
        recordErrorCode: rec.errorCode, diagnosticErrorCode: diag && diag.errorCode,
        expected: spec.expectDiag
      });
    }
    record('R1-3-unknown-response-code-collapses-to-other', allOk, { rows });
  }

  // ── R1-4 非错误响应路径不得被泛加平台错误含义 ──────────────────────────
  {
    const { result } = await runRealWorkerMain({ targetUserId: target, docs: userDoc });
    const chain = parentChain(result, target);
    record('R1-4-not-found-not-marked-as-read-failure',
      result.primary.classification === 'NOT_FOUND' &&
      result.primary.readDiagnostics === undefined &&
      result.primary.errorCode !== 'READ_FAILED' &&
      chain.primary.status === 'NOT_FOUND' &&
      chain.primary.readDiagnostics === null,
      {
        classification: result.primary.classification,
        recordErrorCode: result.primary.errorCode,
        workerDiagnostics: result.primary.readDiagnostics,
        topLevelDiagnostics: chain.primary.readDiagnostics,
        note: 'NOT_FOUND 与坏形状路径不泛加平台错误含义'
      });
  }

  // ── R2-1 message getter 抛错：诊断不抛、不输出原文 ─────────────────────
  {
    const e = new Error('SENSITIVE_MESSAGE_MUST_NOT_LEAK');
    Object.defineProperty(e, 'name', { value: null });
    Object.defineProperty(e, 'message', { get() { throw new Error('BOOM_MESSAGE'); } });
    let d = null;
    let threw = false;
    try { d = w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, e); } catch (_) { threw = true; }
    const dumped = d ? JSON.stringify(d) : '';
    record('R2-1-message-getter-throwing-does-not-break',
      !threw && d &&
      d.localErrorClass === 'UNKNOWN' && d.errorCode === 'OTHER' && d.requestId === null &&
      dumped.includes('SENSITIVE_MESSAGE_MUST_NOT_LEAK') === false &&
      dumped.includes('BOOM_MESSAGE') === false,
      { threw, diagnostics: d, note: '诊断已不读 error.message' });
  }

  // ── R2-2 requestId getter 抛错：固定 null ─────────────────────────────
  {
    const e = new Error('x');
    Object.defineProperty(e, 'requestId', { get() { throw new Error('BOOM_REQUESTID'); } });
    let d = null;
    let threw = false;
    try { d = w.buildReadDiagnostics(w.READ_STAGE.TARGET_USER, e); } catch (_) { threw = true; }
    record('R2-2-requestid-getter-throwing-does-not-break',
      !threw && d && d.requestId === null &&
      d.readStage === 'TARGET_USER_READ' &&
      d.localErrorClass === 'UNKNOWN' && d.errorCode === 'OTHER' &&
      JSON.stringify(d).includes('BOOM_REQUESTID') === false,
      { threw, diagnostics: d });
  }

  // ── R2-3 未知 name 归 UNKNOWN，NOT_AN_ERROR 仅限非对象输入 ─────────────
  {
    const boom = new Error('x');
    Object.defineProperty(boom, 'name', { get() { throw new Error('BOOM_NAME'); } });
    const rows = [
      { input: 'name getter 抛错', got: w.classifyLocalError(boom), expect: 'UNKNOWN' },
      { input: 'TcbError（SDK自有）', got: w.classifyLocalError(Object.assign(new Error('x'), { name: 'TcbError' })), expect: 'UNKNOWN' },
      { input: '自定义名称', got: w.classifyLocalError({ name: 'SomeCustomError' }), expect: 'UNKNOWN' },
      { input: 'name 缺失', got: w.classifyLocalError(Object.defineProperty(new Error('x'), 'name', { value: null })), expect: 'UNKNOWN' },
      { input: 'null', got: w.classifyLocalError(null), expect: 'NOT_AN_ERROR' },
      { input: 'undefined', got: w.classifyLocalError(undefined), expect: 'NOT_AN_ERROR' },
      { input: '字符串', got: w.classifyLocalError('s'), expect: 'NOT_AN_ERROR' },
      { input: '数字', got: w.classifyLocalError(42), expect: 'NOT_AN_ERROR' }
    ];
    record('R2-3-unknown-name-is-unknown-not-not-an-error',
      rows.every(r => r.got === r.expect), { rows });
  }

  // ── 第 4 节：真正 Error/TypeError 不回归；文案与范围说明已更正 ─────────
  {
    const rows = [
      { input: 'TypeError', got: w.classifyLocalError(new TypeError('x')), expect: 'LOCAL_TYPE_ERROR' },
      { input: 'ReferenceError', got: w.classifyLocalError(new ReferenceError('x')), expect: 'LOCAL_REFERENCE_ERROR' },
      { input: 'SyntaxError', got: w.classifyLocalError(new SyntaxError('x')), expect: 'LOCAL_SYNTAX_ERROR' },
      { input: 'Error', got: w.classifyLocalError(new Error('x')), expect: 'UNKNOWN' }
    ];
    const src = fs.readFileSync(WORKER_PATH, 'utf8');
    const observerSrc = fs.readFileSync(
      path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'), 'utf8');
    // 文案核查：不得再断言「本地代码来源」；替换字符须为 0
    const noSourceClaim = !/断定来源|即为本地代码问题|必然来自本地/.test(src) ||
      src.includes('不能可靠证明');
    const noReplacementChar = !src.includes('\ufffd') && !observerSrc.includes('\ufffd');
    const hasScopeNote = src.includes('独立子进程') && src.includes('VM/夹具');
    record('R4-wording-and-scope-corrected',
      rows.every(r => r.got === r.expect) && noReplacementChar && hasScopeNote,
      {
        rows,
        replacementCharsInWorker: (src.match(/\ufffd/g) || []).length,
        replacementCharsInObserver: (observerSrc.match(/\ufffd/g) || []).length,
        mentionsSubprocessVsVm: hasScopeNote,
        nameClassificationOnly: src.includes('名称分类'),
        note: 'name 分类只是观察到的名称，不能断定实际来源'
      });
  }

  // ── 上一轮已通过项不回归：抛异常诊断路径 + 正常读取 ────────────────────
  {
    const { result, calls } = await runRealWorkerMain({
      targetUserId: target,
      docs: {
        [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
        [w.USER_COLLECTION]: { _id: target, status: 'active', openid: 'synthetic-offline-only' }
      }
    });
    const chain = parentChain(result, target);
    record('P-retained-normal-and-throwing-paths',
      calls.length === 2 && result.ok === true &&
      result.primary.classification === 'OBSERVED' &&
      result.targetUser.classification === 'OBSERVED' &&
      chain.primary.status === 'OBSERVED' && chain.target.status === 'OBSERVED' &&
      chain.primary.readDiagnostics === null && chain.target.readDiagnostics === null,
      {
        reads: calls.length,
        primary: chain.primary.status, targetUser: chain.target.status,
        note: '正常读取不回归；抛异常诊断路径由既有 DG-1 覆盖，仍通过'
      });
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.pass).length;
  const files = [
    'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs',
    'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs',
    'miniapp/tests/cloudbase-sdk-readonly-observer.test.cjs',
    'miniapp/scripts/check-cloudbase-sdk-readonly.cjs',
    'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs',
    'miniapp/scripts/lib/cloudbase-readonly-observer.cjs',
    'miniapp/scripts/check-cloudbase-readonly.cjs'
  ];
  process.stdout.write(JSON.stringify({
    observedAt: new Date().toISOString(),
    auditKind: 'offline-fix-verification-not-production-component',
    scope: 'R1 返回错误响应的诊断贯穿 / R2 异常属性访问防护 / 第4节文案',
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
      keyFact: 'src/document.ts:337 —— res.code 存在时 get() 直接返回 res 而不抛；' +
        '该路径不经过 catch，诊断必须在组包阶段接上',
      staticOnly: '固定源码静态事实；平台实际返回码与 requestId 形状未经真实调用验证'
    },
    retainedFromPreviousRound: [
      '凭据获取、进程收尾、初始化、业务实现等已关闭项未重做',
      '抛异常路径的白名单码/合法 requestId/异常名称分类可贯穿父层（既有 DG-1 仍通过）',
      '正常只读路径不回归'
    ],
    remainingOpen: [
      {
        id: 'real-read-failed-root-cause-unknown',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: '真实READ_FAILED 根因**仍未查明**。本轮只修诊断实现，' +
          '未联网复验、未执行真实 secrets 命令、未取真实凭据。' +
          '本轮交付的是「诊断实现已离线验证」，不是根因结论。',
        needed: 'Codex 复核通过后再执行一次真实只读诊断观测。'
      },
      {
        id: 'platform-error-code-space-unverified',
        severity: 'MEDIUM',
        detail: '白名单未扩大；平台侧实际错误码与 requestId 形状未验证，命中即 OTHER。',
        needed: '真实诊断观测后按实际观测补充，不得凭猜测扩充。'
      },
      {
        id: 'production-same-batch-chain-not-proven',
        severity: 'MEDIUM',
        detail: '真实凭据获取与三条 CLI 关联已通过，但 SDK 未取得可用数据库结果，' +
          '完整生产同批链仍不能判通过；proven 恒 false。',
        needed: '数据库读取可用后再评估。'
      }
    ],
    limitations: [
      '全部为合成传输与合成凭据；未执行真实云请求。',
      '异常名称分类只是观察到的 name，不能断定异常实际来源；任何对象都可自报 name。',
      '独立子进程的异常不会以活对象跨 IPC 传给父进程；VM 夹具才涉及跨 realm 对象，两者不混同。',
      'Node 运行时拦截不是操作系统防火墙。',
      '不改变集合是否存在、权限状态或初始化需求 —— 这些仍未结论化。'
    ],
    sha256: Object.fromEntries(files.map(f => [f,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJECT_ROOT, f))).digest('hex')]))
  }, null, 2));
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(() => {
  process.stderr.write('R12_REPRO_FAILED_NO_RAW_ERROR\n');
  process.exitCode = 1;
});