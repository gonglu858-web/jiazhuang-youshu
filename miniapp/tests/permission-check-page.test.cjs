const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function findBlockRange(content, marker) {
  const startIdx = content.indexOf(marker);
  if (startIdx === -1) return null;
  let depth = 1;
  let pos = startIdx + marker.length;
  while (depth > 0 && pos < content.length) {
    const nextOpen = content.indexOf('<block', pos);
    const nextClose = content.indexOf('</block>', pos);
    if (nextClose === -1) throw new Error('unclosed block');
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 1;
    } else {
      depth--;
      if (depth === 0) return { start: startIdx, end: nextClose + '</block>'.length };
      pos = nextClose + 1;
    }
  }
  return null;
}

function assertAllHandlersGated(wxmlPath) {
  const content = fs.readFileSync(wxmlPath, 'utf8');
  const range = findBlockRange(content, '<block wx:if="{{testEntryAllowed}}">');
  if (!range) throw new Error('missing testEntryAllowed block in ' + wxmlPath);
  const handlerRegex = /\s(bindtap|bindinput|bindchange|bindconfirm)\s*=\s*"/g;
  for (const segment of [content.slice(0, range.start), content.slice(range.end)]) {
    const matches = segment.match(handlerRegex);
    if (matches && matches.length > 0) {
      throw new Error(`Found ungated interactive handlers in ${wxmlPath}: ${matches.join(', ')}`);
    }
  }
}

function pageWith(wxExtra = {}) {
  let definition;
  const calls = [];
  const wx = {
    cloud: { database: options => {
      calls.push({ type: 'database', options });
      return {
        collection: name => ({
          limit: n => ({ get: () => { calls.push({ type: 'read', collection: name, limit: n }); return Promise.reject({ errCode: -502003, errMsg: 'database permission denied' }); } }),
          add: data => { calls.push({ type: 'write', collection: name, data }); return Promise.reject({ errCode: -502003, errMsg: 'database permission denied' }); }
        })
      };
    } },
    setClipboardData: () => {},
    ...wxExtra
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/permission-check/permission-check.js'), 'utf8'), {
    require: name => name.includes('permission-probe') ? require('../miniprogram/utils/permission-probe') :
      name.includes('env-gate') ? require('../miniprogram/utils/env-gate') :
      ({ envId: 'cloud1-d8gcq5ag39d847723' }),
    getApp: () => ({ globalData: { cloudReady: true } }),
    Page: value => { definition = value; },
    wx
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  if (page.onLoad) page.onLoad();
  return { page, calls };
}

test('release, unknown version, wrong appId and missing account info hide entry and issue no requests', async () => {
  for (const variant of ['release', 'unknown', 'appid', 'missing']) {
    const api = {
      getAccountInfoSync: () => {
        if (variant === 'missing') return {};
        return { miniProgram: {
          appId: variant === 'appid' ? 'wrong' : 'wxfb4db1615ac15531',
          envVersion: variant === 'release' ? 'release' : (variant === 'appid' ? 'develop' : 'unknown')
        } };
      }
    };
    const { page, calls } = pageWith(api);
    assert.equal(page.data.testEntryAllowed, false);
    assert.ok(page.data.testEntryMessage);
    await page.checkRead();
    await page.checkWrite();
    await page.checkBusinessCollections();
    assert.equal(calls.length, 0);
  }
});

test('develop version can still run read, write and business checks', async () => {
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }) };
  const { page, calls } = pageWith(api);
  assert.equal(page.data.testEntryAllowed, true);
  await page.checkRead();
  assert.equal(page.data.readDenied, true);
  await page.checkWrite();
  assert.ok(page.data.writeMessage.includes('拒绝'));
  await page.checkBusinessCollections();
  assert.ok(page.data.businessSummary.includes('六个业务集合'));
  assert.ok(calls.some(c => c.type === 'read'));
  assert.ok(calls.some(c => c.type === 'write'));
});

test('page becomes unavailable after switching to release still issues no requests', async () => {
  const state = { appId: 'wxfb4db1615ac15531', envVersion: 'develop' };
  const api = { getAccountInfoSync: () => ({ miniProgram: state }) };
  const { page, calls } = pageWith(api);
  state.envVersion = 'release';
  await page.checkRead();
  assert.equal(calls.length, 0);
  assert.equal(page.data.testEntryAllowed, false);
});

test('WXML gates all interactive test content behind testEntryAllowed', () => {
  assertAllHandlersGated(path.join(__dirname, '../miniprogram/pages/permission-check/permission-check.wxml'));
});

test('onShow refreshes gate without recreating probe or resetting attempt flags', () => {
  const state = { appId: 'wxfb4db1615ac15531', envVersion: 'develop' };
  const api = { getAccountInfoSync: () => ({ miniProgram: state }) };
  const { page } = pageWith(api);
  const probe = page.probe;
  page.setData({ readAttempted: true, writeAttempted: true, businessAttempted: true });
  page.onShow();
  assert.equal(page.probe, probe);
  assert.equal(page.data.readAttempted, true);
  assert.equal(page.data.writeAttempted, true);
  assert.equal(page.data.businessAttempted, true);
  assert.equal(page.data.testEntryAllowed, true);
});

test('resuming from release to develop keeps reports and marks but re-enables actions', () => {
  const state = { appId: 'wxfb4db1615ac15531', envVersion: 'develop' };
  const api = { getAccountInfoSync: () => ({ miniProgram: state }) };
  const { page, calls } = pageWith(api);
  page.results = [{ collection: 'test', status: 'denied' }];
  page.setData({ details: 'report-body', readAttempted: true, businessAttempted: true });
  state.envVersion = 'release';
  page.onShow();
  assert.equal(page.data.testEntryAllowed, false);
  assert.equal(page.data.details, 'report-body');
  assert.equal(page.data.readAttempted, true);
  assert.equal(calls.length, 0);
  state.envVersion = 'develop';
  page.onShow();
  assert.equal(page.data.testEntryAllowed, true);
  assert.equal(page.data.details, 'report-body');
  assert.equal(page.data.readAttempted, true);
});
