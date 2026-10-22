# 自动化验证

测试按现行源码归属组织，不以历史阶段号或曾经的测试数作为覆盖标准。

## 目录对应

- `tests/backend/modules`：图、Run/Operation/Work、分支、权限、定义和领域状态规则。
- `tests/backend/adapters`：HTTP、Mongo/SQLite、RabbitMQ/进程内消息、资产和显式迁移。
- `tests/backend/execution`：Host 领取/续租/关闭、DSH 会话与工作执行。
- `tests/apps`：桌面 IPC/子服务、CLI 进程和本机配置。
- `tests/client`：公共客户端、SSE、会话状态、图布局和界面特性状态。
- `tests/browser`：M00 真实浏览器产品、并发/断流、API 进程重开和独立性能用例；[当前范围与运行方式](./browser/README.md)。Vitest 排除此目录，普通 Playwright 排除性能及受控故障 spec，性能由独立配置发现。
- `tests/contracts` 与 `tests/platform`：共享协议和 Node 进程/诊断边界。
- `experiments/evidence-library-tests`：证据库真实 Mongo/HTTP 与专项压测工件；只有被当前配置显式纳入的用例才是本次回归结果。

跨测试共用夹具位于 `tests/backend/fixtures` 和 `tests/fixtures`。所有需要 Mongo、RabbitMQ、SQLite、DSH 或模型端点的用例必须使用隔离实例和确定性夹具，不操作开发者的服务或正式凭据。

## 常用命令

