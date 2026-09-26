# 070 — 提示词资源与 Core 边界收口

## 目标

从 `backend/core` 移除默认提示词资源及其加载逻辑。Core只负责配置校验、种子写入和领域规则；应用装配层加载可变默认资源并显式注入。

## 设计

- 共享默认Agent配置移到 `resources/prompts/`，由 `apps/config/default-prompts.ts` 组装为完整的 `GraphRunConfiguration`。
- 管理端端点探测提示词移到 `apps/server/resources/endpoint.json`，只由管理员CLI加载。
- `controlCreateService` 必须接收完整默认配置；`seed(custom)`校验自定义配置，自定义配置缺少parse/split时从注入的默认配置补齐。
- `applicationBuildService` 将默认配置作为必需装配参数向Control传递；本机和协作应用工厂统一注入同一资源配置。
- Worker仍只读取已持久化、已冻结到工作数据中的Agent内容，不直接加载资源文件。
- 架构检查禁止 `backend/core` 下出现 `prompts` 目录或JSON资源，并继续限制Core只依赖Core、Contracts和Node标准库。

## 行为边界

- 现有默认提示词文本、Agent身份、工具、模型、promptPath和初始化行为不变。
- 不增加运行时文件搜索、环境路径或缺失时兜底；资源由TypeScript构建静态导入，缺失直接构建失败。
- 测试若直接构造Control，必须显式提供测试配置或共享默认资源，避免隐藏的Core全局默认。

## 验收

- `backend/core` 不包含提示词JSON或默认资源导入。
- 本机首次启动、协作管理员 `init/agents.seed` 与自定义配置种子行为通过回归。
- 架构、类型、消息检查、全量测试、桌面运行时与构建通过。
