'use strict';
// 仅本地合成复核：真实能力层及 v5 源码；OS、管道、私密 FS 全部替身。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const NATIVE = 'miniapp/scripts/lib/participant-native-exec.cjs';
const LOCAL = 'miniapp/scripts/lib/participant-local-tools.cjs';
const DEC = 'miniapp/scripts/lib/participant-native-decoder.cjs';
const PS = 'miniapp/scripts/lib/participant-dpapi-scripts.cjs';
const EV = 'docs/证据/CodeBuddy本地编码模块兼容返修v5-20261024.cjs';
const outerHits = []; let phase = 'probe';
const guard = require(path.join(ROOT, 'miniapp/tests/helpers/psr-guard-runner.cjs'));
const installOuter = () => guard.installParentGuardsWithLocalTools({ hits: outerHits, getPhase: () => phase, allowedScripts: [] });
installOuter();
assert.throws(() => require('node:https').request('https://synthetic.invalid'));
assert.throws(() => require('node:child_process').execSync('synthetic-never-run'));
phase = 'review';
const fixture = require(path.join(ROOT, 'miniapp/tests/helpers/psr-repair-fixtures.cjs'));
const scripts = require(path.join(ROOT, PS)), decoder = require(path.join(ROOT, DEC));
const sourceOriginal = fs.readFileSync(path.join(ROOT, EV), 'utf8');
const ok = b => ({ status: 0, stdout: b, stderr: Buffer.alloc(0) });
const gbTail = Buffer.concat([Buffer.from([0xd2,0xd1,0xb3,0xc9,0xb9,0xa6,0xb4,0xa6,0xc0,0xed]), Buffer.from(' 1 '),
  Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe]), Buffer.from('; '), Buffer.from([0xb4,0xa6,0xc0,0xed]), Buffer.from(' 0 '),
  Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe,0xca,0xb1,0xca,0xa7,0xb0,0xdc])]);
const probe = Buffer.concat([Buffer.from('synthetic:(F)\r\n'), gbTail, Buffer.from('\r\n')]);

