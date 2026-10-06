# WorkBuddy 开发交接

## Git 本地工作快照（2026-10-06）

- 本轮整理 Git 入库范围、排除本机凭据/原始导出/临时目录，并保存当前工作快照；细节见 [Git本地存档说明](Git本地存档说明-20261006.md)。
- 快照包含待审代码，不等于验收通过；首次管理员 SDK 适配 R1–R5 返修仍待 Codex 复核。
- 仅本地存档，无远程推送、云端操作或部署；下一步确定私有远程仓库，再复核上传范围。


## R1–R5 返修完成，等 Codex 复核（2026-10-06）

依据 `docs/Codex复核-首次管理员SDK适配M1-M3-20261006.md`。**仅改本轮新增的适配层、其测试与说明**；P4 核心、CLI、旧业务、已关闭项一律未动。

### 本轮改动（3 个文件 + 1 组新证据）

| 文件 | 变化 |
|---|---|
| `miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs` | R1–R5 实现 |
| `miniapp/tests/sandbox-primary-sdk-adapter.test.cjs` | 30 → 50 项 |
| `docs/首次管理员SDK适配说明-20261006.md` | 第 3/5/6 节改写 + 新增 7.1 |
| `docs/证据/WorkBuddyR1R5复现-20261006.cjs` / `.json` | **新增**（13 样本对照复现） |

**Codex 原证据原样保留未改写**：`证据/Codex管理员SDK适配M1M3复现-20261006.cjs/.json`、`证据/Codex首次初始化SDK离线形状核对-20261006.cjs`、`证据/Codex首次初始化只读准备-20261006.json`。

### 未改（哈希可核对）
P4 核心 `133c21ae4b1081a1…`｜CLI `608aa8854a4213fc…`（`--execute` 仍拒绝）｜driver `940a89c2bdc3a9fb…`｜driver 测试 `e55dcf682cea2166…`｜打包器 `3e1274c70cf5bbbb…`｜单一入口 `b882b0c13b38d555…`｜服务端八文件与 vendor 零差异。

### 关键实现要点（复核重点）

- **R1** `normalizeDoc(result, {mode, expectedKey})`：事务成功空**仅** `data:null`、非事务**仅** `data:[]`；缺 `data`/`undefined`/未核实结构拒绝；非空记录必须 `_id` 匹配 `expectedKey`。
- **R2** `assertSetSuccess(result, expectedKey)`：只认 `updated`/`upserted`；计数须 `Number.isFinite && Number.isInteger && >=0 && <=1`；`updated===0` 时 `upserted` 必须含目标主键；`updatedCount` 出现即拒；只有 `upsert_id` 而无 `upserted` 即拒。
- **R3** `verifyCaller`：**先**核对 `envId`/`appId`/`trusted`，**再**输出白名单 `{allowed, envId}`。
- **R4** `REGISTRY = new WeakMap()`（实例私有）；返回 `Object.freeze({})` 空壳；`lookupOwn` 先核对归属再谈状态；`beginTransaction` 不再改写宿主 SDK 事务对象。
- **R5** `ALLOWED_ERROR_NAMES` 白名单；`sanitizeFailure` 返回固定码 + 固定文案 + 白名单化的 `name`，**不使用**传入异常的 `message`/`code`。

### 实跑

```
cd miniapp && node --test tests/sandbox-primary-sdk-adapter.test.cjs  → 50/50（网络尝试 0）
cd miniapp && node --test tests/sandbox-primary-bootstrap.test.cjs    → 45 项 40 通过 / 0 失败 / 5 跳过（CLI 子进程，历史遗留）
SANDBOX_SDK_ROOT=<不存在路径> node --test …sdk-adapter…             → 43 通过 / 0 失败 / 7 跳过
node docs/证据/WorkBuddyR1R5复现-20261006.cjs                       → 13 样本：unsafeInits=0 markerLeaks=0 foreignRollbackInvoked=0
```
按任务要求**未重跑未变化的旧业务全量测试**。

### 实测到的真实包约束（Codex 报告未列出，踩过坑）

合成传输返回的文档**必须是 EJSON 序列化后的字符串**：SDK `get` 对每项调用 `bson.EJSON.parse`（内部 `JSON.parse`，要求字符串）。直接返回普通对象会在 SDK 内部抛 `SyntaxError: "[object Object]" is not valid JSON`，容易被误判为适配层缺陷。测试用 SDK 自带 `EJSON.serialize(doc,{relaxed:false})` 再 `JSON.stringify`。

### 过程中被测试逼出的夹具问题（非实现缺陷）
- 合成 db 的 `pick` 必须**精确键优先于 `*`**，否则具体注入被通配遮蔽。
- R2-b 的零更新回执要按**两条写入各自的主键**给出 `upserted`，不能只给 `primary`。
- R2-a 的正确判据是**零 commit + 已回滚**；写入请求可能已发出一次（回执在传输后才可判定），断言「零 set」不成立。

### 未验证项
生产调用者核验未接通；真实平台缺记录返回与 `upserted` 实际形态未在平台核实；平台事务原子性/并发/回滚未验证；签名与 IAM 未核实；净化错误码是本层定义非平台清单；node-sdk 维护风险未裁决；资源安全规则未回读；费用余量未核实。

---

## 当前任务：首次管理员SDK适配 R1–R5 修正（2026-10-06）

Codex已复跑相关75项全通过，但独立反例发现读取形状/主键、set回执、调用者字段、unknown回滚归属、异常净化五类缺口。按 [复核报告](Codex复核-首次管理员SDK适配M1-M3-20261006.md) R1–R5和第7节完成最小修改；末尾有可复制提示词，证据11条已另存。

仅改新增适配层、其测试和说明，同步记录；P4核心/CLI/driver/云函数/vendor/打包器/旧配置与历史证据不动。不新增架构，不运行停用脚本，不安装/联网/初始化/部署，不处理A/B/C。配置继续关闭，完成后交Codex复核。

## M1–M3 已完成：SDK 薄适配层本地实现，等 Codex 复核（2026-10-06）

任务：`docs/WorkBuddy任务-首次管理员初始化最小接入准备-20261006.md` 第 4 节。**本地最小接入准备，真实初始化未放行。**

### 新增 3 个文件（仅此三个）

| 文件 | 字节 | sha256 |
|---|---|---|
| `miniapp/scripts/lib/sandbox-primary-sdk-adapter.cjs` | 21933 | `83519dde4c0f9d78c8b932f1f7416b2a05320cf24ce5a356b96fab5bf70fc438` |
| `miniapp/tests/sandbox-primary-sdk-adapter.test.cjs` | 37292 | `0fb0d8b918c524983dc993d3da82328a7623d47274b749d1e2028d69e37622d7` |
| `docs/首次管理员SDK适配说明-20261006.md` | 13505 | `ebc3e50999c8d618376fb99b3d2df3a688bc7b4516098fe6a7447a83dade191e` |

### 复用已存在的包（未安装、未升级、未复制 node_modules）

`C:/Users/30591/.codex/tmp/memberAccess-readonly-sdk-20260925/node_modules`
`@cloudbase/node-sdk` 2.10.0（`5987ce76…`）、`@cloudbase/database` 1.4.1（`52919989…`）、`wx-server-sdk` 3.0.1（`c014d07f…`，**未用它伪造微信上下文**）。
实际事务入口 `dist/commonjs/transaction/index.js`（`0c3cd858…`）。该目录内**没有** `@cloudbase/manager-node` / `@cloudbase/js-sdk`（不等于整台机器没有）。
SDK 路径**只在测试宿主指定**（`SANDBOX_SDK_ROOT`），**不是 CLI 参数**。

### 未改（哈希可核对）

P4 核心 `miniapp/scripts/lib/sandbox-primary-bootstrap.cjs` = `133c21ae4b1081a1…`
CLI `miniapp/scripts/prepare-sandbox-primary.cjs` = `608aa8854a4213fc…`（**`--execute` 仍拒绝**，实测退出码 1）
driver `940a89c2bdc3a9fb…`、driver 测试 `e55dcf682cea2166…`、打包器 `3e1274c70cf5bbbb…`、单一入口 `b882b0c13b38d555…`、
Codex 证据与历轮历史证据全部原样；服务端八文件与 vendor 零差异。

### 实跑

```
cd miniapp && node --test tests/sandbox-primary-sdk-adapter.test.cjs   → 30/30（网络尝试 0）
cd miniapp && node --test tests/sandbox-primary-bootstrap.test.cjs     → 45 项 40 通过 / 0 失败 / 5 跳过（CLI 子进程类，历史遗留）
SANDBOX_SDK_ROOT=<不存在路径> node --test …sandbox-primary-sdk-adapter… → 25 通过 / 0 失败 / 5 跳过（标「该层未验证」）
node miniapp/scripts/prepare-sandbox-primary.cjs --plan <合法计划> --execute → 退出码 1，拒绝文案不变
```

### 实现过程中自查修掉的 3 个缺陷（值得复核）

1. `readOnlyGet` 起初未排除 `users`（与「只读观察仅 primary 与本计划审计」不符）→ 新增 `READ_ONLY_SCOPE`。
2. commit 失败后句柄被标 finished，**核心的合法回滚被拒**、误报 `ROLLBACK_FAILED` → 改为 `commitUnknown`：禁止读写与再提交，**允许回滚**。
3. `sanitizeFailure` 与 `AdapterError` 叠加产生双前缀消息 → 统一由 `AdapterError` 加前缀。

### 实测得到的一条真实包约束（Codex 报告未列出）

`Db.reqClass` 的替换**必须在 `sdk.init(...).database()` 之后**；反序会让 `startTransaction` 走真实传输并被网络拦截拦下（`OFFLINE_ONLY`）。测试脚手架已固定正确顺序。

### 未验证项（不得当作通过）

生产调用者核验未接通；**真实平台缺记录返回未实测**；**平台事务原子性/并发冲突/回滚语义未验证**；真实请求签名与 IAM 未核实；底层真实传输的重试与超时未查；净化错误码是本层定义而非平台清单；node-sdk 停止维护的生产选型风险未裁决；独立副本资源与安全规则未回读；费用余量未核实。

### 下一阶段

真实初始化仍须具体云端执行包（含受控凭据来源与可信操作者核验、副本资源与安全规则、本人完整 userId 的受审名单、批准隔离范围内的真实 SDK 行为核实、费用余量与完整执行计划）。**不接受独立「读 → 写 → 回读」作为原子替代。**

---

## 下一任务：首次管理员初始化 SDK 薄适配层（2026-10-06）

按 [首次管理员初始化最小接入准备](WorkBuddy任务-首次管理员初始化最小接入准备-20261006.md) 第4节 M1–M3：只新增本地适配层、相称离线测试、说明并同步记录。已找到部署包 node-sdk 2.10.0，Codex真实包+合成传输8项通过，未安装或连接真实 SDK 网络。任务末尾有可复制提示词。

P4核心与CLI保持原样，--execute仍拒绝；无真实凭据提供者/受审生产名单，不伪造授权。三配置关闭，不改旧业务、云函数、副本vendor、打包器或历史证据，不重开已关闭返修，不运行停用shell。无安装、云端写入、初始化、建资源、部署、启用或A/B/C操作。费用余量仍由Codex后续核实；完成本地交付后停止并交复核。

## Codex 文档收尾复核通过，WorkBuddy 待命（2026-10-06）

八项交付逐项通过（历史命令执行按自述范围记录），本轮关闭，无需继续返修。四份文档交付哈希、shell 原逻辑哈希、两份旧产物哈希失配、关键未改文件、副本八文件及关闭配置均已只读核对。未运行停用 shell、重跑入口、测试或打包器。

沿用已验收的停用与证据边界，不修旧哈希、不重开业务项、不开发替代脚本。下一步由 Codex 做真实管理 SDK 与费用/额度的只读准备核验，再下发明确任务；WorkBuddy 暂不改代码或操作云端，用户无需扫码或手机操作。此通过不代表 SDK、平台事务、真机、初始化或部署已通过。

## Codex 已验收核心：业务代码收尾关闭，shell路径停用（2026-10-06）

最新依据：[S3-b与E1核心验收](Codex验收-独立副本S3b与E1核心-20261006.md)。S3-b关闭；E1采用唯一运行编号、独立汇总的包装调用方式已实跑34/18各一次通过。其他已关闭项不重开。

`WorkBuddyShell核对-20261006.sh` 不通过并停用：复用runId覆盖两份入口产物，哈希失配已记录。保留旧文件，不运行、不再开发替代shell体系、不修订旧哈希。仅按报告第6节收窄文档表述，随后待命，不改产品代码、不重复测试未变代码。

### 本轮文档收尾已完成（WorkBuddy，2026-10-06）

本轮**只做文档**：未改业务代码、未重跑未变代码的测试、未运行已停用的 shell 脚本。

| 事项 | 处置 |
|---|---|
| `docs/证据/WorkBuddyShell核对-20261006.sh` | **已标停用**（文件头加说明），**文件保留**；不删除、不运行、不完善 |
| `docs/证据/WorkBuddyShell核对-20261006-102641-11436.json` | **保留原样**，作为当时运行记录，不代表原始字节证据 |
| `docs/证据重跑/shell辅助停用与哈希失配-20261006.md` | **新增**：停用原因、哈希失配实测、入口有效使用边界、7 项覆盖范围更正 |
| `docs/证据/WorkBuddy单一重跑入口-20261006.json` 及两份重跑产物 | **未修改**，旧哈希原样保留 |

**哈希失配（如实保留）**：入口报告 `producedSha256` 与当前文件两份均不匹配——34 条 `98f43d0f…` vs `f04dc41c…`、18 条 `70aadbe9…` vs `55cf5deb…`。**不修改旧哈希以匹配被覆盖后的内容**；入口报告只能作为当时的运行记录。

**单一入口的有效使用方式（唯一）**：调用导出的 `orchestrate`，用 `codex-final-时间戳-UUID` 形式的新运行编号，汇总写**独立文件**。**不得复用既有 runId**；**不直接执行会写固定同名汇总的 `main`**（`main` 写固定同名汇总、`runId` 用秒+pid、`runOnce` 会删除同编号旧结果）。Codex 另存的新证据支持核心关闭（`证据/Codex驱动S3bE1最终复核-20261006.cjs/.json` 等三份）。

**已作废的自述表述**：上一轮「E1 控制流故障注入 7/7」**表述过强** —— `e1-partial-not-sealed` 未真正调用 `orchestrate`，`e1-orchestration-patch-guarded` 未注入缺失/不唯一源；两项覆盖有限，不为此重开业务返修。本地 667 项全量与三次重跑为 WorkBuddy 自述，验收以 Codex 本次证据为准。

Codex下一阶段负责真实管理SDK与费用/额度只读核验，形成具体接入任务前不安装、初始化、建资源或部署。三配置保持关闭，用户无需手机操作。

以下是此前交付记录，以本段及新验收报告为准。

## Codex 接续：S3-b / E1 已收尾，等复核（2026-10-06）

**改了什么（2 个实现/测试文件 + 3 个新证据文件，其余只读）**
- `miniapp/miniprogram/utils/sandbox-test-driver.js` — S3-b 两项：读失败放弃补存、槽位编号 `slotIndex`。
- `miniapp/tests/sandbox-test-driver.test.cjs` — 94 → 98 项（新增 4 条 S3-b2）。
- 新增 `docs/证据/WorkBuddy单一重跑入口-20261006.cjs`（E1）+ `.json`、`docs/证据/WorkBuddyS3bE1复现-20261006.cjs`/`.json`、`docs/证据/WorkBuddyShell核对-20261006.sh`。

**未改（哈希与上一轮一致，可直接核对）**
P4 写核心 `133c21ae4b1081a1…`；打包器 `3e1274c70cf5bbbb…`；候选清单 `7a0284d5098375f6…`；两份原制品 manifest `2692351f26e10e9b…` / `8821a459b2f32be1…`；协调器 `9f17ae44713d58d4…`；客户端 `fde6107ef00c49b9…`；页面 `fbb70b3cb2a9898f…`；服务端八文件与 vendor 零差异。Codex 六份证据与前轮 34 条证据全部未改。

**历史证据修订说明（务必知悉）**
上一轮改过 `docs/证据/WorkBuddy返修S1S5复现-20261006.cjs`（36977 B/`d26906f6…` → 41117 B/`09f23d61…`），故「历轮全部历史证据未改」不成立。本轮起历史证据只读。不凭记忆伪造旧哈希，也不声称可逐字节还原。

**E1 入口的用法与边界**
```
node docs/证据/WorkBuddy单一重跑入口-20261006.cjs          # 编排 34/18 各一次；失败不重跑
bash docs/证据/WorkBuddyShell核对-20261006.sh <runId>     # 宿主 spawn 受限时由 shell 另行核对
```
`sealed=true` 要求两份**都**本次实际完成且 summary 符合期望。宿主 spawn 故障时入口记 `sealed=false` 并保留错误码；shell 核对结果写入独立文件，不回填入口结论。

**环境限制（如实）**：本机 node 内 `spawnSync` 持续 `EBUSY`（含 spawn 任意可执行文件）。因此入口自动执行受阻；34 条中唯一未达期望的 `R5-cli-execute-still-refused` 已由脚本自行标 `hostSpawnBlocked: true`，CLI 拒绝行为另由 shell 直接核对正确（`--execute` 非零退出并输出「不得用独立的读 → 写 → 回读冒充原子性」；`--approval` 被拒）。

**剩余缺口（不变）**：V06 三对与 V07 两例仍需真实云端执行 + 管理端逐例事后核对；P4 需 Codex 核实真实管理 SDK 后单独下发接入任务；平台索引就绪、3 秒超时、100 操作、32 KiB、费用未实测。

**边界**：未安装、未联网、未调用云端、未接真实 SDK、未建资源、未取号、未预览/部署/启用、未清缓存、未处理 A/B/C；三配置保持关闭、动态值为空、递归冻结。

---

## Codex 最新接续：S3-a 关闭，只修 S3-b / E1（2026-10-06）

阅读 [S3ab/E1 复核](Codex复核-独立副本S3ab-E1收尾-20261006.md)，第6节为可复制任务；反例 `证据/Codex驱动S3abE1复核-20261006.cjs/.json`。34/18/8条均通过，保留成果。

剩余限定：晚到补存读失败不得回写状态、同号双超时证据保留槽位；新建单一重跑入口取消自动回退与嵌套重复，完整结论不得由部分成功产生。已改过的旧证据脚本如实记录，后续不再改旧文件。产品修改仅driver及对应测试，其他已关闭项不重做。

三配置继续关闭，用户无需手机操作。不安装、不接真实SDK、不调用云端、不建资源、不部署/启用、不清缓存、不处理A/B/C。

以下保留此前交付与接续记录，以本段及最新报告为准。

## S3-a / S3-b / E1 已交付，待 Codex 复核（2026-10-06）

先读 [Codex 本轮复核报告](Codex复核-独立副本S1-S5收尾-20261006.md)、Codex 复核证据（`证据/Codex驱动S1S5复核-20261006.cjs/.json`，**原样保留**）与本轮证据（`证据/WorkBuddy安全重跑与S3ab复现-20261006.cjs/.json`，S3-a/S3-b 8/8 封堵，E1 sealed，重跑 34+18 均实际执行）。

### 本轮改动（3 个文件）
- `miniapp/miniprogram/utils/sandbox-test-driver.js`（**唯一的产品改动**）：
  - S3-a：同步抛错槽位的收尾循环补上完成检查（`settleSlot` → `persistSlot` → `notify`），并加兜底 `notify()`；全同步抛错时不再挂起。
  - S3-b：新增 `recordLateArrival` —— 晚到成功/拒绝**只补存净化后的槽位证据**，不改判、不覆盖主槽位历史、不回写状态、不补发、不解锁。
  - `persistSlot(stateOverride)`：状态不再硬编码 `inFlight`，而是沿用当前已持久化状态（否则晚到补存会把 `stopped` 回写成 `inFlight`）。
- `miniapp/tests/sandbox-test-driver.test.cjs`（87 → **94 项**）：新增 S3-a 三项（**非 async** `callFunction` 真同步 throw）与 S3-b 五项（晚到成功/晚到拒绝/补存失败/同 requestId 槽位区分/不补发不解锁）。
- 证据脚本：`docs/证据/WorkBuddy返修S1S5复现-20261006.cjs`（改为安全重跑）、新增 `docs/证据/WorkBuddy安全重跑与S3ab复现-20261006.cjs`（独立安全重跑入口）。

### 未改（哈希与上一轮一致）
P4 写核心 `sandbox-primary-bootstrap.cjs` = `133c21ae4b1081a1…`；协调器、客户端、页面、打包器 `3e1274c7…`、候选清单 `7a0284d5…`、两份原制品 manifest、服务端八文件与 vendor；Codex 与历轮全部历史证据。

### 重跑约定（E1，后续接手请沿用）
- **不要** `require()` 自执行的证据脚本 —— 那会执行它并覆盖它的同名 JSON。
- 安全重跑 = 复制到**根下两层**的 `docs/证据重跑/`（旧脚本按 `__dirname/../..` 推导仓库根，放深了会算错）、校验 SHA-256 一致、只跑一次并 await、输出落新文件。
- 宿主 spawn 不可用时可**进程内执行隔离副本**（隔离保证只写新文件），但必须记录 `executionMode`；读不到新结果就标「未重跑」，**不得**回读旧 JSON 冒充。

### 仍未闭合（下一阶段参考，非本轮范围）
V06/V07 仍需真实云端执行 + 管理端逐例事后核对；真实管理 SDK 未核实，**primary 未在生产初始化**；真实 wcc/wcsc 编译未执行；**S3-b 的晚到时序只在本地合成响应下验证，真实网络晚到顺序未实测**；平台索引就绪、3 秒超时、100 操作、32 KiB、费用未实测。

---

## Codex 上一轮接续提示：只修 S3-a / S3-b / E1（2026-10-06）

阅读 [S1–S5 复核](Codex复核-独立副本S1-S5收尾-20261006.md) 与 `证据/Codex驱动S1S5复核-20261006.cjs/.json`。第 7 节已提供可复制任务。

S1/S2/S4/S5 已关闭；34 条旧样本与 18 条新样本均通过。剩余为：全部同步抛错不结束（含 V07 单次调用）、超时后晚到响应未补存、证据脚本自执行旧脚本导致重复运行/覆盖历史输出。限 driver、对应测试及新证据/记录，不重开 P4 写核心、已关闭 U/T、打包器或旧业务。

本机全量 656/652 pass/0 fail/4 skip（SDK + 三个 junction EPERM）；新旧入口和驱动保持关闭。先完成本地这三项，不接真实 SDK、不安装、不调用云端、不建资源、不部署/启用、不清缓存、不处理 A/B/C。用户无需扫码或手机操作。

以下为先前交付记录，当前结论以上述复核为准。

## S1–S5 已交付，待 Codex 复核（2026-10-06）

先读 [Codex 本轮复核报告](Codex复核-独立副本R1-R5返修-20261005.md)、Codex 原证据（`证据/Codex驱动R1R5剩余复现-20261005.cjs/.json`，**原样保留未改写**）与收尾证据（`证据/WorkBuddy返修S1S5复现-20261006.cjs/.json`，18/18 封堵；并含上一轮 34 条的重跑，34/34 无回退）。

