#!/usr/bin/env node
'use strict';
/**
 * WorkBuddy M1/M2/M3 S1–S3 收尾复现（SDK 只读身份接入）— 2026-10-08
 *
 * 依据：docs/Codex复核-SDK只读身份R1-R5返修-20261008.md 第 2–4 节。
 *
 * 覆盖的真实缺陷
 * ────────────
 *  S1 users 从worker 到最终报告的实际契约不一致：
 *     - worker 输出 `userStatus`，父进程净化器读 `status`；
 *     - `interpretWorkerOutput` 对 targetUser 传 `expectation=null`，
 *       既不保留状态、又默认要求 primary 才有的 userId → 合法记录被误降级；
 *     - 已净化记录被**再净化一次**，失败原因在第二趟丢失。
 *  S2 剩余自由文本出口：任意 errorCode / 非 OBSERVED 的 docId / 任意 requestId。
 *  S3 有效期在 worker 输入端缺失即放行，且父进程 worker 返回后少一次复核。
 *
 * 严格边界
 * ──────
 * - 全部离线：不执行官方 CLI、不联网、不获取任何真实凭据、不安装、不初始化、不部署。
 * - 涉及真实 SDK 的样本**只把请求传输替换为合成只读传输**；
 *   执行的是 worker 源码里的真实 main()（真实形状校验、真实 init/database、
 *   真实 normalizeReadResult、真实 emit），因此能证明 worker → 父进程整条链。
 * - 不读认证内容；不读取 auth.json；不查旧业务集合。
 * - 产物只写 stdout；**不覆盖任何历史证据**。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..', '..');
const MINIAPP = path.join(ROOT, 'miniapp');
const WORKER_PATH = path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-worker.cjs');
const o = require(path.join(MINIAPP, 'scripts', 'lib', 'cloudbase-sdk-readonly-observer.cjs'));
const w = require(WORKER_PATH);
const SDK_ROOT = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';

const SYN_OPENID = 'synthetic-offline-only';
const SYN_TARGET = w.deriveUserId('wxfb4db1615ac15531', SYN_OPENID);
const MARKER = 'SYNTHETIC_PRIVATE_MARKER';
const UUID_V4 = '00000000-0000-4000-8000-000000000001';
const SYN_ACCOUNT = '123456789012';

const results = [];
function record(id, pass, detail) {
  results.push(Object.assign({ id, pass: Boolean(pass) }, detail || {}));
}

/**
 * 运行**真实 worker 主入口**（仅替换 SDK 请求传输）。
 * @param {object} opts docs / expiryMode / requestId / targetUserId
 */
async function runRealWorkerMain(opts) {
  const options = opts || {};
  const sdk = require(path.join(SDK_ROOT, '@cloudbase', 'node-sdk'));
  const database = require(path.join(SDK_ROOT, '@cloudbase', 'database'));
  const originalReqClass = database.Db.reqClass;
  const calls = [];
  const docs = options.docs || {};
  const requestId = options.requestId === undefined ? UUID_V4 : options.requestId;
  class SyntheticRequest {
    async send(action, params) {
      calls.push({ action, collection: params.collectionName });
      const doc = docs[params.collectionName];
      return {
        data: { list: doc === undefined ? [] : [JSON.stringify(doc)] },
        requestId
      };
    }
  }
  const input = new PassThrough();
  const mod = { exports: {} };
  const actualRequire = createRequire(WORKER_PATH);
  function localRequire(name) {
    if (name.replace(/\\/g, '/').startsWith(SDK_ROOT + '/@cloudbase/node-sdk')) {
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
    process: {
      stdin: input,
      stdout: { write(s) { resolveOutput(JSON.parse(s)); return true; } }
    }
  };
  try {
    vm.runInNewContext(fs.readFileSync(WORKER_PATH, 'utf8'), context, { filename: WORKER_PATH });
    const payload = {
      secretId: 'synthetic-id', secretKey: 'synthetic-key',
      sessionToken: 'synthetic-token',
      targetUserId: options.targetUserId || null
    };
    if (options.expiryMode === 'valid') payload.expiresAtMs = Date.now() + 600000;
    if (options.expiryMode === 'expired') payload.expiresAtMs = Date.now() - 1;
    if (options.expiryMode === 'infinite') payload.expiresAtMs = Infinity;
    if (options.expiryMode === 'nan') payload.expiresAtMs = NaN;
    if (options.expiryMode === 'string') payload.expiresAtMs = 'not-a-number';
    input.end(JSON.stringify(payload) + '\n');
    const result = await output;
    return { result, calls };
  } finally {
    database.Db.reqClass = originalReqClass;
  }
}

/** 父进程完整处理链：worker 输出 → interpretWorkerOutput → interpretPrimary/interpretTargetUser */
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

const VALID_DOCS = {
  [w.ADMIN_COLLECTION]: { _id: 'primary', userId: SYN_TARGET, status: 'active' },
  [w.USER_COLLECTION]: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID }
};

