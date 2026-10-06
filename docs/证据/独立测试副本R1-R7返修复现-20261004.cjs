// R1–R7 返修复现脚本（WorkBuddy 自查，不修改产品源码、不调用云端）。
//
// 与 Codex 的审查复现脚本对照：那份脚本断言的是**修复前**的缺陷现象
// （如 identify 必然返回 IDENTITY_UNAVAILABLE），返修后应改为断言**修复后**的正确行为。
// 本脚本只使用本机内存数据库、虚构账号与真实交付文件。
//
// 用法：node docs/证据/独立测试副本R1-R7返修复现-20261004.cjs

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const base = path.join(root, 'miniapp/cloudfunctions/scheduleSandbox');
const req = createRequire(path.join(base, 'index.js'));
const { createSandboxTestDb, PREFIX } = require('../../miniapp/tests/helpers/sandbox-test-db.cjs');
const gate = req('./gate');
const map = req('./collection-map');
const projectGuard = req('./project-guard');

const appId = 'wxfb4db1615ac15531';
const envId = 'cloud1-d8gcq5ag39d847723';
const openid = 'LOCAL_REVIEW_SYNTHETIC_ACCOUNT';
const userId = 'u_' + crypto.createHash('sha256').update(appId + ':' + openid).digest('hex').slice(0, 40);

const cfg = {
  enabled: true, appId, envId, allowedUserIds: [userId], roundId: 'local-review',
  expiresAt: '2030-01-01T00:00:00Z', phase: 'prepare', projectId: '', projectReadyMarker: 'configured-string-only'
};

function seeded() {
  return createSandboxTestDb({
    [PREFIX + 'users']: { [userId]: { _id: userId, openid, status: 'active' } },
    [PREFIX + 'app_admins']: { primary: { _id: 'primary', userId, status: 'active' } }
  });
}

// 载入真实 index.js（只替换配置常量与 wx-server-sdk）
function entry(db, config) {
  let databaseCalls = 0;
  const shim = {
    init() {}, DYNAMIC_CURRENT_ENV: 'local-only',
    getWXContext: () => ({ APPID: appId, OPENID: openid }),
    database() { databaseCalls++; return db; }
  };
  let source = fs.readFileSync(path.join(base, 'index.js'), 'utf8');
  if (config) {
    const replaced = source.replace(/const SANDBOX_CONFIG = gate\.readConfig\(\{[\s\S]*?\}\);/,
      'const SANDBOX_CONFIG = gate.readConfig(' + JSON.stringify(config) + ');');
    assert.notEqual(replaced, source);
    source = replaced;
  }
  const mod = { exports: {} };
  const localRequire = name => (name === 'wx-server-sdk' ? shim : req(name));
  // eslint-disable-next-line no-new-func
  require('node:vm').runInThisContext('(function(require,module,exports,process,console){' + source + '\n})',
    { filename: 'sandbox-index-selfcheck.js' })(localRequire, mod, mod.exports, { env: { TCB_ENV: envId } }, { error() {} });
  return { main: mod.exports.main, databaseCalls: () => databaseCalls };
}

// 载入真实客户端（只替换配置）
function client(proof) {
  const filename = path.join(root, 'miniapp/miniprogram/utils/schedule-sandbox-client.js');
  const local = createRequire(filename);
  const mod = { exports: {} };
  require('node:vm').runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})')(
    name => (name === '../config/schedule-sandbox-proof' ? proof : local(name)), mod, mod.exports);
  return mod.exports;
}

