#!/usr/bin/env node
/**
 * 证据脚本：真实登记包最小接线（本地候选模式）
 * =============================================
 *
 * 独立复现本轮交付。**不修改任何历史证据**，只输出 stdout；
 * 运行方如需保存结果请另取独占文件名。
 *
 * 本轮性质（重要）：
 *  - 只实现并验证**本地候选接线能力**，使用**受控历史时钟**与**离线夹具**；
 *  - `synthetic=false` 是**被测计划契约**，测试传输、wx 与存储仍为合成对象；
 *  - **不确定实际登记轮次/窗口**，不产出可交给用户操作的当次真实执行包；
 *  - 候选清单**不是**部署授权、云端证明、本人身份复核或批准签发。
 *
 * 记录内容：
 *  1. 接手时全部已跟踪文件的字节基线，运行前后比较；
 *  2. 两模式 schema/契约分离与默认合成防线保持；
 *  3. 候选完整正向（49 文件、八文件逐字节、唯一页面、差异面）；
 *  4. 反例零写快照（非法计划、输入漂移、冲突、额外项、过期、篡改）；
 *  5. 过期按**当前时钟**拒绝，且篡改 generatedAt 不能救活；
 *  6. 合法续建与完整复用（含 /1 合成包兼容、模式不互相认领）；
 *  7. 独立关闭制品检查不受登记到期影响；
 *  8. 两份完整项目的实际 App/Page/client 合成调用链；
 *  9. 网络拦截的**实际拦截点范围**与敏感性检查（不硬写 network=0）。
 *
 * 边界：本轮不执行真实 SDK、微信工具、真实凭据或任何网络请求。
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

const BASELINE_COMMIT = 'b274da4';
const FIXED_TARGET_USER = 'u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4';

/** 受控历史时钟与窗口：2026-03-01T12:00Z 起 20 分钟（≤30 分钟上限）。 */
const CAND_NOW_MS = Date.parse('2026-03-01T12:00:00.000Z');
const CAND_START = '2026-03-01T12:00:00.000Z';
const CAND_EXPIRES = '2026-03-01T12:20:00.000Z';
/** 合成包沿用更早的固定窗口（与历史 /1 口径一致）。 */
const SYNTH_NOW_MS = Date.parse('2026-01-01T00:05:00.000Z');
const SYNTH_START = '2026-01-01T00:00:00.000Z';
const SYNTH_EXPIRES = '2026-01-01T00:20:00.000Z';
const SYNTH_OPENID = 'synthetic-assembly-openid';

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function deriveUserId(openid) {
  return 'u_' + sha256(Buffer.from(`${reg.FIXED_TARGET.appId}:${openid}`)).slice(0, 40);
}
function freshId(prefix) { return prefix + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20); }
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

const report = {
  startedAt: new Date().toISOString(),
  baselineCommit: BASELINE_COMMIT,
  nature: {
    localWiringOnly: true,
    producesRealExecutionPackage: false,
    deploymentAuthorized: false,
    verificationKind: asm.VERIFICATION_KIND,
    note: 'synthetic=false 是被测计划契约；时钟、wx 与存储仍为受控合成，候选清单不是部署授权或批准签发。'
  },
  controlledClock: {
    candidateNow: new Date(CAND_NOW_MS).toISOString(),
    candidateWindow: [CAND_START, CAND_EXPIRES],
    syntheticNow: new Date(SYNTH_NOW_MS).toISOString(),
    syntheticWindow: [SYNTH_START, SYNTH_EXPIRES],
    note: '受控历史时钟仅用于离线夹具复跑；不代表实际登记轮次或真实窗口。'
  },
  groups: [],
  protectedBaseline: {},
  networkGuard: {},
  counts: { networkAttempts: 0, cloudCalls: 0, credentialsFetched: 0, realSdkExecuted: 0 },
  unverified: []
};
function group(name, checks) {
  report.groups.push({
    group: name,
    total: checks.length,
    passed: checks.filter(c => c.ok).length,
    checks
  });
}

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
function sameSnapshot(a, b) { return canonical(a) === canonical(b); }

// ── 1. 受保护文件字节基线 ────────────────────────────────────────────────────
function resolveGit() {
  for (const exe of [process.env.GIT_EXECUTABLE, 'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files/Git/bin/git.exe', 'git'].filter(Boolean)) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (!r.error && r.status === 0) return exe;
  }
  return null;
}
const GIT_EXE = resolveGit();
function gitOutput(args) {
  if (!GIT_EXE) return null;
  const r = spawnSync(GIT_EXE, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return (r.error || r.status !== 0) ? null : r.stdout;
}
function trackedFiles() {
  const out = gitOutput(['ls-files', '-z']);
  return out === null ? null : out.split('\0').filter(Boolean);
}
function hashTracked() {
  const files = trackedFiles();
  const map = new Map();
  if (files === null) return map;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    map.set(rel, fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null);
  }
  return map;
}
const baselineBefore = hashTracked();
const baselineTracked = trackedFiles();

// ── 2. 网络实际拦截（含拦截点范围记录） ─────────────────────────────────────
const netState = asm.installNetworkGuard({});
report.networkGuard = {
  installedPoints: netState.attempts === undefined ? [] : [
    'http.request', 'https.request', 'net.connect', 'net.createConnection',
    'dns.lookup', 'dns.resolve'
  ],
  scope: '本进程内 Node 模块拦截点；不是系统级网络审计，也不覆盖原生编译器内部调用。',
  sensitivityCheck: null,
  attemptsDuringWork: 0
};

