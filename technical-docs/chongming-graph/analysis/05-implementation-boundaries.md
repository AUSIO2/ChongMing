# 实现边界与内部判断

本文件不进入对外主文。

| 主题 | 当前事实 | 触发条件 | 影响 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| 可执行阶段 | metadata 与运行合同均支持 parse/split/verify | Source/News/Claim 进入 scope | 按 until 派生对应 Operation | `control.ts#read`、`run.ts#runUpdateProgress` | 无 | 已证实 |
| 工作发现扫描 | Host 按 updatedAt 扫描有 running Run 的 Graph | 图量持续增长 | claim 延迟和数据库读取增加 | `store.ts#discover` | 有测量后增加 ready-work 索引 | 已证实 |
| 单 Graph 文档 | 节点、边、Run、lease、回执同一 Mongo 文档 | 接近 8 MiB 软限制 | 新业务写入返回 GRAPH_LIMIT | `storeValidateDocument` | 达到实际规模后拆集合 | 已证实 |
| proposal 竞争 | worker proposal 最多重试 64 次 CAS，只重试数据库写 | 大量角度同时完成 | 极端竞争返回 WRITE_CONTENTION | `graph.ts#propose` | 观察冲突率再调整 | 已证实 |
| 外部工具副作用 | lease 接管可重做未提交推理/工具调用 | Host 失租或崩溃 | 外部工具可能重复副作用 | `host.ts`、`dsh-verify.ts` | 工具自身使用幂等键 | 已证实 |
| orphan blob | 提交结果未知时保留未公开 blob | Mongo 提交结果不确定 | 需要停写维护识别未知孤儿 | `assets.ts#importWorkspace` | 增加有证明的离线清理 | 已证实 |
| URL locator | 只验证 HTTP(S) 并存储，不抓取 | 用户新增 URL source/evidence | 不产生内容快照 | `graph-input.ts` | 抓取属于后续明确能力 | 已证实 |
| 生产可观测性 | 仅 stdout/stderr 和结构化 Host start/stop 事件可见 | 生产故障定位 | 没有仓库内 metrics/tracing 集成 | `graph-main.ts`、`host-main.ts` | 部署时接外部采集 | 已证实 |
| 存量 News 修复 | 057 前可能有 context 被 Mongoose minimize 省略 | 客户端读取旧图 | DTO 不完整 | `repair.ts`、056 回归 | 先 dry-run 后显式 apply | 已证实 |
| 正式部署材料 | 仓库没有容器/编排、证书或监控清单 | 生产部署 | 无法从源码确认拓扑与 SLA | 基线搜索 | 由部署仓补齐 | 待确认 |
| 管理界面与事件流 | 业务 API 已有 Agent/成员/资产管理，产品客户端仍未覆盖全部管理界面且使用轮询 | 管理或大量进度更新 | 需 API/CLI 操作，页面无 SSE | 059 完成记录、客户端源码 | 后续接线 | 已证实 |
