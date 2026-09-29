# 077 — 分支编辑保护与 Agent 级分布式执行实施状态

设计：[分支编辑保护与 Agent 级分布式执行](./077-分支独占与分布式协作.md)。

当前状态：A0 通用定义、A Agent 级执行、分支内容版本、独占编辑租约、同图多 Run、Run 范围占有与控制租约，以及 G 中的 v4 数据包/显式迁移已经落地并通过真实 DSH、Mongo、SQLite、RabbitMQ、进程内传输及客户端回归。`branch.*`、`run.control.*`、`runs[]`、按 runId 的 Work/活动/审核、最终存储 guard、占有 SSE 和客户端选择均已接通。

已确认约束：调度继续使用自有 Work＋RabbitMQ／本机通知，底层 DSH 保留。本轮完善数据与执行协议，不接入外部调度器。精确字段、发布事务和迁移语义以 [077 数据定义协议](./077-数据定义协议.md) 为准。

## 落地状态

本地入口已明确采用 `clientLeases: none`：编辑、启动及 Run 控制/审核无需 lease/control，UI 不显示领取按钮、不发客户端心跳。协作默认 required，由服务器决定，无法通过请求参数关闭。两种模式均保留分支版本和运行范围保护；内部 Work 授权仍由系统维护。旧本机 editor/control 记录不再约束或显示给本机用户。

| 阶段 | 状态 | 当前结果 |
|---|---|---|
| A0 注册数据类型与转换 | 已完成 | 精确版本定义包、受限 draft-07、definition.get/publish、冻结 ExecutionSpec、默认事实核查包和通用 DSH 合同已接通 |
| A Agent Work 与 Host 容量 | 已完成 | Work 是单次 Agent 阶段；Host concurrency 1..64；RabbitMQ/进程内通知有界并发、逐项租约与排空已接通 |
| B 合同中的通用节点/Operation | 已完成当前范围 | 通用节点、有限 plan、`runs[]`、分支与 Run 控制 proof/grant/ownership、ownershipRevision 已完成 |
| C 分支范围与业务动作 | 已完成当前范围 | scope/version/影响计算、领取/续租/释放、修改后冲突检查、graph.apply 最终租约 guard 和 Run 占有转换已接入 |
| D 存储协调 | 已完成当前范围 | Mongo/SQLite 按 runId 领取、续租和最终提交；不相交 Run 的整文档 CAS 竞争由服务层重读重放 |
| E HTTP、消息与 SSE | 已完成当前范围 | branch.get/claim/renew/release、proof/lease HTTP/client 协议及同内容 revision 的占有基线 SSE 已接通 |
| F 客户端 | 已完成当前范围 | 每窗口 holder、编辑/控制租约、占用只读、Run 选择器、按 runId 控制审核及不相交范围启动已接通 |
| G 资产与迁移 | 已完成当前范围 | v4 包含定义/Agent 依赖闭包；Mongo 与 SQLite 提供显式 dry-run/apply 通用数据迁移，不自动启动 |

### 后续实施顺序

注册定义、Host 多槽、分支摘要、编辑租约和 Run 范围占有已经完成。后续按以下顺序推进：

1. 增加持有期间的原子范围扩充动作；当前一次 claim 已支持多根，拓扑写入可扩大原根的后继闭包，但不能把另一组根事后拼入同一租约。
2. 在实际生产基础设施上补充两个 API 与 Mongo/RabbitMQ 主切换验收。

以上属于增强与部署验收；当前代码路径已经具备不相交分支的多 Run 并发。

## 文件与函数清单

以下保留原文件/函数清单作为实现追踪。完成状态以上表为准。租约控制直接进入 `client-session.ts`，没有另建 `client/branch-lease.ts`；后者继续保留为未来抽取选择，不是缺失能力的标志。

分为 A0（注册类型与转换）、A（统一 Agent 执行）和 B–G（分支保护、多 Run 及完整接线）。A0/A、分支独占、Run 范围/控制租约与同图多 Run 已经验收。沿用 GraphWork，不新增 AgentTask 队列、持久化执行槽表或另一个调度器。

### A0. 注册数据类型与转换定义

