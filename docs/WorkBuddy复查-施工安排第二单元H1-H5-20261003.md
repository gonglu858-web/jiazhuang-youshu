# 施工安排第二单元 H1–H5 本地返修完成报告

日期：2026-10-03。执行：WorkBuddy。下一步：Codex 复查。

约束保持：
- 入口配置 `miniapp/miniprogram/config/schedule-entry-proof.js`：`enabled=false`、`allowedProjectIds=[]`、嵌套 `Object.freeze`。
- 未修改旧探针、凭据、env-gate。
- 未操作云端、未安装依赖、未预览/部署/发布。
- 未创建真实数据库集合/索引。

---

## 一、验证结果

### 1.1 全量测试

```text
node --test --test-reporter=spec miniapp/tests/*.test.cjs
# 251 tests: 250 pass, 0 fail, 1 skipped
```

- 跳过项为 `实际 SDK：入口允许空负责人记录，仍拒绝权限和网络错误，全程无业务写入`，原因：未配置本机 wx-server-sdk 路径。
- 新增 14 项测试覆盖 H1–H5（见第三节）。

### 1.2 语法与路由检查

- 使用 `node --check` 遍历 `miniapp/miniprogram` 下全部 `.js` 文件，均通过。
- 使用 `JSON.parse` 遍历全部 `.json` 文件，均通过。
- 校验 `miniapp/project.config.json` 的 `miniprogramRoot === 'miniprogram/'`，通过。
- 校验 `miniapp/miniprogram/app.json` 中 8 个页面路由文件（`.js`/`.json`/`.wxml`）齐全，通过。
- `miniapp/scripts/check.cjs` 在沙箱下 spawnSync 会触发 EBUSY，未直接运行；上述检查与其等价。
- WXML/WXSS 真实编译：WorkBuddy 执行环境不可访问本机微信开发者工具 wcc-exec，跳过，不记为通过。

### 1.3 Git 检查

```text
git diff --check
# 通过；仅 LF → CRLF 转换警告
```

---

## 二、逐项改动

### H1 / 未知结果保护、错误分类与完整快照重试

**问题**：网络/超时/响应缺失等未知结果被误当 recoverable；用户可未经核验点击“我已核对”清除未知状态，导致可能创建第二份安排；重试时读取当前页面输入而非原请求。

**改动文件**：
- `miniapp/miniprogram/utils/schedule-client.js`
  - 新增 `classifyError(err)`：
    - 网络、超时、响应缺失、HTTP 5xx → `{ kind: 'unknown' }`
    - 服务端明确业务错误码 → `{ kind: 'business' }`
    - 入口/版本/项目/配置拒绝 → `{ kind: 'entry' }`
    - 字段校验失败 → `{ kind: 'validation' }`
  - `call()` 在 `err` 上附加 `kind`，并导出 `classifyError`。

- `miniapp/miniprogram/pages/schedule/schedule.js`
  - data 新增 `errorKind: null`（取值 `blocking` | `recoverable`）。
  - `pendingRequest` 扩展为完整快照：`projectId`、`scheduleId`、`version`、`requestId`、`cloudForm`、`reason`、`expectedConfirmed`、`isEdit`、`payload`、状态。
  - 新增 `guardUnknown()`：当 `errorKind === 'blocking'` 时，所有输入/选择/提交处理器短路。
  - `save()`：
    - `errorKind === 'blocking'` 时禁止提交；
    - recoverable 或 fresh 时使用当前表单生成快照与 requestId；
    - 重试 unknown 时直接使用 `pendingRequest` 快照，不读取页面。
  - `saveCloud()`：新/ recoverable 请求从当前表单构建快照；retry 分支复用快照。
  - `handleSendError()`：unknown → `errorKind='blocking'`；business/validation → `errorKind='recoverable'`。
  - 移除 unknown 状态的“我已核对”清除路径。

- `miniapp/miniprogram/pages/schedule/schedule.wxml`
  - 保存按钮禁用条件改为 `errorKind === 'blocking'`。
  - unknown 状态卡片仅显示“重试”按钮，移除“我已核对”按钮。

- `miniapp/miniprogram/pages/schedule-detail/schedule-detail.js`
  - data 新增 `errorKind`；`pendingCancel` 保存完整快照：`requestId`、`version`、`reason`、`scheduleId`、`projectId`。
  - 取消重试复用快照中的 `requestId`/`version`/`reason`。
  - `handleCancelError()` 分类 unknown vs recoverable；unknown 时锁定并仅允许重试。
  - 移除 unknown 状态的“我已核对”清除路径。

- `miniapp/miniprogram/pages/schedule-detail/schedule-detail.wxml`
  - unknown 取消卡片仅显示“重试取消”。

### H2 / 明确业务失败后允许修改保存

**问题**：业务错误（如空内容 `BAD_INPUT`）后表单被锁定，修改内容仍无法保存。

**改动文件**：
- `miniapp/miniprogram/pages/schedule/schedule.js`
  - business/validation 错误设置 `errorKind='recoverable'`，不锁定输入。
  - 用户修改表单后，保存按钮可用；`saveCloud()` 检测到表单签名变化时分配新 requestId。

- `miniapp/tests/schedule-page.test.cjs`
  - 新增测试 `cloud schedule page recovers from business error after correcting form`。
  - 更新 mock `createSchedule`：空 `content` 时返回 `BAD_INPUT` / `kind='business'`。

### H3 / 并发交错、事务冲突重试与写节点回滚测试

**问题**：缺少真正的创建/改派与移出双向交错、事务冲突重试及各写节点回滚证据。

