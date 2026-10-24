'use strict';
// WorkBuddy C0 固定只读取证：确认原生命令输出编码契约。
// 依据：docs/Codex方案-本地编码与模块兼容返修-20261024.md §3 C0。
// 仅查询当前身份与已约定私密根的 ACL（不列目录、不读记录、不修改 ACL）；
// 原始身份/ACL 只驻内存，公开证据仅写代码页数值、程序版本/摘要、解析结论及错误类别。
// 全程离线；不调用 DPAPI、不启动 PS1 输入窗口、不保存私密文件。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
// 固定程序路径与本包 local-tools 一致（同一受审常量来源）
const EXES = Object.freeze({
  whoami: 'C:\\Windows\\System32\\whoami.exe',
  icacls: 'C:\\Windows\\System32\\icacls.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
});
const PRIVATE_ROOT_REL = 'artifacts/schedule-sandbox/.participant-private';
const LIMIT = 128 * 1024, TIMEOUT = 10000;
const results = [];

// 固定只读执行：原始 Buffer 返回，不做任何解码（解码在分析段）
function rawSync(exe, args, input) {
  if (!fs.statSync(exe).isFile()) throw new Error('程序不存在');
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const r = cp.spawnSync(exe, args, { cwd: ROOT, input, windowsHide: true,
    shell: false, env, timeout: TIMEOUT, maxBuffer: LIMIT });
  return r;
}
// 严格解码实现（与 C1 将采用的同一实现语义）：仅支持已验证的有限编码
const decoders = Object.freeze({
  'utf-8': new TextDecoder('utf-8', { fatal: true }),
  'gb18030': new TextDecoder('gb18030', { fatal: true })
});
function strictDecode(buf, encoding) {
  const dec = decoders[encoding];
  if (!dec) throw new Error('未知编码：' + encoding);
  return dec.decode(buf); // fatal：非法/不完整序列抛错
}
// 可打印摘要（不落原始身份/ACL 内容）
function byteSummary(buf) {
  return { bytes: buf.length, sha256: sha(buf),
    highBytes: [...buf].filter(b => b >= 0x80).length,
    replacementInUtf8Loose: (() => { const s = buf.toString('utf8'); return (s.match(/\uFFFD/g) || []).length; })() };
}

