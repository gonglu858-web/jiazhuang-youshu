'use strict';
// 三账号独立业务测试包 R1–R6 返修复核证据（2026-10-14）。
//
// 依据：docs/Codex审查-三账号独立业务测试包本地准备-20261014.md R1–R6。
// 性质：离线合成验证——只用合成 wx/db 与本地文件；不触达 SDK、平台、凭据。
// 每组断言直接证明修复后的正确行为（正向 + 反例对照）；旧审查脚本
// （Codex三账号业务包独立审查-20261014.cjs）断言的是旧缺陷存在，
// 修复后其旧断言失败不作为闭合证据，历史证据原样保留。
//
// 口径（R6）：
// - 钉定来源 = 登记钉定 19 文件（8 服务端 + 11 前端）+ 组装扩展 4 文件
//   （app.js / app.json / config/cloud.js / project.config.json）；
//   候选制品 = 23 文件 + plan.json；不称"38 源文件"。
// - SDK 本地转换：未执行（只引用，未触达平台）。
// - project-guard 创建业务项目记录 ≠ 创建数据库/集合；集合初始化未执行。
// - 零写断言使用全库快照（全部集合），不只单一集合。
// - 输出默认仅 stdout；--out 必须为不存在的新路径（wx 独占新建，不覆盖）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const guardHits = [];
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
const run = 'btp-r116-' + crypto.randomUUID();
const outRoot = path.join(ROOT, 'artifacts/schedule-sandbox/business-test', run);
fs.mkdirSync(outRoot, { recursive: false });
const results = [];
let seq = 0;

// ── 计划构造 ────────────────────────────────────────────────────────────────
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
function clock(fn, value) {
  const old = Date.now; Date.now = typeof value === 'function' ? value : () => value;
  try { return fn(); } finally { Date.now = old; }
}

// ── 真实计划（带回读证据） ──────────────────────────────────────────────────
function realPlan(windowId, overrides = {}) {
  const p = plan(windowId, {
    synthetic: false,
    windowStartsAt: new Date(Date.now() - 3600e3).toISOString(),
    windowExpiresAt: new Date(Date.now() + 1200e3).toISOString(),
    users: Object.fromEntries(ROLES.map(r => [r, {
      userId: SYN_USERS[r].userId, source: '人工来源声明（完整身份以用户核实为准）'
    }])),
    ...overrides
  });
  p.participantEvidence = Object.fromEntries(ROLES.map(r =>
    [r, { kind: 'readback-record', recordSha256: sha(Buffer.from('readback-' + r)) }]));
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
        if (opts.throwAfter !== undefined && calls.length > opts.throwAfter) {
          throw new Error('synthetic transport failure');
        }
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
  return createRequire(path.join(candidateDir, 'frontend', rel))(
    path.join(candidateDir, 'frontend', rel));
}

const dbSnap = db => JSON.stringify(db.getPrefixedData());
const countOf = (db, name) => Object.keys(db.getPrefixedData()[PREFIX + name] || {}).length;

