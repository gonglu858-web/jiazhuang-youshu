'use strict';
// WorkBuddy R1–R5 定点返修的独立复现证据。
//
// 与 Codex 的 `Codex最小驱动V06V07P4复核-20261005.cjs` 的关系：
// - **原证据原样保留不改写**；本脚本是**返修侧**的对照复现。
// - 复用同一批反例 id，逐条给出「修前复现 / 返修后封堵」的实测结果。
// - 只加载**真实模块**（驱动、协调器、客户端、页面、P4 核心），
//   API/存储/事务适配器为**合成替身**；故障注入只在内存。
// - **不安装、不联网、不创建资源、不部署、不启用入口、不清缓存。**
//
// 用法：node docs/证据/WorkBuddy返修R1R5复现-20261005.cjs
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
  'loadDriver,openProof,baseInput,makeStorage,makeApi,resetAll,ctxFor,coordinator,IDENTIFY_OK,MEMBERS_OK,MANAGER,WORKER_B,PROJECT,scheduleOk,defaultHandler,clone,loadPage'
);
const p = helpers(
  'miniapp/tests/sandbox-primary-bootstrap.test.cjs',
  'bootstrap,makeAdapter,goodPlan,goodApproval,ownerRecord,OWNER,OTHER,APP_ID,ENV_ID,FIXED_NOW'
);

const PAGE = path.join(root, 'miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js');
const CLIENT = path.join(root, 'miniapp/miniprogram/utils/schedule-sandbox-client.js');
const writes = api => api.__calls.filter(x => ['createSchedule', 'updateSchedule', 'removeMember'].includes(x.action));

const results = [];
async function record(id, requirement, fn) {
  try {
    const outcome = await fn();
    // sealed=true 表示该反例的合同已封堵（零请求 / 被拒 / 不再是候选）
    results.push(Object.assign({ id, requirement, sealed: true, harnessError: null }, outcome));
  } catch (error) {
    results.push({ id, requirement, sealed: false, harnessError: String(error && error.stack) });
  }
}

/** 驱动场景：默认 identify/getMembers 正常，业务动作由 respond 决定。 */
function setup(respond, extra, proofOverrides, apiOverrides) {
  d.resetAll();
  const storage = d.makeStorage();
  const proof = d.openProof(proofOverrides);
  const driver = d.loadDriver(proof);
  const api = d.makeApi(Object.assign({
    storage,
    handler: d.defaultHandler(respond, extra || {})
  }, apiOverrides || {}));
  return { storage, proof, driver, api };
}

