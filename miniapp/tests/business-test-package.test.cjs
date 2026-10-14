// 三账号独立业务测试包：P／E／X 候选生成工具与合成链验收。
//
// 依据：docs/WorkBuddy任务-三账号独立业务测试包本地准备-20261013.md §3–§4、
// docs/Codex方案-独立测试项目与管家师傅业务验证-20261013.md §4–§6。
//
// 边界：全部为本地合成验证——候选服务端代码（真实 index/gate/vendor 变换副本）
// 跑在合成数据库上，候选前端代码（真实 page/client/driver/coordinator）跑在
// 合成 wx 上；**不是真机、不是平台调用**。SDK 本地转换与平台行为另行标注。
// 每次运行使用唯一输出目录（artifacts 之下，已被忽略，不入库）。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const tool = require('../scripts/package-business-test.cjs');
const gateSource = require('../cloudfunctions/scheduleSandbox/gate');
const { createSandboxTestDb, PREFIX } = require('./helpers/sandbox-test-db.cjs');
const { APPID, ENV_ID } = require('./helpers/sandbox-entry-loader.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'artifacts', 'schedule-sandbox', 'business-test');
const RUN_ID = crypto.randomBytes(4).toString('hex');

// ── 合成计划 ────────────────────────────────────────────────────────────────
const SYN_ROUND = 'synthetic-round-biz-' + RUN_ID;
const SYN_PROJECT = 'p_sbx_' + crypto.createHash('sha256').update(SYN_ROUND).digest('hex').slice(0, 32);
const SYN_OPENID = t => 'openid-btp-' + RUN_ID + '-' + t;
const SYN_USER = t => 'u_' + crypto.createHash('sha256')
  .update(APPID + ':' + SYN_OPENID(t)).digest('hex').slice(0, 40);
const SYN_USERS = {
  owner: { userId: SYN_USER('owner'), source: 'synthetic 夹具（不代表真实人员）' },
  manager: { userId: SYN_USER('manager'), source: 'synthetic 夹具（不代表真实人员）' },
  worker: { userId: SYN_USER('worker'), source: 'synthetic 夹具（不代表真实人员）' }
};
const OWNER = SYN_USERS.owner.userId;
const MANAGER = SYN_USERS.manager.userId;
const WORKER = SYN_USERS.worker.userId;

function writePlan(windowId, overrides) {
  const plan = Object.assign({
    schema: 'business-test-plan/1',
    window: windowId,
    synthetic: true,
    businessRoundId: SYN_ROUND,
    windowNo: windowId + '-01',
    appId: APPID,
    envId: ENV_ID,
    users: {
      owner: { ...SYN_USERS.owner },
      manager: { ...SYN_USERS.manager },
      worker: { ...SYN_USERS.worker }
    },
    projectReadyMarker: 'ready-' + SYN_ROUND,
    windowStartsAt: '2030-01-01T00:00:00Z',
    windowExpiresAt: '2030-01-01T01:00:00Z'
  }, overrides || {});
  if (overrides && overrides.projectId !== undefined) plan.projectId = overrides.projectId;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-plan-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

function buildWindow(windowId, overrides, outName) {
  const planPath = writePlan(windowId, overrides);
  const out = path.join(OUT_ROOT, outName || (windowId.toLowerCase() + '-test-' + RUN_ID));
  return tool.build(windowId, planPath, out);
}

// ── 候选加载器（服务端 / 前端） ─────────────────────────────────────────────
/** 把候选服务端 index.js（含候选 gate.js / vendor）载入 vm，注入合成 db。 */
function loadCandidateServer(candidateDir, db, context = {}) {
  const serverDir = path.join(candidateDir, 'server');
  const nativeRequire = createRequire(path.join(serverDir, 'index.js'));
  const ctx = {
    APPID: context.appId === undefined ? APPID : context.appId,
    OPENID: context.openid
  };
  const shim = {
    init() {},
    DYNAMIC_CURRENT_ENV: 'candidate-test',
    getWXContext: () => ctx,
    database() { return db; }
  };
  const source = fs.readFileSync(path.join(serverDir, 'index.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInThisContext(
    `(function(require,module,exports,process,console){${source}\n})`,
    { filename: 'candidate-index.js' }
  )(name => (name === 'wx-server-sdk' ? shim : nativeRequire(name)),
    mod, mod.exports, { env: { TCB_ENV: ENV_ID } }, console);
  return mod.exports.main;
}

const openidByUser = Object.fromEntries(
  Object.entries(SYN_USERS).map(([, u]) => [u.userId, SYN_OPENID(u.userId.slice(-6))]));
// 反查：SYN_USERS 由 SYN_OPENID 派生，这里按 userId 找回 openid
for (const role of ['owner', 'manager', 'worker']) {
  openidByUser[SYN_USERS[role].userId] = SYN_OPENID(role);
}
const openidFor = userId => openidByUser[userId];
const as = (candidateDir, db, who) => loadCandidateServer(candidateDir, db, {
  openid: openidFor(SYN_USERS[who].userId)
});

/** 候选前端模块（config 已变换，直接按路径加载即可）。 */
function candidateFrontend(candidateDir, rel) {
  return createRequire(path.join(candidateDir, 'frontend', rel))(
    path.join(candidateDir, 'frontend', rel));
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

function scheduleOk(overrides) {
  return Object.assign({
    ok: true, sandbox: true,
    id: 's_x01', projectId: SYN_PROJECT,
    stage: '拆改', trade: '拆改', workerUserId: WORKER,
    startDate: '2030-01-02', endDate: '2030-01-03', expectedDate: '2030-01-03',
    restDays: [], content: '三账号合成验证', status: 'active', version: 1
  }, overrides || {});
}

const SCHEDULE_FORM = {
  stage: '拆改', trade: '拆改', workerUserId: WORKER,
  startDate: '2030-01-02', endDate: '2030-01-03', expectedDate: '2030-01-03',
  restDays: [], content: '三账号合成验证'
};

// ═══════════════════════════════════════════════════════════════════════════
// A：计划校验与工具行为
// ═══════════════════════════════════════════════════════════════════════════

test('A1 计划校验：real 缺来源 / E 缺 projectId / projectId 与 roundId 不绑定 / 受保护项目 / 窗口超限 / 重复账号 全部拒绝', () => {
  // real 缺来源
  assert.throws(
    () => tool.readPlan(writePlan('P', {
      synthetic: false,
      users: { owner: { userId: OWNER }, manager: { userId: MANAGER }, worker: { userId: WORKER } }
    }), 'P'),
    e => e.code === tool.ERR.PLAN_USER_INVALID);
  // E 缺 projectId
  assert.throws(() => tool.readPlan(writePlan('E'), 'E'),
    e => e.code === tool.ERR.PLAN_PROJECT_INVALID);
  // projectId 与 roundId 不绑定
  const other = 'p_sbx_' + crypto.createHash('sha256').update('other-round').digest('hex').slice(0, 32);
  assert.throws(() => tool.readPlan(writePlan('E', { projectId: other }), 'E'),
    e => e.code === tool.ERR.PLAN_PROJECT_INVALID);
  // 受保护项目
  assert.throws(() => tool.readPlan(writePlan('E', {
    projectId: gateSource.PROTECTED_PROJECT_IDS[0]
  }), 'E'), e => e.code === tool.ERR.PLAN_PROJECT_INVALID);
  // P 预填 projectId
  assert.throws(() => tool.readPlan(writePlan('P', { projectId: SYN_PROJECT }), 'P'),
    e => e.code === tool.ERR.PLAN_PROJECT_INVALID);
  // 窗口超 2 小时
  assert.throws(() => tool.readPlan(writePlan('P', {
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T03:00:00Z'
  }), 'P'), e => e.code === tool.ERR.PLAN_WINDOW_INVALID);
  // 重复账号
  assert.throws(() => tool.readPlan(writePlan('P', {
    users: { owner: SYN_USERS.owner, manager: SYN_USERS.owner, worker: SYN_USERS.worker }
  }), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID);
  // 占位 marker
  assert.throws(() => tool.readPlan(writePlan('P', { projectReadyMarker: '<待填>' }), 'P'),
    e => e.code === tool.ERR.PLAN_INVALID);
  // userId 格式非法
  assert.throws(() => tool.readPlan(writePlan('P', {
    users: { owner: { userId: 'u_short' }, manager: SYN_USERS.manager, worker: SYN_USERS.worker }
  }), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID);
});

test('A2 工具行为：synthetic 三窗口构建成功；reuse 语义；篡改后 check 失败；续建补齐', () => {
  const suffix = 'a2-' + RUN_ID;
  const p = buildWindow('P', null, 'p-' + suffix);
  assert.equal(p.manifest.window, 'P');
  assert.deepEqual(p.manifest.actions, tool.P_ACTIONS);
  assert.equal(p.manifest.synthetic, true);
  assert.equal(p.manifest.files.length, 19);
  assert.equal(p.manifest.closePackage.files.length, 19);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'e-' + suffix);
  assert.deepEqual(e.manifest.actions, tool.E_ACTIONS);
  const x = buildWindow('X', { projectId: SYN_PROJECT }, 'x-' + suffix);
  assert.deepEqual(x.manifest.actions, tool.X_ACTIONS);
  // reuse：同计划重建 → 全部 reused
  const again = buildWindow('P', null, 'p-' + suffix);
  assert.equal(again.io.every(f => f.action === 'reused'), true, '相同内容应全部复用');
  // 篡改 → check 失败
  const target = path.join(p.outDir, 'server', 'gate.js');
  fs.writeFileSync(target, fs.readFileSync(target).toString('utf8') + '\n// tampered\n');
  const broken = tool.checkDir(p.outDir);
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some(s => s.includes('gate.js')));
  // 续建：删除文件后重建 → 补齐且 check 通过
  fs.rmSync(p.outDir, { recursive: true, force: true });
  const rebuilt = buildWindow('P', null, 'p-' + suffix);
  const verified = tool.checkDir(rebuilt.outDir);
  assert.equal(verified.ok, true, verified.problems.join('; '));
  // roundId↔projectId 绑定在 E/X manifest 中一致
  assert.equal(e.manifest.projectId, SYN_PROJECT);
  assert.equal(x.manifest.projectId, SYN_PROJECT);
});

// ═══════════════════════════════════════════════════════════════════════════
// B：候选服务端合成链（真实候选 index/gate/vendor × 合成 db）
// ═══════════════════════════════════════════════════════════════════════════

function seedUsers() {
  const users = {};
  for (const u of [OWNER, MANAGER, WORKER]) {
    users[u] = { _id: u, status: 'active', openid: openidFor(u) };
  }
  const admins = { primary: { _id: 'primary', status: 'active', userId: OWNER } };
  return createSandboxTestDb({
    [PREFIX + 'users']: users,
    [PREFIX + 'app_admins']: admins
  });
}
const countOf = (db, name) =>
  Object.keys(db.getPrefixedData()[PREFIX + name] || {}).length;

test('B1 P 候选服务端链：成员准备全链走通；removeMember 与施工写被收窄拒绝且零写', async () => {
  const p = buildWindow('P', null, 'p-chain-' + RUN_ID);
  const db = seedUsers();
  const call = as(p.outDir, db, 'owner');
  const mCall = as(p.outDir, db, 'manager');
  const wCall = as(p.outDir, db, 'worker');

  const id = await call({ action: 'identify', requestId: 'p-id-1' });
  assert.equal(id.ok, true);
  const created = await call({
    action: 'createProject', requestId: 'p-create-1', name: '虚构测试 · 三账号'
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.projectId, SYN_PROJECT, 'projectId 必须与 roundId 确定性绑定一致');
  const number = await mCall({ action: 'requestBindingNumber' });
  assert.equal(number.ok, true);
  const assigned = await call({
    action: 'assignManager', projectId: SYN_PROJECT, bindingNumber: number.bindingNumber
  });
  assert.equal(assigned.ok, true);
  const inv = await mCall({
    action: 'createInvitation', projectId: SYN_PROJECT, role: '师傅', trades: ['拆改']
  });
  assert.equal(inv.ok, true);
  const wNum = await wCall({ action: 'requestBindingNumber' });
  const applied = await wCall({ action: 'applyInvitation', invitationCode: inv.invitationCode });
  assert.equal(applied.ok, true);
  const approved = await mCall({
    action: 'approveInvitation', projectId: SYN_PROJECT,
    invitationId: inv.invitationId, applicantNumber: wNum.bindingNumber
  });
  assert.equal(approved.ok, true);
  const members = await mCall({ action: 'getMembers', projectId: SYN_PROJECT });
  assert.equal(members.ok, true);
  assert.ok(members.members.length >= 3);

  // 收窄：P 禁止 removeMember 与施工写（started 前拒绝、零写）
  const before = countOf(db, 'project_members');
  const rm = await call({
    action: 'removeMember', projectId: SYN_PROJECT, userId: WORKER
  });
  assert.equal(rm.ok, false);
  assert.equal(rm.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE');
  const cs = await mCall({
    action: 'createSchedule', projectId: SYN_PROJECT, requestId: 'p-sch-1', form: SCHEDULE_FORM
  });
  assert.equal(cs.ok, false);
  assert.equal(cs.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE');
  assert.equal(countOf(db, 'project_members'), before, '拒绝必须零写');
  assert.equal(countOf(db, 'schedules'), 0, 'P 零安排写入');
});

test('B2 E 候选服务端链：合法安排/调整/取消走通；管理动作被收窄拒绝且零写', async () => {
  // 先用 P 候选建立成员状态，再切 E 候选（同一 db，roundId 一致）
  const p = buildWindow('P', null, 'p-echain-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'e-chain-' + RUN_ID);
  const db = seedUsers();
  const pCall = as(p.outDir, db, 'owner');
  const pMgr = as(p.outDir, db, 'manager');
  const pWorker = as(p.outDir, db, 'worker');
  const idr = await pCall({ action: 'identify', requestId: 'e-id-1' });
  console.error('B2DBG identify', JSON.stringify(idr).slice(0,120));
  const created = await pCall({ action: 'createProject', requestId: 'e-create-1', name: '虚构测试 · 三账号' });
  console.error('B2DBG create', JSON.stringify(created).slice(0,160));
  const projectId = created.projectId;
  const number = await pMgr({ action: 'requestBindingNumber' });
  console.error('B2DBG number', JSON.stringify(number).slice(0,120));
  const amr = await pCall({ action: 'assignManager', projectId, bindingNumber: number.bindingNumber });
  console.error('B2DBG assign', JSON.stringify(amr).slice(0,120));
  const inv = await pMgr({ action: 'createInvitation', projectId, role: '师傅', trades: ['拆改'] });
  console.error('B2DBG inv', JSON.stringify(inv).slice(0,120));
  const wNum = await pWorker({ action: 'requestBindingNumber' });
  console.error('B2DBG wNum', JSON.stringify(wNum).slice(0,120));
  const apr = await pWorker({ action: 'applyInvitation', invitationCode: inv.invitationCode });
  console.error('B2DBG apply', JSON.stringify(apr).slice(0,120));
  const apv = await pMgr({
    action: 'approveInvitation', projectId, invitationId: inv.invitationId,
    applicantNumber: wNum.bindingNumber
  });
  console.error('B2DBG approve', JSON.stringify(apv).slice(0,160));

  const call = as(e.outDir, db, 'manager');
  const wCall = as(e.outDir, db, 'worker');
  const oCall = as(e.outDir, db, 'owner');
  // E1 合法新增（管家）
  const s1 = await call({
    action: 'createSchedule', projectId, requestId: 'e-sch-1',
    form: SCHEDULE_FORM, expectedConfirmed: true
  });
  console.error('B2DBG s1', JSON.stringify(s1).slice(0,200));
  assert.equal(s1.ok, true, JSON.stringify(s1));
  // E2 调整（版本 +1，填原因）
  const s2 = await call({
    action: 'updateSchedule', projectId, requestId: 'e-sch-2',
    scheduleId: s1.scheduleId, expectedVersion: s1.version,
    reason: '三账号合成调整', form: { ...SCHEDULE_FORM, content: '调整后内容' }
  });
  console.error('B2DBG s2', JSON.stringify(s2).slice(0,200));
  assert.equal(s2.ok, true, JSON.stringify(s2));
  // E4 收窄：师傅 / 仅负责人尝试受限写入 → 拒绝且零写
  const schedulesBefore = countOf(db, 'schedules');
  const workerWrite = await wCall({
    action: 'createSchedule', projectId, requestId: 'e-sch-w1', form: SCHEDULE_FORM
  });
  assert.equal(workerWrite.ok, false, '师傅不得写安排');
  const ownerWrite = await oCall({
    action: 'createSchedule', projectId, requestId: 'e-sch-o1', form: SCHEDULE_FORM
  });
  assert.equal(ownerWrite.ok, false, '仅负责人不得写安排');
  assert.equal(countOf(db, 'schedules'), schedulesBefore, '拒绝零写');
  // E 收窄：管理动作一律拒绝（含零写）
  for (const [who, action, extra] of [
    ['owner', 'assignManager', { bindingNumber: '1' }],
    ['manager', 'createInvitation', { role: '师傅', trades: ['拆改'] }],
    ['worker', 'applyInvitation', { invitationCode: 'X' }],
    ['manager', 'removeMember', { userId: WORKER }],
    ['manager', 'reassignSchedule', { scheduleId: s1.scheduleId, userId: MANAGER }],
    ['manager', 'requestBindingNumber', {}]
  ]) {
    const whoCall = as(e.outDir, db, who);
    const denied = await whoCall({ action, projectId, ...extra });
    assert.equal(denied.ok, false, action + ' 应被 E 收窄拒绝');
    assert.equal(denied.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE', action);
  }
  assert.equal(countOf(db, 'schedules'), schedulesBefore, '收窄拒绝全程零写');
  // E6 取消（填原因）
  const canceled = await call({
    action: 'cancelSchedule', projectId, requestId: 'e-sch-3',
    scheduleId: s1.scheduleId, expectedVersion: s2.version, reason: '三账号合成取消'
  });
  assert.equal(canceled.ok, true, JSON.stringify(canceled));
});

test('B3 X 候选服务端链：有任务移出拒绝→清空后移出成功→退出后访问受限；写动作被收窄拒绝', async () => {
  const p = buildWindow('P', null, 'p-xchain-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'e-xchain-' + RUN_ID);
  const x = buildWindow('X', { projectId: SYN_PROJECT }, 'x-chain-' + RUN_ID);
  const db = seedUsers();
  const pCall = as(p.outDir, db, 'owner');
  const pMgr = as(p.outDir, db, 'manager');
  const pWorker = as(p.outDir, db, 'worker');
  await pCall({ action: 'identify', requestId: 'x-id-1' });
  const created = await pCall({ action: 'createProject', requestId: 'x-create-1', name: '虚构测试 · 三账号' });
  const projectId = created.projectId;
  const number = await pMgr({ action: 'requestBindingNumber' });
  await pCall({ action: 'assignManager', projectId, bindingNumber: number.bindingNumber });
  const inv = await pMgr({ action: 'createInvitation', projectId, role: '师傅', trades: ['拆改'] });
  const wNum = await pWorker({ action: 'requestBindingNumber' });
  await pWorker({ action: 'applyInvitation', invitationCode: inv.invitationCode });
  await pMgr({
    action: 'approveInvitation', projectId, invitationId: inv.invitationId,
    applicantNumber: wNum.bindingNumber
  });

  const xMgr = as(x.outDir, db, 'manager');
  const xWorker = as(x.outDir, db, 'worker');
  // V07-A 前置：一条有效安排（经 E 候选创建——E 窗口动作在 X 前完成）
  const eMgr = as(e.outDir, db, 'manager');
  const s1 = await eMgr({
    action: 'createSchedule', projectId, requestId: 'x-sch-1',
    form: SCHEDULE_FORM, expectedConfirmed: true
  });
  assert.equal(s1.ok, true, JSON.stringify(s1));
  // V07-A：有未完成安排 → 明确拒绝
  const blocked = await xMgr({ action: 'removeMember', projectId, userId: WORKER });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'WORKER_HAS_ACTIVE_SCHEDULES');
  const membersBefore = countOf(db, 'project_members');
  // V07-B 前置：管家按原因取消师傅全部有效安排
  const canceled = await xMgr({
    action: 'cancelSchedule', projectId, requestId: 'x-cancel-1',
    scheduleId: s1.scheduleId, expectedVersion: s1.version, reason: 'X 窗口移出前清空任务'
  });
  assert.equal(canceled.ok, true, JSON.stringify(canceled));
  // V07-B：单次移出成功
  const removed = await xMgr({ action: 'removeMember', projectId, userId: WORKER });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.status, 'left', '成员状态应为 left');
  assert.equal(countOf(db, 'project_members'), membersBefore, '记录保留（不删除）');
  // 退出后：师傅的项目列表被过滤（成员权限生效，非允许名单删除）
  const workerProjects = await xWorker({ action: 'listMyProjects' });
  assert.equal(workerProjects.ok, true);
  assert.equal((workerProjects.projects || []).length, 0, '退出后师傅读不到本项目');
  // X 收窄：安排写与改派拒绝且零写
  const schedulesBefore = countOf(db, 'schedules');
  for (const action of ['createSchedule', 'updateSchedule', 'reassignSchedule']) {
    const denied = await xMgr({
      action, projectId, requestId: 'x-deny-' + action,
      scheduleId: s1.scheduleId, form: SCHEDULE_FORM, userId: WORKER
    });
    assert.equal(denied.ok, false, action + ' 应被 X 收窄拒绝');
    assert.equal(denied.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE', action);
  }
  assert.equal(countOf(db, 'schedules'), schedulesBefore, 'X 收窄拒绝零写');
  // 管家仍可读历史
  const history = await xMgr({
    action: 'listScheduleRevisions', projectId, scheduleId: s1.scheduleId
  });
  assert.equal(history.ok, true, '管家仍可查安排历史');
});

// ═══════════════════════════════════════════════════════════════════════════
// C：候选前端合成链（真实 page/client/driver/coordinator × 合成 wx）
// ═══════════════════════════════════════════════════════════════════════════

function makeWx(handler, options = {}) {
  const store = makeStorage(options.storage);
  const calls = [];
  const api = {
    ...store,
    storage: store,
    getAccountInfoSync: () => ({
      miniProgram: { appId: options.appId || APPID, envVersion: options.envVersion || 'develop' }
    }),
    cloud: {
      async callFunction(args) {
        calls.push(JSON.parse(JSON.stringify(args.data)));
        if (args.data && args.data.action === 'identify') {
          return { result: { ok: true, sandbox: true, userId: options.identifyUserId || MANAGER } };
        }
        return handler(args.data, calls.length);
      }
    }
  };
  return { api, calls };
}

function loadCandidatePage(candidateDir, wxApi) {
  const pagePath = path.join(candidateDir, 'frontend', 'pages/schedule-sandbox/schedule-sandbox.js');
  const pageRequire = createRequire(pagePath);
  let definition;
  vm.runInThisContext(
    `(function(require,Page,wx){${fs.readFileSync(pagePath, 'utf8')}\n})`
  )(name => pageRequire(name), value => { definition = value; }, wxApi);
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data || {})),
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
  return page;
}

test('C1 P/E 候选前端：普通链可达、专用驱动关闭（零发送）；Page 级入口与测试卡一致', async () => {
  const p = buildWindow('P', null, 'p-fe-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'e-fe-' + RUN_ID);
  for (const [label, cand] of [['P', p], ['E', e]]) {
    const client = candidateFrontend(cand.outDir, 'utils/schedule-sandbox-client.js');
    const { api, calls } = makeWx(async () => ({
      result: { ok: true, sandbox: true, userId: MANAGER }
    }));
    const identified = await client.callSandbox(
      { action: 'identify', requestId: 'fe-id-1' }, { api });
    assert.equal(identified.ok, true, label + '：普通 client 链可达');
    assert.equal(calls.length, 1, label + '：普通请求已发出');
    // 专用驱动关闭：零发送
    const driver = candidateFrontend(cand.outDir, 'utils/sandbox-test-driver.js');
    const drvResult = await driver.runCase({
      api, testCaseId: 'V07-A', input: { projectId: SYN_PROJECT, userId: WORKER }
    });
    assert.equal(drvResult.ok, false, label + '：驱动应被门控拦截');
    assert.equal(drvResult.code, 'TEST_DRIVER_GATE_BLOCKED');
    assert.equal(drvResult.report.sent, 0, label + '：驱动关闭必须零发送');
    // Page 级：入口允许 + 测试卡隐藏（P/E 驱动关闭）
    const page = loadCandidatePage(cand.outDir, api);
    page.onLoad();
    assert.equal(page.data.entryAllowed, true, label + '：普通入口可达');
    assert.equal(page.data.testCardVisible, false, label + '：专用测试卡隐藏');
  }
});

test('C2 X 候选前端：V06 零发送、V07-A 可达且 candidate 后同轮阻断 V07-B（接续门槛）、V07-B 独立轮次可达；Page 级测试卡可见', async () => {
  const x = buildWindow('X', { projectId: SYN_PROJECT }, 'x-fe-' + RUN_ID);
  const driver = candidateFrontend(x.outDir, 'utils/sandbox-test-driver.js');
  let removeCalls = 0;
  // 相位状态机：V07-A = 有未完成安排（明确拒绝）；V07-B = 任务清空（成功退出）
  let v07Phase = 'A';
  const { api, calls } = makeWx(async data => {
    if (data.action === 'getMembers') {
      return { result: { ok: true, members: [
        { id: 'm_a', userId: MANAGER, roles: ['管家'], trades: ['拆改'] },
        { id: 'm_b', userId: WORKER, roles: ['师傅'], trades: ['拆改'] }
      ] } };
    }
    if (data.action === 'listSchedules') {
      const schedules = v07Phase === 'A' ? [scheduleOk()] : [];
      return { result: { ok: true, schedules, pagination: { limit: 100, hasMore: false, nextCursor: null } } };
    }
    if (data.action === 'removeMember') {
      removeCalls++;
      if (v07Phase === 'A') {
        return { result: { ok: false, code: 'WORKER_HAS_ACTIVE_SCHEDULES' } };
      }
      return { result: { ok: true, userId: WORKER, status: 'left' } };
    }
    return { result: { ok: false, code: 'UNKNOWN_CODE' } };
  });
  // V06 附带开放被拒绝：用例不在候选配置内 → 零发送
  const v06 = await driver.runCase({ api, testCaseId: 'V06-a', input: { projectId: SYN_PROJECT, userId: MANAGER } });
  assert.equal(v06.ok, false);
  assert.equal(v06.code, 'TEST_DRIVER_UNKNOWN_CASE');
  assert.equal(v06.report.sent, 0, 'V06 必须零发送');
  // V07-A：有任务移出 → 预期拒绝（actor=管家、目标=师傅 来自候选配置）
  const v07a = await driver.runCase({
    api, testCaseId: 'V07-A', input: { projectId: SYN_PROJECT, userId: WORKER }
  });
  assert.equal(v07a.report.sent >= 1, true, 'V07-A 应实际发送（合成传输）');
  const removeReq = calls.find(c => c.action === 'removeMember');
  assert.ok(removeReq, 'removeMember 请求已发出');
  assert.equal(removeReq.userId, WORKER, '移出目标必须是候选绑定的本轮师傅');
  assert.equal(v07a.report.verdict, 'candidate', '预期拒绝属于可核对候选结果');
  // 同轮接续门槛：A candidate 未人工云端核对前，同候选 B 必须零发送阻断
  v07Phase = 'B';
  const blocked = await driver.runCase({
    api, testCaseId: 'V07-B', input: { projectId: SYN_PROJECT, userId: WORKER }
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'TEST_DRIVER_PREFLIGHT_BLOCKED');
  assert.equal(blocked.report.sent, 0, '接续门槛：V07-B 同轮零发送');
  assert.ok(/未完成用例/.test(blocked.message || blocked.reasons && blocked.reasons.join('') || ''),
    '阻断原因指向未完成用例');
  // V07-B 独立轮次候选（A 的未决不跨轮阻断）→ 成功退出
  const round2 = 'synthetic-round-b2-' + RUN_ID.slice(-12);
  const x2 = buildWindow('X', {
    projectId: 'p_sbx_' + crypto.createHash('sha256').update(round2).digest('hex').slice(0, 32),
    businessRoundId: round2
  }, 'x2-b-' + RUN_ID);
  assert.notEqual(x2.outDir, x.outDir);
  const driver2 = candidateFrontend(x2.outDir, 'utils/sandbox-test-driver.js');
  const project2 = 'p_sbx_' + crypto.createHash('sha256').update(round2).digest('hex').slice(0, 32);
  const v07b = await driver2.runCase({
    api, testCaseId: 'V07-B', input: { projectId: project2, userId: WORKER }
  });
  assert.equal(v07b.report.verdict, 'candidate', JSON.stringify(v07b.report).slice(0, 300));
  assert.equal(removeCalls >= 2, true, 'V07-B 已发送移出');
  assert.equal(v07b.report.responses[0].result.status, 'left');
  // Page 级（独立轮次候选2）：入口与测试卡可见；V06 按钮点击 → 零发送 stopped
  const page = loadCandidatePage(x2.outDir, api);
  page.onLoad();
  assert.equal(page.data.entryAllowed, true);
  assert.equal(page.data.testCardVisible, true, 'X 窗口专用测试卡可见');
  const callsBefore = calls.length;
  await page.runTestCase({ currentTarget: { dataset: { case: 'V06-a' } } });
  assert.equal(page.data.testReport.verdict, 'stopped');
  assert.equal(page.data.testReport.stoppedReason, 'TEST_DRIVER_UNKNOWN_CASE');
  assert.equal(calls.length, callsBefore, 'V06 页面点击零发送');
});