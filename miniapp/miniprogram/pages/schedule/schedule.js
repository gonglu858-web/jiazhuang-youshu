const store = require('../../utils/store');
const business = require('../../utils/business');
const { STAGES } = require('../../utils/seed');
const { day } = require('../../utils/date');
const { fail, go } = require('../../utils/ui');
const scheduleClient = require('../../utils/schedule-client');

const suggestedStage = { '水电': '水电隐蔽工程', '泥瓦': '砌墙', '木工': '木工施工' };

function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function formSignature(form, reason, expectedConfirmed) {
  // 用于判断业务负载是否变化；变化后应分配新 requestId
  return JSON.stringify({
    trade: form.trade,
    stage: form.stage,
    workerId: form.workerId,
    start: form.start,
    end: form.end,
    expected: form.expected,
    restDays: [...new Set((form.restDays || []).filter(d => typeof d === 'string'))].sort(),
    content: typeof form.content === 'string' ? form.content.trim() : form.content,
    reason: typeof reason === 'string' ? reason.trim() : reason,
    expectedConfirmed: !!expectedConfirmed
  });
}

Page({
  data: {
    error: '',
    errorKind: '', // 'blocking' | 'recoverable'
    loading: false,
    saving: false,
    mode: 'local',
    project: null,
    stages: STAGES,
    trades: [],
    workers: [],
    form: { restDays: [] },
    reason: '',
    restDate: day(),
    expectedConfirmed: false,
    expectedDateMismatch: false,
    isEdit: false,
    canManage: false,
    pendingRequest: null
  },
  onLoad(options) {
    this.projectId = options.projectId;
    this.scheduleId = options.id || '';
    this.requestId = uid('req');
    this.lastRequestPayload = '';
    this.init();
  },
  init() {
    this.setData({ loading: true, error: '', errorKind: '', saving: false, canManage: false });
    try {
      const entry = scheduleClient.checkEntry(this.projectId);
      if (entry.allowed) {
        if (this.scheduleId) this.initCloudEdit();
        else this.initCloudCreate();
        return;
      }
      // 入口禁用：只能使用本机示例数据
      const state = store.read();
      if (this.scheduleId) {
        const localSchedule = state.schedules.find(item => item.id === this.scheduleId && item.projectId === this.projectId);
        if (localSchedule) {
          this.setLocalForm(localSchedule, state);
          return;
        }
        throw new Error('没有找到此施工安排。');
      }
      const localProject = state.projects.find(item => item.id === this.projectId);
      if (!localProject) {
        throw new Error(entry.reason);
      }
      this.initLocalCreate(state);
    } catch (error) {
      this.setData({ error: error.message, errorKind: 'blocking', loading: false });
    }
  },
  initLocalCreate(state) {
    if (!business.canManage(state, this.projectId)) throw new Error('仅项目管家可以维护施工安排。');
    const members = state.members.filter(item => item.projectId === this.projectId && item.status === 'active' && item.roles.includes('师傅'));
    const trades = [...new Set(members.reduce((all, member) => all.concat(member.trades), []))];
    if (!trades.length) throw new Error('本项目尚无获授权工种的师傅，暂不能安排施工。');
    const trade = trades[0];
    const form = { trade, stage: suggestedStage[trade] || STAGES[0], start: day(), end: day(), expected: day(), content: '', restDays: [], workerId: '' };
    this.setData({ mode: 'local', project: business.project(state, this.projectId), canManage: true, trades, form, tradeIndex: 0, stageIndex: STAGES.indexOf(form.stage), restDate: form.start, isEdit: false, loading: false });
    this.refreshLocalWorkers(members, state.accounts);
    this.lastRequestPayload = formSignature(form, '', false);
  },
  setLocalForm(schedule, state) {
    if (!business.canManage(state, this.projectId)) throw new Error('仅项目管家可以维护施工安排。');
    const members = state.members.filter(item => item.projectId === this.projectId && item.status === 'active' && item.roles.includes('师傅'));
    const trades = [...new Set(members.reduce((all, member) => all.concat(member.trades), []))];
    const form = {
      id: schedule.id,
      version: schedule.version,
      trade: schedule.trade,
      stage: schedule.stage,
      workerId: schedule.workerId,
      start: schedule.start,
      end: schedule.end,
      expected: schedule.expected,
      content: schedule.content,
      restDays: [...(schedule.restDays || [])]
    };
    const mismatch = form.expected !== form.end;
    this.setData({ mode: 'local', project: business.project(state, this.projectId), canManage: true, trades, form, tradeIndex: trades.indexOf(form.trade), stageIndex: STAGES.indexOf(form.stage), reason: '', restDate: form.start, expectedDateMismatch: mismatch, expectedConfirmed: false, isEdit: true, loading: false });
    this.refreshLocalWorkers(members, state.accounts);
    this.lastRequestPayload = formSignature(form, '', false);
  },
  initCloudCreate() {
    scheduleClient.getScheduleContext(this.projectId).then(body => {
      if (!body.isManager) throw new Error('仅项目管家可以维护施工安排。');
      const trades = body.trades && body.trades.length ? body.trades : [];
      if (!trades.length) throw new Error('本项目尚无获授权工种的师傅，暂不能安排施工。');
      const trade = trades[0];
      const form = { trade, stage: suggestedStage[trade] || STAGES[0], start: day(), end: day(), expected: day(), content: '', restDays: [], workerId: '' };
      this.allWorkers = body.workers;
      this.setData({ mode: 'cloud', project: body.project, canManage: true, trades, workers: body.workers.map(w => ({ id: w.userId, name: w.label || w.userId })), form, tradeIndex: 0, stageIndex: STAGES.indexOf(form.stage), restDate: form.start, isEdit: false, loading: false });
      this.refreshCloudWorkers(body.workers);
      this.lastRequestPayload = formSignature(form, '', false);
    }).catch(error => { this.setData({ error: error.message, errorKind: this.errorKindOf(error), loading: false }); });
  },
  initCloudEdit() {
    Promise.all([
      scheduleClient.getScheduleContext(this.projectId),
      scheduleClient.getSchedule(this.projectId, this.scheduleId)
    ]).then(([ctx, scheduleBody]) => {
      if (!ctx.isManager) throw new Error('仅项目管家可以维护施工安排。');
      const schedule = scheduleBody.schedule;
      const form = {
        id: schedule.id,
        version: schedule.version,
        trade: schedule.trade,
        stage: schedule.stage,
        workerId: schedule.workerUserId,
        start: schedule.startDate,
        end: schedule.endDate,
        expected: schedule.expectedDate,
        content: schedule.content,
        restDays: [...(schedule.restDays || [])]
      };
      const mismatch = form.expected !== form.end;
      this.allWorkers = ctx.workers;
      this.setData({ mode: 'cloud', project: ctx.project, canManage: true, trades: ctx.trades, workers: ctx.workers.map(w => ({ id: w.userId, name: w.label || w.userId })), form, tradeIndex: ctx.trades.indexOf(form.trade), stageIndex: STAGES.indexOf(form.stage), reason: '', restDate: form.start, expectedDateMismatch: mismatch, expectedConfirmed: false, isEdit: true, loading: false });
      this.refreshCloudWorkers(ctx.workers);
      this.lastRequestPayload = formSignature(form, '', false);
    }).catch(error => { this.setData({ error: error.message, errorKind: this.errorKindOf(error), loading: false }); });
  },
  errorKindOf(error) {
    if (error && typeof error.kind === 'string') {
      // validation 与 business 均属于可纠正错误；entry/unknown/blocking 保持阻塞
      if (error.kind === 'validation' || error.kind === 'business') return 'recoverable';
      return error.kind;
    }
    return 'blocking';
  },
  refreshLocalWorkers(members, accounts) {
    const workers = members.filter(item => item.trades.includes(this.data.form.trade)).map(item => ({ id: item.userId, name: (accounts.find(a => a.id === item.userId) || {}).name || item.userId }));
    let workerIndex = workers.findIndex(item => item.id === this.data.form.workerId);
    if (workerIndex < 0) workerIndex = 0;
    this.setData({ workers, workerIndex, 'form.workerId': workers[workerIndex] ? workers[workerIndex].id : '' });
  },
  refreshCloudWorkers(workers) {
    const list = workers.filter(w => w.trades.includes(this.data.form.trade)).map(w => ({ id: w.userId, name: w.label || w.userId }));
    let workerIndex = list.findIndex(item => item.id === this.data.form.workerId);
    if (workerIndex < 0) workerIndex = 0;
    this.setData({ workers: list, workerIndex, 'form.workerId': list[workerIndex] ? list[workerIndex].id : '' });
  },
  refreshWorkers() {
    if (this.data.mode === 'local') {
      const state = store.read();
      const members = state.members.filter(item => item.projectId === this.projectId && item.status === 'active' && item.roles.includes('师傅'));
      this.refreshLocalWorkers(members, state.accounts);
    } else {
      this.refreshCloudWorkers(this.allWorkers || []);
    }
  },
  isPendingUnknown() {
    return this.data.pendingRequest && this.data.pendingRequest.state === 'unknown';
  },
  guardUnknown() {
    if (this.isPendingUnknown()) {
      this.setData({ error: '已有未确认提交，请先重试或核对结果后再修改。', errorKind: 'blocking' });
      return true;
    }
    return false;
  },
  changeTrade(event) {
    if (this.guardUnknown()) return;
    const index = Number(event.detail.value);
    const trade = this.data.trades[index];
    const stage = suggestedStage[trade] || STAGES[0];
    this.setData({ tradeIndex: index, stageIndex: STAGES.indexOf(stage), 'form.trade': trade, 'form.stage': stage });
    this.refreshWorkers();
  },
  changeStage(event) {
    if (this.guardUnknown()) return;
    const index = Number(event.detail.value); this.setData({ stageIndex: index, 'form.stage': STAGES[index] });
  },
  changeWorker(event) {
    if (this.guardUnknown()) return;
    const index = Number(event.detail.value); this.setData({ workerIndex: index, 'form.workerId': this.data.workers[index].id });
  },
  input(event) {
    if (this.guardUnknown()) return;
    const field = event.currentTarget.dataset.field;
    if (['start', 'end', 'expected', 'content'].includes(field)) {
      const form = { ...this.data.form, [field]: event.detail.value };
      const mismatch = form.expected !== form.end;
      // 预计日期发生变化时重置确认状态；一致时无需确认
      this.setData({ form, expectedDateMismatch: mismatch, expectedConfirmed: mismatch ? false : false });
    }
  },
  inputReason(event) {
    if (this.guardUnknown()) return;
    this.setData({ reason: event.detail.value });
  },
  toggleExpectedConfirmed() {
    if (this.guardUnknown()) return;
    this.setData({ expectedConfirmed: !this.data.expectedConfirmed });
  },
  chooseRest(event) { this.setData({ restDate: event.detail.value }); },
  addRest() {
    if (this.guardUnknown()) return;
    const { form, restDate } = this.data;
    if (restDate < form.start || restDate > form.end) return fail(new Error('请选择施工日期范围内的休息／停工日。'));
    this.setData({ 'form.restDays': [...new Set(form.restDays.concat(restDate))].sort() });
  },
  removeRest(event) {
    if (this.guardUnknown()) return;
    this.setData({ 'form.restDays': this.data.form.restDays.filter(date => date !== event.currentTarget.dataset.date) });
  },
  buildCloudForm() {
    const form = this.data.form;
    return {
      stage: form.stage,
      trade: form.trade,
      workerUserId: form.workerId,
      startDate: form.start,
      endDate: form.end,
      expectedDate: form.expected,
      restDays: form.restDays,
      content: form.content.trim()
    };
  },
  ensureFreshRequestId() {
    const payload = formSignature(this.data.form, this.data.reason, this.data.expectedConfirmed);
    if (payload !== this.lastRequestPayload) {
      this.requestId = uid('req');
      this.lastRequestPayload = payload;
    }
  },
  save() {
    if (this.data.saving || this.data.loading) return;
    if (this.isPendingUnknown()) {
      this.setData({ error: '已有未确认提交，请先重试或核对结果后再修改。', errorKind: 'blocking' });
      return;
    }
    if (!this.data.canManage) return fail(new Error('仅项目管家可以维护施工安排。'));
    // 阻断错误禁止保存；可纠正错误在点击保存时清空，允许重新校验
    if (this.data.error && this.data.errorKind === 'blocking') return;
    this.setData({ saving: true, error: '', errorKind: '' });
    if (this.data.mode === 'cloud') this.saveCloud();
    else this.saveLocal();
  },
  saveLocal() {
    try {
      const state = store.read();
      const next = business.saveSchedule(state, this.projectId, this.data.form, new Date().toISOString(), store.uid('plan'));
      store.write(next);
      this.setData({ saving: false });
      wx.showToast({ title: '已保存到本机', icon: 'success' });
      wx.navigateBack();
    } catch (error) {
      this.setData({ saving: false, error: error.message, errorKind: this.errorKindOf(error) });
      fail(error);
    }
  },
  async saveCloud() {
    let pending = this.data.pendingRequest;
    const currentPayload = formSignature(this.data.form, this.data.reason, this.data.expectedConfirmed);
    if (pending && pending.state === 'unknown') {
      // unknown 状态不允许修改内容，只能以原快照重试
      if (pending.payload !== currentPayload) {
        this.setData({ saving: false, error: '已有未确认提交，请先以原内容重试或核对结果后再修改。', errorKind: 'blocking' });
        return;
      }
      this.setData({ saving: true, error: '', errorKind: '' });
      return this.sendCloud(pending);
    }
    // 新提交或 recoverable 失败后重编辑：按当前内容生成新 pending
    this.ensureFreshRequestId();
    const reason = (this.data.reason || '').trim();
    const isEdit = !!this.data.form.id;
    if (isEdit && (!reason || reason.length > 200)) {
      this.setData({ saving: false, error: '调整安排须填写 1-200 字原因。', errorKind: 'recoverable' });
      return;
    }
    pending = {
      requestId: this.requestId,
      payload: currentPayload,
      projectId: this.projectId,
      scheduleId: this.data.form.id || null,
      version: this.data.form.version || null,
      cloudForm: this.buildCloudForm(),
      reason,
      expectedConfirmed: this.data.expectedConfirmed || false,
      isEdit,
      state: 'pending'
    };
    this.setData({ pendingRequest: pending, error: '', errorKind: '' });
    try {
      await this.sendCloud(pending);
    } catch (error) {
      this.handleSendError(error, pending);
    }
  },
  async sendCloud(pending) {
    const options = { requestId: pending.requestId, expectedConfirmed: pending.expectedConfirmed };
    if (pending.isEdit) {
      await scheduleClient.updateSchedule(pending.projectId, pending.scheduleId, pending.version, pending.cloudForm, pending.reason, options);
    } else {
      await scheduleClient.createSchedule(pending.projectId, pending.cloudForm, options);
    }
    // 成功：清理未确认状态并返回
    this.lastRequestPayload = '';
    this.requestId = uid('req');
    this.setData({ saving: false, pendingRequest: null });
    wx.showToast({ title: '已保存', icon: 'success' });
    wx.navigateBack();
  },
  handleSendError(error, pending) {
    const kind = error && error.kind ? error.kind : (this.isNetworkUnknown(error) ? 'unknown' : 'recoverable');
    if (kind === 'unknown') {
      this.setData({ saving: false, pendingRequest: { ...pending, state: 'unknown' }, error: '提交结果未知，请勿修改内容，可点击“重试”以原内容/原编号再次提交。', errorKind: 'blocking' });
    } else {
      this.setData({ saving: false, pendingRequest: { ...pending, state: 'failed' }, error: error.message || '提交失败', errorKind: 'recoverable' });
    }
  },
  isNetworkUnknown(error) {
    return error && (error.kind === 'unknown' || error.code === 'TIMEOUT' || error.code === 'NETWORK' || error.code === 'ECONNRESET' || error.message && /超时|网络|timeout|network/i.test(error.message));
  },
  retryPending() {
    const pending = this.data.pendingRequest;
    if (!pending || pending.state !== 'unknown') return;
    this.setData({ saving: true, error: '', errorKind: '' });
    this.sendCloud({ ...pending, state: 'pending' })
      .catch(error => { this.handleSendError(error, pending); });
  },
  // unknown 状态下不提供“我已核对”清除入口；只能通过原快照重试或返回列表人工核对
});
