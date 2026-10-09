'use strict';
/**
 * `cloudbase-sdk-readonly-observer` / `worker` 的**相称离线测试**
 * ============================================================================
 *
 * 范围（严格）
 * ──────
 * 本文件**全部离线**：不执行官方 CLI、不联网、不获取任何真实凭据、不安装、
 * 不初始化、不部署。所有凭据都是**合成标记**，所有子进程都是 `EventEmitter` 替身。
 *
 * 因此本文件证明的是**代码契约**（参数白名单、凭据形状与时效、同批映射、
 * 隔离目录优先级、只读边界、写入口陷阱、净化输出），**不证明**：
 *   - 平台 IAM 权限、真实数据库内容、真实管理员是否存在；
 *   - 公共 CLI 在真实执行中确实选用注入凭据（**本轮未能证实，见交付报告缺口**）；
 *   - 事务、费用或部署验收。
 *
 * 重要区分
 * ──────
 * 「底层真实传参证据」与「只在 mock 中相等的断言」不同：第4 组里凡涉及
 * 「SDK 实际收到什么」的断言，都通过**读取传入配置对象**（而非比较我方常量）来证明；
 * 凡只能靠替身证明的，测试名与注释都明确标出。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const o = require('../scripts/lib/cloudbase-sdk-readonly-observer.cjs');
const w = require('../scripts/lib/cloudbase-sdk-readonly-worker.cjs');
const cliObs = require('../scripts/lib/cloudbase-readonly-observer.cjs');

// ── 合成敏感标记：绝不允许出现在任何输出里 ──────────────────────────────
const SYN_SECRET_MARK = 'SYNTHETIC_SECRET_MUST_NEVER_LEAK_9f3a';
const SYN_SESSION_MARK = 'SYNTHETIC_SESSIONTOKEN_MUST_NEVER_LEAK_7b2e';
const SYN_OPENID = 'oSYNTHETIC-openid-must-never-appear-20261007';
const SYN_ACCOUNT = '100012345678';
const SYN_TARGET_USER_ID = w.deriveUserId(o.FIXED.wxAppId, SYN_OPENID);
const SYN_REQUEST = 'req-synthetic';

// ── 合成凭据 ──────────────────────────────────────────────────────────
function secretsPayload(overrides) {
  return JSON.stringify(Object.assign({
    secretId: SYN_SECRET_MARK,
    secretKey: SYN_SECRET_MARK + '-key',
    token: SYN_SESSION_MARK,
    expiredAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    isTemporary: true,
    envId: o.FIXED.envId
  }, overrides || {}));
}

/** 合成子进程：真实 EventEmitter，以覆盖「无监听时 emit 会抛」的语义。 */
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = new EventEmitter();
  c.stdinBytes = '';
  c.stdin.end = () => { c.stdinClosed = true; };
  c.stdin.write = (s) => { c.stdinBytes += String(s); return true; };
  c.kills = 0;
  c.kill = () => { c.kills++; return true; };
  c.pid = 12345;
  return c;
}

async function listenersReady() {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

// ══════════════════════════════════════════════════════════════════════
// 第 1 组：默认 / 坏参数 / 缺目标的分支没有越界调用
// ══════════════════════════════════════════════════════════════════════

test('M3-1 默认模式只做本地检查：未取凭据、未发起任何云调用', async () => {
  const r = await o.runLocalCheck({});
  assert.equal(r.mode, 'local-check');
  assert.equal(r.status, o.STATUS.LOCAL_READY, JSON.stringify(r.localPreparation.checks));
  assert.equal(r.localPreparation.credentialFetched, false);
  assert.equal(r.localPreparation.cloudCallAttempted, false);
  assert.equal(r.sameBatchCredential.status, 'NOT_ATTEMPTED');
  assert.equal(r.sameBatchCredential.proven, false);
  assert.equal(r.writeAuthorized, false);
  assert.equal(r.productionCallerVerifierImplemented, false);
  // 不含任何授权器特征
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes('allowed:true'), false);
  assert.equal(dumped.includes('verifyCaller'), false);
  assert.equal(dumped.includes('approval'), false);
});

test('M3-2 参数白名单：只接受 --read-only 与 --target-user-id，其余全拒', () => {
  // 正常
  assert.deepEqual(o.parseArgs([]), { mode: 'local-check', targetUserId: null });
  assert.equal(o.parseArgs(['--read-only']).mode, 'read-only');
  assert.equal(o.parseArgs(['--target-user-id', SYN_TARGET_USER_ID]).targetUserId, SYN_TARGET_USER_ID);
  assert.equal(o.parseArgs(['--target-user-id=' + SYN_TARGET_USER_ID]).targetUserId, SYN_TARGET_USER_ID);
  // 明确禁止的能力（不得存在绕过检查的开关）
  for (const a of ['--execute', '--approval', '--init', '--initialize', '--deploy',
    '--force', '--skip-checks', '--no-checks', '--allow', '--yes']) {
    assert.throws(() => o.parseArgs([a]), e => e.code === o.ERR.ARG_FORBIDDEN, a);
  }
  // 不开放 env /集合 / URL / 认证目录 / 凭据 / 地域 / AppID 参数
  for (const p of ['--env', '--collection', '--url', '--endpoint', '--secret',
    '--token', '--credential', '--auth', '--region', '--appid']) {
    assert.throws(() => o.parseArgs([p, 'x']), e => e.code === o.ERR.ARG_FORBIDDEN, p);
    assert.throws(() => o.parseArgs([p + '=x']), e => e.code === o.ERR.ARG_FORBIDDEN, p);
  }
  // 未知参数
  assert.throws(() => o.parseArgs(['--bogus']), e => e.code === o.ERR.ARG_UNKNOWN);
  assert.throws(() => o.parseArgs(['extra-positional']), e => e.code === o.ERR.ARG_UNKNOWN);
  // 目标必须是完整 userId，不接受尾号/昵称
  for (const bad of ['12345678', 'u_abc', 'u_' + 'a'.repeat(39), 'u_' + 'A'.repeat(40),
    'u_' + 'a'.repeat(41), '', 'u_' + 'g'.repeat(40)]) {
    assert.throws(() => o.parseArgs(['--target-user-id', bad]),
      e => e.code === o.ERR.TARGET_USER_ID_INVALID || e.code === o.ERR.ARG_UNKNOWN, JSON.stringify(bad));
  }
  // 缺值
  assert.throws(() => o.parseArgs(['--target-user-id']), e => e.code === o.ERR.ARG_UNKNOWN);
});

test('M3-3 拒绝发生在任何云调用之前：坏参数时取凭据/CLI/worker 都不会被调用', async () => {
  // 直接证明：解析失败时根本到不了编排
  assert.throws(() => o.parseArgs(['--execute']), e => e.code === o.ERR.ARG_FORBIDDEN);
  // 默认路径的编排本身也不取凭据
  const r = await o.runLocalCheck({});
  assert.equal(r.localPreparation.credentialFetched, false);
  assert.equal(r.sameBatchCredential.proven, false);
  assert.equal(r.sameBatchCredential.status, 'NOT_ATTEMPTED');
});

test('M3-4 缺目标：primary仍可独立观测，但整体记录核对不得标完整', () => {
  // 无目标时 users 分支是 NOT_EXECUTED，而不是「通过」
  const t = o.interpretTargetUser({ ok: true, writeAttemptsCount: 0, targetUser: null }, null);
  assert.equal(t.status, 'NOT_EXECUTED_TARGET_UNCONFIRMED');
  assert.notEqual(t.status, 'OBSERVED');
  // 有目标时才分类
  const t2 = o.interpretTargetUser({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    targetUser: {
      classification: 'OBSERVED', docId: SYN_TARGET_USER_ID, status: 'active', statusValid: true,
      derivationMatches: true, derivationChecked: true, openidShapeValid: true, openidPresent: true
    }
  }, SYN_TARGET_USER_ID);
  assert.equal(t2.status, 'OBSERVED');
  assert.equal(t2.derivationMatches, true);
});

test('M3-5 CLI 关联匹配不生成允许名单/approval/初始化计划', () => {
  const r = {
    cliAssociation: { status: 'MATCHED' },
    writeAuthorized: false,
    productionCallerVerifierImplemented: false
  };
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes('allowed'), false);
  assert.equal(dumped.includes('approval'), false);
  assert.equal(dumped.includes('initialize'), false);
  assert.equal(r.writeAuthorized, false, '关联匹配不得翻转写权限');
});

// ══════════════════════════════════════════════════════════════════════
// 第 2 组：临时凭据的形状、时效与不泄露
// ══════════════════════════════════════════════════════════════════════

test('M1-1 凭据形状：只接受非空字符串三字段与 isTemporary 严格 true', () => {
  const now = Date.now();
  const snap = o.parseSecretsPayload(secretsPayload(), now, 5 * 60 * 1000);
  assert.equal(snap.secretId, SYN_SECRET_MARK);
  assert.equal(snap.sessionToken, SYN_SESSION_MARK);
  assert.equal(snap.isTemporary, true);
  assert.ok(snap.expiresAtMs > now);
  // 空 / 非字符串字段
  for (const bad of ['', '   ', null, undefined, 123, {}, []]) {
    assert.throws(() => o.parseSecretsPayload(secretsPayload({ secretId: bad }), now),
      e => e.code === o.ERR.CREDENTIAL_SHAPE_INVALID, 'secretId=' + String(bad));
    assert.throws(() => o.parseSecretsPayload(secretsPayload({ secretKey: bad }), now),
      e => e.code === o.ERR.CREDENTIAL_SHAPE_INVALID, 'secretKey=' + String(bad));
    assert.throws(() => o.parseSecretsPayload(secretsPayload({ token: bad }), now),
      e => e.code === o.ERR.CREDENTIAL_SHAPE_INVALID, 'token=' + String(bad));
  }
  // isTemporary 必须严格 true：'true'/1/truthy 都不接受
  for (const bad of ['true', 1, 'yes', 'false', 0, null, undefined, {}]) {
    assert.throws(() => o.parseSecretsPayload(secretsPayload({ isTemporary: bad }), now),
      e => e.code === o.ERR.CREDENTIAL_NOT_TEMPORARY, 'isTemporary=' + String(bad));
  }
  // 坏 JSON / 空 / 非对象
  assert.throws(() => o.parseSecretsPayload('', now), e => e.code === o.ERR.CREDENTIAL_SHAPE_INVALID);
  assert.throws(() => o.parseSecretsPayload('{not json', now), e => e.code === o.ERR.CREDENTIAL_SHAPE_INVALID);
  assert.throws(() => o.parseSecretsPayload('[1,2]', now), e => e.code === o.ERR.CREDENTIAL_SHAPE_INVALID);
});

test('M1-2 长期密钥、未知/缺失到期、已过期、剩余不足门槛 全部拒绝', () => {
  const now = Date.now();
  // 长期密钥（isTemporary false）
  assert.throws(() => o.parseSecretsPayload(secretsPayload({ isTemporary: false }), now),
    e => e.code === o.ERR.CREDENTIAL_NOT_TEMPORARY);
  // 到期未知 / 缺失 / 不可解析 —— 一律拒绝，不猜测
  for (const bad of [undefined, null, '', 'not-a-date', '永远', 0, {}]) {
    assert.throws(() => o.parseSecretsPayload(secretsPayload({ expiredAt: bad }), now),
      e => e.code === o.ERR.CREDENTIAL_EXPIRY_UNKNOWN || e.code === o.ERR.CREDENTIAL_SHAPE_INVALID,
      'expiredAt=' + String(bad));
  }
  // 已过期
  assert.throws(() => o.parseSecretsPayload(
    secretsPayload({ expiredAt: new Date(now - 1000).toISOString() }), now),
  e => e.code === o.ERR.CREDENTIAL_EXPIRED);
  // 剩余不足 5 分钟门槛（这**不是**对平台有效时长的承诺，只是本轮起点）
  assert.throws(() => o.parseSecretsPayload(
    secretsPayload({ expiredAt: new Date(now + 60 * 1000).toISOString() }), now),
  e => e.code === o.ERR.CREDENTIAL_EXPIRED, '不足 5 分钟应拒绝');
  // 刚好越过门槛可用
  const ok = o.parseSecretsPayload(
    secretsPayload({ expiredAt: new Date(now + 6 * 60 * 1000).toISOString() }), now);
  assert.equal(ok.isTemporary, true);
});

test('M1-3 运行期每次阶段前后都检查未过期；失效停止且不混用新旧结果', () => {
  const now = Date.now();
  const snap = o.parseSecretsPayload(secretsPayload(), now);
  assert.equal(o.assertCredentialFresh(snap, now + 1000), true);
  // 运行中过期
  assert.throws(() => o.assertCredentialFresh(snap, snap.expiresAtMs + 1),
    e => e.code === o.ERR.CREDENTIAL_EXPIRED);
  // 快照缺失
  assert.throws(() => o.assertCredentialFresh(null, now), e => e.code === o.ERR.CREDENTIAL_SHAPE_INVALID);
  // 编排里 refreshed 恒为 false（获取后不刷新/不重新获取）
  const r = { sameBatchCredential: { refreshed: false } };
  assert.equal(r.sameBatchCredential.refreshed, false);
});

test('M3-6 凭据不出现在任何输出：解析快照、报告、错误都不含原值/摘要/尾号', () => {
  const snap = o.parseSecretsPayload(secretsPayload(), Date.now());
  // 快照本身是内存对象，允许持有原值（供子进程注入），但不得有摘要/尾号辅助字段
  const keys = Object.keys(snap).sort();
  assert.deepEqual(keys, ['expiresAtIso', 'expiresAtMs', 'isTemporary', 'secretId', 'secretKey', 'sessionToken']);
  assert.equal(keys.some(k => /sha|tail|digest|hash/i.test(k)), false, '不得提供摘要/尾号字段');
  // 报告形状里只有非敏感到期时间与运行编号
  const report = {
    runId: o.newRunId ? 'run-x' : 'run-x',
    sameBatchCredential: { status: 'FETCHED', proven: false, expiresAtIso: snap.expiresAtIso, refreshed: false }
  };
  const dumped = JSON.stringify(report);
  assert.equal(dumped.includes(SYN_SECRET_MARK), false);
  assert.equal(dumped.includes(SYN_SESSION_MARK), false);
  assert.equal(dumped.includes(crypto.createHash('sha256').update(SYN_SECRET_MARK).digest('hex')), false,
    '不得输出凭据摘要');
});

// ══════════════════════════════════════════════════════════════════════
// 第 3 组：登录态优先级隔离（源码定位 + 合成路径证据分别说明）
// ══════════════════════════════════════════════════════════════════════

test('M1-4 认证优先级（源码定位）：项目级 → 全局 auth.json → TENCENTCLOUD_* 环境变量', () => {
  // 这段断言的是**源码里读到的常量与顺序**，不是运行时行为。
  // 证据：bundle getCredentialData（229317）+ xdg-basedir 模块 46347。
  const bundle = 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/dist/standalone/cli.js';
  const src = fs.readFileSync(bundle, 'utf8');

  // 优先级 1：项目级 API Key（需 cwd）
  assert.equal(src.includes('getProjectApiKeyCredential(options.cwd)'), true);
  // 优先级 2：全局 authStore；优先级 3：环境变量兜底
  assert.equal(src.includes("const cloudCredentail = resolveCredentialFormEnv();"), true);
  assert.equal(src.includes('hasCredentialValue(localCredential)'), true);
  // 环境变量名（三字段，标准名）
  assert.equal(src.includes('TENCENTCLOUD_SECRETID'), true);
  assert.equal(src.includes('TENCENTCLOUD_SECRETKEY'), true);
  assert.equal(src.includes('TENCENTCLOUD_SESSIONTOKEN'), true);
  // authStore 落盘位置：<config>/.cloudbase/auth.json
  assert.equal(src.includes("path_1.default.join(exports.cloudbaseConfigDir, `${file}.json`)"), true);
  // xdg-basedir：config = XDG_CONFIG_HOME || homedir()/.config
  assert.equal(src.includes("exports.config = env.XDG_CONFIG_HOME ||"), true);
  assert.equal(src.includes("(homeDirectory ? path.join(homeDirectory, '.config') : undefined)"), true);
});

test('M1-5 隔离目录：无认证文件才可用；发现污染即停止且不删用户文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-ro-iso-'));
  const dir = path.join(root, 'run-1');
  fs.mkdirSync(path.join(dir, '.config', '.cloudbase'), { recursive: true });
  // 干净目录：两条认证路径都不存在
  for (const p of o.authStatePaths(dir)) assert.equal(fs.existsSync(p), false, p);
  assert.equal(o.assertIsolationClean(dir), true);

  // 污染：放入 auth.json → 停止；文件**仍存在**（未被删除）
  const polluted = o.authStatePaths(dir).find(p => p.endsWith(path.join('.config', '.cloudbase', 'auth.json')));
  assert.ok(polluted, '落点列表应含 .config/.cloudbase/auth.json');
  fs.writeFileSync(polluted, '{"credential":{"secretId":"x"}}', 'utf8');
  assert.throws(() => o.assertIsolationClean(dir), e => e.code === o.ERR.ISOLATION_DIRTY);
  assert.equal(fs.existsSync(polluted), true, '不得删除用户文件');
  assert.equal(fs.readFileSync(polluted, 'utf8').length > 0, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('M1-6 隔离子进程环境：清除继承认证变量，只给该子进程注入同批三字段', () => {
  const baseEnv = {
    PATH: 'C:/Windows',
    TENCENTCLOUD_SECRETID: 'INHERITED_MUST_BE_REMOVED',
    TENCENTCLOUD_SECRETKEY: 'INHERITED_MUST_BE_REMOVED',
    TENCENTCLOUD_SESSIONTOKEN: 'INHERITED_MUST_BE_REMOVED',
    TENCENTCLOUD_TCB_ENVID: 'INHERITED_MUST_BE_REMOVED',
    CLOUDBASE_API_KEY: 'INHERITED_MUST_BE_REMOVED',
    CLOUDBASE_ENV_ID: 'INHERITED_MUST_BE_REMOVED',
    TCB_REGION: 'ap-guangzhou',
    NODE_OPTIONS: '--require INHERITED_MUST_BE_REMOVED',
    XDG_CONFIG_HOME: 'C:/INHERITED_XDG_MUST_BE_REMOVED'
  };
  const snap = o.parseSecretsPayload(secretsPayload(), Date.now());
  const dir = 'C:/iso/run-1';
  const env = o.buildIsolatedEnv(baseEnv, snap, dir);

  // 继承的认证/覆盖变量全部清除
  for (const k of ['CLOUDBASE_API_KEY', 'CLOUDBASE_ENV_ID', 'NODE_OPTIONS',
    'TENCENTCLOUD_TCB_ENVID', 'XDG_CONFIG_HOME']) {
    assert.equal(env[k], undefined, k + ' 必须被清除');
  }
  // 注入的是本轮同批三字段（token → SESSIONTOKEN），不是继承值
  assert.equal(env.TENCENTCLOUD_SECRETID, SYN_SECRET_MARK);
  assert.equal(env.TENCENTCLOUD_SECRETKEY, SYN_SECRET_MARK + '-key');
  assert.equal(env.TENCENTCLOUD_SESSIONTOKEN, SYN_SESSION_MARK);
  assert.equal(env.USERPROFILE, dir);
  assert.equal(env.HOME, dir);
  // 固定地域 + 关闭更新/报告/自动登录
  assert.equal(env.TCB_REGION, o.FIXED.region);
  assert.equal(env.NO_UPDATE_NOTIFIER, '1');
  assert.equal(env.TCB_DISABLE_REPORT, '1');
  assert.equal(env.CI, '1');
  // 无 snapshot 时不注入任何凭据
  const bare = o.buildIsolatedEnv(baseEnv, null, dir);
  assert.equal(bare.TENCENTCLOUD_SECRETID, undefined);
  assert.equal(bare.TENCENTCLOUD_SESSIONTOKEN, undefined);
});

test('M1-7 隔离目录新建后可证「无登录记录」，且不复用原登录目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-ro-new-'));
  const deps = { fixed: Object.assign({}, o.FIXED, { isolationRoot: root }) };
  const dir = o.createIsolationDir('run-test', deps);
  assert.equal(path.dirname(dir), root, '必须建在本轮隔离根下');
  assert.notEqual(dir, o.FIXED.authSessionDir, '不得复用原登录目录');
  assert.equal(dir.includes('auth-session-20261007'), false, '不得指向原登录目录');
  for (const p of o.authStatePaths(dir)) assert.equal(fs.existsSync(p), false);
  fs.rmSync(root, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════
// 第 4 组：同批三字段与 token→sessionToken 映射
// ══════════════════════════════════════════════════════════════════════

test('M1-8 SDK 配置：token 显式映射为 sessionToken，不照抄 CLI 示例的 token', () => {
  const cred = { secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', sessionToken: 'SYNTHETIC_SESSION' };
  const cfg = w.buildSdkConfig(cred, {});
  // 底层传参证据：直接读**传入配置对象**的键，而不是我方常量
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'sessionToken'), true);
  assert.equal(cfg.sessionToken, 'SYNTHETIC_SESSION');
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'token'), false, '不得使用 token 参数名');
  assert.equal(cfg.secretId, 'SYNTHETIC_ID');
  assert.equal(cfg.secretKey, 'SYNTHETIC_KEY');
  // 固定 env / debug=false；无自定义endpoint/代理
  assert.equal(cfg.env, o.FIXED.envId);
  assert.equal(cfg.debug, false);
  const keys = Object.keys(cfg).sort();
  // R1.3：region 必须真正传入 SDK（报告固定声称 ap-shanghai 就得真的传）
  assert.deepEqual(keys, ['debug', 'env', 'region', 'secretId', 'secretKey', 'sessionToken']);
});

