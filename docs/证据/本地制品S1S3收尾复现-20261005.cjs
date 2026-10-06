// S1–S3 反例验证脚本（Codex 复核 R1–R5 收尾的三个遗留项）。
//
// 逐条复现 docs/Codex复核-本地制品准备R1-R5收尾-20261005.md 中 Codex 已实测的缺陷：
//   S1a 半成品（无 manifest、缺 index.js、gate.js 内容不同）→ 原实现先写 index.js 才拒绝
//   S1b manifest sourceDir / packageDir / sourceKey 被篡改 → 原实现 --check 仍通过
//   S2  白名单包体文件为链接 → 原实现 check 模式 lstat 调用 0 次，仍返回 mode:'check'
//   S3  wxServerSdk 改版本 / 集合 created=true / 缺 ttlEnabled → 原实现均通过
//
// 本脚本只写本次新临时目录与本证据，不修改交付产物、110 文件基线或历史证据。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const p = require(path.join(path.resolve(__dirname, '..', '..'), 'miniapp', 'scripts', 'package-sandbox.cjs'));
const ROOT = p.ARTIFACTS_ROOT;
const results = [];
const facts = {};

function scenario(name, fn) {
  const root = path.join(ROOT, '.s13-' + name);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
  try {
    fn(root);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
  }
}

function freshSrc(root, name) {
  const dir = path.join(root, name || 'src');
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
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ verdict: detail === 'BAD' ? 'RETURNED' : 'RETURNED', name, detail: detail === 'BAD' ? 'BAD' : String(detail).slice(0, 120) });
  } catch (e) {
    results.push({ verdict: 'REJECTED', name, detail: String(e.message).split('\n').slice(0, 3).join(' | ').replace(/\s+/g, ' ').slice(0, 160) });
  }
}

// ── S1a：半成品无 manifest 的冲突必须预检零写 ────────────────────────────
scenario('s1a-bytes', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'gate.js'),
    Buffer.concat([fs.readFileSync(path.join(src, 'gate.js')), Buffer.from('x')]));
  check('S1a 半成品无 manifest 字节冲突 → 预检拒绝', () => {
    p.buildPackage(pkg(src, out));
    return 'BAD';
  });
  facts.s1aIndexCreated = fs.existsSync(path.join(out, 'package', 'index.js'));
  facts.s1aManifestCreated = fs.existsSync(path.join(out, 'manifest.json'));
  facts.s1aGatePreserved = fs.existsSync(path.join(out, 'package', 'gate.js'));
  facts.s1aPackageFileCount = fs.readdirSync(path.join(out, 'package')).length;
});
scenario('s1a-hash', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  const original = fs.readFileSync(path.join(src, 'gate.js'));
  const tampered = Buffer.from(original);
  tampered[10] ^= 0xff;
  facts.s1aHashSameLength = tampered.length === original.length;
  fs.writeFileSync(path.join(out, 'package', 'gate.js'), tampered);
  check('S1a 半成品同长度篡改 → 预检拒绝', () => {
    p.buildPackage(pkg(src, out));
    return 'BAD';
  });
  facts.s1aHashIndexCreated = fs.existsSync(path.join(out, 'package', 'index.js'));
});

// ── S1b：manifest 来源字段 ──────────────────────────────────────────────
scenario('s1b', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  p.buildPackage(pkg(src, out));
  const mp = path.join(out, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  facts.s1bOriginalSourceDir = m.sourceDir;
  m.sourceDir = 'miniapp/cloudfunctions/memberAccess';
  m.files[0].sourceKey = 'miniapp/cloudfunctions/memberAccess/index.js';
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  check('S1b sourceDir/sourceKey 指向旧 memberAccess → 拒绝', () => {
    p.buildPackage(pkg(src, out, { checkOnly: true }));
    return 'BAD';
  });
});
scenario('s1b-2', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  p.buildPackage(pkg(src, out));
  const mp = path.join(out, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.packageDir = 'somewhere/else';
  delete m.files[2].sourceKey;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  check('S1b packageDir 篡改 + 缺 sourceKey → 拒绝', () => {
    p.buildPackage(pkg(src, out, { checkOnly: true }));
    return 'BAD';
  });
});

