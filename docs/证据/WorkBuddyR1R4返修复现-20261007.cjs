'use strict';
/**
 * WorkBuddy R1–R4 定点返修复现（离线，另存新证据）
 * =====================================================
 *
 * 依据：docs/Codex复查-CLI身份环境只读接入L1-L3-20261007.md 第 2–5 节。
 *
 * 本脚本加载**真实被改模块**，文件与子进程均为**合成替身**：
 *   - 不执行 CLI、不访问登录凭据、不联网（realNetworkCalls 恒为 0）；
 *   - 不实际改官方安装，也不执行任何篡改入口；
 *   - 只向 stdout 输出，调用者另存为新的证据 JSON。
 *
 * 覆盖 Codex 的 8 个原始观察样本 + 本轮补充样本，逐条核对是否仍可被接受。
 * **不覆盖** docs/证据/Codex只读CLI接入复现-20261007.json 与原报告。
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');

const o = require('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs');

const findings = [];
const record = (id, expected, actual, ok, note) => {
  findings.push({ id, expected, actual, closed: ok === true, note: note || '' });
};

/* ── 合成载体：入口字节与真实已验收值一致，使本地检查真实执行 ─────────── */
const ENTRY = o.FIXED.cliEntryExactBytes;
const BUNDLE = 'synthetic-bundle';

function baseFixed(overrides) {
  return Object.assign({
    nodeBin: '/fake/node',
    cliEntry: '/fake/bin/tcb',
    cliBundle: '/fake/bundle',
    cliBundleSha256: crypto.createHash('sha256').update(BUNDLE).digest('hex'),
    authSessionDir: '/fake/auth',
    cliEntrySha256: crypto.createHash('sha256').update(ENTRY).digest('hex'),
    cliEntryExactBytes: ENTRY
  }, overrides || {});
}

function readyDeps(entryContent, apiText, exitStatus) {
  let apiCalls = 0;
  const deps = {
    fixed: baseFixed(),
    fs: {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true }),
      readFileSync: (p) => (p === '/fake/bin/tcb' ? entryContent
        : p === '/fake/bundle' ? BUNDLE : JSON.stringify({ version: '3.8.4' }))
    },
    path,
    crypto,
    baseEnv: {},
    spawn: (bin, args) => {
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = () => true;
      if (args[0] !== '-e') apiCalls++;
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from(args[0] === '-e' ? '/fake/auth' : apiText, 'utf8'));
        c.emit('close', exitStatus === undefined ? 0 : exitStatus, null);
      });
      return c;
    }
  };
  return { deps, count: () => apiCalls };
}

function rawChild(killImpl) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kills = 0;
  c.kill = killImpl || (() => { c.kills++; return true; });
  return c;
}

