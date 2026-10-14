'use strict';
// 三账号业务测试包 R1–R6 剩余出口返修 · 复核证据（2026-10-14）。
//
// 依据：docs/Codex复查-三账号业务包R1R6返修-20261014.md §3
//（R1-a / R2-a / R3-a/b/c / R4-a / R5-a / R6-a；接手参考 be993ce）。
// 性质：离线合成验证——只用合成 wx/db 与本地文件/时钟/VM；不触达 SDK、平台、凭据。
// 每组断言直接证明修复后的正确行为（正向 + 反例对照）；不改历史证据。
//
// R6-a 守卫记账口径：
// - 敏感性探针（G0）与业务期命中**分别记账**；G0 之后基线即固定，
//   业务期任何命中（**含被调用方 catch 吞掉的尝试**）都计入 unexpectedGuardAttempts
//   并使本轮验证失败（exit 1）——N8 以内存副本反例直接证明这一点；
// - 受测实现用运行时内容摘要（implementationSha256）定位，不硬编码提交号；
//   审查依据（reviewBasis）单独列出。
//
// 输出默认仅 stdout；--out 必须为不存在的新路径（wx 独占新建，不覆盖）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const guardHits = []; // 全部命中（G0 + 业务期），按阶段分别记账
const restore = [];
function guard(mod, name) {
  if (typeof mod[name] !== 'function') return;
  const old = mod[name];
  mod[name] = function () { guardHits.push(name); throw new Error('LOCAL_REVIEW_BLOCKED'); };
  restore.push(() => { mod[name] = old; });
}
for (const id of ['node:http', 'node:https']) {
  const mod = require(id); for (const name of ['request', 'get']) guard(mod, name);
}
for (const name of ['connect', 'createConnection']) guard(require('node:net'), name);
guard(require('node:net').Socket.prototype, 'connect');
guard(require('node:tls'), 'connect');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), name); guard(require('node:dns').promises, name);
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  guard(require('node:child_process'), name);
}
guard(globalThis, 'fetch');

const tool = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const registration = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));
const { createSandboxTestDb, PREFIX } = require(path.join(ROOT, 'miniapp/tests/helpers/sandbox-test-db.cjs'));
const { APPID, ENV_ID } = require(path.join(ROOT, 'miniapp/tests/helpers/sandbox-entry-loader.cjs'));

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const run = 'btpx2-' + crypto.randomUUID();
const outRoot = path.join(ROOT, 'artifacts/schedule-sandbox/business-test', run);
fs.mkdirSync(outRoot, { recursive: false });
const results = [];
let seq = 0;
let sensitivityHits = 0; // G0 敏感性探针命中（预期、单独记账）
const ROUND = 'synthetic-round-' + crypto.randomBytes(4).toString('hex');
const PROJECT = 'p_sbx_' + sha(Buffer.from(ROUND)).slice(0, 32);
const SYN_OPENID = t => 'openid-' + run + '-' + t;
const SYN_USER = t => 'u_' + sha(Buffer.from(APPID + ':' + SYN_OPENID(t))).slice(0, 40);
const ROLES = ['owner', 'manager', 'worker'];
const SYN_USERS = Object.fromEntries(ROLES.map(r => [r, {
  userId: SYN_USER(r), source: 'synthetic 夹具（不代表真实人员）'
}]));
const U = Object.fromEntries(ROLES.map(r => [r, SYN_USERS[r].userId]));
const WORKER = U.worker;
const MANAGER = U.manager;
const RECORD_DIR = path.join(outRoot, 'records');

// ── 计划构造 ────────────────────────────────────────────────────────────────
function plan(windowId, overrides = {}) {
  return {
    schema: 'business-test-plan/1', window: windowId, synthetic: true,
    businessRoundId: ROUND, windowNo: windowId + '-01',
    appId: APPID, envId: ENV_ID,
    users: Object.fromEntries(ROLES.map(r => [r, { ...SYN_USERS[r] }])),
    projectReadyMarker: 'ready-' + ROUND,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z',
    ...(windowId === 'P' ? {} : { projectId: PROJECT }),
    ...overrides
  };
}
function planFile(p) {
  const dir = path.join(outRoot, 'plans');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'plan-' + (++seq) + '.json');
  fs.writeFileSync(f, JSON.stringify(p), { flag: 'wx' });
  return f;
}
function build(windowId, p = plan(windowId), name) {
  return tool.build(windowId, planFile(p), path.join(outRoot, name));
}
function tree(dir, prefix = '') {
  if (!fs.existsSync(dir)) return {};
  const result = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (e.isDirectory()) Object.assign(result, tree(path.join(dir, e.name), rel + '/'));
    else result[rel] = sha(fs.readFileSync(path.join(dir, e.name)));
  }
  return result;
}

