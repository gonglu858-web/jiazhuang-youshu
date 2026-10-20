// 手机请求轮次与预览版本证据 v2（R1/R2 返修轮；合成材料；非平台验证、非执行批准）。
// 依据：docs/Codex复查-手机请求轮次与预览版本-20261019.md §2–§4。
// 对 v1 的增补：R1 节——生成客户端/发送前置校验（buildId 缺失/非法、轮次非法、协议/函数非固定值
// 一律在 callFunction 前拒绝：零发送、无 handoffAttempted=true 假事实；合法正向保持）；
// R2 节——checkDir/checkPreparedDir 对前端模板漂移/缺失/读取异常返回结构化失败
// （ok=false/problems 含分类/planChecked=false/准备不升级 executionReady，不抛原始异常、
// 不信任清单自报值）；C1 口径——缺 result 时 transportOutcome=returned 仅表示 SDK Promise
// 兑现，不保证有效服务端结果，页面按失败/未知处理。历史 v1 证据原字节保留。
// stdout 默认；--out wx 独占新建。守卫覆盖初始化与业务阶段：除显式探针外一切命中
//（含被 catch 者）计入意外，经共享辅助模块的真实判定出口决定 ok/exit。
'use strict';
const root = 'C:/Users/30591/Documents/ChatGPT/装修进度验收APP';
const PACKER_CLI = root + '/miniapp/scripts/package-participant-identity-check.cjs';
const SELF = __filename;
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const guardHelper = require(root + '/miniapp/tests/helpers/pic-guard-runner.cjs');

const outIdx = process.argv.indexOf('--out');
const outPath = outIdx !== -1 ? path.resolve(process.argv[outIdx + 1] || '') : null;
const fault = process.env.PIC_PREP_EVIDENCE_FAULT || null; // 变量名与受审 runner 的 extraEnv 白名单一致

const guardHits = [];
let phase = 'unexpected';
const guard = guardHelper.installParentGuards({ hits: guardHits, getPhase: () => phase, allowedScripts: [PACKER_CLI, SELF] });

if (fault === 'earlyRequire') {
  try { require('node:https').request('https://example.invalid'); } catch (_) {}
}

const core = require(root + '/miniapp/scripts/lib/participant-identity-check.cjs');
const packer = require(root + '/miniapp/scripts/package-participant-identity-check.cjs');
const business = require(root + '/miniapp/scripts/package-business-test.cjs');

