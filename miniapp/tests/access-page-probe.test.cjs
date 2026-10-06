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

const DEFAULT_WX = {
  getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
  getStorageSync: () => null,
  setStorageSync: () => {}
};

function pageWith(callFunction, wxExtra = {}, proof = require('../miniprogram/config/valid-binding-proof'),
  approvalProof = require('../miniprogram/config/valid-approval-proof'),
  concurrentProof = require('../miniprogram/config/valid-concurrent-approval-proof'),
  primaryOwnerProof = require('../miniprogram/config/valid-primary-owner-concurrency-proof')) {
  let definition;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../miniprogram/pages/access/access.js'), 'utf8'), {
    require: name => name.includes('valid-primary-owner-concurrency-proof') ? primaryOwnerProof :
      name.includes('primary-owner-concurrency-probe') ? require('../miniprogram/utils/primary-owner-concurrency-probe') :
      name.includes('valid-concurrent-approval-proof') ? concurrentProof :
      name.includes('concurrent-approval-probe') ? require('../miniprogram/utils/concurrent-approval-probe') :
      name.includes('valid-approval-proof') ? approvalProof :
      name.includes('valid-approval-probe') ? require('../miniprogram/utils/valid-approval-probe') :
      name.includes('valid-binding-proof') ? proof : name.includes('member-write-probe') ? require('../miniprogram/utils/member-write-probe') :
      name.includes('env-gate') ? require('../miniprogram/utils/env-gate') :
      ({ envId: 'cloud1-d8gcq5ag39d847723' }),
    getApp: () => ({ globalData: { cloudReady: true } }),
    Page: value => { definition = value; },
    wx: { cloud: { callFunction: async args => { calls.push(args); return callFunction(args); } }, ...DEFAULT_WX, ...wxExtra }
  });
  const page = { ...definition, data: { ...definition.data, identified: true,
    transactionReady: true, accountLabel: '本人账号 989a74' },
    setData(values) { Object.assign(this.data, values); } };
  if (page.refreshEnvGate) page.refreshEnvGate();
  return { page, calls };
}

function concurrentProofEnabled() {
  const { bindingDigest } = require('../miniprogram/utils/binding-digest');
  const number = '1234567890';
  return { enabled: true, evidenceId: 'synthetic-page-concurrent',
    projectId: 'p_38507fc9b43c4e23a7fbd996415637bb',
    actorId: 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d',
    applicantUserId: 'u_a2acfbaea35f409671860b2c4b13d777a6989a74',
    memberId: 'm_4312a8548b3a432854ade093290e72c6ed5a6f7f',
    invitationId: 'i_0e0483488efb40ada6825d259ebc1736',
    issuedByUserId: 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d',
    role: '师傅', trades: ['拆改'], status: 'requested',
    invitationExpiresAt: new Date(Date.now() + 120000).toISOString(),
    verifiedAt: new Date(Date.now() - 5000).toISOString(),
    checkBefore: new Date(Date.now() + 60000).toISOString(),
    bindingProof: { evidenceId: 'synthetic-binding-page', userId: 'u_a2acfbaea35f409671860b2c4b13d777a6989a74',
      digest: bindingDigest(number), verifiedAt: new Date(Date.now() - 6000).toISOString(),
      checkBefore: new Date(Date.now() + 60000).toISOString(),
      expiresAt: new Date(Date.now() + 120000).toISOString() } };
}

test('有效成员页面只允许目标开发版本，跨页面重进也不重发检查', async () => {
  const { MEMBER_TARGET: target } = require('../miniprogram/utils/member-write-probe');
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: target.actorId, isAdmin: false } };
    if (data.action === 'getMembers') return { result: { ok: true,
      project: { id: target.projectId, roles: ['主业主'], scope: 'identity-test', status: 'active' },
      members: [{ id: target.memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] } };
    return { result: { ok: false, code: 'NO_ACCESS', message: '仅项目管家可管理成员。' } };
  };
  const { page, calls } = pageWith(respond, api);
  page.data.accountLabel = '本人账号 f182f4';
  const running = page.checkValidMember();
  await page.checkValidMember();
  await running;
  assert.equal(JSON.parse(page.data.validMemberReport).complete, true);
  assert.equal(calls.filter(c => c.data.action === 'removeMember').length, 1);
  const fresh = pageWith(respond, api);
  fresh.page.data.accountLabel = '本人账号 f182f4';
  await fresh.page.checkValidMember();
  assert.equal(fresh.calls.length, 0);
  assert.equal(fresh.page.data.validMemberReport, page.data.validMemberReport);
});

