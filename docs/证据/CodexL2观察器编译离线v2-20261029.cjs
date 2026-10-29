'use strict';
// No csc/PowerShell/helper launch. Actual runner/PE function bytes, synthetic OS/PE only.
let hits=0;const deny=()=>{hits++;throw Error('OFFLINE_OS_BLOCKED');};
for(const id of ['node:child_process','node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
const net=require('node:net');net.Socket.prototype.connect=deny;net.connect=net.createConnection=net.createServer=deny;globalThis.fetch=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
const fs=require('fs'),vm=require('vm'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),{EventEmitter}=require('events');
const file=path.join(__dirname,'CodexL2观察器单次编译v2-20261029.cjs'),out=path.join(__dirname,'CodexL2观察器编译离线v2-20261029.json');
const source=fs.readFileSync(file,'utf8'),c=JSON.parse(fs.readFileSync(path.join(__dirname,'CodexL2观察器固定编译配置v2-20261029.json')));
Object.assign(c,c.cases[0]); c.sources=c.inputs;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function section(a,b){const start=source.indexOf(a),end=source.indexOf(b);assert(start>=0&&end>start);return source.slice(start+a.length,end);}
const need=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
const body=section('// BEGIN RUNNER: offline test evaluates these actual bytes with an OS substitute.','// END RUNNER');
const peBody=section('// BEGIN PE: file-byte inspection only; no CLR/Assembly loading.','// END PE');
const results=[];
const ROOT=path.resolve(__dirname,'../..'),CONFIG=path.join(__dirname,'CodexL2观察器固定编译配置v2-20261029.json');
const EVIDENCE=c.record,LEGACY=path.join(ROOT,'artifacts/psr-l2/v1/psr-l2-helper.exe');
// Real input bytes are only read. All driver mutations and OS events use a separate memory FS.
const cache=new Map([file,CONFIG,path.join(ROOT,'AGENTS.md'),path.join(ROOT,'.git/info/exclude'),...[c.host,c.compiler,c.compilerConfig,...c.references,...c.sources].map(x=>x.path)].map(p=>[p,fs.readFileSync(p)]));
async function full(mode,id="baseline"){
  const c={...JSON.parse(cache.get(CONFIG)),...JSON.parse(cache.get(CONFIG)).cases.find(x=>x.id===id)};c.sources=c.inputs;const EVIDENCE=c.record;
  const files=new Map(cache),dirs=new Set(),links=new Set(),calls=[],mutations=[];
  for(const f of files.keys()){let d=path.dirname(f);while(!dirs.has(d)){dirs.add(d);const u=path.dirname(d);if(u===d)break;d=u;}}
  for(let d=path.dirname(c.outputRoot);!dirs.has(d);d=path.dirname(d))dirs.add(d);
  let text='',written=null,spawned=false,closed=false,injected=false,ctx,productReads=0;
  function err(code){throw Object.assign(Error(code),{code});}
  function hit(kind='network'){try{if(kind==='socket')new (mods.get('node:net').Socket)().connect();else if(kind==='dns')mods.get('node:dns').promises.lookup();else if(kind==='fetch')ctx.fetch();else if(kind==='process')mods.get('node:child_process').execSync('denied');else mods.get('node:https').request('denied');}catch{}}
  function bytes(p){if(!files.has(p))err('ENOENT');const b=files.get(p);if(mode==='generatedDrift'&&p===c.sourceFiles[0])return Buffer.from('drift');
    if(p===c.outputFile){productReads++;if(mode==='finalProductDrift'&&productReads>1){const changed=Buffer.from(b);changed[changed.length-1]^=1;return changed;}}
    if(mode==='configDrift'&&p===CONFIG)return Buffer.concat([b,Buffer.from(' ')]);
    if(mode==='coreReferenceDrift'&&p===c.references[2].path)return Buffer.from('synthetic');
    if(mode==='nodeDrift'&&p===c.host.path)return Buffer.from('synthetic');
    if(mode==='secondSourceDrift'&&p===c.sources[1].path)return Buffer.from('synthetic');
    if(mode==='sourceAfterStart'&&spawned&&p===c.sources[1].path)return Buffer.from('synthetic');
    if(mode==='configAfterStart'&&spawned&&p===CONFIG)return Buffer.concat([b,Buffer.from(' ')]);
    if(mode==='sourceBeforeStart'&&dirs.has(c.outputRoot)&&p===c.sources[1].path)return Buffer.from('synthetic');
    if(mode==='legacyAfterStart'&&spawned&&p===LEGACY)return Buffer.from('synthetic');
    if(mode==='excludeMissing'&&p===path.join(ROOT,'.git/info/exclude'))return Buffer.from('');
    if(mode==='agentsDrift'&&p===path.join(ROOT,'AGENTS.md'))return Buffer.from('synthetic');
    return b;
  }
  if(mode==='outputExists')dirs.add(c.outputRoot);
  if(mode==='evidenceExists')files.set(EVIDENCE,Buffer.from('planted'));
  if(mode==='sourceLink')links.add(c.sources[1].path);
  if(mode==='outputLink'){dirs.add(c.outputRoot);links.add(c.outputRoot);}
  if(mode==='parentMissing')dirs.delete(path.dirname(c.outputRoot));
  const fsm={
    lstatSync(p){p=path.resolve(p);if(!dirs.has(p)&&!files.has(p))err('ENOENT');return {isSymbolicLink:()=>links.has(p),isFile:()=>files.has(p),isDirectory:()=>dirs.has(p),size:files.get(p)?.length||0};},
    existsSync:p=>files.has(path.resolve(p))||dirs.has(path.resolve(p)),
    readFileSync(p,enc){p=path.resolve(p);if(!injected&&((mode==='earlyNetwork'&&p===CONFIG)||(mode==='lateReadHit'&&p===file)||(mode==='postCompileHit'&&closed&&p===CONFIG)||(['socketHit','dnsHit','fetchHit','processHit'].includes(mode)&&p===CONFIG))){injected=true;hit(mode.replace('Hit',''));}
      const b=bytes(p);return enc?b.toString(enc):Buffer.from(b);},
    mkdirSync(p){p=path.resolve(p);if(mode==='mkdirRace'&&p===c.outputRoot){dirs.add(p);err('EEXIST');}if(files.has(p)||dirs.has(p))err('EEXIST');if(!dirs.has(path.dirname(p)))err('ENOENT');if(mode==='tmpFailure'&&p===c.tempRoot)err('EACCES');dirs.add(p);mutations.push({kind:'mkdir',p});},
    readdirSync(p,opts){p=path.resolve(p);if(!dirs.has(p))err('ENOENT');if(mode==='beforeStartExtra'&&!spawned&&p===c.outputRoot)files.set(path.join(p,'planted'),Buffer.from('x'));
      const names=[...files.keys(),...dirs].filter(q=>path.dirname(q)===p&&q!==p).map(q=>path.basename(q));return opts?.withFileTypes?names.map(name=>({name,isDirectory:()=>dirs.has(path.join(p,name)),isFile:()=>files.has(path.join(p,name))})):names;},
    writeFileSync(p,b,opts){p=path.resolve(p);assert([EVIDENCE,...c.sourceFiles].includes(p));assert.equal(opts.flag,'wx');if(p!==EVIDENCE){if(files.has(p))err('EEXIST');files.set(p,Buffer.from(b));mutations.push({kind:'source',p});return;}if(mode==='evidenceRace'){files.set(p,Buffer.from('planted'));err('EEXIST');}if(files.has(p))err('EEXIST');files.set(p,Buffer.from(b));written=JSON.parse(b);mutations.push({kind:'evidence',p});},
    writeSync(fd,b){assert.equal(fd,1);text+=b;}
  };
  function spawn(exe,args,opts){calls.push({exe,args,opts});spawned=true;if(mode==='startThrow')err('SYNTHETIC_START');
    const ch=new EventEmitter();ch.pid=808;ch.stdout=new EventEmitter();ch.stderr=new EventEmitter();
    ch.kill=()=>{if(mode!=='noClose')queueMicrotask(()=>{closed=true;ch.emit('close',null,'SIGKILL');});return mode!=='killFalse';};
    queueMicrotask(()=>{
      if(['timeout','noClose','killFalse'].includes(mode))return;
      if(mode==='compilerError'){closed=true;ch.emit('close',1,null);return;}
      if(mode==='stderr'){ch.stderr.emit('data',Buffer.from('synthetic compile error'));return;}
      if(mode==='outputOverflow'){ch.stdout.emit('data',Buffer.alloc(131073));return;}
      if(mode==='streamError'){ch.stdout.emit('error',Error('synthetic'));return;}
      if(mode!=='noProduct'){let b=pe();if(mode==='badPe')b=Buffer.from('bad');if(mode==='largeProduct')b=Buffer.alloc(1048577);files.set(c.outputFile,b);}
      if(mode==='extraProduct')files.set(path.join(c.outputRoot,'extra.pdb'),Buffer.from('x'));
      if(mode==='nonemptyTmp')files.set(path.join(c.tempRoot,'left'),Buffer.from('x'));
      if(mode==='productLink')links.add(c.outputFile);
      closed=true;ch.emit('close',0,null);
    });return ch;
  }
  const mods=new Map();function req(id){if(id==='node:vm')return vm;if(id==='node:fs')return fsm;if(id==='node:path')return path;
    if(id==='node:crypto')return {createHash(algorithm){const h=crypto.createHash(algorithm);return {update(b){if(mode==='lateHashHit'&&!injected&&Buffer.isBuffer(b)&&b.equals(cache.get(file))){injected=true;hit();}h.update(b);return this;},digest:e=>h.digest(e)};}};
    if(!mods.has(id)){const f=()=>err('UNEXPECTED_FAKE_OS');const m=id==='node:child_process'?{spawn,execSync:f,execFile:f,fork:f}:{request:f,createConnection:f,connect:f};if(id==='node:net'){m.Socket=function(){};m.Socket.prototype.connect=f;}if(id==='node:dns')m.promises={lookup:f};mods.set(id,m);}return mods.get(id);
  }
  let args=mode==='default'?[]:['--execute-once',id];if(mode==='invalidCli')args=['--execute-once','--out','x'];if(mode==='helperCli')args=['--helper','else'];
  const proc={argv:[c.host.path,file,...args],execPath:mode==='hostMismatch'?'C:\\other.exe':c.host.path,cwd:()=>ROOT,exitCode:undefined};
  ctx=vm.createContext({require:req,__dirname,__filename:file,process:proc,Buffer,TextDecoder,Date,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),clearTimeout});
  await vm.runInContext(source,ctx,{timeout:3000});const r=JSON.parse(text);return {r,exit:proc.exitCode,written,calls,mutations,files};
}
async function mainMatrix(){
  await test('main default readonly zero mutations',async()=>{const t=await full('default');assert.equal(t.exit,2,JSON.stringify(t.r.failure));assert(t.r.preparationValidated&&!t.r.ok);assert.equal(t.calls.length,0);assert.equal(t.mutations.length,0);});
  await test('main exact one compile / synthetic PE / no execution',async()=>{const t=await full('normal');assert.equal(t.exit,0);assert(t.r.ok);assert.equal(t.calls.length,1);assert.equal(t.r.compilerStarts,1);assert.equal(t.r.productExecuted,false);assert.equal(t.r.assemblyCapabilityAuditPassed,false);assert.equal(t.r.l2Unlocked,false);assert.deepEqual(t.written,t.r);assert.deepEqual(JSON.parse(JSON.stringify(t.calls[0])),{exe:c.compiler.path,args:c.args,opts:{cwd:c.cwd,shell:false,windowsHide:true,env:c.childEnv,stdio:['ignore','pipe','pipe']}});assert.equal(t.mutations.filter(x=>x.kind==='mkdir').length,2);assert.equal(t.r.createdPaths.length,4);});
  const cases=[['invalidCli',0,'CLI'],['helperCli',0,'CLI'],['evidenceExists',0,'EVIDENCE_EXISTS'],['configDrift',0,'CONFIG_DRIFT'],['nodeDrift',0,'SOURCE_DRIFT'],['coreReferenceDrift',0,'SOURCE_DRIFT'],['secondSourceDrift',0,'SOURCE_DRIFT'],['sourceLink',0,'PATH_LINK'],['hostMismatch',0,'HOST'],['excludeMissing',0,'EXCLUDE_MISSING'],['outputExists',0,'OUTPUT_EXISTS'],['outputLink',0,'PATH_LINK'],['parentMissing',0,'ENOENT'],['mkdirRace',0,'EEXIST'],['tmpFailure',0,'EACCES'],['beforeStartExtra',0,'OUTPUT_SET'],['sourceBeforeStart',0,'SOURCE_DRIFT'],['sourceAfterStart',1,'SOURCE_DRIFT'],['configAfterStart',1,'CONFIG_DRIFT'],['startThrow',1,'OUTPUT_SET'],['compilerError',1,'OUTPUT_SET'],['stderr',1,'OUTPUT_SET'],['outputOverflow',1,'OUTPUT_SET'],['streamError',1,'OUTPUT_SET'],['timeout',1,'OUTPUT_SET'],['noClose',1,'OUTPUT_SET'],['killFalse',1,'OUTPUT_SET'],['noProduct',1,'OUTPUT_SET'],['badPe',1,'PE_BOUNDS'],['largeProduct',1,'OUTPUT_SIZE'],['extraProduct',1,'OUTPUT_SET'],['nonemptyTmp',1,'TEMP_NOT_EMPTY'],['productLink',1,'PATH_LINK']];
  for(const [name,n,code]of cases)await test('main reject '+name,async()=>{const t=await full(name);assert.equal(t.exit,1);assert(!t.r.ok);assert.equal(t.calls.length,n);assert.equal(t.r.failure.code,code);assert(t.calls.length<=1);if(['invalidCli','helperCli','evidenceExists'].includes(name))assert.equal(t.mutations.length,0);if(name==='mkdirRace')assert.deepEqual(t.r.createdPaths,[]);if(name==='noClose')assert.equal(t.r.compiler.closed,false);});
  for(const name of ['earlyNetwork','postCompileHit','lateReadHit','lateHashHit','socketHit','dnsHit','fetchHit','processHit'])await test('main caught guard '+name,async()=>{const t=await full(name);assert.equal(t.exit,1);assert(!t.r.ok);assert.equal(t.r.guardUnexpected,1);assert.equal(t.calls.length,['postCompileHit','lateReadHit','lateHashHit'].includes(name)?1:0);assert.deepEqual(t.written,t.r);});
  await test('main evidence race cannot overwrite',async()=>{const t=await full('evidenceRace');assert.equal(t.exit,1);assert.equal(t.r.failure,'EVIDENCE_WRITE_FAILED');assert.equal(t.files.get(EVIDENCE).toString(),'planted');assert.equal(t.calls.length,1);});
  await test('main final same-size product drift rejected',async()=>{const t=await full('finalProductDrift');assert.equal(t.exit,1);assert.equal(t.r.failure.code,'OUTPUT_DRIFT');assert.equal(t.calls.length,1);assert(t.r.output);});
  await test('draft/runtime inputs still pinned and output absent',()=>{assert(source.includes(hash(cache.get(CONFIG))));for(const f of [c.host,c.compiler,c.compilerConfig,...c.references,...c.sources])assert.equal(hash(cache.get(f.path)),f.sha256);assert(!fs.existsSync(c.outputRoot));assert(!fs.existsSync(EVIDENCE));});
}
async function test(name,fn){await fn();results.push({name,passed:true});}
async function run(mode){let calls=0,opts;
  const ctx=vm.createContext({Buffer,TextDecoder,need,Date,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),clearTimeout,attempts:0,rawSpawn:(exe,args,options)=>{
    calls++;opts={exe,args,options};if(mode==='throw')throw Error('synthetic');const ch=new EventEmitter();ch.pid=mode==='noPid'?undefined:123;ch.stdout=new EventEmitter();ch.stderr=new EventEmitter();
    ch.kill=()=>{if(mode==='killThrows')throw Error('synthetic');if(mode!=='noClose')queueMicrotask(()=>ch.emit('close',null,'SIGKILL'));return mode!=='killFalse';};
    queueMicrotask(()=>{
      if(mode==='normal')ch.emit('close',0,null);
      if(mode==='nonzero')ch.emit('close',1,null);
      if(mode==='signal')ch.emit('close',null,'SIGTERM');
      if(mode==='error'||mode==='noPid')ch.emit('error',Error('synthetic'));
      if(mode==='stdout')ch.stdout.emit('data',Buffer.from('synthetic diagnostic'));
      if(mode==='stderr')ch.stderr.emit('data',Buffer.from('synthetic diagnostic'));
      if(mode==='limit')ch.stdout.emit('data',Buffer.alloc(131073,65));
      if(mode==='type')ch.stdout.emit('data','not-buffer');
      if(mode==='streamError')ch.stderr.emit('error',Error('synthetic'));
      if(mode==='utf8')ch.stdout.emit('data',Buffer.from([0xff]));
    });
    if(mode==='missing')ch.stdout=null;return ch;
  }});
  vm.runInContext(body+';this.run=runCompiler;',ctx);const r=await ctx.run(c);return {r,calls,opts,ctx};
}
function pe(){const b=Buffer.alloc(2048);b.write('MZ');b.writeUInt32LE(128,60);b.writeUInt32LE(0x4550,128);b.writeUInt16LE(0x8664,132);b.writeUInt16LE(1,134);b.writeUInt16LE(240,148);const o=152;b.writeUInt16LE(0x20b,o);b.writeUInt32LE(16,o+108);b.writeUInt32LE(0x2000,o+112+14*8);b.writeUInt32LE(72,o+112+14*8+4);const s=o+240;b.writeUInt32LE(1536,s+8);b.writeUInt32LE(0x2000,s+12);b.writeUInt32LE(1536,s+16);b.writeUInt32LE(512,s+20);b.writeUInt32LE(72,512);b.writeUInt32LE(0x2080,520);b.writeUInt32LE(32,524);b.writeUInt32LE(1,528);b.writeUInt32LE(0x06000001,532);b.writeUInt32LE(0x424a5342,640);return b;}
(async()=>{try{
  assert(process.argv.length===2||process.argv.length===4&&process.argv[2]==='--out'&&path.resolve(process.argv[3])===out);if(process.argv.length===4)assert(!fs.existsSync(out));
  await test('normal fixed vector/options single start',async()=>{const t=await run('normal');assert.equal(t.r.failure,null);assert.equal(t.r.closed,true);assert.equal(t.calls,1);assert.equal(t.opts.exe,c.compiler.path);assert.deepEqual(JSON.parse(JSON.stringify(t.opts.args)),c.args);assert.deepEqual(JSON.parse(JSON.stringify(t.opts.options)),{cwd:c.cwd,shell:false,windowsHide:true,env:c.childEnv,stdio:['ignore','pipe','pipe']});await assert.rejects(t.ctx.run(c),e=>e.code==='SECOND_START');assert.equal(t.calls,1);});
  for(const [mode,reason]of [['throw','START_FAILED'],['noPid','START_FAILED'],['nonzero','PROCESS_EXIT'],['signal','PROCESS_EXIT'],['error','PROCESS_ERROR'],['stdout','STDOUT_NONEMPTY'],['stderr','STDERR_NONEMPTY'],['limit','OUTPUT_LIMIT'],['type','OUTPUT_TYPE'],['streamError','STREAM_ERROR'],['missing','STREAM_MISSING'],['timeout','TIMEOUT'],['noClose','CLOSE_UNCONFIRMED'],['killThrows','CLOSE_UNCONFIRMED'],['killFalse','TIMEOUT'],['utf8','STDOUT_NONEMPTY']])await test(mode,async()=>{const t=await run(mode);assert.equal(t.calls,1);assert.equal(t.r.failure,reason);if(mode==='noClose'||mode==='killThrows')assert.equal(t.r.closed,false);if(mode==='throw')assert.equal(t.r.spawnFailed,true);});
  const pc=vm.createContext({need});vm.runInContext(peBody+';this.inspect=inspectPe;',pc);
  await test('synthetic managed AMD64 PE',()=>{const r=pc.inspect(pe());assert.equal(r.machine,'AMD64');assert.equal(r.managedEntryToken,0x06000001);});
  const cases=[['truncated',b=>b.subarray(0,20),'PE_BOUNDS'],['DOS',b=>{b[0]=0;return b;},'PE_MZ'],['signature',b=>{b[128]=0;return b;},'PE_SIGNATURE'],['machine',b=>{b.writeUInt16LE(0x14c,132);return b;},'PE_MACHINE'],['magic',b=>{b.writeUInt16LE(0x10b,152);return b;},'PE_MAGIC'],['CLR missing',b=>{b.writeUInt32LE(0,152+224);return b;},'CLR_DIRECTORY'],['RVA invalid',b=>{b.writeUInt32LE(0x9000,152+224);return b;},'PE_RVA'],['native entry',b=>{b.writeUInt32LE(17,528);return b;},'CLR_FLAGS'],['entry zero',b=>{b.writeUInt32LE(0,532);return b;},'CLR_ENTRY_TOKEN'],['metadata',b=>{b[640]=0;return b;},'CLR_METADATA']];
  for(const [name,mutate,code]of cases)await test('PE reject '+name,()=>assert.throws(()=>pc.inspect(mutate(pe())),e=>e.code===code));
  await mainMatrix();
  await test('v2 config delta only reference and new destinations',()=>{const old=JSON.parse(fs.readFileSync(path.join(__dirname,'CodexL2观察器固定编译配置v1-20261029.json')));const now=JSON.parse(cache.get(CONFIG));assert.equal(now.references.length,3);assert.equal(now.references[2].sha256,'8b898bed54ae8cc61f9c58cc3eb062724f8357d2bdda338b5d363654ecff333d');now.references.pop();now.schema=old.schema;now.basisCommit=old.basisCommit;for(const k of now.cases){for(const key of ['outputRoot','tempRoot','outputFile','record'])k[key]=k[key].replace('synthetic-v2-','synthetic-v1-').replace('单次编译v2-','单次编译v1-');k.sourceFiles=k.sourceFiles.map(x=>x.replace('synthetic-v2-','synthetic-v1-'));k.childEnv.TEMP=k.tempRoot;k.childEnv.TMP=k.tempRoot;k.args=k.args.filter(x=>x!=='/reference:'+c.references[2].path).map(x=>x.replace('synthetic-v2-','synthetic-v1-'));}assert.deepEqual(now,old);});
  await test('v2 executor only binding delta',()=>{let old=fs.readFileSync(path.join(__dirname,'CodexL2观察器单次编译v1-20261029.cjs'),'utf8');old=old.replaceAll('固定编译配置v1-','固定编译配置v2-').replace('d8830ed6602e6f07a5255547fe5b21954d4edeeec0e53ac487d2e137a11ea075',hash(cache.get(CONFIG))).replace("schema:'codex-observer-compile-result/1'","schema:'codex-observer-compile-result/2'").replace("basisCommit:'46aa59b'","basisCommit:'2eb05f8'");assert.equal(source,old);});
  await test('historical failed receipt remains unchanged',()=>assert.equal(hash(fs.readFileSync(path.join(__dirname,'CodexL2观察器单次编译v1-baseline-20261029.json'))),'d73a332000fde1dca5f98afb511dc3717866fc4830a0c6a1c862041a1a47c6a5'));
  for(const k of c.cases)await test('case binding '+k.id,async()=>{const t=await full('normal',k.id);assert.equal(t.exit,0);assert.equal(t.calls.length,1);assert.equal(hash(t.files.get(k.sourceFiles[0])),k.sha256);assert.equal(hash(t.files.get(k.sourceFiles[1])),c.inputs[1].sha256);assert.deepEqual(Array.from(t.calls[0].args),k.args);assert.equal(t.r.caseId,k.id);assert.equal(t.r.productExecuted,false);});
  await test('generated source drift prevents compiler',async()=>{const t=await full('generatedDrift');assert.equal(t.exit,1);assert.equal(t.r.failure.code,'GENERATED_FILE_DRIFT');assert.equal(t.calls.length,0);assert.equal(t.r.createdPaths.length,4);});
  await test('runner and PE implementations reused byte exactly',()=>{const old=fs.readFileSync(path.join(__dirname,'CodexL2成员诊断单次编译v3-20261028.cjs'),'utf8');assert(old.includes(body));assert(old.includes(peBody));});
  await test('five isolated destinations and exact two-source vectors',()=>{assert.equal(new Set(c.cases.map(k=>k.outputRoot)).size,5);for(const k of c.cases){assert(!fs.existsSync(k.outputRoot));assert(!fs.existsSync(k.record));assert(k.args.includes('/main:L2ObserverSyntheticEntry'));assert.deepEqual(k.args.slice(-2),k.sourceFiles);assert(!k.args.some(a=>a.includes('辅助层')));}});

  const digests={runner:hash(fs.readFileSync(file)),test:hash(fs.readFileSync(__filename)),observer:hash(fs.readFileSync(c.sources[1].path)),config:hash(fs.readFileSync(CONFIG))};const report={schema:'codex-observer-compile-offline/2',checks:results.length,results,digests,unexpectedOS:hits,actualCompilerStarts:0,helperExecuted:false,coverage:'Actual executor/runner/PE checks with memory FS and synthetic OS/PE; fixed observer sources and compiler configuration; C# not compiled or executed',ok:hits===0};report.exitCode=report.ok?0:1;
  fs.writeSync(1,JSON.stringify({ok:report.ok,checks:results.length,unexpectedOS:hits})+'\n');if(process.argv.length===4)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,checks:results.length,error:e.message})+'\n');process.exitCode=1;}})();
