'use strict';
// Local review only. Historical clock, no cloud/SDK/auth. stdout only; fixtures retained.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const asmPath = path.join(ROOT, 'miniapp/scripts/assemble-sandbox-registration.cjs');
const asm = require(asmPath);
const reg = require(path.join(ROOT, 'miniapp/scripts/package-sandbox-registration.cjs'));
const git = args => cp.execFileSync('git', args, {cwd: ROOT, windowsHide: true});
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const tracked = git(['ls-files', '-z']).toString().split('\0').filter(Boolean);
const before = new Map(tracked.map(p => [p, sha(fs.readFileSync(path.join(ROOT,p)))]));
const guard = asm.installNetworkGuard({});
const runId = crypto.randomUUID().replace(/-/g,'').slice(0,12);
const T = Date.parse('2026-03-01T12:00:00Z');
const E = T + 20*60000;
let seq = 0;
const fresh = s => 'cxa-' + runId + '-' + (++seq) + '-' + s;
const report = {reviewCommit:'f9a8f2c',baseline:'b274da4',verificationKind:'OFFLINE_CONTRACT_FIXTURE', cases:[],fixtures:[]};
function snap(dir) {
 const out={}; if(!fs.existsSync(dir))return out;
 function walk(d) {for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p=path.join(d,e.name),r=path.relative(dir,p).replace(/\\/g,'/');
  if(e.isDirectory()){out[r+'/']='directory';walk(p);}else out[r]=sha(fs.readFileSync(p));
 }} walk(dir);return out;
}
function plan(synthetic=false) {return {purpose:'offline-fixture-codex-review', ...reg.FIXED_TARGET,
 allowedUserIds:[reg.CANDIDATE_USER_ID],roundId:fresh('offline-fixture'),
 windowStartsAt:new Date(T).toISOString(),windowExpiresAt:new Date(E).toISOString(),
 sourceVersion:reg.REVIEWED_SOURCE_VERSION,synthetic};}