### 本轮改动（4 个文件，均在报告允许范围内）
- `miniapp/miniprogram/utils/sandbox-test-coordinator.js`：新增 `BATCH_KIND`/`KNOWN_CASE_STATES`/`validateBatchDoc`/`validateLegacyBatchDoc`/`verifyOrdinaryOwner`；`readBatch` 不再用 `{}` 兜底；`ensureBatchDoc` 不再重置损坏 `cases`；`pendingBatchesForRound` 不再跳过 `:case:` 键；`setCaseState` 回读逐项核对拟写证据。
- `miniapp/miniprogram/utils/sandbox-test-driver.js`：gate 只认官方 `appId`/`envVersion`/`version`（`extraEnvId` 仅在额外提供时核对）；`sendFixed` 每次显式钉死固定 env/函数名并对偏离直接抛错；`sanitizeResult` 按 `PUBLIC_FIELD_TYPES` 逐字段校验（新增 `PUBLIC_FIELD_TYPES`/`matchesFieldType`）；新增 `verifyListedSchedule`；`readAllActiveSchedules` 严格化；`readCurrentSchedule` 要求 `ok:true` 与真实 `expectedDate`/`restDays`；`buildPair(update)` 采用当前 `expectedDate`；V06-c 增加日期不等即停；发送段改为逐笔立即监听与先到先留证。
- `miniapp/miniprogram/utils/schedule-sandbox-client.js`：`enterOrdinary` 的 `owner` 改为必须通过 `verifyOrdinaryOwner`，无效凭证按「未持有」处理并保留拒绝原因。
- `miniapp/scripts/lib/sandbox-primary-bootstrap.cjs`：`observePrimary` 的 `present` 增加资格状态与本计划关联核对（写核心未动）。
- 测试：`tests/sandbox-test-driver.test.cjs`（69 → 87 项）、`tests/sandbox-primary-bootstrap.test.cjs`（39 → 45 项）。夹具按真实契约修正：`makeApi` 去掉虚构 `envId`、`listSchedules`/`getSchedule` 补 `ok:true`、V06-c 夹具日期一致。

### 未改
服务端八文件副本、vendor、打包器 `3e1274c7…`、候选清单 `7a0284d5…`、两份原制品 manifest（`2692351f…` / `8821a459…`）、Codex 与历轮全部历史证据。

### 仍未闭合（下一阶段参考，非本轮范围）
V06/V07 仍需真实云端执行 + 管理端逐例事后核对；真实管理 SDK 未核实，**primary 未在生产初始化**；真实 wcc/wcsc 编译未执行；互斥只是同设备/运行时操作互斥；平台索引就绪、3 秒超时、100 操作、32 KiB、费用未实测；S1 的「平台按 `config.env` 实际路由」本地无法验证。

---

## Codex 上一轮接续提示：只做 S1–S5（2026-10-05）

阅读 [R1–R5 返修复核](Codex复核-独立副本R1-R5返修-20261005.md) 与 `证据/Codex驱动R1R5剩余复现-20261005.cjs/.json`。本轮 34 条原返修证据复跑通过，新增 10 条反例归并为 S1–S5；不是重启全部 R 项。

下一步按报告第 9 节可复制提示词：真实账号 API 形状、坏批次/内部 owner、响应独立留证与完整回读、当前 form/分页/响应验证、P4 只读一致性。R5 写核心保持通过。修改文件计数为实际 9 个，原记录保留并注明接续。

本机全量 631/627 通过/0 失败/4 跳过（SDK+3 个 junction EPERM）；三配置关闭、动态值空、冻结；既有副本/制品通过。原证据不改，返修新建证据。本轮不接真实 SDK、不触云端、不建资源、不预览/部署/启用、不清缓存、不处理 A/B/C，用户无需手机操作。

## R1–R5 返修已交付，待 Codex 复核（2026-10-05）

先读 [Codex 本轮复核报告](Codex复核-独立副本V06V07P4本地实现-20261005.md)、Codex 原证据（`证据/Codex最小驱动V06V07P4复核-20261005.cjs/.json`，**原样保留未改写**）与返修证据（`证据/WorkBuddy返修R1R5复现-20261005.cjs/.json`，34 条对照反例全部封堵）。报告第 9 节提供可复制提示词。

### 本轮改动（均在报告允许范围内）
- `miniapp/miniprogram/utils/sandbox-test-coordinator.js`：占用表带 owner + token；批次键改**轮次级**（不含执行人）；`blockingCases` / `pendingBatchesForRound` 失败关闭；`setCaseState` 回读重算摘要；新增 `upgradeRuntimeHoldReason`；`resolveStorage` 标注枚举不可用。
- `miniapp/miniprogram/utils/sandbox-test-driver.js`：gate 核对实际 AppID/环境；`verifyFixedTarget` / `verifyV07Target`；`verifyScheduleSuccess` / `verifyRemovedSuccess`；`readCurrentSchedule`（getSchedule）与 `readAllActiveSchedules`（listSchedules 完整分页）；`attemptSend` 逐笔处理；发送前重验 gate/窗口/冻结快照；`report.localOnly=false` + `source`。
- `miniapp/miniprogram/utils/schedule-sandbox-client.js`：新增 `enterOrdinary`，`callSandbox` / `resumePending` / `refreshSessionIdentity` 在首次 await 前取得并保持普通占用；`resumePendingHeld` 内部把同一 `internalOwner` 传给身份刷新（不自锁）；三个入口拆成 wrapper + `*Held` 主体。**未新增任何绕过开关**，envelope 与恢复规则未变。
- `miniapp/miniprogram/config/sandbox-test-driver-proof.js`：V06-a `compareFields` 由 `scheduleId` 改为公开契约字段 `id`。
- `miniapp/miniprogram/pages/schedule-sandbox/schedule-sandbox.js`：`runTestCase` 加 `try/catch/finally`；`readPriorV06aResult` 只接受 `reviewed` 且读 `result.id`；V07 目标去掉表单兜底。
- `miniapp/scripts/lib/sandbox-primary-bootstrap.cjs`：`FIXED_APP_ID/FIXED_ENV_ID` 常量自约束；`validateApprovalContext` / `assertApprovedTarget`（完整 userId）；`deriveUserId` / `verifyUserRecordIdentity`；`resolveNowMs`（默认当前时钟、拒绝非法注入、首写前再核验）；`observePrimary` 四态。
- `miniapp/scripts/prepare-sandbox-primary.cjs`：批准上下文只从计划文件读入；新增 `--approval` 拒绝；输出批准人与身份核对说明。

### 未改
服务端八文件副本、vendor、打包器 `3e1274c7…`、候选清单 `7a0284d5…`、两份原制品 manifest（`2692351f…` / `8821a459…`）、Codex 与上一轮全部历史证据。

### 仍未闭合（下一阶段参考，非本轮范围）
V06/V07 仍需真实云端执行 + 管理端逐例事后核对；真实管理 SDK 未核实，**primary 未初始化**；真实 wcc/wcsc 编译未执行；互斥只是同设备/运行时操作互斥；平台索引就绪、3 秒超时、100 操作、32 KiB、费用未实测。

---

## Codex 上一轮接续提示：V06/V07/P4 按 R1–R5 返修（2026-10-05）

先读 [Codex 本轮复核报告](Codex复核-独立副本V06V07P4本地实现-20261005.md) 与 `证据/Codex最小驱动V06V07P4复核-20261005.cjs/.json`。独立 15 条反例全部复现；不要用现有测试通过替代这些行为核验。报告第 9 节提供可复制开发提示词。

范围仅 R1–R5：互斥、目标门控、真实用例前提与形状、异常持久留证、P4 身份环境时效。下方交付原文保留作历史，不代表上述契约已通过；其中“新增 6 个”实为 7 个，“模拟 getSchedule”未实际调用该接口。原独立证据不改写，返修另建证据。

本机全量 578/574 通过/0 失败/4 跳过；3 个新增跳过来自 junction EPERM，勿混写为平台已验证。基线仅允许的 4 文件变化，既有副本与制品不变，全部入口关闭。无需手机操作；不接真实适配器，不安装、不触云端、不建资源、不部署、不启用、不清缓存、不处理 A/B/C。旧关闭项保持关闭。

## WorkBuddy 已交付 V06/V07/P4 本地实现，转 Codex 复核（2026-10-05）

按 [最小测试驱动与首次初始化任务](WorkBuddy任务-独立副本最小测试驱动与首次初始化-20261005.md) 完成本地开发。**本地实现 ≠ 云端执行授权**；未安装、未联网、未创建资源、未部署、未启用入口、未清缓存。

**新增 6 个文件**：`config/sandbox-test-driver-proof.js`（默认关闭/动态值空/嵌套冻结）、`utils/sandbox-test-coordinator.js`（同步占用+持久批次+状态机，无云调用）、`utils/sandbox-test-driver.js`（组包/门控/判定/脱敏报告）、`scripts/lib/sandbox-primary-bootstrap.cjs`（P4 原子核心）、`scripts/prepare-sandbox-primary.cjs`（仅本地检查 CLI）、两个测试文件（30 + 24 项）。

**最小修改 4 个文件**：`schedule-sandbox-client.js`（三入口首次 await 前加驱动占用拒绝，无绕过开关、envelope 与恢复规则未变）、`schedule-sandbox.js`/`.wxml`（专用卡片 + 五按钮 + 报告 + 人工接续，不加路由、不把 removeMember 进选择器）、`schedule-sandbox-frontend.test.cjs`（仅补 require 映射，旧断言未删未放宽，48/48）。

**实跑**：全量 578 项 577 通过 / 0 失败 / 1 跳过（跳过为历史遗留 SDK 路径项，未安装 SDK 凑通过）；新增 30/30 与 24/24；十个 JS `node --check` 通过；WXML 标签配平通过；CLI 本地检查与 `--execute` 拒绝路径实测通过。

**关键证据**：驱动占用时 `callSandbox`/`resumePending`/`refreshSessionIdentity` 均零请求且原 envelope 逐字节不变；源码无 `ignoreLock` 类开关。P4 模拟适配器下：空 primary 一次初始化（1 次 commit）、写失败与提交失败整体回滚快照不变、已有/孤立记录零写停止、两实例并发（逐键读集冲突检测）恰好 1 次提交与 1 笔授予、确定性审计 ID、`trusted` 默认拒绝、集合白名单越界拒绝、CLI `--execute` 明确拒绝零网络。

**110 基线**：110 中恰好 4 个变化，全为授权范围（客户端/页面/其前端测试）；服务端**八文件副本包与 vendor 零差异**；候选清单、两份原制品 manifest、已验收打包器哈希未变；旧业务与历史证据未改。

**未验证（如实）**：① 真机未验证（全用合成 wx 与内存存储；真实并发是否触发平台事务重入未实测）；② 真实管理 SDK 未核实，P4 只完成本地原子核心，**primary 未初始化**；③ 真实 WXML/WXSS 编译未执行；④ 互斥仅同设备/运行时，非跨设备锁；⑤ 平台索引就绪、3 秒超时、费用未实测。

**边界**：新旧入口与新驱动配置均确认关闭、动态值全空。不安装、不联网、不取号、不建资源、不预览/部署/发布、不清缓存、不处理 A/B/C。

**剩余缺口**：V06 三对需真实云端执行 + 管理端逐例核对；V07 需先备好前提（乙的安排与非幂等未知处理）；P4 需 Codex 核实 SDK 后单独下发接入任务；费用余量待补。

## 新本地开发任务：最小测试驱动与首次初始化（2026-10-05）

请接 [任务文档](WorkBuddy任务-独立副本最小测试驱动与首次初始化-20261005.md)，文末有可复制提示词。用户已要求整理方案交开发：V06 三组小程序固定并发、V07 两种前提各一次移出、P4 原子事务核心。普通客户端只接入双向互斥，不放开防重；P4 真实管理 SDK 未核实，CLI 执行入口本轮必须拒绝。只做本地实现/模拟自测，保持入口关闭，八文件包与已验收打包器不动；授权差异见任务第2节，旧110基线不改写。此为文件交接，未通过工具自动发送 WorkBuddy；实现状态仍待 WorkBuddy 交付。

## Codex 已验收：S1 最小收尾及本地制品准备返修关闭（2026-10-05）

见 [最终验收及可复制接续通知](Codex验收-本地制品S1缺文件最小收尾-20261005.md)。三个关键分支通过，夹具修正通过；本机 524/520/0/4，110 文件不变，入口关闭。WorkBuddy 暂停待命，不再修改打包器，不重开已验收业务。后续由 Codex 单独整理 V06/V07/P4 的最小驱动与原子初始化任务；当前无新实现、安装、云端写入或部署放行。关于“删除链接防线不抛错”的推断按验收第3节收准，不另派返修。历史记录保留如下。

## WorkBuddy 已交付 S1 缺文件预检回归最小收尾，转 Codex 复核（2026-10-05）

按 [Codex 复核](Codex复核-本地制品S1-S3收尾-20261005.md) 第 2 节只修 `facts.missing` 回归，并同批修正第 3 节测试夹具。**未改已验收业务源码**（110 文件基线 0 变化）；U3/U5 与 U1/U2/U4/T5 保持关闭；未实现驱动或初始化程序。

**修改 2 个文件**：`miniapp/scripts/package-sandbox.cjs`、`miniapp/tests/sandbox-package.test.cjs`（37 → **41 项**）。
**保持不变**：候选清单 JSON、两份原制品 manifest、全部历史证据、110 文件基线。S1a/S1b、S2/S3 与三处文案**未重做**。
**新增证据**：`docs/证据/本地制品S1缺文件回归修复复现-20261005.cjs` / `.json`（5 项，0 未达预期）。

**根因**：`safeReadPackageFile` 返回 `exists:false` 时直接 `continue`，`facts.missing` 永远为空 → 生成模式先补文件、随后才可能因 manifest 冲突失败。
**修法**：缺文件记入 `facts.missing`；有 manifest 时任何写入前拒绝；无 manifest 的合法半成品仍可续建。

**修前修后（实测）**：有 manifest 缺 index.js —— 修前生成返回 `mode:'created'` 并重建文件，修后 check 与生成都在预检拒绝、`index.js` 不存在、manifest 逐字节不变；叠加 manifest 冲突 —— 修前先建文件后报冲突，修后缺文件先报且零写；无 manifest 合法半成品 —— 修前后均 `mode=created`、gate.js `reused` 且字节不变、8 文件齐备、`--check` 通过。

**夹具修正**：S2.2 的 vendor 备份移出样本输出目录，断言只接受链接表述 `vendor（符号链接/目录联接）`，删除链接防线后该用例会失败；junction 无权限仍明确 skip。S2.3 标题收准确。

**实跑**：全量 524 项 523 通过 / 0 失败 / 1 跳过（历史遗留 SDK 路径项）；新测试 41/41；`build-sandbox --check` 与 `package-sandbox --check --out .../closed-20261005-r2fix` 通过；三个 JS `node --check` 与 `git diff --check` 通过；110 文件基线零变化；新旧入口实读关闭。

**过程如实记录**：编辑中曾引入 `const conflictProblems = [` 缺 `]` 的语法错误（`node --check` 报 788 行），定位修正后才跑测试；交付文件语法已通过。

**未验证**：真实文件符号链接在本机 EPERM 未验证；junction 本机可创建且已实测；关闭态为合成 SDK + 内存替身。

**边界**：未安装、未调用云端、未取号、未创建资源、未预览/部署/发布、未清缓存、未处理 A/B/C；不宣称满足部署条件。剩余缺口不变（V06 三对未验证、V07 无移出入口、P4 执行方法未就绪、费用待补）。

## Codex 接续：S2/S3 关闭，S1 缺文件预检仅一处回归待修（2026-10-05）

见 [本轮复核及可复制提示词](Codex复核-本地制品S1-S3收尾-20261005.md)。S1a/S1b 原反例及文案已通过；缺文件分支没有加入 facts.missing，使有 manifest 的样本在生成时先补文件、清单冲突后才失败。仅恢复有 manifest 的完整性预检，补零写与合法半成品正向测试；S2.2 的 vendor-real 额外文件干扰可同批移除。保持 110 文件、候选清单、历史证据与原包不变。Codex 实跑 520/516/0/4，三个 junction 因 EPERM 跳过；入口关闭，不安装、不云端操作、不实现驱动或初始化。原 WorkBuddy 交付与历史记录保留如下。

## WorkBuddy 已交付 S1–S3 定点收尾，转 Codex 复核（2026-10-05）

按 [Codex 复核](Codex复核-本地制品准备R1-R5收尾-20261005.md) 只修 S1–S3。**未改任何已验收业务源码**（110 文件基线 0 缺失 0 变化）；U3/U5 与 U1/U2/U4/T5 保持关闭；未实现驱动或初始化程序。

**修改 3 个文件**：`miniapp/scripts/package-sandbox.cjs`、`miniapp/tests/sandbox-package.test.cjs`（27 → **37 项**）、`docs/独立副本有限测试操作稿-20261005.md`（第 5 节三处文案）。
**保持不变**：候选清单 JSON、两份原制品目录（`closed-20261005`、`closed-20261005-r2fix`）、全部历史证据、110 文件基线。
**新增证据**：`docs/证据/本地制品S1S3收尾复现-20261005.cjs` / `.json` —— **15 项反例全部被拒，0 漏网**。

**修复要点**
- S1a：包体冲突判定不再依赖 manifest 存在，一律预检拒绝、零新文件（实测 index.js/manifest 均未创建，原 gate.js 保留）。
- S1b：manifest `sourceDir` / `packageDir` / 每条 `sourceKey` 与实际计算值精确比对，缺项也拒；不引入签名或自哈希。
- S2：新增 `safeReadPackageFile`，生成与检查**共用同一读点**（先 lstat 判链接、判普通文件，再读）；预检另扫「链接条目一律拒绝」，白名单文件是链接同样拒。原实现 check 模式 lstat 为 0 次的分支已封闭。
- S3：锁定 `wxServerSdk=3.0.1` 与 `packageJson` 来源，并与副本 package.json 实际版本交叉核对；11 个集合 `created` / `ttlEnabled` 必须显式 false。

**文案三处**：V06-b 删去「解除锁的唯一路径是标记」并区分真正并发与串行；execute 阶段 createProject 改为首先返回 `SANDBOX_ACTION_NOT_ALLOWED_IN_PHASE`（已实测）；`sandboxProjectId` 改为客户端 preflight + 服务端授权两层作用。

**实跑**：全量 520 项 519 通过 / 0 失败 / 1 跳过（历史遗留 SDK 路径项）；新测试 37/37；`build-sandbox --check` 与 `package-sandbox --check --out .../closed-20261005-r2fix` 通过；`node --check`、`git diff --check` 通过；110 文件基线零变化；新旧入口实读关闭。

**未验证（如实）**：真实文件符号链接在本机 EPERM 无法创建，该分支未验证，测试中明确标注并改用合成标记（只证明控制流）；junction 本机可创建且已实测，不泛化为其它环境性质；关闭态为合成 SDK + 内存替身。

**边界**：未安装、未调用云端、未取号、未创建资源、未预览/部署/发布、未清缓存、未处理 A/B/C；不宣称满足部署条件。剩余缺口不变（V06 三对未验证、V07 无移出入口、P4 执行方法未就绪、费用待补）。

## Codex 复核接续：仅 S1–S3 工具遗漏与三处随改文案（2026-10-05）

按 [R1–R5 复核报告](Codex复核-本地制品准备R1-R5收尾-20261005.md) 第2–4节收尾：无 manifest 冲突预检/来源记录，check 白名单链接，SDK/集合标记；第5节文案随改。R4/R5 主要问题通过，不重做；U3/U5 与 U1/U2/U4/T5 继续关闭。110 文件、正确候选 JSON 与原制品保持不变。不得将环境 EPERM 当校验器成功拒绝，不安装或部署；末尾有可复制提示词。

## WorkBuddy 已交付 R1–R5 定点收尾，转 Codex 复核（2026-10-05）

按 [复查报告](Codex复查-独立副本本地制品准备-20261005.md) 只修 R1–R5。**未改任何已验收业务源码**（110 文件基线 0 缺失 0 变化）；U3/U5 与 U1/U2/U4/T5 保持关闭；未实现新驱动或初始化程序。

**修改 3 个文件**：`miniapp/scripts/package-sandbox.cjs`（R1/R2/R3）、`miniapp/tests/sandbox-package.test.cjs`（R1–R5 反例回归 27 项）、`docs/独立副本有限测试操作稿-20261005.md`（R4/R5 + §5 差异表）。
**新增证据**：`docs/证据/本地制品准备R1R5修复复现-20261005.cjs` / `.json`（32 项，31 反例被拒、0 漏网）。Codex 原始复现文件**未改写**。
**新格式包**：`artifacts/schedule-sandbox/closed-20261005-r2fix/`（schema `/2`）；旧 `closed-20261005/`（schema `/1`）保留未改，新工具按 `/2` 校验会拒绝它——预期行为。

**实跑**：全量 510 项 509 通过 / 0 失败 / 1 跳过（跳过为历史遗留 SDK 路径项）；新测试 27/27；`build-sandbox --check` 与 `package-sandbox --check --out .../closed-20261005-r2fix` 均通过；`node --check` 与两个 JSON 通过；`git diff --check` 通过；110 文件基线零变化；新旧入口实读关闭。

**修复要点**：R1 基线强制停止且零产物、manifest 与实际源双向核对、预检覆盖整个制品目录且可预知失败零新文件；R2 受信根与**每一级祖先**校验，**Windows junction 三处实测拒绝**；R3 13 索引按有序字段序列严格匹配 + 规格必填 + 就绪标记显式为 false。测试放行开关不暴露给 CLI。

**未验证**：普通文件符号链接分支（本机退化为硬链接）；关闭态为合成 SDK + 内存替身；索引平台就绪、3 秒超时、并发、费用未实测。

**剩余缺口**：V06 三对均未验证（驱动载体未成立）；V07 页面无移出入口；P4 执行方法未就绪（原子写载体能力未核实）；费用/余量待 Codex 补齐。

**边界**：未安装、未调用云端、未取号、未创建资源、未预览/部署/发布、未清缓存、未处理 A/B/C；不宣称满足部署条件。

## Codex 复查接续：仅 R1–R5 定点收尾（2026-10-05）

按 [本地制品复查报告](Codex复查-独立副本本地制品准备-20261005.md) 收尾：R1 manifest/基线/生成预检，R2 根目录联接，R3 严格候选规格，R4/R5 仅操作稿事实及前置顺序。Codex 已用临时副本形成独立复现 JSON；原交付包正确但校验器未闭合。110 文件不动，U3/U5 与 U1/U2/U4/T5 保持关闭，不开发真实驱动或初始化载体，不操作云端。报告末尾有可复制提示词。

## WorkBuddy 已交付 L1–L3 本地制品，转 Codex 复查（2026-10-05）

按 [本地制品准备任务](WorkBuddy任务-独立副本本地制品准备-20261005.md) 完成，**未改任何已验收业务源码**，U3/U5 与 U1/U2/U4/T5 保持关闭。本节取代下方「待转交」的当前安排。

**交付物**
- L1：`miniapp/scripts/package-sandbox.cjs`（白名单关闭包工具，仅 Node 内置模块，无上传/部署/云端调用）+ 产物 `artifacts/schedule-sandbox/closed-20261005/`（manifest.json + package/ 8 文件，与源逐字节一致，与 110 文件基线哈希相同）。
- L2：`miniapp/cloudbase/schedule-sandbox-resources.candidate.json`（11 集合 / 13 索引，`executable:false`，区分本地资源计划与平台 API 请求）。
- L3：`docs/独立副本有限测试操作稿-20261005.md`（V06 三对、V07 移出、P4 primary 初始化 + 最小并发驱动草案）。
- 测试：`miniapp/tests/sandbox-package.test.cjs` 24/24 通过。

**实跑**：全量 507 项 506 通过 / 0 失败 / 1 跳过（跳过为历史遗留的「未指定 wx-server-sdk 路径」）；`build-sandbox.cjs --check` 通过（vendor 哈希未变）；`package-sandbox.cjs --check` 通过；`node --check` + 两个新 JSON 解析通过；`git diff --check` 通过；110 文件基线 0 缺失 0 变化；新旧入口实读确认关闭、动态值空。

