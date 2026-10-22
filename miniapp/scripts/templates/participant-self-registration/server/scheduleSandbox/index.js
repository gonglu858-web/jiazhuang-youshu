'use strict';
// 指定本人登记云函数入口（scheduleSandbox 同名函数目录；participant-self-registration 协议）。
//
// CONFIG_ENABLED 默认 false：候选源码默认关闭，仅真实装配（执行包）才置 true。
// CONFIG_ALLOWED_ACCOUNT 仅在真实装配时由已核准私密来源解密注入——完整允许账号会进入
// 服务端候选制品与远端函数代码，如实披露，不宣称只在内存；前端/公开清单/证据不含完整值。
// 全部准入检查在数据库工厂之前；非名单账号零工厂零事务零写。

const CONFIG_ENABLED = false;
const CONFIG_APP_ID = '';
const CONFIG_ENV_ID = '';
const CONFIG_REGISTRATION_ROUND_ID = '';
const CONFIG_PASSPHRASE_DIGEST = '';
const CONFIG_WINDOW_STARTS_AT_MS = 0;
const CONFIG_WINDOW_EXPIRES_AT_MS = 0;
const CONFIG_ALLOWED_ACCOUNT = '';
const CONFIG_USERS_COLLECTION = 'schtest_v1_users';
const CONFIG_AUDIT_COLLECTION = 'schtest_v1_audit_events';
const CONFIG_SOURCE_PROTOCOL = 'participant-self-registration/1';
const CONFIG_SYNTHETIC = false;

const cloud = require('wx-server-sdk');
const adapter = require('./request-adapter');
const registrationCore = require('./participant-self-registration');

cloud.init({ env: CONFIG_ENV_ID || 'cloud1-d8gcq5ag39d847723', traceUser: false });

function sanitized(errorLike) {
  return {
    schema: registrationCore.RESULT_SCHEMA,
    outcome: 'REJECTED_NO_WRITE',
    code: 'PIC_REQUEST_INVALID',
    registrationRoundId: null,
    userIdTail: null,
    writeAttempted: false,
    commitConfirmed: false,
    readBack: { user: false, audit: false },
    message: '请求校验未通过'
  };
}

exports.main = async (event) => {
  if (!CONFIG_ENABLED) {
    return {
      schema: registrationCore.RESULT_SCHEMA, outcome: 'REJECTED_NO_WRITE', code: 'PIC_CONFIG_DISABLED',
      registrationRoundId: null, userIdTail: null, writeAttempted: false, commitConfirmed: false,
      readBack: { user: false, audit: false }, message: '登记入口未启用'
    };
  }
  const parsed = adapter.extractBusinessRequest(event);
  if (!parsed.ok) return sanitized();
  const wxContext = cloud.getWXContext();
  const checker = registrationCore.createSelfRegistrationChecker({
    // R1：数据库工厂后置——核心在全部准入通过后才调用 cloud.database()；
    // 非名单/错轮次/错口令等拒绝时零 database/collection/事务/写。
    // R2（2026-10-22 复查）：真实 wx-server-sdk 3.0.1 的 document.get 默认
    // throwOnNotFound=true——事务内读取不存在的本人用户会抛错并中止事务，
    // 导致"不存在→新增"路径必然 PIC_TRANSACTION_FAILED。显式传
    // { throwOnNotFound: false } 使未命中返回 {data:null}（明确不存在形状），
    // 与核心的事务形状判定一致；移除该参数的敏感性由测试以真实 SDK 转换证明。
    dbFactory: cloud.database ? () => cloud.database({ throwOnNotFound: false }) : null,
    trusted: { appId: wxContext.APPID, envId: CONFIG_ENV_ID, OPENID: wxContext.OPENID },
    config: {
      registrationRoundId: CONFIG_REGISTRATION_ROUND_ID,
      passphraseDigest: CONFIG_PASSPHRASE_DIGEST,
      allowedAccount: CONFIG_ALLOWED_ACCOUNT,
      windowStartsAtMs: CONFIG_WINDOW_STARTS_AT_MS,
      windowExpiresAtMs: CONFIG_WINDOW_EXPIRES_AT_MS,
      usersCollection: CONFIG_USERS_COLLECTION,
      auditCollection: CONFIG_AUDIT_COLLECTION,
      sourceProtocol: CONFIG_SOURCE_PROTOCOL,
      synthetic: CONFIG_SYNTHETIC
    },
    now: () => Date.now()
  });
  try {
    return await checker.handle(parsed.request);
  } catch (_) {
    // 核心层异常一律净化；不外露原始 SDK 错误/堆栈
    return sanitized();
  }
};
