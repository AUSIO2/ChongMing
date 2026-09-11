# 054 — 自动执行与多 Host 租约

目标：启动图服务和 Host 后，run.start 自动推进动态路由、并行角度报告和汇总；人工批准后自动继续。两个 Host 可以领取同一 Claim 的不同角度。保留 053 的自定义 Agent/tool、独立汇总、配置快照和原子接受。

## 架构与边界

工作资格直接由 Run 状态推导：无 route → router；批准 route 中尚无报告的 slot → worker；全部报告齐且无 draft → merge。无需新增持久任务队列。每 Host 默认一次处理一个工作项；多个 Host 共享 Mongo，通过服务领取不同 slot 并行。一个 Map 仍只有一个活动 Run。

每个工作项对应一个独立 DSH 进程和根 Session，使用该角色被冻结的 profile。把工作项 root 与业务 worker/merge 身份区分开。移除原 data_delegate 本机扇出，避免绕过领取；底层模型、工具、上下文和会话仍由官方 DSH 执行。router 只负责动态选角度与候选 Agent/tool，不把选择逻辑写进 Host。

GraphDocument 顶层 leases 以稳定 proposal/work ID 为键；与整体 CAS 写入的 run 分离。grant 包含 mapId、runId、operationId、workId、actor、routeRevision、hostId、holderId、fence、expiresAt。holderId 是领取请求UUID；fence由数据库递增。lease 不进入产品快照或模型数据，也不进入业务提案幂等 hash。

## 原子性

- claim 用当前 Map revision、活动 Run、工作仍就绪、该项无有效租约的条件原子写 grant/fence++。截止时间与过期条件使用 Mongo 的 $$NOW。找不到第一项时继续找其他 slot/Map，避免占用项堵住后续工作。
- Mongo连接固定primary读取与majority写确认，保证已确认的租约代数/报告收据在副本集换主后仍可作为依据；写确认超时属于不确定结果，按收据/租约重新确认。
- claim/renew/release 只修改单个 leases 键，不增业务 revision。报告/命令 CAS 永不整体覆盖 leases。
- 新提案的最终 Mongo 更新同时检查 Map revision、holderId/fence、未过期租约及正确 Run。取消与提案的胜负由这次原子写决定。
- 已接受的相同业务提案可确认重放，但不新增结果；未接受的旧 fence 提案拒绝。不同 slot 报告冲突只重读重验数据库，不重跑模型。
- 一个工作接受产物后即不再可领取；DSH退出后释放物理lease。waiting没有可执行工作，用户批准route后重新派生worker。每次执行都用固定grant，禁止失租后换新grant提交旧调用。
- 普通执行失败由持有者带有效grant把Run置failed并保存简短错误。取消、失租和停机不误写failed；Host关闭当前DSH进程后再释放。崩溃无释放时，到期可接管，已有报告跳过。

## 接口与进程

公开query/command保持原有规模。新增内部 POST /internal/v1/work，method为claim/read/renew/release/fail，使用已有Host Bearer token。claim.params={hostId,holderId,mapId?}；其余使用固定grant proof。内部data.read/propose必须带x-work-id、x-work-holder、x-work-fence；actor由数据库grant解析，删除旧自报role/slot入口。read确认本工作是否已接受，跨Run也能查既有收据，不伪造已经删除/修改的历史Claim输入。

每次claim调用使用新的holderId。Host不并发重试同holder请求；响应丢失但未取得grant时不执行该工作，未知租约等待到期回收。claim不承诺公开command式全局请求幂等。

data.read增加work={id,actor,routeRevision,status:ready|accepted}，供单项执行器判断自己的产物；整个operation未完成时worker也能结束。模型不接触租约头或token。

独立 Host 命令启动常驻领取循环；图服务保持独立，可在每台机器使用相同Mongo与其本机图服务。Host失去续租确认即Abort本项并await官方SDK close。SDK close改为共享Promise，确保所有调用等待真正退出。提供轮询/租约周期配置用于部署和验证，不加入Redis或新调度依赖。

当前Host token表示可信部署，不在本阶段增加用户权限/密钥管理。保留旧前端及原有未提交Mapper修改。旧无租约执行器调用方一次性切换，不保留绕过授权的并行通路。

## 验收

真实Mongo并发领取仅一个赢家、不同slots可同时领取；续租不改变Map revision、不被报告覆盖；过期续租拒绝、接管fence递增、旧Host写入拒绝；取消/fail与报告竞争；相同已接受报告重放不重复；HITL等待不执行worker，批准后自动继续。两个独立Host进程/独立DSH目录实际调用自定义工具并在同图发生时间重叠；崩溃后接管未完成slot；正常关闭立即发起DSH退出并等待完成。模型端点继续使用本机确定性fixture，外部模型质量不冒称已验收。

## 实现入口

| 文件/入口 | 职责 |
|---|---|
| work.ts / workReadItems | 从已接受的route/reports/draft推导可执行角色工作 |
| store.ts / claim、readLease、renew、release、commit | Mongo服务器时间与单文档围栏；不混写lease和业务状态 |
| graph.ts / dispatchWork、readData、propose | 领取协议、固定grant校验、收据确认与CAS |
| api.ts / apiReadWorkCommand、apiReadWorkProof | 内部请求的严格解析，角色由grant派生 |
| host.ts / hostCreateWorker | 一个Host的一条领取循环、续租与保守截止时间、退出后释放 |
| host-main.ts / hostRunMain | 独立Host命令、实例ID、目录及SIGINT/SIGTERM关闭 |
| dsh-verify.ts / dshRunWork | 单工作项的官方DSH进程；按冻结profile执行，按收据结束 |
| dsh-business-plugin.mjs | 真实根Agent绑定、工具白名单、data_read/data_propose |

当前接口与部署参数统一见[054-接口文档](./054-接口文档.md)。
