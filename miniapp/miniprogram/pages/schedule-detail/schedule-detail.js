const scheduleClient = require('../../utils/schedule-client');
const store = require('../../utils/store');
const business = require('../../utils/business');
const { fail, go } = require('../../utils/ui');
const { day } = require('../../utils/date');

const CHANGE_LABEL = { create: '创建', update: '调整', reassign: '改派', cancel: '取消' };

function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function formatRestDays(restDays) {
  if (!Array.isArray(restDays) || restDays.length === 0) return { hasRestDays: false, restDaysText: '' };
  return { hasRestDays: true, restDaysText: restDays.join('、') };
}

function cloudScheduleView(schedule, workers) {
  const worker = workers && workers.find(w => w.userId === schedule.workerUserId);
  const { hasRestDays, restDaysText } = formatRestDays(schedule.restDays);
  return {
    id: schedule.id,
    trade: schedule.trade,
    stage: schedule.stage,
    workerName: worker ? (worker.label || worker.userId) : (schedule.workerUserId || '历史成员'),
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    expectedDate: schedule.expectedDate,
    hasRestDays,
    restDaysText,
    content: schedule.content,
    status: schedule.status,
    version: schedule.version,
    mode: 'cloud'
  };
}

function localScheduleView(schedule, accounts) {
  const worker = accounts && accounts.find(a => a.id === schedule.workerId);
  const { hasRestDays, restDaysText } = formatRestDays(schedule.restDays);
  return {
    id: schedule.id,
    trade: schedule.trade,
    stage: schedule.stage,
    workerName: worker ? worker.name : (schedule.workerId || '历史成员'),
    startDate: schedule.start,
    endDate: schedule.end,
    expectedDate: schedule.expected,
    hasRestDays,
    restDaysText,
    content: schedule.content,
    status: schedule.status || 'active',
    version: schedule.version,
    mode: 'local'
  };
}

function cloudRevisionView(rev) {
  const snap = rev.snapshot || {};
  return {
    beforeVersion: rev.beforeVersion,
    afterVersion: rev.afterVersion,
    changeType: rev.changeType,
    changeLabel: CHANGE_LABEL[rev.changeType] || rev.changeType,
    reason: rev.reason,
    actorLabel: rev.actorLabel || rev.actorUserId,
    createdAt: rev.createdAt,
    snapshot: {
      trade: snap.trade,
      stage: snap.stage,
      workerName: snap.workerUserId,
      startDate: snap.startDate,
      endDate: snap.endDate,
      expectedDate: snap.expectedDate,
      hasRestDays: Array.isArray(snap.restDays) && snap.restDays.length > 0,
      restDaysText: Array.isArray(snap.restDays) ? snap.restDays.join('、') : '',
      content: snap.content,
      status: snap.status,
      version: snap.version
    }
  };
}

function localRevisionView(item) {
  return {
    beforeVersion: item.version - 1,
    afterVersion: item.version,
    changeType: 'update',
    changeLabel: '调整',
    reason: '',
    actorLabel: item.updatedBy || '',
    createdAt: item.updatedAt,
    snapshot: {
      trade: item.trade,
      stage: item.stage,
      workerName: item.workerId,
      startDate: item.start,
      endDate: item.end,
      expectedDate: item.expected,
      hasRestDays: Array.isArray(item.restDays) && item.restDays.length > 0,
      restDaysText: Array.isArray(item.restDays) ? item.restDays.join('、') : '',
      content: item.content,
      status: item.status || 'active',
      version: item.version
    }
  };
}

