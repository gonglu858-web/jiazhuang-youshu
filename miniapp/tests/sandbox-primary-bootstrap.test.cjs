// P4 首次管理员初始化事务核心与本地 CLI 的离线测试。
//
// 依据：任务文档 §8「P4 核心」与 Codex 复核 R5（固定身份、环境与时效）。
//
// 重要边界（必须分开表述）：
// - 本文件用**注入的模拟适配器**验证原子性与回滚语义。
// - 这**不等于**真实平台事务已验证：真实管理 SDK 的认证、环境绑定与
//   事务缺失读取/冲突行为**未核实**。
// - 本文件**不做**任何真实初始化；primary 在测试存储中建立，生产未建立。
// - 夹具提供**逐键读集冲突检测**，不是串行假事务。
// - 受控批准上下文里的 userId 与 OPENID 都是**合成测试数据**，不是真实凭据。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 宿主级 spawn 故障判定。
 *
 * 本机实测：node 进程内 spawnSync **任何**可执行文件（含 bash）都会返回
 * EBUSY，status/signal 均为 null —— 这是宿主的进程创建被占用，
 * **不是**被测代码的行为，也无法靠重试消除。
 * 命中时下方用例按 t.skip 明确标注「未验证」，不冒充通过。
 */
const HOST_SPAWN_CODES = ['EBUSY', 'EPERM', 'EAGAIN', 'ENOMEM'];

/**
 * 调用 CLI 并返回 { failed, out, hostSpawnError }。
 * 宿主级 spawn 故障时 hostSpawnError 为真，调用方必须显式 skip。
 */
function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [CLI_PATH].concat(args), { encoding: 'utf8', stdio: 'pipe' });
    return { failed: false, out: String(out), hostSpawnError: false, spawnCode: null };
  } catch (error) {
    const code = error && error.code ? String(error.code) : 'unknown';
    const hostSpawnError = HOST_SPAWN_CODES.indexOf(code) >= 0 && error.status === null;
    return {
      failed: true,
      out: String((error && error.stdout) || '') + String((error && error.stderr) || ''),
      hostSpawnError,
      spawnCode: code
    };
  }
}

const bootstrap = require('../scripts/lib/sandbox-primary-bootstrap.cjs');

const APP_ID = bootstrap.FIXED_APP_ID;
const ENV_ID = bootstrap.FIXED_ENV_ID;
const CLI_PATH = path.join(__dirname, '..', 'scripts', 'prepare-sandbox-primary.cjs');

const FIXED_NOW = 1760000000000;

/**
 * 合成 OPENID 与其派生 userId（按已验收 service 契约）。
 * 明确是**测试夹具数据**，不来自任何真实账号。
 */
const OWNER_OPENID = 'synthetic-openid-for-owner-fixture-only';
const OWNER = bootstrap.deriveUserId(APP_ID, OWNER_OPENID);
const OTHER_OPENID = 'synthetic-openid-for-other-fixture-only';
const OTHER = bootstrap.deriveUserId(APP_ID, OTHER_OPENID);

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** 受控批准上下文（合成：仅测试用，不接 IAM、不接真实 SDK）。 */
function goodApproval(overrides) {
  return Object.assign({
    approvedUserIds: [OWNER],
    approvedBy: 'synthetic-approver-fixture',
    approvedAt: '2026-10-05T00:00:00Z'
  }, overrides || {});
}

function goodPlan(overrides) {
  return Object.assign({
    enabled: true,
    appId: APP_ID,
    envId: ENV_ID,
    roundId: 'round-2026-10-05-p4',
    targetUserId: OWNER,
    evidenceId: 'ev-p4-001',
    expiresAt: '2030-01-01T00:00:00Z',
    schemaVersion: 1,
    operatorRef: 'operator-ref-1',
    approvedOwnerHint: '2d3aa4'
  }, overrides || {});
}

/** 默认用户记录：_id / status / openid 三者自洽。 */
function ownerRecord(overrides) {
  return Object.assign({ _id: OWNER, status: 'active', openid: OWNER_OPENID }, overrides || {});
}

/**
 * 模拟适配器：**逐键读集冲突检测**的事务内存实现。
 */
