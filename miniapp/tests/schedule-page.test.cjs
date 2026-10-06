const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSeed } = require('../miniprogram/utils/seed');

const TODAY = new Date().toISOString().slice(0, 10);

function baseRequire(name, storeData, calls, extra = {}) {
  if (name.includes('store')) {
    return {
      read: () => JSON.parse(JSON.stringify(storeData)),
      write: state => { Object.assign(storeData, JSON.parse(JSON.stringify(state))); },
      uid: prefix => `${prefix}-test-id`
    };
  }
  if (name.includes('business')) return require('../miniprogram/utils/business');
  if (name.includes('seed')) return require('../miniprogram/utils/seed');
  if (name.includes('date')) return require('../miniprogram/utils/date');
  if (name.includes('ui')) {
    return {
      // 默认抛出以保持既有测试语义；extra.failures 存在时改为记录不抛，便于断言可恢复错误
      fail: error => { if (extra.failures) { extra.failures.push(error); return; } throw error; },
      go: url => { calls.push({ type: 'navigate', url }); },
      context: (state, projectId) => {
        const project = state.projects.find(item => item.id === projectId);
        const member = state.members.find(item => item.projectId === projectId && item.userId === state.currentUserId && item.status === 'active');
        return { project, account: state.accounts.find(item => item.id === state.currentUserId), roleText: member ? member.roles.join('、') : '负责人', canManage: !!(member && member.roles.includes('管家')) };
      }
    };
  }
  if (name.includes('schedule-client')) {
    if (extra.scheduleClient) return extra.scheduleClient;
    return {
      checkEntry: () => ({ allowed: false, reason: '施工安排入口未启用。' }),
      getScheduleContext: async () => { throw new Error('should not call'); },
      getSchedule: async () => { throw new Error('should not call'); },
      listScheduleRevisions: async () => ({ revisions: [] }),
      createSchedule: async () => { throw new Error('should not call'); },
      updateSchedule: async () => { throw new Error('should not call'); }
    };
  }
  return {};
}

// 让真实 schedule-client 参与页面测试：入口 proof 以 enabled=true + 允许项目注入，
// wx.cloud.callFunction 由测试控制，从而验证真实错误分类与响应结构校验在页面中的表现。
function withRealClient(extra, callFunction) {
  const proofPath = require.resolve('../miniprogram/config/schedule-entry-proof');
  const clientPath = require.resolve('../miniprogram/utils/schedule-client');
  const envGatePath = require.resolve('../miniprogram/utils/env-gate');
  const saved = {
    proof: require.cache[proofPath],
    client: require.cache[clientPath],
    envGate: require.cache[envGatePath],
    wx: global.wx
  };
  const allowedProjectIds = (extra.allowedProjectIds || ['p_cloud']);
  require.cache[proofPath] = {
    id: proofPath, filename: proofPath, loaded: true,
    exports: {
      enabled: true,
      appId: 'wxfb4db1615ac15531',
      envId: 'cloud1-d8gcq5ag39d847723',
      allowedProjectIds,
      allowedVersions: ['develop', 'trial']
    }
  };
  delete require.cache[clientPath];
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    cloud: { callFunction }
  };
  const realClient = require('../miniprogram/utils/schedule-client');
  extra.scheduleClient = realClient;
  extra.restore = () => {
    if (saved.proof) require.cache[proofPath] = saved.proof; else delete require.cache[proofPath];
    if (saved.client) require.cache[clientPath] = saved.client; else delete require.cache[clientPath];
    if (saved.envGate) require.cache[envGatePath] = saved.envGate; else delete require.cache[envGatePath];
    if (saved.wx === undefined) delete global.wx; else global.wx = saved.wx;
  };
  return extra;
}

