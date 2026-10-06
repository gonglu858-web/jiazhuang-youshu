const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/utils/store');
const { createSeed } = require('../miniprogram/utils/seed');
const { day, shift } = require('../miniprogram/utils/date');
const { persist } = require('../miniprogram/utils/media');
const copy = value => JSON.parse(JSON.stringify(value));
let memory;
let modal;
let stack;
let failWrite;
function setup(user = 'manager') {
  memory = createSeed(); memory.currentUserId = user; modal = null; stack = []; failWrite = false;
  global.wx = {
    getStorageSync: () => copy(memory),
    setStorageSync: (_key, value) => { if (failWrite) throw new Error('模拟存储空间不足'); memory = copy(value); },
    showToast: () => {}, showModal: options => { modal = options; }, navigateBack: () => {}, navigateTo: () => {},
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    env: { USER_DATA_PATH: 'test-user-data' }
  };
  global.getCurrentPages = () => stack;
}
function page(name, options = {}) {
  let definition;
  global.Page = value => { definition = value; };
  const file = require.resolve(`../miniprogram/pages/${name}/${name}.js`);
  delete require.cache[file]; require(file);
  const instance = { ...definition, route: `pages/${name}/${name}`, data: copy(definition.data), setData(values) {
    for (const [path, value] of Object.entries(values)) {
      const parts = path.split('.'); let target = this.data;
      while (parts.length > 1) target = target[parts.shift()];
      target[parts[0]] = value;
    }
  } };
  if (instance.onLoad) instance.onLoad(options);
  if (instance.onShow) instance.onShow();
  return instance;
}
const event = (value, dataset = {}) => ({ detail: { value }, currentTarget: { dataset } });
function fillRecord(record) {
  record.toggleSpace(event('', { name: '厨房' }));
  record.inputNote(event('虚构测试：完成定位。'));
}

test('页面流程：管家调整→师傅两照拒绝、三照发布→业主查看→重新加载', async () => {
  setup();
  let index = page('index');
  assert.equal(index.data.projects.length, 1);
  assert.equal(index.data.projects[0].activeCount, 2);
  const schedule = page('schedule', { projectId: 'demo-a', id: 'electric-plan' });
  schedule.input(event('虚构测试：更新后的本次施工内容', { field: 'content' }));
  schedule.save();
  assert.equal(memory.schedules[0].version, 2);
  store.switchAccount('electric');
  const project = page('project', { id: 'demo-a' });
  const record = page('record', { projectId: 'demo-a' }); stack = [project, record];
  assert.equal(record.data.schedule.content, '虚构测试：更新后的本次施工内容');
  assert.equal(record.data.schedule.trade, '水电');
  fillRecord(record);
  record.capture(event('', { type: 'image' })); record.capture(event('', { type: 'image' }));
  await record.submit();
  assert.match(record.data.submitError, /至少/); assert.equal(memory.records.length, 1);
  record.capture(event('', { type: 'image' }));
  await Promise.all([record.submit(), record.submit()]);
  assert.equal(memory.records.length, 2);
  assert.equal(project.data.tab, 'records');
  store.switchAccount('owner');
  const owner = page('project', { id: 'demo-a' });
  assert.equal(owner.data.canManage, false); assert.equal(owner.data.records[0].note, '虚构测试：完成定位。');
  assert.equal(owner.data.updatedCount, 1);
  const again = page('project', { id: 'demo-a' });
  assert.equal(again.data.records.length, 2);
  again.filterRecords(event(shift(day(), -3))); assert.equal(again.data.records.length, 0);
  again.allRecords(); assert.equal(again.data.records.length, 2);
});

test('新增安排按示例工种预选对应阶段，管家仍可手动改选', () => {
  setup();
  const schedule = page('schedule', { projectId: 'demo-a' });
  assert.equal(schedule.data.form.trade, '水电');
  assert.equal(schedule.data.form.stage, '水电隐蔽工程');
  schedule.changeTrade(event(1));
  assert.equal(schedule.data.form.trade, '泥瓦');
  assert.equal(schedule.data.form.stage, '砌墙');
  assert.equal(schedule.data.form.workerId, 'mason');
  schedule.changeStage(event(4));
  assert.equal(schedule.data.form.stage, '泥瓦铺贴');
});