test('有效待申请页面仅发送一次固定批准请求，清除编号并跨页面防重', async () => {
  const { bindingDigest } = require('../miniprogram/utils/binding-digest');
  const actual = require('../miniprogram/config/valid-approval-proof');
  const number = '1234567890';
  const proof = { ...actual, evidenceId: 'synthetic-approval-page',
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
    checkBefore: new Date(Date.now() + 60000).toISOString(),
    invitationExpiresAt: new Date(Date.now() + 120000).toISOString(),
    bindingProof: { evidenceId: 'synthetic-binding', userId: actual.applicantUserId,
      digest: bindingDigest(number), verifiedAt: new Date(Date.now() - 2000).toISOString(),
      checkBefore: new Date(Date.now() + 60000).toISOString(),
      expiresAt: new Date(Date.now() + 120000).toISOString() } };
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: proof.actorId, isAdmin: false } };
    if (data.action === 'getMembers') return { result: { ok: true,
      project: { id: proof.projectId, scope: 'identity-test', status: 'active', roles: ['主业主'] },
      members: [{ id: proof.memberId, label: '成员 989a74',
        roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] } };
    return { result: { ok: false, code: 'NO_ACCESS', message: '仅项目管家可管理成员。' } };
  };
  const { page, calls } = pageWith(respond, api, undefined, proof);
  Object.assign(page.data, { accountLabel: '本人账号 f182f4', validApprovalNumber: number });
  const running = page.checkValidApproval();
  await page.checkValidApproval();
  await running;
  assert.equal(JSON.parse(page.data.validApprovalReport).complete, true);
  assert.equal(page.data.validApprovalNumber, '');
  assert.equal(JSON.stringify(store).includes(number), false);
  assert.equal(calls.filter(row => row.data.action === 'approveInvitation').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(row => row.data.action === 'approveInvitation').data)),
    { action: 'approveInvitation', projectId: proof.projectId,
      invitationId: proof.invitationId, applicantNumber: number });
  const fresh = pageWith(respond, api, undefined, proof);
  fresh.page.data.accountLabel = '本人账号 f182f4';
  await fresh.page.checkValidApproval();
  assert.equal(fresh.calls.length, 0);
  assert.equal(fresh.page.data.validApprovalReport, page.data.validApprovalReport);
});

test('有效待申请页面遇到正式版、错AppID、错身份、过期和存储失败时不调用云端', async () => {
  const { bindingDigest } = require('../miniprogram/utils/binding-digest');
  const actual = require('../miniprogram/config/valid-approval-proof');
  const number = '1234567890';
  for (const variant of ['release', 'appid', 'actor', 'expiry', 'storage']) {
    const until = Date.now() + (variant === 'expiry' ? -1000 : 60000);
    const proof = { ...actual, evidenceId: 'synthetic-' + variant,
      verifiedAt: new Date(Date.now() - 5000).toISOString(),
      checkBefore: new Date(until).toISOString(),
      invitationExpiresAt: new Date(Date.now() + 120000).toISOString(),
      bindingProof: { evidenceId: 'synthetic', userId: actual.applicantUserId,
        digest: bindingDigest(number), verifiedAt: new Date(Date.now() - 6000).toISOString(),
        checkBefore: new Date(Date.now() + 60000).toISOString(),
        expiresAt: new Date(Date.now() + 120000).toISOString() } };
    const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, {
      getAccountInfoSync: () => ({ miniProgram: { appId: variant === 'appid' ? 'wrong' : 'wxfb4db1615ac15531',
        envVersion: variant === 'release' ? 'release' : 'trial' } }),
      getStorageSync: () => null,
      setStorageSync: () => { if (variant === 'storage') throw new Error('storage failure'); }
    }, undefined, proof);
    Object.assign(page.data, { accountLabel: variant === 'actor' ? 'other' : '本人账号 f182f4',
      validApprovalNumber: number });
    await page.checkValidApproval();
    assert.equal(calls.length, 0);
    assert.equal(page.data.validApprovalNumber, '');
  }
});

test('正式版、错误AppID、非主业主或存储不可用不执行有效成员检查', async () => {
  for (const variant of ['release', 'appid', 'actor', 'storage']) {
    const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, {
      getAccountInfoSync: () => ({ miniProgram: { appId: variant === 'appid' ? 'wrong' : 'wxfb4db1615ac15531',
        envVersion: variant === 'release' ? 'release' : 'trial' } }),
      getStorageSync: () => null,
      setStorageSync: () => { if (variant === 'storage') throw new Error('storage failure'); }
    });
    if (variant !== 'actor') page.data.accountLabel = '本人账号 f182f4';
    await page.checkValidMember();
    assert.equal(calls.length, 0);
    assert.ok(page.data.validMemberSummary);
  }
});

test('有效编号页面清除输入、不缓存原始编号，重进页面不重复请求', async () => {
  const { MEMBER_TARGET: target } = require('../miniprogram/utils/member-write-probe');
  const { bindingDigest } = require('../miniprogram/utils/binding-digest');
  const number = '1234567890';
  const proof = { evidenceId: 'synthetic-page', userId: target.userId, digest: bindingDigest(number),
    verifiedAt: new Date(Date.now() - 1000).toISOString(), checkBefore: new Date(Date.now() + 60000).toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString() };
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: target.actorId, isAdmin: false } };
    if (data.action === 'getMembers') return { result: { ok: true,
      project: { id: target.projectId, roles: ['主业主'], scope: 'identity-test', status: 'active' },
      members: [{ id: target.memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] } };
    return { result: { ok: false, code: 'NO_ACCESS', message: '仅负责人可指定管家。' } };
  };
  const { page, calls } = pageWith(respond, api, proof);
  Object.assign(page.data, { accountLabel: '本人账号 f182f4', validBindingNumber: number });
  const running = page.checkValidBinding();
  await page.checkValidBinding();
  await running;
  assert.equal(JSON.parse(page.data.validBindingReport).complete, true);
  assert.equal(page.data.validBindingNumber, '');
  assert.equal(JSON.stringify(store).includes(number), false);
  assert.equal(calls.filter(row => row.data.action === 'assignManager').length, 1);
  const fresh = pageWith(respond, api, proof);
  fresh.page.data.accountLabel = '本人账号 f182f4';
  await fresh.page.checkValidBinding();
  assert.equal(fresh.calls.length, 0);
  assert.equal(fresh.page.data.validBindingReport, page.data.validBindingReport);
});

