'use strict';
// Reads PE/CLI metadata bytes only. Never loads an Assembly or starts any process.
let blocked=0;const deny=()=>{blocked++;throw Error('READONLY_OS_BLOCKED');};
for(const id of ['node:child_process','node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
const net=require('node:net');net.connect=net.createConnection=net.createServer=deny;net.Socket.prototype.connect=deny;globalThis.fetch=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
const fs=require('fs'),path=require('path'),crypto=require('crypto'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),file=path.join(root,'artifacts/psr-l2/observer-synthetic-v2-baseline/observer-test.exe'),out=__filename.replace(/cjs$/,'json');
const expected='d6c3fdfca6893ede87afb8c866dbc637c5c45e36def2ac8140266d08b3ba215b',H=b=>crypto.createHash('sha256').update(b).digest('hex');
const checks=[];function check(name,fn){const value=fn();checks.push({name,passed:true});return value;}
function inspectEntry(b){
  const need=(v,c)=>assert(v,c),span=(o,n)=>need(Number.isSafeInteger(o)&&o>=0&&n>=0&&o+n<=b.length,'bounds');
  const pe=b.readUInt32LE(60),opt=pe+24,ns=b.readUInt16LE(pe+6),os=b.readUInt16LE(pe+20);span(opt,os+ns*40);
  const sections=[];for(let i=0;i<ns;i++){const s=opt+os+i*40;sections.push({va:b.readUInt32LE(s+12),raw:b.readUInt32LE(s+20),size:b.readUInt32LE(s+16)});}
  function at(r,n){const all=sections.filter(s=>r>=s.va&&r-s.va+n<=s.size);need(all.length===1,'RVA');const p=all[0].raw+r-all[0].va;span(p,n);return p;}
  const clr=at(b.readUInt32LE(opt+112+14*8),72),token=b.readUInt32LE(clr+20),meta=at(b.readUInt32LE(clr+8),b.readUInt32LE(clr+12)),metaSize=b.readUInt32LE(clr+12);
  const mspan=(p,n)=>{span(p,n);need(p>=meta&&p+n<=meta+metaSize,'metadata bounds');};
  const versionBytes=b.readUInt32LE(meta+12);let p=meta+16+versionBytes;p=(p+3)&~3;mspan(p,4);const nstreams=b.readUInt16LE(p+2);p+=4;const streams={};
  for(let i=0;i<nstreams;i++){mspan(p,8);const off=b.readUInt32LE(p),len=b.readUInt32LE(p+4);p+=8;let end=p;while(end<meta+metaSize&&b[end]!==0)end++;need(end<meta+metaSize,'stream name');const name=b.toString('ascii',p,end);p=(end+4)&~3;mspan(meta+off,len);need(!streams[name],'duplicate stream');streams[name]={p:meta+off,n:len};}
  need(streams['#~']&&streams['#Strings']&&streams['#Blob'],'metadata streams');const table=streams['#~'],strings=streams['#Strings'],blob=streams['#Blob'];mspan(table.p,24);
  const heap=b[table.p+6],str=(heap&1)?4:2,guid=(heap&2)?4:2,bl=(heap&4)?4:2,valid=b.readBigUInt64LE(table.p+8),rows=Array(64).fill(0);p=table.p+24;
  for(let i=0;i<64;i++)if(valid&(1n<<BigInt(i))){mspan(p,4);rows[i]=b.readUInt32LE(p);p+=4;}
  const idx=t=>rows[t]<65536?2:4,coded=(bits,ts)=>Math.max(...ts.map(t=>rows[t]))<(1<<(16-bits))?2:4;
  const sizes=[2+str+guid*3,coded(2,[0,26,35,1])+2*str,4+2*str+coded(2,[2,1,27])+idx(4)+idx(6),idx(4),2+str+bl,idx(6),8+str+bl+idx(8)];
  const starts=[];for(let i=0;i<=6;i++){starts[i]=p;const len=rows[i]*sizes[i];mspan(p,len);need(p+len<=table.p+table.n,'table bounds');p+=len;}
  function uint(p,n){mspan(p,n);return n===2?b.readUInt16LE(p):b.readUInt32LE(p);}
  function stringAt(i){need(i<strings.n,'string index');let q=strings.p+i,end=q;while(end<strings.p+strings.n&&b[end]!==0)end++;need(end<strings.p+strings.n,'string terminator');return new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(q,end));}
  need(rows[26]===0&&rows[28]===0,'native module/import tables absent');for(let i=0;i<rows[6];i++){const f=b.readUInt16LE(starts[6]+i*sizes[6]+6);need((f&0x2000)===0,'PInvoke method absent');}
  need((token>>>24)===6,'entry token table');const rid=token&0xffffff;need(rid>0&&rid<=rows[6],'entry MethodDef row');const method=starts[6]+(rid-1)*sizes[6],rva=b.readUInt32LE(method),flags=b.readUInt16LE(method+6),name=stringAt(uint(method+8,str));
  const sigIndex=uint(method+8+str,bl);need(sigIndex<blob.n,'blob index');let q=blob.p+sigIndex;const first=b[q++];let sigLen;if((first&128)===0)sigLen=first;else if((first&192)===128){mspan(q,1);sigLen=((first&63)<<8)|b[q++];}else{need((first&224)===192,'blob length');mspan(q,3);sigLen=((first&31)*16777216)+(b[q++]<<16)+(b[q++]<<8)+b[q++];}need(q+sigLen<=blob.p+blob.n,'blob range');const signature=Array.from(b.subarray(q,q+sigLen));
  let owner=null;for(let i=0;i<rows[2];i++){const row=starts[2]+i*sizes[2],methodListOffset=4+2*str+coded(2,[2,1,27])+idx(4),firstMethod=uint(row+methodListOffset,idx(6)),last=i+1<rows[2]?uint(row+sizes[2]+methodListOffset,idx(6)):rows[6]+1;if(rid>=firstMethod&&rid<last)owner=stringAt(uint(row+4,str));}
  need(name==='Main'&&owner==='L2ObserverSyntheticEntry'&&(flags&0x10)!==0,'static entry name/owner');need(JSON.stringify(signature)==='[0,1,8,29,14]','int Main(string[]) signature');
  const body=at(rva,1);let ilBytes,header;if((b[body]&3)===2){header=1;ilBytes=b[body]>>>2;}else{need((b[body]&3)===3,'method header');span(body,12);header=(b.readUInt16LE(body)>>>12)*4;need(header>=12,'fat method header');ilBytes=b.readUInt32LE(body+4);}need(ilBytes>0,'entry body');at(rva,header+ilBytes);
  return {entryToken:'0x'+token.toString(16).padStart(8,'0'),moduleRefRows:rows[26],implMapRows:rows[28],pinvokeMethods:0,methodDefCount:rows[6],owner,name,isStatic:true,signature:'int Main(string[])',ilBytes,ilSemanticsVerified:false};
}
try{
  const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===out);if(args.length)assert(!fs.existsSync(out));
  const b=check('binary fixed hash and size',()=>{const v=fs.readFileSync(file);assert.equal(v.length,24064);assert.equal(H(v),expected);return v;});
  check('binary path no links',()=>{for(let p=file;;p=path.dirname(p)){assert(!fs.lstatSync(p).isSymbolicLink());if(path.dirname(p)===p)break;}});
  const recordBytes=fs.readFileSync(path.join(__dirname,'CodexL2观察器单次编译v2-baseline-20261029.json')),r=JSON.parse(recordBytes);
  check('compile receipt pinned and success',()=>{assert.equal(H(recordBytes),'a0d33fe1a57c43b9011f9fa09ee3f7fec74207fb67fe278aa7041d578c4a02b9');assert(r.ok&&r.compiler.closed&&r.compilerStarts===1&&r.compiler.exitCode===0);assert.equal(r.output.sha256,expected);assert.equal(r.productExecuted,false);});
  check('compile inputs still match',()=>{assert.deepEqual(r.inputsBefore,r.inputsAfter);assert.deepEqual(r.inputsBefore,r.inputsFinal);for(const p of r.inputsFinal)assert.equal(H(fs.readFileSync(p.path)),p.sha256);});
  const inspector=fs.readFileSync(path.join(__dirname,'CodexL2观察器单次编译v2-20261029.cjs'),'utf8');assert.equal(H(Buffer.from(inspector)),r.digests.runner);
  const body=inspector.split('// BEGIN PE: file-byte inspection only; no CLR/Assembly loading.')[1].split('// END PE')[0];const ctx=vm.createContext({need:(v,c)=>assert(v,c)});vm.runInContext(body+';this.inspect=inspectPe;',ctx);
  const pe=check('actual PE and CLI file structure',()=>ctx.inspect(b));
  const entry=check('entry MethodDef owner signature and body range',()=>inspectEntry(b));
  check('entry token out of range rejected',()=>{const v=Buffer.from(b),opt=v.readUInt32LE(60)+24,dir=opt+112+14*8;const rva=v.readUInt32LE(dir),section=opt+v.readUInt16LE(opt-4);const va=v.readUInt32LE(section+12),raw=v.readUInt32LE(section+20);v.writeUInt32LE(0x06ffffff,raw+rva-va+20);assert.throws(()=>inspectEntry(v));});
  check('binary unchanged after inspection',()=>assert.equal(H(fs.readFileSync(file)),expected));
  const report={schema:'codex-observer-binary-entry-review/1',basisCommit:'1253e2c',checks:checks.length,results:checks,binarySha256:expected,pe,entry,scriptSha256:H(fs.readFileSync(__filename)),compileEvidenceSha256:H(recordBytes),processesStarted:0,assemblyLoaded:false,helperExecuted:false,assemblyCapabilityAuditPassed:false,guardUnexpected:blocked,limitations:['PE/CLI metadata inspection only, not IL semantic verification','Job/handle cleanup and real transport not executed','This binds an existing compiled artifact; no deterministic rebuild claim']};report.ok=blocked===0;report.exitCode=report.ok?0:1;
  fs.writeSync(1,JSON.stringify({ok:report.ok,checks:report.checks,entry})+'\n');if(args.length)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,checks:checks.length,error:e.message})+'\n');process.exitCode=1;}
