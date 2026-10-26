'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// 固定Node绑定返修 v2 证据（2026-10-26；R1–R3 定点返修，接手 master e918835，受审 1ca7c81）
// 依据：docs/Codex复查-固定Node绑定1ca7c81-20261026.md §2–§4。
// v1（CodeBuddy固定Node绑定返修-20261026.cjs/.json）原样保留，不修改。
//
// R2 要点（相对 v1）：
// - 完整守卫在业务装载前安装：公共网络/进程默认阻断（含被 catch 者记账）；仅私有
//   受控 runner 可执行固定程序+完整参数（git 基线 / powershell 语法解析 / node 自
//   重入 fault 模式）；先校验完整参数并计数，再执行（Git 计入实际总数，不能先执行
//   再分类，不只凭 exe 名称当探针）。
// - 探针、预期策略阻断、命令失败、业务意外分述；被 catch 的意外也必须使真实最终
//   ok=false/exit1（fault 模式实测四种注入点的最终出口）。
// - 全部核验、摘要和保护读取完成后才形成最终判定；判定后仅序列化输出。
// - 补初始化/业务/收尾三阶段的网络与公共进程敏感性探针及正常对照。
// 口径收尾：v1 实际携带 -ExecutionPolicy Default（非 Bypass 但非无覆盖参数验证），
// 如实记录；v2 固定 -File 命令不携带任何 -ExecutionPolicy 参数（本机已阻断环境不
// 重复尝试，也不改策略、不抽取正文到 -Command、不换宿主绕过）。策略、七个合成场
// 景、SelfTestTransport、UI、DPAPI 分述记录；v1 SelfTestCheck exit0 不证明其他项。
// 全程离线；不读真实编号/既有密文/凭据；不运行真实 UI/DPAPI/私密保存。
// ═══════════════════════════════════════════════════════════════════════════════

// ── 守卫安装（业务装载前；唯一逃逸口 REAL_SPAWN_SYNC 仅受控 runner 可用） ──
const guard = { phase: 'init', hits: [], currentProbe: null, installedAtMs: Date.now() };
const runner = { attempts: 0, completed: 0, failed: 0, calls: [] };
const cp = require('node:child_process');
const REAL_SPAWN_SYNC = cp.spawnSync.bind(cp);   // 先捕获，后包装
const FAULT_MODES = ['initNetwork', 'businessPublicProcess', 'cleanupNetwork', 'lateAfterVerdict'];
const IS_FAULT = (() => { const i = process.argv.indexOf('--fault'); return i >= 0 ? process.argv[i + 1] : null; })();
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '../..');
const PS1_REL = 'miniapp/scripts/participant-private-input.ps1';
const V1_CJS_REL = 'docs/证据/CodeBuddy固定Node绑定返修-20261026.cjs';
const V1_JSON_REL = 'docs/证据/CodeBuddy固定Node绑定返修-20261026.json';
const TEST_REL = 'miniapp/tests/participant-self-registration.test.cjs';
const sha = v => crypto.createHash('sha256').update(v).digest('hex');

function guardHit(kind) {
  // 无条件记账（含将被 catch 者）；class 由当前探针注册决定
  const cls = guard.currentProbe === kind ? 'probe' : 'unexpected';
  guard.hits.push({ phase: guard.phase, kind, class: cls });
  throw new Error(kind === 'network' ? 'PSR_GUARD_BLOCKED_NETWORK' : 'PSR_GUARD_BLOCKED_PUBLIC_PROCESS');
}
// 公共进程接口全部阻断
for (const k of Object.keys(cp)) {
  if (typeof cp[k] === 'function') {
    cp[k] = function (...a) { guardHit('publicProcess'); };
  }
}
// 公共网络接口全部阻断
function blockNet(mod, names) {
  for (const n of names) {
    if (mod && typeof mod[n] === 'function') {
      mod[n] = function (...a) { guardHit('network'); };
    }
  }
}
blockNet(require('node:http'), ['request', 'get']);
blockNet(require('node:https'), ['request', 'get']);
blockNet(require('node:net'), ['connect', 'createConnection', 'createServer']);
blockNet(require('node:tls'), ['connect', 'createServer']);
blockNet(require('node:dgram'), ['createSocket']);
blockNet(require('node:dns'), ['lookup', 'resolve', 'resolve4', 'resolve6']);

