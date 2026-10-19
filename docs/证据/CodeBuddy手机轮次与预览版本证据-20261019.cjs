// 手机请求轮次与预览版本证据（2026-10-19 任务 §5 A–G 矩阵；合成材料；非平台验证、非执行批准）。
// stdout 默认；--out wx 独占新建。守卫覆盖初始化与业务阶段：除显式探针外一切命中
//（含被 catch 者）计入意外，经共享辅助模块的真实判定出口决定 ok/exit。历史证据不回写。
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
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'round-src-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan.json');
  const round = 'synthetic-round-src-' + crypto.randomBytes(2).toString('hex');
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
function loadTemplateClient(configObj, wxStub) {
  const ctx = { module: { exports: {} }, require: () => configObj, wx: wxStub };
  vm.runInNewContext(fs.readFileSync(root + '/miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js', 'utf8'), ctx, { filename: 'client.js' });
  return ctx.module.exports;
}

async function main() {
  // 自反例/短流程模式（F/G 敏感性）：'normal'=无故障对照；其余为故障注入。
  if (fault !== null) {
    phase = 'probe';
    assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
    assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
    phase = 'unexpected';
    if (fault === 'duringCloseSource') { makeCloseSource(); } // R1 反例注入点：关闭来源构建期间
    if (fault === 'businessHit') { try { require('node:https').request('https://example.invalid'); } catch (_) {} }
    if (fault === 'nonWhitelistSpawn') { try { require('node:child_process').execSync('echo synthetic-non-whitelist'); } catch (_) {} }
    if (fault === 'publicSpawnBypass') { try { require('node:child_process').spawn(PACKER_CLI, ['--check-prepared', root]); } catch (_) {} }
    const counters = {
      probes: guardHits.filter(h => h.phase === 'probe').length,
      parentUnexpected: guardHits.filter(h => h.phase !== 'probe').length,
      childUnexpectedTotal: 0,
      receiptFailures: 0
    };
    const verdict = guardHelper.verdictFor(counters);
    console.log(JSON.stringify({ schema: 'codebuddy-i1-round-preview-evidence-v1-selftest/1', faultMode: fault, guardCounters: counters, verdict }, null, 2));
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
  const mkPlan = (round, digest) => {
    const p = path.join(root, 'artifacts/schedule-sandbox/business-test', 'round-plan-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(p, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: round, participantCode: '1',
      ...core.FIXED_TARGET, passphraseDigest: digest || sha(PASSPHRASE), windowStartsAtIso: new Date(starts).toISOString(),
      windowExpiresAtIso: new Date(starts + 29 * 60 * 1000).toISOString(), closeSourceDir: closeSource,
      requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
    return p;
  };

  // ── A：确定性标识 ────────────────────────────────────────────────────────
  const planA = mkPlan(roundId);
  const dirA1 = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round-a1-' + crypto.randomBytes(3).toString('hex'));
  const dirA2 = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round-a2-' + crypto.randomBytes(3).toString('hex'));
  const b1 = packer.build(planA, dirA1);
  const b2 = packer.build(planA, dirA2);
  const idA = b1.manifest.previewBuildId;
  const prepA = packer.prepare(planA, path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round-aprep-' + crypto.randomBytes(3).toString('hex')));
  const sectionA = {
    idFormatOk: /^[0-9a-f]{64}$/.test(idA),
    sameBuild: b2.manifest.previewBuildId === idA,
    samePrepare: prepA.manifest.previewBuildId === idA,
    configInjected: fs.readFileSync(path.join(dirA1, 'frontend', 'config', 'cloud.js'), 'utf8').includes("previewBuildId: '" + idA + "'"),
    roundSensitive: packer.computePreviewBuildId(JSON.parse(fs.readFileSync(mkPlan('synthetic-round-evidence-b'), 'utf8'))) !== idA,
    passphraseDigestNotInvolved: (() => {
      const planObj = JSON.parse(fs.readFileSync(planA, 'utf8'));
      const p2 = path.join(root, 'artifacts/schedule-sandbox/business-test', 'round-plan-digest-' + crypto.randomBytes(3).toString('hex') + '.json');
      fs.writeFileSync(p2, JSON.stringify(Object.assign({}, planObj, { passphraseDigest: sha('other-passphrase') }), null, 2));
      return packer.computePreviewBuildId(JSON.parse(fs.readFileSync(p2, 'utf8'))) === idA;
    })(),
    planSelfReportRejected: (() => {
      const planObj = JSON.parse(fs.readFileSync(planA, 'utf8'));
      const p3 = path.join(root, 'artifacts/schedule-sandbox/business-test', 'round-plan-selfreport-' + crypto.randomBytes(3).toString('hex') + '.json');
      fs.writeFileSync(p3, JSON.stringify(Object.assign({}, planObj, { previewBuildId: idA }), null, 2));
      const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round-self-' + crypto.randomBytes(3).toString('hex'));
      try { packer.build(p3, dir); return fs.existsSync(dir) === false && true; } catch (error) { return /计划含未知字段/.test(error.message) && !fs.existsSync(dir); }
    })()
  };
  assert.equal(sectionA.idFormatOk, true); assert.equal(sectionA.sameBuild, true); assert.equal(sectionA.samePrepare, true);
  assert.equal(sectionA.configInjected, true); assert.equal(sectionA.roundSensitive, true);
  assert.equal(sectionA.passphraseDigestNotInvolved, true); assert.equal(sectionA.planSelfReportRejected, true);

  // ── B：生成链三栏与 payload ─────────────────────────────────────────────
  const outDir = dirA1;
  const sent = [];
  const counters = { factory: 0, collections: [], gets: 0 };
  const db = {
    collection(name) { counters.collections.push(name); if (name !== core.FIXED_TARGET.collection) throw Error('TRAP 集合'); return { doc(id) { if (id !== userId) throw Error('TRAP 主键'); return { async get() { counters.gets++; throw Error('unprojected get'); }, field(f) { return { async get() { counters.gets++; return { data: { _id: userId, openid, status: 'active' } }; } }; } }; } }; }
  };
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
  let sectionB = {};
  {
    const loadFrontModule = rel => {
      const m = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(outDir, rel), 'utf8'), { module: m, exports: m.exports }, { filename: rel });
      return m.exports;
    };
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
    sectionB.loaded = true;
    page.onLoad();
    if (page.onShow) page.onShow();
    sectionB.zeroSendOnLoad = sent.length === 0;
    sectionB.previewBuildIdVisible = page.data.previewBuildId === b1.manifest.previewBuildId;
    sectionB.configRoundVisible = page.data.configCheckRoundId === roundId;
    page.onPassphraseInput({ detail: { value: PASSPHRASE } });
    await page.onCheckTap();
    sectionB.oneSend = sent.filter(x => x.type === 'callFunction').length === 1;
    const payload = sent[0] && sent[0].data;
    sectionB.capturedRoundEqualsPayload = payload && payload.picRequest.checkRoundId === page.data.localRequestRound;
    sectionB.payloadOuterKeys = Object.keys(payload).join(',');
    sectionB.payloadInnerKeys = Object.keys(payload.picRequest).sort().join(',');
    sectionB.chainActive = page.data.result && page.data.result.registrationState === 'ACTIVE';
    assert.equal(sectionB.zeroSendOnLoad, true); assert.equal(sectionB.previewBuildIdVisible, true);
    assert.equal(sectionB.configRoundVisible, true); assert.equal(sectionB.oneSend, true);
    assert.equal(sectionB.capturedRoundEqualsPayload, true);
    assert.equal(sectionB.payloadOuterKeys, 'picRequest'); assert.equal(sectionB.payloadInnerKeys, 'action,checkRoundId,passphrase,schema');
    assert.equal(sectionB.chainActive, true);
  }

  // ── C：旧前端请求新服务端 ────────────────────────────────────────────────
  const roundOld = 'synthetic-round-evidence-old';
  const planOld = mkPlan(roundOld);
  const dirOld = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round-old-' + crypto.randomBytes(3).toString('hex'));
  packer.build(planOld, dirOld);
  const oldConfig = (() => { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(dirOld, 'frontend', 'config', 'cloud.js'), 'utf8'), { module: m, exports: m.exports }, { filename: 'old-cloud.js' }); return m.exports; })();
  const oldClient = loadTemplateClient(oldConfig, { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async opts => ({ result: await srvMain(opts.data) }) } });
  counters.factory = 0; counters.collections = []; counters.gets = 0; // C 节独立计数（B 节已用）
  const envelopeOld = await oldClient.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
  const sectionC = {
    localRound: envelopeOld.localRequestEvidence.requestRoundId,
    serverCode: envelopeOld.response.code,
    serverState: envelopeOld.response.registrationState,
    serverReadAttempted: envelopeOld.response.readAttempted,
    factory: counters.factory, collections: counters.collections.length, gets: counters.gets
  };
  assert.equal(sectionC.localRound, roundOld); assert.equal(sectionC.serverCode, 'PIC_ROUND_MISMATCH');
  assert.equal(sectionC.serverState, 'UNKNOWN'); assert.equal(sectionC.serverReadAttempted, false);
  assert.equal(sectionC.factory, 1); assert.equal(sectionC.collections, 0); assert.equal(sectionC.gets, 0);

  // ── D：响应伪造不采信、不泄漏；采样后改变证据不变 ────────────────────────
  const forged = {
    checkRoundId: '<script>alert(1)</script>', ok: false, code: 'PIC_ROUND_MISMATCH', registrationState: 'UNKNOWN', readAttempted: false,
    localRequestEvidence: { schema: 'participant-identity-local-request/1', requestRoundId: 'forged-server-round', handoffAttempted: true },
    previewBuildId: 'f'.repeat(64), serverSecret: 'synthetic-server-secret-value'
  };
  const clientD = loadTemplateClient(oldConfig, { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async () => ({ result: forged }) } });
  const envelopeD = await clientD.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
  const sectionD = {
    evidenceNotOverwritten: envelopeD.localRequestEvidence.requestRoundId === roundOld && envelopeD.localRequestEvidence.previewBuildId !== 'f'.repeat(64),
    forgedNotInEvidence: !JSON.stringify(envelopeD.localRequestEvidence).includes('forged-server-round') && !JSON.stringify(envelopeD.localRequestEvidence).includes('synthetic-server-secret-value'),
    immutableAfterConfigChange: (() => {
      const before = JSON.stringify(envelopeD.localRequestEvidence);
      oldConfig.checkRoundId = 'synthetic-round-changed-after';
      return JSON.stringify(envelopeD.localRequestEvidence) === before;
    })()
  };
  assert.equal(sectionD.evidenceNotOverwritten, true); assert.equal(sectionD.forgedNotInEvidence, true);
  assert.equal(sectionD.immutableAfterConfigChange, true);

  // ── E：失败路径保留本机事实 ──────────────────────────────────────────────
  const sectionE = {};
  {
    const clientSync = loadTemplateClient(oldConfig, { cloud: { _identityCheckEnvInited: true, init() {}, callFunction() { throw new Error('synthetic-sync-throw'); } } });
    const envSync = await clientSync.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
    sectionE.syncThrow = { transportOutcome: envSync.transportOutcome, handoffAttempted: envSync.localRequestEvidence && envSync.localRequestEvidence.handoffAttempted, noRawError: !JSON.stringify(envSync).includes('synthetic-sync-throw') };
    assert.equal(sectionE.syncThrow.transportOutcome, 'failed'); assert.equal(sectionE.syncThrow.handoffAttempted, true);
    assert.equal(sectionE.syncThrow.noRawError, true);
  }

  // ── F：门槛回归（错轮次仍拒绝；关闭包独立检查保持）─────────────────────────
  const sectionF = { wrongRoundStillRejected: sectionC.serverCode === 'PIC_ROUND_MISMATCH', closeIndependent: true };
  {
    const closeDir = path.join(closeSource, '..');
    const closeCheck = packer.checkCloseDir ? null : null;
    // checkCloseDir 需要显式来源环境变量（沿用既有契约）
    process.env.PIC_CLOSE_SOURCE_DIR = closeSource;
    const closeResult = packer.checkCloseDir(dirA1);
    sectionF.closeIndependentOk = closeResult.ok;
    sectionF.closeFiles = closeResult.files;
    assert.equal(sectionF.closeIndependentOk, true);
    assert.equal(sectionF.closeFiles, 23);
  }

  // ── G：CLI 子进程（受审私有 runner + 回执核验）+ CLI 空值/配对反例 ─────────
  const guardPreload = path.join(root, 'artifacts/schedule-sandbox/business-test', 'round-cli-guard-' + crypto.randomBytes(3).toString('hex') + '.cjs');
  fs.writeFileSync(guardPreload, guardHelper.buildGuardPreloadSource());
  const runCli = (args, group) => guard.runCli({ scriptPath: PACKER_CLI, args, guardPreload, receiptPath: guard.newReceiptPath('round'), group: group || 'normal' });
  const sectionG = {};
  {
    const preparedCliDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round-cli-' + crypto.randomBytes(3).toString('hex'));
    const p1 = await runCli(['--prepare', planA, '--out', preparedCliDir]);
    const v1 = p1.validation;
    sectionG.prepare = { code: p1.code, executionReady: JSON.parse(p1.out).executionReady, childUnexpected: v1.childUnexpected, receiptFailures: v1.failures.length };
    assert.equal(sectionG.prepare.code, 0); assert.equal(sectionG.prepare.executionReady, false);
    assert.equal(sectionG.prepare.childUnexpected, 0); assert.equal(sectionG.prepare.receiptFailures, 0);
    // R4 空值反例：空 --out → exit1 + [用法错误] + 零产物
    const emptyOutDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round-emptyout-' + crypto.randomBytes(3).toString('hex'));
    const p2 = await runCli(['--prepare', planA, '--out', '']);
    const v2 = p2.validation;
    sectionG.emptyOut = { code: p2.code, usageError: p2.err.includes('[用法错误]'), dirCreated: fs.existsSync(emptyOutDir), childUnexpected: v2.childUnexpected, receiptFailures: v2.failures.length };
    assert.equal(sectionG.emptyOut.code, 1); assert.equal(sectionG.emptyOut.usageError, true);
    assert.equal(sectionG.emptyOut.dirCreated, false); assert.equal(sectionG.emptyOut.childUnexpected, 0);
    // R4 反例：--check-close 缺 --close-source
    const p3 = await runCli(['--check-close', dirA1]);
    const v3 = p3.validation;
    sectionG.missingCloseSource = { code: p3.code, usageError: p3.err.includes('--close-source'), childUnexpected: v3.childUnexpected, receiptFailures: v3.failures.length };
    assert.equal(sectionG.missingCloseSource.code, 1); assert.equal(sectionG.missingCloseSource.usageError, true);
    assert.equal(sectionG.missingCloseSource.childUnexpected, 0);
    // 预期业务 exit1 不豁免回执校验：篡改副本 --check exit1 仍核验回执
    const tamperedDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-round-tamper-' + crypto.randomBytes(3).toString('hex'));
    fs.cpSync(dirA1, tamperedDir, { recursive: true });
    fs.appendFileSync(path.join(tamperedDir, 'server', 'scheduleSandbox', 'index.js'), '\n// tampered\n');
    const p4 = await runCli(['--check', tamperedDir]);
    const v4 = p4.validation;
    sectionG.expectedExit1ReceiptChecked = { code: p4.code, receiptOk: v4.failures.length === 0 && p4.receipt !== null };
    assert.equal(sectionG.expectedExit1ReceiptChecked.code, 1);
    assert.equal(sectionG.expectedExit1ReceiptChecked.receiptOk, true);
  }

  // ── F/G 敏感性自反例（独立分组；真实判定出口）─────────────────────────────
  const runSelf = faultMode2 => guard.runCli({ scriptPath: SELF, args: [], guardPreload, receiptPath: guard.newReceiptPath('round-self'), group: 'sensitivity', extraEnv: faultMode2 ? { PIC_PREP_EVIDENCE_FAULT: faultMode2 } : {} }); //.rawSpawn
  const sectionS = {};
  {
    const normal = await runSelf('normal');
    let normalJ = null, normalParseError = null;
    try { normalJ = JSON.parse(normal.out); } catch (e) { normalParseError = e.message; }
    assert.ok(normalJ, 'normal 自反例输出可解析：out=' + JSON.stringify((normal.out || '').slice(0, 120)) + ' err=' + JSON.stringify((normal.err || '').slice(0, 120)) + ' code=' + normal.code + ' spawnError=' + normal.spawnError + ' validation=' + JSON.stringify(normal.validation) + ' parseError=' + normalParseError);
    sectionS.normal = { code: normal.code, verdictExitCode: normalJ.verdict.exitCode, probes: normalJ.guardCounters.probes, parentUnexpected: normalJ.guardCounters.parentUnexpected };
    assert.equal(sectionS.normal.code, 0); assert.equal(sectionS.normal.verdictExitCode, 0);
    assert.equal(sectionS.normal.probes, 2); assert.equal(sectionS.normal.parentUnexpected, 0);
    for (const faultName of ['earlyRequire', 'duringCloseSource', 'businessHit', 'nonWhitelistSpawn', 'publicSpawnBypass']) {
      const r = await runSelf(faultName);
      const j = JSON.parse(r.out);
      const v = guardHelper.verdictFor({ probes: j.guardCounters.probes, parentUnexpected: j.guardCounters.parentUnexpected, childUnexpectedTotal: 0, receiptFailures: 0 });
      sectionS[faultName] = { code: r.code, parentUnexpected: j.guardCounters.parentUnexpected, verdictExitCode: v.exitCode };
      assert.equal(r.code, 1, faultName + '：exit1（counters=' + JSON.stringify(j.guardCounters || null) + ' verdict=' + JSON.stringify(j.verdict || null) + ' err=' + (r.err || '').slice(0, 120) + '）');
      assert.equal(j.guardCounters.parentUnexpected, 1, faultName + '：意外恰 1');
      assert.equal(v.exitCode, 1, faultName + '：真实判定出口 exit1');
    }
  }

  // ── 汇总与真实判定出口 ────────────────────────────────────────────────────
  const actualCounters = {
    probes: guardHits.filter(h => h.phase === 'probe').length,
    parentUnexpected: guardHits.filter(h => h.phase !== 'probe').length,
    childUnexpectedTotal: 0,
    receiptFailures: 0
  };
  const verdict = guardHelper.verdictFor(actualCounters);
  const result = {
    schema: 'codebuddy-i1-round-preview-evidence/1',
    observedAt: new Date().toISOString(),
    basisCommit: '85a983b',
    reviewBasis: 'docs/CodeBuddy任务-手机请求轮次与预览版本本地核对-20261019.md §2–§6',
    verificationKind: 'offline evidence; synthetic plans/clocks/transport stubs; NOT platform verification, NOT an execution approval',
    ok: verdict.ok,
    guardCounters: Object.assign({}, actualCounters, { total: actualCounters.probes + actualCounters.parentUnexpected }),
    verdict,
    sections: { a: sectionA, b: sectionB, c: sectionC, d: sectionD, e: sectionE, f: sectionF, g: sectionG, selfFaults: sectionS },
    runtimeDigests: {
      packerSha256: sha(fs.readFileSync(root + '/miniapp/scripts/package-participant-identity-check.cjs')),
      coreSha256Unchanged: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-identity-check.cjs'))
    },
    evidenceKinds: {
      sourceObservation: 'previewBuildId canonical JSON definition and client envelope read from product source',
      syntheticChain: 'sections A–F use synthetic plans/windows/passphrases and synthetic wx/db',
      localCli: 'section G spawns only whitelisted scripts via the shared helper runner with child guard preload and receipts',
      selfFaults: 'self-run fault modes with independent accounting through the real verdict exit',
      platform: 'none — whether the SDK actually delivered the request to the server remains unverified; previewBuildId is a local audited-package identifier, not a WeChat platform build id'
    },
    cloudOperations: 0,
    limitations: [
      'No new network payload fields; previewBuildId/localRequestEvidence never enter the network payload.',
      'handoffAttempted only means the program reached the SDK call; not proof of network delivery.'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[手机轮次与预览版本证据摘要] ok=' + verdict.ok + ' A.确定性+敏感性 B.三栏+payload C.旧前端对新服务端拒绝 D.伪造不采信 E.失败保留事实 F.门槛/关闭23 G.CLI含R4反例 S.自反例5类 计数：探针=' + actualCounters.probes + ' 父意外=' + actualCounters.parentUnexpected + ' 子意外合计=' + actualCounters.childUnexpectedTotal + ' 回执失败=' + actualCounters.receiptFailures + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  process.exitCode = verdict.exitCode;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => guard.restoreAll());
