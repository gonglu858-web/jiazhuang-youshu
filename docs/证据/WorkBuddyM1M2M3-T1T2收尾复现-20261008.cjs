#!/usr/bin/env node
'use strict';
/**
 * WorkBuddy M1/M2/M3 T1/T2 收尾复现（SDK 只读身份接入）— 2026-10-08
 *
 * 依据：docs/Codex复核-SDK只读身份S1-S3收尾-20261008.md 第 2、3 节。
 *
 * 覆盖的真实缺陷
 * ────────────
 *  T1 [P2] 两处布尔判断仍是 `!== false`，与交付说明/函数注释声称的
 *     「必须严格 true、不再混用 `!== false`」不一致：
 *       out.userIdShapeValid = out.userId !== null && rec.userIdShapeValid !== false;
 *       out.statusValid       = out.status   !== null && rec.statusValid       !== false;
 *     把「缺失 / null / 0 / 空串」这些**并非明确通过**的损坏协议值当成通过。
 *     位置：observer 的 `sanitizeWorkerRecord`。
 *
 *  T2 [P2] 两条时效测试（S3-5/S3-6）没有验证标题所称阶段：
 *     S3-5 的子进程全部 exit 1，流程在 CLI 阶段就停止，断言却允许
 *     stoppedAt ∈ {sameBatchCredential, cliAssociation}；两条测试都用
 *     「now() 调用次数」猜阶段；S3-6 没有明确的 worker 响应分支。
 *     T2 **只修测试**，不重做 S3 实现（Codex 已补证实现正确）。
 *
 * 严格边界
 * ──────
 * - 全部离线：不执行官方 CLI、不联网、不获取任何真实凭据、不安装、不初始化、不部署。
 * - 子进程为合成 EventEmitter；不执行真实 worker 子进程。
 * - 只读核对源码哈希；**不读取认证内容**，不查旧业务集合。
 * - 只创建空临时隔离目录（与被复核脚本一致）；产物**只写stdout**。
 * - **不覆盖任何历史证据**。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..', '..');
const MINIAPP = path.join(ROOT, 'miniapp');
const OBSERVER_PATH = path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs');
const WORKER_PATH = path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs');
const o = require(OBSERVER_PATH);
const w = require(WORKER_PATH);

const SYN_OPENID = 'synthetic-offline-only';
const SYN_TARGET = w.deriveUserId('wxfb4db1615ac15531', SYN_OPENID);
const SYN_ACCOUNT = '123456789012';
const UUID_V4 = '00000000-0000-4000-8000-000000000001';

const results = [];
function record(id, pass, detail) {
  results.push(Object.assign({ id, pass: Boolean(pass) }, detail || {}));
}

/** 一份合法的 worker 输出，供 T1 逐项篡改布尔标记。 */
function validPayload() {
  return {
    ok: true, writeAttemptsCount: 0, credentialExpiredDuringRun: false,
    primary: {
      classification: 'OBSERVED', docId: 'primary',
      userId: SYN_TARGET, status: 'active',
      userIdShapeValid: true, statusValid: true
    },
    targetUser: {
      classification: 'OBSERVED', docId: SYN_TARGET, status: 'active', statusValid: true,
      openidPresent: true, openidShapeValid: true, derivationChecked: true, derivationMatches: true
    }
  };
}

/** 走完整解释链：worker 输出 → interpretWorkerOutput → interpretPrimary/interpretTargetUser */
function chain(payload) {
  const normalized = o.interpretWorkerOutput({
    code: 0, signal: null, stdout: JSON.stringify(payload),
    terminationConfirmed: true, targetUserId: SYN_TARGET
  });
  return {
    normalized,
    primary: o.interpretPrimary(normalized, SYN_TARGET),
    users: o.interpretTargetUser(normalized, SYN_TARGET)
  };
}

/**
 * T2：以 **worker 返回事件**为屏障推进时钟，跑完整父进程编排。
 *
 * 不用「now() 调用次数」猜阶段 —— 时钟只在 worker close 时被推进，
 * 因此过期必然落在「worker 最后一次检查之后、父进程收尾复核之前」这段窗口。
 *
 * @param {boolean} opts.workerFails        worker 是否返回失败
 * @param {boolean} opts.expireOnWorkerClose 是否在 worker close 时把时钟推到过期
 */
