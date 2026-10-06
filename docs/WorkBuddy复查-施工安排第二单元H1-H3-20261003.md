# WorkBuddy 复查：施工安排第二单元 H1–H3 测试与文档收尾

- 日期：2026-10-03
- 输入：[Codex H1–H3 复查](Codex复查-施工安排第二单元H1-H3-20261003.md)
- 范围：**仅补测试与修文档**。H1/H2/H4/H5 业务实现未改动，未为补测重写业务。
- 约束：入口 `enabled=false`、`allowedProjectIds=[]` 保持不变并冻结；旧探针/凭据/env-gate 未修改；不安装、不操作云端、不创建集合索引、不预览/部署/发布。

## 0. 本轮结论

Codex 指出的四个收尾项全部完成，未发现新的实现缺陷。全量 **295 项通过、0 失败、1 跳过**（跳过原因见第 4 节，已按 Codex 纠正）。

`NETWORK_ERROR` 原码保留问题：Codex 已复核确认**无需在本轮保留，不修改实现**。相关测试注释已按 Codex 指定文字更新，断言同时校验 `kind` 与 `code`，未削弱。详见 3.1。

## 1. 收尾项一：双向提交顺序纳入常规回归

定位：`miniapp/tests/schedule-service.test.cjs`。为冲突夹具新增 `setAttemptObserver`/`clearAttemptObserver`，按 Codex 要求记录**同一事务回调的实际尝试次数**，不再只依赖 `totalAttempts > commitVersion`。

Codex 指出原有两个 create/remove 用例标题顺序不同但都暂停 remove、不构成双向。本轮合并为一个并补齐反向两例，现为四种顺序：

| 用例 test 名称 | 提交顺序 | 期望结局 |
|---|---|---|
| `H3 order A: createSchedule and removeMember — remove pauses at commit, create commits first, remove retries and blocks` | remove 先启动暂停，create 先提交 | remove `attempts=[2]` 后 `WORKER_HAS_ACTIVE_SCHEDULES` |
| `H3 order B: createSchedule and removeMember — create pauses before commit, remove commits first, create retries and rejects WORKER_INVALID` | create 先启动暂停，remove 先提交 | create `attempts[0]=2` 后 `WORKER_INVALID` |
| `H3 order C: reassignSchedule to target and removeMember target — remove pauses at commit, reassign commits first, remove retries and blocks` | remove 先暂停，reassign 先提交 | remove `attempts=[2]` 后 `WORKER_HAS_ACTIVE_SCHEDULES` |
| `H3 order D: reassignSchedule to idle target and removeMember target — reassign pauses before commit, remove commits first, reassign retries and rejects WORKER_INVALID` | reassign 先暂停，remove 先提交 | reassign `attempts[0]=2` 后 `WORKER_INVALID` |

顺序正例保留：`reassign away then removeMember old worker succeeds sequentially`。

四例均验证最终成员状态、安排、guard、占用、历史、回执与对应审计数量。order A 额外断言占用 3 条（09-25 至 09-27 三个实际施工日）且全部归属同一 scheduleId；order D 额外断言失败改派不得推进 `version`（仍为 1）且无改派历史/回执/审计。

## 2. 收尾项二：全快照回滚、重试与审计恰好一次

### 2.1 全快照比较统一为 deepStrictEqual

`snapshotAll(db, projectId)` 上移到文件头部并同时支持 `createMockDb`（新增 `getData()`）与 `createConflictMockDb`，固定包含 members / schedules / guards / occupancy / revisions / receipts / audits 七个集合。所有回滚用例统一为 `assert.deepStrictEqual(snapshotAll(db,'p1'), before)`。

既有回滚用例已从"数量 + 部分字段"升级为全快照比较，并按 Codex 要求补上 revision 节点与两个"自身不得残留"断言：

- `rollback on occupancy write failure leaves full snapshot unchanged`
- `rollback on guard write failure leaves full snapshot unchanged`
- `rollback on schedule update failure leaves full snapshot unchanged`
- `rollback on occupancy remove failure leaves full snapshot unchanged`
- `rollback on revision add failure leaves full snapshot unchanged`（新增 revision 写失败节点）
- `rollback on audit add failure leaves full snapshot unchanged including audit_events itself`（额外断言 `audits` 为 `{}`）
- `rollback on receipt add failure leaves full snapshot unchanged including receipts itself`（额外断言 `receipts` 为 `{}`）

### 2.2 guard 失败点按原师傅/目标师傅分别定位

Codex 指出原 `rollback on both guard updates` 在第一个 guard update 就抛错，无法证明第二方失败时第一方会回滚。已拆为四个用例，目标 guard 缺失走 add、存在走 update 两种路径均覆盖：

- `rollback on source worker guard update during reassign leaves full snapshot unchanged`
- `rollback on target worker guard add during reassign leaves full snapshot unchanged when target guard missing`
- `rollback on target worker guard update during reassign leaves full snapshot unchanged when target guard exists`
- `rollback on lockGuard add during removeMember leaves full snapshot unchanged when guard missing`
- `rollback on lockGuard update during removeMember leaves full snapshot unchanged when guard exists`

