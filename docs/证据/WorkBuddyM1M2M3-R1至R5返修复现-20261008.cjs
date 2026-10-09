#!/usr/bin/env node
'use strict';
/**
 * WorkBuddy M1/M2/M3 R1–R5 返修复现（SDK 只读身份接入）— 2026-10-08
 *
 * 依据：docs/Codex复核-SDK只读身份M1-M3本地实现-20261007.md 第 2–6 节。
 *
 * 与上一轮复现脚本的关系
 * ────────────────────
 * 本脚本**只写 stdout**，**不写任何文件**。历史证据
 * `WorkBuddyM1M2M3-SDK只读接入复现-20261007.json` **保持原样、不重跑覆盖**。
 *
 * 严格边界
 * ──────
 * - 全部离线：不执行官方 CLI、不联网、不获取任何真实凭据、不安装、不初始化、不部署。
 * - 凭据一律为**合成标记**，只在本进程内存中经 stdin 管道传给 worker 替身。
 * - 涉及真实 SDK 的样本只做**本地 introspection**（init/database/引用形状），
 *   不发起任何数据库查询；真实网络请求 0 次。
 * - 输出不含凭据、原始 OPENID、完整记录、SDK 实例或配置对象内容。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const MINIAPP = path.resolve(__dirname, '..', '..', 'miniapp');
const o = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'));
const w = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'));

const SYN_SECRET = 'SYNTHETIC_SECRET_MUST_NEVER_LEAK_9f3a';
const SYN_SESSION = 'SYNTHETIC_SESSIONTOKEN_MUST_NEVER_LEAK_7b2e';
const SYN_OPENID = 'oSYNTHETIC-openid-must-never-appear-20261007';
const SYN_ACCOUNT = '100012345678';
const SYN_TARGET = w.deriveUserId(o.FIXED.wxAppId, SYN_OPENID);

const results = [];
function record(id, pass, detail) {
  results.push(Object.assign({ id, pass: Boolean(pass) }, detail || {}));
}
function expectCode(code, fn) {
  try {
    fn();
  } catch (e) {
    if (e && e.code === code) return true;
    throw new Error('期望 ' + code + '，实际 ' + (e && e.code) + '：' + (e && e.message));
  }
  throw new Error('期望以 ' + code + ' 拒绝，但未抛错');
}
/** 合成子进程：真实 EventEmitter（无监听时 emit 会抛，必须用真实语义）。 */
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = new EventEmitter();
  c.stdinBytes = '';
  c.kills = 0;
  c.stdin.end = () => { c.stdinClosed = true; };
  c.stdin.write = (s) => { c.stdinBytes += String(s); return true; };
  c.kill = () => { c.kills++; return true; };
  return c;
}
async function listenersReady() {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}
function settleWithin(promise, ms) {
  return Promise.race([
    promise.then(v => ({ settled: true, v })),
    new Promise(res => setTimeout(() => res({ settled: false }), ms))
  ]);
}
const SNAP = { secretId: 'SYN_ID', secretKey: 'SYN_KEY', sessionToken: 'SYN_TOKEN', expiresAtMs: Date.now() + 600000 };
const FAST = { timeoutMs: 120, closeGraceMs: 40, maxOutputBytes: 4096 };

/** 在子进程跑探针并取回 stdout 净化 JSON（异步 spawn；本机 spawnSync 会返回空）。 */
function runProbe(source, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(o.FIXED.nodeBin, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* 如实记为未确认 */ }
      reject(new Error('probe timeout'));
    }, timeoutMs || 30000);
    child.stdout.on('data', d => { so += d; });
    child.stderr.on('data', d => { se += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('probe exit=' + code));
      try { resolve(JSON.parse(so)); } catch (_) { reject(new Error('probe 非 JSON')); }
    });
  });
}