test('有效编号页面未就绪、正式版、存储失败或输入错误时没有云端请求', async () => {
  const { MEMBER_TARGET: target } = require('../miniprogram/utils/member-write-probe');
  const { bindingDigest } = require('../miniprogram/utils/binding-digest');
  const number = '1234567890';
  const proof = { evidenceId: 'synthetic-gates', userId: target.userId, digest: bindingDigest(number),
    verifiedAt: new Date(Date.now() - 1000).toISOString(), checkBefore: new Date(Date.now() + 60000).toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString() };
  for (const variant of ['release', 'actor', 'storage', 'input', 'not-ready']) {
    const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, {
      getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: variant === 'release' ? 'release' : 'trial' } }),
      getStorageSync: () => null, setStorageSync: () => { if (variant === 'storage') throw new Error('storage failure'); }
    }, proof);
    Object.assign(page.data, { accountLabel: variant === 'actor' ? 'other' : '本人账号 f182f4',
      transactionReady: variant !== 'not-ready', validBindingNumber: variant === 'input' ? '' : number });
    await page.checkValidBinding();
    assert.equal(calls.length, 0);
  }
});

test('退出账号探针直接读取两个项目，四项明确拒绝；不发送写操作或保存成员内容', async () => {
  const { page, calls } = pageWith(async () => ({ result: {
    ok: false, code: 'NO_ACCESS', message: '当前微信账号不是该项目成员。' } }));
  await page.checkProjectAccess();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(c => c.data.action), ['getMembers', 'listInvitations', 'getMembers', 'listInvitations']);
  assert.equal(new Set(calls.map(c => c.data.projectId)).size, 2);
  assert.ok(calls.every(c => c.name === 'memberAccess' && c.config.env === 'cloud1-d8gcq5ag39d847723'));
  const report = JSON.parse(page.data.accessCheckReport);
  assert.equal(report.complete, true);
  assert.ok(report.results.every(row => row.status === 'denied'));
  assert.equal(page.data.busy, false);
});

test('错误不会冒充权限拒绝，遇到网络、登录、服务端或无效响应时停止', async () => {
  for (const respond of [
    async () => { const error = new Error('network failed'); error.code = 'NO_ACCESS'; throw error; },
    async () => ({ result: { ok: false, code: 'IDENTITY_UNAVAILABLE', message: '身份不可用' } }),
    async () => ({ result: { ok: false, code: 'SERVER_ERROR', message: '服务失败' } }),
    async () => ({ result: { code: 'NO_ACCESS' } }),
    async () => ({})
  ]) {
    const { page, calls } = pageWith(respond);
    await page.checkProjectAccess();
    const report = JSON.parse(page.data.accessCheckReport);
    assert.equal(calls.length, 1);
    assert.equal(report.complete, false);
    assert.equal(report.results[0].status, 'inconclusive');
    assert.equal(page.data.busy, false);
  }
});

test('允许访问如实显示，丢弃响应资料；未识别或执行中不重复请求', async () => {
  const { page, calls } = pageWith(async () => ({ result: { ok: true, members: ['private-member'] } }));
  page.data.identified = false;
  await page.checkProjectAccess();
  assert.equal(calls.length, 0);
  page.data.identified = true;
  const running = page.checkProjectAccess();
  await page.checkProjectAccess();
  await running;
  assert.equal(calls.length, 4);
  const report = JSON.parse(page.data.accessCheckReport);
  assert.ok(report.results.every(row => row.status === 'allowed'));
  assert.equal(page.data.accessCheckReport.includes('private-member'), false);
});

test('写检查页面禁止负责人、未就绪及重复执行，输出完整报告', async () => {
  const { page, calls } = pageWith(async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: 'u_worker989a74', isAdmin: false } };
    if (data.action === 'listMyProjects') return { result: { ok: true, projects: [] } };
    return { result: { ok: false, code: 'NO_ACCESS', message: data.action === 'assignManager' ?
      '仅负责人可指定管家。' : '当前微信账号不是该项目成员。' } };
  });
  page.data.isAdmin = true;
  await page.checkWriteAccess();
  page.data.isAdmin = false;
  page.data.transactionReady = false;
  await page.checkWriteAccess();
  assert.equal(calls.length, 0);
  page.data.transactionReady = true;
  const running = page.checkWriteAccess();
  await page.checkWriteAccess();
  await running;
  const count = calls.length;
  await page.checkWriteAccess();
  assert.equal(calls.length, count);
  const report = JSON.parse(page.data.writeCheckReport);
  assert.equal(report.env, 'cloud1-d8gcq5ag39d847723');
  assert.equal(report.complete, true);
  assert.equal(report.results.length, 8);
  assert.equal(page.data.busy, false);
});

