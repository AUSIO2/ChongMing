# 重明 ChongMing

围绕可注册数据类型和 Agent 转换构建可追溯数据图的桌面应用；仓库自带事实核查定义包。

模块职责、依赖方向与部署入口见 [架构说明](./ARCHITECTURE.md)；稳定主题文档从 [现行文档导航](./docs/README.md) 开始。

开发与审阅统一遵循 [开发规范](./coding.md)：模块、命名、排版、类型、中文用途注释、异步状态、错误和测试要求均在此维护。

源码先按用途查找：`backend/modules` 是图、工作区、身份和资产规则；`backend/adapters` 是HTTP/存储/消息实现；`backend/execution` 是Host与DSH；`apps` 是各运行入口和界面。后端导航见 [backend/README.md](./backend/README.md)，运行端导航见 [apps/README.md](./apps/README.md)。

系统已接入统一错误编号、未知错误脱敏、Node进程终端边界、受控关闭时限、HTTP/SSE/IPC诊断、Host永久错误分类，以及Electron/Vue的加载和渲染恢复入口。故障专项使用 `npm run test:faults`；桌面诊断默认不上传。日志位置、脱敏边界和尚未验收范围见 [故障处理与诊断](./docs/operations/fault-handling.md)。

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

本地用户无需领取编辑权、领取 Run 控制权或续租：编辑/启动携带分支内容版本，暂停、继续、取消、审核直接指定 Run。服务端保留版本冲突检查和活跃 Run 范围保护。`app.bootstrap.metadata.clientLeases` 返回 `none`（本机）或 `required`（协作）；以下客户端租约说明适用于协作模式。内部 Agent Work 的授权由 Host 自动维护。

077 已落地通用数据与 Agent 级执行主链：节点使用 `id/revision/typeId/typeVersion/payload`，工作区发布不可变数据类型和转换定义，Run 保存有限 `plan` 与冻结 `ExecutionSpec`。一个转换可产生多个按阶段和槽位区分的 Agent Work；同一 Host 的可配置执行槽与多个 Host 使用相同领取、续租、围栏和幂等提交协议。默认事实核查包提供来源解析、事实拆分、并行核查与汇总，但核心图、DSH 合同和 UI 不再按这些业务名称分支。关闭图或退出客户端不停止后端 Run。

083 已记录移除独立 Evidence 的方案和清理补丁；默认定义文件反复恢复的问题按用户要求暂缓处理。证据库使用工作区实际注册的 Claim，库引用由通用节点元信息承载。本轮保留版本号、暂不发布新版，不改写已有工作区的定义与存量数据。

Mongo 服务已提供 workspace 证据库的显式收录、读取、分页检索、撤回及固定关系查询。条目保存 Claim 的固定快照，判断仅为数字 0（完全错误）或 1（完全正确）；撤回后仍可按原身份读取历史内容。界面在侧栏与 Map 并列，共用图浏览和单页阅读，从 Map 的 Claim 可显式收录。新收录冻结真实出处、核查上下游与显式依据；选中后可查看连线和原版本正文，来源删除后仍可读取。旧条目没保存关系时明确提示。092 增加运行表单显式选材，按步骤冻结跨 Map 库材料，核查产物只能引用已获权集合；详情可查看当前/历史使用及原消费者正文。撤回阻止新选择，既有冻结核查仍可完成。详情见 [089 核心](./develop-docs/089-Mongo证据库核心收录闭环.md)、[090 界面](./develop-docs/090-Map式证据库界面.md)、[091 出处与上下游](./develop-docs/091-证据库出处与上下游.md) 和 [092 跨 Map 引用](./develop-docs/092-跨Map库引用与使用追溯.md)。匹配、替代、证据集、导入导出及本机 SQLite 库适配继续按 [084 计划](./develop-docs/084-workspace证据库实现计划.md) 推进；当前v4导出会明确拒绝非空库引用，避免生成无法恢复引用的包。

