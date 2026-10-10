#!/usr/bin/env node
/**
 * 证据脚本：真实登记接线 R1/R2 定点返修（本地离线）
 * =================================================
 *
 * 直接证明**修后行为**，不把 Codex 缺陷脚本「不再复现」当作闭合依据。
 * 只输出 stdout；历史证据不改写、不覆盖。
 *
 * R1（各时效边界重新读取时钟）
 *   以**实际事件**推进受控时钟：在读取受审来源文件、或写完首个输出文件的时刻
 *   把时钟推进到截止时刻。调用方**不传** nowMs，组装器必须自己在每个边界读时钟。
 *   不使用 sleep，不以恒定 nowMs 代替跨期，也不替换过期判断。
 *   覆盖：写前、写后、check、复用、续建五条路径 + 边界相等 + 未过期对照。
 *
 * R2（恢复受审合成 /1 原清单契约）
 *   用 `git show b274da4` 的**真实旧版本模块**（由外部预导出到 OLD_ASM_SRC）
 *   生成真正的历史 /1 包 —— 不用当前版本自造「历史包」，不手工拼清单，
 *   也不修改旧制品补字段。验证：新版 check 通过、默认/显式 synthetic 复用成功、
 *   manifest 字节不变、旧包篡改仍严格拒绝、候选 /2 独有字段仍被严格要求。
 *
 * 边界：`synthetic=false` 是被测计划契约，时钟/wx/存储仍为受控合成；
 * 不是真实 SDK 或平台验证；不产生当次真实执行包。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const asmPath = path.join(ROOT, 'miniapp/scripts/assemble-sandbox-registration.cjs');
const asm = require(asmPath);
const reg = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));

const REVIEW_COMMIT = 'f9a8f2c';
const REVIEW_BASELINE = 'c97d406';
const SYNTH_OPENID = 'synthetic-assembly-openid';
/** 受控历史时钟：候选 2026-03-01T12:00Z，窗口 20 分钟；合成 2026-01-01。 */
const T = Date.parse('2026-03-01T12:00:00.000Z');
const E = T + 20 * 60 * 1000;
const SYNTH_NOW = Date.parse('2026-01-01T00:05:00.000Z');

const report = {
  reviewCommit: REVIEW_COMMIT,
  reviewBaseline: REVIEW_BASELINE,
  verificationKind: asm.VERIFICATION_KIND,
  nature: {
    localWiringFixOnly: true,
    producesRealExecutionPackage: false,
    deploymentAuthorized: false,
    note: 'synthetic=false 是被测计划契约；时钟、wx 与存储为受控合成，非真实 SDK 或平台验证。'
  },
  controlledClock: {
    candidateNow: new Date(T).toISOString(),
    candidateWindow: [new Date(T).toISOString(), new Date(E).toISOString()],
    syntheticNow: new Date(SYNTH_NOW).toISOString(),
    note: '受控历史时钟，仅用于离线复跑；不代表实际登记轮次或真实窗口。'
  },
  groups: [],
  fixtures: [],
  protectedBaseline: {},
  networkGuard: {}
};
function group(name, checks) {
  report.groups.push({ group: name, total: checks.length, passed: checks.filter(c => c.ok).length, checks });
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function deriveUserId(openid) {
  return 'u_' + sha256(Buffer.from(`${reg.FIXED_TARGET.appId}:${openid}`)).slice(0, 40);
}
const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
let seq = 0;
const freshId = s => 'r1r2-' + runId + '-' + (++seq) + '-' + s;

const tempDirs = [];
function track(dir) { tempDirs.push(dir); return dir; }
function cleanupSelf(dir) {
  const abs = path.resolve(dir);
  if (!abs.startsWith(path.resolve(asm.ARTIFACTS_ROOT) + path.sep)) {
    throw new Error('拒绝清理制品根之外的路径：' + abs);
  }
  if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
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
      rows.push(rel + ':' + sha256(fs.readFileSync(abs)));
    }
  })(dir, '');
  return rows;
}

// ── 网络实际拦截（含敏感性：实际为 3 个触发点） ──────────────────────────────
const netState = asm.installNetworkGuard({});

