// I1 请求分层兼容定点返修 R1/R2 证据（合成反例，非平台验证）。
// 依据：docs/Codex复查-I1请求分层兼容实现-20261017.md §3–§4。stdout 默认；--out wx 独占新建。
// 守卫计数（探针/业务期意外/总数）写入 JSON 并以同一实际计数决定 ok/退出码；被 catch 意外也记账。
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { execSync } = require('child_process');
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
const SDK_PATH = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/wx-server-sdk';
const TEST_ROUND = 'synthetic-rfix-round-' + crypto.randomBytes(3).toString('hex');
const PASSPHRASE = 'synthetic-rfix-passphrase-' + crypto.randomBytes(6).toString('hex');
const DIGEST = sha(PASSPHRASE);
const makeCloseSource = () => {
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'rfix2-src-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan.json');
  const round = 'synthetic-rfix2-close-src';
  fs.writeFileSync(planPath, JSON.stringify({ schema: 'business-test-plan/1', window: 'P', synthetic: true, businessRoundId: round, windowNo: 'P-01',
    appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(k => [k, { userId: 'u_' + sha(k).slice(0, 40), source: 'synthetic' }])),
    projectReadyMarker: 'ready-' + round, windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z' }, null, 2));
  return business.build('P', planPath, path.join(scratch, 'close-source')).outDir;
};

async function main() {
  const probeStart = guardHits.length;
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  const sensitivityAttempts = guardHits.length - probeStart;
  const businessStart = guardHits.length;

  // ── R2 核验：两份历史脚本磁盘字节 === 347261a blob（逐字节比对）────────────
  const r2Restored = {};
  for (const rel of ['docs/证据/CodeBuddyI1入站事件封装离线核实-20261016.cjs', 'docs/证据/CodeBuddy受控诊断R1R4收尾-20261016.cjs']) {
    const blob = execSync('git -C "' + root + '" cat-file blob 347261a:"' + rel + '"', { maxBuffer: 1e8 });
    const disk = fs.readFileSync(path.join(root, rel));
    r2Restored[rel] = { byteEqual: disk.equals(blob), size: disk.length };
    assert.equal(r2Restored[rel].byteEqual, true, rel + ' 必须与 347261a blob 逐字节一致');
  }

  // ── R1 单元：严格原型判定；自定义 null-root（外/内层）拒绝 + 继承 getter 实测零读取 ──
  const valid = { schema: 'participant-identity-request/1', action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE };
  const r1Unit = {};
  r1Unit.plainAccepted = requestAdapter.extractBusinessRequest({ picRequest: valid }).ok === true;
  r1Unit.nullProtoAccepted = requestAdapter.extractBusinessRequest(Object.assign(Object.create(null), { picRequest: Object.assign(Object.create(null), valid) })).ok === true;
  r1Unit.crossRealmPlainAccepted = requestAdapter.extractBusinessRequest(vm.runInNewContext('({ picRequest: { schema: "participant-identity-request/1", action: "inspectSelf", checkRoundId: "' + TEST_ROUND + '", passphrase: "' + PASSPHRASE + '" } })')).ok === true;
  let customGetterReads = 0;
  const custom = Object.create(null);
  Object.defineProperty(custom, 'role', { enumerable: true, value: 'synthetic-forged' });
  Object.defineProperty(custom, 'inheritedGetter', { enumerable: true, get() { customGetterReads++; return 'synthetic-inherited'; } });
  r1Unit.outerCustomNullRootRejected = requestAdapter.extractBusinessRequest(Object.assign(Object.create(custom), { picRequest: valid })).ok === false;
  r1Unit.innerCustomNullRootRejected = requestAdapter.extractBusinessRequest({ picRequest: Object.assign(Object.create(custom), valid) }).ok === false;
  r1Unit.inheritedGetterReads = customGetterReads;
  assert.equal(r1Unit.outerCustomNullRootRejected, true); assert.equal(r1Unit.innerCustomNullRootRejected, true);
  assert.equal(r1Unit.inheritedGetterReads, 0);
  assert.equal(r1Unit.plainAccepted && r1Unit.nullProtoAccepted && r1Unit.crossRealmPlainAccepted, true);

  // ── R1 生成链：外/内层自定义 null-root → PIC_REQUEST_INVALID/UNKNOWN/readAttempted=false 且零工厂/零集合/零 get ──
  const openid = 'synthetic-rfix2-openid';
  const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);
  const closeSource = makeCloseSource();
  const outDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-rfix2-' + crypto.randomBytes(4).toString('hex'));
  const starts = Date.now() - 60000;
  const planPath = path.join(path.dirname(outDir), 'rfix2-plan-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(planPath, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: TEST_ROUND, participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: DIGEST, windowStartsAtIso: new Date(starts).toISOString(), windowExpiresAtIso: new Date(starts + 600000).toISOString(),
    closeSourceDir: closeSource, requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  packer.build(planPath, outDir);
  assert.equal(packer.checkDir(outDir).ok, true);
  const serverFile = path.join(outDir, 'server', 'scheduleSandbox', 'index.js');
  const mkChain = mutate => {
    const counters = { factory: 0, collections: [], reads: 0 };
    const db = {
      collection(name) { counters.collections.push(name); if (name !== core.FIXED_TARGET.collection) throw Error('TRAP 集合'); return { doc(id) { if (id !== userId) throw Error('TRAP 主键'); return { async get() { counters.reads++; throw Error('unprojected get'); }, field(f) { return { async get() { counters.reads++; return { data: { _id: userId, openid, status: 'active' } }; } }; } }; } }; }
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
  const r1Chain = {};
  const chainCases = {
    outerCustomNullRoot: () => { const c = Object.create(null); c.role = 'synthetic-forged'; return Object.assign(Object.create(c), { picRequest: valid }); },
    innerCustomNullRoot: e => { const c = Object.create(null); c.role = 'synthetic-forged'; e.picRequest = Object.assign(Object.create(c), valid); }
  };
  for (const [name, mutate] of Object.entries(chainCases)) {
    const chain = mkChain(mutate);
    const r = (await chain.wx.cloud.callFunction({ data: { picRequest: valid } })).result;
    r1Chain[name] = { code: r.code, state: r.registrationState, readAttempted: r.readAttempted, factory: chain.counters.factory, collections: chain.counters.collections.length, gets: chain.counters.reads };
    assert.equal(r.code, 'PIC_REQUEST_INVALID', name); assert.equal(r.registrationState, 'UNKNOWN', name); assert.equal(r.readAttempted, false, name);
    assert.equal(chain.counters.factory, 0, name + ' 零工厂'); assert.equal(chain.counters.collections.length, 0, name + ' 零集合'); assert.equal(chain.counters.reads, 0, name + ' 零 get');
  }

  // ── 正向对照：合法 picRequest（含外层附带键容忍）→ ACTIVE；容忍链 getter 实测计数 ──
  let toleratedGetterReads = 0;
  const posChain = mkChain(e => {
    e.userInfo = { appId: 'synthetic-envelope-appid', openId: 'synthetic-envelope-openid' };
    Object.defineProperty(e, 'toleratedGetterKey', { enumerable: true, get() { toleratedGetterReads++; return 'synthetic'; } });
  });
  const pos = (await posChain.wx.cloud.callFunction({ data: { picRequest: valid } })).result;
  const positiveControl = { state: pos.registrationState, factory: posChain.counters.factory, reads: posChain.counters.reads, toleratedGetterReads };
  assert.equal(positiveControl.state, 'ACTIVE'); assert.equal(positiveControl.factory, 1); assert.equal(positiveControl.reads, 1);
  assert.equal(positiveControl.toleratedGetterReads, 0, '容忍外层键的值/getter 零读取（实测）');

  // ── §4：完整入口 no-flag 敏感性（原入口 vs 内存变体）＋ 实际主键/投影/次数 ──
  let sectionNoFlag = { available: fs.existsSync(SDK_PATH) };
  if (sectionNoFlag.available) {
    const networkAttempts = { n: 0 };
    const originals = [];
    const block = () => { networkAttempts.n++; throw Error('LOCAL_NETWORK_DISABLED'); };
    for (const [m, keys] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:net', ['connect', 'createConnection']]]) {
      const mod = require(m);
      for (const k of keys) { originals.push([mod, k, mod[k]]); mod[k] = block; }
    }
    const sock = require('node:net').Socket.prototype;
    originals.push([sock, 'connect', sock.connect]); sock.connect = block;
    try {
      const realCloud = require(SDK_PATH);
      const transportCalls = [];
      const mkEntry = variant => {
        const src0 = fs.readFileSync(serverFile, 'utf8');
        assert.ok(src0.includes('cloud.database({ throwOnNotFound: false })'));
        let src = src0;
        if (variant === 'noflag') src = src0.replace('cloud.database({ throwOnNotFound: false })', 'cloud.database({})');
        const initArgs = [], databaseArgs = [];
        let script = [];
        const shim = {
          DYNAMIC_CURRENT_ENV: realCloud.DYNAMIC_CURRENT_ENV,
          init(o) { initArgs.push(o); realCloud.init(o); },
          getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: openid }),
          database(o) { databaseArgs.push(o); const db = realCloud.database(o);
            class T { async send(action, params) { transportCalls.push({ variant, action, raw: JSON.stringify(params) }); const s = script.shift(); if (!s) throw Error('耗尽'); if (s === 'absent') return { data: { list: [], offset: 0, limit: 1 } }; throw Error('unused'); } }
            db._db.constructor.reqClass = function () { return new T(); };
            return db; }
        };
        const srv = { exports: {} };
        vm.runInNewContext(src, {
          require: name => (name === 'wx-server-sdk' ? shim : name === './participant-identity-check' ? core : name === './request-adapter' ? requestAdapter : (() => { throw Error('unexpected ' + name); })()),
          module: srv, exports: srv.exports, process: { env: { TCB_ENV: core.FIXED_TARGET.envId } }, console
        });
        return { main: srv.exports.main, initArgs, databaseArgs, setScript: s => { script = s; } };
      };
      const call = entry => entry.main({ picRequest: valid });
      const a = mkEntry('original');
      a.setScript(['absent']);
      const miss = await call(a);
      const b = mkEntry('noflag');
      b.setScript(['absent']);
      const miss2 = await call(b);
      sectionNoFlag = {
        available: true,
        originalAbsent: miss.registrationState === 'ABSENT',
        noFlagUnknown: miss2.registrationState === 'UNKNOWN',
        noFlagCode: miss2.code,
        noFlagReadAttempted: miss2.readAttempted,
        originalDatabaseArg: JSON.stringify(a.databaseArgs[0]),
        noFlagDatabaseArg: JSON.stringify(b.databaseArgs[0]),
        transports: transportCalls.map(c => ({ variant: c.variant, action: c.action, hasUserId: c.raw.includes(userId), hasProjection: c.raw.includes('_id') && c.raw.includes('openid') && c.raw.includes('status') })),
        networkAttempts: networkAttempts.n
      };
      assert.equal(sectionNoFlag.originalAbsent, true); assert.equal(sectionNoFlag.noFlagUnknown, true);
      assert.equal(sectionNoFlag.noFlagCode, 'PIC_READ_FAILED'); assert.equal(sectionNoFlag.noFlagReadAttempted, true);
      assert.equal(sectionNoFlag.networkAttempts, 0);
    } finally {
      for (const [mod, key, original] of originals) mod[key] = original;
    }
  }

  // ── v2 绑定反例 ───────────────────────────────────────────────────────────
  const tamperPlan = patch => {
    const planObj = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete planObj[k]; else planObj[k] = v; }
    const p2 = path.join(path.dirname(planPath), 'tamper-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(p2, JSON.stringify(planObj, null, 2));
    try { packer.build(p2, path.join(path.dirname(outDir), 'participant-identity-tamper-' + crypto.randomBytes(3).toString('hex'))); return true; } catch (e) { return false; }
  };
  const binding = {
    keyDiagnosticTrueRejected: tamperPlan({ keyDiagnostic: true }) === false,
    requestProtocolMissingRejected: tamperPlan({ requestProtocol: undefined }) === false,
    v1PlanSchemaRejected: tamperPlan({ schema: 'participant-identity-plan/1' }) === false
  };
  assert.equal(binding.keyDiagnosticTrueRejected, true); assert.equal(binding.requestProtocolMissingRejected, true);
  assert.equal(binding.v1PlanSchemaRejected, true);

  const businessPhaseGuardAttempts = guardHits.length - businessStart;
  const guardCounters = { sensitivityAttempts, businessPhaseGuardAttempts, total: guardHits.length };
  const ok = businessPhaseGuardAttempts === 0;
  const result = {
    schema: 'codebuddy-i1-layering-rfix-evidence/1',
    observedAt: new Date().toISOString(),
    basisCommit: 'b89be83',
    verificationKind: 'offline fix-proof evidence for R1 (strict plain-object prototype) + R2 (historical script byte restore); synthetic counterexamples, not platform verification',
    ok,
    guardCounters,
    sections: { r2Restored, r1Unit, r1Chain, positiveControl, noFlag: sectionNoFlag, binding },
    runtimeDigests: {
      requestAdapterSha256: sha(fs.readFileSync(root + '/miniapp/scripts/templates/participant-identity-check/server/request-adapter.js')),
      coreSha256Unchanged: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-identity-check.cjs')),
      packerSha256: sha(fs.readFileSync(root + '/miniapp/scripts/package-participant-identity-check.cjs'))
    },
    cloudOperations: 0,
    limitations: [
      'Synthetic prototypes/events and local transport stubs; not platform verification.',
      'Strict prototype rule accepts cross-realm plain objects only when the root structurally matches a canonical Object.prototype root (own non-enumerable canonical methods + null root-of-root).'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[返修证据摘要] ok=' + ok + ' r2.字节恢复=' + Object.values(r2Restored).every(x => x.byteEqual) + ' r1.单元拒绝=2/链拒绝=2/零工厂零get r1.正向=3 ' + (sectionNoFlag.available ? 'noFlag=固化' : 'noFlag=SDK缺失') + ' binding=3 探针=' + sensitivityAttempts + ' 业务期意外=' + businessPhaseGuardAttempts + '/总=' + guardCounters.total + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  if (!ok) process.exitCode = 1;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
