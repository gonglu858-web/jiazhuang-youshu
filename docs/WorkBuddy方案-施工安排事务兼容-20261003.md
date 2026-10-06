# WorkBuddy 方案：施工安排事务兼容（修订稿 + 已实施）

> **状态：本地已实施（2026-10-03），已完成 T1–T7 返修、U1–U3 收尾与 V1–V3 测试收尾。** 本文的设计部分保留为契约来源；§12 起为实际实施记录，§13 为 T1–T7 返修记录，§14 为 U1–U3 收尾记录，§15 为 V1–V3 测试收尾记录。**云端部署仍暂停**：未创建集合/索引、未改云端模式/超时、未部署、未取号。
- T1–T7 返修依据：[Codex复查](Codex复查-施工安排事务兼容本地实施-20261003.md)；返修结果另存 [WorkBuddy返修-施工安排事务兼容T1-T7-20261003.md](WorkBuddy返修-施工安排事务兼容T1-T7-20261003.md)。
- U1–U3 收尾依据：[Codex复核](Codex复核-施工安排事务兼容T1-T7返修-20261003.md)；收尾结果另存 [WorkBuddy收尾-施工安排事务兼容U1-U3-20261003.md](WorkBuddy收尾-施工安排事务兼容U1-U3-20261003.md)。
- V1–V3 测试收尾依据：[Codex复核2](Codex复核-施工安排事务兼容U1-U3收尾-20261003.md)；结果另存 [WorkBuddy收尾-施工安排事务兼容V1-V3-20261003.md](WorkBuddy收尾-施工安排事务兼容V1-V3-20261003.md)。

- 日期：2026-10-03（初稿同日；本稿按 [Codex裁决](Codex裁决-施工安排事务兼容设计-20261003.md) 修订）
- 证据：[施工安排云端前置核验-20261003.json](证据/施工安排云端前置核验-20261003.json)
- 核对对象：`miniapp/cloudfunctions/memberAccess/schedule-service.js`（714 行）、`service.js`（342 行）、`miniapp/tests/schedule-service.test.cjs`（66 项）
- 分工：Codex 策划/审查，WorkBuddy 开发。本轮只交设计。
- 边界：入口保持 `enabled=false`、`allowedProjectIds=[]` 冻结；不改旧探针、旧凭据、env-gate；不安装、不取号、不创建项目或成员、不操作云端、不变更超时、不预览/部署/发布。
- 实施依据：[Codex实施裁决](Codex裁决-施工安排事务兼容修订稿-20261003.md)（六项决策已明确，无需再提交选项）。

## 0. 摘要

| 阻断 | 根因 | 推荐方案 | 集合数 | 产品能力 |
|---|---|---|---|---|
| P1 | 事务内 `where` 不被官方支持；且目录自洽**不能**替代与实际安排核对 | **独立初始化锚点**（`project_members`）+ **事务外扫描 + 持久版本围栏**（`member_task_guard`） | 不变 | 不变 |
| P2 | 365 天逐日占用写入超单事务操作预算 | `schedule_occupancy` **月度分桶**，桶读一次、内存合并、桶写一次 | 不变 | 365 天上限保留 |

**字段有新增**（`project_members`、`projects`、`member_task_guard`、`schedule_occupancy`），集合数不变。逐项见 §7.2。

**预算口径**：应用层每次事务尝试上限 **80** 次数据操作；平台限制夹具仍为 **100**。80 是工程余量，**不是**"重试共享 100 次额度"——每次 attempt 独立计数，重试另计累计耗时。初稿的 38/64/15/10 估算值**不予采纳**，重算见 §5.4。

**关于目录安全性**：目录是**维护的派生索引**，不是"原子写所以永不损坏"的证明。误删、历史数据、漏写都必须能被拒绝，见 §2.3 与 §3。

## 1. P1 根因与受影响接口

### 1.1 官方限制

`https://docs.cloudbase.net/database/transaction`（Codex 于 2026-10-03 读取）：事务**仅支持 `doc`，不支持 `where`**；单事务**最多 100 个操作**，最长 30 秒。

**当前部署包**：`wx-server-sdk=3.0.1`、`@cloudbase/database=1.4.1`。SDK 暴露 `Query` 并携带 `transactionId` 发请求，但这不代表平台支持该查询。**尚未在云端实际调用复现**，本文只写文档兼容风险，不写任何具体错误码。

### 1.2 事务内 `where` 实际使用点（逐行核对）

| 位置 | 调用 | 事务源 | 状态 |
|---|---|---|---|
| `schedule-service.js:87` `rebuildGuardCount` | `paginatedFetch('schedules', {...}, { source: tx })` | `tx` | **违规** |
| `schedule-service.js:112` `hasActiveSchedules` | `paginatedFetch('schedules', {...}, { source: tx })` | `tx` | **违规** |
| `schedule-service.js:413` `releaseOccupancy` | `get('schedule_occupancy', key, tx)` | `tx` | 合规（已是 `doc`） |
| `schedule-service.js:423` `occupyDates` | `get('schedule_occupancy', key, tx)` | `tx` | 合规（已是 `doc`） |

`listSchedules`（:243）、`listScheduleRevisions`（:299）、`getScheduleContext`（:204）、`paginatedFetch`/`fetchAll`（:341/:324）在**事务外**执行，不受该限制，但共用 helper，实施时须按 `opts.source` 区分，**不得误改事务外路径**。

`:202` 现有注释假设扫描发生在事务内，修订后须一并更正。

### 1.3 受影响接口

新增四个写动作，以及**既有** `removeMember`（`service.js:293` 经 `hasActiveSchedules` 带入该依赖）。P1 不是"只影响新功能"，必须一并修。

## 2. P1 修订之一：独立于目录的初始化锚点

### 2.1 初稿方案被否决的原因

初稿用"目录缺失且 `initialized=true/false`"区分首次使用与被删除，**无法实现**：目录不存在时两个字段都读不到。

**反例（必须能拒绝）**：师傅有 active 安排 → guard 文档被删除 → 读取结果与"从未建目录"完全相同 → 按零初始化 → `removeMember` 错误放行。

### 2.2 修订方案

把"是否已初始化"存到**与目录不同的文档**。物理集合仍为已获准的 `member_task_guard`；`member_task_dir` 仅为概念称呼，不是新增集合。

**锚点载体：`project_members` 成员文档**（稳定 `_id = m_{hash(projectId:userId).slice(0,40)}`）

```
project_members（新增 2 字段）
  taskDirSchemaVersion : integer   锚点结构版本，本轮固定 1
  taskDirGeneration    : integer   目录代际，从 0 起；每次首次初始化 +1
```

**目录载体：`member_task_guard`**（`_id` 不变）

```
member_task_guard
  projectId, userId
  activeScheduleCount : integer >= 0     派生计数
  version             : integer >= 1     冲突点（语义不变）
  fenceVersion        : integer >= 0     持久版本围栏（新增，见 §4）
  activeScheduleIds   : string[]         派生索引（不得有重复 ID）
  updatedAt
```

**关键性质**：锚点与目录分处两个文档。目录被删不影响锚点可读，因此"曾初始化"这一事实不会丢失。

### 2.3 初始化与恢复状态表

| # | 锚点 `taskDirGeneration` | 目录 | 判定 | 动作 | 错误码 |
|---|---|---|---|---|---|
| S1 | 字段不存在（历史成员未迁移） | 缺失 | **不可推断** | 拒绝，提示需先执行迁移/初始化入口 | `TASK_DIR_NOT_READY` |
| S2 | `= 0` | 缺失 | 从未初始化，且当前无 active 安排（由扫描证明） | 允许首次初始化，`generation → 1` | — |
| S3 | `= 0` | 存在 | 异常（未初始化却有目录） | 拒绝 | `TASK_DIR_INCONSISTENT` |
| S4 | `>= 1` | 缺失 | **目录被删除或从未回填** | **一律拒绝**，不按零计数放行 | `TASK_DIR_INCONSISTENT` |
| S5 | `>= 1` | 存在，计数与目录自洽 | 正常 | 继续走 §3 围栏核对 | — |
| S6 | `>= 1` | 存在，但 `count !== ids.length` 或 `ids` 有重复 | 目录损坏 | 拒绝 | `TASK_DIR_INCONSISTENT` |
| S7 | `>= 1` | 存在且自洽，但与**实际扫描**结果不符 | 派生索引与真实安排脱节 | 拒绝 | `GUARD_INCONSISTENT` |

**S7 是初稿最大的缺陷**：初稿声称"同事务写所以永不损坏"，被 Codex 明确否决。本修订保留实际扫描核对，Codex 给出的两个反例必须能被测出：

