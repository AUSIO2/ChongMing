# 075 — Graph功能点重构与审核清单

日期：2026-09-16。状态：功能盘点与代码量估算完成，未实施任何功能重构。

[逐项执行与审核状态](./075-implement-Graph功能点重构与审核.md) · [开发规范](../coding.md) · [072总计划](./072-可读性与服务结构重构.md)

## 1. 范围与计数口径

本清单覆盖backend/modules/graph现有六个文件，按功能逐个重构、逐个审核，不以文件改名、拆出类或排版作为完成标准。

| 文件 | 物理行数 |
|---|---:|
| graph-service.ts | 542 |
| run-state.ts | 303 |
| graph-input.ts | 83 |
| graph-record.ts | 45 |
| work-state.ts | 36 |
| work-activity.ts | 24 |
| 合计 | 1,033 |

物理行包含类型、导入、注释和空行；扣除空行、纯注释后约946行。对应graph/ run/ node-run/ work四个测试文件共1,066行，不包含共享fixture和跨模块集成测试。

下表“现有主体”是当前独占代码片段的物理行分配，不把共享函数反复计入：17项合计868行，另有165行共用查找/输入前置、类型、导入、分发外壳和零散注释空行，合计仍为1,033。内部函数已包含在外层片段时不再次累加。

“单项改动范围”是实施前对需修改/新增的实现范围的粗估，包含为可读性展开和必要内部提取，可能包含对共用代码的少量调整；不等于净新增行数、不等于Git加减行之和，也不包括测试和图目录外代码。各批次可重复触及共用代码，不能相加当作最终总量。实际范围以该项设计后的差异为准，行数不作质量指标。

默认复用现有测试；多数项测试修改暂按0–60行预留，租约/并发/历史重放项按0–120行预留，只补真实缺口，不为了达到估算新增测试。

## 2. 功能点和代码量

| 编号 | 功能点 | 现有主体（行） | 单项改动范围估算（行） | 审核重点 |
|---|---|---:|---:|---|
| G01 | 暂停、恢复与取消Run | 30 | 60–120 | 保留报告/审核；恢复不复活旧租约；取消不能被迟到失败覆盖 |
| G02 | 创建Run与冻结执行范围/配置 | 23 | 40–80 | 活动Run互斥、Run ID不复用、scope合法、配置冻结、旧Run入历史 |
| G03 | 发现后继节点、建立Operation、汇总运行状态 | 52 | 100–180 | scope/until正确；各新闻/事实独立推进；共享节点不反向扩张 |
| G04 | 复用历史产物与强制重新生成 | 15 | 30–60 | 输入/配置/产物版本匹配；产物关系仍存在；空产物与regenerate语义 |
| G05 | 节点、意见及来源字段输入校验 | 83 | 100–160 | 五类节点字段、URL/时间/评分/意见合法；空News.context保持 |
| G06 | 手动修改图、节点和关系 | 128 | 150–240 | 节点类型不可变；同删同写/重复ID拒绝；级联删边和关系方向正确 |
| G07 | 创建/读取/删除图及查询历史Run | 74 | 90–150 | 重复创建、删除墓碑、活动Run限制、列表与历史Run查询 |
| G08 | 公共收据、输入摘要、幂等和版本提交 | 83 | 110–180 | 相同ID不同输入冲突；合法重放先于版本；返回实际获胜产物ID |
| G09 | 生成可执行Work、阶段身份和优先级 | 36 | 60–100 | parse/router/worker/merge阶段一致；槽位优先级；稳定工作身份 |
| G10 | Work领取、状态查询、续租和释放 | 42 | 80–140 | claimed/busy/obsolete；同持有者重领；固定fence；有界争用 |
| G11 | 投影工作输入、过滤上下文并冻结来源正文 | 50 | 90–150 | 只暴露可见上下文；首次来源读取冻结；I/O回来后重新校验租约 |
| G12 | 接纳解析草稿、路由和分槽报告 | 48 | 100–180 | parse/router/worker权限；路由能力和数量；每个槽位一份报告 |
| G13 | 汇总校验、产物入图和来源追溯 | 81 | 130–220 | 报告集完整且恰好一次；候选索引；产物关系和producer来源 |
| G14 | 创建/编辑/批准/拒绝人工审核 | 48 | 80–140 | 路由/结果两次审核；review版本；暂停时审核；并发批准只接纳一次 |
| G15 | 提案原子提交、并发重试和历史重放 | 32 | 60–110 | 同提案重放；跨Run/租约/旧节点删除确认；拒绝未提交旧工作 |
| G16 | 记录Work失败并阻止继续提交 | 19 | 40–80 | 失败请求幂等；已接纳工作不能后补失败；阻止兄弟写入 |
| G17 | 验证并投影临时执行活动 | 24 | 40–70 | 有效租约且工作仍可执行；活动不改变图revision或泄露执行正文 |
| — | 共用前置、类型/导入和分发骨架等 | 165 | 随所属批次核算 | 不复制共享规则，不另加空转发层 |
| 合计 | 当前graph目录 | 1,033 | 不以各项改动估算相加推导 | 行数用于控制审核范围 |