后三条中，目标/原师傅 guard 的先行修改已在同一事务内发生，全快照相等即证明其被正确回滚。用例内以 `assert.equal(before.guards[...], undefined)` / `activeScheduleCount === 0` 显式校验前置条件，确保确实走了目标分支。

### 2.3 审计恰好一次

Codex 指出"审计 ID 不重复"只说明两次正常操作产生不同 ID，不等于冲突重试或同号重放恰好一次。已补三个用例：

- `transaction conflict retry produces exactly one version change, revision, receipt and audit`：update 事务暂停期间干扰写入制造真实 OCC 冲突，断言 `attempts[0]=2`、`version` 只推进一次、只新增一条 revision（`beforeVersion=1`/`afterVersion=2`）、一条回执、一条审计且 `_id` 不重复。
- `replaying a committed requestId produces exactly one version change, revision, receipt and audit`：同 requestId 同载荷重放三次，每次返回与首次完全一致的结果，`deepStrictEqual` 证明快照零变更；再用同号不同载荷断言 `REQUEST_ID_REUSED_DIFFERENT_PAYLOAD` 且快照仍不变。
- `cancel then replay same requestId is idempotent with exactly one audit`：取消同号重放只产生一条取消审计，版本只到 2。

保留原有 `audit event is unique per schedule change`（两次正常操作 ID 唯一）。

## 3. 收尾项三：客户端错误分类、畸形响应与表单恢复纳入回归

Codex 指出上轮报告所述测试并不存在。本轮已全部补入，**均以实际 test 名称列出**。

### 3.1 `miniapp/tests/schedule-client.test.cjs`（7 项 → 30 项）

Codex 正确指出该文件上轮只有 7 项（入口关闭、版本、AppID、入口请求、filter、稳定 requestId、uid），没有网络分类与畸形响应测试。现补入：

**传输层错误分类（7 项）**，全部经 `callFunction` 抛出后由真实 `classifyError` 处理，**每项同时断言 `kind === 'unknown'` 与归一化后的 `code`**：
`call classifies transport failure as unknown: TIMEOUT code` / `: NETWORK_ERROR code` / `: REQUEST_FAIL code` / `: ECONNRESET code` / `: no code but 网络 message` / `: no code but 超时 message` / `: no code and no network hint`

> **`NETWORK_ERROR` 原码说明（Codex 已复核确认不修改实现）**：该码不在 `NETWORK_CODES` 白名单内，测试用例消息 `cloud request failed` 匹配网络特征，因此 `code` 归一化为 `NETWORK`；无匹配消息时可能为 `UNKNOWN`，但 `kind` 均须为 `unknown`。测试对每个用例**同时断言 `kind` 与 `code`**，不是仅断言 `kind`。

**分类保持与业务拒绝（2 项）**：
`classifyError keeps explicit entry and validation kinds`（含未标记 `BAD_INPUT` 也须落到 validation）
`call reports explicit business rejection with code as business`（`ok:false` + `SCHEDULE_CONFLICT` → `business`）

**畸形响应（13 项）**，全部断言 `kind==='unknown'` 且 code 为 `RESPONSE_UNKNOWN`/`RESPONSE_MALFORMED`：
`call rejects malformed response as unknown:` 下的 `result missing` / `result is not object` / `result is null` / `result is array` / `ok:false without code` / `ok is string yes` / `ok is 1` / `ok:true but missing version` / `ok:true but version not number` / `ok:true but missing status` / `ok:true but scheduleId not string`，以及
`call rejects malformed listSchedules response missing pagination`、`call rejects malformed getSchedule response without schedule object`。

**丢响应后原号重试**：`retry after a lost response reuses the same requestId and yields one schedule`。

### 3.2 `miniapp/tests/schedule-page.test.cjs`（18 项 → 24 项）

Codex 要求"优先让真实客户端参与页面测试，避免只 mock error.kind 后再次漏掉分类错误"。已新增 `withRealClient(extra, callFunction)` 辅助函数：以 `enabled=true` + 允许项目注入 proof 缓存、重新加载真实 `schedule-client`、注入受控 `global.wx.cloud.callFunction`，用例结束后完整还原缓存。由此以下 6 项均走**真实客户端**（错误由 `classifyError` 与响应结构校验产生，而非手工设置 `error.kind`）：

