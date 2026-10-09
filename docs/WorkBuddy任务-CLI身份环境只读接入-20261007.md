# WorkBuddy 任务：CLI 身份与环境只读接入

日期：2026-10-07。状态：任务已整理，待 WorkBuddy 本地实现与 Codex 审查；本文件不是实现结果或初始化授权。

## 1. 本轮目标与依据

将 Codex 已实测的官方 CLI 只读通道封装为小型本地工具，回答：当前签名调用者所属云账号是否与指定环境归属相符，环境是否正常、地域和微信 AppID 是否匹配。

依据：
- [CLI 登录与只读身份核验](Codex核验-CLI登录与只读身份-20261007.md)：用户已完成授权，真实查询成功。
- [CLI 独立安装核验](Codex核验-CloudBaseCLI独立安装-20261007.md)：固定官方 CLI 3.8.4 已安装。
- [生产身份核验与只读接入方案](Codex方案-生产身份核验与只读接入-20261007.md)：云操作者与目标微信管理员是两种身份。

这是“只读观测工具”，不命名为生产授权器，不实现或替换 `verifyCaller`，不接入 P4 初始化调用链。生产人员允许名单仍未建立；不把首个查询结果自动登记为授权主体。

Codex 负责审查与后续真实只读执行。WorkBuddy 本轮只实现和运行离线测试，不使用已有登录态访问云端，不重复登录或安装。

## 2. 文件范围

仅新增以下三个文件，必要说明写在文件头与交付记录，不另建框架：

1. `miniapp/scripts/lib/cloudbase-readonly-observer.cjs`：固定调用计划、进程执行、解析、字段校验和安全结果投影。
2. `miniapp/scripts/check-cloudbase-readonly.cjs`：命令行入口，默认只检查本地准备条件；显式 `--read-only` 才允许启动三项查询。
3. `miniapp/tests/cloudbase-readonly-observer.test.cjs`：针对本任务的离线测试。

允许在 `docs/进展与待办.md`、`docs/WorkBuddy开发交接.md` 顶部记录实际交付。可新增一份独立交付结果 JSON，但不得覆盖历史证据。

不修改 P4 核心、SDK 适配层、既有初始化 CLI、driver、打包器、业务代码、云函数、副本、配置、依赖或锁文件；已关闭项不重开。

## 3. 固定运行边界（L1）

### 3.1 已取得的本机载体

| 项 | 固定值 |
|---|---|
| Node | `C:/Users/30591/.agent-reach/tools/node-v22.16.0-win-x64/node.exe` |
| CLI 入口 | `C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/bin/tcb` |
| CLI bundle | 同 CLI 根下 `dist/standalone/cli.js` |
| bundle SHA-256 | `8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97` |
| 官方登录目录 | `C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/auth-session-20261007` |
| 环境 | `cloud1-d8gcq5ag39d847723` |
| 地域 | `ap-shanghai` |
| 微信 AppID | `wxfb4db1615ac15531` |

检查 Node/入口/bundle 与固定版本、安装记录相符，入口应为已验收的 `require('../dist/standalone/cli.js')` 转发。缺失或不符即停止，不自动下载、修复或换版本。固定路径是本机约束，不宣传为通用安装发现器。

本地默认检查不得启动任何 CLI 云命令、读取认证文件内容或宣称“登录有效”。可以读取非敏感安装元数据与源码哈希，并用上述 Node 仅运行 `os.homedir()` 检查子进程用户目录。

### 3.2 子进程约束