- 反例一：`count=0, ids=[]`，但 `schedules` 实际有 active 安排。
- 反例二：`count=1, ids=[错误ID]`，但真实安排是另一个 ID。

**S1 的处理**：对历史成员（无锚点字段）**不得自动推断没有安排**。必须有明确的初始化/迁移入口，且该入口有服务端可验证的就绪条件（§6.4），不依赖客户端 `enabled=false` 暂停写入——旧预览版或直接调用云函数仍可能并发写。

### 2.4 各分支行为

| 分支 | 锚点 | 目录 | 行为 |
|---|---|---|---|
| **新成员加入**（`approveInvitation` 走 `add` 分支，`service.js:269`） | 写入 `taskDirSchemaVersion: 1, taskDirGeneration: 0` | 不创建 | 首次安排时按 S2 初始化 |
| **成员离开后重新加入**（走 `update` 分支，`service.js:268`） | **保留原 `taskDirGeneration` 不重置**（可能 `>= 1`） | 保留 | 若离开前目录存在 → S5；若目录期间被删 → S4 拒绝。**禁止重置 generation 覆盖旧 active 目录** |
| **首次安排** | `= 0` | 创建 | S2 → `generation → 1` |
| **原目录被删除** | `>= 1` | 缺失 | S4 拒绝 |
| **维护/迁移期** | 任意 | 任意 | 由 §6.4 的就绪条件阻断写入 |

`approveInvitation` 兼容影响：仅在 `add` 分支多写 2 个字段；`update` 分支**不触碰**这两个字段，因此不改变既有身份行为。成员文档 `version` 递增逻辑不变。

## 3. P1 修订之二：实际扫描 + 版本围栏

### 3.1 为什么必须扫描

Codex 反例（两者都满足"数组长度自洽"，但都不满足原安全要求）见 §2.3。**目录只能作为派生索引**，移出前必须与实际 `schedules` 核对。**不是简单把 `where` 搬出去**——需要下列可执行顺序与竞争证明。

### 3.2 并发时序（七步）

记 `G` = `member_task_guard` 文档，`A` = `project_members` 锚点，`S` = 实际 `schedules` 扫描结果。

```
【事务外】(1) 读 G → 得 (fenceVersion₀, activeScheduleIds₀, count₀)
         (2) 读 A → 得 taskDirGeneration₀ 与锚点存在性
             —— 顺序不可颠倒：必须先取围栏再扫描 ——
【事务外】(3) 完整扫描 S：{projectId, workerUserId, status:'active'} → S₀（id 集合）
         (4) 前置校验（不通过则不进事务）：
             - 锚点 S1/S4 → 拒绝
             - S₀ 与 G 的目录不一致 → 拒绝 GUARD_INCONSISTENT

【事务内】(5) 重读 G 与 A（读到事务视图）
         (6) 核对前置条件：
             - G.fenceVersion === fenceVersion₀            否则扫描已过期
             - A.taskDirGeneration === taskDirGeneration₀  否则锚点已变
             - A 存在性与 (2) 一致                        否则锚点被删/新建
             - G.activeScheduleIds 与 S₀ 集合相等           否则真实安排已变
             任一不符 → 抛 STALE_SCAN，**不复用失效扫描结果**
         (7) 写 G：fenceVersion = fenceVersion₀ + 1（并按动作增删目录）
             写 A（仅 S2 首次初始化时）：taskDirGeneration 0 → 1
         提交
```

**顺序不可颠倒的理由**：若先扫描再取围栏，扫描过程中发生的写可能落在"扫描完成"与"读取围栏"之间，此时围栏已是新值，扫描结果却是旧的，事务内核对会**误判为一致**，从而放行错误的移出。先取围栏再扫描则围栏必早于扫描，任何写都会使围栏领先于扫描结果，被 (6) 检出。

### 3.3 各竞争场景的证明

| 场景 | 竞争 | 为何安全 |
|---|---|---|
| 扫描期间另一 create 提交 | 扫描 (3) 读到旧集合或新集合 | 对方提交时 `G.fenceVersion + 1`（§4.1），事务内 (6) 读到 `fenceVersion ≠ fenceVersion₀` → 拒绝或重扫 |
| 扫描期间 cancel 提交 | 同上 | 同上 |
| 扫描期间 reassign 提交 | 涉及**双方**成员 | 双方 `fenceVersion` 都 +1；本成员侧必然检出 |
| 扫描期间 schedule 的 `content` 等非归属字段被改 | 不影响 active 集合 | 判据是 active id 集合与计数，不是全字段；集合相等即可通过 |
| 分页扫描期间写入导致漏读 | 某页读完后有写发生 | 写路径递增 `fenceVersion`；事务内 (6) 检出 → 拒绝。**这正是围栏的作用**，防止漏读被静默接受 |
| 两个移出并发 | 都通过扫描 | 事务内 (7) 写同一 `G` 文档 → 单文档写冲突 → 平台重试 → 重跑 (5)(6)，仍无 active 安排才放行 |
| 首次并发初始化（S2） | 两个 create 同时看到 `generation=0` 且无目录 | 两者都写 `G`（同一 `_id`）→ 写冲突 → 平台重试 → 重试后读到已初始化目录，按 S5 继续。**初始化恰好一次**；两个不同日期、容量合法的创建在重试后**可以都成功**，不要求"业务只能成功一个" |
| 目录缺失（S4） | 移出时目录已被删 | 锚点 `>= 1` → 事务外 (4) 即拒绝，不进入事务 |
| 维护期间 | 旧预览版直接调用 | 由 §6.4 服务端就绪条件阻断，不靠客户端开关 |

### 3.4 平台冲突重试与 `VERSION_MISMATCH` 的关系

**必须区分三个版本字段**：

| 字段 | 归属 | 冲突后果 |
|---|---|---|
| `schedules.version` | 安排业务版本 | 不匹配 → `VERSION_MISMATCH`（用户可刷新重试） |
| `member_task_guard.fenceVersion` | 扫描围栏 | 不匹配 → 扫描过期，**重跑扫描**后可能成功 |
| `member_task_guard.version` | 冲突点（既有语义） | 写冲突触发平台重试 |

Codex 指出：平台冲突重试**不一定**触发 `VERSION_MISMATCH`——若安排版本未变、仅 guard 变动，重新校验后**可以成功**。**不得把 `fenceVersion` 与 `schedule.expectedVersion` 混同**，也不得在文档中暗示前者会导致后者报错。

重试时若只是 fence 变了而业务前提仍成立，实现可选择"重新扫描 + 重新校验"后成功；为限制重试放大，**最多重扫 1 次**，仍冲突则返回 `STALE_SCAN` 交由用户重试。

### 3.5 明确不在保证范围内

管理员绕过服务直接同时篡改多个文档，**不在正常业务一致性保证内**。本文不声称能检测任何形式的外部篡改。有**可见**缺失（S4/S6）或自洽但与实际扫描不符（S7）仍须拒绝。

## 4. P1 修订之三：围栏的写入义务

### 4.1 谁必须递增 `fenceVersion`

**所有改变"某成员 active 安排归属或 status"的业务路径**，都必须在同一事务内递增该成员的 `fenceVersion`：

| 路径 | 递增对象 | 依据 |
|---|---|---|
| `createSchedule` | 新责任人 | 集合 +1 |
| `cancelSchedule` | 该安排责任人 | 集合 -1 |
| `reassignSchedule` | **旧责任人与新责任人各一次** | 双方集合均变 |
| `updateSchedule`（责任人不变） | 该责任人 | 集合不变但仍递增，防止漏读被静默接受 |
| `updateSchedule`（责任人变更） | 旧、新各一次 | 同 reassign |
| `removeMember`（`lockGuard`） | 该成员 | 已在 `version+1`，同时 `fenceVersion+1` |

### 4.2 其他影响核对结果的字段

`schedules` 上除 `workerUserId`/`status` 外，`startDate`/`endDate`/`restDays` 的修改**不影响** active 集合与计数，因此不要求递增围栏。`trade` 变更会影响占用判定，走 §5 的桶合并路径。

### 4.3 围栏与目录的写入顺序

围栏递增必须与目录变更在**同一个文档更新**里完成（`G` 的单次 `update` 同时写 `fenceVersion`、计数、目录），避免出现"围栏动了目录没动"的中间态。

## 5. P2 月度分桶与逐动作预算

### 5.1 桶结构

