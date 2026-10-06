'use strict';
/**
 * SDK 薄适配层：相称离线契约测试。
 *
 * 两条腿：
 *  A. 合成替身（纯内存，注入假 db）—— 覆盖边界与失败语义；
 *  B. **真实已安装包** @cloudbase/node-sdk 2.10.0 + @cloudbase/database 1.4.1，
 *     用合成请求传输（替换 `Db.reqClass`）替换传输层，并**完全拦截网络**。
 *
 * B 腿的 SDK 路径**只在测试宿主里指定**，不作为 CLI 参数；路径不可用时
 * 该层用 t.skip 明确标注「未验证」，不安装、不复制整棵 node_modules。
 *
 * 全部为本地合成数据；**不得据此声称平台原子性、IAM、真实凭据或费用已验证**。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const adapterModule = require('../scripts/lib/sandbox-primary-sdk-adapter.cjs');
const bootstrap = require('../scripts/lib/sandbox-primary-bootstrap.cjs');

const {
  FIXED_APP_ID, FIXED_ENV_ID, FIXED_REGION, PRIMARY_ID,
  createAdapter, AdapterError
} = adapterModule;

// ── 合成数据（全部为夹具，不代表任何真实值） ────────────────────────────
const APP = FIXED_APP_ID;
const ENV = FIXED_ENV_ID;
const REGION = FIXED_REGION;
// 合成 openid（**夹具数据，不代表任何真实微信标识**）
const OPENID = 'oSYNTHETIC-openid-placeholder-for-p4-fixture';
// 目标 userId 由 deriveUserId(appId, openid) 派生 —— 与核心要求的
// 「记录 _id === 派生值」保持自洽。它是**合成夹具值**，不是真实用户。
const OWNER = bootstrap.deriveUserId(APP, OPENID);
const AUDIT_PREFIX = bootstrap.AUDIT_ID_PREFIX;
const FIXED_NOW = 1760000000000;

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * 默认用户记录：_id / status / openid 三者自洽。
 * 核心要求 _id === deriveUserId(appId, openid)，因此这里的 openid 是合成夹具值，
 * 派生结果**只用于夹具自洽**，不代表任何真实微信标识。
 */
function userRecord(overrides) {
  return Object.assign({ _id: OWNER, status: 'active', openid: OPENID }, overrides || {});
}

// ── A 腿：合成替身 ────────────────────────────────────────────────────

/**
 * 内存事务替身。**逐键读集冲突检测**未在此实现 —— 本层测试不验证平台原子性。
 * 只按脚本返回预设结果，并记录调用序列。
 */
function makeSyntheticDb(script) {
  const log = [];
  let committed = 0;
  let rolledBack = 0;
  const store = { 'schtest_v1_users': {}, 'schtest_v1_app_admins': {}, 'schtest_v1_audit_events': {} };
  // 预置
  for (const [coll, rec] of Object.entries((script && script.seed) || {})) {
    store[coll][rec._id] = clone(rec);
  }

  function pick(action, args) {
    const table = (script && script[action]) || {};
    const joined = args.join('|');
    // 精确键优先于 '*'，否则具体注入会被通配遮蔽
    const key = Object.prototype.hasOwnProperty.call(table, joined) ? joined
      : (Object.prototype.hasOwnProperty.call(table, '*') ? '*' : undefined);
    if (key === undefined) {
      return { __default: true };
    }
    const value = table[key];
    return typeof value === 'function' ? value(args) : value;
  }

  const db = {
    store,
    log,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              log.push({ op: 'get', collection: name, id, mode: 'plain' });
              const r = pick('get', [name, id]);
              if (r instanceof Error) throw r;
              if (r && r.__throw) throw new Error('synthetic transport failure');
              if (r && r.__default) {
                const rec = store[name][id];
                return { data: rec ? [clone(rec)] : [] };
              }
              return clone(r);
            },
            async set(fields) {
              log.push({ op: 'set', collection: name, id, fields: clone(fields) });
              const r = pick('set', [name, id]);
              if (r instanceof Error) throw r;
              if (r && r.__throw) throw new Error('synthetic transport failure');
              if (r && r.__default) return { updated: 1, upserted: [], requestId: 'syn-set' };
              return clone(r);
            }
          };
        }
      };
    },
    async startTransaction() {
      log.push({ op: 'startTransaction' });
      const r = pick('startTransaction', []);
      if (r instanceof Error) throw r;
      if (r && r.__throw) throw new Error('synthetic startTransaction failure');
      if (r && r.__default) {
        return {
          collection: (name) => ({
            doc: (id) => ({
              async get() {
                log.push({ op: 'tx-get', collection: name, id, mode: 'transaction' });
                const rr = pick('txGet', [name, id]);
                if (rr instanceof Error) throw rr;
                if (rr && rr.__throw) throw new Error('synthetic transport failure');
                if (rr && rr.__default) {
                  const rec = store[name][id];
                  // 真实 SDK 事务读取形状：显式 null 或单个对象（非数组）
                  return { data: rec ? clone(rec) : null };
                }
                return clone(rr);
              },
              async set(fields) {
                log.push({ op: 'tx-set', collection: name, id, fields: clone(fields) });
                const rr = pick('txSet', [name, id]);
                if (rr instanceof Error) throw rr;
                if (rr && rr.__throw) throw new Error('synthetic transport failure');
                if (rr && rr.__default) {
                  store[name][id] = Object.assign({ _id: id }, clone(fields));
                  return { updated: 1, upserted: [], requestId: 'syn-set' };
                }
                if (rr && rr.__apply !== false) {
                  store[name][id] = Object.assign({ _id: id }, clone(fields));
                }
                return clone(rr);
              }
            })
          }),
          async commit() {
            log.push({ op: 'commit' });
            const rr = pick('commit', []);
            if (rr instanceof Error) throw rr;
            if (rr && rr.__throw) throw new Error('synthetic commit failure');
            if (rr && rr.__code) { const e = new Error('synthetic commit code error'); e.code = rr.__code; throw e; }
            if (rr && rr.__default) { committed++; return true; }
            committed++;
            return true;
          },
          async rollback() {
            log.push({ op: 'rollback' });
            const rr = pick('rollback', []);
            if (rr instanceof Error) throw rr;
            if (rr && rr.__throw) throw new Error('synthetic rollback failure');
            rolledBack++;
            return true;
          }
        };
      }
      return r;
    }
  };
  return db;
}

function plan(overrides) {
  return Object.assign({
    enabled: true,
    appId: APP,
    envId: ENV,
    roundId: 'round-p4-minimal',
    targetUserId: OWNER,
    evidenceId: 'ev-p4-minimal',
    expiresAt: '2030-01-01T00:00:00Z',
    schemaVersion: 1,
    operatorRef: 'operator-ref-synthetic',
    approvedOwnerHint: '2d3aa4'
  }, overrides || {});
}

function approval(overrides) {
  return Object.assign({
    approvedUserIds: [OWNER],
    approvedBy: 'codex-review-synthetic',
    approvedAt: '2026-10-06T00:00:00Z'
  }, overrides || {});
}

function newAdapter(db, verifyCaller, overrides) {
  return createAdapter(Object.assign({
    db,
    verifyCaller: verifyCaller || (async () => ({ allowed: true, envId: ENV })),
    targetUserId: OWNER,
    auditId: bootstrap.auditId(plan(), bootstrap.inputDigest(plan())),
    appId: APP,
    envId: ENV,
    region: REGION
  }, overrides || {}));
}

function auditIdFor(p) {
  return bootstrap.auditId(p, bootstrap.inputDigest(p));
}

// ── M1：构造与固定值边界 ───────────────────────────────────────────────

