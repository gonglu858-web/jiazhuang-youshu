# 本人登记完整测试包与关闭包：本地组装任务

## 1. 接手依据和分工

项目根：`C:\Users\30591\Documents\ChatGPT\装修进度验收APP`。沿用 master 与既有 Git 仓库，不创建新仓库或改写历史。

先读 AGENTS.md、需求与业务规则、进展与待办/WorkBuddy开发交接顶部，以及：

- `docs/Codex验收-本人登记制品R1-R5返修-20261010.md`
- `docs/Codex准备-本人登记完整包与部署关闭-20261010.md`
- `docs/本人登记制品操作稿-20261010.md`

R1–R5 已通过关闭；所有旧 U/T、管理员接线、P4、SDK/凭据链、旧打包器均不重开。新增组装器只消费它们的受审产物。本任务不修业务、不新增用户可见功能、不承担部署工具或生产批准签发者实现。

## 2. 允许文件（七个）

新增：

1. `miniapp/scripts/assemble-sandbox-registration.cjs`
2. `miniapp/tests/sandbox-registration-assembly.test.cjs`
3. `docs/本人登记完整包本地组装说明-20261010.md`
4. `docs/证据/本人登记完整包本地组装-20261010.cjs`
5. 同名新 `.json` 证据（存在即另取新名，不覆盖）

仅在顶部追加：`docs/进展与待办.md`、`docs/WorkBuddy开发交接.md`。

产物仅在已被 `/artifacts/schedule-sandbox/registration-*` 忽略的新目录内；不改 .gitignore，不覆盖任何已有制品。不得编辑已验收生成器、源 Page/client/配置、云函数/vendor、P4、SDK、凭据链、旧编译脚本和历史证据。

## 3. L1 两份完整项目

输出建议为 `registration-full-<安全编号>/registration-project/` 与 `closed-project/`，各自有 project.config.json、miniprogram/、cloudfunctions/scheduleSandbox/。顶部另有组装 manifest，不能上传整个 artifacts 根或含两个函数版本的目录。

### 输入及校验

- 输入为已验收登记生成器的明确单个产物目录；调用真实 `checkRegistration` 并绑定完整计划和清单，不自行信任其中自报哈希。不得扫描目录自动取“最新”包。
- 复用受审关闭包校验，不改它。来源以本轮接手 Git 提交、固定登记来源 be413a0 和实际 SHA-256 记录。11 个既有前端文件仍受生成器独立字节基线约束。
- 新纳入的 app.js/app.json/app.wxss/config/cloud.js/project.config.json 也绑定独立审阅的来源字节及哈希；不得只将当前被篡改内容读入 manifest 后自证。
- 本轮实际生成只用 synthetic=true 的合成计划，不把历史真实账号或当前查询结果当作真实写批准；不实现新的授权系统。

### 前端组装

- 原 Page 四文件、client/env-gate/driver/coordinator 以及三配置共 11 文件按实际依赖闭包保留；只有 schedule-sandbox-proof 使用已有登记/关闭覆盖。
- 再补 app.js、app.wxss、config/cloud.js；app.json 为受控制品变换：从受审源保留 window，pages 精确为 `['pages/schedule-sandbox/schedule-sandbox']`。源九路由不改。
- 递归检查 require、usingComponents、WXML import/include 和样式依赖；任何新增未知依赖先报告，不自动复制整个旧业务目录。当前预计没有 npm 前端依赖，必须以文件核对确认。
- project.config.json 从固定模板/受审源白名单投影，固定 AppID=`wxfb4db1615ac15531`、compileType=miniprogram、miniprogramRoot=miniprogram/、cloudfunctionRoot=cloudfunctions/；说明保留的编译设置及与来源差异。禁止 private config、认证缓存、个人启动参数、密钥、临时源映射和无关文件混入。
- 不修改 Page 动作选择器、不隐藏新功能；如实说明页面仍显示其他动作，登记期间服务端只允许 identify；旧入口/驱动开关继续关闭。不得把单页等同于单按钮。

### 服务端组装

- registration-project/cloudfunctions/scheduleSandbox 放登记产物八文件；closed-project 同位置放受审关闭包八文件，均逐字节相同，不另改配置或 vendor。
- 不将 package/frontend 等覆盖目录放进云函数；不能把源目录名 package 当云函数名。
- 本轮不安装 wx-server-sdk、不远程安装 npm，不伪造 node_modules；package.json 版本仍 3.0.1。依赖安装和平台运行时留作后续具体执行包事项。

