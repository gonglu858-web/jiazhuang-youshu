'use strict';
/**
 * CloudBase CLI 身份与环境只读观测 —— 离线测试（L3）
 *
 * 全部为**合成数据 + 合成子进程**：
 *   - 绝大多数用例由测试**拦截 `spawn`**，不因本机已安装真实 CLI 就联网；
 *   - 不运行任何云调用、不读取认证文件、不取凭据；不执行 `--read-only`；
 *   - 合成值**不代表任何真实账号、真实主体或真实环境凭据**。
 *
 * 唯一的例外是 L1-3：它用 `execFileSync` 真实运行**命令行入口的 4 个参数拒绝组合**
 * （未通过测试注入）。这些组合都在参数解析阶段停止，**未调用任何云 API**；
 * 因此不能表述为「所有子进程均被拦截」。
 *
 * 因此本文件通过**不等于**官方 CLI 登录、IAM、平台事务、费用或部署已验证。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const observer = require('../scripts/lib/cloudbase-readonly-observer.cjs');
const {
  FIXED, STAGES, STATUS, ERR, LIMITS, ObserverError,
  parseObserverArgs, buildChildEnv, buildStageArgs, parseCliJson, stripAnsi,
  assertSts, assertDescribeEnvs, assertDescribeEnvInfo, digestOf, normalizeEnvUin,
  spawnBounded, runLocalCheck, runReadOnlyObservation
} = observer;

// ── 合成身份数据（夹具，不代表任何真实账号/主体） ────────────────────
const SYN_ACCOUNT = '100012345678';
const SYN_UIN = '100012345678';          // 与 SYN_ACCOUNT 同值 → 摘要必须相等
const SYN_OTHER_ACCOUNT = '100099999999';
const SYN_OPENID = 'oSYNTHETIC-openid-must-never-appear-20261007';
const SYN_SECRET = 'SYNTHETIC_SECRET_TOKEN_a1b2c3';
const SYN_REQUEST_STS = 'req-sts-synthetic';
const SYN_REQUEST_ENVS = 'req-envs-synthetic';
const SYN_REQUEST_INFO = 'req-envinfo-synthetic';

/** 成功回执：CLI 的 --json 输出是 `{data: <result>}`（源码 outputJson）。 */
function stsOk(overrides) {
  return { data: Object.assign({
    Type: 'CAMRole',
    AccountId: SYN_ACCOUNT,
    UserId: 'sub-synthetic-user',
    PrincipalId: 'principal-synthetic-5386',
    Arn: 'qcs::cam::uin/100012345678:role/synthetic#sub-synthetic',
    RequestId: SYN_REQUEST_STS
  }, overrides || {}) };
}
function envsOk(overrides) {
  return { data: Object.assign({
    EnvList: [{ EnvId: FIXED.envId, Status: 'NORMAL', Region: FIXED.region, Source: 'miniapp' }],
    RequestId: SYN_REQUEST_ENVS
  }, overrides || {}) };
}
function envInfoOk(overrides, userOverrides) {
  return { data: Object.assign({
    EnvInfo: {
      EnvBaseInfo: { EnvId: FIXED.envId, Status: 'NORMAL', Region: FIXED.region },
      UserInfo: Object.assign({ Uin: SYN_UIN, WxAppId: FIXED.wxAppId }, userOverrides || {})
    },
    RequestId: SYN_REQUEST_INFO
  }, overrides || {}) };
}

/** ANSI 提示行（对齐源码：`${symbols.info} ${bold.cyan('→')} ${bold(SERVICE.ACTION)}`）。 */
function hintLine(service, action) {
  return `[1m[34mℹ[39m[22m [1m[36m→[39m[22m [1m${service.toUpperCase()}.${action}[22m`;
}

function stdoutFor(stage, payload) {
  return hintLine(stage.service, stage.action) + '\n' + JSON.stringify(payload, null, 2) + '\n';
}

/**
 * 合成 `spawn`：拦截全部子进程执行。
 *
 * scripts 可给：
 *   - `Error`（模拟启动错误）
 *   - `{stdout, status, signal, stderr}`（正常退出）
 *   - `{hang: true}`（不触发 close，用于超时分支）
 *   - `{chunked: true, ...}`（分块输出，用于输出上限分支）
 *
 * 返回值形状对齐 Node 的 ChildProcess 事件接口（本模块只用 stdout/stderr 的
 * `data` 事件与 `error`/`close` 事件）。
 */
