# Implement: Map 主键与过渡注册表（阶段 A）

对应设计：[025-Map主键与过渡注册表.md](./025-Map主键与过渡注册表.md)

## 任务清单

- [x] `database.ts`：`MapModel`、`chains`、`dbMigrateNewsToMap`
- [x] `map-scope.ts`：scope 读写、`MAP_DEFAULT_SCOPE`
- [x] `types.ts` / `serialize.ts`：`DisplayMap`、`transitionKey`、`parentNodeId`
- [x] `map-service.ts` 替代 `news-service.ts`
- [x] `transitions/` + `extractor` / `verifier` 按 chains 读写
- [x] `graph-service.runTransition` + `TRANSITION_REGISTRY`
- [x] IPC `map:*`、`graph:run-transition`；preload `electronAPI.map`
- [x] 前端 adapter / stores / 组件 `mapId` 改名
- [x] `graph-doc.spec` / `map-ids.spec` / `layout.spec` 更新

## 验收

- `npm run test:map` 45 passed
- `vue-tsc --noEmit` 通过
