# 模块与运行入口

本文件描述实际结构；编码样式与变更规则统一见[coding.md](./coding.md)。

073 已把现有源码按业务和运行职责放进实际目录；当前文件树如下。072 后续负责模块内部可读性和 interface 的改善。

## 文件树

~~~text
backend/
  application/
    graph-application.ts       组织业务调用、身份验证和事务
  modules/
    graph/                     数据图、Run、Work与活动
    workspace/                 工作区、成员、Agent库与配置
    identity/                  用户、令牌与写入身份验证
    assets/                    资产上传、导出、导入与数据包
    shared/                    领域错误、输入校验与注册定义编译
  ports/                       持久化、图存储、消息、来源读取interface
  adapters/
    http/                      图HTTP、事件流、DSH诊断HTTP
    storage/
      mongo/                   Mongo连接、图存储、持久化、维护
      sqlite/                  SQLite图存储与持久化
    messaging/                 进程内消息、RabbitMQ、Mongo Outbox
    sources/                   HTTP来源读取
  execution/
    host-worker.ts             领取、续租、执行和释放工作
    dsh/                       DSH运行时、工作执行、提示词与活动

apps/
  graph-server/                协作图服务和管理员入口
  execution-host/              协作执行Host入口
  local-server/                SQLite与单Host本机入口
  dsh-diagnostics/             独立DSH诊断入口
  desktop/                    Electron启动、IPC、连接与本机子进程
  ui/
    features/
      graph/                   图画布、节点详情和树布局
      run/                     运行与审核界面
      workspace/               工作区与成员管理
      agents/                  Agent管理
      assets/                  文件与数据包界面
      settings/                共享配置界面
      management/              管理面板与请求生命周期
    state/client-session.ts    客户端会话状态
    transport/client-gateway.ts 桌面桥接与Web网关选择
    views/WorkspacePage.vue    工作区主页面
    components/shell/          通用外壳与分栏
    composables/              拖动、缩放与尺寸交互
  cli/                         认证命令行入口
  config/                      默认Agent与本机配置装配

client/graph-client.ts         桌面、Web、CLI共用的图服务客户端
contracts/                    各运行端共用的协议、数据定义和消息
platform/node/                Node进程退出与诊断
resources/prompts/            构建期默认提示词
resources/data-definitions/   构建期默认数据类型与转换定义包
tests/                        按backend模块、apps入口、client等对应归类
~~~

完整旧路径映射见 [073 文件迁移表](./develop-docs/073-文件迁移表.json)。旧目录已经移除，没有旧路径重导出。

## 从哪里开始读

| 要找的行为 | 文件 |
|---|---|
| 用户命令怎么鉴权并进入事务 | [graph-application.ts](./backend/application/graph-application.ts) |
| 图写入、收据与Work提交 | [graph-service.ts](./backend/modules/graph/graph-service.ts) |
| 分支闭包、摘要和局部修改影响 | [branch-state.ts](./backend/modules/graph/branch-state.ts) |
| 有限计划、阶段依赖、候选发布和审核状态 | [run-state.ts](./backend/modules/graph/run-state.ts) |
| 类型/转换注册、payload 校验与执行规格冻结 | [data-definition.ts](./backend/modules/shared/data-definition.ts)、[公共合同](./contracts/data-definition.ts) |
| 哪些Work现在可以领取 | [work-state.ts](./backend/modules/graph/work-state.ts) |
| 工作区、成员和Agent配置管理 | [workspace-service.ts](./backend/modules/workspace/workspace-service.ts) |
| Agent配置内容是否合法 | [agent-configuration.ts](./backend/modules/workspace/agent-configuration.ts) |
| 用户令牌和身份验证 | [identity-service.ts](./backend/modules/identity/identity-service.ts) |
| 资产与数据包读写 | [asset-service.ts](./backend/modules/assets/asset-service.ts)、[bundle-codec.ts](./backend/modules/assets/bundle-codec.ts) |
| Host怎么领取/续租/退出 | [host-worker.ts](./backend/execution/host-worker.ts) |
| DSH如何运行一个已授权工作 | [work-executor.ts](./backend/execution/dsh/work-executor.ts) |
| HTTP和实时推送 | [graph-http-server.ts](./backend/adapters/http/graph-http-server.ts)、[graph-event-stream.ts](./backend/adapters/http/graph-event-stream.ts) |
| UI切图、重试、连接状态 | [client-session.ts](./apps/ui/state/client-session.ts) |
| 通用数据关系布局与转换选择 | [graph-layout.ts](./apps/ui/features/graph/graph-layout.ts) |

## 077 当前执行模型

客户端租约策略由服务端装配决定：本机 `applicationCreateLocalService()` 固定 `clientLeases: 'none'`，协作默认 required。bootstrap 公开该能力，UI 据此直接编辑/控制且不启动续租定时器。本机提交仍校验 branch proof、权限、review revision、内部 CAS 和持久 Run 范围占有；客户端不能通过请求选择跳过协作授权。下文编辑/控制租约生命周期适用于协作服务，Work 授权在两种模式中均由系统管理。

`GraphNode` 是通用数据实例，业务内容位于 `payload`，其约束由精确 `typeId@typeVersion` 对应的不可变定义决定。`successor` 表达正式后继，`reference` 表达不扩张结构范围的引用。事实核查只是默认定义包；新增受支持业务类型和转换不要求修改核心节点联合类型。

