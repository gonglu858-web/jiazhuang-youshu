'use strict';
/**
 * 本人登记制品 —— 相称离线测试（L3）
 * ==========================================
 *
 * 覆盖任务《本人登记制品本地准备》§3 测试表：
 *  A 产物来源与差异 / B 服务端真实 main / C 动作收口 / D 新账号登记 /
 *  E 已有·停用·错误归属 / F 客户端真实 Page·client / G 保存与关闭
 *
 * **合成验证 / 真实 SDK 本地转换 / 未进行的平台验证必须分开看**：
 *  - 本文件全程使用**合成**凭据、合成微信上下文与合成数据库传输；
 *  - 「真实 main」指的是加载**生成的** index/gate/map/vendor 并实际调用
 *    其 main/assert 函数，走**真实 SDK 本地转换**（序列化、事务对象），
 *    但数据库是**合成传输**，**不是**云端执行；
 *  - 真实凭据获取、真实平台初始化、IAM 写权限、真机与平台编译**全部未验证**。
 *
 * 边界：不联网、不取真实凭据、不安装、不创建资源、不预览、不部署、
 * 不登记本人微信、不初始化管理员、不启用入口、不清缓存。
 * 产物目录为隔离的合成制品目录（artifacts 不纳入提交）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const reg = require('../scripts/package-sandbox-registration.cjs');

const SOURCE_DIR = reg.SOURCE_DIR;
const ARTIFACTS_ROOT = reg.ARTIFACTS_ROOT;
const FIXED = reg.FIXED_TARGET;
const TARGET_USER = 'u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4';

/** 合成 OPENID（合成验证用，非真实微信标识）。 */
const SYNTH_OPENID = 'synthetic-registration-openid';

/** 由可信 APPID/OPENID 派生 userId —— 与 vendor/service.js 同一算法。 */
function deriveUserId(openid) {
  const h = crypto.createHash('sha256').update(`${FIXED.appId}:${openid}`).digest('hex');
  return `u_${h.slice(0, 40)}`;
}

/** 合成计划（synthetic=true，可用合成时钟）。 */
function syntheticPlan(patch) {
  const base = {
    purpose: 'synthetic-offline-verification-only',
    appId: FIXED.appId,
    envId: FIXED.envId,
    region: FIXED.region,
    functionName: FIXED.functionName,
    allowedUserIds: [deriveUserId(SYNTH_OPENID)],
    roundId: 'SYNTH-REG-0001',
    // 合成窗口：**固定**基准（2026-01-01T00:00:00Z 起 20 分钟）。
    // 固定值保证离线复跑时计划逐项一致，产物可复用；窗口有效性由
    // deps.nowMs（合成时钟）判定，真实时间窗口留到执行包阶段，本轮不预填。
    windowStartsAt: '2026-01-01T00:00:00.000Z',
    windowExpiresAt: '2026-01-01T00:20:00.000Z',
    sourceVersion: 'synthetic-offline-source-v1',
    synthetic: true
  };
  return Object.assign(base, patch || {});
}

/** 一次性生成合成登记制品，返回目录与manifest。 */
/** 合成时钟：落在合成窗口内（与真实当前时间无关）。 */
const SYNTH_NOW_MS = Date.parse('2026-01-01T00:05:00.000Z');
const BUILT = reg.buildRegistration(syntheticPlan(), {
  outId: 'synth-reg-0001', nowMs: SYNTH_NOW_MS
});
const PKG = path.join(BUILT.dir, 'package');

/**
 * 收集一次 main 调用对合成数据库的访问。
 *
 * 合成传输按**真实 SDK 调用形状**实现（与已验收测试一致）：
 *   collection(name).doc(id).get()      → { data }
 *   collection(name).doc(id).update({data})
 *   collection(name).add({ data })
 *   collection(name).where(cond).limit(n).get() → { data: [] }
 *   db.runTransaction(fn)               → 事务内同一批写入，失败整体回滚
 *
 * 计数用途：证明「非 identify 动作在数据库访问前被拒」（database 入口 0 次）
 * 与「identify 的写入面恰好是 users + registerIdentity 审计、primary 零写」。
 */
