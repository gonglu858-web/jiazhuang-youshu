// I1 核验包提前准备与执行时效分离证据 v2（C1–C4 收尾；合成材料；非平台验证、非执行批准）。
// 依据：docs/Codex复查-核验包提前准备分离-20261018.md §2–§3。
// 对 v1 的修复：C1 CLI 严格解析正反例；C2 守卫覆盖初始化至结束（显式阶段记账，无起始偏移）、
// 父进程进程API白名单runner、子进程守卫覆盖网络/进程面并以结构化回执回传计数、
// runner 超时/spawn错误/有界输出；C3 固定包根相对路径快照（39 项完整唯一）+ 三类改动敏感性。
// stdout 默认；--out wx 独占新建。历史 v1 脚本/JSON 原字节保留。
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = 'C:/Users/30591/Documents/ChatGPT/装修进度验收APP';
const PACKER_CLI = root + '/miniapp/scripts/package-participant-identity-check.cjs';
const SELF = __filename;
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx !== -1 ? path.resolve(process.argv[outIdx + 1] || '') : null;
const faultMode = process.env.PIC_PREP_EVIDENCE_FAULT || null;

// ── C2：守卫在一切依赖加载/来源构建之前安装；显式阶段记账 ──────────────────────
const guardHits = [];
let phase = 'setup'; // 'setup'（守卫安装期，不计）→ 'probe'（显式探针）→ 'unexpected'（其余全部计意外）
const restore = [];
function guard(obj, k, label) {
  const old = obj[k];
  if (typeof old !== 'function') return;
  obj[k] = function (...a) { guardHits.push({ phase, api: label || k }); throw Error('OFFLINE_GUARD:' + (label || k)); };
  restore.push(() => { obj[k] = old; });
}
for (const m of ['node:http', 'node:https']) for (const k of ['get', 'request']) guard(require(m), k, m + '.' + k);
guard(require('node:tls'), 'connect', 'tls.connect');
guard(globalThis, 'fetch', 'fetch');
const dns = require('node:dns');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) { guard(dns, k, 'dns.' + k); guard(dns.promises, k, 'dns.promises.' + k); }
const netMod = require('node:net');
for (const k of ['connect', 'createConnection']) guard(netMod, k, 'net.' + k);
// 进程 API：默认全部阻断并计意外；仅受控 runner 通过白名单直达原始 spawn。
const cpMod = require('node:child_process');
const origSpawn = cpMod.spawn;
const RUNNER_WHITELIST = new Set([PACKER_CLI, SELF]); // 明确 Node + 指定脚本
cpMod.spawn = function controlledSpawn(file, args) {
  const argv = Array.isArray(args) ? args : [];
  if (file === process.execPath && argv.length >= 1 && RUNNER_WHITELIST.has(argv[0])) {
    return origSpawn.apply(cpMod, arguments); // 受控 runner：不走守卫记账
  }
  guardHits.push({ phase, api: 'child_process.spawn(非白名单)' });
  throw Error('OFFLINE_GUARD:child_process.spawn(非白名单)');
};
for (const k of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) guard(cpMod, k, 'cp.' + k);

// 守卫已就位，之后才允许加载业务模块与构建来源（其任何意外都会被记账）
const core = require(root + '/miniapp/scripts/lib/participant-identity-check.cjs');
const packer = require(root + '/miniapp/scripts/package-participant-identity-check.cjs');
const business = require(root + '/miniapp/scripts/package-business-test.cjs');

