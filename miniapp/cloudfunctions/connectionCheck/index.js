// 开发环境连通性检查，不读取用户身份，不访问数据库或存储。
exports.main = async () => ({
  ok: true,
  service: 'renovation-connection-check',
  version: '1.0.0',
  serverTime: new Date().toISOString()
});