for (const [role, mode, method] of [
  [['师傅'], 'active-worker', 'checkWorkerRole'],
  [['主业主'], 'active-primary-owner', 'checkPrimaryOwnerRole'],
  [['设计师', '师傅'], 'active-worker-designer', 'checkWorkerDesignerRole']
]) {
test(`项目内${role}按钮选择正确模式，报告含成员允许和管家列表拒绝预检`, async () => {
  const project = { id: 'p_38507fc9b43c4e23a7fbd996415637bb', roles: role,
    scope: 'identity-test', status: 'active' };
  const { page } = pageWith(async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: 'u_worker989a74', isAdmin: false } };
    if (data.action === 'listMyProjects') return { result: { ok: true, projects: [project] } };
    if (data.action === 'getMembers') return { result: { ok: true, project, members: [] } };
    return { result: { ok: false, code: 'NO_ACCESS', message: data.action === 'assignManager' ?
      '仅负责人可指定管家。' : '仅项目管家可管理成员。' } };
  });
  await page[method]();
  const report = JSON.parse(page.data.writeCheckReport);
  assert.equal(report.mode, mode);
  assert.equal(report.complete, true);
  assert.equal(report.results.length, 4);
  assert.deepEqual(report.preflight.map(r => r.status), ['allowed', 'denied']);
});
}

test('并发批准卡片默认禁用，管家账号也不发送请求', async () => {
  const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, {
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: () => null, setStorageSync: () => {}
  });
  page.data.accountLabel = '本人账号 64193d';
  page.data.concurrentApprovalNumber = '1234567890';
  await page.checkConcurrentApproval();
  assert.equal(calls.length, 0);
  assert.ok(page.data.concurrentApprovalSummary);
});

test('并发批准卡片启用后仅管家账号可发两次请求，清除编号并跨页面防重', async () => {
  const proof = concurrentProofEnabled();
  const number = '1234567890';
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  let callIndex = 0;
  let listCalls = 0;
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: proof.actorId, isAdmin: false } };
    if (data.action === 'getMembers') return { result: { ok: true,
      project: { id: proof.projectId, scope: 'identity-test', status: 'active', roles: ['管家'] },
      members: [{ id: proof.memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] } };
    if (data.action === 'listInvitations') {
      listCalls++;
      return { result: { ok: true,
        invitations: listCalls > 1 ? [] : [{ id: proof.invitationId, role: '师傅', trades: ['拆改'], applicantLabel: '成员 989a74' }] } };
    }
    callIndex++;
    if (callIndex === 1) return { result: { ok: true, invitationId: proof.invitationId, status: 'approved' } };
    return { result: { ok: false, code: 'CODE_INVALID', message: '邀请未待核对或编号已失效。' } };
  };
  const { page, calls } = pageWith(respond, api, undefined, undefined, proof);
  Object.assign(page.data, { accountLabel: '本人账号 64193d', concurrentApprovalNumber: number });
  const running = page.checkConcurrentApproval();
  await page.checkConcurrentApproval();
  await running;
  const report = JSON.parse(page.data.concurrentApprovalReport);
  assert.equal(report.complete, true);
  assert.equal(report.after.targetRemoved, true);
  assert.equal(page.data.concurrentApprovalNumber, '');
  assert.equal(JSON.stringify(store).includes(number), false);
  assert.equal(calls.filter(row => row.data.action === 'approveInvitation').length, 2);
  const fresh = pageWith(respond, api, undefined, undefined, proof);
  fresh.page.data.accountLabel = '本人账号 64193d';
  await fresh.page.checkConcurrentApproval();
  assert.equal(fresh.calls.length, 0);
});

test('并发批准卡片在正式版、错AppID、错身份、存储失败时不调用云端', async () => {
  const proof = concurrentProofEnabled();
  const number = '1234567890';
  for (const variant of ['release', 'appid', 'actor', 'storage']) {
    const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, {
      getAccountInfoSync: () => ({ miniProgram: { appId: variant === 'appid' ? 'wrong' : 'wxfb4db1615ac15531',
        envVersion: variant === 'release' ? 'release' : 'trial' } }),
      getStorageSync: () => null,
      setStorageSync: () => { if (variant === 'storage') throw new Error('storage failure'); }
    }, undefined, undefined, proof);
    Object.assign(page.data, { accountLabel: variant === 'actor' ? 'other' : '本人账号 64193d',
      concurrentApprovalNumber: number });
    await page.checkConcurrentApproval();
    assert.equal(calls.filter(row => row.data && row.data.action === 'approveInvitation').length, 0);
    assert.equal(page.data.concurrentApprovalNumber, '');
  }
});

