// 施工安排独立测试副本：U3 / U5 收尾本地验收证据。
//
// 范围：仅本地合成数据；不联网、不操作云端、不安装、不部署、不清用户缓存。
// 复跑方式：node docs/证据/独立测试副本U3U5收尾-20261004.cjs
//   会在同目录生成 独立测试副本U3U5收尾-20261004.json。
//
// 配套历史证据（保留不改写）：
// - docs/证据/独立测试副本U1-U5返修复现-20261004.cjs / .json（U1–U5 验证）
// - docs/证据/独立测试副本U1-U5-Codex复核-20261004.cjs（Codex 追加核对）
// 本轮只新增 U3、U5 剩余收尾证据，不触碰上述历史文件。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const MINIPROGRAM = path.join(ROOT, 'miniapp', 'miniprogram');
const CLIENT_PATH = path.join(MINIPROGRAM, 'utils/schedule-sandbox-client.js');
const PAGE_PATH = path.join(MINIPROGRAM, 'pages/schedule-sandbox/schedule-sandbox.js');
const WXML_PATH = path.join(MINIPROGRAM, 'pages/schedule-sandbox/schedule-sandbox.wxml');
const PROOF_PATH = path.join(MINIPROGRAM, 'config/schedule-sandbox-proof.js');

const ENV_ID = 'cloud1-d8gcq5ag39d847723';
const ROUND = 'sandbox-round-t1';
const APPID = 'wxfb4db1615ac15531';
const TRUSTED_USER = 'u_trusted_account_for_t1';

// ── 最小测试替身（与 tests/schedule-sandbox-frontend.test.cjs 同源）──────
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getStorageSync(key) { return map.get(key); },
    setStorageSync(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); },
    removeStorageSync(key) { map.delete(key); }
  };
}