test('M1-1 注入 db +核验函数可构造出满足核心边界的适配层', () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  bootstrap.assertAdapterBoundary(a);
  assert.equal(typeof a.readOnlyGet, 'function', '须提供只读观察读取');
  assert.equal(a.__meta.productionCallerVerifierImplemented, false, '生产调用者核验尚未实现');
  assert.equal(a.__meta.isAuthorizationMechanism, false, '注入不是授权机制');
  assert.equal(a.__meta.setRetries, 0);
  assert.equal(a.__meta.commitRetries, 0);
});

test('M1-2 AppID / 环境 / 地域不符固定值 → 构造即拒绝', () => {
  const db = makeSyntheticDb({});
  for (const [label, o] of [
    ['appId', { appId: 'wx_other' }],
    ['envId', { envId: 'cloud_other' }],
    ['region', { region: 'ap-beijing' }],
    ['primaryId', { primaryId: 'other' }]
  ]) {
    assert.throws(() => newAdapter(db, null, o), AdapterError, `${label} 不符必须拒绝`);
  }
});

test('M1-3 缺 db 或缺调用者核验函数 → 构造即拒绝（不硬编码 allowed:true）', () => {
  const base = {
    targetUserId: OWNER,
    auditId: auditIdFor(plan()),
    appId: APP, envId: ENV, region: REGION
  };
  // 缺 db 与缺核验函数都必须拒绝；具体报哪一个码取决于检查顺序，两者都是硬要求
  assert.throws(() => createAdapter(base),
    e => e.code === 'DB_NOT_INJECTED' || e.code === 'CALLER_VERIFIER_MISSING');
  // 有 db 但缺核验函数 → 必须是 CALLER_VERIFIER_MISSING
  assert.throws(() => createAdapter(Object.assign({}, base, { db: makeSyntheticDb({}) })),
    e => e.code === 'CALLER_VERIFIER_MISSING');
  // 有核验函数但 db 不可用 → 必须是 DB_NOT_INJECTED
  assert.throws(() => createAdapter(Object.assign({}, base, {
    db: {}, verifyCaller: async () => ({ allowed: true })
  })), e => e.code === 'DB_NOT_INJECTED');
});

test('M1-4 缺绑定目标用户或审计主键 → 拒绝', () => {
  const db = makeSyntheticDb({});
  assert.throws(() => newAdapter(db, null, { targetUserId: '' }),
    e => e.code === 'TARGET_USER_REQUIRED');
  assert.throws(() => newAdapter(db, null, { auditId: '' }),
    e => e.code === 'AUDIT_ID_REQUIRED');
});

test('M1-5 无顶层副作用：不读凭据文件、不联网、不加载全局 SDK', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts/lib/sandbox-primary-sdk-adapter.cjs'), 'utf8');
  // 去掉注释后再扫，避免说明文字里的词造成误判
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const pattern of [
    /require\(/,
    /process\.env/,
    /readFileSync/,
    /https?\.request/,
    /node-fetch|axios/,
    /secretId|secretKey|credential/,
    /app\.admins(?![\w])/
  ]) {
    assert.equal(pattern.test(code), false, `适配层不得出现 ${pattern}`);
  }
  assert.equal(/module\.exports\s*=\s*createAdapter\(/.test(code), false, '不得在加载时创建适配层');
});

// ── M1：调用者核验 ────────────────────────────────────────────────────

test('M1-6 调用者核验：缺函数/抛错/allowed 非 true/环境不符 → 零数据库调用', async () => {
  const db = makeSyntheticDb({});
  const callsBefore = db.log.length;

  // 缺函数：构造阶段即拒绝
  assert.throws(() => createAdapter({
    db, targetUserId: OWNER, auditId: auditIdFor(plan()),
    appId: APP, envId: ENV, region: REGION
  }), e => e.code === 'CALLER_VERIFIER_MISSING');

  for (const [label, verifier] of [
    ['throw', async () => { throw new Error('synthetic verifier explosion with SECRET=abc'); }],
    ['allowed-false', async () => ({ allowed: false })],
    ['not-true', async () => ({ allowed: 'yes' })],
    ['not-object', async () => 'ok'],
    ['env-mismatch', async () => ({ allowed: true, envId: 'cloud_other' })]
  ]) {
    const d = makeSyntheticDb({});
    const a = newAdapter(d, verifier);
    await assert.rejects(() => a.verifyCaller({ envId: ENV, appId: APP }), AdapterError, label);
    assert.equal(d.log.length, 0, `${label} 必须零数据库调用`);
  }
  assert.equal(db.log.length, callsBefore);
});

test('M1-7 调用者核验通过时只回结论，不透传自由字段', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db, async () => ({
    allowed: true, envId: ENV, secretId: 'SYNTHETIC_SECRET', token: 'SYNTHETIC_TOKEN'
  }));
  const r = await a.verifyCaller({ envId: ENV, appId: APP });
  assert.deepEqual(Object.keys(r).sort(), ['allowed', 'envId']);
  assert.equal(JSON.stringify(r).includes('SYNTHETIC'), false, '不得把凭据字段传给核心');
});

// ── M1：集合与主键边界 ────────────────────────────────────────────────

test('M1-8 越界集合 / 主键 / users 写入 → 零发送', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  const tx = await a.beginTransaction();
  for (const [label, fn] of [
    ['未授权集合', () => a.getDoc(tx, 'app_admins', PRIMARY_ID)],
    ['users 写入', () => a.setDoc(tx, 'schtest_v1_users', OWNER, { status: 'active' })],
    ['别的用户', () => a.getDoc(tx, 'schtest_v1_users', 'u_' + 'f'.repeat(40))],
    ['别的审计主键', () => a.getDoc(tx, 'schtest_v1_audit_events', 'sbx-init-primary:deadbeef')],
    ['非 primary', () => a.getDoc(tx, 'schtest_v1_app_admins', 'secondary')]
  ]) {
    await assert.rejects(fn, AdapterError, label);
  }
  const sends = db.log.filter(x => x.op === 'tx-set' || x.op === 'set' || x.op === 'tx-get' || x.op === 'get');
  assert.equal(sends.length, 0, '越界一律零发送');
  await a.rollback(tx);
});

test('M1-9 外来事务句柄与已结束句柄 → 拒绝', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  const foreign = { collection: () => ({ doc: () => ({ get: async () => ({ data: null }) }) }) };
  await assert.rejects(() => a.getDoc(foreign, 'schtest_v1_app_admins', PRIMARY_ID),
    e => e.code === 'TX_NOT_OWNED');
  await assert.rejects(() => a.setDoc(foreign, 'schtest_v1_app_admins', PRIMARY_ID, { userId: OWNER }),
    e => e.code === 'TX_NOT_OWNED');

  const tx = await a.beginTransaction();
  await a.rollback(tx);
  const finished = e => e.code === 'TX_ALREADY_FINISHED';
  await assert.rejects(() => a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID), finished);
  await assert.rejects(() => a.commit(tx), finished);
  await assert.rejects(() => a.rollback(tx), finished);

  // 第二个适配器的句柄也不能被第一个使用
  const db2 = makeSyntheticDb({});
  const b = newAdapter(db2);
  const tx2 = await b.beginTransaction();
  await assert.rejects(() => a.getDoc(tx2, 'schtest_v1_app_admins', PRIMARY_ID),
    e => e.code === 'TX_NOT_OWNED');
  await b.rollback(tx2);
});

// ── M1：读取形状与错误区分（真实 SDK 转换结论） ───────────────────────

test('M1-10 事务读取成功空（显式 null）→ null；非事务成功空（data:[]）→ null', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  const tx = await a.beginTransaction();
  assert.equal(await a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID), null);
  assert.equal(await a.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID), null);
  await a.rollback(tx);
});

