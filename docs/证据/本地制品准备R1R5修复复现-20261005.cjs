// R1–R5 反例验证脚本（临时，位于 artifacts 受控根下，运行后自删）。
// 逐条复现 Codex 复现的 10 个反例，确认修复后被拒绝。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = require(path.join(path.resolve(__dirname, '..', '..'), 'miniapp', 'scripts', 'package-sandbox.cjs'));

const ROOT = p.ARTIFACTS_ROOT;
const results = [];

function freshSrc(name) {
  const dir = path.join(ROOT, '.tmp-' + name, 'src');
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of p.PACKAGE_FILES) {
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(p.SOURCE_DIR, rel), to);
  }
  return dir;
}
function opt(src, out, extra) {
  return Object.assign({ outDir: out, sourceDir: src, skipBaseline: true, skipCandidateCheck: true }, extra || {});
}
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, rejected: false, detail: r });
  } catch (e) {
    results.push({ name, rejected: true, detail: String(e.message).split('\n').slice(0, 3).join(' | ') });
  }
}

// ── R1 ──
function scenario(name, fn) {
  const root = path.join(ROOT, '.tmp-' + name);
  // 先无条件清干净：Windows 上文件句柄释放有延迟，显式预清理避免上一轮残留
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 继续 */ }
  try {
    fn(root);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 忽略 */ }
  }
}

