'use strict';
// WorkBuddy 独立证据：I1 候选 SDK 精确版本本地接线（执行页 §2）。
// 生成后的候选入口**直接调用真实 wx-server-sdk 3.0.1** 的 init 与
// database({throwOnNotFound:false})（无入口级替身）；替换范围仅三处：合成微信上下文
// （process.env 原生通道）、node-sdk init 工厂替身、Db.reqClass 传输层本地替身。
// 全程离线、无真实凭据；不是平台验证。
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
const WORK = path.join(OUT_ROOT, 'wb-pic-sdkpin-' + RUN);
fs.mkdirSync(WORK, { recursive: true });
let seq = 0;
const outDirFor = tag => path.join(OUT_ROOT, 'participant-identity-wb-pin-' + tag + '-' + RUN.slice(-8) + '-' + (++seq));
const APPID = core.FIXED_TARGET.appId;
const ENV_ID = core.FIXED_TARGET.envId;
const OPENID = 'synthetic-wxctx-' + RUN;
const USER_ID = core.deriveUserId(APPID, OPENID);
const PASSPHRASE = 'synthetic-wb-pin-pass-' + RUN;
const ROUND = 'wb-pin-' + RUN.slice(0, 12);
const SDK_BASE = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
const writeJson = (dir, name, data) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, JSON.stringify(data, null, 2), { flag: 'wx' });
  return target;
};
const results = [];
async function probe(id, fn) {
  try { results.push({ id, assertionsPassed: true, actual: await fn() }); }
  catch (error) { results.push({ id, assertionsPassed: false, error: error.message }); }
}

