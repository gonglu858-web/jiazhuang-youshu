# WorkBuddy 收尾：施工安排事务兼容 V1–V3（2026-10-03）

依据：[Codex复核-施工安排事务兼容U1-U3收尾-20261003](Codex复核-施工安排事务兼容U1-U3收尾-20261003.md)

**本轮只修改测试与文档，未改动任何业务实现。** Codex 已独立验证 U1–U3 实现正确；本轮只补正式回归的覆盖缺口。T1/T2/T5 未重做。

## 结论

V1、V2、V3 三项已完成。**关键改进是把"故障敏感性"固化为正式回归**——V1 在内存中删除写事务内回执复核后，`U1a`–`U1d` 四项全部失败（4/4），证明回归不再有覆盖缺口。

全量 **394 项 / 393 通过 / 0 失败 / 1 跳过**。

需要明确的边界：**本地证据已覆盖清单要求，但真实云端事务行为、3 秒超时、桶大小平台限制仍未实测**，部署前需 Codex 另做隔离验证。

## 1. 改动文件（1 个）

| 文件 | 改动 |
|---|---|
| `miniapp/tests/schedule-service.test.cjs` | 新增辅助 `gateAfterBothFastReceiptChecks()`、`settleCall`、`countDelta()`、`SNAPSHOT_COLLECTION`、`compileInMemory()`、`seedPendingMemberFixture()`、`interleaveMemberAndMaintenance()`；重写 `U1a`–`U1f`；修正 `U2d`/`T4c` 标题与注释；新增 `V1`、`V2a`–`V2d`、`V3a`–`V3c` |

**未改动**：`schedule-service.js`（时间戳 21:00）、`service.js`（20:59）、`schedule-client.js`、`schedule-page.test.cjs`、`schedule-client.test.cjs`、`member-access*.test.cjs`、云函数配置、入口配置、旧探针/凭据/env-gate。

已用 `find -newermt` 核实：本轮 21:29 之后**只有 `miniapp/tests/schedule-service.test.cjs` 变化**。

Codex 原审查文档与两份离线证据（`证据/施工安排事务兼容U1-U3收尾复核-20261003.json`、`证据/施工安排事务兼容U1-U3复核补充-20261003.cjs`）原样保留。

## 2. V1：同号并发屏障位置修正

### 问题

原 `U1a`–`U1d` 的 barrier 停在 A 的**快速回执事务提交前**：

```
A 快速事务提交前暂停 → B 完整提交业务+回执 → 恢复 A
                                              └→ A 快速事务冲突重试 → 直接找到回执返回
```

被测的是"快速路径重试后能否找到回执"，**不是**"实际写事务内是否重新检查回执"。原注释"恢复 A 后必须在实际写事务重新查回执"不成立。

Codex 实证：仅在内存中删除四个写回调的 `checkIdempotency` 与命中返回、保留快速返回路径，**现有 `U1a`–`U1d` 仍全部通过**。

### 修正

新增 `gateAfterBothFastReceiptChecks(db)`，包裹 `db.runTransaction`：

```
双方快速回执事务真正执行完 → 断言返回 null → 计数 +1
两个都到位（fastNullReturns === 2）→ 一起放行 → 进入实际写事务
```

这样被测点才是写事务内的回执复核。每个用例都断言 `fastNullReturns() === 2`，确保屏障位置正确。

### 故障敏感性已固化为正式回归（`V1`）

在内存中（`vm.runInThisContext`，**不写磁盘**）删除全部 4 处：

```js
const committed = await checkIdempotency(tx, requestId, payload, actor);
if (committed) return committed;
```

然后重跑 `U1a`–`U1d`，断言四个**都必须失败**，且失败原因涉及各自预期的业务码：

| 用例 | 变异后失败码 | 含义 |
|---|---|---|
| `U1a` create | `SCHEDULE_CONFLICT` | 撞占用检查 |
| `U1b` update | `VERSION_MISMATCH` | 撞业务版本 |
| `U1c` reassign | `VERSION_MISMATCH` | 撞业务版本 |
| `U1d` cancel | `BAD_INPUT` | 撞"已取消" |

**检出率 4/4**。这四个码正是 Codex 独立复现的"已成功提交被误报为业务失败"表现——现在它们被写进断言，删掉实现就会红。

### 保留的断言

