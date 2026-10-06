# CloudBase 现有连接检查与记录只读工具接入

日期：2026-10-03。用户明确要求按 https://docs.cloudbase.net/skill.md 完成接入。

## 已完成

- 已读取官方 Setup Skill；遵循已有原生 MCP 可用时优先复用、不重复叠加安装的路径。
- Node v22.16.0、npm 10.9.2、npx 已存在，没有安装新运行时或插件。
- 现有 CloudBase 为官方 HTTPS 远程 MCP，主机 tcb-api.cloud.tencent.com；地址的认证查询参数未复制到报告或输出。
- 本次 queryEnv(info) 成功：cloud1-d8gcq5ag39d847723，AppID wxfb4db1615ac15531，环境 NORMAL，NoSQL 后端；RequestId 5c7b1773-9cb7-450c-8da9-618f75e730a2。
- 找到此前记录查询不可用的本地原因：Codex enabled_tools 仅列五个元数据/文档工具，未开放官方 readNoSqlDatabaseContent。此前“没有记录查询入口”是会话可见能力描述，不代表 CloudBase 不支持记录读取。
- 官方工具说明确认 readNoSqlDatabaseContent 是管理端记录查询，支持 query/projection/分页/排序：https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/mcp-tools 。

## 唯一配置修改

在 C:/Users/30591/.codex/config.toml 的 mcp_servers.cloudbase.enabled_tools 中新增：

`readNoSqlDatabaseContent`

保留原有 queryEnv、queryPermissions、queryFunctions、readNoSqlDatabaseStructure、searchKnowledgeBase；没有开放写入、调用云函数或部署工具，没有改变服务 URL/认证信息/超时/其它服务器配置。通过反向替换比对确认无其它文本变化。

原配置已备份到 C:/Users/30591/.codex/tmp/config-before-cloudbase-read-content-20261003-234026.toml。备份包含原连接设置，仅留本机私有目录，不进入项目仓库或交接。

## 验证边界

- **CloudBase 连接与当前登录已验证可用。**
- **新增记录查询工具配置已落盘；本会话尚未加载，记录读取待重载后验证。**
- 本轮没有读取 A/B/C 新业务记录，没有云端写入、没有创建资源/部署，也未改变入口关闭状态。
- 官方知识库检索一次超时，后用官方网页确认工具定义；没有为此重复安装。
- 当前 B0 仍为 PARTIAL_OBSERVATION / complete=false，不能因接通工具就标为验收完成。

## 下一步

用户重新加载或重启 Codex，回到本对话告知“继续 B0”。先确认 readNoSqlDatabaseContent 出现在工具列表，再核对其实际参数与明确环境，以字段投影读取 A/B/C 的 projects、project_members，然后读取所引用 users 的 _id/status 及 app_admins.primary 的 _id/userId/status。不查询 openid、绑定编号或令牌，不调用业务 identity 路由。

若重载后读取成功，继续记录级核验，用户不必手工导出。若远端工具缺失或授权失败，只报告准确错误，不声称数据库数据已读取。

