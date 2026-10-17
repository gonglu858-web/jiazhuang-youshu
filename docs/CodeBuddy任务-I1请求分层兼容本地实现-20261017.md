# CodeBuddy任务：I1请求分层兼容，仅本地实现与自测

## 1. 授权、依据与接手

2026-10-17用户明确：“按此方案交给 CodeBuddy，仅本地实现和自测”。本文件确认采用[20261016设计方案](Codex方案-I1请求分层兼容设计-20261016.md)推荐方案及§3–§6契约；原设计文档和来源核对JSON保留当时状态与字节，由本任务和[授权记录](证据/CodexI1请求分层本地实施授权-20261017.json)记录后续批准。

项目根：C:\Users\30591\Documents\ChatGPT\装修进度验收APP。接手参考2aa1780（底层受审实现f0b7fa9）；接手实际HEAD应包含本任务提交，先核对master、HEAD、未提交/未跟踪文件。不得重建仓库、重置、清理或覆盖他人成果。

先读AGENTS.md、docs/当前状态.md、docs/CodeBuddy开发交接.md、本任务、设计方案全文及docs/Codex分析-I1第二候选手机结果-20261016.md。方案与本任务均不可省略；本任务不放宽方案的拒绝条件。

已关闭：第二候选诊断已完成；本轮仅命中userInfo，另有一个9–16码元未知键。停止猜词表，未知名/来源仍未知；核心只读、原身份/轮次/口令/窗口/字段投影与关闭包已有审查结论，不重做无关开发。I1身份和登记状态尚未确认。

## 2. 允许实现范围

- 新增本核验包专用请求适配器；由本包打包器复制入server/scheduleSandbox，入口相对require闭包。允许修改本包server入口模板、frontend客户端及协议配置模板、package-participant-identity-check.cjs、定点测试、操作说明、新证据和当前状态/进展/CodeBuddy交接。
- 核心participant-identity-check.cjs业务实现保持字节不变，不扩大REQUEST_FIELDS、不改身份算法、读取/结果语义或诊断词表。源业务App/Page/client、miniapp/cloudfunctions/vendor、P/E/X业务打包器、管理员/P4/凭据链、旧生成器、原项目配置、关闭来源、历史证据与旧冻结包不得修改。页面主体如无协议依赖变更需求保持不动。
- 请求改为固定picRequest内层对象，schema=participant-identity-request/1。适配器按设计§3验证后只构造新的原四字段对象交给核心；schema不进入核心，不传event/原型/附带值。禁止spread、Object.assign、整event JSON克隆；不自动回退旧格式。
- 外层附带字段只查必要键名、不读值/getter、不输出键名或值；不是信任平台元数据。严格落实设计§3.1的冲突拒绝名单、自有数据属性、Symbol/原型/访问器与异常净化边界；内层额外字段/伪造身份/非枚举/访问器/类型错误全部拒绝。
- 适配在cloud.database()构造前；失败用既有结果schema/PIC_REQUEST_INVALID/UNKNOWN/readAttempted=false，零database工厂/collection/get，无诊断或原始异常。核心入口后的错误码和尝试事实不改；SDK工厂与真实读取尝试分别计数。
- 新计划participant-identity-plan/2、manifest participant-identity-check-candidate/2，必填requestProtocol；协议绑定计划、清单、前后端及适配器。缺/错版本与旧v1拒绝，禁止自动升级。keyDiagnostic只允许false/缺省false，true拒绝；旧核心诊断保留但本新协议不启用。
- 来源PINNED包含新增适配器及受改模板，审计外置打包器摘要同步。候选文件数量真实统计；关闭仍23文件/8服务端文件，字节与映射不变。保持来源重建、wx新建、链接边界、复用续建、部分写/竞态事实与时效门槛。旧v1证据和冻结包不迁移；历史核验用原版本工具，不篡改旧证据适配新实现。

## 3. 验收与证据

完整落实设计§6矩阵，不能以测试总数代替分支证明：

1. 合法新协议+外层userInfo/任意未知键、双候选名、多个附带键，进入本人只读链；附带值为秘密/抛错getter时getter计数0、结果/日志无秘密。测试清楚使用合成值，不读取SDK令牌上下文。
2. 旧格式、混用、内层未知/自报身份、外层冲突、缺/错schema、继承/自定义原型/非枚举/Symbol/访问器/元操作抛错，全链拒绝；适配失败实际工厂/collection/get计数0，不手造零值。
3. 错口令/轮次/动作/可信身份或目标/时间均拒绝；提取、读取和返回阶段推进时钟，含expires==now/NaN/抛错。通过的请求最多一次本人主键三字段get，零写/事务；权限失败保留readAttempted，UNKNOWN不作ABSENT。
4. 实际生成App→Page→client→入口→适配器→未改核心→合成db；合成传输后添加外层附带键。验证口令清除、单击单发、加载/切前台零发送、完整编号缺省/勾选/取消即时清除；禁止替换核心造成功。
5. 生成入口接已有本地wx-server-sdk3.0.1和database1.4.1，init/database参数经过真实SDK；合成上下文/工厂/传输替换范围逐项披露。存在/不存在/权限失败三路，删除throwOnNotFound:false敏感性反例必须改变不存在路结果。已有本地SDK路径C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/wx-server-sdk；不可用则报告阻断，不联网安装。
6. 协议/计划/清单/适配器/前后端漂移反例，来源漂移写前零产物；关闭包独立校验不依赖候选窗口，并拒绝新旧请求零DB，关闭包无适配器/诊断能力。
7. 核验包相关完整测试、business-test-package既有18项、member-access-sdk已有本地SDK回归；只迁移受影响的本包测试，不扩修无关既有失败。发现设计矛盾给出证据和建议，不能临时改核心/保护范围或放宽准入以造绿。
8. 新证据脚本默认stdout、--out新路径wx。探针/业务意外/总数来自实际守卫计数；被catch意外使ok=false/exit1，用注入反例证明。运行时实现摘要、审查依据、版本口径分列；用新脚本/JSON，不改历史反例或旧JSON。严格区分静态检查、合成全链、真实SDK本地转换与真实平台未验证；不宣称平台零日志、零费用、一次性口令或全局限流。

## 4. 记录、Git与停止

本轮用合成轮次/口令/身份，不能生成真实执行批准或可用真实窗口。更新当前状态、操作说明、进展与CodeBuddy交接；两份历史按字节顶部追加，旧HEAD blob完整后缀并核对。Codex方案和旧来源证据保持不改；如需解释差异写新实现说明。

完成后逐文件检查差异及AKID/secretKey/sessionToken/token长值模式，确保无认证缓存/登录态/凭据。artifacts/node_modules/临时诊断文件不提交。沿用现有master，以仓库历史身份Codex <codex@localhost>保存一次本地提交，不改全局配置。提交信息注明实测数字、“本地代码完成待Codex审查；真实平台未验证未放行”。交付提交号、父提交、文件范围、测试/证据摘要、保护路径差异、工作区状态和剩余阻断后停止。

禁止联网、安装、取真实凭据/读认证缓存/SDK令牌上下文、查云日志、预览/部署/上传/启用/真实调用、登记/初始化/写库/建资源/改权限费用、清用户缓存或处理A/B/C。远端沿用2026-10-16 22:15已核关闭（496a4397…5830），本轮不查询或变更。1号不重试，I2/P不开展。本地通过后由Codex独立审查，再决定是否提出新真实执行包；本任务不是云端批准。
