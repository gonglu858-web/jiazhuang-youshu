#!/usr/bin/env node
/**
 * 证据脚本：登记最终出口 S1 时钟分类收尾（本地离线）
 * =================================================
 *
 * 直接断言**修后行为**，不把「旧缺陷脚本不再复现」当作闭合依据。
 * 只输出 stdout；历史证据不改写、不覆盖。
 *
 * 本轮两项：
 *  S1-a 时钟异常分类
 *    在**读取时钟的边界**显式捕获并标记读时钟异常（结构化字段 `clockUnavailable`），
 *    下游只依据该标记判断时钟未知，**不检查错误文字是否包含「时钟」**。
 *    抛错时钟与非有限值都标记为未知；时钟未知时不得宣称已证明到期。
 *
 *  S1-b 最终分支覆盖
 *    让写后检查先取得有效快照，在 manifest 写完之后才让**下一次**读取
 *    （即最终返回前检查）降级。manifest 出现后的第一次读取属写后检查、
 *    第二次才是最终检查 —— 据此区分两个守卫，**不按调用总数猜阶段、不用 sleep**。
 *
 * 记录还包含对上一轮交付事实差异的如实补记（尾随空白、证据版本标签、行尾事实）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const asm = require(path.join(ROOT, 'miniapp/scripts/assemble-sandbox-registration.cjs'));
const reg = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));

/** 被复核的提交与本轮开发接手基线。 */
const REVIEWED_COMMIT = '3a9d90c';
const HANDOFF_BASELINE = '832f53c';

const T = Date.parse('2026-03-01T12:00:00.000Z');
const E = T + 20 * 60 * 1000;

const report = {
  reviewedCommit: REVIEWED_COMMIT,
  handoffBaseline: HANDOFF_BASELINE,
  evidenceRevision: 'clock-classification-final-exit',
  verificationKind: asm.VERIFICATION_KIND,
  nature: {
    localFixOnly: true,
    producesRealExecutionPackage: false,
    deploymentAuthorized: false,
    platformVerificationPerformed: false,
    note: 'synthetic=false 为被测计划契约；wx 与存储为受控合成。'
  },
  controlledClock: {
    now: new Date(T).toISOString(),
    window: [new Date(T).toISOString(), new Date(E).toISOString()]
  },
  groups: [],
  recordingDeltas: {
    note: '如实补记 Codex 复核报告第 4 节指出的上一轮交付事实差异，不回写历史证据。',
    trailingWhitespaceInCommittedDiff: null,
    evidenceRevisionLabel: null,
    lineEndings: null
  },
  protectedBaseline: {},
  networkGuard: {}
};
function group(name, checks) {
  report.groups.push({ group: name, total: checks.length, passed: checks.filter(c => c.ok).length, checks });
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
let seq = 0;
const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const freshId = s => 's1c-' + runId + '-' + (++seq) + '-' + s;

const tempDirs = [];
function track(d) { tempDirs.push(d); return d; }
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
      if (st.isDirectory()) { rows.push(rel + '/'); walk(abs, rel); }
      else rows.push(rel + ':' + sha256(fs.readFileSync(abs)));
    }
  })(dir, '');
  return rows;
}
function diskFiles(dir) {
  return snapshotTree(dir).filter(x => !x.endsWith('/')).map(x => x.split(':')[0]).sort();
}
function countFiles(dir) {
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  })(dir);
  return n;
}

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

function candidatePlan() {
  return {
    purpose: 'offline-fixture-s1-clock-classification',
    ...reg.FIXED_TARGET,
    allowedUserIds: [reg.CANDIDATE_USER_ID],
    roundId: freshId('offline-fixture'),
    windowStartsAt: new Date(T).toISOString(),
    windowExpiresAt: new Date(E).toISOString(),
    sourceVersion: reg.REVIEWED_SOURCE_VERSION,
    synthetic: false
  };
}
function candidateInput() {
  const plan = candidatePlan();
  const r = reg.buildRegistration(plan, { outId: freshId('input'), nowMs: T });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  track(r.dir);
  return { plan, inputDir: r.dir };
}

/**
 * manifest 出现后的第 N 次时钟读取开始降级。
 * 第 1 次 = 「组装（写后）」守卫，第 2 次 = 「组装（返回前）」守卫。
 */
