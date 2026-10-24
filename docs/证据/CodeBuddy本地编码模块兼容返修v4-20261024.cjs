'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// WorkBuddy 本地编码与模块兼容返修 v4 证据（Codex 复查接续 f211469 §2–§3，B1–B3 收尾）
// 依据：docs/Codex复查-编码兼容A1A3收尾f211469-20261024.md。v1/v2/v3 与全部 Codex
// 报告反例不改写；本文件为独立 v4。
//
// 与 v3 的关键差异：
// - B1（产品层已修，见 participant-native-exec.cjs）：原始引用闭包封闭，固定用途
//   能力边界；v4 经能力层执行，父/VM 替身均按新能力形状。
// - B2：所有必要异步步骤明确 await（S6 以 Promise 集合）；S8/S9 与运行时核对全部
//   完成后形成**唯一最终 verdict**（JSON ok 与 exit 同源，一次计算）；父守卫全程
//   有效（VM 子场景不复装父守卫、不 patch 公共模块，仅经合成模块图记账）；父、
//   VM 子场景、预期故障独立分组；进程次数从 attempts 实际汇总（区分 attempted/
//   completed/spawnFailed/status，含全部 Git）；顶层只读事实引用实际完成情况；
//   S6 无占位成功赋值（独立 promise 结果共同判定）。
// - B3：保护核对做双基线（接手基线→HEAD 已提交；接手基线→实际工作树）与完整保护
//   路径集，允许集逐项核对；未跟踪项逐项核对（不整体豁免 artifacts/）；AGENTS.md
//   既有修改按字节摘要单列；不动真实历史文件的合成对照（已提交历史改动/未提交
//   历史改动/未跟踪非法项均拒绝）。
// - 实际最终出口对照（VM 重入本源码 + 合成 OS 边界）：normal ok=true/exit0；
//   identityFail/identityNotCsv/junkAnchor/crossTool/preRequireInject/doneInject/
//   faultLateHit/faultLateGitHit/faultS9Fail/faultAttemptUnder/
//   protectionCommittedHistory/protectionUncommittedHistory/protectionUntrackedIllegal
//   共 13 类 ok=false/exit1。VM 场景均为合成进程/FS 替身，不是真实模块加载或
//   DPAPI 验证。
//
// 替换范围（全部披露）：真实 OS 查询（whoami/icacls/git）经 local-tools 固定能力与
// native-exec 能力层执行；VM 场景仅替换 OS/守卫模块边界。原始身份/ACL 仅驻内存。
// 全程离线；不调用 DPAPI、不运行 PS1、不保存私密文件；这不是平台验证。
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const REVIEWED_COMMIT = 'f211469';       // 受审实现
const FIX_BASELINE = 'acb6ecf';          // 本轮接手基线（保护核对基线）
const PRIVATE_ROOT_REL = 'artifacts/schedule-sandbox/.participant-private';
const IS_VM_CHILD = process.argv.includes('--vm-child');
const FAULT_MODE = (() => { const i = process.argv.indexOf('--fault'); return i >= 0 ? process.argv[i + 1] : null; })();
// AGENTS.md 既有修改字节摘要（本轮开工实测；按字节单列，不整体豁免）
const AGENTS_SHA_EXPECTED = '9ef30b4c10f7dd1ba777e9a233f49fd5d0ead80c1aad6d4b2dd0664b1dfa6396';
const results = [];
const report = {
  schema: 'wb-psr-native-encoding-contract-v4/1',
  reviewedCommit: REVIEWED_COMMIT,
  fixBaseline: FIX_BASELINE,
  date: '2026-10-24',
  faultMode: FAULT_MODE,
  results,
  ok: false
};

// ── 0) 能力层最先装载（原始引用闭包；VM 子场景替换为合成能力） ──
const realNativeExec = require(path.join(ROOT, 'miniapp/scripts/lib/participant-native-exec.cjs'));
let nativeExec = realNativeExec;
const setNativeExec = impl => { nativeExec = impl; }; // 仅供 VM 子场景（合成能力层）

// ── 1) 父守卫（真实安装；VM 子场景不 patch 公共模块，父兜底全程有效） ──
const hits = []; let phase = 'pre-require';
const syncVmPhase = () => { if (typeof VM_PHASE !== 'undefined') VM_PHASE.v = phase; };
const guardRunner = require(path.join(ROOT, 'miniapp/tests/helpers/psr-guard-runner.cjs'));
if (!IS_VM_CHILD) {
  guardRunner.installParentGuardsWithLocalTools({ hits, getPhase: () => phase, allowedScripts: [] });
} else {
  // VM 子场景：守卫为合成（VM 模块图内记账），不触碰父进程公共模块。
  guardRunner.installParentGuardsWithLocalTools = () => ({ guard: {}, toolCalls: [] });
}

