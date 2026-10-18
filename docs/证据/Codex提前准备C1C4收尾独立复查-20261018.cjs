'use strict';
// 离线独立反例：仅变换 VM 中的证据副本，不改产品、历史脚本或真实包。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), assert = require('node:assert/strict'), cp = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const sourcePath = path.join(__dirname, 'CodeBuddyI1提前准备分离证据v2-20261018.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const cli = path.join(root, 'miniapp/scripts/package-participant-identity-check.cjs');
const originalSpawn = cp.spawn, originalSpawnSync = cp.spawnSync;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const rows = [];
function replaceOnce(s, a, b) { assert.equal(s.split(a).length, 2, 'unique anchor'); return s.replace(a, b); }
async function run(name, change) {
  const restore = [], outerBlocked = [], output = [], errors = [];
  function block(obj, key) {
    const old = obj[key]; if (typeof old !== 'function') return;
    obj[key] = () => { outerBlocked.push(key); throw Error('CODEX_OFFLINE_BLOCK'); };
    restore.push(() => { obj[key] = old; });
  }
  for (const m of ['http', 'https']) for (const k of ['request', 'get']) block(require(m), k);
  for (const k of ['connect', 'createConnection']) block(require('net'), k);
  block(require('net').Socket.prototype, 'connect'); block(require('tls'), 'connect'); block(globalThis, 'fetch');
  for (const obj of [require('dns'), require('dns').promises]) for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) block(obj, k);
  for (const k of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawnSync', 'fork']) block(cp, k);
  const previousSpawn = cp.spawn;
  cp.spawn = (exe, args, opts) => {
    const target = args && path.resolve(args[0]);
    if (exe === process.execPath && target === cli && opts && opts.env && opts.env.NODE_OPTIONS.includes('--require'))
      return originalSpawn(exe, args, { ...opts, windowsHide: true });
    if (exe === process.execPath && target === sourcePath && opts && opts.env && Object.hasOwn(opts.env, 'PIC_PREP_EVIDENCE_FAULT'))
      return originalSpawn(exe, args, { ...opts, windowsHide: true });
    outerBlocked.push('spawn-without-guard'); throw Error('CODEX_OFFLINE_BLOCK');
  };
  restore.push(() => { cp.spawn = previousSpawn; });
  const proc = { argv: [process.execPath, sourcePath], env: { ...process.env }, execPath: process.execPath, exitCode: 0 };
  delete proc.env.PIC_PREP_EVIDENCE_FAULT;
  const code = replaceOnce(change(source), 'main().catch(e =>', 'globalThis.__done = main().catch(e =>');
  const context = { require: createRequire(sourcePath), __dirname, __filename: sourcePath, process: proc,
    console: { log: s => output.push(String(s)), error: s => errors.push(String(s)) },
    Date, Buffer, URL, setTimeout, clearTimeout, fetch: globalThis.fetch };
  try {
    vm.runInNewContext(code, context, { filename: sourcePath }); await context.__done;
    assert.equal(proc.exitCode, 0, errors.join('\n'));
    const j = JSON.parse(output.find(s => s.startsWith('{'))); assert.equal(j.ok, true);
    rows.push({ name, exitCode: proc.exitCode, ok: j.ok, counters: j.guardCounters,
      actualParentHits: context.__parentHits, observedReceipts: context.__receipts, outerBlocked,
      snapshot: j.sections.b, sensitivity: j.sections.sensitivity });
  } finally { restore.reverse().forEach(f => f()); }
}
function observe(s) {
  s = replaceOnce(s, '  const probesFinal = guardHits.filter', '  globalThis.__parentHits = guardHits.slice();\n  const probesFinal = guardHits.filter');
  return replaceOnce(s, '        resolve({ code, out, err, spawnError: null, receipt, receiptError,',
    "        (globalThis.__receipts ||= []).push({ mode: args[0], code, receipt, receiptError: receiptError ? 'missing-or-invalid' : null });\n        resolve({ code, out, err, spawnError: null, receipt, receiptError,");
}
(async () => {
  await run('normal', observe);
  await run('caught_during_real_initialization', s => observe(replaceOnce(s,
    "const core = require(root + '/miniapp/scripts/lib/participant-identity-check.cjs');",
    "try { require('https').request('https://example.invalid'); } catch (_) {}\nconst core = require(root + '/miniapp/scripts/lib/participant-identity-check.cjs');")));
  assert.equal(rows.at(-1).actualParentHits.filter(h => h.phase === 'setup').length, 1);
  assert.equal(rows.at(-1).counters.parentUnexpected, 0);
  await run('caught_child_request_in_strict_plan_run', s => observe(replaceOnce(s,
    '  const runCli = makeRunner(guardPreload);',
    `  fs.appendFileSync(guardPreload, "\\nif(process.argv.includes('--plan')){try{require('https').request('https://example.invalid')}catch(_){}}\\n");\n  const runCli = makeRunner(guardPreload);`)));
  assert.equal(rows.at(-1).observedReceipts.find(r => r.mode === '--plan').receipt.unexpected.length, 1);
  assert.equal(rows.at(-1).counters.childUnexpectedTotal, 0);
  await run('missing_strict_plan_receipt', s => observe(replaceOnce(s,
    'if (p) fs.writeFileSync(p, JSON.stringify({ pid:',
    "if (p && !process.argv.includes('--plan')) fs.writeFileSync(p, JSON.stringify({ pid:")));
  assert.equal(rows.at(-1).observedReceipts.find(r => r.mode === '--plan').receipt, null);
  await run('malformed_receipt_missing_pid_exitCode', s => observe(replaceOnce(s,
    'JSON.stringify({ pid: process.pid, unexpected: hits, exitCode: process.exitCode === undefined ? null : process.exitCode })',
    'JSON.stringify({ unexpected: hits })')));
  assert(rows.at(-1).observedReceipts.every(r => !Object.hasOwn(r.receipt, 'pid')));
  await run('whitelisted_script_spawn_without_preload', s => observe(replaceOnce(s,
    "  const openid = 'synthetic-prep2-openid';",
    "  try { require('child_process').spawn(process.execPath,[PACKER_CLI,'--prepare','not-a-real-plan']); } catch (_) {}\n  const openid = 'synthetic-prep2-openid';")));
  assert(rows.at(-1).outerBlocked.includes('spawn-without-guard'));
  assert.equal(rows.at(-1).counters.parentUnexpected, 0);
  // CLI 真子进程空字符串参数；仅合成计划与本地制品，独立 preload 禁止网络/子进程。
  const scratch = path.join(root, 'artifacts/schedule-sandbox/business-test');
  const id = crypto.randomBytes(5).toString('hex');
  const packer = require(cli);
  const templatePath = fs.readdirSync(scratch).filter(n => n.startsWith('prep2-plan-future-')).map(n => path.join(scratch,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
  const plan = { ...JSON.parse(fs.readFileSync(templatePath)), checkRoundId: 'synthetic-codex-empty-out-' + id };
  const planPath = path.join(scratch, 'codex-empty-out-' + id + '.json');
  fs.writeFileSync(planPath, JSON.stringify(plan), { flag: 'wx' });
  const preload = path.join(scratch, 'codex-cli-offline-' + id + '.cjs');
  fs.writeFileSync(preload, "const b=()=>{process.exitCode=89;throw Error('OFFLINE')};for(const m of ['http','https'])for(const k of ['get','request'])require(m)[k]=b;require('net').Socket.prototype.connect=b;require('tls').connect=b;globalThis.fetch=b;for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('child_process')[k]=b;", { flag: 'wx' });
  const p = originalSpawnSync(process.execPath, ['--require',preload,cli,'--prepare',planPath,'--out',''], { cwd:root, encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:300000 });
  assert.equal(p.status,0,p.stderr); const payload=JSON.parse(p.stdout); assert.equal(payload.written,39);
  const absentSource = packer.parseCliArgs(['--check-close','synthetic-close']); assert.equal(absentSource.error,undefined);
  assert.equal(sha(fs.readFileSync(sourcePath)),sha(source));
  const result={schema:'codex-preparation-c1c4-review/1',reviewedCommit:'0b5d459',sourceSha256:sha(source),sourceUnchanged:true,
    evidenceRuns:rows,cli:{emptyOut:{exitCode:p.status,written:payload.written,outDir:payload.outDir},missingCloseSourceParserAccepted:true},
    networkCallsActuallyIssued:0,unexpectedProcessesActuallyExecuted:0,scope:'offline synthetic materials; VM evidence mutations only; no platform verification'};
  const json=JSON.stringify(result,null,2)+'\n'; if(process.argv[2])fs.writeFileSync(process.argv[2],json,{flag:'wx'}); console.log(json);
})().catch(e=>{console.error(e);process.exitCode=1;});
