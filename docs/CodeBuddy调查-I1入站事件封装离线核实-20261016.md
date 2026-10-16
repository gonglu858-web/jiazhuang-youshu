# CodeBuddy 调查：I1 入站事件封装离线核实

日期：2026-10-16。执行者：CodeBuddy。依据：[Codex诊断-参与者I1请求字段拒绝-20261016.md](Codex诊断-参与者I1请求字段拒绝-20261016.md) §3 定点任务、[CodeBuddy开发交接](CodeBuddy开发交接.md) §3。初版基线 `0fd3094`；**2026-10-16 依 [Codex复查](Codex复查-I1入站调查与取证方案-20261016.md) C1–C4 修订本文：§1/§2/§3 的排他性结论已更正，§4 取证方案替换为受控最小诊断（已本地实现待审查），§6 更新交付。原始文字见该提交的 git 历史。**

## 1. 结论（依复查更正后）

1. **受审应用链路逐字节核实干净**。核验页面→客户端只构造 `action`/`passphrase`/`checkRoundId`（勾选时加 `includeFullUserId`）共 3～4 个键；服务端入口把平台传入的 `event` 原样交给核心，不改写、不包装；核心 `assertRequest` 对 `Object.keys(event)` 逐键按 4 键白名单校验，遇首个未知键即 `PIC_REQUEST_INVALID`，且先于口令、可信上下文、窗口与任何数据库访问。
2. **已查服务端 SDK 锚点未发现可解释本次额外键的代码**。wx-server-sdk 3.0.1 的 `callFunction` 包装层把 `data` 原样传给 tcb 实例；@cloudbase/node-sdk 2.10.0 的 `callFunction` 经 `JSON.stringify(data)` 序列化后作为 `request_data` 发出——这是**云函数间/服务端出站调用路径**，不是手机基础库发出请求与平台入站处理的完整路径，不能据此称整链"逐字节透传"，也不能推出入站信封形状。可信身份（OPENID/APPID）来自平台注入的 `WX_*` 环境变量（`getWXContext` 读 `process.env.WX_CONTEXT_KEYS` 机制），与 event 无关。
3. **实际额外键、来源与注入时点尚不确定**。受审应用源码与已查服务端 SDK 锚点均不能解释额外键；手机基础库与云平台入站处理（`wx.cloud.callFunction(data)` 与 `exports.main(event)` 之间的封装层）是**待核查边界**，该层不在任何本地制品中，离线无法定名。按诊断要求不盲改：白名单不扩、未知字段不过滤。
4. **截图能支持的仅是：候选入口/核心的错误结果确实出现**（`PIC_REQUEST_INVALID`、`readAttempted=false`、UNKNOWN、无尾号/服务端时间）。由此可确认的是**打包常量门槛**（入口 `CONFIG_ENABLED === true` 且 `CONFIG_APP_ID`/`CONFIG_ENV_ID` 与受审固定常量一致）已通过——这是装配期的静态常量核对，**不等于** `assertTrustedTarget` 通过，**不等于**调用者的 APPID/env 身份已被核实；常量门槛与可信运行时校验是两道不同的门槛。该结果与 [5/5 离线对照](证据/Codex参与者I1请求字段拒绝定位-20261016.json) 的错误分支一致。

## 2. 证据锚点（来源、版本、位置）

