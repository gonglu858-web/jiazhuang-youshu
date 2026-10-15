'use strict';
// 本地只读复查：在内存中改写交付证据，检验 W2 是否覆盖生成入口的 database() 参数。
// 不修改受审文件、不取凭据；交付证据自身使用合成上下文和本地传输。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const evidence = path.join(__dirname, '参与者核验包I1候选SDK精确版本接线复核-20261015.cjs');
const source = fs.readFileSync(evidence, 'utf8');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const sdkAdapter = /const sdkForEntry = Object\.create\(realSdk\);\s*sdkForEntry\.init = \(\) => \{\};\s*sdkForEntry\.database = \(\) => prebuiltDb;/;
const entryRead = /fs\.readFileSync\(serverFile, 'utf8'\)/;
assert(sdkAdapter.test(source) && entryRead.test(source), '交付证据的两处锚点须存在');

function run({ directSdk, dropNotFoundOption }) {
  let code = source;
  if (directSdk) code = code.replace(sdkAdapter, 'const sdkForEntry = realSdk;');
  if (dropNotFoundOption) {
    code = code.replace(entryRead, match =>
      match + '.replace(/throwOnNotFound: false/, "")');
  }
  const runner = [
    'const Module=require("node:module"),path=require("node:path");',
    'const f=' + JSON.stringify(evidence) + ';',
    'process.argv=[process.execPath,f];',
    'const m=new Module(f);m.filename=f;m.paths=Module._nodeModulePaths(path.dirname(f));',
    'm._compile(' + JSON.stringify(code) + ',f);'
  ].join('');
  const p = cp.spawnSync(process.execPath, ['-e', runner], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    env: process.env, windowsHide: true
  });
  assert(!p.error && !p.signal, '离线探针须正常结束');
  const report = JSON.parse(p.stdout);
  const w2 = report.results.find(item => item.id === 'W2_generated_entry_with_real_sdk_three_paths');
  assert(w2, '须取得 W2 结果');
  assert.equal(report.guardAccounting.businessPeriodUnexpectedAttempts, 0);
  return {
    directSdk, dropNotFoundOption, exitCode: p.status,
    w2Passed: w2.assertionsPassed,
    w2ErrorClass: w2.assertionsPassed ? null :
      (/不存在路/.test(w2.error || '') ? 'ABSENT_PATH_REJECTED' : 'OTHER_FAILURE'),
    unexpectedGuardAttempts: report.guardAccounting.businessPeriodUnexpectedAttempts
  };
}

const variants = [
  run({ directSdk: false, dropNotFoundOption: false }),
  run({ directSdk: false, dropNotFoundOption: true }),
  run({ directSdk: true, dropNotFoundOption: false }),
  run({ directSdk: true, dropNotFoundOption: true })
];
assert.deepEqual(variants.map(v => v.w2Passed), [true, true, true, false]);
assert.equal(variants[3].w2ErrorClass, 'ABSENT_PATH_REJECTED');
assert.deepEqual(variants.map(v => v.exitCode), [0, 0, 0, 1]);

const result = {
  schema: 'codex-participant-i1-sdk-evidence-counterexample/1',
  reviewedCommit: '8a2bb00', baseline: '2bd9c9c',
  evidenceScriptSha256: sha256(fs.readFileSync(evidence)),
  packerSha256: sha256(fs.readFileSync(path.join(ROOT, 'miniapp/scripts/package-participant-identity-check.cjs'))),
  variants,
  conclusion: '真实 SDK 直接接入的未改入口三路通过；交付 W2 的预建 database 替身使删除 throwOnNotFound:false 后仍全绿，故其“仅替换传输”的范围表述及入口参数覆盖不成立。',
  boundaries: '全程本地合成上下文和传输；未取凭据、未联网、未触云端。'
};
const body = JSON.stringify(result, null, 2) + '\n';
if (process.argv.length === 2) process.stdout.write(body);
else if (process.argv.length === 4 && process.argv[2] === '--out') fs.writeFileSync(path.resolve(process.argv[3]), body, { flag: 'wx' });
else throw Error('usage: node script.cjs [--out <new-path>]');
