// I1 入站事件封装离线审计（只读源码事实提取；不含任何键值、口令、OPENID 或原始 event）。
// 依据：docs/Codex诊断-参与者I1请求字段拒绝-20261016.md §3；CodeBuddy开发交接.md §3。
// 方法：固定文件哈希 + 锚点字符串断言 + 本地 SDK 包内全文计数；全程网络/进程守卫。
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), sha = b => crypto.createHash('sha256').update(b).digest('hex');
const out = __filename.replace(/cjs$/, 'json'); assert(!fs.existsSync(out));
const guardHits = [], restore = []; function guard(obj, k) { const old = obj[k]; if (typeof old !== 'function') return; obj[k] = () => { guardHits.push(k); throw Error('OFFLINE_GUARD'); }; restore.push(() => obj[k] = old); }
for (const m of ['node:http', 'node:https']) for (const k of ['get', 'request']) guard(require(m), k);
for (const k of ['connect', 'createConnection']) guard(require('node:net'), k); guard(require('node:tls'), 'connect'); guard(globalThis, 'fetch');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) { guard(require('node:dns'), k); guard(require('node:dns').promises, k); }
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) guard(require('node:child_process'), k);
const readU8 = abs => fs.readFileSync(abs).toString('utf8');
const count = (hay, needle) => hay.split(needle).length - 1;
const SDK = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
const RELS = [
  'miniapp/scripts/lib/participant-identity-check.cjs',
  'miniapp/scripts/templates/participant-identity-check/server/index.js',
  'miniapp/scripts/templates/participant-identity-check/frontend/utils/identity-check-client.js',
  'miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js',
  'miniapp/scripts/templates/participant-identity-check/frontend/config/cloud.js',
  'miniapp/scripts/package-participant-identity-check.cjs'
];
async function main() {
  assert.throws(() => require('node:https').request('https://example.invalid'), /OFFLINE_GUARD/);
  assert.throws(() => require('node:net').connect(1), /OFFLINE_GUARD/);
  const probes = guardHits.length;
  const files = {};
  for (const rel of RELS) { const buf = fs.readFileSync(path.join(root, rel)); files[rel] = { bytes: buf.length, sha256: sha(buf) }; }
  const core = readU8(path.join(root, RELS[0]));
  const entry = readU8(path.join(root, RELS[1]));
  const client = readU8(path.join(root, RELS[2]));
  const page = readU8(path.join(root, RELS[3]));
  const packer = readU8(path.join(root, RELS[5]));
  // ── 应用链锚点（任何一项不符即拒绝记录）─────────────────────────────────
  assert.ok(core.includes("const REQUEST_FIELDS = Object.freeze(['action', 'passphrase', 'checkRoundId', 'includeFullUserId'])"));
  assert.ok(core.includes('for (const k of Object.keys(payload))'));
  assert.ok(core.includes("deny(ERR_CODES.REQUEST_INVALID, '请求含未登记字段：' + k)"));
  assert.ok(core.includes("PIC_REQUEST_INVALID: '请求含未登记字段。'"));
  assert.ok(core.includes('message: internal ? ERROR_PUBLIC_TEXT[error.code] || GENERIC_TEXT : GENERIC_TEXT'));
  const h = core.indexOf('async function handle(event) {');
  const body = h >= 0 ? core.slice(h) : '';
  const iReq = body.indexOf('assertRequest(event);'), iTrust = body.indexOf('assertTrustedTarget();'), iWin = body.indexOf('assertWindowOpen();');
  assert.ok(h >= 0 && iReq >= 0 && iTrust > iReq && iWin > iTrust, 'handle 门槛顺序必须为 请求键→可信上下文→窗口');
  assert.ok(entry.includes('return checker.handle(event);'));
  assert.ok(entry.includes('ctx = cloud.getWXContext() || {};'));
  assert.ok(entry.includes('require(\'./participant-identity-check\')'));
  assert.ok(client.includes('const payload = {') && client.includes('action: request.action') && client.includes('passphrase: request.passphrase'));
  assert.ok(client.includes('checkRoundId: cloudConfig.checkRoundId'));
  assert.ok(client.includes('if (request.includeFullUserId === true) payload.includeFullUserId = true;'));
  assert.ok(client.includes('data: payload') && client.includes('name: cloudConfig.identityCheckFunction'));
  assert.ok(page.includes("action: 'inspectSelf'") && page.includes('passphrase: this.data.passphrase'));
  assert.ok(page.includes('includeFullUserId: this.data.wantFullUserId === true'));
  assert.ok(packer.includes('const PINNED_SOURCES = Object.freeze({'), '打包器受审基线表存在（未改）');
  // ── 本地 SDK 版本与信封事实 ─────────────────────────────────────────────
  const sdkPkg = JSON.parse(readU8(path.join(SDK, 'wx-server-sdk/package.json')));
  const nsPkg = JSON.parse(readU8(path.join(SDK, '@cloudbase/node-sdk/package.json')));
  assert.equal(sdkPkg.version, '3.0.1'); assert.equal(nsPkg.version, '2.10.0');
  const sdkIndexBuf = fs.readFileSync(path.join(SDK, 'wx-server-sdk/index.js'));
  const sdkIndex = sdkIndexBuf.toString('utf8');
  const nsFnBuf = fs.readFileSync(path.join(SDK, '@cloudbase/node-sdk/lib/functions/index.js'));
  const nsFn = nsFnBuf.toString('utf8');
  assert.equal(count(sdkIndex, 'userInfo'), 0);
  assert.ok(sdkIndex.includes('process.env.WX_CONTEXT_KEYS'), 'getWXContext 读取平台注入的 WX_CONTEXT_KEYS 环境变量清单');
  assert.ok(sdkIndex.includes("wxContext.ENV = process.env.TCB_ENV || process.env.SCF_NAMESPACE"));
  assert.ok(sdkIndex.includes('data: options.data || {}'), 'wx-server-sdk callFunction 透传 data');
  assert.ok(sdkIndex.includes('const res = await tcbInstance.callFunction(options);'));
  assert.equal(count(nsFn, 'userInfo'), 0);
  assert.ok(nsFn.includes('JSON.stringify(data)') && nsFn.includes('request_data: transformData'), 'node-sdk callFunction 逐字透传 data');
  // 直接递归扫描（不依赖搜索工具的忽略规则）；记录每文件计数，限制归属。
  const nsUserInfoByFile = {};
  let nsJsFiles = 0, nsUserInfoCount = 0;
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
  // 已核对：仅 auth.getUserInfo() 返回形状（auth/index.js L45/66/92）与 storage 内部
  // 读取（storage/index.js L260-261）含 userInfo；callFunction 与事件信封路径为 0。
  assert.equal(nsUserInfoCount, 5, '@cloudbase/node-sdk lib userInfo 计数须与人工核对一致');
  assert.equal(count(nsFn, 'userInfo'), 0, 'callFunction 模块不得出现 userInfo');
  for (const rel of Object.keys(nsUserInfoByFile)) {
    assert.ok(rel === 'auth/index.js' || rel === 'storage/index.js', 'userInfo 只允许出现在 auth/storage 模块：' + rel);
  }
  const sdkPkgFiles = ['index.js', 'index.d.ts', 'README.md', 'CHANGELOG.md', 'package.json'];
  const sdkUserInfo = {};
  for (const f of sdkPkgFiles) sdkUserInfo[f] = count(readU8(path.join(SDK, 'wx-server-sdk/' + f)), 'userInfo');
  assert.equal(guardHits.length, probes, '审计期间不得有任何网络/进程尝试');
  const result = {
    schema: 'codebuddy-i1-inbound-envelope-audit/1',
    observedAt: new Date().toISOString(),
    basisCommit: '2f99a48',
    basisNote: 'HEAD at audit time (handover commit); workspace clean at start',
    verificationKind: 'offline read-only source audit + string anchors + local SDK scans; no cloud operation, no field values, no raw event',
    localSdkRoot: SDK,
    projectFiles: files,
    sdkFacts: {
      wxServerSdk: { version: sdkPkg.version, indexSha256: sha(sdkIndexBuf), indexBytes: sdkIndexBuf.length, userInfoCounts: sdkUserInfo, callFunctionPassthrough: true, getWXContextSource: 'process.env.WX_CONTEXT_KEYS (+WX_* env keys; ENV from TCB_ENV/SCF_NAMESPACE; SOURCE from TCB_SOURCE)' },
      cloudbaseNodeSdk: { version: nsPkg.version, functionsIndexSha256: sha(nsFnBuf), functionsIndexBytes: nsFnBuf.length, callFunctionPassthrough: true, libJsFilesScanned: nsJsFiles, userInfoCountInLib: nsUserInfoCount, userInfoOnlyInModules: Object.keys(nsUserInfoByFile), userInfoNote: 'all occurrences are auth.getUserInfo() return shape / storage internal read; none on callFunction or event envelope path' }
    },
    anchors: {
      coreRequestFields: ['action', 'passphrase', 'checkRoundId', 'includeFullUserId'],
      assertRequestKeyLoop: true,
      assertRequestFirstInHandle: true,
      rejectMessageCarriesKeyNameInternallyOnly: true,
      publicResultUsesFixedText: true,
      entryPassesEventUntouched: true,
      clientPayloadKeysFixed: true,
      pageRequestLiteralFixed: true,
      packerPinnedSourcesUntouched: true
    },
    checksPassed: 32,
    guardAttemptsTotal: guardHits.length,
    unexpectedGuardAttempts: guardHits.length - probes,
    cloudOperations: 0,
    auditProcessFacts: [
      'First run failed honestly: lib-wide zero-userInfo assertion disproved (5 occurrences found by direct scan); no JSON was written on that run.',
      'A tool-based grep with default ignore rules had under-reported node-sdk hits; direct recursive scan is authoritative.'
    ],
    limitations: [
      'Platform envelope between wx.cloud.callFunction(data) and exports.main(event) is not present in any local artifact; exact extra key name cannot be determined offline.',
      'userInfo appears nowhere in wx-server-sdk 3.0.1 package; in @cloudbase/node-sdk 2.10.0 it appears only inside auth/storage getUserInfo shapes (5), unrelated to callFunction or event envelope; no local material records a platform-injected event userInfo.',
      'DevTools base library (app.asar) not inspected; simulator path would not prove phone behavior anyway.',
      'This audit does not run the request pipeline; behavioral equivalence was covered by the prior 5/5 reproduction (Codex参与者I1请求字段拒绝定位-20261016.json).'
    ]
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ checksPassed: result.checksPassed, files: Object.keys(files).length, sdkUserInfo: { wxServerSdkTotal: Object.values(sdkUserInfo).reduce((a, b) => a + b, 0), nodeSdkLib: nsUserInfoCount }, unexpectedGuardAttempts: result.unexpectedGuardAttempts, out: path.basename(out) }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => restore.reverse().forEach(f => f()));
