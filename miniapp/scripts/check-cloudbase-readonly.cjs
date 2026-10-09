#!/usr/bin/env node
'use strict';
/**
 * CLI 身份与环境只读观测 —— 命令行入口
 * =====================================
 *
 * 默认（无参数）：只检查**本地准备条件**（非敏感安装元数据、入口文件完整字节
 * 哈希与精确内容、bundle 源码哈希、CLI 版本、子进程 `os.homedir()`）。
 *   - **不启动任何 CLI 云命令**；不读取认证文件内容；**不宣称「登录有效」**。
 *
 * `--read-only`：才允许启动固定的三项只读查询（STS GetCallerIdentity、
 * TCB DescribeEnvs、TCB DescribeEnvInfo），固定环境 `cloud1-d8gcq5ag39d847723`、
 * 地域 `ap-shanghai`。按次序执行，前一步不合格立即停止。
 *
 * 明确不接受（启动任何子进程前即拒绝）：`--execute`、`--approval`、`--init`、
 * 任意未知开关、任意额外位置参数、任意自定义 service/action/body/env/region/
 * 可执行路径/认证目录。**没有跳过检查的开关。**
 *
 * 输出：仅向 stdout 打印净化后的 JSON；退出码 0 = 成功/本地就绪，1 = 失败。
 * 本入口**不写任何文件**（不覆盖固定路径的证据）。
 *
 * 边界：这是**只读观测工具，不是授权器**。所有分支 `writeAuthorized=false`，
 * 不实现也不替换 P4 的 `verifyCaller`，不生成初始化计划或人员允许名单。
 * 不核实费用/余量（三接口不提供计费余额或配额）。
 */

const observer = require('./lib/cloudbase-readonly-observer.cjs');

function emit(report) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

async function main() {
  let parsed;
  try {
    parsed = observer.parseObserverArgs(process.argv);
  } catch (error) {
    // 参数错误：只输出本层固定码与固定文案，不启动任何子进程
    emit({
      schemaVersion: observer.SCHEMA_VERSION,
      mode: 'rejected',
      complete: false,
      status: observer.STATUS.FAILED,
      errorCode: error && error.code ? error.code : observer.ERR.ARGS_INVALID,
      stoppedAt: 'argument-validation',
      observedAt: new Date().toISOString(),
      cloudQueryAttempted: false,
      cloudResponseValidated: false,
      cloudObservationPerformed: false,
      writeAuthorized: false
    });
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = parsed.mode === 'read-only'
      ? await observer.runReadOnlyObservation()
      : await observer.runLocalCheck();
  } catch (error) {
    report = {
      schemaVersion: observer.SCHEMA_VERSION,
      mode: parsed.mode,
      complete: false,
      status: observer.STATUS.FAILED,
      errorCode: error && error.code ? error.code : 'UNEXPECTED_FAILURE',
      stoppedAt: 'internal',
      observedAt: new Date().toISOString(),
      cloudQueryAttempted: false,
      cloudResponseValidated: false,
      cloudObservationPerformed: false,
      writeAuthorized: false
    };
  }
  emit(report);

  const ok = report.status === observer.STATUS.LOCAL_READY
    || report.status === observer.STATUS.ASSOCIATION_OBSERVED;
  process.exitCode = ok ? 0 : 1;
}

main();