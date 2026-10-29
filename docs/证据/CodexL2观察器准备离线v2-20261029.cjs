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
const fixture=fs.readFileSync(path.join(__dirname,'CodexL2观察器合成夹具v2-20261029.cs'));
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
for(const name of ['CaptureCase','CensusFailure','QueueFailure','FinalFailure','PortCases','ExitBeforeNew','Limits','OwnedCases','RootException','TwoMembers','ZeroTotal','PortMissing','ImageException','PathThroughCapture'])test('fixture has '+name,()=>assert(fixture.toString().includes('static void '+name+'(')));
test('compile and execution remain false',()=>{assert.equal(generated.compiled,false);assert.equal(generated.executed,false);});
const f=fixture.toString();
test('two member real chain',()=>{for(const token of ['o.Root(100,new IntPtr(500))','s.Ids=new long[]{100,101}','o.Stop(2)','o.members[100].ExitSeen&&o.members[101].ExitSeen'])assert(f.includes(token));});
test('independent handle ledger',()=>{for(const token of ['Owned.Add(900)','Owned.Add(501)','Owned.Contains(h)&&CloseAttempts.Add(h)','Owned.SetEquals(SyntheticBoundary.CloseAttempts)','CloseFailures.Add(h)'])assert(f.includes(token));});
test('no duplicate switch labels',()=>{for(const part of f.matchAll(/switch\(mode\)\{([\s\S]*?)\n    \}/g)){const keys=[...part[1].matchAll(/case (\d+):/g)].map(m=>m[1]);assert.equal(new Set(keys).size,keys.length);}});
test('72 planned case instances',()=>{assert.equal(1+14*2+9+7+6+4+1+2+7+1+6,72);assert(f.includes('CaseResults.Count==72'));for(const token of ['i<=13','i<9','i<7','i<6','i<4','i<2'])assert(f.includes(token));});
test('per case failure stops and final exit derives ok',()=>{assert(f.includes('if(!Case(name,action))throw'));assert(f.includes('return ok?0:1;'));assert(f.includes('remainingSteps'));});
const mutantBytes=fs.readFileSync(path.join(__dirname,'CodexL2观察器敏感变体准备v1-20261029.cjs'));
const mm={exports:{}};vm.runInNewContext(mutantBytes.toString(),{module:mm,require:ctx.require},{timeout:1000});let mutants;
test('four fixed in-memory mutants',()=>{mutants=mm.exports.prepare(generated.source);assert.equal(mutants.length,4);assert.equal(new Set(mutants.map(m=>m.sha256)).size,4);});
for(const id of ['caseSensitive','finalIdentity','borrowedClose','recapture'])test('mutant '+id,()=>{const m=mutants.find(x=>x.id===id);assert(m);assert.notEqual(m.source,generated.source);assert.equal(m.expectedExitCode,1);assert.equal(m.compiled,false);assert.equal(m.executed,false);assert(!/DllImport|static extern/.test(m.source));});
test('mutant source drift rejected',()=>assert.throws(()=>mm.exports.prepare(generated.source+' '),/BASE_DRIFT/));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={schema:'codex-observer-preparation-offline/2',basisCommit:'0dc3df4',checks:results.length,results,sourceSha256:SOURCE_SHA,generatedSha256:generated&&generated.generatedSha256,fixtureSha256:hash(fixture),transformerSha256:hash(transformerBytes),mutantBuilderSha256:hash(mutantBytes),testSha256:hash(fs.readFileSync(__filename)),mutants:(mutants||[]).map(m=>({id:m.id,sha256:m.sha256,expectedFirstFailure:m.expectedFirstFailure,expectedExitCode:m.expectedExitCode})),unexpected:hits,csharpCompiled:false,csharpExecuted:false,plannedCsharpCases:72,mutationSensitivityExecuted:false,limitations:['Static fixture checks are not C# compilation or behavior proof','Four mutation failures are predictions pending compiled execution','No binary capability audit performed'],ok:results.every(r=>r.passed)&&hits===0};
const args=process.argv.slice(2);if(args.length){assert.deepEqual(args,['--out',path.join(__dirname,'CodexL2观察器准备离线v2-20261029.json')]);fs.writeFileSync(args[1],JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=report.ok?0:1;
