# Implement: Map 节点 ID 统一

对应设计：[018-Map节点ID统一.md](./018-Map节点ID统一.md)

## 任务清单

- [x] `map-ids`：删 scoped/verify helpers；不保留 `normalizeInstanceId`
- [x] `types`：`GraphProgressPayload` 用 `nodeId` / `parentNodeId`
- [x] `graph-utils`：fanout/skill 发 `nodeId`；fanout 带 `parentNodeId`
- [x] `graph-doc`：按 `nodeId` 投影；删 verifyClaimId / scopedVerifyRoute
- [x] `electron-ipc`：加槽不再 scoped；threadId=runId
- [x] `graph-service`：新运行与 restore 均 threadId=runId
- [x] `extractor`/`verifier`：threadId 必填，无旧前缀 fallback
- [x] `graph-doc.spec` 更新

## 验收

- `npm run test:map` 全绿
