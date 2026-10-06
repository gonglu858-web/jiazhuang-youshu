const store = require('../../utils/store');
const business = require('../../utils/business');
const { day } = require('../../utils/date');
const { fail, go, context } = require('../../utils/ui');
const scheduleClient = require('../../utils/schedule-client');

Page({
  data: { tab: 'plans', selectedDate: '', recordDate: '', error: '', schedules: [], records: [], postOptions: [], today: '', activeCount: 0, updatedCount: 0, isWorker: false, project: null, roleText: '', canManage: false, mode: 'local', pagination: { hasMore: false, nextCursor: null } },
  onLoad(options) { this.projectId = options.id; this.setData({ selectedDate: day(), today: day() }); },
  onShow() { this.refresh(); },
  refresh() {
    this.setData({ error: '', schedules: [], records: [], postOptions: [], activeCount: 0, updatedCount: 0, isWorker: false, pagination: { hasMore: false, nextCursor: null } });
    try {
      const entry = scheduleClient.checkEntry(this.projectId);
      if (entry.allowed) {
        this.refreshCloud();
        return;
      }
      this.refreshLocal();
    } catch (error) {
      this.setData({ error: error.message, project: null, schedules: [], records: [], postOptions: [] });
    }
  },
  refreshCloud() {
    this.setData({ mode: 'cloud' });
    Promise.all([
      scheduleClient.getScheduleContext(this.projectId),
      scheduleClient.listSchedules(this.projectId, { date: this.data.selectedDate, limit: 20 })
    ]).then(([ctx, body]) => {
      const cloudSchedules = (body.schedules || []).map(item => this.mapCloudSchedule(item));
      this.setData({
        project: ctx.project,
        roleText: ctx.isManager ? '管家' : '成员',
        canManage: ctx.isManager,
        schedules: cloudSchedules,
        records: [],
        postOptions: [],
        activeCount: 0,
        updatedCount: 0,
        isWorker: false,
        pagination: body.pagination || { hasMore: false, nextCursor: null },
        error: ''
      });
    }).catch(error => { this.setData({ error: error.message, schedules: [] }); });
  },
  mapCloudSchedule(item) {
    return {
      id: item.id,
      trade: item.trade,
      stage: item.stage,
      start: item.startDate,
      end: item.endDate,
      expected: item.expectedDate,
      content: item.content,
      workerName: item.workerUserId ? `成员 ${item.workerUserId.slice(-6)}` : '历史成员',
      restText: (item.restDays || []).join('、'),
      status: { text: item.status === 'cancelled' ? '已取消' : '有效', tone: item.status === 'cancelled' ? 'muted' : 'success', active: item.status === 'active' },
      version: item.version
    };
  },
  loadMoreCloud() {
    if (!this.data.pagination.hasMore || this.data.loading) return;
    this.setData({ loading: true });
    scheduleClient.listSchedules(this.projectId, { date: this.data.selectedDate, limit: 20, cursor: this.data.pagination.nextCursor }).then(body => {
      const more = (body.schedules || []).map(item => this.mapCloudSchedule(item));
      this.setData({
        schedules: this.data.schedules.concat(more),
        pagination: body.pagination || { hasMore: false, nextCursor: null },
        loading: false
      });
    }).catch(error => { this.setData({ error: error.message, loading: false }); });
  },
  refreshLocal() {
    const state = store.read();
    const current = context(state, this.projectId);
    const today = day();
    const schedules = state.schedules.filter(item => item.projectId === this.projectId).map(item => ({ ...item, workerName: (state.accounts.find(user => user.id === item.workerId) || {}).name || '历史成员', status: business.scheduleStatus(state, item, this.data.selectedDate), restText: item.restDays.join('、') }));
    const postOptions = state.schedules.filter(item => item.projectId === this.projectId && business.workerCanPost(state, item, today));
    const records = state.records.filter(item => item.projectId === this.projectId && (!this.data.recordDate || item.date === this.data.recordDate)).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => ({ ...item, images: item.media.filter(media => media.type === 'image'), videos: item.media.filter(media => media.type === 'video'), simulated: item.media.some(media => media.source === 'simulated') }));
    const activeTrades = [...new Set(schedules.filter(item => item.status.active).map(item => item.trade))];
    const updatedTrades = [...new Set(schedules.filter(item => item.status.updated).map(item => item.trade))];
    this.setData({ mode: 'local', ...current, schedules, records, postOptions, today, activeCount: activeTrades.length, updatedCount: updatedTrades.length, isWorker: !!(business.membership(state, this.projectId) || { roles: [] }).roles.includes('师傅'), error: '', pagination: { hasMore: false, nextCursor: null } });
  },
  setTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }); },
  changeDate(event) { this.setData({ selectedDate: event.detail.value }); this.refresh(); },
  returnToday() { this.setData({ selectedDate: day() }); this.refresh(); },
  filterRecords(event) { this.setData({ recordDate: event.detail.value }); this.refresh(); },
  allRecords() { this.setData({ recordDate: '' }); this.refresh(); },
  addPlan() { go(`/pages/schedule/schedule?projectId=${this.projectId}`); },
  editPlan(event) { go(`/pages/schedule-detail/schedule-detail?projectId=${this.projectId}&id=${event.currentTarget.dataset.id || ''}`); },
  publish() { go(`/pages/record/record?projectId=${this.projectId}`); },
  members() { go(`/pages/members/members?projectId=${this.projectId}`); },
  previewImage(event) {
    const record = this.data.records.find(item => item.id === event.currentTarget.dataset.record);
    if (!record) return;
    const urls = record.images.filter(item => item.path).map(item => item.path);
    if (urls.length) wx.previewImage({ current: event.currentTarget.dataset.path, urls, fail: () => fail(new Error('本机图片无法打开，可能已清理。真实文件存储尚未接入。')) });
  },
  mediaFailed() { fail(new Error('本机媒体无法打开，可能已清理。此版本没有云端副本。')); }
});
