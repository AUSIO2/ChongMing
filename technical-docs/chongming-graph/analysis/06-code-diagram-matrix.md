# 代码—图矩阵

| 运行代码路径 | Diagram ID | Trace | 图中职责 |
|---|---|---|---|
| `apiCreateServer → ApplicationService.read → AuthService.read → ControlService.read/GraphService.read` | UC-01 | UC-01 | 登录、工作区与图读取 |
| `ApplicationService.dispatch → AuthService.transact → ControlService.dispatch` | UC-02 | UC-02 | 管理事务、权限、CAS 与回执 |
| `ApplicationService.dispatch → GraphService.dispatch → graphUpdateChanges → GraphStore.commit` | UC-03 | UC-03 | 图编辑与原子提交 |
| `runCreateRun → runUpdateProgress → workReadItems → GraphStore.claim` | UC-04-A | UC-04 | 冻结范围/配置、派生多 Operation 与工作 |
| `sourceReadUrl/AssetsService.content → dshRunWork → DshRuntime → DSH business plugin` | UC-04-B | UC-04 | Source 正文、parse/split/verify 执行与工具限制 |
| `GraphService.readData/propose → runUpdateProposal/runCreateOutputs → GraphStore.commit` | UC-04-B | UC-04 | 原子产物、后继闭包和并发提交 |
| `runCreateReview/runUpdateReview/runAnswerReview/runUpdatePause` | UC-04-C | UC-04 | Operation 审核、暂停与恢复 |
| `runUpdateProgress` 的 Source→News→Claim→Verification 闭包 | UC-04-D | UC-04 | scope/until、复用和完成判定 |
| `AssetsService.upload/content/delete → GridFS + metadata + transaction` | UC-05 | UC-05 | 资产完整性、发布与删除 |
| `AssetsService.export* → bundles* → importWorkspace` | UC-06 | UC-06 | 包校验、ID 重映射、事务发布 |
| `graph-main/admin-main/local-settings/repair` | OPS-01 | OPS-01 | 启动、诊断、News 修复与旧 Run 显式迁移 |
| `backend/main → dshHttpCreateServer → DshRuntime` | DEV-01 | DEV-01 | 独立 SDK 调试端点 |

运行入口可达的具体实现均落在上述路径。TypeScript 返回对象接口均已追到函数体；没有只以类型声明计覆盖的路径。辅助图 S-01/S-02/D-01/ST-01 解释边界、持久化和状态，不代替时序图。
