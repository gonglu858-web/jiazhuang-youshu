const test = require('node:test');
const assert = require('node:assert/strict');
const { createProbe, classifyError, TARGET_ENV, COLLECTION, BUSINESS_COLLECTIONS } = require('../miniprogram/utils/permission-probe');
const denied = () => Promise.reject({ errCode: -502003, errMsg: 'database permission denied' });
const currentSdkDenied = () => Promise.reject({ errCode: -502003,
  errMsg: 'Permission denied 更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/DATABASE_PERMISSION_DENIED' });
function fixture({ appId = 'wxfb4db1615ac15531', envVersion = 'develop', read = denied,
  write = denied, collection = COLLECTION } = {}) {
  const calls = [];
  const api = {
    getAccountInfoSync: () => ({ miniProgram: { appId, envVersion } }),
    cloud: { database: options => {
      assert.deepEqual(options, { env: TARGET_ENV });
      return { collection: name => {
        assert.equal(name, collection);
        return {
          limit: n => { assert.equal(n, 1); return { get: () => { calls.push('read'); return read(); } }; },
          add: options => { calls.push('write'); assert.equal(options.data.diagnostic, true); return write(options); }
        };
      } };
    } }
  };
  return { api, calls, probe: createProbe(api, TARGET_ENV, 30, collection) };
}

test('only explicit database permission denial counts; network/login/generic errors do not', () => {
  for (const error of [new Error('network timeout'), { errCode: -502003, errMsg: 'login failed' }, { errMsg: 'permission denied' }, { errCode: -1, errMsg: 'Permission denied' }]) {
    assert.equal(classifyError(error).status, 'inconclusive');
  }
  assert.equal(classifyError({ errMsg: 'errCode: -502003 database permission denied' }).status, 'denied');
});
test('actual SDK error from user screenshot unlocks create check and both denials pass', async () => {
  const { probe, calls } = fixture({ read: currentSdkDenied, write: currentSdkDenied });
  assert.equal((await probe.read()).status, 'denied');
  assert.equal((await probe.write()).status, 'denied');
  assert.deepEqual(calls, ['read', 'write']);
});
test('wrong account, wrong environment, release, unknown or missing version issue no database requests', async () => {
  for (const overrides of [{ appId: 'another' }, { envVersion: 'release' }, { envVersion: 'unknown' }, { envVersion: null }, { envVersion: '' }]) {
    const { probe, calls } = fixture(overrides);
    assert.equal((await probe.read()).status, 'inconclusive');
    assert.equal((await probe.write()).status, 'blocked');
    assert.deepEqual(calls, []);
  }
  // 缺失 envVersion 字段：返回对象中不含该属性
  const { api: apiMissing, calls: callsMissing } = fixture({ envVersion: Symbol('skip') });
  apiMissing.getAccountInfoSync = () => ({ miniProgram: { appId: 'wxfb4db1615ac15531' } });
  const probeMissing = createProbe(apiMissing, TARGET_ENV, 30);
  assert.equal((await probeMissing.read()).status, 'inconclusive');
  assert.deepEqual(callsMissing, []);

  const { api, calls } = fixture();
  assert.equal((await createProbe(api, 'other-env').read()).status, 'inconclusive');
  assert.deepEqual(calls, []);
});

test('getAccountInfoSync failure is treated as inconclusive with zero requests', async () => {
  const { api } = fixture();
  api.getAccountInfoSync = () => { throw new Error('unavailable'); };
  const probe = createProbe(api, TARGET_ENV, 30);
  assert.equal((await probe.read()).status, 'inconclusive');
  assert.equal((await probe.write()).status, 'blocked');
});
test('unexpected successful read blocks writing and does not expose document data', async () => {
  const { probe, calls } = fixture({ read: async () => ({ data: [{ secret: 'not-for-output' }] }) });
  const result = await probe.read();
  assert.equal(result.status, 'unexpected-success');
  assert.equal(JSON.stringify(result).includes('not-for-output'), false);
  assert.equal((await probe.write()).status, 'blocked');
  assert.deepEqual(calls, ['read']);
});
test('network failure is inconclusive and never enables writing', async () => {
  const { probe, calls } = fixture({ read: async () => { throw new Error('socket hang up'); } });
  assert.equal((await probe.read()).status, 'inconclusive');
  assert.equal((await probe.write()).status, 'blocked');
  assert.deepEqual(calls, ['read']);
});
test('read and create deny as expected; duplicate calls cannot issue another request', async () => {
  const { probe, calls } = fixture();
  assert.equal((await probe.write()).status, 'blocked');
  assert.equal((await probe.read()).status, 'denied');
  const results = await Promise.all([probe.write(), probe.write()]);
  assert.equal(results[0].status, 'denied');
  assert.equal(results[1].status, 'blocked');
  assert.equal((await probe.read()).status, 'blocked');
  assert.deepEqual(calls, ['read', 'write']);
});
test('unexpected creation is reported with marker for investigation, without deletion or retry', async () => {
  const { probe, calls } = fixture({ write: async () => ({ _id: 'unexpected' }) });
  await probe.read();
  const result = await probe.write();
  assert.equal(result.status, 'unexpected-success');
  assert.match(result.markerId, /^yf-permission-probe-/);
  assert.equal((await probe.write()).status, 'blocked');
  assert.deepEqual(calls, ['read', 'write']);
});
test('a write timeout is unknown and cannot be retried by this probe', async () => {
  const { probe, calls } = fixture({ write: () => new Promise(() => {}) });
  await probe.read();
  assert.equal((await probe.write()).status, 'inconclusive');
  assert.equal((await probe.write()).status, 'blocked');
  assert.deepEqual(calls, ['read', 'write']);
});
test('each approved business collection can be checked; arbitrary collections cannot be queried', async () => {
  assert.deepEqual(BUSINESS_COLLECTIONS, ['users', 'app_admins', 'projects',
    'project_members', 'invitations', 'audit_events']);
  for (const name of BUSINESS_COLLECTIONS) {
    const { probe, calls } = fixture({ collection: name });
    assert.equal((await probe.read()).status, 'denied');
    assert.equal((await probe.write()).status, 'denied');
    assert.deepEqual(calls, ['read', 'write']);
  }
  const { api, calls } = fixture();
  const result = await createProbe(api, TARGET_ENV, 30, 'sys_user').read();
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(calls, []);
});
