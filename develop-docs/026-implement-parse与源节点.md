# Implement: Parse 过渡与源节点（阶段 B）

对应设计：[026-parse与源节点.md](./026-parse与源节点.md)

## 任务清单

- [x] `map-ids`：source/parse/news chain id + focus `0-1`
- [x] `types` + `graph-doc`：`source`/`parseAgent`；`docAddSourceChain`；`docProjectParse`
- [x] `fact-parser/parser.ts` + prompt + `agentReadParseConfig`
- [x] `transitions/parse.ts` 注册 `0-1`
- [x] `serialize` / `graph-service` / `database` enum
- [x] adapter：`addSourceChain`、`startParse`；Controls 解析按钮
- [x] `FlowMapTopology` / `labels` / `layout` 新 kind
- [x] 测试 + typecheck（49 passed，`vue-tsc --noEmit`）
