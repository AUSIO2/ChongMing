# 重明图服务技术说明书生产包

## 基线

- 服务：重明图服务（Graph API、Host 与 DSH 工作适配器）
- 分支：`codex/run-review-core`
- Commit：`b5b6df5af5367b1147f0311c6fe96f1cf0fbf903`
- 参考流程：WisePen 微服务技术说明书 AI 生产规范 v2.13，已适配 TypeScript/Electron/Host 架构

## 范围与入口

分析覆盖 `backend/`、`contracts/`、客户端传输边界及默认新客户端对服务的消费。旧 Mapper/server 源码保留在仓库，但不属于当前图服务说明书。证据层归并为 6 个业务 UC、1 个运维流程和 1 个独立开发流程。

入口盘点包含 8 个 query method、19 个 command method、4 个独立用户 HTTP、7 个内部动作、4 个运行/管理入口和 2 个独立 DSH 开发入口。10 个应用持久化 Entity 已进入附录 A；GridFS 作为基础设施资源单列。

## 阅读入口

- 对外稳定技术事实：[技术说明书.md](./技术说明书.md)
- 可分发 Word 版本：[重明图服务技术说明书.docx](./重明图服务技术说明书.docx)
- 基线与证据：[analysis/](./analysis/)
- 逐流程追踪：[traces/](./traces/)
- 图源与静态图：[diagrams/](./diagrams/)
- 审查与未闭环项：[review/](./review/)

## 当前状态

正文、证据、trace、参与者映射和 14 份 Mermaid 图源已经生成；每份图源都有 SVG、常规 PNG 和窄版 PNG，静态渲染与图片检查完成。作者自审不替代参考规范要求的独立技术审查；正式发布还需关闭 `TECH-01`、完成 Draw.io 导入检查（若交付要求）和独立读者语义验收。当前标记为候选生产包。

文档不得包含真实 token、密钥、个人配置或生产地址。本包只记录源码中的配置名称和脱敏语义。

Word 版本为 19 页 A4 技术手册，嵌入中文字体和 6 张正文图；封面不显示页眉页码，正文包含单页目录、重复表头、图片替代文本和页码。

源码/图量复核位于 `analysis/08-source-metrics.md`，发布门禁位于 `review/06-release-checklist.md`。由于独立审查尚未完成，本次不生成名称暗示“正式发布”的 ZIP。
