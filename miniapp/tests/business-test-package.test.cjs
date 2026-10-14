// 三账号独立业务测试包：P／E／X 候选生成工具与合成链验收（R1–R6 返修版）。
//
// 依据：docs/WorkBuddy任务-三账号独立业务测试包本地准备-20261013.md §3–§4、
// docs/Codex方案-独立测试项目与管家师傅业务验证-20261013.md §4–§6、
// docs/Codex审查-三账号独立业务测试包本地准备-20261014.md R1–R6。
//
// 边界：全部为本地合成验证——候选服务端代码（真实 index/gate/vendor 变换副本）
// 跑在合成数据库上，候选前端代码（真实 App/Page/client/driver/coordinator）跑在
// 合成 wx 上，链路为 **App→Page→client→合成传输→候选服务端→合成 db**；
// **不是真机、不是平台调用**。SDK 本地转换未执行；平台行为另行标注。
// 每次运行使用唯一输出目录（artifacts 之下，已被忽略，不入库）。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const openidFor = userId => {
  for (const role of ['owner', 'manager', 'worker']) {
    if (SYN_USERS[role].userId === userId) return SYN_OPENID(role);
  }
  throw new Error('未知合成用户');
};

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
  const dir = path.join(OUT_ROOT, 'plans-' + RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'plan-' + windowId + '-' + crypto.randomBytes(4).toString('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

function buildWindow(windowId, overrides, outName) {
  const planPath = writePlan(windowId, overrides);
  const out = path.join(OUT_ROOT, outName || (windowId.toLowerCase() + '-test-' + RUN_ID));
  return tool.build(windowId, planPath, out);
}

// ── R5-a 来源记录夹具（结构性核对控制；内容为合成夹具，不代表真实人员/回执） ──
const RECORD_DIR = path.join(OUT_ROOT, 'records-' + RUN_ID);
function writeRecordFile(obj) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const f = path.join(RECORD_DIR, 'rec-' + crypto.randomBytes(6).toString('hex') + '.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  return {
    recordPath: f,
    recordSha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  };
}
function participantRecordFixture(role, userId, overrides = {}) {
  return writeRecordFile({
    schema: 'business-test-participant-record/1',
    synthetic: false,
    appId: APPID, envId: ENV_ID,
    businessRoundId: SYN_ROUND,
    subject: { role, userId },
    capturedAt: '2026-10-14T00:00:00Z',
    content: '登记/成员查询回执原文（合成夹具，仅验证本地核对路径，不代表真实人员）',
    ...overrides
  });
}
function projectReadbackRecordFixture(round, projectId, marker, overrides = {}) {
  return writeRecordFile({
    schema: 'business-test-project-readback-record/1',
    synthetic: false,
    appId: APPID, envId: ENV_ID,
    businessRoundId: round,
    projectId, projectReadyMarker: marker,
    subject: { role: 'owner', userId: SYN_USERS.owner.userId },
    capturedAt: '2026-10-14T00:00:00Z',
    content: 'P 项目回读原文（project-guard 业务项目记录；合成夹具）',
    persistentReceipt: { recordId: 'pgrecfixture01', note: '合成回执夹具' },
    ...overrides
  });
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

/** 全库快照（R6：零写断言覆盖全部集合，不只单一集合）。 */
const dbSnap = db => JSON.stringify(db.getPrefixedData());
const countOf = (db, name) =>
  Object.keys(db.getPrefixedData()[PREFIX + name] || {}).length;

// ── 完整链合成传输：wx.cloud.callFunction → 候选服务端 main ────────────────
function makeChainWx(candidateDir, db, who, options = {}) {
  const storage = options.storageShim || makeStorage(options.storage);
  const calls = [];
  const api = {
    ...storage,
    storage,
    getAccountInfoSync: () => ({
      miniProgram: { appId: APPID, envVersion: 'develop' }
    }),
    cloud: {
      init() {},
      async callFunction(args) {
        calls.push(JSON.parse(JSON.stringify(args.data)));
        if (options.throwAfter !== undefined && calls.length > options.throwAfter) {
          throw new Error('synthetic transport failure');
        }
        const main = loadCandidateServer(candidateDir, db, { openid: openidFor(SYN_USERS[who].userId) });
        const result = await main(args.data);
        return { result };
      }
    }
  };
  return { api, calls };
}

/** 加载候选 App（app.js 原样 + 合成 wx）。 */
function loadCandidateApp(candidateDir, wxApi) {
  const appPath = path.join(candidateDir, 'frontend', 'app.js');
  const appRequire = createRequire(appPath);
  let definition;
  vm.runInThisContext(
    `(function(require,App,wx){${fs.readFileSync(appPath, 'utf8')}\n})`
  )(name => appRequire(name), value => { definition = value; }, wxApi);
  const app = Object.create(definition);
  app.globalData = JSON.parse(JSON.stringify(definition.globalData || {}));
  app.onLaunch();
  return app;
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

/** P 候选服务端建立成员状态（供 E/X 链复用）。 */
async function seedMembers(pOutDir, db) {
  const pCall = as(pOutDir, db, 'owner');
  const pMgr = as(pOutDir, db, 'manager');
  const pWorker = as(pOutDir, db, 'worker');
  await pCall({ action: 'identify', requestId: 'seed-id-1' });
  const created = await pCall({ action: 'createProject', requestId: 'seed-create-1', name: '虚构测试 · 三账号' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const projectId = created.projectId;
  const number = await pMgr({ action: 'requestBindingNumber' });
  const assigned = await pCall({ action: 'assignManager', projectId, bindingNumber: number.bindingNumber });
  assert.equal(assigned.ok, true, JSON.stringify(assigned));
  const inv = await pMgr({ action: 'createInvitation', projectId, role: '师傅', trades: ['拆改'] });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  const wNum = await pWorker({ action: 'requestBindingNumber' });
  const applied = await pWorker({ action: 'applyInvitation', invitationCode: inv.invitationCode });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const approved = await pMgr({
    action: 'approveInvitation', projectId, invitationId: inv.invitationId,
    applicantNumber: wNum.bindingNumber
  });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  return { projectId };
}

// ═══════════════════════════════════════════════════════════════════════════
// A：计划校验与工具行为（R1/R5/R6 口径）
// ═══════════════════════════════════════════════════════════════════════════

test('A1 计划校验：real 缺回读证据 / E 缺 projectId / 绑定不符 / 受保护项目 / 窗口超限 / 未知字段 / 窗口号前缀不符 全部拒绝', () => {
  // real 缺回读证据（R5：非空来源声明不等于来源核实）
  assert.throws(
    () => tool.readPlan(writePlan('P', {
      synthetic: false,
      users: { owner: { userId: OWNER, source: '人工声明' }, manager: { userId: MANAGER, source: '人工声明' }, worker: { userId: WORKER, source: '人工声明' } }
    }), 'P'),
    e => e.code === tool.ERR.PLAN_USER_INVALID);
  // real 带齐回读证据 + 实际记录文件 → 接受（R5-a：kind+摘要+记录文件三方一致）
  const realOk = {
    synthetic: false,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(r =>
      [r, { userId: SYN_USERS[r].userId, source: '人工声明（完整身份待用户核实）' }])),
    participantEvidence: Object.fromEntries(['owner', 'manager', 'worker'].map(r => {
      const fx = participantRecordFixture(r, SYN_USERS[r].userId);
      return [r, { kind: 'readback-record', recordSha256: fx.recordSha256, recordPath: fx.recordPath }];
    }))
  };
  const parsed = tool.readPlan(writePlan('P', realOk), 'P');
  assert.equal(parsed.evidenceBound, true);
  assert.equal(parsed.users.every(u => u.evidence && u.evidence.kind === 'readback-record' && u.evidence.recordPath), true);
  // 证据结构非法（kind 冒充 / 摘要缺失）→ 拒绝
  assert.throws(() => tool.readPlan(writePlan('P', {
    ...realOk,
    participantEvidence: { owner: { kind: 'declaration-only', recordSha256: 'a'.repeat(64) }, manager: { kind: 'readback-record', recordSha256: 'b'.repeat(64) }, worker: { kind: 'readback-record', recordSha256: 'c'.repeat(64) } }
  }), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID);
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
  // 未知顶层字段（严格计划校验）
  assert.throws(() => tool.readPlan(writePlan('P', { autoExtend: true }), 'P'),
    e => e.code === tool.ERR.PLAN_INVALID);
  // windowNo 与窗口号不对应
  assert.throws(() => tool.readPlan(writePlan('E', { windowNo: 'P-09', projectId: SYN_PROJECT }), 'E'),
    e => e.code === tool.ERR.PLAN_INVALID);
  // 重复账号
  assert.throws(() => tool.readPlan(writePlan('P', {
    users: { owner: SYN_USERS.owner, manager: SYN_USERS.owner, worker: SYN_USERS.worker }
  }), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID);
  // 占位 marker
  assert.throws(() => tool.readPlan(writePlan('P', { projectReadyMarker: '<待填>' }), 'P'),
    e => e.code === tool.ERR.PLAN_INVALID);
  // userId 格式非法
  assert.throws(() => tool.readPlan(writePlan('P', {
    users: { owner: { userId: 'u_short', source: 'x' }, manager: SYN_USERS.manager, worker: SYN_USERS.worker }
  }), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID);
  // 来源说明计入稳定摘要（R5）：改变 source 文本 → planDigest 改变
  const d1 = tool.planDigest(tool.readPlan(writePlan('P'), 'P'));
  const d2 = tool.planDigest(tool.readPlan(writePlan('P', {
    users: {
      owner: { ...SYN_USERS.owner, source: '另一份来源声明' },
      manager: SYN_USERS.manager, worker: SYN_USERS.worker
    }
  }), 'P'));
  assert.notEqual(d1, d2, '来源声明变化必须影响 planDigest');
});

test('A2 工具行为：完整项目23制品；同计划整体复用；真实半成品续建补1；篡改后 check 失败；关闭包独立核对', () => {
  const suffix = 'a2-' + RUN_ID;
  const p = buildWindow('P', null, 'p-' + suffix);
  assert.equal(p.manifest.window, 'P');
  assert.deepEqual(p.manifest.actions, tool.P_ACTIONS);
  assert.equal(p.manifest.synthetic, true);
  // R4：完整项目 = 8 服务端 + 14 前端（含 app.js/app.json/config/cloud.js）+ 根 project.config.json，
      // 外加目录内计划 plan.json（其哈希由 manifest.planSha256 与重建双重核对）
  assert.equal(p.manifest.files.length, 24, JSON.stringify(p.manifest.files.map(f => f.rel)));
  assert.equal(p.manifest.closePackage.files.length, 23);
  assert.equal(p.manifest.files.some(f => f.rel === 'frontend/app.js'), true);
  assert.equal(p.manifest.files.some(f => f.rel === 'frontend/app.json'), true);
  assert.equal(p.manifest.files.some(f => f.rel === 'frontend/config/cloud.js'), true);
  assert.equal(p.manifest.files.some(f => f.rel === 'project.config.json'), true);
  assert.equal(p.manifest.files.some(f => f.rel === 'plan.json'), true);
  // app.json 已收窄为唯一页面入口；project.config 根指向候选 frontend/server
  const appJson = JSON.parse(fs.readFileSync(path.join(p.outDir, 'frontend/app.json'), 'utf8'));
  assert.deepEqual(appJson.pages, ['pages/schedule-sandbox/schedule-sandbox']);
  const projConf = JSON.parse(fs.readFileSync(path.join(p.outDir, 'project.config.json'), 'utf8'));
  assert.equal(projConf.miniprogramRoot, 'frontend/');
  assert.equal(projConf.cloudfunctionRoot, 'server/');
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'e-' + suffix);
  assert.deepEqual(e.manifest.actions, tool.E_ACTIONS);
  const x = buildWindow('X', { projectId: SYN_PROJECT }, 'x-' + suffix);
  assert.deepEqual(x.manifest.actions, tool.X_ACTIONS);
  // R1：正常候选整体 check 通过（重建比对）
  const verified = tool.checkDir(p.outDir);
  assert.equal(verified.ok, true, verified.problems.join('; '));
  assert.equal(verified.planChecked, true);
  // reuse：同计划重建 → 全部 reused（内容寻址，无时间戳）
  const again = buildWindow('P', null, 'p-' + suffix);
  assert.equal(again.io.every(f => f.action === 'reused'), true, '相同内容应全部复用');
  // R6：真实半成品续建——只删 1 个关闭文件后重建 → 恰补写 1 个，其余复用
  const victim = p.manifest.closePackage.files[0].rel;
  fs.unlinkSync(path.join(p.outDir, victim));
  const resumed = buildWindow('P', null, 'p-' + suffix);
  assert.equal(resumed.io.filter(f => f.action === 'written').length, 1, '半成品续建只补缺失文件');
  assert.equal(tool.checkDir(p.outDir).ok, true);
  // 篡改 → check 失败
  const target = path.join(p.outDir, 'server', 'gate.js');
  fs.writeFileSync(target, fs.readFileSync(target).toString('utf8') + '\n// tampered\n');
  const broken = tool.checkDir(p.outDir);
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some(s => s.includes('gate.js')));
  // roundId↔projectId 绑定在 E/X manifest 中一致
  assert.equal(e.manifest.projectId, SYN_PROJECT);
  assert.equal(x.manifest.projectId, SYN_PROJECT);
  // R1：关闭包独立核对入口（不读 manifest/计划，不受开启候选损坏影响）
  const closeOk = tool.checkCloseDir(p.outDir);
  assert.equal(closeOk.ok, true, closeOk.problems.join('; '));
  assert.equal(closeOk.files, 23);
});

test('A4 R1-a：manifest.files 的 plan.json 条目 bytes/sha256 纳入精确核对；篡改拒绝、合法对照通过', () => {
  const p = buildWindow('P', null, 'a4-planentry-' + RUN_ID);
  assert.equal(tool.checkDir(p.outDir).ok, true, '合法对照：check 通过');
  // 篡改清单 plan.json 条目（保留合法 plan.json/planSha256/planDigest）
  const mp = path.join(p.outDir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const row = m.files.find(f => f.rel === 'plan.json');
  row.sha256 = '0'.repeat(64);
  row.bytes = -1;
  fs.writeFileSync(mp, JSON.stringify(m));
  const r = tool.checkDir(p.outDir);
  assert.equal(r.ok, false, '顶层 planSha256 正确不代表整条清单正确');
  assert.ok(r.problems.some(s => s.includes('plan.json') && s.includes('实际计划不符')),
    '问题应指向 plan.json 清单条目：' + r.problems.join('; '));
});

test('A5 R2-a：check 逐文件读取边界与最终返回前重查时钟；中途到期/NaN/抛错均不成功', () => {
  const round = 'synthetic-clock-a5-' + RUN_ID.slice(-8);
  const p2 = 'p_sbx_' + crypto.createHash('sha256').update(round).digest('hex').slice(0, 32);
  // 窗口以运行当下为基准：开始=now-1h，到期=now+1h（真实模式需覆盖当下时钟）
  const startsIso = new Date(Date.now() - 3600e3).toISOString();
  const expiresIso = new Date(Date.now() + 3600e3).toISOString();
  const planOverrides = {
    synthetic: false,
    businessRoundId: round, projectId: p2,
    projectReadyMarker: 'ready-' + round,
    windowStartsAt: startsIso, windowExpiresAt: expiresIso,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(r =>
      [r, { userId: SYN_USERS[r].userId, source: '人工声明（完整身份待用户核实）' }])),
    participantEvidence: Object.fromEntries(['owner', 'manager', 'worker'].map(r => {
      const fx = participantRecordFixture(r, SYN_USERS[r].userId, { businessRoundId: round });
      return [r, { kind: 'readback-record', recordSha256: fx.recordSha256, recordPath: fx.recordPath }];
    })),
    projectReadback: (() => {
      const fx = projectReadbackRecordFixture(round, p2, 'ready-' + round, { businessRoundId: round });
      return { source: 'readback', projectId: p2, businessRoundId: round, projectReadyMarker: 'ready-' + round, recordSha256: fx.recordSha256, recordPath: fx.recordPath };
    })()
  };
  const b = buildWindow('E', planOverrides, 'a5-real-' + RUN_ID);
  const target = path.join(b.outDir, 'server', 'index.js');
  // 中途到期：读取候选 server/index.js 后把时钟推进到 expiresAt
  const realRead = fs.readFileSync;
  let now = Date.now(), calls = 0, triggered = false;
  fs.readFileSync = function (f, ...args) {
    const r = realRead.call(this, f, ...args);
    if (f === target) { now = Date.parse(expiresIso); triggered = true; }
    return r;
  };
  try {
    const clock = () => { calls++; return now; };
    const oldNow = Date.now; Date.now = clock;
    let checked;
    try { checked = tool.checkDir(b.outDir); } finally { Date.now = oldNow; }
    assert.equal(triggered, true, '到期推进事件已发生');
    assert.equal(calls > 1, true, 'check 必须多次重读当下时钟（实测 ' + calls + ' 次）');
    assert.equal(checked.ok, false, '中途到期不得带成功结论');
    assert.ok(checked.problems.some(s => s.includes('BTP_WINDOW_EXPIRED')), checked.problems.join('; '));
    // NaN 时钟中途出现 → 不成功（需在覆盖时钟下运行 check）
    const oldNowN = Date.now; Date.now = () => NaN;
    let nanChecked;
    try { nanChecked = tool.checkDir(b.outDir); } finally { Date.now = oldNowN; }
    assert.equal(nanChecked.ok, false, 'NaN 时钟不得成功');
    assert.ok(nanChecked.problems.some(s => s.includes('BTP_CLOCK_INVALID')));
    // 时钟抛错 → 不成功（check 以问题记录暴露原错误，不带成功结论）
    const oldNow2 = Date.now;
    Date.now = () => { throw new Error('clock exploded mid-check'); };
    let throwChecked;
    try { throwChecked = tool.checkDir(b.outDir); } finally { Date.now = oldNow2; }
    assert.equal(throwChecked.ok, false, '时钟抛错不得成功');
    assert.ok(throwChecked.problems.some(s => s.includes('BTP_CLOCK_ERROR') && s.includes('clock exploded')),
      throwChecked.problems.join('; '));
    // 正常时钟对照 → 成功
    now = Date.now();
    assert.equal(tool.checkDir(b.outDir).ok, true, '正常对照 check 通过');
    // 合成模式不受时钟守卫影响（关闭包/合成候选不依赖期限）
    const syn = buildWindow('P', null, 'a5-syn-' + RUN_ID);
    assert.equal(tool.checkDir(syn.outDir).ok, true);
  } finally {
    fs.readFileSync = realRead;
  }
});

test('A6 R3：目录占位/多余目录预检零写；输出根 junction 拒绝；部分写副作用事实；竞态 EEXIST 不算本轮写入', () => {
  // R3-a：预存空目录冒名 manifest.json → 预检拒绝、全树快照不变、零新写
  const dirConflict = path.join(OUT_ROOT, 'a6-dirconflict-' + RUN_ID);
  fs.mkdirSync(path.join(dirConflict, 'manifest.json'), { recursive: true });
  const before = JSON.stringify(fs.readdirSync(dirConflict));
  let err = null;
  try { tool.build('P', writePlan('P'), dirConflict); } catch (e) { err = e; }
  assert.equal(err && err.code, 'BTP_OUT_CONFLICT');
  assert.equal(JSON.stringify(fs.readdirSync(dirConflict)), before, '预检冲突：目录快照不变');
  assert.equal(err.wroteFiles, undefined, '预检失败零写（无写入事实）');
  // R3-a：多余空目录 → 预检拒绝
  const extraDir = path.join(OUT_ROOT, 'a6-extradir-' + RUN_ID);
  fs.mkdirSync(path.join(extraDir, 'unrelated', 'nested'), { recursive: true });
  err = null;
  try { tool.build('P', writePlan('P'), extraDir); } catch (e) { err = e; }
  assert.equal(err && err.code, 'BTP_OUT_CONFLICT', '多余目录预检拒绝');
  assert.deepEqual(fs.readdirSync(extraDir), ['unrelated'], '不清理用户目录');
  // R3-b：输出根本身是 junction（指向输出根之外）→ 拒绝且目标零写
  const jTarget = path.join(OUT_ROOT, 'a6-junction-target-' + RUN_ID);
  fs.mkdirSync(jTarget, { recursive: true });
  const jLink = path.join(OUT_ROOT, 'a6-junction-' + RUN_ID);
  let junctionCreated = true;
  try { fs.symlinkSync(jTarget, jLink, 'junction'); } catch (_) { junctionCreated = false; }
  if (junctionCreated) {
    err = null;
    try { tool.build('P', writePlan('P'), jLink); } catch (e) { err = e; }
    assert.equal(err && err.code, 'BTP_OUT_CONFLICT', 'junction 输出根拒绝：' + (err && err.message));
    assert.equal(fs.readdirSync(jTarget).length, 0, 'junction 目标零写');
    // 检查入口也不认领 junction 目录
    assert.throws(() => tool.checkDir(jLink), e => e.code === 'BTP_OUT_CONFLICT');
    assert.throws(() => tool.checkCloseDir(jLink), e => e.code === 'BTP_OUT_CONFLICT');
  }
  // R3-c：首个文件排他创建后部分写 EIO → 副作用如实记录（written/wroteFiles）
  const partialDir = path.join(OUT_ROOT, 'a6-partial-' + RUN_ID);
  const pf = writePlan('P');
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (f, buf, opts) {
    if (typeof f === 'string' && f.endsWith('server' + path.sep + 'index.js')) {
      realWrite.call(this, f, Buffer.from(buf).subarray(0, 7), opts);
      const e = new Error('synthetic partial write'); e.code = 'EIO'; throw e;
    }
    return realWrite.call(this, f, buf, opts);
  };
  try { tool.build('P', pf, partialDir); } catch (e) { err = e; } finally { fs.writeFileSync = realWrite; }
  assert.equal(err && err.code, 'EIO');
  assert.equal(err.wroteFiles, 1, '部分写副作用必须计入 wroteFiles');
  assert.deepEqual(err.written, ['server/index.js']);
  assert.equal(fs.statSync(path.join(partialDir, 'server', 'index.js')).size, 7, '盘上为 7 字节部分文件');
  // R3-c：竞态 EEXIST（他人抢先创建）→ 不算本轮写入、不覆盖不删除
  const raceDir = path.join(OUT_ROOT, 'a6-race-' + RUN_ID);
  const racePlan = writePlan('P');
  const gateRel = path.join('server', 'gate.js');
  fs.writeFileSync = function (f, buf, opts) {
    if (typeof f === 'string' && f.endsWith(gateRel)) {
      realWrite.call(this, f, Buffer.from('other-writer'), opts); // 他人文件
      const e = new Error('EEXIST race'); e.code = 'EEXIST'; throw e;
    }
    return realWrite.call(this, f, buf, opts);
  };
  try { tool.build('P', racePlan, raceDir); } catch (e) { err = e; } finally { fs.writeFileSync = realWrite; }
  assert.equal(err && err.code, 'EEXIST');
  assert.ok(!err.written || !err.written.includes('server/gate.js'), '他人 EEXIST 文件不算本轮写入');
  assert.equal(fs.readFileSync(path.join(raceDir, gateRel), 'utf8'), 'other-writer', '不覆盖他人文件');
});

test('A7 R4-a：关闭包受审装配（正确根/唯一页面/完整依赖）；checkCloseDir 独立重建；关闭 App/Page 禁用零发送', async () => {
  const p = buildWindow('P', null, 'a7-close-' + RUN_ID);
  const close = path.join(p.outDir, 'close');
  // 装配正确：根路径 + 唯一页面 + 页面文件齐备
  const cfg = JSON.parse(fs.readFileSync(path.join(close, 'project.config.json'), 'utf8'));
  assert.equal(cfg.miniprogramRoot, 'frontend/');
  assert.equal(cfg.cloudfunctionRoot, 'server/');
  const appJson = JSON.parse(fs.readFileSync(path.join(close, 'frontend', 'app.json'), 'utf8'));
  assert.deepEqual(appJson.pages, ['pages/schedule-sandbox/schedule-sandbox'], '关闭包唯一页面');
  for (const page of appJson.pages) {
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      assert.equal(fs.existsSync(path.join(close, 'frontend', page + ext)), true, page + ext + ' 存在');
    }
  }
  // 独立重建核对（不读 manifest/计划；不受开启候选损坏影响）
  const closeOk = tool.checkCloseDir(p.outDir);
  assert.equal(closeOk.ok, true, closeOk.problems.join('; '));
  assert.equal(closeOk.files, 23);
  // 篡改关闭装配（恢复 9 页面）→ 独立重建拒绝
  const closeApp = path.join(close, 'frontend', 'app.json');
  const original = fs.readFileSync(closeApp);
  fs.writeFileSync(closeApp, original.toString('utf8').replace(
    '"pages": [\n    "pages/schedule-sandbox/schedule-sandbox"\n  ]',
    '"pages": [\n    "pages/index/index",\n    "pages/schedule-sandbox/schedule-sandbox"\n  ]'));
  const broken = tool.checkCloseDir(p.outDir);
  assert.equal(broken.ok, false, '关闭装配篡改被独立重建拒绝');
  assert.ok(broken.problems.some(s => s.includes('app.json')));
  fs.writeFileSync(closeApp, original);
  assert.equal(tool.checkCloseDir(p.outDir).ok, true, '还原后恢复');
  // 关闭 App/Page 实际加载：入口禁用、驱动零发送（不依赖开启窗口期限）
  const { api, calls } = makeChainWx(close, seedUsers(), 'manager');
  const app = loadCandidateApp(close, api);
  assert.ok(app.globalData, '关闭 App 壳可加载');
  const page = loadCandidatePage(close, api);
  page.onLoad();
  assert.equal(page.data.entryAllowed, false, '关闭包入口禁用');
  await page.runAction('identify');
  assert.ok(page.data.lastError, '禁用状态下动作被拒：' + page.data.lastError);
  const callsAfterPage = calls.length;
  const driver = candidateFrontend(close, 'utils/sandbox-test-driver.js');
  const blocked = await driver.runCase({ api, testCaseId: 'V07-A', input: { projectId: SYN_PROJECT, userId: WORKER } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'TEST_DRIVER_GATE_BLOCKED');
  assert.equal(blocked.report.sent, 0, '关闭驱动零发送');
  assert.equal(calls.length, callsAfterPage, '关闭态全程零发送');
  // 服务端关闭门槛：任何动作 SANDBOX_DISABLED
  const srv = as(close, seedUsers(), 'owner');
  const denied = await srv({ action: 'identify', requestId: 'a7-closed-1' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'SANDBOX_DISABLED');
});

test('A8 R5-a：真实模式必须核对实际记录文件（缺文件/摘要不符/合成标记/身份不符/缺回执全拒绝；合法对照通过）', () => {
  const mkReal = (round, evidence) => ({
    synthetic: false,
    businessRoundId: round,
    projectId: 'p_sbx_' + crypto.createHash('sha256').update(round).digest('hex').slice(0, 32),
    projectReadyMarker: 'ready-' + round,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T02:00:00Z',
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(r =>
      [r, { userId: SYN_USERS[r].userId, source: '人工声明（完整身份待用户核实）' }])),
    participantEvidence: evidence.participant,
    projectReadback: evidence.project
  });
  const validParticipant = () => Object.fromEntries(['owner', 'manager', 'worker'].map(r => {
    const fx = participantRecordFixture(r, SYN_USERS[r].userId, { businessRoundId: 'synthetic-round-a8-' + RUN_ID.slice(-8) });
    return [r, { kind: 'readback-record', recordSha256: fx.recordSha256, recordPath: fx.recordPath }];
  }));
  const roundA8 = 'synthetic-round-a8-' + RUN_ID.slice(-8);
  const projA8 = 'p_sbx_' + crypto.createHash('sha256').update(roundA8).digest('hex').slice(0, 32);
  const validProject = () => {
    const fx = projectReadbackRecordFixture(roundA8, projA8, 'ready-' + roundA8, { businessRoundId: roundA8 });
    return { source: 'readback', projectId: projA8, businessRoundId: roundA8, projectReadyMarker: 'ready-' + roundA8, recordSha256: fx.recordSha256, recordPath: fx.recordPath };
  };
  // 合法对照：E 窗口真实模式（含记录文件）→ 接受
  const parsed = tool.readPlan(writePlan('E', mkReal(roundA8, { participant: validParticipant(), project: validProject() })), 'E');
  assert.equal(parsed.evidenceBound, true);
  assert.equal(parsed.projectReadback.recordPath !== null, true);
  // 反例 1：kind+64hex 但缺记录文件 → 拒绝（自报摘要不等于已核对记录）
  assert.throws(() => tool.readPlan(writePlan('P', mkReal(roundA8, {
    participant: Object.fromEntries(['owner', 'manager', 'worker'].map(r =>
      [r, { kind: 'readback-record', recordSha256: 'a'.repeat(64) }])),
    project: null
  })), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID);
  // 反例 2：记录文件不存在
  assert.throws(() => tool.readPlan(writePlan('P', mkReal(roundA8, {
    participant: Object.fromEntries(['owner', 'manager', 'worker'].map(r =>
      [r, { kind: 'readback-record', recordSha256: 'a'.repeat(64), recordPath: path.join(RECORD_DIR, 'missing-' + r + '.json') }])),
    project: null
  })), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID);
  // 反例 3：摘要与记录内容不符
  assert.throws(() => tool.readPlan(writePlan('P', mkReal(roundA8, {
    participant: Object.fromEntries(['owner', 'manager', 'worker'].map(r => {
      const fx = participantRecordFixture(r, SYN_USERS[r].userId, { businessRoundId: roundA8 });
      return [r, { kind: 'readback-record', recordSha256: 'b'.repeat(64), recordPath: fx.recordPath }];
    })),
    project: null
  })), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID && /摘要/.test(e.message));
  // 反例 4：记录标记 synthetic=true → 不能为真实候选背书
  assert.throws(() => tool.readPlan(writePlan('P', mkReal(roundA8, {
    participant: Object.fromEntries(['owner', 'manager', 'worker'].map(r => {
      const fx = participantRecordFixture(r, SYN_USERS[r].userId, { businessRoundId: roundA8, synthetic: true });
      return [r, { kind: 'readback-record', recordSha256: fx.recordSha256, recordPath: fx.recordPath }];
    })),
    project: null
  })), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID && /合成/.test(e.message));
  // 反例 5：记录 subject.userId 与计划账号不一致（冒用他人记录）
  assert.throws(() => tool.readPlan(writePlan('P', mkReal(roundA8, {
    participant: Object.fromEntries(['owner', 'manager', 'worker'].map(r => {
      const other = r === 'owner' ? MANAGER : OWNER;
      const fx = participantRecordFixture(r, other, { businessRoundId: roundA8 });
      return [r, { kind: 'readback-record', recordSha256: fx.recordSha256, recordPath: fx.recordPath }];
    })),
    project: null
  })), 'P'), e => e.code === tool.ERR.PLAN_USER_INVALID && /身份\/角色/.test(e.message));
  // 反例 6：P 回读记录缺持久回执（persistentReceipt）→ 拒绝
  const noReceipt = projectReadbackRecordFixture(roundA8, projA8, 'ready-' + roundA8, { businessRoundId: roundA8 });
  const noReceiptObj = JSON.parse(fs.readFileSync(noReceipt.recordPath, 'utf8'));
  delete noReceiptObj.persistentReceipt;
  fs.writeFileSync(noReceipt.recordPath, JSON.stringify(noReceiptObj, null, 2));
  noReceipt.recordSha256 = crypto.createHash('sha256').update(fs.readFileSync(noReceipt.recordPath)).digest('hex');
  assert.throws(() => tool.readPlan(writePlan('E', mkReal(roundA8, {
    participant: validParticipant(), project: {
      source: 'readback', projectId: projA8, businessRoundId: roundA8,
      projectReadyMarker: 'ready-' + roundA8, recordSha256: noReceipt.recordSha256, recordPath: noReceipt.recordPath
    }
  })), 'E'), e => e.code === tool.ERR.PLAN_PROJECT_INVALID && /persistentReceipt|持久回执/.test(e.message));
  // 反例 7：P 回读记录 projectId 与计划不一致 → 拒绝
  const wrongProj = projectReadbackRecordFixture(roundA8, 'p_sbx_' + '0'.repeat(32), 'ready-' + roundA8, { businessRoundId: roundA8 });
  assert.throws(() => tool.readPlan(writePlan('E', mkReal(roundA8, {
    participant: validParticipant(), project: {
      source: 'readback', projectId: projA8, businessRoundId: roundA8,
      projectReadyMarker: 'ready-' + roundA8, recordSha256: wrongProj.recordSha256, recordPath: wrongProj.recordPath
    }
  })), 'E'), e => e.code === tool.ERR.PLAN_PROJECT_INVALID && /projectId/.test(e.message));
  // 合成模式保持：无记录文件仍可构建（合成候选不受影响）
  const syn = buildWindow('P', null, 'a8-syn-' + RUN_ID);
  assert.equal(syn.manifest.synthetic, true);
});

test('A3 R1 反例：空清单 / 越界变换同步哈希 / 模式篡改 / 多余文件 全部拒绝；关闭包不受开启候选损坏影响', () => {
  // C02 类：空 manifest（无 plan.json、空 files）→ 拒绝
  const emptyDir = path.join(OUT_ROOT, 'a3-empty-' + RUN_ID);
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'manifest.json'),
    JSON.stringify({ schema: tool.MANIFEST_SCHEMA, files: [], closePackage: { files: [] } }));
  assert.equal(tool.checkDir(emptyDir).ok, false);
  // C03 类：E 候选越界加入 reassignSchedule 并同步 manifest 哈希 → 重建比对拒绝
  const e3 = buildWindow('E', { projectId: SYN_PROJECT }, 'a3-tamper-' + RUN_ID);
  const gatePath = path.join(e3.outDir, 'server/gate.js');
  let gateSrc = fs.readFileSync(gatePath, 'utf8');
  gateSrc = gateSrc.replace('const EXECUTE_ALLOWED = Object.freeze([',
    'const EXECUTE_ALLOWED = Object.freeze([\n  \'reassignSchedule\',');
  fs.writeFileSync(gatePath, gateSrc);
  const m3 = JSON.parse(fs.readFileSync(path.join(e3.outDir, 'manifest.json'), 'utf8'));
  const rec3 = m3.files.find(r => r.rel === 'server/gate.js');
  rec3.sha256 = crypto.createHash('sha256').update(gateSrc).digest('hex');
  rec3.bytes = Buffer.byteLength(gateSrc);
  fs.writeFileSync(path.join(e3.outDir, 'manifest.json'), JSON.stringify(m3, null, 2));
  const r3 = tool.checkDir(e3.outDir);
  assert.equal(r3.ok, false, '清单同步哈希不能替代来源重建比对');
  assert.ok(r3.problems.some(s => s.includes('gate.js')));
  // C04 类：仅翻转 manifest.synthetic → 与目录内计划不一致 → 拒绝
  const p4 = buildWindow('P', null, 'a3-flip-' + RUN_ID);
  const m4 = JSON.parse(fs.readFileSync(path.join(p4.outDir, 'manifest.json'), 'utf8'));
  m4.synthetic = false;
  fs.writeFileSync(path.join(p4.outDir, 'manifest.json'), JSON.stringify(m4, null, 2));
  assert.equal(tool.checkDir(p4.outDir).ok, false);
  // 多余文件 → 拒绝
  const p5 = buildWindow('P', null, 'a3-extra-' + RUN_ID);
  fs.writeFileSync(path.join(p5.outDir, 'frontend/extra.txt'), 'x');
  assert.equal(tool.checkDir(p5.outDir).ok, false);
  // C10 类：开启候选损坏，但关闭包独立核对仍成立
  fs.unlinkSync(path.join(p5.outDir, 'frontend/pages/schedule-sandbox/schedule-sandbox.js'));
  assert.equal(tool.checkDir(p5.outDir).ok, false);
  const closeStill = tool.checkCloseDir(p5.outDir);
  assert.equal(closeStill.ok, true, closeStill.problems.join('; '));
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

test('B1 P 候选服务端链：成员准备全链走通；removeMember 与施工写被收窄拒绝且全库零写', async () => {
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

  // 收窄：P 禁止 removeMember 与施工写（拒绝前做全库快照，R6 口径：核对全部集合）
  const snap = dbSnap(db);
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
  assert.equal(dbSnap(db), snap, '拒绝必须全库零写（不只单一集合）');
});

test('B2 E 候选服务端链：合法安排/调整/取消走通；管理动作被收窄拒绝且全库零写', async () => {
  const p = buildWindow('P', null, 'p-echain-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'e-chain-' + RUN_ID);
  const db = seedUsers();
  await seedMembers(p.outDir, db);

  const call = as(e.outDir, db, 'manager');
  const wCall = as(e.outDir, db, 'worker');
  const oCall = as(e.outDir, db, 'owner');
  // E1 合法新增（管家）
  const s1 = await call({
    action: 'createSchedule', projectId: SYN_PROJECT, requestId: 'e-sch-1',
    form: SCHEDULE_FORM, expectedConfirmed: true
  });
  assert.equal(s1.ok, true, JSON.stringify(s1));
  // E2 调整（版本 +1，填原因）
  const s2 = await call({
    action: 'updateSchedule', projectId: SYN_PROJECT, requestId: 'e-sch-2',
    scheduleId: s1.scheduleId, expectedVersion: s1.version,
    reason: '三账号合成调整', form: { ...SCHEDULE_FORM, content: '调整后内容' }
  });
  assert.equal(s2.ok, true, JSON.stringify(s2));
  // E4 收窄：师傅 / 仅负责人尝试受限写入 → 拒绝且全库零写
  const snap = dbSnap(db);
  const workerWrite = await wCall({
    action: 'createSchedule', projectId: SYN_PROJECT, requestId: 'e-sch-w1', form: SCHEDULE_FORM
  });
  assert.equal(workerWrite.ok, false, '师傅不得写安排');
  const ownerWrite = await oCall({
    action: 'createSchedule', projectId: SYN_PROJECT, requestId: 'e-sch-o1', form: SCHEDULE_FORM
  });
  assert.equal(ownerWrite.ok, false, '仅负责人不得写安排');
  assert.equal(dbSnap(db), snap, '拒绝零写（全库口径）');
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
    const denied = await whoCall({ action, projectId: SYN_PROJECT, ...extra });
    assert.equal(denied.ok, false, action + ' 应被 E 收窄拒绝');
    assert.equal(denied.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE', action);
  }
  assert.equal(dbSnap(db), snap, '收窄拒绝全程零写（全库口径）');
  // E6 取消（填原因）
  const canceled = await call({
    action: 'cancelSchedule', projectId: SYN_PROJECT, requestId: 'e-sch-3',
    scheduleId: s1.scheduleId, expectedVersion: s2.version, reason: '三账号合成取消'
  });
  assert.equal(canceled.ok, true, JSON.stringify(canceled));
});

test('B3 X 候选服务端链：有任务移出拒绝→清空后移出成功→退出后访问受限；写动作被收窄拒绝', async () => {
  const p = buildWindow('P', null, 'p-xchain-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'e-xchain-' + RUN_ID);
  const x = buildWindow('X', { projectId: SYN_PROJECT }, 'x-chain-' + RUN_ID);
  const db = seedUsers();
  await seedMembers(p.outDir, db);

  const xMgr = as(x.outDir, db, 'manager');
  const xWorker = as(x.outDir, db, 'worker');
  // V07-A 前置：一条有效安排（经 E 候选创建——E 窗口动作在 X 前完成）
  const eMgr = as(e.outDir, db, 'manager');
  const s1 = await eMgr({
    action: 'createSchedule', projectId: SYN_PROJECT, requestId: 'x-sch-1',
    form: SCHEDULE_FORM, expectedConfirmed: true
  });
  assert.equal(s1.ok, true, JSON.stringify(s1));
  // V07-A：有未完成安排 → 明确拒绝
  const blocked = await xMgr({ action: 'removeMember', projectId: SYN_PROJECT, userId: WORKER });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'WORKER_HAS_ACTIVE_SCHEDULES');
  const membersBefore = countOf(db, 'project_members');
  // V07-B 前置：管家按原因取消师傅全部有效安排
  const canceled = await xMgr({
    action: 'cancelSchedule', projectId: SYN_PROJECT, requestId: 'x-cancel-1',
    scheduleId: s1.scheduleId, expectedVersion: s1.version, reason: 'X 窗口移出前清空任务'
  });
  assert.equal(canceled.ok, true, JSON.stringify(canceled));
  // V07-B：单次移出成功
  const removed = await xMgr({ action: 'removeMember', projectId: SYN_PROJECT, userId: WORKER });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.status, 'left', '成员状态应为 left');
  assert.equal(countOf(db, 'project_members'), membersBefore, '记录保留（不删除）');
  // 退出后：师傅的项目列表被过滤（成员权限生效，非允许名单删除）
  const workerProjects = await xWorker({ action: 'listMyProjects' });
  assert.equal(workerProjects.ok, true);
  assert.equal((workerProjects.projects || []).length, 0, '退出后师傅读不到本项目');
  // X 收窄：安排写与改派拒绝且全库零写
  const snap = dbSnap(db);
  for (const action of ['createSchedule', 'updateSchedule', 'reassignSchedule']) {
    const denied = await xMgr({
      action, projectId: SYN_PROJECT, requestId: 'x-deny-' + action,
      scheduleId: s1.scheduleId, form: SCHEDULE_FORM, userId: WORKER
    });
    assert.equal(denied.ok, false, action + ' 应被 X 收窄拒绝');
    assert.equal(denied.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE', action);
  }
  assert.equal(dbSnap(db), snap, 'X 收窄拒绝零写（全库口径）');
  // 管家仍可读历史
  const history = await xMgr({
    action: 'listScheduleRevisions', projectId: SYN_PROJECT, scheduleId: s1.scheduleId
  });
  assert.equal(history.ok, true, '管家仍可查安排历史');
});

// ═══════════════════════════════════════════════════════════════════════════
// C：候选前端（页面收窄 + 驱动门控）
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

test('C1 P/E 候选前端：动作选择器按窗口收窄、专用驱动关闭（零发送）、测试卡隐藏', async () => {
  const p = buildWindow('P', null, 'p-fe-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'e-fe-' + RUN_ID);
  for (const [label, cand, allowed] of [['P', p, tool.P_ACTIONS], ['E', e, tool.E_ACTIONS]]) {
    // R4：页面动作选择器收窄为窗口允许子集
    const pageSrc = fs.readFileSync(path.join(cand.outDir, 'frontend/pages/schedule-sandbox/schedule-sandbox.js'), 'utf8');
    const pageKeys = [...pageSrc.matchAll(/key: '(\w+)'/g)].map(m => m[1]);
    assert.ok(pageKeys.length > 0 && pageKeys.length < 17, label + '：页面动作应已收窄');
    for (const key of pageKeys) {
      assert.ok(allowed.includes(key), label + '：页面动作 ' + key + ' 必须在窗口允许清单内');
    }
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

test('C2 X 候选前端：V06 按钮不显示且零发送、V07-A candidate 后同轮阻断 V07-B（接续门槛）、独立轮次可达', async () => {
  const x = buildWindow('X', { projectId: SYN_PROJECT }, 'x-fe-' + RUN_ID);
  // R4：X 页面专用按钮收窄为 V07-A/B，普通动作收窄为 X 允许子集
  const pageSrc = fs.readFileSync(path.join(x.outDir, 'frontend/pages/schedule-sandbox/schedule-sandbox.js'), 'utf8');
  const tcLabels = [...pageSrc.matchAll(/id: '(V0[67]-\w)'/g)].map(m => m[1]);
  assert.deepEqual(tcLabels, ['V07-A', 'V07-B'], 'X 页面专用按钮必须只有 V07-A/B');
  const pageKeys = [...pageSrc.matchAll(/key: '(\w+)'/g)].map(m => m[1]);
  for (const key of pageKeys) assert.ok(tool.X_ACTIONS.includes(key), '页面动作 ' + key + ' 须在 X 允许清单内');

  const driver = candidateFrontend(x.outDir, 'utils/sandbox-test-driver.js');
  let removeCalls = 0;
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
  // 同轮接续门槛：A candidate 未人工核对前，同候选 B 必须零发送阻断
  v07Phase = 'B';
  const blocked = await driver.runCase({
    api, testCaseId: 'V07-B', input: { projectId: SYN_PROJECT, userId: WORKER }
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'TEST_DRIVER_PREFLIGHT_BLOCKED');
  assert.equal(blocked.report.sent, 0, '接续门槛：V07-B 同轮零发送');
  assert.ok(/未完成用例/.test(blocked.message || blocked.reasons && blocked.reasons.join('') || ''),
    '阻断原因指向未完成用例');
  // 独立轮次候选（A 的未决不跨轮阻断）→ 成功退出（补充对照；同轮链见 D3）
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
  // Page 级（独立轮次候选2）：入口与测试卡可见；V06 按钮不存在于 testCases，
  // 直接构造 V06 点击 → 零发送 stopped
  const page = loadCandidatePage(x2.outDir, api);
  page.onLoad();
  assert.equal(page.data.entryAllowed, true);
  assert.equal(page.data.testCardVisible, true, 'X 窗口专用测试卡可见');
  assert.deepEqual(page.data.testCases.map(c => c.id), ['V07-A', 'V07-B'], '页面 testCases 不含 V06');
  const callsBefore = calls.length;
  await page.runTestCase({ currentTarget: { dataset: { case: 'V06-a' } } });
  assert.equal(page.data.testReport.verdict, 'stopped');
  assert.equal(page.data.testReport.stoppedReason, 'TEST_DRIVER_UNKNOWN_CASE');
  assert.equal(calls.length, callsBefore, 'V06 页面点击零发送');
});

// ═══════════════════════════════════════════════════════════════════════════
// D：完整候选 App→Page→client→候选服务端→合成 db 实际业务链（R4）
// ═══════════════════════════════════════════════════════════════════════════

test('D1 完整链·P：候选 App 初始化 + Page 身份登记/建项目实际贯通候选服务端与合成 db', async () => {
  const p = buildWindow('P', null, 'd1-p-' + RUN_ID);
  const db = seedUsers();
  const { api, calls } = makeChainWx(p.outDir, db, 'owner');
  // R4：App 壳初始化链（原样 app.js → config/cloud.js → wx.cloud.init）
  const app = loadCandidateApp(p.outDir, api);
  assert.equal(app.globalData.cloudReady, true, '候选 App 云初始化链应可达');
  const page = loadCandidatePage(p.outDir, api);
  page.onLoad();
  assert.equal(page.data.entryAllowed, true);
  // 实际业务链：Page 提交 → client → 候选服务端 → 合成 db
  await page.runAction('identify');
  assert.equal(page.data.lastError, '', 'identify 不应报错：' + page.data.lastError);
  await page.runAction('createProject');
  assert.equal(page.data.lastError, '', 'createProject 不应报错：' + page.data.lastError);
  assert.ok(page.data.lastResult.includes(SYN_PROJECT), '建项目结果应含 roundId 绑定的 projectId');
  assert.equal(countOf(db, 'projects'), 1, '候选服务端已在合成 db 建立本轮项目');
  assert.ok(calls.some(c => c.action === 'createProject'), '请求确实经合成传输发出');
  // P 页面不含安排写动作入口
  assert.equal(page.data.actions.some(a => a.key === 'createSchedule'), false, 'P 页面不提供安排写');
});

test('D2 完整链·E：Page 表单提交新增安排实际贯通；client 直发受限管理动作被服务端拒绝', async () => {
  const p = buildWindow('P', null, 'd2-p-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'd2-e-' + RUN_ID);
  const db = seedUsers();
  await seedMembers(p.outDir, db);
  const { api } = makeChainWx(e.outDir, db, 'manager');
  const page = loadCandidatePage(e.outDir, api);
  page.onLoad();
  assert.equal(page.data.entryAllowed, true);
  // 页面动作收窄：不含任何管理动作
  for (const a of page.data.actions) assert.ok(tool.E_ACTIONS.includes(a.key));
  // 先身份登记（client 可信账号绑定），再表单提交
  await page.runAction('identify');
  assert.equal(page.data.lastError, '', 'identify 不应报错：' + page.data.lastError);
  // 表单提交（日期一致，无需显式确认分支；仍按页面真实路径设置）
  page.setData({
    projectIdInput: SYN_PROJECT,
    form: {
      stage: '拆改', trade: '拆改', workerUserId: WORKER,
      startDate: '2030-01-02', endDate: '2030-01-03', expectedDate: '2030-01-03',
      restDaysText: '', content: 'D2 完整链新增'
    }
  });
  await page.runAction('createSchedule');
  assert.equal(page.data.lastError, '', 'createSchedule 不应报错：' + page.data.lastError);
  assert.equal(countOf(db, 'schedules'), 1, '安排已实际写入合成 db');
  // 拒绝路径：client 直发受限管理动作 → 服务端收窄拒绝
  const client = candidateFrontend(e.outDir, 'utils/schedule-sandbox-client.js');
  const denied = await client.callSandbox(
    { action: 'assignManager', projectId: SYN_PROJECT, bindingNumber: '1', requestId: 'd2-deny-1' },
    { api });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE');
});

test('D3 完整链·X 同项目同轮：V07-A candidate → 既有人工核对入口接续 → 页面取消任务 → V07-B 成功（不换轮次、不清缓存）', async () => {
  const p = buildWindow('P', null, 'd3-p-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'd3-e-' + RUN_ID);
  const x = buildWindow('X', { projectId: SYN_PROJECT }, 'd3-x-' + RUN_ID);
  const db = seedUsers();
  await seedMembers(p.outDir, db);
  // 前置：E 候选建一条有效安排
  const eMgr = as(e.outDir, db, 'manager');
  const s1 = await eMgr({
    action: 'createSchedule', projectId: SYN_PROJECT, requestId: 'd3-sch-1',
    form: SCHEDULE_FORM, expectedConfirmed: true
  });
  assert.equal(s1.ok, true, JSON.stringify(s1));

  // X 候选完整链：App + Page + client + driver，全部经同一合成传输（actor=管家）
  const { api, calls } = makeChainWx(x.outDir, db, 'manager');
  const app = loadCandidateApp(x.outDir, api);
  assert.equal(app.globalData.cloudReady, true);
  const page = loadCandidatePage(x.outDir, api);
  page.onLoad();
  assert.equal(page.data.entryAllowed, true);
  await page.runAction('identify');
  assert.equal(page.data.lastError, '', 'identify 不应报错：' + page.data.lastError);
  assert.deepEqual(page.data.testCases.map(c => c.id), ['V07-A', 'V07-B']);

  // V07-A：有未完成安排 → 服务端明确拒绝 → 驱动记 candidate
  await page.runTestCase({ currentTarget: { dataset: { case: 'V07-A' } } });
  assert.equal(page.data.testReport.testCaseId, 'V07-A');
  assert.equal(page.data.testReport.verdict, 'candidate',
    JSON.stringify(page.data.testReport).slice(0, 300));
  assert.ok(calls.some(c => c.action === 'removeMember' && c.userId === WORKER));
  const removeCountA = calls.filter(c => c.action === 'removeMember').length;

  // 既有人工核对入口接续（同轮、同候选、同存储；声明不验真，但走真实页面通道）
  page.setData({ testReviewIdInput: 'd3-review-001' });
  page.acceptTestCloudReview();
  assert.ok(/已记录人工核对声明/.test(page.data.testReport.reviewResult || ''),
    '人工核对入口应接受声明：' + page.data.testReport.reviewResult);

  // 页面取消师傅安排（普通链 cancelSchedule）
  page.setData({
    scheduleIdInput: s1.scheduleId,
    expectedVersionInput: String(s1.version),
    reasonInput: 'D3 同轮移出前清空任务'
  });
  await page.runAction('cancelSchedule');
  assert.equal(page.data.lastError, '', 'cancelSchedule 不应报错：' + page.data.lastError);
  assert.equal(countOf(db, 'schedules'), 1, '取消为状态更新，不删除记录');

  // V07-B：同轮同候选移出成功（不允许换轮次或清缓存替代）
  await page.runTestCase({ currentTarget: { dataset: { case: 'V07-B' } } });
  assert.equal(page.data.testReport.testCaseId, 'V07-B');
  assert.equal(page.data.testReport.verdict, 'candidate',
    JSON.stringify(page.data.testReport).slice(0, 300));
  const removeCountB = calls.filter(c => c.action === 'removeMember').length;
  assert.equal(removeCountB, removeCountA + 1, 'V07-B 恰好新增一次移出请求');
  const members = db.getPrefixedData()[PREFIX + 'project_members'] || {};
  const workerRecord = Object.values(members).find(m => m.userId === WORKER);
  assert.equal(workerRecord && workerRecord.status, 'left', '师傅成员状态已更新为 left');
});

test('D4 完整链·未知响应与停机：传输中断→页面重开呈现未决；非幂等动作拒绝重发且零发送', async () => {
  const p = buildWindow('P', null, 'd4-p-' + RUN_ID);
  const e = buildWindow('E', { projectId: SYN_PROJECT }, 'd4-e-' + RUN_ID);
  const db = seedUsers();
  await seedMembers(p.outDir, db);
  const { api, calls } = makeChainWx(e.outDir, db, 'manager');
  const page = loadCandidatePage(e.outDir, api);
  page.onLoad();
  await page.runAction('identify');
  assert.equal(page.data.lastError, '', 'identify 绑定应成功');
  // 同一存储 shim 上换用会抛错的传输（模拟响应丢失/未知结果）
  const failing = makeChainWx(e.outDir, db, 'manager', { throwAfter: 0, storageShim: api.storage });
  const page2 = loadCandidatePage(e.outDir, failing.api);
  page2.onLoad();
  // 非幂等动作 assignManager 发送后传输失败 → 未决保留
  page2.setData({ bindingNumberInput: '1234' });
  await page2.runAction('assignManager');
  assert.ok(page2.data.lastError, '传输失败必须显式报错：' + page2.data.lastError);
  // 页面重开（新实例、同一存储）：未决记录仍在
  const page3 = loadCandidatePage(e.outDir, api);
  page3.onLoad();
  page3.restorePending();
  assert.equal(page3.data.pendingAvailable, true, '页面重开仍可见未决');
  assert.ok(page3.data.pendingRequestId, '未决请求编号已保留');
  assert.equal(page3.data.pendingAction, 'assignManager');
  // 未决期间新普通提交被阻断（零发送）
  const callsBeforeBlocked = calls.length;
  await page3.runAction('createSchedule');
  assert.ok(/结果未知/.test(page3.data.lastError), '未决期间普通提交被阻断：' + page3.data.lastError);
  assert.equal(calls.length, callsBeforeBlocked, '阻断不发送');
  // 恢复入口：非幂等动作拒绝重发（T1），且零发送
  const resumed = await candidateFrontend(e.outDir, 'utils/schedule-sandbox-client.js')
    .resumePending({ api, sensitive: { bindingNumber: '1234' } });
  assert.equal(resumed.ok, false);
  assert.equal(resumed.code, 'SANDBOX_RETRY_UNSAFE', '非幂等动作不得自动重发');
  assert.equal(calls.length, callsBeforeBlocked, '拒绝重发必须零发送');
});
