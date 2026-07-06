# 038 — 跨数据节点 SubAgent 并行

## 背景

034 Timeline 按源链串行 `schedulePickWork`，每轮 `runTimeline` 只启动一个数据节点（news/claim）的 transition。单 parent 内 `maxConcurrency` 仅限制扇出 SubAgent，不跨节点。

## 目标

- **auto**：同一 transition 阶段可同时调度最多 `maxSubAgent` 个数据节点，各自 `runTransition`。
- **human-in-loop**：保持串行（limit=1），保留 activeLine 拓扑序。
- **全局配置** `maxSubAgent`：`MAX_SUB_AGENT` 环境变量 / `agentReadMaxSubAgent()`，默认 3。

## 模块

| 文件 | 职责 |
|------|------|
| `electron/api/agent-config.ts` | `agentReadMaxSubAgent()` |
| `src/flow-map/schedule/pipeline.ts` | `schedulePickWorks` |
| `src/flow-map/timeline.ts` | `timelinePickWorks` facade |
| `electron/api/graph-service.ts` | `runReadAllSessions(mapId)` |
| `src/flow-map/adapters/electron-ipc.ts` | 并行 `runParallelTransitions`、doc 变更队列 |

## 调度

```
limit = mode === 'auto' ? agentReadMaxSubAgent() : 1
works = schedulePickWorks(ctx, key, pending, timeline, selectedNewsId, limit)
```

- limit=1：委托 `schedulePickWork`（activeLine + 034 序）
- limit>1：全 pending 按 rank 排序取前 N（distinct parent）

## 后端

- graph-service：同 mapId 多 `runId` 并存；`runReadAllSessions` 列表查询。
- adapter：`Promise.all` 并行 `runOneTransition`；`adapterEnqueueDoc` 串行化 wireEvents 对 doc 的写。

## 与 maxConcurrency

- `maxConcurrency`：单数据节点内 route 扇出上限（已有）
- `maxSubAgent`：auto 下同时推进的数据节点数（本方案）

## 验收

- auto + 双新闻 pending：一次 `runTimeline` 可 pick 2 work（maxSubAgent≥2）
- HITL：行为与 034 一致
- `npm run test:map` 全绿
