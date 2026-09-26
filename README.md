# 重明 ChongMing

围绕事实、来源和核查结论构建数据图的桌面应用。

模块职责、依赖方向与部署入口见 [架构说明](./ARCHITECTURE.md)。

开发与审阅统一遵循 [开发规范](./coding.md)：模块、命名、排版、类型、中文用途注释、异步状态、错误和测试要求均在此维护。

源码先按用途查找：`backend/modules` 是图、工作区、身份和资产规则；`backend/adapters` 是HTTP/存储/消息实现；`backend/execution` 是Host与DSH；`apps` 是各运行入口和界面。后端导航见 [backend/README.md](./backend/README.md)，运行端导航见 [apps/README.md](./apps/README.md)。

068 已接入统一错误编号、未知错误脱敏、Node进程终端边界、受控关闭时限、HTTP/SSE/IPC诊断、Host永久错误分类，以及Electron/Vue的加载和渲染恢复入口。故障专项使用 `npm run test:faults`；桌面诊断写入userData中的 `main-diagnostics.log` 和 `local-service/service-diagnostics.log`，默认不上传。

## 当前架构

```text
独立本机：Vue/CLI ← HTTP + SSE → 本机 API + 一个 Host → DSH
                                  ↕          ↑
                              SQLite   进程内通知

多Host协作：Vue/CLI ← HTTP + SSE → Graph API ↔ MongoDB
                                     ↕
                                  RabbitMQ → 多个 Host → DSH
```

两种模式共用数据图、身份/配置/资产、Run和Review规则。独立本机不连接其他重明实例，模型和工具仍正常联网；不需要MongoDB或RabbitMQ。协作模式中多个Host领取不同工作、使用独立DSH目录。前端只提交业务命令、读取状态，不负责智能体调度。

059 已接通：用户登录 → 工作区/图 → 选择一个或多个 Source/News/Claim → 解析、拆分、核查 → 各操作独立审核 → 产物入图并推进后继。一个 Run 以 scope/until 保存范围和终点，多个 Host 可同时处理不同新闻、事实和核查角度。自定义 Agent 与工具来自冻结的工作区配置；拆分保留路由、多 Agent 提取和汇总选择。关闭图或退出客户端不停止后端 Run。

默认桌面入口为 `apps/desktop/main.ts` 和 `apps/ui/views/WorkspacePage.vue`，不加载旧 Mapper、数据库或 AgentLoop。支持运行暂停/继续：暂停持久化并撤销执行租约，恢复保留已保存产物和审核，未完成工作使用新 DSH 会话重跑。060 的「管理工作台」已接入成员、七类 Agent 配置与共享库复制、非秘密模型/工具设置、资产上传下载和数据包导入导出。061 使用RabbitMQ分发工作通知，Host不再空闲扫图；客户端通过认证SSE接收完整快照与管理刷新，保留初始读取/手动刷新，无定时图快照轮询。062 恢复各阶段树状展开：来源、解析、新闻、拆分分支、事实、核查意见与结论按子树排列，支持阶段定位并保留实时更新时的视口。063 已接入DSH固定活动摘要，树卡与进度面板实时显示模型/工具执行状态，暂停和断流清除临时活动。064 已删除旧Mapper/AgentLoop及其依赖，CLI也使用认证API；065 已提供SQLite与进程内通知的独立服务入口；066 已将Node 24和服务资源随桌面打包，支持本机一键连接、记住模式及退出排空。

Source 支持共享文本资产和公开 HTTP(S) URL，媒体限 UTF-8 text/plain、text/markdown、text/html、application/json，最多 1 MiB。URL 不携带凭证、不跟随重定向，解析并固定公开目标地址，拒绝 Host 本机及私网；首次成功读取的正文随 operation 保存。开发验收 fixture 明确允许自己的本机测试来源，生产入口不开放此选项。

## 开发运行

```bash
npm install
```

### 桌面本机模式

首次在登录页选择“在本机运行”，之后自动恢复。安装包自带Node 24，不需要系统Node/Mongo/Rabbit。已有远程服务仍用原登录方式；Mac关窗保留后台工作，退出应用才停止本机服务。详见[桌面本机模式](./develop-docs/066-桌面本机模式说明.md)。

### 命令行独立本机（Node.js 24+）

```bash
npm run local:serve
```

启动信息会给出服务地址及用户Token文件路径，默认数据位于.chongming-local。无需MongoDB、RabbitMQ或Docker；模型密钥沿用环境/本机配置，Agent配置可在管理工作台编辑。详见[本机运行、停止及备份说明](./develop-docs/065-本机运行说明.md)。

