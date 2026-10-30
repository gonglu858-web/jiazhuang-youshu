'use strict';
// Read bytes only. No assembly loading; semantic body comparison remains pending.
let hits=0;const deny=()=>{hits++;throw Error('READONLY_OS_BLOCKED');};
for(const id of ['node:child_process','node:http','node:https','node:tls','node:dgram','node:dns']){const m=require(id);for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
const net=require('node:net');net.Socket.prototype.connect=deny;net.connect=net.createConnection=net.createServer=deny;globalThis.fetch=deny;
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),ROOT=path.resolve(__dirname,'../..');
const BASE=path.join(ROOT,'artifacts/psr-l2/observer-synthetic-v2-baseline'),MUT=path.join(ROOT,'artifacts/psr-l2/observer-synthetic-v2-recapture');
const parserPath=path.join(__dirname,'CodexL2观察器托管能力只读v1-20261029.cjs'),receiptPath=path.join(__dirname,'CodexL2观察器单次编译v2-recapture-20261029.json');
function chain(p){for(;;){assert(!fs.lstatSync(p).isSymbolicLink());const up=path.dirname(p);if(up===p)break;p=up;}}
try{
 const args=process.argv.slice(2),out=__filename.replace(/cjs$/,'json');assert(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===out);if(args.length)assert(!fs.existsSync(out));
 const parser=fs.readFileSync(parserPath);assert.equal(hash(parser),'474d8aebdcc7f686440ac5587ec94bf0def67a5cc6f104b8b3d27d91dfa7d8db');
 const src=parser.toString('utf8'),start=src.indexOf('function inspect(b){'),end=src.indexOf('\nconst POLICY=',start);assert(start>=0&&end>start);
 const inspect=vm.runInNewContext('('+src.slice(start,end).trim()+')',{assert,Buffer,TextDecoder},{timeout:2000});
 const ap=path.join(BASE,'observer-test.exe'),bp=path.join(MUT,'observer-test.exe');for(const p of [parserPath,receiptPath,ap,bp,path.join(MUT,'tmp')])chain(p);
 const a=fs.readFileSync(ap),b=fs.readFileSync(bp),rb=fs.readFileSync(receiptPath),receipt=JSON.parse(rb);
 assert.equal(hash(a),'d6c3fdfca6893ede87afb8c866dbc637c5c45e36def2ac8140266d08b3ba215b');assert.equal(hash(b),'381886fd26286256c43997275162eaee3080470cb90084d2b2bd1e515a074b5d');
 assert(receipt.ok&&receipt.compilerStarts===1&&receipt.compiler.closed&&receipt.compiler.exitCode===0&&receipt.guardUnexpected===0&&!receipt.productExecuted);assert.equal(receipt.output.sha256,hash(b));
 assert.deepEqual(fs.readdirSync(MUT).sort(),['fixture.cs','observer-test.exe','observer.cs','tmp']);assert.deepEqual(fs.readdirSync(path.join(MUT,'tmp')),[]);
 const original=fs.readFileSync(path.join(BASE,'observer.cs'),'utf8'),mutant=fs.readFileSync(path.join(MUT,'observer.cs'),'utf8'),before='if(m.State!="UNKNOWN")return;',after='if(m.Pid==0)return;';assert.equal(original.split(before).length,2);assert.equal(mutant,original.replace(before,after));assert.equal(hash(Buffer.from(mutant)),'faa7b51fa66cfc9a98a2e91572cb46d55c335ec44766a1e1442f6a6bd2f8a1a3');assert(fs.readFileSync(path.join(BASE,'fixture.cs')).equals(fs.readFileSync(path.join(MUT,'fixture.cs'))));
 const x=inspect(a),y=inspect(b),plain=v=>JSON.parse(JSON.stringify(v));assert.equal(y.bodyFacts.length,85);assert.equal(y.calls.length,649);assert.equal(y.entry,x.entry);assert.equal(y.implMapRows+y.moduleRefRows,0);
 for(const k of ['assemblies','types','typeSpecs','methodSpecs','locals'])assert.deepEqual(plain(y[k]),plain(x[k]));
 const normalizedRefs=r=>r.map(({token,...v})=>JSON.stringify(v)).sort();assert.deepEqual(normalizedRefs(plain(x.refs)),normalizedRefs(plain(y.refs)));
 const normalizeCall=({token,...v})=>v;const expected=x.calls.filter(v=>!(v.caller==='L2MemberObserver::Capture'&&v.offset===11)).map(v=>({...normalizeCall(v),offset:v.caller==='L2MemberObserver::Capture'?v.offset-10:v.offset}));assert.deepEqual(plain(y.calls.map(normalizeCall)),plain(expected));
 const changed=[];let unchanged=0;for(let i=0;i<x.bodyFacts.length;i++){const m=x.bodyFacts[i],n=y.bodyFacts[i];assert.equal(m.name,n.name);const u=a.subarray(m.fileOffset,m.fileOffset+m.ilBytes),v=b.subarray(n.fileOffset,n.fileOffset+n.ilBytes);if(u.equals(v))unchanged++;else changed.push({method:m.name,baseBytes:u.length,mutantBytes:v.length,baseHash:hash(u),mutantHash:hash(v)});}
 const capture=changed.find(v=>v.method==='L2MemberObserver::Capture');assert(capture&&capture.baseBytes===415&&capture.mutantBytes===405);
 assert.equal(hash(fs.readFileSync(ap)),hash(a));assert.equal(hash(fs.readFileSync(bp)),hash(b));assert(fs.readFileSync(receiptPath).equals(rb));
 const report={schema:'codex-observer-fourth-mutant-initial-readonly/1',basisCommit:'bea32ea',caseId:'recapture',scriptSha256:hash(fs.readFileSync(__filename)),parserSha256:hash(parser),compileReceiptSha256:hash(rb),baselineSha256:hash(a),mutantSha256:hash(b),methods:85,calls:649,referenceSetEqualIgnoringTokens:true,normalizedCallDeltaMatched:true,unchangedBodies:unchanged,changedBodies:changed,assemblyLoaded:false,productExecuted:false,compilerStartsThisInspector:0,guardUnexpected:hits,staticCapabilityReviewPassed:false,executionApproved:false,pending:'Complete instruction/operand comparison, including field/string/member token renumbering, branch targets and exception regions; normalized call targets alone are insufficient'};
 report.ok=hits===0;report.exitCode=report.ok?0:1;if(args.length)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});fs.writeSync(1,JSON.stringify({ok:report.ok,methods:85,calls:649,unchangedBodies:unchanged,changedBodies:changed.length,staticCapabilityReviewPassed:false,productExecuted:false,guardUnexpected:hits})+'\n');process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,error:e.message})+'\n');process.exitCode=1;}
