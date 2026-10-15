'use strict';
// WorkBuddy 独立证据：I1/I2 前置核验——真实 wx-server-sdk 本地转换 + 同名函数部署映射。
// 全程离线、无真实凭据：SDK 行为证据来自本地副本源码与真实数据库实现代码
// （仅传输层以本地替身替换并如实标注），映射证据来自实际生成制品的静态核对。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// ── 离线守卫：敏感性探针与业务期意外尝试分开记账（含被 catch 的尝试） ──
const guardHits = [];
const restore = [];
function guard(mod, name) {
  if (typeof mod[name] !== 'function') return;
  const old = mod[name];
  mod[name] = function () { guardHits.push(name); throw new Error('WB_OFFLINE_GUARD'); };
  restore.push(() => { mod[name] = old; });
}
for (const id of ['node:http', 'node:https']) {
  const mod = require(id);
  for (const name of ['request', 'get']) guard(mod, name);
}
for (const name of ['connect', 'createConnection']) guard(require('node:net'), name);
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
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const RUN = crypto.randomUUID();
const OUT_ROOT = path.join(ROOT, 'artifacts/schedule-sandbox/business-test');
const WORK = path.join(OUT_ROOT, 'wb-pic-sdkmap-' + RUN);
fs.mkdirSync(WORK, { recursive: true });
let seq = 0;
const outDirFor = tag => path.join(OUT_ROOT, 'participant-identity-wb-sdk-' + tag + '-' + RUN.slice(-8) + '-' + (++seq));
const APPID = core.FIXED_TARGET.appId;
const ENV_ID = core.FIXED_TARGET.envId;
const writeJson = (dir, name, data) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, JSON.stringify(data, null, 2), { flag: 'wx' });
  return target;
};
const results = [];

async function probe(id, fn) {
  try {
    results.push({ id, assertionsPassed: true, actual: await fn() });
  } catch (error) {
    results.push({ id, assertionsPassed: false, error: error.message });
  }
}

