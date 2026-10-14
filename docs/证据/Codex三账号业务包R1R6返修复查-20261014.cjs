'use strict';
// c62f32d 独立离线复查。断言含缺陷复现，全部符合预期不等于验收通过。
// 默认 stdout；--out 仅 wx 新建。仅在唯一 artifacts 目录制造反例，不改受审文件。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const hits = [], undo = [];
function guard(obj, key) {
  if (typeof obj[key] !== 'function') return;
  const old = obj[key];
  obj[key] = function () { hits.push(key); throw new Error('CODEX_OFFLINE_BLOCK'); };
  undo.push(() => { obj[key] = old; });
}
for (const id of ['http', 'https']) for (const k of ['request', 'get']) guard(require('node:' + id), k);
for (const k of ['connect', 'createConnection']) guard(require('node:net'), k);
guard(require('node:net').Socket.prototype, 'connect'); guard(require('node:tls'), 'connect');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), k); guard(require('node:dns').promises, k);
}
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) guard(require('node:child_process'), k);
guard(globalThis, 'fetch');
const tool = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const root = path.join(ROOT, 'artifacts/schedule-sandbox/business-test', 'codex-c62-' + crypto.randomUUID());
fs.mkdirSync(root, { recursive: true });
const results = [];
let seq = 0, expectedHits = 0;
function plan(w = 'P', real = false) {
  const round = 'synthetic-review-c62';
  return {
    schema: 'business-test-plan/1', window: w, windowNo: w + '-01', synthetic: !real,
    businessRoundId: round, appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723',
    users: Object.fromEntries(['owner','manager','worker'].map((r,i) =>
      [r, {userId: 'u_' + String(i+1).repeat(40), source: 'synthetic fixture only'}])),
    projectReadyMarker: 'synthetic-review-marker',
    windowStartsAt: '2030-01-01T00:00:00Z', windowExpiresAt: '2030-01-01T01:00:00Z',
    ...(real ? {participantEvidence: Object.fromEntries(['owner','manager','worker'].map(r =>
      [r, {kind:'readback-record',recordSha256:'a'.repeat(64)}]))} : {}),
    ...(w !== 'P' ? {projectId:'p_sbx_' + sha(round).slice(0,32)} : {})
  };
}
function file(p) { const f = path.join(root,'input-' + (++seq) + '.json'); fs.writeFileSync(f,JSON.stringify(p),{flag:'wx'}); return f; }
function build(p=plan(),name='out-'+(++seq)) { return tool.build(p.window,file(p),path.join(root,name)); }
function disk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out=[];
  const walk=(d,pre='')=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){
    if(e.isDirectory()) walk(path.join(d,e.name),pre+e.name+'/');
    else out.push(pre+e.name);
  }};
  walk(dir); return out.sort();
}
function withClock(fn, clock=()=>Date.parse('2030-01-01T00:30:00Z')) {
  const old=Date.now; Date.now=clock; try{return fn();}finally{Date.now=old;}
}
function capture(fn) { try { return {returned:fn()}; } catch(e) { return {error:e}; } }
async function probe(id,kind,fn) {
  try { results.push({id,kind,assertionsPassed:true,actual:await fn()}); }
  catch(e) { results.push({id,kind,assertionsPassed:false,error:e.message}); }
}
async function main() {
  await probe('C01','control',()=>{
    for(const f of [()=>require('node:https').request('https://example.invalid'),()=>require('node:child_process').spawn('not-executed',[])]) {
      assert.throws(f,/CODEX_OFFLINE_BLOCK/); expectedHits++;
    }
    const b=build(); assert.equal(tool.checkDir(b.outDir).ok,true);
    const again=tool.build('P',file(plan()),b.outDir);
    assert.equal(again.io.filter(x=>x.action==='written').length,0);
    const victim=path.join(b.outDir,'close/server/gate.js'); fs.unlinkSync(victim);
    const resumed=tool.build('P',file(plan()),b.outDir);
    assert.equal(resumed.io.filter(x=>x.action==='written').length,1);
    assert.equal(resumed.io.filter(x=>x.action==='reused').length,47);
    return {files:disk(b.outDir).length,completeReuse:true,resumeWritten:1,resumeReused:47};
  });
  await probe('C02','remaining-R1',()=>{
    const b=build(), m=JSON.parse(fs.readFileSync(path.join(b.outDir,'manifest.json')));
    const row=m.files.find(x=>x.rel==='plan.json'); row.sha256='0'.repeat(64); row.bytes=-1;
    fs.writeFileSync(path.join(b.outDir,'manifest.json'),JSON.stringify(m));
    const checked=tool.checkDir(b.outDir); assert.equal(checked.ok,true);
    return {tamperedPlanEntryAccepted:checked.ok,planChecked:checked.planChecked,declaredBytes:row.bytes};
  });
  await probe('C03','remaining-R2',()=>{
    const p=plan('P',true),b=withClock(()=>build(p));
    let now=Date.parse('2030-01-01T00:30:00Z'),calls=0,triggered=false;
    const read=fs.readFileSync, target=path.join(b.outDir,'server/index.js');
    fs.readFileSync=function(f,...args){ const r=read.call(this,f,...args); if(f===target){now=Date.parse(p.windowExpiresAt);triggered=true;} return r; };
    let checked; try{checked=withClock(()=>tool.checkDir(b.outDir),()=>{calls++;return now;});}finally{fs.readFileSync=read;}
    assert.equal(triggered,true);assert.equal(checked.ok,true);assert.equal(calls,1);
    return {expiredDuringCheckAccepted:true,dateNowCalls:calls,advanceEvent:'candidate server/index.js read'};
  });
  await probe('C04','remaining-R3',()=>{
    const out=path.join(root,'directory-conflict');fs.mkdirSync(path.join(out,'manifest.json'),{recursive:true});
    const r=capture(()=>tool.build('P',file(plan()),out));assert.ok(r.error);
    const actual=disk(out); assert.equal(actual.length,47);
    return {error:r.error.code,wroteFiles:r.error.wroteFiles,filesAfter:actual.length,preexistingConflict:'manifest.json is directory'};
  });
  await probe('C05','remaining-R3',()=>{
    const out=path.join(root,'partial-io'), f=file(plan()),write=fs.writeFileSync;
    fs.writeFileSync=function(p,b,o){
      if(p===path.join(out,'server/index.js')){write.call(this,p,Buffer.from(b).subarray(0,7),o);const e=new Error('synthetic partial write');e.code='EIO';throw e;}
      return write.call(this,p,b,o);
    };
    let r;try{r=capture(()=>tool.build('P',f,out));}finally{fs.writeFileSync=write;}
    assert.equal(r.error.code,'EIO');assert.equal(disk(out).length,1);assert.equal(r.error.wroteFiles,undefined);
    return {error:r.error.code,filesOnDisk:disk(out),bytes:fs.statSync(path.join(out,'server/index.js')).size,reportedWritten:r.error.written||null,reportedWroteFiles:r.error.wroteFiles??null};
  });
  await probe('C06','remaining-R3',()=>{
    // Both paths are fresh inside this review's artifacts; junction target is outside the tool output root.
    const target=path.join(ROOT,'artifacts/schedule-sandbox','registration-codex-junction-target-'+crypto.randomUUID());
    fs.mkdirSync(target); const link=path.join(root,'linked-output'); fs.symlinkSync(target,link,'junction');
    const b=tool.build('P',file(plan()),link);
    assert.equal(disk(target).length,48);
    return {rootJunctionAccepted:true,filesOutsideBusinessTestRoot:disk(target).length,checkOk:tool.checkDir(b.outDir).ok};
  });
  await probe('C07','remaining-R4',()=>{
    const b=build(),close=path.join(b.outDir,'close');
    const cfg=JSON.parse(fs.readFileSync(path.join(close,'project.config.json')));
    const app=JSON.parse(fs.readFileSync(path.join(close,'frontend/app.json')));
    const missingPages=app.pages.filter(p=>!fs.existsSync(path.join(close,'frontend',p+'.js')));
    assert.equal(fs.existsSync(path.join(close,cfg.miniprogramRoot,'app.json')),false);
    assert.equal(missingPages.length,8); assert.equal(tool.checkCloseDir(b.outDir).ok,true);
    return {checkCloseOk:true,miniprogramRoot:cfg.miniprogramRoot,cloudfunctionRoot:cfg.cloudfunctionRoot,actualRoots:['frontend','server'],declaredPages:app.pages.length,missingPages};
  });
  await probe('C08','remaining-R5',()=>{
    const p=plan('E',true);
    p.projectReadback={source:'readback',projectId:p.projectId,businessRoundId:p.businessRoundId,projectReadyMarker:p.projectReadyMarker,recordSha256:'a'.repeat(64)};
    const b=withClock(()=>build(p));const checked=withClock(()=>tool.checkDir(b.outDir));
    assert.equal(checked.ok,true);
    return {realModeAccepted:true,checkOk:true,evidenceFileCount:0,allEvidenceHashesInvented:true,userSourceBinding:b.manifest.userSourceBinding};
  });
  await probe('C09','closed-controls',()=>{
    const p=plan('P',true), out=path.join(root,'expired');
    const r=withClock(()=>capture(()=>tool.build('P',file(p),out)),()=>Date.parse(p.windowExpiresAt));
    assert.equal(r.error.code,'BTP_WINDOW_EXPIRED');assert.equal(fs.existsSync(out),false);
    const b=withClock(()=>build(p));
    assert.equal(withClock(()=>tool.checkDir(b.outDir),()=>Date.parse(p.windowExpiresAt)).ok,false);
    const expiredClose=withClock(()=>tool.checkCloseDir(b.outDir),()=>NaN);assert.equal(expiredClose.ok,true);
    return {expiresEqualRejected:true,alreadyExpiredCheckRejected:true,closeClockIndependent:true};
  });
  await probe('C10','remaining-R6',async()=>{
    const ep=path.join(ROOT,'docs/证据/三账号业务测试包返修复核-20261014.cjs');
    const src=fs.readFileSync(ep,'utf8');
    const anchor='  const g0Baseline = guardHits.length;';
    assert.equal(src.split(anchor).length,2);
    // A caught unexpected request is blocked by the script's own guard, but omitted from its counter.
    const changed=src.replace(anchor,"  try { require('node:https').get('https://example.invalid'); } catch (_) {}\n"+anchor)
      .replace('main().catch(e =>','return main().catch(e =>');
    let stdout='',exitCode=0;
    const fakeProcess={argv:['node',ep],stdout:{write:s=>{stdout+=s;}},get exitCode(){return exitCode;},set exitCode(v){exitCode=v;}};
    const run=vm.runInThisContext('(async function(require,__dirname,process,console){'+changed+'\n})',{filename:ep});
    await run(createRequire(ep),path.dirname(ep),fakeProcess,{error(){}});
    const report=JSON.parse(stdout);
    assert.equal(report.summary.unexpectedGuardAttempts,0);assert.equal(exitCode,0);
    return {injectedBlockedUnexpectedAttempt:1,reportedUnexpected:report.summary.unexpectedGuardAttempts,exitCode,reportedCommit:report.reviewedCommit};
  });
  await probe('C11','closed-build-clock-controls',()=>{
    const matrix=[];
    for(const mode of ['first-write','final-write','reuse','resume']) {
      const p=plan('P',true),pf=file(p),out=path.join(root,'clock-'+mode);
      if(mode==='reuse'||mode==='resume') withClock(()=>tool.build('P',pf,out));
      if(mode==='resume') fs.unlinkSync(path.join(out,'manifest.json'));
      let now=Date.parse('2030-01-01T00:30:00Z'),calls=0,writes=0;
      const read=fs.readFileSync,write=fs.writeFileSync;
      fs.writeFileSync=function(f,...args) {
        const r=write.call(this,f,...args);
        if(typeof f==='string'&&f.startsWith(out+path.sep)) {
          writes++;
          if(mode==='first-write'||mode==='resume'||(mode==='final-write'&&writes===48)) now=Date.parse(p.windowExpiresAt);
        }
        return r;
      };
      fs.readFileSync=function(f,...args) {
        const r=read.call(this,f,...args);
        if(mode==='reuse'&&f===path.join(out,'server/index.js')) now=Date.parse(p.windowExpiresAt);
        return r;
      };
      let r;try{r=withClock(()=>capture(()=>tool.build('P',pf,out)),()=>{calls++;return now;});}
      finally{fs.writeFileSync=write;fs.readFileSync=read;}
      assert.equal(r.error.code,'BTP_WINDOW_EXPIRED');assert.ok(calls>1);
      const want={'first-write':1,'final-write':48,reuse:0,resume:1}[mode];
      assert.equal(r.error.wroteFiles||0,want);
      assert.equal((r.error.written||[]).length,want);
      matrix.push({mode,dateNowCalls:calls,writes,reportedWritten:want});
    }
    for(const [expected,c] of [['BTP_CLOCK_INVALID',()=>NaN],['BTP_CLOCK_ERROR',()=>{throw new Error('english clock failure');}],['BTP_WINDOW_NOT_OPEN',()=>Date.parse('2029-12-31T23:59:59Z')]]) {
      const r=withClock(()=>capture(()=>build(plan('P',true))),c);assert.equal(r.error.code,expected);
    }
    return {matrix,clockInvalidAndThrowDistinct:true,notOpenRejected:true};
  });
  await probe('C12','closed-R1-original-controls',()=>{
    const b=build(plan('E')),mp=path.join(b.outDir,'manifest.json'),g=path.join(b.outDir,'server/gate.js');
    const m=JSON.parse(fs.readFileSync(mp)),buf=Buffer.concat([fs.readFileSync(g),Buffer.from('\n// unaudited mutation\n')]);
    fs.writeFileSync(g,buf);const row=m.files.find(x=>x.rel==='server/gate.js');row.bytes=buf.length;row.sha256=sha(buf);
    fs.writeFileSync(mp,JSON.stringify(m));assert.equal(tool.checkDir(b.outDir).ok,false);
    const p=build(),pm=path.join(p.outDir,'manifest.json'),before=JSON.parse(fs.readFileSync(pm));before.synthetic=false;
    fs.writeFileSync(pm,JSON.stringify(before));assert.equal(tool.checkDir(p.outDir).ok,false);
    assert.equal(tool.checkCloseDir(p.outDir).ok,true);
    return {selfReportedFileHashInsufficient:true,manifestModeFlipRejected:true,independentCloseHashCheck:true};
  });
  const report={
    reviewedCommit:'c62f32d',reviewBasis:'3cbdd7f',generatedAt:new Date().toISOString(),
    implementationSha256:sha(fs.readFileSync(path.join(ROOT,'miniapp/scripts/package-business-test.cjs'))),
    verificationKind:'local synthetic filesystem/time/VM only; no SDK or platform verification',
    artifactDirectory:path.relative(ROOT,root).split(path.sep).join('/'),results,
    summary:{total:results.length,assertionsPassed:results.filter(x=>x.assertionsPassed).length,guardSensitivityHits:expectedHits,unexpectedGuardAttempts:hits.length-expectedHits,accepted:false}
  };
  const json=JSON.stringify(report,null,2)+'\n',args=process.argv.slice(2);
  if(args.length){assert.equal(args.length,2);assert.equal(args[0],'--out');fs.writeFileSync(path.resolve(args[1]),json,{flag:'wx'});}
  process.stdout.write(json);
  if(results.some(x=>!x.assertionsPassed)||hits.length!==expectedHits) process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>undo.reverse().forEach(f=>f()));
