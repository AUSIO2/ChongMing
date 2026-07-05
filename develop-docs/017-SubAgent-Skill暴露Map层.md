# SubAgent Skill 暴露 Map 层

## 背景

SubAgent 在 ReAct 循环内可调用配置化 skill（如 `web_search`），但此前对 Map 层不可见：外层 LangGraph 只能观测到 `subAgent` 节点整体进出，内层 tool 调用是黑盒。

Map 层语义上，`activeTool` / `pendingTool` 专指 HITL 工作流（invoke / validate / save），不能与 LLM skill 混用。

## 目标

1. 运行时捕获 SubAgent 正在调用的 skill（名称 + 参数摘要）。
2. 经现有 `GRAPH_PROGRESS` IPC 投影到对应 `subAgent` 节点的 `runtime.activeSkill`。
3. 并行多 SubAgent 扇出时，各节点 skill 状态互不干扰。
4. 本次不改前端 UI。

## 非目标

- LangSmith 接入（开发期 trace，与 Map Port 正交）。
- 外层图统一 `stream` + ReAct 子图化重构。
- skill 调用历史持久化。

## 架构

```text
subAgent 节点
  └─ invokeWithOptionalTools
       └─ createReactAgent + LangChain callback（handleToolStart/End）
            └─ createSubAgentSkillEmitter(instanceId)
                 └─ GraphRunSession.onProgress(subagent_tool)
                      └─ GRAPH_PROGRESS → applyGraphProgress
                           └─ nodes[sub:{instanceId}].runtime.activeSkill
```

### 为何不用外层 `graph.stream({ streamMode: ["tools"] })`

当前 ReAct 在 `subAgent` 节点函数内黑盒 `.invoke()`，外层 stream 看不到内层 tool 事件。内层通过 LangChain callback 捕获（与 LangGraph `tools` 流同源），再桥接到 Map。

### session 查找

`runGraphWithInterrupts` 按 `thread_id` 注册 `GraphRunSession`；SubAgent 节点通过 `getConfig().configurable.thread_id` 查找并发射进度。

## 类型扩展

### GraphProgressPayload

新增事件：

```ts
{
  event: 'subagent_tool'
  phase: 'start' | 'end'
  instanceId: string
  agentName?: string
  toolName: string
  argsSummary?: string  // 仅 start
}
```

### Map runtime

```ts
runtime?: {
  activeTool?: MapToolKind
  pendingTool?: MapToolKind
  activeSkill?: { name: string; argsSummary?: string }
}
```

## Map 投影规则

| 事件 | 行为 |
|------|------|
| `subagent_tool` + `start` | 写 `activeSkill` 到 `sub:{instanceId}` |
| `subagent_tool` + `end` | 清除该节点 `activeSkill` |
| `node_enter` / 其他图级进度 | `clearHitlRuntimes`（只清 HITL 标记，保留 `activeSkill`） |
| `node_exit` + `subAgent` | 清除所有 subAgent 的 `activeSkill`（兜底） |

## 关键文件

| 层级 | 文件 |
|------|------|
| 捕获 | `electron/shared/llm-utils.ts` |
| 桥接 | `electron/shared/graph-utils.ts`, `extractor.ts`, `verifier.ts` |
| IPC | `electron/api/types.ts`, `graph-service.ts` |
| Map | `src/flow-map/types.ts`, `graph-doc.ts`, `adapters/electron-ipc.ts` |

## 验收

- 来源可信度 / 数据可验证性调 `web_search` 时，Map 快照对应 subAgent 节点出现 `activeSkill`（含 query 摘要）。
- 并行两槽：A 调工具时 B 的 `activeSkill` 不被清除。
- HITL `applyProgress` 焦点迁移行为不退化。
- `npm run test:map` 通过。
