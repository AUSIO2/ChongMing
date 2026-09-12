# 056 — 客户端核查闭环实施原稿

1. 定义客户端query/command返回映射和连接/桥接类型，完成标准Fetch client及Electron安全凭证边界。
2. 新建客户端store，集中连接、Workspace/Map/偏好、轮询、命令幂等与迟到响应隔离。
3. 复用AppShell/样式，接登录、工作区/图创建选择、图标签、Claim/News编辑与来源关联。
4. 新GraphCanvas和Review组件使用真实Graph合同，完成动态角度审核、进度、结果审核和历史意见显示。
5. 切新路由与纯客户端Electron入口，保留旧源码但断开新入口到旧Mapper/DB依赖。
6. 用真实后端fixture跑界面闭环、取消订阅/错误/权限回归和视觉核对；不使用用户真实凭据或调用付费模型。
7. 更新运行文档，完成类型/测试/构建检查，仅提交本阶段文件并按既定规范push。

界面验收发现Mongoose的默认minimize会删除News.context={}，导致已发布DTO缺少必填字段。修复schema保留空对象，并增加显式本机data.repair-news-context工具：默认只统计，apply=true才补齐新图集合中缺失的News.context，保留Node版本/内容、提高Map版本通知客户端。不得在UI加运行时fallback掩盖存量问题，也不默认修改用户数据库。

## 实施结果

- 新默认入口为 ClientHome → client store → typed gateway → Graph API；Electron Main 只持有连接与加密凭证，旧 Mapper/数据库/AgentLoop 不在启动依赖中。
- 完成 Workspace/Map 创建与选择、个人图标签恢复、News/Claim 编辑和多来源关联、动态路由编辑、两轮 Review、真实进度与逐角度意见。旧后端源码按约定保留，后续功能不走旧接口回退。
- 会话代次与 Map 版本隔离迟到响应；重试冻结原始参数并复用 requestId，切换工作区后清除旧重试。草稿保留原版本，冲突交由用户明确处理。
- 修复 News.context 空对象丢失的存储根因；新增本机显式修复命令以及客户端网络边界 DTO 校验。未运行任何用户数据库修复。
- 函数命名按模块前缀校正；测试模型 persona 放入 tests/client/fixtures 的独立 JSON，未增加依赖。

## 验收记录（2026-09-12）

使用隔离 Mongo 副本集、真实鉴权 HTTP 服务和官方 DSH Host，模型与工具响应由本机确定性 fixture 提供；未使用用户真实令牌或外部付费模型。

浏览器实际操作通过：登录 → 新建工作区/图 → 新建两篇新闻（含空 context 和自定义字段）→ 新建 Claim → 保存两条来源边 → 启动人工审核 → 路由由 3 个角度改为 2 个并保存 → 批准 → 关闭/重开图 → 收到对应 2 份意见 → 批准结果 → 4 个节点/3 条边持久化。两份已保存意见可展开查看依据和工具范围。刷新清除浏览器内存令牌；重新登录恢复工作区、图标签、选择和已保存结论。修复后的流程没有新增浏览器 error/warn。

在 1280×720 核对主布局，并按桌面最小尺寸 960×640 核对画布适应、节点选择和右栏滚动；完成后恢复默认视口。

- 全量 npm test：43 个测试文件、162 个测试通过。
- npm run build:check：类型检查、Vue/Vite 和 Electron 打包通过。
- 规范校正后针对会话、布局和真实客户端集成补验：17/17 通过；客户端与 IPC/凭证补验：16/16 通过。
- 契约文档校验与 git diff --check 通过。
- 最终 Electron 实际启动通过：隔离 userData，登录 UI、preload 六方法和真实 IPC 正常；无旧 electronAPI/Node 暴露；外跳和新窗口被阻止。生产 CSP 注入后无控制台告警或资源拒绝，未连接时远程请求为 0。验收进程与临时目录均已清理。

当前仍采用快照轮询；parse/split 执行、完整 Agent/成员/资产管理界面及产品 SSE 留待下一阶段。打包为本地开发验收产物，未做发行签名或发布。