**未验证（不得当作通过）**：本机 `fs.symlinkSync` 退化为硬链接，工具的链接标记分支未验证；关闭态验证基于合成 SDK 与内存替身；索引平台就绪、3 秒超时、操作/文档大小限制、真实并发、费用均未实测；本地哈希不是云端编译后包哈希。

**剩余缺口**：V06 真实并发当前不可达（未决锁本地拦下第二请求），最小驱动草案待审查；V07 页面无独立移出按钮，`removeMember` 非幂等；P4 primary 初始化执行方法未就绪，需选择受控管理命令或非事务人工序列。

**边界**：未安装、未调用云端、未取号、未创建资源、未预览/部署/发布、未清缓存、未处理 A/B/C。本轮不宣称满足部署条件。费用/余量待 Codex 补齐后一次性提交云端执行范围确认。

## 费用补充，不改变本地任务范围（2026-10-05）

用户已明确接受必要续费或升级；套餐截图显示个人版 19.9 元/月、到期 2027-04-04、按量关闭/自动续费开启。截图列示套餐额度而非剩余额度，未形成具体购买或云端执行授权。继续下方 L1–L3 本地制品任务，无需等升级付款；不因本消息安装、部署或改入口。费用事实以进展顶部记录为准。

## Codex 新任务：仅本地制品准备，待转交（2026-10-05）

以 [本地制品准备任务](WorkBuddy任务-独立副本本地制品准备-20261005.md) 为下一轮范围：L1 关闭候选包和校验工具，L2 11 集合/13 候选索引清单，L3 有限测试与受控 primary 初始化操作稿。取代下面“继续待命”的当前安排，但尚未自动发送或确认 WorkBuddy 接手。

保持 U3/U5 等关闭，不改现有业务/副本实现和实际入口。只按任务白名单新增；并发不能用清缓存/解锁普通页面实现，需要新驱动时只提交最小草案。本轮不安装、不调用云端、不创建资源、不预览/部署/发布、不处理 A/B/C。实际费用/余量仍待 Codex 与用户核实，不阻塞本地工具准备，也不代表可云端执行。

## Codex 接续：下一阶段执行包待批准，仍待命（2026-10-05）

[独立副本小规模云端验证执行包](Codex执行包-独立测试副本小规模云端验证-20261005.md) 已写好：仅候选新增 scheduleSandbox、11 前缀集合/13 索引，列明费用、制品切换、真实验证、停止条件；不是已执行部署清单。当前只读环境为个人版/自动续费开启/超额按量关闭，实际计费模式与剩余额度未确认，禁止承诺 0 元。相关原始字段摘要另存本日证据，旧历史不改写。

U3/U5 已关闭，U1/U2/U4/T5 保持关闭。本轮 Codex 没有委派代码任务；WorkBuddy 继续待命。下一份任务如需准备，只限精确新副本配置制品、受控初始化步骤与有限核验工具，须有明确范围；不得提前改入口或云端。新旧入口关闭、动态值空，不处理 A/B/C、不安装、不创建资源、不预览/部署/发布。用户无需手机操作。

## Codex 最新接续：U3/U5 本地验收关闭，WorkBuddy 待命（2026-10-04）

详见 [U3/U5 验收与可复制通知](Codex验收-独立测试副本U3U5收尾-20261004.md)。**U3/U5 功能通过；U1/U2/U4/T5 保持关闭。无需继续业务返修。** 全量 483/483、WorkBuddy 脚本 12/12、Codex 四组追加复现、9 WXML / 10 WXSS 真实编译通过；未安装 SDK。

非阻断证据口径已由验收报告纠正：EBUSY 回填历史成功字符串不是当次执行；标签正则不等于编译；includes 表示包含固定值，不能称拒绝所有混合数组。旧证据不改写，当前结论使用新 Codex 实证。下文历史“布尔事件”说法与待修状态已被本段取代，不沿用为当前说明。

下一步由 Codex 汇总独立副本资源、索引、费用及部署验证具体执行包；WorkBuddy 暂停待命。保持入口关闭与动态值空，不处理 A/B/C，不安装、不建资源、不预览/部署/发布、不清用户缓存；用户无需手机操作。

## Codex 接续：仅处理 U3/U5 两处，U1/U2/U4 与 T5 关闭（2026-10-04）

按 [本轮复核报告](Codex复核-独立测试副本U1-U5收尾-20261004.md) 第 3、4 节完整验收表定点收尾，第 6 节有可复制提示词。U3 是页面组包与恢复校验的本轮回归；U5 是原生控件事件契约原要求未完成。不要重做已关闭项，不新建功能；非阻断注释残留随改。

Codex 已复跑 480 项全通过、9 WXML / 10 WXSS 编译通过、vendor --check 通过，8 个交付哈希匹配；另建独立证据及 12 条 WorkBuddy 复跑输出，历史原文件不改写。测试通过不代表上述两处已正确：错误断言与绕过 Page 的测试已在报告指出。

保持新旧入口关闭与动态值空，不改 vendor/旧业务/旧探针/凭据/env-gate/事务替身，不处理 A/B/C，不安装、不操作云端、不建资源、不预览/部署/发布、不清缓存。用户无需手机操作。下文保留历史交付，当前结论以本段为准。

## 最新接续：U1–U5 本地定点收尾完成并自测通过，等 Codex 复查（2026-10-04）

按 `docs/Codex复核-独立测试副本T1-T5返修-20261004.md` 完成 U1–U5。要点如下，细节见 `docs/进展与待办.md` 同日段落与 `docs/证据/独立测试副本U1-U5返修复现-20261004.cjs`/`.json`。

### 改了什么

- **U1（客户端结果分类）**：`dispatch` 按 `retry` 分流。**恢复路径的非成功响应一律保留 envelope**（返回 `retryDenied`），只有 `REQUEST_ID_REUSED_DIFFERENT_PAYLOAD` / `SANDBOX_PROJECT_PAYLOAD_MISMATCH` 才结束未决。依据：`tryReceiptReplay` 在读回执**之前**先做 `verifyActorInTransaction` + `assertProjectWritable`，业务码不构成“原提交未发生”的证据。首次请求的 definite 行为不变。
- **U2（会话身份）**：新增 `refreshSessionIdentity(api)`，独立发一次 `identify` 取服务端 `userId`；**不经过 `callSandbox`**，因此不被旧未决锁死、也不覆盖任何 envelope。`resumePending` 在发业务请求前最后核实身份，未确认/不符则零业务发送并保留记录。顺序上把纯本地判定（目标、凭据、安全性）放在身份核实之前，目标不一致时零请求。更正 identify“零写”说明为 vendor 实际行为（首次写 `users` + `registerIdentity` 审计）。
- **U3（恢复前置与元数据）**：项目必需动作当前登记为空也必须停止；无项目动作不补目标。`validateEnvelope` 增加存储键归属、`snapshot.action`/`snapshot.projectId` 与顶层一致、动作与目标自洽等交叉校验；`writeEnvelope` 写后读回核对全部关键绑定。损坏停止，不修补。
- **U4（云函数 guard 文案）**：`committed` → `commitAcked`（仅正向证据）。未收到成功返回时不再断言未提交，改为“提交结果未确认…按同一编号重试核对”；已确认提交后读失败单独成句。未引入补偿性重建。
- **U5（页面日期确认）**：确认绑定到 `dateConfirmedFor`（`endDate|expectedDate` 组合），任一相关日期变化立即失效；`onLoad`/`onShow`/`changeAction` 也清除。`toggleDateConfirm` 按 `<checkbox bindchange>` 真实契约要求布尔 `detail.value`，不用 `Boolean()` 转换；模板已同步并被测试核对。

### 没改什么

`vendor/service.js`、`vendor/schedule-service.js`（仍只由 `build-sandbox.cjs` 生成，`--check` 通过）、原 `memberAccess`/`connectionCheck`、R1 身份字段、R6 集合保护、**T5 事务替身（已验收关闭）**、S1 准备链、S3 归属与列表、旧探针/凭据/env-gate、A/B/C 迁移逻辑，均未改动。87 文件基线中只有 `miniapp/miniprogram/app.json` 变化（此前已获准的新增路由）。**所有历史证据保持原状**（T1–T5 复现脚本/JSON 哈希与上一轮交付一致）。

### 本轮结果

隔离 41/41、前端 45/45；**全量 480 项、479 通过、0 失败、1 跳过**（上一轮 452）。定点验证 12/12。`check-pages.cjs` 9 路由全通过。**原 `check.cjs` 本轮在本机因 `spawnSync EBUSY` 无法运行**（Windows 环境限制），已用等价逻辑（`vm.Script` 代替 `spawnSync`）完成其全部检查项并全部通过；**WXML/WXSS 真实编译未执行**（本机无编译器）。`build-sandbox.cjs --check` 通过。

### 下一步

等 Codex 复查 U1–U5。复查通过后才进入部署前资源/费用/规格审查；当前**不放行资源创建、启用入口或部署**。

### 未验证（不得当作已通过）

平台隔离未验证（内存替身）；替身不是平台事务模型；**U1 的服务端拒绝顺序与 U4 的提交响应丢失均为本地故障注入，不冒称 CloudBase 实测**；**U2 只在内存中模拟共享存储与账号变化，不声称实测微信跨账号缓存行为**；真实 SDK 形状、3 秒/100 操作/32 KiB 未实测；真实并发未实测；**页面未在微信开发者工具或真机编译**；11 个带前缀集合与索引尚未创建；B0-7/B0-8/历史非零代际/B 无管家/恢复载体未闭合；**费用未核实，不承诺 0 元**；测试 openid 为本地虚构。



按 `docs/Codex复核-独立测试副本S1-S6返修-20261004.md` 完成 T1–T5 定点返修。要点如下，细节见 `docs/进展与待办.md` 同日段落与 `docs/证据/独立测试副本T1-T5返修复现-20261004.cjs`/`.json`。

### 改了什么

- **T1**：客户端按动作分三类（只读 / 有回执保障 / 无幂等保障），无幂等保障的动作结果未知**不重发**并**锁写**；取消"直接清锁重发"，解除需显式确认已在管理端核对且**解除后仍锁写**；门控/窗口拒绝不清除未决记录；业务层拒绝码（含 `SCHEDULE_CONFLICT` 等实际码）归为可修正。
- **T2**：未决记录与快照合并为**单一 envelope 单键**，含可信账号（来自服务端 `identify` 的 `userId`，不信任表单 `actorId`）；恢复核验账号与目标，换目标即停止不覆盖；普通提交不静默恢复，只有显式 `resumePending()` 重建；旧格式残留只阻断不删除。
- **T3**：`project-guard` 新增 `verifyRoundState`，回放统一重验权限与轮次状态（记录字段/确定性 ID/项目真实存在），并发回放不再绕过权限；错误信息只陈述已证实事实，不再虚假声称"已整体回滚"。
- **T4**：页面新增 `inputCredential` 作为未决期间唯一解锁通道（只补录本次所需凭据，其余字段仍锁定）；修掉 `restDays` 回填到 `form.restDays` 而非 `restDaysText` 的真实缺陷；日期不一致不再无条件 `expectedConfirmed=true`，需显式确认；移除 `discardPending`。
- **T5**：测试替身改为**每 attempt 独占写集**，未提交写入对事务外与其他事务不可见，失败只丢弃本 attempt 写集与写日志；新增 `pauseBeforeCommit`、`failNextRead(..., when)` 夹具；`seededDb(extra, options)` 透传 options。

### 没改什么

`vendor/service.js`、`vendor/schedule-service.js`（仍只由 `build-sandbox.cjs` 生成，`--check` 通过）、原 `memberAccess`/`connectionCheck`、R1 身份字段契约、R6 集合保护、旧探针/凭据/env-gate、A/B/C 迁移逻辑，均未改动。87 文件基线中只有 `miniapp/miniprogram/app.json` 变化（此前已获准的新增路由）。

### 本轮结果

隔离 36/36、前端 22/22；**全量 452 项、451 通过、0 失败、1 跳过**（上一轮 441）。定点验证 15/15。原 `check.cjs` 本轮首次可正常运行（此前 Windows `spawnSync EBUSY` 不再复现），JSON/JS/9 路由通过；**未提供微信编译器，WXML/WXSS 编译跳过且不视作通过**。`check-pages.cjs` 9 路由全通过。

### 下一步

等 Codex 复查 T1–T5。复查通过后才进入方案第 6 节的部署前资源/费用/规格审查；当前**不放行资源创建、启用入口或部署**。

### 未验证（不得当作已通过）

平台隔离未验证（内存替身）；替身不是平台事务模型；真实 SDK 形状、3 秒/100 操作/32 KiB 未实测；真实并发未实测；**页面未在微信开发者工具或真机编译**；11 个带前缀集合与索引尚未创建；B0-7/B0-8/历史非零代际/B 无管家/恢复载体未闭合；**费用未核实，不承诺 0 元**；测试 openid 为本地虚构，与真实微信账号对应关系未验证。

Codex 已按实际源码完成[本轮复核](Codex复核-独立测试副本S1-S6返修-20261004.md)。本段取代下方 WorkBuddy 自测交付的当前状态；历史原文保留。正常 main 准备链、正常邀请归属/列表隔离、页面 JSON 与编译修复通过；R1 身份字段、R6 集合保护保持关闭，不重做。

整体尚未通过：T1 未知结果不能统一同号重发或直接清锁；T2 未决记录半写与目标/账号绑定；T3 创建回放权限/状态与提交后未知结果；T4 带凭据的页面恢复及日期确认；T5 测试替身未提交写入可见。10 条离线定点复现见报告链接及其证据。本轮只写审查/复现与接续，没有修改产品实现。

实际核验：441 项全通过（已有 SDK 离线用例也执行，0 跳过），原 check.cjs 及真实微信编译器 9 WXML/10 WXSS 通过；15 个交付哈希一致，87 个旧基线文件仅获准的 app.json 路由变化，vendor --check 通过。全绿不抵消已复现的恢复与测试隔离缺口，也不代表真实平台验证。

下一步：将报告第 7 节可复制任务交 WorkBuddy，仅做 T1–T5 本地定点返修。新旧入口继续关闭、动态值空，不改原业务/vendor 算法/旧探针/凭据/env-gate，不触碰 A/B/C，不安装、不创建资源、不预览/部署/发布。用户无需手机操作；修复复核通过后再进入部署前资源/费用/规格审查。

## 最新接续：S1–S6 定点返修完成（441 项测试 0 失败），交 Codex 复查（2026-10-04）

已按[Codex 复核](Codex复核-独立测试副本R1-R7返修-20261004.md)完成 S1–S6。**R1 身份字段、R6 集合保护已通过，未重做。** **只改本地新副本 + 必要新页面配置/路由 + 测试 + 文档**；`git diff` 对既有产品代码为空，87 文件基线中**只有 `app.json`** 因新增独立测试页路由而变化。**未操作云端、未创建资源、未安装、未取号、未预览、未部署、未发布。** 新旧入口默认关闭、动态值空；原 `memberAccess`/`connectionCheck`、vendor 业务算法、旧探针/凭据/env-gate、A/B/C 未改动。**原审查与双方历史证据保持原状。**

### 逐项要点

| 项 | 返修 | 验收 |
|---|---|---|
| **S1** 准备链 | 项目范围依据改为「**本轮持久记录中的唯一项目**」（不再是配置静态 ID）；准备期允许清单补入 `getMembers`/`listInvitations`/`getScheduleContext` 与三个只读查询，**仍不含施工写动作** | `S1.1`–`S1.4` **全程经真实 `index.main`** 从零走完建项目→取号→指定管家→邀请→申请→批准→核对成员/邀请，**未用 vendor 直接写成员跳过准备**；再受控切 execute 执行施工四写与查询 |
| **S2** 一致提交 | **事务委托 enlist**：包装层登记「唯一记录+回执」，由**业务实现发起的那一次真实事务**在业务工作之前执行 → 同事务一致提交、失败整体回滚、**仍单层真实事务**；enlist 槽每请求一个且在 `runTransaction` 期间保留（SDK 重入每次 attempt 都重执行）。唯一键与项目ID **只由 roundId 决定** | `S2.1` **真实回执写故障注入**（替身 `failNextWrite`，数据层注入）→ 项目/成员/审计/回执**全为 0**，重试成功；`S2.2`/`S2.3` 同号与不同号并发**两请求都成功**、同一项目、**不接受 SERVER_ERROR**；`S2.4` primary 改绑后仍只一个项目；`S2.5` 同载荷回放/异载荷拒绝；`S2.6` 回放先重验权限；`S2.7` 唯一记录缺失则停止 |
| **S3** 归属与列表 | **始终**以记录真实归属为准，请求 ID 存在时**必须一致、不得覆盖**；邀请码规范化与 vendor 同（`trim().toUpperCase()`）；两阶段均有归属约束；`listMyProjects` **只限本轮项目** | `S3.1` 跨项目邀请码 prepare/execute × 带允许ID/不带ID/带错ID **六组合全拒且零写入**，邀请保持 `issued`；`S3.2` 大小写/空格变体同样被拒；`S3.3` **实测 `listMyProjects`**（未建本轮→拒绝；建好后→只含本轮）；`S3.4` A/B/C 两阶段与误配硬拒绝 |
| **S4** 客户端 | **未知/封闭动作零请求**；按动作核验**固定目标**（不一致或缺失零请求，身份类例外）；未决记录绑定**动作/项目/requestId + 非敏感快照 + 摘要**；同号不同动作拒、不同号拒、**同号重试从快照重建**；**存储读/写失败、记录损坏、摘要不匹配一律拒发**；**结果三分类**（成功清理 / 明确业务拒绝清理 / 未知保留）；**凭据只存摘要**；按**环境+轮次**隔离 | `S4.1`–`S4.12` 用**启用后的真实客户端**检查**实际发送参数**（11 类动作必需字段全到、7 禁止字段未透传、嵌套 form 保留 `restDays`），其余覆盖零请求、三分类、读写失败、快照篡改、凭据脱敏、轮次隔离 |
| **S5** 页面 | 17 个动作覆盖**完整最小测试链**（身份→取号→建项目→指定管家→邀请→申请→批准→核对→施工四写→查询）+ 凭据/施工/邀请输入；**固定目标无需手抄**；`restorePending` 恢复**真实快照**并可同号重试/放弃；每次 `onShow` 与提交前重校验；**拒绝环境不展示可操作控件**；补 `schedule-sandbox.json` | `S5.1`–`S5.9` **加载实际 Page 对象**执行 `onLoad`/`onShow`/事件：正常链、施工与邀请字段构造、**退出重进恢复同号与项目并可重试**、未决期间阻止改动作与改表单、release 关闭、存储不可用零请求 |
| **S6** 测试与工具 | 替身补 **undo 日志**（只撤销本次写入，**不把另一事务已提交的记录误当回滚**）、重复键拒绝、`DUPLICATE_KEY` 触发重入、屏障只作用首个 attempt；`check-pages.cjs` **必要文件缺失即失败**并写明**范围与不等价说明** | `S1.1` 全程 main；`S2.1` 真实故障注入；`S2.2` 并发不接受 SERVER_ERROR；`S3.3` 实测列表；`S4.8` 补业务拒绝分支；`S5.6` 加载真实 Page；`S6.1` 屏障制造真实交错验证冲突与保留 |

### 一处事实更正

上一轮「原 collection-map 未调用 `work(tx)`」的表述**不准确**——被审查版本已含 `return work(tx)`。实际情况是**本轮返修过程中**曾一度出现事务委托实现不完整导致经 main 的事务未落库，已在同轮定位修正；属**返修过程临时缺陷**，**不**据此否定上一轮证据。

### 文件与哈希

| 文件 | SHA-256 |
|---|---|
| `cloudfunctions/scheduleSandbox/collection-map.js` | `09c5aa9bea3c779aa8c65ea4991c77691db8005380099179ce4281f153046ae6` |
| `cloudfunctions/scheduleSandbox/gate.js` | `712b6e92b606c321de114f5eed36a66db7ee431dcfc6d4fe7181fb5fd8d0e4cc` |
| `cloudfunctions/scheduleSandbox/project-guard.js` | `9670ad2e85daacf653fa5c3939bfe6e5ae1025fe1daedefc50fc893bb1c04551` |
| `cloudfunctions/scheduleSandbox/index.js` | `1bec56a38fcec9da89460a32ec34bb55c5607ed740e48692fd6360e5203da048` |
| `miniprogram/config/schedule-sandbox-proof.js` | `724bc3c16ca8d03b84d3d8498b06e011b2ad621599167fc78649b2b378c0cf33` |
| `miniprogram/utils/schedule-sandbox-client.js` | `4b51cec35ecfbe26d9717c38bc62a1304d16c2299a89e8ff7d9df6971a854ff1` |
| `miniprogram/pages/schedule-sandbox/schedule-sandbox.js` | `82ea23087125b8d4b0e3b1512b9d0e2c862dc2832c3540c190beb6f6f66a48b4` |
| `miniprogram/pages/schedule-sandbox/schedule-sandbox.wxml` | `cff304362b899d2065d693db785de309273bfc7e804f2afac3f16a6a3839cdba` |
| `miniprogram/pages/schedule-sandbox/schedule-sandbox.wxss` | `d30ca2ab51a2ff15179ace61f1b83a5c8d7a9e8514046262260dd923b25a1eb1` |
| `miniprogram/pages/schedule-sandbox/schedule-sandbox.json`（新增） | `7713a1f63aec15f626eef5e42809b1a1cbdae561351d77c54856894ca1cd1609` |
| `miniprogram/app.json`（仅新增一条路由） | `7318ca539c191670b58297ba5008b5403fda5c6b91da99010c35a85434221f80` |
| `scripts/check-pages.cjs` | `df046c12181ed5518412094384dc5dceb1777cf6e583dc1ca631a3a6094314aa` |
| `tests/helpers/sandbox-test-db.cjs` | `5bc9b0af4cba19c0444d69191a8bf45c4ef571c73d4bbe883a42ea7094955a43` |
| `tests/schedule-sandbox-isolation.test.cjs` | `394980b6505b12f00174e937bc5b78d752e7f8648704caf33b7b1494f037e71c` |
| `tests/schedule-sandbox-frontend.test.cjs` | `5d012ee5b877c61197783775f0f92a674dcb6f3a85d494989b518f45090ce20d` |

`vendor/service.js`（`c5e93d81…a89e55`）与 `vendor/schedule-service.js`（`da302a74…f69cbec`）**未变**，`build-sandbox.cjs --check` 通过。

### 本轮实际测试与检查结果

- 隔离 **25/25**、前端/页面 **22/22**
- **全量 441 项，440 通过、0 失败、1 跳过**（上一轮 449 项；本轮重写两个沙箱测试文件，移除已被 S1–S6 取代的旧断言）。跳过为既有 `member-access-sdk` 实际 SDK 用例，原因「未指定已取得的 wx-server-sdk 路径」；**未安装、未伪造通过**。
- **页面结构检查** `node miniapp/scripts/check-pages.cjs`：路由 9 条、WXML 9、WXSS 9、必要文件齐全、**全部通过**。
- **原 `scripts/check.cjs` 仍无法运行**：本机 Windows `spawnSync … EBUSY`（此前各轮已记录）。`check-pages.cjs` 为**辅助**检查，**不等价**原检查，也不等价微信编译器。
- **真实模板编译本轮未执行**：本机无微信开发者工具；Codex 上一轮曾跑通 9 WXML/10 WXSS，本轮新增页面 `.json` 后**未重新编译**，如实标未验证。
- 基线：87 文件中**只有 `app.json`** 变化（R5 授权的新增路由）。

### 未验证项