每个用例除故障敏感性外还断言：`deepEqual` 双方返回完全相同的原成功结果、业务版本只推进一次、回执/历史/审计各 +1（全集合快照增量）、不得重复落库；`U1c` 另断言双方目录一致；`U1d` 另断言目录只释放一次。`U1e`（不同载荷）改为"一成功一被明确业务码拒绝 + 回执/审计恰好一次"，`U1f`（首次初始化竞争）保持两次成功、同一 `generation=1` 目录含 2 条。

## 3. V2：真实成员入口 × 真实维护路由双向交错

### 问题

| 用例 | 实际覆盖 | 与要求的差距 |
|---|---|---|
| `U2d` 第一半 | 移出受**直接修改 projects** 干扰，完成后才调用维护接口 | 维护事务未与成员写并行，也无"维护重试" |
| `U2d` 第二半 | 移出 × 真实维护路由交错 | 覆盖 `removeMember`，非要求的两个入口 |
| `U2e`/`U2f` | 先切维护、再**顺序**调用 | 非在途冲突；`U2e` 还用了不存在的邀请 + 无效格式编号 |
| `T4c` | 移出 × 直接改 projects | 注释"业务先提交 → 维护切换重试"与实际顺序**相反** |

### 修正

新增两个辅助：

- `seedPendingMemberFixture(db)`：种入**有效的**待批申请（`status: 'requested'`、角色不冲突、有效期到 2030）+ **10 位**绑定编号（`/^\d{10}$/`）+ owner 管理员，使 `approveInvitation`/`assignManager` 走真实 `codeUser`/`verifyCodeForUser` 校验路径。
- `interleaveMemberAndMaintenance(db, action, first, body)`：把"先提交方"卡在其事务提交前（按 `writeSet` 是否含 `project_members`/`projects` 区分），另一方**经真实 `setScheduleWriteMode` 路由**完整跑完后再恢复。**干扰不用直接修改 projects 模拟。**

### 四例结果（与 Codex 独立复现一致）

| 用例 | 先提交方 | 被暂停并恢复 | attempts | epoch | 最终状态 |
|---|---|---|---|---|---|
| `V2a` | `approveInvitation` | 维护事务 | ≥3 | 1→2→**3** | 成员已加入（active）、锚点代际 0 / schema 1、申请 `approved`、编号已消费（hash 置 null）、批准审计 1 条 |
| `V2b` | 维护切换 | `approveInvitation` | ≥3 | 1→**2** | `PROJECT_NOT_WRITABLE`、**无新增成员**、申请仍 `requested`、编号未消费、批准审计 0 条 |
| `V2c` | `assignManager` | 维护事务 | ≥3 | 1→2→**3** | 管家已指定（`roles: ['管家']`）、锚点代际 0、编号已消费、指定审计 1 条 |
| `V2d` | 维护切换 | `assignManager` | ≥3 | 1→**2** | `PROJECT_NOT_WRITABLE`、**无新增管家**、编号未消费、指定审计 0 条 |

四例均断言最终 `scheduleWriteMode === 'maintenance'`，且 `attempts >= 3`（确实观察到冲突重试）。

### 注释修正

- **`U2d`** 标题改为 `removeMember conflicts with maintenance switch on the same project document (both orders)`，并加说明块：两半都不是与真实维护路由并行交错、第一半是顺序调用、第二半覆盖的是 `removeMember`，真正交错见 `V2a`–`V2d`。
- **`T4c`** 标题改为 `removeMember is rejected when maintenance state is committed while it is in flight`，注释改为实际顺序（移出先暂停 → 直接改 projects → 恢复后被拒），并明确标注**不经过** `setScheduleWriteMode` 路由。

两个用例保留为回归，但不再宣称覆盖它们实际未覆盖的场景。

## 4. V3：受控预算注入与重入计数可量化断言

### 问题

原 `U3d` 标题宣称"rejects before any write with zero writes"，但实际是：事务外直接调 `assertWithinBudget` 检查公式 → 再成功执行 26 桶更新 → 断言写入**大于零**。既没检查超限真实业务路径的底层写调用为 0，也没断言拒绝后全集合不变。

### 修正

新增 `compileInMemory({ find, replace })`：`vm.runInThisContext` 编译内存副本，并断言注入确实修改了源码文本（否则用例无效）。**不写磁盘。**

