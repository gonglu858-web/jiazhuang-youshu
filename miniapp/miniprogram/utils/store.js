const { createSeed } = require('./seed');
const KEY = 'renovation-native-local-v1';

function read() {
  const stored = wx.getStorageSync(KEY);
  if (!stored) {
    const initial = createSeed();
    write(initial);
    return initial;
  }
  if (stored.schema !== 1 || !Array.isArray(stored.records) || !Array.isArray(stored.schedules)) {
    throw new Error('本地示例数据格式无法读取，请从项目列表重置示例。');
  }
  return JSON.parse(JSON.stringify(stored));
}

function write(state) {
  // 写入失败必须向页面抛错，不能假装已保存。
  wx.setStorageSync(KEY, state);
}

function switchAccount(userId) {
  const state = read();
  if (!state.accounts.some(item => item.id === userId)) throw new Error('示例账号不存在。');
  state.currentUserId = userId;
  write(state);
}

const reset = () => write(createSeed());
const uid = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
module.exports = { read, write, switchAccount, reset, uid, KEY };
