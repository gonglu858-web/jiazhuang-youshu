# CloudBase CLI 独立安装核验

日期：2026-10-07。授权：用户明确“同意安装工具”，随后“继续”。范围依据 `Codex接入卡-生产身份核验N0-20261007.md` 第4节。

## 1. 结论

**官方 CloudBase CLI 3.8.4 已安装，版本与帮助检查通过，安装包完整性通过。** 没有登录、取凭据、初始化、建云资源、部署或启用。真实生产调用者仍未核验，WorkBuddy 暂不开发身份接入。

安装位置：`C:/Users/30591/.codex/tmp/cloudbase-readonly-cli-3.8.4`。

未全局安装、未修改 PATH 或项目业务依赖。包是 standalone bundle，安装锁文件只有一个包条目，相关运行依赖已打包在 CLI 内；不能把源码内的依赖声明当作逐项独立安装的版本证明。

## 2. 执行与完整性

1. 从 HTTPS 官方 npm 注册表读取精确版本元数据，确认名称、版本、下载地址及 SHA-512 完整性值，保存于安装目录 `registry-metadata.json`。
2. 使用现有 Node 22.16.0 / npm 10.9.2，安装固定 `@cloudbase/cli@3.8.4`，参数包含 `--prefix`、独立 `--cache`、官方 registry、`--ignore-scripts --no-audit --no-fund --engine-strict --save-exact`。没有开启安装生命周期脚本、执行 npm 建议的升级或选择其它版本。
3. 起初 npm 两次 ECONNRESET；请求终止该安装进程时，自动审批服务因额度限制未完成，命令未执行。后来用户继续，本次检查发现同一次 npm 安装已在第三次请求成功后正常结束（日志 exit 0）。没有重复安装、删除或覆盖目录。
4. 读取实际包版本与锁文件，另外对 npm 缓存中的已下载 tarball 重新计算 SHA-512，确认与官方元数据和锁文件三者一致。这是包完整性核验，不是对全部包代码的安全审计，也没有另行验证 npm 签名链。

| 对象 | 核验值 |
|---|---|
| tarball | https://registry.npmjs.org/@cloudbase/cli/-/cli-3.8.4.tgz |
| SHA-512 SRI | sha512-AS5L8KW7QAf+APYfBKaZ1rBuG+qIGWIlwPIU9dNpRJHQrfwpM2OfdRh159Xf38pOmS/rZ72YE6cGuSLgPGq/7Q== |
| package-lock.json SHA-256 | 1bc7cc063f431b32ed7fb300e9797275a91232715c72bb2b5711129341b0feda |
| dist/standalone/cli.js SHA-256 | 8d987e48b05eef08f78167f7da0f3c07a2515c6cdf58482094e217c49824ee97 |

注册表与实际外层 package.json 未声明 engines、dependencies；上一轮 PowerShell 将空属性计数显示为1，不代表确有1项外部依赖。源码入口要求 Node 主版本≥18，实际 v22.16.0 版本与帮助运行成功；不泛化为全部命令兼容性已验收。

## 3. 实际运行检查（均退出0）

使用现有 Node 显式执行安装目录的 `node_modules/@cloudbase/cli/bin/tcb`，工作目录为工具目录：

- `--version`：CloudBase CLI 3.8.4。
- `--help`：可列出 login / api / secrets 等命令。
- `login --help`：有 `--flow device|web`，默认 device。
- `api --help`：真实用法是 **api <service> <action>**，没有 call 子命令。
- `secrets get --help`：帮助正常；**没有运行 secrets get 本身**。

曾用 `api call --help` 探查帮助，CLI只展示 api 父命令帮助，没有发起 API 请求；随后按实际用法执行 `api --help` 确认。所有运行均为版本/帮助，不执行登录或业务动作。运行时禁用了更新通知；最后一项同时显式设 TCB_DISABLE_REPORT=1。未作网络拦截实验，不把本轮描述为“网络尝试0”（安装本就联网）。

## 4. 源码确认的接入能力

安装包 `dist/standalone/cli.js`：

- ApiCallCommand（约3808行）通过 getMangerService → commonService(service, apiVersion) → call({Action,Param})；支持通用官方API通道。还没有实测 STS 调用权限或响应。
- SecretsGetCommand（约45509行）使用 checkAndGetCredential(true)，可输出 secretId/secretKey/token/expiredAt/isTemporary/envId。这是敏感输出入口，不应直接输出到聊天或保存原始结果。环境ID字段不等于限制凭据权限。
- 这些依赖封装在 webpack bundle 中，不是可供项目直接 require 的独立 manager-node 包。不得提取内部模块编号作为生产接入接口。
- update-notifier 支持 NO_UPDATE_NOTIFIER；报告模块支持 TCB_DISABLE_REPORT。后续受控检查同时关闭二者，不使用 --verbose。

## 5. 下一步：单独安排浏览器授权，尚未执行

安装这一项已关闭，无需 WorkBuddy 返修。下一步建议只做一次官方浏览器/设备码登录和指定环境的只读身份核验，需明确授权该新范围。

拟执行前先核对登录存储与认证优先级，确保不覆盖当前 MCP 使用的登录/环境配置；若 CLI 默认共用登录文件，需要找到官方支持的隔离方式或先说明实际影响，不能凭目录独立就声称登录也隔离。用户在官方网页自行确认账户与授权，不发送密钥。

后续真实检查仅限固定环境 `cloud1-d8gcq5ag39d847723`、地域 `ap-shanghai`，查询调用者身份与环境关联；不调用 secrets get 输出凭据，不初始化，不建资源，不部署。登录本身不证明实际主体就是预期主体，STS返回也不得自动成为允许名单。

SDK复用同一凭据、凭据过期处理、IAM、身份允许名单、OPENID核对及平台事务仍未验证；这些需要后续具体接入任务，不能由工具安装成功推出。未改产品源码、已验收适配层或配置，未跑未变化代码的旧测试。
