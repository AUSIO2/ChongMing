# 自动化验证

本地模式专项见 `tests/backend/modules/graph/local-coordination.spec.ts`：无客户端租约的 HTTP 编辑/运行控制、旧版本拒绝、同范围 Run 竞争、运行根删除保护及旧本机租约兼容。SQLite/DSH 审核闭环与桌面发行运行检查直接省略 lease/control；session 回归验证本机不发送领取命令、不启动续租定时器。协作模式仍验收缺凭证拒绝。

测试按源码归属组织：`backend/modules` 对应业务规则，`backend/adapters` 对应HTTP/存储/消息，`backend/execution` 对应Host/DSH，`apps` 对应桌面/CLI/配置；`client`、`contracts`、`platform` 对应各自共享模块。`backend/fixtures`和`fixtures`保留跨测试共用夹具。

- npm run test:local：SQLite/进程内通知的事务、崩溃重开、Agent Work 并发、暂停续跑、显式迁移和 v4 文件导入；无需Mongo/Rabbit/Docker。
- npm run test:boundaries：模块依赖与本机/协作入口隔离；npm test/build:check自动执行。
- npm run test:faults：进程终端、关闭时限、日志脱敏、HTTP/IPC、Host/MQ与客户端恢复故障专项。
- npm test：启动隔离RabbitMQ并运行当前架构的全部测试，结束后清理。
- npm run test:map：注册类型名称/摘要、successor/reference 布局、转换选择与通用阶段进度。
- npm run test:run：定义发布与冻结、有限计划、Agent Work、Host 1..64 槽、权限、v4 资产包及MQ/SSE。
- npm test -- tests/apps/cli/headless.spec.ts：真实认证CLI读写、幂等、SSE退出及文件传输。
- npm run test:desktop-runtime：准备发行资源，并用所带Node验证SQLite/DSH核查、重启和父IPC断开。
- npm run build:check：类型、Web/桌面构建与打包。
- node develop-docs/064-校验入口.mjs：前端/桌面/CLI不加载执行后端或存储依赖。
- node develop-docs/052-校验契约.mjs：历史接口映射与独立目标契约检查；被删除源码的引用校验冻结审计索引，不代表这些旧文件仍在运行。

tests/backend使用隔离Mongo/RabbitMQ和确定性模型夹具；tests/client验证通用节点信封、定义目录、UI状态和真实DSH端到端闭环；tests/apps/desktop只保留当前preload/IPC、凭据存储和本机多槽关闭测试；tests/apps/cli验证当前CLI进程。

077 已有回归覆盖：不可变定义包和负例、默认及自定义转换、候选引用原子发布、同 Host 有界并发、RabbitMQ/进程内传输排空、真实 DSH 目录与会话隔离、通用 UI、v4 bundle 及 Mongo/SQLite 显式迁移。分支回归另覆盖 `branch.get`、`GraphBranchProof`、同分支旧版本冲突、不相交分支重放不丢更新、新根 `expectedVersion: null`、拓扑与 payload node reference 影响范围、快照/proof 配对，以及 Run 启动后关系变化使 Work 失效和正式产物推进 scope；整图 revision 仅作为存储 CAS 和快照顺序验证。

独占回归覆盖同根、祖先/子分支和共享后继冲突，不相交分支并行，领取/续租/释放、接管与旧 fence 拒绝，续租和内容写入竞态，以及编辑租约转换为 Run 占有。Run 回归覆盖控制权接管、续租与暂停竞态、终态清理，以及两个不相交分支并发 `run.start` 后同时保留、分别领取 Work、暂停其中一个不影响另一个。旧单 `run` 通用文档必须经显式迁移为 `runs[]`。

064删除旧Mapper、AgentLoop和旧UI时同步移除了这些已删除实现的专属测试。新架构的阶段树、共享数据、取消/暂停围栏、DSH恢复、管理和文件回归均保留。测试总数减少来自旧实现退役，不将历史测试数作为当前覆盖率指标。
