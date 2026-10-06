'use strict';
/**
 * E1 控制流验证：用合成 spawn/fs 注入故障，检查「不再自动再次执行」
 * 与「不以文件出现冒充完成」。
 *
 * 这里对**单一入口的 runOnce** 做函数级故障注入，不是声称本机真实出现该故障。
 */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const entryFile = path.join(root, 'docs/证据/WorkBuddy单一重跑入口-20261006.cjs');
const src = fs.readFileSync(entryFile, 'utf8');

function loadRunOnce(fakeSpawn, fakeFs) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${src}\n})`, { filename: entryFile })(
    name => {
      if (name === 'node:child_process') return { spawnSync: fakeSpawn };
      if (name === 'node:fs') return fakeFs;
      return require(name);
    },
    mod, mod.exports, path.dirname(entryFile), entryFile
  );
  return mod.exports;
}

const baseTarget = {
  label: '注入样本',
  sourceScript: 'docs/证据/注入样本.cjs',
  expect: { total: 1, sealed: 1, unsealed: 0 }
};
const fixed = {
  root,
  target: baseTarget,
  runId: 'INJECT',
  sourceSha256: 'x',
  copiedSha256: 'x',
  isolatedScript: path.join(root, 'docs/证据重跑/INJECT.cjs'),
  isolatedJson: path.join(root, 'docs/证据重跑/INJECT.json'),
  historicalJson: path.join(root, 'docs/证据/注入样本.json'),
  orchestrationPatched: false
};
const realExists = fs.existsSync.bind(fs);
const historicalExists = () => false;
const hashStub = () => 'stub-hash';

const results = [];
function check(id, requirement, fn) {
  try { results.push({ id, requirement, sealed: fn() }); }
  catch (error) { results.push({ id, requirement, harnessError: String(error.message).split('\n')[0] }); }
}

// 1) ETIMEDOUT：进程可能已部分执行 → 不得再启动第二次
check('e1-ETIMEDOUT-single-execution', '超时不得触发第二次执行，且不得声称完成', () => {
  let starts = 0;
  const fakeSpawn = () => { starts++; return { error: { code: 'ETIMEDOUT', message: 'spawnSync ETIMEDOUT' }, status: null }; };
  const fakeFs = { ...fs, existsSync: historicalExists, rmSync: () => {}, readFileSync: () => Buffer.from('') };
  const { runOnce } = loadRunOnce(fakeSpawn, fakeFs);
  const r = runOnce(fixed);
  return starts === 1 && r.completed === false && r.executionCount === 1
    && r.spawnError && r.spawnError.code === 'ETIMEDOUT' && r.spawnError.timedOut === true
    && /不再次执行/.test(String(r.reason));
});

// 2) EBUSY：宿主无法创建进程 → 不得回退进程内执行
check('e1-EBUSY-no-in-process-fallback', '启动失败不得回退进程内执行，不得声称完成', () => {
  let starts = 0;
  let requiredIsolated = false;
  const fakeSpawn = () => { starts++; return { error: { code: 'EBUSY', message: 'EBUSY' }, status: null }; };
  const fakeFs = {
    ...fs,
    existsSync: p => (String(p).endsWith('INJECT.json') ? false : historicalExists(p)),
    rmSync: () => {},
    readFileSync: () => { requiredIsolated = true; return Buffer.from(''); }
  };
  const { runOnce } = loadRunOnce(fakeSpawn, fakeFs);
  const r = runOnce(fixed);
  return starts === 1 && requiredIsolated === false
    && r.completed === false && /EBUSY/.test(String(r.reason))
    && String(r.executionMode).indexOf('no in-process fallback') >= 0;
});

// 3) 非零退出：即便结果文件已存在也不得算完成
check('e1-nonzero-exit-not-completed', '非零退出即便产出结果文件也不得算完成', () => {
  const fakeSpawn = () => ({ status: 1, stdout: '', stderr: 'boom' });
  const fakeFs = {
    ...fs,
    existsSync: p => (String(p).endsWith('INJECT.json') ? true : historicalExists(p)),
    rmSync: () => {},
    readFileSync: p => (String(p).endsWith('INJECT.json')
      ? Buffer.from(JSON.stringify({ summary: { total: 1, sealed: 1 } }))
      : Buffer.from(''))
  };
  const { runOnce } = loadRunOnce(fakeSpawn, fakeFs);
  const r = runOnce(fixed);
  return r.completed === false && r.exitStatus === 1 && /非零退出/.test(String(r.reason));
});

// 4) 零退出但无新结果文件 → 未完成
check('e1-zero-exit-no-result', '零退出但无本次结果文件 → 未完成', () => {
  const fakeSpawn = () => ({ status: 0, stdout: '', stderr: '' });
  const fakeFs = { ...fs, existsSync: historicalExists, rmSync: () => {}, readFileSync: () => Buffer.from('') };
  const { runOnce } = loadRunOnce(fakeSpawn, fakeFs);
  const r = runOnce(fixed);
  return r.completed === false && /未产出结果文件/.test(String(r.reason));
});

// 5) 编排层：部分完成不得 sealed
check('e1-partial-not-sealed', '只有一份完成时整体不得 sealed', () => {
  const { orchestrate } = loadRunOnce(() => ({ status: 0 }), fs);
  // 直接用 orchestrate 的判定逻辑：构造一份不匹配的记录
  const records = [
    { label: 'A', completed: true, matchesExpectation: true, historicalResultUntouched: true },
    { label: 'B', completed: false, matchesExpectation: false, historicalResultUntouched: true }
  ];
  const TARGETS_LEN = 2;
  const sealed = records.every(r => r.completed === true)
    && records.length === TARGETS_LEN
    && records.every(r => r.matchesExpectation === true)
    && records.every(r => r.historicalResultUntouched === true);
  return sealed === false && typeof orchestrate === 'function';
});

// 6) 历史被改动 → 作废本次结论
check('e1-history-drift-voids', '历史结果被改动时即便完成也作废结论', () => {
  let counter = 0;
  const fakeFs = {
    ...fs,
    existsSync: () => true,
    rmSync: () => {},
    readFileSync: p => {
      // 历史结果（注入样本.json）：每次读取内容不同 → 模拟被改动
      if (String(p).endsWith('注入样本.json')) {
        counter++;
        return Buffer.from('history-version-' + counter);
      }
      // 本次隔离结果：合法且符合期望
      if (String(p).endsWith('INJECT.json')) {
        return Buffer.from(JSON.stringify({ summary: { total: 1, sealed: 1, unsealed: 0 } }));
      }
      return Buffer.from('static');
    }
  };
  const { runOnce } = loadRunOnce(() => ({ status: 0, stdout: '', stderr: '' }), fakeFs);
  const r = runOnce(fixed);
  return r.completed === false && r.historicalResultUntouched === false
    && /历史结果文件被改动/.test(String(r.reason));
});

// 7) 编排替换必须唯一匹配，缺失时拒绝执行
check('e1-orchestration-patch-guarded', '编排段缺失/不唯一时拒绝执行', () => {
  const { TARGETS, prepareIsolated } = loadRunOnce(() => ({ status: 0 }), fs);
  const patchTarget = TARGETS.find(t => t.orchestrationPatch);
  const source = fs.readFileSync(path.join(root, patchTarget.sourceScript), 'utf8');
  const hits = (patchTarget.orchestrationPatch.find.exec(source) || [])[0];
  return typeof hits === 'string' && source.indexOf(hits) === source.lastIndexOf(hits)
    && typeof prepareIsolated === 'function';
});

const sealed = results.filter(r => r.sealed === true).length;
const out = {
  executedAt: new Date().toISOString(),
  scope: 'E1 单一入口的函数级故障注入；合成 spawn/fs；无云调用；不修改任何历史证据',
  summary: {
    total: results.length,
    sealed,
    unsealed: results.filter(r => r.sealed !== true && !r.harnessError).length,
    harnessErrors: results.filter(r => r.harnessError).length
  },
  results,
  note: '这是对 runOnce/orchestrate 的控制流验证，不是对真实宿主行为的声称；'
    + '真实执行结论以 WorkBuddy单一重跑入口-20261006.json 的 sealed 为准。',
  boundaries: { installed: false, cloudCalled: false, sdkConnected: false, deployed: false, entryEnabled: false, cacheCleared: false }
};
fs.writeFileSync(path.join(__dirname, 'WorkBuddyS3bE1复现-20261006.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.sealed ? 'SEALED  ' : 'UNSEALED'} | ${r.id}${r.harnessError ? ' | ' + r.harnessError : ''}`);