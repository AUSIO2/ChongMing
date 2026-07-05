# Map 节点 ID 统一

## 背景

SubAgent 槽位存在多套 id 规则（拆分 `agentName#n`、核查 `claimId:agentName`、Map 节点 `sub:…`），progress 事件传 `instanceId` 而 UI/焦点用 `MapNode.id`，导致匹配逻辑复杂且易错（017 skill 展示 bug）。

## 目标

1. **instanceId 全局统一**为 `agentName#n`；核查作用域仅靠 `parentId`（claim 节点 id）。
2. **progress / skill 事件对外只传 `nodeId`**（`sub:{instanceId}`）。
3. **删除** `verifyInstanceId`、`scopedVerifyInstanceId`、`verifyClaimId`、`scopedVerifyRoute`。
4. **新运行与恢复** `threadId = runId`（UUID）；不兼容旧 `split-*` / `verify-*` 前缀。
5. **bootstrap** 直接使用持久化的 `instanceId`（`agentName#n`），不做 `claimId:agentName` 归一化。

## 非目标

- `draft:N` 与落库 `claimId` 合并（后续）
- `edge.id` 改为派生（后续）
- MongoDB schema 迁移（内存归一化即可）

## 规则

| 概念 | 规则 |
|------|------|
| instanceId | `agentName#n`，在**同一 parentId** 下唯一 |
| MapNode.id (subAgent) | `sub:${instanceId}` |
| progress.subagent_tool | `{ nodeId, toolName, phase, argsSummary? }` |
| progress.fanout_spawn | `{ nodeId, parentNodeId, agentName? }` |
| threadId（新） | 等于 `runId` |

## 数据流

```text
routeInstructions[].instanceId  (agentName#n)
        │ routeNodeId
        ▼
   nodeId = sub:agentName#n  ──► GRAPH_PROGRESS ──► graph-doc 按 nodeId 写 runtime
        ▲
   parentId = __news_root__ | claimId
```

## 关键文件

- `electron/shared/map-ids.ts`
- `electron/api/types.ts`, `graph-service.ts`
- `electron/shared/graph-utils.ts`
- `src/flow-map/graph-doc.ts`, `adapters/electron-ipc.ts`

## 验收

- `npm run test:map` 通过
- 核查/拆分 HITL 与 auto 下 SubAgent skill 展示正常
