const store = require('../../utils/store');
const business = require('../../utils/business');
const { day } = require('../../utils/date');
const { fail, go, context } = require('../../utils/ui');
Page({
  data: { tab: 'plans', selectedDate: '', recordDate: '', error: '', schedules: [], records: [], postOptions: [] },
  onLoad(options) { this.projectId = options.id; this.setData({ selectedDate: day() }); },
  onShow() { this.refresh(); },
  refresh() {
    try {
      const state = store.read();
      const current = context(state, this.projectId);
      const today = day();
      const schedules = state.schedules.filter(item => item.projectId === this.projectId).map(item => ({ ...item, workerName: (state.accounts.find(user => user.id === item.workerId) || {}).name || '历史成员', status: business.scheduleStatus(state, item, this.data.selectedDate), restText: item.restDays.join('、') }));
      const postOptions = state.schedules.filter(item => item.projectId === this.projectId && business.workerCanPost(state, item, today));
      const records = state.records.filter(item => item.projectId === this.projectId && (!this.data.recordDate || item.date === this.data.recordDate)).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => ({ ...item, images: item.media.filter(media => media.type === 'image'), videos: item.media.filter(media => media.type === 'video'), simulated: item.media.some(media => media.source === 'simulated') }));
      const activeTrades = [...new Set(schedules.filter(item => item.status.active).map(item => item.trade))];
      const updatedTrades = [...new Set(schedules.filter(item => item.status.updated).map(item => item.trade))];
      this.setData({ ...current, schedules, records, postOptions, today, activeCount: activeTrades.length, updatedCount: updatedTrades.length, isWorker: !!(business.membership(state, this.projectId) || { roles: [] }).roles.includes('师傅'), error: '' });
    } catch (error) { this.setData({ error: error.message, project: null, schedules: [], records: [], postOptions: [] }); }
  },
  setTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }); },
  changeDate(event) { this.setData({ selectedDate: event.detail.value }); this.refresh(); },
  returnToday() { this.setData({ selectedDate: day() }); this.refresh(); },
  filterRecords(event) { this.setData({ recordDate: event.detail.value }); this.refresh(); },
  allRecords() { this.setData({ recordDate: '' }); this.refresh(); },
  editPlan(event) { go(`/pages/schedule/schedule?projectId=${this.projectId}&id=${event.currentTarget.dataset.id || ''}`); },
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