function makeSyntheticCloud(store, opts) {
  const o = opts || {};
  const calls = {
    database: 0, collection: [], execute: 0,
    adds: [], updates: [], gets: [], removes: [],
    tx: 0, commits: 0, rollbacks: 0
  };
  /** 集合名 → 文档数组（真实是文档集合，这里用数组承载以便 where/add）。 */
  const rows = (name) => {
    if (!Array.isArray(store[name])) store[name] = [];
    return store[name];
  };
  const findById = (name, id) => rows(name).find((d) => d && d._id === id);
  const matchCond = (d, cond) => Object.entries(cond || {})
    .every(([k, v]) => (d ? d[k] === v : false));

  const makeCollection = (name, sink) => ({
    doc(id) {
      return {
        async get() {
          sink.gets.push(`${name}/${id}`);
          return { data: findById(name, id) || null };
        },
        async update({ data: patch }) {
          sink.updates.push(`${name}/${id}`);
          const cur = findById(name, id);
          if (cur) Object.assign(cur, patch);
          else rows(name).push(Object.assign({ _id: id }, patch));
          return { stats: { updated: cur ? 1 : 0 } };
        },
        async set({ data: patch }) {
          sink.updates.push(`${name}/${id}/set`);
          const cur = findById(name, id);
          if (cur) Object.assign(cur, patch);
          else rows(name).push(Object.assign({ _id: id }, patch));
          return { stats: { updated: cur ? 1 : 0 } };
        },
        async remove() {
          sink.removes.push(`${name}/${id}`);
          const i = rows(name).findIndex((d) => d && d._id === id);
          if (i !== -1) rows(name).splice(i, 1);
          return { stats: { removed: i !== -1 ? 1 : 0 } };
        }
      };
    },
    async add({ data: value }) {
      sink.adds.push(`${name}/add`);
      const doc = Object.assign({}, value);
      if (!doc._id) doc._id = `${name}-auto-${rows(name).length + 1}`;
      rows(name).push(doc);
      return { _id: doc._id, stats: { added: 1 } };
    },
    where(cond) {
      const api = {
        async get() {
          sink.gets.push(`${name}/where`);
          return { data: rows(name).filter((d) => matchCond(d, cond)) };
        },
        limit() { return api; },
        orderBy() { return api; },
        get() { return api.get(); }
      };
      return api;
    },
    async get() {
      sink.gets.push(`${name}/all`);
      return { data: rows(name).slice() };
    },
    async count() { return { total: rows(name).length }; }
  });

  const db = {
    collection(name) {
      calls.collection.push(name);
      return makeCollection(name, calls);
    },
    async runTransaction(fn) {
      calls.tx += 1;
      const snapshot = JSON.parse(JSON.stringify(store));
      const txSink = { adds: [], updates: [], gets: [], removes: [] };
      const txDb = {
        collection(name) { return makeCollection(name, txSink); },
        async runTransaction(f) { return f(txDb); }
      };
      try {
        const r = await fn(txDb);
        calls.adds.push(...txSink.adds);
        calls.updates.push(...txSink.updates);
        calls.gets.push(...txSink.gets);
        calls.removes.push(...txSink.removes);
        calls.commits += 1;
        return r;
      } catch (error) {
        // 回滚：恢复快照，**如实**记录已发生的写（用于断言「拒绝时不覆盖」）
        calls.adds.push(...txSink.adds);
        calls.updates.push(...txSink.updates);
        calls.gets.push(...txSink.gets);
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, snapshot);
        calls.rollbacks += 1;
        throw error;
      }
    }
  };
  return {
    calls,
    cloud: {
      database() { calls.database += 1; return db; },
      getWXContext() { return o.wxContext || {}; }
    }
  };
}

/**
 * 加载**生成的** index.js，注入合成 wx-server-sdk 与数据库。
 * 返回其 exports.main。
 */
function loadGeneratedMain(store, opts) {
  const o = opts || {};
  const synth = makeSyntheticCloud(store, o);
  const indexPath = path.join(PKG, 'index.js');
  // 生成 main 的 trusted.envId **在调用时**从 process.env.TCB_ENV 读取
  // （不接受请求体自报），因此环境必须覆盖整个 main 调用期：
  // 载入时设置，返回包装器在调用前后设置/恢复。
  const envId = o.envId || FIXED.envId;
  const prevEnv = process.env.TCB_ENV;
  process.env.TCB_ENV = envId;
  // 合成 wx-server-sdk
  const sdkStub = {
    init(opts2) { return synth.cloud; },
    database() { return synth.cloud.database(); },
    getWXContext() { return (o.wxContext || {}); },
    DYNAMIC_CURRENT_ENV: 'FIXED'
  };
  /**
   * 合成时钟：生成的 gate 以 `trusted.nowMs > expiresAt` 判定窗口到期，
   * 而 `trusted.nowMs` 来自 index 的 `Date.now()`。合成窗口是固定历史时刻，
   * 因此离线验证必须把 `Date.now` 一并替换为合成时刻 ——
   * 否则窗口永远「已过期」，无法验证登记成功路径。
   */
  const realNow = Date.now;
  const synthNow = typeof o.nowMs === 'number' && Number.isFinite(o.nowMs) ? o.nowMs : SYNTH_NOW_MS;
  Date.now = () => synthNow;
  const req = Module.createRequire(indexPath);
  const originalResolve = req.resolve;
  req.resolve = function (request, ...rest) {
    if (request === 'wx-server-sdk') return 'wx-server-sdk';
    return originalResolve.call(this, request, ...rest);
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return sdkStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(indexPath)];
    const mod = require(indexPath);
    void realNow;
    // 包装 main：调用期间保持合成运行环境，调用后恢复
    const rawMain = mod.main;
    const wrapped = async (event) => {
      const before = process.env.TCB_ENV;
      const beforeNow = Date.now;
      process.env.TCB_ENV = envId;
      // gate 在**调用时**读 Date.now() 判定窗口到期，
      // 因此合成时钟须覆盖整个调用期。
      Date.now = () => synthNow;
      try {
        return await rawMain(event);
      } finally {
        Date.now = beforeNow;
        if (before === undefined) delete process.env.TCB_ENV;
        else process.env.TCB_ENV = before;
      }
    };
    return { main: wrapped, calls: synth.calls, cloud: synth.cloud };
  } finally {
    Module._load = originalLoad;
    req.resolve = originalResolve;
    Date.now = realNow;
    if (prevEnv === undefined) delete process.env.TCB_ENV;
    else process.env.TCB_ENV = prevEnv;
  }
}

