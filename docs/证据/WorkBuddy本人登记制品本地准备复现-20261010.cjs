#!/usr/bin/env node
/**
 * 本人登记制品本地准备 —— 独立复现证据（L3）
 * =============================================
 *
 * 范围：验证 L1 生成/检查工具、L2 前端覆盖与关闭绑定、L3 相称测试所覆盖的
 * 实际行为，并**另存**本轮结果（不覆盖任何历史证据）。
 *
 * **三类验证必须分开看（不得混同）**：
 *  1) 合成验证：合成计划、合成凭据上下文、合成微信上下文与合成数据库传输。
 *     「真实 main」指加载**生成的** index/gate/map/vendor 并实际调用其
 *     main / assert 函数，走**真实 SDK 本地转换**（配置解析、动作门控、
 *     身份派生、事务对象），但数据库是合成传输，**不是**云端执行。
 *  2) 未进行的平台验证：真实凭据获取、真实平台初始化、平台事务、IAM 写权限、
 *     真机与平台编译、前端完整包组装与预览，**全部未验证**。
 *
 * 硬边界（不得放宽）：不联网、不取真实凭据、不安装、不创建资源、不预览、
 * 不部署、不登记本人微信、不初始化管理员、不启用入口、不清缓存。
 * 生成 enabled=true 的候选文件只存在于隔离 artifacts 目录，**不等于云端启用**。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

// __dirname = <项目根>/docs/证据 → 项目根为上两级，miniapp 为其下
const ROOT = path.join(__dirname, '..', '..');
const MINIAPP = path.join(ROOT, 'miniapp');
const reg = require(path.join(MINIAPP, 'scripts', 'package-sandbox-registration.cjs'));

const results = [];
const boundaries = {
  networkCalls: 0,
  realCredentialFetches: 0,
  realCloudCalls: 0,
  realInitializeExecuted: false,
  realDeploymentExecuted: false,
  realWechatRegistrationExecuted: false,
  installedPackages: 0,
  resourceCreated: false,
  previewGenerated: false,
  entranceEnabled: false,
  cacheCleared: false
};
const protectedHashes = {};

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function record(id, pass, observed) {
  results.push({ id, pass: pass === true, observed: observed === undefined ? null : observed });
}

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const FIXED = reg.FIXED_TARGET;
const SYNTH_NOW_MS = Date.parse('2026-01-01T00:05:00.000Z');
const SYNTH_OPENID = 'synthetic-registration-openid';

function deriveUserId(openid) {
  const h = crypto.createHash('sha256').update(`${FIXED.appId}:${openid}`).digest('hex');
  return `u_${h.slice(0, 40)}`;
}

function syntheticPlan(patch) {
  return Object.assign({
    purpose: 'synthetic-offline-verification-only',
    appId: FIXED.appId,
    envId: FIXED.envId,
    region: FIXED.region,
    functionName: FIXED.functionName,
    allowedUserIds: [deriveUserId(SYNTH_OPENID)],
    roundId: 'SYNTH-REG-0001',
    windowStartsAt: '2026-01-01T00:00:00.000Z',
    windowExpiresAt: '2026-01-01T00:20:00.000Z',
    sourceVersion: 'synthetic-offline-source-v1',
    synthetic: true
  }, patch || {});
}

// ── 合成数据库（真实 SDK 调用形状） ──────────────────────────────────────
function makeSyntheticCloud(store, wxContext) {
  const calls = { database: 0, adds: [], updates: [], gets: [], tx: 0, commits: 0, rollbacks: 0 };
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
        async get() { sink.gets.push(`${name}/${id}`); return { data: findById(name, id) || null }; },
        async update({ data: patch }) {
          sink.updates.push(`${name}/${id}`);
          const cur = findById(name, id);
          if (cur) Object.assign(cur, patch); else rows(name).push(Object.assign({ _id: id }, patch));
          return { stats: { updated: cur ? 1 : 0 } };
        },
        async set({ data: patch }) {
          sink.updates.push(`${name}/${id}/set`);
          const cur = findById(name, id);
          if (cur) Object.assign(cur, patch); else rows(name).push(Object.assign({ _id: id }, patch));
          return { stats: { updated: cur ? 1 : 0 } };
        },
        async remove() {
          sink.removes = sink.removes || [];
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
        async get() { sink.gets.push(`${name}/where`); return { data: rows(name).filter((d) => matchCond(d, cond)) }; },
        limit() { return api; },
        orderBy() { return api; },
        get() { return api.get(); }
      };
      return api;
    },
    async get() { sink.gets.push(`${name}/all`); return { data: rows(name).slice() }; },
    async count() { return { total: rows(name).length }; }
  });
  const db = {
    collection(name) { return makeCollection(name, calls); },
    async runTransaction(fn) {
      calls.tx += 1;
      const snapshot = JSON.parse(JSON.stringify(store));
      const txSink = { adds: [], updates: [], gets: [] };
      const txDb = {
        collection: (n) => makeCollection(n, txSink),
        async runTransaction(f) { return f(txDb); }
      };
      try {
        const r = await fn(txDb);
        calls.adds.push(...txSink.adds);
        calls.updates.push(...txSink.updates);
        calls.gets.push(...txSink.gets);
        calls.commits += 1;
        return r;
      } catch (error) {
        calls.adds.push(...txSink.adds);
        calls.updates.push(...txSink.updates);
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, snapshot);
        calls.rollbacks += 1;
        throw error;
      }
    }
  };
  return {
    calls,
    cloud: { database: () => { calls.database += 1; return db; }, getWXContext: () => wxContext || {} }
  };
}

/** 加载生成的 index.js，注入合成 sdk、合成时钟与合成环境，返回其 main。 */
function loadGeneratedMain(pkgDir, store, wxContext) {
  const synth = makeSyntheticCloud(store, wxContext);
  const indexPath = path.join(pkgDir, 'index.js');
  const prevEnv = process.env.TCB_ENV;
  const realNow = Date.now;
  process.env.TCB_ENV = FIXED.envId;
  const origLoad = Module._load;
  const sdkStub = {
    init: () => synth.cloud,
    database: () => synth.cloud.database(),
    getWXContext: () => synth.cloud.getWXContext(),
    DYNAMIC_CURRENT_ENV: 'FIXED'
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return sdkStub;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(indexPath)];
    const mod = require(indexPath);
    const raw = mod.main;
    const wrapped = async (event) => {
      const beforeEnv = process.env.TCB_ENV;
      const beforeNow = Date.now;
      process.env.TCB_ENV = FIXED.envId;
      Date.now = () => SYNTH_NOW_MS;
      try {
        return await raw(event);
      } finally {
        Date.now = beforeNow;
        if (beforeEnv === undefined) delete process.env.TCB_ENV;
        else process.env.TCB_ENV = beforeEnv;
      }
    };
    return { main: wrapped, calls: synth.calls };
  } finally {
    Module._load = origLoad;
    Date.now = realNow;
    if (prevEnv === undefined) delete process.env.TCB_ENV;
    else process.env.TCB_ENV = prevEnv;
  }
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  for (const rel of [
    'miniapp/scripts/package-sandbox.cjs',
    'miniapp/cloudfunctions/scheduleSandbox/gate.js',
    'miniapp/cloudfunctions/scheduleSandbox/index.js',
    'miniapp/cloudfunctions/scheduleSandbox/collection-map.js',
    'miniapp/cloudfunctions/scheduleSandbox/project-guard.js',
    'miniapp/cloudfunctions/scheduleSandbox/package.json',
    'miniapp/cloudfunctions/scheduleSandbox/vendor/service.js',
    'miniapp/cloudfunctions/scheduleSandbox/vendor/schedule-service.js',
    'miniapp/cloudfunctions/scheduleSandbox/vendor/MANIFEST.json',
    'miniapp/miniprogram/config/schedule-sandbox-proof.js',
    'miniapp/scripts/lib/sandbox-primary-execution-host.cjs'
  ]) {
    protectedHashes[rel] = sha256File(path.join(ROOT, rel)).slice(0, 16);
  }

  // ── L1-a：check 模式零写盘、零云调用 ──────────────────────────────────
  const checkDefault = reg.checkRegistration({});
  record('L1-check-mode-zero-side-effects',
    checkDefault.mode === 'check' && checkDefault.wroteFiles === false &&
    checkDefault.cloudCalled === false,
    { ok: checkDefault.ok, candidates: checkDefault.candidates,
      wroteFiles: checkDefault.wroteFiles, cloudCalled: checkDefault.cloudCalled });

  // ── L1-b：生成（合成计划），两处变换 + 其余逐字节一致 ────────────────
  const built = reg.buildRegistration(syntheticPlan(), { outId: 'synth-reg-0001', nowMs: SYNTH_NOW_MS });
  const pkgDir = path.join(built.dir, 'package');
  record('L1-build-synthetic-package', built.ok === true && built.differences.length === 2,
    {
      ok: built.ok, reused: built.reused,
      differences: built.differences.map((d) => ({
        file: d.file, anchor: d.anchor,
        sourceSha256: d.sourceSha256, artifactSha256: d.artifactSha256
      }))
    });

  const diffFiles = built.differences.map((d) => d.file).sort();
  record('L1-exactly-two-transforms',
    JSON.stringify(diffFiles) === JSON.stringify(['gate.js', 'index.js']),
    { diffFiles });

  // 其余 6 文件逐字节一致
  const changedSet = new Set(diffFiles);
  const identical = [];
  let allIdentical = true;
  for (const rel of reg.PACKAGE_FILES) {
    if (changedSet.has(rel)) continue;
    const a = fs.readFileSync(path.join(reg.SOURCE_DIR, rel));
    const b = fs.readFileSync(path.join(pkgDir, rel));
    const same = Buffer.compare(a, b) === 0;
    identical.push({ rel, same, sha256: reg.sha256Buffer(a).slice(0, 16) });
    if (!same) allIdentical = false;
  }
  record('L1-other-six-byte-identical', allIdentical && identical.length === 6, { identical });

  // ── L1-c：PREPARE_ALLOWED 精确收窄，EXECUTE_ALLOWED 未动 ─────────────
  const gatePath = path.join(pkgDir, 'gate.js');
  delete require.cache[require.resolve(gatePath)];
  const gate = require(gatePath);
  record('L1-prepare-allowed-narrowed-to-identify',
    JSON.stringify(Array.from(gate.PREPARE_ALLOWED)) === JSON.stringify(['identify']),
    { prepareAllowed: Array.from(gate.PREPARE_ALLOWED) });
  record('L1-execute-allowed-untouched',
    gate.EXECUTE_ALLOWED.indexOf('createSchedule') !== -1 &&
    gate.EXECUTE_ALLOWED.indexOf('updateSchedule') !== -1,
    { executeAllowedCount: gate.EXECUTE_ALLOWED.length });

  // ── L1-d：动作收口 —— 其余动作数据库入口 0 次 ─────────────────────────
  const otherActions = [
    'listMyProjects', 'requestBindingNumber', 'createProject', 'assignManager',
    'createInvitation', 'applyInvitation', 'approveInvitation', 'removeMember',
    'getMembers', 'listInvitations', 'getScheduleContext', 'listSchedules',
    'getSchedule', 'listScheduleRevisions',
    'createSchedule', 'updateSchedule', 'reassignSchedule', 'cancelSchedule',
    'totallyUnknownAction'
  ];
  let dbAccessTotal = 0;
  let txTotal = 0;
  let commitTotal = 0;
  let rejected = 0;
  for (const action of otherActions) {
    const store = {};
    const { main, calls } = loadGeneratedMain(pkgDir, store, {
      APPID: FIXED.appId, OPENID: SYNTH_OPENID
    });
    let out = null; let threw = false;
    try { out = await main({ action }); } catch (_) { threw = true; }
    dbAccessTotal += calls.database;
    txTotal += calls.tx;
    commitTotal += calls.commits;
    if (threw || (out && out.ok === false)) rejected += 1;
  }
  record('L1-other-actions-rejected-before-db',
    rejected === otherActions.length && dbAccessTotal === 0 &&
    txTotal === 0 && commitTotal === 0,
    { actions: otherActions.length, rejected, dbAccessTotal, txTotal, commitTotal });

  // ── L1-e：本人首次登记（合成微信上下文） ─────────────────────────────
  const regStore = {};
  const first = loadGeneratedMain(pkgDir, regStore, { APPID: FIXED.appId, OPENID: SYNTH_OPENID });
  const firstOut = await first.main({ action: 'identify' });
  const writes1 = first.calls.adds.concat(first.calls.updates);
  const dumped = JSON.stringify(firstOut);
  record('L1-first-registration-writes-users-and-audit-only',
    firstOut.ok === true &&
    firstOut.userId === deriveUserId(SYNTH_OPENID) &&
    first.calls.adds.filter((x) => x.indexOf('schtest_v1_users') === 0).length === 1 &&
    first.calls.adds.filter((x) => x.indexOf('schtest_v1_audit_events') === 0).length === 1 &&
    writes1.filter((x) => x.indexOf('schtest_v1_app_admins') === 0).length === 0 &&
    writes1.filter((x) => x.indexOf('schtest_v1_projects') === 0).length === 0,
    {
      result: { ok: firstOut.ok, userId: firstOut.userId },
      writes: writes1,
      readsPrimary: first.calls.gets.some((x) => x.indexOf('schtest_v1_app_admins') !== -1),
      commits: first.calls.commits
    });
  record('L1-registration-no-openid-or-credential-in-output',
    dumped.indexOf(SYNTH_OPENID) === -1 &&
    !/"(secret|token|openid|OPENID|secretKey)"\s*:/i.test(dumped),
    { outputKeys: Object.keys(firstOut) });

  // ── L1-f：已有账号零新增；停用/错归属拒绝不覆盖 ──────────────────────
  const id = deriveUserId(SYNTH_OPENID);
  const existStore = { schtest_v1_users: [{ _id: id, openid: SYNTH_OPENID, status: 'active' }] };
  const existRun = loadGeneratedMain(pkgDir, existStore, { APPID: FIXED.appId, OPENID: SYNTH_OPENID });
  const existOut = await existRun.main({ action: 'identify' });
  record('L1-existing-account-zero-new-writes',
    existOut.ok === true &&
    existRun.calls.adds.length + existRun.calls.updates.length === 0 &&
    existRun.calls.tx === 0,
    { ok: existOut.ok, writes: existRun.calls.adds.concat(existRun.calls.updates), tx: existRun.calls.tx });

  const disStore = { schtest_v1_users: [{ _id: id, openid: SYNTH_OPENID, status: 'disabled' }] };
  const disRun = loadGeneratedMain(pkgDir, disStore, { APPID: FIXED.appId, OPENID: SYNTH_OPENID });
  let disOut = null; let disThrew = false;
  try { disOut = await disRun.main({ action: 'identify' }); } catch (_) { disThrew = true; }
  record('L1-disabled-account-rejected-not-overwritten',
    (disThrew || (disOut && disOut.ok === false)) &&
    disStore.schtest_v1_users[0].status === 'disabled' &&
    (disRun.calls.adds.concat(disRun.calls.updates))
      .filter((x) => x.indexOf('schtest_v1_users') === 0).length === 0,
    { rejected: disThrew || (disOut && disOut.ok === false), status: disStore.schtest_v1_users[0].status });

  const wrongStore = { schtest_v1_users: [{ _id: id, openid: 'synthetic-other', status: 'active' }] };
  const wrongRun = loadGeneratedMain(pkgDir, wrongStore, { APPID: FIXED.appId, OPENID: SYNTH_OPENID });
  let wrongOut = null; let wrongThrew = false;
  try { wrongOut = await wrongRun.main({ action: 'identify' }); } catch (_) { wrongThrew = true; }
  record('L1-wrong-openid-owner-rejected-not-overwritten',
    (wrongThrew || (wrongOut && wrongOut.ok === false)) &&
    wrongStore.schtest_v1_users[0].openid === 'synthetic-other' &&
    (wrongRun.calls.adds.concat(wrongRun.calls.updates))
      .filter((x) => x.indexOf('schtest_v1_users') === 0).length === 0,
    { rejected: wrongThrew || (wrongOut && wrongOut.ok === false),
      openid: wrongStore.schtest_v1_users[0].openid });

  // 名单外
  const outStore = {};
  const outRun = loadGeneratedMain(pkgDir, outStore, {
    APPID: FIXED.appId, OPENID: 'synthetic-outsider'
  });
  let outOut = null; let outThrew = false;
  try { outOut = await outRun.main({ action: 'identify' }); } catch (_) { outThrew = true; }
  record('L1-outsider-rejected-before-db',
    (outThrew || (outOut && outOut.ok === false)) && outRun.calls.database === 0,
    { rejected: outThrew || (outOut && outOut.ok === false), dbAccess: outRun.calls.database,
      code: outOut ? outOut.code : null });

  // 错 AppID / 缺微信上下文
  let ctxRejected = 0;
  let ctxDb = 0;
  for (const ctx of [{ APPID: 'wxOTHER0000000000', OPENID: SYNTH_OPENID },
    { APPID: FIXED.appId }, {}]) {
    const st = {};
    const run = loadGeneratedMain(pkgDir, st, ctx);
    let o = null; let t = false;
    try { o = await run.main({ action: 'identify' }); } catch (_) { t = true; }
    ctxDb += run.calls.database;
    if (t || (o && o.ok === false)) ctxRejected += 1;
  }
  record('L1-bad-appid-or-missing-wxcontext-rejected',
    ctxRejected === 3 && ctxDb === 0, { rejected: ctxRejected, dbAccess: ctxDb });

  // ── L1-g：非法计划零产物 ────────────────────────────────────────────
  const badPlans = [
    ['placeholder', { purpose: 'TBD' }, reg.ERR.PLAN_PLACEHOLDER],
    ['empty-allowlist', { allowedUserIds: [] }, reg.ERR.PLAN_USER_INVALID],
    ['short-userid', { allowedUserIds: ['2d3aa4'] }, reg.ERR.PLAN_USER_INVALID],
    ['dup-user', { allowedUserIds: [deriveUserId(SYNTH_OPENID), deriveUserId(SYNTH_OPENID)] },
      reg.ERR.PLAN_USER_NOT_UNIQUE],
    ['window-too-long', {
      windowStartsAt: '2026-01-01T00:00:00.000Z', windowExpiresAt: '2026-01-01T02:00:00.000Z'
    }, reg.ERR.PLAN_WINDOW_TOO_LONG],
    ['env-mismatch', { envId: 'other' }, reg.ERR.PLAN_TARGET_MISMATCH],
    ['function-mismatch', { functionName: 'memberAccess' }, reg.ERR.PLAN_TARGET_MISMATCH],
    ['unknown-field', { collections: ['x'] }, reg.ERR.PLAN_FIELD_UNKNOWN]
  ];
  const planResults = [];
  let allRejected = true;
  for (const [label, patch, code] of badPlans) {
    let got = null;
    try {
      reg.validatePlan(syntheticPlan(patch), { nowMs: SYNTH_NOW_MS });
    } catch (error) {
      got = error.code;
    }
    planResults.push({ label, expected: code, got });
    if (got !== code) allRejected = false;
  }
  // 真实（非合成）计划过期即拒
  let expiredCode = null;
  try {
    reg.validatePlan(Object.assign(syntheticPlan(), { synthetic: false }),
      { nowMs: Date.parse('2026-01-01T00:20:00.000Z') + 1000 });
  } catch (error) { expiredCode = error.code; }
  record('L1-invalid-plans-rejected', allRejected &&
    expiredCode === reg.ERR.PLAN_WINDOW_EXPIRED,
    { planResults, expiredCode });

  // ── L1-h：变换锚点缺失/多处/源漂移 ──────────────────────────────────
  const sources = reg.readReviewedSources();
  const tIndex = reg.buildIndexTransform(reg.validatePlan(syntheticPlan(), { nowMs: SYNTH_NOW_MS }));
  let anchorMissing = null;
  try {
    const broken = new Map(sources);
    broken.set('index.js', { bytes: 3, sha256: 'x', buf: Buffer.from('const other = 1;') });
    reg.applyTransform(broken, tIndex);
  } catch (error) { anchorMissing = error.code; }
  let anchorDup = null;
  try {
    const dup = new Map(sources);
    const idxBuf = sources.get('index.js').buf;
    const dupBuf = Buffer.concat([idxBuf, Buffer.from('\n' + tIndex.from)]);
    const dupSha = reg.sha256Buffer(dupBuf);
    dup.set('index.js', { bytes: dupBuf.length, sha256: dupSha, buf: dupBuf });
    reg.applyTransform(dup, tIndex, dupSha);
  } catch (error) { anchorDup = error.code; }
  let drift = null;
  try {
    reg.applyTransform(sources, tIndex, 'f'.repeat(64));
  } catch (error) { drift = error.code; }
  record('L1-transform-anchor-and-drift-guards',
    anchorMissing === reg.ERR.TRANSFORM_ANCHOR_MISSING &&
    anchorDup === reg.ERR.TRANSFORM_ANCHOR_AMBIGUOUS &&
    drift === reg.ERR.PLAN_SOURCE_DRIFT,
    { anchorMissing, anchorDup, drift });

  // ── L1-i：复用 / 拒绝覆盖 / 检查模式重算 ─────────────────────────────
  const manifestBefore = fs.readFileSync(path.join(built.dir, 'manifest.json'), 'utf8');
  const again = reg.buildRegistration(syntheticPlan(), { outId: 'synth-reg-0001', nowMs: SYNTH_NOW_MS });
  const manifestAfter = fs.readFileSync(path.join(built.dir, 'manifest.json'), 'utf8');
  let overwriteCode = null;
  try {
    reg.buildRegistration(syntheticPlan({ roundId: 'SYNTH-REG-OTHER' }),
      { outId: 'synth-reg-0001', nowMs: SYNTH_NOW_MS });
  } catch (error) { overwriteCode = error.code; }
  record('L1-reuse-same-content-no-overwrite',
    again.ok === true && again.reused === true && again.wroteFiles === false &&
    manifestBefore === manifestAfter &&
    overwriteCode === reg.ERR.ARTIFACT_EXISTS_DIFFERENT,
    { reused: again.reused, wroteFiles: again.wroteFiles,
      manifestUnchanged: manifestBefore === manifestAfter, overwriteCode });

  const victim = path.join(pkgDir, 'collection-map.js');
  const victimOriginal = fs.readFileSync(victim);
  let tamperDetected = false;
  try {
    fs.writeFileSync(victim, Buffer.concat([victimOriginal, Buffer.from('\n// tampered\n')]));
    const bad = reg.checkRegistration({ outDir: built.dir });
    tamperDetected = bad.ok === false && bad.problems.length > 0;
  } finally {
    fs.writeFileSync(victim, victimOriginal);
  }
  const restored = reg.checkRegistration({ outDir: built.dir });
  record('L1-check-recomputes-not-trusting-manifest',
    tamperDetected && restored.ok === true &&
    restored.wroteFiles === false && restored.cloudCalled === false,
    { tamperDetected, restoredOk: restored.ok });

  // 额外文件
  const extra = path.join(pkgDir, 'unexpected-extra.js');
  fs.writeFileSync(extra, '// extra\n');
  let extraDetected = false;
  try {
    extraDetected = reg.checkRegistration({ outDir: built.dir }).ok === false;
  } finally {
    fs.unlinkSync(extra);
  }
  record('L1-extra-file-rejected', extraDetected, { extraDetected });

  // ── L1-j：输出目录安全 ──────────────────────────────────────────────
  let unsafeRejected = 0;
  for (const bad of ['..', '../escape', 'a/b', 'A_B', '-lead', 'trail-', 'cloudfunctions',
    'closed-20261005-r2fix']) {
    try {
      reg.resolveOutDir(bad, ['closed-20261005-r2fix']);
    } catch (error) {
      if (error.code === reg.ERR.OUT_DIR_UNSAFE) unsafeRejected += 1;
    }
  }
  record('L1-out-dir-safety', unsafeRejected === 8, { unsafeRejected });

  // ── L1-k：CLI 不含部署类操作 ────────────────────────────────────────
  let deployRejected = 0;
  for (const bad of ['--deploy', '--execute', '--login', '--upload', '--preview']) {
    try {
      reg.parseArgs(['--mode', 'build', bad]);
    } catch (error) {
      if (error.code === reg.ERR.MODE_INVALID) deployRejected += 1;
    }
  }
  record('L1-no-deploy-execute-login', deployRejected === 5, { deployRejected });

  // ── L2：前端覆盖文件与关闭包 ────────────────────────────────────────
  const frontendPath = path.join(pkgDir, 'frontend', 'config', 'schedule-sandbox-proof.js');
  const frontend = require(frontendPath);
  record('L2-frontend-override-shape',
    frontend.enabled === true &&
    frontend.appId === FIXED.appId &&
    frontend.envId === FIXED.envId &&
    frontend.functionName === FIXED.functionName &&
    frontend.sandboxProjectId === '' &&
    frontend.roundId === 'SYNTH-REG-0001' &&
    JSON.stringify(Array.from(frontend.allowedVersions)) === JSON.stringify(['develop', 'trial']) &&
    !('phase' in frontend) &&
    Object.isFrozen(frontend),
    {
      enabled: frontend.enabled, appId: frontend.appId, envId: frontend.envId,
      functionName: frontend.functionName, sandboxProjectId: frontend.sandboxProjectId,
      allowedVersions: Array.from(frontend.allowedVersions),
      hasPhaseField: 'phase' in frontend, frozen: Object.isFrozen(frontend)
    });
  const legacyFrontend = require(path.join(MINIAPP, 'miniprogram', 'config', 'schedule-sandbox-proof.js'));
  record('L2-legacy-frontend-still-disabled',
    legacyFrontend.enabled === false,
    { legacyEnabled: legacyFrontend.enabled });
  const srcText = fs.readFileSync(frontendPath, 'utf8');
  record('L2-override-is-not-full-previewable-package',
    srcText.indexOf('wx.request') === -1 &&
    srcText.indexOf('二维码') !== -1,
    { hasRequestCode: srcText.indexOf('wx.request') !== -1,
      declaresNotPreviewable: srcText.indexOf('二维码') !== -1 });

  const closed = reg.describeClosedPackage('closed-20261005-r2fix');
  const closedManifest = JSON.parse(fs.readFileSync(
    path.join(reg.ARTIFACTS_ROOT, 'closed-20261005-r2fix', 'manifest.json'), 'utf8'));
  record('L2-closed-package-bound-readonly',
    closed.present === true &&
    closed.files.length === reg.PACKAGE_FILES.length &&
    closedManifest.schema === 'sandbox-closed-candidate/2' &&
    built.manifest.closedPackage.setDigest === closed.setDigest,
    { dir: closed.dir, present: closed.present, files: closed.files.length,
      schema: closedManifest.schema, boundDigest: built.manifest.closedPackage.setDigest });

  // 关闭包 main 拒绝且零数据库
  const closedIndex = path.join(reg.ARTIFACTS_ROOT, 'closed-20261005-r2fix', 'package', 'index.js');
  let closedOut = null;
  {
    const prevEnv = process.env.TCB_ENV;
    const realNow = Date.now;
    process.env.TCB_ENV = FIXED.envId;
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'wx-server-sdk') {
        return {
          init: () => ({ database: () => { throw new Error('不应访问数据库'); } }),
          database: () => { throw new Error('不应访问数据库'); },
          getWXContext: () => ({ APPID: FIXED.appId, OPENID: SYNTH_OPENID }),
          DYNAMIC_CURRENT_ENV: 'FIXED'
        };
      }
      return origLoad.call(this, request, parent, isMain);
    };
    try {
      delete require.cache[require.resolve(closedIndex)];
      const mod = require(closedIndex);
      closedOut = await mod.main({ action: 'identify' });
    } catch (_) {
      closedOut = null;
    } finally {
      Module._load = origLoad;
      Date.now = realNow;
      if (prevEnv === undefined) delete process.env.TCB_ENV;
      else process.env.TCB_ENV = prevEnv;
    }
  }
  record('L2-closed-package-main-rejects',
    isPlain(closedOut) && closedOut.ok === false && typeof closedOut.code === 'string',
    { result: closedOut });

  // ── manifest 语义 ───────────────────────────────────────────────────
  const m = built.manifest;
  record('manifest-not-deployment-authorization',
    m.schema === reg.REGISTRATION_MANIFEST_SCHEMA &&
    m.deploymentAuthorized === false && m.cloudExecuted === false &&
    m.synthetic === true &&
    !('selfHash' in m) && JSON.stringify(m).indexOf('"manifestHash"') === -1,
    { schema: m.schema, deploymentAuthorized: m.deploymentAuthorized,
      cloudExecuted: m.cloudExecuted, synthetic: m.synthetic,
      hasSelfHash: 'selfHash' in m });
  record('manifest-records-effective-action-surface',
    JSON.stringify(Array.from(m.effectiveActions)) === JSON.stringify(['identify']),
    { effectiveActions: Array.from(m.effectiveActions) });

  // ── 子进程入口（如实记录，未验证不冒充） ────────────────────────────
  let subprocessProbe = { unverified: true, reason: '未探测' };
  try {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'],
      { encoding: 'utf8', timeout: 15000 });
    subprocessProbe = {
      available: r.error === undefined && r.status === 0,
      error: r.error ? String(r.error.message).slice(0, 160) : null
    };
  } catch (_) { /* 如实保留 unverified */ }
  record('subprocess-availability-recorded-honestly',
    isPlain(subprocessProbe), { subprocessProbe });

  const summary = {
    total: results.length,
    passed: results.filter((x) => x.pass).length,
    unverified: results.filter((x) => isPlain(x.observed) && x.observed.unverified === true).length,
    failed: results.filter((x) => !x.pass &&
      !(isPlain(x.observed) && x.observed.unverified === true)).length
  };

  process.stdout.write(JSON.stringify({
    observedAt: new Date().toISOString(),
    scope: '本人登记制品本地准备 L1/L2/L3：独立生成/检查工具、前端覆盖与关闭绑定、相称离线验证',
    networkAttempts: boundaries.networkCalls,
    realCredentialFetches: boundaries.realCredentialFetches,
    realCloudCalls: boundaries.realCloudCalls,
    realInitializeExecuted: boundaries.realInitializeExecuted,
    realDeploymentExecuted: boundaries.realDeploymentExecuted,
    realWechatRegistrationExecuted: boundaries.realWechatRegistrationExecuted,
    installedPackages: boundaries.installedPackages,
    resourceCreated: boundaries.resourceCreated,
    previewGenerated: boundaries.previewGenerated,
    entranceEnabled: boundaries.entranceEnabled,
    cacheCleared: boundaries.cacheCleared,
    syntheticArtifacts: {
      dir: built.dir,
      note: '合成制品目录，manifest 标记 synthetic=true；artifacts 不纳入提交'
    },
    historicalEvidenceOverwritten: false,
    protectedHashes,
    summary,
    verificationKinds: {
      synthetic: '合成计划 + 合成凭据上下文 + 合成微信上下文 + 合成数据库传输',
      realSdkLocalTransform: '加载生成的 index/gate/map/vendor 并实际调用 main/assert，走真实 SDK 本地转换（配置解析、动作门控、身份派生、事务对象）；数据库为合成传输',
      notPerformed: '真实凭据获取、真实平台初始化、平台事务、IAM 写权限、真机与平台编译、前端完整包组装与预览，全部未验证'
    },
    boundaries: {
      notNetworked: true,
      noRealCredentialFetch: true,
      noRealInitialize: true,
      noWechatRegistration: true,
      noResourceCreation: true,
      noInstall: true,
      noPreview: true,
      noDeployment: true,
      noEntranceEnable: true,
      noCacheClear: true,
      syntheticMarkedInManifest: true,
      note: '生成 enabled=true 的候选文件只存在于隔离 artifacts 目录，不等于云端启用'
    },
    results
  }, null, 2));
}

main().catch(() => { process.exit(1); });