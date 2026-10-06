# WorkBuddy 收尾：施工安排事务兼容 U1–U3（2026-10-03）

依据：[Codex复核-施工安排事务兼容T1-T7返修-20261003](Codex复核-施工安排事务兼容T1-T7返修-20261003.md)

原 11 条复现已通过，本轮**未重做已关闭的 T1/T2/T5 实现**，只处理 U1–U3。Codex 原审查文档与离线证据原样保留（时间戳 20:50–20:53，未覆盖）。

## 结论

U1、U2、U3 三项均已修复并补入确定性回归测试。全量 **386 项 / 385 通过 / 0 失败 / 1 跳过**。

需要明确的边界：**本地证据已覆盖清单要求，但真实云端事务行为、3 秒超时、桶大小平台限制仍未实测**，部署前需 Codex 另做隔离验证。

## 1. 改动文件（3 个）

| 文件 | 改动 |
|---|---|
| `miniapp/cloudfunctions/memberAccess/schedule-service.js` | 四个写回调恢复事务内回执复核；`setMaintenanceMode` 接收执行人并事务内重验、封闭 ready 分支；计数器改为每次 SDK 回调私有闭包；预检常量改为实测上界；导出事务包装供隔离验证 |
| `miniapp/cloudfunctions/memberAccess/service.js` | `setScheduleWriteMode` 路由传入执行人并更新注释 |
| `miniapp/tests/schedule-service.test.cjs` | 夹具扩展（`appBudget: null`、`getExecutedOps`、`app_admins`/`invitations` 集合）+ 新增 `twoServices()` + 17 项 `U1*`–`U3*` + 重写 `T3b`/`T3d` |

**未改动**：`schedule-client.js`、`schedule-client.test.cjs`、`schedule-page.test.cjs`、`member-access.test.cjs`、`member-access-schedule.test.cjs`、云函数 `config.json`、入口配置、旧探针/凭据/env-gate。

## 2. U1：实际写事务内重新检查回执

### 问题

T6 把回执检查移到独立事务 `tryReceiptReplay`，实际写事务内的 `checkIdempotency` 被删除。两个同号请求可能都先查到"无回执"，其中一个先提交，另一个冲突重试/重扫后直接撞上占用/版本/取消状态，**把已成功的提交报成业务失败**：

| 同号同载荷动作 | 先完成 | 后完成（Codex 复现） | 原因 |
|---|---|---|---|
| create | 成功 | `SCHEDULE_CONFLICT` | 撞占用检查 |
| update | 成功 | `VERSION_MISMATCH` | 撞业务版本 |
| reassign | 成功 | `VERSION_MISMATCH` | 撞业务版本 |
| cancel | 成功 | `BAD_INPUT 已取消` | 撞取消状态 |

**不是重复落库**，新增审计/回执也只有一次；缺陷是成功请求被错误报告成业务失败。

### 修复

四个写回调（`createSchedule` / `updateSchedule` / `reassignSchedule` / `cancelSchedule`）在实际写事务内，顺序为：

```
verifyActorInTransaction → assertProjectWritable → checkIdempotency → 目录/容量/版本/占用 → 写
```

命中回执即 `return committed`。独立快速返回路径保留（避免无回执时多跑一次扫描）。

### 语义未被放宽

| 场景 | 结果 | 来源 |
|---|---|---|
| 同号同载荷且已提交 | 返回原成功结果 | `checkIdempotency` |
| 同号不同载荷 | `REQUEST_ID_REUSED_DIFFERENT_PAYLOAD` | `checkIdempotency` |
| 执行人失权 | `NO_ACCESS` | `verifyActorInTransaction` |
| 项目处于维护 | `PROJECT_NOT_WRITABLE` | `assertProjectWritable` |
| 回执属于其他账号 | `NO_ACCESS` | `checkIdempotency` |

后三者**都不因为有回执而放行**。

### 回归

- `U1a`–`U1d`：四动作同号同载荷并发。**两个独立服务实例共享具备读值快照与写集冲突检测的内存库**；用 barrier 确保双方先完成"无回执"检查，再让 B 完整提交、A 恢复。断言：双方 `deepEqual` 返回完全相同的原成功结果、业务版本只推进一次、回执/审计/历史恰好一次、不得重复落库。
- `U1e`：同号不同载荷并发 → 明确业务码 `REQUEST_ID_REUSED_DIFFERENT_PAYLOAD`，**不是 SDK 重复键错误**；保留先提交者载荷。
- `U1f`：首次初始化竞争（两个不同 requestId、不同日期）→ 两次成功、两份安排、同一 `generation=1` 目录含 2 条、锚点代际 1。

### 代价

每次写事务新增回执复核，26 桶最坏峰值由 74 升为 **75**，仍 ≤ 80。

## 3. U2：维护切换事务内重验权限；ready 恢复封闭

### 问题

- `setScheduleWriteMode` 只在事务外 `managerAccess`；`setMaintenanceMode` 不接收执行人、只检查项目存在就切换 → 事务外鉴权后把执行人设为 disabled、成员设为 left，切换仍返回成功。
- 项目处于 maintenance 时可直接切 ready。