// ── R5-a 来源记录夹具（结构性核对控制；内容为合成夹具，不代表真实人员/回执） ──
function writeRecordFile(obj) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const f = path.join(RECORD_DIR, 'rec-' + (++seq) + '.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), { flag: 'wx' });
  return { recordPath: f, recordSha256: sha(fs.readFileSync(f)) };
}
function participantRecordFixture(role, userId, round, overrides = {}) {
  return writeRecordFile({
    schema: 'business-test-participant-record/1', synthetic: false,
    appId: APPID, envId: ENV_ID, businessRoundId: round,
    subject: { role, userId },
    capturedAt: '2026-10-14T00:00:00Z',
    content: '登记/成员查询回执原文（合成夹具，仅验证本地核对路径，不代表真实人员）',
    ...overrides
  });
}
function projectReadbackRecordFixture(round, projectId, marker, overrides = {}) {
  return writeRecordFile({
    schema: 'business-test-project-readback-record/1', synthetic: false,
    appId: APPID, envId: ENV_ID, businessRoundId: round,
    projectId, projectReadyMarker: marker,
    subject: { role: 'owner', userId: SYN_USERS.owner.userId },
    capturedAt: '2026-10-14T00:00:00Z',
    content: 'P 项目回读原文（project-guard 业务项目记录；合成夹具）',
    persistentReceipt: { recordId: 'pgrecfix' + run.slice(-8), note: '合成回执夹具' },
    ...overrides
  });
}
/** 真实计划（participant/project 记录文件齐备；窗口以运行当下为基准）。 */
function realPlan(windowId, round, opts = {}) {
  const r = round || ROUND;
  const projectId = 'p_sbx_' + sha(Buffer.from(r)).slice(0, 32);
  const p = plan(windowId, {
    synthetic: false,
    businessRoundId: r,
    projectReadyMarker: 'ready-' + r,
    windowStartsAt: new Date(Date.now() - 3600e3).toISOString(),
    windowExpiresAt: new Date(Date.now() + 3600e3).toISOString(),
    users: Object.fromEntries(ROLES.map(r2 => [r2, {
      userId: SYN_USERS[r2].userId, source: '人工声明（完整身份待用户核实）'
    }])),
    ...(windowId === 'P' ? {} : { projectId }),
    ...opts
  });
  p.participantEvidence = p.participantEvidence || Object.fromEntries(ROLES.map(r2 => {
    const fx = participantRecordFixture(r2, SYN_USERS[r2].userId, r);
    return [r2, { kind: 'readback-record', recordSha256: fx.recordSha256, recordPath: fx.recordPath }];
  }));
  if (windowId !== 'P' && !p.projectReadback) {
    const fx = projectReadbackRecordFixture(r, projectId, 'ready-' + r);
    p.projectReadback = {
      source: 'readback', projectId, businessRoundId: r,
      projectReadyMarker: 'ready-' + r, recordSha256: fx.recordSha256, recordPath: fx.recordPath
    };
  }
  return p;
}