- `npm run test:boundaries`：检查模块依赖、本机/协作入口隔离和运行错误消息；`npm test` 与 `build:check` 会自动执行。
- `npm run test:local`：SQLite、进程内通知、本机并发、暂停续跑和文件导入；不需要 MongoDB、RabbitMQ 或 Docker。
- `npm run test:faults`：进程终端、关闭时限、日志脱敏、HTTP/IPC、Host/MQ 和客户端恢复。
- `npm run test:map`：注册类型名称/摘要、`successor/reference` 布局、转换选择和通用阶段进度。
- `npm run test:ui -- --project=local` / `collab`：真实浏览器验收，分别使用隔离 SQLite 或 Mongo/Rabbit。
- `npm run test:ui:perf -- --project=local` / `collab`：独立 P01–P03，默认仅 200/800 短校准。standard/capacity、5/30 分钟需要显式环境许可；本轮没有正式容量或耐久成绩。
- `npm run test:ui:fixture`：精简后的 M00 生命周期、报告器、真实失败产物、性能报告白名单、Vite 配置和纯诊断合同，共 28 项。重型启动故障 runner 已移出维护集，原执行证据保留在台账。
- `npm run test:ui:types`：严格检查 M00 配置、浏览器用例、测试装配及所用 Node 资格测试；不以运行成功代替类型检查。
- `npx vitest run --config vitest.config.ts tests/client/session-grants.spec.ts tests/client/session.spec.ts`：S1 授权顺序、期限、选择代次与旧会话回归；真实 SSE 原帧旅程另由 `workspace-grant-reliability.spec.ts` 执行，当前前置异常及重启保存未通过项仍须单列。
- `npx vitest run --config vitest.config.ts tests/client/session-editing.spec.ts tests/client/branch-baseline.spec.ts`：S2 写响应/领取的正文与证明配对、独立分支基线与真实旧证明拒绝；真实连续编辑/外部冲突由 `workspace-editing-reliability.spec.ts` 覆盖。
- `npx vitest run --config vitest.config.ts tests/client/session.spec.ts`：会话基础及 C03 偏好原请求重试、版本冲突选择、合并与工作区代次隔离；真实恢复流程用 `npm run test:ui -- tests/browser/workspace-reliability.spec.ts --grep M01-C03`。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M02-C04`：当前图改名、确认删除、协作占用保护、Viewer 拒绝与固定证据保留；协议/收据及真实存储交错另在原 graph、branch-lease、local-coordination 与 session 用例维护。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M02-C05`：固定后继创建、原子连线/来源脚注、人工意见/结论来源及声明字段引用；版本、临时授权和原请求保护由 session/branch/source-anchors/backend 图用例维护。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M03-C06`：协作节点固定库引用的添加/改理由/清空、正文保留、固定原文与撤回历史；本机项目单独验证未提供库时禁止编辑。两条旅程各仅适用一个项目，按项目跳过不计作通过。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M03-C07`：协作四类有序收录依据、跨Map非Claim固定节点、真实文件下载字节和库原文，以及来源更新删除/库撤回后的Viewer阅读；本机两个不适用项目跳过，不计作通过。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M03-C08`：协作新建/重复收录/相反判断结果及固定导航；真实成功丢响应后按原编号确认，保留原收据中的相反判断列表。本机两个不适用项目跳过，不计作通过。
- `node --import tsx tests/run.ts tests/backend/modules/graph/generic-run.spec.ts tests/backend/modules/graph/run.spec.ts tests/client/graph-client.spec.ts tests/apps/cli/headless.spec.ts tests/apps/desktop/ipc-handlers.spec.ts`：C09权威发布集合、只读预览、批准版本保护和公共入口；复用现有领域/真实HTTP夹具，审核界面由后续C10覆盖。
- `npx vitest run --config vitest.config.ts tests/client/publication-preview.spec.ts tests/client/session.spec.ts`：C10前端预览生命周期/候选对齐、input/context精确版本、冻结材料与实际理由、新审核目标/版本及原请求确认。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts tests/browser/workspace-reliability.spec.ts --grep M04-C10`：C10真实Host规划→结果审核，local/collab核对完整上下文与实际发布；collab同时验证启动后撤回的冻结0材料/实际使用理由，以及批准成功丢回包后的原请求确认。本机不适用的协作恢复旅程按项目跳过。
- `node --import tsx tests/run.ts tests/backend/modules/graph/run-history.spec.ts tests/backend/modules/graph/run.spec.ts tests/client/run-history.spec.ts tests/client/graph-client.spec.ts`：C11有界目录/成员版本/绑定游标、真实归档/权限、单份只读详情及迟到隔离；沿现有fixture，不另造服务。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M05-C11`：local/collab真实A完成→B启动归档A→历史读A/B→关闭仍控制B；核对产物、控制证明和无新增写入/预览。
- `node --import tsx tests/run.ts tests/client/node-provenance.spec.ts tests/client/run-history.spec.ts tests/backend/modules/graph/generic-run.spec.ts tests/backend/modules/graph/library-claim-run.spec.ts tests/backend/modules/assets/bundle-v4.spec.ts`：C12保存来源投影、精确Operation/产物映射和目标迟到隔离；既有真实复用、导入规则作绿对照。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M05-C12`：local/collab真实A生成→B复用→独立C待审；详情/单页来源定位、编辑版本差异、直接复用来源及冻结JSON阅读，关闭后C选择/控制不变，无新增写入或预览。
- `node --import tsx tests/run.ts tests/backend/modules/workspace/workspace.spec.ts tests/backend/modules/shared/data-definition.spec.ts tests/client/definition-editor.spec.ts tests/client/graph-client.spec.ts tests/client/management.spec.ts tests/apps/cli/headless.spec.ts tests/apps/desktop/ipc-handlers.spec.ts`：C13真实共享定义目录、精确包与公共边界、独立JSON草稿和既有不可变发布/CAS/收据/冻结规则。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts tests/browser/workspace-reliability.spec.ts --grep M06-C13`：local/collab正常定义发布、真实共享/工作区隔离及只读角色；成功回包丢失后以原request/包/版本确认，不重复发布，旧节点与冻结Run保持。
- `node --import tsx tests/run.ts tests/client/management.spec.ts tests/client/management-integration.spec.ts tests/backend/modules/workspace/workspace.spec.ts tests/backend/modules/shared/data-definition.spec.ts`：C14三职责精确绑定、同职责变量交集及独立草稿；真实创建/改绑版本、合法点号/长阶段引用及已有权限/身份/冻结规则。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M06-C14`：local/collab通用新稿角色选择、绑定保存0→1、改稿不隐式提交、保留不适用变量后显式移除；刷新/共享与工作区/Viewer核对，旧配置、转换与冻结Run保持。
- `node --import tsx tests/run.ts tests/client/run-draft.spec.ts tests/client/layout.spec.ts tests/client/evidence-selection.spec.ts tests/client/session.spec.ts tests/client/session-editing.spec.ts`：C15共同单步草稿、精确类型/数量、材料版本与能力目标、独立提交副本及原请求门禁；原计划、选材/会话规则保持。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M07-C15`：local/collab顶部/节点共用表单，确认前不启动；两次真实启动核同参数，换转换/正文版本清材而mode/regenerate不清，协作明确材料/本机零库查询，正文草稿与无关Run保持。
- `node --import tsx tests/run.ts tests/client/run-draft.spec.ts tests/client/layout.spec.ts tests/client/evidence-selection.spec.ts tests/backend/modules/graph/generic-run.spec.ts`：C16全端口、精确直接输出、范围/依赖/分组/64步边界，逐步材料与切卡保留；真实后端合同不预测未来输出数量。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M07-C16`：local/collab同一表单配置双输入、必填上下文、两个显式组及后步逐个消费正式输出；独立API核对2+2处理项、2篇新闻/4条事实和逐步固定材料，本机零库查询。动态边界保留在Node，不扩模型夹具。
- `npx vitest run --config experiments/evidence-library-tests/relations.config.ts`：真实Mongo/HTTP固定关系及依据，含跨Map同nodeId、非Claim节点、精确basisIndex、旧版本/文件hash/库digest/新增撤回项原子拒绝和旧无快照边界。
- `npx vitest run --config experiments/evidence-library-tests/usage.config.ts`：真实Mongo/HTTP使用追溯，含人工引用的改理由、新旧消费者版本、撤回旧引用、错误摘要和跨工作区拒绝；与Node核心回归分开报告。
- `npm run test:run`：定义发布与冻结、有限计划、Agent Work、Host 并发、权限、v4 数据包及 MQ/SSE。
- `npm test`：运行当前全部回归；需要隔离 RabbitMQ 的部分会使用临时 Docker 容器或 `CHONGMING_TEST_BROKER_FILE` 指定的测试 broker。
- `npm run test:desktop-runtime`：准备发行资源，并用随包 Node 验证 SQLite/DSH、重启和父 IPC 断开。
- `npm run build:check`：类型、边界、Vite 与 Electron 打包。
- `node develop-docs/064-校验入口.mjs`：验证前端、桌面与 CLI 不加载执行后端或存储依赖。
- `node develop-docs/077-校验数据定义.mjs`：验证默认数据类型、转换定义及示例。

