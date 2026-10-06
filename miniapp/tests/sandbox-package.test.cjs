// 独立副本本地制品准备：关闭候选包与资源候选清单的**工具相称**测试。
//
// 任务：docs/WorkBuddy任务-独立副本本地制品准备-20261005.md §5
// 复查：docs/Codex复查-独立副本本地制品准备-20261005.md（只修 R1–R5）
//
// 范围严格限定在新增工具与新增清单，**不扩写已关闭业务（U3/U5 等）的测试矩阵**。
// 本文件同时是 R1–R3 的**反例回归**：每条反例都调用真正的校验器证明其失败，
// 而不是只读当前 JSON 断言它恰好正确。
//
// R1 校验必须覆盖 manifest，缺基线不得继续，生成前完成可预知检查
// R2 校验受信根路径（输出根 / package 根 / 祖先 junction）而不只校验子目录
// R3 资源清单按已审查 I01–I13 规格严格匹配
// R4 源码契约断言：Page 动作列表、公开返回字段（只读断言，不改业务）
// R5 P4 前置不含尚未创建的项目、驱动载体未成立（文档契约断言）
//
// 重要边界：本文件用合成 wx-server-sdk 与内存替身验证关闭态，
// **不等于**实际 SDK 或平台事务已验证；本地文件哈希不是云端编译后包的哈希。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const packager = require('../scripts/package-sandbox.cjs');
const { PREFIX, LOGICAL_COLLECTIONS } = require('../cloudfunctions/scheduleSandbox/collection-map');

const REPO_SRC = path.join(packager.ROOT, 'miniapp');

// 测试临时根放在**仓库受信制品目录之下**：
// os.tmpdir() 在 Windows 上是联接路径，会被 R2 的受信根检查正确拦下，
// 因此不能用它做输出根（这不是测试失败，是受信根约束生效）。
const TMP_ROOT = path.join(packager.ARTIFACTS_ROOT, '.test-tmp');
fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 });
fs.mkdirSync(TMP_ROOT, { recursive: true });

test.after(() => {
  // 只清理本测试自己创建的临时目录，不触碰任何既有产物或源目录。
  fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 });
});

