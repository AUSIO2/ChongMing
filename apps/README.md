# 运行端与界面导航

| 目录 | 用途 |
|---|---|
| [graph-server](./graph-server) | 协作图服务；main.ts提供HTTP，admin.ts提供管理员命令 |
| [execution-host](./execution-host) | 协作执行Host，接收Work并运行DSH |
| [local-server](./local-server) | SQLite和单Host本机运行，不需要Mongo/RabbitMQ |
| [dsh-diagnostics](./dsh-diagnostics) | DSH独立诊断入口 |
| [desktop](./desktop) | Electron main/preload、IPC、凭据、连接与本机子进程 |
| [cli](./cli) | 通过认证客户端操作数据图 |
| [config](./config) | 本机配置文件与默认Agent装配 |
| [ui/features](./ui/features) | 图、运行、工作区、Agent、资产和设置各自的界面 |
| [ui/state](./ui/state) | 客户端会话与视图状态 |
| [ui/transport](./ui/transport) | 桌面桥接与Web客户端选择 |

桌面入口为[main.ts](./desktop/main.ts)，工作区页面为[WorkspacePage.vue](./ui/views/WorkspacePage.vue)。公共网络客户端位于[client/graph-client.ts](../client/graph-client.ts)，各运行端复用它。
