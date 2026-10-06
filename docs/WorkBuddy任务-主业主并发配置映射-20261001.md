# 主业主双申请并发：配置映射任务

状态：Codex已完成管理端事前只读核验。现在只更新本地配置，交Codex复查；不要真机执行或自动批准。

## 唯一数据来源与修改范围

读取 `docs/证据/不同主业主并发执行前基线-20261001.json` 的 **primaryOwnerConcurrencyConfiguration**，逐字段准确映射到 **miniapp/miniprogram/config/valid-primary-owner-concurrency-proof.js**。

- 包含enabled=true、轮次evidenceId、AppID/env、C项目完整ID/实际名称/scope/version、actorId、baselineAt/verifiedAt/checkBefore、空primaryOwnerUserId、expectedMembers及两份candidates的完整bindingProof。
- 保留Object.freeze：顶层、预期成员列表/每项/roles/trades、候选列表/每项/trades/bindingProof均冻结。不得删除字段、改变甲乙顺序或自己生成新的证据ID。
- 项目实际名称为 **虚构测试 · 装修项目**，不是原计划的“虚构测试 · 主业主并发唯一性”。项目靠完整ID准确识别：`p_4e53f8437dab4ddcb62971d58455acaa`。
- 甲989a74对应 `i_a723e933cae24c52858ec24f2781e98e`；乙f182f4对应 `i_e8fe4566389e4ad2b2070c62d038f162`。两位编号摘要来自基线，不需要获取原始编号。
- 唯一实际代码变更为该配置；开发记录可以在本任务末尾追加。本轮不要修改探针、页面、测试、云函数、规则、env-gate或任何旧配置。

## 时间与核验边界

共同最晚窗口：`2026-10-02T12:27:10.726Z`，即北京时间 **2026-10-02 20:27:10.726**，来自甲编号的到期时间；乙编号比甲晚约40秒到期。不是截止前任意时刻都已获准执行，Codex在交付后仍需复查云端状态和文件。

如时间已过，或得知用户重新取号/批准/申请改变，停止并说明，不能仅修改截止时间、基线时间或摘要。不要替用户重新取号。

基线核验：users4、projects3、members7（C恰2）、invitations8（C恰2 requested/v2）、admins1、audit52（分页全量ID唯一）。C为active/identity-test/v1、primaryOwnerUserId=null；管家64193d非负责人；两候选active，当前有效摘要各唯一且未消费，C无候选成员、无批准审计。分页和跨集合非原子快照，事后按已选字段比较。完整数据和RequestId保留在证据文件中。

## 自测与交付

1. require导出配置后，与基线configuration深比较；检查嵌套冻结及没有原始编号。
2. 运行已有探针/页面回归与相称的JS/JSON/模板检查，准确报告数量及跳过。基线中的真实摘要不能用合成编号验证成功；不要尝试猜号。保留合成测试夹具，不为让测试通过放宽断言。
3. git diff --check，报告本轮只改该配置，附evidenceId和checkBefore。若有意外文件变化，列出，不覆盖其他成果。
4. 交Codex审查后等待。**不创建云记录、不批准、不生成预览、不部署；不清缓存、防重标记或历史报告。**

## Codex后续

复查配置与代码指纹，再只读复核基线是否保持；有变化先判断，不直接让用户点击。通过后才指导管家64193d在最新预览输入甲乙本人提供的编号，各申请同时发一次。仅一成功+一OWNER_EXISTS为候选，事后须证明C v1→v2、C成员2→3且唯一主业主、胜方邀请v2→v3/编号消费、败方不变、批准审计只加1，A/B其他已选字段保持，并核验胜败账号访问权。此任务不声称已执行或通过真实并发。

## Codex复查结论

2026-10-01配置与云端复查通过，详见[复查证据](证据/主业主并发配置映射复查-20261001.json)。162项测试全部通过，15个对象/数组冻结；75文件仅本配置变化，六集合完整选定投影保持。WorkBuddy本轮任务完成，无新增代码修改任务。后续由用户按Codex步骤真机执行一次并提交报告，再由Codex只读核实；执行前复查不等于并发唯一性验收完成。
