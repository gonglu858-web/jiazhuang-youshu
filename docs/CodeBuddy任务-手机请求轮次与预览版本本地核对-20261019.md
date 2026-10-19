# CodeBuddy任务：手机请求轮次与预览版本可核对，仅本地实现

## 1. 接手、依据与授权

项目根：C:\Users\30591\Documents\ChatGPT\装修进度验收APP；master，接手参考d3a03d0及本任务提交。先读AGENTS.md、当前状态、CodeBuddy开发交接及本任务。2026-10-19用户授权：先在本地补齐“手机请求轮次、预览版本”的核对办法，保留现有身份与权限校验，再决定是否安排新测试。Codex负责方案/验收，CodeBuddy实施/自测，随后Codex独立复查。不得联网或生成真实执行批准。

依据：[结果核对](证据/CodexI2轮次不匹配本地核对-20261019.json)、对应cjs、[执行收尾](证据/Codex参与者I2固化显示续接轮执行收尾汇总-20261019.json)。I2截图PIC_ROUND_MISMATCH/UNKNOWN/readAttempted=false；截图轮次取自response.checkRoundId，核心baseResult取服务端配置，不是手机发出的轮次。现有本地client→adapter与入口轮次一致；实际手机请求值、预览构建版本未取证，根因未定。不能把旧二维码/缓存/平台改写作为已证实原因。

已关闭：分层适配器、原型校验、原身份/口令/窗口/三字段本人只读、提前准备与执行时效分离、39文件快照与关闭23文件等既有结论。不重做或放宽。最近远端来源为2026-10-19 16:05:24关闭下载，18:06离线核对8文件；CodeSha256=9ae9b524076686c96aff5f4d62c03f8a6f31e1571df334c64ed592df8a5eec79。本轮不查询云端。

## 2. 方案：三个独立证据，不增加请求字段

### 2.1 手机预览版本（提交之前可见）

页面加载即展示“本机预览版本”“本机配置轮次”。数据来自随本包打入的前端本地只读配置，不来自服务器响应、不来自本机缓存/设备身份。加载/切前台零发送。不增加按钮、取号、复制、上报、重试或清缓存入口。

新增previewBuildId：完整64位小写SHA-256；页面可清晰分行展示完整值，人工核对先看前12位，严格机器校验使用全值。它是本地受审包标识，不称微信平台构建编号/二维码签名/可信硬件证明。它不能单独证明编译器执行了全部原字节。

打包器按固定排序的规范JSON计算：证据协议版本、请求协议、轮次、参与者代码、固定AppID/环境/函数、窗口起止、受审本包打包器源码SHA-256、全部已钉定前端模板相对路径及原始字节SHA-256。记录精确定义、字段顺序、路径排序、UTF-8编码。排除口令/口令摘要、用户标识、planDigest、绝对路径、当前时间、随机数；不得把含秘密的plan或配置整对象序列化。模板哈希取注入前字节，避免buildId自引用；实际生成文件哈希继续由manifest覆盖。

同输入build/prepare产生同标识和相同字节；轮次/任一受审前端模板或打包器版本改变导致标识改变。计划中不接受用户自报buildId或证据豁免字段。通过唯一锚点注入前端config，manifest新增明确的previewEvidenceSchema/previewBuildId；checkDir及checkPreparedDir从受审来源重建并严格比较（缺失/未知/伪造/配置与清单不一致拒绝），不信任清单自报值。来源PINNED同步。关闭包来源、制品、23文件和独立检查不变。

### 2.2 手机提交轮次（提交之后保留）

client构造将交给wx.cloud.callFunction的同一个payload后、紧邻调用前，从payload.picRequest.checkRoundId采集不可变字符串快照。不能在响应后重读配置来冒充提交值，不能从result.checkRoundId回填。快照固定字段：schema=participant-identity-local-request/1、previewBuildId、requestRoundId、requestProtocol、functionName、handoffAttempted。仅保存这些经严格格式校验的公共字符串与布尔；绝不复制payload/event/request或保存passphrase、用户ID、OPENID/UNIONID、身份、token、附带字段、原始异常。

requestRoundId格式沿用打包器4–64位轮次约束；buildId为64hex，请求协议/函数为固定值。读取已构造的本客户端payload，不读取未知传输字段/getter。冻结或等价逐字段脱离引用，迟到响应/后续配置变动不得改写已捕获快照。handoffAttempted只表示程序已走到调用SDK这一句，不是网络送达、云函数收到或数据库已读取证明；同步抛错也保留“尝试交给SDK”。

建议本包内部client返回本地封套{response,localRequestEvidence,transportOutcome}，与云函数result严格分开：response仍是未改服务端结果；transportOutcome固定returned/failed，失败不带原始错误。调用SDK前本地参数验证失败不生成已尝试快照。Page对应改用封套，不让服务端同名字段覆盖localRequestEvidence。若实现选择等效独立回调，须证明回调异常零发送、不会把外部可变引用交给payload；不要新增全局lastRequest共享状态。

页面显示“提交轮次（本机调用记录）”；返回失败/超时/同步抛错时仍保留可用的本地快照；结果区域显示原失败事实，不伪造serverTime或身份结果。复用原单击单发、在途锁、finally口令清除；不自动重发，不因证据错误补第二次请求。无需新增时间戳，避免混淆设备时钟与服务器时钟。

### 2.3 服务器返回轮次

