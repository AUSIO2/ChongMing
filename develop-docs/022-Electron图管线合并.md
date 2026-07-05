# Electron 图管线合并

## 阶段 3.1 graphBuildHitl — 部署边界

`graphBuildHitl` 仅抽取 LangGraph **拓扑**（边、interrupt、fanout），不含 DB/业务逻辑。

**必须保留：**

- `splitBuildGraph` / `verifyBuildGraph` 为独立 public API（薄包装 + 注入不同节点）
- 领域节点（load、subAgent、merge、save）留在 `fact-extractor` / `fact-verifier`
- `agentReadSplitConfig` / `agentReadVerifyConfig` 配置分离

**禁止：**

- 合并 split+verify 为单一 graph 类型或单一 state
- 在 shared 工厂内硬编码双域逻辑

**分布式部署：** 将来拆进程时，各 worker 仅依赖 `electron/shared/graph-hitl` + 本域节点注入；3.1 不绑定部署形态。
