# 052 — 代码复核与实现架构实施原稿

对应 [架构/函数总表](./052-代码复核与实现架构.md)、[完整接口文档](./052-完整接口文档.md) 和 [类型契约](./052-接口契约.ts)。第一阶段DSH封装、第二阶段数据图已完成。第三阶段最初的固定两个报告方案已由 [053 动态核查路由](./053-动态核查路由.md) 替换：路由Agent按Claim选择自定义Agent/tool和角度，DSH委派各slot，独立汇总Agent提交结论，人工模式审核路由与结果。当前实现接口以 [054 接口文档](./054-接口文档.md) 为准。正式鉴权、资产管理界面与旧前端接线尚未实施。

**用户最新决定：从零重写，先将DSH封装成可独立调用的接口。** 第一期只固定智能体执行边界，再建设数据图与业务运行，最后接多Host。旧源码仅用作功能检查依据；新后端不import旧Mapper、旧AgentLoop或旧后端服务。

054进度：已继续实现[自动执行与多Host租约](./054-自动执行与多Host租约.md)，当前协议以[054接口文档](./054-接口文档.md)为准。产品SSE/Activity与旧前端接线仍在第6阶段。

最终产品接口规模为9个查询、23个命令；独立DSH封装是后端内部能力，不计入这些产品命令。数据图阶段实现一个graph.apply变更校验/提交路径，不恢复旧node/edge/policy各自独立的处理链。

原生Agent/SubAgent/Session/provider直接装配，先用一个简单测试工具验证扩展注册。data.read/propose业务接入模块在Graph出现后接入；Tavily仅在现成provider不满足时补适配，不把Graph/claim/Review存储插件化。

## 1. 依赖顺序

| 阶段 | 实现内容 | 出口 |
|---|---|---|
| 0 | 保护现有代码/数据，确定新backend目录、独立DSH配置/会话目录及锁定版本 | 不覆盖旧工作树和数据；不做兼容层 |
| 1 | DSH官方SDK封装：start/run/close、命名Session、通知流、薄本机HTTP | 不依赖Graph/Mongo即可初始化、运行、观察、延续命名Session和关闭 |
| 2 | 数据图服务：Map/Node/Edge、graph.apply、版本/CAS/请求幂等、薄HTTP | 人工构建共享数据图、并发编辑、重放、重启持久化可验收 |
| 3 | 业务运行接入DSH：Run/operation、候选报告/Review/收据、实际读集、data.read/propose | 已有Claim→动态路由→各角度报告→汇总/人工确认→结果接受 |
| 4 | 多Host执行：领取/续租/fence、工作发现与终态、接管、共享通知 | 两Host并行同图；旧fence拒绝、取消与响应丢失恢复通过 |
| 5 | auth/Control/资产：成员、共享Agent库、副本、偏好、secret/admin、GridFS/v3包 | 共享配置/资产及管理能力闭合 |
| 6 | 补齐parse/split/verify、产品SSE/Activity代理、Client/Desktop/CLI/Vue | 全部用户业务流程与现有功能清单通过 |
| 7 | 需要时导入旧业务数据，正式切换并删除旧运行入口 | 产品只使用新后端，完成部署/回归文档 |

第一阶段产出是后续正式复用的DSH执行封装，不是新的AgentLoop框架或只有假执行器的服务。直接针对锁定的DSH公开API实现，不提前建立Graph/Run/多Host租约依赖。

### 第一阶段：DSH执行接口

唯一目标：调用方无需了解DSH装配细节，就能在命名Session运行任务、观察根/子Agent通知并正确关闭SDK进程。官方SDK协议未提供冷会话读取和单Session取消；一期不伪造这两个能力。

| 交付 | 范围 |
|---|---|
| DshRuntimeAPI | start/run/close三方法；run接受可选sessionId和事件回调，返回idle区间的最终响应/事件 |
| 本机HTTP | health与POST /runtime/dsh/run；NDJSON逐行输出事件和最终result；close只由生命周期调用 |
| profile | 服务器端不可变版本配置；API选profileId，key不经过调用方请求或响应 |
| 原生执行 | 文本任务、至少一个工具、两个continuable子Agent；复用DSH委派与会话，不自建worker队列 |
| 持久状态 | 会话/inbox/工具消息使用原生持久化与flush；不自建第二份对话账本 |
| 上下文管理 | 配置原生token-meter、compaction及需要的tool-result-pruner，自动计量/裁剪/摘要；不由业务代码维护滚动对话摘要 |
| 事件 | 首帧快照，随后文本/工具/状态/错误；根idle与子Agent运行分别可见 |

