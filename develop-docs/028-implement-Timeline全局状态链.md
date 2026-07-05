# Implement: Timeline 全局状态链（阶段 C）

对应设计：[028-Timeline全局状态链.md](./028-Timeline全局状态链.md)

## 任务清单

- [x] `timeline.ts` + `timeline.spec.ts`
- [x] DB `timeline` 全局字段 + `mapUpdate` timeline patch + `DisplayMap.timeline`
- [x] `runTimeline`（adapter 编排 `runTransition`）+ 移除 `startNextVerify` 自动链
- [x] `FlowMapTimeline.vue` + Controls「运行」→ `runTimeline`
- [x] `flow-map` store `runTimeline` / `updateTimeline`
- [x] 测试 + typecheck（`npm run test:map` 56 passed，`vue-tsc --noEmit`）

## 说明

- 宏观 `runTimeline` 在 **renderer adapter** 内实现（有内存图 + 事件订阅），不经单独 IPC。
- 旧 DB `timeline.scopes` 在 `serialReadTimeline` 读取时归一化为全局字段。