1. **平台隔离未验证**（全内存替身），不能声称已验证，只形成部署候选。
2. **替身不是平台事务模型**：enlist 一致提交、冲突重入、undo 日志均为内存近似；真实 `runTransaction` 嵌套与冲突语义、3 秒/100 操作限制**未实测**。
3. **并发结论基于内存交错**（Promise 并发 + 替身冲突检测），真实平台并发未实测。
4. **11 个带前缀集合与索引尚未创建**（索引待 B0-7，上轮候选≠必建）。
5. **新管理员 primary 初始化、资源创建、真实身份登记、项目创建**只写待执行清单。
6. **页面未在微信开发者工具或真机编译运行**，仅结构解析通过。
7. B0-7 索引适配、B0-8 写入者覆盖、历史非零代际、B 无管家、恢复载体**均未闭合**；新副本**不为测试解决 A/B/C 迁移**。
8. **费用未核实，不承诺 0 元**；未开通按量超额/自动续费/付费升级。
9. 测试账号为本地虚构 openid，与真实账号对应未验证。

**当前状态**：S1–S6 已返修并自测通过；**未部署、未创建资源、未启用任何入口**；原施工安排入口仍关闭；A/B/C 未触碰。下一步由 Codex 复查，通过后进入方案第 6 节部署前资源/费用/规格审查。**本轮不请求云端授权，用户无需手机操作。**

## 历史接续：Codex 复核要求 S1–S6 本地收尾，整体未放行（2026-10-04）

> **本段为历史记录，保留未删改。其要求的 S1–S6 已在上一节完成；"下一步"以最新接续点为准。**


执行 [Codex 复核报告](Codex复核-独立测试副本R1-R7返修-20261004.md)的 S1–S6，第 8 节提供可复制任务。R1 身份字段、R6 集合保护已关闭，R2 字段丢失与环境传参已修；不要重复重做。真实准备链、项目创建一致提交、邀请/列表归属、未决快照及结果分类、页面操作恢复和测试/文档准确性仍需返修。

Codex 实测 449 项全通过、0 跳过（已有 SDK 离线用例）；真实 9 WXML/10 WXSS 编译通过；原 check.cjs 因缺 `schedule-sandbox.json` 失败。测试通过未覆盖本次反例，详见新审查脚本/JSON。旧 87 文件只有 app.json 变化，16 个交付文件哈希一致。下方上一交付及其“全部完成”结论为历史记录，不代表 Codex 验收通过。

保留全部旧审查与双方证据，下一轮另立证据；修正顶部当前事实。仅本地新副本、必要页面/路由、相关测试与记录；原业务源码、vendor算法、旧探针/凭据/env-gate保持。入口关闭，动态值空，不安装、不取号、不操作云端、不建资源、不预览/部署/发布；用户无需手机操作。本文件为交接，不声称已自动向 WorkBuddy 发消息。

## 最新接续：R1–R7 本地返修完成，交 Codex 复查（2026-10-04）

已按[Codex 审查](Codex审查-施工安排独立测试副本本地实现-20261004.md)完成 R1–R7 定点返修。**仅本地新副本 + 必要新路由 + 测试 + 开发记录**；`git diff` 对既有产品代码为空，87 文件基线中**只有 `app.json`** 因新增独立测试页路由而变化。**未操作云端、未创建资源、未安装、未预览、未部署、未发布。** 原 `memberAccess`/`connectionCheck`、旧探针/凭据/env-gate、A/B/C 未改动；新旧入口默认关闭、动态值空。**原审查与其复现证据保持原状。**

### R1–R7 逐项要点

| 项 | 修复 | 证据 |
|---|---|---|
| **R1** | 新增 `toWechatContext()`，门控 `appId/openid` **显式转换**为业务层 `APPID/OPENID`；不改 vendor | 修复前 `IDENTITY_UNAVAILABLE`/DB 操作 0 → **修复后 `ok:true`/DB 操作 2**（经真实 `index.main`） |
| **R2** | 按 `service.js` 的 `event.*` 与 `validateForm` 的 `form.*` 重写顶层与嵌套白名单 | 启用后真实客户端**实际发送参数**逐动作断言 11 个必需字段全到、7 个禁止字段未透传；`restDays` 保留数组 |
| **R3** | 项目ID 改 `roundProjectId(round,actor)`（**不含 requestId**）；回放**先核验权限**、比对输入摘要、确认项目存在 | 换号/同号并发/不同号并发**各只 1 个项目**、1 套成员、1 条审计；同号不同载荷与停用回放**均被拒** |
| **R4** | 阶段只接受明确值（**不回落**）；改**每阶段允许清单**；A/B/C 硬拒含误配；执行期按邀请码解析归属 | 未知动作/未知阶段**零数据库访问零写入**；跨项目邀请码被拒且状态保持 `issued` |
| **R5** | 新增 `pages/schedule-sandbox/`（标注「施工安排独立测试」，确定调用新客户端）；客户端持久化未决状态 | 页面/路由/导入断言；release 与未知版本零请求；退出重进恢复；**存储失败拒绝发送**；未决期间阻止改表单 |
| **R6** | 映射表改 `Object.create(null)` + `hasOwnProperty` 严格校验；**先冻结目标再包代理**；拦截四类改写 | 原型名/空名/未登记名在事务内外**零下层调用**；四类改写全被拒且属性未注入 |
| **R7** | 测试真正经 `index.main`（新增 `sandbox-entry-loader.cjs`）与启用后客户端；移出保护用正确参数；重入由模拟 SDK 同次重调回调；变异实际适配器；替身拒绝重复主键并有冲突检测 | 隔离 35/35、前端 20/20；移出断言 `WORKER_HAS_ACTIVE_SCHEDULES` 且取消后合法移出成功 |

**返修中发现并修复的真实缺陷**：`collection-map.js` 的 `runTransaction` 原先 `return Object.freeze(tx)` 而**未调用业务回调**，导致经 main 的事务静默不落库（此前测试直接调 vendor 未暴露）。已修为调用并返回 `work(tx)`。

### 文件清单与 SHA-256

| 文件 | SHA-256 |
|---|---|
| `cloudfunctions/scheduleSandbox/collection-map.js` | `9cdffe652f6720c9f9929e1710f5c32d3edc9efaf3beb9371223279d53d9629b` |
| `cloudfunctions/scheduleSandbox/gate.js` | `8106da93398b1a61ef4b85b597e02ddf135350697facf602fcef37df4b344247` |
| `cloudfunctions/scheduleSandbox/project-guard.js` | `bd36312b29f102dcbfb74628fbd849a15607d1e304ef46f214bac4d4b1aacd27` |
| `cloudfunctions/scheduleSandbox/index.js` | `1b126e5cdb815cd24372e9bda3939b4b76b37b4faf24560b4fab84357e270dcb` |
| `miniprogram/config/schedule-sandbox-proof.js`（未变） | `71307f7ecd0ef6d47b38ac15512de1504e88b0c43be91d4ef315de211ab4a2e4` |
| `miniprogram/utils/schedule-sandbox-client.js` | `2d74e5308a65c7ca448113f38591707c540ea91cc4cfb33624f933efcf364fa5` |
| `miniprogram/pages/schedule-sandbox/schedule-sandbox.js`（新增） | `887844bb60abc0a854d10155e416e7141c4afa8c0cd3fb3681fae57c2158a7b2` |
| `miniprogram/pages/schedule-sandbox/schedule-sandbox.wxml`（新增） | `e62faf46d1a747ed0e66d5e0017f72df2b972c6cdb9a6e84571479f6c0759184` |
| `miniprogram/pages/schedule-sandbox/schedule-sandbox.wxss`（新增） | `d30ca2ab51a2ff15179ace61f1b83a5c8d7a9e8514046262260dd923b25a1eb1` |
| `miniprogram/app.json`（仅新增一条路由） | `7318ca539c191670b58297ba5008b5403fda5c6b91da99010c35a85434221f80` |
| `scripts/build-sandbox.cjs`（未变） | `457d82a097331ebad7bd536de25d0caf2da8e8c2c6dd9aa2a2bcb84e773a9a41` |
| `scripts/check-pages.cjs`（新增） | `0a9a9d4fc71fe2f3773895d3e03d3dc3ed7f8d8b7aff3b024028add8b439fbf0` |
| `tests/helpers/sandbox-test-db.cjs` | `6bafe267d3fcd5f5985733c4ed6c7d82ce5a59eb91671712ca14d07e3978ab53` |
| `tests/helpers/sandbox-entry-loader.cjs`（新增） | `f9eae7e58027b4104b41c4643ebe116784f73e595cadf7d59a3f8d6f9e8284e3` |
| `tests/schedule-sandbox-isolation.test.cjs` | `7c86343c6317b9180be4611f1094ffee4151638c1ddd04c1273f5ee7c5842cac` |
| `tests/schedule-sandbox-frontend.test.cjs` | `2f0b9f79a23128341bf0ae06cabc0c3b9a7aaebe531676c5b48793140f1e3f0a` |

`vendor/service.js`（`c5e93d81…a89e55`）与 `vendor/schedule-service.js`（`da302a74…f69cbec`）**未变**；`build-sandbox.cjs --check` 通过。

### 本轮实际测试与编译结果

- 隔离 **35/35**、前端/页面 **20/20**
- **全量 449 项，448 通过、0 失败、1 跳过**（返修前 429，+20）。跳过为既有 `member-access-sdk` 实际 SDK 用例，原因「未指定已取得的 wx-server-sdk 路径」；本机该 SDK 不可解析，**未安装、未伪造通过**。
- **定点复现** `node docs/证据/独立测试副本R1-R7返修复现-20261004.cjs` 全部通过（详见 JSON）。原 Codex 复现脚本断言的是修复前缺陷现象，返修后其 R1 断言不再成立，故另立自查脚本对照。
- **页面结构检查** `node miniapp/scripts/check-pages.cjs` → 路由 9 条、WXML 9 个、WXSS 9 个**全部通过**。
- 已知限制：`scripts/check.cjs` 在本机因 Windows `spawnSync … EBUSY` 无法拉起子进程（此前各轮已记录），以 `check-pages.cjs` 等价替代。**不等于微信开发者工具或真机编译通过。**

### 未验证项

1. **平台隔离未验证**（全内存替身），不能声称已验证，只形成部署候选。
2. 真实 SDK 形状/事务/3 秒/100 操作/32 KiB 未实测；**替身的重入与冲突检测是内存近似，不是平台事务模型**。
3. **建项目回执与建项目不同事务**；真实并发未实测。
4. 新管理员 primary 初始化、资源创建、真实身份登记、项目创建**只写待执行清单**。
5. 11 个带前缀集合与索引**尚未创建**（索引待 B0-7，上轮候选≠必建）。
6. B0-7 索引适配、B0-8 写入者覆盖、历史非零代际、B 无管家、恢复载体**均未闭合**；新副本**不为测试解决 A/B/C 迁移**。
7. **费用未核实，不承诺 0 元**；未开通按量超额/自动续费/付费升级。
8. 测试四账号为**虚构 openid**，与真实账号对应未验证。
9. **页面未在微信开发者工具或真机编译运行**，仅结构解析通过。
10. `build-sandbox.cjs` 的非阻断观察（首次生成 `entries` 在复制前计算、`--check` 未核验磁盘 MANIFEST）**本轮未改**，现有 MANIFEST 与文件一致。

**当前状态**：R1–R7 已返修并自测通过；**未部署、未创建资源、未启用任何入口**；原施工安排入口仍关闭；A/B/C 未触碰。下一步由 Codex 复查，通过后进入方案第 6 节部署前资源/费用/规格审查。**本轮不请求云端授权，用户无需手机操作。**

## 历史接续：Codex 要求本地返修 R1–R7，暂不进入部署（2026-10-04）

按 [Codex 审查报告](Codex审查-施工安排独立测试副本本地实现-20261004.md)第 2 节修复；第 5 节有可复制任务。原方案第 4–5 节范围不变。重点是实际 main 身份契约、客户端字段、本轮唯一项目与当前权限回放、阶段/项目范围、独立页面及未知结果恢复、固定映射保护和真正经过入口的测试。不要重做已验收旧业务算法或处理 A/B/C 迁移。

Codex 复跑 429 项（428 通过、1 跳过），已使用现有 SDK 单独跑通跳过项。现有测试未覆盖的定点反例已在报告与 `证据/独立测试副本本地审查复现-20261004.cjs/.json` 留存。14 个新增文件哈希与交付一致；旧基线 87 个文件全部一致。下方“完成/候选”叙述保留为 WorkBuddy 历史交付，当前验收状态以本段和审查报告为准。

本地实现、自测与开发记录仍沿用用户授权；新增页面必要路由/受控导航最小接入，原路径不变。入口默认关闭，真实动态值空。不安装、不操作云端、不建资源、不预览/部署/发布，不取号、不改旧探针/凭据/env-gate。完成后列明实际差异、R1–R7 证据、完整测试/页面编译与未验证项，交 Codex 复查。用户无需手机操作；本条为文件交接，未自动向 WorkBuddy 发送消息。

## 最新接续：独立测试副本本地实现与自测完成，交 Codex 审查（2026-10-04）

已按[独立测试副本方案](Codex方案-施工安排独立测试副本-20261004.md)第 3–5 节完成本地实现、自测与记录。**14 个文件全部为新增；`git diff` 对既有产品代码/测试/配置为空。** **未操作云端、未创建资源、未安装、未预览、未部署、未发布、未提交费用操作。** 原 `memberAccess`/`connectionCheck`、旧 `env-gate`、旧探针、旧凭据、A/B/C **均未改动**；原 `schedule-entry-proof` 仍 `enabled=false`、空允许列表、冻结。

### 交付物与来源哈希

| 文件 | 作用 | SHA-256 |
|---|---|---|
| `cloudfunctions/scheduleSandbox/collection-map.js` | 11 集合固定映射 + 事务/重试包装 + 拒绝未登记 | `ae7d75470ea4ea60f26bcf04db230f23cb776ce5234032ba6b130c04add79d15` |
| `cloudfunctions/scheduleSandbox/gate.js` | 服务端门槛：开关/环境/APPID/账号/窗口 + 两阶段 + 封闭动作 | `c90fc4ccf304cfbbb29c56b85daa408a64d2066586164fea8a4db429dcae8f3d` |
| `cloudfunctions/scheduleSandbox/project-guard.js` | 建项目确定性 ID + 先查已有 + 持久回执 | `2d3f48146c6fab0699bf542bc5533d5be2efad9b2590684a8e5b922b418b50db` |
| `cloudfunctions/scheduleSandbox/index.js` | 新函数入口；门槛先于 `service.execute` | `cbf3fa5bcc8c0ec5670717dea4b0fd77c78e14b0fab537273be5cd08ca14ae8b` |
| `cloudfunctions/scheduleSandbox/package.json` | 独立依赖声明 | `8ffc87ea85fd9767980e9bde06f1693d431acd6b23b64c3b027acc8c133e7e84` |
| `cloudfunctions/scheduleSandbox/vendor/service.js` | **生成**：已验收业务实现副本 | `c5e93d81e0245471efb0bf681836cd94f796fbc6a5547b690d0298a7f6a89e55` |
| `cloudfunctions/scheduleSandbox/vendor/schedule-service.js` | **生成**：同上 | `da302a7412bb08ce03d18c8486081fcc1e786b2f07f2b3817250fbf88f69cbec` |
| `cloudfunctions/scheduleSandbox/vendor/MANIFEST.json` | **生成**：来源路径 + 双向哈希 | `cd711e548e99abf7d086c134f015874f40c34a4c787f637dac4fce50db355830` |
| `miniprogram/config/schedule-sandbox-proof.js` | 专用入口配置，默认关闭、项目ID 空 | `71307f7ecd0ef6d47b38ac15512de1504e88b0c43be91d4ef315de211ab4a2e4` |
| `miniprogram/utils/schedule-sandbox-client.js` | 测试专用客户端，唯一出口无回退 | `c0f49cae4caf171e77566ed7d48c8615248619bbd6cf25f4824935a9a94b0108` |
| `scripts/build-sandbox.cjs` | 从已验收源生成副本并记录哈希 | `457d82a097331ebad7bd536de25d0caf2da8e8c2c6dd9aa2a2bcb84e773a9a41` |
| `tests/helpers/sandbox-test-db.cjs` | 替身：遇无前缀集合即报错 | `829abe08a1053df3ecec5fac0334d674bfb26dd8c33aa54648d8e4839d1d4c1b` |
| `tests/schedule-sandbox-isolation.test.cjs` | 隔离 23 项 | `167b2bdc359df17b8600856f8e0f15af02dce36912435ee1d7a5097f42efb7fe` |
| `tests/schedule-sandbox-frontend.test.cjs` | 前端与原资产 12 项 | `16026f91f86a42eb81cf079b0dd69cfc88097e5ef57801eb43b9645129880c8e` |

**生成可追溯**：`vendor/` 由 `scripts/build-sandbox.cjs` 从 `cloudfunctions/memberAccess` 生成，**源与副本逐字节一致**；`--check` 只校验不写入，不一致时**拒绝覆盖**并报错。已确认产物**未混入** `memberAccess` 目录。

### 实现要点

1. **11 集合固定映射**：`users`/`app_admins`/`projects`/`project_members`/`invitations`/`audit_events`/`schedules`/`schedule_revisions`/`schedule_occupancy`/`member_task_guard`/`schedule_receipts` → `schtest_v1_` 前缀。已逐项核对业务实现实际调用面（`collection`/`doc`/`where`/`orderBy`/`skip`/`limit`/`get`/`add`/`update`/`remove`/`runTransaction`，**无** `command`/聚合/geo）。事务外、事务内事务对象、SDK 重入每次 attempt 均映射。未登记/缺映射/恶意名称立即拒绝，**不自动加前缀**；不暴露原始句柄；未实现 API 显式抛错。
2. **门槛与两阶段**：开关默认 `false`，五项动态值默认空，缺项拒绝；环境只用 `TCB_ENV`/`SCF_NAMESPACE` 与 `getWXContext().APPID` 核对，**不采信请求体**；门槛全部先于 `service.execute`（防 `identify` 先写 `users`）；执行期须已登记项目ID、禁止建项目、原 A/B/C 拒绝；`setScheduleWriteMode`/恢复ready/迁移/维修/任意数据库操作**不开放**。
3. **专用入口无回退**：固定环境 + 固定函数名单一出口；白名单不含 `functionName`/`envId`/`appId`/`isAdmin`；未知结果保留 requestId、不重发不清标记；缓存键 `schtest_v1:` 分开且不清旧缓存；旧 `env-gate` 未放宽，无全局重定向。
4. **建项目防重（重要发现）**：已验收 `createProject` **无 `requestId` 幂等**（仅安排四写用 `schedule_receipts`）。为满足方案 §4.2 又不违反 §4.1「不改事务规则」，在**包装层**用确定性项目ID + 先查已有 + 持久回执补足。**回执与建项目不在同一事务**，极窄并发窗口已列入未验证项。

### 本轮实际测试结果

- `node --test --test-reporter=spec miniapp/tests/schedule-sandbox-isolation.test.cjs` → **23/23 通过**
- `node --test --test-reporter=spec miniapp/tests/schedule-sandbox-frontend.test.cjs` → **12/12 通过**
- 全量 `node --test --test-reporter=spec miniapp/tests/*.test.cjs` → **429 项，428 通过，0 失败，1 跳过**（较此前 394 项 +35）。跳过为既有 `member-access-sdk` 实际 SDK 用例，原因「未指定已取得的 wx-server-sdk 路径」，非本轮新增。
- `node --check` 12 个新增 JS 全通过；`package.json` 解析正常；`node scripts/build-sandbox.cjs --check` 通过。
- 原资产哈希复核：`memberAccess/service.js` `c5e93d81…`、`schedule-service.js` `da302a74…` 与已验收基线一致。

### 未验证项（不得当作已完成）

1. **平台隔离未验证**：全部内存替身，**不能声称"平台隔离已验证"**，只形成部署候选。
2. 真实 SDK 请求形状、事务行为、3 秒超时、100 操作、32 KiB、集合大小限制**全部未实测**。
3. 建项目回执与建项目**不同事务**，并发窗口未验证，不声称强一致。
4. 新管理员 primary 初始化、资源创建、真实身份登记、项目创建**只写待执行清单，未执行**。
5. 11 个带前缀集合与索引**尚未创建**；索引需求待 B0-7，上一轮候选**不得视为必建或已适配**。
6. B0-7 索引适配、B0-8 写入者覆盖、旧项目历史非零代际、B 无管家、恢复载体**均未闭合**；新副本**不为测试解决 A/B/C 迁移**，旧历史不完整**不被伪装成"零数据"**。
7. **费用未核实**，共享现有额度有消耗，**不承诺 0 元**；未开通按量超额/自动续费/付费升级。
8. 测试四账号为**本地虚构 openid**，与真实微信账号对应关系未验证。

**当前状态**：仅本地实现与自测完成；**未部署、未创建资源、未启用任何入口**；原施工安排入口仍关闭；A/B/C 未触碰。下一步由 Codex 审查，通过后按方案第 6 节进入部署前审查与用户一次性确认。

## 历史：当前可执行任务：独立测试副本本地实现（2026-10-04，用户已确认）

用户原话：“确认先做本地测试副本”。此前“待确认/待命”状态对本地开发已被本条取代。请按[方案](Codex方案-施工安排独立测试副本-20261004.md)第3–5节实施，第8节提供完整提示词；只做本地代码、自测和记录，不操作云端或安装。沿用原验收业务实现，保护旧后台、数据与入口；新增配置默认关闭、动态执行值空。

完成后提交实际改动、测试/编译结果、生成包来源与哈希、未验证项、部署候选清单，由Codex审查。云端写入/资源创建/部署/预览/费用仍需后续具体包确认。Codex仅准备本地交接，尚未自动发送到WorkBuddy，也未确认其已开工。

## 最新接续：独立测试副本本地准备任务待确认（2026-10-04）

Codex已完成[具体方案及可复制提示词](Codex方案-施工安排独立测试副本-20261004.md)。用户确认本地范围后，WorkBuddy按第3–5节准备新测试函数包装、固定11集合映射（含事务重试）、服务端关闭/身份/项目限制、专用客户端与隔离反例测试。未确认前仍待命；本条不是自动派发。

不改原memberAccess/connectionCheck、旧env-gate/探针/凭据，不启用旧入口，不改A/B/C，不执行云端操作或安装。新方案共享环境资源，不是完全隔离；不得因为函数名字不同就假定不影响旧数据。F1–F3保持关闭、旧B0缺口保留。云端执行须待实际代码审查、资源/费用清单及单独确认。

## 最新事实：写入者问题已有两项明确答复（2026-10-04）

用户确认“没有其他开发人员操作后台，没有设置过每天自动运行程序”。来源为用户人工陈述，替代先前“不清楚”在这两项上的状态，不再重复问。结合已有空触发器观测记录，不扩张成全部权限/历史完整性证明，也不自动放行W-4、迁移或部署。

下一步Codex整理保护A/B/C的最小测试切换方案，明确共享函数影响、资源/费用、停止与恢复条件后再确认云端执行范围。WorkBuddy继续待命，不重写已通过的F1–F3，不提前开发、创建资源或部署。此次仅同步事实与接续方向，旧证据保持原样。

## 最新事实：B0-8 用户答复“不清楚”（2026-10-04）

已收到用户对其他写入者的答复“不清楚”，状态为UNKNOWN，不等于“没有”，不再等待此题答复。旧证据保留生成时点表述。下一步由Codex收敛CAM/IAM授权主体、外部任务与历史证据的只读核查范围；当前工具不提供完整管理权限清单，不用CloudBase应用用户代替。WorkBuddy继续待命，不新增代码或重复扩写方案。

原D测试方案更新共享memberAccess，不能当作已实现与A/B/C隔离。无迁移、恢复、部署、新环境或新函数授权变化；入口保持关闭。

## 最新接续：Codex 已推进 B0-7/B0-8，只读缺口保留（2026-10-04）

见 [B0索引与写入者只读核验](Codex-B0索引与写入者只读核验-20261004.md) 及新证据：六集合索引/权限已回读，七个既有索引清单匹配；A/B/C过滤排序管理端样本4/1/3条成功。施工安排五集合该时点NOT_EXISTS，相关索引仅候选，未验证实际SDK/平台适配、未创建。