test('并发批准卡片持久化报告不泄露编号或任意错误内容', async () => {
  const proof = concurrentProofEnabled();
  const number = '1234567890';
  const repeated = number + number;
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  let callIndex = 0;
  let listCalls = 0;
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: proof.actorId, isAdmin: false } };
    if (data.action === 'getMembers') return { result: { ok: true,
      project: { id: proof.projectId, scope: 'identity-test', status: 'active', roles: ['管家'] },
      members: [{ id: proof.memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] } };
    if (data.action === 'listInvitations') {
      listCalls++;
      return { result: { ok: true,
        invitations: listCalls > 1 ? [] : [{ id: proof.invitationId, role: '师傅', trades: ['拆改'], applicantLabel: '成员 989a74' }] } };
    }
    callIndex++;
    if (callIndex === 1) return { result: { ok: true, invitationId: proof.invitationId, status: 'approved', raw: number } };
    return { result: { ok: false, code: 'CODE_INVALID', message: 'raw failure ' + repeated } };
  };
  const { page, calls } = pageWith(respond, api, undefined, undefined, proof);
  Object.assign(page.data, { accountLabel: '本人账号 64193d', concurrentApprovalNumber: number });
  await page.checkConcurrentApproval();
  const report = JSON.parse(page.data.concurrentApprovalReport);
  assert.equal(report.complete, true);
  assert.equal(report.after.targetRemoved, true);
  assert.equal(calls.filter(row => row.data.action === 'approveInvitation').length, 2);
  assert.equal(page.data.concurrentApprovalNumber, '');
  const stored = JSON.stringify(store);
  assert.equal(stored.includes(number), false);
  assert.equal(stored.includes('raw failure'), false);
  assert.equal(stored.includes('raw'), false);
});

test('并发批准卡片遇到无效响应不计为成功且不保存报告', async () => {
  const proof = concurrentProofEnabled();
  const number = '1234567890';
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: proof.actorId, isAdmin: false } };
    if (data.action === 'getMembers') return { result: { ok: true,
      project: { id: proof.projectId, scope: 'identity-test', status: 'active', roles: ['管家'] },
      members: [{ id: proof.memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] } };
    if (data.action === 'listInvitations') return { result: { ok: true,
      invitations: [{ id: proof.invitationId, role: '师傅', trades: ['拆改'], applicantLabel: '成员 989a74' }] } };
    return { result: { ok: true, invitationId: 'i_other', status: 'approved' } };
  };
  const { page, calls } = pageWith(respond, api, undefined, undefined, proof);
  Object.assign(page.data, { accountLabel: '本人账号 64193d', concurrentApprovalNumber: number });
  await page.checkConcurrentApproval();
  const report = JSON.parse(page.data.concurrentApprovalReport);
  assert.equal(report.complete, false);
  assert.equal(calls.filter(row => row.data.action === 'approveInvitation').length, 2);
  assert.equal(report.results.filter(row => row.status === 'success').length, 0);
  const stored = store['yf-concurrent-approval-' + proof.evidenceId];
  assert.ok(stored && stored.started);
  assert.equal((stored.report || '').includes('i_other'), false);
});

test('并发批准卡片后置读取未知码及重复编号不泄露到存储', async () => {
  const proof = concurrentProofEnabled();
  const number = '1234567890';
  const repeated = number + number;
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  let callIndex = 0;
  let listCalls = 0;
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: proof.actorId, isAdmin: false } };
    if (data.action === 'getMembers') return { result: { ok: true,
      project: { id: proof.projectId, scope: 'identity-test', status: 'active', roles: ['管家'] },
      members: [{ id: proof.memberId, label: '成员 989a74', roles: ['师傅', '设计师'], trades: ['拆改', '木工'] }] } };
    if (data.action === 'listInvitations') {
      listCalls++;
      if (listCalls > 1) return { result: { ok: false, code: 'UNEXPECTED_AFTER_' + number, message: 'after failed ' + repeated } };
      return { result: { ok: true,
        invitations: [{ id: proof.invitationId, role: '师傅', trades: ['拆改'], applicantLabel: '成员 989a74' }] } };
    }
    callIndex++;
    if (callIndex === 1) return { result: { ok: true, invitationId: proof.invitationId, status: 'approved' } };
    return { result: { ok: false, code: 'CODE_INVALID', message: '邀请未待核对或编号已失效。' } };
  };
  const { page, calls } = pageWith(respond, api, undefined, undefined, proof);
  Object.assign(page.data, { accountLabel: '本人账号 64193d', concurrentApprovalNumber: number });
  await page.checkConcurrentApproval();
  const report = JSON.parse(page.data.concurrentApprovalReport);
  assert.equal(report.complete, true);
  assert.equal(calls.filter(row => row.data.action === 'approveInvitation').length, 2);
  assert.ok(report.afterReadError);
  assert.equal(report.afterReadError.code, '');
  const stored = JSON.stringify(store);
  assert.equal(stored.includes(number), false);
  assert.equal(stored.includes('UNEXPECTED_AFTER'), false);
  assert.equal(stored.includes('after failed'), false);
});

test('公共 call 出口在 release、未知版本、错 AppID、账号信息失败时零请求', async () => {
  for (const variant of ['release', 'unknown', 'missing', 'appid', 'throw']) {
    const api = {
      getAccountInfoSync: () => {
        if (variant === 'throw') throw new Error('unavailable');
        if (variant === 'missing') return {};
        return { miniProgram: {
          appId: variant === 'appid' ? 'wrong' : 'wxfb4db1615ac15531',
          envVersion: variant === 'appid' ? 'develop' : (variant === 'release' ? 'release' : 'unknown')
        } };
      }
    };
    const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, api);
    await assert.rejects(page.call('identify', {}), /不可用|不匹配|未识别|无法读取|仅目标/);
    assert.equal(calls.length, 0);
  }
});

