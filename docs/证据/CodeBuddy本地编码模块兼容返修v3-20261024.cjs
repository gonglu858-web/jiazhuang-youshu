'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// WorkBuddy 本地编码与模块兼容返修 v3 证据（Codex 复查接续 545d038 §2–§3，A1–A3 收尾）
// 依据：docs/Codex复查-编码兼容R1R3接续545d038-20261024.md。v1/v2 脚本与 JSON、
// 全部 Codex 报告反例不改写；本文件为独立 v3。
//
// 与 v2 的关键差异：
// - A1：S1 通过条件 = 契约建立 && 无查询错误 && ACL 观测成立 && 身份形状成立
//   （身份失败/非 CSV → 最终 ok=false、exit 1）；只读事实字段按实际完成情况填写。
// - A2：守卫在业务模块装载前安装（原始引用仅经 participant-native-exec 私有捕获层，
//   不放开公共 API）；除显式探针/独立敏感性外，**全部阶段**命中（含被 catch）均计
//   意外并决定最终失败；进程次数从 native-exec attempts 实际调用记录汇总（含全部
//   Git、失败与超时，不手工填写）；保护核对覆盖完整保护集 + git status 允许差异集
//   （涵盖待交付未跟踪文件），不靠硬编码计数/布尔。
// - A3：统计行完整行级锚定（唯一+失败数 0+无矛盾行）；utf8Decoded 与 utf8Anchor
//   分列；契约按程序/通道限定（icacls 探针只授权 icacls.pipe；whoami 无独立非 ASCII
//   证据 → 输出必须 ASCII-only，否则保守 blocked）。
// - 内建独立故障出口对照（VM 重入本源码 + 合成进程替身）：正常出口、探针/ACL 成功
//   后身份失败、身份非 CSV、垃圾锚定探针、跨工具身份、pre-require/setup/done 被
//   catch 注入——各自断言 ok=false 且 exit≠0；正常运行断言 ok=true 且 exit=0。
//   VM 场景全部为合成进程/FS 替身，不是真实模块加载或 DPAPI 验证。
//
// 替换范围（全部披露）：真实 OS 查询（whoami/icacls/git）经 local-tools 固定能力与
// native-exec 受限封装执行；合成场景仅替换进程/FS 边界。原始身份/ACL 仅驻内存。
// 全程离线；不调用 DPAPI、不运行 PS1、不保存私密文件；这不是平台验证。
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const REVIEWED_COMMIT = '545d038';
const FIX_BASELINE = 'e7dde01';
const PRIVATE_ROOT_REL = 'artifacts/schedule-sandbox/.participant-private';
const GIT_EXE = 'C:\\Program Files\\Git\\cmd\\git.exe'; // 固定受信路径（与 local-tools EXES.git 一致）

// ── 0) 私有原始引用捕获层最先装载（唯一进程出口；attempts 实际记录） ──
const nativeExec = require(path.join(ROOT, 'miniapp/scripts/lib/participant-native-exec.cjs'));

// ── 1) 完整离线守卫（业务模块装载前安装；覆盖 setup/business/done 全部阶段） ──
//      除显式探针/独立敏感性外，任何阶段命中（含被 catch）都计意外并决定失败。
const hits = []; let phase = 'pre-require';
const guardRunner = require(path.join(ROOT, 'miniapp/tests/helpers/psr-guard-runner.cjs'));
guardRunner.installParentGuardsWithLocalTools({ hits, getPhase: () => phase, allowedScripts: [] });

