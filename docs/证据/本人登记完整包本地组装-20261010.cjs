#!/usr/bin/env node
/**
 * 证据脚本：本人登记完整包本地组装（L1/L2/L3）
 * =================================================
 *
 * 独立复现本轮交付，不修改任何历史证据、不写仓库源文件。
 *
 * 记录内容：
 *  1. 受保护文件字节基线（接手提交 61821b4 的全部已跟踪文件）运行前后比较；
 *  2. 真实调用已验收登记生成器产出合成登记制品；
 *  3. 真实调用本轮组装器产出两份完整项目，记录路径、文件数、清单哈希；
 *  4. 行为分组核验：完整文件集与依赖、八文件逐字节、反例零写、合法续建与复用、
 *     两份完整项目的真实 App/Page/client 合成调用链；
 *  5. 本机微信编译器（wcc/wcsc）对**隔离完整包**的 WXML/WXSS 编译，
 *     参数数组、shell:false、独立输出目录、限时与输出截断；
 *     不打开 IDE、不执行模拟器、不预览、不上传、不登录、不联网。
 *
 * 边界：本轮不执行真实 SDK 或平台验证；网络调用由实际拦截计数，非硬写零。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const reg = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));
const asm = require(path.join(ROOT, 'miniapp/scripts/assemble-sandbox-registration.cjs'));

const BASELINE_COMMIT = '61821b4';
const SYNTH_NOW_MS = Date.parse('2026-01-01T00:05:00.000Z');
const SYNTH_OPENID = 'synthetic-assembly-openid';
const WCC_DIR = 'D:/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
const COMPILE_TIMEOUT_MS = 60000;
const MAX_CAPTURE = 4000;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function deriveUserId(openid) {
  return 'u_' + sha256(Buffer.from(`${reg.FIXED_TARGET.appId}:${openid}`)).slice(0, 40);
}
function freshId(prefix) { return prefix + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20); }

const report = {
  startedAt: new Date().toISOString(),
  baselineCommit: BASELINE_COMMIT,
  claims: {
    realSdkExecuted: false,
    platformExecuted: false,
    cloudWritten: false,
    previewedOrUploaded: false,
    deployed: false,
    note: '本轮仅本地组装与离线核验；wx/云函数/存储均为合成对象。'
  },
  groups: [],
  protectedBaseline: {},
  assembly: {},
  compilation: {},
  counts: { networkAttempts: 0, cloudCalls: 0, credentialsFetched: 0 }
};
function group(name, detail) { report.groups.push(Object.assign({ group: name }, detail)); }

/** 只清理本脚本自己新建、且绝对路径在制品根内的目录。 */
function cleanupSelf(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(asm.ARTIFACTS_ROOT) + path.sep)) {
    throw new Error('拒绝清理制品根之外的路径：' + resolved);
  }
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}
function snapshotTree(dir) {
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  (function walk(cur, prefix) {
    for (const name of fs.readdirSync(cur).sort()) {
      const rel = prefix ? prefix + '/' + name : name;
      const abs = path.join(cur, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) { rows.push(rel + ':link'); continue; }
      if (st.isDirectory()) { rows.push(rel + '/'); walk(abs, rel); continue; }
      if (!st.isFile()) { rows.push(rel + ':special'); continue; }
      const buf = fs.readFileSync(abs);
      rows.push(rel + ':' + buf.length + ':' + sha256(buf));
    }
  })(dir, '');
  return rows;
}

// ── 1. 受保护文件字节基线 ────────────────────────────────────────────────────
/**
 * 列出全部已跟踪文件。Git Bash 的 git 不在标准 PATH，
 * 故先按常见安装位置解析绝对路径；找不到时如实记为未验证，不静默跳过。
 */
function resolveGit() {
  const candidates = [
    process.env.GIT_EXECUTABLE,
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files/Git/bin/git.exe',
    'git'
  ].filter(Boolean);
  for (const exe of candidates) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (!r.error && r.status === 0) return exe;
  }
  return null;
}
const GIT_EXE = resolveGit();

