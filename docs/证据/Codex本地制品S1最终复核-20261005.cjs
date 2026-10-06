'use strict';
// 复用上一轮独立反例的内存副本，保留原脚本/原结果，输出到本轮新证据。
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const crypto=require('node:crypto');
const original=path.join(__dirname,'Codex本地制品S1S3复核-20261005.cjs');
const historic=[original,path.join(__dirname,'Codex本地制品S1S3复核-20261005.json'),path.join(__dirname,'本地制品S1缺文件回归修复复现-20261005.cjs'),path.join(__dirname,'本地制品S1缺文件回归修复复现-20261005.json')];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before=historic.map(hash);
let source=fs.readFileSync(original,'utf8');
function replaceOnce(from,to){assert.equal(source.split(from).length-1,1);source=source.replace(from,to);}
replaceOnce("'Codex本地制品S1S3复核-20261005.json'","'Codex本地制品S1最终复核-20261005.json'");
replaceOnce('  const candidate = JSON.parse(', `  // 新断言：上轮两个失败样本现在都必须在写入前拒绝。
  for(const r of results.filter(r=>r.case.startsWith('manifest + missing'))) {
    assert.match(r.generationError,/manifest 声明了但包体缺失/);
    assert.equal(r.indexCreated,false);
    assert.equal(r.manifestUnchanged,true);
    assert.equal(r.generationMode,null);
    r.passed=true;
  }
  // 正向：无 manifest 的合法半成品可续建且复用 gate。
  {
    const out=path.join(tmp,'valid-partial');
    fs.mkdirSync(path.join(out,'package'),{recursive:true});
    const gate=path.join(out,'package/gate.js');
    fs.copyFileSync(path.join(p.SOURCE_DIR,'gate.js'),gate);
    const gateHash=hash(gate);
    const result=p.buildPackage(options(out));
    assert.equal(result.mode,'created');
    assert.equal(result.written.find(x=>x.path==='gate.js').action,'reused');
    assert.equal(hash(gate),gateHash);
    assert.equal(p.buildPackage({...options(out),checkOnly:true}).mode,'check');
    results.push({case:'no manifest valid partial',passed:true,gateReused:true,gateUnchanged:true,checkPasses:true});
  }
  const candidate = JSON.parse(`);
replaceOnce("  'docs/证据/本地制品S1S3收尾复现-20261005.cjs',", "  'docs/证据/本地制品S1缺文件回归修复复现-20261005.cjs',\n  'docs/证据/本地制品S1缺文件回归修复复现-20261005.json',\n  'docs/证据/本地制品S1S3收尾复现-20261005.cjs',");
replaceOnce('newFrozen:Object.isFrozen(newProof)', 'newFrozen:Object.isFrozen(newProof),newArrayFrozen:Object.isFrozen(newProof.allowedVersions),oldArraysFrozen:Object.isFrozen(oldProof.allowedProjectIds)&&Object.isFrozen(oldProof.allowedVersions)');
const run=vm.runInThisContext('(function(require,__dirname){'+source+'\n})',{filename:__filename});
run(createRequire(original),__dirname);
assert.deepEqual(historic.map(hash),before,'历史证据与交付方证据不得改写');
console.log('本轮三个关键分支断言通过；历史与交付证据未变。');