```
schedule_occupancy
  _id      = `${projectId}:${trade}:${YYYYMM}`      例：p_xxx:水电:202610
  projectId, trade
  month    : "202610"
  days     : { "2026-10-01": "s_xxx", "2026-10-02": "s_yyy", ... }  仅实际施工日
  updatedAt
```

**日期键统一为真实 `YYYY-MM-DD`**（初稿示例 `202610-01` 有误，已纠正）。覆盖闰年、跨年、月末、365 天跨度、休息日与全休息日拒绝（后者沿用 `SCHEDULE_NO_WORKING_DAY`）。

### 5.2 桶大小实测

初稿的"约 2 KB"是估算。现按实际最长允许值计算 UTF-8 序列化字节：

| 输入 | 取值依据 | `_id` 字节 | `days` 字节 | 文档合计 |
|---|---|---|---|---|
| ASCII `projectId` 99 字符 | `schedule-service.js:198`/`:236` 的 `length < 100` 校验 | 113 B | 1551 B | **1869 B = 1.83 KB** |
| CJK `projectId` 99 字符 | 同上，取汉字最坏情形 | 311 B | 1551 B | **2265 B = 2.21 KB** |

`trade` 取 `TRADES` 最长 2 汉字（`schedule-service.js:6`）；`scheduleId` 形如 `s_<32 位 hex>`（`id()` 用 `randomUUID` 去横线）；一个月最多 31 个日期键。

**文档大小的真实平台限制须在执行前另行核对**，本文数值为本地计算结果。

### 5.3 合并读写规则

| 规则 | 说明 |
|---|---|
| 桶键并集 | 按**旧项目+工种+月份**与**新项目+工种+月份**桶键的**并集**核算 |
| 每桶读一次 | 不按日期重复读同一桶 |
| 内存合并后写一次 | 读齐全部相关桶 → 内存中释放本安排旧日期、获取新日期 → 各桶**写一次** |
| 同桶先释放再获取 | 同月不重叠日期可先在内存释放本安排再获取新日期，避免自冲突 |
| **不得写回旧快照覆盖他人占用** | 写回前须基于本事务读到的最新桶内容合并 |
| 释放时发现占用属于其他安排 | **停止并报告不一致**，不得静默继续（否则留下错误占用） |
| 空桶删除或保留 | **统一为保留**（写空 `days`），避免 add/remove 分支差异进入预算 |
| `add`/`update`/`set`/`remove` 的存在/缺失分支 | 全部纳入预算，不只算命中路径 |

### 5.4 逐动作预算（每次事务尝试，独立计数）

平台上限 100；**应用层每次 attempt 上限 80**。重试另计累计耗时，**不共享额度**。

**桶数上界**：365 天最多跨 13 个自然月；改期/改工种时旧新桶并集最多 **26** 个。

固定开销（按现有 `verifyActorInTransaction`、`checkIdempotency`、`validateWorker` 的 `doc` 读次数统计）：权限与身份复核读 users/projects/project_members 共 3 次；回执读 1 次；`validateWorker` 读 users + project_members 共 2 次；锚点读 1 次。

| 动作 | 最坏路径 | 数据操作数 | 是否超 80 |
|---|---|---|---|
| `createSchedule` | 固定 7 + 锚点读1 + guard 读1/写1（首次初始化） + 安排写1 + 历史1 + 审计1 + 回执写1 + 桶读13 + 桶写13 | **33** | 否 |
| `updateSchedule`（改日期+改工种+改责任人） | 固定 7 + 锚点读1 + guard 读2/写2（双方 fence） + 安排读1/写1 + 历史1 + 审计1 + 回执1 + **桶并集读26 + 写26** | **≈ 66** | 否（余量 14） |
| `updateSchedule`（仅改内容） | 同上但无桶操作、guard 仅 fence | **≈ 12** | 否 |
| `reassignSchedule` | 固定 7 + 锚点读1 + guard 读2/写2（双方） + 安排读1/写1 + 历史1 + 审计1 + 回执1 | **≈ 13** | 否 |
| `cancelSchedule` | 固定 7 + 锚点读1 + guard 读1/写1 + 安排读1/写1 + 历史1 + 审计1 + 回执1 + 桶读13 + 桶写13 | **≈ 35** | 否 |
| `removeMember` | 管家权限复核 + 锚点读1 + guard 读1/写1（fence+1） + 成员读1/写1 + 审计1 | **≈ 9** | 否 |
| 缺失结构恢复（回填/修复） | 独立维护命令，**不占用业务事务预算**（§6.3） | 另计 | — |

**超预算判定时机**：最终预算必须在**首个数据写之前**确定。`update` 的旧日期/工种/责任人须在事务内读到权威版本后才能算准，因此**形状校验可提前做，预算判定不可提前**。超限抛 `SCHEDULE_OPERATION_BUDGET_EXCEEDED`；因未发生任何写入，**不留半份安排**。

服务端为准；客户端预估**只作体验辅助**，不复制易漂移的权威规则。

## 6. 3 秒超时、迁移与就绪条件

### 6.1 3 秒超时

**当前配置**：`Nodejs16.13`、`256 MB`、`Timeout=3 秒`（前置证据 `function` 段）。平台事务 30 秒 ≠ 函数可执行 30 秒，**3 秒是硬约束**。

**明确不接受的结论**：不接受"10/15 次操作可以在 3 秒完成"。函数的外层身份/鉴权、冷启动、重试与查询同样耗时。**已删除初稿中 10–30 ms 的无测量依据数值。**

修订后的行为约束：

| 项 | 设计口径 |
|---|---|
| 重试放大 | 每次 attempt 独立计数（§5.4）；扫描过期最多重扫 1 次（§3.4），避免无界重试 |
| 超时行为 | 事务未提交即整体回滚；客户端收到 `kind='unknown'`，按既有快照重试语义处理（不换 requestId） |
| 事务外扫描耗时 | 扫描不计事务内额度，但仍计函数总耗时；须限制扫描分页数上限，超限拒绝而非无限翻页 |
| 实测要求 | 部署准备时单列**建议 10 秒超时**及客户端等待窗口供核对；**本轮不自动改资源配置** |
| 样本声明 | 少量样本**不能**声称有可靠 p95 |

**当前 3 秒尚未验证**，不以文档延迟假设放行。

### 6.2 容量上限

**每项目每成员 active 安排目录条目数上限 200**，作为本轮隔离试验的**服务端技术保护上限**，不确认为正式业务永久上限。

| 规则 | 说明 |
|---|---|
| 计量对象 | 每项目每成员**当前 active 状态**的目录条目数；**不得**混同为"成员一生最多 200 项"或"同时施工 200 项" |
| 达到上限 | 只拒绝**增加条目**的新操作；允许读取、允许减少条目的合法取消/改派 |
| 幂等 | 成功回放不再次占容量 |
| 重复 ID | 目录中重复 ID 不得通过（S6） |
| 提示语 | **禁止**提示用户"为绕过容量而取消实际仍需施工的安排" |

### 6.3 迁移与回填

**证据区分**：前置证据记录 5 个集合处于 `newCollectionsAbsent`（**不存在**的证据），这**不是**"现存集合 Count=0"。两者不可混用。

当前前置观察为集合未创建，故实际迁移量为 0；仍保留回填脚本以防环境已变更。

| 步骤 | 内容 | 就绪条件 |
|---|---|---|
| M1 | 创建 5 集合 + 索引，回读确认 | — |
| M2 | 为历史成员写锚点 `taskDirSchemaVersion=1, taskDirGeneration=0` | 维护模式下 |
| M3 | 为已有 active 安排的成员建目录并写 `generation=1`（若 `generation=0` 却是 S3，按不一致处理并人工确认） | 维护模式下 |
| M4 | 校验无 `TASK_DIR_INCONSISTENT` / `GUARD_INCONSISTENT` | 维护模式下 |
| M5 | 解除维护模式 | 服务端就绪条件通过 |

**回填脚本要求**：独立维护命令，**不占用业务事务预算**；按 §4.1 的义务正确写 `fenceVersion`；回填后目录与实际安排必须一致。

### 6.4 服务端可验证的就绪/维护条件

**不能只依赖客户端 `enabled=false`**——旧预览版或直接调用云函数仍可能并发写。

| 条件 | 载体 | 写路径检查 |
|---|---|---|
| 维护模式标志 | `projects.scheduleWriteMode : 'maintenance' \| 'ready'`（新增字段） | 四个写动作与 `removeMember` 在**事务内**读 `projects` 时校验，非 `ready` 一律拒绝 |
| 迁移就绪标志 | `projects.scheduleSchemaVersion : integer` | 低于期望版本拒绝写入，提示需迁移 |