test('页面流程：位置多选与自由文字共存，移除照片后仍可用单视频发布', async () => {
  setup('electric');
  const record = page('record', { projectId: 'demo-a' });
  record.inputLocation(event('厨房、楼梯间'));
  record.toggleSpace(event('', { name: '主卧' }));
  record.toggleSpace(event('', { name: '厨房' }));
  assert.equal(record.data.location, '楼梯间、主卧');
  record.inputNote(event('虚构视频测试'));
  record.capture(event('', { type: 'image' }));
  record.removeMedia(event('', { id: record.data.media[0].id }));
  record.capture(event('', { type: 'video' }));
  await record.submit();
  assert.equal(memory.records.at(-1).media[0].duration, 15);
  assert.equal(memory.records.at(-1).location, '楼梯间、主卧');
});

test('页面流程：本机保存失败保留表单和影像，重试不重复生成记录', async () => {
  setup('electric');
  const record = page('record', { projectId: 'demo-a' }); fillRecord(record);
  record.capture(event('', { type: 'video' }));
  failWrite = true;
  await record.submit();
  assert.equal(memory.records.length, 1); assert.match(record.data.submitError, /空间不足/);
  assert.equal(record.data.note, '虚构测试：完成定位。'); assert.equal(record.data.media.length, 1);
  failWrite = false; await record.submit(); await record.submit();
  assert.equal(memory.records.length, 2);
});

test('文件保存失败后重试复用成功文件，全部完成才可发布', async () => {
  setup(); let attempts = []; let failOnce = true;
  wx.getFileSystemManager = () => ({ copyFile: options => { attempts.push(options.srcPath); if (options.srcPath === 'second' && failOnce) { failOnce = false; options.fail(new Error('模拟文件保存失败')); } else options.success(); } });
  const media = [{ id: 'a', type: 'image', source: 'camera', path: 'first' }, { id: 'b', type: 'video', source: 'camera', path: 'second' }];
  await assert.rejects(persist(media, () => {}), /保存失败/);
  assert.equal(media[0].saved, true); assert.equal(media[1].saved, undefined);
  await persist(media, () => {});
  assert.deepEqual(attempts, ['first', 'second', 'second']);
  assert.ok(media.every(item => item.saved));
});

test('只读角色不能进入编辑或发布页；越项目路由无数据；成员页不含退出成员', () => {
  setup('owner');
  assert.match(page('schedule', { projectId: 'demo-a' }).data.error, /仅项目管家/);
  assert.match(page('record', { projectId: 'demo-a' }).data.error, /没有本人/);
  assert.equal(page('project', { id: 'demo-b' }).data.project, null);
  assert.equal(page('members', { projectId: 'demo-a' }).data.members.some(item => item.userId === 'exited'), false);
  store.switchAccount('carpenter');
  const project = page('project', { id: 'demo-a' });
  assert.equal(project.data.postOptions.length, 0);
  assert.equal(project.data.records.length, 1);
  store.switchAccount('outsider'); assert.equal(page('index').data.projects.length, 0);
});

test('相机调用只请求 camera；取消保留文本，超时视频拒绝，九照上限', () => {
  setup('electric');
  const record = page('record', { projectId: 'demo-a' }); fillRecord(record);
  record.changeMode(event(1));
  wx.chooseMedia = options => {
    assert.deepEqual(options.sourceType, ['camera']); assert.equal(options.maxDuration, 60);
    options.fail({ errMsg: 'chooseMedia:fail cancel' }); options.complete();
  };
  record.capture(event('', { type: 'image' }));
  assert.equal(record.data.capturing, false); assert.equal(record.data.media.length, 0); assert.equal(modal, null);
  wx.chooseMedia = options => { options.success({ tempFiles: [{ tempFilePath: 'test.mp4', duration: 61 }] }); options.complete(); };
  record.capture(event('', { type: 'video' }));
  assert.match(modal.content, /60 秒/); assert.equal(record.data.media.length, 0);
  record.changeMode(event(0));
  for (let i = 0; i < 10; i++) record.capture(event('', { type: 'image' }));
  assert.equal(record.data.images.length, 9);
});