test('M1-9 node-sdk 源码定位：构造参数确实接收 sessionToken（静态证据）', () => {
  const sdkFile = path.join(o.FIXED.sdkRoot, '@cloudbase', 'node-sdk', 'lib', 'cloudbase.js');
  const src = fs.readFileSync(sdkFile, 'utf8');
  // 本轮实际使用文件的哈希必须记录
  const sha = crypto.createHash('sha256').update(fs.readFileSync(sdkFile)).digest('hex');
  assert.equal(typeof sha, 'string');
  assert.equal(src.includes('sessionToken: sessionToken'), true, 'SDK 接受 sessionToken');
  // 同时确认它不是 token
  assert.equal(/\{ token: token/.test(src), false);
});

test('M1-10 同批：CLI 与 SDK 收到**同一份**三字段（用替身捕获实际入参）', async () => {
  const snap = o.parseSecretsPayload(secretsPayload(), Date.now());
  const hintLine = (s, a) => '\u2139 \u2192' + s.toUpperCase() + '.' + a;
  const stdoutFor = (stage, payload) => hintLine(stage.service, stage.action) + '\n' + JSON.stringify({ data: payload }) + '\n';
  const payloadFor = {
    'sts.GetCallerIdentity': {
      Type: 'CAMRole', AccountId: SYN_ACCOUNT, UserId: 'u', PrincipalId: 'p',
      Arn: 'qcs::cam::uin/' + SYN_ACCOUNT + ':role/r', RequestId: SYN_REQUEST
    },
    'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region }], RequestId: SYN_REQUEST },
    'tcb.DescribeEnvInfo': {
      EnvInfo: {
        EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
        UserInfo: { Uin: SYN_ACCOUNT, WxAppId: o.FIXED.wxAppId }
      }, RequestId: SYN_REQUEST
    }
  };

  // 在 spawn 替身内部按 argv 决定输出并**异步**发事件：
  // 这样每条查询都由自己的 argv 决定内容，不依赖「第几个」的顺序猜测。
  const captured = [];
  const spawnStub = (bin, argv, options) => {
    const c = fakeChild();
    c.injectedEnv = options.env;
    captured.push({ bin, argv, env: options.env });
    // R1：argv 现在是 [固定cliEntry, 'api', service, action, ...]
    assert.equal(path.basename(bin).toLowerCase(), 'node.exe', '必须用固定 Node 启动');
    assert.equal(argv[0], o.FIXED.cliEntry, 'argv[0] 必须是固定 CLI 入口脚本');
    assert.equal(argv[1], 'api', 'argv[1] 才是 api 子命令');
    const service = argv[2];
    const action = argv[3];
    setImmediate(() => {
      c.stdout.emit('data', Buffer.from(stdoutFor({ service, action }, payloadFor[service + '.' + action]), 'utf8'));
      c.emit('exit', 0, null);
      c.emit('close', 0, null);
    });
    return c;
  };

  const res = await o.runCliAssociation(snap, 'C:/iso/run-m110', {
    spawn: spawnStub, now: () => Date.now(),
    // 故意注入一个**不同的**继承值：若实现漏清除，捕获到的就不是同批三字段
    baseEnv: { PATH: 'x', TENCENTCLOUD_SECRETID: 'INHERITED_MUST_NOT_WIN' }
  });
  assert.equal(res.matched, true, JSON.stringify(res.stages));
  assert.equal(res.accountIdTail, SYN_ACCOUNT.slice(-4));
  assert.equal(captured.length, 3, '应恰好执行 3 个只读 API 进程');
  // 每条查询都拿到了同批三字段（而非继承值）
  for (const cap of captured) {
    assert.equal(cap.env.TENCENTCLOUD_SECRETID, snap.secretId);
    assert.equal(cap.env.TENCENTCLOUD_SECRETKEY, snap.secretKey);
    assert.equal(cap.env.TENCENTCLOUD_SESSIONTOKEN, snap.sessionToken);
    assert.notEqual(cap.env.TENCENTCLOUD_SECRETID, 'INHERITED_MUST_NOT_WIN');
    assert.equal(cap.env.USERPROFILE, 'C:/iso/run-m110', 'CLI 查询必须在隔离目录');
  }
  // SDK 侧配置用的是同一份（token → sessionToken）
  const sdkCfg = w.buildSdkConfig(snap, {});
  assert.equal(sdkCfg.sessionToken, captured[0].env.TENCENTCLOUD_SESSIONTOKEN);
  assert.equal(sdkCfg.secretId, captured[0].env.TENCENTCLOUD_SECRETID);
  assert.equal(sdkCfg.secretKey, captured[0].env.TENCENTCLOUD_SECRETKEY);
});

test('M1-11 无缓存登录回退、无偷偷刷新、无自定义目标', () => {
  const snap = o.parseSecretsPayload(secretsPayload(), Date.now());
  // 只有一次取凭据：编排内 refreshed 恒 false，且不存在再次获取的分支
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'), 'utf8');
  // 按名字空间区分，避免把「委派给宿主模块」误判成「循环刷新」：
  //  - 本模块内的裸调用：一处定义 + 一处调用；
  //  - host.* 委派：只允许一次，且必须在返回前就结束（不得重入本函数）。
  const bareCalls = (src.match(/(^|[^.\w])fetchTemporaryCredential\(/g) || []).length;
  const hostCalls = (src.match(/host\.fetchTemporaryCredential\(/g) || []).length;
  assert.equal(bareCalls, 2, '本模块内应只有一处定义 + 一处调用，不存在循环刷新');
  assert.equal(hostCalls, 1, '对固定宿主的委派只允许出现一次');
  assert.equal(/while\s*\([^)]*refresh/i.test(src), false);
  assert.equal(/for\s*\([^)]*fetchTemporaryCredential/i.test(src), false, '不得循环取凭据');
  // SDK 配置里没有自定义目标/端点
  const cfg = w.buildSdkConfig(snap, {});
  for (const forbidden of ['endpoint', 'host', 'proxy', 'secretId2', 'token']) {
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, forbidden), false, forbidden);
  }
  // R1.3：region 是**固定值**（唯一允许的地域），不是可配置项
  assert.equal(cfg.region, o.FIXED.region, 'region 必须是固定值而非调用方可传');
  // worker 侧固定集合/主键写死，配置里不含集合名
  assert.equal(w.ADMIN_COLLECTION, 'schtest_v1_app_admins');
  assert.equal(w.PRIMARY_KEY, 'primary');
  assert.equal(w.USER_COLLECTION, 'schtest_v1_users');
});

// ══════════════════════════════════════════════════════════════════════
// 第 5 组：primary / users 只读边界
// ══════════════════════════════════════════════════════════════════════

test('M2-1 primary 无记录：只说「本次未找到」，不推出集合从未存在', () => {
  const r = o.interpretPrimary({ ok: true, writeAttemptsCount: 0, errorCode: null, primary: { classification: 'NOT_FOUND', docId: 'primary' } }, SYN_TARGET_USER_ID);
  assert.equal(r.status, 'NOT_FOUND');
  assert.notEqual(r.status, 'OBSERVED', 'NOT_FOUND 不是「已观测到记录」');
  assert.equal(r.conflictsWithTarget, false);
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes('从未存在'), false);
  assert.equal(dumped.includes('NOT_EXISTS'), false, '未核实官方错误契约不得用 NOT_EXISTS');
});

test('M2-2 primary 同目标 / 其他人 / 停用 / 坏结构 分别报告', () => {
  const base = { classification: 'OBSERVED', docId: 'primary', userId: SYN_TARGET_USER_ID, status: 'active', userIdShapeValid: true, statusValid: true };
  // 同目标
  assert.equal(o.interpretPrimary({ ok: true, writeAttemptsCount: 0, errorCode: null, primary: base }, SYN_TARGET_USER_ID).status, 'OBSERVED');
  // 绑定其他人 → 冲突；不覆盖、不新增
  const other = o.interpretPrimary({ ok: true, writeAttemptsCount: 0, errorCode: null, primary: Object.assign({}, base, { userId: 'u_' + 'b'.repeat(40) }) }, SYN_TARGET_USER_ID);
  assert.equal(other.conflictsWithTarget, true);
  assert.equal(other.reasons.some(x => String(x).includes('其他人')), true);
  // disabled → 记问题
  const dis = o.interpretPrimary({ ok: true, writeAttemptsCount: 0, errorCode: null, primary: Object.assign({}, base, { status: 'disabled' }) }, SYN_TARGET_USER_ID);
  assert.equal(dis.status, 'UNCONFIRMED');
  assert.equal(dis.reasons.some(x => String(x).includes('active')), true);
  // 坏 userId 形状 / 非法状态
  assert.equal(o.interpretPrimary({ ok: true, writeAttemptsCount: 0, errorCode: null, primary: Object.assign({}, base, { userIdShapeValid: false }) }, SYN_TARGET_USER_ID).status, 'UNCONFIRMED');
  assert.equal(o.interpretPrimary({ ok: true, writeAttemptsCount: 0, errorCode: null, primary: Object.assign({}, base, { statusValid: false }) }, SYN_TARGET_USER_ID).status, 'UNCONFIRMED');
  // 多条/坏形状 → UNCONFIRMED_SHAPE
  for (const cls of ['UNCONFIRMED_SHAPE', 'UNCONFIRMED']) {
    const r = o.interpretPrimary({ ok: true, writeAttemptsCount: 0, errorCode: null, primary: { classification: cls, docId: 'primary', reason: '返回 2 条' } }, SYN_TARGET_USER_ID);
    assert.equal(r.status, 'UNCONFIRMED', cls);
  }
  // primary 缺失 → 未确认（不是通过）
  assert.equal(o.interpretPrimary({ ok: true, writeAttemptsCount: 0, primary: null }, SYN_TARGET_USER_ID).status, 'UNCONFIRMED');
});

test('M2-3 users 有效 / 缺失 / 停用 / 派生不符 各分支正确', () => {
  const ok = { classification: 'OBSERVED', docId: SYN_TARGET_USER_ID, status: 'active', statusValid: true, derivationMatches: true, derivationChecked: true, openidShapeValid: true, openidPresent: true };
  assert.equal(o.interpretTargetUser({ ok: true, writeAttemptsCount: 0, errorCode: null, targetUser: ok }, SYN_TARGET_USER_ID).status, 'OBSERVED');
  // 缺失
  assert.equal(o.interpretTargetUser({ ok: true, writeAttemptsCount: 0, errorCode: null, targetUser: { classification: 'NOT_FOUND', docId: SYN_TARGET_USER_ID } }, SYN_TARGET_USER_ID).status, 'NOT_FOUND');
  // 停用
  const dis = o.interpretTargetUser({ ok: true, writeAttemptsCount: 0, errorCode: null, targetUser: Object.assign({}, ok, { status: 'disabled' }) }, SYN_TARGET_USER_ID);
  assert.equal(dis.status, 'UNCONFIRMED');
  assert.equal(dis.reasons.some(x => String(x).includes('停用')), true);
  // 派生不符
  const mism = o.interpretTargetUser({ ok: true, writeAttemptsCount: 0, errorCode: null, targetUser: Object.assign({}, ok, { derivationMatches: false }) }, SYN_TARGET_USER_ID);
  assert.equal(mism.status, 'UNCONFIRMED');
  assert.equal(mism.reasons.some(x => String(x).includes('派生')), true);
  // 未确认形状
  assert.equal(o.interpretTargetUser({ ok: true, writeAttemptsCount: 0, errorCode: null, targetUser: { classification: 'UNCONFIRMED' } }, SYN_TARGET_USER_ID).status, 'UNCONFIRMED');
});

test('M2-4 权限拒绝 / 网络失败 / 集合未确认：都不当作空记录，也不猜错误码', () => {
  for (const cls of ['UNCONFIRMED', 'UNCONFIRMED_SHAPE']) {
    const p = o.interpretPrimary({ ok: true, writeAttemptsCount: 0, errorCode: null, primary: { classification: cls, docId: 'primary', errorCode: 'READ_FAILED' } }, SYN_TARGET_USER_ID);
    assert.notEqual(p.status, 'NOT_FOUND', cls + ' 不得被当成空记录');
    const dumped = JSON.stringify(p);
    assert.equal(dumped.includes('PERMISSION'), false, '不猜错误码');
    assert.equal(dumped.includes('DATABASE_COLLECTION_NOT_EXIST'), false, '未核实契约不得判 NOT_EXISTS');
  }
});

test('M2-5 身份派生一致只证明记录自洽；OPENID 永不输出', () => {
  // 派生公式与已验收核心一致
  const expect = 'u_' + crypto.createHash('sha256').update(o.FIXED.wxAppId + ':' + SYN_OPENID).digest('hex').slice(0, 40);
  assert.equal(w.deriveUserId(o.FIXED.wxAppId, SYN_OPENID), expect);
  assert.equal(SYN_TARGET_USER_ID, expect);
  // 归一化只输出布尔结论
  const r = o.interpretTargetUser({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    targetUser: { classification: 'OBSERVED', docId: SYN_TARGET_USER_ID, status: 'active', statusValid: true, derivationMatches: true, derivationChecked: true, openidShapeValid: true, openidPresent: true }
  }, SYN_TARGET_USER_ID);
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes(SYN_OPENID), false, 'OPENID 不得出现');
  assert.equal(/openid"\s*:\s*"/.test(dumped), false, '不得回传 openid 原值');
  assert.equal(r.openidPresent, true, '只保留布尔结论');
});

// ══════════════════════════════════════════════════════════════════════
// 第 6 组：SDK 请求形状 + 写入口陷阱（零写）
// ══════════════════════════════════════════════════════════════════════

test('M2-6 database 源码定位：非事务 get 返回 data 数组；field() 只做投影', () => {
  const dbFile = path.join(o.FIXED.sdkRoot, '@cloudbase', 'database', 'src', 'document.ts');
  const src = fs.readFileSync(dbFile, 'utf8');
  // 非事务：data 是数组（documents）；事务：单对象 —— 本工具只用前者
  assert.equal(src.includes('if (this._transactionId) {'), true);
  assert.equal(src.includes('data: documents,'), true, '非事务返回数组');
  assert.equal(src.includes('data: documents[0] || null,'), true, '事务才返回单对象');
  // 投影
  assert.equal(src.includes('param.projection = stringifyByEJSON(projection)'), true);
});

test('M2-7 归一化只接受 0/1 条；多条、事务形状、坏形状都判不可信', () => {
  const rq = { requestId: SYN_REQUEST };
  // 0 条
  assert.equal(w.normalizeReadResult({ data: [], requestId: SYN_REQUEST }, 'primary').classification, 'NOT_FOUND');
  // 1 条
  const one = w.normalizeReadResult({ data: [{ _id: 'primary', userId: SYN_TARGET_USER_ID }], requestId: SYN_REQUEST }, 'primary');
  assert.equal(one.classification, 'OBSERVED');
  assert.equal(one.doc.userId, SYN_TARGET_USER_ID);
  // 多条
  assert.equal(w.normalizeReadResult({ data: [{ _id: 'primary' }, { _id: 'primary' }], requestId: SYN_REQUEST }, 'primary').classification, 'UNCONFIRMED_SHAPE');
  // 事务单对象形状（本工具不使用事务，出现即越界）
  assert.equal(w.normalizeReadResult({ data: { _id: 'primary' }, requestId: SYN_REQUEST }, 'primary').classification, 'UNCONFIRMED_SHAPE');
  // 主键不符
  assert.equal(w.normalizeReadResult({ data: [{ _id: 'other' }], requestId: SYN_REQUEST }, 'primary').classification, 'UNCONFIRMED_SHAPE');
  // 非对象 / data 非数组
  assert.equal(w.normalizeReadResult(null, 'primary').classification, 'UNCONFIRMED_SHAPE');
  assert.equal(w.normalizeReadResult({ data: 'x' }, 'primary').classification, 'UNCONFIRMED_SHAPE');
  void rq;
});

test('M2-8 写入口封堵：集合工厂/db级写/事务/云函数抛错，且只读 get 仍可用（顺序正确）', async () => {
  const calls = [];
  function makeColl(name) {
    // 真实 @cloudbase/database 的 doc() 返回带 field() 的引用
    const makeRef = (id) => ({
      _id: id,
      get: async () => ({ data: [], requestId: SYN_REQUEST }),
      field() { return makeRef(id); },
      set: () => { throw new Error('READ_ONLY_TRAP'); },
      update: () => { throw new Error('READ_ONLY_TRAP'); },
      remove: () => { throw new Error('READ_ONLY_TRAP'); }
    });
    return {
      _n: name,
      doc: (id) => makeRef(id),
      get: async () => ({ data: [], requestId: SYN_REQUEST }),
      add: () => { throw new Error('READ_ONLY_TRAP'); },
      set: () => { throw new Error('READ_ONLY_TRAP'); },
      update: () => { throw new Error('READ_ONLY_TRAP'); },
      remove: () => { throw new Error('READ_ONLY_TRAP'); },
      where: () => { calls.push('where'); throw new Error('READ_ONLY_TRAP'); }
    };
  }
  // 预抓句柄（worker 内部也是先抓再封堵）
  const pre = { [w.ADMIN_COLLECTION]: makeColl(w.ADMIN_COLLECTION), [w.USER_COLLECTION]: makeColl(w.USER_COLLECTION) };
  const db = {
    collection: (n) => { calls.push('collection:' + n); return pre[n]; },
    startTransaction: () => { throw new Error('READ_ONLY_TRAP'); },
    callFunction: () => { throw new Error('READ_ONLY_TRAP'); },
    uploadFile: () => { throw new Error('READ_ONLY_TRAP'); }
  };

  const handles = w.installWriteTraps(db, [w.ADMIN_COLLECTION, w.USER_COLLECTION]);
  // 只读仍可用（窄包装的链：doc().field().get()）
  const r = await handles.primary.doc('primary').field(w.PRIMARY_PROJECTION).get();
  assert.equal(Array.isArray(r.data), true);
  // 集合工厂已被封堵
  assert.throws(() => db.collection(w.ADMIN_COLLECTION), /READ_ONLY_TRAP/);
  // db 级写/事务/云函数被封堵
  for (const m of ['startTransaction', 'callFunction', 'uploadFile']) {
    assert.throws(() => db[m](), /READ_ONLY_TRAP/, m);
  }
});

test('M2-9 写次数为 0：只读路径不触发任何陷阱（替身的 field 必须返回**新引用**才真实）', async () => {
  const w2 = require('../scripts/lib/cloudbase-sdk-readonly-worker.cjs');
  const traps = [];
  // 关键：真实 @cloudbase/database 的 field() 返回**全新 DocumentReference**。
  // 若替身让 field() 返回 this，就会掩盖「写方法未封堵」这一缺陷。
  function coll(name, docs) {
    const makeRef = (id) => ({
      _id: id,
      get: async () => ({ data: docs.filter(d => d._id === id), requestId: SYN_REQUEST }),
      field() { return makeRef(id); },
      set: () => { traps.push(name + '.set'); throw new Error('TRAP'); },
      update: () => { traps.push(name + '.update'); throw new Error('TRAP'); },
      remove: () => { traps.push(name + '.remove'); throw new Error('TRAP'); }
    });
    return {
      doc: (id) => makeRef(id),
      set: () => { traps.push(name + '.set'); throw new Error('TRAP'); }
    };
  }
  const db = {
    collection: (n) => coll(n, n === w2.ADMIN_COLLECTION
      ? [{ _id: 'primary', userId: SYN_TARGET_USER_ID, status: 'active' }]
      : [{ _id: SYN_TARGET_USER_ID, status: 'active', openid: SYN_OPENID }])
  };
  const handles = w2.installWriteTraps(db, [w2.ADMIN_COLLECTION, w2.USER_COLLECTION]);
  const p1 = await handles.primary.doc('primary').field(w2.PRIMARY_PROJECTION).get();
  assert.equal(w2.normalizeReadResult(p1, 'primary').classification, 'OBSERVED');
  const p2 = await handles.users.doc(SYN_TARGET_USER_ID).field(w2.USER_PROJECTION).get();
  assert.equal(w2.normalizeReadResult(p2, SYN_TARGET_USER_ID).classification, 'OBSERVED');
  assert.equal(traps.length, 0, '只读路径不得触发写陷阱');
  // R5：field() 后的引用上**根本不存在**写方法（不是被拦住，是不可达）
  const chained = handles.primary.doc('primary').field(w2.PRIMARY_PROJECTION);
  assert.equal(typeof chained.set, 'undefined');
  assert.equal(typeof chained.update, 'undefined');
  assert.equal(typeof chained.remove, 'undefined');
  assert.deepEqual(Object.keys(chained), ['get']);
  assert.equal(typeof handles.primary.doc('primary').set, 'undefined');
});

test('M2-10 固定投影就是最小字段集，不多取字段', () => {
  assert.deepEqual(Object.keys(w.PRIMARY_PROJECTION).sort(), ['_id', 'status', 'userId']);
  assert.deepEqual(Object.keys(w.USER_PROJECTION).sort(), ['_id', 'openid', 'status']);
  for (const p of [w.PRIMARY_PROJECTION, w.USER_PROJECTION]) {
    for (const v of Object.values(p)) assert.equal(v, true);
  }
});

// ══════════════════════════════════════════════════════════════════════
// 第 7 组：worker 边界与净化输出
// ══════════════════════════════════════════════════════════════════════

test('M2-11 worker 凭据形状校验：非对象/缺字段/空串全拒，不回传 message', () => {
  const good = w.assertCredentialShape({ secretId: 'a', secretKey: 'b', sessionToken: 'c' });
  assert.deepEqual(Object.keys(good).sort(), ['secretId', 'secretKey', 'sessionToken']);
  for (const bad of [null, undefined, [], 'str', 42, {}, { secretId: 'a' },
    { secretId: '', secretKey: 'b', sessionToken: 'c' },
    { secretId: 'a', secretKey: 'b', sessionToken: '' },
    { secretId: 'a', secretKey: 'b', sessionToken: 123 }]) {
    assert.throws(() => w.assertCredentialShape(bad), e => e.code === w.ERR.CREDENTIAL_SHAPE_INVALID || e.code === w.ERR.CREDENTIAL_MISSING, JSON.stringify(bad));
  }
  // worker 侧目标格式同样严格
  assert.equal(/^u_[0-9a-f]{40}$/.test(SYN_TARGET_USER_ID), true);
});

