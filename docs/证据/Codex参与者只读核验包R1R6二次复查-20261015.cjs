'use strict';
// Local independent review: c5d58ff, basis ece7659. No SDK/platform calls.
// Passing reproduction assertions confirm a defect, not acceptance.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const hits = [], restores = [];
function guard(o, k) {
  if (typeof o[k] !== 'function') return;
  const old = o[k]; o[k] = function () { hits.push(k); throw new Error('OFFLINE_BLOCKED'); };
  restores.push(() => { o[k] = old; });
}
for (const mod of ['node:http', 'node:https']) for (const k of ['get', 'request']) guard(require(mod), k);
for (const k of ['connect', 'createConnection']) guard(require('node:net'), k);
guard(require('node:net').Socket.prototype, 'connect'); guard(require('node:tls'), 'connect');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), k); guard(require('node:dns').promises, k);
}
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) guard(require('node:child_process'), k);
guard(globalThis, 'fetch');
const corePath = path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs');
const packerPath = path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs');
const core = require(corePath), packer = require(packerPath);
const business = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const sourceHashes = { implementationSha256: hash(fs.readFileSync(corePath)), packerSha256: hash(fs.readFileSync(packerPath)) };
const OUT = path.join(ROOT, 'artifacts/schedule-sandbox/business-test');
const run = crypto.randomUUID(), work = path.join(OUT, 'participant-identity-review2-' + run);
fs.mkdirSync(work, { recursive: true });
let sequence = 0;
const pass = 'synthetic-review-only-passphrase-not-a-real-secret';
const round = 'synthetic-review2-round', openid = 'synthetic-review2-openid';
const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);
const row = { _id: userId, openid, status: 'active', unrelatedSyntheticField: 'must-not-be-read' };
const start = Date.parse('2030-01-01T00:00:00Z'), expiry = start + 600000;
function put(v) { const p = path.join(work, 'fixture-' + (++sequence) + '.json'); fs.writeFileSync(p, JSON.stringify(v), { flag: 'wx' }); return p; }
function out() { return path.join(OUT, 'participant-identity-review2-' + run + '-' + (++sequence)); }
function clock(value, fn) { const old = Date.now; Date.now = typeof value === 'function' ? value : () => value; try { return fn(); } finally { Date.now = old; } }
function fixture(o = {}) {
  const calls = { collection: 0, get: 0, field: 0, writes: 0, returnedKeys: [] };
  const trap = () => { calls.writes++; throw new Error('WRITE_FORBIDDEN'); };
  let projection = null;
  const ref = { field(v) { calls.field++; projection = v; return this; }, get() {
    calls.get++; if (o.getError) throw o.getError;
    if (o.afterRead) o.afterRead();
    const data = o.rows === undefined ? [row] : o.rows;
    const selected = data.map(r => projection ? Object.fromEntries(Object.keys(projection).filter(k => k in r).map(k => [k, r[k]])) : { ...r });
    calls.returnedKeys = selected[0] ? Object.keys(selected[0]) : [];
    return Promise.resolve({ data: selected });
  }, set: trap, update: trap, remove: trap };
  if (o.noField) delete ref.field;
  const db = { collection(name) {
    calls.collection++; assert.equal(name, core.FIXED_TARGET.collection);
    if (o.collectionError) throw new Error('synthetic constructor error');
    return { doc(id) { assert.equal(id, userId); return ref; }, add: trap, where: trap };
  }, runTransaction: trap, startTransaction: trap, set: trap, update: trap, remove: trap };
  return { db, calls };
}
async function inspect(o = {}) {
  const f = fixture(o);
  const checker = core.createIdentityChecker({ db: f.db,
    trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, openid },
    config: { checkRoundId: round, passphraseDigest: hash(pass), windowStartsAtMs: start, windowExpiresAtMs: expiry },
    now: o.now || (() => start + 1000) });
  const result = await checker.handle({ action: 'inspectSelf', passphrase: pass, checkRoundId: round, ...o.request });
  assert.equal(f.calls.writes, 0); return { result, calls: f.calls };
}
const probes = [];
async function probe(id, kind, fn) {
  try { probes.push({ id, kind, assertionsPassed: true, actual: await fn() }); }
  catch (e) { probes.push({ id, kind, assertionsPassed: false, error: e.message }); }
}
function generatedSession(dir, o = {}) {
  const f = fixture(o), requests = [], cache = new Map(); let app, page;
  class LocalDate extends Date { static now() { return start + 1000; } }
  const cloud = { DYNAMIC_CURRENT_ENV: 'synthetic-dynamic', init() {},
    getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: openid }), database: () => f.db };
  const wx = { cloud: { init() {}, async callFunction(v) {
    requests.push({ name: v.name, checkRoundId: v.data.checkRoundId, includeFullUserId: v.data.includeFullUserId === true });
    return { result: await load(path.join(dir, 'server/index.js')).main(v.data) };
  } } };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.js';
    if (cache.has(file)) return cache.get(file).exports;
    const m = { exports: {} }; cache.set(file, m);
    const sandbox = { module: m, exports: m.exports, Date: LocalDate,
      process: { env: { TCB_ENV: core.FIXED_TARGET.envId } }, wx,
      App(v) { app = v; }, Page(v) { page = v; },
      require(id) {
        if (id === 'wx-server-sdk') return cloud;
        if (id === 'node:crypto') return crypto;
        if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
        throw new Error('Unexpected dependency: ' + id);
      } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file }); return m.exports;
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'project.config.json')));
  const frontend = path.join(dir, cfg.miniprogramRoot);
  load(path.join(frontend, 'app.js'));
  const pages = JSON.parse(fs.readFileSync(path.join(frontend, 'app.json'))).pages;
  load(path.join(frontend, pages[0] + '.js'));
  page.data = JSON.parse(JSON.stringify(page.data)); page.setData = function (v) { Object.assign(this.data, v); };
  app.onLaunch(); page.onLoad(); page.onShow();
  return { page, requests, calls: f.calls };
}
async function main() {
  await probe('D0', 'guard-control', async () => {
    assert.throws(() => require('node:https').get('https://example.invalid'), /OFFLINE_BLOCKED/);
    assert.throws(() => require('node:child_process').spawn('node', []), /OFFLINE_BLOCKED/); return { sensitivity: hits.length };
  });
  const sensitivity = hits.length;
  const closePlan = put({ schema: 'business-test-plan/1', window: 'P', synthetic: true,
    businessRoundId: 'synthetic-review2-' + run, windowNo: 'P-01', appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, { userId: 'u_' + hash('synthetic-' + role).slice(0, 40), source: 'synthetic review' }])),
    projectReadyMarker: 'synthetic-ready', windowStartsAt: new Date(start).toISOString(), windowExpiresAt: new Date(start + 3600000).toISOString() });
  const closeSource = business.build('P', closePlan, path.join(work, 'close-source')).outDir;
  const plan = { schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: round, participantCode: '1', ...core.FIXED_TARGET,
    passphraseDigest: hash(pass), windowStartsAtIso: new Date(start).toISOString(), windowExpiresAtIso: new Date(expiry).toISOString(), closeSourceDir: closeSource };
  const planPath = put(plan), built = clock(start + 1, () => packer.build(planPath, out()));
  await probe('D1', 'R1-layout-and-reuse', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(built.outDir, 'project.config.json')));
    assert.equal(cfg.miniprogramRoot, 'frontend/'); assert.equal(cfg.cloudfunctionRoot, 'server/');
    for (const key of ['miniprogramRoot', 'cloudfunctionRoot']) assert.equal(fs.statSync(path.join(built.outDir, cfg[key])).isDirectory(), true);
    assert.equal(clock(start + 1, () => packer.checkDir(built.outDir)).ok, true);
    const reuse = clock(start + 1, () => packer.build(planPath, built.outDir));
    assert.equal(reuse.io.filter(x => x.action === 'written').length, 0);
    // Only remove this run's own known fixture file to test legitimate resume.
    fs.unlinkSync(path.join(built.outDir, 'frontend/app.wxss'));
    const resume = clock(start + 1, () => packer.build(planPath, built.outDir));
    assert.equal(resume.io.filter(x => x.action === 'written').length, 1);
    return { rootsExist: true, checkOk: true, reused: reuse.io.length, resumeWritten: 1, resumeReused: resume.io.length - 1 };
  });
  await probe('D2', 'R3-all-pinned-sources', async () => {
    const sourceText = fs.readFileSync(packerPath, 'utf8');
    const entries = [...sourceText.matchAll(/'(miniapp\/scripts\/[^']+)': '([0-9a-f]{64})'/g)]; assert.equal(entries.length, 13);
    for (const entry of entries) {
      const file = path.join(ROOT, entry[1]), read = fs.readFileSync, original = read(file); assert.equal(hash(original), entry[2]);
      const changed = Buffer.concat([original, Buffer.from('\n// synthetic source drift\n')]), output = out();
      fs.readFileSync = function (p, ...args) {
        if (typeof p === 'string' && path.resolve(p) === file) return typeof args[0] === 'string' ? changed.toString(args[0]) : changed;
        return read.call(this, p, ...args);
      };
      try {
        assert.throws(() => clock(start + 1, () => packer.build(planPath, output)), e => e.code === 'PIC_SOURCE_DRIFT');
        const checked = clock(start + 1, () => packer.checkDir(built.outDir)); assert.equal(checked.ok, false);
        assert.ok(checked.problems.some(p => p.includes('PIC_SOURCE_DRIFT'))); assert.equal(fs.existsSync(output), false);
      } finally { fs.readFileSync = read; }
      assert.equal(hash(read(file)), entry[2]);
    }
    return { pinnedEntries: 13, buildDriftRejectedZeroArtifacts: 13, checkDriftRejected: 13, diskSourcesUnchanged: true };
  });
  await probe('D3', 'R4-early-returns', async () => {
    const codes = [];
    for (const [value, code] of [[expiry, 'PIC_WINDOW_EXPIRED'], [NaN, 'PIC_CLOCK_INVALID'], [() => { throw new Error('synthetic clock'); }, 'PIC_CLOCK_ERROR']]) {
      const r = clock(value, () => packer.checkDir(built.outDir)); assert.equal(r.ok, false); assert.equal(r.planChecked, false);
      assert.ok(r.problems.some(p => p.includes(code))); codes.push(code);
    }
    const pp = path.join(built.outDir, 'plan.json'), mp = path.join(built.outDir, 'manifest.json');
    const oldP = fs.readFileSync(pp), oldM = fs.readFileSync(mp);
    for (const label of ['missing', 'hash', 'invalid', 'source']) {
      try {
        if (label === 'missing') fs.unlinkSync(pp);
        else if (label === 'hash') fs.writeFileSync(pp, Buffer.concat([oldP, Buffer.from(' ')]));
        else {
          const value = JSON.parse(oldP); if (label === 'invalid') value.participantCode = '3'; else value.closeSourceDir = path.join(work, 'missing-source');
          const bytes = Buffer.from(JSON.stringify(value)), manifest = JSON.parse(oldM); manifest.planSha256 = hash(bytes);
          fs.writeFileSync(pp, bytes); fs.writeFileSync(mp, JSON.stringify(manifest));
        }
        const r = clock(start + 1, () => packer.checkDir(built.outDir)); assert.equal(r.ok, false); assert.equal(r.planChecked, false);
      } finally { fs.writeFileSync(pp, oldP); fs.writeFileSync(mp, oldM); }
    }
    return { classifiedClockFailures: codes, otherEarlyReturns: 4, referenceErrors: 0 };
  });
  await probe('D4', 'R5-window-and-round', async () => {
    for (const now of [start - 1, expiry, expiry + 1, NaN]) { const r = await inspect({ now: () => now }); assert.equal(r.result.identityConfirmed, false); assert.equal(r.calls.get, 0); }
    for (const now of [start, start + 1]) assert.equal((await inspect({ now: () => now })).result.identityConfirmed, true);
    for (const value of [undefined, null, '', 17, 'other-round']) { const r = await inspect({ request: { checkRoundId: value } }); assert.equal(r.calls.collection, 0); }
    for (const delta of [0, -1]) {
      const file = put({ ...plan, windowExpiresAtIso: new Date(start + delta).toISOString() }), output = out();
      assert.throws(() => clock(start, () => packer.build(file, output)), e => e.code === 'PIC_PLAN_WINDOW_INVALID'); assert.equal(fs.existsSync(output), false);
    }
    const expiredOut = out(); assert.throws(() => clock(expiry, () => packer.build(planPath, expiredOut)), e => e.code === 'PIC_WINDOW_EXPIRED'); assert.equal(fs.existsSync(expiredOut), false);
    let now = start + 1; const post = await inspect({ now: () => now, afterRead: () => { now = expiry; } });
    assert.equal(post.result.identityConfirmed, false); assert.equal(post.result.readAttempted, true);
    return { clockEdgesCorrect: true, badRoundsRejectedBeforeCollection: 5, nonpositiveWindowsRejected: 2, expiryBuildZeroWrite: true, postReadExpiryPreservesAttempt: true };
  });
  await probe('D5', 'R6-fixed-controls', async () => {
    const good = await inspect(); assert.deepEqual(good.calls.returnedKeys.sort(), ['_id', 'openid', 'status']);
    const pre = await inspect({ collectionError: true }); assert.equal(pre.result.readAttempted, false);
    for (const code of ['PIC_READ_FAILED', 'PIC_UNREVIEWED', 'SDK_ERROR']) {
      const r = await inspect({ getError: Object.assign(new Error('synthetic-private-error'), { code }), request: { includeFullUserId: true } });
      assert.equal(r.result.readAttempted, true); assert.equal(r.result.userId, null); assert.equal(r.result.code, 'PIC_READ_FAILED');
      assert.equal(r.result.message.includes('synthetic-private-error'), false);
    }
    for (const key of ['_id', 'openid', 'status']) { const v = { ...row }; delete v[key]; const r = await inspect({ rows: [v] }); assert.equal(r.result.registrationState, 'UNKNOWN'); }
    const explicit = await inspect({ request: { includeFullUserId: true } }); assert.equal(explicit.result.userId, userId);
    const absent = await inspect({ rows: [], request: { includeFullUserId: true } }); assert.equal(absent.result.userId, userId); assert.equal(absent.result.registrationState, 'ABSENT');
    return { projectionKeys: good.calls.returnedKeys, preGetAttempted: false, getFailureAttempted: true, rawErrorsSuppressed: 3, missingFieldsUnknown: 3, controlledFullIdActiveAndAbsent: true };
  });
  await probe('D6', 'generated-page-positive-controls', async () => {
    const outcomes = [];
    for (const selected of [false, true]) {
      const s = generatedSession(built.outDir); assert.equal(s.requests.length, 0);
      if (selected) s.page.onWantFullIdChange({ detail: { value: ['full'] } });
      s.page.onPassphraseInput({ detail: { value: pass } });
      await Promise.all([s.page.onCheckTap(), s.page.onCheckTap()]);
      assert.equal(s.requests.length, 1); assert.equal(s.requests[0].checkRoundId, round); assert.equal(s.requests[0].name, 'scheduleSandbox');
      assert.equal(s.page.data.result.fullUserIdAvailable, selected); assert.equal(s.page.data.passphrase, ''); assert.equal(s.calls.writes, 0);
      outcomes.push({ selected, fullIdAvailable: s.page.data.result.fullUserIdAvailable, sends: s.requests.length, reads: s.calls.get });
    }
    return { chain: 'generated App/Page/client/main/copied core + synthetic wx/db', outcomes };
  });
  await probe('D7', 'S1-cancel-checkbox-defect', async () => {
    const s = generatedSession(built.outDir);
    s.page.onWantFullIdChange({ detail: { value: ['full'] } });
    s.page.onWantFullIdChange({ detail: { value: [] } });
    assert.equal(s.page.data.wantFullUserId, true);
    s.page.onPassphraseInput({ detail: { value: pass } }); await s.page.onCheckTap();
    assert.equal(s.requests[0].includeFullUserId, true); assert.equal(s.page.data.result.userId, userId);
    return { cancellationEventValue: [], storedChoiceAfterCancel: s.page.data.wantFullUserId, requestIncludesFullId: true, fullIdDisplayed: true, sends: s.requests.length, writes: s.calls.writes };
  });
  await probe('D8', 'S2-missing-field-defect', async () => {
    const r = await inspect({ noField: true, request: { includeFullUserId: true } });
    assert.equal(r.calls.field, 0); assert.equal(r.calls.get, 1); assert.equal(r.result.registrationState, 'ACTIVE'); assert.equal(r.result.userId, userId);
    assert.ok(r.calls.returnedKeys.includes('unrelatedSyntheticField'));
    return { fieldCalls: 0, getCalls: r.calls.get, fetchedUnrelatedField: true, identityConfirmed: r.result.identityConfirmed, fullIdDelivered: true, writes: r.calls.writes };
  });
  await probe('D9', 'close-control', async () => {
    const old = process.env.PIC_CLOSE_SOURCE_DIR; process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    try { const r = clock(NaN, () => packer.checkCloseDir(built.outDir)); assert.equal(r.ok, true); return { atNaN: r.ok, files: r.files }; }
    finally { if (old === undefined) delete process.env.PIC_CLOSE_SOURCE_DIR; else process.env.PIC_CLOSE_SOURCE_DIR = old; }
  });
  const report = { schema: 'codex-participant-identity-r1r6-second-review/1', reviewedCommit: 'c5d58ff', reviewBasis: 'ece7659', ...sourceHashes,
    verificationKind: 'LOCAL actual generated code + synthetic wx/db/clock; SDK/platform not executed', probes,
    guardAccounting: { sensitivity, unexpected: hits.length - sensitivity },
    summary: { total: probes.length, assertionsPassed: probes.filter(p => p.assertionsPassed).length, defectsReproduced: probes.filter(p => p.assertionsPassed && p.kind.endsWith('-defect')).length,
      meaning: 'Includes defect reproduction assertions; not acceptance.' } };
  const i = process.argv.indexOf('--out');
  if (i >= 0) { if (!process.argv[i + 1]) throw new Error('Missing --out path'); fs.writeFileSync(path.resolve(process.argv[i + 1]), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (probes.some(p => !p.assertionsPassed) || hits.length !== sensitivity) process.exitCode = 1;
}
main().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; }).finally(() => { for (const restore of restores.reverse()) restore(); });