scenario('v1', root => {
  const src = freshSrc('v1'); const out = path.join(root, 'out');
  p.buildPackage(opt(src, out));
  fs.writeFileSync(path.join(out, 'manifest.json'), 'NOT JSON');
  check('R1-1 manifest 非法 JSON → check 拒绝', () => { p.buildPackage(opt(src, out, { checkOnly: true })); return 'BAD'; });
});
scenario('v2', root => {
  const src = freshSrc('v2'); const out = path.join(root, 'out');
  p.buildPackage(opt(src, out));
  const mp = path.join(out, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.files[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  check('R1-2 manifest 哈希与源不符 → 拒绝', () => { p.buildPackage(opt(src, out, { checkOnly: true })); return 'BAD'; });
});
scenario('v3', root => {
  const src = freshSrc('v3'); const out = path.join(root, 'out');
  p.buildPackage(opt(src, out));
  const mp = path.join(out, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.files.pop();
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  check('R1-3a manifest 漏项 → 拒绝', () => { p.buildPackage(opt(src, out, { checkOnly: true })); return 'BAD'; });
});
scenario('v3b', root => {
  const src = freshSrc('v3b'); const out = path.join(root, 'out');
  p.buildPackage(opt(src, out));
  const mp = path.join(out, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.files.push(Object.assign({}, m.files[0]));
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  check('R1-3b manifest 重复项 → 拒绝', () => { p.buildPackage(opt(src, out, { checkOnly: true })); return 'BAD'; });
});
scenario('v4', root => {
  fs.mkdirSync(root, { recursive: true });
  check('R1-4a 基线不存在 → 停止', () => { p.buildPackage({ outDir: path.join(root, 'out'), baselinePath: path.join(root, 'none.json') }); return 'BAD'; });
  fs.writeFileSync(path.join(root, 'bad.json'), '{ not json');
  check('R1-4b 基线坏 JSON → 停止', () => { p.buildPackage({ outDir: path.join(root, 'out2'), baselinePath: path.join(root, 'bad.json') }); return 'BAD'; });
  fs.writeFileSync(path.join(root, 'nofiles.json'), JSON.stringify({ date: 'x', fileCount: 1 }));
  check('R1-4c 基线缺 files → 停止', () => { p.buildPackage({ outDir: path.join(root, 'out3'), baselinePath: path.join(root, 'nofiles.json') }); return 'BAD'; });
  console.log('R1-4 零产物: out=' + fs.existsSync(path.join(root, 'out')) + ' out2=' + fs.existsSync(path.join(root, 'out2')) + ' out3=' + fs.existsSync(path.join(root, 'out3')));
});
scenario('v5', root => {
  const src = freshSrc('v5'); const out = path.join(root, 'out');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'unexpected.txt'), 'x');
  check('R1-5a package 额外文件 → 生成拒绝', () => { p.buildPackage(opt(src, out)); return 'BAD'; });
  check('R1-5b package 额外文件 → check 拒绝', () => { p.buildPackage(opt(src, out, { checkOnly: true })); return 'BAD'; });
  console.log('R1-5 零新增: manifest=' + fs.existsSync(path.join(out, 'manifest.json')) + ' index.js=' + fs.existsSync(path.join(out, 'package', 'index.js')));
});
scenario('v5b', root => {
  const src = freshSrc('v5b'); const out = path.join(root, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'stray.txt'), 'x');
  check('R1-5c 顶层额外文件 → 拒绝', () => { p.buildPackage(opt(src, out)); return 'BAD'; });
});
scenario('v6', root => {
  const src = freshSrc('v6'); const out = path.join(root, 'out');
  p.buildPackage(opt(src, out));
  fs.writeFileSync(path.join(out, 'package', 'gate.js'), Buffer.concat([fs.readFileSync(path.join(out, 'package', 'gate.js')), Buffer.from('x')]));
  const before = fs.readdirSync(path.join(out, 'package')).length;
  check('R1-6 晚序冲突 → 拒绝', () => { p.buildPackage(opt(src, out)); return 'BAD'; });
  console.log('R1-6 文件数不变: ' + before + ' -> ' + fs.readdirSync(path.join(out, 'package')).length);
});
scenario('v7', root => {
  const src = freshSrc('v7'); const out = path.join(root, 'out');
  const bad = path.join(root, 'bad-candidate.json');
  const doc = JSON.parse(fs.readFileSync(p.CANDIDATE_PATH, 'utf8'));
  doc.indexes[0].id = 'I99';
  fs.writeFileSync(bad, JSON.stringify(doc, null, 2));
  check('R1-7 候选清单错误 → 打包前拒绝', () => { p.buildPackage({ outDir: out, sourceDir: src, skipBaseline: true, candidatePath: bad }); return 'BAD'; });
  console.log('R1-7 零新增: out 存在=' + fs.existsSync(out));
});

// ── R2：真实 Windows junction ──
scenario('v8', root => {
  const src = freshSrc('v8');
  const actual = path.join(root, 'actual'); fs.mkdirSync(actual, { recursive: true });
  const alias = path.join(root, 'alias'); fs.symlinkSync(actual, alias, 'junction');
  console.log('R2 junction lstat isSymbolicLink=' + fs.lstatSync(alias).isSymbolicLink());
  check('R2-a 输出根 junction → 拒绝', () => { p.buildPackage(opt(src, alias)); return 'BAD'; });
  console.log('R2-a 未写入目标: manifest=' + fs.existsSync(path.join(actual, 'manifest.json')));
});
scenario('v9', root => {
  const src = freshSrc('v9');
  const out = path.join(root, 'out'); fs.mkdirSync(out, { recursive: true });
  const pkgActual = path.join(root, 'pkgActual'); fs.mkdirSync(pkgActual, { recursive: true });
  fs.symlinkSync(pkgActual, path.join(out, 'package'), 'junction');
  check('R2-b package 根 junction → 拒绝', () => { p.buildPackage(opt(src, out)); return 'BAD'; });
  console.log('R2-b 未写入: pkgActual/manifest=' + fs.existsSync(path.join(pkgActual, 'manifest.json')));
});
scenario('v10', root => {
  const realParent = path.join(root, 'realParent'); fs.mkdirSync(realParent, { recursive: true });
  const aliasParent = path.join(root, 'aliasParent'); fs.symlinkSync(realParent, aliasParent, 'junction');
  const src = freshSrc('v10');
  check('R2-c 祖先目录 junction → 拒绝', () => { p.buildPackage(opt(src, path.join(aliasParent, 'out'))); return 'BAD'; });
  console.log('R2-c 未写入: ' + fs.existsSync(path.join(realParent, 'out', 'manifest.json')));
});
scenario('v11', root => {
  const src = freshSrc('v11');
  check('R2-d 输出根与源目录重叠 → 拒绝', () => { p.buildPackage({ outDir: src, sourceDir: src, skipBaseline: true, skipCandidateCheck: true }); return 'BAD'; });
  check('R2-e 输出根为仓库根 → 拒绝', () => { p.buildPackage({ outDir: p.ROOT, sourceDir: src, skipBaseline: true, skipCandidateCheck: true }); return 'BAD'; });
  check('R2-f 输出根在制品目录之外 → 拒绝', () => { p.buildPackage({ outDir: path.join(p.ROOT, 'miniapp', 'x'), sourceDir: src, skipBaseline: true, skipCandidateCheck: true }); return 'BAD'; });
});

// ── R3 ──
const base = JSON.parse(fs.readFileSync(p.CANDIDATE_PATH, 'utf8'));
function mut(name, fn) {
  const root = path.join(ROOT, '.tmp-mut'); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const doc = JSON.parse(JSON.stringify(base)); fn(doc);
  const f = path.join(root, 'c.json'); fs.writeFileSync(f, JSON.stringify(doc, null, 2));
  check('R3 ' + name, () => { p.validateCandidateDocument(JSON.parse(fs.readFileSync(f, 'utf8')), [], f); return 'BAD'; });
  fs.rmSync(root, { recursive: true, force: true });
}
mut('I04 keys 反序 → 拒绝', d => { d.indexes[3].keys.reverse(); });
mut('I07 desc→asc → 拒绝', d => { d.indexes[6].keys[1].direction = 'asc'; });
mut('I05 unique→false → 拒绝', d => { d.indexes[4].unique = false; });
mut('I01 编号改 I99 → 拒绝', d => { d.indexes[0].id = 'I99'; });
mut('删除 runtime → 拒绝', d => { delete d.function.runtime; });
mut('runtime memoryMB→512 → 拒绝', d => { d.function.runtime.memoryMB = 512; });
mut('I12 追加第 5 字段 → 拒绝', d => { d.indexes[11].keys.push({ name: 'x', direction: 'asc' }); });
mut('I03 字段名改错 → 拒绝', d => { d.indexes[2].keys[0].name = 'userID'; });
mut('删除 dependency → 拒绝', d => { delete d.function.dependency; });
mut('executable→true → 拒绝', d => { d.executable = true; });
mut('containsPlatformApiRequest→true → 拒绝', d => { d.containsPlatformApiRequest = true; });
mut('删除 platformPrimaryKeys → 拒绝', d => { delete d.platformPrimaryKeys; });
mut('I05 unique→false 后再改回仍需唯一 → 拒绝', d => { d.indexes[4].unique = true; d.indexes[4].collection = 'schtest_v1_users'; });
check('R3 未变异真实清单应通过', () => { p.checkResourceCandidate(); return 'OK 通过'; });

// ── R4/R5 源码契约 ──
const repoSrc = path.join(p.ROOT, 'miniapp');
const page = fs.readFileSync(path.join(repoSrc, 'miniprogram/pages/schedule-sandbox/schedule-sandbox.js'), 'utf8');
const actsBlock = /const ACTIONS = \[([\s\S]*?)\n\];/.exec(page);
const acts = actsBlock ? (actsBlock[1].match(/key: '([a-zA-Z]+)'/g) || []).map(s => /'([a-zA-Z]+)'/.exec(s)[1]) : [];
console.log('R4 Page ACTIONS(' + acts.length + ') = ' + JSON.stringify(acts));
console.log('R4 removeMember 在 picker 中可选 = ' + acts.includes('removeMember'));
console.log('R4 buildPayload 是否有 removeMember 分支 = ' + /action === 'removeMember'/.test(page));
const svc = fs.readFileSync(path.join(repoSrc, 'cloudfunctions/scheduleSandbox/vendor/schedule-service.js'), 'utf8');
const gscIdx = svc.indexOf('getScheduleContext');
const gsc = gscIdx >= 0 ? svc.slice(gscIdx, gscIdx + 1400) : '';
const gscKeys = [...new Set([...gsc.matchAll(/\n {6}([a-zA-Z]+):/g)].map(m => m[1]))];
console.log('R4 getScheduleContext 返回键 = ' + JSON.stringify(gscKeys));
console.log('R4 上下文含 activeScheduleIds = ' + gscKeys.includes('activeScheduleIds'));
const cli = fs.readFileSync(path.join(repoSrc, 'miniprogram/utils/schedule-sandbox-client.js'), 'utf8');
const rpaIdx = cli.indexOf('function resolvePendingAfterExternalCheck');
const rpa = rpaIdx >= 0 ? cli.slice(rpaIdx, rpaIdx + 1400) : '';
console.log('R4 resolvePendingAfterExternalCheck 保留 envelope = ' + /clearEnvelope|envelope:/.test(rpa));
console.log('R4 resolvePendingAfterExternalCheck 标记 writeLocked = ' + /writeLocked/.test(rpa));

// ── 汇总 ──
console.log('');
console.log('===== 汇总 =====');
let bad = 0;
for (const r of results) {
  const isBad = r.detail === 'BAD';
  if (isBad) bad++;
  console.log((r.rejected ? 'REJECTED' : 'RETURNED ') + ' | ' + r.name + (r.detail && !isBad ? ' | ' + String(r.detail).slice(0, 100) : ''));
}
console.log('未被拒绝的反例数: ' + bad + ' / ' + results.length);
