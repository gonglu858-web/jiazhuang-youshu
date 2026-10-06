'use strict';
// 只验证已取得 SDK 的参数转换；不连接真实数据库，不实现初始化适配器。
// 输出仅到 stdout；调用方负责以新路径保存。无凭据读取、无安装。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let networkAttempts = 0;
const block = () => { networkAttempts++; throw new Error('OFFLINE_ONLY'); };
for (const [name, methods] of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']]]) {
  const m = require(name); for (const key of methods) m[key] = block;
}
require('node:net').Socket.prototype.connect = block;
globalThis.fetch = block;
const files = ['wx-server-sdk/package.json','@cloudbase/node-sdk/package.json','@cloudbase/node-sdk/lib/index.js','@cloudbase/database/package.json','@cloudbase/database/dist/commonjs/index.js','@cloudbase/database/dist/commonjs/transaction/index.js','@cloudbase/database/dist/commonjs/document.js'];
const inventory = files.map(p => ({path:path.join(root,p),sha256:hash(path.join(root,p))}));
const sdk = require(path.join(root,'@cloudbase/node-sdk'));
const { Db } = require(path.join(root,'@cloudbase/database'));
const db = sdk.init({env:'offline-shape-only',secretId:'SYNTHETIC',secretKey:'SYNTHETIC',throwOnCode:true}).database();
const calls = [];
let failureCode = '';
Db.reqClass = class {
  async send(action, params = {}) {
    calls.push({action,params});
    if(failureCode) return {code:failureCode,message:'synthetic rejection'};
    if(action==='database.startTransaction')return {transactionId:'offline-tx'};
    if(action==='database.getDocument')return {data:{list:[]},requestId:'offline-get'};
    if(action==='database.modifyDocument')return {data:{updated:0,upsert_id:'primary'},requestId:'offline-set'};
    if(action==='database.commitTransaction'||action==='database.abortTransaction')return {requestId:'offline-end'};
    throw new Error('unexpected SDK action');
  }
};
(async()=>{
  const checks=[];
  const tx=await db.startTransaction();
  assert.equal(typeof tx.collection,'function'); checks.push('startTransaction returns collection/commit/rollback transaction');
  const ref=tx.collection('schtest_v1_app_admins').doc('primary');
  assert.equal((await ref.get()).data,null); checks.push('successful empty transport list maps to transaction data:null');
  const before=calls.length;
  await assert.rejects(ref.set({_id:'primary',userId:'synthetic-user',status:'active'}));
  assert.equal(calls.length,before); checks.push('set with _id rejected before transport');
  await ref.set({userId:'synthetic-user',status:'active'});
  const set=calls.at(-1);
  assert.equal(set.action,'database.modifyDocument');
  assert.deepEqual(JSON.parse(set.params.query),{_id:'primary'});
  assert.deepEqual(JSON.parse(set.params.data),{userId:'synthetic-user',status:'active'});
  assert.equal(set.params.transactionId,'offline-tx');
  assert.equal(set.params.upsert,true); checks.push('bare set body serialized without data wrapper, id in query, same transactionId');
  failureCode='SYNTHETIC_PERMISSION_DENIED';
  const denied=await ref.get();
  assert.equal(denied.code,failureCode); assert.equal(denied.data,undefined);
  checks.push('synthetic code-bearing transport result returned by document get, must not normalize to missing');
  await assert.rejects(tx.commit(),e=>e.code===failureCode);
  checks.push('commit code-bearing failure thrown');
  failureCode=''; await tx.rollback(); checks.push('rollback dispatches database.abortTransaction');
  const outside=await db.collection('schtest_v1_app_admins').doc('primary').get();
  assert.deepEqual(outside.data,[]); checks.push('nontransaction successful empty read maps to data:[]');
  assert.equal(networkAttempts,0);
  console.log(JSON.stringify({observedAt:new Date().toISOString(),scope:'real installed SDK with synthetic request transport; no cloud execution',sdkVersion:sdk.version,databaseVersion:require(path.join(root,'@cloudbase/database/package.json')).version,inventory,checks,passed:checks.length,networkAttempts,actions:calls.map(x=>x.action),limitations:['Missing response was synthesized, not observed on platform','No IAM/signature/credential/platform transaction/atomicity/fees verified','Db.reqClass replaced only in this process','No primary record created; transport set is synthetic']},null,2));
})().catch(e=>{console.error('OFFLINE_SHAPE_CHECK_FAILED',e.code||e.name);process.exitCode=1;});
