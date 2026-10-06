'use strict';
// 本轮独立复核：只操作新建受控临时目录；不覆盖旧证据或制品。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const p = require(path.join(root, 'miniapp/scripts/package-sandbox.cjs'));
const tmp = fs.mkdtempSync(path.join(p.ARTIFACTS_ROOT, '.codex-r1r5-'));
const results = [];
function trial(name, fn) { try { results.push({name, rejected:false, result:fn()}); } catch(e) {results.push({name,rejected:true,error:e.message});} }
function make(name) { const out = path.join(tmp, name); p.buildPackage({outDir:out}); return out; }
trial('partial-without-manifest-late-conflict', () => {
  const out = path.join(tmp,'partial');
  fs.mkdirSync(path.join(out,'package'), {recursive:true});
  fs.writeFileSync(path.join(out,'package/gate.js'), 'different');
  let error;
  try { p.buildPackage({outDir:out}); } catch(e) {error=e.message;}
  return { rejected:!!error, indexCreated:fs.existsSync(path.join(out,'package/index.js')), error };
});
trial('manifest-false-sourceKey', () => {
  const out = make('source-key');
  const file=path.join(out,'manifest.json'), d=JSON.parse(fs.readFileSync(file,'utf8'));
  d.files[0].sourceKey='miniapp/cloudfunctions/memberAccess/index.js';
  d.sourceDir='miniapp/cloudfunctions/memberAccess';
  fs.writeFileSync(file,JSON.stringify(d));
  return p.buildPackage({outDir:out,checkOnly:true}).mode;
});
trial('whitelisted-file-symbolic-link', () => {
  const out=make('file-link'), index=path.join(out,'package/index.js');
  const saved=path.join(tmp,'saved-index.js');
  fs.renameSync(index,saved);
  fs.symlinkSync(saved,index,'file');
  const isSymbolicLink=fs.lstatSync(index).isSymbolicLink();
  const check=p.buildPackage({outDir:out,checkOnly:true});
  return {isSymbolicLink,mode:check.mode,meaning:isSymbolicLink?'link not rejected':'link branch not exercised'};
});
trial('synthetic-whitelisted-link-check-branch', () => {
  // 链接权限不可用时只注入文件类型，证明控制流遗漏；不声称是平台实链。
  const out=make('synthetic-link'), marked=path.join(out,'package/index.js');
  const wrapper=Object.create(fs);let markedLstatCalls=0;
  wrapper.lstatSync=(file,...args)=>{const s=fs.lstatSync(file,...args);if(path.resolve(file)!==marked)return s;markedLstatCalls++;return new Proxy(s,{get:(o,k)=>k==='isSymbolicLink'?()=>true:typeof o[k]==='function'?o[k].bind(o):o[k]});};
  wrapper.readdirSync=(dir,opts)=>{const entries=fs.readdirSync(dir,opts);if(!opts||!opts.withFileTypes)return entries;return entries.map(e=>path.join(dir,e.name)!==marked?e:new Proxy(e,{get:(o,k)=>k==='isSymbolicLink'?()=>true:typeof o[k]==='function'?o[k].bind(o):o[k]}));};
  const file=path.join(root,'miniapp/scripts/package-sandbox.cjs'), mod={exports:{}};
  const req=require('node:module').createRequire(file);
  vm.runInThisContext('(function(require,module,exports,__dirname){'+fs.readFileSync(file,'utf8').replace(/^#![^\r\n]*/,'')+'\n})',{filename:file})(name=>name==='node:fs'?wrapper:req(name),mod,mod.exports,path.dirname(file));
  const result=mod.exports.buildPackage({outDir:out,checkOnly:true});
  return {mode:result.mode,markedLstatCalls,scope:'synthetic file-type injection only; no real symlink'};
});
for (const [name, mutate] of [
  ['dependency-version-changed',d=>d.function.dependency.wxServerSdk='999.0.0'],
  ['collection-created-true',d=>d.collections[0].created=true],
  ['collection-ttl-omitted',d=>delete d.collections[0].ttlEnabled],
  ['index-reverse',d=>d.indexes[3].keys.reverse()],
]) trial(name,()=>{const d=JSON.parse(fs.readFileSync(p.CANDIDATE_PATH,'utf8'));mutate(d);return p.validateCandidateDocument(d,[],name);});

// 原 WorkBuddy 脚本仅内存重定向其临时根；所有递归清理先检查最终绝对目标属于本次临时根。
const wbPath=path.join(__dirname,'本地制品准备R1R5修复复现-20261005.cjs');
const wbRoot=path.join(tmp,'wb-replay');fs.mkdirSync(wbRoot);
const wbSource=fs.readFileSync(wbPath,'utf8').replace('const ROOT = p.ARTIFACTS_ROOT;',`const ROOT = ${JSON.stringify(wbRoot)};`);
const safeFs=Object.create(fs);
safeFs.rmSync=(file,opts)=>{const abs=path.resolve(file); if(!abs.startsWith(wbRoot+path.sep)) throw Error('unexpected cleanup path');return fs.rmSync(abs,opts);};
const createRequire=require('node:module').createRequire(wbPath);
const logs=[];
const runner=vm.runInThisContext('(function(require,__dirname,console){'+wbSource+'\n})',{filename:wbPath});
let wbReplayError=null;
try { runner(name=>name==='node:fs'?safeFs:createRequire(name),__dirname,{log:(...args)=>logs.push(args.join(' '))}); }
catch(e) { wbReplayError={code:e.code||'',message:e.message}; logs.push('REPLAY INCOMPLETE: '+e.message); }
fs.writeFileSync(path.join(__dirname,'Codex本地制品R1R5原脚本复跑-20261005.txt'),logs.join('\n')+'\n');
const baseline=JSON.parse(fs.readFileSync(p.BASELINE_PATH,'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const changed=Object.entries(baseline.files).filter(([file,h])=>!fs.existsSync(path.join(root,file))||hash(path.join(root,file))!==h).map(([file])=>file);
const result={date:'2026-10-05',scope:'local only',tmp,results,baselineCount:Object.keys(baseline.files).length,changed,wbReplayError,wbReplaySummary:logs.slice(-1),files:[
  'miniapp/scripts/package-sandbox.cjs','miniapp/tests/sandbox-package.test.cjs','docs/独立副本有限测试操作稿-20261005.md',
  'miniapp/cloudbase/schedule-sandbox-resources.candidate.json','artifacts/schedule-sandbox/closed-20261005/manifest.json',
  'artifacts/schedule-sandbox/closed-20261005-r2fix/manifest.json','docs/证据/本地制品准备R1R5修复复现-20261005.cjs','docs/证据/本地制品准备R1R5修复复现-20261005.json'
].map(file=>({file,sha256:hash(path.join(root,file))}))};
fs.writeFileSync(path.join(__dirname,'Codex本地制品R1R5复核-20261005.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
