// 施工安排独立测试副本：客户端契约、页面可操作性与未知结果恢复（T1/T2/T4）。
//
// Codex 复核 T1（按动作处理未知结果）：
// - 无幂等保障的写动作结果未知时**不重发**，保留证据并锁写；
// - 没有"直接清锁重发"的路径；解除必须显式确认已在管理端核对，且解除后仍锁写；
// - 门控/窗口拒绝只说明本次未执行，**不清除**未决记录；
// - 已知业务码（含 SCHEDULE_CONFLICT 等实际码）分类为可修正的明确拒绝。
//
// Codex 复核 T2（未决记录完整绑定）：
// - 未决记录与快照是**单一 envelope**（一个键），半写/半清理拼不出合法请求；
// - 恢复核验当前可信账号与目标，变化即停止；
// - 普通提交不静默恢复；旧格式残留只阻断不删除。
//
// Codex 复核 T4（带凭据的恢复与字段一致性）：
// - 未决期间只允许补录**该请求所需**的敏感凭据，其余业务字段仍锁定；
// - 凭据摘要不匹配拒绝发送；
// - restDays 回填到 `restDaysText`；日期不一致必须显式确认。
//
// 所有用例都**加载实际客户端与实际 Page 对象**并执行真实事件，
// setData 替身支持点分路径，不靠直接 setData 绕过事件锁。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const MINIPROGRAM = path.join(ROOT, 'miniprogram');
const CLIENT_PATH = path.join(MINIPROGRAM, 'utils/schedule-sandbox-client.js');
const PAGE_PATH = path.join(MINIPROGRAM, 'pages/schedule-sandbox/schedule-sandbox.js');
const nativeRequire = createRequire(CLIENT_PATH);

const originalProof = require('../miniprogram/config/schedule-sandbox-proof');
const ENV_ID = 'cloud1-d8gcq5ag39d847723';
const ROUND = 'sandbox-round-t1';
const APPID = 'wxfb4db1615ac15531';
const TRUSTED_USER = 'u_trusted_account_for_t1';

const clone = v => JSON.parse(JSON.stringify(v));

/** 内存存储：可注入读/写/删故障。 */
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const storage = {
    map,
    failRead: false,
    failWrite: false,
    failRemove: false,
    getStorageSync(key) {
      if (storage.failRead) throw new Error('READ_FAILED');
      return map.get(key);
    },
    setStorageSync(key, value) {
      if (storage.failWrite) throw new Error('WRITE_FAILED');
      map.set(key, clone(value));
    },
    removeStorageSync(key) {
      if (storage.failRemove) throw new Error('REMOVE_FAILED');
      map.delete(key);
    }
  };
  return storage;
}

/**
 * 载入**实际**客户端与**实际** Page。
 * identify 由服务端返回 userId —— 这是客户端唯一可信账号来源。
 */
function loadStack(options = {}) {
  const {
    store = makeStorage(),
    target = 'p_sbx_target',
    round = ROUND,
    envVersion = 'develop',
    enabled = true,
    handler = async () => { throw new Error('timeout'); },
    identifyResult = { ok: true, sandbox: true, userId: TRUSTED_USER },
    loadPage = true
  } = options;
  const proof = {
    ...originalProof,
    enabled,
    roundId: round,
    sandboxProjectId: target,
    functionName: 'scheduleSandbox'
  };
  const clientModule = { exports: {} };
  // 专用驱动会 require 副本 proof；用与页面同一份注入对象，
  // 否则驱动的门控会读到磁盘上的默认（关闭）配置。
  const testCoordinatorModule = require('../miniprogram/utils/sandbox-test-coordinator');
  const testDriverModule = require('../miniprogram/utils/sandbox-test-driver');
  const testProofModule = require('../miniprogram/config/sandbox-test-driver-proof');
  const injectProof = name => {
    if (name.includes('schedule-sandbox-client')) return client;
    if (name.includes('config/schedule-sandbox-proof')) return proof;
    if (name.includes('sandbox-test-driver-proof')) return testProofModule;
    if (name.includes('sandbox-test-coordinator')) return testCoordinatorModule;
    if (name.includes('sandbox-test-driver')) return testDriverModule;
    return nativeRequire(name);
  };
  vm.runInThisContext(
    `(function(require,module,exports,wx){${fs.readFileSync(CLIENT_PATH, 'utf8')}\n})`
  )(name => {
    // 客户端只新增了对协调器的只读 require（互斥接点）
    if (name.includes('sandbox-test-coordinator')) return testCoordinatorModule;
    if (name.includes('config/schedule-sandbox-proof')) return proof;
    return nativeRequire(name);
  }, clientModule, clientModule.exports, {});
  const client = clientModule.exports;
  const calls = [];
  const api = {
    ...store,
    storage: store,
    getAccountInfoSync: () => ({ miniProgram: { appId: APPID, envVersion } }),
    cloud: {
      async callFunction(args) {
        calls.push(clone(args.data));
        if (args.data && args.data.action === 'identify') return { result: clone(identifyResult) };
        return handler(args.data, calls.length);
      }
    }
  };
  const stack = { proof, store, client, api, calls, page: null };
  if (!loadPage) return stack;
  let definition;
  vm.runInThisContext(
    `(function(require,Page,wx){${fs.readFileSync(PAGE_PATH, 'utf8')}\n})`
  )(injectProof, value => { definition = value; }, api);
  stack.page = {
    ...definition,
    data: clone(definition.data),
    // setData 替身**必须支持点分路径**，否则无法验证真实事件写入
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split('.');
        let cursor = this.data;
        for (const part of parts.slice(0, -1)) {
          if (cursor[part] === undefined || cursor[part] === null) cursor[part] = {};
          cursor = cursor[part];
        }
        cursor[parts[parts.length - 1]] = value;
      }
    }
  };
  return stack;
}

/** 真实发一次 identify 以绑定可信账号。 */
async function bindAccount(stack) {
  const result = await stack.client.callSandbox({ action: 'identify', requestId: 'bind-1' }, { api: stack.api });
  assert.equal(result.ok, true, `身份登记应成功：${JSON.stringify(result)}`);
  stack.calls.length = 0;
  return result;
}

/**
 * 只统计**业务**调用（U2 起恢复前会先发一次 identify 核实当前会话身份，
 * 它不是业务请求，断言"零业务发送"时必须排除）。
 */
function businessCalls(stack) {
  return stack.calls.filter(c => c.action !== 'identify');
}

const inputEvent = (field, value) => ({
  currentTarget: { dataset: { field } },
  detail: { value }
});

// ─────────────────────────── T1：按动作处理未知结果 ───────────────────────

test('T1.1 无幂等保障的写动作结果未知时不得重发，保留证据并锁写', async () => {
  const stack = loadStack();
  await bindAccount(stack);
  const result = await stack.client.callSandbox(
    { action: 'createInvitation', requestId: 'inv-1', role: '师傅', trades: ['拆改'] },
    { api: stack.api }
  );
  assert.equal(result.unknown, true);
  assert.equal(result.retryAllowed, false, 'createInvitation 无幂等保障，不得声称可重发');
  assert.equal(result.writeLocked, true, '结果未知后必须锁写');
  const before = stack.calls.length;
  const resumed = await stack.client.resumePending({ api: stack.api });
  assert.equal(resumed.code, 'SANDBOX_RETRY_UNSAFE');
  assert.equal(stack.calls.length, before, '被拒的恢复不得发出请求');
  const again = await stack.client.callSandbox(
    { action: 'createInvitation', requestId: 'inv-2', role: '师傅', trades: ['拆改'] },
    { api: stack.api }
  );
  assert.equal(again.code, 'SANDBOX_PENDING_UNRESOLVED');
  assert.equal(stack.calls.length, before, '未决期间不得发出第二次写请求');
});

