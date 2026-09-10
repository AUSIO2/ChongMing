# 046 Implement Plan — DSH 原生重写

> 本文已被 `049-DSH多人协作重构执行计划.md` 取代，不再直接执行。

## 0. 执行约束

- 当前工作区已有未提交修改；开始实现前先建立保护分支并形成可回退提交，不覆盖这些文件。
- 使用新目录实现，通过测试后一次性切换；最终不得保留双轨运行。
- 不迁移旧 `MapperRun`、call ledger 或 LangGraph checkpoint；开发数据库直接清理。
- 每个阶段必须满足退出条件才能进入下一阶段。

## 1. Phase 0：DSH Spike

### 新增文件

```text
spikes/dsh/package.json
spikes/dsh/composition.ts
spikes/dsh/run.ts
spikes/dsh/recovery.spec.ts
```

### 新增函数

```text
dshSpikeCreateRuntime()
dshSpikeCreateAgent()
dshSpikeRunWorkers()
dshSpikeResumeSession()
dshSpikeDeleteRuntime()
```

### 验证场景

1. 创建父 Session。
2. route Agent 返回两个 named SubAgent。
3. 两个 SubAgent 并行产生结构化 Claim。
4. 一个 SubAgent 完成后强制结束进程。
5. 使用持久化 Session 恢复。
6. 已完成 SubAgent 不重复调用，另一个继续。
7. 发起 Question/Approval，结束进程后恢复并回答。
8. cancel 能终止父 Agent 和子 Agent。

### Go/No-Go

只有以下条件全部满足才正式迁移：

- Node v24 与 Electron 打包环境可运行所需 DSH packages。
- SQLite Session Persistence 能在应用数据目录稳定恢复。
- structured output 能覆盖 route/split/verify schema。
- SubAgent 生命周期和取消行为满足测试。
- Renderer 可以从 DSH events 获得增量文本、tool 状态和待回答交互。

任何一项失败则停止 DSH-first，保留现有 Mapper-first，不添加半成品 adapter。

## 2. Phase 1：建立新契约和目录

### 新增文件

```text
src/contracts/domain.ts
src/contracts/mapper.ts
src/contracts/snapshot.ts
src/mapper/commands.ts
src/mapper/document-store.ts
src/mapper/service.ts
src/mapper/project.ts
```

### 新增领域类型

```text
SourceRecord
NewsRecord（新增 splitCompletedAt）
ClaimRecord
VerifyResult
AgentProfile
MapDocument
DataState
Stage
RunMode
```

### 新增公开类型

```text
MapperQuery
MapperCommand
MapperReadResult
MapperDispatchResult
MapperSnapshot
PipelineSnapshot
PipelineLane
MapperAPI
```

### 新增函数

`src/mapper/document-store.ts`

```text
mapDocumentCreate()
mapDocumentRead()
mapDocumentList()
mapDocumentCommit()
mapDocumentDelete()
```

`src/mapper/commands.ts`

```text
mapCreateNode()
mapUpdateNode()
mapDeleteNode()
mapUpdateName()
mapInvalidateSource()
mapInvalidateNews()
mapInvalidateClaim()
```

`src/mapper/project.ts`

```text
projectReadMap()
projectReadPipeline()
projectReadSnapshot()
```

### 修改 API

删除：

```text
MapperTimeline
MapperStageContext
MapperRun
MapperCallPlan
MapperCallRecord
AgentCall
AgentResult
AgentEvent
AgentLoop
timeline.update command
```

修改：

```ts
run.start {
  mapId: string
  scopeId?: string
  until: 'news' | 'claims' | 'verified'
  mode: 'auto' | 'human-in-loop'
}
```

### 退出条件

- 新 contracts 不 import Electron、Vue、Mongoose 或 DSH。
- CRUD 和级联失效纯单测通过。
- 旧 Mapper 尚未删除，但新代码不调用旧 Mapper。

## 3. Phase 2：DSH Composition

### 新增文件

```text
src/runtime/dsh/composition.ts
src/runtime/dsh/sessions.ts
src/runtime/dsh/agents.ts
src/runtime/dsh/schemas.ts
src/runtime/dsh/events.ts
src/runtime/dsh/projection.ts
src/runtime/dsh/interaction.ts
src/runtime/dsh/tools/web-search.ts
```

### 新增函数

`composition.ts`

```text
dshCreateRuntime(settings, dataDir)
dshDeleteRuntime(runtime)
```

`sessions.ts`