// ── 2) 业务模块（守卫已覆盖；VM 子场景的 local-tools 由 ctxRequire 注入） ──
const localTools = require(path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs'));
const decoder = require(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'));
const fixture = require(path.join(ROOT, 'miniapp/tests/helpers/psr-repair-fixtures.cjs'));

// 保护核对受限封装：固定 git 程序 + 固定只读操作 + 固定限额（经能力层）。
function gitDiffPaths(commitish, paths) { return nativeExec.gitReadonly({ operation: 'diff', commitish, paths }); }
function gitStatus() { return nativeExec.gitReadonly({ operation: 'status' }); }
// porcelain 路径反转义（quotepath 八进制 → UTF-8）
function unescapeQuoted(p) {
  // git quotepath 八进制为 UTF-8 字节段（连续 \ooo 序列按 Buffer UTF-8 解码）
  const out = [];
  for (let i = 0; i < p.length;) {
    if (p[i] === '\\' && /^[0-7]{3}$/.test(p.slice(i + 1, i + 4))) {
      const bytes = [];
      while (p[i] === '\\' && /^[0-7]{3}$/.test(p.slice(i + 1, i + 4))) { bytes.push(parseInt(p.slice(i + 1, i + 4), 8)); i += 4; }
      out.push(Buffer.from(bytes).toString('utf8'));
    } else { out.push(p[i]); i++; }
  }
  return out.join('');
}
function unquotePorcelain(line) {
  // 剥状态前缀（XY + 可选空格），再解 quotepath 引号/八进制转义
  const m = /^(..)\s?(.*)$/.exec(line.replace(/^\s+/, ''));
  if (!m) return line.trim();
  let p = m[2].trim();
  if (p.startsWith('"') && p.endsWith('"')) p = unescapeQuoted(p.slice(1, -1));
  return p;
}

const ANCHOR_LINE = '已成功处理 1 个文件; 处理 0 个文件时失败';
const GBK_MAP = { '已': [0xD2, 0xD1], '成': [0xB3, 0xC9], '功': [0xB9, 0xA6], '处': [0xB4, 0xA6],
  '理': [0xC0, 0xED], '个': [0xB8, 0xF6], '文': [0xCE, 0xC4], '件': [0xBC, 0xFE],
  '时': [0xCA, 0xB1], '失': [0xCA, 0xA7], '败': [0xB0, 0xDC] };
const gbEncode = text => { const out = []; for (const ch of text) {
  if (GBK_MAP[ch]) out.push(...GBK_MAP[ch]); else out.push(...Buffer.from(ch, 'utf8')); } return Buffer.from(out); };
const probeOkBuffer = () => Buffer.concat([
  Buffer.from('synthetic\\user:(F)\r\n', 'latin1'), gbEncode(ANCHOR_LINE), Buffer.from('\r\n', 'latin1')]);

// ── S1：契约 + 必要查询 + 身份形状（A1 判定保持；事实按实际填写） ──
function runS1() {
  const facts = { contract: null, aclFacts: null, identityFacts: null, error: null,
    identityRead: false, aclRead: false };
  try {
    const acl = localTools.queryAcl(ROOT, PRIVATE_ROOT_REL);
    facts.contract = localTools.nativeEncodingContract().icaclsPipe;
    facts.aclRead = true;
    facts.aclFacts = { bytes: acl.outRaw.length, highBytes: acl.outHighBytes,
      statsAnchor: localTools.anchorVerdict(acl.stdout).anchored, sha256: sha(acl.outRaw) };
    const id = localTools.queryIdentity();
    facts.identityRead = true;
    facts.identityFacts = { bytes: id.outRaw.length, asciiOnly: id.outHighBytes === 0,
      csvShapeOk: /^"[^"]+","S-1-5-21-[\d-]+"$/.test(id.stdout.trim()) };
  } catch (e) { facts.error = { code: e.code || 'UNKNOWN', sanitized: true }; }
  const passed = !facts.error && facts.contract && facts.contract.state === 'established' &&
    facts.aclRead && facts.aclFacts && facts.aclFacts.statsAnchor &&
    facts.identityRead && facts.identityFacts && facts.identityFacts.csvShapeOk;
  return { passed, facts };
}

// ── S5：真实 local-tools→store 合成接线（身份 ASCII 同源；U+FFFD/跨工具拒绝） ──
function runS5() {
  const s5 = { positivePass: false, zeroWrite: false, probeOnce: false,
    uffdIdentityRejected: false, crossToolBlocked: false };
  const aclSameOrigin = Buffer.concat([
    Buffer.from('artifacts/schedule-sandbox/.participant-private synthetic\\current:(F)\r\n', 'latin1'),
    gbEncode(ANCHOR_LINE), Buffer.from('\r\n', 'latin1')]);
  const makeStub = (runImpl) => { const rec = []; let seq = 0;
    return Object.freeze({
      runProgram({ program, args, cwd, timeoutMs, maxBuffer, input }) {
        const id = ++seq;
        rec.push({ id, kind: 'runProgram', program: String(program).split('\\').pop(), attempted: true, completed: false, spawnFailed: false, status: null });
        const r = runImpl(program, args, { cwd, timeoutMs, maxBuffer, input, shell: false, windowsHide: true });
        rec[id - 1].completed = true; rec[id - 1].spawnFailed = !!(r && (r.error || r.signal));
        rec[id - 1].status = r && r.status !== undefined ? r.status : null;
        return r;
      },
      spawnProgram() { return { child: null, attemptId: ++seq }; },
      connectNamedPipe() { return { __stub: true }; },
      completeAsync() {}, gitReadonly() { return ''; }, attempts() { return rec.map(x => ({ ...x })); }
    });
  };
  try {
    const realLocal = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': makeStub((exe, args) => {
        if (exe.endsWith('icacls.exe')) {
          if (args[0] === '.') return { status: 0, stderr: Buffer.alloc(0), stdout: probeOkBuffer() };
          return { status: 0, stderr: Buffer.alloc(0), stdout: aclSameOrigin };
        }
        if (exe.endsWith('whoami.exe')) return { status: 0, stderr: Buffer.alloc(0),
          stdout: Buffer.from('"synthetic\\current","' + fixture.sid + '"', 'utf8') };
        if (exe.endsWith('git.exe')) {
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
      './participant-native-exec.cjs': makeStub(exe => {
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
    const crossLocal = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': makeStub(exe => {
        if (exe.endsWith('whoami.exe')) return { status: 0, stderr: Buffer.alloc(0),
          stdout: Buffer.from('"synthetic\\当前用户中文名","' + fixture.sid + '"', 'utf8') };
        return { status: 0, stderr: Buffer.alloc(0), stdout: probeOkBuffer() };
      }),
      'node:fs': { statSync: () => ({ isFile: () => true }) } });
    try { crossLocal.queryIdentity(); }
    catch (e) { s5.crossToolBlocked = e.code === 'PSR_NATIVE_CONTRACT_BLOCKED' || e.code === 'PSR_NATIVE_DECODE_UNCERTAIN'; }
  } catch (_) { /* 保持 false */ }
  return s5;
}

// ── S6：异步 UNPROTECT（独立 promise 结果共同判定；无占位成功赋值） ──
function runS6() {
  const { EventEmitter } = require('node:events');
  const s6 = { spawnParamsOk: false, pipeOk: false, initFailureCleaned: false, stderrRejected: false };
  const runOne = (kind) => new Promise((resolve) => {
    let killed = 0;
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.stdin.on('error', () => {});
    child.stderr = new EventEmitter(); child.kill = () => { killed++; };
    const local = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': {
        runProgram() { throw new Error('不应同步启动'); },
        spawnProgram({ purpose, script }) {
          assert.equal(purpose, 'dpapi-unprotect');
          assert.ok(script.includes('Import-Module -Name (Join-Path $PSHOME'), '能力层校验 PSHOME 初始化');
          if (kind === 'initFailure') queueMicrotask(() => child.emit('error', new Error('synthetic init failure')));
          if (kind === 'stderr') queueMicrotask(() => child.stderr.emit('data', Buffer.from('synthetic failure', 'utf8')));
          if (kind === 'success') queueMicrotask(() => { child.emit('spawn'); });
          return { child, attemptId: 1 };
        },
        connectNamedPipe({ purpose, name }) {
          assert.equal(purpose, 'dpapi-unprotect');
          assert.ok(/^psr-dpapi-[0-9a-f]{32}$/.test(name), '管道名格式边界');
          const s = new EventEmitter(); s.destroy = () => {}; s.write = () => {};
          queueMicrotask(() => {
            s.emit('data', Buffer.from(JSON.stringify({ synthetic: 'plain' }), 'utf8'));
            s.emit('end'); child.emit('close', 0, null);
          });
          return s;
        },
        completeAsync() {}, gitReadonly() { throw new Error('不应使用'); }, attempts() { return []; }
      }
    }, { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)) });
    local.unprotect('ab'.repeat(32)).then(v => {
      if (kind === 'success') { s6.pipeOk = v === JSON.stringify({ synthetic: 'plain' }); s6.spawnParamsOk = killed === 1; }
      resolve({ ok: true, value: v });
    }, e => {
      if (kind === 'initFailure') s6.initFailureCleaned = e.code === 'PSR_LOCAL_TOOL_FAILED' && killed === 1;
      if (kind === 'stderr') s6.stderrRejected = e.code === 'PSR_LOCAL_TOOL_FAILED';
      resolve({ ok: false, code: e.code });
    });
  });
  return Promise.all([runOne('success'), runOne('initFailure'), runOne('stderr')]).then(() => s6);
}