test('T1.2 有回执保障的写动作结果未知时可用同一编号重试', async () => {
  let n = 0;
  const stack = loadStack({
    handler: async () => {
      n++;
      if (n === 1) throw new Error('timeout after server commit');
      return { result: { ok: true, sandbox: true, scheduleId: 'sch-1' } };
    }
  });
  await bindAccount(stack);
  const first = await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'sch-req-1', form: { content: '原施工内容' } },
    { api: stack.api }
  );
  assert.equal(first.unknown, true);
  assert.equal(first.retryAllowed, true, '施工四写有服务端回执保障，应允许同号重试');
  const resumed = await stack.client.resumePending({ api: stack.api });
  assert.equal(resumed.ok, true, `同号重试应取回原结果：${JSON.stringify(resumed)}`);
  assert.equal(resumed.replayed, true);
  const sent = stack.calls[stack.calls.length - 1];
  assert.equal(sent.requestId, 'sch-req-1', '必须沿用同一请求编号');
  assert.equal(sent.form.content, '原施工内容', '必须从原快照重建载荷');
});

test('T1.3 只读动作结果未知可安全重发', async () => {
  let n = 0;
  const stack = loadStack({
    handler: async () => {
      n++;
      if (n === 1) throw new Error('timeout');
      return { result: { ok: true, sandbox: true, schedules: [] } };
    }
  });
  await bindAccount(stack);
  const first = await stack.client.callSandbox(
    { action: 'listSchedules', projectId: 'p_sbx_target', requestId: 'q1' },
    { api: stack.api }
  );
  assert.equal(first.unknown, true);
  assert.equal(first.retryAllowed, true);
  const resumed = await stack.client.resumePending({ api: stack.api });
  assert.equal(resumed.ok, true);
});

test('T1.4 没有直接清锁重发的路径：解除必须显式确认且解除后仍锁写', async () => {
  const stack = loadStack();
  await bindAccount(stack);
  await stack.client.callSandbox(
    { action: 'createInvitation', projectId: 'p_sbx_target', requestId: 'inv-1', role: '师傅', trades: ['拆改'] },
    { api: stack.api }
  );
  const blind = stack.client.resolvePendingAfterExternalCheck(stack.store, {});
  assert.equal(blind.ok, false, '未确认核对时不得视为成功');
  assert.equal(blind.code, 'SANDBOX_VERIFICATION_REQUIRED');
  assert.ok(stack.client.readPending(stack.store, ENV_ID, ROUND).record, '未确认时不得解除未决记录');
  const resolved = stack.client.resolvePendingAfterExternalCheck(stack.store, { externallyVerified: true });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.writeLocked, true, '解除记录不等于放开新写');
  const after = stack.client.readPending(stack.store, ENV_ID, ROUND);
  assert.equal(after.record.writeLocked, true, '解除后仍必须保持锁写');
  assert.equal(after.record.externallyVerified, true, '必须记录人工核对事实');
  const before = stack.calls.length;
  const next = await stack.client.callSandbox(
    { action: 'createInvitation', projectId: 'p_sbx_target', requestId: 'inv-3', role: '师傅', trades: ['拆改'] },
    { api: stack.api }
  );
  assert.equal(next.code, 'SANDBOX_PENDING_UNRESOLVED');
  assert.equal(stack.calls.length, before, '解除后不得自动放开新写');
});

test('T1.5 未知之后收到窗口/权限拒绝，不得当作原请求未提交', async () => {
  const stack = loadStack();
  await bindAccount(stack);
  // 用有回执保障的施工写入，才能走到服务端并收到门控拒绝
  await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'sch-1', form: { content: 'x' } },
    { api: stack.api }
  );
  assert.ok(stack.client.readPending(stack.store, ENV_ID, ROUND).record, '第一次应留下未决记录');
  stack.api.cloud.callFunction = async args => {
    stack.calls.push(clone(args.data));
    if (args.data.action === 'identify') return { result: { ok: true, userId: TRUSTED_USER } };
    return { result: { ok: false, code: 'SANDBOX_EXPIRED', message: '测试窗口已结束' } };
  };
  const denied = await stack.client.resumePending({ api: stack.api });
  assert.equal(denied.code, 'SANDBOX_EXPIRED');
  assert.equal(denied.unknown, true, '门控拒绝只说明本次未执行，结果仍未知');
  const after = stack.client.readPending(stack.store, ENV_ID, ROUND);
  assert.ok(after.record, '窗口拒绝不得清除未决记录');
  assert.equal(after.record.requestId, 'sch-1', '未决记录必须仍是原来那次');
});

test('T1.6 首次请求的已知业务拒绝码正确分类为可修正', async () => {
  for (const code of ['SCHEDULE_CONFLICT', 'EXPECTED_DATE_MISMATCH', 'TASK_DIR_NOT_READY', 'GUARD_INCONSISTENT', 'BAD_INPUT']) {
    const stack = loadStack({ handler: async () => ({ result: { ok: false, code, message: '业务拒绝' } }) });
    await bindAccount(stack);
    const result = await stack.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: `req-${code}`, form: { content: 'x' } },
      { api: stack.api }
    );
    assert.equal(result.definite, true, `${code} 应分类为明确拒绝`);
    assert.notEqual(result.unknown, true, `${code} 不得标为未知`);
    assert.equal(
      stack.client.readPending(stack.store, ENV_ID, ROUND).record, null,
      `${code} 属首次请求的确定拒绝，应清理未决记录以便修正`
    );
  }
});

test('T1.7 动作分类与 vendor 实际幂等能力一致', () => {
  const stack = loadStack({ loadPage: false });
  const { client } = stack;
  for (const action of ['createSchedule', 'updateSchedule', 'reassignSchedule', 'cancelSchedule']) {
    assert.equal(client.retryAllowed(action), true, `${action} 有服务端回执保障`);
  }
  assert.equal(client.retryAllowed('createProject'), true);
  for (const action of ['requestBindingNumber', 'assignManager', 'createInvitation', 'applyInvitation', 'approveInvitation', 'removeMember']) {
    assert.equal(client.retryAllowed(action), false, `${action} 无幂等保障，不得重发`);
  }
  const serviceSrc = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/scheduleSandbox/vendor/service.js'), 'utf8');
  const scheduleSrc = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/scheduleSandbox/vendor/schedule-service.js'), 'utf8');
  assert.ok(scheduleSrc.includes('tryReceiptReplay'), '施工回执路径应存在');
  assert.ok(!/case 'createInvitation':[\s\S]{0,400}requestId/.test(serviceSrc),
    'createInvitation 分支不应读取 requestId（无幂等保障）');
});

// ─────────────────────── T2：未决记录单一 envelope 完整绑定 ────────────────

test('T2.1 未决记录与快照是单一 envelope，一个键即可完整表达', async () => {
  const stack = loadStack({ handler: async () => { throw new Error('timeout'); } });
  await bindAccount(stack);
  await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'rs-1', form: { content: '原内容', restDays: ['2026-01-02'] } },
    { api: stack.api }
  );
  const keys = [...stack.store.map.keys()];
  assert.equal(keys.length, 2, `应只有账号键 + 单一 envelope 键，实际 ${keys.join(',')}`);
  const envelopeKey = keys.find(k => k.includes(':envelope:'));
  assert.ok(envelopeKey, '必须存在 envelope 键');
  const envelope = stack.store.map.get(envelopeKey);
  for (const field of ['requestId', 'action', 'actionClass', 'projectId', 'accountId', 'roundId', 'envId', 'snapshot', 'snapshotDigest']) {
    assert.ok(Object.prototype.hasOwnProperty.call(envelope, field), `envelope 必须自带 ${field}`);
  }
  assert.equal(envelope.snapshotDigest, stack.client.snapshotDigest(envelope.snapshot), '快照摘要必须自洽');
});

