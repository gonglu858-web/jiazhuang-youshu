// 固定环境与函数：页面不接受用户切换目标，也不接受调用方传入函数名/环境。
// R5：本轮核验轮次（打包器按唯一锚点替换）。页面必须原样带回，
// 服务端据此拒绝「缺轮次/空值/非法类型/错误轮次」——客户端不得自行编造。
module.exports = {
  envId: 'cloud1-d8gcq5ag39d847723',
  identityCheckFunction: 'scheduleSandbox',
  // 请求分层协议版本：与计划/manifest/服务端适配器绑定（participant-identity-request/1）
  requestProtocol: 'participant-identity-request/1',
  checkRoundId: ''
};
