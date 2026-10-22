# 后端模块导航

| 目录 | 负责什么 |
|---|---|
| [modules/graph](./modules/graph) | 数据图、Run状态、可领取Work、活动与收据 |
| [modules/workspace](./modules/workspace) | 工作区、成员、Agent库、共享设置与配置验证 |
| [modules/identity](./modules/identity) | 用户、令牌和事务内身份验证 |
| [modules/assets](./modules/assets) | 资产及工作区/图数据包 |
| [modules/shared](./modules/shared) | 共用输入校验和领域错误 |
| [application](./application) | 按业务命令组织上述module和事务 |
| [ports](./ports) | 持久化、图存储、消息和来源读取的interface |
| [adapters/http](./adapters/http) | HTTP请求、SSE输出和诊断HTTP |
| [adapters/storage](./adapters/storage) | Mongo和SQLite两个真实adapter |
| [adapters/messaging](./adapters/messaging) | 进程内通知、RabbitMQ和Mongo Outbox |
| [adapters/sources](./adapters/sources) | HTTP来源读取 |
| [execution](./execution) | Host领取/续租工作，以及DSH执行 |

从[graph-application.ts](./application/graph-application.ts)追踪公开命令，从[host-worker.ts](./execution/host-worker.ts)追踪执行生命周期。运行入口集中在[apps](../apps/README.md)。
