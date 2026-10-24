'use strict';
// 仅内存合成复核81bfac3：不运行受审证据的真实OS查询、不读私密根、不运行DPAPI/UI。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const TARGET = path.join(ROOT, 'docs/证据/CodeBuddy本地编码模块兼容返修-20261024.cjs');
const LOCAL = 'miniapp/scripts/lib/participant-local-tools.cjs';
const DECODER = 'miniapp/scripts/lib/participant-native-decoder.cjs';
const hits = []; let phase = 'probe';
require(path.join(ROOT, 'miniapp/tests/helpers/psr-guard-runner.cjs'))
  .installParentGuardsWithLocalTools({hits, getPhase: () => phase, allowedScripts: []});
assert.throws(() => require('node:https').request('https://synthetic.invalid'));
assert.throws(() => require('node:child_process').execSync('synthetic-never-executed'));
phase = 'review';
const fixture = require(path.join(ROOT, 'miniapp/tests/helpers/psr-repair-fixtures.cjs'));
const decoder = require(path.join(ROOT, DECODER));
const source = fs.readFileSync(TARGET, 'utf8');
const root = path.join(ROOT, 'artifacts/schedule-sandbox/.participant-private');
const gb = Buffer.from([0xd2,0xd1,0xb3,0xc9,0xb9,0xa6,0xb4,0xa6,0xc0,0xed]); // 已成功处理
const gbTail = Buffer.concat([gb, Buffer.from(' 1 '), Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe]),
  Buffer.from('; '), Buffer.from([0xb4,0xa6,0xc0,0xed]), Buffer.from(' 0 '),
  Buffer.from([0xb8,0xf6,0xce,0xc4,0xbc,0xfe,0xca,0xb1,0xca,0xa7,0xb0,0xdc])]);
