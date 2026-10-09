# WorkBuddy 任务：SDK 只读身份接入与管理员记录核对

日期：2026-10-07。状态：最小方案与本地任务，尚未实现、尚未执行真实 SDK 读取。

## 1. 目标与当前结论

回答两个问题：数据库 SDK 使用的云身份是否与本轮身份查询一致；独立测试副本是否已有主管理员，以及指定微信用户记录是否有效。只做观测，不授予权限。

前置：[CLI C1及整组验收](Codex验收-CLI只读接入C1与整组核验-20261007.md)已关闭，真实 CLI 账号归属、环境和 AppID 关联通过。但不能把该报告当作 SDK 使用同一批凭据的证明。

本任务沿用独立副本范围，仅限 `schtest_v1_`。不查旧业务 `users/app_admins`，不处理 A/B/C。旧业务已有负责人不代表副本已有负责人，也不自动指定其为副本初始化目标。

**WorkBuddy 本轮只本地开发和离线验证。Codex 审查后再安排真实只读；本轮不获取真实临时凭据、不使用已有登录态联网。** 用户无需提供密钥、扫码或手机操作。未授权初始化、资源创建、安装、部署、入口启用或费用调整。

## 2. 本次已核对的本地依据

| 对象 | 事实 | 限制 |
|---|---|---|
| CLI 3.8.4 | 固定安装的 standalone bundle；没有独立可直接导入的 manager-node 包接口 | 不 require CLI 主入口或提取 webpack 内部模块作生产接口 |
| `SecretsGetCommand`，bundle约45509行 | 公共 `secrets get --json` 路径可返回 secretId/secretKey/token/expiredAt/isTemporary/envId | 此次只读源码，未执行命令；输出高度敏感，只能由未来受审进程捕获 |
| bundle约229317行 `getCredentialData` | 项目存储优先于全局登录存储，全局登录存储优先于 TENCENTCLOUD 环境变量 | 在原登录目录注入变量不能证明使用注入凭据 |
| bundle约229250行 | 环境变量名为 TENCENTCLOUD_SECRETID / SECRETKEY / SESSIONTOKEN | 只放入受控子进程环境，不设置系统环境、不写参数文件 |
| node-sdk 2.10.0 | `lib/cloudbase.js:135–139` 接受 secretId/secretKey/**sessionToken** | 不照抄 CLI 示例的 token 参数；实例不得回退到环境或云函数身份 |
| database 1.4.1 | `document.js:169–217` 支持 `doc(id).field(projection).get()`；非事务正常返回 data 数组 | 0条、1条、异常形状分别处理，不套用事务内单对象形状 |
| 既有 P4 适配层 | readOnlyGet不开放users；核心要求受审计划和调用者校验 | 保持关闭，不扩权、不伪造approval、不借初始化事务查询 |

固定路径：

- Node：`C:/Users/30591/.agent-reach/tools/node-v22.16.0-win-x64/node.exe`。
- CLI：`C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/node_modules/@cloudbase/cli/bin/tcb`。
- CLI bundle SHA-256：`8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97`，入口精确字节及哈希复用已验收检查。
- 取临时凭据的既有登录目录：`C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4/auth-session-20261007`。
- 已取得 SDK 根：`C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules`；不用项目依赖或全局PATH替换。
- 固定环境 `cloud1-d8gcq5ag39d847723`、AppID `wxfb4db1615ac15531`、地域 `ap-shanghai`。

## 3. 选定的最小接入路径

### M1：一次获取、同批使用，不做生产授权器

未来显式只读运行按以下顺序；本轮全部用合成凭据与网络拦截验证：

1. 核对固定程序、SDK版本/来源和本地环境。默认模式只本地检查，不启动取凭据或云查询。记录SDK本轮实际使用文件哈希；没有历史受审值的文件不得标“历史基线已匹配”。
2. 用既有登录目录调用一次官方 `secrets get --json`，stdout/stderr只进有界内存，绝不显示、写盘或透传异常。程序不得直接读auth.json或扫描登录缓存。此路径是新受审宿主的专门能力，不扩展已关闭的CLI观测器。
3. 严格接受非空字符串secretId/secretKey/token、isTemporary严格为true、可验证的未来expiredAt；未知或缺失有效期、长期密钥、坏JSON、超限、非零退出均停止。选择至少剩余5分钟作为本轮开始门槛，每阶段前后检查尚未过期；不是对平台有效时长的承诺。
4. 同一内存凭据快照分别供固定CLI身份/环境查询和node-sdk使用。获取后不再刷新或重新获取；失效则停止并记录未完成，不混用新旧结果。凭据不输出摘要、尾号或原值；报告只保存随机运行编号和非敏感到期时间。移除引用不等于能保证JS内存已物理擦除。
5. 后续CLI查询采用**本轮新建、无登录记录的隔离USERPROFILE/HOME/cwd**，不使用原登录目录。不存在性检查只查固定配置/认证文件位置，不读取内容；发现污染或不能证明隔离即停止，不删用户文件。清除继承的CLOUDBASE/TCB/TENCENTCLOUD认证及覆盖变量、NODE_OPTIONS，再仅给该子进程注入同一份三字段与固定地域，CI=1，关闭更新与报告。源码确认不能替代对真实公共CLI入口的离线优先级验证。
6. 在隔离目录使用公共 `api` 命令，执行已验收的STS→DescribeEnvs→DescribeEnvInfo序列；复用解析与字段核验，不复用原登录态runReadOnlyObservation冒充同凭据链。账号/环境/AppID匹配后才进入数据库读取。
7. SDK实例显式传secretId/secretKey/sessionToken/env/region，debug=false，固定官方服务，禁自定义endpoint、跨账号回调、代理覆盖和环境身份回退。只暴露本任务固定doc读取。需核对实际SDK重试与超时，不把业务层一次调用说成网络仅一次。

复用 `cloudbase-readonly-observer.cjs` 已导出的进程收尾、解析、校验能力，**不改其实现或限制、不复制重造一套计时/解析框架**。新凭据输出解析保持专用、严格、不得把含凭据的结果或诊断返回给调用方。原工具清理凭据变量的行为保持不变；新宿主只在其自己的隔离调用边界注入。

每个CLI子进程保留55秒/合并1MiB/exit后2秒close宽限，底层终止未确认必须如实标注。SDK读取放在有界独立worker，凭据经私有stdin管道一次送入，关闭stdin；不放命令行或磁盘，worker只输出净化结果。worker总上限55秒/输出1MiB，失败不重试；杀进程不证明已取消平台请求。

**硬停止点**：若无法用合成凭据验证公共CLI在干净目录确实选用注入凭据，或发现需新增SDK/提取内部模块/手写签名，交付具体缺口，停止此路径。不得以假的verifyCaller或allowed:true继续拼接。最多两轮针对性定位，不发展通用认证框架。

### M2：管理员记录核对，只读固定目标

| 次序 | 目标与投影 | 处理 |
|---|---|---|
| 1 | `schtest_v1_app_admins/primary`：仅 `_id,userId,status` | 正常返回0条为本次文档未找到；1条要求主键primary、完整userId与状态合法；多条/坏形状为不可信 |
| 2 | `schtest_v1_users/<targetUserId>`：仅 `_id,status,openid` | 仅当完整目标已有受信指定记录时查询；核对主键、active、派生一致性；OPENID仅worker内存比较，永不输出 |
| 3 | 本轮不查审计 | 当前没有有效初始化计划与确定性审计ID，记NOT_APPLICABLE；不编造轮次或扫描全表 |

目标userId暂不预填。CLI可接受一个格式严格的完整userId作为**只读查询目标**，不接受尾号/昵称；参数不构成授权或现实人员证明。真实执行前由Codex把受信指定来源与目标对应好。缺少目标时仍可单独观测primary，users记NOT_EXECUTED_TARGET_UNCONFIRMED，整体记录核对不得标完整。不要为此马上要求用户取号或发OPENID。

primary中的userId与预定目标分开：不把当前primary绑定的人自动选作拟初始化对象，不沿任意返回值继续查更多用户。若已有primary绑定其他人，报告冲突，不覆盖、不新增。已有同一目标也不意味着可执行初始化。

字段缺失、disabled、指向不同人、用户不存在、用户停用、身份派生不符分别报告。派生公式沿用已验收核心 `u_ + sha256(appId + ':' + openid).slice(0,40)`，只复用纯校验函数或相同窄逻辑，绝不导入并执行初始化。

只读get的空数组只说明文档此次未找到；不得推出集合从未存在或历史无人初始化。只有已核实的官方错误契约才能将集合缺失分类为NOT_EXISTS；无法区分的错误一律UNCONFIRMED，保留净化分类，不猜码、不解析自由message。权限拒绝与网络失败不能当作空记录。此轮不为存在性额外建集合、列全库或扩展控制面API。

身份派生一致仅证明记录自洽，不证明现实微信归属。普通读取不是原子快照，各阶段注明时间；未来写入仍需重新核验，当前观测不能替代事务内条件写。

### M3：输出、默认入口与范围

仅新增：

1. `miniapp/scripts/lib/cloudbase-sdk-readonly-observer.cjs`：上述编排与窄验证。
2. `miniapp/scripts/lib/cloudbase-sdk-readonly-worker.cjs`：固定SDK与两条主键只读，凭据仅私有管道。
3. `miniapp/scripts/check-cloudbase-sdk-readonly.cjs`：默认本地检查；显式`--read-only`，可选`--target-user-id <完整ID>`。无跳过检查开关、无任意env/集合/URL/认证目录/凭据参数；未知参数、--execute、--approval在任何云调用前拒绝。
4. `miniapp/tests/cloudbase-sdk-readonly-observer.test.cjs`：相称离线测试。

只更新进展与交接顶部；可另存一份不含敏感值的新交付证据。缺乏必要隔离能力时允许交付未完成结论，不另造框架。

输出至少分层：本地准备 / 同批凭据路径是否证实 / STS与环境关联 / primary观测 / 指定users观测 / 未完成项。所有分支`writeAuthorized=false`、`productionCallerVerifierImplemented=false`。CLI关联匹配不自动生成允许名单、approval或初始化计划。生产人员允许名单尚缺不妨碍已授权的有限只读观测，但必须阻止将其解释为写权限认证。

账号只留现有摘要/尾号、请求ID；内部userId按必要性保留；不得输出凭据、原始OPENID、完整记录、签名头、SDK实例/配置对象、原始错误/stack/cause。默认stdout仅净化JSON，不内置固定同名覆盖写证据器。程序白名单不等于IAM只读权限，临时凭据仍可能有更广权限，用户不需接触它们。

禁止调用业务identify/requestBindingNumber（可能写库）、initializePrimary、数据库事务/写方法、云函数、原始集合或任意查询。既有业务文件、CLI观测器、P4、适配层、初始化CLI、driver、打包器、关闭配置与全部历史证据均不改。

## 4. 最小验收与停止标准

只运行新增相关测试、必要共享依赖回归与语法检查，不重跑旧业务全量。重点行为：

1. 默认/坏参数/缺目标的分支没有越界调用；缺目标不影响primary独立观测，但不能输出完整记录核对成功。
2. 临时凭据坏形状、到期、未知到期、长期凭据被拒；所有成功和失败输出不泄露合成敏感标记。
3. 公共CLI入口离线执行路径与认证优先级受验证：合成网络拦截中核对选用身份；污染目录停止。不允许抽取webpack模块作为生产实现；源码定位和合成路径证据分别说明。
4. STS/环境与SDK收到同批合成三字段，token→sessionToken准确；无缓存登录回退、无偷偷刷新、无自定义目标。底层真实传参证据与只在mock中相等的断言区分。
5. primary无记录/同目标/其他目标/停用/坏结构，users有效/缺失/停用/派生不符，权限/网络/集合未确认各分支正确，无补建。
6. 实际SDK非事务data数组与投影契约通过离线请求替身核验；所有写入口设陷阱，写次数为0。不用事务读替代普通get。
7. 超时、超限、晚到错误沿用已验收收尾；credential与worker输出敏感标记不得出现在stdout/stderr/新文件。终止未确认不说“已取消”。

交付列出实际改动、已测/未测、凭据来源优先级证据、SDK投影/请求形状证据与零真实网络边界。测试不是平台IAM、事务或费用验收；没有实现的路径直接说明，不能用测试注入伪装生产核验。

## 5. 阶段出口

WorkBuddy本地交付 → Codex审查 → 明确指定用户来源与缺项 → Codex在受审宿主内按既有只读授权执行一次，另存脱敏证据。凭据取得属于该后续宿主流程，本次方案整理和WorkBuddy本地开发均不执行它。

若副本集合或指定用户不存在，记录事实后结束，不自动进入准备/初始化/部署流程。费用与余量独立待核实，不加入本工具；Git备份也独立处理。

本文件为下一轮最小本地任务，不代表SDK接入已完成或真实管理员已核实。无需重开C1及前轮关闭项。