function runWithStageDegradedClock(operation, dir, mode) {
  let manifestSeen = false, readsAfterManifest = 0, filesAtFire = 0, fired = false;
  const degradeOn = mode.indexOf('post-') === 0 ? 1 : 2;
  const bad = mode.slice(-3) === 'nan' ? 'nan'
    : mode.slice(-5) === 'throw' ? 'throw'
      : 'expired';
  const realDateNow = Date.now;
  Date.now = () => {
    if (!manifestSeen && fs.existsSync(path.join(dir, 'manifest.json'))) {
      manifestSeen = true;
      filesAtFire = countFiles(dir);
      fired = true;
    }
    if (!manifestSeen) return T;
    readsAfterManifest++;
    if (readsAfterManifest < degradeOn) return T;
    if (bad === 'nan') return NaN;
    // 注入的异常文字为英文，且**不含「时钟」二字**，用于证明分类不依赖文字
    if (bad === 'throw') throw new Error('synthetic clock unavailable');
    return E;
  };
  let r;
  try { r = operation(); } finally { Date.now = realDateNow; }
  return { r, fired, filesAtFire, readsAfterManifest };
}

// ═══════════════════════════════════════════════════════════════════════════
// 分组 1：最终返回前检查的三种降级方式
// ═══════════════════════════════════════════════════════════════════════════
(function groupFinalExitClock() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  // 1) 最终检查到期（时钟有效）
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('fexp')));
    const outId = path.basename(dir).slice(asm.OUT_DIR_PREFIX.length);
    const { r, fired, filesAtFire } = runWithStageDegradedClock(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId }),
      dir, 'final-expired');
    check('[到期] 事件屏障命中', fired);
    check('[到期] 推进时已写满 49 文件', filesAtFire === 49, 'files=' + filesAtFire);
    check('[到期] 拒绝成功', r.ok === false);
    check('[到期] 命中最终检查', r.reason === 'final-check', String(r.reason));
    check('[到期] 保留已写事实', r.wroteFiles === true && Array.isArray(r.written) && r.written.length === 49);
    check('[到期] written 与磁盘一致', JSON.stringify(r.written.slice().sort()) === JSON.stringify(diskFiles(dir)));
    check('[到期] 时钟有效 → 不标未知', r.clockInvalid === false);
    check('[到期] expiryProven=true', r.expiryProven === true, 'expiryProven=' + r.expiryProven);
  }

  // 2) 最终检查读到 NaN
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('fnan')));
    const outId = path.basename(dir).slice(asm.OUT_DIR_PREFIX.length);
    const { r, fired, filesAtFire } = runWithStageDegradedClock(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId }),
      dir, 'final-nan');
    check('[NaN] 事件屏障命中', fired);
    check('[NaN] 推进时已写满 49 文件', filesAtFire === 49, 'files=' + filesAtFire);
    check('[NaN] 拒绝成功', r.ok === false);
    check('[NaN] 命中最终检查（非写后检查）', r.reason === 'final-check', String(r.reason));
    check('[NaN] 保留已写事实', r.wroteFiles === true && r.written.length === 49);
    check('[NaN] written 与磁盘一致', JSON.stringify(r.written.slice().sort()) === JSON.stringify(diskFiles(dir)));
    check('[NaN] 标记时钟未知', r.clockInvalid === true);
    check('[NaN] 不得宣称已证明到期', r.expiryProven === false);
    check('[NaN] 说明含时间未知表述',
      /时间未知|未能取得当前时钟/.test(r.problems[0].detail), r.problems[0].detail);
  }

  // 3) 最终检查读取抛错（英文异常文字，不含「时钟」）
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('fthrow')));
    const outId = path.basename(dir).slice(asm.OUT_DIR_PREFIX.length);
    const { r, fired, filesAtFire } = runWithStageDegradedClock(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId }),
      dir, 'final-throw');
    check('[抛错] 事件屏障命中', fired);
    check('[抛错] 推进时已写满 49 文件', filesAtFire === 49, 'files=' + filesAtFire);
    check('[抛错] 拒绝成功', r.ok === false);
    check('[抛错] 命中最终检查', r.reason === 'final-check', String(r.reason));
    check('[抛错] 保留已写事实', r.wroteFiles === true && r.written.length === 49);
    check('[抛错] written 与磁盘一致', JSON.stringify(r.written.slice().sort()) === JSON.stringify(diskFiles(dir)));
    // S1-a 核心：异常文字为 'synthetic clock unavailable'（不含中文「时钟」），
    // 仍必须被识别为时钟未知 —— 证明分类依据结构化标记而非文字。
    check('[抛错] 时钟未知（不依赖错误文字）', r.clockInvalid === true, 'clockInvalid=' + r.clockInvalid);
    check('[抛错] clockUnknown 同步为 true', r.clockUnknown === true);
    check('[抛错] 不得宣称已证明到期', r.expiryProven === false);
    check('[抛错] 说明含时间未知表述',
      /时间未知|未能取得当前时钟/.test(r.problems[0].detail), r.problems[0].detail);
    check('[抛错] 未声称已证明截止', !/已于.*截止/.test(r.problems[0].detail), r.problems[0].detail);
    check('[抛错] 产物保留 49 文件', countFiles(dir) === 49);
  }

  // 4) 对照：写后检查即降级 → post-write-check（证明两守卫可区分）
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('post')));
    const outId = path.basename(dir).slice(asm.OUT_DIR_PREFIX.length);
    const { r, fired, filesAtFire } = runWithStageDegradedClock(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId }),
      dir, 'post-nan');
    check('[对照] 事件屏障命中', fired);
    check('[对照] 推进时已写满 49 文件', filesAtFire === 49, 'files=' + filesAtFire);
    check('[对照] 拒绝成功', r.ok === false);
    check('[对照] 命中写后检查（与最终检查可区分）', r.reason === 'post-write-check', String(r.reason));
    check('[对照] 时钟未知同样被标记', r.clockInvalid === true);
    check('[对照] 保留已写事实', r.wroteFiles === true);
  }

  group('S1c-最终返回前检查的时钟分类', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 分组 2：既有语义不回归
// ═══════════════════════════════════════════════════════════════════════════
(function groupNoRegression() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  // 预检零写
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('pre')));
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({
      inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: E });
    check('预检失败拒绝成功', r.ok === false);
    check('预检失败仍为 wroteFiles=false', r.wroteFiles === false);
    check('预检失败不带 written', r.written === undefined);
    check('预检失败目录快照不变',
      JSON.stringify(snapshotTree(dir)) === JSON.stringify(before));
  }

  // check 与完整复用零写
  {
    const i = candidateInput();
    const outId = freshId('reuse');
    const built = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    assert.equal(built.ok, true, JSON.stringify(built.problems));
    track(built.dir);
    const before = snapshotTree(built.dir);
    const expired = E + 1000;

    const c = asm.checkAssembly({ inputDir: i.inputDir, outDir: built.dir, plan: i.plan, artifactKind: 'real-candidate', nowMs: expired });
    check('check 过期拒绝成功', c.ok === false);
    check('check 失败零写且无 written', c.wroteFiles === false && c.written === undefined);
    check('check 失败目录不变', JSON.stringify(snapshotTree(built.dir)) === JSON.stringify(before));

    const u = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: expired });
    check('完整复用过期拒绝成功', u.ok === false);
    check('完整复用失败零写且无 written', u.wroteFiles === false && u.written === undefined);
    check('完整复用失败目录不变', JSON.stringify(snapshotTree(built.dir)) === JSON.stringify(before));

    const okReuse = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    check('未过期复用仍成功且零写',
      okReuse.ok === true && okReuse.reused === true && okReuse.wroteFiles === false);
  }

  // check 的时钟未知也应被标记
  {
    const i = candidateInput();
    const outId = freshId('chkclock');
    const built = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    track(built.dir);
    const realDateNow = Date.now;
    try {
      Date.now = () => { throw new Error('synthetic clock unavailable'); };
      const r = asm.checkAssembly({ inputDir: i.inputDir, outDir: built.dir, plan: i.plan, artifactKind: 'real-candidate' });
      check('check 时钟抛错拒绝成功', r.ok === false);
      check('check 时钟未知被标记（结构化）', r.clockInvalid === true, 'clockInvalid=' + r.clockInvalid);
      check('check 时钟未知仍为零写', r.wroteFiles === false);
    } finally { Date.now = realDateNow; }
  }

  // 合法续建与正常成功
  {
    const i = candidateInput();
    const outId = freshId('cont');
    const dir = track(asm.resolveOutDir(outId));
    const missing = `${asm.REGISTRATION_ROOT}/miniprogram/app.wxss`;
    const ok = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    check('正常成功未回归', ok.ok === true && ok.wroteFiles === true && ok.written.length === 49,
      JSON.stringify(ok.problems));
    check('正常成功无过期/时钟标记',
      ok.expiredAfterWrite === undefined && ok.clockInvalid === undefined && ok.reason === undefined);

    fs.unlinkSync(path.join(dir, 'manifest.json'));
    fs.unlinkSync(path.join(dir, missing));
    const cont = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    check('合法续建成功', cont.ok === true, JSON.stringify(cont.problems));
    check('续建 written 只列本次补写 2 项',
      JSON.stringify(cont.written.slice().sort()) === JSON.stringify([missing, 'manifest.json'].sort()),
      JSON.stringify(cont.written));
    check('续建后目录 49 文件', countFiles(dir) === 49);
  }

  group('S1d-预检复用零写与续建成功不回归', checks);
})();

