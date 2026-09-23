const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeed, SPACES } = require('../miniprogram/utils/seed');
const { day, shift, validDay } = require('../miniprogram/utils/date');
const b = require('../miniprogram/utils/business');
const today = '2026-09-23';
const now = `${today} 16:00:00`;
const stateFor = userId => ({ ...createSeed(today), currentUserId: userId });
const photos = count => Array.from({ length: count }, (_, index) => ({ id: `photo-${index}`, type: 'image', source: 'simulated', capturedAt: now, path: '', duration: 0 }));
const video = duration => ({ id: 'video', type: 'video', source: 'simulated', capturedAt: now, path: '', duration });
const input = (media = photos(3)) => ({ requestId: 'request-1', projectId: 'demo-a', scheduleId: 'electric-plan', scheduleVersion: 1, location: '厨房、餐厅', note: '虚构测试：完成定位', media });

test('本地示例可见项目随账号变化，未加入及已退出账号被拦截', () => {
  for (const user of ['manager', 'electric', 'helper', 'mason', 'owner', 'designer', 'family']) {
    assert.equal(b.canRead(stateFor(user), 'demo-a'), true);
    assert.equal(b.canRead(stateFor(user), 'demo-b'), false);
  }
  assert.equal(b.canRead(stateFor('lead'), 'demo-b'), true);
  assert.equal(b.canRead(stateFor('other'), 'demo-b'), true);
  for (const user of ['outsider', 'exited', 'other']) assert.throws(() => b.project(stateFor(user), 'demo-a'), /无法访问/);
  assert.throws(() => b.project(stateFor('lead'), 'missing'), /无法访问/);
});

test('日期含首尾，支持同日两工种，休息及未来工种不产生待更新', () => {
  const state = stateFor('manager');
  const [electric, mason, wood] = state.schedules;
  assert.equal(state.schedules.filter(plan => b.activeOn(plan, today)).length, 2);
  assert.equal(b.activeOn(electric, electric.start), true);
  assert.equal(b.activeOn(electric, electric.end), true);
  assert.equal(b.scheduleStatus(state, electric, shift(today, 1)).active, false);
  assert.equal(b.scheduleStatus(state, mason, shift(today, 1)).active, true);
  assert.equal(b.scheduleStatus(state, wood, today).active, false);
  assert.equal(b.workerCanPost(stateFor('carpenter'), wood, today), false);
});

test('同工种补充记录计入当日已更新，管家巡检不计入', () => {
  let state = stateFor('helper');
  state.records.push({ projectId: 'demo-a', trade: '水电', date: today, kind: 'inspection' });
  assert.equal(b.scheduleStatus(state, state.schedules[0], today).updated, false);
  state = b.publishRecord(state, input(), today, now, 'r1');
  assert.equal(b.scheduleStatus(state, state.schedules[0], today).updated, true);
  assert.equal(b.scheduleStatus(state, state.schedules[1], today).updated, false);
  assert.equal(state.records.at(-1).authorId, 'helper');
});

test('只有管家可新增、修改安排；角色兼任合并功能', () => {
  for (const user of ['electric', 'owner', 'designer', 'lead']) {
    const state = stateFor(user);
    assert.throws(() => b.saveSchedule(state, 'demo-a', state.schedules[0], now, 'new'), /仅项目管家/);
  }
  const state = stateFor('lead');
  state.members[0].roles.push('管家');
  assert.equal(b.canManage(state, 'demo-a'), true);
  const form = { ...state.schedules[0], id: undefined, trade: '泥瓦', workerId: 'mason' };
  const next = b.saveSchedule(state, 'demo-a', form, now, 'new');
  assert.equal(next.schedules.length, 4);
  assert.equal(state.schedules.length, 3);
});

test('安排拒绝倒置日期、不合法日期、跨范围休息日和错误工种责任人', () => {
  const state = stateFor('manager');
  for (const change of [{ end: '2026-09-01' }, { expected: '2026-09-01' }, { start: '2026-02-30' }, { restDays: ['2026-09-30'] }, { workerId: 'mason' }, { stage: '未定义阶段' }, { content: '   ' }]) {
    assert.throws(() => b.saveSchedule(state, 'demo-a', { ...state.schedules[0], ...change }, now, 'new'));
  }
  assert.equal(validDay('2024-02-29'), true);
  assert.equal(validDay('2026-02-29'), false);
  assert.equal(shift('2026-12-31', 1), '2027-01-01');
});