test('M1-11 含 code / 权限错误 / 传输异常 / 形状错误 → 不得当成「不存在」', async () => {
  const cases = [
    ['含 code', { get: { '*': { code: 'SYNTHETIC_PERMISSION_DENIED' } } }],
    ['形状非对象', { get: { '*': 'not-an-object' } }],
    ['data 非数组非对象', { get: { '*': { data: 'weird' } } }],
    ['两条记录', { get: { '*': { data: [{ _id: PRIMARY_ID }, { _id: 'other' }] } } }],
    ['传输抛错', { get: { '*': { __throw: true } } }]
  ];
  for (const [label, script] of cases) {
    const db = makeSyntheticDb(script);
    const a = newAdapter(db);
    await assert.rejects(() => a.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID), AdapterError, label);
  }
  // 事务读取同样
  for (const [label, payload] of [
    ['事务含 code', { code: 'SYNTHETIC_DENIED' }],
    ['事务两条', { data: [{ _id: 'a' }, { _id: 'b' }] }],
    ['事务 data 非对象', { data: 42 }]
  ]) {
    const db = makeSyntheticDb({ txGet: { '*': payload } });
    const a = newAdapter(db);
    const tx = await a.beginTransaction();
    await assert.rejects(() => a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID), AdapterError, label);
    await a.rollback(tx).catch(() => {});
  }
});

test('M1-12 失败消息只含错误码与净化文案，不含原始异常文本', async () => {
  const db = makeSyntheticDb({ get: { '*': { __throw: true } } });
  const a = newAdapter(db);
  const err = await a.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID).then(() => null, e => e);
  assert.ok(err instanceof AdapterError);
  const text = JSON.stringify({ code: err.code, message: err.message, name: err.originalErrorName });
  assert.equal(/synthetic transport failure/.test(text), false, '不得透传原始异常文本');
  assert.equal(err.code, 'READ_TRANSPORT_FAILED');
  assert.equal(/SYNTHETIC/.test(text), false, '不得出现合成标记原样');
  assert.equal(text.includes('Error'), true, '只保留异常类型名');
});

// ── M1：写入转换 ──────────────────────────────────────────────────────

test('M1-13 set：裸字段对象 + 剔除一致的 _id，且**输入对象未被改动**', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  const tx = await a.beginTransaction();
  const input = { _id: PRIMARY_ID, userId: OWNER, status: 'active' };
  const snapshot = JSON.stringify(input);
  await a.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID, input);
  const sent = db.log.find(x => x.op === 'tx-set');
  assert.deepEqual(sent.fields, { userId: OWNER, status: 'active' }, '发出的字段不得含 _id');
  assert.equal('_id' in sent.fields, false, '不得嵌套 data 包装');
  assert.equal(JSON.stringify(input), snapshot, '**核心传入的对象不得被改动**');
  await a.rollback(tx);
});

test('M1-14 set：_id 与独立主键不一致 → 拒绝且零发送', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  const tx = await a.beginTransaction();
  const before = db.log.length;
  await assert.rejects(
    () => a.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID, { _id: 'secondary', userId: OWNER }),
    e => e.code === 'DOC_ID_MISMATCH'
  );
  await assert.rejects(
    () => a.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID, 'not-an-object'),
    e => e.code === 'DOC_NOT_OBJECT'
  );
  assert.equal(db.log.length, before, '不一致时零发送');
  await a.rollback(tx);
});

test('M1-15 set 成功形状核验：缺字段 / 含 code → 拒绝', async () => {
  for (const [label, payload] of [
    ['缺成功字段', { ok: true }],
    ['非对象', 'nope'],
    ['含 code', { code: 'SYNTHETIC_DENIED' }],
    ['updated 类型异常', { updated: 'one' }]
  ]) {
    const db = makeSyntheticDb({ txSet: { '*': payload } });
    const a = newAdapter(db);
    const tx = await a.beginTransaction();
    await assert.rejects(() => a.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID, { userId: OWNER }),
      AdapterError, label);
    assert.equal(db.committed, 0, `${label} 不得 commit`);
    await a.rollback(tx).catch(() => {});
  }
});

// ── M1：提交与回滚 ────────────────────────────────────────────────────

test('M1-16 提交结果未知 → 抛错、不重试、不谎报已回滚', async () => {
  for (const [label, script] of [
    ['commit 抛错', { commit: { '*': { __throw: true } } }],
    ['commit 含 code', { commit: { '*': { __code: 'SYNTHETIC_CONFLICT' } } }]
  ]) {
    const db = makeSyntheticDb(script);
    const a = newAdapter(db);
    const tx = await a.beginTransaction();
    const commits = db.log.filter(x => x.op === 'commit').length;
    await assert.rejects(() => a.commit(tx), AdapterError, label);
    assert.equal(db.log.filter(x => x.op === 'commit').length, commits + 1, '只提交一次，不重试');
    assert.equal(db.rolledBack, 0, '适配层不自行回滚，不谎报已回滚');
    // 提交结果未知：不允许再次提交，也不允许再读写；但**允许回滚**（恢复动作）
    await assert.rejects(() => a.commit(tx), e => e.code === 'TX_COMMIT_UNKNOWN');
    await assert.rejects(() => a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID),
      e => e.code === 'TX_COMMIT_UNKNOWN');
    await assert.rejects(() => a.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID, { userId: OWNER }),
      e => e.code === 'TX_COMMIT_UNKNOWN');
    // 允许回滚，且回滚会真正下发
    await a.rollback(tx);
    assert.equal(db.rolledBack, 1, '提交未知后仍允许回滚（恢复动作）');
  }
});

test('M1-17 rollback 失败 → 抛错并如实报告，不谎报已回滚', async () => {
  const db = makeSyntheticDb({ rollback: { '*': { __throw: true } } });
  const a = newAdapter(db);
  const tx = await a.beginTransaction();
  const err = await a.rollback(tx).then(() => null, e => e);
  assert.ok(err instanceof AdapterError);
  assert.equal(err.code, 'ROLLBACK_FAILED');
  assert.equal(/谎报/.test(err.message), true, '消息须提示人工核对');
  assert.equal(db.rolledBack, 0);
  // 句柄仍被标记结束，不会被再次使用
  await assert.rejects(() => a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID),
    e => e.code === 'TX_ALREADY_FINISHED');
});

test('M1-18 rollback 句柄无效 → 明确拒绝而非静默', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  // 非对象 → TX_HANDLE_INVALID
  await assert.rejects(() => a.rollback(null), e => e.code === 'TX_HANDLE_INVALID');
  await assert.rejects(() => a.rollback('tx'), e => e.code === 'TX_HANDLE_INVALID');
  // 对象但未登记（含空对象与旧版 __tx 结构）→ TX_NOT_OWNED
  await assert.rejects(() => a.rollback({}), e => e.code === 'TX_NOT_OWNED');
  // 形似但不属于本适配器的句柄（含旧版 __tx 结构）→ TX_NOT_OWNED
  await assert.rejects(() => a.rollback({ __tx: { rollback: async () => {} } }),
    e => e.code === 'TX_NOT_OWNED');
});

// ── M1：只读观察 ──────────────────────────────────────────────────────

test('M1-19 只读观察零写，且只查 primary 与本计划审计两条', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  await a.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID);
  await a.readOnlyGet('schtest_v1_audit_events', auditIdFor(plan()));
  const writes = db.log.filter(x => x.op === 'set' || x.op === 'tx-set');
  assert.equal(writes.length, 0, '只读观察必须零写');
  assert.equal(db.log.filter(x => x.op === 'get').length, 2, '恰好两条读取');
  // 只读观察比事务读更窄：users 不开放
  await assert.rejects(() => a.readOnlyGet('schtest_v1_users', OWNER),
    e => e.code === 'READ_ONLY_SCOPE');
});

// ── M1/M2：与真实 P4 核心串联 ────────────────────────────────────────