### 多Host协作

需要RabbitMQ服务。开发环境可使用仓库的 `compose.rabbitmq.yml`，先配置 `RABBITMQ_DEFAULT_USER` 与 `RABBITMQ_DEFAULT_PASS`，再执行 `docker compose -f compose.rabbitmq.yml up -d`；示例仅监听本机5672/15672并使用持久卷。单机示例不提供broker节点高可用，多机环境应按运维要求配置副本与可达地址。

Graph API与Host使用相同 `CHONGMING_AMQP_URL`（amqp/amqps连接串）和 `CHONGMING_QUEUE_NAMESPACE`（默认chongming）。连接串可放环境变量，或通过 `npm run admin -- secret.set --input /absolute/path/to/mq-secret.json` 保存到私有配置；JSON字段为name=`CHONGMING_AMQP_URL`、value=实际连接串。管理员只读接口仅返回是否已配置，Broker凭据不会传入DSH环境。

共享后端需要 Mongo 副本集，可用单节点副本集开发。设置 `CHONGMING_MONGO_URI`，准备 `admin.json`（内容为 `{"displayName":"Owner"}`），初始化：

```bash
npm run admin -- init --input /absolute/path/to/admin.json
npm run graph:serve
```

初始化只返回一次用户 token，并在本机缺失时生成内部 Host token。桌面登录使用用户 token；Host 使用独立内部 token。模型凭证通过本机配置或环境变量提供，详细配置见 [055 接口文档](./develop-docs/055-接口文档.md)。

另开终端启动 Host：

```bash
npm run host:serve -- --host-id host-a --dsh-home /absolute/path/to/host-a
```

再启动桌面客户端，在登录页填写图服务地址（默认 `http://127.0.0.1:4320`）和用户 token：

```bash
npm run dev
```

客户端本身不启动数据库、图服务或 Host。桌面 Main 持有 token，系统安全存储可用时才显示“记住登录”。显式退出登录会清除保存的连接凭证。

Host的旧 `--map-id`、`--poll-ms` 参数已移除。用户处理范围由Run.scope限定，部署/测试工作池通过namespace隔离；实际Rabbit资源名称还附加Mongo持久deploymentId，防止同名不同数据库互相消费。MQ暂时断开时Graph API可继续保存业务与待发布标记，连接恢复后补发，Host和客户端重连；没有MQ不可用时的轮询后备路径。

浏览器开发预览：

```bash
CHONGMING_GRAPH_API=http://127.0.0.1:4320 npm run dev:web
```

打开 Vite 输出的地址，登录页保持该同源地址；`/api/v1` 由固定开发代理转发。代理目标在启动 Vite 时设置，不能通过请求动态指定。浏览器 token 仅保存在内存，刷新后需要重新登录；工作区和图标签偏好保存在后端。

## 命令行客户端

`npm run headless -- --help` 可离线查看命令。设置用户级 `CHONGMING_USER_TOKEN` 和 `CHONGMING_GRAPH_API` 后，使用 `read` 查询、`dispatch` 写入、`watch` 订阅，以及 `upload/download` 传输文件。写入必须提供稳定的 `--request-id`；Ctrl+C 只断开客户端，不取消共享任务。CLI不会连接数据库或启动执行器。详情见 [064 CLI使用说明](./develop-docs/064-CLI使用说明.md)。

## 验证与打包

```bash
npm run test:boundaries
npm run test:faults
npm run test:local  # 不启动Mongo/Rabbit
npm test            # 同时回归协作模式
npm run build:check
npm run test:desktop-runtime
node develop-docs/052-校验契约.mjs
node develop-docs/064-校验入口.mjs
```

`npm test` 会自动启动一个临时RabbitMQ Docker容器，供真实消息集成测试共享，结束时清理。仅有本地Docker引擎或配置好的测试broker才运行这些集成，不静默跳过。也可设置 `CHONGMING_TEST_BROKER_FILE` 指向权限受限、含amqpUrl字段的测试配置文件；每个fixture使用独立随机namespace并清理自己的资源。只跑不涉及MQ的纯单元测试可直接使用Vitest。

`build:check` 包含类型检查、Vite 构建和 Electron 打包。生产桌面 HTML 注入 CSP，Renderer 不直接联网，业务请求经 Main 发送；开发模式保留 HMR。发行签名需另行配置。

本机确定性界面验收环境：

```bash
node --import tsx tests/client/ui-fixture.ts
```

