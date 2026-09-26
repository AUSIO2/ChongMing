# 自动化验证

测试按源码归属组织：`backend/modules` 对应业务规则，`backend/adapters` 对应HTTP/存储/消息，`backend/execution` 对应Host/DSH，`apps` 对应桌面/CLI/配置；`client`、`contracts`、`platform` 对应各自共享模块。`backend/fixtures`和`fixtures`保留跨测试共用夹具。

- npm run test:local：SQLite/进程内通知的事务、崩溃重开、真实DSH、暂停续跑和文件导入；无需Mongo/Rabbit/Docker。
- npm run test:boundaries：模块依赖与本机/协作入口隔离；npm test/build:check自动执行。
- npm run test:faults：进程终端、关闭时限、日志脱敏、HTTP/IPC、Host/MQ与客户端恢复故障专项。
- npm test：启动隔离RabbitMQ并运行当前架构的全部测试，结束后清理。
- npm run test:map：阶段树布局、共享节点、候选与历史意见投影。
- npm run test:run：后端节点闭包、DSH、权限、资产及MQ/SSE。
- npm test -- tests/apps/cli/headless.spec.ts：真实认证CLI读写、幂等、SSE退出及文件传输。
- npm run test:desktop-runtime：准备发行资源，并用所带Node验证SQLite/DSH核查、重启和父IPC断开。
- npm run build:check：类型、Web/桌面构建与打包。
- node develop-docs/064-校验入口.mjs：前端/桌面/CLI不加载执行后端或存储依赖。
- node develop-docs/052-校验契约.mjs：历史接口映射与独立目标契约检查；被删除源码的引用校验冻结审计索引，不代表这些旧文件仍在运行。

tests/backend使用隔离Mongo/RabbitMQ和确定性模型夹具；tests/client验证客户端合同、状态和真实端到端闭环；tests/apps/desktop只保留当前preload/IPC和凭据存储测试；tests/apps/cli验证当前CLI进程。

064删除旧Mapper、AgentLoop和旧UI时同步移除了这些已删除实现的专属测试。新架构的阶段树、共享数据、取消/暂停围栏、DSH恢复、管理和文件回归均保留。测试总数减少来自旧实现退役，不将历史测试数作为当前覆盖率指标。