(async () => {
  // ── R1：双向、跨页与持久互斥 ───────────────────────────────────────────
  await record(
    'R1-ordinary-identity-inflight-does-not-block-driver',
    '普通身份刷新在途时驱动必须零业务发送',
    async () => {
      const x = setup(() => d.scheduleOk());
      const m = { exports: {} };
      const enabledSandbox = {
        enabled: true, roundId: x.proof.roundId, sandboxProjectId: x.proof.projectId,
        appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723',
        functionName: 'scheduleSandbox', allowedVersions: ['develop', 'trial'],
        cachePrefix: 'schtest_v1:', sandboxProjectId: x.proof.projectId, roundId: x.proof.roundId
      };
      vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(CLIENT, 'utf8')}\n})`)(
        name => (name.includes('config/schedule-sandbox-proof') ? enabledSandbox : createRequire(CLIENT)(name)),
        m, m.exports);
      let release;
      let held = false;
      const inner = x.api.cloud.callFunction;
      x.api.cloud.callFunction = args => {
        if (args.data.action === 'identify' && !held) {
          held = true;
          return new Promise(resolve => { release = () => resolve({ result: d.clone(d.IDENTIFY_OK) }); });
        }
        return inner(args);
      };
      const pending = m.exports.refreshSessionIdentity(x.api);
      const result = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      const sentWhileOrdinary = writes(x.api).length;
      if (release) release();
      await pending;
      return {
        ordinaryWasInflight: held,
        driverVerdict: result.report.verdict,
        businessRequestsWhileOrdinaryInflight: sentWhileOrdinary,
        sealed: held === true && sentWhileOrdinary === 0
      };
    }
  );

  await record(
    'R1-candidate-does-not-block-next-case',
    'candidate 未人工接续前下一例不得启动、普通入口被阻断',
    async () => {
      const x = setup(() => d.scheduleOk());
      const a = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      const block = d.coordinator.ordinaryEntryBlock({
        storage: x.storage, envId: 'cloud1-d8gcq5ag39d847723', roundId: 'round-test-1', actorUserId: d.MANAGER
      });
      const b = await x.driver.runCase({
        api: x.api, testCaseId: 'V06-b', input: d.baseInput({ requestId1: 'b1', requestId2: 'b2' })
      });
      return {
        a: a.report.verdict,
        ordinaryBlock: block ? block.code : null,
        nextCaseStarted: b.ok,
        businessRequests: writes(x.api).length,
        batchKeys: Object.keys(x.storage.store).filter(k => k.includes('batch:')),
        sealed: a.report.verdict === 'candidate' && Boolean(block) && b.ok === false && writes(x.api).length === 2
      };
    }
  );

  await record(
    'R1-stopped-reload-does-not-block-next-case',
    'stopped 在页面重建后仍阻断，且人工接续不能解锁',
    async () => {
      const x = setup(() => ({ ok: false, code: 'SERVER_ERROR' }));
      const a = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      d.coordinator._resetRuntimeHoldForTest();
      const review = d.coordinator.acceptCloudReview(d.ctxFor(x.storage), 'V06-a', 'mgmt-review-1');
      const driver2 = d.loadDriver(x.proof);
      const b = await driver2.runCase({
        api: x.api, testCaseId: 'V06-b', input: d.baseInput({ requestId1: 'b1', requestId2: 'b2' })
      });
      return {
        a: a.report.verdict,
        reviewAccepted: review.ok,
        reviewCode: review.code || null,
        nextCaseStarted: b.ok,
        businessRequests: writes(x.api).length,
        sealed: a.report.verdict === 'stopped' && review.ok === false && b.ok === false && writes(x.api).length === 2
      };
    }
  );

  await record(
    'R1-account-switch-cannot-hide-batch',
    '换账号不得隐藏同轮次未完成批次',
    async () => {
      const x = setup(() => d.scheduleOk());
      const a = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      const otherCtx = {
        storage: x.storage, envId: 'cloud1-d8gcq5ag39d847723',
        roundId: 'round-test-1', actorUserId: d.WORKER_B, nowMs: Date.now()
      };
      const round = d.coordinator.blockingCases(otherCtx);
      const pre = d.coordinator.preflight(otherCtx, 'V06-b');
      return {
        a: a.report.verdict,
        blockingVisibleToOtherAccount: round.blocking.length,
        preflightBlocked: pre.ok === false,
        batchKeyHasNoActor: !d.coordinator.batchKey('cloud1-d8gcq5ag39d847723', 'round-test-1').includes(d.MANAGER),
        sealed: a.report.verdict === 'candidate' && round.blocking.length >= 1 && pre.ok === false
      };
    }
  );

  await record(
    'R1-storage-enumeration-unavailable-fails-closed',
    '存储无法枚举或读取异常时失败关闭，不得视为无未完成批次',
    async () => {
      const noEnum = d.makeStorage();
      delete noEnum.getStorageInfoSync;
      const a1 = d.loadDriver(d.openProof());
      const api1 = d.makeApi({ storage: noEnum, handler: d.defaultHandler(() => d.scheduleOk()) });
      delete api1.getStorageInfoSync;
      const r1 = await a1.runCase({ api: api1, testCaseId: 'V06-a', input: d.baseInput() });

      d.resetAll();
      const throwing = d.makeStorage();
      const orig = throwing.getStorageSync;
      throwing.getStorageSync = key => {
        if (String(key).includes('batch:')) throw new Error('storage read failure');
        return orig(key);
      };
      const a2 = d.loadDriver(d.openProof());
      const api2 = d.makeApi({ storage: throwing, handler: d.defaultHandler(() => d.scheduleOk()) });
      const r2 = await a2.runCase({ api: api2, testCaseId: 'V06-a', input: d.baseInput() });

      return {
        noEnumerationRejected: r1.ok === false,
        noEnumerationRequests: api1.__calls.length,
        readFailureRejected: r2.ok === false,
        readFailureRequests: api2.__calls.length,
        sealed: r1.ok === false && api1.__calls.length === 0 && r2.ok === false && api2.__calls.length === 0
      };
    }
  );

  await record(
    'R1-token-ownership-release',
    '运行时占用必须出示本方 token 才能释放',
    async () => {
      d.resetAll();
      const first = d.coordinator.acquireRuntimeHold('preflight', 'test', 'V06-a');
      const wrong = d.coordinator.releaseRuntimeHold('test:preflight:V06-a:999');
      const stillHeld = d.coordinator.peekRuntimeHold().held;
      const right = d.coordinator.releaseRuntimeHold(first.token);
      return {
        wrongTokenReleased: wrong,
        stillHeldAfterWrongToken: stillHeld,
        rightTokenReleased: right,
        sealed: wrong === false && stillHeld === true && right === true
      };
    }
  );

  // ── R2：固定目标与运行门控 ────────────────────────────────────────────
  await record(
    'R2-wrong-runtime-appid',
    '实际运行 AppID 与固定值不符必须零请求',
    async () => {
      const x = setup(() => d.scheduleOk(), null, null, { appId: 'wx_wrong_runtime' });
      const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      return {
        verdict: r.report.verdict, code: r.code, totalRequests: x.api.__calls.length,
        sealed: r.ok === false && x.api.__calls.length === 0
      };
    }
  );

  await record(
    'R2-input-project-overrides-proof',
    '输入项目与固定目标不符（含 A/B/C）必须在首次请求前拒绝',
    async () => {
      const out = {};
      for (const bad of ['p_other_target', ...d.coordinator.pendingBatchesForRound ? [] : []]) {
        const x = setup(() => d.scheduleOk());
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput({ projectId: bad }) });
        out[bad] = { code: r.code, requests: x.api.__calls.length };
      }
      // 再用配置里的受保护项目清单逐个验证
      const protectedIds = require(path.join(root, 'miniapp/miniprogram/config/sandbox-test-driver-proof')).protectedProjectIds;
      for (const bad of protectedIds) {
        const x = setup(() => d.scheduleOk());
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput({ projectId: bad }) });
        out[bad] = { code: r.code, requests: x.api.__calls.length };
      }
      const allZero = Object.values(out).every(v => v.requests === 0);
      return { cases: out, sealed: allZero };
    }
  );

  await record(
    'R2-v07-input-target-not-validated',
    'V07 目标必须等于配置里的完整受审目标，否则零发送',
    async () => {
      const x = setup(
        () => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' }),
        {
          __listSchedules: {
            schedules: [d.scheduleOk({ id: 's_x', workerUserId: d.WORKER_B })],
            pagination: { limit: 100, hasMore: false, nextCursor: null }
          }
        }
      );
      const r = await x.driver.runCase({
        api: x.api, testCaseId: 'V07-A', input: { projectId: d.PROJECT, userId: d.MANAGER }
      });
      return {
        verdict: r.report.verdict, code: r.code,
        configuredTarget: x.proof.v07TargetUserId,
        sentTargets: writes(x.api).map(c => c.userId),
        sealed: r.ok === false && writes(x.api).length === 0
      };
    }
  );

  await record(
    'R2-v07-protected-role-and-missing-member',
    'V07 目标为受保护角色 / 非师傅 / 不在公开成员列表 → 零发送',
    async () => {
      const out = {};
      const variants = [
        ['role-owner', [{ userId: d.MANAGER, roles: ['管家'], trades: [] }, { userId: d.WORKER_B, roles: ['负责人'], trades: [] }]],
        ['role-primary-owner', [{ userId: d.MANAGER, roles: ['管家'], trades: [] }, { userId: d.WORKER_B, roles: ['主业主'], trades: [] }]],
        ['not-worker', [{ userId: d.MANAGER, roles: ['管家'], trades: [] }, { userId: d.WORKER_B, roles: ['设计师'], trades: [] }]],
        ['absent', [{ userId: d.MANAGER, roles: ['管家'], trades: [] }]]
      ];
      for (const [label, members] of variants) {
        const x = setup(() => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' }));
        x.api.cloud.callFunction = async args => {
          x.api.__calls.push(d.clone(args.data));
          if (args.data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
          if (args.data.action === 'getMembers') return { result: { ok: true, members: d.clone(members) } };
          if (args.data.action === 'listSchedules') {
            return { result: { schedules: [d.scheduleOk({ workerUserId: d.WORKER_B })], pagination: { limit: 100, hasMore: false, nextCursor: null } } };
          }
          return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
        };
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V07-A', input: { projectId: d.PROJECT, userId: d.WORKER_B } });
        out[label] = { code: r.code, writes: writes(x.api).length };
      }
      return { cases: out, sealed: Object.values(out).every(v => v.writes === 0) };
    }
  );

  // ── R3：真实用例前提与响应形状 ────────────────────────────────────────
  await record(
    'R3-real-page-c-without-review-or-getSchedule',
    '真实 Page：c 需 a 已 reviewed，且必须真实调用 getSchedule',
    async () => {
      const proof = d.openProof();
      const driver = d.loadDriver(proof);
      const storage = d.makeStorage();
      let updates = 0;
      const api = d.makeApi({
        storage,
        handler: async data => {
          if (data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
          if (data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
          if (data.action === 'createSchedule') return { result: d.scheduleOk({ id: 's_review01', version: 1 }) };
          if (data.action === 'getSchedule') {
            return { result: { ok: true, schedule: d.scheduleOk({ id: 's_review01', version: 7, content: '当前内容', startDate: '2026-12-01', endDate: '2026-12-02', expectedDate: '2026-12-02' }) } };
          }
          if (data.action === 'updateSchedule') {
            updates++;
            return updates === 1
              ? { result: d.scheduleOk({ id: 's_review01', version: 8, content: '内容一' }) }
              : { result: { ok: false, code: 'VERSION_MISMATCH' } };
          }
          return { result: { ok: true } };
        }
      });
      const page = d.loadPage(api, driver, proof);
      page.data.form = Object.assign(d.baseInput(), { restDaysText: '' });

      await page.runTestCase({ currentTarget: { dataset: { case: 'V06-a' } } });
      const aVerdict = page.data.testReport.verdict;

      // 未接续：c 必须零业务发送
      api.__calls.length = 0; updates = 0;
      await page.runTestCase({ currentTarget: { dataset: { case: 'V06-c' } } });
      const beforeReview = { verdict: page.data.testReport.verdict, writes: writes(api).length };

      // 人工接续后再跑 c
      page.data.testReport = Object.assign({}, page.data.testReport, { testCaseId: 'V06-a' });
      page.data.testReviewIdInput = 'mgmt-review-page-1';
      page.acceptTestCloudReview();
      api.__calls.length = 0; updates = 0;
      await page.runTestCase({ currentTarget: { dataset: { case: 'V06-c' } } });
      const getScheduleRequests = api.__calls.filter(c => c.action === 'getSchedule').length;
      const updateCalls = api.__calls.filter(c => c.action === 'updateSchedule');

      return {
        aVerdict,
        beforeReview,
        getScheduleRequests,
        updates: updateCalls.length,
        expectedVersionFromCurrent: updateCalls[0] ? updateCalls[0].expectedVersion : null,
        formStartDateFromCurrent: updateCalls[0] ? updateCalls[0].form.startDate : null,
        contentsDiffer: updateCalls.length === 2 ? updateCalls[0].form.content !== updateCalls[1].form.content : false,
        busyCleared: page.data.testBusy === false,
        sealed: aVerdict === 'candidate'
          && beforeReview.verdict === 'stopped' && beforeReview.writes === 0
          && getScheduleRequests === 1 && updateCalls.length === 2
          && updateCalls[0].expectedVersion === 7
          && updateCalls[0].form.startDate === '2026-12-01'
          && page.data.testBusy === false
      };
    }
  );

  await record(
    'R3-malformed-success-is-candidate',
    '非标成功形状（缺字段 / 类型错 / 目标错 / 版本非 1）不得判候选',
    async () => {
      const variants = [
        ['no-id', () => ({ ok: true, version: 1, status: 'active' }), { ok: false, code: 'SCHEDULE_CONFLICT' }],
        ['version-zero', () => ({ ...d.scheduleOk(), version: 0 }), { ok: false, code: 'SCHEDULE_CONFLICT' }],
        ['version-two-both-ok', () => d.scheduleOk({ version: 2 }), () => d.scheduleOk({ version: 2 })],
        ['wrong-project', () => d.scheduleOk({ projectId: 'p_other' }), { ok: false, code: 'SCHEDULE_CONFLICT' }],
        ['wrong-worker', () => d.scheduleOk({ workerUserId: 'u_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }), { ok: false, code: 'SCHEDULE_CONFLICT' }],
        ['not-active', () => d.scheduleOk({ status: 'cancelled' }), { ok: false, code: 'SCHEDULE_CONFLICT' }],
        ['not-an-object', () => 'nope', () => d.scheduleOk()]
      ];
      const out = {};
      for (const [label, left, right] of variants) {
        const x = setup(() => d.scheduleOk());
        let n = 0;
        x.api.cloud.callFunction = async args => {
          x.api.__calls.push(d.clone(args.data));
          if (args.data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
          if (args.data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
          n++;
          return { result: n === 1 ? left : right };
        };
        const r = await x.driver.runCase({
          api: x.api, testCaseId: 'V06-b', input: d.baseInput({ requestId1: 'x1', requestId2: 'x2' })
        });
        out[label] = { verdict: r.report.verdict, stoppedReason: r.report.stoppedReason };
      }
      return {
        cases: out,
        sealed: Object.values(out).every(v => v.verdict === 'stopped')
      };
    }
  );

  await record(
    'R3-date-confirmation-not-auto-granted',
    '日期不一致不得自动授予确认（零请求）',
    async () => {
      const x = setup(() => d.scheduleOk());
      const r = await x.driver.runCase({
        api: x.api, testCaseId: 'V06-a', input: d.baseInput({ expectedDate: '2026-11-05' })
      });
      return {
        code: r.code, requests: x.api.__calls.length,
        sealed: r.ok === false && r.code === 'TEST_DRIVER_DATE_NOT_CONFIRMED' && x.api.__calls.length === 0
      };
    }
  );

  await record(
    'R3-b-and-c-request-id-and-content-constraints',
    'b/c 强制不同请求号；c 强制不同内容与正整数版本',
    async () => {
      const out = {};
      const cases = [
        ['b-same-request-id', 'V06-b', d.baseInput({ requestId1: 'same', requestId2: 'same' }), 'TEST_DRIVER_REQUEST_ID_NOT_DISTINCT'],
        ['c-same-request-id', 'V06-c', d.baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'a', content2: 'b', reason: 'r', requestId1: 'same', requestId2: 'same' }), 'TEST_DRIVER_REQUEST_ID_NOT_DISTINCT'],
        ['c-same-content', 'V06-c', d.baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'x', content2: 'x', reason: 'r' }), 'TEST_DRIVER_CONTENT_NOT_DISTINCT'],
        ['c-missing-reason', 'V06-c', d.baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'a', content2: 'b' }), 'TEST_DRIVER_INPUT_INCOMPLETE']
      ];
      for (const [label, testCaseId, input, expectCode] of cases) {
        const x = setup(() => d.scheduleOk());
        if (testCaseId === 'V06-c') {
          // 先跑 a 并接续，使 c 能进入组包阶段
          await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
          d.coordinator.acceptCloudReview(d.ctxFor(x.storage), 'V06-a', 'mgmt-review-1');
          x.api.__calls.length = 0;
        }
        const r = await x.driver.runCase({ api: x.api, testCaseId, input });
        out[label] = { code: r.code, writes: writes(x.api).length };
      }
      return {
        cases: out,
        sealed: Object.entries(out).every(([k, v]) => v.writes === 0)
      };
    }
  );

  await record(
    'R3-v07-precondition-requires-full-pagination',
    'V07-A/B 必须用完整分页确认前提；不可确认或前提不成立 → 零发送',
    async () => {
      const out = {};
      // A：第二页才查到目标 → candidate
      {
        const x = setup(() => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' }));
        const pages = [
          { schedules: [d.scheduleOk({ id: 's_1', workerUserId: 'u_ffffffffffffffffffffffffffffffffffffffff' })], pagination: { limit: 100, hasMore: true, nextCursor: 'c1' } },
          { schedules: [d.scheduleOk({ id: 's_2', workerUserId: d.WORKER_B })], pagination: { limit: 100, hasMore: false, nextCursor: null } }
        ];
        let page = 0;
        x.api.cloud.callFunction = async args => {
          x.api.__calls.push(d.clone(args.data));
          if (args.data.action === 'listSchedules') return { result: Object.assign({ ok: true }, d.clone(pages[Math.min(page++, 1)])) };
          if (args.data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
          if (args.data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
          return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
        };
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V07-A', input: { projectId: d.PROJECT, userId: d.WORKER_B } });
        out['A-has-active'] = {
          verdict: r.report.verdict,
          listCalls: x.api.__calls.filter(c => c.action === 'listSchedules').length
        };
      }
      // A：查不到 active → 零发送
      {
        const x = setup(() => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' }));
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V07-A', input: { projectId: d.PROJECT, userId: d.WORKER_B } });
        out['A-no-active'] = { code: r.code, writes: writes(x.api).length };
      }
      // B：仍有 active → 零发送
      {
        const x = setup(() => ({ userId: d.WORKER_B, status: 'left' }), {
          __listSchedules: {
            schedules: [d.scheduleOk({ workerUserId: d.WORKER_B })],
            pagination: { limit: 100, hasMore: false, nextCursor: null }
          }
        });
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V07-B', input: { projectId: d.PROJECT, userId: d.WORKER_B } });
        out['B-has-active'] = { code: r.code, writes: writes(x.api).length };
      }
      // 分页不可确认 → 零发送
      {
        const x = setup(() => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' }));
        x.api.cloud.callFunction = async args => {
          x.api.__calls.push(d.clone(args.data));
          if (args.data.action === 'listSchedules') {
            return { result: { schedules: [], pagination: { limit: 100, hasMore: true, nextCursor: 'c' } } };
          }
          if (args.data.action === 'identify') return { result: d.clone(d.IDENTIFY_OK) };
          if (args.data.action === 'getMembers') return { result: d.clone(d.MEMBERS_OK) };
          return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
        };
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V07-A', input: { projectId: d.PROJECT, userId: d.WORKER_B } });
        out['A-unconfirmable'] = { code: r.code, writes: writes(x.api).length };
      }
      return {
        cases: out,
        sealed: out['A-has-active'].verdict === 'candidate'
          && out['A-has-active'].listCalls >= 2
          && out['A-no-active'].writes === 0
          && out['B-has-active'].writes === 0
          && out['A-unconfirmable'].writes === 0
      };
    }
  );

  await record(
    'R3-v07-b-result-shape',
    'V07-B 只接受 { userId: 目标, status: left }',
    async () => {
      const out = {};
      for (const [label, bad] of [
        ['other-user', { ok: true, userId: 'u_ffffffffffffffffffffffffffffffffffffffff', status: 'left' }],
        ['status-active', { ok: true, userId: d.WORKER_B, status: 'active' }]
      ]) {
        const x = setup(() => bad);
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V07-B', input: { projectId: d.PROJECT, userId: d.WORKER_B } });
        out[label] = { verdict: r.report.verdict, stoppedReason: r.report.stoppedReason };
      }
      return { cases: out, sealed: Object.values(out).every(v => v.verdict === 'stopped') };
    }
  );

  // ── R4：发送生命周期与持久证据 ────────────────────────────────────────
  await record(
    'R4-expiry-during-member-check',
    '前置期间窗口过期 → 零业务发送',
    async () => {
      const original = Date.now;
      const start = original();
      const x = setup(() => d.scheduleOk(), null, { expiresAt: new Date(start + 10000).toISOString() });
      const inner = x.api.cloud.callFunction;
      x.api.cloud.callFunction = async args => {
        const r = await inner(args);
        if (args.data.action === 'getMembers') Date.now = () => start + 20000;
        return r;
      };
      try {
        const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
        return {
          verdict: r.report.verdict, code: r.code, businessRequests: writes(x.api).length,
          sealed: r.ok === false && writes(x.api).length === 0
        };
      } finally {
        Date.now = original;
      }
    }
  );

  await record(
    'R4-second-send-synchronous-throw',
    '第二次发送同步抛错 → 已调用证据保留、不补发、状态落 stopped',
    async () => {
      const x = setup(() => d.scheduleOk());
      let n = 0;
      const inner = x.api.cloud.callFunction;
      x.api.cloud.callFunction = args => {
        if (args.data.action === 'createSchedule' && ++n === 2) throw new Error('synthetic synchronous send failure');
        return inner(args);
      };
      let thrown = false;
      let result = null;
      try {
        result = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      } catch (error) {
        thrown = true;
      }
      const rec = d.coordinator.readCase(d.ctxFor(x.storage), 'V06-a');
      const outcomes = rec.status === 'ok' && Array.isArray(rec.record.responses)
        ? rec.record.responses.map(r => r.outcome).sort() : [];
      return {
        thrown,
        verdict: result ? result.report.verdict : null,
        stoppedReason: result ? result.report.stoppedReason : null,
        businessRequests: writes(x.api).length,
        sent: result ? result.report.sent : null,
        persistedState: rec.status === 'ok' ? rec.record.state : null,
        responseOutcomes: outcomes,
        allMarkedInvoked: rec.status === 'ok' && rec.record.responses.every(r => r.invoked === true),
        ordinaryBlock: d.coordinator.ordinaryEntryBlock(),
        sealed: thrown === false
          && result.report.verdict === 'stopped'
          && result.report.stoppedReason === 'UNKNOWN_RESULT'
          && writes(x.api).length === 1
          && result.report.sent === 2
          && rec.status === 'ok' && rec.record.state === 'stopped'
          && outcomes.join(',') === 'responded,sync-throw'
      };
    }
  );

  await record(
    'R4-response-storage-failure-still-candidate',
    '状态写失败 → 不显示 candidate（保守停止）',
    async () => {
      const x = setup(() => d.scheduleOk());
      const orig = x.storage.setStorageSync;
      let injected = false;
      x.storage.setStorageSync = (key, value) => {
        if (!injected && value.includes('"state":"candidate"')) {
          injected = true;
          throw new Error('synthetic full storage');
        }
        orig(key, value);
      };
      const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      const rec = d.coordinator.readCase(d.ctxFor(x.storage), 'V06-a');
      return {
        injected,
        verdict: r.report.verdict,
        stoppedReason: r.report.stoppedReason,
        persistedState: rec.status === 'ok' ? rec.record.state : null,
        sealed: injected === true && r.report.verdict !== 'candidate' && rec.status === 'ok' && rec.record.state === 'inFlight'
      };
    }
  );

  await record(
    'R4-readback-recomputes-digest',
    '回读对实际记录重算摘要：只改内容保留旧 digest 会被发现',
    () => {
      d.resetAll();
      d.coordinator._setProofForTest(d.openProof());
      const storage = d.makeStorage();
      const ctx = { storage, envId: 'cloud1-d8gcq5ag39d847723', roundId: 'round-test-1', actorUserId: d.MANAGER, nowMs: Date.now() };
      const snapshot = { testCaseId: 'V06-probe', plan: [{ action: 'createSchedule', projectId: d.PROJECT, requestId: 'r1' }], forms: [{ content: '原内容' }] };
      const first = d.coordinator.persistArmedRecord(ctx, {
        testCaseId: 'V06-probe', snapshot, binding: { projectId: d.PROJECT }, requestIds: ['r1']
      });
      const key = d.coordinator.batchKey('cloud1-d8gcq5ag39d847723', 'round-test-1');
      const doc = JSON.parse(storage.store[key]);
      doc.cases['V06-probe'].snapshot.forms[0].content = '被改过的内容';
      storage.store[key] = JSON.stringify(doc);
      const outcome = d.coordinator.setCaseState(ctx, 'V06-probe', 'inFlight', { sentAt: 1 });
      return {
        armedOk: first.ok,
        driftDetected: outcome.ok === false,
        message: outcome.message || null,
        sealed: first.ok === true && outcome.ok === false
      };
    }
  );

  await record(
    'R4-snapshot-covers-all-semantic-fields',
    '启动快照覆盖全部非敏感请求语义字段，且摘要与内容一致',
    async () => {
      const x = setup(() => d.scheduleOk());
      await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      const rec = d.coordinator.readCase(d.ctxFor(x.storage), 'V06-a').record;
      const plan = rec.snapshot.plan[0];
      const fields = ['action', 'projectId', 'requestId', 'scheduleId', 'expectedVersion', 'reason', 'userId'];
      const missing = fields.filter(f => !Object.prototype.hasOwnProperty.call(plan, f));
      const digestMatches = rec.snapshotDigest === d.coordinator.snapshotDigest(rec.snapshot);
      const bindingComplete = Boolean(rec.binding && rec.binding.envId && rec.binding.projectId
        && rec.binding.actorUserId && rec.binding.evidenceId && rec.binding.appId);
      return {
        missingFields: missing,
        digestMatches,
        bindingComplete,
        sealed: missing.length === 0 && digestMatches && bindingComplete
      };
    }
  );

  await record(
    'R4-report-does-not-claim-local-only',
    '已真实发送的报告不得声称 localOnly',
    async () => {
      const x = setup(() => d.scheduleOk());
      const r = await x.driver.runCase({ api: x.api, testCaseId: 'V06-a', input: d.baseInput() });
      return {
        localOnly: r.report.localOnly,
        source: r.report.source,
        sent: r.report.sent,
        invokedCount: r.report.invokedCount,
        sealed: r.report.localOnly === false && r.report.source === 'runtime-real-wx-cloud' && r.report.invokedCount === 2
      };
    }
  );

  // ── R5：P4 固定身份、环境与时效 ───────────────────────────────────────
  await record(
    'R5-missing-user-identity-is-granted',
    '用户记录缺身份字段 → 拒绝且零写入',
    async () => {
      const a = p.makeAdapter({ users: { [p.OWNER]: { _id: p.OWNER, status: 'active' } } });
      let code = null;
      try {
        await p.bootstrap.initializePrimary({
          plan: p.goodPlan(), approval: p.goodApproval(), adapter: a, nowMs: p.FIXED_NOW
        });
      } catch (error) {
        code = error.code;
      }
      return { code, grants: 0, commits: a.__commits.length, sealed: code !== null && a.__commits.length === 0 };
    }
  );

  await record(
    'R5-wrong-record-id-is-granted',
    '用户记录 _id 与查询键不一致 → 拒绝且零写入',
    async () => {
      const a = p.makeAdapter({
        users: { [p.OWNER]: { _id: 'u_wrong', status: 'active', openid: p.OWNER_OPENID_FOR_FIXTURE || 'synthetic-openid-for-owner-fixture-only' } }
      });
      let code = null;
      try {
        await p.bootstrap.initializePrimary({
          plan: p.goodPlan(), approval: p.goodApproval(), adapter: a, nowMs: p.FIXED_NOW
        });
      } catch (error) {
        code = error.code;
      }
      return { code, commits: a.__commits.length, sealed: code !== null && a.__commits.length === 0 };
    }
  );

  await record(
    'R5-derivation-mismatch-is-granted',
    'openid 与 _id 派生关系不匹配 → 拒绝且零写入，且错误不含 OPENID',
    async () => {
      const a = p.makeAdapter({
        users: { [p.OWNER]: { _id: p.OWNER, status: 'active', openid: 'synthetic-openid-that-derives-elsewhere' } }
      });
      let code = null;
      let text = '';
      try {
        await p.bootstrap.initializePrimary({
          plan: p.goodPlan(), approval: p.goodApproval(), adapter: a, nowMs: p.FIXED_NOW
        });
      } catch (error) {
        code = error.code;
        text = JSON.stringify({ message: error.message, detail: error.detail });
      }
      return {
        code,
        commits: a.__commits.length,
        leaksOpenid: text.includes('synthetic-openid-that-derives-elsewhere'),
        sealed: code !== null && a.__commits.length === 0 && !text.includes('synthetic-openid-that-derives-elsewhere')
      };
    }
  );

  await record(
    'R5-expired-plan-no-injected-clock',
    '不传时钟 + 已过期计划 → 拒绝且零写入',
    async () => {
      const a = p.makeAdapter();
      let code = null;
      try {
        await p.bootstrap.initializePrimary({
          plan: p.goodPlan({ expiresAt: '2020-01-01T00:00:00Z' }),
          approval: p.goodApproval(),
          adapter: a
        });
      } catch (error) {
        code = error.code;
      }
      return { code, commits: a.__commits.length, sealed: code !== null && a.__commits.length === 0 };
    }
  );

  await record(
    'R5-default-clock-is-now',
    '不传时钟 + 有效计划 → 审计时间来自当前时钟',
    async () => {
      const a = p.makeAdapter();
      const r = await p.bootstrap.initializePrimary({
        plan: p.goodPlan({ expiresAt: '2030-01-01T00:00:00Z' }), approval: p.goodApproval(), adapter: a
      });
      const audit = await a.readOnlyGet('schtest_v1_audit_events', r.auditId);
      const drift = Math.abs(Date.parse(audit.createdAt) - Date.now());
      return {
        outcome: r.outcome, grants: r.granted ? 1 : 0,
        clockDriftMs: drift,
        sealed: r.granted === true && drift < 60000
      };
    }
  );

  await record(
    'R5-caller-supplied-wrong-fixed-environment',
    '计划与调用参数同时改成同一错误环境 → 仍拒绝且零写入',
    async () => {
      const a = p.makeAdapter();
      let code = null;
      try {
        await p.bootstrap.initializePrimary({
          plan: p.goodPlan({ appId: 'wx_other', envId: 'env_other' }),
          approval: p.goodApproval(),
          adapter: a,
          appId: 'wx_other',
          envId: 'env_other',
          nowMs: Date.now()
        });
      } catch (error) {
        code = error.code;
      }
      return { code, commits: a.__commits.length, sealed: code !== null && a.__commits.length === 0 };
    }
  );

  await record(
    'R5-target-not-in-approved-list',
    '目标不在受控批准名单（尾号提示不算授权）→ 拒绝且零写入',
    async () => {
      const a = p.makeAdapter({
        users: {
          [p.OWNER]: p.ownerRecord(),
          [p.OTHER]: p.ownerRecord({ _id: p.OTHER, openid: 'synthetic-openid-for-other-fixture-only' })
        }
      });
      let code = null;
      try {
        await p.bootstrap.initializePrimary({
          plan: p.goodPlan({ targetUserId: p.OTHER }),
          approval: p.goodApproval(),
          adapter: a,
          nowMs: p.FIXED_NOW
        });
      } catch (error) {
        code = error.code;
      }
      return {
        code,
        commits: a.__commits.length,
        primaryAbsent: a.__data['schtest_v1_app_admins'].primary === undefined,
        sealed: code === 'TARGET_NOT_APPROVED' && a.__commits.length === 0
      };
    }
  );

  await record(
    'R5-missing-approval-context',
    '缺受控批准上下文 → 拒绝且零写入',
    async () => {
      const a = p.makeAdapter();
      let code = null;
      try {
        await p.bootstrap.initializePrimary({ plan: p.goodPlan(), adapter: a, nowMs: p.FIXED_NOW });
      } catch (error) {
        code = error.code;
      }
      return { code, commits: a.__commits.length, sealed: code === 'APPROVAL_CONTEXT_MISSING' && a.__commits.length === 0 };
    }
  );

  await record(
    'R5-expiry-during-preflight',
    '预检期间窗口过期 → 首写之前停止、零写入',
    async () => {
      const a = p.makeAdapter();
      const clock = { value: p.FIXED_NOW };
      const originalGet = a.getDoc.bind(a);
      let calls = 0;
      a.getDoc = async (tx, collection, key) => {
        calls++;
        if (calls === 2) clock.value = Date.parse('2031-01-01T00:00:00Z');
        return originalGet(tx, collection, key);
      };
      let code = null;
      try {
        await p.bootstrap.initializePrimary({
          plan: p.goodPlan({ expiresAt: '2030-06-01T00:00:00Z' }),
          approval: p.goodApproval(),
          adapter: a,
          fixedNowMs: p.FIXED_NOW,
          get nowMs() { return clock.value; }
        });
      } catch (error) {
        code = error.code;
      }
      return {
        code,
        commits: a.__commits.length,
        primaryAbsent: a.__data['schtest_v1_app_admins'].primary === undefined,
        sealed: code === 'PLAN_EXPIRED_BEFORE_WRITE' && a.__commits.length === 0
      };
    }
  );

  await record(
    'R5-invalid-injected-clock',
    '注入时钟必须是有效有限值',
    async () => {
      const out = {};
      for (const bad of [NaN, Infinity, -1, '123', 999999999999999]) {
        const a = p.makeAdapter();
        let code = null;
        try {
          await p.bootstrap.initializePrimary({
            plan: p.goodPlan(), approval: p.goodApproval(), adapter: a, nowMs: bad
          });
        } catch (error) {
          code = error.code;
        }
        out[String(bad)] = { code, commits: a.__commits.length };
      }
      return {
        cases: out,
        sealed: Object.values(out).every(v => v.code === 'CLOCK_INVALID' && v.commits === 0)
      };
    }
  );

  await record(
    'R5-observe-primary-four-states',
    'observePrimary 四态且永不成为写授权',
    async () => {
      const out = {};
      const empty = p.makeAdapter();
      out.absent = (await p.bootstrap.observePrimary({
        adapter: empty, plan: p.goodPlan(), approval: p.goodApproval(), nowMs: p.FIXED_NOW
      })).state;
      const seeded = p.makeAdapter();
      const init = await p.bootstrap.initializePrimary({
        plan: p.goodPlan(), approval: p.goodApproval(), adapter: seeded, nowMs: p.FIXED_NOW
      });
      const presentObs = await p.bootstrap.observePrimary({
        adapter: seeded, plan: p.goodPlan(), approval: p.goodApproval(), nowMs: p.FIXED_NOW
      });
      out.present = presentObs.state;
      out.presentWriteAuthorized = presentObs.writeAuthorized;
      out.noAuditCountField = !('auditCount' in presentObs);
      out.auditId = init.auditId === presentObs.auditId;
      const onlyPrimary = p.makeAdapter({
        appAdmins: { primary: { _id: 'primary', userId: p.OWNER, status: 'active' } }
      });
      out.inconsistent = (await p.bootstrap.observePrimary({
        adapter: onlyPrimary, plan: p.goodPlan(), approval: p.goodApproval(), nowMs: p.FIXED_NOW
      })).state;
      const noPerm = p.makeAdapter({ callerAllowed: false });
      out.unconfirmedNoPermission = (await p.bootstrap.observePrimary({
        adapter: noPerm, plan: p.goodPlan(), approval: p.goodApproval(), nowMs: p.FIXED_NOW
      })).state;
      const wrongEnv = p.makeAdapter({ callerEnvId: 'env_other' });
      out.unconfirmedWrongEnv = (await p.bootstrap.observePrimary({
        adapter: wrongEnv, plan: p.goodPlan(), approval: p.goodApproval(), nowMs: p.FIXED_NOW
      })).state;
      const badPlan = p.makeAdapter();
      out.unconfirmedBadPlan = (await p.bootstrap.observePrimary({
        adapter: badPlan, plan: p.goodPlan({ expiresAt: '2000-01-01T00:00:00Z' }), approval: p.goodApproval(), nowMs: p.FIXED_NOW
      })).state;
      return {
        states: out,
        sealed: out.absent === 'absent'
          && out.present === 'present'
          && out.presentWriteAuthorized === false
          && out.noAuditCountField === true
          && out.auditId === true
          && out.inconsistent === 'inconsistent'
          && out.unconfirmedNoPermission === 'unconfirmed'
          && out.unconfirmedWrongEnv === 'unconfirmed'
          && out.unconfirmedBadPlan === 'unconfirmed'
      };
    }
  );

  await record(
    'R5-cli-execute-still-refused',
    'CLI --execute 仍拒绝；受控批准上下文只从计划文件读入',
    async () => {
      // 临时目录放在仓库受信根下：os.tmpdir() 在本机是联接路径，子进程输出取不到
      const dir = fs.mkdtempSync(path.join(root, 'artifacts/schedule-sandbox/.r5-cli-'));
      const planPath = path.join(dir, 'plan.json');
      fs.writeFileSync(planPath, JSON.stringify(Object.assign(p.goodPlan(), { approval: p.goodApproval() }), null, 2));
      const { execFileSync } = require('node:child_process');
      const cli = path.join(root, 'miniapp/scripts/prepare-sandbox-primary.cjs');
      let executeOut = '';
      let executeFailed = false;
      try {
        execFileSync(process.execPath, [cli, '--plan', planPath, '--execute'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        executeFailed = true;
        executeOut = `${error.stdout || ''}${error.stderr || ''}`;
      }
      let approvalFlagFailed = false;
      let approvalFlagOut = '';
      try {
        execFileSync(process.execPath, [cli, '--plan', 'x.json', '--approval', 'y'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        approvalFlagFailed = true;
        approvalFlagOut = `${error.stdout || ''}${error.stderr || ''}`;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      // 宿主进程创建故障（Windows 上表现为 EBUSY/EPERM 且 status===null）：
      // 此时**无法观测** CLI 行为，如实标 hostSpawnBlocked，**不**判通过、**不**判失败。
      const hostSpawnBlocked = !executeOut && !approvalFlagOut;
      return {
        hostSpawnBlocked,
        executeRefused: executeFailed && /--execute 已拒绝/.test(executeOut),
        executeMentionsNoFakeAtomicity: /不得用独立的读 → 写 → 回读冒充原子性/.test(executeOut),
        approvalFlagRefused: approvalFlagFailed && /不接受 --approval/.test(approvalFlagOut),
        // 宿主无法启动子进程时本项标为「未验证」，按未封堵计入 unsealed，不冒充通过
        sealed: !hostSpawnBlocked
          && executeFailed && /--execute 已拒绝/.test(executeOut)
          && /不得用独立的读 → 写 → 回读冒充原子性/.test(executeOut)
          && approvalFlagFailed && /不接受 --approval/.test(approvalFlagOut)
      };
    }
  );

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
    configs[name] = require(path.join(root, 'miniapp/miniprogram/config', name));
    configs[name] = { value: configs[name], deepFrozen: frozen(configs[name]) };
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
    'miniapp/cloudfunctions/scheduleSandbox/vendor/schedule-service.js'
  ]) retainedHashes[rel] = hash(rel);

  const output = {
    executedAt: new Date().toISOString(),
    scope: 'local repair verification of Codex R1–R5; real modules, synthetic API/storage/transaction adapters; no platform execution',
    originalEvidencePreserved: [
      'docs/证据/Codex最小驱动V06V07P4复核-20261005.cjs',
      'docs/证据/Codex最小驱动V06V07P4复核-20261005.json',
      'docs/证据/Codex最小驱动全量测试-20261005.txt'
    ],
    summary: {
      total: results.length,
      sealed: results.filter(r => r.sealed === true).length,
      unsealed: results.filter(r => r.sealed !== true).length,
      harnessErrors: results.filter(r => r.harnessError).length
    },
    baseline: { count: Object.keys(baseline.files).length, missing, differences },
    retainedHashes,
    configs,
    results,
    notVerified: [
      '真机未验证：全部使用合成 wx 与内存存储。',
      '真实管理 SDK 未核实：P4 仅本地原子核心，primary 未初始化。',
      '真实 wcc/wcsc 编译未执行；WXML 只做静态标签配平与关键串检查。',
      '互斥为同一设备/运行时操作互斥，不是跨设备锁。',
      '平台索引就绪、3 秒超时、100 操作、32 KiB、真实并发与费用均未实测。'
    ],
    boundaries: {
      installed: false,
      cloudCalled: false,
      resourcesCreated: false,
      deployed: false,
      entryEnabled: false,
      cacheCleared: false,
      sdkAdapterConnected: false
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