云端两函数仅 $LATEST，默认别名指向 $LATEST，触发器返回为空；memberAccess旧包指纹未变。控制台/外部脚本/CAM主体与历史删除仍未知，不能宣布B0或W-4闭合。Codex已提出写入者事实问题；未答复不视作确认。下一步由Codex继续收敛事实缺口。

WorkBuddy保持待命，无新代码或文档返修任务；F1–F3保持关闭。入口关闭/空允许列表/冻结，87个文件哈希与验收基线一致。本轮无业务路由调用、云端写入、资源创建、迁移、恢复、预览或部署；用户无需手机操作。

## 最新接续：F1–F3 文档验收通过，本轮收尾关闭（2026-10-04）

Codex 已实际核对方案与两份交接：F1–F3 和指定勘误通过，E1–E3 保持关闭。按已确定规则直接校正 PA-3 四项前置、PC-2 自引用与完整 ID 说明三处残留文字，不再要求 WorkBuddy 重交同范围文档。见 [验收报告](Codex验收-部署前准备F1-F3文档收尾-20261004.md)。

87 个实现/配置/测试文件与验收基线哈希一致；入口关闭且冻结；53 项设计用例及各清单编号完整。本轮未重跑未变化测试，未操作云端，历史证据未改写。§14 仍是不可执行草案，文档通过不等于 B0 完整闭合或云端放行。

**下一步由 Codex 继续 B0-7 索引适配与 B0-8 可得写入者证据的只读核验；WorkBuddy 暂不新增代码、不重复扩写方案。** B 无管家、历史完整性、旁路写入者约束、恢复载体及平台实测仍保留未知/未完成。继续 M-b，不补字段、不建资源、不迁移、不恢复、不部署、不启用入口。用户无需手机操作。


## 最新接续：§14 草案 F1–F3 已修正 + 第 3 节勘误同批收口（2026-10-04）

已按[复核报告](Codex复核-部署前准备E1-E3与干跑草案-20261004.md)完成 **F1–F3** 与第 3 节勘误，修订[部署前准备方案](WorkBuddy方案-施工安排部署前准备-20261003.md)（1048 → 1099 行）。**E1–E3 已通过关闭，未重做。** **只改方案 §14 与勘误文字、进展/交接记录；未改产品代码或测试、未执行 S/R/B0 全流程或 §14 任一条目、未补字段、未建资源、未迁移、未恢复 ready、未部署、未启用入口、未改写历史证据。** 入口 `enabled=false`、`allowedProjectIds=[]`、冻结。**继续 M-b；草案保持不可执行；七项裁决不变，未新增技术选项。** 本轮未重跑未变化测试（394 项与真实编译引用既有 Codex 验收）。

### F1（P1）补 schema 按单字段判断

| 项 | 内容 |
|---|---|
| 条件改法 | `PA-1`/`PB-1`/`PC-1` 由"三字段分类仍为 `FIELDS_MISSING`"改为"**`scheduleSchemaVersion` 该单字段不存在；其余字段按实际值分别核验并保留**" |
| 依据 | `setMaintenanceMode`（`schedule-service.js:658–677`）写 `scheduleWriteMode` 与 `scheduleEpoch`（`(epoch||0)+1`），**不补 schema** |
| 后果 | 进入维护后项目**不再是"三字段全缺"**而 schema **仍需补**；原表会**再次排除这条合法准备路径**（§5 已解决，**不得重新引入**） |
| 执行纪律 | **拟执行前重新读取现值**；合法现值保留，非法值/部分锚点按既有停止规则处理；`FIELDS_MISSING` 只是 **2026-10-03 观测时点基线** |
| epoch | 若已由维护事务建立或递增，`PA-2`/`PB-2`/`PC-2` **跳过并记录**，**不覆盖、不改回 0** |

### F2（P1）锚点前置与字段名

- 原"**历史非零代际已被完整证明**"字面要求**存在**非零代际却拟补 `generation=0`，**方向相反** → 改为"**已有充分依据证明不存在历史非零代际**"。有证据表明存在、或无法证明不存在时**仍不可执行**；53 条审计最小投影**不足以**满足。
- 拟写字段改用真实名 **`taskDirSchemaVersion=1` / `taskDirGeneration=0`**（原 `schemaVersion`/`generation` 会被误当实际写键）。
- 四项条件保留：两锚点均不存在 + 无 guard + **该成员**完整扫描为空 + 历史门槛满足；**`NOT_EXISTS` 不替代 `EMPTY`，也不替代历史证明**。
- `PB-4` 现值更正为"**`scheduleWriteMode` 缺失 + 无管家**"（原误写"无 guard"）。
- `PA-4` 标明**仅为未来合法业务首用的行为说明，非迁移指令**。
- §14.1 八个成员 ID 改为**完整值**；**正式包必须用完整 ID，缩写不可作执行目标**。

### F3（P2）共享部署按实际路由

| 项 | 内容 |
|---|---|
| 受限范围 | 按**当前未部署实现**：安排四写 + 批准/指定管家/移出成员在未就绪项目被拒；**`createInvitation`/`applyInvitation`/取号/身份初始化仍可能写入**；`setMaintenanceMode` 有自己的鉴权与写入路径，**不是统一缺字段拒绝**。**与 §1.3 逐路由表一致，不写"所有写入都停止"** |
| 变更包要求 | **必须评估 A/B/C 及其他调用方影响**，列明**每项目处置、在途请求约束、中断窗口、失败接续与回退适用条件** |
| **已删除的绝对结论** | "必须一次性覆盖 A/B/C 补缺与 B 权限处置"、"部分不可写中间态无法回退"——**代码部署与数据库迁移并非一个原子事务**；是否存在受控分阶段路径/兼容包/暂停窗口/安全回退**由未来具体方案证明** |
| 回退 | **不宣称回退旧包必然安全**（旧包可能绕过新围栏，须结合实际已写数据判断），**也不宣称必然不安全** |
| 保留约束 | guard 不能靠删除回到"无目录"；锚点代际只增不减；`scheduleEpoch` 单调递增不回退 |
| B 无管家 | **保留未决**：不自动加角色、不授权 app admin 绕过当前管家入口，**本轮不选择也不开发新载体** |

### 第 3 节勘误（同批处理）

- **执行状态**：§13-10 与 §16 末尾改为"**WorkBuddy 本轮未执行；Codex 已取得部分记录级观测，尚未完整执行 S/R/B0 全流程**"，写明**不能把 WorkBuddy 未操作等同于项目从未取证**；53 项用例与 §14 草案**确实未运行**。
- **§9.8**：标题改为"**B0 初查证据引用边界**"；"均未读取"补"**在初查当时**"并指向 §9.7；**原 JSON 不改写**。
- **`maintenanceRoundId`**：从 §9.6.3 白名单**移出**，加注为**拟议协议占位字段、尚无实现、不补值**、B0 不依赖。
- **编号**：`PA-*`/`PB-*`/`PC-*` 前缀与 §5 的 A-1…A-3 区分；§14.4 汇总同步。
- **索引/末尾**：§15 补 §16 行；末尾"本轮性质 D1–D4"改为 **E1–E3 与草案审查**。
- **§16 下一步**：优先 **B0-7**（最终查询与现有索引映射）、**B0-8**（函数/触发器及管理端写入者证据）；历史完整性与控制台/外部脚本约束**保持未知**，必要时提出具体事实问题，**不以等待或用户未回复当作已确认**；**平台写入实测与恢复载体不属于当前只读授权**。

### 状态与校验

**§14 全部条目仍"不可执行"，仍不是已运行的干跑结果**；F3/F4/F6 仍无事实基础。方案 1099 行、无乱码；**53 个唯一用例编号**（未增未删）、S-1…S-7、R-1…R-12、B0-0…B0-8 连续；章节 1–16 连续；`PA/PB/PC-1…4` 各连续无缺。

**改动文件**：`docs/WorkBuddy方案-施工安排部署前准备-20261003.md`、`docs/进展与待办.md`、`docs/WorkBuddy开发交接.md`。产品代码、测试、云函数配置、入口、旧探针/凭据/env-gate 全部未动；Codex 五份审查/核验文档与全部历史证据原样保留。

**未验证项**：写入者覆盖未知（B0-8）；**历史完整性未获证明**；占用完整性无法验证（`NOT_EXISTS`）；W-4 未确认；**B 无管家**路径不成立；平台与 SDK 限制全部未实测；索引需求未结论化（B0-7）；恢复载体与入口均未实现；`scheduleEpoch` 缺失填值与承担递增事务待变更包；**53 项用例与 §14 草案确实未运行；S/R/B0 全流程尚未完整执行**。

**当前状态：写入、迁移、恢复 ready、部署、入口启用均未放行；B0 只读取证可继续；用户无需扫码、导出或手机操作。**

## 历史接续：E1–E3 通过关闭，§14 草案定点修正 F1–F3（2026-10-04）

> **本段为历史记录，保留未删改。其要求的 F1–F3 与同批勘误已在上一节完成；"下一步"以最新接续点为准。**


Codex 已核对本轮方案及两份交接：E1 字段契约、E2 扫描范围、E3 B0 状态同步均通过。87 个实现/配置/测试文件与 V1–V3 验收哈希一致；53 个设计用例及 S/R/B0 编号完整；入口仍关闭且冻结。本轮未重跑未变化测试，未调用云端。

新增 §14 保持不可执行，需修正三点：F1 补 schema 不得要求三字段仍全缺失；F2 补锚点须证明“无”历史非零代际且使用 taskDirSchemaVersion/taskDirGeneration 真字段；F3 共享部署只按实际受影响路由说明，不能推出全部不可写、强制同时迁移三个项目或必然无法回退。见 [复核报告](Codex复核-部署前准备E1-E3与干跑草案-20261004.md)。

**下一步：WorkBuddy 仅改 F1–F3 与同批勘误；Codex 继续 B0-7/B0-8 可得只读证据，两者互不阻塞。** 不重做 E1–E3，不改代码或测试，不补字段、不建资源、不迁移、不恢复、不部署、不启用入口。用户无需手机操作。下方 WorkBuddy 交付描述保留为历史，正式结论以本节与复核报告为准。


## 最新接续：E1–E3 已收口 + 最小干跑变更包草案（未运行），交 Codex 复核（2026-10-04）

已按[正式复核](Codex复核-部署前准备D1-D4收尾-20261004.md)一次完成 E1–E3，修订[部署前准备方案](WorkBuddy方案-施工安排部署前准备-20261003.md)（875 → 1048 行），**新增 §14 最小干跑变更包草案**。**本轮只改方案与进展/交接记录；未改产品代码或测试、未执行 S/R/B0 或 §14 任何条目、未补字段、未改维护状态、未新增或部署运维函数、未操作云端、未安装、未创建资源、未启用入口、未预览/部署/发布。** 入口保持 `enabled=false`、`allowedProjectIds=[]`、冻结。**继续 M-b；七项裁决不变，未提交任何选项组。**

### E1（P1）字段契约按实际存储修正

| 项 | 修正前 | 修正后（依据） |
|---|---|---|
| `schedules` 投影 | 含**不存在**的 `workingDays`，且禁读起止日期 → **无法构造 D** | 取 `startDate`/`endDate`/`restDays`；施工日按 `workingDays()` **计算**（`schedule-service.js:1058–1065`、`:1343–1356`） |
| D 的推导 | 未定义 | 四步；`parseDate` 失败或 `start>end` 返回空数组时**标"推导不完整"并中止**，**不得当作零施工日**（§7.3） |
| guard 集合 | 泛指"成员 guard 目录集合"，字段缺 4 项 | 真实名 **`member_task_guard`**；补 `projectId`/`userId`（归属核对）、`activeScheduleCount`/`version`（`readGuardDoc` `:166–168`、`:196–210`） |
| 占用集合 | 泛指"占用桶集合" | 真实名 **`schedule_occupancy`** |
| `app_admins` | 泛指"绑定用户字段" | `_id`(固定 `primary`)/`userId`/`status`，**记录本身 active 与关联 users active 双重核对**（`service.js:94–95`、`:113–114`） |
| `invitations` | `inviteeUserId`（**不存在**） | **`applicantUserId`**（`service.js:265`） |
| `audit_events` | 仅 `_id/projectId/action/createdAt`，**不足以判历史代际** | 补 `actorUserId`/`subjectUserId` + 锚点/项目元数据 before-after **点分子字段**；**禁读完整对象**；**未发现≠历史完整** |
| 敏感字段 | "任何 OPENID 派生值不得保存"与允许 `userId` **自相矛盾** | 禁**原始 openid**/绑定编号与摘要/令牌/签名链接/完整 before-after；内部 `userId` 等可**受控本地最小化保留**（`userId` 本即 `u_`+散列，`service.js:75`）但**不等于允许公开传播**；**删除"actorId 原值以外凭据"含糊例外**（客户端 `actorId` 非可信身份） |

### E2（P2）范围与计数口径

- **S-2 计数**：原与**集合总计**比较 → 改**只与相同过滤条件计数比较**（A/B/C 成员 4/1/3、集合总计 8）；非原子差异标**待核对**，**不推断损坏**。MC-3 同步。
- **S-3 哨兵**：原"命中 201 即停止" → **取消**；项目合计 201 可分布在多个未超限成员。200/201 只在**按 `workerUserId` 分组后**逐成员应用（§6.4 同步）；取证自身资源上限中止**单列"取证未完成"**。
- **R-6 范围**：`EMPTY` 改**成员级**（该成员分组为空），避免误阻断其他成员合法首用。
- **扫描参数**："与 `scanActiveSchedules` 同参" → **"仅分页大小与排序相同"**（该函数另按 `workerUserId` 过滤 `:283–290`）。§6.2、§9.6.6 同步。
- **不要求重跑**已完成的 A/B/C 记录查询。

### E3（P2）B0 状态同步

§9.7 更新（B0-0 已完成、B0-5 已取得记录级观测、B0-6 因 `NOT_EXISTS` 无法进行、B0-8 未完成），并列出**两份 B0 证据各自状态与范围**（初查 `PARTIAL_OBSERVATION`、记录级 `RECORD_OBSERVATIONS_OBTAINED_B0_REMAINS_PARTIAL`，**均 `complete=false`**），**两份历史证据保持原状不改写**。§13 拆"已取得/仍未知"，写明**历史非零代际未获完整证明 → A-3 不可放行**、`NOT_EXISTS` ≠ 历史为空。§16 下一步改为 B0 继续只读缺口核验、草案保持不可执行。

### §14 最小干跑变更包草案（新增）

**性质：候选清单，没有任何干跑工具被开发或运行，没有执行任何写操作，没有产生任何变更结果；"候选拟值"不是已写入值，不构成写入授权。**

- **基线**：A `p_38507fc9…`(v2/4 成员/管家 64193d/主业主 f182f4)、B `p_a328c089…`(v1/**1 成员**/**无管家**/主业主 `null`)、C `p_4e53f843…`(v2/3 成员/管家 64193d/主业主 989a74)；三项目三字段缺失、八成员两锚点缺失、五安排集合 `NOT_EXISTS`。
- **条目**：A-1…A-4、B-1…B-4、C-1…C-4，**全部"不可执行"**。补 schema/epoch 因变更包未获批且围栏不可信；**补锚点因历史非零代际未获完整证明一律不可放行**；恢复 ready 因载体未实现且 W-4 未确认。**F3/F4/F6 无事实基础。**
- **B 无管家**：维护入口要求**活跃管家**，B 唯一成员是**负责人**；`app_admins.primary` 的 `2d3aa4` 虽为 app admin 但**不满足管家要求**。**禁止**让 app admin 直接调用该入口，**禁止**擅自新增管家或改 B 成员角色。候选处置**不预选**。
- **共享部署影响**：`memberAccess` **共享不可按项目隔离**；一次部署影响 A/B/C 及其它路由；**新包部署后缺三字段项目立即不可写**（A/B/C 正为此状态）→ **部署与补缺必须同批**；B 可能"A/C 可维护、B 被拒"的不对称可用性；不可回退项（guard 不能靠删除回到无目录、代际只增不减、epoch 单调递增）。**"只补 A、暂不动 B/C"不具原子性。**
- **闭合条件**：B0-8 写入者、历史完整性、B0-7 索引适配、平台实测**闭合前不得转为执行**。

### 校验与边界

**53 个唯一用例编号**（未增未删，仅 MC-3 收紧）、S-1…S-7、R-1…R-12、B0-0…B0-8 连续无缺、章节 1–16 连续、无乱码。**53 项用例、S/R/B0 三张清单与 §14 草案均未被任何工具实现或运行。**

**改动文件**：`docs/WorkBuddy方案-施工安排部署前准备-20261003.md`、`docs/进展与待办.md`、`docs/WorkBuddy开发交接.md`。产品代码、测试、云函数配置、入口、旧探针/凭据/env-gate 全部未动；Codex 四份审查/核验文档与全部历史证据原样保留。

**未验证项**：写入者覆盖未知（B0-8）；历史完整性未证明；占用完整性无法验证（`NOT_EXISTS`）；W-4 未确认；B 无管家维护路径不成立；平台与 SDK 限制全部未实测；索引需求未结论化；恢复载体与入口均未实现；`epoch` 缺失填值与递增归属待变更包；用例与草案均未执行。

**当前状态：写入、迁移、恢复 ready、部署、入口启用均未放行；B0 只读取证可继续；用户无需扫码、重新导出或手机操作。**

## 历史接续：D1/D2/D4 通过，D3 取证规范收尾与 B0 状态同步（2026-10-04）

> **本段为历史记录，保留未删改。其要求的 E1–E3 与干跑草案已在上一节完成；"下一步"以最新接续点为准。**


Codex 实际核对 875 行方案：D1、D2、D4 核心修订通过；D3 清单已恢复，但投影写入未落库 workingDays、遗漏起止日期及部分校验字段，项目级 201 哨兵/集合总数比较/成员首用范围仍需纠正。合并为 E1–E3 一次文档收尾，见 [正式复核](Codex复核-部署前准备D1-D4收尾-20261004.md)。87 个已验收实现/配置/测试文件哈希不变，入口关闭且冻结；53 项设计编号完整；未重复执行测试，本轮未调用云端。

后续 B0 已取得 A/B/C 项目、8 名成员、4 个账号及 primary 主管理员记录，不能再把旧“真实 ID 未回读/记录全未知”当成当前状态。B 无管家；安排五集合当时 NOT_EXISTS；历史完整性与写入者约束等仍未知，整体 B0 未闭合。

**下一步：WorkBuddy 一次修订 E1–E3，并按已有真实记录编制最小干跑变更包草案（未运行），标清 B 无管家、共享部署影响及未满足门槛。** 只改文档，继续 M-b，不补字段、不改代码、不创建资源、不迁移、不恢复、不部署。无需用户手机操作。下方历史进度保留，当前结论以上述及所链接复核为准。


## 最新接续：CloudBase 记录读取已实测成功，A/B/C 记录核对完成（2026-10-03）

用户提供的两份导出已解析，3个项目、8名成员与本轮云端最小字段投影一致；8个确定性成员ID、负责人/主业主关系核对通过。四个用户账号启用，primary主管理员仍为2d3aa4。三项目均缺施工安排三字段，八成员均缺两锚点；安排五集合当前NOT_EXISTS。现存53条相关审计未发现投影中的非零代际，但不证明历史无删除或旁路写入。

见[记录核验结果](Codex-B0记录级核验结果-20261003.md)及[证据](证据/施工安排B0记录级核验-20261003.json)。**B没有管家，不能照搬A/C的管家维护入口。** B0仍未整体闭合：历史完整性、写入者约束、最终索引适配和平台实测保留未知。

**下一步：基于真实记录整理最小干跑变更包草案，显式标明B无管家路径和历史证明门槛；继续M-b，不执行任何补值、迁移、恢复或部署。** 本轮全部云端只读，用户无需再导出或手机操作。

## 最新接续：CloudBase 连接正常，记录只读工具已补齐配置、待重载（2026-10-03）

按用户本轮接入要求完成官方说明核对。现有登录可查询目标环境；无需重复安装。此前会话缺少记录读取工具的原因是 Codex MCP 白名单未列入 readNoSqlDatabaseContent，现已仅增加此官方只读工具，原配置本机备份，其余设置不变，未开放写入/部署工具。

见[接入核验](CloudBase接入核验与只读工具补齐-20261003.md)。**下一步：重新加载/重启 Codex 后回本对话继续 B0，先验证新工具再读取 A/B/C 最小字段；暂不要求用户手工导出。** 配置落盘不等于记录读取通过；B0 仍为部分观测。本轮未写云端、未部署、未启用业务入口。

## 最新接续：部署前准备方案 D1–D4 定点文档收尾完成，交 Codex 核对（2026-10-03）

已按[Codex 二次复审](Codex二次复审-施工安排部署前准备-20261003.md)完成 D1–D4，修订[部署前准备方案](WorkBuddy方案-施工安排部署前准备-20261003.md)（690 → 875 行）。**本轮只改方案、设计用例说明及进展/交接记录；未改产品代码或测试、未执行 S/R/B0 任一步骤、未实施迁移、未补字段、未改维护状态、未新增或部署运维函数、未操作云端、未安装、未创建资源、未启用入口、未预览/部署/发布。** 入口保持 `enabled=false`、`allowedProjectIds=[]`、顶层与嵌套冻结。**七项技术裁决全部不变，未提交任何选项组。**

### D1（P1）业务查询路由不是零写入口
已核对实现：`execute`（`service.js:134`）除 `checkTransaction` 特例外一律先调 `identity`（`:143`）；`identity`（`:72`）首次见到账号时写 `users` 并追加 `registerIdentity` 审计（`:83`）；`requestBindingNumber`（`:147`）写 `users` 与审计（`:155`）。
- §1.3 逐路由表把"是否递增 epoch"与"是否无写入"**分成两列**；标注"查询主体只读 ≠ 入口零写"，并说明该副作用属**公共前置逻辑**、旧部署同样存在。
- §9.6.2 规定 **B0 一律用受控管理端数据库只读查询**，**不调用这些路由取身份或数据、不为核对取号**。
- 账号状态与主管理员资格**必须重验**；证书涉及 active 安排责任账号有效性时，**不得仅因 `users` 未入摘要就忽略账号状态稳定性**。
- 本轮未调用上述路由，**不存在本轮取证已产生注册写入的问题**。

### D2（P2）删除新旧部署混淆
- §2.2 改为"当前不执行补缺：云端旧部署未建立新围栏，且具体变更包尚未批准。旧部署可用性不能由本地新代码的缺字段校验推断"。
- §3.1 改为"多次 epoch 相等**只观测采样值未变**"；只有已证明全部相关写入遵守同一围栏单调递增且无旁路回写时，才支持"期间无相关提交"。M-b 下两前提均不成立，**任何 epoch 采样只能记为观测值，不作排空证据**。