function bootstrapRun(adapter, p) {
  return bootstrap.initializePrimary({
    plan: p || plan(),
    adapter,
    approval: approval(),
    fixedNowMs: FIXED_NOW,
    nowMs: FIXED_NOW
  });
}

test('M2-20 真实核心 + 适配层：空 primary 一次初始化恰好一次 commit、写两条', async () => {
  const p = plan();
  const db = makeSyntheticDb({ seed: { schtest_v1_users: userRecord() } });
  const a = newAdapter(db);
  const r = await bootstrapRun(a, p);
  assert.equal(r.granted, true, JSON.stringify(r));
  assert.equal(r.outcome, 'initialized');
  assert.equal(db.committed, 1, '恰好一次提交');
  const writes = db.log.filter(x => x.op === 'tx-set');
  assert.equal(writes.length, 2, '恰好两条写入');
  assert.deepEqual(writes.map(w => w.collection).sort(),
    ['schtest_v1_app_admins', 'schtest_v1_audit_events']);
  assert.equal(writes.find(w => w.collection === 'schtest_v1_app_admins').id, PRIMARY_ID);
  assert.equal(writes.find(w => w.collection === 'schtest_v1_audit_events').id, auditIdFor(p));
  // 同一事务
  const txOps = db.log.filter(x => x.op === 'tx-get' || x.op === 'tx-set');
  assert.equal(txOps.length, 5, '同事务内 3 次读 + 2 次写');
  assert.equal(db.log.filter(x => x.op === 'startTransaction').length, 1);
  // 输出不含敏感值
  const dump = JSON.stringify(r);
  assert.equal(dump.includes(OPENID), false, '结果不含 OPENID');
  assert.equal(/SYNTHETIC_SECRET|secretKey|token/i.test(dump), false, '结果不含凭据');
});

test('M2-21 已有 primary → 零写停止，适配层不 commit', async () => {
  const db = makeSyntheticDb({
    seed: {
      schtest_v1_users: userRecord(),
      schtest_v1_app_admins: { _id: PRIMARY_ID, userId: OWNER, status: 'active' }
    }
  });
  const a = newAdapter(db);
  const r = await bootstrapRun(a);
  assert.equal(r.granted, false);
  assert.equal(r.outcome, 'alreadyPresent');
  assert.equal(db.log.filter(x => x.op === 'tx-set').length, 0, '零写');
  assert.equal(db.committed, 0, '不提交');
});

test('M2-22 第一/第二次写失败 → 不 commit，核心整体回滚', async () => {
  for (const [label, target] of [['第一次', 'schtest_v1_app_admins'], ['第二次', 'schtest_v1_audit_events']]) {
    const db = makeSyntheticDb({
      seed: { schtest_v1_users: userRecord() },
      txSet: { [`${target}|${target === 'schtest_v1_app_admins' ? PRIMARY_ID : auditIdFor(plan())}`]: { __throw: true } }
    });
    const a = newAdapter(db);
    const err = await bootstrapRun(a).then(() => null, e => e);
    assert.ok(err, `${label} 写失败必须抛错`);
    assert.equal(db.committed, 0, `${label} 写失败后不得 commit`);
    // 核心捕获写失败后自行调用 adapter.rollback；回滚成功才会抛原始写错误，
    // 回滚失败才会变成 ROLLBACK_FAILED。两种都必须「不 commit、不补写」。
    assert.equal(db.rolledBack >= 1, true, `${label} 写失败后应尝试回滚`);
    const expectedWrites = target === 'schtest_v1_app_admins' ? 1 : 2;
    assert.equal(db.log.filter(x => x.op === 'tx-set').length, expectedWrites,
      `${label} 写失败后不得补写（应恰好 ${expectedWrites} 次）`);
  }
});

test('M2-23 提交未知 → 核心停止，不自动再次初始化（写请求不重复）', async () => {
  const db = makeSyntheticDb({
    seed: { schtest_v1_users: userRecord() },
    commit: { '*': { __throw: true } }
  });
  const a = newAdapter(db);
  const err = await bootstrapRun(a).then(() => null, e => e);
  assert.ok(err);
  // 核心捕获提交失败 → 自行回滚（本例回滚成功）→ 按 RESULT_UNKNOWN 停止
  assert.equal(err.code, 'RESULT_UNKNOWN', '须按结果未知停止：' + err.message);
  assert.equal(db.log.filter(x => x.op === 'tx-set').length, 2, '写入只发生一次，不补发');
  assert.equal(db.log.filter(x => x.op === 'startTransaction').length, 1, '不自动再次初始化');
  assert.equal(db.committed, 0);
});

test('M2-24 目标用户不存在或非 active → 拒绝、零提交', async () => {
  for (const [label, rec] of [
    ['不存在', null],
    ['非 active', userRecord({ status: 'disabled' })],
    ['身份派生不符', userRecord({ _id: 'u_' + 'f'.repeat(40), openid: 'o-other' })]
  ]) {
    const seed = rec ? { schtest_v1_users: rec } : {};
    const db = makeSyntheticDb({ seed });
    const a = newAdapter(db);
    const err = await bootstrapRun(a).then(() => null, e => e);
    assert.ok(err, `${label} 必须被拒绝`);
    assert.equal(db.committed, 0, `${label} 零提交`);
    assert.equal(db.log.filter(x => x.op === 'tx-set').length, 0, `${label} 零写`);
  }
});

test('M2-25 计划边界不符（AppID/环境/未批准目标）→ 核心拒绝，适配层零调用', async () => {
  const db = makeSyntheticDb({ seed: { schtest_v1_users: userRecord() } });
  const a = newAdapter(db);
  await assert.rejects(() => bootstrapRun(a, plan({ appId: 'wx_other' })), /初始化计划不合法/);
  await assert.rejects(() => bootstrapRun(a, plan({ envId: 'cloud_other' })), /初始化计划不合法/);
  assert.equal(db.log.length, 0, '计划不合法时适配层零调用');
});

// ── B 腿：真实已安装包 + 合成传输 ─────────────────────────────────────

const SDK_ROOT = process.env.SANDBOX_SDK_ROOT
  || 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';

function sdkAvailable() {
  try {
    require(path.join(SDK_ROOT, '@cloudbase/node-sdk'));
    require(path.join(SDK_ROOT, '@cloudbase/database'));
    return true;
  } catch (error) {
    return false;
  }
}

/** 完全拦截网络；返回计数器。 */
function blockNetwork() {
  const counter = { attempts: 0 };
  const block = () => { counter.attempts++; throw new Error('OFFLINE_ONLY'); };
  for (const [name, methods] of [
    ['node:http', ['request', 'get']],
    ['node:https', ['request', 'get']],
    ['node:net', ['connect', 'createConnection']],
    ['node:tls', ['connect']]
  ]) {
    const m = require(name);
    for (const key of methods) m[key] = block;
  }
  require('node:net').Socket.prototype.connect = block;
  globalThis.fetch = block;
  return counter;
}

