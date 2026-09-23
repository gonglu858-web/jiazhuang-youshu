const { envId, healthFunction } = require('../../config/cloud');
const store = require('../../utils/store');
const business = require('../../utils/business');
const { day } = require('../../utils/date');
const { fail, go } = require('../../utils/ui');

Page({
  data: {
    checking: false,
    connectionState: 'idle',
    connectionMessage: '尚未测试云连接',
    serverTime: '',
    accounts: [],
    projects: [],
    error: ''
  },
  onShow() { this.refreshProjects(); },
  refreshProjects() {
    try {
      const state = store.read();
      const today = day();
      const projects = state.projects.filter(item => business.canRead(state, item.id)).map(item => {
        const schedules = state.schedules.filter(plan => plan.projectId === item.id && business.activeOn(plan, today));
        const trades = [...new Set(schedules.map(plan => plan.trade))];
        const updated = trades.filter(trade => state.records.some(record => record.projectId === item.id && record.trade === trade && record.date === today && record.kind === 'worker')).length;
        return { ...item, activeCount: trades.length, updatedCount: updated, role: (business.membership(state, item.id) || { roles: ['负责人'] }).roles.join('、') };
      });
      this.setData({ accounts: state.accounts, account: business.account(state), accountIndex: state.accounts.findIndex(item => item.id === state.currentUserId), projects, today, seedDate: state.seedDate, error: '' });
    } catch (error) { this.setData({ error: error.message, projects: [] }); }
  },
  switchAccount(event) {
    try { store.switchAccount(this.data.accounts[Number(event.detail.value)].id); this.refreshProjects(); } catch (error) { fail(error); }
  },
  openProject(event) { go(`/pages/project/project?id=${event.currentTarget.dataset.id}`); },
  resetDemo() {
    wx.showModal({ title: '重置本地虚构示例？', content: '本机试填的安排和记录会恢复为初始示例，并以今天生成日期。不会操作云端。此前测试拍摄的本机文件不会在这里删除。', success: result => {
      if (!result.confirm) return;
      try { store.reset(); this.refreshProjects(); } catch (error) { fail(error); }
    } });
  },
  async checkConnection() {
    if (this.data.checking) return;
    const app = getApp();
    if (!app.globalData.cloudReady) {
      this.setData({
        connectionState: 'error',
        connectionMessage: app.globalData.cloudError || '云开发尚未初始化，请重新打开小程序。',
        serverTime: ''
      });
      return;
    }
    this.setData({
      checking: true,
      connectionState: 'checking',
      connectionMessage: '正在连接云端…',
      serverTime: ''
    });
    let timeoutId;
    try {
      const response = await Promise.race([
        wx.cloud.callFunction({ name: healthFunction, config: { env: envId }, data: {} }),
        new Promise((resolve, reject) => {
          timeoutId = setTimeout(() => reject(new Error('连接超时，请检查网络后重试。')), 15000);
        })
      ]);
      const result = response && response.result;
      if (!result || result.ok !== true || result.service !== 'renovation-connection-check' ||
          result.version !== '1.0.0' || typeof result.serverTime !== 'string' ||
          !Number.isFinite(Date.parse(result.serverTime))) {
        throw new Error('云端返回内容不符合预期，请核对测试函数版本。');
      }
      this.setData({
        connectionState: 'success',
        connectionMessage: '云连接成功',
        serverTime: result.serverTime
      });
    } catch (error) {
      console.error('Cloud connection check failed', error);
      this.setData({
        connectionState: 'error',
        connectionMessage: error.message || error.errMsg || '连接失败，请检查网络后重试。',
        serverTime: ''
      });
    } finally {
      clearTimeout(timeoutId);
      this.setData({ checking: false });
    }
  }
});
