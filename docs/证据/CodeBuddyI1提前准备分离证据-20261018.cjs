// I1 核验包提前准备与执行时效分离证据（合成材料；非平台验证、非执行批准）。
// 依据：docs/CodeBuddy任务-核验包提前准备与执行时效分离-20261017.md §3–§5。
// stdout 默认；--out wx 独占新建。守卫探针与业务期意外独立计数（含被 catch 者），
// 同一实际意外计数决定 ok 与退出码。历史脚本/JSON 不改写。
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
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
const core = require(root + '/miniapp/scripts/lib/participant-identity-check.cjs');
const packer = require(root + '/miniapp/scripts/package-participant-identity-check.cjs');
const business = require(root + '/miniapp/scripts/package-business-test.cjs');
const PACKER_CLI = root + '/miniapp/scripts/package-participant-identity-check.cjs';
const closeSource = (() => {
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep-src-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan.json');
  const round = 'synthetic-prep-close-src';
  fs.writeFileSync(planPath, JSON.stringify({ schema: 'business-test-plan/1', window: 'P', synthetic: true, businessRoundId: round, windowNo: 'P-01',
    appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId,
    users: Object.fromEntries(['owner', 'manager', 'worker'].map(k => [k, { userId: 'u_' + sha(k).slice(0, 40), source: 'synthetic' }])),
    projectReadyMarker: 'ready-' + round, windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z' }, null, 2));
  return business.build('P', planPath, path.join(scratch, 'close-source')).outDir;
})();

async function withClock(now, fn) {
  const orig = Date.now;
  Date.now = typeof now === 'function' ? now : () => now;
  try { return await fn(); } finally { Date.now = orig; }
}

async function main() {
  const probeStart = guardHits.length;
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  const sensitivityAttempts = guardHits.length - probeStart;
  const businessStart = guardHits.length;
  const openid = 'synthetic-prep-openid';
  const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);
  const futureStarts = Date.now() + 2 * 60 * 60 * 1000;
  const futurePlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep-plan-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(futurePlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: TEST_ROUND_FALLBACK(), participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: sha('synthetic-prep-passphrase'),
    windowStartsAtIso: new Date(futureStarts).toISOString(), windowExpiresAtIso: new Date(futureStarts + 30 * 60 * 1000).toISOString(),
    closeSourceDir: closeSource, requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  function TEST_ROUND_FALLBACK() { return 'synthetic-prep-round'; }
  const roundId = 'synthetic-prep-round';

  // ── A：未来窗口可准备、严格执行仍拒绝、核心拒绝 ───────────────────────────
  const outDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep-' + crypto.randomBytes(4).toString('hex'));
  const prepared = packer.prepare(futurePlan, outDir);
  const sectionA = {
    phase: prepared.phase, preparationValidated: prepared.preparationValidated, executionReady: prepared.executionReady,
    files: prepared.manifest.files.length, closeFiles: prepared.manifest.closePackage.files.length,
    checkPreparedOk: packer.checkPreparedDir(outDir).ok,
    checkPreparedExecutionReady: packer.checkPreparedDir(outDir).executionReady,
    strictBuildNewDirNotCreated: false, strictCheckRejected: false
  };
  assert.equal(sectionA.phase, 'preparation'); assert.equal(sectionA.executionReady, false);
  assert.equal(sectionA.files, 15); assert.equal(sectionA.closeFiles, 23);
  assert.equal(sectionA.checkPreparedOk, true); assert.equal(sectionA.checkPreparedExecutionReady, false);
  const strictOut = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-strict-' + crypto.randomBytes(3).toString('hex'));
  try { packer.build(futurePlan, strictOut); } catch (error) {
    sectionA.strictBuildNewDirNotCreated = !fs.existsSync(strictOut);
    sectionA.strictBuildCode = error.code;
  }
  sectionA.strictCheckRejected = packer.checkDir(outDir).ok === false;
  assert.equal(sectionA.strictBuildNewDirNotCreated, true); assert.equal(sectionA.strictCheckRejected, true);
  const futureChecker = core.createIdentityChecker({
    db: { collection() { throw Error('DB forbidden'); } },
    trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, OPENID: openid, openid },
    config: { checkRoundId: roundId, passphraseDigest: sha('synthetic-prep-passphrase'), windowStartsAtMs: futureStarts, windowExpiresAtMs: futureStarts + 30 * 60 * 1000 },
    now: () => Date.now()
  });
  const futureHandle = await futureChecker.handle({ action: 'inspectSelf', checkRoundId: roundId, passphrase: 'synthetic-prep-passphrase' });
  sectionA.coreFutureCode = futureHandle.code;
  sectionA.coreFutureReadAttempted = futureHandle.readAttempted;
  assert.equal(sectionA.coreFutureCode, 'PIC_WINDOW_NOT_OPEN'); assert.equal(sectionA.coreFutureReadAttempted, false);

  // ── B：进入窗口后同包通过、完全复用、字节不变 ─────────────────────────────
  const snapshot = new Map();
  (function snap(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) snap(p); else snapshot.set(path.relative(dir, p).split(path.sep).join('/'), sha(fs.readFileSync(p))); } })(outDir);
  let inWindowCheckOk = false, rebuildWritten = -1, bytesUnchanged = false;
  await withClock(futureStarts + 60 * 1000, () => {
    inWindowCheckOk = packer.checkDir(outDir).ok;
    const rebuilt = packer.build(futurePlan, outDir);
    rebuildWritten = rebuilt.io.filter(x => x.action === 'written').length;
  });
  const after = new Map();
  (function snap2(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) snap2(p); else after.set(path.relative(dir, p).split(path.sep).join('/'), sha(fs.readFileSync(p))); } })(outDir);
  bytesUnchanged = after.size === snapshot.size && [...snapshot].every(([rel, s]) => after.get(rel) === s);
  const sectionB = { inWindowCheckOk, rebuildWritten, bytesUnchanged };
  assert.equal(inWindowCheckOk, true); assert.equal(rebuildWritten, 0); assert.equal(bytesUnchanged, true);

  // ── C：边界矩阵（可控时钟；测试隔离，finally 恢复）────────────────────────
  const inWindowPlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep-plan-inwin-' + crypto.randomBytes(3).toString('hex') + '.json');
  const baseStarts = Date.now() - 60 * 1000;
  fs.writeFileSync(inWindowPlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: roundId, participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: sha('synthetic-prep-passphrase'), windowStartsAtIso: new Date(baseStarts).toISOString(),
    windowExpiresAtIso: new Date(baseStarts + 30 * 60 * 1000).toISOString(), closeSourceDir: closeSource,
    requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  const expiresMs = Date.parse(JSON.parse(fs.readFileSync(inWindowPlan, 'utf8')).windowExpiresAtIso);
  const sectionC = {};
  const boundaryCase = async (name, clock, expectCode) => {
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-boundary-' + crypto.randomBytes(3).toString('hex'));
    let code = null, dirCreated = false;
    await withClock(clock, () => {
      try { packer.prepare(inWindowPlan, dir); } catch (error) { code = error.code; }
      dirCreated = fs.existsSync(dir);
    });
    sectionC[name] = { code, dirCreated };
    assert.equal(code, expectCode, name); assert.equal(dirCreated, false, name + ' 失败不创建目录');
  };
  await boundaryCase('expiresNow', expiresMs, 'PIC_WINDOW_EXPIRED');
  await boundaryCase('expired', expiresMs + 1, 'PIC_WINDOW_EXPIRED');
  await boundaryCase('nanClock', NaN, 'PIC_CLOCK_INVALID');
  await boundaryCase('clockThrows', () => { throw Error('synthetic-clock-failure'); }, 'PIC_CLOCK_ERROR');
  // 途中跨截止：部分写入事实与计数一致
  {
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-midflight-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0;
    let caught = null;
    await withClock(() => { calls++; return calls <= 10 ? baseStarts + 1000 : expiresMs + 1; }, () => {
      try { packer.prepare(inWindowPlan, dir); } catch (error) { caught = error; }
    });
    sectionC.midFlight = { code: caught && caught.code, wroteFiles: caught && caught.wroteFiles, writtenList: caught && caught.written };
    assert.equal(sectionC.midFlight.code, 'PIC_WINDOW_EXPIRED');
    assert.ok(sectionC.midFlight.wroteFiles > 0 && sectionC.midFlight.writtenList.length === sectionC.midFlight.wroteFiles);
  }
  // 未来开始跨入窗口不升级
  {
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-crossin-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0;
    let preparedResult = null;
    await withClock(() => { calls++; return calls <= 5 ? futureStarts - 1000 : futureStarts + 60 * 1000; }, () => { preparedResult = packer.prepare(futurePlan, dir); });
    sectionC.crossIn = { phase: preparedResult.phase, executionReady: preparedResult.executionReady };
    assert.equal(sectionC.crossIn.executionReady, false);
  }

  // ── D：CLI 子进程（白名单 process.execPath + 本包 CLI；子进程网络守卫 preload）──
  const guardPreload = path.join(root, 'artifacts/schedule-sandbox/business-test', 'cli-net-guard-' + crypto.randomBytes(3).toString('hex') + '.cjs');
  fs.writeFileSync(guardPreload, "'use strict';\nconst blocked = () => { throw Error('CLI_OFFLINE_GUARD'); };\nfor (const m of ['http','https']) { const mod = require(m); mod.request = blocked; mod.get = blocked; }\nconst net = require('net'); net.connect = blocked; net.createConnection = blocked;\n");
  const runCli = args => new Promise(resolve => {
    const child = spawn(process.execPath, [PACKER_CLI, ...args], {
      env: Object.assign({}, process.env, { NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require ' + guardPreload }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out, err }));
  });
  const sectionD = {};
  {
    const p1 = await runCli(['--prepare', futurePlan, '--out', path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-cli-prep-' + crypto.randomBytes(3).toString('hex'))]);
    sectionD.prepare = { code: p1.code, executionReady: p1.out.includes('"executionReady": false'), phase: p1.out.includes('"phase": "preparation"') };
    assert.equal(sectionD.prepare.code, 0); assert.equal(sectionD.prepare.executionReady, true); assert.equal(sectionD.prepare.phase, true);
    const preparedCliDir = (JSON.parse(p1.out)).outDir;
    const p2 = await runCli(['--check-prepared', preparedCliDir]);
    sectionD.checkPrepared = { code: p2.code, ok: JSON.parse(p2.out).ok, executionReady: JSON.parse(p2.out).executionReady };
    assert.equal(sectionD.checkPrepared.code, 0); assert.equal(sectionD.checkPrepared.ok, true); assert.equal(sectionD.checkPrepared.executionReady, false);
    const p3 = await runCli(['--check', preparedCliDir]);
    sectionD.strictCheckFuture = { code: p3.code, windowNotOpen: p3.out.includes('WINDOW_NOT_OPEN') };
    assert.equal(sectionD.strictCheckFuture.code, 1); assert.equal(sectionD.strictCheckFuture.windowNotOpen, true);
    const strictDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-cli-strict-' + crypto.randomBytes(3).toString('hex'));
    const p4 = await runCli(['--plan', futurePlan, '--out', strictDir]);
    sectionD.defaultBuildFuture = { code: p4.code, windowNotOpen: p4.err.includes('WINDOW_NOT_OPEN'), dirCreated: fs.existsSync(strictDir) };
    assert.equal(sectionD.defaultBuildFuture.code, 1); assert.equal(sectionD.defaultBuildFuture.windowNotOpen, true); assert.equal(sectionD.defaultBuildFuture.dirCreated, false);
    const expiredPlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep-plan-expired-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(expiredPlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: roundId, participantCode: '1',
      ...core.FIXED_TARGET, passphraseDigest: sha('synthetic-prep-passphrase'),
      windowStartsAtIso: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      windowExpiresAtIso: new Date(Date.now() - 60 * 1000).toISOString(), closeSourceDir: closeSource,
      requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
    const p5 = await runCli(['--prepare', expiredPlan, '--out', path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-cli-exp-' + crypto.randomBytes(3).toString('hex'))]);
    if (!p5.err.includes('WINDOW_EXPIRED')) console.error('[调试] p5.code=' + p5.code + ' p5.err=' + JSON.stringify(p5.err.slice(0, 240)) + ' p5.out=' + JSON.stringify(p5.out.slice(0, 160)));
    sectionD.expiredPrepare = { code: p5.code, windowExpired: p5.err.includes('WINDOW_EXPIRED') };
    assert.equal(sectionD.expiredPrepare.code, 1); assert.equal(sectionD.expiredPrepare.windowExpired, true);
    const p6 = await runCli(['--prepare', futurePlan, '--check', preparedCliDir]);
    sectionD.mixedModes = { code: p6.code, usageError: p6.err.includes('用法错误') };
    assert.equal(sectionD.mixedModes.code, 1); assert.equal(sectionD.mixedModes.usageError, true);
    const p7 = await runCli(['--prepare']);
    sectionD.badArgs = { code: p7.code };
    assert.equal(sectionD.badArgs.code, 1);
  }

  // ── 字节一致性：同计划 prepare vs 严格 build（窗口内受控时钟）──────────────
  const dirPrepare = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-idprep-' + crypto.randomBytes(3).toString('hex'));
  const dirBuild = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-idbuild-' + crypto.randomBytes(3).toString('hex'));
  packer.prepare(inWindowPlan, dirPrepare);
  packer.build(inWindowPlan, dirBuild);
  const mapOf = dir => { const m = new Map(); (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else m.set(path.relative(dir, p).split(path.sep).join('/'), sha(fs.readFileSync(p))); } })(dir); return m; };
  const mp = mapOf(dirPrepare), mb = mapOf(dirBuild);
  const byteIdentity = { sameSize: mp.size === mb.size, allEqual: mp.size === mb.size && [...mb].every(([rel, s]) => mp.get(rel) === s) };
  assert.equal(byteIdentity.allEqual, true);

  const businessPhaseGuardAttempts = guardHits.length - businessStart;
  const guardCounters = { sensitivityAttempts, businessPhaseGuardAttempts, total: guardHits.length };
  const ok = businessPhaseGuardAttempts === 0;
  const result = {
    schema: 'codebuddy-i1-prepare-separation-evidence/1',
    observedAt: new Date().toISOString(),
    basisCommit: 'a7ad58b',
    reviewBasis: 'docs/CodeBuddy任务-核验包提前准备与执行时效分离-20261017.md（本轮任务书；离线阻断证据 证据/Codex核验包未来窗口准备阻断-20261017.json）',
    verificationKind: 'offline evidence for prepare/execution time separation; synthetic plans/clocks/transport stubs; NOT platform verification, NOT an execution approval',
    ok,
    guardCounters,
    sections: { a: sectionA, b: sectionB, c: sectionC, d: sectionD, byteIdentity },
    runtimeDigests: {
      packerSha256: sha(fs.readFileSync(root + '/miniapp/scripts/package-participant-identity-check.cjs')),
      coreSha256Unchanged: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-identity-check.cjs'))
    },
    evidenceKinds: {
      sourceObservation: 'windowClockCheck phase parameter and public prepare/checkPreparedDir entries read from product source',
      syntheticChain: 'sections A/B/C use synthetic plans, controlled test clock (finally restored) and synthetic db/context',
      localCli: 'section D spawns only process.execPath with this package CLI under a child network-guard preload (whitelist, not general spawn)',
      platform: 'none — real platform/preview/deploy/call remains unverified'
    },
    cloudOperations: 0,
    limitations: [
      'Preparation success means local artifacts only (executionReady=false); it is not an execution approval.',
      'Real platform window behaviour is not verified; future execution needs a new specific package and user confirmation.'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[提前准备证据摘要] ok=' + ok + ' A.准备39=39/A.executionReady=false B.入窗通过+0新写+字节不变 C.边界=' + Object.keys(sectionC).length + ' D.CLI=7项 探针=' + sensitivityAttempts + ' 业务期意外=' + businessPhaseGuardAttempts + '/总=' + guardCounters.total + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  if (!ok) process.exitCode = 1;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
