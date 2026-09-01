# 重明 ChongMing

面向新闻事实拆分与核查的桌面 Agent 应用。

## 架构

代码按三层组织：

1. Renderer：Vue UI，只通过 `mapper.read / dispatch / watch` 使用业务能力。
2. Mapper：唯一业务状态机，负责文档、运行步骤、人工确认和断点续跑。
3. AgentLoop：单次 Agent 调用适配器；当前实现基于 LangGraph，可独立替换。

持久化以 `MapperDocument` 为唯一事实源。运行中的每次 Agent 调用会先登记、再执行、完成后立即落库；应用重启后由 Mapper 跳过已完成调用并继续未完成部分。

## 开发

```bash
npm install
npm run dev
npm test
npm run build:check
```

无头运行：

```bash
npm run headless -- --help
```

项目不维护旧数据结构兼容层。结构变更时直接清理开发数据库，再使用当前 schema。