function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function makeCloseSource() {
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'round2-src-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan.json');
  const round = 'synthetic-round2-src-' + crypto.randomBytes(2).toString('hex');
  if (fault === 'duringCloseSource') {
    try { require('node:https').request('https://example.invalid'); } catch (_) {}
  }
  fs.writeFileSync(planPath, JSON.stringify({ schema: 'business-test-plan/1', window: 'P', synthetic: true, businessRoundId: round, windowNo: 'P-01',
    appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(k => [k, { userId: 'u_' + sha(k).slice(0, 40), source: 'synthetic' }])),
    projectReadyMarker: 'ready-' + round, windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z' }, null, 2));
  return business.build('P', planPath, path.join(scratch, 'close-source')).outDir;
}
async function withClock(now, fn) {
  const orig = Date.now;
  Date.now = typeof now === 'function' ? now : () => now;
  try { return await fn(); } finally { Date.now = orig; }
}

async function main() {
  // 自反例/短流程模式：'normal'=无故障对照；其余为故障注入（独立分组，真实判定出口）。
  if (fault !== null) {
    phase = 'probe';
    assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
    assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
    phase = 'unexpected';
    if (fault === 'duringCloseSource') { makeCloseSource(); }
    if (fault === 'businessHit') { try { require('node:https').request('https://example.invalid'); } catch (_) {} }
    if (fault === 'nonWhitelistSpawn') { try { require('node:child_process').execSync('echo synthetic-non-whitelist'); } catch (_) {} }
    if (fault === 'publicSpawnBypass') { try { require('node:child_process').spawn(PACKER_CLI, ['--check-prepared', root]); } catch (_) {} }
    const counters = { probes: guardHits.filter(h => h.phase === 'probe').length, parentUnexpected: guardHits.filter(h => h.phase !== 'probe').length, childUnexpectedTotal: 0, receiptFailures: 0 };
    const verdict = guardHelper.verdictFor(counters);
    console.log(JSON.stringify({ schema: 'codebuddy-i1-round-preview-evidence-v2-selftest/1', faultMode: fault, guardCounters: counters, verdict }, null, 2));
    process.exitCode = verdict.exitCode;
    return;
  }

  // ── 显式探针 ─────────────────────────────────────────────────────────────
  phase = 'probe';
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  phase = 'unexpected';

  const closeSource = makeCloseSource();
  const openid = 'synthetic-round-openid';
  const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);
  const roundId = 'synthetic-round-evidence';
  const PASSPHRASE = 'synthetic-round-passphrase';
  const starts = Date.now() - 60 * 1000;
  const mkPlan = round => {
    const p = path.join(root, 'artifacts/schedule-sandbox/business-test', 'round2-plan-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(p, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: round, participantCode: '1',
      ...core.FIXED_TARGET, passphraseDigest: sha(PASSPHRASE), windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 29 * 60 * 1000).toISOString(), closeSourceDir: closeSource,
      requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
    return p;
  };

  // ── A：确定性标识（v1 同口径回归）─────────────────────────────────────────
  const planA = mkPlan(roundId);
  const dirA1 = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round2-a1-' + crypto.randomBytes(3).toString('hex'));
  const b1 = packer.build(planA, dirA1);
  const b2 = packer.build(planA, path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round2-a2-' + crypto.randomBytes(3).toString('hex')));
  const prepA = packer.prepare(planA, path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round2-aprep-' + crypto.randomBytes(3).toString('hex')));
  const idA = b1.manifest.previewBuildId;
  const sectionA = {
    idFormatOk: /^[0-9a-f]{64}$/.test(idA),
    sameBuild: b2.manifest.previewBuildId === idA,
    samePrepare: prepA.manifest.previewBuildId === idA,
    configInjected: fs.readFileSync(path.join(dirA1, 'frontend', 'config', 'cloud.js'), 'utf8').includes("previewBuildId: '" + idA + "'"),
    roundSensitive: packer.computePreviewBuildId(JSON.parse(fs.readFileSync(mkPlan('synthetic-round-evidence-b'), 'utf8'))) !== idA
  };
  assert.equal(sectionA.idFormatOk, true); assert.equal(sectionA.sameBuild, true);
  assert.equal(sectionA.samePrepare, true); assert.equal(sectionA.configInjected, true);
  assert.equal(sectionA.roundSensitive, true);

  // ── B：生成链三栏与 payload（v1 同口径回归）──────────────────────────────
  const outDir = dirA1;
  const sent = [];
  const counters = { factory: 0, collections: [], gets: 0 };
  const db = { collection(name) { counters.collections.push(name); if (name !== core.FIXED_TARGET.collection) throw Error('TRAP 集合'); return { doc(id) { if (id !== userId) throw Error('TRAP 主键'); return { async get() { counters.gets++; throw Error('unprojected get'); }, field(f) { return { async get() { counters.gets++; return { data: { _id: userId, openid, status: 'active' } }; } }; } }; } }; } };
  const srvMain = (() => {
    const mainMod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(outDir, 'server', 'scheduleSandbox', 'index.js'), 'utf8'), {
      require: name => (name === 'wx-server-sdk'
        ? { DYNAMIC_CURRENT_ENV: 'd', init() {}, getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: openid }), database: () => { counters.factory++; return db; } }
        : name === './participant-identity-check' ? core : name === './request-adapter' ? require(root + '/miniapp/scripts/templates/participant-identity-check/server/request-adapter.js') : (() => { throw Error('req ' + name); })()),
      module: mainMod, exports: mainMod.exports, process: { env: { TCB_ENV: core.FIXED_TARGET.envId } }, console
    });
    return mainMod.exports.main;
  })();
  const sectionB = {};
  {
    const loadFrontModule = rel => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(outDir, rel), 'utf8'), { module: m, exports: m.exports }, { filename: rel }); return m.exports; };
    const cfgObj = loadFrontModule(path.join('frontend', 'config', 'cloud.js'));
    const clientWx = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async opts => { sent.push({ type: 'callFunction', data: opts.data }); return { result: await srvMain(opts.data) }; } } };
    const clientObj = (() => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(outDir, 'frontend', 'utils', 'identity-check-client.js'), 'utf8'), { module: m, exports: m.exports, require: () => cfgObj, wx: clientWx }, { filename: 'client.js' }); return m.exports; })();
    const pageMod = { pageDef: null };
    vm.runInNewContext(fs.readFileSync(path.join(outDir, 'frontend', 'pages', 'identity-check', 'identity-check.js'), 'utf8'), {
      Page(d) { pageMod.pageDef = d; },
      require: name => (name === '../../utils/identity-check-client' ? clientObj : name === '../../config/cloud' ? cfgObj : (() => { throw Error('req ' + name); })()),
      wx: clientWx
    }, { filename: 'page.js' });
    const page = Object.assign({ data: {}, setData(patch) { Object.assign(this.data, patch); } }, pageMod.pageDef);
    page.onLoad();
    if (page.onShow) page.onShow();
    sectionB.zeroSendOnLoad = sent.length === 0;
    sectionB.previewBuildIdVisible = page.data.previewBuildId === idA;
    sectionB.configRoundVisible = page.data.configCheckRoundId === roundId;
    page.onPassphraseInput({ detail: { value: PASSPHRASE } });
    await page.onCheckTap();
    sectionB.oneSend = sent.filter(x => x.type === 'callFunction').length === 1;
    const payload = sent[0] && sent[0].data;
    sectionB.capturedRoundEqualsPayload = Boolean(payload) && payload.picRequest.checkRoundId === page.data.localRequestRound;
    sectionB.payloadOuterKeys = Object.keys(payload).join(',');
    sectionB.payloadInnerKeys = Object.keys(payload.picRequest).sort().join(',');
    sectionB.chainActive = Boolean(page.data.result) && page.data.result.registrationState === 'ACTIVE';
    assert.equal(sectionB.zeroSendOnLoad, true); assert.equal(sectionB.previewBuildIdVisible, true);
    assert.equal(sectionB.configRoundVisible, true); assert.equal(sectionB.oneSend, true);
    assert.equal(sectionB.capturedRoundEqualsPayload, true);
    assert.equal(sectionB.payloadOuterKeys, 'picRequest');
    assert.equal(sectionB.payloadInnerKeys, 'action,checkRoundId,passphrase,schema');
    assert.equal(sectionB.chainActive, true);
  }

  // ── R1：生成客户端/页面发送前置校验（本轮新增核心节）─────────────────────
  const sectionR1 = {};
  {
    const loadGeneratedConfig = dir => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dir, 'frontend', 'config', 'cloud.js'), 'utf8'), { module: m, exports: m.exports }, { filename: 'cloud.js' }); return m.exports; };
    const mkClient = (dir, configOverrides, wxStub) => {
      const cfg = Object.assign(loadGeneratedConfig(dir), configOverrides || {});
      const ctx = { module: { exports: {} }, require: name => { if (name === '../config/cloud') return cfg; throw Error('unexpected require ' + name); }, wx: wxStub };
      vm.runInNewContext(fs.readFileSync(path.join(dir, 'frontend', 'utils', 'identity-check-client.js'), 'utf8'), ctx, { filename: 'client.js' });
      return ctx.module.exports;
    };
    const activeResult = { ok: true, registrationState: 'ACTIVE', code: null, readAttempted: true, userId };
    const mkSendStub = sends => ({ cloud: { _identityCheckEnvInited: true, init() {}, callFunction(opts) { sends.push(opts); return Promise.resolve({ result: activeResult }); } } });
    const rejectCases = [
      { why: '缺失 buildId', override: { previewBuildId: '' } },
      { why: '非法 buildId', override: { previewBuildId: 'not-a-hash' } },
      { why: '非法轮次', override: { checkRoundId: 'x' } },
      { why: '错误协议（payload 与配置一致但均非固定值）', override: { requestProtocol: 'unapproved-protocol/9' } },
      { why: '错误函数', override: { identityCheckFunction: 'unapprovedFunction' } }
    ];
    sectionR1.rejects = [];
    for (const c of rejectCases) {
      const sends = [];
      const client = mkClient(outDir, c.override, mkSendStub(sends));
      await assert.rejects(client.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE }), /本机核验参数校验未通过/, c.why + ' 必须调用前拒绝');
      sectionR1.rejects.push({ why: c.why, sends: sends.length });
      assert.equal(sends.length, 0, c.why + '：零 callFunction（无 handoffAttempted=true 假事实）');
    }
    // C1 口径：缺 result 时 returned 仅表示 SDK Promise 兑现 + response=null
    {
      const sends = [];
      const client = mkClient(outDir, null, { cloud: { _identityCheckEnvInited: true, init() {}, callFunction(opts) { sends.push(opts); return Promise.resolve({}); } } });
      const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
      sectionR1.c1MissingResult = { transportOutcome: envelope.transportOutcome, responseNull: envelope.response === null, sends: sends.length };
      assert.equal(sectionR1.c1MissingResult.transportOutcome, 'returned', 'C1：缺 result 仍为 returned（仅 SDK Promise 兑现）');
      assert.equal(sectionR1.c1MissingResult.responseNull, true, 'C1：无有效服务端结果时 response=null');
    }
    // 合法正向：ACTIVE 保持
    {
      const sends = [];
      const client = mkClient(outDir, null, mkSendStub(sends));
      const envelope = await client.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
      sectionR1.legalForward = { sends: sends.length, state: envelope.response.registrationState };
      assert.equal(sectionR1.legalForward.sends, 1);
      assert.equal(sectionR1.legalForward.state, 'ACTIVE');
    }
    // 页面级：无效配置生成包副本 → 前置拒绝 → 零发送、失败未知、口令清除、无自动重试
    {
      const badDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round2-h6bad-' + crypto.randomBytes(3).toString('hex'));
      fs.cpSync(outDir, badDir, { recursive: true });
      const cfgPath = path.join(badDir, 'frontend', 'config', 'cloud.js');
      fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(/checkRoundId: '[^']*'/, "checkRoundId: 'x'"));
      let pageSends = 0;
      const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction(opts) { pageSends++; return Promise.resolve({ result: activeResult }); } } };
      const loadPage = dir => {
        const pageMod = { pageDef: null };
        const cfgObj = loadGeneratedConfig(dir);
        const clientObj = (() => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dir, 'frontend', 'utils', 'identity-check-client.js'), 'utf8'), { module: m, exports: m.exports, require: () => cfgObj, wx: wxStub }, { filename: 'client.js' }); return m.exports; })();
        vm.runInNewContext(fs.readFileSync(path.join(dir, 'frontend', 'pages', 'identity-check', 'identity-check.js'), 'utf8'), {
          Page(d) { pageMod.pageDef = d; },
          require: name => (name === '../../utils/identity-check-client' ? clientObj : name === '../../config/cloud' ? cfgObj : (() => { throw Error('req ' + name); })()),
          wx: wxStub
        }, { filename: 'page.js' });
        return Object.assign({ data: {}, setData(patch) { Object.assign(this.data, patch); } }, pageMod.pageDef);
      };
      const page = loadPage(badDir);
      page.onLoad();
      page.onPassphraseInput({ detail: { value: PASSPHRASE } });
      await page.onCheckTap();
      sectionR1.pageReject = { sends: pageSends, passphraseCleared: page.data.passphrase === '', resultNull: page.data.result === null, failureUnknownHint: Boolean(page.data.stopHint) && page.data.stopHint.includes('未完成') };
      assert.equal(sectionR1.pageReject.sends, 0, '页面级前置拒绝：零发送');
      assert.equal(sectionR1.pageReject.passphraseCleared, true, '口令清除');
      assert.equal(sectionR1.pageReject.resultNull, true);
      assert.equal(sectionR1.pageReject.failureUnknownHint, true, '失败未知文案');
      await page.onCheckTap();
      sectionR1.pageReject.noAutoRetry = pageSends === 0 && page.data.passphrase === '';
      assert.equal(sectionR1.pageReject.noAutoRetry, true, '无自动重试');
    }
  }

  // ── R2：检查器来源漂移结构化失败（本轮新增核心节）────────────────────────
  const sectionR2 = {};
  {
    const withTemplateRead = (fn, mode) => {
      const orig = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        const s = String(p);
        if (s.includes('participant-identity-check') && s.includes('frontend')) {
          if (mode === 'drift') return Buffer.concat([orig.call(fs, p, ...rest), Buffer.from('\n// synthetic-source-drift\n')]);
          if (mode === 'missing') { const e = new Error('ENOENT: no such file or directory, open ' + s); e.code = 'ENOENT'; throw e; }
          if (mode === 'readError') { const e = new Error('EACCES: permission denied, open ' + s); e.code = 'EACCES'; throw e; }
        }
        return orig.call(fs, p, ...rest);
      };
      try { return fn(); } finally { fs.readFileSync = orig; }
    };
    const manifestSelfReport = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).previewBuildId;
    sectionR2.manifestSelfReportValid = /^[0-9a-f]{64}$/.test(manifestSelfReport);
    assert.equal(sectionR2.manifestSelfReportValid, true, '清单自报值本身合法（漂移时仍被拒绝=不信任自报值）');
    sectionR2.cases = [];
    for (const [name, mode, classification] of [['前端模板漂移', 'drift', 'SOURCE_DRIFT'], ['前端模板缺失', 'missing', 'ENOENT'], ['前端模板读取异常', 'readError', 'EACCES']]) {
      const record = withTemplateRead(() => {
        const r1 = packer.checkDir(outDir); // 不抛：结构化失败
        const r2 = packer.checkPreparedDir(outDir);
        return {
          checkDirOkFalse: r1.ok === false,
          problemClassified: r1.problems.some(p => p.includes('预览版本标识重建失败') && p.includes(classification)),
          planCheckedFalse: r1.planChecked === false,
          preparedOkFalse: r2.ok === false,
          preparedExecutionReadyFalse: r2.executionReady === false && r2.phase === 'preparation',
          preparedPlanCheckedFalse: r2.planChecked === false
        };
      }, mode);
      sectionR2.cases.push(Object.assign({ name }, record));
      assert.equal(record.checkDirOkFalse, true, name + '：checkDir ok=false');
      assert.equal(record.problemClassified, true, name + '：问题含重建失败分类');
      assert.equal(record.planCheckedFalse, true, name + '：planChecked=false');
      assert.equal(record.preparedOkFalse, true, name + '：checkPreparedDir ok=false');
      assert.equal(record.preparedExecutionReadyFalse, true, name + '：准备不升级 executionReady');
      assert.equal(record.preparedPlanCheckedFalse, true);
    }
    // 合法对照与关闭独立检查
    const ok1 = packer.checkDir(outDir);
    const ok2 = packer.checkPreparedDir(outDir);
    sectionR2.legalControl = { checkDirOk: ok1.ok, preparedOk: ok2.ok, executionReady: ok2.executionReady };
    assert.equal(sectionR2.legalControl.checkDirOk, true);
    assert.equal(sectionR2.legalControl.preparedOk, true);
    assert.equal(sectionR2.legalControl.executionReady, false);
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    try {
      const closeResult = packer.checkCloseDir(outDir);
      sectionR2.closeIndependent = { ok: closeResult.ok, files: closeResult.files };
      assert.equal(sectionR2.closeIndependent.ok, true);
      assert.equal(sectionR2.closeIndependent.files, 23);
    } finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
  }

  // ── C/D/E（v1 同口径回归；E 增加 C1 缺 result 用例）──────────────────────
  const roundOld = 'synthetic-round-evidence-old';
  const oldDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round2-old-' + crypto.randomBytes(3).toString('hex'));
  packer.build(mkPlan(roundOld), oldDir);
  const loadGeneratedConfig = dir => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dir, 'frontend', 'config', 'cloud.js'), 'utf8'), { module: m, exports: m.exports }, { filename: 'cloud.js' }); return m.exports; };
  const oldConfig = loadGeneratedConfig(oldDir);
  const mkTemplateClient = (cfg, wxStub) => { const ctx = { module: { exports: {} }, require: () => cfg, wx: wxStub }; vm.runInNewContext(fs.readFileSync(path.join(outDir, 'frontend', 'utils', 'identity-check-client.js'), 'utf8'), ctx, { filename: 'client.js' }); return ctx.module.exports; };
  const sectionC = {};
  {
    const oldClient = mkTemplateClient(oldConfig, { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async opts => ({ result: await srvMain(opts.data) }) } });
    counters.factory = 0; counters.collections = []; counters.gets = 0;
    const envelopeOld = await oldClient.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
    sectionC.localRound = envelopeOld.localRequestEvidence.requestRoundId;
    sectionC.serverCode = envelopeOld.response.code;
    sectionC.serverState = envelopeOld.response.registrationState;
    sectionC.serverReadAttempted = envelopeOld.response.readAttempted;
    sectionC.factory = counters.factory; sectionC.collections = counters.collections.length; sectionC.gets = counters.gets;
    assert.equal(sectionC.localRound, roundOld); assert.equal(sectionC.serverCode, 'PIC_ROUND_MISMATCH');
    assert.equal(sectionC.serverState, 'UNKNOWN'); assert.equal(sectionC.serverReadAttempted, false);
    assert.equal(sectionC.factory, 1); assert.equal(sectionC.collections, 0); assert.equal(sectionC.gets, 0);
  }
  const sectionD = {};
  {
    const forged = { checkRoundId: '<script>alert(1)</script>', ok: false, code: 'PIC_ROUND_MISMATCH', registrationState: 'UNKNOWN', readAttempted: false,
      localRequestEvidence: { schema: 'participant-identity-local-request/1', requestRoundId: 'forged-server-round', handoffAttempted: true },
      previewBuildId: 'f'.repeat(64), serverSecret: 'synthetic-server-secret-value' };
    const clientD = mkTemplateClient(oldConfig, { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async () => ({ result: forged }) } });
    const envelopeD = await clientD.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
    sectionD.evidenceNotOverwritten = envelopeD.localRequestEvidence.requestRoundId === roundOld && envelopeD.localRequestEvidence.previewBuildId !== 'f'.repeat(64);
    sectionD.forgedNotInEvidence = !JSON.stringify(envelopeD.localRequestEvidence).includes('forged-server-round') && !JSON.stringify(envelopeD.localRequestEvidence).includes('synthetic-server-secret-value');
    const before = JSON.stringify(envelopeD.localRequestEvidence);
    oldConfig.checkRoundId = 'synthetic-round-changed-after';
    sectionD.immutableAfterConfigChange = JSON.stringify(envelopeD.localRequestEvidence) === before;
    assert.equal(sectionD.evidenceNotOverwritten, true); assert.equal(sectionD.forgedNotInEvidence, true);
    assert.equal(sectionD.immutableAfterConfigChange, true);
  }
  const sectionE = {};
  {
    const clientSync = mkTemplateClient(oldConfig, { cloud: { _identityCheckEnvInited: true, init() {}, callFunction() { throw new Error('synthetic-sync-throw'); } } });
    const envSync = await clientSync.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
    sectionE.syncThrow = { transportOutcome: envSync.transportOutcome, handoffAttempted: Boolean(envSync.localRequestEvidence && envSync.localRequestEvidence.handoffAttempted), noRawError: !JSON.stringify(envSync).includes('synthetic-sync-throw') };
    assert.equal(sectionE.syncThrow.transportOutcome, 'failed');
    assert.equal(sectionE.syncThrow.handoffAttempted, true);
    assert.equal(sectionE.syncThrow.noRawError, true);
  }

  // ── F：关闭包独立检查（v1 同口径回归）────────────────────────────────────
  const sectionF = { wrongRoundStillRejected: sectionC.serverCode === 'PIC_ROUND_MISMATCH' };
  {
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    try {
      const closeResult = packer.checkCloseDir(dirA1);
      sectionF.closeIndependentOk = closeResult.ok;
      sectionF.closeFiles = closeResult.files;
    } finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
    assert.equal(sectionF.closeIndependentOk, true);
    assert.equal(sectionF.closeFiles, 23);
  }

  // ── G：CLI 子进程（受审私有 runner + 回执核验；v1 同口径回归）──────────────
  const guardPreload = path.join(root, 'artifacts/schedule-sandbox/business-test', 'round2-cli-guard-' + crypto.randomBytes(3).toString('hex') + '.cjs');
  fs.writeFileSync(guardPreload, guardHelper.buildGuardPreloadSource(), { flag: 'wx' });
  const runCli = (args, group) => guard.runCli({ scriptPath: PACKER_CLI, args, guardPreload, receiptPath: guard.newReceiptPath('round2'), group: group || 'normal' });
  const sectionG = {};
  {
    const preparedCliDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round2-cli-' + crypto.randomBytes(3).toString('hex'));
    const p1 = await runCli(['--prepare', planA, '--out', preparedCliDir]);
    sectionG.prepare = { code: p1.code, executionReady: JSON.parse(p1.out).executionReady, childUnexpected: p1.validation.childUnexpected, receiptFailures: p1.validation.failures.length };
    assert.equal(sectionG.prepare.code, 0); assert.equal(sectionG.prepare.executionReady, false);
    assert.equal(sectionG.prepare.childUnexpected, 0); assert.equal(sectionG.prepare.receiptFailures, 0);
    const p2 = await runCli(['--prepare', planA, '--out', '']);
    sectionG.emptyOut = { code: p2.code, usageError: p2.err.includes('[用法错误]'), childUnexpected: p2.validation.childUnexpected, receiptFailures: p2.validation.failures.length };
    assert.equal(sectionG.emptyOut.code, 1); assert.equal(sectionG.emptyOut.usageError, true);
    assert.equal(sectionG.emptyOut.childUnexpected, 0);
    const tamperedDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round2-tamper-' + crypto.randomBytes(3).toString('hex'));
    fs.cpSync(dirA1, tamperedDir, { recursive: true });
    fs.appendFileSync(path.join(tamperedDir, 'server', 'scheduleSandbox', 'index.js'), '\n// tampered\n');
    const p4 = await runCli(['--check', tamperedDir]);
    sectionG.expectedExit1ReceiptChecked = { code: p4.code, receiptOk: p4.validation.failures.length === 0 && p4.receipt !== null };
    assert.equal(sectionG.expectedExit1ReceiptChecked.code, 1);
    assert.equal(sectionG.expectedExit1ReceiptChecked.receiptOk, true);
  }

  // ── S：敏感性自反例（独立分组；真实判定出口）─────────────────────────────
  const runSelf = faultMode2 => guard.runCli({ scriptPath: SELF, args: [], guardPreload, receiptPath: guard.newReceiptPath('round2-self'), group: 'sensitivity', extraEnv: faultMode2 ? { PIC_PREP_EVIDENCE_FAULT: faultMode2 } : {} });
  const sectionS = {};
  {
    const normal = await runSelf('normal');
    const normalJ = JSON.parse(normal.out);
    sectionS.normal = { code: normal.code, verdictExitCode: normalJ.verdict.exitCode, probes: normalJ.guardCounters.probes, parentUnexpected: normalJ.guardCounters.parentUnexpected };
    assert.equal(sectionS.normal.code, 0); assert.equal(sectionS.normal.verdictExitCode, 0);
    assert.equal(sectionS.normal.probes, 2); assert.equal(sectionS.normal.parentUnexpected, 0);
    for (const faultName of ['earlyRequire', 'duringCloseSource', 'businessHit', 'nonWhitelistSpawn', 'publicSpawnBypass']) {
      const r = await runSelf(faultName);
      const j = JSON.parse(r.out);
      const v = guardHelper.verdictFor({ probes: j.guardCounters.probes, parentUnexpected: j.guardCounters.parentUnexpected, childUnexpectedTotal: 0, receiptFailures: 0 });
      sectionS[faultName] = { code: r.code, parentUnexpected: j.guardCounters.parentUnexpected, verdictExitCode: v.exitCode };
      assert.equal(r.code, 1, faultName + '：exit1');
      assert.equal(j.guardCounters.parentUnexpected, 1, faultName + '：意外恰 1');
      assert.equal(v.exitCode, 1, faultName + '：真实判定出口 exit1');
    }
  }

  // ── 汇总与真实判定出口 ────────────────────────────────────────────────────
  const normalSummary = guard.summary('normal');
  const sensitivitySummary = guard.summary('sensitivity');
  const actualCounters = {
    probes: guardHits.filter(h => h.phase === 'probe').length,
    parentUnexpected: guardHits.filter(h => h.phase !== 'probe').length,
    childUnexpectedTotal: normalSummary.childUnexpectedTotal,
    receiptFailures: normalSummary.receiptFailures
  };
  const verdict = guardHelper.verdictFor(actualCounters);
  const result = {
    schema: 'codebuddy-i1-round-preview-evidence/2',
    observedAt: new Date().toISOString(),
    basisCommit: 'a32ebdd',
    reviewBasis: 'docs/Codex复查-手机请求轮次与预览版本-20261019.md §2–§4（R1/R2 返修 + C1 口径）',
    verificationKind: 'offline evidence; synthetic plans/clocks/transport stubs; NOT platform verification, NOT an execution approval',
    ok: verdict.ok,
    guardCounters: Object.assign({}, actualCounters, { total: actualCounters.probes + actualCounters.parentUnexpected }),
    verdict,
    sections: { a: sectionA, b: sectionB, r1: sectionR1, r2: sectionR2, c: sectionC, d: sectionD, e: sectionE, f: sectionF, g: sectionG, selfFaults: sectionS },
    runtimeDigests: {
      packerSha256: sha(fs.readFileSync(root + '/miniapp/scripts/package-participant-identity-check.cjs')),
      coreSha256Unchanged: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-identity-check.cjs'))
    },
    evidenceKinds: {
      sourceObservation: 'client pre-send validation (R1) and controlled checker failure exits (R2) read from product source',
      syntheticChain: 'sections A–F use synthetic plans/windows/passphrases and synthetic wx/db',
      localCli: 'section G spawns only whitelisted scripts via the shared helper runner with child guard preload and receipts',
      selfFaults: 'self-run fault modes with independent accounting through the real verdict exit',
      c1Semantics: "transportOutcome='returned' means the SDK promise fulfilled only; a null result is still shown as failure/unknown by the page",
      platform: 'none — whether the SDK actually delivered the request to the server remains unverified; previewBuildId is a local audited-package identifier, not a WeChat platform build id'
    },
    cloudOperations: 0,
    limitations: [
      'No new network payload fields; previewBuildId/localRequestEvidence never enter the network payload.',
      'handoffAttempted only means the program reached the SDK call; not proof of network delivery.',
      'Pre-send rejection (R1) means this round was NOT consumed; it is a local failure, not a server verdict.'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[手机轮次与预览版本证据v2摘要] ok=' + verdict.ok + ' A.确定性 B.三栏+payload R1.前置拒绝5类+C1口径+页面级 R2.结构化失败3类+合法对照+关闭23 C.旧前端拒绝 D.伪造不采信 E.失败保留事实 F/G/S.回归+自反例5类 计数：探针=' + actualCounters.probes + ' 父意外=' + actualCounters.parentUnexpected + ' normal子意外合计=' + actualCounters.childUnexpectedTotal + ' normal回执失败=' + actualCounters.receiptFailures + ' 敏感性组=' + JSON.stringify(sensitivitySummary) + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  process.exitCode = verdict.exitCode;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => guard.restoreAll());
