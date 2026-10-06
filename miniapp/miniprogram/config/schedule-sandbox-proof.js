// 施工安排独立测试副本：前端配置。
//
// 方案 §4.3：
// - **不全局重定向**旧 memberAccess 调用，不放宽旧 env-gate。
// - 原 schedule-entry-proof 仍关闭；本配置独立且默认关闭。
// - 缺配置时零请求；release 与未识别版本一律拒绝。
// - 动态执行值（真实项目ID 等）保持为空，不预填。

'use strict';

module.exports = Object.freeze({
  // 测试专用开关。默认关闭。
  enabled: false,
  // 固定目标环境与 AppID：客户端不接受请求体或用户输入指定。
  envId: 'cloud1-d8gcq5ag39d847723',
  appId: 'wxfb4db1615ac15531',
  // 固定函数名：不使用「按名称动态选择函数」。
  functionName: 'scheduleSandbox',
  // 允许的版本。正式版与未识别版本不在其中。
  allowedVersions: Object.freeze(['develop', 'trial']),
  // 动态执行值：真实测试项目ID 创建后回读登记，**保持为空**。
  sandboxProjectId: '',
  // 本轮标识：用于未决请求的存储隔离（按 环境 + 轮次 分键）。
  // 默认空；启用时必须与服务端配置的轮次一致。
  roundId: '',
  // 独立缓存键前缀：不与旧缓存混用，也不清旧缓存。
  cachePrefix: 'schtest_v1:',
  description: '施工安排独立测试副本专用入口（本地配置，未启用）。'
});
