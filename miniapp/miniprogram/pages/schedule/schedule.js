const store = require('../../utils/store');
const business = require('../../utils/business');
const { STAGES } = require('../../utils/seed');
const { day, time } = require('../../utils/date');
const { fail, context } = require('../../utils/ui');
const suggestedStage = { '水电': '水电隐蔽工程', '泥瓦': '砌墙', '木工': '木工施工' };
Page({
  data: { error: '', stages: STAGES, trades: [], workers: [], history: [], form: { restDays: [] }, saving: false },
  onLoad(options) {
    this.projectId = options.projectId;
    try {
      const state = store.read();
      const current = context(state, this.projectId);
      if (!current.canManage) throw new Error('仅项目管家可以维护施工安排。');
      this.members = state.members.filter(item => item.projectId === this.projectId && item.status === 'active' && item.roles.includes('师傅'));
      this.accounts = state.accounts;
      const trades = [...new Set(this.members.reduce((all, member) => all.concat(member.trades), []))];
      if (!trades.length) throw new Error('本项目尚无获授权工种的师傅，暂不能安排施工。');
      const old = options.id ? state.schedules.find(item => item.id === options.id && item.projectId === this.projectId) : null;
      if (options.id && !old) throw new Error('没有找到此施工安排。');
      const form = old || { trade: trades[0], stage: suggestedStage[trades[0]] || STAGES[0], start: day(), end: day(), expected: day(), content: '', restDays: [], workerId: '' };
      this.setData({ ...current, trades, form, tradeIndex: trades.indexOf(form.trade), stageIndex: STAGES.indexOf(form.stage), restDate: form.start, history: old ? old.history.slice().reverse() : [] });
      this.refreshWorkers();
    } catch (error) { this.setData({ error: error.message, project: null }); }
  },
  refreshWorkers() {
    const workers = this.members.filter(item => item.trades.includes(this.data.form.trade)).map(item => ({ id: item.userId, name: this.accounts.find(user => user.id === item.userId).name }));
    let workerIndex = workers.findIndex(item => item.id === this.data.form.workerId);
    if (workerIndex < 0) workerIndex = 0;
    this.setData({ workers, workerIndex, 'form.workerId': workers[workerIndex] ? workers[workerIndex].id : '' });
  },
  changeTrade(event) {
    const index = Number(event.detail.value);
    const trade = this.data.trades[index];
    const stage = suggestedStage[trade] || STAGES[0];
    this.setData({ tradeIndex: index, stageIndex: STAGES.indexOf(stage), 'form.trade': trade, 'form.stage': stage });
    this.refreshWorkers();
  },
  changeStage(event) { const index = Number(event.detail.value); this.setData({ stageIndex: index, 'form.stage': STAGES[index] }); },
  changeWorker(event) { const index = Number(event.detail.value); this.setData({ workerIndex: index, 'form.workerId': this.data.workers[index].id }); },
  input(event) { const field = event.currentTarget.dataset.field; if (['start', 'end', 'expected', 'content'].includes(field)) this.setData({ [`form.${field}`]: event.detail.value }); },
  chooseRest(event) { this.setData({ restDate: event.detail.value }); },
  addRest() {
    const { form, restDate } = this.data;
    if (restDate < form.start || restDate > form.end) return fail(new Error('请选择施工日期范围内的休息／停工日。'));
    this.setData({ 'form.restDays': [...new Set(form.restDays.concat(restDate))].sort() });
  },
  removeRest(event) { this.setData({ 'form.restDays': this.data.form.restDays.filter(date => date !== event.currentTarget.dataset.date) }); },
  save() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const next = business.saveSchedule(store.read(), this.projectId, this.data.form, time(), store.uid('plan'));
      store.write(next);
      wx.showToast({ title: '已保存到本机', icon: 'success' });
      wx.navigateBack();
    } catch (error) { this.setData({ saving: false }); fail(error); }
  }
});
