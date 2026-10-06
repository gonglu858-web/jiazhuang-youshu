const { envId } = require('../../config/cloud');
const { runWriteProbe, runValidMemberProbe, createValidBindingProbe } = require('../../utils/member-write-probe');
const { createValidApprovalProbe } = require('../../utils/valid-approval-probe');
const { createConcurrentApprovalProbe } = require('../../utils/concurrent-approval-probe');
const { createPrimaryOwnerConcurrencyProbe } = require('../../utils/primary-owner-concurrency-probe');
const { checkEnvGate } = require('../../utils/env-gate');
const bindingProof = require('../../config/valid-binding-proof');
const approvalProof = require('../../config/valid-approval-proof');
const concurrentApprovalProof = require('../../config/valid-concurrent-approval-proof');
const primaryOwnerConcurrencyProof = require('../../config/valid-primary-owner-concurrency-proof');
const validBindingProbe = createValidBindingProbe(bindingProof);
const validApprovalProbe = createValidApprovalProbe(approvalProof);
const concurrentApprovalProbe = createConcurrentApprovalProbe(concurrentApprovalProof);
const primaryOwnerConcurrencyProbe = createPrimaryOwnerConcurrencyProbe(primaryOwnerConcurrencyProof);

const ROLE_OPTIONS = ['师傅', '主业主', '设计师', '家庭成员'];
const TRADE_OPTIONS = ['拆改', '泥瓦', '水电', '防水', '木工', '油漆', '美缝', '安装', '保洁'];
// 第一单元已存在的两个虚构项目；仅用于真机只读权限核验。
const ACCESS_CHECK_PROJECTS = [
  { id: 'p_38507fc9b43c4e23a7fbd996415637bb', label: '原师傅测试项目' },
  { id: 'p_a328c08992f7414c812047935bc3c31e', label: '另一隔离测试项目' }
];

