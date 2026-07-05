# 034-implement — Timeline 图层拓扑调度

## 步骤

- [x] `schedule/pipeline.ts` — 源链串行 derive/pick + endX
- [x] 删除 `schedule/pick.ts`；`timeline.ts` facade 更新
- [x] `runTimeline` 单 key + endX 守卫
- [x] `timeline.spec.ts` 源链/endX 回归
- [x] counter=34

## 验证

```bash
npm run test:map
```