### D3（P2）恢复可定位的完整 S/R/B0 清单
原稿只写"沿用上稿"却继续引用 R-6 / R-1…R-12 / S-5 而无对应表，§9.7 状态表也不能替代执行规范。本轮**在同一方案内**恢复三张完整表：
- **§6.2 S-1…S-7**（范围/查询参数/输出/停止条件）：项目三字段分类、成员全量枚举、项目级 active 安排枚举、责任成员并集与孤立检出、占用桶全量枚举、guard 全量枚举、锚点目录配对与容量。页大小 100、`_id` 升序 + `skip`，与 `scanActiveSchedules`（`schedule-service.js:283`）同参。
- **§6.7 R-1…R-12**（逐项输入与失败条件）：**R-12 用本稿成员分流，不恢复"所有成员必须 active 师傅"**；R-6 明确合法 `FIRST_USE` 分支通过（`generation=0` + 无 guard + 扫描 `EMPTY`），不再要求 guard 必须存在；上游 `INCOMPLETE`/`ERROR` 时该 R 判为**无法结论**、按阻断处理，**不得因没查到问题而通过**。
- **§9.6 B0-0…B0-8**：B0-0 目标标识（**必须先回读登记 A/B/C 真实 `projectId`**，禁项目名代替/预填）、9.6.2 只读调用方式、9.6.3 集合与字段白名单、9.6.4 敏感字段剔除（含 `REDACTION_VIOLATION`）、9.6.5 步骤表、9.6.6 分页与结束条件、9.6.7 证据输出规范。
- **孤立 guard 必须双向枚举**（S-6）：只遍历成员各读一次 guard 会遗漏无成员记录的孤立目录。
- **编号混用修正**：**B0-4 = 集合存在性**、**B0-8 = 写入者清单**（原稿 §3.2 把写入者清单写成"B0 第 4 项"）。

### D4（P2/P3）歧义与勘误
① §5.2 补 `epoch=0`：`schedule-service.js:636` 为 `isNonNegativeInt`、`service.js:52` 只拒绝负数 → **已有合法 0 不当作缺失、不擅自改成 1**；缺失填值与递增归属**放入 B0 后变更包，本轮不预设不执行**；"不把正整数改回 0"保留；§5.3 A-2 触发条件收紧为"**字段不存在**"。
② §6.5 拆分"不满足时"：**角色缺失/已 left/停用且无 active 引用 → 不阻断**；**锚点/目录一致性失败 → 仍阻断恢复**。
③ §8.4 明确**成功回执重试分支**：先核验身份权限 → 再识别同轮次同输入已提交结果 → 返回原结果，**不要求 `maintenance`/证书未消费/旧 epoch**；首次恢复才走全部 8 项前置；**必须先判分支①**。`MX-5` 改述"拒绝二次执行或消费"，与 `MX-6` 不矛盾。
④ §11.6 标题"7 项"改"**10 项**"；"全部在内存合成数据上运行"改"**拟**在内存合成数据上运行，**尚未执行**"。
⑤ §7.2 写明 **`monthOf(date)` 必须等于桶 `month`**、**非空 holder 先判类型再判归属**，**空桶豁免不放宽错月/非字符串 holder/无效结构**。

### 用例与校验
**仍为 53 项，本轮未增未删**；仅 `MR-2`/`MR-3`/`MR-5`/`MX-5`/`MX-6` 表述收紧，`MO-3`/`MO-7`/`MO-8` 各追加一条 D4-5 子情形（不新增编号）。脚本校验：53 个唯一编号、S-1…S-7、R-1…R-12、B0-0…B0-8 **连续无缺、无乱码**。**全部仍为设计，未执行。**

**改动文件**：`docs/WorkBuddy方案-施工安排部署前准备-20261003.md`、`docs/进展与待办.md`、`docs/WorkBuddy开发交接.md`。产品代码、测试、云函数配置、入口、旧探针/凭据/env-gate 全部未动；Codex 三份审查文档与全部历史证据原样保留。

**未验证项**：A/B/C 记录级数据形态未知；**目标 A/B/C 真实 `projectId` 未回读登记**；B0 仍 `PARTIAL_OBSERVATION` / `complete=false`；是否有不遵守 epoch 的写入者未知（B0-8 未完成）；W-4 未确认；平台与 SDK 限制全部未实测；索引需求未结论化；恢复载体与入口均未实现，证书最终事务操作序列待 B0 后最小方案；`epoch` 缺失填值与递增归属待变更包；**53 项用例与 S/R/B0 三张清单均未被任何工具实现或运行**。

**当前状态：写入、迁移、恢复 ready、部署均未放行；B0 只读取证可继续；用户无需手机操作。**

## 最新接续：B0 记录级通道受限，查询形状与最小取证清单已整理（2026-10-03）

本轮未取得新的云端业务记录：历史 cloud_db_read_doc 工具当前不可用；现有 CloudBase 入口只有元数据读取；浏览器状态工具启动失败，未重复尝试。未安装、未读取/复制认证密钥、未调用业务云函数、未写云端。现有 B0 仍为部分观测。

已完成本地真实查询形状对照：历史排序为 afterVersion；回执使用确定性主键；安排列表含四种筛选组合。索引平台适配仍待核验。见[记录级取证接续](Codex-B0记录级取证接续-20261003.md)。

**下一步：通过已登录桌面控制台先提供 A/B/C 的 projects、project_members 两份 JSON，只读导出，不导入、不编辑。** Codex 收到后完成项目字段与成员锚点分类，再按最小字段核对 users/app_admins。用户无需手机操作，不提供密钥或绑定编号。

## 最新接续：部署前准备二次复审，技术方向接受、定点文档收尾与 B0 并行（2026-10-03）

Codex 已读取二次修订稿；与 V1–V3 验收比较的 87 个文件（含 18 个测试文件）哈希全部一致，入口继续关闭、允许列表为空且冻结。53 个设计用例编号核对无误；本轮不重复运行未改变的测试，394 项通过引用既有验收。

schema/epoch 独立分类、成员按 active 安排引用分流、合法空月桶、可信有界证书四项主要方向接受。仍需 D1–D4 定点收尾：身份查询前置可能注册写入，不能当 B0 零写入口；M-b 中残留的新旧部署混淆；S/R/B0 完整定义被“沿用上稿”替代；epoch=0、无任务成员目录损坏、成功恢复回执重试等分支和少量标题歧义。见[二次复审](Codex二次复审-施工安排部署前准备-20261003.md)与[核验记录](证据/施工安排部署前准备二次复审-20261003.json)。

**下一步：WorkBuddy 仅按 D1–D4 收尾文档；Codex 继续 B0 记录级管理端只读取证，两者不互相等待。** B0 仍为部分观测，本轮未重新操作云端；数据齐备后才形成具体干跑变更包。不改产品实现、不新增资源、不迁移、不恢复 ready、不启用入口、不部署，用户无需手机操作。

## 最新接续：部署前准备设计需修订，B0只读取证可独立推进（2026-10-03）

Codex完成本地设计审查，代码/测试指纹与V1–V3验收一致，不重复跑未变化测试。本地验收保持通过。设计存在旧部署/新代码混淆、首用initDir误用导致代际下降、按“已存在”跳过损坏、全量发现和恢复事务预算不足、B0及部署前置循环、写范围与授权表述矛盾。见[裁决S1–S5](Codex裁决-施工安排部署前准备方案-20261003.md)与[本轮证据](证据/施工安排部署前准备方案审查-20261003.json)。

已裁定：无锚点选先扫描的策略乙；F3/F4/F6只识别和停止，是否维修待B0事实；恢复需可信管理员与有界核验证据；暂不新增部署运维云函数。A/B/C“已永久不可写”没有事实依据，旧包不识别新维护字段，不能用新代码推断当前云端行为。

**下一步：WorkBuddy仅按S1–S5修订设计与B0取证规范；Codex可沿用已有授权进行当前云端只读B0。** 先有事实和干跑再确定最小写入包及新增授权，不默认实施通用维修系统。当前不改业务实现、不安装、不写云端、不启用入口、不预览/部署；用户无需手机操作。

## 最新接续：V1–V3 核心本地验收通过，进入部署前准备（2026-10-03）

Codex 独立394项全部通过（已有SDK、0跳过），JS/JSON/8路由及真实8 WXML/9 WXSS编译通过。代码指纹确认本轮仅 schedule-service.test.cjs 变化，产品实现、旧探针/凭据/env-gate和禁用入口未变。V1屏障与4/4指定变异检出、V2真实维护四种交错、V3预算注入零写与重入计数均通过；本地收尾关闭，不重做T1/T2/T5。

保留少量非阻断注释和冗余断言清理，不能宣称“回归无任何缺口”。见[本地验收](Codex验收-施工安排事务兼容V1-V3收尾-20261003.md)与[证据](证据/施工安排事务兼容V1-V3验收-20261003.json)。SDK用例仍是离线入口检查，真实云端行为尚未验证。

**下一步：WorkBuddy先提交旧A/B/C兼容、维护修复与恢复ready的部署前准备方案；只写方案，不执行迁移或改业务实现。** Codex审查后安排后续本地工具与云端只读核验；已有隔离方案授权保留，新增A/B/C写入影响须单列。当前不启用入口、不安装、不操作云端、不预览/部署，用户无需手机操作。

## 最新接续：U1–U3 实现已修，转 V1–V3 测试及文档收尾（2026-10-03）

Codex 独立386项全部通过（已有SDK、0跳过），真实8 WXML/9 WXSS编译通过。实际写事务回执复核、维护权限及ready封闭、每attempt计数已验证；26桶峰值75。相对上轮仅3个交付代码/测试文件变化，入口保持禁用、空列表、冻结，历史证据未覆盖。

正式回归仍有三项缺口：U1a–d停在快速回执事务提交前，删除实际写回执检查仍能通过；U2d–f未覆盖批准/指定与真实维护路由双向交错；U3d未实际断言超限业务路径零写入。Codex另做正确屏障、真实四种交错及预算注入，所查实现均通过。见[本轮复核及V1–V3](Codex复核-施工安排事务兼容U1-U3收尾-20261003.md)与[证据](证据/施工安排事务兼容U1-U3收尾复核-20261003.json)。

**下一步：WorkBuddy只补正式测试和准确文档，不重改产品实现，不重做T1/T2/T5。** 完成后交Codex核对；云端准备门槛仍保留，当前不部署。用户无需扫码、取号或手机操作。

## 最新接续：T1–T7原反例通过，仍需U1–U3并发收尾（2026-10-03）

独立369项通过（已有SDK、0跳过），真实8 WXML/9 WXSS编译通过；相对上轮仅3个交付代码/测试文件变化。原11条反例均已修好，26桶峰值74，首用移出保护与跨月改期通过；入口保持禁用、空列表、冻结，原证据未覆盖。

补充复现发现：独立回执事务之后实际写事务不再查回执，同号并发后请求误报业务失败；维护切换事务不重新鉴权且可无就绪核验恢复ready；计数器在同服务实例内共享、交错尝试可超80，预算预检低估且边界测试只测夹具。见[U1–U3复核清单](Codex复核-施工安排事务兼容T1-T7返修-20261003.md)及[本轮证据](证据/施工安排事务兼容T1-T7返修复核-20261003.json)。

**下一步：WorkBuddy只完成U1–U3本地收尾并补针对性测试，交Codex再次复核。** T1/T2/T5已查路径不要求重做；首次竞争补入正式回归。旧项目缺字段还会阻止批准成员/指定管家，部署前兼容准备须覆盖这两项。本轮不操作云端、不安装、不启用入口、不预览/部署，用户无需手机操作。

## 最新接续：事务兼容本地复查未通过，转 T1–T7 返修（2026-10-03）

Codex 独立全量350项通过（已有SDK，0跳过），JS/JSON/8路由及真实8 WXML/9 WXSS编译通过；七个代码/测试文件变化与交付一致，入口仍禁用、空列表、冻结。但独立反例检出：首用跳过扫描可移出有安排成员、跨月改期误拒、26桶超预算、维护成员入口绕过、混合快照提前报错、回执顺序不完整、测试弱断言。现有通过数不等于兼容实施验收通过。

详见[审查及T1–T7任务](Codex复查-施工安排事务兼容本地实施-20261003.md)和[离线证据](证据/施工安排事务兼容实施复查-20261003.json)。本轮Codex仅记录审查，未改产品代码、未访问或修改云端。已有SDK用例只覆盖checkTransaction入口，不证明新施工写路由平台行为。

**下一步：WorkBuddy按T1–T7本地返修后交Codex复查；用户无需扫码、取号或手机操作。** 云端部署继续暂停；旧A/B/C准备/兼容方案、维护修复、SDK写请求与重试、超时及索引回读仍属后续放行前事项，沿用既有方案授权，不扩大资源或发布范围。

## 最新接续：事务兼容修订稿六项裁决明确，转本地实施（2026-10-03）

已裁定锚点放project_members且guard配对代际；最多两轮扫描；每尝试80操作；项目文档维护模式+schema+epoch与业务写共用冲突点；容量200为隔离测试技术保护；最终索引由Codex部署前回读。

修订稿不能原样实现：扫描须先判围栏过期后判数据不一致；维护标志只读不足以阻断在途事务；预算算式有误；补幂等回放优先、首用/恢复代际、容量扫描完整性等约束。详见[本地实施裁决与验收要求](Codex实施裁决-施工安排事务兼容修订稿-20261003.md)。无需重复讨论同一组参数，WorkBuddy同步修正文档后实施和测试。

**下一步：WorkBuddy依裁决完成本地兼容实现后交Codex复查。** 不操作云端、不安装、不启用入口、不预览/部署。未就绪A/B/C将受服务端模式限制的部署影响须另行核对，当前不修改其云记录。用户无需扫码取号；原云端方案授权保留，兼容验收前不部署。

## 最新接续：事务兼容方案六项裁决已给出，目录设计需修订（2026-10-03）

Codex 已读 WorkBuddy 设计。月度分桶接受；200 条限为隔离试验技术保护，非永久业务上限；事务每次尝试应用预算80/平台夹具100。云端3秒未证明可用，本轮不改，10秒作为部署配置评估项。

阻断：initialized 与目录同存，无法区分首次缺失/被删除；count=ids.length不能证明与实际安排一致，不能替代原 GUARD_INCONSISTENT 放行检查。要求独立持久初始化锚点、完整迁移/重入语义及事务外真实扫描+版本围栏的并发证明（或等价方案），防简单搬出 where 丢失保护。

见[六项裁决与设计修订要求](Codex裁决-施工安排事务兼容设计-20261003.md)。**下一步：WorkBuddy 只修订现有设计稿与记录，Codex 再审后下实施任务。** 本轮未改产品代码、云配置或入口，用户无需手机操作。云端方案授权继续保留，兼容阻断未闭合前不部署。

## 最新接续：云端方案已获确认，前置核验发现事务兼容阻断（2026-10-03）

用户已回复“确认按方案执行”，授权保留。Codex 只读核实目标 AppID/环境一致、环境 NORMAL、memberAccess Active/Available；旧部署包已下载至本机 CodexBackups，SHA-256 与云端一致；保存当前配置。五个新增集合不存在，尚未创建。

官方事务文档明确不支持 where、最多 100 操作/30 秒；现有 hasActiveSchedules/rebuildGuardCount 在事务内分页 where，365 天占用也超操作预算。当前函数超时为 3 秒。SDK 暴露方法不等于后台支持；本轮未在云端复现错误或执行任何业务写入。既有 295 项本地回归通过仍有效，但不能作为平台兼容通过。

按已确认方案停止于部署前。未创建集合/索引/D项目、未修改权限、未启用入口、未部署或生成预览；未安装。当前已保存函数包，不代表做过恢复演练。传统套餐剩余配额、旧规则/索引及 A/B/C 数据基线尚需补核，资源点接口的零值不视为实际零用量。

见[前置证据](证据/施工安排云端前置核验-20261003.json)。**下一步：将[WorkBuddy 事务兼容设计任务](WorkBuddy任务-施工安排事务兼容设计-20261003.md)交给 WorkBuddy，先形成具体设计与预算，Codex 审查后再实现；用户无需扫码/取号。** 不重复确认原云端方案；范围变化另行列明。

## 最新接续：施工安排云端测试方案已形成，待确认执行（2026-10-03）

Codex 按已验收代码形成[隔离云端测试方案](施工安排第二单元云端测试方案-20261003.md)：沿用目标环境，新增五集合及匹配查询的索引，更新共享 memberAccess，另建虚构 D 项目，沿用四账号；先基础流程后专项并发/权限。已明确客户端白名单不等于服务端隔离，旧移出接口受影响，发生新安排后不能无条件回退旧函数。

本轮只读本地资料并编写方案，未读取当前云端、未创建集合/项目/成员、未启用入口、未安装/预览/部署/发布。索引平台支持、事务限制、当前包与数据状态均须执行前核验。

**下一步：用户确认具体方案后，Codex 先做云端只读基线和旧包恢复核对，再进入资源准备。当前无需 WorkBuddy 改代码，也无需手机操作或获取编号。** 下方本地通过结论保持有效。

## 最新接续：施工安排第二单元本地收尾通过（2026-10-03）

Codex 已核对四项收尾：双向提交顺序回归、七集合全快照回滚及恰好一次、实际客户端与表单恢复测试、报告来源修正，均通过。上一轮 H1–H3 剩余项关闭，H4/H5 保持通过。

独立全量 295 项通过、0 失败、0 跳过（使用已有 SDK）；JS/JSON、8 路由、真实 8 WXML/9 WXSS 编译及 diff 空白检查通过。相对上一轮代码指纹仅三个施工安排测试文件变化；入口保持禁用、空项目列表和嵌套冻结。

详见[本地收尾验收](Codex验收-施工安排第二单元本地收尾-20261003.md)及[证据](证据/施工安排第二单元本地收尾复核-20261003.json)。本地验收通过不等于真实云端事务或手机验收通过。

**下一步：Codex 准备隔离云端测试具体方案，列资源/索引/权限、函数影响、测试项目、备份回退和证据要求，确认方案后再执行。当前无需 WorkBuddy 继续改业务代码，用户无需扫码或手机操作。** 本轮未操作云端、安装、预览、部署或发布。以下旧记录保留为历史，以本节为最新状态。

## 最新接续：H1–H3 复查完成，限定测试与文档收尾（2026-10-03）

Codex 独立全量 258 项通过、无跳过；JS/JSON、8 路由、真实 8 WXML/9 WXSS 通过。入口禁用/空允许列表/冻结，旧探针凭据env-gate及项目配置指纹保持。

H1/H2 指定故障场景已独立验证修复；H4/H5 保持。H3 已有实际路由交错；Codex 另补“移出先提交”的创建/改派反向场景，均拒绝且无 left 师傅承担 active 安排。仍须把这些场景纳入常规回归，补全相关集合快照回滚与重试审计恰好一次断言。

报告声称的部分网络/畸形响应/空原因及本机空内容恢复测试未在测试文件找到；功能修复已由 Codex 独立补验，须补正式回归并纠正验证来源。跳过项实际为缺 SDK 路径的真实 SDK 测试，本轮 Codex 指定已有路径后通过，非占位测试。

见[H1–H3 复查结论与测试收尾要求](Codex复查-施工安排第二单元H1-H3-20261003.md)、[独立证据](证据/施工安排第二单元H1-H3复查-20261003.json)。

**唯一下一步：WorkBuddy 仅补测试、断言和准确文档，保持已验证业务实现。整体本地验收尚未关闭。用户无需扫码或手机操作；不安装、不操作云端、不预览/部署/发布。** Codex 仅审查和记录。

## 最新接续：H1–H5 已复查，H4/H5 关闭，剩余 H1/H2/H3（2026-10-03）

Codex 独立全量 251 项通过、无跳过；JS/JSON、8 路由、真实 8 WXML/9 WXSS 编译通过。入口关闭、允许列表为空且冻结；旧探针/凭据/env-gate 和项目配置指纹不变。

已确认本机详情调整保存正常、已有错计数在实际移出路由被拒绝（H4/H5）；云端新增业务错误后纠正可保存。不带 code 的网络丢响应后原号重试只产生一份安排。

仍复现：真实客户端将带 TIMEOUT code 的异常先判 validation，服务端已成功但丢响应后可编辑重提产生两份；畸形响应误判业务失败/成功；取消空原因及本机空内容出错后无法恢复。并发夹具新增但只交错 helper，实际移出路由仍为顺序测试，完整回滚证据待补。

详见[Codex H1–H5 复查](Codex复查-施工安排第二单元H1-H5-20261003.md)、[独立证据](证据/施工安排第二单元H1-H5复查-20261003.json)。WorkBuddy 本轮完成报告保留为交付来源，不能替代审查结论。

**唯一下一步：WorkBuddy 限定修 H1/H2/H3，H4/H5 保持回归。用户无需扫码或手机操作；不安装、不操作云端、不预览/部署/发布。** Codex 本轮仅审查与证据/进展记录，未改产品实现。

## 最新接续：G1–G6 复查完成，仍需 H1–H5 本地返修（2026-10-03）

Codex 独立全量 237 项通过、无跳过；JS/JSON、8 路由及真实 8 WXML/9 WXSS 编译通过。超百条缺 guard 重建、历史游标、完整师傅名单、取消后日期查询已复现确认修复。入口关闭、允许列表为空、冻结及旧探针/凭据/env-gate 指纹通过。

仍独立复现：“我已核对”无读取直接清除未知结果后可创建两份安排；响应异常误判失败；修改业务错误后保存仍锁定。另有本机编辑按钮被误隐藏、已有不一致零计数放行移出，以及并发交错/事务重试/完整回滚证据缺口。人工注入的计数异常不能描述成云端已发生故障。

详见[H1–H5 复查要求](WorkBuddy复查-施工安排第二单元G1-G6-20261003.md)、[独立证据](证据/施工安排第二单元G1-G6复查-20261003.json)。此前“G1–G6 完成”为 WorkBuddy 交付声明，不能替代本轮审查结论。

**唯一下一步：WorkBuddy 限定本地修 H1–H5，交逐项验证后由 Codex 复查。用户无需扫码或手机操作；不安装、不操作云端、不预览/部署/发布。** Codex 本轮仅记录审查与证据，未修改产品实现。

## 最新接续：F1–F7 复查仍需收尾，交 WorkBuddy 修 G1–G6（2026-10-03）

Codex 独立运行 224 项全部通过、无跳过；语法/8 路由通过。实际 wcc 发现 project.wxml 第24行新引号错误，WXSS 未执行到。列表/历史扁平响应、两份安排缺 guard 后保护、事务内停用账号拒绝已离线确认改善。

仍复现保护计数重建超过100条少算并放行移出、历史游标跳项、师傅名单截断、取消安排无法从按日列表找到、未知成功结果后编辑重试创建两份安排；并发交错/冲突重试/失败回滚测试仍需补。见[限定收尾清单 G1–G6](WorkBuddy复查-施工安排第二单元F1-F7-20261003.md)、[独立证据](证据/施工安排第二单元F1-F7复查-20261003.json)。入口关闭/空允许列表/冻结及旧探针凭据env-gate指纹通过。

**唯一下一步：WorkBuddy 本地修 G1–G6 并交逐项验证，再由 Codex 复查。用户无需手机操作，不操作云端、不安装、不预览/部署/发布。** Codex 本轮仅审查和证据/文档记录，未修改产品实现。

## 最新接续：施工安排第二单元 R1–R8 复查仍需返修（2026-10-02）

Codex 独立复查：213 项测试全部通过、0 跳过；本机已有微信编译器完成 8 WXML/9 WXSS 编译，语法及 8 路由通过。**R1 模板、R3 更新补丁本地关闭；其余部分修复但不闭合。** 默认入口关闭、空允许列表及嵌套冻结通过，旧探针/凭据/env-gate 指纹不变。

独立离线复现 9 项问题：真实列表/历史路由多包一层导致页面 map 报错；缺 guard 后取消两份中的一份仍可移出有任务师傅；数据库分页截断；事务内执行人停用/回执失权复核缺失；取消重试换号；历史版本错标；云端列表丢失施工内容及只读身份仍显示编辑表单。另有模板数据来源说明、只读入口和阶段顺序等剩余缺口。

详见[复查返修 F1–F7](WorkBuddy复查-施工安排第二单元R1-R8-20261002.md)、[独立证据](证据/施工安排第二单元R1-R8复查-20261002.json)。额外发现 project.config、project.private.config、member-access.test 指纹变化，须补来源说明，不盲目回滚。

**唯一下一步：WorkBuddy 按复查文档继续本地返修，补真正的路由—页面契约、分页、交错重试及回滚测试后交 Codex。用户无需手机操作；不操作云端、不安装、不预览/部署/发布。** 本轮 Codex 仅审查与文档/证据记录，未修改产品实现。

