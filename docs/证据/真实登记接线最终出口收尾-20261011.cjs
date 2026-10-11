#!/usr/bin/env node
/**
 * 证据脚本：登记接线最终出口收尾 S1（本地离线）
 * =============================================
 *
 * 直接断言**修后行为**，不把「Codex 缺陷脚本不再复现」当作闭合依据。
 * 只输出 stdout；历史证据不改写、不覆盖。
 *
 * S1 缺陷：最终返回前检查落在外层 catch，磁盘已写 49 文件却返回
 *        `wroteFiles=false` 且缺失 `written`。
 *
 * 验证要点：
 *  - 推进时钟的事件点是「manifest 已写完之后」，因此**真正到达最终检查分支**；
 *    同时断言推进时文件数已达 49，证明事件点位于最终检查之前；
 *  - 覆盖最终检查到期与最终检查时钟无效两例，均须保留已写事实；
 *  - 断言 `written` 与磁盘实际文件完全一致（不多不少、无重复）；
 *  - 预检零写、check/完整复用零写语义不变；
 *  - 合法续建只记录本次补写；正常成功不回归。
 *
 * 边界：不执行真实 SDK、凭据或任何网络请求；`synthetic=false` 只是被测计划契约。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const asm = require(path.join(ROOT, 'miniapp/scripts/assemble-sandbox-registration.cjs'));
const reg = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));

const REVIEW_COMMIT = 'c6d40b9';
const REVIEW_BASELINE = 'afe633d';
const T = Date.parse('2026-03-01T12:00:00.000Z');
const E = T + 20 * 60 * 1000;

const report = {
  reviewCommit: REVIEW_COMMIT,
  reviewBaseline: REVIEW_BASELINE,
  verificationKind: asm.VERIFICATION_KIND,
  nature: {
    localFixOnly: true,
    producesRealExecutionPackage: false,
    deploymentAuthorized: false,
    note: 'synthetic=false 为被测计划契约；wx 与存储为受控合成，非真实 SDK 或平台验证。'
  },
  controlledClock: {
    now: new Date(T).toISOString(),
    window: [new Date(T).toISOString(), new Date(E).toISOString()]
  },
  groups: [],
  protectedBaseline: {},
  networkGuard: {}
};
function group(name, checks) {
  report.groups.push({ group: name, total: checks.length, passed: checks.filter(c => c.ok).length, checks });
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
let seq = 0;
const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const freshId = s => 's1-' + runId + '-' + (++seq) + '-' + s;

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
function fileList(dir) {
  return snapshotTree(dir).filter(x => !x.endsWith('/')).map(x => x.split(':')[0]).sort();
}
function canonicalSorted(list) { return (list || []).slice().sort().join(String.fromCharCode(10)); }
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
    purpose: 'offline-fixture-s1-final-exit',
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
 * 在「manifest 已写完」之后推进时钟 —— 该时刻位于写后检查之后、最终返回前检查。
 * 返回推进时的文件数与时钟读取次数，用于证明确实命中最终检查分支。
 */
function runWithFinalStageClock(operation, dir, mode) {
  let now = T, reads = 0, fired = false, filesAtFire = 0;
  const realDateNow = Date.now;
  Date.now = () => {
    reads++;
    const current = now;
    if (!fired && fs.existsSync(path.join(dir, 'manifest.json'))) {
      filesAtFire = countFiles(dir);
      fired = true;
      now = mode === 'invalid' ? NaN : E;
    }
    return mode === 'invalid' && fired ? NaN : current;
  };
  let r;
  try { r = operation(); } finally { Date.now = realDateNow; }
  return { r, clockReads: reads, fired, filesAtFire };
}