| 文件 | 状态、函数或类型 | 要实现的职责 |
|---|---|---|
| `contracts/data-definition.ts`（新文件） | 新增 `DefinitionRef`、`DataTypeDefinition`、`TransitionDefinition`、`ExecutionSpec`、`Cardinality`、`DefinitionPackage` | 开放 typeId 与确切 version；draft-07 受限字段 schema；输入/上下文/输出端口、基数、successorOf、封闭组、Agent 阶段及结果合同；类型引用和数据实例引用严格区分。 |
| `backend/modules/shared/data-definition.ts`（新文件） | 新增 `definitionsValidateCatalog()`、`definitionsReadType()`、`definitionsReadTransition()`、`definitionsValidatePayload()`、`definitionsFreezeExecution()` | 共享定义完整性、引用一致性和 payload 校验；冻结实际使用的类型/转换/Agent 绑定，不读取可变最新配置执行旧 Run。由已有业务入口调用，不新增并行调度服务。 |
| `resources/data-definitions/fact-checking.json`（新增资源） | 默认类型与转换声明 | 把现有来源、新闻、事实、意见、结论等字段、后继许可、评分、提示词变量映射和显示信息移为默认定义。意见节点化与历史数据迁移同步设计。 |
| [apps/config/default-prompts.ts](../apps/config/default-prompts.ts)、[apps/graph-server/application.ts](../apps/graph-server/application.ts)、[apps/local-server/application.ts](../apps/local-server/application.ts) | 修改现有默认配置装配函数，增加定义包装配 | apps 加载默认资源并注入初始化；业务模块不读取 resources 路径。只在显式初始化/导入时发布，不自动覆盖已有工作区。 |
| [backend/modules/workspace/workspace-service.ts](../backend/modules/workspace/workspace-service.ts) | 修改 `controlCreateService()` → `initialize()`、`configuration()`、`read()`、`dispatch()` | 管理工作区定义和不可变发布版本；读取/发布由现有权限事务保护，Run 配置包含精确引用。 |
| 同上 | 新增私有 `controlReadDefinitions()`、`controlPublishDefinitions()`；修改 `read()` 的 app.bootstrap 分支 | 接入 definition.get/publish；Owner 发布整包和依赖验证、workspace revision CAS、收据及通知同事务。bootstrap 返回通用引擎能力和定义目录入口，不再固定核查类型、评分和变量。 |
| [backend/modules/workspace/workspace-input.ts](../backend/modules/workspace/workspace-input.ts)、[contracts/control.ts](../contracts/control.ts) | 修改 `controlReadKind()`、`controlReadAgent()`、`controlReadQuery()`、`controlReadCommand()`；替换 `CONTROL_PROMPT_KINDS`、`CONTROL_PROMPT_VARIABLES`、`PromptKind` 的业务硬编码 | 管理入口接受注册绑定与受支持的通用角色；严格解析 definition.get/publish。仅修改执行期 agent-configuration 不足以让用户创建新业务 Agent。 |
| [backend/modules/workspace/agent-configuration.ts](../backend/modules/workspace/agent-configuration.ts) | 修改 `configurationReadProfile()`、`configurationRead()` | 校验通用 Agent 与转换绑定；claimCategory 等业务约束迁为默认定义的字段/输出约束。 |
| [contracts/control.ts](../contracts/control.ts)、[contracts/client.ts](../contracts/client.ts) | 修改控制查询/命令及输入输出映射 | 定义读取、显式发布/导入沿用公共客户端，支持 CLI 配置；首版不要求可视化流程编辑器。 |
| [backend/execution/dsh/work-executor.ts](../backend/execution/dsh/work-executor.ts) | 修改 `dshReadWork()`、`dshReadWorkProfile()`、`dshRunWork()` | 按冻结 executionSpec 选择 Agent 和输入，移除 parse/split/verify 对目标类型的映射，向可信 patch 下发相同输出定义。 |
| [backend/execution/dsh/prompt-renderer.ts](../backend/execution/dsh/prompt-renderer.ts) | 修改 `promptReadWork()` | 按声明的输入投影和变量绑定渲染；旧 claimContent/opinions 属于默认包，未知阶段不回落为核查。 |
| [backend/execution/dsh/dsh-business-plugin.mjs](../backend/execution/dsh/dsh-business-plugin.mjs) | 修改 `apply()`、`businessReadData()` 和 data_propose 的 execute/schema 构造 | 由可信冻结定义构造受限参数，移除 news/claims/score 拼装；保留根 Agent、工具权限和服务器二次校验。不能只改 TS 而漏掉直接加载的 MJS。 |
| [backend/modules/graph/run-state.ts](../backend/modules/graph/run-state.ts)、[work-state.ts](../backend/modules/graph/work-state.ts) | 修改 `runReadConfiguration()`、`runUpdateProgress()`、`runCreateOutputs()`、`runReadData()`、`runUpdateProposal()`、`runCanReuse()`、`workReadItems()` | 按选定转换、冻结输入组和明确阶段建立 Work/产物；后继许可和基数不直接派发全部允许类型。 |
| [backend/adapters/http/graph-http-server.ts](../backend/adapters/http/graph-http-server.ts) | 替换 `apiReadUntil()` 的固定终点解析；修改 `apiReadOutputs()`、`apiReadDataProposal()` | 接受目标类型/转换引用和通用产物信封，字段按授权 Operation 的冻结定义验证，不接受模型自行提交 schema 授权。 |

schema 支持范围、输入齐备和 DSH 合同已在数据定义协议中明确。新增私有 `definitionsValidatePorts()`、`definitionsValidateStages()`、`definitionsCompileOutputContract()`，由完整发布校验/执行规格冻结调用，统一检查数量、精确引用、阶段依赖和工具参数可表达性；不要求 application 按顺序逐项调用这些函数。新资源须纳入桌面打包检查。

### A. Agent 工作与 Host 执行容量

