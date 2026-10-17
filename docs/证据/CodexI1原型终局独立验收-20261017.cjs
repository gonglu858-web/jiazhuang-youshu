// e62e256独立验收：从上一轮反例派生新文件，保留构造步骤，仅将期望改为本轮合同；历史文件不改。
'use strict';
// 本地复查：合成上下文/数据库/传输；不执行平台操作。默认 stdout，--out wx 新建。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const hits = [], restores = [];
function guard(o, k) { if (typeof o[k] !== 'function') return; const old = o[k]; o[k] = () => { hits.push(k); throw Error('OFFLINE'); }; restores.push(() => { o[k] = old; }); }
for (const m of ['http', 'https']) for (const k of ['get', 'request']) guard(require('node:' + m), k);
for (const k of ['connect', 'createConnection']) guard(require('node:net'), k);
guard(require('node:net').Socket.prototype, 'connect'); guard(require('node:tls'), 'connect'); guard(globalThis, 'fetch');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) { guard(require('node:dns'), k); guard(require('node:dns').promises, k); }
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) guard(require('node:child_process'), k);
const packer = require(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'));
const corePath = path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs');
const core = require(corePath);
const token = crypto.randomBytes(5).toString('hex');
const round = 'synthetic-codex-shape-' + token, pass = 'synthetic-codex-pass-' + token;
const openid = 'synthetic-codex-participant';
const uid = core.deriveUserId(core.FIXED_TARGET.appId, openid);
async function main() {
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE/);
  const probeCount = hits.length;
  const artifactRoot = path.join(root, 'artifacts/schedule-sandbox/business-test');
  const planPath = path.join(artifactRoot, 'codex-shape-review-' + token + '.json');
  const outDir = path.join(artifactRoot, 'participant-identity-codex-shape-' + token);
  const now = Date.now(), expires = now + 600000;
  fs.writeFileSync(planPath, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false,
    checkRoundId: round, participantCode: '1', ...core.FIXED_TARGET,
    requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false, passphraseDigest: sha(pass),
    windowStartsAtIso: new Date(now - 60000).toISOString(), windowExpiresAtIso: new Date(expires).toISOString(),
    closeSourceDir: path.join(artifactRoot, 'pic-close-source-8b3a3b71-a82570') }), { flag: 'wx' });
  // synthetic:false 仅让生成入口开启本地合成链；口令/账号/轮次全合成，无执行批准、无部署。
  const built = packer.build(planPath, outDir);
  assert.equal(packer.checkDir(outDir).ok, true);
  const oldCloseSource = process.env.PIC_CLOSE_SOURCE_DIR;
  process.env.PIC_CLOSE_SOURCE_DIR = path.join(artifactRoot, 'pic-close-source-8b3a3b71-a82570');
  try { assert.equal(packer.checkCloseDir(outDir).ok, true); }
  finally { if (oldCloseSource === undefined) delete process.env.PIC_CLOSE_SOURCE_DIR; else process.env.PIC_CLOSE_SOURCE_DIR = oldCloseSource; }
  const serverRoot = path.join(outDir, 'server/scheduleSandbox');
  const source = fs.readFileSync(path.join(serverRoot, 'index.js'), 'utf8');
  const adapter = require(path.join(serverRoot, 'request-adapter.js'));
  const event = () => ({ picRequest: { schema: packer.REQUEST_PROTOCOL, action: 'inspectSelf', checkRoundId: round, passphrase: pass } });
  function loadEntry(sdk, text = source, coreModule = core) {
    const m = { exports: {} };
    vm.runInNewContext(text, { module: m, exports: m.exports, process: { env: { TCB_ENV: core.FIXED_TARGET.envId } },
      require: id => { if (id === 'wx-server-sdk') return sdk; if (id === './participant-identity-check') return coreModule;
        if (id === './request-adapter') return adapter; throw Error('UNEXPECTED_MODULE'); } });
    return m.exports.main;
  }
  async function syntheticRun(e, coreModule = core) {
    const counts = { factory: 0, collection: 0, get: 0 }, fields = [];
    const sdk = { init() {}, DYNAMIC_CURRENT_ENV: 'synthetic', getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: openid }),
      database() { counts.factory++; return { collection(name) { counts.collection++; assert.equal(name, core.FIXED_TARGET.collection);
        return { doc(id) { assert.equal(id, uid); const doc = { async get() { counts.get++; return { data: { _id: uid, openid, status: 'active' } }; },
          field(f) { fields.push(Object.keys(f).sort()); return doc; } }; return doc; } }; } }; } };
    const r = await loadEntry(sdk, source, coreModule)(e);
    return { acceptedByAdapter: adapter.extractBusinessRequest(e).ok, code: r.code, state: r.registrationState,
      readAttempted: r.readAttempted, counts, fields };
  }
  const controls = {};
  controls.plain = await syntheticRun(event());
  controls.nullPrototype = await syntheticRun(Object.assign(Object.create(null), { picRequest: Object.assign(Object.create(null), event().picRequest) }));
  controls.crossRealm = await syntheticRun(vm.runInNewContext('(' + JSON.stringify(event()) + ')'));
  for (const c of Object.values(controls)) { assert.equal(c.state, 'ACTIVE'); assert.equal(c.counts.get, 1); }
  // C1：链深度相同不等于普通对象；自定义 null-root 原型可携带继承角色或 getter。
  let inheritedGetterReads = 0;
  const custom = Object.create(null);
  // 上轮简易null-root反例已拒绝，先记录修复对照。
  const oldOuter = Object.assign(Object.create(custom), event());
  controls.oldCustomNullRoot = await syntheticRun(oldOuter);
  assert.equal(controls.oldCustomNullRoot.acceptedByAdapter, false);
  assert.equal(controls.oldCustomNullRoot.counts.factory, 0);
  // 只补齐实现要求的描述符，方法全为自定义函数；仍然是人工构造的原型。
  let fakeMethodCalls = 0;
  for (const key of ['hasOwnProperty','isPrototypeOf','propertyIsEnumerable','toLocaleString','toString','valueOf','constructor']) {
    Object.defineProperty(custom,key,{enumerable:false,writable:true,configurable:true,value:function syntheticFake(){fakeMethodCalls++;}});
  }
  assert.notEqual(custom.constructor.prototype,custom);

  custom.role = 'synthetic-inherited-role';
  Object.defineProperty(custom, 'syntheticInheritedGetter', { get() { inheritedGetterReads++; throw Error('synthetic'); } });
  const outer = Object.assign(Object.create(custom), event());
  const inner = { picRequest: Object.assign(Object.create(custom), event().picRequest) };
  const protoCases = { outerCustomNullRoot: await syntheticRun(outer), innerCustomNullRoot: await syntheticRun(inner) };
  for (const c of Object.values(protoCases)) { assert.equal(c.acceptedByAdapter, false); assert.equal(c.state, 'UNKNOWN'); assert.equal(c.counts.get, 0); }
  assert.equal(inheritedGetterReads, 0);
  const copiedRoot = Object.create(null,Object.getOwnPropertyDescriptors(Object.prototype));
  assert.notEqual(copiedRoot,Object.prototype);
  assert.notEqual(Object.getOwnPropertyDescriptor(copiedRoot,'constructor').value.prototype,copiedRoot);
  protoCases.outerCopiedDescriptors = await syntheticRun(Object.assign(Object.create(copiedRoot),event()));
  protoCases.innerCopiedDescriptors = await syntheticRun({picRequest:Object.assign(Object.create(copiedRoot),event().picRequest)});
  // 即使伪造构造器的prototype手工回指，也不使它成为真实Object构造器。
  Object.getOwnPropertyDescriptor(custom,'constructor').value.prototype = custom;
  protoCases.outerFakeConstructorSelfBound = await syntheticRun(Object.assign(Object.create(custom),event()));
  protoCases.innerFakeConstructorSelfBound = await syntheticRun({picRequest:Object.assign(Object.create(custom),event().picRequest)});
  for (const c of Object.values(protoCases)) { assert.equal(c.acceptedByAdapter,false); assert.equal(c.code,'PIC_REQUEST_INVALID'); assert.equal(c.state,'UNKNOWN'); assert.equal(c.readAttempted,false); assert.equal(c.counts.factory,0); assert.equal(c.counts.collection,0); assert.equal(c.counts.get,0); }
  assert.equal(fakeMethodCalls,0);
  // 上轮参考谓词保持原样，不用于替换受测适配器。
  function referencePlainRecord(v) {
    try {
      if(v===null || typeof v!=='object' || Array.isArray(v))return false;
      const p=Object.getPrototypeOf(v);
      if(p===null || p===Object.prototype)return true;
      if(Object.getPrototypeOf(p)!==null)return false;
      const c=Object.getOwnPropertyDescriptor(p,'constructor');
      if(!c || !Object.prototype.hasOwnProperty.call(c,'value') || typeof c.value!=='function' || c.enumerable!==false)return false;
      if(Function.prototype.toString.call(c.value)!==Function.prototype.toString.call(Object))return false;
      const q=Object.getOwnPropertyDescriptor(c.value,'prototype');
      return !!q && Object.prototype.hasOwnProperty.call(q,'value') && q.value===p && q.writable===false && q.configurable===false;
    }catch(_){return false;}
  }
  const referenceChecks = {
    plain: referencePlainRecord(event()), nullPrototype: referencePlainRecord(Object.create(null)),
    crossRealm: referencePlainRecord(vm.runInNewContext('({})')),
    fakeSelfBoundRejected: !referencePlainRecord(Object.create(custom)),
    copiedDescriptorsRejected: !referencePlainRecord(Object.create(copiedRoot))
  };
  for(const value of Object.values(referenceChecks))assert.equal(value,true);

  const conflict = event(); Object.defineProperty(conflict, 'openid', { enumerable: false, value: 'synthetic-forged' });
  controls.ownNonEnumerableConflict = await syntheticRun(conflict);
  assert.equal(controls.ownNonEnumerableConflict.code, 'PIC_REQUEST_INVALID');
  assert.equal(controls.ownNonEnumerableConflict.counts.factory, 0);
  // 提取期间时钟推进至到期：加载字节未改核心，唯独 Date.now 为合成时钟。
  let clock = now;
  class TestDate extends Date { static now() { return clock; } }
  const cm = { exports: {} };
  vm.runInNewContext(fs.readFileSync(corePath, 'utf8'), { module: cm, exports: cm.exports, Date: TestDate,
    require: createRequire(corePath), Buffer, setTimeout, clearTimeout });
  const extractionExpiry = await syntheticRun(new Proxy(event(), { ownKeys(t) { clock = expires; return Reflect.ownKeys(t); } }), cm.exports);
  assert.equal(extractionExpiry.code, 'PIC_WINDOW_EXPIRED'); assert.equal(extractionExpiry.counts.get, 0);
  // C2 补充独立证明：直接修改生成入口内存副本，不是单独构造 db 来代替入口敏感性。
  const sdkPath = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/wx-server-sdk';
  const real = require(sdkPath);
  const utils = require(path.join(sdkPath, '../@cloudbase/database/dist/commonjs/utils/utils.js'));
  const sdkFacts = [], sdkCalls = []; let mode = 'hit';
  const sdkShim = { DYNAMIC_CURRENT_ENV: real.DYNAMIC_CURRENT_ENV,
    init(opts) { real.init(opts); }, getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: openid }),
    database(opts) { const db = real.database(opts); db._db.constructor.reqClass = function () { return { async send(action, params) {
      sdkCalls.push({ action, projection: utils.parseByEJSON(params.projection) });
      assert.equal(action, 'database.getDocument'); assert.equal(params.collectionName, core.FIXED_TARGET.collection);
      assert.equal(utils.parseByEJSON(params.query)._id, uid);
      if (mode === 'denied') return { code: 'DATABASE_PERMISSION_DENIED' };
      return { data: { list: mode === 'miss' ? [] : [utils.stringifyByEJSON({ _id: uid, openid, status: 'active' })], offset: 0, limit: 1 } };
    } }; }; return db; } };
  for (mode of ['hit', 'miss', 'denied']) {
    const r = await loadEntry(sdkShim)(event()); sdkFacts.push({ mode, code: r.code, state: r.registrationState, readAttempted: r.readAttempted });
  }
  assert.deepEqual(sdkFacts.map(x => x.state), ['ACTIVE', 'ABSENT', 'UNKNOWN']);
  assert.equal(sdkFacts[2].readAttempted, true);
  const flag = 'throwOnNotFound: false'; assert.equal(source.split(flag).length, 2);
  mode = 'miss'; const mutant = await loadEntry(sdkShim, source.replace(flag, ''))(event());
  assert.equal(mutant.code, 'PIC_READ_FAILED'); assert.equal(mutant.readAttempted, true); assert.equal(mutant.registrationState, 'UNKNOWN');
  assert.equal(sdkCalls.length, 4);
  for (const c of sdkCalls) assert.deepEqual(c.projection, { _id: 1, openid: 1, status: 1 });
  const unexpected = hits.length - probeCount;
  assert.equal(unexpected, 0);
  const result = { schema: 'codex-i1-prototype-final-review/1', reviewedCommits: ['e62e256'], basis: 'f7cb27f', observedAt: new Date().toISOString(),
    evidenceAssertionsPassed: true, prototypeRepairAccepted: true,
    coreSha256: sha(fs.readFileSync(corePath)), adapterSha256: sha(fs.readFileSync(path.join(serverRoot, 'request-adapter.js'))),
    packerSha256: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    files: { candidate: built.manifest.files.length, close: built.manifest.closePackage.files.length },
    controls, prototypeCounterexamples: protoCases, inheritedGetterReads, fakeMethodCalls, referenceChecks, extractionExpiry,
    sdk: { version: require(path.join(sdkPath, 'package.json')).version, databaseVersion: require(path.join(sdkPath, '../@cloudbase/database/package.json')).version,
      routes: sdkFacts, mutatedGeneratedEntry: { code: mutant.code, state: mutant.registrationState, readAttempted: mutant.readAttempted }, calls: sdkCalls,
      substitution: 'SDK facade delegates init/database unchanged; synthetic getWXContext and Db.reqClass transport. Generated source mutated only in memory for sensitivity; no platform verification.' },
    guardCounters: { sensitivity: probeCount, unexpected, total: hits.length },
    limits: 'Scoped prototype contract accepted for six forged and three positive cases; not a proof against arbitrary lying Proxies or modified builtins. Local synthetic contexts and transport only; no platform verification, credentials or cloud actions. History preservation reviewed separately.' };
  const text = JSON.stringify(result, null, 2) + '\n';
  const idx = process.argv.indexOf('--out'); if (idx >= 0) { assert.ok(process.argv[idx + 1]); fs.writeFileSync(process.argv[idx + 1], text, { flag: 'wx' }); }
  console.log(text);
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => restores.reverse().forEach(f => f()));
