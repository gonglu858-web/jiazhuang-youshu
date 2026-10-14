#!/usr/bin/env node
'use strict';
/**
 * 三账号独立业务测试包本地准备 —— 收尾证据（2026-10-14）。
 *
 * 依据：docs/WorkBuddy任务-三账号独立业务测试包本地准备-20261013.md、
 *       docs/Codex方案-独立测试项目与管家师傅业务验证-20261013.md。
 * 受测实现：miniapp/scripts/package-business-test.cjs（本运行时记录其
 * SHA-256 内容指纹，不硬编码提交号）。
 *
 * 口径分述（不混淆）：
 * - 「合成验证」：候选服务端/前端在 Node vm + 合成 db / 合成 wx 传输内运行；
 * - 「SDK 本地转换」：本仓库既有的 cloudbase sdk 适配层语义（未在本轮触达）；
 * - 「未验证平台项」：真实云函数部署行为、真实 wx.cloud.callFunction、
 *   project-guard 云端建库等 —— 本轮一律未验证，测试全绿不等于平台可用。
 *
 * 运行：node docs/证据/三账号业务测试包本地准备-20261014.cjs
 *   默认仅输出 stdout，不写文件。
 *   另存 JSON：node 本脚本 --out <绝对路径>
 *   —— 以 wx 独占新建，目标已存在即失败退出，绝不覆盖历史证据。
 *
 * 零网络、零真实子进程、零真实凭据；不部署、不上传、不初始化任何云端资源。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const REPO = path.resolve(__dirname, '..', '..');
const tool = require(path.join(REPO, 'miniapp', 'scripts', 'package-business-test.cjs'));
const { createSandboxTestDb, PREFIX } = require(path.join(
  REPO, 'miniapp', 'tests', 'helpers', 'sandbox-test-db.cjs'));
const { APPID } = require(path.join(
  REPO, 'miniapp', 'tests', 'helpers', 'sandbox-entry-loader.cjs'));

const ENV_ID = 'cloud1-d8gcq5ag39d847723';
const RUN_ID = 'ev' + crypto.randomBytes(4).toString('hex');

// ── 网络与子进程守卫（实际拦截并计数） ──────────────────────────────────────
const GUARD_TOTALS = { https: 0, http: 0, dns: 0, net: 0, cp: 0 };
const GUARD_PROBES = { https: 0, http: 0, dns: 0, net: 0, cp: 0 };
const GUARD_STACKS = [];
function guard(channel, mod, fnName, code) {
  const orig = mod[fnName];
  mod[fnName] = function (...args) {
    GUARD_TOTALS[channel]++;
    const e = new Error(code);
    e.code = code;
    GUARD_STACKS.push({ channel, stack: (e.stack || '').split('\n').slice(1, 4).join('\n') });
    throw e;
  };
}
const https = require('node:https');
const http = require('node:http');
const dns = require('node:dns');
const net = require('node:net');
const cp = require('node:child_process');
guard('https', https, 'request', 'EV_NET_BLOCKED');
guard('http', http, 'request', 'EV_NET_BLOCKED');
guard('dns', dns, 'lookup', 'EV_NET_BLOCKED');
guard('net', net, 'connect', 'EV_NET_BLOCKED');
guard('cp', cp, 'spawn', 'EV_CHILD_PROCESS_BLOCKED');
guard('cp', cp, 'exec', 'EV_CHILD_PROCESS_BLOCKED');
guard('cp', cp, 'execFile', 'EV_CHILD_PROCESS_BLOCKED');

// ── 断言与结果收集 ─────────────────────────────────────────────────────────
const assert = require('node:assert');
const results = [];
async function check(name, fn) {
  const startedAt = new Date().toISOString();
  try { await fn(); results.push({ name, ok: true, startedAt }); }
  catch (e) { results.push({ name, ok: false, error: String(e && e.message || e), startedAt }); }
}
function sha256Buffer(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ── 合成用户与计划 ─────────────────────────────────────────────────────────
const OPENID_OF = role => 'openid-btp-ev-' + RUN_ID + '-' + role;
const USER_ID_OF = role =>
  'u_' + crypto.createHash('sha256').update(APPID + ':' + OPENID_OF(role)).digest('hex').slice(0, 40);
const USERS = {
  owner: { userId: USER_ID_OF('owner'), source: 'synthetic' },
  manager: { userId: USER_ID_OF('manager'), source: 'synthetic' },
  worker: { userId: USER_ID_OF('worker'), source: 'synthetic' }
};
const USER_IDS = { owner: USERS.owner.userId, manager: USERS.manager.userId, worker: USERS.worker.userId };
const ROUND = 'synthetic-round-ev-' + RUN_ID;
const SYN_PROJECT = 'p_sbx_' + crypto.createHash('sha256').update(ROUND).digest('hex').slice(0, 32);

function writePlan(windowId, overrides) {
  const plan = Object.assign({
    schema: 'business-test-plan/1', window: windowId, synthetic: true,
    businessRoundId: ROUND, windowNo: windowId + '-EV1',
    appId: APPID, envId: ENV_ID,
    users: { owner: { ...USERS.owner }, manager: { ...USERS.manager }, worker: { ...USERS.worker } },
    projectReadyMarker: 'ready-' + ROUND,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
  }, overrides || {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-ev-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}
const OUT_ROOT = path.join(REPO, 'artifacts', 'schedule-sandbox', 'business-test', 'ev-' + RUN_ID);

// ── 候选服务端/前端合成加载 ────────────────────────────────────────────────
const openidByUser = {};
for (const role of ['owner', 'manager', 'worker']) openidByUser[USERS[role].userId] = OPENID_OF(role);
function seedUsers() {
  const users = {};
  for (const role of ['owner', 'manager', 'worker']) {
    users[USERS[role].userId] = { _id: USERS[role].userId, status: 'active', openid: OPENID_OF(role) };
  }
  const admins = { primary: { _id: 'primary', status: 'active', userId: USERS.owner.userId } };
  return createSandboxTestDb({ [PREFIX + 'users']: users, [PREFIX + 'app_admins']: admins });
}
function loadCandidateServer(candidateDir, db, who) {
  const serverDir = path.join(candidateDir, 'server');
  const nativeRequire = createRequire(path.join(serverDir, 'index.js'));
  const shim = {
    init() {}, DYNAMIC_CURRENT_ENV: 'candidate-test',
    getWXContext: () => ({ APPID: APPID, OPENID: openidByUser[USERS[who].userId] }),
    database() { return db; }
  };
  const source = fs.readFileSync(path.join(serverDir, 'index.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,process,console){\n${source}\n})`,
    { filename: path.join(serverDir, 'index.js') })(
    name => name === 'wx-server-sdk' ? shim : nativeRequire(name),
    mod, mod.exports, { env: { TCB_ENV: ENV_ID } }, console);
  return mod.exports.main;
}
function loadCandidatePage(candidateDir, api) {
  const base = path.join(candidateDir, 'frontend');
  const sandboxRequire = name => {
    if (name.startsWith('./') || name.startsWith('../')) {
      const p = path.resolve(base, 'pages', 'schedule-sandbox', name);
      return { config: JSON.parse(fs.readFileSync(p + '.json', 'utf8')) };
    }
    return require(name);
  };
  const src = fs.readFileSync(path.join(base, 'pages', 'schedule-sandbox', 'schedule-sandbox.js'), 'utf8');
  const pageDef = { data: {}, handlers: {} };
  const apiSink = { calls: [], async call(fn) { return fn; } };
  const App = () => {};
  const Page = def => { pageDef.handlers = def; pageDef.data = JSON.parse(JSON.stringify(def.data || {})); };
  const getApp = () => ({});
  const wx = {
    cloud: { callFunction: async req => { apiSink.calls.push(req.data); return api(req.data); } }
  };
  vm.runInThisContext(`(function(require,module,exports,Page,App,getApp,wx){\n${src}\n})`,
    { filename: path.join(base, 'pages', 'schedule-sandbox', 'schedule-sandbox.js') })(
    sandboxRequire, { exports: {} }, {}, Page, App, getApp, wx);
  const def = pageDef.handlers;
  const page = {
    data: pageDef.data,
    setData(patch) { Object.assign(this.data, patch); },
    onLoad: def.onLoad.bind(page),
    runTestCase: def.runTestCase.bind(page)
  };
  page.__apiSink = apiSink;
  return page;
}
const SCHEDULE_FORM = {
  stage: '拆改', trade: '拆改', workerUserId: USER_IDS.worker,
  startDate: '2030-01-02', endDate: '2030-01-03', expectedDate: '2030-01-03',
  restDays: [], content: '三账号合成验证'
};

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    round: '三账号独立业务测试包本地准备（仅本地实现与合成验证）',
    taskBasis: 'docs/WorkBuddy任务-三账号独立业务测试包本地准备-20261013.md',
    planBasis: 'docs/Codex方案-独立测试项目与管家师傅业务验证-20261013.md',
    implementation: {
      tool: 'miniapp/scripts/package-business-test.cjs',
      toolSha256: sha256Buffer(fs.readFileSync(path.join(REPO, 'miniapp', 'scripts', 'package-business-test.cjs'))),
      testSha256: sha256Buffer(fs.readFileSync(path.join(REPO, 'miniapp', 'tests', 'business-test-package.test.cjs')))
    },
    scopeNotes: {
      synthetic: '候选服务端/前端在 Node vm + 合成 db / 合成 wx 传输内运行（本轮全部结果属于此类）',
      sdkLocalConversion: '本仓库既有 cloudbase SDK 适配层仅被引用未触达，无平台调用',
      platformUnverified: [
        '真实云函数部署与运行行为',
        '真实 wx.cloud.callFunction 传输',
        'project-guard 云端建库/集合初始化',
        '真实微信三账号登录与会话'
      ],
      conclusion: '测试全绿不等于平台可用；云端操作未放行，真实操作须具体执行包与用户确认。'
    },
    checks: [], summary: null, guards: null
  };

  await check('S1 来源指纹：38 个受审源文件与钉定清单逐字节一致（零漂移）', () => {
    const pinned = require(path.join(REPO, 'miniapp', 'scripts', 'package-sandbox-registration.cjs')).PINNED_FACTS;
    let covered = 0;
    for (const rel of [...tool.SERVER_FILES.map(f => 'miniapp/cloudfunctions/scheduleSandbox/' + f),
      ...tool.FRONTEND_FILES.map(f => 'miniapp/miniprogram/' + f)]) {
      const p = pinned[rel];
      assert.ok(p, '钉定清单应覆盖：' + rel);
      const buf = fs.readFileSync(path.join(REPO, rel));
      assert.equal(buf.length, p.bytes, rel + ' 字节数漂移');
      assert.equal(sha256Buffer(buf), p.sha256, rel + ' 内容漂移');
      covered++;
    }
    assert.ok(covered >= 19, '覆盖文件数 ' + covered);
  });

  let built = {};
  await check('S2 三窗口候选构建：P/E/X 各 19 文件 + 19 关闭文件，checkDir 全过', () => {
    built.P = tool.build('P', writePlan('P'), path.join(OUT_ROOT, 'p'));
    built.E = tool.build('E', writePlan('E', { projectId: SYN_PROJECT }), path.join(OUT_ROOT, 'e'));
    built.X = tool.build('X', writePlan('X', { projectId: SYN_PROJECT }), path.join(OUT_ROOT, 'x'));
    for (const w of ['P', 'E', 'X']) {
      const m = JSON.parse(fs.readFileSync(path.join(built[w].outDir, 'manifest.json'), 'utf8'));
      assert.equal(m.files.length, 19, w + ' 候选 19 文件');
      assert.equal(m.closePackage.files.length, 19, w + ' 关闭 19 文件');
      assert.equal(m.window, w);
      tool.checkDir(built[w].outDir);
    }
  });

  await check('S3 变换核验：P/E 门动作收窄、E/X proof 绑定候选轮次与项目、X driver 用例仅 V06 拒绝 + V07 专用', () => {
    const gate = w => fs.readFileSync(path.join(built[w].outDir, 'server', 'gate.js'), 'utf8');
    // 各门取「可达动作块」：P 为 PREPARE_ALLOWED（phase 固定 prepare），
    // E/X 为 EXECUTE_ALLOWED（phase 固定 execute）；不可达块为公共清单，不构成窗口开放。
    const reachableBlock = w => {
      const g = gate(w);
      const name = w === 'P' ? 'PREPARE_ALLOWED' : 'EXECUTE_ALLOWED';
      const m = g.match(new RegExp('const ' + name + ' = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);'));
      assert.ok(m, w + ' 门含可达块 ' + name);
      return { block: m[1], name };
    };
    const rP = reachableBlock('P');
    for (const act of tool.P_ACTIONS) assert.ok(rP.block.includes("'" + act + "'"), 'P 门保留 ' + act);
    for (const act of ['createSchedule', 'updateSchedule', 'cancelSchedule', 'removeMember', 'reassignSchedule']) {
      assert.ok(!rP.block.includes("'" + act + "'"), 'P 准备清单不含执行期动作 ' + act);
    }
    const rE = reachableBlock('E');
    for (const act of tool.E_ACTIONS) assert.ok(rE.block.includes("'" + act + "'"), 'E 门保留 ' + act);
    for (const act of ['createProject', 'assignManager', 'createInvitation', 'approveInvitation', 'removeMember']) {
      assert.ok(!rE.block.includes("'" + act + "'"), 'E 门不含窗口外动作 ' + act);
    }
    const rX = reachableBlock('X');
    for (const act of tool.X_ACTIONS) assert.ok(rX.block.includes("'" + act + "'"), 'X 门保留 ' + act);
    for (const act of ['assignManager', 'createInvitation', 'createSchedule', 'updateSchedule', 'reassignSchedule']) {
      assert.ok(!rX.block.includes("'" + act + "'"), 'X 门不含窗口外动作 ' + act);
    }
    assert.ok(/phase 固定为 prepare/.test(gate('P')), 'P 候选 phase 固定为 prepare');
    const proofESrc = fs.readFileSync(path.join(built.E.outDir, 'frontend', 'config', 'schedule-sandbox-proof.js'), 'utf8');
    assert.ok(proofESrc.includes('roundId: ' + JSON.stringify(ROUND)), 'E proof 轮次绑定');
    const drvX = fs.readFileSync(path.join(built.X.outDir, 'frontend', 'config', 'sandbox-test-driver-proof.js'), 'utf8');
    assert.ok(drvX.includes(JSON.stringify(ROUND)), 'X driver 绑定候选轮次');
    // X driver 实际可用用例清单仅 V07：TEST_CASES 只绑定 V07_CASES，
    // V06 三对用例未进入可运行集合（运行时被 TEST_DRIVER_UNKNOWN_CASE 零发送拒绝）
    assert.ok(/const TEST_CASES = Object\.freeze\(V07_CASES\)/.test(drvX),
      'X 可运行清单只绑 V07_CASES');
    assert.ok(!/TEST_CASES[^\n]*V06_CASES/.test(drvX), 'V06 用例不得进入可运行集合');
  });

  await check('S4 roundId↔projectId 绑定反例：E 计划指向其他轮次项目 → PLAN_PROJECT_INVALID 零写', () => {
    assert.throws(() => tool.build('E', writePlan('E', {
      projectId: 'p_sbx_' + '0'.repeat(32)
    })), e => e.code === tool.ERR.PLAN_PROJECT_INVALID);
    assert.throws(() => tool.build('X', writePlan('X', {
      projectId: 'p_sbx_abcd'.padEnd(38, '0')
    })), e => e.code === tool.ERR.PLAN_PROJECT_INVALID);
  });

  await check('S5 时效与非法输入：过期窗口 PLAN_WINDOW_INVALID；未知窗口/用户形状 PLAN_INVALID，全部零写', () => {
    assert.throws(() => tool.build('P', writePlan('P', {
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T04:00:00Z'
    })), e => e.code === tool.ERR.PLAN_WINDOW_INVALID, '窗口超 2 小时上限必须拒绝');
    assert.throws(() => tool.build('Q', writePlan('P')), e => e.code === tool.ERR.PLAN_INVALID);
    assert.throws(() => tool.build('P', writePlan('P', {
      users: { owner: { userId: '', source: 'synthetic' } }
    })), e => e.code === tool.ERR.PLAN_USER_INVALID);
  });

  await check('S6 P 完整正向链（候选合成）：建项目→管家→师傅，成员/目录/安排计数吻合', async () => {
    const db = seedUsers();
    const owner = loadCandidateServer(built.P.outDir, db, 'owner');
    const manager = loadCandidateServer(built.P.outDir, db, 'manager');
    const worker = loadCandidateServer(built.P.outDir, db, 'worker');
    await owner({ action: 'identify', requestId: 's1' });
    const created = await owner({ action: 'createProject', requestId: 's2', name: '虚构测试 · 三账号' });
    assert.equal(created.ok, true, '建项目成功');
    const n = await manager({ action: 'requestBindingNumber' });
    await owner({ action: 'assignManager', projectId: created.projectId, bindingNumber: n.bindingNumber });
    const inv = await manager({ action: 'createInvitation', projectId: created.projectId, role: '师傅', trades: ['拆改'] });
    assert.equal(inv.ok, true);
    const wn = await worker({ action: 'requestBindingNumber' });
    await worker({ action: 'applyInvitation', invitationCode: inv.invitationCode });
    await manager({ action: 'approveInvitation', projectId: created.projectId, invitationId: inv.invitationId, applicantNumber: wn.bindingNumber });
    const members = Object.values(db.getPrefixedData()[PREFIX + 'project_members'] || {});
    assert.equal(members.length, 3, '三个成员');
    assert.ok(members.some(m => m.userId === USER_IDS.manager && (m.roles || []).includes('管家')), '管家角色');
    assert.ok(members.some(m => m.userId === USER_IDS.worker && (m.roles || []).includes('师傅')), '师傅角色');
  });

  await check('S7 E 完整正向链（候选合成）：安排创建→调整→取消，版本与回执一致', async () => {
    const db = seedUsers();
    const owner = loadCandidateServer(built.P.outDir, db, 'owner');
    const manager = loadCandidateServer(built.P.outDir, db, 'manager');
    const worker = loadCandidateServer(built.P.outDir, db, 'worker');
    await owner({ action: 'identify', requestId: 'e1' });
    const created = await owner({ action: 'createProject', requestId: 'e2', name: '虚构测试 · 三账号' });
    if (!created.ok) console.error('S7STEP create', JSON.stringify(created).slice(0, 200));
    assert.equal(created.ok, true, 'S7 建项目');
    const n = await manager({ action: 'requestBindingNumber' });
    const am = await owner({ action: 'assignManager', projectId: created.projectId, bindingNumber: n.bindingNumber });
    if (!am.ok) console.error('S7STEP assign', JSON.stringify(am).slice(0, 200));
    assert.equal(am.ok, true, 'S7 指派管家');
    const inv = await manager({ action: 'createInvitation', projectId: created.projectId, role: '师傅', trades: ['拆改'] });
    assert.equal(inv.ok, true, 'S7 邀请');
    const wn = await worker({ action: 'requestBindingNumber' });
    const ap = await worker({ action: 'applyInvitation', invitationCode: inv.invitationCode });
    assert.equal(ap.ok, true, 'S7 申请');
    const apv = await manager({ action: 'approveInvitation', projectId: created.projectId, invitationId: inv.invitationId, applicantNumber: wn.bindingNumber });
    if (!apv.ok) console.error('S7STEP approve', JSON.stringify(apv).slice(0, 200));
    assert.equal(apv.ok, true, 'S7 批准');
    const call = loadCandidateServer(built.E.outDir, db, 'manager');
    const s1 = await call({ action: 'createSchedule', projectId: created.projectId, requestId: 'e3', form: SCHEDULE_FORM, expectedConfirmed: true });
    assert.equal(s1.ok, true, '安排创建');
    const s2 = await call({ action: 'updateSchedule', projectId: created.projectId, requestId: 'e4', scheduleId: s1.scheduleId, expectedVersion: s1.version, reason: '合成调整', form: { ...SCHEDULE_FORM, content: '调整后' } });
    assert.equal(s2.ok, true, '安排调整');
    const c1 = await call({ action: 'cancelSchedule', projectId: created.projectId, requestId: 'e5', scheduleId: s1.scheduleId, expectedVersion: s2.version, reason: '合成取消' });
    assert.equal(c1.ok, true, '安排取消');
  });

  await check('S8 X 前端合成：V06 拒绝零发送、V07 专用驱动配置绑定候选轮次', async () => {
    const drvSrc = fs.readFileSync(path.join(built.X.outDir, 'frontend', 'utils', 'sandbox-test-driver.js'), 'utf8');
    assert.ok(drvSrc.includes('removeMember'), '专用驱动含移出');
    assert.ok(drvSrc.includes('TEST_DRIVER_UNKNOWN_CASE'), '未知用例零发送拒绝路径存在');
    const proofX = fs.readFileSync(path.join(built.X.outDir, 'frontend', 'config', 'sandbox-test-driver-proof.js'), 'utf8');
    assert.ok(proofX.includes(JSON.stringify(ROUND)), 'driver-proof 轮次绑定');
    // V06 开放用例被拒已在 S3 以可运行清单断言（dependsOn 注释字样不构成开放）
  });

  await check('S9 守卫探针：网络与真实子进程通道实际拦截并计数', () => {
    assert.throws(() => https.request('https://example.invalid'), e => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.https++;
    assert.throws(() => http.request('http://example.invalid'), e => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.http++;
    assert.throws(() => dns.lookup('example.invalid'), e => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.dns++;
    assert.throws(() => net.connect(443, 'example.invalid'), e => e.code === 'EV_NET_BLOCKED');
    GUARD_PROBES.net++;
    assert.throws(() => cp.spawn('node', ['-e', '1']), e => e.code === 'EV_CHILD_PROCESS_BLOCKED');
    GUARD_PROBES.cp++;
  });

  await check('S10 守卫汇总：业务期间意外网络/真实子进程尝试 = 0', () => {
    for (const channel of Object.keys(GUARD_TOTALS)) {
      assert.equal(GUARD_TOTALS[channel], GUARD_PROBES[channel],
        channel + '：存在业务期意外尝试');
    }
  });

  report.checks = results;
  report.summary = {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  };
  report.guards = { totals: GUARD_TOTALS, probes: GUARD_PROBES, unexpected: Object.fromEntries(
    Object.keys(GUARD_TOTALS).map(k => [k, GUARD_TOTALS[k] - GUARD_PROBES[k]])) };

  const allOk = report.summary.failed === 0;
  const out = JSON.stringify(report, null, 2);
  const outIdx = process.argv.indexOf('--out');
  if (outIdx >= 0) {
    const target = process.argv[outIdx + 1];
    if (!target || !path.isAbsolute(target)) {
      console.error('--out 须为绝对路径；未写文件。');
      process.exit(2);
    }
    let fd;
    try { fd = fs.openSync(target, 'wx'); } catch (e) {
      if (e && e.code === 'EEXIST') {
        console.error('目标已存在（' + target + '）；wx 语义拒绝覆盖，未写文件。');
        process.exit(3);
      }
      throw e;
    }
    fs.writeFileSync(fd, out, 'utf8');
    fs.closeSync(fd);
    console.log('证据已另存（wx 新建）：' + target);
  }
  console.log(out);
  process.exit(allOk ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