| 文件 | 状态、函数或类型 | 要实现的职责 |
|---|---|---|
| [backend/execution/host-worker.ts](../backend/execution/host-worker.ts) | 修改 `HostInput`；新增类型 `HostExecutionEvent` | 增加 `concurrency`，默认 1；事件包装包含 hostId/executionSlotId/workId/holderId/fence。Host 事件回调与单会话 DSH 回调分开定义。 |
| 同上 | 修改 `hostCreateWorker()` | 校验正整数容量和上限，持有有限执行槽及在途 Work 索引；不按 agentId 限制独立任务。 |
| 同上 | 修改私有 `hostRunQueue()`、`hostRunNotice()` | 向传输传容量；按投递取得空闲槽，每次领取使用独立 holderId；合并本 Host 重复工作唤醒，清理结束后才归还槽位。 |
| 同上 | 修改私有 `hostRunWork()` | 保持逐 Work 的续租、截止、取消、活动及释放；上下文增加执行槽身份。单项失租不停止无关 Work；业务失败仍按所属 Run 的规则处理。 |
| 同上 | 修改私有 `hostReadGrant()` | 后续接入 Run 占有时，核对新增执行授权字段；续租只能延长期限，不能替换任务、角色或执行代次。 |
| 同上 | 修改返回方法 `start()`、`finished()`、`close()` | 关闭或连接失效时停止新工作，等待所有尝试完成 DSH 清理和释放，再退出或重连；结束状态包含全部在途任务。 |
| [backend/ports/messaging.ts](../backend/ports/messaging.ts) | 修改 `WorkChannel.consumeWork()`；新增类型 `WorkConsumeOptions` | 明确 `consumeWork(handler, stop?, options?: { concurrency?: number })` 的有界投递和全部排空契约；默认容量 1。第二个消费者是否允许由 adapter 原有约束决定。 |
| [backend/adapters/messaging/rabbitmq.ts](../backend/adapters/messaging/rabbitmq.ts) | 修改 `queueOpen()` → `consumeWork()`、私有 `close()` | 按容量设置 prefetch，以在途 Promise 集合替换单个 task；每条消息独立 ACK/NACK，停止时等待全部处理器，任一清理失败也不能漏等其他任务。 |
| [backend/adapters/messaging/in-process.ts](../backend/adapters/messaging/in-process.ts) | 修改 `localCreateMessaging()` → `queue.consumeWork()`、`queue.publishWork()`、私有 `close()` | 一个本机消费者内部有界并发；协调 pending/in-flight 去重、容量唤醒及重试；close 等全部任务完成。继续拒绝第二个本机 Host 消费者。 |
| [backend/execution/dsh/work-executor.ts](../backend/execution/dsh/work-executor.ts) | 修改 `dshRunWork()`、私有 `dshCloseWork()` | 每次尝试隔离可写运行目录、补丁和会话；配置和只读资源显式共享；先关闭 DSH 再清理临时目录，不让并行尝试删除彼此资源。 |
| 同上 | 适配私有 `dshReadWork()`、`dshReadWorkStatus()` | 新协议下继续核对输入与提交状态属于同一 Work/Run/角色；不因 Host 多槽而共用可变 grant。 |
| [apps/execution-host/main.ts](../apps/execution-host/main.ts) | 修改 `hostStartProcess()` | 读取 `--concurrency` / `CHONGMING_HOST_CONCURRENCY`，传入 Host；启动日志报告实际容量。 |
| [apps/local-server/main.ts](../apps/local-server/main.ts)、[apps/local-server/runtime.ts](../apps/local-server/runtime.ts) | 修改 `localStartProcess()`、`localCreateRuntime()` 的输入及装配 | 本机模式传入相同容量；保持一个 SQLite 服务进程、一个 Host 池；关闭顺序仍为 Host → API/消息 → 存储。 |
| [apps/desktop/local-service-entry.ts](../apps/desktop/local-service-entry.ts) | 修改 `desktopStartService()` | 桌面本机子进程传递同一容量配置；首版沿用环境变量，无须增加设置页面。 |

此阶段复用 [runtime.ts](../backend/execution/dsh/runtime.ts) 的 `dshCreateRuntime()` 和 [activity-reporter.ts](../backend/execution/dsh/activity-reporter.ts) 的 `activityCreateReporter()`，只验证它们的实例隔离及幂等关闭；无新证据时不另造共享 DSH Runtime。现有 `workReadItems()`、`GraphWorkProof` 和工作幂等身份不因增加 Host 容量而更名。

### B. 分支、Run 与事件协议

| 文件 | 状态、类型或常量 | 要实现的职责 |
|---|---|---|
| [contracts/graph.ts](../contracts/graph.ts) | 整理 `GraphNode`、`GraphNodeData`，引用 A0 定义合同 | 实例使用 id/revision/typeId/typeVersion/payload；移除固定业务种类联合和此前计划的静态 GRAPH_DATA_TYPE_DEFINITIONS。业务定义由发布目录解析，实际边另存。 |
| [contracts/graph.ts](../contracts/graph.ts) | 已新增分支/控制 proof/grant/ownership，并将快照改为 `runs[]` | 定义实际闭包、内容版本、holder/fence/期限、编辑/Run 占有和多个 Run 的公共快照。 |
| 同上 | 已修改 `GraphQuery`、`GraphCommand`、`GraphWriteResult` | branch.*、run.control.*、graph.apply/run.start proof/lease、启动返回 runControl 与控制命令 proof 已完成。 |
| 同上 | 已修改 `GraphSnapshot`、`GraphRun`、`GraphOperation`、`GraphWorkGrant`、`GraphDataRead`、`GraphDataProposal`、`GraphDataActor` | 快照使用 `runs[]` 并增加 ownershipRevision/ownerships/runControls；Operation 使用 transitionRef、冻结 executionSpec 与输入依赖。 |
| [backend/modules/graph/graph-record.ts](../backend/modules/graph/graph-record.ts) | 已增加 `runs[]`、branch/run/control 三类记录、占有收据与 ownershipRevision | 活跃及最近终态 Run 在 `runs[]`，启动新 Run 时将既有终态移入 runHistory；旧单 run 明确拒绝并走显式迁移。 |
| [backend/ports/graph-store.ts](../backend/ports/graph-store.ts) | 已新增 `GraphCommitGuard`、`commitOwnership()` 并扩展 `commit()` | 内容写在最终 CAS 中核对 ownershipRevision 与 editor/run/control guard；纯占有写入独立推进 ownershipRevision 和 dispatch.version。 |
| [contracts/events.ts](../contracts/events.ts) | 复用现有 `QueueChange { kind: 'graph' }` | 消息只提示订阅端重读图；完整 snapshot 携带 ownershipRevision/ownerships，由 SSE 独立比较内容与占有序号。 |
| [contracts/client.ts](../contracts/client.ts) | 修改 `PublicQuery`、`PublicCommand`、`QueryOutputMap`、`CommandOutputMap` 及相关输入映射 | 桌面/Web/CLI 使用同一新增协议及响应类型，不为每个端建立不同分支授权合同。 |
| [contracts/messages.ts](../contracts/messages.ts) | 修改 `RuntimeMessage` | 增补分支忙、失租、范围冲突、旧客户端缺少授权、迁移未完成等固定文案；错误 code 与协议校验一起确定。 |

