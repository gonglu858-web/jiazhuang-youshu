// Codex按用户明确本地返修指令接续cb3a764；沿用证据命名系列，非CodeBuddy本轮交付。
// v3原字节保留。全部子进程（包括自反例）强制基础守卫、回执与统一判定。
// I1 核验包提前准备与执行时效分离证据 v4（R1–R4 返修；合成材料；非平台验证、非执行批准）。
// 依据：docs/Codex复查-提前准备C1C4收尾-20261018.md §2–§3。
// 对 v2 的修复：R1 除显式探针外一切命中（含初始化/setup/关闭来源构建/业务期，含被 catch 者）计入意外，
// 反例注入真实业务 require 之前与关闭来源构建期间；R2 全部子进程结果统一核验回执（结构/pid/退出状态/
// 缺失/畸形/非零意外/超时/启动错误），预期 CLI 业务 exit1 不豁免，实际汇总经真实判定出口 verdictFor
// 决定 ok/exit（敏感性运行独立分组并证明真实判定出口失败，非布尔推演）；R3 公共 child_process API
// 完全拒绝（不检查脚本名），唯一原始 spawn 由共享辅助模块闭包持有（固定命令/白名单脚本/preload/回执），
// 父守卫补 Socket.prototype.connect、子 preload 补 dns.promises；R4 CLI 空值/必需配对写前拒绝。
// stdout 默认；--out wx 独占新建。历史 v1/v2 脚本与 JSON 原字节保留。
'use strict';
const root = 'C:/Users/30591/Documents/ChatGPT/装修进度验收APP';
const PACKER_CLI = root + '/miniapp/scripts/package-participant-identity-check.cjs';
const SELF = __filename;
const SELF_DIR = __dirname;
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const guardHelper = require(root + '/miniapp/tests/helpers/pic-guard-runner.cjs');

const outIdx = process.argv.indexOf('--out');
const outPath = outIdx !== -1 ? path.resolve(process.argv[outIdx + 1] || '') : null;
const fault = process.env.PIC_PREP_EVIDENCE_FAULT || null;

// ── R1：守卫先装；除显式 probe 外一切命中计意外（初始即 unexpected，无 setup 豁免）──
const guardHits = [];
let phase = 'unexpected';
const guard = guardHelper.installParentGuards({ hits: guardHits, getPhase: () => phase, allowedScripts: [PACKER_CLI, SELF] });

// 真实业务 require 之前注入（R1 反例：初始化阶段命中必须计入意外）
if (fault === 'earlyRequire') {
  try { require('node:https').request('https://example.invalid'); } catch (_) {} // 被 catch 仍记账
}

const core = require(root + '/miniapp/scripts/lib/participant-identity-check.cjs');
const packer = require(root + '/miniapp/scripts/package-participant-identity-check.cjs');
const business = require(root + '/miniapp/scripts/package-business-test.cjs');

function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function makeCloseSource() {
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep4-src-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan.json');
  const round = 'synthetic-prep4-close-src';
  // R1 反例：关闭来源构建期间注入（被 catch 仍记账）
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
function snapshot(outDir) {
  const m = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else m.set(path.relative(outDir, p).split(path.sep).join('/'), sha(fs.readFileSync(p)));
    }
  })(outDir);
  return m;
}

