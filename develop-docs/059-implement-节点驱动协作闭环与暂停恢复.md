# 059 — 节点驱动协作闭环与暂停恢复实施原稿

设计依据：[059 技术设计](./059-节点驱动协作闭环与暂停恢复.md)。本文在业务代码改动前创建；前六节保留实施原稿，实际完成情况见末尾记录。

## 1. 保护基线与统一文档

1. 保留 053–058 已完成的新后端、核查客户端与测试；不修改旧 Mapper 等用户已有未提交文件。
2. 在 050–052 正文修正单 Run 根 Session、强制模型会话恢复、单 Claim 作为完整目标等过时表述；标清历史审计与当前已实现基线。
3. 以 059 作为节点驱动闭环和暂停协议的实施依据，先确认生产合同，再同步示例与文档校验；不把设计稿接口当成已上线接口。

## 2. Run 与节点处理合同

1. 将新后端 Run 的单 target/operation 改为明确的 scope.nodeIds、until、operations[] 和独立 paused 位，保留一图一活跃 Run。
2. operation 绑定数据节点、处理阶段、实际输入版本和配置；Review、报告和收据属于 operation。Node 不表示 Agent。
3. 复用已有具体模块定义输入、输出与字段校验，接通 parse/source、split/news、verify/claim；保留 verify 内部 router/角度/merge。
4. 明确一次性旧数据迁移与升级边界，不保留双协议运行路径。

## 3. 业务发现与并行执行

1. 在现有 Run/work 代码中根据 scope/until 与有效收据派生需要的 operation；独立新闻、事实可同时 ready。
2. 接受结果、关系、空结果收据和 operation 推进原子提交；提交后及 Host 再次扫描均能重建后继义务。
3. scope 持续限定本次闭包，不因处理完第一项扩大到全图；重叠输入和共享事实去重；完成按同一确认图版本检查闭包。
4. 沿用现有 Host 领取循环、租约 fence 和 CAS，不新增调度器、队列、消息中间件或 Runtime 接口。

## 4. 暂停、审核与恢复

1. 用户 pause/resume 走现有权限事务、revision 和收据；pause 同次提交定向过期本 Run lease，保留 holder/fence。
2. discover、claim、readLease、renew、commit/fail 的执行资格一致检查 paused；确认并发 claim/renew 不会因不升 Map revision 而逃过失效。
3. Review 与暂停独立：operation 可持续保留审核事实，回答不清 paused；其他 operation 在未暂停时可继续。
4. resume 同 Run 重新推导业务工作，不清报告或审核，不加载旧模型现场；未提交工作使用新 DSH Session。
5. 区分关客户端、停 Host、用户 pause、cancel、failed；更新客户端操作与状态展示，暂停仍阻止编辑/覆盖/删除活跃图。

## 5. 客户端闭环

1. 在现有客户端新增 scope/until 入口和多节点进度、operation Review、暂停/继续；数据与审核通过现有 typed gateway。
2. 接通共享 Source、News、Claim 的连续推进，不要求用户逐 Claim 创建 Run；保留 News/Claim 编辑、关联来源和核查角度能力。
3. 以最新 Snapshot 处理并发冲突与迟到响应；断开视图不改变共享运行。

## 6. 验证与交付

1. 先运行与改动直接相关的范围/派生/空结果/审核测试，再覆盖多 Host lease 与暂停竞争；使用现有确定性 fixture。
2. 覆盖 source→news→claims→verification、多来源/共享 Claim、until 边界、多个独立 operation、最后提交与完成竞争。
3. 覆盖 pause 与 claim/renew/proposal/fail 交错、快速恢复、旧 grant 迟到、幂等重放、权限与终态限制。
4. 运行全量测试、vue-tsc、构建、契约校验和 git diff --check；如有依赖未就绪，明确记录阻塞及实际已验证范围。
5. 用本轮实际结果更新完成记录和 README；仅提交本轮文件，旧未提交改动继续保留。部署、发行或安装按现有用户授权范围执行。

## 当前记录