### C. 分支规则与完整业务动作

只新增一个领域文件 `backend/modules/graph/branch-state.ts`。范围计算与纯规则放这里，完整业务动作留在现有 `graphCreateService()`；application 和 UI 不负责拼接“先读锁、再验证、最后写入”。

| 文件 | 状态、函数 | 输入与结果／职责 |
|---|---|---|
| [backend/modules/graph/graph-input.ts](../backend/modules/graph/graph-input.ts)、[graph-service.ts](../backend/modules/graph/graph-service.ts) | 已新增 `graphInputReadNode()` 并接入定义驱动的 payload/successor 校验 | HTTP 解析通用节点信封，服务层从精确版本定义读取后继许可和 schema；不使用固定 kind 白名单。 |
| `backend/modules/graph/branch-state.ts`（新文件） | 已新增 scope/version/mutation 规则 | 按统一 successor 方向计算含根闭包；GraphEdge reference 与声明式 payload node reference 不扩展范围，但进入两端摘要及 before/after 影响校验。 |
| 同上 | 已新增 `branchReadImpact()`、`branchValidateMutation()`、`branchValidateNewRoots()` | 覆盖旧/新边端点、删节点级联、新节点 successor 可达性、多根删除和 null 新根规则。 |
| 同上 | 已新增 `branchReadVersion()`、`branchReadSnapshot()` | 生成根、成员、节点版本及相邻关系的稳定摘要；无关分支不改变版本。 |
| 同上 | 已新增 `branchReadOwnerships()`、`branchFindOwnershipConflict()`、`branchPruneOwnerships()` | 按存储时间过滤过期编辑租约，动态重算每份占有 scope，并检查祖先/子树/共享后继交集；Run 占有不自动过期。 |
| [backend/modules/graph/graph-service.ts](../backend/modules/graph/graph-service.ts) | 已接入 branch.get/claim/renew/release | claim 返回 claimed/busy；renew/release 核对 leaseId/holderId/fence；同 holder 的相同根领取复用租约，接管使用更高 fence。 |
| 同上 | 已修改 `graphCommit()`、`graphUpdateChanges()` 及 graph.apply 路径 | 验证 proof，在最新图应用局部补丁；无关 Map CAS 竞争有界重读重验，不用旧整图覆盖，真实分支变化返回 BRANCH_VERSION_CONFLICT。 |
| 同上 | 已修改 run.start 与全部 Work/Run 写路径 | Run 启动消费编辑租约、建立持久范围占有并原子授予控制；Work 持续核对占有，控制命令核对 control proof，终态释放两者。 |
| 同上 | 已修改 `graphCreateWriteResult()` 与 snapshot | 快照公开 runs、ownershipRevision、ownerships 和 runControls；所有运行命令按明确 runId 路由。 |
| [backend/application/graph-application.ts](../backend/application/graph-application.ts) | 已路由全部 branch 命令并注入 actorUserId 与存储时钟 | branch.get 使用 Viewer 权限，claim/renew/release 使用 Editor 权限；占有与内容写均留在授权事务边界。 |

`branchValidateMutation()` 接收的 before/after 都是服务端当前事务内的图及其局部补丁结果，不是客户端提交的完整快照。graph.apply 在服务入口完成摘要、租约、范围、修改后占有冲突校验和 CAS 重放；调用方不能拆成“先查锁，再自行写入”。

### D. 原子存储与多个 Run

内容 CAS、ownership 独立提交与最终 guard 已完成；下表中的多 Run 项仍为后续目标。

| 文件 | 状态、函数或方法 | 要实现的职责 |
|---|---|---|
| [backend/ports/graph-store.ts](../backend/ports/graph-store.ts) | 已新增 `commitOwnership()` 与 `GraphCommitGuard` | 领取/续租/释放以 ownershipRevision CAS 写入；内容提交在最终条件核对 ownershipRevision 与 editor/run 授权。 |
| [backend/adapters/storage/mongo/graph-store.ts](../backend/adapters/storage/mongo/graph-store.ts) | 已序列化 ownership/receipts 并实现两种 commit | 使用数据库时间与 `$expr` 校验过期、holder/fence 和 runId；普通提交不覆盖并发新租约，纯占有写入不抬升内容 revision。 |
| [backend/adapters/storage/sqlite/graph-store.ts](../backend/adapters/storage/sqlite/graph-store.ts) | 已实现同一 `commitOwnership()`/guard 语义 | 在既有事务内执行相同版本、授权与通知规则，保持 SQLite 单服务进程约束。 |
| [backend/modules/graph/run-state.ts](../backend/modules/graph/run-state.ts) | 已修改 `runReadRun()`、`runReadExecution()`、`runUpdateProgress()` | 显式按 runId/Run 对象工作；一个 Run 的推进和终态不改其他 Run。 |
| 同上 | 修改 `runCreateRun()`、`runCancelRun()`、`runUpdatePause()` | 按范围允许多个 Run；原子建立/释放持久 Run 占有；暂停保留范围但撤销本 Run 的 Work，继续不能复活旧授权。 |
| 同上 | 修改 `runUpdateReview()`、`runAnswerReview()`、`runReadData()`、`runUpdateProposal()`、`runCreateOutputs()` | 审核、读取和产物始终定位对应 Run/Operation；worker 只写自己的报告槽，merge 只接纳其合法完整报告集；新增产物纳入所属范围。 |
| 同上 | 新增私有 `runPlanPublication()`、`runResolveOutputReferences()`；由 `runCreateOutputs()` / `runAnswerReview()` 完整调用 | 实现协议 9.1：冻结候选依赖闭包，稳定分配所有正式 ID，回填声明引用，按全部唯一节点检查端口/总基数，在同一次提交中发布意见和结论。调用方不自行拼装半个发布过程。 |
| 同上 | 新增私有 `runReadInputDependencies()`；修改 `runValidateInputs()`、`runCanReuse()` | 冻结并核对输入节点、依赖边和成员集合；新增 mentions 也能使旧输入失效；历史复用同时核对这些条件。 |
| [backend/modules/graph/work-state.ts](../backend/modules/graph/work-state.ts) | 修改 `workReadItems()`、`workReadGrant()` | 从多个允许执行的 Run 推导 Work；保留按角色/报告槽的工作身份，读取 grant 时确认所属 Run 和执行代次。 |
| [backend/modules/graph/graph-service.ts](../backend/modules/graph/graph-service.ts) | 修改 `dispatchWork()`、`readData()`、`propose()` | 领取、续租、失败和提案按 runId 路由；兄弟 Work 的合法报告不导致整体失效；接受收据仍幂等，输入重算必须是新业务代次。 |
| [backend/modules/graph/work-activity.ts](../backend/modules/graph/work-activity.ts) | 修改 `activityReadRecord()` | 按真实 Work 所属 Run 校验与投影活动，不再只识别唯一当前 Run。 |