两个标志都放在已获准集合 `projects` 内，**不新增集合**。`removeMember` 已在事务内读 `projects`（`service.js:285`），增量校验成本为 0。

## 7. 实际查询与字段影响清单

### 7.1 实际查询列表（决定索引）

| # | 位置 | 查询条件 | 事务内/外 | 需要的索引 |
|---|---|---|---|---|
| Q1 | `hasActiveSchedules`（修订后 :112） | `schedules {projectId, workerUserId, status:'active'}` | **外**（扫描） | `{projectId, workerUserId, status}` |
| Q2 | `rebuildGuardCount`（修订后 :87） | 同 Q1 | **外** | 同 Q1（可合并为一次扫描） |
| Q3 | `listSchedules`（:243） | `schedules {projectId, status?, trade?}` | 外 | `{projectId, status, trade}` |
| Q4 | `getScheduleContext`（:204） | `project_members {projectId, status:'active'}` | 外 | `{projectId, status}` |
| Q5 | `listScheduleRevisions`（:299） | `schedule_revisions {scheduleId}` | 外 | `{scheduleId}` |
| Q6 | 全部 `get`/`doc` | 按 `_id` | 内 | `_id` 唯一 |

**事实修正**：初稿 §6.2 称"成员工种索引由 `listSchedules` 使用"**不准确**——`listSchedules` 只按 `projectId`/`status`/`trade` 过滤，**不按 `workerUserId`**。修订后该索引的**实际用途是 Q1/Q2 的事务外核对扫描**。

### 7.2 字段影响清单

| 集合 | 字段 | 变化 | 写入路径 | 兼容影响 |
|---|---|---|---|---|
| `project_members` | `taskDirSchemaVersion` | 新增 integer | `approveInvitation` 的 `add` 分支 | 仅多写 2 字段；`update`（重新加入）分支不触碰 |
| `project_members` | `taskDirGeneration` | 新增 integer | `approveInvitation` 的 `add` 分支；首次初始化时 `0→1` | 同上；重新加入**不重置** |
| `projects` | `scheduleWriteMode` | 新增 string | 维护模式切换（独立命令） | 写动作事务内校验，非 `ready` 拒绝 |
| `projects` | `scheduleSchemaVersion` | 新增 integer | 迁移完成时写入 | 低于期望版本拒绝写入 |
| `member_task_guard` | `fenceVersion` | 新增 integer | 全部影响 active 集合的路径（§4.1） | 语义：并发围栏 |
| `member_task_guard` | `activeScheduleIds` | 新增 string[] | 同上 | 语义：派生索引，可由扫描重建 |
| `schedule_occupancy` | `_id` / `days` / `month` | **结构变更** | 桶读合并写 | 逐日 → 月度桶 |
| 其余三集合 | — | 无 | — | — |

**集合数不变（5 个），字段新增/变更逐项如上。** 不扩大到无关身份行为。

## 8. 平台限制夹具与测试清单

### 8.1 `createPlatformLimitedMockDb()`（新增，不替换现有夹具）

| 限制 | 行为 |
|---|---|
| 事务内 `where`/`orderBy`/`limit`/`skip` | **立即抛** `PLATFORM_UNSUPPORTED_IN_TXN` |
| 应用层预算 | **第 81 个操作执行前拒绝**（不是 commit 时事后报错） |
| 平台预算 | **第 101 个操作执行前拒绝** |
| 计数器语义 | **每次 attempt 重置**；同时保留总尝试数与累计操作数 |
| 峰值暴露 | `getPeakAttemptOps()` / `getTotalAttempts()` |
| 事务外 `where` | 正常分页，不受限 |

**不修改** `createConflictMockDb` 的 `where` 支持——保留 `H3 order A/B/C/D` 四种交错用例。

### 8.2 测试清单

| 类别 | 用例 | 状态 |
|---|---|---|
| 四种路由交错 | `H3 order A/B/C/D`（含 `attempts` 断言） | **保留** |
| 七集合快照（含新增字段） | `rollback on ... leaves full snapshot unchanged`（7 项） | **保留**，快照需含 `fenceVersion`、`activeScheduleIds`、锚点字段 |
| 恰好一次 | 冲突重试 / 同号重放 / 取消重放（3 项） | **保留** |
| **目录误删** | 锚点 `generation>=1` + 目录缺失 → 移出被拒（S4） | **新增** |
| **自洽但错误目录** | `count=0,ids=[]` 但实际有 active 安排 → 拒绝（反例一） | **新增** |
| **自洽但错误 ID** | `count=1,ids=[错误ID]` 但真实为另一 ID → 拒绝（反例二） | **新增** |
| **扫描期间变更** | 扫描后、事务前另一 create 提交 → `STALE_SCAN`，不得复用失效结果 | **新增** |
| **重试重新扫描** | fence 变但业务前提仍成立 → 重扫后可成功；不误报 `VERSION_MISMATCH` | **新增** |
| **初始化恰好一次** | 两事务并发首次初始化 → 目录只建一次；两个不同日期的合法创建**重试后都可成功** | **新增** |
| **重新加入** | 离开后重新加入保留 `generation`；目录被删则 S4 拒绝 | **新增** |
| **迁移分支** | S1（无锚点）拒绝；M2/M3 回填后就绪 | **新增** |
| **异常分支** | S3（未初始化却有目录）、S6（重复 ID/长度不符）拒绝 | **新增** |
| **超预算首写前拒绝** | 第 81 个操作前拒绝，且**无任何写入**、无半份安排 | **新增** |
| **事务内零 `where`** | 平台夹具下跑全部写动作，出现事务内 `where` 即失败 | **新增** |
| **同月同日竞争** | 同月不同日不冲突；同日 `SCHEDULE_CONFLICT` | **新增** |
| **桶边界** | 闰年、跨年、月末、365 天跨度、休息日、全休息日拒绝 | **新增** |
| **桶释放冲突** | 释放日占用属于其他安排 → 停止并报不一致，不静默继续 | **新增** |
| **桶合并不覆盖** | 同桶先释放再获取；不写回旧快照覆盖他人占用 | **新增** |
| **容量上限** | 第 201 条拒绝增加；取消/改派减少条目仍允许；重复 ID 拒绝 | **新增** |
| **幂等** | 成功回放不再次占容量 | **新增** |
| **维护模式** | `scheduleWriteMode != 'ready'` 时写动作与 `removeMember` 均拒绝 | **新增** |

### 8.3 三类测试边界

| 类别 | 载体 | 能证明 | 不能证明 |
|---|---|---|---|
| 实际 SDK 请求形状 | `member-access-sdk.test.cjs`（需 `MEMBER_ACCESS_SDK_PATH`） | SDK 接受参数形状、身份注入 | **不等于云端事务通过** |
| 模拟事务 | `createConflictMockDb` / `createPlatformLimitedMockDb` | 交错、回滚、预算、幂等逻辑 | 不等于平台真实行为 |
| 真实云端 | 尚未执行 | 平台实际限制 | 本轮无云端写入 |

**不得把"SDK 路径可加载"称作云端事务通过。** 本轮未安装 SDK，该用例仍 1 跳过。

## 9. 与已验证业务规则的关系

**不推翻**任何已验证规则：可信微信身份、项目权限、仅管家可写、requestId/版本/载荷三重幂等回执、`VERSION_MISMATCH`、`WORKER_INVALID`、`SCHEDULE_CONFLICT`、`EXPECTED_DATE_MISMATCH`、`SCHEDULE_NO_WORKING_DAY`、日志脱敏、完整快照回滚与恰好一次审计。

**两处必须纠正的表述**：

| 初稿表述 | 修订后 |
|---|---|
| "计数与目录同事务写，与实际不符不可能发生" | **删除**。目录是派生索引，误删/历史数据/漏写都可能发生，必须由实际扫描核对检出（S7 + 反例测试） |
| "新语义比原语义更严格" | **删除**。改为：语义**保持**——`GUARD_INCONSISTENT` 仍是阻止移出的检查，只是判定依据从"分页扫描对照"改为"扫描 + 围栏重扫"，并新增结构缺失场景 |

`guard.version`（冲突点）、`fenceVersion`（扫描围栏）与 `schedules.version`（业务版本）**三者不得混同**。

## 10. 待 Codex 决策点

