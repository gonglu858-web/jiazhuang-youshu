'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// 固定Node绑定返修证据（2026-10-26；接手 master 953f20e）
// 依据：docs/Codex方案-私密输入入口固定Node返修-20261025.md §2/§4。
//
// 范围与如实声明：
// - 本证据只覆盖「固定Node绑定返修」本轮静态可验证内容 + 一次动态尝试记录。
// - 本机有效执行策略为 Restricted：实际 PS1 语义（-File 动态运行）被策略拒绝，
//   如实记录 blocked；不改策略、不加 Bypass、不抽取正文到 -Command、不换宿主绕过。
//   静态通过与动态未验证分开报告；本证据不写"全部验收通过"。
// - 静态检查为源码绑定核对（标明 static），不冒充动态执行结果。
// - 全程离线；不读真实编号/既有密文/凭据；不运行真实输入窗口/DPAPI/私密保存；
//   不查询身份/ACL；不改 PATH/权限/策略/系统环境。
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
// 原生命令管道输出解码用受审解码器（GB18030 契约；只读使用，不修改）
const { decodeNative } = require(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'));
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const PS1_REL = 'miniapp/scripts/participant-private-input.ps1';
const TEST_REL = 'miniapp/tests/participant-self-registration.test.cjs';
// 受审常量（来自任务给定/已审锚点；预期摘要不得从文件现算后当作预期）
const FIXED_NODE_PATH = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const FIXED_NODE_SHA = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19';

// ── 进程边界记账：本轮证据自身只允许两类显式探针 spawn（解析检查 + 一次 -File 尝试） ──
const procAccounting = { attempts: 0, completed: 0, failed: 0, probed: 0, unexpected: [], events: [] };
const PROBE_LABELS = new Set();
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function (exe, args, opts) {
  procAccounting.attempts++;
  procAccounting.events.push({ kind: 'spawnSync', exe: String(exe), args: (args || []).length });
  let r;
  try { r = origSpawnSync.call(cp, exe, args, opts); } catch (e) { procAccounting.failed++; throw e; }
  if (r && typeof r.status === 'number') procAccounting.completed++; else procAccounting.failed++;
  if (PROBE_LABELS.has(String(exe).toLowerCase())) procAccounting.probed++;
  else procAccounting.unexpected.push(String(exe));
  return r;
};

// ── 基线与运行时摘要 ──
const baseline = origSpawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const ps1Buf = fs.readFileSync(path.join(ROOT, PS1_REL));
const ps1 = ps1Buf.toString('utf8');
const ps1Code = ps1.split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n');
const testSha = sha(fs.readFileSync(path.join(ROOT, TEST_REL)));
const selfSha = sha(fs.readFileSync(__filename));

// ── 静态绑定检查（static） ──
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
check('filename-from-validated-binding', /\$psi\.FileName\s*=\s*\$binding\.NodePath/.test(ps1));
// (3) 共用启动链：两分支同一入口，仅两个固定用途
check('purpose-whitelist', ps1.includes("'save-protect'") && ps1.includes("'selftest-echo'"));
check('save-uses-shared-chain', /Invoke-SaveProtect[\s\S]*?Start-FixedNode 'save-protect'/.test(ps1));
check('echo-uses-shared-chain', /Invoke-SelfTestEcho[\s\S]*?Start-FixedNode 'selftest-echo'/.test(ps1));
check('no-arbitrary-launch-exit', (ps1.match(/Start-FixedNode '/g) || []).length === 2);
// (4) 启动开关与子进程 NODE_OPTIONS
check('useshellexecute-false', ps1.includes('$psi.UseShellExecute = $false'));
check('createnowindow-true', ps1.includes('$psi.CreateNoWindow = $true'));
const noNodes = ps1Code
  .replace(/\$psi\.EnvironmentVariables\.Remove\('NODE_OPTIONS'\)/g, '')
  .replace(/\$psi\.EnvironmentVariables\['NODE_OPTIONS'\]/g, '');
check('node-options-single-removal', ps1Code.includes("$psi.EnvironmentVariables.Remove('NODE_OPTIONS')") && !noNodes.includes('NODE_OPTIONS'));
// (5) 校验时点：UI 前一次；启动前再次；句柄只读拒绝写/删除共享，finally 释放
const preCheck = ps1.indexOf('$preBinding = Test-FixedNodeBinding');
const addType = ps1.indexOf('Add-Type -AssemblyName System.Windows.Forms');
check('pre-window-check-before-ui', preCheck !== -1 && addType !== -1 && preCheck < addType);
check('recheck-before-start', /function Start-FixedNode[\s\S]*?Test-FixedNodeBinding[\s\S]*?BoundaryOpenHold[\s\S]*?BoundaryStart/.test(ps1));
check('fileshare-read-deny-write-delete', ps1.includes('[System.IO.FileShare]::Read'));
check('hold-dispose-in-finally', /finally[\s\S]{0,120}?\$handle\.Dispose\(\)/.test(ps1));
// (6) 摘要：.NET SHA-256 直接使用；完整比较
check('dotnet-sha256-direct', ps1.includes('[System.Security.Cryptography.SHA256]::Create()') && !ps1Code.includes('Get-FileHash'));
check('digest-full-compare', /\$LabelDigestMismatch \}/.test(ps1) && ps1.includes("Equals($digest, $FixedNodeSha256"));
// (7) 失败净化标签与既有契约
for (const label of ['NODE_DECLARATION_INVALID', 'NODE_FILE_INVALID', 'NODE_FILE_READ_FAIL', 'NODE_DIGEST_MISMATCH', 'NODE_START_FAIL']) {
  check('label-' + label.toLowerCase(), ps1.includes("'" + label + "'"));
}
check('save-failed-contract', ps1.includes("Write-Output 'SAVE_FAILED'") && /SAVE_FAILED'\s*\r?\n\s*exit 6/.test(ps1));
check('cancel-contract', ps1.includes("Write-Output 'CANCELLED'") && /CANCELLED'\s*\r?\n\s*exit 5/.test(ps1));
// (8) 完整编号只走 stdin；参数构造不含输入值
check('plain-stdin-only', /function Invoke-SaveProtect[\s\S]*?StandardInput\.Write[\s\S]*?StandardInput\.Close/.test(ps1));
check('args-without-plain-value', !/Get-StoreArguments[\s\S]{0,600}?\$value/.test(ps1));
// (9) 合成自测入口固定场景；声明参数校验
check('selftest-scenario-whitelist', /\$fixedScenarios = @\('N1_SAVE', 'N1_ECHO', 'N2_DECL', 'N3_FILE', 'N4_DRIFT', 'N5_STARTFAIL', 'N6_TRANSPORT'\)/.test(ps1) && ps1.includes('-notcontains $SelfTestScenario'));
check('decl-absolute-required', ps1.includes('[System.IO.Path]::IsPathRooted'));
check('decl-control-chars-rejected', ps1.includes('[\\x00-\\x1f\\x7f]'));
check('mode-misuse-rejected', /Test-SelfTestNodePathModeUse[\s\S]{0,200}?exit 20/.test(ps1));
// (10) 字节形态：BOM + 纯 CRLF
check('ps1-bom-preserved', ps1Buf[0] === 0xEF && ps1Buf[1] === 0xBB && ps1Buf[2] === 0xBF);
let loneLf = 0;
for (let i = 0; i < ps1Buf.length; i++) if (ps1Buf[i] === 10 && (i === 0 || ps1Buf[i - 1] !== 13)) loneLf++;
check('ps1-pure-crlf', loneLf === 0);
// (11) 固定 Node 本机现值交叉记录（信息性：预期仍以受审常量为准，不以现算值为预期）
let observedNodeDigest = null;
try { observedNodeDigest = sha(fs.readFileSync(FIXED_NODE_PATH)); } catch (e) { observedNodeDigest = null; }
check('observed-node-matches-constant', observedNodeDigest !== null && observedNodeDigest.toLowerCase() === FIXED_NODE_SHA,
  observedNodeDigest || 'unreadable');

const staticAllPass = staticChecks.every(c => c.passed);

// ── 探针1：PS1 语法解析（-Command 内联解析器调用；不执行脚本、不抽取正文） ──
PROBE_LABELS.add('powershell.exe');
let parseCheck = null;
{
  const r = cp.spawnSync('powershell.exe',
    ['-NoProfile', '-Command', '$errs=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile("C:/Users/30591/Documents/ChatGPT/装修进度验收APP/miniapp/scripts/participant-private-input.ps1",[ref]$null,[ref]$errs); if($errs.Count -eq 0){"parse-ok"}else{$errs|ForEach-Object{$_.Extent.StartLineNumber.ToString()+": "+$_.Message}}'],
    { cwd: ROOT, timeout: 30000 });
  const text = (decodeNative(r.stdout || Buffer.alloc(0)) + decodeNative(r.stderr || Buffer.alloc(0))).trim();
  parseCheck = { kind: 'syntax-parse', probed: true, status: r.status, output: text.slice(0, 400), passed: text.includes('parse-ok') };
}

// ── 探针2：一次固定 -File 动态尝试（预期策略阻断；不重试、不绕过） ──
let dynamicAttempt = null;
{
  const synth = 'u_0123456789abcdef0123456789abcdef01234567';
  const r = cp.spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Default', '-File', path.join(ROOT, PS1_REL),
     '-SelfTestCheck', '-SelfTestValue1', synth, '-SelfTestValue2', synth],
    { cwd: ROOT, timeout: 30000 });
  const errText = decodeNative(r.stderr || Buffer.alloc(0));
  const outText = decodeNative(r.stdout || Buffer.alloc(0));
  const policyBlocked = r.status !== 0 && (errText.includes('禁止运行脚本') || errText.includes('UnauthorizedAccess') || errText.includes('running scripts is disabled'));
  dynamicAttempt = {
    kind: 'fixed -File dynamic attempt',
    probed: true,
    attempts: 1,
    status: r.status,
    policyBlocked,
    blockedLabel: policyBlocked ? 'blocked' : (r.status === 0 ? 'ran' : 'other-error'),
    outputHead: (errText || outText).replace(/\s+/g, ' ').slice(0, 240),
    passed: policyBlocked || r.status === 0, // blocked 属如实记录，不算产品失败
    note: '有效执行策略 Restricted（本会话 Get-ExecutionPolicy 实测）；动态 PS 语义未验证，单列缺口'
  };
}

// ── 汇总：实际计数决定 ok/exit；静态通过与动态未验证分开 ──
const allChecksPass = staticAllPass && parseCheck.passed && dynamicAttempt.passed;
const guardClean = procAccounting.unexpected.length === 0 && procAccounting.failed === 0
  && procAccounting.attempts === 2 && procAccounting.probed === 2;
const ok = allChecksPass && guardClean;

const report = {
  schema: 'wb-psr-fixed-node-binding-v1/1',
  date: '2026-10-26',
  baseline,
  reviewedBasis: 'docs/Codex方案-私密输入入口固定Node返修-20261025.md §2/§4',
  ok,
  acceptanceLevel: 'static-only',
  dynamicPowerShellSemantics: dynamicAttempt.blockedLabel === 'blocked' ? 'blocked' : 'recorded',
  fullAcceptanceClaimed: false,
  statusNote: '本地实现完成待 Codex 复查；动态缺口单列（执行策略 Restricted，-File 被拒）；真实私密输入及执行未放行',
  digests: {
    ps1AfterRepair: sha(ps1Buf),
    ps1BeforeRepairHead: 'ea3b35b5f50857c90959520a21a0cbf4fde43a753107d6ae7d8afb92dba4a357',
    registrationTest: testSha,
    evidenceScriptSelf: selfSha,
    fixedNodeConstant: FIXED_NODE_SHA,
    fixedNodeObserved: observedNodeDigest
  },
  staticChecks: { total: staticChecks.length, failed: staticChecks.filter(c => !c.passed).length, items: staticChecks },
  parseCheck,
  dynamicAttempt,
  guardAccounting: {
    attempts: procAccounting.attempts,
    completed: procAccounting.completed,
    failed: procAccounting.failed,
    probed: procAccounting.probed,
    unexpected: procAccounting.unexpected,
    events: procAccounting.events,
    note: '全部 spawn 显式登记为探针（解析检查 + 一次 -File 尝试）；意外命中含被 catch 者；实际计数决定 ok/exit'
  },
  limitations: [
    '动态 PowerShell 语义（SelfTestTransport 真实运行、SelfTestSynthetic 七场景、UI 前与启动前真实文件/摘要校验链）因执行策略 Restricted 未运行；PS1 已内置固定合成自测入口，待允许执行脚本的环境以固定 -File 验证',
    '真实输入窗口、DPAPI、私密保存、身份/ACL 查询未运行；不读真实编号/既有密文/凭据',
    '未改 PATH/权限/策略/系统环境；未联网；1/2号不重试，P 不开展，A 预检不恢复'
  ]
};

const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0) {
  const outPath = process.argv[outIdx + 1];
  const fd = fs.openSync(outPath, 'wx'); // wx 独占创建，不覆盖任何既有文件
  fs.writeFileSync(fd, JSON.stringify(report, null, 2));
  fs.closeSync(fd);
  console.log('written:', outPath);
} else {
  console.log(JSON.stringify(report, null, 2));
}
if (!ok) process.exit(1);
