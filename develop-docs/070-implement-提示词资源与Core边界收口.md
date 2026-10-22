# 070 — 提示词资源与 Core 边界收口实施原稿

1. 将共享默认提示词机械迁移到 `resources/prompts`，将管理端专用提示词迁移到服务器资源目录。
2. 新建装配层默认配置模块，删除Core对JSON及默认常量的依赖。
3. 让Application和Control显式接收默认种子配置，更新所有直接构造调用方。
4. 更新编码规范、架构文档和边界检查，禁止提示词资源再次进入Core。
5. 运行种子、配置、本机、协作、类型、全量测试及构建检查并记录结果。

## 实施结果

- 12个共享默认Agent/提示词JSON已迁移到`resources/prompts/`；管理员端点探测提示词迁移到`apps/server/resources/endpoint.json`。
- `apps/config/default-prompts.ts`在构建期组装完整`GraphSeedConfiguration`。本机与协作应用工厂把它注入`applicationBuildService`，再由后者注入`controlCreateService`。
- `backend/core/configuration.ts`只保留配置解析与完整种子配置校验；`backend/core/control.ts`不再导入任何JSON。自定义配置仍可覆盖验证配置，缺少parse/split时使用注入的默认部分。
- 所有直接构造Control的测试已显式传入默认配置；`backend/core`现有18个TypeScript文件和4个端口文件，不含JSON或prompts目录。
- `scripts/check-architecture.mjs`新增Core提示词目录和JSON禁入断言；`coding.md`与`ARCHITECTURE.md`同步为资源注入规则。

## 验证

- 种子、资产、节点Run、Mongo副本集、SQLite与无头入口专项：7个文件、42个测试通过。
- `npm test`：38个测试文件、257个测试通过。
- `npm run build:check`：类型、架构、消息检查、Vite及macOS arm64 DMG构建通过；本机没有有效Developer ID，产物未签名。
- `npm run test:desktop-runtime`：随包Node 24、SQLite、DSH、重启和父进程断开检查通过。
- `git diff --check`通过。
