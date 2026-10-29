'use strict';
// Prepared capability only. --execute-once <fixed-case> belongs to a later compile node.
// Default is read-only, exit2. No helper/PowerShell launch or automatic retry.
const cp=require('node:child_process'),rawSpawn=cp.spawn.bind(cp);
let unexpected=0,attempts=0;
const deny=()=>{unexpected++;throw Object.assign(Error('CAPABILITY_BLOCKED'),{code:'CAPABILITY_BLOCKED'});};
for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const id of ['node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
const net=require('node:net');net.Socket.prototype.connect=deny;net.connect=net.createConnection=net.createServer=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT='C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const CONFIG=path.join(__dirname,'CodexL2观察器固定编译配置v1-20261029.json');
const CONFIG_HASH='d8830ed6602e6f07a5255547fe5b21954d4edeeec0e53ac487d2e137a11ea075';
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const vm=require('node:vm');
// BEGIN RUNNER: offline test evaluates these actual bytes with an OS substitute.
async function runCompiler(c){
  need(attempts===0,'SECOND_START');attempts++;
  const r={attempted:true,pid:null,closed:false,spawnFailed:false,exitCode:null,signal:null,stdoutBytes:0,stderrBytes:0,killRequested:false,killAccepted:null,failure:null};
  const start=Date.now();let chunks={stdout:[],stderr:[]};
  return new Promise(resolve=>{
    let child,timer,reap,done=false;
    function finish(){if(done)return;done=true;clearTimeout(timer);clearTimeout(reap);r.elapsedMs=Date.now()-start;
      for(const key of ['stdout','stderr']){const b=Buffer.concat(chunks[key]);try{const s=new TextDecoder('utf-8',{fatal:true}).decode(b);need(!s.includes('\ufffd'),'OUTPUT_DECODE');r[key+'Diagnostics']=s.split(/\r?\n/).filter(Boolean).slice(0,8).map(s=>s.slice(0,1000));}catch{r.failure||='OUTPUT_DECODE';}finally{b.fill(0);for(const b of chunks[key])b.fill(0);}}
      resolve(r);
    }
    function stop(code){r.failure||=code;if(done||r.closed||r.spawnFailed)return;
      if(!r.killRequested){r.killRequested=true;try{r.killAccepted=child.kill('SIGKILL')===true;}catch{r.killAccepted=false;}if(!done)reap=setTimeout(()=>{r.failure='CLOSE_UNCONFIRMED';finish();},c.spawn.reapMs);}
    }
    try{child=rawSpawn(c.compiler.path,[...c.args],{cwd:c.cwd,shell:false,windowsHide:true,env:{...c.childEnv},stdio:['ignore','pipe','pipe']});}
    catch{r.spawnFailed=true;r.failure='START_FAILED';finish();return;}
    r.pid=Number.isSafeInteger(child.pid)&&child.pid>0?child.pid:null;
    child.on('error',()=>{if(!r.pid){r.spawnFailed=true;r.failure='START_FAILED';finish();}else stop('PROCESS_ERROR');});
    child.on('close',(code,signal)=>{r.closed=true;r.exitCode=Number.isInteger(code)?code:null;r.signal=signal||null;
      if(signal||code!==0)r.failure||='PROCESS_EXIT';if(!r.pid)r.failure||='PID_MISSING';finish();});
    function receive(key,b){if(done)return;if(!Buffer.isBuffer(b)){stop('OUTPUT_TYPE');return;}r[key+'Bytes']+=b.length;
      if(r.stdoutBytes+r.stderrBytes>c.spawn.maxCombinedOutputBytes){stop('OUTPUT_LIMIT');return;}
      chunks[key].push(Buffer.from(b));if(b.length)stop(key==='stdout'?'STDOUT_NONEMPTY':'STDERR_NONEMPTY');
    }
    if(!child.stdout||!child.stderr)stop('STREAM_MISSING');else for(const key of ['stdout','stderr']){child[key].on('data',b=>receive(key,b));child[key].on('error',()=>stop('STREAM_ERROR'));}
    if(!done)timer=setTimeout(()=>stop('TIMEOUT'),c.spawn.timeoutMs);
  });
}
// END RUNNER
// BEGIN PE: file-byte inspection only; no CLR/Assembly loading.
function inspectPe(b){
  const span=(o,n)=>need(Number.isSafeInteger(o)&&o>=0&&n>=0&&o+n<=b.length,'PE_BOUNDS');
  span(0,64);need(b.toString('ascii',0,2)==='MZ','PE_MZ');const pe=b.readUInt32LE(60);span(pe,24);need(b.readUInt32LE(pe)===0x4550,'PE_SIGNATURE');
  need(b.readUInt16LE(pe+4)===0x8664,'PE_MACHINE');const count=b.readUInt16LE(pe+6),size=b.readUInt16LE(pe+20),opt=pe+24;
  need(count>0&&count<=96&&size>=240,'PE_HEADERS');span(opt,size+count*40);need(b.readUInt16LE(opt)===0x20b,'PE_MAGIC');need(b.readUInt32LE(opt+108)>=15,'PE_DIRECTORIES');
  const sections=[];for(let i=0;i<count;i++){const o=opt+size+i*40;const s={va:b.readUInt32LE(o+12),virtualSize:b.readUInt32LE(o+8),rawSize:b.readUInt32LE(o+16),raw:b.readUInt32LE(o+20)};span(s.raw,s.rawSize);sections.push(s);}
  function at(rva,n){const matches=sections.filter(s=>rva>=s.va&&rva-s.va+n<=s.rawSize&&rva-s.va+n<=Math.max(s.virtualSize,s.rawSize));need(matches.length===1,'PE_RVA');const o=matches[0].raw+rva-matches[0].va;span(o,n);return o;}
  const dir=opt+112+14*8,clrRva=b.readUInt32LE(dir),clrSize=b.readUInt32LE(dir+4);need(clrRva>0&&clrSize>=72,'CLR_DIRECTORY');const clr=at(clrRva,clrSize);
  need(b.readUInt32LE(clr)>=72&&b.readUInt32LE(clr)<=clrSize,'CLR_SIZE');const flags=b.readUInt32LE(clr+16),entry=b.readUInt32LE(clr+20);need((flags&1)===1&&(flags&0x10)===0,'CLR_FLAGS');need((entry>>>24)===6&&(entry&0xffffff)>0,'CLR_ENTRY_TOKEN');
  const metaSize=b.readUInt32LE(clr+12);need(metaSize>=16,'CLR_METADATA');const meta=at(b.readUInt32LE(clr+8),metaSize);need(b.readUInt32LE(meta)===0x424a5342,'CLR_METADATA');
  return {machine:'AMD64',optionalHeader:'PE32+',sections:count,clrSize,clrFlags:flags,managedEntryToken:entry,metadataSignature:'BSJB',methodBodyNotExecuted:true};
}
// END PE
function chain(p,mustExist=true){p=path.resolve(p);for(;;){try{const s=fs.lstatSync(p);need(!s.isSymbolicLink(),'PATH_LINK');}catch(e){if(mustExist||e.code!=='ENOENT')throw e;}const up=path.dirname(p);if(up===p)break;p=up;}}
function sources(c){
  chain(CONFIG);need(hash(fs.readFileSync(CONFIG))===CONFIG_HASH,'CONFIG_DRIFT');
  const facts=[],buffers=[];
  for(const item of [c.host,c.compiler,c.compilerConfig,...c.references,...c.inputs]){
    chain(item.path);need(fs.lstatSync(item.path).isFile(),'SOURCE_TYPE');const b=fs.readFileSync(item.path);
    need(hash(b)===item.sha256&&(!item.bytes||b.length===item.bytes),'SOURCE_DRIFT');
    facts.push({path:item.path,bytes:b.length,sha256:hash(b)});buffers.push(b);
  }
  const inputs=buffers.slice(-4);
  function load(b){const module={exports:{}};vm.runInNewContext(b.toString('utf8'),{module,Buffer,require:id=>{need(id==='node:crypto','PREP_IMPORT');return crypto;}},{timeout:2000});return module.exports;}
  const base=load(inputs[2]).transform(inputs[0]);
  const variants=[{id:'baseline',source:base.source,sha256:base.generatedSha256},...load(inputs[3]).prepare(base.source)];
  const selected=variants.find(x=>x.id===c.id);need(selected&&selected.sha256===c.sha256,'GENERATED_DRIFT');
  return {facts,generated:[Buffer.from(selected.source),inputs[1]]};
}
function inventory(c){
  if(!fs.existsSync(c.outputRoot))return [];chain(c.outputRoot);const out=[];
  for(const name of fs.readdirSync(c.outputRoot)){
    const p=path.join(c.outputRoot,name);chain(p);const s=fs.lstatSync(p);
    need(s.isFile()||s.isDirectory(),'OUTPUT_TYPE');
    if(s.isDirectory()){need(name==='tmp','OUTPUT_EXTRA');need(fs.readdirSync(p).length===0,'TEMP_NOT_EMPTY');}
    out.push({rel:name,directory:s.isDirectory(),bytes:s.isFile()?s.size:null});
  }return out;
}
function generatedUnchanged(c,expected){
  for(let i=0;i<2;i++){chain(c.sourceFiles[i]);need(fs.lstatSync(c.sourceFiles[i]).isFile(),'OUTPUT_TYPE');need(fs.readFileSync(c.sourceFiles[i]).equals(expected[i]),'GENERATED_FILE_DRIFT');}
}
function exactFiles(c,withProduct){
  const got=inventory(c).map(x=>x.rel).sort();
  need(JSON.stringify(got)===JSON.stringify(['tmp','observer.cs','fixture.cs',...(withProduct?['observer-test.exe']:[])].sort()),'OUTPUT_SET');
}
(async()=>{
  const report={schema:'codex-observer-compile-result/1',basisCommit:'46aa59b',caseId:null,executionRequested:false,createdPaths:[],compiler:null,output:null,failure:null,assemblyCapabilityAuditPassed:false,productExecuted:false,l2Unlocked:false};
  let c,execute=false,mayRecord=false;
  try{
    const args=process.argv.slice(2);need(args.length===0||(args.length===2&&args[0]==='--execute-once'),'CLI');execute=args.length===2;
    report.executionRequested=execute;
    chain(CONFIG);const bytes=fs.readFileSync(CONFIG);need(hash(bytes)===CONFIG_HASH,'CONFIG_DRIFT');const all=JSON.parse(bytes);
    const selected=all.cases.find(x=>x.id===(execute?args[1]:'baseline'));need(selected,'CASE');c={...all,...selected};report.caseId=c.id;
    need(process.execPath===c.host.path&&process.cwd()===ROOT&&path.resolve(__dirname,'../..')===ROOT,'HOST');
    chain(path.dirname(c.record));need(!fs.existsSync(c.record),'EVIDENCE_EXISTS');mayRecord=execute;
    const before=sources(c);report.inputsBefore=before.facts;
    chain(path.join(ROOT,'.git/info/exclude'));need(fs.readFileSync(path.join(ROOT,'.git/info/exclude'),'utf8').split(/\r?\n/).includes(c.requiredRepoLocalExclude),'EXCLUDE_MISSING');
    chain(path.dirname(c.outputRoot));need(fs.lstatSync(path.dirname(c.outputRoot)).isDirectory(),'OUTPUT_PARENT');chain(c.outputRoot,false);need(!fs.existsSync(c.outputRoot),'OUTPUT_EXISTS');
    if(execute){
      need(unexpected===0,'CAPABILITY_BLOCKED');fs.mkdirSync(c.outputRoot);report.createdPaths.push(c.outputRoot);
      fs.mkdirSync(c.tempRoot);report.createdPaths.push(c.tempRoot);
      for(let i=0;i<2;i++){fs.writeFileSync(c.sourceFiles[i],before.generated[i],{flag:'wx'});report.createdPaths.push(c.sourceFiles[i]);}
      const current=sources(c);generatedUnchanged(c,current.generated);exactFiles(c,false);need(unexpected===0,'CAPABILITY_BLOCKED');
      report.compiler=await runCompiler(c);
      report.inputsAfter=sources(c).facts;exactFiles(c,true);generatedUnchanged(c,current.generated);
      need(report.compiler.closed&&!report.compiler.failure&&report.compiler.exitCode===0,'COMPILER_FAILED');
      chain(c.outputFile);const s=fs.lstatSync(c.outputFile);need(s.isFile()&&s.size>0&&s.size<=c.postcheck.maxOutputFileBytes,'OUTPUT_SIZE');
      const b=fs.readFileSync(c.outputFile);report.output={bytes:b.length,sha256:hash(b),pe:inspectPe(b)};
    }
  }catch(e){report.failure={code:e.code||'LOCAL_FAILURE'};}
  try{
    if(c){report.inventory=inventory(c);const last=sources(c);report.inputsFinal=last.facts;
      if(report.output){exactFiles(c,true);generatedUnchanged(c,last.generated);const b=fs.readFileSync(c.outputFile);need(b.length===report.output.bytes&&hash(b)===report.output.sha256,'OUTPUT_DRIFT');}
    }
    report.digests={config:hash(fs.readFileSync(CONFIG)),runner:hash(fs.readFileSync(__filename))};
  }catch(e){report.failure={code:e.code||'FINAL_CHECK_FAILED'};}
  report.guardUnexpected=unexpected;report.compilerStarts=attempts;
  report.preparationValidated=!execute&&!report.failure&&unexpected===0&&attempts===0;
  report.ok=execute&&!report.failure&&unexpected===0&&attempts===1&&!!report.output;
  report.exitCode=report.ok?0:report.preparationValidated?2:1;
  try{const text=JSON.stringify(report,null,2)+'\n';if(mayRecord)fs.writeFileSync(c.record,text,{flag:'wx'});fs.writeSync(1,text);process.exitCode=report.exitCode;}
  catch{fs.writeSync(1,'{"ok":false,"failure":"EVIDENCE_WRITE_FAILED","exitCode":1}\n');process.exitCode=1;}
})();
