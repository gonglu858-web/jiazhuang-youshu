'use strict';
// 54fc06c 独立反例。只读源文件、VM/内存替身；不启动子进程，不录入编号，不调用云端。
// ok 表示反例及对照复现完成，不表示产品通过。默认 stdout；--out 仅 wx 新建。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const helper = require(path.join(root, 'miniapp/tests/helpers/pic-guard-runner.cjs'));
const hits = []; let phase = 'setup';
helper.installParentGuards({ hits, getPhase: () => phase, allowedScripts: [] });
phase = 'probe';
for (const act of [() => require('https').request('https://example.invalid'), () => require('child_process').spawn('blocked', [])]) { try { act(); } catch (_) {} }
phase = 'business';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const source = rel => fs.readFileSync(path.join(root, rel), 'utf8');
function load(rel, overrides = {}, injected = {}) {
  const filename = path.join(root, rel), module = { exports: {} };
  const req = id => Object.hasOwn(overrides, id) ? overrides[id] : require(id);
  req.main = null;
  vm.runInNewContext(source(rel), { module, exports: module.exports, require: req,
    __dirname: path.dirname(filename), __filename: filename, Buffer, console, process, ...injected }, { filename });
  return module.exports;
}
const coreRel = 'miniapp/scripts/lib/participant-self-registration.cjs';
const core = require(path.join(root, coreRel));
const app = 'wxfb4db1615ac15531', env = 'cloud1-d8gcq5ag39d847723';
const openid = 'synthetic-codex-review-person';
const uid = core.deriveUserId(app, openid), aid = core.deriveRegistrationAuditId(app, env, uid);
const round = 'synthetic-codex-registration', pass = 'synthetic-codex-pass';
const config = { registrationRoundId: round, passphraseDigest: sha(pass), allowedAccount: uid,
  windowStartsAtMs: 1000, windowExpiresAtMs: 10000, usersCollection: 'schtest_v1_users',
  auditCollection: 'schtest_v1_audit_events', sourceProtocol: core.SELF_REG_SCHEMA, synthetic: false };
const request = { action: 'registerSelf', registrationRoundId: round, passphrase: pass };
const user = () => ({ _id: uid, openid, status: 'active', createdAt: 'synthetic-time', updatedAt: 'synthetic-time' });
const audit = () => ({ _id: aid, projectId: null, actorUserId: uid, actorRole: '本人普通账号', action: 'registerIdentity',
  subjectUserId: uid, before: null, after: { status: 'active' }, createdAt: 'synthetic-time',
  sourceProtocol: core.SELF_REG_SCHEMA, registrationRoundId: round });
