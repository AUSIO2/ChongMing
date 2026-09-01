# 044 — Renderer / Mapper / AgentLoop 三层激进重构

## 实现状态（2026-09-01）

已完成：

- Renderer 全部切换为 `mapper.read / dispatch / watch`。
- Mapper canonical `MapDocument` CRUD、revision、lease 和 Snapshot 投影。
- Parse / Split / Verify 普通状态机、HITL、自动连续调度和取消。
- LangGraph 收缩为单一 `AgentLoop.run/close` 适配器。
- Desktop IPC、Preload 和 Headless CLI 共用 Mapper。
- 导入导出直接升级为 canonical v2。
- 删除 Renderer Adapter / Port、StateGraph、transitions、checkpoint、Graph IPC、旧 schema 和双写对账。

本文后续内容保留为决策与验收记录。

## 决策

重明直接重构为三层：

```text
Renderer
  └─ mapper.read / mapper.dispatch / mapper.watch
       ↓
Mapper
  └─ AgentLoop.run
       ↓
AgentLoop
  └─ LangChain / LangGraph
```

本次只实现 LangChain / LangGraph AgentLoop，不接入 DSH，也不为 DSH 编写适配代码、配置开关或兼容分支。未来如果需要 DSH，只实现相同的 `AgentLoop.run/close` 契约。

这是破坏性重构：

- 不兼容现有 MongoDB Map 文档。
- 不提供 v1/v2 双读、迁移器或回滚器。
- 不保留旧 Graph API、旧 Renderer Adapter 或旧 StateGraph 路径。
- 不保留 `Graph*` 兼容类型别名。
- 不双写旧字段。
- 不主动删除用户数据库；旧数据由用户自行清理或切换新库。

## 目标

1. Renderer 只展示 `MapperSnapshot` 和发送 `MapperCommand`。
2. Mapper 是唯一产品状态机和唯一业务数据写入者。
3. AgentLoop 只负责一次模型 / tool loop 调用。
4. HITL、并发、恢复、Timeline、投影全部属于 Mapper。
5. Map 的 canonical document 是唯一持久化真相。
6. 桌面端和 Headless CLI 使用同一个 Mapper 实现。

## 非目标

- DSH 集成。
- 多持久化后端。
- Mapper 插件系统。
- Repository / EventBus / StageFactory 抽象。
- 节点 move/reparent；当前产品没有该命令。
- 手工布局持久化；当前布局可派生。

## 依赖规则

```text
src/**                    → electron/mapper/types
electron/api/**           → electron/mapper/service
server/**                 → electron/mapper/service
electron/mapper/**        → AgentLoop contract + MongoDB
electron/agent-loop/**    → electron/mapper/types
```

禁止：

```text
Renderer → LangGraph / LangChain / MongoDB
Mapper   → Vue / Pinia / LangGraph / LangChain
AgentLoop→ MapDocument / Timeline / MongoDB / Renderer
```

## 对顶层接口

Mapper 只暴露三个方法：

```ts
interface MapperAPI {
  read(query: MapperQuery): Promise<MapperReadResult>
  dispatch(command: MapperCommand): Promise<MapperDispatchResult>
  watch(listener: (event: MapperUpdated) => void): () => void
}
```

### Read

```ts
type MapperQuery =
  | { type: 'map.list'; workspaceId: string }
  | { type: 'map.snapshot'; mapId: string }
```

### Create

```text
map.create
node.create       source | news | claim | route
```

### Update

```text
map.rename
node.update
timeline.update
run.start
run.continue
run.cancel
run.set-mode
claims.dedup
routes.batch-update
lease.acquire
lease.release
```

### Delete

```text
map.delete
node.delete
```

Catalog 不属于 Mapper，继续使用独立 Agent/Catalog API。

## AgentLoop 契约

```ts
interface AgentLoop {
  run(
    call: AgentCall,
    options: {
      signal: AbortSignal
      onEvent: (event: AgentEvent) => void
    },
  ): Promise<AgentResult>

  close(): Promise<void>
}
```

```ts
interface AgentCall {
  callId: string
  sessionId?: string
  prompt: string
  agent: {
    name: string
    model?: string
    baseUrl?: string
    tools: string[]
  }
}

interface AgentResult {
  text: string
  sessionId?: string
}

type AgentEvent =
  | { type: 'delta'; channel: 'thinking' | 'text'; text: string }
  | { type: 'tool-start'; name: string; argsSummary?: string }
  | { type: 'tool-end'; name: string }
```

AgentLoop 契约中不得出现 `mapId`、`transitionKey`、HITL、checkpoint、Map 节点或数据库类型。

## 唯一数据模型

旧 `chains + mapGraph + mapRun + LangGraph checkpoint + Renderer MapGraphDoc` 全部废弃。

```ts
interface MapDocument {
  _id: string
  workspaceId: string
  name?: string

  sources: SourceRecord[]
  news: NewsRecord[]
  claims: ClaimRecord[]
  routes: RouteRecord[]

  timeline: MapTimeline
  run?: MapperRun

  revision: number
  writeLease?: WriteLease
}
```

