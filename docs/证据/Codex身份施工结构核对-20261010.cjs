'use strict';
// 本地证据：真实普通施工页/客户端 + 合成 wx；真实安排服务 + 合成查询。
// 不加载 SDK，不启动子进程，不写文件；结果仅输出 stdout，重跑须另存新文件。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('OFFLINE_ONLY'); };
for (const name of ['node:http', 'node:https']) {
  const mod = require(name); mod.request = denyNetwork; mod.get = denyNetwork;
}
require('node:net').connect = denyNetwork;
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:tls').connect = denyNetwork;
global.fetch = denyNetwork;

async function main() {
  const tracked = [
    'miniapp/miniprogram/pages/schedule/schedule.js',
    'miniapp/miniprogram/utils/schedule-client.js',
    'miniapp/cloudfunctions/memberAccess/service.js',
    'miniapp/cloudfunctions/memberAccess/schedule-service.js',
    'miniapp/miniprogram/config/schedule-entry-proof.js',
    'miniapp/miniprogram/config/schedule-sandbox-proof.js'
  ];
  const digest = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
  const before = Object.fromEntries(tracked.map(p => [p, digest(p)]));
  const sent = [];
  let storageWrites = 0;
  const wx = {
    cloud: { callFunction: async ({ data }) => {
      if (data.action === 'getScheduleContext') return { result: {
        ok: true, project: { id: 'synthetic-project' }, isManager: true,
        trades: ['泥瓦'], workers: [{ userId: 'synthetic-worker', trades: ['泥瓦'] }]
      } };
      assert.equal(data.action, 'createSchedule');
      sent.push(clone(data));
      throw Object.assign(new Error('synthetic timeout'), { code: 'TIMEOUT' });
    } },
    setStorageSync: () => { storageWrites++; }, getStorageSync: () => null,
    showToast: () => {}, navigateBack: () => {}
  };
  const clientModule = { exports: {} };
  vm.runInNewContext(read(tracked[1]), {
    module: clientModule, wx,
    require: name => {
      if (name === '../config/schedule-entry-proof') return { enabled: true, envId: 'synthetic-env', allowedProjectIds: ['synthetic-project'] };
      if (name === './env-gate') return { checkEnvGate: () => ({ allowed: true }) };
      throw new Error('UNEXPECTED_REQUIRE');
    }
  }, { filename: tracked[1] });
  let randomCounter = 0;
  const makePage = async () => {
    let definition;
    const math = Object.create(Math);
    math.random = () => (++randomCounter) / 100;
    vm.runInNewContext(read(tracked[0]), {
      Page: value => { definition = value; }, wx, Math: math,
      require: name => {
        if (name.endsWith('/schedule-client')) return clientModule.exports;
        if (name.endsWith('/seed')) return { STAGES: ['砌墙'] };
        if (name.endsWith('/date')) return { day: () => '2026-10-10' };
        if (name.endsWith('/ui')) return { fail: e => { throw e; }, go: () => {} };
        if (name.endsWith('/store') || name.endsWith('/business')) return {};
        throw new Error('UNEXPECTED_REQUIRE');
      }
    }, { filename: tracked[0] });
    const page = { ...definition, data: clone(definition.data), setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split('.'); let obj = this.data;
        while (parts.length > 1) obj = obj[parts.shift()];
        obj[parts[0]] = value;
      }
    } };
    page.onLoad({ projectId: 'synthetic-project' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.mode, 'cloud');
    page.data.form.content = '合成施工内容';
    return page;
  };
  const first = await makePage();
  await first.saveCloud();
  assert.equal(first.data.pendingRequest.state, 'unknown');
  first.retryPending();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0].requestId, sent[1].requestId);
  const second = await makePage();
  assert.equal(second.data.pendingRequest, null);
  await second.saveCloud();
  assert.notEqual(sent[0].requestId, sent[2].requestId);
  assert.equal(storageWrites, 0);

  const rows = Array.from({ length: 250 }, (_, i) => ({
    _id: `synthetic-${String(i).padStart(4, '0')}`, projectId: 'synthetic-project',
    createdAt: '2026-10-10T00:00:00.000Z', status: 'active',
    startDate: '2026-10-10', endDate: '2026-10-10', restDays: []
  }));
  const queries = [];
  const db = { collection(name) {
    assert.equal(name, 'schedules');
    return { where(filter) {
      let skip = 0; let limit = 100; const order = [];
      const q = {
        orderBy: (field, direction) => { order.push([field, direction]); return q; },
        limit: n => { limit = n; return q; }, skip: n => { skip = n; return q; },
        get: async () => { queries.push({ filter, skip, limit, order }); return { data: rows.slice(skip, skip + limit) }; }
      };
      return q;
    } };
  } };
  const service = require(path.join(root, tracked[3])).createScheduleService(db);
  const pageOne = await service.listSchedules('synthetic-project', { limit: 1 });
  const firstQueryCount = queries.length;
  assert.equal(pageOne.schedules.length, 1);
  assert.equal(firstQueryCount, 3);
  await service.listSchedules('synthetic-project', { limit: 1, cursor: pageOne.pagination.nextCursor });
  assert.equal(queries.length, 6);
  const oldGate = require(path.join(root, tracked[4]));
  const sandboxGate = require(path.join(root, tracked[5]));
  assert.equal(oldGate.enabled, false); assert.equal(oldGate.allowedProjectIds.length, 0);
  assert.equal(sandboxGate.enabled, false); assert.equal(sandboxGate.sandboxProjectId, '');
  assert.equal(sandboxGate.roundId, '');
  const sourceUnchanged = tracked.every(p => before[p] === digest(p));
  assert.equal(sourceUnchanged, true); assert.equal(networkAttempts, 0);
  return {
    kind: 'BOUNDED_LOCAL_ARCHITECTURE_OBSERVATION', observedAt: new Date().toISOString(),
    sources: before, sourceUnchanged, networkAttempts,
    ordinaryPage: { samePageRetryKeepsRequestId: true, reopenedPageHasPending: false,
      reopenedSubmissionUsesDifferentId: true, syntheticWriteCalls: sent.length, storageWrites,
      limitation: '只证明页面丢失未决状态并允许新编号发送；未模拟提交成功或证明云端重复记录。' },
    listQuery: { matchedSyntheticRows: 250, requestedPageSize: 1,
      firstPageQueryCount: firstQueryCount, secondPageQueryCount: queries.length - firstQueryCount,
      limitation: '真实服务+合成查询，不是平台耗时、费用或索引性能实测。' },
    gates: { oldEnabled: oldGate.enabled, sandboxEnabled: sandboxGate.enabled },
    cloudExecuted: false, businessSourceModified: false,
    sdkExecuted: false, deploymentAuthorized: false
  };
}
main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(() => {
  process.stderr.write('LOCAL_AUDIT_FAILED\n'); process.exitCode = 1;
});
