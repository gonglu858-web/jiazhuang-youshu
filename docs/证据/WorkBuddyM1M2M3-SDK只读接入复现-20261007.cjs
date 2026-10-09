#!/usr/bin/env node
/**
 * WorkBuddy M1/M2/M3 复现（SDK 只读身份接入与管理员核对）— 2026-10-07
 *
 * 目的：为 docs/WorkBuddy任务-SDK只读身份接入与管理员核对-20261007.md 的本地实现
 *       留一份**不含敏感值**的独立证据，供 Codex 审查。
 *
 * 严格边界（与任务一致）
 * ──────────────────
 * - 全部离线：不执行官方 CLI、不联网、不获取任何真实凭据、不安装、不初始化、不部署。
 * - 凭据一律为**合成标记**，只在本进程内存中经 stdin 管道传给 worker 替身。
 * - 探测**源码契约**（认证优先级、SDK 参数名、SDK 请求形状）时只**只读**文件，
 *   不执行 bundle、不提取 webpack 内部模块作生产接口。
 * - 输出不含凭据、原始 OPENID、完整记录、签名头、SDK 实例/配置对象。
 *
 * 本文件**不**证明：平台 IAM 权限、真实数据库内容、真实管理员是否存在、
 * 公共 CLI 在真实执行中确实选用注入凭据（见 gaps 段）。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MINIAPP = path.resolve(__dirname, '..', '..', 'miniapp');
const o = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'));
const w = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs'));

const SYN_SECRET = 'SYNTHETIC_SECRET_MUST_NEVER_LEAK_9f3a';
const SYN_SESSION = 'SYNTHETIC_SESSIONTOKEN_MUST_NEVER_LEAK_7b2e';
const SYN_OPENID = 'oSYNTHETIC-openid-must-never-appear-20261007';
const SYN_ACCOUNT = '100012345678';
const SYN_TARGET = w.deriveUserId(o.FIXED.wxAppId, SYN_OPENID);

const results = [];
let section6 = null;
function record(id, pass, detail) {
  results.push(Object.assign({ id, pass: Boolean(pass) }, detail || {}));
}
function expectCode(code, fn) {
  try {
    fn();
  } catch (e) {
    if (e && e.code === code) return true;
    throw new Error('期望 ' + code + '，实际 ' + (e && e.code) + '：' + (e && e.message));
  }
  throw new Error('期望以 ' + code + ' 拒绝，但未抛错');
}
function secretsPayload(over) {
  return JSON.stringify(Object.assign({
    secretId: SYN_SECRET, secretKey: SYN_SECRET + '-key', token: SYN_SESSION,
    expiredAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    isTemporary: true, envId: o.FIXED.envId
  }, over || {}));
}

// ═══ 1. 源码契约：CLI 认证优先级（隔离可行性的根据） ═══════════════════
const bundle = 'C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/dist/standalone/cli.js';
{
  const src = fs.readFileSync(bundle, 'utf8');
  const bundleSha = crypto.createHash('sha256').update(src).digest('hex');
  const projectFirst = src.includes('getProjectApiKeyCredential(options.cwd)');
  const envFallback = src.includes('const cloudCredentail = resolveCredentialFormEnv();');
  const valueGate = src.includes('hasCredentialValue(localCredential)');
  const authPath = src.includes("path_1.default.join(exports.cloudbaseConfigDir, `${file}.json`)");
  const xdg = src.includes('exports.config = env.XDG_CONFIG_HOME ||') &&
    src.includes("(homeDirectory ? path.join(homeDirectory, '.config') : undefined)");
  const envNames = ['TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN']
    .every(n => src.includes(n));
  record('cli-credential-priority-source', projectFirst && envFallback && valueGate && authPath && xdg && envNames, {
    bundleSha256: bundleSha,
    bundleShaMatchesTaskDoc: bundleSha === '8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97',
    order: 'project(cwd) > authStore(<config>/.cloudbase/auth.json) > TENCENTCLOUD_* env',
    envIsLowestPriority: true,
    configDirFormula: 'XDG_CONFIG_HOME || homedir()/.config  → Windows 下随USERPROFILE 迁移',
    note: '静态源码定位；**不等于**已验证真实执行中确实选用注入凭据'
  });
}

// ═══ 2. 隔离目录：无认证文件才可用，污染即停止且不删文件 ═══════════════
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm123-iso-'));
  const dir = path.join(root, 'run-1');
  fs.mkdirSync(path.join(dir, '.config', '.cloudbase'), { recursive: true });
  const absentBefore = o.authStatePaths(dir).every(p => !fs.existsSync(p));
  const clean = o.assertIsolationClean(dir);
  const pollutedPath = o.authStatePaths(dir)[0];
  fs.writeFileSync(pollutedPath, '{"credential":{"secretId":"x"}}', 'utf8');
  const dirtyStops = expectCode(o.ERR.ISOLATION_DIRTY, () => o.assertIsolationClean(dir));
  const notDeleted = fs.existsSync(pollutedPath);
  fs.rmSync(root, { recursive: true, force: true });
  record('isolation-clean-vs-dirty', absentBefore && clean && dirtyStops && notDeleted, {
    absentBefore, clean, dirtyStops, notDeleted,
    note: '只查位置不读内容；发现污染即停止且未删除任何文件'
  });
}

// ═══ 3. 同批凭据注入：清除继承值，只给子进程注入三字段 ══════════════════
{
  const snap = o.parseSecretsPayload(secretsPayload(), Date.now());
  const env = o.buildIsolatedEnv({
    PATH: 'C:/Windows',
    TENCENTCLOUD_SECRETID: 'INHERITED_MUST_BE_REMOVED',
    TENCENTCLOUD_SECRETKEY: 'INHERITED_MUST_BE_REMOVED',
    TENCENTCLOUD_SESSIONTOKEN: 'INHERITED_MUST_BE_REMOVED',
    CLOUDBASE_API_KEY: 'INHERITED_MUST_BE_REMOVED',
    TCB_REGION: 'ap-guangzhou',
    NODE_OPTIONS: '--require INHERITED_MUST_BE_REMOVED',
    XDG_CONFIG_HOME: 'C:/INHERITED'
  }, snap, 'C:/iso/run-m12');
  const cleared = ['CLOUDBASE_API_KEY', 'NODE_OPTIONS', 'XDG_CONFIG_HOME']
    .every(k => env[k] === undefined);
  const injected = env.TENCENTCLOUD_SECRETID === SYN_SECRET &&
    env.TENCENTCLOUD_SESSIONTOKEN === SYN_SESSION;
  record('same-batch-injection', cleared && injected && env.USERPROFILE === 'C:/iso/run-m12' &&
    env.CI === '1' && env.TCB_REGION === o.FIXED.region, {
    clearedInherited: cleared, injectedSameSnapshot: injected,
    region: env.TCB_REGION, ci: env.CI,
    note: '凭据不进命令行/磁盘；仅注入该子进程；原登录目录未被使用'
  });
}

// ═══ 4. token → sessionToken 映射（读取传入配置对象的底层证据） ═════════
{
  const snap = o.parseSecretsPayload(secretsPayload(), Date.now());
  const cfg = w.buildSdkConfig(snap, {});
  const sdkFile = path.join(o.FIXED.sdkRoot, '@cloudbase', 'node-sdk', 'lib', 'cloudbase.js');
  const sdkSrc = fs.readFileSync(sdkFile, 'utf8');
  record('token-to-sessiontoken-mapping',
    Object.prototype.hasOwnProperty.call(cfg, 'sessionToken') &&
    !Object.prototype.hasOwnProperty.call(cfg, 'token') &&
    cfg.sessionToken === SYN_SESSION &&
    sdkSrc.includes('sessionToken: sessionToken'), {
      sdkConfigKeys: Object.keys(cfg).sort(),
      usesSessionToken: true, usesTokenParamName: false,
      sdkLibSha256: crypto.createHash('sha256').update(fs.readFileSync(sdkFile)).digest('hex'),
      sdkSourceAcceptsSessionToken: true,
      note: 'node-sdk 接收 sessionToken；CLI 输出字段是 token，此处显式映射一次'
    });
}

// ═══ 5. SDK 请求形状：非事务 data 数组（源码定位 + 归一化验证） ════════
{
  const dbFile = path.join(o.FIXED.sdkRoot, '@cloudbase', 'database', 'src', 'document.ts');
  const src = fs.readFileSync(dbFile, 'utf8');
  const nonTxArray = src.includes('data: documents,') && src.includes('if (this._transactionId) {');
  const txSingle = src.includes('data: documents[0] || null,');
  const projection = src.includes('param.projection = stringifyByEJSON(projection)');
  const zero = w.normalizeReadResult({ data: [], requestId: 'r' }, 'primary').classification;
  const one = w.normalizeReadResult({ data: [{ _id: 'primary', userId: SYN_TARGET }], requestId: 'r' }, 'primary').classification;
  const many = w.normalizeReadResult({ data: [{ _id: 'primary' }, { _id: 'primary' }], requestId: 'r' }, 'primary').classification;
  const txShape = w.normalizeReadResult({ data: { _id: 'primary' }, requestId: 'r' }, 'primary').classification;
  record('sdk-request-shape', nonTxArray && txSingle && projection &&
    zero === 'NOT_FOUND' && one === 'OBSERVED' &&
    many === 'UNCONFIRMED_SHAPE' && txShape === 'UNCONFIRMED_SHAPE', {
      nonTransactionReturnsArray: nonTxArray, transactionReturnsSingleObject: txSingle,
      projectionSupported: projection,
      classifications: { zero, one, many, txShape },
      note: '未用事务读替代普通 get；事务形状出现即判不可信'
    });
}

// ═══ 6. 写入口陷阱：零写 ═══════════════════════════════════════════════
{
  const traps = [];
  function coll(name, docs) {
    const mk = (id) => ({
      get: async () => ({ data: docs.filter(x => x._id === id), requestId: 'r' }),
      field() { return this; },
      set() { traps.push(name + '.set'); throw new Error('TRAP'); },
      update() { traps.push(name + '.update'); throw new Error('TRAP'); },
      remove() { traps.push(name + '.remove'); throw new Error('TRAP'); },
      add() { traps.push(name + '.add'); throw new Error('TRAP'); }
    });
    return { doc: (id) => mk(id), set() { traps.push(name + '.set'); throw new Error('TRAP'); },
      update() { traps.push(name + '.update'); throw new Error('TRAP'); },
      remove() { traps.push(name + '.remove'); throw new Error('TRAP'); } };
  }
  const pre = {
    [w.ADMIN_COLLECTION]: coll(w.ADMIN_COLLECTION, [{ _id: 'primary', userId: SYN_TARGET, status: 'active' }]),
    [w.USER_COLLECTION]: coll(w.USER_COLLECTION, [{ _id: SYN_TARGET, status: 'active', openid: SYN_OPENID }])
  };
  const db = {
    collection: (n) => pre[n],
    startTransaction() { traps.push('db.startTransaction'); throw new Error('TRAP'); },
    callFunction() { traps.push('db.callFunction'); throw new Error('TRAP'); }
  };
  // .cjs 不支持顶层 await：第 6 组包进 async 任务，由第 10 组统一 await
  section6 = (async () => {
  const h = w.installWriteTraps(db, [w.ADMIN_COLLECTION, w.USER_COLLECTION]);
  const p1 = await h.primary.doc('primary').field(w.PRIMARY_PROJECTION).get();
  const p2 = await h.users.doc(SYN_TARGET).field(w.USER_PROJECTION).get();
  const n1 = w.normalizeReadResult(p1, 'primary');
  const n2 = w.normalizeReadResult(p2, SYN_TARGET);
  // 派生一致性只在内存比较
  const derived = w.deriveUserId(o.FIXED.wxAppId, n2.doc.openid) === SYN_TARGET;
  const dbTrapWorks = expectCode('READ_ONLY_TRAP', () => db.collection(w.ADMIN_COLLECTION));
  const txTrapWorks = expectCode('READ_ONLY_TRAP', () => db.startTransaction());
  record('zero-write-traps', traps.length === 0 && n1.classification === 'OBSERVED' &&
    n2.classification === 'OBSERVED' && derived && dbTrapWorks && txTrapWorks, {
    writeAttempts: traps.length,
    primaryClass: n1.classification, targetClass: n2.classification,
    derivationMatches: derived, collectionFactoryTrapped: dbTrapWorks, transactionTrapped: txTrapWorks,
    note: '只读路径触发陷阱数 = 0；写入口与事务入口均已封堵'
  });
  })().catch(e => {
    record('zero-write-traps', false, { error: String((e && e.message) || e) });
    throw e;
  });
}

// ═══ 7. primary / users 只读边界各分支 ════════════════════════════════
{
  const base = { classification: 'OBSERVED', docId: 'primary', userId: SYN_TARGET, status: 'active', userIdShapeValid: true, statusValid: true };
  const cases = {
    primaryNotFound: o.interpretPrimary({ primary: { classification: 'NOT_FOUND', docId: 'primary' } }, SYN_TARGET).status,
    primarySameTarget: o.interpretPrimary({ primary: base }, SYN_TARGET).status,
    primaryOtherPerson: o.interpretPrimary({ primary: Object.assign({}, base, { userId: 'u_' + 'b'.repeat(40) }) }, SYN_TARGET).conflictsWithTarget,
    primaryDisabled: o.interpretPrimary({ primary: Object.assign({}, base, { status: 'disabled' }) }, SYN_TARGET).status,
    primaryBadShape: o.interpretPrimary({ primary: { classification: 'UNCONFIRMED_SHAPE', docId: 'primary', reason: '返回 2 条' } }, SYN_TARGET).status,
    usersValid: o.interpretTargetUser({ targetUser: { classification: 'OBSERVED', docId: SYN_TARGET, status: 'active', statusValid: true, derivationMatches: true } }, SYN_TARGET).status,
    usersNotFound: o.interpretTargetUser({ targetUser: { classification: 'NOT_FOUND', docId: SYN_TARGET } }, SYN_TARGET).status,
    usersDisabled: o.interpretTargetUser({ targetUser: { classification: 'OBSERVED', docId: SYN_TARGET, status: 'disabled', statusValid: true, derivationMatches: true } }, SYN_TARGET).status,
    usersDerivationMismatch: o.interpretTargetUser({ targetUser: { classification: 'OBSERVED', docId: SYN_TARGET, status: 'active', statusValid: true, derivationMatches: false } }, SYN_TARGET).status,
    usersNoTarget: o.interpretTargetUser({ targetUser: null }, null).status,
    permissionDeniedNotEmpty: o.interpretPrimary({ primary: { classification: 'UNCONFIRMED', docId: 'primary', errorCode: 'READ_FAILED' } }, SYN_TARGET).status
  };
  const pass = cases.primaryNotFound === 'NOT_FOUND' && cases.primarySameTarget === 'OBSERVED' &&
    cases.primaryOtherPerson === true && cases.primaryDisabled === 'UNCONFIRMED' &&
    cases.primaryBadShape === 'UNCONFIRMED' && cases.usersValid === 'OBSERVED' &&
    cases.usersNotFound === 'NOT_FOUND' && cases.usersDisabled === 'UNCONFIRMED' &&
    cases.usersDerivationMismatch === 'UNCONFIRMED' &&
    cases.usersNoTarget === 'NOT_EXECUTED_TARGET_UNCONFIRMED' &&
    cases.permissionDeniedNotEmpty === 'UNCONFIRMED';
  record('primary-users-boundaries', pass, Object.assign({ cases }, {
    note: '权限拒绝不当作空记录；缺目标不影响 primary 独立观测，但整体不得标完整'
  }));
}

// ═══ 8. 凭据形状 / 时效拒绝 ═══════════════════════════════════════════
{
  const now = Date.now();
  const ok = o.parseSecretsPayload(secretsPayload(), now);
  const rejects = {
    longTermKey: expectCode(o.ERR.CREDENTIAL_NOT_TEMPORARY, () => o.parseSecretsPayload(secretsPayload({ isTemporary: false }), now)),
    truthyIsTemporary: expectCode(o.ERR.CREDENTIAL_NOT_TEMPORARY, () => o.parseSecretsPayload(secretsPayload({ isTemporary: 'true' }), now)),
    unknownExpiry: expectCode(o.ERR.CREDENTIAL_EXPIRY_UNKNOWN, () => o.parseSecretsPayload(secretsPayload({ expiredAt: 'not-a-date' }), now)),
    missingExpiry: expectCode(o.ERR.CREDENTIAL_EXPIRY_UNKNOWN, () => o.parseSecretsPayload(secretsPayload({ expiredAt: undefined }), now)),
    alreadyExpired: expectCode(o.ERR.CREDENTIAL_EXPIRED, () => o.parseSecretsPayload(secretsPayload({ expiredAt: new Date(now - 1000).toISOString() }), now)),
    underThreshold: expectCode(o.ERR.CREDENTIAL_EXPIRED, () => o.parseSecretsPayload(secretsPayload({ expiredAt: new Date(now + 60 * 1000).toISOString() }), now)),
    expiredDuringRun: expectCode(o.ERR.CREDENTIAL_EXPIRED, () => o.assertCredentialFresh(ok, ok.expiresAtMs + 1)),
    badJson: expectCode(o.ERR.CREDENTIAL_SHAPE_INVALID, () => o.parseSecretsPayload('{bad', now)),
    emptyField: expectCode(o.ERR.CREDENTIAL_SHAPE_INVALID, () => o.parseSecretsPayload(secretsPayload({ token: '' }), now))
  };
  record('credential-strictness', Object.values(rejects).every(Boolean), {
    acceptedFields: Object.keys(ok).sort(), rejects,
    minRemainingMs: o.MIN_REMAINING_MS,
    note: '门槛 5 分钟是本轮起点要求，不是对平台有效时长的承诺'
  });
}

// ═══ 9. 参数白名单（无越界开关） ═══════════════════════════════════════
{
  const forbidden = ['--execute', '--approval', '--init', '--initialize', '--deploy',
    '--force', '--skip-checks', '--no-checks', '--allow', '--yes'];
  const noOpenKnobs = ['--env', '--collection', '--url', '--endpoint', '--secret',
    '--token', '--credential', '--auth', '--region', '--appid'];
  const rejectedForbidden = forbidden.every(a => { try { o.parseArgs([a]); return false; } catch (e) { return e.code === o.ERR.ARG_FORBIDDEN; } });
  const rejectedNoKnobs = noOpenKnobs.every(a => { try { o.parseArgs([a, 'x']); return false; } catch (e) { return e.code === o.ERR.ARG_FORBIDDEN; } });
  const unknownRejected = (() => { try { o.parseArgs(['--bogus']); return false; } catch (e) { return e.code === o.ERR.ARG_UNKNOWN; } })();
  const targetStrict = ['12345678', 'u_abc', 'u_' + 'a'.repeat(39)].every(v => { try { o.parseArgs(['--target-user-id', v]); return false; } catch (e) { return e.code === o.ERR.TARGET_USER_ID_INVALID; } });
  const validTarget = o.parseArgs(['--target-user-id', SYN_TARGET]).targetUserId === SYN_TARGET;
  record('argument-whitelist', rejectedForbidden && rejectedNoKnobs && unknownRejected && targetStrict && validTarget, {
    rejectedForbidden, rejectedNoOpenKnobs: rejectedNoKnobs, unknownRejected, targetStrict, validTarget,
    note: '未知/禁止参数在任何云调用之前拒绝；参数不构成授权或现实人员证明'
  });
}

// ═══ 10. 未注入真实凭据来源时如实停止 ═════════════════════════════════
(async () => {
  await section6;
  const ro = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {});
  const local = await o.runLocalCheck({});
  record('honest-stop-without-credentials',
    ro.status === o.STATUS.FAILED && ro.stoppedAt === 'sameBatchCredential' &&
    ro.errorCode === o.ERR.SAME_BATCH_NOT_PROVEN && ro.sameBatchCredential.proven === false &&
    ro.writeAuthorized === false && ro.productionCallerVerifierImplemented === false &&
    local.localPreparation.credentialFetched === false && local.localPreparation.cloudCallAttempted === false, {
    readOnlyStatus: ro.status, stoppedAt: ro.stoppedAt, errorCode: ro.errorCode,
    localStatus: local.status, localCheckCount: local.localPreparation.checks.length,
    writeAuthorized: false, productionCallerVerifierImplemented: false,
    note: '未用合成授权冒充生产核验；本地准备通过但同批凭据链未证实'
  });

  // ═══ 11. 未改项哈希（历史证据与关闭项未被触碰） ═════════════════════
  const untouched = {
    'scripts/lib/cloudbase-readonly-observer.cjs': '3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
    'scripts/check-cloudbase-readonly.cjs': '552dc12269989ec271338153fba036331cc37a27facc13189c3c2a8d0a17ae3a',
    'scripts/lib/sandbox-primary-bootstrap.cjs': '133c21ae4b1081a1e716422862730d518a2194cc8620eb0956a9459a44765614',
    'scripts/prepare-sandbox-primary.cjs': '608aa8854a4213fc81659f2892634cd29e4ba691db1253d34a8e66778c7046e4',
    'scripts/lib/sandbox-primary-sdk-adapter.cjs': '9088e6478b940a4c2db06737effbb9264f12fd1b62778e64cdb3990ef2ec9f1d'
  };
  const hashMismatches = [];
  for (const [rel, expect] of Object.entries(untouched)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(MINIAPP, rel))).digest('hex');
    if (actual !== expect) hashMismatches.push({ file: rel, expected: expect, actual });
  }
  record('untouched-files-unchanged', hashMismatches.length === 0, {
    checked: Object.keys(untouched).length, hashMismatches,
    note: '本轮只新增文件，未修改既有观测器/P4/适配层/初始化 CLI'
  });

  // ═══ 12. 缺口（如实报告，不用测试注入伪装生产核验） ══════════════════
  const gaps = [
    {
      id: 'same-batch-credential-chain-not-proven-in-production',
      severity: 'BLOCKING_FOR_PRODUCTION',
      detail: '本轮未执行 secrets get --json、未获取任何真实凭据，因此「同一批凭据同时供给 CLI 与 SDK」在**生产**层面未证实。' +
        '已证实的是：源码层面的优先级顺序与隔离机制（静态定位），以及合成凭据下的注入路径（替身）。',
      needed: '受审宿主内按既有只读授权执行一次整组，另存脱敏证据。'
    },
    {
      id: 'public-cli-actually-selects-injected-credential-not-executed',
      severity: 'BLOCKING_FOR_PRODUCTION',
      detail: '任务硬停止点要求「用合成凭据验证公共 CLI 在干净目录确实选用注入凭据」。' +
        '本轮**未执行**真实 CLI（不执行 bundle、不联网），故此项未完成。' +
        '源码显示环境变量优先级最低、且 auth.json 位置随 USERPROFILE 迁移，指向隔离可行，' +
        '但**源码不能替代对真实公共入口的离线优先级验证**。',
      needed: '在受审宿主内以隔离目录 + 合成凭据执行一次 `api` 命令并观察实际选用的身份（或等价受审验证）。'
    },
    {
      id: 'no-real-database-read-performed',
      severity: 'EXPECTED_THIS_ROUND',
      detail: 'primary / users 均未真实读取；所有分支结论来自离线替身。' +
        '副本是否已有主管理员、指定微信用户记录是否有效**均未知**。',
      needed: '同批凭据链证实后，由受审宿主执行一次只读整组。'
    },
    {
      id: 'target-user-source-unconfirmed',
      severity: 'EXPECTED_THIS_ROUND',
      detail: '目标 userId 未预填。CLI 接受一个格式严格的完整 userId 作为**只读查询目标**，' +
        '但参数不构成授权，也不构成现实人员证明。缺少受信指定来源时，users 记 NOT_EXECUTED_TARGET_UNCONFIRMED。',
      needed: '由 Codex 把受信指定来源与目标对应好后再执行；不必为此立即要求用户取号或发 OPENID。'
    },
    {
      id: 'sdk-network-retry-count-unverified',
      severity: 'EXPECTED_LATER',
      detail: 'SDK 自身的重试与超时未实测。本轮只固定了 worker 层的 55 秒 / 1 MiB 上限。' +
        '不把业务层一次调用说成网络仅一次。',
      needed: '真实执行时记录实际请求次数与耗时。'
    },
    {
      id: 'permission-denial-vs-collection-missing-unclassified',
      severity: 'EXPECTED_LATER',
      detail: '权限拒绝与网络失败当前都归为 UNCONFIRMED（不猜错误码、不解析自由 message）。' +
        '只有已核实的官方错误契约才能把集合缺失分类为 NOT_EXISTS。',
      needed: '取得官方错误契约后再细分。'
    }
  ];

  const out = {
    observedAt: new Date().toISOString(),
    scope: 'M1/M2/M3 SDK 只读身份接入与管理员核对（本地实现）',
    constraints: {
      network: false, executedCli: false, readAuth: false, fetchedRealCredential: false,
      installed: false, initialized: false, deployed: false, createdResources: false,
      syntheticFixture: true
    },
    realNetworkCalls: 0,
    fixedEnvironment: { envId: o.FIXED.envId, appId: o.FIXED.wxAppId, region: o.FIXED.region,
      cliBundleSha256: o.FIXED.cliBundleSha256 },
    limits: { cli: o.LIMITS.cli, worker: o.LIMITS.worker, minRemainingMs: o.MIN_REMAINING_MS },
    results,
    gaps,
    boundaries: {
      writeAuthorized: false,
      productionCallerVerifierImplemented: false,
      forbiddenCalled: ['identify', 'requestBindingNumber', 'initializePrimary',
        'database transactions', 'cloud functions', 'raw collection names', 'arbitrary queries'],
      collectionsTouched: [w.ADMIN_COLLECTION, w.USER_COLLECTION],
      scopeNote: '仅独立测试副本 schtest_v1_*；未查旧业务 users/app_admins；未处理 A/B/C'
    },
    summary: {
      total: results.length,
      passed: results.filter(r => r.pass).length,
      failed: results.filter(r => !r.pass).length,
      blockingGaps: gaps.filter(g => g.severity === 'BLOCKING_FOR_PRODUCTION').length
    }
  };

  const dest = path.join(__dirname, 'WorkBuddyM1M2M3-SDK只读接入复现-20261007.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.stdout.write('\n[written] ' + dest + '\n');
  if (out.summary.failed > 0) process.exitCode = 1;
})().catch(e => {
  process.stderr.write(String(e && e.stack || e) + '\n');
  process.exitCode = 1;
});