/** 接手时的已跟踪文件字节基线（运行前后比较用）。 */
const baselineBefore = new Map();
(function captureBaseline() {
  let files = null;
  try {
    files = require('node:child_process').execFileSync('git', ['ls-files', '-z'],
      { cwd: ROOT, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
  } catch (_) { files = null; }
  if (files === null) return;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    baselineBefore.set(rel, fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null);
  }
})();

// ── 计划与输入 ───────────────────────────────────────────────────────────────
function candidatePlan(patch = {}) {
  return {
    purpose: 'offline-fixture-r1r2-verification',
    ...reg.FIXED_TARGET,
    allowedUserIds: [reg.CANDIDATE_USER_ID],
    roundId: freshId('offline-fixture'),
    windowStartsAt: new Date(T).toISOString(),
    windowExpiresAt: new Date(E).toISOString(),
    sourceVersion: reg.REVIEWED_SOURCE_VERSION,
    synthetic: false,
    ...patch
  };
}
function syntheticPlan(patch = {}) {
  return {
    purpose: 'offline-fixture-r1r2-synthetic',
    ...reg.FIXED_TARGET,
    allowedUserIds: [deriveUserId(SYNTH_OPENID)],
    roundId: freshId('offline-fixture'),
    windowStartsAt: '2026-01-01T00:00:00.000Z',
    windowExpiresAt: '2026-01-01T00:20:00.000Z',
    sourceVersion: reg.REVIEWED_SOURCE_VERSION,
    synthetic: true,
    ...patch
  };
}
function candidateInput() {
  const plan = candidatePlan();
  const r = reg.buildRegistration(plan, { outId: freshId('input'), nowMs: T });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  track(r.dir);
  return { plan, inputDir: r.dir };
}
function syntheticInput() {
  const plan = syntheticPlan();
  const r = reg.buildRegistration(plan, { outId: freshId('input'), nowMs: SYNTH_NOW });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  track(r.dir);
  return { plan, inputDir: r.dir };
}
const EXPIRED_RE = new RegExp('^(' + asm.ERR.WINDOW_EXPIRED + '|REG_PLAN_WINDOW_EXPIRED)$');

/**
 * 以实际事件推进时钟。只替换 `Date.now` 与 `fs.readFileSync`/`fs.writeFileSync`
 * 的**旁路观察**，不替换过期判断、不改产品代码、不用 sleep。
 */
function advanceClockAtEvent(operation, trigger, targetDir) {
  let now = T, reads = 0, fired = false;
  const realDateNow = Date.now;
  const realRead = fs.readFileSync;
  const realWrite = fs.writeFileSync;
  Date.now = () => { reads++; return now; };
  const sourceFile = path.join(asm.MINIPROGRAM_SRC, 'app.js');
  fs.readFileSync = function (p, ...rest) {
    const buf = realRead.call(fs, p, ...rest);
    if (trigger === 'source' && path.resolve(String(p)) === sourceFile) { now = E; fired = true; }
    return buf;
  };
  fs.writeFileSync = function (p, ...rest) {
    const res = realWrite.call(fs, p, ...rest);
    if (trigger === 'write' && path.resolve(String(p)).startsWith(targetDir + path.sep)) { now = E; fired = true; }
    return res;
  };
  let r;
  try { r = operation(); } finally {
    Date.now = realDateNow; fs.readFileSync = realRead; fs.writeFileSync = realWrite;
  }
  assert.equal(fired, true, '事件屏障未命中：未真正推进时钟');
  return { r, clockReads: reads, atDeadline: now === E };
}

// ═══════════════════════════════════════════════════════════════════════════
// R1：五个时效边界重新读时钟
// ═══════════════════════════════════════════════════════════════════════════
(function groupR1() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  // 1) 写前（来源读取中到期）
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('prewrite')));
    const before = snapshotTree(dir);
    const { r, clockReads, atDeadline } = advanceClockAtEvent(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate',
        outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length) }),
      'source', dir
    );
    check('写前：事件推进到截止时刻', atDeadline);
    check('写前：多个边界读取时钟（>=2）', clockReads >= 2, 'reads=' + clockReads);
    check('写前：拒绝且不报成功', r.ok === false, JSON.stringify(r.problems));
    check('写前：过期错误码', EXPIRED_RE.test(r.problems[0] && r.problems[0].code), r.problems[0] && r.problems[0].code);
    check('写前：零写', r.wroteFiles === false);
    check('写前：未标 expiredAfterWrite', r.expiredAfterWrite === undefined);
    check('写前：目录快照不变', JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
  }

  // 2) 写后（首个输出文件写完到期）
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('postwrite')));
    const { r, clockReads } = advanceClockAtEvent(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate',
        outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length) }),
      'write', dir
    );
    check('写后：三个以上边界读取时钟（>=3）', clockReads >= 3, 'reads=' + clockReads);
    check('写后：拒绝且不报成功', r.ok === false, JSON.stringify(r.problems));
    check('写后：标记 expiredAfterWrite', r.expiredAfterWrite === true);
    check('写后：如实报告 wroteFiles=true', r.wroteFiles === true);
    check('写后：列出已写文件', Array.isArray(r.written) && r.written.length === 49, 'written=' + (r.written || []).length);
    check('写后：产物保留未清理', fs.existsSync(path.join(dir, 'manifest.json'))
      && snapshotTree(dir).filter(x => !x.endsWith('/')).length === 49);
    check('写后：报告文本说明保留与失效', /保留|不可作为当前有效登记候选/.test(r.problems[0].detail || ''));
  }

  // 3) check 路径
  {
    const i = candidateInput();
    const outId = freshId('check');
    const built = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    assert.equal(built.ok, true, JSON.stringify(built.problems));
    track(built.dir);
    const before = snapshotTree(built.dir);
    const { r, clockReads } = advanceClockAtEvent(
      () => asm.checkAssembly({ inputDir: i.inputDir, outDir: built.dir, plan: i.plan, artifactKind: 'real-candidate' }),
      'source', built.dir
    );
    check('check：边界重读时钟（>=2）', clockReads >= 2, 'reads=' + clockReads);
    check('check：来源读取中到期即拒绝', r.ok === false, JSON.stringify(r.problems));
    check('check：过期错误码', EXPIRED_RE.test(r.problems[0] && r.problems[0].code));
    check('check：零写且目录不变',
      r.wroteFiles === false && JSON.stringify(snapshotTree(built.dir)) === JSON.stringify(before));
  }

  // 4) 复用路径
  {
    const i = candidateInput();
    const outId = freshId('reuse');
    const built = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    track(built.dir);
    const before = snapshotTree(built.dir);
    const { r, clockReads } = advanceClockAtEvent(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId }),
      'source', built.dir
    );
    check('复用：边界重读时钟（>=2）', clockReads >= 2, 'reads=' + clockReads);
    check('复用：到期拒绝且不报复用成功', r.ok === false && r.reused === undefined, JSON.stringify(r));
    check('复用：过期错误码', EXPIRED_RE.test(r.problems[0] && r.problems[0].code));
    check('复用：零写且目录不变',
      r.wroteFiles === false && JSON.stringify(snapshotTree(built.dir)) === JSON.stringify(before));
  }

  // 5) 续建路径
  {
    const i = candidateInput();
    const outId = freshId('resume');
    const built = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    track(built.dir);
    const missing = `${asm.REGISTRATION_ROOT}/miniprogram/app.wxss`;
    fs.unlinkSync(path.join(built.dir, 'manifest.json'));
    fs.unlinkSync(path.join(built.dir, missing));
    const before = snapshotTree(built.dir);
    const { r, clockReads } = advanceClockAtEvent(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId }),
      'source', built.dir
    );
    check('续建：边界重读时钟（>=2）', clockReads >= 2, 'reads=' + clockReads);
    check('续建：到期拒绝', r.ok === false, JSON.stringify(r.problems));
    check('续建：不补任何文件', r.wroteFiles === false && (r.written || []).length === 0);
    check('续建：缺文件与 manifest 均未被补上',
      !fs.existsSync(path.join(built.dir, missing)) && !fs.existsSync(path.join(built.dir, 'manifest.json')));
    check('续建：目录快照不变', JSON.stringify(snapshotTree(built.dir)) === JSON.stringify(before));
    // 对照：未过期时同一半成品可合法续建
    const again = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    check('续建：未过期对照成功且只补缺项',
      again.ok === true && asm.canonical(again.written.slice().sort()) === asm.canonical([missing, 'manifest.json'].sort()),
      JSON.stringify(again.written));
  }

  // 6) 边界相等 + 未过期对照
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('edge')));
    const before = snapshotTree(dir);
    const atEdge = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: E });
    check('边界相等（expires<=now）拒绝', atEdge.ok === false, JSON.stringify(atEdge.problems));
    check('边界相等：零写且目录不变',
      atEdge.wroteFiles === false && JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));

    const okDir = track(asm.resolveOutDir(freshId('notexpired')));
    const ok = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate',
      outId: path.basename(okDir).slice(asm.OUT_DIR_PREFIX.length), nowMs: T });
    check('未过期对照成功', ok.ok === true, JSON.stringify(ok.problems));
    check('未过期对照：49 文件', snapshotTree(okDir).filter(x => !x.endsWith('/')).length === 49);
  }

  // 7) CLI 不得提前固定时钟数值
  {
    const src = fs.readFileSync(asmPath, 'utf8');
    const cliCallsFixedNow = /buildAssembly\(\{[^}]*nowMs:\s*Date\.now\(\)/.test(src);
    check('CLI build 不再传 nowMs: Date.now()（各边界自行读时钟）', !cliCallsFixedNow);
  }

  group('R1-各时效边界重新读取时钟', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// R2：恢复受审合成 /1 原清单契约
// ═══════════════════════════════════════════════════════════════════════════
(function groupR2() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  const OLD_SRC = process.env.OLD_ASM_SRC;
  check('旧版本源码由外部预导出提供', Boolean(OLD_SRC) && fs.existsSync(OLD_SRC), String(OLD_SRC));
  if (!OLD_SRC || !fs.existsSync(OLD_SRC)) {
    group('R2-恢复受审 /1 原清单契约', checks);
    return;
  }
  // 用真实旧版本模块（保持原模块解析位置）生成真正的历史 /1 包
  const m = new Module(asmPath, module);
  m.filename = asmPath;
  m.paths = Module._nodeModulePaths(path.dirname(asmPath));
  m._compile(fs.readFileSync(OLD_SRC, 'utf8'), asmPath);
  const old = m.exports;

  const i = syntheticInput();
  const oldId = freshId('oldschema');
  const oldDir = track(asm.resolveOutDir(oldId));
  const oldBuilt = old.buildAssembly({ inputDir: i.inputDir, plan: i.plan, outId: oldId, nowMs: SYNTH_NOW });
  check('旧版本模块成功生成 /1 包', oldBuilt.ok === true, JSON.stringify(oldBuilt.problems));
  check('旧模块自检通过', old.checkAssembly({ inputDir: i.inputDir, outDir: oldDir, plan: i.plan }).ok === true);

  const manifestPath = path.join(oldDir, 'manifest.json');
  const oldBytes = fs.readFileSync(manifestPath);
  const oldManifest = JSON.parse(oldBytes.toString('utf8'));
  report.oldManifestFields = Object.keys(oldManifest);
  check('旧 /1 清单不含 artifactKind', !Object.prototype.hasOwnProperty.call(oldManifest, 'artifactKind'));
  check('旧 /1 清单不含 verificationKind', !Object.prototype.hasOwnProperty.call(oldManifest, 'verificationKind'));

  // 新版 check 旧包
  const checked = asm.checkAssembly({ inputDir: i.inputDir, outDir: oldDir, plan: i.plan });
  check('新版 check 真实旧 /1 包通过', checked.ok === true, JSON.stringify(checked.problems));
  check('新版 check 旧包零写', checked.wroteFiles === false);

  // 新版完整复用（默认 + 显式 synthetic），manifest 零重写
  const beforeReuse = snapshotTree(oldDir);
  for (const [label, options] of [['默认模式', {}], ['显式 synthetic', { artifactKind: 'synthetic' }]]) {
    const reuse = asm.buildAssembly(Object.assign(
      { inputDir: i.inputDir, plan: i.plan, outId: oldId, nowMs: SYNTH_NOW }, options));
    check('新版复用旧包成功（' + label + '）', reuse.ok === true && reuse.reused === true, JSON.stringify(reuse.problems));
    check('复用零写（' + label + '）', reuse.wroteFiles === false);
    check('manifest 字节不变（' + label + '）', fs.readFileSync(manifestPath).equals(oldBytes));
    check('复用不改任何字节（' + label + '）', JSON.stringify(snapshotTree(oldDir)) === JSON.stringify(beforeReuse));
  }

  // 新版生成的 /1 与旧受审契约逐字节一致
  const newDir = track(asm.resolveOutDir(freshId('newschema')));
  const newBuilt = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan,
    outId: path.basename(newDir).slice(asm.OUT_DIR_PREFIX.length), nowMs: SYNTH_NOW });
  check('新版生成 /1 成功', newBuilt.ok === true, JSON.stringify(newBuilt.problems));
  const newBytes = fs.readFileSync(path.join(newDir, 'manifest.json'));
  check('新版 /1 与旧受审契约逐字节一致', oldBytes.equals(newBytes),
    'old=' + sha256(oldBytes) + ' new=' + sha256(newBytes));
  const newManifest = JSON.parse(newBytes.toString('utf8'));
  check('新版 /1 仍不含候选独有键',
    !('artifactKind' in newManifest) && !('verificationKind' in newManifest));

  // 旧包篡改仍严格拒绝（不是靠容忍缺字段兼容）
  const tampered = JSON.parse(oldBytes.toString('utf8'));
  tampered.plan.roundId = 'TAMPERED-ROUND';
  fs.writeFileSync(manifestPath, JSON.stringify(tampered, null, 2) + '\n');
  const beforeTamper = snapshotTree(oldDir);
  const tamperCheck = asm.checkAssembly({ inputDir: i.inputDir, outDir: oldDir, plan: i.plan });
  check('旧包篡改必需字段仍被拒绝', tamperCheck.ok === false && tamperCheck.problems[0].code === asm.ERR.MANIFEST_MISMATCH,
    JSON.stringify(tamperCheck.problems));
  check('旧包检查失败零写', tamperCheck.wroteFiles === false
    && JSON.stringify(snapshotTree(oldDir)) === JSON.stringify(beforeTamper));
  check('工具未改写旧制品（保留篡改后字节供审查）',
    fs.readFileSync(manifestPath).toString('utf8').includes('TAMPERED-ROUND'));
  fs.writeFileSync(manifestPath, oldBytes);

  // 旧包新增候选字段也应被拒（/1 不允许新键）
  const polluted = JSON.parse(oldBytes.toString('utf8'));
  polluted.artifactKind = 'synthetic';
  fs.writeFileSync(manifestPath, JSON.stringify(polluted, null, 2) + '\n');
  const pollutedCheck = asm.checkAssembly({ inputDir: i.inputDir, outDir: oldDir, plan: i.plan });
  check('旧包被塞入候选字段后拒绝（/1 契约不容扩张）',
    pollutedCheck.ok === false && pollutedCheck.problems[0].code === asm.ERR.MANIFEST_MISMATCH,
    JSON.stringify(pollutedCheck.problems));
  fs.writeFileSync(manifestPath, oldBytes);

  // 候选 /2 独有字段仍被严格要求
  const ci = candidateInput();
  const realId = freshId('realschema');
  const realBuilt = asm.buildAssembly({ inputDir: ci.inputDir, plan: ci.plan, artifactKind: 'real-candidate',
    outId: realId, nowMs: T });
  check('候选 /2 组装成功', realBuilt.ok === true, JSON.stringify(realBuilt.problems));
  track(realBuilt.dir);
  const realManifest = JSON.parse(fs.readFileSync(path.join(realBuilt.dir, 'manifest.json'), 'utf8'));
  report.realManifestFields = Object.keys(realManifest);
  check('候选 /2 使用独立 schema', realManifest.schema === asm.ASSEMBLY_MANIFEST_SCHEMA_REAL);
  check('候选 /2 带 artifactKind 与 verificationKind',
    realManifest.artifactKind === 'real-candidate' && realManifest.verificationKind === asm.VERIFICATION_KIND);

  const realManifestPath = path.join(realBuilt.dir, 'manifest.json');
  const realBytes = fs.readFileSync(realManifestPath);
  const noKind = { ...realManifest }; delete noKind.artifactKind;
  fs.writeFileSync(realManifestPath, JSON.stringify(noKind, null, 2) + '\n');
  const noKindCheck = asm.checkAssembly({ inputDir: ci.inputDir, outDir: realBuilt.dir, plan: ci.plan,
    artifactKind: 'real-candidate', nowMs: T });
  check('候选 /2 缺 artifactKind 被拒',
    noKindCheck.ok === false && noKindCheck.problems[0].code === asm.ERR.ARTIFACT_KIND_CONFLICT,
    JSON.stringify(noKindCheck.problems));
  const noVerKind = { ...realManifest }; delete noVerKind.verificationKind;
  fs.writeFileSync(realManifestPath, JSON.stringify(noVerKind, null, 2) + '\n');
  const noVerCheck = asm.checkAssembly({ inputDir: ci.inputDir, outDir: realBuilt.dir, plan: ci.plan,
    artifactKind: 'real-candidate', nowMs: T });
  check('候选 /2 缺 verificationKind 被拒', noVerCheck.ok === false, JSON.stringify(noVerCheck.problems));
  fs.writeFileSync(realManifestPath, realBytes);

  group('R2-恢复受审 /1 原清单契约', checks);
})();