test('页面由允许变为不允许后事件调用仍零请求', async () => {
  const state = { appId: 'wxfb4db1615ac15531', envVersion: 'develop' };
  const api = { getAccountInfoSync: () => ({ miniProgram: state }) };
  const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, api);
  assert.equal(page.data.testEntryAllowed, true);
  state.envVersion = 'release';
  page.data.identified = false;
  await page.checkProjectAccess();
  assert.equal(calls.filter(c => c.data && c.data.action).length, 0);
  page.data.identified = true;
  await page.checkWriteAccess();
  assert.equal(calls.filter(c => c.data && c.data.action).length, 0);
});

test('WXML gates all interactive test content behind testEntryAllowed', () => {
  assertAllHandlersGated(path.join(__dirname, '../miniprogram/pages/access/access.wxml'));
});

test('release entry hides all test actions while preserving reports and anti-replay marks', async () => {
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'release' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, api);
  Object.assign(page.data, {
    identified: true, isAdmin: true, transactionReady: true,
    projects: [{ id: 'p1', name: '保留项目', roleText: '负责人' }],
    selectedProject: { id: 'p1', name: '保留项目' },
    accessCheckReport: 'access-report', writeCheckReport: 'write-report',
    validMemberReport: 'valid-member-report', validBindingReport: 'valid-binding-report',
    validApprovalReport: 'valid-approval-report', concurrentApprovalReport: 'concurrent-report',
    primaryOwnerConcurrencyReport: 'primary-owner-report',
    testEntryAllowed: false
  });
  await page.checkProjectAccess();
  await page.checkWriteAccess();
  await page.checkValidMember();
  await page.checkValidBinding();
  await page.checkValidApproval();
  await page.checkConcurrentApproval();
  await page.checkPrimaryOwnerConcurrency();
  assert.equal(calls.length, 0);
  assert.equal(page.data.accessCheckReport, 'access-report');
  assert.equal(page.data.writeCheckReport, 'write-report');
  assert.equal(page.data.validMemberReport, 'valid-member-report');
  assert.equal(page.data.validBindingReport, 'valid-binding-report');
  assert.equal(page.data.validApprovalReport, 'valid-approval-report');
  assert.equal(page.data.concurrentApprovalReport, 'concurrent-report');
  assert.equal(page.data.primaryOwnerConcurrencyReport, 'primary-owner-report');
});

test('onShow refresh keeps state and reports when switching back to allowed', async () => {
  const state = { appId: 'wxfb4db1615ac15531', envVersion: 'develop' };
  const api = { getAccountInfoSync: () => ({ miniProgram: state }),
    getStorageSync: () => null, setStorageSync: () => {} };
  const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, api);
  Object.assign(page.data, {
    identified: true, isAdmin: false, transactionReady: true,
    accessCheckReport: 'access-report', writeCheckStarted: true,
    validMemberStarted: true, validBindingStarted: true,
    validApprovalStarted: true, concurrentApprovalStarted: true,
    primaryOwnerConcurrencyStarted: true
  });
  state.envVersion = 'release';
  page.onShow();
  assert.equal(page.data.testEntryAllowed, false);
  assert.equal(page.data.accessCheckReport, 'access-report');
  assert.equal(page.data.writeCheckStarted, true);
  assert.equal(page.data.validMemberStarted, true);
  assert.equal(page.data.primaryOwnerConcurrencyStarted, true);
  assert.equal(calls.length, 0);
  state.envVersion = 'develop';
  page.onShow();
  assert.equal(page.data.testEntryAllowed, true);
  assert.equal(page.data.accessCheckReport, 'access-report');
  assert.equal(page.data.writeCheckStarted, true);
  assert.equal(page.data.validMemberStarted, true);
  assert.equal(page.data.primaryOwnerConcurrencyStarted, true);
});

