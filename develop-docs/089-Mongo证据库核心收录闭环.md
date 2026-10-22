# 089 Mongo 证据库核心收录闭环

日期：2026-10-06。状态：本阶段核心实现与自动验证完成。承接 [084 计划](./084-workspace证据库实现计划.md) 和 [086 测试先行](./086-证据库独立测试与压测用例.md)。

## 范围与验收

实现 evidence.collect/get/search/withdraw，沿用 MongoDB、现有身份/工作区授权和 StorageSession。固定保存 Claim、范围、依据、收录人和数字 0/1；无固定字段更新接口。只运行已实现的核心用例及适当集成回归，不运行完整压测，不提前实现匹配、Host/Work 接入、替代、证据集和导入导出。

闭环验收：显式收录正确/错误陈述，保留原文；按身份和分页查询；撤回后默认搜索排除，历史按原身份可读。权限、幂等、业务去重键、固定内容及库事务组合同时验证。

## 契约与存储

公共契约在 contracts/evidence-library.ts。库模块使用现有 Persistence 管理 evidence_entries、evidence_receipts、evidence_catalogs 与冻结附件引用；有界查询由 ports/evidence-query.ts 和 Mongo adapter 实现。条目内部增加 dedupKey、fingerprint、tokens 用于查询，不对客户端公开。

| 操作 | 权限与输入 | 结果 |
| --- | --- | --- |
| evidence.collect | editor；精确 Claim 引用、固定 0/1、范围、理由和显式依据 | 固定条目、replayed/existing 与相反判断冲突身份 |
| evidence.get | viewer；workspaceId、entryId | 当前管理状态与原固定内容，撤回后仍可读取 |
| evidence.search | viewer；关键词、0/1、主体/事件、状态与游标 | 摘要页、nextCursor、libraryRevision；默认 25、最多 100 |
| evidence.withdraw | editor；entryId、expectedRevision、理由及 requestId | 撤回条目；固定内容、判断、摘要与附件引用保留 |

关键词以 Unicode 字母数字连续词、汉字单字/双字建立索引，全部查询词项需匹配；空关键词浏览库，纯标点非空关键词返回空页。这是词项检索，适用性或语义匹配待后续实现。持久化条目读取校验固定结构与内容摘要，损坏记录返回受控 EVIDENCE_RECORD_INVALID。

精确重复键包含 workspace、原 Map/Node/revision、范围、0/1 和依据摘要；相反判断按同文/范围的 fingerprint 返回冲突身份。库目录 revision 随新增或管理状态变化递增，分页游标绑定 workspace、筛选摘要、目录 revision 和排序位置。

收录在授权事务中先查用户/requestId 收据；合法重放返回原结果，仅新请求解析输入并校验源 Claim、定义、版本和依据。来源只读快照和库写入共享会话；撤回也有版本与幂等收据。业务词项及附件引用随条目原子写入；物理索引在初始化执行。

## 运行装配与限制

应用层暴露四个新方法并装配 Mongo query adapter，HTTP/公共客户端同步白名单、输入及结果校验。本机 SQLite 未适配时返回明确不可用，不把 Mongo 驱动引入本机依赖闭包。新库不产生独立 Evidence 节点，不改写工作区已保存的不可变类型，不发布软件新版本。

收录采用现有实际 Claim 类型，083 默认定义反复回写问题不在本轮继续调查；本轮代码不依赖独立 Evidence 类型。附件通过现有资产校验，删除入口增加库引用保护，以免冻结材料丢失。

## 验证与分工

业务、Mongo 查询、真实测试接入分别按文件分工；公共契约、应用/传输装配、架构检查和最终验证由主线程协调。保持已有其他未提交修改，不重置或覆盖。

真实测试工厂使用 MongoMemoryReplSet 和现有身份/图服务，接入层不实现库规则。未实现的动作明确报 NOT_IMPLEMENTED，筛选核心用例运行，不将未实现组自动跳过为通过。记录首次失败、修复复跑、核心用例数量、真实 Mongo 与静态检查结果及未验证项。