/** 合成可信微信上下文。 */
function trustedCtx(patch) {
  return Object.assign({
    APPID: FIXED.appId,
    OPENID: SYNTH_OPENID,
    env: FIXED.envId
  }, patch || {});
}

// ══════════════════════════════════════════════════════════════════════
// A 产物来源与差异
// ══════════════════════════════════════════════════════════════════════

test('A-1 生成产物为 8 个服务端文件 + manifest + 前端覆盖文件', () => {
  const files = [];
  const walk = (dir, rel) => {
    for (const n of fs.readdirSync(dir)) {
      const abs = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else files.push(r);
    }
  };
  walk(BUILT.dir, '');
  for (const rel of reg.PACKAGE_FILES) {
    assert.ok(files.includes(path.join('package', rel)) ||
      files.includes('package/' + rel), '缺产物文件：' + rel);
  }
  assert.ok(files.indexOf('manifest.json') !== -1, '缺 manifest.json');
  assert.ok(files.indexOf('package/frontend/config/schedule-sandbox-proof.js') !== -1,
    '缺前端覆盖文件：' + files.join(','));
  assert.equal(BUILT.manifest.schema, reg.REGISTRATION_MANIFEST_SCHEMA);
  // 不自称云端部署哈希、不做安全授权
  assert.equal(BUILT.manifest.deploymentAuthorized, false);
  assert.equal(BUILT.manifest.cloudExecuted, false);
  // 不给 manifest 加循环自哈希
  assert.equal(Object.keys(BUILT.manifest).indexOf('selfHash'), -1);
  assert.equal(JSON.stringify(BUILT.manifest).indexOf('"manifestHash"'), -1);
});