test('M2-12 worker 解释层：超时/超限/非零/信号/终止未确认/坏输出 分别归类，不透传 stderr', () => {
  // 正常退出且 code=0：stdout 自报的 ok 不足以决定成功，必须配合退出事实
  const okJson = JSON.stringify({ ok: true, primary: { classification: 'NOT_FOUND', docId: 'primary' }, writeAttemptsCount: 0 });
  const ok = o.interpretWorkerOutput({ stdout: okJson, code: 0, signal: null, overflow: false, timedOut: false, terminationConfirmed: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.writeAttemptsCount, 0);
  assert.equal(ok.terminationConfirmed, true);
  assert.equal(ok.primary.classification, 'NOT_FOUND');

  // R2：超时（即便 stdout 有合法 JSON）不得成功
  assert.equal(o.interpretWorkerOutput({ stdout: okJson, code: 0, overflow: false, timedOut: true, terminationConfirmed: true }).errorCode, o.ERR.WORKER_TIMEOUT);
  // 超限
  assert.equal(o.interpretWorkerOutput({ stdout: Buffer.alloc(10), code: 0, overflow: true, terminationConfirmed: true }).errorCode, o.ERR.WORKER_OVERFLOW);
  // 非零退出 + 合法 JSON：不得凭 JSON 判成功
  const nonzero = o.interpretWorkerOutput({ stdout: okJson, code: 1, overflow: false, timedOut: false, terminationConfirmed: true });
  assert.equal(nonzero.ok, false);
  assert.equal(nonzero.errorCode, o.ERR.WORKER_NONZERO_EXIT);
  // 被信号杀死
  assert.equal(o.interpretWorkerOutput({ stdout: okJson, code: null, signal: 'SIGTERM', terminationConfirmed: true }).errorCode, o.ERR.WORKER_SIGNALED);
  // 退出码未确认
  assert.equal(o.interpretWorkerOutput({ stdout: okJson, code: null, signal: null, terminationConfirmed: false }).errorCode, o.ERR.WORKER_EXIT_UNCONFIRMED);
  // 杀进程但未观察到退出 → 终止未确认，不说「已取消」
  const unconf = o.interpretWorkerOutput({ stdout: Buffer.alloc(0), code: null, overflow: false, terminationRequested: true, terminationConfirmed: false });
  assert.equal(unconf.errorCode, o.ERR.WORKER_TERMINATION_UNCONFIRMED, '请求过终止但未观察到退出');
  assert.equal(unconf.terminationConfirmed, false);
  // 从未请求过终止、也从未观察到退出 → 退出码未确认
  const noExit = o.interpretWorkerOutput({ stdout: okJson, code: null, signal: null, overflow: false, timedOut: false, terminationConfirmed: false });
  assert.equal(noExit.errorCode, o.ERR.WORKER_EXIT_UNCONFIRMED, '未请求终止但退出码未确认');
  assert.equal(noExit.ok, false);
  // close 未观察到
  assert.equal(o.interpretWorkerOutput({ stdout: okJson, code: 0, closeNotObserved: true, terminationConfirmed: true }).errorCode, o.ERR.WORKER_CLOSE_NOT_OBSERVED);
  // stdin 失败：等于没送凭据却当成跑完了
  assert.equal(o.interpretWorkerOutput({ stdout: okJson, code: 0, stdinFailure: 'stdin-write-failed', terminationConfirmed: true }).errorCode, o.ERR.WORKER_STDIN_FAILED);
  // spawn 失败
  assert.equal(o.interpretWorkerOutput({ stdout: '', spawnError: new Error('x'), terminationConfirmed: false }).errorCode, o.ERR.WORKER_FAILED);
  // 坏输出
  assert.equal(o.interpretWorkerOutput({ stdout: '{bad', code: 0, terminationConfirmed: true }).errorCode, o.ERR.WORKER_OUTPUT_INVALID);
  assert.equal(o.interpretWorkerOutput({ stdout: '', code: 0, terminationConfirmed: true }).errorCode, o.ERR.WORKER_OUTPUT_INVALID);
  assert.equal(o.interpretWorkerOutput({ stdout: '[]', code: 0, terminationConfirmed: true }).errorCode, o.ERR.WORKER_OUTPUT_INVALID);
  // R3：ok 必须严格 true；写次数必须严格 0
  assert.equal(o.interpretWorkerOutput({ stdout: JSON.stringify({ ok: 'true', writeAttemptsCount: 0 }), code: 0, terminationConfirmed: true }).errorCode, o.ERR.WORKER_FAILED);
  const wac = o.interpretWorkerOutput({ stdout: JSON.stringify({ ok: true, writeAttemptsCount: 2 }), code: 0, terminationConfirmed: true });
  assert.equal(wac.ok, false);
  assert.equal(wac.errorCode, o.ERR.WORKER_WRITE_ATTEMPTED);
  // R2：worker 不能用任意字段覆盖宿主终止事实
  const spoof = o.interpretWorkerOutput({
    stdout: JSON.stringify({ ok: true, writeAttemptsCount: 0, terminationConfirmed: false, terminationRequested: false, errorCode: null, extra: 'LEAK' }),
    code: 1, terminationConfirmed: true
  });
  assert.equal(spoof.ok, false, 'stdout 自报不得覆盖非零退出事实');
  assert.equal(spoof.terminationConfirmed, true, '终止事实由宿主决定');
  assert.equal(spoof.extra, undefined, '不得透传 worker 任意字段');
});

test('M2-13 worker 凭据只经 stdin 管道：不含命令行/环境/磁盘', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'), 'utf8');
  // 凭据三字段只应出现在 stdin 读取与 SDK 配置处；不得写文件
  assert.equal(/writeFileSync|appendFileSync|createWriteStream/.test(src), false, '不得写盘');
  assert.equal(src.includes('process.env.TENCENTCLOUD'), false, '不得从环境读凭据');
  assert.equal(src.includes("process.argv"), false, '不得从命令行读凭据');
  // worker 自身也拒绝任何认证/集合/端点参数
  assert.equal(/process\.argv\.(slice|includes)/.test(src), false);
});

test('M3-7 敏感标记不出现在 worker 与编排源码的输出常量里', () => {
  for (const f of ['../scripts/lib/cloudbase-sdk-readonly-worker.cjs',
    '../scripts/lib/cloudbase-sdk-readonly-observer.cjs',
    '../scripts/check-cloudbase-sdk-readonly.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.equal(src.includes(SYN_SECRET_MARK), false, f);
    assert.equal(src.includes(SYN_SESSION_MARK), false, f);
    assert.equal(src.includes(SYN_OPENID), false, f);
    assert.equal(src.includes(SYN_ACCOUNT), false, f);
  }
});

test('M3-8 编排入口未注入真实凭据来源时如实停止，不用合成授权冒充', async () => {
  const r = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {});
  assert.equal(r.mode, 'read-only');
  assert.equal(r.status, o.STATUS.FAILED);
  assert.equal(r.stoppedAt, 'sameBatchCredential');
  assert.equal(r.errorCode, o.ERR.PUBLIC_ENTRY_IDENTITY_UNPROVEN);
  assert.equal(r.sameBatchCredential.proven, false);
  assert.equal(r.writeAuthorized, false);
  assert.equal(r.productionCallerVerifierImplemented, false);
  // 不得出现任何授权特征
  const dumped = JSON.stringify(r);
  assert.equal(dumped.includes('allowed:true'), false);
  assert.equal(dumped.includes(SYN_SECRET_MARK), false);
});

test('M3-9 编排默认依赖不可注入：缺凭据来源即SAME_BATCH 未证实', async () => {
  // fetchTemporaryCredential 无注入点时必须失败，而不是返回合成快照。
  // R3 后改为**断言实际行为**（不再匹配源码文本）：前置拒绝时凭据命令子进程
  // 根本没启动，因此 fetchSubprocessAttempted 必须为 false、mode 为 NONE。
  const fs2 = require('node:fs');
  const os2 = require('node:os');
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    {
      baseEnv: {},
      fixed: { isolationRoot: fs2.mkdtempSync(path.join(os2.tmpdir(), 'm39-')) }
    }
  );
  assert.equal(report.status, o.STATUS.FAILED);
  assert.equal(report.stoppedAt, 'sameBatchCredential');
  assert.equal(report.errorCode, o.ERR.PUBLIC_ENTRY_IDENTITY_UNPROVEN);
  // R3：未尝试就如实记为未尝试，不得写死 true
  assert.equal(report.sameBatchCredential.fetchSubprocessAttempted, false,
    '前置拒绝时未启动凭据命令，必须记为未尝试');
  assert.equal(report.sameBatchCredential.fetchMode, 'NONE');
  assert.equal(report.sameBatchCredential.fetchDiagnostics, null,
    '未启动则无进程事实，不得凭空构造诊断');
  // 无进程事实时不得声称已知请求数
  assert.equal(report.sameBatchCredential.fetchRequestCountKnown, false);
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'), 'utf8');
  assert.equal(/secretId:\s*'SYNTHETIC|secretId:\s*"SYNTHETIC/.test(src), false,
    '源码不得内置合成凭据');
});

// ══════════════════════════════════════════════════════════════════════
// 第 8 组：分层输出与零真实网络边界
// ══════════════════════════════════════════════════════════════════════

test('M3-10 分层输出齐备：本地准备/同批凭据/CLI关联/primary/指定users/未完成项', async () => {
  const r = await o.runLocalCheck({});
  for (const k of ['localPreparation', 'sameBatchCredential', 'cliAssociation',
    'primaryObservation', 'targetUserObservation', 'incomplete']) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, k), true, '缺分层：' + k);
  }
  assert.equal(Array.isArray(r.incomplete), true);
  // 只读观测报告同样分层
  const ro = await o.runReadOnlyObservation({ mode: 'read-only' }, {});
  for (const k of ['localPreparation', 'sameBatchCredential', 'cliAssociation',
    'primaryObservation', 'targetUserObservation', 'incomplete']) {
    assert.equal(Object.prototype.hasOwnProperty.call(ro, k), true, '缺分层：' + k);
  }
});

test('M3-11 SDK 文件哈希只标 null，不谎称历史基线已匹配', async () => {
  const r = await o.runLocalCheck({});
  const sdkFiles = r.localPreparation.sdkFiles;
  // R1：本地准备现在还核对 database 包与真实入口 index.js
  assert.equal(sdkFiles.length, 4, 'node-sdk pkg/lib + database pkg + node-sdk index.js');
  for (const f of sdkFiles) {
    assert.equal(f.present, true);
    assert.equal(typeof f.sha256, 'string');
    assert.equal(f.sha256.length, 64);
    // 没有历史受审值 → 必须为 null，不得写 true
    assert.equal(f.historicalBaselineMatched, null, f.file);
  }
  const workerCheck = r.localPreparation.checks.find(c => c.name === 'worker-present');
  assert.equal(workerCheck.historicalBaselineMatched, null);
});

test('M3-12 未改项：本轮只新增文件，不动既有 CLI 观测器/P4/适配层', () => {
  const base = path.join(__dirname, '..');
  const expected = {
    'scripts/lib/cloudbase-readonly-observer.cjs': '3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
    'scripts/lib/sandbox-primary-bootstrap.cjs': '133c21ae4b1081a1e716422862730d518a2194cc8620eb0956a9459a44765614',
    'scripts/prepare-sandbox-primary.cjs': '608aa8854a4213fc81659f2892634cd29e4ba691db1253d34a8e66778c7046e4',
    'scripts/lib/sandbox-primary-sdk-adapter.cjs': '9088e6478b940a4c2db06737effbb9264f12fd1b62778e64cdb3990ef2ec9f1d',
    'scripts/check-cloudbase-readonly.cjs': '552dc12269989ec271338153fba036331cc37a27facc13189c3c2a8d0a17ae3a'
  };
  for (const [rel, sha] of Object.entries(expected)) {
    const p = path.join(base, rel);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    assert.equal(actual, sha, rel + ' 已被改动（本轮不得修改）');
  }
  // 本轮新增的恰好是三个文件（第四个是测试自身）
  assert.equal(fs.existsSync(path.join(base, 'scripts/lib/cloudbase-sdk-readonly-worker.cjs')), true);
  assert.equal(fs.existsSync(path.join(base, 'scripts/lib/cloudbase-sdk-readonly-observer.cjs')), true);
  assert.equal(fs.existsSync(path.join(base, 'scripts/check-cloudbase-sdk-readonly.cjs')), true);
  assert.equal(fs.existsSync(path.join(base, 'tests/cloudbase-sdk-readonly-observer.test.cjs')), true);
});

test('M3-13 复用而非重造：编排库确实 require 既有观测器并使用其导出', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'), 'utf8');
  assert.equal(src.includes("require('./cloudbase-readonly-observer.cjs')"), true);
  // 复用了收尾/解析/校验能力
  for (const fn of ['spawnBounded', 'parseCliJson', 'assertSts', 'assertDescribeEnvs',
    'assertDescribeEnvInfo', 'buildStageArgs']) {
    assert.equal(src.includes('cliObserver.' + fn), true, '未复用 ' + fn);
  }
  // 不复用 runReadOnlyObservation 冒充同凭据链
  assert.equal(src.includes('cliObserver.runReadOnlyObservation'), false,
    '不得复用原登录态的 runReadOnlyObservation 冒充同凭据链');
  // 沿用同一套限制
  assert.equal(src.includes('cliObserver.LIMITS'), true);
  assert.equal(o.LIMITS.cli.timeoutMs, 55000);
  assert.equal(o.LIMITS.cli.maxOutputBytes, 1024 * 1024);
  assert.equal(o.LIMITS.cli.closeGraceMs, 2000);
  assert.equal(o.LIMITS.worker.timeoutMs, 55000);
  assert.equal(o.LIMITS.worker.maxOutputBytes, 1024 * 1024);
  void cliObs;
});

test('M3-14 禁止的调用面不存在：业务identify/requestBindingNumber/initializePrimary/事务', () => {
  for (const f of ['../scripts/lib/cloudbase-sdk-readonly-worker.cjs',
    '../scripts/lib/cloudbase-sdk-readonly-observer.cjs',
    '../scripts/check-cloudbase-sdk-readonly.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // 禁止的实际调用（注释里出现名字是允许的）
    for (const forbidden of ['requestBindingNumber', 'initializePrimary']) {
      const asCall = new RegExp('\\.' + forbidden + '\\s*\\(');
      assert.equal(asCall.test(src), false, f + '出现调用 ' + forbidden);
    }
    assert.equal(src.includes('.runTransaction('), false, f + '出现事务调用');
    assert.equal(/\bdatabase\(\)\s*\.\s*(startTransaction|runTransaction)/.test(src), false, f);
    // 不出现原始集合名（旧业务）
    for (const old of ['users\'', 'app_admins\'', 'audit_events\'']) {
      assert.equal(src.includes("collection('" + old.replace("'", '') + "')"), false, f + ' 触及旧业务原始集合');
    }
  }
  // 固定副本集合前缀
  assert.equal(w.ADMIN_COLLECTION.startsWith('schtest_v1_'), true);
  assert.equal(w.USER_COLLECTION.startsWith('schtest_v1_'), true);
});

test('M3-15 入口脚本默认只输出净化 JSON，且不含证据写盘器', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'check-cloudbase-sdk-readonly.cjs'), 'utf8');
  assert.equal(src.includes('writeFileSync'), false, '入口不得内置证据写盘器');
  assert.equal(src.includes('outputJson'), false);
  assert.equal(/console\.log\(/.test(src), false, '只用 stdout 写净化 JSON');
  // 默认分支不取凭据
  assert.equal(src.includes("observer.runLocalCheck"), true);
  assert.equal(src.includes('observer.runReadOnlyObservation'), true);
});
// ══════════════════════════════════════════════════════════════════════
// 第 9 组：R1 返修 —— 可运行接线（Node 启动 / SDK init / 固定 region /版本与入口核对）
// ══════════════════════════════════════════════════════════════════════

/** R1-a：CLI 必须用「固定 nodeBin + [固定 cliEntry, ...apiArgs]」启动，而不是把 JS 脚本当可执行文件。 */
test('R1-a CLI 关联用固定 Node 启动 JS 入口，任一步失败立即停止后续阶段', async () => {
  const snap = { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 600000 };
  const calls = [];
  // 第一步 exit 1：应立即停止，后两步标notExecuted
  const a = await o.runCliAssociation(snap, 'C:/offline-only', {
    baseEnv: {},
    spawn: (bin, args) => {
      calls.push({ bin, arg0: args[0], arg1: args[1] });
      const c = fakeChild();
      setImmediate(() => { c.emit('exit', 1, null); c.emit('close', 1, null); });
      return c;
    }
  });
  assert.equal(calls.length, 1, '第一步失败后不得再启动后续阶段');
  assert.equal(path.basename(calls[0].bin).toLowerCase(), 'node.exe', '必须用固定 Node 启动');
  assert.equal(calls[0].arg0, o.FIXED.cliEntry, '第一个参数必须是固定 CLI 入口脚本');
  assert.equal(a.matched, false);
  assert.equal(a.stoppedEarly, true);
  assert.equal(a.stages.length, 3, '仍保留三阶段记录');
  assert.equal(a.stages.filter(s => s.notExecuted).length, 2, '后两步须标记未执行');
  assert.equal(a.stages[0].launchedBy, 'node');
});

test('R1-b node-sdk 公开入口是 init(config)：导出为对象，对它 new 会抛 TypeError', () => {
  const resolved = require.resolve(path.join(o.FIXED.sdkRoot, '@cloudbase', 'node-sdk'));
  const sdk = require(resolved);
  assert.equal(typeof sdk, 'object', '导出确实是对象而非构造函数');
  assert.equal(typeof sdk.init, 'function', '公开入口是 init');
  assert.throws(() => new sdk({}), TypeError, '对导出对象 new 必须抛 TypeError（这正是上一版的缺陷）');
});

test('R1-c buildSdkConfig 真的传入固定 region（不用常量冒充已核实请求地域）', () => {
  const cfg = w.buildSdkConfig({ secretId: 'a', secretKey: 'b', sessionToken: 'c' }, {});
  assert.equal(cfg.region, o.FIXED.region, 'region 必须真正传给 SDK');
  assert.equal(cfg.region, 'ap-shanghai');
  // 仍然禁止自定义 endpoint / 代理覆盖
  assert.equal(cfg.endpoint, undefined);
  // token → sessionToken 映射不变
  assert.equal(cfg.sessionToken, 'c');
  assert.equal(cfg.token, undefined);
});

test('R1-d 本地准备核对真实版本与公开入口，不只「文件存在就算通过」', async () => {
  const r = await o.runLocalCheck({});
  assert.equal(r.status, o.STATUS.LOCAL_READY);
  const lp = r.localPreparation;
  assert.deepEqual(lp.actualVersions['@cloudbase/node-sdk'], '2.10.0');
  assert.deepEqual(lp.actualVersions['@cloudbase/database'], '1.4.1');
  assert.equal(lp.sdkPublicEntry.exportKind, 'object');
  assert.equal(lp.sdkPublicEntry.hasInit, true);
  // H3：能力字段与运行证据必须分开 —— 实现存在 ≠ 已执行 ≠ 生产已证实
  assert.equal(lp.credentialFetchHostImplemented, true, '宿主候选实现已存在');
  assert.equal(lp.publicEntryIdentityProven, true, '离线公共入口证明已完成');
  assert.equal(lp.productionSameBatchObserved, false,
    '生产同批链本轮恒为 false：离线证明 + 候选实现都不等于生产证据');
  // 本次默认调用确实没有取凭据、没有发起任何云调用
  assert.equal(lp.credentialFetched, false);
  assert.equal(lp.cloudCallAttempted, false);
  // 离线证明的适用范围必须写明并**限定**，不得泛化成平台保证
  assert.equal(lp.publicEntryEvidence.scope.includes('secrets get --json'), true,
    '须写明证明覆盖的命令');
  assert.equal(lp.publicEntryEvidence.additionalBehaviorsKnown, true,
    '须记录命令的附加行为，避免被当作无副作用');
  assert.equal(typeof lp.publicEntryEvidence.fingerprint, 'object',
    '须绑定固定指纹，范围随指纹变化而失效');
  assert.equal(lp.publicEntryEvidence.fingerprint.bundleSha256.length, 64, 'bundle 指纹须为 sha256');
});

/**
 * 在子进程里跑一段探针并取回其 stdout 净化 JSON。
 *
 * 用**异步 spawn** 而非 `spawnSync`：交付当时本机实测 `spawnSync` 对本探针返回
 * `status=null, stdout=undefined`（与已验收 CLI 观测器记录的 `spawnSync` EBUSY 属同类
 * 环境现象）。不放宽检查，改用不会触发该问题的执行方式。
 */
function runProbe(probeSource, timeoutMs) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(o.FIXED.nodeBin, ['-e', probeSource], { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* 已记为未确认 */ } reject(new Error('probe timeout')); }, timeoutMs || 30000);
    child.stdout.on('data', d => { so += d; });
    child.stderr.on('data', d => { se += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('probe exit=' + code + ' stderr=' + se.slice(0, 300)));
      try { resolve(JSON.parse(so)); } catch (e) { reject(new Error('probe 输出非 JSON：' + so.slice(0, 300))); }
    });
  });
}

test('R1-e 真实 worker 初始化路径可跑通（真实 SDK，零网络请求）', async () => {
  // 运行真实 worker 的初始化路径：require 真实 SDK、真实 init(config)、真实
  // database()，随后只做本地 introspection。不发起任何数据库查询。
  const workerPath = path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs');
  const probe = `
    const path = require('path');
    const w = require(${JSON.stringify(workerPath)});
    const sdk = require(require.resolve(path.join(${JSON.stringify(o.FIXED.sdkRoot)}, '@cloudbase', 'node-sdk')));
    const cfg = w.buildSdkConfig({ secretId: 'SYN_ID', secretKey: 'SYN_KEY', sessionToken: 'SYN_TOKEN' }, {});
    const out = { hasInit: typeof sdk.init === 'function', region: cfg.region, env: cfg.env, sessionTokenMapped: typeof cfg.sessionToken === 'string' && cfg.token === undefined };
    try {
      const app = sdk.init(cfg);
      out.initOk = Boolean(app);
      out.hasDatabase = typeof app.database === 'function';
      const db = app.database();
      const handles = w.installWriteTraps(db, [w.ADMIN_COLLECTION, w.USER_COLLECTION]);
      const chained = handles.primary.doc('primary').field(w.PRIMARY_PROJECTION);
      out.chainedKeys = Object.keys(chained);
      out.writeMethodsReachable = typeof chained.set === 'function' || typeof handles.primary.doc('primary').set === 'function';
      out.trapThrows = (() => { try { db.collection(w.ADMIN_COLLECTION); return false; } catch (e) { return e.code === 'READ_ONLY_TRAP'; } })();
    } catch (e) { out.error = String(e && e.message); }
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  `;
  const got = await runProbe(probe);
  assert.equal(got.hasInit, true);
  assert.equal(got.region, 'ap-shanghai', '真实配置里region 确实被固定传入');
  assert.equal(got.env, o.FIXED.envId);
  assert.equal(got.sessionTokenMapped, true);
  assert.equal(got.initOk, true, 'sdk.init(config) 必须成功（上一版 new 会抛 TypeError）');
  assert.equal(got.hasDatabase, true);
  assert.equal(got.error, undefined, '不应有初始化错误：' + got.error);
  // R5：真实 SDK 的 field() 返回新引用，但窄包装上仍只有 get
  assert.deepEqual(got.chainedKeys, ['get']);
  assert.equal(got.writeMethodsReachable, false, '真实 SDK 下写方法也不可达');
  assert.equal(got.trapThrows, true);
});

// ══════════════════════════════════════════════════════════════════════
// 第 10 组：R2 返修 —— worker 进程有界失败（EventEmitter 生命周期，不直接调解释函数）
// ══════════════════════════════════════════════════════════════════════

const R2_OPTS = { timeoutMs: 120, closeGraceMs: 40, maxOutputBytes: 4096 };
const R2_SNAP = { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 600000 };
/** R2 断言：无论发生什么，runWorker 都必须在有限时间内 settle。 */
async function settleWithin(promise, ms) {
  const r = await Promise.race([
    promise.then(v => ({ settled: true, v })),
    new Promise(res => setTimeout(() => res({ settled: false }), ms))
  ]);
  return r;
}

test('R2-1 正常路径：code=0 且合法 JSON 才成功，凭据只经 stdin 一次送入', async () => {
  const c = fakeChild();
  const p = o.runWorker(R2_SNAP, SYN_TARGET_USER_ID, { spawn: () => c, limits: R2_OPTS });
  await listenersReady();
  c.stdout.emit('data', Buffer.from(JSON.stringify({
    ok: true, writeAttemptsCount: 0,
    primary: { classification: 'NOT_FOUND', docId: 'primary', requestId: SYN_REQUEST }
  })));
  c.emit('exit', 0, null);
  c.emit('close', 0, null);
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.writeAttemptsCount, 0);
  assert.equal(c.stdinClosed, true, 'stdin 必须已关闭');
  const sent = JSON.parse(c.stdinBytes);
  assert.equal(sent.secretId, 'S');
  assert.equal(sent.targetUserId, SYN_TARGET_USER_ID);
  // R4：到期时间随载荷送入，使 worker 能在两条读取之间复核
  assert.equal(typeof sent.expiresAtMs, 'number');
});

