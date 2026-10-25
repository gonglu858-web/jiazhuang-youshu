'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const cp=require('node:child_process'),net=require('node:net');
const REPO=path.resolve(__dirname,'../..'),driver=path.join(__dirname,'Codex环境校验细分-20261025.cjs');
const basisFile=path.join(__dirname,'Codex本机合成预检恢复A-20261025.cjs');
const source=fs.readFileSync(driver,'utf8'),basis=fs.readFileSync(basisFile,'utf8');
const NODE='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
const PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const originalExpression=basis.match(/need\((v&&same[\s\S]*?), 'ENVIRONMENT_PARSE_FAILED'\);/)[1];
const newExpression=source.match(/return !!\((v&&same[\s\S]*?)\);\}catch/)[1];
const normalize=s=>s.replace(/\bPOLICY\b/g,'policies').replace(/\bSCOPE\b/g,'scopes').replace(/\s+/g,'');
assert.equal(normalize(originalExpression),normalize(newExpression));
const expectedMeta=JSON.parse(basis.match(/^const META = (".*");$/m)[1]);
let fallbackHits=0,probes=0,probing=false;
function deny(){if(probing)probes++;else fallbackHits++;throw Error('OFFLINE_BOUNDARY');}
const cpKeys=Object.keys(cp).filter(k=>typeof cp[k]==='function');for(const k of cpKeys)cp[k]=deny;
const ids=['node:http','node:https','node:tls','node:dns'],keys={};
for(const id of ids){const m=require(id);keys[id]=Object.keys(m).filter(k=>typeof m[k]==='function');for(const k of keys[id])Object.defineProperty(m,k,{value:deny,configurable:true});}
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
net.connect=net.createConnection=net.createServer=deny;net.Socket.prototype.connect=deny;global.fetch=deny;
probing=true;try{cp.execSync('synthetic-denied');}catch(_){}try{require('node:https').request('https://synthetic.invalid');}catch(_){}probing=false;
const base=()=>({schema:'psr-local-environment/1',version:'5.1.26100.9711',effectivePolicy:'Restricted',
  policies:['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'].map(scope=>({scope,policy:'Undefined'})),nodeCandidateCount:3,selectedNodeMatches:true});
const cases=[
  ['normal',null,null],['utf8',null,'UTF8_STRICT_FAILED'],['json',null,'JSON_PARSE_FAILED'],
  ['extra',v=>{v.SECRET_METADATA='SECRET_METADATA';},'ROOT_KEYS'],['schema',v=>{v.schema='SECRET_METADATA';},'SCHEMA'],
  ['version',v=>{v.version='SECRET_METADATA';},'VERSION_FORMAT'],['effective',v=>{v.effectivePolicy='SECRET_METADATA';},'EFFECTIVE_POLICY_ENUM'],
  ['nodeMismatch',v=>{v.selectedNodeMatches=false;},'NODE_FIRST_MATCH'],['nodeType',v=>{v.selectedNodeMatches='true';},'NODE_FIRST_MATCH'],
  ['countZero',v=>{v.nodeCandidateCount=0;},'NODE_COUNT'],['countLarge',v=>{v.nodeCandidateCount=65;},'NODE_COUNT'],
  ['countType',v=>{v.nodeCandidateCount='3';},'NODE_COUNT'],['policyShape',v=>{v.policies={};},'POLICIES_ARRAY'],
  ['policyCount',v=>{v.policies.pop();},'POLICY_COUNT'],['scopeDuplicate',v=>{v.policies[1].scope=v.policies[0].scope;},'SCOPE_UNIQUENESS'],
  ['rowKeys',v=>{v.policies[0].SECRET_METADATA=true;},'POLICY_ROW_KEYS'],['scopeEnum',v=>{v.policies[0].scope='SECRET_METADATA';},'SCOPE_ENUM'],
  ['policyEnum',v=>{v.policies[0].policy='SECRET_METADATA';},'POLICY_ENUM'],['rowNull',v=>{v.policies[0]=null;},'POLICY_ROW_KEYS'],
  ['rootNull',null,'ROOT_KEYS'],['numericVersionUnchanged',v=>{v.version=5.1;},null],
  ['queryFailure',null,null],['queryTimeout',null,null],['earlyHit',null,null],['digestHit',null,null],['sourceDrift',null,null]];