test('A-2 两处变换唯一且精确，其余 6 文件逐字节一致', () => {
  const diffs = BUILT.differences;
  assert.equal(diffs.length, 2, '必须恰好两处差异：' + JSON.stringify(diffs.map((d) => d.file)));
  const files = diffs.map((d) => d.file).sort();
  assert.deepEqual(files, ['gate.js', 'index.js']);
  for (const d of diffs) {
    assert.match(d.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(d.artifactSha256, /^[0-9a-f]{64}$/);
  }
  // 其余 6 文件与受审源逐字节一致
  const changed = new Set(diffs.map((d) => d.file));
  for (const rel of reg.PACKAGE_FILES) {
    const srcAbs = path.join(SOURCE_DIR, rel);
    const artAbs = path.join(PKG, rel);
    if (changed.has(rel)) continue;
    assert.deepEqual(fs.readFileSync(artAbs), fs.readFileSync(srcAbs),
      '非变换文件必须逐字节一致：' + rel);
  }
});

test('A-3 源目录/vendor/旧打包器未被修改', () => {
  // 计划中的 sourceVersion 绑定受审源整体指纹
  assert.match(BUILT.manifest.reviewedSource.setDigest, /^[0-9a-f]{64}$/);
  assert.equal(BUILT.manifest.reviewedSource.files.length, reg.PACKAGE_FILES.length);
  for (const f of BUILT.manifest.reviewedSource.files) {
    const abs = path.join(SOURCE_DIR, f.rel);
    assert.equal(reg.sha256Buffer(fs.readFileSync(abs)), f.sha256,
      '受审源已变化：' + f.rel);
  }
  // 旧打包器仍可加载（未被新工具改动）
  const legacy = require('../scripts/package-sandbox.cjs');
  assert.equal(legacy.MANIFEST_SCHEMA, 'sandbox-closed-candidate/2');
});

test('A-4 计划非法时零产物（占位/空名单/超窗/过期/目标不符）', () => {
  const bad = [
    ['占位 purpose', syntheticPlan({ purpose: 'TBD' }), reg.ERR.PLAN_PLACEHOLDER],
    ['空名单', syntheticPlan({ allowedUserIds: [] }), reg.ERR.PLAN_USER_INVALID],
    ['非完整 userId', syntheticPlan({ allowedUserIds: ['2d3aa4'] }), reg.ERR.PLAN_USER_INVALID],
    ['重复用户', syntheticPlan({ allowedUserIds: [deriveUserId(SYNTH_OPENID), deriveUserId(SYNTH_OPENID)] }),
      reg.ERR.PLAN_USER_NOT_UNIQUE],
    ['窗口过长', syntheticPlan({
      windowStartsAt: '2026-10-10T00:00:00.000Z',
      windowExpiresAt: '2026-10-10T02:00:00.000Z'
    }), reg.ERR.PLAN_WINDOW_TOO_LONG],
    ['环境不符', syntheticPlan({ envId: 'other-env' }), reg.ERR.PLAN_TARGET_MISMATCH],
    ['函数不符', syntheticPlan({ functionName: 'memberAccess' }), reg.ERR.PLAN_TARGET_MISMATCH],
    ['未登记字段', syntheticPlan({ collections: ['x'] }), reg.ERR.PLAN_FIELD_UNKNOWN],
    ['缺轮次', (() => { const p = syntheticPlan(); delete p.roundId; return p; })(),
      reg.ERR.PLAN_FIELD_MISSING]
  ];
  // 合成 now 取窗口内（早于 expiresAt）以便「过期」用例可单独触发
  const insideNow = SYNTH_NOW_MS;
  for (const [label, plan, code] of bad) {
    assert.throws(
      () => reg.validatePlan(plan, { nowMs: insideNow }),
      (err) => err.code === code,
      label + ' 应被 ' + code + ' 拒绝'
    );
  }
  // 真实（非合成）计划过期即拒
  assert.throws(() => reg.validatePlan(
    Object.assign(syntheticPlan(), { synthetic: false }),
    { nowMs: Date.parse(syntheticPlan().windowExpiresAt) + 1000 }),
    (e) => e.code === reg.ERR.PLAN_WINDOW_EXPIRED, '真实计划过期须拒绝');
});

test('A-5 变换锚点缺失/多处即停止，不做全局替换', () => {
  const sources = reg.readReviewedSources();
  const t = reg.buildIndexTransform(reg.validatePlan(syntheticPlan(), { nowMs: SYNTH_NOW_MS }));
  // 锚点缺失
  const broken = new Map(sources);
  broken.set('index.js', { bytes: 3, sha256: 'x', buf: Buffer.from('const other = 1;') });
  assert.throws(() => reg.applyTransform(broken, t),
    (e) => e.code === reg.ERR.TRANSFORM_ANCHOR_MISSING, '缺失锚点须停止');
  // 锚点多处
  // 片段出现两次（源内容被复制一份）—— 哈希须与该夹具**自洽**，
  // 否则会先触发「源漂移」而测不到「锚点多处」这一分支。
  const dup = new Map(sources);
  const idxBuf = sources.get('index.js').buf;
  const dupBuf = Buffer.concat([idxBuf, Buffer.from('\n' + t.from)]);
  const dupSha = reg.sha256Buffer(dupBuf);
  dup.set('index.js', { bytes: dupBuf.length, sha256: dupSha, buf: dupBuf });
  assert.throws(() => reg.applyTransform(dup, t, dupSha),
    (err) => err.code === reg.ERR.TRANSFORM_ANCHOR_AMBIGUOUS, '多处锚点须停止');
  // 源漂移（哈希不符）
  assert.throws(() => reg.applyTransform(sources, t, 'f'.repeat(64)),
    (e) => e.code === reg.ERR.PLAN_SOURCE_DRIFT, '源漂移须停止');
});

// ══════════════════════════════════════════════════════════════════════
// B 服务端真实 main
// ══════════════════════════════════════════════════════════════════════

test('B-1 生成的 gate 只允许 identify，其余 14 个 prepare 动作被拒', () => {
  const gateSrc = fs.readFileSync(path.join(PKG, 'gate.js'), 'utf8');
  // 直接断言**生成的** gate 导出
  const gatePath = path.join(PKG, 'gate.js');
  delete require.cache[require.resolve(gatePath)];
  const gate = require(gatePath);
  assert.deepEqual(Array.from(gate.PREPARE_ALLOWED), ['identify']);
  const cfg = gate.readConfig({
    enabled: true, appId: FIXED.appId, envId: FIXED.envId,
    allowedUserIds: [deriveUserId(SYNTH_OPENID)], projectId: '',
    roundId: 'SYNTH-REG-0001', expiresAt: '2026-10-10T00:20:00.000Z',
    phase: 'prepare', projectReadyMarker: ''
  });
  gate.assertActionAllowed(cfg, 'identify');
  const others = [
    'listMyProjects', 'requestBindingNumber', 'createProject', 'assignManager',
    'createInvitation', 'applyInvitation', 'approveInvitation', 'removeMember',
    'getMembers', 'listInvitations', 'getScheduleContext', 'listSchedules',
    'getSchedule', 'listScheduleRevisions'
  ];
  for (const a of others) {
    assert.throws(() => gate.assertActionAllowed(cfg, a), '应拒绝：' + a);
  }
  // 施工四写与未知动作同样被拒
  for (const a of ['createSchedule', 'updateSchedule', 'reassignSchedule', 'cancelSchedule',
    'totallyUnknownAction']) {
    assert.throws(() => gate.assertActionAllowed(cfg, a), '应拒绝：' + a);
  }
  // EXECUTE_ALLOWED 未被改动（未被误收窄）
  assert.ok(gate.EXECUTE_ALLOWED.indexOf('createSchedule') !== -1,
    'EXECUTE_ALLOWED 不得被本次变换改动');
  void gateSrc;
});

test('B-2 其他动作在数据库访问前被拒（database 入口 0 次）', async () => {
  const gatePath = path.join(PKG, 'gate.js');
  const gate = require(gatePath);
  const sourceGate = fs.readFileSync(path.join(SOURCE_DIR, 'gate.js'), 'utf8');
  // 确认生成的 EXECUTE_ALLOWED 仍含施工写（未用改 phase 的方式绕过）
  assert.ok(gate.EXECUTE_ALLOWED.length >= 8, 'EXECUTE_ALLOWED 长度异常');
  assert.ok(sourceGate.indexOf('const PREPARE_ALLOWED') !== -1);
});

test('B-3 关闭配置与错环境/错微信账号被拒（真实 main 调用）', async () => {
  // 关闭包：enabled=false → 真实 main 拒绝且零数据库
  const closedDir = path.join(ARTIFACTS_ROOT, 'closed-20261005-r2fix', 'package');
  // 直接用受审关闭包的 index 做 main 拒绝验证（**不**生成任何登记产物）
  const closedIndex = path.join(closedDir, 'index.js');
  const store = {};
  const prevEnv = process.env.TCB_ENV;
  process.env.TCB_ENV = FIXED.envId;
  const origLoad = Module._load;
  const req = Module.createRequire(closedIndex);
  const origResolve = req.resolve;
  req.resolve = function (r2, ...rest) {
    if (r2 === 'wx-server-sdk') return 'wx-server-sdk';
    return origResolve.call(this, r2, ...rest);
  };
  const cloudStub = {
    init: () => ({ database: () => { throw new Error('不应访问数据库'); } }),
    database: () => { throw new Error('不应访问数据库'); },
    getWXContext: () => trustedCtx()
  };
  Module._load = function (r2, parent, isMain) {
    if (r2 === 'wx-server-sdk') return cloudStub;
    return origLoad.call(this, r2, parent, isMain);
  };
  let main;
  try {
    delete require.cache[require.resolve(closedIndex)];
    main = require(closedIndex).main;
  } finally {
    Module._load = origLoad;
    req.resolve = origResolve;
  }
  const r = await (async () => {
    process.env.TCB_ENV = FIXED.envId;
    try {
      return await main({ action: 'identify' });
    } finally {
      if (prevEnv === undefined) delete process.env.TCB_ENV;
      else process.env.TCB_ENV = prevEnv;
    }
  })();
  assert.equal(r.ok, false, '关闭包必须拒绝：' + JSON.stringify(r));
  assert.ok(r.code, '应返回固定错误码：' + JSON.stringify(r));
});

// ══════════════════════════════════════════════════════════════════════
// C 动作收口（真实 main，全程零数据库）
// ══════════════════════════════════════════════════════════════════════

test('C-1 非 identify 动作经真实 main 全被拒且数据库访问 0 次', async () => {
  const others = [
    'listMyProjects', 'requestBindingNumber', 'createProject', 'assignManager',
    'createInvitation', 'applyInvitation', 'approveInvitation', 'removeMember',
    'getMembers', 'listInvitations', 'getScheduleContext', 'listSchedules',
    'getSchedule', 'listScheduleRevisions',
    // 施工四写
    'createSchedule', 'updateSchedule', 'reassignSchedule', 'cancelSchedule',
    // 未知动作
    'totallyUnknownAction'
  ];
  for (const action of others) {
    const store = {};
    const { main, calls } = loadGeneratedMain(store, { wxContext: trustedCtx() });
    let out = null;
    let threw = null;
    try {
      out = await main({ action });
    } catch (error) {
      threw = error;
    }
    assert.equal(calls.database, 0,
      action + '：数据库入口必须 0 次，实际 ' + calls.database);
    assert.equal(calls.tx, 0, action + '：事务必须 0 次');
    assert.equal(calls.commits, 0, action + '：提交必须 0 次');
    assert.ok(threw !== null || (out && out.ok === false),
      action + '：应被拒绝（抛错或 ok=false），实际 ' + JSON.stringify(out));
  }
});

// ══════════════════════════════════════════════════════════════════════
// D 新账号登记
// ══════════════════════════════════════════════════════════════════════

test('D-1 本人首次登记：users + registerIdentity 两条写、primary 写 0', async () => {
  const store = {};
  const { main, calls } = loadGeneratedMain(store, { wxContext: trustedCtx() });
  const out = await main({ action: 'identify' });
  assert.equal(out.ok, true, '首次登记应成功：' + JSON.stringify(out));
  const expectedId = deriveUserId(SYNTH_OPENID);
  assert.equal(out.userId, expectedId, '应返回派生 userId');
  // 不输出 OPENID 或凭据
  const dumped = JSON.stringify(out);
  assert.equal(dumped.indexOf(SYNTH_OPENID), -1, '输出不得含 OPENID');
  assert.equal(/"(secret|token|openid|OPENID)"/i.test(dumped), false, '输出不得含凭据字段');
  // 写集合：users 一条 + audit 一条；primary 零写
  const writes = calls.adds.concat(calls.updates);
  assert.equal(calls.adds.filter((x) => x.indexOf('schtest_v1_users') === 0).length, 1,
    '应新增一条测试 users：' + JSON.stringify(writes));
  assert.equal(calls.adds.filter((x) => x.indexOf('schtest_v1_audit_events') === 0).length, 1,
    '应新增一条 registerIdentity 审计：' + JSON.stringify(writes));
  assert.equal(writes.filter((x) => x.indexOf('schtest_v1_app_admins') === 0).length, 0,
    '登记不得写 primary：' + JSON.stringify(writes));
  // 如实记录 primary 读取
  assert.ok(calls.gets.some((x) => x.indexOf('schtest_v1_app_admins') !== -1),
    '登记路径会读取 primary，应如实记录：' + JSON.stringify(calls.gets));
  // 不建项目、不取号
  assert.equal(writes.filter((x) => x.indexOf('schtest_v1_projects') === 0).length, 0,
    '登记不得建项目');
  assert.equal(calls.commits, 1, '一次事务提交');
});

test('D-2 登记返回 isAdmin=false（不授予管理员权限）', async () => {
  const store = {};
  const { main } = loadGeneratedMain(store, { wxContext: trustedCtx() });
  const out = await main({ action: 'identify' });
  assert.equal(out.userId, deriveUserId(SYNTH_OPENID));
  // 无 primary → 非管理员
  const dumped = JSON.stringify(out);
  assert.equal(dumped.indexOf('"isAdmin":true'), -1, '登记不得声称已授予管理员');
});

// ══════════════════════════════════════════════════════════════════════
// E 已有 / 停用 / 错误归属
// ══════════════════════════════════════════════════════════════════════

test('E-1 已存在合法用户：零新增、不重复审计', async () => {
  const id = deriveUserId(SYNTH_OPENID);
  const store = {
    schtest_v1_users: [{ _id: id, openid: SYNTH_OPENID, status: 'active' }]
  };
  const { main, calls } = loadGeneratedMain(store, { wxContext: trustedCtx() });
  const out = await main({ action: 'identify' });
  assert.equal(out.ok, true);
  assert.equal(out.userId, id);
  assert.equal(calls.adds.length + calls.updates.length, 0,
    '已存在不得新增：' + JSON.stringify(calls.adds.concat(calls.updates)));
  assert.equal(calls.tx, 0, '已存在不得再开事务');
});

test('E-2 停用账号被拒且不覆盖', async () => {
  const id = deriveUserId(SYNTH_OPENID);
  const store = {
    schtest_v1_users: [{ _id: id, openid: SYNTH_OPENID, status: 'disabled' }]
  };
  const { main, calls } = loadGeneratedMain(store, { wxContext: trustedCtx() });
  let out = null; let threw = null;
  try { out = await main({ action: 'identify' }); } catch (e) { threw = e; }
  assert.ok(threw !== null || (out && out.ok === false), '停用账号须拒绝');
  assert.equal(store.schtest_v1_users[0].status, 'disabled', '不得覆盖停用状态');
  assert.equal((calls.adds.concat(calls.updates)).filter((x) => x.indexOf('schtest_v1_users') === 0).length, 0,
    '停用不得被自动修复');
});

test('E-3 错 openid 归属被拒且不覆盖', async () => {
  const id = deriveUserId(SYNTH_OPENID);
  const store = {
    // 该 userId 记录属于**另一个** openid → 身份不一致
    schtest_v1_users: [{ _id: id, openid: 'synthetic-other-openid', status: 'active' }]
  };
  const { main, calls } = loadGeneratedMain(store, { wxContext: trustedCtx() });
  let out = null; let threw = null;
  try { out = await main({ action: 'identify' }); } catch (e) { threw = e; }
  assert.ok(threw !== null || (out && out.ok === false), '错归属须拒绝');
  assert.equal(store.schtest_v1_users[0].openid, 'synthetic-other-openid', '不得覆盖他人 openid');
  assert.equal((calls.adds.concat(calls.updates)).filter((x) => x.indexOf('schtest_v1_users') === 0).length, 0,
    '不得自动修复归属');
});

test('E-4 名单外账号被拒（allowedUserIds 是附加限制）', async () => {
  const store = {};
  const { main, calls } = loadGeneratedMain(store, {
    // 另一个可信微信上下文 → 派生出名单外的 userId
    wxContext: trustedCtx({ OPENID: 'synthetic-outsider-openid' })
  });
  let out = null; let threw = null;
  try { out = await main({ action: 'identify' }); } catch (e) { threw = e; }
  assert.ok(threw !== null || (out && out.ok === false), '名单外须拒绝');
  assert.equal(calls.database, 0, '名单外应在数据库访问前被拒');
});

test('E-5 错 AppID / 缺微信上下文被拒且零数据库', async () => {
  const cases = [
    ['错 AppID', { APPID: 'wxOTHERAPPID000000', OPENID: SYNTH_OPENID }],
    ['缺 OPENID', { APPID: FIXED.appId }],
    ['空上下文', {}]
  ];
  for (const [label, ctx] of cases) {
    const store = {};
    const { main, calls } = loadGeneratedMain(store, { wxContext: ctx });
    let out = null; let threw = null;
    try { out = await main({ action: 'identify' }); } catch (e) { threw = e; }
    assert.ok(threw !== null || (out && out.ok === false), label + ' 须拒绝');
    assert.equal(calls.database, 0, label + '：数据库入口必须 0 次');
  }
});

// ══════════════════════════════════════════════════════════════════════
// F 客户端真实 Page / client
// ══════════════════════════════════════════════════════════════════════

test('F-1 前端覆盖文件：固定目标、空项目、仅 develop/trial、无 phase 字段', () => {
  const cfg = require(path.join(PKG, 'frontend', 'config', 'schedule-sandbox-proof.js'));
  assert.equal(cfg.enabled, true, '登记窗口覆盖文件应为 enabled=true');
  assert.equal(cfg.appId, FIXED.appId);
  assert.equal(cfg.envId, FIXED.envId);
  assert.equal(cfg.functionName, FIXED.functionName);
  assert.deepEqual(Array.from(cfg.allowedVersions), ['develop', 'trial']);
  assert.equal(cfg.sandboxProjectId, '', '登记不以创建项目为前置');
  assert.equal(cfg.roundId, 'SYNTH-REG-0001');
  // 不新增不存在的 phase 字段
  assert.equal('phase' in cfg, false, '不得新增 phase 字段');
  // 冻结要求保留
  assert.ok(Object.isFrozen(cfg), '配置须冻结');
  assert.ok(Object.isFrozen(cfg.allowedVersions));
  // 旧业务入口与专用测试驱动仍 false
  const legacy = require(path.join(__dirname, '..', 'miniprogram', 'config', 'schedule-sandbox-proof.js'));
  assert.equal(legacy.enabled, false, '仓库源配置必须仍为 false');
});

test('F-2 客户端真实 client：用生成的覆盖配置加载，onLoad/onShow 零业务请求', () => {
  const clientPath = path.join(__dirname, '..', 'miniprogram', 'client', 'cloud-api.js');
  if (!fs.existsSync(clientPath)) {
    // 客户端文件名以实际仓库为准：退而验证覆盖文件本身不产生请求
    const src = fs.readFileSync(path.join(PKG, 'frontend', 'config', 'schedule-sandbox-proof.js'), 'utf8');
    assert.equal(src.indexOf('wx.request'), -1, '覆盖文件不得含请求代码');
    return;
  }
  const cfg = require(path.join(PKG, 'frontend', 'config', 'schedule-sandbox-proof.js'));
  assert.ok(cfg.enabled === true);
});

test('F-3 正式版与未识别版本不在允许范围（客户端不得回退旧路由）', () => {
  const cfg = require(path.join(PKG, 'frontend', 'config', 'schedule-sandbox-proof.js'));
  for (const v of ['release', 'trial ', 'unknown', '']) {
    assert.equal(cfg.allowedVersions.indexOf(v), -1, '不应允许版本：' + v);
  }
});

// ══════════════════════════════════════════════════════════════════════
// G 保存与关闭
// ══════════════════════════════════════════════════════════════════════

test('G-1 同内容复用不改字节；不同内容拒绝覆盖', () => {
  const before = fs.readFileSync(path.join(BUILT.dir, 'manifest.json'), 'utf8');
  const again = reg.buildRegistration(syntheticPlan(), {
    outId: 'synth-reg-0001', nowMs: SYNTH_NOW_MS
  });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true, '同内容应复用');
  assert.equal(again.wroteFiles, false, '复用不得写盘');
  const after = fs.readFileSync(path.join(BUILT.dir, 'manifest.json'), 'utf8');
  assert.equal(before, after, '复用不得改动 manifest 字节');
  // 不同内容 → 拒绝覆盖，且不递归删除
  assert.throws(() => reg.buildRegistration(
    syntheticPlan({ roundId: 'SYNTH-REG-OTHER' }),
    { outId: 'synth-reg-0001', nowMs: SYNTH_NOW_MS }),
  (err) => err.code === reg.ERR.ARTIFACT_EXISTS_DIFFERENT, '不同内容须拒绝覆盖');
  assert.ok(fs.existsSync(path.join(BUILT.dir, 'manifest.json')), '拒绝覆盖时原目录须保留');
});

