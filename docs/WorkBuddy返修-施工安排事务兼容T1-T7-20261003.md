# WorkBuddy 返修：施工安排事务兼容 T1–T7（2026-10-03）

依据：[Codex复查-施工安排事务兼容本地实施-20261003](Codex复查-施工安排事务兼容本地实施-20261003.md)（结论：不通过，须完成 T1–T7 返修）。

Codex 原审查文档与离线复现证据**原样保留**，本文件为返修后的结果记录。

- 边界：入口保持 `enabled=false`、`allowedProjectIds=[]`、嵌套冻结；不改旧探针/凭据/env-gate；不操作云端、不安装、不取号、不预览/部署/发布。
- 结论：T1–T7 全部修复并补入确定性回归测试；**未发现新的实现缺陷**。

## 1. 修改文件

| 文件 | 改动 |
|---|---|
| `miniapp/cloudfunctions/memberAccess/schedule-service.js` | T1 首用真实扫描；T2 完整桶键并集 + 每桶读一次写一次；T3 产品侧逐 attempt 80 次计数；T5 采集期版本稳定性；T6 回执优先外层 |
| `miniapp/cloudfunctions/memberAccess/service.js` | T4 `assertScheduleWritableInTx` + `guardAndBumpEpoch`，`approveInvitation`/`assignManager` 事务内校验并递增 epoch |
| `miniapp/tests/schedule-service.test.cjs` | 夹具：`denyInTxn` 第一步无条件拒绝、新增 `getWriteCount`/`resetWriteCount`/`resetPeak`；新增 19 项 `T1*`–`T7*` 回归；`compat 7b` 改确定性；`transaction conflict retry…` 交错点改为 schedules 写入 |

**未改动**：`schedule-client.js`、`member-access-schedule.test.cjs`、`member-access.test.cjs`、`schedule-client.test.cjs`、入口配置、旧探针/凭据/env-gate。

## 2. 逐项返修结果

### T1 首用分支跳过实际扫描 → 已修

- 复现：`generation=0` + guard 缺失 + 存在一条 active 安排 → `removeMember` 成功，成员变 `left`，安排遗留。
- 修复：`collectPreconditions` 对 `first-use` **同样执行真实有界扫描**；`verifyPreconditions` 在 first-use 下若实际集合非空抛 `GUARD_INCONSISTENT`，**不建立覆盖事实的空目录**。
- 回归：`T1a`（移出被拒 + 八集合快照不变 + 成员保持 active）、`T1b`（create 被拒且不建目录）。

### T2 改期只读新日期桶 → 已修

- 复现：1 月 1 日安排改到 2 月 1 日被误报 `OCCUPANCY_INCONSISTENT`。
- 修复：新增 `buildBucketKeys(projectId, {oldDays, oldTrade, newDays, newTrade})` 以完整键 `(projectId, trade, month)` 建并集，旧工种只取旧日期桶、新工种只取新日期桶，同键去重；`readBucketsForKeys()` 每桶读一次并保留 `existed`；`writeBuckets()` 复用已读存在性写一次；删除 `mergeBucketsMulti` 与 `upsertBucket` 的二次读。
- 回归：`T2a`（同工种跨不相交月份成功，旧 1 月桶释放、新 2 月桶占用）、`T2b`（跨工种，新旧工种各一桶）、`T2c`（跨年两年各一桶）。

### T3 预算漏计 + 产品无逐操作保护 → 已修

- 复现：26 桶最坏路径在夹具第 81 次操作被拦（已尝试 22 次写）；取消夹具 80 拦截后第 101 次仍触发（已尝试 33 次写）。
- 修复：
  - 消除 `upsertBucket` 二次读；预算改按**完整桶键**计数（同月不同工种算两个键）。
  - 产品 `transaction()` 用 `wrapTx` 包装事务视图，`countTxnOp` 对**每次 attempt 独立计数**，达到第 80 次立即拒绝后续数据操作——**不依赖测试夹具替产品阻断**。
  - 双层保护：首写前 `assertWithinBudget()` 预检（超限无任何写入）+ 逐操作 80 拦截。
