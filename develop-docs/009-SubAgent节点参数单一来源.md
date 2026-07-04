# 009 — SubAgent 节点参数单一来源

## 问题

SubAgent「槽位节点参数」前后端各有一套：

| 层 | 类型 | 字段 |
|----|------|------|
| Map（前端） | `SubAgentParams` | `agentName`, `displayLabel`, `description?`, `priority`, `hint?` |
| 图状态（后端） | `RouteInstruction` | `agentName`, `priority`, `hint?`, `instanceId?` |

Adapter 在两套之间搬运字段；`displayLabel` / `description` 不进图状态、不可写，却挂在节点 `params` 上，造成「假参数」与双真相源。

注册表（`SubAgentConfig` / catalog）是静态「有哪些 agent」，与槽位实例参数无关，本设计不合并注册表。

## 唯一来源

**`RouteInstruction`（`electron/shared/types.ts`）是 SubAgent 节点参数的唯一契约。**

- 图状态 `routeInstructions: RouteInstruction[]` 直接持有该形状
- Map 节点 `SubAgentMapNode.params` **就是** `RouteInstruction`（含 `instanceId`）
- 删除 `SubAgentParams`；不再做参数形状翻译，只做拓扑投影（`id` / `parentId` / edges）

展示名（`displayLabel` / `description`）属于 **catalog 元数据**，按 `agentName` 查表，不写入节点 params。

## 边界

| 概念 | 类型 | 说明 |
|------|------|------|
| 槽位参数（唯一） | `RouteInstruction` | 实例：谁、priority、hint、instanceId |
| 目录项（静态） | `SubAgentEntry` / `CatalogEntryDTO` | 可添加候选 + 展示文案 |
| 运行时注册 | `SubAgentConfig` | promptPath / model / tools |

## 可写面

Inspector / `updateNodeParams` 对 subAgent 仅允许：

```ts
Partial<Pick<RouteInstruction, 'priority' | 'hint'>>
```

`agentName` / `instanceId` 在加槽时确定，之后不可改。

## Adapter 行为

- `pending` 槽：存完整 `RouteInstruction`（必含 `instanceId`）
- `project`：`routeInstructions` / pending **原样**写入 `node.params`
- `addSubAgent`：补 `instanceId` 后写入 pending（及 invoke 期 active state）
- 不再构造 `displayLabel: route.agentName`

## UI

- 拓扑 / 焦点条：优先 `catalog` 中同名项的 `displayLabel`，否则 `params.agentName`
- Inspector：名称只读展示（查 catalog）；可编辑仅 priority / hint
