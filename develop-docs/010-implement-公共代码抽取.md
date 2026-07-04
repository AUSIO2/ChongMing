# 010-implement — 公共代码抽取（1–7）

1. `map-ids`：加 `routeInstanceId` / `routeNodeId`；`flow-map/ids` 再导出；`electron-ipc` 改用
2. `flow-map/types`：删除本地 Priority/Confidence/ExecutionMode，从 `electron/api/types` 或 shared re-export
3. `sub-agent-catalog`：`name` → `agentName`；`listCatalogEntries` 直接返回条目（去掉 promptPath）；`CatalogEntryDTO` / `SubAgentEntry` 对齐；`agent-config` 用 `agentName`
4. 新增 `electron/shared/errors.ts`；替换 store / graph-service / database
5. `graph-service`：`executeRun` 泛型合并 split/verify
6. `GraphConfig` 放 shared 或 fact-extractor/types，verifier/extractor 改用
7. `src/flow-map/labels.ts`：`RUN_PHASE_LABEL`；Header / Controls 引用

验证：`vue-tsc --noEmit`、`npm run test:map`
