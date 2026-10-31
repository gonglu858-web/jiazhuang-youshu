'use strict';
// Independent review of 60ed280. Real JS modules; inert OS boundaries only.
// Common guard/PE/receipt doubles copied from the prior review, not imported.
// Counterexample success means a reviewed defect reproduced, NOT product approval.
const guard = { probes: 0, unexpected: 0 }; let probing = false;
function deny() { guard[probing ? 'probes' : 'unexpected']++; throw Error('REVIEW_OS_BLOCKED'); }
const cp = require('node:child_process'); cp.ChildProcess.prototype.spawn = deny;
const socketProto = require('node:net').Socket.prototype;
for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = deny;
for (const id of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns']) {
  const m = require(id);
  if (id === 'node:net') m.Socket.prototype.connect = deny;
  if (id === 'node:dns') for (const k of Object.keys(m.promises)) if (typeof m.promises[k] === 'function') m.promises[k] = deny;
  for (const k of Object.keys(m)) if (typeof m[k] === 'function') Object.defineProperty(m, k, { value: deny, configurable: true });
}
globalThis.fetch = deny;
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm'), assert = require('node:assert/strict');
const H = b => crypto.createHash('sha256').update(b).digest('hex');
const dir = __dirname, root = path.resolve(dir, '../..');
const names = {
  driver: 'CodexL2单根产物绑定与单次驱动v3-20261031.cjs',
  audit: 'CodexL2单根对照离线核验v5-20261031.cjs',
  ccfg: 'CodexL2单根对照固定编译配置v3-20261031.json',
  contract: 'CodexL2单根对照回执契约v2-20261031.cjs',
  config: 'CodexL2单根对照固定接口v2-20261031.json',
  run: 'CodexL2单根Run合成边界夹具v3-20261031.cs'
};
const read = n => fs.readFileSync(path.join(dir, n));
const results = [];
function test(name, fn) { try { results.push({ name, matched: true, facts: fn() }); } catch (e) { results.push({ name, matched: false, error: e.code || e.message }); } }
function capture(fn) { try { return { value: fn() }; } catch (e) { return { error: e.message, facts: e.facts || null, report: e.report || null }; } }
function product() {
  const b = Buffer.alloc(0x800), pe = 0x80, opt = pe + 24, sect = opt + 240;
  b.write('MZ'); b.writeUInt32LE(pe, 60); b.write('PE\0\0', pe, 'latin1');
  b.writeUInt16LE(0x8664, pe + 4); b.writeUInt16LE(3, pe + 6); b.writeUInt16LE(240, pe + 20); b.writeUInt16LE(0x20b, opt);
  b.writeUInt32LE(0x800, opt + 56); b.writeUInt32LE(0x400, opt + 60);
  for (let i = 0; i < 3; i++) {
    b.writeUInt32LE(0x400, sect + i * 40 + 8); b.writeUInt32LE(0x1000 + i * 0x400, sect + i * 40 + 12);
    b.writeUInt32LE(0x200, sect + i * 40 + 16); b.writeUInt32LE(0x200 + i * 0x200, sect + i * 40 + 20);
  }
  b.writeUInt32LE(0x1000, opt + 112 + 14 * 8); b.writeUInt32LE(0x48, opt + 112 + 14 * 8 + 4);
  b.writeUInt32LE(0x48, 0x200); b.writeUInt16LE(2, 0x204); return b;
}
const configRaw = read(names.config), cfg = JSON.parse(configRaw);
const receipt = {
  schema: 'codex-l2-root-only-job/1', mode: 'rootOnly', outcome: 'completed', reason: 'NONE',
  created: true, assigned: true, resumed: true, pid: 100, rootExited: true, rootExit: 0, jobEmpty: true,
  totalProcesses: 1, activeProcesses: 0, killRequested: false, killAccepted: false, readersDone: true,
  handlesClosed: true, cleanupConfirmed: true, stdoutBytes: 12, stderrBytes: 0,
  stdoutBase64: Buffer.from('L2_ROOT_ONLY').toString('base64'), elapsedMs: 100, accountingLayoutVerified: true,
  observation: { failure: 'NONE', identityCoverage: true, parentEvidenceComplete: false, notificationCompletenessGuaranteed: false,
    stopped: true, handlesClosed: true, duplicateNew: false, finalTotal: 1,
    events: [{ kind: 'NEW', pid: 100 }, { kind: 'EXIT', pid: 100 }, { kind: 'ACTIVE_ZERO', pid: 0 }],
    members: [{ pid: 100, creationTime: '1', image: 'FIXED_NODE', pathClass: 'FIXED_NODE_PATH', state: 'CAPTURED', root: true, parent: 'UNKNOWN', newSeen: true, listed: true, exitSeen: true }] }
};
function boundary(o = {}) {
  const log = { spawn: 0, kill: 0, wait: 0, hold: 0, release: 0, heldPath: null, spawnPath: null, args: null, killAtFirstWait: null };
  return {
    log, productPath: 'C:\\synthetic\\bound.exe',
    receiptExistsBefore() { return !!o.exists; }, guardUnexpected() { return 0; },
    digestFile(p) {
      if (o.postDigestThrow && log.spawn) throw Error('SYNTHETIC_DIGEST_ERROR');
      const s = cfg.sources.find(x => x.rel === p); return s ? (o.drift ? 'drift' : s.sha256) : H(product());
    },
    holdProduct(p) { log.hold++; log.heldPath = p; return { sha256: o.badDigest ? 'wrong' : H(product()), holdToken: {} }; },
    releaseHold() { log.release++; if (o.releaseThrow) throw Error('SYNTHETIC_RELEASE_ERROR'); return o.releaseFalse ? false : true; },
    spawn(a) { log.spawn++; log.spawnPath = a.artifactPath; log.args = a.args; return { onData(cb) {
      if (o.subscribeThrow) throw Error('SYNTHETIC_SUBSCRIBE_ERROR');
      cb(false, o.stdout === undefined ? Buffer.from(JSON.stringify(receipt)) : o.stdout);
    } }; },
    awaitExit() {
      log.wait++; if (log.wait === 1) log.killAtFirstWait = log.kill;
      if (o.waitThrow) throw Error('SYNTHETIC_WAIT_ERROR');
      return o.timeout ? { timedOut: true, closed: false } : { status: 0, signal: null, closed: true };
    },
    kill() { log.kill++; if (o.killThrow) throw Error('SYNTHETIC_KILL_ERROR'); return true; }
  };
}

