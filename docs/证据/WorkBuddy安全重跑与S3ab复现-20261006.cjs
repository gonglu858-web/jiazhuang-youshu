'use strict';
// S3-a / S3-b / E1 的独立复现 + **安全证据重跑入口**。
//
// 用途（对应报告第 2、3、4 节）：
// 1. S3-a：全部请求同步抛错时，收尾信号必须触发（V06 两笔、V07 单笔、混合）；
// 2. S3-b：超时后的晚到成功/拒绝必须补留证，且不改判、不回写状态、不解锁；
// 3. E1：提供**安全重跑入口** —— 不 require 自执行的旧脚本、不覆盖历史 JSON，
//    只跑一次并 await，输出落到新文件；宿主无法启动时如实标「未重跑」。
//
// 边界：只加载真实模块（驱动、协调器、客户端、页面），API/存储/事务为合成替身；
// **不安装、不联网、不创建资源、不部署、不启用入口、不清缓存、不处理 A/B/C**。
//
// 用法：node docs/证据/WorkBuddy安全重跑与S3ab复现-20261006.cjs
// 产出：同名 .json（历史脚本与历史 JSON 全程只读）

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = p => sha256(fs.readFileSync(p));

/** 取既有测试文件的夹具工厂（不注册原测试）。 */
function helpers(rel, names) {
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  const prefix = source.slice(0, source.indexOf('\ntest('));
  const m = { exports: {} };
  vm.runInThisContext(
    `(function(require,module,exports,__dirname,__filename){${prefix}\nmodule.exports={${names}};})`,
    { filename: file }
  )(createRequire(file), m, m.exports, path.dirname(file), file);
  return m.exports;
}

const d = helpers(
  'miniapp/tests/sandbox-test-driver.test.cjs',
  'loadDriver,loadPage,openProof,baseInput,makeStorage,makeApi,resetAll,ctxFor,coordinator,scheduleOk,IDENTIFY_OK,MEMBERS_OK,MANAGER,WORKER_B,PROJECT,clone'
);
const p = helpers(
  'miniapp/tests/sandbox-primary-bootstrap.test.cjs',
  'bootstrap,makeAdapter,goodPlan,goodApproval,OWNER,OTHER,APP_ID,ENV_ID,FIXED_NOW'
);

const writes = api => api.__calls.filter(x => ['createSchedule', 'updateSchedule', 'removeMember'].includes(x.action));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const batchKeyOf = storage => Object.keys(storage.store).find(k => k.includes('batch:'));

const results = [];
async function record(id, requirement, fn) {
  try {
    results.push(Object.assign({ id, requirement, sealed: true, harnessError: null }, await fn()));
  } catch (error) {
    results.push({ id, requirement, sealed: false, harnessError: String(error && error.stack) });
  }
}

// ── E1：安全重跑入口 ────────────────────────────────────────────────────

/**
 * 安全地重跑一个**自执行**的证据脚本。
 *
 * 逐条对应报告第 4 节：
 * - **不 require** 旧脚本（require 会执行它并写它的同名 JSON）；
 * - 复制到**根下两层**的隔离路径（旧脚本按 `__dirname/../..` 推导仓库根），
 *   因此它的输出路径也落到隔离位置，**历史 JSON 不会被覆盖**；
 * - 复制前后校验源脚本 SHA-256 一致；
 * - **只执行一次**，并等待完成（有界超时）；
 * - 宿主无法创建进程 / 未产出结果 / 非零退出 → `reran:false` + 原因，
 *   绝不回读历史 JSON 冒充本次结果。
 */
