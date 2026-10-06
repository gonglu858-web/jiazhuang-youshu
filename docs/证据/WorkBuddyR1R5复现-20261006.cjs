'use strict';
/**
 * R1–R5 定点返修的对照复现（真实适配层 + 真实 P4 核心；合成 db/传输；无云调用）。
 *
 * 保留 Codex 原证据 docs/证据/Codex管理员SDK适配M1M3复现-20261006.cjs/.json 不改写；
 * 本文件是返修后的**独立**复现，另存结果。
 *
 * 判据：
 *   - 异常读取/坏回执/错 appId/trusted 与真实核心串联后**不得 initialized**（零写零提交）；
 *   - 跨适配器/伪造句柄的 rollback **零底层调用**；本实例 commitUnknown 可回滚一次；
 *   - 合成标记不得进入本层公开输出或核心 RESULT_UNKNOWN 的 detail。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const adapterModule = require(path.resolve(__dirname, '../../miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs'));
const bootstrap = require(path.resolve(__dirname, '../../miniapp/scripts/lib/sandbox-primary-bootstrap.cjs'));

const { createAdapter } = adapterModule;
const APP = bootstrap.FIXED_APP_ID;
const ENV = bootstrap.FIXED_ENV_ID;
const REGION = 'ap-shanghai';
const OPENID = 'oSYNTHETIC-openid-for-r1r5-repro';
const OWNER = bootstrap.deriveUserId(APP, OPENID);
const PRIMARY = 'primary';
const NOW = 1760000000000;
const MARKER = 'SYNTHETIC_SECRET_MARKER_R5';

function plan(o) {
  return Object.assign({
    enabled: true, appId: APP, envId: ENV, roundId: 'round-r1r5',
    targetUserId: OWNER, evidenceId: 'ev-r1r5', expiresAt: '2030-01-01T00:00:00Z',
    schemaVersion: 1, operatorRef: 'op-r1r5', approvedOwnerHint: '2d3aa4'
  }, o || {});
}
const approval = { approvedUserIds: [OWNER], approvedBy: 'codex-review-synthetic', approvedAt: '2026-10-06T00:00:00Z' };
const auditId = bootstrap.auditId(plan(), bootstrap.inputDigest(plan()));

/** 记录调用并按脚本返回；seed 决定初始记录。 */
function makeDb(script) {
  const t = Object.assign({ seed: {}, txGet: {}, set: {}, startTx: {} }, script || {});
  const c = { begin: 0, write: 0, commit: 0, rollback: 0 };
  const store = {
    schtest_v1_users: {}, schtest_v1_app_admins: {}, schtest_v1_audit_events: {}
  };
  // seed 形状：{ 集合名: { 主键: 记录 } }
  for (const [coll, bucket] of Object.entries(t.seed)) {
    for (const [id, rec] of Object.entries(bucket || {})) {
      store[coll][id] = JSON.parse(JSON.stringify(rec));
    }
  }
  const pick = (tbl, key) => (Object.prototype.hasOwnProperty.call(tbl, key) ? tbl[key]
    : Object.prototype.hasOwnProperty.call(tbl, '*') ? tbl['*'] : undefined);

  const db = {
    count: c, store,
    collection(name) {
      return { doc(id) { return {
        async get() {
          const r = pick(t.txGet, `${name}|${id}`);
          if (r instanceof Error) throw r;
          if (r !== undefined) return JSON.parse(JSON.stringify(r));
          const rec = store[name][id];
          return { data: rec ? [JSON.parse(JSON.stringify(rec))] : [] };
        },
        async set(fields) {
          const r = pick(t.set, `${name}|${id}`);
          if (r instanceof Error) throw r;
          if (r !== undefined) return JSON.parse(JSON.stringify(r));
          store[name][id] = Object.assign({ _id: id }, JSON.parse(JSON.stringify(fields)));
          return { updated: 1, upserted: [], requestId: 'syn-get' };
        }
      }; } };
    },
    async startTransaction() {
      c.begin++;
      const r = pick(t.startTx, '*');
      if (r instanceof Error) throw r;
      return {
        collection(name) { return { doc(id) { return {
          async get() {
            const v = pick(t.txGet, `${name}|${id}`);
            if (v instanceof Error) throw v;
            if (v !== undefined) return JSON.parse(JSON.stringify(v));
            const rec = store[name][id];
            return { data: rec ? [JSON.parse(JSON.stringify(rec))] : [] };
          },
          async set(fields) {
            c.write++;
            const v = pick(t.set, `${name}|${id}`);
            if (v instanceof Error) throw v;
            if (v !== undefined) return JSON.parse(JSON.stringify(v));
            store[name][id] = Object.assign({ _id: id }, JSON.parse(JSON.stringify(fields)));
            return { updated: 1, upserted: [], requestId: 'syn-set' };
          }
        }; } }; },
        async commit() {
          c.commit++;
          const v = pick(t.startTx, '__commit');
          if (v instanceof Error) throw v;
          return true;
        },
        async rollback() { c.rollback++; return true; }
      };
    }
  };
  return db;
}

