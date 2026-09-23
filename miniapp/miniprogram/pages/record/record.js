const store = require('../../utils/store');
const business = require('../../utils/business');
const { SPACES } = require('../../utils/seed');
const { day, time } = require('../../utils/date');
const { fail, context } = require('../../utils/ui');
const { persist } = require('../../utils/media');

Page({
  data: { error: '', options: [], optionIndex: 0, spaces: SPACES.map(name => ({ name, selected: false })), location: '', note: '', media: [], images: [], videos: [], modeIndex: 0, modes: ['模拟拍摄（电脑试用）', '设备相机（待真机核验）'], saving: false, capturing: false, submitError: '', mediaHint: '还需 3 张照片，或录制 1 段视频', saveProgress: '' },
  onLoad(options) {
    this.projectId = options.projectId;
    this.requestId = store.uid('request');
    try {
      const state = store.read();
      const current = context(state, this.projectId);
      const plans = state.schedules.filter(item => item.projectId === this.projectId && business.workerCanPost(state, item, day())).map(item => ({ ...item, label: `${item.trade} · ${item.stage} · ${item.content}` }));
      if (!plans.length) throw new Error('今天没有本人获授权工种的施工安排，或今天为休息／停工日。');
      this.authorId = state.currentUserId;
      this.setData({ ...current, options: plans, schedule: plans[0], today: day() });
    } catch (error) { this.setData({ error: error.message, project: null }); }
  },
  changePlan(event) {
    if (this.data.saving || this.data.capturing) return;
    const index = Number(event.detail.value);
    if (this.data.media.length) return fail(new Error('已有影像，请先移除后再切换施工安排，避免记录归错工种。'));
    this.setData({ optionIndex: index, schedule: this.data.options[index] });
  },
  inputLocation(event) {
    if (this.data.saving) return;
    this.updateLocation(event.detail.value);
  },
  updateLocation(location) {
    const parts = location.split(/[、，,；;\n]/).map(value => value.trim()).filter(Boolean);
    this.setData({ location, spaces: SPACES.map(name => ({ name, selected: parts.includes(name) })) });
  },
  toggleSpace(event) {
    if (this.data.saving) return;
    const name = event.currentTarget.dataset.name;
    const parts = this.data.location.split(/[、，,；;\n]/).map(value => value.trim()).filter(Boolean);
    const next = parts.includes(name) ? parts.filter(value => value !== name) : parts.concat(name);
    this.updateLocation([...new Set(next)].join('、'));
  },
  inputNote(event) { if (!this.data.saving) this.setData({ note: event.detail.value }); },
  changeMode(event) {
    if (this.data.saving || this.data.capturing) return;
    if (this.data.media.length) return fail(new Error('请先移除当前影像，再切换拍摄方式。'));
    this.setData({ modeIndex: Number(event.detail.value) });
  },
  setMedia(media) {
    const images = media.filter(item => item.type === 'image');
    const videos = media.filter(item => item.type === 'video');
    const mediaHint = business.mediaError(media) || '影像数量已满足，可以发布到本机';
    this.setData({ media, images, videos, mediaHint, submitError: '' });
  },
  capture(event) {
    if (this.data.saving || this.data.capturing) return;
    const type = event.currentTarget.dataset.type;
    if (type === 'image' && this.data.images.length >= 9) return fail(new Error('每次最多 9 张照片，请先移除再重拍。'));
    if (this.data.modeIndex === 0) {
      this.setMedia(this.data.media.concat({ id: store.uid('media'), type, source: 'simulated', capturedAt: time(), path: '', duration: type === 'video' ? 15 : 0 }));
      return;
    }
    if (typeof wx.chooseMedia !== 'function') return fail(new Error('当前基础库不支持此相机接口，请用模拟拍摄试用，设备拍摄另行核验。'));
    this.setData({ capturing: true });
    wx.chooseMedia({
      count: type === 'image' ? 9 - this.data.images.length : 1, mediaType: [type], sourceType: ['camera'], maxDuration: 60, sizeType: ['compressed'], camera: 'back',
      success: result => {
        const additions = (result.tempFiles || []).map(file => ({ id: store.uid('media'), type, source: 'camera', capturedAt: time(), path: file.tempFilePath, duration: type === 'video' ? Number(file.duration) : 0 }));
        if (!additions.length) return;
        const combined = this.data.media.concat(additions);
        // 未达到最低数量时仍允许保留，以便继续拍摄；无效视频直接拒绝。
        if (combined.filter(item => item.type === 'image').length > 9) return fail(new Error('每次最多 9 张照片。'));
        if (additions.some(item => !item.path || (type === 'video' && (!Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 60)))) return fail(new Error('影像无效或视频超过 60 秒，请重新拍摄。'));
        this.setMedia(combined);
      },
      fail: error => {
        if (/cancel/.test(error.errMsg || '')) return;
        fail(new Error('相机未能打开。请检查设备授权；模拟器请切换为模拟拍摄。已填内容保留。'));
      },
      complete: () => this.setData({ capturing: false })
    });
  },
  removeMedia(event) { if (!this.data.saving && !this.data.capturing) this.setMedia(this.data.media.filter(item => item.id !== event.currentTarget.dataset.id)); },
  previewImage(event) { const urls = this.data.images.filter(item => item.path).map(item => item.path); if (urls.length) wx.previewImage({ current: event.currentTarget.dataset.path, urls }); },
  async submit() {
    if (this.data.saving || this.data.capturing || this.completed) return;
    const input = { requestId: this.requestId, projectId: this.projectId, scheduleId: this.data.schedule && this.data.schedule.id, scheduleVersion: this.data.schedule && this.data.schedule.version, location: this.data.location, note: this.data.note, media: this.data.media };
    try {
      const state = store.read();
      if (state.currentUserId !== this.authorId) throw new Error('试用身份已变化，请返回重新进入。');
      business.validateRecord(state, input, day());
      this.setData({ saving: true, submitError: '', saveProgress: '正在保存到本机…' });
      await persist(input.media, (done, total) => this.setData({ saveProgress: `本机影像保存 ${done}/${total}` }));
      const fresh = store.read();
      if (fresh.currentUserId !== this.authorId) throw new Error('试用身份已变化，请返回重新进入。');
      const next = business.publishRecord(fresh, input, day(), time(), store.uid('record'));
      store.write(next);
      this.completed = true;
      wx.showToast({ title: '已发布到本机', icon: 'success' });
      const pages = getCurrentPages();
      const previous = pages[pages.length - 2];
      if (previous && previous.route === 'pages/project/project') previous.setData({ tab: 'records', recordDate: '' });
      wx.navigateBack();
    } catch (error) {
      this.setMedia(input.media);
      this.setData({ submitError: error.message || '本机文件保存失败，已填内容和影像保留，请重试。', saveProgress: '', saving: false });
    }
  }
});