function primaryOwnerProofEnabled() {
  const { bindingDigest } = require('../miniprogram/utils/binding-digest');
  const { sha256Hex } = require('../miniprogram/utils/sha256-hex');
  const numberA = '1234567890';
  const numberB = '0987654321';
  const managerId = 'u_8256b2f0dbfdcdff95ccf9ea7beba2afda64193d';
  const ownerId = 'u_c32979f165284b3c34672abccf2e8dcb0e2d3aa4';
  const applicantA = 'u_a2acfbaea35f409671860b2c4b13d777a6989a74';
  const applicantB = 'u_15703f790f293a33c184af9eb0b8db9852f182f4';
  const projectId = 'p_owner_concurrency_page';
  const invitationA = 'i_owner_page_a';
  const invitationB = 'i_owner_page_b';
  function memberId(userId) { return 'm_' + sha256Hex(`${projectId}:${userId}`).slice(0, 40); }
  function labelFor(userId) { return `成员 ${userId.slice(-6)}`; }
  const memberA = memberId(applicantA);
  const memberB = memberId(applicantB);
  const ownerMemberId = memberId(ownerId);
  const managerMemberId = memberId(managerId);
  const base = {
    enabled: true, evidenceId: 'synthetic-page-poc', appId: 'wxfb4db1615ac15531',
    envId: 'cloud1-d8gcq5ag39d847723', projectId, projectName: 'test',
    projectScope: 'identity-test', projectVersion: 1, actorId: managerId,
    baselineAt: new Date(Date.now() - 5000).toISOString(),
    verifiedAt: new Date(Date.now() - 6000).toISOString(),
    checkBefore: new Date(Date.now() + 60000).toISOString(),
    primaryOwnerUserId: '',
    expectedMembers: [
      { userId: ownerId, memberId: ownerMemberId, roles: ['负责人'], trades: [] },
      { userId: managerId, memberId: managerMemberId, roles: ['管家'], trades: [] }
    ],
    candidates: [
      { label: '候选甲', invitationId: invitationA, applicantUserId: applicantA, expectedMemberId: memberA,
        role: '主业主', trades: [], status: 'requested', invitationVersion: 2,
        invitationExpiresAt: new Date(Date.now() + 120000).toISOString(), issuedByUserId: managerId,
        bindingProof: { evidenceId: 'b-page-a', userId: applicantA, digest: bindingDigest(numberA),
          verifiedAt: new Date(Date.now() - 7000).toISOString(),
          checkBefore: new Date(Date.now() + 60000).toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString() } },
      { label: '候选乙', invitationId: invitationB, applicantUserId: applicantB, expectedMemberId: memberB,
        role: '主业主', trades: [], status: 'requested', invitationVersion: 2,
        invitationExpiresAt: new Date(Date.now() + 120000).toISOString(), issuedByUserId: managerId,
        bindingProof: { evidenceId: 'b-page-b', userId: applicantB, digest: bindingDigest(numberB),
          verifiedAt: new Date(Date.now() - 8000).toISOString(),
          checkBefore: new Date(Date.now() + 60000).toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString() } }
    ]
  };
  return { proof: base, projectId, invitationA, invitationB, memberA, memberB, applicantA, applicantB, managerId, ownerId, numberA, numberB, labelFor };
}

function primaryOwnerPageAccess({ proof, memberA, applicantA, applicantB, labelFor }, afterWinner = true) {
  const ownerMemberId = 'm_' + require('../miniprogram/utils/sha256-hex').sha256Hex(`${proof.projectId}:${proof.expectedMembers[0].userId}`).slice(0, 40);
  const managerMemberId = 'm_' + require('../miniprogram/utils/sha256-hex').sha256Hex(`${proof.projectId}:${proof.expectedMembers[1].userId}`).slice(0, 40);
  return {
    project: { id: proof.projectId, name: 'test', scope: 'identity-test', status: 'active', roles: ['管家'] },
    members: [
      { id: ownerMemberId, userId: proof.expectedMembers[0].userId, label: labelFor(proof.expectedMembers[0].userId), roles: ['负责人'], trades: [], joinedAt: new Date(Date.now() - 10000).toISOString() },
      { id: managerMemberId, userId: proof.expectedMembers[1].userId, label: labelFor(proof.expectedMembers[1].userId), roles: ['管家'], trades: [], joinedAt: new Date(Date.now() - 10000).toISOString() },
      ...(afterWinner ? [{ id: memberA, userId: applicantA, label: labelFor(applicantA), roles: ['主业主'], trades: [], joinedAt: new Date(Date.now()).toISOString() }] : [])
    ]
  };
}

test('主业主并发唯一性卡片默认禁用，管家账号也不发送请求', async () => {
  const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, {
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: () => null, setStorageSync: () => {}
  });
  page.data.accountLabel = '本人账号 64193d';
  page.data.primaryOwnerConcurrencyNumberA = '1234567890';
  page.data.primaryOwnerConcurrencyNumberB = '0987654321';
  await page.checkPrimaryOwnerConcurrency();
  assert.equal(calls.length, 0);
  assert.ok(page.data.primaryOwnerConcurrencySummary);
});

test('主业主并发唯一性卡片启用后仅管家账号发送两次请求，清除编号并跨页面防重', async () => {
  const { proof, projectId, invitationA, invitationB, memberA, applicantA, applicantB, numberA, numberB, labelFor } = primaryOwnerProofEnabled();
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  let callIndex = 0;
  let listCalls = 0;
  const requestedAtA = new Date(Date.now() - 5000).toISOString();
  const requestedAtB = new Date(Date.now() - 4000).toISOString();
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: proof.actorId, isAdmin: false } };
    if (data.action === 'getMembers') {
      const access = primaryOwnerPageAccess({ proof, memberA, applicantA, applicantB, labelFor }, callIndex >= 2);
      return { result: { ok: true, ...access } };
    }
    if (data.action === 'listInvitations') {
      listCalls++;
      const list = [
        { id: invitationA, role: '主业主', trades: [], applicantLabel: labelFor(applicantA), requestedAt: requestedAtA },
        { id: invitationB, role: '主业主', trades: [], applicantLabel: labelFor(applicantB), requestedAt: requestedAtB }
      ];
      return { result: { ok: true, invitations: listCalls > 1 ? [list[1]] : list } };
    }
    callIndex++;
    if (callIndex === 1) return { result: { ok: true, invitationId: invitationA, status: 'approved' } };
    return { result: { ok: false, code: 'OWNER_EXISTS', message: '目标项目已存在主业主。' } };
  };
  const { page, calls } = pageWith(respond, api, undefined, undefined, undefined, proof);
  Object.assign(page.data, { accountLabel: '本人账号 64193d', primaryOwnerConcurrencyNumberA: numberA, primaryOwnerConcurrencyNumberB: numberB });
  const running = page.checkPrimaryOwnerConcurrency();
  await page.checkPrimaryOwnerConcurrency();
  await running;
  const report = JSON.parse(page.data.primaryOwnerConcurrencyReport);
  assert.equal(report.complete, true);
  assert.equal(report.after.winner.memberId, memberA);
  assert.equal(page.data.primaryOwnerConcurrencyNumberA, '');
  assert.equal(page.data.primaryOwnerConcurrencyNumberB, '');
  assert.equal(JSON.stringify(store).includes(numberA), false);
  assert.equal(JSON.stringify(store).includes(numberB), false);
  assert.equal(calls.filter(row => row.data.action === 'approveInvitation').length, 2);
  const fresh = pageWith(respond, api, undefined, undefined, undefined, proof);
  fresh.page.data.accountLabel = '本人账号 64193d';
  await fresh.page.checkPrimaryOwnerConcurrency();
  assert.equal(fresh.calls.length, 0);
});