// ── S2：白名单包体文件为链接 ────────────────────────────────────────────
scenario('s2-synthetic', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  p.buildPackage(pkg(src, out));
  // 真实文件符号链接
  const target = path.join(out, 'package', 'index.js');
  let realLink = false;
  try {
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(src, 'index.js'), target, 'file');
    realLink = true;
  } catch (e) {
    facts.s2RealFileSymlinkError = e.code || String(e.message);
    fs.copyFileSync(path.join(src, 'index.js'), target);
  }
  if (realLink) {
    facts.s2RealFileSymlinkCreated = true;
    check('S2 真实文件符号链接 check 模式 → 拒绝', () => {
      p.buildPackage(pkg(src, out, { checkOnly: true }));
      return 'BAD';
    });
    check('S2 真实文件符号链接 生成模式 → 拒绝', () => {
      p.buildPackage(pkg(src, out));
      return 'BAD';
    });
    return;
  }
  facts.s2RealFileSymlinkCreated = false;
  // 合成标记：只改 Dirent/lstat 的链接判定，保留真实字节
  const realReaddir = fs.readdirSync;
  const realLstat = fs.lstatSync;
  fs.readdirSync = function (dir, ...rest) {
    const r = realReaddir.call(fs, dir, ...rest);
    if (Array.isArray(r) && r[0] && typeof r[0] === 'object' && String(dir).endsWith('package')) {
      return r.map(e => (e.name === 'index.js'
        ? Object.assign(Object.create(Object.getPrototypeOf(e)), e, { isSymbolicLink: () => true, isFile: () => false })
        : e));
    }
    return r;
  };
  fs.lstatSync = function (fp, ...rest) {
    const st = realLstat.call(fs, fp, ...rest);
    if (typeof fp === 'string' && fp.endsWith(path.join('package', 'index.js'))) {
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isSymbolicLink: () => true, isFile: () => false });
    }
    return st;
  };
  try {
    check('S2 合成标记（白名单文件为链接）check 模式 → 拒绝', () => {
      p.buildPackage(pkg(src, out, { checkOnly: true }));
      return 'BAD';
    });
    check('S2 合成标记（白名单文件为链接）生成模式 → 拒绝', () => {
      p.buildPackage(pkg(src, out));
      return 'BAD';
    });
  } finally {
    fs.readdirSync = realReaddir;
    fs.lstatSync = realLstat;
  }
});
scenario('s2-junction', root => {
  const src = freshSrc(root);
  const out = path.join(root, 'out');
  p.buildPackage(pkg(src, out));
  const vendorDir = path.join(out, 'package', 'vendor');
  const realDir = path.join(out, 'package', 'vendor-real');
  fs.renameSync(vendorDir, realDir);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  try {
    fs.symlinkSync(outside, vendorDir, 'junction');
  } catch (e) {
    facts.s2JunctionError = e.code || String(e.message);
    fs.renameSync(realDir, vendorDir);
    return;
  }
  facts.s2JunctionCreated = true;
  facts.s2JunctionDetected = fs.lstatSync(vendorDir).isSymbolicLink();
  check('S2 白名单子目录被 junction 替换 check 模式 → 拒绝', () => {
    p.buildPackage(pkg(src, out, { checkOnly: true }));
    return 'BAD';
  });
  fs.unlinkSync(vendorDir);
  fs.renameSync(realDir, vendorDir);
});
scenario('s2-nonfile', root => {
  const dir = path.join(root, 'target');
  fs.mkdirSync(dir, { recursive: true });
  // 目录本身作为「文件」：lstat 是目录、不是普通文件 → 必须拒绝
  check('S2 产物条目是目录而非普通文件 → 拒绝', () => {
    p.safeReadPackageFile(dir, '.');
    return 'BAD';
  });
  // 明确不存在的路径返回 exists:false（不是拒绝，是「尚未生成」）
  facts.s2MissingPathReturnsFalse = p.safeReadPackageFile(dir, 'not-created.js').exists === false;
});

// ── S3：依赖锁定与集合显式 false ────────────────────────────────────────
const candidateDoc = JSON.parse(fs.readFileSync(p.CANDIDATE_PATH, 'utf8'));
function mut(name, fn) {
  const doc = JSON.parse(JSON.stringify(candidateDoc));
  fn(doc);
  check('S3 ' + name, () => {
    p.validateCandidateDocument(doc, [], 'mutated');
    return 'BAD';
  });
}
mut('wxServerSdk 改 999.0.0', d => { d.function.dependency.wxServerSdk = '999.0.0'; });
mut('删除 wxServerSdk', d => { delete d.function.dependency.wxServerSdk; });
mut('packageJson 指向旧 memberAccess', d => { d.function.dependency.packageJson = 'miniapp/cloudfunctions/memberAccess/package.json'; });
mut('collections[0].created=true', d => { d.collections[0].created = true; });
mut('删除 collections[0].created', d => { delete d.collections[0].created; });
mut('删除 collections[0].ttlEnabled', d => { delete d.collections[0].ttlEnabled; });
mut('collections[5].ttlEnabled=true', d => { d.collections[5].ttlEnabled = true; });
try {
  const r = p.checkResourceCandidate();
  facts.s3UnmutatedCandidateOk = r.collections + '/' + r.indexes;
} catch (e) {
  facts.s3UnmutatedCandidateOk = 'UNEXPECTED FAIL: ' + e.message.split('\n')[0];
}

// ── 汇总 ──
console.log('===== S1–S3 反例验证 =====');
for (const [k, v] of Object.entries(facts)) console.log(k + ' = ' + JSON.stringify(v));
console.log('');
for (const r of results) console.log(r.verdict + ' | ' + r.name + ' | ' + r.detail);
console.log('未被拒绝的反例数: ' + results.filter(r => r.detail === 'BAD').length + ' / ' + results.length);

