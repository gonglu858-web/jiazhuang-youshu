const test = require('node:test');
const assert = require('node:assert/strict');

function setupWx(info, callFunction = async () => { throw new Error('should not call'); }) {
  global.wx = {
    getAccountInfoSync: () => {
      if (info === 'throw') throw new Error('unavailable');
      return { miniProgram: info };
    },
    cloud: { callFunction }
  };
}

function clearModule() {
  delete require.cache[require.resolve('../miniprogram/utils/schedule-client')];
  delete require.cache[require.resolve('../miniprogram/config/schedule-entry-proof')];
}

test('entry disabled by default', () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' });
  const client = require('../miniprogram/utils/schedule-client');
  const result = client.checkEntry('p_any');
  assert.equal(result.allowed, false);
  assert.equal(result.reason, '施工安排入口未启用。');
});

test('entry denied for release or unknown env', () => {
  clearModule();
  const client = require('../miniprogram/utils/schedule-client');
  for (const envVersion of ['release', 'unknown', undefined]) {
    setupWx({ appId: 'wxfb4db1615ac15531', envVersion });
    const result = client.checkEntry('p_any');
    assert.equal(result.allowed, false);
  }
});

test('entry denied for wrong appId', () => {
  clearModule();
  setupWx({ appId: 'wrong', envVersion: 'develop' });
  const client = require('../miniprogram/utils/schedule-client');
  const result = client.checkEntry('p_any');
  assert.equal(result.allowed, false);
});

test('cloud calls throw entry error when disabled', async () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' });
  const client = require('../miniprogram/utils/schedule-client');
  for (const fn of [() => client.listSchedules('p_any'), () => client.createSchedule('p_any', {})]) {
    try { await fn(); assert.fail('should throw'); } catch (error) { assert.equal(error.code, 'ENTRY_DISABLED'); }
  }
});

const TEST_PROOF = {
  enabled: true,
  allowedProjectIds: ['p_allowed'],
  envId: 'cloud1-d8gcq5ag39d847723',
  appId: 'wxfb4db1615ac15531'
};

test('filters whitelist ignores action or projectId overrides', async () => {
  clearModule();
  let captured = null;
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async args => {
    captured = args;
    return { result: { ok: true, schedules: [], pagination: { hasMore: false, nextCursor: null, limit: 100 } } };
  });
  const client = require('../miniprogram/utils/schedule-client');
  await client.listSchedules('p_allowed', { action: 'removeMember', projectId: 'p_not_allowed', status: 'active', date: '2026-10-01' }, TEST_PROOF);
  assert.equal(captured.data.action, 'listSchedules');
  assert.equal(captured.data.projectId, 'p_allowed');
  assert.equal(captured.data.status, 'active');
  assert.equal(captured.data.date, '2026-10-01');
  assert.equal(typeof captured.data.actionOverride, 'undefined');
  assert.equal(typeof captured.data.projectIdOverride, 'undefined');
});

test('write methods reuse stable requestId', async () => {
  clearModule();
  let captured = null;
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async args => {
    captured = args;
    return { result: { ok: true, scheduleId: 's_1', version: 1, status: 'active' } };
  });
  const client = require('../miniprogram/utils/schedule-client');
  const requestId = client.uid();
  await client.createSchedule('p_allowed', { trade: '水电' }, { requestId }, TEST_PROOF);
  assert.equal(captured.data.requestId, requestId);
  await client.createSchedule('p_allowed', { trade: '水电' }, { requestId }, TEST_PROOF);
  assert.equal(captured.data.requestId, requestId);
});

test('uid returns distinct request ids', () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' });
  const client = require('../miniprogram/utils/schedule-client');
  const a = client.uid();
  const b = client.uid();
  assert.notEqual(a, b);
  assert.equal(typeof a, 'string');
});

// ========== H1：真实客户端网络错误分类与响应结构校验 ==========

