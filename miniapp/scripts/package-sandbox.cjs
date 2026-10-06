#!/usr/bin/env node
// 施工安排独立测试副本：关闭候选包生成与本地校验工具。
//
// 任务：docs/WorkBuddy任务-独立副本本地制品准备-20261005.md §2（L1）
//
// 设计约束（逐条对应任务要求）：
// 1. **只复制白名单文件**，不递归打包整个工程。白名单是显式常量，不是目录遍历结果。
// 2. 输出到仓库内独立目录 `artifacts/schedule-sandbox/closed-20261005/`，
//    **绝不写回源目录**。
// 3. 输出已存在时：逐文件比较内容，相同则复用（action=reused），不同则**失败**，
//    不递归删除、不静默覆盖。
// 4. manifest 记录相对路径 / 字节数 / SHA-256 / 源文件 SHA-256；
//    **manifest 不对自身做哈希声明**（避免循环）。
// 5. 拒绝绝对路径条目、`..`、符号链接或目录联接等使读取/输出逃逸的路径。
//    **包体每个读点**（生成与检查模式共用）都先 lstat 判链接、判普通文件后才读。
// 6. 不纳入 node_modules、账号配置、日志、历史证据或临时文件。
// 7. **本工具不含上传、部署、安装或云端调用功能**，只读写本地文件。
//
// 失败语义（不夸大承诺）：
// - **可预知的失败**（源/基线/候选清单/受信根/既有文件冲突/额外文件/链接条目/
//   manifest 不一致）**全部发生在预检阶段，此时零新文件写入**。
// - 写入阶段的**真实 I/O 故障**可能已留下部分文件，此时如实报告「包未完成」
//   并保留可核对状态；本工具不递归删除已写入文件。
// - **存在 manifest 不等于已完整校验通过**：判断完整性必须以本工具的校验结果为准。
//
// 用法：
//   node miniapp/scripts/package-sandbox.cjs              生成/复用关闭候选包并校验
//   node miniapp/scripts/package-sandbox.cjs --check      只校验已有产物，不写入
//   node miniapp/scripts/package-sandbox.cjs --out <dir>  指定其它输出目录（测试用）
//
// 退出码：0 通过；1 校验失败（差异、逃逸、字节不符、链接条目等）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE_DIR = path.join(ROOT, 'miniapp', 'cloudfunctions', 'scheduleSandbox');
const DEFAULT_OUT_DIR = path.join(ROOT, 'artifacts', 'schedule-sandbox', 'closed-20261005');
const BASELINE_PATH = path.join(ROOT, 'docs', '证据', '独立测试副本执行包本地基线-20261005.json');
const CANDIDATE_PATH = path.join(ROOT, 'miniapp', 'cloudbase', 'schedule-sandbox-resources.candidate.json');

// ── 白名单（任务 §2.1：入口、gate、collection-map、project-guard、package.json、
//    vendor 两服务及来源清单）────────────────────────────────────────────────
// 顺序固定，便于逐次核对与差异说明。新增文件必须显式登记，不允许自动纳入。
const PACKAGE_FILES = Object.freeze([
  'index.js',
  'gate.js',
  'collection-map.js',
  'project-guard.js',
  'package.json',
  'vendor/service.js',
  'vendor/schedule-service.js',
  'vendor/MANIFEST.json'
]);

// 明确排除项（任务 §2.5）。这里只做**声明式拒绝**，实际由白名单本身保证不纳入；
// 保留常量是为了让「不纳入什么」可被审阅与测试断言，而不是靠隐式约定。
const EXCLUDED_PATTERNS = Object.freeze([
  'node_modules',
  '.env',
  'project.private.config.json',
  '.log',
  'logs',
  'docs/证据',
  '.tmp'
]);

const EXPECTED_PREFIX = 'schtest_v1_';
const EXPECTED_COLLECTION_COUNT = 11;
const EXPECTED_INDEX_COUNT = 13;
const MANIFEST_SCHEMA = 'sandbox-closed-candidate/2';
// 仓库内制品根（R2：CLI 输出必须限定在此之下）
const ARTIFACTS_ROOT = path.join(ROOT, 'artifacts', 'schedule-sandbox');

// ── 已审查的候选规格（R3：严格锁定，防止字段顺序/方向/unique/编号被静默改动）──
// 来源：docs/Codex执行包-独立测试副本小规模云端验证-20261005.md §4 与 §4.1。
// 这是**已审查的待验证候选**，不是新的规格；不新增索引、不改方向。
// 平台是否接受这些组合仍须未来逐项回读。
const APPROVED_INDEX_SPECS = Object.freeze([
  { id: 'I01', collection: 'schtest_v1_users', keys: [{ name: 'bindingCodeHash', direction: 'asc' }], unique: false },
  { id: 'I02', collection: 'schtest_v1_projects', keys: [{ name: 'scope', direction: 'asc' }, { name: 'status', direction: 'asc' }], unique: false },
  { id: 'I03', collection: 'schtest_v1_project_members', keys: [{ name: 'userId', direction: 'asc' }, { name: 'status', direction: 'asc' }], unique: false },
  {
    id: 'I04',
    collection: 'schtest_v1_project_members',
    keys: [
      { name: 'projectId', direction: 'asc' },
      { name: 'status', direction: 'asc' },
      { name: '_id', direction: 'asc' }
    ],
    unique: false
  },
  { id: 'I05', collection: 'schtest_v1_invitations', keys: [{ name: 'tokenHash', direction: 'asc' }], unique: true },
  { id: 'I06', collection: 'schtest_v1_invitations', keys: [{ name: 'projectId', direction: 'asc' }, { name: 'status', direction: 'asc' }], unique: false },
  {
    id: 'I07',
    collection: 'schtest_v1_audit_events',
    keys: [{ name: 'projectId', direction: 'asc' }, { name: 'createdAt', direction: 'desc' }],
    unique: false
  },
  {
    id: 'I08',
    collection: 'schtest_v1_schedules',
    keys: [
      { name: 'projectId', direction: 'asc' },
      { name: 'createdAt', direction: 'asc' },
      { name: '_id', direction: 'asc' }
    ],
    unique: false
  },
  {
    id: 'I09',
    collection: 'schtest_v1_schedules',
    keys: [
      { name: 'projectId', direction: 'asc' },
      { name: 'status', direction: 'asc' },
      { name: 'createdAt', direction: 'asc' },
      { name: '_id', direction: 'asc' }
    ],
    unique: false
  },
  {
    id: 'I10',
    collection: 'schtest_v1_schedules',
    keys: [
      { name: 'projectId', direction: 'asc' },
      { name: 'trade', direction: 'asc' },
      { name: 'createdAt', direction: 'asc' },
      { name: '_id', direction: 'asc' }
    ],
    unique: false
  },
  {
    id: 'I11',
    collection: 'schtest_v1_schedules',
    keys: [
      { name: 'projectId', direction: 'asc' },
      { name: 'status', direction: 'asc' },
      { name: 'trade', direction: 'asc' },
      { name: 'createdAt', direction: 'asc' },
      { name: '_id', direction: 'asc' }
    ],
    unique: false
  },
  {
    id: 'I12',
    collection: 'schtest_v1_schedules',
    keys: [
      { name: 'projectId', direction: 'asc' },
      { name: 'workerUserId', direction: 'asc' },
      { name: 'status', direction: 'asc' },
      { name: '_id', direction: 'asc' }
    ],
    unique: false
  },
  {
    id: 'I13',
    collection: 'schtest_v1_schedule_revisions',
    keys: [{ name: 'scheduleId', direction: 'asc' }, { name: 'afterVersion', direction: 'asc' }],
    unique: false
  }
]);