人工编辑使用分支内容版本和独占编辑租约。客户端以 `branch.get(mapId, rootIds)` 取得服务端计算的实际 successor 闭包及不透明版本，再以 `branch.claim` 领取该实际范围；父子分支、共享后继或多根范围发生交集时只有一个客户端能取得编辑权，互不相交的分支可以并行。`graph.apply` 同时携带 `GraphBranchProof { rootIds, expectedVersion }` 与 `GraphBranchLeaseProof { leaseId, holderId, fence }`，最终存储条件会检查内容版本、所有权代次和过期时间。版本同时覆盖结构边和类型声明中的 payload 节点引用；reference 不扩展闭包，但会影响两端版本。分支读取还返回根节点 revision 与 mapRevision，供客户端确认它和当前展示快照属于同一时点；并发裁决只比较不透明的 branch version。

租约状态使用独立 `ownershipRevision`，领取、续租和释放不增加内容 revision；SSE 即使在内容 revision 不变时也会推送新的完整占有基线。每个窗口使用独立 holder 并按租期续租，未持有编辑权时界面只读。`run.start` 会验证并消费编辑租约，把范围转换为不随浏览器断线过期的 Run 占有；Work 读取、领取、提案和失败处理继续核对该占有，Run 终态释放范围。创建完全独立的新根仍可用 `expectedVersion: null`，不需要先领取不存在的分支。

图快照和持久记录使用 `runs[]`。不相交分支可以在同一张图上同时启动 Run；每个 Run 独立保存 branchState、范围占有、控制租约、Operation 和 Work。重叠范围仍由实际 successor 闭包拒绝。启动者原子取得该 Run 的控制权，暂停、继续、取消和审核校验 owner、holder、fence 与存储时间；暂停只撤销所属 Run 的 Work 租约，其他 Run 继续执行。界面可以选择具体 Run 查看、领取控制和审核。整图 `revision` 只承担内部 CAS 和快照排序，服务层在无关分支、其他 Run 或租约续租抢先提交后会从最新图重新验证并重放业务动作。

默认桌面入口为 `apps/desktop/main.ts` 和 `apps/ui/views/WorkspacePage.vue`，不加载旧 Mapper、数据库或 AgentLoop。支持运行暂停/继续：暂停持久化并撤销执行租约，恢复保留已保存产物和审核，未完成工作使用新 DSH 会话重跑。「管理工作台」已接入成员、七类 Agent 配置与共享库复制、非秘密模型/工具设置、资产上传下载和数据包导入导出。RabbitMQ分发工作通知，Host不再空闲扫图；客户端通过认证SSE接收完整快照与管理刷新，保留初始读取/手动刷新，无定时图快照轮询。界面按子树展开来源、解析、新闻、事实、核查意见与结论，并显示DSH模型/工具活动摘要。CLI使用同一认证API；独立本机入口使用SQLite与进程内通知；桌面包含Node 24和服务资源，支持本机一键连接、记住模式及退出排空。

Source 支持共享文本资产和公开 HTTP(S) URL，媒体限 UTF-8 text/plain、text/markdown、text/html、application/json，最多 1 MiB。URL 不携带凭证、不跟随重定向，解析并固定公开目标地址，拒绝 Host 本机及私网；首次成功读取的正文随 operation 保存。开发验收 fixture 明确允许自己的本机测试来源，生产入口不开放此选项。

## 开发运行

```bash
npm install
```

### 桌面本机模式

首次在登录页选择“在本机运行”，之后自动恢复。安装包自带Node 24，不需要系统Node/Mongo/Rabbit。远程服务支持用户名账户、邮箱账户及“使用访问令牌”高级入口；Mac关窗保留后台工作，退出应用才停止本机服务。详见[桌面本机模式](./develop-docs/066-桌面本机模式说明.md)。

### 命令行独立本机（Node.js 24+）

```bash
npm run local:serve
```

启动信息会给出服务地址及用户Token文件路径，默认数据位于.chongming-local。无需MongoDB、RabbitMQ或Docker。模型与API Key在管理工作台按工作区/Agent配置，服务器环境和本机旧模型密钥不再兜底。详见[本机运行、停止及备份说明](./develop-docs/065-本机运行说明.md)。

### 多Host协作

需要RabbitMQ服务。开发环境可使用仓库的 `compose.rabbitmq.yml`，先配置 `RABBITMQ_DEFAULT_USER` 与 `RABBITMQ_DEFAULT_PASS`，再执行 `docker compose -f compose.rabbitmq.yml up -d`；示例仅监听本机5672/15672并使用持久卷。单机示例不提供broker节点高可用，多机环境应按运维要求配置副本与可达地址。

