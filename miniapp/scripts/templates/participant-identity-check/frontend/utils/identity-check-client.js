// 核验页专用客户端：固定环境/固定函数，单一动作，失败不回退。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §5
// - 显式固定环境与函数名，不接受调用方指定目标，不做全局重定向。
// - **禁止失败后回退旧函数/旧客户端/本机保存**，也不做任何本地重试。
// - 请求体只含 action 与口令；不接受自报 openid/appId/userId/集合/角色。

const cloudConfig = require('../config/cloud');

function callIdentityCheck(request) {
  if (!request || typeof request !== 'object') {
    return Promise.reject(new Error('请求参数无效'));
  }
  if (request.action !== 'inspectSelf') {
    // 非核验动作零请求。
    return Promise.reject(new Error('本客户端只提供本人身份只读核验'));
  }
  if (!wx.cloud) {
    return Promise.reject(new Error('运行环境不可用'));
  }
  // 只初始化一次固定环境；不读取任何本机缓存或历史目标。
  if (!wx.cloud._identityCheckEnvInited) {
    wx.cloud.init({ env: cloudConfig.envId, traceUser: false });
    wx.cloud._identityCheckEnvInited = true;
  }
  return wx.cloud.callFunction({
    name: cloudConfig.identityCheckFunction,
    data: { action: request.action, passphrase: request.passphrase }
  }).then(res => (res && res.result) || null);
}

module.exports = { callIdentityCheck };
