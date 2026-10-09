# schedules 索引控制台人工补证

接收日期：2026-10-09（北京时间）。来源：用户本人操作控制台后提交的两张截图；Codex只核对图片，未操作同一控制台。截图没有精确采集时间或完整环境ID，只显示环境别名 cloud1，不单独用来证明环境身份；此前API身份环境关联证据仍独立保留。

## 观察

选中集合为 `schtest_v1_schedules`。两图合并覆盖以下5个自定义索引，均显示非唯一、8.00KB、命中次数0，字段均升序：

| 名称 | 顺序 |
| --- | --- |
| project_status_trade_created_id | projectId / status / trade / createdAt / _id |
| project_status_created_id | projectId / status / createdAt / _id |
| project_created_id | projectId / createdAt / _id |
| project_worker_status_id | projectId / workerUserId / status / _id |
| project_trade_created_id | projectId / trade / createdAt / _id |

同时可见默认 `_id_`（4.00KB）和 `_openid_1`（8.00KB）。截图中的5个自定义索引规格与已批准清单相符。

可见表头为名称、属性、字段、占用空间、命中次数、操作，**没有明确的就绪/构建中状态列或标记**。索引大小、可删除按钮、命中0均不单独证明READY，也不说明故障。两图只覆盖这个集合，不覆盖其余8个自定义索引；其余规格仍依据已保存的API回读。

## 结论与接续

- 本次截图核对通过：5个自定义索引及2个默认索引已显示，规格一致。
- 显式平台就绪状态仍未确认；不继续要求用户在同一无状态页面反复截图，也不重建索引或修改业务代码。
- 下一项有意义的验证是按真实业务过滤与排序做有界只读查询。届时应分别记录“空集合查询成功”“是否有索引命中/执行计划证据”；不能把空结果成功直接提升为13索引全部命中、性能通过或唯一约束写入已验证。查询方案/执行本轮均未完成。
- SDK对固定primary主键的读取已在前轮真实成功并返回NOT_FOUND，保留该结论，不重复相同请求。本轮没有任何云请求、资源修改、初始化、部署、启用或收费操作。

## 原图留存

- [上半截图](用户截图-schedules索引上半-20261009.png)，SHA-256 `d3fb95429c86efd3cbe496e8dbc56fbbeebf6046253c5402aecc75acfd8c80f1`。
- [下半截图](用户截图-schedules索引下半-20261009.png)，SHA-256 `4a4cbcb05e72c79785f0a765877e6ee312d20e84a4256aad8216d7c58a3eaebc`。

原图逐字节复制归档，没有编辑图片或改写旧证据。
