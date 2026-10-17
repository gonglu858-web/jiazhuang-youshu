# CodeBuddy任务：核验包提前准备与执行时效分离（仅本地）

日期：2026-10-17。接手master d4c3205（以本任务提交为实际接手点）；依据本轮[离线阻断证据](证据/Codex核验包未来窗口准备阻断-20261017.json)。范围仅参与者核验打包器，不扩展P/E/X或业务能力。

## 1. 问题与已关闭项

两次I2获批后，手动预览/模拟器准备消耗候选启动余量，均在候选覆盖前停止，云凭据/部署/调用0。第二轮用户已确认二维码正常；模拟器失败根因未确定，不据此修前端或清缓存。

现有package-participant-identity-check.cjs的windowClockCheck约461行在now<starts时拒绝，build约698行、checkDir约855行均调用；因此真实模式未来计划虽可readPlan，却不能提前构建/核对。本轮独立证据用合成材料且synthetic=false证实WINDOW_NOT_OPEN、输出目录未创建、源文件未改，未改时钟、未假冒平台验证。

I1请求分层/原型真实性、SDK3.0.1、身份只读、字段投影、完整编号勾选与取消、配对关闭映射均已受审，不重做。1号真机身份确认+ABSENT，完整编号未取得；2号尚未提交核验。P/登记/写库/角色授权未放行。

## 2. 允许改动与接口设计

只改miniapp/scripts/package-participant-identity-check.cjs、miniapp/tests/participant-identity-check.test.cjs、现有本包操作说明；新增本轮证据脚本/JSON，更新当前状态与两份开发记录顶部。源core、request-adapter、server入口、client、页面、模板配置、PINNED_SOURCES受审源文件、关闭来源、业务打包器、管理员/P4链不改。

新增明确命名的prepare(planPath,outOverride)与checkPreparedDir(dir)，CLI新增--prepare <planPath> [--out <dir>]、--check-prepared <dir>。旧build/checkDir/旧CLI默认严格行为不变。不得增加全局skipWindow、环境变量绕过、plan豁免字段或任意外部now参数，不改系统时间/全局Date来生成真实包，不将真实计划改synthetic=true。

实现宜复用同一个制品重建/文件检查主体，内部模式固定由公开入口选择，避免复制完整校验器。不得把布尔prepare参数写进真实计划/运行配置，或从manifest选取检查模式。计划/清单/输出目录内容寻址仍使用现有受审规则。

## 3. 准备与执行两类校验

### A. 提前准备（新增）

- 使用真实Date.now逐边界重读。真实模式允许now<starts准备；允许有效窗口内准备；now>=expires仍拒绝。NaN/抛错仍原分类拒绝。窗口长度<=30分钟、expires>starts保持。
- 准备仅表示本地制品完整，结果明确phase=preparation、preparationValidated=true、executionReady=false；即使时间处于窗口内也不宣称执行批准。失败preparationValidated=false/退出非0，结构校验失败不被时间信息覆盖。
- 不把易变的时间结论写入内容寻址manifest，不加时间戳。相同计划/源码经prepare与旧build生成的候选及关闭制品必须逐字节一致；准备模式的事实只在返回报告/外置证据。
- 既有来源14项钉定、锚点、目标/协议、plan字节锚定、关闭映射四字段、精确文件集、symlink/junction、wx排他、冲突零写、续建/复用、partialWrites/EEXIST事实全部保留。准备/检查均不得因为尚未开窗跳过这些校验。

### B. 执行前（现有）

- 旧build/checkDir保持now<starts拒绝、starts<=now<expires才通过，now>=expires拒绝；多边界重查不减。CLI输出不得把准备检查冒充--check通过。
- checkPreparedDir成功不能替代checkDir；未来包准备成功后同一时点checkDir必须失败（WINDOW_NOT_OPEN）。将来Codex执行脚本仍用checkDir和真实剩余>=15分钟门槛；本轮不改历史执行脚本或签发新真实批准。
- 核心服务端的窗口/口令/轮次/可信微信上下文/固定目标校验原字节不变。准备成功不允许提前部署/读取；新的真实执行安排留待Codex复查。
- checkCloseDir继续与候选窗口/候选manifest/时钟独立，NaN或过期时仍可检查合法关闭包。