- 回归：`T3a`（26 桶最坏路径**成功**、峰值 ≤ 80、26 桶完整变更、写调用 > 0）、`T3b`（产品常量 80/100）、`T3c`（三动作峰值与常量核对）、`T3d`（逐动作峰值报告）。
- **重要更正**：旧估算"38/64/15/10"与"最坏 66、余 14"**均不成立**。实测见 §3。

### T4 维护模式仍可批准成员/指定管家 → 已修

- 复现：项目处于 maintenance 时 `approveInvitation` 仍批准并消费编号、`assignManager` 仍成功添加管家，两者 epoch 均保持 1。
- 修复：新增 `assertScheduleWritableInTx(project)`（校验 `scheduleWriteMode`/`scheduleSchemaVersion`/`scheduleEpoch`）与 `guardAndBumpEpoch(tx, projectId)`（**真实递增 epoch**）；两个入口在事务内先过守卫再写入；重新加入保留既有 `taskDirGeneration`。
- 回归：`T4a`（维护期批准被拒、epoch 不变、不新增成员）、`T4b`（维护期指定管家被拒、epoch 不变）、`T4c`（业务事务与维护切换在同一 projects 文档上真实冲突，移出重扫后以 `PROJECT_NOT_WRITABLE` 拒绝、成员保持 active）。

### T5 外层混合快照先判损坏 → 已修

- 复现：采集先读到 `generation=0`，随后另一提交原子形成 `generation=1` 成员+guard 并推进 epoch，再读 guard → 立即报 `TASK_DIR_INCONSISTENT`，事务尝试数 0。
- 修复：`collectPreconditions` 记录**扫描前后**的围栏与代际，不一致抛 `STALE_SCAN`；`runWithScanRounds` 的 `collect` 阶段也纳入同一最多两轮预算。结构判定放在复核之后，真实损坏仍拒绝。
- 回归：`T5a`（采集期目录被建立 → 重扫后成功移出，不得报损坏）、`T5b`（真实损坏——`generation=0` 却存在 `generation=1` 目录——仍被拒）。

### T6 回执优先不完整 + 可绕过维护 → 已修

- 复现一：创建成功后目录被删，原号重试在事务外被目录错误挡住。
- 复现二：外层采集后切 maintenance 并递增 epoch，事务内 `verifyActorInTransaction` 不查模式，已有回执立即返回成功。
- 修复：新增 `withReceiptFirst` + `tryReceiptReplay`——先在**独立事务内**核验可信身份、项目权限与维护策略（含 `assertProjectWritable`），再优先处理回执；回放**不依赖**新写所需的目录/容量/旧业务版本；新请求才进入 `runWithScanRounds` 的完整检查。四个写动作全部切换。
- 回归：`T6a`（目录删除后原号重试返回原结果、不产生第二份安排）、`T6b`（维护切换后回放被 `PROJECT_NOT_WRITABLE` 拒绝）、`T6c`（失权后回放被 `NO_ACCESS` 拒绝）、`T6d`（同号不同载荷仍 `REQUEST_ID_REUSED_DIFFERENT_PAYLOAD`）。

### T7 测试接受错误结果 → 已修

- 修复：
  - `compat 7b` 与新增 `T3a` 改为**确定性期望**：26 桶最坏路径必须成功且峰值 ≤ 80（旧版条件分支会放过 `OCCUPANCY_INCONSISTENT`）。
  - 夹具 `denyInTxn` 去掉 `currentOps > 0` 前提——事务**第一步** `where` 即无条件拒绝。
  - 夹具新增 `getWriteCount()`/`resetWriteCount()`，可断言"首写前拒绝"（写调用 **0**），区分于写后回滚；新增 `resetPeak()` 供逐动作峰值测量。
  - 交错测试使用**真实检测写冲突并重入**的 `createConflictMockDb`（`T4c`/`T5a`）。
  - 完整快照 `snapshotAll8` 含 `projects`。
- 回归：`T7a`（事务第一步 `where` 无条件拒绝）、`T1a`/`T1b`（拒绝后八集合完全不变）。

