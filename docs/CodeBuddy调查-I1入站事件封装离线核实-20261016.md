# CodeBuddy 调查：I1 入站事件封装离线核实

日期：2026-10-16。执行者：CodeBuddy。依据：[Codex诊断-参与者I1请求字段拒绝-20261016.md](Codex诊断-参与者I1请求字段拒绝-20261016.md) §3 定点任务、[CodeBuddy开发交接](CodeBuddy开发交接.md) §3。基线 `2f99a48`（交接提交，接手时工作区干净）。**本轮离线只读，无云操作，无产品代码/模板/打包器改动。**

## 1. 结论

1. **应用侧链路逐字节核实干净**。核验页面→客户端只构造 `action`/`passphrase`/`checkRoundId`（勾选时加 `includeFullUserId`）共 3～4 个键；服务端入口把平台传入的 `event` 原样交给核心，不改写、不包装；核心 `assertRequest` 对 `Object.keys(event)` 逐键按 4 键白名单校验，遇首个未知键即 `PIC_REQUEST_INVALID`，且先于口令、可信上下文、窗口与任何数据库访问。
2. **本地 SDK 链不含任何信封改写**。wx-server-sdk 3.0.1 与 @cloudbase/node-sdk 2.10.0 的 `callFunction` 两侧均把 `data` 逐字透传；可信身份（OPENID/APPID）来自平台注入的 `WX_*` 环境变量（`getWXContext` 读 `process.env.WX_CONTEXT_KEYS` 机制），与 event 无关。
3. **因此多余顶层键只能产生于微信云平台信封**——手机基础库与云调用后端在 `wx.cloud.callFunction(data)` 与 `exports.main(event)` 之间的封装层。该层不在任何本地制品中，**离线无法证实具体键名与来源**。按诊断要求不盲改：白名单不扩、未知字段不过滤。
4. 截图与该出口完全吻合（`readAttempted=false`、UNKNOWN、无尾号/服务端时间），并可反推：调用时刻候选函数 `enabled=true` 且 APPID/envId 固定目标校验通过（入口门槛先于核心），拒绝仅发生在请求键门槛。这一事实与 [5/5 离线对照](证据/Codex参与者I1请求字段拒绝定位-20261016.json) 一致。

## 2. 证据锚点（来源、版本、位置）

| 环节 | 文件（均哈希核对） | 位置 | 事实 |
|---|---|---|---|
| 页面请求 | `miniapp/scripts/templates/participant-identity-check/frontend/pages/identity-check/identity-check.js` | L71-76 | 请求字面量仅 `action`/`passphrase`/`includeFullUserId` |
| 客户端封装 | 同目录 `frontend/utils/identity-check-client.js` | L29-39 | payload 仅 3+1 键；`includeFullUserId` 仅在 `=== true` 时加入；`callFunction({name, data: payload})` |
| 固定目标 | 同目录 `frontend/config/cloud.js` | L4-8 | 环境/函数/轮次固定，调用方不可注入 |
| 服务端入口 | 同目录 `server/index.js`（装配锚点替换生成） | L48-77 | `exports.main = async event => …; return checker.handle(event);` event 原样透传 |
| 核心白名单 | `miniapp/scripts/lib/participant-identity-check.cjs` | L57、L217-236 | `REQUEST_FIELDS` 4 键；`Object.keys(payload)` 逐键拒绝；拒绝先于 `assertTrustedTarget`/`assertWindowOpen`（`handle` L361-365 顺序已断言） |
| 失败净化 | 同核心 | L62-78、L391-407 | 内部拒绝消息含键名（`'请求含未登记字段：'+k`），但对外只映射固定文案 `请求含未登记字段。`，键名不出服务端 |
| wx-server-sdk | 本机副本 `C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules/wx-server-sdk`（package.json version `3.0.1`） | 打包模块 `src/api/functions/api/callFunction.ts`（index.js 内 L1685-1765）与 `src/api/cloud/provider/tcb/api/callFunction.ts`（L300-330） | `data: options.data || {}` 透传 tcb 实例；全包（js/d.ts/README/CHANGELOG）`userInfo` 计数 0 |
| 身份来源 | 同上 | 打包模块 `src/api/utils/api/getWXContext.ts`（index.js 内 L2864-2928） | `getWXContext` 从 `process.env.WX_CONTEXT_KEYS` 列出的 `WX_*` 环境变量构造上下文（黑名单 `API_TOKEN`/`TRIGGER_API_TOKEN_V0`；ENV 取 `TCB_ENV`/`SCF_NAMESPACE`，SOURCE 取 `TCB_SOURCE`）——身份不经 event |
| @cloudbase/node-sdk | 同 node_modules 下 `@cloudbase/node-sdk`（version `2.10.0`） | `lib/functions/index.js` L16-57 | `request_data = JSON.stringify(data)` 逐字透传；lib 22 个 js 文件中 `userInfo` 仅 5 处，全部位于 `auth/index.js`（`getUserInfo()` 返回形状）与 `storage/index.js`（内部读取），与 callFunction/信封无关 |