Page({
  data: {
    busy: false, error: '', message: '', identified: false, isAdmin: false,
    transactionReady: false,
    accountLabel: '', bindingNumber: '', bindingExpiresAt: '',
    projects: [], selectedProject: null, members: [], invitations: [], isManager: false,
    projectName: '虚构测试 · 装修项目', managerNumber: '', applicantNumber: '', invitationCode: '',
    issuedCode: '', roleOptions: ROLE_OPTIONS, roleIndex: 0, tradeOptions: TRADE_OPTIONS,
    tradeIndex: 0, accessChecks: [], accessCheckReport: '',
    writeChecks: [], writeCheckReport: '', writeCheckStarted: false, writeCheckSummary: '',
    validMemberStarted: false, validMemberReport: '', validMemberSummary: '',
    validBindingNumber: '', validBindingStarted: false, validBindingReport: '', validBindingSummary: '',
    validApprovalNumber: '', validApprovalStarted: false, validApprovalReport: '',
    validApprovalSummary: '', approvalWindowOpen: Date.now() < Date.parse(approvalProof.checkBefore),
    concurrentApprovalNumber: '', concurrentApprovalStarted: false, concurrentApprovalReport: '',
    concurrentApprovalSummary: '', concurrentApprovalWindowOpen: false,
    primaryOwnerConcurrencyNumberA: '', primaryOwnerConcurrencyNumberB: '',
    primaryOwnerConcurrencyStarted: false, primaryOwnerConcurrencyReport: '',
    primaryOwnerConcurrencySummary: '', primaryOwnerConcurrencyWindowOpen: false,
    testEntryAllowed: false, testEntryMessage: ''
  },
  onShow() {
    const gate = checkEnvGate(envId, wx);
    this.setData({
      testEntryAllowed: gate.allowed,
      testEntryMessage: gate.reason,
      approvalWindowOpen: Date.now() < Date.parse(approvalProof.checkBefore),
      concurrentApprovalWindowOpen: concurrentApprovalProof.enabled === true &&
        Date.now() < Date.parse(concurrentApprovalProof.checkBefore || ''),
      primaryOwnerConcurrencyWindowOpen: primaryOwnerConcurrencyProof.enabled === true &&
        Date.now() < Date.parse(primaryOwnerConcurrencyProof.checkBefore || '')
    });
    if (gate.allowed && this.data.identified) this.loadProjects();
  },
  refreshEnvGate() {
    const gate = checkEnvGate(envId, wx);
    this.setData({ testEntryAllowed: gate.allowed, testEntryMessage: gate.reason });
    return gate;
  },
  input(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  changeRole(event) { this.setData({ roleIndex: Number(event.detail.value) }); },
  changeTrade(event) { this.setData({ tradeIndex: Number(event.detail.value) }); },
  async call(action, input = {}) {
    const gate = checkEnvGate(envId, wx);
    if (!gate.allowed) throw new Error(gate.reason);
    if (!getApp().globalData.cloudReady) throw new Error('云开发尚未初始化，请重新进入小程序。');
    const response = await wx.cloud.callFunction({ name: 'memberAccess', config: { env: envId },
      data: { action, ...input } });
    const result = response && response.result;
    if (!result || result.ok !== true) {
      const error = new Error((result && result.message) || '云端身份功能尚未准备好，请稍后重试。');
      // 只有函数明确返回的业务错误用于权限判定；网络异常不算拒绝成功。
      error.businessCode = result && result.ok === false ? result.code : undefined;
      throw error;
    }
    return result;
  },
  async checkProjectAccess() {
    if (this.data.busy || !this.data.identified || !this.data.transactionReady) return;
    const gate = this.refreshEnvGate();
    if (!gate.allowed) { this.setData({ error: gate.reason }); return; }
    const account = this.data.accountLabel;
    const rows = [];
    this.setData({ busy: true, error: '', message: '', accessChecks: [], accessCheckReport: '' });
    try {
      for (const project of ACCESS_CHECK_PROJECTS) {
        for (const action of ['getMembers', 'listInvitations']) {
          const row = { key: `${project.id}:${action}`, projectId: project.id,
            label: `${project.label} · ${action === 'getMembers' ? '读取成员' : '读取待核对申请'}`,
            action, checkedAt: new Date().toISOString() };
          try {
            await this.call(action, { projectId: project.id });
            Object.assign(row, { status: 'allowed', text: '允许访问', code: '' });
          } catch (error) {
            const denied = error.businessCode === 'NO_ACCESS';
            Object.assign(row, { status: denied ? 'denied' : 'inconclusive',
              text: denied ? '权限拒绝' : '检查未完成', code: error.businessCode || '',
              message: error.message || '请求失败' });
          }
          rows.push(row);
          this.setData({ accessChecks: rows.slice() });
          // 遇到网络、身份、服务端或响应格式错误就停下，保留已完成结果。
          if (row.status === 'inconclusive') return;
        }
      }
    } finally {
      this.setData({ busy: false, accessCheckReport: JSON.stringify({ env: envId, account,
        complete: rows.length === 4 && rows.every(row => row.status !== 'inconclusive'), results: rows }, null, 2) });
    }
  },
  copyAccessChecks() {
    if (this.data.accessCheckReport) wx.setClipboardData({ data: this.data.accessCheckReport });
  },
  async checkWriteAccess() {
    return this.runWriteAccessMode('outsider');
  },
  async checkWorkerRole() {
    return this.runWriteAccessMode('active-worker');
  },
  async checkPrimaryOwnerRole() {
    return this.runWriteAccessMode('active-primary-owner');
  },
  async checkWorkerDesignerRole() {
    return this.runWriteAccessMode('active-worker-designer');
  },
  async runWriteAccessMode(mode) {
    if (this.data.busy || this.data.writeCheckStarted || !this.data.identified ||
        !this.data.transactionReady || this.data.isAdmin) return;
    const gate = this.refreshEnvGate();
    if (!gate.allowed) { this.setData({ error: gate.reason }); return; }
    if (envId !== 'cloud1-d8gcq5ag39d847723') {
      this.setData({ error: '此检查只适用于已批准的 cloud1 测试环境。' });
      return;
    }
    this.setData({ busy: true, writeCheckStarted: true, error: '', message: '',
      writeChecks: [], writeCheckReport: '', writeCheckSummary: '检查中，请勿切换账号或操作成员。' });
    try {
      const report = await runWriteProbe(this.call.bind(this), ACCESS_CHECK_PROJECTS,
        rows => this.setData({ writeChecks: rows }), mode);
      this.setData({ writeCheckReport: JSON.stringify({ env: envId, ...report }, null, 2),
        writeCheckSummary: report.complete ?
          `${report.results.length} 项均被权限拒绝，请复制结果供核对云端记录。` : report.stoppedReason });
    } catch (error) {
      this.setData({ writeCheckSummary: '检查发生异常，请停止并联系开发协作者，不要再次执行。',
        writeCheckReport: JSON.stringify({ env: envId, complete: false,
          error: error.message || '检查异常，需核对云端记录。' }, null, 2) });
    } finally { this.setData({ busy: false }); }
  },
  copyWriteChecks() {
    if (this.data.writeCheckReport) wx.setClipboardData({ data: this.data.writeCheckReport });
  },
  async checkValidMember() {
    if (this.data.busy || this.data.validMemberStarted || !this.data.identified ||
        !this.data.transactionReady || this.data.isAdmin) return;
    const key = 'yf-valid-member-removal-20260929-v1';
    try {
      const config = wx.getAccountInfoSync().miniProgram;
      if (envId !== 'cloud1-d8gcq5ag39d847723' || config.appId !== 'wxfb4db1615ac15531' ||
          !['develop', 'trial'].includes(config.envVersion)) throw new Error('仅允许目标小程序的开发／体验版本检查。');
      const saved = wx.getStorageSync(key);
      if (saved) {
        this.setData({ validMemberStarted: true, validMemberReport: saved.report || '',
          validMemberSummary: '本机已开始过此轮检查，不自动重试；请复制已有报告或联系开发协作者。' });
        return;
      }
      if (this.data.accountLabel !== '本人账号 f182f4') throw new Error('请使用主业主账号 f182f4。');
      wx.setStorageSync(key, { started: true });
      this.setData({ busy: true, validMemberStarted: true, error: '',
        validMemberSummary: '检查中，请勿操作成员。' });
      const report = await runValidMemberProbe(this.call.bind(this));
      const serialized = JSON.stringify({ env: envId, ...report }, null, 2);
      this.setData({ validMemberReport: serialized, validMemberSummary: report.complete ?
        '移出请求被拒绝，原成员仍可见。请复制报告核对云端。' : report.stoppedReason });
      wx.setStorageSync(key, { started: true, report: serialized });
    } catch (error) {
      this.setData({ validMemberSummary: error.message || '检查未完成，请勿重试。' });
    } finally { this.setData({ busy: false }); }
  },
  copyValidMember() {
    if (this.data.validMemberReport) wx.setClipboardData({ data: this.data.validMemberReport });
  },
  async checkValidBinding() {
    if (this.data.busy || this.data.validBindingStarted || !this.data.identified ||
        !this.data.transactionReady || this.data.isAdmin) return;
    const number = this.data.validBindingNumber.trim();
    const key = 'yf-valid-binding-' + bindingProof.evidenceId;
    try {
      const config = wx.getAccountInfoSync().miniProgram;
      if (envId !== 'cloud1-d8gcq5ag39d847723' || config.appId !== 'wxfb4db1615ac15531' ||
          !['develop', 'trial'].includes(config.envVersion)) throw new Error('仅允许目标小程序的开发／体验版本检查。');
      if (this.data.accountLabel !== '本人账号 f182f4') throw new Error('请使用主业主账号 f182f4。');
      const saved = wx.getStorageSync(key);
      if (saved) {
        this.setData({ validBindingStarted: true, validBindingReport: saved.report || '',
          validBindingSummary: '本机已开始过本轮检查，不自动重试；请复制报告或联系开发协作者。' });
        return;
      }
      validBindingProbe.validate(number);
      wx.setStorageSync(key, { started: true });
      this.setData({ busy: true, validBindingStarted: true, validBindingSummary: '检查中，请勿操作成员。' });
      const report = await validBindingProbe.run(this.call.bind(this), number);
      const serialized = JSON.stringify({ env: envId, ...report }, null, 2);
      this.setData({ validBindingReport: serialized, validBindingSummary: report.complete ?
        '指定管家请求被拒绝，师傅原角色仍保留。请复制报告核对编号及云端记录。' : report.stoppedReason });
      wx.setStorageSync(key, { started: true, report: serialized });
    } catch (error) {
      const message = error.message || '检查未完成，请勿重试。';
      this.setData({ validBindingSummary: number ? message.split(number).join('[编号已隐藏]') : message });
    } finally { this.setData({ busy: false, validBindingNumber: '' }); }
  },
  copyValidBinding() {
    if (this.data.validBindingReport) wx.setClipboardData({ data: this.data.validBindingReport });
  },
  async checkValidApproval() {
    if (this.data.busy || this.data.validApprovalStarted || !this.data.identified ||
        !this.data.transactionReady || this.data.isAdmin) return;
    const number = typeof this.data.validApprovalNumber === 'string' ?
      this.data.validApprovalNumber.trim() : '';
    const key = 'yf-valid-approval-' + approvalProof.evidenceId;
    try {
      const config = wx.getAccountInfoSync().miniProgram;
      if (envId !== 'cloud1-d8gcq5ag39d847723' || config.appId !== 'wxfb4db1615ac15531' ||
          !['develop', 'trial'].includes(config.envVersion)) {
        throw new Error('仅允许目标小程序的开发／体验版本检查。');
      }
      if (this.data.accountLabel !== '本人账号 f182f4') throw new Error('请使用主业主账号 f182f4。');
      const saved = wx.getStorageSync(key);
      if (saved) {
        this.setData({ validApprovalStarted: true, validApprovalReport: saved.report || '',
          validApprovalSummary: '本机已开始过本轮检查，不自动重试；请复制报告或联系开发协作者。' });
        return;
      }
      validApprovalProbe.validate(number);
      // 在任何网络请求前持久化标记；结果不确定时也禁止本机再发送一次。
      wx.setStorageSync(key, { started: true });
      this.setData({ busy: true, validApprovalStarted: true, error: '',
        validApprovalSummary: '检查中，请勿批准申请或切换账号。' });
      const report = await validApprovalProbe.run(this.call.bind(this), number);
      const serialized = JSON.stringify({ env: envId, ...report }, null, 2);
      this.setData({ validApprovalReport: serialized, validApprovalSummary: report.complete ?
        '批准请求被明确拒绝；请复制报告，仍须管理端核对申请和编号未消费。' : report.stoppedReason });
      wx.setStorageSync(key, { started: true, report: serialized });
    } catch (_) {
      this.setData({ validApprovalSummary: '本轮编号、环境或窗口未通过检查，或检查未完成；未自动重试。' });
    } finally {
      this.setData({ busy: false, validApprovalNumber: '',
        approvalWindowOpen: Date.now() < Date.parse(approvalProof.checkBefore) });
    }
  },
  copyValidApproval() {
    if (this.data.validApprovalReport) wx.setClipboardData({ data: this.data.validApprovalReport });
  },
  async checkConcurrentApproval() {
    if (this.data.busy || this.data.concurrentApprovalStarted || !this.data.identified ||
        !this.data.transactionReady || this.data.isAdmin) return;
    const number = typeof this.data.concurrentApprovalNumber === 'string' ?
      this.data.concurrentApprovalNumber.trim() : '';
    const key = 'yf-concurrent-approval-' + concurrentApprovalProof.evidenceId;
    try {
      const config = wx.getAccountInfoSync().miniProgram;
      if (envId !== 'cloud1-d8gcq5ag39d847723' || config.appId !== 'wxfb4db1615ac15531' ||
          !['develop', 'trial'].includes(config.envVersion)) throw new Error('仅允许目标小程序的开发／体验版本检查。');
      if (this.data.accountLabel !== '本人账号 64193d') throw new Error('请使用管家账号 64193d。');
      const saved = wx.getStorageSync(key);
      if (saved) {
        this.setData({ concurrentApprovalStarted: true, concurrentApprovalReport: saved.report || '',
          concurrentApprovalSummary: '本机已开始过本轮检查，不自动重试；请复制已有报告或联系开发协作者。' });
        return;
      }
      concurrentApprovalProbe.validate(number);
      this.setData({ busy: true, concurrentApprovalStarted: true, error: '',
        concurrentApprovalSummary: '并发检查中，请勿切换账号或操作成员。' });
      const storage = { get: (k) => wx.getStorageSync(k), set: (k, v) => wx.setStorageSync(k, v) };
      const report = await concurrentApprovalProbe.run(this.call.bind(this), number, storage);
      const serialized = JSON.stringify({ env: envId, ...report }, null, 2);
      this.setData({ concurrentApprovalReport: serialized,
        concurrentApprovalSummary: report.complete ?
          '并发检查完成；请复制报告，最终须由管理端基线比对确认。' : report.stoppedReason });
      wx.setStorageSync(key, { started: true, report: serialized });
    } catch (_) {
      this.setData({ concurrentApprovalSummary: '本轮编号、环境或窗口未通过检查，或检查未完成；未自动重试。' });
    } finally {
      this.setData({ busy: false, concurrentApprovalNumber: '',
        concurrentApprovalWindowOpen: concurrentApprovalProof.enabled === true &&
          Date.now() < Date.parse(concurrentApprovalProof.checkBefore || '') });
    }
  },
  copyConcurrentApproval() {
    if (this.data.concurrentApprovalReport) wx.setClipboardData({ data: this.data.concurrentApprovalReport });
  },
  async checkPrimaryOwnerConcurrency() {
    if (this.data.busy || this.data.primaryOwnerConcurrencyStarted || !this.data.identified ||
        !this.data.transactionReady || this.data.isAdmin) return;
    const numberA = typeof this.data.primaryOwnerConcurrencyNumberA === 'string' ?
      this.data.primaryOwnerConcurrencyNumberA.trim() : '';
    const numberB = typeof this.data.primaryOwnerConcurrencyNumberB === 'string' ?
      this.data.primaryOwnerConcurrencyNumberB.trim() : '';
    const key = 'yf-primary-owner-concurrency-' + primaryOwnerConcurrencyProof.evidenceId;
    try {
      const gate = this.refreshEnvGate();
      if (!gate.allowed) throw new Error(gate.reason);
      if (this.data.accountLabel !== '本人账号 64193d') throw new Error('请使用管家账号 64193d。');
      const saved = wx.getStorageSync(key);
      if (saved) {
        this.setData({ primaryOwnerConcurrencyStarted: true, primaryOwnerConcurrencyReport: saved.report || '',
          primaryOwnerConcurrencySummary: '本机已开始过本轮检查，不自动重试；请复制已有报告或联系开发协作者。' });
        return;
      }
      primaryOwnerConcurrencyProbe.validate(numberA, numberB);
      this.setData({ busy: true, primaryOwnerConcurrencyStarted: true, error: '',
        primaryOwnerConcurrencySummary: '并发唯一性检查中，请勿切换账号或操作成员。' });
      const storage = { get: (k) => wx.getStorageSync(k), set: (k, v) => wx.setStorageSync(k, v) };
      const report = await primaryOwnerConcurrencyProbe.run(this.call.bind(this), numberA, numberB, storage);
      const serialized = JSON.stringify({ env: envId, ...report }, null, 2);
      this.setData({ primaryOwnerConcurrencyReport: serialized,
        primaryOwnerConcurrencySummary: report.complete ?
          '并发唯一性检查完成；请复制报告，最终须由管理端基线比对确认。' : report.stoppedReason });
      wx.setStorageSync(key, { started: true, report: serialized });
    } catch (_) {
      this.setData({ primaryOwnerConcurrencySummary: '本轮编号、环境或窗口未通过检查，或检查未完成；未自动重试。' });
    } finally {
      this.setData({ busy: false, primaryOwnerConcurrencyNumberA: '', primaryOwnerConcurrencyNumberB: '',
        primaryOwnerConcurrencyWindowOpen: primaryOwnerConcurrencyProof.enabled === true &&
          Date.now() < Date.parse(primaryOwnerConcurrencyProof.checkBefore || '') });
    }
  },
  copyPrimaryOwnerConcurrency() {
    if (this.data.primaryOwnerConcurrencyReport) wx.setClipboardData({ data: this.data.primaryOwnerConcurrencyReport });
  },
  async run(action, input, done) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '', message: '' });
    try { const result = await this.call(action, input); await done.call(this, result); }
    catch (error) { this.setData({ error: error.message || '云端请求失败，请稍后重试。' }); }
    finally { this.setData({ busy: false }); }
  },
  identify() {
    return this.run('identify', {}, async function (result) {
      this.setData({ identified: true, isAdmin: result.isAdmin,
        bindingNumber: '', bindingExpiresAt: '',
        accountLabel: `本人账号 ${result.userId.slice(-6)}`, message: '已由云端识别当前微信账号。' });
      await this.loadProjects();
    });
  },
  checkTransaction() {
    return this.run('checkTransaction', {}, function (result) {
      this.setData({ transactionReady: result.transactionReady === true,
        message: result.transactionReady === true ?
          '目标云端只读事务检查通过；尚未写入账号或项目记录。' : '事务检查未通过。' });
    });
  },
  requestNumber() {
    return this.run('requestBindingNumber', {}, function (result) {
      this.setData({ bindingNumber: result.bindingNumber, bindingExpiresAt: result.expiresAt,
        message: '请由本人核对并确认此编号。编号本身不能授予负责人权限。' });
    });
  },
  async loadProjects() {
    try {
      const result = await this.call('listMyProjects');
      this.setData({ projects: result.projects.map(item => ({ ...item, roleText: item.roles.join('、') })) });
      if (this.data.selectedProject) {
        const selected = result.projects.find(item => item.id === this.data.selectedProject.id);
        if (selected) await this.loadProject(selected);
        else this.setData({ selectedProject: null, members: [], invitations: [], isManager: false });
      }
    } catch (error) { this.setData({ error: error.message || '项目列表读取失败。' }); }
  },
  selectProject(event) {
    const project = this.data.projects.find(item => item.id === event.currentTarget.dataset.id);
    if (project) return this.loadProject(project);
  },
  async loadProject(project) {
    try {
      const result = await this.call('getMembers', { projectId: project.id });
      const isManager = project.roles.includes('管家');
      const changed = !this.data.selectedProject || this.data.selectedProject.id !== project.id;
      this.setData({ selectedProject: project,
        ...(changed ? { issuedCode: '', applicantNumber: '' } : {}),
        members: result.members.map(item => ({ ...item, roleText: item.roles.join('、'),
          tradeText: item.trades.join('、'), removable: isManager &&
          !item.roles.some(role => ['负责人', '管家', '主业主'].includes(role)) })),
        isManager, invitations: [] });
      if (isManager) {
        const pending = await this.call('listInvitations', { projectId: project.id });
        this.setData({ invitations: pending.invitations });
      }
    } catch (error) { this.setData({ error: error.message || '项目成员读取失败。' }); }
  },
  createProject() {
    const name = this.data.projectName.trim();
    if (!name || this.data.busy) return;
    return this.run('createProject', { name }, async function () {
      this.setData({ projectName: '', message: '虚构测试项目已创建，请从上方列表进入。' });
      await this.loadProjects();
    });
  },
  assignManager() {
    const project = this.data.selectedProject;
    if (!project) return;
    return this.run('assignManager', { projectId: project.id, bindingNumber: this.data.managerNumber.trim() },
      async function () {
        this.setData({ managerNumber: '', message: '管家已加入此虚构项目。' });
        await this.loadProject(project);
      });
  },
  createInvitation() {
    const project = this.data.selectedProject;
    if (!project) return;
    const role = ROLE_OPTIONS[this.data.roleIndex];
    const trades = role === '师傅' ? [TRADE_OPTIONS[this.data.tradeIndex]] : [];
    return this.run('createInvitation', { projectId: project.id, role, trades }, function (result) {
      this.setData({ issuedCode: result.invitationCode,
        message: '邀请码只显示这一次。请管家核对对方微信身份后再批准加入。' });
    });
  },
  applyInvitation() {
    return this.run('applyInvitation', { invitationCode: this.data.invitationCode.trim() }, function () {
      this.setData({ invitationCode: '', message: '申请已提交，等待管家核对身份。此时尚无项目访问权。' });
    });
  },
  approveInvitation(event) {
    const project = this.data.selectedProject;
    if (!project) return;
    return this.run('approveInvitation', { projectId: project.id,
      invitationId: event.currentTarget.dataset.id,
      applicantNumber: this.data.applicantNumber.trim() }, async function () {
      this.setData({ applicantNumber: '', message: '身份编号核对通过，已批准加入。' });
      await this.loadProject(project);
    });
  },
  removeMember(event) {
    const project = this.data.selectedProject;
    if (!project) return;
    wx.showModal({ title: '确认移出测试成员？', content: '移出后对方立即失去此虚构项目访问权，历史授权记录保留。',
      success: result => {
        if (!result.confirm) return;
        this.run('removeMember', { projectId: project.id, userId: event.currentTarget.dataset.id },
          async function () { this.setData({ message: '成员已移出。' }); await this.loadProject(project); });
      } });
  }
});
