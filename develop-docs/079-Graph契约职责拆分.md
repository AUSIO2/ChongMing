# 079 — Graph 契约职责拆分

日期：2026-09-30。

## 目的与范围

将 `contracts/graph.ts` 按使用者关心的协议职责拆分，让读取图数据、协调分支、执行 Run/Work 和调用 API 的读者能直接定位定义。遵循 coding.md FILE-1，调用方直接导入定义文件，不增加重导出入口。

| 文件 | 定义范围 |
|---|---|
| `contracts/graph.ts` | payload、节点、边和图变更输入 |
| `contracts/graph-agent.ts` | 已解析 Agent 配置与旧工作区运行配置 |
| `contracts/graph-branch.ts` | 分支范围、内容版本证明、编辑占有和 Run 控制租约 |
| `contracts/graph-run.ts` | 有限运行计划、Operation、阶段候选与接受结果、审核和 Run 状态 |
| `contracts/graph-work.ts` | Work 身份、授权、Host 命令、获权数据读取和提案 |
| `contracts/graph-api.ts` | 公开快照、列表摘要、图查询/命令及响应 |

## Interface 与不变式

类型名称、字段、可选性、判别联合及注释中的业务约束全部保留。HTTP、IPC、持久化和运行行为保持一致。`data-definition.ts` 直接依赖 `graph-agent.ts`，解除定义协议与图实例协议之间的循环依赖；新契约文件之间按依赖单向导入。

## 迁移与验证

1. 对照原始导出，将每个声明唯一归属到目标文件。
2. 同步更新源码、Vue、脚本和测试的静态导入及内联类型引用。
3. 更新 ARCHITECTURE.md 的协议导航；历史开发文档保留其原始语义。
4. 对比搬移前后的类型语法，检查类型完整性、导入解析与契约依赖无环。
5. 运行 vue-tsc、架构/消息边界检查和现有图分支、客户端、布局及本机协调回归。仅迁移类型与引用，不新增镜像测试或执行桌面打包。
