// 受控诊断收尾与分层兼容证据 v5（提前准备分离 C1–C4 收尾轮；由 v4 迁移的新命名脚本，审计引用为 v10；v4 保持上一轮已交付字节，v3/v2 与历史 20261016 脚本保持原字节）。
// 修复后证据；不修改 Codex 历史反例与历史 JSON。
// 依据：docs/Codex复查-受控键诊断C1C4实现-20261016.md §2–§6。stdout 默认；--out wx 独占新建。
// 记录实际计数、正反例、实现摘要与依据；守卫分敏感性探针与业务期意外（含被 catch 者，意外必须为 0）。
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
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
const core = require(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs'));
const packer = require(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'));
const business = require(path.join(root, 'miniapp/scripts/package-business-test.cjs'));
const TEST_ROUND = 'synthetic-rfix-round-' + crypto.randomBytes(3).toString('hex');
const PASSPHRASE = 'synthetic-rfix-passphrase-' + crypto.randomBytes(6).toString('hex');
const DIGEST = sha(PASSPHRASE);

async function main() {
  const probeStart = guardHits.length;
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  const sensitivityAttempts = guardHits.length - probeStart;
  const businessStart = guardHits.length;

  // ── R1：审计退出码（正常对照 / 被 catch 的业务期意外注入 / 来源漂移）────────
  // 指向本轮新命名审计脚本 v10；历史 20261016 审计脚本保留为 347261a 字节，v7/v8/v9 保持各轮已交付字节。
  const auditFile = path.join(root, 'docs', '证据', 'CodeBuddyI1入站审计v10-20261018.cjs');
  const auditSource = fs.readFileSync(auditFile, 'utf8');
  const runAudit = kind => {
    let source = auditSource;
    if (kind === 'caughtAttempt') {
      const anchor = 'const businessStart = guardHits.length;';
      assert.equal(source.split(anchor).length, 2);
      source = source.replace(anchor, anchor + "\ntry { require('node:https').request('https://example.invalid'); } catch (_) {}");
    }
    const processStub = { argv: ['node', auditFile], exitCode: 0 };
    const outputs = [];
    const nativeRequire = createRequire(auditFile);
    const fsProxy = new Proxy(fs, { get(t, key) {
      if (key !== 'readFileSync' || kind !== 'sourceDrift') return t[key];
      return (p, ...args) => {
        const b = t.readFileSync(p, ...args);
        if (path.resolve(String(p)) !== path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs')) return b;
        return Buffer.concat([b, Buffer.from('\n// synthetic drift\n')]);
      };
    }});
    const context = { require: n => (n === 'node:fs' ? fsProxy : nativeRequire(n)),
      __dirname: path.dirname(auditFile), __filename: auditFile, Buffer, process: processStub,
      console: { log: s => outputs.push(s), error() {} } };
    vm.runInNewContext(source, context, { filename: auditFile, timeout: 30000 });
    const out = JSON.parse(outputs[0]);
    return { exitCode: processStub.exitCode, ok: out.ok, businessPhaseGuardAttempts: out.counters.businessPhaseGuardAttempts, sensitivityGuardAttempts: out.counters.sensitivityGuardAttempts, driftHits: out.sourcePins.driftHits };
  };
  const r1 = { baseline: runAudit('baseline'), caughtAttempt: runAudit('caughtAttempt'), sourceDrift: runAudit('sourceDrift') };
  assert.equal(r1.baseline.exitCode, 0); assert.equal(r1.baseline.ok, true);
  assert.equal(r1.baseline.businessPhaseGuardAttempts, 0); assert.equal(r1.baseline.sensitivityGuardAttempts, 2);
  assert.equal(r1.caughtAttempt.businessPhaseGuardAttempts, 1, '被catch的意外记账');
  assert.equal(r1.caughtAttempt.ok, false, '意外>0 成功标记不得为真');
  assert.equal(r1.caughtAttempt.exitCode, 1, '意外>0 非零退出');
  assert.equal(r1.sourceDrift.driftHits, 1); assert.equal(r1.sourceDrift.exitCode, 1);

  // ── R2：诊断构建后/附加前重查窗口（构造前有效、构造后失效）─────────────────
  const r2Cases = [];
  for (const endState of ['unchanged', 'expires', 'NaN', 'throws']) {
    let phase = 0, enumerations = 0, clockReads = 0, dbCalls = 0;
    const checker = core.createIdentityChecker({
      db: { collection() { dbCalls++; throw Error('DB forbidden'); } },
      trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, openid: 'synthetic-rfix-openid' },
      config: { checkRoundId: TEST_ROUND, passphraseDigest: DIGEST, windowStartsAtMs: 1000, windowExpiresAtMs: 2000, keyDiagnostic: true },
      now() { clockReads++; if (!phase || endState === 'unchanged') return 1500; if (endState === 'throws') throw Error('synthetic-clock-unavailable'); return endState === 'NaN' ? NaN : 2000; }
    });
    const event = new Proxy({ action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE, userInfo: {} },
      { ownKeys(t) { if (++enumerations === 2) phase = 1; return Reflect.ownKeys(t); } });
    const result = await checker.handle(event);
    assert.equal(result.code, 'PIC_REQUEST_INVALID'); assert.equal(dbCalls, 0); assert.equal(result.readAttempted, false);
    const diagnosticReturned = !!result.keyDiagnostic;
    assert.equal(diagnosticReturned, endState === 'unchanged', endState + '：仅时钟保持有效时附加');
    r2Cases.push({ endState, clockReads, enumerations, diagnosticReturned, dbCalls, readAttempted: result.readAttempted });
  }

  // ── R3：清单诊断协议/scope 两种模式统一绑定 ────────────────────────────────
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'rfix-' + crypto.randomBytes(6).toString('hex'));
  assert.ok(scratch.startsWith(path.join(root, 'artifacts') + path.sep));
  fs.mkdirSync(scratch, { recursive: true });
  const write = (name, obj) => { const p = path.join(scratch, name); fs.writeFileSync(p, JSON.stringify(obj), { flag: 'wx' }); return p; };
  const round = 'synthetic-rfix-close-src';
  const sourcePlan = write('source-plan.json', { schema: 'business-test-plan/1', window: 'P', synthetic: true, businessRoundId: round, windowNo: 'P-01',
    appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(k => [k, { userId: 'u_' + sha(k).slice(0, 40), source: 'synthetic' }])),
    projectReadyMarker: 'ready-' + round, windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z' });
  const source = business.build('P', sourcePlan, path.join(scratch, 'close-source'));
  const r3 = { modes: {} };
  for (const mode of [false]) {
    const planPath = write('pic-plan-' + (mode ? 'true' : 'false') + '.json', { schema: packer.PLAN_SCHEMA, synthetic: true, checkRoundId: TEST_ROUND,
      participantCode: '1', ...core.FIXED_TARGET, passphraseDigest: DIGEST,
      windowStartsAtIso: '2020-01-01T00:00:00Z', windowExpiresAtIso: '2020-01-01T00:10:00Z', closeSourceDir: source.outDir,
      requestProtocol: packer.REQUEST_PROTOCOL,
      ...(mode ? { keyDiagnostic: true } : {}) });
    const candidate = path.join(path.dirname(scratch), 'participant-identity-rfix-' + (mode ? 't-' : 'f-') + crypto.randomBytes(4).toString('hex'));
    packer.build(planPath, candidate);
    const tamper = patch => {
      const mf = path.join(candidate, 'manifest.json');
      const orig = fs.readFileSync(mf);
      const m = JSON.parse(orig);
      Object.assign(m, patch);
      fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
      const ok = packer.checkDir(candidate).ok;
      fs.writeFileSync(mf, orig);
      return ok;
    };
    const modeResult = { legalControl: packer.checkDir(candidate).ok,
      schemaWrongAccepted: null, scopeWrongAccepted: null, schemaMissingAccepted: null,
      closeCheckIndependentOfCandidateWindow: null };
    modeResult.schemaWrongAccepted = tamper({ keyDiagnosticSchema: 'synthetic-unrelated-protocol' });
    modeResult.scopeWrongAccepted = tamper({ keyDiagnosticScope: 'synthetic-unrelated-scope' });
    modeResult.schemaMissingAccepted = tamper({ keyDiagnosticSchema: undefined });
    assert.equal(modeResult.legalControl, true, mode + ' 合法对照');
    assert.equal(modeResult.schemaWrongAccepted, false, mode + ' 协议错值拒绝');
    assert.equal(modeResult.scopeWrongAccepted, false, mode + ' scope错值拒绝');
    assert.equal(modeResult.schemaMissingAccepted, false, mode + ' 协议缺失拒绝');
    process.env.PIC_CLOSE_SOURCE_DIR = source.outDir;
    try { modeResult.closeCheckIndependentOfCandidateWindow = packer.checkCloseDir(candidate).ok; }
    finally { delete process.env.PIC_CLOSE_SOURCE_DIR; }
    assert.equal(modeResult.closeCheckIndependentOfCandidateWindow, true, mode + ' 关闭检查不依赖候选窗口');
    r3.modes[String(mode)] = modeResult;
    if (mode) r3.candidateTrueDir = candidate;
  }

  // ── R4：客户端严格验证（畸形整份丢弃 / 合法保留）──────────────────────────
  const clientFile = path.join(root, 'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js');
  const base = () => ({ schema: core.KEY_DIAGNOSTIC_SCHEMA, diagnosticScope: core.KEY_DIAGNOSTIC_SCOPE, otherKeyCount: 1,
    otherKeyNameLengthBuckets: { 'len<=4': 1, 'len5-8': 0, 'len9-16': 0, 'len17-32': 0, lenOver32: 0 }, candidateLabels: [], truncated: false });
  const malformedCases = {
    labelsNotArray: d => { d.candidateLabels = 'synthetic-invalid-type'; },
    countBucketMismatch: d => { d.otherKeyCount = 9; },
    illegalLabel: d => { d.candidateLabels = ['SYNTHETIC_UNKNOWN_LABEL']; },
    duplicateLabel: d => { d.candidateLabels = ['CANDIDATE_USERINFO', 'CANDIDATE_USERINFO']; },
    labelOverflow: d => { d.candidateLabels = new Array(9).fill('CANDIDATE_USERINFO'); },
    negativeCount: d => { d.otherKeyCount = -1; },
    nonSafeIntegerCount: d => { d.otherKeyCount = 1.5; },
    missingBucket: d => { delete d.otherKeyNameLengthBuckets['len<=4']; },
    negativeBucket: d => { d.otherKeyNameLengthBuckets['len5-8'] = -1; },
    truncatedNotBoolean: d => { d.truncated = 'no'; },
    wrongSchema: d => { d.schema = 'synthetic-schema'; },
    wrongScope: d => { d.diagnosticScope = 'synthetic-scope'; },
    missingLabels: d => { delete d.candidateLabels; },
    missingCount: d => { delete d.otherKeyCount; }
  };
  const wxStub = { cloud: { _identityCheckEnvInited: true, init() {}, callFunction: async () => ({ result: currentResult }) } };
  let currentResult = null;
  const ctx = { module: { exports: {} }, require: () => ({ checkRoundId: TEST_ROUND }), wx: wxStub };
  vm.runInNewContext(fs.readFileSync(clientFile, 'utf8'), ctx, { filename: clientFile });
  const client = ctx.module.exports;
  const call = async diag => {
    currentResult = { schema: core.RESULT_SCHEMA, checkRoundId: TEST_ROUND, ok: false, identityConfirmed: false,
      registrationState: 'UNKNOWN', recordMatched: null, readAttempted: false, userIdTail: '', code: 'PIC_REQUEST_INVALID', message: '请求含未登记字段。' };
    if (diag !== undefined) currentResult.keyDiagnostic = diag;
    return client.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
  };
  const r4 = { malformedDropped: {}, legalKept: null };
  for (const [name, mutate] of Object.entries(malformedCases)) {
    const d = base();
    mutate(d);
    const r = await call(d);
    r4.malformedDropped[name] = r.keyDiagnostic === undefined;
    assert.equal(r.keyDiagnostic, undefined, name + '：畸形诊断整份丢弃');
    assert.equal(r.code, 'PIC_REQUEST_INVALID', name + '：原失败事实保持');
  }
  const good = await call(base());
  r4.legalKept = good.keyDiagnostic !== undefined;
  assert.equal(r4.legalKept, true, '合法诊断保留');
  // S2：截断契约一致性——当前词表容量 1 < 上限 8，truncated=true 与协议矛盾，整份拒绝
  const r4Truncation = {};
  const truncVariants = {
    emptyLabelsPlusTrue: d => { d.candidateLabels = []; d.truncated = true; },
    singleLabelPlusTrue: d => { d.candidateLabels = ['CANDIDATE_USERINFO']; d.truncated = true; }
  };
  for (const [name, mutate] of Object.entries(truncVariants)) {
    const d = base();
    mutate(d);
    const r = await call(d);
    r4Truncation[name + 'Rejected'] = r.keyDiagnostic === undefined;
    assert.equal(r.keyDiagnostic, undefined, name + '：截断矛盾整份拒绝');
    assert.equal(r.code, 'PIC_REQUEST_INVALID', name + '：原失败事实保持');
  }
  const falseEmpty = await call(base());
  const falseSingle = await call((() => { const d = base(); d.candidateLabels = ['CANDIDATE_USERINFO']; return d; })());
  r4Truncation.falseControlKept = falseEmpty.keyDiagnostic !== undefined && falseSingle.keyDiagnostic !== undefined;
  assert.equal(r4Truncation.falseControlKept, true, 'truncated=false 空标签/单标签合法对照保留');
  r4.truncation = r4Truncation;

  // ── R5（第二候选）：wxCloudApiToken 固定候选识别/泄漏/相似名/getter/生成链 ────
  // 该候选仅为本机 node-sdk 静态锚点（15 码元）提出的待验证假设，不证明手机入站真实键名。
  const r5 = {};
  const r5Checker = core.createIdentityChecker({
    db: { collection() { throw Error('DB forbidden'); } },
    trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, openid: 'synthetic-r5-openid' },
    config: { checkRoundId: TEST_ROUND, passphraseDigest: DIGEST, windowStartsAtMs: 1000, windowExpiresAtMs: 2000, keyDiagnostic: true },
    now: () => 1500
  });
  const r5req = extra => Object.assign({ action: 'inspectSelf', checkRoundId: TEST_ROUND, passphrase: PASSPHRASE }, extra || {});
  const both = await r5Checker.handle(r5req({ userInfo: {}, wxCloudApiToken: {} }));
  r5.bothLabels = JSON.parse(JSON.stringify(both.keyDiagnostic.candidateLabels));
  r5.otherKeyCountBoth = both.keyDiagnostic.otherKeyCount;
  assert.equal(r5.bothLabels.join(','), 'CANDIDATE_USERINFO,CANDIDATE_WX_CLOUD_API_TOKEN', '双候选两标签');
  assert.equal(r5.otherKeyCountBoth, 0, '双候选其它键0');
  assert.equal(JSON.stringify(both).includes('wxCloudApiToken'), false, '原键名不回显');
  const secret = 'synthetic_secret_' + crypto.randomBytes(8).toString('hex');
  const withSecret = await r5Checker.handle(r5req({ userInfo: {}, wxCloudApiToken: {}, [secret]: {} }));
  r5.secretLeaked = JSON.stringify(withSecret).includes(secret);
  r5.secretOtherCount = withSecret.keyDiagnostic.otherKeyCount;
  assert.equal(r5.secretLeaked, false, '秘密键名不回显');
  assert.equal(r5.secretOtherCount, 1, '秘密键计入其它键');
  const similar = await r5Checker.handle(r5req({ WXCloudApiToken: {}, wxcloudapitoken: {}, wxCloudApiTokenX: {}, userInfo: {} }));
  r5.similarMisidentified = JSON.parse(JSON.stringify(similar.keyDiagnostic.candidateLabels)).includes('CANDIDATE_WX_CLOUD_API_TOKEN');
  r5.similarOtherCount = similar.keyDiagnostic.otherKeyCount;
  assert.equal(r5.similarMisidentified, false, '大小写/相似名不误识别');
  assert.equal(r5.similarOtherCount, 3, '相似名按其它键计数');
  let getterHits = 0;
  const getterEvent = r5req({});
  Object.defineProperty(getterEvent, 'wxCloudApiToken', { enumerable: true, get() { getterHits++; throw Error('synthetic-token-read'); } });
  const withGetter = await r5Checker.handle(getterEvent);
  r5.candidateGetterReads = getterHits;
  r5.candidateLabelOnGetter = JSON.parse(JSON.stringify(withGetter.keyDiagnostic.candidateLabels)).join(',');
  assert.equal(getterHits, 0, '候选键值/getter 零访问');
  assert.equal(r5.candidateLabelOnGetter, 'CANDIDATE_WX_CLOUD_API_TOKEN', 'getter 抛错仍仅枚举识别');
  // 实际生成链：独立构建真实模式（synthetic:false、当前窗口）的诊断候选——入口 CONFIG_ENABLED=true
  const r5PlanPath = write('pic-plan-r5.json', { schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: TEST_ROUND,
    participantCode: '1', ...core.FIXED_TARGET, passphraseDigest: DIGEST,
    windowStartsAtIso: new Date(Date.now() - 60000).toISOString(), windowExpiresAtIso: new Date(Date.now() + 600000).toISOString(), closeSourceDir: source.outDir,
    requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false });
  const r5Candidate = path.join(path.dirname(scratch), 'participant-identity-r5diag-' + crypto.randomBytes(4).toString('hex'));
  packer.build(r5PlanPath, r5Candidate);
  assert.equal(packer.checkDir(r5Candidate).ok, true, 'R5 诊断候选重建一致');
  assert.ok(fs.readFileSync(path.join(r5Candidate, 'server', 'scheduleSandbox', 'index.js'), 'utf8').includes('const CONFIG_KEY_DIAGNOSTIC = false;'), 'R5 候选诊断开关为 false（新协议不启用）');
  const serverFile = path.join(r5Candidate, 'server', 'scheduleSandbox', 'index.js');
  const nativeRequireSrv = createRequire(serverFile);
  const dbForbidden = { collection() { throw Error('DB forbidden'); } };
  const wxSdkStubSrv = { init() {}, DYNAMIC_CURRENT_ENV: 'dynamic', getWXContext: () => ({ APPID: core.FIXED_TARGET.appId, OPENID: 'synthetic-r5-openid' }), database: () => dbForbidden };
  const srvModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(serverFile, 'utf8'), {
    require: id => (id === 'wx-server-sdk' ? wxSdkStubSrv : id === './participant-identity-check' ? core : nativeRequireSrv(id)),
    module: srvModule, exports: srvModule.exports, process: { env: { TCB_ENV: core.FIXED_TARGET.envId } }, console
  });
  const cfgCtx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(r5Candidate, 'frontend', 'config', 'cloud.js'), 'utf8'), cfgCtx, { filename: 'cloud.js' });
  const generatedConfig = cfgCtx.module.exports;
  assert.equal(generatedConfig.checkRoundId, TEST_ROUND, '生成配置含本轮轮次');
  const clientGenCtx = { module: { exports: {} }, require: () => generatedConfig,
    wx: { cloud: { _identityCheckEnvInited: false, init() {}, callFunction: async opts => ({ result: await srvModule.exports.main(Object.assign({}, opts.data, { userInfo: {}, wxCloudApiToken: {} })) }) } } };
  vm.runInNewContext(fs.readFileSync(path.join(r5Candidate, 'frontend', 'utils', 'identity-check-client.js'), 'utf8'), clientGenCtx, { filename: 'client.js' });
  const chainResult = await clientGenCtx.module.exports.callIdentityCheck({ action: 'inspectSelf', passphrase: PASSPHRASE });
  // 请求分层协议下：双候选外层键被适配器容忍，请求进入核心（DB 句柄被禁 → 核心只读失败点）
  r5.chainCode = chainResult.code;
  r5.chainReachedCore = r5.chainCode === 'PIC_DB_UNAVAILABLE';
  r5.chainDbForbidden = true;
  assert.equal(r5.chainCode, 'PIC_DB_UNAVAILABLE', '生成链：外层双候选被容忍、请求进入未改核心');
  assert.equal(chainResult.readAttempted, false, 'DB 句柄不可用不计读取尝试');
  assert.equal(JSON.stringify(chainResult).includes('wxCloudApiToken'), false, '生成链不回显原键名');

  // S1：外层守卫计数（探针/业务期意外/总数）与同一实际计数决定的 ok/退出码。
  // 内部审计的预期反例（r1.*）与外层意外分述；不清零、不掩盖外层命中。
  const businessPhaseGuardAttempts = guardHits.length - businessStart;
  const totalGuardAttempts = guardHits.length;
  const guardCounters = { sensitivityAttempts, businessPhaseGuardAttempts, total: totalGuardAttempts };
  const failed = businessPhaseGuardAttempts > 0;
  const result = {
    schema: 'codebuddy-key-diagnostic-rfix-evidence/3',
    observedAt: new Date().toISOString(),
    basisCommit: 'b89be83',
    verificationKind: 'offline fix-proof evidence after R1-R4 + S1/S2 + second fixed candidate; synthetic counterexamples, not platform verification',
    ok: !failed,
    guardCounters,
    implementationSummary: {
      R1: '审计 ok/exit 判定纳入业务期意外守卫（含被 catch 者）；探针单独记账',
      R2: '核心诊断构建后与最终附加前各重查窗口；到期/未开始/NaN/抛错撤销诊断，失败语义与零DB保持',
      R3: 'manifest keyDiagnosticSchema/Scope 对 true/false 两候选统一严格校验；缺失/错值拒绝',
      R4: '客户端严格验证必需字段/标签词表与重复与数量上限/非负安全整数/计数与分桶一致，违约整份丢弃；截断契约一致性已执行校验（S2）：当前词表容量2仍<8，truncated=true矛盾即整份拒绝',
      sizeBoundWording: '序列化<1KB为源码防御检查；固定字段+有限词表+安全整数下合法投影结构上远小于1KB（结构界限）；畸形用例未动态触达该分支（无实际超限用例，不宣称动态覆盖）。实现用字符串长度（UTF-16码元），全ASCII投影下与UTF-8字节数一致',
      R5: '第二固定候选 wxCloudApiToken→CANDIDATE_WX_CLOUD_API_TOKEN（本机 node-sdk 静态锚点假设，非真实键名结论）：双候选两标签/其它0、秘密键名不回显、相似名不误识别、候选getter零访问、实际生成链两标签可见且原键名不外泄'
    },
    r1, r2Cases, r3, r4, r5,
    runtimeDigests: {
      coreSha256: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
      packerSha256: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'))),
      clientSha256: sha(fs.readFileSync(clientFile))
    },
    cloudOperations: 0,
    limitations: [
      'Clock advancement and malformed payloads are synthetic; no platform evidence claimed.',
      'Not a claim that real platform events contain Proxy objects or that real leakage occurred.',
      'The >1KB output branch is a source-level defense; it is structurally unreachable for legal projections and was not dynamically exercised.'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[收尾证据摘要] ok=' + result.ok + ' r1.exit=' + r1.baseline.exitCode + '/' + r1.caughtAttempt.exitCode + '/' + r1.sourceDrift.exitCode + ' r2.撤销反例=3/4 r3.篡改拒绝=6 r4.畸形丢弃=' + Object.keys(r4.malformedDropped).length + ' r4.截断矛盾拒绝=true r5.双标签=' + (r5.bothLabels.length === 2) + '/相似名误识=' + r5.similarMisidentified + '/getter=' + r5.candidateGetterReads + '/生成链进核心=' + r5.chainReachedCore + ' 探针=' + sensitivityAttempts + ' 业务期意外=' + businessPhaseGuardAttempts + '/总=' + totalGuardAttempts + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  if (failed) process.exitCode = 1;
}
main().catch(e => { console.error(e && e.message ? e.message : e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