async function main() {
  for (const fn of [
    () => require('node:https').request('https://example.invalid'),
    () => require('node:child_process').spawn('node', [])
  ]) assert.throws(fn, /WB_OFFLINE_GUARD/);
  const sensitivityHits = guardHits.length;

  // ── K0：受审关闭包来源（先经未改 checkCloseDir 校验） ──
  let closeSource = null;
  await probe('K0_close_source_pinned_check', async () => {
    const round = 'synthetic-close-' + RUN.slice(0, 12);
    const users = Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
      userId: 'u_' + sha(APPID + ':synthetic-' + role + RUN).slice(0, 40), source: 'synthetic fixture'
    }]));
    const plan = writeJson(WORK, 'business-plan.json', {
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: round, windowNo: 'P-01', appId: APPID, envId: ENV_ID, users,
      projectReadyMarker: 'ready-' + round,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    });
    closeSource = business.build('P', plan, outDirFor('close-source')).outDir;
    assert.equal(business.checkCloseDir(closeSource).ok, true, '关闭来源独立校验');
    return { closeCheckOk: true };
  });

  // ── K1：真实 SDK 依赖发现与版本边界 ──
  const SDK_BASE = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
  let sdkVersion = null, nodeSdkVersion = null, tcbDbVersion = null;
  await probe('K1_sdk_dependency_discovery', async () => {
    const sdkPath = path.join(SDK_BASE, 'wx-server-sdk');
    const pkg = JSON.parse(fs.readFileSync(path.join(sdkPath, 'package.json'), 'utf8'));
    sdkVersion = pkg.version;
    nodeSdkVersion = JSON.parse(fs.readFileSync(path.join(SDK_BASE, '@cloudbase/node-sdk/package.json'), 'utf8')).version;
    tcbDbVersion = JSON.parse(fs.readFileSync(path.join(SDK_BASE, '@cloudbase/database/package.json'), 'utf8')).version;
    // 依赖树完整性：真实加载 wx-server-sdk 主模块（不 init、不联网）
    const sdk = require(sdkPath);
    assert.equal(typeof sdk.init, 'function');
    assert.equal(typeof sdk.database, 'function');
    assert.ok(sdk.DYNAMIC_CURRENT_ENV !== undefined, 'DYNAMIC_CURRENT_ENV 常量可访问');
    // npm 本地缓存无 ~2.6.3 tarball（如实记录，不联网安装）
    const cacheIndex = process.env.LOCALAPPDATA + '/npm-cache/index-v5';
    let cacheHasSdk = false;
    if (fs.existsSync(cacheIndex)) {
      for (const dir of fs.readdirSync(cacheIndex)) {
        const sub = path.join(cacheIndex, dir);
        for (const f of fs.readdirSync(sub)) {
          if (fs.readFileSync(path.join(sub, f), 'utf8').includes('wx-server-sdk')) cacheHasSdk = true;
        }
      }
    }
    assert.equal(cacheHasSdk, false, 'npm 本地缓存不得含 wx-server-sdk（否则须说明来源）');
    return {
      declaredRange: '~2.6.3',
      localCopyVersion: sdkVersion,
      localCopyPath: sdkPath,
      localCopySha256: sha(fs.readFileSync(path.join(sdkPath, 'index.js'))),
      cloudbaseNodeSdk: nodeSdkVersion,
      cloudbaseDatabase: tcbDbVersion,
      npmCacheHasSdkTarball: cacheHasSdk,
      versionBoundaryNote: '本地副本为 3.0.1；~2.6.3 精确版本本地不可得且不联网安装——2.6.3 精确转换列为待云端部署前只读复核'
    };
  });

  // ── K2：静态源码核验（真实字节，零手造） ──
  await probe('K2_static_source_semantics', async () => {
    const sdkIndex = fs.readFileSync(path.join(SDK_BASE, 'wx-server-sdk', 'index.js'), 'utf8');
    const docSrc = fs.readFileSync(path.join(SDK_BASE, '@cloudbase/database', 'dist', 'commonjs', 'document.js'), 'utf8');
    const changelog = fs.readFileSync(path.join(SDK_BASE, 'wx-server-sdk', 'CHANGELOG.md'), 'utf8');
    // wx-server-sdk 单文档 get() 包装层语义（按锚点断言真实存在）
    const anchors = [
      ['包装层-读取 throwOnNotFound（默认 true）',
        "const throwOnNotFound = this.database.config.hasOwnProperty('throwOnNotFound') ? Boolean(this.database.config.throwOnNotFound) : true;"],
      ['包装层-不存在且默认配置时抛错', 'if (throwOnNotFound) {'],
      ['包装层-不抛错时 data:null', 'data: null,'],
      ['包装层-存在时取单对象', 'data: Array.isArray(queryResult.data) ? queryResult.data[0] : queryResult.data,'],
      ['database(config) 透传 throwOnNotFound', 'this.config = config;']
    ];
    const found = {};
    for (const [label, needle] of anchors) {
      found[label] = sdkIndex.includes(needle);
      assert.ok(found[label], 'wx-server-sdk 源码缺少锚点：' + label);
    }
    // @cloudbase/database 底层 get/field 语义
    const dbAnchors = [
      ['底层 get 调用 database.getDocument', "this.request.send('database.getDocument', param"],
      ['底层投影随请求发送', 'param.projection = utils_1.stringifyByEJSON(projection);'],
      ['底层 field 布尔→1/0 转换', "transformProjection[k] = projection[k] === true ? 1 : 0;"],
      ['底层成功返回数组', 'data: documents,'],
      ['底层错误原样返回待上层抛出', 'if (res.code) {']
    ];
    const dbFound = {};
    for (const [label, needle] of dbAnchors) {
      dbFound[label] = docSrc.includes(needle);
      assert.ok(dbFound[label], '@cloudbase/database 源码缺少锚点：' + label);
    }
    // 版本差异：2.6.3 → 3.0.0 的 CHANGELOG 变更仅 protobufjs 与 d.ts，无数据库 API 行为变更
    const seg30 = changelog.slice(changelog.indexOf('### 3.0.0'), changelog.indexOf('### 2.6.3'));
    assert.ok(/protobufjs/.test(seg30) && /d\.ts|d.ts/.test(seg30), '3.0.0 变更条目须可识别');
    // d.ts 定义增加不构成行为变更；不得出现 doc()/field()/get() 等 API 行为修改记录
    assert.ok(!/doc\(|field\(|get\(\)|database\.getDocument/i.test(seg30), '3.0.0 相对 2.6.3 不得含数据库 API 行为变更');
    return {
      sdkAnchorsFound: found,
      dbAnchorsFound: dbFound,
      changelog_3_0_0_entries: seg30.trim().split('\n').filter(l => l.trim()).slice(0, 4),
      conclusion: '3.0.1 实测源码语义：database({throwOnNotFound:false}) 时 doc().field(P).get() 存在→{data:单对象}、不存在→{data:null}、失败→reject；2.6.3→3.0.1 CHANGELOG 无数据库 API 行为变更'
    };
  });

  // ── K3：动态转换核验（真实 @cloudbase/database 代码全链，仅传输层本地替身） ──
  await probe('K3_dynamic_conversion_with_real_db_impl', async () => {
    const tcb = require(path.join(SDK_BASE, '@cloudbase', 'database'));
    const sent = [];
    class LocalTransport {
      constructor(config) { this.config = config; }
      async send(action, params) {
        sent.push({ action, projection: params.projection || null, query: params.query || null });
        if (action !== 'database.getDocument') throw new Error('K3 只允许只读 getDocument');
        if (sent.length === 1) {
          // 存在：平台响应形状（EJSON 列表）
          return {
            data: { list: [require(path.join(SDK_BASE, '@cloudbase/database', 'dist', 'commonjs', 'utils', 'utils.js')).stringifyByEJSON({ _id: 'u_' + 'a'.repeat(40), openid: 'synthetic-openid', status: 'active' })], offset: 0, limit: 1 },
            requestId: 'synthetic-req-1'
          };
        }
        if (sent.length === 2) return { data: { list: [], offset: 0, limit: 1 }, requestId: 'synthetic-req-2' };
        return { code: 'DATABASE_PERMISSION_DENIED', requestId: 'synthetic-req-3' };
      }
    }
    tcb.Db.reqClass = LocalTransport; // 仅替换传输层；数据库实现全部为真实代码
    const db = new tcb.Db({ env: 'synthetic-env-local' });
    const userId = 'u_' + 'a'.repeat(40);
    // (1) 存在：投影 + get
    const hit = await db.collection('schtest_v1_users').doc(userId)
      .field({ _id: true, openid: true, status: true }).get();
    assert.ok(Array.isArray(hit.data) && hit.data.length === 1, '真实实现存在→数组 1 条');
    assert.equal(hit.data[0]._id, userId);
    assert.equal(hit.data[0].status, 'active');
    assert.equal(hit.data[0].openid, 'synthetic-openid');
    // 投影确实随请求发送（EJSON 序列化 _id:1/openid:1/status:1）
    assert.ok(sent[0].projection, '投影参数必须发送');
    assert.ok(sent[0].projection.includes('_id') && sent[0].projection.includes('openid') && sent[0].projection.includes('status'));
    assert.equal(sent[0].action, 'database.getDocument');
    // (2) 明确不存在：空列表 → { data: [] }
    const miss = await db.collection('schtest_v1_users').doc('u_' + 'b'.repeat(40))
      .field({ _id: true, openid: true, status: true }).get();
    assert.ok(Array.isArray(miss.data) && miss.data.length === 0, '真实实现不存在→空数组');
    // (3) 权限/读取失败：res.code 原样返回（上层 wx-server-sdk checkError 抛 CloudSDKError）
    const denied = await db.collection('schtest_v1_users').doc('u_' + 'c'.repeat(40))
      .field({ _id: true, openid: true, status: true }).get();
    assert.equal(denied.code, 'DATABASE_PERMISSION_DENIED', '失败响应带平台 code');
    // 恢复 reqClass（不污染其他 require）
    delete tcb.Db.reqClass;
    return {
      transportReplacedOnly: 'LocalTransport 仅替换 Db.reqClass 传输层；解析/EJSON/投影/包装全部为真实 @cloudbase/database 1.4.1 代码',
      existsShape: { isArray: Array.isArray(hit.data), len: hit.data.length, keys: Object.keys(hit.data[0]).sort() },
      missingShape: { isArray: Array.isArray(miss.data), len: miss.data.length },
      deniedShape: { code: denied.code },
      projectionSent: sent[0].projection,
      actionName: sent[0].action
    };
  });

  // ── K4：核心模块消费真实形状（单对象/null/数组）不误判 ──
  await probe('K4_core_consumes_real_sdk_shapes', async () => {
    const PASS = 'synthetic-wb-pass-' + RUN;
    const DIGEST = sha(PASS);
    const ROUND = 'wb-sdk-' + RUN.slice(0, 12);
    const openid = 'synthetic-wb-core-' + RUN;
    const userId = core.deriveUserId(APPID, openid);
    const mk = (getDb) => core.createIdentityChecker({
      db: getDb(),
      trusted: { appId: APPID, envId: ENV_ID, openid },
      config: { checkRoundId: ROUND, passphraseDigest: DIGEST, windowStartsAtMs: 1000, windowExpiresAtMs: 601000 },
      now: () => 2000
    });
    const req = { action: 'inspectSelf', passphrase: PASS, checkRoundId: ROUND };
    const realDoc = {
      field() { return this; },
      async get() {
        // 真实 wx-server-sdk resolve 形状（throwOnNotFound=false）
        return { data: { _id: userId, openid, status: 'active' }, errMsg: 'document.get:ok' };
      }, set() {}, update() {}, remove() {}
    };
    const active = await mk(() => ({ collection: () => ({ doc: () => realDoc, add() {} }) })).handle(req);
    assert.equal(active.registrationState, 'ACTIVE', '单对象存在→ACTIVE');
    assert.equal(active.identityConfirmed, true);
    const absent = await mk(() => ({ collection: () => ({ doc: () => ({
      field() { return this; }, async get() { return { data: null, errMsg: 'document.get:ok' }; },
      set() {}, update() {}, remove() {} }), add() {} }) })).handle(req);
    assert.equal(absent.registrationState, 'ABSENT', 'data:null→ABSENT（不得误判 READ_FAILED）');
    const denied = await mk(() => ({ collection: () => ({ doc: () => ({
      field() { return this; }, async get() { throw new Error('synthetic permission failure'); },
      set() {}, update() {}, remove() {} }), add() {} }) })).handle(req);
    assert.equal(denied.registrationState, 'UNKNOWN', 'reject→UNKNOWN');
    assert.equal(denied.readAttempted, true, 'get 已调用如实记录');
    assert.equal(denied.userId, null, '失败不交付完整 ID');
    return {
      activeState: active.registrationState,
      absentState: absent.registrationState,
      deniedState: denied.registrationState,
      deniedReadAttempted: denied.readAttempted,
      shapesSupported: ['single-object(hit)', 'null(absent)', 'array(hit/absent/multi)', 'reject(unknown)']
    };
  });

  // ── K5：同名函数部署映射（实际生成制品静态核对） ──
  const starts = Date.now() - 60000;
  await probe('K5_deployment_mapping_same_name_dir', async () => {
    const plan = writeJson(WORK, 'identity-plan.json', {
      schema: packer.PLAN_SCHEMA, synthetic: true, checkRoundId: 'wb-sdk-' + RUN.slice(0, 12),
      participantCode: '1', appId: APPID, envId: ENV_ID,
      functionName: core.FIXED_TARGET.functionName, collection: core.FIXED_TARGET.collection,
      passphraseDigest: sha('synthetic-wb-pass-' + RUN),
      windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 600000).toISOString(),
      closeSourceDir: closeSource, note: 'WorkBuddy SDK/mapping synthetic fixture'
    });
    const outDir = outDirFor('candidate');
    packer.build(plan, outDir);
    const check = packer.checkDir(outDir);
    assert.equal(check.ok, true, '候选自校验通过');
    const serverRoot = path.join(outDir, 'server');
    const children = fs.readdirSync(serverRoot);
    assert.deepEqual(children, [packer.SERVER_FN_DIR], 'server/ 下仅同名函数子目录');
    assert.equal(packer.SERVER_FN_DIR, core.FIXED_TARGET.functionName, '子目录名=受审函数名');
    const fnDir = path.join(serverRoot, packer.SERVER_FN_DIR);
    const fnFiles = fs.readdirSync(fnDir).sort();
    assert.deepEqual(fnFiles, ['index.js', 'package.json', 'participant-identity-check.js'], '函数目录三件套');
    // 依赖闭包：入口 require 同目录核心
    const entrySrc = fs.readFileSync(path.join(fnDir, 'index.js'), 'utf8');
    assert.ok(entrySrc.includes("require('./participant-identity-check')"), '入口引用同目录核心');
    assert.ok(entrySrc.includes("cloud.database({ throwOnNotFound: false })"), '入口以 throwOnNotFound:false 构造');
    // 与既有业务布局同构（静态对照）
    const bizFnDir = path.join(ROOT, 'miniapp', 'cloudfunctions', 'scheduleSandbox');
    assert.equal(fs.existsSync(path.join(bizFnDir, 'index.js')) && fs.existsSync(path.join(bizFnDir, 'package.json')), true,
      '既有业务函数目录同构（子目录名=函数名）');
    // 映射声明（离线可证部分）
    return {
      serverRootChildren: children,
      functionName: core.FIXED_TARGET.functionName,
      fnDirFiles: fnFiles,
      entryRequiresLocalCore: true,
      entryThrowOnNotFoundFalse: true,
      isomorphicWithBusinessLayout: true,
      mappingStatement: '候选 server/scheduleSandbox/ → 既有同名远端函数 scheduleSandbox（cloudfunctionRoot=server/；子目录名=函数名为微信云开发固定约定，与 miniapp/cloudfunctions/scheduleSandbox/ 同构）',
      uploadBoundary: '实际上传/远端回读未验证（禁止联网与部署）——部署映射到此为止，需执行包以真实工具落实并回读确认'
    };
  });

  // ── K6：配对关闭包映射缺口（如实阻断，不改业务打包器） ──
  await probe('K6_close_package_mapping_gap_blocked', async () => {
    assert.ok(closeSource, '关闭来源须已构建');
    const closeServer = path.join(closeSource, 'close', 'server');
    const entries = fs.readdirSync(closeServer).sort();
    // 业务关闭包 close/server/ 直接根（无 scheduleSandbox 子目录）
    assert.ok(entries.includes('index.js') && !fs.existsSync(path.join(closeServer, 'scheduleSandbox')),
      '业务关闭包 close/server/ 为直接根布局（映射缺口事实）');
    const closeCfg = JSON.parse(fs.readFileSync(path.join(closeSource, 'close', 'project.config.json'), 'utf8'));
    assert.equal(closeCfg.cloudfunctionRoot, 'server/', '关闭包配置指向 server/ 根');
    return {
      gap: '业务关闭包 close/server/ 为直接根布局（index.js/gate.js/vendor 等直接在根下，无 scheduleSandbox 子目录），与同名函数约定不符——用与候选相同的方法无法可靠映射到既有 scheduleSandbox',
      blocked: true,
      reason: '业务打包器 package-business-test.cjs 与其关闭装配属受保护范围（P/E/X 包不重开），本轮不得修改',
      closeServerEntries: entries.slice(0, 8),
      closeCloudfunctionRoot: closeCfg.cloudfunctionRoot,
      nextStep: '关闭包布局适配须另立定点任务修改业务打包器 close 装配（close/server/scheduleSandbox/），经自测与 Codex 复核后随执行包冻结'
    };
  });

  // ── K7：回归守卫（只读/零写/漂移拒绝不回归） ──
  await probe('K7_no_regression_guards', async () => {
    // 漂移拒绝（核心字节注入）
    const corePath = path.join(ROOT, 'miniapp', 'scripts', 'lib', 'participant-identity-check.cjs');
    const realRead = fs.readFileSync;
    const original = realRead.call(fs, corePath);
    const drifted = Buffer.concat([original, Buffer.from('\n// synthetic drift\n')]);
    fs.readFileSync = function (p, ...args) {
      if (typeof p === 'string' && path.resolve(p) === corePath) {
        return typeof args[0] === 'string' ? drifted.toString(args[0]) : drifted;
      }
      return realRead.call(this, p, ...args);
    };
    const plan = writeJson(WORK, 'identity-plan2.json', {
      schema: packer.PLAN_SCHEMA, synthetic: true, checkRoundId: 'wb-sdk-d-' + RUN.slice(0, 10),
      participantCode: '1', appId: APPID, envId: ENV_ID,
      functionName: core.FIXED_TARGET.functionName, collection: core.FIXED_TARGET.collection,
      passphraseDigest: sha('synthetic-wb-pass-' + RUN),
      windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 600000).toISOString(),
      closeSourceDir: closeSource
    });
    const driftOut = outDirFor('drift');
    let buildErr = null;
    try { packer.build(plan, driftOut); } catch (e) { buildErr = e; } finally { fs.readFileSync = realRead; }
    assert.ok(buildErr && buildErr.code === packer.ERR.SOURCE_DRIFT, '漂移须写前拒绝');
    assert.equal(fs.existsSync(driftOut), false, '漂移零产物');
    // 候选/关闭非法输入零写与独立检查（既有行为抽测）
    assert.equal(business.checkCloseDir(closeSource).ok, true, '关闭来源复查');
    return { driftRejectedBeforeWrite: true, closeSourceCheckOk: true, diskSourceUnchanged: sha(fs.readFileSync(corePath)) === sha(original) };
  });

  assert.equal(guardHits.length, sensitivityHits, '业务期不得尝试网络或子进程（含被 catch 者）');
  return {
    schema: 'wb-participant-identity-sdk-mapping-evidence/1',
    reviewedCommit: '34b5003',
    reviewBasis: 'Codex执行包-参与者I1I2本人只读核验准备-20261015.md §2（SDK 本地转换与云函数部署映射两个未闭合前置）；本轮以运行时内容摘要定位受测实现',
    implementationSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
    packerSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    verificationKind: '本地合成验证：真实 SDK 依赖树源码与真实数据库实现代码（仅传输层本地替身）+ 实际生成制品静态核对；真实 2.6.3 精确转换、真实上传部署、远端回读完全未验证',
    sdkVersionBoundary: {
      declared: '~2.6.3',
      locallyVerified: sdkVersion,
      locallyVerifiedPath: path.join(SDK_BASE, 'wx-server-sdk'),
      preciseVersionVerifiableOffline: false,
      note: 'npm 本地缓存无 2.6.3 tarball，不联网安装；CHANGELOG 证明 2.6.3→3.0.1 无数据库 API 行为变更，精确行为仍须部署前以真实环境只读复核'
    },
    deploymentMappingBoundary: {
      candidateProven: 'server/scheduleSandbox/ 子目录布局（离线静态可证，约定一致）',
      closePackageBlocked: '业务关闭包 close/server/ 直接根布局存在同样映射缺口，属受保护范围本轮不改——列为阻断',
      uploadAndReadback: '未验证（禁止联网与部署）'
    },
    results,
    guardAccounting: {
      sensitivityProbeHits: sensitivityHits,
      businessPeriodUnexpectedAttempts: guardHits.length - sensitivityHits,
      caughtAttemptsCounted: true
    },
    summary: {
      total: results.length,
      assertionsPassed: results.filter(r => r.assertionsPassed).length,
      unexpectedGuardAttempts: guardHits.length - sensitivityHits,
      blockers: ['wx-server-sdk ~2.6.3 精确版本本地转换未验证（本地无该版本依赖，不联网安装）', '配对关闭包同名函数映射缺口（业务打包器受保护，须另立定点任务）', '实际上传部署与远端关闭回读未验证（云端未放行）']
    }
  };
}

main().then(report => {
  const body = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2] === '--out' && process.argv[3] && process.argv.length === 4) {
    fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
    process.stdout.write('WB evidence written\n');
  } else if (process.argv.length === 2) {
    process.stdout.write(body);
  } else {
    throw new Error('usage: node evidence.cjs [--out <new-path>]');
  }
  if (report.summary.assertionsPassed !== report.summary.total ||
      report.summary.unexpectedGuardAttempts !== 0) {
    process.exitCode = 1;
  }
}).catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
}).finally(() => {
  for (const fn of restore.reverse()) fn();
});
