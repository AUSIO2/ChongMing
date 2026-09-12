# 图→代码反向还原记录

审查基线：基础 Commit `1ae38fa93d616fb2b32bfa567808b2d7c61d347e`，工作树快照 `cbc2b902e029abb2fca2c960f2e18245ba5a201cd58f2b531366074fbab6a02d`。本记录先按图描述可推导行为，再列源码比对；组织上的独立审查仍需另一位未参与文档编写的审查者完成。

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

- 由图还原：用户提交起点与 until，控制服务解析三阶段配置，Run 组件冻结范围并派生多个 Operation，Host 可从任一运行项领取工作。
- 源码比对：`control.configuration → runCreateRun → runUpdateProgress → workReadItems → GraphStore.claim` 一致。
- 差异：图未画命令回执重放，属于横切机制，在主文说明。

## UC-04-B

- 由图还原：parse 首次读取 Source 正文；Host 执行与续租并行；适配器按 Operation 启动 DSH；插件限制 schema/tool；服务在同一 CAS 保存数据节点、关系、空结果、后继与回执。
- 源码比对：`sourceReadUrl`、`hostRunWork`、`dshRunWork`、插件 guard/schema、`GraphService.propose` 和 `runCreateOutputs` 均有对应消息或 alt。
- 差异：图未展开“Agent 未在最大轮次内提交则继续同 session”的循环；不改变跨组件顺序，trace 记录。

## UC-04-C

- 由图还原：pause 过期租约但保留业务状态；Review 按 Operation 处理 parse/split/verify；暂停中批准仍暂停；resume 重新派生工作。
- 源码比对：`runUpdatePause`、GraphStore pause commit、`runUpdateReview`、`runAnswerReview`、`runUpdateProgress` 一致。
- 差异：无。

## UC-04-D

- 由图还原：Source 经 parse 到 News，News 经 split 到 Claim，Claim 经 verify 到 Verification；until 在对应层停止；有效历史 Operation 可复用，合法空结果不会重复派发。
- 源码比对：`runUpdateProgress`、`runCanReuse`、`runCreateOutputs` 一致。
- 差异：图未展开共享 Claim 不反向扩 scope 的过滤条件，trace 已记录。

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