G03“推进后继”与G04“复用历史成果”分别审核；G04允许新Run利用旧产物，G15确认旧请求已成功，是不同规则。G08是横切的公共提交基础，G15是在该基础上的Work提案授权/重试/历史确认。

G12与G13按“接纳草稿/路由/报告”和“完整汇总/正式产物”划分，覆盖parse、split、verify三种处理。审核时三个分支分别列证据，不能只跑一种核查流程就称全部通过。

## 3. 每项的具体入口和验证

本节行号只对应盘点当日，函数重构后应以名称和该项实际差异定位；不要求为了保持行号而限制改动。测试短名默认在tests/backend/modules/graph，带其他目录的名称表示协作验证。

### G01 暂停、恢复与取消Run

- 入口：runUpdatePause、runCancelRun、dispatch的run.pause/run.resume/run.cancel。
- 本项审核：保留报告/审核；恢复不复活旧租约；取消不能被迟到失败覆盖。
- 现有验证入口：node-run、run、work；storage/sqlite与sqlite-integration。
- 当前独占片段：graph-service.ts 353–365行；run-state.ts 192–208行。

### G02 创建Run与冻结执行范围/配置

- 入口：runCreateRun、dispatch的run.start。
- 本项审核：活动Run互斥、Run ID不复用、scope合法、配置冻结、旧Run入历史。
- 现有验证入口：run、node-run。
- 当前独占片段：graph-service.ts 345–351行；run-state.ts 175–190行。

### G03 发现后继节点、建立Operation、汇总运行状态

- 入口：runUpdateProgress（除历史复用段）、runReadConfiguration。
- 本项审核：scope/until正确；各新闻/事实独立推进；共享节点不反向扩张。
- 现有验证入口：node-run；storage/sqlite-integration。
- 当前独占片段：run-state.ts 32–43、95–118、123–138行。

### G04 复用历史产物与强制重新生成

- 入口：runCanReuse、runUpdateProgress内的历史查找段。
- 本项审核：输入/配置/产物版本匹配；产物关系仍存在；空产物与regenerate语义。
- 现有验证入口：node-run（空输出、复用）；需在实施时核对每个失效条件的用例。
- 当前独占片段：run-state.ts 82–92、119–122行。

### G05 节点、意见及来源字段输入校验

- 入口：graphInputReadNodeData、graphInputReadReport。
- 本项审核：五类节点字段、URL/时间/评分/意见合法；空News.context保持。
- 现有验证入口：graph；assets与client/graph-client的合同回归。
- 当前独占片段：graph-input.ts 1–83行。

### G06 手动修改图、节点和关系

- 入口：graphUpdateChanges、graphReadUnique、dispatch的graph.apply。
- 本项审核：节点类型不可变；同删同写/重复ID拒绝；级联删边和关系方向正确。
- 现有验证入口：graph；图编辑细分约束实施前逐项核对覆盖。
- 当前独占片段：graph-service.ts 101–107、110–210、389–408行。