// 已审查的候选函数规格（删除或改动任一字段即失败）
const APPROVED_FUNCTION_RUNTIME = Object.freeze({
  nodejs: '20.19',
  memoryMB: 256,
  timeoutSeconds: 3,
  type: 'Event'
});

// 已审查的依赖锁定（S3）：版本与来源都必须精确匹配，
// 且会与副本 package.json 的实际锁定版本交叉核对。
const APPROVED_DEPENDENCY = Object.freeze({
  wxServerSdk: '3.0.1',
  packageJson: 'miniapp/cloudfunctions/scheduleSandbox/package.json'
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fail(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  throw new Error(list.join('\n'));
}

// ── 路径安全 ──────────────────────────────────────────────────────────────

/** 相对路径条目校验：拒绝绝对路径、`..`、空段、`.`、Windows 盘符与反斜杠。 */
function assertSafeRelative(relPath) {
  if (typeof relPath !== 'string' || relPath === '') {
    fail('打包条目必须是非空相对路径字符串。');
  }
  if (relPath.includes('\\')) fail(`打包条目不得包含反斜杠：${relPath}`);
  if (path.isAbsolute(relPath) || relPath.startsWith('/')) fail(`打包条目不得是绝对路径：${relPath}`);
  if (/^[A-Za-z]:/.test(relPath)) fail(`打包条目不得含盘符：${relPath}`);
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '') fail(`打包条目不得含空路径段：${relPath}`);
    if (segment === '.' || segment === '..') fail(`打包条目不得含 . 或 .. 段：${relPath}`);
  }
  if (segments.some(segment => /[\0<>:"|?*]/.test(segment))) {
    fail(`打包条目含非法字符：${relPath}`);
  }
  return segments;
}

/**
 * 受信根校验（R2）。
 *
 * `resolveInside` 只从 baseDir 之下开始 lstat，**不检查 base 本身与祖先**；
 * 而 realpath 比较用的是已经跟随链接的根，因此「根被替换成 junction」不会被发现。
 * 本函数对 baseDir 及其**每一级祖先**做链接检查：任一级是符号链接或
 * Windows 目录联接即拒绝，避免把调用方给的任意目录（或被替换的根）当受信根。
 *
 * @param {string} baseDir  待校验根
 * @param {string} label    错误信息中的名称
 * @param {object} options  { allowMissing: 根尚不存在时，只校验已存在的祖先 }
 */
function assertTrustedRoot(baseDir, label, options = {}) {
  const resolved = path.resolve(baseDir);
  const segments = [];
  let cursor = resolved;
  // 逐级向上收集：resolved 自身，以及它的每一级祖先
  for (;;) {
    segments.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const dir of segments) {
    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        if (options.allowMissing) continue; // 尚未创建，往上继续检查
        fail(`${label} 不存在：${dir}`);
      }
      if (error && (error.code === 'ENOTDIR' || error.code === 'ELOOP')) {
        fail(`${label} 路径不可用（可能经由链接或非目录）：${dir}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      fail(`${label} 自身或其祖先是符号链接/目录联接，已拒绝：${dir}`);
    }
  }
  return resolved;
}

/**
 * 真实路径包含判定：target 必须在 root 的**真实路径**之内。
 * 用于根已被确认无链接之后，再确认目标没有跳出。
 */
function assertRealInside(root, target, label) {
  const realRoot = fs.realpathSync(path.resolve(root));
  let realTarget;
  try {
    realTarget = fs.realpathSync(path.resolve(target));
  } catch (error) {
    if (error && error.code === 'ENOENT') return realRoot; // 尚不存在，交给调用方
    fail(`${label} 真实路径不可解析，已拒绝：${target}`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    fail(`${label} 真实路径逃逸出受信根，已拒绝：${target}`);
  }
  return realTarget;
}

/** 解析后的真实路径必须仍在 baseDir 之内，且途中不得经过符号链接/联接。 */
function resolveInside(baseDir, relPath, label, options = {}) {
  assertSafeRelative(relPath);
  // 先确认 baseDir 及其祖先本身不是链接（R2）。
  // 写入阶段目标根可能尚未创建，此时只校验**已存在的祖先**。
  assertTrustedRoot(baseDir, `${label} 的基目录`, { allowMissing: options.allowMissingBase === true });
  const target = path.resolve(baseDir, relPath);
  const baseResolved = path.resolve(baseDir);
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) {
    fail(`${label} 解析后逃逸出基目录：${relPath}`);
  }
  // 逐级 lstat：任一层是符号链接或 Windows 目录联接即拒绝
  let cursor = baseResolved;
  for (const segment of relPath.split('/')) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error && error.code === 'ENOENT') return target; // 尚不存在，交由调用方处理
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`${label} 路径含符号链接或目录联接，已拒绝：${relPath}`);
  }
  // 已存在时再做一次真实路径包含判定：即使 lstat 未标记为链接，
  // 指向基目录之外的路径也会在此被拦下（双保险，不替代上面的逐级检查）。
  if (fs.existsSync(cursor)) {
    assertRealInside(baseResolved, cursor, label);
  }
  return target;
}

// ── 入口关闭状态 ──────────────────────────────────────────────────────────

/**
 * 从**源入口源码**静态确认服务端开关为关闭、动态值为空。
 * 只读解析，不执行代码；不声称等同实际部署后的服务器状态。
 */
function assertEntryClosed(sourceText) {
  const problems = [];
  const block = /const SANDBOX_CONFIG = gate\.readConfig\(\{([\s\S]*?)\}\);/.exec(sourceText);
  if (!block) {
    fail('未能定位入口的 SANDBOX_CONFIG 配置块，入口结构已变化，拒绝生成关闭包。');
  }
  const body = block[1];
  const readField = name => {
    const m = new RegExp(`${name}\\s*:\\s*([^,\\n]+)`).exec(body);
    return m ? m[1].trim() : null;
  };
  if (readField('enabled') !== 'false') {
    problems.push(`入口 enabled 不是字面量 false（实际：${readField('enabled')}），不得生成关闭包。`);
  }
  for (const name of ['appId', 'envId', 'projectId', 'roundId', 'expiresAt', 'projectReadyMarker']) {
    const value = readField(name);
    if (value !== "''" && value !== '""') {
      problems.push(`入口动态值 ${name} 非空（实际：${value}），关闭包必须保持动态值为空。`);
    }
  }
  const allowed = readField('allowedUserIds');
  if (allowed !== '[]') {
    problems.push(`入口 allowedUserIds 非空（实际：${allowed}），关闭包必须保持允许名单为空。`);
  }
  if (problems.length) fail(problems);
  return {
    enabled: false,
    dynamicValuesEmpty: true,
    allowedUserIdsEmpty: true,
    note: '仅静态解析源入口源码；实际部署后仍须回读服务端状态，不得凭本字段认定已关闭。'
  };
}

// ── 源文件读取与基线核对 ──────────────────────────────────────────────────

function readSource(relPath, sourceDir = SOURCE_DIR) {
  // 排除项先判：即使文件不存在，也不允许把凭据/日志/历史证据路径纳入白名单。
  for (const pattern of EXCLUDED_PATTERNS) {
    if (relPath === pattern || relPath.split('/').includes(pattern)) {
      fail(`白名单条目命中排除项「${pattern}」：${relPath}`);
    }
  }
  const abs = resolveInside(sourceDir, relPath, '源文件');
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (error) {
    fail(`缺少白名单源文件：${relPath}`);
  }
  if (!stat.isFile()) fail(`白名单源文件不是普通文件：${relPath}`);
  return fs.readFileSync(abs);
}

/**
 * 与 110 文件本地基线核对（R1）。
 *
 * 默认与 CLI 路径下，基线**必须存在、可解析、字段完整**；缺失或损坏一律停止，
 * 不再「返回 checked:false 继续打包」。`options.allowMissingBaseline` 只供测试
 * 显式跳过使用，调用方必须自行区分，不得据此宣称已核验。
 */
function verifyAgainstBaseline(files, options = {}) {
  const baselinePath = options.baselinePath || BASELINE_PATH;
  const allowMissing = options.allowMissingBaseline === true;

  let raw;
  try {
    raw = fs.readFileSync(baselinePath, 'utf8');
  } catch (error) {
    if (allowMissing) {
      return { checked: false, skipped: true, reason: `测试显式跳过基线核对：${error.message}` };
    }
    fail(`验收基线不可读，已停止（不得跳过）：${baselinePath}\n  ${error.message}`);
  }

  let baseline;
  try {
    baseline = JSON.parse(raw);
  } catch (error) {
    fail(`验收基线不是合法 JSON，已停止：${baselinePath}\n  ${error.message}`);
  }

  // 字段完整性：缺 date / files / fileCount 一律停止
  const problems = [];
  if (!baseline || typeof baseline !== 'object') {
    fail(`验收基线结构无效，已停止：${baselinePath}`);
  }
  if (!baseline.files || typeof baseline.files !== 'object' || Array.isArray(baseline.files)) {
    fail(`验收基线缺少 files 字典，已停止：${baselinePath}`);
  }
  if (typeof baseline.fileCount !== 'number') {
    problems.push('基线缺少数字字段 fileCount');
  }
  for (const [key, value] of Object.entries(baseline.files)) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      problems.push(`基线条目 ${key} 的哈希不是 64 位十六进制`);
    }
  }
  if (problems.length) {
    fail(['验收基线字段不完整，已停止：', ...problems].join('\n'));
  }

  for (const entry of files) {
    const key = entry.sourceKey;
    if (!Object.prototype.hasOwnProperty.call(baseline.files, key)) {
      problems.push(`基线中无此文件记录：${key}`);
      continue;
    }
    if (baseline.files[key] !== entry.sha256) {
      problems.push(
        `与验收基线不一致：${key}\n    当前 ${entry.sha256}\n    基线 ${baseline.files[key]}`
      );
    }
  }
  if (problems.length) {
    fail(['源文件与验收基线存在差异，已停止（不自行修复）：', ...problems].join('\n'));
  }
  return { checked: true, skipped: false, fileCount: Object.keys(baseline.files).length, matched: files.length };
}

// ── 关闭包生成 ────────────────────────────────────────────────────────────

/**
 * 读取并严格校验既有 manifest（R1.2）。
 *
 * **不信 manifest 自报的 `packageVerification`**，而是：
 * - 必须可解析，且 schema 匹配当前格式；
 * - whitelist 必须与当前白名单逐项一致；
 * - files 的路径集合必须与当前白名单**完全相同**（无漏项、无重复、无额外项）；
 * - 每个文件的 bytes / sha256 必须与**实际源文件**一致（不是与 manifest 自己比）；
 * - **来源字段必须与实际计算值精确一致**（S1b）：sourceDir、packageDir 与每条 sourceKey。
 *   不把 manifest 自报的来源当事实；缺项也拒绝。
 * 无需给 manifest 添加自哈希声明，也不引入签名体系。
 *
 * @param {string} manifestPath
 * @param {Array} sourceFiles 已计算好的源文件事实（含 path/bytes/sha256/sourceKey）
 * @param {object} context { sourceDir, targetRoot } 实际来源目录与产物根
 */
function readAndValidateManifest(manifestPath, sourceFiles, context = {}) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    fail(`manifest 不可读：${manifestPath}\n  ${error.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    fail(`manifest 不是合法 JSON，已拒绝：${manifestPath}\n  ${error.message}`);
  }

  const problems = [];
  if (!doc || typeof doc !== 'object') fail(`manifest 结构无效：${manifestPath}`);
  if (doc.schema !== MANIFEST_SCHEMA) {
    problems.push(`manifest schema 不是 ${MANIFEST_SCHEMA}（实际：${doc.schema}）`);
  }
  if (!Array.isArray(doc.whitelist)) {
    problems.push('manifest 缺少 whitelist 数组');
  } else {
    const expected = PACKAGE_FILES.join('|');
    const actual = doc.whitelist.join('|');
    if (expected !== actual) {
      problems.push(`manifest 白名单与当前白名单不一致：${actual} ≠ ${expected}`);
    }
  }
  // ── 来源字段核对（S1b）：与实际计算值精确比对 ──
  if (context.sourceDir) {
    const expectedSourceDir = path.relative(ROOT, context.sourceDir).split(path.sep).join('/');
    if (doc.sourceDir === undefined) {
      problems.push('manifest 缺少 sourceDir');
    } else if (doc.sourceDir !== expectedSourceDir) {
      problems.push(`manifest sourceDir 与实际来源不符：${doc.sourceDir} ≠ ${expectedSourceDir}`);
    }
  }
  if (context.targetRoot) {
    const expectedPackageDir = path.relative(ROOT, context.targetRoot).split(path.sep).join('/');
    if (doc.packageDir === undefined) {
      problems.push('manifest 缺少 packageDir');
    } else if (doc.packageDir !== expectedPackageDir) {
      problems.push(`manifest packageDir 与实际产物根不符：${doc.packageDir} ≠ ${expectedPackageDir}`);
    }
  }
  if (!Array.isArray(doc.files)) {
    problems.push('manifest 缺少 files 数组');
  } else {
    const seen = new Set();
    for (const item of doc.files) {
      if (!item || typeof item.path !== 'string') {
        problems.push('manifest files 存在无效条目（缺 path）');
        continue;
      }
      if (seen.has(item.path)) problems.push(`manifest files 路径重复：${item.path}`);
      seen.add(item.path);
      if (!PACKAGE_FILES.includes(item.path)) {
        problems.push(`manifest files 出现白名单外路径：${item.path}`);
      }
    }
    for (const rel of PACKAGE_FILES) {
      if (!seen.has(rel)) problems.push(`manifest files 漏项：${rel}`);
    }
    // 与实际源文件逐项比对（不信 manifest 自报）
    for (const src of sourceFiles) {
      const row = doc.files.find(item => item && item.path === src.path);
      if (!row) continue;
      if (row.bytes !== src.bytes) {
        problems.push(`manifest 记录的字节数与源不符：${src.path}（${row.bytes} ≠ ${src.bytes}）`);
      }
      if (row.sha256 !== src.sha256) {
        problems.push(`manifest 记录的哈希与源不符：${src.path}（${row.sha256} ≠ ${src.sha256}）`);
      }
      // sourceKey 必须与实际计算值一致（旧 memberAccess 路径等篡改必须被拒）
      if (row.sourceKey === undefined) {
        problems.push(`manifest 条目缺少 sourceKey：${src.path}`);
      } else if (row.sourceKey !== src.sourceKey) {
        problems.push(`manifest sourceKey 与实际来源不符：${src.path}（${row.sourceKey} ≠ ${src.sourceKey}）`);
      }
    }
  }
  // 就绪标记不得被改成「已就绪」
  if (doc.entryState) {
    if (doc.entryState.enabled !== false) problems.push('manifest entryState.enabled 不是 false');
    if (doc.entryState.dynamicValuesEmpty !== true) problems.push('manifest 未确认动态值为空');
    if (doc.entryState.allowedUserIdsEmpty !== true) problems.push('manifest 未确认允许名单为空');
  } else {
    problems.push('manifest 缺少 entryState');
  }
  if (doc.packageVerification && doc.packageVerification.manifestSelfHash !== 'omitted-by-design') {
    problems.push('manifest 未声明 manifestSelfHash=omitted-by-design');
  }

  if (problems.length) {
    fail(['manifest 校验失败，已停止：', ...problems.map(item => `  ${item}`)].join('\n'));
  }
  return doc;
}

/**
 * 产物包体文件的**统一安全读点**（S2）。
 *
 * 生成与检查两个模式都必须经过这里：
 * 1. 用 lstat 判定，链接/目录联接一律拒绝（**即使相对名在白名单内**）；
 * 2. 非普通文件（目录、管道等）拒绝；
 * 3. 确认是普通文件后才读取，避免跟随链接读到包外内容。
 *
 * 之前检查模式用 `path.join + readFileSync` 直读，lstat 调用为 0，
 * 因此白名单文件若是链接也能通过检查——该分支由此封闭。
 *
 * @returns {{exists:false}|{exists:true, buffer:Buffer, byteMismatch?:boolean, hashMismatch?:boolean}}
 */
function safeReadPackageFile(targetRoot, relPath, expected = {}) {
  // 首次生成时 package/ 可能尚未创建：基目录允许缺失，只校验已存在的祖先
  const target = resolveInside(targetRoot, relPath, '产物文件', { allowMissingBase: true });
  if (!fs.existsSync(target)) return { exists: false };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fail(`产物文件是符号链接/目录联接，已拒绝（白名单文件同样适用）：${relPath}`);
  }
  if (!stat.isFile()) {
    fail(`产物文件不是普通文件，已拒绝：${relPath}`);
  }
  const buffer = fs.readFileSync(target);
  if (expected.bytes === undefined && expected.sha256 === undefined) {
    return { exists: true, buffer };
  }
  if (buffer.length !== expected.bytes) {
    return { exists: true, buffer, byteMismatch: true };
  }
  if (sha256(buffer) !== expected.sha256) {
    return { exists: true, buffer, hashMismatch: true };
  }
  return { exists: true, buffer };
}

/** 递归列出目录内所有普通文件（相对路径），用于「额外文件」检出。 */
function listFilesRecursive(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return out;
    throw error;
  }
  for (const item of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, item.name);
    if (item.isSymbolicLink()) out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), symlink: true });
    else if (item.isDirectory()) out.push(...listFilesRecursive(abs, base));
    else if (item.isFile()) out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), symlink: false });
  }
  return out;
}

