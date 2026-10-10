'use strict';
/**
 * 本人登记完整测试包与关闭包：本地组装器测试
 * =============================================
 *
 * 范围：只验证 `assemble-sandbox-registration.cjs` 的**本地组装**行为。
 * 不重开 R1–R5、管理员接线、P4、SDK/凭据链与旧打包器；不改动任何源文件。
 *
 * 关键性质：
 *  - 真实调用已验收的 `reg.buildRegistration` / `reg.checkRegistration` 与本轮组装器，
 *    不以手写算法冒充生成或检查；
 *  - 反例一律断言**目录快照不变**（零新增、零覆盖、零修补）；
 *  - 两份完整项目用其中的**实际 App / Page / client 及依赖**执行合成链，
 *    wx、云函数与存储都是合成对象 —— **不是**真实 SDK 或平台验证；
 *  - 夹具只清理测试自己新建、且已验证绝对路径位于制品根内的目录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Module = require('node:module');

const reg = require('../scripts/package-sandbox-registration.cjs');
const asm = require('../scripts/assemble-sandbox-registration.cjs');

const FIXED = reg.FIXED_TARGET;
const SYNTH_OPENID = 'synthetic-assembly-openid';
const SYNTH_NOW_MS = Date.parse('2026-01-01T00:05:00.000Z');
const ARTIFACTS_ROOT = path.resolve(asm.ARTIFACTS_ROOT);

/** 由可信 APPID/OPENID 派生 userId —— 与 vendor/service.js 同一算法。 */
function deriveUserId(openid) {
  const h = crypto.createHash('sha256').update(`${FIXED.appId}:${openid}`).digest('hex');
  return `u_${h.slice(0, 40)}`;
}

/** 合成计划：固定窗口保证离线可复跑，synthetic=true 不会被当作真实写批准。 */
function syntheticPlan(patch = {}) {
  return {
    purpose: 'synthetic-full-assembly-only',
    appId: FIXED.appId,
    envId: FIXED.envId,
    region: FIXED.region,
    functionName: FIXED.functionName,
    allowedUserIds: [deriveUserId(SYNTH_OPENID)],
    roundId: 'SYNTH-ASM-0001',
    windowStartsAt: '2026-01-01T00:00:00.000Z',
    windowExpiresAt: '2026-01-01T00:20:00.000Z',
    sourceVersion: reg.REVIEWED_SOURCE_VERSION,
    synthetic: true,
    ...patch
  };
}