function withRealSdk(t, fn) {
  if (!sdkAvailable()) {
    t.skip(`真实包不可用（${SDK_ROOT}）：该层未验证；未安装、未复制 node_modules`);
    return;
  }
  const net = blockNetwork();
  const { Db } = require(path.join(SDK_ROOT, '@cloudbase/database'));
  const sdk = require(path.join(SDK_ROOT, '@cloudbase/node-sdk'));
  // 顺序要求（真实包实测）：**先** init 出 db，**再** 替换 Db.reqClass。
  // 反过来会让 startTransaction 走真实传输并被网络拦截拦下。
  const db = sdk.init({
    env: 'offline-shape-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true
  }).database();
  /**
   * 真实 SDK 的 `get` 会对传输层返回的每个文档调用 `EJSON.parse`（bson 库），
   * 而它**要求参数是字符串**。因此合成传输必须返回 EJSON 序列化后的字符串，
   * 直接返回普通对象会在 SDK 内部抛 SyntaxError —— 这不是适配层的问题。
   * （本轮实测确认，见 M2-31/M2-32。）
   */
  const bson = require(path.join(SDK_ROOT, 'bson'));
  const EJSON = bson.EJSON || bson;
  const asEjsonDoc = doc => JSON.stringify(EJSON.serialize(doc, { relaxed: false }));
  const originalReq = Db.reqClass;
  const calls = [];
  let failureCode = '';
  let failActions = new Set();

  Db.reqClass = class {
    async send(action, params = {}) {
      calls.push({ action, params });
      if (failureCode && (failActions.size === 0 || failActions.has(action))) {
        return { code: failureCode, message: 'synthetic rejection' };
      }
      if (action === 'database.startTransaction') return { transactionId: 'offline-tx' };
      if (action === 'database.getDocument') return { data: { list: [] }, requestId: 'offline-get' };
      if (action === 'database.modifyDocument') {
        return { data: { updated: 0, upsert_id: 'primary' }, requestId: 'offline-set' };
      }
      if (action === 'database.commitTransaction') return { requestId: 'offline-commit' };
      if (action === 'database.abortTransaction') return { requestId: 'offline-abort' };
      throw new Error('unexpected SDK action: ' + action);
    }
  };

  const cleanup = () => { Db.reqClass = originalReq; };
  const wrapped = async () => {
    try {
      await fn({
        db, calls, sdk, Db, net, asEjsonDoc,
        /**
         * 替换当前生效的传输实现。真实 SDK 的 db 实例在 init 时就捕获了
         * `Db.reqClass`，因此要按用例替换响应，必须在替换后再自建 db；
         * 本辅助已保证顺序（先 init、后替换），这里直接换回当前实现即可。
         */
        setTransport: impl => { Db.reqClass = impl; },
        setFailure: (code, actions) => { failureCode = code || ''; failActions = new Set(actions || []); }
      });
    } finally {
      cleanup();
    }
    assert.equal(net.attempts, 0, '网络尝试次数必须为 0');
  };
  return wrapped();
}

test('M2-26 真实包：事务读取成功空 → null；非事务读取成功空 → []→ null', async t => {
  await withRealSdk(t, async ({ db, sdk, net }) => {
    const a = createAdapter({
      db,
      verifyCaller: async () => ({ allowed: true, envId: ENV }),
      targetUserId: OWNER,
      auditId: auditIdFor(plan()),
      appId: APP, envId: ENV, region: REGION
    });
    const tx = await a.beginTransaction();
    assert.equal(await a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID), null,
      '真实 SDK 事务空读经转换应为 null');
    assert.equal(await a.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID), null,
      '真实 SDK 非事务空读（data:[]）应转为 null');
    await a.rollback(tx);
    assert.equal(sdk.version, '2.10.0');
    assert.equal(net.attempts, 0);
  });
});

test('M2-27 真实包：发出的写请求是裸字段、id 在 query、同一事务Id', async t => {
  await withRealSdk(t, async ({ db, calls }) => {
    const a = createAdapter({
      db,
      verifyCaller: async () => ({ allowed: true, envId: ENV }),
      targetUserId: OWNER,
      auditId: auditIdFor(plan()),
      appId: APP, envId: ENV, region: REGION
    });
    const tx = await a.beginTransaction();
    await a.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID,
      { _id: PRIMARY_ID, userId: OWNER, status: 'active' });
    const set = calls.find(x => x.action === 'database.modifyDocument');
    assert.ok(set, '应发出 modifyDocument');
    assert.deepEqual(JSON.parse(set.params.query), { _id: PRIMARY_ID });
    const data = JSON.parse(set.params.data);
    assert.equal('_id' in data, false, 'data 不得含 _id');
    assert.deepEqual(data, { userId: OWNER, status: 'active' }, '裸字段，无 data 包装');
    assert.equal(set.params.transactionId, 'offline-tx');
    assert.equal(set.params.upsert, true);
    await a.rollback(tx);
  });
});

test('M2-28 真实包：含 code 的读取/写入/提交不得被当成缺记录或成功', async t => {
  await withRealSdk(t, async ({ db, setFailure }) => {
    const a = createAdapter({
      db,
      verifyCaller: async () => ({ allowed: true, envId: ENV }),
      targetUserId: OWNER,
      auditId: auditIdFor(plan()),
      appId: APP, envId: ENV, region: REGION
    });
    const rejected = e => e.code === 'READ_REJECTED_BY_SERVER';
    const CODE = 'SYNTHETIC_PERMISSION_DENIED';

    // 只让读取失败：不得被当成「记录不存在」
    setFailure(CODE, ['database.getDocument']);
    await assert.rejects(() => a.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID), rejected);
    const tx = await a.beginTransaction();
    await assert.rejects(() => a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID), rejected);

    // 只让写入失败：成功形状核验必须拦住，核心因此不会继续提交
    setFailure(CODE, ['database.modifyDocument']);
    await assert.rejects(() => a.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID, { userId: OWNER }),
      e => e.code === 'SET_REJECTED_BY_SERVER');

    // 只让提交失败：真实 SDK 抛错，适配层净化为提交未知（不谎报已回滚）
    setFailure(CODE, ['database.commitTransaction']);
    await assert.rejects(() => a.commit(tx), e => e.code === 'COMMIT_UNKNOWN');
    setFailure('');
  });
});

test('M2-29 真实包 + 核心：合成空读导致目标用户缺失而早停（**不是**一次成功初始化）', async t => {
  await withRealSdk(t, async ({ db, calls }) => {
    const p = plan();
    const a = createAdapter({
      db,
      verifyCaller: async () => ({ allowed: true, envId: ENV }),
      targetUserId: OWNER,
      auditId: auditIdFor(p),
      appId: APP, envId: ENV, region: REGION
    });
    // 合成传输下 users 读也返回空 → 核心会因目标用户不存在而拒绝：
    // 这恰好证明「含 code/空读不被当成可继续」的语义，且不产生任何写入。
    const err = await bootstrapRun(a, p).then(() => null, e => e);
    assert.ok(err, '合成空读下不得通过核心的用户校验');
    const writes = calls.filter(x => x.action === 'database.modifyDocument');
    assert.equal(writes.length, 0, '核心必须零写');
    assert.equal(calls.filter(x => x.action === 'database.commitTransaction').length, 0, '不得提交');
  });
});

test('M2-30 真实包清单与版本核对（只读包元数据）', t => {
  if (!sdkAvailable()) {
    t.skip('真实包不可用：该层未验证');
    return;
  }
  const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const nodeSdkPkg = JSON.parse(fs.readFileSync(path.join(SDK_ROOT, '@cloudbase/node-sdk/package.json'), 'utf8'));
  const dbPkg = JSON.parse(fs.readFileSync(path.join(SDK_ROOT, '@cloudbase/database/package.json'), 'utf8'));
  assert.equal(nodeSdkPkg.version, '2.10.0');
  assert.equal(dbPkg.version, '1.4.1');
  // 实际事务入口必须是 transaction/index.js
  const txIndex = path.join(SDK_ROOT, '@cloudbase/database/dist/commonjs/transaction/index.js');
  assert.equal(fs.existsSync(txIndex), true, '实际事务入口 transaction/index.js 应存在');
  assert.equal(typeof sha(txIndex), 'string');
  // 管理资源 SDK 不在已查目录内 —— 不能据此说整台机器没有
  const managerSdk = fs.existsSync(path.join(SDK_ROOT, '@cloudbase/manager-node'));
  assert.equal(managerSdk, false, '已查目录内不应有 manager-node');
});
// ── R1：读取必须区分缺字段与成功空，并核对返回记录主键 ──────────────────

