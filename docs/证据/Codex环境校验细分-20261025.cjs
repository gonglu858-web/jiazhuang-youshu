'use strict';
// One fixed environment query only. Same query and acceptance predicate as the
// pinned A driver; diagnostic output contains booleans/counts/fixed labels only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const cp=require('node:child_process'),net=require('node:net');
const REPO=path.resolve(__dirname,'../..');
const BASIS='Codex本机合成预检恢复A-20261025.cjs';
const BASIS_SHA='629f1170ad0a2e2ea09f7059ed564488032439db0cdb6f4cee5cd96fb18f01f7';
const DECODER='miniapp/scripts/lib/participant-native-decoder.cjs';
const DECODER_SHA='462976b3cf32999fb0079d6b0bbb4cf54cd35ab3d1068fb1052db36f4c05f7d3';
const NODE='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const NODE_SHA='c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19';
const PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const POLICY=['Undefined','Restricted','AllSigned','RemoteSigned','Unrestricted','Bypass','Default'];
const SCOPE=['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'];
const state={probes:0,unexpected:0,attempts:[]};
let probing=false,outPath=null,rawOutput=null,used=false;
const start=Date.now(),rawSync=cp.spawnSync;
function fail(code){throw Object.assign(new Error(code),{code});}
function need(v,code){if(!v)fail(code);}
function deny(){if(probing)state.probes++;else state.unexpected++;fail('LOCAL_CAPABILITY_BLOCKED');}
for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const mod of [require('node:http'),require('node:https'),require('node:tls'),require('node:dns'),require('node:dns').promises])
  for(const k of Object.keys(mod))if(typeof mod[k]==='function')Object.defineProperty(mod,k,{value:deny,configurable:true});
net.connect=net.createConnection=net.createServer=deny;net.Socket.prototype.connect=deny;globalThis.fetch=deny;
const report={schema:'codex-environment-diagnostic/1',basisCommit:'95097a7',recordedAt:new Date().toISOString(),
  scope:'one fixed environment query only; no identity/ACL/private directory/product actions',
  observations:state,diagnosisCompleted:false,environmentAccepted:false,fullPreflightPassed:false,
  phases:{identity:'not-run',acl:'not-run',DPAPI:'not-run',UI:'not-run'},ok:false};
// Deliberately identical acceptance expression, including its implicit version
// conversion. Do not silently tighten/relax the previous driver's contract.
function legacyAccepted(v){try{return !!(v&&same(Object.keys(v).sort(),['schema','version','effectivePolicy','policies','nodeCandidateCount','selectedNodeMatches'].sort())&&
  v.schema==='psr-local-environment/1'&&/^\d+(\.\d+){1,3}$/.test(v.version)&&POLICY.includes(v.effectivePolicy)&&
  v.selectedNodeMatches===true&&Number.isSafeInteger(v.nodeCandidateCount)&&v.nodeCandidateCount>0&&v.nodeCandidateCount<=64&&
  Array.isArray(v.policies)&&v.policies.length===5&&new Set(v.policies.map(p=>p.scope)).size===5&&
  v.policies.every(p=>same(Object.keys(p).sort(),['policy','scope'])&&SCOPE.includes(p.scope)&&POLICY.includes(p.policy)));}catch(_){return false;}}
