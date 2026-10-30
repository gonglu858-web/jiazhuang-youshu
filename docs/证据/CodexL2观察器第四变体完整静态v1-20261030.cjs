'use strict';
// Fixed PE bytes only. Never load CLR assemblies or execute products.
let unexpected=0;
const deny=()=>{unexpected++;throw Error('READONLY_OS_BLOCKED');};
for(const id of ['node:child_process','node:http','node:https','node:tls','node:dgram','node:dns']){
 const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});
}
const net=require('node:net');net.Socket.prototype.connect=deny;net.connect=net.createConnection=net.createServer=deny;globalThis.fetch=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),plain=o=>JSON.parse(JSON.stringify(o));
const BASE=path.join(ROOT,'artifacts/psr-l2/observer-synthetic-v2-baseline/observer-test.exe');
const MUT=path.join(ROOT,'artifacts/psr-l2/observer-synthetic-v2-recapture/observer-test.exe');
const BH='d6c3fdfca6893ede87afb8c866dbc637c5c45e36def2ac8140266d08b3ba215b',MH='381886fd26286256c43997275162eaee3080470cb90084d2b2bd1e515a074b5d';
const PARSER=path.join(__dirname,'CodexL2观察器托管能力只读v1-20261029.cjs'),PH='474d8aebdcc7f686440ac5587ec94bf0def67a5cc6f104b8b3d27d91dfa7d8db';
const RECEIPT=path.join(__dirname,'CodexL2观察器单次编译v2-recapture-20261029.json'),RH='b143529462ca6002a2d4598d024842d459679e314c7f7468d7f961a14052661b';
const POLICY=path.join(__dirname,'CodexL2观察器托管调用清单v1-20261029.json'),POLH='770cdb4dd5dfb4477b3c3b3e7b91e78cf1184cc7cf51f00a419a6dcae37cca24';
const CAP='L2MemberObserver::Capture',results=[];
function test(name,fn){fn();results.push({name,passed:true});}
function chain(p){for(;;){assert(!fs.lstatSync(p).isSymbolicLink(),'PATH_LINK');const up=path.dirname(p);if(up===p)return;p=up;}}

// Add exports at unique anchors of the pinned parser; retain its existing checks.
// Extra decoding uses the same instruction width table and metadata resolver.
function extend(source){
 const s=source.indexOf('function inspect(b){'),e=source.indexOf('\nconst POLICY=',s);assert(s>=0&&e>s);let body=source.slice(s,e).trim();
 const original=body,patches=[];
 function patch(from,to){assert.equal(body.split(from).length,2,'UNIQUE_PARSER_ANCHOR');patches.push(hash(Buffer.from(from)));body=body.replace(from,to);}
 patch('const calls=[],allOps=new Set(),bodyFacts=[];',`const calls=[],allOps=new Set(),bodyFacts=[],details=[];
 function semantic(tok){const t=tok>>>24,id=tok&0xffffff,target=resolve(tok);let sig=null;
  if(t===6)sig=methods[id-1].signature;else if(t===10)sig=refs[id-1].signature;else if(t===4)sig=signature(blob(row(4,id)[2]));else if(t===43)sig=signature(blob(row(43,id)[1]));
  return {kind:t,target,signature:sig};
 }
 function userString(tok){need(tok>>>24===112,'US_TOKEN');const us=streams['#US'],st={p:tok&0xffffff},v=b.subarray(us.p,us.p+us.n),n=compressed(v,st);need(n>0&&(n&1)===1&&st.p+n<=v.length,'US_ENCODING');need(v[st.p+n-1]<=1,'US_FLAG');return v.subarray(st.p,st.p+n).toString('hex');}
 function canonicalMetadata(){return tables.map((rs,t)=>({table:t,rows:rs.map((r,i)=>r.map((v,j)=>{
  if(t===6&&j===0)return 'METHOD_RVA';
  if(t===0&&j===2)return 'BUILD_MVID';
  const k=schemas[t][j];if(k==='s')return str(v);if(k==='b')return blob(v).toString('hex');
  if(k==='g'){if(v===0)return null;const g=streams['#GUID'];need(g&&v*16<=g.n,'GUID_INDEX');return b.subarray(g.p+(v-1)*16,g.p+v*16).toString('hex');}
  if(v&&ci[k]){const q=decode(k,v);if(q.t===10)return semantic((10<<24)|q.id);}
  if(v&&k==='t10')return semantic((10<<24)|v);return v;
 })).sort(t===10?(a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)):()=>0)})).filter(x=>x.rows.length);}
 `);
 patch('const body=at(m.rva,hs+len)+hs,end=body+len,boundaries=',`const detail={name:m.name,signature:m.signature,flags:m.flags,implFlags:m.implFlags,
 header:hs===1?{format:'tiny',maxStack:8,initLocals:false,local:null}:{format:'fat',flags:b.readUInt16LE(start)&4095,headerWords:hs/4,maxStack:b.readUInt16LE(start+2),local:local?signature(blob(row(17,local&0xffffff)[0])):null,extra:b.subarray(start+12,start+hs).toString('hex')},instructions:[],exceptions:[]};
 const body=at(m.rva,hs+len)+hs,end=body+len,boundaries=`);
 patch("if(kind==='switch'){need(q+4<=end,'SWITCH');",`const inst={offset:off,opcode:code.toString(16),kind,operand:null};detail.instructions.push(inst);
 if(kind==='switch'){need(q+4<=end,'SWITCH');`);
 patch('const next=q+n*4;for(let j=0;j<n;j++)branches.push(',`const next=q+n*4;inst.operand=Array.from({length:n},(_,j)=>next-body+b.readInt32LE(q+j*4));for(let j=0;j<n;j++)branches.push(`);
 patch("need(q+size<=end,'OPERAND');if(kind==='branch'",`need(q+size<=end,'OPERAND');
 if(kind==='token')inst.operand=semantic(b.readUInt32LE(q));
 else if(kind==='string')inst.operand=userString(b.readUInt32LE(q));
 else if(kind==='branch'||kind==='shortbranch')inst.operand=q+size-body+(size===4?b.readInt32LE(q):b.readInt8(q));
 else if(size)inst.operand=b.subarray(q,q+size).toString('hex');
 if(kind==='branch'`);
 patch('clauses++;}if(!(k&128))',`detail.exceptions.push({flag,tryStart:tr,tryEnd:tr+tl,handlerStart:ha,handlerEnd:ha+hl,catchType:flag===0?semantic(cl):null,filter:flag===1?cl:null,reserved:flag===2||flag===4?cl:null});clauses++;}if(!(k&128))`);
 patch('bodyFacts.push({name:m.name,',`details.push(detail);bodyFacts.push({headerOffset:start,name:m.name,`);
 patch('return {assemblies,types,refs',`return {details,canonicalMetadata:canonicalMetadata(),assemblies,types,refs`);
 const compile=s=>vm.runInNewContext('('+s+')',{assert,Buffer,TextDecoder},{timeout:2000});
 return {original:compile(original),inspect:compile(body),patchAnchorHashes:patches};
}

