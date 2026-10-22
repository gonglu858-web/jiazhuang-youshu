'use strict';
// 仅合成FS/ACL/DPAPI接缝。实际CLI/存储/打包器源码在VM中执行，不访问真实私密根。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Module = require('node:module'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname,'../../..');
const STORE = 'miniapp/scripts/lib/participant-private-store.cjs';
const PACKER = 'miniapp/scripts/package-participant-self-registration.cjs';
const sid = 'S-1-5-21-111-222-333-1001';
function load(rel, overrides={}, globals={}, source, asMain=false) {
  const file=path.join(ROOT,rel), module={exports:{}}, native=Module.createRequire(file);
  const req = name => Object.hasOwn(overrides,name) ? overrides[name] : native(name);
  req.main=asMain?module:null;
  vm.runInNewContext(source===undefined?fs.readFileSync(file,'utf8'):source,
    {module,exports:module.exports,require:req,__dirname:path.dirname(file),__filename:file,
      Buffer,process,console,Date,setTimeout,clearTimeout,...globals},{filename:file});
  return module.exports;
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function createPrivateHarness() {
  const prefix=path.join(ROOT,'artifacts/schedule-sandbox/.participant-private');
  const mem=new Map(), calls=[], state={tracked:false,ignored:true,gitError:false,acl:'minimal',identity:true,unreadable:new Set(),links:new Set()};
  const key=p=>path.resolve(String(p)), privatePath=p=>key(p)===prefix||key(p).startsWith(prefix+path.sep);
  const dirStat=()=>({isFile:()=>false,isDirectory:()=>true,isSymbolicLink:()=>false});
  const tools={
    queryIdentity(){calls.push('identity');return {status:state.identity?0:1,stdout:'"synthetic\\current","'+sid+'"',stderr:''};},
    queryGit(repo,op,rel){calls.push('git:'+op);return {status:state.gitError?2:(op==='check-ignore'&&!state.ignored?1:0),stdout:op==='ls-files'?(state.tracked?rel:''):(state.ignored?rel:''),stderr:''};},
    queryAcl(repo,rel){calls.push('acl');return {status:state.acl==='error'?1:0,
      stdout:rel+' '+(state.acl==='minimal'?sid+':(F)':state.acl==='everyone'?'S-1-1-0:(F)':state.acl==='unknown'?'synthetic\\other:(R,W)':'unparseable42')+'\nSuccessfully processed 1 files; Failed processing 0 files',stderr:''};},
    protect(plain){calls.push('protect');return Buffer.from(plain).toString('hex');},
    async unprotect(hex){calls.push('unprotect');if(state.unreadable.has(hex))throw Error('synthetic decrypt failure');return Buffer.from(hex,'hex').toString();},
    PROTECT:'synthetic-dpapi-protect',UNPROTECT:'synthetic-dpapi-pipe'
  };
  const fakeFs=new Proxy(fs,{get(target,k){
    if(k==='readFileSync')return (p,...args)=>{if(privatePath(p)){calls.push('read:'+path.basename(String(p)));if(!mem.has(key(p)))throw Error('synthetic missing');const b=mem.get(key(p));return typeof args[0]==='string'?b.toString(args[0]):Buffer.from(b);}return fs.readFileSync(p,...args);};
    if(k==='writeFileSync')return (p,b,o)=>{if(privatePath(p)){if(mem.has(key(p))&&o&&o.flag==='wx'){const e=Error('exists');e.code='EEXIST';throw e;}calls.push('write');mem.set(key(p),Buffer.from(b));return;}return fs.writeFileSync(p,b,o);};
    if(k==='existsSync')return p=>privatePath(p)?(key(p)===prefix||mem.has(key(p))):fs.existsSync(p);
    if(k==='lstatSync')return p=>{if(state.links.has(key(p)))return {isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>true};if(privatePath(p)){if(key(p)===prefix)return dirStat();if(mem.has(key(p)))return {isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,size:mem.get(key(p)).length};const e=Error('missing');e.code='ENOENT';throw e;}return fs.lstatSync(p);};
    if(k==='readdirSync')return (p,...args)=>{if(privatePath(p))throw Error('禁止枚举私密根/历史记录');return fs.readdirSync(p,...args);};
    return target[k];
  }});
  const store=load(STORE,{'node:fs':fakeFs,'./participant-local-tools.cjs':tools});
  const packer=load(PACKER,{'node:fs':fakeFs,'./lib/participant-private-store.cjs':store});
  function save(code,account,patch={}) {
    const payload=store.buildPrivatePayload({participantCode:code,fullAccount:account,
      appId:'wxfb4db1615ac15531',envId:'cloud1-d8gcq5ag39d847723',expectedTarget:store.FIXED_TARGET,
      checkRoundId:'synthetic-readonly-'+code,checkWindowStartsAtIso:'2026-01-01T00:00:00Z',
      checkWindowExpiresAtIso:'2026-01-01T00:10:00Z',serverTimeIso:'2026-01-01T00:05:00Z',
      readonlySourceDigest:sha('synthetic-readonly-source-'+code),deliveryConfirmed:true,...patch});
    const name='synthetic-source-'+code+'.bin';mem.set(path.join(prefix,name),Buffer.from(Buffer.from(JSON.stringify(payload)).toString('hex')));
    const ref=Object.fromEntries(['participantCode','checkRoundId','checkWindowStartsAtIso','checkWindowExpiresAtIso',
      'serverTimeIso','readonlySourceDigest','deliveryConfirmed'].map(k=>[k,payload[k]]));
    return {payload,ref:{recordFile:name,...ref},name};
  }
  return {store,packer,mem,calls,state,tools,fakeFs,save,prefix};
}
module.exports=Object.freeze({load,createPrivateHarness,ROOT,STORE,PACKER,sid,sha});
