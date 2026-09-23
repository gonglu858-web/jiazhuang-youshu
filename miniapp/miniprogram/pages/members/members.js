const store = require('../../utils/store');
const { day } = require('../../utils/date');
const { activeOn } = require('../../utils/business');
const { context } = require('../../utils/ui');
Page({
  data: { members: [], error: '' },
  onLoad(options) { this.projectId = options.projectId; },
  onShow() {
    try {
      const state = store.read();
      const current = context(state, this.projectId);
      const members = state.members.filter(item => item.projectId === this.projectId && item.status === 'active').map(item => {
        const user = state.accounts.find(account => account.id === item.userId);
        const working = state.schedules.some(plan => plan.projectId === this.projectId && item.trades.includes(plan.trade) && activeOn(plan, day()));
        return { ...item, name: user.name, roleText: item.roles.join('、'), tradeText: item.trades.join('、'), workText: working ? '所属工种今日有施工安排' : '已加入项目 · 今日无需更新' };
      });
      this.setData({ ...current, members, error: '' });
    } catch (error) { this.setData({ error: error.message, project: null, members: [] }); }
  }
});