```text
dshCreateRunSession(mapId, request)
dshReadRunSession(sessionId)
dshResumeRunSession(sessionId)
dshCancelRunSession(sessionId)
dshDeleteRunSession(sessionId)
```

`agents.ts`

```text
dshCreateAgent(profile, parentSessionId)
dshRunAgent(profile, prompt, schema)
dshRunSubagents(requests, concurrency)
```

`schemas.ts`

```text
routeOutputSchema
splitOutputSchema
verifyOutputSchema
mergeOutputSchema
```

`events.ts`

```text
dshAppendRunStart()
dshAppendStageStart()
dshAppendDraft()
dshAppendStageCommit()
```

`projection.ts`

```text
dshProjectRun(events)
dshProjectStream(events)
dshProjectInteraction(events)
```

`interaction.ts`

```text
dshAskQuestion()
dshAskApproval()
dshAnswerInteraction()
```

`tools/web-search.ts`

```text
dshCreateWebSearchTool()
```

### 依赖调整

删除 npm dependencies：

```text
@langchain/core
@langchain/langgraph
@langchain/openai
langsmith
```

新增最小 DSH capabilities 对应 packages：

```text
Cordis
session
system-prompt
tools
agent
agent-loop
LLM adapter
session-persistence-sqlite
session-checkpoint-policy
llm-retry
subagent
structured-output provider
```

精确 package 名和版本在 Spike 锁定后写入 package.json；禁止在计划阶段猜测并提交不存在的包。

### 退出条件

- 单个 Agent 可以流式运行并使用 web_search。
- Session 重启恢复、取消、structured output 测试通过。
- 所有 DSH package 只在 `src/runtime/dsh/**` 和 composition root 中 import。

## 4. Phase 3：Pipeline 与领域事件

### 新增文件

```text
src/mapper/pipeline.ts
src/mapper/stages.ts
src/mapper/agent-profiles.ts
tests/mapper/pipeline.spec.ts
tests/mapper/stages.spec.ts
tests/runtime/dsh-recovery.spec.ts
```

### 新增函数

`pipeline.ts`

```text
pipelineReadTasks(document, scopeId, until)
pipelineStart(mapId, request)
pipelineResume(mapId)
pipelineContinue(mapId, answer)
pipelineCancel(mapId)
pipelineRunTask(session, task)
pipelineCommitDraft(mapId, session, draft)
pipelineRepairCommit(mapId, session)
```

`stages.ts`

```text
stageRunParse(context)
stageRunSplit(context)
stageRunVerify(context)
stageReadRoutes(context)
stageRunWorkers(context)
stageRunMerge(context)
```

`agent-profiles.ts`

```text
agentProfileReadParse(workspace)
agentProfileReadRoute(workspace, stage)
agentProfileReadWorkers(workspace, stage)
agentProfileReadMerge(workspace, stage)
```

### 运行规则

- `pipelineStart` 创建 DSH run Session，并将 SessionId 写入 `MapDocument.activeRunSessionId`。
- 每个 task 先追加 `stage-start`。
- Agent structured result 追加 `draft`。
- HITL 模式调用 DSH interaction；自动模式直接 commit。
- Mongo commit 后追加 `stage-commit`。
- 所有 task 完成后清除 `activeRunSessionId`，保留 DSH Session 供审计；清理策略另设保留期，不阻塞本次实现。

### 退出条件

- Parse、Split、Verify 自动模式端到端通过。
- 每个 HITL gate 可以关闭应用后继续。
- 0 Claim 的 Split 被记录为完成，不会重复运行。
- Mongo commit 中断窗口能够通过 `pipelineRepairCommit` 修复。

## 5. Phase 4：Mapper Service 切换

### 新增/重写函数

`src/mapper/service.ts`

```text
mapperCreate(runtime, documentStore)
mapperRead(query)
mapperDispatch(command)
mapperWatch(listener)
mapperEmit(snapshot)
```

### 删除旧函数

从 `electron/mapper/service.ts` 删除：

```text
createMapper(agentLoop)
runUntilPause()
checkpoint()
executeCalls()
readNextRun()
旧 applyNodeCreate/Update/Delete
```

从 stage 文件删除：

```text
parseStep()
splitStep()
verifyStep()
```

这些行为由新 `commands.ts`、`pipeline.ts`、`stages.ts` 承担；不保留转发别名。

### 退出条件

- Electron/CLI 尚可通过临时测试入口调用新 Mapper。
- 新 Mapper 没有 LangGraph、自研 AgentLoop 和 call ledger。
- Map revision 冲突、lease 和运行 session ownership 测试通过。