function tmpDir(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把已验收源目录复制成一份可安全篡改的临时副本。 */
function cloneSource(name) {
  const dir = tmpDir(name);
  for (const rel of packager.PACKAGE_FILES) {
    const from = path.join(packager.SOURCE_DIR, rel);
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return dir;
}

/**
 * 测试用打包参数：**显式**跳过基线与候选清单核对。
 * 跳过是显式声明的，结果对象会标 checked:false / skipped:true，不冒充已核验。
 */
function pkg(src, out, extra) {
  return Object.assign(
    { outDir: out, sourceDir: src, skipBaseline: true, skipCandidateCheck: true },
    extra || {}
  );
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

/** 读取真实候选清单副本（供变异测试使用）。 */
function candidateDoc() {
  return JSON.parse(fs.readFileSync(packager.CANDIDATE_PATH, 'utf8'));
}

// ── R3：资源候选清单按已审查规格严格匹配 ──────────────────────────────────

test('R3.1 未变异的真实候选清单通过校验：11 集合 / 13 索引、不可执行', () => {
  const result = packager.checkResourceCandidate();
  assert.equal(result.collections, 11);
  assert.equal(result.indexes, 13);
  assert.equal(result.executable, false);
});

test('R3.2 索引变异全部被拒：字段顺序、方向、unique、编号、增删字段', () => {
  const cases = [
    ['I04 keys 反序', d => { d.indexes[3].keys.reverse(); }],
    ['I07 createdAt desc→asc', d => { d.indexes[6].keys[1].direction = 'asc'; }],
    ['I05 unique true→false', d => { d.indexes[4].unique = false; }],
    ['I01 编号改 I99', d => { d.indexes[0].id = 'I99'; }],
    ['I12 追加第 5 个字段', d => { d.indexes[11].keys.push({ name: 'x', direction: 'asc' }); }],
    ['I03 字段名改错', d => { d.indexes[2].keys[0].name = 'userID'; }],
    ['I02 字段数减少', d => { d.indexes[1].keys.pop(); }],
    ['I13 改归属集合', d => { d.indexes[12].collection = 'schtest_v1_schedules'; }]
  ];
  for (const [label, mutate] of cases) {
    const doc = candidateDoc();
    mutate(doc);
    assert.throws(
      () => packager.validateCandidateDocument(doc, [], 'mutated'),
      /资源候选清单校验失败/,
      `${label} 必须被拒绝`
    );
  }
});

test('R3.3 候选规格与就绪标记被删或改动 → 拒绝', () => {
  const cases = [
    ['删除 function.runtime', d => { delete d.function.runtime; }],
    ['runtime null', d => { d.function.runtime = null; }],
    ['runtime memoryMB 改 512', d => { d.function.runtime.memoryMB = 512; }],
    ['runtime nodejs 改 16.13', d => { d.function.runtime.nodejs = '16.13'; }],
    ['runtime 新增未审查字段', d => { d.function.runtime.extra = 1; }],
    ['删除 function.dependency', d => { delete d.function.dependency; }],
    ['dependency.installThisRound 改 true', d => { d.function.dependency.installThisRound = true; }],
    ['executable 改 true', d => { d.executable = true; }],
    ['executable 删除', d => { delete d.executable; }],
    ['containsPlatformApiRequest 改 true', d => { d.containsPlatformApiRequest = true; }],
    ['删除 platformPrimaryKeys', d => { delete d.platformPrimaryKeys; }],
    ['platformPrimaryKeys.count 改 10', d => { d.platformPrimaryKeys.count = 10; }]
  ];
  for (const [label, mutate] of cases) {
    const doc = candidateDoc();
    mutate(doc);
    assert.throws(
      () => packager.validateCandidateDocument(doc, [], 'mutated'),
      /资源候选清单校验失败/,
      `${label} 必须被拒绝`
    );
  }
});

test('R3.4 既有集合/函数/触发器防护仍生效（旧资源、额外函数、HTTP、权限、TTL）', () => {
  const cases = [
    ['多出旧集合', d => { d.collections.push({ name: 'users', permission: 'ADMINONLY', access: 'server-controlled', ttlEnabled: false, created: false }); }],
    ['未知前缀集合', d => { d.collections[0].name = 'schtest_v1_other'; }],
    ['权限改公开读', d => { d.collections[0].permission = 'READWRITE'; }],
    ['开启 TTL', d => { d.collections[3].ttlEnabled = true; }],
    ['access 描述被改', d => { d.collections[1].access = 'public'; }],
    ['额外函数', d => { d.otherFunctionsCreated = ['scheduleSandboxAdmin']; }],
    ['HTTP 网关', d => { d.function.httpAccess = [{ path: '/x' }]; }],
    ['定时触发器', d => { d.function.timerTriggers = [{ cron: '* * * * *' }]; }],
    ['集合数量减少', d => { d.collections.pop(); }],
    ['索引数量减少', d => { d.indexes.pop(); }],
    ['索引 created 改 true', d => { d.indexes[0].created = true; }],
    ['索引 ttl 改 true', d => { d.indexes[0].ttl = true; }],
    ['queryOrigin 清空', d => { d.indexes[0].queryOrigin = ''; }],
    ['部署根指向整个根目录', d => { d.function.deployRoot = 'miniapp/cloudfunctions'; }]
  ];
  for (const [label, mutate] of cases) {
    const doc = candidateDoc();
    mutate(doc);
    assert.throws(
      () => packager.validateCandidateDocument(doc, [], 'mutated'),
      /资源候选清单校验失败/,
      `${label} 必须被拒绝`
    );
  }
});

test('R3.5 候选清单与 collection-map 固定表逐项一致，全部 ADMINONLY / 无 TTL / 未创建', () => {
  const doc = candidateDoc();
  const mapped = LOGICAL_COLLECTIONS.map(name => packager.EXPECTED_PREFIX + name);
  const listed = doc.collections.map(item => item.name);
  assert.deepEqual([...listed].sort(), [...mapped].sort());
  for (const item of doc.collections) {
    assert.equal(item.permission, 'ADMINONLY');
    assert.equal(item.ttlEnabled, false);
    assert.equal(item.created, false);
    assert.equal(item.access, 'server-controlled');
  }
  // 索引编号与已审查规格一致
  assert.deepEqual(
    doc.indexes.map(i => i.id),
    packager.APPROVED_INDEX_SPECS.map(s => s.id)
  );
  // 仅 I05 唯一
  assert.deepEqual(doc.indexes.filter(i => i.unique).map(i => i.id), ['I05']);
  // I04 显式含 _id
  assert.deepEqual(
    doc.indexes.find(i => i.id === 'I04').keys.map(k => k.name),
    ['projectId', 'status', '_id']
  );
});

// ── R1：manifest 校验、基线强制、生成前预检 ───────────────────────────────

test('R1.1 manifest 非法 JSON → check 与生成都拒绝', () => {
  const src = cloneSource('r1-1-src');
  const out = path.join(tmpDir('r1-1'), 'closed');
  packager.buildPackage(pkg(src, out));
  fs.writeFileSync(path.join(out, 'manifest.json'), 'NOT JSON');
  assert.throws(() => packager.buildPackage(pkg(src, out, { checkOnly: true })), /manifest 不是合法 JSON/);
  assert.throws(() => packager.buildPackage(pkg(src, out)), /manifest 不是合法 JSON/);
});

test('R1.2 manifest 文件条目哈希错 / 字节数错 → 拒绝', () => {
  for (const [label, mutate] of [
    ['sha256', m => { m.files[0].sha256 = '0'.repeat(64); }],
    ['bytes', m => { m.files[0].bytes = m.files[0].bytes + 1; }]
  ]) {
    const src = cloneSource(`r1-2-${label}-src`);
    const out = path.join(tmpDir(`r1-2-${label}`), 'closed');
    packager.buildPackage(pkg(src, out));
    const mp = path.join(out, 'manifest.json');
    const doc = JSON.parse(fs.readFileSync(mp, 'utf8'));
    mutate(doc);
    fs.writeFileSync(mp, JSON.stringify(doc, null, 2) + '\n');
    assert.throws(
      () => packager.buildPackage(pkg(src, out, { checkOnly: true })),
      /manifest 校验失败/,
      `${label} 篡改必须被拒绝`
    );
  }
});

test('R1.3 manifest 漏项 / 重复项 / 白名单外路径 / 就绪标记被改 → 拒绝', () => {
  const cases = [
    ['漏项', m => { m.files.pop(); }],
    ['重复项', m => { m.files.push(Object.assign({}, m.files[0])); }],
    ['白名单外路径', m => { m.files[0].path = 'evil.js'; }],
    ['白名单不一致', m => { m.whitelist.push('extra.js'); }],
    ['schema 不符', m => { m.schema = 'other/1'; }],
    ['enabled 改 true', m => { m.entryState.enabled = true; }],
    ['动态值标记改 false', m => { m.entryState.dynamicValuesEmpty = false; }],
    ['自哈希声明被去掉', m => { delete m.packageVerification.manifestSelfHash; }]
  ];
  for (const [label, mutate] of cases) {
    const src = cloneSource(`r1-3-${label}-src`);
    const out = path.join(tmpDir(`r1-3-${label}`), 'closed');
    packager.buildPackage(pkg(src, out));
    const mp = path.join(out, 'manifest.json');
    const doc = JSON.parse(fs.readFileSync(mp, 'utf8'));
    mutate(doc);
    fs.writeFileSync(mp, JSON.stringify(doc, null, 2) + '\n');
    assert.throws(
      () => packager.buildPackage(pkg(src, out, { checkOnly: true })),
      /manifest 校验失败|既有关闭包与源或 manifest 不一致/,
      `${label} 必须被拒绝`
    );
  }
});

test('R1.4 基线缺失 / 坏 JSON / 字段不完整 → 停止且零产物', () => {
  const root = tmpDir('r1-4');
  // 缺失
  assert.throws(
    () => packager.buildPackage({ outDir: path.join(root, 'out-a'), baselinePath: path.join(root, 'none.json') }),
    /验收基线不可读/
  );
  assert.equal(fs.existsSync(path.join(root, 'out-a')), false, '缺基线时不得创建任何产物');
  // 坏 JSON
  fs.writeFileSync(path.join(root, 'bad.json'), '{ not json');
  assert.throws(
    () => packager.buildPackage({ outDir: path.join(root, 'out-b'), baselinePath: path.join(root, 'bad.json') }),
    /不是合法 JSON/
  );
  assert.equal(fs.existsSync(path.join(root, 'out-b')), false);
  // 缺 files 字典
  fs.writeFileSync(path.join(root, 'nofiles.json'), JSON.stringify({ date: 'x', fileCount: 1 }));
  assert.throws(
    () => packager.buildPackage({ outDir: path.join(root, 'out-c'), baselinePath: path.join(root, 'nofiles.json') }),
    /缺少 files 字典/
  );
  assert.equal(fs.existsSync(path.join(root, 'out-c')), false);
  // fileCount 非数字
  fs.writeFileSync(path.join(root, 'badfc.json'), JSON.stringify({ files: {}, fileCount: '1' }));
  assert.throws(
    () => packager.buildPackage({ outDir: path.join(root, 'out-d'), baselinePath: path.join(root, 'badfc.json') }),
    /字段不完整/
  );
  // 哈希格式非法
  fs.writeFileSync(path.join(root, 'badhash.json'), JSON.stringify({ fileCount: 1, files: { a: 'zz' } }));
  assert.throws(
    () => packager.buildPackage({ outDir: path.join(root, 'out-e'), baselinePath: path.join(root, 'badhash.json') }),
    /字段不完整/
  );
});

test('R1.5 基线与源不一致 → 停止，不自行修复', () => {
  const src = cloneSource('r1-5-src');
  // 构造一份键与临时源匹配的基线，内容取自真实源
  const real = JSON.parse(fs.readFileSync(packager.BASELINE_PATH, 'utf8'));
  const remapped = { fileCount: real.fileCount, files: {} };
  for (const rel of packager.PACKAGE_FILES) {
    const key = path.relative(packager.ROOT, path.join(src, rel)).split(path.sep).join('/');
    remapped.files[key] = sha256(fs.readFileSync(path.join(packager.SOURCE_DIR, rel)));
  }
  const baselinePath = path.join(tmpDir('r1-5'), 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify(remapped), 'utf8');

  // 未改动时通过
  const ok = packager.buildPackage({
    outDir: path.join(TMP_ROOT, 'r1-5-ok'),
    sourceDir: src,
    baselinePath,
    skipCandidateCheck: true
  });
  assert.equal(ok.baseline.checked, true);
  assert.equal(ok.baseline.matched, 8);

  // 改动一个 vendor 文件 → 阻断
  const target = path.join(src, 'vendor', 'service.js');
  fs.writeFileSync(target, Buffer.concat([fs.readFileSync(target), Buffer.from('\n// drift\n')]));
  assert.throws(
    () => packager.buildPackage({ outDir: path.join(TMP_ROOT, 'r1-5-bad'), sourceDir: src, baselinePath, skipCandidateCheck: true }),
    /与验收基线不一致[\s\S]*service\.js/,
    '基线差异必须阻断'
  );
});

test('R1.6 生成前存在额外文件 → 生成与 check 都拒绝，且零新增文件', () => {
  // package 子目录内额外文件
  {
    const src = cloneSource('r1-6a-src');
    const out = path.join(tmpDir('r1-6a'), 'closed');
    fs.mkdirSync(path.join(out, 'package'), { recursive: true });
    fs.writeFileSync(path.join(out, 'package', 'unexpected.txt'), 'x');
    assert.throws(() => packager.buildPackage(pkg(src, out)), /存在白名单外文件/);
    assert.equal(fs.existsSync(path.join(out, 'manifest.json')), false, '不得写 manifest');
    assert.equal(fs.existsSync(path.join(out, 'package', 'index.js')), false, '不得写包体文件');
    assert.throws(() => packager.buildPackage(pkg(src, out, { checkOnly: true })), /存在白名单外文件/);
  }
  // 制品目录顶层额外文件（检查整个目录，不只 package 子目录）
  {
    const src = cloneSource('r1-6b-src');
    const out = path.join(tmpDir('r1-6b'), 'closed');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'stray.txt'), 'x');
    assert.throws(() => packager.buildPackage(pkg(src, out)), /允许项之外的文件/);
    assert.equal(fs.existsSync(path.join(out, 'manifest.json')), false);
  }
});

test('R1.7 晚序文件冲突在预检阶段被发现 → 拒绝且文件数不变', () => {
  const src = cloneSource('r1-7-src');
  const out = path.join(tmpDir('r1-7'), 'closed');
  packager.buildPackage(pkg(src, out));
  // 篡改排在后面的 gate.js，制造「晚序冲突」
  fs.writeFileSync(
    path.join(out, 'package', 'gate.js'),
    Buffer.concat([fs.readFileSync(path.join(out, 'package', 'gate.js')), Buffer.from('x')])
  );
  const before = fs.readdirSync(path.join(out, 'package')).length;
  const manifestBefore = fs.readFileSync(path.join(out, 'manifest.json'), 'utf8');
  assert.throws(() => packager.buildPackage(pkg(src, out)), /既有产物包体与源不一致|既有关闭包与源或 manifest 不一致/);
  assert.equal(fs.readdirSync(path.join(out, 'package')).length, before, '不得新增文件');
  assert.equal(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'), manifestBefore, 'manifest 不得变化');
});

// ── S1：半成品无 manifest 的冲突预检零写 + 来源字段核对 ───────────────────

test('S1.1 半成品（无 manifest、缺 index.js、gate.js 内容不同）→ 预检拒绝且零写', () => {
  const src = cloneSource('s1-1-src');
  const out = path.join(tmpDir('s1-1'), 'closed');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  // 只放一个内容不同的 gate.js；**没有 manifest**，index.js 缺失
  fs.writeFileSync(
    path.join(out, 'package', 'gate.js'),
    Buffer.concat([fs.readFileSync(path.join(src, 'gate.js')), Buffer.from('x')])
  );
  const gateBefore = fs.readFileSync(path.join(out, 'package', 'gate.js'));

  assert.throws(
    () => packager.buildPackage(pkg(src, out)),
    /既有产物包体与源不一致/,
    '半成品冲突必须在预检被拒'
  );
  // 关键断言：拒绝后不得创建 index.js，也不得创建 manifest
  assert.equal(fs.existsSync(path.join(out, 'package', 'index.js')), false, 'index.js 不得被创建');
  assert.equal(fs.existsSync(path.join(out, 'manifest.json')), false, 'manifest 不得被创建');
  // 原 gate.js 必须原样保留（不覆盖、不删除）
  assert.ok(fs.readFileSync(path.join(out, 'package', 'gate.js')).equals(gateBefore), '原 gate.js 须原样保留');
  // 包体内文件数不变（仍只有 1 个）
  assert.equal(fs.readdirSync(path.join(out, 'package')).length, 1, '不得新增包体文件');
});

test('S1.2 半成品同长度内容篡改（hash 冲突）→ 预检拒绝且零写', () => {
  const src = cloneSource('s1-2-src');
  const out = path.join(tmpDir('s1-2'), 'closed');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  const original = fs.readFileSync(path.join(src, 'gate.js'));
  const tampered = Buffer.from(original);
  tampered[10] ^= 0xff; // 长度不变 → 走 hash 冲突分支
  assert.equal(tampered.length, original.length);
  fs.writeFileSync(path.join(out, 'package', 'gate.js'), tampered);

  assert.throws(() => packager.buildPackage(pkg(src, out)), /既有产物包体与源不一致/);
  assert.equal(fs.existsSync(path.join(out, 'package', 'index.js')), false, 'index.js 不得被创建');
  assert.equal(fs.existsSync(path.join(out, 'manifest.json')), false, 'manifest 不得被创建');
});

test('S1.3 manifest 来源字段（sourceDir / packageDir / sourceKey）被篡改 → 拒绝', () => {
  const cases = [
    ['sourceDir 指向旧 memberAccess', m => { m.sourceDir = 'miniapp/cloudfunctions/memberAccess'; }],
    ['sourceDir 删除', m => { delete m.sourceDir; }],
    ['packageDir 篡改', m => { m.packageDir = 'somewhere/else'; }],
    ['packageDir 删除', m => { delete m.packageDir; }],
    ['files[0].sourceKey 指向旧目录', m => { m.files[0].sourceKey = 'miniapp/cloudfunctions/memberAccess/index.js'; }],
    ['files[2].sourceKey 删除', m => { delete m.files[2].sourceKey; }],
    ['全部 sourceKey 改成同目录', m => { m.files.forEach(f => { f.sourceKey = 'x/y.js'; }); }]
  ];
  for (const [label, mutate] of cases) {
    const src = cloneSource(`s1-3-${label}-src`);
    const out = path.join(tmpDir(`s1-3-${label}`), 'closed');
    packager.buildPackage(pkg(src, out));
    const mp = path.join(out, 'manifest.json');
    const doc = JSON.parse(fs.readFileSync(mp, 'utf8'));
    mutate(doc);
    fs.writeFileSync(mp, JSON.stringify(doc, null, 2) + '\n');
    assert.throws(
      () => packager.buildPackage(pkg(src, out, { checkOnly: true })),
      /manifest sourceDir 与实际来源不符|manifest 缺少 sourceDir|manifest packageDir 与实际产物根不符|manifest 缺少 packageDir|manifest sourceKey 与实际来源不符|manifest 条目缺少 sourceKey/,
      `${label} 必须被拒绝`
    );
  }
});

test('S1.4 未篡改的 manifest 来源字段与实际计算值一致（正向确认）', () => {
  const src = cloneSource('s1-4-src');
  const out = path.join(tmpDir('s1-4'), 'closed');
  const result = packager.buildPackage(pkg(src, out));
  const doc = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const expectedSourceDir = path.relative(packager.ROOT, src).split(path.sep).join('/');
  const expectedPackageDir = path.relative(packager.ROOT, path.join(out, 'package')).split(path.sep).join('/');
  assert.equal(doc.sourceDir, expectedSourceDir);
  assert.equal(doc.packageDir, expectedPackageDir);
  for (const entry of result.files) {
    const row = doc.files.find(f => f.path === entry.path);
    assert.equal(row.sourceKey, entry.sourceKey, `${entry.path} 的 sourceKey 应与实际一致`);
  }
  // --check 同样通过
  assert.equal(packager.buildPackage(pkg(src, out, { checkOnly: true })).mode, 'check');
});

// ── S2：check 与生成统一拒绝白名单文件链接 ────────────────────────────────

test('S2.1 包体读点统一判链接：白名单文件为链接时 check 与生成都拒绝', t => {
  const src = cloneSource('s2-1-src');
  const out = path.join(tmpDir('s2-1'), 'closed');
  packager.buildPackage(pkg(src, out));

  const target = path.join(out, 'package', 'index.js');
  const original = fs.readFileSync(target);
  // 优先尝试真实文件符号链接；无权限则明确 skip，不冒充平台验证
  let realLinkCreated = false;
  try {
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(src, 'index.js'), target, 'file');
    realLinkCreated = true;
  } catch (error) {
    fs.copyFileSync(path.join(src, 'index.js'), target);
    t.diagnostic(`本机无法创建真实文件符号链接（${error.code}）：真实链接分支未验证，改用合成标记测试`);
  }

  if (realLinkCreated) {
    assert.throws(() => packager.buildPackage(pkg(src, out, { checkOnly: true })), /符号链接|链接条目/);
    assert.throws(() => packager.buildPackage(pkg(src, out)), /符号链接|链接条目/);
    return;
  }

  // 合成标记：仅把 readdir 的 Dirent 标成链接，保留真实字节。
  // 该测试只证明**控制流已覆盖**，不等于平台链接行为已验证。
  const realReaddir = fs.readdirSync;
  const realLstat = fs.lstatSync;
  fs.readdirSync = function patched(dir, ...rest) {
    const result = realReaddir.call(fs, dir, ...rest);
    if (Array.isArray(result) && result[0] && typeof result[0] === 'object' && String(dir).endsWith('package')) {
      return result.map(entry => (entry.name === 'index.js'
        ? Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, {
            isSymbolicLink: () => true,
            isFile: () => false
          })
        : entry));
    }
    return result;
  };
  fs.lstatSync = function patched(fp, ...rest) {
    const st = realLstat.call(fs, fp, ...rest);
    if (typeof fp === 'string' && fp.endsWith(path.join('package', 'index.js'))) {
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
        isSymbolicLink: () => true,
        isFile: () => false
      });
    }
    return st;
  };
  try {
    assert.throws(
      () => packager.buildPackage(pkg(src, out, { checkOnly: true })),
      /链接条目/,
      'check 模式必须拒绝白名单链接条目'
    );
    assert.throws(
      () => packager.buildPackage(pkg(src, out)),
      /链接条目/,
      '生成模式必须拒绝白名单链接条目'
    );
  } finally {
    fs.readdirSync = realReaddir;
    fs.lstatSync = realLstat;
  }
  assert.ok(original.length > 0);
});