不持久化以下派生数据：

- edges
- parseAgent / subAgent / opinion UI 节点
- runPhase / activeNodeId / pendingTool
- thinking / text 流
- tool 活动

`MapperSnapshot = projectSnapshot(MapDocument, LiveRunState)`。

## MapperRun

```ts
interface MapperRun {
  runId: string
  stage: 'parse' | 'split' | 'verify'
  step:
    | 'load'
    | 'route'
    | 'confirm-route'
    | 'workers'
    | 'merge'
    | 'validate'
    | 'save'
    | 'done'
  status: 'running' | 'interrupted' | 'cancelled' | 'error'
  mode: 'auto' | 'human-in-loop'
  targetId: string
  draft: MapperDraft
  completedCalls: Record<string, AgentResult>
  updatedAt: string
}
```

Mapper 在每个 AgentCall 完成时保存结果。进程重启只重跑缺失的 call。

## 目标函数

### `electron/mapper/service.ts`

```text
createMapper(agentLoop)
read(query)
dispatch(command)
watch(listener)
close()

enqueueMapCommand(mapId, operation)
applyCommand(document, command)
runUntilPause(document)
applyHumanDecision(document, decision)
cancelActiveRun(mapId)
emitSnapshot(mapId)
```

### `electron/mapper/document.ts`

```text
mapDocumentCreate(input)
mapDocumentList(workspaceId)
mapDocumentRead(mapId)
mapDocumentCommit(document, expectedRevision)
mapDocumentDelete(mapId)
```

### `electron/mapper/project.ts`

```text
projectSnapshot(document, liveState?)
projectNodes(document, liveState?)
projectRun(document, liveState?)
readNodeCapabilities(document, nodeId)
collectSubtree(snapshot, rootId)
```

### `electron/mapper/schedule.ts`

```text
readNextWork(document)
pickWorks(items, limit, selectedNodeId?)
deriveTimelineState(document)
selectAgentCalls(routes, maxConcurrency)
```

### `electron/mapper/stages/`

```text
parseStep(context)
splitStep(context)
verifyStep(context)

routeAgents(context)
runSplitAgents(context)
mergeSplitClaims(context)
runVerifyAgents(context)
mergeVerifyOpinions(context)

parseRouteOutput(text)
parseClaimsOutput(text)
parseVerifyOutput(text)
```

### `electron/agent-loop/langgraph.ts`

```text
langGraphAgentLoop.run(call, options)
langGraphAgentLoop.close()
```

`close()` 初始为 no-op。不创建抽象基类或工厂。

## 现有函数迁移

### Map CRUD

| 当前 | 目标 |
|---|---|
| `mapCreate` | `mapDocumentCreate` |
| `mapReadIndex` | `mapDocumentList` |
| `mapRead` | `mapDocumentRead + projectSnapshot` |
| `mapUpdate` | Mapper commands |
| `mapDelete` | `mapDocumentDelete` |
| `mapReadAllClaims` | 删除 |
| `mapUpdatePersistMap` | 删除，由 `mapDocumentCommit` 替代 |

删除整个 `map-chain-writers.ts`：

```text
mapChainReadScope
mapChainRequireScope
mapChainWriteClaims
mapChainWriteVerifyResult
mapChainWriteScope
mapChainWriteContent
```

### Renderer Adapter

删除 `src/flow-map/adapters/electron-ipc.ts`。映射：

| 当前 | 目标 |
|---|---|
| `adapterBuildIpc` | `createMapper`，运行于主进程 |
| `emitPush` | `emitSnapshot` |
| `adapterEnqueueDoc` | `enqueueMapCommand` |
| `adapterResumeAutoInterrupt` | `runUntilPause` |
| `persistDoc` | `mapDocumentCommit` |
| `snapshotOf` | `projectSnapshot` |
| `adapterMutate` | `dispatch` |
| `runOneTransition` | stage step |
| `runParallelTransitions` | `runSplitAgents/runVerifyAgents` |
| `adapterTryRestoreRun` | `runUntilPause` 读取 `MapperRun` |
| `wireEvents` | AgentLoop callback |

直接删除：

```text
graphListenRunEnd
adapterFlushDoc
adapterAcceptRun
adapterClearBatch
getLoadedDoc
getDoc
adapterReadRestoreInput
adapterSyncInterrupt
adapterClearStaleRun
ensureGraph
reconcileVerify
unloadMap
flushMap
startParse
startRun
```

### GraphDoc / Projection

canonical CRUD 替代：

```text
docAddSourceChain / docAddRootNews / docAddRootClaim → node.create
docUpdateMap / docUpdateSubAgent / docUpdateClaim   → node.update
docDeleteNodes                                      → node.delete
docDedupClaims                                      → claims.dedup
docBatchUpdateSubAgents                             → routes.batch-update
```

删除运行双轨：