function makeAdapter(options) {
  const opts = options || {};
  const data = {
    'schtest_v1_users': opts.users || { [OWNER]: ownerRecord() },
    'schtest_v1_app_admins': opts.appAdmins || {},
    'schtest_v1_audit_events': opts.audits || {}
  };
  let version = 0;
  let currentKeyVersion = 0;
  let txSeq = 0;
  const keyVersions = new Map();
  const commits = [];
  let failAt = opts.failAt || '';
  // 写入故障与回滚故障分开注入，便于组合「写失败且回滚也失败」
  const failWriteAt = opts.failWriteAt || failAt;
  const failRollbackAt = opts.failRollbackAt || (opts.failAt === 'rollback' ? 'rollback' : '');
  let conflictEnabled = opts.conflictEnabled !== false;
  const readSets = new Map();

  function snapshot() {
    return JSON.parse(JSON.stringify(data));
  }

  const adapter = {
    __data: data,
    __commits: commits,
    __snapshot: snapshot,
    __version: () => version,

    async verifyCaller() {
      if (opts.callerAllowed === false) return { allowed: false };
      return {
        allowed: true,
        operatorRef: 'operator-ref-1',
        trusted: opts.trusted === true,
        // 固定环境回执：调用方必须与核心常量一致
        appId: opts.callerAppId === undefined ? APP_ID : opts.callerAppId,
        envId: opts.callerEnvId === undefined ? ENV_ID : opts.callerEnvId
      };
    },

    async beginTransaction() {
      // 事务 ID 必须**唯一**：否则并发事务会互相覆盖读集。
      txSeq++;
      const tx = { id: `tx-${txSeq}`, writes: new Map(), reads: new Map(), baseVersion: version, done: false };
      if (conflictEnabled) readSets.set(tx.id, tx);
      return tx;
    },

    async getDoc(tx, collection, key) {
      if (tx.done) throw new Error('事务已结束');
      if (readSets.has(tx.id)) {
        const rs = readSets.get(tx.id);
        const mapKey = `${collection}:${key}`;
        if (!rs.reads.has(mapKey)) {
          const current = keyVersions.get(mapKey);
          rs.reads.set(mapKey, current === undefined ? -1 : current);
        }
      }
      const bucket = data[collection];
      return bucket && bucket[key] ? clone(bucket[key]) : null;
    },

    async setDoc(tx, collection, key, value) {
      if (tx.done) throw new Error('事务已结束');
      if (failWriteAt === `set:${collection}`) throw new Error(`注入故障：写 ${collection} 失败`);
      tx.writes.set(`${collection}:${key}`, { collection, key, value: clone(value) });
    },

    async commit(tx) {
      if (tx.done) throw new Error('事务已结束');
      if (failWriteAt === 'commit') throw new Error('注入故障：提交失败');
      if (readSets.has(tx.id)) {
        const rs = readSets.get(tx.id);
        for (const [mapKey, seenVersion] of rs.reads.entries()) {
          const current = keyVersions.has(mapKey) ? keyVersions.get(mapKey) : -1;
          if (current !== seenVersion) {
            tx.done = true;
            readSets.delete(tx.id);
            throw new Error('TRANSACTION_CONFLICT');
          }
        }
      }
      for (const w of tx.writes.values()) {
        data[w.collection][w.key] = clone(w.value);
        keyVersions.set(`${w.collection}:${w.key}`, currentKeyVersion);
        currentKeyVersion++;
      }
      version++;
      tx.done = true;
      readSets.delete(tx.id);
      commits.push({ id: tx.id, wrote: [...tx.writes.values()].map(w => `${w.collection}:${w.key}`) });
    },

    async rollback(tx) {
      if (failRollbackAt === 'rollback') throw new Error('注入故障：回滚失败');
      if (tx) { tx.done = true; tx.writes.clear(); readSets.delete(tx.id); }
    },

    async readOnlyGet(collection, key) {
      return data[collection] && data[collection][key] ? clone(data[collection][key]) : null;
    }
  };
  return adapter;
}

function run(adapter, planOverrides, approvalOverrides, extra) {
  return bootstrap.initializePrimary(Object.assign({
    plan: goodPlan(planOverrides),
    approval: goodApproval(approvalOverrides),
    adapter,
    nowMs: FIXED_NOW,
    fixedNowMs: FIXED_NOW
  }, extra || {}));
}

// ── 受控批准上下文（R5）──────────────────────────────────────────────────

test('R5-1 缺受控批准上下文 → 拒绝且零写入（尾号提示不是授权）', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => bootstrap.initializePrimary({ plan: goodPlan(), adapter, nowMs: FIXED_NOW }),
    /缺少受控批准上下文/
  );
  assert.equal(adapter.__commits.length, 0);
});

test('R5-2 批准上下文不合法 → 拒绝', () => {
  for (const bad of [
    null,
    { approvedUserIds: [], approvedBy: 'x', approvedAt: '2026-10-05T00:00:00Z' },
    { approvedUserIds: ['2d3aa4'], approvedBy: 'x', approvedAt: '2026-10-05T00:00:00Z' },
    { approvedUserIds: [OWNER], approvedBy: '', approvedAt: '2026-10-05T00:00:00Z' },
    { approvedUserIds: [OWNER], approvedBy: 'x', approvedAt: 'not-a-date' }
  ]) {
    assert.throws(() => bootstrap.validateApprovalContext(bad), /受控批准上下文/);
  }
});