function gitOutput(args) {
  if (!GIT_EXE) return null;
  const r = spawnSync(GIT_EXE, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}
function trackedFiles() {
  const out = gitOutput(['ls-files', '-z']);
  if (out === null) return null;
  return out.split('\0').filter(Boolean);
}
function hashTracked() {
  const files = trackedFiles();
  const map = new Map();
  if (files === null) return map; // 如实记为不可用，由报告标注
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { map.set(rel, null); continue; }
    map.set(rel, sha256(fs.readFileSync(abs)));
  }
  return map;
}
const baselineBefore = hashTracked();
const baselineTracked = trackedFiles();
const baselineCommitOk = baselineTracked !== null
  && spawnSync(GIT_EXE, ['cat-file', '-e', BASELINE_COMMIT + '^{commit}'],
    { cwd: ROOT, windowsHide: true, timeout: 30000 }).status === 0;

// ── 2. 组装输入与产物 ────────────────────────────────────────────────────────
const netState = asm.installNetworkGuard({});
const plan = {
  purpose: 'synthetic-full-assembly-evidence-only',
  appId: reg.FIXED_TARGET.appId,
  envId: reg.FIXED_TARGET.envId,
  region: reg.FIXED_TARGET.region,
  functionName: reg.FIXED_TARGET.functionName,
  allowedUserIds: [deriveUserId(SYNTH_OPENID)],
  roundId: 'SYNTH-EVIDENCE-0001',
  windowStartsAt: '2026-01-01T00:00:00.000Z',
  windowExpiresAt: '2026-01-01T00:20:00.000Z',
  sourceVersion: reg.REVIEWED_SOURCE_VERSION,
  synthetic: true
};

const inputId = freshId('eviden');
const inputBuild = reg.buildRegistration(plan, { outId: inputId, nowMs: SYNTH_NOW_MS });
if (!inputBuild.ok) throw new Error('合成登记制品生成失败：' + JSON.stringify(inputBuild.problems));

const outId = freshId('synth');
const built = asm.buildAssembly({
  inputDir: inputBuild.dir, plan, outId, nowMs: SYNTH_NOW_MS, networkGuard: netState
});
if (!built.ok) throw new Error('组装失败：' + JSON.stringify(built.problems));

const registrationProject = path.join(built.dir, asm.REGISTRATION_ROOT);
const closedProject = path.join(built.dir, asm.CLOSED_ROOT);
const manifestBuf = fs.readFileSync(path.join(built.dir, 'manifest.json'));
const manifest = JSON.parse(manifestBuf.toString('utf8'));

report.assembly = {
  inputDir: path.relative(ROOT, inputBuild.dir).split(path.sep).join('/'),
  inputFiles: inputBuild.written.length,
  outDir: path.relative(ROOT, built.dir).split(path.sep).join('/'),
  registrationProject: path.relative(ROOT, registrationProject).split(path.sep).join('/'),
  closedProject: path.relative(ROOT, closedProject).split(path.sep).join('/'),
  totalFiles: snapshotTree(built.dir).filter(r => !r.endsWith('/')).length,
  manifestSha256: sha256(manifestBuf),
  manifestSchema: manifest.schema,
  perProjectFileCount: manifest.projects.registration.fileCount,
  projectDelta: built.projectDelta,
  dependencyClosure: built.dependencyClosure,
  networkAttempts: netState.attempts.length,
  cloudCalled: built.cloudCalled,
  synthetic: manifest.synthetic,
  deploymentAuthorized: manifest.deploymentAuthorized,
  cloudExecuted: manifest.cloudExecuted,
  uploaded: manifest.uploaded
};