// ── 完整链合成传输 ──────────────────────────────────────────────────────────
function loadCandidateServer(candidateDir, db, openid) {
  const serverDir = path.join(candidateDir, 'server');
  const nativeRequire = createRequire(path.join(serverDir, 'index.js'));
  const shim = {
    init() {}, DYNAMIC_CURRENT_ENV: 'candidate-test',
    getWXContext: () => ({ APPID, OPENID: openid }),
    database() { return db; }
  };
  const source = fs.readFileSync(path.join(serverDir, 'index.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,process,console){${source}\n})`)(
    name => (name === 'wx-server-sdk' ? shim : nativeRequire(name)),
    mod, mod.exports, { env: { TCB_ENV: ENV_ID } }, console);
  return mod.exports.main;
}
function makeStorage() {
  const store = {};
  return {
    getStorageSync: k => (store[k] === undefined ? '' : store[k]),
    setStorageSync: (k, v) => { store[k] = v; },
    removeStorageSync: k => { delete store[k]; },
    getStorageInfoSync: () => ({ keys: Object.keys(store) })
  };
}
function makeChainWx(candidateDir, db, role, opts = {}) {
  const storage = opts.storageShim || makeStorage();
  const calls = [];
  const openid = SYN_OPENID(role);
  const api = {
    ...storage, storage,
    getAccountInfoSync: () => ({ miniProgram: { appId: APPID, envVersion: 'develop' } }),
    cloud: {
      init() {},
      async callFunction(args) {
        calls.push(JSON.parse(JSON.stringify(args.data)));
        return { result: await loadCandidateServer(candidateDir, db, openid)(args.data) };
      }
    }
  };
  return { api, calls, storage };
}
function loadCandidatePage(candidateDir, wxApi) {
  const pagePath = path.join(candidateDir, 'frontend', 'pages/schedule-sandbox/schedule-sandbox.js');
  const pageRequire = createRequire(pagePath);
  let definition;
  vm.runInThisContext(`(function(require,Page,wx){${fs.readFileSync(pagePath, 'utf8')}\n})`)(
    name => pageRequire(name), value => { definition = value; }, wxApi);
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
function loadCandidateApp(candidateDir, wxApi) {
  const appPath = path.join(candidateDir, 'frontend', 'app.js');
  const appRequire = createRequire(appPath);
  let definition;
  vm.runInThisContext(`(function(require,App,wx){${fs.readFileSync(appPath, 'utf8')}\n})`)(
    name => appRequire(name), value => { definition = value; }, wxApi);
  const app = Object.create(definition);
  app.globalData = JSON.parse(JSON.stringify(definition.globalData || {}));
  app.onLaunch();
  return app;
}
function candidateFrontend(candidateDir, rel) {
  return createRequire(path.join(candidateDir, 'frontend', rel))(path.join(candidateDir, 'frontend', rel));
}
function seedUsers() {
  const users = {};
  for (const u of Object.values(U)) users[u] = { _id: u, status: 'active', openid: SYN_OPENID(Object.keys(U).find(k => U[k] === u)) };
  return createSandboxTestDb({
    [PREFIX + 'users']: users,
    [PREFIX + 'app_admins']: { primary: { _id: 'primary', status: 'active', userId: U.owner } }
  });
}
function clock(fn, value) {
  const old = Date.now; Date.now = typeof value === 'function' ? value : () => value;
  try { return fn(); } finally { Date.now = old; }
}

async function probe(id, fn) {
  try { const actual = await fn(); results.push({ id, assertionsPassed: true, actual }); }
  catch (e) { results.push({ id, assertionsPassed: false, error: e.message }); }
}

async function main() {
  // G0：守卫敏感性探针（实际触发；命中单独记账，不计入业务期意外）
  await probe('G0_guard_sensitivity', async () => {
    for (const fn of [
      () => require('node:https').request('https://example.invalid'),
      () => require('node:child_process').spawn('node', [])
    ]) assert.throws(fn, /LOCAL_REVIEW_BLOCKED/);
    sensitivityHits = guardHits.length;
    return { sensitivityProbeHits: sensitivityHits, note: '敏感性探针实际触发并单独记账；业务期基线自此固定' };
  });

  // N1（R1-a）：plan.json 清单条目纳入精确核对
  await probe('N1_r1a_plan_entry_verified', () => {
    const p = build('P', plan('P'), 'n1');
    const mp = path.join(p.outDir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const row = m.files.find(f => f.rel === 'plan.json');
    row.sha256 = '0'.repeat(64); row.bytes = -1;
    fs.writeFileSync(mp, JSON.stringify(m));
    const r = tool.checkDir(p.outDir);
    assert.equal(r.ok, false, '顶层 planSha256 正确不代表整条清单正确');
    assert.ok(r.problems.some(s => s.includes('plan.json') && s.includes('实际计划不符')), r.problems.join('; '));
    // 合法对照
    const ctl = build('P', plan('P'), 'n1ctl');
    assert.equal(tool.checkDir(ctl.outDir).ok, true);
    return { tamperedEntryRejected: true, controlOk: true };
  });

  // N2（R2-a）：check 逐文件读取边界与最终返回前重查时钟
  await probe('N2_r2a_check_clock_rechecks', () => {
    const r2 = 'synthetic-round-n2-' + run.slice(-8);
    const b = build('E', realPlan('E', r2), 'n2');
    const target = path.join(b.outDir, 'server', 'index.js');
    const expiresIso = JSON.parse(fs.readFileSync(path.join(b.outDir, 'plan.json'), 'utf8')).windowExpiresAt;
    const realRead = fs.readFileSync;
    let now = Date.now(), calls = 0, triggered = false;
    fs.readFileSync = function (f, ...args) {
      const rr = realRead.call(this, f, ...args);
      if (f === target) { now = Date.parse(expiresIso); triggered = true; }
      return rr;
    };
    try {
      const checked = clock(() => tool.checkDir(b.outDir), () => { calls++; return now; });
      assert.equal(triggered, true, '到期推进事件已发生');
      assert.ok(calls > 1, 'check 必须多次重读当下时钟（实测 ' + calls + ' 次）');
      assert.equal(checked.ok, false, '中途到期不得带成功结论');
      assert.ok(checked.problems.some(s => s.includes('BTP_WINDOW_EXPIRED')), checked.problems.join('; '));
      // NaN 时钟 → 不成功
      const nanChecked = clock(() => tool.checkDir(b.outDir), NaN);
      assert.equal(nanChecked.ok, false);
      assert.ok(nanChecked.problems.some(s => s.includes('BTP_CLOCK_INVALID')));
      // 正常对照 → 成功
      assert.equal(clock(() => tool.checkDir(b.outDir), Date.now()).ok, true, '正常对照 check 通过');
      return { midCheckExpiryRejected: true, dateNowCalls: calls, nanRejected: true, controlOk: true };
    } finally { fs.readFileSync = realRead; }
  });

  // N3（R3-a）：目录占位/多余目录预检拒绝且全树快照不变、零写
  await probe('N3_r3a_dir_placeholder_and_extra', () => {
    const dirConflict = path.join(outRoot, 'n3-dirconflict');
    fs.mkdirSync(path.join(dirConflict, 'manifest.json'), { recursive: true });
    const before = JSON.stringify(tree(dirConflict)) + '|' + fs.readdirSync(dirConflict).join(',');
    let err = null;
    try { tool.build('P', planFile(plan('P')), dirConflict); } catch (e) { err = e; }
    assert.equal(err && err.code, 'BTP_OUT_CONFLICT');
    const after = JSON.stringify(tree(dirConflict)) + '|' + fs.readdirSync(dirConflict).join(',');
    assert.equal(after, before, '预检冲突：全树快照不变');
    assert.equal(err.wroteFiles, undefined, '预检失败零写');
    // 多余目录
    const extraDir = path.join(outRoot, 'n3-extradir');
    fs.mkdirSync(path.join(extraDir, 'unrelated', 'nested'), { recursive: true });
    err = null;
    try { tool.build('P', planFile(plan('P')), extraDir); } catch (e) { err = e; }
    assert.equal(err && err.code, 'BTP_OUT_CONFLICT', '多余目录预检拒绝');
    assert.deepEqual(fs.readdirSync(extraDir), ['unrelated'], '不清理用户目录');
    return { dirPlaceholderRejected: 'BTP_OUT_CONFLICT(全树快照不变,零写)', extraDirRejected: true, noCleanup: true };
  });

  // N4（R3-b）：输出根 junction/链接绕过 → 拒绝；检查入口不认领
  await probe('N4_r3b_root_junction_rejected', () => {
    const target = path.join(outRoot, '..', 'n4-junction-target-' + crypto.randomBytes(3).toString('hex'));
    fs.mkdirSync(target, { recursive: false });
    const link = path.join(outRoot, 'n4-linked-output');
    fs.symlinkSync(target, link, 'junction');
    let err = null;
    try { tool.build('P', planFile(plan('P')), link); } catch (e) { err = e; }
    assert.equal(err && err.code, 'BTP_OUT_CONFLICT', 'junction 输出根拒绝：' + (err && err.message));
    assert.equal(fs.readdirSync(target).length, 0, 'junction 目标零写');
    assert.throws(() => tool.checkDir(link), e => e.code === 'BTP_OUT_CONFLICT', 'check 不认领 junction 目录');
    assert.throws(() => tool.checkCloseDir(link), e => e.code === 'BTP_OUT_CONFLICT', 'check-close 不认领 junction 目录');
    return { rootJunctionRejected: true, targetFilesAfter: 0, checkAndCheckCloseRefuse: true };
  });

  // N5（R3-c）：部分写副作用事实 + 竞态 EEXIST 不算本轮写入
  await probe('N5_r3c_write_side_effects', () => {
    // 部分写：首个文件排他创建并写入 7 字节后 EIO
    const partialDir = path.join(outRoot, 'n5-partial');
    const pf = planFile(plan('P'));
    const realWrite = fs.writeFileSync;
    let err = null;
    fs.writeFileSync = function (f, buf, o) {
      if (typeof f === 'string' && f.endsWith('server' + path.sep + 'index.js')) {
        realWrite.call(this, f, Buffer.from(buf).subarray(0, 7), o);
        const e = new Error('synthetic partial write'); e.code = 'EIO'; throw e;
      }
      return realWrite.call(this, f, buf, o);
    };
    try { tool.build('P', pf, partialDir); } catch (e) { err = e; } finally { fs.writeFileSync = realWrite; }
    assert.equal(err && err.code, 'EIO');
    assert.equal(err.wroteFiles, 1, '部分写副作用必须计入 wroteFiles');
    assert.deepEqual(err.written, ['server/index.js']);
    assert.equal(fs.statSync(path.join(partialDir, 'server', 'index.js')).size, 7);
    // 竞态 EEXIST：他人抢先创建 → 不算本轮写入、不覆盖不删除
    const raceDir = path.join(outRoot, 'n5-race');
    err = null;
    fs.writeFileSync = function (f, buf, o) {
      if (typeof f === 'string' && f.endsWith('server' + path.sep + 'gate.js')) {
        realWrite.call(this, f, Buffer.from('other-writer'), o);
        const e = new Error('EEXIST race'); e.code = 'EEXIST'; throw e;
      }
      return realWrite.call(this, f, buf, o);
    };
    try { tool.build('P', planFile(plan('P')), raceDir); } catch (e) { err = e; } finally { fs.writeFileSync = realWrite; }
    assert.equal(err && err.code, 'EEXIST');
    assert.ok(!err.written || !err.written.includes('server/gate.js'), '他人 EEXIST 文件不算本轮写入');
    assert.equal(fs.readFileSync(path.join(raceDir, 'server', 'gate.js'), 'utf8'), 'other-writer', '不覆盖他人文件');
    return {
      partialWrite: { wroteFiles: 1, written: err ? null : ['server/index.js'], bytesOnDisk: 7 },
      raceEexist: { notCounted: true, notOverwritten: true, sideEffect: (err && err.sideEffect) || null }
    };
  });

  // N6（R4-a）：关闭包受审装配 + checkCloseDir 独立重建 + 关闭链禁用零发送
  await probe('N6_r4a_close_assembly_and_closed_chain', async () => {
    const p = build('P', plan('P'), 'n6');
    const close = path.join(p.outDir, 'close');
    const cfg = JSON.parse(fs.readFileSync(path.join(close, 'project.config.json'), 'utf8'));
    assert.equal(cfg.miniprogramRoot, 'frontend/');
    assert.equal(cfg.cloudfunctionRoot, 'server/');
    const appJson = JSON.parse(fs.readFileSync(path.join(close, 'frontend', 'app.json'), 'utf8'));
    assert.deepEqual(appJson.pages, ['pages/schedule-sandbox/schedule-sandbox'], '关闭包唯一页面');
    for (const page of appJson.pages) {
      for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
        assert.equal(fs.existsSync(path.join(close, 'frontend', page + ext)), true, page + ext);
      }
    }
    // 独立重建核对（不读 manifest/计划/时钟）
    const closeOk = tool.checkCloseDir(p.outDir);
    assert.equal(closeOk.ok, true, closeOk.problems.join('; '));
    assert.equal(closeOk.files, 23);
    // 篡改关闭装配 → 独立重建拒绝
    const closeApp = path.join(close, 'frontend', 'app.json');
    const original = fs.readFileSync(closeApp);
    fs.writeFileSync(closeApp, original.toString('utf8').replace(
      '"pages": [\n    "pages/schedule-sandbox/schedule-sandbox"\n  ]',
      '"pages": [\n    "pages/index/index",\n    "pages/schedule-sandbox/schedule-sandbox"\n  ]'));
    const broken = tool.checkCloseDir(p.outDir);
    assert.equal(broken.ok, false);
    assert.ok(broken.problems.some(s => s.includes('app.json')));
    fs.writeFileSync(closeApp, original);
    assert.equal(tool.checkCloseDir(p.outDir).ok, true, '还原后恢复');
    // 关闭链：App/Page 加载、入口禁用、驱动零发送、服务端 SANDBOX_DISABLED；不依赖期限（NaN 时钟仍成立）
    const db = seedUsers();
    const { api, calls } = makeChainWx(close, db, 'manager');
    const app = loadCandidateApp(close, api);
    assert.ok(app.globalData, '关闭 App 壳可加载');
    const page = loadCandidatePage(close, api);
    page.onLoad();
    assert.equal(page.data.entryAllowed, false, '关闭包入口禁用');
    await page.runAction('identify');
    assert.ok(page.data.lastError, '禁用态动作被拒：' + page.data.lastError);
    const callsAfterPage = calls.length;
    const driver = candidateFrontend(close, 'utils/sandbox-test-driver.js');
    const blocked = await driver.runCase({ api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: WORKER } });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'TEST_DRIVER_GATE_BLOCKED');
    assert.equal(blocked.report.sent, 0, '关闭驱动零发送');
    assert.equal(calls.length, callsAfterPage, '关闭态零发送');
    const srv = loadCandidateServer(close, db, SYN_OPENID('owner'));
    const denied = await srv({ action: 'identify', requestId: 'n6-closed-1' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'SANDBOX_DISABLED');
    assert.equal(clock(() => tool.checkCloseDir(p.outDir), NaN).ok, true, '关闭核对与时钟无关');
    return {
      closeRoots: [cfg.miniprogramRoot, cfg.cloudfunctionRoot],
      closePages: appJson.pages, closeFiles: closeOk.files,
      tamperRejected: true, closedChain: { appLoaded: true, entryAllowed: false, driverSent: 0, serverCode: 'SANDBOX_DISABLED' },
      clockIndependent: true
    };
  });

  // N7（R5-a）：真实模式核对实际记录文件（缺文件/摘要不符/合成标记/身份不符/缺回执/项目不符全拒绝）
  await probe('N7_r5a_record_verification', () => {
    const r7 = 'synthetic-round-n7-' + run.slice(-8);
    // 合法对照：E 真实模式（记录文件齐备）→ 接受且绑定记录路径
    const parsed = tool.readPlan(planFile(realPlan('E', r7)), 'E');
    assert.equal(parsed.evidenceBound, true);
    assert.equal(parsed.users.every(u => u.evidence && u.evidence.recordPath), true);
    assert.equal(parsed.projectReadback.recordPath !== null, true);
    // 反例 1：kind+64hex 无记录文件
    assert.throws(() => tool.readPlan(planFile(realPlan('P', r7, {
      participantEvidence: Object.fromEntries(ROLES.map(r =>
        [r, { kind: 'readback-record', recordSha256: 'a'.repeat(64) }]))
    })), 'P'), e => e.code === 'BTP_PLAN_USER_INVALID' && /recordPath/.test(e.message));
    // 反例 2：记录文件不存在
    assert.throws(() => tool.readPlan(planFile(realPlan('P', r7, {
      participantEvidence: Object.fromEntries(ROLES.map(r =>
        [r, { kind: 'readback-record', recordSha256: 'a'.repeat(64), recordPath: path.join(RECORD_DIR, 'missing-' + r + '.json') }]))
    })), 'P'), e => e.code === 'BTP_PLAN_USER_INVALID');
    // 反例 3：摘要与记录内容不符
    assert.throws(() => tool.readPlan(planFile((() => {
      const p = realPlan('P', r7);
      for (const k of ROLES) p.participantEvidence[k].recordSha256 = 'b'.repeat(64);
      return p;
    })()), 'P'), e => e.code === 'BTP_PLAN_USER_INVALID' && /摘要/.test(e.message));
    // 反例 4：记录标记 synthetic=true
    assert.throws(() => tool.readPlan(planFile((() => {
      const p = realPlan('P', r7);
      for (const k of ROLES) {
        const fx = participantRecordFixture(k, SYN_USERS[k].userId, r7, { synthetic: true });
        p.participantEvidence[k] = { kind: 'readback-record', recordSha256: fx.recordSha256, recordPath: fx.recordPath };
      }
      return p;
    })()), 'P'), e => e.code === 'BTP_PLAN_USER_INVALID' && /合成/.test(e.message));
    // 反例 5：记录身份与计划账号不一致（冒用他人记录）
    assert.throws(() => tool.readPlan(planFile((() => {
      const p = realPlan('P', r7);
      for (const k of ROLES) {
        const other = k === 'owner' ? U.manager : U.owner;
        const fx = participantRecordFixture(k, other, r7);
        p.participantEvidence[k] = { kind: 'readback-record', recordSha256: fx.recordSha256, recordPath: fx.recordPath };
      }
      return p;
    })()), 'P'), e => e.code === 'BTP_PLAN_USER_INVALID' && /身份\/角色/.test(e.message));
    // 反例 6：P 回读记录缺持久回执
    const noReceipt = projectReadbackRecordFixture(r7, 'p_sbx_' + sha(Buffer.from(r7)).slice(0, 32), 'ready-' + r7);
    const obj = JSON.parse(fs.readFileSync(noReceipt.recordPath, 'utf8'));
    delete obj.persistentReceipt;
    fs.writeFileSync(noReceipt.recordPath, JSON.stringify(obj, null, 2));
    noReceipt.recordSha256 = sha(fs.readFileSync(noReceipt.recordPath));
    assert.throws(() => tool.readPlan(planFile((() => {
      const p = realPlan('E', r7);
      p.projectReadback = {
        source: 'readback', projectId: p.projectId, businessRoundId: r7,
        projectReadyMarker: 'ready-' + r7, recordSha256: noReceipt.recordSha256, recordPath: noReceipt.recordPath
      };
      return p;
    })()), 'E'), e => e.code === 'BTP_PLAN_PROJECT_INVALID' && /persistentReceipt|持久回执/.test(e.message));
    // 反例 7：P 回读记录 projectId 与计划不一致
    const wrongProj = projectReadbackRecordFixture(r7, 'p_sbx_' + '0'.repeat(32), 'ready-' + r7);
    assert.throws(() => tool.readPlan(planFile((() => {
      const p = realPlan('E', r7);
      p.projectReadback = {
        source: 'readback', projectId: p.projectId, businessRoundId: r7,
        projectReadyMarker: 'ready-' + r7, recordSha256: wrongProj.recordSha256, recordPath: wrongProj.recordPath
      };
      return p;
    })()), 'E'), e => e.code === 'BTP_PLAN_PROJECT_INVALID' && /projectId/.test(e.message));
    // 合成模式保持：无记录文件仍可构建
    const syn = build('P', plan('P'), 'n7syn');
    assert.equal(syn.manifest.synthetic, true);
    return {
      legalControlAccepted: true,
      rejected: ['noRecordPath', 'missingFile', 'digestMismatch', 'syntheticMarked', 'subjectMismatch', 'missingReceipt', 'projectIdMismatch'],
      syntheticModeUnchanged: true
    };
  });

  // N8（R6-a）：反例——被 catch 的意外尝试也计数并使验证失败（内存副本，不改磁盘历史）
  await probe('N8_r6a_caught_attempt_counted', async () => {
    const ep = path.join(__dirname, path.basename(__filename));
    const src = fs.readFileSync(ep, 'utf8');
    // 锚点用拼接构造，避免本文件源码自身包含锚点文本
    const P1 = 'await probe' + "('N1_";
    const P8 = 'await probe' + "('N8_";
    const a1 = '  ' + P1;
    const a8 = '  ' + P8;
    assert.equal(src.split(a1).length, 2, 'N1 锚点唯一');
    assert.equal(src.split(a8).length, 2, 'N8 锚点唯一');
    const changed = src
      // 在业务期（N1 前）注入一次会被自身 guard 拦截并被 catch 吞掉的尝试
      .replace(a1, "  try { require('node:https').get('https://example.invalid'); } catch (_) {} // 注入：被捕获的意外尝试\n" + a1)
      // 副本跳过 N8（避免递归），直接出报告
      .replace(a8, '  return emitReport(); // 副本跳过 N8\n' + a8);
    let stdout = '', exitCode = 0;
    const fakeProcess = {
      argv: ['node', ep],
      stdout: { write: s => { stdout += s; } },
      get exitCode() { return exitCode; }, set exitCode(v) { exitCode = v; }
    };
    const runCopy = vm.runInThisContext(
      '(async function(require,__dirname,process,console){' + changed + '\n})',
      { filename: ep + '#counterexample' });
    const copyErrors = [];
    // 注意：包装函数在同步体结束（仅调度 main()）时即 resolve，
    // 不能直接 await 它当作完成信号——必须轮询等待副本报告写出。
    await runCopy(createRequire(ep), __dirname, fakeProcess, { error: m => copyErrors.push(String((m && m.message) || m)) });
    const deadline = Date.now() + 60000;
    while (!stdout.includes('"guardAccounting"') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    if (!stdout.includes('"guardAccounting"')) {
      throw new Error('副本 60s 内未产出报告 stdout=' + stdout.length + ' exitCode=' + exitCode + ' errors=' + JSON.stringify(copyErrors));
    }
    const report = JSON.parse(stdout);
    assert.equal(report.summary.unexpectedGuardAttempts, 1, '被 catch 的意外尝试必须计数');
    assert.equal(exitCode, 1, '意外尝试必须使验证失败');
    assert.equal(report.guardAccounting.sensitivityProbeHits, 2);
    return {
      injectedCaughtAttempt: 1,
      copyReportedUnexpected: report.summary.unexpectedGuardAttempts,
      copyExitCode: exitCode,
      copyGuardAccounting: report.guardAccounting
    };
  });

  // N9：控制组——完整 48 文件、续建补 1 复用 47、过期真实构建零写、关闭核对与时钟无关、模式篡改拒绝
  await probe('N9_closed_controls', () => {
    const p = build('P', plan('P'), 'n9');
    assert.equal(Object.keys(tree(p.outDir)).length, 48, '候选 23+plan.json+关闭 23+manifest.json');
    assert.equal(p.manifest.files.length, 24);
    assert.equal(p.manifest.closePackage.files.length, 23);
    // 续建
    const snap = tree(p.outDir);
    fs.unlinkSync(path.join(p.outDir, p.manifest.closePackage.files[0].rel));
    const b2 = tool.build('P', planFile(plan('P')), p.outDir);
    assert.equal(b2.io.filter(x => x.action === 'written').length, 1);
    assert.equal(b2.io.filter(x => x.action === 'reused').length, 47);
    assert.deepEqual(tree(p.outDir), snap);
    assert.equal(tool.checkDir(p.outDir).ok, true);
    // 过期真实构建：目录未创建、零写
    const rp = realPlan('P');
    rp.windowStartsAt = new Date(Date.now() - 7200e3).toISOString();
    rp.windowExpiresAt = new Date(Date.now() - 3600e3).toISOString();
    const out = path.join(outRoot, 'n9-expired');
    let err = null;
    try { tool.build('P', planFile(rp), out); } catch (e) { err = e; }
    assert.equal(err && err.code, 'BTP_WINDOW_EXPIRED');
    assert.equal(fs.existsSync(out), false);
    // 模式篡改拒绝
    const mp = path.join(p.outDir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.synthetic = false;
    fs.writeFileSync(mp, JSON.stringify(m));
    assert.equal(tool.checkDir(p.outDir).ok, false);
    return { filesOnDisk: 48, manifestEntries: 24, resume: { written: 1, reused: 47 }, expiredBuild: 'BTP_WINDOW_EXPIRED(目录未创建)', modeFlipRejected: true };
  });

  emitReport();
}

function emitReport() {
  // R6-a：业务期意外 = G0 敏感性探针之后的一切命中（含被捕获吞掉的尝试）
  const businessUnexpected = guardHits.length - sensitivityHits;
  const report = {
    generatedAt: new Date().toISOString(),
    implementationSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'))),
    implementationPath: 'miniapp/scripts/package-business-test.cjs',
    reviewBasis: 'docs/Codex复查-三账号业务包R1R6返修-20261014.md §3（R1-a/R2-a/R3-a/b/c/R4-a/R5-a/R6-a；接手参考 be993ce）',
    artifactDirectory: path.relative(ROOT, outRoot).replaceAll('\\', '/'),
    verificationKind: 'offline synthetic verification; no SDK/platform/credentials; SDK local transform NOT executed',
    terminologyNote: 'project-guard 创建业务项目记录不等于创建数据库/集合；集合初始化未执行；R5-a 记录核对为本地结构/绑定核对，不替代平台侧核验',
    results,
    guardAccounting: {
      sensitivityProbeHits: sensitivityHits,
      businessPeriodUnexpectedAttempts: businessUnexpected,
      caughtAttemptsCounted: true,
      note: '敏感性与业务期命中分别记账；业务期命中含被调用方捕获的尝试（N8 反例直接证明）'
    },
    summary: {
      total: results.length,
      assertionsPassed: results.filter(r => r.assertionsPassed).length,
      unexpectedGuardAttempts: businessUnexpected
    }
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  const args = process.argv.slice(2);
  if (args.length) {
    assert.equal(args.length, 2); assert.equal(args[0], '--out');
    fs.writeFileSync(path.resolve(args[1]), json, { flag: 'wx' });
    console.error('已写入：' + args[1]);
  }
  process.stdout.write(json);
  if (results.some(r => !r.assertionsPassed) || businessUnexpected !== 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
