# 030 — Map 阶段 D 清理

## 目标

删除 `NEWS_ROOT_ID`（`__news_root__`）shim，统一为 `MAP_DEFAULT_NEWS_ID`（`news:default`）。

## 变更

| 旧 | 新 |
|----|-----|
| `NEWS_ROOT_ID = '__news_root__'` | 图节点 `MAP_DEFAULT_NEWS_ID = 'news:default'` |
| chains 默认 scope | `MAP_DEFAULT_SCOPE = 'default'`（无冒号，经 `mapScopeReadKey` 映射） |
| chains / mapGraph 存量 shim | `dbMigrateLegacyNewsRoot()` 启动迁移 |

## 不在本阶段

- 工作区 `chongming.project.json` 完整流（D5）
- 微观 HITL timeline-steps（D6）

## 验收

- 生产代码无 `NEWS_ROOT_ID`
- `npm run test:map` 全绿