// ── 网络拦截敏感性（实际触发点为 3 个） ──────────────────────────────────────
(function networkSensitivity() {
  let httpsBlocked = false, dnsBlocked = false, netBlocked = false;
  try { require('node:https').request('https://example.invalid'); } catch (_) { httpsBlocked = true; }
  try { require('node:dns').lookup('example.invalid'); } catch (_) { dnsBlocked = true; }
  try { require('node:net').connect(443, 'example.invalid'); } catch (_) { netBlocked = true; }
  const probes = [httpsBlocked, dnsBlocked, netBlocked].filter(Boolean).length;
  const work = netState.attempts.length - probes;
  report.networkGuard = {
    installedPoints: ['http.request', 'https.request', 'net.connect', 'net.createConnection', 'dns.lookup', 'dns.resolve'],
    scope: '本进程内 Node 模块拦截点；不是系统级网络审计，也不覆盖原生编译器内部调用。',
    sensitivityTriggered: { httpsRequest: httpsBlocked, dnsLookup: dnsBlocked, netConnect: netBlocked },
    sensitivityPointCount: probes,
    attemptsDuringWork: work,
    note: '实际触发 3 个点（https.request / dns.lookup / net.connect）；http.request 是安装拦截点但本次无对应触发。'
  };
  report.counts = { networkAttempts: work, realSdkExecuted: 0, credentialsFetched: 0, cloudWrites: 0 };
})();

