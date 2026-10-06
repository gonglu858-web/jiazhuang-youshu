const { envId } = require('../../config/cloud');
const { createProbe, TARGET_ENV, COLLECTION, BUSINESS_COLLECTIONS } = require('../../utils/permission-probe');
const { checkEnvGate } = require('../../utils/env-gate');

Page({
  data: {
    envId: TARGET_ENV, collection: COLLECTION, busy: false,
    readAttempted: false, writeAttempted: false, readDenied: false,
    readMessage: '尚未检测', writeMessage: '先完成读取检测',
    summary: '空测试集合已由用户核验；本页保留原检测，并准备逐个验证六个业务集合。',
    businessAttempted: false, businessSummary: '六个业务集合尚待逐个设置权限后检测。', details: '',
    testEntryAllowed: false, testEntryMessage: ''
  },
  onLoad() {
    this.probe = createProbe(wx, envId); this.results = [];
    const gate = checkEnvGate(envId, wx);
    this.setData({ testEntryAllowed: gate.allowed, testEntryMessage: gate.reason });
  },
  onShow() {
    this.refreshEnvGate();
  },
  refreshEnvGate() {
    const gate = checkEnvGate(envId, wx);
    this.setData({ testEntryAllowed: gate.allowed, testEntryMessage: gate.reason });
    return gate;
  },
  ensureGate() {
    const gate = this.refreshEnvGate();
    if (!gate.allowed) {
      this.setData({ summary: gate.reason });
      return false;
    }
    return true;
  },
  record(result, collection = COLLECTION) {
    this.results.push({ collection, ...result });
    this.setData({ details: JSON.stringify({ env: TARGET_ENV, results: this.results }, null, 2) });
  },
  async checkRead() {
    if (this.data.busy || this.data.readAttempted) return;
    if (!this.ensureGate()) { this.setData({ readAttempted: true, readMessage: this.data.testEntryMessage }); return; }
    this.setData({ busy: true, readAttempted: true, readMessage: '正在检测…' });
    try {
      const result = await this.probe.read();
      this.record(result);
      const denied = result.status === 'denied';
      this.setData({ readDenied: denied,
        readMessage: denied ? '读取被权限拒绝，符合预期' : '未通过：' + result.message,
        writeMessage: denied ? '可以进行写入检测' : '已停止，不尝试写入',
        summary: denied ? '读取检测通过，请继续第二步。' : '结果不符合预期或尚不明确，请将结果交给开发协作者。'
      });
    } finally { this.setData({ busy: false }); }
  },
  async checkWrite() {
    if (this.data.busy || !this.data.readDenied || this.data.writeAttempted) return;
    if (!this.ensureGate()) { this.setData({ writeAttempted: true, writeMessage: this.data.testEntryMessage }); return; }
    this.setData({ busy: true, writeAttempted: true, writeMessage: '正在检测…' });
    try {
      const result = await this.probe.write();
      this.record(result);
      const denied = result.status === 'denied';
      this.setData({
        writeMessage: denied ? '新增记录被权限拒绝，符合预期' : '未通过：' + result.message,
        summary: denied ? '当前账号读取与新增记录均被拒绝。尚未测试修改、删除及其他账号。' : '停止后续实施。请保留结果，不重复写入，也不要自行删除可能产生的测试标记。'
      });
    } finally { this.setData({ busy: false }); }
  },
  async checkBusinessCollections() {
    if (this.data.busy || this.data.businessAttempted) return;
    if (!this.ensureGate()) { this.setData({ businessAttempted: true, businessSummary: this.data.testEntryMessage }); return; }
    this.setData({ busy: true, businessAttempted: true, businessSummary: '正在逐个检测，请勿退出…' });
    try {
      for (const name of BUSINESS_COLLECTIONS) {
        const probe = createProbe(wx, envId, 15000, name);
        const read = await probe.read();
        this.record(read, name);
        if (read.status !== 'denied') {
          this.setData({ businessSummary: `${name} 读取未明确被拒绝，已停止；不要写入业务数据。` });
          return;
        }
        const write = await probe.write();
        this.record(write, name);
        if (write.status !== 'denied') {
          this.setData({ businessSummary: `${name} 新增未明确被拒绝，已停止；保留标记编号，不要重试或写入业务数据。` });
          return;
        }
      }
      this.setData({ businessSummary: '六个业务集合对当前账号的读取与新增均被拒绝；修改、删除及其他账号仍待核验。' });
    } finally { this.setData({ busy: false }); }
  },
  copyResult() { if (this.data.details) wx.setClipboardData({ data: this.data.details }); }
});
