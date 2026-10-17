'use strict';
// 外层守卫敏感性独立验证；仅内存插入被catch尝试，不修改受审脚本。默认stdout，--out wx。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..');
const file=path.join(__dirname,'CodeBuddyI1分层R1原型终局证据-20261017.cjs');
const original=fs.readFileSync(file,'utf8');
async function run(injected){
 let src=original;const anchor='const businessStart = guardHits.length;';
 assert.equal(src.split(anchor).length,2);
 if(injected)src=src.replace(anchor,anchor+" try { require('node:https').request('https://example.invalid'); } catch (_) {}");
 assert.equal(src.split('main().catch').length,2);src=src.replace('main().catch','globalThis.completion = main().catch');
 const output=[],errors=[];const proc={argv:['node',file],env:process.env,exitCode:0,chdir:p=>assert.equal(path.resolve(p),root)};
 const ctx={require:createRequire(file),process:proc,console:{log:s=>output.push(s),error:s=>errors.push(String(s))},Buffer,setTimeout,clearTimeout,URL,__dirname:path.dirname(file),__filename:file};
 vm.runInNewContext(src,ctx,{filename:file});await ctx.completion;
 assert.equal(output.length,1,errors.join('\n'));const result=JSON.parse(output[0]);
 assert.equal(result.guardCounters.sensitivityAttempts,2);
 assert.equal(result.guardCounters.businessPhaseGuardAttempts,injected?1:0);
 assert.equal(result.guardCounters.total,injected?3:2);
 assert.equal(result.ok,!injected);assert.equal(proc.exitCode,injected?1:0);
 return {injected,guardCounters:result.guardCounters,ok:result.ok,exitCode:proc.exitCode};
}
(async()=>{const normal=await run(false),caughtUnexpected=await run(true);const r={schema:'codex-i1-final-evidence-guard/1',reviewed:'e62e256',normal,caughtUnexpected,assertionsPassed:true,cloudOperations:0};const text=JSON.stringify(r,null,2)+'\n';const i=process.argv.indexOf('--out');if(i>=0){assert.ok(process.argv[i+1]);fs.writeFileSync(process.argv[i+1],text,{flag:'wx'});}console.log(text);})().catch(e=>{console.error(e);process.exitCode=1;});