| 环节 | 文件（均哈希核对） | 位置 | 事实 |
|---|---|---|---|
| 页面请求 | `miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js` | 原初版对应行（本轮 C3 后行号有变，见 git） | 请求字面量仅 `action`/`passphrase`/`includeFullUserId` |
| 客户端封装 | 同目录 `frontend/utils/identity-check-client.js` | payload 构造与 `callFunction({name, data: payload})` | 仅 3+1 键；`includeFullUserId` 仅在 `=== true` 时加入 |
| 固定目标 | 同目录 `frontend/config/cloud.js` | L4-8 | 环境/函数/轮次固定，调用方不可注入 |
| 服务端入口 | 同目录 `server/index.js`（装配锚点替换生成） | `exports.main` | `return checker.handle(event);` event 原样透传 |
| 核心白名单 | `miniapp/scripts/lib/participant-identity-check.cjs` | `REQUEST_FIELDS`、`assertRequest` | 4 键白名单；`Object.keys(payload)` 逐键拒绝；拒绝先于可信上下文/窗口/读取 |
| 失败净化 | 同核心 | 错误白名单与 catch 映射 | 内部拒绝消息含键名（`'请求含未登记字段：'+k`），对外只映射固定文案 `请求含未登记字段。`，键名不出服务端 |
| wx-server-sdk | 本机副本 `C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/wx-server-sdk`（version `3.0.1`） | 打包模块 `src/api/functions/api/callFunction.ts` 与 `src/api/cloud/provider/tcb/api/callFunction.ts` | `data: options.data || {}` 传入 tcb 实例；全包（js/d.ts/README/CHANGELOG）`userInfo` 计数 0 |
| 身份来源 | 同上 | 打包模块 `src/api/utils/api/getWXContext.ts` | `getWXContext` 从 `process.env.WX_CONTEXT_KEYS` 列出的 `WX_*` 环境变量构造上下文（黑名单 `API_TOKEN`/`TRIGGER_API_TOKEN_V0`；ENV 取 `TCB_ENV`/`SCF_NAMESPACE`，SOURCE 取 `TCB_SOURCE`）——身份不经 event |
| @cloudbase/node-sdk | 同 node_modules 下 `@cloudbase/node-sdk`（version `2.10.0`） | `lib/functions/index.js` | `request_data = JSON.stringify(data)` 序列化透传（服务端出站路径）；lib 22 个 js 文件中 `userInfo` 仅 5 处，全部位于 `auth/index.js`（`getUserInfo()` 返回形状）与 `storage/index.js`（内部读取），与 callFunction/信封无关 |

以上事实由 [审计脚本 v2](证据/CodeBuddyI1入站事件封装离线核实-20261016.cjs) 固化（C4 修正后）：默认 stdout；`--out` 独占新建；打包器自身摘要外置写死并先行核对，再从其字节中提取 `PINNED_SOURCES` 全部 13 项逐文件真实比对（漂移即失败退出）；内存漂移反例必须被拒绝；计数为实际断言累计；守卫命中区分敏感性探针与业务期意外（含被 catch 者）。首轮 [v1 结果](证据/CodeBuddyI1入站事件封装离线核实-20261016.json) 为历史证据保留不改；其"打包器仅 assert 存在 PINNED 字符串、漂移不拒绝"的缺陷已由复查用内存反例证实并在 v2 修复。过程事实：v1 首轮"node-sdk lib userInfo 全零"断言曾被直接扫描证伪（实为 auth/storage 的 getUserInfo 形状 5 处），如实修正后通过；另有一次带忽略规则的搜索工具漏报，以直接递归扫描为准。

## 3. 平台信封边界与 userInfo 的记载状态

- 手机基础库与云平台入站处理不属于本项目任何本地制品；本地已查 SDK 均运行在**服务端出站/云函数间**路径，不在该入站层。入站信封的实际形状、额外键名、注入方与注入时点**均未确定**。
- **历史版本材料中"平台向 event 注入 userInfo"零记载**（本报告初版时点：核心/模板/打包器/测试无此概念；wx-server-sdk 3.0.1 全包 0 处；@cloudbase/node-sdk 2.10.0 的 5 处均与信封无关）。当前实现包含 `userInfo` 与 `wxCloudApiToken`（后者为本机 node-sdk 静态锚点假设）固定候选字典与合成注入测试——它们是识别与测试夹具，**不构成平台实际注入的证据**；2026-10-16 真实诊断轮（i1diag-20261016-2c8461b684ea）截图仅证明 userInfo 被识别且另有 1 个 9–16 码元未知键，未知键的名称/值/注入来源仍未知。
- "平台会注入 `userInfo`（appId/openId 等）"仅来自项目外的公开文档知识（旧版官方文档曾记载小程序端调用自动注入 `event.userInfo`；官方亦记载云函数互调时后端注入 userInfo）。按诊断报告与复查要求，**不把该记载当作本次根因**，也不据此放行或过滤任何字段。

## 4. 受控最小键诊断（复查 C2/C3 收紧后方案；已本地实现，待 Codex 审查；未部署）