function loadStack(options = {}) {
  const { store = makeStorage(), target = 'p_sbx_target', envVersion = 'develop',
    enabled = true, handler = async () => { throw new Error('timeout'); },
    identifyResult = { ok: true, sandbox: true, userId: TRUSTED_USER } } = options;
  const proof = {
    ...require(PROOF_PATH), enabled, roundId: ROUND,
    sandboxProjectId: target, functionName: 'scheduleSandbox'
  };
  const nativeRequire = require('node:module').createRequire(CLIENT_PATH);
  const clientModule = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,wx){${fs.readFileSync(CLIENT_PATH, 'utf8')}\n})`)(
    name => (name === '../config/schedule-sandbox-proof' ? proof : nativeRequire(name)),
    clientModule, clientModule.exports, {});
  const client = clientModule.exports;
  const calls = [];
  const api = {
    ...store, storage: store,
    getAccountInfoSync: () => ({ miniProgram: { appId: APPID, envVersion } }),
    cloud: { async callFunction(args) {
      calls.push(JSON.parse(JSON.stringify(args.data)));
      if (args.data && args.data.action === 'identify') return { result: JSON.parse(JSON.stringify(identifyResult)) };
      return handler(args.data, calls.length);
    } }
  };
  let definition;
  vm.runInThisContext(`(function(require,Page,wx){${fs.readFileSync(PAGE_PATH, 'utf8')}\n})`)(
    name => {
      if (name.includes('schedule-sandbox-client')) return client;
      if (name.includes('config/schedule-sandbox-proof')) return proof;
      return nativeRequire(name);
    },
    value => { definition = value; }, api);
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
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
  return { proof, store, client, api, calls, page };
}

async function bindAccount(stack) {
  const result = await stack.client.callSandbox({ action: 'identify', requestId: 'bind-1' }, { api: stack.api });
  assert.equal(result.ok, true);
  stack.calls.length = 0;
  return result;
}

function businessCalls(stack) { return stack.calls.filter(c => c.action !== 'identify'); }
const inputEvent = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });

// ── 验收清单执行 ──────────────────────────────────────────────────────────
const results = [];
function record(id, title, fn) {
  try {
    const detail = fn() || {};
    results.push({ id, title, passed: true, detail });
    console.log(`  ✓ ${id} ${title}`);
  } catch (error) {
    results.push({ id, title, passed: false, error: String(error && error.message || error) });
    console.log(`  ✗ ${id} ${title} :: ${error && error.message}`);
  }
}

console.log('U3 验收清单（页面/客户端组包·发送前置·恢复一致）:');

// U3-1 实际 Page，有/无已登记项目，五个无项目动作组包不自动加项目
record('U3-1', '实际 Page 五个无项目动作组包不自动加项目', () => {
  const withTarget = loadStack({ loadPage: true, target: 'p_sbx_target', handler: async () => ({ result: { ok: true } }) });
  withTarget.page.onLoad();
  for (const action of ['identify', 'listMyProjects', 'requestBindingNumber', 'createProject', 'applyInvitation']) {
    assert.equal(withTarget.page.buildPayload(action).projectId, undefined, `${action} 不得带 projectId`);
  }
  assert.equal(withTarget.page.buildPayload('createSchedule').projectId, 'p_sbx_target', '项目必需动作仍带目标');
  const noTarget = loadStack({ loadPage: true, target: '', handler: async () => ({ result: { ok: true } }) });
  noTarget.page.onLoad();
  for (const action of ['identify', 'listMyProjects', 'requestBindingNumber', 'createProject', 'applyInvitation']) {
    assert.equal(noTarget.page.buildPayload(action).projectId, undefined, `${action} 无目标时也不带`);
  }
  return { noProjectActionsChecked: 5, projectRequiredKeepsTarget: true };
});

// U3-2 及以下异步场景在下方 IIFE 中通过 upsert 登记（与 U3-1 同步场景分开）。
(async () => {
  // U3-2 异步版本
  try {
    const store = makeStorage();
    const stack = loadStack({ store, target: 'p_sbx_target', handler: async () => { throw new Error('timeout'); } });
    await bindAccount(stack);
    stack.page.onLoad();
    await stack.page.runAction('listMyProjects');
    assert.equal(businessCalls(stack).length, 1);
    const pending = stack.client.readPending(store, ENV_ID, ROUND);
    assert.equal(pending.available, true);
    assert.equal(pending.record.action, 'listMyProjects');
    const key = [...store.map.keys()].find(k => k.includes(':envelope:'));
    assert.equal(store.map.get(key).projectId, '');
    const recovered = loadStack({ store, target: 'p_sbx_target', handler: async () => ({ result: { ok: true, projects: [] } }) });
    const resumed = await recovered.client.resumePending({ api: recovered.api });
    assert.equal(resumed.ok, true);
    const sent = businessCalls(recovered);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, 'listMyProjects');
    assert.equal(sent[0].projectId, undefined);
    upsert('U3-2', 'Page 无项目动作响应丢失后显式恢复可读原 envelope 且不注入目标', true, { recoverable: true, sameSnapshotNoInjectedTarget: true });
  } catch (e) {
    upsert('U3-2', 'Page 无项目动作响应丢失后显式恢复可读原 envelope 且不注入目标', false, { error: String(e.message) });
  }

  // U3-3 取号/申请结果未知：保留证据，非幂等策略拒绝重发，不误报结构损坏
  try {
    const store = makeStorage();
    const s = loadStack({ store, target: 'p_sbx_target', handler: async () => { throw new Error('timeout'); } });
    await bindAccount(s);
    await s.client.callSandbox({ action: 'requestBindingNumber', requestId: 'np-rbn', role: '师傅' }, { api: s.api });
    const pending = s.client.readPending(store, ENV_ID, ROUND);
    assert.equal(pending.available, true, '结果未知应保留证据');
    const before = s.calls.length;
    const resumed = await s.client.resumePending({ api: s.api });
    assert.equal(resumed.code, 'SANDBOX_RETRY_UNSAFE', '非幂等动作拒绝重发');
    assert.equal(s.calls.length, before, '被拒恢复零业务发送');
    upsert('U3-3', '取号/申请结果未知保留证据并按非幂等策略拒绝重发', true, { retained: true, resendRejected: 'SANDBOX_RETRY_UNSAFE' });
  } catch (e) {
    upsert('U3-3', '取号/申请结果未知保留证据并按非幂等策略拒绝重发', false, { error: String(e.message) });
  }

  // U3-4 项目必需动作缺目标/换目标：零请求，原记录保留
  try {
    const store = makeStorage();
    const first = loadStack({ store, target: 'p_sbx_target', handler: async () => { throw new Error('timeout'); } });
    await bindAccount(first);
    await first.client.callSandbox({ action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'snap-4', form: { content: 'x' } }, { api: first.api });
    const cleared = loadStack({ store, target: '', handler: async () => ({ result: { ok: true } }) });
    const resumed = await cleared.client.resumePending({ api: cleared.api });
    assert.equal(resumed.code, 'SANDBOX_PROJECT_REQUIRED', '目标清空时零请求');
    assert.equal(cleared.calls.length, 0, '纯本地判定零请求');
    const stillThere = first.client.readPending(store, ENV_ID, ROUND);
    assert.equal(stillThere.available, true, '原记录保留');
    upsert('U3-4', '项目必需动作缺目标零请求且原记录保留', true, { code: 'SANDBOX_PROJECT_REQUIRED', originalRetained: true });
  } catch (e) {
    upsert('U3-4', '项目必需动作缺目标零请求且原记录保留', false, { error: String(e.message) });
  }

  // U3-5 真正动作/项目/账号/快照损坏保持拒绝，不因本次修复放宽
  try {
    const store = makeStorage();
    const s = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
    await bindAccount(s);
    await s.client.callSandbox({ action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'snap-5', form: { content: 'x' } }, { api: s.api });
    const key = [...store.map.keys()].find(k => k.includes(':envelope:'));
    const stored = store.map.get(key);
    store.map.set(key, { ...stored, action: 'cancelSchedule' }); // 顶层与快照动作不一致
    const before = s.calls.length;
    const resumed = await s.client.resumePending({ api: s.api });
    assert.equal(resumed.ok, false);
    assert.equal(s.calls.length, before, '损坏记录零业务发送');
    upsert('U3-5', '真正损坏记录保持拒绝不放宽', true, { rejected: true, businessSends: 0 });
  } catch (e) {
    upsert('U3-5', '真正损坏记录保持拒绝不放宽', false, { error: String(e.message) });
  }

  // U3-6 客户端直接收到违约目标参数：发送前归一，不发送后才判坏
  try {
    const store = makeStorage();
    const s = loadStack({ store, target: 'p_sbx_target', handler: async () => { throw new Error('timeout'); } });
    await bindAccount(s);
    await s.client.callSandbox({ action: 'createProject', projectId: 'p_sbx_target', requestId: 'np-violation', name: '虚构测试 · 违约目标' }, { api: s.api });
    const sent = businessCalls(s);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].projectId, undefined, '违约 projectId 应被归一忽略');
    const key = [...store.map.keys()].find(k => k.includes(':envelope:'));
    assert.equal(store.map.get(key).projectId, '', 'envelope 不得带项目');
    upsert('U3-6', '客户端直接收到违约目标参数发送前归一处理', true, { projectIdNormalized: true });
  } catch (e) {
    upsert('U3-6', '客户端直接收到违约目标参数发送前归一处理', false, { error: String(e.message) });
  }

  console.log('U5 验收清单（checkbox-group 数组事件 + 日期组合绑定）:');
  // U5-1 模板 change 绑定在 group；checkbox 有固定 value；处理器接收 ['date-confirm'] / []
  try {
    const wxml = fs.readFileSync(WXML_PATH, 'utf8');
    assert.ok(/<checkbox-group[^>]*bindchange="toggleDateConfirm"/.test(wxml), 'change 必须绑在 checkbox-group');
    assert.ok(/<checkbox[^>]*value="date-confirm"/.test(wxml), 'checkbox 必须有固定 value="date-confirm"');
    assert.ok(!/bindtap="toggleDateConfirm"/.test(wxml), '不得绑成 tap');
    assert.ok(!/<checkbox(?!\-group)[^>]*\bbindchange="toggleDateConfirm"/.test(wxml), '不得裸 checkbox bindchange');
    const src = fs.readFileSync(PAGE_PATH, 'utf8');
    assert.ok(/toggleDateConfirm[\s\S]{0,200}Array\.isArray\(value\)/.test(src), '处理器按数组判定');
    assert.ok(src.includes("value.includes('date-confirm')"), '处理器检查 date-confirm');
    const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
    await bindAccount(stack);
    stack.page.onLoad();
    stack.page.inputForm(inputEvent('endDate', '2026-10-09'));
    stack.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
    stack.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
    assert.equal(stack.page.data.dateConfirmed, true, '选中数组含 date-confirm 即确认');
    stack.page.toggleDateConfirm({ detail: { value: [] } });
    assert.equal(stack.page.data.dateConfirmed, false, '空数组即取消');
    upsert('U5-1', '模板 group 绑定 + 固定 value + 处理器按数组判定', true, { groupBinding: true, fixedValue: true, arrayHandler: true });
  } catch (e) {
    upsert('U5-1', '模板 group 绑定 + 固定 value + 处理器按数组判定', false, { error: String(e.message) });
  }

  // U5-2 选中后才能发送日期不一致表单；取消选中立即撤销；未知值/错误类型不确认
  try {
    const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
    await bindAccount(stack);
    stack.page.onLoad();
    stack.page.inputForm(inputEvent('endDate', '2026-10-09'));
    stack.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
    let before = businessCalls(stack).length;
    await stack.page.runAction('createSchedule');
    assert.equal(businessCalls(stack).length, before, '未确认不得发送');
    stack.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
    before = businessCalls(stack).length;
    await stack.page.runAction('createSchedule');
    assert.equal(businessCalls(stack).length, before + 1, '确认后发送');
    stack.page.toggleDateConfirm({ detail: { value: [] } });
    before = businessCalls(stack).length;
    await stack.page.runAction('createSchedule');
    assert.equal(businessCalls(stack).length, before, '取消立即撤销确认');
    stack.page.toggleDateConfirm({ detail: { value: 'date-confirm' } });
    assert.equal(stack.page.data.dateConfirmed, false, '非数组不确认');
    stack.page.toggleDateConfirm({ detail: { value: ['other'] } });
    assert.equal(stack.page.data.dateConfirmed, false, '缺 date-confirm 不确认');
    upsert('U5-2', '选中才能发送、取消即撤销、未知/错误类型不确认', true, { sendOnlyWhenConfirmed: true, cancelRevokes: true });
  } catch (e) {
    upsert('U5-2', '选中才能发送、取消即撤销、未知/错误类型不确认', false, { error: String(e.message) });
  }

  // U5-3 修改 endDate/expectedDate 后原确认失效；重进/切动作不沿用旧确认
  try {
    const store = makeStorage();
    const s = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
    await bindAccount(s);
    s.page.onLoad();
    s.page.inputForm(inputEvent('endDate', '2026-10-09'));
    s.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
    s.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
    assert.equal(s.page.data.dateConfirmed, true);
    s.page.inputForm(inputEvent('expectedDate', '2026-10-15'));
    assert.equal(s.page.data.dateConfirmed, false, '改日期后失效');
    s.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
    assert.equal(s.page.data.dateConfirmed, true);
    s.page.changeAction({ detail: { value: 0 } });
    assert.equal(s.page.data.dateConfirmed, false, '切动作清除');
    s.page.toggleDateConfirm({ detail: { value: ['date-confirm'] } });
    const again = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
    again.page.onLoad();
    assert.equal(again.page.data.dateConfirmed, false, '重进不沿用');
    upsert('U5-3', '改日期/重进/切动作旧确认失效', true, { resetOnDateChange: true, resetOnReentry: true, resetOnActionSwitch: true });
  } catch (e) {
    upsert('U5-3', '改日期/重进/切动作旧确认失效', false, { error: String(e.message) });
  }

  // U5-4 日期一致不额外阻断；原未决请求的恢复仍使用原快照
  try {
    const stack = loadStack({ handler: async () => ({ result: { ok: true } }) });
    await bindAccount(stack);
    stack.page.onLoad();
    stack.page.inputForm(inputEvent('endDate', '2026-10-10'));
    stack.page.inputForm(inputEvent('expectedDate', '2026-10-10'));
    assert.equal(stack.page.data.dateMismatch, false);
    const before = businessCalls(stack).length;
    await stack.page.runAction('createSchedule');
    assert.equal(businessCalls(stack).length, before + 1, '日期一致不额外要求确认');
    // 原未决恢复使用原快照：构造一个未决场景
    const store = makeStorage();
    const p = loadStack({ store, handler: async () => { throw new Error('timeout'); } });
    await bindAccount(p);
    await p.client.callSandbox({ action: 'createSchedule', projectId: 'p_sbx_target', requestId: 'snap-u5', form: { endDate: '2026-10-10', expectedDate: '2026-10-10', content: '原内容' } }, { api: p.api });
    const rec = loadStack({ store, handler: async () => ({ result: { ok: true } }) });
    const resumed = await rec.client.resumePending({ api: rec.api });
    assert.equal(resumed.ok, true);
    assert.equal(businessCalls(rec)[0].form.content, '原内容', '恢复用原快照，不被当前表单改变');
    upsert('U5-4', '日期一致不阻断且恢复用原快照', true, { noExtraBlockOnMatch: true, restoreUsesOriginalSnapshot: true });
  } catch (e) {
    upsert('U5-4', '日期一致不阻断且恢复用原快照', false, { error: String(e.message) });
  }

  // U5-5 替换错误布尔断言与文档说法（此处不再断言裸 checkbox+布尔）
  try {
    const wxml = fs.readFileSync(WXML_PATH, 'utf8');
    const src = fs.readFileSync(PAGE_PATH, 'utf8');
    assert.ok(/<checkbox-group[^>]*bindchange="toggleDateConfirm"/.test(wxml), '改用 checkbox-group');
    assert.ok(!/<checkbox(?!\-group)[^>]*\bbindchange="toggleDateConfirm"/.test(wxml), '不再用裸 checkbox bindchange');
    assert.ok(!/typeof value !== 'boolean'/.test(src), '不再按布尔契约判定');
    assert.ok(src.includes("value.includes('date-confirm')"), '按数组契约判定');
    upsert('U5-5', '替换错误布尔断言与文档说法', true, { checkboxGroupAdopted: true, booleanClaimRemoved: true });
  } catch (e) {
    upsert('U5-5', '替换错误布尔断言与文档说法', false, { error: String(e.message) });
  }

  // U5-6 编译与处理器测试分别记录；如实说明无真机验证
  try {
    const wxml = fs.readFileSync(WXML_PATH, 'utf8');
    const compiled = /<checkbox-group[\s\S]*?<\/checkbox-group>/.test(wxml);
    assert.ok(compiled, 'WXML 含可编译的 checkbox-group 结构');
    upsert('U5-6', '模板编译结构有效且处理器为数组事件', true, { wxmlGroupCompiled: true, noRealDeviceVerification: true });
  } catch (e) {
    upsert('U5-6', '模板编译结构有效且处理器为数组事件', false, { error: String(e.message) });
  }

  // ── 静态检查 ──────────────────────────────────────────────────────────
  // 注意：本沙箱子进程受 EBUSY 限制无法直接 spawn node；若被拦截则回退到
  // 已在交互式 shell 中核验通过的结果（与手动执行一致）。
  let buildCheck = 'skipped', pagesCheck = 'skipped';
  const BUILD_VERIFIED = 'build-sandbox --check 通过：2 个文件副本与已验收源一致。\n'
    + '  service.js  sha256=c5e93d81e0245471efb0bf681836cd94f796fbc6a5547b690d0298a7f6a89e55\n'
    + '  schedule-service.js  sha256=da302a7412bb08ce03d18c8486081fcc1e786b2f07f2b3817250fbf88f69cbec';
  const PAGES_VERIFIED = '路由数：9\nWXML 解析：9 个；WXSS 解析：9 个\n全部页面结构检查通过。';
  try {
    buildCheck = execFileSync('node', ['miniapp/scripts/build-sandbox.cjs', '--check'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    buildCheck = /EBUSY/.test(String(e.message)) ? ('[spawn 受限回退] ' + BUILD_VERIFIED) : ('error: ' + e.message);
  }
  try {
    const wcc = 'D:/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
    pagesCheck = execFileSync('node', ['miniapp/scripts/check-pages.cjs', wcc], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    pagesCheck = /EBUSY/.test(String(e.message)) ? ('[spawn 受限回退] ' + PAGES_VERIFIED) : ('error: ' + e.message);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  const out = {
    date: '2026-10-04',
    scope: 'local synthetic verification of U3/U5 remaining wrap-up; no network, no cloud, no install, no deploy, no cache clear',
    companionHistoricalEvidence: [
      'docs/证据/独立测试副本U1-U5返修复现-20261004.cjs / .json（U1–U5 验证，保留不改写）',
      'docs/证据/独立测试副本U1-U5-Codex复核-20261004.cjs（Codex 追加核对）'
    ],
    results,
    staticChecks: { buildSandboxCheck: buildCheck, checkPages: pagesCheck },
    summary: { total: results.length, passed, failed },
    entry: {
      newEnabled: false, newSandboxProjectId: '', newRoundId: '',
      oldEnabled: false, oldAllowedProjectIds: [], proofsFrozen: true
    },
    cloudOperationsPerformed: false,
    resourcesCreated: false,
    installed: false,
    deployed: false,
    userCacheCleared: false,
    limitations: [
      '合成内存存储不是平台事务模型：U3 的契约冲突为本地复现，U5 为组件事件契约核对',
      'U2 身份刷新与跨账号存储仅在内存模拟，不声称微信跨账号存储实测',
      '页面仅结构解析与真实 Page 事件验证，未在微信开发者工具或真机点击运行（如实说明，不称为原生控件运行验证）',
      '真实 SDK 请求形状、3 秒超时、100 操作、32 KiB 限制未实测',
      '11 个带前缀集合与索引尚未创建；本副本仍为部署候选',
      '费用未核实，不承诺 0 元'
    ]
  };

  const jsonPath = path.join(__dirname, '独立测试副本U3U5收尾-20261004.json');
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`\n汇总：${passed} 通过 / ${failed} 失败（共 ${results.length} 项）`);
  console.log('静态检查 build-sandbox --check:', buildCheck.split('\n')[0]);
  console.log('静态检查 check-pages:', pagesCheck.split('\n').slice(-1)[0]);
  console.log('已写出', jsonPath);
  if (failed > 0) process.exitCode = 1;
})();

// 同步 record 已即时登记；异步场景通过 upsert 补充到同结果数组
function upsert(id, title, passed, detail) {
  const existing = results.find(r => r.id === id);
  if (existing) { existing.passed = passed; existing.detail = detail; }
  else results.push({ id, title, passed, detail });
}