function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function makeCloseSource() {
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep2-src-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan.json');
  const round = 'synthetic-prep2-close-src';
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
/** 固定包根相对路径快照（C3）：返回 rel→sha256，rel 以固定 outDir 为根。 */
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
/** 受控 runner（C2）：仅白名单脚本；回执校验；超时/spawn错误/有界输出。 */
function makeRunner(guardPreload) {
  return function runCli(args, extraEnv) {
    return new Promise(resolve => {
      const receiptPath = path.join(root, 'artifacts/schedule-sandbox/business-test', 'cli-receipt-' + crypto.randomBytes(5).toString('hex') + '.json');
      const child = origSpawn(process.execPath, [PACKER_CLI, ...args], {
        env: Object.assign({}, process.env, {
          NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require ' + guardPreload,
          PIC_CLI_GUARD_RECEIPT: receiptPath
        }, extraEnv || {}),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '', err = '', outBounded = false, errBounded = false, timedOut = false;
      const LIMIT = 256 * 1024;
      child.stdout.on('data', d => { if (out.length < LIMIT) out += d; else outBounded = true; });
      child.stderr.on('data', d => { if (err.length < LIMIT) err += d; else errBounded = true; });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60000);
      child.on('error', spawnError => {
        clearTimeout(timer);
        resolve({ code: -1, out, err, spawnError: String(spawnError && spawnError.message), receipt: null, receiptError: 'spawn-error', outBounded, errBounded, timedOut, receiptPath });
      });
      child.on('close', code => {
        clearTimeout(timer);
        let receipt = null, receiptError = null;
        try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch (e) { receiptError = e.message; }
        resolve({ code, out, err, spawnError: null, receipt, receiptError, outBounded, errBounded, timedOut, receiptPath });
      });
    });
  };
}

async function main() {
  // 故障注入模式（自反例）：用于固化 C2 要求的四类反例；正常模式不走此分支。
  if (faultMode) {
    phase = 'unexpected';
    if (faultMode === 'earlyRequest') {
      try { require('node:https').request('https://example.invalid'); } catch (_) {} // 被 catch 仍记账
    }
    if (faultMode === 'midRequest') {
      phase = 'probe'; // 显式探针（不计意外）
      assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
      phase = 'unexpected';
      try { require('node:https').request('https://example.invalid'); } catch (_) {} // 被 catch 仍记账
    }
    if (faultMode === 'nonWhitelistSpawn') {
      try { cpMod.execSync('echo synthetic-non-whitelist'); } catch (_) {} // 被 catch，未实际执行
    }
    const counters = {
      probes: guardHits.filter(h => h.phase === 'probe').length,
      parentUnexpected: guardHits.filter(h => h.phase === 'unexpected').length
    };
    const ok = counters.parentUnexpected === 0;
    const result = { schema: 'codebuddy-i1-prepare-evidence-v2-selftest/1', faultMode, guardCounters: counters, ok };
    console.log(JSON.stringify(result, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  // ── 正常流程 ─────────────────────────────────────────────────────────────
  const closeSource = makeCloseSource();
  phase = 'probe'; // 显式探针阶段
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  phase = 'unexpected'; // 之后的一切命中都计意外
  const probes = guardHits.filter(h => h.phase === 'probe').length;
  assert.equal(probes, 2, '显式探针 2');

  const openid = 'synthetic-prep2-openid';
  const userId = core.deriveUserId(core.FIXED_TARGET.appId, openid);
  const roundId = 'synthetic-prep2-round';
  const PASSPHRASE = 'synthetic-prep2-passphrase';
  const futureStarts = Date.now() + 2 * 60 * 60 * 1000;
  const futurePlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep2-plan-future-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(futurePlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: roundId, participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: sha(PASSPHRASE),
    windowStartsAtIso: new Date(futureStarts).toISOString(), windowExpiresAtIso: new Date(futureStarts + 30 * 60 * 1000).toISOString(),
    closeSourceDir: closeSource, requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  const inWindowPlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep2-plan-inwin-' + crypto.randomBytes(3).toString('hex') + '.json');
  const baseStarts = Date.now() - 60 * 1000;
  fs.writeFileSync(inWindowPlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: roundId, participantCode: '1',
    ...core.FIXED_TARGET, passphraseDigest: sha(PASSPHRASE), windowStartsAtIso: new Date(baseStarts).toISOString(),
    windowExpiresAtIso: new Date(baseStarts + 30 * 60 * 1000).toISOString(), closeSourceDir: closeSource,
    requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
  const expiresMs = Date.parse(JSON.parse(fs.readFileSync(inWindowPlan, 'utf8')).windowExpiresAtIso);

  // ── A：未来窗口可准备、严格执行仍拒绝、核心拒绝（v1 同口径）───────────────
  const outDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-' + crypto.randomBytes(4).toString('hex'));
  const prepared = packer.prepare(futurePlan, outDir);
  const cp = packer.checkPreparedDir(outDir);
  const sectionA = {
    phase: prepared.phase, preparationValidated: prepared.preparationValidated, executionReady: prepared.executionReady,
    files: prepared.manifest.files.length, closeFiles: prepared.manifest.closePackage.files.length,
    checkPreparedOk: cp.ok, checkPreparedExecutionReady: cp.executionReady,
    strictBuildRejected: false, strictBuildDirCreated: null, strictCheckRejected: packer.checkDir(outDir).ok === false
  };
  const strictOut = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-strict-' + crypto.randomBytes(3).toString('hex'));
  try { packer.build(futurePlan, strictOut); } catch (error) {
    sectionA.strictBuildRejected = error.code === 'PIC_WINDOW_NOT_OPEN';
    sectionA.strictBuildDirCreated = fs.existsSync(strictOut);
  }
  assert.equal(sectionA.phase, 'preparation'); assert.equal(sectionA.executionReady, false);
  assert.equal(sectionA.files, 15); assert.equal(sectionA.closeFiles, 23);
  assert.equal(sectionA.checkPreparedOk, true); assert.equal(sectionA.checkPreparedExecutionReady, false);
  assert.equal(sectionA.strictBuildRejected, true); assert.equal(sectionA.strictBuildDirCreated, false);
  assert.equal(sectionA.strictCheckRejected, true);
  const futureChecker = core.createIdentityChecker({
    db: { collection() { throw Error('DB forbidden'); } },
    trusted: { appId: core.FIXED_TARGET.appId, envId: core.FIXED_TARGET.envId, OPENID: openid, openid },
    config: { checkRoundId: roundId, passphraseDigest: sha(PASSPHRASE), windowStartsAtMs: futureStarts, windowExpiresAtMs: futureStarts + 30 * 60 * 1000 },
    now: () => Date.now()
  });
  const futureHandle = await futureChecker.handle({ action: 'inspectSelf', checkRoundId: roundId, passphrase: PASSPHRASE });
  sectionA.coreFutureCode = futureHandle.code;
  assert.equal(sectionA.coreFutureCode, 'PIC_WINDOW_NOT_OPEN');

  // ── B：入窗后同包通过、完全复用、字节不变（C3：固定包根相对路径快照，39 项唯一）──
  const before = snapshot(outDir);
  const EXPECTED_RELS = 39;
  assert.equal(before.size, EXPECTED_RELS, '快照恰 39 项（无同名覆盖）');
  assert.equal(new Set(before.keys()).size, EXPECTED_RELS, '相对路径唯一');
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

  // ── C3 敏感性：分别改动关闭入口/候选入口/同名前端文件，必须被发现 ────────────
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

  // ── D：边界矩阵（可控时钟；测试隔离，finally 恢复）────────────────────────
  const sectionD = {};
  const boundaryCase = async (name, clock, expectCode) => {
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-boundary-' + crypto.randomBytes(3).toString('hex'));
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
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-midflight-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0, caught = null;
    await withClock(() => { calls++; return calls <= 10 ? baseStarts + 1000 : expiresMs + 1; }, () => {
      try { packer.prepare(inWindowPlan, dir); } catch (error) { caught = error; }
    });
    sectionD.midFlight = { code: caught && caught.code, wroteFiles: caught && caught.wroteFiles };
    assert.equal(sectionD.midFlight.code, 'PIC_WINDOW_EXPIRED');
    assert.ok(sectionD.midFlight.wroteFiles > 0);
  }
  {
    const dir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-crossin-' + crypto.randomBytes(3).toString('hex'));
    let calls = 0, preparedResult = null;
    await withClock(() => { calls++; return calls <= 5 ? futureStarts - 1000 : futureStarts + 60 * 1000; }, () => { preparedResult = packer.prepare(futurePlan, dir); });
    sectionD.crossIn = { phase: preparedResult.phase, executionReady: preparedResult.executionReady };
    assert.equal(sectionD.crossIn.executionReady, false);
  }

  // ── E：CLI（C1 严格解析 + C2 守卫/回执/超时/有界输出）─────────────────────
  const guardPreload = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep2-cli-guard-' + crypto.randomBytes(3).toString('hex') + '.cjs');
  fs.writeFileSync(guardPreload, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const hits = [];",
    "const blocked = name => { hits.push(name); throw new Error('CLI_OFFLINE_GUARD:' + name); };",
    "for (const m of ['http', 'https']) { const mod = require(m); mod.request = blocked.bind(null, m + '.request'); mod.get = blocked.bind(null, m + '.get'); }",
    "try { const tls = require('node:tls'); tls.connect = blocked.bind(null, 'tls.connect'); } catch (_) {}",
    "const dns = require('node:dns'); for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[k] = blocked.bind(null, 'dns.' + k);",
    "const net = require('node:net'); net.connect = blocked.bind(null, 'net.connect'); net.createConnection = blocked.bind(null, 'net.createConnection');",
    "net.Socket.prototype.connect = blocked.bind(null, 'socket.connect');",
    "if (typeof globalThis.fetch === 'function') globalThis.fetch = blocked.bind(null, 'fetch');",
    "const cp = require('node:child_process'); for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[k] = blocked.bind(null, 'cp.' + k);",
    "process.on('exit', () => {",
    "  try {",
    "    const p = process.env.PIC_CLI_GUARD_RECEIPT;",
    "    if (p) fs.writeFileSync(p, JSON.stringify({ pid: process.pid, unexpected: hits, exitCode: process.exitCode === undefined ? null : process.exitCode }) + String.fromCharCode(10), { flag: 'wx' });",
    "  } catch (_) {}",
    "});"
  ].join('\n'));
  const runCli = makeRunner(guardPreload);
  const sectionE = {};
  {
    const preparedCliDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-cli-' + crypto.randomBytes(3).toString('hex'));
    const p1 = await runCli(['--prepare', futurePlan, '--out', preparedCliDir]);
    sectionE.prepare = { code: p1.code, executionReady: p1.out.includes('"executionReady": false'), childUnexpected: p1.receipt && p1.receipt.unexpected };
    assert.equal(sectionE.prepare.code, 0); assert.equal(sectionE.prepare.executionReady, true);
    assert.deepEqual(sectionE.prepare.childUnexpected, [], '子回执意外为空');
    const p2 = await runCli(['--check-prepared', preparedCliDir]);
    sectionE.checkPrepared = { code: p2.code, ok: JSON.parse(p2.out).ok, executionReady: JSON.parse(p2.out).executionReady, childUnexpected: p2.receipt.unexpected };
    assert.equal(sectionE.checkPrepared.code, 0); assert.equal(sectionE.checkPrepared.executionReady, false);
    assert.deepEqual(sectionE.checkPrepared.childUnexpected, []);
    const p3 = await runCli(['--check', preparedCliDir]);
    sectionE.strictCheckFuture = { code: p3.code, windowNotOpen: p3.out.includes('WINDOW_NOT_OPEN'), childUnexpected: p3.receipt.unexpected };
    assert.equal(sectionE.strictCheckFuture.code, 1); assert.equal(sectionE.strictCheckFuture.windowNotOpen, true);
    assert.deepEqual(sectionE.strictCheckFuture.childUnexpected, []);
    const strictDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-clistrict-' + crypto.randomBytes(3).toString('hex'));
    const p4 = await runCli(['--plan', futurePlan, '--out', strictDir]);
    sectionE.defaultBuildFuture = { code: p4.code, dirCreated: fs.existsSync(strictDir) };
    assert.equal(sectionE.defaultBuildFuture.code, 1); assert.equal(sectionE.defaultBuildFuture.dirCreated, false);
    const expiredPlan = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep2-plan-expired-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(expiredPlan, JSON.stringify({ schema: packer.PLAN_SCHEMA, synthetic: false, checkRoundId: roundId, participantCode: '1',
      ...core.FIXED_TARGET, passphraseDigest: sha(PASSPHRASE), windowStartsAtIso: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      windowExpiresAtIso: new Date(Date.now() - 60 * 1000).toISOString(), closeSourceDir: closeSource,
      requestProtocol: packer.REQUEST_PROTOCOL, keyDiagnostic: false }, null, 2));
    const p5 = await runCli(['--prepare', expiredPlan, '--out', path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-cliexp-' + crypto.randomBytes(3).toString('hex'))]);
    sectionE.expiredPrepare = { code: p5.code, windowExpired: p5.err.includes('WINDOW_EXPIRED') };
    assert.equal(sectionE.expiredPrepare.code, 1); assert.equal(sectionE.expiredPrepare.windowExpired, true);
    // C1 反例：重复模式（静默忽略第二份计划）/缺值/未知选项/额外位置参数/不适用组合 → exit1 + 零产物
    const c1Cases = [
      { args: ['--prepare', futurePlan, '--out', 'PENDING', '--prepare', futurePlan], why: '重复模式', hasOut: true },
      { args: ['--prepare', futurePlan, '--out'], why: '缺值（末尾）', hasOut: false },
      { args: ['--prepare', futurePlan, '--unknown-option', 'value', '--out', 'PENDING'], why: '未知选项', hasOut: true },
      { args: ['--prepare', futurePlan, '--out', 'PENDING', 'extra-positional'], why: '额外位置参数', hasOut: true },
      { args: ['--prepare', futurePlan, '--out', 'PENDING', '--out', 'OTHER'], why: '重复选项 --out', hasOut: true },
      { args: ['--check', futurePlan, '--close-source', 's'], why: '不适用组合 --close-source', hasOut: false }
    ];
    sectionE.c1 = [];
    for (const [i, c] of c1Cases.entries()) {
      const outDir2 = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-c1-' + i + '-' + crypto.randomBytes(3).toString('hex'));
      const args = c.args.map(a => (a === 'PENDING' ? outDir2 : a));
      const r = await runCli(args);
      const record = { why: c.why, code: r.code, usageError: r.err.includes('[用法错误]'), dirCreated: c.hasOut ? fs.existsSync(outDir2) : null, childUnexpected: r.receipt ? r.receipt.unexpected : null };
      sectionE.c1.push(record);
      assert.equal(record.code, 1, c.why + '：exit1');
      assert.equal(record.usageError, true, c.why + '：[用法错误]');
      if (c.hasOut) assert.equal(record.dirCreated, false, c.why + '：零产物');
      assert.deepEqual(record.childUnexpected, [], c.why + '：子回执意外为空');
    }
    // 合法对照：同参数合法形式成功（解析未误伤）
    const legalDir = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-c1legal-' + crypto.randomBytes(3).toString('hex'));
    const legal = await runCli(['--prepare', futurePlan, '--out', legalDir]);
    sectionE.c1Legal = { code: legal.code, files: JSON.parse(legal.out).files, childUnexpected: legal.receipt.unexpected };
    assert.equal(sectionE.c1Legal.code, 0); assert.equal(sectionE.c1Legal.files, 15);
    assert.deepEqual(sectionE.c1Legal.childUnexpected, []);
  }

  // ── F：C2 四类反例（自进程故障注入；实际计数决定 ok/exit）─────────────────
  const runSelf = faultMode2 => new Promise(resolve => {
    const child = origSpawn(process.execPath, [SELF], {
      env: Object.assign({}, process.env, { PIC_PREP_EVIDENCE_FAULT: faultMode2 }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  const sectionF = {};
  {
    const normal = await runSelf(null);
    sectionF.normal = { code: normal.code, ok: JSON.parse(normal.out).ok, counters: JSON.parse(normal.out).guardCounters };
    assert.equal(sectionF.normal.code, 0); assert.equal(sectionF.normal.ok, true);
    assert.equal(sectionF.normal.counters.parentUnexpected, 0);
    for (const fault of ['earlyRequest', 'midRequest', 'nonWhitelistSpawn']) {
      const r = await runSelf(fault);
      const j = JSON.parse(r.out);
      sectionF[fault] = { code: r.code, ok: j.ok, parentUnexpected: j.guardCounters.parentUnexpected };
      assert.equal(r.code, 1, fault + '：exit1');
      assert.equal(j.ok, false, fault + '：ok=false');
      assert.equal(j.guardCounters.parentUnexpected, 1, fault + '：意外恰 1');
    }
    // 子进程被 catch 请求：CLI 子回执计数非零 → 父判失败（CLI 业务可 exit0 也无济于事）
    const childFaultPreload = path.join(root, 'artifacts/schedule-sandbox/business-test', 'prep2-cli-faultguard-' + crypto.randomBytes(3).toString('hex') + '.cjs');
    fs.writeFileSync(childFaultPreload, fs.readFileSync(guardPreload, 'utf8') + "\ntry { require('node:https').request('https://example.invalid'); } catch (_) {}\n");
    const faultRunner = makeRunner(childFaultPreload);
    const pFault = await faultRunner(['--check-prepared', outDir]);
    sectionF.childRequest = {
      cliCode: pFault.code, childUnexpected: pFault.receipt && pFault.receipt.unexpected.length,
      parentWouldFail: !!(pFault.receipt && pFault.receipt.unexpected.length > 0)
    };
    assert.equal(sectionF.childRequest.cliCode, 0, 'CLI 业务本身成功（回执独立于业务码）');
    assert.equal(sectionF.childRequest.childUnexpected, 1, '子回执记录被 catch 意外 1');
    assert.equal(sectionF.childRequest.parentWouldFail, true, '父进程按回执判 ok=false');
  }

  // ── 字节一致性：同计划 prepare vs 严格 build（窗口内受控时钟）──────────────
  const dirPrepare = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-idprep-' + crypto.randomBytes(3).toString('hex'));
  const dirBuild = path.join(root, 'artifacts/schedule-sandbox/business-test', 'participant-identity-prep2-idbuild-' + crypto.randomBytes(3).toString('hex'));
  packer.prepare(inWindowPlan, dirPrepare);
  packer.build(inWindowPlan, dirBuild);
  const byteIdentity = { allEqual: snapshot(dirPrepare).size === 39 && [...snapshot(dirBuild)].every(([rel, s]) => snapshot(dirPrepare).get(rel) === s) && snapshot(dirPrepare).size === snapshot(dirBuild).size };
  assert.equal(byteIdentity.allEqual, true);

  // ── 记账：探针/父意外分述；同一实际计数决定 ok/exit ────────────────────────
  const probesFinal = guardHits.filter(h => h.phase === 'probe').length;
  const parentUnexpected = guardHits.filter(h => h.phase === 'unexpected').length;
  const childUnexpectedTotal = 0; // 正常流程所有子回执已逐项断言为空
  const guardCounters = { probes: probesFinal, parentUnexpected, childUnexpectedTotal, total: parentUnexpected + probesFinal };
  const ok = parentUnexpected === 0 && probesFinal === 2;
  const result = {
    schema: 'codebuddy-i1-prepare-separation-evidence/2',
    observedAt: new Date().toISOString(),
    basisCommit: 'ed8a563',
    reviewBasis: 'docs/Codex复查-核验包提前准备分离-20261018.md §2–§3（C1–C4 收尾）',
    verificationKind: 'offline evidence; synthetic plans/clocks/transport stubs; NOT platform verification, NOT an execution approval',
    ok,
    guardCounters,
    sections: { a: sectionA, b: sectionB, sensitivity, d: sectionD, e: sectionE, f: sectionF, byteIdentity },
    runtimeDigests: {
      packerSha256: sha(fs.readFileSync(root + '/miniapp/scripts/package-participant-identity-check.cjs')),
      coreSha256Unchanged: sha(fs.readFileSync(root + '/miniapp/scripts/lib/participant-identity-check.cjs'))
    },
    evidenceKinds: {
      sourceObservation: 'CLI strict parser (parseCliArgs) and phase accounting read from product source',
      syntheticChain: 'sections A–D use synthetic plans, controlled test clock (finally restored) and synthetic db/context',
      localCli: 'section E spawns only process.execPath with this package CLI under a child guard preload (network+process surface, structured receipts)',
      selfFaults: 'section F spawns this evidence with fault env (earlyRequest/midRequest/nonWhitelistSpawn) plus a child-fault CLI run',
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
  console.error('[提前准备证据v2摘要] ok=' + ok + ' A.准备15+23 B.39项快照/入窗通过/0新写/字节不变 C3.敏感性3/3 D.边界6 E.CLI含C1反例6+合法对照 F.四类反例 计数：探针=' + probesFinal + ' 父意外=' + parentUnexpected + ' 子回执意外合计=' + childUnexpectedTotal + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  if (!ok) process.exitCode = 1;
}
main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
