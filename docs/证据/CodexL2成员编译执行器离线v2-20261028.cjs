'use strict';
// No csc/PowerShell/helper launch. Actual runner/PE function bytes, synthetic OS/PE only.
let hits=0;const deny=()=>{hits++;throw Error('OFFLINE_OS_BLOCKED');};
for(const id of ['node:child_process','node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
const net=require('node:net');net.Socket.prototype.connect=deny;net.connect=net.createConnection=net.createServer=deny;globalThis.fetch=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
const fs=require('fs'),vm=require('vm'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),{EventEmitter}=require('events');
const file=path.join(__dirname,'CodexL2成员诊断单次编译v2-20261028.cjs'),out=path.join(__dirname,'CodexL2成员编译执行器离线v2-20261028.json');
const source=fs.readFileSync(file,'utf8'),c=JSON.parse(fs.readFileSync(path.join(__dirname,'CodexL2成员诊断编译草案v2-20261028.json')));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function section(a,b){const start=source.indexOf(a),end=source.indexOf(b);assert(start>=0&&end>start);return source.slice(start+a.length,end);}
const need=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
const body=section('// BEGIN RUNNER: offline test evaluates these actual bytes with an OS substitute.','// END RUNNER');
const peBody=section('// BEGIN PE: file-byte inspection only; no CLR/Assembly loading.','// END PE');
const results=[];
const ROOT=path.resolve(__dirname,'../..'),CONFIG=path.join(__dirname,'CodexL2成员诊断编译草案v2-20261028.json');
const EVIDENCE=path.join(__dirname,'CodexL2成员诊断单次编译v2-20261028.json'),LEGACY=path.join(ROOT,'artifacts/psr-l2/v1/psr-l2-helper.exe');
// Real input bytes are only read. All driver mutations and OS events use a separate memory FS.
const cache=new Map([file,CONFIG,path.join(ROOT,'AGENTS.md'),path.join(ROOT,'.git/info/exclude'),LEGACY,...[c.host,c.compiler,c.compilerConfig,...c.references,...c.sources,c.definitionRecord].map(x=>x.path)].map(p=>[p,fs.readFileSync(p)]));
async function full(mode){
  const files=new Map(cache),dirs=new Set(),links=new Set(),calls=[],mutations=[];
  for(const f of files.keys()){let d=path.dirname(f);while(!dirs.has(d)){dirs.add(d);const u=path.dirname(d);if(u===d)break;d=u;}}
  let text='',written=null,spawned=false,closed=false,injected=false,ctx,productReads=0;
  function err(code){throw Object.assign(Error(code),{code});}
  function hit(kind='network'){try{if(kind==='socket')new (mods.get('node:net').Socket)().connect();else if(kind==='dns')mods.get('node:dns').promises.lookup();else if(kind==='fetch')ctx.fetch();else if(kind==='process')mods.get('node:child_process').execSync('denied');else mods.get('node:https').request('denied');}catch{}}
  function bytes(p){if(!files.has(p))err('ENOENT');const b=files.get(p);
    if(p===c.outputFile){productReads++;if(mode==='finalProductDrift'&&productReads>1){const changed=Buffer.from(b);changed[changed.length-1]^=1;return changed;}}
    if(mode==='configDrift'&&p===CONFIG)return Buffer.concat([b,Buffer.from(' ')]);
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
    writeFileSync(p,b,opts){p=path.resolve(p);assert.equal(p,EVIDENCE);assert.equal(opts.flag,'wx');if(mode==='evidenceRace'){files.set(p,Buffer.from('planted'));err('EEXIST');}if(files.has(p))err('EEXIST');files.set(p,Buffer.from(b));written=JSON.parse(b);mutations.push({kind:'evidence',p});},
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
  const mods=new Map();function req(id){if(id==='node:fs')return fsm;if(id==='node:path')return path;
    if(id==='node:crypto')return {createHash(algorithm){const h=crypto.createHash(algorithm);return {update(b){if(mode==='lateHashHit'&&!injected&&Buffer.isBuffer(b)&&b.equals(cache.get(file))){injected=true;hit();}h.update(b);return this;},digest:e=>h.digest(e)};}};
    if(!mods.has(id)){const f=()=>err('UNEXPECTED_FAKE_OS');const m=id==='node:child_process'?{spawn,execSync:f,execFile:f,fork:f}:{request:f,createConnection:f,connect:f};if(id==='node:net'){m.Socket=function(){};m.Socket.prototype.connect=f;}if(id==='node:dns')m.promises={lookup:f};mods.set(id,m);}return mods.get(id);
  }
  let args=mode==='default'?[]:['--execute-once'];if(mode==='invalidCli')args=['--execute-once','--out','x'];if(mode==='helperCli')args=['--helper','else'];
  const proc={argv:[c.host.path,file,...args],execPath:mode==='hostMismatch'?'C:\\other.exe':c.host.path,cwd:()=>ROOT,exitCode:undefined};
  ctx=vm.createContext({require:req,__dirname,__filename:file,process:proc,Buffer,TextDecoder,Date,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),clearTimeout});
  await vm.runInContext(source,ctx,{timeout:3000});const r=JSON.parse(text);return {r,exit:proc.exitCode,written,calls,mutations,files};
}
async function mainMatrix(){
  await test('main default readonly zero mutations',async()=>{const t=await full('default');assert.equal(t.exit,2);assert(t.r.preparationValidated&&!t.r.ok);assert.equal(t.calls.length,0);assert.equal(t.mutations.length,0);});
  await test('main exact one compile / synthetic PE / no execution',async()=>{const t=await full('normal');assert.equal(t.exit,0);assert(t.r.ok);assert.equal(t.calls.length,1);assert.equal(t.r.compilerStarts,1);assert.equal(t.r.helperExecuted,false);assert.equal(t.r.powershellExecuted,false);assert.equal(t.r.l2Unlocked,false);assert.equal(t.r.descendantsMeasured,false);assert.deepEqual(t.written,t.r);assert.deepEqual(JSON.parse(JSON.stringify(t.calls[0])),{exe:c.compiler.path,args:c.args,opts:{cwd:c.cwd,shell:false,windowsHide:true,env:c.childEnv,stdio:['ignore','pipe','pipe']}});assert.equal(t.mutations.filter(x=>x.kind==='mkdir').length,2);assert.equal(t.r.createdPaths.length,2);});
  const cases=[['invalidCli',0,'CLI'],['helperCli',0,'CLI'],['evidenceExists',0,'EVIDENCE_EXISTS'],['configDrift',0,'CONFIG_DRIFT'],['nodeDrift',0,'SOURCE_DRIFT'],['secondSourceDrift',0,'SOURCE_DRIFT'],['sourceLink',0,'PATH_LINK'],['hostMismatch',0,'HOST'],['agentsDrift',0,'WORKSPACE_DRIFT'],['excludeMissing',0,'EXCLUDE_MISSING'],['outputExists',0,'OUTPUT_EXISTS'],['outputLink',0,'PATH_LINK'],['parentMissing',0,'ENOENT'],['mkdirRace',0,'EEXIST'],['tmpFailure',0,'EACCES'],['beforeStartExtra',0,'OUTPUT_RACE'],['sourceBeforeStart',0,'SOURCE_DRIFT'],['sourceAfterStart',1,'SOURCE_DRIFT'],['configAfterStart',1,'CONFIG_DRIFT'],['legacyAfterStart',1,'LEGACY_DRIFT'],['startThrow',1,'COMPILER_FAILED'],['compilerError',1,'COMPILER_FAILED'],['stderr',1,'COMPILER_FAILED'],['outputOverflow',1,'COMPILER_FAILED'],['streamError',1,'COMPILER_FAILED'],['timeout',1,'COMPILER_FAILED'],['noClose',1,'COMPILER_FAILED'],['killFalse',1,'COMPILER_FAILED'],['noProduct',1,'OUTPUT_SET'],['badPe',1,'PE_BOUNDS'],['largeProduct',1,'OUTPUT_SIZE'],['extraProduct',1,'OUTPUT_SET'],['nonemptyTmp',1,'TEMP_NOT_EMPTY'],['productLink',1,'OUTPUT_LINK']];
  for(const [name,n,code]of cases)await test('main reject '+name,async()=>{const t=await full(name);assert.equal(t.exit,1);assert(!t.r.ok);assert.equal(t.calls.length,n);assert.equal(t.r.failure.code,code);assert(t.calls.length<=1);if(['invalidCli','helperCli','evidenceExists'].includes(name))assert.equal(t.mutations.length,0);if(name==='mkdirRace')assert.deepEqual(t.r.createdPaths,[]);if(name==='noClose')assert.equal(t.r.compiler.closed,false);});
  for(const name of ['earlyNetwork','postCompileHit','lateReadHit','lateHashHit','socketHit','dnsHit','fetchHit','processHit'])await test('main caught guard '+name,async()=>{const t=await full(name);assert.equal(t.exit,1);assert(!t.r.ok);assert.equal(t.r.guardUnexpected,1);assert.equal(t.calls.length,['postCompileHit','lateReadHit','lateHashHit'].includes(name)?1:0);assert.deepEqual(t.written,t.r);});
  await test('main evidence race cannot overwrite',async()=>{const t=await full('evidenceRace');assert.equal(t.exit,1);assert.equal(t.r.failure,'EVIDENCE_WRITE_FAILED');assert.equal(t.files.get(EVIDENCE).toString(),'planted');assert.equal(t.calls.length,1);});
  await test('main final same-size product drift rejected',async()=>{const t=await full('finalProductDrift');assert.equal(t.exit,1);assert.equal(t.r.failure.code,'OUTPUT_DRIFT');assert.equal(t.calls.length,1);assert(t.r.output);});
  await test('draft/runtime inputs still pinned and output absent',()=>{assert(source.includes(hash(cache.get(CONFIG))));for(const f of [c.host,c.compiler,c.compilerConfig,...c.references,...c.sources,c.definitionRecord])assert.equal(hash(cache.get(f.path)),f.sha256);assert(!fs.existsSync(c.outputRoot));assert(!fs.existsSync(EVIDENCE));});
}
async function observerMatrix(){
  const old=fs.readFileSync(path.join(__dirname,'CodexL2成员观察器-20261028.cs'),'utf8');
  const current=fs.readFileSync(c.sources[1].path,'utf8');
  function expected(){return old.replace('HashSet<uint> unique=new HashSet<uint>();','List<uint> unique=new List<uint>();').replace('!unique.Add((uint)id)','unique.Contains((uint)id)').replace('        Member m=Slot((uint)id);','        unique.Add((uint)id);\r\n        Member m=Slot((uint)id);');}
  function validate(s){assert.equal(s,expected());assert(!s.includes('HashSet<'));assert.equal((s.match(/unique\.Add\(\(uint\)id\)/g)||[]).length,1);assert(s.indexOf('unique.Contains((uint)id)')<s.indexOf('unique.Add((uint)id)'));}
  await test('observer exact minimal source delta / outer cleanup unchanged',()=>validate(current));
  const originalConfig=JSON.parse(fs.readFileSync(path.join(__dirname,'CodexL2成员诊断编译草案-20261028.json')));
  await test('v2 compile config only versioned source/output/basis delta',()=>{
    const expectedConfig=JSON.parse(JSON.stringify(originalConfig));expectedConfig.basisCommit='e76bf47';expectedConfig.sources[1].path=expectedConfig.sources[1].path.replace('观察器-','观察器v2-');expectedConfig.sources[1].sha256=hash(Buffer.from(current));
    for(const k of ['outputRoot','outputFile','tempRoot'])expectedConfig[k]=expectedConfig[k].replace('member-diag-v1','member-diag-v2');expectedConfig.args=expectedConfig.args.map(x=>x.replace('member-diag-v1','member-diag-v2').replace('成员观察器-','成员观察器v2-'));for(const k of ['TEMP','TMP'])expectedConfig.childEnv[k]=expectedConfig.childEnv[k].replace('member-diag-v1','member-diag-v2');assert.deepEqual(c,expectedConfig);
  });
  await test('v2 executor only explicit bindings and schema delta',()=>{
    let prior=fs.readFileSync(path.join(__dirname,'CodexL2成员诊断单次编译-20261028.cjs'),'utf8');prior=prior.replaceAll('CodexL2成员诊断编译草案-','CodexL2成员诊断编译草案v2-').replaceAll('CodexL2成员诊断单次编译-','CodexL2成员诊断单次编译v2-').replace('aa42d0ec2d1fc9641f50556edcf3fc81f5f3031525541481c51308cf21c7c70a',hash(cache.get(CONFIG))).replace('9ef30b4c10f7dd1ba777e9a233f49fd5d0ead80c1aad6d4b2dd0664b1dfa6396',hash(cache.get(path.join(ROOT,'AGENTS.md')))).replace("basisCommit:'769869b'","basisCommit:'e76bf47'").replace("schema:'codex-l2-member-compile-result/1'","schema:'codex-l2-member-compile-result/2'");assert.equal(source,prior);
  });
  const mutants=[['remove duplicate test',s=>s.replace('||unique.Contains((uint)id)','')],['omit add',s=>s.replace('        unique.Add((uint)id);\r\n','')],['add before rejection',s=>s.replace('        long id=Marshal.ReadInt64(b,8+i*8);','        long id=Marshal.ReadInt64(b,8+i*8);unique.Add((uint)id);')],['restore HashSet',s=>s.replace('List<uint> unique=new List<uint>();','HashSet<uint> unique=new HashSet<uint>();')]];
  for(const [name,mutate]of mutants)await test('observer source sensitivity '+name,()=>{const changed=mutate(current);assert.notEqual(changed,current);assert.throws(()=>validate(changed));});
  // Semantic models only: no C# compilation or runtime execution is claimed.
  function model(ids,useSet){const unique=useSet?new Set():[],accepted=[];if(ids.length>16)return {failure:'OBS_CENSUS_SIZE',accepted};for(const id of ids){if(id<=0||id>0xffffffff||(useSet?unique.has(id):unique.includes(id)))return {failure:'OBS_CENSUS_PID',accepted};if(useSet)unique.add(id);else unique.push(id);accepted.push(id);}return {failure:null,accepted};}
  const sequences=[['empty',[],null,0],['one',[1],null,1],['sixteen',Array.from({length:16},(_,i)=>i+1),null,16],['adjacent',[2,2],'OBS_CENSUS_PID',1],['first-last',[1,2,3,1],'OBS_CENSUS_PID',3],['last duplicate',[1,2,3,3],'OBS_CENSUS_PID',3],['zero',[0],'OBS_CENSUS_PID',0],['negative',[-1],'OBS_CENSUS_PID',0],['max',[0xffffffff],null,1],['over max',[0x100000000],'OBS_CENSUS_PID',0],['invalid after accepted',[1,0],'OBS_CENSUS_PID',1],['count overflow',Array.from({length:17},(_,i)=>i+1),'OBS_CENSUS_SIZE',0]];
  for(const [name,ids,failure,count]of sequences)await test('observer semantic model '+name,()=>{const r=model(ids,false);assert.deepEqual(r,model(ids,true));assert.equal(r.failure,failure);assert.equal(r.accepted.length,count);assert.deepEqual(r.accepted,ids.slice(0,count));});
  await test('observer semantic model fresh collection per census',()=>{assert.deepEqual(model([1,2],false),model([1,2],false));assert.equal(model([1,2],false).failure,null);});
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
  await observerMatrix();
  const digests={runner:hash(fs.readFileSync(file)),test:hash(fs.readFileSync(__filename)),observer:hash(fs.readFileSync(c.sources[1].path)),config:hash(fs.readFileSync(CONFIG))};const report={schema:'codex-l2-member-compile-offline/2',checks:results.length,results,digests,unexpectedOS:hits,actualCompilerStarts:0,helperExecuted:false,coverage:'75 actual executor/runner/PE checks with memory FS and synthetic OS/PE; 20 exact source/config deltas, source mutation checks and PID semantic models; C# not compiled or executed',ok:hits===0};report.exitCode=report.ok?0:1;
  fs.writeSync(1,JSON.stringify({ok:report.ok,checks:results.length,unexpectedOS:hits})+'\n');if(process.argv.length===4)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,checks:results.length,error:e.message})+'\n');process.exitCode=1;}})();
