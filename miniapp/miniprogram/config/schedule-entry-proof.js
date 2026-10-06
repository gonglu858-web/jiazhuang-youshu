// 施工安排第二单元入口配置。
// 默认禁用，启用前须经管理端审查并填入允许的项目 ID 列表；不保存凭据或密钥。

module.exports = Object.freeze({
  enabled: false,
  appId: 'wxfb4db1615ac15531',
  envId: 'cloud1-d8gcq5ag39d847723',
  allowedProjectIds: Object.freeze([]),
  allowedVersions: Object.freeze(['develop', 'trial']),
  description: '施工安排新增、调整、改派、取消、只读查看及版本历史入口。'
});