Graph API与Host使用相同 `CHONGMING_AMQP_URL`（amqp/amqps连接串）和 `CHONGMING_QUEUE_NAMESPACE`（默认chongming）。连接串可放环境变量，或通过 `npm run admin -- secret.set --input /absolute/path/to/mq-secret.json` 保存到私有配置；JSON字段为name=`CHONGMING_AMQP_URL`、value=实际连接串。管理员只读接口仅返回是否已配置，Broker凭据不会传入DSH环境。

共享后端需要 Mongo 副本集，可用单节点副本集开发。设置 `CHONGMING_MONGO_URI`，准备 `admin.json`（内容为 `{"displayName":"Owner"}`），初始化：

```bash
npm run admin -- init --input /absolute/path/to/admin.json
npm run graph:serve
```

初始化只返回一次用户 token，并在本机缺失时生成内部 Host token。管理员可在“使用访问令牌”入口继续使用用户 token；Host 使用独立内部 token。模型凭证由工作区或Agent提供，不再使用Host环境或旧secret.set模型配置兜底。

### 模型调用配置

工作区所有者打开“管理工作台 → 工作区与成员 → 工作区模型调用”，填写提供方、模型ID、API地址和自己的API Key。Agent页的“智能体模型调用”可覆盖这些字段；留空继承工作区。同提供方可只更改模型，更换提供方或地址需要匹配的Key。初版支持DeepSeek与OpenAI官方HTTPS API，独立本机还支持loopback模型服务。

Key保存后不回显，空输入保持原Key，移除或恢复继承使用明确按钮。编辑者和只读成员只能查看配置状态。未配置可用Key时不能启动模型任务；新工作区、复制共享库和导入数据都不会顺带复制Key。

提示词/工具仍按发布定义固定；新Run单独冻结实际模型和地址，改变调用配置不需要重新发布转换。Key只经当前Work授权交付执行器，服务器没有模型Key兜底。明文Key不进入公开图、运行、提示词、导出包或浏览器本地存储。

服务端以独立AES-GCM主密钥加密保存工作区Key。部署时备份 `CHONGMING_CONFIG_DIR/model-encryption.key` 与数据库；本机主密钥在数据目录的 `config/model-encryption.key`。丢失主密钥后需要重新输入工作区Key，程序不会自动覆盖损坏的旧主密钥。详见[110模型调用配置](./develop-docs/110-工作区与智能体模型调用配置.md)。

DeepSeek工作中的`web_search`使用独立`/v1/tools/search`接口，沿用该Work按Agent→工作区解析的Key，返回来源链接、标题和摘要；工具的超时、取消和结果数量限制复用DSH。详见[112搜索适配器](./develop-docs/112-DeepSeek独立搜索适配器.md)。

另开终端启动 Host：

```bash
npm run host:serve -- --host-id host-a --dsh-home /absolute/path/to/host-a
```

每个 Host 的容量默认为 1，可用 `--concurrency 1..64` 或 `CHONGMING_HOST_CONCURRENCY` 设置；本机服务也接受同一参数。容量表示同时执行的 Agent Work 数量，不是固定 Agent 数量。

再启动桌面客户端，在登录页填写图服务地址（默认 `http://127.0.0.1:4320`），使用用户名账户、选择邮箱登录，或展开“使用访问令牌”填写已有用户 token：

```bash
npm run dev
```

远程连接由已有图服务与Host处理。桌面Main只在可信系统安全存储可用时提供账户“记住登录”，仅加密保存刷新凭据；访问令牌不落盘。旧v1凭据升级后只保留服务地址，旧令牌仍可在高级入口手动输入；手工令牌仅本次会话使用。显式退出账户会撤销服务端会话并清除本机凭据。

### 用户名账户

登录页默认支持用户名和密码，“创建账户”无需邮箱或验证码，注册后直接登录并创建该账户的默认私有工作区。用户名为3至32位英文字母、数字、下划线或短横线，忽略大小写；显示名称可使用中文。密码使用Argon2id，长度15至128字符。新账户没有站点管理员权限，不合并已有用户数据。