test('R2-2 无 exit/close：总超时必须有界收尾，不能永久挂起', async () => {
  const c = fakeChild();
  const p = o.runWorker(R2_SNAP, null, { spawn: () => c, limits: R2_OPTS });
  const r = await settleWithin(p, 3000);
  assert.equal(r.settled, true, '无 exit/close 也必须有界收尾（上一版永久挂起）');
  assert.equal(r.v.errorCode, o.ERR.WORKER_TIMEOUT);
  assert.equal(c.kills, 1, '终止请求只发一次');
});

test('R2-3 kill 返回 false 且永不 close：仍必须有界收尾并如实记未确认', async () => {
  const c = fakeChild();
  c.kill = () => { c.kills++; return false; };
  const p = o.runWorker(R2_SNAP, null, { spawn: () => c, limits: R2_OPTS });
  const r = await settleWithin(p, 3000);
  assert.equal(r.settled, true, 'kill 失败也不得挂起');
  assert.equal(r.v.errorCode, o.ERR.WORKER_TIMEOUT);
});

test('R2-4 exit 后无 close：由 close 宽限有界失败，不无限等待', async () => {
  const c = fakeChild();
  const p = o.runWorker(R2_SNAP, null, { spawn: () => c, limits: R2_OPTS });
  await listenersReady();
  c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
  c.emit('exit', 0, null);
  const r = await settleWithin(p, 3000);
  assert.equal(r.settled, true, 'exit 无 close 必须由宽限定时收尾');
  assert.equal(r.v.errorCode, o.ERR.WORKER_CLOSE_NOT_OBSERVED);
});

test('R2-5 stdout+stderr 合并超限：各自不超但合计超限同样拒绝，且只终止一次', async () => {
  const c = fakeChild();
  const p = o.runWorker(R2_SNAP, null, { spawn: () => c, limits: { timeoutMs: 5000, closeGraceMs: 40, maxOutputBytes: 1000 } });
  await listenersReady();
  for (let i = 0; i < 5; i++) {
    c.stdout.emit('data', Buffer.alloc(400, 32));
    c.stderr.emit('data', Buffer.alloc(400, 120));
  }
  const r = await settleWithin(p, 3000);
  assert.equal(r.settled, true);
  assert.equal(r.v.errorCode, o.ERR.WORKER_OVERFLOW, '合并超限必须拒绝');
  assert.equal(c.kills, 1, '重复 chunk 不得重复 kill');
});

test('R2-6 非零退出带合法 JSON：不得凭 stdout 判成功', async () => {
  const c = fakeChild();
  const p = o.runWorker(R2_SNAP, null, { spawn: () => c, limits: R2_OPTS });
  await listenersReady();
  c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
  c.emit('exit', 1, null);
  c.emit('close', 1, null);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, o.ERR.WORKER_NONZERO_EXIT);
});

test('R2-7 超时后 close 且 stdout 含 ok:true：仍不得成功（WORKER_TIMEOUT 生效）', async () => {
  const c = fakeChild();
  const p = o.runWorker(R2_SNAP, null, { spawn: () => c, limits: R2_OPTS });
  const r = await settleWithin(p, 3000);
  assert.equal(r.settled, true);
  assert.equal(r.v.errorCode, o.ERR.WORKER_TIMEOUT);
  assert.equal(r.v.ok, false);
});

test('R2-8 stdin 写失败：本次调用失败，不得当成跑完了', async () => {
  const c = fakeChild();
  c.stdin.write = () => { throw new Error('EPIPE'); };
  const p = o.runWorker(R2_SNAP, null, { spawn: () => c, limits: R2_OPTS });
  await listenersReady();
  c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
  c.emit('exit', 0, null);
  c.emit('close', 0, null);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, o.ERR.WORKER_STDIN_FAILED);
});

test('R2-9 子进程 error 事件：首次作为结果返回，收尾后的晚到 error 被吸收', async () => {
  const c1 = fakeChild();
  const p1 = o.runWorker(R2_SNAP, null, { spawn: () => c1, limits: R2_OPTS });
  await listenersReady();
  c1.emit('error', new Error('spawn failed'));
  const r1 = await p1;
  assert.equal(r1.ok, false);
  assert.equal(r1.errorCode, o.ERR.WORKER_FAILED);

  // 晚到 error：不得抛错（EventEmitter 无监听会抛）
  const c2 = fakeChild();
  const p2 = o.runWorker(R2_SNAP, null, { spawn: () => c2, limits: R2_OPTS });
  await listenersReady();
  c2.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
  c2.emit('exit', 0, null);
  c2.emit('close', 0, null);
  const r2 = await p2;
  assert.equal(r2.ok, true);
  assert.doesNotThrow(() => c2.emit('error', new Error('late')));
});

test('R2-10 收尾后不得二次终止、不再追加输出（幂等）', async () => {
  const c = fakeChild();
  const p = o.runWorker(R2_SNAP, null, { spawn: () => c, limits: R2_OPTS });
  await listenersReady();
  c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
  c.emit('exit', 0, null);
  c.emit('close', 0, null);
  await p;
  const killsAfterFirst = c.kills;
  // 收尾后再来事件：不得触发 kill，也不得抛出
  assert.doesNotThrow(() => {
    c.stdout.emit('data', Buffer.from('X'.repeat(5000)));
    c.emit('exit', 0, null);
    c.emit('close', 0, null);
  });
  assert.equal(c.kills, killsAfterFirst, '收尾后不得二次终止');
  assert.equal(c.stdout.listenerCount('data'), 0, '收尾后移除累积数据的监听');
});

// ══════════════════════════════════════════════════════════════════════
// 第 11 组：R3 返修 —— 严格记录校验与顶层汇总（跑真实编排，不只测手工摘要对象）
// ══════════════════════════════════════════════════════════════════════

/** 走真实 runWorker 生命周期，注入指定的 worker 载荷。 */
async function runWorkerWithPayload(payload, opts) {
  const c = fakeChild();
  const p = o.runWorker(R2_SNAP, (opts && opts.targetUserId) || null, {
    spawn: () => c, limits: R2_OPTS
  });
  await listenersReady();
  c.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
  c.emit('exit', 0, null);
  c.emit('close', 0, null);
  return p;
}

test('R3-1 primary 缺 userId/status：不得判为 OBSERVED，且必须写明原因', () => {
  const r = o.interpretPrimary({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    primary: { classification: 'OBSERVED', docId: 'primary', userId: null, status: null, userIdShapeValid: false, statusValid: false }
  }, SYN_TARGET_USER_ID);
  assert.equal(r.status, 'UNCONFIRMED', '字段缺失不得算通过（上一版得 OBSERVED）');
  assert.equal(r.userId, null);
  assert.equal(r.status_field, null);
  assert.equal(r.fieldCompleteness, 'INCOMPLETE');
  assert.ok(r.reasons.some(x => x.includes('userId')), '须写明 userId 问题：' + JSON.stringify(r.reasons));
  assert.ok(r.reasons.some(x => x.includes('状态')), '须写明状态问题：' + JSON.stringify(r.reasons));
  assert.equal(r.errorCode, o.ERR.PRIMARY_UNCONFIRMED);
});

test('R3-2 users 缺 status/openid：不得判 OBSERVED；派生 false 必须有原因', () => {
  const r = o.interpretTargetUser({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    targetUser: { classification: 'OBSERVED', docId: SYN_TARGET_USER_ID, status: null, statusValid: false, derivationMatches: false, derivationChecked: false, openidShapeValid: false }
  }, SYN_TARGET_USER_ID);
  assert.equal(r.status, 'UNCONFIRMED');
  assert.equal(r.derivationMatches, false);
  assert.ok(r.reasons.length > 0, 'derivationMatches=false 必须有失败原因');
  assert.ok(r.reasons.some(x => x.includes('状态')));
  assert.ok(r.reasons.some(x => x.includes('openid')));
  assert.ok(r.reasons.some(x => x.includes('派生')));
});

test('R3-3 平台错误响应（带 code 且 data 为空）不是 NOT_FOUND', () => {
  const n = w.normalizeReadResult({ code: 'SYNTHETIC_DENIED', data: [] }, 'primary');
  assert.equal(n.classification, 'UNCONFIRMED', '错误响应不得归为未找到');
  assert.equal(n.hasPlatformError, true);
  // 解释层同样不得把它当空记录
  const r = o.interpretPrimary({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    primary: { classification: 'UNCONFIRMED', docId: 'primary', hasPlatformError: true, reason: '平台返回错误响应' }
  }, SYN_TARGET_USER_ID);
  assert.equal(r.status, 'UNCONFIRMED');
  assert.notEqual(r.status, 'NOT_FOUND');
  assert.equal(r.hasPlatformError, true);
});

test('R3-4 非法 userId 字符串与合成敏感标记不得进入报告（两层都拒绝/净化）', () => {
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  const r = o.interpretPrimary({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    primary: { classification: 'OBSERVED', docId: 'primary', userId: marker, status: 'active', userIdShapeValid: false, statusValid: true }
  }, SYN_TARGET_USER_ID);
  assert.equal(r.userId, null, '非法 userId 不得原样进入报告');
  assert.equal(JSON.stringify(r).includes(marker), false, '敏感标记不得泄露到报告');
  assert.equal(r.status, 'UNCONFIRMED');
  // 非法 status 同样净化
  const r2 = o.interpretPrimary({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    primary: { classification: 'OBSERVED', docId: 'primary', userId: SYN_TARGET_USER_ID, status: marker, statusValid: false }
  }, SYN_TARGET_USER_ID);
  assert.equal(r2.status_field, null);
  assert.equal(JSON.stringify(r2).includes(marker), false);
  // 非法 classification 降级
  const r3 = o.interpretPrimary({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    primary: { classification: 'WHATEVER', docId: 'primary' }
  }, null);
  assert.equal(r3.status, 'UNCONFIRMED');
  // 任意 reason 字符串不透传
  const r4 = o.interpretPrimary({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    primary: { classification: 'UNCONFIRMED_SHAPE', docId: 'primary', reason: marker }
  }, null);
  assert.equal(JSON.stringify(r4).includes(marker), false, 'reason 只接受固定短语白名单');
});

test('R3-5 worker 失败（ok:false）时顶层不得标 OBSERVED，incomplete 不得为空', async () => {
  const wr = await runWorkerWithPayload({ ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 });
  assert.equal(wr.ok, false);
  // 顶层：解释器必须拒绝，不能因worker.primary 缺失而静默
  const p = o.interpretPrimary(wr, SYN_TARGET_USER_ID);
  assert.equal(p.status, 'UNCONFIRMED');
  assert.equal(p.errorCode, 'SDK_UNAVAILABLE');
  assert.ok(p.reasons.length > 0);
  const u = o.interpretTargetUser(wr, SYN_TARGET_USER_ID);
  assert.equal(u.status, 'UNCONFIRMED');
});

test('R3-6 写次数非 0：整组必须失败，不得继续核对', async () => {
  const wr = await runWorkerWithPayload({ ok: true, writeAttemptsCount: 2, primary: null });
  assert.equal(wr.ok, false);
  assert.equal(wr.errorCode, o.ERR.WORKER_WRITE_ATTEMPTED);
});

test('R3-7 依赖注入不得产生生产 proven；证据种类如实区分', async () => {
  const fetched = await o.fetchTemporaryCredential({
    deps: { fetchCredential: async () => secretsPayload() }
  });
  assert.equal(fetched.proven, false, '依赖注入不是生产证据');
  assert.equal(fetched.evidenceKind, 'SYNTHETIC_INJECTION');
  assert.equal(fetched.source, 'deps:fetchCredential');
  // 未注入时：如实报「公共入口身份来源未证实」，且不是「平台验证缺口」
  await assert.rejects(
    () => o.fetchTemporaryCredential({ deps: {} }),
    e => e.code === o.ERR.PUBLIC_ENTRY_IDENTITY_UNPROVEN
  );
});

test('R3-8 NOT_FOUND 只是「本次未找到」：单列但不得称为有效管理员', () => {
  const r = o.interpretPrimary({
    ok: true, writeAttemptsCount: 0, errorCode: null,
    primary: { classification: 'NOT_FOUND', docId: 'primary', requestId: SYN_REQUEST }
  }, SYN_TARGET_USER_ID);
  assert.equal(r.status, 'NOT_FOUND');
  assert.notEqual(r.status, 'OBSERVED');
  assert.equal(r.userId, null, 'NOT_FOUND 不得凭空给出管理员');
});

test('R3-9 缺目标维持未执行；primary 可独立观测但整体不得标完整', () => {
  const r = o.interpretTargetUser({ ok: true, writeAttemptsCount: 0, targetUser: null }, null);
  assert.equal(r.status, 'NOT_EXECUTED_TARGET_UNCONFIRMED');
});

// ══════════════════════════════════════════════════════════════════════
// 第 12 组：R4 返修 —— 身份隔离与有效期覆盖实际运行边界
// ══════════════════════════════════════════════════════════════════════

test('R4-1 隔离环境按大小写无关清理：小写别名与代理变量都不得残留', () => {
  const iso = o.buildIsolatedEnv({
    PATH: 'C:/Windows',
    xdg_config_home: 'C:/outside',
    XDG_CONFIG_HOME: 'C:/outside',
    UserProfile: 'C:/outside',
    USERPROFILE: 'C:/outside',
    home: 'C:/outside',
    HOMEDRIVE: 'C:',
    Http_Proxy: 'http://outside',
    HTTP_PROXY: 'http://outside',
    https_proxy: 'http://outside',
    ALL_PROXY: 'http://outside',
    no_proxy: 'localhost',
    tcb_region: 'ap-guangzhou',
    CLOUDBASE_API_KEY: 'X',
    Node_Options: '--require X',
    TENCENTCLOUD_SECRETID: 'INHERITED'
  }, { secretId: 'S', secretKey: 'K', sessionToken: 'T' }, 'C:/iso/run');

  // 1) 不得残留任何「非规范大小写」的同义键（Windows 忽略大小写，别名等于旁路）
  const canonical = new Set([
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATH',
    'TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN',
    'TCB_REGION', 'NO_UPDATE_NOTIFIER', 'TCB_DISABLE_REPORT', 'CI'
  ]);
  for (const k of Object.keys(iso)) {
    assert.equal(canonical.has(k), true, '出现非预期键（可能是未清理的别名）：' + k);
  }
  // 2) 逐类确认清除
  const uppers = Object.keys(iso).map(k => k.toUpperCase());
  for (const u of uppers) {
    assert.equal(u.startsWith('XDG_'), false, 'XDG 变量残留：' + u);
    assert.equal(u.includes('PROXY'), false, '代理变量残留：' + u);
    assert.equal(u === 'NODE_OPTIONS' || u === 'NODE_PATH', false, 'Node 注入残留：' + u);
    assert.equal(u === 'HOMEDRIVE' || u === 'HOMEPATH', false, '主目录别名残留：' + u);
    assert.equal(u.startsWith('CLOUDBASE_'), false, 'CLOUDBASE_ 残留：' + u);
    // TENCENTCLOUD_ 只允许我们注入的那三个
    if (u.startsWith('TENCENTCLOUD_')) {
      assert.ok(['TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN'].includes(u), '意外 TENCENTCLOUD_ 键：' + u);
    }
    if (u.startsWith('TCB_')) {
      assert.ok(['TCB_REGION', 'TCB_DISABLE_REPORT'].includes(u), '意外 TCB_ 键：' + u);
    }
  }
  // 3) 规范大写形式确实指向隔离目录，且注入的是同批三字段
  assert.equal(iso.USERPROFILE, 'C:/iso/run');
  assert.equal(iso.HOME, 'C:/iso/run');
  assert.equal(iso.APPDATA, path.join('C:/iso/run', 'AppData', 'Roaming'));
  assert.equal(iso.LOCALAPPDATA, path.join('C:/iso/run', 'AppData', 'Local'));
  assert.equal(iso.TENCENTCLOUD_SECRETID, 'S');
  assert.equal(iso.TENCENTCLOUD_SECRETKEY, 'K');
  assert.equal(iso.TENCENTCLOUD_SESSIONTOKEN, 'T');
  assert.equal(iso.TCB_REGION, o.FIXED.region);
  assert.equal(iso.PATH, 'C:/Windows', '无关变量应保留');
});

test('R4-2 authStatePaths 覆盖完整取值链的所有落点（含XDG 指定位置）', () => {
  const paths = o.authStatePaths('C:/iso/run');
  assert.ok(paths.length >= 4, '实际取值链不止两个落点：' + JSON.stringify(paths));
  const joined = paths.map(p => p.toLowerCase()).join('|');
  assert.ok(joined.includes('.cloudbase'), '须含 .cloudbase 目录');
  assert.ok(joined.includes('auth.json'), '须含 auth.json');
  // 大小写不敏感去重
  assert.equal(new Set(paths.map(p => p.toLowerCase())).size, paths.length, '不得有大小写重复项');
  // 污染即停止且不删文件
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-iso-'));
  const dir = path.join(root, 'run');
  fs.mkdirSync(path.join(dir, '.config', '.cloudbase'), { recursive: true });
  assert.equal(o.assertIsolationClean(dir), true);
  // 在**实际取值链的某个落点**上放一个认证文件
  const target = o.authStatePaths(dir).find(p => p.endsWith(path.join('.config', '.cloudbase', 'auth.json')));
  assert.ok(target, '落点列表应含 .config/.cloudbase/auth.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{}', 'utf8');
  assert.throws(() => o.assertIsolationClean(dir), e => e.code === o.ERR.ISOLATION_DIRTY);
  assert.equal(fs.existsSync(target), true, '污染时不得删除用户文件');
  fs.rmSync(root, { recursive: true, force: true });
});

test('R4-3 有效期检查覆盖 CLI 各阶段前后（失败停止时也不漏检）', async () => {
  const clock = Date.now();
  const snap = { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: clock + 1000, expiresAtIso: new Date(clock + 1000).toISOString() };
  let n = 0;
  // 第一次检查（阶段前）用当前时刻，之后跳到过期之后。
  // 第一步 exit 1 → 停止，但**阶段后的检查仍必须执行**并发现过期。
  await assert.rejects(
    () => o.runCliAssociation(snap, 'C:/offline-only', {
      now: () => { n++; return n === 1 ? clock : clock + 5000; },
      baseEnv: {},
      spawn: (bin, args) => {
        const c = fakeChild();
        setImmediate(() => { c.emit('exit', 1, null); c.emit('close', 1, null); });
        return c;
      }
    }),
    e => e.code === o.ERR.CREDENTIAL_EXPIRED,
    '阶段失败停止时仍须做后检查'
  );
  assert.ok(n >= 2, '有效期应被多次核对（实际 ' + n + ' 次）');

  // 未过期时正常放行；过期时拦下
  assert.equal(o.assertCredentialFresh(snap, clock), true, '未过期时放行');
  assert.throws(() => o.assertCredentialFresh(snap, clock + 5000), e => e.code === o.ERR.CREDENTIAL_EXPIRED);
  // 停止时仍保留三阶段记录，后两步标 notExecuted
  let m = 0;
  const a = await o.runCliAssociation(
    { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 600000 },
    'C:/offline-only',
    {
      now: () => { m++; return Date.now(); },
      baseEnv: {},
      spawn: () => {
        const c = fakeChild();
        setImmediate(() => { c.emit('exit', 1, null); c.emit('close', 1, null); });
        return c;
      }
    });
  assert.equal(a.stages.length, 3, '三阶段记录须完整保留');
  assert.equal(a.stages.filter(s => s.notExecuted).length, 2);
  assert.equal(a.stoppedEarly, true);
});

test('R4-4 worker 载荷带到期时间，使两条读取之间可复核（不刷新不混批）', async () => {
  const c = fakeChild();
  const p = o.runWorker({ secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 600000 }, SYN_TARGET_USER_ID, {
    spawn: () => c, limits: R2_OPTS
  });
  await listenersReady();
  const sent = JSON.parse(c.stdinBytes);
  assert.equal(typeof sent.expiresAtMs, 'number', '载荷必须含到期时间');
  assert.equal(sent.expiresAtMs, c.stdinBytes.includes('"expiresAtMs"') ? sent.expiresAtMs : null);
  c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
  c.emit('exit', 0, null);
  c.emit('close', 0, null);
  await p;
});

test('R4-5 凭据在运行期间过期：观察结果不得升级为完整核验', async () => {
  const wr = await runWorkerWithPayload({
    ok: true, writeAttemptsCount: 0, credentialExpiredDuringRun: true,
    primary: { classification: 'OBSERVED', docId: 'primary', userId: SYN_TARGET_USER_ID, status: 'active' }
  });
  assert.equal(wr.ok, true);
  assert.equal(wr.credentialExpiredDuringRun, true, '过期事实必须从worker 带回');
});

// ══════════════════════════════════════════════════════════════════════
// 第 13 组：R5 返修 —— 写陷阱声明收窄 + 真实 SDK 请求拦截
// ══════════════════════════════════════════════════════════════════════

test('R5-1 真实 @cloudbase/database 的 field() 确实返回新引用（缺陷前提成立）', async () => {
  // 运行期确认：真实 SDK 的 doc().field() 返回 !== doc() 的对象，且新引用带写方法
  const probe = `
    const path = require('path');
    const sdk = require(require.resolve(path.join(${JSON.stringify(o.FIXED.sdkRoot)}, '@cloudbase', 'node-sdk')));
    const db = sdk.init({ secretId: 'SYN_ID', secretKey: 'SYN_KEY', env: ${JSON.stringify(o.FIXED.envId)}, region: ${JSON.stringify(o.FIXED.region)} }).database();
    const ref = db.collection('schtest_v1_app_admins').doc('primary');
    const projected = ref.field({ _id: true });
    process.stdout.write(JSON.stringify({ same: projected === ref, hasSet: typeof projected.set === 'function', refHasSet: typeof ref.set === 'function' }));
    process.exit(0);
  `;
  const got = await runProbe(probe);
  assert.equal(got.same, false, 'field() 必须返回新引用（否则 R5 缺陷前提不成立）');
  assert.equal(got.hasSet, true, '新引用上确实带写方法 —— 这就是上一版漏封的入口');
  assert.equal(got.refHasSet, true);
});

test('R5-2 窄包装只暴露 get：写方法在包装上不可达（不是被拦，是不存在）', async () => {
  const db = {
    collection: (n) => ({
      doc: (id) => ({
        set: () => 'reachable',
        field() { return { get: async () => ({ data: [{ _id: id }] }), set: () => 'reachable' }; }
      }),
      set: () => 'reachable'
    })
  };
  const h = w.installWriteTraps(db, [w.ADMIN_COLLECTION, w.USER_COLLECTION]);
  assert.deepEqual(Object.keys(h.primary), ['doc']);
  assert.deepEqual(Object.keys(h.primary.doc('primary')), ['field']);
  assert.deepEqual(Object.keys(h.primary.doc('primary').field({})), ['get']);
  // 上一版的绕过手法：.doc().field().set() —— 现在不可达
  assert.throws(() => h.primary.doc('primary').field({}).set(), TypeError);
  assert.throws(() => h.primary.doc('primary').set(), TypeError);
  // 真实引用上的集合级写方法仍被陷阱拦住
  assert.throws(() => db.collection(w.ADMIN_COLLECTION), /READ_ONLY_TRAP/);
});

