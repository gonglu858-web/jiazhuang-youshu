'use strict';
// 三账号业务测试包 S1–S5 定点收尾 · 复核证据（2026-10-14）。
//
// 依据：docs/Codex复查-三账号业务包第二轮返修-20261014.md §3（S1–S5）。
// 性质：离线合成验证——只用合成 wx/db 与本地文件/时钟；不触达 SDK、平台、凭据。
// 每项均为「正确拒绝 + 合法对照」直接断言；不以旧缺陷脚本失败作为闭合依据。
//
// S1 持久回执契约：沿用未改 project-guard 的实际键
//     sbx-create-project: + sha256(businessRoundId)[0:40]（roundRecordId）；
//     本轮合法编号正向通过，他轮/无关编号拒绝（不能仅放开冒号）。
// S2 recordPath 绝对路径契约：相对路径在写入前即拒绝；绝对路径 build/check/复用一致。
// S3 manifest.planFile 固定为 plan.json：改名/路径别名/越界引用拒绝；正常包通过。
// S4 checkCloseDir 检查 close 根本身：junction/symlink 顶替即拒绝，不跟随链接清理。
// S5 部分写/排他写异常公开投影：partialWrites（rel+bytesOnDisk）逐字段保留；
//     部分写与 EEXIST 两类异常分别保存，JSON 从实际结果组装。
//
// 守卫记账口径（同前）：敏感性探针（T0）单独记账；其后业务期任何命中
//（含被 catch 者）计入 businessUnexpected 并使验证失败（exit 1）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const guardHits = [];
const restore = [];
function guard(mod, name) {
  if (typeof mod[name] !== 'function') return;
  const old = mod[name];
  mod[name] = function () { guardHits.push(name); throw new Error('LOCAL_REVIEW_BLOCKED'); };
  restore.push(() => { mod[name] = old; });
}
for (const id of ['node:http', 'node:https']) {
  const mod = require(id); for (const name of ['request', 'get']) guard(mod, name);
}
for (const name of ['connect', 'createConnection']) guard(require('node:net'), name);
guard(require('node:net').Socket.prototype, 'connect');
guard(require('node:tls'), 'connect');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), name); guard(require('node:dns').promises, name);
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  guard(require('node:child_process'), name);
}
guard(globalThis, 'fetch');

const tool = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const projectGuard = require(path.join(ROOT, 'miniapp/cloudfunctions/scheduleSandbox/project-guard.js'));
const { APPID, ENV_ID } = require(path.join(ROOT, 'miniapp/tests/helpers/sandbox-entry-loader.cjs'));