test('R5-3 目标不在受控批准名单 → 拒绝且零写入', async () => {
  const adapter = makeAdapter({
    users: { [OWNER]: ownerRecord(), [OTHER]: ownerRecord({ _id: OTHER, openid: OTHER_OPENID }) }
  });
  await assert.rejects(
    () => run(adapter, { targetUserId: OTHER }),
    /不在受控批准名单内/
  );
  assert.equal(adapter.__commits.length, 0, '未批准目标不得提交');
  assert.equal(adapter.__data['schtest_v1_app_admins'].primary, undefined);
});

test('R5-4 尾号提示与受审名单无关：名单换成别人后原目标被拒', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => run(adapter, {}, { approvedUserIds: [OTHER] }),
    /不在受控批准名单内/
  );
  assert.equal(adapter.__commits.length, 0);
});

// ── 固定环境（R5：核心自约束，不与调用方比较）────────────────────────────

test('R5-5 调用方与计划同时改成同一错误环境 → 仍拒绝', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => bootstrap.initializePrimary({
      plan: goodPlan({ appId: 'wx_other', envId: 'env_other' }),
      approval: goodApproval(),
      adapter,
      appId: 'wx_other',
      envId: 'env_other',
      nowMs: FIXED_NOW
    }),
    /初始化计划不合法/
  );
  assert.equal(adapter.__commits.length, 0, '双错环境不得提交');
});

test('R5-6 调用者回执环境与固定环境不符 → 拒绝', async () => {
  for (const bad of [{ callerAppId: 'wx_other' }, { callerEnvId: 'env_other' }]) {
    const adapter = makeAdapter(bad);
    await assert.rejects(() => run(adapter), /环境与固定/);
    assert.equal(adapter.__commits.length, 0);
  }
});

// ── 时效（R5：默认当前时钟；首写前再核验）───────────────────────────────

test('R5-7 不传时钟 + 已过期计划 → 拒绝且零写入', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => bootstrap.initializePrimary({
      plan: goodPlan({ expiresAt: '2020-01-01T00:00:00Z' }),
      approval: goodApproval(),
      adapter
    }),
    /初始化计划不合法/
  );
  assert.equal(adapter.__commits.length, 0);
});

test('R5-8 不传时钟 + 有效计划 → 按当前时间通过（证明默认用当前时钟）', async () => {
  const adapter = makeAdapter();
  const result = await bootstrap.initializePrimary({
    plan: goodPlan({ expiresAt: '2030-01-01T00:00:00Z' }),
    approval: goodApproval(),
    adapter
  });
  assert.equal(result.granted, true);
  const audit = await adapter.readOnlyGet('schtest_v1_audit_events', result.auditId);
  // createdAt 落在「当前时钟」附近而不是 FIXED_NOW
  const created = Date.parse(audit.createdAt);
  assert.ok(Math.abs(created - Date.now()) < 60000, '审计时间应来自当前时钟');
});

test('R5-9 注入时钟必须是有效有限值', async () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, '123', 999999999999999]) {
    const adapter = makeAdapter();
    await assert.rejects(
      () => bootstrap.initializePrimary({
        plan: goodPlan(), approval: goodApproval(), adapter, nowMs: bad
      }),
      /时钟/,
      `nowMs=${String(bad)} 必须被拒`
    );
    assert.equal(adapter.__commits.length, 0);
  }
});

test('R5-10 预检期间窗口过期 → 首写之前停止，零写入', async () => {
  const adapter = makeAdapter();
  // nowMs 在验证时有效，但事务内读取后过期：让 adapter 在 getDoc 时推进注入时钟
  let calls = 0;
  const originalGet = adapter.getDoc.bind(adapter);
  adapter.getDoc = async (tx, collection, key) => {
    calls++;
    // 第二次读（app_admins.primary）之前把时钟推到截止之后
    if (calls === 2) optionsClock.value = Date.parse('2031-01-01T00:00:00Z');
    return originalGet(tx, collection, key);
  };
  const optionsClock = { value: FIXED_NOW };
  await assert.rejects(
    () => bootstrap.initializePrimary({
      plan: goodPlan({ expiresAt: '2030-06-01T00:00:00Z' }),
      approval: goodApproval(),
      adapter,
      fixedNowMs: FIXED_NOW,
      get nowMs() { return optionsClock.value; }
    }),
    /首写之前已停止/
  );
  assert.equal(adapter.__commits.length, 0, '过期后不得提交');
  assert.equal(adapter.__data['schtest_v1_app_admins'].primary, undefined);
});