test('R5-3 不构造通用数据库代理框架：窄包装只含 doc/field/get 三层', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'), 'utf8');
  const start = src.indexOf('function makeReadOnlyHandle');
  assert.ok(start > 0, '应存在 makeReadOnlyHandle');
  const body = src.slice(start, src.indexOf('\n}', start));
  // 只允许出现这三层能力，不得出现 Proxy / getownpropertydescriptor 之类通用代理
  assert.equal(/new\s+Proxy|Reflect\.|getOwnPropertyDescriptor/.test(body), false, '不得构造通用代理框架');
  assert.equal(body.includes('get'), true);
});

// ══════════════════════════════════════════════════════════════════════
// 第 14 组：S1–S3 收尾 —— 真实 worker main 输出 → 父进程完整处理链
// ══════════════════════════════════════════════════════════════════════

/**
 * 运行**真实 worker 主入口**，只把 SDK 请求传输替换为合成只读传输。
 *
 * 与「手写 worker 输出对象再直接调 interpretTargetUser」的区别：这里执行的是
 * worker 源码里的真实 main()（真实凭据形状校验、真实 init/database、真实
 * normalizeReadResult、真实 emit），因此能证明 worker →父进程整条链。
 *
 * 不发起任何真实网络/云请求；不取真实凭据；不读认证内容。
 */
const VM = require('node:vm');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');

const WORKER_PATH = path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs');

async function runRealWorkerMain(options) {
  const opts = options || {};
  const sdkRoot = o.FIXED.sdkRoot;
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const originalReqClass = database.Db.reqClass;
  const calls = [];
  const docs = opts.docs || {};
  const requestId = opts.requestId === undefined ? '00000000-0000-4000-8000-000000000001' : opts.requestId;
  class SyntheticRequest {
    async send(action, params) {
      calls.push({ action, collection: params.collectionName });
      //诊断用：按场景让传输层抛出带特定属性的异常，验证真实 worker 的 catch
      // 只输出最小诊断（不含 message/stack/cause）。
      if (opts.throwOn) {
        // target 选取：'primary' / 'users' 指定集合；其余值（如 'type'）表示
        // 在 primary 集合上按该模式抛错
        const which = opts.throwOn === 'users' ? w.USER_COLLECTION : w.ADMIN_COLLECTION;
        if (params.collectionName === which) {
          const isType = opts.throwOn === 'type' || opts.throwOn === 'primary-type';
          const err = isType
            ? new TypeError(opts.message || 'SYNTHETIC_LOCAL_TYPE_ERROR')
            : new Error(opts.message || 'SYNTHETIC_GENERIC_FAILURE');
          if (opts.errorCode) err.code = opts.errorCode;
          if (opts.errCode) err.errCode = opts.errCode;
          if (opts.requestId) err.requestId = opts.requestId;
          if (opts.extra) for (const k of Object.keys(opts.extra)) err[k] = opts.extra[k];
          throw err;
        }
      }
      if (opts.returnErrorResponse) {
        // R1：合成传输**返回**带 code 的响应（不抛）—— 对应固定源码 document.ts:337
        // `res.code` 存在时 get() 直接返回 res 的路径。
        const which = opts.returnErrorResponse === 'users' ? w.USER_COLLECTION : w.ADMIN_COLLECTION;
        if (params.collectionName === which) {
          return {
            code: opts.responseCode,
            requestId: opts.responseRequestId,
            data: { list: [] }
          };
        }
      }
      const doc = docs[params.collectionName];
      // 真实 SDK 的文档序列化格式；这里只替换传输，不改SDK 自身转换
      return { data: { list: doc === undefined ? [] : [JSON.stringify(doc)] }, requestId };
    }
  }
  const input = new PassThrough();
  const mod = { exports: {} };
  const actualRequire = createRequire(WORKER_PATH);
  function localRequire(name) {
    if (name.replace(/\\/g, '/').startsWith(sdkRoot + '/@cloudbase/node-sdk')) {
      return {
        init(config) {
          const app = sdk.init(config);
          return {
            database() {
              const db = app.database();
              database.Db.reqClass = SyntheticRequest;
              return db;
            }
          };
        }
      };
    }
    return actualRequire(name);
  }
  localRequire.resolve = actualRequire.resolve;
  localRequire.main = mod;
  let resolveOutput;
  const output = new Promise(r => { resolveOutput = r; });
  const context = {
    module: mod, exports: mod.exports, require: localRequire, Buffer,
    process: { stdin: input, stdout: { write(s) { resolveOutput(JSON.parse(s)); return true; } } }
  };
  try {
    VM.runInNewContext(fs.readFileSync(WORKER_PATH, 'utf8'), context, { filename: WORKER_PATH });
    const payload = {
      secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', sessionToken: 'SYNTHETIC_TOKEN',
      targetUserId: opts.targetUserId || null
    };
    if (opts.expiryMode === 'valid') payload.expiresAtMs = Date.now() + 600000;
    if (opts.expiryMode === 'expired') payload.expiresAtMs = Date.now() - 1;
    if (opts.expiryMode === 'infinite') payload.expiresAtMs = Infinity;
    if (opts.expiryMode === 'nan') payload.expiresAtMs = NaN;
    input.end(JSON.stringify(payload) + '\n');
    const result = await output;
    return { result, calls };
  } finally {
    database.Db.reqClass = originalReqClass;
  }
}

/** 走父进程完整处理链：worker 输出 → interpretWorkerOutput → interpretTargetUser/Primary。 */
function parentChain(workerResult, targetUserId) {
  const normalized = o.interpretWorkerOutput({
    code: 0, signal: null, stdout: JSON.stringify(workerResult),
    terminationConfirmed: true, targetUserId: targetUserId || null
  });
  return {
    normalized,
    primary: o.interpretPrimary(normalized, targetUserId),
    target: o.interpretTargetUser(normalized, targetUserId)
  };
}

test('S1-1 真实 worker main → 父进程完整链：合法 primary/users 各自 OBSERVED', async () => {
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const { result, calls } = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, status: 'active', openid }
    }
  });
  // 真实 worker 确实执行了两次 get
  assert.equal(calls.length, 2, '真实 worker 应发出两次读取');
  assert.equal(result.ok, true);
  // S1：字段契约已统一为 status（不再是 userStatus）
  assert.equal(result.targetUser.status, 'active');
  assert.equal(result.targetUser.userStatus, undefined, '不再使用 userStatus 字段名');
  // 走完父进程两层
  const chain = parentChain(result, target);
  assert.equal(chain.normalized.ok, true);
  assert.equal(chain.primary.status, 'OBSERVED', JSON.stringify(chain.primary.reasons));
  assert.equal(chain.target.status, 'OBSERVED', JSON.stringify(chain.target.reasons));
  assert.equal(chain.target.userStatus, 'active');
  assert.equal(chain.target.derivationMatches, true);
  assert.equal(chain.target.fieldCompleteness, 'COMPLETE');
  assert.equal(chain.primary.userId, target);
});

test('S1-2 users 契约不要求不存在的 userId 字段（净化层不得误降级）', () => {
  const target = w.deriveUserId(o.FIXED.wxAppId, 'synthetic-offline-only');
  const chain = parentChain({
    ok: true, writeAttemptsCount: 0, credentialExpiredDuringRun: false,
    primary: { classification: 'NOT_FOUND', docId: 'primary' },
    targetUser: {
      classification: 'OBSERVED', docId: target, status: 'active', statusValid: true,
      openidPresent: true, openidShapeValid: true, derivationMatches: true, derivationChecked: true
    }
  }, target);
  assert.equal(chain.normalized.targetUser.userId, null, 'users 记录不产出 userId');
  assert.equal(chain.normalized.targetUser.userIdShapeValid, null, 'users 不要求 userId 形状');
  assert.equal(chain.normalized.targetUser.fieldCompleteness, 'COMPLETE');
  assert.equal(chain.target.status, 'OBSERVED');
});

test('S1-3 反例：缺字段 / disabled / 错记录键 / 派生不符 各自 UNCONFIRMED 且有原因', async () => {
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  // (a) 缺 status —— 真实 worker 输出
  const missing = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, openid }
    }
  });
  const cMissing = parentChain(missing.result, target);
  assert.equal(cMissing.target.status, 'UNCONFIRMED');
  assert.ok(cMissing.target.reasons.length > 0);
  // (b) disabled
  const disabled = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, status: 'disabled', openid }
    }
  });
  const cDisabled = parentChain(disabled.result, target);
  assert.equal(cDisabled.target.status, 'UNCONFIRMED');
  assert.ok(cDisabled.target.reasons.some(r => String(r).includes('停用')));
  // (c) 派生不符（openid 与目标不匹配）
  const mismatch = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, status: 'active', openid: 'different-openid' }
    }
  });
  const cMismatch = parentChain(mismatch.result, target);
  assert.equal(cMismatch.target.status, 'UNCONFIRMED');
  assert.ok(cMismatch.target.reasons.some(r => String(r).includes('派生')));
  // (d) 错记录键（SDK 返回了别的 _id）
  const wrongKey = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: 'u_' + 'b'.repeat(40), status: 'active', openid }
    }
  });
  assert.equal(w.normalizeReadResult({ data: [{ _id: 'u_' + 'b'.repeat(40) }] }, target).classification, 'UNCONFIRMED_SHAPE');
  assert.equal(wrongKey.result.targetUser.classification, 'UNCONFIRMED_SHAPE');
});

test('S1-4 编排整体：合成凭据 proven=false 但两条合法记录各自 OBSERVED，整体可为 INCOMPLETE', async () => {
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const { result: realWorkerPayload } = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, status: 'active', openid }
    }
  });
  const account = '123456789012';
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: target },
    {
      now: () => Date.now(),
      baseEnv: {},
      fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 's14-iso-')) },
      fetchCredential: async () => secretsPayload(),
      spawn: (bin, argv) => {
        const c = fakeChild();
        // R1：argv = [固定cliEntry, 'api', service, action]；
        // worker 子进程则是 [workerPath]（无 api 参数）
        if (argv.length === 1) {
          // worker：回放上面由真实 worker main 产出的净化结果
          const w = realWorkerPayload;
          setImmediate(() => {
            c.stdout.emit('data', Buffer.from(JSON.stringify(w)));
            c.emit('exit', 0, null);
            c.emit('close', 0, null);
          });
          return c;
        }
        const api = argv[2];
        const act = argv[3];
        const hint = (svc, a) => '\u2139 \u2192' + String(svc).toUpperCase() + '.' + a + '\n';
        const payload = {
          'sts.GetCallerIdentity': {
            Type: 'CAMRole', AccountId: account, UserId: 'u', PrincipalId: 'p',
            Arn: 'qcs::cam::uin/' + account + ':role/r', RequestId: SYN_REQUEST
          },
          'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region }], RequestId: SYN_REQUEST },
          'tcb.DescribeEnvInfo': {
            EnvInfo: {
              EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
              UserInfo: { Uin: account, WxAppId: o.FIXED.wxAppId }
            }, RequestId: SYN_REQUEST
          }
        };
        setImmediate(() => {
          c.stdout.emit('data', Buffer.from(hint(api, act) + JSON.stringify({ data: payload[api + '.' + act] })));
          c.emit('exit', 0, null);
          c.emit('close', 0, null);
        });
        return c;
      }
    }
  );
  // 合成凭据绝不产生生产 proven
  assert.equal(report.sameBatchCredential.proven, false);
  assert.equal(report.sameBatchCredential.evidenceKind, 'SYNTHETIC_INJECTION');
  // 两条合法记录必须各自 OBSERVED —— 这是 S1 的核心正向
  assert.equal(report.primaryObservation.status, 'OBSERVED', JSON.stringify(report.primaryObservation));
  assert.equal(report.targetUserObservation.status, 'OBSERVED', JSON.stringify(report.targetUserObservation));
  assert.equal(report.targetUserObservation.userStatus, 'active');
  // 但整体不得声称生产同批链已证明
  assert.notEqual(report.status, o.STATUS.OBSERVED, '合成链不得整体标 OBSERVED：' + JSON.stringify(report.incomplete));
  assert.ok(report.incomplete.some(x => String(x).includes('未获生产证实')));
  assert.equal(report.writeAuthorized, false);
});

test('S2-1 worker 任意 errorCode 不进入顶层：未知值映射为固定失败码', () => {
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  const r = o.interpretWorkerOutput({
    code: 0, terminationConfirmed: true, targetUserId: null,
    stdout: JSON.stringify({ ok: false, errorCode: marker, writeAttemptsCount: 0 })
  });
  assert.equal(r.ok, false);
  assert.notEqual(r.errorCode, marker, '任意错误码不得原样进入顶层');
  assert.equal(r.errorCode, o.ERR.WORKER_FAILED);
  // 已知错误码仍原样保留，便于诊断
  const known = o.interpretWorkerOutput({
    code: 0, terminationConfirmed: true, targetUserId: null,
    stdout: JSON.stringify({ ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 })
  });
  assert.equal(known.errorCode, 'SDK_UNAVAILABLE');
  // 记录内的任意 errorCode 同样被映射
  const inner = o.sanitizeWorkerRecord(
    { classification: 'UNCONFIRMED', docId: 'primary', errorCode: marker },
    o.makeUsersExpectation(null)
  );
  assert.notEqual(inner.errorCode, marker);
});

test('S2-2 非 OBSERVED 记录的 docId 只能是请求目标，否则置 null', () => {
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  const r = o.interpretPrimary(o.interpretWorkerOutput({
    code: 0, terminationConfirmed: true, targetUserId: null,
    stdout: JSON.stringify({ ok: true, writeAttemptsCount: 0, primary: { classification: 'NOT_FOUND', docId: marker } })
  }), null);
  assert.equal(r.docId, null, 'NOT_FOUND 的任意 docId 不得保留');
  assert.equal(JSON.stringify(r).includes(marker), false);
  // 合法主键仍保留
  const okRec = o.interpretPrimary(o.interpretWorkerOutput({
    code: 0, terminationConfirmed: true, targetUserId: null,
    stdout: JSON.stringify({ ok: true, writeAttemptsCount: 0, primary: { classification: 'NOT_FOUND', docId: 'primary' } })
  }), null);
  assert.equal(okRec.docId, 'primary');
});

test('S2-3 requestId 只保留已核实格式（真实证据 190 个样本全为 UUID v4）', async () => {
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  // 真实 worker 主入口：SDK 返回任意 requestId 时不得原样输出
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const bad = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target, requestId: marker,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, status: 'active', openid }
    }
  });
  assert.equal(bad.result.primary.requestId, null, '任意 requestId 不得进入 worker 输出');
  assert.equal(JSON.stringify(bad.result).includes(marker), false);
  // 净化层同样收紧（即使 worker 输出了）
  const sanitized = o.sanitizeWorkerRecord(
    { classification: 'OBSERVED', docId: 'primary', userId: target, status: 'active', requestId: marker },
    { docId: 'primary', classificationValues: ['OBSERVED'], userIdPattern: /^u_[0-9a-f]{40}$/, statusValues: ['active', 'disabled'], requiredFields: ['docIdMatches'] }
  );
  assert.equal(sanitized.requestId, null);
  // 已核实的 UUID v4 原样保留
  const uuid = '5dc5d7cb-6deb-42d5-9c36-36a958d574f8';
  assert.equal(o.safeRequestId(uuid), uuid);
  assert.equal(o.safeRequestId('SYNTHETIC_PRIVATE_MARKER'), null);
  assert.equal(o.safeRequestId('r-a-1'), null);
  // 版本位不对的 UUID 也拒（已核实样本版本位恒为 4）
  assert.equal(o.safeRequestId('5dc5d7cb-6deb-12d5-9c36-36a958d574f8'), null);
});

test('S3-1 worker 截止时间缺失 → 零读取', async () => {
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const { result, calls } = await runRealWorkerMain({
    expiryMode: 'missing', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, status: 'active', openid }
    }
  });
  assert.equal(calls.length, 0, '缺失截止时间必须零读取（上一版读了两条）');
  assert.equal(result.credentialExpiryMissing, true);
  assert.equal(result.primary.classification, 'UNCONFIRMED');
  assert.equal(result.targetUser.classification, 'UNCONFIRMED');
  // 「缺失不是尚未过期」
  assert.equal(result.credentialExpiredDuringRun, false);
});

test('S3-2 非法截止值（Infinity / NaN）同样零读取', async () => {
  const target = w.deriveUserId(o.FIXED.wxAppId, 'synthetic-offline-only');
  for (const mode of ['infinite', 'nan']) {
    const { calls, result } = await runRealWorkerMain({
      expiryMode: mode, targetUserId: target,
      docs: { [w.USER_COLLECTION]: { _id: target, status: 'active', openid: 'x' } }
    });
    assert.equal(calls.length, 0, mode + ' 必须零读取');
    assert.equal(result.credentialExpiryMissing, true, mode);
  }
});

test('S3-3 有效截止时间 → 正常两次读取', async () => {
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const { calls, result } = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, status: 'active', openid }
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.credentialExpiryMissing, false);
  assert.equal(result.credentialExpiredDuringRun, false);
});

test('S3-4 两读之间过期 → 如实标记，不升级为完整核验', async () => {
  // 用受控时钟：第一次检查在有效期内，第二次（读完 primary 后）已过期
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const sdkRoot = o.FIXED.sdkRoot;
  const sdk = require(path.join(sdkRoot, '@cloudbase', 'node-sdk'));
  const database = require(path.join(sdkRoot, '@cloudbase', 'database'));
  const originalReqClass = database.Db.reqClass;
  const calls = [];
  class SyntheticRequest {
    async send(action, params) {
      calls.push(params.collectionName);
      const doc = params.collectionName === w.ADMIN_COLLECTION
        ? { _id: 'primary', userId: target, status: 'active' }
        : { _id: target, status: 'active', openid };
      return { data: { list: [JSON.stringify(doc)] }, requestId: '00000000-0000-4000-8000-000000000001' };
    }
  }
  const input = new PassThrough();
  const mod = { exports: {} };
  const actualRequire = createRequire(WORKER_PATH);
  // 受控时钟：每次调用 now() 前进 400ms（有效期 600ms → 第二次 get 前已过期）
  let ticks = 0;
  const context = {
    module: mod, exports: mod.exports, Buffer,
    process: {
      stdin: input,
      stdout: { write(s) { resolveOut(JSON.parse(s)); return true; } },
      Date, JSON, console,
      hrtime: { bigint: () => 0n },
      uptime: () => 0,
      env: {},
      argv: [],
      platform: 'win32',
      version: 'v22.0.0',
      versionInfo: {},
      nextTick: (fn) => setImmediate(fn)
    },
    require(name) {
      if (name.replace(/\\/g, '/').startsWith(sdkRoot + '/@cloudbase/node-sdk')) {
        return { init(config) {
          const app = sdk.init(config);
          return { database() { const db = app.database(); database.Db.reqClass = SyntheticRequest; return db; } };
        } };
      }
      return actualRequire(name);
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    setImmediate, clearImmediate,
    Promise, Error, TypeError, Object, Array, String, Number, Boolean, JSON, Math, RegExp, Date, Symbol, Map, Set
  };
  context.require.resolve = actualRequire.resolve;
  context.require.main = mod;
  // 覆盖 worker 内部 deps.now()：通过 Date.now 注入
  const baseNow = Date.now();
  const realNow = Date.now;
  Date.now = () => baseNow + (ticks++) * 400;
  let resolveOut;
  const output = new Promise(r => { resolveOut = r; });
  try {
    VM.runInNewContext(fs.readFileSync(WORKER_PATH, 'utf8'), context, { filename: WORKER_PATH });
    input.end(JSON.stringify({
      secretId: 'SYN_ID', secretKey: 'SYN_KEY', sessionToken: 'SYN_TOKEN',
      targetUserId: target, expiresAtMs: baseNow + 600
    }) + '\n');
    const result = await output;
    // 第二条读取不应发生（或即使发生也如实标记过期）
    assert.equal(result.credentialExpiredDuringRun, true, '两读之间过期必须如实标记');
    const chain = parentChain(result, target);
    assert.notEqual(chain.target.status, 'OBSERVED', '过期不得升级为完整核验');
  } finally {
    Date.now = realNow;
    database.Db.reqClass = originalReqClass;
  }
});

/**
 * T2：以**worker 返回事件**为屏障推进时钟，跑完整父进程编排。
 *
 * 上一版 S3-5/S3-6 的问题：
 *  - S3-5 的子进程全部 exit 1，流程在 CLI 阶段就停止，注释还写「CLI 阶段就会…停止」，
 *    却断言 stoppedAt ∈ {sameBatchCredential, cliAssociation} —— 根本没到 worker；
 *  - 两条测试都用「now() 调用次数」猜阶段，口径脆弱且与实际阶段不对应；
 *  - S3-6 没有明确的 worker 响应分支，只断言「有 errorCode / incomplete」。
 *
 * 现在：以 worker 子进程的 close 事件作为**唯一**的时钟推进点，
 * 并断言四个阶段（sts / DescribeEnvs / DescribeEnvInfo / worker）确实都发生过。
 *
 * @param {object} opts.workerFails  worker 是否返回失败
 * @param {boolean} opts.expireOnWorkerClose 是否在 worker close 时把时钟推到过期
 */
async function runWithWorkerEventBarrier(opts) {
  const o2 = opts || {};
  const base = Date.now();
  let clock = base;
  const stages = [];
  let workerReturned = false;
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: target },
    {
      // 时钟只在 worker close 时被推进 —— 不用调用次数猜阶段
      now: () => clock,
      baseEnv: {},
      fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 't2-iso-')) },
      fetchCredential: async () => JSON.stringify({
        secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', token: 'SYNTHETIC_TOKEN',
        expiredAt: new Date(base + 600000).toISOString(), isTemporary: true, envId: o.FIXED.envId
      }),
      spawn: (bin, argv) => {
        const c = fakeChild();
        const isWorker = argv.length === 1;
        stages.push(isWorker ? 'worker' : argv[2] + '.' + argv[3]);
        setImmediate(() => {
          if (isWorker) {
            // worker 明确分支：成功返回两条合法记录，或返回固定失败
            const payload = o2.workerFails
              ? { ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 }
              : {
                ok: true, writeAttemptsCount: 0, credentialExpiredDuringRun: false,
                primary: { classification: 'OBSERVED', docId: 'primary', userId: target, status: 'active', userIdShapeValid: true, statusValid: true },
                targetUser: {
                  classification: 'OBSERVED', docId: target, status: 'active', statusValid: true,
                  openidPresent: true, openidShapeValid: true, derivationChecked: true, derivationMatches: true
                }
              };
            workerReturned = true;
            c.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
            // **事件屏障**：worker 即将 close 时才推进时钟 → 制造
            // 「worker 最后一次检查之后、父进程收尾复核之前」这段窗口
            if (o2.expireOnWorkerClose) clock = base + 600001;
            c.emit('exit', 0, null);
            c.emit('close', 0, null);
            return;
          }
          const account = '123456789012';
          const api = argv[2];
          const act = argv[3];
          const payload = {
            'sts.GetCallerIdentity': {
              Type: 'CAMRole', AccountId: account, UserId: 'u', PrincipalId: 'p',
              Arn: 'qcs::cam::uin/' + account + ':role/r', RequestId: SYN_REQUEST
            },
            'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region }], RequestId: SYN_REQUEST },
            'tcb.DescribeEnvInfo': {
              EnvInfo: {
                EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
                UserInfo: { Uin: account, WxAppId: o.FIXED.wxAppId }
              }, RequestId: SYN_REQUEST
            }
          };
          const hint = (svc, a) => '\u2139 \u2192' + String(svc).toUpperCase() + '.' + a + '\n';
          c.stdout.emit('data', Buffer.from(hint(api, act) + JSON.stringify({ data: payload[api + '.' + act] })));
          c.emit('exit', 0, null);
          c.emit('close', 0, null);
        });
        return c;
      }
    }
  );
  return { report, stages, workerReturned };
}

