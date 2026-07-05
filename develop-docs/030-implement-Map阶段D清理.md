# Implement: Map 阶段 D 清理

对应设计：[030-Map阶段D清理.md](./030-Map阶段D清理.md)

## 任务清单

- [x] `map-ids`：`MAP_DEFAULT_NEWS_ID` / `mapIdIsDefaultNews`；删除 `NEWS_ROOT_ID`
- [x] 全栈替换引用 + `dbMigrateLegacyNewsRoot`
- [x] `getSubAgentCatalog` 按 news id 前缀判 split
- [ ] 工作区 UI 收尾（后续）
- [x] `npm run test:map`