async function main() {
  if (outPath && fs.existsSync(outPath)) throw Error('--out 已存在，拒绝覆盖');
  // ── 自反例/短流程模式（PIC_PREP_EVIDENCE_FAULT 存在即短流程：'normal'=无故障对照，
  //    其余为故障注入；实际计数经真实判定出口决定 ok/exit。完整流程仅在外层无该环境变量时执行，
  //    因此自反例不会递归触发完整流程）────────────────────────────────────────────
  if (fault !== null) {
    phase = 'probe'; // 显式探针阶段（不计意外）
    assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/); // 显式探针1
    assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/); // 显式探针2
    phase = 'unexpected';
    if (fault === 'duringCloseSource') {
      makeCloseSource(); // R1 反例注入点：关闭来源构建期间（命中计入意外）
    }
    if (fault === 'businessHit') {
      try { require('node:https').request('https://example.invalid'); } catch (_) {} // 被 catch 仍记账
    }
    if (fault === 'nonWhitelistSpawn') {
      try { cpPublic().execSync('echo synthetic-non-whitelist'); } catch (_) {} // 被 catch，未实际执行
    }
    if (fault === 'publicSpawnBypass') {
      // R3 反例：业务期直接经公共 API spawn 本包 CLI 且不附 preload——必须被阻断并计数（未启动）
      try { cpPublic().spawn(process.execPath, [PACKER_CLI, '--check-prepared', root]); } catch (_) {}
    }
    // 子回执反例走本证据真实父出口，不以局部布尔值代替退出码。
    if (['childRequest','missingReceipt','malformedReceipt','pidMismatch','exitMismatch'].includes(fault)) {
      const planArg = process.argv[process.argv.indexOf('--fixture-plan') + 1];
      assert.ok(planArg && path.isAbsolute(planArg));
      const extra = {
        childRequest: "try { require('https').request('https://example.invalid'); } catch (_) {}",
        missingReceipt: "process.on('exit',()=>require('fs').unlinkSync(process.env.PIC_CLI_GUARD_RECEIPT));",
        malformedReceipt: "process.on('exit',()=>require('fs').writeFileSync(process.env.PIC_CLI_GUARD_RECEIPT,JSON.stringify({unexpected:[]})));",
        pidMismatch: "process.on('exit',()=>{const fs=require('fs'),p=process.env.PIC_CLI_GUARD_RECEIPT,j=JSON.parse(fs.readFileSync(p));j.pid+=1;fs.writeFileSync(p,JSON.stringify(j));});",
        exitMismatch: "process.on('exit',()=>{const fs=require('fs'),p=process.env.PIC_CLI_GUARD_RECEIPT,j=JSON.parse(fs.readFileSync(p));j.exitCode=0;fs.writeFileSync(p,JSON.stringify(j));});"
      }[fault];
      const fixture=guard.newReceiptPath('fault-preload')+'.cjs';
      fs.writeFileSync(fixture,guardHelper.buildGuardPreloadSource()+'\n'+extra,{flag:'wx'});
      const r=await guard.runCli({scriptPath:PACKER_CLI,args:['--plan',planArg,'--out',guard.newReceiptPath('unused-output')],guardPreload:fixture,receiptPath:guard.newReceiptPath('fault-cli')});
      assert.equal(r.code,1,'预期业务exit1仍须回执判定');
      assert.ok(r.validation.failures.length>0,'真实子回执异常已被捕获');
    }
    const counters = countHits();
    const verdict = guardHelper.verdictFor(counters); // 真实判定出口
    const result = { schema: 'codebuddy-i1-prepare-evidence-v4-selftest/1', faultMode: fault, guardCounters: counters, verdict };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = verdict.exitCode;
    return;
  }
  function cpPublic() { return require('node:child_process'); }
  function countHits() {
    return {
      probes: guardHits.filter(h => h.phase === 'probe').length,
      parentUnexpected: guardHits.filter(h => h.phase !== 'probe').length,
      childUnexpectedTotal: guard.summary().childUnexpectedTotal,
      receiptFailures: guard.summary().receiptFailures
    };
  }

  // ── 显式探针 ─────────────────────────────────────────────────────────────
  phase = 'probe';
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  phase = 'unexpected';

  const openid = 'synthetic-prep4-openid';
  const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);
  const roundId = 'synthetic-prep4-round';
  const PASSPHRASE = 'synthetic-prep4-passphrase';
  const closeSource = makeCloseSource();
  const futureStarts = Date.now() + 2 * 60 * 60 * 1000;
  const futurePlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep4-plan-future-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(futurePlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: roundId, participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: sha(PASSPHRASE),
    windowStartsAtIso: new Date(futureStarts).toISOString(), windowExpiresAtIso: new Date(futureStarts + 30 * 60 * 1000).toISOString(),
    closeSourceDir: closeSource, requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  const inWindowPlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep4-plan-inwin-' + crypto.randomBytes(3).toString('hex') + '.json');
  const baseStarts = Date.now() - 60 * 1000;
  fs.writeFileSync(inWindowPlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: roundId, participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: sha(PASSPHRASE), windowStartsAtIso: new Date(baseStarts).toISOString(),
    windowExpiresAtIso: new Date(baseStarts + 30 * 60 * 1000).toISOString(), closeSourceDir: closeSource,
    requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  const expiresMs = Date.parse(JSON.parse(fs.readFileSync(inWindowPlan, 'utf8')).windowExpiresAtIso);

  // ── A：未来窗口可准备、严格执行仍拒绝、核心拒绝 ───────────────────────────
  const outDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-' + crypto.randomBytes(4).toString('hex'));
  const prepared = packer.prepare(futurePlan, outDir);
  const cpCheck = packer.checkPreparedDir(outDir);
  const strictOut = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-strict-' + crypto.randomBytes(3).toString('hex'));
  let strictBuildCode = null, strictBuildDirCreated = null;
  try { packer.build(futurePlan, strictOut); } catch (error) { strictBuildCode = error.code; strictBuildDirCreated = fs.existsSync(strictOut); }
  const futureChecker = core.createIdentityChecker({
    db: { collection() { throw Error('DB forbidden'); } },
    trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, OPENID: openid, openid },
    config: { checkRoundId: roundId, passphraseDigest: sha(PASSPHRASE), windowStartsAtMs: futureStarts, windowExpiresAtMs: futureStarts + 30 * 60 * 1000 },
    now: () => Date.now()
  });
  const futureHandle = await futureChecker.handle({ action: 'inspectSelf', checkRoundId: roundId, passphrase: PASSPHRASE });
  const sectionA = {
    phase: prepared.phase, preparationValidated: prepared.preparationValidated, executionReady: prepared.executionReady,
    files: prepared.manifest.files.length, closeFiles: prepared.manifest.closePackage.files.length,
    checkPreparedOk: cpCheck.ok, checkPreparedExecutionReady: cpCheck.executionReady,
    strictBuildCode, strictBuildDirCreated, strictCheckRejected: packer.checkDir(outDir).ok === false,
    coreFutureCode: futureHandle.code, coreFutureReadAttempted: futureHandle.readAttempted
  };
  assert.equal(sectionA.phase, 'preparation'); assert.equal(sectionA.executionReady, false);
  assert.equal(sectionA.files, 15); assert.equal(sectionA.closeFiles, 23);
  assert.equal(sectionA.checkPreparedOk, true); assert.equal(sectionA.checkPreparedExecutionReady, false);
  assert.equal(sectionA.strictBuildCode, 'PIC_WINDOW_NOT_OPEN'); assert.equal(sectionA.strictBuildDirCreated, false);
  assert.equal(sectionA.strictCheckRejected, true);
  assert.equal(sectionA.coreFutureCode, 'PIC_WINDOW_NOT_OPEN'); assert.equal(sectionA.coreFutureReadAttempted, false);

  // ── B：入窗后同包通过、完全复用、字节不变（固定包根 39 项唯一快照）──────────
  const before = snapshot(outDir);
  assert.equal(before.size, 39, '快照恰 39 项');
  assert.equal(new Set(before.keys()).size, 39, '相对路径唯一');
  for (const must of ['close/server/scheduleSandbox/index.js', 'server/scheduleSandbox/index.js', 'frontend/app.js', 'close/frontend/app.js', 'manifest.json', 'plan.json']) {
    assert.ok(before.has(must), '快照包含同名敏感路径：' + must);
  }
  let inWindowCheckOk = false, rebuildWritten = -1;
  await withClock(futureStarts + 60 * 1000, () => {
    inWindowCheckOk = packer.checkDir(outDir).ok;
    rebuildWritten = packer.build(futurePlan, outDir).io.filter(x => x.action === 'written').length;
  });
  const after = snapshot(outDir);
  const bytesUnchanged = after.size === before.size && [...before].every(([rel, s]) => after.get(rel) === s);
  const sectionB = { snapshotSize: before.size, inWindowCheckOk, rebuildWritten, bytesUnchanged };
  assert.equal(inWindowCheckOk, true); assert.equal(rebuildWritten, 0); assert.equal(bytesUnchanged, true);

  // ── C3 敏感性（保留）：关闭入口/候选入口/同名前端文件改动必须被发现 ─────────
  const sensitivity = {};
  const mutateAndCheck = (rel, mutate) => {
    const p = path.join(outDir, ...rel.split('/'));
    const orig = fs.readFileSync(p);
    fs.writeFileSync(p, mutate(orig));
    const after2 = snapshot(outDir);
    const detected = after2.get(rel) !== before.get(rel);
    fs.writeFileSync(p, orig);
    const restored = snapshot(outDir);
    return { detected, restoredEquals: restored.size === before.size && [...before].every(([rel2, s]) => restored.get(rel2) === s) };
  };
  sensitivity.closeEntry = mutateAndCheck('close/server/scheduleSandbox/index.js', b => Buffer.concat([b, Buffer.from('\n// synthetic-close-entry-note\n')]));
  sensitivity.candidateEntry = mutateAndCheck('server/scheduleSandbox/index.js', b => Buffer.concat([b, Buffer.from('\n// synthetic-candidate-entry-note\n')]));
  sensitivity.sameNameFrontend = mutateAndCheck('frontend/app.js', b => Buffer.concat([b, Buffer.from('\n// synthetic-frontend-note\n')]));
  for (const [name, r] of Object.entries(sensitivity)) {
    assert.equal(r.detected, true, name + ' 改动必须被快照发现');
    assert.equal(r.restoredEquals, true, name + ' 还原后字节一致');
  }

  // ── D：边界矩阵（可控时钟；finally 恢复）────────────────────────────────
  const sectionD = {};
  const boundaryCase = async (name, clock, expectCode) => {
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-boundary-' + crypto.randomBytes(3).toString('hex'));
    let code = null, dirCreated = false;
    await withClock(clock, () => {
      try { packer.prepare(inWindowPlan, dir); } catch (error) { code = error.code; }
      dirCreated = fs.existsSync(dir);
    });
    sectionD[name] = { code, dirCreated };
    assert.equal(code, expectCode, name); assert.equal(dirCreated, false, name + ' 失败不创建目录');
  };
  await boundaryCase('expiresNow', expiresMs, 'PIC_WINDOW_EXPIRED');
  await boundaryCase('expired', expiresMs + 1, 'PIC_WINDOW_EXPIRED');
  await boundaryCase('nanClock', NaN, 'PIC_CLOCK_INVALID');
  await boundaryCase('clockThrows', () => { throw Error('synthetic-clock-failure'); }, 'PIC_CLOCK_ERROR');
  {
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-midflight-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0, caught = null;
    await withClock(() => { calls++; return calls <= 10 ? baseStarts + 1000 : expiresMs + 1; }, () => {
      try { packer.prepare(inWindowPlan, dir); } catch (error) { caught = error; }
    });
    sectionD.midFlight = { code: caught && caught.code, wroteFiles: caught && caught.wroteFiles };
    assert.equal(sectionD.midFlight.code, 'PIC_WINDOW_EXPIRED');
    assert.ok(sectionD.midFlight.wroteFiles > 0);
  }
  {
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-crossin-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0, preparedResult = null;
    await withClock(() => { calls++; return calls <= 5 ? futureStarts - 1000 : futureStarts + 60 * 1000; }, () => { preparedResult = packer.prepare(futurePlan, dir); });
    sectionD.crossIn = { phase: preparedResult.phase, executionReady: preparedResult.executionReady };
    assert.equal(sectionD.crossIn.executionReady, false);
  }

  // ── E：CLI（C1 严格解析 + C2 统一回执校验：预期业务 exit1 不豁免）────────────
  const guardPreload = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep4-cli-guard-' + crypto.randomBytes(3).toString('hex') + '.cjs');
  fs.writeFileSync(guardPreload, guardHelper.buildGuardPreloadSource());
  const runCli = args => guard.runCli({ scriptPath: PACKER_CLI, args, guardPreload, receiptPath: guard.newReceiptPath('prep4') });
  const childUnexpectedTotal = { n: 0 }; // 正常流程子意外实际累计（R2：禁止写死）
  const receiptFailures = { n: 0 }; // 回执失败实际累计
  const sectionE = {};
  const expectClean = (r, label) => {
    const v = guardHelper.validateChildResult(r);
    childUnexpectedTotal.n += v.childUnexpected;
    receiptFailures.n += v.failures.length;
    assert.deepEqual(v.failures, [], label + ' 回执/守卫校验通过');
    return v;
  };
  {
    const preparedCliDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-cli-' + crypto.randomBytes(3).toString('hex'));
    const p1 = await runCli(['--prepare', futurePlan, '--out', preparedCliDir]);
    expectClean(p1, 'prepare');
    sectionE.prepare = { code: p1.code, executionReady: JSON.parse(p1.out).executionReady, files: JSON.parse(p1.out).files };
    assert.equal(sectionE.prepare.executionReady, false); assert.equal(sectionE.prepare.files, 15);
    const p2 = await runCli(['--check-prepared', preparedCliDir]);
    expectClean(p2, 'check-prepared');
    sectionE.checkPrepared = { code: p2.code, executionReady: JSON.parse(p2.out).executionReady };
    assert.equal(sectionE.checkPrepared.executionReady, false);
    // 预期业务 exit1 的运行同样不豁免回执校验（R2）
    const p3 = await runCli(['--check', preparedCliDir]);
    expectClean(p3, 'check-future-exit1');
    sectionE.strictCheckFuture = { code: p3.code, windowNotOpen: p3.out.includes('WINDOW_NOT_OPEN') };
    assert.equal(sectionE.strictCheckFuture.code, 1); assert.equal(sectionE.strictCheckFuture.windowNotOpen, true);
    const strictDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-clistrict-' + crypto.randomBytes(3).toString('hex'));
    const p4 = await runCli(['--plan', futurePlan, '--out', strictDir]);
    expectClean(p4, 'plan-future-exit1');
    sectionE.defaultBuildFuture = { code: p4.code, dirCreated: fs.existsSync(strictDir) };
    assert.equal(sectionE.defaultBuildFuture.code, 1); assert.equal(sectionE.defaultBuildFuture.dirCreated, false);
    const expiredPlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep4-plan-expired-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(expiredPlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: roundId, participantCode: '1',
      ...core.FIXED_TARGET, passphraseDigest: sha(PASSPHRASE), windowStartsAtIso: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      windowExpiresAtIso: new Date(Date.now() - 60 * 1000).toISOString(), closeSourceDir: closeSource,
      requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
    const p5 = await runCli(['--prepare', expiredPlan, '--out', path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-cliexp-' + crypto.randomBytes(3).toString('hex'))]);
    expectClean(p5, 'prepare-expired-exit1');
    sectionE.expiredPrepare = { code: p5.code, windowExpired: p5.err.includes('WINDOW_EXPIRED') };
    assert.equal(sectionE.expiredPrepare.code, 1); assert.equal(sectionE.expiredPrepare.windowExpired, true);
    // R4 反例：空字符串值/缺 --close-source → exit1 + [用法错误] + 零产物（回执校验不豁免）
    const r4Cases = [
      { args: ['--prepare', futurePlan, '--out', ''], why: '空字符串 --out', hasOut: false },
      { args: ['--prepare', ''], why: '空字符串计划路径', hasOut: false },
      { args: ['--check-close', futurePlan], why: '缺 --close-source', hasOut: false }
    ];
    sectionE.r4 = [];
    for (const c of r4Cases) {
      const r = await runCli(c.args);
      const v = expectClean(r, 'R4:' + c.why);
      const record = { why: c.why, code: r.code, usageError: r.err.includes('[用法错误]'), childUnexpected: v.childUnexpected };
      sectionE.r4.push(record);
      assert.equal(record.code, 1, c.why + '：exit1');
      assert.equal(record.usageError, true, c.why + '：[用法错误]');
    }
    // C1 反例（保留）：重复模式/未知选项/额外位置参数/重复选项 → exit1 + 零产物
    const c1Cases = [
      { args: ['--prepare', futurePlan, '--out', 'PENDING', '--prepare', futurePlan], why: '重复模式', hasOut: true },
      { args: ['--prepare', futurePlan, '--unknown-option', 'value', '--out', 'PENDING'], why: '未知选项', hasOut: true },
      { args: ['--prepare', futurePlan, '--out', 'PENDING', 'extra-positional'], why: '额外位置参数', hasOut: true },
      { args: ['--prepare', futurePlan, '--out', 'PENDING', '--out', 'OTHER'], why: '重复选项 --out', hasOut: true }
    ];
    sectionE.c1 = [];
    for (const [i, c] of c1Cases.entries()) {
      const outDir2 = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-c1-' + i + '-' + crypto.randomBytes(3).toString('hex'));
      const args = c.args.map(a => (a === 'PENDING' ? outDir2 : a));
      const r = await runCli(args);
      expectClean(r, 'C1:' + c.why);
      const record = { why: c.why, code: r.code, usageError: r.err.includes('[用法错误]'), dirCreated: c.hasOut ? fs.existsSync(outDir2) : null };
      sectionE.c1.push(record);
      assert.equal(record.code, 1, c.why + '：exit1');
      assert.equal(record.usageError, true, c.why + '：[用法错误]');
      if (c.hasOut) assert.equal(record.dirCreated, false, c.why + '：零产物');
    }
    const legalDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-c1legal-' + crypto.randomBytes(3).toString('hex'));
    const legal = await runCli(['--prepare', futurePlan, '--out', legalDir]);
    expectClean(legal, 'c1-legal');
    sectionE.c1Legal = { code: legal.code, files: JSON.parse(legal.out).files, executionReady: JSON.parse(legal.out).executionReady };
    assert.equal(sectionE.c1Legal.code, 0); assert.equal(sectionE.c1Legal.files, 15); assert.equal(sectionE.c1Legal.executionReady, false);
  }

  // F：自反例全部有基础preload与回执；从实际父进程进出状态确认失败。
  const runSelf = faultMode => guard.runCli({scriptPath:SELF,args:['--fixture-plan',futurePlan],guardPreload,
    receiptPath:guard.newReceiptPath('self'),group:'sensitivity',extraEnv:{PIC_PREP_EVIDENCE_FAULT:faultMode}});
  const sectionF = {};
  for (const faultName of ['normal','earlyRequire','duringCloseSource','businessHit','nonWhitelistSpawn','publicSpawnBypass','childRequest','missingReceipt','malformedReceipt','pidMismatch','exitMismatch']) {
    const r=await runSelf(faultName);
    assert.deepEqual(r.validation.failures,[],'自反例进程自身传输/回执必须正常');
    const j=JSON.parse(r.out),expected=faultName==='normal'?0:1;
    assert.equal(r.code,expected,faultName+' 真实父进程退出码');
    assert.equal(j.verdict.exitCode,r.code);assert.equal(j.verdict.ok,expected===0);
    assert.equal(j.guardCounters.probes,2);
    if(['earlyRequire','duringCloseSource','businessHit','nonWhitelistSpawn','publicSpawnBypass'].includes(faultName))assert.equal(j.guardCounters.parentUnexpected,1);
    if(faultName==='childRequest')assert.equal(j.guardCounters.childUnexpectedTotal,1);
    if(['missingReceipt','malformedReceipt','pidMismatch','exitMismatch'].includes(faultName))assert.ok(j.guardCounters.receiptFailures>0);
    sectionF[faultName]={processExitCode:r.code,verdict:j.verdict,guardCounters:j.guardCounters,outerReceiptChecked:true};
  }
  const sectionG={selfTransport:guard.summary('sensitivity'),scope:'F内故障为独立敏感性进程的实际计数；不混入正常业务期，也不清零'};
  assert.equal(sectionG.selfTransport.receiptFailures,0);
  assert.equal(sectionG.selfTransport.childUnexpectedTotal,0);

  const sectionH = await require(root + "/miniapp/tests/helpers/pic-guard-boundary-proof.cjs").runBoundaryProof();

  // ── 字节一致性：同计划 prepare vs 严格 build（窗口内受控时钟）──────────────
  const dirPrepare = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-idprep-' + crypto.randomBytes(3).toString('hex'));
  const dirBuild = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep4-idbuild-' + crypto.randomBytes(3).toString('hex'));
  packer.prepare(inWindowPlan, dirPrepare);
  packer.build(inWindowPlan, dirBuild);
  const sp = snapshot(dirPrepare), sb = snapshot(dirBuild);
  const byteIdentity = { sameSize: sp.size === sb.size && sp.size === 39, allEqual: sp.size === sb.size && [...sb].every(([rel, s]) => sp.get(rel) === s) };
  assert.equal(byteIdentity.allEqual, true);

  // ── R2：真实判定出口（同一 verdictFor 决定本证据 ok/exit；禁止写死计数）────
  const actualCounters = {
    probes: guardHits.filter(h => h.phase === 'probe').length,
    parentUnexpected: guardHits.filter(h => h.phase !== 'probe').length,
    childUnexpectedTotal: guard.summary().childUnexpectedTotal,
    receiptFailures: guard.summary().receiptFailures
  };
  assert.equal(actualCounters.childUnexpectedTotal, childUnexpectedTotal.n);
  assert.equal(actualCounters.receiptFailures, receiptFailures.n);
  const verdict = guardHelper.verdictFor(actualCounters);
  const result = {
    schema: 'codebuddy-i1-prepare-separation-evidence/4',
    observedAt: new Date().toISOString(),
    basisCommit: 'cb3a764',
    reviewBasis: 'docs/Codex复查-提前准备C1C4收尾-20261018.md §2–§3（R1–R4 返修）',
    verificationKind: 'offline evidence; synthetic plans/clocks/transport stubs; NOT platform verification, NOT an execution approval',
    ok: verdict.ok,
    guardCounters: Object.assign({}, actualCounters, { total: actualCounters.probes + actualCounters.parentUnexpected + actualCounters.childUnexpectedTotal }),
    verdict,
    sections: { a: sectionA, b: sectionB, sensitivity, d: sectionD, e: sectionE, f: sectionF, g: sectionG, h: sectionH, byteIdentity },
    runtimeDigests: {
      packerSha256: sha(fs.readFileSync(root + '/miniapp/scripts/package-participant-identity-check.cjs')),
      coreSha256Unchanged: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-identity-check.cjs')),
      guardHelperSha256: sha(fs.readFileSync(root + '/miniapp/tests/helpers/pic-guard-runner.cjs')),
      boundaryProofSha256: sha(fs.readFileSync(root + '/miniapp/tests/helpers/pic-guard-boundary-proof.cjs')),
      evidenceSourceSha256: sha(fs.readFileSync(__filename))
    },
    evidenceKinds: {
      sourceObservation: 'CLI strict parser (parseCliArgs incl. R4 empty/pairing) and phase accounting read from product source',
      syntheticChain: 'sections A–D use synthetic plans, controlled test clock (finally restored) and synthetic db/context',
      localCli: 'section E/F spawn only whitelisted scripts via the shared helper runner under a child guard preload (network+process surface incl. dns.promises/Socket.connect, structured receipts)',
      selfFaults: 'F starts separately guarded evidence processes; initialization/business/process-bypass/child-request/missing/malformed/pid/exit faults cause their actual exit1; G accounts for their transport separately',
      runnerBoundaries: 'H uses real local child output/timeout and intercepted DNS/Socket calls; startup-error events are synthetic VM dependency injection, not OS/platform verification',
      platform: 'none — real platform/preview/deploy/call remains unverified'
    },
    cloudOperations: 0,
    limitations: [
      'Preparation success means local artifacts only (executionReady=false); it is not an execution approval.',
      'Guard receipts cover the child lifetime via process exit hook; a SIGKILL child yields a missing receipt which the parent treats as failure.',
      'Not claimed: resistance to tampered runtime builtins or arbitrary lying Proxies.'
    ]
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) { console.error('[拒绝] --out 已存在，不覆盖：' + outPath); process.exitCode = 1; return; }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[提前准备证据v4摘要] ok=' + verdict.ok + ' A.准备15+23 B.39项快照/入窗通过/0新写/字节不变 C3.敏感性3/3 D.边界6 E.CLI含R4反例3+C1反例4+合法对照 F.自反例10类经真实进程退出码 G.自反例传输与回执独立记账 计数：探针=' + actualCounters.probes + ' 父意外=' + actualCounters.parentUnexpected + ' 子意外合计=' + actualCounters.childUnexpectedTotal + ' 回执失败=' + actualCounters.receiptFailures + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  process.exitCode = verdict.exitCode;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => guard.restoreAll());
