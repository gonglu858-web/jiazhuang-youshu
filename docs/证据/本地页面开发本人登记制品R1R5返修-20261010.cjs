#!/usr/bin/env node
'use strict';
// 新证据只输出 stdout；历史证据不读取执行、不修改。另存 JSON 时使用独占写入。
// 唯一测试子进程为本机 Node；Git 命令只读本地对象，不联网、不取凭据。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const child = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const reg = require(path.join(root, 'miniapp/scripts/package-sandbox-registration.cjs'));
const baseline = 'a0023da';
const modified = [
  'miniapp/scripts/package-sandbox-registration.cjs',
  'miniapp/tests/sandbox-registration-package.test.cjs',
  'docs/本人登记制品操作稿-20261010.md',
  'docs/进展与待办.md',
  'docs/WorkBuddy开发交接.md'
];
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
function git(args) {
  const r = child.spawnSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, '只读 Git 命令失败：' + args[0]); return r.stdout;
}
function fileFact(rel) {
  const file = path.join(root, rel), st = fs.lstatSync(file);
  assert.ok(st.isFile() && !st.isSymbolicLink(), '证据输入必须是普通文件：' + rel);
  const b = fs.readFileSync(file); return { path: rel, bytes: b.length, sha256: sha256(b) };
}
function protectedFacts() {
  return git(['ls-tree', '-r', '-z', baseline]).toString('utf8').split('\0').filter(Boolean)
    .map(row => {
      const tab = row.indexOf('\t'), rel = row.slice(tab + 1);
      const [, type, objectId] = row.slice(0, tab).split(' ');
      if (modified.includes(rel)) return null;
      assert.equal(type, 'blob', '未声明的基线条目类型：' + rel);
      const fact = fileFact(rel), b = fs.readFileSync(path.join(root, rel));
      const blob = crypto.createHash('sha1').update(Buffer.from('blob ' + b.length + '\0')).update(b).digest('hex');
      assert.equal(blob, objectId, '受保护文件与复核提交字节不同：' + rel);
      return { ...fact, gitBlob: objectId };
    }).filter(Boolean);
}
function verifyIndependentPins() {
  return Object.entries(reg.PINNED_FACTS).map(([rel, pinned]) => {
    const b = git(['show', reg.REVIEWED_SOURCE_VERSION + ':' + rel]);
    assert.equal(b.length, pinned.bytes, '独立 Git 来源字节数：' + rel);
    assert.equal(sha256(b), pinned.sha256, '独立 Git 来源哈希：' + rel);
    assert.deepEqual(fileFact(rel), { path: rel, bytes: pinned.bytes, sha256: pinned.sha256 });
    return { path: rel, ...pinned };
  });
}
function walkFacts(dir, prefix = '') {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const abs = path.join(dir, name), rel = prefix ? prefix + '/' + name : name;
    const st = fs.lstatSync(abs); assert.equal(st.isSymbolicLink(), false);
    if (st.isDirectory()) return walkFacts(abs, rel);
    assert.equal(st.isFile(), true);
    const b = fs.readFileSync(abs); return [{ rel, bytes: b.length, sha256: sha256(b) }];
  });
}
function main() {
  const before = protectedFacts();
  const sourcePins = verifyIndependentPins();
  const command = ['--test', '--test-reporter=tap', 'miniapp/tests/sandbox-registration-package.test.cjs'];
  const result = child.spawnSync(process.execPath, command, {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000
  });
  if (result.error) throw result.error; // 环境受阻明确失败；不静态回退、不重试子进程。
  const tap = result.stdout || '';
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].map(key => {
    const m = tap.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'));
    assert.ok(m, '缺测试实跑统计：' + key); return [key, Number(m[1])];
  }));
  const rows = Array.from(tap.matchAll(/^(not ok|ok) (\d+) - (.+)$/gm),
    m => ({ number: Number(m[2]), name: m[3], passed: m[1] === 'ok' }));
  assert.equal(result.status, 0, '相关测试失败：\n' + tap + (result.stderr || ''));
  assert.equal(counts.tests, rows.length); assert.equal(counts.pass, counts.tests);
  assert.equal(counts.fail + counts.skipped + counts.cancelled + counts.todo, 0);
  const id = 'r1r5-evidence-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const plan = { purpose: 'synthetic-offline-verification-only', ...reg.FIXED_TARGET,
    allowedUserIds: ['u_' + sha256(Buffer.from(reg.FIXED_TARGET.appId + ':synthetic-registration-openid')).slice(0, 40)],
    roundId: 'SYNTH-REG-0001', windowStartsAt: '2026-01-01T00:00:00.000Z',
    windowExpiresAt: '2026-01-01T00:20:00.000Z', sourceVersion: reg.REVIEWED_SOURCE_VERSION, synthetic: true };
  const candidate = reg.buildRegistration(plan, { outId: id, nowMs: Date.parse('2026-01-01T00:05:00Z') });
  assert.equal(candidate.ok, true);
  const artifactFacts = walkFacts(candidate.dir); assert.equal(artifactFacts.length, 11);
  const checked = reg.checkRegistration({ outDir: candidate.dir, plan }); assert.equal(checked.ok, true);
  const reused = reg.buildRegistration(plan, { outId: id, nowMs: Date.parse('2026-01-01T00:06:00Z') });
  assert.equal(reused.reused, true); assert.equal(reused.wroteFiles, false);
  assert.deepEqual(walkFacts(candidate.dir), artifactFacts);
  assert.deepEqual(protectedFacts(), before);
  const evidencePath = path.relative(root, __filename).replace(/\\/g, '/');
  return {
    schema: 'local-registration-r1r5-evidence/1', executor: '本地页面开发', recordedAt: new Date().toISOString(),
    task: '本人登记制品 R1–R5 定点返修', status: '待Codex复查；平台未验证未放行',
    projectRoot: root, branch: git(['branch', '--show-current']).toString('utf8').trim(),
    reviewedDelivery: reg.REVIEWED_SOURCE_VERSION, reviewBaseline: baseline,
    verificationKinds: {
      synthetic: '合成计划/时钟/微信上下文/SDK/存储/数据库/事务；故障替身仅限内存。',
      actualApplication: '真实应用代码＋合成SDK/数据库：生成 index/gate/map/vendor main 及实际 Page/client/协调器。',
      actualFilesystem: '本机实际生成/检查、冲突/额外项、合法续建/复用、真实目录联接；写入阶段 EIO 由合成 fs 注入。',
      actualSdkConversion: { verified: false, executed: false },
      platform: { verified: false, executed: false, items: ['IAM/平台事务/配额账单', '真实凭据/本人微信',
        '完整前端包/微信编译/真机', '预览/部署/入口启用', '管理员初始化/批准签发者'] }
    },
    historicalCorrection: '旧JSON原样保留；旧“真实SDK本地转换”应读为真实应用代码＋合成SDK/数据库。动作数为14＋4＋1＝19。',
    evidencePreparation: '首个证据脚本运行因walkFacts缺右括号语法失败，未写JSON；修正后执行本次证据。不覆盖历史材料。',
    testRun: { command: 'node ' + command.join(' '), executable: process.execPath, exitCode: result.status,
      ...counts, rows, tapSha256: sha256(Buffer.from(tap)), stderr: result.stderr || '',
      earlierRepairRun: { tests: 81, pass: 79, fail: 2, skipped: 0,
        explanation: 'G1 完整包拒绝码分支顺序、字符串 VM 缺 exports；修正后81/81通过。' } },
    closure: Object.fromEntries(['R1', 'R2', 'R3', 'R4', 'R5'].map(group => [group, {
      tests: rows.filter(row => row.name.includes(group)), selfTestPassed: true, independentCodexAccepted: false
    }])),
    normalControl: { generated: true, checked: checked.ok, reused: reused.reused, reuseWrites: reused.wroteFiles,
      synthetic: true, artifactDir: path.relative(root, candidate.dir).replace(/\\/g, '/'),
      artifactFacts, differences: candidate.differences, closedPackage: candidate.manifest.closedPackage,
      frontendDependencies: candidate.manifest.frontendDependencies },
    independentSourcePins: sourcePins,
    protectedFiles: { count: before.length, allEqualReviewBaselineBeforeAndAfter: true,
      factsSha256: sha256(Buffer.from(JSON.stringify(before))), files: before },
    finalFiles: modified.concat(evidencePath).map(fileFact),
    boundaries: { localOnly: true, network: false, credentialAcquisition: false, installed: false,
      cloudResources: false, preview: false, deployment: false, actualRegistration: false,
      adminInitialization: false, sourceEntriesEnabled: false, realCacheCleared: false, abcHandled: false },
    gaps: ['待Codex独立复核，81通过不等于验收或部署授权。',
      '首次未绑定identify未知结果无持久防重；未自动重发，明确停止，不点击核对并重试。',
      '不组装完整预览包；两份配置覆盖本身不能预览。', '真实SDK与平台未执行；真实写入仍需具体执行包及用户确认。']
  };
}
try { process.stdout.write(JSON.stringify(main(), null, 2) + '\n'); }
catch (e) {
  process.stdout.write(JSON.stringify({ schema: 'local-registration-r1r5-evidence/1', executor: '本地页面开发',
    ok: false, error: String(e.message), status: '证据执行失败；未验证未放行' }, null, 2) + '\n');
  process.exitCode = 1;
}