function buildContext(extra = {}) {
  const storeData = createSeed(TODAY);
  const calls = [];
  return {
    require: name => (extra.require ? extra.require(name) : baseRequire(name, storeData, calls, extra)),
    Page: value => { extra.definition = value; },
    wx: {
      getStorageSync: () => null,
      setStorageSync: () => {},
      getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
      showToast: args => { calls.push({ type: 'toast', ...args }); },
      showModal: args => { calls.push({ type: 'modal', ...args }); },
      navigateBack: () => { calls.push({ type: 'navigateBack' }); },
      previewImage: () => {},
      cloud: { callFunction: async args => { calls.push(args); return extra.callFunction ? extra.callFunction(args) : { result: { ok: false, code: 'ENTRY_DISABLED' } }; } }
    },
    getApp: () => ({ globalData: {} }),
    calls
  };
}

function loadSchedulePage(extra = {}) {
  const ctx = buildContext(extra);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/schedule/schedule.js'), 'utf8'), ctx);
  const page = { ...extra.definition, data: { ...extra.definition.data }, setData(values) { Object.assign(this.data, values); }, ctx };
  return { definition: extra.definition, calls: ctx.calls, ctx, page };
}

function loadScheduleDetailPage(extra = {}) {
  const ctx = buildContext(extra);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/schedule-detail/schedule-detail.js'), 'utf8'), ctx);
  const page = { ...extra.definition, data: { ...extra.definition.data }, setData(values) { Object.assign(this.data, values); }, ctx };
  return { definition: extra.definition, calls: ctx.calls, page };
}

function loadProjectPage(extra = {}) {
  const ctx = buildContext(extra);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/project/project.js'), 'utf8'), ctx);
  const page = { ...extra.definition, data: { ...extra.definition.data }, setData(values) { Object.assign(this.data, values); }, ctx };
  return { definition: extra.definition, calls: ctx.calls, page };
}

test('schedule page initializes local form for manager', () => {
  const { page } = loadSchedulePage();
  page.onLoad({ projectId: 'demo-a' });
  assert.equal(page.data.project.name, '示例甲 · 晴川居');
  assert.equal(page.data.canManage, true);
  assert.equal(page.data.mode, 'local');
  assert.equal(page.data.form.trade, '水电');
  assert.equal(page.data.workers.length > 0, true);
});

test('schedule page rejects non-manager', () => {
  const customRequire = name => {
    if (name.includes('store')) {
      const state = createSeed(TODAY);
      state.currentUserId = 'owner';
      return { read: () => JSON.parse(JSON.stringify(state)), write: () => {}, uid: prefix => `${prefix}-test-id` };
    }
    return baseRequire(name, createSeed(TODAY), [], {});
  };
  const { page } = loadSchedulePage({ require: customRequire });
  page.onLoad({ projectId: 'demo-a' });
  assert.equal(page.data.error, '仅项目管家可以维护施工安排。');
});

test('schedule page saves local schedule', () => {
  const { page, calls } = loadSchedulePage();
  page.onLoad({ projectId: 'demo-a' });
  page.data.form.workerId = 'electric';
  page.data.form.content = '本地测试施工内容';
  page.save();
  assert.equal(calls.some(c => c.type === 'navigateBack'), true);
});

test('schedule page cloud path does not fall back to local when entry disabled', () => {
  const scheduleClient = {
    checkEntry: () => ({ allowed: false, reason: '入口关闭' }),
    getScheduleContext: async () => { throw new Error('should not call'); }
  };
  const { page, calls } = loadSchedulePage({ scheduleClient });
  page.onLoad({ projectId: 'p_real_cloud' });
  assert.equal(page.data.error, '入口关闭');
  assert.equal(calls.filter(c => c.type === 'toast').length, 0);
});

test('schedule page cloud create uses cloud save and stable mode', async () => {
  const calls = [];
  const scheduleClient = {
    checkEntry: () => ({ allowed: true }),
    getScheduleContext: async () => ({
      project: { id: 'p_cloud', name: '云端项目' },
      trades: ['水电'],
      workers: [{ userId: 'u_worker', label: '师傅甲', trades: ['水电'] }],
      isManager: true
    }),
    createSchedule: async (projectId, form, options) => {
      calls.push({ type: 'createSchedule', projectId, form, options });
      return { scheduleId: 's_cloud', version: 1, status: 'active' };
    }
  };
  const { page } = loadSchedulePage({ scheduleClient });
  page.onLoad({ projectId: 'p_cloud' });
  // 等待 Promise 完成
  await new Promise(r => setTimeout(r, 10));
  page.data.form.content = '云端测试内容';
  page.data.form.workerId = 'u_worker';
  page.save();
  assert.equal(calls[0].type, 'createSchedule');
  assert.equal(calls[0].form.content, '云端测试内容');
  assert.equal(typeof calls[0].options.requestId, 'string');
});