function projectLegacy(r){const v=plain(r);delete v.details;delete v.canonicalMetadata;for(const m of v.bodyFacts)delete m.headerOffset;return v;}
function expectedFromBaseline(left){
 const expected=plain(left.details),m=expected.find(x=>x.name===CAP);assert(m);
 // Exact original prefix: load State, UNKNOWN, String inequality, brfalse to 19, ret.
 assert.deepEqual(m.instructions.slice(0,6).map(x=>({offset:x.offset,opcode:x.opcode})),[
  {offset:0,opcode:'3'},{offset:1,opcode:'7b'},{offset:6,opcode:'72'},{offset:11,opcode:'28'},{offset:16,opcode:'2c'},{offset:18,opcode:'2a'}]);
 assert.deepEqual(m.instructions[1].operand,{kind:4,target:'Member::State',signature:'field string'});
 assert.equal(m.instructions[2].operand,Buffer.concat([Buffer.from('UNKNOWN','utf16le'),Buffer.from([0])]).toString('hex'));
 assert.deepEqual(m.instructions[3].operand,{kind:10,target:'[mscorlib]System.String::op_Inequality',signature:'cc0/g0 bool(string,string)'});
 assert.equal(m.instructions[4].operand,19);
 const shift=n=>{assert(n>=19,'UNEXPECTED_CAPTURE_BACKEDGE');return n-10;};
 const tail=m.instructions.slice(6).map(x=>{x.offset=shift(x.offset);if(['branch','shortbranch'].includes(x.kind))x.operand=shift(x.operand);if(x.kind==='switch')x.operand=x.operand.map(shift);return x;});
 m.instructions=[{offset:0,opcode:'3',kind:'none',operand:null},{offset:1,opcode:'7b',kind:'token',operand:{kind:4,target:'Member::Pid',signature:'field u4'}},{offset:6,opcode:'2d',kind:'shortbranch',operand:9},{offset:8,opcode:'2a',kind:'none',operand:null},...tail];
 for(const eh of m.exceptions){for(const k of ['tryStart','tryEnd','handlerStart','handlerEnd'])eh[k]=shift(eh[k]);if(eh.filter!==null)eh.filter=shift(eh.filter);}
 return expected;
}