const readable = new Set([TARGET, ...[LOCAL, DECODER, 'miniapp/scripts/lib/participant-private-store.cjs'].map(p => path.join(ROOT,p))]);
let mockedQueries = 0, mockedGit = 0;
function runEvidence(mode) {
  let stdout = '', stderr = '', calls = 0, gitCalls = 0;
  const proc = {env: {}, version: process.version, argv: ['node', TARGET], exitCode: 0,
    stdout: {write(s) {stdout += s;}}, stderr: {write(s) {stderr += s;}}};
  const fakeFs = {
    statSync(p) {assert.ok(p === root || /^C:\\Windows\\System32\\/.test(p)); return {isFile:()=>p!==root,isDirectory:()=>p===root};},
    existsSync(p) {assert.equal(p, root); return true;},
    readFileSync(p, ...args) {assert.ok(readable.has(p), '只读受审源码'); return fs.readFileSync(p,...args);},
    writeFileSync() {throw Error('禁止VM落盘');}
  };
  const fakeCp = {
    spawnSync(exe,args,opts) {
      calls++; mockedQueries++;
      assert.equal(opts.shell,false); assert.equal(opts.encoding,undefined);
      assert.equal(opts.timeout,10000); assert.equal(opts.maxBuffer,128*1024);
      if(exe.endsWith('powershell.exe')) return {status:0,stdout:Buffer.from(mode==='codepage65001'?'OEM=65001 ANSI=1252':'OEM=936 ANSI=936'),stderr:Buffer.alloc(0)};
      if(exe.endsWith('whoami.exe')) {assert.deepEqual(Array.from(args),['/user','/fo','csv','/nh']);return {status:mode==='whoamiFailure'?1:0,stdout:Buffer.from('"synthetic\\current","'+fixture.sid+'"'),stderr:mode==='whoamiFailure'?Buffer.from('synthetic error'):Buffer.alloc(0)};}
      assert.ok(exe.endsWith('icacls.exe')); assert.equal(args[0],root);
      const tail = mode==='asciiContractUnknown'?Buffer.from('Successfully processed 1 files; Failed processing 0 files'):gbTail;
      return {status:mode==='aclFailure'?1:0,
        ...(mode==='aclTimeout'?{error:Error('synthetic timeout'),signal:'SIGTERM'}:{}),
        stdout:Buffer.concat([Buffer.from('synthetic '+fixture.sid+':(F)\n'),tail]),
        stderr:mode==='aclFailure'?Buffer.from('synthetic failure'):Buffer.alloc(0)};
    },
    execFileSync(exe,args) {assert.equal(exe,'git'); assert.equal(Array.from(args).join(' '),'diff --name-only 3d8d515 HEAD'); mockedGit++;gitCalls++;return '';}
  };
  let s=source;
  const before=hits.length;
  if(mode==='caughtNetwork') s=s.replace("'use strict';", "'use strict'; try { require('node:https').request('https://synthetic.invalid'); } catch (_) {}");
  vm.runInNewContext(s,{require(n){if(n==='node:fs')return fakeFs;if(n==='node:child_process')return fakeCp;
    if(['node:path','node:crypto','node:assert/strict','node:https'].includes(n))return require(n);
    assert.equal(n,path.join(ROOT,DECODER));return decoder;},
    __dirname:path.dirname(TARGET),__filename:TARGET,process:proc,Buffer,TextDecoder}, {timeout:5000});
  assert.equal(stderr,''); const report=JSON.parse(stdout);
  return {ok:report.ok,exit:proc.exitCode||0,spawnCalls:calls,gitCalls,
    observedOperations:calls+gitCalls,reportedFixedQueries:report.results.find(r=>r.id==='S5_fixed_readonly_command_count').actual.totalFixedReadonly,
    encoding:report.contractTable.find(r=>r.command==='icacls.exe <路径>').encoding,
    outerGuardHits:hits.length-before};
}
const results=[];
for(const mode of ['normal','whoamiFailure','aclFailure','aclTimeout','codepage65001','asciiContractUnknown','caughtNetwork']) {
  phase=mode==='caughtNetwork'?'sensitivity':'review';
  const result=runEvidence(mode);assert.equal(result.ok,true);assert.equal(result.exit,0);
  assert.equal(result.observedOperations,4);assert.equal(result.reportedFixedQueries,3);
  if(mode==='caughtNetwork')assert.equal(result.outerGuardHits,1);else assert.equal(result.outerGuardHits,0);
  if(mode==='asciiContractUnknown')assert.equal(result.encoding,'无法确认');
  results.push({mode,...result});
}
phase='review';
// 真实local-tools→真实store，进程与FS为纯合成替身，不再在store入口跳过解码。
const chains=[];
for(const mode of ['utf8Misdecoded','replacementCharacter']) {
  const h=fixture.createPrivateHarness();let calls=0;
  const nameBytes=mode==='utf8Misdecoded'?Buffer.from('中文'):Buffer.from([0x84,0x31,0xa4,0x37]);
  const name=Buffer.concat([Buffer.from('synthetic\\'),nameBytes]);
  const local=fixture.load(LOCAL,{
    'node:fs':{statSync:()=>({isFile:()=>true})},
    'node:child_process':{spawnSync(exe,args){calls++;
      const stdout=exe.endsWith('whoami.exe')?Buffer.concat([Buffer.from('"'),name,Buffer.from('","'+fixture.sid+'"')]):
        Buffer.concat([Buffer.from(args[0]+' '),name,Buffer.from(':(F)\nSuccessfully processed 1 files; Failed processing 0 files')]);
      return {status:0,stdout,stderr:Buffer.alloc(0)};}}
  });
  h.tools.queryIdentity=local.queryIdentity; h.tools.queryAcl=local.queryAcl;
  assert.doesNotThrow(()=>h.store.validatePrivateTarget({repoRoot:ROOT,relativePath:h.store.PRIVATE_ROOT_REL+'/synthetic.bin'}));
  assert.equal(h.mem.size,0);assert.equal(h.calls.includes('write'),false);assert.equal(h.calls.includes('protect'),false);
  const decoded=decoder.decodeNative(nameBytes);
  if(mode==='utf8Misdecoded')assert.notEqual(decoded,'中文');else assert.equal(decoded,'\ufffd');
  chains.push({mode,accepted:true,processStubCalls:calls,decodedIncorrectly:mode==='utf8Misdecoded',containsReplacement:decoded.includes('\ufffd'),writes:0,protects:0});
}
assert.equal(decoder.decodeUtf8Strict(Buffer.from('\ufffd')),'\ufffd');
const probes=hits.filter(h=>h.phase==='probe').length;
const sensitivities=hits.filter(h=>h.phase==='sensitivity').length;
const unexpected=hits.filter(h=>!['probe','sensitivity'].includes(h.phase)).length;
assert.equal(probes,2);assert.equal(sensitivities,1);assert.equal(unexpected,0);
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,p))).digest('hex');
const report={schema:'codex-local-compat-review/1',reviewedCommit:'81bfac3',reviewedBaseline:'3d8d515',
  runtimeDigests:Object.fromEntries([LOCAL,DECODER,path.relative(ROOT,TARGET)].map(p=>[p,sha(p)])),
  evidenceVm:results,actualLocalToolsStoreChains:chains,utf8LiteralReplacementAccepted:true,
  accounting:{probes,sensitivities,unexpected,total:hits.length,mockedQueries,mockedGit,realOsQueries:0,dpapi:0,cloud:0},
  limitations:['全部为合成字节/进程/FS替身，未重跑原证据的真实系统命令。','ok仅表示所列反例已复现，不代表产品或编码契约通过。'],
  ok:unexpected===0};
const body=JSON.stringify(report,null,2)+'\n';
if(process.argv.length===2)process.stdout.write(body);
else if(process.argv.length===4&&process.argv[2]==='--out')fs.writeFileSync(path.resolve(process.argv[3]),body,{flag:'wx'});
else throw Error('usage: node script [--out new-path]');
process.exitCode=report.ok?0:1;
