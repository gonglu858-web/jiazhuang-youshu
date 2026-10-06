'use strict';
// WorkBuddy S1–S5 定点收尾的独立复现证据。
//
// 与 Codex 的 `Codex驱动R1R5剩余复现-20261005.cjs` 的关系：
// - **Codex 原证据原样保留不改写**；本脚本是返修侧的对照复现。
// - 复用同一批 S1–S5 反例 id，逐条给出「修前复现 / 收尾后封堵」的实测结果。
// - 另外重跑上一轮**已通过的 34 条**，确认本轮没有回退已验收成果。
// - 只加载**真实模块**（驱动、协调器、客户端、页面、P4 核心），
//   API/存储/事务适配器为**合成替身**；故障注入只在内存。
// - **不安装、不联网、不创建资源、不部署、不启用入口、不清缓存。**
//
// 用法：node docs/证据/WorkBuddy返修S1S5复现-20261006.cjs
// 产出：同名 .json

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');

/** 从既有测试文件里取夹具工厂（不注册原测试，只取 helpers）。 */
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
  'loadDriver,loadPage,openProof,baseInput,makeStorage,makeApi,resetAll,ctxFor,coordinator,scheduleOk,IDENTIFY_OK,MEMBERS_OK,MANAGER,WORKER_B,PROJECT,clone,defaultHandler'
);
const p = helpers(
  'miniapp/tests/sandbox-primary-bootstrap.test.cjs',
  'bootstrap,makeAdapter,goodPlan,goodApproval,ownerRecord,OWNER,OTHER,APP_ID,ENV_ID,FIXED_NOW'
);

const CLIENT = path.join(root, 'miniapp/miniprogram/utils/schedule-sandbox-client.js');
const writes = api => api.__calls.filter(x => ['createSchedule', 'updateSchedule', 'removeMember'].includes(x.action));
const tick = () => new Promise(resolve => setImmediate(resolve));

const results = [];
async function record(id, requirement, fn) {
  try {
    const outcome = await fn();
    results.push(Object.assign({ id, requirement, sealed: true, harnessError: null }, outcome));
  } catch (error) {
    results.push({ id, requirement, sealed: false, harnessError: String(error && error.stack) });
  }
}

/** 驱动场景：默认 identify/getMembers 正常（真实 service 契约：统一包 ok:true）。 */
function setup(handler, extra, proofOverrides, apiOverrides) {
  d.resetAll();
  const storage = d.makeStorage();
  const proof = d.openProof(proofOverrides);
  const driver = d.loadDriver(proof);
  const api = d.makeApi(Object.assign({
    storage,
    handler: d.defaultHandler(handler || (() => d.scheduleOk()), extra || {})
  }, apiOverrides || {}));
  return { storage, proof, driver, api };
}

