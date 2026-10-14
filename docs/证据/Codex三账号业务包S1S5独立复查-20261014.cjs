'use strict';
// Independent closure assertions for afa409c; historical defect probes are unchanged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),hits=[],restore=[];
function guard(o,k){if(typeof o[k]!=='function')return;const f=o[k];o[k]=()=>{hits.push(k);throw Error('OFFLINE_REVIEW');};restore.push(()=>o[k]=f);}
for(const id of ['http','https'])for(const k of ['request','get'])guard(require('node:'+id),k);
for(const k of ['connect','createConnection'])guard(require('node:net'),k);
guard(require('node:net').Socket.prototype,'connect');guard(require('node:tls'),'connect');guard(globalThis,'fetch');
for(const k of ['lookup','resolve','resolve4','resolve6']){guard(require('node:dns'),k);guard(require('node:dns').promises,k);}
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])guard(require('node:child_process'),k);
const tool=require(path.join(ROOT,'miniapp/scripts/package-business-test.cjs'));
const pg=require(path.join(ROOT,'miniapp/cloudfunctions/scheduleSandbox/project-guard.js'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const root=path.join(ROOT,'artifacts/schedule-sandbox/business-test','codex-afa-'+crypto.randomUUID());
fs.mkdirSync(root,{recursive:true});let seq=0,sensitivityHits=0;const results=[];
const roles=['owner','manager','worker'];
const plan=(w='P')=>({schema:'business-test-plan/1',window:w,windowNo:w+'-01',synthetic:true,businessRoundId:'synthetic-afa-review',
  appId:'wxfb4db1615ac15531',envId:'cloud1-d8gcq5ag39d847723',
  users:Object.fromEntries(roles.map((r,i)=>[r,{userId:'u_'+String(i+1).repeat(40),source:'synthetic review fixture'}])),
  projectReadyMarker:'synthetic-review-marker',windowStartsAt:'2030-01-01T00:00:00Z',windowExpiresAt:'2030-01-01T01:00:00Z',
  ...(w==='P'?{}:{projectId:pg.roundProjectId('synthetic-afa-review')})});
function put(f,o){fs.writeFileSync(f,JSON.stringify(o,null,2),{flag:'wx'});return f;}
function pf(p){return put(path.join(root,'plan-'+(++seq)+'.json'),p);}
function build(p=plan()){return tool.build(p.window,pf(p),path.join(root,'out-'+(++seq)));}
function clock(fn,c=()=>Date.parse('2030-01-01T00:30:00Z')){const old=Date.now;Date.now=c;try{return fn();}finally{Date.now=old;}}
function caught(f){try{return {value:f()};}catch(error){return {error};}}
function records(p,receipt=pg.roundRecordId(p.businessRoundId)){
  p.synthetic=false;p.participantEvidence={};
  for(const role of roles){
    const rec={schema:'business-test-participant-record/1',synthetic:false,appId:p.appId,envId:p.envId,businessRoundId:p.businessRoundId,
      subject:{role,userId:p.users[role].userId},capturedAt:'2030-01-01T00:00:00Z',content:'synthetic local fixture; no platform record'};
    const f=put(path.join(root,'record-'+(++seq)+'.json'),rec);
    p.participantEvidence[role]={kind:'readback-record',recordPath:f,recordSha256:sha(fs.readFileSync(f))};
  }
  if(p.window!=='P'){
    const rec={schema:'business-test-project-readback-record/1',synthetic:false,appId:p.appId,envId:p.envId,businessRoundId:p.businessRoundId,
      subject:{role:'owner',userId:p.users.owner.userId},projectId:p.projectId,projectReadyMarker:p.projectReadyMarker,
      capturedAt:'2030-01-01T00:00:00Z',content:'synthetic local fixture only',persistentReceipt:{recordId:receipt}};
    const f=put(path.join(root,'record-'+(++seq)+'.json'),rec);
    p.projectReadback={source:'readback',recordPath:f,recordSha256:sha(fs.readFileSync(f)),projectId:p.projectId,businessRoundId:p.businessRoundId,projectReadyMarker:p.projectReadyMarker};
  }
  return p;
}
function probe(id,fn){try{results.push({id,assertionsPassed:true,actual:fn()});}catch(e){results.push({id,assertionsPassed:false,error:e.stack});}}
function snapshot(dir){const out={};function walk(base){for(const d of fs.readdirSync(base,{withFileTypes:true})){const f=path.join(base,d.name),rel=path.relative(dir,f).split(path.sep).join('/');if(d.isSymbolicLink())out[rel]='link:'+fs.readlinkSync(f);else if(d.isDirectory()){out[rel]='dir';walk(f);}else out[rel]=sha(fs.readFileSync(f));}}walk(dir);return out;}
function main(){
  probe('C01_guard',()=>{
    assert.equal(hits.length,0);
    assert.throws(()=>require('node:https').get('https://example.invalid'),/OFFLINE_REVIEW/);
    assert.throws(()=>require('node:child_process').spawn('not-executed'),/OFFLINE_REVIEW/);
    sensitivityHits=hits.length;assert.equal(sensitivityHits,2);return {sensitivityHits};
  });
  probe('C02_S1_S2_positive_E_X',()=>{
    const matrix=[];
    for(const w of ['E','X']){
      const p=records(plan(w)),f=pf(p),before=fs.readFileSync(f),out=path.join(root,'positive-'+w);
      const b=clock(()=>tool.build(w,f,out));assert.equal(clock(()=>tool.checkDir(out)).ok,true);
      assert.deepEqual(fs.readFileSync(path.join(out,'plan.json')),before);
      const snap=snapshot(out),reuse=clock(()=>tool.build(w,f,out));assert.deepEqual(snapshot(out),snap);
      assert.equal(reuse.io.filter(x=>x.action==='written').length,0);
      fs.unlinkSync(path.join(out,'server/gate.js'));
      const resumed=clock(()=>tool.build(w,f,out));assert.deepEqual(resumed.io.filter(x=>x.action==='written').map(x=>path.relative(out,x.path).split(path.sep).join('/')),['server/gate.js']);
      assert.equal(clock(()=>tool.checkDir(out)).ok,true);
      matrix.push({window:w,receipt:pg.roundRecordId(p.businessRoundId),files:b.manifest.files.length,closeFiles:b.manifest.closePackage.files.length,reuseWrites:0,resumeWrites:1,planBytesPreserved:true});
    }return matrix;
  });
  probe('C03_S1_wrong_receipts_zero_write',()=>{
    const matrix=[];
    for(const receipt of [pg.roundRecordId('other-round'),'unrelated_receipt_123456',null]){
      const p=records(plan('E'),receipt);
      if(receipt===null){const f=p.projectReadback.recordPath,r=JSON.parse(fs.readFileSync(f));delete r.persistentReceipt;fs.writeFileSync(f,JSON.stringify(r));p.projectReadback.recordSha256=sha(fs.readFileSync(f));}
      const out=path.join(root,'bad-receipt-'+(++seq)),r=caught(()=>clock(()=>tool.build('E',pf(p),out)));
      assert.equal(r.error.code,'BTP_PLAN_PROJECT_INVALID');assert.equal(fs.existsSync(out),false);matrix.push({receipt,code:r.error.code,outputCreated:false});
    }return matrix;
  });
  probe('C04_S2_relative_paths_zero_write',()=>{
    const matrix=[];
    for(const target of ['participant','project']){
      const p=records(plan('E')),ev=target==='participant'?p.participantEvidence.manager:p.projectReadback;
      ev.recordPath=path.basename(ev.recordPath);
      const out=path.join(root,'relative-'+target),r=caught(()=>clock(()=>tool.build('E',pf(p),out)));
      assert.ok(r.error);assert.match(r.error.message,/绝对路径/);assert.equal(fs.existsSync(out),false);
      matrix.push({target,code:r.error.code,outputCreated:false});
    }return matrix;
  });
  probe('C05_S3_fixed_plan_before_read',()=>{
    const b=build(),manifestPath=path.join(b.outDir,'manifest.json'),original=b.manifest,old=fs.readFileSync,matrix=[];
    for(const name of ['replacement.json','./plan.json','..\\escape.json']){
      const m=JSON.parse(JSON.stringify(original));m.planFile=name;m.files.find(x=>x.rel==='plan.json').rel=name;fs.writeFileSync(manifestPath,JSON.stringify(m));
      let planReads=0;fs.readFileSync=function(f,...args){if(path.resolve(String(f))!==manifestPath)planReads++;return old.call(this,f,...args);};
      let r;try{r=caught(()=>tool.checkDir(b.outDir));}finally{fs.readFileSync=old;}
      assert.equal(r.error.code,'BTP_MANIFEST_INVALID');assert.equal(planReads,0);matrix.push({name,code:r.error.code,nonManifestReads:planReads});
    }
    // Observe omitted-field semantics without asserting an unimplemented strict-schema claim.
    const missing=JSON.parse(JSON.stringify(original));delete missing.planFile;fs.writeFileSync(manifestPath,JSON.stringify(missing));
    const omittedOk=tool.checkDir(b.outDir).ok;assert.equal(omittedOk,true);
    fs.writeFileSync(manifestPath,JSON.stringify(original));assert.equal(tool.checkDir(b.outDir).ok,true);
    return {matrix,omittedFieldUsesFixedPlanJson:omittedOk,normalOk:true};
  });
  probe('C06_S4_close_junction_zero_follow',()=>{
    const b=build();assert.equal(clock(()=>tool.checkCloseDir(b.outDir),()=>NaN).ok,true);
    const outside=path.join(ROOT,'artifacts/schedule-sandbox','registration-codex-afa-'+crypto.randomUUID());fs.mkdirSync(outside);
    const external=path.join(outside,'close');fs.renameSync(path.join(b.outDir,'close'),external);const before=snapshot(external);
    fs.symlinkSync(external,path.join(b.outDir,'close'),'junction');
    let reads=0;const old=fs.readFileSync;fs.readFileSync=function(...args){reads++;return old.apply(this,args);};
    let r;try{r=tool.checkCloseDir(b.outDir);}finally{fs.readFileSync=old;}
    assert.equal(r.ok,false);assert.equal(reads,0);assert.deepEqual(snapshot(external),before);
    return {normalNaNClockOk:true,junctionOk:r.ok,fileReads:reads,targetUnchanged:true};
  });
  probe('C07_S5_partial_and_race_actual_facts',()=>{
    const matrix=[];
    for(const mode of ['partial','race']){
      const f=pf(plan()),out=path.join(root,mode),old=fs.writeFileSync,target=path.join(out,'server/gate.js');
      fs.writeFileSync=function(p,buf,o){if(p===target){old.call(this,p,mode==='partial'?Buffer.from(buf).subarray(0,11):Buffer.from('other-writer'),o);const e=Error('synthetic '+mode);e.code=mode==='partial'?'EIO':'EEXIST';throw e;}return old.call(this,p,buf,o);};
      let r;try{r=caught(()=>tool.build('P',f,out));}finally{fs.writeFileSync=old;}
      const e=r.error,size=fs.statSync(target).size;assert.ok(e);
      if(mode==='partial'){assert.deepEqual(e.written,['server/index.js','server/gate.js']);assert.equal(e.wroteFiles,2);assert.deepEqual(e.partialWrites,[{rel:'server/gate.js',bytesOnDisk:size}]);assert.equal(size,11);}
      else{assert.deepEqual(e.written,['server/index.js']);assert.equal(e.wroteFiles,1);assert.equal(e.partialWrites,undefined);assert.match(e.sideEffect,/EEXIST/);assert.equal(fs.readFileSync(target,'utf8'),'other-writer');}
      matrix.push({mode,code:e.code,written:e.written,wroteFiles:e.wroteFiles,partialWrites:e.partialWrites||null,sideEffect:e.sideEffect||null,actualTargetBytes:size});
    }return matrix;
  });
  probe('C08_clock_and_closed_controls',()=>{
    const b=clock(()=>build(records(plan()))),old=fs.readFileSync,matrix=[];
    for(const mode of ['expired','nan','throw']){
      let advanced=false,count=0;fs.readFileSync=function(p,...args){const r=old.call(this,p,...args);if(p===path.join(b.outDir,'server/index.js'))advanced=true;return r;};
      let r;try{r=clock(()=>tool.checkDir(b.outDir),()=>{count++;if(!advanced)return Date.parse('2030-01-01T00:30:00Z');if(mode==='throw')throw Error('english clock error');return mode==='nan'?NaN:Date.parse('2030-01-01T01:00:00Z');});}finally{fs.readFileSync=old;}
      assert.equal(r.ok,false);assert.ok(count>1);matrix.push({mode,ok:r.ok,count});
    }
    fs.writeFileSync(path.join(b.outDir,'manifest.json'),'broken candidate manifest');assert.equal(clock(()=>tool.checkCloseDir(b.outDir),()=>NaN).ok,true);
    const out=path.join(root,'dir-conflict');fs.mkdirSync(path.join(out,'manifest.json'),{recursive:true});const before=snapshot(out);
    assert.equal(caught(()=>tool.build('P',pf(plan()),out)).error.code,'BTP_OUT_CONFLICT');assert.deepEqual(snapshot(out),before);
    return {matrix,closeIndependentOfBrokenManifestAndNaN:true,preflightConflictUnchanged:true};
  });
  const unexpected=hits.length-sensitivityHits,passed=results.filter(x=>x.assertionsPassed).length;
  const report={reviewedCommit:'afa409c',reviewBasis:'5ed9f60',implementationSha256:sha(fs.readFileSync(path.join(ROOT,'miniapp/scripts/package-business-test.cjs'))),
    generatedAt:new Date().toISOString(),artifactDirectory:path.relative(ROOT,root).split(path.sep).join('/'),
    verificationKind:'offline synthetic files/time only; no SDK/platform/real identity',results,
    summary:{total:results.length,assertionsPassed:passed,sensitivityHits,unexpectedAttempts:unexpected,localClosureChecksPassed:passed===results.length&&unexpected===0}};
  const output=JSON.stringify(report,null,2)+'\n',args=process.argv.slice(2);
  if(args.length){assert.equal(args.length,2);assert.equal(args[0],'--out');fs.writeFileSync(path.resolve(args[1]),output,{flag:'wx'});}
  process.stdout.write(output);if(passed!==results.length||unexpected!==0)process.exitCode=1;
}
try{main();}finally{restore.reverse().forEach(f=>f());}
