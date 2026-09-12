# 时序参与者映射

| Diagram | 可见参与者 | 实体类型 | 源码实体/运行资源 |
|---|---|---|---|
| UC-01 | 用户客户端、图服务入口、认证服务、控制服务、图服务、MongoDB | 调用者/组件/存储 | ClientGateway、apiCreateServer、AuthService、ControlService、GraphService、Mongo |
| UC-02 | 管理客户端、图服务入口、认证服务、控制服务、MongoDB | 调用者/组件/存储 | 同名具体 service factory 返回对象 |
| UC-03 | 编辑客户端、图服务入口、应用服务、图服务、图存储 | 调用者/组件/存储 | ApplicationService、GraphService、GraphStore |
| UC-04-A | 审核客户端、图服务入口、控制服务、Run 状态组件、图存储 | 调用者/组件/存储 | ControlService、backend/run.ts、GraphStore |
| UC-04-B | Host、图服务入口、图服务、DSH 工作适配器、DSH 进程、业务插件、MongoDB | 组件/运行资源/存储 | HostWorker、GraphService、dshRunWork、DeepSeekHarness、dsh-business-plugin、Mongo |
| UC-04-C | 审核客户端、图服务入口、Run 状态组件、图存储 | 调用者/组件/存储 | backend/run.ts、GraphStore |
| UC-05 | 资产客户端、图服务入口、认证服务、资产服务、MongoDB、GridFS | 调用者/组件/存储 | AssetsService、Mongo collections、GridFSBucket |
| UC-06 | 迁移客户端、图服务入口、资产服务、包解析组件、MongoDB、GridFS | 调用者/组件/存储 | AssetsService、backend/bundles.ts、Mongo、GridFSBucket |
| OPS-01 | 本机管理员、管理 CLI、控制/认证服务、MongoDB、本机配置文件 | 调用者/组件/存储 | admin-main、ControlService/AuthService、Mongo、local-settings |
| DEV-01 | 本机开发者、DSH HTTP 服务、SDK 适配器、DSH 进程 | 调用者/组件/运行资源 | dsh-http、DshRuntime、DeepSeekHarness |

图中不使用“流程”“状态”“能力”等抽象生命线；Run 状态组件指向有真实函数体的 `backend/run.ts`，包解析组件指向 `backend/bundles.ts`。
