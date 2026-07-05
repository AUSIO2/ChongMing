# Implement: 数据节点编辑态锁

对应设计：[029-数据节点编辑态锁.md](./029-数据节点编辑态锁.md)

## 任务清单

- [x] `docCollectSubtree` + 后继/scope 纯函数
- [x] 重写 `docIsParamLock` / `docCanEditNode` / `docCanAddSubAgent` / `docCanRemoveNode`
- [x] 新增 `docReadLockReason`；删除 `docReadDescendants`
- [x] `docAddRootClaim` → `workerOut`；`docUpdateRunEnd` → `idle`
- [x] `timeline-project` 复用 `docCollectSubtree`
- [x] `FlowMapInspector` 用选中节点 id
- [x] `graph-doc.spec` capability 段重写 + `npm run test:map`（65 passed）