function freshId(prefix = 'asm') {
  return prefix + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

function snapshotTree(dir) {
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  function walk(cur, prefix) {
    for (const name of fs.readdirSync(cur).sort()) {
      const rel = prefix ? prefix + '/' + name : name;
      const abs = path.join(cur, name);
      const st = fs.lstatSync(abs);
      // junction/符号链接本身即是被测对象：记录类型，不递归进入，也不按文件读取
      if (st.isSymbolicLink()) { rows.push(rel + ':link'); continue; }
      if (st.isDirectory()) { rows.push(rel + '/'); walk(abs, rel); continue; }
      if (!st.isFile()) { rows.push(rel + ':special'); continue; }
      const buf = fs.readFileSync(abs);
      rows.push(rel + ':' + buf.length + ':' + asm.sha256Buffer(buf));
    }
  }
  walk(dir, '');
  return rows;
}

/** 只清理测试自己新建、且绝对路径确在制品根内的目录。 */
function cleanup(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(ARTIFACTS_ROOT + path.sep)) {
    throw new Error('拒绝清理夹具根之外的路径：' + resolved);
  }
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

/** 真实调用已验收生成器产出一个合成登记制品，作为组装输入。 */
function buildRegistrationInput(plan = syntheticPlan()) {
  const outId = freshId('regin');
  const r = reg.buildRegistration(plan, { outId, nowMs: SYNTH_NOW_MS });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  return { dir: r.dir, plan, outId };
}

function assemble(input, options = {}) {
  return asm.buildAssembly({
    inputDir: input.dir,
    plan: input.plan,
    nowMs: SYNTH_NOW_MS,
    ...options
  });
}

/** 完整组装一次，返回两份项目路径；测试结束自动清理。支持异步回调。 */
async function withAssembly(fn, options = {}) {
  const input = buildRegistrationInput(options.plan);
  const result = assemble(input, options.assemblyOptions);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const registration = path.join(result.dir, asm.REGISTRATION_ROOT);
  const closed = path.join(result.dir, asm.CLOSED_ROOT);
  try {
    return await fn({ input, result, registration, closed, dir: result.dir });
  } finally {
    cleanup(result.dir);
    cleanup(input.dir);
  }
}

/**
 * 断言一次预检失败：固定错误码、零写、目录快照不变。
 * 本函数**只清理自己新建的目录**（已验证绝对路径在制品根内），不碰其他夹具。
 */
function expectBuildZeroWrite(input, options = {}) {
  const id = options.outId === undefined ? freshId('asmzero') : options.outId;
  const dir = asm.resolveOutDir(id);
  const before = snapshotTree(dir);
  try {
    const r = asm.buildAssembly({
      inputDir: input.dir, plan: options.plan || input.plan, outId: id, nowMs: SYNTH_NOW_MS
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.wroteFiles, false);
    assert.deepEqual(snapshotTree(dir), before, '预检失败必须零新增、零覆盖');
    return r;
  } finally {
    cleanup(dir);
  }
}

function expectCheckZeroWrite(dir, options = {}) {
  const before = snapshotTree(dir);
  const r = asm.checkAssembly({ inputDir: options.inputDir, outDir: dir, plan: options.plan });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.wroteFiles, false);
  assert.deepEqual(snapshotTree(dir), before, '检查失败不得写入或修补');
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// 分组 1：两份完整项目的文件集、依赖闭包与逐字节来源
// ═══════════════════════════════════════════════════════════════════════════
test('L1 两份项目各含完整文件集，唯一页面入口，云函数目录名为 scheduleSandbox', async () => {
  await withAssembly(({ result, registration, closed }) => {
    assert.equal(result.projects === undefined, true);
    for (const root of [registration, closed]) {
      const top = fs.readdirSync(root).sort();
      assert.deepEqual(top, ['cloudfunctions', 'miniprogram', 'project.config.json']);
      // 云函数目录名即函数名，不得是源目录名 package
      assert.deepEqual(fs.readdirSync(path.join(root, 'cloudfunctions')).sort(), [asm.CLOUD_FUNCTION_NAME]);
      const appJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
      assert.deepEqual(appJson.pages, [asm.ONLY_PAGE], '唯一页面入口');
      // 唯一页面的四个文件齐全
      for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
        assert.ok(fs.existsSync(path.join(root, 'miniprogram', asm.ONLY_PAGE + ext)), '缺 ' + ext);
      }
    }
    // 不含 access 与旧业务页面
    for (const root of [registration, closed]) {
      const pages = fs.readdirSync(path.join(root, 'miniprogram/pages')).sort();
      assert.deepEqual(pages, ['schedule-sandbox'], '不得混入旧业务页面');
      assert.equal(fs.existsSync(path.join(root, 'miniprogram/pages/access')), false);
    }
  });
});

test('L1 两份项目各 24 个文件，恰好等于声明文件集，无额外条目', async () => {
  await withAssembly(({ registration, closed }) => {
    for (const root of [registration, closed]) {
      const found = [];
      (function walk(cur, prefix) {
        for (const name of fs.readdirSync(cur).sort()) {
          const abs = path.join(cur, name);
          if (fs.lstatSync(abs).isDirectory()) walk(abs, prefix ? prefix + '/' + name : name);
          else found.push(prefix ? prefix + '/' + name : name);
        }
      })(root, '');
      assert.equal(found.length, asm.PROJECT_FILES.length, '项目文件数');
      assert.deepEqual(found.sort(), asm.PROJECT_FILES.slice().sort());
    }
  });
});

test('L1 前端依赖闭包在制品内全部可解析，无 npm/未知依赖', async () => {
  await withAssembly(({ result }) => {
    const c = result.dependencyClosure;
    assert.equal(c.externalRequires, 0, '不得有前端外部依赖');
    assert.equal(c.unresolved, 0);
    assert.ok(c.edges > 0, '应解析出真实依赖边');
    // 实际把每个相对 require 目标在磁盘上确认存在（纯 posix 解析，与组装器同口径）
    const posix = path.posix;
    for (const rel of c.sortedFiles) {
      if (!rel.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(result.dir, asm.REGISTRATION_ROOT, rel), 'utf8');
      for (const m of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        let target = posix.normalize(posix.join(posix.dirname(rel), m[1]));
        if (!posix.extname(target)) target += '.js';
        assert.ok(c.sortedFiles.includes(target),
          '依赖未纳入制品：' + rel + '→' + m[1]);
      }
    }
    // 云函数不参与前端闭包（Node 侧平台依赖，本轮不安装）
    assert.equal(c.sortedFiles.some(f => f.startsWith('cloudfunctions/')), false);
  });
});

test('L1 八文件服务端各与正确输入逐字节匹配：登记取登记制品、关闭取受审关闭包', async () => {
  await withAssembly(({ input, result, registration, closed }) => {
    const closedDesc = reg.describeClosedPackage();
    for (const rel of reg.PACKAGE_FILES) {
      const regBytes = fs.readFileSync(path.join(registration, 'cloudfunctions/scheduleSandbox', rel));
      const closedBytes = fs.readFileSync(path.join(closed, 'cloudfunctions/scheduleSandbox', rel));
      assert.ok(regBytes.equals(fs.readFileSync(path.join(input.dir, 'package', rel))),
        '登记版服务端不符：' + rel);
      const pinned = reg.PINNED_FACTS['miniapp/cloudfunctions/scheduleSandbox/' + rel];
      assert.equal(closedBytes.length, pinned.bytes, '关闭版字节数：' + rel);
      assert.equal(asm.sha256Buffer(closedBytes), pinned.sha256, '关闭版哈希：' + rel);
    }
    // 关闭包描述本身来自受审校验
    assert.equal(closedDesc.dir, asm.CLOSED_DIR);
    assert.equal(closedDesc.entryState.enabled, false);
    // 覆盖目录不得混入云函数
    for (const root of [registration, closed]) {
      const names = [];
      (function walk(cur, prefix) {
        for (const n of fs.readdirSync(cur)) {
          const abs = path.join(cur, n);
          if (fs.lstatSync(abs).isDirectory()) walk(abs, prefix ? prefix + '/' + n : n);
          else names.push(prefix ? prefix + '/' + n : n);
        }
      })(path.join(root, 'cloudfunctions'), '');
      assert.equal(names.some(n => n.includes('frontend')), false, '覆盖目录不得进云函数');
      assert.equal(names.some(n => n.startsWith('package/')), false);
    }
  });
});

test('L1 前后端包差异面精确：仅登记覆盖、index.js、gate.js 三项', async () => {
  await withAssembly(({ registration, closed, result }) => {
    const differing = [];
    for (const rel of asm.PROJECT_FILES) {
      const a = fs.readFileSync(path.join(registration, rel));
      const b = fs.readFileSync(path.join(closed, rel));
      if (!a.equals(b)) differing.push(rel);
    }
    assert.deepEqual(differing.sort(), [
      'cloudfunctions/scheduleSandbox/gate.js',
      'cloudfunctions/scheduleSandbox/index.js',
      'miniprogram/config/schedule-sandbox-proof.js'
    ]);
    assert.deepEqual(result.projectDelta.slice().sort(), differing.sort());
    // 前端差异只来自既有覆盖，不改客户端与驱动开关
    const clientA = fs.readFileSync(path.join(registration, 'miniprogram/utils/schedule-sandbox-client.js'));
    const clientB = fs.readFileSync(path.join(closed, 'miniprogram/utils/schedule-sandbox-client.js'));
    assert.ok(clientA.equals(clientB), '不得修改客户端');
    const driverProof = fs.readFileSync(path.join(registration, 'miniprogram/config/sandbox-test-driver-proof.js'), 'utf8');
    assert.match(driverProof, /enabled:\s*false/, '旧前端驱动开关保持关闭');
  });
});

test('L1 app.json 为受控变换：保留 window、收窄 pages，仓库源九路由未改', async () => {
  await withAssembly(({ registration }) => {
    const artifact = JSON.parse(fs.readFileSync(path.join(registration, 'miniprogram/app.json'), 'utf8'));
    const source = JSON.parse(fs.readFileSync(path.join(asm.MINIPROGRAM_SRC, 'app.json'), 'utf8'));
    assert.deepEqual(artifact.window, source.window, 'window 必须原样保留');
    assert.deepEqual(source.pages, asm.SOURCE_PAGES, '源九路由未改');
    assert.deepEqual(source.pages.length, 9);
    // 仓库源文件字节未变
    const src = fs.readFileSync(path.join(asm.MINIPROGRAM_SRC, 'app.json'));
    assert.equal(asm.sha256Buffer(src), asm.PINNED_APP_FILES['miniapp/miniprogram/app.json'].sha256);
  });
});

test('L1 project.config.json 固定投影：AppID/compileType/双根固定，无 private config', async () => {
  await withAssembly(({ registration }) => {
    const pc = JSON.parse(fs.readFileSync(path.join(registration, 'project.config.json'), 'utf8'));
    assert.equal(pc.appid, 'wxfb4db1615ac15531');
    assert.equal(pc.compileType, 'miniprogram');
    assert.equal(pc.miniprogramRoot, 'miniprogram/');
    assert.equal(pc.cloudfunctionRoot, 'cloudfunctions/');
    for (const key of asm.PROJECT_SETTING_KEYS) assert.ok(key in pc.setting, '缺编译设置 ' + key);
    const text = JSON.stringify(pc);
    assert.equal(text.includes('private'), false, '不得混入 private config');
    assert.equal(fs.existsSync(path.join(registration, 'project.private.config.json')), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 分组 2：非法输入与漂移按既有契约拒绝，且零写
// ═══════════════════════════════════════════════════════════════════════════
test('L2 组装前拒绝非法计划：真实计划、多用户、来源漂移、过期窗口，占位符', () => {
  const input = buildRegistrationInput();
  try {
    const cases = [
      ['真实计划不获组装放行', syntheticPlan({ synthetic: false })],
      ['多用户', syntheticPlan({ allowedUserIds: [deriveUserId(SYNTH_OPENID), deriveUserId(SYNTH_OPENID)] })],
      ['来源漂移', syntheticPlan({ sourceVersion: 'unverified-source-label' })],
      ['占位符轮次', syntheticPlan({ roundId: '待定' })],
      ['窗口超长', syntheticPlan({ windowExpiresAt: '2026-01-01T01:00:00.000Z' })],
      ['目标不符', syntheticPlan({ envId: 'cloud-other' })]
    ];
    for (const [label, plan] of cases) {
      const r = expectBuildZeroWrite(input, { plan, outId: freshId('asmplan') });
      // 非法计划可能在生成器的受审校验（REG_*）或组装器自身校验（ASM_*）处停止；
      // 两者都是写入前失败，关键是零写与固定错误码，不放宽生成器契约。
      assert.match(r.problems[0].code, /^(ASM_|REG_)/, label + ' → ' + JSON.stringify(r.problems));
      assert.equal(typeof r.problems[0].detail, 'string');
    }
    // 真实计划另有专门拒绝。组装器自身用合成时钟判定，因此这里传入当前时间之后
    // 的合法窗口，确保拒绝点是「合成限定」而不是更早的窗口有效性检查。
    const realId = freshId('asmreal');
    const realDir = asm.resolveOutDir(realId);
    const beforeReal = snapshotTree(realDir);
    const realNow = Date.now();
    const startIso = new Date(realNow + 60000).toISOString();
    const endIso = new Date(realNow + 20 * 60000).toISOString();
    const real = asm.buildAssembly({
      inputDir: input.dir,
      plan: syntheticPlan({
        synthetic: false,
        allowedUserIds: ['u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4'],
        windowStartsAt: startIso,
        windowExpiresAt: endIso
      }),
      outId: realId,
      nowMs: realNow
    });
    assert.equal(real.ok, false, '真实计划不得被组装放行');
    // 该计划窗口合法、未过期且用户为固定本人，拒绝点必须是组装器的合成限定
    assert.equal(real.problems[0].code, asm.ERR.PLAN_SYNTHETIC_ONLY, JSON.stringify(real.problems));
    assert.equal(real.wroteFiles, false);
    assert.deepEqual(snapshotTree(realDir), beforeReal);
  } finally { cleanup(input.dir); }
});

test('L2 组装前拒绝输入漂移：登记制品被改字节后 checkRegistration 停止，零写', () => {
  const input = buildRegistrationInput();
  try {
    const target = path.join(input.dir, 'package/gate.js');
    const original = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n// drift')]));
    try {
      const r = expectBuildZeroWrite(input, { outId: freshId('asmdrift') });
      assert.equal(r.problems[0].code, asm.ERR.INPUT_REJECTED);
    } finally { fs.writeFileSync(target, original); }
    // 还原后同一输入可正常组装
    const dir = asm.resolveOutDir(freshId('asmok'));
    try {
      const ok = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: SYNTH_NOW_MS });
      assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    } finally { cleanup(dir); }
  } finally { cleanup(input.dir); }
});

test('L2 组装前拒绝缺失输入与非法来源目录，不扫描目录自动取最新包', () => {
  const missing = asm.checkAssembly({ inputDir: null, outDir: asm.resolveOutDir(freshId('asmmiss')) });
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].code, asm.ERR.INPUT_MISSING);
  // 非 registration- 前缀目录（含仓库其他目录）一律拒绝
  const bad = asm.checkAssembly({ inputDir: asm.ROOT, outDir: asm.resolveOutDir(freshId('asmbad')) });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].code, asm.ERR.INPUT_INVALID);
});

