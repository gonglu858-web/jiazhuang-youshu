'use strict';
// 只读本地文件核对；不生成真实计划、口令或开启包，不调用 CLI。
const fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const hits = [], restore = [];
function guard(o, k) { if (typeof o[k] !== 'function') return; const old=o[k]; o[k]=()=>{hits.push(k);throw Error('OFFLINE_ONLY');};restore.push(()=>{o[k]=old;}); }
for (const id of ['node:http','node:https']) for(const k of ['request','get']) guard(require(id),k);
for(const k of ['connect','createConnection']) guard(require('node:net'),k);
guard(require('node:tls'),'connect');guard(globalThis,'fetch');
for(const k of ['lookup','resolve','resolve4','resolve6']) {guard(require('node:dns'),k);guard(require('node:dns').promises,k);}
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) guard(require('node:child_process'),k);
try {
  assert.throws(()=>require('node:https').request('https://example.invalid'),/OFFLINE_ONLY/);
  assert.throws(()=>require('node:child_process').spawn('node',[]),/OFFLINE_ONLY/);
  const sensitivity=hits.length;
  const pins={
    'miniapp/scripts/lib/participant-identity-check.cjs':'c516c2610ed751d858f5f963d652237edc9106e04d01796d484ae23f48d5843a',
    'miniapp/scripts/package-participant-identity-check.cjs':'3ae3ae91de3fcaa7d28d67fa8a11cdf2fe67759955044f40733225fc616be352',
    'miniapp/scripts/templates/participant-identity-check/server/package.json':'e7b16fdd6e5df8b4aa150f456f933be15dbe42bc1f1bce7f003dad09202618d9'
  };
  for(const [rel,digest] of Object.entries(pins)) assert.equal(sha(fs.readFileSync(path.join(ROOT,rel))),digest);
  const sourceRel='artifacts/schedule-sandbox/business-test/pic-close-source-8b3a3b71-a82570';
  const source=path.join(ROOT,sourceRel), base=path.join(source,'close');
  const business=require(path.join(ROOT,'miniapp/scripts/package-business-test.cjs'));
  const checked=business.checkCloseDir(source);
  assert.equal(checked.ok,true);assert.equal(checked.files,23);assert.equal(checked.expectedFiles,23);
  function walk(dir,out=[]) {for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),s=fs.lstatSync(p);assert(!s.isSymbolicLink());if(s.isDirectory())walk(p,out);else {assert(s.isFile());out.push(p);}}return out;}
  const files=walk(base).map(p=>({rel:path.relative(base,p).split(path.sep).join('/'),sha256:sha(fs.readFileSync(p))})).sort((a,b)=>a.rel<b.rel?-1:a.rel>b.rel?1:0);
  const listSha=sha(files.map(x=>x.rel+' '+x.sha256).join('\n')+'\n');
  assert.equal(listSha,'b009ae06f111c4950d3d2c3b6d2b1edbdad913d43735bc1a67c86ec70b6b371d');
  const sdkBase='C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
  const sdkVersion=JSON.parse(fs.readFileSync(path.join(sdkBase,'wx-server-sdk/package.json'))).version;
  const dbVersion=JSON.parse(fs.readFileSync(path.join(sdkBase,'@cloudbase/database/package.json'))).version;
  assert.equal(sdkVersion,'3.0.1');assert.equal(dbVersion,'1.4.1');
  const cli=require(path.join(ROOT,'miniapp/scripts/lib/cloudbase-readonly-observer.cjs'));
  const cliSha=sha(fs.readFileSync(cli.FIXED.cliEntry));
  assert.equal(cliSha,'328da4af4726c2aa4b20cf9b2e1a3614e4f22bf2e8fb8cb6d601692180de926b');
  assert(fs.existsSync(cli.FIXED.nodeBin));assert.equal(hits.length,sensitivity);
  const report={schema:'codex-i1-local-prerequisites/1',basisCommit:'c7f5da9',observedAt:new Date().toISOString(),sourcePins:pins,closeSource:{path:sourceRel,files:23,checkOk:true,listSha256:listSha,filesSha256:files},localSdk:{sdkVersion,dbVersion},cli:{entrySha256:cliSha,nodeExists:true,invoked:false},guard:{sensitivityAttempts:sensitivity,unexpectedAttempts:hits.length-sensitivity},remoteChecked:false,credentialsFetched:false,realPlanCreated:false,passphraseCreated:false};
  const body=JSON.stringify(report,null,2)+'\n';
  if(process.argv.length===2)process.stdout.write(body);
  else if(process.argv.length===4&&process.argv[2]==='--out')fs.writeFileSync(path.resolve(process.argv[3]),body,{flag:'wx'});
  else throw Error('usage: node script.cjs [--out <new-path>]');
} finally {for(const f of restore.reverse())f();}
