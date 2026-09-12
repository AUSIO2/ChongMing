# 重明图服务技术说明书生产包

## 基线

- 服务：重明图服务（Graph API、Host 与 DSH 工作适配器）
- 分支：`codex/run-review-core`
- 基础 Commit：`1ae38fa93d616fb2b32bfa567808b2d7c61d347e`
- 当前源码快照：`cbc2b902e029abb2fca2c960f2e18245ba5a201cd58f2b531366074fbab6a02d`
- 参考流程：WisePen 微服务技术说明书 AI 生产规范 v2.13，已适配 TypeScript/Electron/Host 架构

## 范围与入口

分析覆盖 `backend/`、`contracts/`、客户端传输边界及默认新客户端对服务的消费。旧 Mapper/server 源码保留在仓库，但不属于当前图服务说明书。证据层归并为 6 个业务 UC、1 个运维流程和 1 个独立开发流程。

入口盘点包含 8 个 query method、21 个 command method、4 个独立用户 HTTP、7 个内部动作、4 个运行/管理入口和 2 个独立 DSH 开发入口。10 个应用持久化 Entity 已进入附录 A；GridFS 作为基础设施资源单列。

## 阅读入口

- 对外稳定技术事实：[技术说明书.md](./技术说明书.md)
- 可分发 Word 版本：[重明图服务技术说明书.docx](./重明图服务技术说明书.docx)
- 基线与证据：[analysis/](./analysis/)
- 逐流程追踪：[traces/](./traces/)
- 图源与静态图：[diagrams/](./diagrams/)
- 审查与未闭环项：[review/](./review/)

## 当前状态

正文已按 059 节点驱动架构重写：Source→News→Claim→Verification、scope/until、多个 Operation、parse/split/verify、独立 Review、pause/resume 和显式旧 Run 迁移均进入主文。图源将随本快照重新渲染；作者自审不替代独立技术审查，当前仍为候选生产包。

文档不得包含真实 token、密钥、个人配置或生产地址。本包只记录源码中的配置名称和脱敏语义。

Word 版本共 19 页、7 幅图；继续嵌入中文字体，保留单页目录、重复表头、图片替代文本和页码。

源码/图量复核位于 `analysis/08-source-metrics.md`，发布门禁位于 `review/06-release-checklist.md`。由于独立审查尚未完成，本次不生成名称暗示“正式发布”的 ZIP。