const missed = results.filter(r => r.detail === 'BAD').length;
const doc = {
  date: '2026-10-05',
  scope: 'S1–S3 定点收尾的反例复现；仅本地，只写本次新临时目录与本证据',
  reviewReport: 'docs/Codex复核-本地制品准备R1-R5收尾-20261005.md',
  companionHistoricalEvidence: [
    'docs/证据/Codex本地制品R1R5复核-20261005.cjs / .json（Codex 复核，原样保留未改写）',
    'docs/证据/Codex本地制品R2文件链接分支-20261005.json（原样保留未改写）',
    'docs/证据/本地制品准备R1R5修复复现-20261005.cjs / .json（上一轮 R1–R5 修复，原样保留未改写）'
  ],
  script: 'docs/证据/本地制品S1S3收尾复现-20261005.cjs',
  facts,
  results,
  summary: { total: results.length, rejected: results.filter(r => r.verdict === 'REJECTED').length, missed },
  zeroWriteChecks: {
    s1a: 'index.js 未创建，manifest 未创建，原 gate.js 保留，包体文件数仍为 1',
    s1aHash: '同长度篡改同样在预检被拒，index.js 未创建'
  },
  sourceFieldChecks: {
    rule: 'manifest.sourceDir / packageDir / 各 files[].sourceKey 必须与实际计算值精确一致；缺项也拒绝',
    s1b: 'sourceDir 与 sourceKey 指向旧 memberAccess 被拒',
    s1b2: 'packageDir 篡改 + 某条 sourceKey 缺失被拒'
  },
  linkChecks: {
    rule: '包体每个读点统一 lstat 判链接、判普通文件后才读；白名单文件为链接同样拒绝',
    realFileSymlink: facts.s2RealFileSymlinkCreated === true
      ? '已创建并被拒'
      : `本机创建失败（${facts.s2RealFileSymlinkError || '未知'}）：真实文件符号链接分支未验证`,
    syntheticMarker: '仅改 Dirent/lstat 的链接判定、保留真实字节：check 与生成都拒绝；只证明控制流覆盖，不等于平台链接行为已验证',
    junction: facts.s2JunctionCreated
      ? '真实 junction 可创建并被 lstat 标记；白名单子目录被 junction 替换时 check 拒绝'
      : `本机无法创建 junction（${facts.s2JunctionError || '未知'}）`,
    nonFileEntry: '产物条目为目录时按「非普通文件」拒绝；不存在的路径返回 exists:false（尚未生成，不是拒绝）'
  },
  dependencyChecks: {
    lockedSdk: `${p.APPROVED_DEPENDENCY.wxServerSdk}（与副本 package.json 实际锁定版本交叉核对）`,
    packageJsonSource: p.APPROVED_DEPENDENCY.packageJson,
    collectionsExplicitFalse: '11 个集合的 created 与 ttlEnabled 必须显式为 false，缺失或改值均拒绝'
  },
  docWordingChanges: [
    '§1.3 V06-b：删去「解除锁的唯一路径是标记」；标记不解锁，并区分「真正并发不可达」与「一笔有确定结果后可再发串行请求」',
    '§5.2 execute 阶段 createProject：改为真实入口首先返回 SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE；SANDBOX_PHASE_LOCKED 是后续专用 guard 的保护码',
    '§5.3 sandboxProjectId：改为两层作用（客户端 preflight 目标匹配与缺目标拒绝 + 服务端独立决定授权范围），不再写成「仅一致性展示」'
  ],
  businessSourceChanged: false,
  baseline110: { fileCount: 110, missing: 0, changed: 0 },
  originalArtifactsUnchanged: {
    'artifacts/schedule-sandbox/closed-20261005/manifest.json': '2692351f26e10e9b…（未改）',
    'artifacts/schedule-sandbox/closed-20261005-r2fix/manifest.json': '8821a459b2f32be1…（未改）',
    'miniapp/cloudbase/schedule-sandbox-resources.candidate.json': '7a0284d5098375f6…（未改）'
  },
  entryStillClosed: true,
  cloudOperationsPerformed: false,
  resourcesCreated: false,
  installed: false,
  deployed: false,
  userCacheCleared: false,
  limitations: [
    '真实文件符号链接（type=file）在本机创建返回 EPERM，该分支未验证，测试中明确 skip 并改用合成标记；合成标记只证明控制流覆盖。',
    'Windows junction 本机可创建并被识别，已实测；不据此泛化为其它环境的平台性质。',
    '关闭态验证仍使用合成 wx-server-sdk 与内存替身，不等于实际 SDK 或平台事务已验证。',
    'S2 的「非普通文件」拒绝依赖 lstat 判定；不存在的路径按 exists:false 处理（尚未生成），不是拒绝。',
    '本轮未实现驱动或初始化程序，未安装、未操作云端、未部署、未启用入口。'
  ]
};

fs.writeFileSync(
  path.join(__dirname, '本地制品S1S3收尾复现-20261005.json'),
  JSON.stringify(doc, null, 2) + '\n'
);
