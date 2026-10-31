'use strict';
// L2 root-only offline module verification v3: full-module delivery checks.
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
const results = []; function test(name, fn) { try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.code || 'ASSERTION_FAILED' }); } }
const dir = __dirname, read = n => fs.readFileSync(path.join(dir, n));
const names = {
  helper: 'CodexL2单根对照辅助层v2-20261031.cs', config: 'CodexL2单根对照固定接口v2-20261031.json',
  contract: 'CodexL2单根对照回执契约v2-20261031.cjs', offlineV2: 'CodexL2单根对照离线核验v2-20261031.json',
  fixtureBuilder: 'CodexL2单根收尾夹具准备v1-20261031.cjs', fixture: 'CodexL2单根收尾合成夹具v1-20261031.cs',
  compileConfig: 'CodexL2单根对照固定编译配置v1-20261031.json', binder: 'CodexL2单根产物绑定与单次驱动v1-20261031.cjs'
};
let report;
try {
  const args = process.argv.slice(2), fault = args.length === 1 && args[0] === '--fault-caught';
  assert.ok(args.length === 0 || fault || (args.length === 2 && args[0] === '--out' && args[1].trim() && !args[1].startsWith('--')));
  if (args.length === 2) assert.equal(fs.existsSync(args[1]), false);
  probing = true;
  for (const fn of [() => cp.spawn('denied'), () => require('node:https').request('denied'), () => socketPrototype.connect(), () => require('node:dns').promises.lookup('denied'), () => fetch('denied')]) assert.throws(fn, /OFFLINE_BLOCKED/);
  probing = false; assert.equal(guard.probes, 5);
  const helperBytes = read(names.helper), configBytes = read(names.config);

  // ── 已关闭项沿用引用（v2 81项离线核验结论，不重跑） ──
  const v2 = JSON.parse(read(names.offlineV2).toString('utf8'));
  test('v2 offline evidence reused: 81 checks pass with guard clean', () => {
    assert.equal(v2.ok, true); assert.equal(v2.checks, 81);
    assert.equal(v2.results.filter(r => r.ok).length, 81); assert.equal(v2.guard.unexpected, 0);
    assert.equal(v2.kind, 'synthetic receipt validation and source comparison only');
    assert.equal(v2.executionApproved, false);
  });
  test('v2 evidence digests match pinned values', () => {
    assert.equal(v2.runtimeDigests.helper, '408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b');
    assert.equal(v2.runtimeDigests.config, '1518269f0918b03052fec0540ac7a8934484341ec379445e86d86508685f98ce');
    assert.equal(v2.runtimeDigests.contract, '2029ca70c718bd56f151448c5fd95db9d5e9e1c52bd63573d8907b849915bae7');
    assert.equal(v2.runtimeDigests.fixtureBuilder, 'c22a543113d979994d5d84e3a3ae76c38c3e7db007a9d4d61cbd07b58d718858');
    assert.equal(v2.runtimeDigests.fixture, '9b76b6af754992cbb69b6a77c24191f16ed0132d6028a214118f31aed2840fd2');
    assert.equal(H(helperBytes), v2.runtimeDigests.helper);
    assert.equal(H(configBytes), v2.runtimeDigests.config);
  });

  // ── 新模块：固定编译配置（数据准备，不执行） ──
  const ccfg = JSON.parse(read(names.compileConfig).toString('utf8'));
  function checkCompileConfig(c) {
    assert.equal(c.schema, 'codex-l2-rootonly-compile-config/1');
    assert.equal(c.executionAuthorized, false); assert.equal(c.artifactExecutionApproved, false);
    assert.deepEqual(c.singleCompile, { maxDirectCompilerStarts: 1, automaticRetry: false, failureStopsAll: true, note: '仅编译一次；异常即停、不重试；编译产物不运行' });
    assert.equal(c.postcheck.executeOutput, false); assert.equal(c.postcheck.executionAllowed, false);
    assert.equal(c.postcheck.outputMagic, 'PE32+'); assert.equal(c.postcheck.outputMachine, 'AMD64');
    assert.ok(c.postcheck.artifactBinding.includes('bound digest'));
    assert.equal(c.toolFacts.source, 'historical');
    assert.equal(c.cases.length, 2);
    const ids = c.cases.map(x => x.id); assert.deepEqual(ids, ['rootOnlyHelper', 'cleanupFixture']);
    for (const x of c.cases) {
      assert.equal(x.expectedExitCode, 0);
      assert.ok(x.args.includes('/platform:x64') && x.args.some(a => a.startsWith('/main:')));
      assert.equal(x.outputFile, x.args.find(a => a.startsWith('/out:')).slice('/out:'.length));
    }
    assert.ok(c.pending.runBoundaryFixture.includes('不因本配置存在而获得编译或运行批准'));
    return true;
  }
  test('compile config is data-only preparation', () => assert.equal(checkCompileConfig(ccfg), true));
  test('compile config inputs match repo bytes', () => {
    for (const i of ccfg.inputs) assert.equal(H(read(path.basename(i.path))), i.sha256);
    assert.equal(ccfg.inputs[0].sha256, '408d9108fff46b045bf19183d1488a53f02ca52f4e255fab987163df60124a7b');
    assert.equal(ccfg.inputs[1].sha256, '9b76b6af754992cbb69b6a77c24191f16ed0132d6028a214118f31aed2840fd2');
  });
  test('compile config cases are single-run and distinct', () => {
    for (const c of ccfg.cases) assert.ok(!ccfg.cases.some(o => o !== c && o.outputFile === c.outputFile));
  });
  for (const [path_, value] of [
    ['executionAuthorized', true], ['artifactExecutionApproved', true],
    ['singleCompile.maxDirectCompilerStarts', 2], ['singleCompile.automaticRetry', true],
    ['postcheck.executeOutput', true], ['postcheck.executionAllowed', true],
    ['cases', []]
  ]) test('compile config rejects ' + path_, () => {
    const clone = JSON.parse(JSON.stringify(ccfg));
    const ks = path_.split('.'); let t = clone; while (ks.length > 1) t = t[ks.shift()]; t[ks[0]] = value;
    assert.throws(() => checkCompileConfig(clone));
  });

  // ── 新模块：产物绑定与私有单次驱动（替身边界自测） ──
  const mod = require('./' + names.binder);
  test('driver module has no public process/network surface', () => {
    const src = read(names.binder).toString('utf8');
    assert.doesNotMatch(src, /require\('node:(child_process|net|http|https|tls|dgram|dns)'\)/);
    assert.doesNotMatch(src, /(^|[^.\w])spawn\s*\(/);
    assert.ok(src.includes('boundary.spawn'));
    assert.deepEqual(Object.keys(mod).sort(), ['bind', 'createRunner', 'inspectProduct']);
  });
  function product() {
    const b = Buffer.alloc(0x400, 0); b.write('MZ', 0, 'latin1');
    const pe = 0x80; b.writeUInt32LE(pe, 0x3c); b.write('PE\0\0', pe, 'latin1');
    b.writeUInt16LE(0x8664, pe + 4); b.writeUInt16LE(0x20b, pe + 24);
    b.writeUInt32LE(0x1000, pe + 24 + 112 + 14 * 8);
    return b;
  }
  const binding = mod.bind(configBytes, product());
  test('binding computes digest from provided bytes and stays diagnostic', () => {
    assert.equal(binding.artifactBound, true); assert.equal(binding.executionApproved, false);
    assert.equal(binding.artifactSha256, H(product()));
    assert.deepEqual(binding.statics, { size: 0x400, machine: 'AMD64', magic: 'PE32+', clrHeaderPresent: true });
  });
  test('bind rejects config mismatch', () => assert.throws(() => mod.bind(Buffer.from(JSON.stringify({ ...JSON.parse(configBytes.toString('utf8')), mode: 'normal' })), product()), /CONFIG_MISMATCH/));
  for (const [name, mutate] of [
    ['PE_MAGIC', b => { b.write('XX', 0, 'latin1'); return b; }],
    ['PE_MACHINE', b => { b.writeUInt16LE(0x014c, b.readUInt32LE(0x3c) + 4); return b; }],
    ['PE_OPTIONAL', b => { b.writeUInt16LE(0x10b, b.readUInt32LE(0x3c) + 24); return b; }],
    ['PE_CLR', b => { b.writeUInt32LE(0, b.readUInt32LE(0x3c) + 24 + 112 + 14 * 8); return b; }]
  ]) test('bind rejects ' + name, () => assert.throws(() => mod.bind(configBytes, mutate(product())), new RegExp(name)));
  test('bind rejects oversize product', () => assert.throws(() => mod.bind(configBytes, Buffer.alloc(1048577)), /PRODUCT_WIRE/));
  test('runner refuses unbound binding', () => assert.throws(() => mod.createRunner({ artifactBound: false }, {}), /ARTIFACT_NOT_BOUND/));
  test('runner refuses missing boundary', () => assert.throws(() => mod.createRunner(binding, {}), /BOUNDARY_REQUIRED/));
  const validReceipt = {
    schema: 'codex-l2-root-only-job/1', mode: 'rootOnly', outcome: 'completed', reason: 'NONE', created: true, assigned: true, resumed: true,
    pid: 100, rootExited: true, rootExit: 0, jobEmpty: true, totalProcesses: 1, activeProcesses: 0, killRequested: false, killAccepted: false,
    readersDone: true, handlesClosed: true, cleanupConfirmed: true, stdoutBytes: 12, stderrBytes: 0,
    stdoutBase64: Buffer.from('L2_ROOT_ONLY').toString('base64'), elapsedMs: 100, accountingLayoutVerified: true,
    observation: {
      failure: 'NONE', identityCoverage: true, parentEvidenceComplete: false, notificationCompletenessGuaranteed: false,
      stopped: true, handlesClosed: true, duplicateNew: false, finalTotal: 1,
      events: [{ kind: 'NEW', pid: 100 }, { kind: 'EXIT', pid: 100 }, { kind: 'ACTIVE_ZERO', pid: 0 }],
      members: [{ pid: 100, creationTime: '1', image: 'FIXED_NODE', pathClass: 'FIXED_NODE_PATH', state: 'CAPTURED', root: true, parent: 'UNKNOWN', newSeen: true, listed: true, exitSeen: true }]
    }
  };
  function boundary(over) {
    const o = { drift: 'none', spawnThrows: false, timedOut: false, closed: true, status: 0, signal: null, killOk: true, stderr: 0, stdout: Buffer.from('L2_ROOT_ONLY'), receipt: validReceipt, receiptBefore: false, ...over };
    let spawned = false;
    return {
      productPath: 'C:\\synthetic\\rootonly-helper.exe',
      spawn() { if (o.spawnThrows) throw Error('synthetic'); spawned = true; return { onData(cb) { if (o.stdout) cb(false, o.stdout); if (o.stderr) cb(true, Buffer.alloc(o.stderr)); } }; },
      awaitExit() { if (!o.timedOut) return { status: o.status, signal: o.signal, closed: o.closed }; return { status: null, signal: null, closed: false, timedOut: true }; },
      kill() { return o.killOk; },
      digestFile(rel) { const s = cfgSourceSha(rel); return spawned && o.drift === 'after' ? 'drifted' : (o.drift === 'before' && !spawned ? 'drifted' : s); },
      receiptExistsBefore() { return o.receiptBefore; },
      receipt() { return Buffer.from(JSON.stringify(typeof o.receipt === 'function' ? o.receipt() : o.receipt)); },
      _spawned: () => spawned
    };
  }
  const cfgSources = JSON.parse(configBytes.toString('utf8')).sources;
  const cfgSourceSha = rel => cfgSources.find(s => s.rel === rel).sha256;
  const normal = mod.createRunner(binding, boundary({}));
  test('normal single run is diagnostic only', () => {
    const r = normal.runOnce();
    assert.equal(r.ok, true); assert.equal(r.assessment.rootOnlyPassed, true);
    assert.equal(r.facts.attempts, 1); assert.equal(r.facts.closed, true); assert.equal(r.facts.status, 0);
    assert.equal(r.artifactSha256, binding.artifactSha256);
    for (const k of ['executionApproved', 'realInputApproved', 'l2Approved']) assert.equal(r[k], false);
  });
  test('second run refused (single run per binding)', () => assert.throws(() => normal.runOnce(), /ALREADY_RUN/));
  for (const [name, over, kind] of [
    ['spawn throw', { spawnThrows: true }, 'SPAWN_FAILED'],
    ['timeout', { timedOut: true }, 'TIMEOUT'],
    ['stderr', { stderr: 5 }, 'STDERR'],
    ['output limit', { stdout: Buffer.alloc(131073) }, 'OUTPUT_LIMIT'],
    ['close unconfirmed', { closed: false }, 'CLOSE_UNCONFIRMED'],
    ['sources drift before', { drift: 'before' }, null],
    ['sources drift after', { drift: 'after' }, null],
    ['receipt pre-exists', { receiptBefore: true }, null]
  ]) test('driver failure scenario: ' + name, () => {
    const r = mod.createRunner(binding, boundary(over));
    if (kind === null) assert.throws(() => r.runOnce(), /DRIVER_FAILED/);
    else {
      let err = null;
      try { r.runOnce(); } catch (e) { err = e; }
      assert.match(String(err && err.message), /DRIVER_FAILED/);
      assert.equal(err.facts.failure, kind);
    }
  });
  test('driver failed receipt stays failed and diagnostic', () => {
    const failed = { ...validReceipt, outcome: 'failed', reason: 'TREE_COUNT', stdoutBase64: '', rootExit: 9009, killRequested: true, killAccepted: true };
    const r = mod.createRunner(binding, boundary({ receipt: failed, status: 1 })).runOnce();
    assert.equal(r.ok, false); assert.equal(r.assessment.rootOnlyPassed, false); assert.equal(r.assessment.l2Approved, false);
  });

  // ── 完整Run合成边界：全Run源文顺序检查（静态，如实表述；非执行证明） ──
  function fullRunOrder(source) {
    const start = source.indexOf('  static Receipt Run(string mode) {'), end = source.indexOf('  static bool Allowed(string s) {');
    assert.ok(start >= 0 && end > start); const s = source.slice(start, end);
    const steps = [
      'string[] args=Arguments(mode);nodeHold=Hold(Node,NodeHash);',
      'VerifyAccountingLayout();r.AccountingLayoutVerified=true;',
      'job=CreateJobObjectW(IntPtr.Zero,null);Require(job!=IntPtr.Zero,"JOB_CREATE");',
      'Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))),"JOB_SET");',
      'Require(QueryLimits(job,9,out actual,(uint)Marshal.SizeOf(typeof(ExtendedLimit)),IntPtr.Zero)&&actual.Basic.Flags==KillOnClose,"JOB_LIMITS");',
      'r.Observer=new L2MemberObserver(job);Require(r.Observer.Failure=="NONE","OBS_FAILURE");',
      'Require(CreatePipe(out rd,out wr,ref sa,0),"PIPE");',
      'Require(CreatePipe(out er,out ew,ref sa,0),"PIPE");',
      'input=CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);Require(input!=Invalid,"STDIN");',
      'Require(CreateProcessW(app,command,IntPtr.Zero,IntPtr.Zero,true,Suspended|NoWindow|UnicodeEnvironment,env,Root,ref si,out pi),"CREATE");',
      'r.Created=true;r.Pid=pi.Pid;',
      'Require(AssignProcessToJobObject(job,pi.Process),"JOB_ASSIGN");r.Assigned=true;',
      'r.Observer.Root(pi.Pid,pi.Process);',
      'Require(Close(ref wr,r)&Close(ref ew,r)&Close(ref input,r),"HANDLE_CLOSE");',
      'outThread.Start();', 'errThread.Start();',
      'Require(ResumeThread(pi.Thread)==1,"RESUME");r.Resumed=true;',
      'r.Observer.Poll();Require(r.Observer.Failure=="NONE","OBS_FAILURE");',
      'Account(job,r);Require(r.Total<=16,"OBS_MEMBER_LIMIT");',
      'Require(r.Total==1,"TREE_COUNT");',
      'r.Outcome="completed";',
      'if(r.Created && (!r.RootExited || !r.JobEmpty || r.Reason!="NONE")) {',
      'r.KillRequested=true;r.KillAccepted=r.Assigned?TerminateJobObject(job,9009):TerminateProcess(pi.Process,9009);',
      'while(reap.ElapsedMilliseconds<2000) {',
      'if(outThread!=null)r.ReadersDone=outThread.Join(100)&&r.ReadersDone;',
      'if(r.Reason=="NONE")r.Stdout=Convert.ToBase64String(output.Bytes.ToArray());output.Bytes.Dispose();',
      'if(r.Observer!=null)r.Observer.Stop(r.Total);',
      'r.HandlesClosed=(Close(ref pi.Thread,r)&Close(ref pi.Process,r)&Close(ref rd,r)&Close(ref wr,r)&Close(ref er,r)&Close(ref ew,r)&Close(ref input,r)&Close(ref job,r))&&r.HandlesClosed;',
      'if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);',
      'try {if(nodeHold!=null)nodeHold.Dispose();}catch{r.HandlesClosed=false;}',
      'if(r.Reason!="NONE"||!r.Cleanup){r.Outcome="failed";r.Stdout="";}'
    ];
    let previous = -1;
    for (const step of steps) { assert.equal(s.split(step).length, 2, 'ANCHOR:' + step.slice(0, 40)); const at = s.indexOf(step); assert.ok(at > previous, 'ORDER:' + step.slice(0, 40)); previous = at; }
    assert.ok(source.includes('if(args.Length!=1 || args[0]!="rootOnly")'));
    return true;
  }
  test('full-run ordering source check only (admission..finally)', () => assert.equal(fullRunOrder(helperBytes.toString('utf8')), true));
  test('run order sensitivity: held hash gate removed', () => assert.throws(() => fullRunOrder(helperBytes.toString('utf8').replace('nodeHold=Hold(Node,NodeHash);', ''))));
  test('run order sensitivity: resume before assignment', () => {
    let s = helperBytes.toString('utf8'); const resume = 'Require(ResumeThread(pi.Thread)==1,"RESUME");r.Resumed=true;';
    s = s.replace(resume, ''); s = s.replace('Require(AssignProcessToJobObject(job,pi.Process)', resume + 'Require(AssignProcessToJobObject(job,pi.Process)');
    assert.throws(() => fullRunOrder(s));
  });
  test('run order sensitivity: kill-on-abandon removed', () => assert.throws(() => fullRunOrder(helperBytes.toString('utf8').replace('r.KillRequested=true;r.KillAccepted=r.Assigned?TerminateJobObject(job,9009):TerminateProcess(pi.Process,9009);', ''))));
  test('run order sensitivity: final failure body kept', () => assert.throws(() => fullRunOrder(helperBytes.toString('utf8').replace('{r.Outcome="failed";r.Stdout="";}', '{r.Outcome="failed";}'))));
  test('run order sensitivity: closed merge dropped', () => assert.throws(() => fullRunOrder(helperBytes.toString('utf8').replace('&&r.HandlesClosed;', ';'))));
  test('run order sensitivity: main gate removed', () => assert.throws(() => fullRunOrder(helperBytes.toString('utf8').replace('if(args.Length!=1 || args[0]!="rootOnly")', 'if(false)'))));

  // ── 13项收尾夹具沿用核对（审查结论：无需修改） ──
  const prep = require('./' + names.fixtureBuilder);
  test('cleanup fixture v1 reviewed and unchanged', () => {
    const g = prep.build(helperBytes);
    assert.equal(read(names.fixture).toString('utf8'), g.source);
    assert.equal(g.plannedCases, 13); assert.equal(g.compiled, false); assert.equal(g.executed, false);
  });

  // 全部读取与摘要计算之后、唯一最终判定之前：fault 注入点
  const digests = {
    helper: H(helperBytes), config: H(configBytes), offlineV2: H(read(names.offlineV2)),
    compileConfig: H(read(names.compileConfig)), binder: H(read(names.binder)),
    fixtureBuilder: H(read(names.fixtureBuilder)), fixture: H(read(names.fixture)),
    evidence: H(fs.readFileSync(__filename))
  };
  if (fault) { try { require('node:https').request('denied'); } catch { } }
  const ok = results.every(x => x.ok) && guard.unexpected === 0;
  report = {
    schema: 'codex-l2-root-only-offline/3', basisCommit: '0da6af0', reviewedImplementation: 'feddd0a',
    kind: 'full-module offline delivery verification: reuse references + new module synthetic matrix + source-order preparation',
    fault, checks: results.length, results, guard, digests,
    acceptanceMatrix: [
      { item: '来源与差异', status: '已执行', evidence: 'v2沿用81项 + 本轮 digests 固定源摘要；漂移拒绝（夹具/配置）' },
      { item: '准入与启动', status: '静态已执行', evidence: 'fullRunOrder 全Run顺序检查与6项敏感性；Main/rootOnly准入、持有摘要、分配→恢复顺序；非执行证明' },
      { item: '关闭事实', status: '已执行(合成)', evidence: 'v2沿用：F1/F2回执反例 + 13场景夹具准备（未编译）' },
      { item: '回执消费', status: '已执行(合成)', evidence: 'v2沿用：成功/计数0·2·4/候选冒充/同长错误/身份缺失/晚失败/字段矛盾' },
      { item: '驱动', status: '已执行(替身)', evidence: '本轮：未绑定拒绝、单次、spawn异常/超时/输出超限/关闭未确认/前后来源漂移/回执预存在，事实由runner采集' },
      { item: '守卫', status: '已执行', evidence: '初始化至唯一最终判定；非探针命中含被catch者使ok=false/exit1；子替身结果经统一核验（faultProofs式：本证据为单进程矩阵，无子进程计数硬编码）' },
      { item: '编译和运行准备', status: '已准备待执行', evidence: '固定编译配置v1（单次/异常即停/不运行产物）；未编译、未伪造产物或运行摘要' },
      { item: '保护与记录', status: '已执行', evidence: '保护路径零改动；暂存凭据扫描见提交说明；历史后缀二进制核验' }
    ],
    limitations: [
      '13项C#收尾夹具与Run边界仍未编译/执行；完整Run、线程/Job/管道动态缺口保留',
      '驱动为替身边界合成自测，未运行真实产物；未绑定执行入口默认拒绝',
      'compile config 工具来源为历史事实，本轮未再次核对环境文件',
      '旧normal恰2、真实累计4失败、父链UNKNOWN、候选真实性缺口保持'
    ],
    ok, executionApproved: false
  };
  report.exitCode = report.ok ? 0 : 1;
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.length === 2) fs.writeFileSync(args[1], text, { flag: 'wx' });
  fs.writeSync(1, text); process.exitCode = report.exitCode;
} catch (e) {
  probing = false; fs.writeSync(1, JSON.stringify({ ok: false, exitCode: 1, error: e.code || 'OFFLINE_FAILURE', guard }) + '\n'); process.exitCode = 1;
}