// 制品目录允许出现的顶层条目（R1.3：检查**整个制品目录**，不只 package 子目录）。
const OUT_DIR_ALLOWED_TOP = Object.freeze(['manifest.json', 'package']);

/**
 * 受信输出根校验（R2）。
 *
 * - outDir 及其祖先不得是符号链接/目录联接；
 * - outDir 不得与源目录重叠，也不得是源目录的祖先（防止写回源目录）；
 * - outDir 不得等于仓库根。
 * 测试可用 `options.allowUntrustedOutDir` 显式放行到受控临时根，但该开关
 * 不暴露给 CLI，主入口永远走严格分支。
 */
function assertTrustedOutDir(outDir, sourceDir, options = {}) {
  const resolved = path.resolve(outDir);
  assertTrustedRoot(resolved, '输出根', { allowMissing: true });
  assertRealInside(ROOT, resolved, '输出根');

  if (options.allowUntrustedOutDir === true) {
    return { resolved, trusted: false, reason: '测试显式放行（非 CLI 路径）' };
  }

  const sourceResolved = path.resolve(sourceDir);
  const overlaps =
    resolved === sourceResolved ||
    resolved.startsWith(sourceResolved + path.sep) ||
    sourceResolved.startsWith(resolved + path.sep);
  if (overlaps) {
    fail(`输出根与源目录重叠，已拒绝：${resolved}`);
  }
  if (resolved === path.resolve(ROOT)) {
    fail('输出根不得为仓库根目录。');
  }
  // 输出根必须位于仓库内的制品目录之下（防止把任意调用方目录当受信根）
  const artifactsRoot = path.resolve(ARTIFACTS_ROOT);
  if (resolved !== artifactsRoot && !resolved.startsWith(artifactsRoot + path.sep)) {
    fail(`输出根必须位于仓库制品目录 ${artifactsRoot} 之下，已拒绝：${resolved}`);
  }
  return { resolved, trusted: true };
}