### 修复

1. `setMaintenanceMode(projectId, mode, actor)` **必须接收执行人**，事务内调用 `verifyActorInTransaction` 重新核验账号启用状态、管家角色、项目有效范围。
2. `mode === 'ready'` **一律拒绝**，抛 `MAINTENANCE_RESTORE_BLOCKED`，**不写任何字段**，项目停留在 maintenance。就绪核验/迁移流程尚未实现，不以注释代替入口约束。
3. 已处于目标模式时返回 `changed: false`，不重复递增 epoch。
4. `service.js` 路由注释改为"事务外鉴权仅作快速失败"。

### 回归

| 用例 | 场景 | 断言 |
|---|---|---|
| `U2a` | 事务外鉴权后账号被停用 | `IDENTITY_DISABLED`，仍为 ready |
| `U2b` | 事务外鉴权后成员被设为 left | `NO_ACCESS`，仍为 ready |
| `U2c` | maintenance 下请求 ready | `MAINTENANCE_RESTORE_BLOCKED`，仍为 maintenance，epoch 未变 |
| `U2d` 顺序一 | 成员写先提交 → 维护切换 | 切换基于事务内最新 epoch 递增成功；成员已 left |
| `U2d` 顺序二 | 维护切换先提交 → 成员写 | 成员写重扫后 `PROJECT_NOT_WRITABLE`；成员保持 active |
| `U2e` | 维护先提交 → `approveInvitation` | `PROJECT_NOT_WRITABLE`，epoch 未变，未新增成员 |
| `U2f` | 维护先提交 → `assignManager` | `PROJECT_NOT_WRITABLE`，epoch 未变，仍只有原管家 |

> `T4c` 只测 `removeMember` 且直接改 `projects` 模拟干扰，注释与实际提交顺序相反；已由 `U2d`–`U2f` 覆盖真实路由的双向交错，`T4c` 保留为回归。

### 旧项目兼容影响已更新

`projects` 字段缺失/未就绪的项目，现在**同时阻止**：

- `removeMember`（`compat 5d`）
- `approveInvitation`（`U2e`）
- `assignManager`（`U2f`）

这是**兼容拒绝，不是"旧项目完全不受影响"**。A/B/C 项目的兼容准备仍由 Codex 在部署前另做；本地实现不静默填 `ready`，本轮未改任何云记录。

## 4. U3：attempt 计数隔离与预算上界修正

### 问题

1. `attemptOps/attemptPeak` 定义在 `createScheduleService` 作用域，每次 transaction 重置同一变量 → 同实例并发互相重置/累计。
2. `wrapTx` 只缓存**集合包装对象**，注释却称"重复读取可复用"，属**虚构缓存**。
3. 预检 70 / 实测 74 不相等，低估式不能当完整上界；其余动作也有低估（18/19、16/22）。
4. `T3b` 直接调 `db.runTransaction`，没经过产品包装，断言的是夹具码而非产品码；读取常量不能证明产品边界。

### 修复

**计数器隔离**：

```js
function createTxnOpCounter() { /* 每次 SDK 回调私有闭包 */ }
function wrapTx(tx, counter) { /* counter 由该回调的 wrapTx 传递 */ }
async function transaction(work) {
  return db.runTransaction(async tx => {
    const counter = createTxnOpCounter();   // 每次调用回调都是新计数器
    return work(wrapTx(tx, counter));
  });
}
```

边界语义：**允许前 80 次；第 81 次在调用底层 SDK 之前拒绝**（不是"第 80 次被拒绝"）。

**预检改为实测上界**（不再是低估值）：

| 常量 | 值 | 来源 |
|---|---|---|
| `FIXED_CREATE` | 18 | 首用 18 / 已初始化 17 → 取最大 |
| `FIXED_UPDATE_BASE` | 18 | 不换人 18 |
| `UPDATE_WORKER_CHANGED_EXTRA` | 5 | 换人 23 − 18 |
| `FIXED_REASSIGN` | 23 | 实测 |
| `FIXED_CANCEL` | 16 | 实测 |
| `FIXED_REMOVE_MEMBER` | 13 | 实测 |
| 未知动作兜底 | 23 + 26 | 最大固定 + 最大单侧桶数 |

### 实测操作峰值（`T3d` 输出，U1/U3 修复后重测）

| 动作 | 分支 | 桶数 | 实测峰值 | 预检 | 上限 |
|---|---|---|---|---|---|
| `create` | 首用 | 1 | **20** | 20 | 80 |
| `create` | 已初始化 | 1 | 19 | 20 | 80 |
| `create` | 365 天 | 13 | **44** | 44 | 80 |
| `update` | 最坏：换人 + 换工种 | 26 | **75** | 75 | 80 |
| `reassign` | 换责任人 | 0 | **23** | 23 | 80 |
| `cancel` | 365 天 | 13 | **42** | 42 | 80 |
| `removeMember` | 无 active 安排 | 0 | **13** | 13 | 80 |

