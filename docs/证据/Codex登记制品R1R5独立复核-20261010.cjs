'use strict';
// Offline independent review. Unique ignored fixtures; stdout only; no historical JSON overwrite.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),toolPath=path.join(root,'miniapp/scripts/package-sandbox-registration.cjs');
const reg=require(toolPath),basePath=path.join(path.dirname(toolPath),'package-sandbox.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const run='review-'+crypto.randomUUID().replace(/-/g,'').slice(0,16);let serial=0;
const next=()=>run+'-'+(++serial),now=Date.now();
const plan=patch=>({purpose:'independent-local-review',...reg.FIXED_TARGET,allowedUserIds:[reg.CANDIDATE_USER_ID],
  roundId:'CODEX-R1R5-LOCAL',windowStartsAt:new Date(now).toISOString(),windowExpiresAt:new Date(now+1200000).toISOString(),
  sourceVersion:reg.REVIEWED_SOURCE_VERSION,synthetic:true,...patch});
const out=id=>path.join(reg.ARTIFACTS_ROOT,'registration-'+id);
function snap(dir){
  if(!fs.existsSync(dir))return null;
  const rows=[];function walk(d,p=''){for(const n of fs.readdirSync(d).sort()){
    const f=path.join(d,n),r=p+n,s=fs.lstatSync(f);
    if(s.isSymbolicLink())rows.push([r,'link',fs.readlinkSync(f)]);
    else if(s.isDirectory()){rows.push([r,'dir']);walk(f,r+'/');}
    else rows.push([r,sha(fs.readFileSync(f))]);
  }}walk(dir);return rows;
}
function noWriteReject(p,id,tool=reg){const before=snap(out(id));assert.throws(()=>tool.buildRegistration(p,{outId:id,nowMs:now}));assert.deepEqual(snap(out(id)),before);}
function make(){const b=reg.buildRegistration(plan(),{outId:next(),nowMs:now});assert.equal(b.ok,true);return b;}
function changeManifest(b,fn){const f=path.join(b.dir,'manifest.json'),m=JSON.parse(fs.readFileSync(f));fn(m);fs.writeFileSync(f,JSON.stringify(m));}
function checkReject(b,tool=reg){const before=snap(b.dir);assert.equal(tool.checkRegistration({outDir:b.dir}).ok,false);assert.deepEqual(snap(b.dir),before);}
// Evaluate real builder AND old helper against a local fs facade, never monkeypatch global fs.
function toolWithFs(overrides){const facade={...fs,...overrides};function load(file,base){
  const mod={exports:{}},req=createRequire(file);
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){'+fs.readFileSync(file,'utf8').replace(/^#![^\n]*\n/,'')+'\n})')(
    n=>n==='node:fs'?facade:n==='./package-sandbox.cjs'?base:req(n),mod,mod.exports,file,path.dirname(file));return mod.exports;
}return load(toolPath,load(basePath));}
const prior=JSON.parse(fs.readFileSync(path.join(__dirname,'本地页面开发本人登记制品R1R5返修-20261010.json')));
const protectedPaths=prior.protectedFiles.files.map(f=>f.path).concat(['miniapp/scripts/package-sandbox-registration.cjs','miniapp/tests/sandbox-registration-package.test.cjs',
 'docs/证据/本地页面开发本人登记制品R1R5返修-20261010.cjs','docs/证据/本地页面开发本人登记制品R1R5返修-20261010.json']);
const hashes=()=>protectedPaths.map(p=>sha(fs.readFileSync(path.join(root,p))));
const before=hashes(),rows=[];
async function sample(name,fn){try{const detail=await fn();rows.push({name,passed:true,...detail});}catch(e){rows.push({name,passed:false,error:e.code||e.name});}}