// ── 3. 分组一：文件集、依赖、逐字节来源 ─────────────────────────────────────
function groupFilesAndBytes() {
  const checks = [];
  function check(label, condition, detail) { checks.push({ label, ok: Boolean(condition), detail: detail || '' }); }

  const registrationFiles = snapshotTree(registrationProject).filter(r => !r.endsWith('/'));
  const closedFiles = snapshotTree(closedProject).filter(r => !r.endsWith('/'));
  check('登记项目文件数等于声明文件集', registrationFiles.length === asm.PROJECT_FILES.length,
    registrationFiles.length + ' vs ' + asm.PROJECT_FILES.length);
  check('关闭项目文件数等于声明文件集', closedFiles.length === asm.PROJECT_FILES.length,
    closedFiles.length + ' vs ' + asm.PROJECT_FILES.length);

  const appJson = JSON.parse(fs.readFileSync(path.join(registrationProject, 'miniprogram/app.json'), 'utf8'));
  check('app.json 仅保留唯一页面', JSON.stringify(appJson.pages) === JSON.stringify([asm.ONLY_PAGE]),
    JSON.stringify(appJson.pages));
  const sourceAppJson = JSON.parse(fs.readFileSync(path.join(asm.MINIPROGRAM_SRC, 'app.json'), 'utf8'));
  check('窗口配置原样保留', JSON.stringify(appJson.window) === JSON.stringify(sourceAppJson.window));
  check('仓库源九路由未改', sourceAppJson.pages.length === 9);

  const pc = JSON.parse(fs.readFileSync(path.join(registrationProject, 'project.config.json'), 'utf8'));
  check('project.config.json 固定 AppID', pc.appid === 'wxfb4db1615ac15531');
  check('compileType=miniprogram', pc.compileType === 'miniprogram');
  check('miniprogramRoot=miniprogram/', pc.miniprogramRoot === 'miniprogram/');
  check('cloudfunctionRoot=cloudfunctions/', pc.cloudfunctionRoot === 'cloudfunctions/');
  check('不含 private config', !JSON.stringify(pc).includes('private'));
  check('不含 project.private.config.json 文件',
    !fs.existsSync(path.join(registrationProject, 'project.private.config.json')));

  check('云函数目录名为 scheduleSandbox',
    fs.readdirSync(path.join(registrationProject, 'cloudfunctions')).join(',') === asm.CLOUD_FUNCTION_NAME);

  // 八文件逐字节
  const closedDesc = reg.describeClosedPackage();
  let byteMatch = true; const byteDetail = [];
  for (const rel of reg.PACKAGE_FILES) {
    const regBytes = fs.readFileSync(path.join(registrationProject, 'cloudfunctions/scheduleSandbox', rel));
    const closedBytes = fs.readFileSync(path.join(closedProject, 'cloudfunctions/scheduleSandbox', rel));
    if (!regBytes.equals(fs.readFileSync(path.join(inputBuild.dir, 'package', rel)))) {
      byteMatch = false; byteDetail.push('登记版不符:' + rel);
    }
    const pinned = reg.PINNED_FACTS['miniapp/cloudfunctions/scheduleSandbox/' + rel];
    if (closedBytes.length !== pinned.bytes || sha256(closedBytes) !== pinned.sha256) {
      byteMatch = false; byteDetail.push('关闭版漂移:' + rel);
    }
  }
  check('服务端八文件各与正确输入逐字节匹配', byteMatch, byteDetail.join('; '));
  check('关闭包来自受审校验', closedDesc.dir === asm.CLOSED_DIR && closedDesc.entryState.enabled === false);

  // 差异面
  const differing = asm.PROJECT_FILES.filter(rel =>
    !fs.readFileSync(path.join(registrationProject, rel))
      .equals(fs.readFileSync(path.join(closedProject, rel))));
  check('前后端差异面恰为三项',
    JSON.stringify(differing.slice().sort()) === JSON.stringify([
      'cloudfunctions/scheduleSandbox/gate.js',
      'cloudfunctions/scheduleSandbox/index.js',
      'miniprogram/config/schedule-sandbox-proof.js'
    ]), JSON.stringify(differing));

  // 依赖闭包
  const posix = path.posix;
  let unresolved = 0;
  for (const rel of asm.PROJECT_FRONTEND_FILES) {
    if (!rel.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(registrationProject, rel), 'utf8');
    for (const m of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      let target = posix.normalize(posix.join(posix.dirname(rel), m[1]));
      if (!posix.extname(target)) target += '.js';
      if (!fs.existsSync(path.join(registrationProject, target))) unresolved++;
    }
  }
  check('前端相对依赖全部在制品内可解析', unresolved === 0, 'unresolved=' + unresolved);
  check('无前端 npm 依赖', built.dependencyClosure.externalRequires === 0);

  group('1-文件集与逐字节来源', { checks, passed: checks.filter(c => c.ok).length, total: checks.length });
}

