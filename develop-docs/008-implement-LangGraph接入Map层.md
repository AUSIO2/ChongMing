# 008 — LangGraph 接入 Map 层（Implement Plan）

## Phase 1 — Port 契约钉死

- [x] `types.ts`：注释；`RunPhase` 含 `error`；`MapSnapshot.error?`
- [x] mock：焦点 `runtime.pendingTool`；Route + invoke 配置期人工加槽
- [x] UI：Map error 展示
- [x] **`SubAgentParams` 补 `priority` / `hint`**；Claim 去掉误放的 priority；Opinion 补 `priority`
- [x] mock / Inspector / 单测对齐真实 route 参数
- [x] catalog 条目带默认 priority

## Phase 2 — 后端 IPC 与 per-node interrupt

- [x] `RouteInstruction` 增加可选 `instanceId`
- [x] `StartSplitInput.routeInstructions?`；与 AI route **合并**
- [x] `GraphInterruptedPayload`：`focus` + `pendingTool`
- [x] split：按条 `save` 循环 persist claim
- [x] verify：按条 opinion save
- [x] `graph.getActiveRun(newsId)`
- [x] `catalog.list(module)` + preload / channels / register-handlers
- [x] activeRuns 按 newsId 索引

## Phase 3 — electron-ipc Adapter

- [x] `src/flow-map/adapters/electron-ipc.ts` 实现 `MapAPI`
- [x] 投影器：news + claims + active run state → MapSnapshot（单焦点）
- [x] `startRun` / `continueStep` / `cancel` / `setMode` / `onUpdated`
- [x] `addSubAgent` idle：pending routes，startRun 时并入
- [x] `main.ts`：非 mock 时 `installMapAPI(createElectronIpcMapAdapter())`

## Phase 4 — 验收

```bash
npm run test:map
npx vue-tsc --noEmit
rg -n "SplitCheckpointSlice|verifyByClaimId|routeInstructions|GraphType" \
  src/flow-map src/stores/flow-map.ts src/composables/use-flow-map.ts \
  src/components/flow/FlowMap*.vue
```

- interrupted 快照仅一个 activeNodeId
- claim save 后同一步出现 verify subAgent 子树（mock + 真机投影）
