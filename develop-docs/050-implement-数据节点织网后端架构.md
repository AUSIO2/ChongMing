# 050 — 数据节点织网后端架构实施原稿

> 多 Host 执行、领取与部署部分结合 [051 实施原稿](./051-implement-多Host协同演进数据图.md) 执行，不再按单 Host 边界落地。

对应设计：[050 数据节点架构](./050-数据节点织网后端架构.md)。本文保留整体功能迁移清单；053–058 已完成共享后端、核查与客户端基线，尚缺的节点驱动闭环按 [059 实施原稿](./059-implement-节点驱动协作闭环与暂停恢复.md) 继续，不重新执行已完成阶段。060补齐管理和文件流转，061接MQ/SSE，062恢复各阶段树，063接执行活动摘要；064已完成第六阶段的旧运行源码/依赖收敛与CLI切换；065新增SQLite独立本机服务入口；066已接Electron本机服务托管，067完成模块边界与运行入口分离；旧Mapper数据导入及其他平台的发行验收仍待后续。

## 1. 完成标准

以数据节点与真实多来源关系为主体，DSH 独占智能体调度；保留现有产品功能并纳入 049 的多人目标。完整性以设计第 13 节对照表及本稿验收场景判断，不以删掉多少文件判断。

## 2. 实施顺序

### 第一阶段：保护基线与验证 DSH

- 保留已有未提交修改，不 reset、清库或覆盖。
- 记录当前测试、类型检查、CLI 和打包基线；区分既有失败与本次回归。
- 在隔离分支做 DSH 最小闭环，锁定可安装版本、公开接口及持久化方案。
- 沿用已验证 DSH SDK，验证多个结构化报告、路由限制、人工确认、Host 重启和旧业务结果复用；不要求模型会话恢复。
- 验证 Host 绑定 operation/角色/slot 和 holder/fence；重新领取未提交工作使用新 Session，业务身份不依赖模型重建。
- 验证 current model/baseUrl、按 Agent 配置、搜索和报告 schema。

退出条件：通过设计第 14 节闭环，尤其是完成报告不重跑及取消后不可落库。未通过不删除旧运行路径。

### 第二阶段：定义数据网和单次原子提交

- 建立 contracts 的有限 Node/Edge 联合；移除主业务 parentId 和位置编码 ID。
- Graph 实现节点/边 CRUD、去重、输入有效性与共享引用处理。
- 三种业务规则只做资格/结果校验和目标后置条件检查。
- Run 内定义业务 operation、Review、候选报告及紧凑接受收据。
- 一个 Map 文档进行 CAS；结果、边、收据和空结果完成标记一起写。
- 规定图大小限制、终结 Run 压缩及收据保留条件。

退出条件：无需模型也能验证多来源编辑、空结果、并发写入、重复提交、取消围栏。

### 第三阶段：接通 Host 与 Control

- Host 统一承担身份/RBAC、业务服务、DSH、数据库和资产目录。
- 保留 Workspace/Agent/prompt/变量/输出预览/模型/工具/DB 设置的现有功能。
- HTTP 命令及 SSE 首帧/更新复用 Graph 服务。
- 完成 asset 上传与 Source 引用、导入导出引用重映射。
- Desktop Main 和 CLI 共用 client；移除客户端 lease 的执行所有权。

退出条件：两个用户可看同一图，写冲突和权限在 Host 生效，来源资产可共享。

### 第四阶段：接通 DSH 根 Agent 和业务工具

- Run 包含 scope.nodeIds/until/operations[]/paused；每次工作领取使用本地 DSH 会话，配置快照装配成 profiles。
- 仅新增项目业务 `data.read / data.propose` 工具；输出按提案类型严格校验。
- 子 Agent 报告、路由/草稿及最终提案使用同一业务写入边界。
- DSH 执行当前工作的模型/工具/SubAgent；不同 Source、News、Claim 的 operation 并行由现有 Host 领取，内部角度并行继续保留。
- 接受产物后从业务事实派生后继，合法零结果写完成记录；按同一图版本检查 scope/until 全部后置条件。
- 现有 Host 循环读取共享业务报告、Review、输入/输出版本和配置指纹继续；未提交工作新 Session 重跑。
- pause/resume 在现有权限事务里写独立 paused 位与收据；pause 原子定向过期本 Run 租约，保留 fence。Review 回答不清 paused。

退出条件：parse/split/verify 均可完成自动/HITL；无 Mongo worker 生命周期、模型请求副本或重试队列。

### 第五阶段：前端与 CLI 切换

