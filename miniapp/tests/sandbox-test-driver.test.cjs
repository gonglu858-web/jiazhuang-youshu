// 专用测试驱动（V06 三对并发 / V07 两次移出）的离线行为测试。
//
// 依据：任务文档 §8「驱动与页面」与 Codex 复核 R1–R4 定点返修。
//
// 重要边界：本文件用**合成 wx** 与内存存储，**不是真机**；
// 运行载体仍是真实小程序页面的 wx.cloud.callFunction + 服务端 getWXContext。
// 这里验证的是门控、双向互斥、固定目标、真实用例前提、响应形状核验与
// 未知即停机并留证的**控制流**。
//
// 保留导出的夹具工厂名（loadDriver / openProof / baseInput / makeStorage /
// makeApi / resetAll / ctxFor / coordinator / IDENTIFY_OK / MEMBERS_OK /
// MANAGER / WORKER_B / PROJECT），Codex 的独立复核脚本依赖这些名字。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const MINIPROGRAM = path.join(__dirname, '..', 'miniprogram');
const nativeRequire = createRequire(path.join(MINIPROGRAM, 'utils/schedule-sandbox-client.js'));

const proof = require('../miniprogram/config/sandbox-test-driver-proof');
const coordinator = require('../miniprogram/utils/sandbox-test-coordinator');
const clientModule = require('../miniprogram/utils/schedule-sandbox-client');
const sandboxProof = require('../miniprogram/config/schedule-sandbox-proof');

const APPID = 'wxfb4db1615ac15531';
const ENV_ID = 'cloud1-d8gcq5ag39d847723';
const MANAGER = 'u_0123456789abcdef0123456789abcdef01234567';
const WORKER_B = 'u_89abcdef0123456789abcdef0123456789abcdef';
const PROJECT = 'p_sbx_fixed_target';
const PAGE_PATH = path.join(MINIPROGRAM, 'pages/schedule-sandbox/schedule-sandbox.js');

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function makeStorage(initial) {
  const store = Object.assign({}, initial || {});
  return {
    store,
    getStorageSync: key => (store[key] === undefined ? '' : store[key]),
    setStorageSync: (key, value) => { store[key] = value; },
    removeStorageSync: key => { delete store[key]; },
    getStorageInfoSync: () => ({ keys: Object.keys(store) })
  };
}

/**
 * 合成 wx：可编排 callFunction 的响应与时序。
 * handler(data, callIndex) 必须返回 result；抛错表示同步抛错或网络失败。
 */
function makeApi(options) {
  const storage = options.storage;
  const calls = [];
  let failNext = 0;
  let hangNext = 0;
  const api = {
    storage,
    getStorageInfoSync: storage.getStorageInfoSync,
    getAccountInfoSync: () => ({
      miniProgram: {
        appId: options.appId === undefined ? APPID : options.appId,
        // 官方 MiniProgram 契约：appId / envVersion / version，**没有 envId**。
        // 不再伪造 envId；云环境由固定 proof 与每次 callFunction.config.env 保证。
        envVersion: options.envVersion === undefined ? 'develop' : options.envVersion,
        version: options.version === undefined ? '1.0.0' : options.version
      }
    }),
    cloud: {
      async callFunction(args) {
        calls.push(clone(args.data));
        if (hangNext > 0) { hangNext--; return new Promise(() => {}); }
        if (failNext > 0) { failNext--; throw new Error('network down'); }
        if (typeof options.handler === 'function') return options.handler(args.data, calls.length);
        return { result: { ok: true } };
      }
    },
    // 测试控制
    __calls: calls,
    __failNext: n => { failNext = n; },
    __hangNext: n => { hangNext = n; }
  };
  return api;
}

/** 在 vm 中加载驱动，注入可配置的 proof（默认沿用磁盘上的关闭配置）。 */
function loadDriver(proofOverride) {
  const drvProof = proofOverride || proof;
  // 协调器也读同一份证明配置：整体替换，避免协调器仍读磁盘上的关闭配置
  coordinator._setProofForTest(drvProof);
  const src = fs.readFileSync(path.join(MINIPROGRAM, 'utils/sandbox-test-driver.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${src}\n})`)(
    name => {
      if (name.includes('sandbox-test-driver-proof')) return drvProof;
      if (name.includes('config/schedule-sandbox-proof')) {
        return { ...sandboxProof, enabled: true, roundId: drvProof.roundId, sandboxProjectId: drvProof.projectId };
      }
      if (name.includes('sandbox-test-coordinator')) return coordinator;
      return nativeRequire(name);
    },
    mod, mod.exports
  );
  return mod.exports;
}

/** 构造一份开启且完整的驱动配置副本（不改磁盘配置）。 */
function openProof(overrides) {
  return {
    ...proof,
    enabled: true,
    roundId: 'round-test-1',
    projectId: PROJECT,
    actorUserId: MANAGER,
    expiresAt: '2030-01-01T00:00:00Z',
    evidenceId: 'ev-test-1',
    v07TargetUserId: WORKER_B,
    ...overrides
  };
}

/** 固定计划输入（V06-a/b 用一个新空闲日；c 由驱动真实读取当前安排）。 */
function baseInput(extra) {
  return Object.assign({
    projectId: PROJECT,
    actorUserId: MANAGER,
    stage: '拆改',
    trade: '拆改',
    workerUserId: WORKER_B,
    startDate: '2026-11-02',
    endDate: '2026-11-03',
    expectedDate: '2026-11-03',
    restDays: [],
    content: '并发验证内容',
    requestId1: 'r-a-1',
    requestId2: 'r-a-2'
  }, extra || {});
}

function ctxFor(storage) {
  return { storage, envId: ENV_ID, roundId: 'round-test-1', actorUserId: MANAGER, nowMs: Date.now() };
}

/** 每个用例前复位模块级占用、配置引用与存储。 */
function resetAll(storage) {
  coordinator._resetRuntimeHoldForTest();
  coordinator._setProofForTest(proof);
  if (storage) for (const k of Object.keys(storage.store)) delete storage.store[k];
}

/** publicSchedule 形态的成功返回（字段是 `id`，不是 scheduleId）。 */
function scheduleOk(overrides) {
  return Object.assign({
    ok: true,
    sandbox: true,
    id: 's_review01',
    projectId: PROJECT,
    stage: '拆改',
    trade: '拆改',
    workerUserId: WORKER_B,
    startDate: '2026-11-02',
    endDate: '2026-11-03',
    expectedDate: '2026-11-03',
    restDays: [],
    content: '并发验证内容',
    status: 'active',
    version: 1
  }, overrides || {});
}

const IDENTIFY_OK = { ok: true, sandbox: true, userId: MANAGER };
const MEMBERS_OK = {
  ok: true,
  project: { id: PROJECT, name: '虚构测试项目', roles: ['管家'], status: 'active', scope: 'identity-test' },
  members: [
    { id: 'm_a', userId: MANAGER, label: '成员 123456', roles: ['管家'], trades: ['拆改'], joinedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'm_b', userId: WORKER_B, label: '成员 89abcd', roles: ['师傅'], trades: ['拆改'], joinedAt: '2026-01-01T00:00:00.000Z' }
  ]
};

/** 默认 handler：identify / getMembers 正常，业务动作按 respond 给。 */
function defaultHandler(respond, extra) {
  const table = extra || {};
  return async data => {
    if (data.action === 'listSchedules') {
      // 真实 service 契约：index.js 统一包 { ok:true, sandbox:true, ...result }，
      // 因此 listSchedules 的成功结果**必须**带 ok:true（S4 起强制核对）。
      return { result: Object.assign({ ok: true, sandbox: true }, table.__listSchedules || { schedules: [], pagination: { limit: 100, hasMore: false, nextCursor: null } }) };
    }
    if (data.action === 'getSchedule') {
      return { result: Object.assign({ ok: true, sandbox: true }, table.__getSchedule || { schedule: scheduleOk({ version: 1 }) }) };
    }
    if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
    if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
    return { result: clone(respond(data, 0)) };
  };
}

const writes = api => api.__calls.filter(x => ['createSchedule', 'updateSchedule', 'removeMember'].includes(x.action));

/** 在 vm 中加载真实 Page（注入驱动与协调器替身）。 */
function loadPage(api, driver, drvProof) {
  let page;
  const p = drvProof || openProof();
  vm.runInThisContext(`(function(require,Page,wx){${fs.readFileSync(PAGE_PATH, 'utf8')}\n})`, { filename: PAGE_PATH })(
    name => {
      if (name.includes('sandbox-test-driver-proof')) return p;
      if (name.includes('sandbox-test-coordinator')) return coordinator;
      if (name.includes('utils/sandbox-test-driver')) return driver;
      if (name.includes('schedule-sandbox-client')) return clientModule;
      if (name.includes('config/schedule-sandbox-proof')) {
        return { ...sandboxProof, enabled: true, roundId: p.roundId, sandboxProjectId: p.projectId };
      }
      return nativeRequire(name);
    },
    definition => { page = definition; },
    api
  );
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function setData(patch) { Object.assign(this.data, patch); };
  return page;
}

/** 合成 API 缺 getStorageInfoSync 时如实暴露（不伪造枚举能力）。 */
function apiWithoutEnumeration(storage, options) {
  const api = makeApi(Object.assign({ storage }, options || {}));
  delete api.getStorageInfoSync;
  return api;
}

// ── 配置模板 ──────────────────────────────────────────────────────────────

test('D1 配置默认关闭、动态值全空、嵌套冻结', () => {
  assert.equal(proof.enabled, false, '驱动默认必须关闭');
  for (const field of ['roundId', 'projectId', 'actorUserId', 'expiresAt', 'evidenceId', 'v07TargetUserId']) {
    assert.equal(proof[field], '', `${field} 必须默认为空`);
  }
  assert.equal(proof.appId, APPID);
  assert.equal(proof.envId, ENV_ID);
  assert.equal(proof.functionName, 'scheduleSandbox');
  assert.deepEqual([...proof.allowedVersions], ['develop', 'trial']);
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(Object.isFrozen(proof.v06Cases), true);
  assert.equal(Object.isFrozen(proof.v06Cases[0]), true);
  assert.equal(Object.isFrozen(proof.v06Cases[0].expect), true);
});

test('D2 固定用例齐备且不含预填真实值', () => {
  assert.deepEqual(proof.testCases.map(c => c.testCaseId), ['V06-a', 'V06-b', 'V06-c', 'V07-A', 'V07-B']);
  const raw = JSON.stringify(proof.v06Cases) + JSON.stringify(proof.v07Cases);
  assert.equal(/u_[0-9a-f]{40}/.test(raw), false, '计划不得预填完整 userId');
  assert.equal(/p_[0-9a-f]{32}/.test(raw), false, '计划不得预填项目 ID');
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(raw), false, '计划不得预填日期');
  assert.equal(proof.v07Cases.every(c => c.idempotent === false), true, '移出没有服务端幂等');
  assert.equal(proof.v06Cases[2].dependsOn, 'V06-a', 'V06-c 依赖 a 的结果');
});

test('D3 尾号只作提示，不作授权判断依据', () => {
  assert.equal(proof.actorHint, '64193d');
  assert.equal(proof.v07TargetHint, 'f182f4');
  assert.equal(/userId:\s*'64193d'/.test(JSON.stringify(proof)), false);
});

// ── 门控（R2：实际 AppID 与固定值比对）─────────────────────────────────

test('D4 门控：驱动未启用 → 零请求', () => {
  const drv = loadDriver(proof);
  const storage = makeStorage();
  const api = makeApi({ storage, handler: async () => { throw new Error('不应发请求'); } });
  const g = drv.gate({ api });
  assert.equal(g.ok, false);
  assert.ok(g.reasons.some(r => r.includes('驱动未启用')));
  assert.equal(api.__calls.length, 0, '门控失败必须零请求');
});

