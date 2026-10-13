# 用户主账号 GetRole 成功结果核对

日期：2026-10-13。接手基线：5eaabf4。本轮只核对用户材料、官方公开文档及本地既有证据。

## 结论

用户在 API Explorer 手动查询并回传的角色尾2941为 TCB_QcsRole，所属主账号尾7053。完整 RoleId 与 RoleArn 内所属 UIN 的 SHA-256 分别与既有 STS 基线一致，不是仅比较尾号。角色实体识别问题已解决；与日志角色 TCB_QCSRoleInRunLog（尾2942）是两个实体，无需修改日志角色。

用户返回 RequestId：2511d0fd-f9af-4fae-a3bc-fa27d12cb621。RoleType=system；创建及更新时间为2026-09-23 16:51:43。信任策略允许 scf.qcloud.com、tcb.cloud.tencent.com、cvm.qcloud.com 执行 sts:AssumeRole。时间接近账号创建时间，不证明完整创建授权过程。

[腾讯云官方 TCB 预设策略说明](https://cloud.tencent.com/document/product/876/47056)明确提及云开发服务角色 TCB_QcsRole。这支持角色名称与产品用途，不证明本实例关联了文档所列全部权限。

## 尚未确认

- 信任服务域名不能直接映射为 STS PrincipalId 尾5386。该申请账号与本次 CloudBase CLI 凭据签发的具体关系仍需平台确认。
- PolicyDocument 是信任策略，不等同关联权限策略、临时会话有效权限或数据库写权限；角色描述也不能用作写权限验证。
- 本次主账号查询成功不改写此前 CLI 的 AuthFailure.UnauthorizedOperation；两次请求的调用身份不同。本次成功 RequestId 不能冒充旧失败请求 RequestId。
- 控制台角色列表为何未显示该角色、申请主体是否轮换仍未知。不猜测隐藏机制，不要求其必须永不变更；继续采用变更即停、重新核对。
- CAM RoleArn 与 STS assumed-role Arn 格式不同，本次精确核对所属账号及 RoleId；SessionDuration=7200 不用来倒推旧凭据有效期。

因此 principalSourceConfirmed、roleTrustApproved、writeAuthorized 仍为 false。角色实体已识别不等于真实初始化获批。

## 核验及来源边界

新增[本地核对脚本](证据/Codex用户GetRole成功结果核对-20261013.cjs)及[结果](证据/Codex用户GetRole成功结果核对-20261013.json)。固定核对既有基线文件指纹、两个完整标识摘要以及请求编号格式；信任策略按用户回传内容记录。此为材料一致性核对，不是重新执行平台 API，也不是响应真实性的密码学认证。

官方字段语义参见[GetCallerIdentity](https://cloud.tencent.com/document/product/1312/66098)。用户执行的人工查询与助手本轮零认证 API 调用分别记录。未读取认证缓存、获取凭据、运行 worker、写库、初始化、部署、改变权限或签发批准。业务代码未改，业务测试未重跑；旧证据保留。

## 唯一下一步

在既有工单202610137590补充成功 GetRole 结果，请人工确认 PrincipalId 尾5386是否为 CloudBase 为该小程序申请临时凭据的正常主体，以及如何核实这条授权关系。无需继续排查日志角色2942，不需要提供密钥或修改权限。

收到可核对答复后再判断能否准备新的管理员执行包。真实写入仍需新轮次、具体执行包及用户确认，不复用v2失败轮次或旧凭据。本节点无需转发给 WorkBuddy。
