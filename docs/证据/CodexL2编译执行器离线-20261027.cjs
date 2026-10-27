'use strict';
// No csc/PowerShell/helper launch. Actual runner/PE function bytes, synthetic OS/PE only.
let hits=0;const deny=()=>{hits++;throw Error('OFFLINE_OS_BLOCKED');};
for(const id of ['node:child_process','node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
const net=require('node:net');net.Socket.prototype.connect=deny;net.connect=net.createConnection=net.createServer=deny;globalThis.fetch=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
const fs=require('fs'),vm=require('vm'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),{EventEmitter}=require('events');
const file=path.join(__dirname,'CodexL2单次编译-20261027.cjs'),out=path.join(__dirname,'CodexL2编译执行器离线-20261027.json');
const source=fs.readFileSync(file,'utf8'),c=JSON.parse(fs.readFileSync(path.join(__dirname,'CodexL2固定编译配置-20261027.json')));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function section(a,b){const start=source.indexOf(a),end=source.indexOf(b);assert(start>=0&&end>start);return source.slice(start+a.length,end);}
const need=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
const body=section('// BEGIN RUNNER: offline test evaluates these actual bytes with an OS substitute.','// END RUNNER');
const peBody=section('// BEGIN PE: file-byte inspection only; no CLR/Assembly loading.','// END PE');
const results=[];
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
  const digests={runner:hash(fs.readFileSync(file)),test:hash(fs.readFileSync(__filename))};const report={schema:'codex-l2-compile-runner-offline/1',checks:results.length,results,digests,unexpectedOS:hits,actualCompilerStarts:0,helperExecuted:false,coverage:'actual runner and PE function bodies; synthetic OS events and PE bytes; main FS orchestration reviewed separately',ok:hits===0};report.exitCode=report.ok?0:1;
  fs.writeSync(1,JSON.stringify({ok:report.ok,checks:results.length,unexpectedOS:hits})+'\n');if(process.argv.length===4)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,checks:results.length,error:e.message})+'\n');process.exitCode=1;}})();