原子性由 GraphStore 的 commit guard 承担，领域模块不根据一次读取推导稍后写入必然有效。run.start、终态释放和拓扑范围变化在同一次内容提交中处理占有；暂停保留 Run 占有并撤销当前 Work 租约。

### E. 消息、HTTP、SSE 和公共客户端

branch.get/proof、租约命令、ownership SSE 与公共客户端验证已完成；多 Run 部分仍为后续目标。

| 文件 | 状态、函数 | 要实现的职责 |
|---|---|---|
| [backend/adapters/messaging/mongo-outbox.ts](../backend/adapters/messaging/mongo-outbox.ts) | change stream 监听全部图更新，再由 `readDispatch()` 过滤待发记录 | 纯 ownership 提交也能触发补发；`workReadItems()` 从全部可运行 Run 恢复 Work。 |
| [backend/adapters/messaging/in-process.ts](../backend/adapters/messaging/in-process.ts) | 复用现有 `graph` 刷新提示 | 本机 ownership 提交发出同一图刷新语义，由 SSE 重读完整 snapshot；不另造只含局部租约的事件。 |
| [backend/adapters/messaging/rabbitmq.ts](../backend/adapters/messaging/rabbitmq.ts) | 复用严格校验的 `graph` 变更提示 | 协作模式同样由订阅端重读 snapshot，互斥不依赖通知内容或到达顺序。 |
| [backend/adapters/http/graph-http-server.ts](../backend/adapters/http/graph-http-server.ts) | 已解析 branch/control proof 与六类租约命令 | 空根、重复根、缺 proof/lease/control 和 run.start null version 均在边界拒绝。 |
| 同上 | 修改 `apiReadDataProposal()`、`apiReadWorkProof()`、`apiCreateServer()` | 根据最终 Work 合同补齐请求/头字段校验和路由；身份仍由可信 Host 授权绑定，不让模型自报 holder/fence。 |
| [backend/adapters/http/graph-event-stream.ts](../backend/adapters/http/graph-event-stream.ts) | 已修改 `eventsOpen()`、内部 flush/write | 独立跟踪 ownershipRevision；首次连接和重连发送占有基线，同一内容 revision 的租约变化不会被丢弃。 |
| [client/graph-client.ts](../client/graph-client.ts) | 已修改公共命令白名单与 `clientAssertData()` | 严格验证 runs、branch/control snapshot、claimed/busy/grant、runControls 和 ownershipRevision。 |
| 同上 | 修改 `clientAssertNode()`；核对 `clientIsLocator()`、`clientIsScore()` 的调用方 | HTTP 和 SSE 共用通用节点信封验证，不再按封闭 kind switch 拒绝新类型；合法内容依据对应定义校验，未知定义不能被当作 verification。 |
| [apps/desktop/ipc-handlers.ts](../apps/desktop/ipc-handlers.ts) | 修改/适配 `clientRegisterIpc()` 的 read/dispatch/watch handlers | 复用新版公共白名单与事件类型，保留窗口、watchId、sequence 校验；不为分支命令新增一套 IPC channel。 |
| [apps/ui/transport/client-gateway.ts](../apps/ui/transport/client-gateway.ts) | 适配 `apiCreateGateway()` → `watch()` | 转发新版占有事件及多 Run 事件，保持订阅身份隔离；无分支状态逻辑下沉到传输层。 |

### F. 客户端租约、分支编辑与运行界面

分支摘要、编辑/控制租约生命周期、占用只读和 run.start 原子控制授予已完成；多 Run 选择仍为后续目标。