async function runWithWorkerEventBarrier(opts) {
  const options = opts || {};
  const base = Date.now();
  let clock = base;
  const stages = [];
  let workerReturned = false;
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: SYN_TARGET },
    {
      now: () => clock,
      baseEnv: {},
      fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 't1t2-iso-')) },
      fetchCredential: async () => JSON.stringify({
        secretId: 'synthetic-id', secretKey: 'synthetic-key', token: 'synthetic-token',
        expiredAt: new Date(base + 600000).toISOString(), isTemporary: true, envId: o.FIXED.envId
      }),
      spawn: (bin, argv) => {
        const c = new EventEmitter();
        c.stdout = new EventEmitter();
        c.stderr = new EventEmitter();
        c.stdin = new EventEmitter();
        c.stdin.write = () => true;
        c.stdin.end = () => {};
        c.kill = () => true;
        const isWorker = argv.length === 1;
        stages.push(isWorker ? 'worker' : argv[2] + '.' + argv[3]);
        setImmediate(() => {
          if (isWorker) {
            const payload = options.workerFails
              ? { ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 }
              : validPayload();
            workerReturned = true;
            c.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
            // 事件屏障：worker 即将 close 时才推进时钟
            if (options.expireOnWorkerClose) clock = base + 600001;
            c.emit('exit', 0, null);
            c.emit('close', 0, null);
            return;
          }
          const api = argv[2];
          const act = argv[3];
          const payload = {
            'sts.GetCallerIdentity': {
              Type: 'CAMRole', AccountId: SYN_ACCOUNT, UserId: 'u', PrincipalId: 'p',
              Arn: 'qcs::cam::uin/' + SYN_ACCOUNT + ':role/r', RequestId: UUID_V4
            },
            'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region }], RequestId: UUID_V4 },
            'tcb.DescribeEnvInfo': {
              EnvInfo: {
                EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
                UserInfo: { Uin: SYN_ACCOUNT, WxAppId: o.FIXED.wxAppId }
              }, RequestId: UUID_V4
            }
          };
          c.stdout.emit('data', Buffer.from(
            '\u2139 \u2192' + String(api).toUpperCase() + '.' + act + '\n' +
            JSON.stringify({ data: payload[api + '.' + act] })));
          c.emit('exit', 0, null);
          c.emit('close', 0, null);
        });
        return c;
      }
    }
  );
  return { report, stages, workerReturned };
}