### G07 创建/读取/删除图及查询历史Run

- 入口：graphReadMap、read、dispatch的map.create/map.delete。
- 本项审核：重复创建、删除墓碑、活动Run限制、列表与历史Run查询。
- 现有验证入口：graph、run；必要时application级授权测试。
- 当前独占片段：graph-service.ts 218–224、251–260、270–311、329–343行。

### G08 公共收据、输入摘要、幂等和版本提交

- 入口：storeFormatCanonical/storeCreateInputHash、graphReadReceipt、graphCreateReceipt、graphCreateWriteResult、graphCommit及dispatch公共版本/收据段。
- 本项审核：相同ID不同输入冲突；合法重放先于版本；返回实际获胜产物ID。
- 现有验证入口：graph、run、work；storage/sqlite。
- 当前独占片段：graph-record.ts 32–44行；graph-service.ts 65–98、227–247、313–327行。

### G09 生成可执行Work、阶段身份和优先级

- 入口：workReadItems、runReadPhase、runReadProposalId。
- 本项审核：parse/router/worker/merge阶段一致；槽位优先级；稳定工作身份。
- 现有验证入口：node-run、run、work。
- 当前独占片段：work-state.ts 8–27行；run-state.ts 65–80行。

### G10 Work领取、状态查询、续租和释放

- 入口：workReadGrant、dispatchWork的claim/read/renew/release。
- 本项审核：claimed/busy/obsolete；同持有者重领；固定fence；有界争用。
- 现有验证入口：work、node-run；storage/work-replica与sqlite。
- 当前独占片段：graph-service.ts 413–447行；work-state.ts 30–36行。

### G11 投影工作输入、过滤上下文并冻结来源正文

- 入口：graph-service.readData、runReadData。
- 本项审核：只暴露可见上下文；首次来源读取冻结；I/O回来后重新校验租约。
- 现有验证入口：work、node-run；adapters/sources/http-source与storage/sqlite-integration。
- 当前独占片段：graph-service.ts 470–504行；run-state.ts 234–248行。

### G12 接纳解析草稿、路由和分槽报告

- 入口：runValidateSlots、runUpdateProposal的公共输入、parse、route与report/split-report分支。
- 本项审核：parse/router/worker权限；路由能力和数量；每个槽位一份报告。
- 现有验证入口：run、node-run；execution/dsh-business、dsh-verify。
- 当前独占片段：run-state.ts 45–58、250–283行。

### G13 汇总校验、产物入图和来源追溯

- 入口：runUpdateProposal的merge/split-merge、runCreateOutputs及其内部函数、graphReadSnapshot。
- 本项审核：报告集完整且恰好一次；候选索引；产物关系和producer来源。
- 现有验证入口：run、node-run；client/layout和storage/sqlite-integration。
- 当前独占片段：run-state.ts 140–173、284–303行；graph-service.ts 36–62行。

### G14 创建/编辑/批准/拒绝人工审核

- 入口：runCreateReview、runUpdateReview、runAnswerReview和dispatch的review.update/review.answer。
- 本项审核：路由/结果两次审核；review版本；暂停时审核；并发批准只接纳一次。
- 现有验证入口：run、node-run。
- 当前独占片段：run-state.ts 60–63、210–232行；graph-service.ts 367–387行。

### G15 提案原子提交、并发重试和历史重放

- 入口：graph-service.propose。
- 本项审核：同提案重放；跨Run/租约/旧节点删除确认；拒绝未提交旧工作。
- 现有验证入口：run、work；storage/work-replica。
- 当前独占片段：graph-service.ts 507–538行。

### G16 记录Work失败并阻止继续提交

- 入口：dispatchWork的fail。
- 本项审核：失败请求幂等；已接纳工作不能后补失败；阻止兄弟写入。
- 现有验证入口：work；execution/host用于错误分类协作回归。
- 当前独占片段：graph-service.ts 448–466行。

### G17 验证并投影临时执行活动

- 入口：activityReadRecord。
- 本项审核：有效租约且工作仍可执行；活动不改变图revision或泄露执行正文。
- 现有验证入口：adapters/messaging/messaging；execution/activity用于活动脱敏协作回归。
- 当前独占片段：work-activity.ts 1–24行。


