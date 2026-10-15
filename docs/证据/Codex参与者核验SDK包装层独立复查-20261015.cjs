'use strict';
// 离线复查：运行本机 wx-server-sdk 3.0.1 包装层与 @cloudbase/database 1.4.1。
// 只替换 node-sdk 初始化及数据库传输；不加载真实凭据，不访问平台。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const sdkBase = 'C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules';
const hits = [];
const undo = [];
function block(mod, method) {
  if (typeof mod[method] !== 'function') return;
  const original = mod[method];
  mod[method] = function () { hits.push(method); throw new Error('OFFLINE_GUARD'); };
  undo.push(() => { mod[method] = original; });
}
for (const id of ['node:http', 'node:https']) for (const method of ['get', 'request']) block(require(id), method);
for (const method of ['connect', 'createConnection']) block(require('node:net'), method);
block(require('node:tls'), 'connect');
for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6']) block(require('node:dns'), method);
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) block(require('node:child_process'), method);
block(globalThis, 'fetch');

async function main() {
  const wxPkg = JSON.parse(fs.readFileSync(path.join(sdkBase, 'wx-server-sdk/package.json'), 'utf8'));
  const dbPkg = JSON.parse(fs.readFileSync(path.join(sdkBase, '@cloudbase/database/package.json'), 'utf8'));
  const candidatePkg = JSON.parse(fs.readFileSync(path.join(root,
    'miniapp/scripts/templates/participant-identity-check/server/package.json'), 'utf8'));
  assert.equal(wxPkg.version, '3.0.1');
  assert.equal(dbPkg.version, '1.4.1');
  assert.equal(candidatePkg.dependencies['wx-server-sdk'], '~2.6.3');

  const tcb = require(path.join(sdkBase, '@cloudbase/node-sdk'));
  const database = require(path.join(sdkBase, '@cloudbase/database'));
  const ejson = require(path.join(sdkBase, '@cloudbase/database/dist/commonjs/utils/utils.js'));
  const originalInit = tcb.init;
  const originalReqClass = database.Db.reqClass;
  const sent = [];
  const row = { _id: 'u_' + 'a'.repeat(40), openid: 'synthetic-openid', status: 'active' };
  class LocalTransport {
    async send(action, params) {
      assert.equal(action, 'database.getDocument');
      sent.push({ action, projection: params.projection });
      if (sent.length === 1) return {
        data: { list: [ejson.stringifyByEJSON(row)], offset: 0, limit: 1 }, requestId: 'synthetic-hit'
      };
      if (sent.length === 2) return {
        data: { list: [], offset: 0, limit: 1 }, requestId: 'synthetic-miss'
      };
      return { code: 'DATABASE_PERMISSION_DENIED', requestId: 'synthetic-denied' };
    }
  }
  try {
    database.Db.reqClass = LocalTransport;
    tcb.init = () => ({
      logger: () => {},
      database: () => new database.Db({ env: 'synthetic-local' })
    });
    const wx = require(path.join(sdkBase, 'wx-server-sdk'));
    wx.init({ env: 'synthetic-local' });
    const db = wx.database({ throwOnNotFound: false });
    const read = () => db.collection('schtest_v1_users').doc(row._id)
      .field({ _id: true, openid: true, status: true }).get();
    const hit = await read();
    const miss = await read();
    let denied = null;
    try { await read(); } catch (error) { denied = error; }
    assert.deepEqual(hit.data, row);
    assert.equal(miss.data, null);
    assert.ok(denied instanceof Error);
    assert.equal(sent.length, 3);
    for (const item of sent) {
      const projection = ejson.parseByEJSON(item.projection);
      assert.deepEqual(projection, { _id: 1, openid: 1, status: 1 });
    }
    assert.equal(hits.length, 0, '业务期没有网络或子进程尝试');
    return {
      schema: 'codex-participant-sdk-wrapper-review/1',
      reviewedCommit: 'c9df59b',
      sdkVersion: wxPkg.version,
      databaseVersion: dbPkg.version,
      candidateDeclaredVersion: candidatePkg.dependencies['wx-server-sdk'],
      transport: 'synthetic local; node-sdk init and Db.reqClass replaced',
      exists: 'single object', absent: 'null', failure: 'rejected',
      projection: { _id: 1, openid: 1, status: 1 }, calls: sent.length,
      unexpectedGuardAttempts: hits.length,
      caveat: '未运行 ~2.6.3；未访问真实平台；关闭包部署映射未在此脚本验证',
      scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
    };
  } finally {
    tcb.init = originalInit;
    database.Db.reqClass = originalReqClass;
  }
}

main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
  .catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; })
  .finally(() => { for (const fn of undo.reverse()) fn(); });