function input(synthetic=false) {
 const p=plan(synthetic),r=reg.buildRegistration(p,{outId:fresh('input'),nowMs:T});
 assert.equal(r.ok,true,JSON.stringify(r.problems));report.fixtures.push(r.dir);return {plan:p,inputDir:r.dir};
}
function opts(i,id=fresh('out')) {return {...i,artifactKind:'real-candidate',outId:id};}
function good(i) {const o=opts(i); const r=asm.buildAssembly({...o,nowMs:T});assert.equal(r.ok,true,JSON.stringify(r.problems));report.fixtures.push(r.dir);return {o,r};}
function summarize(r) {return {ok:r.ok,reused:r.reused,wroteFiles:r.wroteFiles,expiredAfterWrite:r.expiredAfterWrite,problems:r.problems};}
function crossed(i,operation,trigger,target) {
 let now=T, reads=0, fired=false;
 const date=Date.now,read=fs.readFileSync,write=fs.writeFileSync;
 Date.now=()=>{reads++;return now;};
 const source=path.join(ROOT,'miniapp/miniprogram/app.js');
 fs.readFileSync=function(p,...args){const b=read.call(fs,p,...args);if(trigger==='source'&&path.resolve(String(p))===source){now=E;fired=true;}return b;};
 fs.writeFileSync=function(p,...args){const v=write.call(fs,p,...args);if(trigger==='write'&&path.resolve(String(p)).startsWith(target+path.sep)){now=E;fired=true;}return v;};
 let r;
 try {r=operation();}finally {Date.now=date;fs.readFileSync=read;fs.writeFileSync=write;}
 assert.equal(fired,true,'event barrier not hit');
 return {clockReads:reads,barrierHit:fired,atDeadline:now===E,result:summarize(r),bugReproduced:r.ok===true};
}
try {
 // Scope / exact historical suffix / independent source pins.
 const changed=git(['diff','--name-only','-z','b274da4','f9a8f2c']).toString().split('\0').filter(Boolean);
 assert.equal(changed.length,7);
 const endings=[];
 for(const p of ['docs/进展与待办.md','docs/WorkBuddy开发交接.md']) {
  const old=git(['show','b274da4:'+p]),cur=git(['show','f9a8f2c:'+p]);
  const suffix=old.subarray(old.indexOf(10)+1);assert.ok(cur.subarray(cur.length-suffix.length).equals(suffix));
  const stats=git(['diff','--numstat','b274da4','f9a8f2c','--',p]).toString().trim();
  endings.push({path:p,historicalSuffixByteIdentical:true,diff:stats,lfOnly:cur.toString().replace(/\r\n/g,'').includes('\n')});
 }
 const pins=[];
 for(const [p,f] of Object.entries(asm.PINNED_APP_FILES)) {
  const b=git(['show',reg.REVIEWED_SOURCE_VERSION+':'+p]);assert.equal(sha(b),f.sha256);assert.equal(b.length,f.bytes);pins.push(p);
 }
 report.cases.push({id:'scope-source-EOL',pass:true,changed,endings,pins});
 const i=input();const {o,r}=good(i);const tree=snap(r.dir);
 assert.equal(Object.keys(tree).filter(k=>!k.endsWith('/')).length,49);
 for(const root of [asm.REGISTRATION_ROOT,asm.CLOSED_ROOT]) {
  const project=path.join(r.dir,root);
  assert.equal(Object.keys(snap(project)).filter(k=>!k.endsWith('/')).length,24);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project,'miniprogram/app.json'))).pages,[asm.ONLY_PAGE]);
  for(const rel of reg.PACKAGE_FILES) {
   const inputFile=root===asm.REGISTRATION_ROOT?path.join(i.inputDir,'package',rel):path.join(asm.ARTIFACTS_ROOT,asm.CLOSED_DIR,'package',rel);
   assert.ok(fs.readFileSync(path.join(project,'cloudfunctions/scheduleSandbox',rel)).equals(fs.readFileSync(inputFile)));
  }
 }
 report.cases.push({id:'current-positive-49files',pass:true,dir:r.dir});
 for(const [id,patch] of [['wrong-user',{allowedUserIds:['u_'+'a'.repeat(40)]}],['wrong-env',{envId:'other'}],['source-drift',{sourceVersion:'other'}]]) {
  const b=opts(i),dir=asm.resolveOutDir(b.outId),s=snap(dir);
  const result=asm.buildAssembly({...b,plan:{...i.plan,...patch},nowMs:T});assert.equal(result.ok,false);assert.deepEqual(snap(dir),s);
  report.cases.push({id,pass:true,result:summarize(result)});
 }
 const conflict=opts(i),conflictDir=asm.resolveOutDir(conflict.outId);
 fs.mkdirSync(path.join(conflictDir,asm.REGISTRATION_ROOT,'miniprogram'),{recursive:true});
 fs.writeFileSync(path.join(conflictDir,asm.REGISTRATION_ROOT,'miniprogram/app.js'),'conflict');
 const conflictBefore=snap(conflictDir);const refused=asm.buildAssembly({...conflict,nowMs:T});assert.equal(refused.ok,false);assert.deepEqual(snap(conflictDir),conflictBefore);
 report.fixtures.push(conflictDir);report.cases.push({id:'preflight-conflict-zero-write',pass:true});
 const reused=asm.buildAssembly({...o,nowMs:T});assert.equal(reused.reused,true);assert.deepEqual(snap(r.dir),tree);
 const missing='registration-project/miniprogram/app.wxss';fs.unlinkSync(path.join(r.dir,'manifest.json'));fs.unlinkSync(path.join(r.dir,missing));
 const continued=asm.buildAssembly({...o,nowMs:T});assert.equal(continued.ok,true);assert.deepEqual(continued.written.slice().sort(),[missing,'manifest.json'].sort());
 report.cases.push({id:'valid-reuse-resume',pass:true});
 const b1=opts(i),d1=asm.resolveOutDir(b1.outId);report.fixtures.push(d1);
 report.cases.push({id:'R1-prewrite-deadline',...crossed(i,()=>asm.buildAssembly(b1),'source',d1),filesAfter:Object.keys(snap(d1)).filter(k=>!k.endsWith('/')).length});
 const b2=opts(i),d2=asm.resolveOutDir(b2.outId);report.fixtures.push(d2);
 report.cases.push({id:'R1-postwrite-deadline',...crossed(i,()=>asm.buildAssembly(b2),'write',d2),filesAfter:Object.keys(snap(d2)).filter(k=>!k.endsWith('/')).length});
 report.cases.push({id:'R1-check-deadline',...crossed(i,()=>asm.checkAssembly({...i,artifactKind:'real-candidate',outDir:r.dir}),'source',r.dir)});
 report.cases.push({id:'R1-reuse-deadline',...crossed(i,()=>asm.buildAssembly(o),'source',r.dir)});
 fs.unlinkSync(path.join(r.dir,'manifest.json'));fs.unlinkSync(path.join(r.dir,missing));
 report.cases.push({id:'R1-resume-deadline',...crossed(i,()=>asm.buildAssembly(o),'source',r.dir)});
 const origDate=Date.now;Date.now=()=>E;
 try {const exp=asm.checkAssembly({...i,artifactKind:'real-candidate',outDir:r.dir});assert.equal(exp.ok,false);assert.equal(reg.describeClosedPackage().entryState.enabled,false);
 report.cases.push({id:'entry-expired-closed-independent',pass:true,result:summarize(exp)});}finally{Date.now=origDate;}
 // Generate with actual pre-change module loaded from Git, not a hand-crafted manifest.
 const oldSource=git(['show','b274da4:miniapp/scripts/assemble-sandbox-registration.cjs']).toString();
 const m=new Module(asmPath,module);m.filename=asmPath;m.paths=Module._nodeModulePaths(path.dirname(asmPath));m._compile(oldSource,asmPath);const old=m.exports;
 const si=input(true),oldId=fresh('old-schema'),oldOptions={...si,outId:oldId,nowMs:T};
 const oldBuilt=old.buildAssembly(oldOptions);assert.equal(oldBuilt.ok,true);report.fixtures.push(oldBuilt.dir);
 assert.equal(old.checkAssembly({...si,outDir:oldBuilt.dir}).ok,true);
 const bytes=fs.readFileSync(path.join(oldBuilt.dir,'manifest.json'));
 const newCheck=asm.checkAssembly({...si,outDir:oldBuilt.dir});const newReuse=asm.buildAssembly(oldOptions);
 assert.ok(fs.readFileSync(path.join(oldBuilt.dir,'manifest.json')).equals(bytes));
 report.cases.push({id:'R2-old-actual-schema1',oldGeneration:true,oldCheck:true,oldFields:Object.keys(JSON.parse(bytes)),newCheck:summarize(newCheck),newReuse:summarize(newReuse),manifestUnchanged:true,bugReproduced:!newCheck.ok&&!newReuse.ok});
 const drift=tracked.filter(p=>!fs.existsSync(path.join(ROOT,p))||sha(fs.readFileSync(path.join(ROOT,p)))!==before.get(p));assert.deepEqual(drift,[]);
 report.protected={count:tracked.length,drift};report.networkAttempts=guard.attempts.length;assert.equal(report.networkAttempts,0);
 report.summary={groups:report.cases.length,positiveGroups:report.cases.filter(c=>c.pass).length,defectPaths:report.cases.filter(c=>c.bugReproduced).length};
} finally {asm.restoreNetworkGuard(guard);}
process.stdout.write(JSON.stringify(report,null,2)+'\n');