// ── 计划构造 ─────────────────────────────────────────────────────────────────
function candidatePlan(patch = {}) {
  return {
    purpose: 'offline-fixture real-candidate wiring verification',
    appId: reg.FIXED_TARGET.appId,
    envId: reg.FIXED_TARGET.envId,
    region: reg.FIXED_TARGET.region,
    functionName: reg.FIXED_TARGET.functionName,
    allowedUserIds: [FIXED_TARGET_USER],
    roundId: 'OFFLINE-FIXTURE-CAND-0001',
    windowStartsAt: CAND_START,
    windowExpiresAt: CAND_EXPIRES,
    sourceVersion: reg.REVIEWED_SOURCE_VERSION,
    synthetic: false,
    ...patch
  };
}
function syntheticPlan(patch = {}) {
  return {
    purpose: 'offline-fixture synthetic compatibility verification',
    appId: reg.FIXED_TARGET.appId,
    envId: reg.FIXED_TARGET.envId,
    region: reg.FIXED_TARGET.region,
    functionName: reg.FIXED_TARGET.functionName,
    allowedUserIds: [deriveUserId(SYNTH_OPENID)],
    roundId: 'OFFLINE-FIXTURE-SYNTH-0001',
    windowStartsAt: SYNTH_START,
    windowExpiresAt: SYNTH_EXPIRES,
    sourceVersion: reg.REVIEWED_SOURCE_VERSION,
    synthetic: true,
    ...patch
  };
}
function buildInput(plan, nowMs, prefix) {
  const r = reg.buildRegistration(plan, { outId: freshId(prefix), nowMs });
  if (!r.ok) throw new Error('登记制品生成失败：' + JSON.stringify(r.problems));
  return r.dir;
}
const tempDirs = [];
function trackTemp(dir) { tempDirs.push(dir); return dir; }

