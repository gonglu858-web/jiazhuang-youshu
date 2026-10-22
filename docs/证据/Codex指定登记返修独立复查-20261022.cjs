'use strict';
// 2c46eaf 独立复查；仅合成内存数据。不得运行录入、ACL修改、真实子进程或网络。
// ok 表示下述对照/反例如实复现，不表示产品通过。--out 只允许 wx 新建。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const helper = require(path.join(root, 'miniapp/tests/helpers/pic-guard-runner.cjs'));
const hits = []; let phase = 'setup';
helper.installParentGuards({ hits, getPhase: () => phase, allowedScripts: [] });
phase = 'probe';
for (const f of [() => require('https').request('https://example.invalid'), () => require('child_process').spawn('blocked', [])]) { try { f(); } catch (_) {} }
phase = 'business';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const src = rel => fs.readFileSync(path.join(root, rel), 'utf8');
function load(rel, overrides = {}, inject = {}, text = src(rel), main = false) {
  const filename = path.join(root, rel), module = { exports: {} };
  const native = require('node:module').createRequire(filename);
  const req = id => Object.hasOwn(overrides, id) ? overrides[id] : native(id);
  req.main = main ? module : null;
  vm.runInNewContext(text, { module, exports: module.exports, require: req, __dirname: path.dirname(filename),
    __filename: filename, Buffer, console, process, ...inject }, { filename });
  return module.exports;
}
const cr = 'miniapp/scripts/lib/participant-self-registration.cjs';
const sr = 'miniapp/scripts/lib/participant-private-store.cjs';
const pr = 'miniapp/scripts/package-participant-self-registration.cjs';
const er = 'miniapp/scripts/templates/participant-self-registration/server/scheduleSandbox/index.js';
const core = require(path.join(root, cr));
const app = 'wxfb4db1615ac15531', env = 'cloud1-d8gcq5ag39d847723';
const openid = 'synthetic-codex-rereview', uid = core.deriveUserId(app, openid);
const aid = core.deriveRegistrationAuditId(app, env, uid);
const round = 'synthetic-codex-rereview-round', pass = 'synthetic-codex-rereview-pass';
const config = { registrationRoundId: round, passphraseDigest: sha(pass), allowedAccount: uid,
  windowStartsAtMs: 1000, windowExpiresAtMs: 10000, usersCollection: 'schtest_v1_users',
  auditCollection: 'schtest_v1_audit_events', sourceProtocol: core.SELF_REG_SCHEMA, synthetic: false };
const request = { action: 'registerSelf', registrationRoundId: round, passphrase: pass };
const user = () => ({ _id: uid, openid, status: 'active', createdAt: '1970-01-01T00:00:02.000Z', updatedAt: '1970-01-01T00:00:02.000Z' });
const audit = () => ({ _id: aid, projectId: null, actorUserId: uid, actorRole: '本人普通账号', action: 'registerIdentity',
  subjectUserId: uid, before: null, after: { status: 'active' }, createdAt: '1970-01-01T00:00:02.000Z',
  sourceProtocol: core.SELF_REG_SCHEMA, registrationRoundId: 'synthetic-prior-round' });