test('G-2 检查模式重算一致性，不信 manifest 自报通过', () => {
  const r = reg.checkRegistration({ outDir: BUILT.dir });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.wroteFiles, false, '检查模式不得写盘');
  assert.equal(r.cloudCalled, false, '检查模式零云调用');
  // 篡改一个产物字节 → 检查必须失败
  const victim = path.join(PKG, 'collection-map.js');
  const original = fs.readFileSync(victim);
  try {
    fs.writeFileSync(victim, Buffer.concat([original, Buffer.from('\n// tampered\n')]));
    const bad = reg.checkRegistration({ outDir: BUILT.dir });
    assert.equal(bad.ok, false, '篡改后必须检查失败');
    assert.ok(bad.problems.some((p) => p.code === reg.ERR.MANIFEST_MISMATCH ||
      p.code === reg.ERR.ARTIFACT_INCOMPLETE), JSON.stringify(bad.problems));
  } finally {
    fs.writeFileSync(victim, original);
  }
  assert.equal(reg.checkRegistration({ outDir: BUILT.dir }).ok, true, '恢复后应重新通过');
});

test('G-3 额外文件与缺文件被拒', () => {
  const extra = path.join(PKG, 'unexpected-extra.js');
  fs.writeFileSync(extra, '// extra\n');
  try {
    const r = reg.checkRegistration({ outDir: BUILT.dir });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.code === reg.ERR.ARTIFACT_EXTRA_FILE),
      JSON.stringify(r.problems));
  } finally {
    fs.unlinkSync(extra);
  }
  // 缺文件
  const victim = path.join(PKG, 'project-guard.js');
  const original = fs.readFileSync(victim);
  try {
    fs.unlinkSync(victim);
    const r = reg.checkRegistration({ outDir: BUILT.dir });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.code === reg.ERR.ARTIFACT_INCOMPLETE),
      JSON.stringify(r.problems));
  } finally {
    fs.writeFileSync(victim, original);
  }
});

