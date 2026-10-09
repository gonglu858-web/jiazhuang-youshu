#!/usr/bin/env node
'use strict';
/**
 * CloudBase数据库 SDK 只读观测入口（M3）
 * =====================================================
 *
 * 默认：**本地检查**，不取凭据、不发起任何云调用。
 * 显式 `--read-only`：才进入M1/M2 只读观测。
 * 可选 `--target-user-id <完整userId>`：受信指定查询目标（**参数不构成授权，
 * 也不构成任何现实人员证明**）。
 *
 * 严格边界
 * ──────
 * - **没有**任何跳过检查的开关；**没有**任意 env / 集合 / URL / 认证目录 / 凭据参数。
 * - 未知参数、`--execute`、`--approval` 等一律**在任何云调用之前**拒绝。
 * - 输出**只有**净化 JSON：不含凭据、原始 OPENID、完整记录、签名头、SDK 实例/配置对象、
 *   原始错误/stack/cause。
 * - 与既有 CLI 只读入口一致：拒绝与失败均以退出码 1 结束（非零），便于脚本判定。
 * - 所有分支 `writeAuthorized=false`、`productionCallerVerifierImplemented=false`。
 * - 本入口**不是**授权器：不实现/替换 P4 `verifyCaller`，不生成允许名单或初始化计划。
 *
 * 本轮（离线实现）说明
 * ──────────────────
 * 默认模式只做本地检查；`--read-only` 在**未注入真实凭据来源**时会如实以
 * `SAME_BATCH_NOT_PROVEN` 停止 —— 不用合成授权冒充生产核验。
 */

const observer = require('./lib/cloudbase-sdk-readonly-observer.cjs');

async function main() {
  const argv = process.argv.slice(2);

  // 参数解析：**任何云调用之前**完成；非法参数直接退出
  let options;
  try {
    options = observer.parseArgs(argv);
  } catch (error) {
    process.stdout.write(JSON.stringify({
      schemaVersion: observer.SCHEMA_VERSION,
      mode: 'rejected',
      status: observer.STATUS.FAILED,
      errorCode: error.code || observer.ERR.ARG_UNKNOWN,
      note: '参数被拒绝；未取凭据、未发起任何云调用。',
      writeAuthorized: false,
      productionCallerVerifierImplemented: false
    }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    if (options.mode === 'read-only') {
      report = await observer.runReadOnlyObservation(options, {});
    } else {
      report = await observer.runLocalCheck({});
    }
  } catch (error) {
    // 兜底：只输出固定错误码，不外传 stack/cause/message
    report = {
      schemaVersion: observer.SCHEMA_VERSION,
      mode: options.mode,
      status: observer.STATUS.FAILED,
      errorCode: (error && error.code) || 'UNEXPECTED',
      note: '执行未完成；未发起超出授权范围的调用。',
      writeAuthorized: false,
      productionCallerVerifierImplemented: false
    };
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.status === observer.STATUS.FAILED ? 1 : 0;
}

main();