## 6. Phase 5：Renderer 与 Timeline 切换

### 移动目录

```text
src/components/**  → src/renderer/components/**
src/chrome/**      → src/renderer/chrome/**
src/composables/** → src/renderer/composables/**
src/views/**       → src/renderer/views/**
src/shortcuts/**   → src/renderer/shortcuts/**
```

### 删除文件

```text
src/stores/run-coordinator.ts
src/flow-map/timeline.ts
src/flow-map/timeline-project.ts
```

### 重写文件

```text
src/stores/flow-map.ts       → src/renderer/stores/mapper.ts
src/stores/workspace.ts      → src/renderer/stores/workspace.ts
src/stores/workspace-tabs.ts → src/renderer/stores/tabs.ts
src/flow-map/timeline-frame.ts → src/renderer/flow-map/pipeline-frame.ts
```

### 新增函数

`renderer/stores/mapper.ts`

```text
mapperAttach(mapId)
mapperDetach()
mapperRefresh()
mapperDispatch(command)
mapperAnswer(interactionId, value)
```

`renderer/flow-map/pipeline-frame.ts`

```text
pipelineFrameReadState()
pipelineFrameReadStage()
pipelineFrameReadX()
pipelineFrameReadWidth()
```

### 删除 Renderer 行为

- `runPhase` 本地状态推进。
- `continueInFlight` 以外的运行真相副本。
- Timeline `startX/endX/stateIndex/activeScope`。
- Renderer 对 `electron/mapper/types`、`electron/api/types`、`electron/shared/*` 的 import。
- 根据 FlowMap layout depth 反推 Timeline 进度。

### 退出条件

- Renderer 只 import `src/contracts/**`。
- Timeline 完全由 `PipelineSnapshot` 渲染。
- DSH stream、tool、SubAgent、question、approval 都能显示。

## 7. Phase 6：Transport 与入口统一

### 新增文件

```text
src/application.ts
src/entries/desktop/main.ts
src/entries/desktop/preload.ts
src/entries/desktop/ipc.ts
src/entries/cli/main.ts
src/entries/cli/commands.ts
```

### 新增函数

`src/application.ts`

```text
applicationCreate(options)
applicationDelete(app)
```

返回：

```ts
{
  mapper,
  runtime,
  workspace,
  settings,
}
```

Desktop 和 CLI 必须调用同一个 `applicationCreate()`，不得分别装配 DSH。

### 重写函数

```text
handlerRegisterIpc() → 只注册 transport，不 import 数据库 model
serverBootstrap()    → 调 applicationCreate()
serverShutdown()     → 调 applicationDelete()
```

### 可选后续，不在本次实现

只有需要远程执行时，才用 DSH API Gateway 替换 Electron IPC；不得为未来需求预埋两套 transport。

## 8. Phase 7：一次性删除旧运行内核

### 删除文件

```text
electron/agent-loop/langgraph.ts
electron/mapper/index.ts
electron/mapper/types.ts
electron/mapper/service.ts
electron/mapper/document.ts
electron/mapper/output.ts
electron/mapper/project.ts
electron/mapper/stages/parse.ts
electron/mapper/stages/split.ts
electron/mapper/stages/verify.ts
electron/shared/llm-model.ts
electron/shared/llm-utils.ts
electron/tools/index.ts
electron/tools/web-search.ts
src/.DS_Store
```

### 合并后删除的旧服务

以下文件先把仍需行为迁入 `mapper/agent-profiles.ts` 或 `platform`，再删除：

```text
electron/api/catalog-service.ts
electron/api/sub-agent-catalog.ts
electron/api/local-agent-service.ts
electron/api/agent-registry-service.ts
electron/api/prompt-config-service.ts
electron/shared/prompt-loader.ts
electron/shared/prompt-migrate.ts
electron/shared/prompt-output.ts
electron/shared/prompt-vars.ts
```

保留 Agent Manager 产品能力，但只有一个 `AgentProfile` 数据源和一套 CRUD；删除 disk catalog、local Mongo agent、workspace overlay 三套并行来源。

### 删除类型与字段

```text
AgentLoop
AgentCall
AgentResult
AgentEvent
MapperRun
MapperCallPlan
MapperCallRecord
MapperStageContext
MapperTimeline
MapperToolKind（若完全由 DSH event presentation 替代）
writeLease（仅在独立 DSH Host 落地后删除）
```

### 删除 Mongo schema

