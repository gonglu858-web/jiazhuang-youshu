# WorkBuddy 任务：临时测试入口的版本隔离

状态：WorkBuddy已完成返修，Codex复查通过，R1/R2关闭。见[返修复查证据](证据/临时测试入口版本隔离返修复查-20261001.json)。本任务完成，不代表第一单元整体验收。

## 问题与目标

并发批准配置已关闭且通过 Codex 复查。但首页 `openCloudAccess`、`openPermissionCheck` 仍直接跳转；身份测试页的公共 `call` 只检查 cloudReady，一般成员操作和早期 `runWriteAccessMode` 没有统一的 AppID／版本门槛。数据库探针只排除 release，版本缺失或未知时未默认拒绝。因此“并发入口关闭”不代表其他临时入口已隔离。

本轮目标：第一单元身份测试、数据库权限测试及首页云连接诊断，仅在正确 AppID、正确环境、明确的 develop 或 trial 版本可执行；release、未知／缺失版本、取账号信息失败或目标不符时，界面不提供入口，直接调用处理函数也不发出云请求。保留开发／体验版本用于剩余验收。此客户端限制不替代现有服务端权限验证。

## 范围与实现要求

1. 目标固定：AppID `wxfb4db1615ac15531`，环境 `cloud1-d8gcq5ag39d847723`。增加小型共用判断函数，读取 `wx.getAccountInfoSync().miniProgram` 并使用明确允许列表。异常、空数据、未知值均拒绝，不能回落为开发版本。
2. 首页隐藏不可用的三个诊断入口（云连接、身份测试、数据库权限测试），对应事件处理器也检查；不改变本地项目列表、试用账号、施工安排、现场记录、成员查看或本地数据。
3. `pages/access/access` 页面进入／恢复时检查，受限状态只显示简明不可用提示；公共云调用出口在每次请求前再检查，覆盖直接路由、事件直接调用、已存在页面恢复及普通成员操作。核对页面中是否还有绕开公共出口的云请求，逐一覆盖。不得只依靠隐藏按钮或一次 onLoad 判断。
4. `pages/permission-check/permission-check` 页面也有进入限制；数据库探针实际访问数据库前使用相同严格条件，未知版本不再放行。保留原目标集合限制、一次尝试规则和错误分类。
5. 已关闭的 `valid-concurrent-approval-proof.js` 保持关闭、空凭据和冻结结构。旧编号／批准配置不续期、不改动；不删除探针逻辑、历史证据、手机缓存、防重标记或报告。保留已审查探针的账号、时间窗、防重及云端身份校验。

可改文件限于共用入口判断工具、首页、上述两个测试页、数据库权限探针、相关测试及交付记录。不要修改云函数、数据库规则、其他业务页面、测试证据或 AppID／环境配置。保留现有路由，以执行门槛处理直接进入的情况。

## 验收标准

- 使用桩替代云 API，在 release、未知／缺失版本、账号信息 API 抛错、错 AppID、错环境下，直接调用页面事件／公共出口及数据库探针，云函数与数据库调用次数均为0；仅界面隐藏不算通过。
- 正确目标的 develop／trial 仍可走已有测试流程，原角色、凭据和防重限制保持；不要使用真实云端调用做自测。
- 模拟页面由允许变为不允许后再触发操作，仍须零云请求。
- 本地四类页面继续工作；并发配置保持禁用，其39项相关测试继续通过。
- 运行适当的既有与新增测试、语法检查及 WXML/WXSS 编译，记录真实数量和跳过原因。无需安装新依赖，禁止为过测试删改原有断言。

## 交付

在本文件末尾记录改动文件、自测结果及无云端写入声明，并更新进展顶部。完成后交 Codex 审查。用户本轮无需重新扫码、取号或批准；不生成预览、不部署、不发布。

未覆盖项继续保留：纯家庭成员独立微信真机测试、两个不同主业主申请的真实并发唯一性。后者需另行制定有效申请与账号基线，不可复用已批准申请、不凭本地模拟宣称完成。

## 实际交付记录

- 交付时间：2026-10-01 13:33（北京时间）
- 修改文件：
  - 新增 `miniapp/miniprogram/utils/env-gate.js`：统一环境门控，仅允许目标 AppID 的 develop/trial 版本通过。
  - `miniapp/miniprogram/pages/index/index.js` + `index.wxml`：首页隐藏云连接、身份测试、数据库权限三个诊断入口；事件处理器与 `checkConnection` 先调门控。
  - `miniapp/miniprogram/pages/access/access.js` + `access.wxml`：`onShow`、公共 `call` 出口每次请求前调门控；受限时显示不可用提示。
  - `miniapp/miniprogram/pages/permission-check/permission-check.js` + `permission-check.wxml`：页面加载与事件处理调门控；隐藏不可用时按钮。
  - `miniapp/miniprogram/utils/permission-probe.js`：`collection()` 中对未知/缺失版本、账号信息读取失败、错 AppID/环境统一拒绝。
  - 新增/扩展测试：`miniapp/tests/env-gate.test.cjs`、`miniapp/tests/pages.test.cjs`、`miniapp/tests/access-page-probe.test.cjs`、`miniapp/tests/permission-probe.test.cjs`、`miniapp/tests/permission-check-page.test.cjs`。
- 未修改：云函数、数据库规则、业务页面（项目/施工/记录等）、`valid-concurrent-approval-proof.js`（仍禁用空凭据）、`valid-binding-proof.js`、`valid-approval-proof.js`、历史证据、手机缓存/防重标记/报告。
- 未执行：云端写入、部署、发布、预览、取号、批准。
- 自测结果：
  - `node --test miniapp/tests/*.test.cjs`：**126 项（125 通过、1 跳过、0 失败）**。跳过的仍是需外部 `wx-server-sdk` 路径的真实 SDK 回归测试。
  - JS/JSON 语法：24 个 JS、8 个 JSON 全部通过。
  - WXML/WXSS 编译：7 个 WXML、8 个 WXSS 全部通过。
  - `git diff --check` 无空白问题。

## Codex 返修复查结论

独立133项测试通过、0失败、0跳过，编译7 WXML／8 WXSS通过。受限内容完整隐藏、点击时重新检查、恢复时不重建探针或清除报告和尝试标记均已核实。新增7项测试结合既有回归与源码检查足以关闭本轮意见。未实际操作手机或云端，未推进下一业务单元。
