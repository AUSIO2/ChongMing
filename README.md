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

独立 DSH 运行时（第一阶段）：

```bash
CHONGMING_DSH_HOME=/absolute/path/to/dsh-home npm run dsh:serve
curl http://127.0.0.1:4318/health
```

`POST /runtime/dsh/run` 接受 `{ "prompt": "...", "sessionId": "可选" }`，以 NDJSON 依次返回 DSH 通知和最终结果。相同进程内可用同一 sessionId 继续对话。运行模型需要 DSH profile 对应的凭证。当前官方 SDK 线协议没有单 Session 中途取消、冷 Session 查询或跨进程恢复已有 Session；关闭服务会结束整个 SDK 子进程。

独立数据图服务（第二阶段）：

```bash
CHONGMING_MONGO_URI=mongodb://127.0.0.1:27017/chongming_graph npm run graph:serve
curl http://127.0.0.1:4320/health
```

数据图通过 `POST /api/v1/query` 读取，通过 `POST /api/v1/command` 执行图命令、Run 和 Review。新后端核查流程为：Claim → 路由 Agent 动态选择角度及自定义 Agent/tool → DSH 委派 → 收集各角度报告 → 汇总 Agent → 结论入图。人工模式分别审核路由和结论；一次 Run 保存完整配置快照，报告数量由批准的路由决定。

默认提示词分文件保存在 `backend/prompts/verify/`，也可在 `run.start.configuration` 提交自定义配置。工具实现由可信 Host 的 DSH 插件注册。内部数据接口要求 `CHONGMING_DATA_TOKEN`。当前仍使用本机开发入口和固定开发工作区；`run.start` 尚不会自动领取执行，也未连接旧前端。

新后端的当前可用接口见 [053 接口文档](./develop-docs/053-接口文档.md)，动态核查设计见 [053 技术设计](./develop-docs/053-动态核查路由.md)。上面的 Renderer/Mapper/AgentLoop 是旧桌面运行路径，新代码位于 `backend/` 与 `contracts/`。

创建 Run 后，使用同一个本机 `CHONGMING_DATA_TOKEN` 驱动其 operation：

```bash
npm run dsh:verify -- --map-id MAP_UUID --operation-id OPERATION_ID
```

执行器运行到 `waiting` 或 `done` 返回；人工批准路由后再次执行相同命令，读取已持久化进度继续。可信自定义工具或 provider 使用 `--patch /absolute/path/to/tools.patch.yml` 注册。模型凭证由 DSH Host 配置提供。

项目不维护旧数据结构兼容层。结构变更时直接清理开发数据库，再使用当前 schema。