此方式不需要SMTP或验证码密钥。用户名账户暂不支持邮件找回密码；请妥善保存密码，登录后可在账户设置中修改。会话刷新、退出和桌面安全记住登录沿用现有账户能力。详见[108用户名账户注册](./develop-docs/108-用户名账户注册.md)。

### 邮箱账户

账户页支持注册、邮箱验证、登录、找回/重置密码，登录后的“账户设置”可修改密码。密码使用Argon2id，长度15至128字符；验证码10分钟有效，连续失败5次后该验证码失效，需要重新发送。首次验证会创建该账户的私有工作区，不合并或改权已有用户的数据。

需要发送验证/重置邮件的Graph API（或显式启用邮件的`local:serve`）须配置以下服务端环境变量：

| 环境变量 | 含义 |
| --- | --- |
| `CHONGMING_SMTP_HOST` | SMTP主机 |
| `CHONGMING_SMTP_PORT` | 默认465；使用587时采用STARTTLS |
| `CHONGMING_SMTP_SECURE` | 465默认`true`，其它端口默认`false`并要求TLS升级 |
| `CHONGMING_SMTP_USER` / `CHONGMING_SMTP_PASSWORD` | SMTP认证信息 |
| `CHONGMING_MAIL_FROM` | 发件邮箱 |
| `CHONGMING_AUTH_CHALLENGE_SECRET` | 至少32字符的随机验证码密钥；同一服务集群/重启保持一致 |

未配置SMTP时，用户名账户和本机/令牌连接继续可用，邮箱注册、验证及密码找回等邮件流程明确返回`ACCOUNT_MAIL_UNAVAILABLE`；不会把验证码写进日志作为发信替代。部分邮件配置会在启动前拒绝。测试仅使用环境独占的内存收件箱，未验收真实SMTP投递。详细实现与验证见[106账户登录集成](./develop-docs/106-账户登录集成.md)。

Host的旧 `--map-id`、`--poll-ms` 参数已移除。用户处理范围由Run.scope限定，部署/测试工作池通过namespace隔离；实际Rabbit资源名称还附加Mongo持久deploymentId，防止同名不同数据库互相消费。MQ暂时断开时Graph API可继续保存业务与待发布标记，连接恢复后补发，Host和客户端重连；没有MQ不可用时的轮询后备路径。

浏览器开发预览：

```bash
CHONGMING_GRAPH_API=http://127.0.0.1:4320 npm run dev:web
```

打开 Vite 输出的地址，登录页保持该同源地址；`/api/v1` 由固定开发代理转发。代理目标在启动 Vite 时设置，不能通过请求动态指定。浏览器账户凭据和手工token仅保存在内存，刷新页面后需要重新登录；工作区和图标签偏好保存在后端。

## 命令行客户端

`npm run headless -- --help` 可离线查看命令。设置用户级 `CHONGMING_USER_TOKEN` 和 `CHONGMING_GRAPH_API` 后，使用 `read` 查询、`dispatch` 写入、`watch` 订阅，以及 `upload/download` 传输文件。写入必须提供稳定的 `--request-id`；Ctrl+C 只断开客户端，不取消共享任务。CLI不会连接数据库或启动执行器。按目标操作的完整示例见 [CLI 使用手册（19 个 UC）](./develop-docs/077-CLI使用手册.md)，包含分支租约、多 Run、运行控制与审核、资产和导入导出。

## 验证与打包

```bash
npm run test:boundaries
npm run test:faults
npm run test:local  # 不启动Mongo/Rabbit
npm test            # 同时回归协作模式
npm run build:check
npm run test:desktop-runtime
node develop-docs/064-校验入口.mjs
node develop-docs/077-校验数据定义.mjs
```

`npm test` 会自动启动一个临时RabbitMQ Docker容器，供真实消息集成测试共享，结束时清理。仅有本地Docker引擎或配置好的测试broker才运行这些集成，不静默跳过。也可设置 `CHONGMING_TEST_BROKER_FILE` 指向权限受限、含amqpUrl字段的测试配置文件；每个fixture使用独立随机namespace并清理自己的资源。只跑不涉及MQ的纯单元测试可直接使用Vitest。

`build:check` 包含类型检查、Vite 构建和 Electron 打包。生产桌面 HTML 注入 CSP，Renderer 不直接联网，业务请求经 Main 发送；开发模式保留 HMR。发行签名需另行配置。

本机确定性界面验收环境：

