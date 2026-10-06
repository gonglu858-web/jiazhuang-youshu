// 开发/体验版临时测试入口的环境隔离。
// 仅允许目标 AppID 的 develop/trial 版本访问测试功能；异常、未知、缺失 envVersion 均拒绝。
// 此限制在客户端，不替代服务端权限验证。

const TARGET_APPID = 'wxfb4db1615ac15531';
const TARGET_ENV = 'cloud1-d8gcq5ag39d847723';
const ALLOWED_VERSIONS = Object.freeze(['develop', 'trial']);

function checkEnvGate(configuredEnv, api) {
  if (!api && typeof wx !== 'undefined') api = wx;
  let info;
  try {
    if (!api || typeof api.getAccountInfoSync !== 'function') throw new Error('wx api unavailable');
    info = api.getAccountInfoSync().miniProgram;
  } catch (error) {
    return { allowed: false, reason: '无法读取当前小程序账号信息，测试入口不可用。' };
  }
  if (!info || typeof info !== 'object') {
    return { allowed: false, reason: '当前小程序账号信息异常，测试入口不可用。' };
  }
  if (info.appId !== TARGET_APPID) {
    return { allowed: false, reason: '仅目标小程序可使用测试入口。' };
  }
  if (configuredEnv !== TARGET_ENV) {
    return { allowed: false, reason: '仅目标云环境可使用测试入口。' };
  }
  if (!ALLOWED_VERSIONS.includes(info.envVersion)) {
    return { allowed: false, reason: '仅开发版/体验版可使用测试入口，正式版或未识别版本不可用。' };
  }
  return { allowed: true, reason: '', appId: info.appId, envVersion: info.envVersion };
}

module.exports = { checkEnvGate, TARGET_APPID, TARGET_ENV, ALLOWED_VERSIONS };
