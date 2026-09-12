# 技术正确性审查

## 审查内容

- 服务边界与默认入口：新 Electron 客户端只调用公开 Graph API；图服务、Host、DSH 是独立进程。
- 入口：公开 query/command、流式资产、内部 work/data、进程与 CLI 均已归属 Flow。
- 持久化：10 个应用 Entity、Graph 嵌入值和 GridFS 基础设施已区分。
- 状态：Run/Operation、Review、Asset、Workspace/Map tombstone 和 Lease 的写入点已核对。
- 并发：用户命令回执、CAS、事务授权围栏、proposal 回执和 lease fence 已核对。
- 代码与图：逐图自审记录见反向还原文件。

## 问题

| ID | 等级 | 内容 | 处理 |
|---|---|---|---|
| TECH-01 | P1 | 参考规范要求独立执行单元完成图→代码审查；当前任务未获准另启审查者 | 保持候选状态，在正式发布前由未参与编写者复审 |
| TECH-02 | P2 | 生产部署清单、证书和监控配置不在仓库 | 仅记录源码可见运行要求，不写入主文为已实现能力 |
| TECH-03 | P1 | 初稿把上传写为 Owner、Workspace 导出写为 Viewer | 已按 `AssetsService.upload/exportWorkspace` 修正入口、trace 和主文 |

P0 为 0，TECH-03 已关闭。TECH-01 未关闭，因此不作正式发布判定。