// ═══════════════════════════════════════════════════════════════════════════
// 分组 1：模式与 schema 分离、默认合成防线
// ═══════════════════════════════════════════════════════════════════════════
(function groupModes() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  check('候选与合成使用独立 schema 常量',
    asm.ASSEMBLY_MANIFEST_SCHEMA_REAL !== asm.ASSEMBLY_MANIFEST_SCHEMA,
    asm.ASSEMBLY_MANIFEST_SCHEMA + ' vs ' + asm.ASSEMBLY_MANIFEST_SCHEMA_REAL);
  check('artifactKind 枚举恰为 synthetic / real-candidate',
    canonical(asm.ARTIFACT_KINDS) === canonical(['synthetic', 'real-candidate']),
    JSON.stringify(asm.ARTIFACT_KINDS));
  check('默认模式为 synthetic', asm.DEFAULT_ARTIFACT_KIND === 'synthetic');
  check('ASM_PLAN_SYNTHETIC_ONLY 防线仍存在', asm.ERR.PLAN_SYNTHETIC_ONLY === 'ASM_PLAN_SYNTHETIC_ONLY');

  // 默认模式拒绝真实计划
  const realIn = trackTemp(buildInput(candidatePlan(), CAND_NOW_MS, 'evmode'));
  const d1 = trackTemp(asm.resolveOutDir(freshId('evmodeout')));
  try {
    const before = snapshotTree(d1);
    const r = asm.buildAssembly({ inputDir: realIn, plan: candidatePlan(), outId: path.basename(d1).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS });
    check('默认模式拒绝真实计划', r.ok === false && r.problems[0].code === asm.ERR.PLAN_SYNTHETIC_ONLY,
      JSON.stringify(r.problems));
    check('默认模式拒绝时零写', r.wroteFiles === false && sameSnapshot(snapshotTree(d1), before));
  } finally { /* 由末尾统一清理 */ }

  // 候选模式拒绝合成计划
  const synIn = trackTemp(buildInput(syntheticPlan(), SYNTH_NOW_MS, 'evmodesyn'));
  const d2 = trackTemp(asm.resolveOutDir(freshId('evmodesynout')));
  const before2 = snapshotTree(d2);
  const r2 = asm.buildAssembly({
    inputDir: synIn, plan: syntheticPlan(), artifactKind: 'real-candidate',
    outId: path.basename(d2).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS
  });
  check('候选模式拒绝合成计划', r2.ok === false && r2.problems[0].code === asm.ERR.PLAN_SYNTHETIC_IN_REAL,
    JSON.stringify(r2.problems));
  check('候选拒绝合成时零写', r2.wroteFiles === false && sameSnapshot(snapshotTree(d2), before2));

  // 未知 / 缺值 / 重复：逐项捕获，断言「抛错即拒绝」
  const badKindCodes = [];
  for (const bad of ['real', 'REAL-CANDIDATE', 'production', '', 7, {}, []]) {
    try { asm.normalizeArtifactKind(bad); badKindCodes.push('NO_THROW'); }
    catch (error) { badKindCodes.push(error.code); }
  }
  check('未知/非字符串模式值一律拒绝',
    badKindCodes.every(code => code === asm.ERR.ARTIFACT_KIND_UNKNOWN || code === asm.ERR.ARTIFACT_KIND_MISSING_VALUE),
    JSON.stringify(badKindCodes));
  check('未指定时回落默认 synthetic', asm.normalizeArtifactKind(undefined) === 'synthetic');
  check('null 视为未指定并回落默认', asm.normalizeArtifactKind(null) === 'synthetic');
  check('合法模式值原样返回',
    asm.normalizeArtifactKind('synthetic') === 'synthetic'
    && asm.normalizeArtifactKind('real-candidate') === 'real-candidate');

  const cliCases = [
    [['--artifact-kind', 'real-candidate', '--artifact-kind', 'synthetic'], asm.ERR.ARTIFACT_KIND_DUPLICATE],
    [['--artifact-kind'], asm.ERR.ARTIFACT_KIND_MISSING_VALUE],
    [['--artifact-kind', '--plan'], asm.ERR.ARTIFACT_KIND_MISSING_VALUE],
    [['--artifact-kind', 'nope'], asm.ERR.ARTIFACT_KIND_UNKNOWN],
    [['--artifact-kind', 'real-candidate'], asm.ERR.PLAN_REQUIRED_FOR_REAL]
  ];
  for (const [extra, expected] of cliCases) {
    let code = null;
    try { asm.parseArgs(['--mode', 'build', '--input', 'x'].concat(extra)); }
    catch (error) { code = error.code; }
    check('CLI 拒绝 ' + extra.join(' '), code === expected, '实际=' + code);
  }
  check('CLI 默认 artifactKind=synthetic', asm.parseArgs(['--check']).artifactKind === 'synthetic');
  let bannedRejected = 0;
  for (const flag of ['--force', '--skip-verify', '--override-clock', '--set-time']) {
    try { asm.parseArgs(['--mode', 'build', flag]); } catch (_) { bannedRejected++; }
  }
  check('不提供绕过检查/时钟覆盖开关', bannedRejected === 4, 'rejected=' + bannedRejected);

  group('1-模式分离与默认合成防线', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 分组 2：候选完整正向
// ═══════════════════════════════════════════════════════════════════════════
const candidateDir = (function buildCandidate() {
  const inputDir = trackTemp(buildInput(candidatePlan(), CAND_NOW_MS, 'evcand'));
  const outId = freshId('evcandfull');
  const r = asm.buildAssembly({
    inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
    outId, nowMs: CAND_NOW_MS, networkGuard: netState
  });
  if (!r.ok) throw new Error('候选组装失败：' + JSON.stringify(r.problems));
  trackTemp(r.dir);
  report.assembly = {
    inputDir: path.relative(ROOT, inputDir).split(path.sep).join('/'),
    outDir: path.relative(ROOT, r.dir).split(path.sep).join('/'),
    registrationProject: path.relative(ROOT, path.join(r.dir, asm.REGISTRATION_ROOT)).split(path.sep).join('/'),
    closedProject: path.relative(ROOT, path.join(r.dir, asm.CLOSED_ROOT)).split(path.sep).join('/'),
    totalFiles: snapshotTree(r.dir).filter(r => !r.endsWith('/')).length,
    perProjectFileCount: asm.PROJECT_FILES.length,
    projectDelta: r.projectDelta,
    dependencyClosure: r.dependencyClosure,
    networkAttempts: r.networkAttempts,
    cloudCalled: r.cloudCalled
  };
  return { inputDir, outId, dir: r.dir };
})();

(function groupCandidatePositive() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });
  const root = candidateDir.dir;
  const registration = path.join(root, asm.REGISTRATION_ROOT);
  const closed = path.join(root, asm.CLOSED_ROOT);

  const total = snapshotTree(root).filter(r => !r.endsWith('/'));
  check('总文件数 49', total.length === 49, String(total.length));
  for (const [label, dir] of [['登记', registration], ['关闭', closed]]) {
    const files = snapshotTree(dir).filter(r => !r.endsWith('/'));
    check(label + '项目 24 文件', files.length === asm.PROJECT_FILES.length, String(files.length));
    const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'miniprogram/app.json'), 'utf8'));
    check(label + '项目唯一页面入口', canonical(appJson.pages) === canonical([asm.ONLY_PAGE]),
      JSON.stringify(appJson.pages));
    const pc = JSON.parse(fs.readFileSync(path.join(dir, 'project.config.json'), 'utf8'));
    check(label + '项目固定 AppID/双根',
      pc.appid === 'wxfb4db1615ac15531' && pc.miniprogramRoot === 'miniprogram/'
      && pc.cloudfunctionRoot === 'cloudfunctions/' && pc.compileType === 'miniprogram');
    check(label + '项目云函数目录名为 scheduleSandbox',
      fs.readdirSync(path.join(dir, 'cloudfunctions')).join(',') === asm.CLOUD_FUNCTION_NAME);
    check(label + '项目不含 access/旧业务页面',
      !fs.existsSync(path.join(dir, 'miniprogram/pages/access'))
      && canonical(fs.readdirSync(path.join(dir, 'miniprogram/pages')).sort()) === canonical(['schedule-sandbox']));
  }

  // 八文件逐字节
  const closedDesc = reg.describeClosedPackage();
  let byteOk = true; const byteDetail = [];
  for (const rel of reg.PACKAGE_FILES) {
    const regBytes = fs.readFileSync(path.join(registration, 'cloudfunctions/scheduleSandbox', rel));
    const closedBytes = fs.readFileSync(path.join(closed, 'cloudfunctions/scheduleSandbox', rel));
    if (!regBytes.equals(fs.readFileSync(path.join(candidateDir.inputDir, 'package', rel)))) {
      byteOk = false; byteDetail.push('登记版:' + rel);
    }
    const pinned = reg.PINNED_FACTS['miniapp/cloudfunctions/scheduleSandbox/' + rel];
    if (closedBytes.length !== pinned.bytes || sha256(closedBytes) !== pinned.sha256) {
      byteOk = false; byteDetail.push('关闭版:' + rel);
    }
  }
  check('服务端八文件各与正确输入逐字节匹配', byteOk, byteDetail.join('; '));
  check('关闭包来自受审校验且为关闭态',
    closedDesc.dir === asm.CLOSED_DIR && closedDesc.entryState.enabled === false);

  // 差异面
  const differing = asm.PROJECT_FILES.filter(rel =>
    !fs.readFileSync(path.join(registration, rel)).equals(fs.readFileSync(path.join(closed, rel))));
  check('前后端差异恰为三类文件',
    canonical(differing.slice().sort()) === canonical([
      'cloudfunctions/scheduleSandbox/gate.js',
      'cloudfunctions/scheduleSandbox/index.js',
      'miniprogram/config/schedule-sandbox-proof.js'
    ]), JSON.stringify(differing));
  check('前端覆盖：登记 enabled=true / 关闭 enabled=false',
    /enabled:\s*true/.test(fs.readFileSync(path.join(registration, 'miniprogram/config/schedule-sandbox-proof.js'), 'utf8'))
    && /enabled:\s*false/.test(fs.readFileSync(path.join(closed, 'miniprogram/config/schedule-sandbox-proof.js'), 'utf8')));
  check('旧前端驱动开关保持关闭',
    /enabled:\s*false/.test(fs.readFileSync(path.join(registration, 'miniprogram/config/sandbox-test-driver-proof.js'), 'utf8')));

  // 清单
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  report.manifestSha256 = sha256(fs.readFileSync(path.join(root, 'manifest.json')));
  check('候选 schema 为独立 /2', manifest.schema === asm.ASSEMBLY_MANIFEST_SCHEMA_REAL, manifest.schema);
  check('候选 artifactKind=real-candidate 且 synthetic=false',
    manifest.artifactKind === 'real-candidate' && manifest.synthetic === false);
  check('候选标注离线契约核验', manifest.verificationKind === asm.VERIFICATION_KIND);
  check('候选明确未获部署授权',
    manifest.deploymentAuthorized === false && manifest.cloudExecuted === false
    && manifest.uploaded === false && manifest.previewed === false);
  const limits = manifest.limitations.join(' ');
  check('候选限制声明含否定式授权表述',
    /不表示允许部署、本人已确认或管理员已初始化/.test(limits)
    && !/(已获|准予|可以)部署/.test(limits));
  check('候选限制声明写明过期不影响关闭包', /不代表关闭包失效/.test(limits));
  check('候选限制声明写明 windowStartsAt 非服务端守卫', /windowStartsAt 不是服务端/.test(limits));

  group('2-候选完整正向与来源字节', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 分组 3：反例零写快照
// ═══════════════════════════════════════════════════════════════════════════
(function groupZeroWrite() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  const invalid = [
    ['错账号', candidatePlan({ allowedUserIds: [deriveUserId('someone-else')] })],
    ['多账号', candidatePlan({ allowedUserIds: [FIXED_TARGET_USER, deriveUserId('second')] })],
    ['错环境', candidatePlan({ envId: 'cloud-other-env' })],
    ['错 AppID', candidatePlan({ appId: 'wxOTHERAPPID000000' })],
    ['错地域', candidatePlan({ region: 'ap-guangzhou' })],
    ['错函数名', candidatePlan({ functionName: 'otherFunction' })],
    ['轮次占位符', candidatePlan({ roundId: '待定' })],
    ['来源漂移', candidatePlan({ sourceVersion: 'unverified-source-label' })],
    ['窗口超 30 分钟', candidatePlan({ windowExpiresAt: '2026-03-01T13:00:00.000Z' })],
    ['窗口倒置', candidatePlan({ windowStartsAt: CAND_EXPIRES, windowExpiresAt: CAND_START })],
    ['synthetic 非布尔', candidatePlan({ synthetic: 'false' })],
    ['多余计划字段', Object.assign(candidatePlan(), { approved: true })]
  ];
  for (const [label, plan] of invalid) {
    const inputDir = trackTemp(buildInput(candidatePlan(), CAND_NOW_MS, 'evinv'));
    const dir = trackTemp(asm.resolveOutDir(freshId('evinvout')));
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({
      inputDir, plan, artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS
    });
    check('非法计划[' + label + '] 拒绝且零写',
      r.ok === false && r.wroteFiles === false && sameSnapshot(snapshotTree(dir), before),
      JSON.stringify(r.problems));
    cleanupSelf(inputDir);
    cleanupSelf(dir);
  }

  // 输入漂移
  {
    const inputDir = trackTemp(buildInput(candidatePlan(), CAND_NOW_MS, 'evdrift'));
    const target = path.join(inputDir, 'package/gate.js');
    const original = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n// drift')]));
    const dir = trackTemp(asm.resolveOutDir(freshId('evdriftout')));
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({
      inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS
    });
    check('输入漂移拒绝且零写',
      r.ok === false && r.problems[0].code === asm.ERR.INPUT_REJECTED
      && r.wroteFiles === false && sameSnapshot(snapshotTree(dir), before),
      JSON.stringify(r.problems));
    fs.writeFileSync(target, original);
    cleanupSelf(inputDir);
    cleanupSelf(dir);
  }

  // 冲突目录（有 manifest 但字节不同）
  {
    const dir = trackTemp(asm.resolveOutDir(freshId('evconf')));
    const rel = `${asm.REGISTRATION_ROOT}/miniprogram/app.wxss`;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '// 冲突\n');
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({
      inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS
    });
    check('无清单冲突字节拒绝且零写',
      r.ok === false && r.problems[0].code === asm.ERR.CONFLICT
      && r.wroteFiles === false && sameSnapshot(snapshotTree(dir), before),
      JSON.stringify(r.problems));
    cleanupSelf(dir);
  }

  // 额外空目录
  {
    const dir = trackTemp(asm.resolveOutDir(freshId('evextra')));
    fs.mkdirSync(path.join(dir, 'unexpected-empty'), { recursive: true });
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({
      inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS
    });
    check('额外空目录拒绝且零写',
      r.ok === false && r.problems[0].code === asm.ERR.EXTRA_ENTRY
      && r.wroteFiles === false && sameSnapshot(snapshotTree(dir), before),
      JSON.stringify(r.problems));
    cleanupSelf(dir);
  }

  // 真实 Windows junction
  {
    const dir = trackTemp(asm.resolveOutDir(freshId('evlink')));
    fs.mkdirSync(dir, { recursive: true });
    const sentinel = path.join(dir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'untouched');
    const link = path.join(dir, asm.REGISTRATION_ROOT);
    let made = false;
    try {
      spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, path.join(asm.ARTIFACTS_ROOT, asm.CLOSED_DIR)],
        { windowsHide: true, stdio: 'ignore' });
      made = fs.existsSync(link);
    } catch (_) { made = false; }
    if (made) {
      const before = snapshotTree(dir);
      const r = asm.buildAssembly({
        inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
        outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS
      });
      check('真实 junction 拒绝且零写',
        r.ok === false && r.wroteFiles === false && sameSnapshot(snapshotTree(dir), before),
        JSON.stringify(r.problems));
      check('junction 目标 sentinel 未被改动', fs.readFileSync(sentinel, 'utf8') === 'untouched');
    } else {
      check('真实 junction 未能在本机创建（如实记未验证）', false, 'mklink /J 失败');
    }
    cleanupSelf(dir);
  }

  group('3-反例零写快照', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 分组 4：当前时钟时效
// ═══════════════════════════════════════════════════════════════════════════
(function groupExpiry() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });
  const afterWindow = Date.parse(CAND_EXPIRES) + 1000;
  const EXPIRED_RE = new RegExp('^(' + asm.ERR.WINDOW_EXPIRED + '|REG_PLAN_WINDOW_EXPIRED)$');

  // 复用（过期）
  {
    const before = snapshotTree(candidateDir.dir);
    const r = asm.buildAssembly({
      inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
      outId: candidateDir.outId, nowMs: afterWindow
    });
    check('过期复用拒绝', r.ok === false && EXPIRED_RE.test(r.problems[0].code), JSON.stringify(r.problems));
    check('过期复用零写且快照不变', r.wroteFiles === false && sameSnapshot(snapshotTree(candidateDir.dir), before));
  }
  // check（过期）
  {
    const before = snapshotTree(candidateDir.dir);
    const r = asm.checkAssembly({
      inputDir: candidateDir.inputDir, outDir: candidateDir.dir, plan: candidatePlan(),
      artifactKind: 'real-candidate', nowMs: afterWindow
    });
    check('过期 check 拒绝', r.ok === false && EXPIRED_RE.test(r.problems[0].code), JSON.stringify(r.problems));
    check('过期 check 零写且快照不变', r.wroteFiles === false && sameSnapshot(snapshotTree(candidateDir.dir), before));
  }
  // 篡改 generatedAt 不能救活（改完还原）
  {
    const manifestPath = path.join(candidateDir.dir, 'manifest.json');
    const original = fs.readFileSync(manifestPath);
    const m = JSON.parse(original.toString('utf8'));
    m.generatedAt = CAND_START;
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
    const r = asm.checkAssembly({
      inputDir: candidateDir.inputDir, outDir: candidateDir.dir, plan: candidatePlan(),
      artifactKind: 'real-candidate', nowMs: afterWindow
    });
    check('篡改 generatedAt 不能让过期包通过', r.ok === false, JSON.stringify(r.problems));
    check('篡改 generatedAt 的检查零写', r.wroteFiles === false);
    fs.writeFileSync(manifestPath, original);
  }
  // 未过期时同一目录仍可复用（证明不是靠目录损坏取胜）
  {
    const before = snapshotTree(candidateDir.dir);
    const r = asm.buildAssembly({
      inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
      outId: candidateDir.outId, nowMs: CAND_NOW_MS
    });
    check('未过期时同一目录复用成功且零写',
      r.ok === true && r.reused === true && r.wroteFiles === false
      && sameSnapshot(snapshotTree(candidateDir.dir), before), JSON.stringify(r.problems));
  }
  // 候选 check 必须外部 plan
  {
    const before = snapshotTree(candidateDir.dir);
    const r = asm.checkAssembly({
      inputDir: candidateDir.inputDir, outDir: candidateDir.dir, artifactKind: 'real-candidate', nowMs: CAND_NOW_MS
    });
    check('候选 check 缺外部 plan 拒绝',
      r.ok === false && r.problems[0].code === asm.ERR.PLAN_REQUIRED_FOR_REAL, JSON.stringify(r.problems));
    check('缺外部 plan 零写且快照不变',
      r.wroteFiles === false && sameSnapshot(snapshotTree(candidateDir.dir), before));
  }
  // 过期续建（合法半成品：无 manifest）
  {
    const dir = trackTemp(asm.resolveOutDir(freshId('evcont')));
    assert1(asm.buildAssembly({
      inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS
    }).ok === true);
    const rel = `${asm.REGISTRATION_ROOT}/miniprogram/app.wxss`;
    fs.unlinkSync(path.join(dir, 'manifest.json'));
    fs.unlinkSync(path.join(dir, rel));
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({
      inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: afterWindow
    });
    check('过期续建拒绝且不补写',
      r.ok === false && EXPIRED_RE.test(r.problems[0].code)
      && r.wroteFiles === false && sameSnapshot(snapshotTree(dir), before), JSON.stringify(r.problems));
    const again = asm.buildAssembly({
      inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: CAND_NOW_MS
    });
    check('未过期时同一半成品可合法续建且只补缺项',
      again.ok === true && canonical(again.written.slice().sort()) === canonical([rel, 'manifest.json'].sort()),
      JSON.stringify(again.written));
    cleanupSelf(dir);
  }
  group('4-当前时钟时效与过期拒绝', checks);
})();
function assert1(cond) { if (!cond) throw new Error('证据脚本前置断言失败'); }

