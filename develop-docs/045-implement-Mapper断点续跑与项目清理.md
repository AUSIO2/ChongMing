# Implement Plan：Mapper 断点续跑与项目清理

1. 清理空目录、旧迁移/调试脚本、模板文件和构建产物。
2. 将 `MapperDraftCall` 替换为带状态的 `MapperCallRecord`，更新 Mongo schema。
3. write lease 增加进程级 leaseId，所有 acquire/heartbeat/release/assert 条件同时校验 holderId 与 leaseId。
4. 在 Mapper service 实现 `callPlan / callRun / callCheckpoint / runRecover`：调用可并发，checkpoint 串行写入。
5. parse/split/verify stage 只构造调用计划并使用 Mapper 提供的 executeCalls，不直接依赖 AgentLoop。
6. lease 接管时恢复陈旧 running run；continue 支持 restart 与 error 重试，保留人工 gate 行为。
7. 增加部分完成、乱序并发、进程锁接管、取消和幂等保存测试。
8. 更新 README 与 coding.md，执行 typecheck、全量测试和构建。
