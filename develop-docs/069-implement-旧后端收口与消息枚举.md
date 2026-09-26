# 069 — 旧后端收口与消息枚举实施原稿

1. 审计当前入口闭包、依赖、物理目录、Git迁移状态和旧数据边界，记录准确结论。
2. 建立RuntimeMessage枚举与动态模板格式化函数，机械迁移全部TypeScript运行时错误message。
3. DSH `.mjs`插件使用冻结消息表，保持Node直接加载边界。
4. 新增AST防回归检查和故意负例，接入边界/构建检查。
5. 跑消息行为专项、全量回归、类型、打包运行时和构建；更新实施记录。

## 实施结果

- 旧根目录 `electron/`、`server/`、`src/` 及其空目录均已删除；`backend/` 根层旧入口文件已删除，运行代码只保留067后的分层目录。入口依赖检查未发现旧Mapper、AgentLoop、LangGraph、LangChain或LangSmith，直接依赖也为空。
- `contracts/messages.ts`当前集中480条TypeScript运行时异常、失败响应和错误状态文案；动态字段由`messageFormat`填充。正常UI标题/按钮、提示词、协议code和结构化日志事件名保持各自语义，不混入错误枚举。
- DSH业务插件由Node直接加载`.mjs`，因此在插件内使用17条冻结`RuntimeMessage`表；异常、能力守卫及远端错误格式均引用该表。
- `scripts/check-runtime-messages.mjs`扫描79个运行文件，禁止异常构造器、错误助手、`message`/`error`错误字段和message局部变量重新出现硬编码文案，并校验共享枚举值唯一。负例测试确认违规会失败。
- `docs/design-overview.md`和052技术说明入口已明确标为历史基线，避免仍把退役的LangGraph/LangChain方案写成当前架构。历史分析、开发记录与恢复归档继续保留，不参与构建。
- 未删除任何Mongo集合、SQLite文件或用户数据。旧代码清理已完成；数据销毁不属于本阶段。

## 验证

- `npm test`：38个测试文件、257个测试通过。
- `npm run build:check`：类型、边界、消息检查、Vite构建和macOS arm64 DMG打包通过；本机没有有效Developer ID，所以产物未签名。
- `npm run test:desktop-runtime`：随包Node 24、SQLite、DSH、重启与父进程断开检查通过。
- `git diff --check`通过。
