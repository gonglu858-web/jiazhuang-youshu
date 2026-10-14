'use strict';
// Independent local counterexamples. No source edits, SDK, network or real credentials.
// Outputs only to a fresh ignored artifact directory; JSON defaults to stdout, --out uses wx.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const guardHits = [];
const restore = [];
function guard(mod, name) {
  if (typeof mod[name] !== 'function') return;
  const old = mod[name];
  mod[name] = function () { guardHits.push(name); throw new Error('LOCAL_REVIEW_BLOCKED'); };
  restore.push(() => { mod[name] = old; });
}
for (const id of ['node:http', 'node:https']) {
  const mod = require(id); for (const name of ['request', 'get']) guard(mod, name);
}
for (const name of ['connect', 'createConnection']) guard(require('node:net'), name);
guard(require('node:net').Socket.prototype, 'connect');
guard(require('node:tls'), 'connect');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  guard(require('node:dns'), name); guard(require('node:dns').promises, name);
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  guard(require('node:child_process'), name);
}
guard(globalThis, 'fetch');
const tool = require(path.join(ROOT, 'miniapp/scripts/package-business-test.cjs'));
const reg = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const run = 'codex-review-' + crypto.randomUUID();
const outRoot = path.join(ROOT, 'artifacts/schedule-sandbox/business-test', run);
fs.mkdirSync(outRoot, { recursive: false });
const results = [];
const T0 = Date.parse('2030-01-01T00:00:00Z');
let seq = 0;
function plan(window = 'P', overrides = {}) {
  const round = 'synthetic-review-round';
  return {
    schema: 'business-test-plan/1', window, synthetic: true,
    businessRoundId: round, windowNo: window + '-01',
    appId: 'wxfb4db1615ac15531', envId: 'cloud1-d8gcq5ag39d847723',
    users: Object.fromEntries(['owner','manager','worker'].map((role, i) =>
      [role,{ userId: 'u_' + String(i+1).repeat(40), source: 'synthetic fixture only' }])),
    projectReadyMarker: 'synthetic-marker',
    windowStartsAt: new Date(T0).toISOString(), windowExpiresAt: new Date(T0+60000).toISOString(),
    ...(window === 'P' ? {} : {projectId:'p_sbx_' + sha(round).slice(0,32)}), ...overrides
  };
}
function planFile(p) {
  const f = path.join(outRoot, 'plan-' + (++seq) + '.json');
  fs.writeFileSync(f, JSON.stringify(p), {flag:'wx'}); return f;
}
function build(name, p = plan()) { return tool.build(p.window, planFile(p), path.join(outRoot,name)); }
function tree(dir, prefix='') {
  if (!fs.existsSync(dir)) return {};
  const result = {};
  for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    const rel = prefix + e.name;
    if (e.isDirectory()) Object.assign(result, tree(path.join(dir,e.name),rel+'/'));
    else result[rel] = sha(fs.readFileSync(path.join(dir,e.name)));
  }
  return result;
}
async function probe(id, fn) {
  try { const actual = await fn(); results.push({id,assertionsPassed:true,actual}); }
  catch(e) { results.push({id,assertionsPassed:false,error:e.message}); }
}
function clock(fn, value=T0) {
  const old=Date.now; Date.now=()=>value;
  try{return fn();}finally{Date.now=old;}
}
async function main() {
  await probe('C01_source_count_and_missing_project',()=>{
    const b=build('complete');
    const all=[...tool.SERVER_FILES.map(r=>'miniapp/cloudfunctions/scheduleSandbox/'+r),
      ...tool.FRONTEND_FILES.map(r=>'miniapp/miniprogram/'+r)];
    for(const rel of all) assert.equal(sha(fs.readFileSync(path.join(ROOT,rel))),reg.PINNED_FACTS[rel].sha256);
    const absent=['frontend/app.js','frontend/app.json','project.config.json','close/frontend/app.js','close/frontend/app.json','close/project.config.json']
      .filter(r=>!fs.existsSync(path.join(b.outDir,r)));
    assert.equal(all.length,19); assert.equal(absent.length,6);
    return {sourceFiles:all.length,pinnedFactsKeys:Object.keys(reg.PINNED_FACTS).length,
      candidateFiles:b.manifest.files.length,closeFiles:b.manifest.closePackage.files.length,missing:absent,checkOk:tool.checkDir(b.outDir).ok};
  });
  await probe('C02_empty_self_declared_manifest_accepted',()=>{
    const d=path.join(outRoot,'empty'); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d,'manifest.json'),JSON.stringify({schema:tool.MANIFEST_SCHEMA,files:[],closePackage:{files:[]}}));
    const r=tool.checkDir(d); assert.equal(r.ok,true); return {ok:r.ok,files:r.files,closeFiles:r.closeFiles};
  });
  await probe('C03_gate_tamper_plus_self_hash_accepted',()=>{
    const b=build('tamper',plan('E'));
    const f=path.join(b.outDir,'server/gate.js');
    let s=fs.readFileSync(f,'utf8');
    s=s.replace('const EXECUTE_ALLOWED = Object.freeze([',"const EXECUTE_ALLOWED = Object.freeze([\n  'reassignSchedule',");
    fs.writeFileSync(f,s);
    const rec=b.manifest.files.find(r=>r.rel==='server/gate.js');
    rec.sha256=sha(Buffer.from(s));rec.bytes=Buffer.byteLength(s);
    fs.writeFileSync(path.join(b.outDir,'manifest.json'),JSON.stringify(b.manifest));
    assert.equal(tool.checkDir(b.outDir).ok,true);
    return {addedAction:'reassignSchedule',checkOk:true,planDigestUnchanged:true};
  });
  await probe('C04_synthetic_to_real_manifest_flip_accepted',()=>{
    const b=build('modeflip');b.manifest.synthetic=false;
    fs.writeFileSync(path.join(b.outDir,'manifest.json'),JSON.stringify(b.manifest));
    assert.equal(tool.checkDir(b.outDir).ok,true);return {checkOk:true,changedOnly:'manifest.synthetic'};
  });
  await probe('C05_build_expiry_after_first_write_ignored',()=>{
    const d=path.join(outRoot,'expires-during-build');const pp=planFile(plan('P',{synthetic:false}));
    const oldNow=Date.now, oldWrite=fs.writeFileSync;let now=T0,calls=0,advanced=false;
    Date.now=()=>{calls++;return now;};
    fs.writeFileSync=function(f,...args){const result=oldWrite.call(fs,f,...args);
      if(String(f).startsWith(d+path.sep)){now=T0+60001;advanced=true;}return result;};
    try{const r=tool.build('P',pp,d);assert.ok(advanced);assert.equal(calls,1);
      return {returnedSuccess:true,dateNowCalls:calls,written:r.io.filter(i=>i.action==='written').length,expiredBeforeReturn:true};
    }finally{Date.now=oldNow;fs.writeFileSync=oldWrite;}
  });
  await probe('C06_expired_check_accepted',()=>{
    const b=clock(()=>build('expired-check',plan('P',{synthetic:false})));
    const r=clock(()=>tool.checkDir(b.outDir),T0+60001);assert.equal(r.ok,true);return {checkOk:true,expired:true};
  });
  await probe('C07_invalid_clock_accepted',()=>{
    const p=planFile(plan('P',{synthetic:false}));
    const r=clock(()=>tool.readPlan(p,'P'),NaN);assert.equal(r.synthetic,false);return {nanClockAccepted:true};
  });
  await probe('C08_preexisting_manifest_conflict_writes_38_files',()=>{
    const d=path.join(outRoot,'late-conflict');fs.mkdirSync(d);
    fs.writeFileSync(path.join(d,'manifest.json'),'sentinel');const before=tree(d);
    let err;try{tool.build('P',planFile(plan()),d);}catch(e){err=e;}
    const after=tree(d);assert.equal(err.code,'BTP_OUT_CONFLICT');assert.equal(Object.keys(after).length,39);
    assert.equal(before['manifest.json'],after['manifest.json']);
    return {code:err.code,newFiles:38,oldManifestUnchanged:true,errorHasWritten:Object.hasOwn(err,'written'),errorHasWroteFiles:Object.hasOwn(err,'wroteFiles')};
  });
  await probe('C09_partial_io_failure_loses_written_facts',()=>{
    const d=path.join(outRoot,'io-failure');const pp=planFile(plan());const old=fs.writeFileSync;let calls=0,err;
    fs.writeFileSync=function(f,...args){if(String(f).startsWith(d+path.sep)&&++calls===3){const e=new Error('synthetic EIO');e.code='EIO';throw e;}return old.call(fs,f,...args);};
    try{tool.build('P',pp,d);}catch(e){err=e;}finally{fs.writeFileSync=old;}
    assert.equal(Object.keys(tree(d)).length,2);assert.equal(err.code,'EIO');
    return {code:err.code,diskFiles:2,errorHasWritten:Object.hasOwn(err,'written'),errorHasWroteFiles:Object.hasOwn(err,'wroteFiles')};
  });
  await probe('C10_close_not_independent',()=>{
    const b=build('close-independent');let code;
    try{tool.checkDir(path.join(b.outDir,'close'));}catch(e){code=e.code;}
    assert.equal(code,'BTP_MANIFEST_INVALID');
    fs.unlinkSync(path.join(b.outDir,'frontend/pages/schedule-sandbox/schedule-sandbox.js'));
    const r=tool.checkDir(b.outDir);assert.equal(r.ok,false);
    return {checkCloseDirectoryError:code,closeFilesIntact:b.manifest.closePackage.files.every(e=>tree(b.outDir)[e.rel]===e.sha256),pairedCheckOk:r.ok};
  });
  await probe('C11_real_accepts_synthetic_sources_and_unwitnessed_project',()=>{
    const p=plan('E',{synthetic:false});const r=clock(()=>tool.readPlan(planFile(p),'E'));
    assert.equal(r.synthetic,false);assert.ok(r.users.every(u=>u.source==='synthetic fixture only'));
    return {accepted:true,sources:'synthetic fixture only',projectFromFormulaOnly:true,projectReadbackEvidenceProvided:false};
  });
  await probe('C12_x_page_keeps_v06_buttons_and_all_normal_actions',()=>{
    const b=build('page-x',plan('X'));const f=path.join(b.outDir,'frontend/pages/schedule-sandbox/schedule-sandbox.js');
    const req=createRequire(f);let def;
    const wx={getAccountInfoSync:()=>({miniProgram:{appId:'wxfb4db1615ac15531',envVersion:'develop'}})};
    vm.runInThisContext('(function(require,Page,wx){'+fs.readFileSync(f,'utf8')+'\n})')(req,d=>{def=d;},wx);
    const page={...def,data:JSON.parse(JSON.stringify(def.data)),setData(p){Object.assign(this.data,p);}};
    page.refreshEntry();const buttons=page.data.testCases.map(c=>c.id);
    assert.equal(page.data.testCardVisible,true);assert.equal(buttons.filter(id=>id.startsWith('V06')).length,3);
    return {testCardVisible:true,buttons,normalActions:page.data.actions};
  });
  await probe('C13_valid_partial_reuse_control',()=>{
    const p=plan();const pp=planFile(p);const d=path.join(outRoot,'partial');const b=tool.build('P',pp,d);
    const before=tree(d);const rel=b.manifest.closePackage.files[0].rel;fs.unlinkSync(path.join(d,rel));
    const r=tool.build('P',pp,d);assert.deepEqual(tree(d),before);assert.equal(r.io.filter(v=>v.action==='written').length,1);
    return {written:1,reused:r.io.filter(v=>v.action==='reused').length,checkOk:tool.checkDir(d).ok};
  });
  const unexpected=guardHits.length;
  await probe('C14_guard_sensitivity',()=>{
    for(const fn of [()=>require('node:https').request('https://example.invalid'),()=>require('node:child_process').spawn('node',[])]) {
      assert.throws(fn,/LOCAL_REVIEW_BLOCKED/);
    }
    assert.equal(unexpected,0);return {unexpectedBeforeProbes:unexpected,probeHits:guardHits.length-unexpected};
  });
  const report={reviewedCommit:'b5aff19',generatedAt:new Date().toISOString(),
    implementationSha256:sha(fs.readFileSync(path.join(ROOT,'miniapp/scripts/package-business-test.cjs'))),
    artifactDirectory:path.relative(ROOT,outRoot).replaceAll('\\','/'),
    verificationKind:'offline synthetic counterexamples; no SDK/platform/credentials',
    results,summary:{total:results.length,assertionsPassed:results.filter(r=>r.assertionsPassed).length,unexpectedGuardAttempts:unexpected}};
  const json=JSON.stringify(report,null,2)+'\n';const args=process.argv.slice(2);
  if(args.length){assert.equal(args.length,2);assert.equal(args[0],'--out');fs.writeFileSync(path.resolve(args[1]),json,{flag:'wx'});}
  process.stdout.write(json);
  if(results.some(r=>!r.assertionsPassed)||unexpected) process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>restore.reverse().forEach(fn=>fn()));