test('schedule page requires expectedDate confirmation when different from end', () => {
  const { page } = loadSchedulePage();
  page.onLoad({ projectId: 'demo-a' });
  page.setData({ 'form.expected': '2099-01-01' });
  page.input({ currentTarget: { dataset: { field: 'expected' } }, detail: { value: '2099-01-01' } });
  assert.equal(page.data.expectedDateMismatch, true);
});

test('schedule-detail page shows local schedule and history', () => {
  const { page } = loadScheduleDetailPage();
  page.onLoad({ projectId: 'demo-a', id: 'electric-plan' });
  assert.equal(page.data.schedule.trade, '水电');
  assert.equal(page.data.revisions.length, 0);
  assert.equal(page.data.schedule.hasRestDays, true);
});

test('schedule-detail page shows cancel button for active manager', () => {
  const { page } = loadScheduleDetailPage();
  page.onLoad({ projectId: 'demo-a', id: 'electric-plan' });
  assert.equal(page.data.canManage, true);
  assert.equal(page.data.schedule.status !== 'cancelled', true);
});

test('schedule-detail page clears stale data on cloud load error', async () => {
  const scheduleClient = {
    checkEntry: () => ({ allowed: true }),
    getScheduleContext: async () => { throw new Error('网络错误'); },
    getSchedule: async () => { throw new Error('网络错误'); },
    listScheduleRevisions: async () => { throw new Error('网络错误'); }
  };
  const { page } = loadScheduleDetailPage({ scheduleClient });
  page.onLoad({ projectId: 'p_cloud', id: 's_1' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(page.data.error, '网络错误');
  assert.equal(page.data.schedule, null);
  assert.equal(page.data.revisions.length, 0);
});

test('project page add plan navigates to schedule form', () => {
  const { page, calls } = loadProjectPage();
  page.onLoad({ id: 'demo-a' });
  page.addPlan();
  assert.equal(calls.some(c => c.type === 'navigate' && c.url.includes('/pages/schedule/schedule?')), true);
  assert.equal(calls.some(c => c.type === 'navigate' && c.url.includes('schedule-detail')), false);
});

test('project page cloud list shows cancelled schedule by date', async () => {
  const calls = [];
  const scheduleClient = {
    checkEntry: () => ({ allowed: true }),
    getScheduleContext: async () => ({ project: { id: 'p_cloud', name: '云端项目' }, trades: ['水电'], workers: [], isManager: false }),
    listSchedules: async (projectId, filters) => {
      calls.push(filters);
      return {
        schedules: [{ id: 's_cancelled', trade: '水电', stage: '水电隐蔽工程', workerUserId: 'u_worker', startDate: '2026-10-01', endDate: '2026-10-03', expectedDate: '2026-10-03', content: '已取消', status: 'cancelled', version: 2 }],
        pagination: { hasMore: false, nextCursor: null }
      };
    }
  };
  const { page } = loadProjectPage({ scheduleClient });
  page.onLoad({ id: 'p_cloud' });
  page.onShow();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(page.data.schedules.length, 1);
  assert.equal(page.data.schedules[0].status.text, '已取消');
});

test('project page edit plan navigates to schedule detail', () => {
  const { page, calls } = loadProjectPage();
  page.onLoad({ id: 'demo-a' });
  page.editPlan({ currentTarget: { dataset: { id: 'electric-plan' } } });
  assert.equal(calls.some(c => c.type === 'navigate' && c.url.includes('/pages/schedule-detail/schedule-detail?')), true);
});

test('cloud schedule page rejects non-manager', async () => {
  const scheduleClient = {
    checkEntry: () => ({ allowed: true }),
    getScheduleContext: async () => ({ project: { id: 'p_cloud', name: '云端项目' }, trades: ['水电'], workers: [], isManager: false })
  };
  const { page } = loadSchedulePage({ scheduleClient });
  page.onLoad({ projectId: 'p_cloud' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(page.data.error, '仅项目管家可以维护施工安排。');
  assert.equal(page.data.canManage, false);
});

test('cloud schedule save retries same requestId when result unknown, blocks edit and prevents duplicate', async () => {
  const calls = [];
  const scheduleClient = {
    checkEntry: () => ({ allowed: true }),
    getScheduleContext: async () => ({
      project: { id: 'p_cloud', name: '云端项目' },
      trades: ['水电'],
      workers: [{ userId: 'u_worker', label: '师傅甲', trades: ['水电'] }],
      isManager: true
    }),
    createSchedule: async (projectId, form, options) => {
      calls.push({ type: 'createSchedule', projectId, form, options });
      if (calls.length === 1) throw Object.assign(new Error('网络超时'), { code: 'TIMEOUT' });
      return { scheduleId: 's_cloud', version: 1, status: 'active' };
    }
  };
  const { page } = loadSchedulePage({ scheduleClient });
  page.onLoad({ projectId: 'p_cloud' });
  await new Promise(r => setTimeout(r, 10));
  page.data.form.content = '云端测试内容';
  page.data.form.workerId = 'u_worker';
  page.save();
  await new Promise(r => setTimeout(r, 10));
  const firstRequestId = calls[0].options.requestId;
  assert.ok(firstRequestId);
  assert.equal(page.data.pendingRequest.state, 'unknown');
  // 结果未知时修改内容被阻止
  page.input({ currentTarget: { dataset: { field: 'content' } }, detail: { value: '新内容' } });
  assert.equal(page.data.error.includes('未确认提交'), true);
  // 重试必须复用同一 requestId 和原内容
  page.retryPending();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls[1].options.requestId, firstRequestId);
  assert.equal(calls[1].form.content, '云端测试内容');
  assert.equal(page.data.pendingRequest, null);
  // 成功后再次保存为新操作，应换号
  page.save();
  await new Promise(r => setTimeout(r, 10));
  assert.notEqual(calls[2].options.requestId, firstRequestId);
});

test('schedule-detail page loads more revisions with cursor', async () => {
  let revisionCalls = [];
  const scheduleClient = {
    checkEntry: () => ({ allowed: true }),
    getScheduleContext: async () => ({ project: { id: 'p_cloud', name: '云端项目' }, workers: [], isManager: false }),
    getSchedule: async () => ({ schedule: { id: 's_1', trade: '水电', stage: '水电隐蔽工程', workerUserId: 'u_worker', startDate: '2026-10-01', endDate: '2026-10-03', expectedDate: '2026-10-03', content: 'x', status: 'active', version: 4 } }),
    listScheduleRevisions: async (projectId, scheduleId, filters) => {
      revisionCalls.push(filters);
      if (!filters || !filters.cursor) {
        return {
          revisions: [{ beforeVersion: 0, afterVersion: 1, changeType: 'create', reason: '', actorUserId: 'u', actorRole: '管家', actorLabel: '管家', createdAt: '2026-10-01', snapshot: { stage: '水电隐蔽工程', trade: '水电', workerUserId: 'u_worker', startDate: '2026-10-01', endDate: '2026-10-03', expectedDate: '2026-10-03', restDays: [], content: 'x', status: 'active', version: 0 } }],
          pagination: { hasMore: true, nextCursor: '1', limit: 1 }
        };
      }
      return {
        revisions: [{ beforeVersion: 1, afterVersion: 2, changeType: 'update', reason: '调整', actorUserId: 'u', actorRole: '管家', actorLabel: '管家', createdAt: '2026-10-02', snapshot: { stage: '水电隐蔽工程', trade: '水电', workerUserId: 'u_worker', startDate: '2026-10-01', endDate: '2026-10-04', expectedDate: '2026-10-04', restDays: [], content: 'y', status: 'active', version: 1 } }],
        pagination: { hasMore: false, nextCursor: null, limit: 1 }
      };
    }
  };
  const { page } = loadScheduleDetailPage({ scheduleClient });
  page.onLoad({ projectId: 'p_cloud', id: 's_1' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(page.data.revisions.length, 1);
  assert.equal(page.data.revisions[0].changeType, 'create');
  assert.equal(page.data.revPagination.hasMore, true);
  page.loadMoreRevisions();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(page.data.revisions.length, 2);
  assert.equal(page.data.revisions[1].changeType, 'update');
  assert.equal(page.data.revPagination.hasMore, false);
});

test('cloud schedule page recovers from business error after correcting form', async () => {
  const calls = [];
  const scheduleClient = {
    checkEntry: () => ({ allowed: true }),
    getScheduleContext: async () => ({
      project: { id: 'p_cloud', name: '云端项目' },
      trades: ['水电'],
      workers: [{ userId: 'u_worker', label: '师傅甲', trades: ['水电'] }],
      isManager: true
    }),
    createSchedule: async (projectId, form, options) => {
      calls.push({ type: 'createSchedule', form, options });
      if (!form.content || !form.content.trim()) {
        const error = new Error('请填写本次施工内容');
        error.code = 'BAD_INPUT';
        error.kind = 'business';
        throw error;
      }
      return { scheduleId: 's_cloud', version: 1, status: 'active' };
    }
  };
  const { page } = loadSchedulePage({ scheduleClient });
  page.onLoad({ projectId: 'p_cloud' });
  await new Promise(r => setTimeout(r, 10));
  page.data.form.workerId = 'u_worker';
  // 首次提交：内容为空，应触发业务错误（recoverable）
  page.save();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(page.data.errorKind, 'recoverable');
  assert.equal(page.data.saving, false);
  // 修正内容后再次保存：应再次调用 createSchedule 并生成新 requestId
  page.input({ currentTarget: { dataset: { field: 'content' } }, detail: { value: '有效内容' } });
  page.save();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].options.requestId, calls[0].options.requestId);
  assert.equal(calls[1].form.content, '有效内容');
});

test('local schedule-detail shows edit but hides cancel for active manager', async () => {
  const calls = [];
  const scheduleClient = {
    checkEntry: () => ({ allowed: false, reason: '入口未启用' }),
    createSchedule: async () => { throw new Error('should not call cloud'); }
  };
  const { page } = loadScheduleDetailPage({ scheduleClient });
  page.onLoad({ projectId: 'demo-a', id: 'electric-plan' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(page.data.canManage, true);
  assert.equal(page.data.schedule.status, 'active');
  assert.equal(page.data.schedule.mode, 'local');
  // 本机详情保留调整入口，不显示未实现的本机取消
  page.edit();
  assert.equal(page.ctx.calls.some(c => c.type === 'navigate' && c.url.includes('/pages/schedule/schedule?')), true);
  // 零云请求
  assert.equal(page.ctx.calls.filter(c => c.type === 'cloud').length, 0);
});

test('schedule-detail cancel retries reuse snapshot requestId without prompting again', async () => {
  let attempt = 0;
  const captured = [];
  const errors = [];
  const scheduleClient = {
    checkEntry: () => ({ allowed: true }),
    getScheduleContext: async () => ({ project: { id: 'p_cloud', name: '云端项目' }, workers: [], isManager: true }),
    getSchedule: async () => ({ schedule: { id: 's_1', trade: '水电', stage: '水电隐蔽工程', workerUserId: 'u_worker', startDate: '2026-10-01', endDate: '2026-10-03', expectedDate: '2026-10-03', content: 'x', status: 'active', version: 1 } }),
    listScheduleRevisions: async () => ({ revisions: [] }),
    cancelSchedule: async (projectId, scheduleId, version, reason, options) => {
      captured.push({ attempt: ++attempt, options });
      if (attempt === 1) throw Object.assign(new Error('网络超时'), { code: 'TIMEOUT', kind: 'unknown' });
      return { scheduleId, version: 2, status: 'cancelled' };
    }
  };
  const customRequire = name => {
    if (name.includes('ui')) {
      return { fail: error => { errors.push(error); }, go: url => {} };
    }
    return baseRequire(name, createSeed(TODAY), [], { scheduleClient });
  };
  const { page } = loadScheduleDetailPage({ require: customRequire, scheduleClient });
  page.onLoad({ projectId: 'p_cloud', id: 's_1' });
  await new Promise(r => setTimeout(r, 10));
  page.cancel();
  await new Promise(r => setTimeout(r, 10));
  const modalCall = page.ctx.calls.find(c => c.type === 'modal');
  assert.ok(modalCall);
  modalCall.success({ confirm: true, content: '原因' });
  await new Promise(r => setTimeout(r, 20));
  const firstRequestId = captured[0].options.requestId;
  assert.ok(firstRequestId);
  assert.equal(page.data.pendingCancel.state, 'unknown');
  // 直接重试取消复用同一 requestId，不再弹出原因输入框
  page.retryCancel();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(captured.length, 2);
  assert.equal(captured[1].options.requestId, firstRequestId);
  assert.equal(page.data.pendingCancel, null);
  // 重试期间不能发起新的取消
  assert.equal(page.ctx.calls.filter(c => c.type === 'modal').length, 1);
});

// ========== H1/H2：真实客户端参与的错误分类与恢复回归 ==========

const CLOUD_CONTEXT = {
  project: { id: 'p_cloud', name: '云端项目' },
  trades: ['水电'],
  workers: [{ userId: 'u_worker', label: '师傅甲', trades: ['水电'] }],
  isManager: true
};

function okContext(extra) {
  return {
    type: 'context',
    result: { ok: true, project: extra.project, trades: extra.trades, workers: extra.workers, isManager: true }
  };
}

test('real client: cloud create that times out after server success becomes blocking unknown and retry reuses one requestId', async () => {
  const captured = [];
  let attempt = 0;
  const extra = withRealClient({ failures: [] }, async args => {
    captured.push(args.data);
    if (args.data.action === 'getScheduleContext') return okContext(CLOUD_CONTEXT);
    attempt++;
    // 服务端已成功写入，但客户端丢失响应
    if (attempt === 1) throw Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });
    return { result: { ok: true, scheduleId: 's_cloud', version: 1, status: 'active' } };
  });
  try {
    const { page } = loadSchedulePage(extra);
    page.onLoad({ projectId: 'p_cloud' });
    await new Promise(r => setTimeout(r, 20));
    page.data.form.workerId = 'u_worker';
    page.data.form.content = '真实客户端超时用例';
    page.save();
    await new Promise(r => setTimeout(r, 20));
    // 真实客户端把 TIMEOUT 判为 unknown → 页面 blocking
    assert.equal(page.data.errorKind, 'blocking', 'TIMEOUT 必须落到 blocking，而不是 recoverable');
    assert.equal(page.data.pendingRequest.state, 'unknown');
    const firstRequestId = page.data.pendingRequest.requestId;
    // 未知结果下不得改内容再重提第二份
    page.input({ currentTarget: { dataset: { field: 'content' } }, detail: { value: '改了内容' } });
    assert.equal(page.data.form.content, '真实客户端超时用例', '未知结果时表单输入必须被锁定');
    page.save();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(page.data.errorKind, 'blocking');
    // 以原快照重试：必须复用同一 requestId，且云端只收到一条新的 createSchedule
    page.retryPending();
    await new Promise(r => setTimeout(r, 20));
    const createCalls = captured.filter(d => d.action === 'createSchedule');
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].requestId, firstRequestId);
    assert.equal(createCalls[1].requestId, firstRequestId, '重试必须复用原 requestId，不得产生第二份安排');
  } finally {
    extra.restore();
  }
});

test('real client: malformed ok:false without code becomes blocking unknown instead of recoverable business error', async () => {
  const extra = withRealClient({ failures: [] }, async args => {
    if (args.data.action === 'getScheduleContext') return okContext(CLOUD_CONTEXT);
    return { result: { ok: false, message: '出错了但没有业务码' } };
  });
  try {
    const { page } = loadSchedulePage(extra);
    page.onLoad({ projectId: 'p_cloud' });
    await new Promise(r => setTimeout(r, 20));
    page.data.form.workerId = 'u_worker';
    page.data.form.content = '畸形响应用例';
    page.save();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(page.data.errorKind, 'blocking', '缺业务码的 ok:false 不得当成可纠正业务错误');
    assert.equal(page.data.pendingRequest.state, 'unknown');
  } finally {
    extra.restore();
  }
});

test('real client: explicit business rejection stays recoverable and allows corrected resubmit', async () => {
  const captured = [];
  let attempt = 0;
  const extra = withRealClient({}, async args => {
    if (args.data.action === 'getScheduleContext') return okContext(CLOUD_CONTEXT);
    captured.push(args.data);
    attempt++;
    if (attempt === 1) return { result: { ok: false, code: 'SCHEDULE_CONFLICT', message: '该工种当日已有安排。' } };
    return { result: { ok: true, scheduleId: 's_cloud', version: 1, status: 'active' } };
  });
  try {
    const { page } = loadSchedulePage(extra);
    page.onLoad({ projectId: 'p_cloud' });
    await new Promise(r => setTimeout(r, 20));
    page.data.form.workerId = 'u_worker';
    page.data.form.content = '业务失败用例';
    page.save();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(page.data.errorKind, 'recoverable', '明确业务码必须为 recoverable');
    // 修正内容后可重新提交，并使用新 requestId
    page.input({ currentTarget: { dataset: { field: 'content' } }, detail: { value: '修正后的内容' } });
    page.save();
    await new Promise(r => setTimeout(r, 20));
    const creates = captured.filter(d => d.action === 'createSchedule');
    assert.equal(creates.length, 2);
    assert.notEqual(creates[1].requestId, creates[0].requestId, '业务失败后重新提交应使用新 requestId');
    assert.equal(page.data.pendingRequest, null);
  } finally {
    extra.restore();
  }
});

test('real client: empty cancel reason is recoverable and correcting it cancels successfully', async () => {
  const captured = [];
  const extra = withRealClient({ failures: [] }, async args => {
    if (args.data.action === 'getScheduleContext') {
      return { result: { ok: true, project: CLOUD_CONTEXT.project, trades: [], workers: [], isManager: true } };
    }
    if (args.data.action === 'getSchedule') {
      return { result: { ok: true, schedule: { id: 's_1', trade: '水电', stage: '水电隐蔽工程', workerUserId: 'u_worker', startDate: '2026-10-01', endDate: '2026-10-03', expectedDate: '2026-10-03', content: 'x', status: 'active', version: 1 } } };
    }
    if (args.data.action === 'listScheduleRevisions') {
      return { result: { ok: true, revisions: [], pagination: { hasMore: false, nextCursor: null, limit: 20 } } };
    }
    captured.push(args.data);
    return { result: { ok: true, scheduleId: 's_1', version: 2, status: 'cancelled' } };
  });
  try {
    const { page } = loadScheduleDetailPage(extra);
    page.onLoad({ projectId: 'p_cloud', id: 's_1' });
    await new Promise(r => setTimeout(r, 20));
    // 第一次：原因为空 → recoverable，且不得发出任何取消请求
    page.cancel();
    await new Promise(r => setTimeout(r, 20));
    const modalCall = page.ctx.calls.find(c => c.type === 'modal');
    assert.ok(modalCall);
    modalCall.success({ confirm: true, content: '   ' });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(page.data.errorKind, 'recoverable', '空取消原因必须是可纠正错误');
    assert.equal(captured.filter(d => d.action === 'cancelSchedule').length, 0, '原因为空时不得发出取消请求');
    // 纠正后可重新发起取消（不依赖 blocking 拦截）
    page.cancel();
    await new Promise(r => setTimeout(r, 20));
    const secondModal = page.ctx.calls.filter(c => c.type === 'modal')[1];
    assert.ok(secondModal, 'recoverable 状态下应能重新打开取消输入');
    secondModal.success({ confirm: true, content: '客户取消' });
    await new Promise(r => setTimeout(r, 20));
    const cancels = captured.filter(d => d.action === 'cancelSchedule');
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].reason, '客户取消');
  } finally {
    extra.restore();
  }
});