- 2026-09-12：设计与实施原稿已在生产编码前创建；050–052 正文、目标合同和示例已同步修订，历史审计与 053–058 已实现基线分开标注。
- 文档校验通过：052 目标合同 9 个查询/25 个命令与示例独立类型检查、43 个旧 Electron 方法/15 个旧 Mapper 命令映射；12 份 Markdown 的 559 个本地链接与格式检查、git diff --check 通过。该结果只证明文档工件，不证明本轮生产功能完成。
- 下列记录仅归属本轮验证，053–058 的历史结果保持原有归属。

## 完成记录（2026-09-12）

- 已将生产 Run 改为 scope.nodeIds/until/operations[]/paused；同图多个 Source、News、Claim 操作可分别领取，结果接受后在同一 CAS 内补齐后继与整体进度。配置和实际输入版本冻结，有效历史结果及零结果可复用，显式 regenerate 才重新生成；旧结果版本变化时不复用。
- parse 支持共享文本资产与公开 HTTP(S) URL，首次正文读取随 operation 保存；URL 校验 DNS 地址并固定实际连接，拒绝私网/本机与重定向，限制文本媒体、UTF-8、1 MiB、10 秒。仅隔离测试 fixture 显式允许自己的本地 URL。
- split 保留 router、多 Agent 提取与 merger 选择原始候选引用；verify 保留动态角度、自定义工具/模型与逐角度意见。没有增加依赖、任务队列或自有模型上下文恢复机制。
- pause/resume 已走用户权限事务和幂等回执；暂停与租约过期原子提交，保留 holder/fence，快速恢复不能复活旧授权。Review 属于各 operation，独立待审；暂停中批准仍暂停，恢复保留已有成果与人工决定。
- 客户端已接 Source URL 创建、单节点及批量 scope/until、显式重新生成、多操作进度与独立审核、暂停/继续；保留草稿、版本冲突、快照轮询和未结束 Run 的输入锁。
- 显式管理员命令 data.migrate-node-runs 默认只检查；apply:true 才在事务内迁移当前及历史单 operation Run。保留原身份/报告/Review/回执，未结束旧 Run 保持暂停；按 Mongo 时间拒绝有效租约。旧结果引用保留创建时版本 0，避免把后来人工编辑的结果重新认证为有效。未执行任何用户数据库迁移。

验证结果：

- 最终全量 npm test：46 个文件、210 项全部通过，退出码 0，无未处理异常。
- 节点协作专项 9 项、来源边界 7 项、迁移 14 项；真实客户端/官方 DSH 集成 3 项；原两 Host auto/HITL/SIGKILL 接管 3 项均通过。模型与工具数据使用本机确定性 fixture，未调用用户外部付费模型。
- npm run build:check 通过：类型检查、Vue/Vite、Electron Main/preload 构建和本机 arm64 DMG 打包。发行签名未配置，未安装或发布。
- 浏览器实际验证两 News 独立待审、未保存甲草稿经过暂停及乙审核刷新仍保留、暂停中批准不恢复、继续后 6/6 操作完成并形成 4 份事实结论。另验证 URL Source 到 until=news 后停止。960×640 无页面溢出/关键控件遮挡，控制台无错误；临时标签及测试服务已清理。
- 052 契约检查与 git diff --check 通过。

一轮全量验证暴露旧 catalog-service 单测的异步副作用：CRUD 返回后仍动态导入本地数据库模块，环境关闭时产生4个未处理错误。只修测试边界，沿既有 registry 测试隔离数据库同步并逐次等待 dynamicImportSettled，保留同步调用断言；旧 catalog/Mapper 生产代码及用户已有改动未修改。最终全量结果以修复后记录为准。

升级与剩余范围：已有工作区配置不会自动覆盖，旧占位 parse/split 提示词及缺失拆分 Agent 须经已有 Agent 接口显式配置。完整管理界面、产品 SSE、旧源码/依赖最终清理及安装包自动托管本地服务仍为后续工作。本轮工作保留在工作区，未推送或部署。
