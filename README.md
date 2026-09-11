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

共享后端（第五阶段，需要Mongo副本集，可用单节点副本集开发）：

```bash
# 设置CHONGMING_MONGO_URI为实际副本集连接；admin.json内容为 {"displayName":"Owner"}。
npm run admin -- init --input /absolute/path/to/admin.json
npm run graph:serve
npm run host:serve -- --host-id host-a --dsh-home /absolute/path/to/host-a
```

初始化会返回用户token一次，并在本机缺失时私下生成内部Host token。公开 `POST /api/v1/query` 和 `/api/v1/command` 必须携带用户Bearer token。通过 `workspace.create` 创建工作区（agentSource可选library或empty）；Owner管理成员和Agent，Editor操作图与Run，Viewer查看及保存本人偏好。

核查流程为：Claim → 路由Agent动态选择角度和自定义Agent/tool → Host领取各角度 → DSH执行 → 汇总与两轮人工审核 → 结论入图。run.start只提交目标，配置由服务器从工作区副本与共享设置冻结。库修改不自动覆盖工作区；已经运行的配置保持不变。

另一个终端或机器用独立DSH目录启动Host，连接同一Mongo或图服务，即可并行演进同一张图。Host失租会停止执行，到期后其他Host接管未完成项。模型/工具由可信DSH provider与`--patch`注册；凭据可通过本机admin secret.set管理，工作区配置和v3包不携带系统密钥。

当前支持用户/Token、工作区和成员、Agent共享库与私有副本、个人偏好、非秘密设置、GridFS资产以及Map/Workspace v3导入导出。source/evidence可引用共享资产，但parse/split执行与旧前端还未接线。

完整字段、权限、运行及管理员命令见 [055 接口文档](./develop-docs/055-接口文档.md)，架构见 [055 技术设计](./develop-docs/055-共享管理与资产.md)。新代码位于`backend/`和`contracts/`；上面的Renderer/Mapper/AgentLoop仍是旧桌面路径。

本机配置默认在`.chongming-host`（可用CHONGMING_CONFIG_DIR修改），环境变量优先；配置/凭据文件0600，已排除版本控制。切库时先停止Host与图服务，使用admin database.stage配置下一次启动，再重启。

旧development图和用户未提交的Mapper改动保持原样，不自动删除或赋给某个新用户。正式API使用真实Workspace UUID；旧数据迁移和最终桌面切换另行处理。