test('T2.2 存储半写/半清理都拼不出合法请求，读取即阻断', async () => {
  {
    const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
    await bindAccount(stack);
    const before = stack.calls.length;
    stack.store.failWrite = true;
    const blocked = await stack.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'w-1', form: { content: 'x' } },
      { api: stack.api }
    );
    assert.equal(blocked.code, 'SANDBOX_STORAGE_UNAVAILABLE');
    assert.equal(stack.calls.length, before, '写不进去时不得发送');
  }
  {
    const stack = loadStack({ handler: async () => { throw new Error('timeout'); } });
    await bindAccount(stack);
    await stack.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'w-2', form: { content: 'x' } },
      { api: stack.api }
    );
    const key = [...stack.store.map.keys()].find(k => k.includes(':envelope:'));
    const broken = stack.store.map.get(key);
    broken.snapshot.form.content = '被篡改';
    stack.store.map.set(key, broken);
    const before = stack.calls.length;
    const resumed = await stack.client.resumePending({ api: stack.api });
    assert.equal(resumed.code, 'SANDBOX_STORAGE_UNAVAILABLE', '摘要不符必须阻断');
    assert.equal(stack.calls.length, before, '摘要不符不得发送');
  }
  {
    const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
    await bindAccount(stack);
    await stack.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'w-3', form: { content: '第一次载荷' } },
      { api: stack.api }
    );
    stack.store.failRemove = true;
    await stack.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'w-4', form: { content: '第二次载荷' } },
      { api: stack.api }
    );
    stack.store.failRemove = false;
    const pending = stack.client.readPending(stack.store, ENV_ID, ROUND);
    assert.ok(pending.record, '清理失败时未决记录仍在');
    // 清理失败的是 w-4 那次（结果已定但标记删不掉），因此它必须继续拦着新写
    assert.equal(pending.record.requestId, 'w-4', '未决记录必须是删不掉的那一次');
    assert.equal(pending.record.writeLocked, false, '该次有回执保障，不应被锁写');
    const before = stack.calls.length;
    const fresh = await stack.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'w-5', form: { content: '第三次载荷' } },
      { api: stack.api }
    );
    assert.equal(fresh.code, 'SANDBOX_PENDING_UNRESOLVED');
    assert.equal(stack.calls.length, before, '不得发出新编号 + 旧载荷的混合请求');
  }
});

test('T2.3 同轮次换目标：恢复时停止，不覆盖原目标', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 't-1', form: { content: '原目标载荷' } },
    { api: first.api }
  );
  const second = loadStack({ store, target: 'p_sbx_other', handler: async () => ({ result: { ok: true } }) });
  const resumed = await second.client.resumePending({ api: second.api });
  assert.equal(resumed.code, 'SANDBOX_TARGET_CHANGED', '目标变化必须停止');
  assert.equal(businessCalls(second).length, 0, '不得改发到新目标');
  assert.equal(second.calls.length, 0, '目标不一致应在任何网络请求之前停止');
  const back = loadStack({ store, target: 'p_sbx_target', handler: async () => ({ result: { ok: true } }) });
  const okResume = await back.client.resumePending({ api: back.api });
  assert.equal(okResume.ok, true, '目标一致时应可恢复');
  const sent = businessCalls(back);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].projectId, 'p_sbx_target');
});

test('T2.4 可信账号隔离：换账号不得恢复他人未决记录，且不信任表单 actorId', async () => {
  const store = makeStorage();
  const owner = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(owner);
  await owner.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'a-1', form: { content: '甲的载荷' } },
    { api: owner.api }
  );
  store.setStorageSync(`${originalProof.cachePrefix}account:${ENV_ID}:${ROUND}`, 'u_another_account');
  const other = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  const resumed = await other.client.resumePending({ api: other.api });
  assert.equal(resumed.ok, false);
  assert.equal(resumed.code, 'SANDBOX_NO_PENDING', '他人账号不应看到本人的未决记录');
  assert.equal(other.calls.length, 0, '不得恢复他人未决记录');
  const fake = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  fake.store.setStorageSync(`${originalProof.cachePrefix}account:${ENV_ID}:${ROUND}`, TRUSTED_USER);
  const forged = await fake.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'a-2', actorId: TRUSTED_USER, form: { content: 'x' } },
    { api: fake.api }
  );
  assert.equal(forged.code, 'SANDBOX_PENDING_UNRESOLVED', '伪造 actorId 不得绕过未决记录');
});

test('T2.5 读取失败不得当作"没有未决"', async () => {
  const stack = loadStack({ handler: async () => { throw new Error('timeout'); } });
  await bindAccount(stack);
  await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'r-1', form: { content: 'x' } },
    { api: stack.api }
  );
  stack.store.failRead = true;
  const before = stack.calls.length;
  const blocked = await stack.client.callSandbox(
    { action: 'listSchedules', projectId: 'p_sbx_target', requestId: 'r-2' },
    { api: stack.api }
  );
  assert.equal(blocked.code, 'SANDBOX_STORAGE_UNAVAILABLE');
  assert.equal(stack.calls.length, before, '读不到未决记录时不得发送');
});

test('T2.6 旧格式残留只阻断不删除（不清用户缓存）', async () => {
  const legacyKey = `${originalProof.cachePrefix}pending:${ENV_ID}:${ROUND}`;
  const store = makeStorage();
  const bootstrap = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  await bindAccount(bootstrap);
  store.setStorageSync(legacyKey, { requestId: 'legacy-unknown' });
  const stack = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  const before = stack.calls.length;
  const blocked = await stack.client.callSandbox(
    { action: 'listSchedules', projectId: 'p_sbx_target', requestId: 'legacy-check' },
    { api: stack.api }
  );
  assert.equal(blocked.code, 'SANDBOX_STORAGE_UNAVAILABLE');
  assert.ok(store.map.has(legacyKey), '旧缓存必须保留，不得擅自删除');
  assert.equal(stack.calls.length, before, '旧残留未确认前不得发送');
});

test('T2.7 普通提交不静默恢复：同号也不重发，必须走显式恢复接口', async () => {
  let calls = 0;
  const stack = loadStack({
    handler: async () => {
      calls++;
      if (calls === 1) throw new Error('timeout');
      return { result: { ok: true, sandbox: true, scheduleId: 'sch-replayed' } };
    }
  });
  await bindAccount(stack);
  await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'same-1', form: { content: '原内容' } },
    { api: stack.api }
  );
  const before = businessCalls(stack).length;
  const normal = await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'same-1', form: { content: '换了内容' } },
    { api: stack.api }
  );
  assert.equal(normal.code, 'SANDBOX_PENDING_UNRESOLVED');
  assert.equal(businessCalls(stack).length, before, '普通提交不得静默恢复或改载荷');
  const identitiesBefore = stack.calls.filter(c => c.action === 'identify').length;
  const resumed = await stack.client.resumePending({ api: stack.api });
  assert.equal(resumed.ok, true, `显式恢复应成功：${JSON.stringify(resumed)}`);
  const sent = businessCalls(stack);
  assert.equal(sent.length, before + 1, '显式恢复应恰好发送一次业务请求');
  assert.equal(sent[sent.length - 1].form.content, '原内容', '必须用原快照载荷');
  assert.equal(
    stack.calls.filter(c => c.action === 'identify').length, identitiesBefore + 1,
    '恢复前应恰好再核实一次当前身份'
  );
});

