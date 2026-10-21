'use strict';
// 登记页专用客户端（participant-self-registration-request/1 协议；单一 registerSelf 动作）。
//
// - 发送前置校验（沿用只读包 R1 口径）：registrationBuildId 缺失/非法、登记轮次非法、
//   协议非 participant-self-registration-request/1、函数非 scheduleSandbox 一律在
//   wx.cloud.callFunction 之前拒绝——零发送、无 handoffAttempted=true 假事实。
// - 本机快照（participant-self-registration-local/1）：同一 payload 紧邻调用前采集、
//   冻结；服务端同名字段不能覆盖。
// - C1 口径：transportOutcome='returned' 仅表示 SDK Promise 兑现，不保证存在有效
//   服务端结果（result 可为 null）；页面按失败/未知处理。
// - 无自动重试、无回退、无旧动作兼容。

const cloudConfig = require('../config/cloud');

const LOCAL_EVIDENCE_SCHEMA = 'participant-self-registration-local/1';
const REQUEST_PROTOCOL = 'participant-self-registration-request/1';
const FIXED_FUNCTION_NAME = 'scheduleSandbox';
const ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const BUILD_ID_RE = /^[0-9a-f]{64}$/;

function captureLocalRequestEvidence(payload) {
  const pic = payload && payload.picRequest;
  const requestRoundId = pic && typeof pic.registrationRoundId === 'string' ? pic.registrationRoundId : '';
  const schema = pic && typeof pic.schema === 'string' ? pic.schema : '';
  const registrationBuildId = typeof cloudConfig.registrationBuildId === 'string' ? cloudConfig.registrationBuildId : '';
  const functionName = typeof cloudConfig.functionName === 'string' ? cloudConfig.functionName : '';
  const configProtocol = typeof cloudConfig.requestProtocol === 'string' ? cloudConfig.requestProtocol : '';
  if (!ROUND_ID_RE.test(requestRoundId)) return null;
  if (!BUILD_ID_RE.test(registrationBuildId)) return null;
  if (configProtocol !== REQUEST_PROTOCOL) return null;
  if (schema !== configProtocol || schema !== REQUEST_PROTOCOL) return null;
  if (functionName !== FIXED_FUNCTION_NAME) return null;
  return Object.freeze({
    schema: LOCAL_EVIDENCE_SCHEMA,
    registrationBuildId: registrationBuildId,
    requestRoundId: requestRoundId,
    requestProtocol: cloudConfig.requestProtocol,
    functionName: functionName,
    handoffAttempted: true
  });
}

function callSelfRegistration(request) {
  if (!request || typeof request !== 'object') {
    return Promise.reject(new Error('请求参数无效'));
  }
  if (request.action !== 'registerSelf') {
    return Promise.reject(new Error('本客户端只提供本人登记动作'));
  }
  if (!wx.cloud) {
    return Promise.reject(new Error('运行环境不可用'));
  }
  if (!wx.cloud._selfRegistrationEnvInited) {
    wx.cloud.init({ env: cloudConfig.envId, traceUser: false });
    wx.cloud._selfRegistrationEnvInited = true;
  }
  const payload = {
    picRequest: {
      schema: cloudConfig.requestProtocol,
      action: request.action,
      registrationRoundId: cloudConfig.registrationRoundId,
      passphrase: request.passphrase
    }
  };
  const localRequestEvidence = captureLocalRequestEvidence(payload);
  if (!localRequestEvidence) {
    return Promise.reject(new Error('本机登记参数校验未通过，本次未发送请求'));
  }
  const onSettled = res => {
    const result = (res && res.result) || null;
    // C1 口径：returned 仅表示 SDK Promise 兑现，不保证有效服务端结果
    return Object.freeze({ response: result, localRequestEvidence: localRequestEvidence, transportOutcome: 'returned' });
  };
  const onFailed = () => Object.freeze({ response: null, localRequestEvidence: localRequestEvidence, transportOutcome: 'failed' });
  try {
    return wx.cloud.callFunction({
      name: cloudConfig.functionName,
      data: payload
    }).then(onSettled, onFailed);
  } catch (_) {
    return Promise.resolve(onFailed());
  }
}

module.exports = { callSelfRegistration };