原 unknownKeys 方案（返回截断键名）被复查否决：键名本身可携带口令/OPENID/任意秘密文本，截断不能保证不泄漏，且在准入门槛之前输出输入派生内容。收紧后的设计（本轮已实现于核心/模板/打包器/页面，配套测试与证据见 §6）：

1. **默认关闭**：`plan.keyDiagnostic`（布尔、缺省 false）→ 打包器唯一锚点替换入口 `CONFIG_KEY_DIAGNOSTIC`；普通核验包与关闭包无诊断能力；开关与协议版本（`participant-identity-key-diagnostic/1`、scope `request-keys-only`）纳入计划、manifest 与受审来源字节绑定（`assertCoreDiagnosticBinding` 逐字断言核心字节），`checkDir` 拒绝手改（manifest 翻转与入口翻转均被重建比对拒绝）。
2. **全门槛准入**：仅在动作、轮次、口令、可信目标、**当下窗口**全部复核通过时才构建诊断；缺上下文/错轮次/错口令/过期/无效时钟的诊断为空。结果码保持 `PIC_REQUEST_INVALID`、`ok:false`、UNKNOWN 语义与 `readAttempted` 事实不变；错口令+额外键等组合的行为与既有事实一致（请求键门槛仍最先）。
3. **净化输出**：只含源代码固定候选标签（当前字典：`userInfo → CANDIDATE_USERINFO`、`wxCloudApiToken → CANDIDATE_WX_CLOUD_API_TOKEN`；后者仅是本机 node-sdk 静态锚点（15 码元，落 9–16 桶）提出的**待验证假设**，不证明手机入站真实键名，也不因此成为允许业务字段或可信身份）、其它键计数与键名长度分桶（固定边界 `len<=4/5-8/9-16/17-32/lenOver32`）、截断标志。大小写/相似名不误识别；不返回任意原键名/值/前后缀；诊断枚举仅对请求顶层键名做 `Object.keys`——不读取**额外未知字段**的值/getter/`__proto__`（准入校验本身必须读取 action/round/passphrase 等已允许字段的值，该承诺不扩展到任意对象访问）；不记录原始 event；总大小有界；诊断构造异常与构造后/附加前窗口失效一律撤销诊断（R2）。零 DB 访问、零业务写、零持久写入；**本实现自身无主动日志记录，但不承诺平台侧零日志**。
4. **手机可见取证路径**：客户端按固定 schema **严格**验证诊断——必需字段缺失/类型错误/越界、候选标签非法/重复/超量、非负安全整数违约、计数与分桶总和不一致——**整份丢弃，不修补成默认值**；额外未知字段仅投影丢弃。截断契约一致性已执行校验（S2）：`truncated=true` 仅在「候选标签数已达上限(8)且有未列出候选」时成立，而合法标签只能来自固定词表且不得重复——当前词表容量 1 < 8，故当前协议下 `truncated=true` 必然矛盾，客户端整份拒绝；未来扩词表须同时满足「labels 数 === 上限」且「词表容量 ≥ 上限」。**大小界限口径分述**：源码确有序列化长度防御检查（实现用字符串长度即 UTF-16 码元，全 ASCII 投影下与 UTF-8 字节数一致）；固定字段+单词表+安全整数约束下合法投影**结构上**远小于 1KB；现有畸形用例**未动态触达**该防御分支（无实际超 1KB 用例，不宣称动态覆盖）。页面仅展示净化后的固定文本（无自动请求、无重试、无新增按钮，口令照常清除）。
5. **生效方式**：Codex 审查本实现 → 新具体取证执行包 → 用户确认后才重新打包/部署/一次调用/关闭（沿用 I1 配对关闭流程与字节回读）；1 号不自动重试。读云函数日志取证仍不采用（本轮及原诊断均禁查云日志）。若捕获到候选标签/计数证据，再评估"针对已确认元信息的最小边界适配"——那是下一轮有据任务。

## 5. 未验证项

- 真实平台 event 信封形状：本次根因键名、注入方（基础库/后端）、注入时点——离线不可得，待取证轮（先经 Codex 审查与用户确认）。
- 手机微信/基础库版本；微信开发者工具基础库（app.asar）未读取（且模拟器路径不能代表手机行为，证据价值有限）。
- 诊断实现仅离线合成验证（测试与全链证据），真实平台行为完全未验证。

## 6. 交付与状态