// ── 用户身份一致性（R5）────────────────────────────────────────────────

test('R5-11 用户记录缺身份字段 → 拒绝且零写入', async () => {
  const adapter = makeAdapter({ users: { [OWNER]: { _id: OWNER, status: 'active' } } });
  await assert.rejects(() => run(adapter), /缺少身份字段/);
  assert.equal(adapter.__commits.length, 0);
  assert.equal(adapter.__data['schtest_v1_app_admins'].primary, undefined);
});

test('R5-12 用户记录 _id 与查询键不一致 → 拒绝且零写入', async () => {
  const adapter = makeAdapter({ users: { [OWNER]: { _id: 'u_wrong', status: 'active', openid: OWNER_OPENID } } });
  await assert.rejects(() => run(adapter), /身份一致性核对失败/);
  assert.equal(adapter.__commits.length, 0);
});

test('R5-13 身份派生值与 _id 不一致（openid 错配）→ 拒绝且零写入', async () => {
  const adapter = makeAdapter({
    users: { [OWNER]: { _id: OWNER, status: 'active', openid: 'synthetic-openid-that-derives-elsewhere' } }
  });
  await assert.rejects(() => run(adapter), /身份一致性核对失败/);
  assert.equal(adapter.__commits.length, 0);
});

test('R5-14 错误记录不含 openid 明文', async () => {
  const adapter = makeAdapter({
    users: { [OWNER]: { _id: OWNER, status: 'active', openid: 'synthetic-secret-openid-value' } }
  });
  let captured = null;
  try {
    await run(adapter);
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, '必须抛出');
  const text = JSON.stringify({ message: captured.message, detail: captured.detail, code: captured.code });
  assert.equal(text.includes('synthetic-secret-openid-value'), false, '错误信息不得含 OPENID');
});

test('R5-15 合法一致身份 → 正向授予（一次提交）', async () => {
  const adapter = makeAdapter();
  const result = await run(adapter);
  assert.equal(result.granted, true);
  assert.equal(adapter.__commits.length, 1);
  const primary = await adapter.readOnlyGet('schtest_v1_app_admins', 'primary');
  assert.deepEqual(primary, { _id: 'primary', userId: OWNER, status: 'active' });
});

test('R5-16 非 active → 拒绝且零写入', async () => {
  const adapter = makeAdapter({ users: { [OWNER]: ownerRecord({ status: 'disabled' }) } });
  await assert.rejects(() => run(adapter), /身份一致性核对失败/);
  assert.equal(adapter.__commits.length, 0);
});

test('R5-17 deriveUserId 与已验收 service 契约一致', () => {
  const crypto = require('node:crypto');
  const openid = 'synthetic-openid-contract-check';
  const expected = `u_${crypto.createHash('sha256').update(`${APP_ID}:${openid}`).digest('hex').slice(0, 40)}`;
  assert.equal(bootstrap.deriveUserId(APP_ID, openid), expected);
  assert.equal(bootstrap.deriveUserId('wx_other', openid) !== expected, true, '不同 AppID 派生不同');
});

// ── 计划验证（非法 → 零写）──────────────────────────────────────────────

test('P1 非法计划 → 拒绝且零数据库操作', () => {
  const cases = [
    ['未启用', { enabled: false }],
    ['AppID 不符', { appId: 'wx_other' }],
    ['环境不符', { envId: 'env_other' }],
    ['缺 roundId', { roundId: '' }],
    ['缺 evidenceId', { evidenceId: '' }],
    ['缺 targetUserId', { targetUserId: '' }],
    ['targetUserId 用尾号', { targetUserId: '2d3aa4' }],
    ['targetUserId 形态非法', { targetUserId: 'u_zzz' }],
    ['负责人提示不符', { approvedOwnerHint: 'other' }],
    ['schemaVersion 错', { schemaVersion: 2 }],
    ['窗口不合法', { expiresAt: 'not-a-date' }],
    ['含任意集合字段', { collection: 'schtest_v1_app_admins' }],
    ['含原始 SQL 字段', { sql: 'delete all' }],
    ['含凭据字段', { secret: 'x' }],
    ['含 trusted 字段', { trusted: true }],
    ['含未登记字段', { somethingElse: 1 }],
    ['operatorRef 含凭据形态', { operatorRef: 'k=v' }]
  ];
  for (const [label, overrides] of cases) {
    assert.throws(
      () => bootstrap.validatePlan(goodPlan(overrides), { approval: goodApproval(), nowMs: FIXED_NOW }),
      /初始化计划不合法/,
      `${label} 必须被拒绝`
    );
  }
});