test('S2.2 白名单子目录被 junction 替换 → 拒绝（真实 junction 实测）', t => {
  const src = cloneSource('s2-2-src');
  const out = path.join(tmpDir('s2-2'), 'closed');
  packager.buildPackage(pkg(src, out));
  const vendorDir = path.join(out, 'package', 'vendor');
  // 备份放到**样本输出目录之外**的专用临时根：否则 vendor-real 会成为
  // 「白名单外文件」，让断言被额外文件错误掩盖，测不到 junction 检查本身。
  const backupRoot = tmpDir('s2-2-backup');
  const realDir = path.join(backupRoot, 'vendor-real');
  fs.renameSync(vendorDir, realDir);
  assert.equal(fs.existsSync(path.join(out, 'package', 'vendor-real')), false, '备份不得留在输出目录内');
  const outside = path.join(backupRoot, 'elsewhere');
  fs.mkdirSync(outside, { recursive: true });
  try {
    fs.symlinkSync(outside, vendorDir, 'junction');
  } catch (error) {
    fs.renameSync(realDir, vendorDir);
    t.skip(`本机无法创建 junction（${error.code}）：该分支未验证`);
    return;
  }
  assert.equal(fs.lstatSync(vendorDir).isSymbolicLink(), true, 'junction 应被 lstat 标记');
  // 错误断言必须命中**链接本身**：备份已移出输出目录，因此「白名单外文件」只可能
  // 来自递归列举 junction 下的真实文件（父级会被标注为链接），不能来自备份残留。
  // 若删除链接防线，此处将不再抛错 → 测试失败。
  assert.throws(
    () => packager.buildPackage(pkg(src, out, { checkOnly: true })),
    /vendor（符号链接\/目录联接）/,
    '白名单子目录被 junction 替换必须因链接被拒绝（不得由备份文件残留掩盖）'
  );
  fs.unlinkSync(vendorDir);
  fs.renameSync(realDir, vendorDir);
});