// ── 记录差异补记（只读检查，不修改历史文件） ────────────────────────────────
(function recordingDeltas() {
  const cp = require('node:child_process');
  function git(args) {
    try {
      return cp.execFileSync('git', args, { cwd: ROOT, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString();
    } catch (_) { return null; }
  }

  // (1) 上一轮已提交差异中的尾随空白
  const check = git(['diff', '--check', 'afe633d', REVIEWED_COMMIT]);
  const lines = check === null ? [] : check.split('\n').filter(Boolean);
  report.recordingDeltas.trailingWhitespaceInCommittedDiff = {
    command: 'git diff --check afe633d ' + REVIEWED_COMMIT,
    available: check !== null,
    finding: lines.length > 0 ? '已提交差异中确有尾随空白，上一轮「无空白问题」应更正' : '未发现尾随空白',
    lines: lines.slice(0, 10),
    note: '仅看工作区 git diff --check 无法检查已提交的差异。'
  };

  // (2) 上一轮证据的版本标签
  const prevEvidence = path.join(ROOT, 'docs/证据/真实登记接线最终出口收尾-20261011.json');
  let prevRevision = null;
  if (fs.existsSync(prevEvidence)) {
    try { prevRevision = JSON.parse(fs.readFileSync(prevEvidence, 'utf8')).reviewCommit; } catch (_) { prevRevision = null; }
  }
  report.recordingDeltas.evidenceRevisionLabel = {
    previousEvidence: 'docs/证据/真实登记接线最终出口收尾-20261011.json',
    previousReviewCommit: prevRevision,
    actuallyReviewedCommit: REVIEWED_COMMIT,
    currentEvidenceReviewCommit: REVIEWED_COMMIT,
    note: '上一轮证据的 reviewCommit 指向更早提交；本证据标明本次核验对象，不回写历史 JSON。'
  };

  // (3) 行尾事实
  const records = ['docs/进展与待办.md', 'docs/WorkBuddy开发交接.md'];
  const eol = {};
  for (const f of records) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    let crlf = 0, lfOnly = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) { if (i > 0 && buf[i - 1] === 0x0d) crlf++; else lfOnly++; }
    }
    eol[f] = { crlf, lfOnly };
  }
  report.recordingDeltas.lineEndings = {
    records: eol,
    fact: '两份记录保留历史字节与原 LF 行尾，新追加段落使用 CRLF。',
    caveat: '不能泛称七个文件全部无行尾变更：组装说明存在历史段落行尾变化；不为统一格式继续改写历史段落。'
  };
})();

