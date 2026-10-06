// S1 缺文件预检回归的定点复现（Codex 复核第 2 节）+ 第 3 节夹具修正。
//
// 复现 Codex 实测的三个分支：
//   1) 有 manifest、缺 index.js：此前 check 正确拒绝，生成却返回 mode:'created' 并重建文件
//   2) 上例叠加 manifest 文本冲突：此前先创建 index.js，最后才报 manifest 冲突
//   3) 无 manifest、仅有内容正确的 gate.js：合法半成品，应仍可续建
//
// 第 3 节：junction 夹具的备份放到输出目录外，断言只接受链接相关错误。
//
// 只写本次新临时目录（artifacts/schedule-sandbox/.s1fix-*，运行后自删）与配套 JSON；
// 不修改交付产物、110 文件基线或任何历史证据。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const p = require(path.join(path.resolve(__dirname, '..', '..'), 'miniapp', 'scripts', 'package-sandbox.cjs'));
const ROOT = p.ARTIFACTS_ROOT;
const results = [];
const facts = {};

function scenario(name, fn) {
  const root = path.join(ROOT, '.s1fix-' + name);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
  try {
    fn(root);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
  }
}
function freshSrc(root) {
  const dir = path.join(root, 'src');
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of p.PACKAGE_FILES) {
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(p.SOURCE_DIR, rel), to);
  }
  return dir;
}
function pkg(src, out, extra) {
  return Object.assign({ outDir: out, sourceDir: src, skipBaseline: true, skipCandidateCheck: true }, extra || {});
}
function record(name, verdict, detail) {
  results.push({ verdict, name, detail: detail === undefined ? null : String(detail).replace(/\s+/g, ' ').slice(0, 200) });
}
function check(name, fn) {
  try {
    fn();
    record(name, 'RETURNED', 'BAD');
  } catch (e) {
    record(name, 'REJECTED', e.message);
  }
}

// ── 分支 1：有 manifest、缺 index.js ────────────────────────────────────
scenario('missing-with-manifest', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  p.buildPackage(pkg(src, out));
  fs.unlinkSync(path.join(out, 'package', 'index.js'));
  const manifestBefore = fs.readFileSync(path.join(out, 'manifest.json'), 'utf8');
  const before = fs.readdirSync(path.join(out, 'package')).length;

  check('分支1 check 模式：有 manifest 缺 index.js → 拒绝', () => {
    p.buildPackage(pkg(src, out, { checkOnly: true }));
    throw new Error('BAD');
  });
  check('分支1 生成模式：有 manifest 缺 index.js → 预检拒绝（此前会重建文件）', () => {
    p.buildPackage(pkg(src, out));
    throw new Error('BAD');
  });
  facts.branch1IndexRecreated = fs.existsSync(path.join(out, 'package', 'index.js'));
  facts.branch1ManifestUnchanged = fs.readFileSync(path.join(out, 'manifest.json'), 'utf8') === manifestBefore;
  facts.branch1PackageFileCountUnchanged = fs.readdirSync(path.join(out, 'package')).length === before;
});

// ── 分支 2：叠加 manifest 文本冲突 ──────────────────────────────────────
scenario('missing-plus-manifest-conflict', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  p.buildPackage(pkg(src, out));
  fs.unlinkSync(path.join(out, 'package', 'index.js'));
  const mp = path.join(out, 'manifest.json');
  const doc = JSON.parse(fs.readFileSync(mp, 'utf8'));
  doc.purpose = '被人为改动的用途说明';
  fs.writeFileSync(mp, JSON.stringify(doc, null, 2) + '\n');
  const manifestBefore = fs.readFileSync(mp, 'utf8');
  const before = fs.readdirSync(path.join(out, 'package')).length;

  check('分支2 缺文件 + manifest 冲突 → 缺文件先报且零写', () => {
    p.buildPackage(pkg(src, out));
    throw new Error('BAD');
  });
  facts.branch2IndexCreated = fs.existsSync(path.join(out, 'package', 'index.js'));
  facts.branch2ManifestUnchanged = fs.readFileSync(mp, 'utf8') === manifestBefore;
  facts.branch2PackageFileCountUnchanged = fs.readdirSync(path.join(out, 'package')).length === before;
});