async function main() {
  // ═══ S1 users 契约 ═══════════════════════════════════════════════════
  {
    const normal = await runRealWorkerMain({ expiryMode: 'valid', targetUserId: SYN_TARGET, docs: VALID_DOCS });
    const chain = parentChain(normal.result, SYN_TARGET);
    record('S1-1-real-worker-main-through-parent-chain',
      normal.calls.length === 2 &&
      normal.result.targetUser.status === 'active' &&
      normal.result.targetUser.userStatus === undefined &&
      chain.primary.status === 'OBSERVED' &&
      chain.target.status === 'OBSERVED' &&
      chain.target.userStatus === 'active' &&
      chain.target.derivationMatches === true &&
      chain.target.fieldCompleteness === 'COMPLETE', {
        actualWorkerReads: normal.calls.length,
        workerUserField: 'status',
        workerUserStatus: normal.result.targetUser.status,
        legacyUserStatusFieldPresent: normal.result.targetUser.userStatus !== undefined,
        finalPrimaryStatus: chain.primary.status,
        finalTargetStatus: chain.target.status,
        finalTargetUserStatus: chain.target.userStatus,
        fieldCompleteness: chain.target.fieldCompleteness,
        note: '正向必须来自真实 worker main 输出经父进程两层处理，不是手写对象'
      });

    // users 记录本来就没有 userId 字段 —— 不得要求
    const noUserId = parentChain({
      ok: true, writeAttemptsCount: 0, credentialExpiredDuringRun: false,
      primary: { classification: 'NOT_FOUND', docId: 'primary' },
      targetUser: {
        classification: 'OBSERVED', docId: SYN_TARGET, status: 'active', statusValid: true,
        openidPresent: true, openidShapeValid: true, derivationMatches: true, derivationChecked: true
      }
    }, SYN_TARGET);
    record('S1-2-users-contract-does-not-require-userid',
      noUserId.normalized.targetUser.userId === null &&
      noUserId.normalized.targetUser.userIdShapeValid === null &&
      noUserId.normalized.targetUser.fieldCompleteness === 'COMPLETE' &&
      noUserId.target.status === 'OBSERVED', {
        userId: noUserId.normalized.targetUser.userId,
        userIdShapeValid: noUserId.normalized.targetUser.userIdShapeValid,
        fieldCompleteness: noUserId.normalized.targetUser.fieldCompleteness,
        finalStatus: noUserId.target.status,
        note: '上一版 interpretWorkerOutput 传 expectation=null，默认要求 primary 才有的 userId'
      });

    // 反例：缺字段 / disabled / 派生不符 / 错记录键
    const missing = await runRealWorkerMain({
      expiryMode: 'valid', targetUserId: SYN_TARGET,
      docs: { [w.ADMIN_COLLECTION]: VALID_DOCS[w.ADMIN_COLLECTION], [w.USER_COLLECTION]: { _id: SYN_TARGET, openid: SYN_OPENID } }
    });
    const cMissing = parentChain(missing.result, SYN_TARGET);
    const disabled = await runRealWorkerMain({
      expiryMode: 'valid', targetUserId: SYN_TARGET,
      docs: { [w.ADMIN_COLLECTION]: VALID_DOCS[w.ADMIN_COLLECTION], [w.USER_COLLECTION]: { _id: SYN_TARGET, status: 'disabled', openid: SYN_OPENID } }
    });
    const cDisabled = parentChain(disabled.result, SYN_TARGET);
    const mismatch = await runRealWorkerMain({
      expiryMode: 'valid', targetUserId: SYN_TARGET,
      docs: { [w.ADMIN_COLLECTION]: VALID_DOCS[w.ADMIN_COLLECTION], [w.USER_COLLECTION]: { _id: SYN_TARGET, status: 'active', openid: 'a-different-openid' } }
    });
    const cMismatch = parentChain(mismatch.result, SYN_TARGET);
    const wrongKey = await runRealWorkerMain({
      expiryMode: 'valid', targetUserId: SYN_TARGET,
      docs: {
        [w.ADMIN_COLLECTION]: VALID_DOCS[w.ADMIN_COLLECTION],
        [w.USER_COLLECTION]: { _id: 'u_' + 'b'.repeat(40), status: 'active', openid: SYN_OPENID }
      }
    });
    record('S1-3-counterexamples-have-reasons',
      cMissing.target.status === 'UNCONFIRMED' && cMissing.target.reasons.length > 0 &&
      cDisabled.target.status === 'UNCONFIRMED' && cDisabled.target.reasons.some(r => String(r).includes('停用')) &&
      cMismatch.target.status === 'UNCONFIRMED' && cMismatch.target.reasons.some(r => String(r).includes('派生')) &&
      wrongKey.result.targetUser.classification === 'UNCONFIRMED_SHAPE', {
        missingStatus: { status: cMissing.target.status, reasons: cMissing.target.reasons },
        disabled: { status: cDisabled.target.status, reasons: cDisabled.target.reasons },
        derivationMismatch: { status: cMismatch.target.status, reasons: cMismatch.target.reasons },
        wrongRecordKey: wrongKey.result.targetUser.classification,
        note: '净化幂等：已净化记录再净化一次会丢原因（上一版 classify 已降级导致 reasons 全丢）'
      });

    // 顶层编排整体：合成 proven=false，但两条合法记录各自 OBSERVED
    const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's1-s3-iso-'));
    const realWorkerPayload = normal.result;
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: SYN_TARGET },
      {
        now: () => Date.now(),
        baseEnv: {},
        fixed: { isolationRoot: isoRoot },
        fetchCredential: async () => JSON.stringify({
          secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', token: 'SYNTHETIC_TOKEN',
          expiredAt: new Date(Date.now() + 1800000).toISOString(), isTemporary: true, envId: o.FIXED.envId
        }),
        spawn: (bin, argv) => {
          const c = new EventEmitter();
          c.stdout = new EventEmitter();
          c.stderr = new EventEmitter();
          c.stdin = new EventEmitter();
          c.stdin.write = () => true;
          c.stdin.end = () => {};
          c.kill = () => true;
          if (argv.length === 1) {
            // worker 子进程：回放真实 worker main 的净化结果
            setImmediate(() => {
              c.stdout.emit('data', Buffer.from(JSON.stringify(realWorkerPayload)));
              c.emit('exit', 0, null);
              c.emit('close', 0, null);
            });
            return c;
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
          setImmediate(() => {
            c.stdout.emit('data', Buffer.from(
              '\u2139 \u2192' + String(api).toUpperCase() + '.' + act + '\n' + JSON.stringify({ data: payload[api + '.' + act] })));
            c.emit('exit', 0, null);
            c.emit('close', 0, null);
          });
          return c;
        }
      }
    );
    record('S1-4-orchestration-report',
      report.sameBatchCredential.proven === false &&
      report.sameBatchCredential.evidenceKind === 'SYNTHETIC_INJECTION' &&
      report.primaryObservation.status === 'OBSERVED' &&
      report.targetUserObservation.status === 'OBSERVED' &&
      report.targetUserObservation.userStatus === 'active' &&
      report.status !== o.STATUS.OBSERVED &&
      report.writeAuthorized === false, {
        syntheticProven: report.sameBatchCredential.proven,
        evidenceKind: report.sameBatchCredential.evidenceKind,
        primaryStatus: report.primaryObservation.status,
        targetStatus: report.targetUserObservation.status,
        targetUserStatus: report.targetUserObservation.userStatus,
        overallStatus: report.status,
        incomplete: report.incomplete,
        note: '合成完整记录 ≠ 生产同批链已证明：整体可为 INCOMPLETE'
      });
    fs.rmSync(isoRoot, { recursive: true, force: true });
  }

  // ═══ S2 错误码/ 记录键 / 请求标识 ═══════════════════════════════════════
  {
    const rawError = o.interpretWorkerOutput({
      code: 0, terminationConfirmed: true, targetUserId: null,
      stdout: JSON.stringify({ ok: false, errorCode: MARKER, writeAttemptsCount: 0 })
    });
    const knownError = o.interpretWorkerOutput({
      code: 0, terminationConfirmed: true, targetUserId: null,
      stdout: JSON.stringify({ ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0 })
    });
    record('S2-1-arbitrary-errorcode-mapped',
      rawError.ok === false &&
      rawError.errorCode !== MARKER &&
      rawError.errorCode === o.ERR.WORKER_FAILED &&
      knownError.errorCode === 'SDK_UNAVAILABLE', {
        arbitraryInput: MARKER,
        arbitraryMappedTo: rawError.errorCode,
        knownPreserved: knownError.errorCode,
        knownAllowlistSize: 11,
        note: '有限映射；未知值用固定失败码，不新增通用脱敏框架'
      });

    const rawDoc = o.interpretPrimary(o.interpretWorkerOutput({
      code: 0, terminationConfirmed: true, targetUserId: null,
      stdout: JSON.stringify({ ok: true, writeAttemptsCount: 0, primary: { classification: 'NOT_FOUND', docId: MARKER } })
    }), null);
    const goodDoc = o.interpretPrimary(o.interpretWorkerOutput({
      code: 0, terminationConfirmed: true, targetUserId: null,
      stdout: JSON.stringify({ ok: true, writeAttemptsCount: 0, primary: { classification: 'NOT_FOUND', docId: 'primary' } })
    }), null);
    record('S2-2-non-observed-docid-must-match-target',
      rawDoc.docId === null && JSON.stringify(rawDoc).includes(MARKER) === false &&
      goodDoc.docId === 'primary', {
        arbitraryDocIdKept: rawDoc.docId,
        markerLeaked: JSON.stringify(rawDoc).includes(MARKER),
        validDocIdKept: goodDoc.docId,
        note: '非 OBSERVED 记录的 docId 只能是请求目标，否则置 null'
      });

    const badRequestId = await runRealWorkerMain({
      expiryMode: 'valid', targetUserId: SYN_TARGET, requestId: MARKER, docs: VALID_DOCS
    });
    record('S2-3-requestid-format-whitelist',
      badRequestId.result.primary.requestId === null &&
      JSON.stringify(badRequestId.result).includes(MARKER) === false &&
      o.safeRequestId('5dc5d7cb-6deb-42d5-9c36-36a958d574f8') === '5dc5d7cb-6deb-42d5-9c36-36a958d574f8' &&
      o.safeRequestId('r-a-1') === null &&
      o.safeRequestId('5dc5d7cb-6deb-12d5-9c36-36a958d574f8') === null, {
        arbitraryRequestIdKept: badRequestId.result.primary.requestId,
        markerLeaked: JSON.stringify(badRequestId.result).includes(MARKER),
        realUuidV4Sample: '5dc5d7cb-6deb-42d5-9c36-36a958d574f8',
        verifiedSamples: 190,
        note: 'docs/证据 下真实只读证据的 190 个 requestId 样本全部为 UUID v4（版本位恒 4，变体位 8/9/a/b）'
      });
  }

  // ═══ S3 有效期在 worker 输入与父进程收尾处闭合 ═════════════════════════
  {
    const missing = await runRealWorkerMain({ expiryMode: 'missing', targetUserId: SYN_TARGET, docs: VALID_DOCS });
    record('S3-1-missing-expiry-zero-reads',
      missing.calls.length === 0 &&
      missing.result.credentialExpiryMissing === true &&
      missing.result.credentialExpiredDuringRun === false &&
      missing.result.primary.classification === 'UNCONFIRMED' &&
      missing.result.targetUser.classification === 'UNCONFIRMED', {
        readsWhenMissing: missing.calls.length,
        expiryMissingFlag: missing.result.credentialExpiryMissing,
        reportedExpired: missing.result.credentialExpiredDuringRun,
        note: '上一版 expiresAtMs===null → return true，在无时效约束下执行了两条 get'
      });

    const illegal = {};
    for (const mode of ['infinite', 'nan', 'string']) {
      const r = await runRealWorkerMain({
        expiryMode: mode, targetUserId: SYN_TARGET,
        docs: { [w.USER_COLLECTION]: { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID } }
      });
      illegal[mode] = { reads: r.calls.length, expiryMissing: r.result.credentialExpiryMissing };
    }
    record('S3-2-illegal-expiry-zero-reads',
      Object.values(illegal).every(v => v.reads === 0 && v.expiryMissing === true), {
        infinite: illegal.infinite, nan: illegal.nan, string: illegal.string,
        note: '无限大等非法截止值不应当作有效期限'
      });

    const valid = await runRealWorkerMain({ expiryMode: 'valid', targetUserId: SYN_TARGET, docs: VALID_DOCS });
    const expired = await runRealWorkerMain({ expiryMode: 'expired', targetUserId: SYN_TARGET, docs: VALID_DOCS });
    record('S3-3-valid-expiry-two-reads-expired-zero',
      valid.calls.length === 2 && valid.result.ok === true &&
      valid.result.credentialExpiryMissing === false &&
      expired.calls.length === 0 && expired.result.credentialExpiredDuringRun === true, {
        validReads: valid.calls.length,
        expiredReads: expired.calls.length,
        expiredFlag: expired.result.credentialExpiredDuringRun,
        note: '有效期限正常两读；已过期零读并如实标记'
      });

    // 两读之间过期（受控时钟）
    const sdk = require(path.join(SDK_ROOT, '@cloudbase', 'node-sdk'));
    const database = require(path.join(SDK_ROOT, '@cloudbase', 'database'));
    const originalReqClass = database.Db.reqClass;
    const betweenCalls = [];
    class SyntheticRequest {
      async send(action, params) {
        betweenCalls.push(params.collectionName);
        const doc = params.collectionName === w.ADMIN_COLLECTION
          ? { _id: 'primary', userId: SYN_TARGET, status: 'active' }
          : { _id: SYN_TARGET, status: 'active', openid: SYN_OPENID };
        return { data: { list: [JSON.stringify(doc)] }, requestId: UUID_V4 };
      }
    }
    const input = new PassThrough();
    const mod = { exports: {} };
    const actualRequire = createRequire(WORKER_PATH);
    let resolveOut;
    const output = new Promise(r => { resolveOut = r; });
    const context = {
      module: mod, exports: mod.exports, Buffer,
      process: {
        stdin: input,
        stdout: { write(s) { resolveOut(JSON.parse(s)); return true; } },
        Date, JSON, console, env: {}, argv: [], platform: 'win32', version: 'v22.0.0',
        hrtime: { bigint: () => 0n }, uptime: () => 0, nextTick: (fn) => setImmediate(fn)
      },
      require(name) {
        if (name.replace(/\\/g, '/').startsWith(SDK_ROOT + '/@cloudbase/node-sdk')) {
          return {
            init(config) {
              const app = sdk.init(config);
              return { database() { const db = app.database(); database.Db.reqClass = SyntheticRequest; return db; } };
            }
          };
        }
        return actualRequire(name);
      },
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
      Promise, Error, TypeError, Object, Array, String, Number, Boolean, JSON, Math, RegExp, Date, Symbol, Map, Set
    };
    context.require.resolve = actualRequire.resolve;
    context.require.main = mod;
    const baseNow = Date.now();
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => baseNow + (ticks++) * 400;   // 有效期 600ms → 第二条读取前已过期
    let betweenResult = null;
    try {
      vm.runInNewContext(fs.readFileSync(WORKER_PATH, 'utf8'), context, { filename: WORKER_PATH });
      input.end(JSON.stringify({
        secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', sessionToken: 'SYNTHETIC_TOKEN',
        targetUserId: SYN_TARGET, expiresAtMs: baseNow + 600
      }) + '\n');
      betweenResult = await output;
    } finally {
      Date.now = realNow;
      database.Db.reqClass = originalReqClass;
    }
    const betweenChain = parentChain(betweenResult, SYN_TARGET);
    record('S3-4-expired-between-reads',
      betweenResult.credentialExpiredDuringRun === true &&
      betweenChain.target.status !== 'OBSERVED' &&
      betweenCalls.length < 2, {
        readsActuallyIssued: betweenCalls.length,
        expiredFlag: betweenResult.credentialExpiredDuringRun,
        finalTargetStatus: betweenChain.target.status,
        incompleteReasons: betweenChain.target.reasons,
        note: '两条读取之间也要能核对同一批凭据'
      });

    // 父进程 worker 返回后复核（受控时钟，不真等到期）
    // 受控时钟：逐次前移until 「worker 返回后的复核」拿到过期时刻。
    // 用足够大的阈值覆盖全部前置检查，再用 expiryFrom 精确控制过期起点；
    // 首次运行先观察实际调用总数，再校准。
    const baseNow2 = Date.now();
    let clockCalls = 0;
    // 全流程共 13 次 now()（实测）；第 13 次即 worker 返回后的父进程复核
    const EXPIRY_FROM = 12;   // 第 1..12 次有效（worker spawn 在第 12 次），第 13 次 = worker 返回后复核
    const report = await o.runReadOnlyObservation(
      { mode: 'read-only', targetUserId: null },
      {
        now: () => { clockCalls++; const v = clockCalls <= EXPIRY_FROM ? baseNow2 : baseNow2 + 1800001; return v; },
        baseEnv: {},
        fixed: { isolationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 's3-parent-')) },
        fetchCredential: async () => JSON.stringify({
          secretId: 'SYNTHETIC_ID', secretKey: 'SYNTHETIC_KEY', token: 'SYNTHETIC_TOKEN',
          expiredAt: new Date(baseNow2 + 1800000).toISOString(), isTemporary: true, envId: o.FIXED.envId
        }),
        spawn: (bin, argv) => {
          const c = new EventEmitter();
          c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
          c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
          if (argv.length === 1) {
            setImmediate(() => {
              c.stdout.emit('data', Buffer.from(JSON.stringify({
                ok: false, errorCode: 'SDK_UNAVAILABLE', writeAttemptsCount: 0
              })));
              c.emit('exit', 0, null);
              c.emit('close', 0, null);
            });
            return c;
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
          setImmediate(() => {
            c.stdout.emit('data', Buffer.from(
              '\u2139 \u2192' + String(api).toUpperCase() + '.' + act + '\n' + JSON.stringify({ data: payload[api + '.' + act] })));
            c.emit('exit', 0, null);
            c.emit('close', 0, null);
          });
          return c;
        }
      }
    );
    record('S3-5-parent-recheck-after-worker-return',
      report.status === o.STATUS.FAILED &&
      report.errorCode === 'SDK_UNAVAILABLE' &&
      report.incomplete.some(x => String(x).includes('SDK_UNAVAILABLE')) &&
      report.incomplete.some(x => String(x).includes('过期')) &&
      report.writeAuthorized === false, {
        status: report.status,
        stoppedAt: report.stoppedAt,
        originalErrorPreserved: report.errorCode,
        incomplete: report.incomplete,
        clockChecks: clockCalls,
        note: '失败收尾也复核时效，且原始失败原因按原样保留、不重新获取凭据'
      });
  }

  // ═══ 证据分类与未改项 ════════════════════════════════════════════════
  const untouched = {
    'scripts/lib/cloudbase-readonly-observer.cjs': '3b05a3057afc02065cd528965ac2fb6bb162b5d82bc591f87cb718e60dfcf6bb',
    'scripts/check-cloudbase-readonly.cjs': '552dc12269989ec271338153fba036331cc37a27facc13189c3c2a8d0a17ae3a',
    'scripts/lib/sandbox-primary-bootstrap.cjs': '133c21ae4b1081a1e716422862730d518a2194cc8620eb0956a9459a44765614',
    'scripts/prepare-sandbox-primary.cjs': '608aa8854a4213fc81659f2892634cd29e4ba691db1253d34a8e66778c7046e4',
    'scripts/lib/sandbox-primary-sdk-adapter.cjs': '9088e6478b940a4c2db06737effbb9264f12fd1b62778e64cdb3990ef2ec9f1d'
  };
  const crypto = require('node:crypto');
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

  // 历史证据：只读核对，不覆盖
  const histJson = path.join(__dirname, 'WorkBuddyM1M2M3-SDK只读接入复现-20261007.json');
  const histR15 = path.join(__dirname, 'WorkBuddyM1M2M3-R1至R5返修复现-20261008.json');
  const hist = {};
  for (const [k, p] of [['m1m2m3', histJson], ['r1r5', histR15]]) {
    if (!fs.existsSync(p)) continue;
    hist[k] = {
      file: path.basename(p),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
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
    scope: 'M1/M2/M3 S1–S3 收尾（SDK 只读身份接入，本地离线）',
    basedOn: 'docs/Codex复核-SDK只读身份R1-R5返修-20261008.md 第 2–4 节',
    constraints: {
      network: false, executedCli: false, readAuth: false, fetchedRealCredential: false,
      installed: false, initialized: false, deployed: false, createdResources: false,
      wroteFiles: false, historicalEvidenceOverwritten: false
    },
    evidenceTiers: {
      syntheticVerification: '合成凭据/合成 CLI 响应/合成 SDK 传输下的本地行为验证',
      realSdkLocalTransform: '真实 worker main() + 真实 SDK 的 init/database/文档序列化；仅传输层被替换',
      platformUnverified: ['平台原子性', 'IAM 权限', '真实数据库内容', '真实网络行为', '费用/余量', '生产同批凭据链']
    },
    realNetworkCalls: 0,
    realCloudCalls: 0,
    fixedEnvironment: { envId: o.FIXED.envId, appId: o.FIXED.wxAppId, region: o.FIXED.region },
    results,
    blockingGaps: [
      {
        id: 'public-cli-identity-source-not-proven-offline',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: 'R1 的前置条件：受控公共 CLI 离线身份选择证明仍未完成。' +
          '本轮未执行真实 CLI（不执行 bundle、不联网），真实凭据获取宿主保持关闭' +
          '（credentialFetchHostImplemented=false）。S1–S3 只是收尾，不改变这一点。',
        needed: '在受审宿主内以隔离目录 + 合成凭据执行一次公共 api 命令，观察实际选用的身份来源。'
      },
      {
        id: 'same-batch-credential-chain-not-proven-in-production',
        severity: 'BLOCKING_FOR_PRODUCTION',
        detail: '合成完整记录判定（S1-4）**不等于**生产同批链已证明：' +
          'proven 恒为 false，evidenceKind=SYNTHETIC_INJECTION，整体状态为 INCOMPLETE。' +
          '本轮未执行 secrets get --json、未获取任何真实凭据。',
        needed: '受审宿主内按既有只读授权执行一次整组，另存脱敏证据。'
      },
      {
        id: 'parent-post-worker-expiry-check-not-simulated-with-real-subprocess',
        severity: 'EXPECTED_THIS_ROUND',
        detail: 'S3 的父进程收尾复核用**受控时钟**验证，' +
          '未通过真实 worker 子进程模拟「worker 最后检查后、父进程汇总前」这一时段。' +
          '真实子进程下的该窗口仍待受审宿主确认。',
        needed: '真实执行时以受控凭据与真实时间戳观察该窗口。'
      },
      {
        id: 'no-real-database-read-performed',
        severity: 'EXPECTED_THIS_ROUND',
        detail: 'primary / users 均未真实读取。副本是否已有主管理员、指定微信用户记录是否有效**均未知**。',
        needed: '同批凭据链证实后，由受审宿主执行一次只读整组。'
      },
      {
        id: 'requestid-format-whitelist-based-on-190-samples',
        severity: 'EXPECTED_LATER',
        detail: 'requestId 白名单基于真实只读证据中 190 个 UUID v4 样本。' +
          '若平台对数据库读取返回非该格式（如 v1 或无版本号），相关字段会被省略而非报错。',
        needed: '真实执行一次数据库读取后复核其 requestId 形式。'
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