Run 接收有限有向计划。每个 Operation 冻结转换、输入版本、Agent、工具、schema 和阶段依赖；每份可领取 Work 对应一个 Agent 阶段或计划槽。Host 的 `concurrency` 为 1..64，同 Host 多槽和多 Host 都通过相同 Work claim/renew/release、holder/fence 与结果收据运行。DSH 仍是一份执行尝试的本地模型/工具会话，不是分布式身份。

图持久化保存 `runs[]`，每个 Run 按 runId 管理自己的 branchState、Operation 和 Work。服务端沿实际 `successor` 关系计算分支闭包；`branch.get` 返回 scope、稳定摘要、根节点 revision 与读取时 mapRevision。摘要包含范围成员、相关节点/边版本及声明式 payload 节点引用；reference 不扩展闭包但会影响两端版本。`branch.claim/renew/release` 以同一实际 scope 管理编辑租约，父子或共享后继范围互斥，不相交范围可以并行编辑或运行。`graph.apply` 同时验证内容 proof 与 holder/fence，并在最终存储条件中检查 `ownershipRevision`。

`run.start` 验证内容 proof 和编辑租约，并把它原子转换为持久 Run 范围占有。Run 保存并持续复核 `branchState`，正式产物必须通过 successor 留在扩展后的 scope；终态释放占有。SSE 按内容 revision 与 ownershipRevision 两个序列发送完整快照，因此旁观客户端能在内容不变时进入或退出只读状态。整图 revision 只承担持久化 CAS 和快照排序，CAS 竞争后服务层从最新图重放局部补丁。

活动、控制、审核和 Work 都携带明确 runId。`run.control.claim/renew/release` 管理与后台范围占有分离的可过期控制租约；启动者原子取得控制权，接管不会重启 Host。Mongo/SQLite 按目标 Run 校验工作租约，暂停只撤销该 Run 的授权。同图多个 Run 的内容提交仍由整文档 CAS 串行化，CAS 失败后服务层重读并重放，业务隔离依据各自分支 proof 和占有范围。

文件归属已经明确；graph-service和workspace-service内部的职责还需要按072逐步整理，不能把本次移动等同于内部重构完成。

## 运行入口

| 运行端 | 入口 | 命令 |
|---|---|---|
| 桌面Main / preload | apps/desktop/main.ts、preload.ts | npm run dev |
| 桌面本机子进程 | apps/desktop/local-service-entry.ts | Main自动托管 |
| Web/桌面共用界面 | apps/ui/main.ts | npm run dev:web |
| 认证CLI | apps/cli/main.ts | npm run headless |
| 协作图服务 | apps/graph-server/main.ts | npm run graph:serve |
| 协作管理员 | apps/graph-server/admin.ts | npm run admin |
| 协作执行Host | apps/execution-host/main.ts | npm run host:serve |
| 独立SQLite运行 | apps/local-server/main.ts | npm run local:serve |
| DSH诊断 | apps/dsh-diagnostics/main.ts | npm run dsh:serve |

DSH诊断不是协作部署必需的额外服务。协作部署仍为Mongo、RabbitMQ、Graph API和一个或多个Host；独立本机使用SQLite与进程内通知。两种传输均支持有界的多 Work 在途集合，并在关闭时等待每份尝试完成清理。

## 依赖约束

- apps负责选择和装配adapter；application组织业务module。
- modules不加载HTTP、执行器、数据库或消息驱动。graph、workspace、identity、assets各有单独依赖白名单，shared只依赖contracts。
- ports放置现有interface；GraphStore使用graph-record中的持久化数据类型，保留这个显式类型依赖。
- adapters实现存储/网络/传输；Mongo维护工具只在storage/mongo中。
- execution仅使用工作协议和注入的传输，不导入存储/MQ驱动。
- 桌面Main、preload、UI和CLI只访问公共客户端；Main通过固定子进程入口托管本机后端。
- Graph Server不加载DSH；Execution Host不加载Mongo。桌面本机依赖闭包不含Mongo、RabbitMQ或协作图服务入口。
- 默认提示词在resources，apps/config负责装配注入；application/modules/ports内禁止prompt目录和JSON资源。
- platform/node负责终端异常、受限日志与关闭期限；业务module使用诊断interface。

## 源码与安装包资源

DSH工作执行器、dsh-business.patch.yml和dsh-business-plugin.mjs在backend/execution/dsh同目录。桌面构建把两份资源复制到随包service/main.mjs旁，源码移动不改变它们的相对寻址方式。

安装包继续使用local-runtime/service，Node运行时依赖沿用根lockfile；不会把Mongo、RabbitMQ、Vue或Pinia装到本机服务资源。客户端bundle的main.js/preload.js输出名不变。

## 验证

~~~bash
npm run test:boundaries
npm test
npm run test:desktop-runtime
npm run build:check
node develop-docs/064-校验入口.mjs
node develop-docs/052-校验契约.mjs
~~~

架构检查覆盖新目录归属、导入方向、业务资源隔离和运行入口闭包。路径迁移的非import资源、进程启动和打包行为由运行测试继续验证。