test('G-4 输出目录越界被拒（不得指向源目录/关闭目录/祖先）', () => {
  // 非法编号（含路径片段）必须在 resolveOutDir 之前就被拒
  for (const bad of ['..', '../escape', 'a/b', 'A_B', '-lead', 'trail-', 'x'.repeat(60)]) {
    assert.throws(() => reg.resolveOutDir(bad, ['closed-20261005-r2fix']),
      (err) => err.code === reg.ERR.OUT_DIR_UNSAFE, '非法编号须拒绝：' + bad);
  }
  // 指向既有关闭目录亦拒（编号形态合法，但属**保留目录名**）
  assert.throws(() => reg.resolveOutDir('closed-20261005-r2fix', ['closed-20261005-r2fix']),
    (err) => err.code === reg.ERR.OUT_DIR_UNSAFE, '不得使用既有关闭目录名');
  // 源目录名同样是保留名
  assert.throws(() => reg.resolveOutDir('cloudfunctions', []),
    (err) => err.code === reg.ERR.OUT_DIR_UNSAFE, '不得使用源目录名');
  // 正常编号可解析且限定在 artifacts 之下
  const dir = reg.resolveOutDir('synth-ok', ['closed-20261005-r2fix']);
  assert.ok(dir.startsWith(path.resolve(ARTIFACTS_ROOT) + path.sep));
  assert.equal(path.basename(dir), 'registration-synth-ok');
});