```bash
node --import tsx tests/client/ui-fixture.ts
```

该脚本启动临时 Mongo、真实 API/Host/DSH 及本机测试模型，输出端口和临时凭证文件路径；将端口设置为浏览器开发代理目标即可验收。按 Ctrl+C 清理。测试结果不代表正式模型的核查质量。

## 仓颉证据图检查与报告导出

新增独立命令行模块，用仓颉检查图结构与核查引用并生成中文报告；不调用模型或修改图数据。支持本地快照及公共API的只读`map.get`，当前构建验证平台为macOS arm64。安装、命令及检查边界见[模块说明](./apps/evidence-audit-cj/README.md)。

```bash
npm run evidence:audit -- --input apps/evidence-audit-cj/examples/completed.json
npm run test:evidence-audit
```

第二条为需要先构建真实仓颉程序的专用验收入口；普通Node回归不要求安装仓颉SDK。

## 数据与文档

旧固定 `data.kind` 图以及此前使用单个 `run` 字段的通用图必须显式迁移。迁移不在正常启动时执行；单 Run 文档会转换为 `runs[]`，并保留执行身份、历史和可验证授权。停机、备份、Mongo/SQLite 预览差异、阻断条件和应用命令见 [显式数据迁移与修复](./docs/operations/data-migrations.md)。

现有工作区配置不会自动覆盖。首次初始化包含新的 parse/split 默认配置；已有工作区的 Owner 可进入「管理工作台 → 智能体配置」，编辑解析、拆分路由/汇总并新增拆分 Agent，或预览后从共享库复制。旧占位提示词应按实际需求更新；缺少所需角色时返回配置错误。修改配置只影响以后启动的 Run。

「资产与导入导出」支持 64 MiB 以内文件上传、下载、按注册资产引用类型添加数据、资产删除，以及图/工作区 v4 包导出与导入新工作区。v4 包携带精确类型包、依赖闭包、Agent 快照与摘要，不携带可执行 Run、租约或凭据；v3 包不再支持导入。上传或导入遇到不确定结果时，用“重试同一操作”保留原身份。Viewer 可下载资产并导出当前图，整个工作区导出和导入需 Owner；文件实际解析仍遵守上方的 1 MiB/文本媒体限制。

成员添加使用管理员提供的已注册用户 ID，系统不会自动创建账户或发送邀请。共享库和全局设置由 HostAdmin 修改；工具声明不安装 Host 插件。模型Key由工作区/Agent所有者配置，只写入并显示状态；Renderer不获得已保存的明文Key或任意文件路径权限。旧无Work授权的 `dsh:serve` 诊断入口不再从环境取得模型Key，模型验证应从工作区发起。

早期 Mongo 图若有 News 空 `context` 被存储省略，可用 `data.repair-news-context` 显式修复；默认只统计，`apply:true` 才写入。应用启动不会自动迁移用户数据，旧 Mapper 集合也不在修复范围；命令和精确作用范围见 [数据维护文档](./docs/operations/data-migrations.md#早期-news-context-修复)。

- [当前架构与运行入口](./ARCHITECTURE.md)
- [现行文档导航](./docs/README.md)
- [业务不变式](./docs/architecture/behavioral-invariants.md)
- [故障处理与诊断](./docs/operations/fault-handling.md)
- [显式数据迁移与修复](./docs/operations/data-migrations.md)
- [新闻排序实验（独立私有仓库）](https://github.com/AUSIO2/ChongMing-News-Experiments)
- [077 分支编辑保护与 Agent 级分布式执行](./develop-docs/077-分支独占与分布式协作.md)
- [077 数据定义协议](./develop-docs/077-数据定义协议.md)
- [077 CLI 使用手册](./develop-docs/077-CLI使用手册.md)
- [066 桌面本机模式](./develop-docs/066-桌面本机模式说明.md)
- [065 独立本机运行](./develop-docs/065-本机运行说明.md)
- [workspace 证据库实现计划](./develop-docs/084-workspace证据库实现计划.md)

本机配置默认位于 `.chongming-host`，可由 `CHONGMING_CONFIG_DIR` 修改，环境变量优先。配置/凭据文件权限为 0600，已排除版本控制。切库须先停止图服务和 Host，设置下次启动配置后再重启。