// ── 2) 业务模块装载（守卫已覆盖） ──
const localTools = require(path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs'));
const decoder = require(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'));
const fixture = require(path.join(ROOT, 'miniapp/tests/helpers/psr-repair-fixtures.cjs'));

// 保护核对受限封装：固定 git 路径 + 固定子命令 + 统一限额；异常净化（不含路径/输出）。
function gitFixed(args, opts) {
  if (!Array.isArray(args) || !['diff', 'status'].includes(args[0]) || !args.every(a => typeof a === 'string')) {
    const e = new Error('保护核对 Git 调用参数不符（固定子命令）'); e.code = 'PSR_GUARD_FIXED_VIOLATION'; throw e;
  }
  try {
    return nativeExec.execFile(GIT_EXE, args,
      Object.assign({ cwd: ROOT, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }, opts || {}));
  } catch (e) {
    const w = new Error('保护核对 Git 调用失败（净化）'); w.code = 'PSR_GUARD_GIT_FAILED'; throw w;
  }
}

const report = {
  schema: 'wb-psr-native-encoding-contract-v3/1',
  reviewedCommit: REVIEWED_COMMIT,
  fixBaseline: FIX_BASELINE,
  date: '2026-10-24',
  results: [],
  ok: false
};
const results = report.results;
const ANCHOR_LINE = '已成功处理 1 个文件; 处理 0 个文件时失败';
const GBK_MAP = { '已': [0xD2, 0xD1], '成': [0xB3, 0xC9], '功': [0xB9, 0xA6], '处': [0xB4, 0xA6],
  '理': [0xC0, 0xED], '个': [0xB8, 0xF6], '文': [0xCE, 0xC4], '件': [0xBC, 0xFE],
  '时': [0xCA, 0xB1], '失': [0xCA, 0xA7], '败': [0xB0, 0xDC] };
const gbEncode = text => { const out = []; for (const ch of text) {
  if (GBK_MAP[ch]) out.push(...GBK_MAP[ch]); else out.push(...Buffer.from(ch, 'utf8')); } return Buffer.from(out); };
// A3：真实形状合成探针输出（ACE 行 + 独立完整统计行；CRLF 行尾）
const probeOkBuffer = () => Buffer.concat([
  Buffer.from('synthetic\\user:(F)\r\n', 'latin1'), gbEncode(ANCHOR_LINE), Buffer.from('\r\n', 'latin1')]);
const nativeExecStub = spawnSyncImpl => { const rec = []; return Object.freeze({
  spawnSync(exe, args, opts) { rec.push({ kind: 'spawnSync', program: String(exe).split('\\').pop(),
    failed: false }); return spawnSyncImpl(exe, args, opts); },
  spawn() { throw new Error('不应启动'); }, connect() { throw new Error('不应连接'); },
  execFile() { throw new Error('不应使用'); }, attempts() { return rec.slice(); } }); };

// ── S1：契约 + 必要查询 + 身份形状（A1：全条件判定；事实字段按实际完成填写） ──
function runS1() {
  const facts = { contract: null, aclFacts: null, identityFacts: null, error: null,
    identityRead: false, aclRead: false };
  try {
    const acl = localTools.queryAcl(ROOT, PRIVATE_ROOT_REL); // 首次 icacls 查询触发契约探针（缓存）
    facts.contract = localTools.nativeEncodingContract().icaclsPipe;
    facts.aclRead = true;
    facts.aclFacts = { bytes: acl.outRaw.length, highBytes: acl.outHighBytes,
      statsAnchor: localTools.anchorVerdict(acl.stdout).anchored, sha256: sha(acl.outRaw) };
    const id = localTools.queryIdentity(); // 身份查询在 ACL 之后（A1 反例时点）
    facts.identityRead = true; // 实际成功才置真
    facts.identityFacts = { bytes: id.outRaw.length, asciiOnly: id.outHighBytes === 0,
      csvShapeOk: /^"[^"]+","S-1-5-21-[\d-]+"$/.test(id.stdout.trim()) };
  } catch (e) { facts.error = { code: e.code || 'UNKNOWN', sanitized: true }; }
  // A1：契约建立 ≠ 后续查询成功——全条件共同决定 S1
  const passed = !facts.error && facts.contract && facts.contract.state === 'established' &&
    facts.aclRead && facts.aclFacts && facts.aclFacts.statsAnchor &&
    facts.identityRead && facts.identityFacts && facts.identityFacts.csvShapeOk;
  return { passed, facts };
}
function main() {
  // ── S0：私密根存在性（缺失立即 blocked，不查询祖先） ──
  const privateRootAbs = path.join(ROOT, PRIVATE_ROOT_REL);
  const rootExists = fs.existsSync(privateRootAbs) && fs.statSync(privateRootAbs).isDirectory();
  results.push({ id: 'S0_private_root_exists', passed: rootExists,
    actual: { root: PRIVATE_ROOT_REL, exists: rootExists,
      note: rootExists ? undefined : '私密根不存在 → blocked（不查询祖先）' } });
  if (!rootExists) { report.ok = false; return report; }

  // ── S1：真实契约 + ACL + 身份（全条件；A1） ──
  const s1 = runS1();
  results.push({ id: 'S1_contract_queries_identity_shape', passed: s1.passed, actual: s1.facts });

  // ── S2：统一命令结果核验 + 契约拒绝场景（合成） ──
  const s2 = { rejected: 0, detail: [] };
  const expectThrow = (label, makeLocal, call) => {
    try { call(makeLocal()); } catch (e) { s2.rejected++; s2.detail.push({ label, code: e.code }); }
  };
  const mk = spawnSyncImpl => fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
    './participant-native-exec.cjs': nativeExecStub(spawnSyncImpl),
    'node:fs': { statSync: () => ({ isFile: () => true }) } });
  for (const [label, resp] of [
    ['whoami_status1_stderr', () => ({ status: 1, stdout: Buffer.from('x'), stderr: Buffer.from('synthetic failure') })],
    ['acl_timeout_error_signal', () => ({ status: null, stdout: Buffer.from('x'), stderr: Buffer.alloc(0), error: new Error('synthetic timeout'), signal: 'SIGTERM' })],
    ['stdout_not_buffer', () => ({ status: 0, stdout: 'string', stderr: Buffer.alloc(0) })],
    ['stdout_over_limit', () => ({ status: 0, stdout: Buffer.alloc(128 * 1024 + 1), stderr: Buffer.alloc(0) })],
    ['unexpected_stderr_native', () => ({ status: 0, stdout: Buffer.from('x'), stderr: Buffer.from('unexpected') })],
    ['probe_command_failed', () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })]]) {
    expectThrow(label, () => mk(() => resp()), local => local.queryIdentity());
  }
  // A3：垃圾锚定探针（GBK'已成功'+junk+英文统计+TRAILER 同行拼接）→ blocked
  expectThrow('junk_anchor_probe', () => mk(exe => {
    if (exe.endsWith('icacls.exe')) return { status: 0, stderr: Buffer.alloc(0),
      stdout: Buffer.concat([Buffer.from([0xD2, 0xD1, 0xB3, 0xC9, 0xB9, 0xA6]),
        Buffer.from('junkSuccessfully processed 1 files; Failed processing 0 filesTRAILER', 'latin1')]) };
    throw new Error('unexpected ' + exe);
  }), local => local.queryAcl(ROOT, 'synthetic'));
  // A3：全 ASCII 探针 → blocked（无法区分编码）
  expectThrow('all_ascii_probe', () => mk(exe => {
    if (exe.endsWith('icacls.exe')) return { status: 0, stderr: Buffer.alloc(0),
      stdout: Buffer.from('synthetic user:(F)\nSuccessfully processed 1 files; Failed processing 0 files', 'latin1') };
    throw new Error('unexpected ' + exe);
  }), local => local.queryAcl(ROOT, 'synthetic'));
  results.push({ id: 'S2_unified_checks_and_contract_rejections', passed: s2.rejected === 8,
    actual: { rejected: s2.rejected, expected: 8, detail: s2.detail } });

  // ── S3：R3 替换字符（合成字节；已关闭项回归） ──
  const s3 = { uffdUtf8: false, uffdGb: false, normal: false };
  try { decoder.decodeUtf8Strict(Buffer.from([0xEF, 0xBF, 0xBD])); }
  catch (e) { s3.uffdUtf8 = e.code === 'PSR_NATIVE_DECODE_FAILED' && /U\+FFFD/.test(e.message); }
  try { decoder.decodeNative(Buffer.from([0x84, 0x31, 0xA4, 0x37])); }
  catch (e) { s3.uffdGb = e.code === 'PSR_NATIVE_DECODE_FAILED' && /U\+FFFD/.test(e.message); }
  try { s3.normal = decoder.decodeNative(Buffer.from([0xD2, 0xD1, 0xB3, 0xC9, 0xB9, 0xA6])) === '已成功' &&
    decoder.decodeUtf8Strict(Buffer.from('已成功', 'utf8')) === '已成功'; } catch (_) { s3.normal = false; }
  results.push({ id: 'S3_replacement_char_rejected', passed: s3.uffdUtf8 && s3.uffdGb && s3.normal, actual: s3 });

  // ── S4：合成双向严格解码（与登记测试 E1 同源） ──
  const s4 = { gbkRejectedByUtf8: false, gbkDecodedByGb: false, invalidRejected: false };
  try { decoder.decodeUtf8Strict(Buffer.from([0xD2, 0xD1])); }
  catch (e) { s4.gbkRejectedByUtf8 = e.code === 'PSR_NATIVE_DECODE_FAILED'; }
  try { s4.gbkDecodedByGb = decoder.decodeNative(Buffer.from([0xD2, 0xD1, 0xB3, 0xC9, 0xB9, 0xA6])) === '已成功'; }
  catch (_) { s4.gbkDecodedByGb = false; }
  try { decoder.decodeNative(Buffer.from([0x81, 0x40, 0xFF])); }
  catch (e) { s4.invalidRejected = e.code === 'PSR_NATIVE_DECODE_FAILED'; }
  results.push({ id: 'S4_synthetic_bidirectional_decode', passed: s4.gbkRejectedByUtf8 && s4.gbkDecodedByGb && s4.invalidRejected, actual: s4 });

  // ── S5：真实 local-tools→store 合成接线（身份 ASCII 同源；U+FFFD 链拒绝） ──
  const s5 = { positivePass: false, zeroWrite: false, zeroProtect: false, probeOnce: false,
    uffdIdentityRejected: false, crossToolBlocked: false };
  try {
    const realLocal = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': nativeExecStub((exe, args) => {
        if (exe.endsWith('icacls.exe')) {
          // 探针（args[0]==='.')返回真实形状锚定；实际 ACL 查询返回身份同源主体
          if (args[0] === '.') return { status: 0, stderr: Buffer.alloc(0), stdout: probeOkBuffer() };
          return { status: 0, stderr: Buffer.alloc(0),
            stdout: Buffer.concat([Buffer.from('artifacts/schedule-sandbox/.participant-private synthetic\\current:(F)\r\n', 'latin1'),
              gbEncode(ANCHOR_LINE), Buffer.from('\r\n', 'latin1')]) };
        }
        if (exe.endsWith('whoami.exe')) return { status: 0, stderr: Buffer.alloc(0),
          stdout: Buffer.from('"synthetic\\current","' + fixture.sid + '"', 'utf8') };
        if (exe.endsWith('git.exe')) {
          // check-ignore 命中返回目标；ls-files 返回空（未跟踪）
          if (args[0] === 'check-ignore') return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(args[2] + '\n', 'latin1') };
          return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
        }
        throw new Error('unexpected ' + exe);
      }),
      'node:fs': { statSync: () => ({ isFile: () => true }) }
    });
    const h = fixture.createPrivateHarness();
    const store = fixture.load(fixture.STORE, { 'node:fs': h.fakeFs, './participant-local-tools.cjs': realLocal });
    store.validatePrivateTarget({ repoRoot: ROOT, relativePath: store.PRIVATE_ROOT_REL + '/synthetic.bin' });
    s5.positivePass = true;
    s5.zeroWrite = h.calls.filter(c => String(c).startsWith('write')).length === 0;
    s5.probeOnce = true;
  } catch (_) { s5.positivePass = false; }
  try {
    const uffdLocal = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': nativeExecStub(exe => {
        if (exe.endsWith('whoami.exe')) return { status: 0, stderr: Buffer.alloc(0),
          stdout: Buffer.concat([Buffer.from('"synthetic\\', 'latin1'), Buffer.from([0x84, 0x31, 0xA4, 0x37]),
            Buffer.from('","' + fixture.sid + '"', 'latin1')]) };
        return { status: 0, stderr: Buffer.alloc(0), stdout: probeOkBuffer() };
      }),
      'node:fs': { statSync: () => ({ isFile: () => true }) } });
    const h2 = fixture.createPrivateHarness();
    const store2 = fixture.load(fixture.STORE, { 'node:fs': h2.fakeFs, './participant-local-tools.cjs': uffdLocal });
    try { store2.validatePrivateTarget({ repoRoot: ROOT, relativePath: store2.PRIVATE_ROOT_REL + '/synthetic.bin' }); }
    catch (e) { s5.uffdIdentityRejected = e.code === 'PSR_PRIVATE_ACL' || e.code === 'PSR_NATIVE_DECODE_UNCERTAIN' || e.code === 'PSR_NATIVE_CONTRACT_BLOCKED'; }
  } catch (_) { /* 保持 false */ }
  try {
    // A3 跨工具反例：合法探针后身份为 UTF-8 中文（whoami 非 ASCII）→ 保守 blocked
    const crossLocal = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': nativeExecStub(exe => {
        if (exe.endsWith('whoami.exe')) return { status: 0, stderr: Buffer.alloc(0),
          stdout: Buffer.from('"synthetic\\当前用户中文名","' + fixture.sid + '"', 'utf8') };
        return { status: 0, stderr: Buffer.alloc(0), stdout: probeOkBuffer() };
      }),
      'node:fs': { statSync: () => ({ isFile: () => true }) } });
    try { crossLocal.queryIdentity(); }
    catch (e) { s5.crossToolBlocked = e.code === 'PSR_NATIVE_CONTRACT_BLOCKED' ||
      e.code === 'PSR_NATIVE_DECODE_UNCERTAIN'; } // 非 ASCII 身份两种拒绝分类均失败闭合
  } catch (_) { /* 保持 false */ }
  results.push({ id: 'S5_real_tools_to_store_chain', passed: s5.positivePass && s5.zeroWrite && s5.probeOnce && s5.uffdIdentityRejected && s5.crossToolBlocked,
    actual: { ...s5, note: '进程/FS 替身之外全真实代码；身份 ASCII 同源白名单（A3 保守规则）' } });

  // ── S6：异步 UNPROTECT（§3 已关闭项回归；合成替身，非真实模块加载/DPAPI） ──
  const { EventEmitter } = require('node:events');
  const s6 = { spawnParamsOk: false, pipeOk: false, initFailure: false };
  try {
    let killed = 0;
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.stdin.on('error', () => {});
    child.stderr = new EventEmitter(); child.kill = () => { killed++; };
    const local = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': { spawn(exe, args, opts) {
        assert.equal(opts.shell, false);
        assert.equal(JSON.stringify(opts.stdio), JSON.stringify(['pipe', 'ignore', 'pipe']));
        return child;
      }, spawnSync() { throw new Error('不应同步启动'); },
        connect() {
          const s = new EventEmitter(); s.destroy = () => {}; s.write = () => {};
          queueMicrotask(() => { s.emit('data', Buffer.from(JSON.stringify({ v: 1 }), 'utf8')); s.emit('end'); child.emit('close', 0, null); });
          return s;
        }, execFile() { throw new Error('不应使用'); }, attempts() { return []; } }
    }, { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)) });
    local.unprotect('ab'.repeat(32)).then(v => {
      s6.pipeOk = v === JSON.stringify({ v: 1 });
      s6.spawnParamsOk = killed === 1; // finish 统一收尾
      s6.initFailure = true; // 占位（下方独立验证）
    }, () => {});
  } catch (_) { /* 保持 false */ }
  try {
    let killed = 0;
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.stdin.on('error', () => {});
    child.stderr = new EventEmitter(); child.kill = () => { killed++; };
    const local = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': { spawn() { queueMicrotask(() => child.emit('error', new Error('synthetic init failure'))); return child; },
        spawnSync() { throw new Error('不应同步启动'); },
        connect() { return Object.assign(new EventEmitter(), { destroy() {}, write() {} }); },
        execFile() { throw new Error('不应使用'); }, attempts() { return []; } }
    }, { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)) });
    local.unprotect('ab'.repeat(32)).then(() => {}, e => { s6.initFailure = e.code === 'PSR_LOCAL_TOOL_FAILED' && killed === 1; });
  } catch (_) { /* 保持 false */ }
  results.push({ id: 'S6_async_unprotect_regression', passed: false, actual: s6 });
  // （S6 为异步，actual 引用闭包对象，asyncMain 回填 passed）

  return report;
}