test('S2.3 safeReadPackageFile：普通文件/字节差异/缺失/目录（非普通文件）', () => {
  const root = tmpDir('s2-3');
  fs.writeFileSync(path.join(root, 'real.js'), '// real\n', 'utf8');
  // 正常读取
  const ok = packager.safeReadPackageFile(root, 'real.js', { bytes: 8, sha256: sha256(fs.readFileSync(path.join(root, 'real.js'))) });
  assert.equal(ok.exists, true);
  // 字节不符
  const bad = packager.safeReadPackageFile(root, 'real.js', { bytes: 999, sha256: 'x' });
  assert.equal(bad.byteMismatch, true);
  // 缺失 → exists:false（尚未生成，不是拒绝）
  assert.equal(packager.safeReadPackageFile(root, 'missing.js').exists, false);
  // 目录不是普通文件 → 拒绝
  fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
  assert.throws(() => packager.safeReadPackageFile(root, 'dir'), /不是普通文件/);
});

// ── S1 回归修复：facts.missing 必须填充（有 manifest 缺文件 → 预检零写）─────

test('S1R.1 有 manifest 但包体缺文件 → 生成与检查均拒绝，且零写', () => {
  const src = cloneSource('s1r-1-src');
  const out = path.join(tmpDir('s1r-1'), 'closed');
  packager.buildPackage(pkg(src, out));
  // 只删 index.js，保留 manifest
  fs.unlinkSync(path.join(out, 'package', 'index.js'));
  const manifestBefore = fs.readFileSync(path.join(out, 'manifest.json'), 'utf8');
  const before = fs.readdirSync(path.join(out, 'package')).length;

  // 检查模式
  assert.throws(
    () => packager.buildPackage(pkg(src, out, { checkOnly: true })),
    /产物缺失|manifest 声明了但包体缺失/,
    'check 模式必须拒绝缺文件'
  );
  // 生成模式：这是本轮修复的回归点——此前会先补文件再因 manifest 冲突才失败
  assert.throws(
    () => packager.buildPackage(pkg(src, out)),
    /manifest 声明了但包体缺失/,
    '生成模式必须在任何写入前因缺文件被拒'
  );
  // 零写断言
  assert.equal(fs.existsSync(path.join(out, 'package', 'index.js')), false, 'index.js 不得被重建');
  assert.equal(fs.readdirSync(path.join(out, 'package')).length, before, '包体文件数不得变化');
  assert.equal(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'), manifestBefore, 'manifest 必须逐字节不变');
});

test('S1R.2 有 manifest 缺文件 + manifest 文本冲突 → 仍预检拒绝且零写', () => {
  const src = cloneSource('s1r-2-src');
  const out = path.join(tmpDir('s1r-2'), 'closed');
  packager.buildPackage(pkg(src, out));
  fs.unlinkSync(path.join(out, 'package', 'index.js'));
  // 再叠加 manifest 文本冲突（改 purpose）
  const mp = path.join(out, 'manifest.json');
  const doc = JSON.parse(fs.readFileSync(mp, 'utf8'));
  doc.purpose = '被人为改动的用途说明';
  fs.writeFileSync(mp, JSON.stringify(doc, null, 2) + '\n');
  const manifestBefore = fs.readFileSync(mp, 'utf8');
  const before = fs.readdirSync(path.join(out, 'package')).length;

  assert.throws(
    () => packager.buildPackage(pkg(src, out)),
    /manifest 声明了但包体缺失/,
    '缺文件应先于 manifest 文本冲突被报出，且不得先写文件'
  );
  assert.equal(fs.existsSync(path.join(out, 'package', 'index.js')), false, 'index.js 不得被创建');
  assert.equal(fs.readdirSync(path.join(out, 'package')).length, before, '包体文件数不得变化');
  assert.equal(fs.readFileSync(mp, 'utf8'), manifestBefore, '原 manifest 必须保持不变');
});

test('S1R.3 无 manifest 的合法半成品（内容正确的 gate.js）→ 仍可续建', () => {
  const src = cloneSource('s1r-3-src');
  const out = path.join(tmpDir('s1r-3'), 'closed');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  // 只放一个**内容正确**的 gate.js，没有 manifest
  fs.copyFileSync(path.join(src, 'gate.js'), path.join(out, 'package', 'gate.js'));
  const gateBefore = fs.readFileSync(path.join(out, 'package', 'gate.js'));

  const result = packager.buildPackage(pkg(src, out));
  assert.equal(result.mode, 'created', '合法半成品应能续建');
  assert.equal(fs.existsSync(path.join(out, 'manifest.json')), true, '续建后应写出 manifest');
  // 既有 gate.js 必须被复用且字节不变
  const gateReused = result.written.find(item => item.path === 'gate.js');
  assert.equal(gateReused.action, 'reused', '内容正确的既有文件应被复用');
  assert.ok(fs.readFileSync(path.join(out, 'package', 'gate.js')).equals(gateBefore), '既有 gate.js 不得被改写');
  // 全部 8 个白名单文件齐备
  for (const rel of packager.PACKAGE_FILES) {
    assert.ok(fs.existsSync(path.join(out, 'package', rel)), `续建后应存在 ${rel}`);
  }
  // --check 通过
  assert.equal(packager.buildPackage(pkg(src, out, { checkOnly: true })).mode, 'check');
});

test('S1R.4 缺文件清单来源：facts.missing 由实际读取结果填充', () => {
  // 直接验证实现分支：safeReadPackageFile 对缺失路径返回 exists:false，
  // 由 buildPackage 记入 facts.missing；无 manifest 时不因此拒绝。
  const src = cloneSource('s1r-4-src');
  const out = path.join(tmpDir('s1r-4'), 'closed');
  // 全新目录：无任何既有文件 → 8 个都缺，但无 manifest → 允许生成
  const result = packager.buildPackage(pkg(src, out));
  assert.equal(result.written.filter(i => i.action === 'created').length, 8);
  assert.equal(fs.existsSync(path.join(out, 'manifest.json')), true);

  // 删两个文件后：check 模式应逐个报缺失
  fs.unlinkSync(path.join(out, 'package', 'index.js'));
  fs.unlinkSync(path.join(out, 'package', 'gate.js'));
  assert.throws(
    () => packager.buildPackage(pkg(src, out, { checkOnly: true })),
    /index\.js[\s\S]*gate\.js|gate\.js[\s\S]*index\.js/,
    'check 应报出全部缺失文件'
  );
});

// ── S3：依赖版本/来源锁定 + 集合 created/ttlEnabled 显式 false ─────────────

test('S3.1 依赖版本与来源被改或删除 → 拒绝', () => {
  const cases = [
    ['wxServerSdk 改 999.0.0', d => { d.function.dependency.wxServerSdk = '999.0.0'; }],
    ['删除 wxServerSdk', d => { delete d.function.dependency.wxServerSdk; }],
    ['wxServerSdk 改 3.0.0', d => { d.function.dependency.wxServerSdk = '3.0.0'; }],
    ['packageJson 指向旧 memberAccess', d => { d.function.dependency.packageJson = 'miniapp/cloudfunctions/memberAccess/package.json'; }],
    ['删除 packageJson', d => { delete d.function.dependency.packageJson; }],
    ['installThisRound 改 true', d => { d.function.dependency.installThisRound = true; }]
  ];
  for (const [label, mutate] of cases) {
    const doc = candidateDoc();
    mutate(doc);
    assert.throws(
      () => packager.validateCandidateDocument(doc, [], 'mutated'),
      /资源候选清单校验失败/,
      `${label} 必须被拒绝`
    );
  }
});

test('S3.2 集合 created / ttlEnabled 必须显式为 false（缺失或改值都拒绝）', () => {
  const cases = [
    ['collections[0].created=true', d => { d.collections[0].created = true; }],
    ['删除 collections[0].created', d => { delete d.collections[0].created; }],
    ['删除 collections[3].created', d => { delete d.collections[3].created; }],
    ['删除 collections[0].ttlEnabled', d => { delete d.collections[0].ttlEnabled; }],
    ['collections[5].ttlEnabled=true', d => { d.collections[5].ttlEnabled = true; }],
    ['collections[7].ttlEnabled 改字符串', d => { d.collections[7].ttlEnabled = 'false'; }]
  ];
  for (const [label, mutate] of cases) {
    const doc = candidateDoc();
    mutate(doc);
    assert.throws(
      () => packager.validateCandidateDocument(doc, [], 'mutated'),
      /资源候选清单校验失败/,
      `${label} 必须被拒绝`
    );
  }
});

test('S3.3 依赖锁定与副本 package.json 实际版本一致（正向确认）', () => {
  const actual = JSON.parse(
    fs.readFileSync(path.join(packager.SOURCE_DIR, 'package.json'), 'utf8')
  );
  assert.equal(actual.dependencies['wx-server-sdk'], packager.APPROVED_DEPENDENCY.wxServerSdk);
  const doc = candidateDoc();
  assert.equal(doc.function.dependency.wxServerSdk, packager.APPROVED_DEPENDENCY.wxServerSdk);
  assert.equal(doc.function.dependency.packageJson, packager.APPROVED_DEPENDENCY.packageJson);
  // 清单中每个集合都显式声明了 created/ttlEnabled
  for (const item of doc.collections) {
    assert.equal(item.created, false, `${item.name}.created 应显式为 false`);
    assert.equal(item.ttlEnabled, false, `${item.name}.ttlEnabled 应显式为 false`);
  }
});

test('R1.8 候选清单错误在打包之前被发现 → 零新增文件', () => {
  const src = cloneSource('r1-8-src');
  const out = path.join(tmpDir('r1-8'), 'closed');
  const badCandidate = path.join(TMP_ROOT, 'r1-8', 'bad-candidate.json');
  const doc = candidateDoc();
  doc.indexes[0].id = 'I99';
  fs.writeFileSync(badCandidate, JSON.stringify(doc, null, 2), 'utf8');
  assert.throws(
    () => packager.buildPackage({ outDir: out, sourceDir: src, skipBaseline: true, candidatePath: badCandidate }),
    /资源候选清单校验失败/
  );
  assert.equal(fs.existsSync(out), false, '候选清单错误时不得创建输出目录');
});

test('R1.9 真实源目录当前与 110 文件基线完全一致（8 个白名单文件）', () => {
  const result = packager.buildPackage({
    outDir: path.join(TMP_ROOT, 'r1-9'),
    verifyBaselineOnRealSource: undefined,
    skipCandidateCheck: true
  });
  assert.equal(result.baseline.checked, true);
  assert.equal(result.baseline.matched, 8);
  assert.equal(result.baseline.fileCount, 110);
});

// ── R2：受信根路径 ────────────────────────────────────────────────────────

test('R2.1 受信根检查：输出根 / package 根 / 祖先为 junction → 拒绝且未写入', t => {
  const root = tmpDir('r2-1');
  const src = cloneSource('r2-1-src');

  // a) 输出根本身是 junction
  const actual = path.join(root, 'actual');
  fs.mkdirSync(actual, { recursive: true });
  const alias = path.join(root, 'alias');
  try {
    fs.symlinkSync(actual, alias, 'junction');
  } catch (error) {
    t.skip(`本机无法创建 junction：${error.code}`);
    return;
  }
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true, 'junction 应被 lstat 标记');
  assert.throws(() => packager.buildPackage(pkg(src, alias)), /符号链接\/目录联接/);
  assert.equal(fs.existsSync(path.join(actual, 'manifest.json')), false, '不得写入联接目标');

  // b) package 根是 junction
  const out2 = path.join(root, 'out2');
  fs.mkdirSync(out2, { recursive: true });
  const pkgActual = path.join(root, 'pkgActual');
  fs.mkdirSync(pkgActual, { recursive: true });
  fs.symlinkSync(pkgActual, path.join(out2, 'package'), 'junction');
  assert.throws(() => packager.buildPackage(pkg(src, out2)), /符号链接\/目录联接/);
  assert.equal(fs.existsSync(path.join(pkgActual, 'manifest.json')), false);

  // c) 祖先目录是 junction
  const realParent = path.join(root, 'realParent');
  fs.mkdirSync(realParent, { recursive: true });
  const aliasParent = path.join(root, 'aliasParent');
  fs.symlinkSync(realParent, aliasParent, 'junction');
  assert.throws(() => packager.buildPackage(pkg(src, path.join(aliasParent, 'out3'))), /符号链接\/目录联接/);
  assert.equal(fs.existsSync(path.join(realParent, 'out3', 'manifest.json')), false);
});

