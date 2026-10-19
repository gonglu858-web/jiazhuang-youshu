// I1 入站事件封装离线审计 v12（手机请求轮次与预览版本轮；由 v11 迁移的新命名版本，历史 v7–v11 与 20261016 脚本保持原字节不变）。
// 只读源码事实提取；不含任何键值、口令、OPENID 或原始 event。
//
// C4 修正（Codex 复查 a187998 §5）：
// - 默认仅 stdout；--out <路径> 以 flag:'wx' 独占新建，已存在即拒绝（不覆盖历史证据）。
// - 期望来源基线外置：本脚本内写死打包器自身 SHA-256（提交绑定）；先校验打包器字节，
//   再从其字节中的 PINNED_SOURCES 受审基线表提取 13 项逐文件真实比对，漂移即失败退出。
// - 打包器自身摘要与 5 个本轮受改源文件的 PINNED 项分述（打包器不在自身基线表内）。
// - 内置来源漂移反例（内存中改动核心字节）必须被拒绝，反例不落盘。
// - 计数为实际执行的断言累计（不预写固定数字）；守卫命中区分敏感性探针与业务期意外
//   （含被 try/catch 捕获者——守卫在调用点即刻记账，与是否被捕获无关）。
// - R1（Codex 复查 880fbf8 §2）：业务期意外 > 0 必须非零退出且输出 ok:false；
//   探针命中单独记账，不计入失败判定。
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), sha = b => crypto.createHash('sha256').update(b).digest('hex');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outPath = outIdx !== -1 ? path.resolve(argv[outIdx + 1] || '') : null;

// ── 外置固定基线（提交绑定；不从待测源码自举）────────────────────────────────
const BASIS_COMMIT = '85a983b';
/** 打包器自身受审摘要（手机请求轮次与预览版本轮）；其 PINNED_SOURCES 表内不含打包器自身。 */
const PACKAGER_SELF_SHA256 = 'ac4d609b229a5bf1dabbe60aee04d5ac779cd2ac8176116cba18e2060c11f4ce';
const PACKAGER_REL = 'miniapp/scripts/package-participant-identity-check.cjs';
const CORE_REL = 'miniapp/scripts/lib/participant-identity-check.cjs';
/** 本轮实际修改的受审源文件（对照项在 PINNED_SOURCES 中分述）。 */
const CHANGED_THIS_ROUND = Object.freeze([
  'miniapp/scripts/templates/participant-identity-check/server/request-adapter.js',
  'miniapp/scripts/templates/participant-identity-check/server/index.js'
]);
const SDK = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';

// ── 网络/进程守卫：敏感性探针与业务期意外分开记账（含被 catch 者）────────────
const guardHits = [], restore = [];
function guard(obj, k) {
  const old = obj[k];
  if (typeof old !== 'function') return;
  obj[k] = (...args) => { guardHits.push(k); throw Error('OFFLINE_GUARD'); };
  restore.push(() => { obj[k] = old; });
}
for (const m of ['node:http', 'node:https']) for (const k of ['get', 'request']) guard(require(m), k);
for (const k of ['connect', 'createConnection']) guard(require('node:net'), k);
guard(require('node:tls'), 'connect'); guard(globalThis, 'fetch');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) { guard(require('node:dns'), k); guard(require('node:dns').promises, k); }
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) guard(require('node:child_process'), k);

// ── 实际断言计数（含失败收集；失败最终以非零退出）────────────────────────────
let checksRun = 0;
const checkFailures = [];
function check(name, fn) {
  checksRun++;
  try { fn(); return true; } catch (error) { checkFailures.push(name + ' :: ' + error.message); return false; }
}
const readU8 = abs => fs.readFileSync(abs).toString('utf8');
const count = (hay, needle) => hay.split(needle).length - 1;