## 4. L2 最小组装完整性

不要扩大成通用发布框架。沿用已经建立的目录边界、链接拒绝、写前完整预检、独占写入和完整计划语义检查：

- 目录不可逃逸、不可与来源/旧制品重叠；整个输出树只含列明文件和目录。来源或产物文件/祖先 junction、额外文件/空目录、非普通文件均拒绝。
- 输出冲突在任何写入前发现；零新增、零覆盖实测。有 manifest 却缺文件时拒绝补写；无 manifest 且已有部分字节完全正确时可续建。相同完整输入复用时不重写 manifest。
- manifest 记录输入计划/登记清单与关闭清单的哈希、来源独立基线、两份完整项目每文件长度与 SHA-256、全部允许差异、合成性质、未部署状态。无需自哈希或新签名体系。
- check 模式从受审来源与完整输入重算内容，既验字节也验配置意义；不能仅比较 manifest 自报哈希。缺失/多余/重复条目、改轮次/目标/窗口/合成标记、旧路由混入都拒绝。
- 检查无云调用、无自动安装、无修补；写入期真实 I/O 失败保留可审查半成品，不递归删除。只清理由测试自己新建、已验证绝对路径在夹具根内的内容。

## 5. L3 验证与编译

按行为分组，不为凑数字重复断言。至少独立证明：

1. 两份项目的完整文件集和依赖可解析、唯一页面入口正确、八文件服务端各与正确输入逐字节匹配；明确前后端包差异。
2. 错来源/输入漂移/过期真实输入或非法计划按现有契约拒绝；测试不得放宽生成器校验。
3. 上节冲突反例在真实 build/check 上拒绝且目录快照不变；合法半成品续建和完整复用成功。
4. 用两份完整项目中的实际 App、Page、client 和依赖执行合成生命周期/主动按钮链。App 可初始化固定云环境，onLoad/onShow 零业务请求；主动 identify 一次、无 projectId、固定 scheduleSandbox/环境；关闭版本零业务发送。不能只加载孤立配置。
5. 本轮沿用首次未绑定 identify 未知结果停止限制；不承诺持久防重、不清真实缓存、不增加自动重发，也不修改关闭的客户端。
6. 既有前端驱动与旧入口保持关闭；完整包不含 access/旧业务页面。真实云函数权限仍由既有登记制品测试支持，不能虚构本轮真实 SDK 验证。
7. 运行相关新测试和登记制品相关回归，未改的业务/P4全量不重跑。历史数字不计入本轮。
8. 可直接用现有本地编译器检查隔离完整包中的 WXML/WXSS：`D:/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec/wcc.exe` 与 `wcsc.exe`；参数参考现有 miniapp/scripts/check.cjs，但其 root 固定指向源目录，**不能直接用该旧脚本通过声称新包已编译**。使用参数数组、shell:false、独立输出，限时/限制输出；不得打开 IDE 项目、执行模拟器、预览、上传、登录或网络调用。
9. 编译器失败最多两轮有依据排查；EBUSY/EPERM 等如实附净化错误并记未验证，不给无证据归因、不以结构解析代替实际编译。WXML/WXSS 编译通过不等于完整微信构建、真机或平台通过。

## 6. 交付、证据与 Git

- 证据独立记录合成验证、真实应用代码加载、本机编译器验证；本轮不执行真实 SDK/平台验证。所有网络/凭据/云写计数必须有实际拦截/观测依据，不能硬写零冒充检测。
- 执行脚本只输出脱敏 stdout 或独占新文件，不 require 会自行覆盖历史 JSON 的脚本，不改旧证据。
- 对接手时全部已跟踪文件做字节基线，除本轮允许七文件以外均应无差异。记录产生的两个完整包的路径、文件数、清单哈希及每类核验。
- 同一轮开发、自测、记录后 master 一次本地提交，注明实测数和“待 Codex 审查，平台未验证、部署未放行”；逐文件检查暂存区凭据，排除 artifacts/node_modules/缓存，报告提交号、文件范围和工作区状态。不得 push 或改历史。
- 完成即停止并交 Codex 复查；不自行进入下一轮，不联网刷新本报告的账号/费用证据。

## 7. 未放行边界

本轮只本地组装与核验。未授权安装、预览/上传/部署/发布、真实凭据获取、本人微信登记、管理员初始化、资源创建/规则变更/索引变更、启用入口、清用户缓存或 A/B/C 操作。真实窗口、依赖安装和写入由后续具体执行包单独确认；当前无需用户操作微信。
