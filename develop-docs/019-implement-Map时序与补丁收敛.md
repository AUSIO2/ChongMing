# Implement: Map 时序与补丁收敛

对应设计：[019-Map时序与补丁收敛.md](./019-Map时序与补丁收敛.md)

## 任务清单

- [x] `map-ids`：`allocateInstanceId`、`agentNameFromInstanceId`、`inferFocusFromNodeId`
- [x] `graph-service`：restore 握手、`resumeGraph` 未就绪抛错、restore 跳过重复 interrupt、focus infer
- [x] `graph-doc`：runId 守卫、收紧 fallback、`applyInterrupted` 幂等
- [x] `graph-utils`：fanout HITL 重排、`withInstanceIds` 用 allocator
- [x] `electron-ipc`：事件仅已加载图、onCompleted 顺序、addSubAgent allocator、continueStep 回滚
- [x] 低优先级：`use-flow-map`、`FlowMapInspector`
- [x] `graph-doc.spec` / `map-ids.spec` 回归测试
- [x] 重建 `dist-electron`

## 验收

- `npm run test:map` 全绿