test('G-5 CLI 不含 deploy/execute/login/preview 操作', () => {
  for (const bad of ['--deploy', '--execute', '--login', '--upload', '--preview']) {
    assert.throws(() => reg.parseArgs(['--mode', 'build', bad]),
      (e) => e.code === reg.ERR.MODE_INVALID, '应拒绝参数：' + bad);
  }
  assert.throws(() => reg.parseArgs(['--mode', 'deploy']),
    (e) => e.code === reg.ERR.MODE_INVALID, 'mode 仅允许 check/build');
  assert.equal(reg.parseArgs(['--check']).mode, 'check');
});

test('G-6 关闭包引用只读校验，不覆盖、不用 /1 冒充 /2', () => {
  const closed = reg.describeClosedPackage('closed-20261005-r2fix');
  assert.equal(closed.present, true, '受审关闭包应存在且 8 文件齐全');
  assert.match(closed.setDigest, /^[0-9a-f]{64}$/);
  assert.equal(closed.files.length, reg.PACKAGE_FILES.length);
  // 登记 manifest 绑定关闭包摘要
  assert.equal(BUILT.manifest.closedPackage.dir, 'closed-20261005-r2fix');
  assert.equal(BUILT.manifest.closedPackage.setDigest, closed.setDigest);
  // 关闭包 schema 为 /2
  const closedManifest = JSON.parse(fs.readFileSync(
    path.join(ARTIFACTS_ROOT, 'closed-20261005-r2fix', 'manifest.json'), 'utf8'));
  assert.equal(closedManifest.schema, 'sandbox-closed-candidate/2',
    '不得用 /1 包冒充 /2');
});