// ═══════════════════════════════════════════════════════════════════════════
// 分组 5：模式/schema/清单篡改与复用、/1 兼容
// ═══════════════════════════════════════════════════════════════════════════
(function groupTamperAndReuse() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });
  const manifestPath = path.join(candidateDir.dir, 'manifest.json');
  const original = fs.readFileSync(manifestPath);
  const restore = () => fs.writeFileSync(manifestPath, original);

  const mutations = [
    ['改成 /1 合成 schema', m => { m.schema = asm.ASSEMBLY_MANIFEST_SCHEMA; m.artifactKind = 'synthetic'; m.synthetic = true; }, asm.ERR.ARTIFACT_KIND_CONFLICT],
    ['改 artifactKind', m => { m.artifactKind = 'synthetic'; }, asm.ERR.ARTIFACT_KIND_CONFLICT],
    ['改 synthetic 标记', m => { m.synthetic = true; }, asm.ERR.MANIFEST_INVALID],
    ['部署标记改真', m => { m.deploymentAuthorized = true; }, asm.ERR.MANIFEST_INVALID],
    ['云执行标记改真', m => { m.cloudExecuted = true; }, asm.ERR.MANIFEST_INVALID],
    ['上传标记改真', m => { m.uploaded = true; }, asm.ERR.MANIFEST_INVALID],
    ['换计划轮次', m => { m.plan.roundId = 'OFFLINE-FIXTURE-CAND-9999'; }, asm.ERR.MANIFEST_MISMATCH],
    ['换计划用户', m => { m.plan.allowedUserIds = [deriveUserId('other')]; }, asm.ERR.MANIFEST_MISMATCH],
    ['删除限制声明', m => { delete m.limitations; }, asm.ERR.MANIFEST_MISMATCH]
  ];
  for (const [label, mutate, expected] of mutations) {
    const m = JSON.parse(original.toString('utf8'));
    mutate(m);
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
    const before = snapshotTree(candidateDir.dir);
    const r = asm.checkAssembly({
      inputDir: candidateDir.inputDir, outDir: candidateDir.dir, plan: candidatePlan(),
      artifactKind: 'real-candidate', nowMs: CAND_NOW_MS
    });
    check('候选拒绝[' + label + ']',
      r.ok === false && r.problems[0].code === expected
      && r.wroteFiles === false && sameSnapshot(snapshotTree(candidateDir.dir), before),
      JSON.stringify(r.problems));
    restore();
  }

  // 改字节并自报新哈希
  {
    const rel = `${asm.CLOSED_ROOT}/miniprogram/app.wxss`;
    const abs = path.join(candidateDir.dir, rel);
    const saved = fs.readFileSync(abs);
    const tampered = Buffer.concat([saved, Buffer.from('\n.tampered{}')]);
    fs.writeFileSync(abs, tampered);
    const m = JSON.parse(original.toString('utf8'));
    const entry = m.projects.closed.files.find(f => f.rel === 'miniprogram/app.wxss');
    entry.bytes = tampered.length;
    entry.sha256 = sha256(tampered);
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
    const r = asm.checkAssembly({
      inputDir: candidateDir.inputDir, outDir: candidateDir.dir, plan: candidatePlan(),
      artifactKind: 'real-candidate', nowMs: CAND_NOW_MS
    });
    check('候选拒绝改字节并自报新哈希',
      r.ok === false && r.problems[0].code === asm.ERR.MANIFEST_MISMATCH && r.wroteFiles === false,
      JSON.stringify(r.problems));
    fs.writeFileSync(abs, saved);
    restore();
    const ok = asm.checkAssembly({
      inputDir: candidateDir.inputDir, outDir: candidateDir.dir, plan: candidatePlan(),
      artifactKind: 'real-candidate', nowMs: CAND_NOW_MS
    });
    check('还原后候选检查通过', ok.ok === true, JSON.stringify(ok.problems));
  }

  // 模式不互相认领
  {
    const r = asm.checkAssembly({
      inputDir: candidateDir.inputDir, outDir: candidateDir.dir, plan: candidatePlan(), nowMs: CAND_NOW_MS
    });
    check('候选目录不被合成模式认领', r.ok === false, JSON.stringify(r.problems));
  }
  {
    const synIn = trackTemp(buildInput(syntheticPlan(), SYNTH_NOW_MS, 'evmix'));
    const synDir = trackTemp(asm.resolveOutDir(freshId('evmixout')));
    assert1(asm.buildAssembly({
      inputDir: synIn, plan: syntheticPlan(),
      outId: path.basename(synDir).slice(asm.OUT_DIR_PREFIX.length), nowMs: SYNTH_NOW_MS
    }).ok === true);
    const r = asm.checkAssembly({
      inputDir: synIn, outDir: synDir, plan: syntheticPlan(),
      artifactKind: 'real-candidate', nowMs: CAND_NOW_MS
    });
    check('合成目录不被候选模式认领', r.ok === false, JSON.stringify(r.problems));
    cleanupSelf(synIn);
    cleanupSelf(synDir);
  }

  // /1 合成包兼容：check 与复用，且不重写 manifest
  {
    const synIn = trackTemp(buildInput(syntheticPlan(), SYNTH_NOW_MS, 'evv1'));
    const outId = freshId('evv1out');
    const synDir = trackTemp(asm.resolveOutDir(outId));
    assert1(asm.buildAssembly({
      inputDir: synIn, plan: syntheticPlan(), outId, nowMs: SYNTH_NOW_MS
    }).ok === true);
    const synManifestPath = path.join(synDir, 'manifest.json');
    const synManifestBuf = fs.readFileSync(synManifestPath);
    const synManifest = JSON.parse(synManifestBuf.toString('utf8'));
    check('合成包仍为 /1 且 artifactKind=synthetic',
      synManifest.schema === asm.ASSEMBLY_MANIFEST_SCHEMA && synManifest.artifactKind === 'synthetic');
    const checked = asm.checkAssembly({ inputDir: synIn, outDir: synDir, plan: syntheticPlan() });
    check('/1 合成包检查仍通过', checked.ok === true, JSON.stringify(checked.problems));
    const beforeReuse = snapshotTree(synDir);
    const reuse = asm.buildAssembly({ inputDir: synIn, plan: syntheticPlan(), outId, nowMs: SYNTH_NOW_MS });
    check('/1 合成包复用成功且零写',
      reuse.ok === true && reuse.reused === true && reuse.wroteFiles === false
      && sameSnapshot(snapshotTree(synDir), beforeReuse), JSON.stringify(reuse.problems));
    check('/1 manifest 字节未被重写',
      fs.readFileSync(synManifestPath).equals(synManifestBuf));
    cleanupSelf(synIn);
    cleanupSelf(synDir);
  }

  group('5-篡改拒绝、复用与 /1 兼容', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 分组 6：关闭包独立性
// ═══════════════════════════════════════════════════════════════════════════
(function groupClosedIndependence() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });
  // 直接校验独立受审关闭制品：与任何登记计划/窗口无关
  const desc = reg.describeClosedPackage();
  check('关闭制品独立校验通过', desc.present === true && desc.dir === asm.CLOSED_DIR);
  check('关闭制品为关闭态', desc.entryState.enabled === false);
  check('关闭制品八文件齐全', desc.files.length === reg.PACKAGE_FILES.length);
  const closedManifest = path.join(asm.ARTIFACTS_ROOT, asm.CLOSED_DIR, 'manifest.json');
  check('关闭制品 manifest 字节与受审哈希一致',
    sha256(fs.readFileSync(closedManifest)) === reg.CLOSED_MANIFEST_SHA256);
  // 即使登记候选已过期，关闭制品仍可独立校验
  const afterWindow = Date.parse(CAND_EXPIRES) + 1000;
  const expiredReg = asm.buildAssembly({
    inputDir: candidateDir.inputDir, plan: candidatePlan(), artifactKind: 'real-candidate',
    outId: candidateDir.outId, nowMs: afterWindow
  });
  check('登记候选此时确已过期', expiredReg.ok === false);
  const stillOk = reg.describeClosedPackage();
  check('登记过期不影响关闭制品独立校验',
    stillOk.present === true && stillOk.entryState.enabled === false);
  group('6-关闭包独立于登记窗口', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 分组 7：实际 App/Page/client 合成链
// ═══════════════════════════════════════════════════════════════════════════
function loadActualApp(projectRoot, options = {}) {
  const miniprogram = path.join(projectRoot, 'miniprogram');
  const modules = new Map(), loaded = [], calls = [];
  const storage = new Map([['unrelated-cache', 'keep-me']]);
  let clearCount = 0, removeCount = 0, appDefinition = null, pageDefinition = null, initArgs = null;
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
        return { result: { ok: true, userId: FIXED_TARGET_USER, isAdmin: false } };
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

async function runRuntimeGroup() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });
  const registration = path.join(candidateDir.dir, asm.REGISTRATION_ROOT);
  const closed = path.join(candidateDir.dir, asm.CLOSED_ROOT);

  {
    const h = loadActualApp(registration);
    h.app.onLaunch.call(h.appInstance);
    check('候选登记版 App 初始化固定云环境',
      h.initArgs() && h.initArgs().env === reg.FIXED_TARGET.envId && h.initArgs().traceUser === false,
      JSON.stringify(h.initArgs()));
    check('候选登记版初始化无错误',
      h.appInstance.globalData.cloudReady === true && h.appInstance.globalData.cloudError === '');
    h.page.onLoad(); h.page.onShow();
    check('候选登记版生命周期零业务发送', h.calls.length === 0, 'calls=' + h.calls.length);
    check('候选登记版生命周期不清缓存', h.clearCalls() === 0 && h.removeCalls() === 0);
    await h.page.runSelected();
    check('候选登记版主动 identify 恰好一次', h.calls.length === 1, 'calls=' + h.calls.length);
    check('候选登记版 identify 固定函数与环境',
      h.calls[0].name === asm.CLOUD_FUNCTION_NAME && h.calls[0].config.env === reg.FIXED_TARGET.envId);
    check('候选登记版 identify 不带 projectId',
      h.calls[0].data.action === 'identify' && h.calls[0].data.projectId === undefined,
      JSON.stringify(h.calls[0].data));
    check('候选登记版页面仍保留动作选择器（单页≠单按钮）',
      Array.isArray(h.page.data.actions) && h.page.data.actions.length > 1);
    check('实际加载 App/Page/client/协调器/两份配置',
      ['app.js', 'config/cloud.js', asm.ONLY_PAGE + '.js', 'utils/schedule-sandbox-client.js',
        'utils/env-gate.js', 'utils/sandbox-test-driver.js', 'utils/sandbox-test-coordinator.js',
        'config/schedule-sandbox-proof.js', 'config/sandbox-test-driver-proof.js']
        .every(r => h.loaded.includes(r)), h.loaded.join(','));
  }
  {
    const h = loadActualApp(closed);
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad(); h.page.onShow();
    await h.page.runSelected();
    check('候选关闭版入口拒绝', h.page.data.entryAllowed === false);
    check('候选关闭版零业务发送', h.calls.length === 0, 'calls=' + h.calls.length);
    check('候选关闭版不清缓存', h.clearCalls() === 0 && h.removeCalls() === 0);
  }
  {
    const h = loadActualApp(registration, { failCall: true });
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad();
    await h.page.runSelected();
    check('首次未知 identify 只发一次', h.calls.length === 1);
    check('首次未知给出停止/核对提示', /未知|失败|核对/.test(String(h.page.data.lastError)),
      String(h.page.data.lastError));
    const before = canonical(Array.from(h.storage.entries()));
    h.page.onShow(); h.page.onLoad(); await Promise.resolve(); await Promise.resolve();
    check('首次未知不自动重发', h.calls.length === 1, 'calls=' + h.calls.length);
    check('首次未知不清缓存', canonical(Array.from(h.storage.entries())) === before);
  }
  {
    const h = loadActualApp(registration, { appId: 'wxOTHERAPPID000000' });
    h.app.onLaunch.call(h.appInstance);
    h.page.onLoad();
    await h.page.runSelected();
    check('错 AppID 零发送', h.calls.length === 0, 'calls=' + h.calls.length);
  }
  group('7-实际 App/Page/client 合成链（非真实 SDK）', checks);
}