// Actual Page/client/coordinator loader; only platform API/storage/config are synthetic.
function pageHarness(b,{closed=false,version='develop',fail=false}={}){
  const mini=path.join(root,'miniapp/miniprogram'),cache=new Map(),calls=[],loaded=[],store=new Map([['unrelated','keep']]);let def,clears=0,removes=0;
  const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const wx={getAccountInfoSync:()=>({miniProgram:{appId:reg.FIXED_TARGET.appId,envVersion:version}}),
    getStorageInfoSync:()=>({keys:[...store.keys()]}),getStorageSync:k=>copy(store.get(k)),setStorageSync:(k,v)=>store.set(k,copy(v)),
    removeStorageSync:k=>{removes++;store.delete(k);},clearStorageSync:()=>{clears++;store.clear();},
    cloud:{callFunction:async a=>{calls.push(copy(a));if(fail)throw Error('synthetic unknown');return {result:{ok:true,userId:reg.CANDIDATE_USER_ID,isAdmin:false}};}}};
  function load(f){f=path.resolve(f);if(cache.has(f))return cache.get(f).exports;const rel=path.relative(mini,f).replace(/\\/g,'/');assert.ok(!rel.startsWith('../'));
    let code=fs.readFileSync(f,'utf8');if(rel==='config/schedule-sandbox-proof.js')code=fs.readFileSync(path.join(b.dir,'package',closed?'frontend-closed':'frontend','config/schedule-sandbox-proof.js'),'utf8');
    const m={exports:{}};cache.set(f,m);loaded.push(rel);
    vm.runInNewContext(code,{module:m,exports:m.exports,wx,Page:v=>{def=v;},console,Date,setTimeout,clearTimeout,require:n=>{assert.ok(n.startsWith('.'));let p=path.resolve(path.dirname(f),n);if(!path.extname(p))p+='.js';return load(p);}},{filename:f});return m.exports;
  }
  load(path.join(mini,'pages/schedule-sandbox/schedule-sandbox.js'));assert.ok(def);
  const page={...def,data:copy(def.data),setData(p){for(const [k,v]of Object.entries(p)){const bits=k.split('.');let d=this.data;for(const b of bits.slice(0,-1))d=d[b]||(d[b]={});d[bits.at(-1)]=v;}}};
  return {page,calls,loaded,store,wx,client:cache.get(path.join(mini,'utils/schedule-sandbox-client.js')).exports,counters:()=>({clears,removes})};
}
async function main(){
  const control=make();
  await sample('control-generate-check-reuse',()=>{assert.equal(reg.checkRegistration({outDir:control.dir}).ok,true);const old=snap(control.dir);
    const b=reg.buildRegistration(plan(),{outId:path.basename(control.dir).slice(13),nowMs:now+1000});assert.equal(b.reused,true);assert.equal(b.wroteFiles,false);assert.deepEqual(snap(control.dir),old);});
  await sample('R1-targets-and-version-zero-write',()=>{for(const p of [plan({allowedUserIds:[reg.CANDIDATE_USER_ID,'u_'+'a'.repeat(40)]}),
    plan({synthetic:false,allowedUserIds:['u_'+'b'.repeat(40)]}),plan({sourceVersion:'self-reported-version'})])noWriteReject(p,next());});
  await sample('R1-eight-source-drifts-zero-write',()=>{for(const rel of reg.PACKAGE_FILES){const target=path.join(reg.SOURCE_DIR,rel);
    const t=toolWithFs({readFileSync(f,...a){const b=fs.readFileSync(f,...a);return path.resolve(f)===target?Buffer.concat([Buffer.from(b),Buffer.from('\n// independent drift')]):b;}});noWriteReject(plan(),next(),t);}return {sources:8};});
  await sample('R1-generated-string-is-data',()=>{const p=plan({roundId:"x' + (globalThis.__marker=1) + '\n\\end"}),b=reg.buildRegistration(p,{outId:next(),nowMs:now});assert.equal(b.ok,true);
    for(const prefix of ['frontend','frontend-closed']){const ctx={module:{exports:{}}};vm.runInNewContext(fs.readFileSync(path.join(b.dir,'package',prefix,'config/schedule-sandbox-proof.js'),'utf8'),ctx);assert.equal(ctx.__marker,undefined);assert.equal(ctx.module.exports.roundId,p.roundId);}});
  await sample('R2-conflict-preserved-zero-write',()=>{const id=next();fs.mkdirSync(path.join(out(id),'package'),{recursive:true});fs.writeFileSync(path.join(out(id),'package/gate.js'),'keep conflict');noWriteReject(plan(),id);});
  await sample('R2-junction-preserved-zero-write',()=>{const id=next(),target=out(next());fs.mkdirSync(path.join(out(id),'package'),{recursive:true});fs.mkdirSync(target);fs.writeFileSync(path.join(target,'keep'),'sentinel');
    fs.symlinkSync(target,path.join(out(id),'package/vendor'),'junction');const original=snap(target);noWriteReject(plan(),id);assert.deepEqual(snap(target),original);});
  await sample('R2-partial-resume-reuses-bytes',()=>{const id=next(),f=path.join(out(id),'package/gate.js');fs.mkdirSync(path.dirname(f),{recursive:true});const bytes=fs.readFileSync(path.join(control.dir,'package/gate.js'));fs.writeFileSync(f,bytes);
    const b=reg.buildRegistration(plan(),{outId:id,nowMs:now});assert.equal(b.ok,true);assert.ok(!b.written.includes('package/gate.js'));assert.deepEqual(fs.readFileSync(f),bytes);assert.equal(reg.checkRegistration({outDir:b.dir}).ok,true);});
  await sample('R2-write-fault-retained-then-resumed',()=>{let writes=0;const id=next(),t=toolWithFs({writeFileSync(...args){if(++writes===4){const e=Error('synthetic');e.code='EIO';throw e;}return fs.writeFileSync(...args);}});
    const failed=t.buildRegistration(plan(),{outId:id,nowMs:now});assert.equal(failed.incomplete,true);assert.equal(failed.written.length,3);const before=snap(out(id));
    const b=reg.buildRegistration(plan(),{outId:id,nowMs:now});assert.equal(b.ok,true);assert.equal(b.reusedFiles.length,3);for(const row of before.filter(x=>x[1]!=='dir'))assert.ok(snap(out(id)).some(x=>JSON.stringify(x)===JSON.stringify(row)));});
  await sample('R3-both-frontends-cannot-self-hash',()=>{for(const prefix of ['frontend','frontend-closed']){const b=make(),f=path.join(b.dir,'package',prefix,'config/schedule-sandbox-proof.js');fs.appendFileSync(f,'\nmodule.exports={enabled:true,functionName:"wrong"};');
    const bytes=fs.readFileSync(f);changeManifest(b,m=>Object.assign(prefix==='frontend'?m.frontendOverride:m.frontendClosedOverride,{sha256:sha(bytes),bytes:bytes.length}));checkReject(b);}});
  await sample('R3-manifest-full-contract',()=>{const mutations=[m=>m.deploymentAuthorized=true,m=>m.cloudExecuted=true,m=>m.artifacts.push(m.artifacts[0]),m=>m.artifacts[0].bytes=-1,
    m=>delete m.reviewedSource,m=>m.differences=[],m=>delete m.closedPackage,m=>m.frontendDependencies.files=[],m=>m.effectiveActions=['createProject']];
    for(const mutate of mutations){const b=make();changeManifest(b,mutate);checkReject(b);}return {mutations:mutations.length};});
  await sample('R3-top-extra-and-complete-missing',()=>{for(const kind of ['extra','missing']){const b=make();if(kind==='extra')fs.mkdirSync(path.join(b.dir,'unexpected'));else fs.unlinkSync(path.join(b.dir,'package/index.js'));
    checkReject(b);noWriteReject(plan(),path.basename(b.dir).slice(13));}});
  await sample('R3-complete-plan-reuse',()=>{const id=path.basename(control.dir).slice(13);for(const patch of [{synthetic:false},{purpose:'different'},
    {windowStartsAt:new Date(now+1000).toISOString()},{windowExpiresAt:new Date(now+1199000).toISOString()}])noWriteReject(plan(patch),id);});
  await sample('R4-closed-source-missing-and-corrupt',()=>{const f=path.join(reg.ARTIFACTS_ROOT,reg.CLOSED_DIR,'manifest.json');
    const t=toolWithFs({readFileSync(p,...args){if(path.resolve(p)===f)return Buffer.from('{broken');return fs.readFileSync(p,...args);}});
    noWriteReject(plan(),next(),t);checkReject(control,t);
    const missing=toolWithFs({existsSync(p){return path.resolve(p)===path.dirname(f)?false:fs.existsSync(p);}});
    noWriteReject(plan(),next(),missing);checkReject(control,missing);});
  await sample('R4-frontends-and-dependencies',()=>{const m=control.manifest;assert.equal(m.frontendDependencies.files.length,11);assert.equal(m.closedPackage.present,true);
    const a=require(path.join(control.dir,'package/frontend/config/schedule-sandbox-proof.js')),b=require(path.join(control.dir,'package/frontend-closed/config/schedule-sandbox-proof.js'));
    assert.equal(a.enabled,true);assert.equal(b.enabled,false);for(const k of ['roundId','envId','appId','functionName'])assert.equal(a[k],b[k]);});
  await sample('R5-real-page-single-identify',async()=>{const h=pageHarness(control);h.page.onLoad();h.page.onShow();assert.equal(h.calls.length,0);await h.page.runSelected();assert.equal(h.calls.length,1);
    const a=h.calls[0];assert.equal(a.name,'scheduleSandbox');assert.equal(a.config.env,reg.FIXED_TARGET.envId);assert.equal(a.data.action,'identify');assert.equal('projectId'in a.data,false);
    assert.ok(h.loaded.includes('utils/sandbox-test-coordinator.js'));assert.equal(h.store.get('unrelated'),'keep');return {loadedModules:h.loaded};});
  await sample('R5-closed-and-release-zero-send',async()=>{for(const options of [{closed:true},{version:'release'},{version:'unknown'}]){const h=pageHarness(control,options);h.page.onLoad();h.page.onShow();await h.page.runSelected();assert.equal(h.calls.length,0);}});
  await sample('R5-first-unbound-unknown-no-auto-retry',async()=>{const h=pageHarness(control,{fail:true});h.page.onLoad();await h.page.runSelected();assert.equal(h.calls.length,1);const old=JSON.stringify([...h.store]);
    h.page.onShow();h.page.onLoad();await Promise.resolve();assert.equal(h.calls.length,1);assert.equal(JSON.stringify([...h.store]),old);assert.deepEqual(h.counters(),{clears:0,removes:0});
    return {persistentDeduplicationClaimed:false,operatorMustStop:true};});
  await sample('R5-bound-unknown-blocks-resubmit',async()=>{const h=pageHarness(control,{fail:true});assert.equal(h.client.bindAccount(h.wx,reg.FIXED_TARGET.envId,plan().roundId,reg.CANDIDATE_USER_ID),true);
    h.page.onLoad();await h.page.runSelected();assert.equal(h.page.data.pendingAvailable,true);const old=JSON.stringify([...h.store]);h.page.onShow();await h.page.runSelected();assert.equal(h.calls.length,1);assert.equal(JSON.stringify([...h.store]),old);});
  const after=hashes(),unchanged=before.every((x,i)=>x===after[i]);
  const report={reviewedCommit:'f38adc04c55abe27d9ac1f1d394d7fb7f09235ee',runId:run,observedAt:new Date().toISOString(),
    evidenceKind:'REAL_APPLICATION_CODE_WITH_SYNTHETIC_SDK_STORAGE_AND_FILESYSTEM_FAULTS',rows,
    summary:{total:rows.length,passed:rows.filter(x=>x.passed).length,failed:rows.filter(x=>!x.passed).length},
    protectedFiles:{count:protectedPaths.length,unchanged,factsSha256:sha(Buffer.from(JSON.stringify(after)))},
    boundaries:{network:false,credentialFetch:false,platform:false,actualSdk:false,deploy:false,registration:false,initialization:false,historicalEvidenceOverwritten:false},
    limitations:['首次未绑定 identify 未知结果仅证明不自动重发；须停止人工核对，不证明持久防重或平台幂等。','读写仅限新建忽略夹具；源/关闭包故障为局部内存 fs 替身。']};
  process.stdout.write(JSON.stringify(report,null,2)+'\n');if(report.summary.failed||!unchanged)process.exitCode=1;
}
main().catch(e=>{process.stdout.write(JSON.stringify({harnessFailed:true,error:e.code||e.name})+'\n');process.exitCode=1;});
