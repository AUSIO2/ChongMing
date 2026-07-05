# Electron 图管线合并 — 阶段 3 收尾

## 3.2 runCreate

`runCreate(graphType, input)` + `GRAPH_RUN_SPEC` 配置表；`runCreateSplit` / `runCreateVerify` 保留为薄包装。

`splitRunGraph` / `verifyRunGraph` 已删除；`graph-service` 直接调 `graphRunInterrupt`。

## 3.3 merge-flags

[`electron/shared/merge-flags.ts`](../electron/shared/merge-flags.ts)：`mergeReadShouldSave`、`mergeUpdateClaims`、`mergeUpdateDraftFlags`。

## 3.4 Resume 单源

`docReadResume` 为唯一 patch 策略；`runUpdateResume` 信任 adapter 传入，不再剥 `routeInstructions`。

## 3.5 mapIdReadInterruptFocus

自 `deriveInterruptFocus` 迁入 [`map-ids.ts`](../electron/shared/map-ids.ts)。