names.checker = 'CodexL2单根编译配置严格检查v1-20261031.cjs';
names.prep = 'CodexL2单根Run合成边界准备v3-20261031.cjs';
function auditVm(mode = 'normal') {
  let output = '', fallback = 0, injected = false, finalReport;
  const cache = new Map(), mocks = {};
  const no = () => { fallback++; throw Error('INDEPENDENT_VM_OS_BLOCKED'); };
  for (const id of ['child_process','http','https','net','tls','dgram','dns']) {
    mocks['node:' + id] = {};
    for (const k of ['request','get','connect','createConnection','createSocket','lookup','spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) mocks['node:' + id][k] = no;
  }
  mocks['node:child_process'].ChildProcess = function () {};
  mocks['node:child_process'].ChildProcess.prototype.spawn = no;
  mocks['node:net'].Socket = function () {};
  mocks['node:net'].Socket.prototype.connect = no;
  mocks['node:dns'].promises = { lookup: no };
  const proc = { argv: ['synthetic-node', path.join(dir, names.audit)], exitCode: null,
    exit(n) { this.exitCode = n; } };
  if (mode === 'ownFault') proc.argv.push('--fault-caught');
  const ctx = vm.createContext({ Buffer, TextDecoder, process: proc, fetch: no });
  const auditHashBytes = read(names.checker);
  const fakeCrypto = { ...crypto, createHash(...args) {
    const hash = crypto.createHash(...args), update = hash.update;
    hash.update = function (b, ...rest) {
      if (mode === 'lateDigest' && !injected && Buffer.isBuffer(b) && b.equals(auditHashBytes)) {
        injected = true; try { mocks['node:https'].request('synthetic-denied'); } catch (_) {}
      }
      return update.call(this, b, ...rest);
    }; return hash;
  } };
  const meta = new Set([path.join(root, 'AGENTS.md'), path.join(root,'.git','HEAD')]);
  const head = fs.readFileSync(path.join(root,'.git','HEAD'),'utf8').trim();
  if (head.startsWith('ref: ')) meta.add(path.join(root,'.git',head.slice(5)));
  const fakeFs = { readFileSync(p, enc) {
    p = path.resolve(String(p));
    assert.ok(meta.has(p) || path.dirname(p) === dir && /^(CodexL2).*\.(cjs|cs|json)$/.test(path.basename(p)), 'VM_READ_SCOPE');
    if (mode === 'earlyRead' && !injected && p === path.join(dir,names.driver)) {
      injected = true; try { mocks['node:https'].request('synthetic-denied'); } catch (_) {}
    }
    const b = fs.readFileSync(p); return enc ? b.toString(enc) : b;
  }, writeSync(fd,s) { assert.equal(fd,1); output += String(s); }, existsSync() { return false; },
    openSync:no, writeFileSync:no, closeSync:no };
  const fakeVm = { Script: class { constructor(src, opts) { this.s = new vm.Script(src,opts); }
    runInThisContext() { return this.s.runInContext(ctx,{timeout:3000}); } } };
  const injections = {
    socket: "new (require('node:net').Socket)().connect()",
    dns: "require('node:dns').promises.lookup('synthetic')",
    fetch: "fetch('synthetic')",
    processPrototype: "new (require('node:child_process').ChildProcess)().spawn({})"
  };
  function req(id) {
    if (id === 'node:fs') return fakeFs; if (id === 'node:path') return path;
    if (id === 'node:crypto') return fakeCrypto; if (id === 'node:vm') return fakeVm;
    if (id === 'node:assert/strict') return assert; if (mocks[id]) return mocks[id];
    assert.ok(id.startsWith('./'),'VM_REQUIRE_SCOPE'); return load(path.basename(id));
  }
  function load(n) {
    if (cache.has(n)) return cache.get(n).exports;
    const mod = {exports:{}}; cache.set(n,mod);
    let src = fakeFs.readFileSync(path.join(dir,n),'utf8');
    if (n === names.audit) {
      if (injections[mode]) src = src.replace('const failed = results.filter', 'try {' + injections[mode] + ';} catch (_) {}\nconst failed = results.filter');
      src += '\nglobalThis.reviewApi={vmLoadVerified,loadCache,FILES,PINNED};';
    }
    const fn = new vm.Script('(function(require,module,exports,__dirname,__filename){\n'+src+'\n})',{filename:n}).runInContext(ctx,{timeout:3000});
    fn(req,mod,mod.exports,dir,path.join(dir,n)); return mod.exports;
  }
  load(names.audit); finalReport=JSON.parse(output.trim());
  let loaderProof = null;
  if (mode === 'loader') {
    const a=ctx.reviewApi; a.loadCache.clear();
    const rec=a.vmLoadVerified(a.PINNED.driver,Buffer.from('module.exports={syntheticUnreviewed:true};'),a.FILES.driver,{});
    assert.equal(rec.exports.syntheticUnreviewed,true);
    const unknown=a.vmLoadVerified('unapproved-label',Buffer.from('module.exports={unknownPath:true};'),'unapproved.cjs',{});
    assert.equal(unknown.exports.unknownPath,true);
    loaderProof={wrongBytesAcceptedUnderPinnedLabel:true,unknownPathAccepted:true};
  }
  return {ok:finalReport.ok,exit:proc.exitCode,checks:finalReport.checks,failed:finalReport.failedChecks,
    submittedGuard:finalReport.guard,independentFallback:fallback,injected,loaderProof};
}

try {
  const argv=process.argv.slice(2);
  assert.ok(argv.length===0 || argv.length===2 && argv[0]==='--out' && argv[1].trim() && !argv[1].startsWith('--'));
  if(argv.length)assert.equal(fs.existsSync(argv[1]),false);
  probing=true;
  for(const f of [()=>cp.spawn('blocked'),()=>require('node:https').request('blocked'),()=>socketProto.connect(),()=>require('node:dns').promises.lookup('blocked'),()=>fetch('blocked')])assert.throws(f,/REVIEW_OS_BLOCKED/);
  probing=false;
  assert.equal(H(read(names.driver)),'0b5f3a49e9b64e36f3817c65ff128cf3d988bdcf0a18f0f295f872c94933b49c');
  for(const [k,sha] of Object.entries({audit:'204ed3fdafa6ff17911050f531be4fb5b5f80324d70f5e7f6c7f14435a3cec3b',checker:'72e68265c255f898b2c0ac8d76ffb3f02e46ce0e9a799b41e2e4368e5c591a37',ccfg:'4d43a8419c5c964705f2a1dd7bef66cde75df2d15925d5b2db36d52f0f0dcfa0',prep:'eea43bed024acab302ca2b5d4f3bfb63425332d34d6661c9d083ddf73beac7d3',run:'88ed80b47798d348717bb8b02dee9bbf3cb6412f0f0007258823cad8381f8b9e'}))assert.equal(H(read(names[k])),sha,'REVIEW_SOURCE_DRIFT:'+k);
  const m=require('./'+names.driver);
  const provenance=()=>({configRel:'docs/证据/'+names.config,artifactRelPath:'artifacts/psr-l2/rootonly-v3-helper/rootonly-helper.exe',configSha256:H(configRaw),compiled:false,executed:false});
  const bind=()=>m.bind(configRaw,product(),provenance());
  test('closed: WeakMap/byte-copy/shared single consumption',()=>{
    const p=product(),b=m.bind(configRaw,p,provenance());p.fill(0);assert.equal(H(b.bytes),b.artifactSha256);
    assert.equal(Object.getOwnPropertySymbols(b).length,0);assert.throws(()=>m.createRunner({...b},boundary()),/FAKE_BINDING/);
    const r1=m.createRunner(b,boundary()),r2=m.createRunner(b,boundary());assert.equal(r1.runOnce().ok,true);assert.throws(()=>r2.runOnce(),/ALREADY_RUN/);return {closed:true};
  });
  test('closed: productPath getter once and fixed launch options',()=>{
    const b=boundary();let reads=0;Object.defineProperty(b,'productPath',{get(){reads++;return 'C:\\synthetic\\bound.exe';}});
    assert.equal(m.createRunner(bind(),b).runOnce().ok,true);assert.equal(reads,1);assert.equal(b.log.spawnPath,b.log.heldPath);return {reads};
  });
  for(const [label,opts,code] of [['source',{drift:true},'SOURCES_DRIFTED'],['receipt',{exists:true},'RECEIPT_EXISTS'],['holdDigest',{badDigest:true},'PRODUCT_DIGEST_MISMATCH']])test('closed: '+label,()=>{
    const b=boundary(opts),r=capture(()=>m.createRunner(bind(),b).runOnce());assert.equal(r.error,code);assert.equal(b.log.spawn,0);return b.log;
  });
  test('closed: release false and wait throw cannot succeed',()=>{
    const b=boundary({waitThrow:true});assert.ok(capture(()=>m.createRunner(bind(),b).runOnce()).error);assert.equal(b.log.kill,1);assert.equal(b.log.release,1);
    assert.ok(capture(()=>m.createRunner(bind(),boundary({releaseFalse:true})).runOnce()).error);return b.log;
  });
  test('R1 fixed provenance does not bind actual launch path',()=>{
    const b=boundary(),r=m.createRunner(bind(),b).runOnce();assert.equal(r.ok,true);
    assert.notEqual(path.resolve(b.log.spawnPath),path.resolve(root,provenance().artifactRelPath));return {accepted:true,declared:provenance().artifactRelPath,actual:b.log.spawnPath};
  });
  test('R1 provenance getters retain mutable caller record',()=>{
    const p=provenance(),b=m.bind(configRaw,product(),p);p.artifactRelPath='synthetic-changed';assert.equal(b.artifactRelPath,'synthetic-changed');return {changedAfterBinding:true};
  });
  test('R2 close unconfirmed skips kill and bounded reclaim',()=>{
    const b=boundary();b.awaitExit=()=>{b.log.wait++;return {status:0,closed:false,timedOut:false};};
    const r=capture(()=>m.createRunner(bind(),b).runOnce());assert.equal(r.facts.failure,'CLOSE_UNCONFIRMED');assert.equal(b.log.kill,0);assert.equal(b.log.wait,1);assert.equal(b.log.release,1);return {facts:r.facts,log:b.log};
  });
  test('R2 initial unexpected count can be erased by final count',()=>{
    const b=boundary();let reads=0;b.guardUnexpected=()=>++reads===1?1:0;
    const r=m.createRunner(bind(),b).runOnce();assert.equal(r.ok,true);assert.equal(r.facts.unexpected,0);return {accepted:true,initialUnexpected:1,finalUnexpected:0,launches:b.log.spawn};
  });
  const checker=require('./'+names.checker),raw=read(names.ccfg);
  test('closed: strict config legal control and ordinary mutation',()=>{
    checker.strictCheck(raw);const c=JSON.parse(raw);c.postcheck.executeOutput=true;assert.throws(()=>checker.strictCheck(c),/CONFIG_MISMATCH/);return {closed:true};
  });
  test('R3 exported expected configuration can change acceptance',()=>{
    const c=JSON.parse(raw),e=checker.expectedConfig,old=e.postcheck.executeOutput;
    try{e.postcheck.executeOutput=true;c.postcheck.executeOutput=true;const r=checker.strictCheck(c);assert.equal(r.postcheck.executeOutput,true);return {unapprovedExecuteOutputAccepted:true};}finally{e.postcheck.executeOutput=old;}
  });
  test('R3 validation and returned copy read different values',()=>{
    const c=JSON.parse(raw),valid=c.host.path;let reads=0;
    Object.defineProperty(c.host,'path',{enumerable:true,get(){return ++reads===1?valid:'C:\\synthetic\\unapproved.exe';}});
    const out=checker.strictCheck(c);assert.equal(out.host.path,'C:\\synthetic\\unapproved.exe');assert.equal(reads,2);return {reads,returned:out.host.path};
  });
  for(const mode of ['normal','ownFault','socket','dns','fetch','processPrototype','earlyRead','lateDigest','loader'])test('R4 complete submitted audit VM: '+mode,()=>{
    const r=auditVm(mode);assert.equal(r.checks,36);assert.equal(r.failed.length,0);
    assert.equal(r.ok,mode!=='ownFault');assert.equal(r.exit,mode==='ownFault'?1:0);
    if(['socket','dns','fetch','processPrototype','earlyRead'].includes(mode)){assert.equal(r.independentFallback,1);assert.equal(r.submittedGuard.unexpected,0);}
    if(mode==='lateDigest'){assert.equal(r.injected,true);assert.equal(r.submittedGuard.unexpected,1);}
    if(mode==='normal'||mode==='ownFault')assert.equal(r.independentFallback,0);
    return r;
  });
  const prep=require('./'+names.prep),src=read(names.run).toString('utf8');
  test('R5 source checks: sibling FailAt, success EnvFree expectation, raw JSON string',()=>{
    const hook=src.slice(src.indexOf('internal static class Hook'),src.indexOf('static string Q('));
    const obs=src.slice(src.indexOf('internal sealed class L2MemberObserver'));
    assert.ok(hook.includes('static string FailAt="NONE"'));assert.ok(obs.includes('(FailAt=="OBS_FAILURE")'));
    assert.equal(prep.ENV_FREE_EXPECT[0],0);assert.ok(src.includes('if(env!=IntPtr.Zero)Hook.EnvFree(env);'));
    assert.ok(src.includes('J("note","synthetic boundary fixture; production helper not executed")'));
    assert.throws(()=>JSON.parse('{"note":synthetic boundary fixture; production helper not executed}'));
    return {sourceOnly:true,csharpExecuted:false,successEnvFreeExpected:0,unquotedNote:true};
  });
  test('R5 Output capability check slices empty text and misses replacement',()=>{
    assert.ok(src.indexOf('sealed class Output')>src.indexOf('sealed class Receipt'));
    const bad=src.replace('Hook.ReadChunk(handle, buffer, out count)','ReadFile(handle, buffer, out count)');
    assert.notEqual(bad,src);assert.deepEqual(prep.inspect(bad),[]);return {unapprovedReadFileNotDetected:true};
  });
  test('R5 removing all eight final close operations still passes static closure checker',()=>{
    const original='r.HandlesClosed=(Close(ref pi.Thread,r)&Close(ref pi.Process,r)&Close(ref rd,r)&Close(ref wr,r)&Close(ref er,r)&Close(ref ew,r)&Close(ref input,r)&Close(ref job,r))&&r.HandlesClosed;';
    const bad=src.replace(original,'r.HandlesClosed=true;');assert.notEqual(bad,src);assert.deepEqual(prep.inspect(bad),[]);
    const finalization=src.slice(src.indexOf('internal static bool FinalizationOk'),src.indexOf('static string Q('));
    assert.equal(/(?:==|IndexOf\()15\b/.test(finalization),false);
    return {eightCloseRemovalUndetected:true,sourceOnly:true,csharpExecuted:false};
  });
  const runtimeDigests=Object.fromEntries(Object.entries(names).map(([k,n])=>[k,H(read(n))]));
  const ok=results.every(r=>r.matched)&&guard.probes===5&&guard.unexpected===0;
  const report={schema:'codex-rootonly-60ed280-independent-review/1',reviewedCommit:'60ed280',runtimeDigests,
    ok,exitCode:ok?0:1,checks:results.length,guard,results,
    limitations:['All OS boundaries are synthetic; fallback interceptions are separately recorded per VM.','Counterexample matched is not product acceptance. No C# compilation, OS tree, credentials, cloud, or real input.']};
  const out=JSON.stringify(report,null,2)+'\n';if(argv.length)fs.writeFileSync(argv[1],out,{flag:'wx'});else fs.writeSync(1,out);
  process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,error:e.message,guard})+'\n');process.exitCode=1;}