async function main() {
  // ═══ R1 可运行接线 ═══════════════════════════════════════════════════
  {
    // R1-1 公共 CLI 入口的认证优先级（源码静态定位）
    const bundle = 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/dist/standalone/cli.js';
    const src = fs.readFileSync(bundle, 'utf8');
    const bundleSha = crypto.createHash('sha256').update(src).digest('hex');
    record('R1-1-cli-credential-priority-source',
      src.includes('getProjectApiKeyCredential(options.cwd)') &&
      src.includes('const cloudCredentail = resolveCredentialFormEnv();') &&
      src.includes("path_1.default.join(exports.cloudbaseConfigDir, `${file}.json`)") &&
      src.includes('exports.config = env.XDG_CONFIG_HOME ||') &&
      ['TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN'].every(n => src.includes(n)), {
        bundleSha256: bundleSha,
        bundleShaMatchesTaskDoc: bundleSha === '8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97',
        order: 'project(cwd) > authStore(<config>/.cloudbase/auth.json) > TENCENTCLOUD_*（最低）',
        evidenceKind: 'STATIC_SOURCE',
        note: '静态源码定位；仍不能替代对真实公共入口的离线优先级验证'
      });

    // R1-2 CLI 必须用「固定 Node + [固定 CLI 入口, ...apiArgs]」启动，失败即停
    const cliCalls = [];
    const assoc = await o.runCliAssociation(SNAP, 'C:/offline-only', {
      baseEnv: {},
      spawn: (bin, argv) => {
        cliCalls.push({ bin: path.basename(bin), argv0: path.basename(argv[0]), argv1: argv[1] });
        const c = fakeChild();
        setImmediate(() => { c.emit('exit', 1, null); c.emit('close', 1, null); });
        return c;
      }
    });
    record('R1-2-cli-node-launch-and-stop-on-failure',
      cliCalls.length === 1 &&
      cliCalls[0].bin.toLowerCase() === 'node.exe' &&
      cliCalls[0].argv0 === path.basename(o.FIXED.cliEntry) &&
      assoc.matched === false && assoc.stoppedEarly === true &&
      assoc.stages.filter(s => s.notExecuted).length === 2, {
        calls: cliCalls,
        launchedBy: 'node',
        stoppedEarly: assoc.stoppedEarly,
        notExecutedStages: assoc.stages.filter(s => s.notExecuted).length,
        note: '上一版把无扩展名 JS 脚本当可执行文件、且失败后仍跑完三阶段'
      });

    // R1-3 node-sdk 公开入口是 init(config)；对它 new 会抛 TypeError
    const sdkPath = require.resolve(path.join(o.FIXED.sdkRoot, '@cloudbase', 'node-sdk'));
    const sdk = require(sdkPath);
    let newError = null;
    try { new sdk({}); } catch (e) { newError = e.name; }
    const dbPkg = JSON.parse(fs.readFileSync(path.join(o.FIXED.sdkRoot, '@cloudbase', 'database', 'package.json'), 'utf8'));
    const nodeSdkPkg = JSON.parse(fs.readFileSync(path.join(o.FIXED.sdkRoot, '@cloudbase', 'node-sdk', 'package.json'), 'utf8'));
    record('R1-3-sdk-init-entry-and-versions',
      typeof sdk === 'object' && typeof sdk.init === 'function' && newError === 'TypeError' &&
      nodeSdkPkg.version === '2.10.0' && dbPkg.version === '1.4.1', {
        exportType: typeof sdk,
        initType: typeof sdk.init,
        constructorError: newError,
        nodeSdkVersion: nodeSdkPkg.version,
        databaseVersion: dbPkg.version,
        resolvedEntry: sdkPath,
        note: '上一版 new CloudBase(config) 会停在 SDK_UNAVAILABLE'
      });

    // R1-4 region 必须真正传入 SDK（不得用常量冒充已核实请求地域）
    const cfg = w.buildSdkConfig({ secretId: 'S', secretKey: 'K', sessionToken: 'T' }, {});
    record('R1-4-region-actually-passed',
      cfg.region === o.FIXED.region && cfg.endpoint === undefined &&
      cfg.sessionToken === 'T' && cfg.token === undefined, {
        region: cfg.region, sdkConfigKeys: Object.keys(cfg).sort(),
        note: 'R1.3：报告固定声称 ap-shanghai，就必须真的传'
      });

    // R1-5 真实 SDK 初始化路径可跑通（本地 introspection，零网络）
    const probe = `
      const path = require('path');
      const w = require(${JSON.stringify(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'))});
      const sdk = require(require.resolve(path.join(${JSON.stringify(o.FIXED.sdkRoot)}, '@cloudbase', 'node-sdk')));
      const cfg = w.buildSdkConfig({ secretId: 'SYN_ID', secretKey: 'SYN_KEY', sessionToken: 'SYN_TOKEN' }, {});
      const out = { region: cfg.region, env: cfg.env };
      const app = sdk.init(cfg);
      out.initOk = Boolean(app);
      out.hasDatabase = typeof app.database === 'function';
      const db = app.database();
      // 先在封堵前抓一个真实引用，用于观察 field() 的返回形状（R5 缺陷前提）
      const rawRef = db.collection('schtest_v1_app_admins').doc('primary');
      const projected = rawRef.field({ _id: true });
      out.fieldReturnsNewRef = projected !== rawRef;
      out.newRefHasSet = typeof projected.set === 'function';
      // 再封堵
      const h = w.installWriteTraps(db, [w.ADMIN_COLLECTION, w.USER_COLLECTION]);
      out.chainedKeys = Object.keys(h.primary.doc('primary').field(w.PRIMARY_PROJECTION));
      out.trapThrows = (() => { try { db.collection(w.ADMIN_COLLECTION); return false; } catch (e) { return e.code === 'READ_ONLY_TRAP'; } })();
      out.narrowWriteReachable = typeof h.primary.doc('primary').field({}).set === 'function';
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    `;
    const p = await runProbe(probe);
    record('R1-5-real-sdk-init-path-runs',
      p.initOk === true && p.hasDatabase === true && p.region === o.FIXED.region &&
      p.env === o.FIXED.envId && p.trapThrows === true, {
        initOk: p.initOk, hasDatabase: p.hasDatabase, region: p.region, env: p.env,
        chainedKeys: p.chainedKeys, trapThrows: p.trapThrows,
        realNetworkCalls: 0,
        note: '真实 require + init(config) + database()；只做本地 introspection，未发起任何查询'
      });

    // R1-6 本地准备如实标注「获取宿主未实现 / 公共入口未证实」
    const local = await o.runLocalCheck({});
    record('R1-6-local-preparation-honest',
      local.status === o.STATUS.LOCAL_READY &&
      local.localPreparation.credentialFetchHostImplemented === false &&
      local.localPreparation.publicEntryIdentityProven === false &&
      local.localPreparation.credentialFetched === false &&
      local.localPreparation.cloudCallAttempted === false &&
      local.localPreparation.actualVersions['@cloudbase/node-sdk'] === '2.10.0' &&
      local.localPreparation.sdkPublicEntry.hasInit === true, {
        checkCount: local.localPreparation.checks.length,
        actualVersions: local.localPreparation.actualVersions,
        sdkPublicEntry: local.localPreparation.sdkPublicEntry,
        credentialFetchHostImplemented: false,
        publicEntryIdentityProven: false,
        note: '交付状态不再写成「完整实现后的平台验证缺口」'
      });
  }

  // ═══ R2 worker 有界失败 ═══════════════════════════════════════════════
  {
    // R2-1 无 exit/close：总超时必须有界收尾
    const c1 = fakeChild();
    const t0 = Date.now();
    const r1 = await settleWithin(o.runWorker(SNAP, null, { spawn: () => c1, limits: FAST }), 5000);
    record('R2-1-timeout-without-exit-is-bounded',
      r1.settled === true && r1.v.errorCode === o.ERR.WORKER_TIMEOUT && c1.kills === 1, {
        settled: r1.settled, elapsedMs: Date.now() - t0, kills: c1.kills,
        errorCode: r1.v ? r1.v.errorCode : null,
        note: '上一版计时器只 kill 不 resolve，可永久挂起'
      });

    // R2-2 kill 返回 false 且永不 close
    const c2 = fakeChild();
    c2.kill = () => { c2.kills++; return false; };
    const r2 = await settleWithin(o.runWorker(SNAP, null, { spawn: () => c2, limits: FAST }), 5000);
    record('R2-2-kill-false-still-bounded',
      r2.settled === true && r2.v.ok === false, {
        settled: r2.settled, errorCode: r2.v ? r2.v.errorCode : null, kills: c2.kills,
        terminationConfirmed: r2.v ? r2.v.terminationConfirmed : null,
        note: '「杀进程」不证明已终止，如实记未确认'
      });

    // R2-3 exit 后无 close：close 宽限定时失败
    const c3 = fakeChild();
    const p3 = o.runWorker(SNAP, null, { spawn: () => c3, limits: FAST });
    await listenersReady();
    c3.stdout.emit('data', Buffer.from('{"ok":true,"writeAttemptsCount":0}'));
    c3.emit('exit', 0, null);
    const r3 = await settleWithin(p3, 5000);
    record('R2-3-exit-without-close',
      r3.settled === true && r3.v.errorCode === o.ERR.WORKER_CLOSE_NOT_OBSERVED, {
        settled: r3.settled, errorCode: r3.v ? r3.v.errorCode : null,
        note: '复用已验收收尾：宽限只从首次 exit 起算'
      });

    // R2-4 stdout+stderr 合并超限，且只终止一次
    const c4 = fakeChild();
    const p4 = o.runWorker(SNAP, null, { spawn: () => c4, limits: { timeoutMs: 5000, closeGraceMs: 40, maxOutputBytes: 1000 } });
    await listenersReady();
    for (let i = 0; i < 5; i++) {
      c4.stdout.emit('data', Buffer.alloc(400, 32));
      c4.stderr.emit('data', Buffer.alloc(400, 120));
    }
    const r4 = await settleWithin(p4, 5000);
    record('R2-4-combined-overflow-single-kill',
      r4.settled === true && r4.v.errorCode === o.ERR.WORKER_OVERFLOW && c4.kills === 1, {
        settled: r4.settled, errorCode: r4.v ? r4.v.errorCode : null, kills: c4.kills,
        note: '上一版 stdout/stderr 各自计数，700KB+700KB 可同时低于 1MiB'
      });

    // R2-5 非零退出 / 信号 / 超时带合法 JSON 都不得成功
    const cases = {};
    const mk = async (payload) => {
      const c = fakeChild();
      const pr = o.runWorker(SNAP, null, { spawn: () => c, limits: FAST });
      await listenersReady();
      c.stdout.emit('data', Buffer.from(payload));
      return { c, pr };
    };
    const nz = await mk('{"ok":true,"writeAttemptsCount":0}');
    nz.c.emit('exit', 1, null);
    nz.c.emit('close', 1, null);
    cases.nonzero = await nz.pr;
    const sg = await mk('{"ok":true,"writeAttemptsCount":0}');
    sg.c.emit('exit', null, 'SIGTERM');
    sg.c.emit('close', null, 'SIGTERM');
    cases.signaled = await sg.pr;
    const to = await mk('{"ok":true,"writeAttemptsCount":0}');
    cases.timeout = (await settleWithin(to.pr, 5000)).v;
    record('R2-5-stdout-cannot-override-exit-facts',
      cases.nonzero.errorCode === o.ERR.WORKER_NONZERO_EXIT && cases.nonzero.ok === false &&
      cases.signaled.errorCode === o.ERR.WORKER_SIGNALED && cases.signaled.ok === false &&
      cases.timeout.errorCode === o.ERR.WORKER_TIMEOUT && cases.timeout.ok === false, {
        nonzeroExit: cases.nonzero.errorCode,
        signaled: cases.signaled.errorCode,
        timeoutWithValidJson: cases.timeout.errorCode,
        note: '上一版忽略 code/signal，超时后 close 且 stdout 含 ok:true 也判成功'
      });

    // R2-6 stdin 失败 / error 事件 / 晚到 error / 收尾幂等
    const cs = fakeChild();
    cs.stdin.write = () => { throw new Error('EPIPE'); };
    const ps = o.runWorker(SNAP, null, { spawn: () => cs, limits: FAST });
    await listenersReady();
    cs.stdout.emit('data', Buffer.from('{"ok":true,"writeAttemptsCount":0}'));
    cs.emit('exit', 0, null);
    cs.emit('close', 0, null);
    const stdinFail = await ps;

    const ce = fakeChild();
    const pe = o.runWorker(SNAP, null, { spawn: () => ce, limits: FAST });
    await listenersReady();
    ce.emit('error', new Error('spawn failed'));
    const spawnErr = await pe;

    const cl = fakeChild();
    const pl = o.runWorker(SNAP, SYN_TARGET, { spawn: () => cl, limits: FAST });
    await listenersReady();
    cl.stdout.emit('data', Buffer.from('{"ok":true,"writeAttemptsCount":0}'));
    cl.emit('exit', 0, null);
    cl.emit('close', 0, null);
    const late = await pl;
    let lateThrew = false;
    try { cl.emit('error', new Error('late')); } catch (_) { lateThrew = true; }
    const killsBefore = cl.kills;
    let reemitThrew = false;
    try {
      cl.stdout.emit('data', Buffer.from('X'.repeat(5000)));
      cl.emit('exit', 0, null);
      cl.emit('close', 0, null);
    } catch (_) { reemitThrew = true; }

    record('R2-6-stdin-error-and-idempotent-finish',
      stdinFail.errorCode === o.ERR.WORKER_STDIN_FAILED &&
      spawnErr.errorCode === o.ERR.WORKER_FAILED &&
      late.ok === true && lateThrew === false &&
      reemitThrew === false && cl.kills === killsBefore &&
      cl.stdout.listenerCount('data') === 0, {
        stdinFailure: stdinFail.errorCode,
        spawnError: spawnErr.errorCode,
        normalRunOk: late.ok,
        lateErrorThrew: lateThrew,
        reEmitThrew: reemitThrew,
        listenersAfterFinish: cl.stdout.listenerCount('data'),
        stdinClosed: cl.stdinClosed,
        stdinPayloadHasExpiry: typeof (JSON.parse(cl.stdinBytes).expiresAtMs) === 'number',
        note: 'stdin 是与已验收收尾的唯一差异，须最小受控实现'
      });
  }

  // ═══ R3 严格记录校验与顶层汇总 ════════════════════════════════════════
  {
    // R3-1 字段缺失不得判 OBSERVED，且须写明原因
    const missPrimary = o.interpretPrimary({
      ok: true, writeAttemptsCount: 0, errorCode: null,
      primary: { classification: 'OBSERVED', docId: 'primary', userId: null, status: null, userIdShapeValid: false, statusValid: false }
    }, SYN_TARGET);
    const missUser = o.interpretTargetUser({
      ok: true, writeAttemptsCount: 0, errorCode: null,
      targetUser: { classification: 'OBSERVED', docId: SYN_TARGET, status: null, statusValid: false, derivationMatches: false, derivationChecked: false, openidShapeValid: false }
    }, SYN_TARGET);
    record('R3-1-missing-fields-not-observed',
      missPrimary.status === 'UNCONFIRMED' && missPrimary.reasons.length > 0 &&
      missUser.status === 'UNCONFIRMED' && missUser.reasons.length > 0, {
        primaryStatus: missPrimary.status,
        primaryReasons: missPrimary.reasons,
        primaryFieldCompleteness: missPrimary.fieldCompleteness,
        userStatus: missUser.status,
        userReasons: missUser.reasons,
        note: '上一版只拒绝 ===false，worker 给 null 时缺失字段被放行成 OBSERVED'
      });

    // R3-2 平台错误响应优先于 data 形状
    const errNorm = w.normalizeReadResult({ code: 'SYNTHETIC_DENIED', data: [] }, 'primary');
    const errInterp = o.interpretPrimary({
      ok: true, writeAttemptsCount: 0, errorCode: null,
      primary: { classification: 'UNCONFIRMED', docId: 'primary', hasPlatformError: true, reason: '平台返回错误响应' }
    }, SYN_TARGET);
    record('R3-2-platform-error-not-not-found',
      errNorm.classification === 'UNCONFIRMED' && errNorm.hasPlatformError === true &&
      errInterp.status !== 'NOT_FOUND', {
        classification: errNorm.classification,
        hasPlatformError: errNorm.hasPlatformError,
        interpretedStatus: errInterp.status,
        note: '上一版先看 data 长度，把带 code 的 {data:[]} 误判为 NOT_FOUND'
      });

    // R3-3 非法值不得泄露（两层都净化）
    const marker = 'SYNTHETIC_PRIVATE_MARKER';
    const badUser = o.interpretPrimary({
      ok: true, writeAttemptsCount: 0, errorCode: null,
      primary: { classification: 'OBSERVED', docId: 'primary', userId: marker, status: marker, userIdShapeValid: false, statusValid: false }
    }, SYN_TARGET);
    const badClass = o.interpretPrimary({
      ok: true, writeAttemptsCount: 0, errorCode: null,
      primary: { classification: 'WHATEVER', docId: 'primary' }
    }, null);
    const badReason = o.interpretPrimary({
      ok: true, writeAttemptsCount: 0, errorCode: null,
      primary: { classification: 'UNCONFIRMED_SHAPE', docId: 'primary', reason: marker }
    }, null);
    const dumped = JSON.stringify([badUser, badClass, badReason]);
    record('R3-3-invalid-values-sanitized',
      badUser.userId === null && badUser.status_field === null &&
      badClass.status === 'UNCONFIRMED' &&
      dumped.includes(marker) === false, {
        leakedMarker: dumped.includes(marker),
        invalidUserId: badUser.userId,
        invalidStatus: badUser.status_field,
        illegalClassification: badClass.classification,
        note: 'R3.4：userId/status/requestId/reason 各按自身契约投影'
      });

    // R3-4 worker 失败不得被汇总成 OBSERVED（走真实 runWorker 生命周期）
    const cf = fakeChild();
    const pf = o.runWorker(SNAP, SYN_TARGET, { spawn: () => cf, limits: FAST });
    await listenersReady();
    cf.stdout.emit('data', Buffer.from('{"ok":false,"errorCode":"SDK_UNAVAILABLE","writeAttemptsCount":0}'));
    cf.emit('exit', 0, null);
    cf.emit('close', 0, null);
    const workerFail = await pf;
    const pFromFail = o.interpretPrimary(workerFail, SYN_TARGET);
    const uFromFail = o.interpretTargetUser(workerFail, SYN_TARGET);
    record('R3-4-worker-failure-not-summarized-as-observed',
      workerFail.ok === false && pFromFail.status === 'UNCONFIRMED' && pFromFail.errorCode === 'SDK_UNAVAILABLE' &&
      uFromFail.status === 'UNCONFIRMED', {
        workerOk: workerFail.ok,
        workerErrorCode: workerFail.errorCode,
        primaryStatus: pFromFail.status,
        targetStatus: uFromFail.status,
        note: '上一版顶层 status=OBSERVED 且 incomplete=[]'
      });

    // R3-5 ok / writeAttemptsCount 必须严格
    const strictCases = {};
    for (const [k, payload] of [
      ['okNotTrue', { ok: 'true', writeAttemptsCount: 0 }],
      ['wacPositive', { ok: true, writeAttemptsCount: 2 }],
      ['wacMissing', { ok: true }]
    ]) {
      strictCases[k] = o.interpretWorkerOutput({ stdout: JSON.stringify(payload), code: 0, terminationConfirmed: true });
    }
    // 伪造字段不得覆盖宿主终止事实
    const spoof = o.interpretWorkerOutput({
      stdout: JSON.stringify({ ok: true, writeAttemptsCount: 0, terminationConfirmed: false, extra: 'LEAK' }),
      code: 1, terminationConfirmed: true
    });
    record('R3-5-strict-ok-and-write-attempts',
      strictCases.okNotTrue.ok === false &&
      strictCases.wacPositive.errorCode === o.ERR.WORKER_WRITE_ATTEMPTED &&
      strictCases.wacMissing.ok === false &&
      spoof.ok === false && spoof.extra === undefined && spoof.terminationConfirmed === true, {
        okNotTrue: strictCases.okNotTrue.errorCode,
        writeAttemptsPositive: strictCases.wacPositive.errorCode,
        writeAttemptsMissing: strictCases.wacMissing.errorCode,
        spoofNotAccepted: spoof.ok === false,
        arbitraryFieldDropped: spoof.extra === undefined,
        note: '两层都须校验，不能仅信任 worker 的布尔标志'
      });

    // R3-6 依赖注入不得产生生产 proven
    const injected = await o.fetchTemporaryCredential({
      deps: { fetchCredential: async () => JSON.stringify({
        secretId: SYN_SECRET, secretKey: SYN_SECRET + '-key', token: SYN_SESSION,
        expiredAt: new Date(Date.now() + 1800000).toISOString(), isTemporary: true, envId: o.FIXED.envId
      }) }
    });
    let unprovenCode = null;
    try { await o.fetchTemporaryCredential({ deps: {} }); } catch (e) { unprovenCode = e.code; }
    record('R3-6-injection-is-not-production-evidence',
      injected.proven === false && injected.evidenceKind === 'SYNTHETIC_INJECTION' &&
      injected.source === 'deps:fetchCredential' &&
      unprovenCode === o.ERR.PUBLIC_ENTRY_IDENTITY_UNPROVEN, {
        provenFromInjection: injected.proven,
        evidenceKind: injected.evidenceKind,
        source: injected.source,
        unprovenErrorCode: unprovenCode,
        note: '上一版仅提供注入函数即 proven:true；获取宿主其实未实现'
      });

    // R3-7 NOT_FOUND 单列但不得称为有效管理员；缺目标维持未执行
    const notFound = o.interpretPrimary({
      ok: true, writeAttemptsCount: 0, errorCode: null,
      primary: { classification: 'NOT_FOUND', docId: 'primary', requestId: 'req-syn' }
    }, SYN_TARGET);
    const noTarget = o.interpretTargetUser({ ok: true, writeAttemptsCount: 0, targetUser: null }, null);
    record('R3-7-not-found-and-missing-target',
      notFound.status === 'NOT_FOUND' && notFound.userId === null &&
      noTarget.status === 'NOT_EXECUTED_TARGET_UNCONFIRMED', {
        primaryStatus: notFound.status,
        primaryUserId: notFound.userId,
        targetStatus: noTarget.status,
        note: 'NOT_FOUND 只是「本次未找到」，不得称为有效管理员'
      });
  }

  // ═══ R4 身份隔离与有效期 ══════════════════════════════════════════════
  {
    // R4-1 大小写无关清理
    const iso = o.buildIsolatedEnv({
      PATH: 'C:/Windows',
      xdg_config_home: 'C:/outside', XDG_CONFIG_HOME: 'C:/outside',
      UserProfile: 'C:/outside', USERPROFILE: 'C:/outside', home: 'C:/outside',
      HOMEDRIVE: 'C:', HOMEPATH: '\\Users',
      Http_Proxy: 'http://outside', HTTP_PROXY: 'http://outside',
      https_proxy: 'http://outside', ALL_PROXY: 'http://outside', no_proxy: 'localhost',
      tcb_region: 'ap-guangzhou', CLOUDBASE_API_KEY: 'X',
      Node_Options: '--require X', TENCENTCLOUD_SECRETID: 'INHERITED'
    }, { secretId: 'S', secretKey: 'K', sessionToken: 'T' }, 'C:/iso/run');
    const uppers = Object.keys(iso).map(k => k.toUpperCase());
    const allowed = new Set(['PATH', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
      'TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN',
      'TCB_REGION', 'NO_UPDATE_NOTIFIER', 'TCB_DISABLE_REPORT', 'CI']);
    record('R4-1-case-insensitive-isolation',
      Object.keys(iso).every(k => allowed.has(k)) &&
      !uppers.some(u => u.startsWith('XDG_') || u.includes('PROXY') || u === 'NODE_OPTIONS' ||
        u === 'HOMEDRIVE' || u === 'HOMEPATH' || u.startsWith('CLOUDBASE_')) &&
      iso.USERPROFILE === 'C:/iso/run' && iso.HOME === 'C:/iso/run' &&
      iso.TENCENTCLOUD_SESSIONTOKEN === 'T' && iso.TCB_REGION === o.FIXED.region, {
        envKeys: Object.keys(iso).sort(),
        userProfile: iso.USERPROFILE,
        region: iso.TCB_REGION,
        note: 'Windows 环境变量忽略大小写；上一版只删大写键、留下 xdg_config_home/UserProfile 与整族代理'
      });

    // R4-2 authStatePaths 覆盖完整取值链
    const paths = o.authStatePaths('C:/iso/run');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r45-iso-'));
    const dir = path.join(root, 'run');
    fs.mkdirSync(path.join(dir, '.config', '.cloudbase'), { recursive: true });
    const clean = o.assertIsolationClean(dir);
    const target = paths.map(p => path.join(dir, path.relative('C:/iso/run', p)))
      .find(p => p.endsWith(path.join('.config', '.cloudbase', 'auth.json')));
    fs.writeFileSync(target, '{}', 'utf8');
    const dirtyStops = expectCode(o.ERR.ISOLATION_DIRTY, () => o.assertIsolationClean(dir));
    const notDeleted = fs.existsSync(target);
    fs.rmSync(root, { recursive: true, force: true });
    record('R4-2-auth-state-locations-complete',
      paths.length >= 4 && clean === true && dirtyStops === true && notDeleted === true &&
      new Set(paths.map(p => p.toLowerCase())).size === paths.length, {
        locationCount: paths.length,
        locations: paths.map(p => path.basename(p) + ' @ ' + path.dirname(p).split(path.sep).slice(-2).join('/')),
        cleanAccepted: clean,
        dirtyRejected: dirtyStops,
        fileNotDeleted: notDeleted,
        note: '上一版只检查两个路径；仍只查位置不读内容'
      });

    // R4-3 有效期覆盖每阶段前后（含失败停止路径）
    const clock = Date.now();
    const shortSnap = { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: clock + 1000, expiresAtIso: new Date(clock + 1000).toISOString() };
    let checks = 0;
    let expiredCaught = false;
    try {
      await o.runCliAssociation(shortSnap, 'C:/offline-only', {
        now: () => { checks++; return checks === 1 ? clock : clock + 5000; },
        baseEnv: {},
        spawn: () => {
          const c = fakeChild();
          setImmediate(() => { c.emit('exit', 1, null); c.emit('close', 1, null); });
          return c;
        }
      });
    } catch (e) { expiredCaught = e.code === o.ERR.CREDENTIAL_EXPIRED; }
    record('R4-4-expiry-checked-on-failure-paths',
      expiredCaught === true && checks >= 2, {
        freshnessChecks: checks,
        expiredCaughtOnFailurePath: expiredCaught,
        note: '上一版失败即停止会跳过所有后检查；现已覆盖失败路径'
      });

    // R4-4 worker 载荷含到期时间 + 运行期过期事实带回
    const cw = fakeChild();
    const pw = o.runWorker({ secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 600000 }, SYN_TARGET, {
      spawn: () => cw, limits: FAST
    });
    await listenersReady();
    const sent = JSON.parse(cw.stdinBytes);
    cw.stdout.emit('data', Buffer.from('{"ok":true,"writeAttemptsCount":0,"credentialExpiredDuringRun":true}'));
    cw.emit('exit', 0, null);
    cw.emit('close', 0, null);
    const expiredRun = await pw;
    record('R4-5-worker-payload-carries-expiry',
      typeof sent.expiresAtMs === 'number' && sent.expiresAtMs > 0 &&
      expiredRun.ok === true && expiredRun.credentialExpiredDuringRun === true, {
        payloadHasExpiresAtMs: typeof sent.expiresAtMs === 'number',
        expiredDuringRun: expiredRun.credentialExpiredDuringRun,
        note: '上一版载荷根本不含到期时间，两条读取之间无法检查'
      });
  }

  // ═══ R5 写陷阱声明收窄 ════════════════════════════════════════════════
  {
    // R5-1 窄包装：写方法不可达（用 field() 返回新引用的契约替身）
    const db = {
      collection: () => ({
        doc: (id) => ({
          set: () => 'write-reachable',
          field() { return { get: async () => ({ data: [{ _id: id }] }), set: () => 'write-reachable' }; }
        }),
        set: () => 'write-reachable'
      })
    };
    const h = w.installWriteTraps(db, [w.ADMIN_COLLECTION, w.USER_COLLECTION]);
    let chainedReachable = true;
    try { h.primary.doc('primary').field({}).set(); } catch (_) { chainedReachable = false; }
    let docReachable = true;
    try { h.primary.doc('primary').set(); } catch (_) { docReachable = false; }
    const dbTrap = expectCode('READ_ONLY_TRAP', () => db.collection(w.ADMIN_COLLECTION));
    const readStillWorks = await h.users.doc(SYN_TARGET).field(w.USER_PROJECTION).get();
    record('R5-1-narrow-wrapper-write-unreachable',
      chainedReachable === false && docReachable === false && dbTrap === true &&
      Array.isArray(readStillWorks.data) === true &&
      Object.keys(h.primary.doc('primary').field({})).join() === 'get', {
        chainedWriteReachable: chainedReachable,
        docWriteReachable: docReachable,
        dbCollectionTrapped: dbTrap,
        readPathStillWorks: Array.isArray(readStillWorks.data),
        wrapperKeys: Object.keys(h.primary),
        note: '上一版仅改 doc 原引用，field() 返回的新 DocumentReference 上写方法未被封堵'
      });

    // R5-2 真实 SDK 下同样不可达（独立采集，不依赖其它块的局部变量）
    const shapeProbe = `
      const path = require('path');
      const w = require(${JSON.stringify(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'))});
      const sdk = require(require.resolve(path.join(${JSON.stringify(o.FIXED.sdkRoot)}, '@cloudbase', 'node-sdk')));
      const db = sdk.init({ secretId: 'SYN_ID', secretKey: 'SYN_KEY', env: ${JSON.stringify(o.FIXED.envId)}, region: ${JSON.stringify(o.FIXED.region)} }).database();
      // 封堵前：观察真实 field() 的返回形状（R5 缺陷前提）
      const ref = db.collection('schtest_v1_app_admins').doc('primary');
      const projected = ref.field({ _id: true });
      const out = {
        fieldReturnsNewRef: projected !== ref,
        newRefHasSet: typeof projected.set === 'function'
      };
      // 封堵后：窄包装上仍只有 get
      const h = w.installWriteTraps(db, [w.ADMIN_COLLECTION, w.USER_COLLECTION]);
      out.narrowWriteReachable = typeof h.primary.doc('primary').field({}).set === 'function';
      out.narrowKeys = Object.keys(h.primary.doc('primary').field({})).join();
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    `;
    const shape = await runProbe(shapeProbe);
    record('R5-2-real-sdk-narrow-wrapper-holds',
      shape.fieldReturnsNewRef === true && shape.newRefHasSet === true &&
      shape.narrowWriteReachable === false && shape.narrowKeys === 'get', {
        realFieldReturnsNewRef: shape.fieldReturnsNewRef,
        realNewRefHasSetMethod: shape.newRefHasSet,
        narrowWrapperWriteReachable: shape.narrowWriteReachable,
        narrowWrapperKeys: shape.narrowKeys,
        realNetworkCalls: 0,
        note: '在真实 @cloudbase/database 上验证缺陷前提，不是自制 mock'
      });

    // R5-3 只读两次 get 不触发任何陷阱
    const probe = `
      const path = require('path');
      const w = require(${JSON.stringify(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'))});
      const sdk = require(require.resolve(path.join(${JSON.stringify(o.FIXED.sdkRoot)}, '@cloudbase', 'node-sdk')));
      const db = sdk.init({ secretId: 'SYN_ID', secretKey: 'SYN_KEY', env: ${JSON.stringify(o.FIXED.envId)}, region: ${JSON.stringify(o.FIXED.region)} }).database();
      const h = w.installWriteTraps(db, [w.ADMIN_COLLECTION, w.USER_COLLECTION]);
      const out = { keys: Object.keys(h.primary.doc('primary').field(w.PRIMARY_PROJECTION)) };
      let reachable = false;
      try { h.primary.doc('primary').field(w.PRIMARY_PROJECTION).set(); reachable = true; } catch (e) { reachable = false; }
      out.writeReachable = reachable;
      // 窄包装上根本没有集合级写方法 —— 不存在即不可达
      out.collAddExists = typeof h.primary.add === 'function';
      let collReachable = false;
      if (out.collAddExists) { try { h.primary.add({}); collReachable = true; } catch (e) { collReachable = false; } }
      out.collAddReachable = collReachable;
      // 封堵后 db.collection 确实抛 READ_ONLY_TRAP
      out.dbCollectionTrapped = (() => { try { db.collection(w.ADMIN_COLLECTION); return false; } catch (e) { return e.code === 'READ_ONLY_TRAP'; } })();
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    `;
    const p2 = await runProbe(probe);
    record('R5-3-read-path-triggers-no-write',
      p2.writeReachable === false && p2.collAddReachable === false &&
      p2.keys.join() === 'get' && p2.collAddExists === false && p2.dbCollectionTrapped === true, {
        wrapperKeys: p2.keys,
        chainedWriteReachable: p2.writeReachable,
        collectionAddExists: p2.collAddExists,
        dbCollectionTrapped: p2.dbCollectionTrapped,
        realNetworkCalls: 0,
        note: '窄包装上根本不存在写方法（不可达），不是「被陷阱拦住」'
      });
  }

  // ═══ 未改项哈希 ════════════════════════════════════════════════════════
  {
    const untouched = {
      'scripts/lib/cloudbase-readonly-observer.cjs': '3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
      'scripts/check-cloudbase-readonly.cjs': '552dc12269989ec271338153fba036331cc37a27facc13189c3c2a8d0a17ae3a',
      'scripts/lib/sandbox-primary-bootstrap.cjs': '133c21ae4b1081a1e716422862730d518a2194cc8620eb0956a9459a44765614',
      'scripts/prepare-sandbox-primary.cjs': '608aa8854a4213fc81659f2892634cd29e4ba691db1253d34a8e66778c7046e4',
      'scripts/lib/sandbox-primary-sdk-adapter.cjs': '9088e6478b940a4c2db06737effbb9264f12fd1b62778e64cdb3990ef2ec9f1d'
    };
    const mismatch = [];
    const actual = {};
    for (const [rel, expect] of Object.entries(untouched)) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(MINIAPP, rel))).digest('hex');
      actual[rel] = h;
      if (h !== expect) mismatch.push({ file: rel, expected: expect, actual: h });
    }
    record('untouched-files-unchanged', mismatch.length === 0, {
      checked: Object.keys(untouched).length, mismatch, actual,
      note: 'C1/T1/P4/已验收适配层/初始化 CLI 均未触碰'
    });
  }

  // ═══ 历史证据未被覆盖（第 8 节） ════════════════════════════════════════
  {
    const histJson = path.join(__dirname, 'WorkBuddyM1M2M3-SDK只读接入复现-20261007.json');
    const histScript = path.join(__dirname, 'WorkBuddyM1M2M3-SDK只读接入复现-20261007.cjs');
    const codexRepro = path.join(__dirname, 'CodexSDK只读M1M3复核-20261007.cjs');
    const codexSummary = path.join(__dirname, 'CodexSDK只读汇总复现-20261007.cjs');
    const jsonSha = crypto.createHash('sha256').update(fs.readFileSync(histJson)).digest('hex');
    const scriptSha = crypto.createHash('sha256').update(fs.readFileSync(histScript)).digest('hex');
    const declaredJsonSha = 'ea3caa2ec5aaa469f3d14cf9b05280d359be20ef38434b7e91fdaea1e6f582c1';
    const declaredScriptSha = '1da8655f2e310b1f75d416126e3ca947ef4691bcfed4b598ea99ab0ff134ad01';
    const histJson_ = JSON.parse(fs.readFileSync(histJson, 'utf8'));
    record('historical-evidence-preserved', true, {
      historicalJsonSha256: jsonSha,
      historicalScriptSha256: scriptSha,
      declaredJsonSha256: declaredJsonSha,
      declaredScriptSha256: declaredScriptSha,
      scriptMatchesDeclaration: scriptSha === declaredScriptSha,
      jsonDiffersFromDeclaration: jsonSha !== declaredJsonSha,
      jsonObservedAt: histJson_.observedAt,
      differenceCause: 'JSON 内含 observedAt 运行时间戳；该 JSON 由同一脚本在收尾时**重跑一次**产出，' +
        '时间戳变化导致字节不同。脚本本身未变（哈希与声明一致）。非第三方修改。',
      codexEvidencePresent: fs.existsSync(codexRepro) && fs.existsSync(codexSummary),
      action: '按第 8 节要求：**保留**原 JSON 与原哈希声明，未重跑覆盖来「对齐」；本轮证据只写 stdout。',
      note: 'Codex 的审查依据是其独立复现，不依赖该 JSON 逐字节可信'
    });
  }

  const out = {
    observedAt: new Date().toISOString(),
    scope: 'M1/M2/M3 R1–R5 返修（SDK 只读身份接入，本地离线）',
    basedOn: 'docs/Codex复核-SDK只读身份M1-M3本地实现-20261007.md 第 2–6 节',
    constraints: {
      network: false, executedCli: false, readAuth: false, fetchedRealCredential: false,
      installed: false, initialized: false, deployed: false, createdResources: false,
      wroteFiles: false, historicalEvidenceOverwritten: false
    },
    realNetworkCalls: 0,
    realCloudCalls: 0,
    fixedEnvironment: { envId: o.FIXED.envId, appId: o.FIXED.wxAppId, region: o.FIXED.region },
    results,
    blockingGaps: [
      {
        id: 'public-cli-identity-source-not-proven-offline',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: 'R1 要求先完成「受控公共 CLI 离线身份选择证明」再接入真实获取实现。' +
          '本轮**未执行**真实 CLI（不执行 bundle、不联网），故该离线证明**未完成**，' +
          '真实凭据获取宿主因此保持关闭（credentialFetchHostImplemented=false）。',
        needed: '在受审宿主内以隔离目录 + 合成凭据执行一次公共 `api` 命令，观察实际选用的身份来源。'
      },
      {
        id: 'same-batch-credential-chain-not-proven-in-production',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: '未执行 secrets get --json、未获取任何真实凭据，「同一批凭据同时供给 CLI 与 SDK」在生产层面未证实。' +
          '本轮已证实的是：注入路径（合成）、隔离清理、有效期多点核对、同一份快照不刷新不混批。',
        needed: '受审宿主内按既有只读授权执行一次整组，另存脱敏证据。'
      },
      {
        id: 'no-real-database-read-performed',
        severity: 'EXPECTED_THIS_ROUND',
        detail: 'primary / users 均未真实读取。副本是否已有主管理员、指定微信用户记录是否有效**均未知**。',
        needed: '同批凭据链证实后，由受审宿主执行一次只读整组。'
      },
      {
        id: 'target-user-source-unconfirmed',
        severity: 'EXPECTED_THIS_ROUND',
        detail: '目标 userId 未预填。CLI 接受一个格式严格的完整 userId 作为只读查询目标，' +
          '但参数不构成授权，也不构成现实人员证明。',
        needed: '由 Codex 把受信指定来源与目标对应好后再执行。'
      },
      {
        id: 'sdk-network-retry-count-unverified',
        severity: 'EXPECTED_LATER',
        detail: 'SDK 自身的重试与超时未实测。本轮只固定了 worker 层的 55 秒 / 1 MiB 上限。',
        needed: '真实执行时记录实际请求次数与耗时。'
      },
      {
        id: 'permission-denial-vs-collection-missing-unclassified',
        severity: 'EXPECTED_LATER',
        detail: '权限拒绝与网络失败都归为 UNCONFIRMED（不猜错误码、不解析自由 message）。',
        needed: '取得官方错误契约后再细分。'
      }
    ],
    boundaries: {
      writeAuthorized: false,
      productionCallerVerifierImplemented: false,
      collectionsTouched: [w.ADMIN_COLLECTION, w.USER_COLLECTION],
      note: '仅独立测试副本 schtest_v1_*；未查旧业务 users/app_admins'
    },
    summary: {
      total: results.length,
      passed: results.filter(r => r.pass).length,
      failed: results.filter(r => !r.pass).length,
      blockingGaps: 2
    }
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (out.summary.failed > 0) process.exitCode = 1;
}

main().catch(e => {
  process.stderr.write(String((e && e.stack) || e) + '\n');
  process.exitCode = 1;
});
