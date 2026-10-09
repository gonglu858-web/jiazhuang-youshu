'use strict';
/**
 * R2 完整插入回执收紧 —— 复现脚本（2026-10-07）
 *
 * 目的：验证 Codex复核-首次管理员SDK适配R1-R5返修-20261007.md 第 2 节
 * 列出的 5 类回执反例已全部被拒，且不再错误继续到 initialized / granted=true。
 *
 * 边界：
 *   - **只输出 stdout**，不写任何文件；本轮结果由调用方另存为新 JSON，
 *     避免覆盖历史证据（WorkBuddyR1R5复现-20261006.json 等一律不改写）。
 *   - 全部为合成夹具 + 合成传输；**不联网、不初始化、不建资源、不部署、不启用**。
 *   - 只require 适配层与 P4 核心，**不改** P4 核心、CLI、旧业务。
 *
 * 用法：node docs/证据/WorkBuddyR2回执收紧复现-20261007.cjs > 新证据.json
 */

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
const adapterModule = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs'));
const bootstrap = require(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs'));

const { FIXED_APP_ID: APP, FIXED_ENV_ID: ENV, FIXED_REGION: REGION,
  PRIMARY_ID, createAdapter } = adapterModule;

const OPENID = 'oSYNTHETIC-openid-placeholder-for-r2-receipt';
const OWNER = bootstrap.deriveUserId(APP, OPENID);
const FIXED_NOW = 1760000000000;

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function plan(overrides) {
  return Object.assign({
    enabled: true, appId: APP, envId: ENV, roundId: 'round-r2-receipt',
    targetUserId: OWNER, evidenceId: 'ev-r2-receipt', expiresAt: '2030-01-01T00:00:00Z',
    schemaVersion: 1, operatorRef: 'operator-ref-synthetic', approvedOwnerHint: '2d3aa4'
  }, overrides || {});
}
function approval() {
  return { approvedUserIds: [OWNER], approvedBy: 'codex-review-synthetic', approvedAt: '2026-10-06T00:00:00Z' };
}
const auditIdFor = p => bootstrap.auditId(p, bootstrap.inputDigest(p));
function userRecord() { return { _id: OWNER, status: 'active', openid: OPENID }; }

/** 内存事务替身：记录调用序列，按脚本返回回执。 */
function makeDb(script) {
  const log = [];
  let committed = 0, rolledBack = 0;
  const store = { schtest_v1_users: {}, schtest_v1_app_admins: {}, schtest_v1_audit_events: {} };
  for (const rec of (script.seed || [])) store[rec._coll][rec._id] = clone(rec);
  function pick(action, args) {
    const table = script[action] || {};
    const joined = args.join('|');
    const key = Object.prototype.hasOwnProperty.call(table, joined) ? joined
      : (Object.prototype.hasOwnProperty.call(table, '*') ? '*' : undefined);
    if (key === undefined) return { __default: true };
    const v = table[key];
    return typeof v === 'function' ? v(args) : v;
  }
  const db = {
    log,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    collection(name) {
      return { doc(id) { return { async get() {
        log.push({ op: 'get', collection: name, id });
        const r = pick('get', [name, id]);
        if (r && r.__default) { const rec = store[name][id]; return { data: rec ? [clone(rec)] : [] }; }
        return clone(r);
      } }; } };
    },
    async startTransaction() {
      log.push({ op: 'startTransaction' });
      return {
        collection: (name) => ({ doc: (id) => ({
          async get() {
            log.push({ op: 'tx-get', collection: name, id });
            const r = pick('txGet', [name, id]);
            if (r && r.__default) { const rec = store[name][id]; return { data: rec ? clone(rec) : null }; }
            return clone(r);
          },
          async set(fields) {
            log.push({ op: 'tx-set', collection: name, id });
            const r = pick('txSet', [name, id]);
            if (r && r.__default) {
              store[name][id] = Object.assign({ _id: id }, clone(fields));
              // 与真实包 document.js:108–112 一致：无底层 upsert_id 时为 [{_id:undefined}]
              return { updated: 1, upserted: [{ _id: undefined }], requestId: 'syn-set' };
            }
            if (r && r.__apply !== false) store[name][id] = Object.assign({ _id: id }, clone(fields));
            return clone(r);
          }
        }) }),
        async commit() { log.push({ op: 'commit' }); committed++; return true; },
        async rollback() { log.push({ op: 'rollback' }); rolledBack++; return true; }
      };
    }
  };
  return db;
}

function newAdapter(db) {
  return createAdapter({
    db,
    verifyCaller: async () => ({ allowed: true, envId: ENV }),
    targetUserId: OWNER,
    auditId: auditIdFor(plan()),
    appId: APP, envId: ENV, region: REGION
  });
}

function runCore(db) {
  const a = newAdapter(db);
  return bootstrap.initializePrimary({
    plan: plan(), adapter: a, approval: approval(),
    fixedNowMs: FIXED_NOW, nowMs: FIXED_NOW
  }).then(r => ({ outcome: r.outcome, granted: r.granted }),
    e => ({ code: e.code, message: e.message }));
}

function counts(db) {
  return {
    begin: db.log.filter(x => x.op === 'startTransaction').length,
    read: db.log.filter(x => x.op === 'tx-get' || x.op === 'get').length,
    write: db.log.filter(x => x.op === 'tx-set').length,
    commit: db.committed,
    rollback: db.rolledBack
  };
}

async function main() {
  const p = plan();
  const auditKey = `schtest_v1_audit_events|${auditIdFor(p)}`;

  // ── 报告第 2 节表中的 5 类反例（落在首写） ──
  const firstWrite = [
    ['R2-multiple-upserts', { updated: 0, upserted: [{ _id: PRIMARY_ID }, { _id: 'other-key' }] }],
    ['R2-duplicate-upserts', { updated: 0, upserted: [{ _id: PRIMARY_ID }, { _id: PRIMARY_ID }] }],
    ['R2-unverified-string-upsert', { updated: 0, upserted: [PRIMARY_ID] }],
    ['R2-updated-one-wrong-insert', { updated: 1, upserted: [{ _id: 'other-key' }] }],
    ['R2-updated-one-invalid-shape', { updated: 1, upserted: false }]
  ];

  // ── 同一契约落在第二写（审计）──
  const secondWrite = [
    ['R2-second-write-multiple', { updated: 0, upserted: [{ _id: 'other-key' }, { _id: 'other-key-2' }] }],
    ['R2-second-write-empty-array', { updated: 0, upserted: [] }],
    ['R2-second-write-updated-one-invalid', { updated: 1, upserted: false }]
  ];

  const samples = [];

  for (const [id, payload] of firstWrite) {
    const db = makeDb({ seed: [{ _coll: 'schtest_v1_users', _id: OWNER, ...userRecord() }], txSet: { '*': payload } });
    const result = await runCore(db);
    samples.push({ id, stage: 'first-write', payload, result, counts: counts(db),
      dangerous: result.granted === true });
  }
  for (const [id, payload] of secondWrite) {
    const db = makeDb({ seed: [{ _coll: 'schtest_v1_users', _id: OWNER, ...userRecord() }],
      txSet: { [auditKey]: payload } });
    const result = await runCore(db);
    samples.push({ id, stage: 'second-write', payload, result, counts: counts(db),
      dangerous: result.granted === true });
  }

  // ── 合成替身正向：不得误拒本包两种成功形状 ──
  const positives = [
    ['POS-updated-one-placeholder', {
      seed: [{ _coll: 'schtest_v1_users', _id: OWNER, ...userRecord() }],
      txSet: { '*': { updated: 1, upserted: [{ _id: undefined }], requestId: 'syn' } }
    }],
    ['POS-zero-update-matching-keys', {
      seed: [{ _coll: 'schtest_v1_users', _id: OWNER, ...userRecord() }],
      txSet: {
        '*': { updated: 0, upserted: [{ _id: PRIMARY_ID }], requestId: 'syn' },
        [auditKey]: { updated: 0, upserted: [{ _id: auditIdFor(p) }], requestId: 'syn' }
      }
    }]
  ];
  for (const [id, script] of positives) {
    const db = makeDb(script);
    const result = await runCore(db);
    samples.push({ id, stage: 'positive', result, counts: counts(db),
      expected: 'initialized/granted=true', pass: result.granted === true && db.committed === 1 });
  }

  // ── 真实包正向（合成传输，网络完全拦截）：updated:0 + upsert_id:目标键 ──
  const SDK_ROOT = process.env.SANDBOX_SDK_ROOT
    || 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
  let realSdk = { attempted: false, verified: false, note: '' };
  try {
    require(path.join(SDK_ROOT, '@cloudbase/node-sdk'));
    require(path.join(SDK_ROOT, '@cloudbase/database'));
    const { Db } = require(path.join(SDK_ROOT, '@cloudbase/database'));
    const sdk = require(path.join(SDK_ROOT, '@cloudbase/node-sdk'));
    const net = { attempts: 0 };
    const block = () => { net.attempts++; throw new Error('OFFLINE_ONLY'); };
    for (const [name, methods] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
      ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']]]) {
      const m = require(name);
      for (const k of methods) m[k] = block;
    }
    require('node:net').Socket.prototype.connect = block;
    globalThis.fetch = block;
    const original = Db.reqClass;
    // 顺序约束（真实包实测）：先 init 出 db，再替换 Db.reqClass
    const db = sdk.init({
      env: 'offline-shape-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true
    }).database();
    const bson = require(path.join(SDK_ROOT, 'bson'));
    const EJSON = bson.EJSON || bson;
    const asEjson = d => JSON.stringify(EJSON.serialize(d, { relaxed: false }));
    Db.reqClass = class {
      async send(action, params = {}) {
        if (action === 'database.startTransaction') return { transactionId: 'offline-tx' };
        if (action === 'database.getDocument') {
          const q = typeof params.query === 'string' ? JSON.parse(params.query) : (params.query || {});
          if (q._id === OWNER) return { data: { list: [asEjson(userRecord())] }, requestId: 'syn' };
          return { data: { list: [] }, requestId: 'syn' };
        }
        if (action === 'database.modifyDocument') {
          const q = typeof params.query === 'string' ? JSON.parse(params.query) : (params.query || {});
          return { data: { updated: 0, upsert_id: q._id }, requestId: 'syn-set' };
        }
        if (action === 'database.commitTransaction') return { requestId: 'syn-commit' };
        if (action === 'database.abortTransaction') return { requestId: 'syn-abort' };
        throw new Error('unexpected SDK action: ' + action);
      }
    };
    const a = createAdapter({
      db,
      verifyCaller: async () => ({ allowed: true, envId: ENV }),
      targetUserId: OWNER, auditId: auditIdFor(p), appId: APP, envId: ENV, region: REGION
    });
    const r = await bootstrap.initializePrimary({
      plan: p, adapter: a, approval: approval(), fixedNowMs: FIXED_NOW, nowMs: FIXED_NOW
    }).then(x => ({ outcome: x.outcome, granted: x.granted }), e => ({ code: e.code, message: e.message }));
    Db.reqClass = original;
    realSdk = {
      attempted: true, verified: r.granted === true,
      outcome: r.outcome || null, networkAttempts: net.attempts,
      note: '离线合成传输；底层给 upsert_id=各自主键，经真实 SDK 转换后 upserted:[{_id:目标键}]'
    };
  } catch (error) {
    realSdk = { attempted: true, verified: false, note: '真实包不可用或被拦截：' + (error && error.message) };
  }

  const dangerous = samples.filter(s => s.dangerous === true).length;
  const positivesAllPass = samples.filter(s => s.stage === 'positive').every(s => s.pass);

  const report = {
    observedAt: new Date().toISOString(),
    scope: 'offline synthetic R2 receipt tightening; no cloud initialization',
    sourceReview: 'docs/Codex复核-首次管理员SDK适配R1-R5返修-20261007.md 第2节',
    receiptContract: {
      sdkSource: '@cloudbase/database 1.4.1 dist/commonjs/document.js:108–112',
      transactionSetReturn: '{ updated, upserted: [{_id: res.data.upsert_id}], requestId }',
      rules: [
        'updated 必须是有限非负整数且 <= 1',
        'upserted 必须存在、必须是数组、元素数量恰为 1、元素必须是对象',
        'updated===0：_id 必须是有效字符串且等于目标主键（无占位）',
        'updated===1：_id 为 undefined/null 视为本包正常无插入占位；否则必须是目标主键'
      ],
      notAccepted: ['多条/重复元素', '字符串等非对象元素', 'updated=1 分支的错误主键或无效结构', 'updatedCount 或单独 upsert_id 作为替代凭据']
    },
    samples,
    realSdkPositiveInsertion: realSdk,
    summary: {
      total: samples.length,
      dangerousInitialized: dangerous,
      allRejectedHaveZeroCommit: samples.filter(s => s.stage !== 'positive').every(s => s.counts.commit === 0),
      rollbackAttempted: samples.filter(s => s.stage !== 'positive').every(s => s.counts.rollback === 1),
      positivesPass: positivesAllPass
    },
    notVerified: [
      '真实平台 upserted/upsert_id 的实际返回形态未实测',
      '平台事务原子性、并发冲突与回滚语义未验证',
      '真实请求签名与 IAM 未核实',
      '生产调用者核验未接通（依赖注入不是授权机制）'
    ],
    untouched: [
      'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs（P4 核心）',
      'miniapp/scripts/prepare-sandbox-primary.cjs（CLI --execute 仍拒绝）',
      '旧业务代码、历史证据 JSON 与历史测试脚本'
    ],
    files: {
      adapter: 'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs',
      adapterSha256: crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs'))).digest('hex'),
      test: 'miniapp/tests/sandbox-primary-sdk-adapter.test.cjs',
      testSha256: crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, 'miniapp/tests/sandbox-primary-sdk-adapter.test.cjs'))).digest('hex')
    }
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch(e => { process.stdout.write(JSON.stringify({ fatal: String(e && e.message) }) + '\n'); process.exit(1); });