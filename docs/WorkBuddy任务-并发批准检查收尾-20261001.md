# WorkBuddy 任务：关闭已完成的并发批准检查

状态：WorkBuddy 已完成本地收尾，Codex 独立复查通过（2026-10-01）；本任务已完成。

## 已确认结果

用户用管家 64193d 真机同时发送两次批准请求，一次成功、一次 CODE_INVALID。Codex 只读比对确认：成员 v5→v6，邀请 requested/v2→approved/v3，绑定编号散列与有效期均已清空，审计 42→43 且仅新增一条对应批准记录。角色师傅＋设计师、工种拆改＋木工不变；项目、其他成员、其他邀请及原 42 条审计的已选字段不变。

依据：[手机原报告](证据/同一申请并发批准真机报告-20261001.json)、[事后复核](证据/同一申请并发批准事后复核-20261001.json)。只证明本次同一申请两请求仅生效一次，不代表整个第一单元验收，也不证明不同主业主申请的并发唯一性。

## 本轮实施范围

1. 只修改 `miniapp/miniprogram/config/valid-concurrent-approval-proof.js`：将 `enabled` 设为 `false`，将执行凭据恢复为无效占位（字符串为空、工种数组为空，包括内嵌 bindingProof）；保留配置字段和 Object.freeze 结构。历史真实值已经留在证据文件，不再作为可执行配置。
2. 更新此任务末尾的实际交付记录，并在进展文档顶部追加完成与自测结果。不要改写已有证据或历史结论。
3. 不改探针、页面、云函数、测试逻辑或旧配置 `valid-binding-proof.js`、`valid-approval-proof.js`。不要删除已有手机防重标记、缓存或检查报告。
4. 不调用云端批准，不回滚邀请或成员，不取号、不重新申请、不生成新邀请码、不部署、不发布。

## 验证与交付

- 检查实际导出配置为禁用且凭据为空，冻结结构保留。
- 运行已有相关测试：`node --test miniapp/tests/concurrent-approval-probe.test.cjs miniapp/tests/access-page-probe.test.cjs`。禁用路径应不发出批准请求；不得为了通过测试改动业务实现。
- 运行 `git diff --check`；交付实际改动文件、测试数量与结果，注明没有云端写入。
- 若现有页面在禁用配置下出现异常，保留错误并交 Codex 审查，不自行扩大到页面重构或云端修改。

完成后由用户通知 Codex“WorkBuddy 收尾完成，请复查”。Codex 审查后再整理第一单元剩余验收事项；本轮无需用户重新扫码或重复批准。

## 实际交付记录

- 交付时间：2026-10-01 13:22（北京时间）
- 修改文件：仅 `miniapp/miniprogram/config/valid-concurrent-approval-proof.js`
- 修改内容：`enabled` 设为 `false`；所有执行凭据字段（含内嵌 `bindingProof`）恢复为空字符串；`trades` 设为空数组；保留 `Object.freeze` 结构
- 未修改：探针、页面、云函数、测试逻辑、旧配置 `valid-binding-proof.js`、`valid-approval-proof.js`
- 未删除：手机端防重标记、缓存、历史检查报告
- 未执行：云端批准、回滚、取号、重新申请、部署、发布
- 自测结果：
  - `node --test miniapp/tests/concurrent-approval-probe.test.cjs miniapp/tests/access-page-probe.test.cjs`：39 项（39 通过、0 跳过、0 失败）
  - JS/JSON 语法：23 个 JS、8 个 JSON 全部通过
  - WXML/WXSS 编译：7 个 WXML、8 个 WXSS 全部通过
  - `git diff --check`：无空白问题
  - 导出配置校验：`enabled=false`，执行凭据字段全为空字符串，`trades` 为空数组

## Codex 复查

39项相关测试全部通过；配置禁用、执行凭据清空、冻结结构保留。role和status保留固定校验值，不影响关闭结论。列明的探针、页面、测试及旧配置指纹未变。范围与限制见[复查证据](证据/WorkBuddy并发批准检查收尾复查-20261001.json)。下一步为[临时入口版本隔离](WorkBuddy任务-临时测试入口版本隔离-20261001.md)，不用重复真机。
