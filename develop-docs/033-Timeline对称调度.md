# 033 — Timeline 对称调度

## 背景

0-1 / 1-2 / 2-3 调度逻辑曾各自维护 pending 发现、scope 推进、interrupt 过期判定，形成结构性不对称与重复 bug（如已完成后仍回退 snapshot、scope 不推进、stateIndex 过早 bump）。

LangGraph 执行（`TRANSITION_REGISTRY`）与 Map 投影（`PROJ_REGISTRY`）已有对称注册表，调度层缺失对应第三层。

## 目标

用 **WorkItem + ScheduleSpec** 统一三阶段 orchestration：

```
SCHEDULE_REGISTRY  →  何时跑、跑哪个 parent
TRANSITION_REGISTRY →  LangGraph 执行
PROJ_REGISTRY       →  Map 图投影
```

## 模型

```ts
interface TimelineWorkItem {
  parentNodeId: string
  scopeNodeId?: string   // 1-2=newsId, 2-3=claim 所属 news
}

interface TimelineScheduleSpec {
  key: TransitionKey
  readPending(ctx): TimelineWorkItem[]
  readInterruptStale(ctx, parentId): boolean
  readScopePatch?(parentId): { activeScope?: string }
}
```

## 对称算法

### deriveStateIndex

按列扫描 pending，返回最早有待办的 x：

1. `0-1` pending 非空 → x=0
2. 无任何有正文 news → x=0
3. `1-2` pending 非空 → x=1
4. `2-3` pending 非空 → x=2
5. 否则 x=3

### runTimeline（单次运行）

对每个 transition key：

1. `timelinePickWork(readPending, timeline, selectedNewsId)` — 优先级：selectedNews > activeScope > 稳定序
2. 更新 `activeScope`（来自 `scopeNodeId` 或 `readScopePatch`）
3. `runOneTransition` 一条
4. interrupted → 返回；completed → **暂停**；若该列 pending 已空则 bump `stateIndex`

### stateIndex 规则

仅当该 transition 列 `readPending` 为空时才写入 `stateIndex = nextX`，避免「核查一条即 stateIndex=3」导致 `resolveKeys` 为空。

## 各 spec 差异（数据层固有不对称）

| 阶段 | parent 类型 | readPending 条件 |
|------|------------|------------------|
| 0-1 | source | news 正文为空 |
| 1-2 | news | 有正文且无 persisted claim |
| 2-3 | claim | `!verifyResult` |

## 模块

- `src/flow-map/schedule/` — parse / split / verify spec + registry + pick
- `src/flow-map/timeline.ts` — facade（derive、readPending、readParents、readRunParent）

## 验收

- 多新闻：A 完成后自动调度 B（拆分 / 核查）
- 已完成的 interrupt 清 session 后重新调度
- `npm run test:map` 全绿