1. **锚点载体选 `project_members` 是否合适**。备选：`projects` 下按成员键的锚点文档（会新增文档但仍不新增集合）。当前选 `project_members` 的理由是成员文档已存在且 `approveInvitation` 已在写。
2. **扫描过期后最多重扫 1 次**是否过少，是否需要按动作区分。
3. **桶并集 26** 与应用层 80 预算的余量（最坏路径 66，余 14）是否足够吸收平台计数口径差异。
4. **`scheduleWriteMode` / `scheduleSchemaVersion` 放 `projects`** 是否可接受，或需要独立的维护状态载体。
5. **容量上限 200** 的口径是否需进一步明确（当前定义为"每项目每成员当前 active 条目数"）。
6. **§7.1 索引清单**是否需要 Codex 按部署环境回读核对。

## 11. 实施前置条件（通过审查后）

1. Codex 明确第 10 节各决策点，并确认两项阻断已闭合。
2. 用户确认任何被列为"待确认变更"的产品能力变化（本轮无）。
3. 入口继续 `enabled=false`、`allowedProjectIds=[]` 冻结，直至云端真实验证通过。
4. 实施顺序：**先改夹具与测试**（使其能表达平台限制与新结构），**再改实现**，最后更新本文状态为"已实施"并写明实际测试名称与结果。
5. 初稿已通过的结果保留为**旧实现证据**，**不得沿用为新设计已验证**。


## 12. 实施记录（2026-10-03）

### 12.1 实际改动文件

| 文件 | 改动 |
|---|---|
| `miniapp/cloudfunctions/memberAccess/schedule-service.js` | 锚点/围栏状态机、两轮扫描外层控制、月度桶、预算预检、项目 epoch、幂等优先、容量与字节保护；**事务内 `where` 全部移除** |
| `miniapp/cloudfunctions/memberAccess/service.js` | `removeMember` 改为 `runWithScanRounds` + `lockDirForRemoval`；新增 `setScheduleWriteMode`；`createProject`/`assignManager`/`approveInvitation` 写入锚点与项目就绪字段 |
| `miniapp/miniprogram/utils/schedule-client.js` | 新增 `classifyBusinessCode()` 与可纠正/阻塞码表，补全事务兼容新增码映射 |
| `miniapp/tests/schedule-service.test.cjs` | 新增 `createPlatformLimitedMockDb()`（平台限制夹具）、`snapshotAll8()`、`seedDir()`、`seedReady()`；重写依赖旧内部 API 的用例；新增 36 项 `compat *` 必测用例 |
| `miniapp/tests/schedule-client.test.cjs` | 新增 20 项业务码映射用例 |
| `miniapp/tests/member-access-schedule.test.cjs`、`member-access.test.cjs` | 按新结构修正断言 |

### 12.2 关键实现口径

| 项 | 实现 |
|---|---|
| 锚点 | `project_members.taskDirSchemaVersion` + `taskDirGeneration`；与 `member_task_guard.generation`/`schemaVersion` **精确配对**，不一致即拒 |
| 目录 | `member_task_guard.activeScheduleIds` + `fenceVersion`；计数与数组长度必须自洽；**仍需与实际扫描核对** |
| 状态机 | S1 无锚点 → `TASK_DIR_NOT_READY`；S2 generation=0 首用 → 原子建档；S3 未初始化却有目录 / S4 目录缺失 / S6 重复ID / S7 与扫描不符 → 拒绝 |
| 扫描 | 事务外 `scanActiveSchedules` 有界分页（固定 `_id` 排序），第 201 项为哨兵 |
| 顺序 | 先读围栏与锚点 → 再扫描 → 事务内**先判围栏过期（`STALE_SCAN`）→ 再判一致性（`GUARD_INCONSISTENT`）** |
| 重扫 | `runWithScanRounds` 最多 2 轮（1 初扫 + 1 重扫），双方责任人算同一轮；第二轮仍过期返回 `STALE_SCAN` |
| 月桶 | `_id = {projectId}:{trade}:{YYYYMM}`，真实 `YYYY-MM-DD` 键，`schemaVersion: 2`；旧新桶并集读一次、内存合并、写一次；空桶保留 |
| 预算 | 应用层每次 attempt ≤ **80**，`assertWithinBudget` 在首个数据写之前；平台夹具 100；每次 attempt 独立计数 |
| 维护 | `projects.scheduleWriteMode`/`scheduleSchemaVersion`/`scheduleEpoch`；四个写动作与 `removeMember` 真实递增 epoch；`setScheduleWriteMode` 写同一文档形成冲突 |
| 幂等 | 事务内**先核验回执再校验目录/版本/容量**；失权仍拒绝；回放不重新占容量 |
| 容量 | 200 条 + 32 KiB UTF-8 字节 + 唯一 ID；满容量只拒增加，允许减少；提示"请联系管理员核对"，不要求取消仍需施工的安排 |

### 12.3 实际操作次数表（U1–U3 收尾后重测）

计数口径：每类文档的读/写各计 1 次；`wrapTx` **只缓存集合包装对象，不缓存文档读取结果**，因此同一 attempt 内对同一文档的重复 `get` 也各计 1 次。桶按完整键 `(projectId, trade, month)` 计数，每桶读一次 + 写一次。`getPeakAttemptOps()` 为单次 attempt 内实测峰值。

**U1 修复后各分支实测（`T3d` 输出）**：

| 动作 | 分支 | 桶数 | 实测峰值 | 预检上界 | 上限 |
|---|---|---|---|---|---|
| `create` | 首用（建目录+锚点） | 1 | **20** | 18 + 2 = **20** | 80 |
| `create` | 已初始化 | 1 | 19 | 18 + 2 = **20** | 80 |
| `create` | 365 天 / 13 桶 | 13 | **44** | 18 + 26 = **44** | 80 |
| `update` | 最坏：日期不变 + 换人 + 换工种 = **26 个桶键** | 26 | **75** | 18 + 5 + 52 = **75** | 80 |
| `reassign` | 换责任人 | 0 | **23** | **23** | 80 |
| `cancel` | 365 天 / 13 桶 | 13 | **42** | 16 + 26 = **42** | 80 |
| `removeMember` | 无 active 安排 | 0 | **13** | **13** | 80 |
| 维护切换 `setScheduleWriteMode` | 事务内重验后写一次 | 0 | ≤ `removeMember` | 不占业务预算 | 80 |

**预检现在是真实上界，不是低估值。** 固定开销取自各分支实测 base 的最大值：

| 常量 | 值 | 来源 |
|---|---|---|
| `FIXED_CREATE` | 18 | 首用 18 / 已初始化 17 → 取最大 |
| `FIXED_UPDATE_BASE` | 18 | 不换人 18 |
| `UPDATE_WORKER_CHANGED_EXTRA` | 5 | 换人 23 − 18 |
| `FIXED_REASSIGN` | 23 | 实测 |
| `FIXED_CANCEL` | 16 | 实测 |
| `FIXED_REMOVE_MEMBER` | 13 | 实测 |
| 未知动作兜底 | 23 + 26 | 最大固定 + 最大单侧桶数 |

`T3d` 与 `U3e` 均断言 **预检 ≥ 实测峰值**（不得低估）且 **预检 ≤ 80**。

**表述边界**：以上是**已枚举分支的样本测量**——26 桶与各动作峰值均不超过预检，但已初始化 create 的预检（20）高于实测（19），说明预检在部分分支上偏保守。**不把样本测量扩大为全部平台路径的证明**：未枚举分支（例如未来新增字段带来的额外读取）仍可能使实际峰值高于预检，这类偏差由第二层逐操作拦截兜底（每次 attempt 独立计数、第 81 次在写入前拒绝），不会写坏数据。

**关键结论**：26 桶最坏路径实测 **75 ≤ 80**，属**可支持**路径，365 天能力未缩减。U1 在写事务内新增回执复核（每次写事务 +2 次操作），峰值由 74 升为 75；U2 的维护切换与成员写重验不影响业务峰值。

**旧数值全部作废**：初稿 38/64/15/10、T1–T7 轮的 19/22/41/74/13 与 18/16/15/14/9 预检，均不再作为返修后证据。

**双层保护**：
1. **首写前预检**：`assertWithinBudget()` 在首个数据写之前按上表预检，超限抛 `SCHEDULE_OPERATION_BUDGET_EXCEEDED`，**无任何写入**。
2. **逐操作拦截**：`createTxnOpCounter()` 为**每次 SDK 事务回调的私有闭包**，由该回调的 `wrapTx` 传递。**允许前 80 次；第 81 次在调用底层 SDK 之前拒绝**。同实例并发事务与 SDK 冲突重入各自独立计数，互不重置或累计（`U3a`、`U3b`、`U3c`）。

### 12.4 测试结果（U1–U3 收尾后）

```
cd miniapp && node --test --test-reporter=spec tests/*.test.cjs
```

**tests 394 / pass 393 / fail 0 / skipped 1**