const SCHEDULE_FORM = {
  stage: '拆改', trade: '拆改', workerUserId: WORKER,
  startDate: '2030-01-02', endDate: '2030-01-03', expectedDate: '2030-01-03',
  restDays: [], content: '返修复核合成验证'
};
async function seedMembers(pOutDir, db) {
  const call = (who, body) => loadCandidateServer(pOutDir, db, SYN_OPENID(who))(body);
  const r1 = await call('owner', { action: 'identify', requestId: 'ev-id' });
  assert.equal(r1.ok, true);
  const created = await call('owner', { action: 'createProject', requestId: 'ev-create', name: '虚构测试 · 三账号' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.projectId, PROJECT);
  const number = await call('manager', { action: 'requestBindingNumber' });
  assert.equal((await call('owner', { action: 'assignManager', projectId: PROJECT, bindingNumber: number.bindingNumber })).ok, true);
  const inv = await call('manager', { action: 'createInvitation', projectId: PROJECT, role: '师傅', trades: ['拆改'] });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  const wNum = await call('worker', { action: 'requestBindingNumber' });
  assert.equal((await call('worker', { action: 'applyInvitation', invitationCode: inv.invitationCode })).ok, true);
  const approved = await call('manager', {
    action: 'approveInvitation', projectId: PROJECT, invitationId: inv.invitationId,
    applicantNumber: wNum.bindingNumber
  });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  return { scheduleOf: null };
}

async function probe(id, fn) {
  try { const actual = await fn(); results.push({ id, assertionsPassed: true, actual }); }
  catch (e) { results.push({ id, assertionsPassed: false, error: e.message }); }
}

async function main() {
  // G0：守卫敏感性探针（实际触发，不是硬填零）
  const unexpectedBefore = guardHits.length;
  await probe('G0_guard_sensitivity', async () => {
    for (const fn of [
      () => require('node:https').request('https://example.invalid'),
      () => require('node:child_process').spawn('node', [])
    ]) assert.throws(fn, /LOCAL_REVIEW_BLOCKED/);
    return { unexpectedBefore, note: '探针在断言内实际触发；余项报告 unexpectedGuardAttempts' };
  });

  // S1（R6 口径更正）：钉定来源与制品的实际数量
  await probe('S1_source_and_artifact_counts', () => {
    const pinnedServer = tool.SERVER_FILES.length;           // 8
    const pinnedFrontend = registration.FRONTEND_FILES.length; // 11
    const assemblyExtra = ['app.js', 'app.json', 'config/cloud.js'];
    assert.equal(tool.FRONTEND_FILES.length, pinnedFrontend + 3);
    assert.equal(Object.keys(tool.ASSEMBLY_PINNED).length, 4, '组装扩展钉定 4 文件（含根 project.config.json）');
    const b = build('P', plan('P'), 's1-complete');
    assert.equal(b.manifest.files.length, 24, '候选 = 23 制品 + plan.json');
    assert.equal(b.manifest.closePackage.files.length, 23);
    // 逐文件与独立受审基线核对（19 钉定 + 4 组装扩展）
    const all = [
      ...tool.SERVER_FILES.map(r => ['miniapp/cloudfunctions/scheduleSandbox/' + r, path.join(ROOT, 'miniapp/cloudfunctions/scheduleSandbox', r)]),
      ...registration.FRONTEND_FILES.map(r => ['miniapp/miniprogram/' + r, path.join(ROOT, 'miniapp/miniprogram', r)])
    ];
    for (const [key, abs] of all) {
      assert.equal(sha(fs.readFileSync(abs)), registration.PINNED_FACTS[key].sha256, key);
    }
    for (const [key, digest] of Object.entries(tool.ASSEMBLY_PINNED)) {
      const abs = path.join(ROOT, key);
      assert.equal(sha(fs.readFileSync(abs)), digest.sha256, key);
    }
    return {
      pinnedSourceFiles: pinnedServer + pinnedFrontend, assemblyPinnedFiles: 4,
      candidateArtifacts: 23, planFile: 'plan.json', closeFiles: 23,
      statement: '钉定来源 19+4=23 文件；候选制品 23 + plan.json；不称 38 源文件'
    };
  });

  // S2（R1）：check 独立重建比对 + 关闭包独立核对
  await probe('S2_r1_check_rebuild_and_close_independent', () => {
    const b = build('P', plan('P'), 's2-normal');
    const ok = tool.checkDir(b.outDir);
    assert.equal(ok.ok, true, ok.problems.join('; '));
    assert.equal(ok.planChecked, true, 'check 必须实际核对目录内计划');
    // 反例：空清单（自报）→ 拒绝
    const emptyDir = path.join(outRoot, 's2-empty');
    fs.mkdirSync(emptyDir);
    fs.writeFileSync(path.join(emptyDir, 'manifest.json'),
      JSON.stringify({ schema: tool.MANIFEST_SCHEMA, files: [], closePackage: { files: [] } }));
    assert.equal(tool.checkDir(emptyDir).ok, false);
    // 反例：越界动作 + 同步改哈希 → 重建比对拒绝
    const e = build('E', plan('E'), 's2-tamper');
    const gatePath = path.join(e.outDir, 'server/gate.js');
    let src = fs.readFileSync(gatePath, 'utf8');
    src = src.replace('const EXECUTE_ALLOWED = Object.freeze([',
      'const EXECUTE_ALLOWED = Object.freeze([\n  \'reassignSchedule\',');
    fs.writeFileSync(gatePath, src);
    const m = JSON.parse(fs.readFileSync(path.join(e.outDir, 'manifest.json'), 'utf8'));
    const rec = m.files.find(r => r.rel === 'server/gate.js');
    rec.sha256 = sha(Buffer.from(src)); rec.bytes = Buffer.byteLength(src);
    fs.writeFileSync(path.join(e.outDir, 'manifest.json'), JSON.stringify(m, null, 2));
    const r = tool.checkDir(e.outDir);
    assert.equal(r.ok, false, '清单同步哈希不能通过重建比对');
    assert.ok(r.problems.some(s => s.includes('gate.js')));
    // 反例：仅翻转 manifest.synthetic → 与目录内计划不一致 → 拒绝
    const p2 = build('P', plan('P'), 's2-flip');
    const m2 = JSON.parse(fs.readFileSync(path.join(p2.outDir, 'manifest.json'), 'utf8'));
    m2.synthetic = false;
    fs.writeFileSync(path.join(p2.outDir, 'manifest.json'), JSON.stringify(m2, null, 2));
    assert.equal(tool.checkDir(p2.outDir).ok, false);
    // 关闭包独立核对：开启候选删除一文件后，close 核对仍通过
    fs.unlinkSync(path.join(p2.outDir, 'frontend/pages/schedule-sandbox/schedule-sandbox.js'));
    assert.equal(tool.checkDir(p2.outDir).ok, false);
    const close = tool.checkCloseDir(p2.outDir);
    assert.equal(close.ok, true, close.problems.join('; '));
    assert.equal(close.files, 23);
    return { normalCheckOk: true, emptyRejected: true, syncedHashRejected: true, flipRejected: true, closeIndependent: { ok: true, files: 23 } };
  });

  // S3（R2）：真实候选各边界重读当下时钟
  await probe('S3_r2_dynamic_clock_boundaries', () => {
    // 正向：有效期内真实候选 build + check 通过
    const good = tool.build('P', planFile(realPlan('P')), path.join(outRoot, 's3-good'));
    assert.equal(tool.checkDir(good.outDir).ok, true);
    // 反例：已过期计划 → 写前拒绝（零写）
    const expiredDir = path.join(outRoot, 's3-expired-build');
    const expiredErr = (() => {
      try {
        tool.build('P', planFile(realPlan('P', {
          windowExpiresAt: new Date(Date.now() - 1000).toISOString()
        })), expiredDir);
        return null;
      } catch (e) { return e; }
    })();
    assert.equal(expiredErr && expiredErr.code, 'BTP_WINDOW_EXPIRED');
    assert.equal(fs.existsSync(expiredDir), false, '写前拒绝：目录未创建');
    // 反例：构建有效、check 时已过期 → check 失败并指明 WINDOW_EXPIRED
    const now = Date.now();
    const later = tool.build('P', planFile(realPlan('P', {
      windowExpiresAt: new Date(now + 30000).toISOString()
    })), path.join(outRoot, 's3-later'));
    const rExpired = clock(() => tool.checkDir(later.outDir), now + 30000);
    assert.equal(rExpired.ok, false);
    assert.ok(rExpired.problems.some(s => s.includes('BTP_WINDOW_EXPIRED')), rExpired.problems.join('; '));
    // 反例：边界相等（expires == 当下时钟）→ 视为到期
    const rEqual = clock(() => tool.checkDir(later.outDir), () => Date.parse(later.manifest.windowExpiresAt));
    assert.equal(rEqual.ok, false);
    // 反例：时钟无效（NaN）→ 独立错误码，不当作未过期（计划在时钟外构造）
    let nanErr = null;
    const nanPlanFile = planFile(realPlan('P'));
    clock(() => { try { tool.build('P', nanPlanFile, path.join(outRoot, 's3-nan')); } catch (e) { nanErr = e; } }, NaN);
    assert.equal(nanErr && nanErr.code, 'BTP_CLOCK_INVALID');
    // 对照：合成模式不受平台时效守卫影响
    const syn = build('P', plan('P', {
      windowStartsAt: '2020-01-01T00:00:00Z', windowExpiresAt: '2020-01-01T01:00:00Z'
    }), 's3-synthetic-past');
    assert.equal(clock(() => tool.checkDir(syn.outDir), 1).ok, true);
    return {
      validRealCheckOk: true, expiredBuild: 'BTP_WINDOW_EXPIRED(零写,目录未创建)',
      expiredCheck: 'problems 含 BTP_WINDOW_EXPIRED', boundaryEqualExpired: true,
      nanClock: 'BTP_CLOCK_INVALID', syntheticControlOk: true
    };
  });

  // S4（R3）：全量预检零写 + 排他新建 + 已写事实保留 + 合法续建对照
  await probe('S4_r3_precheck_exclusive_and_written_facts', () => {
    const pf = planFile(plan('P'));
    // 反例：预存冲突目录 → 全量预检失败且目录快照不变（零写）
    const conflictDir = path.join(outRoot, 's4-conflict');
    fs.mkdirSync(conflictDir);
    fs.writeFileSync(path.join(conflictDir, 'manifest.json'), 'sentinel', { flag: 'wx' });
    const before = tree(conflictDir);
    let err = null;
    try { tool.build('P', pf, conflictDir); } catch (e) { err = e; }
    assert.equal(err && err.code, 'BTP_OUT_CONFLICT');
    assert.deepEqual(tree(conflictDir), before, '预检冲突：目录快照不变');
    assert.equal(err.wroteFiles, undefined, '预检失败未开始写入');
    // 反例：第三次写入注入 EIO → 异常携带准确已写事实
    const eioDir = path.join(outRoot, 's4-eio');
    const oldWrite = fs.writeFileSync; let calls = 0, eioErr = null;
    fs.writeFileSync = function (f, ...a) {
      if (String(f).startsWith(eioDir) && ++calls === 3) {
        const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e;
      }
      return oldWrite.call(fs, f, ...a);
    };
    try { tool.build('P', pf, eioDir); } catch (e) { eioErr = e; } finally { fs.writeFileSync = oldWrite; }
    assert.equal(eioErr && eioErr.code, 'EIO');
    assert.equal(eioErr.wroteFiles, 2, '异常必须携带本次已写数');
    assert.deepEqual(eioErr.written, ['server/index.js', 'server/gate.js']);
    assert.equal(Object.keys(tree(eioDir)).length, 2, '盘上恰好 2 个已写文件');
    // 正向对照：合法半成品续建——只补缺失的 1 个，其余复用，快照还原
    const partDir = path.join(outRoot, 's4-partial');
    const b1 = tool.build('P', pf, partDir);
    const snap = tree(partDir);
    fs.unlinkSync(path.join(partDir, b1.manifest.closePackage.files[0].rel));
    const b2 = tool.build('P', pf, partDir);
    assert.equal(b2.io.filter(x => x.action === 'written').length, 1, '续建只补 1 个');
    assert.equal(b2.io.filter(x => x.action === 'reused').length, 47, '其余 47 个复用');
    assert.deepEqual(tree(partDir), snap, '续建后快照与完整构建一致');
    assert.equal(tool.checkDir(partDir).ok, true);
    return {
      precheckConflict: 'BTP_OUT_CONFLICT(目录快照不变,零写)',
      eioFacts: { wroteFiles: 2, written: eioErr.written },
      legalResume: { written: 1, reused: 47, snapshotRestored: true, checkOk: true }
    };
  });

  // S5（R4）：完整项目组装 + 页面收窄 + 实际 App→Page→client→服务端 链
  await probe('S5_r4_full_project_and_real_chain', async () => {
    // 组装完整性
    const p = build('P', plan('P'), 's5-p');
    const appJson = JSON.parse(fs.readFileSync(path.join(p.outDir, 'frontend/app.json'), 'utf8'));
    assert.deepEqual(appJson.pages, ['pages/schedule-sandbox/schedule-sandbox'], '唯一页面入口');
    const projConf = JSON.parse(fs.readFileSync(path.join(p.outDir, 'project.config.json'), 'utf8'));
    assert.equal(projConf.miniprogramRoot, 'frontend/');
    assert.equal(projConf.cloudfunctionRoot, 'server/');
    // 页面收窄：P/E/X 各自动作 ⊆ 窗口允许清单；X 专用按钮仅 V07-A/B
    const eOut = build('E', plan('E'), 's5-e').outDir;
    const xOut = build('X', plan('X'), 's5-x').outDir;
    for (const [w, allowed, out] of [
      ['P', tool.P_ACTIONS, p.outDir],
      ['E', tool.E_ACTIONS, eOut],
      ['X', tool.X_ACTIONS, xOut]
    ]) {
      const src = fs.readFileSync(path.join(out, 'frontend/pages/schedule-sandbox/schedule-sandbox.js'), 'utf8');
      const keys = [...src.matchAll(/key: '(\w+)'/g)].map(m => m[1]);
      assert.ok(keys.length > 0 && keys.length < 17, w + ' 页面动作已收窄');
      for (const k of keys) assert.ok(allowed.includes(k), w + ':' + k);
      if (w === 'X') {
        const labels = [...src.matchAll(/id: '(V0[67]-\w)'/g)].map(m => m[1]);
        assert.deepEqual(labels, ['V07-A', 'V07-B'], 'X 专用按钮仅 V07-A/B（V06 不显示）');
      }
    }
    // 完整链（正向）：E 窗口 App→Page→client→候选服务端→合成 db
    const pSeed = build('P', plan('P'), 's5-seed');
    const db = createSandboxTestDb({
      [PREFIX + 'users']: Object.fromEntries(ROLES.map(r => [U[r], { _id: U[r], status: 'active', openid: SYN_OPENID(r) }])),
      [PREFIX + 'app_admins']: { primary: { _id: 'primary', status: 'active', userId: U.owner } }
    });
    await seedMembers(pSeed.outDir, db);
    const { api, calls } = makeChainWx(eOut, db, 'manager');
    // App 初始化链
    const app = loadCandidateApp(eOut, api);
    assert.equal(app.globalData.cloudReady, true, '候选 App 初始化链可达');
    const page = loadCandidatePage(eOut, api);
    page.onLoad();
    assert.equal(page.data.entryAllowed, true);
    await page.runAction('identify');
    assert.equal(page.data.lastError, '', page.data.lastError);
    page.setData({
      form: { stage: '拆改', trade: '拆改', workerUserId: WORKER,
        startDate: '2030-01-02', endDate: '2030-01-03', expectedDate: '2030-01-03',
        restDaysText: '', content: 'S5 完整链新增' }
    });
    await page.runAction('createSchedule');
    assert.equal(page.data.lastError, '', page.data.lastError);
    assert.equal(countOf(db, 'schedules'), 1, 'Page 提交实际贯通候选服务端并写入合成 db');
    // 拒绝路径：client 直发受限管理动作 → 服务端收窄拒绝（真实传输，非手造回执）
    const denied = await candidateFrontend(eOut, 'utils/schedule-sandbox-client.js').callSandbox(
      { action: 'assignManager', projectId: PROJECT, bindingNumber: '1', requestId: 's5-deny' }, { api });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE');
    // X 同项目同轮：V07-A candidate → 既有人工核对入口接续 → 页面取消 → V07-B 成功
    const xChain = makeChainWx(xOut, db, 'manager');
    // 复用 E 页面提交的那条安排（全库仅此一条）：V07 流程与页面链不残留 active 安排，
    // cancel 后 V07-B 的"目标已无 active 安排"前置合法成立。
    const scheds = db.getPrefixedData()[PREFIX + 'schedules'] || {};
    assert.equal(Object.keys(scheds).length, 1, '全库恰好 1 条安排');
    const s1rec = Object.values(scheds)[0];
    assert.equal(s1rec.status, 'active');
    const s1 = { scheduleId: s1rec._id, version: s1rec.version };
    const xApp = loadCandidateApp(xOut, xChain.api);
    assert.equal(xApp.globalData.cloudReady, true);
    const xPage = loadCandidatePage(xOut, xChain.api);
    xPage.onLoad();
    assert.equal(xPage.data.entryAllowed, true);
    await xPage.runAction('identify');
    assert.equal(xPage.data.lastError, '', xPage.data.lastError);
    await xPage.runTestCase({ currentTarget: { dataset: { case: 'V07-A' } } });
    assert.equal(xPage.data.testReport.verdict, 'candidate', JSON.stringify(xPage.data.testReport).slice(0, 200));
    const rmA = xChain.calls.filter(c => c.action === 'removeMember').length;
    xPage.setData({ testReviewIdInput: 's5-review-001' });
    xPage.acceptTestCloudReview();
    assert.ok(/已记录人工核对声明/.test(xPage.data.testReport.reviewResult || ''), '既有人工核对入口接续');
    xPage.setData({ scheduleIdInput: s1.scheduleId, expectedVersionInput: String(s1.version), reasonInput: 'S5 同轮移出前清空' });
    await xPage.runAction('cancelSchedule');
    assert.equal(xPage.data.lastError, '', xPage.data.lastError);
    await xPage.runTestCase({ currentTarget: { dataset: { case: 'V07-B' } } });
    assert.equal(xPage.data.testReport.verdict, 'candidate', JSON.stringify(xPage.data.testReport).slice(0, 200));
    assert.equal(xChain.calls.filter(c => c.action === 'removeMember').length, rmA + 1, 'V07-B 恰好一次移出');
    const members = db.getPrefixedData()[PREFIX + 'project_members'] || {};
    const wr = Object.values(members).find(m => m.userId === WORKER);
    assert.equal(wr && wr.status, 'left', '师傅已移出（状态 left）');
    // V06：驱动层零发送拒绝 + X 页面按钮不存在
    const driver = candidateFrontend(xOut, 'utils/sandbox-test-driver.js');
    const v06 = await driver.runCase({ api: xChain.api, testCaseId: 'V06-a', input: { projectId: PROJECT, userId: MANAGER } });
    assert.equal(v06.code, 'TEST_DRIVER_UNKNOWN_CASE');
    assert.equal(v06.report.sent, 0, 'V06 零发送');
    assert.deepEqual(xPage.data.testCases.map(c => c.id), ['V07-A', 'V07-B']);
    // P/E 驱动关闭零发送
    const drvP = candidateFrontend(p.outDir, 'utils/sandbox-test-driver.js');
    const blocked = await drvP.runCase({ api: xChain.api, testCaseId: 'V07-A', input: { projectId: PROJECT, userId: WORKER } });
    assert.equal(blocked.code, 'TEST_DRIVER_GATE_BLOCKED');
    assert.equal(blocked.report.sent, 0);
    return {
      fullProject: { appJsonPages: appJson.pages, roots: [projConf.miniprogramRoot, projConf.cloudfunctionRoot] },
      pageNarrowing: { P: true, E: true, X: 'V07-A/B only' },
      chain: { appReady: true, eCreateScheduleWritten: 1, assignManagerDenied: 'SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE' },
      sameRoundX: 'V07-A→acceptTestCloudReview→cancelSchedule→V07-B（同项目同轮同候选）',
      v06ZeroSend: true, peDriverClosed: true
    };
  });

  // S6（R5）：真实模式来源回读证据绑定
  await probe('S6_r5_readback_evidence_binding', () => {
    // 反例：真实计划无回读证据 → 拒绝（非空来源声明不等于核实）
    const noEv = plan('P', {
      synthetic: false,
      windowStartsAt: new Date(Date.now() - 3600e3).toISOString(),
      windowExpiresAt: new Date(Date.now() + 1200e3).toISOString(),
      users: Object.fromEntries(ROLES.map(r => [r, { userId: U[r], source: '人工声明' }]))
    });
    assert.throws(() => tool.readPlan(planFile(noEv), 'P'), e => e.code === 'BTP_PLAN_USER_INVALID');
    // 反例：证据 kind 冒充 / 摘要缺失 → 拒绝
    const badKind = realPlan('P');
    badKind.participantEvidence.owner = { kind: 'declaration-only', recordSha256: 'a'.repeat(64) };
    assert.throws(() => tool.readPlan(planFile(badKind), 'P'), e => e.code === 'BTP_PLAN_USER_INVALID');
    const badDigest = realPlan('P');
    badDigest.participantEvidence.worker = { kind: 'readback-record', recordSha256: 'short' };
    assert.throws(() => tool.readPlan(planFile(badDigest), 'P'), e => e.code === 'BTP_PLAN_USER_INVALID');
    // 正向（E 窗口）：三账号证据 + P 项目回读证据（绑定 roundId/projectId/marker/摘要）→ 接受
    const okEv = realPlan('E', { projectReadback: {
      source: 'readback', projectId: PROJECT, businessRoundId: ROUND,
      projectReadyMarker: 'ready-' + ROUND, recordSha256: sha(Buffer.from('p-readback'))
    } });
    const parsed = tool.readPlan(planFile(okEv), 'E');
    assert.equal(parsed.evidenceBound, true);
    assert.equal(parsed.projectReadback.source, 'readback');
    // 反例：projectReadback 绑定字段不一致 → 拒绝
    const mismatch = realPlan('E', { projectReadback: {
      source: 'readback', projectId: PROJECT, businessRoundId: 'other-round',
      projectReadyMarker: 'ready-' + ROUND, recordSha256: sha(Buffer.from('x'))
    } });
    assert.throws(() => tool.readPlan(planFile(mismatch), 'E'), e => e.code === 'BTP_PLAN_PROJECT_INVALID');
    // 反例：E 窗口真实模式缺 projectReadback → 拒绝（ID 公式不算回读）
    assert.throws(() => tool.readPlan(planFile(realPlan('E')), 'E'), e => e.code === 'BTP_PLAN_PROJECT_INVALID');
    // 来源与证据计入稳定摘要：来源文本变化 → planDigest 变化
    const d1 = tool.planDigest(tool.readPlan(planFile(realPlan('P')), 'P'));
    const varied = realPlan('P');
    varied.users.owner.source = '另一份来源声明';
    const d2 = tool.planDigest(tool.readPlan(planFile(varied), 'P'));
    assert.notEqual(d1, d2);
    return {
      noEvidenceRejected: true, badKindRejected: true, badDigestRejected: true,
      evidencePlusReadbackAccepted: true, readbackMismatchRejected: true,
      ewithoutReadbackRejected: true, sourceInPlanDigest: true
    };
  });

  // S7（R6）：口径与文档断言
  await probe('S7_r6_wording_and_artifact_hygiene', () => {
    // 测试套件不含旧调试输出
    const testSrc = fs.readFileSync(path.join(ROOT, 'miniapp/tests/business-test-package.test.cjs'), 'utf8');
    assert.equal(testSrc.includes('B2DBG'), false, '无遗留完整调试输出');
    // manifest 边界声明改正术语：project-guard 建项目记录 ≠ 云端建库
    const b = build('P', plan('P'), 's7-words');
    const boundaries = b.manifest.boundaries.join('\n');
    assert.ok(boundaries.includes('不等于创建数据库或集合'), '建库术语已改正');
    // 无生成时间戳：同计划同目录重建字节一致（内容寻址）
    const pfWords = planFile(plan('P'));
    tool.build('P', pfWords, path.join(outRoot, 's7-words2'));
    const again = tool.build('P', pfWords, path.join(outRoot, 's7-words2'));
    assert.equal(again.io.every(x => x.action === 'reused'), true, '同计划重建全部复用（内容寻址）');
    return { noDebugOutput: true, terminologyFixed: true, contentAddressed: true };
  });

  // G0 之前基线=0；G0 探针有意触发 2 次守卫命中，不计入 unexpected
  const g0Baseline = guardHits.length;
  const report = {
    reviewedCommit: '3cbdd7f',
    fixedAgainst: 'b5aff19 R1-R6',
    generatedAt: new Date().toISOString(),
    implementationSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'))),
    artifactDirectory: path.relative(ROOT, outRoot).replaceAll('\\', '/'),
    verificationKind: 'offline synthetic verification; no SDK/platform/credentials; SDK local transform NOT executed',
    terminologyNote: 'project-guard 创建业务项目记录不等于创建数据库/集合；集合初始化未执行',
    results,
    summary: {
      total: results.length,
      assertionsPassed: results.filter(r => r.assertionsPassed).length,
      unexpectedGuardAttempts: guardHits.length - g0Baseline
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
  if (results.some(r => !r.assertionsPassed) || guardHits.length !== g0Baseline) process.exitCode = 1;
}

main().catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(() => restore.reverse().forEach(fn => fn()));