| 文件 | 状态、函数或状态 | 要实现的职责 |
|---|---|---|
| [apps/ui/state/client-session.ts](../apps/ui/state/client-session.ts) | 已实现每 session 独立 holder、`claimBranch()`/`releaseBranch()` 与续租调度 | 服务端确认后才可写；快照基线会使丢失/替换的 grant 失效；切图、断线和销毁尝试释放，迟到响应按视图代次隔离。 |
| 同上 | 已新增 `claimRunControl()`、`releaseRunControl()`、`selectRun()` | 控制生命周期和 Run 选择由 session 管理；Vue 只发用户动作。 |
| 同上 | 已修改 `applyChanges()`、`createNode()`、`saveNode()`、`removeNode()` | 使用分支 proof；独立新根使用 null；网络重试保持原请求身份。关系/删除需要更宽根时由服务端范围规则拒绝。 |
| 同上 | 已修改 `startRun()` 的输入版本屏障与租约消费 | 启动前读取 branch.get/claim 并提交 proof/lease；成功后清除 editor grant、接纳 runControl 并调度续租。 |
| [apps/ui/features/graph/NodeInspector.vue](../apps/ui/features/graph/NodeInspector.vue) | 已按 branch version 与 grant 修改 editable/save/remove | 显示领取/释放按钮和他人占用只读状态；草稿只因相关分支版本改变而冲突。 |
| [apps/ui/features/run/RunReview.vue](../apps/ui/features/run/RunReview.vue) | 已接入 control grant、领取/释放及占用只读 | 只有当前控制者可暂停、继续、取消；控制接管不影响后台执行。明确 Run 选择待多 Run 完成。 |
| [apps/ui/features/run/OperationReview.vue](../apps/ui/features/run/OperationReview.vue) | 已将审核按钮绑定 `canControl` | Editor/Owner 仍需持有当前 Run 控制权才能提交版本化审核决定。 |
| [apps/ui/features/graph/graph-layout.ts](../apps/ui/features/graph/graph-layout.ts)、[GraphCanvas.vue](../apps/ui/features/graph/GraphCanvas.vue) | 修改 `graphReadCanvasLayout()`、`graphReadRunProgress()`、`graphCanProcessNode()`、`graphReadNodeText()`、`canvasReadStatus()` | 名称、摘要和处理选项读取定义；布局依据实际关系/阶段依赖，不固定来源/事实/核查列。遍历多 Run，视觉副本不产生额外编辑权。 |
| [apps/ui/views/WorkspacePage.vue](../apps/ui/views/WorkspacePage.vue) | 已接线分支租约与 Run 选择器 | 可在不相交范围继续启动 Run，右栏按所选 runId 展示控制、活动和审核。 |
| 同上 | 修改 `homeOpenNodeDialog()`、`homeCreateNode()` 及创建表单 | 从已发布类型定义选择新节点类型，按精确版本创建和编辑，移除只允许 claim/news/source 的入口限制。 |
| [apps/ui/features/agents/AgentManagement.vue](../apps/ui/features/agents/AgentManagement.vue) | 修改 `agentReadInput()`、`agentReadDraft()`、`agentUpdateKind()`、`agentUpdateProfile()` | 依据通用角色与转换绑定管理 Agent，不再默认把新 Agent 设为 verifySubAgent；提示词变量来自冻结输入映射。 |
| [apps/ui/features/assets/AssetManagement.vue](../apps/ui/features/assets/AssetManagement.vue) | 已修改 `assetCreateSource()` 并移除整图运行禁用 | 资产来源作为独立新根使用 null proof；不会因无关分支 Run 阻止创建。 |
| [apps/cli/main.ts](../apps/cli/main.ts) | 修改 `cliRun()`、`HELP` | 复用新白名单，写明领取/续租/释放/带凭证提交的完整操作；需要长会话时复用租约控制器。单次命令退出不宣称仍自动续租。 |

### G. 数据迁移、资产和检查入口

新增一个共享迁移文件 `backend/adapters/storage/branch-migration.ts`，通过现有 Persistence 调用两个存储 adapter，不为 Mongo/SQLite 复制两套业务转换。迁移只在显式管理命令调用，不接入自动启动。

| 文件 | 状态、函数 | 要实现的职责 |
|---|---|---|
| `backend/adapters/storage/branch-migration.ts`（新文件） | 新增 `migrationPlanBranchGraph(raw, serverNow)` | 校验旧图并生成通用数据转换计划：活跃 Run、有效租约或无法无损解释的数据会阻断；终态 Run 作为完整 `legacyArchive` 保留，不伪造通用 Operation 或分支占有。纯转换不写库。 |
| 同上 | 新增 `migrationMigrateBranches(database, apply = false)` | 通过现有 records/transaction/now 执行 dry-run 或显式写入；版本条件防止迁移覆盖并发变化，失败保留原数据，新版再次运行不重复迁移。 |
| [apps/graph-server/admin.ts](../apps/graph-server/admin.ts) | 修改 `adminRunCommand()` 的 supported 清单和路由 | 增加 `data.migrate-branches`，连接 Mongo adapter 后调用共享迁移；现有旧版 `repairMigrateNodeRuns()` 不被静默替换。 |
| [apps/local-server/main.ts](../apps/local-server/main.ts) | 修改 `localStartProcess()` 的参数分支 | 增加显式离线迁移模式，取得 SQLite 原有独占目录锁后调用同一迁移函数；迁移模式不启动 API/Host，不在正常启动时自动 apply。 |
| [backend/modules/assets/asset-service.ts](../backend/modules/assets/asset-service.ts) | 修改/核对 `assetsCreateService()` → `readSource()`、`assertReferences()`、`delete()`、`exportMap()`、`exportWorkspace()`、`importWorkspace()` | 按转换输入绑定读取来源，按类型声明识别资产引用，不再只识别 source/evidence 的 locator；权限与分支写授权保持同事务，保留既有来源访问限制。导入不复制活跃授权。 |
| 同上 | 修改私有 `assetsReadBundleFiles()` | 导出扫描按声明的引用字段遍历自定义 payload，带齐实际引用的资产，不仅处理固定 locator 位置。 |
| [backend/modules/assets/bundle-codec.ts](../backend/modules/assets/bundle-codec.ts) | 修改 `bundlesReadNode()`、`bundlesReadMap()`、`bundlesReadWorkspace()`、`bundlesReadMapDocument()`、`bundlesCreateImport()` | 按定义校验并携带精确版本；按声明的资产/节点引用字段重映射，移除 kind 特判；历史包映射到默认定义，拒绝注入运行授权。 |
| 同上及 [contracts/control.ts](../contracts/control.ts) | 修改 `bundlesReadAgents()`、`MapBundle`、`WorkspaceBundle` | 发布 v4 数据包，携带精确定义及依赖闭包；旧 v3 显式转换，原报告身份和待审状态按协议保全，不把新结构伪装为旧格式。 |
| [backend/adapters/storage/mongo/graph-store.ts](../backend/adapters/storage/mongo/graph-store.ts)、[backend/adapters/storage/sqlite/graph-store.ts](../backend/adapters/storage/sqlite/graph-store.ts)、[apps/ui/state/client-session.ts](../apps/ui/state/client-session.ts)、[contracts/graph.ts](../contracts/graph.ts) | 修改两 adapter 的 `list()`、`applySnapshot()`、`GraphMapSummary` | claimCount 改为按类型统计的通用摘要，图列表展示名称来自定义；自定义业务不继续显示固定“事实数”。 |
| [backend/modules/workspace/workspace-service.ts](../backend/modules/workspace/workspace-service.ts) | 修改 `controlCreateService()` → `dispatch()` 的 workspace.delete 路径 | 将单一 run.status 查询改为检查所有活跃 Run 和有效分支占有；检查与删除同属授权事务，避免从工作区入口绕过图级保护。 |
| [scripts/check-architecture.mjs](../scripts/check-architecture.mjs)、[scripts/check-runtime-messages.mjs](../scripts/check-runtime-messages.mjs) | 核对/必要时修改现有路径规则与扫描清单 | 新文件纳入领域/adapter依赖和消息规范检查；不放宽原有业务层禁止加载数据库驱动的约束。 |
| [README.md](../README.md)、[tests/README.md](../tests/README.md) | 修改使用与验收说明 | 写明 Host 容量、分支领取、多 Run、兼容及显式迁移命令，区分已验证与待验证能力。 |

