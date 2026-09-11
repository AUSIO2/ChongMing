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

数据图通过 `POST /api/v1/query` 读取，通过 `POST /api/v1/command` 执行图命令、Run 和 Review。新后端核查流程为：Claim → 路由 Agent 动态选择角度及自定义 Agent/tool → Host 领取各角度 → DSH 执行 → 汇总 Agent → 结论入图。人工模式分别审核路由和结论；一次 Run 保存完整配置快照，报告数量由批准的路由决定。

默认提示词分文件保存在 `backend/prompts/verify/`，也可在 `run.start.configuration` 提交自定义配置。工具实现由可信 Host 的 DSH 插件注册。图服务与 Host 使用相同的 `CHONGMING_DATA_TOKEN`；多个图服务共用 `CHONGMING_MONGO_URI`。当前仍使用本机开发入口和固定开发工作区，旧前端尚未连接。

新后端的完整接口见 [054 接口文档](./develop-docs/054-接口文档.md)，自动执行设计见 [054 技术设计](./develop-docs/054-自动执行与多Host租约.md)。上面的 Renderer/Mapper/AgentLoop 是旧桌面运行路径，新代码位于 `backend/` 与 `contracts/`。

保持图服务运行，启动常驻 Host：

```bash
npm run host:serve -- --host-id host-a --dsh-home /absolute/path/to/host-a
# 另一终端或机器使用独立目录，共享数据库即可并行核查同一 Claim 的其他角度。
npm run host:serve -- --host-id host-b --dsh-home /absolute/path/to/host-b
```

此后 `run.start` 和路由审核批准都会自动推进。Host 失租会停止本地执行，其他 Host 可在到期后接管未完成项；已有报告不会重跑。可信自定义工具或 provider 使用 `--patch /absolute/path/to/tools.patch.yml` 注册，各 Host 部署所需插件及模型凭证。旧无租约 `dsh:verify` 命令已移除。

项目不维护旧数据结构兼容层。结构变更时直接清理开发数据库，再使用当前 schema。