最小目录：

```text
contracts/dsh.ts          start/run/close的DTO与事件
backend/dsh.ts            原生DSH装配、会话/消息/取消封装
backend/dsh-http.ts       loopback HTTP与SSE映射
backend/main.ts           本期只装配DSH服务、优雅关闭
tests/backend/dsh.spec.ts 原生测试provider与真实模型smoke
```

核心实现函数：dshCreateRuntime及其start/run/close实现、dshReadEvent、dshHttpCreateServer。业务层未来的dshRunOperation只调用这套封装，不重新启动另一条Agent路径。

验收：

1. start能装配并完成官方SDK initialize；close幂等并确认子进程退出。
2. run发送文本并收到真实模型输出及通知；HTTP在执行中输出NDJSON事件，最终result不冒充单prompt因果结果。
3. 使用相同sessionId的后续run延续历史；省略sessionId得到新会话。
4. profile启用子Agent时，通知能识别根与后代；根idle不被业务层误当作整图完成。
5. 跨进程使用同一sessionId实测应记录SDK能力结果：当前版本返回session already exists，故一期明确不支持；不自建消息副本绕过。
6. 真实模型smoke已通过：单轮返回PONG，同进程第二轮仍返回PONG；无凭证CI继续只验证初始化、HTTP、类型和事件转换。
7. 子Agent smoke已通过：观察到2个started、2个finished并汇总AB。
8. profile配置已确认装配token-meter/compaction/pruner；仍需用小上下文预算实际触发摘要/裁剪后才能标记运行验收完成。

官方高层run等待receipt-to-idle区间并返回最后一个root assistant响应；它没有每prompt因果结果、调用方messageId或单会话cancel。普通工具临时value不作为通用structuredResult；业务结构化报告、幂等业务身份和人工Review在第三阶段引入。

第一阶段不引入社区长期记忆插件。官方SDK持久化了会话日志，但当前SDK协议无法跨进程恢复已有Session，不能把磁盘存在写成可用恢复能力；多Host接管依赖后续共享业务报告，未落库推理允许重做。上下文计量/压缩按实际触发测试验收。长期跨会话记忆尚未选型，后续还需明确user/workspace隔离、共享存储与更新冲突。

### 第二阶段：可运行的数据图服务

唯一目标：通过HTTP创建、读取和修改一张真实持久化的数据图。先用人工News/Claim和多来源关系验证内核，不调用模型，不创建假Run、假Agent报告或假核查结论。

实现范围：

| 内容 | 数据图阶段做到什么 |
|---|---|
| 领域类型 | Map、Node、Edge、稳定UUID、Map/节点版本；本阶段实际支持News/Claim及其合法关系 |
| 图编辑 | nodes/edges/name的graph.apply，明确变更集，最终图引用校验、派生环拒绝、一次原子接受 |
| 删除语义 | 清理节点原有关联展示边，保留被其他来源共用的节点；必要历史/缺失输入可追溯 |
| 持久化 | 显式连接选定Mongo，重启可读；连接失败明确失败，不fallback到memory |
| 并发与重放 | expectedRevision冲突、requestId幂等/异payload冲突；节点、边、版本和请求收据同次保存 |
| 可调用入口 | query: map.list/map.get；command: map.create/map.delete/graph.apply；health检查 |
| 开发身份 | 显式seed一个开发Workspace和身份，由Host注入；仅loopback开发入口，不冒充已经完成正式鉴权 |

数据图阶段的快照中run为null、reviews/policies为空，这是没有对应数据的合法状态。尚未交付的政策编辑、其他节点能力、运行和管理命令明确报未支持；不得返回空成功结果假装已实现。此阶段交付完整产品v1契约的明确子集，最终接口/类型目标不变。

最小目录和职责：

```text
contracts/graph.ts        必要的数据与图编辑DTO
backend/main.ts          启动、关闭、显式开发配置
backend/api.ts           薄HTTP路由、校验、错误与响应
backend/graph.ts         图编辑与引用规则、快照
backend/store.ts         Mongo模型、读取、字段级CAS
tests/backend/graph.spec.ts  真实HTTP/数据库闭环
```

数据图阶段实现applicationCreateHost/applicationDeleteHost、apiCreateServer/apiReadQuery/apiDispatchCommand/apiWriteError、graphReadGraph/graphUpdateGraph/graphReadSnapshot、storeCreateConnection/storeReadGraph/storeReadGraphs/storeCommitGraph/storeDeleteConnection的必要部分，不创建其他空服务文件。

