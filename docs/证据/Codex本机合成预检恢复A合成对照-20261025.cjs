'use strict';
// Exact driver re-entry, only OS/FS boundaries substituted; product bytes unchanged.
// No synthetic test can fall through to an actual process/network or private file IO.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const cp=require('node:child_process'),net=require('node:net');
const REPO=path.resolve(__dirname,'../..'), ROOT='artifacts/schedule-sandbox/.participant-private';
const driver=path.join(__dirname,'Codex本机合成预检恢复A-20261025.cjs');
const source=fs.readFileSync(driver,'utf8'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const NODE='C:\\Users\\30591\\.agent-reach\\tools\\node-v22.16.0-win-x64\\node.exe';
let fallbackHits=0,probes=0,probing=false;
function deny(){if(probing)probes++;else fallbackHits++;throw Error('OFFLINE_BOUNDARY');}
const cpKeys=Object.keys(cp).filter(k=>typeof cp[k]==='function');
for(const k of cpKeys)cp[k]=deny;
const modules=['node:http','node:https','node:tls','node:dns'];
const moduleKeys={};
for(const id of modules){const m=require(id);moduleKeys[id]=Object.keys(m).filter(k=>typeof m[k]==='function');for(const k of moduleKeys[id])Object.defineProperty(m,k,{value:deny,configurable:true});}
for(const k of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[k]==='function')require('node:dns').promises[k]=deny;
net.connect=net.createConnection=net.createServer=deny;net.Socket.prototype.connect=deny;global.fetch=deny;
probing=true;try{cp.execSync('synthetic-denied');}catch(_){}try{require('node:https').request('https://synthetic.invalid');}catch(_){}probing=false;
const GBK={'已':[210,209],'成':[179,201],'功':[185,166],'处':[180,166],'理':[192,237],'个':[184,246],'文':[206,196],'件':[188,254],'时':[202,177],'失':[202,167],'败':[176,220]};
const gb=t=>Buffer.from([...t].flatMap(c=>GBK[c]||[c.charCodeAt(0)]));
const stats=gb('已成功处理 1 个文件; 处理 0 个文件时失败\r\n');
const cache=new Map();
function staticRead(file){const p=path.resolve(file);assert(p===driver||p.startsWith(path.join(REPO,'miniapp','scripts')+path.sep)||p===NODE||/^(C:\\Windows\\System32\\(?:whoami|icacls)\.exe|C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe|C:\\Program Files\\Git\\cmd\\git\.exe)$/.test(p));
  if(!cache.has(p))cache.set(p,fs.readFileSync(p));return Buffer.from(cache.get(p));}
const cases=[['normal',true,0,6],['sourceDrift',false,2,0],['rootMissing',false,2,0],['targetExists',false,2,0],
  ['environmentFailure',false,2,1],['environmentTimeout',false,2,1],['environmentDecode',false,2,1],['identityFailure',false,2,2],
  ['asciiContract',false,2,5],['aclRejected',false,2,6],['aclDecode',false,2,6],['finalSourceDrift',false,2,6],
  ['preRequireHit',false,1,0],['digestHit',false,1,6],['outputExists',false,2,0],['outputInvalid',false,2,0]];
const results=[];
for(const [mode,expectedOk,expectedExit,expectedCalls]of cases){
  let out='',writes=0,osCalls=0,sourceReads=0,sourceInjected=false;
  const fakeModules={};
  for(const id of modules)fakeModules[id]=Object.fromEntries(moduleKeys[id].map(k=>[k,deny]));
  fakeModules['node:dns'].promises={lookup:deny,resolve:deny};
  const fakeCp=Object.fromEntries(cpKeys.map(k=>[k,deny]));
  fakeCp.spawnSync=(exe,args,opts)=>{
    osCalls++;assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);assert.equal(opts.cwd,REPO);
    assert(opts.timeout>0&&opts.timeout<=10000);assert.equal(opts.maxBuffer,128*1024);assert.equal(opts.encoding,undefined);assert.equal(opts.env.NODE_OPTIONS,undefined);
    let r={status:0,signal:null,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};
    if(exe.endsWith('powershell.exe')){
      assert(args.length===4&&args[3].includes('psr-local-environment/1')&&!args[3].includes('ConvertTo-SecureString'));
      r.stdout=Buffer.from(JSON.stringify({schema:'psr-local-environment/1',version:'5.1.26100.9711',effectivePolicy:'Restricted',
        policies:['MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine'].map(scope=>({scope,policy:'Undefined'})),nodeCandidateCount:3,selectedNodeMatches:true}));
      if(mode==='environmentFailure')r.status=1;if(mode==='environmentTimeout')r.error={code:'ETIMEDOUT'};
      if(mode==='environmentDecode')r.stdout=Buffer.from([0xff]);
    }else if(exe.endsWith('whoami.exe')){assert.deepEqual(Array.from(args),['/user','/fo','csv','/nh']);r.stdout=Buffer.from('"synthetic\\user","S-1-5-21-1-2-3-1001"\r\n');if(mode==='identityFailure')r.status=1;
    }else if(exe.endsWith('git.exe')){assert(['ls-files','check-ignore'].includes(args[0]));assert.equal(args[1],'--');assert(args[2].startsWith(ROOT+'/synthetic-local-private-'));if(args[0]==='check-ignore')r.stdout=Buffer.from(args[2]+'\n');
    }else if(exe.endsWith('icacls.exe')){assert(args.length===1&&(args[0]==='.'||args[0]===ROOT));
      r.stdout=Buffer.concat([Buffer.from(args[0]+' synthetic\\user:(F)\r\n'),stats]);
      if(mode==='asciiContract'&&args[0]==='.')r.stdout=Buffer.from('. synthetic\\user:(F)\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n');
      if(mode==='aclRejected'&&args[0]===ROOT)r.stdout=Buffer.concat([Buffer.from(ROOT+' Everyone:(F)\r\n'),stats]);
      if(mode==='aclDecode'&&args[0]===ROOT)r.stdout=Buffer.from([0x81]);
    }else deny();return r;
  };
  const fileStat=(file)=>{
    const p=path.resolve(file),root=path.join(REPO,ROOT);
    if(p===root&&mode==='rootMissing')throw Object.assign(Error('synthetic'),{code:'ENOENT'});
    if(p.startsWith(root+path.sep)&&p.endsWith('-ui.bin')){
      if(mode!=='targetExists')throw Object.assign(Error('synthetic'),{code:'ENOENT'});
      return {isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};}
    return {isFile:()=>p.endsWith('.exe'),isDirectory:()=>!p.endsWith('.exe'),isSymbolicLink:()=>false};
  };
  const fakeFs={readFileSync(file){let b=staticRead(file);const p=path.resolve(file);
    if(p.endsWith('participant-private-store.cjs')){sourceReads++;
      if(mode==='sourceDrift'||(mode==='finalSourceDrift'&&sourceReads===2))b=Buffer.concat([b,Buffer.from('//synthetic drift')]);
      if(mode==='preRequireHit'&&!sourceInjected){sourceInjected=true;try{fakeModules['node:https'].request('synthetic');}catch(_){}}}
    if(p===driver&&mode==='digestHit'){try{fakeModules['node:https'].request('synthetic');}catch(_){}}
    return b;
  },lstatSync(file){const p=path.resolve(file);if(p.endsWith('.json')){
      if(mode==='outputExists')return {isSymbolicLink:()=>false,isFile:()=>true};throw Object.assign(Error('synthetic'),{code:'ENOENT'});}
    return fileStat(file);},statSync:fileStat,writeFileSync(){writes++;deny();}};
  const fakeProc={argv:[NODE,driver],execPath:NODE,env:{SYNTHETIC:'1',NODE_OPTIONS:'synthetic-removed'},version:'v22.16.0',stdout:{write(s){out+=s;}},exitCode:null};
  if(mode==='outputExists')fakeProc.argv.push('--out',path.join(__dirname,'Codex本机合成预检恢复A-20261025-existing.json'));
  if(mode==='outputInvalid')fakeProc.argv.push('--out',path.join(__dirname,'unapproved.json'));
  const req=id=>{
    if(id==='node:fs')return fakeFs;if(id==='node:child_process')return fakeCp;
    if(id==='node:net')return {connect:deny,createConnection:deny,createServer:deny,Socket:{prototype:{connect:deny}}};
    if(fakeModules[id])return fakeModules[id];
    if(['node:path','node:crypto','node:vm'].includes(id))return require(id);return deny();
  };
  vm.runInNewContext(source,{require:req,__dirname,__filename:driver,Buffer,TextDecoder,process:fakeProc,setTimeout:deny,clearTimeout:deny},{filename:driver,timeout:10000});
  const result=JSON.parse(out);
  assert.equal(result.ok,expectedOk,mode);assert.equal(fakeProc.exitCode,expectedExit,mode);assert.equal(result.exitCode,expectedExit,mode);
  assert.equal(osCalls,expectedCalls,mode);assert.equal(writes,0,mode);assert.equal(result.observations.privateReads,0);assert.equal(result.observations.privateWrites,0);
  if(mode==='normal'){assert.equal(result.acl.rejectedRows,0);assert.equal(result.encodingContract.icaclsPipe.state,'established');assert.equal(result.productAttempts.length,5);assert.equal(result.uiReadiness,'blocked-policy');}
  if(['preRequireHit','digestHit'].includes(mode))assert.equal(result.observations.unexpected,1,mode);
  if(mode==='aclDecode')assert.equal(result.failureCode,'PSR_NATIVE_DECODE_UNCERTAIN');
  results.push({mode,ok:result.ok,exitCode:fakeProc.exitCode,processCalls:osCalls,unexpected:result.observations.unexpected,failureCode:result.failureCode||null,expectationMet:true});
}
const report={schema:'codex-local-preflight-A-synthetic/1',driverSha256:hash(fs.readFileSync(driver)),testSha256:hash(fs.readFileSync(__filename)),
  reviewedCommit:'68d379e',results,checks:results.length,probes,fallbackHits,ok:results.every(x=>x.expectationMet)&&fallbackHits===0,
  limitations:['OS queries and path existence are synthetic; no actual preflight/DPAPI/UI.','Exact driver and actual pinned product sources execute unchanged.']};
const argv=process.argv.slice(2);assert(argv.length===0||(argv.length===2&&argv[0]==='--out'));
const output=JSON.stringify(report,null,2)+'\n';
if(argv.length){const p=path.resolve(argv[1]);assert.equal(path.dirname(p),__dirname);assert(/^Codex本机合成预检恢复A合成对照-20261025\.json$/.test(path.basename(p)));fs.writeFileSync(p,output,{flag:'wx'});}
process.stdout.write(output);process.exitCode=report.ok?0:1;