test('调班保留旧安排与记录快照，旧版表单不能覆盖新安排', () => {
  let state = b.publishRecord(stateFor('electric'), input(), today, now, 'r1');
  state.currentUserId = 'manager';
  const old = state.schedules[0];
  state = b.saveSchedule(state, 'demo-a', { ...old, content: '调整后施工', workerId: 'helper', end: '2026-09-27', expected: '2026-09-27' }, now, 'new');
  assert.equal(state.schedules[0].version, 2);
  assert.equal(state.schedules[0].history[0].workerId, 'electric');
  assert.equal(state.records.at(-1).scheduleSnapshot.content, old.content);
  assert.equal(state.records.at(-1).authorName, '示例水电师傅甲');
  assert.throws(() => b.saveSchedule(state, 'demo-a', old, now, 'new'), /已变化/);
  state.currentUserId = 'electric';
  assert.throws(() => b.publishRecord(state, { ...input(), requestId: 'new-request' }, today, now, 'r2'), /已调整/);
});

test('媒体门槛：三照或一视频；九照上限，60 秒边界与非法来源', () => {
  assert.match(b.mediaError(photos(2)), /至少/);
  assert.equal(b.mediaError(photos(3)), '');
  assert.equal(b.mediaError(photos(9)), '');
  assert.match(b.mediaError(photos(10)), /最多/);
  assert.equal(b.mediaError([video(60)]), '');
  assert.equal(b.mediaError(photos(1).concat(video(15))), '');
  for (const duration of [0, -1, 61, NaN]) assert.match(b.mediaError([video(duration)]), /60 秒/);
  assert.match(b.mediaError(photos(3).map(item => ({ ...item, source: 'album' }))), /现场记录/);
  assert.match(b.mediaError([photos(3)[0], photos(3)[0], photos(3)[1]]), /重复/);
});

test('工种和项目从安排派生，不能用提交参数篡改', () => {
  const state = b.publishRecord(stateFor('electric'), { ...input(), trade: '木工', content: '篡改安排', authorId: 'manager' }, today, now, 'r1');
  assert.equal(state.records.at(-1).trade, '水电');
  assert.equal(state.records.at(-1).authorId, 'electric');
  assert.equal(state.records.at(-1).scheduleSnapshot.content, state.schedules[0].content);
  assert.throws(() => b.publishRecord(stateFor('mason'), input(), today, now, 'r2'), /获授权/);
  assert.throws(() => b.publishRecord(stateFor('electric'), { ...input(), projectId: 'demo-b' }, today, now, 'r2'), /无法访问/);
  assert.throws(() => b.publishRecord(stateFor('manager'), input(), today, now, 'r2'), /获授权/);
  assert.throws(() => b.publishRecord(stateFor('electric'), input(), shift(today, 1), now, 'r2'), /休息/);
});

test('同日可多条；请求重试只生成一条；记录可供同项目成员读取', () => {
  let state = b.publishRecord(stateFor('electric'), input(), today, now, 'r1');
  state = b.publishRecord(state, input(), today, now, 'r2');
  assert.equal(state.records.filter(item => item.date === today).length, 1);
  state = b.publishRecord(state, { ...input(), requestId: 'request-2' }, today, now, 'r3');
  assert.equal(state.records.filter(item => item.date === today).length, 2);
  state.currentUserId = 'owner';
  assert.equal(b.canRead(state, 'demo-a'), true);
  assert.equal(state.records.at(-1).actorRole, '师傅');
});

test('本机相机文件未全部保存时不能生成记录，空位置和说明拒绝', () => {
  const state = stateFor('electric');
  const media = photos(3).map(item => ({ ...item, source: 'camera', path: 'test-temp.jpg' }));
  assert.throws(() => b.publishRecord(state, input(media), today, now, 'r1'), /尚未全部保存/);
  assert.equal(b.publishRecord(state, input(media.map(item => ({ ...item, saved: true }))), today, now, 'r1').records.length, 2);
  for (const change of [{ location: '' }, { note: '  ' }]) assert.throws(() => b.publishRecord(state, { ...input(), ...change }, today, now, 'r1'));
  assert.equal(SPACES.length, 13);
});