test('D5 门控：副本入口未启用 → 零请求（双开关必须同时成立）', () => {
  const storage = makeStorage();
  const api = makeApi({ storage, handler: async () => { throw new Error('不应发请求'); } });
  const closedSandbox = { ...sandboxProof, enabled: false };
  const src = fs.readFileSync(path.join(MINIPROGRAM, 'utils/sandbox-test-driver.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${src}\n})`)(
    name => {
      if (name.includes('sandbox-test-driver-proof')) return openProof();
      if (name.includes('config/schedule-sandbox-proof')) return closedSandbox;
      if (name.includes('sandbox-test-coordinator')) return coordinator;
      return nativeRequire(name);
    }, mod, mod.exports);
  const g = mod.exports.gate({ api });
  assert.equal(g.ok, false);
  assert.ok(g.reasons.some(r => r.includes('副本入口未启用')));
  assert.equal(api.__calls.length, 0);
});

test('D6 门控：release / 未知版本 / 空版本 → 零请求', () => {
  const drv = loadDriver(openProof());
  for (const envVersion of ['release', 'unknown', '']) {
    const storage = makeStorage();
    const api = makeApi({ storage, envVersion, handler: async () => { throw new Error('不应发请求'); } });
    const g = drv.gate({ api });
    assert.equal(g.ok, false, `版本 ${envVersion} 必须被拒`);
    assert.equal(api.__calls.length, 0);
  }
});

test('D7 门控：受保护 A/B/C 项目 → 零请求', async () => {
  for (const bad of proof.protectedProjectIds) {
    resetAll();
    const drv = loadDriver(openProof({ projectId: bad }));
    const storage = makeStorage();
    const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.equal(result.ok, false);
    assert.equal(api.__calls.length, 0, `${bad} 必须零请求`);
  }
});

test('D8 门控：窗口过期 → 零请求', async () => {
  resetAll();
  const drv = loadDriver(openProof({ expiresAt: '2000-01-01T00:00:00Z' }));
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_PREFLIGHT_BLOCKED');
  assert.equal(api.__calls.length, 0);
});

test('D9 门控：缺 v07TargetUserId → 零请求（R2 不得靠空值跳过）', async () => {
  resetAll();
  const drv = loadDriver(openProof({ v07TargetUserId: '' }));
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' })) });
  const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: '' } });
  assert.equal(result.ok, false);
  assert.equal(api.__calls.length, 0, '缺固定目标必须零请求');
});

// ── R2：固定目标与运行门控落到发出的请求 ────────────────────────────────

test('R2-1 实际运行 AppID 与固定值不符 → 零请求', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({
    storage,
    appId: 'wx_wrong_runtime',
    handler: defaultHandler(() => scheduleOk())
  });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_GATE_BLOCKED');
  assert.ok(result.report.gateReasons.some(r => r.includes('AppID')));
  assert.equal(api.__calls.length, 0, '错 AppID 必须零请求（含 identify/getMembers）');
});

test('R2-2 运行环境未返回 AppID → 零请求（空值不得跳过比较）', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, appId: '', handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(api.__calls.length, 0);
});

test('R2-3 配置环境不符固定值 → 零请求（S1：云环境由 proof + config.env 保证）', async () => {
  resetAll();
  // 官方 MiniProgram 不提供 envId，因此「环境错误」只可能来自配置或调用参数。
  // 这里让两份 proof 的 envId 同时偏离固定值 —— 必须被 gate 拦下。
  const badProof = openProof({ envId: 'cloud_other' });
  const src = fs.readFileSync(path.join(MINIPROGRAM, 'utils/sandbox-test-driver.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${src}\n})`)(
    name => {
      if (name.includes('sandbox-test-driver-proof')) return badProof;
      if (name.includes('config/schedule-sandbox-proof')) {
        return { ...sandboxProof, enabled: true, roundId: badProof.roundId, sandboxProjectId: badProof.projectId, envId: 'cloud_other' };
      }
      if (name.includes('sandbox-test-coordinator')) return coordinator;
      return nativeRequire(name);
    }, mod, mod.exports);
  coordinator._setProofForTest(badProof);
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await mod.exports.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.ok(result.report.gateReasons.some(r => r.includes('环境')), JSON.stringify(result.report.gateReasons));
  assert.equal(api.__calls.length, 0, '环境不符必须零请求');
});

test('R2-3b 运行时若额外声明了不一致的 envId → 零请求', () => {
  // 某些非官方宿主可能额外提供 envId；一旦提供就必须与固定值一致
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const base = api.getAccountInfoSync();
  api.getAccountInfoSync = () => ({ miniProgram: Object.assign({}, base.miniProgram, { envId: 'cloud_other' }) });
  const g = drv.gate({ api });
  assert.equal(g.ok, false);
  assert.ok(g.reasons.some(r => r.includes('云环境')));
  assert.equal(api.__calls.length, 0);
});

test('R2-4 输入项目与固定目标不符（含受保护 A/B/C）→ 首次请求前拒绝', async () => {
  for (const bad of ['p_other_target', ...proof.protectedProjectIds]) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput({ projectId: bad }) });
    assert.equal(result.ok, false, `${bad} 必须被拒`);
    assert.equal(result.code, 'TEST_DRIVER_TARGET_MISMATCH');
    assert.equal(api.__calls.length, 0, `${bad} 必须在任何请求之前拒绝`);
  }
});

test('R2-5 V07 目标与固定目标不符 → 零发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: defaultHandler(() => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' }), {
      __listSchedules: {
        schedules: [scheduleOk({ id: 's_x', workerUserId: WORKER_B })],
        pagination: { limit: 100, hasMore: false, nextCursor: null }
      }
    })
  });
  const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: MANAGER } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_V07_TARGET_INVALID');
  assert.equal(writes(api).length, 0, '错目标不得发出移出请求');
});

test('R2-6 V07 目标是执行人本人 → 零发送', async () => {
  resetAll();
  const drv = loadDriver(openProof({ v07TargetUserId: MANAGER }));
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: defaultHandler(() => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' }), {
      __listSchedules: {
        schedules: [scheduleOk({ id: 's_x', workerUserId: MANAGER })],
        pagination: { limit: 100, hasMore: false, nextCursor: null }
      }
    })
  });
  const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: MANAGER } });
  assert.equal(result.ok, false);
  assert.equal(writes(api).length, 0, '自移出必须零发送');
});

test('R2-7 V07 目标是受保护角色（管家/负责人/主业主）→ 零发送', async () => {
  for (const role of ['管家', '负责人', '主业主']) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const members = {
      ok: true,
      members: [
        { userId: MANAGER, roles: ['管家'], trades: [] },
        { userId: WORKER_B, roles: [role], trades: ['拆改'] }
      ]
    };
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(members) };
        if (data.action === 'listSchedules') {
          return { result: { ok: true, schedules: [scheduleOk({ workerUserId: WORKER_B })], pagination: { limit: 100, hasMore: false, nextCursor: null } } };
        }
        return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
      }
    });
    const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: WORKER_B } });
    assert.equal(result.ok, false, `${role} 必须被拒`);
    assert.equal(result.code, 'TEST_DRIVER_V07_TARGET_INVALID');
    assert.equal(writes(api).length, 0, `${role} 必须零发送`);
  }
});

test('R2-8 V07 目标不在公开成员列表 → 零发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: { ok: true, members: [{ userId: MANAGER, roles: ['管家'], trades: [] }] } };
      return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
    }
  });
  const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: WORKER_B } });
  assert.equal(result.ok, false);
  assert.equal(writes(api).length, 0);
});

test('R2-9 V07 目标角色不是师傅 → 零发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') {
        return { result: { ok: true, members: [{ userId: MANAGER, roles: ['管家'], trades: [] }, { userId: WORKER_B, roles: ['设计师'], trades: [] }] } };
      }
      return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
    }
  });
  const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: WORKER_B } });
  assert.equal(result.ok, false);
  assert.equal(writes(api).length, 0);
});

// ── R3：真实用例前提与响应形状 ─────────────────────────────────────────

test('R3-1 日期确认不被自动授予：expectedDate ≠ endDate → 零业务发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({
    api, testCaseId: 'V06-a',
    input: baseInput({ expectedDate: '2026-11-05' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_DATE_NOT_CONFIRMED');
  assert.equal(api.__calls.length, 0, '日期不一致必须零请求（连 identify 都不发）');
});

test('R3-2 V06-b 两个请求号相同 → 零发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({
    api, testCaseId: 'V06-b',
    input: baseInput({ requestId1: 'same', requestId2: 'same' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_REQUEST_ID_NOT_DISTINCT');
  assert.equal(api.__calls.length, 0);
});

test('R3-3 非标成功形状（缺 id / 版本非正整数 / 对象型字段参与比较 / 非标状态）→ stopped', () => {
  const drv = loadDriver(openProof());
  const judged = [
    drv.judgeV06({ expect: { bothOk: true, compareFields: ['id', 'version', 'status'] } },
      { ok: true, version: 1, status: 'active' }, { ok: true, version: 1, status: 'active' }),
    drv.judgeV06({ expect: { bothOk: true, compareFields: ['id', 'version', 'status'] } },
      { ok: true, id: 's_1', version: 0, status: 'active' }, { ok: true, id: 's_1', version: 0, status: 'active' }),
    drv.judgeV06({ expect: { bothOk: true, compareFields: ['restDays', 'version'] } },
      { ok: true, id: 's_1', restDays: [], version: 1, status: 'active' },
      { ok: true, id: 's_1', restDays: [], version: 1, status: 'active' }),
    drv.judgeV06({ expect: { bothOk: true, compareFields: ['id', 'version', 'status'] } },
      { ok: true, id: 's_1', version: 1, status: 'done' }, { ok: true, id: 's_1', version: 1, status: 'done' })
  ];
  for (const j of judged) {
    assert.equal(j.verdict, 'stopped', JSON.stringify(j));
  }
});

test('R3-4 V06-a 两份成功但版本不是 1 → stopped', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  let n = 0;
  const api = makeApi({
    storage,
    handler: defaultHandler(() => (++n === 1 ? scheduleOk({ version: 2 }) : scheduleOk({ version: 2 })))
  });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(result.report.stoppedReason, 'VERSION_NOT_ONE');
});

test('R3-5 成功响应的目标不符（projectId / workerUserId / status）→ stopped', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  for (const bad of [
    scheduleOk({ projectId: 'p_other' }),
    scheduleOk({ workerUserId: 'u_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    scheduleOk({ status: 'cancelled' })
  ]) {
    const storage = makeStorage();
    let n = 0;
    const api = makeApi({
      storage,
      handler: defaultHandler(() => (++n === 1 ? bad : { ok: false, code: 'SCHEDULE_CONFLICT' }))
    });
    const result = await drv.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'x1', requestId2: 'x2' }) });
    assert.equal(result.ok, false, JSON.stringify(bad).slice(0, 90));
    assert.ok(/BAD_SUCCESS_SHAPE/.test(String(result.report.stoppedReason)), String(result.report.stoppedReason));
  }
});

test('R3-6 V06-c 未完成 a 的人工接续 → 零请求', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({
    api, testCaseId: 'V06-c',
    input: baseInput({ scheduleId: 's_p', expectedVersion: 1, content1: 'a', content2: 'b', reason: 'r' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_PRIOR_NOT_REVIEWED');
  assert.equal(api.__calls.length, 0);
});

test('R3-7 a 已 reviewed 后，V06-c 真实调用 getSchedule 并用当前 form', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  let updates = 0;
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (data.action === 'getSchedule') {
        return { result: { ok: true, schedule: scheduleOk({ id: 's_review01', version: 3, content: '当前真实内容', startDate: '2026-12-01', endDate: '2026-12-02', expectedDate: '2026-12-02' }) } };
      }
      if (data.action === 'createSchedule') return { result: clone(scheduleOk({ id: 's_review01', version: 1 })) };
      if (data.action === 'updateSchedule') {
        updates++;
        // 第一笔成功并把版本推进到 4；第二笔因同版本被拒
        return updates === 1
          ? { result: clone(scheduleOk({ id: 's_review01', version: 4, content: '内容一' })) }
          : { result: { ok: false, code: 'VERSION_MISMATCH' } };
      }
      return { result: { ok: true } };
    }
  });
  const a = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(a.report.verdict, 'candidate', a.report.stoppedReason || '');
  const ctx = ctxFor(storage);
  const review = coordinator.acceptCloudReview(ctx, 'V06-a', 'mgmt-review-001');
  assert.equal(review.ok, true, review.message);
  assert.equal(coordinator.readCase(ctx, 'V06-a').record.state, 'reviewed');

  api.__calls.length = 0;
  const c = await drv.runCase({
    api, testCaseId: 'V06-c',
    input: baseInput({ scheduleId: 's_review01', expectedVersion: 3, content1: '内容一', content2: '内容二', reason: 'r' })
  });
  const getScheduleCalls = api.__calls.filter(x => x.action === 'getSchedule');
  assert.equal(getScheduleCalls.length, 1, 'V06-c 必须真实读取 getSchedule');
  assert.equal(c.report.verdict, 'candidate', c.report.stoppedReason || '');
  const updateCalls = api.__calls.filter(x => x.action === 'updateSchedule');
  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0].expectedVersion, 3);
  assert.equal(updateCalls[0].form.startDate, '2026-12-01');
  assert.notEqual(updateCalls[0].form.content, updateCalls[1].form.content);
});

