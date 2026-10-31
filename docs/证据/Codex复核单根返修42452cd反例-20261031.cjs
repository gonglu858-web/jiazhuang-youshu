'use strict';
// Independent review: real JS modules, synthetic OS boundaries only; no C# execution.
const guard = { probes: 0, unexpected: 0 }; let probing = false;
function deny() { guard[probing ? 'probes' : 'unexpected']++; throw Error('REVIEW_OS_BLOCKED'); }
const cp = require('node:child_process'); cp.ChildProcess.prototype.spawn = deny;
const socketProto = require('node:net').Socket.prototype;
for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = deny;
for (const id of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns']) {
  const m = require(id);
  if (id === 'node:net') m.Socket.prototype.connect = deny;
  if (id === 'node:dns') for (const k of Object.keys(m.promises)) if (typeof m.promises[k] === 'function') m.promises[k] = deny;
  for (const k of Object.keys(m)) if (typeof m[k] === 'function') Object.defineProperty(m, k, { value: deny, configurable: true });
}
globalThis.fetch = deny;
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm'), assert = require('node:assert/strict');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const dir = __dirname, root = path.resolve(dir, '../..');
const names = {
  driver: 'CodexL2单根产物绑定与单次驱动v2-20261031.cjs',
  audit: 'CodexL2单根对照离线核验v4-20261031.cjs',
  ccfg: 'CodexL2单根对照固定编译配置v2-20261031.json',
  contract: 'CodexL2单根对照回执契约v2-20261031.cjs',
  config: 'CodexL2单根对照固定接口v2-20261031.json',
  run: 'CodexL2单根Run合成边界夹具v2-20261031.cs'
};
const read = n => fs.readFileSync(path.join(dir, n));
const results = [];
function test(name, fn) { try { results.push({ name, matched: true, facts: fn() }); } catch (e) { results.push({ name, matched: false, error: e.code || e.message }); } }
function capture(fn) { try { return { value: fn() }; } catch (e) { return { error: e.message, facts: e.facts || null, report: e.report || null }; } }
function product() {
  const b = Buffer.alloc(0x800), pe = 0x80, opt = pe + 24, sect = opt + 240;
  b.write('MZ'); b.writeUInt32LE(pe, 60); b.write('PE\0\0', pe, 'latin1');
  b.writeUInt16LE(0x8664, pe + 4); b.writeUInt16LE(3, pe + 6); b.writeUInt16LE(240, pe + 20); b.writeUInt16LE(0x20b, opt);
  b.writeUInt32LE(0x800, opt + 56); b.writeUInt32LE(0x400, opt + 60);
  for (let i = 0; i < 3; i++) {
    b.writeUInt32LE(0x400, sect + i * 40 + 8); b.writeUInt32LE(0x1000 + i * 0x400, sect + i * 40 + 12);
    b.writeUInt32LE(0x200, sect + i * 40 + 16); b.writeUInt32LE(0x200 + i * 0x200, sect + i * 40 + 20);
  }
  b.writeUInt32LE(0x1000, opt + 112 + 14 * 8); b.writeUInt32LE(0x48, opt + 112 + 14 * 8 + 4);
  b.writeUInt32LE(0x48, 0x200); b.writeUInt16LE(2, 0x204); return b;
}
const configRaw = read(names.config), cfg = JSON.parse(configRaw);
const receipt = {
  schema: 'codex-l2-root-only-job/1', mode: 'rootOnly', outcome: 'completed', reason: 'NONE',
  created: true, assigned: true, resumed: true, pid: 100, rootExited: true, rootExit: 0, jobEmpty: true,
  totalProcesses: 1, activeProcesses: 0, killRequested: false, killAccepted: false, readersDone: true,
  handlesClosed: true, cleanupConfirmed: true, stdoutBytes: 12, stderrBytes: 0,
  stdoutBase64: Buffer.from('L2_ROOT_ONLY').toString('base64'), elapsedMs: 100, accountingLayoutVerified: true,
  observation: { failure: 'NONE', identityCoverage: true, parentEvidenceComplete: false, notificationCompletenessGuaranteed: false,
    stopped: true, handlesClosed: true, duplicateNew: false, finalTotal: 1,
    events: [{ kind: 'NEW', pid: 100 }, { kind: 'EXIT', pid: 100 }, { kind: 'ACTIVE_ZERO', pid: 0 }],
    members: [{ pid: 100, creationTime: '1', image: 'FIXED_NODE', pathClass: 'FIXED_NODE_PATH', state: 'CAPTURED', root: true, parent: 'UNKNOWN', newSeen: true, listed: true, exitSeen: true }] }
};
function boundary(o = {}) {
  const log = { spawn: 0, kill: 0, wait: 0, hold: 0, release: 0, heldPath: null, spawnPath: null, args: null, killAtFirstWait: null };
  return {
    log, productPath: 'C:\\synthetic\\bound.exe',
    receiptExistsBefore() { return !!o.exists; }, guardUnexpected() { return 0; },
    digestFile(p) {
      if (o.postDigestThrow && log.spawn) throw Error('SYNTHETIC_DIGEST_ERROR');
      const s = cfg.sources.find(x => x.rel === p); return s ? (o.drift ? 'drift' : s.sha256) : H(product());
    },
    holdProduct(p) { log.hold++; log.heldPath = p; return { sha256: o.badDigest ? 'wrong' : H(product()), holdToken: {} }; },
    releaseHold() { log.release++; if (o.releaseThrow) throw Error('SYNTHETIC_RELEASE_ERROR'); return o.releaseFalse ? false : true; },
    spawn(a) { log.spawn++; log.spawnPath = a.artifactPath; log.args = a.args; return { onData(cb) {
      if (o.subscribeThrow) throw Error('SYNTHETIC_SUBSCRIBE_ERROR');
      cb(false, o.stdout === undefined ? Buffer.from(JSON.stringify(receipt)) : o.stdout);
    } }; },
    awaitExit() {
      log.wait++; if (log.wait === 1) log.killAtFirstWait = log.kill;
      if (o.waitThrow) throw Error('SYNTHETIC_WAIT_ERROR');
      return o.timeout ? { timedOut: true, closed: false } : { status: 0, signal: null, closed: true };
    },
    kill() { log.kill++; if (o.killThrow) throw Error('SYNTHETIC_KILL_ERROR'); return true; }
  };
}

