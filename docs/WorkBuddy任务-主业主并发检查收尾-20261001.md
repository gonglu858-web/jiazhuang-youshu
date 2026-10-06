# 主业主双申请并发：本地配置收尾

## 已核实结果

Codex已只读核实本次真机一成功、一OWNER_EXISTS，见[事后核验](证据/不同主业主并发事后核验-20261001.json)。C项目v1→v2、甲989a74新增唯一主业主成员v1、甲邀请v2→v3、甲编号消费；乙f182f4邀请requested/v2且编号未消费；审计52→53仅新增一条approveInvitation，其他所选记录保持。尚待两候选手机访问核验，不代表整个第一单元完成。

## 唯一代码修改

仅修改 miniapp/miniprogram/config/valid-primary-owner-concurrency-proof.js：

- enabled=false。
- 清空本轮动态执行值：顶层evidenceId、projectId、projectName、baselineAt、verifiedAt、checkBefore为空字符串；projectVersion恢复空占位；primaryOwnerUserId继续为空。
- expectedMembers每项memberId清空；固定负责人/管家userId、roles、空trades等模板保持。
- candidates每项invitationId、expectedMemberId、invitationExpiresAt清空；固定候选标签/userId、主业主角色、requested状态、v2模板、管家issuedByUserId、空trades保持。
- 两份bindingProof的evidenceId、digest、expiresAt、verifiedAt、checkBefore清空；userId可保留与固定候选身份对应。
- 固定目标AppID/env、actorId、projectScope保持；保留顶层及全部嵌套Object.freeze。
- 不将原始编号写入任何文件；历史证据保留，不回写或覆盖已验收基线。

## 不在本轮修改范围

不改探针、页面、测试、云函数、数据库规则、env-gate或旧配置。不清手机缓存、防重标记或报告，不创建/批准/撤销/回滚云端记录，不重新取号或申请，不生成预览、不部署、不发布。保留C唯一主业主和乙待申请现状。

## 自测与交付

检查禁用和动态字段全空，15个对象/数组仍全部冻结；运行已有主业主并发探针和access页面测试、语法检查、git diff --check。报告实际修改清单和测试数，交Codex复查，不自行安排重新执行。开发记录可追加本任务，其他代码不得修改。

## Codex收尾复查：通过

禁用/动态清空/固定模板/全部冻结均通过，实际15个对象或数组；53项相关测试通过，75文件仅目标配置变化，语法及diff检查通过。见[证据](证据/主业主并发配置收尾复查-20261001.json)。用户已确认甲可见C乙不可见C，本次并发检查闭合，WorkBuddy无需继续修改。本轮不操作云端、不部署。
