'use strict';
// 独立复核fea22e0：只用合成账号、内存私密文件/ACL/DPAPI接缝。
// 产品buildReal/prepareReal实际执行；磁盘仅新增忽略目录中的合成计划/关闭来源/候选。
// ok=本轮合成验收完成，不代表真实平台通过。默认stdout，--out排他新建。
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..');
const shared=require(path.join(ROOT,'miniapp/tests/helpers/pic-guard-runner.cjs'));
const hits=[];let phase='business',checks=0;
shared.installParentGuards({hits,getPhase:()=>phase,allowedScripts:[]});
phase='probe';
for(const f of [()=>require('node:https').request('https://example.invalid'),()=>require('node:child_process').spawn('synthetic-never',[])])try{f();}catch(_){}
phase='business';
const fixture=require(path.join(ROOT,'miniapp/tests/helpers/psr-repair-fixtures.cjs'));
const business=require(path.join(ROOT,'miniapp/scripts/package-business-test.cjs'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const eq=(a,b,msg)=>{checks++;assert.deepEqual(a,b,msg);};
const base=path.join(ROOT,'artifacts/schedule-sandbox/business-test');
const tag='codex-source-'+crypto.randomBytes(6).toString('hex');
const created=[];
function put(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx'});created.push(file);}
async function main(){
  const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--out'))throw Error('仅支持--out新路径');
  fs.mkdirSync(base,{recursive:true});
  const closePlan=path.join(base,tag+'-close-plan.json'),closeDir=path.join(base,tag+'-close');
  put(closePlan,{schema:'business-test-plan/1',window:'P',synthetic:true,businessRoundId:tag,
    windowNo:'P-01',appId:'wxfb4db1615ac15531',envId:'cloud1-d8gcq5ag39d847723',
    users:Object.fromEntries(['owner','manager','worker'].map(k=>[k,{userId:'u_'+sha('synthetic-'+k).slice(0,40),source:'synthetic'}])),
    projectReadyMarker:'ready-'+tag,windowStartsAt:'2030-01-01T00:00:00Z',windowExpiresAt:'2030-01-01T01:00:00Z'});
  business.build('P',closePlan,closeDir);created.push(closeDir);
  eq(business.checkCloseDir(closeDir).ok,true,'合成关闭来源独立校验');
  const rows=[];
  for(const mode of ['control','cipherChangesDuringDecrypt','planChangesDuringDecrypt','cipherChangesAfterWrite','planChangesAfterWrite'])for(const entry of ['buildReal','prepareReal']){
    const h=fixture.createPrivateHarness();
    const accountA='u_'+sha('synthetic-account-A').slice(0,40),accountB='u_'+sha('synthetic-account-B').slice(0,40);
    const one=h.save('1',accountA),two=h.save('2',accountB);
    const round=tag+'-'+rows.length,planFile=path.join(base,round+'-plan.json');
    const now=Date.now(),plan={schema:h.packer.PLAN_SCHEMA,synthetic:false,registrationRoundId:round,
      participantCode:'1',appId:'wxfb4db1615ac15531',envId:'cloud1-d8gcq5ag39d847723',functionName:'scheduleSandbox',
      usersCollection:'schtest_v1_users',auditCollection:'schtest_v1_audit_events',passphraseDigest:sha('synthetic-passphrase'),
      windowStartsAtIso:new Date(now-60000).toISOString(),windowExpiresAtIso:new Date(now+29*60000).toISOString(),
      closeSourceDir:closeDir,requestProtocol:h.packer.REQUEST_PROTOCOL,
      privateSource:{schema:h.packer.PRIVATE_SOURCE_SCHEMA,recordFile:one.name,records:[one.ref,two.ref]}};
    put(planFile,plan);
    const originalCipher=Buffer.from(h.mem.get(path.join(h.prefix,one.name)));
    let injected=false;
    const originalUnprotect=h.tools.unprotect;
    h.tools.unprotect=async hex=>{
      const plain=await originalUnprotect(hex);
      if(!injected){injected=true;
        if(mode==='cipherChangesDuringDecrypt'){
          const replacement={...one.payload,fullAccount:'u_'+sha('synthetic-replacement-C').slice(0,40)};
          h.mem.set(path.join(h.prefix,one.name),Buffer.from(Buffer.from(JSON.stringify(replacement)).toString('hex')));
        }
        if(mode==='planChangesDuringDecrypt')fs.writeFileSync(planFile,JSON.stringify({...plan,registrationRoundId:round+'-changed'}));
      }
      return plain;
    };
    const out=path.join(base,'participant-self-registration-'+round);
    if(mode.endsWith('AfterWrite')){
      const intercepted=new Proxy(h.fakeFs,{get(target,k){
        if(k!=='writeFileSync')return target[k];
        return (p,b,o)=>{target.writeFileSync(p,b,o);
          if(path.resolve(p)===path.join(out,'server/scheduleSandbox/index.js')){
            if(mode==='planChangesAfterWrite')fs.writeFileSync(planFile,JSON.stringify({...plan,registrationRoundId:round+'-changed'}));
            else h.mem.set(path.join(h.prefix,one.name),Buffer.from('synthetic-changed-cipher'));
          }
        };
      }});
      h.packer=fixture.load(fixture.PACKER,{'node:fs':intercepted,'./lib/participant-private-store.cjs':h.store});
    }
    if(mode!=='control'){
      let error;try{await h.packer[entry](planFile,out);}catch(e){error=e;}
      eq(!!error,true,'变化必须拒绝');
      const expected=mode.startsWith('cipher')?'PSR_SOURCE_SNAPSHOT_CHANGED':'PSR_PLAN_SNAPSHOT_CHANGED';
      eq(error.code,expected);
      const after=mode.endsWith('AfterWrite');
      eq(fs.existsSync(out),after);
      if(after){eq(error.wroteFiles>0,true);eq(error.written.length,error.wroteFiles);created.push(out);}
      else eq(error.wroteFiles===undefined,true);
      rows.push({mode,entry,rejected:true,code:error.code,outputExists:fs.existsSync(out),wroteFiles:error.wroteFiles||0,written:error.written||[]});
      continue;
    }
    const built=await h.packer[entry](planFile,out);created.push(out);
    const copiedPlan=JSON.parse(fs.readFileSync(path.join(out,'plan.json')));
    const server=fs.readFileSync(path.join(out,'server/scheduleSandbox/index.js'),'utf8');
    const recordedHash=built.manifest.privateSource.recordFileSha256;
    const currentCipher=h.mem.get(path.join(h.prefix,one.name));
    const result={mode,entry,buildReturned:true,
      serverUsesOriginallyDecryptedAccount:server.includes(accountA),
      manifestHashMatchesDecryptedBytes:recordedHash===sha(originalCipher),
      manifestHashMatchesLaterBytes:recordedHash===sha(currentCipher),
      copiedPlanRoundMatchesManifest:copiedPlan.registrationRoundId===built.manifest.registrationRoundId};
    eq(result.serverUsesOriginallyDecryptedAccount,true,'受审入口实际写入原解密账号');
    eq(result.manifestHashMatchesLaterBytes,true,'清单使用后读文件摘要');
    eq(result.manifestHashMatchesDecryptedBytes,mode!=='cipherChangesDuringDecrypt');
    eq(result.copiedPlanRoundMatchesManifest,mode!=='planChangesDuringDecrypt');
    const checked=await h.packer[entry==='buildReal'?'checkDirResolved':'checkPreparedDirResolved'](out);
    result.laterCheckerAccepts=checked.ok;
    eq(checked.ok,mode==='control','后续独立检查能发现，不能替代装配入口失败闭合');
    if(entry==='prepareReal')eq(built.executionReady,false);
    rows.push(result);
  }
  const verdict=shared.verdictFor({probes:hits.filter(x=>x.phase==='probe').length,
    parentUnexpected:hits.filter(x=>x.phase!=='probe').length,childUnexpectedTotal:0,receiptFailures:0});
  const sources=['miniapp/scripts/package-participant-self-registration.cjs','miniapp/scripts/lib/participant-private-store.cjs',
    'miniapp/scripts/lib/participant-self-registration.cjs','miniapp/scripts/participant-private-input.ps1',
    'miniapp/tests/helpers/psr-repair-fixtures.cjs'];
  const evidence={schema:'codex-psr-source-review/2',reviewedCommit:'fea22e0',...verdict,
    interpretation:'ok表示合成正常/等待期间变更拒绝/写后变更拒绝与写入事实对照完成；不构成真实执行批准。',checks,rows,
    guard:{probes:hits.filter(x=>x.phase==='probe').length,unexpected:hits.filter(x=>x.phase!=='probe').length},
    sourceFacts:sources.map(rel=>({rel,sha256:sha(fs.readFileSync(path.join(ROOT,rel)))})),
    syntheticArtifacts:created.map(p=>path.relative(ROOT,p).replaceAll(path.sep,'/')),
    boundaries:{realPrivateRead:false,dpapiInvoked:false,aclMutated:false,processesSpawned:0,cloudCalls:0,productEdited:false},
    limitations:['内存FS/ACL/DPAPI均为合成；使用实际异步存储/打包器源码。','真实PS1执行策略被拒项未重试。','真实环境未执行；变化只注入本轮合成文件和内存密文。']};
  const text=JSON.stringify(evidence,null,2)+'\n';
  if(args.length)fs.writeFileSync(path.resolve(args[1]),text,{flag:'wx'});
  process.stdout.write(text);process.exitCode=evidence.ok?0:1;
}
main().catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.message,checks})+'\n');process.exitCode=1;});
