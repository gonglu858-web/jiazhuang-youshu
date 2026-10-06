// 使用已取得的部署包 SDK，无须安装依赖：设置 MEMBER_ACCESS_SDK_PATH 为 wx-server-sdk 目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sdkPath = process.env.MEMBER_ACCESS_SDK_PATH;
test('实际 SDK：入口允许空负责人记录，仍拒绝权限和网络错误，全程无业务写入',
  { skip: !sdkPath && '未指定已取得的 wx-server-sdk 路径' }, async () => {
    let networkAttempts = 0;
    const originals = [];
    const block = () => { networkAttempts++; throw new Error('LOCAL_NETWORK_DISABLED'); };
    for (const [moduleName, keys] of [
      ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
      ['node:net', ['connect', 'createConnection']]
    ]) {
      const mod = require(moduleName);
      for (const key of keys) { originals.push([mod, key, mod[key]]); mod[key] = block; }
    }
    const socket = require('node:net').Socket.prototype;
    originals.push([socket, 'connect', socket.connect]); socket.connect = block;
    try {
      const cloud = require(sdkPath);
      assert.equal(require(path.join(sdkPath, 'package.json')).version, '3.0.1');
      cloud.init({ env: 'local-sdk-regression-no-network' });
      const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/memberAccess/index.js'), 'utf8');
      const service = require('../cloudfunctions/memberAccess/service');
      for (const failure of [null, 'LOCAL_PERMISSION_DENIED', 'LOCAL_NETWORK_FAILURE']) {
        let reads = 0;
        const logged = [];
        const exports = {};
        const shim = {
          DYNAMIC_CURRENT_ENV: 'local-sdk-regression-no-network', init() {},
          getWXContext: () => ({ APPID: service.APPID, OPENID: 'LOCAL_FAKE_ACCOUNT' }),
          database(config) {
            const db = cloud.database(config);
            db._db.runTransaction = async callback => callback({
              collection(name) {
                assert.equal(name, 'app_admins');
                return { doc(id) {
                  assert.equal(id, 'primary');
                  return { async get() {
                    reads++;
                    if (failure) throw new Error(failure);
                    return { data: null };
                  } };
                } };
              }
            });
            return db;
          }
        };
        vm.runInNewContext(source, { exports,
          require(name) {
            if (name === 'wx-server-sdk') return shim;
            if (name === './service') return service;
            throw new Error(`Unexpected dependency: ${name}`);
          }, console: { error: (...args) => logged.push(args.join(' ')) }
        });
        const result = await exports.main({ action: 'checkTransaction' });
        assert.equal(reads, 1);
        if (!failure) {
          assert.equal(result.ok, true);
          assert.equal(result.transactionReady, true);
          assert.equal(logged.length, 0);
        } else {
          assert.equal(result.ok, false);
          assert.equal(result.code, 'SERVER_ERROR');
          assert.ok(logged.some(line => line.includes(failure)));
        }
      }
      assert.equal(networkAttempts, 0);
    } finally {
      for (const [mod, key, original] of originals) mod[key] = original;
    }
  });