// Full submitted audit in an isolated realm. All process/network objects are inert.
// Only named evidence files, repository HEAD/ref, and AGENTS may be read.
function auditVm(mutateConfig, contractLoadDrift = false) {
  const allowed = new Set([...Object.values(names), 'CodexL2单根对照辅助层v2-20261031.cs',
    'CodexL2单根对照离线核验v2-20261031.json', 'CodexL2单根收尾夹具准备v1-20261031.cjs',
    'CodexL2单根收尾合成夹具v1-20261031.cs', 'CodexL2单根Run合成边界准备v2-20261031.cjs', 'CodexL2成员观察器v3-20261028.cs']);
  const ccfg = JSON.parse(read(names.ccfg)); if (mutateConfig) mutateConfig(ccfg);
  const headPath = path.join(root, '.git', 'HEAD'), head = fs.readFileSync(headPath, 'utf8').trim();
  const meta = new Set([headPath, path.join(root, 'AGENTS.md')]); if (head.startsWith('ref: ')) meta.add(path.join(root, '.git', head.slice(5)));
  const processMock = { argv: ['synthetic-node', path.join(dir, names.audit)], exitCode: 0 };
  const context = vm.createContext({ Buffer, TextDecoder, process: processMock });
  const mocks = {}, cache = new Map(); let output = '', loadedContractHash = null;
  const no = () => { throw Error('VM_FALLBACK_BLOCKED'); };
  for (const k of ['child_process', 'http', 'https', 'net', 'tls', 'dgram', 'dns']) mocks['node:' + k] = { spawn: no, request: no, connect: no, lookup: no };
  mocks['node:child_process'].ChildProcess = function () {}; mocks['node:child_process'].ChildProcess.prototype.spawn = no;
  mocks['node:net'].Socket = function () {}; mocks['node:net'].Socket.prototype.connect = no;
  mocks['node:dns'].promises = { lookup: no };
  function bytes(p) {
    const resolved = path.resolve(String(p)); if (meta.has(resolved)) return fs.readFileSync(resolved);
    assert.equal(path.dirname(resolved), dir); const n = path.basename(resolved); assert.ok(allowed.has(n));
    return n === names.ccfg ? Buffer.from(JSON.stringify(ccfg)) : read(n);
  }
  const fakeFs = { readFileSync(p, enc) { const b = bytes(p); return enc ? b.toString(enc) : b; }, existsSync() { return false; },
    writeFileSync: no, writeSync(fd, s) { assert.equal(fd, 1); output += String(s); } };
  function load(n) {
    if (cache.has(n)) return cache.get(n).exports;
    const module = { exports: {} }; cache.set(n, module);
    let src = bytes(path.join(dir, n));
    if (n === names.contract) { if (contractLoadDrift) src = Buffer.concat([src, Buffer.from('\n// synthetic load-time drift\n')]); loadedContractHash = H(src); }
    const requireMock = id => {
      if (id === 'node:fs') return fakeFs; if (id === 'node:path') return path; if (id === 'node:crypto') return crypto;
      if (id === 'node:assert/strict') return assert; if (mocks[id]) return mocks[id];
      assert.ok(id.startsWith('./')); return load(path.basename(id));
    };
    context.__load = { module, requireMock, dirname: dir, filename: path.join(dir, n) };
    new vm.Script('(function(require,module,exports,__dirname,__filename){' + src.toString('utf8') + '\n})(__load.requireMock,__load.module,__load.module.exports,__load.dirname,__load.filename);', { filename: n }).runInContext(context, { timeout: 3000 });
    return module.exports;
  }
  load(names.audit); const r = JSON.parse(output);
  return { ok: r.ok, exitCode: processMock.exitCode, checks: r.checks, failed: r.results?.filter(x => !x.ok).map(x => x.name),
    checkedContractHash: r.digests?.contract, loadedContractHash };
}