test('R3-8 V06-c 的 getSchedule 失败 / 目标不符 / 版本非法 → 零业务发送', async () => {
  const cases = [
    ['GET_SCHEDULE_FAILED', async () => { throw new Error('boom'); }],
    ['GET_SCHEDULE_ID_MISMATCH', async () => ({ result: { ok: true, schedule: scheduleOk({ id: 's_other000000000000' }) } })],
    ['GET_SCHEDULE_NOT_ACTIVE', async () => ({ result: { ok: true, schedule: scheduleOk({ status: 'cancelled' }) } })],
    ['GET_SCHEDULE_BAD_VERSION', async () => ({ result: { ok: true, schedule: scheduleOk({ version: 0 }) } })],
    ['GET_SCHEDULE_BAD_SHAPE', async () => ({ result: { ok: true, schedule: 'not-an-object' } })]
  ];
  for (const [reason, getSchedule] of cases) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
        if (data.action === 'createSchedule') return { result: clone(scheduleOk()) };
        if (data.action === 'getSchedule') return getSchedule(data);
        return { result: { ok: false, code: 'VERSION_MISMATCH' } };
      }
    });
    await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    coordinator.acceptCloudReview(ctxFor(storage), 'V06-a', 'mgmt-review-001');
    api.__calls.length = 0;
    const c = await drv.runCase({
      api, testCaseId: 'V06-c',
      input: baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'a', content2: 'b', reason: 'r' })
    });
    assert.equal(c.ok, false, reason);
    assert.equal(c.code, 'TEST_DRIVER_CURRENT_SCHEDULE_UNKNOWN', reason);
    assert.equal(writes(api).length, 0, `${reason} 必须零业务发送`);
  }
});

test('R3-9 V06-c 缺字段 / 内容相同 → 零业务发送', async () => {
  const variants = [
    // 缺 reason
    baseInput({ scheduleId: 's_review01', content1: 'a', content2: 'b' }),
    // 缺 content2
    baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'a', reason: 'r' }),
    // 两份内容相同
    baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'same', content2: 'same', reason: 'r' }),
    // 两个请求号相同
    baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'a', content2: 'b', reason: 'r', requestId1: 'same', requestId2: 'same' })
  ];
  for (const input of variants) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
        if (data.action === 'createSchedule') return { result: clone(scheduleOk()) };
        if (data.action === 'getSchedule') return { result: { ok: true, schedule: scheduleOk({ version: 1 }) } };
        return { result: { ok: false, code: 'VERSION_MISMATCH' } };
      }
    });
    await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    coordinator.acceptCloudReview(ctxFor(storage), 'V06-a', 'mgmt-review-001');
    api.__calls.length = 0;
    const c = await drv.runCase({ api, testCaseId: 'V06-c', input });
    assert.equal(c.ok, false, JSON.stringify(input).slice(0, 80));
    assert.equal(writes(api).length, 0);
  }
});

test('R3-9b V06-c 当前安排的版本不是正整数 → 零业务发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (data.action === 'createSchedule') return { result: clone(scheduleOk()) };
      // 版本不是正整数 → 前提不成立
      if (data.action === 'getSchedule') return { result: { ok: true, schedule: scheduleOk({ version: 0 }) } };
      return { result: { ok: false, code: 'VERSION_MISMATCH' } };
    }
  });
  await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  coordinator.acceptCloudReview(ctxFor(storage), 'V06-a', 'mgmt-review-001');
  api.__calls.length = 0;
  const c = await drv.runCase({
    api, testCaseId: 'V06-c',
    input: baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'a', content2: 'b', reason: 'r' })
  });
  assert.equal(c.ok, false);
  assert.equal(c.code, 'TEST_DRIVER_CURRENT_SCHEDULE_UNKNOWN');
  assert.equal(writes(api).length, 0);
});

test('R3-10 V07-A 前提：完整分页确认存在 active 安排', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const pages = [
    { schedules: [scheduleOk({ id: 's_1', workerUserId: 'u_ffffffffffffffffffffffffffffffffffffffff' })], pagination: { limit: 100, hasMore: true, nextCursor: 'c1' } },
    { schedules: [scheduleOk({ id: 's_2', workerUserId: WORKER_B })], pagination: { limit: 100, hasMore: false, nextCursor: null } }
  ];
  let page = 0;
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'listSchedules') return { result: Object.assign({ ok: true }, clone(pages[Math.min(page++, 1)])) };
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
    }
  });
  const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: WORKER_B } });
  assert.equal(result.ok, true, result.report.stoppedReason || '');
  assert.equal(result.report.verdict, 'candidate');
  const lists = api.__calls.filter(x => x.action === 'listSchedules');
  assert.equal(lists.length, 2, '必须读完整分页');
});

test('R3-11 V07-A 前提不成立（无 active 安排）→ 零发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'listSchedules') return { result: { ok: true, schedules: [], pagination: { limit: 100, hasMore: false, nextCursor: null } } };
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
    }
  });
  const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: WORKER_B } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_V07_PRECONDITION_MISSING');
  assert.equal(writes(api).length, 0);
});

test('R3-12 V07-B 前提不成立（仍有 active 安排）→ 零发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'listSchedules') {
        return { result: { ok: true, schedules: [scheduleOk({ workerUserId: WORKER_B })], pagination: { limit: 100, hasMore: false, nextCursor: null } } };
      }
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      return { result: { userId: WORKER_B, status: 'left' } };
    }
  });
  const result = await drv.runCase({ api, testCaseId: 'V07-B', input: { projectId: PROJECT, userId: WORKER_B } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_V07_PRECONDITION_MISSING');
  assert.equal(writes(api).length, 0);
});

test('R3-13 V07 前提查询不可确认（分页未读完 / 形状非法）→ 零发送', async () => {
  const variants = [
    // 分页一直声称还有下一页但游标不前进 → 读完上限仍不可确认
    async () => ({ result: { schedules: [], pagination: { limit: 100, hasMore: true, nextCursor: 'c' } } }),
    // schedules 不是数组 → 形状非法
    async () => ({ result: { schedules: 'not-an-array', pagination: {} } }),
    // pagination 不是对象 → 形状非法
    async () => ({ result: { schedules: [] } }),
    // hasMore 为 true 但没有游标 → 不可确认
    async () => ({ result: { schedules: [], pagination: { limit: 100, hasMore: true, nextCursor: null } } })
  ];
  for (const listSchedules of variants) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'listSchedules') return listSchedules(data);
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
        return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
      }
    });
    const result = await drv.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: WORKER_B } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TEST_DRIVER_V07_PRECONDITION_UNKNOWN');
    assert.equal(writes(api).length, 0);
  }
});

test('R3-14 V07-B 成功形状不符（userId / status）→ stopped', async () => {
  for (const [bad, expectReason] of [
    [{ ok: true, userId: 'u_ffffffffffffffffffffffffffffffffffffffff', status: 'left' }, 'USER_MISMATCH'],
    [{ ok: true, userId: WORKER_B, status: 'active' }, 'STATUS_NOT_LEFT']
  ]) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'listSchedules') return { result: { ok: true, schedules: [], pagination: { limit: 100, hasMore: false, nextCursor: null } } };
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
        return { result: bad };
      }
    });
    const result = await drv.runCase({ api, testCaseId: 'V07-B', input: { projectId: PROJECT, userId: WORKER_B } });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.report.stoppedReason, expectReason);
  }
});

// ── R1：双向、跨页与持久互斥 ────────────────────────────────────────────

