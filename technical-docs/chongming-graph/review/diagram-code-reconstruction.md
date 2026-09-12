# 图→代码反向还原记录

审查基线：`b5b6df5af5367b1147f0311c6fe96f1cf0fbf903`。本记录先按图描述可推导行为，再列源码比对；组织上的独立审查仍需另一位未参与文档编写的审查者完成。

## UC-01

- 由图还原：客户端先鉴权，再读取控制数据；打开 Map 时重新校验 Workspace 权限；Mongo 承担 token、成员、偏好和图读取。
- 源码比对：`apiCreateServer → ApplicationService.read → AuthService.read → ControlService.read/GraphService.read` 一致。
- 差异：图把两个用户请求连画，未展开分页游标和偏好 CAS；trace 已覆盖，主图保持可读。

## UC-02

- 由图还原：管理命令进入认证事务，锁定 token/用户后检查角色、作用域版本和回执；重放、首次提交和冲突互斥。
- 源码比对：`AuthService.transact` 与 `ControlService.dispatch` 一致；共享库和设置也使用同一分支结构。
- 差异：无影响结论的顺序差异。

## UC-03

- 由图还原：先权限与资产引用，后读图/回执；重放不再执行，首次变更校验闭包并 CAS 提交。
- 源码比对：`ApplicationService.dispatch`、`GraphService.dispatch`、`graphUpdateChanges`、`GraphStore.commit` 一致。
- 差异：创建 Map 的 Workspace revision 分支在图中归入“版本不匹配”；语义一致。

## UC-04-A

- 由图还原：用户启动后，控制服务解析配置，Run 组件冻结配置/输入，Host 从图状态派生 route 工作并取得租约。
- 源码比对：`control.configuration → runCreateRun → workReadItems → GraphStore.claim` 一致。
- 差异：图未画命令回执重放，属于横切机制，在主文说明。

## UC-04-B

- 由图还原：Host 先确认工作，执行与续租并行；适配器读取授权数据并启动 DSH；插件限制工具、提交 proposal；服务做作用域/lease/CAS 检查；结束后关闭运行时和释放。
- 源码比对：`hostRunWork` 的 deadline/renew/race、`dshRunWork` 的 patch/round/close、插件的 guard、`GraphService.propose` 的 64 次 CAS 均有对应消息或 alt。
- 差异：图未展开“Agent 未在最大轮次内提交则继续同 session”的循环；不改变跨组件顺序，trace 记录。

## UC-04-C

- 由图还原：route 可选编辑；所有回答都校验 Map/Review/输入版本；三种结果为失败、恢复运行、生成结论并完成。
- 源码比对：`runUpdateReview`、`runAnswerReview`、`runCreateVerification` 一致。
- 差异：无。

## UC-05

- 由图还原：字节先入 GridFS 并校验，再在重新授权事务中发布 ready；确定失败清理；删除校验引用后写 tombstone。
- 源码比对：`AssetsService.upload/delete` 一致。
- 差异：下载路径未单独画消息；技术审查保留为低信息密度已覆盖入口。

## UC-06

- 由图还原：快照导出闭包；导入先验证/重映射，再准备 blob，最后事务发布；确定回滚清理。
- 源码比对：`exportMap/exportWorkspace/importWorkspace` 与 `bundlesReadWorkspace/bundlesCreateImport` 一致。
- 差异：图未展开 MapBundle 与 WorkspaceBundle 两个解析分支，主文说明其结果差异。

## OPS-01

- 由图还原：CLI 先读本机配置，再按管理、数据库、修复、本机写入四类动作执行；返回脱敏结果。
- 源码比对：`adminRunCommand` 的命令分支一致。
- 差异：endpoint.test、assets.cleanup 归入管理动作，没有逐一画出网络 HEAD/LLM 与 GridFS 删除消息。

## DEV-01

- 由图还原：HTTP prompt 进入 SDK，通知逐条 NDJSON，最后输出 result。
- 源码比对：`dshHttpCreateServer → DshRuntime.run → DeepSeekHarness.run` 一致。
- 差异：headersSent 后的 error 行未画，trace 已记录。

## 复审结论

作者自审未发现图与代码相反的控制流。正式“独立技术审查”未满足人员独立性，因此生产包状态保持候选，不标记正式发布。