// ───────────────────── T4：带凭据的页面恢复与字段一致性 ───────────────────

test('T4.1 未决期间只允许补录该请求所需凭据，业务字段仍锁定', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  const secret = 'LOCAL_SYNTHETIC_SECRET';
  await first.client.callSandbox(
    { action: 'approveInvitation', projectId: 'p_sbx_target', invitationId: 'inv-local', applicantNumber: secret, requestId: 'ap-1' },
    { api: first.api }
  );
  const second = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  second.page.onLoad();
  assert.equal(second.page.data.pendingRequestId, 'ap-1', '必须恢复真实请求编号');
  assert.deepEqual(second.page.data.pendingSensitiveKeys, ['applicantNumber']);
  second.page.inputField(inputEvent('invitationIdInput', 'inv-changed'));
  assert.equal(second.page.data.invitationIdInput, 'inv-local', '业务字段必须保持原快照值');
  second.page.inputForm(inputEvent('content', '改了内容'));
  assert.equal(second.page.data.form.content, '', '施工表单必须锁定');
  second.page.inputCredential(inputEvent('bindingNumberInput', 'x'));
  assert.equal(second.page.data.bindingNumberInput, '', '非本次所需凭据必须拒绝');
  second.page.inputCredential(inputEvent('applicantNumberInput', secret));
  assert.equal(second.page.data.applicantNumberInput, secret, '本次所需凭据应可补录');
  assert.ok(!JSON.stringify([...store.map.values()]).includes(secret), '原始凭据不得进入存储');
});

test('T4.2 凭据摘要不匹配时拒绝发送', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'approveInvitation', projectId: 'p_sbx_target', invitationId: 'inv-local', applicantNumber: 'SEC1', requestId: 'ap-2' },
    { api: first.api }
  );
  const second = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  second.page.onLoad();
  second.page.inputCredential(inputEvent('applicantNumberInput', 'WRONG'));
  await second.page.retryPending();
  assert.equal(second.calls.length, 0, '凭据不符不得发送');
  assert.match(second.page.data.lastError, /与原请求不一致/);
});

test('T4.3 凭据正确时按该动作的恢复策略处理（无幂等保障则停止重发）', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'approveInvitation', projectId: 'p_sbx_target', invitationId: 'inv-local', applicantNumber: 'SEC1', requestId: 'ap-3' },
    { api: first.api }
  );
  const second = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  second.page.onLoad();
  second.page.inputCredential(inputEvent('applicantNumberInput', 'SEC1'));
  await second.page.retryPending();
  assert.equal(second.calls.length, 0, '无幂等保障的动作不得重发');
  assert.match(second.page.data.lastError, /没有服务端幂等保障/);
});

test('T4.4 restDays 与常用字段正确回填到展示字段', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    {
      action: 'createSchedule',
      projectId: 'p_sbx_target',
      requestId: 'rs-2',
      form: { content: '施工内容', restDays: ['2026-01-02', '2026-01-03'], startDate: '2026-01-01', endDate: '2026-01-05', expectedDate: '2026-01-05' }
    },
    { api: first.api }
  );
  const second = loadStack({ store });
  second.page.onLoad();
  assert.equal(second.page.data.form.restDaysText, '2026-01-02,2026-01-03',
    'restDays 必须回填到表单实际使用的 restDaysText');
  assert.equal(second.page.data.form.content, '施工内容');
  const src = fs.readFileSync(PAGE_PATH, 'utf8');
  assert.ok(src.includes("['invitationId', 'invitationIdInput']"), '邀请编号必须列入快照回填映射');
  assert.ok(src.includes("['scheduleId', 'scheduleIdInput']"), '安排编号必须列入快照回填映射');
});

test('T4.5 预计完成日与结束日不一致时必须显式确认，不默认填 true', async () => {
  const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
  await bindAccount(stack);
  stack.page.onLoad();
  stack.page.inputForm(inputEvent('startDate', '2026-02-01'));
  stack.page.inputForm(inputEvent('endDate', '2026-02-10'));
  stack.page.inputForm(inputEvent('expectedDate', '2026-02-20'));
  assert.equal(stack.page.data.dateMismatch, true, '日期不一致必须被识别');
  assert.equal(stack.page.data.dateConfirmed, false);
  await stack.page.runAction('createSchedule');
  assert.equal(stack.calls.length, 0, '未确认不得发送');
  assert.match(stack.page.data.lastError, /显式确认/);
  stack.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
  await stack.page.runAction('createSchedule');
  assert.equal(stack.calls.length, 1);
  assert.equal(stack.calls[0].expectedConfirmed, true, '显式确认后才发送 true');
});

test('T4.6 日期一致时不要求额外确认', async () => {
  const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
  await bindAccount(stack);
  stack.page.onLoad();
  stack.page.inputForm(inputEvent('startDate', '2026-02-01'));
  stack.page.inputForm(inputEvent('endDate', '2026-02-10'));
  stack.page.inputForm(inputEvent('expectedDate', '2026-02-10'));
  assert.equal(stack.page.data.dateMismatch, false);
  await stack.page.runAction('createSchedule');
  assert.equal(stack.calls.length, 1);
});

test('T4.7 拒绝环境下不展示可操作控件', async () => {
  const stack = loadStack({ envVersion: 'release' });
  stack.page.onLoad();
  assert.equal(stack.page.data.entryAllowed, false);
  const wxml = fs.readFileSync(path.join(MINIPROGRAM, 'pages/schedule-sandbox/schedule-sandbox.wxml'), 'utf8');
  assert.ok(wxml.includes('wx:if="{{!entryAllowed}}"'), '入口拒绝时只展示错误提示');
  assert.ok(wxml.includes('<block wx:else>'), '可操作控件必须全部在 wx:else 内');
});