test('R1-1 普通身份刷新在途时驱动不得并行发送', async () => {
  resetAll();
  const drvProof = openProof();
  const drv = loadDriver(drvProof);
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });

  // 用真实客户端模块加载一份副本，注入开启的副本 proof
  const file = path.join(MINIPROGRAM, 'utils/schedule-sandbox-client.js');
  const m = { exports: {} };
  const enabledSandbox = { ...sandboxProof, enabled: true, roundId: drvProof.roundId, sandboxProjectId: drvProof.projectId };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`)(
    name => (name.includes('config/schedule-sandbox-proof') ? enabledSandbox : nativeRequire(name)),
    m, m.exports);

  let release;
  let held = false;
  const original = api.cloud.callFunction;
  api.cloud.callFunction = args => {
    if (args.data.action === 'identify' && !held) {
      held = true;
      return new Promise(resolve => { release = () => resolve({ result: clone(IDENTIFY_OK) }); });
    }
    return original(args);
  };
  const pending = m.exports.refreshSessionIdentity(api);
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  const sentWhileOrdinary = writes(api).length;
  if (release) release();
  await pending;
  assert.equal(held, true, '本用例必须真的让普通 identify 挂起');
  assert.equal(sentWhileOrdinary, 0, '普通请求在途时驱动不得发出任何业务写请求');
  assert.equal(result.ok, false);
});

test('R1-2 candidate 未接续时下一例不得启动（换用例、换页面都不行）', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const a = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(a.report.verdict, 'candidate');
  const block = coordinator.ordinaryEntryBlock({ storage, envId: ENV_ID, roundId: 'round-test-1', actorUserId: MANAGER });
  assert.ok(block, 'candidate 必须阻断普通入口');
  assert.equal(block.code, 'SANDBOX_TEST_DRIVER_ACTIVE');
  const b = await drv.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'b1', requestId2: 'b2' }) });
  assert.equal(b.ok, false);
  assert.equal(writes(api).length, 2, 'a 之后不得再发出第二对');
  // 模拟页面重建（复位运行时占用）后仍阻断
  coordinator._resetRuntimeHoldForTest();
  const drv2 = loadDriver(openProof());
  const c = await drv2.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'b1', requestId2: 'b2' }) });
  assert.equal(c.ok, false, '页面重建后仍不得启动下一例');
  assert.equal(writes(api).length, 2);
});

test('R1-3 candidate 接续后才放开下一例', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  // a：两笔都成功；b：一成功一冲突（按用例分别计数）
  const counters = {};
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action !== 'createSchedule') return defaultHandler(() => scheduleOk())(data);
      counters[data.requestId] = (counters[data.requestId] || 0) + 1;
      const isConflictCase = data.requestId.startsWith('b');
      if (isConflictCase) {
        return data.requestId === 'b1' ? { result: scheduleOk() } : { result: { ok: false, code: 'SCHEDULE_CONFLICT' } };
      }
      return { result: scheduleOk() };
    }
  });
  const a = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(a.report.verdict, 'candidate', a.report.stoppedReason || '');
  const ctx = ctxFor(storage);
  assert.equal(coordinator.acceptCloudReview(ctx, 'V06-a', '').ok, false);
  const review = coordinator.acceptCloudReview(ctx, 'V06-a', 'mgmt-review-001');
  assert.equal(review.ok, true, review.message);
  assert.equal(review.record.reviewKind, 'manual-declaration');
  assert.equal(review.record.verifiedByCloudBaseline, false, '人工声明不得改变云端验真标记');
  assert.deepEqual(review.remainingBlocking, []);
  const b = await drv.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'b1', requestId2: 'b2' }) });
  assert.equal(b.report.verdict, 'candidate', b.report.stoppedReason || '');
});

test('R1-4 stopped 状态在页面重建后仍阻断下一例，且接续不能解锁', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => ({ ok: false, code: 'SERVER_ERROR' })) });
  const a = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(a.report.verdict, 'stopped');
  coordinator._resetRuntimeHoldForTest();
  const review = coordinator.acceptCloudReview(ctxFor(storage), 'V06-a', 'mgmt-review-001');
  assert.equal(review.ok, false);
  assert.equal(review.code, 'TEST_DRIVER_REVIEW_NOT_ALLOWED');
  const drv2 = loadDriver(openProof());
  const b = await drv2.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'b1', requestId2: 'b2' }) });
  assert.equal(b.ok, false, 'stopped 永不解锁');
  assert.equal(writes(api).length, 2, 'stopped 之后不得再发出第二对');
});

test('R1-5 换账号不能隐藏同轮次未完成批次', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const a = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(a.report.verdict, 'candidate');
  // 换账号：批次键不含执行人，因此仍命中同一份文档
  const otherCtx = { storage, envId: ENV_ID, roundId: 'round-test-1', actorUserId: WORKER_B, nowMs: Date.now() };
  const round = coordinator.blockingCases(otherCtx);
  assert.equal(round.status, 'ok');
  assert.ok(round.blocking.length >= 1, '换账号后仍应看到未完成用例');
  const pre = coordinator.preflight(otherCtx, 'V06-b');
  assert.equal(pre.ok, false, '换账号不得绕过轮次阻断');
});

test('R1-6 存储枚举不可用或读取异常 → 失败关闭', async () => {
  // 无枚举能力
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  delete storage.getStorageInfoSync;
  const api = apiWithoutEnumeration(storage, { handler: defaultHandler(() => scheduleOk()) });
  const r1 = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(r1.ok, false, '枚举不可用必须拒绝');
  assert.equal(api.__calls.length, 0, '枚举不可用必须零请求');

  // 读取抛错
  resetAll();
  const drv2 = loadDriver(openProof());
  const storage2 = makeStorage();
  const orig = storage2.getStorageSync;
  storage2.getStorageSync = key => {
    if (String(key).includes('batch:')) throw new Error('storage read failure');
    return orig(key);
  };
  const api2 = makeApi({ storage: storage2, handler: defaultHandler(() => scheduleOk()) });
  const r2 = await drv2.runCase({ api: api2, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(r2.ok, false, '读取异常必须拒绝');
  assert.equal(api2.__calls.length, 0);
});

test('R1-7 运行时占用必须出示本方 token 才能释放', () => {
  resetAll();
  const first = coordinator.acquireRuntimeHold('preflight', 'test', 'V06-a');
  assert.equal(first.ok, true);
  const second = coordinator.acquireRuntimeHold('preflight', 'test', 'V06-b');
  assert.equal(second.ok, false);
  assert.equal(coordinator.releaseRuntimeHold('test:preflight:V06-b:999'), false);
  assert.equal(coordinator.peekRuntimeHold().held, true, '错误 token 释放必须无效');
  assert.equal(coordinator.releaseRuntimeHold(first.token), true);
  assert.equal(coordinator.peekRuntimeHold().held, false);
});

test('R1-8 驱动占用期间普通三入口均零请求', async () => {
  resetAll();
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const callsBefore = api.__calls.length;
  coordinator.acquireRuntimeHold('inFlight', 'test', 'V06-a');
  const r1 = await clientModule.callSandbox({ action: 'identify' }, { api });
  assert.equal(r1.code, 'SANDBOX_TEST_DRIVER_ACTIVE');
  const r2 = await clientModule.resumePending({ api });
  assert.equal(r2.code, 'SANDBOX_TEST_DRIVER_ACTIVE');
  const r3 = await clientModule.refreshSessionIdentity(api);
  assert.equal(r3.status, 'unknown');
  assert.equal(api.__calls.length, callsBefore, '占用期间不得发任何请求');
  coordinator._resetRuntimeHoldForTest();
});

test('R1-9 公开 API 上不存在绕过锁的开关', () => {
  const source = fs.readFileSync(path.join(MINIPROGRAM, 'utils/schedule-sandbox-client.js'), 'utf8');
  const code = source.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(/ignoreLock|skipLock|bypassLock|forceLock|ignoreTestDriver/.test(code), false);
});

test('R1-10 持久批次损坏 → 失败关闭（不得视为无未完成批次）', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  storage.store[coordinator.batchKey(ENV_ID, 'round-test-1')] = '{ not json';
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false, '批次损坏必须拒绝');
  assert.equal(api.__calls.length, 0);
});

// ── R4：发送生命周期与持久证据 ─────────────────────────────────────────

test('R4-1 前置期间窗口过期 → 零业务发送', async () => {
  resetAll();
  const original = Date.now;
  const start = original();
  const drv = loadDriver(openProof({ expiresAt: new Date(start + 10000).toISOString() }));
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const inner = api.cloud.callFunction;
  api.cloud.callFunction = async args => {
    const r = await inner(args);
    if (args.data.action === 'getMembers') Date.now = () => start + 20000;
    return r;
  };
  try {
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.equal(result.ok, false);
    assert.equal(writes(api).length, 0, '预检耗时穿越截止后不得发送');
  } finally {
    Date.now = original;
  }
});

test('R4-2 第二次发送同步抛错 → 已调用证据保留、不补发、状态落 stopped', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  let n = 0;
  const inner = api.cloud.callFunction;
  api.cloud.callFunction = args => {
    if (args.data.action === 'createSchedule' && ++n === 2) throw new Error('synthetic synchronous send failure');
    return inner(args);
  };
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false, '同步抛错不得判候选');
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');
  assert.equal(writes(api).length, 1, '第一次已调用，不能被第二次异常抹成零');
  assert.equal(result.report.sent, 2, '两笔都已尝试发起');
  const rec = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  assert.equal(rec.state, 'stopped');
  const outcomes = rec.responses.map(r => r.outcome).sort();
  assert.deepEqual(outcomes, ['responded', 'sync-throw']);
  assert.ok(rec.responses.every(r => r.invoked === true), '已调用必须逐笔标记');
});

test('R4-3 第一笔响应后第二笔挂起 → 超时停止且晚响应不改判', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  let n = 0;
  const inner = api.cloud.callFunction;
  let lateRelease;
  api.cloud.callFunction = args => {
    if (args.data.action === 'createSchedule' && ++n === 2) {
      return new Promise(resolve => { lateRelease = () => resolve({ result: scheduleOk() }); });
    }
    return inner(args);
  };
  const pending = [];
  const timers = { setTimeout: fn => { pending.push(fn); return pending.length; }, clearTimeout: () => {} };
  const run = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers });
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const fn of pending) { try { fn(); } catch (e) { /* 忽略 */ } }
  const result = await run;
  assert.equal(result.ok, false);
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');
  if (lateRelease) lateRelease();
  await new Promise(resolve => setTimeout(resolve, 10));
  const rec = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  assert.equal(rec.state, 'stopped', '晚响应不得把 stopped 改成 candidate');
});

test('R4-4 状态写失败 → 不显示 candidate', async () => {
  // candidate 分支：两笔都成功并满足 a 的判定
  resetAll();
  {
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const orig = storage.setStorageSync;
    let injected = false;
    storage.setStorageSync = (key, value) => {
      // 只在第一次写入 candidate 时失败（模拟状态持久化点故障）
      if (!injected && value.includes('"state":"candidate"')) {
        injected = true;
        throw new Error('synthetic full storage');
      }
      orig(key, value);
    };
    const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.ok(injected, 'candidate 写入点必须真的被触发');
    assert.notEqual(result.report.verdict, 'candidate', 'candidate 写失败不得显示候选');
    const rec = coordinator.readCase(ctxFor(storage), 'V06-a');
    const state = rec.status === 'ok' ? rec.record.state : '(无记录)';
    assert.equal(state, 'inFlight', `candidate 写失败时状态应停在 inFlight，实际 ${state}`);
  }
  // stopped 分支：两笔都被拒（走 UNKNOWN 之前的判定停止）
  resetAll();
  {
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const orig = storage.setStorageSync;
    let injected = false;
    storage.setStorageSync = (key, value) => {
      if (!injected && value.includes('"state":"stopped"')) {
        injected = true;
        throw new Error('synthetic full storage');
      }
      orig(key, value);
    };
    const api = makeApi({ storage, handler: defaultHandler(() => ({ ok: false, code: 'SCHEDULE_CONFLICT' })) });
    const result = await drv.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'b1', requestId2: 'b2' }) });
    assert.ok(injected, 'stopped 写入点必须真的被触发');
    assert.equal(result.report.verdict, 'stopped');
    assert.notEqual(result.report.stoppedReason, null);
  }
});

test('R4-5 回读时重算摘要：只改内容保留旧 digest 会被状态写入发现', () => {
  resetAll();
  coordinator._setProofForTest(openProof());
  const storage = makeStorage();
  const ctx = { storage, envId: ENV_ID, roundId: 'round-test-1', actorUserId: MANAGER, nowMs: Date.now() };
  const snapshot = { testCaseId: 'V06-probe', plan: [{ action: 'createSchedule', projectId: PROJECT, requestId: 'r1' }], forms: [{ content: '原内容' }] };
  const binding = { envId: ENV_ID, roundId: 'round-test-1', projectId: PROJECT };
  const first = coordinator.persistArmedRecord(ctx, {
    testCaseId: 'V06-probe', snapshot, binding, requestIds: ['r1']
  });
  assert.equal(first.ok, true, first.message);
  // 篡改：只改快照内容，保留旧 digest（模拟存储被别处改动）
  const key = coordinator.batchKey(ENV_ID, 'round-test-1');
  const doc = JSON.parse(storage.store[key]);
  doc.cases['V06-probe'].snapshot.forms[0].content = '被改过的内容';
  storage.store[key] = JSON.stringify(doc);
  // 状态写入时的回读必须发现摘要不匹配（不信自报 digest）
  const outcome = coordinator.setCaseState(ctx, 'V06-probe', 'inFlight', { sentAt: 1 });
  assert.equal(outcome.ok, false, '回读必须重算摘要并发现不一致');
  assert.ok(/摘要/.test(String(outcome.message)), String(outcome.message));
});

test('R4-6 报告区分模拟来源与运行期真实发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.report.localOnly, false, '已真实发送不得声称 localOnly');
  assert.equal(result.report.source, 'runtime-real-wx-cloud');
  assert.equal(result.report.invokedCount, 2);
  assert.equal(result.report.verifiedByCloudBaseline, false);
});

test('R4-7 快照覆盖全部非敏感语义字段', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  const rec = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  const plan = rec.snapshot.plan[0];
  for (const key of ['action', 'projectId', 'requestId', 'scheduleId', 'expectedVersion', 'reason', 'userId']) {
    assert.ok(Object.prototype.hasOwnProperty.call(plan, key), `快照缺少 ${key}`);
  }
  assert.ok(rec.binding.envId && rec.binding.projectId && rec.binding.actorUserId && rec.binding.evidenceId);
  assert.equal(rec.snapshotDigest, coordinator.snapshotDigest(rec.snapshot));
});

// ── V06/V07 正向判定 ────────────────────────────────────────────────────

test('D10 V06-a 两笔相同请求号与相同载荷 → 双成功且版本 1 → candidate', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, true, result.report.stoppedReason || '');
  assert.equal(result.report.verdict, 'candidate');
  assert.equal(result.report.sent, 2);
  assert.equal(result.report.verifiedByCloudBaseline, false);
  const calls = api.__calls.filter(x => x.action === 'createSchedule');
  assert.equal(calls[0].requestId, calls[1].requestId, 'a 必须同请求号');
  assert.equal(JSON.stringify(calls[0].form), JSON.stringify(calls[1].form), 'a 必须同完整载荷');
});

test('D11 V06-b 不同请求号、一成功一 SCHEDULE_CONFLICT → candidate（两种顺序）', async () => {
  for (const order of ['ok-first', 'conflict-first']) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    let n = 0;
    const api = makeApi({
      storage,
      handler: defaultHandler(() => {
        n++;
        const isOk = order === 'ok-first' ? n === 1 : n === 2;
        return isOk ? scheduleOk() : { ok: false, code: 'SCHEDULE_CONFLICT' };
      })
    });
    const result = await drv.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'b1', requestId2: 'b2' }) });
    assert.equal(result.ok, true, `${order}: ${result.report.stoppedReason || ''}`);
    const ids = api.__calls.filter(x => x.action === 'createSchedule').map(x => x.requestId);
    assert.notEqual(ids[0], ids[1], 'b 必须不同请求号');
  }
});

test('D12 拒绝组合：双成功(b/c)、双拒绝、未知业务码、SERVER_ERROR、坏形状 → stopped', async () => {
  const variants = [
    [() => scheduleOk(), () => scheduleOk()],
    [() => ({ ok: false, code: 'SCHEDULE_CONFLICT' }), () => ({ ok: false, code: 'SCHEDULE_CONFLICT' })],
    [() => scheduleOk(), () => ({ ok: false, code: 'WEIRD_CODE' })],
    [() => scheduleOk(), () => ({ ok: false, code: 'SERVER_ERROR' })],
    [() => 'not-an-object', () => scheduleOk()]
  ];
  for (const [left, right] of variants) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    let n = 0;
    const api = makeApi({ storage, handler: defaultHandler(() => (++n === 1 ? left : right)) });
    const result = await drv.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'b1', requestId2: 'b2' }) });
    assert.equal(result.ok, false, JSON.stringify([left, right]).slice(0, 90));
    assert.equal(result.report.stoppedReason !== null, true);
  }
});

test('D13 网络失败 → stopped/UNKNOWN_RESULT，不补发不发第三笔', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => { throw new Error('network down'); }) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');
  assert.equal(writes(api).length, 2, '不得补发第三笔');
  assert.equal(coordinator.peekRuntimeHold().held, false, '停止后本机占用已释放');
  assert.equal(coordinator.readCase(ctxFor(storage), 'V06-a').record.state, 'stopped');
});

test('D14 identify / getMembers 异常 → 零业务发送并留停止证据', async () => {
  for (const action of ['identify', 'getMembers']) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === action) throw new Error('synthetic failure');
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
        return { result: clone(scheduleOk()) };
      }
    });
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.equal(result.ok, false, action);
    assert.equal(writes(api).length, 0, `${action} 失败必须零业务发送`);
    const rec = coordinator.readCase(ctxFor(storage), 'V06-a').record;
    assert.equal(rec.state, 'stopped', `${action} 失败必须留停止证据`);
  }
});

test('D15 身份门槛：非可信账号 / 账号不一致 / 非管家 → 零测试写请求', async () => {
  const variants = [
    [{ ok: true, sandbox: true, userId: 'u_ffffffffffffffffffffffffffffffffffffffff' }, MEMBERS_OK],
    [{ ok: false, code: 'IDENTITY_UNAVAILABLE' }, MEMBERS_OK],
    [IDENTIFY_OK, { ok: true, members: [{ userId: MANAGER, roles: ['师傅'], trades: [] }] }]
  ];
  for (const [identify, members] of variants) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'identify') return { result: clone(identify) };
        if (data.action === 'getMembers') return { result: clone(members) };
        return { result: clone(scheduleOk()) };
      }
    });
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.equal(result.ok, false);
    assert.equal(writes(api).length, 0, '身份门槛失败必须零测试写请求');
  }
});

test('D16 启动快照持久化失败 → 零业务发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const orig = storage.setStorageSync;
  storage.setStorageSync = (key, value) => {
    if (String(key).includes('batch:')) throw new Error('synthetic full storage');
    orig(key, value);
  };
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEST_DRIVER_STORAGE_UNAVAILABLE');
  assert.equal(api.__calls.length, 0);
});

test('D17 同 tick 两个入口：业务写请求恒为两笔，至多一个成功', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const [r1, r2] = await Promise.all([
    drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() }),
    drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() })
  ]);
  assert.equal(writes(api).length, 2, `同 tick 只允许一个用例发两笔，实际 ${writes(api).length} 笔`);
  assert.ok([r1, r2].filter(r => r.ok).length <= 1, '至多一个入口成功');
  for (const r of [r1, r2]) {
    if (!r.ok) assert.equal(r.report.sent <= 2, true, '单个入口不得发出超过两笔');
  }
});

test('D18 两个驱动实例共享同一占用表：业务写请求恒为两笔', async () => {
  resetAll();
  const drvA = loadDriver(openProof());
  const drvB = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const [a, b] = await Promise.all([
    drvA.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'x1', requestId2: 'x2' }) }),
    drvB.runCase({ api, testCaseId: 'V06-b', input: baseInput({ requestId1: 'x1', requestId2: 'x2' }) })
  ]);
  assert.equal(writes(api).length, 2, `两实例同用例只允许两笔，实际 ${writes(api).length}`);
  assert.ok([a, b].filter(r => r.ok).length <= 1);
});

test('D19 普通未决存在（当前格式 / unbound / 旧格式 / 损坏）→ 驱动拒绝启动', async () => {
  const pendingKeys = [
    // 当前格式：可信账号键
    [`${sandboxProof.cachePrefix}envelope:${ENV_ID}:round-test-1:${MANAGER}`, '{"requestId":"r"}'],
    // 当前格式：unbound 键
    [`${sandboxProof.cachePrefix}envelope:${ENV_ID}:round-test-1:unbound`, '{"requestId":"r"}'],
    // 旧格式：pending / snapshot 无账号后缀
    [`${sandboxProof.cachePrefix}pending:${ENV_ID}:round-test-1`, '{"requestId":"r"}'],
    [`${sandboxProof.cachePrefix}snapshot:${ENV_ID}:round-test-1`, '{}']
  ];
  for (const [key, value] of pendingKeys) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    storage.store[key] = value;
    const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.equal(result.ok, false, key);
    assert.equal(api.__calls.length, 0, key + ' 必须零请求');
  }
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  storage.store[`${sandboxProof.cachePrefix}envelope:${ENV_ID}:round-test-1:${MANAGER}`] = '{ broken';
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(api.__calls.length, 0);
});

test('D20 脱敏：非白名单码折叠为 UNKNOWN_CODE，不透出底层对象', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: defaultHandler(() => ({ ok: false, code: 'INTERNAL_STACK_XYZ', detail: 'secret-token-abc' }))
  });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result.report).includes('secret-token-abc'), false, '不得透出底层错误内容');
  assert.ok(result.report.responses.some(r => r.result && r.result.code === 'UNKNOWN_CODE'));
});

test('D21 三个模块可独立 require，且不含 wx 引用', () => {
  for (const rel of [
    '../miniprogram/config/sandbox-test-driver-proof',
    '../miniprogram/utils/sandbox-test-coordinator',
    '../miniprogram/utils/sandbox-test-driver'
  ]) {
    const mod = require(rel);
    assert.ok(mod && typeof mod === 'object', `${rel} 应可独立 require`);
  }
  for (const rel of ['config/sandbox-test-driver-proof.js', 'utils/sandbox-test-coordinator.js']) {
    const src = fs.readFileSync(path.join(MINIPROGRAM, rel), 'utf8');
    assert.equal(/require\(['"]wx/.test(src), false, `${rel} 不得 require wx`);
  }
});

// ── 真实 Page 卡片事件测试（R3 / R4）────────────────────────────────────

test('P1 真实 Page：c 无已核对 a → stopped 且零业务发送', async () => {
  resetAll();
  const drvProof = openProof();
  const drv = loadDriver(drvProof);
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (data.action === 'createSchedule') return { result: clone(scheduleOk()) };
      if (data.action === 'getSchedule') return { result: { ok: true, schedule: scheduleOk({ version: 1 }) } };
      return { result: { ok: false, code: 'VERSION_MISMATCH' } };
    }
  });
  const page = loadPage(api, drv, drvProof);
  page.data.form = Object.assign(baseInput(), { restDaysText: '' });
  await page.runTestCase({ currentTarget: { dataset: { case: 'V06-c' } } });
  assert.equal(page.data.testReport.verdict, 'stopped');
  assert.equal(page.data.testReport.stoppedReason, 'V06A_RESULT_MISSING');
  assert.equal(writes(api).length, 0);
  assert.equal(page.data.testBusy, false, 'finally 必须结束 busy');
});

test('P2 真实 Page：a candidate → 人工接续 → c 真实 getSchedule', async () => {
  resetAll();
  const drvProof = openProof();
  const drv = loadDriver(drvProof);
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (data.action === 'createSchedule') return { result: clone(scheduleOk({ id: 's_review01', version: 1 })) };
      if (data.action === 'getSchedule') {
        return { result: { ok: true, schedule: scheduleOk({ id: 's_review01', version: 5, content: '当前内容' }) } };
      }
      if (data.action === 'updateSchedule') {
        return { result: clone(scheduleOk({ id: 's_review01', version: 6, content: '页面内容一' })) };
      }
      return { result: { ok: false, code: 'VERSION_MISMATCH' } };
    }
  });
  const page = loadPage(api, drv, drvProof);
  page.data.form = Object.assign(baseInput(), { restDaysText: '' });
  await page.runTestCase({ currentTarget: { dataset: { case: 'V06-a' } } });
  assert.equal(page.data.testReport.verdict, 'candidate', page.data.testReport.stoppedReason || '');
  // 未接续时 c 必须被拒绝
  api.__calls.length = 0;
  await page.runTestCase({ currentTarget: { dataset: { case: 'V06-c' } } });
  assert.equal(page.data.testReport.verdict, 'stopped');
  assert.equal(writes(api).length, 0, '未接续不得发更新');
  // 人工接续：把报告切回 a（页面对当前报告的用例接续）
  page.data.testReport = Object.assign({}, page.data.testReport, { testCaseId: 'V06-a' });
  page.data.testReviewIdInput = 'mgmt-review-page-1';
  page.acceptTestCloudReview();
  assert.ok(/已记录/.test(page.data.testReport.reviewResult), page.data.testReport.reviewResult);
  api.__calls.length = 0;
  await page.runTestCase({ currentTarget: { dataset: { case: 'V06-c' } } });
  const gets = api.__calls.filter(x => x.action === 'getSchedule');
  assert.equal(gets.length, 1, '页面 c 必须真实读 getSchedule');
  const updateCalls = api.__calls.filter(x => x.action === 'updateSchedule');
  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0].expectedVersion, 5, '期望版本必须来自当前安排');
  assert.equal(page.data.testBusy, false);
});

test('P3 真实 Page：getSchedule 目标变化 / 失败 / 版本非法 → stopped 且零业务发送', async () => {
  const variants = [
    async () => { throw new Error('read failure'); },
    async () => ({ result: { ok: true, schedule: scheduleOk({ id: 's_another000000000' }) } }),
    async () => ({ result: { ok: true, schedule: scheduleOk({ version: 0 }) } })
  ];
  for (const getSchedule of variants) {
    resetAll();
    const drvProof = openProof();
    const drv = loadDriver(drvProof);
    const storage = makeStorage();
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
        if (data.action === 'createSchedule') return { result: clone(scheduleOk({ id: 's_review01' })) };
        if (data.action === 'getSchedule') return getSchedule(data);
        return { result: { ok: false, code: 'VERSION_MISMATCH' } };
      }
    });
    const page = loadPage(api, drv, drvProof);
    page.data.form = Object.assign(baseInput(), { restDaysText: '' });
    await page.runTestCase({ currentTarget: { dataset: { case: 'V06-a' } } });
    page.data.testReviewIdInput = 'mgmt-review-1';
    page.acceptTestCloudReview();
    api.__calls.length = 0;
    await page.runTestCase({ currentTarget: { dataset: { case: 'V06-c' } } });
    assert.equal(page.data.testReport.verdict, 'stopped');
    assert.equal(writes(api).length, 0);
    assert.equal(page.data.testBusy, false);
  }
});

test('P4 真实 Page：日期不一致 → stopped 且零请求（不自动确认）', async () => {
  resetAll();
  const drvProof = openProof();
  const drv = loadDriver(drvProof);
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const page = loadPage(api, drv, drvProof);
  page.data.form = Object.assign(baseInput({ expectedDate: '2026-11-09' }), { restDaysText: '' });
  await page.runTestCase({ currentTarget: { dataset: { case: 'V06-a' } } });
  assert.equal(page.data.testReport.verdict, 'stopped');
  assert.equal(page.data.testReport.stoppedReason, 'TEST_DRIVER_DATE_NOT_CONFIRMED');
  assert.equal(api.__calls.length, 0);
});

test('P5 真实 Page：驱动抛错 → finally 结束 busy 且给出停止报告', async () => {
  resetAll();
  const drvProof = openProof();
  const drv = loadDriver(drvProof);
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const throwingDriver = Object.assign({}, drv, {
    runCase: async () => { throw new Error('synthetic page failure'); }
  });
  const page = loadPage(api, throwingDriver, drvProof);
  page.data.form = Object.assign(baseInput(), { restDaysText: '' });
  await page.runTestCase({ currentTarget: { dataset: { case: 'V06-a' } } });
  assert.equal(page.data.testBusy, false, '抛错后 busy 必须结束');
  assert.equal(page.data.testReport.verdict, 'stopped');
  assert.equal(page.data.testReport.stoppedReason, 'TEST_DRIVER_THREW');
});

test('P6 真实 Page：V07 目标只来自配置，不做表单兜底', async () => {
  resetAll();
  const drvProof = openProof();
  const drv = loadDriver(drvProof);
  const storage = makeStorage();
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'listSchedules') {
        return { result: { ok: true, schedules: [scheduleOk({ workerUserId: WORKER_B })], pagination: { limit: 100, hasMore: false, nextCursor: null } } };
      }
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
    }
  });
  const page = loadPage(api, drv, drvProof);
  page.data.form = Object.assign(baseInput(), { restDaysText: '' });
  page.data.memberUserIdInput = MANAGER;
  await page.runTestCase({ currentTarget: { dataset: { case: 'V07-A' } } });
  // 页面必须用配置里的受审目标（表单兜底已移除）
  assert.equal(page.data.testReport.verdict, 'candidate', page.data.testReport.stoppedReason || '');
  const removals = api.__calls.filter(x => x.action === 'removeMember');
  assert.equal(removals.length, 1);
  assert.equal(removals[0].userId, WORKER_B, '不得使用表单里的账号');

  // 配置目标为空：零发送，不做表单兜底
  resetAll();
  const emptyProof = openProof({ v07TargetUserId: '' });
  const drv2 = loadDriver(emptyProof);
  const storage2 = makeStorage();
  const api2 = makeApi({ storage: storage2, handler: defaultHandler(() => ({ ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' })) });
  const page2 = loadPage(api2, drv2, emptyProof);
  page2.data.form = Object.assign(baseInput(), { restDaysText: '' });
  page2.data.memberUserIdInput = WORKER_B;
  await page2.runTestCase({ currentTarget: { dataset: { case: 'V07-A' } } });
  assert.equal(page2.data.testReport.verdict, 'stopped');
  assert.equal(writes(api2).length, 0, '配置缺目标时不得用表单兜底发送');
});
// ── S1：官方真实账号信息形状 ───────────────────────────────────────────

test('S1-1 官方 MiniProgram 形状（appId/envVersion/version，无 envId）→ 可正常发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  // 显式使用官方契约形状：只有 appId / envVersion / version
  const api = makeApi({
    storage,
    handler: defaultHandler(() => scheduleOk()),
    appId: APPID,
    envVersion: 'develop'
  });
  const info = api.getAccountInfoSync();
  assert.equal('envId' in info.miniProgram, false, '夹具不得再伪造 envId');
  const g = drv.gate({ api });
  assert.equal(g.ok, true, JSON.stringify(g.reasons));
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.report.verdict, 'candidate', result.report.stoppedReason || '');
});

test('S1-2 每次调用都显式钉死固定云环境与函数名', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const seen = [];
  const inner = api.cloud.callFunction;
  api.cloud.callFunction = args => { seen.push(args); return inner(args); };
  await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.ok(seen.length >= 3);
  for (const call of seen) {
    assert.equal(call.name, 'scheduleSandbox', '函数名必须固定');
    assert.equal(call.config.env, 'cloud1-d8gcq5ag39d847723', '云环境必须每次显式限定');
  }
});

test('S1-3 配置环境偏离固定值时 sendFixed 直接抛错（不发请求）', () => {
  resetAll();
  const drv = loadDriver(openProof({ envId: 'cloud_other' }));
  const api = makeApi({ storage: makeStorage(), handler: defaultHandler(() => scheduleOk()) });
  assert.throws(() => drv.sendFixed(api, { action: 'identify' }), /环境不符固定值/);
  assert.equal(api.__calls.length, 0);
});

// ── S2：损坏记录与伪造凭证 ─────────────────────────────────────────────

test('S2-1 cases 是 JSON 数组（可解析但非字典）→ 失败关闭、零发送', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  storage.store[coordinator.batchKey(ENV_ID, 'round-test-1')] = JSON.stringify({
    kind: 'sandbox-test-driver-batch/2',
    envId: ENV_ID,
    roundId: 'round-test-1',
    cases: []
  });
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false, '损坏的 cases 必须失败关闭');
  assert.equal(writes(api).length, 0);
  const raw = JSON.parse(storage.store[coordinator.batchKey(ENV_ID, 'round-test-1')]);
  assert.ok(Array.isArray(raw.cases), '损坏的 cases 不得被重置为 {}');
});

test('S2-2 批次 kind / envId / roundId / 状态 / 绑定 不符 → 失败关闭', async () => {
  const good = { envId: ENV_ID, roundId: 'round-test-1' };
  const bads = [
    ['wrong-kind', { kind: 'sandbox-test-driver-batch/1', envId: ENV_ID, roundId: 'round-test-1', cases: {} }],
    ['wrong-env', { kind: 'sandbox-test-driver-batch/2', envId: 'cloud_other', roundId: 'round-test-1', cases: {} }],
    ['wrong-round', { kind: 'sandbox-test-driver-batch/2', envId: ENV_ID, roundId: 'round-other', cases: {} }],
    ['unknown-state', {
      kind: 'sandbox-test-driver-batch/2', envId: ENV_ID, roundId: 'round-test-1',
      cases: { 'V06-a': { testCaseId: 'V06-a', state: 'weird', binding: good, snapshotDigest: 'x' } }
    }],
    ['key-id-mismatch', {
      kind: 'sandbox-test-driver-batch/2', envId: ENV_ID, roundId: 'round-test-1',
      cases: { 'V06-a': { testCaseId: 'V06-b', state: 'stopped', binding: good, snapshotDigest: 'x' } }
    }],
    ['record-not-object', {
      kind: 'sandbox-test-driver-batch/2', envId: ENV_ID, roundId: 'round-test-1',
      cases: { 'V06-a': 'not-an-object' }
    }],
    ['binding-mismatch', {
      kind: 'sandbox-test-driver-batch/2', envId: ENV_ID, roundId: 'round-test-1',
      cases: { 'V06-a': { testCaseId: 'V06-a', state: 'stopped', binding: { envId: 'cloud_other', roundId: 'round-test-1' }, snapshotDigest: 'x' } }
    }],
    ['no-digest', {
      kind: 'sandbox-test-driver-batch/2', envId: ENV_ID, roundId: 'round-test-1',
      cases: { 'V06-a': { testCaseId: 'V06-a', state: 'stopped', binding: good } }
    }]
  ];
  for (const entry of bads) {
    const label = entry[0];
    const doc = entry[1];
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    storage.store[coordinator.batchKey(ENV_ID, 'round-test-1')] = JSON.stringify(doc);
    const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.equal(result.ok, false, label + ' 必须失败关闭');
    assert.equal(writes(api).length, 0, label + ' 必须零发送');
  }
});

test('S2-3 上一轮 case/1 旧键（stopped）→ 保守阻断且保留记录', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const legacyKey = coordinator.legacyBatchKey(ENV_ID, 'round-test-1', MANAGER) + ':case:V06-a';
  const legacyValue = JSON.stringify({ kind: 'sandbox-test-driver-case/1', testCaseId: 'V06-a', state: 'stopped', responses: [{ outcome: 'timeout' }] });
  storage.store[legacyKey] = legacyValue;
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false, '旧 stopped 记录必须阻断');
  assert.equal(writes(api).length, 0);
  assert.equal(storage.store[legacyKey], legacyValue, '旧记录必须原样保留，不删除');
});

test('S2-4 旧按人批次键里的未完成用例 → 保守阻断', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const key = coordinator.legacyBatchKey(ENV_ID, 'round-test-1', MANAGER);
  storage.store[key] = JSON.stringify({
    kind: 'sandbox-test-driver-batch/2',
    envId: ENV_ID,
    roundId: 'round-test-1',
    cases: { 'V06-a': { testCaseId: 'V06-a', state: 'armed', binding: { envId: ENV_ID, roundId: 'round-test-1' }, snapshotDigest: 'x' } }
  });
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(result.ok, false);
  assert.equal(writes(api).length, 0);
});

test('S2-5 伪造/无效 internalOwner 不得绕过运行时占用', async () => {
  resetAll();
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const file = path.join(MINIPROGRAM, 'utils/schedule-sandbox-client.js');
  const m = { exports: {} };
  const enabledSandbox = { ...sandboxProof, enabled: true, roundId: 'round-test-1', sandboxProjectId: PROJECT };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`)(
    name => (name.includes('config/schedule-sandbox-proof') ? enabledSandbox : nativeRequire(name)),
    m, m.exports);

  const hold = coordinator.acquireRuntimeHold('inFlight', 'test', 'V06-a');
  assert.equal(hold.ok, true);
  const before = api.__calls.length;
  for (const forged of [{}, { token: 'x' }, { token: 'x', owner: 'ordinary' }, 'truthy', 1, []]) {
    const r = await m.exports.refreshSessionIdentity(api, forged);
    assert.notEqual(r.status, 'bound', '伪造凭证 ' + JSON.stringify(forged) + ' 不得放行');
  }
  assert.equal(api.__calls.length, before, '伪造凭证期间不得发任何请求');
  assert.equal(coordinator.peekRuntimeHold().held, true, '原占用仍在');
  coordinator.releaseRuntimeHold(hold.token);
});