// ── 4. 分组二：反例零写、合法续建与复用 ─────────────────────────────────────
function groupConflictsAndReuse() {
  const checks = [];
  function check(label, condition, detail) { checks.push({ label, ok: Boolean(condition), detail: detail || '' }); }
  const tempDirs = [];

  // 4.1 输出冲突零写
  {
    const id = freshId('evconflict');
    const dir = asm.resolveOutDir(id);
    tempDirs.push(dir);
    const rel = `${asm.REGISTRATION_ROOT}/miniprogram/app.js`;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '// 冲突\n');
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    check('不同字节半成品拒绝覆盖', r.ok === false && r.problems[0].code === asm.ERR.CONFLICT,
      JSON.stringify(r.problems));
    check('冲突时零写', r.wroteFiles === false);
    check('冲突时目录快照不变', JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
  }
  // 4.2 额外文件 / 额外空目录
  {
    const id = freshId('evextra');
    const dir = asm.resolveOutDir(id);
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'unexpected-empty'), { recursive: true });
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    check('额外空目录在写入前拒绝', r.ok === false && r.problems[0].code === asm.ERR.EXTRA_ENTRY,
      JSON.stringify(r.problems));
    check('额外条目时零写', r.wroteFiles === false);
    check('额外条目时目录快照不变', JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
  }
  // 4.3 真实 junction
  {
    const id = freshId('evlink');
    const dir = asm.resolveOutDir(id);
    tempDirs.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    const sentinel = path.join(dir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'untouched');
    const link = path.join(dir, asm.REGISTRATION_ROOT);
    let made = false;
    try {
      spawnSync('cmd.exe', ['/c', 'mklink', '/J', link,
        path.join(asm.ARTIFACTS_ROOT, asm.CLOSED_DIR)], { windowsHide: true, stdio: 'ignore' });
      made = fs.existsSync(link);
    } catch (_) { made = false; }
    if (made) {
      const r = asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
      check('真实 junction 在写入前拒绝', r.ok === false, JSON.stringify(r.problems));
      check('junction 情形零写', r.wroteFiles === false);
      check('目标 sentinel 未被改动', fs.readFileSync(sentinel, 'utf8') === 'untouched');
    } else {
      check('真实 junction 未能在本机创建（如实记未验证）', false, 'mklink /J 失败');
    }
  }
  // 4.4 有 manifest 缺文件拒绝补写
  {
    const id = freshId('evmiss');
    const dir = asm.resolveOutDir(id);
    tempDirs.push(dir);
    asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    const rel = `${asm.REGISTRATION_ROOT}/miniprogram/app.wxss`;
    fs.unlinkSync(path.join(dir, rel));
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    check('已带 manifest 缺文件拒绝补写', r.ok === false, JSON.stringify(r.problems));
    check('缺文件时零写', r.wroteFiles === false);
    check('缺文件时目录快照不变', JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
  }
  // 4.5 合法半成品续建
  {
    const id = freshId('evcont');
    const dir = asm.resolveOutDir(id);
    tempDirs.push(dir);
    asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    const dropped = ['manifest.json',
      `${asm.REGISTRATION_ROOT}/miniprogram/app.json`,
      `${asm.CLOSED_ROOT}/cloudfunctions/scheduleSandbox/index.js`];
    for (const rel of dropped) fs.unlinkSync(path.join(dir, rel));
    const r = asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    check('合法半成品续建成功', r.ok === true, JSON.stringify(r.problems));
    check('续建只补缺项', JSON.stringify((r.written || []).slice().sort()) === JSON.stringify(dropped.slice().sort()),
      JSON.stringify(r.written));
    check('续建后检查通过',
      asm.checkAssembly({ inputDir: inputBuild.dir, outDir: dir, plan }).ok === true);
  }
  // 4.6 完整复用不重写
  {
    const id = freshId('evreuse');
    const dir = asm.resolveOutDir(id);
    tempDirs.push(dir);
    asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    const before = snapshotTree(dir);
    const again = asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    check('相同完整输入复用成功', again.ok === true && again.reused === true, JSON.stringify(again.problems));
    check('复用零写', again.wroteFiles === false);
    check('复用不改任何字节', JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
  }
  // 4.7 check 重算：改字节并自报新哈希仍拒绝
  {
    const id = freshId('evtamper');
    const dir = asm.resolveOutDir(id);
    tempDirs.push(dir);
    asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
    const rel = `${asm.CLOSED_ROOT}/miniprogram/app.wxss`;
    const abs = path.join(dir, rel);
    const tampered = Buffer.concat([fs.readFileSync(abs), Buffer.from('\n.tampered{}')]);
    fs.writeFileSync(abs, tampered);
    const mPath = path.join(dir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    const entry = m.projects.closed.files.find(f => f.rel === 'miniprogram/app.wxss');
    entry.bytes = tampered.length;
    entry.sha256 = sha256(tampered);
    fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
    const before = snapshotTree(dir);
    const r = asm.checkAssembly({ inputDir: inputBuild.dir, outDir: dir, plan });
    check('自报新哈希仍被重算拒绝', r.ok === false && r.problems[0].code === asm.ERR.MANIFEST_MISMATCH,
      JSON.stringify(r.problems));
    check('检查失败零写', r.wroteFiles === false);
    check('检查失败目录快照不变', JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
  }
  // 4.8 计划语义变化拒绝复用
  {
    const variants = [
      ['轮次', Object.assign({}, plan, { roundId: 'SYNTH-EVIDENCE-0002' })],
      ['窗口', Object.assign({}, plan, { windowExpiresAt: '2026-01-01T00:10:00.000Z' })],
      ['用户', Object.assign({}, plan, { allowedUserIds: [deriveUserId('synthetic-other')] })]
    ];
    for (const [label, variant] of variants) {
      const id = freshId('evdiff');
      const dir = asm.resolveOutDir(id);
      tempDirs.push(dir);
      asm.buildAssembly({ inputDir: inputBuild.dir, plan, outId: id, nowMs: SYNTH_NOW_MS });
      const before = snapshotTree(dir);
      const r = asm.buildAssembly({ inputDir: inputBuild.dir, plan: variant, outId: id, nowMs: SYNTH_NOW_MS });
      check('计划' + label + '变化拒绝复用', r.ok === false && r.wroteFiles === false, JSON.stringify(r.problems));
      check('计划' + label + '变化时目录不变', JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
    }
  }
  // 4.9 真实计划不获组装放行
  {
    const id = freshId('evreal');
    const dir = asm.resolveOutDir(id);
    tempDirs.push(dir);
    const realNow = Date.now();
    const realPlan = Object.assign({}, plan, {
      synthetic: false,
      allowedUserIds: ['u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4'],
      windowStartsAt: new Date(realNow + 60000).toISOString(),
      windowExpiresAt: new Date(realNow + 20 * 60000).toISOString()
    });
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({ inputDir: inputBuild.dir, plan: realPlan, outId: id, nowMs: realNow });
    check('真实计划被合成限定拒绝', r.ok === false && r.problems[0].code === asm.ERR.PLAN_SYNTHETIC_ONLY,
      JSON.stringify(r.problems));
    check('真实计划零写', r.wroteFiles === false);
    check('真实计划目录不变', JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
  }

  for (const dir of tempDirs) { try { cleanupSelf(dir); } catch (_) { /* 已清理 */ } }
  group('2-反例零写与合法续建复用', { checks, passed: checks.filter(c => c.ok).length, total: checks.length });
}

// ── 5. 分组三：两份完整项目的真实 App/Page/client 合成链 ─────────────────────
function loadActualApp(projectRoot, options = {}) {
  const miniprogram = path.join(projectRoot, 'miniprogram');
  const modules = new Map(), loaded = [], calls = [];
  const storage = new Map([['unrelated-cache', 'keep-me']]);
  let clearCount = 0, removeCount = 0, appDefinition = null, pageDefinition = null;
  let initArgs = null;
  const copy = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const api = {
    getAccountInfoSync: () => ({
      miniProgram: { appId: options.appId || reg.FIXED_TARGET.appId, envVersion: options.version || 'develop' }
    }),
    getStorageInfoSync: () => ({ keys: Array.from(storage.keys()) }),
    getStorageSync: key => copy(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, copy(value)),
    removeStorageSync: key => { removeCount++; storage.delete(key); },
    clearStorageSync: () => { clearCount++; storage.clear(); },
    request: () => { throw new Error('禁止旧 request 路由'); },
    cloud: {
      init: a => { initArgs = copy(a); },
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
  load(path.join(miniprogram, 'app.js'));
  if (!appDefinition) throw new Error('实际 App 未注册');
  const appInstance = Object.assign({}, appDefinition, {
    globalData: JSON.parse(JSON.stringify(appDefinition.globalData || {}))
  });
  load(path.join(miniprogram, asm.ONLY_PAGE + '.js'));
  if (!pageDefinition) throw new Error('实际 Page 未注册');
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
    initArgs: () => initArgs,
    client: modules.get(path.join(miniprogram, 'utils/schedule-sandbox-client.js')).exports,
    clearCalls: () => clearCount, removeCalls: () => removeCount
  };
}

async function groupActualRuntime() {
  const checks = [];
  function check(label, condition, detail) { checks.push({ label, ok: Boolean(condition), detail: detail || '' }); }

  // 登记版
  {
    const h = loadActualApp(registrationProject);
    h.app.onLaunch.call(h.appInstance);
    check('App 初始化固定云环境',
      h.initArgs() && h.initArgs().env === reg.FIXED_TARGET.envId && h.initArgs().traceUser === false,
      JSON.stringify(h.initArgs()));
    check('App 初始化后无错误', h.appInstance.globalData.cloudReady === true
      && h.appInstance.globalData.cloudError === '');
    h.page.onLoad(); h.page.onShow();
    check('登记版生命周期零业务请求', h.calls.length === 0);
    check('登记版生命周期不清缓存', h.clearCalls() === 0 && h.removeCalls() === 0);
    await h.page.runSelected();
    check('主动 identify 恰好一次', h.calls.length === 1, 'calls=' + h.calls.length);
    const call = h.calls[0];
    check('固定函数名 scheduleSandbox', call.name === asm.CLOUD_FUNCTION_NAME);
    check('固定云环境', call.config.env === reg.FIXED_TARGET.envId);
    check('identify 无 projectId', call.data.action === 'identify' && call.data.projectId === undefined,
      JSON.stringify(call.data));
    check('页面仍保留动作选择器（单页≠单按钮）',
      Array.isArray(h.page.data.actions) && h.page.data.actions.length > 1,
      'actions=' + (h.page.data.actions ? h.page.data.actions.length : 'none'));
    check('实际加载 Page/client/协调器/三配置',
      ['app.js', 'config/cloud.js', asm.ONLY_PAGE + '.js', 'utils/schedule-sandbox-client.js',
        'utils/env-gate.js', 'utils/sandbox-test-driver.js', 'utils/sandbox-test-coordinator.js',
        'config/schedule-sandbox-proof.js', 'config/sandbox-test-driver-proof.js']
        .every(r => h.loaded.includes(r)),
      h.loaded.join(','));
  }
  // 关闭版
  {
    const h = loadActualApp(closedProject);
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad(); h.page.onShow();
    await h.page.runSelected();
    check('关闭版入口拒绝', h.page.data.entryAllowed === false);
    check('关闭版零业务发送', h.calls.length === 0, 'calls=' + h.calls.length);
    check('关闭版不清缓存', h.clearCalls() === 0 && h.removeCalls() === 0);
  }
  // 首次未知结果
  {
    const h = loadActualApp(registrationProject, { failCall: true });
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad();
    await h.page.runSelected();
    check('首次未知结果只发一次', h.calls.length === 1);
    check('未知结果给出停止/核对提示', /未知|失败|核对/.test(String(h.page.data.lastError)),
      String(h.page.data.lastError));
    const before = JSON.stringify(Array.from(h.storage.entries()));
    h.page.onShow(); h.page.onLoad(); await Promise.resolve(); await Promise.resolve();
    check('生命周期/微任务不自动重发', h.calls.length === 1, 'calls=' + h.calls.length);
    check('未知结果不清缓存', JSON.stringify(Array.from(h.storage.entries())) === before);
  }
  // 错 AppID 零发送
  {
    const h = loadActualApp(registrationProject, { appId: 'wxOTHERAPPID000000' });
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad();
    await h.page.runSelected();
    check('错 AppID 零发送', h.calls.length === 0, 'calls=' + h.calls.length);
  }
  // 前端驱动开关保持关闭
  {
    const driverProof = fs.readFileSync(
      path.join(registrationProject, 'miniprogram/config/sandbox-test-driver-proof.js'), 'utf8');
    check('旧前端驱动开关保持关闭', /enabled:\s*false/.test(driverProof));
  }

  group('3-真实应用代码合成调用链', { checks, passed: checks.filter(c => c.ok).length, total: checks.length });
}

// ── 6. 本机微信编译器核验（隔离完整包，参数数组，shell:false） ────────────────
function runCompiler(exe, args, cwd, label) {
  // shell:false + 参数数组，避免任何拼接；独立输出目录，限时与输出截断
  const r = spawnSync(exe, args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: COMPILE_TIMEOUT_MS,
    shell: false, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH || '' }
  });
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTURE);
  return {
    label,
    exe: path.basename(exe),
    args,
    status: r.status,
    signal: r.signal,
    errorCode: r.error ? (r.error.code || r.error.message) : null,
    stdout: clean(r.stdout),
    stderr: clean(r.stderr),
    timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT')
  };
}

function compileIsolatedProjects() {
  const results = [];
  const wcc = path.join(WCC_DIR, 'wcc.exe');
  const wcsc = path.join(WCC_DIR, 'wcsc.exe');
  const compilerExists = fs.existsSync(wcc) && fs.existsSync(wcsc);
  if (!compilerExists) {
    report.compilation = { attempted: false, reason: '本机未找到 wcc.exe / wcsc.exe，如实记未验证。' };
    return;
  }
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-asm-compile-'));
  try {
    for (const [variant, root] of [['registration', registrationProject], ['closed', closedProject]]) {
      const miniRoot = path.join(root, 'miniprogram');
      const wxmlRel = [], wxssRel = [];
      (function walk(cur, prefix) {
        for (const name of fs.readdirSync(cur).sort()) {
          const abs = path.join(cur, name);
          const rel = prefix ? prefix + '/' + name : name;
          if (fs.lstatSync(abs).isDirectory()) walk(abs, rel);
          else if (name.endsWith('.wxml')) wxmlRel.push(rel);
          else if (name.endsWith('.wxss')) wxssRel.push(rel);
        }
      })(miniRoot, '');
      const variantOut = path.join(outRoot, variant);
      fs.mkdirSync(variantOut, { recursive: true });
      // WXML：参数数组，相对 miniprogram 根，独立输出
      results.push(runCompiler(wcc, wxmlRel.concat(['-o', path.join(variantOut, 'wxml.js')]),
        miniRoot, variant + '/wxml'));
      // WXSS
      results.push(runCompiler(wcsc, wxssRel.concat(['-o', path.join(variantOut, 'wxss.js')]),
        miniRoot, variant + '/wxss'));
      results[results.length - 2].targets = wxmlRel;
      results[results.length - 1].targets = wxssRel;
    }
  } finally {
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
  report.compilation = {
    attempted: true,
    compilerDir: WCC_DIR,
    compilerSha256: {
      'wcc.exe': sha256(fs.readFileSync(wcc)),
      'wcsc.exe': sha256(fs.readFileSync(wcsc))
    },
    timeoutMs: COMPILE_TIMEOUT_MS,
    shellFalse: true,
    openedIde: false,
    simulatorOrPreview: false,
    results,
    allPassed: results.every(r => r.status === 0 && !r.timedOut && !r.errorCode),
    scope: 'WXML/WXSS 模板与样式编译；不等于完整微信构建、真机或平台通过。'
  };
}

// ── 7. 受保护文件运行前后比较 ────────────────────────────────────────────────
function protectedBaseline() {
  const after = hashTracked();
  const changed = [], missing = [];
  for (const [rel, hash] of baselineBefore) {
    if (after.get(rel) === null) missing.push(rel);
    else if (after.get(rel) !== hash) changed.push(rel);
  }
  const added = [];
  for (const rel of after.keys()) if (!baselineBefore.has(rel)) added.push(rel);
  report.protectedBaseline = {
    commit: BASELINE_COMMIT,
    commitExists: baselineCommitOk,
    gitExecutable: GIT_EXE,
    trackedFiles: baselineBefore.size,
    trackedFilesAvailable: baselineTracked !== null,
    changedByThisRun: changed,
    missingAfter: missing,
    addedByThisRun: added,
    note: baselineTracked === null
      ? '本机未能调用 git，已跟踪文件基线未验证（如实记录，不以静态解析冒充）。'
      : '除本轮允许的 7 个文件外，接手时全部已跟踪文件应字节不变。'
  };
}

/**
 * 顺序主流程：三组行为核验 → 编译器核验 → 受保护基线比较。
 * 组三含真实异步调用链，必须 await 后才继续，否则会与后续步骤并发。
 */
async function main() {
  groupFilesAndBytes();
  groupConflictsAndReuse();
  await groupActualRuntime();
  compileIsolatedProjects();
  protectedBaseline();

  report.counts.networkAttempts = netState.attempts.length;
  report.finishedAt = new Date().toISOString();
  report.summary = {
    groups: report.groups.length,
    checks: report.groups.reduce((n, g) => n + g.checks.length, 0),
    passed: report.groups.reduce((n, g) => n + g.passed, 0),
    failed: report.groups.reduce((n, g) => n + (g.total - g.passed), 0),
    compilationPassed: report.compilation.allPassed === true
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  asm.restoreNetworkGuard(netState);
}

main().catch(error => {
  process.stderr.write('证据脚本失败：' + (error && error.stack ? error.stack : String(error)) + '\n');
  asm.restoreNetworkGuard(netState);
  process.exitCode = 1;
});
