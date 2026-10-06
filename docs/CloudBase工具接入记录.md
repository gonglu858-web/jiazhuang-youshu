# CloudBase 工具接入记录

## 2026-09-24 安装与核验

用户已确认安装官方 CloudBase MCP 与小程序、数据库、云函数相关 Skill。安装不代表授权新增付费服务、迁移数据库或扩大云端业务实施范围。本轮未改动小程序业务代码、集合、云函数或计费。

### 已安装

官方仓库：`https://github.com/TencentCloudBase/cloudbase-skills`，固定提交 `9992ab1e125d07edc19f2d2eefa94e8fdbf81307`，Skill 版本 2.34.6。

全局目录 `C:/Users/30591/.codex/skills/` 已安装：

- `miniprogram-development`
- `auth-wechat-miniprogram`
- `cloudbase-document-database-in-wechat-miniprogram`
- `cloudbase-platform`（公共指南和变更、部署协议）
- `auth-tool-cloudbase`

Skill Installer 已将六项候选下载至隔离检查目录。正式安装时第二次下载遇到 IncompleteRead，未沿网络路径重复尝试；使用此前成功下载的副本，逐文件与固定提交克隆内容核对后复制五项到全局目录，再核对安装副本。全部为 Markdown 文件，未覆盖已有 Skill。新 Skill 可在下一轮对话被发现；项目用户授权、AGENTS 和 YF 流程仍优先。

### 安全检查及暂缓项

采用 Skill Vetter 流程，检查工具位于独立目录 `C:/Users/30591/.codex/tmp/cloudbase-review-tools/`，未改动项目依赖。Aguara 0.28.0 下载包 SHA256 与官方校验清单一致；Cisco AI Skill Scanner 2.1.0 安装在独立 Python 虚拟环境；jq 1.8.1 用于报告解析。依赖检查通过。

已运行 Aguara、Cisco 本地静态扫描、密钥模式检查、结构检查及 Skill Vetter 脚本。Windows 运行副本仅禁用脚本的自动递归临时目录清理，保留扫描结果。没有调用付费 LLM 扫描或上传项目文件。检查不能保证排除所有风险。

- 五项已安装 Skill 的 Cisco 最高级别均为 INFO（未在每个 Skill 的 frontmatter 声明 license）。
- Aguara 对官方 Google OAuth 地址、安全文档中“不要输出凭据”的说明和安装示例提出提示，已人工阅读对应上下文；未发现实际凭据、执行脚本或要求隐瞒行为。没有执行这些文档示例。
- **`cloud-functions` 未安装到生效目录。** Cisco 把“Never echo ... or dump credential ...”这一禁止泄露凭据的提醒标为 CRITICAL，并把“Do not tell the user to ask again or imply success before a terminal status”及不要推荐不支持的 API Key 用法标为 HIGH。人工判断很可能是文字匹配误报，但按 Skill Vetter 的 BLOCKED 规则保留待处理，不能称全部扫描通过。
- Skill Vetter 自带脚本读取 Cisco 结果的旧字段 `severity`；当前 Cisco 返回 `max_severity`，因此脚本退出码 0 不能用于认定通过。本次另行检查 Cisco 原始 JSON，依据实际高风险结果暂缓云函数 Skill。

原始报告保留在上述检查工具目录，文件名为 `aguara-*.json`、`cisco-*.json`、`vett-*.txt`。候选副本保留在 `C:/Users/30591/.codex/tmp/cloudbase-skills-staged-20260924/`。

### MCP 接入状态

已使用 Codex 官方 CLI 添加全局 `cloudbase` HTTP MCP 配置，URL 为官方国内服务：

`https://tcb-api.cloud.tencent.com/mcp/v1?env_id=cloud1-d8gcq5ag39d847723`

配置文件：`C:/Users/30591/.codex/config.toml`。修改前备份在 `.codex/tmp/config-before-cloudbase-20260924.toml`，未打印或复制其中其他连接的凭据到项目。

客户端暂只允许五个查询工具：`queryEnv`、`queryPermissions`、`queryFunctions`、`readNoSqlDatabaseStructure`、`searchKnowledgeBase`。这是 Codex 的工具白名单，不等同于腾讯云账号 IAM 只读授权；OAuth 服务请求的 scope 为 `mcp:full`。云端写入工具暂不开放。

首次 OAuth 等待用户操作超时；第二次用户完成授权后，登录进程明确返回 `Successfully logged in to MCP server cloudbase`，`codex mcp list --json` 显示 enabled=true、auth_status=o_auth，目标 URL 固定为 cloud1。授权成功已由 CLI 确认。当前任务内工具列表仍未出现 CloudBase 查询工具，尚未实际读取云端环境、用量或权限；重新打开 Codex 使连接加载后再核验。

本轮选远程 HTTP 接入以满足只读查询；依赖本地文件上传的完整部署能力不在本次远程接入验证范围。微信开发者工具现有能力继续保留。

### 下一步

1. OAuth 登录已完成；用户授权截图中的账号 UIN 与先前 cloud1 归属一致。等待 Codex 加载新 MCP 工具，无需重复登录。
2. 新连接可用后只读核对环境、权限和实际用量，先读最新进展，避免重复索取开发任务已经取得的证据。
3. 云函数 Skill 的扫描误报单独处理；不为通过扫描而关闭检测或静默修改官方说明。
4. 本次工具安装没有改变已批准的身份与成员权限方案，也没有授予负责人资格。


## 2026-09-25 接入实测成功

重新打开后，当前任务已加载全部五个查询工具。环境详情、数据库结构、资源权限、用户及扩展 OPA、计费用量均取得实际返回；CloudBase 查询连接成功已验证。六个业务集合均为空且 ADMINONLY，函数完整通配规则与用户此前提供一致。函数列表单次查询遇到 JSON-RPC 反序列化错误，没有重试或推断函数部署状态。原始证据见 [MCP只读核验](证据/2026-09-25-CloudBase-MCP只读核验.json)，结论及下一步见 [实施记录](云端身份权限实施记录.md)。本轮未修改云端。云函数 Skill 仍未安装，其扫描误报待单独处理；这不影响本轮已成功的管理查询。