// 传输层异常由 callFunction 抛出，走 classifyError 后必须是 unknown（结果未知）
// 每个用例同时断言 kind 与 code：kind 必须是 unknown；code 由 classifyError 的实际归一化结果决定。
// 以 NETWORK_ERROR 为例：本用例消息 cloud request failed 匹配网络特征，因此 code 归一化为 NETWORK；
// 无匹配消息时可能为 UNKNOWN，但 kind 均须为 unknown。
// NETWORK_CODES 白名单不含 NETWORK_ERROR，其原码无需保留（Codex 已复核确认不修改实现）。
const NETWORK_FAILURES = [
  { name: 'TIMEOUT code', error: Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }), expectedCode: 'TIMEOUT' },
  { name: 'NETWORK_ERROR code', error: Object.assign(new Error('cloud request failed'), { code: 'NETWORK_ERROR' }), expectedCode: 'NETWORK' },
  { name: 'REQUEST_FAIL code', error: Object.assign(new Error('request:fail'), { code: 'REQUEST_FAIL' }), expectedCode: 'REQUEST_FAIL' },
  { name: 'ECONNRESET code', error: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), expectedCode: 'ECONNRESET' },
  { name: 'no code but 网络 message', error: new Error('网络异常，请稍后重试'), expectedCode: 'NETWORK' },
  { name: 'no code but 超时 message', error: new Error('请求超时'), expectedCode: 'NETWORK' },
  { name: 'no code and no network hint', error: new Error('boom'), expectedCode: 'UNKNOWN' }
];

for (const { name, error, expectedCode } of NETWORK_FAILURES) {
  test(`call classifies transport failure as unknown: ${name}`, async () => {
    clearModule();
    setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => { throw error; });
    const client = require('../miniprogram/utils/schedule-client');
    await assert.rejects(client.createSchedule('p_allowed', { trade: '水电' }, {}, TEST_PROOF), e => {
      assert.equal(e.kind, 'unknown', `${name} 必须判为 unknown，实际为 ${e.kind}`);
      assert.equal(e.code, expectedCode);
      return true;
    });
  });
}

test('classifyError keeps explicit entry and validation kinds', () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' });
  const client = require('../miniprogram/utils/schedule-client');
  const entry = client.classifyError(Object.assign(new Error('入口未启用'), { code: 'ENTRY_DISABLED', kind: 'entry' }));
  assert.equal(entry.kind, 'entry');
  const validation = client.classifyError(Object.assign(new Error('内容不能为空'), { code: 'BAD_INPUT', kind: 'validation' }));
  assert.equal(validation.kind, 'validation');
  // 未标记的 BAD_INPUT 也必须落到 validation
  const bare = client.classifyError(Object.assign(new Error('内容不能为空'), { code: 'BAD_INPUT' }));
  assert.equal(bare.kind, 'validation');
});

// 服务端明确业务拒绝：ok:false + 合法 code → business（可恢复）
test('call reports explicit business rejection with code as business', async () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => ({
    result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES', message: '该师傅仍有未取消安排。' }
  }));
  const client = require('../miniprogram/utils/schedule-client');
  await assert.rejects(client.cancelSchedule('p_allowed', 's_1', 1, '取消', {}, TEST_PROOF), { kind: 'business', code: 'WORKER_HAS_ACTIVE_SCHEDULES' });
});

// 畸形响应：全部必须为 unknown，不能伪装成成功或业务失败
const MALFORMED_RESPONSES = [
  { name: 'result missing', response: {} },
  { name: 'result is not object', response: { result: 'ok' } },
  { name: 'result is null', response: { result: null } },
  { name: 'result is array', response: { result: [] } },
  { name: 'ok:false without code', response: { result: { ok: false, message: '失败了' } } },
  { name: 'ok is string yes', response: { result: { ok: 'yes', scheduleId: 's_1', version: 1, status: 'active' } } },
  { name: 'ok is 1', response: { result: { ok: 1, scheduleId: 's_1', version: 1, status: 'active' } } },
  { name: 'ok:true but missing version', response: { result: { ok: true, scheduleId: 's_1', status: 'active' } } },
  { name: 'ok:true but version not number', response: { result: { ok: true, scheduleId: 's_1', version: '1', status: 'active' } } },
  { name: 'ok:true but missing status', response: { result: { ok: true, scheduleId: 's_1', version: 1 } } },
  { name: 'ok:true but scheduleId not string', response: { result: { ok: true, scheduleId: 1, version: 1, status: 'active' } } }
];

for (const { name, response } of MALFORMED_RESPONSES) {
  test(`call rejects malformed response as unknown: ${name}`, async () => {
    clearModule();
    setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => response);
    const client = require('../miniprogram/utils/schedule-client');
    await assert.rejects(client.createSchedule('p_allowed', { trade: '水电' }, {}, TEST_PROOF), e => {
      assert.equal(e.kind, 'unknown', `${name} 必须判为 unknown，实际为 ${e.kind}`);
      assert.ok(['RESPONSE_UNKNOWN', 'RESPONSE_MALFORMED'].includes(e.code), `实际 code=${e.code}`);
      return true;
    });
  });
}