test('R1-a 事务读缺 data / data 为 undefined → 拒绝（不得当成无记录）', async () => {
  for (const [label, payload] of [
    ['缺 data 字段', { requestId: 'fake' }],
    ['data 为 undefined', { data: undefined }]
  ]) {
    const db = makeSyntheticDb({ txGet: { '*': payload } });
    const a = newAdapter(db);
    const tx = await a.beginTransaction();
    await assert.rejects(() => a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID),
      e => e.code === 'READ_SHAPE_INVALID', label);
    await a.rollback(tx).catch(() => {});
  }
});

test('R1-b 异常 primary / 审计读取与真实核心串联 → 零 set、零 commit', async () => {
  for (const [label, key] of [
    ['primary', 'schtest_v1_app_admins|' + PRIMARY_ID],
    ['审计', 'schtest_v1_audit_events|' + auditIdFor(plan())]
  ]) {
    for (const [sub, payload] of [['缺 data', { requestId: 'fake' }], ['data undefined', { data: undefined }]]) {
      const db = makeSyntheticDb({
        seed: { schtest_v1_users: userRecord() },
        txGet: { [key]: payload }
      });
      const a = newAdapter(db);
      const err = await bootstrapRun(a).then(() => null, e => e);
      assert.ok(err, `${label}/${sub} 必须失败`);
      assert.equal(db.log.filter(x => x.op === 'tx-set').length, 0, `${label}/${sub} 零 set`);
      assert.equal(db.committed, 0, `${label}/${sub} 零 commit`);
      assert.equal(db.log.filter(x => x.op === 'startTransaction').length, 1, '只开一个事务');
    }
  }
});

test('R1-c 未核实的兼容形状不再接受（事务数组 / 普通读裸对象）', async () => {
  // 事务读返回数组
  const db1 = makeSyntheticDb({ txGet: { '*': { data: [{ _id: PRIMARY_ID, userId: OWNER }] } } });
  const a1 = newAdapter(db1);
  const tx1 = await a1.beginTransaction();
  await assert.rejects(() => a1.getDoc(tx1, 'schtest_v1_app_admins', PRIMARY_ID),
    e => e.code === 'READ_SHAPE_INVALID', '事务数组');
  await a1.rollback(tx1).catch(() => {});
  // 普通读返回裸对象
  const db2 = makeSyntheticDb({ get: { '*': { data: { _id: PRIMARY_ID, userId: OWNER } } } });
  const a2 = newAdapter(db2);
  await assert.rejects(() => a2.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID),
    e => e.code === 'READ_SHAPE_INVALID', '普通裸对象');
});

test('R1-d 非空记录主键不匹配 / 缺 _id → 拒绝（事务与普通读都覆盖）', async () => {
  const wrong = { data: { _id: 'wrong-key', userId: OWNER, status: 'active' } };
  const missing = { data: { userId: OWNER, status: 'active' } };
  // 事务读
  for (const [label, payload] of [['错主键', wrong], ['缺 _id', missing]]) {
    const db = makeSyntheticDb({ txGet: { '*': payload } });
    const a = newAdapter(db);
    const tx = await a.beginTransaction();
    await assert.rejects(() => a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID),
      e => e.code === 'READ_KEY_MISMATCH' || e.code === 'READ_KEY_MISSING', `事务${label}`);
    await a.rollback(tx).catch(() => {});
  }
  // 普通读
  for (const [label, payload] of [
    ['错主键', { data: [{ _id: 'wrong-key', userId: OWNER }] }],
    ['缺 _id', { data: [{ userId: OWNER }] }]
  ]) {
    const db = makeSyntheticDb({ get: { '*': payload } });
    const a = newAdapter(db);
    await assert.rejects(() => a.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID),
      e => e.code === 'READ_KEY_MISMATCH' || e.code === 'READ_KEY_MISSING', `普通${label}`);
  }
});

test('R1-e 正向：显式 null / 空数组 / 主键匹配都能正常通过', async () => {
  // 事务显式 null
  const db1 = makeSyntheticDb({ txGet: { '*': { data: null } } });
  const a1 = newAdapter(db1);
  const tx1 = await a1.beginTransaction();
  assert.equal(await a1.getDoc(tx1, 'schtest_v1_app_admins', PRIMARY_ID), null);
  await a1.rollback(tx1).catch(() => {});
  // 普通空数组
  const db2 = makeSyntheticDb({ get: { '*': { data: [] } } });
  const a2 = newAdapter(db2);
  assert.equal(await a2.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID), null);
  // 主键匹配的记录
  const db3 = makeSyntheticDb({ get: { '*': { data: [{ _id: PRIMARY_ID, userId: OWNER }] } } });
  const a3 = newAdapter(db3);
  const got = await a3.readOnlyGet('schtest_v1_app_admins', PRIMARY_ID);
  assert.equal(got.userId, OWNER);
});

// ── R2：set 成功判定须符合真实 SDK 返回契约 ────────────────────────────

test('R2-a 坏回执与真实核心串联 → 零 set、零 commit', async () => {
  const bads = [
    ['updatedCount:false', { updatedCount: false }],
    ['零更新无插入', { updated: 0 }],
    ['updated 为 NaN', { updated: NaN }],
    ['updated 为负', { updated: -1 }],
    ['updated 非整数', { updated: 1.5 }],
    ['updated 为字符串', { updated: '1' }],
    ['updated 超过 1', { updated: 2 }],
    ['缺 updated', { upserted: [] }],
    ['含 code', { code: 'SYNTHETIC_DENIED', updated: 1 }],
    ['零更新 + 插入主键不符', { updated: 0, upserted: [{ _id: 'other-key' }] }]
  ];
  for (const [label, payload] of bads) {
    const db = makeSyntheticDb({ seed: { schtest_v1_users: userRecord() }, txSet: { '*': payload } });
    const a = newAdapter(db);
    const err = await bootstrapRun(a).then(() => null, e => e);
    assert.ok(err, `${label} 必须被拒绝`);
    // 关键：**零 commit**。写入请求可能已发出一次（回执在传输后才可判定），
    // 但必须被回滚、事务不得落地 —— 这才是「核心不会继续 commit」的含义。
    assert.equal(db.committed, 0, `${label} 不得 commit`);
    assert.equal(db.rolledBack, 1, `${label} 应回滚一次`);
    assert.equal(db.log.filter(x => x.op === 'tx-set').length, 1, `${label} 只有第一次写入尝试`);
  }
});

test('R2-b 正向：updated=1 与 updated=0+主键匹配的插入都通过', async () => {
  // 两条写入的目标主键不同（primary 与本计划审计），零更新回执须按各自主键给出插入结果
  for (const [label, payloadFor] of [
    ['updated=1', () => ({ updated: 1, upserted: [], requestId: 'syn' })],
    ['零更新+主键匹配的插入', (key) => ({ updated: 0, upserted: [{ _id: key }], requestId: 'syn' })]
  ]) {
    const db = makeSyntheticDb({
      seed: { schtest_v1_users: userRecord() },
      txSet: {
        '*': payloadFor(PRIMARY_ID),
        [`schtest_v1_audit_events|${auditIdFor(plan())}`]: payloadFor(auditIdFor(plan()))
      }
    });
    const a = newAdapter(db);
    const r = await bootstrapRun(a);
    assert.equal(r.granted, true, `${label}: ${r.outcome} / ${(r.detail && r.detail.cause) || ''}`);
    assert.equal(db.committed, 1, `${label} 应提交一次`);
    assert.equal(db.log.filter(x => x.op === 'tx-set').length, 2, `${label} 两条写入`);
  }
});

