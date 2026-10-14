'use strict';
// 816ab89 independent local review. Defect assertions are not acceptance.
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
const root=path.join(ROOT,'artifacts/schedule-sandbox/business-test','codex-816-'+crypto.randomUUID());
fs.mkdirSync(root,{recursive:true});let seq=0;const results=[];
const roles=['owner','manager','worker'];
const plan=(w='P')=>({schema:'business-test-plan/1',window:w,windowNo:w+'-01',synthetic:true,businessRoundId:'synthetic-816-review',
  appId:'wxfb4db1615ac15531',envId:'cloud1-d8gcq5ag39d847723',
  users:Object.fromEntries(roles.map((r,i)=>[r,{userId:'u_'+String(i+1).repeat(40),source:'synthetic review fixture'}])),
  projectReadyMarker:'synthetic-review-marker',windowStartsAt:'2030-01-01T00:00:00Z',windowExpiresAt:'2030-01-01T01:00:00Z',
  ...(w==='P'?{}:{projectId:pg.roundProjectId('synthetic-816-review')})});
function put(f,o){fs.writeFileSync(f,JSON.stringify(o,null,2),{flag:'wx'});return f;}
function pf(p){return put(path.join(root,'plan-'+(++seq)+'.json'),p);}
function build(p=plan()){return tool.build(p.window,pf(p),path.join(root,'out-'+(++seq)));}
function clock(fn,c=()=>Date.parse('2030-01-01T00:30:00Z')){const old=Date.now;Date.now=c;try{return fn();}finally{Date.now=old;}}
function caught(f){try{return {value:f()};}catch(error){return {error};}}
function records(p,receipt='unrelated_receipt_123456'){
  p.synthetic=false;p.participantEvidence={};
  for(const role of roles){
    const rec={schema:'business-test-participant-record/1',synthetic:false,appId:p.appId,envId:p.envId,businessRoundId:p.businessRoundId,
      subject:{role,userId:p.users[role].userId},capturedAt:'2030-01-01T00:00:00Z',content:'synthetic fixture exercising the false flag; no platform record'};
    const f=put(path.join(root,'record-'+(++seq)+'.json'),rec);
    p.participantEvidence[role]={kind:'readback-record',recordPath:f,recordSha256:sha(fs.readFileSync(f))};
  }
  if(p.window!=='P'){
    const rec={schema:'business-test-project-readback-record/1',synthetic:false,appId:p.appId,envId:p.envId,businessRoundId:p.businessRoundId,
      subject:{role:'owner',userId:p.users.owner.userId},projectId:p.projectId,projectReadyMarker:p.projectReadyMarker,
      capturedAt:'2030-01-01T00:00:00Z',content:'synthetic fixture only',persistentReceipt:{recordId:receipt}};
    const f=put(path.join(root,'record-'+(++seq)+'.json'),rec);
    p.projectReadback={source:'readback',recordPath:f,recordSha256:sha(fs.readFileSync(f)),projectId:p.projectId,businessRoundId:p.businessRoundId,projectReadyMarker:p.projectReadyMarker};
  }
  return p;
}
function probe(id,kind,fn){try{results.push({id,kind,assertionsPassed:true,actual:fn()});}catch(e){results.push({id,kind,assertionsPassed:false,error:e.message});}}
function main(){
  probe('D01','closed-controls',()=>{
    assert.throws(()=>require('node:https').get('https://example.invalid'),/OFFLINE_REVIEW/);
    assert.throws(()=>require('node:child_process').spawn('not-executed'),/OFFLINE_REVIEW/);
    const p=plan(),f=pf(p),out=path.join(root,'normal'),b=tool.build('P',f,out);
    assert.equal(tool.checkDir(out).ok,true);assert.equal(tool.checkCloseDir(out).ok,true);
    assert.equal(tool.build('P',f,out).io.filter(x=>x.action==='written').length,0);
    fs.unlinkSync(path.join(out,'server/gate.js'));
    const resumed=tool.build('P',f,out);assert.equal(resumed.io.filter(x=>x.action==='written').length,1);
    const m=b.manifest;m.files.find(x=>x.rel==='plan.json').bytes=-1;
    fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(m));
    assert.equal(tool.checkDir(out).ok,false);
    return {normalAndCloseOk:true,fullReuse:true,resumeWritten:1,wrongPlanBytesRejected:true};
  });
  probe('D02','R1-fixed-path-gap',()=>{
    const b=build(),m=b.manifest;
    fs.renameSync(path.join(b.outDir,'plan.json'),path.join(b.outDir,'replacement.json'));
    m.planFile='replacement.json';m.files.find(x=>x.rel==='plan.json').rel='replacement.json';
    fs.writeFileSync(path.join(b.outDir,'manifest.json'),JSON.stringify(m));
    const r=tool.checkDir(b.outDir);assert.equal(r.ok,true);
    return {planJsonExists:false,renamedPlanAccepted:r.ok,planChecked:r.planChecked};
  });
  probe('D03','R3-close-root-junction-gap',()=>{
    const b=build(),outside=path.join(ROOT,'artifacts/schedule-sandbox','registration-codex-816-'+crypto.randomUUID());
    fs.mkdirSync(outside);const externalClose=path.join(outside,'close');
    fs.renameSync(path.join(b.outDir,'close'),externalClose);
    fs.symlinkSync(externalClose,path.join(b.outDir,'close'),'junction');
    const r=tool.checkCloseDir(b.outDir);assert.equal(r.ok,true);
    assert.equal(tool.checkDir(b.outDir).ok,false);
    return {closeRootIsJunction:true,checkCloseAccepted:r.ok,fullCheckRejected:true};
  });
  probe('D04','R5-real-contract-gap',()=>{
    const expected=pg.roundRecordId('synthetic-816-review');
    const legitimate=records(plan('E'),expected),bad=records(plan('E'),'unrelated_receipt_123456');
    const goodResult=caught(()=>tool.readPlan(pf(legitimate),'E'));
    assert.equal(goodResult.error.code,'BTP_PLAN_PROJECT_INVALID');
    const b=clock(()=>build(bad));assert.equal(clock(()=>tool.checkDir(b.outDir)).ok,true);
    return {actualContractReceipt:expected,actualContractRejected:goodResult.error.code,unrelatedReceiptAccepted:true};
  });
  probe('D05','R5-relative-record-path-gap',()=>{
    const p=records(plan());
    for(const ev of Object.values(p.participantEvidence))ev.recordPath=path.basename(ev.recordPath);
    const b=clock(()=>build(p)),r=clock(()=>tool.checkDir(b.outDir));
    assert.equal(r.ok,false);assert.ok(r.problems.some(x=>x.includes('来源记录文件不存在')));
    return {buildSucceeded:true,ownCheckOk:r.ok,problems:r.problems};
  });
  probe('D06','partial-report-projection-gap',()=>{
    const f=pf(plan()),out=path.join(root,'partial'),old=fs.writeFileSync;
    fs.writeFileSync=function(p,buf,o){if(p===path.join(out,'server/index.js')){old.call(this,p,Buffer.from(buf).subarray(0,7),o);const e=Error('synthetic EIO');e.code='EIO';throw e;}return old.call(this,p,buf,o);};
    let r;try{r=caught(()=>tool.build('P',f,out));}finally{fs.writeFileSync=old;}
    assert.equal(r.error.wroteFiles,1);assert.deepEqual(r.error.written,['server/index.js']);
    assert.equal(JSON.stringify(r.error).includes('bytesOnDisk'),false);
    return {wroteFiles:r.error.wroteFiles,written:r.error.written,bytesOnDisk:7,exportedErrorKeys:Object.keys(r.error),partialMetadataExported:false};
  });
  probe('D07','closed-clock-controls',()=>{
    const b=clock(()=>build(records(plan()))),old=fs.readFileSync,matrix=[];
    for(const mode of ['expired','nan','throw']){
      let advanced=false,count=0;
      fs.readFileSync=function(p,...args){const r=old.call(this,p,...args);if(p===path.join(b.outDir,'server/index.js'))advanced=true;return r;};
      let r;try{r=clock(()=>tool.checkDir(b.outDir),()=>{count++;if(!advanced)return Date.parse('2030-01-01T00:30:00Z');if(mode==='throw')throw Error('english clock error');return mode==='nan'?NaN:Date.parse('2030-01-01T01:00:00Z');});}
      finally{fs.readFileSync=old;}
      assert.equal(r.ok,false);assert.ok(count>1);matrix.push({mode,ok:r.ok,count});
    }
    assert.equal(clock(()=>tool.checkCloseDir(b.outDir),()=>NaN).ok,true);
    return {matrix,closeClockIndependent:true};
  });
  probe('D08','closed-directory-controls',()=>{
    const out=path.join(root,'dir-conflict');fs.mkdirSync(path.join(out,'manifest.json'),{recursive:true});
    const r=caught(()=>tool.build('P',pf(plan()),out));assert.equal(r.error.code,'BTP_OUT_CONFLICT');assert.deepEqual(fs.readdirSync(out),['manifest.json']);
    const target=path.join(root,'empty-target'),link=path.join(root,'root-link');fs.mkdirSync(target);fs.symlinkSync(target,link,'junction');
    for(const f of [()=>tool.build('P',pf(plan()),link),()=>tool.checkDir(link),()=>tool.checkCloseDir(link)])assert.throws(f,e=>e.code==='BTP_OUT_CONFLICT');
    assert.deepEqual(fs.readdirSync(target),[]);
    return {directoryConflictZeroWrite:true,candidateRootJunctionAllThreeRejected:true};
  });
  const report={reviewedCommit:'816ab89',reviewBasis:'be993ce',implementationSha256:sha(fs.readFileSync(path.join(ROOT,'miniapp/scripts/package-business-test.cjs'))),
    generatedAt:new Date().toISOString(),artifactDirectory:path.relative(ROOT,root).split(path.sep).join('/'),
    verificationKind:'offline synthetic files/time only; no SDK/platform/real identity',results,
    summary:{total:results.length,assertionsPassed:results.filter(x=>x.assertionsPassed).length,sensitivityHits:2,unexpectedAttempts:hits.length-2,accepted:false}};
  const output=JSON.stringify(report,null,2)+'\n',args=process.argv.slice(2);
  if(args.length){assert.equal(args.length,2);assert.equal(args[0],'--out');fs.writeFileSync(path.resolve(args[1]),output,{flag:'wx'});}
  process.stdout.write(output);if(results.some(x=>!x.assertionsPassed)||hits.length!==2)process.exitCode=1;
}
try{main();}finally{restore.reverse().forEach(f=>f());}