// ── 网络拦截敏感性检查 ──────────────────────────────────────────────────────
function networkSensitivity() {
  let httpsBlocked = false, dnsBlocked = false, netBlocked = false;
  try { require('node:https').request('https://example.invalid'); } catch (_) { httpsBlocked = true; }
  try { require('node:dns').lookup('example.invalid'); } catch (_) { dnsBlocked = true; }
  try { require('node:net').connect(443, 'example.invalid'); } catch (_) { netBlocked = true; }
  report.networkGuard.sensitivityCheck = {
    httpsRequestBlocked: httpsBlocked,
    dnsLookupBlocked: dnsBlocked,
    netConnectBlocked: netBlocked,
    attemptsAfterProbe: netState.attempts.length,
    note: '探针刻意触发拦截以证明计数非硬写；这些调用在拦截点被拒绝，未发出真实请求。'
  };
  const workAttempts = netState.attempts.length - (httpsBlocked ? 1 : 0) - (dnsBlocked ? 1 : 0) - (netBlocked ? 1 : 0);
  report.counts.networkAttempts = workAttempts;
  report.networkGuard.attemptsDuringWork = workAttempts;
}

// ── 受保护文件运行前后比较 ────────────────────────────────────────────────────
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
    commitExists: GIT_EXE
      ? spawnSync(GIT_EXE, ['cat-file', '-e', BASELINE_COMMIT + '^{commit}'],
        { cwd: ROOT, windowsHide: true, timeout: 30000 }).status === 0
      : false,
    gitExecutable: GIT_EXE,
    trackedFiles: baselineBefore.size,
    trackedFilesAvailable: baselineTracked !== null,
    changedByThisRun: changed,
    missingAfter: missing,
    addedByThisRun: added,
    note: baselineTracked === null
      ? '本机未能调用 git，已跟踪文件基线未验证（如实记录）。'
      : '接手时全部已跟踪文件运行前后应字节不变；提交范围另由 git diff 核对，两者不混称。'
  };
}