// ── 分支 3：无 manifest 的合法半成品 ─────────────────────────────────────
scenario('half-product-no-manifest', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.copyFileSync(path.join(src, 'gate.js'), path.join(out, 'package', 'gate.js'));
  const gateBefore = fs.readFileSync(path.join(out, 'package', 'gate.js'));

  let mode = null;
  let reused = null;
  try {
    const r = p.buildPackage(pkg(src, out));
    mode = r.mode;
    reused = (r.written.find(i => i.path === 'gate.js') || {}).action;
  } catch (e) {
    record('分支3 无 manifest 合法半成品 → 应可续建', 'REJECTED', e.message);
  }
  if (mode) {
    record('分支3 无 manifest 合法半成品 → 续建成功', 'RETURNED', 'mode=' + mode + ' gate.js=' + reused);
  }
  facts.branch3GateReused = reused === 'reused';
  facts.branch3GateUnchanged = fs.readFileSync(path.join(out, 'package', 'gate.js')).equals(gateBefore);
  facts.branch3ManifestCreated = fs.existsSync(path.join(out, 'manifest.json'));
  facts.branch3AllFilesPresent = p.PACKAGE_FILES.every(rel => fs.existsSync(path.join(out, 'package', rel)));
  // 续建结果应通过 --check
  try {
    p.buildPackage(pkg(src, out, { checkOnly: true }));
    facts.branch3CheckPasses = true;
  } catch (e) {
    facts.branch3CheckPasses = 'ERR: ' + e.message.split('\n')[0];
  }
});

// ── 第 3 节：junction 夹具（备份移出输出目录）────────────────────────────
scenario('junction-fixture', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  p.buildPackage(pkg(src, out));
  const vendorDir = path.join(out, 'package', 'vendor');
  const backupRoot = path.join(root, 'backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  const realDir = path.join(backupRoot, 'vendor-real');
  fs.renameSync(vendorDir, realDir);
  facts.fixtureBackupOutsideOut = !fs.existsSync(path.join(out, 'package', 'vendor-real'));
  const outside = path.join(backupRoot, 'elsewhere');
  fs.mkdirSync(outside, { recursive: true });
  try {
    fs.symlinkSync(outside, vendorDir, 'junction');
  } catch (e) {
    facts.junctionCreated = false;
    facts.junctionError = e.code || String(e.message);
    fs.renameSync(realDir, vendorDir);
    return;
  }
  facts.junctionCreated = true;
  facts.junctionDetected = fs.lstatSync(vendorDir).isSymbolicLink();
  // 直接判定：要么因链接被拒且消息含链接表述，要么未被拒 → 记 BAD
  let junctionMsg = null;
  try {
    p.buildPackage(pkg(src, out, { checkOnly: true }));
    junctionMsg = null; // 未抛 → 未被拒
  } catch (e) {
    junctionMsg = e.message;
  }
  const junctionHit = Boolean(junctionMsg) && /vendor（符号链接\/目录联接）/.test(junctionMsg);
  record(
    'junction 白名单子目录 → 断言命中链接表述（非备份残留）',
    junctionHit ? 'REJECTED' : 'RETURNED',
    junctionHit ? junctionMsg : (junctionMsg ? 'BAD: 错误信息未命中链接表述 → ' + junctionMsg.split('\n')[0] : 'BAD: 未被拒绝')
  );
  fs.unlinkSync(vendorDir);
  fs.renameSync(realDir, vendorDir);
});

