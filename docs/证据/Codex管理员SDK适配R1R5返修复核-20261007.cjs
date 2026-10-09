'use strict';
// 本地独立复核；合成 db/传输，真实适配层与业务核心；只输出 stdout，不改旧证据。
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const m = require(path.join(root, 'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs'));
const core = require(path.join(root, 'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs'));
const openid = 'synthetic-review-only';
const user = core.deriveUserId(m.FIXED_APP_ID, openid);
const plan = { enabled: true, appId: m.FIXED_APP_ID, envId: m.FIXED_ENV_ID,
  roundId: 'review-r1-r5', targetUserId: user, evidenceId: 'review-only',
  expiresAt: '2030-01-01T00:00:00Z', schemaVersion: 1, operatorRef: 'local-review', approvedOwnerHint: '2d3aa4' };
const approval = { approvedUserIds: [user], approvedBy: 'synthetic-review', approvedAt: '2026-10-07T00:00:00Z' };
const audit = core.auditId(plan, core.inputDigest(plan));
function create(db, caller) {
  return m.createAdapter({ db, verifyCaller: async () => caller || { allowed: true, envId: m.FIXED_ENV_ID },
    targetUserId: user, auditId: audit, appId: m.FIXED_APP_ID, envId: m.FIXED_ENV_ID, region: m.FIXED_REGION });
}
function fixture(o = {}) {
  const count = { begin: 0, read: 0, write: 0, commit: 0, rollback: 0 };
  const doc = (col, key, plain) => ({ async get() {
    count.read++;
    if (o.readError) throw o.readError;
    if (plain) return o.plain || { data: [] };
    if (col === 'schtest_v1_users') return { data: { _id: user, status: 'active', openid } };
    return Object.hasOwn(o, 'read') ? o.read : { data: null };
  }, async set() { count.write++; return o.set ? o.set(key) : { updated: 0, upserted: [{ _id: key }], requestId: 'fake' }; } });
  const db = { collection(col) { return { doc(key) { return doc(col, key, true); } }; },
    async startTransaction() { count.begin++; return {
      collection(col) { return { doc(key) { return doc(col, key, false); } }; },
      async commit() { count.commit++; if (o.commitThrow) throw new Error('fake timeout'); },
      async rollback() { count.rollback++; }
    }; }
  };
  return { adapter: create(db, o.caller), count };
}
async function run(o) {
  const f = fixture(o);
  try { const r = await core.initializePrimary({ adapter: f.adapter, plan, approval }); return { outcome: r.outcome, granted: r.granted, ...f.count }; }
  catch (e) { return { code: e.code, ...f.count }; }
}
async function realSdkPositive() {
  let networkAttempts = 0;
  const block = () => { networkAttempts++; throw new Error('OFFLINE_ONLY'); };
  for (const [mod, keys] of [['http', ['request', 'get']], ['https', ['request', 'get']], ['net', ['connect', 'createConnection']], ['tls', ['connect']]]) {
    for (const key of keys) require('node:' + mod)[key] = block;
  }
  require('node:net').Socket.prototype.connect = block; globalThis.fetch = block;
  const sdkRoot = process.env.SANDBOX_SDK_ROOT || 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
  let sdk, Db, EJSON;
  try { sdk = require(path.join(sdkRoot, '@cloudbase/node-sdk')); ({ Db } = require(path.join(sdkRoot, '@cloudbase/database'))); ({ EJSON } = require(path.join(sdkRoot, 'bson'))); }
  catch { return { verified: false, reason: 'existing SDK unavailable; not installed', networkAttempts }; }
  const db = sdk.init({ env: 'offline-only', secretId: 'SYNTHETIC', secretKey: 'SYNTHETIC', throwOnCode: true }).database();
  const original = Db.reqClass;
  const calls = [];
  Db.reqClass = class { async send(action, params = {}) {
    calls.push(action);
    if (action === 'database.startTransaction') return { transactionId: 'offline-tx' };
    if (action === 'database.getDocument') {
      const id = JSON.parse(params.query)._id;
      const doc = { _id: user, status: 'active', openid };
      return { data: { list: id === user ? [JSON.stringify(EJSON.serialize(doc, { relaxed: false }))] : [] }, requestId: 'offline-read' };
    }
    if (action === 'database.modifyDocument') return { data: { updated: 0, upsert_id: JSON.parse(params.query)._id }, requestId: 'offline-insert' };
    if (action === 'database.commitTransaction' || action === 'database.abortTransaction') return { requestId: 'offline-finish' };
    throw new Error('unexpected synthetic action');
  } };
  try {
    const r = await core.initializePrimary({ adapter: create(db), plan, approval });
    return { verified: true, outcome: r.outcome, writes: calls.filter(x => x === 'database.modifyDocument').length,
      commits: calls.filter(x => x === 'database.commitTransaction').length, networkAttempts,
      transportShape: '{data:{updated:0,upsert_id:requestedKey}}; SDK converts to object entries' };
  } finally { Db.reqClass = original; }
}
(async () => {
  const closedCases = [];
  for (const [id, o] of [
    ['R1-missing-data', { read: { requestId: 'fake' } }], ['R1-undefined-data', { read: { data: undefined } }],
    ['R2-false-updatedCount', { set: () => ({ updatedCount: false }) }], ['R2-zero-no-upsert', { set: () => ({ updated: 0 }) }],
    ['R3-wrong-appId', { caller: { allowed: true, envId: m.FIXED_ENV_ID, appId: 'wrong-app' } }],
    ['R3-trusted-test-marker', { caller: { allowed: true, envId: m.FIXED_ENV_ID, trusted: true } }]
  ]) { const r = await run(o); closedCases.push({ id, result: r, closed: r.commit === 0 && !r.granted }); }
  const f = fixture({ plain: { data: [{ _id: 'wrong-key' }] } });
  const badKey = await f.adapter.readOnlyGet('schtest_v1_app_admins', 'primary').then(() => null, e => e.code);
  closedCases.push({ id: 'R1-wrong-key-read', code: badKey, closed: badKey === 'READ_KEY_MISMATCH' });
  const a = fixture({ commitThrow: true }), b = fixture(); const tx = await a.adapter.beginTransaction();
  await a.adapter.commit(tx).catch(() => {});
  const foreign = await b.adapter.rollback(tx).then(() => null, e => e.code);
  closedCases.push({ id: 'R4-cross-adapter-unknown', code: foreign, closed: foreign === 'TX_NOT_OWNED' && a.count.rollback === 0 });
  await a.adapter.rollback(tx);
  let spoofCalls = 0;
  const spoof = await b.adapter.rollback({ __commitUnknown: true, __tx: { async rollback() { spoofCalls++; } } }).then(() => null, e => e.code);
  closedCases.push({ id: 'R4-forged-unknown', code: spoof, closed: spoof === 'TX_NOT_OWNED' && spoofCalls === 0 });
  const marker = 'SYNTHETIC_SENSITIVE_MARKER'; const injectedName = new Error('hidden'); injectedName.name = marker;
  for (const [id, e] of [['R5-error-name', injectedName], ['R5-adapter-error', new m.AdapterError(marker, marker)]]) {
    const g = fixture({ readError: e });
    const direct = await g.adapter.readOnlyGet('schtest_v1_app_admins', 'primary').catch(x => x);
    const r = await core.initializePrimary({ adapter: g.adapter, plan, approval }).catch(x => x);
    closedCases.push({ id, closed: !JSON.stringify({ direct, message: direct.message, stack: direct.stack, core: r }).includes(marker) });
  }
  const remainingCases = [];
  for (const [id, set] of [
    ['R2-multiple-upserts', key => ({ updated: 0, upserted: [{ _id: key }, { _id: 'wrong-key' }] })],
    ['R2-duplicate-upserts', key => ({ updated: 0, upserted: [{ _id: key }, { _id: key }] })],
    ['R2-unverified-string-upsert', key => ({ updated: 0, upserted: [key] })],
    ['R2-updated-one-wrong-insert', () => ({ updated: 1, upserted: [{ _id: 'wrong-key' }] })],
    ['R2-updated-one-invalid-shape', () => ({ updated: 1, upserted: false })]
  ]) remainingCases.push({ id, result: await run({ set }) });
  const sdk = await realSdkPositive();
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), scope: 'offline synthetic review; no cloud initialization',
    closedCases, remainingCases, realSdkInsertionPositive: sdk,
    summary: { originalCases: closedCases.length, closed: closedCases.filter(x => x.closed).length,
      remainingSamples: remainingCases.length, unexpectedInitialized: remainingCases.filter(x => x.result.granted).length } }, null, 2));
})().catch(e => { console.error('HARNESS_FAILED', e.code || e.name); process.exitCode = 1; });