## 3. 实际操作次数表（返修后实测）

计数口径：每类文档读/写各计 1；桶按完整键 `(projectId, trade, month)`，每桶读一次 + 写一次。数据来自 `T3d` 实测输出。

| 动作 | 场景 | 实测峰值 | 应用层预检 | 上限 |
|---|---|---|---|---|
| `create` | 3 天 / 1 桶 | **19** | 18 | 80 |
| `reassign` | 换责任人 | **22** | 16 | 80 |
| `cancel` | 365 天 / 13 桶 | **41** | 40 | 80 |
| `update` | 最坏：日期不变 + 换人 + 换工种 = 26 桶键 | **74** | 70 | 80 |
| `removeMember` | 无 active 安排 | **13** | 9 | 80 |

**26 桶最坏路径属可支持路径**（74 ≤ 80），365 天能力未缩减。旧实现的 38/64/15/10 与"最坏 66、余 14"已作废。

## 4. 测试结果

```
cd miniapp && node --test --test-reporter=spec tests/*.test.cjs
```

**tests 369 / pass 368 / fail 0 / skipped 1**

- `schedule-service.test.cjs`：123 项（36 项 `compat *` + 19 项 `T1*`–`T7*` + 既有 H3 交错/回滚/恰好一次）
- `schedule-client.test.cjs`：47 项
- 跳过 1 项：`member-access-sdk.test.cjs` 的实际 SDK 用例，**未安装 SDK、未配置 `MEMBER_ACCESS_SDK_PATH`**
- JS/JSON 语法、8 页面路由：通过
- WXML/WXSS 真实编译：本机无 `wcc-exec`，**未执行，不记为通过**

## 5. 未验证项与已知影响

1. **未实测云端事务行为**：`where` 不支持、100 操作、30 秒上限均来自官方文档；本轮未在云端调用复现，未创建集合/索引。
2. **未实测 3 秒超时耗时**：操作峰值下降是数量级改善，但冷启动、外层鉴权、重试与查询耗时未知；**不建议实测前放行**。
3. **桶大小与目录 32 KiB 未在真实平台核对**：月桶最坏 2265 B 为本地计算；32 KiB 为本轮保守自定值。
4. **未安装 wx-server-sdk**：实际 SDK 请求形状用例仍跳过；SDK 路径可加载**不等于**云端事务通过。
5. **`projects` 字段缺失会阻止旧项目移出**：`T4a`/`T4b`/`compat 5d` 均断言 `PROJECT_NOT_WRITABLE`。这是**兼容拒绝**，不是"旧项目不受影响"；A/B/C 项目需 Codex 在部署前补充兼容/准备方案。
6. **维护修复脚本未实现**：仅提供 `setScheduleWriteMode` 与"失败保持 maintenance"的语义基础；幂等、checkpoint、重入不重置代际与就绪验证证据**尚不具备**。§12.5 已明确不列为已覆盖。
7. **平台夹具为本地模拟**：事务内 `where` 拒绝与操作计数按官方文档建模，**不能替代真实云端验证**。
8. **索引回读未执行**：按裁决由 Codex 在创建资源前完成；本轮未建/删任何索引。

## 6. 交 Codex 复查

请重点核对：

a. T1 首用真实扫描是否覆盖 create、移出与首次初始化竞争三种路径。
b. T2 桶并集是否按完整键去重、是否避免"所有工种×所有月份"的扩大。
c. T3 产品 80 次双层保护是否真正在 `schedule-service.js` 内，而非依赖夹具；26 桶峰值 74 是否与预检 70 一致。
d. T4 两个成员写入口的维护守卫与 epoch 递增是否在同一事务内。
e. T5 采集期版本稳定性依据是否充分；`T5b` 是否证明真实损坏未被吞掉。
f. T6 回执优先是否仍核验当前权限与维护策略（`T6b`/`T6c`）。
g. T7 夹具第一步 `where` 拒绝与 `getWriteCount()` 是否能区分首写前拒绝与写后回滚。