// 受控 runner：固定程序 + 完整参数校验（先校验计数，后执行）
const PARSE_CMD = '$errs=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile("C:/Users/30591/Documents/ChatGPT/装修进度验收APP/miniapp/scripts/participant-private-input.ps1",[ref]$null,[ref]$errs); if($errs.Count -eq 0){"parse-ok"}else{$errs|ForEach-Object{$_.Extent.StartLineNumber.ToString()+": "+$_.Message}}';
function validateAndClassify(program, args) {
  const a = args.map(String);
  if (program === 'git' && a.length === 3 && a[0] === 'rev-parse' && a[1] === '--short=7' && a[2] === 'HEAD') {
    return { purpose: 'baseline-readonly', expectedStatus: 0 };
  }
  if (program === 'powershell.exe' && a.length === 3 && a[0] === '-NoProfile' && a[1] === '-Command' && a[2] === PARSE_CMD) {
    return { purpose: 'ps1-syntax-parse', expectedStatus: 0 };
  }
  if (program === process.execPath && !IS_FAULT && a.length === 3 && a[0] === __filename && a[1] === '--fault' && FAULT_MODES.includes(a[2])) {
    return { purpose: 'self-fault-rerun:' + a[2], expectedStatus: 1 }; // fault 子进程最终出口即证明：预期 exit1
  }
  return null;
}
function controlledRun(program, args, opts) {
  const hit = validateAndClassify(program, args);
  if (!hit) {
    guard.hits.push({ phase: guard.phase, kind: 'publicProcess', class: 'unexpected' });
    throw new Error('PSR_GUARD_BLOCKED_PUBLIC_PROCESS');
  }
  runner.attempts++;                       // 先计数后执行（不能先执行再分类）
  runner.calls.push({ purpose: hit.purpose, program: String(program), argsCount: args.length });
  let r;
  try {
    r = REAL_SPAWN_SYNC(program, args, { shell: false, ...opts });
  } catch (e) {
    runner.failed++;
    throw e;
  }
  if (r && typeof r.status === 'number' && r.status === hit.expectedStatus) runner.completed++;
  else runner.failed++;
  return r;
}
// 敏感性探针（预期被阻断；注册为 probe）
function expectGuardBlock(kind, label) {
  const before = guard.hits.length;
  guard.currentProbe = kind;
  let blocked = false;
  try {
    if (kind === 'network') require('node:https').request('https://synthetic.invalid/guard-probe');
    else cp.execSync('synthetic-unapproved-command');
  } catch (e) {
    blocked = String(e && e.message).startsWith('PSR_GUARD_BLOCKED');
  } finally {
    guard.currentProbe = null;
  }
  const hit = guard.hits[guard.hits.length - 1];
  return {
    label, kind, phase: guard.phase,
    passed: blocked && guard.hits.length === before + 1 && hit && hit.class === 'probe' && hit.kind === kind && hit.phase === guard.phase
  };
}
// 业务意外注入（被 catch；守卫已记账为 unexpected）
function caughtUnexpected(kind) {
  const before = guard.hits.length;
  try {
    if (kind === 'network') require('node:https').request('https://synthetic.invalid/unexpected');
    else cp.execSync('synthetic-unapproved-command');
  } catch (e) { /* 被 catch：守卫记账不受影响 */ }
  return guard.hits.slice(before).filter(h => h.class === 'unexpected').length;
}

// ── init 阶段：守卫安装后立即敏感性探针 ──
if (IS_FAULT === 'initNetwork') caughtUnexpected('network');
const initProbes = [expectGuardBlock('network', 'init-network'), expectGuardBlock('publicProcess', 'init-public-process')];