// ═══════════════════════════════════════════════════════════════════════════
// 分组 1：最终返回前检查（真正到达该分支）
// ═══════════════════════════════════════════════════════════════════════════
(function groupFinalExit() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  // 1) 最终检查到期
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('finalexp')));
    const outId = path.basename(dir).slice(asm.OUT_DIR_PREFIX.length);
    const { r, clockReads, fired, filesAtFire } = runWithFinalStageClock(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId }),
      dir, 'expired');
    check('事件屏障命中（推进时已存在 manifest）', fired);
    check('推进时已写满 49 文件（证明位于最终检查之前）', filesAtFire === 49, 'files=' + filesAtFire);
    check('时钟读取次数 >= 4', clockReads >= 4, 'reads=' + clockReads);
    check('拒绝成功', r.ok === false, JSON.stringify(r.problems));
    check('标记 expiredAfterWrite', r.expiredAfterWrite === true);
    check('原因标为 final-check', r.reason === 'final-check', String(r.reason));
    check('wroteFiles=true（磁盘已写，不能报零写）', r.wroteFiles === true, 'wroteFiles=' + r.wroteFiles);
    check('返回 written 清单', Array.isArray(r.written), String(typeof r.written));
    check('written 含 49 项', Array.isArray(r.written) && r.written.length === 49,
      'len=' + (r.written || []).length);
    check('written 无重复', Array.isArray(r.written) && new Set(r.written).size === r.written.length);
    check('产物保留 49 文件', countFiles(dir) === 49, 'files=' + countFiles(dir));
    check('written 与磁盘实际文件完全一致',
      Array.isArray(r.written) && canonicalSorted(r.written) === canonicalSorted(fileList(dir)));
    check('错误码为 ASM_WINDOW_EXPIRED', r.problems[0].code === asm.ERR.WINDOW_EXPIRED, r.problems[0].code);
    check('时钟有效 → 不标 clockInvalid', r.clockInvalid === false);
    check('说明含保留与不可用表述', /已写入并保留/.test(r.problems[0].detail)
      && /不可作为当前有效登记候选/.test(r.problems[0].detail), r.problems[0].detail);
  }
  
  // 2) 最终检查时钟无效（NaN）
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('finalnan')));
    const outId = path.basename(dir).slice(asm.OUT_DIR_PREFIX.length);
    const { r, clockReads, fired, filesAtFire } = runWithFinalStageClock(
      () => asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId }),
      dir, 'invalid');
    check('[NaN] 事件屏障命中', fired);
    check('[NaN] 推进时已写满 49 文件', filesAtFire === 49, 'files=' + filesAtFire);
    check('[NaN] 时钟读取次数 >= 4', clockReads >= 4, 'reads=' + clockReads);
    check('[NaN] 拒绝成功', r.ok === false, JSON.stringify(r.problems));
    check('[NaN] wroteFiles=true（保留已写事实）', r.wroteFiles === true, 'wroteFiles=' + r.wroteFiles);
    check('[NaN] written 含 49 项', Array.isArray(r.written) && r.written.length === 49,
      'len=' + (r.written || []).length);
    check('[NaN] 产物保留 49 文件', countFiles(dir) === 49);
    check('[NaN] 如实标为 clockInvalid', r.clockInvalid === true, 'clockInvalid=' + r.clockInvalid);
    check('[NaN] 说明提及时钟问题', /时钟/.test(r.problems[0].detail), r.problems[0].detail);
    check('[NaN] 未把未知时钟说成已证明的截止时间',
      !/已于.*截止/.test(r.problems[0].detail), r.problems[0].detail);
  }

  group('S1-最终返回前失败出口保留已写事实', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 分组 2：零写语义不变
// ═══════════════════════════════════════════════════════════════════════════
(function groupZeroWrite() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });

  // 预检失败
  {
    const i = candidateInput();
    const dir = track(asm.resolveOutDir(freshId('pre')));
    const before = snapshotTree(dir);
    const r = asm.buildAssembly({
      inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate',
      outId: path.basename(dir).slice(asm.OUT_DIR_PREFIX.length), nowMs: E });
    check('预检失败拒绝成功', r.ok === false, JSON.stringify(r.problems));
    check('预检失败仍为 wroteFiles=false', r.wroteFiles === false);
    check('预检失败不带 written 清单', r.written === undefined);
    check('预检失败目录快照不变', canonicalSorted(snapshotTree(dir)) === canonicalSorted(before));
  }

  // check 与完整复用失败
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
    check('check 失败仍为 wroteFiles=false', c.wroteFiles === false);
    check('check 失败不带 written', c.written === undefined);
    check('check 失败目录不变', canonicalSorted(snapshotTree(built.dir)) === canonicalSorted(before));

    const u = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: expired });
    check('完整复用过期拒绝成功', u.ok === false);
    check('完整复用失败仍为 wroteFiles=false', u.wroteFiles === false);
    check('完整复用失败不带 written', u.written === undefined);
    check('完整复用失败目录不变', canonicalSorted(snapshotTree(built.dir)) === canonicalSorted(before));

    // 正常复用仍成功
    const okReuse = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
    check('未过期完整复用成功且零写', okReuse.ok === true && okReuse.reused === true && okReuse.wroteFiles === false,
      JSON.stringify(okReuse.problems));
    check('未过期复用目录不变', canonicalSorted(snapshotTree(built.dir)) === canonicalSorted(before));
  }

  group('S2-预检与复用零写语义不变', checks);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 分组 3：合法续建与正常成功不回归
