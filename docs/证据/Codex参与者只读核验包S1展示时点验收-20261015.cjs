'use strict';
// Codex 独立本地验收：沿用上轮发现 C1 的生成链夹具，直接断言取消勾选当下的新行为。
// 只使用合成微信上下文、口令、数据库；不调用真实 SDK 或平台。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const guardHits = [];
const restore = [];
function guard(mod, name) {
  if (typeof mod[name] !== 'function') return;
  const old = mod[name];
  mod[name] = function () { guardHits.push(name); throw new Error('CODEX_OFFLINE_GUARD'); };
  restore.push(() => { mod[name] = old; });
}
for (const id of ['node:http', 'node:https']) {
  const mod = require(id);
  for (const name of ['request', 'get']) guard(mod, name);
}
for (const name of ['connect', 'createConnection']) guard(require('node:net'), name);
guard(require('node:net').Socket.prototype, 'connect');
guard(require('node:tls'), 'connect');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), name);
  guard(require('node:dns').promises, name);
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  guard(require('node:child_process'), name);
}
guard(globalThis, 'fetch');
const ROOT = path.resolve(__dirname, '../..');
const packer = require(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'));
const business = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const core = require(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const run = crypto.randomUUID();
const work = path.join(ROOT, 'artifacts/schedule-sandbox/business-test', 'codex-pic-s1b-' + run);
fs.mkdirSync(work, { recursive: true });
const appId = core.FIXED_TARGET.appId;
const envId = core.FIXED_TARGET.envId;
const openid = 'synthetic-codex-' + run;
const userId = core.deriveUserId(appId, openid);
const passphrase = 'synthetic-codex-pass-' + run;
const checkRoundId = 'codex-pic-' + run.slice(0, 12);
const writeJson = (name, data) => {
  const target = path.join(work, name);
  fs.writeFileSync(target, JSON.stringify(data, null, 2), { flag: 'wx' });
  return target;
};
const oldWx = globalThis.wx;
const results = [];
async function main() {
  for (const fn of [
    () => require('node:https').request('https://example.invalid'),
    () => require('node:child_process').spawn('node', [])
  ]) assert.throws(fn, /CODEX_OFFLINE_GUARD/);
  const sensitivityProbeHits = guardHits.length;
  const businessRoundId = 'synthetic-close-' + run.slice(0, 12);
  const users = Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
    userId: 'u_' + sha(appId + ':synthetic-' + role + run).slice(0, 40),
    source: 'synthetic fixture'
  }]));
  const closePlan = writeJson('business-plan.json', {
    schema: 'business-test-plan/1', window: 'P', synthetic: true,
    businessRoundId, windowNo: 'P-01', appId, envId, users,
    projectReadyMarker: 'ready-' + businessRoundId,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
  });
  const closeSource = business.build('P', closePlan, path.join(work, 'close-source')).outDir;
  assert.equal(business.checkCloseDir(closeSource).ok, true);
  const starts = Date.now() - 60000;
  const plan = writeJson('identity-plan.json', {
    schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId, participantCode: '1',
    appId, envId, functionName: core.FIXED_TARGET.functionName,
    collection: core.FIXED_TARGET.collection, passphraseDigest: sha(passphrase),
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 600000).toISOString(),
    closeSourceDir: closeSource, note: 'Codex synthetic review fixture'
  });
  const outDir = path.join(ROOT, 'artifacts/schedule-sandbox/business-test', 'participant-identity-codex-' + run);
  packer.build(plan, outDir);
  assert.equal(packer.checkDir(outDir).ok, true);
  const pageFile = path.join(outDir, 'frontend/pages/identity-check/identity-check.js');
  const wxml = fs.readFileSync(path.join(outDir, 'frontend/pages/identity-check/identity-check.wxml'), 'utf8');
  const templateFile = path.join(ROOT, 'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js');
  assert.deepEqual(fs.readFileSync(pageFile), fs.readFileSync(templateFile));
  const calls = { gets: 0, writes: 0, fields: [] };
  const db = {
    collection(name) {
      assert.equal(name, core.FIXED_TARGET.collection);
      return { doc(id) {
        assert.equal(id, userId);
        return {
          field(projection) {
            calls.fields.push({ ...projection });
            return this;
          },
          async get() {
            calls.gets++;
            return { data: [{ _id: userId, openid, status: 'active' }] };
          }
        };
      } };
    }
  };
  const serverFile = path.join(outDir, 'server/index.js');
  const serverModule = { exports: {} };
  const nativeServerRequire = createRequire(serverFile);
  const sdk = { DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, getWXContext: () => ({ APPID: appId, OPENID: openid }), database: () => db };
  const serverContext = vm.createContext({
    module: serverModule, exports: serverModule.exports,
    require(id) { return id === 'wx-server-sdk' ? sdk : nativeServerRequire(id); },
    process: { env: { TCB_ENV: envId } }, console
  });
  new vm.Script(fs.readFileSync(serverFile, 'utf8'), { filename: serverFile }).runInContext(serverContext);
  const requests = [];
  const wxStub = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction(opts) {
    requests.push(JSON.parse(JSON.stringify(opts.data)));
    return serverModule.exports.main(opts.data).then(result => ({ result }));
  } } };
  globalThis.wx = wxStub;
  const appFile = path.join(outDir, 'frontend/app.js');
  const appDef = {};
  new vm.Script(fs.readFileSync(appFile, 'utf8'), { filename: appFile }).runInContext(
    vm.createContext({ App(value) { Object.assign(appDef, value); }, wx: wxStub, console })
  );
  appDef.onLaunch();
  assert.equal(requests.length, 0);
  const pageDef = {};
  const pageContext = vm.createContext({ Page(value) { Object.assign(pageDef, value); }, require: createRequire(pageFile), wx: wxStub, console });
  new vm.Script(fs.readFileSync(pageFile, 'utf8'), { filename: pageFile }).runInContext(pageContext);
  const page = Object.assign({ data: {}, setData(patch) { Object.assign(this.data, patch); } }, pageDef);
  page.onLoad(); page.onShow();
  assert.equal(requests.length, 0);
  page.onWantFullIdChange({ detail: { value: ['full'] } });
  page.onPassphraseInput({ detail: { value: passphrase } });
  await page.onCheckTap();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].includeFullUserId, true);
  assert.equal(page.data.result.userId, userId);
  assert.equal(page.data.result.fullUserIdAvailable, true);
  page.onWantFullIdChange({ detail: { value: [] } });
  const afterCancel = {
    wantFullUserId: page.data.wantFullUserId,
    fullIdAvailable: page.data.result.fullUserIdAvailable,
    fullIdEmpty: page.data.result.userId === '',
    tailKept: page.data.result.userIdTail === userId.slice(-6),
    requests: requests.length,
    wxmlShowsOnResultFlagOnly: wxml.includes('wx:if="{{result.fullUserIdAvailable}}"')
  };
  assert.equal(afterCancel.wantFullUserId, false);
  assert.equal(afterCancel.requests, 1);
  assert.equal(afterCancel.fullIdAvailable, false);
  assert.equal(afterCancel.fullIdEmpty, true);
  assert.equal(afterCancel.tailKept, true);
  assert.equal(afterCancel.wxmlShowsOnResultFlagOnly, true);
  results.push({ id: 'C1_cancel_immediately_hides_prior_full_id', passed: true, actual: afterCancel });
  page.onWantFullIdChange({ detail: { value: ['full'] } });
  assert.equal(page.data.wantFullUserId, true);
  assert.equal(page.data.result.fullUserIdAvailable, false);
  assert.equal(page.data.result.userId, '');
  assert.equal(requests.length, 1);
  results.push({ id: 'C2_recheck_without_submit_stays_hidden', passed: true, actual: { requests: requests.length, fullIdAvailable: false, fullIdEmpty: true } });
  page.onWantFullIdChange({ detail: { value: [] } });
  page.onPassphraseInput({ detail: { value: passphrase } });
  await page.onCheckTap();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].includeFullUserId, undefined);
  assert.equal(page.data.result.userId, '');
  assert.equal(page.data.result.userIdTail, userId.slice(-6));
  results.push({ id: 'C3_next_submit_after_cancel', passed: true, actual: { requests: requests.length, fullIdRequested: false, fullIdShown: false, tailShown: true } });
  page.onWantFullIdChange({ detail: { value: ['full'] } });
  assert.equal(page.data.result.userId, '');
  page.onPassphraseInput({ detail: { value: passphrase } });
  await page.onCheckTap();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].includeFullUserId, true);
  assert.equal(page.data.result.userId, userId);
  assert.equal(page.data.result.fullUserIdAvailable, true);
  assert.equal(page.data.passphrase, '');
  results.push({ id: 'C4_new_success_after_recheck_restores_full_id', passed: true, actual: { requests: requests.length, newRequestIncludesFullId: true, fullIdShown: true, passphraseCleared: true } });
  const beforeLockedTap = requests.length;
  page.setData({ sending: true });
  await page.onCheckTap();
  assert.equal(requests.length, beforeLockedTap);
  assert.ok(wxml.includes('disabled="{{sending}}"'));
  page.setData({ sending: false });
  results.push({ id: 'C5_inflight_lock', passed: true, actual: { requests: requests.length, wxmlDisabledBinding: true } });
  assert.equal(calls.gets, 3);
  assert.equal(calls.writes, 0);
  assert.deepEqual(calls.fields, Array.from({ length: 3 }, () => ({ _id: true, openid: true, status: true })));

  async function checkField(kind) {
    let gets = 0;
    const handle = { get: async () => { gets++; return { data: [{ _id: userId, openid, status: 'active' }] }; } };
    if (kind === 'throws') handle.field = () => { throw new Error('synthetic projection failure'); };
    if (kind === 'noGet') handle.field = () => ({});
    const localDb = { collection: () => ({ doc: () => handle }) };
    const checker = core.createIdentityChecker({
      db: localDb, trusted: { appId, envId, openid },
      config: { checkRoundId, passphraseDigest: sha(passphrase), windowStartsAtMs: 1000, windowExpiresAtMs: 2000 },
      now: () => 1500
    });
    const result = await checker.handle({ action: 'inspectSelf', checkRoundId, passphrase, includeFullUserId: true });
    assert.equal(result.code, 'PIC_FIELD_PROJECTION_UNAVAILABLE');
    assert.equal(result.registrationState, 'UNKNOWN');
    assert.equal(result.readAttempted, false);
    assert.equal(result.userId, null);
    assert.equal(gets, 0);
    return { kind, gets, code: result.code, readAttempted: result.readAttempted };
  }
  results.push({ id: 'C6_projection_fail_closed_control', passed: true, actual: await Promise.all(['missing', 'throws', 'noGet'].map(checkField)) });
  assert.equal(guardHits.length, sensitivityProbeHits, '业务期不得尝试网络或子进程');
  return {
    schema: 'codex-participant-identity-s1b-review/1', reviewedCommit: '34b5003',
    implementationSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
    packerSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    pageTemplateSha256: sha(fs.readFileSync(templateFile)),
    verificationKind: 'actual generated App/Page/client/server/core with synthetic wx/db; no SDK or platform',
    results, guardAccounting: { sensitivityProbeHits, businessPeriodUnexpectedAttempts: guardHits.length - sensitivityProbeHits },
    summary: { checked: results.length, passed: results.every(x => x.passed === true), gap: null }
  };
}
main().then(report => {
  const body = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2] === '--out' && process.argv[3] && process.argv.length === 4) {
    fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
    process.stdout.write('Codex evidence written\n');
  } else if (process.argv.length === 2) {
    process.stdout.write(body);
  } else {
    throw new Error('usage: node evidence.cjs [--out <new-path>]');
  }
}).catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
}).finally(() => {
  if (oldWx === undefined) delete globalThis.wx; else globalThis.wx = oldWx;
  for (const fn of restore.reverse()) fn();
});