// ── 受保护文件运行前后字节比较 ────────────────────────────────────────────────
(function protectedBaseline() {
  let files = null;
  try {
    files = require('node:child_process').execFileSync('git', ['ls-files', '-z'],
      { cwd: ROOT, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
  } catch (_) { files = null; }
  if (files === null) {
    report.protectedBaseline = {
      trackedFiles: 0, available: false, changedByThisRun: [], missingAfter: [],
      note: '本进程未能调用 git（spawnSync 在当前宿主偶发 EBUSY），已跟踪文件基线未验证，如实记录，不以静态解析冒充。'
    };
    return;
  }
  const changed = [], missing = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    if (sha256(fs.readFileSync(abs)) !== baselineBefore.get(rel)) changed.push(rel);
  }
  report.protectedBaseline = {
    trackedFiles: files.length,
    available: true,
    changedByThisRun: changed,
    missingAfter: missing,
    note: '接手时全部已跟踪文件运行前后应字节不变；提交范围另由 git diff 核对，两者不混称。'
  };
})();

// ── 清理自建夹具 ──────────────────────────────────────────────────────────────
for (const dir of tempDirs) { try { cleanupSelf(dir); } catch (_) { /* 已清理 */ } }
report.fixturesCreated = tempDirs.length;
asm.restoreNetworkGuard(netState);

report.unverified = [
  '真实 SDK 转换、平台事务、IAM 写权限、当前费用与额度。',
  '依赖安装与实际受支持运行时、远端云函数代码字节回读。',
  '完整微信构建、真机与平台部署。',
  '本人微信登记、管理员初始化与批准签发者。',
  '实际登记轮次、开始时间与截止时间（本轮只修接线，不产出当次真实执行包）。',
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
