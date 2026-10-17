'use strict';
// 只读 Git 字节比较；在 VM 内注入一次被 catch 的联网尝试，底层由证据守卫拦截。
// 不修改待测脚本/历史文件；默认 stdout，--out wx 新建。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const git = (...args) => cp.execFileSync('git', args, { cwd: root });
const basis = '347261a', reviewed = '938dde1';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  const histories = ['docs/进展与待办.md', 'docs/CodeBuddy开发交接.md'].map(rel => {
    const before = git('show', basis + ':' + rel), after = git('show', reviewed + ':' + rel);
    const suffixEqual = after.subarray(after.length - before.length).equals(before);
    assert.equal(suffixEqual, true); return { rel, suffixEqual, addedBytes: after.length - before.length };
  });
  const oldPaths = git('-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', basis, '--', 'docs/证据').toString('utf8').trim().split(/\r?\n/);
  const oldJsonPaths = oldPaths.filter(p => p.endsWith('.json'));
  const changedOldJson = oldJsonPaths.filter(p => !git('show', basis + ':' + p).equals(git('show', reviewed + ':' + p)));
  assert.equal(changedOldJson.length, 0);
  const oldScripts = [ 'docs/证据/CodeBuddyI1入站事件封装离线核实-20261016.cjs', 'docs/证据/CodeBuddy受控诊断R1R4收尾-20261016.cjs' ]
    .map(rel => { const before = git('show', basis + ':' + rel), after = git('show', reviewed + ':' + rel);
      return { rel, beforeSha256: sha(before), afterSha256: sha(after), unchanged: before.equals(after) }; });
  assert.equal(oldScripts.every(x => !x.unchanged), true);
  const protectedPaths = ['miniapp/cloudfunctions', 'miniapp/miniprogram', 'miniapp/pages', 'miniapp/project.config.json',
    'miniapp/scripts/lib', 'miniapp/scripts/package-business-test.cjs', 'miniapp/scripts/package-sandbox.cjs', 'miniapp/scripts/package-sandbox-registration.cjs'];
  const protectedDiff = git('diff', '--name-only', basis, reviewed, '--', ...protectedPaths).toString('utf8').trim();
  assert.equal(protectedDiff, '');
  const scriptPath = path.join(root, 'docs/证据/CodeBuddyI1请求分层兼容证据-20261017.cjs');
  const source = fs.readFileSync(scriptPath, 'utf8');
  async function run(caught) {
    let code = source;
    const anchor = 'const businessStart = guardHits.length;';
    assert.equal(code.split(anchor).length, 2);
    if (caught) code = code.replace(anchor, anchor + "\ntry { require('node:https').request('https://example.invalid'); } catch (_) {}\n");
    assert.equal(code.split('main().catch').length, 2);
    code = code.replace('main().catch', 'globalThis.pending = main().catch');
    const logs = [], errors = [], p = { argv: ['node', scriptPath], env: process.env, chdir: d => { assert.equal(path.resolve(d), root); }, exitCode: 0 };
    const context = vm.createContext({ require: createRequire(scriptPath), process: p, Buffer, __dirname: path.dirname(scriptPath),
      console: { log: x => logs.push(String(x)), error: x => errors.push(String(x)) } });
    vm.runInContext(code, context, { filename: scriptPath });
    await context.pending;
    assert.equal(logs.length, 1, errors.join('\n'));
    const result = JSON.parse(logs[0]);
    return { ok: result.ok, exitCode: p.exitCode, counts: result.guardCounters };
  }
  const normal = await run(false), caught = await run(true);
  assert.deepEqual(normal, { ok: true, exitCode: 0, counts: { sensitivityAttempts: 2, businessPhaseGuardAttempts: 0, total: 2 } });
  assert.deepEqual(caught, { ok: false, exitCode: 1, counts: { sensitivityAttempts: 2, businessPhaseGuardAttempts: 1, total: 3 } });
  const result = { schema: 'codex-i1-layer-scope-guard/1', basis, reviewed, observedAt: new Date().toISOString(), histories,
    oldJson: { compared: oldJsonPaths.length, changed: changedOldJson }, oldScripts, protectedPaths, protectedDiff,
    newEvidenceGuard: { sourceSha256: sha(Buffer.from(source)), normal, caught },
    regressionObservedInReview: { identity: { pass: 34, fail: 0, skip: 0 }, business: { pass: 18, fail: 0, skip: 0 }, sdk: { pass: 1, fail: 0, skip: 0 },
      note: '本轮已单独运行三个 node --test 命令，此处记录终端实测结果，本脚本不再重复执行测试。' },
    reviewHarnessCorrections: ['首次独立链脚本误给 checkCloseDir 传 close 子目录且未设来源；按接口改为候选根+PIC_CLOSE_SOURCE_DIR 后通过。',
      '首轮交付证据已写出成功，但 PowerShell ConvertFrom-Json 默认大小写不敏感，无法解析 openid/OPENID 同名键；仅汇总管道失败，原 JSON 未受影响。'],
    evidenceAssertionsPassed: true, implementationAccepted: false, cloudActions: '未执行；守卫探针由本地替身拦截' };
  const text = JSON.stringify(result, null, 2) + '\n'; const i = process.argv.indexOf('--out');
  if (i >= 0) { assert.ok(process.argv[i + 1]); fs.writeFileSync(process.argv[i + 1], text, { flag: 'wx' }); }
  console.log(text);
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
