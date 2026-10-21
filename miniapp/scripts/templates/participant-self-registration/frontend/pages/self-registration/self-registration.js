'use strict';
// 指定本人登记页：明确提示首次登记将新增本人测试账号与登记审计。
// - 加载/切前台零发送；本机版本/配置轮次/提交轮次/服务端返回轮次分栏显示。
// - 只有登记按钮；无取号/角色切换/建项目/重试控件；单击单发、在途锁、结算清口令。
// - 结果后停止（关闭交给执行会话），不承诺自动重试或全局一次性口令。

const registrationClient = require('../../utils/registration-check-client');
const cloudConfig = require('../../config/cloud');

Page({
  data: {
    registrationBuildId: '',
    configRegistrationRoundId: '',
    localRequestRound: '',
    serverRoundText: '未取得',
    passphrase: '',
    sending: false,
    result: null,
    stopHint: '',
    warningText: '本页为本人登记：点击登记将首次新增本人测试账号（schtest_v1_users）与一条登记审计（schtest_v1_audit_events）。此操作写入云端，请确认后再继续。'
  },
  onLoad() {
    this.setData({
      registrationBuildId: cloudConfig.registrationBuildId,
      configRegistrationRoundId: cloudConfig.registrationRoundId
    });
  },
  onShow() {
    // 加载/切前台零发送
  },
  onPassphraseInput(e) {
    this.setData({ passphrase: e && e.detail ? String(e.detail.value || '') : '' });
  },
  async onRegisterTap() {
    if (this.data.sending) return; // 在途锁：单击单发
    if (!this.data.passphrase) {
      this.setData({ stopHint: '请先输入本窗口的临时核验口令。' });
      return;
    }
    this.setData({ sending: true, stopHint: '', result: null });
    try {
      const request = { action: 'registerSelf', passphrase: this.data.passphrase };
      const envelope = await registrationClient.callSelfRegistration(request);
      const response = envelope.response;
      this.setData({
        localRequestRound: envelope.localRequestEvidence ? envelope.localRequestEvidence.requestRoundId : '',
        serverRoundText: response && typeof response.registrationRoundId === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(response.registrationRoundId)
          ? response.registrationRoundId : '未取得'
      });
      if (!response || typeof response !== 'object') {
        // C1：returned 不保证有效服务端结果——按失败/未知处理
        this.setData({
          stopHint: '本次登记未完成（结果未知）。请停止并联系负责人，不要重复点击；系统不会自动重试。',
          result: null
        });
        return;
      }
      this.setData({ result: response });
      this.setData({
        stopHint: response.outcome === 'CREATED_AND_VERIFIED'
          ? '登记完成：本人测试账号与登记审计已新增并回读通过。'
          : response.outcome === 'ALREADY_ACTIVE'
            ? '本人账号已有效存在，本次零新增。'
            : response.outcome === 'OUTCOME_UNKNOWN'
              ? '提交状态未知：请停止并联系负责人，先关闭再另行只读核对；不要重复点击。'
              : '登记未通过，未写入：' + (response.message || '请停止并联系负责人。')
      });
    } catch (_) {
      // 前置拒绝/传输失败：本机事实已在客户端侧记录；页面按失败/未知处理
      this.setData({
        stopHint: '本次登记未完成（结果未知）。请停止并联系负责人，不要重复点击；系统不会自动重试。',
        result: null,
        localRequestRound: this.data.localRequestRound || ''
      });
    } finally {
      this.setData({ passphrase: '', sending: false }); // 结算清口令
    }
  }
});
