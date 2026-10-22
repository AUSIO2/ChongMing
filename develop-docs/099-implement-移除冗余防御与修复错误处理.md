# 099 — 移除冗余防御与修复错误处理实施记录

对应[设计](./099-移除冗余防御与修复错误处理.md)。

## 执行清单

- [x] UI 7 组，其中 schema 引用行为修复有回归。
- [x] 公共客户端 4 组，保持真实响应边界验证及快照/分支一致性。
- [x] 业务模块与应用层 8 组，保留业务不变量。
- [x] 运行与适配层 5 组，覆盖 MQ 和管理员命令行为修复。
- [x] 汇总相关测试、类型、边界与差异检查结果。

## 24 组处理结果

| 范围 | 已完成的独立问题组 |
|---|---|
| UI 1 | `$ref` 直接解析服务端已验证的本地名称，支持点号；缺目标明确失败，不再静默返回原 schema。 |
| UI 2 | 删除 `next.ownershipRevision` 和 `snapshot.ownerships` 的必填字段默认值，保留尚无快照时的实际空状态。 |
| UI 3 | 运行计划返回单步 tuple，删除空计划路径和调用方防空步骤。 |
| UI 4 | 删除从未创建的 RAF 身份和取消分支，保留恢复代次隔离。 |
| UI 5 | 阅读字段 helper 接收已缩窄对象，不重复检查数组、null 和标量。 |
| UI 6 | 二维/三维布局直接传递已初始化的节点状态，删除数值默认值；稀疏邻接表和分组的首次创建保留。 |
| UI 7 | 连接展示明确处理未连接状态，删除空 URL 的异常控制流。 |
| 客户端 1 | 分支续租只解析一次分支证明，ownership 形状检查完成后返回，不再递归重复进入公共尾部。 |
| 客户端 2 | 快照/分支形状验证后直接检查根身份、内容版本和证明配对，不补空数组或空对象。 |
| 客户端 3 | 节点、引用和证据使用验证器声明实际验证过的窄类型，删除后续重复形状检查。 |
| 客户端 4 | 删除下载非成功响应之后不可达的 throw，并删除无其他引用的错误枚举。 |
| 业务 1 | 删除证据命令重复体积检查。 |
| 业务 2 | 库引用身份和理由在同一遍历内解析，保留数量、白名单、UUID、摘要、去重和理由限制。 |
| 业务 3 | 已解析 Agent 只复制并建立版本；种子新增管理角色和提示词路径后仍在转换入口解析。 |
| 业务 4 | 定义发布采用本函数已解析的包，保留目录跨包语义验证。 |
| 业务 5 | 删除 Run 内部重复存储格式检查和启动前的无效全量查找，保留 Run 存在性与实际执行约束。 |
| 业务 6 | Run 计划校验后直接使用选材引用，冻结阶段继续检查身份、摘要、工作区与容量。 |
| 业务 7 | 删除旧包漏声明依赖的补偿 helper 和导入/导出扫描，保留现行目录的显式依赖及精确闭包验证。 |
| 业务 8 | 事务回调类型明确 session 必填，删除应用层紧邻使用模块的重复事务检查。 |
| 运行 1 | DSH 身份只在响应入口核对；persona 渲染一次，再附加库材料。 |
| 运行 2 | Mongo 删除 schema 已强制存在的 runs/leases 默认值。 |
| 运行 3 | 桌面子进程删除空 try/finally。 |
| 运行 4 | QUEUE_CONFIG 拒绝启动并终止消息循环，finished 返回同一原因；临时故障及 QUEUE_SETUP 仍按原策略重连。 |
| 运行 5 | 管理命令把配置写入、端点参数校验移出网络 catch，原始本地错误经现有 CLI 失败出口传播。 |

## 验证结果

- 三组行为问题增加 7 项回归，先在原实现复现失败，修复后通过；DSH 原授权身份断言迁到真实响应边界，未丢失覆盖。
- UI 相关 9 个文件：158 项通过，覆盖 payload、布局、阅读来源、标签、会话、编辑授权与关系展示。
- 业务相关 9 个文件：63 项通过；真实 HTTP 证据库 8 项通过；显式 Mongo 目标核心套件 70 项通过、44 项按既有阶段配置跳过。
- 运行相关 8 个文件：51 项通过，覆盖消息服务、管理配置、DSH、提示词、库材料、Host、子进程及副本工作。最后提示词夹具精简后另复跑 6 项，通过，不重复计入合计。
- 最终客户端与存储集成 11 个文件：118 项通过，包含 72 项客户端回归及 SQLite、图更新、本机协调、分支重放和桌面 IPC。
- 上述不同套件合计 468 项通过，另有 44 项既有跳过。前期重复运行的测试未累计。
- `npx vue-tsc --noEmit` 通过。
- `npm run test:boundaries` 通过：131 个模块、119 个运行消息文件，无新增硬编码错误文案。
- `git diff --check` 通过。

## 验证命令与边界

客户端与最终存储集成使用：

```sh
npx vitest run --config vitest.config.ts tests/client/graph-client.spec.ts tests/client/stream.spec.ts tests/client/files.spec.ts tests/client/evidence-uses-client.spec.ts tests/client/evidence-relations-client.spec.ts tests/backend/adapters/storage/sqlite.spec.ts tests/backend/adapters/storage/sqlite-integration.spec.ts tests/backend/modules/graph/local-coordination.spec.ts tests/backend/modules/graph/graph.spec.ts tests/backend/adapters/storage/branch-rebase.spec.ts tests/apps/desktop/ipc-handlers.spec.ts
```

证据库实际目标使用仓库提供的配置：

```sh
npx vitest run --config experiments/evidence-library-tests/core-http.config.ts
EVIDENCE_TEST_TARGET=experiments/evidence-library-tests/mongo-target.ts npx vitest run --config experiments/evidence-library-tests/core.config.ts
```

首轮核心套件遗漏目标环境变量，仅配置加载失败；按 README 配置后完成上述通过结果。首轮窄类型声明遗漏了现有调用方所用字段，已补充对应已验证字段并通过最终 Vue 类型检查。未做 GUI 人工验收、打包、部署或数据迁移。

## 原有改动与恢复

实施前副本与差异保存于本机临时目录 `chongming-before-24-groups-iqevkc5t`。按副本逐文件复核，本轮只叠加目标修改；已有来源、证据库、Map 编辑和测试修改均保留。没有重置工作区、提交或推送。
