'use strict';
// Read/hash only. Never executes csc, PowerShell, helper or a capability runner.
let blocked=0;
const deny=()=>{blocked++;throw new Error('OS_CAPABILITY_BLOCKED');};
const cp=require('node:child_process');for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const id of ['node:http','node:https','node:net','node:tls','node:dgram','node:dns']){const m=require(id);if(id==='node:net')m.Socket.prototype.connect=deny;if(id==='node:dns')for(const k of Object.keys(m.promises))if(typeof m.promises[k]==='function')m.promises[k]=deny;for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});}
globalThis.fetch=deny;
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT='C:\\Users\\30591\\Documents\\ChatGPT\\装修进度验收APP';
const FRAME='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const FILE=path.join(__dirname,'CodexL2固定编译配置-20261027.json');
const OUT=path.join(__dirname,'CodexL2编译配置只读核对-20261027.json');
const CONFIG_HASH='8da47fec7a91a4f48c14e69c34a22afab901203553be5498915f97beef6478e9';
const H=b=>crypto.createHash('sha256').update(b).digest('hex');
function need(v,code){if(!v)throw Object.assign(new Error(code),{code});}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
const results=[];
function check(name,fn){fn();results.push({name,passed:true});}
function validate(c){
  need(c.schema==='codex-l2-compile-config/1'&&c.executionAuthorized===false&&c.purpose==='compile-only-no-helper-execution','SCOPE');
  need(c.cwd===ROOT&&c.compiler.path===FRAME+'\\csc.exe','PROGRAM');
  need(c.references.length===2&&c.references[0].path===FRAME+'\\mscorlib.dll'&&c.references[1].path===FRAME+'\\System.dll','REFERENCES');
  need(c.outputRoot===ROOT+'\\artifacts\\psr-l2\\v1'&&c.outputFile===c.outputRoot+'\\psr-l2-helper.exe'&&c.tempRoot===c.outputRoot+'\\tmp'&&c.requiredRepoLocalExclude==='/artifacts/psr-l2/','OUTPUT');
  const args=['/nologo','/noconfig','/nostdlib+','/target:exe','/platform:x64','/langversion:5','/codepage:65001','/utf8output','/optimize+','/debug-','/warn:4','/warnaserror+','/errorreport:none','/nowin32manifest','/main:L2JobRunner','/reference:'+FRAME+'\\mscorlib.dll','/reference:'+FRAME+'\\System.dll','/out:'+c.outputFile,ROOT+'\\docs\\证据\\CodexL2进程树辅助层-20261027.cs'];
  need(same(c.args,args)&&c.source.path===args[args.length-1],'ARGUMENTS');
  need(same(c.spawn,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],timeoutMs:30000,reapMs:2000,maxCombinedOutputBytes:131072,maxDirectCompilerStarts:1,automaticRetry:false}),'LIMITS');
  need(same(c.childEnv,{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',PATH:FRAME,TEMP:c.tempRoot,TMP:c.tempRoot}),'ENVIRONMENT');
  need(same(c.postcheck,{exitCode:0,signal:null,stderrBytes:0,stdoutBytes:0,outputMachine:'AMD64',outputMagic:'PE32+',requiresClrHeader:true,maxOutputFileBytes:1048576,tempDirectoryMustBeEmpty:true,executeOutput:false,unfreezeL2:false}),'POSTCHECK');
}
function chain(file){let p=path.resolve(file);for(;;){try{const s=fs.lstatSync(p);need(!s.isSymbolicLink(),'LINK');}catch(e){if(e.code!=='ENOENT')throw e;}const up=path.dirname(p);if(up===p)break;p=up;}}
let report;
try{
  const args=process.argv.slice(2);need(args.length===0||args.length===2&&args[0]==='--out'&&path.resolve(args[1])===OUT,'CLI');
  if(args.length)need(!fs.existsSync(OUT),'OUTPUT_EXISTS');
  const raw=fs.readFileSync(FILE);check('configuration bytes pinned',()=>assert.equal(H(raw),CONFIG_HASH));const c=JSON.parse(raw);
  check('fixed configuration contract',()=>validate(c));check('fixed Node host',()=>assert.equal(process.execPath,c.host.path));
  const facts=[];for(const item of [c.host,c.compiler,c.compilerConfig,...c.references,c.source]){
    check('source '+path.basename(item.path),()=>{chain(item.path);const s=fs.lstatSync(item.path);need(s.isFile(),'SOURCE_TYPE');const b=fs.readFileSync(item.path);assert.equal(H(b),item.sha256);if(item.bytes)assert.equal(b.length,item.bytes);facts.push({path:item.path,bytes:b.length,sha256:H(b)});});
  }
  check('fresh output directory absent',()=>{chain(c.outputRoot);assert.equal(fs.existsSync(c.outputRoot),false);});
  check('source strict UTF-8',()=>{const b=fs.readFileSync(c.source.path);const s=new TextDecoder('utf-8',{fatal:true}).decode(b);assert(!s.includes('\ufffd'));});
  check('L2 gate remains closed',()=>assert(fs.readFileSync(path.join(__dirname,'CodexL2固定Node驱动-20261027.cjs'),'utf8').includes('const RELEASE = Object.freeze({ready:false, helperSha256:null});')));
  const variants=[['scope','SCOPE',x=>x.executionAuthorized=true],['compiler','PROGRAM',x=>x.compiler.path='csc.exe'],['extra reference','REFERENCES',x=>x.references.push(x.references[0])],['output escape','OUTPUT',x=>x.outputFile='C:\\elsewhere.exe'],['response file','ARGUMENTS',x=>x.args.push('@unapproved.rsp')],['implicit references','ARGUMENTS',x=>x.args=x.args.filter(a=>a!=='/nostdlib+')],['default response','ARGUMENTS',x=>x.args=x.args.filter(a=>a!=='/noconfig')],['wrong architecture','ARGUMENTS',x=>x.args[4]='/platform:anycpu'],['wrong encoding','ARGUMENTS',x=>x.args[6]='/codepage:936'],['shell','LIMITS',x=>x.spawn.shell=true],['retry','LIMITS',x=>x.spawn.automaticRetry=true],['timeout','LIMITS',x=>x.spawn.timeoutMs=60000],['output limit','LIMITS',x=>x.spawn.maxCombinedOutputBytes=262144],['environment injection','ENVIRONMENT',x=>x.childEnv.NODE_OPTIONS='synthetic'],['automatic run','POSTCHECK',x=>x.postcheck.executeOutput=true],['unlock','POSTCHECK',x=>x.postcheck.unfreezeL2=true]];
  for(const [name,code,mutate]of variants)check('reject '+name,()=>{const x=JSON.parse(JSON.stringify(c));mutate(x);assert.throws(()=>validate(x),e=>e.code===code);});
  // All source reads and digests precede final verdict. No policy/ACL/identity query.
  const digests={configuration:H(fs.readFileSync(FILE)),script:H(fs.readFileSync(__filename))};
  report={schema:'codex-l2-compile-readonly/1',basisCommit:'5dc07f7',checks:results.length,results,sourceFacts:facts,digests,guardUnexpected:blocked,compilerStarted:false,helperStarted:false,outputCreated:false,actualTransport:false,scope:'filesystem-and-config-only',limitations:['C# not compiled; command options not dynamically accepted','OS process descendants not measured','Git ignore absence separately checked by fixed git check-ignore; repo-local exclusion pending','Framework runtime dependency closure not fully pinned']};
  report.ok=blocked===0;report.exitCode=report.ok?0:1;
  const text=JSON.stringify(report,null,2)+'\n';fs.writeSync(1,JSON.stringify({ok:report.ok,checks:report.checks,guardUnexpected:blocked})+'\n');if(args.length)fs.writeFileSync(OUT,text,{flag:'wx'});process.exitCode=report.exitCode;
}catch(e){fs.writeSync(1,JSON.stringify({ok:false,checks:results.length,guardUnexpected:blocked,reason:e.code||'LOCAL_REVIEW_FAILED'})+'\n');process.exitCode=1;}