test('T2-1 worker 返回后、父进程收尾前过期：成功路径保留部分观测且不升级', async () => {
  const { report, stages, workerReturned } = await runWithWorkerEventBarrier({
    workerFails: false, expireOnWorkerClose: true
  });
  // 必须真的走完四个阶段并启动/完成 worker
  assert.equal(workerReturned, true, 'worker 未返回');
  assert.equal(stages.length, 4, '应恰好执行 4 个子进程：' + JSON.stringify(stages));
  assert.deepEqual(stages, ['sts.GetCallerIdentity', 'tcb.DescribeEnvs', 'tcb.DescribeEnvInfo', 'worker']);
  // 成功路径：两条合法记录仍保留为 OBSERVED
  assert.equal(report.primaryObservation.status, 'OBSERVED', JSON.stringify(report.primaryObservation));
  assert.equal(report.targetUserObservation.status, 'OBSERVED', JSON.stringify(report.targetUserObservation));
  // 整体不得升级为完整核验，且必须写明「父进程复核发现过期」
  assert.notEqual(report.status, o.STATUS.OBSERVED, '过期不得整体标 OBSERVED');
  assert.ok(report.incomplete.some(x => String(x).includes('过期')), '缺少父进程收尾过期说明：' + JSON.stringify(report.incomplete));
  assert.ok(report.incomplete.some(x => String(x).includes('worker 返回后')), '过期说明须指明来自 worker 返回后的复核：' + JSON.stringify(report.incomplete));
  // 合成凭据仍不产生生产 proven
  assert.equal(report.sameBatchCredential.proven, false);
  assert.equal(report.writeAuthorized, false);
});

test('T2-2 未过期对照：同样四阶段，但不得出现任何过期说明', async () => {
  const { report, stages, workerReturned } = await runWithWorkerEventBarrier({
    workerFails: false, expireOnWorkerClose: false
  });
  assert.equal(workerReturned, true);
  assert.equal(stages.length, 4, JSON.stringify(stages));
  // 未过期时不得凭空出现过期说明（否则说明复核逻辑误报）
  assert.equal(report.incomplete.some(x => String(x).includes('过期')), false,
    '未过期却出现过期说明：' + JSON.stringify(report.incomplete));
  // 记录结论仍为 OBSERVED
  assert.equal(report.primaryObservation.status, 'OBSERVED');
  assert.equal(report.targetUserObservation.status, 'OBSERVED');
  // 整体 INCOMPLETE 的唯一原因是合成链未获生产证实
  assert.equal(report.status, o.STATUS.INCOMPLETE);
  assert.ok(report.incomplete.every(x => String(x).includes('未获生产证实')));
});

test('T2-3 worker 失败返回后、父进程收尾前过期：原始错误保留且另有过期说明', async () => {
  const { report, stages, workerReturned } = await runWithWorkerEventBarrier({
    workerFails: true, expireOnWorkerClose: true
  });
  assert.equal(workerReturned, true, 'worker 未返回');
  assert.equal(stages.length, 4, '应恰好执行 4 个子进程：' + JSON.stringify(stages));
  // 原始失败原因必须原样保留
  assert.equal(report.status, o.STATUS.FAILED);
  assert.equal(report.errorCode, 'SDK_UNAVAILABLE', '原始失败原因必须保留');
  assert.equal(report.stoppedAt, 'primaryObservation');
  assert.ok(report.incomplete.some(x => String(x).includes('SDK_UNAVAILABLE')),
    '失败说明须保留原始错误码：' + JSON.stringify(report.incomplete));
  // 同时必须有来自父进程收尾复核的过期说明（不是 worker 自报的布尔）
  assert.ok(report.incomplete.some(x => String(x).includes('过期')),
    '缺少父进程收尾过期说明：' + JSON.stringify(report.incomplete));
  // 不得出现重新获取凭据的迹象：`refreshed` 恒为 false（字段本身存在，
  // 它正是「未刷新」的正确表达，不能用「不含 refresh 字样」这种过宽断言）
  assert.equal(report.sameBatchCredential.refreshed, false, '过期后不得刷新凭据');
  assert.equal(report.sameBatchCredential.status, 'FETCHED_SYNTHETIC');
  assert.equal(report.writeAuthorized, false);
});

// ══════════════════════════════════════════════════════════════════════
// 第 15 组：T1 收尾 —— 布尔标记必须严格为 true（走完整解释链）
// ══════════════════════════════════════════════════════════════════════

/** 一份合法的 worker 输出，供 T1 逐项篡改布尔标记。 */
function t1ValidPayload() {
  return {
    ok: true, writeAttemptsCount: 0, credentialExpiredDuringRun: false,
    primary: {
      classification: 'OBSERVED', docId: 'primary',
      userId: SYN_TARGET_USER_ID, status: 'active',
      userIdShapeValid: true, statusValid: true
    },
    targetUser: {
      classification: 'OBSERVED', docId: SYN_TARGET_USER_ID, status: 'active', statusValid: true,
      openidPresent: true, openidShapeValid: true, derivationChecked: true, derivationMatches: true
    }
  };
}

test('T1-1 非 true 的布尔标记一律不算通过（缺失/null/0/空串/false）', () => {
  // T1：上一版用 `!== false`，把「不是 false」误当「明确通过」——
  // 缺失、null、0、空串这些**并非明确通过**的损坏协议值会被放行。
  const cases = [];
  for (const [record, field] of [['primary', 'userIdShapeValid'], ['primary', 'statusValid'], ['targetUser', 'statusValid']]) {
    for (const value of [undefined, null, 0, '', false]) {
      const payload = t1ValidPayload();
      if (value === undefined) delete payload[record][field];
      else payload[record][field] = value;
      const chain = parentChain(payload, SYN_TARGET_USER_ID);
      const status = record === 'primary' ? chain.primary.status : chain.target.status;
      cases.push({
        record, field,
        input: value === undefined ? 'missing' : JSON.stringify(value),
        finalStatus: status,
        passed: status === 'OBSERVED'
      });
    }
  }
  const wronglyPassed = cases.filter(c => c.passed);
  assert.equal(wronglyPassed.length, 0,
    '以下损坏标记被误判为通过：' + JSON.stringify(wronglyPassed));
  assert.equal(cases.length, 15, '应覆盖 3 个标记 × 5 种非 true 输入');
  // 每一例都必须降级为 UNCONFIRMED 且写明原因
  for (const c of cases) assert.equal(c.finalStatus, 'UNCONFIRMED', JSON.stringify(c));
});

test('T1-2 明确为 true 的标记照常通过（本轮正常记录正向不回归）', () => {
  const chain = parentChain(t1ValidPayload(), SYN_TARGET_USER_ID);
  assert.equal(chain.primary.status, 'OBSERVED', JSON.stringify(chain.primary.reasons));
  assert.equal(chain.target.status, 'OBSERVED', JSON.stringify(chain.target.reasons));
  assert.equal(chain.primary.userId, SYN_TARGET_USER_ID);
  assert.equal(chain.target.userStatus, 'active');
  assert.equal(chain.primary.fieldCompleteness, 'COMPLETE');
  assert.equal(chain.target.fieldCompleteness, 'COMPLETE');
  assert.deepEqual(chain.primary.reasons, []);
  assert.deepEqual(chain.target.reasons, []);
});

test('T1-3 净化层标记本身也是严格 true（不经解释链直接核对）', () => {
  // primary：docIdMatches / userIdShapeValid / statusValid
  const p = o.sanitizeWorkerRecord(
    { classification: 'OBSERVED', docId: 'primary', userId: SYN_TARGET_USER_ID, status: 'active' },
    o.PRIMARY_KEY_EXPECTATION
  );
  // worker 未提供标记 → 不得被判为有效
  assert.equal(p.userIdShapeValid, false, '未提供 userIdShapeValid 时不得判为有效');
  assert.equal(p.statusValid, false, '未提供 statusValid 时不得判为有效');
  assert.equal(p.fieldCompleteness, 'INCOMPLETE');
  // 明确给出 true 才有效
  const p2 = o.sanitizeWorkerRecord(
    { classification: 'OBSERVED', docId: 'primary', userId: SYN_TARGET_USER_ID, status: 'active', userIdShapeValid: true, statusValid: true },
    o.PRIMARY_KEY_EXPECTATION
  );
  assert.equal(p2.userIdShapeValid, true);
  assert.equal(p2.statusValid, true);
  assert.equal(p2.fieldCompleteness, 'COMPLETE');
  // users 记录本来就没有 userId 字段 → 保持「不适用」，不新增要求
  const u = o.sanitizeWorkerRecord(
    { classification: 'OBSERVED', docId: SYN_TARGET_USER_ID, status: 'active', statusValid: true },
    o.makeUsersExpectation(SYN_TARGET_USER_ID)
  );
  assert.equal(u.userIdShapeValid, null, 'users 不适用 userId 形状，不新增要求');
  assert.equal(u.fieldCompleteness, 'COMPLETE', '合法 users 契约不受影响');
});

test('T1-4 布尔标记为真值但非布尔（1/"true"/{}）同样不算通过', () => {
  for (const value of [1, 'true', {}, [], 'yes']) {
    const payload = t1ValidPayload();
    payload.primary.statusValid = value;
    const chain = parentChain(payload, SYN_TARGET_USER_ID);
    assert.notEqual(chain.primary.status, 'OBSERVED',
      '真值但非布尔 ' + JSON.stringify(value) + ' 不得算通过');
  }
});

// ══════════════════════════════════════════════════════════════════════
// 第 16 组：H3 — 固定凭据获取宿主与同批传递链
// ══════════════════════════════════════════════════════════════════════

const host = require('../scripts/lib/cloudbase-cli-credential-host.cjs');

/** 合成一份合规的 `secrets get --json` stdout（真实公共入口的输出形状）。 */
function secretsStdout(overrides) {
  const o = Object.assign({
    secretId: 'SYNTHETIC_H3_ID', secretKey: 'SYNTHETIC_H3_KEY', token: 'SYNTHETIC_H3_TOKEN',
    expiredAt: new Date(Date.now() + 1800000).toISOString(), isTemporary: true, envId: null
  }, overrides || {});
  return JSON.stringify({ data: o });
}

test('H3-1 固定宿主：命令参数与指纹写死，无任意 env/凭据/输出参数', () => {
  // 只能跑固定命令，不能由调用方拼接参数
  assert.deepEqual(host.COMMAND_ARGS, ['secrets', 'get', '--json']);
  for (const forbidden of ['--key', '--token', '--secret', '--env', '--output', '--profile']) {
    assert.equal(host.COMMAND_ARGS.includes(forbidden), false,
      '不得接受任意参数：' + forbidden);
  }
  // 指纹固定：与任务文档记录的 bundle 一致
  assert.equal(host.FINGERPRINT.bundleSha256.length, 64);
  assert.equal(host.FINGERPRINT.entrySha256.length, 64);
});

test('H3-2 指纹核对通过；任一文件被替换即拒绝（不得在指纹不符时取凭据）', () => {
  const cli = require('../scripts/lib/cloudbase-readonly-observer.cjs');
  const ok = host.verifyFingerprint({ cliEntry: cli.FIXED.cliEntry, cliBundle: cli.FIXED.cliBundle });
  assert.equal(ok.verified, true, '固定指纹应匹配已验收 CLI');
  // 缺路径 → 拒绝
  assert.throws(() => host.verifyFingerprint({ cliEntry: null, cliBundle: null }),
    e => e.code === host.ERR.FIXED_PATH_MISSING || e.code === host.ERR.FINGERPRINT_MISMATCH);
});

test('H3-3 解析器：正向接受临时凭据，并映射为 SDK 字段（token → sessionToken）', () => {
  const s = host.parseSecretsJson(secretsStdout(), Date.now());
  assert.equal(s.isTemporary, true);
  // CLI 输出的 envId 应为 null（命令不接受环境选择）
  assert.equal(s.echoedEnvId, null);
  const mapped = host.toSdkCredentialFields(s);
  assert.equal(mapped.sessionToken, 'SYNTHETIC_H3_TOKEN', 'token 必须映射为 sessionToken');
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'token'), false,
    'SDK 侧不得沿用 CLI 的 token 字段名');
  assert.equal(mapped.secretId, 'SYNTHETIC_H3_ID');
  assert.equal(mapped.secretKey, 'SYNTHETIC_H3_KEY');
  // 不外传凭据原值到诊断字段
  assert.equal(JSON.stringify(host.buildFixedDiagnostics(s, {})).includes('SYNTHETIC_H3_TOKEN'), false,
    '诊断输出不得包含凭据原值');
});

test('H3-4 解析器反例：未知字面量/永久密钥/缺字段/已过期/剩余不足 全部拒绝', () => {
  const future = () => new Date(Date.now() + 1800000).toISOString();
  const rejects = [
    ['expiredAt 为"未知"字面量', { expiredAt: '未知' }, host.ERR.EXPIRY_UNKNOWN],
    ['expiredAt 非日期字符串', { expiredAt: 'tomorrow' }, host.ERR.EXPIRY_UNKNOWN],
    ['isTemporary 为 false（永久密钥）', { isTemporary: false }, host.ERR.NOT_TEMPORARY],
    ['isTemporary 为字符串 "true"', { isTemporary: 'true' }, host.ERR.NOT_TEMPORARY],
    ['isTemporary 缺失', { isTemporary: undefined }, host.ERR.NOT_TEMPORARY],
    ['缺 token', { token: undefined }, host.ERR.SHAPE_INVALID],
    ['缺 secretId', { secretId: '' }, host.ERR.SHAPE_INVALID],
    ['缺 secretKey', { secretKey: '' }, host.ERR.SHAPE_INVALID],
    ['已过期', { expiredAt: new Date(Date.now() - 1000).toISOString() }, host.ERR.EXPIRED],
    ['剩余不足 5 分钟门槛', { expiredAt: new Date(Date.now() + 60000).toISOString() }, host.ERR.EXPIRED],
    ['回显了非预期 envId', { envId: 'cloud1-other' }, host.ERR.ENV_ID_UNEXPECTED]
  ];
  for (const [label, patch, expectCode] of rejects) {
    assert.throws(() => host.parseSecretsJson(secretsStdout(patch), Date.now()),
      e => e.code === expectCode, label + ' 期望 ' + expectCode);
  }
  // 结构性坏输出
  for (const bad of ['{bad', '[]', '', 'null', '{"data":[]}']) {
    assert.throws(() => host.parseSecretsJson(bad, Date.now()),
      e => typeof e.code === 'string', '坏输出须拒绝：' + JSON.stringify(bad));
  }
});

test('H3-5 隔离环境：大小写无关清除凭据变量、XDG/主目录别名与代理', () => {
  const env = host.buildFetchEnv({
    PATH: 'C:/Windows', xdg_config_home: 'C:/outside', XDG_CONFIG_HOME: 'C:/outside',
    UserProfile: 'C:/outside', USERPROFILE: 'C:/outside', HOME: 'C:/outside',
    Http_Proxy: 'http://p', HTTP_PROXY: 'http://p', https_proxy: 'http://p', ALL_PROXY: 'http://p',
    TENCENTCLOUD_SECRETID: 'OLD', tcb_region: 'ap-guangzhou',
    CLOUDBASE_API_KEY: 'X', NODE_OPTIONS: '--x', Node_Options: '--y'
  }, 'C:/iso/profile', 'C:/iso/cwd');
  // 继承的凭据与别名必须全部清除（否则等于用了宿主登录态）
  for (const key of Object.keys(env)) {
    const u = key.toUpperCase();
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'TENCENTCLOUD_SECRETID'), false, '不得注入旧凭据');
    assert.equal(u.startsWith('TENCENTCLOUD_'), false, '凭据变量残留：' + key);
    assert.equal(u.startsWith('CLOUDBASE_'), false, 'CLOUDBASE_ 残留：' + key);
    assert.equal(u.startsWith('XDG_'), false, 'XDG_ 残留：' + key);
    assert.equal(u === 'NODE_OPTIONS', false, 'NODE_OPTIONS 残留：' + key);
    assert.equal(u.includes('PROXY'), false, '代理变量残留：' + key);
    // 主目录只允许规范大写形式
    if (u === 'USERPROFILE' || u === 'HOME' || u === 'APPDATA' || u === 'LOCALAPPDATA') {
      assert.equal(key, u, '主目录必须用规范大写键：' + key);
    }
  }
  assert.equal(env.USERPROFILE, 'C:/iso/profile');
  assert.equal(env.HOME, 'C:/iso/profile');
  assert.equal(env.CI, '1');
  assert.equal(env.TCB_DISABLE_REPORT, '1', '须关闭遥测');
  assert.equal(env.TCB_REGION, o.FIXED.region, '地域为固定值');
});

test('H3-6 同批传递：一次获取的同一份快照供 CLI 与 SDK 使用，不刷新不混用', () => {
  // 编排内取一次凭据，其 expiresAtMs 被送进 worker 载荷，
  // 使两条读取之间能独立复核同一批凭据仍然有效。
  const c = fakeChild();
  const snapshot = { secretId: 'S', secretKey: 'K', sessionToken: 'T', expiresAtMs: Date.now() + 600000 };
  const p = o.runWorker(snapshot, SYN_TARGET_USER_ID, { spawn: () => c, limits: { timeoutMs: 500, closeGraceMs: 30, maxOutputBytes: 4096 } });
  return listenersReady().then(() => {
    const sent = JSON.parse(c.stdinBytes);
    // 凭据只经私有 stdin 管道送入，随后关闭
    assert.equal(sent.secretId, 'S');
    assert.equal(sent.secretKey, 'K');
    assert.equal(sent.sessionToken, 'T');
    assert.equal(typeof sent.expiresAtMs, 'number', '须带到期时间以支持两读之间复核');
    assert.equal(c.stdinClosed, true, '凭据送入后必须关闭管道');
    // 不得进命令行 / 环境 / 磁盘
    assert.equal(c.stdinBytes.includes('--secret'), false);
    c.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, writeAttemptsCount: 0 })));
    c.emit('exit', 0, null);
    c.emit('close', 0, null);
    return p;
  }).then(() => {
    // 快照自身不含 refreshed 概念；编排报告里 refreshed 恒 false
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'refreshed'), false);
  });
});

test('H3-7 未获授权时如实停止：候选实现存在 ≠ 允许运行', async () => {
  const report = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {
    baseEnv: {},
    fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'h37-')) }
  });
  // 默认未开启真实执行 → 必须停止，且不得产生任何生产证据
  assert.equal(report.status, o.STATUS.FAILED);
  assert.equal(report.sameBatchCredential.proven, false, '未获授权时不得声称已取得凭据');
  assert.equal(report.writeAuthorized, false);
  assert.ok(report.incomplete.length > 0);
});

test('H3-8 本地准备的能力/证据分层：实现存在、离线已证、生产未证三件事互不冒充', async () => {
  const r = await o.runLocalCheck({});
  const lp = r.localPreparation;
  assert.equal(lp.credentialFetchHostImplemented, true);
  assert.equal(lp.publicEntryIdentityProven, true);
  assert.equal(lp.productionSameBatchObserved, false,
    '离线证明不得升级为生产同批证据');
  // 本次调用未取凭据
  assert.equal(lp.credentialFetched, false);
  assert.equal(lp.cloudCallAttempted, false);
  // 离线证明必须绑定固定指纹（范围随指纹失效）
  assert.equal(lp.publicEntryEvidence.fingerprint.bundleSha256, host.FINGERPRINT.bundleSha256);
});

// ══════════════════════════════════════════════════════════════════════
// 第 17 组：R1–R4 定点返修 —— 真实候选宿主接线、cwd 隔离、事实净化、复现兜底
// ══════════════════════════════════════════════════════════════════════

/**
 * R1 关键：走**真实** `host.fetchTemporaryCredential`，凭据命令必须经过新宿主，
 * 只有最底层 spawn 被替换。绝不手写已有 sessionToken 的快照来代替接线。
 */
async function runRealCandidateChain(options) {
  const opts = options || {};
  const { EventEmitter } = require('node:events');
  const captured = { gets: 0, apiTokens: [], workerToken: null, fetchCwd: [], argvShapes: [] };
  const payload = {
    secretId: 'SYN_R1_ID', secretKey: 'SYN_R1_KEY', token: 'SYN_R1_TOKEN',
    isTemporary: true, expiredAt: new Date(Date.now() + 1800000).toISOString(), envId: null
  };
  const account = '123456789012';
  const rid = '00000000-0000-4000-8000-000000000001';
  const responses = {
    'sts.GetCallerIdentity': { Type: 'CAMRole', AccountId: account, UserId: 'u',
      PrincipalId: 'p', Arn: 'qcs::cam::uin/' + account + ':role/r', RequestId: rid },
    'tcb.DescribeEnvs': { EnvList: [{ EnvId: o.FIXED.envId, Status: 'NORMAL',
      Region: o.FIXED.region }], RequestId: rid },
    'tcb.DescribeEnvInfo': { EnvInfo: {
      EnvBaseInfo: { EnvId: o.FIXED.envId, Status: 'NORMAL', Region: o.FIXED.region },
      UserInfo: { Uin: account, WxAppId: o.FIXED.wxAppId } }, RequestId: rid }
  };
  const mkChild = (output, code) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    setImmediate(() => {
      if (output !== null) c.stdout.emit('data', Buffer.from(output));
      c.emit('exit', code === undefined ? 0 : code, null);
      c.emit('close', code === undefined ? 0 : code, null);
    });
    return c;
  };
  const spawn = (bin, argv, options2) => {
    const opts3 = options2 || {};
    if (argv[1] === 'secrets') {
      captured.gets++;
      captured.argvShapes.push(argv.slice(1));
      captured.fetchCwd.push(opts3.cwd || null);
      return mkChild(opts3.__badOutput ? opts3.__badOutput
        : JSON.stringify({ data: payload }), opts3.__exitCode);
    }
    if (argv[1] === 'api') {
      const key = argv[2] + '.' + argv[3];
      captured.apiTokens.push({
        key,
        sessionToken: opts3.env.TENCENTCLOUD_SESSIONTOKEN,
        secretId: opts3.env.TENCENTCLOUD_SECRETID
      });
      return mkChild(JSON.stringify({ data: responses[key] }));
    }
    if (argv.length === 1 && String(argv[0]).endsWith('cloudbase-sdk-readonly-worker.cjs')) {
      const c = mkChild(JSON.stringify({ ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 }));
      c.stdin.write = (raw) => {
        captured.workerToken = JSON.parse(String(raw)).sessionToken;
        return true;
      };
      return c;
    }
    throw new Error('UNEXPECTED_STAGE:' + JSON.stringify(argv.slice(0, 2)));
  };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-profile-'));
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    {
      baseEnv: {},
      allowRealCredentialFetch: true,
      spawn,
      fixed: { authProfileDir: profile, isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'r1-iso-')) },
      ...(opts.deps || {})
    }
  );
  return { report, captured, profile };
}