test('合并后的首页同时保留示例项目和云连接测试；模拟响应校验成功', async () => {
  setup();
  global.getApp = () => ({ globalData: { cloudReady: true, cloudError: '' } });
  wx.cloud = { callFunction: options => {
    assert.equal(options.name, 'connectionCheck');
    assert.equal(options.config.env, 'cloud1-d8gcq5ag39d847723');
    return Promise.resolve({ result: { ok: true, service: 'renovation-connection-check', version: '1.0.0', serverTime: '2026-09-23T10:52:28.108Z' } });
  } };
  const index = page('index');
  assert.equal(index.data.projects.length, 1);
  assert.equal(index.data.connectionState, 'idle');
  await index.checkConnection();
  assert.equal(index.data.connectionState, 'success');
  assert.equal(index.data.connectionMessage, '云连接成功');
  assert.equal(index.data.projects.length, 1);
  store.switchAccount('owner');
  index.onShow();
  assert.equal(index.data.account.id, 'owner');
  assert.equal(index.data.connectionState, 'success');
});

test('云 SDK 未就绪时首页不显示连接成功，示例项目仍可试用', async () => {
  setup();
  global.getApp = () => ({ globalData: { cloudReady: false, cloudError: '模拟初始化失败' } });
  const index = page('index');
  await index.checkConnection();
  assert.equal(index.data.connectionState, 'error');
  assert.equal(index.data.connectionMessage, '模拟初始化失败');
  assert.equal(index.data.projects.length, 1);
});

test('正式版、未知版本和账号信息失败时首页测试入口隐藏且不发起云连接', async () => {
  for (const envVersion of ['release', undefined, 'unknown']) {
    setup();
    global.getApp = () => ({ globalData: { cloudReady: true, cloudError: '' } });
    wx.getAccountInfoSync = () => {
      if (envVersion === undefined) throw new Error('unavailable');
      return { miniProgram: { appId: 'wxfb4db1615ac15531', envVersion } };
    };
    let calls = 0;
    wx.cloud = { callFunction: () => { calls++; return Promise.resolve({ result: { ok: true } }); } };
    const index = page('index');
    assert.equal(index.data.testEntryAllowed, false);
    assert.ok(index.data.testEntryMessage);
    index.openCloudAccess();
    index.openPermissionCheck();
    await index.checkConnection();
    assert.equal(calls, 0);
    assert.equal(index.data.connectionState, 'error');
  }
});

test('错 AppID 时首页测试入口不可用且零云请求', async () => {
  setup();
  global.getApp = () => ({ globalData: { cloudReady: true, cloudError: '' } });
  wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'wrong', envVersion: 'develop' } });
  let calls = 0;
  wx.cloud = { callFunction: () => { calls++; return Promise.resolve({ result: { ok: true } }); } };
  const index = page('index');
  assert.equal(index.data.testEntryAllowed, false);
  index.openCloudAccess();
  index.openPermissionCheck();
  await index.checkConnection();
  assert.equal(calls, 0);
});

test('develop 版本首页仍可发起云连接测试，但隐藏后再次进入变为不可用仍停止请求', async () => {
  setup();
  global.getApp = () => ({ globalData: { cloudReady: true, cloudError: '' } });
  wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } });
  wx.cloud = { callFunction: options => {
    assert.equal(options.name, 'connectionCheck');
    return Promise.resolve({ result: { ok: true, service: 'renovation-connection-check', version: '1.0.0', serverTime: '2026-09-23T10:52:28.108Z' } });
  } };
  const index = page('index');
  assert.equal(index.data.testEntryAllowed, true);
  await index.checkConnection();
  assert.equal(index.data.connectionState, 'success');
  // 模拟切换为 release 后再次进入页面
  wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'release' } });
  let callsAfter = 0;
  wx.cloud = { callFunction: () => { callsAfter++; return Promise.resolve({ result: { ok: true } }); } };
  index.onShow();
  assert.equal(index.data.testEntryAllowed, false);
  await index.checkConnection();
  assert.equal(callsAfter, 0);
});

test('首页导航按钮点击时重新校验环境，release 下零跳转、develop 下正常跳转', () => {
  setup();
  global.getApp = () => ({ globalData: { cloudReady: true, cloudError: '' } });
  wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } });
  const index = page('index');
  const navigations = [];
  wx.navigateTo = options => { navigations.push(options); };
  wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'release' } });
  index.openCloudAccess();
  index.openPermissionCheck();
  assert.equal(navigations.length, 0);
  assert.equal(index.data.testEntryAllowed, false);
  assert.ok(index.data.error);
  wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } });
  index.openCloudAccess();
  index.openPermissionCheck();
  assert.equal(navigations.length, 2);
  assert.equal(navigations[0].url, '/pages/access/access');
  assert.equal(navigations[1].url, '/pages/permission-check/permission-check');
});