| 用例 | 内容 |
|---|---|
| `V3a` | 注入 `FIXED_CREATE` 18 → 90，经**真实 `createSchedule` 路由**执行；底层夹具 `appBudget: null`（只保留平台 100）。断言 `SCHEDULE_OPERATION_BUDGET_EXCEEDED`、**`getWriteCount() === 0`**、`JSON.stringify(db.getData())` 与执行前**逐字节相同** |
| `V3b` | 对照：未注入时同一路由 365 天创建成功、确有真实写入（`getWriteCount() > 0`）、峰值 ≤ 80、13 个月度桶、`snapshotAll8` 前后不同。**首写前拒绝 ≠ 写后回滚** |
| `V3c` | 用冲突夹具制造一次真实 SDK 重入：第一次 attempt 在提交前被外部改动它读过的 `projects` 文档（必须读该文档，否则冲突检测不到）。在 `db.runTransaction` 外层逐 attempt 记录底层实际操作数，断言 **`perAttempt = [60, 60]`**——第二次从 0 重新计数而非累计 120，且 `currentAttemptPeak() === 60` |

`V3c` 的敏感性已单独验证：把计数器改回实例共享变量（U3 修复前的形态）后 `V3c` 失败（`currentAttemptPeak()` 变为 0）。

## 5. 表述修正

Codex 指出"预检与实测逐项相等"是过度表述。已改为：

> **在所测路径上，预检不低于实测峰值**：已初始化 create 预检 20 / 实测 19，是保守上界（预检偏大 1）。

并补充边界：**这是已枚举分支的样本测量，不是全部平台路径的证明**。未枚举分支（例如未来新增字段带来的额外读取）仍可能使实际峰值高于预检；这类偏差由第二层逐操作拦截兜底（每次 attempt 独立计数、第 81 次在写入前拒绝），不会写坏数据。

已同步三份文档：实施说明 §12.3、U1–U3 收尾、进展与待办。

## 6. 验证结果

```
cd miniapp && node --test --test-reporter=spec tests/*.test.cjs
```

**tests 394 / pass 393 / fail 0 / skipped 1**

| 文件 | 项数 |
|---|---|
| `schedule-service.test.cjs` | 148（36 `compat *` + 19 `T1*`–`T7*` + 17 `U1*`–`U3*` + 8 `V1*`–`V3*`） |
| `schedule-client.test.cjs` | 47 |
| `schedule-page.test.cjs` | 24 |
| `member-access.test.cjs` | 17 |
| `member-access-schedule.test.cjs` | 13 |

- JS/JSON 语法、8 页面路由、`git diff --check`：通过
- 入口 `enabled=false`、`allowedProjectIds=Object.freeze([])`、顶层与嵌套均冻结：确认未变
- 本轮未安装、未取号、未创建资源、未改云端模式与超时、未预览/部署/发布

## 7. 未验证项

沿用上一轮清单，本轮未新增实测：

1. **未实测云端事务行为**：`where` 不支持、100 操作上限、30 秒上限均来自官方文档。
2. **未实测 3 秒超时耗时**：不建议实测前放行。
3. **桶大小与目录上限未在真实平台核对**：月桶最坏 2265 B、目录 32 KiB 为本地计算/自定值。
4. **实际 SDK 用例仍 1 跳过**：本机未安装 SDK。Codex 复核轮记录其使用已有 SDK 路径，但该用例仅为 `checkTransaction` 入口离线回归，**不证明新增施工写路由或云端事务通过**。
5. **`projects` 字段缺失的兼容影响**：同时阻止 `removeMember` / `approveInvitation` / `assignManager`；A/B/C 兼容准备仍是部署前门槛。
6. **恢复 ready 通道封闭**：`MAINTENANCE_RESTORE_BLOCKED`，已知临时限制。
7. **维护修复脚本与就绪核验流程未实现**。
8. **并发幂等与维护交错只在模拟冲突检测下验证**：`V1`/`V2` 使用具备读值快照与写集冲突检测的内存夹具；真实云数据库的事务冲突判定与重试时机**未实测**。
9. **`V1`/`V3` 的故障敏感性基于源码文本变异**（`vm` 内存编译）：能证明"删掉这几行测试会红"，但变异是文本级的，不覆盖语义等价的其他缺陷变体。
10. **索引回读未执行**：按裁决由 Codex 在创建资源前完成。

## 8. 边界声明

- 入口保持 `enabled=false`、`allowedProjectIds=[]`，顶层与嵌套均冻结。
- 未改旧探针、旧凭据、env-gate。
- 未安装、未取号、未创建集合或索引、未改云端模式与超时、未预览/部署/发布。
- 全程使用内存合成数据，未触达云端；V1/V3 的源码变异仅存在于内存，不落盘。
- 用户无需扫码、取号或手机操作。