async function safeRerun(options) {
  const label = options.label;
  const srcPath = path.join(root, options.sourceScript);
  const srcHash = sha256File(srcPath);
  // 隔离副本必须正好在根下两层
  const outDirAbs = path.join(root, 'docs', '证据重跑');
  const isolatedScript = path.join(outDirAbs, `${label}__${path.basename(options.sourceScript)}`);
  const isolatedJson = isolatedScript.replace(/\.cjs$/, '.json');
  const historicalJson = srcPath.replace(/\.cjs$/, '.json');

  const record_ = {
    label,
    sourceScript: options.sourceScript,
    isolatedScript: path.relative(root, isolatedScript).split(path.sep).join('/'),
    isolatedResult: path.relative(root, isolatedJson).split(path.sep).join('/'),
    historicalResult: options.sourceScript.replace(/\.cjs$/, '.json'),
    sourceSha256: srcHash,
    requiredByE1: {
      noRequireOfSelfRunningScript: true,
      singleExecution: true,
      awaited: true,
      newOutputFile: true,
      historyReadOnly: true
    },
    reran: false,
    awaited: false,
    summary: null,
    reason: null
  };
  record_.historicalResultSha256Before = fs.existsSync(historicalJson) ? sha256File(historicalJson) : null;

  if (isolatedJson === historicalJson) {
    record_.reason = '隔离输出与历史结果同路径，已拒绝执行。';
    return record_;
  }
  if (!fs.existsSync(srcPath)) {
    record_.reason = '源脚本不存在：本次未重跑。';
    return record_;
  }

  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.copyFileSync(srcPath, isolatedScript);
  record_.copiedSha256 = sha256File(isolatedScript);
  if (record_.copiedSha256 !== srcHash) {
    record_.reason = '隔离副本哈希与源不一致，已拒绝执行。';
    return record_;
  }
  // 清掉隔离位置的旧产物，确保读到的只能是本次结果
  if (fs.existsSync(isolatedJson)) fs.rmSync(isolatedJson);

  const { spawnSync } = require('node:child_process');
  const run = spawnSync(process.execPath, [isolatedScript], { cwd: root, encoding: 'utf8', timeout: 180000 });
  if (run.error) {
    // 宿主无法创建子进程（Windows 上表现为 EBUSY/EPERM）。
    // 回退到**进程内执行隔离副本**：因为副本在独立目录、按 __filename 写输出，
    // 它只会写隔离位置的新文件，历史 JSON 不受影响。
    // 仍然只执行**一次**，并有界等待其产物出现且稳定。
    record_.executionMode = 'in-process-isolated(fallback)';
    record_.spawnBlocked = String(run.error.code || run.error.message);
    let loaded = false;
    try {
      require(isolatedScript); // 隔离副本，绝不是历史脚本
      loaded = true;
    } catch (error) {
      record_.reason = `进程内执行隔离副本失败：${String(error && error.message).split('\n')[0]}`;
    }
    if (loaded) {
      // 有界等待：产物出现且大小/哈希连续两次不变即视为完成
      let stable = 0;
      let lastSig = '';
      for (let i = 0; i < 1200 && stable < 3; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (!fs.existsSync(isolatedJson)) continue;
        let sig;
        try {
          sig = `${fs.statSync(isolatedJson).size}:${fs.statSync(isolatedJson).mtimeMs}`;
        } catch (e) { continue; }
        if (sig === lastSig) stable++;
        else { lastSig = sig; stable = 0; }
      }
      if (!fs.existsSync(isolatedJson)) {
        record_.reason = '进程内执行后仍未产出结果文件：本次未重跑。';
      }
    }
  } else {
    record_.executionMode = 'subprocess';
    if (run.status !== 0) {
      record_.reason = `重跑进程非零退出（status=${run.status}）：本次未重跑。`;
    }
  }

  if (!record_.reason && !fs.existsSync(isolatedJson)) {
    record_.reason = '重跑未产出结果文件：本次未重跑。';
  }

  if (!record_.reason && fs.existsSync(isolatedJson)) {
    const doc = JSON.parse(fs.readFileSync(isolatedJson, 'utf8'));
    record_.reran = true;
    record_.awaited = true;
    record_.summary = doc.summary || null;
    record_.producedExecutedAt = doc.executedAt || null;
    record_.producedSha256 = sha256File(isolatedJson);
    record_.producedMatchesHistory = record_.producedSha256 === record_.historicalResultSha256Before;
  }

  const after = fs.existsSync(historicalJson) ? sha256File(historicalJson) : null;
  record_.historicalResultSha256After = after;
  record_.historicalResultUntouched = after === record_.historicalResultSha256Before;
  if (!record_.historicalResultUntouched) {
    record_.reran = false;
    record_.reason = '历史结果文件被改动，已作废本次重跑结论。';
  }
  return record_;
}