test('T4.8 页面不再提供"放弃未决标记后新发"的路径', async () => {
  const wxml = fs.readFileSync(path.join(MINIPROGRAM, 'pages/schedule-sandbox/schedule-sandbox.wxml'), 'utf8');
  assert.ok(!wxml.includes('discardPending'), '不得保留直接放弃未决标记的入口');
  const pageSrc = fs.readFileSync(PAGE_PATH, 'utf8');
  assert.ok(!/discardPending\s*\(/.test(pageSrc), '页面逻辑不得保留无核验放弃路径');
  assert.ok(pageSrc.includes('resolvePendingAfterExternalCheck'), '解除必须走显式核对确认接口');
});

// ===== U1：重试遇前置拒绝保留原未决记录 =====

test('U1.1 重试遇业务码前置拒绝不清除原 envelope（不假定业务码都在回执之后）', async () => {
  // 模拟真实情况：施工写入服务端已成功，重试被前置维护检查拒绝。
  // tryReceiptReplay 在读回执之前先做 assertProjectWritable，
  // 因此 PROJECT_NOT_WRITABLE 完全可能在没读原回执时返回。
  let phase = 'lost';
  const stack = loadStack({
    handler: async () => {
      if (phase === 'lost') {
        // 服务端已提交，但响应在传输中丢失
        throw new Error('timeout after server commit');
      }
      if (phase === 'reject') {
        return { result: { ok: false, code: 'PROJECT_NOT_WRITABLE', message: '项目当前处于维护或未就绪状态' } };
      }
      return { result: { ok: true, sandbox: true, scheduleId: 'sch-1' } };
    }
  });
  await bindAccount(stack);
  // 第一次：服务端已提交，响应丢失 → 结果未知
  const first = await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'sch-1', form: { content: '原载荷' } },
    { api: stack.api }
  );
  assert.equal(first.unknown, true, '第一次应留下未决记录');
  // 之后项目转入维护：重试被前置检查拒绝
  phase = 'reject';
  const denied = await stack.client.resumePending({ api: stack.api });
  assert.equal(denied.code, 'PROJECT_NOT_WRITABLE', `应返回服务端拒绝码，实际 ${denied.code}`);
  assert.equal(denied.unknown, true, '拒绝只说明本次未执行，原结果仍未知');
  assert.notEqual(denied.definite, true, '不得把重试拒绝当成原请求的确定结论');
  const pending = stack.client.readPending(stack.store, ENV_ID, ROUND);
  assert.ok(pending.record, '原未决记录必须保留');
  assert.equal(pending.record.requestId, 'sch-1', '必须仍是原来那次请求');
  assert.deepEqual(pending.snapshot.form, { content: '原载荷' }, '原快照必须保留');
  // 维护恢复后同号重试可取回原结果
  phase = 'ok';
  const resumed = await stack.client.resumePending({ api: stack.api });
  assert.equal(resumed.ok, true, `恢复条件具备后同号应成功：${JSON.stringify(resumed)}`);
  assert.equal(stack.client.readPending(stack.store, ENV_ID, ROUND).record, null, '成功后清理');
});

test('U1.2 失权/停用类前置拒绝同样保留原记录', async () => {
  for (const code of ['NO_ACCESS', 'IDENTITY_DISABLED', 'PROJECT_NOT_WRITABLE', 'OCCUPANCY_INCONSISTENT']) {
    let first = true;
    const stack = loadStack({
      handler: async () => {
        if (first) { first = false; throw new Error('timeout after server commit'); }
        return { result: { ok: false, code, message: '前置拒绝' } };
      }
    });
    await bindAccount(stack);
    first = true;
    await stack.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: `req-${code}`, form: { content: 'x' } },
      { api: stack.api }
    );
    const denied = await stack.client.resumePending({ api: stack.api });
    assert.equal(denied.code, code);
    assert.notEqual(denied.definite, true, `${code} 不得被当成原请求的确定结论`);
    assert.ok(stack.client.readPending(stack.store, ENV_ID, ROUND).record, `${code} 后原记录必须保留`);
  }
});

test('U1.3 恢复期间不放开新写', async () => {
  let first = true;
  const stack = loadStack({
    handler: async () => {
      if (first) { first = false; throw new Error('timeout after server commit'); }
      return { result: { ok: false, code: 'NO_ACCESS', message: '前置拒绝' } };
    }
  });
  await bindAccount(stack);
  first = true;
  await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'sch-1', form: { content: 'x' } },
    { api: stack.api }
  );
  await stack.client.resumePending({ api: stack.api });
  const before = businessCalls(stack).length;
  const fresh = await stack.client.callSandbox(
    { action: 'listSchedules', projectId: 'p_sbx_target', requestId: 'brand-new' },
    { api: stack.api }
  );
  assert.equal(fresh.code, 'SANDBOX_PENDING_UNRESOLVED', '原记录未结束前不得放开新写');
  assert.equal(businessCalls(stack).length, before, '不得发出新业务请求');
});

test('U1.4 首次请求的确定业务拒绝仍可修正（不被 U1 波及）', async () => {
  const stack = loadStack({ handler: async () => ({ result: { ok: false, code: 'SCHEDULE_CONFLICT', message: '日期冲突' } }) });
  await bindAccount(stack);
  // 注意：本例的第一次响应就是业务拒绝（没有过"响应丢失"），
  const first = await stack.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'sch-first', form: { content: 'x' } },
    { api: stack.api }
  );
  assert.equal(first.definite, true, '首次请求的确定拒绝应可修正');
  assert.equal(stack.client.readPending(stack.store, ENV_ID, ROUND).record, null, '首次确定拒绝应清理');
});

// ===== U2：恢复前确认当前会话身份 =====

test('U2.1 传输层返回不同身份时恢复零业务发送，且不覆盖原记录', async () => {
  const store = makeStorage();
  const owner = loadStack({ store, identifyResult: { ok: true, userId: 'u_A' } });
  await bindAccount(owner);
  await owner.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'A-request', form: { content: 'A 载荷' } },
    { api: owner.api }
  );
  const key = `${originalProof.cachePrefix}account:${ENV_ID}:${ROUND}`;
  const envelopeKeyBefore = [...store.map.keys()].find(k => k.includes(':envelope:'));
  const before = clone(store.map.get(envelopeKeyBefore));

  // 另一账号进入同一存储：服务端 identify 会返回 u_B
  const other = loadStack({ store, identifyResult: { ok: true, userId: 'u_B' }, handler: async () => ({ result: { ok: true } }) });
  other.page.onLoad();
  await other.page.retryPending();
  assert.equal(businessCalls(other).length, 0, '身份不符时不得发出业务请求');
  assert.equal(other.page.data.lastError.includes('执行人不同'), true, `应说明身份不符：${other.page.data.lastError}`);
  // 原记录与账号绑定都不得被覆盖
  assert.deepEqual(store.map.get(envelopeKeyBefore), before, '原未决记录不得被覆盖');
  assert.equal(store.map.get(key), 'u_A', '账号绑定不得被另一账号覆盖');
});

test('U2.2 同一身份重进可正常恢复', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'same-1', form: { content: '原内容' } },
    { api: first.api }
  );
  const again = loadStack({ store, handler: async () => ({ result: { ok: true, sandbox: true } }) });
  const resumed = await again.client.resumePending({ api: again.api });
  assert.equal(resumed.ok, true, `同身份应可恢复：${JSON.stringify(resumed)}`);
  assert.equal(businessCalls(again).length, 1);
});

test('U2.3 身份请求失败保留原记录且零业务发送', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'same-1', form: { content: '原内容' } },
    { api: first.api }
  );
  for (const failure of ['network', 'no-userid', 'not-ok']) {
    const again = loadStack({
      store,
      handler: async () => ({ result: { ok: true } }),
      identifyResult: failure === 'no-userid'
        ? { ok: true, sandbox: true }
        : failure === 'not-ok' ? { ok: false, code: 'IDENTITY_UNAVAILABLE', message: '无法确认身份' } : null
    });
    if (failure === 'network') {
      again.api.cloud.callFunction = async args => {
        again.calls.push(clone(args.data));
        throw new Error('network down');
      };
    }
    const resumed = await again.client.resumePending({ api: again.api });
    assert.equal(resumed.ok, false, `${failure} 时不得恢复`);
    assert.equal(resumed.code, 'SANDBOX_IDENTITY_UNCONFIRMED', `${failure} 应报身份未确认：${resumed.code}`);
    assert.equal(businessCalls(again).length, 0, `${failure} 时零业务发送`);
    assert.ok(again.client.readPending(store, ENV_ID, ROUND).record, `${failure} 时原记录必须保留`);
  }
});

