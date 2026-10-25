'use strict';
// B1 定点复核：真实能力层，最底层 OS 替身；不运行 v6 的真实查询主流程。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const NATIVE = 'miniapp/scripts/lib/participant-native-exec.cjs';
const PS = 'miniapp/scripts/lib/participant-dpapi-scripts.cjs';
const EV = 'docs/证据/CodeBuddy本地编码模块兼容返修v6-20261025.cjs';
const JSON_REL = EV.replace(/\.cjs$/, '.json');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const hits = []; let phase = 'probe';
require(path.join(ROOT, 'miniapp/tests/helpers/psr-guard-runner.cjs')).installParentGuardsWithLocalTools({ hits, getPhase: () => phase, allowedScripts: [] });
assert.throws(() => require('node:https').request('https://synthetic.invalid'));
assert.throws(() => require('node:child_process').execSync('synthetic-never-run'));
phase = 'review';
const fixture = require(path.join(ROOT, 'miniapp/tests/helpers/psr-repair-fixtures.cjs'));
const scripts = require(path.join(ROOT, PS));
const calls = [], results = [];
const cap = fixture.load(NATIVE, {
  'node:child_process': {
    spawnSync(exe, args, opts) { calls.push({ exe, args, opts }); return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
    execFileSync(exe, args, opts) { calls.push({ exe, args, opts }); return 'synthetic'; },
    spawn() { throw Error('ASYNC_NOT_IN_SCOPE'); }
  },
  'node:net': { connect() { throw Error('PIPE_NOT_IN_SCOPE'); } }
});
function check(name, fn) { const facts = fn(); results.push({ name, passed: true, facts }); }
function rejectWithoutCall(fn, reason) {
  const before = calls.length;
  assert.throws(fn, e => e.code === 'PSR_NATIVE_EXEC_BOUNDARY' && (!reason || e.message.includes(reason)));
  assert.equal(calls.length, before);
}
function run() {
  check('previous_accessor_counterexample', () => {
    let reads = 0;
    const input = ['-NoProfile', '-NonInteractive', '-Command'];
    Object.defineProperty(input, '3', { get() { return ++reads === 1 ? scripts.PROTECT : 'Write-Output synthetic-unapproved'; } });
    cap.runProgram({ program: 'powershell', args: input });
    const received = calls.at(-1).args;
    assert.notEqual(received, input); assert.equal(received[3], scripts.PROTECT); assert.equal(reads, 1);
    // 底层替身故意保留原收到的引用而非复制；证明不是证据复制掩盖共享引用。
    input[0] = 'synthetic-mutated';
    assert.equal(received[0], '-NoProfile'); assert.equal(received[3], scripts.PROTECT); assert.equal(reads, 1);
    return { reads, independentArray: true, onlyApprovedScriptAtBoundary: true, retainedBoundaryReferenceUnaffected: true };
  });
  check('first_value_unapproved', () => {
    let reads = 0; const input = ['-NoProfile', '-NonInteractive', '-Command'];
    Object.defineProperty(input, '3', { get() { reads++; return 'Write-Output synthetic-unapproved'; } });
    rejectWithoutCall(() => cap.runProgram({ program: 'powershell', args: input }), 'PowerShell 脚本不是受审固定脚本');
    assert.equal(reads, 1); return { reads, boundaryCalls: 0 };
  });
  check('git_paths_snapshot', () => {
    let reads = 0; const paths = ['miniapp/scripts'];
    Object.defineProperty(paths, '1', { get() { return ++reads === 1 ? 'miniapp/scripts/lib' : '-x'; } });
    cap.gitReadonly({ operation: 'diff', commitish: 'HEAD', paths });
    const received = calls.at(-1).args;
    assert.deepEqual(Array.from(received), ['diff', '--name-only', 'HEAD', '--', 'miniapp/scripts', 'miniapp/scripts/lib']);
    paths[0] = '-changed'; assert.equal(received[4], 'miniapp/scripts'); assert.equal(reads, 1);
    rejectWithoutCall(() => cap.gitReadonly({ operation: 'diff', commitish: 'HEAD', paths: ['-x'] }), 'Git paths 不允许选项注入');
    return { reads, mutationUnaffected: true, invalidFirstValueRejected: true };
  });
  check('overridden_input_methods_unused', () => {
    let methodCalls = 0;
    const input = ['/user', '/fo', 'csv', '/nh'];
    for (const key of ['slice', 'map', 'every', Symbol.iterator]) Object.defineProperty(input, key, { value() { methodCalls++; throw Error('UNTRUSTED_METHOD'); } });
    cap.runProgram({ program: 'whoami', args: input });
    assert.deepEqual(Array.from(calls.at(-1).args), ['/user', '/fo', 'csv', '/nh']); assert.equal(methodCalls, 0);
    return { methodCalls };
  });
  check('length_and_elements_sampled_once', () => {
    const reads = {}; const input = new Proxy(['/user', '/fo', 'csv', '/nh'], {
      get(target, key) { reads[String(key)] = (reads[String(key)] || 0) + 1; return Reflect.get(target, key); }
    });
    cap.runProgram({ program: 'whoami', args: input });
    assert.deepEqual(reads, { length: 1, '0': 1, '1': 1, '2': 1, '3': 1 });
    return reads;
  });
  check('bounded_and_invalid_values', () => {
    let reads = 0;
    const oversized = { length: 65, get 0() { reads++; return '.'; } };
    rejectWithoutCall(() => cap.runProgram({ program: 'icacls', args: oversized }), '长度不在固定边界');
    assert.equal(reads, 0);
    for (const args of [[], ['\0'], [42], new Array(1)]) rejectWithoutCall(() => cap.runProgram({ program: 'icacls', args }));
    return { oversizedElementReads: reads, invalidCases: 5 };
  });
  check('four_limit_tests_reach_intended_reason', () => {
    const valid = { program: 'git', args: ['check-ignore', '--', 'miniapp/scripts'] };
    const variants = [
      [{ timeoutMs: 99999 }, '超时超出固定边界'],
      [{ maxBuffer: 999999 }, '输出限额超出固定边界'],
      [{ cwd: 'C:\\Windows' }, 'cwd 不在固定仓库根边界内'],
      [{ input: 42 }, '输入类型不在固定边界']
    ];
    for (const [opts, reason] of variants) rejectWithoutCall(() => cap.runProgram({ ...valid, ...opts }), reason);
    return { distinctReasonsMatched: variants.length, boundaryCalls: 0 };
  });
  check('v6_S11_actual_function', () => {
    const source = fs.readFileSync(path.join(ROOT, EV), 'utf8');
    const start = source.indexOf('function runS11() {'), end = source.indexOf('// ── 主流程', start);
    assert.ok(start >= 0 && end > start);
    const facts = vm.runInNewContext(source.slice(start, end) + '\nrunS11();', { fixture, localTools: scripts, Buffer }, { timeout: 5000 });
    assert.equal(Object.keys(facts).length, 5); assert.ok(Object.values(facts).every(v => v === true));
    return facts;
  });
  check('delivered_evidence_integrity', () => {
    assert.equal(sha(fs.readFileSync(path.join(ROOT, EV))), '4cefc8eaee8a6e52cc138dbffb1df01fb304eba557309d9fb263119abd30cfd9');
    assert.equal(sha(fs.readFileSync(path.join(ROOT, JSON_REL))), '92275ddef0f4ac3f32fc25a412260d267520e58193dee1607980af29489ca5c5');
    const delivered = JSON.parse(fs.readFileSync(path.join(ROOT, JSON_REL), 'utf8'));
    assert.equal(delivered.ok, true); assert.equal(delivered.results.length, 12);
    assert.ok(delivered.results.every(r => r.passed));
    assert.equal(delivered.results.find(r => r.id.startsWith('S9')).actual.scenarios.length, 16);
    return { hashesMatch: true, deliveredChecks: 12, deliveredVmScenarios: 16, fullCliNotRerun: true };
  });
}
let error = null;
try { run(); } catch (e) { error = { name: e.name, message: e.message }; }
const runtimeDigests = Object.fromEntries([NATIVE, PS, EV].map(p => [p, sha(fs.readFileSync(path.join(ROOT, p)))]));
const unexpected = hits.filter(h => h.phase !== 'probe').length;
const report = { schema: 'codex-param-snapshot-68d379e-review/1', reviewedCommit: '68d379e', basis: '7c00355',
  results, error, runtimeDigests,
  guard: { probes: hits.filter(h => h.phase === 'probe').length, unexpected, total: hits.length },
  realOsQueries: 0, dpapi: 0, cloud: 0,
  limitations: ['仅B1定点独立验证；B2/B3沿用，不重跑。', '真实能力层源码，最底层OS替身；S11按原函数文本独立执行，未运行v6真实查询主流程。',
    '交付JSON的12项/16场景是读取核对结果，不冒充本轮完整重跑；本轮独立9组对照。'],
  ok: !error && results.length === 9 && unexpected === 0 };
const body = JSON.stringify(report, null, 2) + '\n';
if (process.argv.length === 2) process.stdout.write(body);
else if (process.argv.length === 4 && process.argv[2] === '--out') fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
else throw Error('usage: node script [--out new-path]');
if (!report.ok) process.exitCode = 1;
