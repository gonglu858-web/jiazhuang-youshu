// I1 请求分层 R1 原型真实性终局证据（合成反例，非平台验证）。
// 依据：docs/Codex复查-I1分层R1R2返修-20261017.md §3–§4（referencePlainRecord 参考谓词）。
// stdout 默认；--out wx 独占新建。守卫计数（探针/业务期意外/总数）写入 JSON 并决定 ok/退出码。
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = 'C:/Users/30591/Documents/ChatGPT/装修进度验收APP';
process.chdir(root);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx !== -1 ? path.resolve(process.argv[outIdx + 1] || '') : null;
const guardHits = [], restore = [];
function guard(obj, k) { const old = obj[k]; if (typeof old !== 'function') return; obj[k] = (...a) => { guardHits.push(k); throw Error('OFFLINE_GUARD'); }; restore.push(() => { obj[k] = old; }); }
for (const m of ['node:http', 'node:https']) for (const k of ['get', 'request']) guard(require(m), k);
for (const k of ['connect', 'createConnection']) guard(require('node:net'), k);
guard(require('node:tls'), 'connect'); guard(globalThis, 'fetch');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) { guard(require('node:dns'), k); guard(require('node:dns').promises, k); }
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) guard(require('node:child_process'), k);
const core = require(root + '/miniapp/scripts/lib/participant-identity-check.cjs');
const packer = require(root + '/miniapp/scripts/package-participant-identity-check.cjs');
const business = require(root + '/miniapp/scripts/package-business-test.cjs');
const requestAdapter = require(root + '/miniapp/scripts/templates/participant-identity-check/server/request-adapter.js');
const TEST_ROUND = 'synthetic-r1final-round-' + crypto.randomBytes(3).toString('hex');
const PASSPHRASE = 'synthetic-r1final-passphrase-' + crypto.randomBytes(6).toString('hex');
const DIGEST = sha(PASSPHRASE);
const openid = 'synthetic-r1final-openid';
const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);

// 复查参考谓词（CodexI1原型形状伪造复查-20261017.cjs）——仅用于与产品实现一致性对照。
function referencePlainRecord(v) {
  try {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    if (p === null || p === Object.prototype) return true;
    if (Object.getPrototypeOf(p) !== null) return false;
    const c = Object.getOwnPropertyDescriptor(p, 'constructor');
    if (!c || !Object.prototype.hasOwnProperty.call(c, 'value') || typeof c.value !== 'function' || c.enumerable !== false) return false;
    if (Function.prototype.toString.call(c.value) !== Function.prototype.toString.call(Object)) return false;
    const q = Object.getOwnPropertyDescriptor(c.value, 'prototype');
    return !!q && Object.prototype.hasOwnProperty.call(q, 'value') && q.value === p && q.writable === false && q.configurable === false;
  } catch (_) { return false; }
}

