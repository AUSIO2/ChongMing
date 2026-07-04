# 014 implement — Map 层坏味道清理

1. `types`：`MapClaimNode.shouldSave`；`GraphClaimDto.shouldSave`；`GraphInterruptNode` = confirmRoute | validate | save（工具中断点）；`canWriteRouteInstructions(pendingTool?)`
2. `graph-doc`：reset / activeTool / 去 gate / shouldSave 投影与 `pruneRejectedClaims` / 导出 `ensureSubAgent`；简化 `canAddSubAgent`
3. `electron-ipc`：`addSubAgent` 复用；`continueStep` 在 validate 工具时先剪枝
4. `graph-service`：`validate`（及兜底 `merge`）→ pendingTool=validate；resume 只用 pendingTool
5. `extractor`：merge LLM + `validate` 工具空节点；merge 只标 shouldSave；更新 merge prompt；删 sourceAgent 启发式
6. `verifier`：对称 `validate` 工具中断点
7. UI：`RightNewsPanel` / Inspector / Topology
8. `graph-doc.spec`：reset / activeTool / shouldSave 剪枝 / buildResumePatch
