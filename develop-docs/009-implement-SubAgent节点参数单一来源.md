# 009-implement — SubAgent 节点参数单一来源

## 目标

以 `RouteInstruction` 为 SubAgent 节点参数唯一来源，删除 `SubAgentParams`，去掉 adapter 参数翻译与假展示字段。

## 步骤

1. **类型**
   - `flow-map/types.ts`：删除 `SubAgentParams`；`SubAgentMapNode.params` 使用从 `electron/api/types`（或 shared）导入的 `RouteInstruction`；re-export `RouteInstruction`
   - `flow-map/api.ts`：`AddSubAgentInput.params` / `UpdateNodeParamsPatch` 改为基于 `RouteInstruction`
   - `flow-map/index.ts`：导出 `RouteInstruction`

2. **Adapter `electron-ipc.ts`**
   - `PendingSlot` 改为 `{ parentNodeId, route: RouteInstruction }`（`route.instanceId` 必填）
   - `pushSubAgent` 接收 `RouteInstruction`，原样写入 `params`
   - `project` / `addSubAgent` / `updateNodeParams` / `removeNode` / `pendingRoutesFor` 去掉 displayLabel 与字段搬运

3. **Store / UI**
   - `stores/flow-map.ts`：`addSubAgent` 参数类型改为 `RouteInstruction`
   - `FlowMapInspector`：加槽只传 `agentName` + `priority`；名称展示查 catalog
   - `FlowMapTopology` / `FlowMapControls`：标签用 catalog 或 `agentName`

4. **测试**
   - `graph-ops.spec.ts` / `layout.spec.ts`：subAgent params 去掉 `displayLabel`，补 `instanceId`（可选）

5. **验证**
   - `vue-tsc --noEmit`
   - `npm run test:map`

## 非目标

- 不合并 catalog 三套类型（`SubAgentCatalogEntry` / DTO / `SubAgentEntry`）
- 不改 `SubAgentConfig` / prompt 路径
- 不改 claim / opinion / news 的 params 形状