async function main() {
  for (const fn of [
    () => require('node:https').request('https://example.invalid'),
    () => require('node:child_process').spawn('node', [])
  ]) assert.throws(fn, /WB_OFFLINE_GUARD/);
  const sensitivityHits = guardHits.length;

  // ── W0：来源与版本事实 ──
  let closeSource = null;
  await probe('W0_source_and_version_facts', async () => {
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
    assert.equal(business.checkCloseDir(closeSource).ok, true);
    // 本机 SDK 副本版本事实（未联网）
    const sdkPkg = JSON.parse(fs.readFileSync(path.join(SDK_BASE, 'wx-server-sdk', 'package.json'), 'utf8'));
    assert.equal(sdkPkg.version, '3.0.1', '本机副本版本');
    const tcbDb = JSON.parse(fs.readFileSync(path.join(SDK_BASE, '@cloudbase/database', 'package.json'), 'utf8'));
    assert.equal(tcbDb.version, '1.4.1');
    // 模板与既有业务声明
    const tmplPkg = JSON.parse(fs.readFileSync(path.join(ROOT,
      'miniapp/scripts/templates/participant-identity-check/server/package.json'), 'utf8'));
    assert.equal(tmplPkg.dependencies['wx-server-sdk'], '3.0.1', '候选模板钉精确 3.0.1');
    assert.equal(packer.PINNED_WX_SERVER_SDK_VERSION, '3.0.1');
    const bizPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniapp/cloudfunctions/scheduleSandbox/package.json'), 'utf8'));
    assert.equal(bizPkg.dependencies['wx-server-sdk'], '3.0.1', '既有业务（关闭来源）已为精确 3.0.1');
    return {
      localSdkVersion: sdkPkg.version,
      localCloudbaseDatabase: tcbDb.version,
      candidateTemplatePinned: tmplPkg.dependencies['wx-server-sdk'],
      closeSourcePinned: bizPkg.dependencies['wx-server-sdk'],
      sourceCheckOk: true
    };
  });

  // ── W1：生成制品版本核对（候选 + 关闭双侧） ──
  let candidateDir = null;
  await probe('W1_generated_artifact_versions', async () => {
    const starts = Date.now() - 60000;
    const planPath = writeJson(WORK, 'identity-plan.json', {
      schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: ROUND, participantCode: '1',
      appId: APPID, envId: ENV_ID, functionName: core.FIXED_TARGET.functionName,
      collection: core.FIXED_TARGET.collection, passphraseDigest: sha(PASSPHRASE),
      windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 600000).toISOString(),
      closeSourceDir: closeSource, note: 'WorkBuddy SDK-pin synthetic fixture'
    });
    candidateDir = outDirFor('candidate');
    packer.build(planPath, candidateDir);
    const check = packer.checkDir(candidateDir);
    assert.equal(check.ok, true, '候选自校验：' + JSON.stringify(check.problems));
    // 候选函数 package.json 精确 3.0.1 + 文件哈希
    const fnPkgPath = path.join(candidateDir, 'server', 'scheduleSandbox', 'package.json');
    const fnPkg = JSON.parse(fs.readFileSync(fnPkgPath, 'utf8'));
    assert.equal(fnPkg.dependencies['wx-server-sdk'], '3.0.1');
    // 配对关闭包（来源逐字节映射）同样 3.0.1
    const closePkgPath = path.join(candidateDir, 'close', 'server', 'scheduleSandbox', 'package.json');
    const closePkg = JSON.parse(fs.readFileSync(closePkgPath, 'utf8'));
    assert.equal(closePkg.dependencies['wx-server-sdk'], '3.0.1');
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    let closeOk = false;
    try { closeOk = packer.checkCloseDir(candidateDir).ok; } finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
    assert.equal(closeOk, true, '关闭独立校验');
    return {
      candidatePackageSha256: sha(fs.readFileSync(fnPkgPath)),
      closePackageSha256: sha(fs.readFileSync(closePkgPath)),
      candidateDeps: fnPkg.dependencies,
      closeDeps: closePkg.dependencies,
      closeCheckOk: true
    };
  });

  // ── W2：生成后候选入口 × 真实 SDK 3.0.1 三路读取（合成上下文 + 本地传输替身） ──
  await probe('W2_generated_entry_with_real_sdk_three_paths', async () => {
    assert.ok(candidateDir, '候选须已生成');
    const serverFile = path.join(candidateDir, 'server', 'scheduleSandbox', 'index.js');
    const nativeRequire = createRequire(serverFile);
    // 0) 先 patch 磁盘依赖包（wx-server-sdk bundle 以外部依赖解析到同一磁盘实例）：
    //    node-sdk init 替换为合成实例（不取凭据、不联网）；数据库传输类替换为本地替身。
    //    替换必须先于 require(wx-server-sdk)/init，否则真实 database() 会重置 reqClass。
    const tcbNodeSdk = require(path.join(SDK_BASE, '@cloudbase', 'node-sdk'));
    const tcbDb = require(path.join(SDK_BASE, '@cloudbase', 'database'));
    const originalTcbInit = tcbNodeSdk.init;
    const originalReqClass = tcbDb.Db.reqClass;
    // node-sdk 的 Cloudbase.prototype.database 每次() 都会把 Db.reqClass 重置为真实
    // DBRequest——patch 原型方法让任何 database() 调用都保持本地传输替身；
    // init 也替换为合成实例（不取凭据、不联网）。
    tcbNodeSdk.init = () => ({
      logger: () => {},
      database: () => new tcbDb.Db({ env: ENV_ID })
    });
    // 1) 真实 SDK（wx-server-sdk 3.0.1 主模块；不改其代码）
    const realSdk = require(path.join(SDK_BASE, 'wx-server-sdk'));
    // 2) 合成微信上下文：走 SDK 原生 getWXContext 的 process.env 注入通道
    const savedEnv = { WX_CONTEXT_KEYS: process.env.WX_CONTEXT_KEYS, WX_APPID: process.env.WX_APPID, WX_OPENID: process.env.WX_OPENID, TCB_ENV: process.env.TCB_ENV };
    process.env.WX_CONTEXT_KEYS = 'WX_APPID,WX_OPENID';
    process.env.WX_APPID = APPID;
    process.env.WX_OPENID = OPENID;
    process.env.TCB_ENV = ENV_ID;
    // 3) 底层传输替身（仅传输；解析/EJSON/投影/包装为真实代码）
    const calls = { sends: [], gets: 0, projections: [] };
    let mode = 'hit'; // hit | miss | denied
    class LocalTransport {
      constructor(config) { this.config = config; }
      async send(action, params) {
        const ejson = require(path.join(SDK_BASE, '@cloudbase/database', 'dist', 'commonjs', 'utils', 'utils.js'));
        calls.sends.push({ action, projection: params.projection ? ejson.parseByEJSON(params.projection) : null });
        if (action !== 'database.getDocument') throw new Error('W2 只允许只读 getDocument');
        calls.gets++;
        const EJSONUtils = require(path.join(SDK_BASE, '@cloudbase/database', 'dist', 'commonjs', 'utils', 'utils.js'));
        if (mode === 'hit') {
          return { data: { list: [EJSONUtils.stringifyByEJSON({ _id: USER_ID, openid: OPENID, status: 'active' })], offset: 0, limit: 1 }, requestId: 'synthetic-hit' };
        }
        if (mode === 'miss') return { data: { list: [], offset: 0, limit: 1 }, requestId: 'synthetic-miss' };
        return { code: 'DATABASE_PERMISSION_DENIED', requestId: 'synthetic-denied' };
      }
    }
    tcbDb.Db.reqClass = LocalTransport; // 替换传输类（先于入口装载；合成实例的 database() 不重置）
    // 入口装载与 main 调用辅助：require('wx-server-sdk') 直达真实 SDK 对象——
    // 入口的 init({env}) 与 database({throwOnNotFound:false}) **原样进入真实 SDK**，
    // 不做任何入口级替身（真实包装层的 throwOnNotFound 语义因此被真实检验）。
    const entrySource = fs.readFileSync(serverFile, 'utf8');
    const loadEntry = (sourceText) => {
      const module_ = { exports: {} };
      const ctx = vm.createContext({
        require(id) {
          if (id === 'wx-server-sdk') return realSdk;
          return nativeRequire(id); // './participant-identity-check' 解析到候选内核心副本
        },
        module: module_, exports: module_.exports,
        cloud: realSdk,
        process: { env: process.env },
        console
      });
      new vm.Script(sourceText, { filename: serverFile }).runInContext(ctx);
      return module_.exports;
    };
    try {
      // 4) 装载生成后的候选入口（未改源码）
      const entry = loadEntry(entrySource);
      assert.equal(typeof entry.main, 'function', '生成入口导出 main');
      // 入口必须显式携带 throwOnNotFound:false（真实包装层默认 true，缺失会让不存在路 reject）
      assert.ok(entrySource.includes('throwOnNotFound: false'), '生成入口须显式传递 throwOnNotFound:false');
      const req = { action: 'inspectSelf', passphrase: PASSPHRASE, checkRoundId: ROUND };
      // 三路：存在 → ACTIVE
      mode = 'hit';
      const hit = await entry.main(req);
      assert.equal(hit.ok, true, '存在路 ok：' + hit.message);
      assert.equal(hit.registrationState, 'ACTIVE');
      assert.equal(hit.identityConfirmed, true);
      assert.equal(hit.userId, null, '默认不交付完整 ID');
      // 明确不存在 → ABSENT（真实 SDK 包装层 data:null → 核心归一化）
      mode = 'miss';
      const miss = await entry.main(req);
      assert.equal(miss.ok, true, '不存在路 ok：' + miss.message);
      assert.equal(miss.registrationState, 'ABSENT');
      // 权限失败 → UNKNOWN（readAttempted 保留）
      mode = 'denied';
      const denied = await entry.main(req);
      assert.equal(denied.ok, false, '失败路不确认身份');
      assert.equal(denied.registrationState, 'UNKNOWN');
      assert.equal(denied.readAttempted, true, 'get 已调用如实记录');
      assert.equal(denied.userId, null, '失败不交付完整 ID');
      assert.equal(JSON.stringify(denied).includes('DATABASE_PERMISSION_DENIED'), false, '平台错误码不外传');
      // 敏感性反例（C1）：内存删除入口的 throwOnNotFound:false 后重新装载——
      // 真实包装层默认 throwOnNotFound=true，「明确不存在」会 reject 而非返回 data:null，
      // 因此不存在路必须失败（UNKNOWN），证明三路对照真实检验了入口参数。
      const tamperedSource = entrySource.replace('throwOnNotFound: false', '');
      assert.notEqual(tamperedSource, entrySource, '敏感性改写须生效');
      const tamperedEntry = loadEntry(tamperedSource);
      mode = 'miss';
      const tamMiss = await tamperedEntry.main(req);
      mode = 'denied'; // 还原供后续计数
      assert.equal(tamMiss.ok, false, '删除 throwOnNotFound:false 后不存在路必须失败');
      assert.equal(tamMiss.registrationState, 'UNKNOWN', '失败归 UNKNOWN');
      assert.equal(tamMiss.readAttempted, true, 'get 已调用如实记录');
      // 投影与读取次数：三次主装载 + 一次敏感性装载，各一次本人主键 get，仅 _id/openid/status
      assert.equal(calls.gets, 4);
      for (const s of calls.sends) {
        assert.equal(s.action, 'database.getDocument');
        assert.ok(s.projection, '投影必须随请求发送');
        assert.deepEqual(Object.keys(s.projection).sort(), ['_id', 'openid', 'status'], '只投影三字段');
      }
      return {
        replacementScope: '替换范围共三处（全部已披露）：①合成微信上下文（process.env 原生通道）②node-sdk init 工厂替身（合成实例，防 reqClass 重置）③Db.reqClass 传输层本地替身。入口的 init({env}) 与 database({throwOnNotFound:false}) **原样进入真实 wx-server-sdk 3.0.1**——无入口级替身；敏感性反例证明删除入口 throwOnNotFound:false 后不存在路必失败',
        hit: { state: hit.registrationState, confirmed: hit.identityConfirmed },
        miss: { state: miss.registrationState },
        denied: { state: denied.registrationState, readAttempted: denied.readAttempted },
        gets: calls.gets,
        projectionKeys: Object.keys(calls.sends[0].projection).sort()
      };
    } finally {
      tcbNodeSdk.init = originalTcbInit;
      tcbDb.Db.reqClass = originalReqClass;
      for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
      }
    }
  });

  assert.equal(guardHits.length, sensitivityHits, '业务期不得尝试网络或子进程（含被 catch 者）');
  return {
    schema: 'wb-participant-identity-sdk-pin-evidence/1',
    reviewedCommit: '0c2eb99',
    reviewedBaseline: '2bd9c9c',
    implementationSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
    packerSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    candidateTemplatePkgSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/templates/participant-identity-check/server/package.json'))),
    verificationKind: '本地合成验证：生成后候选入口直接调用真实 wx-server-sdk 3.0.1 的 init 与 database({throwOnNotFound:false})（无入口级替身）；替换范围仅限已披露三处——合成微信上下文（process.env 原生通道）、node-sdk init 工厂替身、Db.reqClass 传输层本地替身。这不是平台验证：云端自动安装的实际版本、真实上传部署、远端关闭覆盖与回读完全未验证',
    versionBoundary: {
      candidatePinned: packer.PINNED_WX_SERVER_SDK_VERSION,
      locallyVerifiedSdk: '3.0.1',
      previousDeclared: '~2.6.3（已钉定为精确 3.0.1；波浪号范围不能称精确版本）',
      cloudInstallStillUnverified: true,
      deploymentReadbackRequired: 'I1 部署后必须下载实际远端 ZIP 核对最终安装版本与代码'
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
      unexpectedGuardAttempts: guardHits.length - sensitivityHits
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