test('R2.2 输出根边界：与源重叠 / 仓库根 / 制品目录之外 → 拒绝', () => {
  const src = cloneSource('r2-2-src');
  // 与源目录重叠
  assert.throws(
    () => packager.buildPackage(pkg(src, src)),
    /与源目录重叠/
  );
  // 仓库根本身（同时也是源的祖先）
  assert.throws(() => packager.buildPackage(pkg(src, packager.ROOT)), /重叠|制品目录/);
  // 制品目录之外
  assert.throws(
    () => packager.buildPackage(pkg(src, path.join(packager.ROOT, 'miniapp', 'x'))),
    /必须位于仓库制品目录/
  );
});

test('R2.3 assertTrustedRoot 直接校验根与祖先', t => {
  const root = tmpDir('r2-3');
  const real = path.join(root, 'real');
  fs.mkdirSync(real, { recursive: true });
  assert.doesNotThrow(() => packager.assertTrustedRoot(real, '测试根'));
  const alias = path.join(root, 'alias');
  try {
    fs.symlinkSync(real, alias, 'junction');
  } catch (error) {
    t.skip(`本机无法创建 junction：${error.code}`);
    return;
  }
  assert.throws(() => packager.assertTrustedRoot(alias, '测试根'), /符号链接\/目录联接/);
  // 祖先是 junction 也拒绝（不存在的子路径会先被「不存在」拦下，同样是拒绝）
  assert.throws(
    () => packager.assertTrustedRoot(path.join(alias, 'child'), '测试根'),
    /符号链接\/目录联接|不存在/,
    '祖先为 junction 时不得通过'
  );
  // 已存在的祖先为 junction → 明确报链接
  fs.mkdirSync(path.join(real, 'child'), { recursive: true });
  assert.throws(
    () => packager.assertTrustedRoot(path.join(alias, 'child'), '测试根'),
    /符号链接\/目录联接/
  );
});