- `schedule-service.test.cjs` 148 项（含 36 项 `compat *`、19 项 `T1*`–`T7*`、17 项 `U1*`–`U3*`、8 项 `V1*`–`V3*`）
- `schedule-client.test.cjs` 47 项、`schedule-page.test.cjs` 24 项、`member-access.test.cjs` 17 项、`member-access-schedule.test.cjs` 13 项
- 跳过 1 项：`member-access-sdk.test.cjs` 的实际 SDK 用例。本机**未安装** SDK；Codex 复核轮使用了已有 SDK 路径，该用例仅为 `checkTransaction` 入口离线回归，**不证明新增施工写路由或云端事务通过**
- JS/JSON 语法、8 页面路由、`git diff --check`：通过
- WXML/WXSS 真实编译：WorkBuddy 本机无 `wcc-exec`，未执行，不记为通过；Codex 复核轮记录为 8 WXML/9 WXSS 编译通过

### 12.5 测试覆盖记录（T1–T7 返修后）

| 裁决 §5 必测项 / Codex 复查项 | 用例 | 状态 |
|---|---|---|
| 1 平台夹具零 where、81/101 拒绝、逐动作计数 | `compat 1a`–`1e`、`T3b`、`T3c`、`T3d` | 覆盖（`T7a` 补第一步 where） |
| 2 八集合快照、失败整体不变 | `compat 2a`、`2b`、`T1a`、`T1b` | 覆盖 |
| 3 锚点状态机 | `compat 3a`–`3f` | 覆盖 |
| 4 扫描期间变更、重扫 | `compat 4a`–`4c`、`H3 order A–D` | 覆盖 |
| 5 维护交错、未就绪旧项目 | `compat 5a`–`5d`、`T4a`–`T4c` | 覆盖（T4 补 approveInvitation/assignManager） |
| 6 同号回放、失权、维护切换 | `compat 6a`–`6c`、`T6a`–`T6d` | 覆盖（T6 补目录删除后回放） |
| 7 长日期月桶、26 桶、月末/闰年/休息日 | `compat 7a`–`7h`、`T2a`–`T2c`、`T3a` | 覆盖（T2 补跨月/跨工种/跨年；T3a 改确定性期望） |
| 8 容量 200、201 哨兵、32KiB | `compat 8a`–`8e` | 覆盖 |
| 9 未就绪旧项目明确拒绝 | `compat 5d`、`T4a`、`T4b` | 覆盖 |
| **T1 首用真实扫描** | `T1a`、`T1b` | **新增** |
| **T2 完整旧新桶并集** | `T2a`、`T2b`、`T2c` | **新增** |
| **T3 产品 80 次双层保护 + 精确计数** | `T3a`、`T3b`、`T3c`、`T3d` | **新增** |
| **T4 维护期成员写入口双向交错** | `T4a`、`T4b`、`T4c` | **新增** |
| **T5 外层混合快照重扫** | `T5a`、`T5b` | **新增** |
| **T6 回执优先 + 维护核验** | `T6a`、`T6b`、`T6c`、`T6d` | **新增** |
| **T7 事务第一步 where 拒绝** | `T7a` | **新增** |
| **U1 写事务内回执复核（四动作同号并发）** | `U1a`–`U1d` | **新增** |
| **U1 同号不同载荷并发 + 首次初始化竞争** | `U1e`、`U1f` | **新增** |
| **U2 维护切换事务内重验账号/角色** | `U2a`、`U2b` | **新增** |
| **U2 ready 恢复封闭 + 拒绝后留在 maintenance** | `U2c` | **新增** |
| **U2 成员写与真实维护路由双向交错** | `U2d`、`U2e`、`U2f` | **新增** |
| **U3 产品 80 边界隔离验证（底层只设 100）** | `U3a` | **新增** |
| **U3 并发 attempt 独立计数 + SDK 重入从 0** | `U3b`、`U3c` | **新增** |
| **U3 首写前预检语义 + 预检为上界** | `U3d`、`U3e`、`T3d` | **新增** |
| **V1 同号并发屏障移到"快速回执已返回 null 之后"** | `U1a`–`U1f`（重写） | **V1 修正** |
| **V1 故障敏感性（删除写事务回执复核必须失败）** | `V1` | **新增** |
| **V2 approveInvitation/assignManager × 真实维护路由双向交错** | `V2a`–`V2d` | **新增** |
| **V3 受控预算注入走真实 create 路由，零写 + 全集合不变** | `V3a`、`V3b` | **新增** |
| **V3 SDK 重入每次 attempt 独立计数的可量化断言** | `V3c` | **新增** |

**未覆盖/不声称覆盖**：维护修复脚本（幂等、checkpoint、失败留 maintenance、重入不重置代际）**尚未实现**，仅提供 `setScheduleWriteMode` 切换与"失败保持 maintenance"的语义基础；不列为已覆盖。

### 12.6 未验证项与已知影响

1. **未实测云端事务行为**：`where` 不支持、100 操作上限、30 秒上限均来自官方文档；本轮未在云端调用复现，也未创建集合/索引。
2. **未实测 3 秒超时耗时**：分桶后操作数下降是数量级改善，但外层身份鉴权、冷启动、重试与查询耗时未知；仍不建议在实测前放行。
3. **桶文档大小真实平台限制未核对**：本地计算月桶最坏 2265 B；目录 32 KiB 为本轮保守自定值，非平台核对结果。
4. **未安装 wx-server-sdk**：实际 SDK 请求形状用例仍跳过；SDK 路径可加载不等于云端事务通过。
5. **`projects` 字段缺失的兼容影响范围已扩大**（U2 收尾后明确）：字段缺失/未就绪的项目不仅阻止 `removeMember`，也阻止 `approveInvitation` 与 `assignManager`（`U2e`、`U2f` 断言 `PROJECT_NOT_WRITABLE`）。**这是兼容拒绝，不是"旧项目完全不受影响"**；A/B/C 项目的兼容准备仍由 Codex 在部署前另做，本地实现不静默填 `ready`，本轮未改任何云记录。
6. **恢复 ready 通道当前封闭**：`setScheduleWriteMode(mode='ready')` 一律返回 `MAINTENANCE_RESTORE_BLOCKED`，项目必须停留在 maintenance。就绪核验/迁移流程尚未实现，因此本轮**不提供**恢复可写的入口；这意味着维护只能由后续独立流程解除，属于已知的临时限制。
7. **维护修复脚本未实现**：本轮仅提供 `setScheduleWriteMode` 切到 maintenance 与"失败保持 maintenance"的语义基础；按 checkpoint 接续的幂等修复脚本与就绪核验流程属部署准备，尚未编写。因此 ready 恢复通道保持封闭（见第 6 条）。
8. **平台夹具为本地模拟**：事务内 `where` 拒绝与操作计数是按官方文档建模，**不能替代真实云端验证**。
9. **并发幂等只在模拟冲突检测下验证**：`U1a`–`U1f` 使用具备读值快照与写集冲突检测的内存夹具，两个独立服务实例共享同一库。真实云数据库的事务冲突判定与重试时机**未实测**。
10. **`attemptOps` 隔离的边界已澄清**：产品计数器是每次 SDK 回调的私有闭包；`index.js` 每次调用创建独立 service，因此**不存在已证实的跨云调用共享计数**。U3 修复的是"复用同一实例时违反每 attempt 独立预算"以及并发测试污染。

## 13. T1–T7 返修记录（2026-10-03）

依据 [Codex复查-施工安排事务兼容本地实施-20261003](Codex复查-施工安排事务兼容本地实施-20261003.md) 的 11 条离线复现，逐项修复并补入确定性回归测试。返修结果另存 [WorkBuddy返修-施工安排事务兼容T1-T7-20261003](WorkBuddy返修-施工安排事务兼容T1-T7-20261003.md)。

