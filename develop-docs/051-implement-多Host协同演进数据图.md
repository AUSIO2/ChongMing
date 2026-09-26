# 051 — 多 Host 协同演进数据图实施原稿

设计：[051 多 Host](./051-多Host协同演进数据图.md)。054 已完成角色工作租约基线；059 在现有实现上补齐节点驱动闭环和暂停，执行顺序见 [059 实施原稿](./059-implement-节点驱动协作闭环与暂停恢复.md)。以下是整体目标与待补检查，不声称均已实现。

## 1. 先验证最危险的边界

在 Mongo 副本集和两个独立 Host 进程上验证：

1. 同一 Map 中两个业务项可以分别被不同 Host 领取并并行计算。
2. 两个 Host 抢同一项只有一个有效持有者。
3. 租约过期后 B 接管；暂停后恢复的 A 不能续租、提交报告或写最终结果。
4. 结果、边、收据、后继项与 operation 完成一次提交；响应丢失后结果不重复。
5. 同一图的并行提交不覆盖其他操作的租约/报告。
6. 取消先写成功后，任何 Host 都不能接受新结果。

先用确定性假执行器验证数据库协议，再连接真实 DSH。假执行器只用于测试，不进入生产 Runtime 抽象。

## 2. 数据与领取

- Run 使用 scope.nodeIds/until/operations[] 和独立 paused；operation 有 inputRefs/outputRefs、配置指纹、业务草稿/Review。
- 沿用独立 lease 容器中的 workId/operationId/hostId/holderId/expiresAt/fence；不把本地 Session 绑定放进业务身份。
- 领取/续租使用数据库时间及当前状态条件，使用 majority 写确认。
- 业务聚合提交用最新 Map revision CAS；租约仅定向更新，禁止普通提交回写旧 lease 容器。
- 纯续租不推进业务 revision，用户可见状态和数据变化推进。
- 扩展现有 work/Host 循环，不新增 claim.ts、调度器或队列；无可领取项时沿用轮询间隔。
- 控制状态、输入版本、Review 版本、幂等收据和 lease 围栏同路径校验。

## 3. DSH 与业务继续

- 未提交工作每次重新领取使用新本地 Session，不要求原会话、模型上下文或 token 级恢复。
- 每次 DSH 执行只承担绑定的节点/角色工作；保留 split/verify 内部 router、角度报告与 merge。
- 工具调用捕获 holder/fence，禁止迟到调用冒用后来的执行授权。
- 接管从共享报告/决定继续，新的 holder/fence 不改变业务幂等 key。
- Review 属于 operation；一项等待不阻止其他独立项。回答保存业务决定，不清 paused；未暂停时新工作由任意 Host 领取。
- 新产物与后继操作尽量同次提交；周期按规则补查缺失操作。
- Run 完成以同一 revision 下重算 scope/until 为准。
- 不可继续的失败与 Run.failed 同次提交；显式重试建新 Run，复用有效报告/收据，不复活旧执行授权。
- 保留活跃 Run（包括暂停）期间普通图编辑/删除/覆盖限制；Review 只改候选。
- pause 在现有权限事务内设置 paused/revision/收据并定向过期该 Run lease，保留 fence；resume 同 Run 重算业务，不增加执行 epoch。

## 4. API、资产与部署

- 各 API Host 读取同一个 DB 权限和业务状态。
- Mongo Change Streams 接入各 Host 的 SSE；重连恢复完整基线。
- 配置 Host 地址映射，代理当前 owner 的 Activity；以 fence 丢弃旧流。
- GridFS 上传完成后发布 assetId，所有 Host 通过相同引用读取；保留内容摘要。
- 生产 Mongo 副本集，验证 majority 提交与 primary 故障切换行为。
- Host 停止时先停止领取、停止执行并 flush，再释放租约；失联则等待租约自然失效。
- 不要求跨机搬运 DSH 私有会话文件。

## 5. 补充故障矩阵

| 情形 | 必须观察到的行为 |
|---|---|
| 旧 owner 阻塞超过 lease | 被新 owner 接管后，所有旧写入失败 |
| DB 接受结果但 Host 未收到响应 | 用原收据确认，节点/边不重复 |
| Host B 完成不相关节点 | Host A 可以重新校验后提交已有结果，无需重算 |
| 运行中尝试普通图编辑 | 入口明确拒绝；Review 修改后旧草稿批准不能复用 |
| 同时产生新 Claim 与尝试结束 Run | 有后继工作时不能 completed |
| Review 发布后原 owner 崩溃 | 任意 API Host 接受回答，另一执行 Host 能继续 |
| 取消与完成/续租/提交竞争 | 以原子写入顺序裁决；取消后无新接受结果 |
| 仅 DB 通知或 Activity 流断开 | 重建业务快照，不丢持久结果 |
| primary 切换 | 已 majority 接受结果保留；不确定结果查收据后处理 |
| 同 Host 两个进程 | holderId 区分，旧进程不得因同 hostId 获得新授权 |
| 一个操作不可继续失败 | Run 同时 failed，其余 Host 的新写入被围栏拒绝 |
| 失败后显式重试 | 新 Run 仅复用已证明输入/输出版本与配置仍有效的业务成果，旧授权不复活 |
| 快速 pause→resume | 旧 grant 续租/提案/fail 全被拒绝；新领取递增 fence |
| pause 与新 claim/renew 并发 | 权限事务冲突重试，不遗漏需要失效的租约 |
| 多篇新闻与空拆分结果 | 独立 operation 可并行，零结果有收据且不会无限拆分 |

全量功能回归继续按 050 实施原稿执行。这里不增加 P2P 同步、CRDT、独立调度服务或会话存储改造。
