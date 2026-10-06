// 施工安排独立测试副本：专用测试页逻辑。
//
// 方案 §4.3 + Codex 复核 S5 + Codex 复核 T4：
// - 页面明显标注「施工安排独立测试」，与原页面路径完全分离。
// - **必须确定调用新客户端**，不做全局重定向，不引用旧客户端。
// - 覆盖**完整最小测试链**：身份登记 → 取号 → 建项目 → 指定管家 → 邀请 →
//   申请 → 批准 → 成员核对 → 施工新增/调整/改派/取消 → 历史与查询。
// - **固定目标无需用户手抄**：优先用已登记的测试项目ID。
// - 恢复**真实快照**（项目、动作、输入），并按动作给出可用/不可用的恢复路径。
// - 每次 onShow 与提交前**重新校验**入口与环境版本。
// - 拒绝环境下**不展示可操作测试控件**。
// - 无旧函数/本机保存回退；不扩展为通用管理后台。
//
// T4（带凭据的恢复与字段一致性）：
// - 未决期间**只允许补录该未知请求所需的敏感凭据**（T2 要求仅此一项解锁），
//   其余业务字段仍锁定；凭据摘要不匹配则拒绝发送。
// - 快照字段**回填到实际展示字段**：`restDays` → `form.restDaysText`，
//   邀请编号等常用字段一并恢复。
// - 施工新增/调整**不再无条件** `expectedConfirmed=true`：
//   预计完成日与结束日不一致时要求页面显式确认；未确认直接拒绝发送。

const sandboxClient = require('../../utils/schedule-sandbox-client');
const sandboxProof = require('../../config/schedule-sandbox-proof');
// 专用测试驱动（V06/V07）：固定计划、门控与批次协调。
// 驱动**不写**普通 envelope，也**不放宽**普通防重；普通未决存在时它拒绝启动。
const testDriver = require('../../utils/sandbox-test-driver');
const testCoordinator = require('../../utils/sandbox-test-coordinator');
const testProof = require('../../config/sandbox-test-driver-proof');

/** 专用卡片按钮：固定五个用例，不加入普通动作选择器。 */
const TEST_CASE_LABELS = Object.freeze([
  { id: 'V06-a', label: '并发幂等（两次同号新增）' },
  { id: 'V06-b', label: '占用冲突（不同号同工种同日）' },
  { id: 'V06-c', label: '版本冲突（同版本两份内容）' },
  { id: 'V07-A', label: '移出：有未完成安排（应拒绝）' },
  { id: 'V07-B', label: '移出：任务已清空（应成功）' }
]);

// 动作清单：标明所属阶段，便于按顺序走完最小测试链。
const ACTIONS = [
  { key: 'identify', label: '身份登记', phase: 'prepare' },
  { key: 'requestBindingNumber', label: '取绑定编号', phase: 'prepare' },
  { key: 'createProject', label: '建立本轮测试项目', phase: 'prepare' },
  { key: 'assignManager', label: '指定管家（填绑定编号）', phase: 'prepare' },
  { key: 'createInvitation', label: '发出邀请（填角色与工种）', phase: 'prepare' },
  { key: 'applyInvitation', label: '申请加入（填邀请码）', phase: 'prepare' },
  { key: 'approveInvitation', label: '批准加入（填邀请编号与申请者编号）', phase: 'prepare' },
  { key: 'getMembers', label: '核对成员', phase: 'prepare' },
  { key: 'listInvitations', label: '核对邀请', phase: 'prepare' },
  { key: 'createSchedule', label: '新增施工安排', phase: 'execute' },
  { key: 'updateSchedule', label: '调整施工安排（填编号与版本）', phase: 'execute' },
  { key: 'reassignSchedule', label: '改派施工安排（填编号与版本）', phase: 'execute' },
  { key: 'cancelSchedule', label: '取消施工安排（填编号与版本）', phase: 'execute' },
  { key: 'listSchedules', label: '查看安排列表', phase: 'execute' },
  { key: 'getSchedule', label: '查看单条安排（填编号）', phase: 'execute' },
  { key: 'listScheduleRevisions', label: '查看变更历史（填编号）', phase: 'execute' },
  { key: 'getScheduleContext', label: '查看施工上下文', phase: 'execute' }
];