const sha256Buffer = b => crypto.createHash('sha256').update(b).digest('hex');
const implementationSha256 = sha256Buffer(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs')));
const RUN = 's15-' + crypto.randomUUID();
const OUT = path.join(ROOT, 'artifacts/schedule-sandbox/business-test', RUN);
fs.mkdirSync(OUT, { recursive: false });
const results = [];
let seq = 0;
let sensitivityHits = 0;
const ROUND = 'synthetic-round-s15-' + crypto.randomBytes(4).toString('hex');
const PROJECT = 'p_sbx_' + sha256Buffer(Buffer.from(ROUND)).slice(0, 32);
const ROLES = ['owner', 'manager', 'worker'];
const SYN_USERS = Object.fromEntries(ROLES.map((r, i) => [r, {
  userId: 'u_' + String(i + 1).padEnd(40, String(i + 1)), source: 'synthetic 夹具（不代表真实人员）'
}]));

// ── 夹具 ────────────────────────────────────────────────────────────────────
function put(obj) {
  const f = path.join(OUT, 'fx-' + (++seq) + '.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), { flag: 'wx' });
  return f;
}
function realPlan(windowId, receipt) {
  // receipt === undefined → 使用本轮合法确定性编号（合法对照）；否则注入反例编号
  const receiptId = receipt === undefined ? projectGuard.roundRecordId(ROUND) : receipt;
  const p = {
    schema: 'business-test-plan/1', window: windowId, synthetic: false,
    businessRoundId: ROUND, windowNo: windowId + '-01',
    appId: APPID, envId: ENV_ID,
    users: Object.fromEntries(ROLES.map(r => [r, { ...SYN_USERS[r] }])),
    projectReadyMarker: 'ready-' + ROUND,
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T02:00:00Z',
    projectId: PROJECT,
    participantEvidence: {},
    projectReadback: null
  };
  for (const r of ROLES) {
    const f = put({
      schema: 'business-test-participant-record/1', synthetic: false,
      appId: APPID, envId: ENV_ID, businessRoundId: ROUND,
      subject: { role: r, userId: SYN_USERS[r].userId },
      capturedAt: '2030-01-01T00:00:00Z',
      content: '登记/成员查询回执原文（合成夹具，仅验证本地核对路径，不代表真实人员）'
    });
    p.participantEvidence[r] = { kind: 'readback-record', recordPath: f, recordSha256: sha256Buffer(fs.readFileSync(f)) };
  }
  const rf = put({
    schema: 'business-test-project-readback-record/1', synthetic: false,
    appId: APPID, envId: ENV_ID, businessRoundId: ROUND,
    projectId: PROJECT, projectReadyMarker: 'ready-' + ROUND,
    subject: { role: 'owner', userId: SYN_USERS.owner.userId },
    capturedAt: '2030-01-01T00:00:00Z',
    content: 'P 项目回读原文（project-guard 业务项目记录；合成夹具）',
    persistentReceipt: { recordId: receiptId, note: '合成回执夹具（确定性轮次编号）' }
  });
  p.projectReadback = { source: 'readback', projectId: PROJECT, businessRoundId: ROUND,
    projectReadyMarker: 'ready-' + ROUND, recordPath: rf, recordSha256: sha256Buffer(fs.readFileSync(rf)) };
  return p;
}
function planFile(p) { return put(p); }
function build(windowId, p, name) {
  return tool.build(windowId, planFile(p), path.join(OUT, name));
}
function withClock(fn, value) {
  const old = Date.now; Date.now = () => value;
  try { return fn(); } finally { Date.now = old; }
}
function renamePlan(outDir, newName) {
  fs.renameSync(path.join(outDir, 'plan.json'), path.join(outDir, newName));
  const m = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  m.planFile = newName;
  m.files.find(x => x.rel === 'plan.json').rel = newName;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(m, null, 2));
}

async function probe(id, fn) {
  try {
    const actual = await fn();
    results.push({ id, assertionsPassed: true, actual });
  } catch (e) {
    results.push({ id, assertionsPassed: false, error: e.message });
  }
}

async function main() {
  // T0：守卫敏感性探针（实际触发；单独记账，业务期基线自此固定）
  await probe('T0_guard_sensitivity', async () => {
    for (const fn of [
      () => require('node:https').request('https://example.invalid'),
      () => require('node:child_process').spawn('node', [])
    ]) assert.throws(fn, /LOCAL_REVIEW_BLOCKED/);
    sensitivityHits = guardHits.length;
    return { sensitivityProbeHits: sensitivityHits, note: '敏感性探针实际触发并单独记账；业务期基线自此固定' };
  });

  // T1（S1）：持久回执契约——本轮合法编号正向通过；他轮/无关编号拒绝
  await probe('T1_s1_receipt_contract', () => {
    // 正向：实际 roundRecordId → readPlan 通过且 build/check 全链一致
    const okPlan = realPlan('E');
    const parsed = withClock(() => tool.readPlan(planFile(okPlan), 'E'),
      Date.parse('2030-01-01T01:00:00Z'));
    assert.equal(parsed.projectReadback.recordPath !== null, true, '合法回执编号必须通过');
    const b = withClock(() => build('E', okPlan, 't1-ok'), Date.parse('2030-01-01T01:00:00Z'));
    assert.equal(withClock(() => tool.checkDir(b.outDir).ok, Date.parse('2030-01-01T01:00:00Z')), true,
      '合法回执编号包必须通过自身检查');
    // 反例 1：他轮确定性编号
    assert.throws(() => tool.readPlan(planFile(realPlan('E', projectGuard.roundRecordId('other-round-xyz'))), 'E'),
      e => e.code === 'BTP_PLAN_PROJECT_INVALID' && /recordId|持久回执/.test(e.message),
      '他轮编号必须拒绝');
    // 反例 2：格式合法但不相关编号（旧实现只查字符集会放行）
    assert.throws(() => tool.readPlan(planFile(realPlan('E', 'unrelated_receipt_123456')), 'E'),
      e => e.code === 'BTP_PLAN_PROJECT_INVALID' && /recordId|持久回执/.test(e.message),
      '无关编号必须拒绝');
    // 反例 3：缺回执
    const miss = realPlan('E');
    const robj = JSON.parse(fs.readFileSync(miss.projectReadback.recordPath, 'utf8'));
    delete robj.persistentReceipt;
    fs.writeFileSync(miss.projectReadback.recordPath, JSON.stringify(robj, null, 2));
    miss.projectReadback.recordSha256 = sha256Buffer(fs.readFileSync(miss.projectReadback.recordPath));
    assert.throws(() => tool.readPlan(planFile(miss), 'E'),
      e => e.code === 'BTP_PLAN_PROJECT_INVALID' && /persistentReceipt|持久回执/.test(e.message),
      '缺回执必须拒绝');
    return {
      contract: 'sbx-create-project: + sha256(businessRoundId)[0:40]',
      actualContractReceipt: projectGuard.roundRecordId(ROUND),
      legitimateAccepted: true, legitimateBuildCheckOk: true,
      otherRoundRejected: true, unrelatedRejected: true, missingRejected: true
    };
  });

  // T2（S2）：recordPath 绝对路径契约——相对路径写入前拒绝；绝对路径正向（T1 已含）
  await probe('T2_s2_absolute_path_contract', () => {
    const p = realPlan('E', projectGuard.roundRecordId(ROUND));
    for (const ev of Object.values(p.participantEvidence)) {
      ev.recordPath = path.basename(ev.recordPath);
    }
    p.projectReadback.recordPath = path.basename(p.projectReadback.recordPath);
    const relFile = planFile(p);
    assert.throws(() => tool.build('E', relFile, path.join(OUT, 't2-rel')),
      e => /绝对路径/.test(e.message), '相对路径必须在 build 写入前拒绝（不等写满包后才发现）');
    assert.equal(fs.existsSync(path.join(OUT, 't2-rel')), false, '拒绝发生在写入前：零写');
    return { relativeRejectedBeforeWrite: true, zeroWrite: true, absolutePositive: '见 T1 legitimateBuildCheckOk' };
  });

  // T3（S3）：manifest.planFile 固定为 plan.json
  await probe('T3_s3_fixed_plan_file', () => {
    const b = build('P', {
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: ROUND, windowNo: 'P-01', appId: APPID, envId: ENV_ID,
      users: Object.fromEntries(ROLES.map(r => [r, { ...SYN_USERS[r] }])),
      projectReadyMarker: 'ready-' + ROUND,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    }, 't3-normal');
    assert.equal(tool.checkDir(b.outDir).ok, true, '正常生成包必须通过（合法对照）');
    // 反例 1：改名 + 同步 manifest.planFile/清单 rel（其余字节不变）
    renamePlan(b.outDir, 'replacement.json');
    assert.throws(() => tool.checkDir(b.outDir),
      e => e.code === 'BTP_MANIFEST_INVALID' && /planFile 必须固定为 plan.json/.test(e.message),
      '改名 planFile 必须拒绝');
    // 反例 2：路径别名/越界引用
    const b2 = build('P', {
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: ROUND, windowNo: 'P-01', appId: APPID, envId: ENV_ID,
      users: Object.fromEntries(ROLES.map(r => [r, { ...SYN_USERS[r] }])),
      projectReadyMarker: 'ready-' + ROUND,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    }, 't3-alias');
    const m2 = JSON.parse(fs.readFileSync(path.join(b2.outDir, 'manifest.json'), 'utf8'));
    m2.planFile = '..' + path.sep + 'escape.json';
    fs.writeFileSync(path.join(b2.outDir, 'manifest.json'), JSON.stringify(m2, null, 2));
    assert.throws(() => tool.checkDir(b2.outDir),
      e => e.code === 'BTP_MANIFEST_INVALID' && /planFile 必须固定为 plan.json/.test(e.message),
      '越界 planFile 引用必须拒绝');
    return { normalPackageOk: true, renamedRejected: true, aliasRejected: true };
  });

  // T4（S4）：checkCloseDir 检查 close 根本身；不跟随链接清理
  await probe('T4_s4_close_root_boundary', () => {
    const b = build('P', {
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: ROUND, windowNo: 'P-01', appId: APPID, envId: ENV_ID,
      users: Object.fromEntries(ROLES.map(r => [r, { ...SYN_USERS[r] }])),
      projectReadyMarker: 'ready-' + ROUND,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    }, 't4-normal');
    // 正向对照：普通 close 独立核验通过，且与时钟无关（NaN 也 ok）
    assert.equal(tool.checkCloseDir(b.outDir).ok, true, '普通 close 必须独立通过');
    assert.equal(withClock(() => tool.checkCloseDir(b.outDir).ok, NaN), true, '关闭核验不受时钟影响');
    // 反例：close 本身被 junction 顶替（候选根保持普通目录）
    const externalClose = path.join(OUT, 't4-external-close');
    fs.renameSync(path.join(b.outDir, 'close'), externalClose);
    fs.symlinkSync(externalClose, path.join(b.outDir, 'close'), 'junction');
    const r = tool.checkCloseDir(b.outDir);
    assert.equal(r.ok, false, 'close 根 junction 必须被独立关闭检查拒绝');
    assert.ok(r.problems.some(x => /close 根缺失或为符号链接\/junction/.test(x)), r.problems.join('; '));
    assert.equal(fs.existsSync(path.join(externalClose, 'server', 'gate.js')), true, '不跟随链接清理文件');
    return { normalCloseOk: true, closeClockIndependent: true, junctionCloseRejected: true, noFollowNoCleanup: true };
  });

  // T5（S5）：部分写/EEXIST 两类异常分别保存，公开投影逐字段保留，JSON 从实际结果组装
  await probe('T5_s5_partial_and_eexist_projection', () => {
    // 反例 A：部分写（首文件 7 字节后 EIO）——单独保存 errA
    const pf = planFile({
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: ROUND, windowNo: 'P-01', appId: APPID, envId: ENV_ID,
      users: Object.fromEntries(ROLES.map(r => [r, { ...SYN_USERS[r] }])),
      projectReadyMarker: 'ready-' + ROUND,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    });
    const partialDir = path.join(OUT, 't5-partial');
    const realWrite = fs.writeFileSync;
    let errA = null;
    fs.writeFileSync = function (f, buf, opts) {
      if (f === path.join(partialDir, 'server', 'index.js')) {
        realWrite.call(this, f, Buffer.from(buf).subarray(0, 7), opts);
        const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e;
      }
      return realWrite.call(this, f, buf, opts);
    };
    try { tool.build('P', pf, partialDir); } catch (e) { errA = e; } finally { fs.writeFileSync = realWrite; }
    assert.ok(errA, '部分写异常必须抛出');
    assert.deepEqual(errA.written, ['server/index.js'], 'written 事实保留');
    assert.equal(errA.wroteFiles, 1, 'wroteFiles 事实保留');
    assert.deepEqual(errA.partialWrites, [{ rel: 'server/index.js', bytesOnDisk: 7 }],
      'partialWrites 必须公开投影（rel + bytesOnDisk）');
    assert.equal(fs.statSync(path.join(partialDir, 'server', 'index.js')).size, 7, '盘上确为 7 字节部分文件');
    // 反例 B：竞态 EEXIST——单独保存 errB（不复用 errA）
    const racePlan = planFile({
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: ROUND, windowNo: 'P-01', appId: APPID, envId: ENV_ID,
      users: Object.fromEntries(ROLES.map(r => [r, { ...SYN_USERS[r] }])),
      projectReadyMarker: 'ready-' + ROUND,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    });
    const raceDir = path.join(OUT, 't5-race');
    let errB = null;
    fs.writeFileSync = function (f, buf, opts) {
      if (f === path.join(raceDir, 'server', 'gate.js')) {
        realWrite.call(this, f, Buffer.from('other-writer'), opts);
        const e = new Error('EEXIST race'); e.code = 'EEXIST'; throw e;
      }
      return realWrite.call(this, f, buf, opts);
    };
    try { tool.build('P', racePlan, raceDir); } catch (e) { errB = e; } finally { fs.writeFileSync = realWrite; }
    assert.ok(errB, 'EEXIST 异常必须抛出');
    assert.equal(errB.code, 'EEXIST');
    assert.ok(!errB.written || !errB.written.includes('server/gate.js'), '他人文件不算本轮写入');
    assert.ok(/EEXIST/.test(errB.sideEffect || ''), 'EEXIST 异常须携带 sideEffect 事实');
    assert.equal(fs.readFileSync(path.join(raceDir, 'server', 'gate.js'), 'utf8'), 'other-writer', '不覆盖他人文件');
    // JSON 从实际结果组装（不硬填、不串用后一次异常）
    return {
      partialWrite: {
        code: errA.code,
        written: errA.written || null,
        wroteFiles: errA.wroteFiles || 0,
        partialWrites: errA.partialWrites || null,
        bytesOnDiskOnDisk: fs.statSync(path.join(partialDir, 'server', 'index.js')).size
      },
      eexist: {
        code: errB.code,
        sideEffect: errB.sideEffect || null,
        written: errB.written || null,
        wroteFiles: errB.wroteFiles || 0
      }
    };
  });

  // T6：控制组——已关闭项保持（48 文件/续建 1 复用 47/真实模式过期构建零写）
  await probe('T6_closed_controls', () => {
    const p = planFile({
      schema: 'business-test-plan/1', window: 'P', synthetic: true,
      businessRoundId: ROUND, windowNo: 'P-01', appId: APPID, envId: ENV_ID,
      users: Object.fromEntries(ROLES.map(r => [r, { ...SYN_USERS[r] }])),
      projectReadyMarker: 'ready-' + ROUND,
      windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z'
    });
    const b = tool.build('P', p, path.join(OUT, 't6-control'));
    const snap = [];
    for (const rel of ['plan.json', 'server/gate.js', 'close/server/gate.js']) {
      snap.push({ rel, sha: sha256Buffer(fs.readFileSync(path.join(b.outDir, rel))) });
    }
    fs.unlinkSync(path.join(b.outDir, b.manifest.closePackage.files[0].rel));
    const b2 = tool.build('P', p, b.outDir);
    assert.equal(b2.io.filter(x => x.action === 'written').length, 1, '续建补 1');
    assert.equal(b2.io.filter(x => x.action === 'reused').length, 47, '复用 47');
    assert.equal(tool.checkDir(b.outDir).ok, true, '控制包通过');
    // 过期真实模式构建：目录未创建、零写（R2 时效保持）
    const rp = realPlan('E');
    rp.windowStartsAt = new Date(Date.now() - 7200e3).toISOString();
    rp.windowExpiresAt = new Date(Date.now() - 3600e3).toISOString();
    const expiredOut = path.join(OUT, 't6-expired');
    let err = null;
    try { tool.build('E', planFile(rp), expiredOut); } catch (e) { err = e; }
    assert.equal(err && err.code, 'BTP_WINDOW_EXPIRED');
    assert.equal(fs.existsSync(expiredOut), false, '过期构建零写且目录未创建');
    return { controlsKept: true, resumeWritten: 1, reused: 47, expiredBuild: 'BTP_WINDOW_EXPIRED(目录未创建)' };
  });
}

function emitReport() {
  const businessUnexpected = guardHits.length - sensitivityHits;
  const report = {
    schema: 'business-test-s15-review/1',
    title: '三账号业务测试包 S1–S5 定点收尾复核',
    reviewedCommit: '816ab89',
    reviewBasis: 'docs/Codex复查-三账号业务包第二轮返修-20261014.md §3（S1–S5）；接手 master 5ed9f60',
    implementationPath: 'miniapp/scripts/package-business-test.cjs',
    implementationSha256,
    generatedAt: new Date().toISOString(),
    verificationKind: 'offline synthetic files/time only; no SDK/platform/real identity/network',
    results,
    guardAccounting: {
      sensitivityProbeHits: sensitivityHits,
      businessPeriodUnexpectedAttempts: businessUnexpected,
      caughtAttemptsCounted: true,
      note: '敏感性与业务期命中分别记账；业务期命中含被调用方捕获的尝试'
    },
    summary: {
      total: results.length,
      assertionsPassed: results.filter(r => r.assertionsPassed).length,
      unexpectedGuardAttempts: businessUnexpected
    }
  };
  const output = JSON.stringify(report, null, 2) + '\n';
  const args = process.argv.slice(2);
  if (args.length) {
    assert.equal(args.length, 2);
    assert.equal(args[0], '--out');
    fs.writeFileSync(path.resolve(args[1]), output, { flag: 'wx' });
  }
  process.stdout.write(output);
  if (results.some(r => !r.assertionsPassed) || businessUnexpected !== 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => restore.reverse().forEach(f => f()))
  .then(() => { if (process.exitCode !== 1) emitReport(); else emitReport(); });