/**
 * 生成（或复用）关闭候选包。
 *
 * 流程按「预检 → 写入 → 回读」组织（R1.3）：
 * 预检阶段完成源读取、入口关闭确认、基线核对、候选清单核对、受信根检查、
 * 既有文件冲突检查、额外文件检查与既有 manifest 冲突检查。
 **可预知的失败一律发生在任何写入之前**；中途真实 I/O 故障可能留下部分新文件，
 * 此类情况如实报告为未完成，不声称任何失败都零写。
 *
 * @param {object} options
 * @param {string} options.outDir 输出目录
 * @param {boolean} options.checkOnly 只校验，不写入
 * @param {boolean} options.verifyBaseline 是否与基线核对（默认 true；关闭需显式 skipBaseline）
 * @param {boolean} options.skipBaseline 测试专用：显式跳过基线（结果标 checked:false, skipped:true）
 * @param {boolean} options.skipCandidateCheck 测试专用：显式跳过候选清单核对
 * @param {string} options.sourceDir 源目录（默认已验收 scheduleSandbox 目录）
 * @param {string} options.baselinePath 基线文件路径
 * @param {string} options.candidatePath 候选清单路径
 * @param {boolean} options.allowUntrustedOutDir 测试专用：允许仓库外受控临时根
 */
