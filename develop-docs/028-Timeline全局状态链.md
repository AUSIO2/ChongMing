# 028 — Timeline 全局状态链（阶段 C）

## 背景

阶段 A/B 完成 `runTransition('0-1'|'1-2'|'2-3')`。阶段 C 引入 **Map 级全局 Timeline**：用户选四列状态链起止，引擎按游标自动调度列间过渡。

## 两套列语义

| 层 | 列 | 模块 |
|----|-----|------|
| Timeline 状态链 | x=0..3 源/新闻/事实/结论 | `timeline.ts` + `FlowMapTimeline.vue` |
| 画布布局 | 7 列含工艺节点 | `MAP_COLUMN` + `layout.ts` |

## Timeline 配置（全局）

```ts
timeline: {
  startX: 0..3
  endX: 0..3
  stateIndex?: number   // 游标；未设则 derive
  activeScope: string   // 当前链锚点（news 节点 id）
}
```

## 运行

`runTimeline(mapId)` = 按 `max(startX, effectiveStateIndex)` 至 `endX` 顺序调用 `runTransition`；HITL 中断即停宏观循环；过渡完成则 `stateIndex++`。

## 不在本阶段

- 工作区磁盘项目
- 删除 `NEWS_ROOT_ID`（阶段 D）
- 多行 Timeline