**改动文件**：
- `miniapp/tests/schedule-service.test.cjs`
  - mock DB 新增 `setUpdateHook`/`clearUpdateHook`/`setRemoveHook`/`clearRemoveHook`。
  - 新增 `createConflictMockDb()`：实现 OCC 语义（读值快照、写集冲突检测、before-commit 钩子、重试计数）。
  - 新增 `makeBarrier()` 并发控制辅助。
  - 新增并发测试：
    - `concurrent create and hasActiveSchedules: checker pauses at commit, create commits first, checker retries and sees active`
    - `concurrent reassign and hasActiveSchedules old worker: checker pauses at commit, reassign commits first, checker retries and sees inactive`
    - `transaction conflict retry counted when second create commits first`
  - 新增回滚测试：
    - `rollback on schedule update failure leaves revision and occupancy unchanged`
    - `rollback on occupancy remove failure leaves schedule active and guard unchanged`
    - `rollback on audit add failure leaves no schedule or revision`
    - `rollback on receipt add failure leaves no schedule or revision`

- `miniapp/tests/member-access-schedule.test.cjs`
  - 新增服务路由级交错测试：
    - `removeMember then create for removed worker fails`
    - `reassign then removeMember old worker: old worker can be removed`
    - `removeMember then reassign to removed worker fails`

### H4 / 本机详情恢复调整安排入口、隐藏取消

**问题**：本机详情页误隐藏了“调整安排”入口；本机取消按钮会发送云请求。

**改动文件**：
- `miniapp/miniprogram/pages/schedule-detail/schedule-detail.wxml`
  - actions 区块对本地和云端 active 安排均显示“调整安排”。
  - “取消安排”仅在 `schedule.mode === 'cloud'` 时显示。

- `miniapp/tests/schedule-page.test.cjs`
  - 新增测试 `local schedule-detail shows edit but hides cancel for active manager`。

### H5 / 保护计数与实际安排不一致时阻止移出

**问题**：`member_task_guard.activeScheduleCount` 与实际 active 安排数不一致时，可能错误放行移出。

**改动文件**：
- `miniapp/cloudfunctions/memberAccess/schedule-service.js`
  - `hasActiveSchedules` 始终通过 `paginatedFetch` 查询 `schedules` 中该成员实际 active 记录数。
  - guard 存在时，比较 `guard.activeScheduleCount` 与实际计数；不一致抛 `GUARD_INCONSISTENT`。
  - guard 缺失时回退到实际计数。

- `miniapp/tests/schedule-service.test.cjs`
  - 新增测试：
    - `hasActiveSchedules rejects when guard count disagrees with actual schedules`
    - `hasActiveSchedules rejects zero guard count when actual count is positive`
  - 重命名旧测试为 `hasActiveSchedules blocks removal while schedule active and allows after cancel`。

---

## 三、新增/更新的关键测试清单

| 测试文件 | 新增/更新测试 | 覆盖项 |
|---|---|---|
| `miniapp/tests/schedule-page.test.cjs` | `cloud schedule page recovers from business error after correcting form` | H2 |
| `miniapp/tests/schedule-page.test.cjs` | `local schedule-detail shows edit but hides cancel for active manager` | H4 |
| `miniapp/tests/schedule-service.test.cjs` | `hasActiveSchedules rejects when guard count disagrees with actual schedules` | H5 |
| `miniapp/tests/schedule-service.test.cjs` | `hasActiveSchedules rejects zero guard count when actual count is positive` | H5 |
| `miniapp/tests/schedule-service.test.cjs` | `concurrent create and hasActiveSchedules: ...` | H3 |
| `miniapp/tests/schedule-service.test.cjs` | `concurrent reassign and hasActiveSchedules old worker: ...` | H3 |
| `miniapp/tests/schedule-service.test.cjs` | `transaction conflict retry counted when second create commits first` | H3 |
| `miniapp/tests/schedule-service.test.cjs` | `rollback on schedule update failure leaves revision and occupancy unchanged` | H3 |
| `miniapp/tests/schedule-service.test.cjs` | `rollback on occupancy remove failure leaves schedule active and guard unchanged` | H3 |
| `miniapp/tests/schedule-service.test.cjs` | `rollback on audit add failure leaves no schedule or revision` | H3 |
| `miniapp/tests/schedule-service.test.cjs` | `rollback on receipt add failure leaves no schedule or revision` | H3 |
| `miniapp/tests/member-access-schedule.test.cjs` | `removeMember then create for removed worker fails` | H3 |
| `miniapp/tests/member-access-schedule.test.cjs` | `reassign then removeMember old worker: old worker can be removed` | H3 |
| `miniapp/tests/member-access-schedule.test.cjs` | `removeMember then reassign to removed worker fails` | H3 |

---

## 四、指纹说明

- `miniapp/project.config.json`、`miniapp/project.private.config.json`：由微信开发者工具自动维护的本地配置，本轮未人工修改其内容。
- `miniapp/tests/member-access.test.cjs`：因新增 schedule action 路由和 `schedule-service` 注入点，该文件在回归运行时被加载执行，其内容未被人为编辑；如有指纹变化，需与 Codex 环境共同确认是否为测试运行副作用或基线差异。

---

## 五、未做项

- 未操作云端（无云函数部署、无数据库创建/回填、无真实身份请求）。
- 未安装新依赖。
- 未生成预览二维码、未部署、未发布。
- WXML/WXSS 真实编译未在 WorkBuddy 环境执行；建议 Codex 在本机微信开发者工具侧复核 8 WXML/9 WXSS 编译。

---

## 六、下一步

交 Codex 对 H1–H5 进行复查。用户无需扫码或手机操作。