把原“核验轮次”明确标为“服务端返回轮次”，保留原response.checkRoundId及失败事实。展示前仅接受合法轮次字符串；非法/缺失显示未取得，不回显任意输入文本，不降级采信服务端伪造localRequestEvidence。不修改既有错误码/identityConfirmed/registrationState/readAttempted/userId逻辑；缺少服务器结果仍为未知。

服务器核心、入口、适配器和REQUEST_FIELDS完全不变；picRequest内层仍仅原schema+四字段。previewBuildId/localRequestEvidence绝不放入网络payload。keyDiagnostic保持false。

## 3. 如何使用与解释（后续才可能真机）

1. 新包批准后手动导入预览；2号扫码进入页面但不提交。负责人对照执行页核对手机预览版本和本机配置轮次。相符再进入已授权一次核验流程；不符即停，不拿旧口令“试一下”。这一步无业务网络调用，也不增加本人读取次数。
2. 本人提交一次后停止；先关闭回读，随后取含上述三栏的截图，完整内部编号继续由本人自愿勾选后当面交付，截图遮挡。口令永不入截图证据。
3. 预览版本/配置轮次不符只能说明手机展示版本与预期不一致，不能直接归因缓存。提交轮次与返回轮次不符只定位不同，不取消轮次校验。
4. 三栏均匹配但服务端仍报ROUND_MISMATCH时，仅说明“本机交给SDK前的快照与响应配置相符”；实际平台入站仍未证实。届时另作最小方案审查，不能本轮偷偷增加服务端回显、查日志或扩白名单。
5. 同时传输失败/缺返回：保留本机快照但不声称云端收到。此证据不是身份/P登记证明，不记录完整内部编号交付成功。

## 4. 允许修改及保护

允许：本核验包打包器、前端config/client/Page(js/wxml及必要样式)、本包相关测试、必要新本地证据、操作说明/状态/进展/交接。以少量改动实现，不重构无关组件。
保护：核心participant-identity-check.cjs、server入口模板/request-adapter/package.json、miniapp源业务/cloudfunctions/vendor、P/E/X/管理员/P4/凭据链、旧生成器、原项目配置、关闭来源、冻结包、历史脚本/JSON、Codex报告与反例。源码未改范围须逐文件blob核对。原测试不删除，受影响的前端返回契约测试应明确迁移。

如摘要变化需要新审计/收尾脚本，另用下一可用版本名，不改旧脚本适配当前树，不照搬未经核对的版本号。新manifest元数据的兼容策略应明示：本包新字段必需，旧冻结包仍用其原版本校验；不修改旧计划或证据使其通过新检查。

## 5. 必须实证的验收矩阵

A. 确定性标识：同输入重复/prepare与build字节一致；轮次变化/前端源码变化有敏感性（受审源码漂移先拒绝，合法新基线内存夹具另证明标识变化）；注入不循环；不包含任何秘密及私密摘要。manifest/config/标识错值、缺字段、来源漂移均拒绝且写前零产物。
B. 实际生成App→Page→client→合成wx边界：加载/前台零发送且版本/配置轮次可见；唯一提交时捕获的requestRoundId与传给wx的同一payload值精确相等。网络payload键集无新增；只读原server/adapter/core实际链继续通过。
C. 两份不同轮次/版本的生成包：旧前端请求对新服务端，仍ROUND_MISMATCH/UNKNOWN/readAttempted=false，collection/get=0（SDK工厂可能已构造，必须按实际计数分述）；页面同时显示旧请求轮次+新返回轮次，不能被响应覆盖。正向同轮仍按既有ACTIVE/ABSENT语义。
D. 响应含伪造localRequestEvidence/previewBuildId、恶意/超长返回轮次、秘密字符串；客户端不采信覆盖本机证据、不泄漏。采样后配置或响应改变，证据仍是实际交给SDK前捕获值。
E. 同步抛错/异步reject/缺result均保留真实本机调用事实、口令清除、无自动重试；前置拒绝无假发送事实。完整ID默认不勾选、取消即时清空、重新勾选未提交不恢复，单击单发/在途锁保持。
F. 门槛回归：错轮次/口令/可信身份目标/到期均保留拒绝；零业务写；关闭23文件/8服务端字节不变且无新证据能力，NaN/过期下独立关闭校验保持。仅必要本包及business-test-package回归，不扩大无关失败。
G. 新证据默认stdout、--out不存在路径wx新建；来源运行时摘要/审查依据分列，离线守卫覆盖初始化和业务阶段，除明确探针外全部命中（含被catch）计意外并使ok/exit失败；有真实失败出口敏感性。需要子进程沿用已受审私有runner与回执核验，不自行放开进程API。披露合成wx/db与真实平台未验证。

## 6. 文档与Git交付

只用合成窗口/口令/身份，无真实包/批准、预览、凭据或云端活动。操作说明解释三种轮次/版本证据边界；更新当前状态，进展/CodeBuddy交接字节安全前缀并证明旧blob完整后缀。沿用master保存一次本地提交（Codex <codex@localhost>仓库级），不重置/清理/改历史。逐文件暂存凭据扫描，artifacts、依赖、原截图、私密编号/口令不入Git。

报告提交号/父提交、改动范围、实测数字和矩阵证据、保护字节、工作区状态；注明“本地自测通过待Codex复查，真实执行未放行”，然后停止。1号2号不重试，P不开展。不得联网安装、取凭据/认证缓存、查云日志、预览/上传/部署/真实调用、登记/写库/授角色/建资源/改权限费用/清缓存。复查通过才决定是否提出新真机具体包，且须用户确认。