验收脚本必须顺序证明：

1. 创建图，用一次graph.apply创建新闻A、新闻B、事实C及两条来源关系。
2. 修改和读取节点，确认UUID稳定、版本递增、无未声明字段进入持久化。
3. 两个客户端以同一revision写入：只接受一个，另一个取得明确冲突。
4. 相同requestId/输入重放不重复写；相同requestId/不同输入拒绝。
5. 批次含非法引用时全体不落库；删除A后B和C仍存在，无悬空展示边。
6. 停止并重启新Host，重新读取相同图和接受结果。

数据图阶段可独立验证结构关系与人工编辑；已有DSH接口尚不写图。Run/HITL和基于实际模型读取记录的有效性在第三阶段接入，集群领取与产品管理/前端继续按表推进，不伪造计算读集。

## 2. 数据迁移

- 备份原始开发/生产数据库；不默认 reset。
- Map/Node/Opinion/Slot 的位置型 ID 映射为稳定 ID，重建所有来源和共享关系。
- Workspace.agents 保留私有内容；共享配置库初始版本按明确来源导入，遇到磁盘/公共池不一致报告差异，不静默择一。
- 将 Workspace.ui 转成本人初始偏好；不能把某一人的标签页覆盖全部成员。
- 旧 Run/调用账本留在备份审计，不迁成可自动执行的新 Session。
- 旧已核查数据保留内容和出处；缺有效输入记录时标需复核。
- 本地来源上传为共享资产并重写assetId；任何缺失文件列为迁移错误，不伪造ready资源。

## 3. 必须通过的检查

### 契约与权限

- 当前43个ElectronAPI方法、所有MapperCommand均有去向，无未说明功能删除。
- QueryMap/CommandMap每项都有字段、返回、权限、错误、幂等与状态约束。
- graph.apply同时新建节点/连边/改策略要全成或全败；拒绝冲突ID、复活已删除ID、运行中夹带数据编辑、伪造运行/租约字段。
- nodes.remove自动清理旧策略和关联展示边，保留共享节点/缺失输入；本批新增边引用被删节点则整体拒绝。
- claims.merge多组合并必须无交叠且一次原子接受，出处与共享引用保留。
- HTTP未知字段、非法kind、跨工作区引用、未知ID、无权限等均返回稳定错误。
- secret/token/数据库URI/DSH Session 不出现在普通查询、流或导出。

### 领域与UI

- Source直接解析、独立News/Claim、多来源引用、证据复用、评分/意见保持。
- 手工Agent槽位和hint真正影响执行；自动配置冻结；空结果不重复。
- Review编辑与正式图分离，旧草稿批准失效；多人抢答只有一个成功。
- 选中范围不外扩；结束检测不遗漏新后继；拒绝和永久失败不留下永久running状态。
- 图谱多入边、键盘导航、标签页、输出格式预览、导入导出、CLI正确。

### 多Host与持久化

- 两Host抢一项仅一个有效持有者；不同项可并行。
- 旧Host失租后即使恢复计算也不能写；旧工具调用不冒用新fence。
- 同图短CAS冲突只重读校验，不重复模型调用或覆盖其他租约。
- Mongo已提交但响应丢失可读取原收据；lease代数不进入业务幂等key。
- waiting释放租约；答案落库后任意Host接管，复用报告。
- cancel/fail与commit/renew/complete竞争顺序明确；retry创建新Run。
- primary切换、无数据库、Host关机、客户端断开分别符合协议；禁止memory fallback。
- SSE基线无缺口、旧Activity代次被丢弃、慢客户端重连、权限撤销。

## 4. 当前可执行的文档检查

```bash
node develop-docs/052-校验契约.mjs
```

该脚本只检查目标类型能独立编译、接口清单覆盖现有公开方法/目标方法、本地证据链接和文档格式。它不运行生产应用，不证明DSH/多Host实现已经完成。

## 5. 实施时的代码检查

```bash
npm test
npx vue-tsc --noEmit
npm run headless -- --help
npm run build:check
```

各阶段新增测试/启动命令在实际建立后加入package.json，不预写不存在的npm命令。第一阶段验证DSH封装，第三阶段验证DSH与业务图闭环，第四阶段验证两Host/副本集故障矩阵。复用现有Vitest，不为纯目录移动复制测试；既有失败单独记录。