本轮已新增 `branch-state.ts`、`branch-migration.ts`、`contracts/data-definition.ts`、`backend/modules/shared/data-definition.ts` 和 `resources/data-definitions/fact-checking.json`。编辑租约生命周期当前集中在 `client-session.ts`，以后若拆为 `client/branch-lease.ts` 只属于代码组织调整。

## 对应验证清单

测试使用现有 describe/it 入口。定义、通用 Run、Host 并发、v4 bundle、显式迁移、分支摘要、编辑/Run/控制租约、ownership SSE 与同图多 Run 均有自动化覆盖。

新增 `tests/backend/modules/shared/data-definition.spec.ts` 验证定义版本、引用、schema、基数和冻结规则；`tests/backend/modules/graph/generic-run.spec.ts`、`tests/client/data-payload.spec.ts` 和现有客户端集成测试覆盖自定义类型、有限转换执行、通用编辑/显示及默认包真实 DSH 闭环。

| 文件 | 状态与必须覆盖的场景 |
|---|---|
| [tests/backend/execution/host.spec.ts](../tests/backend/execution/host.spec.ts) | 修改 `hostCreateFixture()` 与场景：同 Host 并发上限、同 Work 去重、单项失租隔离、所有在途任务排空、重连不重叠。 |
| [tests/backend/adapters/messaging/queue.spec.ts](../tests/backend/adapters/messaging/queue.spec.ts) | 修改 `fixture()` 与场景：有界投递、独立 ACK/NACK、最后启动的任务先结束也不能漏等早期任务。 |
| `tests/backend/adapters/messaging/in-process.spec.ts` | 新增：本机传输同等容量/重试/排空语义，仍拒绝第二消费者。 |
| [tests/backend/execution/dsh.spec.ts](../tests/backend/execution/dsh.spec.ts)、[activity.spec.ts](../tests/backend/execution/activity.spec.ts) | 修改：真实/受控 DSH 的目录与会话隔离、事件归属、独立序号及取消一个不误停另一个。 |
| [tests/backend/execution/dsh-verify.spec.ts](../tests/backend/execution/dsh-verify.spec.ts) | 修改 `startHost()` 容量参数：1 Host × N 槽、N Host × 1 槽、混合布局结果一致；真实并行、崩溃接管和进程收回。 |
| [tests/backend/modules/graph/branch.spec.ts](../tests/backend/modules/graph/branch.spec.ts)、[branch-revision.spec.ts](../tests/backend/modules/graph/branch-revision.spec.ts) | 已覆盖 scope/version、同分支冲突、不相交写入、新根 null、拓扑影响、幂等重放和 run.start 旧摘要拒绝。 |
| [tests/backend/modules/graph/branch-lease.spec.ts](../tests/backend/modules/graph/branch-lease.spec.ts) | 已覆盖分支互斥、不相交领取、续租/释放/接管、旧 fence、写入竞态、Run 转换、控制权接管/竞态/终态释放和同内容 revision 的 SSE。 |
| [tests/backend/adapters/storage/branch-rebase.spec.ts](../tests/backend/adapters/storage/branch-rebase.spec.ts) | 已覆盖 Mongo/SQLite 严格 CAS，以及服务层从最新文档重放不相交局部补丁时不丢更新。 |
| [tests/backend/modules/graph/branch-lease.spec.ts](../tests/backend/modules/graph/branch-lease.spec.ts)、[node-run.spec.ts](../tests/backend/modules/graph/node-run.spec.ts)、[work.spec.ts](../tests/backend/modules/graph/work.spec.ts) | 已覆盖两个不相交 Run 并发启动、分别领取 Work、单 Run 暂停/取消隔离、Agent Work 并行及 pause→resume 围栏。 |
| [tests/backend/adapters/storage/sqlite.spec.ts](../tests/backend/adapters/storage/sqlite.spec.ts)、[sqlite-integration.spec.ts](../tests/backend/adapters/storage/sqlite-integration.spec.ts)、[work-replica.spec.ts](../tests/backend/adapters/storage/work-replica.spec.ts) | 已覆盖本机 runs[] 闭环、编辑/控制租约、Run 占有与 Work 围栏。 |
| [tests/backend/adapters/messaging/messaging.spec.ts](../tests/backend/adapters/messaging/messaging.spec.ts)、[branch-lease.spec.ts](../tests/backend/modules/graph/branch-lease.spec.ts) | 已覆盖普通内容通知及纯 ownership 变化的完整 snapshot；多 API 断线补发专项仍待生产验收。 |
| [tests/client/graph-client.spec.ts](../tests/client/graph-client.spec.ts)、[stream.spec.ts](../tests/client/stream.spec.ts)、[session.spec.ts](../tests/client/session.spec.ts) | 已覆盖 runs/control DTO、ownership 更新、自动领取、控制只读/接管和 Run 选择状态。 |
| [tests/client/layout.spec.ts](../tests/client/layout.spec.ts)、[integration.spec.ts](../tests/client/integration.spec.ts)、[management-integration.spec.ts](../tests/client/management-integration.spec.ts) | 已覆盖通用画布、带租约的分支编辑、真实 DSH Run 与冻结配置。 |
| [tests/apps/desktop/ipc-handlers.spec.ts](../tests/apps/desktop/ipc-handlers.spec.ts)、[local-service-process.spec.ts](../tests/apps/desktop/local-service-process.spec.ts)、[tests/apps/cli/headless.spec.ts](../tests/apps/cli/headless.spec.ts) | 已覆盖公共 branch.get/proof 协议经既有通道可达；CLI 租约续期/失租和占有订阅仍待补。 |
| `tests/backend/adapters/storage/branch-migration.spec.ts` | 新增：同一迁移逻辑在 Mongo/SQLite 的 dry-run、原子 apply、有效租约阻止、身份保留及重复迁移。 |
| [tests/backend/modules/assets/assets.spec.ts](../tests/backend/modules/assets/assets.spec.ts) | 已覆盖资产引用竞争、独立新根和数据包不携带执行授权。 |
| [tests/backend/modules/workspace/workspace.spec.ts](../tests/backend/modules/workspace/workspace.spec.ts) | 工作区删除路径已检查活跃 Run 与有效分支占有；与领取竞争的专项压力测试仍可补充。 |