该脚本启动临时 Mongo、真实 API/Host/DSH 及本机测试模型，输出端口和临时凭证文件路径；将端口设置为浏览器开发代理目标即可验收。按 Ctrl+C 清理。测试结果不代表正式模型的核查质量。

## 数据与文档

058 及之前的单 operation Run 需在升级时显式迁移。先停止 Host 并等待其租约过期，运行 `npm run admin -- data.migrate-node-runs` 查看统计；确认后用内容为 `{"apply":true}` 的本地 JSON，通过 `--input /absolute/path/to/migration.json` 执行。迁移保留图、原 Run/Review/报告/收据身份，未结束的旧 Run 以暂停状态保留；新客户端中继续。命令默认不写入，已有新结构不重复迁移；有有效租约或不支持的数据结构时明确拒绝。

现有工作区配置不会自动覆盖。首次初始化包含新的 parse/split 默认配置；已有工作区的 Owner 可进入「管理工作台 → 智能体配置」，编辑解析、拆分路由/汇总并新增拆分 Agent，或预览后从共享库复制。旧占位提示词应按实际需求更新；缺少所需角色时返回配置错误。修改配置只影响以后启动的 Run。

「资产与导入导出」支持 64 MiB 以内文件上传、下载、添加为 Source、资产删除，以及图/工作区 v3 包导出与导入新工作区。上传或导入遇到不确定结果时，用“重试同一操作”保留原身份；来源创建冲突不要求重新上传。Viewer 可下载资产并导出当前图，整个工作区导出和导入需 Owner；导入不携带可执行 Run。文件实际解析仍遵守上方的 1 MiB/文本媒体限制。

成员添加使用管理员提供的已注册用户 ID，系统不会自动创建账户或发送邀请。共享库和全局设置由 HostAdmin 修改；工具声明不安装 Host 插件，模型密钥仍在 Host 本机配置，Renderer 不取得密钥或任意文件路径权限。

055 及之前的新图若有 News 空 `context` 被存储省略，可用本机 `data.repair-news-context` 显式修复；默认只统计，`apply:true` 才写入。命令与操作范围见 [056 接口文档](./develop-docs/056-接口文档.md)。应用启动不会自动迁移用户数据，旧 Mapper 集合也不在修复范围。

- [图服务技术说明书（058 基线）](./technical-docs/chongming-graph/README.md)
- [061 消息队列与实时同步协议](./develop-docs/061-接口文档.md)
- [061 实施与验收](./develop-docs/061-implement-消息队列与实时同步.md)
- [062 阶段树状画布恢复](./develop-docs/062-implement-阶段树状画布恢复.md)
- [067 模块边界拆分](./develop-docs/067-implement-模块边界与运行入口拆分.md)
- [068 异常处理与故障恢复设计](./develop-docs/068-异常处理与故障恢复体系.md)
- [068 实施与验收](./develop-docs/068-implement-异常处理与故障恢复体系.md)
- [066 桌面本机模式](./develop-docs/066-桌面本机模式说明.md)
- [066 实施与验收](./develop-docs/066-implement-Electron本机服务托管.md)
- [065 独立本机运行](./develop-docs/065-本机运行说明.md)
- [065 实施与验收](./develop-docs/065-implement-独立本机轻量模式.md)
- [064 旧路径收敛与验收](./develop-docs/064-implement-旧运行路径收敛.md)
- [063 执行活动接口](./develop-docs/063-接口文档.md)
- [063 实施与验收](./develop-docs/063-implement-执行活动投影.md)
- [060 管理与文件通道](./develop-docs/060-接口文档.md)
- [060 实施与验收](./develop-docs/060-implement-管理工作台与文件流转.md)
- [059 节点级执行与暂停接口](./develop-docs/059-接口文档.md)
- [059 设计](./develop-docs/059-节点驱动协作闭环与暂停恢复.md)
- [059 实施与验收](./develop-docs/059-implement-节点驱动协作闭环与暂停恢复.md)
- [056 客户端架构](./develop-docs/056-客户端核查闭环.md)
- [056 客户端接口与连接协议](./develop-docs/056-接口文档.md)
- [056 实施及验收记录](./develop-docs/056-implement-客户端核查闭环.md)
- [055 完整业务 HTTP 接口、权限和管理员命令](./develop-docs/055-接口文档.md)

本机配置默认位于 `.chongming-host`，可由 `CHONGMING_CONFIG_DIR` 修改，环境变量优先。配置/凭据文件权限为 0600，已排除版本控制。切库须先停止图服务和 Host，设置下次启动配置后再重启。