test('S2-6 合法 ordinary 凭证可内部重入且不自锁', async () => {
  resetAll();
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const file = path.join(MINIPROGRAM, 'utils/schedule-sandbox-client.js');
  const m = { exports: {} };
  const enabledSandbox = { ...sandboxProof, enabled: true, roundId: 'round-test-1', sandboxProjectId: PROJECT };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`)(
    name => (name.includes('config/schedule-sandbox-proof') ? enabledSandbox : nativeRequire(name)),
    m, m.exports);
  const r = await m.exports.resumePending({ api });
  assert.ok(r.code !== 'SANDBOX_TEST_DRIVER_ACTIVE', '合法内部重入不得被自锁拦下');
  assert.equal(coordinator.peekRuntimeHold().held, false, '结束后不得残留占用');
});

// ── S3：逐笔监听与完整回读 ─────────────────────────────────────────────

test('S3-1 第二笔先成功 → 先到先留证（不必等第一笔）', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  let resolveFirst = null;
  let n = 0;
  // 注意：不能用 defaultHandler —— 它对 respond 的返回值做 JSON clone，
  // 会把 pending promise 变成 {}，挂不住「第一笔永久等待」这个前提。
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (++n === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return { result: scheduleOk() };
    }
  });
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 12; i++) await tick();
  const saved = coordinator.readCase(ctxFor(storage), 'V06-a').record.responses || [];
  assert.equal(saved.length, 1, '第二笔已返回时必须已留证，不必等第一笔');
  if (resolveFirst) resolveFirst({ result: scheduleOk() });
  const result = await running;
  assert.equal(result.report.verdict, 'candidate', result.report.stoppedReason || '');
  assert.equal(coordinator.readCase(ctxFor(storage), 'V06-a').record.responses.length, 2);
});

test('S3-2 第一笔永久等待、第二笔先拒绝 → 各自计时、均落证据', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  let n = 0;
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (++n === 1) return new Promise(() => {});
      // 第二笔**真的抛出**（网络失败）：这正是旧实现「还没装 rejection handler」的风险点
      throw new Error('synthetic network failure');
    }
  });
  const pendingTimers = [];
  const timers = { setTimeout: fn => { pendingTimers.push(fn); return pendingTimers.length; }, clearTimeout: () => {} };
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers });
  await new Promise(resolve => setTimeout(resolve, 20));
  const mid = coordinator.readCase(ctxFor(storage), 'V06-a').record.responses || [];
  assert.equal(mid.length, 1, '先拒绝的那笔必须先留证');
  for (const fn of pendingTimers) { try { fn(); } catch (e) { /* 忽略 */ } }
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');
  const outcomes = coordinator.readCase(ctxFor(storage), 'V06-a').record.responses.map(r => r.outcome).sort();
  assert.deepEqual(outcomes, ['network-error', 'timeout']);
});

test('S3-3 回读丢失 responses → 不得显示 candidate', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
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
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(injected, true, '注入点必须被触发');
  assert.notEqual(result.report.verdict, 'candidate', '丢响应不得显示 candidate');
  assert.equal(result.report.stoppedReason, 'TEST_DRIVER_STORAGE_UNAVAILABLE');
  // 存储里的记录已被注入破坏，这里只核对「运行结论」而不复述被篡改的落盘内容
  assert.equal(result.ok, false);
});

test('S3-4 回读被改 binding / 回退旧内容 → 保守停止', async () => {
  const mutators = [
    ['binding', doc => { doc.cases['V06-a'].binding.projectId = 'p_tampered'; }],
    ['old-content', doc => { doc.cases['V06-a'].responses = [{ requestId: 'r-a-1', outcome: 'timeout' }]; }]
  ];
  for (const entry of mutators) {
    const label = entry[0];
    const mutate = entry[1];
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const orig = storage.setStorageSync;
    let injected = false;
    storage.setStorageSync = (key, value) => {
      const doc = JSON.parse(value);
      if (!injected && doc.cases && doc.cases['V06-a'] && doc.cases['V06-a'].state === 'candidate') {
        injected = true;
        mutate(doc);
        orig(key, JSON.stringify(doc));
        return;
      }
      orig(key, value);
    };
    const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
    const result = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.equal(injected, true, label + ' 注入点必须触发');
    assert.notEqual(result.report.verdict, 'candidate', label + ' 被改后不得显示 candidate');
  }
});

// ── S4：当前安排语义与查询前提 ─────────────────────────────────────────

test('S4-1 当前 expectedDate ≠ endDate → 明确停止、零 update', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const current = scheduleOk({ id: 's_review01', version: 7, expectedDate: '2026-11-05', endDate: '2026-11-03' });
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (data.action === 'createSchedule') return { result: scheduleOk() };
      if (data.action === 'getSchedule') return { result: { ok: true, schedule: current } };
      return { result: { ok: false, code: 'VERSION_MISMATCH' } };
    }
  });
  await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  coordinator.acceptCloudReview(ctxFor(storage), 'V06-a', 'mgmt-review-1');
  api.__calls.length = 0;
  const c = await drv.runCase({
    api, testCaseId: 'V06-c',
    input: baseInput({ scheduleId: 's_review01', expectedVersion: 7, content1: 'a', content2: 'b', reason: 'r' })
  });
  assert.equal(c.ok, false);
  assert.equal(c.code, 'TEST_DRIVER_CURRENT_DATES_NOT_EQUAL');
  assert.equal(writes(api).length, 0, '日期不等必须零 update');
  assert.deepEqual(c.report.currentDates, { expectedDate: '2026-11-05', endDate: '2026-11-03' });
});

test('S4-2 当前安排缺 expectedDate / restDays 非法 → 停止', async () => {
  const variants = [
    ['no-expected', scheduleOk({ expectedDate: undefined })],
    ['restDays-not-array', scheduleOk({ restDays: 'not-an-array' })],
    ['restDays-bad-item', scheduleOk({ restDays: [1] })]
  ];
  for (const entry of variants) {
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const current = entry[1];
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
        if (data.action === 'createSchedule') return { result: scheduleOk() };
        if (data.action === 'getSchedule') return { result: { ok: true, schedule: current } };
        return { result: { ok: false, code: 'VERSION_MISMATCH' } };
      }
    });
    await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    coordinator.acceptCloudReview(ctxFor(storage), 'V06-a', 'mgmt-review-1');
    api.__calls.length = 0;
    const c = await drv.runCase({
      api, testCaseId: 'V06-c',
      input: baseInput({ scheduleId: 's_review01', expectedVersion: 1, content1: 'a', content2: 'b', reason: 'r' })
    });
    assert.equal(c.ok, false, entry[0]);
    assert.equal(c.code, 'TEST_DRIVER_CURRENT_SCHEDULE_UNKNOWN', entry[0]);
    assert.equal(writes(api).length, 0, entry[0] + ' 必须零 update');
  }
});

test('S4-3 listSchedules 结果不可信 → 前提未知、零移出', async () => {
  const emptyPage = { limit: 100, hasMore: false, nextCursor: null };
  const goodRow = {
    stage: '拆改', trade: '拆改', workerUserId: WORKER_B,
    startDate: '2026-11-02', endDate: '2026-11-03', content: 'c', restDays: []
  };
  const variants = [
    ['ok-false', { ok: false, schedules: [], pagination: emptyPage }],
    ['hasMore-missing', { ok: true, schedules: [], pagination: { limit: 100 } }],
    ['hasMore-not-boolean', { ok: true, schedules: [], pagination: { limit: 100, hasMore: 'no' } }],
    ['pagination-missing', { ok: true, schedules: [] }],
    ['bad-row-no-id', { ok: true, schedules: [Object.assign({ id: undefined, projectId: PROJECT, status: 'active', version: 1 }, goodRow)], pagination: emptyPage }],
    ['bad-row-wrong-project', { ok: true, schedules: [scheduleOk({ projectId: 'p_other' })], pagination: emptyPage }],
    ['bad-row-not-active', { ok: true, schedules: [scheduleOk({ status: 'cancelled' })], pagination: emptyPage }],
    ['bad-row-version-zero', { ok: true, schedules: [scheduleOk({ version: 0 })], pagination: emptyPage }],
    ['bad-row-content-object', { ok: true, schedules: [scheduleOk({ content: { token: 'X' } })], pagination: emptyPage }],
    ['cursor-loop', { ok: true, schedules: [], pagination: { limit: 100, hasMore: true, nextCursor: 'c1' } }]
  ];
  for (const entry of variants) {
    const label = entry[0];
    const payload = entry[1];
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({
      storage,
      handler: async data => {
        if (data.action === 'listSchedules') return { result: clone(payload) };
        if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
        return { result: { userId: WORKER_B, status: 'left' } };
      }
    });
    const r = await drv.runCase({ api, testCaseId: 'V07-B', input: { projectId: PROJECT, userId: WORKER_B } });
    assert.equal(r.ok, false, label);
    assert.equal(r.code, 'TEST_DRIVER_V07_PRECONDITION_UNKNOWN', label + ': ' + r.report.stoppedReason);
    assert.equal(writes(api).length, 0, label + ' 必须零移出');
  }
});

test('S4-4 成功响应的嵌套/非法字段不得进入报告或持久存储', async () => {
  const variants = [
    ['content-object', scheduleOk({ content: { token: 'SYNTHETIC_SECRET_MARKER' } })],
    ['content-array', scheduleOk({ content: ['SYNTHETIC_SECRET_MARKER'] })],
    ['restDays-objects', scheduleOk({ restDays: [{ token: 'SYNTHETIC_SECRET_MARKER' }] })],
    ['version-string', scheduleOk({ version: '1' })]
  ];
  for (const entry of variants) {
    const label = entry[0];
    const payload = entry[1];
    resetAll();
    const drv = loadDriver(openProof());
    const storage = makeStorage();
    const api = makeApi({ storage, handler: defaultHandler(() => payload) });
    const r = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
    assert.notEqual(r.report.verdict, 'candidate', label + ' 不得判候选');
    assert.equal(JSON.stringify(storage.store).includes('SYNTHETIC_SECRET_MARKER'), false, label + ' 不得落盘');
    assert.equal(JSON.stringify(r.report).includes('SYNTHETIC_SECRET_MARKER'), false, label + ' 不得进报告');
  }
});

test('S4-5 正常公开成功响应仍可通过（不因收紧而误拒）', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeApi({ storage, handler: defaultHandler(() => scheduleOk()) });
  const r = await drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() });
  assert.equal(r.report.verdict, 'candidate', r.report.stoppedReason || '');
});
// ── S3-a：全部同步抛错时必须能收尾 ─────────────────────────────────────

/**
 * 合成**非 async** 的 callFunction，确保抛出的是**真正的同步异常**。
 * 若用 async 函数内部 throw，会变成 promise rejection，走不到同步抛错分支。
 */
function makeSyncThrowApi(storage, options) {
  const opts = options || {};
  const calls = [];
  let invoked = 0;
  return {
    storage,
    getStorageInfoSync: storage.getStorageInfoSync,
    getAccountInfoSync: () => ({ miniProgram: { appId: APPID, envVersion: 'develop', version: '1.0.0' } }),
    cloud: {
      // 关键：**不是 async**，throw 在调用栈上同步抛出
      callFunction(args) {
        calls.push(clone(args.data));
        if (args.data.action === 'identify') return Promise.resolve({ result: clone(IDENTIFY_OK) });
        if (args.data.action === 'getMembers') return Promise.resolve({ result: clone(MEMBERS_OK) });
        if (args.data.action === 'listSchedules') {
          return Promise.resolve({ result: { ok: true, schedules: [], pagination: { limit: 100, hasMore: false, nextCursor: null } } });
        }
        invoked++;
        if (opts.throwOn === undefined || invoked <= opts.throwOn) {
          throw new Error('synthetic synchronous send failure');
        }
        return Promise.resolve(opts.result || { result: scheduleOk() });
      }
    },
    __calls: calls,
    __invoked: () => invoked
  };
}

test('S3-a V06 两笔均同步抛错 → 返回 stopped/UNKNOWN_RESULT、占用已释放', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeSyncThrowApi(storage);
  const result = await Promise.race([
    drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() }),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 200))
  ]);
  assert.equal(result.timedOut, undefined, '全部同步抛错时 runCase 必须能结束，不得挂起');
  assert.equal(result.ok, false);
  assert.equal(result.report.verdict, 'stopped');
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT', '同步异常属结果未知');
  assert.equal(api.__invoked(), 2, '两笔都已调用');
  assert.equal(writes(api).length, 2, '不补发第三笔');
  // 运行时占用按 finally 释放
  assert.equal(coordinator.peekRuntimeHold().held, false, '收尾后不得残留运行时占用');
  // 持久防重保留
  const rec = coordinator.readCase(ctxFor(storage), 'V06-a');
  assert.equal(rec.status, 'ok');
  assert.equal(rec.record.state, 'stopped');
  assert.deepEqual(rec.record.responses.map(r => r.outcome).sort(), ['sync-throw', 'sync-throw']);
  assert.ok(rec.record.responses.every(r => r.invoked === true));
});

test('S3-a V07 唯一移出调用同步抛错 → 返回 stopped、占用已释放', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeSyncThrowApi(storage, {
    result: { result: { userId: WORKER_B, status: 'left' } }
  });
  const result = await Promise.race([
    drv.runCase({ api, testCaseId: 'V07-B', input: { projectId: PROJECT, userId: WORKER_B } }),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 200))
  ]);
  assert.equal(result.timedOut, undefined, '单笔同步抛错时 runCase 必须能结束');
  assert.equal(result.ok, false);
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');
  assert.equal(api.__invoked(), 1);
  assert.equal(coordinator.peekRuntimeHold().held, false, '收尾后不得残留运行时占用');
  const rec = coordinator.readCase(ctxFor(storage), 'V07-B');
  assert.equal(rec.record.state, 'stopped');
  assert.deepEqual(rec.record.responses.map(r => r.outcome), ['sync-throw']);
});

test('S3-a 单笔同步抛错 + 另一笔异步成功 → 正常收尾并停止', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeSyncThrowApi(storage, { throwOn: 1 });
  const result = await Promise.race([
    drv.runCase({ api, testCaseId: 'V06-a', input: baseInput() }),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 200))
  ]);
  assert.equal(result.timedOut, undefined, '混合分支也必须能收尾');
  assert.equal(result.ok, false);
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');
  const rec = coordinator.readCase(ctxFor(storage), 'V06-a');
  const outcomes = rec.record.responses.map(r => r.outcome).sort();
  assert.deepEqual(outcomes, ['responded', 'sync-throw']);
  assert.equal(coordinator.peekRuntimeHold().held, false);
});

// ── S3-b：超时后的晚到结果必须补留证 ─────────────────────────────────

/** 造一个「可控完成」的合成 API：每笔业务请求都返回可手动结算的 promise。 */
function makeManualApi(storage) {
  const calls = [];
  const ctl = [];
  let n = 0;
  return {
    storage,
    getStorageInfoSync: storage.getStorageInfoSync,
    getAccountInfoSync: () => ({ miniProgram: { appId: APPID, envVersion: 'develop', version: '1.0.0' } }),
    cloud: {
      async callFunction(args) {
        calls.push(clone(args.data));
        if (args.data.action === 'identify') return { result: clone(IDENTIFY_OK) };
        if (args.data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
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

test('S3-b 超时后晚到成功 → 补存净化证据、保留 stopped/timeout、不回写状态', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeManualApi(storage);
  const timers = [];
  const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers: clock });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(api.__ctl.length, 2, '两笔都已发出');
  // 第二笔正常成功
  api.__ctl[1].resolve({ result: scheduleOk() });
  await new Promise(resolve => setTimeout(resolve, 15));
  // 只让第一笔超时（identify/getMembers 也用同一 timers，槽位计时器在其后）
  timers[2]();
  const result = await running;
  assert.equal(result.report.verdict, 'stopped');
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');

  const key = coordinator.batchKey(ENV_ID, 'round-test-1');
  const stateBefore = JSON.parse(storage.store[key]).cases['V06-a'].state;
  const storeBefore = storage.store[key];

  // 晚到成功
  api.__ctl[0].resolve({ result: scheduleOk({ content: 'LATE_ARRIVED_CONTENT' }) });
  await new Promise(resolve => setTimeout(resolve, 25));

  const rec = JSON.parse(storage.store[key]).cases['V06-a'];
  assert.notEqual(storage.store[key], storeBefore, '晚到结果必须被补存');
  assert.equal(rec.state, stateBefore, '不得回写状态（stopped 不能变 inFlight/candidate）');
  assert.equal(rec.state, 'stopped');
  assert.deepEqual(rec.responses.map(r => r.outcome).sort(), ['responded', 'timeout'], '主槽位结论保留 timeout');
  assert.equal(Array.isArray(rec.lateArrivals), true);
  assert.equal(rec.lateArrivals.length, 1);
  assert.equal(rec.lateArrivals[0].outcome, 'responded');
  assert.equal(rec.lateArrivals[0].late, true, '晚到证据必须标记');
  assert.equal(rec.lateArrivals[0].result.content, 'LATE_ARRIVED_CONTENT', '补存的是净化后的公开字段');
});

test('S3-b 超时后晚到拒绝 → 补存 network-error、保留原判定', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeManualApi(storage);
  const timers = [];
  const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers: clock });
  await new Promise(resolve => setTimeout(resolve, 20));
  api.__ctl[1].resolve({ result: scheduleOk() });
  await new Promise(resolve => setTimeout(resolve, 15));
  timers[2]();
  const result = await running;
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');

  api.__ctl[0].reject(new Error('late network failure'));
  await new Promise(resolve => setTimeout(resolve, 25));

  const key = coordinator.batchKey(ENV_ID, 'round-test-1');
  const rec = JSON.parse(storage.store[key]).cases['V06-a'];
  assert.equal(rec.state, 'stopped');
  assert.equal(rec.lateArrivals.length, 1);
  assert.equal(rec.lateArrivals[0].outcome, 'network-error');
  assert.equal(rec.lateArrivals[0].late, true);
  assert.deepEqual(rec.responses.map(r => r.outcome).sort(), ['responded', 'timeout']);
});

test('S3-b 晚到成功但补存失败 → 仍保守停止、不改判', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeManualApi(storage);
  const orig = storage.setStorageSync;
  let failLate = false;
  storage.setStorageSync = (k, v) => {
    if (failLate && v.includes('lateArrivals')) throw new Error('synthetic late persist failure');
    orig(k, v);
  };
  const timers = [];
  const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers: clock });
  await new Promise(resolve => setTimeout(resolve, 20));
  api.__ctl[1].resolve({ result: scheduleOk() });
  await new Promise(resolve => setTimeout(resolve, 15));
  timers[2]();
  const result = await running;
  assert.equal(result.report.verdict, 'stopped');

  failLate = true;
  api.__ctl[0].resolve({ result: scheduleOk({ content: 'LATE' }) });
  await new Promise(resolve => setTimeout(resolve, 25));

  const key = coordinator.batchKey(ENV_ID, 'round-test-1');
  const rec = JSON.parse(storage.store[key]).cases['V06-a'];
  // 补存失败：原 stopped 结论与原 timeout 证据都不得被破坏
  assert.equal(rec.state, 'stopped');
  assert.deepEqual(rec.responses.map(r => r.outcome).sort(), ['responded', 'timeout']);
});

test('S3-b 相同 requestId 的两笔按各自槽位区分晚到证据', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const api = makeManualApi(storage);
  const timers = [];
  const clock = { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
  // V06-a 两笔同 requestId
  const running = drv.runCase({
    api, testCaseId: 'V06-a',
    input: baseInput({ requestId1: 'same-id', requestId2: 'same-id' }),
    timers: clock
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  api.__ctl[1].resolve({ result: scheduleOk({ content: 'SECOND_OK' }) });
  await new Promise(resolve => setTimeout(resolve, 15));
  timers[2](); // 只让第一笔超时
  const result = await running;
  assert.equal(result.report.stoppedReason, 'UNKNOWN_RESULT');

  api.__ctl[0].resolve({ result: scheduleOk({ content: 'FIRST_LATE_OK' }) });
  await new Promise(resolve => setTimeout(resolve, 25));

  const key = coordinator.batchKey(ENV_ID, 'round-test-1');
  const rec = JSON.parse(storage.store[key]).cases['V06-a'];
  assert.equal(rec.state, 'stopped');
  assert.equal(rec.lateArrivals.length, 1, '只有超时那一槽产生晚到证据');
  assert.equal(rec.lateArrivals[0].result.content, 'FIRST_LATE_OK');
  assert.equal(rec.responses.length, 2, '两个槽位各自保留自己的主记录');
  assert.deepEqual(rec.responses.map(r => r.outcome).sort(), ['responded', 'timeout']);
});
// ── S3-b 返修：读失败不得回写 + 稳定槽位编号 ──────────────────────────

test('S3-b2 主响应与晚到证据都带稳定槽位编号', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  let resolveSecond = null;
  let n = 0;
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (++n === 1) return new Promise(() => {});
      return new Promise(resolve => { resolveSecond = resolve; });
    }
  });
  const pending = [];
  const timers = { setTimeout: fn => { pending.push(fn); return pending.length; }, clearTimeout: () => {} };
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 12; i++) await tick();
  for (const fn of pending) { try { fn(); } catch (e) { /* 忽略 */ } }
  const outcome = await running;
  assert.equal(outcome.report.stoppedReason, 'UNKNOWN_RESULT');
  const timedOut = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  // 主响应：每条都有唯一、连续的槽位编号
  assert.deepEqual(timedOut.responses.map(r => r.slotIndex), [0, 1], '主响应必须带槽位编号');
  // 晚到证据也带编号
  resolveSecond({ result: scheduleOk({ content: 'LATE_WITH_SLOT' }) });
  for (let i = 0; i < 6; i++) await tick();
  const rec = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  assert.equal(rec.state, 'stopped');
  assert.equal(rec.lateArrivals.length, 1);
  assert.equal(rec.lateArrivals[0].slotIndex, 1, '晚到证据必须标明来自哪个槽位');
  assert.equal(rec.lateArrivals[0].result.content, 'LATE_WITH_SLOT');
});

test('S3-b2 同号双超时：第二槽先晚到、第一槽随后晚到 → 各自关联正确', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  const controls = [];
  const timers = new Map();
  let tid = 0;
  const clock = {
    setTimeout: fn => { timers.set(++tid, fn); return tid; },
    clearTimeout: id => { timers.delete(id); }
  };
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      return new Promise((resolve, reject) => controls.push({ resolve, reject }));
    }
  });
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers: clock });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 30 && controls.length < 2; i++) await tick();
  assert.equal(controls.length, 2, '两笔都应发出');
  for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  const outcome = await running;
  assert.equal(outcome.report.verdict, 'stopped');
  const afterTimeout = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  assert.deepEqual(afterTimeout.responses.map(r => r.slotIndex), [0, 1]);
  assert.deepEqual(afterTimeout.responses.map(r => r.requestId), ['r-a-1', 'r-a-1'], '本例两笔同号');
  assert.deepEqual(afterTimeout.responses.map(r => r.outcome), ['timeout', 'timeout']);
  assert.equal(afterTimeout.state, 'stopped');

  // 第二槽先晚到成功
  controls[1].resolve({ result: scheduleOk({ content: 'SECOND_SLOT_LATE' }) });
  for (let i = 0; i < 6; i++) await tick();
  const mid = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  assert.equal(mid.lateArrivals.length, 1);
  assert.equal(mid.lateArrivals[0].slotIndex, 1, '先到的晚到必须标为槽位 1');
  assert.equal(mid.lateArrivals[0].result.content, 'SECOND_SLOT_LATE');

  // 第一槽随后晚到拒绝
  controls[0].reject(new Error('late network failure for slot 0'));
  for (let i = 0; i < 6; i++) await tick();
  const rec = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  assert.equal(rec.lateArrivals.length, 2, '两条晚到证据并存');
  const bySlot = new Map(rec.lateArrivals.map(v => [v.slotIndex, v]));
  assert.equal(bySlot.size, 2, '两个槽位各自一条，编号不重复');
  assert.equal(bySlot.get(0).outcome, 'network-error', '槽位 0 是拒绝');
  assert.equal(bySlot.get(1).outcome, 'responded', '槽位 1 是成功');
  assert.equal(bySlot.get(1).result.content, 'SECOND_SLOT_LATE');
  // 主记录与判定不变
  assert.deepEqual(rec.responses.map(r => r.outcome), ['timeout', 'timeout']);
  assert.equal(rec.state, 'stopped', '两笔晚到都不得改写停止状态');
  assert.equal(writes(api).length, 2, '不得补发');
  assert.ok(
    coordinator.blockingCases(ctxFor(storage)).blocking.some(b => b.testCaseId === 'V06-a' && b.state === 'stopped'),
    '下一例仍被持久防重阻断'
  );
});

test('S3-b2 晚到补存时首次读取失败 → 放弃补存、原记录与状态逐字节不变', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  let resolveSecond = null;
  let n = 0;
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (++n === 1) return new Promise(() => {});
      return new Promise(resolve => { resolveSecond = resolve; });
    }
  });
  const pending = [];
  const timers = { setTimeout: fn => { pending.push(fn); return pending.length; }, clearTimeout: () => {} };
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 12; i++) await tick();
  for (const fn of pending) { try { fn(); } catch (e) { /* 忽略 */ } }
  const outcome = await running;
  assert.equal(outcome.report.verdict, 'stopped');

  const batchKey = coordinator.batchKey(ENV_ID, 'round-test-1');
  const before = storage.store[batchKey];
  assert.ok(before, '应有批次记录');
  assert.equal(JSON.parse(before).cases['V06-a'].state, 'stopped');

  // 只让下一次读抛一次错，其后恢复正常
  const original = storage.getStorageSync;
  let thrown = 0;
  storage.getStorageSync = key => {
    if (thrown++ === 0) throw new Error('synthetic one-shot read failure');
    return original(key);
  };
  resolveSecond({ result: scheduleOk({ content: 'LATE_AFTER_READ_FAILURE' }) });
  for (let i = 0; i < 6; i++) await tick();
  storage.getStorageSync = original;

  assert.equal(thrown > 0, true, '注入的读失败必须被触发');
  assert.equal(storage.store[batchKey], before, '读失败时存储必须逐字节不变');
  const rec = coordinator.readCase(ctxFor(storage), 'V06-a').record;
  assert.equal(rec.state, 'stopped', '不得回写成 inFlight');
  assert.deepEqual(rec.responses.map(r => r.outcome).sort(), ['timeout', 'timeout']);
  assert.equal(rec.lateArrivals, undefined, '读失败时不得写入任何晚到证据');
  assert.equal(writes(api).length, 2, '不得补发');
});

test('S3-b2 补存失败（写异常）→ 保守停止并给出可核对原因', async () => {
  resetAll();
  const drv = loadDriver(openProof());
  const storage = makeStorage();
  let resolveSecond = null;
  let n = 0;
  const api = makeApi({
    storage,
    handler: async data => {
      if (data.action === 'identify') return { result: clone(IDENTIFY_OK) };
      if (data.action === 'getMembers') return { result: clone(MEMBERS_OK) };
      if (++n === 1) return new Promise(() => {});
      return new Promise(resolve => { resolveSecond = resolve; });
    }
  });
  const pending = [];
  const timers = { setTimeout: fn => { pending.push(fn); return pending.length; }, clearTimeout: () => {} };
  const running = drv.runCase({ api, testCaseId: 'V06-a', input: baseInput(), timers });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 12; i++) await tick();
  for (const fn of pending) { try { fn(); } catch (e) { /* 忽略 */ } }
  const outcome = await running;
  assert.equal(outcome.report.verdict, 'stopped');

  // 后续所有写都抛错：补存必须失败且保守停止
  storage.setStorageSync = () => { throw new Error('synthetic write failure'); };
  resolveSecond({ result: scheduleOk({ content: 'LATE_WRITE_FAILS' }) });
  for (let i = 0; i < 6; i++) await tick();

  const rec = coordinator.readCase(ctxFor(storage), 'V06-a');
  assert.equal(rec.status === 'ok' ? rec.record.state : '(无)', 'stopped', '写失败时状态停在 stopped');
  assert.equal(rec.record.responses.length, 2, '主证据未被破坏');
});