function makeSpawn(script) {
  const calls = [];
  const fn = (bin, args, options) => {
    calls.push({ bin, args, options });
    const key = args[2] + ' ' + args[3];       // "<service> <Action>"
    const entry = script[key];
    const spec = entry === undefined ? { stdout: '', status: 0, stderr: '' } : entry;
    const listeners = {};
    const push = (event, ...args) => { (listeners[event] || []).forEach(fn2 => fn2(...args)); };
    const child = {
      stdout: { on: (event, cb) => { if (event === 'data') listeners.__out = cb; } },
      stderr: { on: (event, cb) => { if (event === 'data') listeners.__err = cb; } },
      killed: false,
      kill() { child.killed = true; },
      on(event, cb) {
        if (event === 'data') return;           // stdout/stderr 走上面的 on
        (listeners[event] = listeners[event] || []).push(cb);
        return child;
      }
    };
    setImmediate(() => {
      if (spec instanceof Error) {
        push('error', spec);
        return;
      }
      if (spec.hang) return;                      // 永不 close
      if (listeners.__out) {
        const out = String(spec.stdout === undefined ? '' : spec.stdout);
        if (spec.chunked) {
          // 分块喂入，最后一块超出 1 MiB 上限
          const size = 256 * 1024;
          for (let i = 0; i < Math.ceil((1024 * 1024 + 1024) / size); i++) {
            listeners.__out(Buffer.alloc(size, 0x78));
          }
        } else if (out) {
          listeners.__out(Buffer.from(out, 'utf8'));
        }
      }
      if (listeners.__err && spec.stderr) listeners.__err(Buffer.from(String(spec.stderr), 'utf8'));
      push('close', spec.signal ? null : (spec.status === undefined ? 0 : spec.status), spec.signal || null);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// ── 合成载体：让五项本地检查**真实执行**而不是被跳过 ──────────────────
// 仅测试可经 deps.fixed 注入合成路径/哈希；命令行没有这种开关。
const SYN_BUNDLE_CONTENT = 'SYNTHETIC_BUNDLE_CONTENT_v1';
// R1：合成入口与**真实已验收入口字节完全一致**（57 字节 shebang + 转发 require）
const SYN_ENTRY_CONTENT = FIXED.cliEntryExactBytes;
const SYN_NODE_BIN = 'C:/synthetic/node.exe';
const SYN_CLI_ENTRY = 'C:/synthetic/cli/bin/tcb';
const SYN_CLI_BUNDLE = 'C:/synthetic/cli/dist/standalone/cli.js';
const SYN_AUTH_DIR = 'C:/synthetic/auth-session';
const SYN_FIXED = Object.freeze({
  nodeBin: SYN_NODE_BIN,
  cliEntry: SYN_CLI_ENTRY,
  cliBundle: SYN_CLI_BUNDLE,
  cliBundleSha256: crypto.createHash('sha256').update(SYN_BUNDLE_CONTENT).digest('hex'),
  cliVersion: FIXED.cliVersion,
  authSessionDir: SYN_AUTH_DIR,
  cliEntrySha256: crypto.createHash('sha256').update(SYN_ENTRY_CONTENT).digest('hex'),
  cliEntryExactBytes: SYN_ENTRY_CONTENT
});

/**
 * 一份「全部本地检查真实通过」的 deps；spawn 由脚本控制。
 * `opts.files` **整体替换**默认合成文件集（用于制造缺失/篡改），
 * `opts.homedir` 覆盖子进程看到的主目录，`opts.fixedOverride` 覆盖固定值。
 */
function readyDeps(script, options) {
  const opts = options || {};
  const spawn = makeSpawn(script || {});
  const files = opts.files || {
    [SYN_NODE_BIN]: '#!/bin/sh\n',
    [SYN_CLI_ENTRY]: SYN_ENTRY_CONTENT,
    [SYN_CLI_BUNDLE]: SYN_BUNDLE_CONTENT,
    'package.json': JSON.stringify({ version: FIXED.cliVersion })
  };
  const fsStub = Object.assign(Object.create(fs), {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, String(p)),
    statSync: (p) => ({ isFile: () => Object.prototype.hasOwnProperty.call(files, String(p)) }),
    readFileSync: (p, enc) => {
      const key = String(p).endsWith('package.json') ? 'package.json' : String(p);
      if (!Object.prototype.hasOwnProperty.call(files, key)) throw new Error('ENOENT:' + key);
      const v = files[key];
      return enc ? String(v) : Buffer.from(String(v));
    }
  });
  // homedir 检查用的假进程：立即回一句再close
  const homedirChild = (value) => {
    const listeners = {};
    setImmediate(() => {
      if (listeners.out) listeners.out(Buffer.from(String(value), 'utf8'));
      (listeners.close || []).forEach(cb => cb(0, null));
    });
    return {
      stdout: { on: (e, cb) => { if (e === 'data') listeners.out = cb; } },
      stderr: { on: () => {} },
      killed: false,
      kill() { this.killed = true; },
      on(e, cb) { if (e !== 'data') (listeners[e] = listeners[e] || []).push(cb); }
    };
  };
  const spawnWrapper = (bin, args, options2) => {
    if (args.length === 2 && args[0] === '-e') {
      return homedirChild(opts.homedir || SYN_AUTH_DIR);
    }
    return spawn(bin, args, options2);
  };
  spawnWrapper.calls = spawn.calls;
  return {
    fs: fsStub,
    path,
    crypto,
    baseEnv: { PATH: 'x', USERPROFILE: 'C:/Users/someone-else' },
    fixed: opts.fixedOverride || SYN_FIXED,
    spawn: spawnWrapper
  };
}

// ── 1. 默认模式与参数边界（L1） ───────────────────────────────────────

test('L1-1 默认模式零 API：不启动任何云查询，只报本地就绪状态', async () => {
  const d = readyDeps({});
  const r = await runLocalCheck(d);
  assert.equal(r.mode, 'local-check');
  assert.equal(r.status, STATUS.LOCAL_READY, JSON.stringify(r.localChecks));
  assert.equal(r.cloudObservationPerformed, false);
  assert.equal(r.writeAuthorized, false);
  // 只有 homedir 那个 -e 子进程，没有任何 api 参数
  const apiCalls = d.spawn.calls.filter(c => c.args.includes('api'));
  assert.equal(apiCalls.length, 0, '默认模式不得启动任何云命令');
  assert.match(r.notes, /未启动任何云命令/);
});

test('L1-2 参数：仅接受无参数或单个 --read-only，未知/写入/位置参数全部拒绝', () => {
  assert.deepEqual(parseObserverArgs(['node', 'cli']).mode, 'local-check');
  assert.deepEqual(parseObserverArgs(['node', 'cli', '--read-only']).mode, 'read-only');
  for (const args of [
    ['node', 'cli', '--execute'],
    ['node', 'cli', '--approval'],
    ['node', 'cli', '--init'],
    ['node', 'cli', '--dry-run'],
    ['node', 'cli', 'extra'],
    ['node', 'cli', '--read-only', 'extra'],
    ['node', 'cli', '--read-only', '--read-only'],
    ['node', 'cli', '--service', 'sts'],
    ['node', 'cli', '--region', 'ap-beijing'],
    ['node', 'cli', '--env', 'other-env']
  ]) {
    assert.throws(() => parseObserverArgs(args), e => e instanceof ObserverError, args.join(' '));
  }
});

test('L1-3 未知参数在启动任何子进程前即被拒绝（入口级，真实运行入口）', () => {
  // 注意：本用例**真实运行命令行入口**（execFileSync，非 spawn 替身），
  // 但这 4 个组合都在参数解析阶段停止，**未调用任何云 API**。
  const { execFileSync } = require('node:child_process');
  const cli = path.join(__dirname, '../scripts/check-cloudbase-readonly.cjs');
  for (const extra of [['--execute'], ['--approval'], ['--unknown'], ['positional']]) {
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [cli, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      out = String(error.stdout || '');
      code = error.status;
    }
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, STATUS.FAILED, extra.join(' '));
    assert.equal(code, 1, extra.join(' '));
    assert.equal(parsed.cloudObservationPerformed, false, extra.join(' '));
    assert.equal(parsed.cloudQueryAttempted, false, extra.join(' '));
    assert.ok(parsed.errorCode === ERR.ARGS_INVALID || parsed.errorCode === ERR.ARGS_CONFLICT, extra.join(' '));
  }
});

// ── 2. 固定命令与环境（L1） ───────────────────────────────────────────

test('L2-1 三条命令参数固定：service/action/api-version/body/env/region/json', () => {
  assert.deepEqual(buildStageArgs(STAGES[0]), [
    'api', 'sts', 'GetCallerIdentity', '--api-version', '2018-08-13',
    '-r', 'ap-shanghai', '--json'
  ]);
  for (const key of ['describeEnvs', 'describeEnvInfo']) {
    const stage = STAGES.find(s => s.key === key);
    assert.deepEqual(buildStageArgs(stage), [
      'api', 'tcb', stage.action, '--api-version', '2018-06-08',
      '--body', '{"EnvId":"cloud1-d8gcq5ag39d847723"}',
      '-e', 'cloud1-d8gcq5ag39d847723', '-r', 'ap-shanghai', '--json'
    ], key);
  }
  // STS 不得带环境选择参数
  assert.equal(STAGES[0].envArgs.length, 0);
});

test('L2-2 子进程约束：shell:false、固定 cwd/USERPROFILE、认证变量清除、CI=1', async () => {
  const env = buildChildEnv({
    PATH: 'x',
    CLOUDBASE_SECRET_ID: SYN_SECRET,
    cloudbase_token: SYN_SECRET,          // 小写前缀同样要清
    TCB_REGION: 'ap-guangzhou',
    TENCENTCLOUD_SECRET_ID: SYN_SECRET,
    NODE_OPTIONS: '--require evil.js',
    USERPROFILE: 'C:/Users/someone-else'
  });
  const dumped = JSON.stringify(env);
  assert.equal(dumped.includes(SYN_SECRET), false, '继承的认证/配置变量必须清除：' + dumped);
  assert.equal(env.TCB_REGION, 'ap-shanghai');
  assert.equal(env.NO_UPDATE_NOTIFIER, '1');
  assert.equal(env.TCB_DISABLE_REPORT, '1');
  assert.equal(env.CI, '1');
  assert.equal(env.USERPROFILE, FIXED.authSessionDir);
  assert.equal(env.HOME, FIXED.authSessionDir);

  // 三条查询实际使用的 spawn 选项
  const d = readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk()) }
  });
  const r = await runReadOnlyObservation(d);
  assert.equal(r.status, STATUS.ASSOCIATION_OBSERVED, r.errorCode);
  // 生产限制值固定为 55 秒 / 1 MiB / exit 后 2 秒 close 宽限
  assert.deepEqual({ ...observer.LIMITS }, { timeoutMs: 55000, maxOutputBytes: 1024 * 1024, closeGraceMs: 2000 });
  const apiCalls = d.spawn.calls.filter(c => c.args[0] === SYN_CLI_ENTRY);
  assert.equal(apiCalls.length, 3);
  for (const call of apiCalls) {
    assert.equal(call.bin, SYN_NODE_BIN, '必须用固定 Node，不调用全局 PATH 的 tcb');
    assert.equal(call.options.shell, false, '必须 shell:false');
    assert.equal(call.options.cwd, SYN_AUTH_DIR);
    assert.equal(call.options.env.CI, '1');
    assert.equal(call.options.env.USERPROFILE, SYN_AUTH_DIR);
    assert.equal(call.options.stdio[0], 'ignore', 'stdin 必须关闭');
  }
  // 参数数组里不得出现任何拼接的 shell 片段
  for (const call of apiCalls) {
    assert.equal(call.args.some(a => /[|;&><]|\$\(|`/.test(String(a))), false, '参数不得含 shell 元字符');
  }
});

test('L2-3 本地准备条件不满足 → 零 API', async () => {
  const good = {
    [SYN_NODE_BIN]: '#!/bin/sh\n',
    [SYN_CLI_ENTRY]: SYN_ENTRY_CONTENT,
    [SYN_CLI_BUNDLE]: SYN_BUNDLE_CONTENT,
    'package.json': JSON.stringify({ version: FIXED.cliVersion })
  };
  const without = (dropped, extra) => {
    const out = Object.assign({}, good, extra || {});
    delete out[dropped];
    return out;
  };
  const cases = [
    ['bundle 缺失', { files: without(SYN_CLI_BUNDLE) }],
    ['入口缺失', { files: without(SYN_CLI_ENTRY) }],
    ['Node 缺失', { files: without(SYN_NODE_BIN) }],
    ['入口内容不符', { files: without(SYN_CLI_ENTRY, { [SYN_CLI_ENTRY]: 'console.log("tampered")\n' }) }],
    ['版本不符', { files: without('package.json', { 'package.json': JSON.stringify({ version: '9.9.9' }) }) }],
    ['bundle 哈希不符', { fixedOverride: Object.assign({}, SYN_FIXED, { cliBundleSha256: 'f'.repeat(64) }) }],
    // R1：入口哈希被替换成别的值（模拟另一份入口文件）
    ['入口哈希不符', { fixedOverride: Object.assign({}, SYN_FIXED, { cliEntrySha256: 'a'.repeat(64) }) }],
    // R1：入口被截断（少一个换行）
    ['入口字节截断', { files: without(SYN_CLI_ENTRY, { [SYN_CLI_ENTRY]: SYN_ENTRY_CONTENT.slice(0, -1) }) }]
  ];
  for (const [label, opts] of cases) {
    const d = readyDeps({}, opts);
    const r = await runReadOnlyObservation(d);
    assert.equal(r.cloudObservationPerformed, false, label);
    assert.equal(r.errorCode, 'LOCAL_PRECONDITION_NOT_MET', label);
    assert.equal(r.status, STATUS.FAILED, label);
    assert.equal(r.complete, false, label);
    assert.equal(d.spawn.calls.filter(c => c.args.includes('api')).length, 0, label + ' 不得启动任何云命令');
  }
});

test('L2-4 子进程 homedir 与固定目录不符 → 零 API', async () => {
  const d = readyDeps({}, { homedir: 'C:/Users/someone-else' });
  const r = await runReadOnlyObservation(d);
  assert.equal(r.cloudObservationPerformed, false);
  assert.equal(r.errorCode, 'LOCAL_PRECONDITION_NOT_MET');
  assert.equal(r.status, STATUS.FAILED);
  assert.equal(d.spawn.calls.filter(c => c.args.includes('api')).length, 0);
});

// ── 3. 顺序与停止（L1/L3） ────────────────────────────────────────────

test('L3-1 第一步失败 → 不调用后续；零 commit 等价物：不报告关联成功', async () => {
  const d = readyDeps({ 'sts GetCallerIdentity': { stdout: '{"Type":"Unknown"}', status: 0 } });
  const r = await runReadOnlyObservation(d);
  assert.equal(r.status, STATUS.FAILED);
  assert.equal(r.errorCode, ERR.STS_TYPE_UNVERIFIED);
  assert.equal(r.stoppedAt, 'callerIdentity');
  assert.equal(r.associationMatched, false);
  assert.equal(r.writeAuthorized, false);
  assert.equal(d.spawn.calls.filter(c => c.args.includes('api')).length, 1);
});

test('L3-2 第二步失败 → 不调用第三步', async () => {
  const d = readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { status: 1, stderr: SYN_SECRET }
  });
  const r = await runReadOnlyObservation(d);
  assert.equal(r.errorCode, ERR.CLI_NONZERO_EXIT);
  assert.equal(r.stoppedAt, 'describeEnvs');
  assert.equal(d.spawn.calls.filter(c => c.args.includes('api')).length, 2);
});

test('L3-3 超时 / 启动错误 / 输出超限 / 非零退出都失败关闭且不重试', async () => {
  const scenarios = [
    ['启动错误', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), ERR.SPAWN_FAILED],
    ['超时（子进程不退出）', { hang: true }, ERR.SPAWN_TIMEOUT]
  ];
  for (const [label, spec, code] of scenarios) {
    const d = readyDeps({ 'sts GetCallerIdentity': spec });
    // 仅测试注入更小的限制值，让超时分支**真实触发**而不是等满 55 秒
    d.limits = { timeoutMs: 120, maxOutputBytes: 1024 * 1024 };
    const r = await runReadOnlyObservation(d);
    assert.equal(r.errorCode, code, label + ' 实际=' + r.errorCode);
    assert.equal(r.status, STATUS.FAILED, label);
    assert.equal(r.associationMatched, false, label);
    assert.equal(d.spawn.calls.filter(c => c.args.includes('api')).length, 1, label + ' 不得重试');
  }
  // 信号终止（R4：与超时分开归类）
  const sigDeps = readyDeps({ 'sts GetCallerIdentity': { signal: 'SIGTERM', stdout: '' } });
  sigDeps.limits = { timeoutMs: 120, maxOutputBytes: 1024 * 1024 };
  const sigR = await runReadOnlyObservation(sigDeps);
  assert.equal(sigR.errorCode, ERR.SPAWN_SIGNALLED, '信号终止应与超时区分');
  // 输出超限（分块喂入超过合并上限）
  const bigDeps = readyDeps({ 'sts GetCallerIdentity': { chunked: true } });
  bigDeps.limits = { timeoutMs: 5000, maxOutputBytes: 1024 * 1024 };
  const bigR = await runReadOnlyObservation(bigDeps);
  assert.equal(bigR.errorCode, ERR.SPAWN_OUTPUT_LIMIT, '输出超限必须失败关闭');
  assert.equal(bigR.associationMatched, false);
  assert.equal(bigDeps.spawn.calls.filter(c => c.args.includes('api')).length, 1);
});

test('L3-4 超时未被确认时不得声称「已终止」，且如实记录未确认事实', async () => {
  const d = readyDeps({ 'sts GetCallerIdentity': { hang: true } });
  d.limits = { timeoutMs: 120, maxOutputBytes: 1024 * 1024 };
  const r = await runReadOnlyObservation(d);
  assert.equal(r.errorCode, ERR.SPAWN_TIMEOUT);
  const rec = r.stageExecutions.find(x => x.stage === 'callerIdentity');
  assert.equal(rec.timedOut, true, '必须记录超时');
  assert.equal(rec.terminationRequested, true, '只发出过终止请求');
  assert.equal(rec.terminationConfirmed, false, '没有观察到进程退出即不得声称已终止');
  // 失败文案不得出现「已终止」这类未确认表述
  assert.equal(JSON.stringify(r).includes('已终止'), false);
});

/* ── R1：启动文件完整性（R2 组合计数 / R3 根内提示 / R4 阶段事实） ────── */

test('R1-1 入口文件完整字节校验：两种保留片段绕过都被拒，且零 API', async () => {
  // Codex 复现样本 1：原require 后追加可执行语句
  const withExtra = SYN_ENTRY_CONTENT + "throw new Error('synthetic added code');\n";
  // Codex 复现样本 2：require 只写在注释里
  const commentOnly = "// require('../dist/standalone/cli.js')\nprocess.stdout.write('synthetic');";
  for (const [label, content] of [['追加可执行语句', withExtra], ['require 只在注释里', commentOnly]]) {
    // 合成文件内容变了，但 fixed 里的哈希/精确内容仍是已验收值 → 检查必须失败
    const files = {
      [SYN_NODE_BIN]: '#!/bin/sh\n',
      [SYN_CLI_ENTRY]: content,
      [SYN_CLI_BUNDLE]: SYN_BUNDLE_CONTENT,
      'package.json': JSON.stringify({ version: FIXED.cliVersion })
    };
    const d2 = readyDeps({}, { files });
    const r = await runReadOnlyObservation(d2);
    assert.equal(r.status, STATUS.FAILED, label);
    assert.equal(r.errorCode, 'LOCAL_PRECONDITION_NOT_MET', label);
    const entryCheck = r.localChecks.find(c => c.name === 'cli-entry-content');
    assert.equal(entryCheck.ok, false, label + ' 入口检查必须失败');
    assert.equal(d2.spawn.calls.filter(c => c.args.includes('api')).length, 0,
      label + ' 必须在任何 API 子进程启动前拒绝');
  }
});

test('R1-2 真实固定入口的完整字节与哈希一致（正向）', async () => {
  const d = readyDeps({});
  const r = await runLocalCheck(d);
  assert.equal(r.status, STATUS.LOCAL_READY, JSON.stringify(r.localChecks));
  assert.equal(r.localChecks.find(c => c.name === 'cli-entry-content').ok, true);
  // 固定值本身：57 字节、shebang + 单条转发 require
  assert.equal(Buffer.byteLength(FIXED.cliEntryExactBytes, 'utf8'), 57);
  assert.equal(FIXED.cliEntryExactBytes, "#!/usr/bin/env node\nrequire('../dist/standalone/cli.js')\n");
  assert.equal(
    crypto.createHash('sha256').update(FIXED.cliEntryExactBytes).digest('hex'),
    FIXED.cliEntrySha256
  );
});

test('R2-1 stdout+stderr 合并计数：各自低于上限但合计超限仍拒绝', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills++; return true; };
  const p = spawnBounded('fake', [], {}, {
    spawn: () => child,
    __limits: { timeoutMs: 5000, maxOutputBytes: 100 }
  });
  child.stdout.emit('data', Buffer.alloc(60, 120));
  child.stderr.emit('data', Buffer.alloc(60, 121));
  child.emit('close', 0, null);
  const r = await p;
  assert.equal(r.overflow, true, '合并超限必须拒绝（此前按各流分别计数会漏过）');
  assert.equal(r.totalBytes, 120);
  assert.equal(r.retainedBytes <= 100, true, '保留缓冲不得越限：' + r.retainedBytes);
  assert.equal(child.kills, 1, '只发一次终止请求');
});

test('R2-2 单个大 chunk 一次越限：保留有界、不越限', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const p = spawnBounded('fake', [], {}, {
    spawn: () => child,
    __limits: { timeoutMs: 5000, maxOutputBytes: 100 }
  });
  child.stdout.emit('data', Buffer.alloc(5_000_000, 120));
  const r = await p;
  assert.equal(r.overflow, true);
  assert.equal(r.totalBytes, 5_000_000, '先计数总量');
  assert.equal(r.retainedBytes <= 100, true, '保留缓冲必须被截断到上限内');
});

test('R2-3 收尾后继续输出：不再累加、不再二次 kill、监听已清理', async () => {
  const { child, promise } = spawnWithBarrier({ maxOutputBytes: 100 });
  await listenersReady();
  child.stdout.emit('data', Buffer.alloc(101, 120));
  const r = await promise;
  const killsBefore = child.kills;
  const retainedBefore = r.retainedBytes;
  // 收尾后再来数据
  child.stdout.emit('data', Buffer.alloc(101, 120));
  child.stderr.emit('data', Buffer.alloc(101, 121));
  assert.equal(child.kills, killsBefore, '收尾后不得再次 kill');
  assert.equal(r.retainedBytes, retainedBefore, '收尾后不得继续追加');
  assert.equal(r.totalBytes, 101, '收尾后不得继续计数');
  assert.equal(child.stdout.listenerCount('data'), 0, 'data 监听应已清理');
  assert.equal(child.stderr.listenerCount('data'), 0, 'data 监听应已清理');
});

test('R2-4 kill 返回 false 或抛错时如实记为终止未确认（不伪造已终止）', async () => {
  for (const kind of ['returnsFalse', 'throws']) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      if (kind === 'throws') throw new Error('kill failed');
      return false;
    };
    const p = spawnBounded('fake', [], {}, {
      spawn: () => child,
      __limits: { timeoutMs: 60, maxOutputBytes: 100, closeGraceMs: 5000 }
    });
    const r = await p;
    assert.equal(r.timedOut, true, kind);
    assert.equal(r.terminationRequested, true, kind);
    assert.equal(r.processExited, false, kind, '无 exit/close 即不得称进程已退出');
    assert.equal(r.terminationConfirmed, false, kind + ' 未观察到退出即不得声称已终止');
    assert.equal(r.signal, null, kind + ' 不得凭发出 kill 合成信号');
  }
});

test('R2-5 正常退出：终态稳定且不误判超时/超限', async () => {
  const { child, promise } = spawnWithBarrier({ maxOutputBytes: 1024 });
  await listenersReady();
  // 跨 chunk 的 UTF-8：一个中文字符被拆在两个 chunk 里
  const buf = Buffer.from('环境', 'utf8');
  child.stdout.emit('data', buf.subarray(0, 2));
  child.stderr.emit('data', Buffer.from('E', 'utf8'));
  child.stdout.emit('data', buf.subarray(2));
  child.emit('close', 0, null);
  const r = await promise;
  assert.equal(r.timedOut, false);
  assert.equal(r.overflow, false);
  assert.equal(r.code, 0);
  assert.equal(r.processExited, true);
  assert.equal(r.terminationConfirmed, true);
  assert.equal(r.terminationRequested, false);
  assert.equal(r.stdout, '环境', '跨 chunk 的 UTF-8 不得被逐 chunk 转换破坏');
  assert.equal(r.stderr, 'E');
});

test('R3-1 根对象内部混入提示行必须拒绝（不得「修好」后当成功）', () => {
  const broken = '{\n"Type":\n' + hintLine('sts', 'GetCallerIdentity') + '\n"CAMRole"\n}';
  // 前提：这本来就不是合法 JSON
  assert.equal((() => { try { JSON.parse(broken); return true; } catch { return false; } })(), false);
  assert.throws(() => parseCliJson(broken, 'sts', 'GetCallerIdentity'),
    e => e instanceof ObserverError && e.code === ERR.CLI_OUTPUT_UNPARSEABLE);
  // 另一等价形态：提示夹在字段值之间
  const broken2 = '{\n"Type": "CAM' + '\n' + hintLine('sts', 'GetCallerIdentity') + '\nRole"\n}';
  assert.throws(() => parseCliJson(broken2, 'sts', 'GetCallerIdentity'),
    e => e.code === ERR.CLI_OUTPUT_UNPARSEABLE);
});

test('R3-2 提示行仅在根对象外才允许（正向与既有负例都保持）', () => {
  // 纯 JSON
  assert.equal(parseCliJson(JSON.stringify(stsOk()), 'sts', 'GetCallerIdentity').Type, 'CAMRole');
  // 提示行 + JSON（真实形态）
  assert.equal(parseCliJson(stdoutFor(STAGES[0], stsOk()), 'sts', 'GetCallerIdentity').Type, 'CAMRole');
  // 提示 + JSON + 尾随提示与空白
  const trailing = stdoutFor(STAGES[0], stsOk()) + hintLine('sts', 'GetCallerIdentity') + '\n\n';
  assert.equal(parseCliJson(trailing, 'sts', 'GetCallerIdentity').Type, 'CAMRole');
  // 根对象之后出现第二个根 → 拒绝
  assert.throws(() => parseCliJson(stdoutFor(STAGES[0], stsOk()) + '\n' + JSON.stringify(stsOk()),
    'sts', 'GetCallerIdentity'), e => e.code === ERR.CLI_OUTPUT_UNPARSEABLE);
  // 根对象之前出现其它文本 → 拒绝
  assert.throws(() => parseCliJson('loading...\n' + JSON.stringify(stsOk()), 'sts', 'GetCallerIdentity'),
    e => e.code === ERR.CLI_OUTPUT_UNPARSEABLE);
});

test('R4-1 首步坏 JSON：保留真实阶段事实，后续标未执行', async () => {
  const d = readyDeps({ 'sts GetCallerIdentity': { stdout: '{broken', status: 0 } });
  const r = await runReadOnlyObservation(d);
  assert.equal(r.status, STATUS.FAILED);
  assert.equal(r.errorCode, ERR.CLI_OUTPUT_UNPARSEABLE);
  assert.equal(r.stoppedAt, 'callerIdentity', '解析错误必须绑定当前 stage');
  // R4：子进程确实已启动过 —— 如实记录，不得用「是否有合格结果」代替
  assert.equal(r.cloudQueryAttempted, true, '已尝试启动查询进程');
  assert.equal(r.cloudResponseValidated, false);
  assert.equal(r.cloudObservationPerformed, false);
  assert.equal(d.spawn.calls.filter(c => c.args.includes('api')).length, 1);
  const s0 = r.stageExecutions.find(x => x.stage === 'callerIdentity');
  assert.equal(s0.status, 'failed');
  assert.equal(s0.errorCode, ERR.CLI_OUTPUT_UNPARSEABLE);
  assert.equal(typeof s0.startedAt, 'string', '必须有阶段开始时间');
  assert.equal(typeof s0.finishedAt, 'string', '必须有阶段完成时间');
  assert.equal(s0.exitCode, 0, '退出码应被保留（净化后）');
  assert.equal(s0.terminationConfirmed, true, 'close 已观察到');
  assert.equal(r.stageExecutions[1].status, 'not-executed');
  assert.equal(r.stageExecutions[2].status, 'not-executed');
});

test('R4-2 首步字段错 / 次步非零退出 / 超时：分别保留阶段事实', async () => {
  // 首步字段类型不符
  const bad = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: JSON.stringify({ data: { Type: 'CAMRole', AccountId: 12345 } }), status: 0 }
  }));
  assert.equal(bad.errorCode, ERR.STS_FIELD_INVALID);
  assert.equal(bad.stoppedAt, 'callerIdentity');
  assert.equal(bad.cloudQueryAttempted, true);
  assert.equal(bad.cloudResponseValidated, false);
  assert.equal(bad.stageExecutions[1].status, 'not-executed');

  // 次步非零退出：退出码进入阶段记录
  const nz = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { status: 7, stderr: SYN_SECRET }
  }));
  assert.equal(nz.errorCode, ERR.CLI_NONZERO_EXIT);
  assert.equal(nz.stoppedAt, 'describeEnvs');
  const s1 = nz.stageExecutions.find(x => x.stage === 'describeEnvs');
  assert.equal(s1.exitCode, 7, '非零退出码必须保留为净化字段');
  assert.equal(s1.status, 'failed');
  assert.equal(nz.stageExecutions[2].status, 'not-executed');
  assert.equal(JSON.stringify(nz).includes(SYN_SECRET), false, 'stderr 文本不得进入报告');
  assert.equal(JSON.stringify(nz).includes('message'), false, '报告不带原始 message');

  // 超时
  const to = readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { hang: true }
  });
  to.limits = { timeoutMs: 120, maxOutputBytes: 1024 * 1024 };
  const toR = await runReadOnlyObservation(to);
  assert.equal(toR.errorCode, ERR.SPAWN_TIMEOUT);
  assert.equal(toR.stoppedAt, 'describeEnvs');
  const t1 = toR.stageExecutions.find(x => x.stage === 'describeEnvs');
  assert.equal(t1.timedOut, true);
  assert.equal(t1.terminationConfirmed, false);
  assert.equal(toR.stageExecutions[2].status, 'not-executed');
});

test('R4-3 全部成功：三阶段均 validated，时间与退出码齐备', async () => {
  const r = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk()) }
  }));
  assert.equal(r.status, STATUS.ASSOCIATION_OBSERVED);
  assert.equal(r.cloudQueryAttempted, true);
  assert.equal(r.cloudResponseValidated, true);
  assert.equal(r.stageExecutions.length, 3);
  for (const rec of r.stageExecutions) {
    assert.equal(rec.status, 'validated', rec.stage);
    assert.equal(rec.validationPassed, true, rec.stage);
    assert.equal(rec.exitCode, 0, rec.stage);
    assert.equal(typeof rec.startedAt, 'string', rec.stage);
    assert.equal(typeof rec.finishedAt, 'string', rec.stage);
  }
});

test('R4-4 所有失败码都是定义过的固定字符串（不得用 undefined 通过）', () => {
  for (const [key, value] of Object.entries(ERR)) {
    assert.equal(typeof value, 'string', key + ' 必须是字符串');
    assert.equal(value.length > 0, true, key);
  }
  assert.notEqual(ERR.ENVS_FIELD_INVALID, undefined, 'EnvList 字段无效必须有定义过的码');
  let code = null;
  try { assertDescribeEnvs({ EnvList: null }, 'describeEnvs'); } catch (e) { code = e.code; }
  assert.equal(code, ERR.ENVS_FIELD_INVALID);
  assert.equal(typeof code, 'string');
  // 每个 assert* 的失败都必须带定义过的 stage 与码
  for (const [fn, code2] of [
    [() => assertSts({ Type: 'root' }, crypto, 'callerIdentity'), ERR.STS_TYPE_UNVERIFIED],
    // Type 正确但身份字段缺失 → STS_FIELD_INVALID
    [() => assertSts({ Type: 'CAMRole' }, crypto, 'callerIdentity'), ERR.STS_FIELD_INVALID],
    [() => assertDescribeEnvs({ EnvList: 'x' }, 'describeEnvs'), ERR.ENVS_FIELD_INVALID],
    [() => assertDescribeEnvs({}, 'describeEnvs'), ERR.ENVS_FIELD_INVALID],
    [() => assertDescribeEnvInfo({}, 'x', crypto, 'describeEnvInfo'), ERR.ENV_INFO_FIELD_INVALID]
  ]) {
    let caught = null;
    try { fn(); } catch (e) { caught = e; }
    assert.ok(caught instanceof ObserverError, '应抛 ObserverError');
    assert.equal(caught.code, code2);
    assert.equal(typeof caught.stage, 'string');
    assert.ok(Object.values(ERR).includes(caught.code), '失败码必须在 ERR 中定义');
  }
});

test('R4-5 云响应不合格绝不变成关联成功，且不授权写入', async () => {
  for (const script of [
    { 'sts GetCallerIdentity': { stdout: '{broken', status: 0 } },
    { 'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk({ RequestId: undefined })), status: 0 } },
    { 'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()), status: 0 },
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk({ EnvList: [] })), status: 0 } }
  ]) {
    const r = await runReadOnlyObservation(readyDeps(script));
    assert.notEqual(r.status, STATUS.ASSOCIATION_OBSERVED);
    assert.equal(r.associationMatched, false);
    assert.equal(r.complete, false);
    assert.equal(r.writeAuthorized, false);
    assert.equal('allowed' in r, false);
  }
});

/* ── S1：exit 提前完成会丢输出 / S2：晚到 error 变未捕获异常 ────────── */

/**
 * 合成 ChildProcess 事件源。
 *
 * T1：宽限计时**只由 exit 事件启动**，因此测试必须真实并发推进 —— 不能在拿到 Promise
 * 之后同步 emit（此时 `spawnBounded` 尚未注册监听，数据会被丢弃）。
 * 这里用 `spawned` 屏障：spawn 被调用后再由测试发出事件。
 */
function makeChild(killImpl) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = killImpl || (() => { child.kills++; return true; });
  return child;
}

/**
 * T1 辅助：以「已注册监听」为屏障启动一次 spawnBounded。
 * 返回 { child, promise, settled }；settled 是函数，表示是否已收尾。
 */
function spawnWithBarrier(limitsOverride, child) {
  const c = child || makeChild();
  let settled = false;
  const promise = spawnBounded('fake', [], {}, {
    spawn: () => c,
    __limits: Object.assign({ timeoutMs: 5000, maxOutputBytes: 4096, closeGraceMs: 5000 }, limitsOverride || {})
  }).then(r => { settled = true; return r; });
  return { child: c, promise, isSettled: () => settled };
}

/** 让出一轮事件循环，确保 spawnBounded 已注册监听（事件屏障，不用极短 sleep 碰运气） */
async function listenersReady() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

/** 有界等待（毫秒）。T1 需要跨过真实时间窗，故用带下界的显式延时而不是 setImmediate */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('S1-1 exit 后仍有尾部输出：必须等close 收全，不得提前完成', async () => {
  const { child, promise } = spawnWithBarrier({});
  await listenersReady();
  child.stdout.emit('data', Buffer.from('{"ok":', 'utf8'));
  child.emit('exit', 0, null);          // 进程退出，但 stdout 尚未关闭
  child.stdout.emit('data', Buffer.from('true}', 'utf8'));   // 管道里的剩余内容
  child.emit('close', 0, null);
  const r = await promise;
  // 收全后是一个完整可解析对象；此前会在 close 前完成、只保留前半
  assert.equal(r.stdout, '{"ok":true}');
  assert.deepEqual(JSON.parse(r.stdout), { ok: true });
  assert.equal(r.timedOut, false);
  assert.equal(r.closeNotObserved, false);
  assert.equal(r.code, 0);
  assert.equal(r.processExited, true);
  assert.equal(r.terminationConfirmed, true);
});

test('S1-2 exit 后尾部是非法内容：必须收全后再交给解析器拒绝', async () => {
  const { child, promise } = spawnWithBarrier({});
  await listenersReady();
  child.stdout.emit('data', Buffer.from('{"ok":true}', 'utf8'));
  child.emit('exit', 0, null);
  child.stdout.emit('data', Buffer.from('UNEXPECTED_TAIL', 'utf8'));
  child.emit('close', 0, null);
  const r = await promise;
  assert.equal(r.stdout, '{"ok":true}UNEXPECTED_TAIL', '不得丢弃尾部');
  // 完整收尾后由解析器判定：非法 JSON 一律拒绝（此前尾部丢失反而被接受）
  assert.throws(() => parseCliJson(r.stdout, 'sts', 'GetCallerIdentity'),
    e => e instanceof ObserverError && e.code === ERR.CLI_OUTPUT_UNPARSEABLE);
});

test('S1-3 普通完整输出 → exit → close：语义与注释一致', async () => {
  const { child, promise } = spawnWithBarrier({});
  await listenersReady();
  child.stdout.emit('data', Buffer.from('{"a":1}', 'utf8'));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const r = await promise;
  assert.equal(r.stdout, '{"a":1}');
  assert.equal(r.processExited, true);
  assert.equal(r.terminationConfirmed, true);
  assert.equal(r.closeNotObserved, false);
  assert.equal(r.signal, null, 'exit 的 0 不是信号');
  assert.equal(child.kills, 0, '正常退出不得请求终止');
});

test('S1-4 exit 后 close 迟迟不来：宽限有界失败，不把半截输出当成功', async () => {
  const { child, promise } = spawnWithBarrier({ closeGraceMs: 80 });
  await listenersReady();
  child.stdout.emit('data', Buffer.from('{"partial":', 'utf8'));
  child.emit('exit', 0, null);          // 退出已观察，但 close 永不发生
  const r = await promise;
  assert.equal(r.processExited, true);
  assert.equal(r.closeNotObserved, true, 'close 未观察到必须如实标记');
  assert.equal(r.timedOut, false, '这是宽限到期，不是总超时');
  assert.equal(r.stdout, '{"partial":', '保留已收到的受限输出，不追加也不伪造');
});

test('S1-5 上层把「close 未观察到」当失败：不得继续解析半截输出', async () => {
  // 合成 child：API 查询只发 exit、永不发 close，stdout 只有半截 JSON。
  // homedir 检查仍走 readyDeps 的默认替身（args[0]==='-e'）。
  const child = makeChild();
  const d = readyDeps({});
  d.limits = { timeoutMs: 5000, maxOutputBytes: 4096, closeGraceMs: 120 };
  const inner = d.spawn;
  d.spawn = (bin, args, options) => (args[0] === '-e' ? inner(bin, args, options) : child);
  const p = runReadOnlyObservation(d);
  // 事件屏障：等 homedir 检查完成、第一条查询真正spawn 之后再发事件（不用极短 sleep 赌时序）
  await listenersReady();
  await listenersReady();
  child.stdout.emit('data', Buffer.from('{"Type":"CAMRole"', 'utf8'));
  child.emit('exit', 0, null);
  const r = await p;
  assert.equal(r.status, STATUS.FAILED, JSON.stringify(r.localChecks || r.stageExecutions));
  assert.equal(r.errorCode, ERR.SPAWN_CLOSE_UNCONFIRMED, '半截输出绝不能变成关联成功');
  assert.equal(r.stoppedAt, 'callerIdentity');
  assert.equal(r.associationMatched, false);
  assert.equal(r.complete, false);
  assert.equal(r.writeAuthorized, false);
  const rec = r.stageExecutions.find(x => x.stage === 'callerIdentity');
  assert.equal(rec.terminationConfirmed, true, 'exit 已观察到，终止事实成立');
  assert.equal(rec.closeNotObserved, true, 'close 未观察到');
  assert.equal(rec.exitCode, 0, 'exit 记录的退出码应保留');
});

test('S2-1 timeout 后的晚到 error 被吸收：不抛、不打印、不改报告', async () => {
  const SECRET = 'SYNTHETIC_LATE_ERROR_SECRET';
  // 用 child 自己的 error 监听计数来证明「发射不抛」，不劫持 process.stdout
  // （劫持会干扰测试运行器自身的输出）
  const { child, promise } = spawnWithBarrier({ timeoutMs: 40 });
  const r = await promise;
  assert.equal(r.timedOut, true);
  assert.equal(child.listenerCount('error'), 1, '收尾后必须保留 error 吸收器');
  // 收尾后发射 error：EventEmitter 在无 error 监听时会抛错
  let emitThrew = null;
  try {
    child.emit('error', new Error(SECRET));
  } catch (error) {
    emitThrew = error;
  }
  assert.equal(emitThrew, null, '晚到 error 不得抛出');
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes(SECRET), false, '报告不得包含晚到 error 文本');
  assert.equal(r.stdout, '', '不得因晚到 error 追加任何输出');
  assert.equal(r.spawnError, null, '晚到 error 不得改写已确定的结果');
});

test('S2-2 overflow 后的晚到 error 被吸收，且不二次 kill', async () => {
  const { child, promise } = spawnWithBarrier({ maxOutputBytes: 100 });
  await listenersReady();
  child.stdout.emit('data', Buffer.alloc(200, 120));
  const r = await promise;
  assert.equal(r.overflow, true);
  const killsBefore = child.kills;
  assert.doesNotThrow(() => child.emit('error', new Error('late')));
  assert.doesNotThrow(() => child.emit('error', new Error('late again')));
  assert.equal(child.kills, killsBefore, '晚到 error 不得触发二次 kill');
  assert.equal(JSON.stringify(r).includes('late'), false, '报告不得被晚到 error 改写');
});

test('S2-3 error 首次结束后：重复或晚到 error 同样被吸收', async () => {
  const { child, promise } = spawnWithBarrier({});
  await listenersReady();
  child.emit('error', new Error('first'));      // 首次 error：作为结果返回
  const r = await promise;
  assert.ok(r.spawnError, '首次 error 应进入结果');
  assert.equal(r.spawnError.message, 'first');
  // 重复与晚到 error 都不得抛出
  assert.doesNotThrow(() => child.emit('error', new Error('second')));
  assert.doesNotThrow(() => child.emit('error', new Error('third')));
  assert.equal(r.spawnError.message, 'first', '结果不被后来的 error 改写');
  assert.equal(r.code, null);
});

test('S2-4 收尾后仍可继续接收 close/exit/data 而不抛错、不改报告', async () => {
  const { child, promise } = spawnWithBarrier({ timeoutMs: 40 });
  const r = await promise;
  const snapshot = JSON.stringify(r);
  assert.doesNotThrow(() => {
    child.stdout.emit('data', Buffer.from('late data', 'utf8'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  });
  assert.equal(JSON.stringify(r), snapshot, '报告保持原状');
  assert.equal(r.totalBytes, 0, '收尾后不得继续累积输出字节');
});

// ── T1：close 宽限必须从首次 exit 之后才开始（T1-1 ~ T1-4） ──────────

test('T1-1 未观察到 exit 时close 宽限根本不启动：运行超过 closeGrace 仍继续等待', async () => {
  // 这是 Codex 报告的核心缺陷：宽限计时器此前在 spawnBounded 进入时就启动，
  // 于是任何正常运行时长超过 closeGraceMs 的查询都会被误判「close 未确认」。
  // 本例把 closeGrace 压到 30ms、timeout 放宽到 1500ms，先静默运行 120ms
  // （> closeGrace，< 剩余 timeout），Promise 必须仍未收尾。
  const { child, promise, isSettled } = spawnWithBarrier({ closeGraceMs: 30, timeoutMs: 1500 });
  await listenersReady();
  await delay(120);
  assert.equal(isSettled(), false, '未观察到 exit 时不得因 close 宽限到期而收尾');
  // 随后正常输出 + exit + close 到达，必须成功且语义正确
  child.stdout.emit('data', Buffer.from('{"ok":true}', 'utf8'));
  child.emit('exit', 0, null);
  child.stdout.emit('data', Buffer.from('', 'utf8'));
  child.emit('close', 0, null);
  const r = await promise;
  assert.equal(r.timedOut, false, '既未总超时也未宽限到期');
  assert.equal(r.closeNotObserved, false, 'close 已到达');
  assert.equal(r.processExited, true);
  assert.equal(r.terminationConfirmed, true);
  assert.equal(r.stdout, '{"ok":true}', '静默期后的输出必须完整保留');
  assert.equal(child.kills, 0, '不得请求终止');
});

test('T1-2 exit 较晚发生时宽限从 exit 起算；重复 exit 不刷新、不延长宽限', async () => {
  // closeGrace 80ms：静默 120ms 后才 exit，宽限必须从 exit 开始完整给足，
  // 并在 exit 后约 80ms 失败；期间重复 exit 不得把宽限一次次推后。
  const t0 = Date.now();
  const { child, promise } = spawnWithBarrier({ closeGraceMs: 80, timeoutMs: 5000 });
  await listenersReady();
  await delay(120);
  assert.equal(child.kills, 0, '未 exit 前不得 kill');
  child.stdout.emit('data', Buffer.from('{"partial":1}', 'utf8'));
  child.emit('exit', 0, null);              // 宽限从此刻起算
  await delay(40);
  child.emit('exit', 0, null);              // 重复 exit：不得刷新宽限
  const r = await promise;
  const elapsed = Date.now() - t0;
  assert.equal(r.closeNotObserved, true, 'close 始终未到，应按宽限有界失败');
  assert.equal(r.timedOut, false);
  assert.equal(r.processExited, true);
  assert.equal(r.code, 0, 'exit 记录的退出码应保留');
  assert.equal(r.stdout, '{"partial":1}', '尾部输出不得丢失');
  // 关键：失败时间应≈ 120（静默）+ 80（exit 后的宽限），而不是 80（从 spawn 起算）
  assert.equal(elapsed >= 190, true, `宽限必须从 exit 起算，实际耗时 ${elapsed}ms 不该这么短`);
  assert.equal(elapsed < 400, true, `重复 exit 不得延长宽限，实际耗时 ${elapsed}ms 过长`);
});

test('T1-3 永不 exit/close：只由总超时结束，请求一次 kill，不误标 close 未观察到', async () => {
  const t0 = Date.now();
  const { child, promise } = spawnWithBarrier({ closeGraceMs: 30, timeoutMs: 100 });
  const r = await promise;
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true, '永不出 exit 时必须由总超时兜底');
  assert.equal(r.terminationRequested, true, '总超时必须请求终止');
  assert.equal(child.kills, 1, '终止请求只发一次');
  assert.equal(r.processExited, false, '未观察到 exit/close');
  assert.equal(r.terminationConfirmed, false, '未观察到退出不得声称已终止');
  assert.equal(r.closeNotObserved, false, '从未 exit 就不该标「close 未观察到」');
  assert.equal(elapsed < 900, true, `close 宽限不得延长总超时，实际 ${elapsed}ms`);
});

test('T1-4 exit 后 close 缺失：宽限有界失败，且不得越过更早到达的总超时', async () => {
  // closeGrace 500ms 晚于timeout 100ms：宽限不得把总超时推后。
  const t0 = Date.now();
  const { child, promise } = spawnWithBarrier({ closeGraceMs: 500, timeoutMs: 100 });
  await listenersReady();
  child.emit('exit', 0, null);   // exit 已到，但 close 永不发生
  const r = await promise;
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true, '总超时先到，应记为超时');
  assert.equal(r.closeNotObserved, false, '宽限尚未到期，不得提前标 close 未观察到');
  assert.equal(child.kills, 1, '总超时只请求一次终止');
  assert.equal(elapsed < 450, true, `宽限(500ms) 不得延长总超时(100ms)，实际 ${elapsed}ms`);
});

// ── 4. 解析契约（L2） ─────────────────────────────────────────────────

test('L4-1 标准 JSON 与 提示行+JSON 都能解析；对象内的花括号不影响', () => {
  // 纯 JSON（无提示行）
  const plain = JSON.stringify(stsOk());
  assert.equal(parseCliJson(plain, 'sts', 'GetCallerIdentity').Type, 'CAMRole');

  // 带本机已核对的提示行（含 ANSI）
  assert.equal(parseCliJson(stdoutFor(STAGES[0], stsOk()), 'sts', 'GetCallerIdentity').Type, 'CAMRole');

  // 对象字符串内含花括号与箭头，不能被误当提示或被截断
  const tricky = stsOk({ Arn: 'qcs::cam::uin/1:role/{weird}→x' });
  assert.equal(parseCliJson(stdoutFor(STAGES[0], tricky), 'sts', 'GetCallerIdentity').Arn,
    'qcs::cam::uin/1:role/{weird}→x');

  // ANSI 清理
  assert.equal(stripAnsi('[1m[34mℹ[39m[22m x').includes('['), false);
});

test('L4-2 多根 / 截断 / 数组根 / null 根 / 错误对象 / 未知前后文本 全部拒绝', () => {
  const bad = [
    ['多根对象', stdoutFor(STAGES[0], stsOk()) + '\n' + JSON.stringify(stsOk())],
    ['截断 JSON', '{"data":{"Type":"CAMRole"'],
    ['数组根', '[{"Type":"CAMRole"}]'],
    ['null 根', 'null'],
    ['未知前后文本', 'loading...\n' + JSON.stringify(stsOk())],
    ['提示行与 action 不符', hintLine('tcb', 'DescribeEnvs') + '\n' + JSON.stringify(stsOk())],
    ['完全无 JSON', '  \n ']
  ];
  for (const [label, out] of bad) {
    assert.throws(() => parseCliJson(out, 'sts', 'GetCallerIdentity'),
      e => e instanceof ObserverError && e.code === ERR.CLI_OUTPUT_UNPARSEABLE, label);
  }
  // 平台错误对象单独归类
  for (const payload of [{ data: { Error: { Code: 'X' } } }, { Code: 'AuthFailure' }]) {
    assert.throws(() => parseCliJson(JSON.stringify(payload), 'sts', 'GetCallerIdentity'),
      e => e.code === ERR.PLATFORM_ERROR_OBJECT, JSON.stringify(payload));
  }
});

// ── 5. 关联核验（L2） ─────────────────────────────────────────────────

test('L5-1 正向：合成 CAMRole → 单环境 → 账号/AppID 相符', async () => {
  const d = readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk()) }
  });
  const r = await runReadOnlyObservation(d);
  assert.equal(r.status, STATUS.ASSOCIATION_OBSERVED, JSON.stringify(r));
  assert.equal(r.complete, true);
  assert.equal(r.associationMatched, true);
  assert.equal(r.cloudObservationPerformed, true);
  assert.equal(r.writeAuthorized, false);
  assert.equal(r.callerIdentity.type, 'CAMRole');
  assert.equal(r.callerIdentity.accountIdSha256, digestOf(crypto, SYN_ACCOUNT));
  assert.equal(r.describeEnvs.envId, FIXED.envId);
  assert.equal(r.describeEnvInfo.uinSha256, r.callerIdentity.accountIdSha256,
    'Uin 与 AccountId 必须同算法同字节输入');
});

test('L5-2 错账号 / 错 AppID / 错地域 / 异常状态 / 重复环境 / 缺字段 分别不通过', async () => {
  const sts = { 'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) } };
  const cases = [
    ['归属账号不符', ERR.ACCOUNT_MISMATCH, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
      'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk({}, { Uin: SYN_OTHER_ACCOUNT })) }
    }],
    ['微信 AppID 不符', ERR.WX_APP_ID_MISMATCH, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
      'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk({}, { WxAppId: 'wxSYNTHETICwrong' })) }
    }],
    // 数字型 AppId 不能替代 WxAppId：缺 WxAppId 即不通过
    ['只有数字型 AppId', ERR.WX_APP_ID_MISMATCH, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
      'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk({}, { WxAppId: undefined, AppId: 1234567890 })) }
    }],
    ['环境状态异常', ERR.ENVS_FIELD_MISMATCH, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk({ EnvList: [{ EnvId: FIXED.envId, Status: 'ISOLATED', Region: FIXED.region }] })) }
    }],
    ['环境地域不符', ERR.ENVS_FIELD_MISMATCH, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk({ EnvList: [{ EnvId: FIXED.envId, Status: 'NORMAL', Region: 'ap-beijing' }] })) }
    }],
    ['环境 ID 不匹配', ERR.ENVS_FIELD_MISMATCH, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk({ EnvList: [{ EnvId: 'cloud1-other', Status: 'NORMAL', Region: FIXED.region }] })) }
    }],
    ['重复环境', ERR.ENVS_NOT_SINGLE, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk({ EnvList: [
        { EnvId: FIXED.envId, Status: 'NORMAL', Region: FIXED.region },
        { EnvId: FIXED.envId, Status: 'NORMAL', Region: FIXED.region }
      ] })) }
    }],
    ['额外环境', ERR.ENVS_NOT_SINGLE, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk({ EnvList: [
        { EnvId: FIXED.envId, Status: 'NORMAL', Region: FIXED.region },
        { EnvId: 'cloud1-extra', Status: 'NORMAL', Region: FIXED.region }
      ] })) }
    }],
    ['STS 字段缺失', ERR.STS_FIELD_INVALID, {
      'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk({ RequestId: undefined })) }
    }],
    ['STS 身份类型未核验', ERR.STS_TYPE_UNVERIFIED, {
      'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk({ Type: 'root' })) }
    }],
    ['环境详情缺 Uin', ERR.ENV_INFO_FIELD_INVALID, {
      ...sts,
      'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
      'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk({}, { Uin: undefined })) }
    }]
  ];
  for (const [label, code, script] of cases) {
    const d = readyDeps(script);
    const r = await runReadOnlyObservation(d);
    assert.equal(r.status, STATUS.FAILED, label);
    assert.equal(r.errorCode, code, label + ' 实际=' + r.errorCode);
    assert.equal(r.associationMatched, false, label);
    assert.notEqual(r.status, STATUS.ASSOCIATION_OBSERVED, label);
  }
});

test('L5-3 类型不符不做猜测转换（STS 身份值仍严格只接受字符串；Uin 另见 C1）', () => {
  // STS 侧**不放宽**：`AccountId` 必须是字符串，数字型身份值仍然直接拒绝
  assert.throws(() => assertSts({ Type: 'CAMRole', AccountId: 100012345678, UserId: 'u', PrincipalId: 'p', Arn: 'a', RequestId: 'r' }, crypto, 'callerIdentity'),
    e => e.code === ERR.STS_FIELD_INVALID);
  // 断言具体定义的错误码，而不是与 undefined 比较（R4）
  assert.throws(() => assertDescribeEnvs({ EnvList: 'not-an-array' }, 'describeEnvs'),
    e => e.code === ERR.ENVS_FIELD_INVALID);
  assert.throws(() => assertDescribeEnvInfo({}, digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'),
    e => e.code === ERR.ENV_INFO_FIELD_INVALID);
  // 直接调用也遵守「未核验类型即拒绝」
  assert.throws(() => assertSts({ Type: 'CAMUser' }, crypto, 'x'), e => e.code === ERR.STS_TYPE_UNVERIFIED);
  // 注意区分：环境归属 `Uin` 因**已实测**为 number，由C1 的窄契约单独处理（见 C1-3），
  // 不意味着 STS 侧身份字段也放宽数字。
  assert.throws(() => assertSts({ Type: 'CAMRole', AccountId: SYN_ACCOUNT, UserId: 12345, PrincipalId: 'p', Arn: 'a', RequestId: 'r' }, crypto, 'callerIdentity'),
    e => e.code === ERR.STS_FIELD_INVALID, 'STS UserId 仍必须是字符串');
});

/** C1 辅助：`assertDescribeEnvInfo` 接收的是**解包后**的 payload，而 `envInfoOk()` 返回 `{data:...}`。 */
function envInfoPayload(userOverrides) {
  return envInfoOk({}, userOverrides).data;
}

// ── C1：环境归属 Uin 的窄类型适配（已实测 number + 兼容字符串） ────────

test('C1-1 Uin 为十进制正整数字符串：保留原始字节，与 STS 摘要精确匹配', () => {
  const payload = envInfoPayload({ Uin: SYN_UIN });
  const r = assertDescribeEnvInfo(payload, digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo');
  assert.equal(r.uinSha256, digestOf(crypto, SYN_UIN), '字符串形态摘要与旧行为一致');
  assert.equal(r.uinTail, SYN_UIN.slice(-4));
  // 字符串必须是十进制正整数：带符号/小数/空白/非数字一律拒绝
  for (const bad of ['', ' ', 'abc', '100012345678 ', ' 100012345678', '+100012345678',
    '-100012345678', '1.0', '1e5', '0x10', '1000 1234', '100012345678\n', '０１']) {
    assert.throws(() => assertDescribeEnvInfo(envInfoPayload({ Uin: bad }),
      digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'),
      e => e.code === ERR.ENV_INFO_FIELD_INVALID, '必须拒绝：' + JSON.stringify(bad));
  }
});

test('C1-2 Uin 为有限正安全整数 number：按 String(Uin) 摘要并匹配（已实测形态）', () => {
  const numeric = Number(SYN_ACCOUNT);                 // 合成账号的安全整数形式
  assert.equal(Number.isSafeInteger(numeric), true, '夹具必须是安全整数');
  const r = assertDescribeEnvInfo(envInfoPayload({ Uin: numeric }),
    digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo');
  assert.equal(r.uinSha256, digestOf(crypto, SYN_ACCOUNT), 'String(Uin) 与字符串形态同摘要');
  assert.equal(r.uinTail, SYN_ACCOUNT.slice(-4));
  // 正安全整数是本轮唯一放宽的形态
  assert.equal(assertDescribeEnvInfo(envInfoPayload({ Uin: 1 }), digestOf(crypto, '1'), crypto, 'x').uinSha256,
    digestOf(crypto, '1'), '1 也应按"1" 处理');
});

test('C1-3 非法数值与非法类型全部拒绝；Uin 数字与 STS 摘要不匹配也拒绝', () => {
  // 非法数值：不安全整数 / 小数 / 负数 / 零 / NaN / Infinity
  for (const bad of [Number.MAX_SAFE_INTEGER + 2, 1.5, -1, 0, -0, NaN, Infinity, -Infinity,
Number.MAX_VALUE, Number.MIN_VALUE]) {
    assert.throws(() => assertDescribeEnvInfo(envInfoPayload({ Uin: bad }),
      digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'),
      e => e.code === ERR.ENV_INFO_FIELD_INVALID, '必须拒绝数值：' + String(bad));
  }
  // 非法类型：null / undefined / 布尔 / 对象 / 数组 / 其它
  for (const bad of [null, undefined, true, false, {}, { valueOf: () => SYN_ACCOUNT },
    [], [SYN_ACCOUNT], Symbol('x'), 100012345678n]) {
    assert.throws(() => assertDescribeEnvInfo(envInfoPayload({ Uin: bad }),
      digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'),
      e => e.code === ERR.ENV_INFO_FIELD_INVALID, '必须拒绝类型：' + String(typeof bad));
  }
  // 不得用任意 String(value) 让对象通过：摘要输入不是 "[object Object]"
  assert.throws(() => normalizeEnvUin({ toString: () => SYN_ACCOUNT }, 'x'),
    e => e.code === ERR.ENV_INFO_FIELD_INVALID);
  assert.throws(() => normalizeEnvUin([SYN_ACCOUNT], 'x'),
    e => e.code === ERR.ENV_INFO_FIELD_INVALID);
  // 类型合法但与 STS 摘要不一致 → 账号不匹配（不是字段非法）
  assert.throws(() => assertDescribeEnvInfo(envInfoPayload({ Uin: Number(SYN_OTHER_ACCOUNT) }),
      digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'),
    e => e.code === ERR.ACCOUNT_MISMATCH);
  assert.throws(() => assertDescribeEnvInfo(envInfoPayload({ Uin: SYN_OTHER_ACCOUNT }),
      digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'),
    e => e.code === ERR.ACCOUNT_MISMATCH);
});

test('C1-4 带前导零字符串不得被擅自归一后匹配', () => {
  // "00100012345678" 数值上等于 SYN_ACCOUNT，但**原始字节不同**，摘要必须不同
  const padded = '00' + SYN_ACCOUNT;
  assert.notEqual(digestOf(crypto, padded), digestOf(crypto, SYN_ACCOUNT));
  assert.throws(() => assertDescribeEnvInfo(envInfoPayload({ Uin: padded }),
      digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'),
    e => e.code === ERR.ACCOUNT_MISMATCH, '不得去前导零后当作匹配');
  // 尾号也必须来自原始字节
  const r = assertDescribeEnvInfo(envInfoPayload({ Uin: padded }),
    digestOf(crypto, padded), crypto, 'describeEnvInfo');
  assert.equal(r.uinTail, padded.slice(-4));
  // 全零不是正整数
  for (const bad of ['0', '00', '000']) {
    assert.throws(() => normalizeEnvUin(bad, 'x'), e => e.code === ERR.ENV_INFO_FIELD_INVALID);
  }
});

test('C1-5 C1 只作用于 Uin：STS 数字身份、WxAppId、地域检查一律不放宽', () => {
  // STS AccountId 为数字仍拒绝（未因Uin 适配而放宽）
  assert.throws(() => assertSts({ Type: 'CAMRole', AccountId: Number(SYN_ACCOUNT), UserId: 'u', PrincipalId: 'p', Arn: 'a', RequestId: 'r' },
    crypto, 'callerIdentity'), e => e.code === ERR.STS_FIELD_INVALID);
  // WxAppId 仍要求精确字符串相等，数字型 AppId 不可替代
  assert.throws(() => assertDescribeEnvInfo(envInfoPayload({ Uin: SYN_UIN, WxAppId: Number(FIXED.wxAppId) }),
    digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'), e => e.code === ERR.WX_APP_ID_MISMATCH);
  // 地域/状态仍精确匹配
  assert.throws(() => assertDescribeEnvInfo({ EnvInfo: {
    EnvBaseInfo: { EnvId: FIXED.envId, Status: 'NORMAL', Region: 'ap-beijing' },
    UserInfo: { Uin: SYN_UIN, WxAppId: FIXED.wxAppId } } },
    digestOf(crypto, SYN_ACCOUNT), crypto, 'describeEnvInfo'), e => e.code === ERR.ENVS_FIELD_MISMATCH);
});

test('C1-6 成功与失败输出都不含完整账号值（数字与字符串形态均然）', async () => {
  // 成功路径：数字型 Uin
  const ok = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk({}, { Uin: Number(SYN_ACCOUNT) })) }
  }));
  assert.equal(ok.status, STATUS.ASSOCIATION_OBSERVED, ok.errorCode);
  assert.equal(ok.writeAuthorized, false);
  const dumped = JSON.stringify(ok);
  assert.equal(dumped.includes(SYN_ACCOUNT), false, '成功输出泄露完整 Uin');
  assert.equal(dumped.includes(String(Number(SYN_ACCOUNT))), false, '成功输出泄露数字形态 Uin');
  assert.equal(dumped.includes(SYN_UIN), false, '成功输出泄露合成账号');

  // 失败路径：账号不匹配（数字形态）
  const bad = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk({}, { Uin: Number(SYN_OTHER_ACCOUNT) })) }
  }));
  assert.equal(bad.status, STATUS.FAILED);
  assert.equal(bad.errorCode, ERR.ACCOUNT_MISMATCH);
  assert.equal(bad.writeAuthorized, false);
  const badDump = JSON.stringify(bad);
  assert.equal(badDump.includes(SYN_OTHER_ACCOUNT), false, '失败输出泄露完整 Uin');
  assert.equal(badDump.includes(String(Number(SYN_OTHER_ACCOUNT))), false, '失败输出泄露数字形态 Uin');

  // 失败路径：字段非法（对象形态），错误文本也不得回显原值
  const invalid = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk({}, { Uin: { raw: SYN_ACCOUNT } })) }
  }));
  assert.equal(invalid.status, STATUS.FAILED);
  assert.equal(invalid.errorCode, ERR.ENV_INFO_FIELD_INVALID);
  assert.equal(JSON.stringify(invalid).includes(SYN_ACCOUNT), false, '失败输出回显完整 Uin');
});

// ── 6. 标记不泄露 / 不授权（L3） ──────────────────────────────────────

test('L6-1 stdout/stderr/额外字段中的 secret、Token、OPENID 标记都不泄露', async () => {
  const secretInArgs = { Arw: SYN_SECRET, Note: SYN_OPENID, Token: SYN_SECRET, openid: SYN_OPENID };
  const ok = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk(secretInArgs)), stderr: SYN_SECRET + SYN_OPENID },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk(secretInArgs)), stderr: SYN_SECRET },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk(secretInArgs, { Note: SYN_OPENID })), stderr: SYN_SECRET + SYN_OPENID }
  }));
  assert.equal(ok.status, STATUS.ASSOCIATION_OBSERVED, ok.errorCode);
  const dumped = JSON.stringify(ok);
  assert.equal(dumped.includes(SYN_SECRET), false, '成功输出泄露 secret/Token');
  assert.equal(dumped.includes(SYN_OPENID), false, '成功输出泄露 OPENID');

  // 失败路径：错误文本不得进入结果
  const failed = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { status: 1, stdout: SYN_SECRET + SYN_OPENID, stderr: SYN_SECRET }
  }));
  const failDump = JSON.stringify(failed) + JSON.stringify(Object.getOwnPropertyNames(failed));
  assert.equal(failDump.includes(SYN_SECRET), false, '失败输出泄露 secret');
  assert.equal(failDump.includes(SYN_OPENID), false, '失败输出泄露 OPENID');
  assert.equal(failed.errorCode, ERR.CLI_NONZERO_EXIT);
});

test('L6-2 所有结果都不授权写入，且不出现 allowed:true', async () => {
  const ok = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk()) }
  }));
  const bad = await runReadOnlyObservation(readyDeps({ 'sts GetCallerIdentity': { status: 3, stderr: 'x' } }));
  for (const r of [ok, bad, await runLocalCheck(readyDeps({}))]) {
    assert.equal(r.writeAuthorized, false);
    assert.equal('allowed' in r, false);
    assert.equal(r.productionCallerVerifierImplemented, false);
    assert.equal(r.isAuthorizationMechanism, false);
    assert.equal(JSON.stringify(r).includes('"allowed":true'), false);
  }
  // 不产生 approval / 计划类字段
  for (const key of ['approval', 'approvedUserIds', 'approvedBy', 'plan', 'credentials']) {
    assert.equal(key in ok, false, key);
  }
});

test('L6-3 完整身份值不落入输出（只有摘要与尾号）', async () => {
  const r = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk()) }
  }));
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes(SYN_ACCOUNT), false, '完整 AccountId 不得出现');
  assert.equal(dumped.includes('sub-synthetic-user'), false, '完整 UserId 不得出现');
  assert.equal(dumped.includes('principal-synthetic-5386'), false, '完整 PrincipalId 不得出现');
  assert.equal(dumped.includes('qcs::cam'), false, 'Arn 不得出现');
  // RequestId / EnvId / AppID / 地域 / 状态可以保留
  assert.equal(r.callerIdentity.requestId, SYN_REQUEST_STS);
  assert.equal(r.describeEnvInfo.wxAppId, FIXED.wxAppId);
  assert.equal(r.describeEnvs.region, FIXED.region);
  assert.equal(r.callerIdentity.accountIdTail, SYN_ACCOUNT.slice(-4));
});

// ── 7. 成功输出不得越界宣称（L3） ────────────────────────────────────

test('L7-1 正常输出不宣称 SDK 凭据复用 / 平台事务 / 允许名单 / 初始化通过', async () => {
  const r = await runReadOnlyObservation(readyDeps({
    'sts GetCallerIdentity': { stdout: stdoutFor(STAGES[0], stsOk()) },
    'tcb DescribeEnvs': { stdout: stdoutFor(STAGES[1], envsOk()) },
    'tcb DescribeEnvInfo': { stdout: stdoutFor(STAGES[2], envInfoOk()) }
  }));
  const dumped = JSON.stringify(r);
  for (const banned of ['sameCredential', 'credentialsReused', 'sdkVerified', 'atomic',
    'allowlist', 'approvedUserIds', 'initialized', 'deployed', 'enabled']) {
    assert.equal(dumped.includes(banned), false, '输出不得宣称：' + banned);
  }
  assert.match(r.notes, /不证明三次调用使用同一份未刷新的临时凭据/);
  assert.match(r.notes, /未完成数据库 SDK 的同凭据核验/);
  assert.equal(r.status, STATUS.ASSOCIATION_OBSERVED);
});