try{
 const args=process.argv.slice(2),out=__filename.replace(/cjs$/,'json');assert(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===out);if(args.length)assert(!fs.existsSync(out));
 const pins=[[BASE,BH],[MUT,MH],[PARSER,PH],[RECEIPT,RH],[POLICY,POLH]],bytes=new Map();
 test('fixed inputs, no links and single compile receipt',()=>{for(const [p,h] of pins){chain(p);const b=fs.readFileSync(p);assert.equal(hash(b),h);bytes.set(p,b);}const r=JSON.parse(bytes.get(RECEIPT));assert(r.ok&&r.compilerStarts===1&&r.compiler.closed&&r.compiler.exitCode===0&&!r.productExecuted&&r.guardUnexpected===0);assert.equal(r.output.sha256,MH);});
 const parser=extend(bytes.get(PARSER).toString('utf8')),a=bytes.get(BASE),b=bytes.get(MUT),x=parser.inspect(a),y=parser.inspect(b),policy=JSON.parse(bytes.get(POLICY));
 test('added exports preserve original parser results on both binaries',()=>{assert.deepEqual(projectLegacy(x),plain(parser.original(a)));assert.deepEqual(projectLegacy(y),plain(parser.original(b)));});
 test('baseline matches reviewed capability inventory',()=>{for(const [k,p] of [['assemblies','reviewedAssemblies'],['types','reviewedTypes'],['refs','reviewedMembers'],['typeSpecs','reviewedTypeSpecs'],['methodSpecs','reviewedMethodSpecs'],['calls','reviewedCalls']])assert.deepEqual(plain(x[k]),policy[p]);});
 const expected=expectedFromBaseline(x);
 function compare(candidate){const z=parser.inspect(candidate);assert.deepEqual(plain(z.canonicalMetadata),plain(x.canonicalMetadata),'METADATA_DIFF');assert.equal(z.entry,x.entry,'ENTRY_DIFF');assert.deepEqual(plain(z.details),expected,'INSTRUCTION_HEADER_EH_DIFF');return z;}
 test('all metadata rows equal except mapped reference indexes, method RVAs and build MVID',()=>assert.deepEqual(plain(y.canonicalMetadata),plain(x.canonicalMetadata)));
 test('all 85 bodies, headers, operands, branch targets and exception clauses match exact delta',()=>compare(b));
 const summaries=y.details.map((m,i)=>({method:m.name,instructions:m.instructions.length,exceptionClauses:m.exceptions.length,normalizedSha256:hash(Buffer.from(JSON.stringify(m))),baselineNormalizedSha256:hash(Buffer.from(JSON.stringify(x.details[i]))),changed:m.name===CAP}));
 // Binary-level negative tests: each alteration is memory-only and must fail the same comparator.
 function altered(name,select,mutate){test(name,()=>{const v=Buffer.from(b);mutate(v,select());assert.throws(()=>compare(v));});}
 const fact=name=>y.bodyFacts.find(m=>m.name===name);
 const find=(pred)=>{for(const m of y.details){const i=m.instructions.find(pred);if(i)return {m,i,f:fact(m.name)};}throw Error('TEST_ANCHOR_MISSING');};
 test('unchanged baseline rejected as missing approved mutation',()=>assert.throws(()=>compare(a),/INSTRUCTION_HEADER_EH_DIFF/));
 altered('valid field operand change rejected',()=>find(i=>i.kind==='token'&&i.operand.target==='Member::Pid'),(v,{i,f})=>v.writeUInt32LE(0x04000018,f.fileOffset+i.offset+1));
 altered('valid method operand change rejected',()=>find(i=>i.opcode==='28'),(v,{i,f})=>v.writeUInt32LE(0x06000001,f.fileOffset+i.offset+1));
 altered('string heap content change rejected',()=>find(i=>i.kind==='string'),(v,{i,f})=>{const token=v.readUInt32LE(f.fileOffset+i.offset+1);const other=find(j=>j.kind==='string'&&j.operand!==i.operand);const t=v.readUInt32LE(other.f.fileOffset+other.i.offset+1);assert.notEqual(t,token);v.writeUInt32LE(t,f.fileOffset+i.offset+1);});
 altered('valid branch destination change rejected',()=>find(i=>i.kind==='shortbranch'),(v,{i,f})=>v.writeInt8(0,f.fileOffset+i.offset+1));
 altered('constant operand change rejected',()=>find(i=>i.opcode==='20'),(v,{i,f})=>v[f.fileOffset+i.offset+1]^=1);
 altered('valid opcode substitution rejected',()=>find(i=>i.opcode==='16'),(v,{i,f})=>{v[f.fileOffset+i.offset]=0x17;});
 altered('maxStack header change rejected',()=>y.bodyFacts.find(f=>(b[f.headerOffset]&3)===3),(v,f)=>v.writeUInt16LE(v.readUInt16LE(f.headerOffset+2)+1,f.headerOffset+2));
 altered('initLocals flag change rejected',()=>y.bodyFacts.find(f=>(b[f.headerOffset]&3)===3),(v,f)=>v.writeUInt16LE(v.readUInt16LE(f.headerOffset)^16,f.headerOffset));
 altered('method visibility flag change rejected',()=>y.bodyFacts[0],(v,f)=>v.writeUInt16LE(v.readUInt16LE(f.flagsOffset)^1,f.flagsOffset));
 altered('valid exception region boundary change rejected',()=>y.bodyFacts.find(f=>f.exceptionClauses>0),(v,f)=>{const sp=(f.fileOffset+f.ilBytes+3)&~3,fat=!!(v[sp]&64),e=sp+4;const old=fat?v.readUInt32LE(e+4):v.readUInt16LE(e+2);assert(old>0);if(fat)v.writeUInt32LE(0,e+4);else v.writeUInt16LE(0,e+2);});
 altered('exception catch type change rejected',()=>y.bodyFacts.find(f=>y.details.find(d=>d.name===f.name).exceptions.some(e=>e.flag===0)),(v,f)=>{const sp=(f.fileOffset+f.ilBytes+3)&~3,fat=!!(v[sp]&64),cs=fat?24:12;let e=sp+4;while((fat?v.readUInt32LE(e):v.readUInt16LE(e))!==0)e+=cs;const p=e+(fat?20:8),old=v.readUInt32LE(p),next=old===0x01000001?0x01000002:0x01000001;v.writeUInt32LE(next,p);});
 test('changed external member metadata rejected',()=>{const v=Buffer.from(b),key=Buffer.from('WriteLine\0'),p=v.indexOf(key);assert(p>=0);assert.equal(v.indexOf(key,p+1),-1);v[p+5]=88;assert.throws(()=>compare(v),/METADATA_DIFF/);});
 test('unknown instruction rejected by parser',()=>{const v=Buffer.from(b);v[y.bodyFacts[0].fileOffset]=0xff;assert.throws(()=>compare(v),/UNKNOWN_OPCODE/);});
 const rawSame=x.bodyFacts.filter((m,i)=>a.subarray(m.fileOffset,m.fileOffset+m.ilBytes).equals(b.subarray(y.bodyFacts[i].fileOffset,y.bodyFacts[i].fileOffset+y.bodyFacts[i].ilBytes))).length;
 test('raw and normalized counts reconcile',()=>{assert.equal(y.details.length,85);assert.equal(rawSame,59);assert.equal(summaries.filter(m=>m.normalizedSha256===m.baselineNormalizedSha256).length,84);assert.equal(y.calls.length,649);});
 test('truncated binary rejected',()=>assert.throws(()=>compare(b.subarray(0,64))));
 test('inputs unchanged after all memory-only cases',()=>{for(const [p,h] of pins)assert.equal(hash(fs.readFileSync(p)),h);});
 const scriptSha256=hash(fs.readFileSync(__filename));
 const report={schema:'codex-observer-fourth-mutant-complete-static/1',basisCommit:'fe87ada',caseId:'recapture',scriptSha256,parserSha256:PH,baselineSha256:BH,mutantSha256:MH,compileReceiptSha256:RH,checks:results.length,results,parserPatchAnchors:parser.patchAnchorHashes,methods:summaries,metadataRowsCompared:x.canonicalMetadata.map(t=>({table:t.table,rows:t.rows.length})),rawBodySame:rawSame,rawBodyDifferent:y.details.length-rawSame,normalizedUnchangedBodies:summaries.filter(m=>m.normalizedSha256===m.baselineNormalizedSha256).length,exactChangedBody:CAP,assemblyLoaded:false,productExecuted:false,compilerStarts:0,guardUnexpected:unexpected,staticCapabilityReviewPassed:true,executionApproved:false,limitations:['Fixed pair byte interpretation; not a general CLR verifier','MVID and method RVAs are layout/build identities excluded from equality','Does not prove runtime/framework transitive behavior','Expected captureBorrowed0 failure remains unexecuted']};
 report.ok=unexpected===0;report.exitCode=report.ok?0:1;const text=JSON.stringify(report,null,2)+'\n';if(args.length)fs.writeFileSync(out,text,{flag:'wx'});fs.writeSync(1,JSON.stringify({ok:report.ok,checks:results.length,normalizedUnchangedBodies:84,exactChangedBody:CAP,guardUnexpected:unexpected,productExecuted:false})+'\n');process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,checks:results.length,error:e.message})+'\n');process.exitCode=1;}