- 使用 Node `spawn`/`spawnSync` 的独立参数数组，`shell:false`；不拼 PowerShell/cmd 命令字符串，不调用全局 PATH 中的 tcb。
- 子进程 cwd 固定为独立登录目录。只对子进程设置 USERPROFILE，并验证该子进程 `os.homedir()` 等于固定目录；不改变系统或当前用户永久变量。
- 清除继承的 `CLOUDBASE_*`、`TCB_*`、`TENCENTCLOUD_*` 及 `NODE_OPTIONS`，再显式设置 `TCB_REGION=ap-shanghai`、`NO_UPDATE_NOTIFIER=1`、`TCB_DISABLE_REPORT=1`、`CI=1`。
- `CI=1` 的依据：已安装 CLI bundle 公共鉴权分支仅在 `autoRunLogin && !process.env.CI` 时自动打开登录；无登录且 CI 时抛错。本轮静态源码核对，不等于已实测所有过期刷新分支。stdin 关闭，不答复任何提示；不显式调用 login/logout/secrets。
- 每个查询进程最多 55 秒、输出最多 1 MiB；超时/启动失败/超限/退出非零立即停止后续查询，不包装无限重试。CLI 内部凭据刷新或重试不由本工具伪称为零次。
- 不暴露任意 service/action/body/env/region/可执行路径/认证目录选项。测试依赖替换仅供模块测试注入，不通过命令行提供跳过检查开关。
- 不加载项目 cloudbaserc、手工提取认证缓存或把 CLI 凭据复制给 node-sdk。不得读取或输出密钥、Token、OPENID。

### 3.3 唯一允许的三项查询，按次序执行

1. `api sts GetCallerIdentity --api-version 2018-08-13 -r ap-shanghai --json`
2. `api tcb DescribeEnvs --api-version 2018-06-08 --body <固定JSON> -e cloud1-d8gcq5ag39d847723 -r ap-shanghai --json`
3. `api tcb DescribeEnvInfo --api-version 2018-06-08 --body <固定JSON> -e cloud1-d8gcq5ag39d847723 -r ap-shanghai --json`

固定 JSON 恰为 `{"EnvId":"cloud1-d8gcq5ag39d847723"}`，用参数数组传递。STS 无环境选择参数；不能把它说成环境限定的身份凭据。

未知/冲突参数（包括 `--execute`、`--approval`、任意额外位置参数）在启动子进程前拒绝。默认检查与 `--read-only` 模式明确区分；WorkBuddy 本轮不得运行后者。

## 4. 解析与关联核验（L2）

### 4.1 解析契约

真实 CLI stdout 曾含 JSON 外提示。不得直接使用“第一个 `{` 到最后一个 `}`”作为无条件解析器，也不得从多个对象中挑选看起来成功的那个。

接受单个 JSON 根对象；必要时允许已核对的固定动作提示行及 ANSI 显示控制序列，提示必须与当前 action 相符。清理显示序列后验证前后只有允许提示/空白，拒绝多个根对象、截断 JSON、未知前后文本、数组/null 根和平台错误对象。可依据本机源码确定具体提示格式；不为搜集格式再次调用云端。不兼容输出先失败，不扩大到任意文本提取。

原始 stdout/stderr 仅在受限内存处理，不打印、不落库、不作为异常 cause 拼入结果。错误只输出自定义阶段、错误分类、退出码/是否超时；不得把不可信错误文本透传。成功只投影以下字段，额外字段不输出。

### 4.2 逐项要求

- STS：从实际顶层结果取 `Type/AccountId/UserId/PrincipalId/Arn/RequestId`。本机已见 Type=CAMRole；本轮只接受这个已核验类型。所需身份值与 RequestId 必须为非空字符串；不把 Arn 或完整主体值落入公开报告。
- DescribeEnvs：从实际结果 `EnvList` 读取；恰好一条目标环境，EnvId 精确匹配、Status=NORMAL、Region=ap-shanghai。缺项、重复/额外环境、异常状态停止。
- DescribeEnvInfo：从 `EnvInfo.EnvBaseInfo` 校验同一 EnvId/Status/Region，从 `EnvInfo.UserInfo.Uin` 与 STS AccountId 作精确比较，从 `UserInfo.WxAppId` 校验微信 AppID。不能用数字型 `AppId` 替代 `WxAppId`，不能使用请求中的固定值冒充响应匹配。
- 身份字段出现未核验的类型不猜测转换；若本机源码/既有安全记录不能确定，交付时明确说明。测试采用脱离真实账号的合成值；不拿预设 expected 字段覆盖错误响应。
- 每阶段记录本地开始/完成时间及通过字段，不把连续读取称为原子快照。前一步不合格不继续调用。

