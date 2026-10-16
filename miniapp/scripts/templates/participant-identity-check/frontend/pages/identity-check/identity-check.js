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
// - 受控键诊断（C3）：仅展示客户端按固定 schema 净化后的固定标签/计数/长度分桶；
//   不含原键名或值；无自动请求、无重试、无新增操作按钮；口令照常只在本页内存。

const { callIdentityCheck } = require('../../utils/identity-check-client');

/** 把净化诊断渲染为固定格式的展示文本；只含数字、固定标签与固定分桶名。 */
function describeKeyDiagnostic(d) {
  if (!d || typeof d !== 'object') return '';
  const bucketKeys = ['len<=4', 'len5-8', 'len9-16', 'len17-32', 'lenOver32'];
  const parts = ['其它键 ' + d.otherKeyCount + ' 个'];
  const bucketText = [];
  for (const k of bucketKeys) {
    const v = d.otherKeyNameLengthBuckets ? d.otherKeyNameLengthBuckets[k] : undefined;
    if (typeof v === 'number') bucketText.push(k + '=' + v);
  }
  parts.push('键名长度 ' + bucketText.join('，'));
  if (Array.isArray(d.candidateLabels) && d.candidateLabels.length) {
    parts.push('候选标签 ' + d.candidateLabels.join('，'));
  }
  if (d.truncated === true) parts.push('已截断');
  return parts.join('；');
}

Page({
  data: {
    passphrase: '',
    sending: false,
    result: null,
    stopHint: '',
    // R2：默认只展示尾号；勾选后才向服务端请求完整内部 userId（供负责人核对）
    wantFullUserId: false,
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

  onWantFullIdChange(e) {
    // S1：checkbox-group 取消勾选时 detail.value 为空数组，Boolean([]) 是 true——
    // 必须按**选中值是否包含 full** 判断，兑现用户的显式选择。
    const checked = Array.isArray(e.detail.value) && e.detail.value.indexOf('full') !== -1;
    const patch = { wantFullUserId: checked };
    // S1 收尾（展示时点）：取消勾选的当下、下一次提交之前，立即隐藏旧完整编号并
    // 保留尾号——不产生新请求；重新勾选**不恢复**旧编号，只有新一次有效核验返回后
    // 才会随新结果再次展示。
    if (!checked && this.data.result && this.data.result.fullUserIdAvailable) {
      patch.result = Object.assign({}, this.data.result, {
        userId: '',
        fullUserIdAvailable: false
      });
    }
    this.setData(patch);
  },

  async onCheckTap() {
    // 已锁在途请求：重复点击不产生第二次调用。
    if (this.data.sending) return;
    if (!this.data.passphrase) {
      this.setData({ stopHint: '请先输入本窗口的临时核验口令。' });
      return;
    }

    this.setData({ sending: true, stopHint: '', result: null });

    const request = {
      action: 'inspectSelf',
      passphrase: this.data.passphrase,
      // R2：仅在负责人显式勾选时请求完整内部 userId
      includeFullUserId: this.data.wantFullUserId === true
    };
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
        // R2：完整内部 userId（仅本次有效结果且显式请求时才有值）
        userId: response.userId || '',
        fullUserIdAvailable: Boolean(response.userId),
        checkRoundId: response.checkRoundId,
        serverTime: response.serverTimeIso || '',
        code: response.code || '',
        // C3：仅展示客户端净化后的受控键诊断（固定标签/计数/长度分桶，无原键名/值）
        keyDiagnosticText: describeKeyDiagnostic(response.keyDiagnostic)
      },
      lastCheckedAt: response.serverTimeIso || '',
      stopHint: hint
    });
  }
});