以上事实由 [审计脚本](证据/CodeBuddyI1入站事件封装离线核实-20261016.cjs) 以 32 项断言固化，结果见 [JSON](证据/CodeBuddyI1入站事件封装离线核实-20261016.json)：6 个项目文件 SHA-256 与打包器 `PINNED_SOURCES` 受审基线一致（所审即受审源）；守卫意外 0；云端操作 0。过程如实记录：首轮“lib 内 userInfo 全零”断言被直接扫描证伪（实为 auth/storage 5 处），该轮未写 JSON，修正断言后通过；另有一次带忽略规则的搜索工具漏报，直接递归扫描为准。

## 3. 平台信封边界与 userInfo 的记载状态

- `wx.cloud.callFunction(data)` 与函数 `exports.main(event)` 之间的封装由微信客户端基础库与云调用后端实现，**不属于本项目任何本地制品**；本地 SDK 均不在此层运行。
- **本地全部材料中“平台向 event 注入 userInfo”零记载**：核心/模板/打包器/测试无此概念；wx-server-sdk 3.0.1 全包 0 处；@cloudbase/node-sdk 2.10.0 的 5 处均与信封无关。
- “平台会注入 `userInfo`（appId/openId 等）”仅来自项目外的公开文档知识（旧版官方文档曾记载小程序端调用自动注入 `event.userInfo`；官方亦记载云函数互调时后端注入 userInfo）。按诊断报告要求，**不把该记载当作本次根因**，也不据此放行或过滤任何字段。

## 4. 最小取证方案（待 Codex 审查；本轮未实施、未部署）

唯一目的：用**一次**真实调用拿到实际多出的**键名**（键名，不含任何值）。设计要点：

1. 核心对 `REQUEST_INVALID` 的失败结果附加受限摘要：`unknownKeys`（被拒键名列表，排序、去重、上限 8 个、单个截断 64 字符）与固定标记 `diagnosticScope: 'request-keys-only'`；其余一切失败出口不附加。不输出键值、口令、OPENID、原始 event。
2. 实现位置：`participant-identity-check.cjs` 的 `assertRequest` 拒绝处收集 + `handle` catch 路径透出（约 L217-236、L391-407）；同步更新打包器 `PINNED_SOURCES` 受审摘要（R3 基线）、结果 schema 说明与相称测试（正常请求无诊断字段、未知键只出键名、伪造身份字段的值不出现在摘要、业务期出口不带诊断字段、键名截断/去重边界）。
3. 生效方式：Codex 审查方案 → 用户批准的新具体执行包 → 重新打包/部署/一次调用/关闭（沿用 I1 配对关闭流程与字节回读）；1 号不自动重试。
4. 备选不采用：读云函数日志取证（本轮及原诊断均禁查云日志；函数当前也不打印键名）。若键名捕获成功，再评估“针对已确认元信息的最小边界适配”（仅放行平台注入的固定元信息键且值一律不采信，身份仍只取 `cloud.getWXContext`）——那是下一轮有据任务。

## 5. 未验证项

- 真实平台 event 信封形状：本次根因键名、注入方（基础库/后端）、触发条件——离线不可得，待取证轮。
- 手机微信/基础库版本；微信开发者工具基础库（app.asar）未读取（解析尝试未完成；且模拟器路径不能代表手机行为，证据价值有限）。
- 取证方案未实现、未审查；本轮无真实调用（云端保持最近已核关闭状态）。

## 6. 交付与状态

新增：本报告、[审计脚本](证据/CodeBuddyI1入站事件封装离线核实-20261016.cjs)与 [JSON](证据/CodeBuddyI1入站事件封装离线核实-20261016.json)（`wx` 独占创建，未覆盖历史证据）。未改：产品代码、模板、打包器（`PINNED_SOURCES` 未动）、历史证据、云函数/vendor、管理员链。**状态：调查完成待 Codex 审查；取证方案未实施；真实平台未验证未放行；本轮云端操作 0。**
