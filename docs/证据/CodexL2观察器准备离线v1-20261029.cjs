'use strict';
// Tests JS transformation, NOT C# execution. All output is synthetic preparation evidence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
let hits=0;const deny=()=>{hits++;throw Error('OFFLINE_BOUNDARY');};
const vm=require('node:vm');
const transformerBytes=fs.readFileSync(path.join(__dirname,'CodexL2观察器合成准备v1-20261028.cjs'));
const mod={exports:{}};const ctx={module:mod,Buffer,require:n=>n==='node:crypto'?Object.freeze({createHash:crypto.createHash}):deny(),fetch:deny};
vm.runInNewContext(transformerBytes.toString(),ctx,{timeout:1000});
const {transform,SOURCE_SHA}=mod.exports;
const results=[];function test(name,f){try{f();results.push({name,passed:true});}catch{results.push({name,passed:false});}}
const source=fs.readFileSync(path.join(__dirname,'CodexL2成员观察器v3-20261028.cs'));
const fixture=fs.readFileSync(path.join(__dirname,'CodexL2观察器合成夹具v1-20261028.cs'));
let generated;
test('transform pinned source',()=>{generated=transform(source);assert.equal(generated.edits.length,12);});
test('roundtrip source byte equality',()=>{let s=generated.source;for(const e of [...generated.edits].reverse())s=s.slice(0,e.start)+e.before+s.slice(e.start+e.after.length);assert.deepEqual(Buffer.from(s),source);});
test('deterministic transform',()=>assert.deepEqual(transform(source),generated));
for(const [name,b] of [['comment drift',Buffer.concat([source,Buffer.from('//x')])],['algorithm drift',Buffer.from(source.toString().replace('OrdinalIgnoreCase','Ordinal'))],['newline drift',Buffer.from(source.toString().replace(/\r\n/g,'\n'))],['empty',Buffer.alloc(0)]])test(name,()=>assert.throws(()=>transform(b),/SOURCE_DRIFT/));
test('non buffer rejected',()=>assert.throws(()=>transform(source.toString()),/SOURCE_DRIFT/));
test('no native declaration remains',()=>assert(!/DllImport|static extern|Marshal\.GetLastWin32Error/.test(generated.source)));
test('real logic suffix preserved',()=>assert.equal(generated.source.slice(generated.source.indexOf('  sealed class Member')),source.toString().slice(source.toString().indexOf('  sealed class Member')).replace('Marshal.GetLastWin32Error()','SyntheticBoundary.LastError()')));
test('classification preserved',()=>{const cut=s=>s.slice(s.indexOf('  static string ClassifyPath'),s.indexOf('  const int MemberLimit'));assert.equal(cut(generated.source),cut(source.toString()));});
test('fixture prohibited source tokens absent',()=>assert(!/DllImport|Process\.Start|File\.|Directory\.|WebRequest|HttpClient|Socket|Assembly\.Load|Reflection|Activator/.test(fixture.toString())));
for(const name of ['CaptureCase','CensusFailure','QueueFailure','FinalFailure','PortCases','ExitBeforeNew','Limits','OwnedCases','RootException'])test('fixture has '+name,()=>assert(fixture.toString().includes('static void '+name+'(')));
test('compile and execution remain false',()=>{assert.equal(generated.compiled,false);assert.equal(generated.executed,false);});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={schema:'codex-observer-preparation-offline/1',basisCommit:'176aa35',checks:results.length,results,sourceSha256:SOURCE_SHA,generatedSha256:generated&&generated.generatedSha256,fixtureSha256:hash(fixture),transformerSha256:hash(fs.readFileSync(path.join(__dirname,'CodexL2观察器合成准备v1-20261028.cjs'))),testSha256:hash(fs.readFileSync(__filename)),unexpected:hits,csharpCompiled:false,csharpExecuted:false,matrixComplete:false,limitations:['Static fixture checks are not C# compilation or behavior proof','Remaining matrix and mutation sensitivity require completion before compiler configuration'],ok:results.every(r=>r.passed)&&hits===0};
const args=process.argv.slice(2);if(args.length){assert.deepEqual(args,['--out',path.join(__dirname,'CodexL2观察器准备离线v1-20261029.json')]);fs.writeFileSync(args[1],JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=report.ok?0:1;