// ── 合成 API：真正的同步抛错 / 可手动结算 ─────────────────────────────

/** callFunction **不是 async** —— throw 发生在调用栈上，是真正的同步异常。 */
function makeSyncThrowApi(storage, options) {
  const opts = options || {};
  const calls = [];
  let invoked = 0;
  return {
    storage,
    getStorageInfoSync: storage.getStorageInfoSync,
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop', version: '1.0.0' } }),
    cloud: {
      callFunction(args) {
        calls.push(JSON.parse(JSON.stringify(args.data)));
        if (args.data.action === 'identify') return Promise.resolve({ result: JSON.parse(JSON.stringify(d.IDENTIFY_OK)) });
        if (args.data.action === 'getMembers') return Promise.resolve({ result: JSON.parse(JSON.stringify(d.MEMBERS_OK)) });
        if (args.data.action === 'listSchedules') {
          return Promise.resolve({ result: { ok: true, schedules: [], pagination: { limit: 100, hasMore: false, nextCursor: null } } });
        }
        invoked++;
        if (invoked <= (opts.throwOn === undefined ? Infinity : opts.throwOn)) {
          throw new Error('synthetic synchronous send failure');
        }
        return Promise.resolve(opts.result || { result: d.scheduleOk() });
      }
    },
    __calls: calls,
    __invoked: () => invoked
  };
}

/** 每笔业务请求返回可手动 resolve/reject 的 promise。 */
function makeManualApi(storage) {
  const calls = [];
  const ctl = [];
  let n = 0;
  return {
    storage,
    getStorageInfoSync: storage.getStorageInfoSync,
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop', version: '1.0.0' } }),
    cloud: {
      async callFunction(args) {
        calls.push(JSON.parse(JSON.stringify(args.data)));
        if (args.data.action === 'identify') return { result: JSON.parse(JSON.stringify(d.IDENTIFY_OK)) };
        if (args.data.action === 'getMembers') return { result: JSON.parse(JSON.stringify(d.MEMBERS_OK)) };
        if (args.data.action === 'listSchedules') {
          return { result: { ok: true, schedules: [], pagination: { limit: 100, hasMore: false, nextCursor: null } } };
        }
        const idx = n++;
        return new Promise((resolve, reject) => { ctl[idx] = { resolve, reject }; });
      }
    },
    __calls: calls,
    __ctl: ctl
  };
}