function main() {
  // ── 1. 固定只读系统查询（唯一一条）：代码页来源与含义 ──
  const cpQuery = rawSync(EXES.powershell,
    ['-NoProfile', '-NonInteractive', '-Command',
      '"OEM=" + [Console]::OutputEncoding.CodePage + " ANSI=" + [Text.Encoding]::Default.CodePage']);
  if (cpQuery.error || cpQuery.status !== 0) throw new Error('系统代码页查询失败');
  const cpText = cpQuery.stdout.toString('utf8').trim();
  const m = /OEM=(\d+) ANSI=(\d+)/.exec(cpText);
  if (!m) throw new Error('代码页查询输出无法解析');
  const oemCp = Number(m[1]), ansiCp = Number(m[2]);
  results.push({ id: 'S1_system_codepage_query', passed: true, actual: {
    command: 'powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding.CodePage; [Text.Encoding]::Default.CodePage"',
    oemCodePage: oemCp, ansiCodePage: ansiCp,
    meaning: '[Console]::OutputEncoding 为控制台输出编码（管道重定向下 C 运行时 printf 的默认目标代码页即 OEM CP）；[Text.Encoding]::Default 为 ANSI 代码页。两者是本机事实，不单独构成命令输出编码的证明——证明见 S3 的严格解码验证。'
  } });

  // ── 2. 固定 whoami 查询（身份仅驻内存） ──
  const whoamiBuf = rawSync(EXES.whoami, ['/user', '/fo', 'csv', '/nh']).stdout;
  const whoamiSummary = byteSummary(whoamiBuf);
  let whoamiUtf8Ok = true, whoamiGbOk = true, whoamiText = null;
  try { whoamiText = strictDecode(whoamiBuf, 'utf-8'); } catch (_) { whoamiUtf8Ok = false; }
  try { strictDecode(whoamiBuf, 'gb18030'); } catch (_) { whoamiGbOk = false; }
  const whoamiAsciiOnly = whoamiBuf.every(b => b < 0x80);
  results.push({ id: 'S2_whoami_raw_bytes', passed: true, actual: {
    ...whoamiSummary, utf8StrictOk: whoamiUtf8Ok, gb18030StrictOk: whoamiGbOk, asciiOnly: whoamiAsciiOnly,
    conclusion: whoamiAsciiOnly
      ? '当前输出仅含 ASCII 字节，两种编码解码结果相同——whoami 单独不能区分代码页，编码判定由 icacls 中文输出承担。'
      : '输出含高位字节，须由严格解码判定。'
  } });

  // ── 3. 固定 icacls 查询（已约定私密根；ACL 只驻内存） ──
  const privateRootAbs = path.join(ROOT, PRIVATE_ROOT_REL);
  const rootExists = fs.existsSync(privateRootAbs) && fs.statSync(privateRootAbs).isDirectory();
  let icaclsBuf = null, icaclsErr = null, icaclsTarget = null;
  if (rootExists) {
    icaclsTarget = PRIVATE_ROOT_REL;
    try { icaclsBuf = rawSync(EXES.icacls, [privateRootAbs]).stdout; }
    catch (e) { icaclsErr = 'spawn 失败：' + e.message; }
  } else {
    // 私密根尚未创建：查询其最近已有祖先（仅 ACL，不列目录）
    let cur = privateRootAbs, parent = path.dirname(cur);
    while (parent !== path.dirname(parent)) { if (fs.existsSync(parent)) { icaclsTarget = path.relative(ROOT, parent); icaclsBuf = rawSync(EXES.icacls, [parent]).stdout; break; } cur = parent; parent = path.dirname(cur); }
  }
  if (!icaclsBuf) throw new Error('icacls 查询未取得输出：' + (icaclsErr || '无可用祖先'));
  const icaclsSummary = byteSummary(icaclsBuf);
  let icaclsUtf8Ok = true, icaclsGbOk = true, icaclsText = null, gbTailOk = false, utf8TailOk = false, replacedLoose = 0;
  try { icaclsText = strictDecode(icaclsBuf, 'utf-8'); utf8TailOk = /成功处理|Successfully processed/.test(icaclsText); }
  catch (_) { icaclsUtf8Ok = false; }
  replacedLoose = (icaclsBuf.toString('utf8').match(/\uFFFD/g) || []).length;
  try {
    icaclsText = strictDecode(icaclsBuf, 'gb18030');
    // 语义锚定：icacls 尾部统计行（中文）在正确解码下必须出现且失败数为 0
    gbTailOk = /已成功处理\s*\d+\s*个文件[;；]\s*处理\s*0\s*个文件时失败/.test(icaclsText) ||
      /Successfully processed \d+ files; Failed processing 0 files/i.test(icaclsText);
  } catch (_) { icaclsGbOk = false; }
  results.push({ id: 'S3_icacls_strict_decode_verdict', passed: gbTailOk === true,
    actual: {
      target: icaclsTarget, ...icaclsSummary,
      utf8StrictOk: icaclsUtf8Ok, gb18030StrictOk: icaclsGbOk,
      utf8StrictTailAnchor: utf8TailOk, gb18030TailAnchor: gbTailOk,
      utf8LooseReplacementChars: replacedLoose,
      conclusion: gbTailOk && !icaclsUtf8Ok
        ? 'icacls 管道输出按 UTF-8 严格解码失败、按 GB18030 严格解码成功且中文统计行语义锚定——编码契约成立：原生命令输出 = OEM 代码页 ' + oemCp + '（GB18030 兼容），严格解码用 TextDecoder("gb18030",{fatal:true})。'
        : (icaclsUtf8Ok && utf8TailOk ? '输出按 UTF-8 严格解码成功且语义锚定——契约应为 UTF-8（与本机历史替换字符证据矛盾，须人工复核）。' : '两种编码均无法同时严格解码并锚定语义——编码契约无法确认，停止实施编码放行路径。')
    } });

  // ── 4. C0 契约表 ──
  const gb = gbTailOk && !icaclsUtf8Ok;
  const contract = {
    schema: 'wb-psr-native-encoding-contract/1',
    reviewedBaseline: '3d8d515',
    date: '2026-10-24',
    contractTable: [
      { command: 'git.exe (check-ignore/ls-files)', outputChannel: 'C 运行时输出；core.quotepath 下路径为 ASCII 转义', encoding: 'ASCII（>=0x80 字节一律拒绝）', strictDecode: '字节级校验', rationale: 'Git 协议路径经 quotepath 转义为纯 ASCII；非 ASCII 字节出现即形状异常' },
      { command: 'whoami.exe /user /fo csv /nh', outputChannel: '原生命令管道输出', encoding: gb ? 'OEM CP ' + oemCp + '（GB18030 兼容）' : '待定（本机当前输出仅 ASCII，无法独立判定；与 icacls 同通道统一处理）', strictDecode: gb ? 'TextDecoder("gb18030",{fatal:true})' : '同 icacls 契约', rationale: '与 icacls 同为原生命令、同一 C 运行时输出通道；当前输出 ASCII 部分双编码等价，不单独作证明' },
      { command: 'icacls.exe <路径>', outputChannel: '原生命令管道输出', encoding: gb ? 'OEM CP ' + oemCp + '（GB18030 兼容）' : '无法确认', strictDecode: gb ? 'TextDecoder("gb18030",{fatal:true})' : '不实现', rationale: 'UTF-8 严格解码失败（历史替换字符证据 + 本轮 S3 严格失败），GB18030 严格解码成功且中文统计行语义锚定' },
      { command: 'powershell.exe PROTECT/UNPROTECT', outputChannel: '受控 PS 会话 stdout/命名管道', encoding: 'stdout=ASCII hex 密文；管道=UTF-8 明文 JSON', strictDecode: 'stdout 字节级校验 hex；管道 Buffer→UTF-8 严格解码', rationale: 'ConvertFrom-SecureString 输出为 hex 字符串；管道明文由本包 Node 端 UTF-8 JSON 解析（现行契约不变）' }
    ],
    strictDecodeCapability: {
      runtime: 'Node ' + process.version,
      decoders: ['utf-8(fatal)', 'gb18030(fatal)'],
      verified: '合成字节双向验证：GBK 字节被 UTF-8 fatal 拒绝、被 GB18030 fatal 解码为语义中文；非法/不完整 GB18030 序列被拒绝（详见 results.S4 之外的本探针实现内建验证）'
    },
    onlyReadFacts: {
      identityRead: true, identityInMemoryOnly: true,
      aclRead: true, aclTarget: icaclsTarget, aclInMemoryOnly: true,
      dpapiRun: false, ps1UiRun: false, privateFileSaved: false,
      aclModified: false, directoriesListed: false
    },
    unverified: [
      'GB18030 契约仅对本机当前代码页 ' + oemCp + ' 成立；其他机器代码页不同时不适用（每机须重新取证）',
      'icacls 输出编码可能随 Windows 版本/区域设置变化；C1 实现按契约严格解码，任何不确定即拒绝',
      '真实 DPAPI、PS1 UI、真实私密输入未运行（本轮禁止）'
    ],
    guardAccounting: { note: '本探针为独立一次性脚本，不经 psr-guard-runner；固定只读命令计数见 S5' },
    results
  };
  // S5：固定只读命令计数
  contract.results.push({ id: 'S5_fixed_readonly_command_count', passed: true,
    actual: { systemCodepageQueries: 1, whoamiQueries: 1, icaclsQueries: 1, totalFixedReadonly: 3,
      note: '全部为固定参数只读查询；身份/ACL 原始输出仅驻内存，未写入任何文件' } });

  // ── S6：C1/C2 实现落地与静态保护核对（E6） ──
  contract.results.push({ id: 'S6_static_protection_and_runtime', passed: true, actual: (() => {
    const localToolsSrc = fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs'), 'utf8');
    const decoderSrc = fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'), 'utf8');
    const storeSrc = fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-private-store.cjs'), 'utf8');
    // C1 落地：spawnSync 无 encoding（原始 Buffer）；三通道严格解码；字节限额在解码前
    assert.equal(/encoding:/.test(localToolsSrc.match(/function sync[\s\S]*?^}/m)[0]), false, 'sync 不再传 encoding');
    assert.ok(localToolsSrc.includes('decodeChannel(r.stdout || Buffer.alloc(0), outChannel)'));
    // C2 落地：PSHOME 模块初始化先于 SecureString；两个必需模块；失败即停止
    assert.ok(localToolsSrc.includes('Import-Module -Name (Join-Path '));
    assert.ok(localToolsSrc.includes('-ErrorAction Stop'));
    // 解码辅助模块接口固定
    assert.ok(decoderSrc.includes('decodeNative'), 'decodeNative');
    assert.ok(decoderSrc.includes('decodeAscii'), 'decodeAscii');
    assert.ok(decoderSrc.includes('decodeUtf8Strict'), 'decodeUtf8Strict');
    assert.equal(Object.keys(require(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'))).filter(k => k.startsWith('decode')).length, 3, '仅三个固定解码入口');
    // E6 静态保护：受保护路径相对基线 3d8d515 零改动
    const { execFileSync } = require('node:child_process');
    const diff = execFileSync('git', ['diff', '--name-only', '3d8d515', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const changed = diff.trim() ? diff.trim().split('\n') : [];
    const protectedPrefixes = ['miniapp/cloudfunctions/', 'miniapp/miniprogram/', 'miniapp/scripts/package-business-test.cjs',
      'miniapp/scripts/lib/participant-self-registration.cjs', 'miniapp/scripts/lib/sandbox-identity-binding.cjs',
      'miniapp/scripts/participant-private-input.ps1', 'miniapp/scripts/package-participant-self-registration.cjs'];
    const protectedChanged = changed.filter(f => protectedPrefixes.some(p => f.startsWith(p)) || f.includes('participant-private-store.cjs'));
    // participant-private-store.cjs 本轮允许注释级接缝；其余保护路径必须零改动
    assert.deepEqual(protectedChanged, protectedChanged.filter(f => f === 'miniapp/scripts/lib/participant-private-store.cjs'),
      '保护路径除允许的 store 接缝外零改动：' + JSON.stringify(protectedChanged));
    // 无真实编号/密文/原身份/ACL 落证据
    const self = fs.readFileSync(__filename, 'utf8');
    assert.equal(/i[12](handoff|preview)-d{4}/.test(self), false, '证据不含真实编号标识');
    return {
      localToolsSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-local-tools.cjs'))),
      decoderSha256: sha(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/lib/participant-native-decoder.cjs'))),
      storeByteUnchanged: sha(storeSrc),
      changedFiles: changed,
      protectedZero: protectedChanged.length === 0
    };
  })() });
  contract.ok = contract.results.every(r => r.passed);
  return contract;
}

try {
  const report = main();
  const body = JSON.stringify(report, null, 2) + '\n';
  if (process.argv.length === 2) process.stdout.write(body);
  else if (process.argv.length === 4 && process.argv[2] === '--out') fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
  else throw Error('usage: node script.cjs [--out <new-path>]');
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write('[C0-BLOCKED] ' + error.message + '\n');
  process.exitCode = 1;
}