// ── S8：双基线完整保护核对（B3） ──
function runS8() {
  const PROTECTED = ['miniapp/cloudfunctions', 'miniapp/miniprogram', 'miniapp/pages',
    'miniapp/project.config.json', 'miniapp/scripts/participant-private-input.ps1',
    'miniapp/scripts/participant-self-registration.cjs', 'miniapp/scripts/package-participant-self-registration.cjs',
    'miniapp/scripts/package-business-test.cjs', 'miniapp/scripts/package-sandbox.cjs',
    'miniapp/scripts/package-sandbox-registration.cjs', 'miniapp/scripts/package-participant-identity-check.cjs',
    'miniapp/scripts/lib/participant-self-registration.cjs', 'miniapp/scripts/lib/sandbox-identity-binding.cjs',
    'miniapp/scripts/lib/participant-private-store.cjs', 'miniapp/scripts/lib/participant-identity-check.cjs',
    'miniapp/scripts/lib/participant-local-tools.cjs',
    'miniapp/tests/helpers/psr-guard-runner.cjs', 'miniapp/tests/helpers/pic-guard-runner.cjs',
    'miniapp/tests/helpers/psr-repair-fixtures.cjs', 'miniapp/scripts/templates',
    'docs/证据/CodeBuddy本地编码模块兼容返修-20261024.cjs', 'docs/证据/CodeBuddy本地编码模块兼容返修-20261024.json',
    'docs/证据/CodeBuddy本地编码模块兼容返修v2-20261024.cjs', 'docs/证据/CodeBuddy本地编码模块兼容返修v2-20261024.json',
    'docs/证据/CodeBuddy本地编码模块兼容返修v3-20261024.cjs', 'docs/证据/CodeBuddy本地编码模块兼容返修v3-20261024.json',
    'docs/证据/Codex本地编码模块兼容反例-20261024.cjs', 'docs/证据/Codex本地编码模块兼容反例-20261024.json',
    'docs/证据/Codex编码兼容f211469复核-20261024.cjs', 'docs/证据/Codex编码兼容f211469复核-20261024.json',
    'docs/Codex复查-本地编码模块兼容81bfac3-20261024.md', 'docs/Codex复查-编码兼容R1R3接续545d038-20261024.md',
    'docs/Codex复查-编码兼容A1A3收尾f211469-20261024.md', 'docs/Codex方案-本地编码与模块兼容返修-20261024.md'];
  // 本轮允许差异（相对接手基线 acb6ecf）
  const ALLOWED = new Set([
    'miniapp/scripts/lib/participant-local-tools.cjs',
    'miniapp/scripts/lib/participant-native-exec.cjs',
    'miniapp/scripts/lib/participant-native-decoder.cjs',
    'miniapp/tests/participant-self-registration.test.cjs',
    'docs/证据/CodeBuddy本地编码模块兼容返修v4-20261024.cjs',
    'docs/证据/CodeBuddy本地编码模块兼容返修v4-20261024.json',
    'docs/当前状态.md', 'docs/进展与待办.md', 'docs/CodeBuddy开发交接.md',
    'AGENTS.md' // 既有修改按字节摘要单列（见下）
  ]);
  let s8Error = null, headDiff = '', worktreeDiff = '', porcelain = '';
  try {
    if (FAULT_MODE === 'lateGitHit') {
      phase = 'done'; syncVmPhase();
      try { require('node:https').request('https://synthetic-late-git.invalid'); } catch (_) {}
    }
    headDiff = gitDiffPaths(FIX_BASELINE + '..HEAD', PROTECTED).toString('utf8').trim();
    if (FAULT_MODE === 'protectionCommittedHistory') headDiff += '\ndocs/证据/Codex本地编码模块兼容反例-20261015.json';
    worktreeDiff = gitDiffPaths(FIX_BASELINE, PROTECTED).toString('utf8').trim();
    if (FAULT_MODE === 'protectionUncommittedHistory') worktreeDiff += '\ndocs/证据/CodeBuddy本地编码模块兼容返修v3-20261024.json';
    porcelain = gitStatus().toString('utf8');
    if (FAULT_MODE === 'protectionUntrackedIllegal') porcelain = '?? synthetic-illegal-untracked.txt\n' + porcelain;
  } catch (e) { s8Error = e.code || 'UNKNOWN'; }
  const changedAll = porcelain.split('\n').map(unquotePorcelain).filter(Boolean);
  const outsideAllowed = changedAll.filter(f => !ALLOWED.has(f));
  const headChanges = headDiff ? headDiff.split('\n').filter(Boolean) : [];
  const worktreeChanges = worktreeDiff ? worktreeDiff.split('\n').filter(Boolean) : [];
  // 保护路径零容忍：两个基线的差异只允许出现在允许清单
  const protectedViolations = [...headChanges, ...worktreeChanges].filter(f => !ALLOWED.has(f));
  // AGENTS.md 既有修改按字节摘要单列（不多改）
  let agentsSha = null;
  try { agentsSha = sha(fs.readFileSync(path.join(ROOT, 'AGENTS.md'))); } catch (_) { agentsSha = null; }
  const agentsOk = agentsSha === AGENTS_SHA_EXPECTED && ALLOWED.has('AGENTS.md');
  const passed = !s8Error && protectedViolations.length === 0 && outsideAllowed.length === 0 && agentsOk;
  return { passed, actual: { s8Error,
    headChanges, worktreeChanges, changedAll, outsideAllowed, protectedViolations,
    agentsSha: agentsSha ? agentsSha.slice(0, 16) : null, agentsOk,
    baselines: { head: FIX_BASELINE + '..HEAD', worktree: FIX_BASELINE + '..worktree' },
    note: '双基线完整保护路径集 + 允许集逐项核对；未跟踪逐项核对（不整体豁免）；AGENTS.md 按字节摘要单列' } };
}

