const test = require('node:test');
const assert = require('node:assert/strict');
const { checkEnvGate, TARGET_APPID, TARGET_ENV, ALLOWED_VERSIONS } = require('../miniprogram/utils/env-gate');

const envId = TARGET_ENV;

function setupWx(info) {
  global.wx = {
    getAccountInfoSync: () => {
      if (info === 'throw') throw new Error('getAccountInfoSync unavailable');
      return { miniProgram: info };
    }
  };
}

test('allowed only for target appId and develop/trial', () => {
  for (const envVersion of ALLOWED_VERSIONS) {
    setupWx({ appId: TARGET_APPID, envVersion });
    const result = checkEnvGate(envId);
    assert.equal(result.allowed, true);
    assert.equal(result.appId, TARGET_APPID);
    assert.equal(result.envVersion, envVersion);
  }
});

test('release is denied', () => {
  setupWx({ appId: TARGET_APPID, envVersion: 'release' });
  const result = checkEnvGate(envId);
  assert.equal(result.allowed, false);
  assert.equal(result.reason.includes('正式版'), true);
});

test('unknown or missing envVersion is denied', () => {
  for (const envVersion of ['unknown', undefined, null, '']) {
    setupWx({ appId: TARGET_APPID, envVersion });
    const result = checkEnvGate(envId);
    assert.equal(result.allowed, false);
    assert.equal(result.reason.includes('未识别'), true);
  }
});

test('missing or malformed account info is denied', () => {
  for (const info of [undefined, null, {}, 'throw']) {
    setupWx(info === 'throw' ? info : info);
    const result = checkEnvGate(envId);
    assert.equal(result.allowed, false);
  }
});

test('wrong appId or wrong env is denied', () => {
  setupWx({ appId: 'wrong-appid', envVersion: 'develop' });
  assert.equal(checkEnvGate(envId).allowed, false);
  setupWx({ appId: TARGET_APPID, envVersion: 'develop' });
  assert.equal(checkEnvGate('wrong-env').allowed, false);
});