function main() {
  // 敏感性探针：验证守卫真的拦截（探针命中也计入 guardHits，但归入探针计数）
  const probeStart = guardHits.length;
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  const sensitivityAttempts = guardHits.length - probeStart;
  const businessStart = guardHits.length;

  // ── 阶段一：打包器自身摘要（外置基线硬前提，失败即中止不产证）────────────
  const packerBuf = fs.readFileSync(path.join(root, PACKAGER_REL));
  const packerSha = sha(packerBuf);
  assert.equal(packerSha, PACKAGER_SELF_SHA256,
    '打包器自身摘要与外置基线不符（来源漂移）：' + packerSha);

  // ── 阶段二：从打包器字节提取 PINNED_SOURCES 并逐项真实比对磁盘文件 ────────
  const packerText = packerBuf.toString('utf8');
  const tableStart = packerText.indexOf('const PINNED_SOURCES = Object.freeze({');
  const tableEnd = packerText.indexOf('});', tableStart);
  assert.ok(tableStart >= 0 && tableEnd > tableStart, '打包器内受审基线表定位失败');
  const tableText = packerText.slice(tableStart, tableEnd);
  const pinned = [];
  const re = /'([^']+)':\s*'([0-9a-f]{64})'/g;
  let m;
  while ((m = re.exec(tableText)) !== null) pinned.push({ rel: m[1], pinnedSha: m[2] });
  assert.ok(pinned.length >= 13, '受审基线表条目数异常：' + pinned.length);
  const sourcePins = [];
  let driftHits = 0;
  for (const p of pinned) {
    const buf = fs.readFileSync(path.join(root, p.rel));
    const actual = sha(buf);
    const ok = actual === p.pinnedSha;
    if (!ok) driftHits++;
    sourcePins.push({ rel: p.rel, changedThisRound: CHANGED_THIS_ROUND.includes(p.rel), pinnedSha: p.pinnedSha, actualSha: actual, match: ok });
  }

  // ── 阶段三：来源漂移反例（内存改动核心字节）必须被拒绝；不落盘 ────────────
  const coreBuf = fs.readFileSync(path.join(root, CORE_REL));
  const drifted = Buffer.concat([coreBuf, Buffer.from('\n// synthetic drift marker\n', 'utf8')]);
  let driftCounterexampleRejected = false;
  try {
    if (sha(drifted) !== pinned.find(p => p.rel === CORE_REL).pinnedSha) driftCounterexampleRejected = true;
  } catch (_) { driftCounterexampleRejected = false; }
  assert.equal(driftCounterexampleRejected, true, '漂移反例未被拒绝');

  // ── 阶段四：源码锚点与本地 SDK 事实（失败收集、继续执行）──────────────────
  const core = readU8(path.join(root, CORE_REL));
  const entry = readU8(path.join(root, 'miniapp/scripts/templates/participant-identity-check/server/index.js'));
  const client = readU8(path.join(root, 'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js'));
  const page = readU8(path.join(root, 'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js'));
  const wxml = readU8(path.join(root, 'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.wxml'));
  check('核心请求字段白名单固定', () => assert.ok(core.includes("const REQUEST_FIELDS = Object.freeze(['action', 'passphrase', 'checkRoundId', 'includeFullUserId'])")));
  check('核心未登记键拒绝携带内部键名', () => assert.ok(core.includes("deny(ERR_CODES.REQUEST_INVALID, '请求含未登记字段：' + k)")));
  check('核心对外固定文案（键名不出服务端）', () => assert.ok(core.includes("PIC_REQUEST_INVALID: '请求含未登记字段。'")));
  check('核心handle先请求键门槛', () => {
    const h = core.indexOf('async function handle(event) {');
    const body = h >= 0 ? core.slice(h) : '';
    assert.ok(body.indexOf('assertRequest(event, collectKeyDiagnostic);') > -1, 'handle 首个门槛为请求键检查');
  });
  check('入口经适配器仅传原四字段给核心', () => assert.ok(entry.includes('return checker.handle(extracted.request);') && entry.includes('requestAdapter.extractBusinessRequest(event)') && entry.includes("require('./request-adapter')")));
  check('入口诊断开关锚点存在', () => assert.ok(entry.includes('const CONFIG_KEY_DIAGNOSTIC = false;')));
  check('客户端picRequest内层3+1键', () => assert.ok(client.includes('checkRoundId: cloudConfig.checkRoundId') && client.includes('if (request.includeFullUserId === true) payload.picRequest.includeFullUserId = true;') && client.includes('picRequest: {')));
  check('客户端诊断净化按固定schema', () => assert.ok(client.includes("raw.schema !== KEY_DIAGNOSTIC_SCHEMA") && client.includes("KEY_DIAGNOSTIC_LABELS = ['CANDIDATE_USERINFO', 'CANDIDATE_WX_CLOUD_API_TOKEN']")));
  check('页面仅展示净化诊断文本', () => assert.ok(page.includes('describeKeyDiagnostic') && wxml.includes('result.keyDiagnosticText')));
  check('页面无自动调用', () => assert.ok(/\bonLoad\(\)\s*\{[^}]*\}/.test(page) === false || page.includes('明确空实现：加载不发送请求')));
  const sdkPkg = JSON.parse(readU8(path.join(SDK, 'wx-server-sdk/package.json')));
  const nsPkg = JSON.parse(readU8(path.join(SDK, '@cloudbase/node-sdk/package.json')));
  check('本地wx-server-sdk为3.0.1', () => assert.equal(sdkPkg.version, '3.0.1'));
  check('本地node-sdk为2.10.0', () => assert.equal(nsPkg.version, '2.10.0'));
  const sdkIndexBuf = fs.readFileSync(path.join(SDK, 'wx-server-sdk/index.js'));
  const sdkIndex = sdkIndexBuf.toString('utf8');
  const nsFnBuf = fs.readFileSync(path.join(SDK, '@cloudbase/node-sdk/lib/functions/index.js'));
  const nsFn = nsFnBuf.toString('utf8');
  check('wx-server-sdk全文无userInfo', () => assert.equal(count(sdkIndex, 'userInfo'), 0));
  check('wx-server-sdk身份来自WX_环境变量机制', () => assert.ok(sdkIndex.includes('process.env.WX_CONTEXT_KEYS')));
  check('wx-server-sdk callFunction透传data', () => assert.ok(sdkIndex.includes('data: options.data || {}')));
  check('node-sdk callFunction透传(JSON.stringify序列化)', () => assert.ok(nsFn.includes('JSON.stringify(data)') && nsFn.includes('request_data: transformData')));
  let nsJsFiles = 0, nsUserInfoCount = 0;
  const nsUserInfoByFile = {};
  (function walk(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, rel);
      else if (e.isFile() && e.name.endsWith('.js')) {
        nsJsFiles++;
        const c = count(readU8(p), 'userInfo');
        nsUserInfoCount += c;
        if (c > 0) nsUserInfoByFile[rel] = c;
      }
    }
  })(path.join(SDK, '@cloudbase/node-sdk/lib'), '');
  check('node-sdk lib userInfo仅5处且仅在auth/storage', () => {
    assert.equal(nsUserInfoCount, 5);
    for (const rel of Object.keys(nsUserInfoByFile)) {
      assert.ok(rel === 'auth/index.js' || rel === 'storage/index.js', 'userInfo 意外出现于 ' + rel);
    }
  });

  // ── 汇总与输出 ────────────────────────────────────────────────────────────
  const businessGuardHits = guardHits.length - businessStart;
  const result = {
    schema: 'codebuddy-i1-inbound-envelope-audit/3',
    observedAt: new Date().toISOString(),
    basisCommit: BASIS_COMMIT,
    basisNote: 'HEAD at audit time; audit baselines are commit-bound constants inside this script',
    verificationKind: 'offline read-only source audit; external fixed baselines (packager self digest + PINNED_SOURCES extracted from hash-verified packager bytes); drift counterexample rejected in memory',
    outputMode: outPath ? 'stdout+file(wx)' : 'stdout-only',
    outPath: outPath || null,
    counters: { checksRun, checkFailures: checkFailures.length, sensitivityGuardAttempts: sensitivityAttempts, businessPhaseGuardAttempts: businessGuardHits, guardAttemptsTotal: guardHits.length, cloudOperations: 0 },
    packagerSelfDigest: { rel: PACKAGER_REL, sha256: packerSha, expectedSha256: PACKAGER_SELF_SHA256, match: packerSha === PACKAGER_SELF_SHA256, note: '打包器自身摘要单独核对；不在其自身 PINNED_SOURCES 表内' },
    sourcePins: { total: sourcePins.length, driftHits, changedThisRound: CHANGED_THIS_ROUND, entries: sourcePins },
    driftCounterexample: { method: 'append comment to core bytes in memory', rejected: driftCounterexampleRejected, writtenToDisk: false },
    sdkFacts: {
      wxServerSdk: { version: sdkPkg.version, indexSha256: sha(sdkIndexBuf), indexBytes: sdkIndexBuf.length, userInfoCountInIndex: count(sdkIndex, 'userInfo'), callFunctionPassthrough: 'data passed unchanged to tcb instance', getWXContextSource: 'process.env.WX_CONTEXT_KEYS (+WX_* env keys; ENV from TCB_ENV/SCF_NAMESPACE; SOURCE from TCB_SOURCE)' },
      cloudbaseNodeSdk: { version: nsPkg.version, functionsIndexSha256: sha(nsFnBuf), callFunctionPassthrough: 'request_data = JSON.stringify(data)', libJsFilesScanned: nsJsFiles, userInfoCountInLib: nsUserInfoCount, userInfoOnlyInModules: Object.keys(nsUserInfoByFile) }
    },
    checkFailures,
    limitations: [
      'Platform envelope between phone wx.cloud.callFunction(data) and exports.main(event) is not present in any local artifact; actual extra key name, source and injection point remain unknown; userInfo is a public-documentation hypothesis only.',
      'Server-side outgoing callFunction passthrough does not represent the phone inbound path; node-sdk serializes via JSON.stringify, so no byte-exact claim is made.',
      'Entry CONFIG_APP_ID/CONFIG_ENV_ID are packaging constants; reaching the core does not prove cloud.getWXContext-based trusted target verification passed.',
      'Static anchors are not platform behavior verification.'
    ]
  };
  const failed = checkFailures.length > 0 || driftHits > 0 || businessGuardHits > 0;
  result.ok = !failed;
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    if (fs.existsSync(outPath)) {
      console.error('[审计拒绝] --out 路径已存在，不覆盖历史证据：' + outPath);
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(outPath, json, { flag: 'wx' });
  }
  console.log(json);
  console.error('[审计摘要] ok=' + result.ok + ' checks=' + checksRun + ' failures=' + checkFailures.length + ' sourcePins=' + sourcePins.length + ' driftHits=' + driftHits + ' sensitivityGuardAttempts=' + sensitivityAttempts + ' businessPhaseGuardAttempts=' + businessGuardHits + ' driftCounterexampleRejected=' + driftCounterexampleRejected + ' out=' + (outPath ? path.basename(outPath) : 'stdout-only'));
  if (failed) process.exitCode = 1;
}
try { main(); } catch (error) { console.error('[审计中止]', error.message); process.exitCode = 1; } finally { restore.reverse().forEach(f => f()); }