test('主业主并发唯一性卡片启用后事后读取失败不标记完成', async () => {
  const { proof, invitationA, invitationB, memberA, applicantA, applicantB, numberA, numberB, labelFor } = primaryOwnerProofEnabled();
  const store = {};
  const api = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxfb4db1615ac15531', envVersion: 'develop' } }),
    getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = value; } };
  let callIndex = 0;
  const respond = async ({ data }) => {
    if (data.action === 'identify') return { result: { ok: true, userId: proof.actorId, isAdmin: false } };
    if (data.action === 'getMembers') return { result: { ok: true, ...primaryOwnerPageAccess({ proof, memberA, applicantA, applicantB, labelFor }, false) } };
    if (data.action === 'listInvitations') {
      if (callIndex >= 2) return { result: { ok: false, code: 'UNKNOWN_AFTER', message: 'after failed ' + numberA + numberB } };
      return { result: { ok: true, invitations: [
        { id: invitationA, role: '主业主', trades: [], applicantLabel: labelFor(applicantA), requestedAt: new Date(Date.now() - 5000).toISOString() },
        { id: invitationB, role: '主业主', trades: [], applicantLabel: labelFor(applicantB), requestedAt: new Date(Date.now() - 4000).toISOString() }
      ] } };
    }
    callIndex++;
    if (callIndex === 1) return { result: { ok: true, invitationId: invitationA, status: 'approved' } };
    return { result: { ok: false, code: 'OWNER_EXISTS', message: '目标项目已存在主业主。' } };
  };
  const { page, calls } = pageWith(respond, api, undefined, undefined, undefined, proof);
  Object.assign(page.data, { accountLabel: '本人账号 64193d', primaryOwnerConcurrencyNumberA: numberA, primaryOwnerConcurrencyNumberB: numberB });
  await page.checkPrimaryOwnerConcurrency();
  const report = JSON.parse(page.data.primaryOwnerConcurrencyReport);
  assert.equal(report.complete, false);
  assert.equal(report.stoppedReason, '事后只读观察失败，停止并等待管理端核对。');
  assert.ok(report.afterReadError);
  assert.equal(calls.filter(row => row.data.action === 'approveInvitation').length, 2);
  assert.equal(page.data.primaryOwnerConcurrencySummary, report.stoppedReason);
  assert.equal(JSON.stringify(store).includes(numberA), false);
  assert.equal(JSON.stringify(store).includes('UNKNOWN_AFTER'), false);
});

test('主业主并发唯一性卡片在正式版、错AppID、错身份、存储失败时不调用云端', async () => {
  const { proof, numberA, numberB } = primaryOwnerProofEnabled();
  for (const variant of ['release', 'appid', 'actor', 'storage']) {
    const { page, calls } = pageWith(async () => { throw new Error('must not call'); }, {
      getAccountInfoSync: () => ({ miniProgram: { appId: variant === 'appid' ? 'wrong' : 'wxfb4db1615ac15531',
        envVersion: variant === 'release' ? 'release' : 'trial' } }),
      getStorageSync: () => null,
      setStorageSync: () => { if (variant === 'storage') throw new Error('storage failure'); }
    }, undefined, undefined, undefined, proof);
    Object.assign(page.data, { accountLabel: variant === 'actor' ? 'other' : '本人账号 64193d',
      primaryOwnerConcurrencyNumberA: numberA, primaryOwnerConcurrencyNumberB: numberB });
    await page.checkPrimaryOwnerConcurrency();
    assert.equal(calls.filter(row => row.data && row.data.action === 'approveInvitation').length, 0);
    assert.equal(page.data.primaryOwnerConcurrencyNumberA, '');
    assert.equal(page.data.primaryOwnerConcurrencyNumberB, '');
  }
});

test('access.wxml 在项目列表、已选项目和指定管家区域显示完整项目ID', () => {
  const wxmlPath = path.join(__dirname, '../miniprogram/pages/access/access.wxml');
  const content = fs.readFileSync(wxmlPath, 'utf8');
  assert.ok(content.includes('{{item.id}}'), '项目列表按钮应显示完整 item.id');
  assert.ok(content.includes('{{selectedProject.id}}'), '已选项目卡片与指定管家区域应显示完整 selectedProject.id');
  assert.ok(content.includes('id-text'), '长编号应使用允许换行的 id-text 样式');
});
