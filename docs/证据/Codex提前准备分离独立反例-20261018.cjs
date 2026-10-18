"use strict";
// Codex独立复查：只在VM内修改证据脚本副本；网络/非白名单子进程由外层阻断，不改受审源码。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process');
const {createRequire}=require('node:module');const root=path.resolve(__dirname,'../..'),sourcePath=path.join(__dirname,'CodeBuddyI1提前准备分离证据-20261018.cjs'),source=fs.readFileSync(sourcePath,'utf8');
const CLI=path.join(root,'miniapp/scripts/package-participant-identity-check.cjs');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const out=process.argv[2];const origSpawn=cp.spawn;const review=[];
async function run(name,transform){
 const restores=[],blocked=[];function block(o,k){if(typeof o[k]!=='function')return;const old=o[k];o[k]=()=>{blocked.push(k);throw Error('CODEX_OUTER_BLOCK');};restores.push(()=>o[k]=old);}
 for(const m of ['http','https'])for(const k of ['request','get'])block(require('node:'+m),k);
 for(const k of ['connect','createConnection'])block(require('node:net'),k);block(require('node:net').Socket.prototype,'connect');block(require('node:tls'),'connect');block(globalThis,'fetch');
 for(const k of ['exec','execSync','execFile','execFileSync','spawnSync','fork'])block(cp,k);
 let allowed=0;const prev=cp.spawn;cp.spawn=(command,args,opts)=>{assert.equal(command,process.execPath);assert.equal(path.resolve(args[0]),CLI);assert(['--prepare','--check-prepared','--check','--plan'].includes(args[1]));assert(opts.env.NODE_OPTIONS.includes('--require'));allowed++;return origSpawn(command,args,opts);};restores.push(()=>cp.spawn=prev);
 const stdout=[],stderr=[];const proc={argv:[process.execPath,sourcePath],env:process.env,execPath:process.execPath,exitCode:0,chdir:()=>{}};
 let code=transform(source).replace('main().catch(e =>','globalThis.__done = main().catch(e =>');
 const context={require:createRequire(sourcePath),__dirname:path.dirname(sourcePath),__filename:sourcePath,process:proc,console:{log:x=>stdout.push(String(x)),error:x=>stderr.push(String(x))},Date,Buffer,URL,AbortSignal,fetch:globalThis.fetch};
 try{vm.runInNewContext(code,context,{filename:sourcePath});await context.__done;assert.equal(proc.exitCode,0,stderr.join('\n'));const result=JSON.parse(stdout.find(x=>x.startsWith('{')));review.push({name,exitCode:proc.exitCode,evidenceOk:result.ok,evidenceGuard:result.guardCounters,outerBlocked:blocked,allowedLocalCli:allowed,sectionB:result.sections.b});return result;}finally{restores.reverse().forEach(f=>f());}
}
(async()=>{
 await run('normal',s=>s);
 const a=await run('caught_before_probeStart',s=>s.replace('  const probeStart = guardHits.length;',"  try { require('node:https').request('https://example.invalid'); } catch (_) {}\n  const probeStart = guardHits.length;"));assert.equal(a.ok,true);assert.equal(a.guardCounters.total,3);assert.equal(a.guardCounters.businessPhaseGuardAttempts,0);
 const b=await run('caught_child_preload_https',s=>s.replace('  const runCli = args =>',"  fs.appendFileSync(guardPreload, \"try { require('https').request('https://example.invalid'); } catch (_) {}\\n\");\n  const runCli = args =>"));assert.equal(b.ok,true);assert.equal(b.guardCounters.businessPhaseGuardAttempts,0);
 const c=await run('unexpected_process_api_caught',s=>s.replace("  const openid = 'synthetic-prep-openid';","  try { require('node:child_process').execSync('CODEX_BLOCKED_NEVER_EXECUTED'); } catch (_) {}\n  const openid = 'synthetic-prep-openid';"));assert(c.ok);assert(review.at(-1).outerBlocked.includes('execSync'));
 const d=await run('close_index_changed_between_snapshots',s=>s.replace('  const after = new Map();',"  fs.appendFileSync(path.join(outDir, 'close/server/scheduleSandbox/index.js'), '\\n// CODEX_SYNTHETIC_MUTATION\\n');\n  const after = new Map();").replace('const sectionB = { inWindowCheckOk, rebuildWritten, bytesUnchanged };','const sectionB = { inWindowCheckOk, rebuildWritten, bytesUnchanged, snapshotSize:snapshot.size, expectedFiles:39 };'));assert(d.ok);assert(d.sections.b.bytesUnchanged);assert(d.sections.b.snapshotSize<39);
 assert.equal(hash(fs.readFileSync(sourcePath)),hash(source));const report={schema:'codex-prepare-review-counterexamples/1',reviewedCommit:'50dd1ef',sourceSha256:hash(source),sourceUnchanged:true,results:review,networkCallsActuallyIssued:0,unexpectedProcessActuallyExecuted:0,scope:'VM evidence copies and local CLI synthetic materials only; baseline evidence not edited'};fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
