#!/usr/bin/env node
// 施工安排独立测试副本：P4 首次管理员初始化的**本地计划检查 CLI**。
//
// 依据：任务文档 §7.3。
//
// 严格边界：
// - **默认行为无网络、无写入**：只做本地计划字段校验。
// - `--execute` **一律明确拒绝**：真实管理事务适配器未核验，不发送任何请求。
//   不加载全局 SDK、不读密钥文件、不回退到管理 API 逐条写。
// - **不接受**任意适配器文件路径来绕过（没有 `--adapter` 参数）。
// - 可以列出已声明依赖的 SDK 路径/版本事实，但**不打印**认证文件或密钥；
//   本轮**不安装**任何依赖，也不声称现有只读管理工具能完成事务。
//
// 用法：
//   node miniapp/scripts/prepare-sandbox-primary.cjs --plan <plan.json>
//   node miniapp/scripts/prepare-sandbox-primary.cjs --plan <plan.json> --execute
//   node miniapp/scripts/prepare-sandbox-primary.cjs --facts
//
// 退出码：0 通过；1 计划不合法或 --execute 被拒绝。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const bootstrap = require('./lib/sandbox-primary-bootstrap.cjs');

/** 固定目标（与副本配置一致；不从命令行传入）。 */
const APP_ID = 'wxfb4db1615ac15531';
const ENV_ID = 'cloud1-d8gcq5ag39d847723';

function fail(message, detail) {
  console.error(message);
  if (Array.isArray(detail) && detail.length) {
    for (const item of detail) console.error(`  - ${item}`);
  }
  process.exitCode = 1;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 列出**已声明**的 SDK 事实（只读仓库内 package.json）。
 * 不解析、不打印任何认证信息；不安装。
 */
function printFacts() {
  const pkgPath = path.join(__dirname, '..', 'cloudfunctions', 'scheduleSandbox', 'package.json');
  let declared = '(未找到副本 package.json)';
  try {
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    declared = (raw.dependencies && raw.dependencies['wx-server-sdk']) || '(未声明)';
  } catch (error) {
    declared = `(读取失败：${error.message})`;
  }
  console.log('目标 AppID:', APP_ID);
  console.log('目标环境:', ENV_ID);
  console.log('副本声明的 wx-server-sdk 版本:', declared);
  console.log('本机真实管理 SDK 事务能力: 未核实');
  console.log('本轮动作: 未安装、未联网、未初始化');
}

function main(argv) {
  if (argv.includes('--facts')) {
    printFacts();
    return;
  }

  const planIndex = argv.indexOf('--plan');
  if (planIndex < 0 || !argv[planIndex + 1]) {
    fail('需要 --plan <plan.json>。本 CLI 只做本地计划检查，不接受适配器路径参数。');
    return;
  }
  const planPath = planIndex + 1;
  // 明确拒绝绕过参数
  for (const forbidden of ['--adapter', '--sdk', '--credential', '--token']) {
    if (argv.includes(forbidden)) {
      fail(`不接受参数 ${forbidden}：真实执行路径不接受调用方指定适配器或凭据。`);
      return;
    }
  }
  // R5：受控批准上下文**只从计划文件读入**，不接受命令行传入完整名单，
  // 也不接受尾号；生产尚无这份名单，因此本 CLI 永远只做本地检查。
  const approvalIndex = argv.indexOf('--approval');
  if (approvalIndex >= 0) {
    fail('不接受 --approval：受控批准上下文必须随计划文件一并受审，不从命令行传入。');
    return;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(argv[planPath], 'utf8'));
  } catch (error) {
    fail(`计划文件不可读或不是合法 JSON：${error.message}`);
    return;
  }

  const approval = isPlainObject(raw) && isPlainObject(raw.approval) ? raw.approval : null;
  // approval 是**上下文**而不是计划字段：验证前剥离，避免被当作未登记字段拒绝
  const planInput = Object.assign({}, raw);
  delete planInput.approval;

  // 本地计划校验（零数据库操作）；固定 AppID/env 由核心常量判定
  let plan;
  try {
    const approved = bootstrap.validateApprovalContext(approval);
    plan = bootstrap.validatePlan(planInput, { approval: approved, nowMs: Date.now() });
    bootstrap.assertApprovedTarget(approved, plan.targetUserId);
  } catch (error) {
    fail(`计划校验失败：${error.code || 'PLAN_INVALID'} ${error.message}`, error.detail);
    return;
  }

  const digest = bootstrap.inputDigest(plan);
  const auditId = bootstrap.auditId(plan, digest);
  console.log('计划校验通过（纯本地，零数据库操作）');
  console.log('  目标 userId:', plan.targetUserId);
  console.log('  轮次:', plan.roundId);
  console.log('  证据编号:', plan.evidenceId);
  console.log('  批准人:', approval.approvedBy, '（批准时间', approval.approvedAt, '）');
  console.log('  输入摘要:', digest);
  console.log('  将使用的确定性审计主键:', auditId);
  console.log('  集合白名单:', bootstrap.ALLOWED_COLLECTIONS.join(', '));
  console.log('  计划不含 projectId 前置；审计 projectId 将为 null');
  console.log('  身份一致性：将按 u_ + sha256(APPID:OPENID) 前 40 位在内存核对（不导出 OPENID）');

  if (argv.includes('--execute')) {
    console.error('');
    console.error('--execute 已拒绝：真实管理事务适配器未核验，未发送任何请求。');
    console.error('  不加载全局 SDK、不读取密钥文件、不回退到管理 API 逐条写。');
    console.error('  不得用独立的读 → 写 → 回读冒充原子性。');
    console.error('  后续需由 Codex 核实 SDK 请求形状、认证与事务缺失读取/冲突行为后单独下发接入任务。');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('未执行初始化。本命令默认只做本地检查；primary 仍未建立。');
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = Object.freeze({ APP_ID, ENV_ID, printFacts });