async function main() {
  const probeStart = guardHits.length;
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  const sensitivityAttempts = guardHits.length - probeStart;
  const businessStart = guardHits.length;
  const closeSource = (() => {
    const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'r1final-src-' + crypto.randomBytes(5).toString('hex'));
    fs.mkdirSync(scratch, { recursive: true });
    const planPath = path.join(scratch, 'plan.json');
    const round = 'synthetic-r1final-close-src';
    fs.writeFileSync(planPath, JSON.stringify({ schema: 'business-test-plan/1', window: 'P', synthetic: true, businessRoundId: round, windowNo: 'P-01',
      appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
      users: Object.fromEntries(['owner', 'manager', 'worker'].map(k => [k, { userId: 'u_' + sha(k).slice(0, 40), source: 'synthetic' }])),
      projectReadyMarker: 'ready-' + round, windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z' }, null, 2));
    return business.build('P', planPath, path.join(scratch, 'close-source')).outDir;
  })();

  // ── 三类伪造构建（复查 §3.1–§3.3）────────────────────────────────────────
  const fakeMethodCalls = { n: 0 };
  let inheritedGetterReads = 0;
  const mkForgedRoot = (kind) => {
    const root = Object.create(null);
    for (const key of ['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf', 'constructor']) {
      Object.defineProperty(root, key, { enumerable: false, writable: true, configurable: true, value: function syntheticFake() { fakeMethodCalls.n++; } });
    }
    root.role = 'synthetic-inherited-role';
    Object.defineProperty(root, 'syntheticInheritedGetter', { enumerable: true, get() { inheritedGetterReads++; throw Error('synthetic-inherited-getter'); } });
    if (kind === 'selfBound') Object.getOwnPropertyDescriptor(root, 'constructor').value.prototype = root;
    return root;
  };
  const forgedRoots = {
    fakeMethods: mkForgedRoot('fakeMethods'),
    copiedDescriptors: Object.create(null, Object.getOwnPropertyDescriptors(Object.prototype)),
    selfBound: mkForgedRoot('selfBound')
  };
  const valid = { schema: 'participant-identity-request/1', action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE };

  // ── 单元矩阵：六伪造拒绝 + 三正向接受 + 与参考谓词一致 + 方法/getter 零调用 ──
  const unit = { forgeries: {}, positives: {}, referenceAgreement: {} };
  const unitCases = {
    outerFakeMethods: { event: Object.assign(Object.create(forgedRoots.fakeMethods), { picRequest: valid }), target: e => e },
    innerFakeMethods: { event: { picRequest: Object.assign(Object.create(forgedRoots.fakeMethods), valid) }, target: e => e.picRequest },
    outerCopiedDescriptors: { event: Object.assign(Object.create(forgedRoots.copiedDescriptors), { picRequest: valid }), target: e => e },
    innerCopiedDescriptors: { event: { picRequest: Object.assign(Object.create(forgedRoots.copiedDescriptors), valid) }, target: e => e.picRequest },
    outerSelfBound: { event: Object.assign(Object.create(forgedRoots.selfBound), { picRequest: valid }), target: e => e },
    innerSelfBound: { event: { picRequest: Object.assign(Object.create(forgedRoots.selfBound), valid) }, target: e => e.picRequest }
  };
  for (const [name, spec] of Object.entries(unitCases)) {
    const r = requestAdapter.extractBusinessRequest(spec.event);
    const checked = spec.target(spec.event);
    unit.forgeries[name] = { rejected: r.ok === false, referenceAgrees: referencePlainRecord(checked) === false };
    assert.equal(r.ok, false, name + ' 必须拒绝');
    assert.equal(referencePlainRecord(checked), false, name + ' 参考谓词一致拒绝');
  }
  const positiveInputs = {
    plain: { event: { picRequest: valid }, target: e => e },
    nullPrototype: { event: Object.assign(Object.create(null), { picRequest: Object.assign(Object.create(null), valid) }), target: e => e },
    crossRealmPlain: { event: vm.runInNewContext('({ picRequest: { schema: "participant-identity-request/1", action: "inspectSelf", checkRoundId: "' + TEST_ROUND + '", passphrase: "' + PASSPHRASE + '" } })'), target: e => e }
  };
  for (const [name, spec] of Object.entries(positiveInputs)) {
    const r = requestAdapter.extractBusinessRequest(spec.event);
    const checked = spec.target(spec.event);
    unit.positives[name] = { accepted: r.ok === true, referenceAgrees: referencePlainRecord(checked) === true };
    assert.equal(r.ok, true, name + ' 必须接受');
    assert.equal(referencePlainRecord(checked), true, name + ' 参考谓词一致接受');
  }
  unit.fakeMethodCalls = fakeMethodCalls.n;
  unit.inheritedGetterReads = inheritedGetterReads;
  assert.equal(fakeMethodCalls.n, 0, '伪造方法零调用');
  assert.equal(inheritedGetterReads, 0, '继承 getter 零读取');

  // ── 生成链：六伪造 × 外/内层 → PIC_REQUEST_INVALID/UNKNOWN/false 且零工厂/零集合/零 get ──
  const outDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-r1final-' + crypto.randomBytes(4).toString('hex'));
  const starts = Date.now() - 60000;
  const planPath = path.join(path.dirname(outDir), 'r1final-plan-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(planPath, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: TEST_ROUND, participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: DIGEST, windowStartsAtIso: new Date(starts).toISOString(), windowExpiresAtIso: new Date(starts + 600000).toISOString(),
    closeSourceDir: closeSource, requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  packer.build(planPath, outDir);
  assert.equal(packer.checkDir(outDir).ok, true);
  const serverFile = path.join(outDir, 'server', 'scheduleSandbox', 'index.js');
  const mkChain = mutate => {
    const counters = { factory: 0, collections: [], gets: 0 };
    const db = {
      collection(name) { counters.collections.push(name); if (name !== core.FIXED_TARGET.collection) throw Error('TRAP 集合'); return { doc(id) { if (id !== userId) throw Error('TRAP 主键'); return { async get() { counters.gets++; throw Error('unprojected get'); }, field(f) { return { async get() { counters.gets++; return { data: { _id: userId, openid, status: 'active' } }; } }; } }; } }; }
    };
    let main;
    const wx = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction: async opts => {
      const event = Object.assign({}, opts.data);
      const replaced = mutate ? mutate(event) : undefined;
      return { result: await main(replaced === undefined ? event : replaced) };
    } } };
    vm.runInNewContext(fs.readFileSync(serverFile, 'utf8'), {
      require: name => (name === 'wx-server-sdk'
        ? { DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: openid }), database: () => { counters.factory++; return db; } }
        : name === './participant-identity-check' ? core : name === './request-adapter' ? requestAdapter : (() => { throw Error('unexpected ' + name); })()),
      module: main = { exports: {} }, exports: main.exports, process: { env: { TCB_ENV: core.FIXED_TARGET.envId } }, console
    });
    main = main.exports.main;
    return { wx, counters };
  };
  const chain = { forgeries: {}, positives: {} };
  const chainCases = {
    outerFakeMethods: () => Object.assign(Object.create(forgedRoots.fakeMethods), { picRequest: valid }),
    innerFakeMethods: e => { e.picRequest = Object.assign(Object.create(forgedRoots.fakeMethods), valid); },
    outerCopiedDescriptors: () => Object.assign(Object.create(forgedRoots.copiedDescriptors), { picRequest: valid }),
    innerCopiedDescriptors: e => { e.picRequest = Object.assign(Object.create(forgedRoots.copiedDescriptors), valid); },
    outerSelfBound: () => Object.assign(Object.create(forgedRoots.selfBound), { picRequest: valid }),
    innerSelfBound: e => { e.picRequest = Object.assign(Object.create(forgedRoots.selfBound), valid); }
  };
  for (const [name, mutate] of Object.entries(chainCases)) {
    const c = mkChain(mutate);
    const r = (await c.wx.cloud.callFunction({ data: { picRequest: valid } })).result;
    chain.forgeries[name] = { code: r.code, state: r.registrationState, readAttempted: r.readAttempted, factory: c.counters.factory, collections: c.counters.collections.length, gets: c.counters.gets };
    assert.equal(r.code, 'PIC_REQUEST_INVALID', name); assert.equal(r.registrationState, 'UNKNOWN', name); assert.equal(r.readAttempted, false, name);
    assert.equal(c.counters.factory, 0, name + ' 零工厂'); assert.equal(c.counters.collections.length, 0, name + ' 零集合'); assert.equal(c.counters.gets, 0, name + ' 零 get');
  }
  // 正向对照：容忍外层附带键（含继承 getter 实测零读取）→ ACTIVE
  const pos = mkChain(e => {
    e.userInfo = { appId: 'synthetic-envelope-appid', openId: 'synthetic-envelope-openid' };
    Object.defineProperty(e, 'toleratedGetterKey', { enumerable: true, get() { inheritedGetterReads++; return 'synthetic'; } });
  });
  const posResult = (await pos.wx.cloud.callFunction({ data: { picRequest: valid } })).result;
  chain.positives = { state: posResult.registrationState, factory: pos.counters.factory, gets: pos.counters.gets, toleratedGetterReads: inheritedGetterReads };
  assert.equal(chain.positives.state, 'ACTIVE'); assert.equal(chain.positives.factory, 1); assert.equal(chain.positives.gets, 1);
  assert.equal(chain.positives.toleratedGetterReads, 0, '容忍外层键值/getter 零读取（实测）');

  // ── v2 绑定反例（写前拒绝）────────────────────────────────────────────────
  const tamperPlan = patch => {
    const planObj = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete planObj[k]; else planObj[k] = v; }
    const p2 = path.join(path.dirname(planPath), 'tamper-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(p2, JSON.stringify(planObj, null, 2));
    try { packer.build(p2, path.join(path.dirname(outDir), 'participant-identity-tamper-' + crypto.randomBytes(3).toString('hex'))); return true; } catch (e) { return false; }
  };
  const binding = { keyDiagnosticTrueRejected: tamperPlan({ keyDiagnostic: true }) === false, requestProtocolMissingRejected: tamperPlan({ requestProtocol: undefined }) === false };
  assert.equal(binding.keyDiagnosticTrueRejected, true); assert.equal(binding.requestProtocolMissingRejected, true);

  const businessPhaseGuardAttempts = guardHits.length - businessStart;
  const guardCounters = { sensitivityAttempts, businessPhaseGuardAttempts, total: guardHits.length };
  const ok = businessPhaseGuardAttempts === 0;
  const result = {
    schema: 'codebuddy-i1-layering-r1final-evidence/1',
    observedAt: new Date().toISOString(),
    basisCommit: 'f7cb27f',
    verificationKind: 'offline fix-proof evidence for R1 final (prototype authenticity via trusted Object constructor / immutable prototype correspondence); synthetic counterexamples, not platform verification',
    ok,
    guardCounters,
    sections: { unit, chain, binding },
    runtimeDigests: {
      requestAdapterSha256: sha(fs.readFileSync(root + '/miniapp/scripts/templates/participant-identity-check/server/request-adapter.js')),
      coreSha256Unchanged: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-identity-check.cjs')),
      packerSha256: sha(fs.readFileSync(root + '/miniapp/scripts/package-participant-identity-check.cjs'))
    },
    cloudOperations: 0,
    limitations: [
      'Synthetic prototypes/events and local transport stubs; not platform verification.',
      'Does not claim to identify arbitrary lying Proxies or resist tampered runtime builtins (per review §3).'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[R1终局证据摘要] ok=' + ok + ' 单元伪造拒绝=6/正向=3/与参考谓词一致 链伪造=6零工厂零get 正向ACTIVE getter实测=0 绑定=2 探针=' + sensitivityAttempts + ' 业务期意外=' + businessPhaseGuardAttempts + '/总=' + guardCounters.total + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  if (!ok) process.exitCode = 1;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
