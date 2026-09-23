const { envId } = require('./config/cloud');

App({
  globalData: {
    cloudReady: false,
    cloudError: ''
  },
  onLaunch() {
    if (!wx.cloud) {
      this.globalData.cloudError = '当前微信版本不支持云开发，请更新微信后重试。';
      return;
    }
    try {
      wx.cloud.init({ env: envId, traceUser: false });
      // 初始化只代表 SDK 已准备好；实际连接结果由云函数调用验证。
      this.globalData.cloudReady = true;
    } catch (error) {
      this.globalData.cloudError = '云开发初始化失败，请重新打开小程序。';
      console.error('Cloud initialization failed', error);
    }
  }
});
