'use strict';
// 独立本地复核；仅操作新建临时目录，不覆盖交付制品或历史证据。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const p = require(path.join(root, 'miniapp/scripts/package-sandbox.cjs'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '独立测试副本执行包本地基线-20261005.json'), 'utf8'));
const baselineResult = { count: Object.keys(baseline.files).length, missing: [], changed: [] };
for (const [rel, expected] of Object.entries(baseline.files)) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) baselineResult.missing.push(rel);
  else if (hash(file) !== expected) baselineResult.changed.push(rel);
}
const protectedPaths = [
  'miniapp/scripts/package-sandbox.cjs', 'miniapp/tests/sandbox-package.test.cjs',
  'docs/独立副本有限测试操作稿-20261005.md',
  'miniapp/cloudbase/schedule-sandbox-resources.candidate.json',
  'artifacts/schedule-sandbox/closed-20261005/manifest.json',
  'artifacts/schedule-sandbox/closed-20261005-r2fix/manifest.json',
  'docs/证据/本地制品S1S3收尾复现-20261005.cjs',
  'docs/证据/本地制品S1S3收尾复现-20261005.json'
];
const hashes = Object.fromEntries(protectedPaths.map(rel => [rel, { bytes: fs.statSync(path.join(root, rel)).size, sha256: hash(path.join(root, rel)) }]));
const tmp = fs.mkdtempSync(path.join(p.ARTIFACTS_ROOT, '.codex-s13-review-'));
const results = [];
const attempt = fn => { try { return { returned: fn() }; } catch (error) { return { error: error.message }; } };
const options = outDir => ({outDir, skipBaseline:true, skipCandidateCheck:true});
function fresh(label) {
  const out = path.join(tmp, label);
  p.buildPackage(options(out));
  return out;
}
try {
  for (const sameLength of [false, true]) {
    const out = path.join(tmp, sameLength ? 'partial-hash' : 'partial-bytes');
    fs.mkdirSync(path.join(out, 'package'), {recursive:true});
    let bytes = fs.readFileSync(path.join(p.SOURCE_DIR, 'gate.js'));
    if (sameLength) { bytes = Buffer.from(bytes); bytes[10] ^= 255; }
    else bytes = Buffer.concat([bytes, Buffer.from('x')]);
    const gate = path.join(out, 'package/gate.js'); fs.writeFileSync(gate, bytes);
    const result = attempt(() => p.buildPackage(options(out)));
    assert.match(result.error, /既有产物包体与源不一致/);
    assert.equal(fs.existsSync(path.join(out, 'package/index.js')), false);
    assert.equal(fs.existsSync(path.join(out, 'manifest.json')), false);
    assert.ok(fs.readFileSync(gate).equals(bytes));
    results.push({case:sameLength ? 'S1a hash' : 'S1a bytes', passed:true, error:result.error.split('\n')[0], newFiles:0});
  }
  for (const field of ['sourceDir','packageDir','sourceKey']) {
    const out = fresh('source-' + field); const mp = path.join(out, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    if (field === 'sourceKey') delete m.files[0].sourceKey;
    else m[field] = 'miniapp/cloudfunctions/memberAccess';
    fs.writeFileSync(mp, JSON.stringify(m));
    const result = attempt(() => p.buildPackage({...options(out), checkOnly:true}));
    assert.match(result.error, /manifest 校验失败/);
    results.push({case:'S1b '+field, passed:true, error:result.error});
  }
  // 单独覆盖 lstat 防线：不改 Dirent，不让额外文件检查替它拒绝。
  {
    const out=fresh('lstat-only'); const target=path.join(out,'package/index.js');
    const original=fs.lstatSync; let hits=0;
    fs.lstatSync=function(file,...args) {
      const stat=original.call(fs,file,...args);
      if(path.resolve(String(file))===target) {
        hits++;
        return new Proxy(stat,{get(obj,key){return key==='isSymbolicLink'?()=>true:Reflect.get(obj,key);}});
      }
      return stat;
    };
    try {
      for (const checkOnly of [true,false]) {
        const result=attempt(()=>p.buildPackage({...options(out),checkOnly}));
        assert.match(result.error,/符号链接|链接条目/);
        results.push({case:'S2 lstat only '+(checkOnly?'check':'generate'),passed:true,error:result.error,synthetic:true});
      }
    } finally {fs.lstatSync=original;}
    assert.ok(hits>0);
  }
  // 防回归：有 manifest 的缺失文件必须在生成前被识别。
  for (const alterMetadata of [false,true]) {
    const out = fresh(alterMetadata ? 'missing-with-conflict' : 'missing-only');
    const mp = path.join(out, 'manifest.json');
    if (alterMetadata) { const m = JSON.parse(fs.readFileSync(mp)); m.purpose = 'changed'; fs.writeFileSync(mp, JSON.stringify(m,null,2)+'\n'); }
    const beforeManifest = hash(mp);
    const target = path.join(out, 'package/index.js');
    fs.unlinkSync(target); // 仅删除刚生成的隔离样本中的文件
    const check = attempt(() => p.buildPackage({...options(out),checkOnly:true}));
    const generation = attempt(() => p.buildPackage(options(out)));
    results.push({case:alterMetadata?'manifest + missing + metadata conflict':'manifest + missing',
      checkError:check.error, generationError:generation.error || null, generationMode:generation.returned?.mode || null,
      indexCreated:fs.existsSync(target), manifestUnchanged:beforeManifest===hash(mp)});
  }
  const candidate = JSON.parse(fs.readFileSync(p.CANDIDATE_PATH, 'utf8'));
  const mutations = [d=>d.function.dependency.wxServerSdk='999.0.0',d=>delete d.function.dependency.wxServerSdk,
    d=>d.function.dependency.packageJson='miniapp/cloudfunctions/memberAccess/package.json',
    d=>d.collections[0].created=true,d=>delete d.collections[0].created,
    d=>delete d.collections[0].ttlEnabled,d=>d.collections[5].ttlEnabled=true];
  for (let i=0;i<mutations.length;i++) {
    const doc=structuredClone(candidate); mutations[i](doc);
    const result=attempt(()=>p.validateCandidateDocument(doc,[],'independent-mutation'));
    assert.match(result.error,/资源候选清单校验失败/);
    results.push({case:'S3 mutation '+(i+1),passed:true,error:result.error});
  }
} finally {
  // 每次递归清理前核实绝对路径与真实路径均在专用制品根内，且目标本身不是链接。
  const rel=path.relative(fs.realpathSync(p.ARTIFACTS_ROOT),fs.realpathSync(tmp));
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  assert.equal(fs.lstatSync(tmp).isSymbolicLink(),false);
  fs.rmSync(tmp,{recursive:true,force:true});
}
const newProof=require(path.join(root,'miniapp/miniprogram/config/schedule-sandbox-proof.js'));
const oldProof=require(path.join(root,'miniapp/miniprogram/config/schedule-entry-proof.js'));
const evidence={date:'2026-10-05',baseline:baselineResult,hashes,results,
  entry:{newEnabled:newProof.enabled,newProjectId:newProof.sandboxProjectId,newRoundId:newProof.roundId,oldEnabled:oldProof.enabled,oldAllowedProjectIds:oldProof.allowedProjectIds,newFrozen:Object.isFrozen(newProof),oldFrozen:Object.isFrozen(oldProof)},
  protectedHashesUnchanged:protectedPaths.every(rel=>hash(path.join(root,rel))===hashes[rel].sha256),
  scope:'仅本地合成样本；无云端调用；不覆盖 WorkBuddy 或既有 Codex 证据'};
fs.writeFileSync(path.join(__dirname,'Codex本地制品S1S3复核-20261005.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