## 4. 必须直接证明的测试

1. 未来真实模式计划：prepare写39文件，checkPreparedDir完整通过但executionReady=false；旧build写前WINDOW_NOT_OPEN且新目录不存在，旧checkDir拒绝；核心handle未来窗口拒绝且get=0（仅合成db/trusted，不动核心）。
2. 同一未来包，在测试中受控时钟进入有效窗口后旧checkDir通过，旧build完全复用0新写；候选/关闭全部字节及manifest不变。测试时钟仅隔离测试使用，finally恢复，不提供给真实生产入口。
3. prepare/checkPreparedDir/旧严格接口：expires==now、已过期、NaN、抛错、执行途中跨截止、最终返回前跨截止的正反例；失败分类与written/partialWrites事实一致。未来开始跨入窗口不导致准备结果升级为executionReady。
4. 来源/计划/manifest/映射篡改均拒绝；目录占位/额外文件/junction/链接写前零写；完整复用与续建、部分写EIO与竞态EEXIST沿用代表性用例。不为新模式删历史断言。
5. 对新CLI做真实子进程离线正反例：准备成功、准备检查、严格检查未来拒绝、过期/坏参数非0。新模式不能被旧--check或默认build悄悄启用；无效或混合模式参数明确拒绝。
6. 生成入口/前端/核心/关闭制品与相同计划下受审旧路径逐字节一致；关键身份门槛继续保留。完整编号默认不勾选，不新增复制/收集按钮。

只运行受影响核验包套件与必要业务打包回归，先报告实测数字/必要失败；不要跑无关既有失败套件。SDK相关测试继续使用已有本地依赖，不能联网安装。

## 5. 独立证据与历史保护

新命名证据脚本默认stdout、--out wx；运行时摘要定位打包器与测试，reviewBasis单列。把源码观察/合成链/本地CLI与真实平台明确分述。守卫探针与业务期意外独立计数，包含被catch尝试；同一实际意外计数决定ok与exit。若必须验证子进程，只允许明确的本地Node测试CLI白名单，子进程网络也设守卫，不把全部spawn普遍放行。

不得改旧审计v7/v8、收尾v2/v3、历史JSON、Codex报告/反例/冻结执行脚本以消除摘要失败。若需要新的审计基线，另存新版本并记录摘要，旧历史保持。状态记录以字节安全前缀追加，原blob完整保留后缀并比对。

## 6. 将来执行安排（本轮不执行）

复查通过后由Codex与用户约定未来窗口，例如先留20—30分钟供确认、导入、手动预览，随后才进入30分钟身份读取窗口；时间以届时真实安排为准，本文件不预约今晚具体时间。到窗口内才执行候选覆盖，仍须留足15分钟余量；结果出现即关闭并回读8文件。准备和预览不能修改计划/延长窗口。

2号完整编号由本人自愿在唯一提交前勾选，结果出现先关闭，再当面交给0号、逐段核对；公开截图遮挡完整编号。不登记、写库、授角色；1号补交另立新轮。此流程文案沿用，不实现新收集系统。

## 7. 交付与Git

沿用现有master，不重置/清理/改写历史；先查工作区。仅本地实现、自测和记录，完成一轮保存一次提交，标题注明实测数字与“待Codex审查，真实平台未验证未放行”。暂存逐文件扫描凭据；artifacts/依赖/临时脚本不入Git。报告提交号、改动范围、测试与证据、历史字节核对、工作区状态，然后停止。

禁止联网、取凭据/读认证缓存、SDK令牌工具、云日志、预览/部署/上传/启用/真实调用、登记/初始化/写库/建资源、改权限费用、清缓存、处理A/B/C。远端仅保留16:34已核关闭历史d3801edd…d60b，本轮不查询。不生成真实批准；1号/2号不重试。