function memory(opts = {}) {
  const docs = new Map(); if (opts.user) docs.set(uid, opts.user); if (opts.audit) docs.set(aid, opts.audit);
  const calls = { collections: 0, transactions: 0, gets: 0, creates: 0, fields: 0 };
  const db = { collection() { calls.collections++; return { doc(id) { return { id,
    field() { calls.fields++; return this; }, async get() { calls.gets++; if (opts.onRead) opts.onRead();
      return { data: opts.dropRead ? null : docs.get(id) || null }; } }; } }; },
    async runTransaction(cb) { calls.transactions++; if (opts.txError) throw Object.assign(new Error('synthetic'), { code: opts.txError });
      return cb({ get: async ref => ({ data: docs.get(ref.id) || null }), create: async (ref, value) => { calls.creates++; docs.set(ref.id, value); } }); } };
  return { db, calls };
}
async function run(opts = {}) {
  const m = memory(opts); let t = opts.now === undefined ? 2000 : opts.now;
  if (opts.expireOnRead) opts.onRead = () => { t = 10000; };
  // onRead is read dynamically by memory; no platform or concurrency guarantee is inferred.
  const checker = core.createSelfRegistrationChecker({ db: m.db, trusted: { appId: app, envId: env, OPENID: openid },
    config: { ...config, ...opts.config }, now: () => t });
  const result = await checker.handle({ ...request, ...opts.request });
  return { result, calls: m.calls };
}
const cases = [];
async function check(name, fn) { const fact = await fn(); cases.push({ name, ...fact }); }
async function main() {
  await check('positiveSyntheticMemory', async () => { const x = await run(); assert.equal(x.result.outcome, 'CREATED_AND_VERIFIED'); assert.equal(x.calls.creates, 2); return x; });
  await check('R1_beforeWindowStillCreates', async () => { const x = await run({ now: 500 }); assert.equal(x.result.outcome, 'CREATED_AND_VERIFIED'); assert.equal(x.calls.creates, 2); return x; });
  await check('R1_expiryDuringReadbackStillSuccess', async () => { const x = await run({ expireOnRead: true }); assert.equal(x.result.outcome, 'CREATED_AND_VERIFIED'); return x; });
  await check('R3_wrongOpenidAccepted', async () => { const x = await run({ user: { ...user(), openid: 'synthetic-other-person' } }); assert.equal(x.result.outcome, 'ALREADY_ACTIVE'); return x; });
  await check('R3_incompleteAuditAccepted', async () => { const a = audit(); delete a.actorRole; delete a.createdAt; delete a.after; const x = await run({ user: user(), audit: a }); assert.equal(x.result.outcome, 'ALREADY_ACTIVE'); return x; });
  await check('R3_missingReadbackStillActive', async () => { const x = await run({ user: user(), dropRead: true }); assert.equal(x.result.outcome, 'ALREADY_ACTIVE'); assert.equal(x.result.readBack.user, false); return x; });
  await check('R3_noProjection', async () => { const x = await run(); assert.equal(x.calls.gets, 2); assert.equal(x.calls.fields, 0); return { calls: x.calls }; });
  await check('R3_priorRoundAuditRejected', async () => { const x = await run({ user: user(), audit: { ...audit(), registrationRoundId: 'synthetic-prior-round' } }); assert.equal(x.result.code, 'PIC_AUDIT_CONFLICT'); return x; });
  await check('R3_rawSdkCodeEcho', async () => { const x = await run({ txError: 'synthetic-secret-error-code' }); assert.equal(x.result.code, 'synthetic-secret-error-code'); return { rawSyntheticCodeEchoed: true, outcome: x.result.outcome }; });
  await check('R3_wrongRoundEchoesClient', async () => { const x = await run({ request: { registrationRoundId: 'synthetic-old-client' } }); assert.equal(x.result.registrationRoundId, 'synthetic-old-client'); return x; });
  await check('R1_entryFactoryBeforeRejection', async () => {
    const rel = 'miniapp/scripts/templates/participant-self-registration/server/scheduleSandbox/index.js';
    let s = source(rel); const replacements = { CONFIG_ENABLED: 'true', CONFIG_APP_ID: JSON.stringify(app), CONFIG_ENV_ID: JSON.stringify(env),
      CONFIG_REGISTRATION_ROUND_ID: JSON.stringify(round), CONFIG_PASSPHRASE_DIGEST: JSON.stringify(sha(pass)), CONFIG_ALLOWED_ACCOUNT: JSON.stringify(uid),
      CONFIG_WINDOW_STARTS_AT_MS: '1000', CONFIG_WINDOW_EXPIRES_AT_MS: '10000' };
    for (const [k,v] of Object.entries(replacements)) s = s.replace(new RegExp('const ' + k + ' = [^;]*;'), 'const ' + k + ' = ' + v + ';');
    const m = memory(); let factory = 0; const module = { exports: {} };
    const sdk = { init() {}, getWXContext: () => ({ APPID: app, OPENID: openid }), database() { factory++; return m.db; } };
    vm.runInNewContext(s, { module, exports: module.exports, Date: { now: () => 2000 }, require: id => id === 'wx-server-sdk' ? sdk : id === './request-adapter' ? { extractBusinessRequest: event => ({ ok: true, request: event }) } : core });
    const r = await module.exports.main({ ...request, passphrase: 'synthetic-wrong' });
    assert.equal(r.code, 'PIC_PASSPHRASE_MISMATCH'); assert.equal(factory, 1);
    return { factory, collections: m.calls.collections, code: r.code, scope: 'template constants injected in memory; adapter substitute; actual entry/core' };
  });
  await check('R2_realSdkTransactionClassIncompatible', async () => {
    const sdkFile = path.join(process.env.USERPROFILE, '.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/wx-server-sdk/index.js');
    const sdkText = fs.readFileSync(sdkFile, 'utf8'); const start = sdkText.indexOf('class Transaction {');
    assert.ok(start > 0); const end = sdkText.indexOf('exports.Transaction = Transaction;', start);
    const context = {}; vm.runInNewContext(sdkText.slice(start, end) + '\nthis.RealTransaction = Transaction;', context);
    const tx = new context.RealTransaction({}, {});
    assert.equal(typeof tx.collection, 'function'); assert.equal(typeof tx.get, 'undefined'); assert.equal(typeof tx.create, 'undefined');
    const m = memory(); m.db.runTransaction = cb => cb(tx);
    const r = await core.createSelfRegistrationChecker({ db: m.db, trusted: { appId: app, envId: env, OPENID: openid }, config, now: () => 2000 }).handle(request);
    assert.equal(r.code, 'PIC_TRANSACTION_FAILED'); assert.equal(m.calls.creates, 0);
    return { sdkFileSha256: sha(sdkText), classSourceSha256: sha(sdkText.slice(start, end)), methods: { collection: typeof tx.collection, get: typeof tx.get, create: typeof tx.create }, code: r.code,
      scope: 'exact installed wx 3.0.1 Transaction class evaluated; no complete SDK transport/retry verification' };
  });
  await check('R4_privateBindingsNotValidated', async () => {
    const rel = 'miniapp/scripts/lib/participant-private-store.cjs';
    const plain = { schema: 'participant-self-registration-private-payload/1', participantCode: '9', fullAccount: 'synthetic-invalid', appId: 'synthetic-wrong', deliveryConfirmed: false };
    // Obtain exact schema without executing a real process.
    const stats = [];
    const fakeFs = { lstatSync(p) { stats.push(p); return { isSymbolicLink: () => false, isDirectory: () => true }; }, readFileSync: () => 'synthetic-cipher' };
    const fakeCp = { spawnSync(cmd, args) { if (cmd === 'git') return { status: 0, stdout: args[0] === 'check-ignore' ? 'ignored' : '' };
      if (cmd === 'icacls') return { status: 0, stdout: 'S-1-1-0:(F)' }; return { status: 0, stdout: JSON.stringify(plain) }; } };
    const store = load(rel, { 'node:fs': fakeFs, 'node:child_process': fakeCp }); plain.schema = store.PAYLOAD_SCHEMA;
    const target = store.PRIVATE_ROOT_REL + '/synthetic-review.bin'; const got = store.readRecord({ repoRoot: root, relativePath: target });
    assert.equal(got.participantCode, '9'); assert.equal(got.deliveryConfirmed, false);
    assert.equal(stats.includes(path.resolve(root, target)), false);
    const p = store.buildPrivatePayload({ participantCode: '1', fullAccount: uid, appId: 'synthetic-wrong', envId: 'synthetic-wrong', roundId: round,
      serverTimeIso: null, sourceDigest: '0'.repeat(64), deliveryConfirmed: true });
    assert.equal(p.appId, 'synthetic-wrong'); assert.equal(p.serverTimeIso, null);
    return { invalidDecryptedBindingAccepted: true, arbitraryTargetAccepted: true, absentSourceTimeAccepted: true,
      broadSidAclAccepted: true, targetFileNotLstatChecked: true, scope: 'fs/DPAPI/process substitutes; no private file read or OS ACL changed' };
  });
  await check('R6_guardBypassAndUncountedDenial', async () => {
    const recorded = []; let actualSpawn = 0;
    const cp = { spawnSync() { actualSpawn++; return { status: 0 }; } };
    const fakeShared = { installParentGuards(opts) { cp.spawnSync = () => { opts.hits.push('blocked'); throw Error('blocked'); }; return {}; } };
    const g = load('miniapp/tests/helpers/psr-guard-runner.cjs', { 'node:child_process': cp, './pic-guard-runner.cjs': fakeShared });
    g.installParentGuardsWithLocalTools({ hits: recorded });
    try { cp.spawnSync('unapproved-command', []); } catch (_) {}
    assert.equal(recorded.length, 0);
    const args = ['-NoProfile', '-NonInteractive', '-Command', '# ConvertTo-SecureString\n[System.Net.WebRequest]::Create("https://example.invalid")'];
    assert.equal(g.isAllowedToolCall('powershell.exe', args), true);
    cp.spawnSync('powershell.exe', args); assert.equal(actualSpawn, 1);
    return { uncountedDeniedCalls: 1, arbitraryScriptPassedToNativeSpy: 1, realProcessesStarted: 0 };
  });
  await check('R5_manifestMappingAndUnknownFieldsAccepted', async () => {
    const rel = 'miniapp/scripts/package-participant-self-registration.cjs';
    const packer = require(path.join(root, rel));
    const parent = path.join(root, 'artifacts/schedule-sandbox/business-test');
    // Existing CodeBuddy SYNTHETIC fixture only; no files are modified or copied.
    let dir;
    for (const d of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith('participant-self-registration-ev-a-')) continue;
      const candidate = path.join(parent, d.name);
      try { const plan = JSON.parse(fs.readFileSync(path.join(candidate, 'plan.json'), 'utf8'));
        if (plan.synthetic === true && packer.checkDir(candidate).ok) { dir = candidate; break; }
      } catch (_) {}
    }
    assert.ok(dir, '需要原交付的合法 synthetic 夹具');
    const manifestPath = path.join(dir, 'manifest.json');
    const original = fs.readFileSync(manifestPath);
    const changed = JSON.parse(original); changed.closePackage.mapping = 'unrelated mapping';
    changed.unapprovedField = 'synthetic-extra'; changed.files[0].note = 'synthetic-extra';
    const proxyFs = new Proxy(fs, { get(target, key) { if (key !== 'readFileSync') return target[key];
      return (p, ...args) => path.resolve(String(p)) === manifestPath ? (typeof args[0] === 'string' ? JSON.stringify(changed) : Buffer.from(JSON.stringify(changed))) : fs.readFileSync(p, ...args); } });
    const mutated = load(rel, { 'node:fs': proxyFs });
    assert.equal(mutated.checkDir(dir).ok, true); assert.equal(mutated.checkPreparedDir(dir).ok, true);
    assert.ok(fs.readFileSync(manifestPath).equals(original));
    return { fixture: path.relative(root, dir), originalAccepted: true, forgedMappingAccepted: true,
      unknownTopAndFileFieldsAccepted: true, diskUnchanged: true, scope: 'manifest bytes substituted only in memory' };
  });
  await check('R3_malformedResponsePresentedAsNoWrite', async () => {
    let page;
    load('miniapp/scripts/templates/participant-self-registration/frontend/pages/self-registration/self-registration.js', {
      '../../utils/registration-check-client': { callSelfRegistration: async () => ({ response: { errCode: 'synthetic-sdk-error' }, localRequestEvidence: null }) },
      '../../config/cloud': {} }, { Page: p => { page = p; } });
    page.setData = updates => Object.assign(page.data, updates); page.data.passphrase = pass;
    await page.onRegisterTap(); assert.ok(page.data.stopHint.includes('未写入')); assert.equal(page.data.passphrase, '');
    return { malformedResultClaimsNoWrite: true, passphraseCleared: true };
  });
  const probes = hits.filter(h => h.phase === 'probe').length;
  const unexpected = hits.filter(h => h.phase !== 'probe');
  const verdict = helper.verdictFor({ probes, parentUnexpected: unexpected.length, childUnexpectedTotal: 0, receiptFailures: 0 });
  assert.equal(verdict.ok, true);
  const report = { schema: 'codex-self-registration-review/1', reviewedCommit: '54fc06c', basis: '77c5ddd',
    ok: verdict.ok, meaning: 'counterexamples reproduced, NOT product acceptance', cases: cases.length, results: cases,
    guard: { probes, unexpected, processesStarted: 0 }, runtimeDigests: { core: sha(source(coreRel)),
      packer: sha(source('miniapp/scripts/package-participant-self-registration.cjs')) },
    limitations: ['Memory DB is not platform transaction verification', 'Private storage tests use synthetic DPAPI/fs substitutes', 'No real ID input or network/cloud operation'] };
  const argv = process.argv.slice(2);
  if (argv.length) { assert.equal(argv.length, 2); assert.equal(argv[0], '--out'); fs.writeFileSync(path.resolve(argv[1]), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify(argv.length ? { ok: report.ok, cases: report.cases, guard: report.guard } : report, null, 2));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
