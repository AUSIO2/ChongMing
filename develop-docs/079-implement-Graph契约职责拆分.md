# 079 — Graph 契约职责拆分实施记录

日期：2026-09-30。设计见 [079](./079-Graph契约职责拆分.md)。

## 已完成

- `graph.ts` 从 474 行缩为 57 行，只保留 payload、节点、边与变更输入。
- 新增 `graph-agent.ts`、`graph-branch.ts`、`graph-run.ts`、`graph-work.ts` 和 `graph-api.ts`，完整迁移原有 51 个声明。
- 57 个调用文件直接导入对应定义，覆盖源码、Vue、脚本、测试和内联类型引用。
- `data-definition.ts` 直接导入 `graph-agent.ts`，解除原有图协议循环依赖。
- ARCHITECTURE.md 增加各契约文件的职责导航。

## 基线

- 开始时工作区干净。
- 拆分前 `vue-tsc --noEmit` 通过。

## 验证结果

- 声明逐项对照：原有 51 个类型的名称和声明正文完全一致，没有重复或遗漏。
- 调用方对照：57 个文件仅有 Graph 类型导入变更；其余文本保持一致。
- 静态核对：243 处类型导入均指向真实导出；六个 Graph 文件与 `data-definition.ts` 的依赖无环。
- `vue-tsc --noEmit` 通过。
- `npm run test:boundaries` 通过：模块边界与运行时错误消息检查均通过。
- 以下现有回归共 7 个文件、61 个测试通过：

~~~bash
./node_modules/.bin/vitest run --config vitest.config.ts \
  tests/backend/modules/graph/branch.spec.ts \
  tests/backend/modules/graph/local-coordination.spec.ts \
  tests/client/graph-client.spec.ts \
  tests/client/session.spec.ts \
  tests/client/stream.spec.ts \
  tests/client/layout.spec.ts \
  tests/backend/execution/prompt.spec.ts
~~~

- `git diff --check` 通过。
- 本次只拆分类型与迁移引用，未运行 Mongo/RabbitMQ 全量集成测试、桌面运行时检查或打包，也未将 Vitest 运行计作测试文件的类型检查。