function diagnose(buffer,decoder){
  const d={utf8Decoded:false,jsonParsed:false,checks:{},counts:{},failureLabels:[],accepted:false};
  let text,v;
  try{text=decoder.decodeUtf8Strict(buffer);d.utf8Decoded=true;}catch(_){d.failureLabels.push('UTF8_STRICT_FAILED');return d;}
  try{v=JSON.parse(text);d.jsonParsed=true;}catch(_){d.failureLabels.push('JSON_PARSE_FAILED');return d;}finally{text=null;}
  const attempt=fn=>{try{return !!fn();}catch(_){return false;}};
  const checks={
    rootKeys:()=>v&&same(Object.keys(v).sort(),['schema','version','effectivePolicy','policies','nodeCandidateCount','selectedNodeMatches'].sort()),
    schema:()=>v.schema==='psr-local-environment/1',version:()=>/^\d+(\.\d+){1,3}$/.test(v.version),
    effectivePolicy:()=>POLICY.includes(v.effectivePolicy),selectedNodeMatches:()=>v.selectedNodeMatches===true,
    nodeCandidateCount:()=>Number.isSafeInteger(v.nodeCandidateCount)&&v.nodeCandidateCount>0&&v.nodeCandidateCount<=64,
    policiesArray:()=>Array.isArray(v.policies),policyCount:()=>Array.isArray(v.policies)&&v.policies.length===5,
    uniqueScopes:()=>Array.isArray(v.policies)&&new Set(v.policies.map(p=>p.scope)).size===5,
    policyRowKeys:()=>Array.isArray(v.policies)&&v.policies.every(p=>same(Object.keys(p).sort(),['policy','scope'])),
    scopeEnum:()=>Array.isArray(v.policies)&&v.policies.every(p=>SCOPE.includes(p.scope)),
    policyEnum:()=>Array.isArray(v.policies)&&v.policies.every(p=>POLICY.includes(p.policy))};
  const labels=['ROOT_KEYS','SCHEMA','VERSION_FORMAT','EFFECTIVE_POLICY_ENUM','NODE_FIRST_MATCH','NODE_COUNT','POLICIES_ARRAY','POLICY_COUNT','SCOPE_UNIQUENESS','POLICY_ROW_KEYS','SCOPE_ENUM','POLICY_ENUM'];
  Object.entries(checks).forEach(([k,fn],i)=>{d.checks[k]=attempt(fn);if(!d.checks[k])d.failureLabels.push(labels[i]);});
  d.checks.selectedNodeIsBoolean=attempt(()=>typeof v.selectedNodeMatches==='boolean');
  d.counts.nodeCandidates=attempt(()=>Number.isSafeInteger(v.nodeCandidateCount)&&v.nodeCandidateCount>=0&&v.nodeCandidateCount<=64)?v.nodeCandidateCount:null;
  d.counts.policyRows=attempt(()=>Array.isArray(v.policies)&&v.policies.length<=64)?v.policies.length:null;
  d.accepted=legacyAccepted(v);
  need(d.accepted===(d.failureLabels.length===0),'DIAGNOSTIC_PREDICATE_MISMATCH');v=null;return d;
}
// No arbitrary script/argument/options entry point; invoked once after all pins.
function fixedQuery(meta){
  if(used)return deny();used=true;const remaining=60000-(Date.now()-start);need(remaining>0,'BUDGET_EXHAUSTED');
  const env={...process.env};delete env.NODE_OPTIONS;
  const a={attempted:true,completed:false,status:null,signal:false,launchError:false,stdoutBytes:null,stderrBytes:null,timeoutMs:Math.min(10000,remaining)};state.attempts.push(a);
  let r;try{r=rawSync(PS,['-NoProfile','-NonInteractive','-Command',meta],{cwd:REPO,windowsHide:true,shell:false,env,timeout:a.timeoutMs,maxBuffer:128*1024});}
  catch(_){a.completed=true;a.launchError=true;fail('ENVIRONMENT_QUERY_FAILED');}
  a.completed=true;a.status=Number.isInteger(r?.status)?r.status:null;a.signal=!!r?.signal;a.launchError=!!r?.error;
  a.stdoutBytes=Buffer.isBuffer(r?.stdout)?r.stdout.length:null;a.stderrBytes=Buffer.isBuffer(r?.stderr)?r.stderr.length:null;
  need(r&&!r.error&&!r.signal&&r.status===0&&Buffer.isBuffer(r.stdout)&&Buffer.isBuffer(r.stderr)&&r.stdout.length<=128*1024&&r.stderr.length===0,'ENVIRONMENT_QUERY_FAILED');
  return r.stdout;
}
try{
  const argv=process.argv.slice(2);need(argv.length===0||(argv.length===2&&argv[0]==='--out'&&argv[1]),'ARGUMENT_INVALID');
  if(argv.length){const p=path.resolve(argv[1]);need(path.dirname(p)===__dirname&&path.basename(p)==='Codex环境校验细分-20261025.json','OUTPUT_BOUNDARY');
    need(!fs.lstatSync(__dirname).isSymbolicLink(),'OUTPUT_BOUNDARY');let exists=false;try{fs.lstatSync(p);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}need(!exists,'OUTPUT_EXISTS');outPath=p;}
  probing=true;try{cp.execSync('synthetic-denied');}catch(_){}try{require('node:https').request('https://synthetic.invalid');}catch(_){}probing=false;need(state.probes===2,'GUARD_PROBE_FAILED');
  const basis=fs.readFileSync(path.join(__dirname,BASIS));need(hash(basis)===BASIS_SHA,'BASIS_DRIFT');
  const match=basis.toString('utf8').match(/^const META = (".*");$/m);need(match,'QUERY_NOT_FOUND');const meta=JSON.parse(match[1]);
  report.querySha256=hash(meta);report.basisScriptSha256=BASIS_SHA;
  const b=fs.readFileSync(path.join(REPO,DECODER));need(hash(b)===DECODER_SHA,'DECODER_DRIFT');report.decoderSha256=DECODER_SHA;
  need(process.execPath===NODE&&hash(fs.readFileSync(NODE))===NODE_SHA,'NODE_DRIFT');report.actualNodeMatchesPin=true;
  for(const file of [NODE,PS]){const st=fs.lstatSync(file);need(st.isFile()&&!st.isSymbolicLink(),'TOOL_PATH_INVALID');}
  report.powershellSha256=hash(fs.readFileSync(PS));
  const m={exports:{}};vm.runInNewContext('(function(module){'+b.toString('utf8')+'\n})',{Buffer,TextDecoder},{timeout:1000})(m);
  need(state.unexpected===0,'LOCAL_CAPABILITY_BLOCKED');
  rawOutput=fixedQuery(meta);report.diagnostic=diagnose(rawOutput,m.exports);report.diagnosisCompleted=true;
  report.environmentAccepted=report.diagnostic.accepted;
  if(!report.environmentAccepted)report.failureCode='ENVIRONMENT_PARSE_FAILED';
}catch(e){probing=false;report.failureCode=typeof e.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:'DIAGNOSTIC_UNCERTAIN';}
finally{
  if(rawOutput)rawOutput.fill(0);rawOutput=null;
  try{report.scriptSha256=hash(fs.readFileSync(__filename));}catch(_){report.failureCode='DIGEST_FAILED';report.environmentAccepted=false;}
  report.elapsedMs=Date.now()-start;
  if(state.unexpected){report.failureCode='LOCAL_CAPABILITY_BLOCKED';report.environmentAccepted=false;}
  if(report.elapsedMs>60000){report.failureCode='BUDGET_EXHAUSTED';report.environmentAccepted=false;}
  report.ok=report.diagnosisCompleted&&report.environmentAccepted&&!report.failureCode;
  report.exitCode=report.ok?0:state.unexpected||report.failureCode==='DIAGNOSTIC_PREDICATE_MISMATCH'?1:2;
  try{const s=JSON.stringify(report,null,2)+'\n';if(outPath)fs.writeFileSync(outPath,s,{flag:'wx'});process.stdout.write(s);process.exitCode=report.exitCode;}
  catch(_){process.stdout.write('{"ok":false,"failureCode":"EVIDENCE_WRITE_FAILED","exitCode":1}\n');process.exitCode=1;}
}
