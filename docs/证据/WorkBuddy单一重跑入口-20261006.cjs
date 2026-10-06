'use strict';
/**
 * 单一重跑入口（E1 返修）—— 统一编排 34 条与 18 条断言各**一次**。
 *
 * 与上一版入口的差异（按 Codex 复核第 3 节逐条落实）：
 *  1. **不做进程内自动回退**。子进程启动失败 / 超时 / 非零退出 / 无新结果，
 *     一律记「本次未完成」并保留实际错误码；不再 require 隔离副本二次执行。
 *  2. **不轮询文件来声称 await 完成**。只有子进程 status===0 且本次产出新的
 *     结果文件，才算「本次实际完成」；文件是否出现不作为完成判据。
 *  3. **禁止嵌套重复**。18 条脚本内部会再执行 34 条；本入口对**运行副本**
 *     的编排段做**明确、可核对**的替换，把嵌套调用替换为「已由本入口执行」的
 *     记录，并同时记录替换前后的 SHA-256 —— 不声称副本与源逐字节相同。
 *  4. **每次运行独立输出路径**（含运行标识），不覆盖上一轮交付物。
 *  5. **完整通过要求两份本次结果都已完成且符合各自期望**；
 *     `some(reran)` 这类「至少一份完成」的判定不再使用。
 *
 * 边界：只读历史证据文件；不修改任何历史 .cjs / .json；无云调用。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// 隔离副本必须**正好在根下两层**：两个历史脚本都用 path.resolve(__dirname, '../..') 推导根。
const ISOLATED_PARENT = 'docs/证据重跑';

const TARGETS = Object.freeze([
  {
    label: '前轮34条',
    sourceScript: 'docs/证据/WorkBuddy返修R1R5复现-20261005.cjs',
    expect: { total: 34, sealed: 34, unsealed: 0 },
    // 运行副本无需改编排
    orchestrationPatch: null
  },
  {
    label: '上轮18条',
    sourceScript: 'docs/证据/WorkBuddy返修S1S5复现-20261006.cjs',
    expect: { total: 18, sealed: 18, unsealed: 0 },
    // 18 条脚本第 798 行内部会再执行 34 条 → 本入口把它替换为「已由本入口执行」，
    // 避免整条链路上出现两次 34 条执行。替换是**可核对的编排调整**，
    // 断言部分逐字保留；此处如实记录替换前后哈希，不声称与源逐字节相同。
    orchestrationPatch: {
      reason: '禁止嵌套重复执行 34 条（该脚本内部会再调用 safeRerun）',
      find: /const previousRerun = await safeRerun\(\{[\s\S]*?\}\);/,
      replace: [
        'const previousRerun = {',
        "  label: 'previous-R1R5-34',",
        '  reran: false,',
        '  awaited: false,',
        "  reason: '嵌套重跑已由单一入口 WorkBuddy单一重跑入口-20261006.cjs 统一执行并禁止重复；本副本不再自行重跑。'",
        '};'
      ].join('\n')
    }
  }
]);

const TIMEOUT_MS = 300000;

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** 生成运行标识：同一分钟内重复运行也不会互相覆盖。 */
function makeRunId(now) {
  const d = now || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${process.pid}`;
}

/**
 * 执行**一次**隔离副本，返回本次实际完成的判定。
 *
 * 完成判据（全部满足才算 completed）：
 *  - spawnSync 没有 error（包括 ETIMEDOUT / EBUSY / EPERM）；
 *  - status === 0；
 *  - 本次的输出路径存在（上一轮同标号产物已在执行前删除，故只可能是本次产出）。
 *
 * 任何不满足 → completed=false，并保留实际错误，**不再尝试第二次执行**。
 */
function runOnce(options) {
  const {
    root, target, runId, sourceSha256, copiedSha256, isolatedScript, isolatedJson,
    historicalJson, orchestrationPatched
  } = options;

  const record = {
    label: target.label,
    sourceScript: target.sourceScript,
    historicalResult: target.sourceScript.replace(/\.cjs$/, '.json'),
    runId,
    isolatedScript: path.relative(root, isolatedScript).split(path.sep).join('/'),
    isolatedResult: path.relative(root, isolatedJson).split(path.sep).join('/'),
    sourceSha256,
    copiedSha256,
    orchestrationPatched: orchestrationPatched || false,
    executionCount: 1,
    executionMode: 'subprocess-only (no in-process fallback)',
    completed: false,
    summary: null,
    matchesExpectation: false,
    expectedSummary: target.expect,
    spawnError: null,
    exitStatus: null,
    reason: null,
    historicalResultSha256Before: fs.existsSync(historicalJson) ? sha256File(historicalJson) : null
  };

  if (isolatedJson === historicalJson) {
    record.reason = '隔离输出与历史结果同路径，已拒绝执行。';
    return record;
  }

  // 删除上一轮同标号产物，确保「文件存在」只能是本次产出
  if (fs.existsSync(isolatedJson)) fs.rmSync(isolatedJson);

  // 只启动一次。run.error 不代表进程从未启动，因此这里**不再执行第二遍**。
  const run = spawnSync(process.execPath, [isolatedScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: TIMEOUT_MS
  });

  if (run.error) {
    // 启动失败或超时：可能已执行了一部分，如实记未完成，不重跑、不轮询
    record.spawnError = {
      code: String(run.error.code || ''),
      message: String(run.error.message || '').split('\n')[0],
      timedOut: run.error.code === 'ETIMEDOUT'
    };
    record.exitStatus = run.status === undefined ? null : run.status;
    record.reason = `子进程未正常完成（${record.spawnError.code || 'SPAWN_ERROR'}）：本次未完成，不再次执行。`;
  } else {
    record.exitStatus = run.status;
    if (run.status !== 0) {
      record.reason = `子进程非零退出（status=${run.status}）：本次未完成。`;
      const stderrText = String(run.stderr || '').trim().split('\n').slice(-3).join(' | ');
      if (stderrText) record.stderrTail = stderrText;
    }
  }

  // 只有「未报错 + 零退出」才允许把结果文件当作本次产出
  if (!record.reason) {
    if (!fs.existsSync(isolatedJson)) {
      record.reason = '子进程零退出但未产出结果文件：本次未完成。';
    } else {
      let doc = null;
      try {
        doc = JSON.parse(fs.readFileSync(isolatedJson, 'utf8'));
      } catch (error) {
        record.reason = `结果文件不可解析（${String(error.message).split('\n')[0]}）：本次未完成。`;
      }
      if (doc) {
        record.completed = true;
        record.summary = doc.summary || null;
        record.producedExecutedAt = doc.executedAt || null;
        record.producedSha256 = sha256File(isolatedJson);
        const s = record.summary || {};
        record.matchesExpectation = s.total === target.expect.total
          && s.sealed === target.expect.sealed
          && (s.unsealed === undefined || s.unsealed === target.expect.unsealed);
        if (!record.matchesExpectation) {
          record.completed = false;
          record.reason = `本次结果不符合期望（期望 total=${target.expect.total} sealed=${target.expect.sealed}，实际 ${JSON.stringify(s)}）。`;
        }
      }
    }
  }

  const after = fs.existsSync(historicalJson) ? sha256File(historicalJson) : null;
  record.historicalResultSha256After = after;
  record.historicalResultUntouched = after === record.historicalResultSha256Before;
  if (!record.historicalResultUntouched) {
    record.completed = false;
    record.reason = '历史结果文件被改动，已作废本次结论。';
  }
  return record;
}

/** 准备隔离副本（可选编排调整），返回路径与哈希信息。 */
function prepareIsolated(root, target, runId) {
  const srcPath = path.join(root, target.sourceScript);
  const srcHash = sha256File(srcPath);
  const dirAbs = path.join(root, ISOLATED_PARENT);
  fs.mkdirSync(dirAbs, { recursive: true });

  const base = `${runId}__${path.basename(target.sourceScript)}`;
  const isolatedScript = path.join(dirAbs, base);
  const isolatedJson = isolatedScript.replace(/\.cjs$/, '.json');

  let source = fs.readFileSync(srcPath, 'utf8');
  let patched = false;
  let patchDetail = null;

  if (target.orchestrationPatch) {
    const { find, replace, reason } = target.orchestrationPatch;
    const m = find.exec(source);
    if (!m) {
      const err = new Error(`编排段未匹配，拒绝执行（${target.label}）：${reason}`);
      err.code = 'ORCHESTRATION_PATCH_TARGET_MISSING';
      throw err;
    }
    if (source.indexOf(m[0]) !== source.lastIndexOf(m[0])) {
      const err = new Error(`编排段匹配不唯一，拒绝执行（${target.label}）`);
      err.code = 'ORCHESTRATION_PATCH_AMBIGUOUS';
      throw err;
    }
    source = source.replace(find, replace);
    patched = true;
    patchDetail = { reason, matchedChars: m[0].length, removed: m[0], added: replace };
  }

  fs.writeFileSync(isolatedScript, source, 'utf8');
  const copiedHash = sha256File(isolatedScript);

  return {
    isolatedScript,
    isolatedJson,
    sourceSha256: srcHash,
    copiedSha256: copiedHash,
    orchestrationPatched: patched,
    patchDetail,
    byteIdenticalToSource: copiedHash === srcHash,
    historicalJson: srcPath.replace(/\.cjs$/, '.json')
  };
}

/** 编排：两份断言各执行一次。 */
function orchestrate(options) {
  const root = options.root;
  const runId = options.runId;
  const records = [];
  const preparations = [];

  for (const target of TARGETS) {
    let prep;
    try {
      prep = prepareIsolated(root, target, runId);
    } catch (error) {
      records.push({
        label: target.label,
        sourceScript: target.sourceScript,
        runId,
        completed: false,
        summary: null,
        matchesExpectation: false,
        expectedSummary: target.expect,
        executionCount: 0,
        reason: `准备隔离副本失败：${String(error.message).split('\n')[0]}`
      });
      continue;
    }
    preparations.push({
      label: target.label,
      sourceSha256: prep.sourceSha256,
      copiedSha256: prep.copiedSha256,
      byteIdenticalToSource: prep.byteIdenticalToSource,
      orchestrationPatched: prep.orchestrationPatched,
      patchDetail: prep.patchDetail
    });
    records.push(runOnce({
      root, target, runId,
      sourceSha256: prep.sourceSha256,
      copiedSha256: prep.copiedSha256,
      isolatedScript: prep.isolatedScript,
      isolatedJson: prep.isolatedJson,
      historicalJson: prep.historicalJson,
      orchestrationPatched: prep.orchestrationPatched
    }));
  }

  const completed = records.filter(r => r.completed === true);
  const incomplete = records.filter(r => r.completed !== true);
  // 完整通过：**每一份**都必须本次实际完成且符合期望；缺一即不通过
  const sealed = incomplete.length === 0
    && completed.length === TARGETS.length
    && records.every(r => r.matchesExpectation === true)
    && records.every(r => r.historicalResultUntouched === true);

  return { records, preparations, sealed, completedCount: completed.length, incompleteCount: incomplete.length };
}

function historySnapshot(root, files) {
  const out = {};
  for (const rel of files) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) out[rel] = sha256File(p);
  }
  return out;
}

const HISTORY_FILES = Object.freeze([
  'docs/证据/Codex驱动R1R5剩余复现-20261005.cjs',
  'docs/证据/Codex驱动R1R5剩余复现-20261005.json',
  'docs/证据/Codex驱动S1S5复核-20261006.cjs',
  'docs/证据/Codex驱动S1S5复核-20261006.json',
  'docs/证据/Codex驱动S3abE1复核-20261006.cjs',
  'docs/证据/Codex驱动S3abE1复核-20261006.json',
  'docs/证据/WorkBuddy返修R1R5复现-20261005.cjs',
  'docs/证据/WorkBuddy返修R1R5复现-20261005.json',
  'docs/证据/WorkBuddy返修S1S5复现-20261006.cjs',
  'docs/证据/WorkBuddy返修S1S5复现-20261006.json',
  'docs/证据/WorkBuddy安全重跑与S3ab复现-20261006.cjs',
  'docs/证据/WorkBuddy安全重跑与S3ab复现-20261006.json'
]);

/**
 * 历史证据修订说明（如实记录，不回避）。
 *
 * 上一轮**确实修改过** `docs/证据/WorkBuddy返修S1S5复现-20261006.cjs`
 * （36977 B / d26906f6… → 41117 B / 09f23d61…），因此「历轮全部历史证据未改」
 * 的表述不成立。本入口不再修改任何历史 .cjs / .json。
 */
const HISTORY_REVISION_NOTE = Object.freeze({
  topic: '历史证据修订',
  statement: '上一轮对 docs/证据/WorkBuddy返修S1S5复现-20261006.cjs 做过修改（把其中的嵌套重跑改为安全重跑），'
    + '因此「历轮全部历史证据未改」不成立。本轮不再修改任何历史 .cjs/.json，改为新增单一入口。',
  knownPriorStates: [
    { file: 'docs/证据/WorkBuddy返修S1S5复现-20261006.cjs', bytes: 36977, sha256Prefix: 'd26906f6', when: '上轮交付时' },
    { file: 'docs/证据/WorkBuddy返修S1S5复现-20261006.cjs', bytes: 41117, sha256Prefix: '09f23d61', when: '上一轮收尾修改后' }
  ],
  notClaimed: '不凭记忆伪造旧哈希，也不声称可逐字节还原旧版本。',
  policyFromNow: '历史证据文件只读；任何新的重跑/复现都写入本次独立路径。'
});

function main() {
  const root = path.resolve(__dirname, '../..');
  const runId = makeRunId();
  const historyBefore = historySnapshot(root, HISTORY_FILES);

  let orchestrated;
  let fatal = null;
  try {
    orchestrated = orchestrate({ root, runId });
  } catch (error) {
    fatal = String(error && error.message).split('\n')[0];
    orchestrated = { records: [], preparations: [], sealed: false, completedCount: 0, incompleteCount: 0 };
  }

  const historyAfter = historySnapshot(root, HISTORY_FILES);
  const historyDrift = Object.keys(historyBefore).filter(rel => historyBefore[rel] !== historyAfter[rel]);

  const output = {
    executedAt: new Date().toISOString(),
    scope: 'E1 单一重跑入口：34 条与 18 条各执行一次；仅本地，无云调用',
    runId,
    isolatedParent: ISOLATED_PARENT,
    entrySha256: sha256File(__filename),
    rules: {
      noInProcessFallback: true,
      noRerunAfterAnyFailure: true,
      noPollingAsCompletion: true,
      nestedRerunForbidden: true,
      independentOutputPathPerRun: true,
      sealedRequiresAllTargetsCompleted: true
    },
    targets: TARGETS.map(t => ({ label: t.label, sourceScript: t.sourceScript, expect: t.expect })),
    preparations: orchestrated.preparations,
    records: orchestrated.records,
    completedCount: orchestrated.completedCount,
    incompleteCount: orchestrated.incompleteCount,
    incompleteLabels: orchestrated.records.filter(r => r.completed !== true).map(r => r.label),
    sealed: orchestrated.sealed && historyDrift.length === 0 && !fatal,
    sealedReason: fatal
      ? `编排异常：${fatal}`
      : (historyDrift.length
        ? `历史证据被改动：${historyDrift.join(', ')}`
        : (orchestrated.sealed
          ? '两份断言均本次实际完成且符合期望，历史证据未改动。'
          : `未完整通过：未完成 ${orchestrated.incompleteCount} 份（${orchestrated.records.filter(r => r.completed !== true).map(r => r.label).join(', ') || '—'}）。`)),
    fatal,
    historyRevisionNote: HISTORY_REVISION_NOTE,
    historyFileHashesBefore: historyBefore,
    historyFileHashesAfter: historyAfter,
    historyDrift,
    boundaries: {
      installed: false,
      cloudCalled: false,
      sdkConnected: false,
      resourcesCreated: false,
      deployed: false,
      entryEnabled: false,
      cacheCleared: false,
      historicalEvidenceModified: historyDrift.length > 0
    }
  };

  fs.writeFileSync(__filename.replace(/\.cjs$/, '.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`运行标识：${runId}`);
  for (const r of orchestrated.records) {
    console.log(`  ${r.label}：completed=${r.completed} 期望匹配=${r.matchesExpectation} 执行次数=${r.executionCount}`
      + ` summary=${JSON.stringify(r.summary)} ${r.reason ? '｜' + r.reason : ''}`);
  }
  console.log(`历史证据漂移：${historyDrift.length ? historyDrift.join(', ') : '无'}`);
  console.log(`E1 sealed=${output.sealed}｜${output.sealedReason}`);
  process.exitCode = output.sealed ? 0 : 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  TARGETS,
  TIMEOUT_MS,
  ISOLATED_PARENT,
  HISTORY_FILES,
  HISTORY_REVISION_NOTE,
  makeRunId,
  sha256File,
  prepareIsolated,
  runOnce,
  orchestrate,
  historySnapshot,
  main
};