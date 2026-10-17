# CodeBuddy 实现说明：I1 请求分层兼容（participant-identity-request/1）

日期：2026-10-17。执行者：CodeBuddy。基线：设计 `2aa1780`、底层受审实现 `f0b7fa9`、接手 `347261a`。依据 [任务书](CodeBuddy任务-I1请求分层兼容本地实现-20261017.md)、[设计方案](Codex方案-I1请求分层兼容设计-20261016.md) §3–§6、[授权记录](证据/CodexI1请求分层本地实施授权-20261017.json)。**仅本地实现与自测；未部署、未调用、未查询云端。**

## 1. 实现摘要

1. **请求适配器** `miniapp/scripts/templates/participant-identity-check/server/request-adapter.js`（逐字节复制入 `server/scheduleSandbox/request-adapter.js`，入口同目录 require）：
   - 外层：`Reflect.ownKeys` 覆盖 Symbol 与非枚举；Symbol 一律拒绝；冲突名单（旧格式 5 项/自报身份与目标 12 项/原型歧义 3 项）仅比较自有键名，非枚举同名也拒绝；其余附带键不读值/getter、不输出键名或值、不传播。
   - `picRequest` 必须为自有、可枚举数据属性（descriptor 判定，禁止继承取得与访问器）。
   - 内层：仅 `schema` + 原四字段；非枚举/访问器/Symbol/额外键/类型错误拒绝；schema 精确等于 `participant-identity-request/1`；只读 `descriptor.value`；逐项构造新四字段对象（schema 不进核心）。
   - 原型判定（R1 返修后为**严格判定**，见 §5）：null 原型、本仓库 Object.prototype，或经验证的跨仓库真实 Object.prototype 根。
   - 全部元操作抛错净化为 `{ok:false}`，不外露原始异常；无旧格式回退。
2. **服务端入口**：顺序 = 配置门槛 → 适配（`cloud.database()` 之前）→ 数据库工厂 → 未改核心 `handle(extracted.request)`。适配失败返回既有结果 schema（`participant-identity-check-result/2`）+ `PIC_REQUEST_INVALID`/UNKNOWN/readAttempted=false/userId=null，轮次仅来自受审配置，不附 serverTime/keyDiagnostic。可信上下文仍取自 getWXContext/TCB_ENV，配置门槛前获取（原位保留）。
3. **客户端/协议配置**：请求改为固定 `picRequest` 内层；`schema` 取自生成配置新增的 `requestProtocol` 绑定；`includeFullUserId` 仅 true 时携带。页面主体未改（口令清除/勾选时点/单击单发行为由既有测试保持）。
4. **打包器 v2**：`participant-identity-plan/2` + `participant-identity-check-candidate/2`，必填 `requestProtocol`；`keyDiagnostic` 仅 false/缺省（true 写前拒绝）；适配器加入受审模板与 `PINNED_SOURCES`；布局校验新增入口适配器引用/调用、适配器制品在位、配置协议绑定、客户端 picRequest 断言。候选文件 14→**15**（写入 38→**39**）；关闭包仍 23 文件/8 服务端源文件，字节、映射、独立校验不变。
5. **核心字节不变**：`participant-identity-check.cjs` 未改（R1 返修前后 SHA-256 同为 `cd4de681…d92e7`）。

## 2. 与设计文档的落地差异说明

- §3.1.1「普通对象或 null 原型」的跨 vm 场景：**初版曾以原型链深度 ≤1 放宽，Codex 复查否决（R1）**；返修后为 §5 的严格判定，跨 vm 兼容仅限「真实普通对象」。
- §3.1.3「不记录键名/值」落实为拒绝/容忍路径均不构造任何含外层键名的输出；适配失败结果为固定对象，无动态字段。
- 候选数量按方案 §5.5 真实统计为 15（非照抄 38/39 旧数）；关闭包数量与映射经 N 组测试复核不变。

## 3. 验证与披露

- 核验包相关完整测试（R1 返修后 **35/35**）；business-test-package **18/18**；member-access-sdk **1/1**（既有本地 SDK）。
- [返修证据](证据/CodeBuddyI1分层返修R1R2证据-20261017.cjs/.json)：R2 两份历史脚本按 347261a 字节恢复的逐字节比对、R1 严格原型外/内层自定义 null-root 反例（单元+生成链，PIC_REQUEST_INVALID/UNKNOWN/readAttempted=false 且零工厂/零集合/零 get，继承 getter 实测 0 读取）、正向对照 3 路（普通/null 原型/跨 vm plain + 容忍链 getter 实测 0）、完整入口 no-flag 敏感性（原入口 ABSENT vs 无 flag 变体 UNKNOWN/PIC_READ_FAILED，实际主键/三字段投影/传输次数断言）、v2 绑定 3 反例；探针 2/业务期意外 0/总 2 决定 ok/exit。
- [收尾证据 v2](证据/CodeBuddy受控诊断R1R4收尾v2-20261017.cjs/.json) 与 [审计 v7](证据/CodeBuddyI1入站审计v7-20261017.cjs/.json)：由 20261016 旧脚本迁移的**新命名脚本**（旧脚本已按 347261a 字节恢复，不对当前树运行）；审计 v7 ok=true、17 检查、PINNED 14/14、漂移 0、意外 0。
- **披露**：三路/no-flag 测试中 getWXContext 为合成、传输层（`Db.reqClass`）为本地替身——序列化/投影/包装为真实 SDK 3.0.1 + database 1.4.1 代码；这不是平台验证。真实平台是否保留 picRequest 内层仍未知。