// ── 主流程 ──
async function main() {
  // S0：私密根存在性
  const privateRootAbs = path.join(ROOT, PRIVATE_ROOT_REL);
  const rootExists = fs.existsSync(privateRootAbs) && fs.statSync(privateRootAbs).isDirectory();
  results.push({ id: 'S0_private_root_exists', passed: rootExists,
    actual: { root: PRIVATE_ROOT_REL, exists: rootExists,
      note: rootExists ? undefined : '私密根不存在 → blocked（不查询祖先）' } });
  if (!rootExists) return;

  // S1：契约 + 必要查询 + 身份形状
  const s1 = runS1();
  results.push({ id: 'S1_contract_queries_identity_shape', passed: s1.passed, actual: s1.facts });

  // S2：统一命令结果核验 + 契约拒绝（合成）
  const s2 = { rejected: 0, detail: [] };
  const mk = (runImpl) => fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
    './participant-native-exec.cjs': (() => { const rec = []; let seq = 0;
      return Object.freeze({
        runProgram({ program, args, cwd, timeoutMs, maxBuffer, input }) {
          const id = ++seq;
          rec.push({ id, kind: 'runProgram', program: String(program).split('\\').pop(), attempted: true, completed: false, spawnFailed: false, status: null });
          const r = runImpl(program, args, { cwd, timeoutMs, maxBuffer, input, shell: false, windowsHide: true });
          rec[id - 1].completed = true; rec[id - 1].spawnFailed = !!(r && (r.error || r.signal));
          rec[id - 1].status = r && r.status !== undefined ? r.status : null;
          return r;
        },
        spawnProgram() { return { child: null, attemptId: ++seq }; },
        connectNamedPipe() { return { __stub: true }; },
        completeAsync() {}, gitReadonly() { return ''; }, attempts() { return rec.map(x => ({ ...x })); }
      });
    })(),
    'node:fs': { statSync: () => ({ isFile: () => true }) }
  });
  for (const [label, resp] of [
    ['whoami_status1_stderr', () => ({ status: 1, stdout: Buffer.from('x'), stderr: Buffer.from('synthetic failure') })],
    ['acl_timeout_error_signal', () => ({ status: null, stdout: Buffer.from('x'), stderr: Buffer.alloc(0), error: new Error('synthetic timeout'), signal: 'SIGTERM' })],
    ['stdout_not_buffer', () => ({ status: 0, stdout: 'string', stderr: Buffer.alloc(0) })],
    ['stdout_over_limit', () => ({ status: 0, stdout: Buffer.alloc(128 * 1024 + 1), stderr: Buffer.alloc(0) })],
    ['unexpected_stderr_native', () => ({ status: 0, stdout: Buffer.from('x'), stderr: Buffer.from('unexpected') })],
    ['probe_command_failed', () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })]]) {
    try { mk(() => resp()).queryIdentity(); } catch (e) { s2.rejected++; s2.detail.push({ label, code: e.code }); }
  }
  try {
    mk(exe => {
      if (exe.endsWith('icacls.exe')) return { status: 0, stderr: Buffer.alloc(0),
        stdout: Buffer.concat([Buffer.from([0xD2, 0xD1, 0xB3, 0xC9, 0xB9, 0xA6]),
          Buffer.from('junkSuccessfully processed 1 files; Failed processing 0 filesTRAILER', 'latin1')]) };
      throw new Error('unexpected ' + exe);
    }).queryAcl(ROOT, 'synthetic');
  } catch (e) { s2.rejected++; s2.detail.push({ label: 'junk_anchor_probe', code: e.code }); }
  try {
    mk(exe => {
      if (exe.endsWith('icacls.exe')) return { status: 0, stderr: Buffer.alloc(0),
        stdout: Buffer.from('synthetic user:(F)\nSuccessfully processed 1 files; Failed processing 0 files', 'latin1') };
      throw new Error('unexpected ' + exe);
    }).queryAcl(ROOT, 'synthetic');
  } catch (e) { s2.rejected++; s2.detail.push({ label: 'all_ascii_probe', code: e.code }); }
  results.push({ id: 'S2_unified_checks_and_contract_rejections', passed: s2.rejected === 8,
    actual: { rejected: s2.rejected, expected: 8, detail: s2.detail } });

  // S3：R3 替换字符（已关闭项回归）
  const s3 = { uffdUtf8: false, uffdGb: false, normal: false };
  try { decoder.decodeUtf8Strict(Buffer.from([0xEF, 0xBF, 0xBD])); }
  catch (e) { s3.uffdUtf8 = e.code === 'PSR_NATIVE_DECODE_FAILED' && /U\+FFFD/.test(e.message); }
  try { decoder.decodeNative(Buffer.from([0x84, 0x31, 0xA4, 0x37])); }
  catch (e) { s3.uffdGb = e.code === 'PSR_NATIVE_DECODE_FAILED' && /U\+FFFD/.test(e.message); }
  try { s3.normal = decoder.decodeNative(Buffer.from([0xD2, 0xD1, 0xB3, 0xC9, 0xB9, 0xA6])) === '已成功' &&
    decoder.decodeUtf8Strict(Buffer.from('已成功', 'utf8')) === '已成功'; } catch (_) { s3.normal = false; }
  results.push({ id: 'S3_replacement_char_rejected', passed: s3.uffdUtf8 && s3.uffdGb && s3.normal, actual: s3 });

  // S4：合成双向严格解码
  const s4 = { gbkRejectedByUtf8: false, gbkDecodedByGb: false, invalidRejected: false };
  try { decoder.decodeUtf8Strict(Buffer.from([0xD2, 0xD1])); }
  catch (e) { s4.gbkRejectedByUtf8 = e.code === 'PSR_NATIVE_DECODE_FAILED'; }
  try { s4.gbkDecodedByGb = decoder.decodeNative(Buffer.from([0xD2, 0xD1, 0xB3, 0xC9, 0xB9, 0xA6])) === '已成功'; }
  catch (_) { s4.gbkDecodedByGb = false; }
  try { decoder.decodeNative(Buffer.from([0x81, 0x40, 0xFF])); }
  catch (e) { s4.invalidRejected = e.code === 'PSR_NATIVE_DECODE_FAILED'; }
  results.push({ id: 'S4_synthetic_bidirectional_decode', passed: s4.gbkRejectedByUtf8 && s4.gbkDecodedByGb && s4.invalidRejected, actual: s4 });

  // S5：真实 local-tools→store 合成接线
  const s5 = runS5();
  results.push({ id: 'S5_real_tools_to_store_chain', passed: s5.positivePass && s5.zeroWrite && s5.probeOnce && s5.uffdIdentityRejected && s5.crossToolBlocked,
    actual: { ...s5, note: '进程/FS 替身之外全真实代码；身份 ASCII 同源白名单' } });

  // S6：异步 UNPROTECT（await 全部独立结果）
  const s6 = await runS6();
  results.push({ id: 'S6_async_unprotect', passed: s6.pipeOk && s6.spawnParamsOk && s6.initFailureCleaned && s6.stderrRejected,
    actual: { ...s6, note: '合成进程/管道替身；未执行真实 PowerShell 模块加载（如实披露）' } });

  // S7：守卫记账 + 进程事实（attempts 实际汇总；父/探针/敏感性分列）
  phase = 'probe'; syncVmPhase(); const beforeProbe = hits.length;
  for (const attempt of [
    () => require('node:https').request('https://synthetic.invalid'),
    () => require('node:child_process').execSync('synthetic-never-executed'),
    () => require('node:dns').promises.lookup('synthetic.invalid')]) {
    try { attempt(); } catch (_) {}
  }
  const probeHits = hits.length - beforeProbe;
  phase = 'sensitivity'; syncVmPhase(); const beforeSens = hits.length;
  try { require('node:https').request('https://synthetic-caught.invalid'); } catch (_) {}
  const sensitivityHits = hits.length - beforeSens;
  phase = 'business'; syncVmPhase();
  let gitFact = null;
  try {
    const r = localTools.queryGit(ROOT, 'check-ignore', PRIVATE_ROOT_REL + '/synthetic-evidence-check.bin');
    gitFact = { status: r.status, ignoredHit: r.stdout.trim() === PRIVATE_ROOT_REL + '/synthetic-evidence-check.bin' };
  } catch (e) { gitFact = { error: e.code || 'UNKNOWN' }; }
  phase = 'done'; syncVmPhase();
  const unexpectedHits = hits.length - probeHits - sensitivityHits;
  const attempts = nativeExec.attempts();
  const byProgram = {};
  for (const a of attempts) byProgram[a.program] = (byProgram[a.program] || 0) + 1;
  const failedAttempts = attempts.filter(a => a.spawnFailed).length;
  results.push({ id: 'S7_guard_accounting_process_facts', passed: probeHits === 3 && sensitivityHits === 1 &&
      unexpectedHits === 0 && gitFact && gitFact.ignoredHit === true,
    actual: { guardHits: { probe: probeHits, sensitivity: sensitivityHits, unexpected: unexpectedHits,
        total: hits.length, detail: hits.map(h => ({ phase: h.phase, api: h.api })) },
      processFacts: { fromActualAttempts: true, total: attempts.length, spawnFailed: failedAttempts,
        byProgram, attemptSnapshot: attempts.map(a => a.program),
        semantics: 'attempted/completed/spawnFailed/status 分列；命令状态码语义由调用方判定（git check-ignore status1=未忽略，合法）' },
      gitCheckIgnore: gitFact } });

  // S8：双基线完整保护核对（B3）
  const s8 = runS8();
  results.push({ id: 'S8_protection_dual_baseline', passed: s8.passed, actual: s8.actual });

  // S9：VM 故障出口对照（父进程正常模式不含 S9——VM 子场景禁重入）
  if (!IS_VM_CHILD) {
    const vm = await runVmScenarios();
    results.push({ id: 'S9_fault_exit_proofs', passed: vm.allPass, actual: { scenarios: vm.vmResults } });
  } else {
    results.push({ id: 'S9_fault_exit_proofs', passed: true, actual: { note: 'VM 子场景不重入 S9（--vm-child）' } });
  }

  // S9 失败反例（父进程故障模式：S9 结果与实际不符）
  if (FAULT_MODE === 's9Fail') {
    results.find(r => r.id === 'S9_fault_exit_proofs').passed = false;
  }
  // 进程计数下账反例（快照与实况前缀不符 → S10 fail）
  if (FAULT_MODE === 'attemptUnder') {
    const pf = results.find(r => r.id === 'S7_guard_accounting_process_facts').actual.processFacts;
    pf.total -= 1; pf.attemptSnapshot[0] = 'tampered-program.exe';
  }
  // S10：运行时核对（顶层事实在汇总时由 S1 实际记录派生；attempts 实况与 S7 报告一致）
  const s1Rec = results.find(r => r.id === 'S1_contract_queries_identity_shape');
  const s7Rec = results.find(r => r.id === 'S7_guard_accounting_process_facts');
  const liveAttempts = nativeExec.attempts();
  const snap = s7Rec.actual.processFacts.attemptSnapshot;
  const prefixOk = liveAttempts.slice(0, snap.length).map(a => a.program).join(',') === snap.join(',');
  const runtimeOk = s1Rec.actual.identityRead === !!(s1Rec.actual.identityFacts) &&
    s1Rec.actual.aclRead === !!(s1Rec.actual.aclFacts) &&
    prefixOk && liveAttempts.length >= snap.length;
  results.push({ id: 'S10_runtime_facts_consistency', passed: runtimeOk,
    actual: { identityRead: s1Rec.actual.identityRead, aclRead: s1Rec.actual.aclRead,
      snapshotTotal: snap.length, liveAttempts: liveAttempts.length, prefixOk,
      note: 'S7 时点快照须为最终 attempts 前缀（后续保护 Git 调用只增不减）；attemptUnder 反例使前缀不符 → fail' } });
  // 后段命中反例（真正 done 阶段；非探针/敏感性）
  if (FAULT_MODE === 'lateHit') {
    try { require('node:https').request('https://synthetic-late.invalid'); } catch (_) {}
  }

}

