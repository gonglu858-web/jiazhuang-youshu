'use strict';
// WorkBuddy 独立证据：S1 收尾——取消勾选当下立即隐藏旧完整编号（展示时点修复）。
// 走实际生成链（模板→打包器→候选 App/Page/client/server/core + 合成 wx/db），
// 在取消事件后、再次提交前直接断言展示状态与请求次数；不调用真实 SDK 或平台。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

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
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const RUN = crypto.randomUUID();
const WORK = path.join(ROOT, 'artifacts/schedule-sandbox/business-test', 'wb-pic-s1b-' + RUN);
fs.mkdirSync(WORK, { recursive: true });
const OUT_ROOT = path.join(ROOT, 'artifacts/schedule-sandbox/business-test');
let seq = 0;
// 候选输出目录：打包器要求位于 business-test 直接层且以 participant-identity- 为前缀
const outDirFor = tag => path.join(OUT_ROOT, 'participant-identity-wb-s1b-' + tag + '-' + RUN.slice(-8) + '-' + (++seq));
const APPID = core.FIXED_TARGET.appId;
const ENV_ID = core.FIXED_TARGET.envId;
const OPENID = 'synthetic-wb-' + RUN;
const USER_ID = core.deriveUserId(APPID, OPENID);
const PASSPHRASE = 'synthetic-wb-pass-' + RUN;
const ROUND = 'wb-pic-' + RUN.slice(0, 12);
const writeJson = (name, data) => {
  const target = path.join(WORK, name);
  fs.writeFileSync(target, JSON.stringify(data, null, 2), { flag: 'wx' });
  return target;
};
const oldWx = globalThis.wx;
const results = [];

async function probe(id, fn) {
  try {
    const actual = await fn();
    results.push({ id, assertionsPassed: true, actual });
  } catch (error) {
    results.push({ id, assertionsPassed: false, error: error.message });
  }
}

