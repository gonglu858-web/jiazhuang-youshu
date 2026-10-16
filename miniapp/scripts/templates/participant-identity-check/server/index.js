'use strict';
// 两位参与者「本人身份只读核验包」云函数候选入口（本地模板，未部署）。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §3/§5
//
// 与既有业务入口的关系（刻意不做的每一条）：
// - **不 require vendor/service**（含 identify/execute），因此不存在建用户、
//   写审计、授予角色、取号、建项目的可能路径；
// - **不 require memberAccess / connectionCheck / project-guard / gate**；
// - 只 require 本次新增的只读核心模块 participant-identity-check；
// - 可信 APPID/OPENID 只来自 cloud.getWXContext()，环境来自受审运行环境
//   （process.env.TCB_ENV），请求体中的自报值一概不采信。
//
// 本文件由 package-participant-identity-check.cjs 以**唯一锚点替换**方式装配：
// CONFIG_* 常量为默认拒绝值（enabled:false、空口令摘要、窗口为 0 长度），
// 由打包器写入本轮真实值；源码漂移即拒绝打包。

const cloud = require('wx-server-sdk');
const identityCheck = require('./participant-identity-check');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ── 本轮配置（打包器按唯一锚点替换以下各行） ────────────────────────────────
const CONFIG_ENABLED = false;
const CONFIG_APP_ID = '';
const CONFIG_ENV_ID = '';
const CONFIG_CHECK_ROUND_ID = '';
// 服务端**只含口令摘要**：明文口令不进入任何制品、日志或证据。
const CONFIG_PASSPHRASE_DIGEST = '';
const CONFIG_WINDOW_STARTS_AT_MS = 0;
const CONFIG_WINDOW_EXPIRES_AT_MS = 0;
// 受控键诊断开关：默认关闭；仅具体诊断轮由打包器按计划锚点替换开启。
// 开启后也只在动作/轮次/口令/可信目标/当下窗口全部通过时附加净化诊断（见核心 §12）。
const CONFIG_KEY_DIAGNOSTIC = false;

function readTrustedRuntime() {
  let ctx = {};
  try {
    ctx = cloud.getWXContext() || {};
  } catch (error) {
    ctx = {};
  }
  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || '';
  return {
    appId: typeof ctx.APPID === 'string' ? ctx.APPID : '',
    envId: typeof envId === 'string' ? envId.trim() : '',
    openid: typeof ctx.OPENID === 'string' ? ctx.OPENID : ''
  };
}

exports.main = async event => {
  const trusted = readTrustedRuntime();
  // 开关默认关闭；未开启时零数据库访问、不接受任何口令。
  if (CONFIG_ENABLED !== true || CONFIG_APP_ID !== identityCheck.FIXED_TARGET.appId ||
      CONFIG_ENV_ID !== identityCheck.FIXED_TARGET.envId) {
    return {
      schema: identityCheck.RESULT_SCHEMA,
      ok: false,
      identityConfirmed: false,
      registrationState: 'UNKNOWN',
      recordMatched: null,
      readAttempted: false,
      userIdTail: '',
      code: 'PIC_NOT_ENABLED',
      message: '本人身份核验入口未开启。'
    };
  }
  // 数据库句柄只在开关与目标校验通过后建立（默认关闭分支完全不触碰数据库）。
  const db = cloud.database({ throwOnNotFound: false });
  const checker = identityCheck.createIdentityChecker({
    db,
    trusted,
    config: {
      checkRoundId: CONFIG_CHECK_ROUND_ID,
      passphraseDigest: CONFIG_PASSPHRASE_DIGEST,
      windowStartsAtMs: CONFIG_WINDOW_STARTS_AT_MS,
      windowExpiresAtMs: CONFIG_WINDOW_EXPIRES_AT_MS,
      keyDiagnostic: CONFIG_KEY_DIAGNOSTIC
    }
  });
  return checker.handle(event);
};