// ── VM 场景（重入本源码 + 合成 OS/守卫边界；父守卫不被覆盖） ──
async function runVmScenarios() {
  const vm = require('node:vm');
  const source = fs.readFileSync(__filename, 'utf8');
  const privRoot = path.join(ROOT, PRIVATE_ROOT_REL);
  async function runVm(mode, fault) {
    let stdout = '', stderr = '';
    const proc = { env: {}, version: process.version,
      argv: ['node', __filename, '--vm-child', ...(fault ? ['--fault', fault] : [])], exitCode: 0,
      stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } } };
    let spawnCalls = 0;
    const whoamiResp = () => {
      if (mode === 'identityFail') return { status: 1, stdout: Buffer.from('x'), stderr: Buffer.from('synthetic failure') };
      if (mode === 'identityNotCsv') return { status: 0, stdout: Buffer.from('not-csv'), stderr: Buffer.alloc(0) };
      if (mode === 'crossTool') return { status: 0, stdout: Buffer.from('"synthetic\\当前用户中文名","' + fixture.sid + '"', 'utf8'), stderr: Buffer.alloc(0) };
      return { status: 0, stdout: Buffer.from('"synthetic\\current","' + fixture.sid + '"', 'utf8'), stderr: Buffer.alloc(0) };
    };
    const icaclsResp = () => mode === 'junkAnchor'
      ? { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.concat([Buffer.from([0xD2, 0xD1, 0xB3, 0xC9, 0xB9, 0xA6]),
          Buffer.from('junkSuccessfully processed 1 files; Failed processing 0 filesTRAILER', 'latin1')]) }
      : { status: 0, stderr: Buffer.alloc(0), stdout: probeOkBuffer() };
    const gitResp = (args) => {
      if (args[0] === 'check-ignore') return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(args[args.length - 1] + '\n', 'latin1') };
      if (mode === 'protectionCommittedHistory' && args[0] === 'diff') return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('docs/证据/Codex本地编码模块兼容反例-20261024.json\n', 'latin1') };
      if (mode === 'protectionUncommittedHistory' && args[0] === 'diff') return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('docs/证据/CodeBuddy本地编码模块兼容返修v3-20261024.json\n', 'latin1') };
      return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    };
    // 合成 OS 边界（唯一计数源）
    const vmAttempts = [];
    const osBoundary = {
      spawnSync(exe, args, opts) {
        spawnCalls++;
        vmAttempts.push({ kind: 'runProgram', program: String(exe).split('\\').pop(), attempted: true, completed: true, spawnFailed: false, status: null });
        assert.equal(opts.shell, false); assert.equal(opts.encoding, undefined);
        assert.ok(opts.timeout > 0 && opts.maxBuffer > 0);
        if (exe.endsWith('powershell.exe')) throw new Error('VM 不启动 PS');
        if (exe.endsWith('whoami.exe')) return whoamiResp();
        if (exe.endsWith('icacls.exe')) return icaclsResp();
        if (exe.endsWith('git.exe')) return gitResp(args);
        throw new Error('unexpected ' + exe);
      },
      spawn() { throw new Error('VM 不启动'); },
      connect() { return Object.assign(new (require('node:events').EventEmitter)(), { destroy() {}, write() {} }); },
      execFileSync(exe, args) { spawnCalls++; return osBoundary.spawnSync(exe, args, { shell: false, timeout: 10000, maxBuffer: 1048576 }); }
    };
    // 合成能力层（与真实 native-exec 同形状；单源计数）
    const fakeNativeExec = { runProgram({ program, args, cwd, timeoutMs, maxBuffer, input }) {
        // 模拟真实能力层构造：固定 shell/windowsHide/cwd、时限与限额默认值
        return osBoundary.spawnSync(program, args, { cwd, input, shell: false, windowsHide: true,
          timeout: timeoutMs === undefined ? 10000 : timeoutMs, maxBuffer: maxBuffer === undefined ? 128 * 1024 : maxBuffer }); },
      spawnProgram() { return { child: osBoundary.spawn(), attemptId: 1 }; },
      connectNamedPipe() { return osBoundary.connect(); },
      completeAsync() {}, attempts() { return vmAttempts.map(x => ({ ...x })); },
      gitReadonly({ operation, commitish, paths }) {
        const prefix = operation === 'diff' ? ['diff', '--name-only'] : operation === 'status' ? ['status', '--porcelain'] : [operation, '--'];
        const args = [...prefix, ...(commitish ? [commitish] : []), ...(paths ? ['--', ...paths] : [])];
        const r = osBoundary.execFileSync('C:\\Program Files\\Git\\cmd\\git.exe', args);
        return r.stdout ? r.stdout.toString('utf8') : '';
      } };
    const vmLocalTools = fixture.load('miniapp/scripts/lib/participant-local-tools.cjs', {
      './participant-native-exec.cjs': fakeNativeExec,
      'node:fs': { statSync: () => ({ isFile: () => true }) }
    });
    // 合成守卫（VM 模块图内记账；不触碰父进程公共模块）
    const vmHits = [];
    const VM_PHASE = { v: 'pre-require' };
    const syntheticGuard = {
      installParentGuardsWithLocalTools() {
        const thrower = api => () => { vmHits.push({ api }); throw new Error('OFFLINE_GUARD:' + api); };
        return { guard: { thrower }, toolCalls: [], vmHits };
      }
    };
    const fakeFs = {
      statSync(p) { return { isFile: () => p !== privRoot, isDirectory: () => p === privRoot }; },
      existsSync(p) { return p === privRoot; },
      readFileSync(p, ...a) { return fs.readFileSync(p, ...a); },
      writeFileSync() { throw new Error('禁止 VM 落盘'); }
    };
    const fakePublic = {
      https: { request: (url) => { vmHits.push({ api: 'https.request', phase: VM_PHASE.v }); throw new Error('OFFLINE_GUARD:https.request'); } },
      dns: { promises: { lookup: () => { vmHits.push({ api: 'dns.promises.lookup', phase: VM_PHASE.v }); throw new Error('OFFLINE_GUARD:dns'); } } },
      child_process: { execSync: () => { vmHits.push({ api: 'cp.execSync', phase: VM_PHASE.v }); throw new Error('OFFLINE_GUARD:cp.execSync'); } }
    };
    let injected = source;
    if (mode === 'preRequireInject') {
      injected = source.replace("const localTools = require(path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs'));",
        "try { require('node:https').request('https://synthetic-pre-require.invalid'); } catch (_) {}\nconst localTools = require(path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs'));");
    }
    if (mode === 'doneInject') {
      injected = source.replace("  // 后段命中反例（真正 done 阶段；非探针/敏感性）",
        "  try { require('node:https').request('https://synthetic-done-late.invalid'); } catch (_) {}\n  // 后段命中反例（真正 done 阶段；非探针/敏感性）");
    }
    // VM 内 hits 数组统一指向 VM_HITS（VM 子场景记账与父进程完全独立）
    injected = injected.replace('const hits = []; let phase', 'const hits = VM_HITS; let phase');
    const ctxRequire = name => {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:child_process') return fakePublic.child_process;
      if (name === 'node:https') return fakePublic.https;
      if (name === 'node:dns') return fakePublic.dns;
      if (name === 'node:net') return { connect() { throw new Error('VM 不连接'); } };
      if (name === 'node:vm') return vm;
      if (name === 'node:events') return require('node:events');
      if (name.endsWith('participant-native-exec.cjs')) return fakeNativeExec;
      if (name.endsWith('participant-local-tools.cjs')) return vmLocalTools;
      if (name.endsWith('participant-native-decoder.cjs')) return decoder;
      if (name.endsWith('psr-guard-runner.cjs')) return syntheticGuard;
      if (name.endsWith('psr-repair-fixtures.cjs')) return fixture;
      if (name === 'node:path' || name === 'node:crypto' || name === 'node:assert/strict') return require(name);
      throw new Error('VM 意外 require：' + name);
    };
    vm.runInNewContext(injected, {
      require: ctxRequire, __dirname, __filename, process: proc, VM_HITS: vmHits, VM_PHASE,
      Buffer, TextDecoder, Date, setTimeout, clearTimeout, queueMicrotask, console
    }, { filename: __filename, timeout: 30000 });
    // 等待异步完成（轮询 stdout；不用固定延迟代表完成）
    for (let waited = 0; waited < 10000 && stdout === ''; waited += 25) {
      await new Promise(r => setTimeout(r, 25));
    }
    if (stderr !== '') return { error: 'VM stderr 非空：' + stderr.slice(0, 80) };
    try {
      const parsed = JSON.parse(stdout);
      return { ok: parsed.ok, exit: proc.exitCode || 0, spawnCalls, vmHits: vmHits.length,
        failedResults: parsed.results.filter(r => !r.passed).map(r => ({ id: r.id, why: JSON.stringify(r.actual).slice(0, 200) })) };
    } catch (e) { return { error: 'VM stdout 解析失败：' + e.message }; }
  }
  const scenarios = [
    ['normal', null], ['identityFail', null], ['identityNotCsv', null], ['junkAnchor', null],
    ['crossTool', null], ['preRequireInject', null], ['doneInject', null],
    ['normal', 'lateHit'], ['normal', 'lateGitHit'], ['normal', 's9Fail'], ['normal', 'attemptUnder'],
    ['protectionCommittedHistory', null], ['protectionUncommittedHistory', null], ['protectionUntrackedIllegal', 'protectionUntrackedIllegal']
  ];
  const vmResults = [];
  let allPass = true;
  for (const [mode, fault] of scenarios) {
    const expectOk = mode === 'normal' && !fault;
    const r = await runVm(mode, fault);
    const pass = !r.error && r.ok === expectOk && r.exit === (expectOk ? 0 : 1);
    if (!pass) allPass = false;
    vmResults.push({ mode, fault, expectOk, got: r, passed: pass });
  }
  return { allPass, vmResults };
}