test('R2.4 相对路径字符串过滤仍然生效（绝对路径 / .. / 盘符 / 反斜杠）', () => {
  const bad = ['/etc/passwd', 'C:/Windows', '..\\..\\x.js', '../x.js', 'a/../../x.js', './index.js', 'vendor//x.js', 'vendor\\x.js', ''];
  for (const rel of bad) {
    assert.throws(() => packager.assertSafeRelative(rel), /./, `应拒绝：${rel}`);
  }
  assert.doesNotThrow(() => packager.assertSafeRelative('vendor/service.js'));
});

// ── 关闭包正确性（沿用并加强）─────────────────────────────────────────────

test('PKG.1 生成关闭包：8 文件逐字节一致、manifest 无自身哈希、重复运行复用', () => {
  const src = packager.SOURCE_DIR;
  const out = path.join(tmpDir('pkg-1'), 'closed');
  const first = packager.buildPackage({
    outDir: out,
    skipCandidateCheck: true
  });
  assert.equal(first.files.length, 8);
  assert.equal(first.extraFiles, 0);
  assert.equal(first.entryState.enabled, false);
  assert.equal(first.entryState.dynamicValuesEmpty, true);
  assert.equal(first.entryState.allowedUserIdsEmpty, true);

  for (const entry of first.files) {
    const onDisk = fs.readFileSync(path.join(out, 'package', entry.path));
    assert.equal(onDisk.length, entry.bytes);
    assert.equal(sha256(onDisk), entry.sha256);
    assert.ok(onDisk.equals(fs.readFileSync(path.join(src, entry.path))), `${entry.path} 与源不逐字节一致`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.packageVerification.manifestSelfHash, 'omitted-by-design');
  assert.equal(manifest.schema, packager.MANIFEST_SCHEMA);
  assert.equal(manifest.files.length, 8);

  // 重复运行：全部复用，manifest 不重写
  const mtime = fs.statSync(path.join(out, 'manifest.json')).mtimeMs;
  const second = packager.buildPackage({ outDir: out, skipCandidateCheck: true });
  assert.equal(second.mode, 'reused');
  assert.ok(second.written.every(i => i.action === 'reused'));
  assert.equal(fs.statSync(path.join(out, 'manifest.json')).mtimeMs, mtime);
  // --check 通过
  assert.equal(packager.buildPackage({ outDir: out, skipCandidateCheck: true, checkOnly: true }).mode, 'check');
});

test('PKG.2 白名单固定 8 项，不含 node_modules / 凭据 / 日志 / 历史证据', () => {
  assert.equal(packager.PACKAGE_FILES.length, 8);
  for (const forbidden of ['node_modules', '.env', 'logs', 'docs', 'evidence']) {
    assert.ok(!packager.PACKAGE_FILES.some(i => i.includes(forbidden)), `白名单含禁止项 ${forbidden}`);
  }
  for (const required of ['node_modules', '.env', 'logs', 'docs/证据']) {
    assert.ok(packager.EXCLUDED_PATTERNS.includes(required), `排除项缺少 ${required}`);
  }
  // 排除项在读文件前先判：
  //  1) 作为路径段的项（node_modules / .env / logs / .tmp）
  for (const pattern of ['node_modules', '.env', 'logs', '.tmp']) {
    assert.throws(
      () => packager.readSource(`vendor/${pattern}/x.js`, packager.SOURCE_DIR),
      /命中排除项/,
      `应拒绝路径段 ${pattern}`
    );
  }
  //  2) 含斜杠的整条目（docs/证据）——作为整条目直接传入时命中
  assert.throws(
    () => packager.readSource('docs/证据', packager.SOURCE_DIR),
    /命中排除项/,
    '应拒绝整条目 docs/证据'
  );
  //  3) 未登记的白名单路径走「缺少源文件」而不是被排除
  assert.throws(
    () => packager.readSource('not-in-whitelist.js', packager.SOURCE_DIR),
    /缺少白名单源文件/
  );
});

test('PKG.3 关闭包内入口在关闭态拒绝且零数据库访问（合成依赖，非实际 SDK）', async () => {
  const out = path.join(tmpDir('pkg-3'), 'closed');
  packager.buildPackage({ outDir: out, skipCandidateCheck: true });
  const packageEntry = path.join(out, 'package', 'index.js');
  const source = fs.readFileSync(packageEntry, 'utf8');
  let databaseCalls = 0;
  const shim = {
    init() {},
    DYNAMIC_CURRENT_ENV: 'sandbox-package-test',
    getWXContext: () => ({ APPID: 'wxfb4db1615ac15531', OPENID: 'openid-under-test' }),
    database() { databaseCalls++; throw new Error('关闭态不得建立数据库连接'); }
  };
  const nativeRequire = createRequire(packageEntry);
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,process,console){${source}\n})`, {
    filename: 'sandbox-closed-package-index.js'
  })(name => (name === 'wx-server-sdk' ? shim : nativeRequire(name)), mod, mod.exports,
    { env: { TCB_ENV: 'cloud1-d8gcq5ag39d847723' } }, { error() {}, log() {} });

  for (const action of ['identify', 'listMyProjects', 'createProject', 'createSchedule']) {
    const result = await mod.exports.main({ action });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SANDBOX_DISABLED');
  }
  assert.equal(databaseCalls, 0, '关闭态必须零数据库访问');
  // 边界：这是合成依赖结论
  assert.ok(!('cloud' in global), '未向全局注入任何真实 SDK');
});

test('PKG.4 入口被开启或填入动态值 → 拒绝生成关闭包', () => {
  const cases = [
    ['enabled 改 true', 'enabled: false,', 'enabled: true,', /enabled 不是字面量 false/],
    ['appId 填入', "appId: '',", "appId: 'wxfb4db1615ac15531',", /动态值/],
    ['envId 填入', "envId: '',", "envId: 'cloud1-d8gcq5ag39d847723',", /动态值/],
    ['projectId 填入', "projectId: '',", "projectId: 'p_x',", /动态值/],
    ['roundId 填入', "roundId: '',", "roundId: 'r1',", /动态值/],
    ['expiresAt 填入', "expiresAt: '',", "expiresAt: '2030-01-01T00:00:00Z',", /动态值/],
    ['marker 填入', "projectReadyMarker: ''", "projectReadyMarker: 'm1'", /动态值/],
    ['允许名单填入', 'allowedUserIds: [],', 'allowedUserIds: ["u_x"],', /允许名单为空/]
  ];
  for (const [label, from, to, expected] of cases) {
    const src = cloneSource(`pkg-4-${label}`);
    const target = path.join(src, 'index.js');
    const text = fs.readFileSync(target, 'utf8');
    assert.ok(text.includes(from), `入口未找到片段：${from}`);
    fs.writeFileSync(target, text.replace(from, to), 'utf8');
    assert.throws(
      () => packager.buildPackage(pkg(src, path.join(TMP_ROOT, `pkg-4-out-${label}`))),
      expected,
      `${label} 必须被拒绝`
    );
  }
});

test('PKG.5 入口结构变化到无法定位配置块 → 拒绝，不猜测', () => {
  assert.throws(
    () => packager.assertEntryClosed('exports.main = async () => ({ ok: true });'),
    /入口结构已变化/
  );
});

// ── R4：源码契约断言（只读，不改业务）────────────────────────────────────

test('R4.1 Page 的动作列表不含 removeMember：picker 不可选，仅客户端方法可承载', () => {
  const page = fs.readFileSync(
    path.join(REPO_SRC, 'miniprogram/pages/schedule-sandbox/schedule-sandbox.js'), 'utf8'
  );
  const block = /const ACTIONS = \[([\s\S]*?)\n\];/.exec(page);
  assert.ok(block, '未能定位 Page ACTIONS');
  const keys = (block[1].match(/key: '([a-zA-Z]+)'/g) || []).map(s => /'([a-zA-Z]+)'/.exec(s)[1]);
  assert.ok(keys.length > 0, 'ACTIONS 解析为空');
  assert.equal(keys.includes('removeMember'), false, 'Page 动作列表不得包含 removeMember');
  // buildPayload 里的 removeMember 分支存在，但页面无法选中该动作
  assert.ok(/action === 'removeMember'/.test(page), 'buildPayload 应仍有 removeMember 分支');
  // 客户端仍登记该动作，供后续受审驱动调用
  const client = fs.readFileSync(
    path.join(REPO_SRC, 'miniprogram/utils/schedule-sandbox-client.js'), 'utf8'
  );
  assert.ok(/KNOWN_ACTIONS = Object\.freeze\(\[([\s\S]*?)removeMember/.test(client), '客户端应仍登记 removeMember');
  assert.ok(/NON_IDEMPOTENT_ACTIONS = Object\.freeze\(\[([\s\S]*?)removeMember/.test(client),
    'removeMember 应仍属非幂等动作');
});

test('R4.2 getScheduleContext 公开返回不含 activeScheduleIds 等 guard 字段', () => {
  const svc = fs.readFileSync(
    path.join(packager.SOURCE_DIR, 'vendor/schedule-service.js'), 'utf8'
  );
  const idx = svc.indexOf('getScheduleContext');
  assert.ok(idx >= 0, '未找到 getScheduleContext');
  const segment = svc.slice(idx, idx + 1400);
  const keys = [...new Set([...segment.matchAll(/\n {6}([a-zA-Z]+):/g)].map(m => m[1]))];
  assert.ok(keys.length > 0, '未能解析返回键');
  assert.equal(keys.includes('activeScheduleIds'), false, '公开上下文不得返回 activeScheduleIds');
  assert.equal(keys.includes('fenceVersion'), false, '公开上下文不得返回围栏字段');
  // 至少应含项目与权限判定所需字段
  assert.ok(keys.includes('project'), '公开上下文应含 project');
});

test('R4.3 resolvePendingAfterExternalCheck 保留 envelope 并标记 writeLocked（不是解锁工具）', () => {
  const client = fs.readFileSync(
    path.join(REPO_SRC, 'miniprogram/utils/schedule-sandbox-client.js'), 'utf8'
  );
  const idx = client.indexOf('function resolvePendingAfterExternalCheck');
  assert.ok(idx >= 0, '未找到 resolvePendingAfterExternalCheck');
  const segment = client.slice(idx, idx + 1500);
  assert.ok(/writeLocked/.test(segment), '人工核对标记后必须仍标记 writeLocked');
  assert.ok(!/clearEnvelope\(/.test(segment.split('function ')[1] || ''), '该路径不得直接清除 envelope');
});

// ── R5：P4 前置与驱动载体的文档契约 ──────────────────────────────────────

test('R5.1 操作稿：P4 前置不含「项目 ID 已登记」，并发/移出按不可达与未验证表述', () => {
  const doc = fs.readFileSync(
    path.join(packager.ROOT, 'docs/独立副本有限测试操作稿-20261005.md'), 'utf8'
  );
  // 去掉「引述原错误表述」的说明段落后再检查前置条件
  // 注意用 '## 5.' 之后必须带空格，避免误匹配 '## 5.' 形式的其它标题
  const p4Start = doc.indexOf('## 4. ');
  const p5Start = doc.indexOf('\n## 5. ');
  assert.ok(p4Start >= 0 && p5Start > p4Start, '未找到 P4 章节边界');
  const p4Section = doc.slice(p4Start, p5Start);
  const p4Preconditions = p4Section.slice(p4Section.indexOf('### 4.1'));
  assert.ok(p4Preconditions.length > 0, '未找到 P4 前置小节');
  // 只检查**编号前置列表**本身：上文「原 §4.2 要求…」是引述被更正前的表述，不算前置条件
  const listMatch = /只要求：\n([\s\S]*?)\n\n/.exec(p4Preconditions);
  assert.ok(listMatch, '未找到 P4 编号前置列表');
  const preconditionList = listMatch[1];
  assert.equal(
    /项目 ID 已登记|项目ID已登记|已创建项目/.test(preconditionList),
    false,
    `P4 前置列表不得要求已登记/已创建的项目：${preconditionList}`
  );
  assert.ok(/已核实环境/.test(preconditionList), 'P4 前置应含已核实环境/AppID');
  assert.ok(/本人在微信|本人微信/.test(preconditionList) || /identify/.test(preconditionList),
    'P4 前置应含本人微信 identify');
  assert.ok(/primary/.test(preconditionList), 'P4 前置应含 primary 不存在的只读确认');
  assert.ok(
    /不需要已创建项目 ID/.test(p4Preconditions),
    'P4 应显式说明不依赖尚未创建的项目'
  );
  assert.ok(/此时项目尚未建立/.test(p4Preconditions), 'P4 应说明此时项目尚未建立');
  // 审计可记录 projectId: null
  assert.ok(/projectId`（此时为 `null`）/.test(p4Section), '初始化审计应允许 projectId 为 null');
  // 并发须写明当前不可达
  assert.ok(/当前不可达/.test(doc), '操作稿须写明真实并发当前不可达');
  // removeMember 须写明页面不可选
  assert.ok(/removeMember[\s\S]{0,300}不可选|不可选[\s\S]{0,300}removeMember/.test(doc),
    '操作稿须写明 removeMember 在页面不可选');
  // 移出公开上下文不含 guard
  assert.ok(/activeScheduleIds/.test(doc), '操作稿须说明公开上下文不返回该字段');
  // 人工核对标记不是解锁工具
  assert.ok(/不是解锁工具/.test(doc), '操作稿须写明人工核对标记不是解锁工具');
  // 驱动载体未成立
  assert.ok(/运行载体未成立/.test(doc), '操作稿须说明驱动运行载体未成立');
  assert.ok(/暂不批准/.test(doc), '操作稿须照录暂不批准 Node 测试文件作为真机并发载体');
  // 差异表存在
  assert.ok(/prepare[\s\S]*execute[\s\S]*closed/i.test(doc), '须含 prepare/execute/closed 差异表');
  assert.ok(/config\/schedule-sandbox-proof\.js/.test(doc), '差异表须覆盖前端配置');
  // 不预填真实执行值：不得出现完整 userId 形态或真实项目 ID
  assert.equal(/u_[0-9a-f]{40}/.test(doc), false, '操作稿不得预填完整 userId');
  assert.equal(/p_[0-9a-f]{32}/.test(doc), false, '操作稿不得预填项目 ID');
  assert.equal(/wxfb4db1615ac15531/.test(doc), false, '操作稿不得预填 AppID');
  assert.equal(/cloud1-d8gcq5ag39d847723/.test(doc), false, '操作稿不得预填环境 ID');
});