```text
map.run
map.timeline
mapperCallSchema
mapperAgentCallSchema
mapperRunSchema
```

新增：

```text
map.activeRunSessionId
news.splitCompletedAt
```

## 9. Phase 8：测试迁移

### 保留并迁移

```text
layout.spec.ts
layout-nav.spec.ts
map-ids.spec.ts
file-export.spec.ts
workspace/catalog/agent profile CRUD tests
headless-smoke.spec.ts
```

### 删除旧测试

```text
tests/electron/agent-loop-contract.spec.ts
tests/electron/mapper-parse.spec.ts
tests/electron/mapper-split-verify.spec.ts
tests/electron/mapper-recovery.spec.ts
tests/electron/mapper-cancel.spec.ts
```

### 新增测试

```text
tests/mapper/commands.spec.ts
tests/mapper/invalidation.spec.ts
tests/mapper/pipeline.spec.ts
tests/mapper/project.spec.ts
tests/runtime/dsh-agent.spec.ts
tests/runtime/dsh-subagents.spec.ts
tests/runtime/dsh-recovery.spec.ts
tests/runtime/dsh-interaction.spec.ts
tests/runtime/dsh-cancel.spec.ts
tests/integration/desktop-mapper.spec.ts
tests/integration/cli-mapper.spec.ts
```

### 必测场景

1. route structured output 非法时明确失败。
2. 两个 Worker 乱序完成，结果顺序稳定。
3. 一个 Worker 完成后进程退出，恢复时不重复。
4. HITL 等待期间退出，恢复后可回答。
5. Mongo 已提交而 stage-commit 未写时自动修复。
6. cancel 后不能自动恢复。
7. News 输出 0 Claim 仍标记 Split 完成。
8. 修改上游后下游数据和 Pipeline 进度同步失效。
9. Desktop 与 CLI 得到相同 Snapshot。

## 10. Phase 9：文档、构建与清理

### 更新

```text
README.md
coding.md
docs/design-overview.md
electron-builder.json5
vite.config.ts
tsconfig.json / tsconfig.node.json
```

### 删除文档中的旧概念

```text
LangGraph AgentLoop
Mapper call ledger
MapperTimeline 数字状态
旧 electron/api/shared 目录说明
旧 checkpoint 恢复语义
```

### 验证命令

```bash
npm test
npx vue-tsc --noEmit
npm run headless -- status <mapId>
npm run build:check
```

### 静态验收

```bash
rg "@langchain|langgraph|AgentLoop|MapperCallRecord|checkpointTail" src electron server
rg "from .*electron/" src/renderer
find src -type d -empty
```

以上搜索除历史 `develop-docs` 外必须为空。

## 11. 提交边界

建议按以下可回退提交执行：

1. `test: prove DSH runtime recovery spike`
2. `feat: add DSH composition and structured agents`
3. `feat: add DSH-backed Mapper pipeline`
4. `refactor: move renderer behind shared contracts`
5. `refactor: unify desktop and CLI composition`
6. `feat!: remove LangGraph and legacy run state`
7. `docs: document DSH-native architecture`

最终切换提交是破坏性提交；切换前各提交允许新旧目录并存，切换后同一可执行产物只能包含 DSH 路径。

## 12. 工期与规模估计

单人连续开发估计：

```text
Spike                         1–2 天
contracts + domain            1–2 天
DSH composition               2–4 天
pipeline + HITL + recovery    4–6 天
Renderer/transport 切换       3–5 天
删除、测试、打包              2–3 天
总计                          13–22 个工作日
```

预计：

- 删除旧运行、LLM、tool、parser、store 协调代码 1,500–2,500 行。
- 新增 DSH composition、projection、pipeline glue 900–1,600 行。
- 净减少约 500–1,200 行。
- 主要收益不是总代码量，而是删除自研 Agent runtime 与双重恢复逻辑。

## 13. 最终完成定义

只有同时满足以下条件才算完成：

- 生产依赖不含 LangChain/LangGraph/LangSmith。
- Agent 执行只经过 DSH。
- Mongo 不保存 Agent 内部执行状态。
- DSH Session 可以恢复 Agent 和 HITL。
- Mapper 只包含领域 CRUD、pipeline、commit、projection。
- Renderer 只依赖 contracts。
- 目录树能够直接对应 Renderer → Mapper → DSH。
- 旧文件、旧函数、旧类型、旧 schema 和旧测试全部删除。
- 全量测试、类型检查、CLI smoke 和 DMG 构建全部通过。