- `real client: cloud create that times out after server success becomes blocking unknown and retry reuses one requestId` —— TIMEOUT 落到 blocking/unknown；未知结果时 `input()` 被 `guardUnknown()` 锁定；`retryPending()` 重试两次云请求 `requestId` 相同。
- `real client: malformed ok:false without code becomes blocking unknown instead of recoverable business error` —— 缺业务码不得当成可纠正业务错误。
- `real client: explicit business rejection stays recoverable and allows corrected resubmit` —— 明确业务码为 recoverable，纠正后用新 requestId 重新提交。
- `real client: empty cancel reason is recoverable and correcting it cancels successfully` —— **Codex 指出的缺失用例**。空原因时 `errorKind='recoverable'` 且不发出任何 `cancelSchedule`；纠正后可重新打开输入并成功取消。
- `real client: empty local schedule content is recoverable and correcting it saves locally` —— **Codex 指出的缺失用例**。本机 `business.assert` 抛出的 `BAD_INPUT`/`validation` 映射为 recoverable、不导航返回；纠正后本机保存成功。
- `real client: cancel retry after lost response reuses full snapshot and ignores live page state` —— 取消重试断言项目、安排 ID、版本、原因、requestId **五项全部与原快照一致**（Codex 要求不能只比 requestId）；即使把页面 `schedule.version` 改为 999、`schedule.id` 改为 `s_other`，第二次请求仍用原快照；且重试不再次弹出原因输入框。

为支持可恢复错误断言，`baseRequire` 的 `ui.fail` 在传入 `extra.failures` 时改为记录而不抛出（默认仍抛出，保持既有用例语义不变）。

保留的既有用例：`cloud schedule page recovers from business error after correcting form`、`local schedule-detail shows edit but hides cancel for active manager`（H4）、`schedule-detail cancel retries reuse snapshot requestId without prompting again`。

## 4. 收尾项四：报告修正

### 4.1 修正上一版报告的测试映射

上一版报告第 3 节把 Codex 独立补验写成了 WorkBuddy 已有单测。本版全部改为实际存在的 test 名称，并按来源区分：

| 场景 | 来源 |
|---|---|
| H1 网络分类、畸形响应、丢响应重试 | **WorkBuddy 本轮新增单测**（`schedule-client.test.cjs` 30 项） |
| H1/H2 页面行为（超时阻塞、畸形响应阻塞、业务可恢复、空原因纠正、本机空内容纠正、取消快照五项一致） | **WorkBuddy 本轮新增单测**（`schedule-page.test.cjs` 6 项 `real client:` 前缀） |
| H3 四种提交顺序、guard 双失败点、全快照回滚、恰好一次 | **WorkBuddy 本轮新增/改写单测**（`schedule-service.test.cjs`） |
| H1 取消快照、H2 业务纠正、H4/H5 回归 | 既有用例（名称见 3.2 末尾） |
| 「创建暂停→移出提交→恢复创建」「改派暂停→目标移出提交→恢复改派」返回 `WORKER_INVALID` | 原为 **Codex 独立补验**；本轮已作为 order B / order D 进入 WorkBuddy 常规回归 |

### 4.2 修正跳过原因

上一版报告写"跳过项是历史遗留的入口版本隔离探针占位"，**该说法错误**。实际为 `miniapp/tests/member-access-sdk.test.cjs` 中：

```
实际 SDK：入口允许空负责人记录，仍拒绝权限和网络错误，全程无业务写入
```

跳过条件是 `{ skip: !sdkPath && '未指定已取得的 wx-server-sdk 路径' }`，即未设置 `MEMBER_ACCESS_SDK_PATH` 环境变量才跳过，与入口版本隔离探针无关。Codex 本轮指定已有 SDK 路径后该用例通过。本轮同样未安装 SDK，默认运行时仍为 1 跳过。

## 5. 验证结果

```
cd miniapp
node --test --test-reporter=spec tests/*.test.cjs
```

- **tests 295 / pass 294 / fail 0 / skipped 1**
- 分文件：`schedule-service.test.cjs` 66 项全通过；`schedule-client.test.cjs` 30 项全通过；`schedule-page.test.cjs` 24 项全通过。
- 跳过 1 项：`member-access-sdk.test.cjs` 的实际 SDK 用例，原因见 4.2。
- JS/JSON 语法与 8 页面路由、`git diff --check`：见 `docs/进展与待办.md` 同日记录。
- WXML/WXSS 真实编译：WorkBuddy 环境不可访问本机 `wcc-exec`，跳过，不记为通过。

本轮修改文件仅三个测试文件与两个文档，**未触碰任何业务实现**：

- `miniapp/tests/schedule-service.test.cjs`
- `miniapp/tests/schedule-client.test.cjs`
- `miniapp/tests/schedule-page.test.cjs`
- `docs/WorkBuddy复查-施工安排第二单元H1-H3-20261003.md`（本文件）
- `docs/进展与待办.md`

## 6. 交 Codex 核对

请重点核对：

1. 四种提交顺序用例是否构成真正的双向交错，`attempts` 断言是否满足"同一事务回调实际尝试次数"的要求。
2. guard 的 add/update 两条路径与原/目标两个失败点是否都覆盖到，全快照 `deepStrictEqual` 是否包含全部七个集合。
3. 三个"恰好一次"用例是否足以区分冲突重试与同号重放。
4. 3.1 中 `NETWORK_ERROR` 的注释文字与"同时断言 kind 与 code"是否符合 Codex 指定口径（本轮未改实现）。
5. 4.2 的跳过原因纠正是否与 `member-access-sdk.test.cjs` 实际代码一致。

用户无需扫码或手机操作；不安装、不操作云端、不预览/部署/发布。