test('call rejects malformed listSchedules response missing pagination', async () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => ({ result: { ok: true, schedules: [] } }));
  const client = require('../miniprogram/utils/schedule-client');
  await assert.rejects(client.listSchedules('p_allowed', {}, TEST_PROOF), { kind: 'unknown', code: 'RESPONSE_MALFORMED' });
});

test('call rejects malformed getSchedule response without schedule object', async () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => ({ result: { ok: true } }));
  const client = require('../miniprogram/utils/schedule-client');
  await assert.rejects(client.getSchedule('p_allowed', 's_1', TEST_PROOF), { kind: 'unknown', code: 'RESPONSE_MALFORMED' });
});

test('retry after a lost response reuses the same requestId and yields one schedule', async () => {
  clearModule();
  const received = [];
  let failNext = true;
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async args => {
    if (failNext) { failNext = false; throw Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }); }
    // 幂等服务：同 requestId 返回首次结果
    received.push(args.data.requestId);
    return { result: { ok: true, scheduleId: 's_1', version: 1, status: 'active' } };
  });
  const client = require('../miniprogram/utils/schedule-client');
  const requestId = client.uid();
  const form = { trade: '水电' };
  await assert.rejects(client.createSchedule('p_allowed', form, { requestId }, TEST_PROOF), { kind: 'unknown' });
  const ok = await client.createSchedule('p_allowed', form, { requestId }, TEST_PROOF);
  assert.equal(ok.scheduleId, 's_1');
  assert.deepEqual(received, [requestId], '重试必须复用原 requestId，不得换号');
});


// ========== 事务兼容新增业务码的客户端映射 ==========

const RECOVERABLE_CODES = ['TASK_DIR_CAPACITY_EXCEEDED', 'TASK_DIR_INCONSISTENT', 'PROJECT_NOT_WRITABLE',
  'STALE_SCAN', 'OCCUPANCY_INCONSISTENT', 'SCHEDULE_OPERATION_BUDGET_EXCEEDED',
  'BAD_INPUT', 'WORKER_INVALID', 'SCHEDULE_CONFLICT', 'WORKER_HAS_ACTIVE_SCHEDULES', 'VERSION_MISMATCH'];
const BLOCKING_CODES = ['TASK_DIR_NOT_READY', 'NO_ACCESS', 'IDENTITY_DISABLED', 'SERVER_ERROR'];

for (const code of RECOVERABLE_CODES) {
  test(`client maps ${code} as recoverable business error`, async () => {
    clearModule();
    setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => ({
      result: { ok: false, code, message: '拒绝' }
    }));
    const client = require('../miniprogram/utils/schedule-client');
    await assert.rejects(client.createSchedule('p_allowed', { trade: '水电' }, {}, TEST_PROOF), { kind: 'business', code });
  });
}

for (const code of BLOCKING_CODES) {
  test(`client maps ${code} as blocking entry error`, async () => {
    clearModule();
    setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => ({
      result: { ok: false, code, message: '拒绝' }
    }));
    const client = require('../miniprogram/utils/schedule-client');
    await assert.rejects(client.createSchedule('p_allowed', { trade: '水电' }, {}, TEST_PROOF), { kind: 'entry', code });
  });
}

test('client treats unknown business code as blocking rather than recoverable', async () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => ({
    result: { ok: false, code: 'SOMETHING_NEW', message: '未知' }
  }));
  const client = require('../miniprogram/utils/schedule-client');
  await assert.rejects(client.createSchedule('p_allowed', { trade: '水电' }, {}, TEST_PROOF), { kind: 'entry', code: 'SOMETHING_NEW' });
});

test('client still treats unknown transport failure as blocking unknown', async () => {
  clearModule();
  setupWx({ appId: 'wxfb4db1615ac15531', envVersion: 'develop' }, async () => { throw Object.assign(new Error('boom'), { code: 'WEIRD' }); });
  const client = require('../miniprogram/utils/schedule-client');
  await assert.rejects(client.createSchedule('p_allowed', { trade: '水电' }, {}, TEST_PROOF), { kind: 'unknown' });
});