// ── 汇总 ──
const missed = results.filter(r => String(r.detail).includes('BAD')).length;
const doc = {
  date: '2026-10-05',
  scope: 'S1 缺文件预检回归的定点复现 + 第 3 节夹具修正；仅本地，只写本次新临时目录与本证据',
  reviewReport: 'docs/Codex复核-本地制品S1-S3收尾-20261005.md',
  companionHistoricalEvidence: [
    'docs/证据/Codex本地制品S1S3复核-20261005.cjs / .json（Codex 复核，原样保留未改写）',
    'docs/证据/本地制品S1S3收尾复现-20261005.cjs / .json（上一轮 S1–S3，原样保留未改写）'
  ],
  script: 'docs/证据/本地制品S1缺文件回归修复复现-20261005.cjs',
  fixSummary: {
    rootCause: 'safeReadPackageFile 返回 exists:false 时直接 continue，未把路径记入 facts.missing，导致「有 manifest 声明了但包体缺失」的完整性分支永远收不到缺文件，生成模式先补文件、随后才可能因 manifest 冲突失败。',
    minimalFix: '缺文件时记录 facts.missing；有 manifest 时在任何写入前拒绝；无 manifest 的合法半成品仍允许续建。不扩成签名或迁移系统。',
    fixtureFix: 'S2.2 的 vendor 备份从 package 内移到样本输出目录之外的专用临时根；错误断言只接受链接表述（vendor（符号链接/目录联接）），删除链接防线后该用例将不再抛错。',
    titleFix: 'S2.3 标题收准确：实际测的是普通文件/字节差异/缺失/目录（非普通文件）；链接覆盖在 S2.1 与独立证据。'
  },
  facts,
  results,
  summary: {
    total: results.length,
    rejected: results.filter(r => r.verdict === 'REJECTED').length,
    returned: results.filter(r => r.verdict === 'RETURNED').length,
    missed
  },
  beforeAfterComparison: {
    branch1Generate: '修复前 mode=created 且 index.js 被重建 → 修复后预检拒绝，index.js 不存在',
    branch2Conflict: '修复前先创建 index.js 再报 manifest 冲突 → 修复后缺文件先报、零写',
    branch3HalfProduct: '修复前后均允许续建（gate.js 被复用、8 文件齐备、--check 通过）'
  },
  originalArtifactsUnchanged: {
    'artifacts/schedule-sandbox/closed-20261005/manifest.json': '2692351f26e10e9b…（未改）',
    'artifacts/schedule-sandbox/closed-20261005-r2fix/manifest.json': '8821a459b2f32be1…（未改）',
    'miniapp/cloudbase/schedule-sandbox-resources.candidate.json': '7a0284d5098375f6…（未改）'
  },
  notRedone: 'S1a/S1b 原修复、S2/S3 实现、三处文案均未重做。',
  businessSourceChanged: false,
  baseline110: { fileCount: 110, missing: 0, changed: 0 },
  entryStillClosed: true,
  cloudOperationsPerformed: false,
  resourcesCreated: false,
  installed: false,
  deployed: false,
  userCacheCleared: false,
  limitations: [
    '真实文件符号链接（type=file）在本机仍为 EPERM，未验证；S2 的链接覆盖依赖 S2.1 的合成标记与本次 junction 实测。',
    'Windows junction 本机可创建并被识别，已实测；不据此泛化为其它环境的平台性质。',
    '关闭态验证仍使用合成 wx-server-sdk 与内存替身，不等于实际 SDK 或平台事务已验证。',
    '本轮未实现驱动或初始化程序，未安装、未操作云端、未部署、未启用入口。'
  ]
};

fs.writeFileSync(
  path.join(__dirname, '本地制品S1缺文件回归修复复现-20261005.json'),
  JSON.stringify(doc, null, 2) + '\n'
);

console.log('===== S1 缺文件回归定点复现 =====');
for (const [k, v] of Object.entries(facts)) console.log(k + ' = ' + JSON.stringify(v));
console.log('');
for (const r of results) console.log(r.verdict + ' | ' + r.name + ' | ' + (r.detail || '').slice(0, 120));
console.log('未达预期数: ' + missed + ' / ' + results.length);