function mkAdapter(db, verifier, over) {
  return createAdapter(Object.assign({
    db, verifyCaller: verifier || (async () => ({ allowed: true, envId: ENV })),
    targetUserId: OWNER, auditId, appId: APP, envId: ENV, region: REGION
  }, over || {}));
}

async function withCore(db, verifier, over) {
  const a = mkAdapter(db, verifier, over);
  let outcome = null, granted = null, err = null;
  try {
    const r = await bootstrap.initializePrimary({
      plan: plan(), adapter: a, approval, fixedNowMs: NOW, nowMs: NOW
    });
    outcome = r.outcome; granted = r.granted;
  } catch (e) { err = e; }
  return {
    outcome, granted,
    errorCode: err && err.code,
    begin: db.count.begin, write: db.count.write,
    commit: db.count.commit, rollback: db.count.rollback,
    detailCause: err && err.detail && err.detail.cause ? String(err.detail.cause) : null
  };
}

const seedUser = () => ({ schtest_v1_users: { [OWNER]: { _id: OWNER, status: 'active', openid: OPENID } } });
/**
 * 合并脚本：确保 users 记录存在。
 * 注意 seed 合并顺序 —— 必须在 script 之后合并，否则调用方传入的 seed 会覆盖 users。
 */
function withUsers(script) {
  const base = script || {};
  return Object.assign({}, base, {
    seed: Object.assign(seedUser(), base.seed || {})
  });
}
const out = [];
const record = (id, data) => out.push(Object.assign({ id }, data));