async function main() {
  for (const fn of [
    () => require('node:https').request('https://example.invalid'),
    () => require('node:child_process').spawn('node', [])
  ]) assert.throws(fn, /WB_OFFLINE_GUARD/);
  const sensitivityHits = guardHits.length; // G0 之后的一切命中均计入业务期

  // ── G0：受审关闭包来源（先经未改 checkCloseDir 校验） ──
  await probe('G0_close_source_pinned_check', async () => {
    const businessRoundId = 'synthetic-close-' + RUN.slice(0, 12);
    const users = Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
      userId: 'u_' + sha(APPID + ':synthetic-' + role + RUN).slice(0, 40),
      source: 'synthetic fixture'
    }]));
    const closePlan = writeJson('business-plan.json', {
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId, windowNo: 'P-01', appId: APPID, envId: ENV_ID, users,
      projectReadyMarker: 'ready-' + businessRoundId,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    });
    const closeSource = business.build('P', closePlan, outDirFor('close-source')).outDir;
    assert.equal(business.checkCloseDir(closeSource).ok, true, '关闭包独立校验');
    return { closeCheckOk: true };
  });

  // ── G1：实际生成页面三时点（取消当下/重勾未提交/再提交）──
  const starts = Date.now() - 60000;
  let closeSourceRef = null;
  {
    // 关闭来源重建（G0 内目录不可复用，重新构建一次供 G1–G3 使用）
    const businessRoundId = 'synthetic-close-' + RUN.slice(0, 12);
    const users = Object.fromEntries(['owner', 'manager', 'worker'].map(role => [role, {
      userId: 'u_' + sha(APPID + ':synthetic-' + role + RUN).slice(0, 40),
      source: 'synthetic fixture'
    }]));
    const closePlan = writeJson('business-plan2.json', {
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId, windowNo: 'P-01', appId: APPID, envId: ENV_ID, users,
      projectReadyMarker: 'ready-' + businessRoundId,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    });
    closeSourceRef = business.build('P', closePlan, outDirFor('close-source2')).outDir;
  }
  const identityPlan = writeJson('identity-plan.json', {
    schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: ROUND, participantCode: '1',
    appId: APPID, envId: ENV_ID, functionName: core.FIXED_TARGET.functionName,
    collection: core.FIXED_TARGET.collection, passphraseDigest: sha(PASSPHRASE),
    windowStartsAtIso: new Date(starts).toISOString(),
    windowExpiresAtIso: new Date(starts + 600000).toISOString(),
    closeSourceDir: closeSourceRef, note: 'WorkBuddy S1b synthetic fixture'
  });
  const outDir = outDirFor('candidate');
  packer.build(identityPlan, outDir);
  assert.equal(packer.checkDir(outDir).ok, true, '候选包自校验');

  const pageFile = path.join(outDir, 'frontend/pages/identity-check/identity-check.js');
  // 候选页面字节 = 受审模板字节（模板直出，无锚点改写）
  assert.deepEqual(fs.readFileSync(pageFile),
    fs.readFileSync(path.join(ROOT, 'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js')));

  const dbCalls = { gets: 0, writes: 0, fields: [] };
  const db = {
    collection(name) {
      assert.equal(name, core.FIXED_TARGET.collection);
      return { doc(id) {
        assert.equal(id, USER_ID, '只读本人主键');
        return {
          field(projection) { dbCalls.fields.push({ ...projection }); return this; },
          async get() {
            dbCalls.gets++;
            return { data: [{ _id: USER_ID, openid: OPENID, status: 'active' }] };
          }
        };
      } };
    }
  };
  const serverFile = path.join(outDir, 'server/index.js');
  const serverModule = { exports: {} };
  const nativeServerRequire = createRequire(serverFile);
  const sdk = { DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, getWXContext: () => ({ APPID: APPID, OPENID: OPENID }), database: () => db };
  new vm.Script(fs.readFileSync(serverFile, 'utf8'), { filename: serverFile }).runInContext(
    vm.createContext({
      module: serverModule, exports: serverModule.exports,
      require(id) { return id === 'wx-server-sdk' ? sdk : nativeServerRequire(id); },
      process: { env: { TCB_ENV: ENV_ID } }, console
    })
  );
  const requests = [];
  const wxStub = { cloud: { _identityCheckEnvInited: false, init() {}, callFunction(opts) {
    requests.push(JSON.parse(JSON.stringify(opts.data)));
    return serverModule.exports.main(opts.data).then(result => ({ result }));
  } } };
  globalThis.wx = wxStub;
  try {
    // App 加载零发送
    const appDef = {};
    new vm.Script(fs.readFileSync(path.join(outDir, 'frontend/app.js'), 'utf8')).runInContext(
      vm.createContext({ App(v) { Object.assign(appDef, v); }, wx: wxStub, console })
    );
    appDef.onLaunch();
    assert.equal(requests.length, 0, 'App 加载零发送');
    // 页面装载
    const pageDef = {};
    new vm.Script(fs.readFileSync(pageFile, 'utf8'), { filename: pageFile }).runInContext(
      vm.createContext({ Page(v) { Object.assign(pageDef, v); }, require: createRequire(pageFile), wx: wxStub, console })
    );
    const page = Object.assign({ data: {}, setData(patch) { Object.assign(this.data, patch); } }, pageDef);
    page.onLoad(); page.onShow();
    assert.equal(requests.length, 0, '页面加载零发送');

    await probe('G1_cancel_event_hides_full_id_immediately', async () => {
      // 步骤 1：勾选 + 成功核验 → 显示完整编号
      page.onWantFullIdChange({ detail: { value: ['full'] } });
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].includeFullUserId, true, '勾选请求携带完整 ID 开关');
      assert.equal(page.data.result.userId, USER_ID, '有效核验后显示完整编号');
      assert.equal(page.data.result.fullUserIdAvailable, true);
      // 步骤 2（验收要求 1）：取消当下、下一次提交之前——立即隐藏、保留尾号、零新请求
      page.onWantFullIdChange({ detail: { value: [] } });
      const afterCancel = {
        wantFullUserId: page.data.wantFullUserId,
        fullIdAvailable: page.data.result.fullUserIdAvailable,
        fullIdShown: page.data.result.userId === USER_ID,
        tailShown: page.data.result.userIdTail === USER_ID.slice(-6),
        requestCount: requests.length
      };
      assert.equal(afterCancel.wantFullUserId, false);
      assert.equal(afterCancel.fullIdAvailable, false, '取消当下必须隐藏（Codex C1 缺口反证）');
      assert.equal(afterCancel.fullIdShown, false, '取消当下完整编号必须已清空');
      assert.equal(afterCancel.tailShown, true, '尾号必须保留');
      assert.equal(afterCancel.requestCount, 1, '取消事件不得产生新请求');
      // 步骤 3（验收要求 2）：重勾未提交 → 不恢复旧完整编号
      page.onWantFullIdChange({ detail: { value: ['full'] } });
      const afterRecheck = {
        wantFullUserId: page.data.wantFullUserId,
        fullIdAvailable: page.data.result.fullUserIdAvailable,
        fullIdShown: page.data.result.userId === USER_ID,
        tailShown: page.data.result.userIdTail === USER_ID.slice(-6),
        requestCount: requests.length
      };
      assert.equal(afterRecheck.wantFullUserId, true);
      assert.equal(afterRecheck.fullIdAvailable, false, '重勾未提交不得恢复');
      assert.equal(afterRecheck.fullIdShown, false, '重勾未提交不得恢复旧值');
      assert.equal(afterRecheck.tailShown, true, '尾号保留');
      assert.equal(afterRecheck.requestCount, 1, '重勾本身不得产生新请求');
      return { afterCancel, afterRecheck };
    });

    await probe('G2_resubmit_branches_preserved', async () => {
      // 步骤 4（验收要求 3）：取消状态下再次核验 → 不请求完整编号，只显示尾号
      page.onWantFullIdChange({ detail: { value: [] } });
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(requests.length, 2);
      assert.equal(requests[1].includeFullUserId, undefined, '取消后再次核验不请求完整编号');
      assert.equal(page.data.result.userId, '', '取消后再核验不显示完整编号');
      assert.equal(page.data.result.userIdTail, USER_ID.slice(-6));
      // 步骤 5：重新勾选 + 再次核验 → 新一次有效核验返回后才显示
      page.onWantFullIdChange({ detail: { value: ['full'] } });
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      assert.equal(requests.length, 3);
      assert.equal(requests[2].includeFullUserId, true, '重新勾选后才请求');
      assert.equal(page.data.result.userId, USER_ID, '新一次有效核验返回后显示');
      assert.equal(page.data.result.fullUserIdAvailable, true);
      // 非回归：口令清除、读取次数、零业务写、字段投影
      assert.equal(page.data.passphrase, '', '口令调用后清除');
      assert.equal(dbCalls.gets, 3, '至多一次本人 get（共三次核验）');
      assert.deepEqual(dbCalls.fields[0], { _id: true, openid: true, status: true });
      assert.equal(dbCalls.writes, 0, '零业务写');
      return {
        requests: requests.map(r => ({ includeFullUserId: r.includeFullUserId })),
        fullIdShownAfterResubmit: page.data.result.userId === USER_ID,
        passphraseCleared: page.data.passphrase === '',
        dbGets: dbCalls.gets, dbWrites: dbCalls.writes
      };
    });

    await probe('G3_inflight_lock_and_template_drift', async () => {
      // 在途锁：sending 期间点击不产生新请求
      const before = requests.length;
      page.setData({ sending: true });
      await page.onCheckTap();
      assert.equal(requests.length, before, '在途锁保持');
      page.setData({ sending: false });
      // 模板漂移：内存注入额外字节 → build SOURCE_DRIFT 且零产物
      const templatePath = path.join(ROOT, 'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js');
      const realRead = fs.readFileSync;
      const original = realRead.call(fs, templatePath);
      const drifted = Buffer.concat([original, Buffer.from('\n// synthetic drift\n')]);
      let injected = 0;
      fs.readFileSync = function (p, ...args) {
        if (typeof p === 'string' && path.resolve(p) === templatePath) {
          injected++;
          return typeof args[0] === 'string' ? drifted.toString(args[0]) : drifted;
        }
        return realRead.call(this, p, ...args);
      };
      const driftOut = outDirFor('drift');
      let buildErr = null;
      try { packer.build(identityPlan, driftOut); } catch (e) { buildErr = e; } finally { fs.readFileSync = realRead; }
      assert.ok(injected > 0);
      assert.ok(buildErr, '漂移必须拒绝');
      assert.equal(buildErr.code, packer.ERR.SOURCE_DRIFT, '应为 SOURCE_DRIFT：' + (buildErr && buildErr.code));
      assert.equal(fs.existsSync(driftOut), false, '漂移拒绝必须零产物');
      assert.equal(sha(fs.readFileSync(templatePath)), sha(original), '磁盘模板零改动');
      return { inflightLockKept: true, driftRejected: true, driftCode: buildErr.code, zeroArtifact: true };
    });
  } finally {
    if (oldWx === undefined) delete globalThis.wx; else globalThis.wx = oldWx;
  }

  assert.equal(guardHits.length, sensitivityHits, '业务期不得尝试网络或子进程（含被 catch 者）');
  return {
    schema: 'wb-participant-identity-s1b-evidence/1',
    reviewedCommit: '6b89ea0',
    reviewBasis: 'Codex复查-参与者只读核验包S1S2收尾-20261015.md（复查提交 7d1969f，独立证据 C1 复现取消当下旧完整编号仍显示）；本轮修复以运行时内容摘要精确定位，不以 Codex 旧反例不再复现作为闭合依据',
    implementationSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
    packerSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'))),
    pageTemplateSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js'))),
    verificationKind: '本地合成验证：实际生成的 App/Page/client/server/core + 合成 wx/db；未验证真实 SDK 转换、平台行为、真实1号/2号身份与登记状态、真实部署/传输/费用/日志',
    results,
    guardAccounting: {
      sensitivityProbeHits: sensitivityHits,
      businessPeriodUnexpectedAttempts: guardHits.length - sensitivityHits,
      caughtAttemptsCounted: true,
      note: 'G0 探针实际触发 2 次作为敏感性记账基线；其后一切命中（含被 catch 者）计入业务期意外'
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
