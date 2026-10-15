'use strict';
// Independent LOCAL review of 39ac526. Observed defects are not acceptance tests.
// No SDK, credentials, platform calls, or business writes. Only synthetic records.
// Default stdout; --out exclusively creates a new evidence file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const hits = [];
const restore = [];
function guard(object, key) {
  if (typeof object[key] !== 'function') return;
  const old = object[key];
  object[key] = function () { hits.push(key); throw new Error('OFFLINE_REVIEW_BLOCKED'); };
  restore.push(() => { object[key] = old; });
}
for (const mod of ['node:http', 'node:https']) for (const key of ['request', 'get']) guard(require(mod), key);
for (const key of ['connect', 'createConnection']) guard(require('node:net'), key);
guard(require('node:net').Socket.prototype, 'connect');
guard(require('node:tls'), 'connect');
for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), key); guard(require('node:dns').promises, key);
}
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) guard(require('node:child_process'), key);
guard(globalThis, 'fetch');
const corePath = path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs');
const packerPath = path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs');
const core = require(corePath);
const packer = require(packerPath);
const business = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const implementationSha256 = hash(fs.readFileSync(corePath));
const packerSha256 = hash(fs.readFileSync(packerPath));
const OUT = path.join(ROOT, 'artifacts/schedule-sandbox/business-test');
const run = crypto.randomUUID();
const work = path.join(OUT, 'participant-identity-review-' + run);
fs.mkdirSync(work, { recursive: true });
const passphrase = 'synthetic-independent-only-not-a-real-passphrase';
const digest = hash(passphrase);
const openid = 'synthetic-independent-context';
const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);
let sequence = 0;
const rows = [{ _id: userId, openid, status: 'active' }];
function put(value) {
  const p = path.join(work, 'fixture-' + (++sequence) + '.json');
  fs.writeFileSync(p, JSON.stringify(value, null, 2), { flag: 'wx' }); return p;
}
function out() { return path.join(OUT, 'participant-identity-review-' + run + '-' + (++sequence)); }
function withClock(value, fn) {
  const old = Date.now;
  Date.now = typeof value === 'function' ? value : () => value;
  try { return fn(); } finally { Date.now = old; }
}
function caught(fn) {
  try { return { returned: fn() }; } catch (e) { return { name: e.name, code: e.code || null, message: e.message }; }
}
async function inspect(options = {}) {
  const calls = { collection: 0, doc: 0, get: 0, field: 0, writes: 0 };
  const trap = () => { calls.writes++; throw new Error('WRITE_FORBIDDEN'); };
  const ref = {
    field(fields) { calls.field++; calls.fields = fields; return this; },
    async get() {
      calls.get++;
      if (options.readError) throw options.readError;
      if (options.afterRead) options.afterRead();
      return { data: options.rows === undefined ? rows : options.rows };
    }, set: trap, update: trap, remove: trap
  };
  const db = {
    collection(name) {
      calls.collection++; assert.equal(name, core.FIXED_TARGET.collection);
      if (options.beforeGetError) throw new Error('synthetic collection failure');
      return { doc(id) { calls.doc++; assert.equal(id, userId); return ref; }, add: trap, where: trap };
    }, runTransaction: trap, startTransaction: trap, add: trap, set: trap, update: trap, remove: trap
  };
  const checker = core.createIdentityChecker({ db,
    trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, openid },
    config: { checkRoundId: 'synthetic-independent-round', passphraseDigest: digest,
      windowStartsAtMs: 1000, windowExpiresAtMs: 5000 }, now: options.now || (() => 2000) });
  const result = await checker.handle(Object.assign({ action: 'inspectSelf', passphrase }, options.request || {}));
  assert.equal(calls.writes, 0);
  return { result, calls };
}
const findings = [];
async function probe(id, kind, fn) {
  try { findings.push({ id, kind, assertionsPassed: true, actual: await fn() }); }
  catch (error) { findings.push({ id, kind, assertionsPassed: false, error: error.message }); }
}
async function main() {
  await probe('C00', 'guard-control', async () => {
    assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_REVIEW_BLOCKED/);
    assert.throws(() => require('node:child_process').spawn('node', []), /OFFLINE_REVIEW_BLOCKED/);
    return { sensitivityHits: hits.length };
  });
  const sensitivity = hits.length;
  const businessRound = 'synthetic-review-' + run;
  const closePlan = put({ schema: 'business-test-plan/1', window: 'P', synthetic: true,
    businessRoundId: businessRound, windowNo: 'P-01',
    appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
      userId: 'u_' + hash('synthetic-' + role).slice(0, 40), source: 'synthetic review fixture' }])),
    projectReadyMarker: 'ready-' + businessRound,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z' });
  const closeSource = business.build('P', closePlan, path.join(work, 'close-source')).outDir;
  const basePlan = { schema: packer.PLAN_SCHEMA, synthetic: true,
    checkRoundId: 'synthetic-independent-round', participantCode: '1', ...core.FIXED_TARGET,
    passphraseDigest: digest, windowStartsAtIso: '2030-01-01T00:00:00.000Z',
    windowExpiresAtIso: '2030-01-01T00:10:00.000Z', closeSourceDir: closeSource };
  const validPlan = put(basePlan);
  const built = packer.build(validPlan, out());
  await probe('C01', 'positive-control', async () => {
    const first = await inspect();
    assert.equal(first.result.registrationState, 'ACTIVE');
    assert.equal(first.calls.get, 1);
    assert.equal(packer.checkDir(built.outDir).ok, true);
    const reuse = packer.build(validPlan, built.outDir);
    assert.equal(reuse.io.filter(x => x.action === 'written').length, 0);
    assert.equal(reuse.io.length, 38);
    const old = process.env.PIC_CLOSE_SOURCE_DIR;
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    let closed;
    try { closed = withClock(NaN, () => packer.checkCloseDir(built.outDir)); }
    finally { if (old === undefined) delete process.env.PIC_CLOSE_SOURCE_DIR; else process.env.PIC_CLOSE_SOURCE_DIR = old; }
    assert.equal(closed.ok, true);
    return { state: first.result.registrationState, reads: first.calls.get, writes: first.calls.writes,
      buildWritten: built.io.length, reuseWritten: 0, reused: 38, closeAtNaNOk: closed.ok, closeFiles: closed.files };
  });
  await probe('C02', 'R1-reproduction', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(built.outDir, 'project.config.json')));
    const miniprogramRootExists = fs.existsSync(path.join(built.outDir, cfg.miniprogramRoot));
    const cloudfunctionRootExists = fs.existsSync(path.join(built.outDir, cfg.cloudfunctionRoot));
    assert.equal(miniprogramRootExists, false); assert.equal(cloudfunctionRootExists, false);
    return { miniprogramRoot: cfg.miniprogramRoot, cloudfunctionRoot: cfg.cloudfunctionRoot,
      miniprogramRootExists, cloudfunctionRootExists, checkOk: packer.checkDir(built.outDir).ok };
  });
  await probe('C03', 'R2-reproduction', async () => {
    const a = await inspect(); const b = await inspect({ rows: [] });
    for (const x of [a, b]) { assert.equal(x.result.identityConfirmed, true); assert.equal(x.result.userId, undefined); }
    return { states: [a.result.registrationState, b.result.registrationState], fullUserIdReturned: false,
      tailLength: a.result.userIdTail.length, fields: Object.keys(a.result) };
  });
  await probe('C04', 'R3-reproduction', async () => {
    // Inject only source bytes in memory. No original source file is changed.
    const read = fs.readFileSync; let injected = 0;
    const original = read(corePath); const changed = Buffer.concat([original, Buffer.from('\n// synthetic source drift\n')]);
    fs.readFileSync = function (p, ...args) {
      if (typeof p === 'string' && path.resolve(p) === corePath) {
        injected++; return typeof args[0] === 'string' ? changed.toString(args[0]) : changed;
      }
      return read.call(this, p, ...args);
    };
    let driftBuild, check;
    try { driftBuild = packer.build(validPlan, out()); check = packer.checkDir(driftBuild.outDir); }
    finally { fs.readFileSync = read; }
    assert.equal(check.ok, true); assert.ok(injected >= 2);
    assert.equal(hash(read(corePath)), implementationSha256);
    assert.equal(hash(read(path.join(driftBuild.outDir, 'server/participant-identity-check.js'))), hash(changed));
    return { sourceDriftAccepted: true, written: driftBuild.io.length, checkOk: check.ok, originalSourceUnchanged: true };
  });
  const realPlan = put({ ...basePlan, synthetic: false });
  const start = Date.parse(basePlan.windowStartsAtIso), expires = Date.parse(basePlan.windowExpiresAtIso);
  const realBuilt = withClock(start + 1, () => packer.build(realPlan, out()));
  await probe('C05', 'R4-reproduction', async () => {
    const failures = {};
    for (const [key, clock] of [['expired', expires + 1], ['invalid', NaN], ['error', () => { throw new Error('synthetic clock failed'); }]]) {
      failures[key] = withClock(clock, () => caught(() => packer.checkDir(realBuilt.outDir)));
      assert.equal(failures[key].name, 'ReferenceError');
    }
    const planPath = path.join(built.outDir, 'plan.json'), saved = fs.readFileSync(planPath);
    try {
      fs.writeFileSync(planPath, Buffer.concat([saved, Buffer.from(' ')]));
      failures.planHashMismatch = caught(() => packer.checkDir(built.outDir));
      assert.equal(failures.planHashMismatch.name, 'ReferenceError');
    } finally { fs.writeFileSync(planPath, saved); }
    return failures;
  });
  await probe('C06', 'R5-expiry-reproduction', async () => {
    const atEnd = await inspect({ now: () => 5000 });
    assert.equal(atEnd.result.identityConfirmed, true); assert.equal(atEnd.calls.get, 1);
    const exactBuild = withClock(expires, () => packer.build(realPlan, out()));
    const check = withClock(expires, () => packer.checkDir(exactBuild.outDir));
    assert.equal(check.ok, true);
    return { coreConfirmedAtExpiry: true, reads: atEnd.calls.get, buildWrittenAtExpiry: exactBuild.io.length, checkOkAtExpiry: true };
  });
  await probe('C07', 'R5-window-reproduction', async () => {
    const accepted = [];
    for (const minutes of [0, -1]) {
      const file = put({ ...basePlan, windowExpiresAtIso: new Date(start + minutes * 60000).toISOString() });
      const b = packer.build(file, out()); assert.equal(packer.checkDir(b.outDir).ok, true);
      accepted.push({ minutes, written: b.io.length, checkOk: true });
    }
    return { nonpositiveWindowsAccepted: accepted };
  });
  await probe('C08', 'R5-round-reproduction', async () => {
    const accepted = [];
    for (const value of [undefined, '', 17]) {
      const r = await inspect({ request: { checkRoundId: value } });
      assert.equal(r.result.identityConfirmed, true); accepted.push({ type: typeof value, reads: r.calls.get });
    }
    const rejected = await inspect({ request: { checkRoundId: 'other-round' } });
    assert.equal(rejected.calls.get, 0); assert.equal(rejected.result.code, 'PIC_ROUND_MISMATCH');
    return { invalidOrAbsentRoundAccepted: accepted, wrongStringRoundRejected: true };
  });
  await probe('C09', 'R6-projection-reproduction', async () => {
    const marker = 'synthetic-raw-sdk-detail-do-not-return';
    const error = Object.assign(new Error(marker), { code: 'PIC_READ_FAILED' });
    const r = await inspect({ readError: error });
    assert.equal(r.result.message, marker);
    const unknown = await inspect({ readError: Object.assign(new Error(marker), { code: 'PIC_UNREVIEWED' }) });
    assert.equal(unknown.result.code, 'PIC_UNREVIEWED');
    return { rawSdkMessageReflected: true, unlistedCodeReturned: unknown.result.code, reads: r.calls.get };
  });
  await probe('C10', 'R6-read-facts-reproduction', async () => {
    const r = await inspect({ beforeGetError: true });
    assert.equal(r.calls.get, 0); assert.equal(r.result.readAttempted, true);
    return { getCalls: r.calls.get, reportedReadAttempted: r.result.readAttempted, state: r.result.registrationState };
  });
  await probe('C11', 'R6-missing-fields-reproduction', async () => {
    const states = [];
    for (const key of ['_id', 'openid']) {
      const row = { ...rows[0] }; delete row[key];
      const r = await inspect({ rows: [row] }); assert.equal(r.result.registrationState, 'MISMATCH');
      states.push({ missing: key, actual: r.result.registrationState });
    }
    return states;
  });
  await probe('C12', 'R6-minimal-read-reproduction', async () => {
    const r = await inspect(); assert.equal(r.calls.get, 1); assert.equal(r.calls.field, 0);
    return { getCalls: r.calls.get, projectionCalls: r.calls.field, minimalFieldsSelected: false };
  });
  await probe('C13', 'rejection-and-postread-controls', async () => {
    const denied = await inspect({ request: { action: 'identify' } });
    assert.equal(denied.calls.collection, 0);
    let clock = 2000;
    const post = await inspect({ now: () => clock, afterRead: () => { clock = 5001; } });
    assert.equal(post.result.code, 'PIC_WINDOW_EXPIRED'); assert.equal(post.result.readAttempted, true);
    const failure = await inspect({ readError: Object.assign(new Error('synthetic'), { code: 'SDK_ERROR' }) });
    assert.equal(failure.result.registrationState, 'UNKNOWN'); assert.equal(failure.result.code, 'PIC_READ_FAILED');
    return { wrongActionCollectionCalls: denied.calls.collection, postReadExpiredConfirmed: post.result.identityConfirmed,
      postReadAttempted: true, ordinarySdkFailureUnknown: true };
  });
  const result = { schema: 'codex-participant-identity-review/1', reviewedCommit: '39ac526', baseline: '104aea8',
    implementationSha256, packerSha256, verificationKind: 'LOCAL actual code + synthetic db/clock; no SDK or platform',
    findings, guardAccounting: { sensitivity: sensitivity, unexpected: hits.length - sensitivity },
    summary: { total: findings.length, assertionsPassed: findings.filter(x => x.assertionsPassed).length,
      meaning: 'Assertions confirm recorded behavior, including defects; NOT acceptance.' } };
  const i = process.argv.indexOf('--out');
  if (i >= 0) {
    if (!process.argv[i + 1]) throw new Error('--out requires a new path');
    fs.writeFileSync(path.resolve(process.argv[i + 1]), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (findings.some(x => !x.assertionsPassed) || hits.length !== sensitivity) process.exitCode = 1;
}
main().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; })
  .finally(() => { for (const fn of restore.reverse()) fn(); });
