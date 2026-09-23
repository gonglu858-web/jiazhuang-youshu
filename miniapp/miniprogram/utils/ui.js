const business = require('./business');
const fail = error => wx.showModal({ title: '暂未完成', content: error.message || '操作失败，请重试。', showCancel: false });
const go = url => wx.navigateTo({ url });

function context(state, projectId) {
  const project = business.project(state, projectId);
  const member = business.membership(state, projectId);
  return { project, account: business.account(state), roleText: member ? member.roles.join('、') : '负责人', canManage: business.canManage(state, projectId) };
}

module.exports = { fail, go, context };
