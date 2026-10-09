'use strict';
// 独立合成回执复核。只输出 stdout；不加载 SDK/联网，不改旧证据。
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const m = require(path.join(root, 'miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs'));
const core = require(path.join(root, 'miniapp/scripts/lib/sandbox-primary-bootstrap.cjs'));
const openid = 'synthetic-r2-final-only';
const user = core.deriveUserId(m.FIXED_APP_ID, openid);
const plan = { enabled: true, appId: m.FIXED_APP_ID, envId: m.FIXED_ENV_ID, roundId: 'review-r2-final',
  targetUserId: user, evidenceId: 'offline-only', expiresAt: '2030-01-01T00:00:00Z', schemaVersion: 1,
  operatorRef: 'local-review', approvedOwnerHint: '2d3aa4' };
const approval = { approvedUserIds: [user], approvedBy: 'synthetic-review', approvedAt: '2026-10-07T00:00:00Z' };
const auditId = core.auditId(plan, core.inputDigest(plan));
async function run(receipt, failureAt) {
  const counts = { begin: 0, reads: 0, writes: 0, commits: 0, rollbacks: 0 };
  const db = { collection() { throw new Error('unexpected plain read'); }, async startTransaction() {
    counts.begin++;
    return { collection(name) { return { doc(key) { return {
      async get() { counts.reads++; return { data: name === 'schtest_v1_users' ? { _id: user, status: 'active', openid } : null }; },
      async set() { counts.writes++; return !failureAt || counts.writes === failureAt ? receipt(key) : { updated: 0, upserted: [{ _id: key }] }; }
    }; } }; }, async commit() { counts.commits++; }, async rollback() { counts.rollbacks++; } };
  } };
  const adapter = m.createAdapter({ db, verifyCaller: async () => ({ allowed: true, envId: m.FIXED_ENV_ID }),
    appId: m.FIXED_APP_ID, envId: m.FIXED_ENV_ID, region: m.FIXED_REGION, targetUserId: user, auditId });
  try { const r = await core.initializePrimary({ adapter, plan, approval }); return { outcome: r.outcome, ...counts }; }
  catch (e) { return { code: e.code, ...counts }; }
}
(async () => {
  const cases = [];
  for (const [name, receipt] of [
    ['multiple', key => ({ updated: 0, upserted: [{ _id: key }, { _id: 'other' }] })],
    ['duplicate', key => ({ updated: 0, upserted: [{ _id: key }, { _id: key }] })],
    ['string', key => ({ updated: 0, upserted: [key] })],
    ['updated-wrong-key', () => ({ updated: 1, upserted: [{ _id: 'other' }] })],
    ['updated-invalid-shape', () => ({ updated: 1, upserted: false })]
  ]) for (const position of [1, 2]) {
    const r = await run(receipt, position);
    cases.push({ id: name + '-write-' + position, result: r,
      passed: r.code === 'RESULT_UNKNOWN' && r.commits === 0 && r.rollbacks === 1 && r.writes === position });
  }
  for (const [name, receipt] of [
    ['insert-positive', key => ({ updated: 0, upserted: [{ _id: key }] })],
    ['update-placeholder-positive', () => ({ updated: 1, upserted: [{ _id: undefined }] })]
  ]) {
    const r = await run(receipt);
    cases.push({ id: name, result: r, passed: r.outcome === 'initialized' && r.writes === 2 && r.commits === 1 && r.rollbacks === 0 });
  }
  const report = { observedAt: new Date().toISOString(), scope: 'local synthetic responses, real adapter and core; no platform verification',
    summary: { total: cases.length, passed: cases.filter(x => x.passed).length, failed: cases.filter(x => !x.passed).length }, cases };
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.failed) process.exitCode = 1;
})().catch(e => { console.error('HARNESS_FAILED', e.code || e.name); process.exitCode = 1; });