## 最新接续：施工安排第二单元首轮审查需返修（2026-10-02）

Codex 独立核验：指定已有 wx-server-sdk 后，全量 190 项测试全部通过、无跳过；JS/JSON 与 8 路由通过。但实际 wcc 编译在 schedule-detail.wxml 第 12 行失败，WXSS 尚未执行到；另已离线复现 13 个问题。审查结论为**需返修，不进入真机或云端阶段**。

详见[首轮审查与 R1–R8 返修要求](WorkBuddy审查-施工安排第二单元本地实现-20261002.md)、[证据](证据/施工安排第二单元首轮审查-20261002.json)。核心问题涉及模板编译、云端页面依赖示例身份及降级本机保存、SDK 拒绝更新 _id、移出保护记录缺失放行、幂等重试、查询分页与占用释放、业务错误及身份核验、规则和历史展示。默认入口禁用/空允许列表及冻结通过，旧探针/凭据/env-gate 指纹保持。

**当前唯一下一步：WorkBuddy 按审查文档本地修复 R1–R8，完整自测与模板/样式编译后交 Codex 复查。用户无需扫码、取号或批准。** 保持入口关闭；不操作云端、不创建集合索引、不预览/部署/发布。Codex 本轮仅审查、离线复现及记录，没有修改业务实现。第一单元历史待补项不变。

## 最新接续：施工安排第二单元本地开发已获确认（2026-10-02）

用户明确回复“按这个方案”。已将同工种同实际施工日唯一安排、变更/改派/取消原因及版本历史、责任师傅有未取消安排须改派后移出等规则写入需求主文档第3节，并在技术方案7.6记录本地实施边界。

**当前下一步：用户把[WorkBuddy本地开发任务](WorkBuddy任务-施工安排第二单元本地实现-20261002.md)转交WorkBuddy。** WorkBuddy先写技术契约，再完成本地代码、页面、移出并发保护及离线自测，交Codex审查。开工75文件指纹已记录。新入口默认关闭、项目允许列表为空，两类已收尾并发配置继续禁用，其他旧验证配置保持不动。当前不操作云端、不预览/上传/部署、不安装或发布。用户此确认不表示云端部署获批；第一单元原待补项与证据限制继续保留。


## 最新接续：开始施工安排第二单元方案讨论（2026-10-02）

用户“开始下一步”，按上一轮所述方案讨论推进。Codex核对已确认需求、现有本机schedule页面及memberAccess移出接口，形成[第二单元范围与验收方案](施工安排第二单元方案-20261002.md)。推荐先做施工安排新增/调整/取消/只读查看/历史及责任师傅改派保护，进场反馈与影像另分批；同工种同日唯一安排等具体细节标为提案。

**当前下一步：用户确认该实施范围及具体规则后，Codex再交WorkBuddy本地实现任务；当前没有开工指令。** 本轮仅策划文档，无业务代码、云请求或部署。第一单元家庭成员真机与历史审计证据限制保留，不改为整体验收通过。


## 最新结论：不同主业主申请并发检查已闭合

Codex复查WorkBuddy收尾通过：enabled=false，动态执行字段全空，固定模板字段完整保留，15个对象/数组全部冻结（交付说明49个为计数差异），无独立十位原始编号；相对75文件审查指纹，仅目标配置变动。53项相关回归全部通过，无跳过，JS语法和git diff --check通过。见[收尾复查证据](证据/主业主并发配置收尾复查-20261001.json)。本轮Codex没有云请求；文件审查不能独立证明WorkBuddy历史上从未调用云端。

结合[云端事后核验](证据/不同主业主并发事后核验-20261001.json)及[用户手机访问核验](证据/不同主业主并发手机访问核验-20261001.json)，本次独立C项目一成功、一OWNER_EXISTS，唯一主业主及一次批准审计、甲可见C乙不可见C、临时配置收尾均已完成。保留云记录及手机防重标记，无需重复扫码或批准。

**第一单元仍不标整体验收：**纯家庭成员真机验证因暂无额外独立账号暂挂；早期有效成员移出拒绝的紧邻事前审计快照缺失保留为历史证据限制。两者均不能用本轮证据补造。临时入口版本隔离已本地验证，正式交付时仍需届时版本发布检查。

**下一步建议（待用户确认范围）：**先讨论下一业务单元“施工安排”的方案和验收标准，不直接派发代码或部署任务；家庭成员真机条件具备时再补。WorkBuddy本轮无需进一步修改。此建议不表示第一单元全部通过，也不授权下一单元实施。


## 最新接续：甲可见C、乙不可见C已人工确认，仅待本地配置收尾

用户本轮明确反馈“甲可见C，乙不可见C”，与前一轮云端唯一主业主状态一致。见[手机访问核验记录](证据/不同主业主并发手机访问核验-20261001.json)。此项来源为用户人工核验，不描述为Codex代操作或额外接口拒绝测试。Codex仅检查当前本地配置，仍enabled=true、动态凭据未清空；本轮没有云端操作。

**当前唯一下一步：WorkBuddy执行[主业主并发检查收尾任务](WorkBuddy任务-主业主并发检查收尾-20261001.md)，仅关闭临时配置并清空动态凭据，交Codex复查。** 用户无需再扫码、取号或批准，保留C云端状态与手机防重标记。真机结果、云端事后条件和手机项目可见性已核验，配置收尾完成后再确认本项闭合。


## 最新接续：主业主双申请真机并发云端事后核验通过，待访问核验与配置收尾

用户提交管家64193d真机报告：2026-10-01T12:58:50.423Z两请求同时发出，甲989a74成功、乙f182f4收到OWNER_EXISTS。Codex重新只读六集合全部选定记录，证实C v1→v2、成员2→3且甲为唯一主业主/v1、甲邀请v2→v3及编号消费；乙邀请requested/v2与编号保持；审计52→53仅新增`a_96fd3ea3b2ee4d1380ab25e9e6fa7f8a`一条approveInvitation，其他原有记录所选字段保持。见[事后核验证据](证据/不同主业主并发事后核验-20261001.json)。未执行任何云写入。

**下一步：989a74与f182f4分别用本人微信刷新项目列表，核对完整C ID `p_4e53f8437dab4ddcb62971d58455acaa`：甲可见C且角色主业主，乙无C访问权（乙在A的原主业主关系保留）。** 同时交WorkBuddy按[本地配置收尾任务](WorkBuddy任务-主业主并发检查收尾-20261001.md)仅禁用本轮配置并清空动态凭据，保留固定模板、全部冻结、云端状态与手机防重标记。Codex再复查收尾；不重复批准、不清缓存、不撤销乙申请。当前并发云端事后条件通过，手机访问和配置收尾尚未完成，不宣称第一单元全部验收。


## 最新接续：主业主并发配置映射复查通过，等待管家真机执行一次

Codex于2026-10-01北京时间20:53前后复核：配置与事前基线逐字段一致，15个对象/数组全部冻结，未发现独立十位原始编号；75个受检基线文件仅目标配置变化。使用已有真实SDK路径运行162项测试全部通过（0跳过）；语法与7路由、7 WXML/8 WXSS编译通过。只读重新采集六集合完整选定投影（users4/projects3/members7/invitations8/admins1/audit52），均与事前基线逐字段一致。C仍v1、无主业主、2成员、两份requested/v2申请，候选编号仍有效未消费。见[配置映射复查证据](证据/主业主并发配置映射复查-20261001.json)。

**下一步：用户在最新本地预览中，用管家64193d进入身份测试页并完成身份/事务就绪检查，在“不同主业主申请并发唯一性检查”卡片填甲989a74、乙f182f4各自已保留的编号，仅点击一次“检查主业主唯一性（各发送1次）”，复制报告交Codex。** C完整ID为`p_4e53f8437dab4ddcb62971d58455acaa`；共同截止北京时间2026-10-02 20:27:10.726。不要点击普通批准或旧“并发批准检查（发送2次）”，不要重复取号、申请或清防重标记。若报错或窗口过期，保留报告停止，勿重试。Codex本轮未批准、未生成预览、未部署。此结论仅为执行前复查通过，实际并发唯一性仍待真机及事后云端验收。


**2026-10-01当前：**C的两份主业主申请与两位本人新编号已准备，Codex完整只读基线就绪。执行[主业主并发配置映射任务](WorkBuddy任务-主业主并发配置映射-20261001.md)，只把证据的primaryOwnerConcurrencyConfiguration映射到新配置、保留冻结，交Codex复查；共同截止北京时间2026-10-02 20:27:10.726。不要批准、预览、部署、重取号或延长旧时间；不改探针/页面/测试/旧配置。下方“等待准备”均为历史。

**2026-10-01最新：**项目完整ID显示已通过Codex审查，29项相关页面测试与7 WXML/8 WXSS编译通过；仅模板/局部样式/相关测试变化，业务逻辑未变。当前由用户在新版预览按完整C项目ID指定管家，WorkBuddy暂停代码修改，保持并发配置禁用。之后仍需两份主业主申请和两位候选新编号，Codex新鲜基线后才下发配置映射任务，不能直接从任命管家跳到启用配置。

**2026-10-01当前下一步：**用户已创建C，Codex云端只读核实ID为 `p_4e53f8437dab4ddcb62971d58455acaa`，但页面三项同名。先完成[测试项目编号显示任务](WorkBuddy任务-测试项目编号可辨识-20261001.md)：只显示完整ID便于准确选中，不改云端或业务操作逻辑。审查后再安排管家任命；不重复创建C，暂不取号/批准/启用并发配置。

**2026-10-01最新结论：**不同主业主并发入口本地复查通过，R1～R4关闭，161项测试与编译通过。[最终审查结论](WorkBuddy审查-不同主业主申请并发唯一性-20261001.md)生效；WorkBuddy暂不继续改代码，保持默认禁用、空执行凭据，等待Codex在人工准备C项目/两份申请/新编号后提供新鲜基线和明确配置映射任务。不得提前启用、批准、部署或延长旧窗口；下一步由用户先用负责人创建一次独立C项目。以下返修要求为历史。

**2026-10-01最新返修复查：**不同主业主并发入口R1/R4已关闭，156项独立测试通过；R2/R3仍剩三处局部遗漏。当前仅执行[审查文档顶部最新补修要求](WorkBuddy审查-不同主业主申请并发唯一性-20261001.md)：严格trades数组、败方requestedAt快照对比、畸形候选安全报告。保持默认禁用、不操作云端，完成后交Codex复查；以下四项返修指令为上一轮历史。

**2026-10-01最新审查接续：**不同主业主并发入口已实现，但Codex发现R1～R4，见[本轮返修清单](WorkBuddy审查-不同主业主申请并发唯一性-20261001.md)。当前仅修新探针/配置及相关页面测试，默认禁用空执行凭据；暂不人工准备项目、不取号或批准。151项测试通过未覆盖真实接口返回与精确集合校验，必须按清单补契约回归后再审查。以下本地实现交接为历史。

2026-10-01当前接续：WorkBuddy已实际完成并发入口实现、返修和配置交付，Codex已完成本地审查及管家真机后的云端复核，本次仅生效一次。[并发配置关闭任务](WorkBuddy任务-并发批准检查收尾-20261001.md)已完成并经Codex复查通过；[临时测试入口版本隔离](WorkBuddy任务-临时测试入口版本隔离-20261001.md)及R1/R2返修也已通过Codex本地复查，随后用户已要求下一步：当前交WorkBuddy按[不同主业主申请并发唯一性任务](WorkBuddy任务-不同主业主申请并发唯一性-20261001.md)仅做默认禁用的本地实现；不执行云端准备或批准；无需重新取号、申请或真机批准。下方2026-09-30“待接手”是初次交接历史，不代表当前尚未接手；也不表示WorkBuddy已取得云工具权限。

更新日期：2026-09-30。**状态：用户已正式确认从当前步骤起切换分工，待 WorkBuddy 完成接手检查。** Codex 负责策划和审查，WorkBuddy 负责代码开发与自测；此前“仅为设想”的状态已被最新决定替代。尚未确认 WorkBuddy 已打开项目或连接工具，不能写成实际接手完成。

## 1. 打开同一份本地项目

- WorkBuddy 工作目录：`C:\Users\30591\Documents\ChatGPT\装修进度验收APP`。
- 微信开发者工具工程目录：上述目录下的 `miniapp`。
- WorkBuddy 必须能同时读取根目录规则、`docs` 和 `miniapp`，不要仅导入小程序子目录或上传一次性的文件副本。
- 交接时 Git 中存在已修改文件及未跟踪的新文件，其中包含身份云函数、页面、测试和验收证据。先查看 `git status --short` 并保留全部现有成果；仅重新克隆仓库或创建基于提交的独立工作目录，可能缺失这些文件。不要重置、清理或重新初始化项目。
- 同一个本地目录中的文件是双方共同资料；对话历史不会自动同步。读取文件也不等于已经检查当前云端状态。

## 2. 接手阅读顺序

1. 根目录 [AGENTS.md](../AGENTS.md)：协作和授权规则。
2. [进展与待办](进展与待办.md)：先读顶部最新接续点，旧的“当前下一步”按历史记录理解。
3. [需求与业务规则](需求与业务规则.md)：已确认的业务规则；讨论稿不能直接作为开发要求。
4. [miniapp/README.md](../miniapp/README.md)：工程入口、本机示例及验证方法。较早状态以最新验收记录纠正。
5. [第一单元验收清单](云端身份权限第一单元验收清单.md)：已验证与未覆盖事项。
6. [正式版数据与权限方案](正式版数据与权限方案.md) 第 7.5 节，以及 [实施记录](云端身份权限实施记录.md) 最新部分：当前开发范围与证据。

后续只按当前任务补读相关代码和证据，不每次重新加载全部历史。

## 3. 2026-09-30 接手快照

以下来自当日本地文档核对，不是本次重新运行测试或查询云端的结果。此快照不持续充当进度主表，后续以进展与验收清单为准。

- 已有微信原生小程序工程及本机虚构页面；施工安排、现场记录和影像仍属于本机示例，不能描述为多手机云端业务已经完成。
- `memberAccess` 已进入云端身份和项目成员权限第一单元真机验收。已有四个真实微信账号的多项人工结果、云端复核和本地测试证据，第一单元尚未整体验收。
- 最近通过项：主业主持有效编号指定管家被拒绝，前后已选云端字段一致、编号仍有效且未消费；无需重复执行。
- 最新接续点：专用有效待批准申请检查入口**已经完成并通过 Codex 审查**，不得重复制作。用户已申请未批准；管理端约北京时间 21:18 复核邀请 `i_0e0483488efb40ada6825d259ebc1736` 仍 requested／v2，申请人为 989a74，项目为 `p_38507fc9b43c4e23a7fbd996415637bb`。原编号当时仍有效且未消费，截止北京时间 2026-09-30 21:38:20；这不是接手时仍有效的保证。
- 代码入口：`miniapp/miniprogram/utils/valid-approval-probe.js`、`config/valid-approval-proof.js`、`pages/access/`；证据：[事前基线](证据/有效待批准申请事前基线-20260930.json)、[主项目审查](证据/有效待批准申请主项目审查-20260930.json)。目标 AppID `wxfb4db1615ac15531`，环境 `cloud1-d8gcq5ag39d847723`。项目 2／成员 5／邀请 6／审计 41 为事前选定投影基线，非持续或原子快照。
- 子项目记录全套 86 项本地测试通过；Codex 独立复跑相关 35 项及 7 WXML／8 WXSS 编译通过。尚无本轮手机报告，尚未批准该申请，第一单元不能整体验收。当前用户步骤为主业主 f182f4 使用新版预览，输入申请人的有效绑定编号，单次点击“检查主业主不能批准此申请”，复制“待申请检查结果”。必须在有效窗口内且事前核对仍有效；不能由管理端代发用户请求。
- 如果接手时编号已到期：保留现有申请，先报告需要师傅 989a74 获取新绑定编号；取得后按散列只读核对归属、状态及真实到期时间，再更新本地核验证据、配置和防重标识并做相称测试，交 Codex 审查。不得仅改时间绕过过期检查，不把原始编号或邀请码存入代码、文件、缓存或报告，不沿用过期报告作为新验证。若用户已经执行过或结果不确定，先核对报告及云端，禁止直接重置防重重跑。
- 尚缺有效待批准邀请相关越权验证、真实并发等验收项；纯家庭成员真机验证因暂无第 5 个独立微信而待补。详细范围以验收清单为准。
- 9 月 25 日“云端处理失败、暂停身份登记”为历史中断，不能再用作今天的接续点。

## 4. 日常分工与文件交接

- Codex：整理需求、明确任务范围与验收标准、检查开发结果；在 WorkBuddy 开发期间不同时修改业务代码。
- WorkBuddy：按任务实现代码、执行相称检查、记录结果与问题；不得自行改变已确认业务规则。
- 用户：决定新增业务或范围，完成需要本人微信账号和真机的操作。
- 同一时间只由一个执行者修改同一批文件。切换前保存修改、完成进展记录并结束相关写入任务；文档也避免双方同时编辑。
- 每个开发任务开始时，先核对进展顶部和现有文件改动，说明本轮范围；结束时更新进展顶部唯一的最新接续点。历史记录保留，过期的“当前”说明应明确视为历史。
- WorkBuddy 每轮记录：做了什么、修改文件、实际执行的检查及结果、未通过或未验证项、下一步由谁操作及预期结果。用户人工核验须注明来源。
- 身份权限第一单元的结果同步更新原验收清单和必要实施记录；其余事项不另建完整需求或独立进度副本。
- WorkBuddy 完成后，用户在 Codex 告知“WorkBuddy 已完成，请读取项目进展并检查本轮改动”；Codex 根据文件和证据核查，不能仅凭一句“完成了”确认通过。

## 5. 工具、授权与首次接手

- Codex 的 Skill、MCP 连接、云端登录和软件配置不会因为共享文件夹而自动转移到 WorkBuddy。先检查它实际能用的本地工具与云端只读能力，缺失时说明具体缺口；不导出或复制登录令牌、密钥等凭据。
- 接续已批准的第一单元沿用原范围和门槛。本次更换开发助手不额外授权新业务云端实现、付费、扩大权限或正式发布。
- 首次任务先完成只读接手检查：报告实际工作目录、当前阶段、最新接续点、未提交改动是否保留、工具可用性及当前凭据是否仍有效。申请已有事前证据，不要求用户重复邀请；不要直接发送批准、指定、移出等业务请求。
- 现有云环境、集合、索引与账号流程不要重复初始化。部署、云端写入和真机检查必须遵循原方案的目标、范围和证据要求。
- 遇到工具或核验问题，保留一次完整错误及实际结果，给出明确的下一步，避免相同失败路径循环重试。

## 5.1 施工安排事务兼容设计轮次记录（2026-10-03）

- 做了什么：按任务提交**设计稿**（未改业务代码），处理 P1 事务内 `where` 不被官方支持、P2 365 天逐日占用超单事务 100 操作预算、3 秒超时影响、平台限制夹具测试设计。
- 修改文件：仅 `docs/WorkBuddy方案-施工安排事务兼容-20261003.md`（新增）、`docs/进展与待办.md`（顶部接续点）、本文件。业务代码、云函数配置、测试文件均未改动。
- 实际执行的检查：逐行核对 `schedule-service.js` 714 行与 `service.js` 342 行，确认事务内 `where` 仅 `rebuildGuardCount`（:87）与 `hasActiveSchedules`（:112）两处，占用读写本已是 `doc()`；按实际调用序列算出各 action 最坏操作数；校验方案文档 320 行无乱码、章节齐全。
- 未通过或未验证项：**未实测云端事务行为**；**未实测 3 秒超时下实际耗时**；操作预算为静态推算而非运行时计数验证；月度分桶的桶大小（估约 2 KB）未在真实平台核对；未安装 wx-server-sdk，实际 SDK 用例仍 1 跳过。
- 下一步由谁操作：Codex 审查设计稿并裁决第 8 节 6 个决策点；确认后 WorkBuddy 再按明确任务实施（先改夹具与测试，再改实现）。用户无需手机操作。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源。

## 5.2 事务兼容设计修订轮次记录（2026-10-03，Codex 裁决后）

- 做了什么：按 Codex 裁决修订兼容设计稿，闭合两项阻断（独立初始化锚点、实际扫描 + 版本围栏），修正 8 处报告事实错误，重算逐动作预算，补齐测试清单。**未改业务代码。**
- 修改文件：仅 `docs/WorkBuddy方案-施工安排事务兼容-20261003.md`（重写为修订稿）、`docs/进展与待办.md`（顶部接续点）、本文件。
- 实际执行的检查：核实 `listSchedules` 查询条件（`:236`/`:243`，确认**不按 `workerUserId` 过滤**，初稿表述有误）；核实 `approveInvitation` 的 `add`/`update` 双分支（`service.js:268`/`:269`）与成员 ID 稳定性；核实 `MAX_RANGE_DAYS`/`TRADES`/`length<100` 三处约束；用脚本实算月度桶 UTF-8 字节（ASCII 1869 B / CJK 2265 B）替换初稿"约 2 KB"估算；校验修订稿章节齐全、无乱码。
- 未通过或未验证项：**仍未实测云端事务行为**；**仍未实测 3 秒超时耗时**，且已按裁决删除无测量依据的延迟数值；桶文档大小真实平台限制未核对；`fenceVersion` 递增义务尚未在代码中落实；未安装 wx-server-sdk，实际 SDK 用例仍 1 跳过。
- 下一步由谁操作：Codex 复查两项阻断是否闭合并裁决 6 个决策点；通过后 WorkBuddy 按明确实现任务先改夹具与测试、再改实现。用户无需手机操作。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源、未变更超时。

## 5.3 事务兼容本地实施轮次记录（2026-10-03，Codex 实施裁决后）

- 做了什么：按 Codex 实施裁决完成本地兼容实现——锚点代际与目录状态机、事务外扫描+持久围栏、月度桶、每次 attempt 80 次预算、项目级维护写冲突、幂等优先、容量与字节保护；同步补齐裁决 §5 的 9 类必测项。
- 修改文件：`miniapp/cloudfunctions/memberAccess/schedule-service.js`、`service.js`、`miniapp/miniprogram/utils/schedule-client.js`、`miniapp/tests/schedule-service.test.cjs`、`schedule-client.test.cjs`、`member-access-schedule.test.cjs`、`member-access.test.cjs`；文档 `docs/WorkBuddy方案-施工安排事务兼容-20261003.md`（改为已实施并追加 §12）、`docs/进展与待办.md`、本文件。
- 实际执行的检查：`node --test --test-reporter=spec miniapp/tests/*.test.cjs` → 350 项（349 通过、1 跳过、0 失败）；JS/JSON 逐文件 `node --check`/`JSON.parse`；8 页面路由存在性；`project.config.json` 根目录；`git diff --check`；入口 `enabled=false`/`allowedProjectIds=[]` 仍冻结。
- 未通过或未验证项：未实测云端事务行为；未实测 3 秒超时耗时；桶大小与目录 32 KiB 上限未在真实平台核对；未安装 wx-server-sdk（实际 SDK 用例 1 跳过）；维护修复脚本未实现；`projects` 字段缺失会阻止旧项目移出（兼容拒绝，A/B/C 需部署前方案）。
- 下一步由谁操作：Codex 复查实现与证据，重点核对必测项覆盖与 `compat 7b` 26 桶最坏路径的实际处理；必要时给出下一轮实现任务。用户无需手机操作。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源、未变更超时。

## 5.4 事务兼容 T1–T7 返修轮次记录（2026-10-03，Codex 复查后）

