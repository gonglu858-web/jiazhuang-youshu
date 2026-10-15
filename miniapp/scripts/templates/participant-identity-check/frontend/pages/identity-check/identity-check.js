// 两位参与者「本人身份只读核验包」页面逻辑（本地模板，未部署）。
//
// 任务：docs/WorkBuddy任务-两位参与者本人身份只读核验包-20261015.md §5
//
// 行为约束（逐条对应验收要点 5）：
// - onLoad / onShow **不自动调用**核验函数；只有点击按钮才发一次请求。
// - 点击后立刻上锁（inFlight），请求返回前重复点击不产生第二次请求。
// - 失败**不自动重试**：只展示净化结果与人工停止提示，由本人决定是否再点。
// - 口令只存在于本页内存 data，不写 storage、不打日志；调用结束（含失败）
//   立即清空输入与内存副本。
// - 页面不含角色切换、登记、取号、重试、清缓存或项目操作按钮。

const { callIdentityCheck } = require('../../utils/identity-check-client');

Page({
  data: {
    passphrase: '',
    sending: false,
    result: null,
    stopHint: '',
    // 仅用于展示核验轮次/时间；不含任何口令内容
    lastCheckedAt: ''
  },

  onLoad() {
    // 明确空实现：加载不发送请求。
  },

  onShow() {
    // 明确空实现：切前台不发送请求，不重发失败请求。
  },

  onUnload() {
    // 离开页面清除内存中的口令副本。
    this.setData({ passphrase: '' });
  },

  onPassphraseInput(e) {
    this.setData({ passphrase: e.detail.value });
  },

  async onCheckTap() {
    // 已锁在途请求：重复点击不产生第二次调用。
    if (this.data.sending) return;
    if (!this.data.passphrase) {
      this.setData({ stopHint: '请先输入本窗口的临时核验口令。' });
      return;
    }

    this.setData({ sending: true, stopHint: '', result: null });

    const request = { action: 'inspectSelf', passphrase: this.data.passphrase };
    let response = null;
    let failed = false;
    try {
      response = await callIdentityCheck(request);
    } catch (error) {
      // 网络/运行时异常：不自动重试，只显示净化后的失败提示。
      failed = true;
    } finally {
      // 调用结束立即清除口令输入与内存副本。
      this.setData({ passphrase: '', sending: false });
      request.passphrase = '';
    }

    if (failed || !response) {
      this.setData({
        result: null,
        stopHint: '本次核验未完成（结果未知）。请停止并联系负责人，不要重复点击；系统不会自动重试。'
      });
      return;
    }

    const hint = response.ok
      ? (response.registrationState === 'ACTIVE'
        ? '核验完成：请把本页结果截图交给负责人核对（截图不含口令）。'
        : '核验完成但状态需人工处理：请把本页结果交给负责人，不要自行登记或重试。')
      : '本次核验未确认身份或状态：已停止，请把本页结果交给负责人核对。';

    this.setData({
      result: {
        identityConfirmed: response.identityConfirmed,
        registrationState: response.registrationState,
        recordMatched: response.recordMatched,
        readAttempted: response.readAttempted,
        userIdTail: response.userIdTail,
        checkRoundId: response.checkRoundId,
        serverTime: response.serverTimeIso || '',
        code: response.code || ''
      },
      lastCheckedAt: response.serverTimeIso || '',
      stopHint: hint
    });
  }
});