(async () => {
  // ── S3-a ────────────────────────────────────────────────────────────
  await record('S3-a-all-sync-throw-V06-a', 'V06 两笔均同步抛错 → 能收尾、stopped、释放占用', async () => {
    d.resetAll();
    const drv = d.loadDriver(d.openProof());
    const storage = d.makeStorage();
    const api = makeSyncThrowApi(storage);
    const r = await Promise.race([
      drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput() }),
      sleep(300).then(() => ({ timedOut: true }))
    ]);
    const rec = d.coordinator.readCase(d.ctxFor(storage), 'V06-a');
    return {
      completed: r.timedOut === undefined,
      invoked: api.__invoked(),
      businessRequests: writes(api).length,
      verdict: r.verdict,
      stoppedReason: r.stoppedReason,
      persistedState: rec.status === 'ok' ? rec.record.state : null,
      persistedOutcomes: rec.status === 'ok' ? rec.record.responses.map(x => x.outcome).sort() : null,
      runtimeHeld: d.coordinator.peekRuntimeHold().held,
      sealed: r.timedOut === undefined
        && api.__invoked() === 2
        && writes(api).length === 2
        && r.report.verdict === 'stopped'
        && r.report.stoppedReason === 'UNKNOWN_RESULT'
        && rec.record.state === 'stopped'
        && d.coordinator.peekRuntimeHold().held === false
    };
  });

  await record('S3-a-all-sync-throw-V07-B', 'V07 唯一移出调用同步抛错 → 能收尾、stopped、释放占用', async () => {
    d.resetAll();
    const drv = d.loadDriver(d.openProof());
    const storage = d.makeStorage();
    const api = makeSyncThrowApi(storage, { result: { result: { userId: d.WORKER_B, status: 'left' } } });
    const r = await Promise.race([
      drv.runCase({ api, testCaseId: 'V07-B', input: { projectId: d.PROJECT, userId: d.WORKER_B } }),
      sleep(300).then(() => ({ timedOut: true }))
    ]);
    const rec = d.coordinator.readCase(d.ctxFor(storage), 'V07-B');
    return {
      completed: r.timedOut === undefined,
      invoked: api.__invoked(),
      businessRequests: writes(api).length,
      verdict: r.verdict,
      stoppedReason: r.stoppedReason,
      persistedState: rec.status === 'ok' ? rec.record.state : null,
      persistedOutcomes: rec.status === 'ok' ? rec.record.responses.map(x => x.outcome) : null,
      runtimeHeld: d.coordinator.peekRuntimeHold().held,
      sealed: r.timedOut === undefined
        && api.__invoked() === 1
        && r.report.verdict === 'stopped'
        && r.report.stoppedReason === 'UNKNOWN_RESULT'
        && rec.record.state === 'stopped'
        && d.coordinator.peekRuntimeHold().held === false
    };
  });

  await record('S3-a-mixed-sync-throw-and-async', '单笔同步抛错 + 另一笔异步成功 → 正常收尾', async () => {
    d.resetAll();
    const drv = d.loadDriver(d.openProof());
    const storage = d.makeStorage();
    const api = makeSyncThrowApi(storage, { throwOn: 1 });
    const r = await Promise.race([
      drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput() }),
      sleep(300).then(() => ({ timedOut: true }))
    ]);
    const rec = d.coordinator.readCase(d.ctxFor(storage), 'V06-a');
    return {
      completed: r.timedOut === undefined,
      verdict: r.verdict,
      stoppedReason: r.stoppedReason,
      persistedOutcomes: rec.status === 'ok' ? rec.record.responses.map(x => x.outcome).sort() : null,
      runtimeHeld: d.coordinator.peekRuntimeHold().held,
      sealed: r.timedOut === undefined
        && r.report.verdict === 'stopped'
        && rec.status === 'ok'
        && JSON.stringify(rec.record.responses.map(x => x.outcome).sort()) === JSON.stringify(['responded', 'sync-throw'])
        && d.coordinator.peekRuntimeHold().held === false
    };
  });

  // ── S3-b ────────────────────────────────────────────────────────────
  await record('S3-b-late-success-after-timeout', '晚到成功 → 补存净化证据、保留 timeout/停止、不回写状态', async () => {
    d.resetAll();
    const drv = d.loadDriver(d.openProof());
    const storage = d.makeStorage();
    const api = makeManualApi(storage);
    const timers = [];
    const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
    const running = drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput(), timers: clock });
    await sleep(30);
    api.__ctl[1].resolve({ result: d.scheduleOk() });
    await sleep(20);
    timers[2](); // 只让第一笔超时（identify/getMembers 也用同一 timers）
    const r = await running;
    const key = batchKeyOf(storage);
    const before = storage.store[key];
    const stateBefore = JSON.parse(before).cases['V06-a'].state;

    api.__ctl[0].resolve({ result: d.scheduleOk({ content: 'LATE_ARRIVED_CONTENT' }) });
    await sleep(30);

    const rec = JSON.parse(storage.store[key]).cases['V06-a'];
    const late = rec.lateArrivals || [];
    return {
      verdictBefore: r.verdict, reasonBefore: r.stoppedReason,
      storageChanged: storage.store[key] !== before,
      stateBefore, stateAfter: rec.state,
      mainOutcomes: rec.responses.map(x => x.outcome).sort(),
      lateCount: late.length,
      lateOutcome: late.map(x => x.outcome),
      lateContent: late.map(x => (x.result && x.result.content) || null),
      lateMarked: late.every(x => x.late === true),
      sealed: storage.store[key] !== before
        && rec.state === stateBefore && rec.state === 'stopped'
        && JSON.stringify(rec.responses.map(x => x.outcome).sort()) === JSON.stringify(['responded', 'timeout'])
        && late.length === 1 && late[0].outcome === 'responded' && late[0].late === true
        && late[0].result.content === 'LATE_ARRIVED_CONTENT'
        && r.report.verdict === 'stopped' && r.report.stoppedReason === 'UNKNOWN_RESULT'
    };
  });

  await record('S3-b-late-rejection-after-timeout', '晚到拒绝 → 补存 network-error、保留原判定', async () => {
    d.resetAll();
    const drv = d.loadDriver(d.openProof());
    const storage = d.makeStorage();
    const api = makeManualApi(storage);
    const timers = [];
    const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
    const running = drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput(), timers: clock });
    await sleep(30);
    api.__ctl[1].resolve({ result: d.scheduleOk() });
    await sleep(20);
    timers[2]();
    const r = await running;
    api.__ctl[0].reject(new Error('late network failure'));
    await sleep(30);
    const rec = JSON.parse(storage.store[batchKeyOf(storage)]).cases['V06-a'];
    const late = rec.lateArrivals || [];
    return {
      verdictBefore: r.verdict, reasonBefore: r.stoppedReason,
      stateAfter: rec.state,
      mainOutcomes: rec.responses.map(x => x.outcome).sort(),
      lateOutcomes: late.map(x => x.outcome),
      lateMarked: late.every(x => x.late === true),
      sealed: rec.state === 'stopped'
        && JSON.stringify(rec.responses.map(x => x.outcome).sort()) === JSON.stringify(['responded', 'timeout'])
        && late.length === 1 && late[0].outcome === 'network-error' && late[0].late === true
    };
  });

  await record('S3-b-late-persist-failure-stays-stopped', '补存失败 → 原停止判定与原 timeout 证据均不被破坏', async () => {
    d.resetAll();
    const drv = d.loadDriver(d.openProof());
    const storage = d.makeStorage();
    const api = makeManualApi(storage);
    const orig = storage.setStorageSync;
    let failLate = false;
    storage.setStorageSync = (k, v) => {
      if (failLate && v.includes('lateArrivals')) throw new Error('synthetic late persist failure');
      orig(k, v);
    };
    const timers = [];
    const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
    const running = drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput(), timers: clock });
    await sleep(30);
    api.__ctl[1].resolve({ result: d.scheduleOk() });
    await sleep(20);
    timers[2]();
    const r = await running;
    failLate = true;
    api.__ctl[0].resolve({ result: d.scheduleOk({ content: 'LATE' }) });
    await sleep(30);
    const rec = JSON.parse(storage.store[batchKeyOf(storage)]).cases['V06-a'];
    return {
      verdict: r.verdict, reason: r.stoppedReason,
      stateAfter: rec.state,
      mainOutcomes: rec.responses.map(x => x.outcome).sort(),
      sealed: r.report.verdict === 'stopped'
        && rec.state === 'stopped'
        && JSON.stringify(rec.responses.map(x => x.outcome).sort()) === JSON.stringify(['responded', 'timeout'])
    };
  });

  await record('S3-b-same-request-id-slots-distinguished', '相同 requestId 的两笔按各自槽位区分晚到证据', async () => {
    d.resetAll();
    const drv = d.loadDriver(d.openProof());
    const storage = d.makeStorage();
    const api = makeManualApi(storage);
    const timers = [];
    const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
    const running = drv.runCase({
      api, testCaseId: 'V06-a',
      input: d.baseInput({ requestId1: 'same-id', requestId2: 'same-id' }),
      timers: clock
    });
    await sleep(30);
    api.__ctl[1].resolve({ result: d.scheduleOk({ content: 'SECOND_OK' }) });
    await sleep(20);
    timers[2]();
    const r = await running;
    api.__ctl[0].resolve({ result: d.scheduleOk({ content: 'FIRST_LATE_OK' }) });
    await sleep(30);
    const rec = JSON.parse(storage.store[batchKeyOf(storage)]).cases['V06-a'];
    const late = rec.lateArrivals || [];
    return {
      verdict: r.verdict, reason: r.stoppedReason,
      state: rec.state,
      requestIds: rec.responses.map(x => x.requestId),
      mainOutcomes: rec.responses.map(x => x.outcome).sort(),
      lateCount: late.length,
      lateContent: late.map(x => (x.result && x.result.content) || null),
      sealed: rec.state === 'stopped'
        && rec.responses.length === 2
        && JSON.stringify(rec.responses.map(x => x.outcome).sort()) === JSON.stringify(['responded', 'timeout'])
        && late.length === 1
        && late[0].result.content === 'FIRST_LATE_OK'
    };
  });

  await record('S3-b-no-resend-no-unlock', '晚到补存不得补发、不得解锁下一例', async () => {
    d.resetAll();
    const drv = d.loadDriver(d.openProof());
    const storage = d.makeStorage();
    const api = makeManualApi(storage);
    const timers = [];
    const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
    const running = drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput(), timers: clock });
    await sleep(30);
    api.__ctl[1].resolve({ result: d.scheduleOk() });
    await sleep(20);
    timers[2]();
    await running;
    const sendsBefore = writes(api).length;
    api.__ctl[0].resolve({ result: d.scheduleOk({ content: 'LATE' }) });
    await sleep(30);
    // 轮次级阻断仍生效（stopped 永不解锁）
    const block = d.coordinator.blockingCases(d.ctxFor(storage));
    const nextCase = await drv.runCase({
      api, testCaseId: 'V06-b', input: d.baseInput({ requestId1: 'b1', requestId2: 'b2' })
    });
    return {
      sendsBeforeLate: sendsBefore,
      sendsAfterLate: writes(api).length,
      blockingAfterLate: block.blocking.map(x => `${x.testCaseId}=${x.state}`),
      nextCaseStarted: nextCase.ok,
      sealed: writes(api).length === sendsBefore
        && block.blocking.some(x => x.testCaseId === 'V06-a' && x.state === 'stopped')
        && nextCase.ok === false
    };
  });

  // ── E1：安全重跑 ────────────────────────────────────────────────────
  d.resetAll();

  const historyFiles = [
    'docs/证据/Codex驱动R1R5剩余复现-20261005.cjs',
    'docs/证据/Codex驱动R1R5剩余复现-20261005.json',
    'docs/证据/Codex驱动S1S5复核-20261006.cjs',
    'docs/证据/Codex驱动S1S5复核-20261006.json',
    'docs/证据/WorkBuddy返修R1R5复现-20261005.cjs',
    'docs/证据/WorkBuddy返修R1R5复现-20261005.json',
    'docs/证据/WorkBuddy返修S1S5复现-20261006.cjs',
    'docs/证据/WorkBuddy返修S1S5复现-20261006.json'
  ];
  const historyBefore = {};
  for (const rel of historyFiles) {
    const p2 = path.join(root, rel);
    if (fs.existsSync(p2)) historyBefore[rel] = sha256File(p2);
  }

  const reruns = [
    await safeRerun({ label: '前轮34条', sourceScript: 'docs/证据/WorkBuddy返修R1R5复现-20261005.cjs' }),
    await safeRerun({ label: '本轮18条', sourceScript: 'docs/证据/WorkBuddy返修S1S5复现-20261006.cjs' })
  ];

  const historyAfter = {};
  for (const rel of historyFiles) {
    const p2 = path.join(root, rel);
    if (fs.existsSync(p2)) historyAfter[rel] = sha256File(p2);
  }
  const historyDrift = Object.keys(historyBefore).filter(rel => historyBefore[rel] !== historyAfter[rel]);

  // 汇总
  const hash = rel => sha256File(path.join(root, rel));
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/证据/独立测试副本执行包本地基线-20261005.json'), 'utf8'));
  const differences = [];
  const missing = [];
  for (const [rel, expected] of Object.entries(baseline.files)) {
    if (!fs.existsSync(path.join(root, rel))) missing.push(rel);
    else if (hash(rel) !== expected) differences.push(rel);
  }
  const frozen = v => !v || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(frozen));
  const configs = {};
  for (const name of ['sandbox-test-driver-proof', 'schedule-sandbox-proof', 'schedule-entry-proof']) {
    const v = require(path.join(root, 'miniapp/miniprogram/config', name));
    configs[name] = { value: v, deepFrozen: frozen(v) };
  }
  const retainedHashes = {};
  for (const rel of [
    'miniapp/scripts/package-sandbox.cjs',
    'miniapp/cloudbase/schedule-sandbox-resources.candidate.json',
    'artifacts/schedule-sandbox/closed-20261005/manifest.json',
    'artifacts/schedule-sandbox/closed-20261005-r2fix/manifest.json',
    'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs',
    'miniapp/cloudfunctions/scheduleSandbox/vendor/service.js',
    'miniapp/cloudfunctions/scheduleSandbox/vendor/schedule-service.js'
  ]) retainedHashes[rel] = hash(rel);

  const e1Sealed = reruns.every(r => r.historicalResultUntouched === true)
    && historyDrift.length === 0
    && reruns.some(r => r.reran === true); // 至少一次真实重跑完成

  const output = {
    executedAt: new Date().toISOString(),
    scope: 'S3-a / S3-b counterexamples plus E1 safe-rerun entry; real modules, synthetic API/storage; no platform execution',
    summary: {
      total: results.length,
      sealed: results.filter(r => r.sealed === true).length,
      unsealed: results.filter(r => r.sealed !== true).length,
      harnessErrors: results.filter(r => r.harnessError).length
    },
    e1: {
      sealed: e1Sealed,
      requirement: '不 require 自执行旧脚本、不覆盖历史 JSON、只跑一次并 await、输出落新文件、宿主不可用时如实标未重跑',
      reruns,
      historyFileHashesBefore: historyBefore,
      historyFileHashesAfter: historyAfter,
      historyDrift
    },
    baseline: { count: Object.keys(baseline.files).length, missing, differences },
    retainedHashes,
    configs,
    results,
    notVerified: [
      '真机未验证：全部使用合成 wx 与内存存储。',
      '真实管理 SDK 未核实：P4 仅本地原子核心，primary 未在生产初始化（本轮未触碰 P4 写核心）。',
      '真实 wcc/wcsc 编译未执行。',
      '互斥为同一设备/运行时操作互斥，不是跨设备锁。',
      'S3-b 的晚到补存只在**本地合成**响应下验证；真实网络下的晚到时序未实测。',
      '宿主进程创建在本机会偶发 EBUSY（node 内 spawn 任何可执行文件均失败），此时重跑/CLI 子进程项如实标未验证。'
    ],
    boundaries: {
      installed: false,
      cloudCalled: false,
      resourcesCreated: false,
      deployed: false,
      entryEnabled: false,
      cacheCleared: false,
      sdkAdapterConnected: false,
      abcProcessed: false,
      historyEvidenceRewritten: false
    }
  };
  const out = __filename.replace(/\.cjs$/, '.json');
  fs.writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output.summary));
  console.log('E1 sealed:', e1Sealed, '| historyDrift:', JSON.stringify(historyDrift));
  for (const r of results) {
    console.log(`${r.sealed ? 'SEALED  ' : 'UNSEALED'} | ${r.id}${r.harnessError ? ' | HARNESS: ' + r.harnessError.split('\n')[0] : ''}`);
  }
  for (const r of reruns) {
    console.log(`RERUN    | ${r.label} | reran=${r.reran} awaited=${r.awaited} summary=${JSON.stringify(r.summary)} reason=${r.reason || '-'}`);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});