function boundaryCases() {
  const calls = [];
  const cp = { spawnSync(exe, args) { calls.push({ program: path.win32.basename(exe), args: Array.from(args) }); return ok(Buffer.alloc(0)); },
    spawn(exe, args) { calls.push({ program: path.win32.basename(exe), args: Array.from(args) }); return {}; }, execFileSync() { return ''; } };
  const cap = fixture.load(NATIVE, { 'node:child_process': cp, 'node:net': { connect() { return {}; } } });
  const invalid = [
    () => cap.runProgram({ program: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output synthetic-unapproved'] }),
    () => cap.runProgram({ program: 'git', args: ['config', '--local', 'synthetic.probe', 'true'] }),
    () => cap.runProgram({ program: 'icacls', args: ['synthetic-target', '/grant', 'Everyone:F'] }),
    () => cap.spawnProgram({ purpose: 'dpapi-unprotect', script: '# Import-Module -Name (Join-Path $PSHOME\nWrite-Output synthetic-unapproved' })
  ];
  for (const run of invalid) assert.throws(run, e => e.code === 'PSR_NATIVE_EXEC_BOUNDARY');
  assert.equal(calls.length, 0);
  cap.runProgram({ program: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', scripts.PROTECT] });
  cap.runProgram({ program: 'git', args: ['check-ignore', '--', 'artifacts/synthetic'] });
  cap.runProgram({ program: 'icacls', args: ['artifacts/synthetic'] });
  cap.spawnProgram({ purpose: 'dpapi-unprotect', script: scripts.UNPROTECT });
  assert.equal(calls.length, 4);

  // 同一实际数组：检查时取得受审脚本，边界消费时取得另一字符串。不启动任何程序。
  let reads = 0;
  const args = ['-NoProfile', '-NonInteractive', '-Command', scripts.PROTECT];
  Object.defineProperty(args, '3', { enumerable: true, configurable: true,
    get() { return ++reads === 1 ? scripts.PROTECT : 'Write-Output synthetic-unapproved'; } });
  cap.runProgram({ program: 'powershell', args });
  assert.equal(calls[4].args[3], 'Write-Output synthetic-unapproved');
  assert.equal(reads, 2);

  const faultCap = fixture.load(NATIVE, { 'node:child_process': { spawn() { throw Error('synthetic spawn failure'); } },
    'node:net': { connect() { throw Error('synthetic pipe failure'); } } });
  assert.throws(() => faultCap.spawnProgram({ purpose: 'dpapi-unprotect', script: scripts.UNPROTECT }));
  assert.throws(() => faultCap.connectNamedPipe({ purpose: 'dpapi-unprotect', name: 'psr-dpapi-' + 'a'.repeat(32) }));
  assert.ok(faultCap.attempts().every(a => a.completed && a.spawnFailed));
  const spawned = cap.spawnProgram({ purpose: 'dpapi-unprotect', script: scripts.UNPROTECT });
  cap.completeAsync(spawned.attemptId, { error: Error('synthetic failure') });
  cap.completeAsync(spawned.attemptId, { code: 0 });
  assert.equal(cap.attempts().find(a => a.id === spawned.attemptId).spawnFailed, true);
  return { ordinaryInvalidRejected: 4, ordinaryValidAccepted: 4,
    mutableArgs: { accepted: true, getterReads: reads, boundaryScriptIsApproved: false, actualOsProcesses: 0 },
    syncThrowRecorded: true, errorThenCloseZeroPreserved: true };
}

async function evidenceCase(mode) {
  installOuter(); let source = sourceOriginal;
  const full = mode === 'normalFull';
  const privateRoot = path.join(ROOT, 'artifacts/schedule-sandbox/.participant-private');
  const historical = 'docs/证据/Codex编码兼容545d038复核-20261024.json';
  const calls = [], installs = []; let injected = false, stdout = '', stderr = '', complete;
  const done = new Promise(r => complete = r);
  const proc = { env: {}, version: process.version,
    argv: ['node', path.join(ROOT, EV), ...(full ? [] : ['--vm-child'])], exitCode: 0,
    stdout: { write(s) { stdout += s; complete(); } }, stderr: { write(s) { stderr += s; complete(); } } };
  const quoteGit = p => '"' + Array.from(Buffer.from(p)).map(b => b >= 128 ? '\\' + b.toString(8).padStart(3, '0') : String.fromCharCode(b)).join('') + '"';
  const cp = { spawnSync(exe, args, opts) {
    calls.push({ program: path.win32.basename(exe) }); assert.equal(opts.shell, false);
    if (exe.endsWith('icacls.exe')) return ok(probe);
    if (exe.endsWith('whoami.exe')) return ok(Buffer.from('"synthetic\\current","' + fixture.sid + '"'));
    assert.ok(exe.endsWith('git.exe')); assert.equal(args[0], 'check-ignore'); return ok(Buffer.from(args[2] + '\n'));
  }, spawn() { throw Error('REAL_ASYNC_FORBIDDEN'); }, execFileSync(exe, args) {
    calls.push({ program: path.win32.basename(exe) });
    assert.equal(exe, 'C:\\Program Files\\Git\\cmd\\git.exe');
    if (args[0] === 'diff') {
      assert.equal(args.includes('--'), false, '保护 diff 必须完整查询，不能限定 pathspec');
      if (mode === 'committedHistoryChange' && args.some(a => a.endsWith('..HEAD'))) return quoteGit(historical) + '\n';
      if (mode === 'uncommittedHistoryChange' && !args.some(a => a.endsWith('..HEAD'))) return quoteGit(historical) + '\n';
      return quoteGit('docs/当前状态.md') + '\n';
    }
    if (mode === 'untrackedIllegal') return '?? ' + quoteGit('docs/证据/合成未授权.txt') + '\n';
    return ' M ' + quoteGit('docs/当前状态.md') + '\n';
  } };
  const native = fixture.load(NATIVE, { 'node:child_process': cp, 'node:net': { connect() { throw Error('REAL_PIPE_FORBIDDEN'); } } });
  const fakeFs = { existsSync(p) { assert.equal(p, privateRoot); return true; },
    statSync(p) { return { isDirectory: () => p === privateRoot, isFile: () => p !== privateRoot }; },
    readFileSync(p, ...args) {
      assert.ok([EV, LOCAL, NATIVE, DEC, PS, 'AGENTS.md'].some(rel => path.join(ROOT, rel) === p));
      if (mode === 'runtimeDigestHit' && p === path.join(ROOT, NATIVE) && !injected) {
        injected = true; try { require('node:https').request('https://synthetic-digest.invalid'); } catch (_) {}
      }
      if (p === path.join(ROOT, EV)) return typeof args[0] === 'string' ? source : Buffer.from(source);
      return fs.readFileSync(p, ...args);
    }, writeFileSync() { throw Error('VM_WRITE_FORBIDDEN'); } };
  const local = fixture.load(LOCAL, { 'node:fs': fakeFs, './participant-native-exec.cjs': native });
  const guardWrapper = { installParentGuardsWithLocalTools(opts) { installs.push(opts); return guard.installParentGuardsWithLocalTools(opts); } };
  const requireVm = n => {
    if (n === 'node:fs') return fakeFs;
    if (n === path.join(ROOT, NATIVE)) return native;
    if (n === path.join(ROOT, LOCAL)) return local;
    if (n === path.join(ROOT, DEC)) return decoder;
    if (n === path.join(ROOT, 'miniapp/tests/helpers/psr-guard-runner.cjs')) return guardWrapper;
    if (n === path.join(ROOT, 'miniapp/tests/helpers/psr-repair-fixtures.cjs')) return fixture;
    assert.ok(['node:path','node:crypto','node:assert/strict','node:events','node:vm','node:https','node:dns','node:child_process'].includes(n));
    return require(n);
  };
  if (!full) source = source.replace('if (!IS_VM_CHILD) {\n  guardRunner.installParentGuardsWithLocalTools',
    'if (true) {\n  guardRunner.installParentGuardsWithLocalTools');
  vm.runInNewContext(source, { require: requireVm, __dirname: path.join(ROOT, 'docs/证据'), __filename: path.join(ROOT, EV),
    process: proc, Buffer, TextDecoder, Date, setTimeout, clearTimeout, queueMicrotask, console }, { timeout: 5000 });
  let timeout;
  await Promise.race([done, new Promise((_, rej) => { timeout = setTimeout(() => rej(Error('VM_TIMEOUT')), 15000); })]).finally(() => clearTimeout(timeout));
  assert.equal(stderr, ''); const r = JSON.parse(stdout);
  const expected = ['normal', 'normalFull'].includes(mode);
  assert.equal(r.ok, expected); assert.equal(proc.exitCode || 0, expected ? 0 : 1);
  assert.equal(calls.length, 7); assert.equal(installs.length, 1);
  const s8 = r.results.find(x => x.id.startsWith('S8')), s9 = r.results.find(x => x.id.startsWith('S9'));
  if (mode === 'runtimeDigestHit') { assert.ok(r.results.every(x => x.passed)); assert.equal(r.guardAccounting.unexpectedHits, 1); }
  if (mode.includes('HistoryChange')) assert.ok(s8.actual.protectedViolations.includes(historical));
  if (full) { assert.equal(s9.actual.scenarios.length, 16); assert.ok(s9.actual.scenarios.every(x => x.passed)); }
  return { mode, ok: r.ok, exit: proc.exitCode || 0, actualProcesses: calls.length,
    unexpected: r.guardAccounting.unexpectedHits, s8Passed: s8.passed,
    vmScenarioCount: full ? s9.actual.scenarios.length : 0,
    failedResults: r.results.filter(x => !x.passed).map(x => x.id) };
}

async function main() {
  const boundary = boundaryCases(), evidenceVm = [];
  for (const mode of ['normal', 'runtimeDigestHit', 'committedHistoryChange', 'uncommittedHistoryChange', 'untrackedIllegal', 'normalFull']) {
    evidenceVm.push(await evidenceCase(mode));
  }
  installOuter(); const unexpected = outerHits.filter(x => x.phase !== 'probe').length;
  assert.equal(unexpected, 0);
  const report = { schema: 'codex-native-compat-45ee875-review/1', reviewedCommit: '45ee875', basis: '6f42d03',
    runtimeDigests: Object.fromEntries([LOCAL, NATIVE, DEC, PS, EV].map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex')])),
    boundary, evidenceVm, outerGuard: { probes: outerHits.length, unexpected }, realOsQueries: 0, dpapi: 0, cloud: 0, ok: true,
    limitations: ['ok表示独立对照符合预期，不表示产品验收通过。', '真实受审源码；OS、管道和私密FS全部替身。未读取真实身份/ACL/编号/密文。',
      'runtimeDigestHit由独立FS替身在真实摘要读取点注入被catch命中，没有启用受审脚本自带fault开关。',
      '历史差异及未跟踪项只存在于合成Git响应；真实历史未修改。',
      '可变参数反例仅记录边界实际收到的字符串，未执行任意PowerShell。'] };
  const body = JSON.stringify(report, null, 2) + '\n';
  if (process.argv.length === 2) process.stdout.write(body);
  else if (process.argv.length === 4 && process.argv[2] === '--out') fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
  else throw Error('usage: node script [--out new-path]');
}
main().catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exitCode = 1; });