function buildPackage(options = {}) {
  const outDir = options.outDir || DEFAULT_OUT_DIR;
  const checkOnly = options.checkOnly === true;
  const skipBaseline = options.skipBaseline === true;
  const sourceDir = options.sourceDir || SOURCE_DIR;

  // ── 预检 1：受信根与输出根边界（R2）──
  const outInfo = assertTrustedOutDir(outDir, sourceDir, options);
  const targetRoot = path.join(outInfo.resolved, 'package');
  const manifestPath = path.join(outInfo.resolved, 'manifest.json');
  // package 根与 manifest 自身同样做根/祖先检查
  assertTrustedRoot(targetRoot, '产物 package 根', { allowMissing: true });
  if (fs.existsSync(manifestPath)) {
    assertRealInside(outInfo.resolved, manifestPath, 'manifest');
    const manifestStat = fs.lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink()) fail('manifest 自身是符号链接/目录联接，已拒绝。');
    if (!manifestStat.isFile()) fail('manifest 不是普通文件，已拒绝。');
  }

  // ── 预检 2：源文件 + 入口关闭状态 ──
  assertTrustedRoot(sourceDir, '源根', { allowMissing: false });
  const entrySource = readSource('index.js', sourceDir);
  const entryState = assertEntryClosed(entrySource.toString('utf8'));

  const files = PACKAGE_FILES.map(relPath => {
    const buffer = readSource(relPath, sourceDir);
    assertSafeRelative(relPath);
    resolveInside(sourceDir, relPath, '源文件');
    return {
      path: relPath,
      bytes: buffer.length,
      sha256: sha256(buffer),
      sourceKey: path.relative(ROOT, path.join(sourceDir, relPath)).split(path.sep).join('/'),
      _buffer: buffer
    };
  });

  // ── 预检 3：基线核对（缺失/损坏/差异一律停止）──
  const baseline = skipBaseline
    ? { checked: false, skipped: true, reason: '测试显式跳过基线核对（不得据此宣称已核验）' }
    : verifyAgainstBaseline(files, {
        baselinePath: options.baselinePath,
        allowMissingBaseline: false
      });

  // ── 预检 4：资源候选清单核对（**在打包之前**）──
  let candidate = { checked: false, skipped: true, reason: '测试显式跳过候选清单核对' };
  if (options.skipCandidateCheck !== true) {
    const result = checkResourceCandidate({ filePath: options.candidatePath });
    candidate = {
      checked: true,
      skipped: false,
      collections: result.collections,
      indexes: result.indexes,
      status: result.status
    };
  }

  // ── 预检 5：既有产物事实校验（额外文件 / 冲突 / manifest）──
  // 5a. 整个制品目录的顶层允许项
  const outEntries = listFilesRecursive(outInfo.resolved);
  for (const item of outEntries) {
    const top = item.rel.split('/')[0];
    if (!OUT_DIR_ALLOWED_TOP.includes(top)) {
      fail([
        '制品目录存在允许项之外的文件，已停止（生成与检查模式均拒绝）：',
        `  ${item.rel}${item.symlink ? '（符号链接/目录联接）' : ''}`,
        `允许的顶层条目：${OUT_DIR_ALLOWED_TOP.join('、')}`
      ].join('\n'));
    }
  }
  // 5b. package 子目录内的额外文件
  //     **同时**拒绝任何链接条目（即使其相对名在白名单内）——S2：
  //     不能只筛「额外」链接，白名单文件若是链接同样必须拒绝。
  const listedPackageFiles = listFilesRecursive(targetRoot);
  const extraPackageFiles = listedPackageFiles.filter(
    item => !PACKAGE_FILES.includes(item.rel)
  );
  if (extraPackageFiles.length) {
    fail([
      '产物 package 目录存在白名单外文件，已停止：',
      ...extraPackageFiles.map(item => `  ${item.rel}${item.symlink ? '（符号链接/目录联接）' : ''}`)
    ].join('\n'));
  }
  const linkedPackageFiles = listedPackageFiles.filter(item => item.symlink);
  if (linkedPackageFiles.length) {
    fail([
      '产物 package 目录存在链接条目，已停止（白名单文件同样适用）：',
      ...linkedPackageFiles.map(item => `  ${item.rel}（符号链接/目录联接）`)
    ].join('\n'));
  }

  // 5c. 既有包体文件与源/manifest 的三方一致性
  //     **不依赖 manifest 是否存在**：半成品（无 manifest 的不一致包体）同样在预检拒绝。
  //     读点统一走 safeReadPackageFile：先 lstat 判链接、再判普通文件，才读取。
  const facts = { missing: [], byteMismatch: [], hashMismatch: [] };
  if (fs.existsSync(manifestPath)) {
    facts.manifest = readAndValidateManifest(manifestPath, files, {
      sourceDir,
      targetRoot
    });
  }
  for (const entry of files) {
    // 统一安全读点：拒绝链接与非普通文件（S2），并与源比对
    const read = safeReadPackageFile(targetRoot, entry.path, {
      bytes: entry.bytes,
      sha256: entry.sha256
    });
    if (!read.exists) {
      // 缺文件记录在 facts.missing：
      // - **有 manifest** 时，manifest 已声明该文件 → 属可预知不一致，必须在任何写入前拒绝；
      // - **无 manifest** 时属合法半成品（尚未生成），允许续建。
      facts.missing.push(entry.path);
      continue;
    }
    if (read.byteMismatch) facts.byteMismatch.push(entry.path);
    else if (read.hashMismatch) facts.hashMismatch.push(entry.path);
  }

  // 5d. 冲突一律拒绝（**不依赖 manifest 存在**）——S1a
  const conflictProblems = [
    ...facts.byteMismatch.map(name => `包体字节数与源不符：${name}`),
    ...facts.hashMismatch.map(name => `包体内容与源不符：${name}`)
  ];
  if (conflictProblems.length) {
    fail([
      '既有产物包体与源不一致，已停止（可预知失败，未写入任何新文件）：',
      ...conflictProblems.map(item => `  ${item}`),
      '请人工确认差异来源后，移走整个输出目录再重新生成；本工具不递归删除、不静默覆盖。'
    ].join('\n'));
  }

  // 有 manifest 时核对其声明的完整性：缺文件同样在**任何写入前**拒绝。
  // （无 manifest 的合法半成品不在此列，允许续建）
  if (fs.existsSync(manifestPath)) {
    const problems = [];
    for (const name of facts.missing) problems.push(`manifest 声明了但包体缺失：${name}`);
    if (problems.length) {
      fail([
        '既有关闭包与 manifest 不一致，已停止（可预知失败，未写入任何新文件）：',
        ...problems.map(item => `  ${item}`),
        '如需重新生成，请人工确认后移走整个输出目录；本工具不递归删除、不静默覆盖。'
      ].join('\n'));
    }
  }

  if (checkOnly) {
    if (!fs.existsSync(manifestPath)) fail(`关闭包不存在（--check）：${manifestPath}`);
    // 预检已覆盖缺失/额外/链接/冲突/manifest 一致性；此处只确认存在
    for (const entry of files) {
      if (!safeReadPackageFile(targetRoot, entry.path).exists) fail(`产物缺失：${entry.path}`);
    }
    return {
      mode: 'check',
      outDir: outInfo.resolved,
      files: files.map(stripBuffer),
      entryState,
      baseline,
      candidate,
      extraFiles: extraPackageFiles.length
    };
  }

  // ── 写入阶段（预检已全部通过）──
  const written = [];
  const writeFailures = [];
  for (const entry of files) {
    const target = resolveInside(targetRoot, entry.path, '产物文件', { allowMissingBase: true });
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target);
      if (existing.length === entry.bytes && sha256(existing) === entry.sha256) {
        written.push({ path: entry.path, action: 'reused' });
        continue;
      }
      // 预检已在 5c 拦截；此处为写入期二次防线
      fail(
        `产物已存在且与源不一致，拒绝覆盖：${entry.path}\n` +
        '请人工确认差异来源后，移走整个输出目录再重新生成；本工具不递归删除、不静默覆盖。'
      );
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry._buffer);
    } catch (error) {
      writeFailures.push(`${entry.path}: ${error.message}`);
      break;
    }
    written.push({ path: entry.path, action: 'created' });
  }
  if (writeFailures.length) {
    // 中途真实 I/O 故障：如实说明未完成并保留可核对状态，不递归删除。
    fail([
      '写入阶段发生真实 I/O 故障，包**未完成**。已保留可核对状态，请人工检查后处理：',
      ...writeFailures.map(item => `  ${item}`),
      `已写入 ${written.filter(item => item.action === 'created').length} 个文件；本工具不递归删除已写入文件。`
    ].join('\n'));
  }

  // ── 回读验证 ──
  for (const entry of files) {
    const target = path.join(targetRoot, entry.path);
    if (!fs.existsSync(target)) fail(`回读失败，产物不存在：${entry.path}`);
    const actual = fs.readFileSync(target);
    if (actual.length !== entry.bytes || sha256(actual) !== entry.sha256) {
      fail(`回读失败，产物与源不一致：${entry.path}`);
    }
  }

  // ── manifest（**不含自身哈希声明**，避免循环）──
  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedBy: 'miniapp/scripts/package-sandbox.cjs',
    purpose: '本地关闭候选制品；不是云端部署包，也不是已部署证明。',
    sourceDir: path.relative(ROOT, sourceDir).split(path.sep).join('/'),
    packageDir: path.relative(ROOT, targetRoot).split(path.sep).join('/'),
    whitelist: PACKAGE_FILES.slice(),
    excludedPatterns: EXCLUDED_PATTERNS.slice(),
    entryState,
    baseline,
    resourceCandidate: candidate,
    packageVerification: {
      perFileReadBack: true,
      byteIdenticalToSource: true,
      extraFiles: [],
      manifestSelfHash: 'omitted-by-design'
    },
    limitations: [
      '本包只是本地候选制品：运行时、依赖安装方式与平台部署配置尚未审查或回读。',
      '本地文件哈希不是云端编译后包的哈希。',
      'prepare / execute 将来生成时须各自重新记录哈希，不用关闭包哈希代替。',
      '服务器实际关闭状态须部署后回读，不得凭包名或本 manifest 认定。',
      '合成依赖下的关闭态验证不等于实际 wx-server-sdk 或平台事务已验证。',
      '写入阶段若发生真实 I/O 故障，包可能只写入部分文件即中止；此时以本工具的校验结果判断完整性，存在 manifest 不等于已校验通过。',
      'manifest 的 sourceDir / packageDir / 各 sourceKey 在校验时会与实际计算值比对，但本工具不提供签名或自哈希，来源记录不等于防篡改证明。'
    ],
    files: files.map(stripBuffer)
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  if (fs.existsSync(manifestPath)) {
    const existing = fs.readFileSync(manifestPath, 'utf8');
    if (existing !== manifestText) {
      fail(
        `manifest 已存在且内容不同，拒绝覆盖：${manifestPath}\n` +
        '请人工确认差异来源后，移走整个输出目录再重新生成。'
      );
    }
  } else {
    fs.writeFileSync(manifestPath, manifestText);
  }

  return {
    mode: written.some(item => item.action === 'created') ? 'created' : 'reused',
    outDir: outInfo.resolved,
    manifestPath,
    files: files.map(stripBuffer),
    written,
    extraFiles: extraPackageFiles.length,
    entryState,
    baseline,
    candidate
  };
}