try {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || args.length === 2 && args[0] === '--out' && args[1].trim() && !args[1].startsWith('--'));
  if (args.length) assert.equal(fs.existsSync(args[1]), false);
  probing = true;
  for (const f of [() => cp.spawn('blocked'), () => require('node:https').request('blocked'), () => socketProto.connect(), () => require('node:dns').promises.lookup('blocked'), () => fetch('blocked')]) assert.throws(f, /REVIEW_OS_BLOCKED/);
  probing = false;
  assert.equal(H(read(names.driver)), 'bf9577f9a9155ce5861eed95fd2d10f2fca1ccbf0fee9c17f9e26ae3ec38ab23');
  assert.equal(H(read(names.audit)), '49e7228454d659ff8663de5c4774fcf0baa53e95ec7e74f449b4f3214b557d04');
  const m = require('./' + names.driver), bind = () => m.bind(configRaw, product());
  test('positive: observed receipt and released hold', () => { const b = boundary(), r = m.createRunner(bind(), b).runOnce(); assert.equal(r.ok, true); assert.equal(r.holdReleased, true); return b.log; });
  for (const [label, opts, code] of [['sources', { drift: true }, 'SOURCES_DRIFTED'], ['receipt', { exists: true }, 'RECEIPT_EXISTS']])
    test('closed: preflight ' + label + ' zero spawn', () => { const b = boundary(opts), r = capture(() => m.createRunner(bind(), b).runOnce()); assert.equal(r.error, code); assert.equal(b.log.spawn, 0); return b.log; });
  test('closed: caller bytes mutation isolated', () => { const bytes = product(), b = m.bind(configRaw, bytes); bytes.fill(0); assert.equal(H(b.bytes), b.artifactSha256); return { copied: true }; });
  test('closed: empty stdout refuses', () => { const r = capture(() => m.createRunner(bind(), boundary({ stdout: Buffer.alloc(0) })).runOnce()); assert.ok(r.error); return { refused: true }; });
  test('R1 symbol reflection forges binding and config', () => {
    const donor = bind(), symbol = Object.getOwnPropertySymbols(donor)[0]; assert.ok(symbol);
    const fake = { [symbol]: { ...donor[symbol] }, config: { ...cfg, sources: [], helperArgs: ['not-rootOnly'] }, artifactSha256: donor.artifactSha256 };
    const b = boundary(), r = m.createRunner(fake, b).runOnce(); assert.equal(r.ok, true); assert.deepEqual(b.log.args, ['not-rootOnly']); return { ok: r.ok, forgedConfigDelivered: true };
  });
  test('R1 reflected state resets consumption', () => {
    const binding = bind(), symbol = Object.getOwnPropertySymbols(binding)[0], b = boundary(), runner = m.createRunner(binding, b);
    assert.equal(runner.runOnce().ok, true); binding[symbol].consumed = false; assert.equal(runner.runOnce().ok, true); assert.equal(b.log.spawn, 2); return { launches: 2 };
  });
  test('R1 path getter changes between hold and launch', () => {
    const b = boundary(); let reads = 0;
    Object.defineProperty(b, 'productPath', { get() { return ++reads === 4 ? 'C:\\synthetic\\different.exe' : 'C:\\synthetic\\bound.exe'; } });
    const r = m.createRunner(bind(), b).runOnce(); assert.equal(r.ok, true); assert.notEqual(b.log.heldPath, b.log.spawnPath); return { ok: r.ok, reads, heldPath: b.log.heldPath, spawnPath: b.log.spawnPath };
  });
  test('R1 CLR maps virtual tail beyond raw section', () => {
    const b = product(); b.writeUInt32LE(0x1300, 0x80 + 24 + 112 + 14 * 8); b.writeUInt32LE(0x48, 0x500); b.writeUInt16LE(2, 0x504);
    assert.equal(m.inspectProduct(b).clrHeaderPresent, true); return { accepted: true, sectionRawBytes: 512, clrOffsetWithinSection: 768 };
  });
  test('R2 digest mismatch leaks held token before try', () => {
    const b = boundary({ badDigest: true }), r = capture(() => m.createRunner(bind(), b).runOnce());
    assert.equal(r.error, 'PRODUCT_DIGEST_MISMATCH'); assert.equal(b.log.spawn, 0); assert.equal(b.log.hold, 1); assert.equal(b.log.release, 0); return b.log;
  });
  test('R2 release throw still returns success', () => {
    const b = boundary({ releaseThrow: true }), r = m.createRunner(bind(), b).runOnce(); assert.equal(r.ok, true); assert.equal(r.holdReleased, false); return { ok: r.ok, holdReleased: r.holdReleased };
  });
  test('R2 release false is reported released', () => {
    const b = boundary({ releaseFalse: true }), r = m.createRunner(bind(), b).runOnce(); assert.equal(r.ok, true); assert.equal(r.holdReleased, true); return { ok: r.ok, underlyingRelease: false, holdReleased: r.holdReleased };
  });
  test('R2 postcheck throw skips release and escapes raw', () => {
    const b = boundary({ postDigestThrow: true }), r = capture(() => m.createRunner(bind(), b).runOnce()); assert.equal(r.error, 'SYNTHETIC_DIGEST_ERROR'); assert.equal(r.facts, null); assert.equal(b.log.release, 0); return { ...b.log, sanitizedFacts: false };
  });
  test('R2 cleanup await throw escapes raw', () => {
    const b = boundary({ waitThrow: true }), r = capture(() => m.createRunner(bind(), b).runOnce()); assert.equal(r.error, 'SYNTHETIC_WAIT_ERROR'); assert.equal(r.facts, null); return { ...b.log, sanitizedFacts: false };
  });
  test('R2 subscription failure not stopped before normal wait', () => {
    const b = boundary({ subscribeThrow: true }), r = capture(() => m.createRunner(bind(), b).runOnce()); assert.equal(r.facts.failure, 'READ'); assert.equal(b.log.killAtFirstWait, 0); assert.equal(b.log.kill, 0); return b.log;
  });
  test('R2 kill exception escapes raw from cleanup', () => {
    const b = boundary({ timeout: true, killThrow: true }), r = capture(() => m.createRunner(bind(), b).runOnce()); assert.equal(r.error, 'SYNTHETIC_KILL_ERROR'); assert.equal(r.facts, null); return { ...b.log, sanitizedFacts: false };
  });
  test('positive: actual audit VM control', () => { const r = auditVm(); assert.equal(r.ok, true); assert.equal(r.checks, 44); return r; });
  const mutations = [
    ['host path', c => { c.host.path = 'C:\\synthetic\\unapproved.exe'; }],
    ['reference path and digest', c => { c.toolFacts.references[0].path = 'C:\\synthetic\\unapproved.dll'; c.toolFacts.references[0].sha256 = '0'.repeat(64); c.cases[0].args = c.cases[0].args.map(a => a.startsWith('/reference:') && a.includes('mscorlib') ? '/reference:C:\\synthetic\\unapproved.dll' : a); }],
    ['environment shell limits cwd', c => { c.spawn.shell = true; c.spawn.timeoutMs = 999999; c.spawn.maxCombinedOutputBytes = 99999999; c.cases[0].childEnv.NODE_OPTIONS = 'synthetic'; c.cwd = 'C:\\synthetic'; }],
    ['wrong main argument', c => { c.cases[0].args = c.cases[0].args.map(a => a.startsWith('/main:') ? '/main:OtherEntry' : a); }],
    ['missing observer compiler argument', c => { c.cases[0].args = c.cases[0].args.filter(a => !a.endsWith('CodexL2成员观察器v3-20261028.cs')); }],
    ['coordinated input path move', c => { const old = c.inputs[0].path, next = 'C:\\synthetic\\' + path.basename(old); c.inputs[0].path = next; for (const x of c.cases) { x.sourceFiles = x.sourceFiles.map(v => v === old ? next : v); x.args = x.args.map(v => v === old ? next : v); } }]
  ];
  for (const [label, change] of mutations) test('R3 audit accepts ' + label, () => { const r = auditVm(change); assert.equal(r.ok, true); assert.equal(r.exitCode, 0); return r; });
  test('R4 separately loaded contract differs from checked snapshot', () => {
    const r = auditVm(null, true); assert.equal(r.ok, true); assert.notEqual(r.checkedContractHash, r.loadedContractHash); return r;
  });
  const src = read(names.run).toString('utf8');
  test('R5 source declaration and signature contradictions (not compilation)', () => {
    assert.ok(src.includes('r.Mode=mode') && !/\bstring\s+mode\b/.test(src));
    assert.ok(src.includes('object nodeHold=null;') && src.includes('object nodeHold=Hook.Hold(scenario);'));
    assert.ok(src.includes('Hook.PlanReads(') && src.indexOf('void PlanReads(') < src.indexOf('internal static class Hook'));
    assert.ok(src.includes('Require(bool ok, string code)') && src.includes('Require(Unexpected==0)'));
    for (const type of ['ProcessInfo', 'ExtendedLimit', 'Startup']) assert.ok(!new RegExp('(?:class|struct)\\s+' + type + '\\b').test(src));
    assert.ok(!src.includes('using System.Text;') && src.includes('StringBuilder'));
    return { undeclaredMode: true, duplicateHold: true, misplacedPlanReads: true, requireArityMismatch: true, missingTypes: ['ProcessInfo', 'ExtendedLimit', 'Startup'], missingTextImport: true };
  });
  test('R5 source has unbound OS call names despite capability ban', () => {
    const list = ['CloseHandle', 'AssignProcessToJobObject', 'TerminateJobObject', 'TerminateProcess'];
    for (const n of list) { assert.ok(src.includes(n + '(')); assert.ok(!new RegExp('(?:bool|uint|int|void)\\s+' + n + '\\s*\\(').test(src)); }
    return { undefinedCalls: list, noNativeInvocation: true };
  });
  test('R5 scenario wiring and result contradictions (source only)', () => {
    assert.equal((src.match(/FailAt\s*=\s*"NONE"/g) || []).length, 2);
    assert.equal((src.match(/FailAt\s*=(?!=)/g) || []).length, 2);
    assert.ok(src.includes('expected="completed"') && src.includes('Reason="NONE"') && !src.includes('Reason="completed"'));
    assert.ok(src.includes('Want("TREE_COUNT")') && src.includes('else{r.Total=1;r.Active=0;}'));
    assert.ok(src.includes('byte[] big=new byte[131073];big.CopyTo(buf,0)') && src.includes('byte[] buffer = new byte[4096]'));
    assert.ok(!/Unexpected\s*(?:\+\+|\+=|=(?!=))/.test(src));
    return { failTableNotAssigned: true, successReasonWrong: true, treeCountAlwaysOneOutsideMemberLimit: true, oversizedCopyBeforeLimitObservation: true, unexpectedNotRecorded: true };
  });
  const runtimeDigests = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, H(read(n))]));
  runtimeDigests.self = H(fs.readFileSync(__filename));
  const ok = results.every(r => r.matched) && guard.unexpected === 0;
  const report = { schema: 'codex-rootonly-rework-review/1', reviewedCommit: '42452cd', basis: 'aac8890',
    kind: 'real JavaScript with synthetic boundaries; C# source observations only', results, checks: results.length, guard, runtimeDigests,
    ok, exitCode: ok ? 0 : 1, compiled: false, nativeLaunched: false, executionApproved: false };
  const text = JSON.stringify(report, null, 2) + '\n'; if (args.length) fs.writeFileSync(args[1], text, { flag: 'wx' });
  fs.writeSync(1, text); process.exitCode = report.exitCode;
} catch (e) { probing = false; fs.writeSync(1, JSON.stringify({ ok: false, guard, error: e.code || e.message }) + '\n'); process.exitCode = 1; }
