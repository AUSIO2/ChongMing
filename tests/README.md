# tests

与 `src/` 分离的自动化测试模块。

```bash
npm run test:map    # Map 层
npm test            # 全部 tests/**
```

## 结构

```
tests/flow-map/
  fixtures/           # mock API、脚本图、流程驱动器、矩阵 seed
    graph-states.ts   # Graph*State 工厂
    timeline-matrix.ts
    mock-map-api.ts
    scripted-graph.ts
    drive-timeline.ts
  *.spec.ts           # 单元 / 流程测试
  projection/         # 投影层直测
```

## 约定

- 源码：`@flow-map/*` → `src/flow-map/*`
- fixture 前缀：`test*` / `mock*`
- **不修改主代码来凑测试**；集成用例（`flow integration`）走真实 `adapterBuildIpc` + `ScriptedGraphAPI`，主代码有 bug 时失败是预期行为
- **测试自身**（harness、迁移 spec、纯函数）应稳定通过

## 流程测试分层

| 层 | 文件 | 依赖主代码 |
|----|------|-----------|
| harness | `flow-matrix.spec.ts` → `test harness` | 否 |
| 单步集成 | `flow integration` describe | 是（可能红） |
| 纯函数 | `timeline.spec.ts` 等 | 否 |

`testDriveHitlTransition` = 1×run + 3×continue，单 transition 探测；`testDriveTimelineToEnd` 仅用于后续全链探测，步数上限 40。