const allowed=[driver,basisFile,path.join(REPO,'miniapp/scripts/lib/participant-native-decoder.cjs'),NODE,PS];
const cache=new Map(allowed.map(p=>[p,fs.readFileSync(p)]));
const results=[];
for(const [name,mutate,label]of cases){
  let data=base();if(mutate)mutate(data);if(name==='rootNull')data=null;
  let stdout=Buffer.from(JSON.stringify(data));if(name==='utf8')stdout=Buffer.from([0xff]);if(name==='json')stdout=Buffer.from('not-json SECRET_METADATA');
  let output='',calls=0,writes=0,early=false;
  const mods={};for(const id of ids)mods[id]=Object.fromEntries(keys[id].map(k=>[k,deny]));mods['node:dns'].promises={lookup:deny};
  const fc=Object.fromEntries(cpKeys.map(k=>[k,deny]));
  fc.spawnSync=(exe,args,opts)=>{calls++;assert.equal(exe,PS);assert.deepEqual(Array.from(args),['-NoProfile','-NonInteractive','-Command',expectedMeta]);
    assert.equal(opts.cwd,REPO);assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);assert.equal(opts.encoding,undefined);assert.equal(opts.env.NODE_OPTIONS,undefined);assert(opts.timeout>0&&opts.timeout<=10000);assert.equal(opts.maxBuffer,128*1024);
    return {status:name==='queryFailure'?1:0,signal:null,error:name==='queryTimeout'?{code:'ETIMEDOUT'}:undefined,stdout:Buffer.from(stdout),stderr:Buffer.alloc(0)};};
  const fakeFs={readFileSync(file){const p=path.resolve(file);assert(cache.has(p));
      if(name==='earlyHit'&&!early){early=true;try{mods['node:https'].request('synthetic');}catch(_){}}
      if(name==='digestHit'&&p===driver){try{mods['node:https'].request('synthetic');}catch(_){}}
      let b=Buffer.from(cache.get(p));if(name==='sourceDrift'&&p===basisFile)b=Buffer.concat([b,Buffer.from('//drift')]);return b;
    },lstatSync(p){assert(allowed.includes(p));return {isFile:()=>true,isSymbolicLink:()=>false};},writeFileSync(){writes++;deny();}};
  const proc={argv:[NODE,driver],execPath:NODE,env:{SYNTHETIC:'1',NODE_OPTIONS:'synthetic-removed'},stdout:{write(s){output+=s;}},exitCode:null};
  const req=id=>{if(id==='node:fs')return fakeFs;if(id==='node:child_process')return fc;
    if(id==='node:net')return {connect:deny,createConnection:deny,createServer:deny,Socket:{prototype:{connect:deny}}};
    if(mods[id])return mods[id];if(['node:path','node:crypto','node:vm'].includes(id))return require(id);return deny();};
  vm.runInNewContext(source,{require:req,__dirname,__filename:driver,Buffer,TextDecoder,process:proc},{filename:driver,timeout:10000});
  const r=JSON.parse(output),expectedPass=['normal','numericVersionUnchanged'].includes(name);
  assert.equal(r.ok,expectedPass,name);assert.equal(proc.exitCode,expectedPass?0:['earlyHit','digestHit'].includes(name)?1:2,name);
  assert.equal(proc.exitCode,r.exitCode);assert.equal(calls,['earlyHit','sourceDrift'].includes(name)?0:1);assert.equal(writes,0);
  if(label)assert(r.diagnostic.failureLabels.includes(label),name);
  if(r.diagnostic?.jsonParsed){let expected;try{expected=!!vm.runInNewContext(originalExpression,{v:data,policies:['Undefined','Restricted','AllSigned','RemoteSigned','Unrestricted','Bypass','Default'],scopes:['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'],same:(a,b)=>JSON.stringify(a)===JSON.stringify(b)});}catch(_){expected=false;}assert.equal(r.diagnostic.accepted,expected);}
  assert(!output.includes('SECRET_METADATA'));assert(!output.includes('SYNTHETIC'));assert(!output.includes(NODE));
  if(['earlyHit','digestHit'].includes(name))assert.equal(r.observations.unexpected,1);
  results.push({name,expectationMet:true,ok:r.ok,exitCode:proc.exitCode,calls,labels:r.diagnostic?.failureLabels||[],unexpected:r.observations.unexpected});
}
const report={schema:'codex-environment-diagnostic-synthetic/1',basisCommit:'95097a7',driverSha256:hash(fs.readFileSync(driver)),testSha256:hash(fs.readFileSync(__filename)),
  exactPredicatePreserved:true,exactQueryPreserved:true,checks:results.length,results,probes,fallbackHits,ok:fallbackHits===0,
  limitations:['All process results are synthetic; no environment/identity/ACL/DPAPI/UI query.','Only static pinned source and binary files read.']};
const args=process.argv.slice(2);assert(args.length===0||(args.length===2&&args[0]==='--out'));
const text=JSON.stringify(report,null,2)+'\n';if(args.length){const p=path.resolve(args[1]);assert.equal(path.dirname(p),__dirname);assert.equal(path.basename(p),'Codex环境校验细分合成对照-20261025.json');fs.writeFileSync(p,text,{flag:'wx'});}process.stdout.write(text);process.exitCode=report.ok?0:1;