/** 加载一份注入开启副本 proof 的真实客户端副本。 */
function loadClient(proof) {
  const m = { exports: {} };
  const enabledSandbox = {
    ...require(path.join(root, 'miniapp/miniprogram/config/schedule-sandbox-proof')),
    enabled: true,
    roundId: proof.roundId,
    sandboxProjectId: proof.projectId
  };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(CLIENT, 'utf8')}\n})`)(
    name => (name.includes('config/schedule-sandbox-proof') ? enabledSandbox : createRequire(CLIENT)(name)),
    m, m.exports);
  return m.exports;
}

/**
 * E1：安全的证据重跑入口。
 *
 * 约束（逐条对应报告第 4 节）：
 * - **不 require** 自执行的旧脚本（require 就会执行它并覆盖它的历史 JSON）；
 * - 复制到隔离目录后**只执行一次**，输出落到**新文件**，历史脚本/JSON 不动；
 * - 复制前后校验源脚本 **SHA-256 一致**，确保「跑的是同一份内容」；
 * - 执行被 **await** 完成；
 * - 宿主无法启动进程或读不到新结果 → 如实标 `reran: false` + 原因，
 *   **不**回退去读旧 JSON 冒充本次重跑，也**不**改成通过。
 *
 * @param {object} options { label, sourceScript, outDir }
 * @returns {Promise<object>} 本次重跑的结论（**只依据本次产生的文件**）
 */
async function safeRerun(options) {
  const label = options.label;
  const srcPath = path.join(root, options.sourceScript);
  const srcHashBefore = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex');
  // 隔离副本必须**正好在根下两层**（如 docs/证据重跑/xxx.cjs）——
  // 旧脚本用 `path.resolve(__dirname, '../..')` 推导仓库根，放深了会算错根目录。
  const outDirAbs = path.join(root, 'docs', '证据重跑');
  const base = options.label + '__' + path.basename(options.sourceScript);
  const isolatedScript = path.join(outDirAbs, base);
  const isolatedJson = isolatedScript.replace(/\.cjs$/, '.json');

  const result = {
    label,
    sourceScript: options.sourceScript,
    isolatedScript: path.relative(root, isolatedScript).split(path.sep).join('/'),
    isolatedResult: path.relative(root, isolatedJson).split(path.sep).join('/'),
    sourceSha256: srcHashBefore,
    reran: false,
    awaited: false,
    summary: null,
    reason: null
  };

  // 记录历史 JSON 的哈希，用于证明「本次运行没有覆盖历史输出」
  const historicalJson = srcPath.replace(/\.cjs$/, '.json');
  result.historicalResultSha256Before = fs.existsSync(historicalJson)
    ? crypto.createHash('sha256').update(fs.readFileSync(historicalJson)).digest('hex')
    : null;

  if (isolatedJson === historicalJson) {
    result.reason = '隔离输出路径与历史结果相同，已拒绝执行以免覆盖历史证据。';
    return result;
  }

  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.copyFileSync(srcPath, isolatedScript);
  result.sourceSha256AfterCopy = crypto.createHash('sha256')
    .update(fs.readFileSync(isolatedScript)).digest('hex');
  if (result.sourceSha256AfterCopy !== srcHashBefore) {
    result.reason = '复制后的脚本哈希与源不一致，已拒绝执行。';
    return result;
  }
  // 隔离副本自身的历史 JSON 残留先清掉，确保读到的只能是本次产物
  if (fs.existsSync(isolatedJson)) fs.rmSync(isolatedJson);

  const { spawnSync } = require('node:child_process');
  const run = spawnSync(process.execPath, [isolatedScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000
  });
  if (run.error) {
    result.reason = `宿主无法启动子进程（${run.error.code || run.error.message}）：本次未重跑。`;
  } else if (run.status !== 0) {
    result.reason = `重跑进程以非零状态结束（status=${run.status}）：本次未重跑。`;
  } else if (!fs.existsSync(isolatedJson)) {
    result.reason = '重跑进程未产出结果文件：本次未重跑。';
  } else {
    // 只读**本次**产生的文件
    const doc = JSON.parse(fs.readFileSync(isolatedJson, 'utf8'));
    result.reran = true;
    result.awaited = true;
    result.summary = doc.summary || null;
    result.executedAt = doc.executedAt || null;
    result.producedSha256 = crypto.createHash('sha256').update(fs.readFileSync(isolatedJson)).digest('hex');
  }

  // 复核历史 JSON 未被本次运行改动
  const historicalAfter = fs.existsSync(historicalJson)
    ? crypto.createHash('sha256').update(fs.readFileSync(historicalJson)).digest('hex')
    : null;
  result.historicalResultSha256After = historicalAfter;
  result.historicalResultUntouched = historicalAfter === result.historicalResultSha256Before;
  if (!result.historicalResultUntouched) {
    result.reran = false;
    result.reason = '检测到历史结果文件被改动，已作废本次重跑结论。';
  }
  return result;
}

(async () => {
  // ── S1：官方真实账号信息形状 ──────────────────────────────────────────
  await record(
    'S1-official-account-info-shape-blocked',
    '官方 MiniProgram 形状（无 envId）必须能正常运行，不得要求虚构 envId',
    async () => {
      const x = setup();
      // 官方契约：appId / envVersion / version，**没有 envId**
      x.api.getAccountInfoSync = () => ({ miniProgram: { appId: x.proof.appId, envVersion: 'develop', version: '1.0.0' } });
      const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      return {
        code: r.code,
        gateReasons: r.report.gateReasons || null,
        calls: x.api.__calls.length,
        businessRequests: writes(x.api).length,
        verdict: r.report.verdict,
        sealed: r.ok === true && r.report.verdict === 'candidate' && writes(x.api).length === 2
      };
    }
  );

  await record(
    'S1-config-env-pinned-per-call',
    '云环境改由固定 proof + 每次 callFunction.config.env 保证',
    async () => {
      const x = setup();
      const seen = [];
      const inner = x.api.cloud.callFunction;
      x.api.cloud.callFunction = args => { seen.push({ name: args.name, env: args.config && args.config.env }); return inner(args); };
      await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      const allPinned = seen.length > 0 && seen.every(c => c.name === 'scheduleSandbox' && c.env === 'cloud1-d8gcq5ag39d847723');
      // 配置环境偏离固定值时 sendFixed 必须直接抛错
      d.resetAll();
      const badDriver = d.loadDriver(d.openProof({ envId: 'cloud_other' }));
      const api2 = d.makeApi({ storage: d.makeStorage(), handler: d.defaultHandler(() => d.scheduleOk()) });
      let threw = false;
      try { badDriver.sendFixed(api2, { action: 'identify' }); } catch (e) { threw = true; }
      return {
        callsChecked: seen.length,
        allCallsPinned: allPinned,
        mismatchedEnvRejected: threw,
        mismatchedEnvRequests: api2.__calls.length,
        sealed: allPinned && threw && api2.__calls.length === 0
      };
    }
  );

  // ── S2：损坏记录与伪造凭证 ────────────────────────────────────────────
  await record(
    'S2-malformed-batch-cases-silently-reset',
    'cases 是数组（可解析但非字典）必须失败关闭，且不得重置原记录',
    async () => {
      const x = setup();
      const key = d.coordinator.batchKey(x.proof.envId, x.proof.roundId);
      const original = JSON.stringify({
        kind: 'sandbox-test-driver-batch/2',
        envId: x.proof.envId,
        roundId: x.proof.roundId,
        cases: []
      });
      x.storage.store[key] = original;
      const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      return {
        verdict: r.report.verdict,
        businessRequests: writes(x.api).length,
        recordUntouched: x.storage.store[key] === original,
        sealed: r.ok === false && writes(x.api).length === 0 && x.storage.store[key] === original
      };
    }
  );

  await record(
    'S2-batch-structure-variants-fail-closed',
    'kind / envId / roundId / 未知状态 / 键值不符 / 绑定不符 / 缺摘要 一律失败关闭',
    async () => {
      const good = { envId: 'cloud1-d8gcq5ag39d847723', roundId: 'round-test-1' };
      const variants = [
        ['wrong-kind', { kind: 'sandbox-test-driver-batch/1', envId: good.envId, roundId: good.roundId, cases: {} }],
        ['wrong-env', { kind: 'sandbox-test-driver-batch/2', envId: 'cloud_other', roundId: good.roundId, cases: {} }],
        ['wrong-round', { kind: 'sandbox-test-driver-batch/2', envId: good.envId, roundId: 'round-other', cases: {} }],
        ['unknown-state', {
          kind: 'sandbox-test-driver-batch/2', envId: good.envId, roundId: good.roundId,
          cases: { 'V06-a': { testCaseId: 'V06-a', state: 'weird', binding: good, snapshotDigest: 'x' } }
        }],
        ['key-id-mismatch', {
          kind: 'sandbox-test-driver-batch/2', envId: good.envId, roundId: good.roundId,
          cases: { 'V06-a': { testCaseId: 'V06-b', state: 'stopped', binding: good, snapshotDigest: 'x' } }
        }],
        ['record-not-object', {
          kind: 'sandbox-test-driver-batch/2', envId: good.envId, roundId: good.roundId,
          cases: { 'V06-a': 'not-an-object' }
        }],
        ['binding-mismatch', {
          kind: 'sandbox-test-driver-batch/2', envId: good.envId, roundId: good.roundId,
          cases: { 'V06-a': { testCaseId: 'V06-a', state: 'stopped', binding: { envId: 'cloud_other', roundId: good.roundId }, snapshotDigest: 'x' } }
        }],
        ['no-digest', {
          kind: 'sandbox-test-driver-batch/2', envId: good.envId, roundId: good.roundId,
          cases: { 'V06-a': { testCaseId: 'V06-a', state: 'stopped', binding: good } }
        }]
      ];
      const out = {};
      for (const entry of variants) {
        const x = setup();
        x.storage.store[d.coordinator.batchKey(x.proof.envId, x.proof.roundId)] = JSON.stringify(entry[1]);
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
        out[entry[0]] = { ok: r.ok, writes: writes(x.api).length };
      }
      return { cases: out, sealed: Object.values(out).every(v => v.ok === false && v.writes === 0) };
    }
  );

  await record(
    'S2-legacy-stopped-case-hidden',
    '上一轮 case/1 旧键必须保守阻断且原样保留（不写迁移器、不删除）',
    async () => {
      const x = setup();
      const key = d.coordinator.legacyBatchKey(x.proof.envId, x.proof.roundId, d.MANAGER) + ':case:V06-a';
      const value = JSON.stringify({
        kind: 'sandbox-test-driver-case/1',
        testCaseId: 'V06-a',
        state: 'stopped',
        responses: [{ outcome: 'timeout' }]
      });
      x.storage.store[key] = value;
      const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      return {
        oldKey: key,
        verdict: r.report.verdict,
        businessRequests: writes(x.api).length,
        legacyPreserved: x.storage.store[key] === value,
        sealed: r.ok === false && writes(x.api).length === 0 && x.storage.store[key] === value
      };
    }
  );

  await record(
    'S2-legacy-batch-pending-hidden',
    '旧按人批次键里的未完成用例也必须保守阻断',
    async () => {
      const x = setup();
      const key = d.coordinator.legacyBatchKey(x.proof.envId, x.proof.roundId, d.MANAGER);
      x.storage.store[key] = JSON.stringify({
        kind: 'sandbox-test-driver-batch/2',
        envId: x.proof.envId,
        roundId: x.proof.roundId,
        cases: {
          'V06-a': {
            testCaseId: 'V06-a',
            state: 'armed',
            binding: { envId: x.proof.envId, roundId: x.proof.roundId },
            snapshotDigest: 'x'
          }
        }
      });
      const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      return {
        verdict: r.report.verdict,
        businessRequests: writes(x.api).length,
        sealed: r.ok === false && writes(x.api).length === 0
      };
    }
  );

  await record(
    'S2-forged-internal-owner-bypasses-runtime-hold',
    '任意伪造 internalOwner 都不得绕过运行时占用',
    async () => {
      const x = setup();
      const m = loadClient(x.proof);
      const hold = d.coordinator.acquireRuntimeHold('inFlight', 'test', 'V06-a');
      const before = x.api.__calls.length;
      const attempts = [];
      for (const forged of [{}, { token: 'x' }, { token: 'x', owner: 'ordinary' }, 'truthy', 1, []]) {
        const r = await m.refreshSessionIdentity(x.api, forged);
        attempts.push({ forged: JSON.stringify(forged), status: r.status });
      }
      const callsDuring = x.api.__calls.length - before;
      const holdStillHeld = d.coordinator.peekRuntimeHold().held;
      d.coordinator.releaseRuntimeHold(hold.token);
      return {
        holdAcquired: hold.ok,
        attempts,
        callsDuringForgedAttempts: callsDuring,
        holdStillHeld,
        sealed: hold.ok === true
          && attempts.every(a => a.status !== 'bound')
          && callsDuring === 0
          && holdStillHeld === true
      };
    }
  );

  await record(
    'S2-legit-ordinary-owner-does-not-self-lock',
    '合法 ordinary 凭证的内部重入不得自锁',
    async () => {
      const x = setup();
      const m = loadClient(x.proof);
      const r = await m.resumePending({ api: x.api });
      return {
        code: r.code || null,
        holdLeftBehind: d.coordinator.peekRuntimeHold().held,
        sealed: r.code !== 'SANDBOX_TEST_DRIVER_ACTIVE' && d.coordinator.peekRuntimeHold().held === false
      };
    }
  );

  // ── S3：逐笔监听与完整回读 ───────────────────────────────────────────
  await record(
    'S3-second-response-not-persisted-until-first',
    '第二笔先成功必须先到先留证，不等第一笔',
    async () => {
      d.resetAll();
      const drv = d.loadDriver(d.openProof());
      const storage = d.makeStorage();
      let resolveFirst = null;
      let secondResolved = false;
      let n = 0;
      // 注意：不能用 defaultHandler（它对结果做 JSON clone，会毁掉 pending promise）
      const api = d.makeApi({
        storage,
        handler: async data => {
          if (data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
          if (data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
          if (++n === 1) return new Promise(resolve => { resolveFirst = resolve; });
          secondResolved = true;
          return { result: d.scheduleOk() };
        }
      });
      const running = drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput() });
      for (let i = 0; i < 12 && !secondResolved; i++) await tick();
      await tick();
      const before = d.coordinator.readCase(d.ctxFor(storage), 'V06-a');
      const saved = (before.record && before.record.responses) ? before.record.responses.length : 0;
      if (resolveFirst) resolveFirst({ result: d.scheduleOk() });
      const r = await running;
      return {
        secondResolved,
        rowsSavedBeforeFirst: saved,
        finalVerdict: r.report.verdict,
        finalResponseCount: r.report.responses.length,
        sealed: secondResolved === true && saved === 1 && r.report.responses.length === 2
      };
    }
  );

  await record(
    'S3-each-request-timer-starts-at-send',
    '每笔超时起点是各自发送时刻；先拒绝的那笔先留证',
    async () => {
      d.resetAll();
      const drv = d.loadDriver(d.openProof());
      const storage = d.makeStorage();
      let n = 0;
      const api = d.makeApi({
        storage,
        handler: async data => {
          if (data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
          if (data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
          if (++n === 1) return new Promise(() => {});
          throw new Error('synthetic network failure');
        }
      });
      const timers = [];
      const pending = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
      const running = drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput(), timers });
      await new Promise(resolve => setTimeout(resolve, 20));
      const mid = d.coordinator.readCase(d.ctxFor(storage), 'V06-a').record;
      const midRows = (mid && mid.responses) ? mid.responses.length : 0;
      const midOutcome = (mid && mid.responses && mid.responses[0]) ? mid.responses[0].outcome : null;
      for (const fn of timers) { try { fn(); } catch (e) { /* 忽略 */ } }
      const r = await running;
      const outcomes = r.report.responses.map(x => x.outcome).sort();
      return {
        rowsSavedBeforeFirstFinished: midRows,
        firstArrivedOutcome: midOutcome,
        finalOutcomes: outcomes,
        verdict: r.report.verdict,
        sealed: midRows === 1 && midOutcome === 'network-error'
          && outcomes.join(',') === 'network-error,timeout'
          && r.report.verdict === 'stopped'
      };
    }
  );

  await record(
    'S3-candidate-readback-lost-responses-accepted',
    '回读丢失 responses 不得显示 candidate',
    async () => {
      d.resetAll();
      const drv = d.loadDriver(d.openProof());
      const storage = d.makeStorage();
      const orig = storage.setStorageSync;
      let injected = false;
      storage.setStorageSync = (key, value) => {
        const doc = JSON.parse(value);
        if (doc.cases && doc.cases['V06-a'] && doc.cases['V06-a'].state === 'candidate') {
          delete doc.cases['V06-a'].responses;
          injected = true;
          orig(key, JSON.stringify(doc));
          return;
        }
        orig(key, value);
      };
      const api = d.makeApi({ storage, handler: d.defaultHandler(() => d.scheduleOk()) });
      const r = await drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput() });
      return {
        injected,
        verdict: r.report.verdict,
        stoppedReason: r.report.stoppedReason,
        sealed: injected === true && r.report.verdict !== 'candidate'
          && r.report.stoppedReason === 'TEST_DRIVER_STORAGE_UNAVAILABLE'
      };
    }
  );

  await record(
    'S3-readback-binding-and-old-content-tampering',
    '回读被改 binding 或回退旧内容一律保守停止',
    async () => {
      const out = {};
      const mutators = [
        ['binding', doc => { doc.cases['V06-a'].binding.projectId = 'p_tampered'; }],
        ['old-content', doc => { doc.cases['V06-a'].responses = [{ requestId: 'r-a-1', outcome: 'timeout' }]; }]
      ];
      for (const entry of mutators) {
        d.resetAll();
        const drv = d.loadDriver(d.openProof());
        const storage = d.makeStorage();
        const orig = storage.setStorageSync;
        let injected = false;
        storage.setStorageSync = (key, value) => {
          const doc = JSON.parse(value);
          if (!injected && doc.cases && doc.cases['V06-a'] && doc.cases['V06-a'].state === 'candidate') {
            injected = true;
            entry[1](doc);
            orig(key, JSON.stringify(doc));
            return;
          }
          orig(key, value);
        };
        const api = d.makeApi({ storage, handler: d.defaultHandler(() => d.scheduleOk()) });
        const r = await drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput() });
        out[entry[0]] = { injected, verdict: r.report.verdict };
      }
      return {
        cases: out,
        sealed: Object.values(out).every(v => v.injected === true && v.verdict !== 'candidate')
      };
    }
  );

  // ── S4：当前安排语义与查询前提 ────────────────────────────────────────
  await record(
    'S4-current-expected-date-overwritten',
    'c 必须采用当前 expectedDate；与 endDate 不等时明确停止、零 update',
    async () => {
      let updates = 0;
      const current = d.scheduleOk({ version: 7, expectedDate: '2026-11-05', endDate: '2026-11-03' });
      d.resetAll();
      const proof = d.openProof();
      const driver = d.loadDriver(proof);
      const storage = d.makeStorage();
      const api = d.makeApi({
        storage,
        handler: async data => {
          if (data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
          if (data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
          if (data.action === 'createSchedule') return { result: d.scheduleOk() };
          if (data.action === 'getSchedule') return { result: { ok: true, schedule: current } };
          if (data.action === 'updateSchedule') {
            updates++;
            return { result: ++updates === 1 ? d.scheduleOk({ version: 8 }) : { ok: false, code: 'VERSION_MISMATCH' } };
          }
          return { result: d.scheduleOk() };
        }
      });
      await driver.runCase({ api, testCaseId: 'V06-a', input: d.baseInput() });
      d.coordinator.acceptCloudReview(d.ctxFor(storage), 'V06-a', 'synthetic-review');
      const page = d.loadPage(api, driver, proof);
      page.data.form = Object.assign(d.baseInput(), { restDaysText: '' });
      await page.runTestCase({ currentTarget: { dataset: { case: 'V06-c' } } });
      const sent = writes(api).filter(c => c.action === 'updateSchedule');
      return {
        currentExpectedDate: current.expectedDate,
        currentEndDate: current.endDate,
        sentExpectedDates: sent.map(c => c.form.expectedDate),
        verdict: page.data.testReport.verdict,
        stoppedReason: page.data.testReport.stoppedReason,
        sealed: sent.length === 0
          && page.data.testReport.verdict === 'stopped'
          && page.data.testReport.stoppedReason === 'TEST_DRIVER_CURRENT_DATES_NOT_EQUAL'
      };
    }
  );

  await record(
    'S4-current-schedule-missing-fields',
    '当前安排缺 expectedDate 或 restDays 非法 → 停止、零 update',
    async () => {
      const out = {};
      const variants = [
        ['no-expected', d.scheduleOk({ expectedDate: undefined })],
        ['restDays-not-array', d.scheduleOk({ restDays: 'not-an-array' })],
        ['restDays-bad-item', d.scheduleOk({ restDays: [1] })]
      ];
      for (const entry of variants) {
        d.resetAll();
        const drv = d.loadDriver(d.openProof());
        const storage = d.makeStorage();
        const current = entry[1];
        const api = d.makeApi({
          storage,
          handler: async data => {
            if (data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
            if (data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
            if (data.action === 'createSchedule') return { result: d.scheduleOk() };
            if (data.action === 'getSchedule') return { result: { ok: true, schedule: current } };
            return { result: { ok: false, code: 'VERSION_MISMATCH' } };
          }
        });
        await drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput() });
        d.coordinator.acceptCloudReview(d.ctxFor(storage), 'V06-a', 'synthetic-review');
        api.__calls.length = 0;
        const c = await drv.runCase({
          api, testCaseId: 'V06-c',
          input: d.baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'a', content2: 'b', reason: 'r' })
        });
        out[entry[0]] = { code: c.code, writes: writes(api).length };
      }
      return {
        cases: out,
        sealed: Object.values(out).every(v => v.code === 'TEST_DRIVER_CURRENT_SCHEDULE_UNKNOWN' && v.writes === 0)
      };
    }
  );

  await record(
    'S4-invalid-pagination-treated-as-empty',
    'listSchedules 不可信（ok=false / 缺 hasMore / 坏行 / 游标循环）→ 前提未知、零移出',
    async () => {
      const emptyPage = { limit: 100, hasMore: false, nextCursor: null };
      const goodRow = {
        stage: '拆改', trade: '拆改', workerUserId: d.WORKER_B,
        startDate: '2026-11-02', endDate: '2026-11-03', content: 'c', restDays: []
      };
      const variants = [
        ['ok-false', { ok: false, schedules: [], pagination: emptyPage }],
        ['hasMore-missing', { ok: true, schedules: [], pagination: { limit: 100 } }],
        ['hasMore-not-boolean', { ok: true, schedules: [], pagination: { limit: 100, hasMore: 'no' } }],
        ['pagination-missing', { ok: true, schedules: [] }],
        ['bad-row-no-id', { ok: true, schedules: [Object.assign({ id: undefined, projectId: d.PROJECT, status: 'active', version: 1 }, goodRow)], pagination: emptyPage }],
        ['bad-row-unexpected-shape', { ok: true, schedules: [{ unexpected: 'invalid-row' }], pagination: emptyPage }],
        ['bad-row-wrong-project', { ok: true, schedules: [d.scheduleOk({ projectId: 'p_other' })], pagination: emptyPage }],
        ['bad-row-not-active', { ok: true, schedules: [d.scheduleOk({ status: 'cancelled' })], pagination: emptyPage }],
        ['bad-row-version-zero', { ok: true, schedules: [d.scheduleOk({ version: 0 })], pagination: emptyPage }],
        ['bad-row-content-object', { ok: true, schedules: [d.scheduleOk({ content: { token: 'X' } })], pagination: emptyPage }],
        ['cursor-loop', { ok: true, schedules: [], pagination: { limit: 100, hasMore: true, nextCursor: 'c1' } }]
      ];
      const out = {};
      for (const entry of variants) {
        d.resetAll();
        const drv = d.loadDriver(d.openProof());
        const storage = d.makeStorage();
        const payload = entry[1];
        const api = d.makeApi({
          storage,
          handler: async data => {
            if (data.action === 'listSchedules') return { result: d.clone(payload) };
            if (data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
            if (data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
            return { result: { userId: d.WORKER_B, status: 'left' } };
          }
        });
        const r = await drv.runCase({ api, testCaseId: 'V07-B', input: { projectId: d.PROJECT, userId: d.WORKER_B } });
        out[entry[0]] = { code: r.code, writes: writes(api).length };
      }
      return {
        cases: out,
        sealed: Object.values(out).every(v => v.code === 'TEST_DRIVER_V07_PRECONDITION_UNKNOWN' && v.writes === 0)
      };
    }
  );

  await record(
    'S4-unvalidated-nested-field-persists',
    '嵌套/非法类型的成功字段不得进入报告或持久存储',
    async () => {
      const out = {};
      const variants = [
        ['content-object', d.scheduleOk({ content: { token: 'SYNTHETIC_SECRET_MARKER' } })],
        ['content-array', d.scheduleOk({ content: ['SYNTHETIC_SECRET_MARKER'] })],
        ['restDays-objects', d.scheduleOk({ restDays: [{ token: 'SYNTHETIC_SECRET_MARKER' }] })],
        ['version-string', d.scheduleOk({ version: '1' })]
      ];
      for (const entry of variants) {
        d.resetAll();
        const drv = d.loadDriver(d.openProof());
        const storage = d.makeStorage();
        const api = d.makeApi({ storage, handler: d.defaultHandler(() => entry[1]) });
        const r = await drv.runCase({ api, testCaseId: 'V06-a', input: d.baseInput() });
        out[entry[0]] = {
          verdict: r.report.verdict,
          markerInStorage: JSON.stringify(storage.store).includes('SYNTHETIC_SECRET_MARKER'),
          markerInReport: JSON.stringify(r.report).includes('SYNTHETIC_SECRET_MARKER')
        };
      }
      // 正向：正常公开成功仍可通过
      d.resetAll();
      const okDriver = d.loadDriver(d.openProof());
      const okStorage = d.makeStorage();
      const okApi = d.makeApi({ storage: okStorage, handler: d.defaultHandler(() => d.scheduleOk()) });
      const okResult = await okDriver.runCase({ api: okApi, testCaseId: 'V06-a', input: d.baseInput() });
      return {
        cases: out,
        positiveStillPasses: okResult.report.verdict,
        sealed: Object.values(out).every(v => v.verdict !== 'candidate' && !v.markerInStorage && !v.markerInReport)
          && okResult.report.verdict === 'candidate'
      };
    }
  );

  // ── S5：只读观测一致性 ───────────────────────────────────────────────
  await record(
    'S5-disabled-primary-observed-as-consistent',
    '停用 / 缺 status / 目标错 / 关联不符 → inconsistent；读取失败仍 unconfirmed',
    async () => {
      const out = {};
      const mutatePrimary = async (label, mutate) => {
        const adapter = p.makeAdapter();
        await p.bootstrap.initializePrimary({ plan: p.goodPlan(), approval: p.goodApproval(), adapter });
        mutate(adapter.__data.schtest_v1_app_admins.primary);
        const r = await p.bootstrap.observePrimary({ adapter, plan: p.goodPlan(), approval: p.goodApproval() });
        out[label] = { state: r.state, writeAuthorized: r.writeAuthorized };
      };
      await mutatePrimary('disabled', doc => { doc.status = 'disabled'; });
      await mutatePrimary('missing-status', doc => { delete doc.status; });
      await mutatePrimary('wrong-target', doc => { doc.userId = p.OTHER; });
      await mutatePrimary('wrong-primary-key', doc => { doc._id = 'other'; });

      const mutateAudit = async (label, mutate) => {
        const adapter = p.makeAdapter();
        const init = await p.bootstrap.initializePrimary({ plan: p.goodPlan(), approval: p.goodApproval(), adapter });
        mutate(adapter.__data.schtest_v1_audit_events[init.auditId]);
        const r = await p.bootstrap.observePrimary({ adapter, plan: p.goodPlan(), approval: p.goodApproval() });
        out[label] = { state: r.state, writeAuthorized: r.writeAuthorized };
      };
      await mutateAudit('audit-wrong-round', doc => { doc.roundId = 'round-other'; });
      await mutateAudit('audit-wrong-env', doc => { doc.envId = 'env_other'; });
      await mutateAudit('audit-wrong-evidence', doc => { doc.evidenceId = 'ev-other'; });
      await mutateAudit('audit-wrong-digest', doc => { doc.inputDigest = 'deadbeef'; });
      await mutateAudit('audit-wrong-action', doc => { doc.action = 'somethingElse'; });

      // 读取失败 → unconfirmed
      const failing = p.makeAdapter();
      failing.readOnlyGet = async () => { throw new Error('synthetic read failure'); };
      const unconfirmed = await p.bootstrap.observePrimary({
        adapter: failing, plan: p.goodPlan(), approval: p.goodApproval()
      });
      out['read-failure'] = { state: unconfirmed.state, writeAuthorized: unconfirmed.writeAuthorized };

      // 正向：正常初始化后仍为 present
      const good = p.makeAdapter();
      await p.bootstrap.initializePrimary({ plan: p.goodPlan(), approval: p.goodApproval(), adapter: good });
      const present = await p.bootstrap.observePrimary({ adapter: good, plan: p.goodPlan(), approval: p.goodApproval() });
      out['positive'] = { state: present.state, writeAuthorized: present.writeAuthorized, primaryStatus: present.primaryStatus };

      const negatives = Object.entries(out).filter(([k]) => k !== 'positive');
      return {
        cases: out,
        sealed: negatives.every(([, v]) => v.state === 'inconsistent' || v.state === 'unconfirmed')
          && negatives.every(([, v]) => v.writeAuthorized === false)
          && out['positive'].state === 'present'
          && out['positive'].writeAuthorized === false
      };
    }
  );

  await record(
    'S5-observe-only-reads-two-records',
    '只读观察只查 primary 与本计划确定性审计，且不产生第二次授予',
    async () => {
      const adapter = p.makeAdapter();
      await p.bootstrap.initializePrimary({ plan: p.goodPlan(), approval: p.goodApproval(), adapter });
      const commitsBefore = adapter.__commits.length;
      const reads = [];
      const original = adapter.readOnlyGet.bind(adapter);
      adapter.readOnlyGet = async (collection, key) => { reads.push(`${collection}:${key}`); return original(collection, key); };
      const r = await p.bootstrap.observePrimary({ adapter, plan: p.goodPlan(), approval: p.goodApproval() });
      return {
        state: r.state,
        commitsBefore,
        commitsAfter: adapter.__commits.length,
        reads,
        writeAuthorized: r.writeAuthorized,
        sealed: adapter.__commits.length === commitsBefore
          && reads.length === 2
          && reads[0] === 'schtest_v1_app_admins:primary'
          && /^schtest_v1_audit_events:sbx-init-primary:/.test(reads[1])
          && r.writeAuthorized === false
      };
    }
  );

  // ── 回归：上一轮已通过的 34 条不得回退 ────────────────────────────────
  //
  // E1 返修说明（此处原为缺陷）：
  // 旧写法先 `require(旧脚本)` —— 那会**执行**自执行脚本（它无条件写同名 JSON），
  // 随后又用 execFileSync **再跑一遍**：等于启动两次、两次覆盖历史输出。
  //
  // 现在改为「安全重跑」：
  // 1) **不 require** 自执行的旧脚本；
  // 2) 复制到隔离目录再执行 —— 输出路径由 __filename 推导，因此结果落到
  //    **新文件**，历史脚本与历史 JSON 完全不动；
  // 3) 只跑**一次**且 await 完成；宿主无法启动或读不到新结果时如实标「未重跑」，
  //    绝不回退去读旧 JSON 冒充本次重跑。
  const previousRerun = await safeRerun({
    label: 'previous-R1R5-34',
    sourceScript: 'docs/证据/WorkBuddy返修R1R5复现-20261005.cjs',
    outDir: '证据重跑/前轮R1R5-34条'
  });

  // ── 汇总 ──────────────────────────────────────────────────────────────
  d.resetAll();

  const hash = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
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
    'miniapp/cloudfunctions/scheduleSandbox/index.js',
    'miniapp/cloudfunctions/scheduleSandbox/gate.js',
    'miniapp/cloudfunctions/scheduleSandbox/vendor/service.js',
    'miniapp/cloudfunctions/scheduleSandbox/vendor/schedule-service.js',
    'docs/证据/Codex驱动R1R5剩余复现-20261005.cjs',
    'docs/证据/Codex驱动R1R5剩余复现-20261005.json'
  ]) retainedHashes[rel] = hash(rel);

  const output = {
    executedAt: new Date().toISOString(),
    scope: 'local S1–S5 repair verification against Codex counterexamples; real modules, synthetic API/storage/transaction adapters; no platform execution',
    originalEvidencePreserved: [
      'docs/证据/Codex驱动R1R5剩余复现-20261005.cjs',
      'docs/证据/Codex驱动R1R5剩余复现-20261005.json',
      'docs/证据/Codex驱动R1R5返修全量测试-20261005.txt',
      'docs/证据/Codex重跑WorkBuddyR1R5-20261005.json'
    ],
    summary: {
      total: results.length,
      sealed: results.filter(r => r.sealed === true).length,
      unsealed: results.filter(r => r.sealed !== true).length,
      harnessErrors: results.filter(r => r.harnessError).length
    },
    previousR1R5Rerun: previousRerun,
    baseline: { count: Object.keys(baseline.files).length, missing, differences },
    retainedHashes,
    configs,
    results,
    notVerified: [
      '真机未验证：全部使用合成 wx 与内存存储。',
      '真实管理 SDK 未核实：P4 仅本地原子核心，primary 未在生产初始化。',
      '真实 wcc/wcsc 编译未执行；WXML 只做静态标签配平与关键串检查。',
      '互斥为同一设备/运行时操作互斥，不是跨设备锁。',
      '平台索引就绪、3 秒超时、100 操作、32 KiB、真实并发与费用均未实测。',
      'S1：云环境的实际生效仍取决于平台是否按 config.env 路由，本地只验证了调用参数被显式限定。'
    ],
    boundaries: {
      installed: false,
      cloudCalled: false,
      resourcesCreated: false,
      deployed: false,
      entryEnabled: false,
      cacheCleared: false,
      sdkAdapterConnected: false,
      abcProcessed: false
    }
  };
  const out = __filename.replace(/\.cjs$/, '.json');
  fs.writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output.summary));
  for (const r of results) {
    console.log(`${r.sealed ? 'SEALED  ' : 'UNSEALED'} | ${r.id}${r.harnessError ? ' | HARNESS: ' + r.harnessError.split('\n')[0] : ''}`);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});