| 项 | 复现现象 | 修复 | 回归用例 |
|---|---|---|---|
| T1 | generation=0 且 guard 缺失时直接当成没有安排，可移出仍有安排的成员 | `collectPreconditions` 首用也做真实有界扫描；`verifyPreconditions` 在 first-use 下若实际集合非空抛 `GUARD_INCONSISTENT`，不建立覆盖事实的空目录 | `T1a`、`T1b` |
| T2 | 改期只读新日期桶，正常跨月调整被误报 `OCCUPANCY_INCONSISTENT` | 新增 `buildBucketKeys()` 以完整键 `(projectId, trade, month)` 建并集；`readBucketsForKeys()` 每桶读一次并保留存在性；`writeBuckets()` 复用已读结果写一次，移除 `mergeBucketsMulti` 与 `upsertBucket` 二次读 | `T2a`、`T2b`、`T2c` |
| T3 | `upsertBucket` 二次读、`bucketMonths` 按月去重漏计；产品无逐操作 80 保护 | 消除二次读；预算改按完整桶键计数；`transaction()` 用 `wrapTx` + `countTxnOp` 对每次 attempt 独立计数，第 80 次立即拒绝 | `T3a`、`T3b`、`T3c`、`T3d` |
| T4 | 维护模式下 `approveInvitation`/`assignManager` 仍可写入且不推进 epoch | 新增 `assertScheduleWritableInTx` + `guardAndBumpEpoch`，两个入口在事务内校验并真实递增 `scheduleEpoch` | `T4a`、`T4b`、`T4c` |
| T5 | 外层采集混合快照时先判结构损坏，未进入重扫 | `collectPreconditions` 记录扫描前后围栏/代际，不一致抛 `STALE_SCAN`；`runWithScanRounds` 的 `collect` 也纳入两轮预算 | `T5a`、`T5b` |
| T6 | 采集先于回执；目录被删后原号重试被挡；维护切换后回放绕过策略 | 新增 `withReceiptFirst` + `tryReceiptReplay`：先在独立事务内核验身份/权限/维护策略，再优先处理回执；四动作全部切换 | `T6a`–`T6d` |
| T7 | `compat 7b` 弱断言；夹具第一步 `where` 不拒绝；夹具 80 上限遮蔽产品漏计 | `compat 7b`/`T3a` 改为确定性期望；`denyInTxn` 去掉 `currentOps > 0` 前提，第一步无条件拒绝；夹具新增 `getWriteCount()`/`resetPeak()` 区分首写前拒绝与写后回滚 | `T3a`、`T7a` |

**仍未实现（非本轮范围）**：维护修复脚本、旧 A/B/C 项目兼容方案、索引回读。

## 14. U1–U3 收尾记录（2026-10-03）

依据 [Codex复核-施工安排事务兼容T1-T7返修-20261003](Codex复核-施工安排事务兼容T1-T7返修-20261003.md)。原 11 条复现已通过，本轮**未重做已关闭的 T1/T2/T5 实现**；只处理 U1–U3。收尾结果另存 [WorkBuddy收尾-施工安排事务兼容U1-U3-20261003](WorkBuddy收尾-施工安排事务兼容U1-U3-20261003.md)。

### 14.1 U1：实际写事务内重新检查回执

**Codex 指出的问题**：T6 把回执检查移到独立事务 `tryReceiptReplay`，实际写事务内的 `checkIdempotency` 被删除。两个同号请求可能都先查到"无回执"，其中一个先提交，另一个冲突重试/重扫后直接撞上占用/版本/取消状态，把已成功的提交报成业务失败（create→`SCHEDULE_CONFLICT`、update/reassign→`VERSION_MISMATCH`、cancel→`BAD_INPUT 已取消`）。

**修复**：四个写回调（`createSchedule`/`updateSchedule`/`reassignSchedule`/`cancelSchedule`）在实际写事务内、`verifyActorInTransaction` + `assertProjectWritable` 之后、目录/容量/业务版本/占用检查之前，重新调用 `checkIdempotency`；命中即 `return committed`。独立的回执快速返回路径保留（避免无回执时多跑一次扫描）。

**语义未被放宽**：同号不同载荷仍由 `checkIdempotency` 返回 `REQUEST_ID_REUSED_DIFFERENT_PAYLOAD`；失权返回 `NO_ACCESS`；维护状态由 `assertProjectWritable` 返回 `PROJECT_NOT_WRITABLE`，都**不因为有回执而放行**。

**回归**：`U1a`–`U1d` 四动作同号同载荷并发（两个独立服务实例共享具备冲突检测的内存库，双方先完成"无回执"检查），断言双方返回**完全相同**的原成功结果、业务版本只推进一次、回执/审计/历史恰好一次、不得重复落库；`U1e` 同号不同载荷并发（断言为明确业务码，**不是** SDK 重复键错误）；`U1f` 首次初始化竞争（两个不同 requestId、不同日期，两次成功、两份安排、同一 `generation=1` 目录含 2 条）。

**代价**：每次写事务新增 2 次数据操作（1 次回执读已在原路径内，实际为项目复核 + 回执读），26 桶最坏峰值由 74 升为 **75**，仍 ≤ 80。

### 14.2 U2：维护切换事务内重验权限；ready 恢复封闭

**Codex 指出的问题**：`setScheduleWriteMode` 只在事务外调用 `managerAccess`；`setMaintenanceMode` 不接收执行人、只检查项目存在就切换。事务外鉴权后账号被停用/成员已离开仍能切换；项目处于 maintenance 时可直接切 ready。

**修复**：
- `setMaintenanceMode(projectId, mode, actor)` 现在**必须接收执行人**，并在事务内调用 `verifyActorInTransaction` 重新核验账号启用状态、管家角色与项目有效范围。
- `mode === 'ready'` **一律拒绝**，抛 `MAINTENANCE_RESTORE_BLOCKED`，不写任何字段，项目停留在 maintenance。就绪核验/迁移流程尚未实现，**不以注释代替入口约束**。
- 已处于目标模式时返回 `changed: false`，不重复递增 epoch。
- `service.js` 的 `setScheduleWriteMode` 路由注释改为"事务外鉴权仅作快速失败"。

**回归**：`U2a`（事务外鉴权通过后账号被停用 → `IDENTITY_DISABLED`，仍为 ready）；`U2b`（成员被设为 left → `NO_ACCESS`，仍为 ready）；`U2c`（ready 恢复被拒 → `MAINTENANCE_RESTORE_BLOCKED`，仍为 maintenance 且 epoch 未变）；`U2d`（成员写与真实维护路由双向交错：成员写先提交 → 切换基于事务内最新 epoch 递增成功；维护先提交 → 成员写重扫后 `PROJECT_NOT_WRITABLE` 且成员保持 active）；`U2e`/`U2f`（维护先提交时 `approveInvitation`/`assignManager` 均被拒，epoch 未变，成员/管家未新增）。

**旧项目影响已更新**：字段缺失/未就绪的项目现在同时阻止 `removeMember`、`approveInvitation`、`assignManager`，见 §12.6 第 5 条。

### 14.3 U3：attempt 计数隔离与预算上界修正

**Codex 指出的问题**：(1) `attemptOps/attemptPeak` 是服务实例共享状态，同实例并发会互相重置/累计；(2) `wrapTx` 只缓存集合包装对象，注释却称"重复读取可复用"，属虚构缓存；(3) 预检 70 / 实测 74 不相等，低估式不能当上界；(4) `T3b` 直接调 `db.runTransaction`，断言的是夹具码而非产品码。

**修复**：
- 计数器改为 `createTxnOpCounter()` 返回的**每次 SDK 事务回调私有闭包**，由该回调的 `wrapTx(tx, counter)` 传给集合包装对象。SDK 每次调用回调都得到全新计数器，重入/重试自然从 0 开始；同实例并发事务互不影响。
- 删除虚构缓存注释，明确 `wrapTx` 只缓存集合包装对象，**不缓存文档读取结果**。
- 预检常量改为各分支实测 base 的最大值（`FIXED_CREATE` 18、`FIXED_UPDATE_BASE` 18、`UPDATE_WORKER_CHANGED_EXTRA` 5、`FIXED_REASSIGN` 23、`FIXED_CANCEL` 16、`FIXED_REMOVE_MEMBER` 13），未知动作兜底改为最大固定 + 最大单侧桶数。
- 边界语义写明：**允许前 80 次，第 81 次在调用底层 SDK 之前拒绝**（不是"第 80 次被拒绝"）。
- `T3b` 改为只锁定常量口径并注明"读取常量不构成边界证据"；边界证据移到 `U3a`。

**回归**：`U3a` 底层夹具以 `appBudget: null` 启动（**无 80 拦截、只保留平台 100**），经真实产品 `transaction()` 包装读满 80 次成功、第 81 次抛产品 `SCHEDULE_OPERATION_BUDGET_EXCEEDED`，并核实底层只执行 80 次；`U3b` 同实例两个并发 attempt（A 读 60 → 暂停 → B 读 10 → A 再读 30）各自独立计数，A 累计 90 被产品拒绝；`U3c` SDK 冲突重入后新 attempt 从 0 计数并成功；`U3d` 首写前预检语义（超限抛预算码、26 桶可支持路径必须有真实写入且产生真实变更）；`U3e` 与 `T3d` 断言**预检 ≥ 实测峰值**（不得低估）且 ≤ 80。

