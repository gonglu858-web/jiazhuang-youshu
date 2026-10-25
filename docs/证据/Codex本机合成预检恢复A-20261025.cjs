'use strict';
// Phase A only. Product bytes are pinned to 68d379e. No DPAPI/UI/private record IO.
// Product modules run unchanged in isolated CommonJS contexts; their OS boundary
// forwards only the six fixed read-only queries below to the actual OS.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process'), net = require('node:net'), vm = require('node:vm');
const REPO = path.resolve(__dirname, '../..');
const ROOT = 'artifacts/schedule-sandbox/.participant-private';
const NODE = 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const NODE_SHA = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19';
const EXES = Object.freeze({git:'C:\\Program Files\\Git\\cmd\\git.exe',
  whoami:'C:\\Windows\\System32\\whoami.exe', icacls:'C:\\Windows\\System32\\icacls.exe',
  powershell:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'});
const PINNED = Object.freeze({
  'miniapp/scripts/lib/participant-private-store.cjs': [26236,'fe5bc16a20ca9ee2116a72a483f726b78b5a5d55a40a635e9433e61855d83fbe'],
  'miniapp/scripts/lib/participant-local-tools.cjs': [14032,'56daf9f675c7c7fbcd92f81aba4cdd6237626b19ff6b07a78421eb9ff811ae26'],
  'miniapp/scripts/lib/participant-native-exec.cjs': [16761,'12d77b1716590b663819763fd8078b436538b4d6c370ba0f389eaefcf289ec0f'],
  'miniapp/scripts/lib/participant-native-decoder.cjs': [3390,'462976b3cf32999fb0079d6b0bbb4cf54cd35ab3d1068fb1052db36f4c05f7d3'],
  'miniapp/scripts/lib/participant-dpapi-scripts.cjs': [2646,'1f334d8d6b92c4f7e93b64c217fbb1cd2f3d5177f0a4728051ec87895eaa474f'],
  'miniapp/scripts/package-participant-self-registration.cjs': [64288,'618aeadc6b7dbf9622bbaa9ae64d49023c58ff35d6ca747c2db238714b195251'],
  'miniapp/scripts/participant-private-input.ps1': [8951,'ea3b35b5f50857c90959520a21a0cbf4fde43a753107d6ae7d8afb92dba4a357']
});
// Fixed metadata only, not an alternate execution route for the PS1 or DPAPI.
const META = "$ErrorActionPreference='Stop'; Import-Module -Name ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; Import-Module -Name ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $nodes=@(Get-Command node -CommandType Application -ErrorAction Stop); [pscustomobject]@{schema='psr-local-environment/1'; version=$PSVersionTable.PSVersion.ToString(); effectivePolicy=(Get-ExecutionPolicy).ToString(); policies=@(Get-ExecutionPolicy -List | ForEach-Object { [pscustomobject]@{scope=$_.Scope.ToString();policy=$_.ExecutionPolicy.ToString()} }); nodeCandidateCount=$nodes.Count; selectedNodeMatches=($nodes[0].Source -ieq 'C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe') } | ConvertTo-Json -Compress -Depth 4";
const LIMIT=128*1024, start=Date.now(), rawSync=cp.spawnSync;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const state={probes:0,unexpected:0,processCalls:[],privateReads:0,privateWrites:0};
let probing=false, outputPath=null, sources={}, loaded={}, stage='arguments', principals=null, aclRaw=null;
const runId='synthetic-local-private-'+crypto.randomBytes(6).toString('hex');
const target=ROOT+'/'+runId+'-ui.bin';
const report={schema:'codex-local-preflight-restored/1',runId,recordedAt:new Date().toISOString(),
  reviewedCommit:'68d379e',planBasis:'02f867b',verificationKind:'real local read-only OS queries through restricted capabilities; no DPAPI or UI',
  phases:{A:'not-run',B:'not-run',C:'not-run',D:'not-run'},fullLocalValidationPassed:false,
  sourceFacts:[],binaries:[],observations:state,ok:false,
  limitations:['A pass is not real-input approval or complete local validation.','No private record, credential, cloud, DPAPI or UI access.']};
function fail(code){throw Object.assign(new Error(code),{code});}
function need(v,code){if(!v)fail(code);}
function deny(){if(probing)state.probes++;else state.unexpected++;fail('LOCAL_CAPABILITY_BLOCKED');}
// Capture raw spawn privately, then guard public APIs before loading product code.
for(const k of Object.keys(cp))if(typeof cp[k]==='function')cp[k]=deny;
for(const m of [require('node:http'),require('node:https'),require('node:tls'),require('node:dns'),require('node:dns').promises])
  for(const k of Object.keys(m))if(typeof m[k]==='function')Object.defineProperty(m,k,{value:deny,configurable:true});
net.connect=net.createConnection=net.createServer=deny;net.Socket.prototype.connect=deny;globalThis.fetch=deny;
const used=new Set();
function dispatch(exe,args,opts){
  let kind=null;
  if(exe===EXES.git&&same(args,['ls-files','--',target]))kind='git-ls-files';
  if(exe===EXES.git&&same(args,['check-ignore','--',target]))kind='git-check-ignore';
  if(exe===EXES.whoami&&same(args,['/user','/fo','csv','/nh']))kind='identity';
  if(exe===EXES.icacls&&same(args,['.']))kind='encoding-probe';
  if(exe===EXES.icacls&&same(args,[ROOT]))kind='acl-root';
  if(exe===EXES.powershell&&same(args,['-NoProfile','-NonInteractive','-Command',META]))kind='environment';
  const env={...process.env};delete env.NODE_OPTIONS;
  const expected={cwd:REPO,input:undefined,windowsHide:true,shell:false,env,timeout:10000,maxBuffer:LIMIT};
  if(!kind||used.has(kind)||!same(opts,expected))return deny();
  const remaining=60000-(Date.now()-start);need(remaining>0,'A_BUDGET_EXHAUSTED');used.add(kind);
  const record={kind,attempted:true,completed:false,status:null,signal:false,launchError:false,stdoutBytes:null,stderrBytes:null,timeoutMs:Math.min(10000,remaining)};
  state.processCalls.push(record);
  let r;
  try{r=rawSync(exe,[...args],{...expected,timeout:record.timeoutMs});}
  catch(_){record.completed=true;record.launchError=true;fail('LOCAL_PROCESS_FAILED');}
  record.completed=true;record.status=Number.isInteger(r?.status)?r.status:null;
  record.signal=!!r?.signal;record.launchError=!!r?.error;
  record.stdoutBytes=Buffer.isBuffer(r?.stdout)?r.stdout.length:null;
  record.stderrBytes=Buffer.isBuffer(r?.stderr)?r.stderr.length:null;
  need(r&&!r.error&&!r.signal&&[0,1].includes(r.status)&&Buffer.isBuffer(r.stdout)&&Buffer.isBuffer(r.stderr)&&r.stdout.length<=LIMIT&&r.stderr.length===0,'LOCAL_PROCESS_FAILED');
  if(kind==='acl-root')aclRaw=Buffer.from(r.stdout);
  return r;
}
function checkSources(cache){
  const facts=[];
  for(const [rel,[size,digest]]of Object.entries(PINNED)){
    const b=fs.readFileSync(path.join(REPO,rel));
    need(b.length===size&&hash(b)===digest,'SOURCE_DRIFT');
    facts.push({rel,bytes:b.length,sha256:digest});if(cache)sources[rel]=b;
  }
  return facts;
}
function absent(file){try{fs.lstatSync(file);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
// No file content IO is exposed to the product during phase A.
const productFs=new Proxy(Object.freeze({
  statSync(file){if(!Object.values(EXES).includes(file))return deny();return fs.statSync(file);},
  lstatSync(file){const abs=path.resolve(file),root=path.resolve(REPO,ROOT),t=path.resolve(REPO,target);
    if(abs!==t&&abs!==REPO&&!(root.startsWith(abs+path.sep)&&abs.startsWith(REPO+path.sep))&&abs!==root)return deny();
    return fs.lstatSync(abs);}
}),{get(o,k){return Object.hasOwn(o,k)?o[k]:deny;}});
function loadProduct(rel){
  need(rel.startsWith('miniapp/scripts/lib/')&&Object.hasOwn(sources,rel),'MODULE_BOUNDARY');
  if(loaded[rel])return loaded[rel].exports;
  const m={exports:{}};loaded[rel]=m;
  function req(id){
    if(id.startsWith('./'))return loadProduct(path.posix.normalize(path.posix.join(path.posix.dirname(rel),id)));
    if(id==='node:fs')return productFs;
    if(id==='node:path')return path;if(id==='node:crypto')return crypto;
    if(id==='node:child_process')return Object.freeze({spawnSync:dispatch,spawn:deny,execFileSync:deny});
    if(id==='node:net')return Object.freeze({connect:deny});
    return deny();
  }
  const file=path.join(REPO,rel);
  const fn=vm.runInNewContext('(function(require,module,exports,__filename,__dirname){'+sources[rel].toString('utf8')+'\n})',
    {Buffer,TextDecoder,process:{env:{...process.env}},setTimeout:deny,clearTimeout:deny},{filename:file,timeout:1000});
  fn(req,m,m.exports,file,path.dirname(file));return m.exports;
}
function environment(){
  const env={...process.env};delete env.NODE_OPTIONS;
  const r=dispatch(EXES.powershell,['-NoProfile','-NonInteractive','-Command',META],{cwd:REPO,input:undefined,windowsHide:true,shell:false,env,timeout:10000,maxBuffer:LIMIT});
  need(r.status===0,'ENVIRONMENT_QUERY_FAILED');
  let v;try{v=JSON.parse(loadProduct('miniapp/scripts/lib/participant-native-decoder.cjs').decodeUtf8Strict(r.stdout));}catch(_){fail('ENVIRONMENT_PARSE_FAILED');}
  const policies=['Undefined','Restricted','AllSigned','RemoteSigned','Unrestricted','Bypass','Default'];
  const scopes=['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'];
  need(v&&same(Object.keys(v).sort(),['schema','version','effectivePolicy','policies','nodeCandidateCount','selectedNodeMatches'].sort())&&
    v.schema==='psr-local-environment/1'&&/^\d+(\.\d+){1,3}$/.test(v.version)&&policies.includes(v.effectivePolicy)&&
    v.selectedNodeMatches===true&&Number.isSafeInteger(v.nodeCandidateCount)&&v.nodeCandidateCount>0&&v.nodeCandidateCount<=64&&
    Array.isArray(v.policies)&&v.policies.length===5&&new Set(v.policies.map(p=>p.scope)).size===5&&
    v.policies.every(p=>same(Object.keys(p).sort(),['policy','scope'])&&scopes.includes(p.scope)&&policies.includes(p.policy)), 'ENVIRONMENT_PARSE_FAILED');
  return {version:v.version,effectivePolicy:v.effectivePolicy,policies:v.policies,nodeCandidateCount:v.nodeCandidateCount,selectedNodeMatches:true};
}
let store,local;
try{
  const argv=process.argv.slice(2);
  need(argv.length===0||(argv.length===2&&argv[0]==='--out'&&typeof argv[1]==='string'&&argv[1].length>0),'ARGUMENT_INVALID');
  if(argv.length){const p=path.resolve(argv[1]);
    need(path.dirname(p)===__dirname&&/^Codex本机合成预检恢复A-20261025(?:-[A-Za-z0-9]+)?\.json$/.test(path.basename(p)),'OUTPUT_BOUNDARY');
    need(!fs.lstatSync(__dirname).isSymbolicLink()&&absent(p),'OUTPUT_EXISTS');outputPath=p;}
  probing=true;try{cp.execSync('synthetic-denied');}catch(_){}try{require('node:https').request('https://synthetic.invalid');}catch(_){}probing=false;
  need(state.probes===2,'GUARD_PROBE_FAILED');
  stage='A0-source';report.sourceFacts=checkSources(true);
  need(process.execPath===NODE&&hash(fs.readFileSync(NODE))===NODE_SHA,'NODE_DRIFT');
  for(const[kind,exe]of Object.entries({...EXES,node:NODE})){
    const st=fs.lstatSync(exe);need(st.isFile()&&!st.isSymbolicLink(),'PROGRAM_PATH_INVALID');
    report.binaries.push({kind,sha256:hash(fs.readFileSync(exe))});}
  store=loadProduct('miniapp/scripts/lib/participant-private-store.cjs');local=loadProduct('miniapp/scripts/lib/participant-local-tools.cjs');
  stage='A1-path';need(fs.lstatSync(path.join(REPO,ROOT)).isDirectory(),'PRIVATE_ROOT_MISSING');store.assertNoLinks(REPO,path.join(REPO,ROOT));
  need(absent(path.join(REPO,target)),'TARGET_EXISTS');report.targetInitiallyAbsent=true;
  need(state.unexpected===0,'LOCAL_CAPABILITY_BLOCKED');
  stage='A2-environment';report.environment=environment();report.uiReadiness=report.environment.effectivePolicy==='Restricted'?'blocked-policy':'not-tested';
  stage='A3-identity';principals=store.getCurrentPrincipals();need(principals!==null,'IDENTITY_UNCERTAIN');report.identityParsed=true;
  stage='A3-target';store.validatePrivateTarget({repoRoot:REPO,relativePath:target});report.targetValidated=true;
  stage='A4-final';need(absent(path.join(REPO,target)),'TARGET_APPEARED');report.targetStillAbsent=true;
  checkSources(false);report.phases.A='pass';
}catch(e){probing=false;report.failureCode=typeof e.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:'PREFLIGHT_UNCERTAIN';report.failureStage=stage;report.phases.A='blocked';}
finally{
  try{
    if(local)report.encodingContract=local.nativeEncodingContract();
    if(aclRaw&&principals&&store){const text=local.decoder.decodeNative(aclRaw);const rejected=store.findBroadAclGrants(text,principals,ROOT);
      report.acl={rejectedRows:rejected.length,statsAnchored:local.anchorVerdict(text).anchored};}
    if(loaded['miniapp/scripts/lib/participant-native-exec.cjs'])report.productAttempts=loaded['miniapp/scripts/lib/participant-native-exec.cjs'].exports.attempts();
    report.scriptSha256=hash(fs.readFileSync(__filename));
  }catch(_){report.finalFactsComplete=false;if(!report.failureCode)report.failureCode='FINAL_FACTS_UNCERTAIN';report.phases.A='blocked';}
  if(aclRaw)aclRaw.fill(0);aclRaw=null;principals=null;loaded={};sources={};
  report.elapsedMs=Date.now()-start;
  if(report.elapsedMs>60000){report.failureCode='A_BUDGET_EXHAUSTED';report.phases.A='blocked';}
  if(state.unexpected){report.phases.A='fail';report.failureCode='LOCAL_CAPABILITY_BLOCKED';}
  report.ok=report.phases.A==='pass'&&state.unexpected===0;
  report.exitCode=report.ok?0:state.unexpected?1:2;
  const result=JSON.stringify(report,null,2)+'\n';
  try{if(outputPath)fs.writeFileSync(outputPath,result,{flag:'wx'});process.stdout.write(result);process.exitCode=report.exitCode;}
  catch(_){process.stdout.write('{"ok":false,"failureCode":"EVIDENCE_WRITE_FAILED","exitCode":1}\n');process.exitCode=1;}
}
