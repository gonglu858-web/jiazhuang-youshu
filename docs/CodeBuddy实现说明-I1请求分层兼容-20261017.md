# CodeBuddy 实现说明：I1 请求分层兼容（participant-identity-request/1）

日期：2026-10-17。执行者：CodeBuddy。基线：设计 `2aa1780`、底层受审实现 `f0b7fa9`、接手 `347261a`。依据 [任务书](CodeBuddy任务-I1请求分层兼容本地实现-20261017.md)、[设计方案](Codex方案-I1请求分层兼容设计-20261016.md) §3–§6、[授权记录](证据/CodexI1请求分层本地实施授权-20261017.json)。**仅本地实现与自测；未部署、未调用、未查询云端。**

## 1. 实现摘要

1. **新增请求适配器** `miniapp/scripts/templates/participant-identity-check/server/request-adapter.js`（逐字节复制入 `server/scheduleSandbox/request-adapter.js`，入口同目录 require）：
   - 外层：`Reflect.ownKeys` 覆盖 Symbol 与非枚举；Symbol 一律拒绝；冲突名单（旧格式 5 项/自报身份与目标 12 项/原型歧义 3 项）仅比较自有键名，非枚举同名也拒绝；其余附带键不读值/getter、不输出键名或值、不传播。
   - `picRequest` 必须为自有、可枚举数据属性（descriptor 判定，禁止继承/访问器）。
   - 内层：仅 `schema` + 原四字段；非枚举/访问器/Symbol/额外键/类型错误拒绝；schema 精确等于 `participant-identity-request/1`；只读 `descriptor.value`；逐项构造新四字段对象（schema 不进核心）。
   - 原型判定：普通对象或 null 原型，**原型链深度 ≤1**——兼容跨 vm 仓库 plain 对象、拒绝自定义原型/数组/标量（设计 §3.1.1 的跨 vm 说明落地方式，已在测试中以跨仓库对象验证）。
   - 全部元操作抛错净化为 `{ok:false}`，不外露原始异常；无旧格式回退。
2. **服务端入口**：顺序 = 配置门槛 → 适配（`cloud.database()` 之前）→ 数据库工厂 → 未改核心 `handle(extracted.request)`。适配失败返回既有结果 schema（`participant-identity-check-result/2`）+ `PIC_REQUEST_INVALID`/UNKNOWN/readAttempted=false/userId=null，轮次仅来自受审配置，不附 serverTime/keyDiagnostic。可信上下文仍取自 getWXContext/TCB_ENV，配置门槛前获取（原位保留）。
3. **客户端/协议配置**：请求改为固定 `picRequest` 内层；`schema` 取自生成配置新增的 `requestProtocol` 绑定；`includeFullUserId` 仅 true 时携带。页面主体未改（口令清除/勾选时点/单击单发行为由既有测试保持）。
4. **打包器 v2**：`participant-identity-plan/2` + `participant-identity-check-candidate/2`，必填 `requestProtocol`；`keyDiagnostic` 仅 false/缺省（true 写前拒绝）；适配器加入受审模板与 `PINNED_SOURCES`；布局校验新增入口适配器引用/调用、适配器制品在位、配置协议绑定、客户端 picRequest 断言。候选文件 14→**15**（写入 38→**39**）；关闭包仍 23 文件/8 服务端源文件，字节、映射、独立校验不变。
5. **核心字节不变**：`participant-identity-check.cjs` 未改（本轮前后 SHA-256 同为 `cd4de681…d92e7`）；其诊断能力保留但新协议包不启用（keyDiagnostic=false）。

## 2. 与设计文档的落地差异说明

- §3.1.1「普通对象或 null 原型」在跨 vm 场景以「原型链深度 ≤1」实现（任意仓库的 plain 对象接受，自定义原型/两层继承拒绝）；测试以另一 vm 仓库创建的 plain 对象验证。
- §3.1.3「不记录键名/值」落实为拒绝/容忍路径均不构造任何含外层键名的输出；适配失败结果为固定对象，无动态字段。
- 候选数量按方案 §5.5 真实统计为 15（非照抄 38/39 旧数）；关闭包数量与映射经 N 组测试复核不变。

## 3. 验证与披露

- 核验包相关完整测试 **34/34**（原 31 + D2 重写、D4 重写、A1/A3/A4 新增）；business-test-package **18/18**；member-access-sdk **1/1**（既有本地 SDK）。
- [本轮证据](证据/CodeBuddyI1请求分层兼容证据-20261017.cjs/.json)：适配器 24 类拒绝、生成链容忍（ACTIVE/工厂1/读取1/三字段投影/秘密与附带值不入结果）、8 类链上拒绝（零工厂/零读取/无诊断）、真实 SDK 三路（存在→ACTIVE、不存在→ABSENT、权限→UNKNOWN+readAttempted=true）与 throwOnNotFound 敏感性反例、v2 绑定 4 反例；探针 2/业务期意外 0/总 2 决定 ok/exit。
- **披露**：三路测试中 getWXContext 为合成、数据库工厂参数经真实 SDK、传输层（`Db.reqClass`）为本地替身——序列化/投影/包装为真实 SDK 3.0.1 + database 1.4.1 代码；这不是平台验证。真实平台是否保留 picRequest 内层仍未知。
- 审计 [v6](证据/CodeBuddyI1入站事件封装离线核实v6-20261017.json)：ok=true、17 检查、PINNED 14/14（新增适配器）、漂移 0、意外 0。

## 4. 未验证项

- 真实平台对 picRequest 内层的保留行为、外层附带键的实际形状——待 Codex 复查后另建受控取证窗口并经用户确认。
- 一次性口令/全局限流/平台零日志零费用不因本实现成立。
