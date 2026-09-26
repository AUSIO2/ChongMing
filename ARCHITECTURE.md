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
    shared/                    领域错误与输入校验
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
contracts/                    各运行端共用的协议和消息
platform/node/                Node进程退出与诊断
resources/prompts/            构建期默认提示词
tests/                        按backend模块、apps入口、client等对应归类
~~~

完整旧路径映射见 [073 文件迁移表](./develop-docs/073-文件迁移表.json)。旧目录已经移除，没有旧路径重导出。

## 从哪里开始读

| 要找的行为 | 文件 |
|---|---|
| 用户命令怎么鉴权并进入事务 | [graph-application.ts](./backend/application/graph-application.ts) |
| 图写入、收据与Work提交 | [graph-service.ts](./backend/modules/graph/graph-service.ts) |
| 节点后继、暂停恢复和审核状态 | [run-state.ts](./backend/modules/graph/run-state.ts) |
| 哪些Work现在可以领取 | [work-state.ts](./backend/modules/graph/work-state.ts) |
| 工作区、成员和Agent配置管理 | [workspace-service.ts](./backend/modules/workspace/workspace-service.ts) |
| Agent配置内容是否合法 | [agent-configuration.ts](./backend/modules/workspace/agent-configuration.ts) |
| 用户令牌和身份验证 | [identity-service.ts](./backend/modules/identity/identity-service.ts) |
| 资产与数据包读写 | [asset-service.ts](./backend/modules/assets/asset-service.ts)、[bundle-codec.ts](./backend/modules/assets/bundle-codec.ts) |
| Host怎么领取/续租/退出 | [host-worker.ts](./backend/execution/host-worker.ts) |
| DSH如何运行一个已授权工作 | [work-executor.ts](./backend/execution/dsh/work-executor.ts) |
| HTTP和实时推送 | [graph-http-server.ts](./backend/adapters/http/graph-http-server.ts)、[graph-event-stream.ts](./backend/adapters/http/graph-event-stream.ts) |
| UI切图、重试、连接状态 | [client-session.ts](./apps/ui/state/client-session.ts) |
| 阶段树布局 | [graph-layout.ts](./apps/ui/features/graph/graph-layout.ts) |

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

DSH诊断不是协作部署必需的额外服务。协作部署仍为Mongo、RabbitMQ、Graph API和一个或多个Host；独立本机使用SQLite与进程内通知。

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