- 做了什么：按 Codex 复查结论完成 T1–T7 本地返修——首用真实扫描、完整桶键并集、产品侧 80 次双层保护、维护期成员写入口守卫、采集期版本稳定性与重扫、回执优先外层；同步把弱断言测试改为确定性期望。
- 修改文件：`miniapp/cloudfunctions/memberAccess/schedule-service.js`、`service.js`、`miniapp/tests/schedule-service.test.cjs`；文档 `docs/WorkBuddy方案-施工安排事务兼容-20261003.md`（§12.3/§12.5 更新 + §13 新增）、`docs/WorkBuddy返修-施工安排事务兼容T1-T7-20261003.md`（新建）、`docs/进展与待办.md`、本文件。Codex 原审查文档与离线复现证据未改动（时间戳保持 20:25–20:29）。
- 实际执行的检查：`node --test --test-reporter=spec miniapp/tests/*.test.cjs` → 369 项（368 通过、1 跳过、0 失败）；`T3d` 输出各动作实测峰值（create 19 / reassign 22 / cancel 41 / update 最坏 26 桶 74 / removeMember 13）；JS/JSON 逐文件语法；8 页面路由；`git diff --check`；入口 `enabled=false`/`allowedProjectIds=[]` 且顶层与嵌套均冻结。
- 未通过或未验证项：未实测云端事务行为；未实测 3 秒超时；桶大小与目录 32 KiB 未在真实平台核对；未安装 wx-server-sdk（实际 SDK 用例 1 跳过）；`projects` 字段缺失会阻止旧项目移出（兼容拒绝）；**维护修复脚本未实现**；索引回读未执行。
- 下一步由谁操作：Codex 复查 T1–T7，重点核对产品 80 次保护是否真正在实现内、26 桶峰值 74 与预检 70 是否一致、回执优先是否仍核验权限与维护；随后再决定部署准备与旧 A/B/C 兼容方案。用户无需手机操作。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源、未变更超时。

## 5.5 事务兼容 U1–U3 收尾轮次记录（2026-10-03，Codex 复核后）

- 做了什么：按 Codex 复核完成 U1–U3 本地收尾。U1 四个写回调恢复实际写事务内的 `checkIdempotency`（在身份/权限/维护核验之后、目录/容量/版本/占用之前）；U2 `setMaintenanceMode` 必须接收执行人并在事务内重验账号/角色/项目范围，`mode==='ready'` 一律拒绝；U3 计数器改为每次 SDK 回调私有闭包并由该回调的 `wrapTx` 传递，预检常量改为各分支实测上界。**未重做已关闭的 T1/T2/T5 实现。**
- 修改文件：`miniapp/cloudfunctions/memberAccess/schedule-service.js`、`service.js`、`miniapp/tests/schedule-service.test.cjs`；文档 `docs/WorkBuddy方案-施工安排事务兼容-20261003.md`（§12.3/§12.4/§12.5/§12.6 更新 + §14 新增）、`docs/WorkBuddy收尾-施工安排事务兼容U1-U3-20261003.md`（新建）、`docs/进展与待办.md`、本文件。**Codex 原审查文档与离线证据未改动（时间戳保持 20:50–20:53）。**
- 实际执行的检查：`node --test --test-reporter=spec miniapp/tests/*.test.cjs` → 386 项（385 通过、1 跳过、0 失败）；`T3d` 输出各分支实测峰值（create 首用 20 / 已初始化 19 / 13 桶 44、reassign 23、cancel 13 桶 42、update 最坏 26 桶 75、removeMember 13），并断言预检逐项 ≥ 实测；JS/JSON 逐文件语法；8 页面路由；`git diff --check`；入口 `enabled=false`/`allowedProjectIds=[]` 且顶层与嵌套均冻结。
- 未通过或未验证项：未实测云端事务行为；未实测 3 秒超时；桶大小与目录 32 KiB 未在真实平台核对；未安装 wx-server-sdk（实际 SDK 用例 1 跳过，Codex 复核轮记录其使用已有路径但仅为 `checkTransaction` 入口离线回归）；**`projects` 字段缺失现同时阻止 removeMember/approveInvitation/assignManager**（兼容拒绝，A/B/C 需部署前方案）；**恢复 ready 通道封闭**（`MAINTENANCE_RESTORE_BLOCKED`，已知临时限制）；维护修复脚本与就绪核验流程未实现；并发幂等只在模拟冲突检测下验证，真实事务冲突判定未实测；索引回读未执行。
- 下一步由谁操作：Codex 复查 U1–U3，重点核对写事务内回执复核的位置与语义未放宽、`setMaintenanceMode` 的 ready 封闭是否符合"入口约束而非注释"、产品 80 边界隔离验证是否可信（底层只设 100）、预检是否真为上界；随后再决定部署准备与旧 A/B/C 兼容方案。用户无需手机操作。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源、未变更超时。

## 5.6 事务兼容 V1–V3 测试收尾轮次记录（2026-10-03，Codex 复核后）

- 做了什么：按 Codex 复核完成 V1–V3，**只改测试与文档，未改业务实现，未重做 T1/T2/T5**。V1 把同号并发屏障移到"双方快速回执事务已返回 null 之后"，并把故障敏感性固化为正式回归（内存中删除 4 处写事务 `checkIdempotency` 后 `U1a`–`U1d` 必须全部失败，实测检出 4/4）。V2 用有效合成申请与 10 位绑定编号，让 `approveInvitation`/`assignManager` 与真实 `setScheduleWriteMode` 路由做两种提交顺序（4 例 attempts 均 ≥3）。V3 用内存注入 `FIXED_CREATE` 18→90 走真实 `createSchedule` 路由，断言预算码 + 底层写调用 0 + 全集合逐字节不变，并保留 26 桶成功对照；另把 SDK 重入每次 attempt 的底层操作数断言为 `[60, 60]`。同时修正 `U2d`/`T4c` 的错误顺序注释，并把"预检与实测逐项相等"改为"所测路径预检不低于峰值"。
- 修改文件：`miniapp/tests/schedule-service.test.cjs`（唯一代码文件）；文档 `docs/WorkBuddy方案-施工安排事务兼容-20261003.md`（§12.4/§12.5 更新 + §15 新增）、`docs/WorkBuddy收尾-施工安排事务兼容V1-V3-20261003.md`（新建）、`docs/WorkBuddy收尾-施工安排事务兼容U1-U3-20261003.md`（表述修正）、`docs/进展与待办.md`、本文件。**Codex 原审查与两份离线证据未改动。**
- 实际执行的检查：`node --test --test-reporter=spec miniapp/tests/*.test.cjs` → 394 项（393 通过、1 跳过、0 失败）；分文件 schedule-service 148 / schedule-client 47 / schedule-page 24 / member-access 17 / member-access-schedule 13；JS/JSON 逐文件语法；8 页面路由；`git diff --check`；`find miniapp docs -newermt "2026-10-03 21:29"` 确认**仅测试文件变化**（`schedule-service.js` 21:00、`service.js` 20:59 未动）；入口 `enabled=false`/`allowedProjectIds=[]` 且顶层与嵌套均冻结。另单独跑变异脚本验证 `V3c` 对"实例共享计数器"敏感。
- 未通过或未验证项：未实测云端事务行为；未实测 3 秒超时；桶大小与目录 32 KiB 未在真实平台核对；未安装 wx-server-sdk（实际 SDK 用例 1 跳过，Codex 复核轮记录其用已有路径但仅为 `checkTransaction` 入口离线回归）；`projects` 字段缺失同时阻止 removeMember/approveInvitation/assignManager（兼容拒绝）；恢复 ready 通道封闭；维护修复脚本与就绪核验流程未实现；**并发幂等与维护交错仅在模拟冲突检测下验证，真实事务冲突判定未实测**；**V1/V3 敏感性基于源码文本变异，不覆盖语义等价的其他缺陷变体**；索引回读未执行。
- 下一步由谁操作：Codex 复核 V1–V3，重点核对 V1 敏感性检出 4/4 是否足以证明回归无缺口、V2 四例的 attempts/epoch/最终状态断言是否与真实交错一致、V3a 的零写与全集合不变是否可信、"预检不低于峰值"的表述边界是否已清楚。用户无需手机操作。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源、未变更超时；V1/V3 的源码变异仅存在于内存，不落盘。

## 5.7 部署前准备方案轮次记录（2026-10-03，Codex 验收后）

- 做了什么：Codex 已通过 V1–V3 核心本地验收（394 项全通过），按其验收报告第 4 节提交**部署前准备方案**（设计稿，未执行）。内容：A/B/C 缺字段的 F1–F6 分类取证策略（明确禁止一律回填零目录）；P0–P7 阶段划分与维护/修复/就绪检查/恢复 ready 的权限、幂等、并发保护与失败接续；R-1…R-12 就绪检查项；拟改字段/文件（含建议新增独立云函数 `scheduleMaintenance`）；MA/MR/MO/MC/MX/MRo 共 32 项离线验收用例设计；P-1…P-9 平台与 SDK 核验清单；索引回读要求（修复**不新增索引**）；G-1…G-8 门槛与 B0–B6 分批执行；W-1…W-5 授权影响逐条列明。**本轮未修改业务实现、未执行迁移。**
- 修改文件：`docs/WorkBuddy方案-施工安排部署前准备-20261003.md`（新建，504 行）、`docs/进展与待办.md`（顶部接续点）、本文件。**业务代码、云函数配置、测试文件、入口配置、旧探针/凭据/env-gate 全部未动；Codex 验收报告与历史证据原样保留。**
- 实际执行的检查：逐条核对实现以确保方案与真实代码一致——`readProjectWriteState:682`、`assertScheduleWritableInTx`（`service.js:44`）、`classifyDirState:249`（S1/first-use/F3 分支）、`assertDirMatchesScan:272`、`scanActiveSchedules:283`（`SCAN_SENTINEL` 201 哨兵）、`initDir:307`（`check(!existing)` 幂等依据）、`writeDir:330`（`expectedFence` 比对）、`setMaintenanceMode:658`（ready 封闭 + 幂等 + 事务内重验）、常量区 `:15-41`；读取云端测试方案 §1/§3/§4.2/§5/§7/§8 确认授权范围与"不修改 A/B/C 业务记录"约束；对新方案文档跑结构校验（504 行、无乱码、F1–F6/R-1…R-12/P-1…P-9/G-1…G-8/B0–B6/W-1…W-5 与 32 项用例命名齐全）。
- 未通过或未验证项：**§5 的 P-1…P-9 全部未核验**；**A/B/C 真实数据形态未知**——F3/F4/F6 是否真实存在、容量/字节是否超限、有无悬空安排，全部待 B0 只读取证后才能回答，方案对它们的处置是预案不是已确认事实；独立云函数 `scheduleMaintenance` 的部署可行性、权限模型、超时未验证；未安装任何依赖、未创建资源、未改超时/运行时/内存。
- 下一步由谁操作：Codex 审查本方案。重点决策点：① 无锚点成员（F1）选策略甲（`generation=0`，推荐）还是策略乙（先扫描、有安排转人工）；② F4 目录覆盖是否需实现（建议先确认 F4 是否真实存在，若为零可延后）；③ 恢复 ready 权限是否走 app admin（当前 `setMaintenanceMode` 要求管家，复用会被拒）；④ 独立云函数 `scheduleMaintenance` 是否在授权范围内（会扩展授权）；⑤ W-1…W-5 逐条授权，特别是 **W-5 是能力扩大而非收窄**需明确确认；⑥ 若不授权任何写入，A/B/C 永久不可写是否被接受。审查通过后另发本地工具实现任务（干跑脚本 + 离线用例 + 受控云函数），仍不执行迁移。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源、未变更超时。

## 5.8 部署前准备方案 S1–S5 修订轮次记录（2026-10-03，Codex 裁决后）

- 做了什么：按 Codex 裁决修订部署前准备方案（504 → 707 行）。**只改方案与交接记录，未改产品代码或测试、未实施迁移、未开发通用维修系统、未部署 `scheduleMaintenance`。** 已采纳全部六条裁决：策略乙、F3/F4/F6 待 B0 后另立方案、恢复需可信 app admin + 项目/维护轮次/核验证据、暂不新增 `scheduleMaintenance`、B0 沿用已有只读授权、取消逐字段反复授权与"永久不可写"提问。逐项修正：S1 三列状态表（A 已核验旧部署/ B 待部署本地实现 / C 拟建运维工具）+ 更正维护入口真实行为（`setMaintenanceMode:658` **不调用** `assertProjectWritable`；`verifyActorInTransaction:599` 要求活跃管家，app admin 本身不满足）+ 上线顺序改为部署先于修复（M-a/M-b）+ 围栏覆盖前提（旧函数不递增 epoch，故 epoch 静默不能发现旧写入）；S2 禁止用 `initDir:307` 做旧目录修复（会降代际 5→1）+ 幂等改依据持久化轮次/摘要/当前状态匹配 + 首批只补已证实空数据的 A-1/A-2/A-3；S3 三维正交分类（新增 `FIRST_USE_BUT_NONEMPTY`）+ S-1…S-7 全量取证（检出 `ORPHAN_SCHEDULE`/孤立 guard/`MEMBER_INACTIVE`）+ 四完整性标记 + 完整占用映射 D/A 逐项比对 + 恢复改证书式有界事务；S4 B0 前置只留三项 + 索引降为目标而非结论 + 事务 `where` 不支持非必然失败 + 核验按阶段分配；S5 五类动作清单 + 更正 W5 + 撤销"永久不可写"提问。离线用例由声称的 32 项更正为 **36 项（10+6+7+4+5+4）**，补齐裁决要求的九组反例。
- 修改文件：`docs/WorkBuddy方案-施工安排部署前准备-20261003.md`（重写为修订稿）、`docs/进展与待办.md`（顶部接续点）、本文件。**产品代码、测试、云函数配置、入口配置、旧探针/凭据/env-gate 全部未动；Codex 裁决与历史证据原样保留。**
- 实际执行的检查：逐条核对实现以确保修订与真实代码一致——`setMaintenanceMode:658`（确认无 `assertProjectWritable` 调用、缺 epoch 时写为 1、`mode='ready'` 被 `MAINTENANCE_RESTORE_BLOCKED` 封闭、已同模式幂等 `changed:false`）、`verifyActorInTransaction:599`（确认要求 `member.status==='active' && roles.includes('管家')`）、`initDir:307`（确认固定写 `version/fence/generation=1` 且 `check(!existing)`）、`writeDir:330`、`classifyDirState:249`、`assertDirMatchesScan:272`、`scanActiveSchedules:283`、`bucketKey:691`、`validateBucket:697`、`paginatedFetch:554`（确认 `_id` 升序 + `skip` 分页）、`listSchedules:448`（项目级枚举形状）；`find . -name "memberAccess-before-schedule.zip"` 确认该备份包**不在本仓库**（在 Codex 受限本地，故引用其 SHA-256 而非自行读取）；对新修订稿跑结构校验（707 行、无乱码、三列状态/旧包 SHA/三处更正/九组反例/36 项用例命名按 MA 10·MC 6·MO 7·MR 4·MX 5·MRo 4 精确计数全部通过）。
- 未通过或未验证项：**A/B/C 真实数据形态未知**——F3/F4/F6 是否真实存在、孤立安排/guard/桶、容量与字节、失效成员，全部待 B0 取证，方案对其处置是预案不是事实；旧部署是否仍在运行未确认（B0-2 刷新包指纹是唯一途径）；**是否存在不遵守 epoch 的写入者未知**（若存在则证书式恢复不成立）；平台与 SDK 限制按 §9.5 分阶段全部未核验；索引需求未结论化；恢复入口与维修载体均未实现；**36 项离线用例全部只是设计，本轮未执行**。
- 下一步由谁操作：Codex 复审 S1–S5 修订稿；并可沿用既有只读授权独立进行 B0（§9.6 规范，B0-1…B0-8）。重点复核：① §1 三列状态与 §2 维护入口更正是否彻底；② §3 围栏覆盖前提与 M-a/M-b 选择；③ §4 首批只补 A-1/A-2/A-3 的边界是否足够窄；④ §6 四完整性标记与 §7 完整映射比对的可执行性；⑤ §8 证书式恢复的前提是否充分；⑥ §9.6 B0 规范是否可直接执行；⑦ §10 五类清单与一次性授权方式。B0 事实到位后再决定 F3/F4/F6 是否另立方案、以及恢复入口载体选型。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源、未变更超时；未请求用户批准任何写入，也未要求用户接受"永久不可写"。

## 5.9 部署前准备方案复审修订轮次记录（2026-10-03，Codex 复审后）

- 做了什么：按 Codex 复审修订部署前准备方案（707 → 690 行）。**只改方案、设计用例、进展与交接记录；未改产品代码或测试、未补任何字段、未改变任何维护状态、未实施迁移、未开发通用维修系统、未新增或部署运维函数、未操作云端写入。** 七项裁决已固定，**不再提交任何技术选项组**：采用 **M-b**；F3/F4/F6 待 B0 后另立最小方案；恢复载体待 B0 后选最小受限载体（本轮不新增/部署 `scheduleMaintenance`）；管理员资格对齐 `app_admins` 主管理员模型（`primary` 记录绑定用户）并执行时重验；证书时效服务端签发后 ≤10 分钟；首批补缺保持策略乙窄范围；索引仍不能断言"不需新增"。逐项修正：**P1-①** 补缺顺序——上稿把 schema 缺失与 epoch 缺失/0 捆绑，但维护入口缺 epoch 会写入 1，导致"已进维护但 schema 仍缺失"被排除；改为三字段分别分类、合法现值全保留、绝不把 epoch 改回 0、不降低代际、部分锚点/非法值转人工；观测报告与最终恢复证书分离（证书在计划内写入完成后针对最终 epoch 签发，此后任意相关写入使其失效）；`initDir` 合法首用前提是**锚点已存在且 generation=0**，"两者都不存在即可直接 initDir"不能写成操作说明。**P1-②** 成员异常按**是否被 active 安排引用**分流——被引用的责任成员检查记录/账号/师傅角色/工种/锚点目录一致，不满足阻断；未被引用的管家/主业主/`left`/非师傅成员**仅查锚点目录一致性，不因角色或退出状态本身阻断**；孤立 guard/错误代际/非空残留仍检出且不改身份；容量 200/201 **按责任成员目录计算**，不得因项目全量第 201 条判定某成员超限。**P1-③** `writeBuckets` 保留空桶，故比对对象改为**非空日期占用** `(projectId, trade, date) → scheduleId` 严格相等；结构合法且 `days={}` 的保留桶记 `LEGACY_EMPTY_BUCKET`，不形成多余占用、不删除、不阻断；错工种/旧逐日键/未知键/无效结构**不因空豁免**。**P1-④** 恢复证书七项固定要求（可信来源为受信管理端流程 + 服务端可验证记录、客户端只引用证据 ID；绑定环境/项目/轮次/epoch/精确 schema/规则版本/完整性/**写入者覆盖证据**；摘要覆盖项目·成员·锚点·目录·安排·占用全部输入；分阶段证据必须聚合为完整项目证书；有效期 ≤10 分钟且服务端时间、未来签发拒绝、时效为附加条件；七类失效条件含**任何相关写入**；恢复小事务仅主键操作并**原子记录 + 原子消费证书 + 更新 ready + 推进 epoch**；重试同轮次同输入返回原结果不二次推进 epoch、不同输入不复用、仍核验身份权限；邀请类字段若入摘要须另有稳定性依据）。**P2** 消除事实与流程矛盾——更正上稿把 `createInvitation`/`applyInvitation` 说成改 `project_members`（实为只涉邀请及其审计，批准才改成员）；"新代码所有写入都递增 epoch"改为**逐路由围栏覆盖表**（邀请类与账号/管理员变更**否**、控制台脚本**未知**），结论"所有写入都被冻结并受围栏保护"**不成立**；多次 epoch 相等/停发预览/固定等待**都不能单独证明排空**，最终恢复须有写入者约束 W-1…W-4，**W-4 未确认前不存在可用的最终恢复路径**；B0 不以写入设计或新授权为前置，**数据非空停止自动迁移但不停止其余只读取证**，某集合 ERROR/INCOMPLETE 时该项停止而其余继续；查询失败不得报零，集合不存在是单独事实 `NOT_EXISTS`，旧部署观察不能提升为稳定迁移基线。
- 修改文件：`docs/WorkBuddy方案-施工安排部署前准备-20261003.md`（重写为复审修订稿）、`docs/进展与待办.md`（顶部接续点）、本文件。**产品代码、测试、云函数配置、入口配置、旧探针/凭据/env-gate 全部未动；Codex 复审、裁决与全部历史证据原样保留。**
- 实际执行的检查：读取 `证据/施工安排部署前准备B0初查-20261003.json` 全部字段（`status=PARTIAL_OBSERVATION`、`complete=false`、`cloudWritesPerformed=false`、`functionInvocationsPerformed=false`、集合清单 Offset 0/Limit 100/Total 10、元数据计数、六集合 ADMINONLY 权限、六个集合索引已回读、`limitations` 七条、`next`），据此写 §9.8 引用边界，逐条区分"可引用"与"禁止断言"；核对实现确认 `setMaintenanceMode:658` 缺 epoch 时写 `(undefined||0)+1=1`、不补 schema、不调用 `assertProjectWritable`；`verifyActorInTransaction:599` 要求活跃管家；`initDir:307` 固定写 generation/fence=1 且要求 guard 不存在；`writeBuckets` 保留空桶（`upsertBucket` 对每键写一次，空 `days` 也写回）；`scanActiveSchedules:283` 哨兵为**每成员**目录。对修订稿跑结构校验（690 行、无乱码、三字段分类/成员分流/LEGACY_EMPTY_BUCKET/证书七要求/逐路由围栏表/部分观测标注/章节索引全部命中；用例按表格行精确统计 53 个唯一 ID：MA 12 · MF 4 · MC 7 · MO 9 · MR 5 · MX 10 · MRo 4 · MB 2）。
- 未通过或未验证项：A/B/C **记录级**数据形态未知（项目字段、成员锚点、账号状态、管理员记录、active 安排、目录、桶占用全部待 B0），本稿处置是预案不是事实；B0 仅部分观测，不得当作记录级核验完成；是否存在不遵守 epoch 的写入者未知（B0-8 未完成）；W-4（控制台/脚本/其它函数是否停用）未确认；平台与 SDK 限制全部未实测；索引需求未结论化（六集合索引已回读，最终查询形状对照未完成）；恢复载体与入口均未实现；**53 项设计用例全部只是设计，本轮未执行**。
- 下一步由谁操作：Codex 在可用的已授权只读通道补齐**记录级 B0**，读不到的字段保留未知、不以集合计数代替；B0 完成后输出按具体项目/记录/字段列出的干跑变更包，再提交一次性范围确认。本稿交 Codex 复查，重点：① §5 三字段分别分类是否彻底消除 `epoch=1` 与 schema 缺失的冲突；② §6.5 成员分流与 §6.4 容量按责任成员计算；③ §7.3/§7.4 空月桶与非空占用严格比对；④ §8.2–§8.5 证书七项固定要求；⑤ §1.3 逐路由围栏覆盖表与 §3.2 W-1…W-4；⑥ §9.8 部分观测引用边界。
- 用户人工核验：无需。本轮未操作云端、未取号、未创建资源、未变更超时；未请求用户批准任何写入，也未要求用户作技术选项选择。

## 6. 启动指令

把以下文字发给已选择上述工作目录的 WorkBuddy：

> 你接手装修进度验收微信小程序的代码开发，Codex 负责主策划和结果审查。请先读取项目根目录 AGENTS.md 和 docs/WorkBuddy开发交接.md，按其中顺序核对最新进展、需求与第一单元验收清单。先只读检查，保留所有已修改和未跟踪文件，不重新初始化。请用中文报告：实际工作目录、已完成及未验收部分、当前唯一下一步、现有工具能否完成它，以及需要我做的具体操作。后续按明确任务逐项开发，每轮把真实完成内容、检查结果和接续点写回 docs/进展与待办.md；不要只留在聊天中。