/**
 * 顺序主流程：第 7 组含真实异步调用链，**必须 await** 后才能做夹具清理，
 * 否则清理会先执行，导致后续读取实际模块时文件已不存在。
 */
async function main() {
  await runRuntimeGroup();
  networkSensitivity();
  protectedBaseline();

  // 清理本脚本自建夹具（只清理自己新建的）
  for (const dir of tempDirs) {
    try { cleanupSelf(dir); } catch (_) { /* 已清理 */ }
  }
  asm.restoreNetworkGuard(netState);
  emit();
}

function emit() {
report.unverified = [
  '真实 SDK 转换、平台事务、IAM 写权限、当前费用与额度。',
  '依赖安装（wx-server-sdk 未安装、无 node_modules）与实际受支持运行时。',
  '远端云函数代码字节回读能力。',
  '完整微信构建、真机与平台部署。',
  '本人微信登记、管理员初始化与批准签发者。',
  '实际登记轮次、开始时间与截止时间（本轮只实现能力，不产出当次真实执行包）。',
  'windowStartsAt 是否真在服务端形成「未到时不可调用」守卫（本轮未改 gate，不作此宣称）。',
  '首次尚未绑定账号的 identify 未知结果仍无持久防重：只证明不自动重发，必须停止核对。'
];
report.finishedAt = new Date().toISOString();
report.summary = {
  groups: report.groups.length,
  checks: report.groups.reduce((n, g) => n + g.total, 0),
  passed: report.groups.reduce((n, g) => n + g.passed, 0),
  failed: report.groups.reduce((n, g) => n + (g.total - g.passed), 0)
};

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch(error => {
  // 失败时也清理自建夹具，并输出可审查的结构化结果，不覆盖历史证据
  for (const dir of tempDirs) {
    try { cleanupSelf(dir); } catch (_) { /* 已清理 */ }
  }
  asm.restoreNetworkGuard(netState);
  process.stderr.write('证据脚本失败：' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
