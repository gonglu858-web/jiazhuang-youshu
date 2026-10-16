// R1–R4 收尾证明（修复后证据；不修改 Codex 历史反例与历史 JSON）。
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
  const auditFile = path.join(root, 'docs', '证据', 'CodeBuddyI1入站事件封装离线核实-20261016.cjs');
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
  for (const mode of [true, false]) {
    const planPath = write('pic-plan-' + (mode ? 'true' : 'false') + '.json', { schema: packer.PLAN_SCHEMA, synthetic: true, checkRoundId: TEST_ROUND,
      participantCode: '1', ...core.FIXED_TARGET, passphraseDigest: DIGEST,
      windowStartsAtIso: '2020-01-01T00:00:00Z', windowExpiresAtIso: '2020-01-01T00:10:00Z', closeSourceDir: source.outDir,
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

  const result = {
    schema: 'codebuddy-key-diagnostic-rfix-evidence/1',
    observedAt: new Date().toISOString(),
    basisCommit: '880fbf8',
    verificationKind: 'offline fix-proof evidence after R1-R4; synthetic counterexamples, not platform verification',
    implementationSummary: {
      R1: '审计 ok/exit 判定纳入业务期意外守卫（含被 catch 者）；探针单独记账',
      R2: '核心诊断构建后与最终附加前各重查窗口；到期/未开始/NaN/抛错撤销诊断，失败语义与零DB保持',
      R3: 'manifest keyDiagnosticSchema/Scope 对 true/false 两候选统一严格校验；缺失/错值拒绝',
      R4: '客户端严格验证必需字段/标签词表与重复与数量上限/非负安全整数/计数与分桶一致/序列化上限，违约整份丢弃；截断契约=服务端候选标签上限8且有未列出候选'
    },
    r1, r2Cases, r3, r4,
    runtimeDigests: {
      coreSha256: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/lib/participant-identity-check.cjs'))),
      packerSha256: sha(fs.readFileSync(path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs'))),
      clientSha256: sha(fs.readFileSync(clientFile))
    },
    cloudOperations: 0,
    limitations: [
      'Clock advancement and malformed payloads are synthetic; no platform evidence claimed.',
      'Not a claim that real platform events contain Proxy objects or that real leakage occurred.'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[收尾证据摘要] r1.exit=' + r1.baseline.exitCode + '/' + r1.caughtAttempt.exitCode + '/' + r1.sourceDrift.exitCode + ' r2.撤销反例=3/4 r3.篡改拒绝=6 r4.畸形丢弃=' + Object.keys(r4.malformedDropped).length + ' 探针=' + sensitivityAttempts + ' 业务期意外=' + (guardHits.length - businessStart) + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
}
main().catch(e => { console.error(e && e.message ? e.message : e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