const SCHEDULE_FORM_KEYS = ['stage', 'trade', 'workerUserId', 'startDate', 'endDate', 'expectedDate', 'restDays', 'content'];
const NO_PROJECT_ACTIONS = ['identify', 'listMyProjects', 'requestBindingNumber', 'createProject', 'applyInvitation'];
const NEED_SCHEDULE_ID = ['updateSchedule', 'reassignSchedule', 'cancelSchedule', 'getSchedule', 'listScheduleRevisions'];
const SCHEDULE_FORM_ACTIONS = ['createSchedule', 'updateSchedule'];

// 快照字段 → 页面展示字段。`restDays` 数组必须回到 **`restDaysText`**
// （表单实际显示与构造使用的字段，T4）。
const FIELD_FROM_SNAPSHOT = [
  ['scheduleId', 'scheduleIdInput'],
  ['expectedVersion', 'expectedVersionInput', String],
  ['reason', 'reasonInput'],
  ['role', 'roleInput'],
  ['userId', 'memberUserIdInput'],
  ['workerUserId', 'form.workerUserId'],
  ['invitationId', 'invitationIdInput']
];

function toRestDaysText(value) {
  if (Array.isArray(value)) return value.filter(x => x !== undefined && x !== null).join(',');
  if (value === undefined || value === null) return '';
  return String(value);
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

Page({
  data: {
    // 入口状态：拒绝环境下不展示可操作测试控件
    entryAllowed: false,
    entryReason: '',
    // 固定目标：来自配置，用户无需手抄
    targetProjectId: '',
    projectIdInput: '',
    actions: ACTIONS,
    actionIndex: 0,
    // 施工表单
    form: {
      stage: '拆改', trade: '拆改', workerUserId: '',
      startDate: '', endDate: '', expectedDate: '', restDaysText: '', content: ''
    },
    scheduleIdInput: '',
    expectedVersionInput: '',
    reasonInput: '',
    roleInput: '师傅',
    tradesInput: '拆改',
    // 凭据类输入：只在本页内存中保留，**不写入存储**
    bindingNumberInput: '',
    applicantNumberInput: '',
    invitationCodeInput: '',
    invitationIdInput: '',
    memberUserIdInput: '',
    // 未决请求
    pendingAvailable: true,
    pendingRequestId: '',
    pendingAction: '',
    pendingActionClass: '',
    pendingProjectId: '',
    pendingSummary: '',
    pendingSensitiveKeys: [],
    // T1：按动作的恢复策略
    pendingRetryAllowed: false,
    pendingGuidance: '',
    writeLocked: false,
    // T4/U5：日期不一致时的显式确认（绑定到确认时的日期组合）
    dateMismatch: false,
    dateConfirmed: false,
    dateConfirmedFor: '',
    busy: false,
    lastResult: '',
    lastError: '',
    // ── 专用测试驱动卡片（V06 三对并发 / V07 两次移出）──
    // 门控失败时整块隐藏；不提供任意 JSON 编辑器、任意函数名/环境/集合选择器。
    testCardVisible: false,
    testCardReason: '',
    testBusy: false,
    testReport: null,
    testCases: TEST_CASE_LABELS,
    testReviewIdInput: ''
  },

  onLoad() {
    // 新会话开始：不沿用上一次会话的日期确认（U5）
    this.resetDateConfirm();
    this.refreshEntry();
    this.restorePending();
  },

  onShow() {
    // 每次进入页面重新校验入口与环境版本；并清除与当前表单无关的旧确认（U5）
    this.resetDateConfirm();
    this.refreshEntry();
    this.restorePending();
  },

  /** 清除日期确认（重进/切动作时调用，避免旧确认授权新日期）。 */
  resetDateConfirm() {
    this.setData({ dateConfirmed: false, dateConfirmedFor: '' });
  },

  refreshEntry() {
    const entry = sandboxClient.checkSandboxEntry(wx);
    this.setData({
      entryAllowed: Boolean(entry.allowed),
      entryReason: entry.reason || '',
      // 固定目标：配置值优先；准备期建项目前为空
      targetProjectId: entry.targetProjectId || this.data.projectIdInput || ''
    });
    this.refreshTestCard(entry);
  },

  /**
   * 专用测试卡片的门控。
   * 卡片**整块隐藏**（不是禁用按钮）除非：副本入口允许 + 驱动开关开启
   * + 仅 develop/trial。任一不满足都不展示、不发请求。
   */
  refreshTestCard(entry) {
    const reasons = [];
    if (!entry || !entry.allowed) reasons.push(entry && entry.reason ? entry.reason : '测试副本入口未启用。');
    if (testProof.enabled !== true) reasons.push('专用测试驱动未启用。');
    let version = '';
    try {
      const info = wx.getAccountInfoSync();
      version = (info && info.miniProgram && info.miniProgram.envVersion) || '';
    } catch (error) {
      version = '';
    }
    if (!testProof.allowedVersions.includes(version)) reasons.push('仅开发版/体验版可使用专用测试。');
    this.setData({
      testCardVisible: reasons.length === 0,
      testCardReason: reasons.join(' ')
    });
  },

  /** 从现有表单读取固定计划输入（只取公开 service 契约字段）。 */
  collectTestInput() {
    const form = this.data.form || {};
    const base = {
      projectId: testProof.projectId || this.data.targetProjectId || '',
      actorUserId: testProof.actorUserId,
      stage: form.stage,
      trade: form.trade,
      workerUserId: form.workerUserId,
      startDate: form.startDate,
      endDate: form.endDate,
      expectedDate: form.expectedDate,
      restDays: toRestDaysText(form.restDaysText).split(',').map(x => x.trim()).filter(Boolean)
    };
    return base;
  },

  /**
   * 启动一个固定用例。
   * V06-c 需要 a 成功后的安排 ID：从**本机持久化的 a 结果**读取，
   * 不要求用户手填、也不把配置占位值假装已就绪。
   */
  async runTestCase(event) {
    if (this.data.testBusy) return;
    const testCaseId = event.currentTarget.dataset.case;
    this.setData({ testBusy: true, testReport: null });

    // R4 返修：无论成功、停止还是抛错，都必须用 finally 结束 busy；
    // 但停止/未知的**持久阻断不会因此解除**（协调器记录仍在）。
    try {
      const input = this.collectTestInput();
      if (testCaseId === 'V06-c') {
        // R3 返修：只接受**已人工核对（reviewed）**的 a 结果；
        // 不再直接用 candidate 的旧 scheduleId/version 组包。
        const prior = this.readPriorV06aResult();
        if (!prior) {
          this.setData({
            testReport: {
              testCaseId,
              verdict: 'stopped',
              stoppedReason: 'V06A_RESULT_MISSING',
              message: '未找到 V06-a 的已核对（reviewed）结果，无法构建版本冲突用例；未发任何请求。'
            }
          });
          return;
        }
        input.scheduleId = prior.scheduleId;
        input.reason = this.data.reasonInput || '并发版本冲突验证';
        input.content1 = (this.data.form && this.data.form.content) || '版本冲突内容一';
        input.content2 = `${input.content1}-版本二`;
      } else if (testCaseId === 'V06-a' || testCaseId === 'V06-b') {
        input.content = (this.data.form && this.data.form.content)
          || (testCaseId === 'V06-a' ? '并发幂等验证' : '占用冲突验证');
      } else if (testCaseId === 'V07-A' || testCaseId === 'V07-B') {
        // R2 返修：**只**用配置里的完整受审目标，不做表单兜底。
        // 留空即由驱动侧零发送拒绝。
        input.userId = testProof.v07TargetUserId || '';
      }
      if (testCaseId.startsWith('V06-')) {
        input.requestId1 = testDriver.makeTrackingId('v06', testCaseId, 1);
        input.requestId2 = testDriver.makeTrackingId('v06', testCaseId, 2);
      }

      const result = await testDriver.runCase({ api: wx, testCaseId, input });
      this.setData({ testReport: result.report || null });
    } catch (error) {
      // R4 返修：抛错也给出明确的停止报告，不吞掉、不假装成功
      this.setData({
        testReport: {
          testCaseId,
          verdict: 'stopped',
          stoppedReason: 'TEST_DRIVER_THREW',
          message: '专用测试执行抛出异常，已停止；请核对本机持久记录后再决定，未自动重发。'
        }
      });
    } finally {
      this.setData({ testBusy: false });
    }
  },

  /**
   * 只读读取 V06-a 的**已人工核对**结果。
   *
   * R3 返修：仅 `reviewed` 状态可用于构造 V06-c；
   * candidate 必须先完成 `acceptTestCloudReview` 才会放行。
   * 不重新发请求、不解锁。
   */
  readPriorV06aResult() {
    try {
      const storage = testCoordinator.resolveStorage(wx);
      if (!storage) return null;
      const ctx = {
        storage,
        envId: testProof.envId,
        roundId: testProof.roundId,
        actorUserId: testProof.actorUserId
      };
      const got = testCoordinator.readCase(ctx, 'V06-a');
      if (got.status !== 'ok' || !got.record) return null;
      if (got.record.state !== 'reviewed') return null;
      if (typeof got.record.reviewRecordId !== 'string' || !got.record.reviewRecordId.trim()) return null;
      const responses = got.record.responses;
      if (!Array.isArray(responses) || !responses.length) return null;
      const okResp = responses.find(r => r && r.outcome === 'responded' && r.result && r.result.ok === true);
      // 公开契约字段是 `id`（publicSchedule），不是 scheduleId
      if (!okResp || !okResp.result.id || !Number.isInteger(okResp.result.version)) return null;
      return { scheduleId: okResp.result.id, version: okResp.result.version };
    } catch (error) {
      return null;
    }
  },

  /**
   * 「已完成本例管理端核对」接续。
   * 必须填写核对记录 ID；**只是人工声明**，不会把 verifiedByCloudBaseline 改 true，
   * 不处理 stopped/unknown，也**不解开普通 envelope**。
   */
  acceptTestCloudReview() {
    const report = this.data.testReport;
    if (!report || !report.testCaseId) return;
    const result = testCoordinator.acceptCloudReview(
      {
        storage: testCoordinator.resolveStorage(wx),
        envId: testProof.envId,
        roundId: testProof.roundId,
        actorUserId: testProof.actorUserId
      },
      report.testCaseId,
      this.data.testReviewIdInput
    );
    this.setData({
      testReviewIdInput: '',
      testReport: Object.assign({}, report, {
        reviewResult: result.ok ? '已记录人工核对声明（未自动验真）。' : result.message
      })
    });
  },

  /** 恢复未决请求：读取真实快照（项目、动作、输入），不只恢复编号。 */
  restorePending() {
    const envId = sandboxProof.envId;
    const roundId = sandboxProof.roundId || 'default';
    const result = sandboxClient.readPending(wx, envId, roundId);
    if (!result.available) {
      this.setData({
        pendingAvailable: false, pendingRequestId: '', pendingAction: '',
        pendingActionClass: '', pendingProjectId: '', pendingSummary: '',
        pendingSensitiveKeys: [], pendingRetryAllowed: false, pendingGuidance: '',
        writeLocked: false, dateMismatch: false, dateConfirmed: false, dateConfirmedFor: ''
      });
      return;
    }
    if (!result.record) {
      this.setData({
        pendingAvailable: true, pendingRequestId: '', pendingAction: '',
        pendingActionClass: '', pendingProjectId: '', pendingSummary: '',
        pendingSensitiveKeys: [], pendingRetryAllowed: false, pendingGuidance: '',
        writeLocked: false, dateMismatch: false, dateConfirmed: false, dateConfirmedFor: ''
      });
      return;
    }
    const record = result.record;
    const snap = result.snapshot || {};
    const sensitiveKeys = sandboxClient.SENSITIVE_KEYS.filter(k => snap[k] && snap[k].redacted === true);
    const action = record.action || '';
    const retryable = sandboxClient.retryAllowed(action);

    // 回填展示字段（**凭据不回填**，需重新提供）
    const patch = {};
    if (snap.projectId) patch.projectIdInput = snap.projectId;
    for (const [from, to, cast] of FIELD_FROM_SNAPSHOT) {
      if (snap[from] === undefined) continue;
      patch[to] = cast ? cast(snap[from]) : snap[from];
    }
    if (Array.isArray(snap.trades) && snap.trades.length) patch.tradesInput = snap.trades.join(',');
    if (isPlainObject(snap.form)) {
      const form = { ...this.data.form };
      for (const key of SCHEDULE_FORM_KEYS) {
        if (snap.form[key] === undefined) continue;
        if (key === 'restDays') {
          // T4：restDays 数组必须回到表单**实际使用**的 restDaysText
          form.restDaysText = toRestDaysText(snap.form[key]);
          continue;
        }
        form[key] = snap.form[key];
      }
      patch.form = form;
    }
    // 凭据（applicantNumber / bindingNumber / invitationCode）**不持久化**，
    // 因此这里不回填任何值；由 inputCredential 让用户重新提供。
    const summary = Object.keys(snap)
      .filter(k => k !== 'form')
      .map(k => `${k}=${(snap[k] && typeof snap[k] === 'object') ? '[已脱敏]' : snap[k]}`)
      .join('；');
    const mismatch = this.detectDateMismatch(snap.form || this.data.form);
    this.setData({
      pendingAvailable: true,
      pendingRequestId: record.requestId,
      pendingAction: action,
      pendingActionClass: record.actionClass || '',
      pendingProjectId: record.projectId || '',
      pendingSummary: summary,
      pendingSensitiveKeys: sensitiveKeys,
      pendingRetryAllowed: retryable,
      pendingGuidance: sandboxClient.unknownGuidance(action),
      writeLocked: record.writeLocked === true,
      dateMismatch: mismatch,
      ...patch
    });
  },

  detectDateMismatch(form) {
    const end = String((form && form.endDate) || '').trim();
    const expected = String((form && form.expectedDate) || '').trim();
    return Boolean(end && expected && end !== expected);
  },

  changeAction(event) {
    if (this.data.pendingRequestId) {
      this.setData({ lastError: '存在结果未知的请求，请先核对或重试，不要改动操作。' });
      return;
    }
    // U5：切换动作不沿用不相关的旧确认
    this.resetDateConfirm();
    this.setData({ actionIndex: Number(event.detail.value) || 0 });
  },

  /**
   * 普通字段输入：未决期间**全部拒绝**（业务字段锁定，T2/T4）。
   * 只有 `inputCredential` 能补录敏感凭据。
   */
  inputField(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    if (this.data.pendingRequestId) {
      this.setData({ lastError: '存在结果未知的请求，业务字段已锁定；只能补录该请求所需的凭据或执行核对重试。' });
      return;
    }
    this.setData({ [field]: event.detail.value || '' });
    this.syncDateMismatch();
  },

  inputForm(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    if (this.data.pendingRequestId) {
      this.setData({ lastError: '存在结果未知的请求，施工表单已锁定；只能补录该请求所需的凭据或执行核对重试。' });
      return;
    }
    this.setData({ [`form.${field}`]: event.detail.value || '' });
    this.syncDateMismatch();
  },

  /**
   * T4：未决期间**唯一**被允许的输入通道 —— 补录该未知请求所需的敏感凭据。
   * 只接受 `pendingSensitiveKeys` 中的字段；其余一律拒绝。
   * 凭据只留在本页内存，不写入任何存储。
   */
  inputCredential(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    if (!this.data.pendingRequestId) {
      this.setData({ lastError: '当前没有未决请求，无需补录凭据。' });
      return;
    }
    const map = {
      applicantNumberInput: 'applicantNumber',
      bindingNumberInput: 'bindingNumber',
      invitationCodeInput: 'invitationCode'
    };
    const sensitiveKey = map[field];
    if (!sensitiveKey || !this.data.pendingSensitiveKeys.includes(sensitiveKey)) {
      this.setData({ lastError: '该凭据不是这次未决请求所需的字段，已拒绝录入。' });
      return;
    }
    this.setData({ [field]: event.detail.value || '' });
  },

  /**
   * U5：日期不一致时的显式确认。
   *
   * 确认**绑定到确认时的日期组合**（`endDate` + `expectedDate`），
   * 而不是一次性开关：相关日期一变，旧确认立即失效。
   *
   * 事件取值按原生 `<checkbox-group bindchange>` 的真实契约 ——
   * `detail.value` 是**字符串数组**，列出当前选中的 checkbox 的 value。
   * 本组仅含一个固定值 `date-confirm`：选中时数组含该值，取消时为空数组。
   * 非数组 / 含其它值 / 不含 `date-confirm` 一律按**未确认**处理。
   */
  toggleDateConfirm(event) {
    const value = event && event.detail ? event.detail.value : undefined;
    const confirmed = Array.isArray(value) && value.includes('date-confirm');
    if (!confirmed) {
      this.setData({ dateConfirmed: false, dateConfirmedFor: '' });
      return;
    }
    const combo = this.dateCombo();
    this.setData({ dateConfirmed: true, dateConfirmedFor: combo });
  },

  /** 当前相关日期组合（确认的绑定对象）。 */
  dateCombo() {
    const f = this.data.form || {};
    return `${String(f.endDate || '').trim()}|${String(f.expectedDate || '').trim()}`;
  },

  /**
   * 相关日期变化后清除旧确认（U5）。
   * 一次确认只授权它当时看到的那个日期组合。
   */
  syncDateMismatch() {
    const mismatch = this.detectDateMismatch(this.data.form);
    const patch = { dateMismatch: mismatch };
    if (this.data.dateConfirmedFor !== this.dateCombo()) {
      patch.dateConfirmed = false;
      patch.dateConfirmedFor = '';
    }
    this.setData(patch);
  },

  /** 当前生效的项目目标：配置固定值优先，其次页面输入。 */
  resolveProjectId() {
    return (this.data.targetProjectId || this.data.projectIdInput || '').trim();
  },

  /** 本次未决请求所需的凭据（只取 pendingSensitiveKeys 声明的字段）。 */
  collectSensitive() {
    const out = {};
    if (this.data.pendingSensitiveKeys.includes('applicantNumber') && this.data.applicantNumberInput) {
      out.applicantNumber = this.data.applicantNumberInput;
    }
    if (this.data.pendingSensitiveKeys.includes('bindingNumber') && this.data.bindingNumberInput) {
      out.bindingNumber = this.data.bindingNumberInput;
    }
    if (this.data.pendingSensitiveKeys.includes('invitationCode') && this.data.invitationCodeInput) {
      out.invitationCode = this.data.invitationCodeInput;
    }
    return out;
  },

  buildPayload(action) {
    const projectId = this.resolveProjectId();
    const payload = { action };
    // U3：无项目动作（PROJECT_OPTIONAL）不自动加项目目标 —— 否则保存的 envelope
    // 会带项目，却被 validateEnvelope 判为"无项目动作却带目标"，导致真实响应丢失后
    // 的恢复直接报 SANDBOX_STORAGE_UNAVAILABLE，连普通提交都被该记录卡死。
    // 项目必需动作仍按契约携带目标（且须与已登记目标一致）。
    if (projectId && !NO_PROJECT_ACTIONS.includes(action)) payload.projectId = projectId;

    if (action === 'createProject') payload.name = '虚构测试 · 独立副本';
    if (action === 'assignManager') payload.bindingNumber = this.data.bindingNumberInput;
    if (action === 'createInvitation') {
      payload.role = this.data.roleInput;
      payload.trades = String(this.data.tradesInput || '').split(',').map(x => x.trim()).filter(Boolean);
    }
    if (action === 'applyInvitation') payload.invitationCode = this.data.invitationCodeInput;
    if (action === 'approveInvitation') {
      payload.invitationId = this.data.invitationIdInput;
      payload.applicantNumber = this.data.applicantNumberInput;
    }
    if (action === 'removeMember') payload.userId = this.data.memberUserIdInput;

    if (SCHEDULE_FORM_ACTIONS.includes(action)) {
      const f = this.data.form;
      payload.form = {
        stage: f.stage,
        trade: f.trade,
        workerUserId: f.workerUserId,
        startDate: f.startDate,
        endDate: f.endDate,
        expectedDate: f.expectedDate,
        restDays: String(f.restDaysText || '').split(',').map(x => x.trim()).filter(Boolean),
        content: f.content
      };
      // T4/U5：**不再无条件** true。日期一致时按既有契约确认；
      // 不一致时必须由用户针对**当前日期组合**显式确认过。
      payload.expectedConfirmed = this.data.dateConfirmed === true
        && this.data.dateConfirmedFor === this.dateCombo();
    }
    if (action === 'updateSchedule' || action === 'reassignSchedule' || action === 'cancelSchedule') {
      payload.scheduleId = this.data.scheduleIdInput;
      if (this.data.expectedVersionInput) payload.expectedVersion = Number(this.data.expectedVersionInput);
      payload.reason = this.data.reasonInput;
    }
    if (action === 'reassignSchedule') payload.workerUserId = this.data.form.workerUserId;
    if (action === 'getSchedule' || action === 'listScheduleRevisions') {
      payload.scheduleId = this.data.scheduleIdInput;
    }
    return payload;
  },

  async runSelected() {
    await this.runAction(ACTIONS[this.data.actionIndex].key);
  },

  async runAction(action) {
    if (this.data.busy) return;
    // 提交前重新校验入口与环境版本
    this.refreshEntry();
    if (!this.data.entryAllowed) {
      this.setData({ lastError: this.data.entryReason || '测试副本未启用或当前版本不可用。' });
      return;
    }
    // 未决期间：不接受新的普通提交（T2 恢复只能走显式恢复接口）
    if (this.data.pendingRequestId) {
      this.setData({
        lastError: this.data.pendingRetryAllowed
          ? '存在结果未知的请求，请用「核对并重试」按同一请求编号恢复。'
          : '存在结果未知且无幂等保障的请求，已停止写入；请先到管理端核对该编号的结果。'
      });
      return;
    }
    // T1：写锁未解除前不接受新写
    if (this.data.writeLocked) {
      this.setData({ lastError: '本轮存在结果未知且无幂等保障的写入，已锁写；请在管理端核对后由维护流程处理。' });
      return;
    }
    // 项目类动作缺目标：零请求
    if (!NO_PROJECT_ACTIONS.includes(action) && !this.resolveProjectId()) {
      this.setData({ lastError: '尚未确定测试项目ID，未发送任何请求。' });
      return;
    }
    if (NEED_SCHEDULE_ID.includes(action) && !this.data.scheduleIdInput) {
      this.setData({ lastError: '请先填写施工安排编号。' });
      return;
    }
    // U5：日期不一致时必须有**针对当前日期组合**的显式确认。
    // 旧确认（不同日期组合）不算，也不能沿用到新日期。
    if (SCHEDULE_FORM_ACTIONS.includes(action)) {
      const mismatch = this.detectDateMismatch(this.data.form);
      if (mismatch) {
        const bound = this.data.dateConfirmed === true && this.data.dateConfirmedFor === this.dateCombo();
        if (!bound) {
          this.setData({ lastError: '预计完成日与结束日不一致，请针对当前日期重新勾选显式确认再提交。' });
          return;
        }
      }
    }

    const payload = this.buildPayload(action);
    this.setData({ busy: true, lastError: '', lastResult: '' });
    try {
      const result = await sandboxClient.callSandbox(payload, { api: wx });
      this.applyResult(result);
    } catch (error) {
      this.setData({ lastError: '本地调用异常，未回退旧后台。' });
    } finally {
      this.setData({ busy: false });
    }
  },

  /**
   * 显式恢复：按同一请求编号、从**原完整快照**重发。
   *
   * 不在这里按动作提前拒绝：凭据是否匹配必须由客户端**先**校验，
   * 否则"凭据填错"会被"不能重发"掩盖（T4）。
   * 无幂等保障的动作由客户端返回 SANDBOX_RETRY_UNSAFE，仍不发送（T1）。
   */
  async retryPending() {
    if (!this.data.pendingRequestId || !this.data.pendingAction) return;
    if (this.data.busy) return;
    this.refreshEntry();
    if (!this.data.entryAllowed) {
      this.setData({ lastError: this.data.entryReason || '测试副本未启用或当前版本不可用。' });
      return;
    }
    this.setData({ busy: true, lastError: '', lastResult: '' });
    try {
      const result = await sandboxClient.resumePending({
        api: wx,
        sensitive: this.collectSensitive()
      });
      this.applyResult(result);
    } catch (error) {
      this.setData({ lastError: '本地调用异常，未回退旧后台。' });
    } finally {
      this.setData({ busy: false });
    }
  },

  applyResult(result) {
    if (result.local) {
      this.setData({ lastError: `${result.code}：${result.message || '请求未发送。'}` });
      if (result.code === 'SANDBOX_STORAGE_UNAVAILABLE') this.setData({ pendingAvailable: false });
      this.restorePending();
      return;
    }
    if (result.unknown) {
      // 结果未知：按动作说明恢复策略，不笼统提示同号重试
      this.restorePending();
      this.setData({ lastError: result.message || '结果未知。' });
      return;
    }
    if (result.ok === false) {
      this.restorePending();
      this.setData({ lastError: `${result.code || 'ERROR'}：${result.message || '请求被拒绝。'}` });
      return;
    }
    this.restorePending();
    this.setData({ lastResult: JSON.stringify(result).slice(0, 900) });
  },

  /**
   * 解除未决记录：**必须先显式确认已在管理端核对**。
   * 解除后本轮**仍保持锁写**，客户端不自动放开新写。
   */
  resolvePending(event) {
    const confirmed = Boolean(event && event.detail && event.detail.value);
    if (!confirmed) {
      this.setData({ lastError: '请先勾选"已在管理端核对该请求结果"再解除。' });
      return;
    }
    const outcome = sandboxClient.resolvePendingAfterExternalCheck(wx, { externallyVerified: true });
    this.restorePending();
    if (!outcome.ok) {
      this.setData({ lastError: `${outcome.code}：${outcome.message || '解除失败。'}` });
      return;
    }
    this.setData({ lastError: '', lastResult: '', writeLocked: true });
  }
});
