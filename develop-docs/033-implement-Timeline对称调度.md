# 033-implement — Timeline 对称调度

## 步骤

### 1. schedule 模块

- [x] `schedule/types.ts` — WorkItem、ScheduleContext、ScheduleSpec
- [x] `schedule/scope.ts` — scopeHasPersistedClaims、scopeNeedsSplit
- [x] `schedule/parse.ts` — 0-1 spec
- [x] `schedule/split.ts` — 1-2 spec
- [x] `schedule/verify.ts` — 2-3 spec
- [x] `schedule/registry.ts` — SCHEDULE_REGISTRY
- [x] `schedule/pick.ts` — timelinePickWork

### 2. timeline facade

- [x] `timelineDeriveStateIndex` 扫描 0/1/2 列 pending
- [x] `timelineReadPending` / `timelineReadInterruptStale` / `timelineReadScopePatch` 委托 registry
- [x] 删除 `timelineReadSplitScope`、`timelineReadVerifyScope` 及散落 helper

### 3. runTimeline 单循环

- [x] `electron-ipc.ts` 删除 1-2 / 2-3 重复 while
- [x] 统一 pick → run → pause；pending 空才 bump stateIndex

### 4. 测试

- [x] `timeline.spec.ts` — 三阶段 readPending、pickWork、derive、interruptStale、stateIndex 回归

### 5. 文档

- [x] `033-Timeline对称调度.md`
- [x] `counter.txt` → 33

## 验证

```bash
npm run test:map
```

重启 Electron 后手动验证多新闻 map 的解析 / 拆分 / 核查调度。