async function run(opts = {}) {
  const docs = new Map(); if (opts.user) docs.set(uid, opts.user); if (opts.audit) docs.set(aid, opts.audit);
  const calls = { factory: 0, collections: [], transactions: 0, creates: 0, projections: [] };
  let t = opts.now === undefined ? 2000 : opts.now;
  const col = (name, tx) => ({ doc(id) { let projection; return {
    field(p) { projection = p; calls.projections.push(Object.keys(p)); return this; },
    async get() {
      if (!tx && opts.expireOnRead) t = 10000;
      if (tx && opts.malformedMissing) return {};
      let d = docs.get(id) || null;
      if (!tx && id === uid && opts.dropReadTimes && d) { d = { ...d }; delete d.createdAt; delete d.updatedAt; }
      if (projection && d) d = Object.fromEntries(Object.keys(projection).filter(k => Object.hasOwn(d, k)).map(k => [k, d[k]]));
      return { data: d };
    }
  }; }, async add({ data }) { calls.creates++; docs.set(data._id, data); } });
  const db = { collection(name) { calls.collections.push(name); return col(name, false); },
    async runTransaction(cb) { calls.transactions++; return cb({ collection(name) { calls.collections.push(name); return col(name, true); } }); } };
  const checker = core.createSelfRegistrationChecker({ dbFactory() { calls.factory++; return db; },
    trusted: { appId: app, envId: env, OPENID: openid }, config: { ...config, ...opts.config }, now: () => t });
  const result = await checker.handle({ ...request, ...opts.request });
  return { result, calls };
}
const cases = [];
async function check(name, f) { cases.push({ name, ...await f() }); }
function injectedEntry() {
  let s = src(er);
  const values = { CONFIG_ENABLED: true, CONFIG_APP_ID: app, CONFIG_ENV_ID: env, CONFIG_REGISTRATION_ROUND_ID: round,
    CONFIG_PASSPHRASE_DIGEST: sha(pass), CONFIG_ALLOWED_ACCOUNT: uid, CONFIG_WINDOW_STARTS_AT_MS: 1000, CONFIG_WINDOW_EXPIRES_AT_MS: 10000 };
  for (const [k,v] of Object.entries(values)) s = s.replace(new RegExp('const ' + k + ' = [^;]*;'), 'const ' + k + ' = ' + JSON.stringify(v) + ';');
  return s;
}
async function sdkCase() {
  const base = path.join(process.env.USERPROFILE, '.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules');
  const nodeSdk = require(path.join(base, '@cloudbase/node-sdk'));
  const dbModule = require(path.join(base, '@cloudbase/database'));
  const ejson = require(path.join(base, '@cloudbase/database/dist/commonjs/utils/utils.js'));
  const originalInit = nodeSdk.init, originalReq = dbModule.Db.reqClass;
  let sends = [], docs = new Map();
  class Transport {
    async send(action, p = {}) {
      sends.push({ action, transactionId: p.transactionId || null, collection: p.collectionName || null });
      if (action === 'database.startTransaction') return { transactionId: 'synthetic-tx' };
      if (action === 'database.commitTransaction' || action === 'database.abortTransaction') return {};
      if (action === 'database.getDocument') {
        const id = ejson.parseByEJSON(p.query)._id, d = docs.get(id);
        assert.ok([uid, aid].includes(id));
        return { data: { list: d ? [ejson.stringifyByEJSON(d)] : [], offset: 0, limit: 1 } };
      }
      if (action === 'database.insertDocument') {
        assert.equal(p.transactionId, 'synthetic-tx');
        const d = ejson.parseByEJSON(p.data[0]); docs.set(d._id, d);
        return { data: { insertedIds: [d._id] } };
      }
      throw Error('unexpected SDK operation');
    }
  }
  nodeSdk.init = () => ({ logger: () => {}, database: () => new dbModule.Db({ env }) });
  dbModule.Db.reqClass = Transport;
  const cloud = require(path.join(base, 'wx-server-sdk'));
  const savedContext = cloud.getWXContext;
  cloud.getWXContext = () => ({ APPID: app, OPENID: openid });
  const adapter = require(path.join(root, 'miniapp/scripts/templates/participant-self-registration/server/request-adapter.js'));
  const loadEntry = s => load(er, { 'wx-server-sdk': cloud, './request-adapter': adapter, './participant-self-registration': core }, { Date: { now: () => 2000 } }, s);
  const event = { picRequest: { schema: core.REQUEST_PROTOCOL, ...request } };
  try {
    const entryText = injectedEntry();
    const failed = await loadEntry(entryText).main(event);
    assert.equal(failed.code, 'PIC_TRANSACTION_FAILED'); assert.equal(failed.writeAttempted, false);
    const missing = { result: failed, actions: sends.map(s => s.action) };
    assert.deepEqual(missing.actions, ['database.startTransaction', 'database.getDocument', 'database.abortTransaction']);
    sends = []; docs = new Map();
    const changed = entryText.replace('() => cloud.database()', '() => cloud.database({throwOnNotFound:false})');
    assert.notEqual(changed, entryText);
    const positive = await loadEntry(changed).main(event);
    assert.equal(positive.outcome, 'CREATED_AND_VERIFIED');
    assert.equal(sends.filter(s => s.action === 'database.insertDocument').length, 2);
    return { missing, memoryFlagControl: { result: positive, actions: sends.map(s => s.action) },
      sdkSha256: sha(fs.readFileSync(path.join(base, 'wx-server-sdk/index.js'))),
      scope: 'Entry constants injected in memory, actual adapter/core and real wx SDK/database/transaction/EJSON. Synthetic getWXContext, node-sdk init factory and transport only. No platform commit/concurrency claim.' };
  } finally { cloud.getWXContext = savedContext; nodeSdk.init = originalInit; dbModule.Db.reqClass = originalReq; }
}
async function main() {
  await check('R1_positiveAndClosedBoundaries', async () => {
    const good = await run(); assert.equal(good.result.outcome, 'CREATED_AND_VERIFIED');
    const early = await run({ now: 500 }); assert.equal(early.calls.factory, 0); assert.equal(early.result.code, 'PIC_WINDOW_NOT_OPEN');
    const wrong = await run({ request: { passphrase: 'synthetic-wrong' } }); assert.equal(wrong.calls.factory, 0);
    const late = await run({ expireOnRead: true }); assert.equal(late.result.outcome, 'OUTCOME_UNKNOWN'); assert.equal(late.result.commitConfirmed, true);
    return { positive: good, early, wrong, late };
  });
  await check('R2_realSdkMissingRecordFails', sdkCase);
  await check('R1_invalidWindowAndCollectionStillAccepted', async () => {
    const x = await run({ config: { windowStartsAtMs: NaN, windowExpiresAtMs: NaN, usersCollection: 'synthetic-unapproved-users' } });
    assert.equal(x.result.outcome, 'CREATED_AND_VERIFIED'); assert.ok(x.calls.collections.includes('synthetic-unapproved-users'));
    return { ...x, scope: 'Core injected config defense; approved packer currently constrains these fields' };
  });
  await check('R3_invalidAuditContentAccepted', async () => {
    const x = await run({ user: user(), audit: { ...audit(), actorRole: 'synthetic-admin', after: { status: 'disabled' }, createdAt: 'not-a-time' } });
    assert.equal(x.result.outcome, 'ALREADY_ACTIVE'); return x;
  });
  await check('R3_missingReadbackTimeAccepted', async () => {
    const x = await run({ user: user(), audit: audit(), dropReadTimes: true });
    assert.equal(x.result.outcome, 'ALREADY_ACTIVE'); assert.equal(x.result.readBack.user, true); return x;
  });
  await check('R3_malformedMissingSnapshotCreates', async () => {
    const x = await run({ malformedMissing: true }); assert.equal(x.calls.creates, 2); assert.equal(x.result.outcome, 'CREATED_AND_VERIFIED'); return x;
  });
  await check('R4_cliDropsSourceDigest', async () => {
    const callbacks = {}, errors = [], fsCalls = [];
    const fakeFs = { lstatSync(p) { fsCalls.push(p); return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }; } };
    const fakeCp = { spawnSync(cmd, args) {
      if (cmd === 'git') return { status: 0, stdout: args[0] === 'check-ignore' ? 'ignored' : '' };
      if (cmd === 'icacls') return { status: 0, stdout: 'NT AUTHORITY\\SYSTEM:(F)' };
      return { status: 0, stdout: '' };
    } };
    // Only substitute target validation filesystem/processes; actual CLI argument plumbing is executed.
    fakeFs.lstatSync = p => { fsCalls.push(p); if (String(p).endsWith('.bin')) throw Error('missing'); return { isSymbolicLink: () => false, isDirectory: () => true }; };
    fakeFs.readdirSync = () => [{ name: 'synthetic.txt', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }];
    fakeFs.readFileSync = () => Buffer.from('synthetic-close');
    const store = load(sr, { 'node:fs': fakeFs, 'node:child_process': fakeCp });
    const digest = store.computeCloseSourceDigest('synthetic-close');
    const argv = ['node', 'store', 'protect', '--repo-root', root, '--participant-code', '1', '--round-id', round,
      '--source-digest', digest, '--close-source-dir', 'synthetic-close', '--delivery-confirmed', 'true',
      '--window-starts-at-iso', '2030-01-01T00:00:00Z', '--window-expires-at-iso', '2030-01-01T00:10:00Z', '--file-name', 'synthetic.bin'];
    const proc = { argv, stdin: { setEncoding() {}, on(k, fn) { callbacks[k] = fn; } } };
    load(sr, { 'node:fs': fakeFs, 'node:child_process': fakeCp }, { process: proc, console: { log() {}, error(s) { errors.push(s); } } }, src(sr), true);
    callbacks.data(uid + '\n'); callbacks.end();
    assert.equal(proc.exitCode, 1); assert.ok(errors[0].includes('PSR_PRIVATE_SOURCE'));
    return { code: errors[0], suppliedDigestValid: true, exitCode: proc.exitCode, scope: 'Exact CLI in VM, synthetic fs/process substitutes; no DPAPI/private write' };
  });
  await check('R4_sourceGroupingSkipsOtherParticipant', async () => {
    const plan = { schema: 'participant-self-registration-plan/1', synthetic: false, registrationRoundId: round, participantCode: '1',
      appId: app, envId: env, functionName: 'scheduleSandbox', usersCollection: config.usersCollection, auditCollection: config.auditCollection,
      passphraseDigest: sha(pass), windowStartsAtIso: '2030-01-01T00:00:00Z', windowExpiresAtIso: '2030-01-01T00:10:00Z',
      closeSourceDir: path.join(root, 'artifacts/synthetic-not-created'), requestProtocol: core.REQUEST_PROTOCOL,
      privateSource: { schema: 'participant-self-registration-private-source/1', recordFile: 'synthetic.bin' } };
    const p = { participantCode: '1', fullAccount: uid, appId: app, envId: env, roundId: round,
      windowStartsAtIso: plan.windowStartsAtIso, windowExpiresAtIso: plan.windowExpiresAtIso, sourceDigest: 'a'.repeat(64), deliveryConfirmed: true };
    const records = [{ fileName: 'synthetic.bin', payload: p }, { fileName: 'synthetic-other.bin', payload: { ...p, participantCode: '2', sourceDigest: 'b'.repeat(64) } }];
    const fakeStore = { readAllRecordsAsync: async () => records, computeCloseSourceDigest: () => p.sourceDigest };
    const fakeFs = new Proxy(fs, { get(o,k) { return k === 'readFileSync' ? (file,...args) => String(file).endsWith('synthetic-plan.json') ? JSON.stringify(plan) : fs.readFileSync(file,...args) : o[k]; } });
    const packer = load(pr, { 'node:fs': fakeFs, './lib/participant-private-store.cjs': fakeStore });
    const result = await packer.consumePrivateSource('synthetic-plan.json');
    assert.equal(result.account, uid);
    return { duplicatedAccountAcceptedAcrossSourceGroups: true, missingSourceTimeAccepted: true, sourceIsCloseDigestNotIdentityEvidence: true };
  });
  await check('R4_aclAllowsBroadTokenGroupAndIgnoresMalformedAce', async () => {
    const fakeCp = { spawnSync(cmd,args) { return { status: 0, stdout: args[0] === '/user'
      ? '"synthetic\\user","S-1-5-21-1-2-3-1001"' : '"Everyone","S-1-1-0"' }; } };
    const store = load(sr, { 'node:child_process': fakeCp });
    const principals = store.getCurrentPrincipals();
    const broad = store.findBroadAclGrants('S-1-1-0:(F)', principals);
    const unparsed = store.findBroadAclGrants('synthetic\\other:(R,W)', principals);
    assert.equal(broad.length, 0); assert.equal(unparsed.length, 0);
    return { tokenGroupEveryoneAllowed: true, unparsedAceSilentlyAccepted: true, actualAclChanged: false };
  });
  await check('R6_publicSpawnAllowsOptionsAndAclMutation', async () => {
    const calls = [], caught = [];
    const cp = { spawnSync(cmd,args,opts) { calls.push({ cmd,args,opts }); return { status: 0 }; }, spawn() {} };
    const shared = { installParentGuards() { cp.spawnSync = () => { throw Error('blocked'); }; return {}; } };
    const guard = load('miniapp/tests/helpers/psr-guard-runner.cjs', { 'node:child_process': cp, './pic-guard-runner.cjs': shared });
    const g = guard.installParentGuardsWithLocalTools({ hits: caught, getPhase: () => 'business', allowedScripts: [], allowedScriptHashes: ['a'.repeat(64)] });
    cp.spawnSync('git', ['ls-files', '--', 'synthetic; invalid-command'], { shell: true, env: { SYNTHETIC: 'unapproved' } });
    cp.spawnSync('icacls', ['C:/synthetic-outside', '/inheritance:r', '/grant:r', 'Everyone:F', '/grant:r', 'SYSTEM:F'], {});
    g.restore(); cp.spawnSync('git', ['ls-files'], {});
    assert.equal(calls.length, 3); assert.equal(caught.length, 0);
    return { publicNativeSpyCalls: calls.length, unexpectedRecorded: caught.length, shellOptionPassed: calls[0].opts.shell,
      aclMutationPassed: true, restoreStillAllowsPublicSpawnSync: true, realProcessesStarted: 0 };
  });
  const probes = hits.filter(h => h.phase === 'probe').length;
  const unexpected = hits.filter(h => h.phase !== 'probe');
  const verdict = helper.verdictFor({ probes, parentUnexpected: unexpected.length, childUnexpectedTotal: 0, receiptFailures: 0 });
  assert.equal(verdict.ok, true);
  const report = { schema: 'codex-self-registration-rereview/1', reviewedCommit: '2c46eaf', basis: 'b639d7c',
    ok: verdict.ok, meaning: 'Counterexamples and controls reproduced; NOT product acceptance', cases: cases.length, results: cases,
    guard: { probes, unexpected, realProcessesStartedByEvidence: 0 }, runtimeDigests: { core: sha(src(cr)), packer: sha(src(pr)), store: sha(src(sr)) },
    limitations: ['Synthetic filesystem/ACL/process tests do not change OS permissions or read private records', 'SDK transport and context synthetic; no platform writes, retries or concurrency verified', 'No real number input, credentials or cloud activity'] };
  const argv = process.argv.slice(2);
  if (argv.length) { assert.equal(argv.length, 2); assert.equal(argv[0], '--out'); fs.writeFileSync(path.resolve(argv[1]), JSON.stringify(report,null,2)+'\n', { flag: 'wx' }); }
  console.log(JSON.stringify(argv.length ? { ok: report.ok, cases: report.cases, guard: report.guard } : report,null,2));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