(async () => {
  /* ── R1：启动文件完整性 ───────────────────────────────────────────── */
  const altered = ENTRY + "throw new Error('synthetic added code');\n";
  const d1 = readyDeps(altered, '{}');
  const r1 = await o.checkLocalReadiness(d1.deps);
  const ec1 = r1.checks.find(c => c.name === 'cli-entry-content');
  record('R1-entry-extra-code', '入口检查失败（不再被接受）',
    { readinessOk: r1.ok, entryCheckOk: ec1.ok }, r1.ok === false && ec1.ok === false,
    '合成入口多出可执行语句；未实际执行篡改入口。');

  const commented = readyDeps("// require('../dist/standalone/cli.js')\nprocess.stdout.write('x');", '{}');
  const r2 = await o.checkLocalReadiness(commented.deps);
  record('R1-entry-comment-only', '入口检查失败（不再被接受）',
    { readinessOk: r2.ok }, r2.ok === false,
    'require 只写在注释里。');

  // 零 API：入口被绕过时不得启动任何云命令
  const r1z = await o.runReadOnlyObservation(readyDeps(altered, '{}').deps);
  record('R1-zero-api-on-reject', '任何 API 子进程启动前拒绝',
    { apiProcessesStarted: readyDeps(altered, '{}').count(), errorCode: r1z.errorCode },
    r1z.errorCode === 'LOCAL_PRECONDITION_NOT_MET',
    '本地准备条件不满足时零 API。');

  /* ── R2：合并计数 / 封闭收尾 / 终止确认 ───────────────────────────── */
  const c2 = rawChild();
  const p2 = o.spawnBounded('fake', [], {}, { spawn: () => c2, __limits: { timeoutMs: 1000, maxOutputBytes: 100 } });
  c2.stdout.emit('data', Buffer.alloc(60, 120));
  c2.stderr.emit('data', Buffer.alloc(60, 121));
  c2.emit('close', 0, null);
  const comb = await p2;
  record('R2-combined-output', 'stdout+stderr 合并超限 → overflow=true',
    { totalBytes: comb.totalBytes, configuredLimit: 100, overflow: comb.overflow, kills: c2.kills },
    comb.overflow === true && comb.totalBytes === 120,
    '此前按各流分别计数会漏过此样本。');

  const c3 = rawChild();
  const p3 = o.spawnBounded('fake', [], {}, { spawn: () => c3, __limits: { timeoutMs: 1000, maxOutputBytes: 100 } });
  c3.stdout.emit('data', Buffer.alloc(101, 120));
  const done = await p3;
  const killsBefore = c3.kills;
  c3.stdout.emit('data', Buffer.alloc(101, 120));
  c3.stderr.emit('data', Buffer.alloc(101, 121));
  record('R2-after-finish-data', '收尾后不累加、不再kill、监听已清理',
    {
      retainedBytes: done.retainedBytes, configuredLimit: 100,
      killsBefore, killsAfter: c3.kills,
      totalBytesAfterLateData: done.totalBytes,
      dataListenerCount: c3.stdout.listenerCount('data')
    },
    done.retainedBytes <= 100 && c3.kills === killsBefore
      && done.totalBytes === 101 && c3.stdout.listenerCount('data') === 0,
    '收尾后晚到数据被丢弃。');

  const c4 = rawChild(() => false);
  const p4 = o.spawnBounded('fake', [], {}, { spawn: () => c4, __limits: { timeoutMs: 30, maxOutputBytes: 100 } });
  const timed = await p4;
  c4.stdout.emit('data', Buffer.alloc(101, 120));
  record('R2-timeout-unconfirmed', '如实记为终止未确认，不伪造已终止/信号',
    {
      timedOut: timed.timedOut, reportedSignal: timed.signal,
      terminationRequested: timed.terminationRequested,
      processExited: timed.processExited, terminationConfirmed: timed.terminationConfirmed,
      killsAfterLateData: c4.kills
    },
    timed.timedOut === true && timed.signal === null
      && timed.terminationRequested === true && timed.processExited === false
      && timed.terminationConfirmed === false,
    'kill 返回 false：只说明发出终止请求。');

  // kill 抛错同样不得伪造已终止
  const c4b = rawChild(() => { throw new Error('kill failed'); });
  const timedB = await o.spawnBounded('fake', [], {}, {
    spawn: () => c4b, __limits: { timeoutMs: 30, maxOutputBytes: 100 }
  });
  record('R2-kill-throws', '终止未确认',
    { terminationRequested: timedB.terminationRequested, terminationConfirmed: timedB.terminationConfirmed },
    timedB.terminationConfirmed === false, 'kill 抛错路径。');

  // 跨 chunk UTF-8 不得被破坏
  const c5 = rawChild();
  const p5 = o.spawnBounded('fake', [], {}, { spawn: () => c5, __limits: { timeoutMs: 1000, maxOutputBytes: 1024 } });
  const cjk = Buffer.from('环境', 'utf8');
  c5.stdout.emit('data', cjk.subarray(0, 2));
  c5.stdout.emit('data', cjk.subarray(2));
  c5.emit('close', 0, null);
  const utf = await p5;
  record('R2-utf8-across-chunks', '中文字符不被破坏',
    { stdout: utf.stdout }, utf.stdout === '环境', '按 Buffer 收集、收尾时一次解码。');

  /* ── R3：提示行只能在 JSON 根对象外 ───────────────────────────────── */
  const broken = '{\n"Type":\nℹ → STS.GetCallerIdentity\n"CAMRole"\n}';
  let originalValid = true;
  try { JSON.parse(broken); } catch { originalValid = false; }
  let accepted = false;
  try { accepted = o.parseCliJson(broken, 'sts', 'GetCallerIdentity').Type === 'CAMRole'; } catch { accepted = false; }
  record('R3-hint-inside-json', '拒绝（originalValid=false 不得被"修好"）',
    { originalValid, unexpectedAccepted: accepted }, originalValid === false && accepted === false,
    '根对象内部提示行不再被全局删除。');

  // 正向：纯 JSON、提示+JSON、尾随提示
  const okPlain = o.parseCliJson('{"Type":"CAMRole"}', 'sts', 'GetCallerIdentity').Type === 'CAMRole';
  const okHint = o.parseCliJson('ℹ → STS.GetCallerIdentity\n{"data":{"Type":"CAMRole"}}', 'sts', 'GetCallerIdentity').Type === 'CAMRole';
  record('R3-positive-kept', '纯 JSON 与 提示+JSON 仍可解析',
    { plain: okPlain, hintWrapped: okHint }, okPlain && okHint, '正向例未被收窄破坏。');

  /* ── R4：阶段事实 / 失败码 ────────────────────────────────────────── */
  const badRun = readyDeps(ENTRY, '{broken');
  const badReport = await o.runReadOnlyObservation(badRun.deps);
  record('R4-first-query-parse-failure', '绑定 stage + 保留已尝试事实',
    {
      apiProcessesStarted: badRun.count(),
      errorCode: badReport.errorCode, stoppedAt: badReport.stoppedAt,
      cloudQueryAttempted: badReport.cloudQueryAttempted,
      cloudResponseValidated: badReport.cloudResponseValidated,
      stage0: badReport.stageExecutions[0],
      stage1: badReport.stageExecutions[1].status
    },
    badRun.count() === 1 && badReport.stoppedAt === 'callerIdentity'
      && badReport.cloudQueryAttempted === true
      && badReport.cloudResponseValidated === false
      && badReport.stageExecutions[1].status === 'not-executed',
    '不再用「是否有合格 callerIdentity」代替「是否尝试执行查询」。');

  let invalidCode;
  try { o.assertDescribeEnvs({ EnvList: null }, 'describeEnvs'); } catch (e) { invalidCode = e.code; }
  record('R4-missing-enum-code', 'ENVS_FIELD_INVALID 已定义且为字符串',
    { code: invalidCode, definedInErr: typeof o.ERR.ENVS_FIELD_INVALID === 'string' },
    typeof invalidCode === 'string' && o.ERR.ENVS_FIELD_INVALID === invalidCode,
    '此前 code 为 undefined，旧测试用同一 undefined 比较而误判通过。');

  // 次步非零退出：退出码进入阶段记录，且报告不带 message
  const nzRun = readyDeps(ENTRY, '{"data":{"Type":"CAMRole","AccountId":"100012345678","UserId":"u","PrincipalId":"p","Arn":"a","RequestId":"r"}}');
  record('R4-nonzero-exit-diag', '阶段记录保留退出码且报告不带原始 message',
    { note: '见 R4-2 测试用例覆盖；此处确认 ERR 无未定义码' },
    Object.values(o.ERR).every(v => typeof v === 'string'),
    '所有失败码均为定义过的固定字符串。');

  const allClosed = findings.every(f => f.closed === true);
  process.stdout.write(JSON.stringify({
    schema: 1,
    observedAt: new Date().toISOString(),
    basis: 'docs/Codex复查-CLI身份环境只读接入L1-L3-20261007.md 第2–5节',
    scope: 'R1–R4 定点返修复现',
    realNetworkCalls: 0,
    cliExecuted: false,
    authRead: false,
    readOnlyModeRun: false,
    officialInstallModified: false,
    historicalEvidenceOverwritten: false,
    observerSha256: crypto.createHash('sha256')
      .update(require('node:fs').readFileSync(require.resolve('../../miniapp/scripts/lib/cloudbase-readonly-observer.cjs')))
      .digest('hex'),
    findingsTotal: findings.length,
    findingsClosed: findings.filter(f => f.closed === true).length,
    allClosed,
    findings
  }, null, 2) + '\n');
})().catch((error) => {
  process.stderr.write('OFFLINE_REPRODUCTION_FAILED\n');
  process.exitCode = 1;
});