'use strict';
// Reads PE/CLI metadata bytes only. Never loads an Assembly or starts any process.
let blocked=0;const deny=()=>{blocked++;throw Error('READONLY_OS_BLOCKED');};
for(const id of ['node:child_process','node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
const net=require('node:net');net.connect=net.createConnection=net.createServer=deny;net.Socket.prototype.connect=deny;globalThis.fetch=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
const fs=require('fs'),path=require('path'),crypto=require('crypto'),vm=require('vm'),assert=require('assert/strict');
const out=__filename.replace(/cjs$/,'json'),file='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Core.dll';
const H=b=>crypto.createHash('sha256').update(b).digest('hex');
function inspectType(b){
  const need=(v,c)=>assert(v,c),span=(o,n)=>need(Number.isSafeInteger(o)&&o>=0&&n>=0&&o+n<=b.length,'bounds');
  const pe=b.readUInt32LE(60),opt=pe+24,ns=b.readUInt16LE(pe+6),os=b.readUInt16LE(pe+20);span(opt,os+ns*40);
  const sections=[];for(let i=0;i<ns;i++){const s=opt+os+i*40;sections.push({va:b.readUInt32LE(s+12),raw:b.readUInt32LE(s+20),size:b.readUInt32LE(s+16)});}
  function at(r,n){const all=sections.filter(s=>r>=s.va&&r-s.va+n<=s.size);need(all.length===1,'RVA');const p=all[0].raw+r-all[0].va;span(p,n);return p;}
  const clr=at(b.readUInt32LE(opt+(b.readUInt16LE(opt)===0x20b?112:96)+14*8),72),token=b.readUInt32LE(clr+20),meta=at(b.readUInt32LE(clr+8),b.readUInt32LE(clr+12)),metaSize=b.readUInt32LE(clr+12);
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

  const found=[];for(let i=0;i<rows[2];i++){const row=starts[2]+i*sizes[2];const name=stringAt(uint(row+4,str)),ns=stringAt(uint(row+4+str,str));if(name==='HashSet'+String.fromCharCode(96)+'1'&&ns==='System.Collections.Generic')found.push({row:i+1,name,namespace:ns,flags:b.readUInt32LE(row)});}
  need(found.length===1,'unique HashSet TypeDef');need((found[0].flags&7)===1,'public type');return {type:found[0],typeDefCount:rows[2],definitionNotStringSearch:true};
}
module.exports={inspectType};
if(require.main===module){const results=[];const check=(name,fn)=>{fn();results.push({name,passed:true});};try{
 const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===out);if(args.length)assert(!fs.existsSync(out));
 const b=fs.readFileSync(file),sha=H(b);let metadata;
 check('fixed file no link',()=>{for(let p=file;;p=path.dirname(p)){assert(!fs.lstatSync(p).isSymbolicLink());if(path.dirname(p)===p)break;}});
 check('HashSet public TypeDef',()=>{metadata=inspectType(b);});
 check('truncated rejected',()=>assert.throws(()=>inspectType(b.subarray(0,64))));
 check('name removal rejected',()=>{const v=Buffer.from(b),key=Buffer.from('HashSet'+String.fromCharCode(96)+'1'+String.fromCharCode(0));let at=v.indexOf(key);assert(at>=0);while(at>=0){v[at]=88;at=v.indexOf(key,at+1);}assert.throws(()=>inspectType(v));});
 check('mscorlib does not define requested type',()=>assert.throws(()=>inspectType(fs.readFileSync(path.join(path.dirname(file),'mscorlib.dll'))),/unique HashSet TypeDef/));
 check('System does not define requested type',()=>assert.throws(()=>inspectType(fs.readFileSync(path.join(path.dirname(file),'System.dll'))),/unique HashSet TypeDef/));
 check('unchanged file',()=>assert.equal(H(fs.readFileSync(file)),sha));
 const report={schema:'codex-hashset-reference/1',basisCommit:'2eb05f8',file,bytes:b.length,sha256:sha,metadata,checks:results.length,results,scriptSha256:H(fs.readFileSync(__filename)),assemblyLoaded:false,compilerStarts:0,guardUnexpected:blocked};report.ok=blocked===0;report.exitCode=report.ok?0:1;
 const text=JSON.stringify(report,null,2)+'\n';if(args.length)fs.writeFileSync(out,text,{flag:'wx'});fs.writeSync(1,text);process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,checks:results.length,error:e.message})+'\n');process.exitCode=1;}}
