# 固定Node收尾feddd0a独立复核

2026-10-26；受审 `feddd0a`，基线 `e9a3e75`；依据[上一轮报告](Codex复查-固定Node返修487a17d-20261026.md)§2–§3。**S2关闭，S3源码修正关闭；S1仍有最终判定遗漏。只返修证据最终收尾，不再改PS1。动态PowerShell语义未验证，A与真实私密输入及执行不放行。** R1生产启动链及此前认可项沿用。

## 1. 已关闭与实测

- 登记测试独立复跑47/47，业务包18/18，无失败/跳过。正常v3证据独立运行一次：静态56/56、解析通过、attempts/completed/failed=11/11/0、意外0、九个fault出口证明通过、finalOk=true/exit0。本次只执行Git、PowerShell解析探针与固定Node自重入，没有执行PS1的-File或查询策略。
- S1已完成部分：登记测试与自身文件读取已在判定前。独立在实际readFileSync边界注入被catch的HTTPS调用，两例均实际意外1、报告意外1、finalOk=false/exit1。这两处旧反例关闭。
- S2：Socket.prototype.connect、dns.promises.lookup、global fetch三入口，独立VM分别从业务阶段调用，证据守卫均记录意外1、finalOk=false/exit1；下层独立离线兜底命中0。真实网络未发生。交付脚本自身的“守卫抛出即独立兜底”不是两层独立机制；本复核另设完全合成的底层拒绝函数，验证新增三入口先被受审守卫截住。因此本项关闭，无需另改共享守卫。
- S3：PS1第625行按Ok/ExitCode与实际StartCalls/Starts/HoldOpens/HoldCloses判断，不再读取不存在的Started；第687–688行区分Node启动22项和回显接收20项，静态检查已同步。源码修正关闭；没有执行七场景、真实argv传输或操作系统锁验证，动态缺口继续单列。
- 新[复核脚本](证据/Codex固定Node收尾feddd0a复核-20261026.cjs)与[JSON](证据/Codex固定Node收尾feddd0a复核-20261026.json)：运行真实v3 JavaScript，九个内置子fault也递归执行源码；FS/OS/ASCII解码为合成替身，底层网络独立抛错。正常与八个反例/对照共九组，复现断言全部通过。复现通过不等于受审实现通过。

## 2. 唯一剩余：S1 / P1，最终判定仍早于摘要计算

位置：`docs/证据/CodeBuddy固定Node绑定返修v3-20261026.cjs`344–369、405行。

344行冻结finalOk，347行再次冻结realExitOk；之后report.digests仍在362、366–369行计算五份Buffer的SHA-256。虽然不再读取文件，但“全部摘要完成后才判定”仍未满足。

独立复现分别在**PS1摘要**及**历史v2 JSON摘要**的实际crypto.update调用点注入一次被catch的HTTPS请求；真实SHA-256计算仍原样执行，受审源码不改、没有真实网络。结果如下：

| 场景 | 实际意外 | 报告意外 / hitsAfterFinalOk | finalOk / realExitOk / exit |
| --- | --- | --- | --- |
| 正常 | 0 | 0 / 0 | true / true / 0 |
| 测试文件读取、自身文件读取（各自） | 1 | 1 / 1 | false / false / 1 |
| Socket、DNS promises、fetch（各自） | 1 | 1 / 1 | false / false / 1 |
| latePsHash、lateHistoryHash（各自） | 1 | 0 / 0 | true / true / 0 |
| 内置lateAfterVerdict | 1 | 0 / 1 | true / false / 1 |

这不是新增网络接口遗漏：注入使用证据自己的已覆盖HTTPS守卫。错误来自计数快照过早，导致后续摘要期间的意外被漏出最终结论。`noFileReadsAfterFinalOk=true`不足以证明摘要和核验都结束。

同一根因还表现为内置lateAfterVerdict明确接受finalOk=true但exit1。realExitOk=false使该反例退出失败，却没有满足上轮要求的“最终JSON成功字段和退出码同源”。消费者只读finalOk会收到相反结论；不能继续把这种矛盾当成通过条件。

### 定点返修要求

1. 先完成全部读取、全部摘要、保护核对、fault核验及必要收尾数据构造，再从最新实际守卫计数形成**唯一最终结论**，同步生成报告计数与退出码。report中只引用已完成的摘要值；不要继续叠加第二、第三个冻结成功标志。
2. 若保留早期判定，仅能明确命名为中间快照，不作为最终成功字段。lateAfterVerdict等敏感性必须落在真实最后判定之前，或者由同一最终出口收敛；故障统一finalOk=false/意外1/exit1，不得以改名或移动故障到无关早期阶段代替实际收尾覆盖。
3. 固化两处**实际摘要计算点**的被catch反例，保留两处实际文件读取反例、三条网络入口、既有九fault及正常对照；无需增加真实网络或系统操作。不得删除摘要字段、把意外改成探针或仅计算wouldFail。
4. 新建v4证据及JSON，v1–v3、所有Codex报告/反例原字节保留。仅调整该证据与必要定点测试/状态记录。PS1、生产启动链和已关闭S2/S3保护不动；不为本轮重新跑或重做其他已关闭项。

## 3. 保护、口径与交付

- 受审提交相对e9a3e75恰7文件，与交付范围相符；未改其他受保护路径。旧46项测试在N0之前的前缀字节一致；进展/交接旧blob为完整后缀。v1/v2脚本JSON逐字节一致；v2 JSON实际SHA为`384a0737f1f384a972615377b0606be78a6aeacc170bf7aa6fe7b7b22a032da5`，交付摘要中的“374f…”为笔误，不是历史文件变化。
- PS1 SHA `9255adb762cd19801805ee19c04204dd8f8a3b384d8fc857ff36d44466db0790`；v3脚本SHA `c7c4bf4cb07a7aeab23a4409a72377cd435bdea14baafff16a970e615bfcd478`，与交付一致。AGENTS既有SHA `9ef30b4c…`保留排除。
- 文件锁处理过程仅为开发方披露；本轮核对最终tree与字节，不据此认证过去的处理方式。后续受阻遵守既有停止分析规则，不借索引/换名等绕过阻断。
- “有效策略Restricted”仅沿用此前交付事实；本轮没有查询当前策略值，不重试受阻-File、不改变策略、不抽正文或换宿主。动态PS七场景/SelfTestTransport/UI前与启动前真实校验链仍未验证。旧NODE_FIRST_MATCH未改，A不恢复。
- 本复核只新增报告/复现脚本/JSON并更新状态和历史顶部。无额外一次性临时文件；没有读取真实编号/密文/凭据，没有UI/DPAPI、身份ACL查询、权限策略环境修改、联网安装或云端操作。1/2号不重试，P不开展。
- 下一轮只复跑新v4证据与受影响定点检查；若未改登记/业务代码或测试，不必机械重跑本轮47/18。新证据默认stdout、--out wx；如实分列合成与真实缺口。更新当前状态，历史字节安全前置并核对后缀；逐文件扫描暂存凭据/编号，master新增一次本地提交，不amend历史，AGENTS排除。交付后停止，状态写“本地证据收尾待Codex复核，动态PS语义未验证，真实私密输入及执行未放行”。