test('P2 计划合法 → 冻结返回，无 projectId 前置', () => {
  const plan = bootstrap.validatePlan(goodPlan(), { approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(plan.enabled, true);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal('projectId' in plan, false, '计划不得含 projectId 前置');
  assert.equal(plan.targetUserId, OWNER);
});

test('P3 计划过期 → 拒绝', () => {
  assert.throws(
    () => bootstrap.validatePlan(goodPlan({ expiresAt: '2000-01-01T00:00:00Z' }), { approval: goodApproval(), nowMs: FIXED_NOW }),
    /初始化计划不合法/
  );
});

// ── 回滚 ─────────────────────────────────────────────────────────────────

test('P7 任一步写失败 → 整体回滚，快照不变', async () => {
  for (const failAt of ['set:schtest_v1_audit_events', 'commit']) {
    const adapter = makeAdapter({ failAt });
    const before = adapter.__snapshot();
    await assert.rejects(() => run(adapter), /初始化结果未知/);
    assert.deepEqual(adapter.__snapshot(), before, `${failAt} 后快照必须完全不变`);
    assert.equal(adapter.__commits.length, 0);
  }
});

test('P8 回滚失败 → 如实报告，不吞掉', async () => {
  // 写入失败触发回滚，同时回滚本身也失败
  const adapter = makeAdapter({ failAt: 'rollback', failWriteAt: 'set:schtest_v1_app_admins' });
  await assert.rejects(() => run(adapter), /回滚未成功/);
  assert.equal(adapter.__commits.length, 0);
});

test('P9 已有相同 primary → 零写停止，不算本次新授权成功', async () => {
  const adapter = makeAdapter({ appAdmins: { primary: { _id: 'primary', userId: OWNER, status: 'active' } } });
  const result = await run(adapter);
  assert.equal(result.outcome, 'alreadyPresent');
  assert.equal(result.granted, false);
  assert.equal(adapter.__commits.length, 0);
});

test('P10 已有不同 primary → 零写停止并报告冲突', async () => {
  const adapter = makeAdapter({
    users: { [OWNER]: ownerRecord(), [OTHER]: ownerRecord({ _id: OTHER, openid: OTHER_OPENID }) },
    appAdmins: { primary: { _id: 'primary', userId: OTHER, status: 'active' } }
  });
  const result = await run(adapter);
  assert.equal(result.outcome, 'alreadyPresent');
  assert.equal(result.granted, false);
  assert.equal(result.existing.userId, OTHER);
  assert.equal(adapter.__commits.length, 0);
});

test('P11 孤立审计（primary 缺失但审计在）→ 冲突停止，不补写不删除', async () => {
  const probe = makeAdapter();
  const seeded = await run(probe);
  const audits = clone(probe.__data['schtest_v1_audit_events']);
  const adapter = makeAdapter({ audits });
  const result = await run(adapter);
  assert.equal(result.outcome, 'auditAlreadyPresent');
  assert.equal(result.granted, false);
  assert.equal(result.auditId, seeded.auditId);
  assert.equal(adapter.__commits.length, 0);
  assert.deepEqual(Object.keys(adapter.__data['schtest_v1_audit_events']), Object.keys(audits), '不得删除既有审计');
});

test('P12 两实例同时争夺空 primary（同一 target）→ 仅一笔提交', async () => {
  const shared = makeAdapter();
  const a = bootstrap.initializePrimary({ plan: goodPlan(), approval: goodApproval(), adapter: shared, nowMs: FIXED_NOW });
  const b = bootstrap.initializePrimary({ plan: goodPlan(), approval: goodApproval(), adapter: shared, nowMs: FIXED_NOW });
  const settled = await Promise.allSettled([a, b]);
  const granted = settled.filter(x => x.status === 'fulfilled' && x.value.granted === true);
  assert.equal(granted.length, 1, '恰好一笔授予');
  assert.equal(shared.__commits.length, 1, '只有一次事务提交落地');
  const rejected = settled.filter(x => x.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason && rejected[0].reason.message), /结果未知/);
});

test('P13 两实例争夺（不同 target）→ 失败方不得覆盖 primary', async () => {
  const shared = makeAdapter({
    users: { [OWNER]: ownerRecord(), [OTHER]: ownerRecord({ _id: OTHER, openid: OTHER_OPENID }) }
  });
  const approval = goodApproval({ approvedUserIds: [OWNER, OTHER] });
  const a = bootstrap.initializePrimary({ plan: goodPlan(), approval, adapter: shared, nowMs: FIXED_NOW });
  const b = bootstrap.initializePrimary({
    plan: goodPlan({ targetUserId: OTHER }), approval, adapter: shared, nowMs: FIXED_NOW
  });
  const settled = await Promise.allSettled([a, b]);
  assert.equal(shared.__commits.length, 1, '只有一次事务提交落地');
  const primary = await shared.readOnlyGet('schtest_v1_app_admins', 'primary');
  const winner = settled.find(x => x.status === 'fulfilled' && x.value.granted === true);
  assert.ok(winner, '应有一笔授予');
  assert.equal(primary.userId, winner.value.outcome === 'initialized'
    ? goodPlan().targetUserId
    : goodPlan({ targetUserId: OTHER }).targetUserId, 'primary 必须来自胜方，不得被覆盖');
});

test('P14 集合白名单越界 → 拒绝', () => {
  assert.throws(() => bootstrap.assertCollectionAllowed('schtest_v1_other'), /不在固定白名单内/);
  assert.throws(() => bootstrap.assertCollectionAllowed('users'), /不在固定白名单内/);
  assert.equal(bootstrap.assertCollectionAllowed('schtest_v1_app_admins'), 'schtest_v1_app_admins');
});

test('P15 适配器缺方法 → 拒绝', () => {
  assert.throws(() => bootstrap.assertAdapterBoundary({}), /受限适配器缺少必需方法/);
  assert.throws(
    () => bootstrap.assertAdapterBoundary({ verifyCaller() {}, beginTransaction() {} }),
    /受限适配器缺少必需方法/
  );
});

test('P16 trusted 标记默认不接受（只能作测试数据）', async () => {
  const adapter = makeAdapter({ trusted: true });
  await assert.rejects(() => run(adapter), /trusted 标记只能作测试数据/);
  assert.equal(adapter.__commits.length, 0);
});

test('P17 调用者核验失败 → 零写', async () => {
  const adapter = makeAdapter({ callerAllowed: false });
  await assert.rejects(() => run(adapter), /管理调用者未获核验/);
  assert.equal(adapter.__commits.length, 0);
});

// ── 只读观察（R5）───────────────────────────────────────────────────────

test('R5-18 observePrimary 四态：present / absent / inconsistent / unconfirmed', async () => {
  // absent：什么都没写
  const empty = makeAdapter();
  const plan = bootstrap.validatePlan(goodPlan(), { approval: goodApproval(), nowMs: FIXED_NOW });
  const absent = await bootstrap.observePrimary({ adapter: empty, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(absent.state, 'absent');
  assert.equal(absent.writeAuthorized, false);

  // present：先初始化再观察
  const seeded = makeAdapter();
  const init = await run(seeded);
  const present = await bootstrap.observePrimary({ adapter: seeded, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(present.state, 'present');
  assert.equal(present.primaryUserId, OWNER);
  assert.equal(present.auditId, init.auditId);
  assert.equal(present.writeAuthorized, false, '只读观察永不构成写授权');
  assert.equal('auditCount' in present, false, '不得统计整个审计集合');

  // inconsistent：只有 primary，审计缺失
  const onlyPrimary = makeAdapter({ appAdmins: { primary: { _id: 'primary', userId: OWNER, status: 'active' } } });
  const inconsistent = await bootstrap.observePrimary({ adapter: onlyPrimary, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(inconsistent.state, 'inconsistent');
  assert.ok(/审计缺失/.test(inconsistent.reason), inconsistent.reason);

  // unconfirmed：调用者未获核验
  const noPermission = makeAdapter({ callerAllowed: false });
  const unconfirmed = await bootstrap.observePrimary({ adapter: noPermission, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(unconfirmed.state, 'unconfirmed');
  assert.equal(unconfirmed.writeAuthorized, false);

  // unconfirmed：环境不符
  const wrongEnv = makeAdapter({ callerEnvId: 'env_other' });
  const unconfirmed2 = await bootstrap.observePrimary({ adapter: wrongEnv, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(unconfirmed2.state, 'unconfirmed');
  assert.ok(/环境不符/.test(unconfirmed2.reason), unconfirmed2.reason);

  // unconfirmed：计划不合法
  const badPlanObserved = await bootstrap.observePrimary({ adapter: empty, plan: goodPlan({ expiresAt: '2000-01-01T00:00:00Z' }), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(badPlanObserved.state, 'unconfirmed');
  assert.ok(plan);
});

test('R5-19 observePrimary 另一轮次 → 不可确认一致（不误报为通过）', async () => {
  const seeded = makeAdapter();
  await run(seeded);
  const otherRound = await bootstrap.observePrimary({
    adapter: seeded,
    plan: goodPlan({ roundId: 'round-other' }),
    approval: goodApproval(),
    nowMs: FIXED_NOW
  });
  // primary 存在，但本计划的确定性审计主键不同 → 不得报present
  assert.notEqual(otherRound.state, 'present', '另一轮次不得被判定为一致');
  assert.equal(otherRound.state, 'inconsistent');
  assert.equal(otherRound.primaryPresent, true, 'primary 确实存在');
  assert.equal(otherRound.auditPresent, false, '本计划的审计不存在');
  assert.equal(otherRound.writeAuthorized, false);
});

// ── CLI ─────────────────────────────────────────────────────────────────

test('P19 CLI 默认只做本地计划检查：无网络、无写入', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-cli-'));
  const planPath = path.join(dir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(Object.assign(goodPlan(), { approval: goodApproval() }), null, 2));
  const r = runCli(['--plan', planPath]);
  if (r.hostSpawnError) return t.skip(`宿主 spawn 故障（${r.spawnCode}）：本机无法从 node 内启动子进程，CLI 用例未验证`);
  assert.equal(r.failed, false, '合法计划的 CLI 检查应成功');
  const out = r.out;
  assert.ok(/计划校验通过/.test(out));
  assert.ok(/将使用的确定性审计主键/.test(out));
  assert.ok(/primary 仍未建立/.test(out));
  assert.equal(/已初始化|granted/.test(out), false, '不得声称已初始化');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P20 CLI --execute 一律拒绝，零网络', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-cli-exec-'));
  const planPath = path.join(dir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(Object.assign(goodPlan(), { approval: goodApproval() }), null, 2));
  const r = runCli(['--plan', planPath, '--execute']);
  if (r.hostSpawnError) return t.skip(`宿主 spawn 故障（${r.spawnCode}）：本机无法从 node 内启动子进程，CLI 用例未验证`);
  const failed = r.failed;
  const out = r.out;
  assert.equal(failed, true, '--execute 必须非零退出');
  assert.ok(/--execute 已拒绝/.test(out), out);
  assert.ok(/不得用独立的读 → 写 → 回读冒充原子性/.test(out), out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P21 CLI 不接受绕过参数', t => {
  for (const flag of ['--adapter', '--sdk', '--credential', '--token', '--approval']) {
    const r = runCli(['--plan', 'x.json', flag, 'y']);
    if (r.hostSpawnError) return t.skip(`宿主 spawn 故障（${r.spawnCode}）：本机无法从 node 内启动子进程，CLI 用例未验证`);
    const failed = r.failed;
    const out = r.out;
    assert.equal(failed, true, `${flag} 必须被拒绝`);
    assert.ok(new RegExp(`不接受(参数)? ${flag}|不接受参数 ${flag}`).test(out), out);
  }
});

test('P22 CLI 缺批准上下文 → 拒绝并说明', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-cli-noappr-'));
  const planPath = path.join(dir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(goodPlan(), null, 2));
  const r = runCli(['--plan', planPath]);
  if (r.hostSpawnError) return t.skip(`宿主 spawn 故障（${r.spawnCode}）：本机无法从 node 内启动子进程，CLI 用例未验证`);
  assert.equal(r.failed, true);
  assert.ok(/APPROVAL_CONTEXT_MISSING/.test(r.out), r.out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P23 CLI --facts 只列声明事实，不打印凭据', t => {
  const r = runCli(['--facts']);
  if (r.hostSpawnError) return t.skip(`宿主 spawn 故障（${r.spawnCode}）：本机无法从 node 内启动子进程，CLI 用例未验证`);
  assert.equal(r.failed, false, '--facts 应成功');
  const out = r.out;
  assert.ok(/目标 AppID: wxfb4db1615ac15531/.test(out));
  assert.ok(/本机真实管理 SDK 事务能力: 未核实/.test(out));
  assert.ok(/未安装、未联网、未初始化/.test(out));
  assert.equal(/secret|token|password/i.test(out), false, '不得打印凭据类字样');
});

test('P24 CLI 源码不含自动加载 SDK / 联网 / 密钥读取', () => {
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(/require\(['"]wx-server-sdk/.test(code), false);
  assert.equal(/https?:\/\//.test(code), false, '不得含网络地址');
  assert.equal(/readFileSync\([^)]*(credential|secret|token|key)/i.test(code), false, '不得读取密钥文件');
});
// ── S5：只读观测的一致性必须包含资格状态与本计划关联 ─────────────────────

test('S5-1 停用（disabled）的 primary → inconsistent，不得判 present', async () => {
  const adapter = makeAdapter();
  await bootstrap.initializePrimary({ plan: goodPlan(), approval: goodApproval(), adapter, nowMs: FIXED_NOW });
  adapter.__data.schtest_v1_app_admins.primary.status = 'disabled';
  const r = await bootstrap.observePrimary({ adapter, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(r.state, 'inconsistent', '停用状态不得判为一致');
  assert.equal(r.primaryStatus, 'disabled');
  assert.ok(/active/.test(r.reason), r.reason);
  assert.equal(r.writeAuthorized, false, '仍永不构成写授权');
});

test('S5-2 primary 缺 status / 目标错 / 主键错 → inconsistent', async () => {
  const cases = [
    ['missing-status', doc => { delete doc.status; }],
    ['wrong-target', doc => { doc.userId = OTHER; }],
    ['wrong-primary-key', doc => { doc._id = 'other'; }]
  ];
  for (const entry of cases) {
    const label = entry[0];
    const mutate = entry[1];
    const adapter = makeAdapter();
    await bootstrap.initializePrimary({ plan: goodPlan(), approval: goodApproval(), adapter, nowMs: FIXED_NOW });
    mutate(adapter.__data.schtest_v1_app_admins.primary);
    const r = await bootstrap.observePrimary({ adapter, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
    assert.equal(r.state, 'inconsistent', label);
    assert.equal(r.writeAuthorized, false, label);
  }
});

test('S5-3 审计关联不符（轮次/环境/证据/摘要/action）→ inconsistent', async () => {
  const cases = [
    ['wrong-round', doc => { doc.roundId = 'round-other'; }],
    ['wrong-env', doc => { doc.envId = 'env_other'; }],
    ['wrong-evidence', doc => { doc.evidenceId = 'ev-other'; }],
    ['wrong-input-digest', doc => { doc.inputDigest = 'deadbeef'; }],
    ['wrong-action', doc => { doc.action = 'somethingElse'; }],
    ['wrong-subject', doc => { doc.subjectUserId = OTHER; }]
  ];
  for (const entry of cases) {
    const label = entry[0];
    const mutate = entry[1];
    const adapter = makeAdapter();
    const init = await bootstrap.initializePrimary({
      plan: goodPlan(), approval: goodApproval(), adapter, nowMs: FIXED_NOW
    });
    mutate(adapter.__data.schtest_v1_audit_events[init.auditId]);
    const r = await bootstrap.observePrimary({ adapter, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
    assert.equal(r.state, 'inconsistent', label);
    assert.equal(r.writeAuthorized, false, label);
  }
});

test('S5-4 正常初始化后仍为 present（四态正向不被收紧误伤）', async () => {
  const adapter = makeAdapter();
  const init = await bootstrap.initializePrimary({
    plan: goodPlan(), approval: goodApproval(), adapter, nowMs: FIXED_NOW
  });
  const r = await bootstrap.observePrimary({ adapter, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(r.state, 'present', r.reason);
  assert.equal(r.primaryStatus, 'active');
  assert.equal(r.auditId, init.auditId);
  assert.equal(r.writeAuthorized, false);
  assert.ok(/active/.test(r.reason), 'reason 应说明含 active 资格状态');
});

test('S5-5 读取失败仍为 unconfirmed（不放宽成 inconsistent）', async () => {
  const adapter = makeAdapter();
  adapter.readOnlyGet = async () => { throw new Error('synthetic read failure'); };
  const r = await bootstrap.observePrimary({ adapter, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(r.state, 'unconfirmed');
  assert.equal(r.writeAuthorized, false);
});

test('S5-6 只读观察不产生第二次授予，且只查两条记录', async () => {
  const adapter = makeAdapter();
  await bootstrap.initializePrimary({ plan: goodPlan(), approval: goodApproval(), adapter, nowMs: FIXED_NOW });
  const commitsBefore = adapter.__commits.length;
  const reads = [];
  const original = adapter.readOnlyGet.bind(adapter);
  adapter.readOnlyGet = async (collection, key) => { reads.push(`${collection}:${key}`); return original(collection, key); };
  await bootstrap.observePrimary({ adapter, plan: goodPlan(), approval: goodApproval(), nowMs: FIXED_NOW });
  assert.equal(adapter.__commits.length, commitsBefore, '只读观察不得产生提交');
  assert.equal(reads.length, 2, '只查 primary 与本计划的确定性审计两条');
  assert.equal(reads[0], 'schtest_v1_app_admins:primary');
  assert.ok(/^schtest_v1_audit_events:sbx-init-primary:/.test(reads[1]), reads[1]);
});
