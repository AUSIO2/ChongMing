# 015 — 断点恢复（扩展 News 文档）

## 目标

半路退出后可恢复：在现有 Mongo News 上增加 `mapRun` + `mapGraph`；LangGraph 用 `updateState(asNode)` 从 draft 重挂到 interrupt 门闩（同库，不新开存储产品）。

## News 扩展

- `mapRun`：runId、threadId、graphType、mode、gate、pendingTool、activeNodeId、status、claimId?
- `mapGraph`：nodes、edges、runPhase、draft、与 MapGraphDoc 对齐的字段

## 恢复

1. `ensureGraph` 优先 hydrate `mapGraph`
2. 若 `mapRun.status === interrupted`，主进程 `restoreRun`：buildGraph → updateState(draft, asNode) → 进入 HITL 等待 continue