```text
docCreate
docCreateMap
docReconcileVerify
docUpdateProgress
docUpdateError
docUpdateInterrupt
docProjectGraphState
docUpdateVerify
docUpdateRunEnd
docCreatePersist
docReadPersistGraph
docReadPersistRun
docResetMap
docDeleteClaims
docReadResume
docUpdateDraft
docDeleteFocus
docClearRunSession
```

权限函数合并为 `readNodeCapabilities`。`docCollectSubtree` 迁移为 `collectSubtree`。

删除 GraphState 投影 registry、gate policy 和 resume 投影；`projReadSplitClaimParent`、`projUpdateVerifyOpinion` 合并进 `projectSnapshot`。

### Schedule / Timeline

```text
schedulePickWork / schedulePickWorks → pickWorks
scheduleDeriveStateIndex             → deriveTimelineState
scheduleReadPending                  → readNextWork
graphReadRouteLimit                  → selectAgentCalls
```

删除 layout 驱动的调度、interrupt stale 检测和 Timeline 包装函数。业务顺序使用 canonical 数组顺序、active scope 和用户选择。

### LangGraph

`llmRunInvoke` 改为 `langGraphAgentLoop.run`。

迁入 LangGraph adapter 的私有函数：

```text
llmReadMessage
llmFormatTools
llmReadToolInput
formatToolSchemaParams
serializedToolName
llmReadDelta
llmCreateDeltaThrottle
llmPushDelta
llmReadChainMessages
agentCreateModel
```

迁入 Mapper 的输出解析函数：

```text
llmReadJsonText
llmReadJson
llmReadRoute
llmReadClaims
llmReadJsonObject
isRecord
```

删除：

- `electron/orchestration/langgraph-engine.ts`
- `electron/orchestration/types.ts::WorkflowEngine`
- `electron/shared/graph-hitl.ts`
- LangGraph session registry / interrupt loop / checkpoint driver
- `ParseGraphState` / `SplitGraphState` / `VerifyGraphState`
- `parseBuildGraph` / `splitBuildGraph` / `verifyBuildGraph`
- 整个 `electron/transitions/`
- MongoDB LangGraph checkpointer

LangGraph 最终只能存在于 `electron/agent-loop/langgraph.ts`。

## IPC / Renderer / CLI

只保留三个 Mapper 通道：

```text
MAPPER_READ
MAPPER_DISPATCH
MAPPER_UPDATED
```

Preload 只暴露 `mapper.read/dispatch/watch`。

Renderer 删除：

```text
installMapApi
portRegisterApi
portReadApi
portIsInstalled
adapterBuildIpc
flushAllMapTabs
```

FlowMap Store 保留选中、导航和 Catalog UI；CRUD、运行、继续、取消全部改为 `mapper.dispatch`。`runTimeline/startRun/startParse` 合并为 `run`。

CLI：

```text
cmdList   → mapper.read(map.list)
cmdCreate → mapper.dispatch(map.create/node.create)
cmdRun    → mapper.dispatch(timeline.update/run.start)
cmdStatus → mapper.read(map.snapshot)
```

CLI 不再构造 `ElectronAPI → adapterBuildIpc → portRegisterApi`。

## 实施顺序

### A. 合同与 Fake

1. 新建 Mapper / AgentLoop DTO。
2. 新建 `FakeAgentLoop`。
3. 新建 AgentLoop contract test。
4. 新建 Mapper CRUD / run / HITL / cancel tests。

### B. LangGraph AgentLoop

1. 从 `llm-utils` 提取单次调用实现。
2. 统一流式和 tool 事件。
3. 支持 `AbortSignal`。

### C. 新 MapDocument 与 Mapper CRUD

1. 直接替换 Mongoose schema。
2. 实现 document CRUD、snapshot 投影和 command dispatch。
3. 切换 Node / Timeline / lease CRUD。

### D. Mapper 状态机

1. Parse。
2. Split。
3. Verify。
4. HITL、并行、恢复、取消。

### E. 一次性切换

1. IPC / preload。
2. Renderer Store。
3. Headless CLI。
4. 文件导入导出改为新 document。

### F. 删除旧架构

1. Renderer Adapter / Port。
2. Graph Engine / StateGraph / transitions。
3. checkpointer / graph events / Graph DTO。
4. mapGraph / mapRun / chains 双轨写入。
5. 旧测试夹具。

## 验收

- Renderer 无 LangGraph / DSH / Mongo 类型。
- Mapper 无 LangGraph / LangChain 类型。
- AgentLoop 无 Map / Timeline / Mongo 类型。
- `rg "@langchain/langgraph"` 只能命中 LangGraph AgentLoop。
- Mapper 是唯一 Map 写入者。
- 桌面端和 CLI 共用 Mapper。
- Fake 与 LangGraph 通过同一 AgentLoop 合同测试。
- CRUD、三阶段、HITL、恢复、并行、取消全部通过。
- `vue-tsc --noEmit`、完整 Vitest、Vite production build 通过。
- 目标净删除 3,500–5,000 行生产代码。