// ── 网络拦截敏感性 ──────────────────────────────────────────────────────────
(function networkSensitivity() {
  let httpsBlocked = false, dnsBlocked = false, netBlocked = false;
  try { require('node:https').request('https://example.invalid'); } catch (_) { httpsBlocked = true; }
  try { require('node:dns').lookup('example.invalid'); } catch (_) { dnsBlocked = true; }
  try { require('node:net').connect(443, 'example.invalid'); } catch (_) { netBlocked = true; }
  const probes = [httpsBlocked, dnsBlocked, netBlocked].filter(Boolean).length;
  report.networkGuard = {
    installedPoints: ['http.request', 'https.request', 'net.connect', 'net.createConnection', 'dns.lookup', 'dns.resolve'],
    scope: '本进程 Node 模块拦截点；不是系统级网络审计。',
    sensitivityTriggered: { httpsRequest: httpsBlocked, dnsLookup: dnsBlocked, netConnect: netBlocked },
    sensitivityPointCount: probes,
    attemptsDuringWork: netState.attempts.length - probes
  };
  report.counts = { networkAttempts: report.networkGuard.attemptsDuringWork, platformVerification: 0, sdkExecuted: 0 };
})();

// ── 受保护文件运行前后字节比较 ────────────────────────────────────────────────
(function protectedBaseline() {
  let files = null;
  try {
    files = require('node:child_process').execFileSync('git', ['ls-files', '-z'],
      { cwd: ROOT, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
  } catch (_) { files = null; }
  if (files === null) {
    report.protectedBaseline = { trackedFiles: 0, available: false, changedByThisRun: [], missingAfter: [] };
    return;
  }
  const changed = [], missing = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    if (sha256(fs.readFileSync(abs)) !== baselineBefore.get(rel)) changed.push(rel);
  }
  report.protectedBaseline = {
    trackedFiles: files.length, available: true, changedByThisRun: changed, missingAfter: missing
  };
})();

// ── 清理自建夹具 ──────────────────────────────────────────────────────────────
for (const dir of tempDirs) { try { cleanupSelf(dir); } catch (_) { /* 已清理 */ } }
report.fixturesCreated = tempDirs.length;
asm.restoreNetworkGuard(netState);

report.unverified = [
  '真实 SDK 转换、平台事务、IAM 写权限、当前费用与额度。',
  '依赖安装与实际受支持运行时、远端云函数代码字节回读。',
  '完整微信构建、真机与平台部署（本轮未进行任何平台验证）。',
  '本人微信登记、管理员初始化与批准签发者。',
  '实际登记轮次、开始时间与截止时间。',
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