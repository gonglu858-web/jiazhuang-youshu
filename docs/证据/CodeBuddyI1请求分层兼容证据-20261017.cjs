// I1 请求分层兼容证据（修复后实现证明；合成_counterexamples_，非平台验证）。
// 依据：docs/CodeBuddy任务-I1请求分层兼容本地实现-20261017.md、docs/Codex方案-I1请求分层兼容设计-20261016.md §3–§6、
// 授权 docs/证据/CodexI1请求分层本地实施授权-20261017.json。stdout 默认；--out wx 独占新建。
// 守卫计数（探针/业务期意外/总数）写入 JSON 并以同一实际计数决定 ok/退出码；被 catch 意外也记账。
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
const SDK_PATH = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/wx-server-sdk';
const TEST_ROUND = 'synthetic-layering-round-' + crypto.randomBytes(3).toString('hex');
const PASSPHRASE = 'synthetic-layering-passphrase-' + crypto.randomBytes(6).toString('hex');
const DIGEST = sha(PASSPHRASE);
const makeCloseSource = () => {
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'layer-src-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan.json');
  const round = 'synthetic-layer-close-src';
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
  const closeSource = makeCloseSource();
  const openid = 'synthetic-layering-openid';
  const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);

  // ── A：适配器单元（§3 矩阵要点）────────────────────────────────────────────
  const valid = { schema: 'participant-identity-request/1', action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE };
  const accepted = {};
  accepted.plain = requestAdapter.extractBusinessRequest({ picRequest: valid }).ok === true;
  accepted.nullProto = requestAdapter.extractBusinessRequest(Object.assign(Object.create(null), { picRequest: Object.assign(Object.create(null), valid) })).ok === true;
  accepted.crossRealmPlain = requestAdapter.extractBusinessRequest(vm.runInNewContext('({ picRequest: { schema: "participant-identity-request/1", action: "inspectSelf", checkRoundId: "' + TEST_ROUND + '", passphrase: "' + PASSPHRASE + '" } })')).ok === true;
  const withFull = requestAdapter.extractBusinessRequest({ picRequest: Object.assign({}, valid, { includeFullUserId: true }) });
  accepted.fullIdBooleanPassthrough = withFull.ok === true && withFull.request.includeFullUserId === true;
  accepted.requestHasExactlyFourFields = JSON.stringify(Object.keys(withFull.request).sort()) === JSON.stringify(['action', 'checkRoundId', 'includeFullUserId', 'passphrase']);
  accepted.schemaNotPassedToCore = !Object.prototype.hasOwnProperty.call(withFull.request, 'schema');
  const rejectNames = ['event数组', 'event标量', '缺picRequest', 'picRequest继承', 'picRequest标量', 'picRequest访问器', '外层冲突action', '外层自报openid', '外层自报OPENID', '外层Symbol键',
    '内层额外字段', '内层伪造openid', '内层伪造role', '内层Symbol键', '内层非枚举action', '内层action访问器', '内层action数字', 'includeFullUserId字符串',
    'schema错版本', 'schema大小写', '缺schema', '元操作抛错', '自定义原型', '两层继承'];
  const rejectMk = {
    'event数组': () => [{ picRequest: valid }], 'event标量': () => 'x', '缺picRequest': () => ({}),
    'picRequest继承': () => Object.create({ picRequest: valid }), 'picRequest标量': () => ({ picRequest: 'x' }),
    'picRequest访问器': () => { const e = {}; Object.defineProperty(e, 'picRequest', { enumerable: true, get() { return valid; } }); return e; },
    '外层冲突action': () => ({ action: 'inspectSelf', picRequest: valid }), '外层自报openid': () => ({ openid: 'x', picRequest: valid }),
    '外层自报OPENID': () => ({ OPENID: 'x', picRequest: valid }), '外层Symbol键': () => { const e = { picRequest: valid }; e[Symbol.for('s')] = 1; return e; },
    '内层额外字段': () => ({ picRequest: Object.assign({}, valid, { extra: 1 }) }), '内层伪造openid': () => ({ picRequest: Object.assign({}, valid, { openid: 'x' }) }),
    '内层伪造role': () => ({ picRequest: Object.assign({}, valid, { role: 'x' }) }), '内层Symbol键': () => { const p = Object.assign({}, valid); p[Symbol.for('s')] = 1; return { picRequest: p }; },
    '内层非枚举action': () => { const p = {}; Object.defineProperty(p, 'action', { enumerable: false, value: 'inspectSelf' }); p.schema = valid.schema; p.checkRoundId = TEST_ROUND; p.passphrase = PASSPHRASE; return { picRequest: p }; },
    '内层action访问器': () => { const p = {}; Object.defineProperty(p, 'action', { enumerable: true, get() { return 'inspectSelf'; } }); p.schema = valid.schema; p.checkRoundId = TEST_ROUND; p.passphrase = PASSPHRASE; return { picRequest: p }; },
    '内层action数字': () => ({ picRequest: Object.assign({}, valid, { action: 1 }) }), 'includeFullUserId字符串': () => ({ picRequest: Object.assign({}, valid, { includeFullUserId: 'true' }) }),
    'schema错版本': () => ({ picRequest: Object.assign({}, valid, { schema: 'participant-identity-request/2' }) }), 'schema大小写': () => ({ picRequest: Object.assign({}, valid, { schema: 'PARTICIPANT-IDENTITY-REQUEST/1' }) }),
    '缺schema': () => { const p = Object.assign({}, valid); delete p.schema; return { picRequest: p }; },
    '元操作抛错': () => new Proxy({ picRequest: valid }, { ownKeys() { throw Error('synthetic-meta'); } }),
    '自定义原型': () => { function C() {} C.prototype.picRequest = valid; return new C(); }, '两层继承': () => { const m = Object.create({ picRequest: valid }); return Object.create(m); }
  };
  const rejections = {};
  for (const name of rejectNames) {
    const r = requestAdapter.extractBusinessRequest(rejectMk[name]());
    rejections[name] = r.ok === false && r.request === undefined;
    assert.equal(rejections[name], true, name + ' 必须拒绝且不构造请求');
  }
  const sectionAdapter = { accepted, rejectTotal: rejectNames.length, rejections, allRejected: Object.values(rejections).every(Boolean) };

  // ── B：实际生成链（真实模式候选）：容忍外层附带 → 本人只读链；旧格式/内层非法拒绝 ──
  const outDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-layer-' + crypto.randomBytes(4).toString('hex'));
  const starts = Date.now() - 60000;
  const planPath = path.join(path.dirname(outDir), 'layer-plan-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(planPath, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: TEST_ROUND, participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: DIGEST, windowStartsAtIso: new Date(starts).toISOString(), windowExpiresAtIso: new Date(starts + 600000).toISOString(),
    closeSourceDir: closeSource, requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  const built = packer.build(planPath, outDir);
  assert.equal(packer.checkDir(outDir).ok, true);
  const serverFile = path.join(outDir, 'server', 'scheduleSandbox', 'index.js');
  const adapterFile = path.join(outDir, 'server', 'scheduleSandbox', 'request-adapter.js');
  const nativeRequire = createRequire(serverFile);
  const roundId = built.manifest.checkRoundId;
  const mkChain = (mutate, rows) => {
    const factory = { databaseCalls: 0 };
    const dbCalls = { collections: [], reads: 0, fields: [] };
    const db = {
      collection(name) {
        dbCalls.collections.push(name);
        if (name !== core.FIXED_TARGET.collection) throw Error('TRAP 集合');
        return {
          doc(id) {
            if (id !== userId) throw Error('TRAP 主键');
            return {
              // R6：docRef 本身必须可 get（未投影 get 视为缺陷并计数）；实际读取走 field().get()
              async get() { dbCalls.reads++; throw Error('unprojected get'); },
              field(f) {
                dbCalls.fields.push(f);
                return {
                  async get() {
                    dbCalls.reads++;
                    const rows2 = rows || [{ _id: userId, openid, status: 'active' }];
                    return { data: rows2.length === 1 ? rows2[0] : (rows2.length === 0 ? null : rows2) };
                  }
                };
              }
            };
          }
        };
      }
    };
    let main;
    const sent = { keys: null };
    const wx = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction: async opts => {
      sent.keys = Object.keys(opts.data);
      const event = Object.assign({}, opts.data);
      const replaced = mutate ? mutate(event) : undefined;
      return { result: await main(replaced === undefined ? event : replaced) };
    } } };
    vm.runInNewContext(fs.readFileSync(serverFile, 'utf8'), {
      require: name => (name === 'wx-server-sdk'
        ? { DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: openid }), database: opts => { factory.databaseCalls++; return db; } }
        : name === './participant-identity-check' ? core : name === './request-adapter' ? requestAdapter : (() => { throw Error('unexpected ' + name); })()),
      module: main = { exports: {} }, exports: main.exports, process: { env: { TCB_ENV: core.FIXED_TARGET.envId } }, console
    });
    main = main.exports.main;
    return { wx, sent, factory, dbCalls };
  };
  const secretKey = 'synthetic_secret_' + crypto.randomBytes(8).toString('hex');
  const secretInResult = [];
  const chainOk = mkChain(e => {
    e.userInfo = { appId: 'synthetic-envelope-appid', openId: 'synthetic-envelope-openid' };
    e.syntheticUnknownKey12 = 1;
    e[secretKey] = 1;
    Object.defineProperty(e, 'syntheticGetterKey', { enumerable: true, get() { throw Error('synthetic-envelope-getter'); } });
  });
  const posResult = (await chainOk.wx.cloud.callFunction({ data: { picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE, includeFullUserId: true } } })).result;
  const chainTolerance = {
    state: posResult.registrationState, readAttempted: posResult.readAttempted,
    fullIdReturned: posResult.userId === userId,
    factoryCalls: chainOk.factory.databaseCalls, collectionCalls: chainOk.dbCalls.collections.length, reads: chainOk.dbCalls.reads,
    projection: JSON.stringify(chainOk.dbCalls.fields[0]),
    outerKeysSent: chainOk.sent.keys.join(','),
    secretLeaked: JSON.stringify(posResult).includes(secretKey),
    getterTriggered: false,
    diagFieldAbsent: !Object.prototype.hasOwnProperty.call(posResult, 'keyDiagnostic')
  };
  assert.equal(chainTolerance.state, 'ACTIVE'); assert.equal(chainTolerance.factoryCalls, 1); assert.equal(chainTolerance.reads, 1);
  assert.equal(chainTolerance.secretLeaked, false); assert.equal(chainTolerance.diagFieldAbsent, true);
  const chainRejections = {};
  const chainRejectCases = {
    仅旧顶层格式: e => { Object.assign(e, { action: 'inspectSelf', passphrase: PASSPHRASE, checkRoundId: TEST_ROUND }); },
    两格式混用: e => { e.action = 'inspectSelf'; },
    外层自报身份: e => { e.openid = 'x'; e.APPID = 'x'; },
    内层额外字段: e => { e.picRequest.extra = 1; },
    内层伪造身份: e => { e.picRequest.openid = 'x'; },
    内层错schema: e => { e.picRequest.schema = 'participant-identity-request/2'; },
    picRequest访问器: e => { delete e.picRequest; Object.defineProperty(e, 'picRequest', { enumerable: true, get() { throw Error('synthetic'); } }); },
    元操作抛错: e => { e[Symbol.for('s')] = 1; }
  };
  for (const [name, mutate] of Object.entries(chainRejectCases)) {
    const chain = mkChain(mutate, [{ _id: userId, openid, status: 'active' }]);
    const r = (await chain.wx.cloud.callFunction({ data: { picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE } } })).result;
    chainRejections[name] = { code: r.code, factory: chain.factory.databaseCalls, reads: chain.dbCalls.reads, diagAbsent: !Object.prototype.hasOwnProperty.call(r, 'keyDiagnostic') };
    assert.equal(r.code, 'PIC_REQUEST_INVALID', name); assert.equal(chain.factory.databaseCalls, 0, name + ' 零工厂'); assert.equal(chain.dbCalls.reads, 0, name + ' 零读取');
  }
  const sectionChain = { tolerance: chainTolerance, rejections: chainRejections, rejectTotal: Object.keys(chainRejections).length };

  // ── C：真实 SDK 三路与敏感性反例（仅传输替换；上下文/工厂参数合成并披露）────
  let sectionSdk = { available: fs.existsSync(SDK_PATH) };
  if (sectionSdk.available) {
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
      sectionSdk.version = require(path.join(SDK_PATH, 'package.json')).version;
      const initArgs = [], databaseArgs = [];
      let script = [];
      const mkEntry = () => {
        const srv = { exports: {} };
        vm.runInNewContext(fs.readFileSync(serverFile, 'utf8'), {
          require: name => (name === 'wx-server-sdk' ? {
            DYNAMIC_CURRENT_ENV: realCloud.DYNAMIC_CURRENT_ENV,
            init(opts) { initArgs.push(opts); realCloud.init(opts); },
            getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: openid }),
            database(opts) { databaseArgs.push(opts); const db = realCloud.database(opts);
              class T { async send(action) { if (action !== 'database.getDocument') throw Error('only get'); const s = script.shift(); if (!s) throw Error('script exhausted');
                if (s === 'exists') { const utils = require(path.join(SDK_PATH, '../@cloudbase/database', 'dist', 'commonjs', 'utils', 'utils.js')); return { data: { list: [utils.stringifyByEJSON({ _id: userId, openid, status: 'active' })], offset: 0, limit: 1 } }; } if (s === 'absent') return { data: { list: [], offset: 0, limit: 1 } }; return { code: 'DATABASE_PERMISSION_DENIED' }; } }
              db._db.constructor.reqClass = function () { return { send(action) { return T.prototype.send.call(this, action); } }; };
              return db; }
          } : name === './participant-identity-check' ? core : name === './request-adapter' ? requestAdapter : (() => { throw Error('unexpected ' + name); })()),
          module: srv, exports: srv.exports, process: { env: { TCB_ENV: core.FIXED_TARGET.envId } }, console
        });
        return { srv, main: srv.exports.main };
      };
      const e1 = mkEntry();
      script = ['exists'];
      const hit = await e1.main({ picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE, includeFullUserId: true } });
      script = ['absent'];
      const miss = await e1.main({ picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE } });
      script = ['denied'];
      const denied = await e1.main({ picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE } });
      sectionSdk.paths = { exists: hit.registrationState, absent: miss.registrationState, denied: denied.code, deniedReadAttempted: denied.readAttempted };
      sectionSdk.initArgsPassthrough = initArgs.length >= 1 && initArgs[0] && initArgs[0].env === realCloud.DYNAMIC_CURRENT_ENV;
      sectionSdk.databaseArgsPassthrough = databaseArgs.every(a => JSON.stringify(a) === JSON.stringify({ throwOnNotFound: false }));
      assert.equal(sectionSdk.paths.exists, 'ACTIVE'); assert.equal(sectionSdk.paths.absent, 'ABSENT');
      assert.equal(sectionSdk.paths.denied, 'PIC_READ_FAILED'); assert.equal(sectionSdk.paths.deniedReadAttempted, true);
      assert.equal(sectionSdk.initArgsPassthrough, true); assert.equal(sectionSdk.databaseArgsPassthrough, true);
      // 敏感性：无 throwOnNotFound:false 的实例，不存在路（空列表）抛错
      const dbNoFlag = realCloud.database({});
      class EmptyT { async send() { return { data: { list: [], offset: 0, limit: 1 } }; } }
      dbNoFlag._db.constructor.reqClass = function () { return new EmptyT(); };
      let threw = null;
      try { await dbNoFlag.collection('schtest_v1_users').doc('u_' + 'b'.repeat(40)).field({ _id: true }).get(); } catch (err) { threw = err; }
      sectionSdk.sensitivityNoFlagAbsentThrows = threw !== null;
      assert.equal(sectionSdk.sensitivityNoFlagAbsentThrows, true);
      sectionSdk.networkAttempts = networkAttempts.n;
      assert.equal(networkAttempts.n, 0);
    } finally {
      for (const [mod, key, original] of originals) mod[key] = original;
    }
  }

  // ── D：v2 来源绑定反例 ────────────────────────────────────────────────────
  const tamperPlan = patch => {
    const planObj = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete planObj[k]; else planObj[k] = v; }
    const p2 = path.join(path.dirname(planPath), 'tamper-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(p2, JSON.stringify(planObj, null, 2));
    try { packer.build(p2, path.join(path.dirname(outDir), 'participant-identity-tamper-' + crypto.randomBytes(3).toString('hex'))); return true; } catch (e) { return false; }
  };
  const sectionBinding = {
    keyDiagnosticTrueRejected: tamperPlan({ keyDiagnostic: true }) === false,
    requestProtocolMissingRejected: tamperPlan({ requestProtocol: undefined }) === false,
    requestProtocolWrongRejected: tamperPlan({ requestProtocol: 'participant-identity-request/2' }) === false,
    v1PlanSchemaRejected: tamperPlan({ schema: 'participant-identity-plan/1' }) === false
  };
  assert.equal(sectionBinding.keyDiagnosticTrueRejected, true); assert.equal(sectionBinding.requestProtocolMissingRejected, true);
  assert.equal(sectionBinding.requestProtocolWrongRejected, true); assert.equal(sectionBinding.v1PlanSchemaRejected, true);

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  const businessPhaseGuardAttempts = guardHits.length - businessStart;
  const guardCounters = { sensitivityAttempts, businessPhaseGuardAttempts, total: guardHits.length };
  const ok = businessPhaseGuardAttempts === 0;
  const result = {
    schema: 'codebuddy-i1-request-layering-evidence/1',
    observedAt: new Date().toISOString(),
    basisCommit: '347261a',
    implementationBasis: 'f0b7fa9（核心字节不变）+ 本轮适配器/入口/客户端/配置/打包器 v2',
    verificationKind: 'offline fix-proof evidence for request layering; synthetic events/counterexamples, not platform verification',
    ok,
    guardCounters,
    adapterSourceSha256: sha(fs.readFileSync(root + '/miniapp/scripts/templates/participant-identity-check/server/request-adapter.js')),
    coreSha256Unchanged: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-identity-check.cjs')),
    protocol: packer.REQUEST_PROTOCOL,
    candidateFiles: built.manifest.files.length,
    closeFiles: built.manifest.closePackage.files.length,
    sections: { adapter: sectionAdapter, chain: sectionChain, sdk: sectionSdk, binding: sectionBinding },
    implementationSummary: {
      adapter: '固定 picRequest 内层 + participant-identity-request/1；外层只查自有键名（含 Symbol/非枚举），冲突名单仅比较键名；内层仅 schema+原四字段（非枚举/访问器/Symbol/类型错误拒绝）；只读 descriptor.value；不 spread/不克隆/不回退旧格式；元操作抛错净化为 ok:false',
      entry: '适配在 cloud.database() 之前；失败返回既有 schema/PIC_REQUEST_INVALID/UNKNOWN/readAttempted=false、轮次来自受审配置、不附诊断/serverTime；成功仅构造原四字段交未改核心',
      client: 'picRequest 内层 + schema 取自生成配置 requestProtocol 绑定；includeFullUserId 语义保持',
      packer: '计划/manifest 升 v2 并必填 requestProtocol；keyDiagnostic 仅 false/缺省；适配器逐字节复制入 server/scheduleSandbox；PINNED 同步；候选 15 文件、关闭 23 文件不变'
    },
    disclosure: '存在/不存在/权限失败三路使用真实 wx-server-sdk 3.0.1 + @cloudbase/database 1.4.1 代码；仅传输层（Db.reqClass）与 getWXContext 为合成替换；不称平台验证',
    cloudOperations: 0,
    limitations: [
      '真实平台是否保留 picRequest 内层对象仍未知；本证据全部为合成事件与本地传输替身。',
      '不宣称平台零日志、零费用、一次性口令或全局限流。'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[分层证据摘要] ok=' + ok + ' adapter.拒绝=' + sectionAdapter.rejectTotal + ' chain.容忍=ACTIVE/拒绝=' + sectionChain.rejectTotal + ' sdk.available=' + sectionSdk.available + ' binding.反例=4 探针=' + sensitivityAttempts + ' 业务期意外=' + businessPhaseGuardAttempts + '/总=' + guardCounters.total + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  if (!ok) process.exitCode = 1;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
