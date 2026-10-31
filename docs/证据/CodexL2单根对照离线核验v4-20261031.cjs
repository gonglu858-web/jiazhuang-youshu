'use strict';
// L2 root-only full-module rework verification v4 (R1–R5).
// Public process/network APIs are blocked before any contract/config load.
const guard = { probes: 0, unexpected: 0 }; let probing = false;
function deny() { guard[probing ? 'probes' : 'unexpected']++; throw Error('OFFLINE_BLOCKED'); }
const cp = require('node:child_process'); cp.ChildProcess.prototype.spawn = deny;
const socketPrototype = require('node:net').Socket.prototype;
for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = deny;
for (const id of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns']) {
  const m = require(id);
  if (id === 'node:net') m.Socket.prototype.connect = deny;
  if (id === 'node:dns') for (const k of Object.keys(m.promises)) if (typeof m.promises[k] === 'function') m.promises[k] = deny;
  for (const k of Object.keys(m)) if (typeof m[k] === 'function') Object.defineProperty(m, k, { value: deny, configurable: true });
}
globalThis.fetch = deny;
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const results = []; function test(name, fn) { try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: (e.code && e.code !== 'ERR_ASSERTION') ? e.code : ((e.message || 'ASSERTION_FAILED') + ' | ' + (e.operator || '') + ' ' + (e.expected !== undefined ? String(e.expected).slice(0, 40) : '')).slice(0, 220) }); } }
const dir = __dirname, read = n => fs.readFileSync(path.join(dir, n));
const names = {
  helper: 'CodexL2单根对照辅助层v2-20261031.cs', config: 'CodexL2单根对照固定接口v2-20261031.json',
  contract: 'CodexL2单根对照回执契约v2-20261031.cjs', offlineV2: 'CodexL2单根对照离线核验v2-20261031.json',
  fixtureBuilder: 'CodexL2单根收尾夹具准备v1-20261031.cjs', fixture: 'CodexL2单根收尾合成夹具v1-20261031.cs',
  driver: 'CodexL2单根产物绑定与单次驱动v2-20261031.cjs',
  ccfg: 'CodexL2单根对照固定编译配置v2-20261031.json',
  runPrep: 'CodexL2单根Run合成边界准备v2-20261031.cjs', runFixture: 'CodexL2单根Run合成边界夹具v2-20261031.cs'
};
const PINNED = {
  helper: '408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b',
  config: '1518269f0918b03052fec0540ac7a8934484341ec379445e86d86508685f98ce',
  contract: '2029ca70c718bd56f151448c5fd95db9d5e9e1c52bd63573d8907b849915bae7',
  fixtureBuilder: 'c22a543113d979994d5d84e3a3ae76c38c3e7db007a9d4d61cbd07b58d718858',
  fixture: '9b76b6af754992cbb69b6a77c24191f16ed0132d6028a214118f31aed2840fd2',
  observer: '722d28e9e2f145d9bcf4e00fb82ee4837ec4b365d53bdd86b4472a6228fd9019'
};
let report;
try {
  const args = process.argv.slice(2), fault = args.length === 1 && args[0] === '--fault-caught';
  assert.ok(args.length === 0 || fault || (args.length === 2 && args[0] === '--out' && args[1].trim() && !args[1].startsWith('--')));
  if (args.length === 2) assert.equal(fs.existsSync(args[1]), false);
  probing = true;
  for (const fn of [() => cp.spawn('denied'), () => require('node:https').request('denied'), () => socketPrototype.connect(), () => require('node:dns').promises.lookup('denied'), () => fetch('denied')]) assert.throws(fn, /OFFLINE_BLOCKED/);
  probing = false; assert.equal(guard.probes, 5);
  const bytes = {};
  for (const [k, n] of Object.entries(names)) bytes[k] = read(n);
  const configBytes = bytes.config;
  // R4 identity fields are separated and the runtime HEAD is recorded, not gated.
  function ROOT2() { return path.resolve(dir, '../..'); }
  const report_Identity = {
    techBaseline: 'dac82a2', handoverBaseline: 'aac8890', reviewedImplementation: '4dbb317',
    runtimeHead: null, runtimeHeadGated: false, agentsWorktreeSha256Prefix: null
  };
  {
    const head = fs.readFileSync(path.join(ROOT2(), '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref: (.+)$/.exec(head);
    report_Identity.runtimeHead = (m ? fs.readFileSync(path.join(ROOT2(), '.git', m[1]), 'utf8').trim() : head).slice(0, 7);
  }
  report_Identity.agentsWorktreeSha256Prefix = H(fs.readFileSync(path.join(ROOT2(), 'AGENTS.md'))).slice(0, 20);
  // R4: every loaded byte is checked against its reviewed digest (drift refuses).
  function checkLoaded(buf, expectedSha, label) { assert.equal(H(buf), expectedSha, 'SOURCE_DRIFT:' + label); return true; }
  // ── R4: loaded-byte bindings + identity/口径分列 ──
  test('R4 loaded helper bytes match reviewed digest', () => checkLoaded(bytes.helper, PINNED.helper, 'helper'));
  test('R4 loaded contract bytes match reviewed digest', () => checkLoaded(bytes.contract, PINNED.contract, 'contract'));
  test('R4 loaded fixed config bytes match reviewed digest', () => checkLoaded(bytes.config, PINNED.config, 'config'));
  test('R4 loaded fixture/fixtureBuilder bytes match reviewed digests', () => {
    checkLoaded(bytes.fixture, PINNED.fixture, 'fixture'); checkLoaded(bytes.fixtureBuilder, PINNED.fixtureBuilder, 'fixtureBuilder');
  });
  test('R4 loaded observer dependency matches reviewed digest', () => checkLoaded(read('CodexL2成员观察器v3-20261028.cs'), PINNED.observer, 'observer'));
  test('R4 source-drift counterexample: injected comment on contract refuses', () => {
    const drifted = Buffer.concat([bytes.contract, Buffer.from('\n// injected comment\n')]);
    assert.throws(() => checkLoaded(drifted, PINNED.contract, 'contract'), /SOURCE_DRIFT/);
  });
  test('R4 source-drift counterexample: mutated helper byte refuses', () => {
    const drifted = Buffer.from(bytes.helper); drifted[drifted.length - 1] ^= 1;
    assert.throws(() => checkLoaded(drifted, PINNED.helper, 'helper'), /SOURCE_DRIFT/);
  });
  test('R4 v2 reused evidence still matches its recorded conclusions', () => {
    const v2 = JSON.parse(bytes.offlineV2.toString('utf8'));
    assert.equal(v2.ok, true); assert.equal(v2.checks, 81); assert.equal(v2.guard.unexpected, 0);
    assert.equal(v2.runtimeDigests.helper, PINNED.helper);
  });
  test('R4 identity fields are separated and runtime HEAD is recorded, not gated', () => {
    assert.equal(report_Identity.techBaseline, 'dac82a2');
    assert.equal(report_Identity.handoverBaseline, 'aac8890');
    assert.equal(report_Identity.reviewedImplementation, '4dbb317');
    assert.ok(/^[0-9a-f]{7}$/.test(report_Identity.runtimeHead));
    assert.equal(report_Identity.runtimeHeadGated, false);
    assert.equal(report_Identity.agentsWorktreeSha256Prefix, 'f2b27c15f3d725fcb25f');
  });

  // ── R3: compile config v2 with dependency closure, strict fields, single-target semantics ──
  const ccfg = JSON.parse(bytes.ccfg.toString('utf8'));
  function checkCompileConfig(c) {
    assert.equal(c.schema, 'codex-l2-rootonly-compile-config/2');
    assert.equal(c.executionAuthorized, false); assert.equal(c.artifactExecutionApproved, false);
    assert.deepEqual(c.singleCompile, { maxDirectCompilerStarts: 1, automaticRetry: false, failureStopsAll: true, note: '每次获准仅选定一个用例并编译一次；异常即停、不重试；编译产物不运行；多用例清单不默认批跑' });
    assert.equal(c.selection.policy, 'single-target-per-authorization');
    assert.equal(c.postcheck.executeOutput, false); assert.equal(c.postcheck.executionAllowed, false);
    assert.equal(c.toolFacts.source, 'historical');
    assert.equal(c.cases.length, 3);
    // strict: compiler/refs/host exact, full args, inputs<->sourceFiles full paths
    assert.equal(c.toolFacts.compiler.path, 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
    assert.equal(c.toolFacts.compiler.sha256, '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00');
    assert.equal(c.toolFacts.references.length, 3);
    const inputByPath = new Map(c.inputs.map(i => [i.path, i.sha256]));
    for (const cs of c.cases) {
      assert.equal(cs.expectedExitCode, 0);
      assert.ok(!cs.args.some(a => a.startsWith('/unsafe')));
      assert.equal(cs.args.filter(a => a.startsWith('/reference:')).length, c.toolFacts.references.length);
      for (const sf of cs.sourceFiles) assert.ok(inputByPath.has(sf), 'source not in inputs: ' + sf);
      for (const a of cs.args) if (a.endsWith('.cs')) assert.ok(cs.sourceFiles.includes(a), 'arg source not listed: ' + a);
      assert.equal(cs.outputFile, cs.args.find(a => a.startsWith('/out:')).slice('/out:'.length));
      assert.equal(cs.childEnv.TEMP, cs.tempRoot); assert.equal(cs.childEnv.TMP, cs.tempRoot);
    }
    // dependency closure: helper case must include the observer source
    const helperCase = c.cases.find(x => x.id === 'rootOnlyHelper');
    assert.ok(helperCase.sourceFiles.some(p => p.includes('CodexL2成员观察器v3-20261028.cs')), 'observer dependency missing');
    assert.equal(c.cases.find(x => x.id === 'runBoundaryFixture').sourceFiles.length, 1);
    return true;
  }
  test('R3 compile config v2 validates with dependency closure', () => assert.equal(checkCompileConfig(ccfg), true));
  test('R3 compile config inputs match repo bytes', () => {
    for (const i of ccfg.inputs) assert.equal(H(read(path.basename(i.path))), i.sha256);
  });
  for (const [path_, value] of [
    ['executionAuthorized', true], ['artifactExecutionApproved', true],
    ['singleCompile.maxDirectCompilerStarts', 2], ['singleCompile.automaticRetry', true],
    ['postcheck.executeOutput', true], ['postcheck.executionAllowed', true],
    ['cases', []], ['toolFacts.compiler.path', 'C:\\other\\compiler-bin.exe'],
    ['cases.0.args', null], ['cases.0.sourceFiles', null]
  ]) test('R3 compile config rejects ' + path_, () => {
    const clone = JSON.parse(JSON.stringify(ccfg));
    const ks = path_.split('.'); let t = clone; while (ks.length > 1) t = t[ks.shift()];
    if (value === null) { if (ks[0] === 'args') t[ks[0]] = [...t[ks[0]], '/unsafe+']; else t[ks[0]] = [...t[ks[0]], 'C:\\other\\extra.cs']; }
    else t[ks[0]] = value;
    assert.throws(() => checkCompileConfig(clone));
  });
  test('R3 compile config rejects moved input directory (full-path check)', () => {
    const clone = JSON.parse(JSON.stringify(ccfg));
    clone.inputs[0].path = 'C:\\elsewhere\\' + path.basename(clone.inputs[0].path);
    assert.throws(() => {
      const inputByPath = new Map(clone.inputs.map(i => [i.path, i.sha256]));
      for (const cs of clone.cases) for (const sf of cs.sourceFiles) assert.ok(inputByPath.has(sf), 'SOURCE_MOVED');
    }, /SOURCE_MOVED/);
  });
  test('R3 single-target selection returns one case and refuses unknown', () => {
    function selectSingleTarget(c, id) {
      const cs = c.cases.find(x => x.id === id);
      if (!cs) throw Error('CASE_UNKNOWN');
      return { id: cs.id, compileStarts: 1, outputFile: cs.outputFile, main: cs.main };
    }
    const a = selectSingleTarget(ccfg, 'rootOnlyHelper');
    assert.equal(a.compileStarts, 1); assert.equal(a.main, 'L2MemberRunner');
    const b = selectSingleTarget(ccfg, 'runBoundaryFixture');
    assert.equal(b.compileStarts, 1); assert.equal(b.main, 'RootOnlyRunBoundaryFixture');
    assert.throws(() => selectSingleTarget(ccfg, 'all'), /CASE_UNKNOWN/);
  });

  // ── R1/R2: driver v2 matrix (forgery, zero-launch, unified cleanup, receipt binding) ──
  const mod = require('./' + names.driver);
  test('driver v2 module has no public process/network surface', () => {
    const src = bytes.driver.toString('utf8').split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(src, /require\('node:(child_process|net|http|https|tls|dgram|dns)'\)/);
    assert.doesNotMatch(src, /(^|[^.\w])spawn\s*\(/);
    assert.ok(src.includes('boundary.spawn') && src.includes('holdProduct') && src.includes('guardUnexpected'));
  });
  function product() {
    const b = Buffer.alloc(0x800, 0); b.write('MZ', 0, 'latin1');
    const pe = 0x80; b.writeUInt32LE(pe, 0x3c); b.write('PE\0\0', pe, 'latin1');
    b.writeUInt16LE(0x8664, pe + 4); b.writeUInt16LE(0x20b, pe + 24);
    b.writeUInt16LE(240, pe + 20);                             // SizeOfOptionalHeader (PE32+ standard)
    b.writeUInt16LE(3, pe + 6);                                // 3 sections
    b.writeUInt32LE(0x800, pe + 24 + 56);                      // SizeOfImage
    b.writeUInt32LE(0x400, pe + 24 + 60);                      // SizeOfHeaders
    const sect = pe + 24 + 240;
    for (let i = 0; i < 3; i++) { b.writeUInt32LE(0x400, sect + i * 40 + 8); b.writeUInt32LE(0x1000 + i * 0x400, sect + i * 40 + 12); b.writeUInt32LE(0x200, sect + i * 40 + 16); b.writeUInt32LE(0x200 + i * 0x200, sect + i * 40 + 20); }
    const clr = pe + 24 + 112 + 14 * 8;
    b.writeUInt32LE(0x1000, clr); b.writeUInt32LE(0x48, clr + 4);
    b.writeUInt32LE(0x48, 0x200); b.writeUInt16LE(2, 0x204);   // COR20 cb + runtime version
    return b;
  }
  const binding = mod.bind(configBytes, product());
  test('R1 binding copies bytes internally; digest stable and diagnostic-only', () => {
    assert.equal(binding.artifactBound, true); assert.equal(binding.executionApproved, false);
    assert.equal(binding.artifactSha256, H(product()));
    assert.deepEqual(binding.statics.sections, 3);
  });
  test('R1 substantive PE checks refuse zero-section/zero-optional/CLR-less images', () => {
    const noClr = Buffer.from(product()); noClr.writeUInt32LE(0, noClr.readUInt32LE(0x3c) + 24 + 112 + 14 * 8);
    assert.throws(() => mod.bind(configBytes, noClr), /PE_CLR/);
    const noSections = Buffer.from(product()); noSections.writeUInt16LE(0, noSections.readUInt32LE(0x3c) + 6);
    assert.throws(() => mod.bind(configBytes, noSections), /PE_SECTIONS/);
    const badMap = Buffer.from(product()); badMap.writeUInt32LE(0x9000, badMap.readUInt32LE(0x3c) + 24 + 224 + 8 + 20);
    assert.throws(() => mod.bind(configBytes, badMap), /PE_SECTION_MAP|PE_CLR_MAP/);
    const smallClr = Buffer.from(product()); smallClr.writeUInt32LE(8, 0x200);
    assert.throws(() => mod.bind(configBytes, smallClr), /PE_CLR_HEADER/);
  });
  test('R1 forged binding objects are refused', () => {
    assert.throws(() => mod.createRunner({ artifactBound: true, config: JSON.parse(configBytes.toString('utf8')) }, {}), /FAKE_BINDING|BOUNDARY_REQUIRED/);
    assert.throws(() => mod.createRunner(Object.freeze({ artifactBound: true, config: binding.config }), {}), /FAKE_BINDING|BOUNDARY_REQUIRED/);
  });
  test('R1 caller-side mutation of bound bytes cannot diverge digest', () => {
    const external = product(); const b2 = mod.bind(configBytes, external);
    external[100] ^= 0xff;                                     // caller mutates original
    assert.equal(b2.artifactSha256, H(product()));
  });
  function makeBoundary(over) {
    const o = {
      drift: 'none', productDrift: 'none', spawnThrows: false, subSpawnThrows: false,
      timedOut: false, closed: true, killOk: true, stderr: 0, stdout: Buffer.from(JSON.stringify(validReceipt)),
      receiptBefore: false, guardUnexpectedCount: 0, partial: false, awaitThrows: false, status: 0, signal: null, ...over
    };
    let spawned = 0, holdReleased = 0, killed = 0;
    const srcSha = rel => JSON.parse(configBytes.toString('utf8')).sources.find(s => s.rel === rel).sha256;
    return {
      productPath: 'C:\\synthetic\\rootonly-helper.exe',
      get _spawnCount() { return spawned; }, get _holdReleased() { return holdReleased; }, get _killed() { return killed; },
      guardUnexpected() { return o.guardUnexpectedCount; },
      receiptExistsBefore() { return o.receiptBefore; },
      digestFile(p) {
        if (p === this.productPath) return o.productDrift === 'after' && spawned > 0 ? 'drifted' : binding.artifactSha256;
        if (o.drift === 'before' && spawned === 0) return 'drifted';
        if (o.drift === 'after' && spawned > 0) return 'drifted';
        return srcSha(p) === undefined ? 'drifted' : srcSha(p);
      },
      holdProduct(p) {
        if (o.productDrift === 'before') return { sha256: 'mismatched', holdToken: 't' };
        if (o.holdFails) throw Error('HOLD_FAIL');
        return { sha256: binding.artifactSha256, holdToken: 't' };
      },
      releaseHold() { holdReleased++; return true; },
      spawn() {
        spawned++;
        if (o.spawnThrows) throw Error('synthetic start failure');
        if (o.partial) { spawned = spawned; throw Error('partial establishment failure'); }
        return {
          onData(cb) {
            if (o.subSpawnThrows) throw Error('subscription failure');
            if (o.stderr) cb(true, Buffer.alloc(o.stderr));
            if (o.stdout) cb(false, o.stdout);
          }
        };
      },
      awaitExit() {
        if (o.awaitThrows) throw Error('wait failure');
        if (o.timedOut) return { status: null, signal: null, closed: o.closedAfterKill !== false, timedOut: true };
        return { status: o.status, signal: o.signal, closed: o.closed };
      },
      kill() { killed++; return o.killOk; }
    };
  }
  const validReceipt = {
    schema: 'codex-l2-root-only-job/1', mode: 'rootOnly', outcome: 'completed', reason: 'NONE', created: true, assigned: true, resumed: true,
    pid: 100, rootExited: true, rootExit: 0, jobEmpty: true, totalProcesses: 1, activeProcesses: 0, killRequested: false, killAccepted: false,
    readersDone: true, handlesClosed: true, cleanupConfirmed: true, stdoutBytes: 12, stderrBytes: 0,
    stdoutBase64: Buffer.from('L2_ROOT_ONLY').toString('base64'), elapsedMs: 100, accountingLayoutVerified: true,
    observation: { failure: 'NONE', identityCoverage: true, parentEvidenceComplete: false, notificationCompletenessGuaranteed: false, stopped: true, handlesClosed: true, duplicateNew: false, finalTotal: 1, events: [{ kind: 'NEW', pid: 100 }, { kind: 'EXIT', pid: 100 }, { kind: 'ACTIVE_ZERO', pid: 0 }], members: [{ pid: 100, creationTime: '1', image: 'FIXED_NODE', pathClass: 'FIXED_NODE_PATH', state: 'CAPTURED', root: true, parent: 'UNKNOWN', newSeen: true, listed: true, exitSeen: true }] }
  };
  const runner = mod.createRunner(binding, makeBoundary({}));
  const freshRunner = b => mod.createRunner(mod.bind(configBytes, product()), b); // each scenario gets its own binding
  test('R2 normal single run: receipt comes from THIS run output; facts are real', () => {
    const r = runner.runOnce();
    assert.equal(r.ok, true); assert.equal(r.assessment.rootOnlyPassed, true);
    assert.equal(r.facts.attempts, 1); assert.equal(r.facts.unexpected, 0);
    assert.equal(r.facts.closed, true); assert.equal(r.holdReleased, true);
    assert.equal(r.executionApproved, false);
  });
  test('R1 same binding across two runners still consumes once', () => {
    const r2 = mod.createRunner(binding, makeBoundary({}));
    assert.throws(() => r2.runOnce(), /ALREADY_RUN/);
  });
  test('R1 forged/zero-product/drift/legacy-receipt refuse with ZERO spawn', () => {
    const probes = [
      ['receipt pre-exists', makeBoundary({ receiptBefore: true })],
      ['sources drift', makeBoundary({ drift: 'before' })],
      ['product digest mismatch', makeBoundary({ productDrift: 'before' })]
    ];
    for (const [label, b] of probes) {
      const rb = freshRunner( b);
      let err = null;
      try { rb.runOnce(); } catch (e) { err = e; }
      assert.ok(err !== null, label + ' must refuse');
      assert.equal(b._spawnCount, 0, label + ' must be zero-launch');
    }
  });
  test('R1 product digest drift after run fails the result', () => {
    const rb = freshRunner( makeBoundary({ productDrift: 'after' }));
    const r = rb.runOnce();
    // 回执本身是真实成功回执（rootOnlyPassed=true），但运行后产物摘要漂移使本次不可作为通过依据
    assert.equal(r.ok, false); assert.equal(r.productUnchanged, false);
    assert.equal(r.assessment.l2Approved, false); assert.equal(r.executionApproved, false);
  });
  test('R2 unified cleanup: spawn throw keeps close unknown and attaches facts', () => {
    const rb = freshRunner( makeBoundary({ spawnThrows: true }));
    let err = null;
    try { rb.runOnce(); } catch (e) { err = e; }
    assert.match(String(err && err.message), /DRIVER_FAILED/);
    assert.equal(err.facts.failure, 'SPAWN_FAILED');
    assert.equal(err.report.closedUnknown, true);
    assert.equal(err.facts.closed, false);
    assert.equal(err.report.holdReleased, true);
  });
  test('R2 unified cleanup: partial establishment failure keeps close unknown', () => {
    const rb = freshRunner( makeBoundary({ partial: true }));
    let err = null;
    try { rb.runOnce(); } catch (e) { err = e; }
    assert.match(String(err && err.message), /DRIVER_FAILED/);
    assert.equal(err.facts.failure, 'SPAWN_FAILED');
    assert.equal(err.report.closedUnknown, true);
  });
  test('R2 unified cleanup: subscription throw inside child wiring is contained', () => {
    const rb = freshRunner( makeBoundary({ subSpawnThrows: true }));
    let err = null;
    try { rb.runOnce(); } catch (e) { err = e; }
    assert.match(String(err && err.message), /DRIVER_FAILED/);
    assert.equal(err.facts.failure, 'READ');
    assert.equal(err.report.holdReleased, true);
  });
  test('R2 immediate stop on stderr/limit with kill and bounded reclaim', () => {
    const bnd = makeBoundary({ stderr: 5, timedOut: false, closed: true });
    const rb = freshRunner(bnd);
    let err = null;
    try { rb.runOnce(); } catch (e) { err = e; }
    assert.match(String(err && err.message), /DRIVER_FAILED/);
    assert.equal(err.facts.failure, 'STDERR');
    assert.ok(err.facts.killRequested === true);
    assert.equal(bnd._killed >= 1, true);
  });
  test('R2 timeout: kill then bounded reclaim, close unknown fails', () => {
    const bnd = makeBoundary({ timedOut: true, closedAfterKill: false });
    const rb = freshRunner(bnd);
    let err = null;
    try { rb.runOnce(); } catch (e) { err = e; }
    assert.match(String(err && err.message), /DRIVER_FAILED/);
    assert.equal(err.facts.failure, 'TIMEOUT');                  // 第一失败保留
    assert.equal(err.report.closedUnknown, true);
    assert.equal(err.facts.closed, false);
    assert.equal(err.report.killAccepted, true);
  });
  test('R2 empty/wrong output cannot be repaired by another channel', () => {
    const empty = freshRunner( makeBoundary({ stdout: Buffer.alloc(0) }));
    let e1 = null; try { empty.runOnce(); } catch (e) { e1 = e; }
    assert.ok(e1 !== null);                                       // empty receipt refused
    const wrong = freshRunner( makeBoundary({ stdout: Buffer.from('wrong') }));
    let e2 = null; try { wrong.runOnce(); } catch (e) { e2 = e; }
    assert.ok(e2 !== null);                                       // wrong-length output refused
  });
  test('R2 unexpected guard counts come from boundary records, not literals', () => {
    const rb = freshRunner( makeBoundary({ guardUnexpectedCount: 2 }));
    let err = null;
    try { rb.runOnce(); } catch (e) { err = e; }
    assert.equal(err.facts.unexpected, 2);
  });
  test('R2 runOne consumption is per binding, visible via consumed', () => {
    assert.equal(runner.consumed, true);
    const fresh = mod.bind(configBytes, product());
    const rr = mod.createRunner(fresh, makeBoundary({ stdout: Buffer.from(JSON.stringify(buildValid())) }));
    assert.equal(rr.consumed, false);
    function buildValid() {
      const r = JSON.parse(JSON.stringify(validReceipt));
      r.stdoutBase64 = Buffer.from(JSON.stringify(r)).toString('base64');
      r.stdoutBytes = Buffer.byteLength(JSON.stringify(r));
      return r;
    }
  });

  // ── R5: full-Run synthetic boundary fixture prepared (not compiled) ──
  const runPrep = require('./' + names.runPrep);
  test('R5 run-boundary fixture regenerates byte-identically from pinned helper', () => {
    const g = runPrep.build(bytes.helper);
    assert.equal(bytes.runFixture.toString('utf8'), g.source);
    assert.equal(g.plannedCases, 20); assert.equal(g.compiled, false); assert.equal(g.executed, false);
  });
  test('R5 run-boundary fixture refuses source drift', () => assert.throws(() => runPrep.build(Buffer.concat([bytes.helper, Buffer.from(' ')])), /SOURCE_DRIFT/));
  test('R5 run-boundary fixture has no OS-facing capability and covers scenarios', () => {
    const src = bytes.runFixture.toString('utf8');
    assert.doesNotMatch(src, /DllImport|static extern|Process\.Start|File\.|Environment\.|Thread\.|Stopwatch\.|Marshal\./);
    assert.equal((src.match(/case \d+: expected=/g) || []).length, 20);
    assert.ok(src.includes('Require(r!=null&&r.Reason==expected)'));
    assert.ok(src.includes('executedProductionHelper'));
  });
  test('R5 pending dynamic assertions are declared', () => {
    const g = runPrep.build(bytes.helper);
    assert.ok(Array.isArray(g.pendingDynamicAssertions) && g.pendingDynamicAssertions.length >= 3);
  });

  // All reads, digests, protection checks, fault verification and report data are done.
  const digests = {
    helper: H(bytes.helper), config: H(bytes.config), contract: H(bytes.contract),
    offlineV2: H(bytes.offlineV2), driver: H(bytes.driver), ccfg: H(bytes.ccfg),
    runPrep: H(bytes.runPrep), runFixture: H(bytes.runFixture),
    fixtureBuilder: H(bytes.fixtureBuilder), fixture: H(bytes.fixture),
    evidence: H(fs.readFileSync(__filename))
  };
  if (fault) { try { require('node:https').request('denied'); } catch { } }
  const unexpectedHits = guard.unexpected;
  const ok = results.every(x => x.ok) && unexpectedHits === 0;
  report = {
    schema: 'codex-l2-root-only-offline/4',
    identity: { techBaseline: 'dac82a2', handoverBaseline: 'aac8890', reviewedImplementation: '4dbb317', runtimeHead: report_Identity.runtimeHead, runtimeHeadGated: false, agentsWorktreeSha256Prefix: report_Identity.agentsWorktreeSha256Prefix },
    kind: 'R1-R5 concentrated rework verification: same-chain binding/launch, observed cleanup, dependency closure, prepared run boundary',
    fault, checks: results.length, results, guard: { probes: guard.probes, unexpected: unexpectedHits }, digests,
    acceptanceMatrix: [
      { item: 'R1 绑定与启动准入', status: '已执行(替身)', evidence: 'Symbol品牌绑定+内部字节副本；同绑定跨runner单次；来源漂移/既有回执/产物摘要不符零启动；实质PE/CLR节表映射检查' },
      { item: 'R2 异常收尾与回执观测', status: '已执行(替身)', evidence: '回执=本次受限stdout收集；统一try/finally；超限即时停止+kill+有界回收；killAccepted/closedUnknown/holdReleased入报告；空/错输出不可补成功；attempts/unexpected实际记账' },
      { item: 'R3 编译配置', status: '已准备待执行', evidence: '依赖闭包（观察器+Run边界夹具）+严格字段核对+变更/移目录反例+单目标语义；本轮不编译' },
      { item: 'R4 沿用字节与口径', status: '已执行', evidence: '实际装载字节逐项受审摘要核对+漂移反例；identity四字段分列；AGENTS当前摘要f2b27c15…实测' },
      { item: 'R5 完整Run合成边界', status: '已准备未执行', evidence: '准备器v2+夹具v2（20场景，真实表达式提取+Hook替身+符号闭包禁令）；C#动态断言待编译执行' },
      { item: '守卫与最终出口', status: '已执行', evidence: '初始化至唯一最终判定；--fault-caught 意外1/ok=false/exit1' },
      { item: '保护与记录', status: '已执行', evidence: '保护路径零改动；历史后缀二进制核验；暂存凭据扫描' }
    ],
    limitations: [
      '全部C#夹具（13收尾、Run边界20场景）仍未编译/执行；C#动态断言待后续授权',
      '完整Run真实Job/管道/线程行为、真实CloseHandle、真实产物摘要绑定仍未验证',
      'compile config 工具来源为历史事实；本轮未查询策略值、未重试受阻-File'
    ],
    ok, executionApproved: false
  };
  report.exitCode = report.ok ? 0 : 1;
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.length === 2) fs.writeFileSync(args[1], text, { flag: 'wx' });
  fs.writeSync(1, text); process.exitCode = report.exitCode;
} catch (e) {
  probing = false; fs.writeSync(1, JSON.stringify({ ok: false, exitCode: 1, error: e.code || e.message || 'OFFLINE_FAILURE', guard }) + '\n'); process.exitCode = 1;
}