## 4. 图目录外必须一起核对的协作者

| 协作者 | 谁负责什么 | 本轮处理原则 |
|---|---|---|
| [graph-application.ts](../backend/application/graph-application.ts)、identity与workspace | 用户身份事务、工作区权限、按用户隔离requestId、解析工作区配置 | graph的审核要追踪入口，不能把鉴权保证全算成graph内部能力；仅必要调用适配进入该项差异 |
| [GraphStore](../backend/ports/graph-store.ts)及Mongo/SQLite | 真正的CAS、租约过期/fence原子验证、暂停时租约失效、收据落库 | 保留两种adapter的真实行为测试；不能只通过graph内mock宣布安全 |
| assets / HTTP来源读取 | 读取字节、来源约束与访问策略 | G11负责冻结读取结果；实际网络访问约束由来源module承担 |
| 消息、Outbox、SSE | 发布通知、初始快照和实时更新 | graph维护数据和调用port，不能改成依赖消息只投一次 |
| Host / DSH | 领取循环、续租、模型执行、取消与错误分类 | graph不调用模型；G16失败记录与Host错误分类分开 |
| UI图布局 | 阶段树、意见显示、视口和选择 | G13产物与血缘变更需要布局回归，界面逻辑本身不在graph重构范围 |

如一项必须改变目录外的业务语义，应先记录依赖和扩展范围；不能把跨模块修改隐含进“graph只有30行”的估算。

## 5. 推荐执行顺序

先冻结G08/G09及存储租约的既有行为为审核基线，不先重写这些共享实现。

实施顺序：

1. G01 暂停/恢复/取消，作为第一项。
2. G02 启动运行 → G03 节点推进 → G04 历史成果复用。
3. G09 待执行工作 → G10 租约操作 → G11 输入投影与来源冻结。
4. G12 草稿/路由/报告接纳 → G13 汇总和正式产物 → G14 人工审核。
5. G15 提案提交/历史重放 → G16 失败记录 → G17 临时活动。
6. G05 输入校验 → G06 手动编辑 → G07 图生命周期/查询 → G08 公共提交逻辑收口。

顺序表示主要修改对象，不表示可以等到最后才运行依赖项测试。例如G01必须用G09的“不再生成可执行工作”和存储的“旧grant失效”验证；G14调用G13的产物逻辑时，应复跑对应验证。

如果单项差异超出估算，应先说明原因，按业务行为继续拆小批次；不把一次共享函数修改分散为几个看似独立、各自不完整的提交。

## 6. 第一项G01的具体范围

- 改动中心：runUpdatePause、runCancelRun以及graph.dispatch对应分支。
- 只读追踪：runUpdateProgress、workReadItems、Receipt公共前置、application鉴权事务和两种GraphStore提交实现。
- 预估主要源码改动60–120行；共用函数如确需修改，必须标明影响其他哪些功能点。
- 审核案例：暂停保留产物/审核；恢复仍是同一Run；暂停期间不领取新Work；暂停期间允许按既有规则审核；暂停后立即恢复拒绝旧grant；取消阻止迟到提交；重复请求不重复改变业务状态。
- 交付：业务主流程说明、差异、复用/补充测试结果、未解决问题和审核结论。不顺带重写整个run-state.ts。

## 7. 单项完成定义

每项都走“读现状与不变式 → 限定实际差异 → 重构 → 相关验证 → 审核”的完整流程，重构状态与审核状态分别记录。

审核包含三类证据：

- 行为：对外输入/输出、错误顺序、幂等和并发语义保持。
- 可读性：主要步骤可顺读；名称和中文用途说明真实；调用方不需要新增隐含顺序知识。
- 影响范围：指出实际改动文件与行数，任何共用实现变化列出受影响功能；已有测试不是只改期望值来迎合实现。

这一轮只有盘点和清单，不标记任何G项“重构完成/审核通过”。本清单细化072的graph相关阶段，不替代其他module的计划。