### 4.3 输出

建议保持简单对象：`schemaVersion`、`mode`、`complete`、`status`、`stoppedAt`、`errorCode`、`observedAt`、三阶段结果、`writeAuthorized:false`。

成功 `status=ASSOCIATION_OBSERVED`，表示当前观测的账号/环境/AppID 关联相符；失败/未执行不得设置该状态或 complete=true。默认本地检查用独立 `LOCAL_READY`/`LOCAL_NOT_READY` 状态，明确 cloudObservationPerformed=false。

身份只保存必要的 SHA-256 摘要（AccountId 与 Uin 同算法、同字节输入）或尾号；不输出完整 AccountId/UserId/PrincipalId/Arn，也不传播原始 CLI 返回。RequestId、目标 EnvId/AppID、状态与地域可保留。摘要属于内部关联依据，不是签名或授权证书。

所有分支 `writeAuthorized=false`，不输出 `allowed:true`，不生成初始化 approval、允许名单或可供 P4 执行的凭据。报告说明同一登录目录不证明三次调用使用同一份未刷新的临时凭据；本轮也不能完成数据库 SDK 的同凭据核验。

命令行仅向 stdout 输出净化结果，使用退出码区分成功与失败；不要增加固定路径自动覆盖的证据写入器。Codex 后续真实核验另存新的记录。

## 5. 离线验收（L3）

测试必须拦截子进程执行，不能因真实 CLI 已安装就联网。不运行云调用或取凭据来补测试。

按行为覆盖，数量由相称场景决定，不为凑数复制断言：

1. 默认模式不执行三项 API；未知/写入/自定义目标参数零 API。
2. 三个命令参数、固定 env/body/region、shell:false、子进程变量清理与 CI=1；安装缺失/哈希不符/用户目录不符零 API。
3. 顺序与停止：第一或第二步失败不调用后续；超时、非零退出、启动错误、超限都失败关闭且不重试。
4. 标准 JSON、确知提示+JSON、对象字符串内的花括号正常解析；多根、截断、错误对象、额外文本拒绝。
5. 正向合成 CAMRole → 单环境 → 所属账号/AppID 相符；错账号、错 AppID、错地域/环境、异常状态、缺字段/类型、重复环境分别不通过。
6. 在成功/错误 stdout、stderr、额外字段放入合成 secret/Token/OPENID 标记，最终输出和抛出错误不得泄露；所有结果不授权写入。
7. 正常输出不得宣称 SDK 凭据复用、平台事务、人员允许名单或初始化通过。

只运行新增相关测试、新增 JS 语法检查与相称 diff 检查。不重跑未变业务全量，不运行旧自执行证据脚本。测试失败定位同一问题最多两轮，仍无法确认时保留具体失败与阻塞，勿扩建新验证系统。

## 6. 交付与下一步

交付包含新增/修改文件、实际命令与结果、合成执行次数及零真实网络说明、默认模式输出、关键失败样本、未验证项。合成子进程测试不等于官方 CLI 或 IAM 的新实测。

不可宣称本轮核实了费用/余量：三接口不提供计费余额或可用配额。费用资料仍是单独只读待办，不调用未列出的账单接口，不购买/续费/升级。

Codex 审查通过后，沿用用户现有“登录并只读核验”授权运行一次工具，只保存脱敏新证据；登录失效则停止并说明所需人工操作，不反复登录。之后再确定人员允许名单来源、SDK 受控凭据桥与目标微信记录读取的最小任务。本轮不把这些未知项伪装完成。

初始化、资源创建、部署、恢复、入口启用均不在本任务内。P4、旧适配层和此前已关闭项保持原状，A/B/C 不处理。用户当前无需扫码、取号、导出或提供密钥。