- 初版（`0fd3094`）：调查报告 v1、[审计脚本 v1 + JSON](证据/CodeBuddyI1入站事件封装离线核实-20261016.json)（历史证据保留不改）。
- 本轮修订（C1–C4）：本报告更正；核心/入口模板/client/页面/WXML 受控诊断；打包器计划/manifest/锚点/协议绑定与 `PINNED_SOURCES` 更新（5 个受改源文件基线随受审更新）；[审计脚本 v2](证据/CodeBuddyI1入站事件封装离线核实-20261016.cjs) 与 [v2 结果](证据/CodeBuddyI1入站事件封装离线核实v2-20261016.json)；核验包测试扩至 26 项（D1/D2 全链诊断、门控反例、秘密键名反例、零 DB、关闭包无诊断、手改拒绝）。
- 未改：源业务页面、云函数/vendor、P/E/X 打包器、管理员链、旧生成器、原 miniapp 配置、历史证据与旧冻结执行包。
- R1–R4 收尾（复查 880fbf8 §2–§6）：R1 审计业务期意外>0 非零退出+ok 字段（反例经注入被 catch 的守卫命中验证）；R2 诊断构建后与最终附加前各重查窗口，构造期间到期/NaN/抛错撤销诊断（构造前有效/构造后失效反例固化）；R3 manifest 诊断协议/scope 对 true/false 两候选统一严格校验（缺失/错值/篡改均拒绝）；R4 客户端严格验证（必需字段/标签合法值与重复与数量/安全整数/计数分桶一致/序列化上限）违约整份丢弃并走生成页验证不展示。同轮口径更正见 §3/§4（零记载限历史版本、平台日志表述、getter 范围）；manifest 的 SDK 转换说明已由打包器边界行更正（本次打包不执行转换，历史已有本地验证，平台未验证）。新增 [审计 v3 结果](证据/CodeBuddyI1入站事件封装离线核实v3-20261016.json) 与 [R1–R4 收尾证据](证据/CodeBuddy受控诊断R1R4收尾-20261016.json)；测试扩至 30 项（D3–D6）。
- S1/S2 收尾（复查 23f3ffb §2–§4）：S1 收尾证据脚本外层守卫计数（探针/业务期意外/总数）写入 JSON 并以同一实际计数决定 ok/退出码——外层被 catch 意外注入反例 ok=false/exit1，正常对照意外0/exit0，内部审计预期反例（exit 0/1/1）与外层意外分述不清零；S2 客户端截断契约一致性校验——空标签+true、单标签+true 均整份拒绝，false 合法对照保留，生成页面矛盾诊断不展示且不出现「已截断」。大小界限口径分述见 §4.4（14 类畸形不含实际超 1KB 用例，防御分支未动态触达）。新增 [S1/S2 收尾证据](证据/CodeBuddy受控诊断S1S2收尾-20261016.cjs/.json) 与 [审计 v4](证据/CodeBuddyI1入站事件封装离线核实v4-20261016.json)；测试扩至 31 项（D5 扩展 + D7）。
- 第二固定候选（[分析](Codex分析-I1受控诊断手机结果-20261016.md)/[任务](CodeBuddy任务-I1第二额外键固定候选诊断-20261016.md)，基线 `196f91c`）：核心词表增加 `wxCloudApiToken → CANDIDATE_WX_CLOUD_API_TOKEN`（待验证假设）；客户端合法标签集同步；词表容量 2 仍 < 8，truncated=true 仍全部拒绝；REQUEST_FIELDS 零扩展；候选值/getter 零访问，大小写/相似名按其它键计数。实测：核验包 **32/32**（新增 D1b、D2 双候选信封、D5 新标签）、业务包 18/18、member-access-sdk 1/1；[第二候选证据](证据/CodeBuddyI1第二候选诊断证据-20261016.json)（生成器为 [R1R4 收尾脚本扩展](证据/CodeBuddy受控诊断R1R4收尾-20261016.cjs)：r5 双标签/秘密不泄漏/相似名不误识/getter 0/生成链两标签可见）与 [审计 v5](证据/CodeBuddyI1入站事件封装离线核实v5-20261016.json) ok=true、意外 0。
- **状态：本地实现与自测完成，待 Codex 审查；真实平台未验证未放行；本轮云端操作 0。**