本轮最终 `npm test` 为 52 个文件、299 项全部通过，新增本地无客户端租约的 HTTP 写入与运行控制、UI 无续租定时器、旧本机租约兼容和运行根删除保护；同时覆盖分支版本、协作租约、多 Run、DSH 与数据包链路。`npm run build:check`、`npm run test:desktop-runtime`、077/064/052 校验与 `git diff --check` 均已通过；本地 CLI 文档流程另经临时 SQLite/API 实测。

## 本轮实施记录

- 用户已确认采用先领取、其他客户端只读。
- 用户澄清数据类的后继指允许后继类型；已补充类型声明和校验函数，与实际节点关系及分支范围计算分开。
- 用户进一步要求业务节点不硬编码；已改为注册类型、转换定义和默认事实核查包，补齐执行器、提示词、MJS、界面与数据包改动。
- 用户进一步明确执行粒度为 Agent；方案以现有 Work 表达一次 Agent 工作，Host 提供可配置执行槽。
- Work 已改为通用 stageId/slotId 身份并按 Agent 阶段独立领取；Host/传输层的有界并发及多任务生命周期管理已落地。
- 已明确同一分支的兄弟 Agent 不能互抢分支锁，也不能因彼此合法提交而触发整分支版本冲突。
- 已查明分支可能重叠或共享后继；按起点 ID 独立加锁不足以保证互斥。
- 分支摘要、无关分支重放、独占编辑租约、Run 范围/控制占有、同图多 Run、ownership SSE 及 UI 选择/只读状态已完成。
- 通用定义、运行代码、两种存储、Host/传输、DSH、UI、v4 数据包与显式迁移均已修改并有对应回归。
- 真实 DSH 已验证默认解析、拆分、三 Agent 核查、计划/结果审核与候选引用原子发布；这不等于正式模型质量或跨机器生产 HA 验收。

## 本轮协议细化交付

- 新增数据定义协议，确定精确版本、draft-07 子集、引用/Agent 投影、结构锚点、输入齐备、候选发布和 v4 数据包语义。
- 调度选型已收敛到现有 RabbitMQ＋Work／本机通知，DSH 保留；不再把外部引擎选型作为 077 前置条件。
- 定义样例之外，生产注册事务、数据库适配、DSH、通用界面、迁移路径、分支摘要和编辑/Run/控制占有、同图多 Run 已接通。
- [定义样例](./077-数据定义示例.json) 及 [校验器](./077-校验数据定义.mjs) 给出 8 类数据、7 个转换的静态实例；执行 `node develop-docs/077-校验数据定义.mjs` 检查。动态路由、原子候选依赖发布和并发事务的验收另见协议，不混同于样例检查。
- 静态样例仍覆盖 8 个类型、7 个转换及负例；运行回归另覆盖 Mongo/SQLite、分支摘要与不相交重放、编辑/Run/控制租约、同图多 Run、RabbitMQ/进程内通知、真实 DSH、通用客户端、v4 导入导出和显式迁移。生产多机主切换仍需部署验收。