Page({
  data: {
    error: '',
    errorKind: '',
    loading: false,
    cancelling: false,
    project: null,
    schedule: null,
    revisions: [],
    canManage: false,
    today: day(),
    revPagination: { hasMore: false, nextCursor: null, limit: 20 },
    pendingCancel: null
  },
  onLoad(options) {
    this.projectId = options.projectId;
    this.scheduleId = options.id;
    this.revCursor = null;
    this.load();
  },
  onShow() { this.load(); },
  load() {
    this.revCursor = null;
    this.setData({ loading: true, error: '', errorKind: '', schedule: null, revisions: [], canManage: false, project: null, revPagination: { hasMore: false, nextCursor: null, limit: 20 } });
    this.doLoad(false);
  },
  doLoad(append) {
    try {
      const state = store.read();
      const localSchedule = state.schedules.find(item => item.id === this.scheduleId && item.projectId === this.projectId);
      if (localSchedule) {
        const project = state.projects.find(item => item.id === this.projectId);
        const canManage = business.canManage(state, this.projectId);
        this.setData({
          project,
          schedule: localScheduleView(localSchedule, state.accounts),
          revisions: (localSchedule.history || []).slice().reverse().map(localRevisionView),
          canManage,
          loading: false
        });
        return;
      }
      const entry = scheduleClient.checkEntry(this.projectId);
      if (!entry.allowed) {
        this.setData({ error: entry.reason, errorKind: 'blocking', loading: false });
        return;
      }
      Promise.all([
        scheduleClient.getScheduleContext(this.projectId),
        scheduleClient.getSchedule(this.projectId, this.scheduleId),
        scheduleClient.listScheduleRevisions(this.projectId, this.scheduleId, { limit: this.data.revPagination.limit, cursor: this.revCursor })
      ]).then(([ctx, scheduleBody, revBody]) => {
        const more = (revBody.revisions || []).map(cloudRevisionView);
        this.setData({
          project: ctx.project,
          schedule: cloudScheduleView(scheduleBody.schedule, ctx.workers),
          revisions: append ? this.data.revisions.concat(more) : more,
          canManage: ctx.isManager,
          revPagination: revBody.pagination || { hasMore: false, nextCursor: null, limit: 20 },
          loading: false
        });
      }).catch(error => {
        this.setData({ error: error.message, errorKind: error.kind || 'blocking', loading: false });
      });
    } catch (error) {
      this.setData({ error: error.message, errorKind: 'blocking', loading: false });
    }
  },
  loadMoreRevisions() {
    if (!this.data.revPagination.hasMore || this.data.loading || this.data.cancelling) return;
    this.revCursor = this.data.revPagination.nextCursor;
    this.setData({ loading: true });
    this.doLoad(true);
  },
  edit() {
    if (!this.data.canManage || !this.data.schedule || this.data.schedule.status !== 'active' || this.data.loading || this.data.error) return;
    go(`/pages/schedule/schedule?projectId=${this.projectId}&id=${this.scheduleId}`);
  },
  cancel() {
    // 取消入口区分 blocking/unknown/recoverable：
    // - blocking（权限、加载、在途、未知结果）限制保留；
    // - recoverable（业务/校验失败）允许重新填写原因后再次提交。
    if (!this.data.canManage || !this.data.schedule || this.data.schedule.status !== 'active' || this.data.loading || this.data.cancelling) return;
    if (this.data.error && this.data.errorKind === 'blocking') return;
    if (this.data.pendingCancel && this.data.pendingCancel.state === 'unknown') return;
    wx.showModal({
      title: '取消施工安排',
      editable: true,
      placeholderText: '请填写取消原因（1-200字）',
      success: async (res) => {
        if (!res.confirm) return;
        const reason = (res.content || '').trim();
        if (!reason || reason.length > 200) {
          this.setData({ error: '取消原因须为 1-200 字。', errorKind: 'recoverable' });
          return fail(new Error('取消原因须为 1-200 字。'));
        }
        const pending = {
          requestId: uid('req'),
          projectId: this.projectId,
          scheduleId: this.scheduleId,
          version: this.data.schedule.version,
          reason,
          state: 'pending'
        };
        this.setData({ cancelling: true, pendingCancel: pending, error: '', errorKind: '' });
        try {
          await this.sendCancel(pending);
        } catch (error) {
          this.handleCancelError(error, pending);
        }
      }
    });
  },
  async sendCancel(pending) {
    // 统一发送取消请求：直接复用 pending 完整快照，不读取当前页面状态
    await scheduleClient.cancelSchedule(pending.projectId, pending.scheduleId, pending.version, pending.reason, { requestId: pending.requestId });
    this.setData({ cancelling: false, pendingCancel: null });
    wx.showToast({ title: '已取消', icon: 'success' });
    this.load();
  },
  handleCancelError(error, pending) {
    const kind = error && error.kind ? error.kind : (this.isNetworkUnknown(error) ? 'unknown' : 'recoverable');
    if (kind === 'unknown') {
      this.setData({ cancelling: false, pendingCancel: { ...pending, state: 'unknown' }, error: '取消结果未知，请勿离开，可点击“重试取消”以原原因重试。', errorKind: 'blocking' });
    } else {
      this.setData({ cancelling: false, pendingCancel: { ...pending, state: 'failed' }, error: error.message || '取消失败', errorKind: 'recoverable' });
    }
  },
  isNetworkUnknown(error) {
    return error && (error.kind === 'unknown' || error.code === 'TIMEOUT' || error.code === 'NETWORK' || error.code === 'ECONNRESET' || error.message && /超时|网络|timeout|network/i.test(error.message));
  },
  retryCancel() {
    const pending = this.data.pendingCancel;
    if (!pending || pending.state !== 'unknown') return;
    this.setData({ cancelling: true, error: '', errorKind: '' });
    this.sendCancel({ ...pending, state: 'pending' }).catch(error => { this.handleCancelError(error, pending); });
  }
  // unknown 状态下不提供“我已核对”清除入口；只能通过原快照重试或返回列表刷新
});
