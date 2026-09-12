# 用例覆盖矩阵

| Flow ID | 业务目标 | 主调用者 | 入口集合 | 起始条件 | 完成条件 | 主文章节 |
|---|---|---|---|---|---|---|
| UC-01 | 登录并恢复本人工作上下文 | 用户 | Q-01..05、C-05 | 用户 token 有效 | 返回身份、工作区、图和本人偏好 | 4.1 |
| UC-02 | 治理 Workspace、成员、Agent 和共享设置 | Owner / HostAdmin | Q-07、C-01..10 | 对目标作用域有管理权限 | 配置按 CAS 更新并可供新 Run 冻结 | 4.2 |
| UC-03 | 建立和维护事实数据图 | Editor | C-11..13 | Workspace 可写且版本匹配 | 节点/边/图名原子写入新 revision | 4.3 |
| UC-04 | 对 Claim 完成动态多角度核查 | Editor、Host、DSH、审核者 | Q-06、C-14..17、I-01..07、O-03 | Claim 与配置可用，无活动 Run | Run 终态；批准时 Verification 节点入图 | 4.4 |
| UC-05 | 管理可追溯资产 | Editor / Owner / Viewer | Q-08、C-18、H-01..02 | Workspace 权限与摘要正确 | ready 资产可读，删除后不可读 | 4.5 |
| UC-06 | 导出并导入可移植工作区 | Viewer / Owner / staging Owner | C-19、H-03..04 | 包引用闭包与大小合法 | 新 Workspace、Map、资产一次发布 | 4.6 |
| OPS-01 | 初始化、诊断和维护图服务 | 本机管理员、探针 | O-01..02、O-04 | 本机执行权限 | 服务可运行或明确返回诊断/维护结果 | 6 |
| DEV-01 | 独立调用 DSH SDK 会话 | 本机开发者 | D-01..02 | DSH profile 和模型配置可用 | NDJSON 返回通知与最终结果 | 6 |

物理 `/api/v1/query` 和 `/api/v1/command` 是方法信封入口。覆盖按解析后的 method 计算，因此一个 HTTP handler 可以承载多个互斥业务入口，但每个 method 只归属一个主流程。
