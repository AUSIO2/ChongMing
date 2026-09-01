# Mapper 断点续跑与项目清理

## 目标

在不引入第二套 checkpoint 框架的前提下，让 Mapper 成为运行恢复的唯一所有者：LangGraph 只执行一次 AgentCall，Mapper 持久化调用计划、状态和结果。允许删除旧结构，不做数据兼容。

## 根因

当前 `MapperRun.draft.calls` 只记录整批成功后的结果。split/verify worker 使用 `Promise.all`，进程在部分 worker 完成后退出时，已完成结果没有进入数据库。当前 write lease 只使用安装级 clientId，同一安装启动两个进程时也不能区分真正的锁持有者。

## 最小设计

`MapperRun.draft.calls` 改为调用账本。每条记录包含完整 `AgentCall`、角色、实例、状态、尝试次数、时间、结果或错误。Mapper 遵循四个动作：

1. plan：在调用 AgentLoop 前一次性持久化稳定 callId 和输入。
2. start：将待执行调用标为 running 并落库。
3. complete/fail：每个调用独立完成后立即串行落库。
4. resume：接管陈旧运行时把 running 重置为 pending，跳过 completed，再执行 pending/failed。

并行仅发生在 AgentLoop 调用；同一 map 的 checkpoint 写入串行化，继续使用文档 revision 做乐观并发控制。业务 save 保持幂等，完成后删除 `run`，不增加历史执行集合。

## 分层边界

- Renderer：仍只使用 `read / dispatch / watch`，不理解 checkpoint。
- Mapper：规划调用、落 checkpoint、恢复、重试、HITL 和领域数据保存。
- AgentLoop：保持 `run(call, options)` 与 `close()`，不读取数据库。

## 恢复语义

- 进程级 leaseId 与安装级 holderId 一起识别所有权。
- 新进程成功接管 lease 后，若数据库存在 `running` run，则标记为 `interrupted/restart`。
- `running` 调用恢复成 `pending`；`completed` 调用保留并跳过。
- Agent 外部副作用采用 at-least-once 语义；稳定 callId 供下层做幂等。
- cancelled 是用户终态，不自动恢复；error 可由 `run.continue` 显式重试。

## 验收

- worker 部分完成后模拟重启，已完成调用不重复。
- 多 worker 乱序完成，结果全部保存且领域输出顺序稳定。
- 活跃 lease 不可接管，过期 lease 可接管并产生 restart interruption。
- HITL、取消、错误重试与幂等保存均有回归测试。
- 类型检查、全部测试与生产构建通过。