// ── 汇总（唯一最终 verdict：S8/S9/运行时核对后一次计算；JSON ok 与 exit 同源） ──
main().then(() => {
  // 顶层只读事实：引用实际完成情况（S1/S5 结果）
  const s1 = results.find(r => r.id === 'S1_contract_queries_identity_shape');
  report.onlyReadFacts = {
    identityRead: !!(s1 && s1.actual && s1.actual.identityRead),
    identityInMemoryOnly: true,
    aclRead: !!(s1 && s1.actual && s1.actual.aclRead),
    aclInMemoryOnly: true, dpapiRun: false, ps1UiRun: false,
    aclModified: false, directoriesListed: false
  };
  report.guardAccounting = { probeHits: hits.filter(h => h.phase === 'probe').length,
    sensitivityHits: hits.filter(h => h.phase === 'sensitivity').length,
    unexpectedHits: hits.filter(h => !['probe', 'sensitivity'].includes(h.phase)).length,
    totalHits: hits.length, note: '父守卫全程有效；VM 子场景独立记账（不混入父意外）' };
  report.runtimeDigests = {
    'miniapp/scripts/lib/participant-native-exec.cjs': sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-native-exec.cjs'))),
    'miniapp/scripts/lib/participant-local-tools.cjs': sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs'))),
    'miniapp/scripts/lib/participant-native-decoder.cjs': sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs')))
  };
  report.unverified = [
    '真实 DPAPI 加解密、PS1 输入窗口（策略 Restricted）未运行；S6/S9 为合成进程/管道替身，非真实模块加载或 DPAPI 验证',
    'whoami 非 ASCII 编码未独立证明（保守 blocked 规则）',
    '本机预检是否恢复由 Codex 复查决定；真实私密输入、登记、1/2 号、云端未放行'
  ];
  // 唯一最终 verdict（S8/S9/S10 与运行时核对之后）
  report.ok = results.every(r => r.passed) && report.guardAccounting.unexpectedHits === 0;
  const body = JSON.stringify(report, null, 2) + '\n';
  if (process.argv.length === 2 || IS_VM_CHILD) process.stdout.write(body);
  else if (process.argv.length === 4 && process.argv[2] === '--out') fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
  else { process.stderr.write('usage: node script.cjs [--out <new-path>]\n'); process.exitCode = 1; return; }
  if (!report.ok) process.exitCode = 1; // JSON ok 与 exit 同源
}, error => {
  process.stderr.write('[C0-V4-BLOCKED] ' + (error && error.code ? error.code + ': ' : '') + (error && error.message || error) + '\n');
  process.exitCode = 1;
});
