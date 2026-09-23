// 仅本机测试文件保存。正式版须接入可信上传、压缩、水印与云端访问校验。
function persist(media, onProgress) {
  return media.reduce((chain, item, index) => chain.then(async () => {
    if (item.source === 'camera' && !item.saved) {
      const path = `${wx.env.USER_DATA_PATH}/renovation-demo-${item.id}.${item.type === 'image' ? 'jpg' : 'mp4'}`;
      await new Promise((resolve, reject) => wx.getFileSystemManager().copyFile({ srcPath: item.path, destPath: path, success: resolve, fail: reject }));
      // 成功的文件复用，下一次重试只保存尚未完成的文件。
      item.path = path;
      item.saved = true;
    }
    onProgress(index + 1, media.length);
  }), Promise.resolve()).then(() => media);
}
module.exports = { persist };