test('real client: empty local schedule content is recoverable and correcting it saves locally', async () => {
  const failures = [];
  const extra = withRealClient({ failures }, async () => { throw new Error('should not call'); });
  try {
    const { page, calls } = loadSchedulePage(extra);
    page.onLoad({ projectId: 'demo-a' });
    page.data.form.workerId = 'electric';
    page.data.form.content = '';
    page.save();
    // 本机 assert 抛出的 BAD_INPUT/validation 必须映射为 recoverable
    assert.equal(page.data.errorKind, 'recoverable', '本机校验失败必须为 recoverable，否则用户无法纠正');
    assert.equal(page.data.saving, false);
    assert.equal(calls.some(c => c.type === 'navigateBack'), false, '校验失败不得导航返回');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'BAD_INPUT');
    assert.equal(failures[0].kind, 'validation');
    // 纠正内容后本机保存成功
    page.data.form.content = '本机纠正后的内容';
    page.save();
    assert.equal(calls.some(c => c.type === 'navigateBack'), true, '纠正后本机保存应成功');
    assert.equal(calls.filter(c => c.type === 'toast' && c.title === '已保存到本机').length, 1);
  } finally {
    extra.restore();
  }
});

test('real client: cancel retry after lost response reuses full snapshot and ignores live page state', async () => {
  const captured = [];
  let attempt = 0;
  const extra = withRealClient({}, async args => {
    if (args.data.action === 'getScheduleContext') {
      return { result: { ok: true, project: CLOUD_CONTEXT.project, trades: [], workers: [], isManager: true } };
    }
    if (args.data.action === 'getSchedule') {
      return { result: { ok: true, schedule: { id: 's_1', trade: '水电', stage: '水电隐蔽工程', workerUserId: 'u_worker', startDate: '2026-10-01', endDate: '2026-10-03', expectedDate: '2026-10-03', content: 'x', status: 'active', version: 1 } } };
    }
    if (args.data.action === 'listScheduleRevisions') {
      return { result: { ok: true, revisions: [], pagination: { hasMore: false, nextCursor: null, limit: 20 } } };
    }
    captured.push(args.data);
    attempt++;
    if (attempt === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return { result: { ok: true, scheduleId: 's_1', version: 2, status: 'cancelled' } };
  });
  try {
    const { page } = loadScheduleDetailPage(extra);
    page.onLoad({ projectId: 'p_cloud', id: 's_1' });
    await new Promise(r => setTimeout(r, 20));
    page.cancel();
    await new Promise(r => setTimeout(r, 20));
    page.ctx.calls.find(c => c.type === 'modal').success({ confirm: true, content: '客户取消' });
    await new Promise(r => setTimeout(r, 20));
    const pending = page.data.pendingCancel;
    assert.equal(pending.state, 'unknown');
    assert.equal(page.data.errorKind, 'blocking');
    const snapshot = { projectId: pending.projectId, scheduleId: pending.scheduleId, version: pending.version, reason: pending.reason, requestId: pending.requestId };
    // 页面实时状态被改成完全不同的值
    page.setData({ 'schedule.version': 999, 'schedule.id': 's_other' });
    page.retryCancel();
    await new Promise(r => setTimeout(r, 20));
    const cancels = captured.filter(d => d.action === 'cancelSchedule');
    assert.equal(cancels.length, 2);
    // 第二次请求必须与原快照完全一致：项目、安排 ID、版本、原因、requestId
    assert.equal(cancels[1].projectId, snapshot.projectId);
    assert.equal(cancels[1].scheduleId, snapshot.scheduleId);
    assert.equal(cancels[1].expectedVersion, snapshot.version);
    assert.equal(cancels[1].reason, snapshot.reason);
    assert.equal(cancels[1].requestId, snapshot.requestId);
    assert.equal(page.ctx.calls.filter(c => c.type === 'modal').length, 1, '重试不得再次弹出原因输入框');
  } finally {
    extra.restore();
  }
});
