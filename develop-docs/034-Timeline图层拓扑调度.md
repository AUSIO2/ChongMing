# 034 — Timeline 图层拓扑调度

## 背景

033 对称调度按 **全局列** 扫描 pending：任意新闻待拆分会阻塞所有新闻的核查，导致源链之间乱序（新闻 1 拆分后跳过核查、去新闻 2；核查中途又回跳；漏掉 subAgent 2 的 claim）。

## 目标

复用 [`timelineProjectLines`](src/flow-map/timeline-project.ts) + [`MAP_COLUMN`](electron/shared/map-columns.ts)，在 **源链 × 层** 拓扑序上调度：

1. 从上到下（`layoutY`）逐条源链
2. 每条链内按列 parse → split → verify
3. 整条链达到 `timeline.endX` 深度后再进入下一条链

## 模块

[`src/flow-map/schedule/pipeline.ts`](src/flow-map/schedule/pipeline.ts)：

- `scheduleReadLines` / `scheduleFindLine` / `scheduleReadLineNews`
- `scheduleReadLinePending(ctx, line, endX)` — 本线在 endX 下的 stage；null = 已达结束深度
- `scheduleDeriveStateIndex(ctx, timeline)` — 首条未完成源链
- `scheduleReadActiveLine` / `schedulePickWork` — activeLine 过滤 + layoutY 排序
- `scheduleReadTransitionKey` / `scheduleLinePendingEmpty`

## endX

| endX | 源链视为完成 |
|------|-------------|
| 1 | 有新闻正文 |
| 2 | 有 persisted claim |
| 3 | 全部 claim 已核查 |

`runTimeline`：`derived >= endX` → done；仅调度单个 `${derived}-${derived+1}` key。

## 验收

- 双新闻：A 拆分后先核查 A，再处理 B
- 同新闻多 subAgent：按 claim layoutY 顺序核查
- endX=1/2 裁剪仍有效
- `npm run test:map` 全绿