// ═══════════════════════════════════════════════════════════════════════════
(function groupResumeAndSuccess() {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail: detail || '' });
  const i = candidateInput();
  const outId = freshId('cont');
  const dir = track(asm.resolveOutDir(outId));
  const missing = `${asm.REGISTRATION_ROOT}/miniprogram/app.wxss`;

  const ok = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
  check('正常成功未回归', ok.ok === true, JSON.stringify(ok.problems));
  check('正常成功 wroteFiles=true', ok.wroteFiles === true);
  check('正常成功 written 为 49 项', ok.written.length === 49);
  check('正常成功不带过期标记', ok.expiredAfterWrite === undefined);
  check('正常成功不带失败原因', ok.reason === undefined);

  fs.unlinkSync(path.join(dir, 'manifest.json'));
  fs.unlinkSync(path.join(dir, missing));
  const cont = asm.buildAssembly({ inputDir: i.inputDir, plan: i.plan, artifactKind: 'real-candidate', outId, nowMs: T });
  check('合法续建成功', cont.ok === true, JSON.stringify(cont.problems));
  check('续建 written 只列本次补写的 2 项',
    canonicalSorted(cont.written) === canonicalSorted([missing, 'manifest.json']),
    JSON.stringify(cont.written));
  check('续建不把原有文件算作新写', cont.written.length === 2);
  check('续建后目录 49 文件', countFiles(dir) === 49);
  
  group('S3-合法续建与正常成功不回归', checks);
})();

// ── 网络拦截敏感性（实际触发点为 3 个） ──────────────────────────────────────
(function networkSensitivity() {
  let httpsBlocked = false, dnsBlocked = false, netBlocked = false;
  try { require('node:https').request('https://example.invalid'); } catch (_) { httpsBlocked = true; }
  try { require('node:dns').lookup('example.invalid'); } catch (_) { dnsBlocked = true; }
  try { require('node:net').connect(443, 'example.invalid'); } catch (_) { netBlocked = true; }
  const probes = [httpsBlocked, dnsBlocked, netBlocked].filter(Boolean).length;
  report.networkGuard = {
    installedPoints: ['http.request', 'https.request', 'net.connect', 'net.createConnection', 'dns.lookup', 'dns.resolve'],
    scope: '本进程 Node 模块拦截点；不是系统级网络审计，也不覆盖原生编译器内部调用。',
    sensitivityTriggered: { httpsRequest: httpsBlocked, dnsLookup: dnsBlocked, netConnect: netBlocked },
    sensitivityPointCount: probes,
    attemptsDuringWork: netState.attempts.length - probes,
    note: '实际触发 3 个点；http.request 为安装拦截点但本轮无对应触发。'
  };
  report.counts = { networkAttempts: report.networkGuard.attemptsDuringWork };
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
      note: '本进程未能调用 git（spawnSync 在当前宿主偶发 EBUSY），已跟踪文件基线未验证，如实记录。'
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
    note: '接手时已跟踪文件运行前后应字节不变；提交范围另由 git diff 核对，两者不混称。'
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
  '实际登记轮次、开始时间与截止时间（本轮只修出口，不产出当次真实执行包）。',
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