test('U2.4 身份刷新独立完成：不被旧未决记录锁死，也不覆盖任何未决记录', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'same-1', form: { content: '原内容' } },
    { api: first.api }
  );
  const envelopeKey = [...store.map.keys()].find(k => k.includes(':envelope:'));
  const before = clone(store.map.get(envelopeKey));
  const again = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  const identity = await again.client.refreshSessionIdentity(again.api);
  assert.equal(identity.status, 'same', `同身份刷新应返回 same：${JSON.stringify(identity)}`);
  assert.deepEqual(store.map.get(envelopeKey), before, '身份刷新不得覆盖任何未决记录');
  assert.equal(again.client.readPending(store, ENV_ID, ROUND).record.requestId, 'same-1', '未决记录仍在');
});

test('U2.5 身份绑定存储失败时不得混用旧身份', async () => {
  // 场景 A：本地**无**绑定且绑定写失败 → 不得报"已确认"
  {
    const store = makeStorage();
    const broken = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
    broken.store.failWrite = true;
    const identity = await broken.client.refreshSessionIdentity(broken.api);
    assert.equal(identity.status, 'unknown', `绑定写不进去不得当作已确认：${JSON.stringify(identity)}`);
    assert.equal(businessCalls(broken).length, 0, '身份未确认不得发出业务请求');
  }
  // 场景 B：本地**已有**绑定，但绑定记录被读成损坏 → 不得沿用
  {
    const store = makeStorage();
    const first = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
    await bindAccount(first);
    const key = `${originalProof.cachePrefix}account:${ENV_ID}:${ROUND}`;
    store.map.set(key, { userId: TRUSTED_USER });   // 类型不符 → 损坏
    const broken = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
    const identity = await broken.client.refreshSessionIdentity(broken.api);
    assert.equal(identity.status, 'unknown', `绑定损坏不得当作已确认：${JSON.stringify(identity)}`);
    // 恢复流程同样必须停住
    await first.client.callSandbox(
      { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'u-1', form: { content: 'x' } },
      { api: first.api }
    ).catch(() => {});
    const before = businessCalls(broken).length;
    const resumed = await broken.client.resumePending({ api: broken.api });
    assert.equal(resumed.ok, false, '绑定损坏时不得恢复');
    assert.equal(businessCalls(broken).length, before, '零业务发送');
  }
});

test('U2.6 identify 零写说明已更正为实际行为', () => {
  const src = fs.readFileSync(CLIENT_PATH, 'utf8');
  assert.ok(!/只读动作：结果未知可安全重发，因为不会产生写入/.test(src), '不得再声称 identify 零写');
  assert.ok(src.includes('并非零写'), '必须说明 identify 首次会写 users 与审计');
  // 依据 vendor 实际逻辑：identity 首次见账号会 add users 并写审计
  const serviceSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions/scheduleSandbox/vendor/service.js'), 'utf8');
  assert.ok(/add\('users'/.test(serviceSrc), 'vendor identity 确实会写 users');
  assert.ok(serviceSrc.includes('registerIdentity'), 'vendor identity 确实会写注册审计');
});

// ===== U3：恢复目标与元数据一致性 =====

test('U3.1 当前登记目标为空时恢复零请求', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'target-1', form: { content: '原内容' } },
    { api: first.api }
  );
  const cleared = loadStack({ store, target: '', handler: async () => ({ result: { ok: true } }) });
  const resumed = await cleared.client.resumePending({ api: cleared.api });
  assert.equal(resumed.ok, false, '目标被清空时不得恢复');
  assert.equal(resumed.code, 'SANDBOX_PROJECT_REQUIRED', resumed.code);
  assert.equal(cleared.calls.length, 0, '目标校验是纯本地判定，必须零请求');
  // 目标恢复后同一记录仍可恢复
  const restored = loadStack({ store, target: 'p_sbx_target', handler: async () => ({ result: { ok: true } }) });
  const ok = await restored.client.resumePending({ api: restored.api });
  assert.equal(ok.ok, true, '目标恢复后应可恢复');
  assert.equal(businessCalls(restored)[0].projectId, 'p_sbx_target');
});

test('U3.2 envelope 顶层动作与快照动作不一致时停止', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'snap-1', form: { content: '原内容' } },
    { api: first.api }
  );
  const envelopeKey = [...store.map.keys()].find(k => k.includes(':envelope:'));
  const stored = store.map.get(envelopeKey);
  assert.equal(stored.snapshot.action, 'createSchedule');
  // 顶层改成 cancelSchedule，快照与摘要保持原样（单键存储不自动保证一致）
  store.map.set(envelopeKey, { ...stored, action: 'cancelSchedule' });
  const resumed = await first.client.resumePending({ api: first.api });
  assert.equal(resumed.ok, false, '元数据损坏时不得恢复');
  assert.equal(resumed.code, 'SANDBOX_STORAGE_UNAVAILABLE', resumed.code);
  assert.equal(businessCalls(first).length, 1, '不得发出被篡改的请求');
  // 损坏记录**不得**被自动修补成另一请求
  const after = first.client.readPending(store, ENV_ID, ROUND);
  assert.equal(after.available, false, '损坏记录应报告不可用');
  assert.equal(after.record, null, '不得把损坏记录当作可用未决');
  const raw = store.map.get(envelopeKey);
  assert.equal(raw.action, 'cancelSchedule', '原记录不得被静默改写');
  assert.equal(raw.snapshot.action, 'createSchedule', '快照不得被改写');
});

test('U3.3 envelope 顶层项目与快照项目不一致时停止', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'snap-2', form: { content: 'x' } },
    { api: first.api }
  );
  const envelopeKey = [...store.map.keys()].find(k => k.includes(':envelope:'));
  const stored = store.map.get(envelopeKey);
  // 顶层改成另一个项目，快照保持原样
  store.map.set(envelopeKey, { ...stored, projectId: 'p_sbx_another' });
  const before = businessCalls(first).length;
  const resumed = await first.client.resumePending({ api: first.api });
  assert.equal(resumed.ok, false);
  assert.equal(businessCalls(first).length, before, '零业务发送');
});

test('U3.4 envelope 账号与所在存储键不一致时停止', async () => {
  const store = makeStorage();
  const first = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(first);
  await first.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'snap-3', form: { content: 'x' } },
    { api: first.api }
  );
  // 顶层 accountId 改成别人，键仍是本人的
  const ownKey = [...store.map.keys()].find(k => k.includes(`:${TRUSTED_USER}`));
  const stored = store.map.get(ownKey);
  store.map.set(ownKey, { ...stored, accountId: 'u_someone_else' });
  const before = businessCalls(first).length;
  const resumed = await first.client.resumePending({ api: first.api });
  assert.equal(resumed.ok, false, '键归属不符必须停止');
  assert.equal(businessCalls(first).length, before, '零业务发送');
});

test('U3.5 项目类动作缺目标、无项目动作多目标均判损坏', async () => {
  const store = makeStorage();
  const s = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(s);
  await s.client.callSandbox(
    { action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'snap-4', form: { content: 'x' } },
    { api: s.api }
  );
  const envelopeKey = [...store.map.keys()].find(k => k.includes(':envelope:'));
  const stored = store.map.get(envelopeKey);
  // 项目类动作顶层目标清空（快照同步清空并重算摘要，模拟"合法但自相矛盾"）
  const snapshot = { ...stored.snapshot, projectId: undefined };
  delete snapshot.projectId;
  store.map.set(envelopeKey, {
    ...stored, projectId: '',
    snapshot,
    snapshotDigest: s.client.snapshotDigest(snapshot)
  });
  const before = businessCalls(s).length;
  const resumed = await s.client.resumePending({ api: s.api });
  assert.equal(resumed.ok, false, '项目类动作缺目标必须停止');
  assert.equal(businessCalls(s).length, before, '零业务发送');
});