// ── business 阶段：装载与全部核验 ──
guard.phase = 'business';
// 业务装载晚于守卫（受审解码器只读使用）
const { decodeNative } = require(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'));
if (IS_FAULT === 'businessPublicProcess') caughtUnexpected('publicProcess');

const ps1Buf = fs.readFileSync(path.join(ROOT, PS1_REL));
const ps1 = ps1Buf.toString('utf8');
const ps1Code = ps1.split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n');
const selfSrc = fs.readFileSync(__filename, 'utf8');
// 受审常量（来自任务给定/已审锚点；预期摘要不从文件现算当作预期）
const FIXED_NODE_PATH = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const FIXED_NODE_SHA = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19';

const staticChecks = [];
function check(name, passed, detail) { staticChecks.push({ name, passed, detail: detail || '' }); }
// (1) 受审常量与唯一性
check('fixed-path-constant', ps1.includes("'" + FIXED_NODE_PATH + "'"));
check('fixed-digest-constant-full-64', ps1.includes("'" + FIXED_NODE_SHA + "'"));
check('fixed-path-defined-once', ps1.split(FIXED_NODE_PATH).length === 2);
check('fixed-digest-defined-once', ps1.split(FIXED_NODE_SHA).length === 2);
// (2) 无 PATH 搜索/回退/下载/调用方摘要
check('no-get-command', !ps1Code.includes('Get-Command'));
check('no-nodesha-param', !/\bNodeSha\b/.test(ps1));
check('no-download', !/Download|Invoke-WebRequest|Start-BitsTransfer/i.test(ps1Code));
check('filename-not-bare-node', !/\$psi\.FileName\s*=\s*'node'/.test(ps1));
check('filename-not-declared-param', !/FileName\s*=\s*\$SelfTestNodePath/.test(ps1));
check('filename-from-fixed-after-hold-digest', /\$psi\.FileName\s*=\s*\$FixedNodePath/.test(ps1));
check('filename-not-from-precheck-binding', !/FileName\s*=\s*\$binding\.NodePath/.test(ps1));
// (3) 共用启动链：两分支同一入口，仅固定用途调用
check('purpose-whitelist', ps1.includes("'save-protect'") && ps1.includes("'selftest-echo'"));
check('save-uses-shared-chain', /Invoke-SaveProtect[\s\S]*?Start-FixedNode 'save-protect'/.test(ps1));
check('echo-uses-shared-chain', /Invoke-SelfTestEcho[\s\S]*?Start-FixedNode 'selftest-echo'/.test(ps1));
check('fixed-callsites-only', (ps1.match(/Start-FixedNode '/g) || []).length === 3);
// (4) 启动开关与子进程 NODE_OPTIONS
check('useshellexecute-false', ps1.includes('$psi.UseShellExecute = $false'));
check('createnowindow-true', ps1.includes('$psi.CreateNoWindow = $true'));
const noNodes = ps1Code
  .replace(/\$psi\.EnvironmentVariables\.Remove\('NODE_OPTIONS'\)/g, '')
  .replace(/\$psi\.EnvironmentVariables\['NODE_OPTIONS'\]/g, '');
check('node-options-single-removal', ps1Code.includes("$psi.EnvironmentVariables.Remove('NODE_OPTIONS')") && !noNodes.includes('NODE_OPTIONS'));
// (5) R1：UI 前检查（独立标记）；Start-FixedNode 持有→摘要→启动→释放
const uiPre = ps1.indexOf('$uiPreBinding = Test-FixedNodeBinding');
const trPre = ps1.indexOf('$preBinding = Test-FixedNodeBinding');
const addType = ps1.indexOf('Add-Type -AssemblyName System.Windows.Forms');
check('ui-precheck-distinct-marker', uiPre !== -1 && addType !== -1 && uiPre < addType);
check('transport-precheck-present', trPre !== -1 && trPre < uiPre);
const sfnStart = ps1.indexOf('function Start-FixedNode(');
const sfnEnd = ps1.indexOf('function Invoke-SaveProtect(');
const sfn = sfnStart >= 0 && sfnEnd > sfnStart ? ps1.slice(sfnStart, sfnEnd) : '';
check('hold-opened-once-in-start', (sfn.match(/BoundaryOpenHold/g) || []).length === 1);
check('no-standalone-digest-in-start', !/BoundaryProbeNodeDigest(?!FromHold)/.test(sfn));
check('no-precheck-inside-start', !sfn.includes('Test-FixedNodeBinding'));
check('r1-order-hold-digest-start', sfn.indexOf('BoundaryOpenHold') > -1 && sfn.indexOf('BoundaryOpenHold') < sfn.indexOf('BoundaryProbeNodeDigestFromHold') && sfn.indexOf('BoundaryProbeNodeDigestFromHold') < sfn.indexOf('BoundaryStart'));
check('digest-computed-on-held-stream', /function Probe-FixedNodeDigestFromHold[\s\S]*?ComputeHash\(\$holdStream\)/.test(ps1));
const pdhBody = ps1.slice(ps1.indexOf('function Probe-FixedNodeDigestFromHold'), ps1.indexOf('function Open-FixedNodeHold'));
check('held-digest-no-reopen', !pdhBody.includes('[System.IO.File]::Open'));
check('hold-dispose-in-finally', /finally[\s\S]{0,120}?\$handle\.Dispose\(\)/.test(sfn));
// (6) 摘要：.NET SHA-256 直接使用；完整比较
check('dotnet-sha256-direct', ps1.includes('[System.Security.Cryptography.SHA256]::Create()') && !ps1Code.includes('Get-FileHash'));
check('digest-full-compare', ps1.includes('Equals($digest, $FixedNodeSha256'));
// (7) 失败净化标签与既有契约
for (const label of ['NODE_DECLARATION_INVALID', 'NODE_FILE_INVALID', 'NODE_FILE_READ_FAIL', 'NODE_DIGEST_MISMATCH', 'NODE_START_FAIL']) {
  check('label-' + label.toLowerCase(), ps1.includes("'" + label + "'"));
}
check('save-failed-contract', ps1.includes("Write-Output 'SAVE_FAILED'") && /SAVE_FAILED'\s*\r?\n\s*exit 6/.test(ps1));
check('cancel-contract', ps1.includes("Write-Output 'CANCELLED'") && /CANCELLED'\s*\r?\n\s*exit 5/.test(ps1));
// (8) 完整编号只走 stdin
check('plain-stdin-only', /function Invoke-SaveProtect[\s\S]*?StandardInput\.Write[\s\S]*?StandardInput\.Close/.test(ps1));
check('args-without-plain-value', !/Get-StoreArguments[\s\S]{0,600}?\$value/.test(ps1));
// (9) 合成自测入口固定场景；声明参数校验
check('selftest-scenario-whitelist', /\$fixedScenarios = @\('N1_SAVE', 'N1_ECHO', 'N2_DECL', 'N3_FILE', 'N4_DRIFT', 'N5_STARTFAIL', 'N6_TRANSPORT'\)/.test(ps1) && ps1.includes('-notcontains $SelfTestScenario'));
check('decl-absolute-required', ps1.includes('[System.IO.Path]::IsPathRooted'));
check('decl-control-chars-rejected', ps1.includes('[\\x00-\\x1f\\x7f]'));
check('mode-misuse-rejected', /Test-SelfTestNodePathModeUse[\s\S]{0,200}?exit 20/.test(ps1));
// (10) R3：N6 两分支精确核对；旧错误断言移除
check('n6-save-exact-compare', ps1.includes('$psi.Arguments -ceq $expectedSaveArgs'));
check('n6-echo-exact-compare', ps1.includes('$psi2.Arguments -ceq $expectedEchoArgs'));
check('n6-echo-20-params', ps1.includes('$expectedEchoArgv.Count -eq 20'));
check('n6-old-wrong-assert-gone', !ps1.includes("Add-Check 'fixture-space-path-quoted' ($psi.Arguments"));
// (11) 字节形态：BOM + 纯 CRLF
check('ps1-bom-preserved', ps1Buf[0] === 0xEF && ps1Buf[1] === 0xBB && ps1Buf[2] === 0xBF);
let loneLf = 0;
for (let i = 0; i < ps1Buf.length; i++) if (ps1Buf[i] === 10 && (i === 0 || ps1Buf[i - 1] !== 13)) loneLf++;
check('ps1-pure-crlf', loneLf === 0);
// (12) 固定 Node 本机现值交叉记录（信息性；预期仍以受审常量为准）
let observedNodeDigest = null;
try { observedNodeDigest = sha(fs.readFileSync(FIXED_NODE_PATH)); } catch (e) { observedNodeDigest = null; }
check('observed-node-matches-constant', observedNodeDigest !== null && observedNodeDigest.toLowerCase() === FIXED_NODE_SHA, observedNodeDigest || 'unreadable');
// (13) v2 自身不携带 -ExecutionPolicy（口径收尾；仅注释可提及）；v1 携带事实记录（原样保留不改）
const selfCode = selfSrc.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
const EP_FLAG = '-' + 'ExecutionPolicy'; // 拼接构造，避免字面量被本检查误伤
check('v2-no-executionpolicy-flag', !selfCode.includes(EP_FLAG));
const v1CjsBuf = fs.readFileSync(path.join(ROOT, V1_CJS_REL));
const v1JsonBuf = fs.readFileSync(path.join(ROOT, V1_JSON_REL));
const v1Cjs = v1CjsBuf.toString('utf8');
let v1Dynamic = null;
try { v1Dynamic = JSON.parse(v1JsonBuf.toString('utf8')).dynamicAttempt; } catch (e) { v1Dynamic = null; }
check('v1-carried-fact-executionpolicy', v1Cjs.includes(EP_FLAG), 'v1 原样保留；其' + EP_FLAG + ' Default 为已披露事实');
check('v1-policy-block-record-intact', !!v1Dynamic && v1Dynamic.blockedLabel === 'blocked' && v1Dynamic.status === 1);

const staticAllPass = staticChecks.every(c => c.passed);

// ── 运行时核验（runner：Git 计入实际总数；解析探针完整参数固定） ──
const baselineRun = controlledRun('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
const baseline = (baselineRun.stdout || '').trim();
const parseRun = controlledRun('powershell.exe', ['-NoProfile', '-Command', PARSE_CMD], { cwd: ROOT, timeout: 30000 });
const parseText = decodeNative(parseRun.stdout || Buffer.alloc(0)) + decodeNative(parseRun.stderr || Buffer.alloc(0));
const parseCheck = { probed: true, status: parseRun.status, passed: parseRun.status === 0 && parseText.includes('parse-ok'), output: parseText.trim().slice(0, 300) };

// fault 重入（仅主流程；子进程自行退出码即最终出口证明）
const faultProofs = [];
if (!IS_FAULT) {
  for (const mode of FAULT_MODES) {
    const r = controlledRun(process.execPath, [__filename, '--fault', mode], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout || ''); } catch (e) { parsed = null; }
    const expectVerdictOk = mode === 'lateAfterVerdict'; // 判定后注入：冻结判定仍 ok=true，真实出口仍须 1
    faultProofs.push({
      mode,
      exitStatus: r.status,
      parsedVerdictOk: parsed ? parsed.verdict.ok : null,
      parsedFinalOk: parsed ? parsed.finalOk : null,
      unexpectedRecorded: parsed ? parsed.postVerdictUnexpected : null,
      passed: r.status === 1 && parsed && parsed.finalOk === false && parsed.postVerdictUnexpected >= 1 && parsed.verdict.ok === expectVerdictOk
    });
  }
}
// business 阶段敏感性探针
const businessProbes = [expectGuardBlock('network', 'business-network'), expectGuardBlock('publicProcess', 'business-public-process')];

// ── cleanup 阶段敏感性 ──
guard.phase = 'cleanup';
if (IS_FAULT === 'cleanupNetwork') caughtUnexpected('network');
const cleanupProbes = [expectGuardBlock('network', 'cleanup-network'), expectGuardBlock('publicProcess', 'cleanup-public-process')];

// ── 最终判定：全部核验、摘要和保护读取完成之后（判定后仅序列化输出） ──
const allProbes = [...initProbes, ...businessProbes, ...cleanupProbes];
const unexpectedHits = guard.hits.filter(h => h.class === 'unexpected');
const expectedAttempts = IS_FAULT ? 2 : 6; // 子进程：git+parse；主流程：+4 fault 重入
const guardClean = unexpectedHits.length === 0
  && allProbes.every(p => p.passed)
  && runner.attempts === expectedAttempts
  && runner.failed === 0
  && runner.completed === expectedAttempts;
const verdict = {
  // 基线为记录事实（不作为判定门槛：提交后 HEAD 前进属正常演进；内容锚定由
  // 静态检查+文件摘要承担）。判定只由内容核验、守卫口径与 fault 出口证明决定。
  ok: staticAllPass && parseCheck.passed && guardClean && faultProofs.every(f => f.passed),
  failedReasons: [
    ...(staticAllPass ? [] : staticChecks.filter(c => !c.passed).map(c => 'static:' + c.name)),
    ...(parseCheck.passed ? [] : ['parse:ps1-syntax']),
    ...(guardClean ? [] : ['guard:' + (unexpectedHits.length ? 'unexpected-hits' : 'probe-or-accounting-mismatch')]),
    ...(faultProofs.every(f => f.passed) ? [] : ['fault-proof:' + faultProofs.filter(f => !f.passed).map(f => f.mode).join(',')])
  ],
  atHandoverBaseline: baseline === 'e918835',
  baselineNote: baseline === 'e918835' ? 'HEAD 为接手基线 e918835' : 'HEAD 已自接手基线 e918835 前进（记录事实；内容锚定见静态检查与文件摘要）',
  guardAccounting: {
    attempts: runner.attempts, completed: runner.completed, failed: runner.failed,
    expectedAttempts, calls: runner.calls,
    probeHits: guard.hits.filter(h => h.class === 'probe'),
    unexpectedHits,
    probeChecks: allProbes,
    note: '公共网络/进程默认阻断且业务装载前安装；被 catch 者同样记账；Git 经受控 runner 计入实际总数（先校验完整参数并计数后执行）'
  },
  categories: {
    probe: '敏感性探针 6 项（init/business/cleanup × 网络/公共进程）全部被阻断',
    expectedPolicyBlock: '沿用 v1 记录（fixed -File 被 Restricted 拒绝，exit1/UnauthorizedAccess）；本轮不在已阻断环境重复尝试，且新版固定 -File 命令不携带任何 ' + EP_FLAG + ' 参数',
    commandFailure: parseCheck.passed ? '无（解析探针通过）' : '解析探针失败',
    businessUnexpected: unexpectedHits.length === 0 ? '无（主流程）' : '存在（见 unexpectedHits）；fault 子进程证明被 catch 的意外使最终 ok=false/exit1'
  }
};
// 判定冻结；此后仅记录判定后事实并序列化输出
if (IS_FAULT === 'lateAfterVerdict') caughtUnexpected('network');
const postVerdictUnexpected = guard.hits.filter(h => h.class === 'unexpected').length;
const finalOk = verdict.ok && postVerdictUnexpected === 0;

const report = {
  schema: 'wb-psr-fixed-node-binding-v2/1',
  date: '2026-10-26',
  mode: IS_FAULT || 'main',
  baseline,
  reviewedBasis: 'docs/Codex复查-固定Node绑定1ca7c81-20261026.md §2–§4',
  guardInstalledBeforeBusinessLoad: true,
  verdict,
  postVerdictUnexpected,
  finalOk,
  digests: {
    ps1AfterR1R3: sha(ps1Buf),
    ps1At1ca7c81: '3012b4164f8267c3c09061be801690ca703137b3ff69688c2eed02155c895f06',
    registrationTest: sha(fs.readFileSync(path.join(ROOT, TEST_REL))),
    v1CjsPreserved: sha(v1CjsBuf),
    v1JsonPreserved: sha(v1JsonBuf),
    evidenceScriptSelf: sha(fs.readFileSync(__filename)),
    fixedNodeConstant: FIXED_NODE_SHA,
    fixedNodeObserved: observedNodeDigest
  },
  staticChecks: { total: staticChecks.length, failed: staticChecks.filter(c => !c.passed).length, items: staticChecks },
  parseCheck,
  faultProofs,
  dynamicGaps: {
    executionPolicy: '有效 Restricted（2026-10-26 会话实测全 scope Undefined；v1 记录 -File 被拒）。本轮不重复尝试、不改策略、不抽取正文到 -Command、不换宿主绕过',
    fixedFileDynamicAttempt: '本轮未执行；新版固定 -File 命令不携带任何 ' + EP_FLAG + ' 参数',
    selfTestSyntheticSevenScenarios: '未动态执行（blocked）；PS1 内置七场景待允许环境验证',
    selfTestTransportReal: '未动态执行（blocked）',
    uiAndDpapi: '真实输入窗口与 DPAPI 未运行',
    selfTestCheckNote: 'v1 SelfTestCheck exit0 不证明策略/场景/传输/UI/DPAPI 任一项通过'
  },
  limitations: [
    '动态 PowerShell 语义全部未验证（静态检查不冒充动态通过）',
    '不读真实编号/既有密文/凭据；不运行真实 UI/DPAPI/私密保存；不查询身份/ACL',
    '未改 PATH/权限/策略/系统环境；未联网；1/2号不重试，P 不开展，A 预检不恢复'
  ]
};

const outIdx = process.argv.indexOf('--out');
let payload = JSON.stringify(report, null, 2);
if (outIdx >= 0) {
  const outPath = process.argv[outIdx + 1];
  const fd = fs.openSync(outPath, 'wx'); // wx 独占创建
  fs.writeFileSync(fd, payload);
  fs.closeSync(fd);
  payload = JSON.stringify({ written: outPath });
}
console.log(payload);
process.exit(finalOk ? 0 : 1);
