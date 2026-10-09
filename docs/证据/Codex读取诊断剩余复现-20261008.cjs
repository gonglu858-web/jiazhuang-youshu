'use strict';
// 离线审查：复用已交付的真实worker/真实SDK本地转换夹具，仅扩充合成传输响应。
// 不运行原脚本main、不修改源文件或旧证据，不启动真实CLI或云请求。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const source = path.join(__dirname, 'WorkBuddy读取失败最小诊断复现-20261008.cjs');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function main() {
  assert.equal(sha(source), 'cfa553181de852a6f171643b761e31e59f50908900703c1692235b8cc81f3925');
  const oldJson = source.replace(/\.cjs$/, '.json');
  const oldHash = sha(oldJson);
  let src = fs.readFileSync(source, 'utf8');
  const boundary = src.indexOf('async function main()');
  assert(boundary > 0);
  src = src.slice(0, boundary);
  const spot = 'calls.push(params.collectionName);';
  assert.equal(src.split(spot).length, 2);
  src = src.replace(spot, `${spot}
      if (options.returnedError && params.collectionName === options.returnedCollection) {
        return options.returnedError;
      }`);
  src += '\nmodule.exports={runRealWorkerMain,parentChain,w,o};\n';
  const m = new Module(source, module); m.filename = source; m.paths = module.paths;
  m._compile(src, source);
  const { runRealWorkerMain, parentChain, w, o } = m.exports;
  const target = w.deriveUserId(o.FIXED.wxAppId, 'synthetic-offline-only');
  const uuid = '5dc5d7cb-6deb-42d5-9c36-36a958d574f8';
  const docs = { [w.ADMIN_COLLECTION]: { _id:'primary', userId:target, status:'active' },
    [w.USER_COLLECTION]: { _id:target, status:'active', openid:'synthetic-offline-only' } };
  const results = [];
  for (const [label, collection] of [['primary', w.ADMIN_COLLECTION], ['users', w.USER_COLLECTION]]) {
    for (const code of ['DATABASE_REQUEST_FAILED', 'SYNTHETIC_PRIVATE_UNKNOWN_CODE']) {
      const { result, calls } = await runRealWorkerMain({ targetUserId:target, docs,
        returnedCollection:collection, returnedError:{ code, requestId:uuid, message:'SYNTHETIC_SECRET_MESSAGE' } });
      const chain = parentChain(result, target);
      const rec = label === 'primary' ? chain.primary : chain.target;
      results.push({ id:'returned-error-'+label+'-'+(code==='DATABASE_REQUEST_FAILED'?'known':'unknown'),
        kind:'real-worker-main-with-synthetic-sdk-transport', reads:calls.length,
        workerRecord:label==='primary'?result.primary:result.targetUser,
        topLevel:rec, diagnosticLost:rec.readDiagnostics == null,
        sensitiveMarkerLeaked:JSON.stringify(chain).includes('SYNTHETIC_') });
    }
  }
  const control = await runRealWorkerMain({ targetUserId:null, throwOn:'primary', errorCode:'DATABASE_REQUEST_FAILED', requestId:uuid });
  const controlRec = parentChain(control.result, null).primary;
  results.push({ id:'thrown-error-positive-control', topLevel:controlRec,
    passed:controlRec.readDiagnostics?.errorCode==='DATABASE_REQUEST_FAILED' });
  for (const property of ['message','requestId']) {
    const err = property==='message'?{}:new Error('synthetic');
    Object.defineProperty(err, property, { get() { throw new Error('SYNTHETIC_GETTER'); } });
    let threw=false;
    try { w.buildReadDiagnostics(w.READ_STAGE.PRIMARY, err); } catch (_) { threw=true; }
    results.push({id:'throwing-getter-'+property, diagnosticBuilderThrew:threw});
  }
  results.push({ id:'unrecognised-object-name', diagnostics:w.buildReadDiagnostics(w.READ_STAGE.PRIMARY,{ name:'ApiError' }),
    note:'当前按name分类，无法据此证明异常实际起源；此项仅表述提醒。' });
  const report={kind:'OFFLINE_READ_DIAGNOSTIC_REVIEW', observedAt:new Date().toISOString(),
    productSourceModified:false, realCredentialFetched:false, realCloudCalls:0,
    transport:'真实worker main和真实SDK转换，SDK请求传输由合成类替换；旧脚本main未执行',
    historicalEvidenceUnchanged:sha(oldJson)===oldHash, results,
    summary:{ returnedErrorPaths:4, diagnosticsLost:results.filter(x=>x.diagnosticLost).length,
      throwingGetterPaths:2, diagnosticBuilderThrew:results.filter(x=>x.diagnosticBuilderThrew).length } };
  const out=path.join(__dirname,'Codex读取诊断剩余复现-20261008-'+Date.now()+'-'+crypto.randomUUID()+'.json');
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({evidence:out,summary:report.summary,historicalEvidenceUnchanged:report.historicalEvidenceUnchanged})+'\n');
}
if(require.main===module) main().catch(()=>{process.stderr.write('OFFLINE_DIAGNOSTIC_AUDIT_FAILED\n');process.exitCode=1;});