### 14.4 实际改动文件

| 文件 | 改动 |
|---|---|
| `miniapp/cloudfunctions/memberAccess/schedule-service.js` | 四个写回调恢复事务内回执复核；`setMaintenanceMode` 接收执行人并事务内重验、封闭 ready 分支、幂等返回；计数器改为每次 SDK 回调私有闭包；`wrapTx(tx, counter)`；预检常量改为实测上界；导出 `transaction`/`createTxnOpCounter`/`currentAttemptPeak` 供隔离验证 |
| `miniapp/cloudfunctions/memberAccess/service.js` | `setScheduleWriteMode` 路由传入执行人并更新注释 |
| `miniapp/tests/schedule-service.test.cjs` | 冲突夹具补 `app_admins`/`invitations` 集合与 `getExecutedOps()`；平台夹具支持 `appBudget: null` 并暴露 `getExecutedOps()`/`resetExecutedOps()`；新增 `twoServices()`；新增 17 项 `U1*`–`U3*`；重写 `T3b`/`T3d` |

**未改动**：`schedule-client.js`、`schedule-page.test.cjs`、`schedule-client.test.cjs`、`member-access*.test.cjs`、云函数配置、入口配置、旧探针/凭据/env-gate。Codex 原审查文档与离线证据（`Codex复核-…md`、`证据/施工安排事务兼容T1-T7返修复核-20261003.json`、`证据/施工安排事务兼容T1-T7复核补充-20261003.cjs`）时间戳保持 20:50–20:53，原样保留。

## 15. V1–V3 收尾记录（2026-10-03）

依据 [Codex复核-施工安排事务兼容U1-U3收尾-20261003](Codex复核-施工安排事务兼容U1-U3收尾-20261003.md)。**本轮只修改测试与文档，未改动任何业务实现**（`schedule-service.js`、`service.js` 时间戳保持 21:00/20:59，本轮仅 `schedule-service.test.cjs` 变化）。

Codex 的独立复核确认 U1–U3 实现已修复，但指出正式回归存在三处覆盖缺口。本轮结果另存 [WorkBuddy收尾-施工安排事务兼容V1-V3-20261003](WorkBuddy收尾-施工安排事务兼容V1-V3-20261003.md)。

### 15.1 V1：同号并发屏障位置修正

**问题**：原 `U1a`–`U1d` 的 barrier 停在 A 的**快速回执事务提交前**。B 完整提交业务与回执后，A 的快速事务冲突重试便能直接找到回执返回——被测的不是"实际写事务内是否重新检查回执"。Codex 实证：仅在内存中删除四个写回调的 `checkIdempotency` 与命中返回，**现有 U1a–U1d 仍全部通过**。

**修正**：新增 `gateAfterBothFastReceiptChecks(db)`——包裹 `db.runTransaction`，让双方快速回执事务**真正执行完并返回 `null`** 后，把双方一起卡在事务外；等两个都到位（断言 `fastNullReturns() === 2`）再放行进入实际写事务。这样被测点才是写事务内的回执复核。

**故障敏感性已固化为正式回归**：新增 `V1` 用例，在内存中（`vm.runInThisContext`，不写磁盘）删除全部 4 处写事务内回执复核，重跑 `U1a`–`U1d`，断言**四个都必须失败**，且失败原因涉及各自预期的业务码：

| 用例 | 变异后失败码 |
|---|---|
| `U1a` create | `SCHEDULE_CONFLICT` |
| `U1b` update | `VERSION_MISMATCH` |
| `U1c` reassign | `VERSION_MISMATCH` |
| `U1d` cancel | `BAD_INPUT` |

这四个码正是 Codex 独立复现的"已成功提交被误报为业务失败"表现。**检出率 4/4**。

### 15.2 V2：真实成员入口 × 真实维护路由双向交错

**问题**：原 `U2d` 两半都不是与真实维护路由并行交错——第一半直接修改 `projects` 模拟干扰、移出完成后才调用维护接口；第二半覆盖的是 `removeMember` 而非要求的 `approveInvitation`/`assignManager`。`U2e`/`U2f` 是先切维护再顺序调用，且 `U2e` 还用了不存在的邀请与无效格式编号。旧 `T4c` 的注释与实际提交顺序相反。

**修正**：新增 `seedPendingMemberFixture()`（有效合成申请 + 10 位绑定编号 + owner 管理员）与 `interleaveMemberAndMaintenance()`，用**真实 `setScheduleWriteMode` 路由**制造干扰，四例结果与 Codex 独立复现一致：

| 用例 | 先提交方 | 被暂停并恢复 | attempts | epoch | 最终状态 |
|---|---|---|---|---|---|
| `V2a` | `approveInvitation` | 维护事务 | ≥3 | 1→2→**3** | 成员已加入、锚点代际 0、申请 approved、编号已消费、批准审计 1 条 |
| `V2b` | 维护切换 | `approveInvitation` | ≥3 | 1→**2** | `PROJECT_NOT_WRITABLE`、无成员、申请仍 requested、编号未消费、批准审计 0 条 |
| `V2c` | `assignManager` | 维护事务 | ≥3 | 1→2→**3** | 管家已指定、锚点代际 0、编号已消费、指定审计 1 条 |
| `V2d` | 维护切换 | `assignManager` | ≥3 | 1→**2** | `PROJECT_NOT_WRITABLE`、无新增管家、编号未消费、指定审计 0 条 |

**注释修正**：`U2d` 标题改为 `removeMember conflicts with maintenance switch...` 并加说明"两半都不是与真实维护路由并行交错、真正交错见 V2a–V2d"；`T4c` 标题改为 `removeMember is rejected when maintenance state is committed while it is in flight`，注释改为实际的"移出先暂停 → 直接改 projects → 恢复后被拒"。两处均明确标注干扰**不经过** `setScheduleWriteMode` 路由。

### 15.3 V3：受控预算注入与重入计数可量化断言

**问题**：原 `U3d` 标题宣称零写入，但实际是事务外直接调 `assertWithinBudget` 检查公式、再成功执行 26 桶更新并断言写入大于零——**没有检查超限真实业务路径的底层写调用为 0，也没断言拒绝后全集合不变**。

**修正**：新增 `compileInMemory()`（`vm.runInThisContext`，不写磁盘）+ 三例：

- `V3a` 把内存副本的 `FIXED_CREATE` 从 18 提到 90，经**真实 `createSchedule` 路由**执行，底层夹具 `appBudget: null`（只保留平台 100）：断言 `SCHEDULE_OPERATION_BUDGET_EXCEEDED`、**`getWriteCount() === 0`**、`JSON.stringify(db.getData())` 与执行前逐字节相同。
- `V3b` 对照：未注入时同一路由 365 天创建成功、确有真实写入、峰值 ≤ 80、13 个月度桶、快照产生真实变更——**首写前拒绝 ≠ 写后回滚**。
- `V3c` 用冲突夹具制造一次真实 SDK 重入（第一次 attempt 在提交前被外部改动它读过的 `projects` 文档打断），在 `db.runTransaction` 外层逐 attempt 记录底层实际操作数：断言 `perAttempt = [60, 60]`——**第二次从 0 重新计数，而非累计 120**，且 `currentAttemptPeak() === 60`。

`V3c` 的敏感性已单独验证：把计数器改回实例共享变量（U3 修复前的形态）后，`V3c` 失败。

### 15.4 表述修正

Codex 指出"预检与实测逐项相等"是过度表述。已改为：

> **在所测路径上，预检不低于实测峰值**：已初始化 create 预检 20 / 实测 19，是保守上界（预检偏大 1）。

并补充边界说明：这是**已枚举分支的样本测量**，不是全部平台路径的证明；未枚举分支的偏差由第二层逐操作拦截兜底。三份文档（实施说明 §12.3、U1–U3 收尾、进展与待办）已同步。

### 15.5 本轮改动文件

| 文件 | 改动 |
|---|---|
| `miniapp/tests/schedule-service.test.cjs` | 新增 `gateAfterBothFastReceiptChecks()`、`settleCall`、`countDelta()`、`SNAPSHOT_COLLECTION`、`compileInMemory()`、`seedPendingMemberFixture()`、`interleaveMemberAndMaintenance()`；重写 `U1a`–`U1f`；修正 `U2d`/`T4c` 标题与注释；新增 `V1`、`V2a`–`V2d`、`V3a`–`V3c` |

**未改动**：`schedule-service.js`、`service.js`、`schedule-client.js`、云函数配置、入口配置、旧探针/凭据/env-gate，以及任何测试以外的文件。Codex 原审查与两份离线证据原样保留。