## 4. 未验证项

- 真实平台对 picRequest 内层的保留行为、外层附带键的实际形状——待 Codex 复查后另建受控取证窗口并经用户确认。
- 一次性口令/全局限流/平台零日志零费用不因本实现成立。

## 5. R1/R2 复查返修记录（2026-10-17，依据 [复查](Codex复查-I1请求分层兼容实现-20261017.md) §3–§4；另见 [R1/R2 返修复查](Codex复查-I1分层R1R2返修-20261017.md)）

- **R1 原型判定严格化**：初版「原型链深度 ≤1」被否决（任意 null-root 自定义原型可被误判为普通对象）。返修后 `isPlainRecord` 仅接受：null 原型、本仓库 Object.prototype、或 `hasCanonicalObjectPrototypeShape` 验证通过的跨仓库真实根——根的根为 null，且自带与规范 Object.prototype 逐项对应的**非枚举自有数据属性**（hasOwnProperty/isPrototypeOf/propertyIsEnumerable/toLocaleString/toString/valueOf + constructor，均非枚举、方法可写可配置）。不比较 constructor 名称，不做任意深度检查，不读取任何属性值。新增外/内层自定义 null-root（含 role 值与访问器）单元与生成链反例：PIC_REQUEST_INVALID/UNKNOWN/readAttempted=false，工厂/集合/get 实际计数均为 0，继承 getter 实测 0 读取；普通/null 原型/跨 vm plain 正向保留。核心字节未改；PINNED（适配器/入口）与审计外置打包器摘要同步。
- **R2 历史脚本恢复**：`CodeBuddyI1入站事件封装离线核实-20261016.cjs` 与 `CodeBuddy受控诊断R1R4收尾-20261016.cjs` 已按 347261a blob **精确字节恢复**（逐字节比对通过；不 reset、不改写提交历史）。本轮的审计/守卫迁移逻辑改用新命名脚本：[审计 v7](CodeBuddyI1入站审计v7-20261017.cjs) 与 [收尾 v2](CodeBuddy受控诊断R1R4收尾v2-20261017.cjs)；测试 D6/D7 引用已更新并注明旧脚本保留口径。历史 JSON 与 Codex 反例均未改。
- **§4 归并**：完整入口 no-flag 敏感性固化为 A5 测试与返修证据（实际主键/三字段投影/传输次数断言）；证据 getter 改为实测计数（容忍链 0、自定义原型继承 0）；manifest notes 与入口注释的诊断口径更正为「本协议版本固定 false、历史语义仅存于核心与审计记录」（模板字节变动已同步 PINNED）；测试头部「SDK 本地转换未执行」更正为「历史转换验证不重跑；A3/A5 直接使用本地真实 SDK 代码（仅传输与 getWXContext 合成）」；A4 短窗口测试改为**可控合成时钟**（宿主 Date.now 在调用期间替换、finally 还原）：expires==now → PIC_WINDOW_EXPIRED（工厂 1/读取 0），时钟回窗口内 → ACTIVE 对照。

## 6. R1 原型真实性终局返修（2026-10-17，依据 [R1/R2 返修复查](Codex复查-I1分层R1R2返修-20261017.md) §3–§4）

初版返修的「规范属性形状」校验被复查否决：可复制的属性形状不证明真实 Object.prototype（自造方法/复制描述符/伪造自关联三类六例均被旧判定接受）。终局判定与复查参考谓词 `referencePlainRecord` 一致：跨领域候选根除「根的根为 null」外，还须**联合验证**——根自有 `constructor` 数据属性（非枚举函数，拒绝访问器）→ 受信 `Function.prototype.toString` 与受信 Object 构造器原生表示一致（不只看 constructor.name）→ 该构造器自有 `prototype` 数据属性的值精确等于候选根且 writable=false/configurable=false（真实构造器与根的不可改对应关系）。不调用构造器/方法、不读取输入 getter、元操作抛错净化。

验证（[R1 终局证据](证据/CodeBuddyI1分层R1原型终局证据-20261017.cjs/.json) + 测试 A1/D2）：三类伪造 × 外/内层共六例单元+生成链交叉断言——均 PIC_REQUEST_INVALID/UNKNOWN/readAttempted=false 且工厂/集合/get 实际计数 0；伪造方法与继承 getter 实测零调用/零读取；普通/null 原型/跨 VM plain 三正向保留且与参考谓词一致。核心字节未改；PINNED（adapter `06e641fe…a5dc`）与新命名审计 v8 摘要同步。实测：核验包 **35/35**、业务包 18/18、member-access-sdk 1/1；审计 v8 ok=true、PINNED 14/14、漂移 0、意外 0。
