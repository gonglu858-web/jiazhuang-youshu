'use strict';
// 仅本地读取、哈希及纯计划校验。无批准签发、凭据获取、子进程或云调用。
// 默认 stdout；--out <新路径> 仅 wx 新建本地证据，不覆盖。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const lib = path.join(root, 'miniapp/scripts/lib');
const p4 = require(path.join(lib, 'sandbox-primary-bootstrap.cjs'));
const host = require(path.join(lib, 'sandbox-primary-execution-host.cjs'));
const entry = require(path.join(lib, 'sandbox-primary-approved-run.cjs'));
const cli = require(path.join(lib, 'cloudbase-readonly-observer.cjs'));
const planPath = path.join(__dirname, 'Codex首次管理员最终计划-20261012.json');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const file = p => ({ path: path.relative(root, p).replace(/\\/g, '/'), bytes: fs.statSync(p).size, sha256: digest(fs.readFileSync(p)) });
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const now = Date.now();
p4.validatePlan(plan); // 不构造 approvedUserIds，不调用签发函数。
assert.equal(plan.targetUserId, 'u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4');
assert.equal(plan.roundId, 'primary-20261012-final-01');
assert.equal(host.realModeOfflineHarnessActive(), false);
const outDir = path.join(root, 'docs/证据/管理员初始化执行-primary-20261012-final-01');
entry.normalizeRunId(plan.roundId);
assert.equal(fs.existsSync(outDir), false, '执行输出目录已存在：需核对，不新轮重试');
const names = ['sandbox-primary-approved-run.cjs', 'sandbox-primary-execution-host.cjs',
  'sandbox-primary-execution-worker.cjs', 'sandbox-primary-bootstrap.cjs',
  'sandbox-primary-sdk-adapter.cjs', 'cloudbase-cli-credential-host.cjs',
  'cloudbase-readonly-observer.cjs', 'cloudbase-sdk-readonly-observer.cjs',
  'cloudbase-sdk-readonly-worker.cjs'];
const implementationFiles = names.map(n => file(path.join(lib, n)));
assert.equal(implementationFiles[0].sha256, '270391049c0714801f7bbc9bc32e7351643d8a576aeac88bb2fc2095e6950128');
const cliEntry = file(cli.FIXED.cliEntry);
const cliBundle = file(cli.FIXED.cliBundle);
assert.equal(cliEntry.sha256, cli.FIXED.cliEntrySha256);
assert.equal(cliBundle.sha256, cli.FIXED.cliBundleSha256);
assert.equal(fs.readFileSync(cli.FIXED.cliEntry, 'utf8'), cli.FIXED.cliEntryExactBytes);
// 只读固定 node_modules；不遍历登录目录。完整依赖树摘要仅用于后续漂移核对。
const sdkRoot = host.FIXED.sdkRoot;
const entries = [];
function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const p = path.join(dir, d.name);
    assert.equal(d.isSymbolicLink(), false, '依赖树链接需单独核对');
    if (d.isDirectory()) walk(p);
    else if (d.isFile()) entries.push([path.relative(sdkRoot, p).replace(/\\/g, '/'), digest(fs.readFileSync(p))]);
    else throw new Error('非普通依赖项');
  }
}
walk(sdkRoot);
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkRoot, '@cloudbase/node-sdk/package.json'), 'utf8')).version;
const dbVersion = JSON.parse(fs.readFileSync(path.join(sdkRoot, '@cloudbase/database/package.json'), 'utf8')).version;
assert.equal(sdkVersion, '2.10.0'); assert.equal(dbVersion, '1.4.1');
const subjectPath = path.join(__dirname, 'Codex管理员初始化准备主体只读核对-20261012.json');
assert.equal(file(subjectPath).sha256, '741d45f8723d948e3f71cc8f4688b216625b09ca7e05d6338345f6804eaa8536');
const historicalPaths = ['Codex管理员初始化准备主体只读核对-20261012.json',
  'Codex本人第三轮登记与关闭结论-20261012.json', 'Codex本人第三轮关闭页人工核验-20261012.json'];
const output = {
  schema: 'codex-primary-final-package-local/1', observedAt: new Date(now).toISOString(),
  status: 'PREPARED_AWAITING_HUMAN_CONFIRMATION', implementationCommit: 'b537402', acceptanceCommit: '51eb81a',
  writeAuthorized: false, approvalIssued: false, credentialFetched: false, cloudCallAttempted: false,
  initializationAttempted: false, authStoreRead: false,
  planFile: file(planPath), plan,
  inputDigest: p4.inputDigest(plan), auditId: p4.auditId(plan, p4.inputDigest(plan)),
  fullPlanDigest: digest(JSON.stringify(Object.keys(plan).sort().map(k => [k, plan[k]]))),
  expectedSubjectDigest: '93cb27f6ff00e5626a3d88fb01e0a0aafd1b6ceb8b3b5a3f2d02591f253099bf',
  credentialSourceMode: 'fixed-real-source', outDir, outDirAbsent: true,
  approvalWindow: 'after human confirmation, at most 10 minutes and no later than plan deadline',
  implementationFiles, boundFingerprint: entry.fullFingerprint(),
  runtime: { node: file(cli.FIXED.nodeBin), cliEntry, cliBundle, sdkRoot, sdkVersion, dbVersion,
    sdkTreeFiles: entries.length, sdkTreeSha256: digest(JSON.stringify(entries)), treeAlgorithm: 'recursive sorted names; JSON array [relative slash path, file sha256]' },
  historicalEvidence: historicalPaths.map(n => file(path.join(__dirname, n))),
  limitations: ['历史云端记录不代表当前状态', '未签发真实批准', '未核实当前费用余量',
    '未验证生产 worker 自建 db 的平台事务及 IAM 写权限', '本地目录/依赖核对不是平台验证']
};
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out'), '只允许 --out 新路径');
const bytes = JSON.stringify(output, null, 2) + '\n';
if (args.length) fs.writeFileSync(path.resolve(args[1]), bytes, { flag: 'wx', encoding: 'utf8' });
process.stdout.write(bytes);