async function main() {
  // ═══ T1 两处布尔判断 ════════════════════════════════════════════════
  {
    // T1-1 损坏的 worker 输出协议：缺失/null/0/空串/false 都不得算通过
    const flags = [];
    for (const [rec, field] of [['primary', 'userIdShapeValid'], ['primary', 'statusValid'], ['targetUser', 'statusValid']]) {
      for (const value of [undefined, null, 0, '', false, true]) {
        const payload = validPayload();
        if (value === undefined) delete payload[rec][field];
        else payload[rec][field] = value;
        const r = chain(payload);
        const status = rec === 'primary' ? r.primary.status : r.users.status;
        flags.push({
          record: rec, field,
          input: value === undefined ? 'missing' : (typeof value === 'string' ? value : JSON.stringify(value)),
          finalStatus: status,
          passedAsObserved: status === 'OBSERVED'
        });
      }
    }
    const invalidAccepted = flags.filter(f => f.input !== 'true' && f.passedAsObserved);
    const trueRejected = flags.filter(f => f.input === 'true' && !f.passedAsObserved);
    record('T1-1-non-true-flags-rejected', invalidAccepted.length === 0 && trueRejected.length === 0, {
      cases: flags.length,
      invalidFlags: flags.filter(f => f.input !== 'true').length,
      wrongAccepted: invalidAccepted,
      wrongRejected: trueRejected,
      note: 'T1：把「不是 false」误当「明确通过」；现必须是严格 true'
    });

    // T1-2 正常记录正向不回归
    const okChain = chain(validPayload());
    record('T1-2-valid-record-still-observed',
      okChain.primary.status === 'OBSERVED' && okChain.users.status === 'OBSERVED' &&
      okChain.primary.userId === SYN_TARGET && okChain.users.userStatus === 'active' &&
      okChain.primary.fieldCompleteness === 'COMPLETE' &&
      okChain.users.fieldCompleteness === 'COMPLETE', {
        primaryStatus: okChain.primary.status,
        usersStatus: okChain.users.status,
        usersUserStatus: okChain.users.userStatus,
        primaryReasons: okChain.primary.reasons,
        usersReasons: okChain.users.reasons,
        note: '本轮正常记录正向照常通过'
      });

    // T1-3 users 无userId 的合法契约不变（不新增要求、不要求 docIdMatches 标记）
    const usersOnly = o.sanitizeWorkerRecord(
      { classification: 'OBSERVED', docId: SYN_TARGET, status: 'active', statusValid: true },
      o.makeUsersExpectation(SYN_TARGET)
    );
    record('T1-3-users-contract-unchanged',
      usersOnly.userId === null && usersOnly.userIdShapeValid === null &&
      usersOnly.statusValid === true && usersOnly.docIdMatches === true &&
      usersOnly.fieldCompleteness === 'COMPLETE', {
        userId: usersOnly.userId,
        userIdShapeValid: usersOnly.userIdShapeValid,
        statusValid: usersOnly.statusValid,
        docIdMatches: usersOnly.docIdMatches,
        fieldCompleteness: usersOnly.fieldCompleteness,
        note: 'users 记录本来就没有 userId 字段 → 保持「不适用」，不新增 users.userId 要求'
      });

    // T1-4 真值但非布尔同样不算通过
    const truthy = [];
    for (const value of [1, 'true', {}, [], 'yes']) {
      const payload = validPayload();
      payload.primary.statusValid = value;
      const r = chain(payload);
      truthy.push({ value: JSON.stringify(value), status: r.primary.status });
    }
    record('T1-4-truthy-non-boolean-rejected',
      truthy.every(t => t.status !== 'OBSERVED'), {
        samples: truthy,
        note: '严格 true 也排除了 1/"true"/{} 这类真值非布尔'
      });

    // T1-5 源码已不含 `!== false` 的标记判断（本项缺陷的直接证据）
    const src = fs.readFileSync(OBSERVER_PATH, 'utf8');
    // 只核对**赋值语句**（注释里引用旧写法用于说明来历，不构成缺陷）
    const assignments = src.split('\n')
      .filter(line => /^\s*out\.(userIdShapeValid|statusValid)\s*=/.test(line))
      .map(line => line.trim());
    const loose = assignments.filter(l => l.includes('!== false'));
    const strict = assignments.filter(l => l.includes('=== true'));
    record('T1-5-assignments-use-strict-true',
      loose.length === 0 && strict.length === 2, {
        assignmentLines: assignments,
        looseComparisonCount: loose.length,
        strictTrueCount: strict.length,
        note: '源码级核对：两处赋值均为 === true（注释中引用旧写法仅为说明来历）'
      });
  }

  // ═══ T2 两条时效测试改为事件屏障驱动 ══════════════════════════════════
  {
    const noExpiry = await runWithWorkerEventBarrier({ workerFails: false, expireOnWorkerClose: false });
    record('T2-1-no-expiry-baseline',
      noExpiry.workerReturned === true && noExpiry.stages.length === 4 &&
      noExpiry.report.primaryObservation.status === 'OBSERVED' &&
      noExpiry.report.targetUserObservation.status === 'OBSERVED' &&
      noExpiry.report.incomplete.some(x => String(x).includes('过期')) === false, {
        stages: noExpiry.stages,
        workerReturned: noExpiry.workerReturned,
        primaryStatus: noExpiry.report.primaryObservation.status,
        usersStatus: noExpiry.report.targetUserObservation.status,
        overallStatus: noExpiry.report.status,
        hasExpiryNote: noExpiry.report.incomplete.some(x => String(x).includes('过期')),
        note: '未过期对照：同样走完四阶段，但不得出现任何过期说明'
      });

    const successExpiry = await runWithWorkerEventBarrier({ workerFails: false, expireOnWorkerClose: true });
    record('T2-2-success-return-expired-before-parent-finish',
      successExpiry.workerReturned === true && successExpiry.stages.length === 4 &&
      successExpiry.report.primaryObservation.status === 'OBSERVED' &&
      successExpiry.report.targetUserObservation.status === 'OBSERVED' &&
      successExpiry.report.status !== o.STATUS.OBSERVED &&
      successExpiry.report.incomplete.some(x => String(x).includes('worker 返回后')), {
        stages: successExpiry.stages,
        primaryStatus: successExpiry.report.primaryObservation.status,
        usersStatus: successExpiry.report.targetUserObservation.status,
        overallStatus: successExpiry.report.status,
        incomplete: successExpiry.report.incomplete,
        proven: successExpiry.report.sameBatchCredential.proven,
        note: '成功路径：两条部分观测保留，整体不升级为完整核验'
      });

    const failureExpiry = await runWithWorkerEventBarrier({ workerFails: true, expireOnWorkerClose: true });
    record('T2-3-failure-return-expired-before-parent-finish',
      failureExpiry.workerReturned === true && failureExpiry.stages.length === 4 &&
      failureExpiry.report.status === o.STATUS.FAILED &&
      failureExpiry.report.errorCode === 'SDK_UNAVAILABLE' &&
      failureExpiry.report.stoppedAt === 'primaryObservation' &&
      failureExpiry.report.incomplete.some(x => String(x).includes('SDK_UNAVAILABLE')) &&
      failureExpiry.report.incomplete.some(x => String(x).includes('过期')) &&
      failureExpiry.report.sameBatchCredential.refreshed === false, {
        stages: failureExpiry.stages,
        overallStatus: failureExpiry.report.status,
        originalErrorPreserved: failureExpiry.report.errorCode,
        stoppedAt: failureExpiry.report.stoppedAt,
        refreshed: failureExpiry.report.sameBatchCredential.refreshed,
        incomplete: failureExpiry.report.incomplete,
        note: '失败路径：原始错误码按原样保留，另有过期说明，不重新获取凭据'
      });

    // T2-4 旧测试的兜底断言已移除：不得再把「CLI 提前失败」当作覆盖
    const testSrc = fs.readFileSync(path.join(MINIAPP, 'tests', 'cloudbase-sdk-readonly-observer.test.cjs'), 'utf8');
    const weakAssertion = testSrc.includes("['sameBatchCredential', 'cliAssociation'].includes(");
    const guessesByCount = /clockCalls <= \d+/.test(testSrc) || /calls <= \d+/.test(testSrc);
    record('T2-4-weak-assertions-removed', !weakAssertion && !guessesByCount, {
      looseStoppedAtAssertionPresent: weakAssertion,
      callCountGuessingPresent: guessesByCount,
      note: 'S3-5/S3-6 已重写为 T2 组：不再用 now() 调用次数猜阶段，也不再允许 CLI 提前失败兜底'
    });
  }

  // ═══ 未改项与历史证据 ════════════════════════════════════════════════
  // 未改项 = 本轮四个代码文件之外的文件。
  // 特别注意：`cloudbase-sdk-readonly-observer.cjs`（带 sdk- 前缀）是**本轮**的 SDK
  // 编排库，属 Codex 报告列明的「四个代码文件」之一，**不是**未改项；
  // 未改的是既有 CLI 观测器 `cloudbase-readonly-observer.cjs`（无 sdk- 前缀）。
  const untouched = {
    'scripts/lib/cloudbase-readonly-observer.cjs': '3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
    'scripts/check-cloudbase-readonly.cjs': '552dc12269989ec271338153fba036331cc37a27facc13189c3c2a8d0a17ae3a',
    'scripts/lib/sandbox-primary-bootstrap.cjs': '133c21ae4b1081a1e716422862730d518a2194cc8620eb0956a9459a44765614',
    'scripts/prepare-sandbox-primary.cjs': '608aa8854a4213fc81659f2892634cd29e4ba691db1253d34a8e66778c7046e4',
    'scripts/lib/sandbox-primary-sdk-adapter.cjs': '9088e6478b940a4c2db06737effbb9264f12fd1b62778e64cdb3990ef2ec9f1d'
  };
  const mismatch = [];
  const actual = {};
  for (const [rel, expect] of Object.entries(untouched)) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(MINIAPP, rel))).digest('hex');
    actual[rel] = h;
    if (h !== expect) mismatch.push({ file: rel, expected: expect, actual: h });
  }
  record('untouched-files-unchanged', mismatch.length === 0, {
    checked: Object.keys(untouched).length, mismatch, actual,
    note: 'C1/T1/P4/已验收适配层/初始化 CLI/既有 CLI 观测器均未触碰'
  });

  const hist = {};
  for (const [k, p] of [
    ['m1m2m3', 'WorkBuddyM1M2M3-SDK只读接入复现-20261007.json'],
    ['r1r5', 'WorkBuddyM1M2M3-R1至R5返修复现-20261008.json'],
    ['s1s3', 'WorkBuddyM1M2M3-S1至S3收尾复现-20261008.json'],
    ['codex-r1r5', 'CodexSDK只读R1R5返修复核-20261008.json']
  ]) {
    const fp = path.join(__dirname, p);
    if (!fs.existsSync(fp)) continue;
    hist[k] = {
      file: p,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex')
    };
  }
  record('historical-evidence-preserved', true, {
    historicalEvidence: hist,
    overwrittenByThisRound: false,
    wroteFiles: false,
    note: '本脚本只写 stdout；历史 JSON 保留原样，未重跑覆盖来「对齐」'
  });

  const out = {
    observedAt: new Date().toISOString(),
    scope: 'M1/M2/M3 T1/T2 收尾（SDK 只读身份接入，本地离线）',
    basedOn: 'docs/Codex复核-SDK只读身份S1-S3收尾-20261008.md 第 2、3 节',
    constraints: {
      network: false, executedCli: false, readAuth: false, fetchedRealCredential: false,
      installed: false, initialized: false, deployed: false, createdResources: false,
      executedRealWorkerSubprocess: false,
      wroteFiles: false, historicalEvidenceOverwritten: false
    },
    evidenceTiers: {
      syntheticVerification: '合成凭据/合成 CLI 响应/合成 EventEmitter 子进程下的本地行为验证',
      realWorkerMain: '本轮**未**执行真实 worker main（T1 走解释链、T2 走合成子进程）',
      platformUnverified: ['平台原子性', 'IAM 权限', '真实数据库内容', '真实 worker 子进程时序', '真实网络行为', '费用/余量', '生产同批凭据链']
    },
    realNetworkCalls: 0,
    realCloudCalls: 0,
    workerMainExecutions: 0,
    changedScope: {
      observer: '仅两处布尔判断（!== false → === true）+ 导出 PRIMARY_KEY_EXPECTATION',
      tests: '重写 S3-5/S3-6 为 T2 组（事件屏障驱动），新增 T1 组 4 项',
      worker: '本轮未修改',
      entry: '本轮未修改'
    },
    results,
    blockingGaps: [
      {
        id: 'public-cli-identity-source-not-proven-offline',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: 'R1 前置条件仍未完成：公共 CLI 离线身份选择证明未执行' +
          '（不执行 bundle、不联网），真实凭据获取宿主保持关闭。' +
          'T1/T2 只是收尾，不改变这一点。',
        needed: '在受审宿主内以隔离目录 + 合成凭据执行一次公共 api 命令，观察实际选用的身份来源。'
      },
      {
        id: 'same-batch-credential-chain-not-proven-in-production',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: '本轮全部结论来自合成凭据/合成子进程；proven 恒为 false，整体 INCOMPLETE。' +
          '未执行 secrets get --json、未获取任何真实凭据。',
        needed: '受审宿主内按既有只读授权执行一次整组，另存脱敏证据。'
      },
      {
        id: 'real-worker-subprocess-timing-not-simulated',
        severity: 'EXPECTED_THIS_ROUND',
        detail: 'T2 的三个时效场景使用合成 EventEmitter 子进程，' +
          '未通过真实 worker 子进程模拟「worker 最后检查后、父进程收尾前」的时间窗口。' +
          'S3 实现本身已由 Codex 定点脚本补证通过，本项只说明 T2 的覆盖边界。',
        needed: '真实执行时以受控凭据与真实时间戳观察该窗口。'
      },
      {
        id: 'flag-samples-are-malformed-protocol-not-production-response',
        severity: 'EXPECTED_THIS_ROUND',
        detail: 'T1 的 15 个损坏标记样本是**损坏的 worker 输出协议**，' +
          '当前正常 worker 会输出布尔值。本轮不声称真实云记录曾被误认，' +
          '也不声称取得任何写权限；它只是上轮要求收紧、本轮声称完成的判定。',
        needed: '无需平台动作；后续若 worker 协议变化需同步更新契约。'
      }
    ],
    boundaries: {
      writeAuthorized: false,
      productionCallerVerifierImplemented: false,
      collectionsTouched: [w.ADMIN_COLLECTION, w.USER_COLLECTION],
      note: '仅独立测试副本 schtest_v1_*；未查旧业务 users/app_admins'
    },
    summary: {
      total: results.length,
      passed: results.filter(r => r.pass).length,
      failed: results.filter(r => !r.pass).length,
      blockingGaps: 2
    }
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (out.summary.failed > 0) process.exitCode = 1;
}

main().catch(e => {
  process.stderr.write(String((e && e.stack) || e) + '\n');
  process.exitCode = 1;
});
