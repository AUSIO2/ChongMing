# 重明 ChongMing

围绕事实、来源和核查结论构建数据图的桌面应用。

## 当前架构

```text
Vue 客户端 → Electron Main / typed Fetch → Graph API → 共享 Mongo
                                             ↑
                                      多个 Host → DSH
```

Graph API 保存用户、工作区、数据节点、关系、Run 和 Review。多个 Host 领取不同工作，交给 DSH 执行；前端只提交业务命令、读取状态，不负责智能体调度。各 Host 使用独立 DSH 目录，共享图服务和数据库。

056 已接通：用户登录 → 工作区/图 → News/Claim 编辑与多来源关联 → 动态选择核查角度 → 路由审核 → 收集意见 → 结果审核 → 结论入图。自定义 Agent 和工具范围来自后端冻结的工作区配置，路由可由用户调整后批准。关闭图或退出客户端不取消后端 Run。

默认桌面入口已切换到 `electron/client-main.ts` 和 `src/views/ClientHome.vue`，不加载旧 Mapper、数据库或 AgentLoop。旧源码暂时保留；parse/split 执行、完整成员/Agent/资产管理界面以及产品 SSE 在后续接线。目前客户端采用快照轮询。

## 开发运行

```bash
npm install
```

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

浏览器开发预览：

```bash
CHONGMING_GRAPH_API=http://127.0.0.1:4320 npm run dev:web
```

打开 Vite 输出的地址，登录页保持该同源地址；`/api/v1` 由固定开发代理转发。代理目标在启动 Vite 时设置，不能通过请求动态指定。浏览器 token 仅保存在内存，刷新后需要重新登录；工作区和图标签偏好保存在后端。

## 验证与打包

```bash
npm test
npm run build:check
node develop-docs/052-校验契约.mjs
```

`build:check` 包含类型检查、Vite 构建和 Electron 打包。生产桌面 HTML 注入 CSP，Renderer 不直接联网，业务请求经 Main 发送；开发模式保留 HMR。发行签名需另行配置。

本机确定性界面验收环境：

```bash
node --import tsx tests/client/ui-fixture.ts
```

该脚本启动临时 Mongo、真实 API/Host/DSH 及本机测试模型，输出端口和临时凭证文件路径；将端口设置为浏览器开发代理目标即可验收。按 Ctrl+C 清理。测试结果不代表正式模型的核查质量。

## 数据与文档

055 及之前的新图若有 News 空 `context` 被存储省略，可用本机 `data.repair-news-context` 显式修复；默认只统计，`apply:true` 才写入。命令与操作范围见 [056 接口文档](./develop-docs/056-接口文档.md)。应用启动不会自动迁移用户数据，旧 Mapper 集合也不在修复范围。

- [056 客户端架构](./develop-docs/056-客户端核查闭环.md)
- [056 客户端接口与连接协议](./develop-docs/056-接口文档.md)
- [056 实施及验收记录](./develop-docs/056-implement-客户端核查闭环.md)
- [055 完整业务 HTTP 接口、权限和管理员命令](./develop-docs/055-接口文档.md)

本机配置默认位于 `.chongming-host`，可由 `CHONGMING_CONFIG_DIR` 修改，环境变量优先。配置/凭据文件权限为 0600，已排除版本控制。切库须先停止图服务和 Host，设置下次启动配置后再重启。