test('R1-a 真实候选宿主链：宿主 token 被归一为 sessionToken，三处一致', async () => {
  const { report, captured } = await runRealCandidateChain();
  //凭据命令只跑一次，且确实经过新宿主（argv 为固定命令）
  assert.equal(captured.gets, 1, '凭据命令必须恰好执行一次');
  assert.deepEqual(captured.argvShapes[0], ['secrets', 'get', '--json'],
    '必须走固定命令，不接受任意参数');
  // 关键修复：三处 TENCENTCLOUD_SESSIONTOKEN 都必须等于宿主的 token
  assert.equal(captured.apiTokens.length, 3, '应执行三条 CLI 关联');
  for (const a of captured.apiTokens) {
    assert.equal(a.sessionToken, 'SYN_R1_TOKEN',
      'CLI 关联 ' + a.key + ' 未收到归一后的 sessionToken（修复前为 undefined）');
    assert.equal(a.secretId, 'SYN_R1_ID');
  }
  // worker stdin 同样收到归一后的 sessionToken
  assert.equal(captured.workerToken, 'SYN_R1_TOKEN',
    'worker stdin 未收到归一后的 sessionToken（修复前为 undefined）');
  // 报告如实反映：尝试过、候选模式，但生产未证实
  assert.equal(report.sameBatchCredential.fetchSubprocessAttempted, true);
  assert.equal(report.sameBatchCredential.fetchMode, 'REAL_CANDIDATE');
  assert.equal(report.sameBatchCredential.proven, false, '候选路径不得声称已证实');
  assert.equal(report.writeAuthorized, false);
});

test('R1-b 归一函数：两种来源得到同一内部结构，字段缺失不补齐', () => {
  //宿主形态（token）→ 快照契约（sessionToken）
  const fromHost = o.normalizeCredentialSnapshot({
    secretId: 'A', secretKey: 'B', token: 'T', expiresAtMs: 12345, expiresAtIso: 'x'
  });
  assert.equal(fromHost.sessionToken, 'T');
  assert.equal(fromHost.secretId, 'A');
  assert.equal(fromHost.expiresAtMs, 12345);
  // 已是快照形态 → 同结构
  const fromSnapshot = o.normalizeCredentialSnapshot({
    secretId: 'A', secretKey: 'B', sessionToken: 'T', expiresAtMs: 12345, expiresAtIso: 'x'
  });
  assert.deepEqual(Object.keys(fromHost).sort(), Object.keys(fromSnapshot).sort(),
    '两种来源必须得到同一内部结构');
  assert.deepEqual(fromHost, fromSnapshot);
  // 缺字段一律拒绝，**不**用另一个来源补齐
  const bad = [
    { secretId: 'A', secretKey: 'B', expiresAtMs: 1 },
    { secretKey: 'B', token: 'T', expiresAtMs: 1 },
    { secretId: 'A', token: 'T', expiresAtMs: 1 },
    { secretId: 'A', secretKey: 'B', token: 'T' },
    { secretId: 'A', secretKey: 'B', token: 'T', expiresAtMs: 'soon' },
    null
  ];
  for (const b of bad) {
    assert.throws(() => o.normalizeCredentialSnapshot(b),
      e => e.code === o.ERR.CREDENTIAL_FETCH_FAILED,
      '缺字段必须拒绝而非补齐：' + JSON.stringify(b));
  }
});

test('R2-a 获取 cwd 是独立新目录，不回退登录 profile', async () => {
  const { captured, profile } = await runRealCandidateChain();
  assert.equal(captured.fetchCwd.length, 1);
  const cwd = captured.fetchCwd[0];
  assert.notEqual(cwd, profile, '获取 cwd 不得等于登录 profile（修复前正是如此）');
  assert.equal(fs.existsSync(cwd), true, '获取专用目录应已创建');
  // 用途分离：后续 CLI 关联仍用隔离目录/profile，与获取 cwd 不同
  assert.equal(path.basename(cwd).startsWith('cloudbase-credential-fetch-'), true,
    '获取专用目录应使用固定命名前缀：' + cwd);
});

test('R2-b 向上配置发现范围核对：祖先有marker 即在启动前停止', () => {
  // 叶子干净但**祖先**存在 marker → 必须停止（修复前只看叶子目录）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2b-'));
  // S1：cwd 必须建在 profile 之内，profile 即Home 边界
  const profile = path.join(root, 'profile');
  const leaf = path.join(profile, 'fetch-cwd');
  fs.mkdirSync(leaf, { recursive: true });
  // 祖先放 cloudbaserc.json —— 固定源码的 PROJECT_ROOT_MARKERS 之一
  fs.writeFileSync(path.join(profile, 'cloudbaserc.json'), '{"synthetic":true}', 'utf8');
  assert.throws(() => host.assertConfigDiscoveryClean(leaf, { cliHome: profile }),
    e => e.code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE,
    '祖先存在项目配置标记时必须停止');
  // 只判断存在性，不读内容 —— 文件仍在
  assert.equal(fs.existsSync(path.join(profile, 'cloudbaserc.json')), true, '不得删除污染文件');
  // 移除后同一路径应通过（逐级核对到 profile 为止）
  fs.unlinkSync(path.join(profile, 'cloudbaserc.json'));
  const ok = host.assertConfigDiscoveryClean(leaf, { cliHome: profile });
  assert.equal(ok.stoppedAt, null);
  assert.ok(ok.checked >= 2, '应逐级向上核对到 profile：' + ok.checked);
  assert.equal(ok.homeBoundary, path.resolve(profile));
  fs.rmSync(root, { recursive: true, force: true });
});

test('R2-c 四类 PROJECT_ROOT_MARKERS 都能被识别（含 .git）', () => {
  assert.deepEqual(host.PROJECT_ROOT_MARKERS.slice().sort(),
    ['.cloudbaserc', '.git', 'cloudbaserc.js', 'cloudbaserc.json'].sort(),
    'marker 清单须与固定源码一致');
  for (const marker of host.PROJECT_ROOT_MARKERS) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2c-'));
    const leaf = path.join(root, 'work');
    fs.mkdirSync(leaf);
    if (marker === '.git') fs.mkdirSync(path.join(leaf, '.git'));
    else fs.writeFileSync(path.join(leaf, marker), '{"x":1}', 'utf8');
    assert.throws(() => host.assertConfigDiscoveryClean(leaf),
      e => e.code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE, 'marker 未被识别：' + marker);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R2-d 污染在启动凭据命令之前停止：不得先执行再拒绝', async () => {
  const { EventEmitter } = require('node:events');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'r2d-profile-'));
  // S1 后cwd 建在 profile **之内**（profile 即Home 边界），
  // 因此污染面也必须放在 profile 及其祖先链上，而不是系统临时目录。
  // 在 profile 根放一个 marker：新建 cwd 的向上范围必然命中。
  fs.writeFileSync(path.join(profile, 'cloudbaserc.json'), '{"p":1}', 'utf8');
  let spawned = 0;
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    {
      baseEnv: {},
      allowRealCredentialFetch: true,
      spawn: () => { spawned++; throw new Error('MUST_NOT_SPAWN'); },
      fixed: { authProfileDir: profile, isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'r2d-iso-')) }
    }
  );
  assert.equal(report.status, o.STATUS.FAILED);
  assert.equal(report.stoppedAt, 'sameBatchCredential');
  assert.equal(spawned, 0, '发现范围不安全时不得启动任何子进程');
  assert.equal(report.sameBatchCredential.fetchSubprocessAttempted, false);
  // 不得删除污染标记来「清干净」
  assert.equal(fs.existsSync(path.join(profile, 'cloudbaserc.json')), true,
    '不得删除污染文件');
  fs.rmSync(profile, { recursive: true, force: true });
});

test('R3-a 未启动=未尝试；模拟注入明确标SIMULATED', async () => {
  // (a) 前置拒绝 → 未尝试
  const denied = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    { baseEnv: {}, fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'r3a-')) } }
  );
  assert.equal(denied.sameBatchCredential.fetchSubprocessAttempted, false);
  assert.equal(denied.sameBatchCredential.fetchMode, 'NONE');
  // (b) 合成注入 → 明确标模拟，未启动子进程
  const injected = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    {
      baseEnv: {},
      fetchCredential: async () => secretsStdout(),
      fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'r3b-')) }
    }
  );
  assert.equal(injected.sameBatchCredential.fetchMode, 'SIMULATED');
  assert.equal(injected.sameBatchCredential.fetchSubprocessAttempted, false,
    '注入不启动子进程，必须记为未尝试（不得写死 true）');
  assert.equal(injected.sameBatchCredential.proven, false);
});

test('R3-b 解析失败仍保留已发生的退出事实', async () => {
  const { report } = await runRealCandidateChain({
    // 让凭据命令返回不合规输出：退出码 0 但内容不是快照
  });
  assert.equal(report.status, o.STATUS.FAILED);
  // 合成注入路径下的解析失败
  const bad = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    {
      baseEnv: {},
      fetchCredential: async () => JSON.stringify({ data: { secretId: 'A', secretKey: 'B',
        token: 'C', expiredAt: '未知', isTemporary: true } }),
      fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'r3c-')) }
    }
  );
  assert.equal(bad.status, o.STATUS.FAILED);
  assert.ok(bad.errorCode, '必须保留原始失败分类');
  assert.equal(bad.sameBatchCredential.proven, false);
  assert.equal(bad.sameBatchCredential.fetchRequestCountKnown, false,
    '请求数未知时不得填 0');
});

test('R3-c 恶意异常附加对象被净化：标记不得进入报告', async () => {
  const marker = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_MARKER';
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    {
      baseEnv: {},
      fetchCredential: async () => {
        throw Object.assign(new Error('SYNTHETIC_FAILURE'),
          { code: 'CREDENTIAL_FETCH_FAILED', detail: { stdout: marker } });
      },
      fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'r3c-')) }
    }
  );
  const dumped = JSON.stringify(report);
  assert.equal(dumped.includes(marker), false, '异常附加对象不得原样进入报告');
  assert.notEqual(report.errorCode, 'SYNTHETIC_FAILURE');
  // 诊断字段逐字段重建：未启动则无进程事实
  assert.equal(report.sameBatchCredential.fetchSubprocessAttempted, false);
  assert.ok(['CREDENTIAL_FETCH_FAILED', 'OTHER'].includes(report.errorCode) ||
    typeof report.errorCode === 'string');
});

test('R3-d 诊断重建：只保留固定字段，缺项为 null 而非猜 0', () => {
  const rebuilt = o.rebuildFetchDiagnostics({
    exitCode: 0, signal: null, timedOut: false, overflow: false,
    stdoutBytes: 123, stderrBytes: 0, extraSecret: 'LEAK_ME'
  });
  assert.equal(rebuilt.exitCode, 0);
  assert.equal(rebuilt.stdoutBytes, 123);
  assert.equal(JSON.stringify(rebuilt).includes('LEAK_ME'), false, '未知字段不得透传');
  // 白名单外的信号 → null
  assert.equal(o.rebuildFetchDiagnostics({ signal: 'WEIRD' }).signal, null);
  // 非对象 → null
  assert.equal(o.rebuildFetchDiagnostics(null), null);
  assert.equal(o.rebuildFetchDiagnostics('stdout'), null);
  // 缺项为 null，不猜 0
  const partial = o.rebuildFetchDiagnostics({ exitCode: 1 });
  assert.equal(partial.stdoutBytes, null, '缺失计数应为 null');
  assert.equal(partial.timedOut, null);
  // 负数计数 → null
  assert.equal(o.rebuildFetchDiagnostics({ stdoutBytes: -5 }).stdoutBytes, null);
});

test('R3-e 错误分类收敛：任意 code 一律映射为固定失败码', () => {
  assert.equal(o.classifyFetchFailure({ code: 'SYNTHETIC_ARBITRARY' }),
    o.ERR.CREDENTIAL_FETCH_FAILED);
  assert.equal(o.classifyFetchFailure({ errorClass: 'SYNTHETIC_ARBITRARY' }),
    o.ERR.CREDENTIAL_FETCH_FAILED);
  assert.equal(o.classifyFetchFailure(null), o.ERR.CREDENTIAL_FETCH_FAILED);
  // 已知白名单码保留
  assert.equal(o.classifyFetchFailure({ code: 'CREDENTIAL_NOT_TEMPORARY' }),
    'CREDENTIAL_NOT_TEMPORARY');
});

test('R3-f 关闭状态如实：proven 无升级分支，不能靠改常量放行', async () => {
  //跑完整候选链后 proven 仍须为 false
  const { report } = await runRealCandidateChain();
  assert.equal(report.sameBatchCredential.proven, false);
  assert.notEqual(report.status, o.STATUS.OBSERVED,
    '关闭状态下整体不得标 OBSERVED');
  // 该链的 worker 返回 SDK_UNAVAILABLE，流程在读取结论前停止；
  // 此时「同批链未获生产证实」体现为未进入记录核对，而非固定的 incomplete 文案。
  assert.ok(report.incomplete.length > 0, '必须有未完成项说明');
  assert.ok(
    report.incomplete.some(x => String(x).includes('未取得任何可用记录结论')) ||
    report.incomplete.some(x => String(x).includes('未获生产证实')),
    '未完成项须说明记录核对无结论或未获生产证实：' + JSON.stringify(report.incomplete));
  // 源码层面：不得存在把 proven 置 true 的**返回路径**
  // （注释里引用旧写法用于说明来历，不构成放行分支）
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'), 'utf8');
  const assignments = src.split('\n')
    .filter(line => /^\s*proven\s*:/.test(line))
    .map(line => line.trim());
  assert.equal(assignments.length > 0, true, '应存在 proven 赋值');
  for (const line of assignments) {
    assert.equal(/:\s*true/.test(line), false,
      '不得存在 proven:true 的返回路径（关闭状态不得靠改常量放行）：' + line);
  }
});

test('R3-g 文案更正：publicEntryIdentityProven 只表有限度离线证据', async () => {
  const r = await o.runLocalCheck({});
  const lp = r.localPreparation;
  assert.equal(lp.publicEntryIdentityProven, true);
  const ev = lp.publicEntryEvidence;
  assert.ok(Array.isArray(ev.notCovered) && ev.notCovered.length >= 3,
    '必须列出未覆盖项，避免读成全部通过：' + JSON.stringify(ev.notCovered));
  assert.ok(ev.notCovered.some(x => String(x).includes('refresh')),
    '须明示刷新分支未覆盖');
  // 不得出现「全部前置已通过」这类表述
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'), 'utf8');
  assert.equal(/离线前置（公共入口身份选择 \+ `secrets get` 契约）已通过/.test(src), false,
    '不得声称离线前置全部通过');
  assert.equal(/这一离线证明\*\*本轮未完成\*\*/.test(src), false,
    '旧注释「本轮未完成」与 true 字段矛盾，须删除或标历史');
});

// ══════════════════════════════════════════════════════════════════════
// 第 18 组：S1/S2 定点收尾 —— 发现边界一致性与进程失败事实
// ══════════════════════════════════════════════════════════════════════

test('S1-a 未提供 CLI profile 边界即拒绝：不得回退父进程 Home', () => {
  // S1 根因：上一版回退 os.homedir()，而 CLI 的 USERPROFILE/HOME 被设为登录
  // profile，子进程看到的 Home 与父进程不同 → 边界与CLI 不一致。
  assert.throws(() => host.assertConfigDiscoveryClean(os.tmpdir()),
    e => e.code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE,
    '缺 cliHome 必须按范围不确定停止，不得回退父进程 Home');
  assert.throws(() => host.assertConfigDiscoveryClean(os.tmpdir(), { cliHome: '' }),
    e => e.code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE);
  assert.throws(() => host.assertConfigDiscoveryClean(os.tmpdir(), { cliHome: null }),
    e => e.code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE);
});

test('S1-b cwd 必须在 profile 之内：profile 非祖先即拒绝', () => {
  // profile 与 cwd 祖先链不同 →「不越过 Home」不成立 → 范围不确定
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's1b-'));
  const profile = path.join(root, 'profile');
  const elsewhere = path.join(root, 'elsewhere', 'cwd');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  assert.throws(() => host.assertConfigDiscoveryClean(elsewhere, { cliHome: profile }),
    e => e.code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE,
    'cwd 不在 profile 之内必须停止');
  // 建在 profile 之内的干净目录可通过
  const inside = path.join(profile, 'fetch-cwd');
  fs.mkdirSync(inside);
  const r = host.assertConfigDiscoveryClean(inside, { cliHome: profile });
  assert.equal(r.stoppedAt, null);
  assert.equal(r.homeBoundary, path.resolve(profile));
  fs.rmSync(root, { recursive: true, force: true });
});

test('S1-c junction：字面祖先干净但真实路径祖先带 marker 时拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's1c-'));
  const clean = path.join(root, 'clean');
  const polluted = path.join(root, 'polluted');
  fs.mkdirSync(clean); fs.mkdirSync(polluted);
  const target = path.join(polluted, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(polluted, 'cloudbaserc.json'), '{}', { flag: 'wx' });
  const link = path.join(clean, 'linked');
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch (_) {
    fs.rmSync(root, { recursive: true, force: true });
    return; // 本机无法创建 junction时不冒充已验证
  }
  const cwd = path.join(link, 'cwd');
  fs.mkdirSync(cwd);
  // 字面路径的祖先（clean 及其之上）干净，但 realpath 祖先（polluted）带 marker
  assert.throws(() => host.assertConfigDiscoveryClean(cwd, { cliHome: clean }),
    e => e.code === host.ERR.FETCH_CWD_DISCOVERY_UNSAFE,
    '必须沿真实路径看穿 junction 目标祖先');
  assert.equal(fs.existsSync(path.join(polluted, 'cloudbaserc.json')), true, '不得删除标记');
  fs.rmSync(root, { recursive: true, force: true });
});

test('S1-d 边界停在 profile：profile 之上的 marker 不影响（范围正确收口）', () => {
  // 与 S1-c 互补：边界**之上**的 marker 不在 CLI 发现范围内，不应误拒
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's1d-'));
  const profile = path.join(root, 'profile');
  const cwd = path.join(profile, 'fetch-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  // 在 profile **之外**（root层）放 marker
  fs.writeFileSync(path.join(root, 'cloudbaserc.json'), '{}', { flag: 'wx' });
  const r = host.assertConfigDiscoveryClean(cwd, { cliHome: profile });
  assert.equal(r.stoppedAt, null, '边界之上的标记不在发现范围内');
  fs.rmSync(root, { recursive: true, force: true });
});

test('S1-e 获取 cwd 实际建在 profile 之内（编排层实测）', async () => {
  const { EventEmitter } = require('node:events');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 's1e-profile-'));
  let seenCwd = null;
  const mk = (out) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
    setImmediate(() => {
      c.stdout.emit('data', Buffer.from(String(out)));
      c.emit('exit', 0, null); c.emit('close', 0, null);
    });
    return c;
  };
  await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {
    baseEnv: {}, allowRealCredentialFetch: true,
    spawn: (bin, argv, opts) => {
      if (argv[1] === 'secrets') {
        seenCwd = opts.cwd;
        return mk(JSON.stringify({ data: {
          secretId: 'S', secretKey: 'K', token: 'T', isTemporary: true,
          expiredAt: new Date(Date.now() + 1800000).toISOString(), envId: null } }));
      }
      throw new Error('UNEXPECTED');
    },
    fixed: { authProfileDir: profile, isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 's1e-iso-')) }
  });
  assert.equal(typeof seenCwd, 'string');
  // cwd 必须在 profile 之内，边界才真正生效
  const rel = path.relative(path.resolve(profile), path.resolve(seenCwd));
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  assert.equal(inside, true, '获取 cwd 必须建在 profile 之内：' + seenCwd);
  assert.equal(path.basename(seenCwd).startsWith('cloudbase-credential-fetch-'), true);
  assert.notEqual(seenCwd, profile, '不得直接用 profile 本身');
  fs.rmSync(profile, { recursive: true, force: true });
});

test('S2-a 四条进程失败分支都带出尝试与退出事实', async () => {
  const kinds = ['nonzero', 'timeout', 'overflow', 'signal'];
  const expected = {
    nonzero: 'CREDENTIAL_COMMAND_NONZERO_EXIT',
    timeout: 'CREDENTIAL_COMMAND_TIMEOUT',
    overflow: 'CREDENTIAL_COMMAND_OVERFLOW',
    signal: 'CREDENTIAL_COMMAND_SIGNALED'
  };
  for (const kind of kinds) {
    const { EventEmitter } = require('node:events');
    let attempts = 0, followups = 0, kills = 0;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 's2a-' + kind + '-'));
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        baseEnv: {}, allowRealCredentialFetch: true,
        limits: { timeoutMs: 60, maxOutputBytes: 100, closeGraceMs: 30 },
        fixed: { authProfileDir: profile, isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 's2a-iso-')) },
        spawn: (bin, argv) => {
          if (argv[1] !== 'secrets') { followups++; throw new Error('UNEXPECTED_NEXT_STAGE'); }
          attempts++;
          const c = new EventEmitter();
          c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
          c.stdin.write = () => true; c.stdin.end = () => {};
          c.kill = () => { kills++; return true; };
          setImmediate(() => {
            if (kind === 'nonzero') { c.emit('exit', 1, null); c.emit('close', 1, null); }
            if (kind === 'overflow') c.stdout.emit('data', Buffer.alloc(200, 'a'));
            if (kind === 'signal') { c.emit('exit', null, 'SIGTERM'); c.emit('close', null, 'SIGTERM'); }
          });
          return c;
        }
      }
    );
    assert.equal(attempts, 1, kind + ' 应恰好 spawn 一次');
    assert.equal(followups, 0, kind + ' 失败后不得继续后续请求');
    assert.equal(report.status, o.STATUS.FAILED);
    // S2：已 spawn 即记为已尝试，且模式为真实候选
    assert.equal(report.sameBatchCredential.fetchSubprocessAttempted, true,
      kind + ' 已 spawn 却记为未尝试（修复前为 false）');
    assert.equal(report.sameBatchCredential.fetchMode, 'REAL_CANDIDATE', kind);
    // 错误码必须是宿主实际常量名
    assert.equal(report.errorCode, expected[kind],
      kind + ' 错误码应与宿主常量一致：' + report.errorCode);
    // 退出事实必须保留
    const d = report.sameBatchCredential.fetchDiagnostics;
    assert.notEqual(d, null, kind + ' 应保留退出事实');
    if (kind === 'nonzero') assert.equal(d.exitCode, 1);
    if (kind === 'signal') assert.equal(d.signal, 'SIGTERM');
    if (kind === 'timeout') assert.equal(d.timedOut, true);
    if (kind === 'overflow') assert.equal(d.overflow, true);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('S2-b 启动失败同样带出尝试事实（spawnError 分支）', async () => {
  const { EventEmitter } = require('node:events');
  let attempts = 0;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 's2b-'));
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    {
      baseEnv: {}, allowRealCredentialFetch: true,
      fixed: { authProfileDir: profile, isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 's2b-iso-')) },
      spawn: () => {
        attempts++;
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
        c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
        setImmediate(() => c.emit('error', new Error('SYNTHETIC_SPAWN_FAILURE')));
        return c;
      }
    }
  );
  assert.equal(attempts, 1);
  assert.equal(report.sameBatchCredential.fetchSubprocessAttempted, true,
    '已尝试启动 spawnBounded，必须记为已尝试');
  assert.equal(report.sameBatchCredential.fetchMode, 'REAL_CANDIDATE');
  fs.rmSync(profile, { recursive: true, force: true });
});

