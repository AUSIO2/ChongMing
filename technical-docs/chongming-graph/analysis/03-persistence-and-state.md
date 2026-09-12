# 持久化与状态证据

## Entity 清单

| Entity | 集合 | 主键/索引证据 | 主要读写 | 主文落点 |
|---|---|---|---|---|
| 图文档（GraphDocument） | `graphv3` | `_id`；`workspaceId` 索引 | GraphStore create/read/list/commit/claim/renew | 附录 A.1 |
| 用户（UserDocument） | `control_users` | `_id`；`hostAdmin+disabled` 索引 | Auth create/enable/disable/read | 附录 A.2 |
| 访问令牌（TokenDocument） | `control_tokens` | `_id`；hash 唯一索引 | Auth create/read/revoke/transact | 附录 A.3 |
| 管理围栏（control_admin 文档） | `control_admin` | 固定 `_id=root` | 用户管理事务递增 writeFence | 附录 A.4 |
| 工作区（WorkspaceDocument） | `control_workspaces` | `_id`；成员+更新时间+ID 索引 | Control create/read/commit/delete | 附录 A.5 |
| Agent 库（LibraryDocument） | `control_library` | 固定 `_id=global`；revision 索引 | seed/list/agent dispatch/copy | 附录 A.6 |
| 集群设置（SettingsDocument） | `control_settings` | 固定 `_id=global`；revision 索引 | seed/bootstrap/update/config resolve | 附录 A.7 |
| 个人偏好（PreferencesDocument） | `control_preferences` | `_id=user:workspace`；userId+workspaceId 唯一 | workspace view/preferences.set | 附录 A.8 |
| 资产元数据（AssetDocument） | `control_assets` | `_id`；uploadKey 唯一稀疏；workspace+state | upload/read/content/delete/export | 附录 A.9 |
| 资产命令回执（AssetReceipt） | `asset_receipts` | `_id`；userId+workspaceId 索引 | delete/import 幂等 | 附录 A.10 |

GridFS `asset_blobs.files/chunks` 由驱动管理，当前代码只持有 blob ObjectId，不声明其完整 Entity 类型；作为基础设施资源记录，不冒充应用 Entity。Graph 节点、边、Run、lease 和回执都嵌入 GraphDocument，不单列持久化 Entity。

## 状态机

### Run 与多个 Operation

- Run 初始保存 `scope.nodeIds`、`until`、`regenerate`、冻结配置和空 `operations[]`；`runUpdateProgress` 从同一图快照派生 parse/split/verify Operation。
- 每个 Operation 独立处于 running/waiting/completed/failed/cancelled；一个 Operation 待审不阻止其他 Operation 执行。
- Run 从全部 Operation 聚合：存在 failed 为 failed；否则存在 running 为 running；否则存在 waiting 为 waiting；闭包内全部完成为 completed。
- `paused` 与业务状态正交；pause 保留 Operation/Review/报告，同时在提交中定向过期当前 Run 的 lease。
- cancel 把 Run 及仍活动的 Operation 写为 cancelled；Host 不可恢复错误把 Run 写为 failed。

### Review

Review 属于 Operation。`pending → answered` 仅由 `runAnswerReview`；回答记录 decision、answeredAt 并增加 revision。parse/split/verify 的 result 均可待审，split/verify 另有 route Review。暂停中可以回答，批准不会清除 paused。

### Asset

上传物理 blob 后，在授权事务中发布 `ready` 元数据；逻辑删除写 `deleted` 与 deletedAt。未发布/确定回滚的 blob 会清理，提交结果未知时保留私有 blob，避免误删已提交对象。

### Workspace/Map 删除

两者使用 tombstone；Workspace `deletedAt` 为 nullable string，Graph `deletedAt` 为可选日期/字符串投影。正常查询排除 tombstone；不物理级联删除。

### Lease

lease 嵌入 Graph，以 holderId + 单调 fence + expiresAt 确认所有权。claim 只为未暂停 Run 领取工作；renew 延长；release 把到期时间置为 epoch；最终 proposal commit 同时匹配 lease、fence、到期和 `run.paused=false`。pause 在授权事务中原子过期该 Run 的 lease。