## 当前推进决定

2026-10-18 用户要求精简测试后进入 M01。S1/S2、原正常生命周期与重启业务回归保留；M00 扩展资格、正式容量/耐久及未定位启动异常的继续追查暂缓，不再阻塞业务模块。当前维护范围见 [浏览器测试说明](./browser/README.md)，历史结果见实施台账。

## 重要回归边界

- 本机模式不发送客户端分支/Run 租约命令，但仍校验分支内容证明、权限、审核版本、持久 Run 范围占有和内部 CAS。
- M00 并发以真实两浏览器与独立公共读取验证；双请求屏障只证明 HTTP 实际重叠，不把 SQLite 串行提交称为数据库并行。collab R01 曾出现保存按钮超时，后续定向通过不消除原始间歇异常。
- M00 恢复 child 只重开真实 API 服务及其数据库/消息连接，父侧保留存储、身份与稳定 Web 地址；没有 Host/Run/模型执行，不代表执行系统或数据库故障切换验收。
- 追加排查已稳定复现测试配置变更触发 Vite 重载、丢失内存登录的机制；两个测试 Vite 使用 post config hook 实际禁用 watch，开发入口不改。inline watch:null 曾因配置合并被忽略而修复无效，该次失败保留。最终本机默认22/22、相关Node125/125、协作RC两例与原三轮强杀恢复同轮3/3；原偶发启动异常未再现，不能称其根因解决。
- S2 默认 local **20/20** 通过。collab 四项组合曾 3/4，R05 第三轮重新领取超时；最终八项组合 **7/8**，其中 R05 三轮通过，唯一 CS06 等待失败确定为原 claim O 帧未放行的测试前置问题。只修屏障后，CS06 local/collab 各一次通过。原组合及历史异常均保留；详见[实施台账](../develop-docs/096-implement-前后端功能补齐.md)，不能拼成一次完整 collab 绿色验收。
- 新 dataset/安全报告链的历史 local calibration P01/P02 2/2 通过；图 DOM 可用五样本 median 581.93/max 599.64 毫秒，二十次往返成功，软件 GPU 条件下十秒 RAF 仅作调度代理。此前前置失败根因未知；正式规模/长时性能未运行。夹具指定两红已修，资格入口 24/24；最新 S2 相关九文件一次组合 117/117。
- 性能用例通过而缺少受控性能附件时，安全报告器强制整轮失败；原七项 reporter 测试已扩展该守卫。S2 专用 strict、vue-tsc 与边界检查通过；生产仅会话、Inspector 和新增局部基线能力，不修改后端协议。M00 全部资格与正式性能尚未完成。
- M00 性能原始失败/超时不删除；driver 单调计时、RAF 代理和公开 JS 堆分别标明。GPU 完成、实际绘制和服务内存缺少来源时为 unavailable；短校准和报告 parser 通过不等于正式性能门禁通过。
- 协作模式验证同根、父子和共享后继互斥，不相交分支并行，以及领取/续租/释放、接管和旧 fence 拒绝。
- 同一 Map 的多 Run 回归必须证明不相交范围能同时运行，暂停其中一个不影响另一个。
- 显式迁移必须同时验证 Mongo 和 SQLite：预览不改写图记录，应用保留 Run/历史/报告身份，歧义、活动 Run 或有效租约阻断整批。操作流程见 [数据维护文档](../docs/operations/data-migrations.md)。
- 证据库的收录、撤回、固定关系、跨 Map 选材和使用追溯必须使用当前实际 Claim 定义，并隔离工作区、身份、窗口和请求代次。

跨模块必须保持的业务语义见 [业务不变式](../docs/architecture/behavioral-invariants.md)；故障专项的已验证与未验证范围见 [故障处理文档](../docs/operations/fault-handling.md)。


- `node --import tsx tests/run.ts tests/client/run-progress.spec.ts tests/client/layout.spec.ts`：C17冻结步骤、直接依赖、真实处理项/审核计数与多步摘要；原C16/C11页面旅程覆盖当前及历史步骤说明。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep 'M03-C07 混合四类有序收录依据'`：C18侧栏与固定单页使用同一关系说明，原依据序号通过展开控件实际阅读；锚点/平行边/复合身份在原relations Node用例维护。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M09-C20`：C19空配置创建与C20上传/精确来源类型及位置、人工必填字段串成一条双项目旅程，API核实际保存节点和资产身份。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M10-C21`：同一真实待审Run在3D与禁用WebGL的SVG回退中显示审核/暂停/取消；多Run/工作归属/断流/stale边界由graph-node-activity纯用例维护。
- `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M11-C22`：1440/1024/900/650宽度的同节点阅读、窄屏抽屉、运行表单Escape取消与无新增写入，使用原夹具且不启动模型。
