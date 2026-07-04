# 007 — Map 层 Port 重建（Implement Plan）

## 三阶段

### Phase 1 — Port 骨架（不动 UI）

**目标**：`npm test` 通过，`vue-tsc` 通过；UI 完全不感知。

- [ ] `package.json`：加回 `vitest` 到 `devDependencies`；`scripts.test:map = "vitest run --config vitest.config.ts src/flow-map"`
- [ ] `vitest.config.ts`：`environment: 'node'`
- [ ] `src/flow-map/types.ts`：`NodeKind` / `ToolKind` / `DataPhase` / `RunPhase` / `ExecutionMode` / `Priority` / `Confidence` / `SubAgentParams` / `ClaimParams` / `OpinionParams` / `MapNode`（`SubAgent|Claim|Opinion` 联合）/ `MapEdge` / `MapSnapshot` / `SubAgentEntry`
- [ ] `src/flow-map/ids.ts`：`NEWS_ROOT_ID`；`subAgentId(instanceId)` / `claimId(instanceId, index)` / `opinionId(instanceId, index)` / `edgeId(from, to)`
- [ ] `src/flow-map/graph-ops.ts`：`isParamsLocked(node) → boolean`；`canAddSubAgent(snapshot, parentNodeId)`；`canEditNode(snapshot, nodeId)`
- [ ] `src/flow-map/layout.ts`：`layoutMapSnapshot(snapshot) → LayoutSnapshot`，BFS 深度分层
- [ ] `src/flow-map/api.ts`：`MapAPI` 接口 + `AddSubAgentInput` / `UpdateNodeParamsInput`
- [ ] `src/flow-map/port.ts`：`installMapAPI(api)` / `getMapAPI()`
- [ ] `src/flow-map/fixtures/demo.ts`：`buildDemoSubAgentCatalog()` / `buildDemoClaimContent()` / `buildDemoOpinionContent()`
- [ ] `src/flow-map/adapters/langgraph-mock.ts`：`createLangGraphMockAdapter(): MapAPI`
- [ ] `src/flow-map/index.ts`：统一导出
- [ ] `src/flow-map/graph-ops.spec.ts`：锁规则 + canAddSubAgent
- [ ] `src/flow-map/layout.spec.ts`：BFS 深度稳定性 + 无 hasVerifyWorkers 分支
- [ ] `src/flow-map/adapters/langgraph-mock.spec.ts`：`startRun` → 首拆分中断 / `continueStep` × N → 全拆分持久化 → 自动进入首核查 / opinion 持久化后 runPhase=`completed`；**snapshot 断言不含 `scope` / `stage` / `verifyByClaimId`**

### Phase 2 — UI 接线

**目标**：`VITE_USE_MAP_FLOW=1` 时前端只看 Map Port。

- [ ] `src/config/map-flow.ts`：`export const USE_MAP_FLOW = import.meta.env.VITE_USE_MAP_FLOW === '1'`
- [ ] `src/stores/flow-map.ts`（Pinia）：`snapshot` / `selectedNodeId` / `catalog`，操作透传 `MapAPI`
- [ ] `src/composables/use-flow-map.ts`：`useFlowMap(newsId)`，订阅 `port.onUpdated`
- [ ] `src/components/flow/FlowMapTopology.vue`
- [ ] `src/components/flow/FlowMapInspector.vue`
- [ ] `src/components/flow/FlowMapControls.vue`
- [ ] `src/views/HomeView.vue`：`USE_MAP_FLOW` → `FlowMapTopology`，否则原 `FlowTopology`
- [ ] `src/components/RightSidebar.vue`：`USE_MAP_FLOW` → `FlowMapInspector`，否则原 Inspector
- [ ] `src/components/WorkflowControls.vue`：`USE_MAP_FLOW` → `FlowMapControls` 分支
- [ ] `src/shims-vue.d.ts`：`window.mapAPI?: MapAPI`

### Phase 3 — dev:web 验收

- [ ] `src/mocks/flow-map-seed.ts`：一条新闻 + 空 catalog（Inspector 引导添加）
- [ ] `src/mocks/flow-map-api.ts`：`createMockMapAPI()`
- [ ] `src/main.ts`：`USE_MAP_FLOW` → `installMapAPI(createMockMapAPI())`
- [ ] 手工验收：
  1. 空画布 → 添加 3 个拆分 subAgent → 运行
  2. 每个 subAgent 出现 workerOut claims
  3. 第一个 subAgent 出现 `pendingTool=save` 焦点
  4. Continue → 其第一个 claim 变 persisted，**同一步右侧长出核查 subAgent（idle）**
  5. 焦点自动转移到下一 claim / 下一 subAgent
  6. 全部 claim persisted 后自动进入首个 claim 的核查 invoke → save 中断
  7. 一路 Continue 到 `runPhase=completed`
  8. 布局全程无跳变

## 硬验收

在 Phase 1 结束和 Phase 3 结束各跑一次：

```bash
rg -n "SplitCheckpointSlice|verifyByClaimId|routeInstructions|subAgentResults|pendingValidatedClaims|FlowScope" \
  src/flow-map src/stores/flow-map.ts src/composables/use-flow-map.ts src/components/flow/FlowMap*.vue

rg -n "stage === 'split'|stage === 'verify'|scope\.kind|isBridge|edge\.kind" \
  src/flow-map src/stores/flow-map.ts src/composables/use-flow-map.ts src/components/flow/FlowMap*.vue

npm run test:map
npx vue-tsc --noEmit
```

任一非零 / 失败 → 不算完成。