(async () => {
  // ── R1：缺 data / undefined data 被当成无记录 ──
  for (const [id, payload] of [
    ['R1-missing-data', { requestId: 'fake' }],
    ['R1-undefined-data', { data: undefined }]
  ]) {
    const db = makeDb(withUsers({ txGet: { [`schtest_v1_app_admins|${PRIMARY}`]: payload } }));
    record(id, await withCore(db));
  }

  // ── R2：坏回执被当成写入成功 ──
  for (const [id, payload] of [
    ['R2-false-updatedCount', { updatedCount: false }],
    ['R2-zero-no-upsert', { updated: 0 }]
  ]) {
    // 读取走默认路径（返回真实形状），只注入 set 的回执
    const db = makeDb(withUsers({ set: { '*': payload } }));
    record(id, await withCore(db));
  }

  // ── R3：错 appId / trusted 标记被净化掉 ──
  for (const [id, v] of [
    ['R3-wrong-appId', { allowed: true, envId: ENV, appId: 'wrong-app' }],
    ['R3-trusted-test-marker', { allowed: true, envId: ENV, trusted: true }]
  ]) {
    const db = makeDb(withUsers({}));
    record(id, await withCore(db, async () => v));
  }

  // ── R1：错主键读取被接受 ──
  {
    const db = makeDb({ seed: {} });
    const a = mkAdapter(db);
    const got = await a.readOnlyGet('schtest_v1_app_admins', PRIMARY);
    record('R1-wrong-key-read', { accepted: got });
  }

  // ── R4：提交未知后的 rollback 归属 ──
  {
    const dbA = makeDb({ startTx: { __commit: new Error('syn commit fail') } });
    const A = mkAdapter(dbA);
    const tx = await A.beginTransaction();
    try { await A.commit(tx); } catch (e) { /* 结果未知 */ }
    const beforeA = dbA.count.rollback;
    const dbB = makeDb({});
    const B = mkAdapter(dbB);
    // 跨适配器：把 A 的句柄交给 B 回滚，底层 rollback 不得被调用
    try { await B.rollback(tx); } catch (e) { /* 期望被拒 */ }
    record('R4-cross-adapter-unknown', {
      foreignRollbackInvoked: dbA.count.rollback - beforeA,
      aStillRollbackable: dbA.count.rollback === beforeA
    });
    // 本实例仍可回滚一次
    let ownOk = false;
    try { await A.rollback(tx); ownOk = true; } catch (e) { /* 期望失败 */ }
    record('R4-own-unknown-rollback-once', {
      ownRollbackInvoked: dbA.count.rollback - beforeA,
      ownSucceeded: ownOk
    });
    try { await A.rollback(tx); } catch (e) { /* 第二次应被拒 */ }
    record('R4-own-unknown-reuse-rejected', { rollbackCount: dbA.count.rollback - beforeA });
  }
  {
    const db = makeDb({});
    const a = mkAdapter(db);
    let invoked = 0;
    const forged = { __commitUnknown: true, __tx: { rollback: async () => { invoked++; } } };
    try { await a.rollback(forged); } catch (e) { /* 期望被拒 */ }
    record('R4-forged-unknown', { foreignCallbackInvoked: invoked });
  }

  // ── R5：异常 name / 外部构造 AdapterError 泄露 marker ──
  {
    const db = makeDb(withUsers({ txGet: { [`schtest_v1_app_admins|${PRIMARY}`]: new Error(MARKER) } }));
    const dbAnyName = makeDb(withUsers({
      txGet: { [`schtest_v1_app_admins|${PRIMARY}`]: Object.assign(new Error('ordinary'), { name: MARKER }) }
    }));
    const a1 = mkAdapter(db);
    const a2 = mkAdapter(dbAnyName);
    const tx1 = await a1.beginTransaction();
    const tx2 = await a2.beginTransaction();
    let e1 = null, e2 = null;
    try { await a1.getDoc(tx1, 'schtest_v1_app_admins', PRIMARY); } catch (e) { e1 = e; }
    try { await a2.getDoc(tx2, 'schtest_v1_app_admins', PRIMARY); } catch (e) { e2 = e; }
    const dump = e => JSON.stringify({
      code: e.code, message: e.message, name: e.originalErrorName,
      keys: Object.keys(e), all: Object.getOwnPropertyNames(e)
    });
    record('R5-error-name', {
      markerInFirst: dump(e1).includes(MARKER),
      markerInSecond: dump(e2).includes(MARKER)
    });
  }
  {
    // 外部构造本模块导出的 AdapterError，message 含 marker
    const ExternErr = new adapterModule.AdapterError('EXTERNAL_CODE', MARKER);
    const db = makeDb(withUsers({ txGet: { [`schtest_v1_app_admins|${PRIMARY}`]: ExternErr } }));
    const r = await withCore(db);
    record('R5-adapter-error', {
      coreMarkerLeaked: String(r.detailCause || '').includes(MARKER),
      coreCode: r.errorCode
    });
  }

  const summary = {
    total: out.length,
    unsafeInits: out.filter(x => x.outcome === 'initialized').length,
    zeroWriteOnReject: out.filter(x => x.outcome !== 'initialized' && x.write === 0 && x.commit === 0).length,
    markerLeaks: out.filter(x => JSON.stringify(x).includes('SYNTHETIC_SECRET_MARKER_R5')).length,
    foreignRollbackInvoked: out.filter(x => typeof x.foreignRollbackInvoked === 'number')
      .reduce((a, b) => a + b.foreignRollbackInvoked, 0)
      + out.filter(x => typeof x.foreignCallbackInvoked === 'number')
        .reduce((a, b) => a + b.foreignCallbackInvoked, 0),
    coreMarkerLeak: out.some(x => x.coreMarkerLeaked === true)
  };
  const report = {
    executedAt: new Date().toISOString(),
    scope: 'R1–R5 返修后对照复现；真实适配层 + 真实 P4 核心；合成 db/传输；无云调用',
    originalEvidenceKept: 'docs/证据/Codex管理员SDK适配M1M3复现-20261006.cjs/.json（原样保留，未改写）',
    summary,
    cases: out
  };
  fs.writeFileSync(__filename.replace(/\.cjs$/, '.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ summary, cases: out }, null, 2));
})();
