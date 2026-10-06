// 施工安排独立测试副本：**专用测试驱动配置**（V06 / V07）。
//
// 依据：docs/WorkBuddy任务-独立副本最小测试驱动与首次初始化-20261005.md §3。
//
// 与 `schedule-sandbox-proof.js` 的关系（关键）：
// - 两者是**独立**配置，本文件**不替代**旧配置，也**不放宽**它。
// - 驱动发请求必须**同时**满足：本文件 `enabled === true` **且**
//   旧 sandbox proof `enabled === true`；缺一即零发送。
// - 固定目标（AppID / 环境 / 函数名）在本文件重复声明一次，用于**交叉核对**，
//   实际调用仍以旧 proof 为准；两者不一致时停止。
//
// 冻结与安全默认值：
// - `enabled` 默认 **false**；所有执行动态值默认**空字符串**。
// - 嵌套结构**冻结**（避免运行中被就地改写计划）。
// - **不预填**任何真实值：roundId / projectId / actorUserId / expiresAt /
//   evidenceId、目标人 userId、日期、安排 ID、版本、请求号、快照一律为空或占位。
// - 尾号（2d3aa4 / 64193d / f182f4）只作**提示文案**，**不能**用于授权判断；
//   授权判断只能用未来核实过的**完整 userId**。
//
// 本文件不含任何网络调用、不 require 客户端或云函数代码。

'use strict';

/** 允许使用的开发版限制：正式版与未识别版本一律拒绝。 */
const ALLOWED_VERSIONS = Object.freeze(['develop', 'trial']);

/** 固定目标：与旧 sandbox proof 交叉核对，不作为运行时唯一来源。 */
const TARGET = Object.freeze({
  appId: 'wxfb4db1615ac15531',
  envId: 'cloud1-d8gcq5ag39d847723',
  functionName: 'scheduleSandbox'
});

/** 独立缓存前缀：与旧 `schtest_v1:` **不共用**，也不清旧缓存。 */
const CACHE_PREFIX = 'schtest_v1:driver:';

/** 原 A/B/C 受保护项目：任何阶段都不得作为驱动目标。 */
const PROTECTED_PROJECT_IDS = Object.freeze([
  'p_38507fc9b43c4e23a7fbd996415637bb',
  'p_a328c08992f7414c812047935bc3c31e',
  'p_4e53f8437dab4ddcb62971d58455acaa'
]);

// ── 固定计划模板 ────────────────────────────────────────────────────────────
// 约束：只给**结构**与候选判定，不给真实执行值。
// 每个用例的必填字段在**该用例启动时**才要求完整；不要求 V06-a 启动前
// 就已存在只有它成功后才会产生的 V06-c 安排 ID（见 §5）。

/** 参与并发的两名固定成员提示（仅文案，不作授权判断）。 */
const ACTOR_HINT = '64193d';

/** V07 目标：候选师傅乙 f182f4 的**完整 userId** 由未来核实后填入。 */
const V07_TARGET_HINT = 'f182f4';

/** 施工表单字段（与公开 service 结构一致；实际值由用例绑定）。 */
const SCHEDULE_FORM_KEYS = Object.freeze([
  'stage', 'trade', 'workerUserId',
  'startDate', 'endDate', 'expectedDate', 'restDays', 'content'
]);

/**
 * 三个固定并发用例（V06-a/b/c）。
 * - `requests` 描述**两笔固定请求**的关系，不是任意 JSON。
 * - `expect` 列出**唯一可接受**的客户端候选结果组合（不接受「任意一成一败」）。
 */