**在所测路径上，预检不低于实测峰值**：已初始化 create 预检 20 / 实测 19，是保守上界（预检偏大 1）。

这是对**已枚举分支的样本测量**，不是对全部平台路径的证明——未枚举的分支（例如未来新增字段导致的额外读取）仍可能使实际峰值高于预检；这类偏差由第二层逐操作拦截（每次 attempt 独立计数、第 81 次拒绝）兜底，不会写坏数据。

26 桶最坏路径 **75 ≤ 80，属所测路径中的可支持路径，365 天能力未被本次改动缩减**。

**旧数值全部作废**：初稿 38/64/15/10、T1–T7 轮的 19/22/41/74/13 与 18/16/15/14/9 预检，均不再作为返修后证据。

### 回归

| 用例 | 内容 |
|---|---|
| `U3a` | 底层夹具 `appBudget: null`（**无 80 拦截、只保留平台 100**），经真实产品 `transaction()` 读满 80 次成功；第 81 次抛产品 `SCHEDULE_OPERATION_BUDGET_EXCEEDED`，且核实底层只执行 80 次（总执行 160） |
| `U3b` | 同实例两个并发 attempt：A 读 60 → 暂停 → B 读 10 → A 再读 30。A 累计 90 被产品拒绝，证明互不重置 |
| `U3c` | SDK 冲突重入后新 attempt 从 0 计数并成功 |
| `U3d` | 首写前预检语义：超限抛预算码；26 桶可支持路径必须有真实写入且产生真实变更（**首写前拒绝 ≠ 写后回滚**） |
| `U3e` | 各分支断言 **预检 ≥ 实测峰值**（不得低估）且 ≤ 80 |
| `T3b` | 改为只锁定常量口径，并注明"读取常量本身不构成边界证据" |
| `T3d` | 输出各分支实测峰值 + 逐项核对预检为上界 |

## 5. 验证结果

```
cd miniapp && node --test --test-reporter=spec tests/*.test.cjs
```

**tests 386 / pass 385 / fail 0 / skipped 1**

| 文件 | 项数 |
|---|---|
| `schedule-service.test.cjs` | 140（含 36 `compat *` + 19 `T1*`–`T7*` + 17 `U1*`–`U3*`） |
| `schedule-client.test.cjs` | 47 |
| `schedule-page.test.cjs` | 24 |
| `member-access.test.cjs` | 17 |
| `member-access-schedule.test.cjs` | 13 |

- JS/JSON 语法、8 页面路由、`git diff --check`：通过
- WXML/WXSS 真实编译：WorkBuddy 本机无 `wcc-exec`，**未执行，不记为通过**
- 入口 `enabled=false`、`allowedProjectIds=Object.freeze([])`、顶层与嵌套均冻结：确认未变

## 6. 未验证项

1. **未实测云端事务行为**：`where` 不支持、100 操作上限、30 秒上限均来自官方文档。
2. **未实测 3 秒超时耗时**：操作数下降是数量级改善，但外层鉴权、冷启动、重试与查询耗时未知；**不建议实测前放行**。
3. **桶大小与目录上限未在真实平台核对**：月桶最坏 2265 B、目录 32 KiB 均为本地计算/自定值。
4. **实际 SDK 用例仍 1 跳过**：本机未安装 SDK、未配置 `MEMBER_ACCESS_SDK_PATH`。Codex 复核轮记录其使用已有 SDK 路径，但该用例仅为 `checkTransaction` 入口离线回归，**不证明新增施工写路由或云端事务通过**。
5. **`projects` 字段缺失的兼容影响已扩大**：同时阻止 `removeMember` / `approveInvitation` / `assignManager`（见 §3）。
6. **恢复 ready 通道当前封闭**：`setScheduleWriteMode(mode='ready')` 一律拒绝，项目必须停留在 maintenance。这是**已知的临时限制**——维护只能由后续独立流程解除。
7. **维护修复脚本与就绪核验流程未实现**：仅有切到 maintenance 的能力与"失败保持 maintenance"的语义基础。
8. **并发幂等只在模拟冲突检测下验证**：`U1a`–`U1f` 使用具备读值快照与写集冲突检测的内存夹具。真实云数据库的事务冲突判定与重试时机**未实测**。
9. **`attemptOps` 隔离的边界已澄清**：`index.js` 每次调用创建独立 service，因此**不存在已证实的跨云调用共享计数**。U3 修复的是"复用同一实例时违反每 attempt 独立预算"以及并发测试污染。
10. **索引回读未执行**：按裁决由 Codex 在创建资源前完成；本轮未建/删任何索引。

## 7. 边界声明

- 入口保持 `enabled=false`、`allowedProjectIds=[]`，顶层与嵌套均冻结。
- 未改旧探针、旧凭据、env-gate。
- 未安装、未取号、未创建集合或索引、未改云端模式与超时、未预览/部署/发布。
- 全程使用内存合成数据，未触达云端。
- 用户无需扫码、取号或手机操作。
