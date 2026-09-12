# 运行入口清单

入口按可独立调用的 method/路径编号；共享 `/api/v1/query` 与 `/api/v1/command` 只是传输入口，不把所有业务目的错误合成一个 UC。

| Entry ID | 类型 | 定位 | 调用者 | 权限/前置条件 | 首个业务调用 | 主流程 |
|---|---|---|---|---|---|---|
| Q-01 | HTTP query | `app.bootstrap` | 用户客户端 | 有效用户 token | `ApplicationService.read → ControlService.read` | UC-01 |
| Q-02 | HTTP query | `workspace.list` | 用户客户端 | 登录 | `ControlService.read` | UC-01 |
| Q-03 | HTTP query | `workspace.get` | 用户客户端 | Workspace Viewer | `ControlService.read` | UC-01 |
| Q-04 | HTTP query | `map.list` | 用户客户端 | Workspace Viewer | `GraphService.read` | UC-01 |
| Q-05 | HTTP query | `map.get` | 用户客户端 | Map 所属 Workspace Viewer | `GraphService.read` | UC-01 |
| Q-06 | HTTP query | `run.get` | 用户客户端 | Map 所属 Workspace Viewer | `GraphService.read` | UC-04 |
| Q-07 | HTTP query | `agent.list` | 用户客户端 | library 登录可读；workspace Viewer | `ControlService.read` | UC-02 |
| Q-08 | HTTP query | `asset.get` | 用户客户端 | Asset 所属 Workspace Viewer | `AssetsService.read` | UC-05 |
| C-01..03 | HTTP command | `workspace.create/update/delete` | 用户客户端 | 创建需登录；修改/删除 Owner | `ApplicationService.dispatch → ControlService.dispatch` | UC-02 |
| C-04 | HTTP command | `member.set` | 用户客户端 | Owner，不能移除最后 Owner | `ControlService.dispatch` | UC-02 |
| C-05 | HTTP command | `preferences.set` | 用户客户端 | 本人 Workspace 成员 | `ControlService.dispatch` | UC-01 |
| C-06..09 | HTTP command | `agent.create/update/delete/copy` | 用户客户端 | library HostAdmin；workspace Owner | `ControlService.dispatch` | UC-02 |
| C-10 | HTTP command | `settings.update` | 管理员客户端 | HostAdmin | `ControlService.dispatch` | UC-02 |
| C-11..13 | HTTP command | `map.create/delete`、`graph.apply` | 用户客户端 | Workspace Editor；无活动 Run 的编辑受状态门控 | `GraphService.dispatch` | UC-03 |
| C-14..19 | HTTP command | `run.start/pause/resume/cancel`、`review.update/answer` | 用户客户端 | Workspace Editor、Map/Operation/Review 版本匹配 | `GraphService.dispatch → Run functions` | UC-04 |
| C-20 | HTTP command | `asset.delete` | 用户客户端 | Asset 所属 Workspace Owner | `AssetsService.delete` | UC-05 |
| C-21 | HTTP command | `workspace.import` | 用户客户端 | staging Workspace Owner | `AssetsService.importWorkspace` | UC-06 |
| H-01 | HTTP binary | `POST /api/v1/assets` | 用户客户端 | Workspace Editor、长度/摘要/幂等键齐全 | `AssetsService.upload` | UC-05 |
| H-02 | HTTP binary | `GET /api/v1/assets/{id}/content` | 用户客户端 | Workspace Viewer、Asset ready | `AssetsService.content` | UC-05 |
| H-03..04 | HTTP export | `GET /api/v1/maps/{id}/export`、`/workspaces/{id}/export` | 用户客户端 | Map 导出需 Viewer；Workspace 导出需 Owner | `AssetsService.exportMap/exportWorkspace` | UC-06 |
| I-01..05 | 内部 HTTP | `/internal/v1/work` 的 claim/read/renew/release/fail | Host | 内部 Bearer token；按动作校验 grant | `GraphService.dispatchWork` | UC-04 |
| I-06 | 内部 HTTP | `POST /internal/v1/data/read` | DSH 业务插件 | 内部 token + work headers + 有效 lease | `GraphService.readData` | UC-04 |
| I-07 | 内部 HTTP | `POST /internal/v1/data/propose` | DSH 业务插件 | 同上，proposal 与角色/slot 一致 | `GraphService.propose` | UC-04 |
| O-01 | HTTP | `GET /health` | 探针 | 图服务进程可达 | 直接返回 | OPS-01 |
| O-02 | 进程 | `backend/graph-main.ts` | 运维 | Mongo 副本集与配置可读 | 初始化 Auth/Control/Assets/Graph | OPS-01 |
| O-03 | 进程 | `backend/host-main.ts` | 运维 | 内部 token、图服务和 DSH 可用 | `HostWorker.start` | UC-04 |
| O-04 | CLI | `backend/admin-main.ts` 管理动作 | 本机管理员 | 本机配置/数据库条件按动作满足 | Auth/Control/repair/local settings | OPS-01 |
| D-01 | HTTP | `GET /health`（4318） | 开发者 | 独立 DSH 运行时已启动 | 直接返回 | DEV-01 |
| D-02 | HTTP NDJSON | `POST /runtime/dsh/run` | 开发者 | 合法 prompt | `DshRuntime.run` | DEV-01 |

## 覆盖结果

- 逻辑运行入口：8 query、21 command、4 用户专用 HTTP、7 内部动作、4 运行/管理入口、2 独立开发入口。
- 已归属入口数等于总入口数，主归属冲突为 0。
- 仓库中没有 MQ consumer、scheduler 或业务事件监听入口。Host 轮询属于 UC-04 的异步续接。

证据：`backend/api.ts#apiCreateServer`、`backend/graph-main.ts#main`、`backend/host-main.ts#hostRunMain`、`backend/admin-main.ts#adminRunCommand`、`backend/dsh-http.ts#dshHttpCreateServer`。