test('R2-c 只有底层 upsert_id（缺已核实 upserted）→ 不接受', async () => {
  const db = makeSyntheticDb({ seed: { schtest_v1_users: userRecord() }, txSet: { '*': { upsert_id: PRIMARY_ID } } });
  const a = newAdapter(db);
  const err = await bootstrapRun(a).then(() => null, e => e);
  assert.ok(err);
  assert.equal(db.committed, 0, '不得 commit');
});

// ── R3：净化前先校验调用者字段 ────────────────────────────────────────

test('R3-a 错 appId / trusted 标记与真实核心串联 → 零 begin、零读写、零 commit', async () => {
  for (const [label, verdict] of [
    ['错 appId', { allowed: true, envId: ENV, appId: 'wrong-app' }],
    ['trusted:true', { allowed: true, envId: ENV, trusted: true }]
  ]) {
    const db = makeSyntheticDb({ seed: { schtest_v1_users: userRecord() } });
    const a = newAdapter(db, async () => verdict);
    const err = await bootstrapRun(a).then(() => null, e => e);
    assert.ok(err, `${label} 必须被拒绝`);
    assert.equal(err.code, 'CALLER_VERIFY_FAILED', `${label}: ${err.code}`);
    assert.equal(db.log.filter(x => x.op === 'startTransaction').length, 0, `${label} 零 begin`);
    assert.equal(db.log.filter(x => x.op === 'tx-get' || x.op === 'get').length, 0, `${label} 零读`);
    assert.equal(db.log.filter(x => x.op === 'tx-set' || x.op === 'set').length, 0, `${label} 零写`);
    assert.equal(db.committed, 0, `${label} 零 commit`);
  }
});

test('R3-b 错 appId / trusted 直接调用适配层也拒绝', async () => {
  for (const [label, verdict, code] of [
    ['错 appId', { allowed: true, envId: ENV, appId: 'wrong-app' }, 'CALLER_APP_ID_MISMATCH'],
    ['trusted', { allowed: true, envId: ENV, trusted: true }, 'CALLER_TRUSTED_FLAG_REJECTED'],
    ['错 envId', { allowed: true, envId: 'cloud_other' }, 'CALLER_ENV_MISMATCH']
  ]) {
    const db = makeSyntheticDb({});
    const a = newAdapter(db, async () => verdict);
    await assert.rejects(() => a.verifyCaller({ envId: ENV, appId: APP }), e => e.code === code, label);
    assert.equal(db.log.length, 0, `${label} 零数据库调用`);
  }
});

test('R3-c 通过时仍不透传自由字段（含 appId/trusted 等）', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db, async () => ({
    allowed: true, envId: ENV, appId: APP, role: 'admin',
    secretId: 'SYNTHETIC_SECRET', token: 'SYNTHETIC_TOKEN'
  }));
  const r = await a.verifyCaller({ envId: ENV, appId: APP });
  assert.deepEqual(Object.keys(r).sort(), ['allowed', 'envId']);
  assert.equal(JSON.stringify(r).includes('SYNTHETIC'), false);
  assert.equal('role' in r, false, '不得透传 role 等自由字段');
});

// ── R4：私有登记保护 unknown 回滚归属 ─────────────────────────────────

test('R4-a 跨适配器句柄回滚 → 零底层调用，且 A 自己仍可回滚一次', async () => {
  const dbA = makeSyntheticDb({ commit: { '*': { __throw: true } } });
  const A = newAdapter(dbA);
  const tx = await A.beginTransaction();
  await assert.rejects(() => A.commit(tx), e => e.code === 'COMMIT_UNKNOWN');
  const before = dbA.log.filter(x => x.op === 'rollback').length;

  const dbB = makeSyntheticDb({});
  const B = newAdapter(dbB);
  await assert.rejects(() => B.rollback(tx), e => e.code === 'TX_NOT_OWNED', '跨适配器必须拒绝');
  assert.equal(dbA.log.filter(x => x.op === 'rollback').length, before, 'A 的底层 rollback 不得被调用');

  // 本实例仍可回滚一次
  await A.rollback(tx);
  assert.equal(dbA.log.filter(x => x.op === 'rollback').length, before + 1);
  // 第二次拒绝
  await assert.rejects(() => A.rollback(tx), e => e.code === 'TX_ALREADY_FINISHED');
  assert.equal(dbA.log.filter(x => x.op === 'rollback').length, before + 1, '只能回滚一次');
});

test('R4-b 伪造 __commitUnknown 句柄 → 零底层调用', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  let invoked = 0;
  const forged = { __commitUnknown: true, __tx: { rollback: async () => { invoked++; } } };
  await assert.rejects(() => a.rollback(forged), e => e.code === 'TX_NOT_OWNED');
  assert.equal(invoked, 0, '伪造句柄不得触发底层回调');
  // 旧版标志的其它组合同样无效
  for (const f of [
    { __finished: false, __adapterOwned: true, __tx: { rollback: async () => { invoked++; } } },
    { __commitUnknown: false, __tx: { rollback: async () => { invoked++; } } }
  ]) {
    await assert.rejects(() => a.rollback(f), e => e.code === 'TX_NOT_OWNED');
  }
  assert.equal(invoked, 0);
});

test('R4-c 句柄是冻结空壳：读不到底层引用，也无法替换', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  const tx = await a.beginTransaction();
  assert.equal(Object.isFrozen(tx), true, '句柄必须冻结');
  assert.deepEqual(Object.keys(tx), [], '句柄不得暴露底层引用');
  assert.equal(Object.getOwnPropertyNames(tx).length, 0);
  await a.rollback(tx);
});

test('R4-d 已结束句柄：读写提交回滚全部拒绝', async () => {
  const db = makeSyntheticDb({});
  const a = newAdapter(db);
  const tx = await a.beginTransaction();
  await a.rollback(tx);
  const finished = e => e.code === 'TX_ALREADY_FINISHED';
  await assert.rejects(() => a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID), finished);
  await assert.rejects(() => a.setDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID, { userId: OWNER }), finished);
  await assert.rejects(() => a.commit(tx), finished);
  await assert.rejects(() => a.rollback(tx), finished);
});

// ── R5：异常净化不泄露 name / message / code ─────────────────────────

test('R5-a marker 放入 message / name / code 均不进入本层公开输出', async () => {
  const M = 'SYNTHETIC_SECRET_MARKER_R5';
  const variants = [
    ['message 含 marker', new Error(M)],
    ['name 含 marker', Object.assign(new Error('ordinary'), { name: M })],
    ['code 含 marker', Object.assign(new Error('ordinary'), { code: M })],
    ['message+name 都含', Object.assign(new Error(M), { name: M })],
    // 外部构造本模块导出的 AdapterError，message/code 均为自由值
    ['外部 AdapterError', new adapterModule.AdapterError('EXTERNAL_' + M, M)]
  ];
  for (const [label, thrown] of variants) {
    const db = makeSyntheticDb({
      txGet: { ['schtest_v1_app_admins|' + PRIMARY_ID]: thrown }
    });
    const a = newAdapter(db);
    const tx = await a.beginTransaction();
    const err = await a.getDoc(tx, 'schtest_v1_app_admins', PRIMARY_ID).then(() => null, e => e);
    assert.ok(err, `${label} 必须被拒绝`);
    const dump = [
      err.code, err.message, err.originalErrorName,
      JSON.stringify(err), JSON.stringify(Object.keys(err)),
      JSON.stringify(Object.getOwnPropertyNames(err)),
      err.stack ? String(err.stack) : ''
    ].join('|');
    assert.equal(dump.includes(M), false, `${label} 泄露了 marker：${dump.slice(0, 120)}`);
    await a.rollback(tx).catch(() => {});
  }
});