function stripBuffer(entry) {
  const { _buffer, ...rest } = entry;
  return rest;
}

// ── L2 资源候选清单校验 ───────────────────────────────────────────────────

/**
 * 校验资源候选清单。**只做本地一致性检查**，不生成平台 API 请求，不调用云端。
 * 未知集合、旧集合、额外函数、HTTP/定时触发器、公开权限、字段顺序或唯一性变动 → 失败。
 */
function checkResourceCandidate(options = {}) {
  const filePath = options.filePath || CANDIDATE_PATH;
  const problems = [];
  if (!fs.existsSync(filePath)) fail(`资源候选清单不存在：${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf8');
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    fail(`资源候选清单不是合法 JSON：${error.message}`);
  }
  return validateCandidateDocument(doc, problems, filePath);
}

function validateCandidateDocument(doc, problems, label) {
  const at = name => `${label}#${name}`;

  // 固定目标
  const target = doc.target || {};
  if (target.appId !== 'wxfb4db1615ac15531') problems.push(`${at('target.appId')} 不是固定 AppID。`);
  if (target.envId !== 'cloud1-d8gcq5ag39d847723') problems.push(`${at('target.envId')} 不是固定环境。`);
  if (target.functionName !== 'scheduleSandbox') problems.push(`${at('target.functionName')} 不是 scheduleSandbox。`);
  if (target.region !== 'ap-shanghai') problems.push(`${at('target.region')} 不是上海。`);

  // 函数：只允许新增 scheduleSandbox，不得含触发器/网关/额外函数
  const fn = doc.function || {};
  if (fn.name !== 'scheduleSandbox') problems.push(`${at('function.name')} 必须为 scheduleSandbox。`);
  if (fn.deployRoot !== 'miniapp/cloudfunctions/scheduleSandbox') {
    problems.push(`${at('function.deployRoot')} 必须只指向 scheduleSandbox 目录。`);
  }
  if (fn.handler !== 'index.main') problems.push(`${at('function.handler')} 必须为 index.main。`);
  for (const forbidden of ['triggers', 'httpAccess', 'timerTriggers', 'layers', 'preConcurrency']) {
    if (fn[forbidden] !== undefined && !isZeroOrEmpty(fn[forbidden])) {
      problems.push(`${at('function.' + forbidden)} 必须为新增 0 / 空，不得配置。`);
    }
  }
  const otherFunctions = doc.otherFunctionsCreated || [];
  if (otherFunctions.length !== 0) {
    problems.push(`${at('otherFunctionsCreated')} 必须为空数组：不得新增额外函数。`);
  }
  if (fn.runtime) {
    if (fn.runtime.nodejs !== '20.19') problems.push(`${at('function.runtime.nodejs')} 候选规格为 Nodejs20.19。`);
    if (fn.runtime.memoryMB !== 256) problems.push(`${at('function.runtime.memoryMB')} 候选规格为 256 MB。`);
    if (fn.runtime.timeoutSeconds !== 3) problems.push(`${at('function.runtime.timeoutSeconds')} 候选规格为 3 秒。`);
    if (fn.runtime.type !== 'Event') problems.push(`${at('function.runtime.type')} 候选规格为 Event。`);
  }

  // 11 集合
  const collections = doc.collections || [];
  if (collections.length !== EXPECTED_COLLECTION_COUNT) {
    problems.push(`${at('collections')} 数量应为 ${EXPECTED_COLLECTION_COUNT}，实际 ${collections.length}。`);
  }
  const seenCollections = new Set();
  for (const item of collections) {
    const name = item && item.name;
    if (typeof name !== 'string' || !name.startsWith(EXPECTED_PREFIX)) {
      problems.push(`${at('collections')} 集合名必须以 ${EXPECTED_PREFIX} 开头：${name}`);
      continue;
    }
    if (seenCollections.has(name)) problems.push(`${at('collections')} 集合重复：${name}`);
    seenCollections.add(name);
    if (item.permission !== 'ADMINONLY') {
      problems.push(`${at('collections.' + name + '.permission')} 必须为 ADMINONLY，客户端直接读写须拒绝。`);
    }
    // S3：ttlEnabled 与 created 必须**显式**为 false；缺字段或改值都拒绝
    if (item.ttlEnabled === undefined) {
      problems.push(`${at('collections.' + name + '.ttlEnabled')} 缺失：必须显式为 false（禁止 TTL 自动清理）。`);
    } else if (item.ttlEnabled !== false) {
      problems.push(`${at('collections.' + name + '.ttlEnabled')} 必须为 false，实际 ${item.ttlEnabled}。`);
    }
    if (item.created === undefined) {
      problems.push(`${at('collections.' + name + '.created')} 缺失：必须显式为 false（本轮未创建）。`);
    } else if (item.created !== false) {
      problems.push(`${at('collections.' + name + '.created')} 必须为 false，实际 ${item.created}。`);
    }
    if (item.access !== 'server-controlled') {
      problems.push(`${at('collections.' + name + '.access')} 必须声明为服务端受控业务访问。`);
    }
  }
  // 与 collection-map.js 的固定表交叉核对
  try {
    const map = require(path.join(SOURCE_DIR, 'collection-map.js'));
    const expected = map.LOGICAL_COLLECTIONS.map(n => EXPECTED_PREFIX + n);
    for (const name of expected) {
      if (!seenCollections.has(name)) problems.push(`${at('collections')} 缺少固定映射表中的集合：${name}`);
    }
    for (const name of seenCollections) {
      if (!expected.includes(name)) problems.push(`${at('collections')} 出现固定映射表以外的集合：${name}`);
    }
    if (collections.length === EXPECTED_COLLECTION_COUNT && expected.length !== EXPECTED_COLLECTION_COUNT) {
      problems.push(`${at('collections')} collection-map.js 的固定集合数与 ${EXPECTED_COLLECTION_COUNT} 不一致。`);
    }
  } catch (error) {
    problems.push(`无法读取 collection-map.js 做交叉核对：${error.message}`);
  }

  // 13 索引：按**已审查规格**逐条严格匹配（R3）
  const indexes = doc.indexes || [];
  if (indexes.length !== EXPECTED_INDEX_COUNT) {
    problems.push(`${at('indexes')} 数量应为 ${EXPECTED_INDEX_COUNT}，实际 ${indexes.length}。`);
  }
  const byId = new Map();
  for (const item of indexes) {
    const id = item && item.id;
    if (typeof id !== 'string' || !/^I\d{2}$/.test(id)) {
      problems.push(`${at('indexes')} 索引编号须形如 I01：${id}`);
      continue;
    }
    if (byId.has(id)) problems.push(`${at('indexes')} 索引编号重复：${id}`);
    byId.set(id, item);
  }
  for (const spec of APPROVED_INDEX_SPECS) {
    const item = byId.get(spec.id);
    if (!item) {
      problems.push(`${at('indexes')} 缺少已审查索引：${spec.id}`);
      continue;
    }
    if (item.collection !== spec.collection) {
      problems.push(`${at('indexes.' + spec.id)}.collection) 应为 ${spec.collection}，实际 ${item.collection}。`);
    }
    if (!Array.isArray(item.keys) || item.keys.length === 0) {
      problems.push(`${at('indexes.' + spec.id + '.keys')} 字段序列不得为空。`);
    } else if (item.keys.length !== spec.keys.length) {
      problems.push(
        `${at('indexes.' + spec.id + '.keys')} 字段数应为 ${spec.keys.length}，实际 ${item.keys.length}。`
      );
    } else {
      // 字段**有序**序列逐项匹配：顺序、名称、方向任一不符即失败
      spec.keys.forEach((expectedKey, index) => {
        const actualKey = item.keys[index];
        if (!actualKey || typeof actualKey !== 'object') {
          problems.push(`${at('indexes.' + spec.id + '.keys')} 第 ${index + 1} 项不是对象。`);
          return;
        }
        if (actualKey.name !== expectedKey.name) {
          problems.push(
            `${at('indexes.' + spec.id + '.keys')} 第 ${index + 1} 项字段名应为 ${expectedKey.name}，实际 ${actualKey.name}（字段顺序不可变更）。`
          );
        }
        if (actualKey.direction !== expectedKey.direction) {
          problems.push(
            `${at('indexes.' + spec.id + '.keys')}.${expectedKey.name}) 方向应为 ${expectedKey.direction}，实际 ${actualKey.direction}。`
          );
        }
      });
    }
    if (item.unique !== spec.unique) {
      problems.push(`${at('indexes.' + spec.id)}.unique) 应为 ${spec.unique}，实际 ${item.unique}。`);
    }
    if (item.ttl !== false) problems.push(`${at('indexes.' + spec.id)}.ttl) 必须为 false。`);
    if (typeof item.queryOrigin !== 'string' || item.queryOrigin === '') {
      problems.push(`${at('indexes.' + spec.id)}.queryOrigin) 必须记录真实查询位置与过滤/排序。`);
    }
    if (item.created !== false) problems.push(`${at('indexes.' + spec.id)}.created) 必须标注未创建。`);
  }

  // 候选函数规格：必填且精确匹配（删除即失败）
  if (fn.runtime === undefined || fn.runtime === null || typeof fn.runtime !== 'object') {
    problems.push(`${at('function.runtime')} 必填且必须是对象：候选函数规格不得删除。`);
  } else {
    for (const [key, value] of Object.entries(APPROVED_FUNCTION_RUNTIME)) {
      if (fn.runtime[key] !== value) {
        problems.push(`${at('function.runtime.' + key)} 应为 ${value}，实际 ${fn.runtime[key]}。`);
      }
    }
    for (const key of Object.keys(fn.runtime)) {
      if (!Object.prototype.hasOwnProperty.call(APPROVED_FUNCTION_RUNTIME, key)) {
        problems.push(`${at('function.runtime')} 出现未审查字段：${key}`);
      }
    }
  }
  // 依赖锁定：版本与来源必须与已审查清单精确一致，且保持未安装（S3）
  if (fn.dependency === undefined || fn.dependency === null || typeof fn.dependency !== 'object') {
    problems.push(`${at('function.dependency')} 必填：依赖版本锁定不得删除。`);
  } else {
    if (fn.dependency.wxServerSdk !== APPROVED_DEPENDENCY.wxServerSdk) {
      problems.push(
        `${at('function.dependency.wxServerSdk')} 必须锁定为 ${APPROVED_DEPENDENCY.wxServerSdk}，实际 ${fn.dependency.wxServerSdk}。`
      );
    }
    if (fn.dependency.packageJson !== APPROVED_DEPENDENCY.packageJson) {
      problems.push(
        `${at('function.dependency.packageJson')} 必须指向当前副本 ${APPROVED_DEPENDENCY.packageJson}，实际 ${fn.dependency.packageJson}。`
      );
    }
    if (fn.dependency.installThisRound !== false) {
      problems.push(`${at('function.dependency.installThisRound')} 必须为 false：本轮不安装。`);
    }
    // 依赖声明中的实际锁定版本必须与 package.json 一致（防止清单与副本脱节）
    try {
      const pkgPath = path.join(SOURCE_DIR, 'package.json');
      const actual = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const locked = actual && actual.dependencies && actual.dependencies['wx-server-sdk'];
      if (locked !== fn.dependency.wxServerSdk) {
        problems.push(
          `${at('function.dependency.wxServerSdk')} 与副本 package.json 实际锁定版本不符：` +
          `${fn.dependency.wxServerSdk} ≠ ${locked}`
        );
      }
    } catch (error) {
      problems.push(`无法读取副本 package.json 核对依赖锁定：${error.message}`);
    }
  }
  if (!doc.platformPrimaryKeys || doc.platformPrimaryKeys.count !== EXPECTED_COLLECTION_COUNT) {
    problems.push(
      `${at('platformPrimaryKeys.count')} 应为 ${EXPECTED_COLLECTION_COUNT}（11 个 _id 主键索引由平台创建，不重复创建）。`
    );
  }

  // 执行就绪度：必须显式为 false，不得把本地计划标为可执行部署配置
  if (doc.executable !== false) {
    problems.push(`${at('executable')} 必须显式为 false：平台 API 参数形状未核对，不能标记为可执行部署配置。`);
  }
  if (typeof doc.status !== 'string' || !/候选|未创建|未验证/.test(doc.status)) {
    problems.push(`${at('status')} 必须标注候选/未创建/平台适配未验证。`);
  }
  if (doc.containsPlatformApiRequest !== false) {
    problems.push(`${at('containsPlatformApiRequest')} 必须显式为 false：清单不是可直接提交的平台 API 请求。`);
  }

  if (problems.length) fail(['资源候选清单校验失败：', ...problems].join('\n'));
  return {
    filePath: label,
    collections: collections.length,
    indexes: indexes.length,
    status: doc.status,
    executable: doc.executable === true
  };
}

// ── 入口校验（模块化）──────────────────────────────────────────────────────

function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes('--check');
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && !outDir) {
    console.error('--out 需要指定目录');
    process.exitCode = 1;
    return;
  }
  try {
    // CLI 路径：不传任何测试放行开关。基线与候选清单都是**强制**核对项，
    // 且候选清单在打包之前校验（顺序错误会直接失败，不会先写出包）。
    const result = buildPackage({ outDir, checkOnly });
    console.log(
      `关闭候选包${result.mode === 'check' ? '校验' : '生成'}：${result.outDir}`
    );
    for (const entry of result.files) {
      console.log(`  ${entry.path}  bytes=${entry.bytes}  sha256=${entry.sha256}`);
    }
    console.log(`入口静态确认：enabled=false，动态值为空，允许名单为空（${result.entryState.note}）`);
    if (result.baseline && result.baseline.checked) {
      console.log(`110 文件基线核对：匹配 ${result.baseline.matched} 个白名单文件。`);
    } else {
      console.log(
        `110 文件基线核对：**未通过**（${(result.baseline && result.baseline.reason) || '未知'}）。`
      );
    }
    if (result.candidate && result.candidate.checked) {
      console.log(`资源候选清单：${result.candidate.collections} 集合 / ${result.candidate.indexes} 索引（在打包前核对）。`);
    } else {
      console.log(`资源候选清单：**未核对**（${(result.candidate && result.candidate.reason) || '未知'}）。`);
    }
    if (result.mode !== 'check') {
      console.log(`manifest：${result.manifestPath}（不含自身哈希声明）`);
      const created = result.written.filter(item => item.action === 'created').length;
      const reused = result.written.filter(item => item.action === 'reused').length;
      console.log(`写入：新建 ${created} 个，复用 ${reuseText(reused)} 个。`);
      console.log(`额外文件检出：${result.extraFiles} 个。`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function reuseText(n) {
  return String(n);
}

/** 触发器/网关/层等「新增 0」项的宽松判定：空数组、空对象、0、false、null 均视为未配置。 */
function isZeroOrEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

if (require.main === module) {
  main();
}

module.exports = {
  ROOT,
  SOURCE_DIR,
  DEFAULT_OUT_DIR,
  ARTIFACTS_ROOT,
  BASELINE_PATH,
  CANDIDATE_PATH,
  PACKAGE_FILES,
  EXCLUDED_PATTERNS,
  EXPECTED_PREFIX,
  EXPECTED_COLLECTION_COUNT,
  EXPECTED_INDEX_COUNT,
  MANIFEST_SCHEMA,
  APPROVED_INDEX_SPECS,
  APPROVED_FUNCTION_RUNTIME,
  APPROVED_DEPENDENCY,
  OUT_DIR_ALLOWED_TOP,
  assertSafeRelative,
  assertTrustedRoot,
  assertRealInside,
  assertTrustedOutDir,
  resolveInside,
  assertEntryClosed,
  readSource,
  verifyAgainstBaseline,
  readAndValidateManifest,
  safeReadPackageFile,
  buildPackage,
  checkResourceCandidate,
  validateCandidateDocument,
  listFilesRecursive
};
