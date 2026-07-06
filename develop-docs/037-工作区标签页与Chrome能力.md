# 037 — 工作区标签页与 Chrome 菜单能力

## 目标

- 中心区域 VS Code 风格 **WorkspaceTabBar**
- Map 多标签；数据库 / 智能体单例标签画布；工具 Modal
- Chrome 菜单真实能力：保存/导出、库切换、图工具、智能体 CRUD

## 模块

| 模块 | 路径 |
|------|------|
| 标签 store | `src/stores/workspace-tabs.ts` |
| Run 协调 | `src/stores/run-coordinator.ts` |
| 标签栏 | `src/components/shell/WorkspaceTabBar.vue` |
| 画布 | `DatabaseCanvas.vue` / `AgentManagerCanvas.vue` |
| 分发 | `src/chrome/chrome-dispatch.ts` |

## 标签模型

- `map`：多实例，id=mapId
- `database` / `agents`：单例 `__database__` / `__agents__`

## 边界

- 切库：关闭全部 map 标签 + unload；有 running 阻断
- 多 Map 并行 run：`run-coordinator` 跟踪 `runPhaseByMapId`
- 038：`maxSubAgent` 单 map 内跨节点并行

## 验收

- 侧栏开图 → 标签；菜单开数据库/智能体 → 单例标签
- 工具弹窗不占标签
- `npm test` 全绿
