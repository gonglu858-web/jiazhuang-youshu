'use strict';
// 仅离线审查；stdout-only，新建临时夹具，不改历史证据/业务源码。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), cp = require('node:child_process'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const nodeBin = 'C:/Users/30591/.agent-reach/tools/node-v22.16.0-win-x64/node.exe';
const realSpawn = cp.spawn;
let allowedLocalNodeChecks = 0, blockedUnexpectedProcesses = 0;
cp.spawn = (bin, argv, opts) => {
  if (bin === nodeBin && argv.length === 2 && argv[0] === '-e' &&
    argv[1] === 'process.stdout.write(require("node:os").homedir())') {
    allowedLocalNodeChecks++;
    return realSpawn(bin, argv, opts);
  }
  blockedUnexpectedProcesses++;
  throw new Error('AUDIT_PROCESS_BLOCKED');
};
const h = require(path.join(root, 'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs'));
const o = require(path.join(root, 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs'));
const cli = require(path.join(root, 'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-credential-remain-'));
const rows = [];
function referenceFinder(childHome, access, realpath) {
  // 固定bundle原函数片段仅作算法对照；不将其替代公共CLI证据或生产认证实现。
  const bundle = fs.readFileSync(cli.FIXED.cliBundle, 'utf8');
  const start = bundle.indexOf('function findProjectRoot(cwd)');
  const end = bundle.indexOf('exports.findProjectRoot = findProjectRoot;', start);
  if (start < 0 || end < start) throw Error('SOURCE_NOT_FOUND');
  return vm.runInNewContext(bundle.slice(start, end) + '\nfindProjectRoot;', {
    canonicalizePath: realpath, os_1: { default: { homedir: () => childHome } },
    path_1: { default: path }, fs_1: { default: { accessSync: access, constants: fs.constants } },
    exports: { PROJECT_ROOT_MARKERS: h.PROJECT_ROOT_MARKERS }
  });
}
async function main() {
  // S1-a：合成一个父进程Home之上的标记，仅存在于内存access替身，不写真实祖先目录。
  const realAccess = fs.accessSync;
  const virtualMarker = path.join(path.dirname(os.homedir()), 'cloudbaserc.json');
  const fakeAccess = p => {
    if (path.resolve(p) === path.resolve(virtualMarker)) return;
    throw Object.assign(new Error('SYNTHETIC_NOT_FOUND'), { code: 'ENOENT' });
  };
  let precheckPassed = false;
  try { fs.accessSync = fakeAccess; h.assertConfigDiscoveryClean(tmp); precheckPassed = true; }
  finally { fs.accessSync = realAccess; }
  const cliRoot = referenceFinder(cli.FIXED.authSessionDir, fakeAccess, p => path.resolve(p))(tmp);
  rows.push({ id: 'S1-parent-home-vs-child-home', syntheticAccessOnly: true, precheckPassed,
    childWouldFindMarker: cliRoot === path.dirname(virtualMarker),
    defectReproduced: precheckPassed && cliRoot === path.dirname(virtualMarker) });

  // S1-b：真实本地junction只在新夹具根内创建；不读取认证内容，不执行公共CLI。
  const clean = path.join(tmp, 'clean'), polluted = path.join(tmp, 'polluted');
  fs.mkdirSync(clean); fs.mkdirSync(polluted);
  const target = path.join(polluted, 'target'); fs.mkdirSync(target);
  fs.writeFileSync(path.join(polluted, 'cloudbaserc.json'), '{}', { flag: 'wx' });
  const link = path.join(clean, 'linked');
  try {
    fs.symlinkSync(target, link, 'junction');
    const cwd = path.join(link, 'cwd'); fs.mkdirSync(cwd);
    let passed = false; try { h.assertConfigDiscoveryClean(cwd); passed = true; } catch (_) {}
    const found = referenceFinder(cli.FIXED.authSessionDir, realAccess, p => fs.realpathSync(p))(cwd);
    rows.push({ id: 'S1-realpath-junction', verified: true, precheckPassed: passed,
      childWouldFindMarker: found === fs.realpathSync(polluted),
      defectReproduced: passed && found === fs.realpathSync(polluted) });
  } catch (_) {
    rows.push({ id: 'S1-realpath-junction', verified: false, note: '本机无法创建junction，不冒充实测' });
  }

  for (const kind of ['nonzero', 'timeout', 'overflow', 'signal']) {
    let attempts = 0, kills = 0, followups = 0;
    const r = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {
      baseEnv: {}, allowRealCredentialFetch: true, tmpRoot: clean,
      limits: { timeoutMs: 60, maxOutputBytes: 100, closeGraceMs: 30 },
      spawn: (bin, argv) => {
        if (argv[1] !== 'secrets') { followups++; throw Error('UNEXPECTED_NEXT_STAGE'); }
        attempts++;
        const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
        c.stdin = new EventEmitter(); c.stdin.end = () => {}; c.kill = () => { kills++; return true; };
        setImmediate(() => {
          if (kind === 'nonzero') { c.emit('exit', 1, null); c.emit('close', 1, null); }
          if (kind === 'overflow') c.stdout.emit('data', Buffer.alloc(200, 'a'));
          if (kind === 'signal') { c.emit('exit', null, 'SIGTERM'); c.emit('close', null, 'SIGTERM'); }
        });
        return c;
      }
    });
    rows.push({ id: 'S2-' + kind, attempts, kills, followups, errorCode: r.errorCode,
      fetchSubprocessAttempted: r.sameBatchCredential.fetchSubprocessAttempted,
      fetchMode: r.sameBatchCredential.fetchMode, diagnostics: r.sameBatchCredential.fetchDiagnostics,
      defectReproduced: attempts === 1 && r.sameBatchCredential.fetchSubprocessAttempted === false });
  }
  const marker = 'SYNTHETIC_FETCH_MODE_PRIVATE_MARKER';
  const r = await o.runReadOnlyObservation({ mode: 'read-only', targetUserId: null }, {
    baseEnv: {}, fetchCredential: async () => { throw Object.assign(new Error('SYNTHETIC_FAIL'), { fetchMode: marker }); }
  });
  rows.push({ id: 'S2-fetchMode-not-enum-filtered', syntheticErrorOnly: true,
    markerLeaked: JSON.stringify(r).includes(marker), defectReproduced: JSON.stringify(r).includes(marker) });
  const files = [
    'miniapp/scripts/lib/cloudbase-cli-credential-host.cjs', 'miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs',
    'miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs', 'miniapp/tests/cloudbase-sdk-readonly-observer.test.cjs',
    'miniapp/scripts/check-cloudbase-sdk-readonly.cjs','miniapp/scripts/lib/cloudbase-readonly-observer.cjs',
    'miniapp/scripts/check-cloudbase-readonly.cjs','miniapp/scripts/lib/sandbox-primary-bootstrap.cjs',
    'miniapp/scripts/prepare-sandbox-primary.cjs','miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs',
    'docs/证据/Codex核验-H1H2H3接线-20261008.json',
    'docs/证据/WorkBuddyH1H2H3-真实凭据获取最小接线复现-20261008.cjs',
    'docs/证据/WorkBuddyH1H2H3-真实凭据获取最小接线复现-20261008.json'
  ];
  process.stdout.write(JSON.stringify({ observedAt: new Date().toISOString(), realCloudCalls: 0,
    realCredentialFetches: 0, readRealAuthStoreContent: false, wroteSyntheticTempFixtures: true,
    allowedLocalNodeChecks, blockedUnexpectedProcesses, rows,
    hashes: Object.fromEntries(files.map(f => [f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]))
  }, null, 2) + '\n');
}
main().catch(() => { process.stderr.write('AUDIT_FAILED\n'); process.exitCode = 1; });