test('U3.6 无项目动作不把当前目标补进原本无目标的提交', async () => {
  const store = makeStorage();
  // createInvitation 是项目类；这里用 listMyProjects（无项目动作）验证不被补目标
  const s = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
  await bindAccount(s);
  await s.client.callSandbox(
    { action: 'listMyProjects', requestId: 'np-1' },
    { api: s.api }
  );
  const t = loadStack({ store, target: 'p_sbx_target', handler: async () => ({ result: { ok: true, projects: [] } }) });
  const resumed = await t.client.resumePending({ api: t.api });
  assert.equal(resumed.ok, true, '无项目动作应可恢复');
  const sent = businessCalls(t);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'listMyProjects');
  assert.equal(sent[0].projectId, undefined, '无项目动作不得被补进当前目标');
});

test('U3.7 写后读回核对完整关键绑定（顶层字段未真正落盘即视为失败）', () => {
  const stack = loadStack({ loadPage: false });
  const { client, store } = stack;
  const envId = ENV_ID;
  const snapshot = { action: 'listSchedules', projectId: 'p_sbx_target' };
  const envelope = {
    kind: 'sandbox-envelope', version: 1, requestId: 'r-1', action: 'listSchedules',
    actionClass: 'read-only', projectId: 'p_sbx_target', accountId: 'u_x', roundId: ROUND, envId,
    at: 1, writeLocked: false, snapshot, snapshotDigest: client.snapshotDigest(snapshot)
  };
  assert.equal(client.writeEnvelope(store, envId, ROUND, envelope), true, '正常写入应成功');
  // 模拟存储**静默丢弃**某个顶层字段（半写）：写后读回必须发现并判失败
  const original = store.setStorageSync;
  store.setStorageSync = (k, v) => {
    const dropped = { ...v };
    delete dropped.action;
    original(k, dropped);
  };
  assert.equal(client.writeEnvelope(store, envId, ROUND, envelope), false, '顶层绑定未落盘必须判失败');
  // 快照被替换也必须判失败
  store.setStorageSync = (k, v) => {
    const tampered = { ...v, snapshot: { ...v.snapshot, content: '被替换' } };
    original(k, tampered);
  };
  assert.equal(client.writeEnvelope(store, envId, ROUND, envelope), false, '快照未落盘必须判失败');
  store.setStorageSync = original;
  assert.equal(client.writeEnvelope(store, envId, ROUND, envelope), true, '恢复正常后应写入成功');
});

// ===== U3（页面/客户端契约收尾）：组包、发送前置与恢复一致 =====

test('U3.8 实际 Page 组包：无项目动作不自动加项目目标', () => {
  // 有登记项目时，本次回归正是 buildPayload 给所有动作加 projectId 触发
  const withTarget = loadStack({ loadPage: true, target: 'p_sbx_target', handler: async () => ({ result: { ok: true } }) });
  withTarget.page.onLoad();
  for (const action of ['identify', 'listMyProjects', 'requestBindingNumber', 'createProject', 'applyInvitation']) {
    const payload = withTarget.page.buildPayload(action);
    assert.equal(payload.projectId, undefined, `无项目动作 ${action} 不得自动加 projectId`);
  }
  // 项目必需动作在有目标时仍按契约携带
  const create = withTarget.page.buildPayload('createSchedule');
  assert.equal(create.projectId, 'p_sbx_target', '项目必需动作应携带登记目标');
  const exec = withTarget.page.buildPayload('updateSchedule');
  assert.equal(exec.projectId, 'p_sbx_target', '其它项目必需动作应携带登记目标');
  // 无登记项目时，无项目动作同样不带 projectId
  const noTarget = loadStack({ loadPage: true, target: '', handler: async () => ({ result: { ok: true } }) });
  noTarget.page.onLoad();
  for (const action of ['identify', 'listMyProjects', 'requestBindingNumber', 'createProject', 'applyInvitation']) {
    const payload = noTarget.page.buildPayload(action);
    assert.equal(payload.projectId, undefined, `无登记项目时 ${action} 不得带 projectId`);
  }
});

test('U3.9 实际 Page 走无项目动作响应丢失后经真实恢复可用（不注入配置目标）', async () => {
  const store = makeStorage();
  const stack = loadStack({ store, target: 'p_sbx_target', handler: async () => { throw new Error('timeout'); } });
  await bindAccount(stack);
  stack.page.onLoad();
  // 真实 Page runAction：此前会因 buildPayload 自动加项目而触发 U3 回归
  await stack.page.runAction('listMyProjects');
  assert.equal(businessCalls(stack).length, 1, 'listMyProjects 应已发出');
  const pending = stack.client.readPending(store, ENV_ID, ROUND);
  assert.equal(pending.available, true, '响应丢失后应存在可恢复未决记录');
  assert.equal(pending.record.action, 'listMyProjects');
  // 关键回归点：envelope 不得带项目，否则 validateEnvelope 会判"无项目动作却带目标"
  const envelopeKey = [...store.map.keys()].find(k => k.includes(':envelope:'));
  const stored = store.map.get(envelopeKey);
  assert.equal(stored.projectId, '', '无项目动作的 envelope 不得带项目目标（U3 回归点）');
  // 切换正常响应后，按同一编号恢复
  const recovered = loadStack({ store, target: 'p_sbx_target', handler: async () => ({ result: { ok: true, projects: [] } }) });
  const resumed = await recovered.client.resumePending({ api: recovered.api });
  assert.equal(resumed.ok, true, '恢复应成功，不再被 SANDBOX_STORAGE_UNAVAILABLE 卡死');
  const sent = businessCalls(recovered);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'listMyProjects');
  assert.equal(sent[0].projectId, undefined, '恢复不得注入配置目标');

  // createProject 同样：真实 Page 超时后恢复不卡死、不补目标
  const cStack = loadStack({ store, target: 'p_sbx_target', handler: async () => { throw new Error('timeout'); } });
  await cStack.page.runAction('createProject');
  const cRecovered = loadStack({ store, target: 'p_sbx_target', handler: async () => ({ result: { ok: true, projectId: 'p_new' } }) });
  const cResumed = await cRecovered.client.resumePending({ api: cRecovered.api });
  assert.equal(cResumed.ok, true, 'createProject 恢复应成功');
  const cSent = businessCalls(cRecovered);
  assert.equal(cSent.length, 1);
  assert.equal(cSent[0].action, 'createProject');
  assert.equal(cSent[0].projectId, undefined, 'createProject 恢复不得注入配置目标');
});

test('U3.10 客户端直接收到违约目标参数按无项目组包契约处理，不发送后才判坏', async () => {
  const store = makeStorage();
  // 用超时 handler 保留 envelope 以便检查；违约 projectId 应在发送前归一
  const s = loadStack({ store, target: 'p_sbx_target', handler: async () => { throw new Error('timeout'); } });
  await bindAccount(s);
  // createProject 是 PROJECT_OPTIONAL，直接传入 projectId 属于违约
  const result = await s.client.callSandbox(
    { action: 'createProject', projectId: 'p_sbx_target', requestId: 'np-violation', name: '虚构测试 · 违约目标' },
    { api: s.api }
  );
  assert.equal(result.unknown, true, '超时场景：结果未知');
  const sent = businessCalls(s);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'createProject');
  assert.equal(sent[0].projectId, undefined, '违约 projectId 应被忽略，不得进入请求体');
  // envelope 不得带项目目标，否则恢复时会被 validateEnvelope 判结构损坏
  const envelopeKey = [...store.map.keys()].find(k => k.includes(':envelope:'));
  const stored = store.map.get(envelopeKey);
  assert.ok(stored, '超时后应有未决 envelope');
  assert.equal(stored.projectId, '', 'envelope 不得带项目目标，避免恢复时被判结构损坏');
  // 该记录应可正常恢复，不误报结构损坏
  const recovered = loadStack({ store, target: '', handler: async () => ({ result: { ok: true, projectId: 'p_new' } }) });
  const resumed = await recovered.client.resumePending({ api: recovered.api });
  assert.equal(resumed.ok, true, '无项目 envelope 应可恢复，不误报结构损坏');
});