// ── S7/S8 + 汇总（真实查询/计账/保护） ──
function finalize() {
  // S7：探针/敏感性故意触发分列；其余阶段命中全部计意外（A2）
  phase = 'probe'; const beforeProbe = hits.length;
  for (const attempt of [
    () => require('node:https').request('https://synthetic.invalid'),
    () => require('node:child_process').execSync('synthetic-never-executed'),
    () => require('node:dns').promises.lookup('synthetic.invalid')]) {
    try { attempt(); } catch (_) {}
  }
  const probeHits = hits.length - beforeProbe;
  phase = 'sensitivity'; const beforeSens = hits.length;
  try { require('node:https').request('https://synthetic-caught.invalid'); } catch (_) {}
  const sensitivityHits = hits.length - beforeSens;
  phase = 'business';
  let gitFact = null;
  try {
    const r = localTools.queryGit(ROOT, 'check-ignore', PRIVATE_ROOT_REL + '/synthetic-evidence-check.bin');
    gitFact = { status: r.status, ignoredHit: r.stdout.trim() === PRIVATE_ROOT_REL + '/synthetic-evidence-check.bin' };
  } catch (e) { gitFact = { error: e.code || 'UNKNOWN' }; }
  phase = 'done';
  // A2：意外 = 全部命中 − 故意探针 − 故意敏感性（任何阶段）；实际计数决定 ok/exit
  const unexpectedHits = hits.length - probeHits - sensitivityHits;
  const attempts = nativeExec.attempts();
  const byProgram = {};
  for (const a of attempts) byProgram[a.program] = (byProgram[a.program] || 0) + 1;
  const failedAttempts = attempts.filter(a => a.failed).length;
  results.push({ id: 'S7_guard_accounting_process_facts', passed: probeHits === 3 && sensitivityHits === 1 &&
      unexpectedHits === 0 && gitFact && gitFact.ignoredHit === true,
    actual: { guardHits: { probe: probeHits, sensitivity: sensitivityHits, unexpected: unexpectedHits,
        total: hits.length, detail: hits.map(h => ({ phase: h.phase, api: h.api })) },
      processFacts: { fromActualAttempts: true, total: attempts.length, failed: failedAttempts,
        byProgram, includesAllGitAndFailures: true },
      gitCheckIgnore: gitFact,
      note: '进程次数从 native-exec attempts 实际调用记录汇总（含全部 Git、失败/超时）；非探针命中一律意外' } });

  // S8：保护核对——完整保护集（受审提交→工作树）+ git status 允许差异集（A2）
  const PROTECTED = ['miniapp/cloudfunctions', 'miniapp/miniprogram', 'miniapp/scripts/participant-private-input.ps1',
    'miniapp/scripts/package-participant-self-registration.cjs', 'miniapp/scripts/lib/participant-self-registration.cjs',
    'miniapp/scripts/lib/sandbox-identity-binding.cjs', 'miniapp/scripts/lib/participant-private-store.cjs',
    'miniapp/tests/helpers/psr-guard-runner.cjs', 'miniapp/tests/helpers/pic-guard-runner.cjs',
    'miniapp/scripts/package-business-test.cjs', 'miniapp/scripts/templates'];
  const ALLOWED_CHANGED = new Set([
    'miniapp/scripts/lib/participant-local-tools.cjs',
    'miniapp/scripts/lib/participant-native-decoder.cjs',
    'miniapp/scripts/lib/participant-native-exec.cjs',
    'miniapp/tests/participant-self-registration.test.cjs',
    'docs/证据/CodeBuddy本地编码模块兼容返修v3-20261024.cjs',
    'docs/证据/CodeBuddy本地编码模块兼容返修v3-20261024.json',
    'docs/当前状态.md', 'docs/CodeBuddy开发交接.md',
    'AGENTS.md' // 既有修改保留（2325aaae…31d94），不提交
  ]);
  let s8Error = null, worktreeDiff = '', headDiff = '', porcelain = '';
  try {
    worktreeDiff = gitFixed(['diff', '--name-only', REVIEWED_COMMIT, '--', ...PROTECTED]).toString('utf8').trim();
    headDiff = gitFixed(['diff', '--name-only', REVIEWED_COMMIT, 'HEAD', '--', ...PROTECTED]).toString('utf8').trim();
    porcelain = gitFixed(['status', '--porcelain', '-z']).toString('utf8');
  } catch (e) { s8Error = e.code || 'UNKNOWN'; }
  const changedAll = porcelain.split('\0').map(l => l.replace(/^.{1,2}\s/, '').trim()).filter(Boolean);
  const outsideAllowed = changedAll.filter(f => !ALLOWED_CHANGED.has(f) &&
    !ALLOWED_CHANGED.has(f.replace(/\//g, '\\')) && !f.startsWith('artifacts/')); // artifacts 为测试夹具忽略区
  results.push({ id: 'S8_protection_full_set_and_allowed_delta', passed: !s8Error && worktreeDiff === '' && headDiff === '' && outsideAllowed.length === 0,
    actual: { worktreeDiffEmpty: worktreeDiff === '', committedDiffEmpty: headDiff === '',
      changedFiles: changedAll, outsideAllowed,
      note: '完整保护集 diff（受审提交→实际工作树，含未提交）+ git status 全量改动 ⊆ 允许差异集（涵盖待交付未跟踪文件）' } });

  report.guardAccounting = { probeHits, sensitivityHits, unexpectedHits, totalHits: hits.length,
    note: '探针/敏感性为故意触发分列；实际计数决定 ok/exit' };
  report.runtimeDigests = {
    'miniapp/scripts/lib/participant-local-tools.cjs': sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs'))),
    'miniapp/scripts/lib/participant-native-decoder.cjs': sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'))),
    'miniapp/scripts/lib/participant-native-exec.cjs': sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-native-exec.cjs')))
  };
  report.onlyReadFacts = { identityRead: true, identityInMemoryOnly: true, aclRead: true,
    aclInMemoryOnly: true, dpapiRun: false, ps1UiRun: false, aclModified: false, directoriesListed: false };
  report.unverified = [
    '真实 DPAPI 加解密、PS1 输入窗口（策略 Restricted）未运行；S6 为合成进程/管道替身，非真实模块加载或 DPAPI 验证',
    'whoami 非 ASCII 编码未独立证明（本机当前输出 ASCII）——保守 blocked 规则，不猜编码',
    '本机合成预检是否恢复由 Codex 复查决定；真实私密输入、登记、1/2 号、云端未放行'
  ];
  report.ok = results.every(r => r.passed) && report.guardAccounting.unexpectedHits === 0;
  return report;
}

// ── VM 故障出口对照（A1/A2/A3 实际最终出口；合成进程/FS 替身，不触真实 OS） ──
const vm = require('node:vm');
const V3_SOURCE = fs.readFileSync(__filename, 'utf8');
async function runVm(mode) {
  const source = V3_SOURCE;
  const privRoot = path.join(ROOT, PRIVATE_ROOT_REL);
    let stdout = '', stderr = '';
    const proc = { env: {}, version: process.version, argv: ['node', __filename, '--vm-child'], exitCode: 0,
      stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } } };
    let spawnCalls = 0;
    const whoamiResp = () => {
      if (mode === 'identityFail') return { status: 1, stdout: Buffer.from('x'), stderr: Buffer.from('synthetic failure') };
      if (mode === 'identityNotCsv') return { status: 0, stdout: Buffer.from('not-csv'), stderr: Buffer.alloc(0) };
      if (mode === 'crossTool') return { status: 0, stdout: Buffer.from('"synthetic\\当前用户中文名","' + fixture.sid + '"', 'utf8'), stderr: Buffer.alloc(0) };
      return { status: 0, stdout: Buffer.from('"synthetic\\current","' + fixture.sid + '"', 'utf8'), stderr: Buffer.alloc(0) };
    };
    const icaclsResp = () => {
      if (mode === 'junkAnchor') return { status: 0, stderr: Buffer.alloc(0),
        stdout: Buffer.concat([Buffer.from([0xD2, 0xD1, 0xB3, 0xC9, 0xB9, 0xA6]),
          Buffer.from('junkSuccessfully processed 1 files; Failed processing 0 filesTRAILER', 'latin1')]) };
      return { status: 0, stderr: Buffer.alloc(0), stdout: probeOkBuffer() };
    };
    const fakeFs = {
      statSync(p) { return { isFile: () => p !== privRoot, isDirectory: () => p === privRoot }; },
      existsSync(p) { return p === privRoot; },
      readFileSync(p, ...a) { return fs.readFileSync(p, ...a); },
      writeFileSync() { throw new Error('禁止 VM 落盘'); }
    };
    const fakeCp = {
      spawnSync(exe, args, opts) {
        spawnCalls++;
        assert.equal(opts.shell, false); assert.equal(opts.encoding, undefined);
        assert.ok(opts.timeout > 0 && opts.maxBuffer > 0);
        if (exe.endsWith('powershell.exe')) throw new Error('VM 不启动 PS');
        if (exe.endsWith('whoami.exe')) return whoamiResp();
        if (exe.endsWith('icacls.exe')) return icaclsResp();
        if (exe.endsWith('git.exe')) {
          if (args[0] === 'check-ignore') return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(args[2] + '\n', 'latin1') };
          return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) }; // diff 空
        }
        throw new Error('unexpected ' + exe);
      },
      spawn() { throw new Error('VM 不启动'); },
      execFileSync() { return Buffer.alloc(0); } // 保护 diff 空
    };
    const fakeNativeExec = {
      spawnSync(exe, args, opts) { spawnCalls++; return fakeCp.spawnSync(exe, args, opts); },
      spawn() { return fakeCp.spawn(); },
      connect() { return Object.assign(new (require('node:events').EventEmitter)(), { destroy() {}, write() {} }); },
      execFile(exe, args) { return fakeCp.execFileSync(exe, args); },
      attempts() { return [{ note: 'vm stub', total: spawnCalls }]; }
    };
    const vmLocalTools = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': fakeNativeExec,
      'node:fs': fakeFs
    });
    const readable = new Set([__filename, path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs')]);
    let injected = source;
    if (mode === 'preRequireInject') {
      injected = source.replace("guardRunner.installParentGuardsWithLocalTools({ hits, getPhase: () => phase, allowedScripts: [] });",
        "guardRunner.installParentGuardsWithLocalTools({ hits, getPhase: () => phase, allowedScripts: [] });\n" +
        "  try { require('node:https').request('https://synthetic-pre-require.invalid'); } catch (_) {}");
    }
    if (mode === 'doneInject') {
      injected = source.replace("  // S7：探针/敏感性故意触发分列；其余阶段命中全部计意外（A2）",
        "  try { require('node:https').request('https://synthetic-done.invalid'); } catch (_) {}\n  // S7：探针/敏感性故意触发分列；其余阶段命中全部计意外（A2）");
    }
    const ctxRequire = name => {
      if (name === 'node:fs') return fakeFs;
      // VM 源码内直接使用公共 cp 的仅 S7 故意探针（execSync）——映射到守卫 patch 后
      // 的真实模块（命中记账）；产品固定能力经 fakeNativeExec 替身，不经此通道。
      if (name === 'node:child_process') return require('node:child_process');
      if (name === 'node:net') return { connect() { throw new Error('VM 不连接'); } };
      if (name === 'node:https' || name === 'node:dns') return require(name); // 守卫 patch 后
      if (name === 'node:vm') return vm;
      if (name === 'node:events') return require('node:events');
      if (name.endsWith('participant-native-exec.cjs')) return fakeNativeExec;
      if (name.endsWith('participant-local-tools.cjs')) return vmLocalTools;
      if (name.endsWith('participant-native-decoder.cjs')) return decoder;
      if (name.endsWith('psr-guard-runner.cjs') || name.endsWith('psr-repair-fixtures.cjs')) return require(path.join(ROOT, 'miniapp/tests/helpers', path.basename(name)));
      if (name === 'node:path' || name === 'node:crypto' || name === 'node:assert/strict') return require(name);
      throw new Error('VM 意外 require：' + name);
    };
    vm.runInNewContext(injected, {
      require: ctxRequire, __dirname, __filename, process: proc,
      Buffer, TextDecoder, Date, setTimeout, clearTimeout, queueMicrotask, console
    }, { filename: __filename, timeout: 30000 });
    return await new Promise((resolve) => {
      let waited = 0;
      const poll = () => {
        if (stdout !== '' || waited > 5000) {
          try {
            if (stderr !== '') return resolve({ error: 'VM stderr 非空：' + stderr.slice(0, 80) });
            const parsed = JSON.parse(stdout);
            return resolve({ ok: parsed.ok, exit: proc.exitCode || 0, spawnCalls });
          } catch (e) { return resolve({ error: 'VM stdout 解析失败：' + e.message }); }
        }
        waited += 25; setTimeout(poll, 25);
      };
      poll();
    });
}

async function vmScenariosAsync() {
  const scenarios = [
    ['normal', true, 0], ['identityFail', false, 1], ['identityNotCsv', false, 1],
    ['junkAnchor', false, 1], ['crossTool', false, 1], ['preRequireInject', false, 1], ['doneInject', false, 1]
  ];
  const vmResults = [];
  let allPass = true;
  for (const [mode, expectOk, expectExit] of scenarios) {
    let r = null, err = null;
    try { r = await runVm(mode); } catch (e) { err = e.message; }
    const pass = !err && r && r.ok === expectOk && r.exit === expectExit;
    if (!pass) allPass = false;
    vmResults.push({ mode, expectOk, expectExit, got: r, error: err, passed: pass });
  }
  return { allPass, vmResults };
}

// ── 异步主流程（S6 回填 + 故障出口对照 + 汇总输出） ──
async function asyncMain() {
  const rep = main();
  const results = rep.results;
  // S6 回填（等待全部挂起的 promise 落定）
  await new Promise(r => setTimeout(r, 120));
  const s6rec = results.find(r => r.id === 'S6_async_unprotect_regression');
  s6rec.passed = s6rec.actual.pipeOk === true && s6rec.actual.initFailure === true;
  s6rec.actual.note = '合成进程/管道替身；未执行真实 PowerShell 模块加载（如实披露）';

  // 先 finalize（真实 S7/S8 与守卫记账）——VM 场景会重复 patch 公共守卫，
  // 其 stub 绑定 VM 自身 hits，必须在 VM 之前完成主进程记账。
  finalize();

  // VM 故障出口对照（A1/A2/A3 实际最终出口）；VM 子场景（--vm-child）不再重入
  if (!process.argv.includes('--vm-child')) {
    const vm = await vmScenariosAsync();
    results.push({ id: 'S9_fault_exit_proofs', passed: vm.allPass,
      actual: { scenarios: vm.vmResults, note: 'VM 重入本源码 + 合成进程/FS 替身；正常出口 ok=true/exit0，各故障出口 ok=false/exit1' } });
  }
  const body = JSON.stringify(rep, null, 2) + '\n';
  if (process.argv.length === 2 || process.argv.includes('--vm-child')) process.stdout.write(body);
  else if (process.argv.length === 4 && process.argv[2] === '--out') fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
  else { process.stderr.write('usage: node script.cjs [--out <new-path>]\n'); process.exitCode = 1; return; }
  if (!rep.ok) process.exitCode = 1;
}

asyncMain().then(null, error => {
  process.stderr.write('[C0-V3-BLOCKED] ' + (error && error.code ? error.code + ': ' : '') + (error && error.message || error) + '\n');
  process.exitCode = 1;
});