- 前端只导入 contracts，用 snapshot 更新正式数据、用 review 更新草稿。
- 多来源图布局支持多入边；Agent 卡片改为显示投影。
- Timeline 只投影业务进度；旧像素坐标不参与后端执行。
- 实现 scope/until、多 operation 进度、暂停/继续/错误/取消和独立多人 Review 冲突显示。
- 既有标签页、节点编辑、Agent 管理、键盘导航和导入导出均完成验收。

退出条件：断开任意客户端任务继续，重连恢复业务状态；前端没有 Agent 调度/Session 恢复逻辑。

### 第六阶段：整体切换与清理

- 显式本机升级工具处理单 operation 旧 Run，默认不动用户数据库；旧 Mapper 数据另作明确导入，不迁移模型执行现场。
- 切换只支持当前 schema；无永久旧字段双读/双写或兼容转发。
- 删除旧 AgentLoop、LangGraph/LangChain/LangSmith、MapperCallRecord、executeCalls 和 stage worker 调度。
- 删除持久化 Timeline 调度字段与客户端 Map lease。
- 删除已失去用途的前端运行状态副本；保留仍有实际用途的 UI 缓存。
- 更新 README、数据备份/恢复、Host 部署和 CLI 使用说明。

退出条件：功能、恢复及构建检查通过；生产只有一条 DSH 执行路径。

## 3. 必须通过的场景

| 场景 | 验收结果 |
|---|---|
| A、B 新闻引用 C，修改 A | 旧 A 出处过期，C 不被误删，未消费 A 的核查保持有效 |
| 修改核查实际读取的证据 | 相关核查显示需复核，旧结果不被当作当前有效 |
| 删除共享来源/重新拆分/Claim 去重 | 其他来源与人工节点保留；无悬空关系、ID 冲突或静默覆盖 |
| News 拆出 0 条 Claim | 记录成功，不重复拆分；until 目标可正确结束 |
| 从已解析 Source 启动核查 | 纳入有效历史产物；共享 Claim 不反向扩张其他新闻 |
| 发现新证据、修改待审路由 | operationId 不变，生成新的草稿/提交身份，旧批准不可复用 |
| 两个同 revision 的用户更新 | 只有一个成功，另一个取得冲突和最新快照 |
| 两个用户回答同一 Review | 只有一个有效决定；编辑草稿后旧批准失效 |
| 决定落库后、下一工作启动前崩溃 | 新领取会话读到同一业务决定，不要求重复批准 |
| 用户拒绝保存且不要求修订 | 不重新枚举该工作，Run 明确未达成，不误报完成 |
| 运行两个子 Agent，一个报告后 Host 崩溃 | 已接受报告不重跑，只继续未满足项 |
| 图已提交、DSH 工具结果未记录时崩溃 | 同身份重试取得原收据，不重复节点 |
| 同一幂等身份提交不同 payload | 明确冲突，不覆盖第一次接受内容 |
| 取消后子 Agent 迟到 | 不新增业务数据；子树关闭；重启后不自动恢复取消 Run |
| Host 正常关闭再启动 | 未完成 Run 可继续，与用户取消区分 |
| 模型 idle 或全部已登记项完成但后继未达成 | 按 scope/until 闭包重算，不提前 completed |
| 快速 pause→resume，旧 Host 仍计算 | 旧 grant 不能续租/提案/fail；新领取 fence 递增 |
| 一个 operation 待审 | 其他独立节点继续；暂停后批准不清 Run.paused |
| SSE 建立过程中发生提交 | 基线/后续快照无缺口，重连可恢复 |
| Viewer 写入、跨 Workspace 访问 | Host 拒绝；Activity 不泄露内部凭证和非授权数据 |
| 导出后导入新工作区 | 节点关系和资产可用；旧活跃 Run/Session 不被重新执行 |
| NewsContext 字段不对 AI 可见 | 根与子 Agent 都读不到该字段 |

用现有 Vitest 与有针对性的 DSH 集成检查，优先扩展真实行为断言，不为目录移动复制测试。

## 4. 校验与交付

```bash
npm test
npx vue-tsc --noEmit
npm run headless -- --help
npm run build:check
```

Host/DSH 测试沿用现有 tests/backend；059 完成后记录实际新增范围与运行结果，不将历史记录当成本轮通过。

审查生产 imports 和字段，确保没有旧 AgentLoop、MapperCallRecord、checkpointTail、自建 worker 调度或前端 DSH 依赖。历史文档不作为静态删除对象。

本原稿不承诺未经验证的工期或删行数。第一阶段结论决定接入成本，其余阶段按可独立验收的业务结果提交。