// ===== U5：日期确认绑定到实际日期 =====

test('U5.1 确认后修改相关日期必须重新确认', async () => {
  const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
  await bindAccount(stack);
  stack.page.onLoad();
  stack.page.inputForm(inputEvent('endDate', '2026-10-09'));
  stack.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
  assert.equal(stack.page.data.dateMismatch, true);
  stack.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
  assert.equal(stack.page.data.dateConfirmed, true);
  assert.equal(stack.page.data.dateConfirmedFor, '2026-10-09|2026-10-10', '确认必须绑定日期组合');
  // 改预计日 → 旧确认立即失效
  stack.page.inputForm(inputEvent('expectedDate', '2026-10-15'));
  assert.equal(stack.page.data.dateConfirmed, false, '相关日期变化后必须清除旧确认');
  assert.equal(stack.page.data.dateConfirmedFor, '');
  const before = businessCalls(stack).length;
  await stack.page.runAction('createSchedule');
  assert.equal(businessCalls(stack).length, before, '未重新确认不得发送');
  assert.match(stack.page.data.lastError, /重新勾选显式确认/);
  // 重新确认后可以发送
  stack.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
  await stack.page.runAction('createSchedule');
  const sent = businessCalls(stack);
  assert.equal(sent.length, before + 1);
  assert.equal(sent[sent.length - 1].expectedConfirmed, true);
  assert.equal(sent[sent.length - 1].form.expectedDate, '2026-10-15');
});

test('U5.2 改结束日同样使确认失效', async () => {
  const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
  await bindAccount(stack);
  stack.page.onLoad();
  stack.page.inputForm(inputEvent('endDate', '2026-10-09'));
  stack.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
  stack.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
  stack.page.inputForm(inputEvent('endDate', '2026-10-20'));
  assert.equal(stack.page.data.dateConfirmed, false, '结束日变化必须清除确认');
  const before = businessCalls(stack).length;
  await stack.page.runAction('createSchedule');
  assert.equal(businessCalls(stack).length, before, '零业务发送');
});

test('U5.3 重进与切动作不沿用不相关的旧确认', async () => {
  const store = makeStorage();
  const s = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  await bindAccount(s);
  s.page.onLoad();
  s.page.inputForm(inputEvent('endDate', '2026-10-09'));
  s.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
  s.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
  assert.equal(s.page.data.dateConfirmed, true);
  // 切动作
  s.page.changeAction({ detail: { value: 0 } });
  assert.equal(s.page.data.dateConfirmed, false, '切动作必须清除旧确认');
  // 重进
  s.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
  const again = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
  again.page.onLoad();
  assert.equal(again.page.data.dateConfirmed, false, '重进不得沿用旧确认');
});

test('U5.4 取消勾选与非法事件值都按未确认处理（checkbox-group 数组事件）', async () => {
  const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
  await bindAccount(stack);
  stack.page.onLoad();
  stack.page.inputForm(inputEvent('endDate', '2026-10-09'));
  stack.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
  // 选中：checkbox-group 的 change 事件 detail.value 为 ['date-confirm']
  stack.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
  assert.equal(stack.page.data.dateConfirmed, true);
  // 取消勾选：数组变空
  stack.page.toggleDateConfirm({ detail: { value: [] } });
  assert.equal(stack.page.data.dateConfirmed, false, '取消勾选必须清除确认');
  assert.equal(stack.page.data.dateConfirmedFor, '');
  // 非数组 / 含其它值 / 缺 detail.value：一律按未确认，不得用真值转换蒙混
  stack.page.toggleDateConfirm({ detail: { value: 'date-confirm' } });
  assert.equal(stack.page.data.dateConfirmed, false, '非数组值不得当作已确认');
  stack.page.toggleDateConfirm({ detail: { value: ['other'] } });
  assert.equal(stack.page.data.dateConfirmed, false, '不含 date-confirm 的数组不得当作已确认');
  stack.page.toggleDateConfirm({ detail: {} });
  assert.equal(stack.page.data.dateConfirmed, false, '缺 detail.value 不得当作已确认');
  const before = businessCalls(stack).length;
  await stack.page.runAction('createSchedule');
  assert.equal(businessCalls(stack).length, before, '未确认不得发送');
});

test('U5.5 日期一致时不额外阻断', async () => {
  const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
  await bindAccount(stack);
  stack.page.onLoad();
  stack.page.inputForm(inputEvent('endDate', '2026-10-10'));
  stack.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
  assert.equal(stack.page.data.dateMismatch, false);
  assert.equal(stack.page.data.dateConfirmed, false);
  const before = businessCalls(stack).length;
  await stack.page.runAction('createSchedule');
  assert.equal(businessCalls(stack).length, before + 1, '日期一致不应额外要求确认');
});

test('U5.6 模板控件事件绑定与真实事件契约一致（checkbox-group 数组事件）', () => {
  const wxml = fs.readFileSync(path.join(MINIPROGRAM, 'pages/schedule-sandbox/schedule-sandbox.wxml'), 'utf8');
  // 确认控件必须是 <checkbox-group bindchange>：其 change 事件 detail.value 为字符串数组
  assert.ok(/<checkbox-group[^>]*bindchange="toggleDateConfirm"/.test(wxml), '确认控件必须用 checkbox-group 的 bindchange');
  // 组内唯一的 checkbox 必须有固定 value="date-confirm"（不能裸 <checkbox bindchange> 误用布尔契约）
  assert.ok(/<checkbox[^>]*value="date-confirm"/.test(wxml), '组内 checkbox 必须有固定 value="date-confirm"');
  assert.ok(!/bindtap="toggleDateConfirm"/.test(wxml), '不得把 change 事件绑成 tap');
  // 裸 <checkbox ... bindchange="toggleDateConfirm"> 属于误用布尔契约，必须不存在
  // （原生 checkbox 的 change 是数组事件，应绑定在 checkbox-group 上）
  assert.ok(!/<checkbox(?!\-group)[^>]*\bbindchange="toggleDateConfirm"/.test(wxml), '不得用裸 <checkbox bindchange> 误用布尔契约');
  // 日期输入必须走 inputForm（写入 form.<field>）
  for (const field of ['endDate', 'expectedDate']) {
    assert.ok(
      wxml.includes(`data-field="${field}" bindinput="inputForm"`),
      `${field} 必须绑定 inputForm 以触发确认失效`
    );
  }
  // 页面按数组契约处理：Array.isArray + 含 'date-confirm'
  const src = fs.readFileSync(PAGE_PATH, 'utf8');
  assert.ok(
    /toggleDateConfirm[\s\S]{0,200}Array\.isArray\(value\)/.test(src),
    '必须按数组契约判定确认事件值'
  );
  assert.ok(src.includes("value.includes('date-confirm')"), '必须检查 date-confirm 是否在选中数组中');
  // 页面应展示当前确认对应的日期组合
  assert.ok(wxml.includes('修改任一日期需重新确认'), '应提示修改日期需重新确认');
});