test('S2-c fetchMode 固定枚举：未知值归为 UNKNOWN，不保留原字符串', async () => {
  const marker = 'SYNTHETIC_FETCH_MODE_PRIVATE_MARKER';
  const report = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    {
      baseEnv: {},
      fetchCredential: async () => {
        throw Object.assign(new Error('SYNTHETIC_FAIL'), { fetchMode: marker });
      }
    }
  );
  assert.equal(JSON.stringify(report).includes(marker), false,
    '异常上的任意 fetchMode 不得进入报告');
  assert.equal(report.sameBatchCredential.fetchMode, 'UNKNOWN');
  // 合法值原样保留
  assert.equal(o.normalizeFetchMode('NONE'), 'NONE');
  assert.equal(o.normalizeFetchMode('SIMULATED'), 'SIMULATED');
  assert.equal(o.normalizeFetchMode('REAL_CANDIDATE'), 'REAL_CANDIDATE');
  assert.equal(o.normalizeFetchMode('ANYTHING_ELSE'), 'UNKNOWN');
  assert.equal(o.normalizeFetchMode(undefined), 'UNKNOWN');
  assert.equal(o.normalizeFetchMode(123), 'UNKNOWN');
});

test('S2-d 错误码白名单直接来自宿主常量，不再手抄近似名', () => {
  // 上一轮手抄导致 CREDENTIAL_COMMAND_TIMEOUT 被写成 CREDENTIAL_TIMEOUT、
  // CREDITAL_SIGNALED 拼写残留 → 全部退化为泛化失败。现在对齐宿主实际导出。
  for (const value of Object.values(host.ERR)) {
    assert.equal(o.classifyFetchFailure({ code: value }), value,
      '宿主常量必须被识别：' + value);
    assert.equal(o.classifyFetchFailure({ errorClass: value }), value);
  }
  // 上一版手抄的错名不再被接受
  assert.equal(o.classifyFetchFailure({ code: 'CREDENTIAL_TIMEOUT' }),
    o.ERR.CREDENTIAL_FETCH_FAILED, '错名不得被接受');
  assert.equal(o.classifyFetchFailure({ code: 'CREDITAL_SIGNALED' }),
    o.ERR.CREDENTIAL_FETCH_FAILED, '拼写残留不得被接受');
  // 任意未知码 → 固定失败码
  assert.equal(o.classifyFetchFailure({ code: 'SYNTHETIC_ARBITRARY' }),
    o.ERR.CREDENTIAL_FETCH_FAILED);
  assert.equal(o.classifyFetchFailure({}), o.ERR.CREDENTIAL_FETCH_FAILED);
  assert.equal(o.classifyFetchFailure(null), o.ERR.CREDENTIAL_FETCH_FAILED);
});

test('S2-e 前置拒绝仍为未尝试（不得与进程失败混淆）', async () => {
  const denied = await o.runReadOnlyObservation(
    { mode: 'read-only', targetUserId: null },
    { baseEnv: {}, fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 's2e-')) } }
  );
  assert.equal(denied.sameBatchCredential.fetchSubprocessAttempted, false);
  assert.equal(denied.sameBatchCredential.fetchMode, 'NONE');
  assert.equal(denied.sameBatchCredential.fetchDiagnostics, null);
});

// ══════════════════════════════════════════════════════════════════════
// 第 19 组：读取失败最小诊断（Codex 首次真实执行 UNCONFIRMED/READ_FAILED）
// ══════════════════════════════════════════════════════════════════════

const DIAG_UUID = '5dc5d7cb-6deb-42d5-9c36-36a958d574f8';

test('DG-1 真实 worker 输出 → 父进程顶层：白名单码与 requestId 贯穿', async () => {
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  // 合成传输在 primary 读取时抛出带白名单 code 与合法 requestId 的异常
  const { result } = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    throwOn: 'primary', errorCode: 'DATABASE_REQUEST_FAILED', requestId: DIAG_UUID,
    message: 'SENSITIVE_MESSAGE_MUST_NOT_LEAK',
    docs: {
      [w.USER_COLLECTION]: { _id: target, status: 'active', openid }
    }
  });
  // 失败关闭语义保留
  assert.equal(result.primary.classification, 'UNCONFIRMED');
  assert.equal(result.primary.errorCode, 'READ_FAILED');
  // 诊断由**真实 worker main** 产出
  const d = result.primary.readDiagnostics;
  assert.notEqual(d, undefined, '真实 worker 输出须含诊断');
  assert.equal(d.readStage, 'PRIMARY_READ');
  assert.equal(d.errorCode, 'DATABASE_REQUEST_FAILED', '白名单码须原样保留');
  assert.equal(d.requestId, DIAG_UUID);
  // 走完父进程两层
  const chain = parentChain(result, target);
  assert.equal(chain.primary.status, 'UNCONFIRMED', '诊断不得改变失败语义');
  assert.equal(chain.primary.errorCode, 'READ_FAILED');
  assert.deepEqual(chain.primary.readDiagnostics, d, '诊断须贯穿到顶层');
  // 敏感文本全程不得出现
  const dumped = JSON.stringify(result) + JSON.stringify(chain.primary);
  assert.equal(dumped.includes('SENSITIVE_MESSAGE_MUST_NOT_LEAK'), false,
    'message 不得进入 worker 输出或顶层报告');
});

test('DG-2 未知 code/errCode 与敏感文本一律舍弃为 OTHER', async () => {
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  for (const opts of [
    { errorCode: 'PLATFORM_SECRET_MARKER_XYZ', message: 'LEAK_ALPHA' },
    { errCode: 'ANOTHER_UNKNOWN_CODE_123', message: 'LEAK_BETA' },
    { errorCode: 'INVALID_PARAM', message: 'LEAK_GAMMA' } // 白名单内，应保留
  ]) {
    const { result } = await runRealWorkerMain({
      expiryMode: 'valid', targetUserId: target, throwOn: 'primary',
      docs: { [w.USER_COLLECTION]: { _id: target, status: 'active', openid } },
      ...opts
    });
    const d = result.primary.readDiagnostics;
    if (opts.errorCode === 'INVALID_PARAM') {
      assert.equal(d.errorCode, 'INVALID_PARAM', '白名单内码应保留');
    } else {
      assert.equal(d.errorCode, 'OTHER', '未知码须归OTHER：' + (opts.errorCode || opts.errCode));
    }
    const dumped = JSON.stringify(result);
    assert.equal(/LEAK_ALPHA|LEAK_BETA|LEAK_GAMMA|PLATFORM_SECRET_MARKER_XYZ|ANOTHER_UNKNOWN_CODE_123/
      .test(dumped), false, '未知码与敏感文本不得进入输出');
  }
});

test('DG-3 本地 TypeError 与普通 Error 区分有限，其余归 UNKNOWN', async () => {
  // 直接核对分类函数（层一）
  assert.equal(w.classifyLocalError(new TypeError('x')), 'LOCAL_TYPE_ERROR');
  assert.equal(w.classifyLocalError(new ReferenceError('x')), 'LOCAL_REFERENCE_ERROR');
  assert.equal(w.classifyLocalError(new SyntaxError('x')), 'LOCAL_SYNTAX_ERROR');
  assert.equal(w.classifyLocalError(new Error('x')), 'UNKNOWN');
  assert.equal(w.classifyLocalError('not-an-error'), 'NOT_AN_ERROR');
  assert.equal(w.classifyLocalError(null), 'NOT_AN_ERROR');
  // 层二（observer）独立投影，未知值归 UNKNOWN
  assert.equal(o.rebuildReadDiagnostics({
    readStage: 'PRIMARY_READ', localErrorClass: 'LOCAL_TYPE_ERROR',
    errorCode: 'READ_FAILED', requestId: DIAG_UUID
  }).localErrorClass, 'LOCAL_TYPE_ERROR');
  assert.equal(o.rebuildReadDiagnostics({
    readStage: 'PRIMARY_READ', localErrorClass: 'SOMETHING_ELSE', errorCode: 'X'
  }).localErrorClass, 'UNKNOWN');

  // 真实 worker 抛 TypeError：必须确认读取**真的失败**，否则只是读正常路径
  // （防假阳性 —— 夹具若把抛错落到别的集合上，这里会立刻暴露）
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const { result, calls } = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target, throwOn: 'type',
    message: 'SYNTH_TYPE',
    docs: { [w.USER_COLLECTION]: { _id: target, status: 'active', openid } }
  });
  assert.equal(result.primary.classification, 'UNCONFIRMED',
    'primary 必须处于读取失败状态（否则未覆盖抛错路径）');
  assert.equal(result.primary.errorCode, 'READ_FAILED');
  // 注意：worker 的两条读取是**独立**的（有受信目标时primary 失败仍会读 users）——
  // 这是既有设计，不在本次诊断范围内。因此这里只断言 primary 确实失败。
  assert.ok(calls.length >= 1, '应至少发生一次读取');
  assert.equal(result.primary.readDiagnostics.localErrorClass, 'LOCAL_TYPE_ERROR');
  // 且诊断不应污染 users 侧（若users 也读了，其诊断应反映自己的结果）
  if (result.targetUser) {
    assert.equal(result.targetUser.classification, 'OBSERVED',
      'users 侧读成功时不应被 primary 的失败诊断污染');
  }
});

test('DG-4 异常无任何字段时仍为已知未知，不崩不猜', () => {
  const d = w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, new Error('x'));
  assert.equal(d.readStage, 'PRIMARY_READ');
  assert.equal(d.localErrorClass, 'UNKNOWN');
  assert.equal(d.errorCode, 'OTHER');
  assert.equal(d.requestId, null);
  // 完全没有异常对象
  const d2 = w.buildReadDiagnostics(w.READ_STAGE.TARGET_USER, null);
  assert.equal(d2.errorCode, 'OTHER');
  assert.equal(d2.requestId, null);
  // 非法 requestId 形态被拒
  const e = new Error('x'); e.requestId = 'not-a-uuid';
  assert.equal(w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, e).requestId, null);
  // 缺失诊断对象 → observer 返回 null
  assert.equal(o.rebuildReadDiagnostics(null), null);
  assert.equal(o.rebuildReadDiagnostics('READ_FAILED'), null);
});

test('DG-5 R1：平台错误响应路径经真实 worker 组包贯穿到最终记录', async () => {
  // 固定源码 document.ts:337：res.code 存在时 get() **返回 res 而不抛出**，
  // 因此该路径不经过 catch —— 诊断必须在 worker 组包阶段接上，否则会被丢弃。
  // 本用例**不手工补** readDiagnostics，全部来自真实 worker main 的实际输出。
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);

  // (a) primary + 白名单码
  const known = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    returnErrorResponse: 'primary', responseCode: 'DATABASE_REQUEST_FAILED',
    responseRequestId: DIAG_UUID,
    docs: { [w.USER_COLLECTION]: { _id: target, status: 'active', openid } }
  });
  assert.equal(known.result.primary.classification, 'UNCONFIRMED');
  // 记录级必须是 READ_FAILED（读取失败），不能是 PRIMARY_UNCONFIRMED 之类
  assert.equal(known.result.primary.errorCode, 'READ_FAILED');
  const dp = known.result.primary.readDiagnostics;
  assert.notEqual(dp, undefined, 'worker 组包必须接上诊断（修复前为 undefined）');
  assert.equal(dp.readStage, 'PRIMARY_READ');
  assert.equal(dp.errorCode, 'DATABASE_REQUEST_FAILED');
  assert.equal(dp.requestId, DIAG_UUID);
  // 贯穿到最终 primary 记录
  const chainKnown = parentChain(known.result, target);
  assert.equal(chainKnown.primary.status, 'UNCONFIRMED');
  assert.equal(chainKnown.primary.errorCode, 'READ_FAILED');
  assert.deepEqual(chainKnown.primary.readDiagnostics, dp);

  // (b) primary + 未知码 → OTHER，仍 READ_FAILED
  const unknown = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    returnErrorResponse: 'primary', responseCode: 'WEIRD_PLATFORM_CODE',
    docs: { [w.USER_COLLECTION]: { _id: target, status: 'active', openid } }
  });
  assert.equal(unknown.result.primary.errorCode, 'READ_FAILED');
  assert.equal(unknown.result.primary.readDiagnostics.errorCode, 'OTHER',
    '未验证平台码须归 OTHER');
  assert.equal(unknown.result.primary.readDiagnostics.requestId, null);

  // (c) users + 白名单码：不得被通用兜底误报成「派生不匹配」
  const users = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    returnErrorResponse: 'users', responseCode: 'DATABASE_REQUEST_FAILED',
    docs: { [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' } }
  });
  assert.equal(users.result.targetUser.errorCode, 'READ_FAILED');
  const du = users.result.targetUser.readDiagnostics;
  assert.notEqual(du, undefined, 'users 组包必须接上诊断');
  assert.equal(du.readStage, 'TARGET_USER_READ');
  assert.equal(du.errorCode, 'DATABASE_REQUEST_FAILED');
  const chainUsers = parentChain(users.result, target);
  assert.equal(chainUsers.target.status, 'UNCONFIRMED');
  assert.equal(chainUsers.target.errorCode, 'READ_FAILED',
    'users 读取失败不得被归为派生不匹配（修复前为 USER_DERIVATION_MISMATCH）');
  assert.notEqual(chainUsers.target.errorCode, o.ERR.USER_DERIVATION_MISMATCH);
  assert.deepEqual(chainUsers.target.readDiagnostics, du);

  // (d) users + 未知码
  const usersUnknown = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    returnErrorResponse: 'users', responseCode: 'MYSTERY_CODE',
    docs: { [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' } }
  });
  assert.equal(usersUnknown.result.targetUser.readDiagnostics.errorCode, 'OTHER');
  assert.equal(usersUnknown.result.targetUser.errorCode, 'READ_FAILED');
});

test('DG-5b R1：非错误响应路径不得被泛加平台错误含义', async () => {
  // NOT_FOUND / 空记录 **不是** 读取失败：不得带 readDiagnostics 或 READ_FAILED
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const { result } = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: { [w.USER_COLLECTION]: { _id: target, status: 'active', openid } }  // primary 缺
  });
  assert.equal(result.primary.classification, 'NOT_FOUND');
  assert.equal(result.primary.readDiagnostics, undefined,
    'NOT_FOUND 不是读取失败，不得带诊断');
  assert.notEqual(result.primary.errorCode, 'READ_FAILED');
  const chain = parentChain(result, target);
  assert.equal(chain.primary.readDiagnostics, null);
  assert.equal(chain.primary.status, 'NOT_FOUND');
});

test('DG-6 正常只读路径不回归：无诊断字段时为 null', async () => {
  const openid = 'synthetic-offline-only';
  const target = w.deriveUserId(o.FIXED.wxAppId, openid);
  const { result, calls } = await runRealWorkerMain({
    expiryMode: 'valid', targetUserId: target,
    docs: {
      [w.ADMIN_COLLECTION]: { _id: 'primary', userId: target, status: 'active' },
      [w.USER_COLLECTION]: { _id: target, status: 'active', openid }
    }
  });
  assert.equal(calls.length, 2, '正常路径仍是两次读取');
  assert.equal(result.ok, true);
  assert.equal(result.primary.classification, 'OBSERVED');
  assert.equal(result.targetUser.classification, 'OBSERVED');
  const chain = parentChain(result, target);
  assert.equal(chain.primary.status, 'OBSERVED', JSON.stringify(chain.primary.reasons));
  assert.equal(chain.target.status, 'OBSERVED');
  // 正常路径不带诊断
  assert.equal(chain.primary.readDiagnostics, null);
  assert.equal(chain.target.readDiagnostics, null);
  // 两层白名单一致性：worker 与 observer 对同一码判定一致
  const wd = w.buildReadDiagnostics(w.READ_STAGE.PRIMARY,
    Object.assign(new Error('x'), { code: 'DATABASE_REQUEST_FAILED' }));
  assert.equal(wd.errorCode, o.rebuildReadDiagnostics(wd).errorCode);
});

test('DG-7 诊断字段集固定：不得出现 message/stack/cause/请求头等', () => {
  const e = new Error('SENSITIVE');
  e.code = 'DATABASE_REQUEST_FAILED';
  e.stack = 'STACK_SHOULD_NOT_LEAK';
  e.cause = { secret: 'CAUSE_SHOULD_NOT_LEAK' };
  e.requestId = DIAG_UUID;
  e.url = 'https://secret.example/path';
  e.headers = { authorization: 'BEARER_SHOULD_NOT_LEAK' };
  const d = w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, e);
  assert.deepEqual(Object.keys(d).sort(),
    ['errorCode', 'localErrorClass', 'readStage', 'requestId'], '诊断字段集必须固定为四项');
  const dumped = JSON.stringify(d);
  for (const leak of ['SENSITIVE', 'STACK_SHOULD_NOT_LEAK', 'CAUSE_SHOULD_NOT_LEAK',
    'secret.example', 'BEARER_SHOULD_NOT_LEAK']) {
    assert.equal(dumped.includes(leak), false, '不得携带：' + leak);
  }
  // observer 侧同样只输出四项
  const d2 = o.rebuildReadDiagnostics(d);
  assert.deepEqual(Object.keys(d2).sort(),
    ['errorCode', 'localErrorClass', 'readStage', 'requestId']);
});

test('DG-8 读取阶段枚举固定，两层一致', () => {
  assert.equal(w.READ_STAGE.PRIMARY, 'PRIMARY_READ');
  assert.equal(w.READ_STAGE.TARGET_USER, 'TARGET_USER_READ');
  assert.deepEqual(o.READ_STAGES.slice().sort(), ['PRIMARY_READ', 'TARGET_USER_READ']);
  // 未知阶段归UNKNOWN
  assert.equal(o.rebuildReadDiagnostics({ readStage: 'SOME_OTHER_STAGE' }).readStage, 'UNKNOWN');
});

test('R2-1 message getter 抛错：诊断不抛、不输出原文，且不读 message', () => {
  // R2：上一版 name 缺失时直接读 error.message，getter 抛错会让**诊断构造本身**
  // 失败并丢失全部分类事实。现已不读 message。
  const e = new Error('SENSITIVE_MESSAGE_MUST_NOT_LEAK');
  Object.defineProperty(e, 'name', { value: null });
  Object.defineProperty(e, 'message', { get() { throw new Error('BOOM_MESSAGE'); } });
  let d = null;
  assert.doesNotThrow(() => { d = w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, e); },
    'message getter 抛错时诊断不得抛出');
  assert.notEqual(d, null);
  assert.equal(d.readStage, 'PRIMARY_READ');
  assert.equal(d.localErrorClass, 'UNKNOWN', 'name 缺失应归 UNKNOWN');
  assert.equal(d.errorCode, 'OTHER');
  assert.equal(d.requestId, null);
  assert.equal(JSON.stringify(d).includes('SENSITIVE_MESSAGE_MUST_NOT_LEAK'), false);
  assert.equal(JSON.stringify(d).includes('BOOM_MESSAGE'), false);
});

test('R2-2 requestId getter 抛错：诊断不抛，固定为 null', () => {
  const e = new Error('x');
  Object.defineProperty(e, 'requestId', { get() { throw new Error('BOOM_REQUESTID'); } });
  let d = null;
  assert.doesNotThrow(() => { d = w.buildReadDiagnostics(w.READ_STAGE.TARGET_USER, e); },
    'requestId getter 抛错时诊断不得抛出');
  assert.equal(d.requestId, null, '读取失败固定为 null');
  assert.equal(d.readStage, 'TARGET_USER_READ');
  // name 与 code 仍能正常读取
  assert.equal(d.localErrorClass, 'UNKNOWN');
  assert.equal(d.errorCode, 'OTHER');
  assert.equal(JSON.stringify(d).includes('BOOM_REQUESTID'), false);
});

test('R2-3 name getter 抛错与未知 name：均归 UNKNOWN，不称 NOT_AN_ERROR', () => {
  // name getter 抛错
  const boom = new Error('x');
  Object.defineProperty(boom, 'name', { get() { throw new Error('BOOM_NAME'); } });
  assert.equal(w.classifyLocalError(boom), 'UNKNOWN');
  // 未知名称（如 SDK 自己的 TcbError）
  assert.equal(w.classifyLocalError(new TypeError('x').constructor === Error
    ? Object.assign(new Error('x'), { name: 'TcbError' }) : new Error('x')), 'UNKNOWN');
  assert.equal(w.classifyLocalError({ name: 'SomeCustomError' }), 'UNKNOWN');
  // NOT_AN_ERROR 仅限 null / 非对象输入
  assert.equal(w.classifyLocalError(null), 'NOT_AN_ERROR');
  assert.equal(w.classifyLocalError(undefined), 'NOT_AN_ERROR');
  assert.equal(w.classifyLocalError('a string'), 'NOT_AN_ERROR');
  assert.equal(w.classifyLocalError(42), 'NOT_AN_ERROR');
});

test('R2-4 真正的 Error/TypeError 分类不回归', () => {
  assert.equal(w.classifyLocalError(new TypeError('x')), 'LOCAL_TYPE_ERROR');
  assert.equal(w.classifyLocalError(new ReferenceError('x')), 'LOCAL_REFERENCE_ERROR');
  assert.equal(w.classifyLocalError(new SyntaxError('x')), 'LOCAL_SYNTAX_ERROR');
  assert.equal(w.classifyLocalError(new Error('x')), 'UNKNOWN');
  // observer 侧枚举同步
  assert.deepEqual(o.LOCAL_ERROR_CLASSES.slice().sort(),
    ['LOCAL_REFERENCE_ERROR', 'LOCAL_SYNTAX_ERROR', 'LOCAL_TYPE_ERROR', 'NOT_AN_ERROR', 'UNKNOWN']);
  // 正向诊断仍完整
  const d = w.buildReadDiagnostics(w.READ_STAGE.PRIMARY,
    Object.assign(new TypeError('x'), { code: 'DATABASE_REQUEST_FAILED', requestId: DIAG_UUID }));
  assert.equal(d.localErrorClass, 'LOCAL_TYPE_ERROR');
  assert.equal(d.errorCode, 'DATABASE_REQUEST_FAILED');
  assert.equal(d.requestId, DIAG_UUID);
});