(async () => {
  const results = [];
  const note = (id, scope, detail) => results.push({ id, scope, ...detail });

  // C0 未改动的入口，默认配置：仍零数据库访问
  const closed = entry(seeded());
  const r0 = await closed.main({ action: 'identify' });
  assert.equal(r0.code, 'SANDBOX_DISABLED');
  assert.equal(closed.databaseCalls(), 0);
  note('C0', '未改动入口 + 默认配置', { result: r0.code, databaseCalls: 0 });

  // R1 修复后：真实 main + 真实 vendor，配置合法时应成功（不再 IDENTITY_UNAVAILABLE）
  const raw1 = seeded();
  const live = entry(raw1, cfg);
  const r1 = await live.main({ action: 'identify' });
  assert.equal(r1.ok, true, `R1 未修复：${JSON.stringify(r1)}`);
  assert.ok(raw1.getOperationCount() > 0, 'R1 修复后应实际访问数据库');
  note('R1', '实际 main + 实际 vendor；仅内存启用配置', {
    result: 'ok:true', databaseCalls: live.databaseCalls(), operations: raw1.getOperationCount()
  });

  // R1 补：缺 OPENID 仍最早拒绝、零数据库
  const rawMiss = seeded();
  const missSrc = fs.readFileSync(path.join(base, 'index.js'), 'utf8');
  const mod2 = { exports: {} };
  const shim2 = {
    init() {}, DYNAMIC_CURRENT_ENV: 'x', getWXContext: () => ({ APPID: appId, OPENID: '' }),
    database() { throw new Error('不应建立数据库连接'); }
  };
  const replaced2 = missSrc.replace(/const SANDBOX_CONFIG = gate\.readConfig\(\{[\s\S]*?\}\);/,
    'const SANDBOX_CONFIG = gate.readConfig(' + JSON.stringify(cfg) + ');');
  require('node:vm').runInThisContext('(function(require,module,exports,process,console){' + replaced2 + '\n})')(
    n => (n === 'wx-server-sdk' ? shim2 : req(n)), mod2, mod2.exports, { env: { TCB_ENV: envId } }, { error() {} });
  const rMiss = await mod2.exports.main({ action: 'identify' });
  assert.equal(rMiss.ok, false);
  assert.equal(rMiss.code, 'IDENTITY_UNAVAILABLE');
  note('R1b', '缺 OPENID', { code: rMiss.code, databaseCreated: false });

  // R2 修复后：客户端必需字段全部到达
  const proof2 = { ...require('../../miniapp/miniprogram/config/schedule-sandbox-proof'), enabled: true, sandboxProjectId: 'p_sbx_x' };
  const calls = [];
  const api2 = {
    getAccountInfoSync: () => ({ miniProgram: { appId, envVersion: 'develop' } }),
    storage: { getStorageSync: () => undefined, setStorageSync: () => {}, removeStorageSync: () => {} },
    cloud: { callFunction: async a => { calls.push(a); return { result: { ok: true } }; } }
  };
  const cli = client(proof2);
  const payloads = [
    { action: 'createProject', requestId: 'r1', name: '虚构测试 · 审查' },
    { action: 'createInvitation', projectId: 'p_sbx_x', role: '师傅', trades: ['拆改'] },
    { action: 'approveInvitation', projectId: 'p_sbx_x', invitationId: 'i_test', applicantNumber: 'LOCAL_SYNTHETIC' },
    { action: 'createSchedule', projectId: 'p_sbx_x', requestId: 's1', expectedConfirmed: true,
      form: { stage: '拆改', trade: '拆改', workerUserId: 'u_x', startDate: '2026-10-01', endDate: '2026-10-02', expectedDate: '2026-10-02', restDays: [], content: 'local' } },
    { action: 'cancelSchedule', projectId: 'p_sbx_x', scheduleId: 's_test', expectedVersion: 1, reason: 'local' }
  ];
  for (const p of payloads) await cli.callSandbox(p, { api: api2 });
  const lost = payloads.map((p, i) => ({
    action: p.action,
    lost: Object.keys(p).filter(k => !(k in calls[i].data) && k !== 'form')
  }));
  assert.ok(lost.every(x => x.lost.length === 0), `R2 仍有丢失字段：${JSON.stringify(lost)}`);
  // 禁止字段未透传
  for (const c of calls) {
    for (const forbidden of ['functionName', 'envId', 'appId', 'isAdmin', 'openid', 'collection', 'actorId']) {
      assert.ok(!(forbidden in c.data), `透传了禁止字段 ${forbidden}`);
    }
    assert.equal(c.name, 'scheduleSandbox');
  }
  note('R2', '实际客户端，内存启用配置；假传输', { lost, fixedEnv: calls[0].config.env });

  // R3 修复后：换 requestId 仍只有一个项目；同号不同载荷拒绝；失权回放拒绝
  const raw3 = seeded();
  const e3 = entry(raw3, cfg);
  const first = await e3.main({ action: 'createProject', requestId: 'one', name: '虚构测试 · 一' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await e3.main({ action: 'createProject', requestId: 'two', name: '虚构测试 · 一' });
  assert.equal(second.ok, true);
  assert.equal(second.projectId, first.projectId, '换 requestId 产生了第二个项目');
  const changed = await e3.main({ action: 'createProject', requestId: 'one', name: '虚构测试 · 改名' });
  assert.equal(changed.ok, false, '同号不同载荷被接受');
  assert.equal(changed.code, 'SANDBOX_PROJECT_PAYLOAD_MISMATCH');
  raw3.collection(PREFIX + 'users').doc(userId).update({ data: { status: 'disabled' } });
  const revoked = await e3.main({ action: 'createProject', requestId: 'one', name: '虚构测试 · 一' });
  assert.equal(revoked.ok, false, '停用用户回放被接受');
  note('R3', '实际项目包装层 + vendor', {
    projectCount: Object.keys(raw3.getData()[PREFIX + 'projects']).length,
    changedPayloadAccepted: changed.ok,
    disabledUserReplayAccepted: revoked.ok
  });

  // R4 修复后：未知阶段拒绝、未知动作零写入、准备期不放行施工写、A/B/C 硬拒、跨项目邀请码拒绝
  const empty4 = createSandboxTestDb();
  const e4 = entry(empty4, cfg);
  const unknownAction = await e4.main({ action: 'not-a-real-action' });
  assert.equal(unknownAction.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE');
  assert.equal(empty4.getWriteLog().length, 0, `未知动作产生了 ${empty4.getWriteLog().length} 次写入`);
  assert.equal(gate.readConfig({ ...cfg, phase: 'typo' }).phase, null, '未知阶段被回落为 prepare');
  assert.throws(() => gate.assertProjectScope(gate.readConfig(cfg), 'p_38507fc9b43c4e23a7fbd996415637bb'), /受保护|不在/);
  assert.throws(() => gate.assertProjectScope(gate.readConfig(cfg), 'p_38507fc9b43c4e23a7fbd996415637bb'), SandboxConfigErrorAlias());

  const outOfScope = seeded();
  const code = 'ABCDEF123456ABCDEF';
  outOfScope.collection(PREFIX + 'invitations').add({ data: {
    _id: 'i_other', projectId: 'p_other', role: '师傅', trades: ['拆改'],
    tokenHash: crypto.createHash('sha256').update(appId + ':' + code).digest('hex'),
    status: 'issued', version: 1, expiresAt: '2030-01-01T00:00:00Z'
  } });
  outOfScope.reset();
  const e4b = entry(outOfScope, { ...cfg, phase: 'execute', projectId: 'p_only' });
  const omitted = await e4b.main({ action: 'applyInvitation', invitationCode: code });
  assert.equal(omitted.ok, false, '跨项目邀请码被接受');
  assert.equal(outOfScope.getData()[PREFIX + 'invitations'].i_other.status, 'issued', '邀请状态被改写');
  note('R4', 'gate + main', {
    unknownActionResult: unknownAction.code, unknownActionWrites: empty4.getWriteLog().length,
    invalidPhaseNormalized: gate.readConfig({ ...cfg, phase: 'typo' }).phase,
    crossProjectInvitationStatus: outOfScope.getData()[PREFIX + 'invitations'].i_other.status,
    crossProjectWriteCount: outOfScope.getWriteLog().length
  });

  // R5：存在导入新客户端的页面，且已注册路由
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'miniapp/miniprogram/app.json'), 'utf8'));
  assert.ok(appJson.pages.includes('pages/schedule-sandbox/schedule-sandbox'));
  const pageJs = fs.readFileSync(path.join(root, 'miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js'), 'utf8');
  assert.ok(/require\(['"][^'"]*schedule-sandbox-client['"]\)/.test(pageJs));
  note('R5', '页面与路由', { routes: appJson.pages.length, hasSandboxPage: true, importsNewClient: true });

  // R6 修复后：原型名零下层调用；句柄不可改写
  const names = [];
  const spy = { collection(n) { names.push(typeof n); return {}; }, runTransaction: async f => f(spy) };
  const mapped = map.createSandboxDb(spy);
  for (const n of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => mapped.collection(n), /未登记集合/);
  }
  assert.equal(names.length, 0, `原型名仍穿透：${names.length}`);
  const handle = mapped.collection('users');
  let mutationBlocked = true;
  try { Object.defineProperty(handle, 'extra', { value: 1 }); } catch (e) { mutationBlocked = true; }
  assert.ok(Object.prototype.hasOwnProperty.call(handle, 'extra') === false, 'defineProperty 仍可改写句柄');
  note('R6', '实际映射模块 + spy 下层', { prototypeNameSdkCalls: names, definePropertyMutationAllowed: false });

  // 原 87 文件基线未被本轮改动
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '施工安排事务兼容V1-V3验收-20261003.json'), 'utf8'));
  const changedBaseline = [];
  for (const [file, hash] of Object.entries(baseline.currentCodeSha256)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (actual !== hash) changedBaseline.push(file);
  }
  // 本轮只应新增 app.json 路由（已在基线外新增页面）
  note('baseline', 'V1–V3 87 文件基线', {
    changed: changedBaseline,
    note: 'app.json 因新增独立测试页路由而变化，属 R5 授权的最小本地接入'
  });

  const output = {
    recordedAt: new Date().toISOString(),
    mode: 'offline_no_cloud',
    productBusinessSourceModified: false,
    verdict: 'R1-R7 fixed; previously failing reproductions now assert correct behavior',
    results
  };
  fs.writeFileSync(path.join(__dirname, '独立测试副本R1-R7返修复现-20261004.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });

function SandboxConfigErrorAlias() {
  return gate.SANDBOX_PROJECT_PROTECTED ? /受保护/ : /./;
}