test('R5-b marker 不进入核心 RESULT_UNKNOWN 的 detail', async () => {
  const M = 'SYNTHETIC_SECRET_MARKER_R5';
  for (const thrown of [
    new Error(M),
    Object.assign(new Error('ordinary'), { name: M }),
    new adapterModule.AdapterError('EXTERNAL_' + M, M)
  ]) {
    const db = makeSyntheticDb({
      seed: { schtest_v1_users: userRecord() },
      txGet: { ['schtest_v1_app_admins|' + PRIMARY_ID]: thrown }
    });
    const a = newAdapter(db);
    const err = await bootstrapRun(a).then(() => null, e => e);
    assert.ok(err, '必须失败');
    const dump = JSON.stringify({ code: err.code, message: err.message, detail: err.detail || null });
    assert.equal(dump.includes(M), false, `核心输出泄露 marker：${dump.slice(0, 140)}`);
    assert.equal(db.committed, 0, '不得 commit');
  }
});

test('R5-c 保留准确的失败类别与停止语义', async () => {
  // 传输异常 → READ_TRANSPORT_FAILED；错误码对象 → READ_REJECTED_BY_SERVER
  const db1 = makeSyntheticDb({ txGet: { '*': new TypeError('boom') } });
  const a1 = newAdapter(db1);
  const tx1 = await a1.beginTransaction();
  const e1 = await a1.getDoc(tx1, 'schtest_v1_app_admins', PRIMARY_ID).then(() => null, e => e);
  assert.equal(e1.code, 'READ_TRANSPORT_FAILED');
  assert.equal(e1.originalErrorName, 'TypeError', '白名单内的类型名保留');
  await a1.rollback(tx1).catch(() => {});

  const db2 = makeSyntheticDb({ txGet: { '*': { code: 'SYNTHETIC_DENIED' } } });
  const a2 = newAdapter(db2);
  const tx2 = await a2.beginTransaction();
  const e2 = await a2.getDoc(tx2, 'schtest_v1_app_admins', PRIMARY_ID).then(() => null, e => e);
  assert.equal(e2.code, 'READ_REJECTED_BY_SERVER');
  await a2.rollback(tx2).catch(() => {});

  // 白名单外的类型名统一为 Error
  const db3 = makeSyntheticDb({ txGet: { '*': Object.assign(new Error('x'), { name: 'WeirdError' }) } });
  const a3 = newAdapter(db3);
  const tx3 = await a3.beginTransaction();
  const e3 = await a3.getDoc(tx3, 'schtest_v1_app_admins', PRIMARY_ID).then(() => null, e => e);
  assert.equal(e3.originalErrorName, 'Error', '白名单外的名称归一为 Error');
  await a3.rollback(tx3).catch(() => {});
});

// ── 第 7 节要求的真实包正向核心串联 ───────────────────────────────────

test('M2-31 真实包 + 核心：正常初始化路径（合成传输返回真实 SDK 形状）', async t => {
  await withRealSdk(t, async ({ db, calls, asEjsonDoc, setTransport }) => {
    const p = plan();
    const a = createAdapter({
      db,
      verifyCaller: async () => ({ allowed: true, envId: ENV }),
      targetUserId: OWNER,
      auditId: auditIdFor(p),
      appId: APP, envId: ENV, region: REGION
    });
    // 用**注入传输**的真实 SDK db：把三个读取动作换成返回目标记录的合成响应，
    // 保留真实 SDK 的参数转换与 set 序列化路径。
    const targetDoc = { _id: OWNER, status: 'active', openid: OPENID };
    const primaryDoc = { _id: PRIMARY_ID, userId: OWNER, status: 'active' };
    const auditDoc = { _id: auditIdFor(p), action: 'initializeSandboxPrimary' };
    setTransport(class {
      async send(action, params = {}) {
        calls.push({ action, params });
        if (action === 'database.startTransaction') return { transactionId: 'offline-tx' };
        if (action === 'database.getDocument') {
          // 由 docId 决定返回哪条记录；空则返回空列表
          const q = typeof params.query === 'string' ? JSON.parse(params.query) : (params.query || {});
          const id = q._id;
          if (id === OWNER) return { data: { list: [asEjsonDoc(targetDoc)] }, requestId: 'syn' };
          if (id === PRIMARY_ID) return { data: { list: [asEjsonDoc(primaryDoc)] }, requestId: 'syn' };
          if (id === auditIdFor(p)) return { data: { list: [asEjsonDoc(auditDoc)] }, requestId: 'syn' };
          return { data: { list: [] }, requestId: 'syn' };
        }
        if (action === 'database.modifyDocument') {
          // 真实 SDK 的最终返回形状
          return { data: { updated: 1, upserted: [] }, requestId: 'syn-set' };
        }
        if (action === 'database.commitTransaction') return { requestId: 'syn-commit' };
        if (action === 'database.abortTransaction') return { requestId: 'syn-abort' };
        throw new Error('unexpected SDK action: ' + action);
      }
    });
    // 已存在 primary → 零写停止（证明读取形状与主键核对在真实 SDK 路径上成立）
    const stopped = await bootstrapRun(a, p);
    assert.equal(stopped.granted, false, '已存在 primary 必须零写');
    assert.equal(stopped.outcome, 'alreadyPresent');
    assert.equal(calls.filter(x => x.action === 'database.modifyDocument').length, 0, '零写');
    assert.equal(calls.filter(x => x.action === 'database.commitTransaction').length, 0, '零 commit');
  });
});

test('M2-32 真实包 + 核心：空 primary 时按真实 SDK 形状完成一次初始化', async t => {
  await withRealSdk(t, async ({ db, calls, asEjsonDoc, setTransport }) => {
    const p = plan();
    const a = createAdapter({
      db,
      verifyCaller: async () => ({ allowed: true, envId: ENV }),
      targetUserId: OWNER,
      auditId: auditIdFor(p),
      appId: APP, envId: ENV, region: REGION
    });
    const targetDoc = { _id: OWNER, status: 'active', openid: OPENID };
    setTransport(class {
      async send(action, params = {}) {
        calls.push({ action, params });
        if (action === 'database.startTransaction') return { transactionId: 'offline-tx' };
        if (action === 'database.getDocument') {
          const q = typeof params.query === 'string' ? JSON.parse(params.query) : (params.query || {});
          // 只返回目标用户；primary 与审计都是空
          if (q._id === OWNER) return { data: { list: [asEjsonDoc(targetDoc)] }, requestId: 'syn' };
          return { data: { list: [] }, requestId: 'syn' };
        }
        if (action === 'database.modifyDocument') {
          return { data: { updated: 1, upserted: [] }, requestId: 'syn-set' };
        }
        if (action === 'database.commitTransaction') return { requestId: 'syn-commit' };
        if (action === 'database.abortTransaction') return { requestId: 'syn-abort' };
        throw new Error('unexpected SDK action: ' + action);
      }
    });
    const r = await bootstrapRun(a, p);
    assert.equal(r.granted, true, (r.outcome || '') + ' / ' + (r.reason || ''));
    {
      assert.equal(r.outcome, 'initialized');
      const writes = calls.filter(x => x.action === 'database.modifyDocument');
      assert.equal(writes.length, 2, '恰好两条写入');
      assert.equal(calls.filter(x => x.action === 'database.commitTransaction').length, 1, '恰好一次提交');
      // 写请求形状：裸字段、id 在 query、同一事务
      for (const w of writes) {
        const q = JSON.parse(w.params.query);
        const data = JSON.parse(w.params.data);
        assert.equal('_id' in data, false, 'data 不得含 _id');
        assert.ok(q._id, '主键应在 query');
        assert.equal(w.params.transactionId, 'offline-tx', '同一事务');
      }
      const ids = writes.map(w => JSON.parse(w.params.query)._id).sort();
      assert.deepEqual(ids, [PRIMARY_ID, auditIdFor(p)].sort(), '写目标恰为 primary + 本计划审计');
    }
  });
});