test('L2 输出目录不可逃逸：非法编号、非制品根、与既有制品重叠均拒绝', () => {
  const input = buildRegistrationInput();
  const dir = asm.resolveOutDir(freshId('asmov'));
  try {
    // 非法编号：路径逃逸、大写、空串
    assert.throws(() => asm.resolveOutDir('../escape'), /ASM_OUT_DIR_UNSAFE/);
    assert.throws(() => asm.resolveOutDir('UPPER_Case'), /ASM_OUT_DIR_UNSAFE/);
    assert.throws(() => asm.resolveOutDir(''), /ASM_OUT_DIR_UNSAFE/);
    // 非制品根：checkedTarget 只认本组装器命名空间
    assert.throws(() => asm.checkedTarget(asm.ROOT), /ASM_OUT_DIR_UNSAFE/);
    assert.throws(() => asm.checkedTarget(input.dir), /ASM_OUT_DIR_UNSAFE/);
    // 与输入登记制品重叠：输出落在输入制品内部或输入目录就是候选本身，均判冲突
    assert.throws(() => asm.assertNoOverlap(path.join(input.dir, 'nested-out'), input.dir), /ASM_INPUT_OVERLAP/);
    assert.throws(() => asm.assertNoOverlap(path.dirname(input.dir), input.dir), /ASM_INPUT_OVERLAP/);
    // 与受审关闭包重叠：输出落在关闭包内部即冲突
    assert.throws(
      () => asm.assertNoOverlap(path.join(ARTIFACTS_ROOT, asm.CLOSED_DIR, 'nested-out'), input.dir),
      /ASM_INPUT_OVERLAP/
    );
    // 与既有历史制品重叠
    assert.throws(
      () => asm.assertNoOverlap(path.join(ARTIFACTS_ROOT, 'closed-20261005', 'nested-out'), input.dir),
      /ASM_INPUT_OVERLAP/
    );
    // 输出目录等于受审关闭包本身也判冲突（不得改写关闭包）
    assert.throws(
      () => asm.assertNoOverlap(path.resolve(ARTIFACTS_ROOT, asm.CLOSED_DIR), path.resolve(input.dir)),
      /ASM_INPUT_OVERLAP/
    );
    // 正常独立目录不误报
    assert.doesNotThrow(() => asm.assertNoOverlap(dir, input.dir));
    assert.equal(fs.existsSync(dir), false, '拒绝路径不得创建目录');
  } finally {
    cleanup(dir);
    cleanup(input.dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 分组 3：输出冲突在真实 build/check 上拒绝，目录快照不变；合法续建与复用
// ═══════════════════════════════════════════════════════════════════════════
test('L3 无 manifest 半成品含不同字节时拒绝覆盖，原树零改动', () => {
  const input = buildRegistrationInput();
  const id = freshId('asmconf');
  try {
    const dir = asm.resolveOutDir(id);
    const rel = `${asm.REGISTRATION_ROOT}/miniprogram/app.js`;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '// 冲突内容\n');
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(r.ok, false);
    assert.equal(r.wroteFiles, false);
    assert.equal(r.problems[0].code, asm.ERR.CONFLICT);
    assert.deepEqual(snapshotTree(dir), before, '冲突必须零覆盖');
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 无 manifest 半成品字节完全正确时合法续建，只补缺项', () => {
  const input = buildRegistrationInput();
  const id = freshId('asmcont');
  try {
    const dir = asm.resolveOutDir(id);
    // 先完整组装，再删掉 manifest 与两个文件 → 合法半成品
    const first = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(first.ok, true, JSON.stringify(first.problems));
    const dropped = [
      'manifest.json',
      `${asm.REGISTRATION_ROOT}/miniprogram/app.json`,
      `${asm.CLOSED_ROOT}/cloudfunctions/scheduleSandbox/index.js`
    ];
    for (const rel of dropped) fs.unlinkSync(path.join(dir, rel));
    const r = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.equal(r.reused, false);
    assert.deepEqual(r.written.slice().sort(), dropped.slice().sort(), '只补缺项');
    assert.equal(asm.checkAssembly({ inputDir: input.dir, outDir: dir, plan: input.plan }).ok, true);
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 有 manifest 但缺文件时拒绝补写（不静默修复）', () => {
  const input = buildRegistrationInput();
  const id = freshId('asminc');
  try {
    const dir = asm.resolveOutDir(id);
    const first = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(first.ok, true);
    const rel = `${asm.REGISTRATION_ROOT}/miniprogram/app.js`;
    fs.unlinkSync(path.join(dir, rel));
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(r.ok, false);
    assert.equal(r.wroteFiles, false);
    assert.deepEqual(snapshotTree(dir), before, '不得补写');
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 完整输入复用不重写 manifest，写入数与网络计数均为零', () => {
  const input = buildRegistrationInput();
  const id = freshId('asmreuse');
  try {
    const dir = asm.resolveOutDir(id);
    const first = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(first.ok, true);
    const manifestBefore = fs.readFileSync(path.join(dir, 'manifest.json'));
    const before = snapshotTree(dir);
    const second = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(second.wroteFiles, false);
    assert.deepEqual(second.written, undefined);
    assert.ok(fs.readFileSync(path.join(dir, 'manifest.json')).equals(manifestBefore));
    assert.deepEqual(snapshotTree(dir), before, '复用不得改动任何字节');
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 计划语义不同（轮次/窗口/用户）即拒绝复用，目录不变', () => {
  const input = buildRegistrationInput();
  const id = freshId('asmdiff');
  try {
    const dir = asm.resolveOutDir(id);
    assert.equal(asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS }).ok, true);
    const before = snapshotTree(dir);
    const variants = [
      syntheticPlan({ roundId: 'SYNTH-ASM-0002' }),
      syntheticPlan({ windowExpiresAt: '2026-01-01T00:10:00.000Z' }),
      syntheticPlan({ allowedUserIds: [deriveUserId('synthetic-other-openid')] })
    ];
    for (const plan of variants) {
      const r = asm.buildAssembly({ inputDir: input.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
      assert.equal(r.ok, false, JSON.stringify(r));
      // 计划语义变化先被输入登记制品的受审校验拦下（其 manifest 绑定原计划），
      // 或被组装器自身的完整契约比对拦下；两者都在任何写入之前。
      assert.match(r.problems[0].code, /^(ASM_INPUT_REJECTED|ASM_CONFLICT|ASM_MANIFEST_MISMATCH|REG_)/,
        JSON.stringify(r.problems));
      assert.equal(r.wroteFiles, false);
    }
    assert.deepEqual(snapshotTree(dir), before);
    // 另证：同一计划语义（仅随机后缀不同）可正常复用
    const same = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(same.ok, true, JSON.stringify(same.problems));
    assert.equal(same.reused, true);
    assert.deepEqual(snapshotTree(dir), before, '相同输入复用不得改动字节');
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 额外文件、额外目录、空目录与非普通条目在写入前拒绝，零写', () => {
  const input = buildRegistrationInput();
  try {
    // 额外文件
    let id = freshId('asmx1'), dir = asm.resolveOutDir(id);
    fs.mkdirSync(path.join(dir, asm.REGISTRATION_ROOT), { recursive: true });
    fs.writeFileSync(path.join(dir, asm.REGISTRATION_ROOT, 'stray.txt'), 'x');
    let before = snapshotTree(dir);
    let r = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(r.ok, false); assert.equal(r.problems[0].code, asm.ERR.EXTRA_ENTRY);
    assert.equal(r.wroteFiles, false); assert.deepEqual(snapshotTree(dir), before);
    cleanup(dir);

    // 额外（含空）目录
    id = freshId('asmx2'); dir = asm.resolveOutDir(id);
    fs.mkdirSync(path.join(dir, 'unexpected-empty'), { recursive: true });
    before = snapshotTree(dir);
    r = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(r.ok, false); assert.equal(r.problems[0].code, asm.ERR.EXTRA_ENTRY);
    assert.equal(r.wroteFiles, false); assert.deepEqual(snapshotTree(dir), before);
    cleanup(dir);

    // 祖先 junction（本机真实 Windows 目录联接）
    id = freshId('asmx3'); dir = asm.resolveOutDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const sentinel = path.join(dir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'untouched');
    const linkPath = path.join(dir, 'registration-project');
    let junctionMade = false;
    try {
      require('node:child_process').execFileSync(
        'cmd.exe', ['/c', 'mklink', '/J', linkPath, path.join(ARTIFACTS_ROOT, asm.CLOSED_DIR)],
        { windowsHide: true, stdio: 'ignore' }
      );
      junctionMade = true;
    } catch (_) { junctionMade = false; }
    if (junctionMade) {
      before = snapshotTree(dir);
      r = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
      assert.equal(r.ok, false, '真实 junction 必须拒绝');
      assert.equal(r.wroteFiles, false);
      assert.ok(
        r.problems[0].code === asm.ERR.ENTRY_SYMLINK || r.problems[0].code === asm.ERR.EXTRA_ENTRY,
        JSON.stringify(r.problems)
      );
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched', '目标 sentinel 不得被改动');
      assert.deepEqual(snapshotTree(dir), before, '拒绝后目录快照不变');
    }
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 check 从受审来源与完整输入重算：改字节并自报新哈希仍拒绝', () => {
  const input = buildRegistrationInput();
  const id = freshId('asmtamper');
  try {
    const dir = asm.resolveOutDir(id);
    assert.equal(asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS }).ok, true);
    const rel = `${asm.CLOSED_ROOT}/miniprogram/app.wxss`;
    const abs = path.join(dir, rel);
    const tampered = Buffer.concat([fs.readFileSync(abs), Buffer.from('\n.tampered{}')]);
    fs.writeFileSync(abs, tampered);
    // 同时把 manifest 里该文件的自报哈希改成实际值
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifest.projects.closed.files.find(f => f.rel === 'miniprogram/app.wxss');
    entry.bytes = tampered.length;
    entry.sha256 = asm.sha256Buffer(tampered);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const before = snapshotTree(dir);
    const r = expectCheckZeroWrite(dir, { inputDir: input.dir, plan: input.plan });
    assert.equal(r.problems[0].code, asm.ERR.MANIFEST_MISMATCH);
    assert.deepEqual(snapshotTree(dir), before);
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 check 拒绝改轮次/目标/窗口/合成标记与旧路由混入的 manifest', () => {
  const input = buildRegistrationInput();
  const id = freshId('asmmeta');
  try {
    const dir = asm.resolveOutDir(id);
    assert.equal(asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS }).ok, true);
    const manifestPath = path.join(dir, 'manifest.json');
    const original = fs.readFileSync(manifestPath);
    const mutations = [
      ['合成标记改假', m => { m.synthetic = false; }],
      ['部署标记改真', m => { m.deploymentAuthorized = true; }],
      ['云执行改真', m => { m.cloudExecuted = true; }],
      ['上传改真', m => { m.uploaded = true; }],
      ['轮次变更', m => { m.plan.roundId = 'SYNTH-ASM-9999'; }],
      ['目标变更', m => { m.plan.envId = 'cloud-other'; }],
      ['窗口变更', m => { m.plan.windowExpiresAt = '2026-01-01T00:19:00.000Z'; }],
      ['加入旧路由', m => { m.controlledTransforms.appJson.artifactPages = ['pages/access/access']; }],
      ['删除限制声明', m => { delete m.limitations; }]
    ];
    for (const [label, mutate] of mutations) {
      const m = JSON.parse(original.toString('utf8'));
      mutate(m);
      fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
      const r = expectCheckZeroWrite(dir, { inputDir: input.dir, plan: input.plan });
      assert.ok(
        r.problems[0].code === asm.ERR.MANIFEST_INVALID || r.problems[0].code === asm.ERR.MANIFEST_MISMATCH,
        label + ' → ' + JSON.stringify(r.problems)
      );
    }
    fs.writeFileSync(manifestPath, original);
    assert.equal(asm.checkAssembly({ inputDir: input.dir, outDir: dir, plan: input.plan }).ok, true, '还原后应通过');
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 check 拒绝缺失、多余与重复条目，且不补写', () => {
  const input = buildRegistrationInput();
  const id = freshId('asment');
  try {
    const dir = asm.resolveOutDir(id);
    assert.equal(asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS }).ok, true);

    // 缺失条目
    const rel = `${asm.REGISTRATION_ROOT}/miniprogram/app.wxss`;
    const abs = path.join(dir, rel);
    const saved = fs.readFileSync(abs);
    fs.unlinkSync(abs);
    let before = snapshotTree(dir);
    let r = expectCheckZeroWrite(dir, { inputDir: input.dir, plan: input.plan });
    assert.equal(r.problems[0].code, asm.ERR.INCOMPLETE);
    assert.deepEqual(snapshotTree(dir), before, '不得补写缺失文件');
    fs.writeFileSync(abs, saved);

    // 多余条目
    const stray = path.join(dir, asm.CLOSED_ROOT, 'extra.js');
    fs.writeFileSync(stray, '// 多余');
    before = snapshotTree(dir);
    r = expectCheckZeroWrite(dir, { inputDir: input.dir, plan: input.plan });
    assert.equal(r.problems[0].code, asm.ERR.EXTRA_ENTRY);
    assert.deepEqual(snapshotTree(dir), before);
    fs.unlinkSync(stray);

    // 重复条目：清单里同一 rel 出现两次
    const manifestPath = path.join(dir, 'manifest.json');
    const original = fs.readFileSync(manifestPath);
    const m = JSON.parse(original.toString('utf8'));
    m.projects.registration.files.push(Object.assign({}, m.projects.registration.files[0]));
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
    before = snapshotTree(dir);
    r = expectCheckZeroWrite(dir, { inputDir: input.dir, plan: input.plan });
    assert.equal(r.problems[0].code, asm.ERR.MANIFEST_MISMATCH);
    assert.deepEqual(snapshotTree(dir), before);
    fs.writeFileSync(manifestPath, original);
    assert.equal(asm.checkAssembly({ inputDir: input.dir, outDir: dir, plan: input.plan }).ok, true);
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

test('L3 写入期 I/O 失败保留可审查半成品，不递归清理，解除后续建', () => {
  const input = buildRegistrationInput();
  const id = freshId('asmio');
  try {
    const dir = asm.resolveOutDir(id);
    // 预置一个字节完全正确的文件，使树进入合法半成品状态
    const probe = asm.computeExpected(input.plan, input.dir);
    const seedRel = `${asm.REGISTRATION_ROOT}/miniprogram/app.js`;
    fs.mkdirSync(path.dirname(path.join(dir, seedRel)), { recursive: true });
    fs.writeFileSync(path.join(dir, seedRel), probe.expected.get(seedRel));

    const realWrite = fs.writeFileSync;
    let calls = 0;
    const failing = Object.assign({}, fs, {
      writeFileSync(file, data, options) {
        calls++;
        if (calls === 2) { const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e; }
        return realWrite(file, data, options);
      }
    });
    const Module_ = Module;
    const tool = (() => {
      const file = path.join(asm.ROOT, 'miniapp/scripts/assemble-sandbox-registration.cjs');
      const module = { exports: {} };
      const native = Module_.createRequire(file);
      const legacy = require('../scripts/package-sandbox.cjs');
      const registration = require('../scripts/package-sandbox-registration.cjs');
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(file), __filename: file,
        Buffer, Map, Set, JSON, Array, Object, Number, String, Boolean, Error, RegExp, Date, process,
        require(name) {
          if (name === 'node:fs' || name === 'fs') return failing;
          if (name === './package-sandbox.cjs') return legacy;
          if (name === './package-sandbox-registration.cjs') return registration;
          return native(name);
        }
      }, { filename: file });
      return module.exports;
    })();

    const r = tool.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(r.ok, false);
    assert.equal(r.incomplete, true);
    assert.ok(r.written.length > 0, '已写文件应如实报告');
    assert.equal(r.problems[0].code, asm.ERR.WRITE_FAILED);
    // 半成品保留：至少一个已写文件仍在
    assert.ok(fs.existsSync(path.join(dir, r.written[0])));
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), false, '失败不得写 manifest');

    // 解除故障后合法续建
    const again = asm.buildAssembly({ inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS });
    assert.equal(again.ok, true, JSON.stringify(again.problems));
    assert.equal(asm.checkAssembly({ inputDir: input.dir, outDir: dir, plan: input.plan }).ok, true);
    cleanup(dir);
  } finally { cleanup(input.dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 分组 4：两份完整项目中的实际 App / Page / client 合成调用链
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 从**组装产物**内加载实际 App、Page、client 及其依赖。
 * 只替换全局 wx / App / Page / getApp 与存储为合成对象；模块代码是制品真实字节。
 */
function loadActualApp(projectRoot, options = {}) {
  const miniprogram = path.join(projectRoot, 'miniprogram');
  const modules = new Map(), loaded = [], calls = [];
  const storage = new Map([['unrelated-cache', 'keep-me']]);
  let clearCount = 0, removeCount = 0, appDefinition = null, pageDefinition = null;
  const copy = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const api = {
    getAccountInfoSync: () => ({
      miniProgram: { appId: options.appId || FIXED.appId, envVersion: options.version || 'develop' }
    }),
    getStorageInfoSync: () => ({ keys: Array.from(storage.keys()) }),
    getStorageSync: key => copy(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, copy(value)),
    removeStorageSync: key => { removeCount++; storage.delete(key); },
    clearStorageSync: () => { clearCount++; storage.clear(); },
    request: () => { throw new Error('禁止旧 request 路由'); },
    cloud: {
      init: options.initSpy || (() => {}),
      callFunction: async args => {
        calls.push(copy(args));
        if (options.failCall) throw new Error('synthetic timeout: outcome unknown');
        return { result: { ok: true, userId: deriveUserId(SYNTH_OPENID), isAdmin: false } };
      }
    }
  };
  function load(file) {
    file = path.resolve(file);
    if (modules.has(file)) return modules.get(file).exports;
    const rel = path.relative(miniprogram, file).replace(/\\/g, '/');
    if (rel.startsWith('../')) throw new Error('前端依赖越界：' + rel);
    let source;
    try { source = fs.readFileSync(file, 'utf8'); }
    catch (_) { throw new Error('实际模块缺失，不得退化为静态检查：' + rel); }
    const module = { exports: {} };
    modules.set(file, module);
    loaded.push(rel);
    const appInstance = options.appInstance;
    vm.runInNewContext(source, {
      module, exports: module.exports, wx: api,
      App: value => { appDefinition = value; },
      Page: value => { pageDefinition = value; },
      getApp: () => appInstance,
      console, Date, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, Boolean, Error,
      require(name) {
        if (!name.startsWith('.')) throw new Error('不允许未声明的外部前端依赖：' + name);
        let next = path.resolve(path.dirname(file), name);
        if (!path.extname(next)) next += '.js';
        return load(next);
      }
    }, { filename: file });
    return module.exports;
  }

  // 1) 先加载实际 App（app.js → config/cloud.js）
  load(path.join(miniprogram, 'app.js'));
  assert.ok(appDefinition, '实际 App 必须注册');
  // globalData 取实际定义（不替换为空对象），保证 onLaunch 写入的是真实字段
  const appInstance = options.appInstance || Object.assign({}, appDefinition, {
    globalData: JSON.parse(JSON.stringify(appDefinition.globalData || {}))
  });
  // 2) 再加载实际 Page（及其 client / driver / coordinator / 三配置）
  load(path.join(miniprogram, asm.ONLY_PAGE + '.js'));
  assert.ok(pageDefinition, '实际 Page 必须注册');

  const page = Object.assign({}, pageDefinition, {
    data: copy(pageDefinition.data),
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split('.');
        let node = this.data;
        for (const p of parts.slice(0, -1)) { if (!node[p]) node[p] = {}; node = node[p]; }
        node[parts[parts.length - 1]] = value;
      }
    }
  });
  return {
    app: appDefinition, appInstance, page, api, storage, calls, loaded,
    client: modules.get(path.join(miniprogram, 'utils/schedule-sandbox-client.js')).exports,
    clearCalls: () => clearCount, removeCalls: () => removeCount
  };
}

test('L4 登记完整包：实际 App 初始化固定云环境，onLoad/onShow 零业务请求', async () => {
  await withAssembly(({ registration }) => {
    let initArgs = null;
    const h = loadActualApp(registration, { initSpy: a => { initArgs = JSON.parse(JSON.stringify(a)); } });
    h.app.onLaunch.call(h.appInstance);
    // App 以固定云环境初始化（VM 跨上下文，故按值比较）
    assert.equal(initArgs.env, FIXED.envId, 'App 初始化固定云环境');
    assert.equal(initArgs.traceUser, false);
    assert.equal(h.appInstance.globalData.cloudReady, true);
    assert.equal(h.appInstance.globalData.cloudError, '');
    h.page.onLoad(); h.page.onShow();
    assert.equal(h.calls.length, 0, '生命周期零业务请求');
    assert.equal(h.clearCalls(), 0); assert.equal(h.removeCalls(), 0);
  });
});

test('L4 登记完整包：主动 identify 一次、无 projectId、固定函数名与环境', async () => {
  await withAssembly(async ({ registration }) => {
    const h = loadActualApp(registration);
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad();
    assert.equal(h.page.data.entryAllowed, true, '登记版入口应允许');
    await h.page.runSelected();
    assert.equal(h.calls.length, 1, '主动提交恰好一次');
    const call = h.calls[0];
    assert.equal(call.name, asm.CLOUD_FUNCTION_NAME, '固定函数名');
    assert.equal(call.config.env, FIXED.envId, '固定环境');
    assert.equal(call.data.action, 'identify');
    assert.equal(call.data.projectId, undefined, 'identify 不得携带 projectId');
    assert.equal(typeof call.data.requestId, 'string');
  });
});

test('L4 关闭完整包：实际 Page/client 加载后生命周期与主动提交均零业务发送', async () => {
  await withAssembly(async ({ closed }) => {
    const h = loadActualApp(closed);
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad(); h.page.onShow();
    await h.page.runSelected();
    assert.equal(h.page.data.entryAllowed, false, '关闭版入口应拒绝');
    assert.equal(h.calls.length, 0, '关闭版零业务发送');
    assert.equal(h.clearCalls(), 0); assert.equal(h.removeCalls(), 0);
  });
});

test('L4 首次未知结果：生命周期与微任务不自动重发、不清缓存（沿用未绑定限制）', async () => {
  await withAssembly(async ({ registration }) => {
    const h = loadActualApp(registration, { failCall: true });
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad();
    await h.page.runSelected();
    assert.equal(h.calls.length, 1, '只发一次');
    assert.match(String(h.page.data.lastError), /未知|失败|核对/);
    const before = Array.from(h.storage.entries());
    h.page.onShow(); h.page.onLoad(); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.calls.length, 1, '不得自动重发');
    assert.deepEqual(Array.from(h.storage.entries()), before, '不得清缓存');
    assert.equal(h.clearCalls(), 0); assert.equal(h.removeCalls(), 0);
  });
});

test('L4 版本与 AppID 门控：错 AppID 零发送；关闭版错误页仍显示其他动作（单页≠单按钮）', async () => {
  await withAssembly(async ({ registration }) => {
    const wrong = loadActualApp(registration, { appId: 'wxOTHERAPPID000000' });
    wrong.page.onLoad();
    wrong.app.onLaunch.call(wrong.appInstance);
    await wrong.page.runSelected();
    assert.equal(wrong.calls.length, 0, '错 AppID 必须零发送');

    const h = loadActualApp(registration);
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad();
    // 页面保留既有动作选择器，未因唯一页面被隐藏
    assert.ok(Array.isArray(h.page.data.actions) && h.page.data.actions.length > 1,
      '页面仍应显示其他动作');
    assert.ok(h.page.data.actionIndex >= 0);
  });
});

test('L4 实际加载的是两份完整项目自身模块，且非孤立配置', async () => {
  await withAssembly(({ registration, closed }) => {
    const a = loadActualApp(registration);
    const b = loadActualApp(closed);
    // App/Page/client/协调器/驱动与三配置均为实际模块加载（非静态文本检查）
    for (const rel of [
      'app.js', 'config/cloud.js', asm.ONLY_PAGE + '.js',
      'utils/schedule-sandbox-client.js', 'utils/env-gate.js',
      'utils/sandbox-test-driver.js', 'utils/sandbox-test-coordinator.js',
      'config/schedule-sandbox-proof.js', 'config/sandbox-test-driver-proof.js'
    ]) {
      assert.ok(a.loaded.includes(rel), '登记版未加载 ' + rel);
      assert.ok(b.loaded.includes(rel), '关闭版未加载 ' + rel);
    }
    // schedule-entry-proof.js 在闭包内但当前链不引用它；如实断言它未被加载，
    // 而不是把它算作「已加载」来凑数。
    assert.equal(a.loaded.includes('config/schedule-entry-proof.js'), false,
      '入口证明文件当前不被该链引用');
    // client 是实际模块导出，不是占位
    for (const h of [a, b]) {
      assert.equal(typeof h.client.callSandbox, 'function');
      assert.equal(typeof h.client.checkSandboxEntry, 'function');
      assert.ok(Array.isArray(h.client.KNOWN_ACTIONS) && h.client.KNOWN_ACTIONS.length > 1);
    }
    // 两份项目加载的是各自产物中的字节，不是仓库源目录
    const loadedAbs = path.join(registration, 'miniprogram/utils/schedule-sandbox-client.js');
    assert.ok(fs.existsSync(loadedAbs));
    assert.ok(fs.readFileSync(loadedAbs).equals(
      fs.readFileSync(path.join(closed, 'miniprogram/utils/schedule-sandbox-client.js'))
    ), '两份项目的客户端字节应一致');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 分组 5：网络与云调用实际拦截、产物未部署记录
// ═══════════════════════════════════════════════════════════════════════════
test('L5 组装与检查均零网络：安装实际拦截后计数为零，调用会被拒绝', () => {
  const state = asm.installNetworkGuard({});
  try {
    const input = buildRegistrationInput();
    const id = freshId('asmnet');
    try {
      const dir = asm.resolveOutDir(id);
      const built = asm.buildAssembly({
        inputDir: input.dir, plan: input.plan, outId: id, nowMs: SYNTH_NOW_MS, networkGuard: state
      });
      assert.equal(built.ok, true, JSON.stringify(built.problems));
      assert.equal(state.attempts.length, 0, '组装不得有任何网络调用');
      assert.equal(built.networkAttempts, 0);
      assert.equal(built.cloudCalled, false);

      const checked = asm.checkAssembly({ inputDir: input.dir, outDir: dir, plan: input.plan, networkGuard: state });
      assert.equal(checked.ok, true);
      assert.equal(state.attempts.length, 0, '检查不得有任何网络调用');
      assert.equal(checked.wroteFiles, false);

      // 拦截确实生效：尝试网络会被拒绝并计数
      assert.throws(() => require('node:https').request('https://example.invalid'), /禁止网络访问/);
      assert.equal(state.attempts.length, 1, '拦截计数应实际增加');

      // 清单如实记录未部署状态
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.deploymentAuthorized, false);
      assert.equal(manifest.cloudExecuted, false);
      assert.equal(manifest.uploaded, false);
      assert.equal(manifest.previewed, false);
      assert.equal(manifest.synthetic, true);
      cleanup(dir);
    } finally { cleanup(input.dir); }
  } finally { asm.restoreNetworkGuard(state); }
});

test('L5 组装目录含两个函数版本时不能整体上传：清单只承认单项目根', async () => {
  await withAssembly(({ result }) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.projects.registration.root, asm.REGISTRATION_ROOT);
    assert.equal(manifest.projects.closed.root, asm.CLOSED_ROOT);
    // 顶层只有一个 manifest 与两个项目目录，没有混合云函数版本
    const top = fs.readdirSync(result.dir).sort();
    assert.deepEqual(top, ['closed-project', 'manifest.json', 'registration-project']);
    assert.equal(manifest.input.closedPackage.dir, asm.CLOSED_DIR);
    assert.match(manifest.limitations.join(' '), /不得提交名为 package 的目录/);
  });
});

test('L5 合成计划不得被当作真实写批准：清单标记与限制声明齐备', async () => {
  await withAssembly(({ result }) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.synthetic, true);
    assert.equal(manifest.plan.synthetic, true);
    assert.equal(manifest.plan.sourceVersion, reg.REVIEWED_SOURCE_VERSION);
    const text = manifest.limitations.join(' ');
    assert.match(text, /不是部署授权/);
    assert.match(text, /不得转为真实包或上传/);
    assert.match(text, /未安装 wx-server-sdk/);
    assert.match(text, /唯一页面不等于唯一按钮/);
    assert.match(text, /无持久防重/);
  });
});