const V06_CASES = Object.freeze([
  Object.freeze({
    testCaseId: 'V06-a',
    label: '并发幂等：两次新增，相同请求号与相同载荷',
    pair: 'createSchedule',
    sameRequestId: true,
    // 相同 requestId + 逐字段相同 form/载荷；使用一个**新的空闲施工日**
    expect: Object.freeze({
      bothOk: true,
      identicalResult: true,
      compareFields: Object.freeze(['id', 'version', 'status'])
    }),
    cloudCheck: '一份新安排且版本为 1；一条对应 revision/审计/回执；目录与占用只增加一次'
  }),
  Object.freeze({
    testCaseId: 'V06-b',
    label: '占用冲突：两次新增，不同请求号、相同工种与实际施工日',
    pair: 'createSchedule',
    sameRequestId: false,
    // 与 a 不重叠的另一空闲日；同项目/工种/实际施工日，其他字段按固定计划
    expect: Object.freeze({
      oneOkOneConflict: true,
      conflictCode: 'SCHEDULE_CONFLICT',
      orderAgnostic: true
    }),
    cloudCheck: '仅胜方的安排/回执/历史/审计与对应占用落地；失败方无残留'
  }),
  Object.freeze({
    testCaseId: 'V06-c',
    label: '版本冲突：同一安排的两次调整，同一期望版本、不同内容',
    pair: 'updateSchedule',
    sameRequestId: false,
    // 依赖 V06-a 成功后的安排 ID：启动时才要求该字段，且必须来自
    // a 的持久化成功结果 + 同项目 getSchedule 核对，不允许手填假装就绪
    dependsOn: 'V06-a',
    expect: Object.freeze({
      oneOkOneConflict: true,
      conflictCode: 'VERSION_MISMATCH',
      orderAgnostic: true
    }),
    cloudCheck: '版本只 +1；内容等于胜方；历史/审计/回执仅新增一份；无败方残留'
  })
]);

/**
 * 两个移出用例（V07-A / V07-B）。
 * - **不**加入普通动作选择器；只由专用按钮触发。
 * - 目标必须是**副本现场**的 active 师傅；不能因为其在原 A 项目曾是主业主
 *   就推断副本角色。
 * - `removeMember` **没有服务端 requestId 幂等**：requestId 只作追踪，
 *   不允许超时重发、恢复发送或清锁重试。
 */
const V07_CASES = Object.freeze([
  Object.freeze({
    testCaseId: 'V07-A',
    label: '有未完成安排时移出：应被明确拒绝',
    precondition: 'hasActiveSchedule',
    expect: Object.freeze({
      rejected: true,
      code: 'WORKER_HAS_ACTIVE_SCHEDULES'
    }),
    cloudCheck: '成员仍在；安排、目录、月桶不变；失败不新增成功移出审计',
    idempotent: false
  }),
  Object.freeze({
    testCaseId: 'V07-B',
    label: '任务清空后移出：应成功退出',
    precondition: 'noActiveSchedule',
    expect: Object.freeze({
      removed: true,
      requireResultFields: Object.freeze(['userId', 'status']),
      requireStatus: 'left'
    }),
    cloudCheck: '成员退出；目录/代际正常；旧安排与历史保留；管家仍可查历史；乙本人之后 NO_ACCESS',
    idempotent: false
  })
]);

/** 全部固定用例（顺序固定，便于逐例串行核对）。 */
const TEST_CASES = Object.freeze([...V06_CASES, ...V07_CASES]);

/** 用例状态机（§4）。 */
const CASE_STATES = Object.freeze([
  'ready', 'preflight', 'armed', 'inFlight', 'candidate', 'stopped', 'reviewed'
]);

/** 仅这些状态可被「已完成本例管理端核对」接续；stopped/unknown 不行。 */
const REVIEWABLE_STATES = Object.freeze(['candidate']);

module.exports = Object.freeze({
  // ── 开关与动态值（默认关闭、动态值全空）──
  enabled: false,
  appId: TARGET.appId,
  envId: TARGET.envId,
  functionName: TARGET.functionName,
  allowedVersions: ALLOWED_VERSIONS,
  cachePrefix: CACHE_PREFIX,

  // 执行动态值：一律为空，启动时必须完整
  roundId: '',
  projectId: '',
  actorUserId: '',
  expiresAt: '',
  evidenceId: '',

  // ── 固定计划 ──
  actorHint: ACTOR_HINT,
  v07TargetHint: V07_TARGET_HINT,
  protectedProjectIds: PROTECTED_PROJECT_IDS,
  scheduleFormKeys: SCHEDULE_FORM_KEYS,
  v06Cases: V06_CASES,
  v07Cases: V07_CASES,
  testCases: TEST_CASES,
  caseStates: CASE_STATES,
  reviewableStates: REVIEWABLE_STATES,

  // V07 目标完整 userId 未来核实后填入；默认空，不预填。
  v07TargetUserId: '',

  // UI 建议等待上限（秒）。与云函数 3 秒超时**不是同一概念**。
  uiTimeoutSeconds: 30,

  description: '独立副本专用测试驱动配置（V06 三对并发 + V07 两次移出）。默认关闭，动态值为空；'
    + '需与旧 sandbox proof 同时启用才可发送。'
});
