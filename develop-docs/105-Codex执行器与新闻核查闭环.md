# 105 — Codex exec执行器与新闻核查闭环

日期：2026-10-20建立，2026-10-21完成。状态：已先补测试再实现，并通过真实单事实及新闻闭环验收。基线608文件保存在 `test-results/105-codex-exec-baseline-689056003000/{manifest.json,source.tar.gz}`，此前所有未提交工作保留。当前counter由104推进105；未提交/推送，原5173预览及用户配置/数据库保持。

## 2026-10-21 补充验收：树状分叉（已通过）

用户指出应看到树状分支。此前的通过范围仅为单路径技术闭环，不包含多事实、多意见扇出，不能据此称业务结构已完整验收。本次继续同号阶段；补充前617文件基线为 `test-results/105-branching-baseline-1792555998/{manifest.json,source.tar.gz}`，原数据与失败记录保持，不重开M00。

先补三类证据，再调整最少实现：

1. 正式后端合同中一份News发布至少两条Claim，每条Claim按each进入独立Operation；每项核查发布两个不同角度意见和引用它们的一个结论。验证全部真实节点、跨步骤输入、各分支successor及候选引用闭合，禁止串线。既有后端若已正确则直接记绿，不制造红灯或改后端。
2. 演示验收明确拒绝原四节点单链；移除演示的单角度限制，以覆盖新闻独立陈述的拆分角色及两种独立核查职责执行。只能使用真实模型产物，不追加假事实、意见或连线来满足数量；每个分支都核对实际模型与Work来源。提供材料与未联网边界保持。
3. 真实场景已有两个节点后新增后继，应自动适应使全部节点可见；选择、正文、活动更新保持原取景。先以真实浏览器取红，再最小修正节点增长时的适应条件，不新增相机框架或修改业务关系。

最终从普通页面重跑一份新闻的两步Run，至少两事实且每事实至少两意见并汇总结论；独立API/SQLite与可见页面同时验收。实际产物数量、截图、模型调用和失败/重跑分别记录，不复用上轮6次调用当本轮证据。

本轮真实结果：`test-results/105-codex-live-news-biHG8v`，Run `651b76aa-4fc4-4481-88bf-e6ecd9a68096`，11个真实Codex工作accepted，1 News→2 Claim→4 Opinion→2 Verification，共9节点10条successor，两个结论分别引用本分支两种意见。独立API与关闭后SQLite读取一致；正常页面9个节点标签全部可见，未手点适应。146项相关Node回归、3项场景浏览器测试和2项既有UI回归通过，类型/边界/Web构建通过。仍为提供材料核查、未接联网检索，普通Run没有被强制成双分支。

## 目标与范围

新增可选codex exec执行器，保留默认DSH。先实际通过正常前端启动一个事实核查，保存真实Opinion/Verification；再实际通过统一表单创建单个Run，以默认split-news→verify-claim两个步骤串接正式claims输出，保存新闻→事实→意见→结论关系。必须是实际CLI推理、获权提案被后端接纳和产物落库三者对应，不把模拟模型/自然语言或退出0当成功。

第一版使用Host预读的冻结输入、context、可选固定库材料和依赖结果，以结构化结果适配原提案接口。不先搬DSH插件或新增MCP/通用执行框架。支持三种阶段提案：plan、outputs、selection。Codex过程不获取内部API令牌，不能自选正式nodeId或改Work/Operation/执行规格身份。

工具边界明确：本版Codex执行器只接tools=[]任务；DSH的web_search/web_fetch没有自动映射。遇到非空允许工具明确拒绝，不能静默忽略或声称调用过。真实演示采用显式、可审查的Codex初始化配置和提供的参考材料，不宣称完成在线独立取证。后续是否接检索工具另按实际需要规划。

## 最小结构

1. `backend/execution/work-api.ts`：从DSH执行器提取两个执行器确实共用的获权read/status、profile和提交能力、WorkAccessError及共同结果类型。保留原HTTP错误/失租分类，服务端仍权威验证payload/引用/合同。旧DSH路径先跑绿对照，提取后复跑；不做网络客户端框架或复制Schema验证器。
2. 新 `backend/execution/codex/work-executor.ts` 及确需的同目录小型提案/进程实现：核对状态和完整授权，accepted早退；ready时读取冻结视图、渲染既有persona和材料，通过stdin发送给一份独立codex exec。使用只读隔离目录、临时会话/忽略用户配置、禁shell及不需要的本地/应用工具；不改变全局Codex配置或复制认证文件。模型明确采用冻结profile.provider=openai与profile.model，不能保留DeepSeek标签或借CLI默认模型隐式替换。
3. Codex最终输出使用小型JSON Schema外壳承载提案JSON字符串，解析后仅接收当前mode对应的kind/reason与outputs/selection/slots字段。任意业务payload与候选引用由原服务端验证，不编写通用JSON Schema转换器。宿主注入原proposalId/mapId/operationId/specHash及Work proof，确认后端status=accepted才返回。输入/结构无效、进程失败、没有accepted都不冒称成功；提交回包丢失时只核对原Work接受状态，不重新生成其它提案。
4. `apps/execution-host/main.ts`、`apps/local-server/runtime.ts`、对应本机入口：新增可选executor=dsh|codex及codex-bin部署参数，默认DSH；在既有hostCreateWorker的runner seam装配。Host继续独占claim/renew/fence/release/取消/队列ack。Codex适配响应AbortSignal，停止并等待自己子进程退出后才交还Host；临时文件/状态仅由本次工作拥有。
5. 显式 `tests/experiments/codex-live.ts`（不命名.spec.ts，不加默认测试矩阵）：隔离SQLite/本机队列/新API端口/新Vite端口，初始化准确OpenAI模型和无外部工具配置，复用正式定义和提示词。先单事实，再新闻完整链，正常页面点击启动、独立API核对实际保存记录和CLI运行证据。保留可查看结果或按显式关闭清理自有进程，不碰用户运行实例。

## 测试先行

- 原Host/DSH/prompt、工作API与local runtime先绿对照，提取公用能力不改行为。
- 新Codex执行器用真实子进程测试夹具及隔离工作API seam验证：stdin与精确model/安全参数、三种提案及宿主身份绑定、旧accepted零spawn、错授权零spawn、工具非空拒绝、自然语言/坏JSON/非零退出不成功、提交丢回包而原Work已accepted可确认、取消等待close再返回。只补必要边界，不重建M00资格/耐久/重启框架。
- 装配验证默认DSH保持、Codex显式选择、非法executor拒绝、参数不进入模型输入/日志、现有本机API与清理保持。
- fake CLI只用于确定性测试且明确标注，不能算真实模型通过。真实验收单独记录实际模型/CLI版本、阶段/Work、产物数与理由，不断言虚构固定2条事实/3意见/0.5分。

## 真实验收及完成条件

本机只读已核对CLI版本0.162.0-alpha.17.2、ChatGPT登录状态和已配置model=gpt-6-astra/provider=openai；没有读取/输出认证文件、token或邮箱。需先做低影响真实调用验证访问，再跑业务。使用官方CLI认证缓存，由Codex自己管理；无可用openai-platform-api-key工具，不读取或伪造API密钥。

1. 正常前端创建Claim并启动核查。真正完成route/assess/merge，Opinion与Verification保存，结论引用真实意见、结构边正确，来源标明实际Agent/model/Work；输入参考材料与核查边界可审查。
2. 正常前端创建News，用统一两步计划将第二步claim输入绑定第一步claims端口，并提供原News/参考材料context；自动模式完成，逐条Claim都有实际核查意见与结论，第二步inputRefs恰为第一步正式outputRefs。
3. 相关Node、实际页面、strict/架构/消息及适当构建检查通过；原DSH回归仍绿。记录失败/修复/最终轮，冻结摘要保护既有dirty改动；不以全仓/不同阶段数字拼成一次验收。
4. 模型访问/外部条件受阻时保持目标未完成，先完成独立实现和确定性验证，准确说明还差的真实链路；不得用fake结果冒称通过。

## 官方依据

- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)：stdin、JSONL、ephemeral、output-schema、read-only、ignore-user-config和复用CLI认证。
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)：官方程序化集成；本版先直接exec，不加SDK依赖。

M00暂缓项目与096之外产品决策不纳本轮；不重做前端/图模型/审核接口。详细过程与实际文件函数见同号实施记录。

## 完成记录

- 最终单事实：`test-results/105-codex-live-claim-FY2qu4/summary.json`，正常页面启动，3个真实Codex工作accepted，1条意见、1条结论、2条正确结构边，独立API验证通过。
- 最终新闻链：`test-results/105-codex-live-news-Ts7OdB/summary.json`，单个两步Run，6个真实Codex工作accepted，保存新闻→1条事实→1条意见→1条结论及3条结构边，后步输入与前步正式输出严格一致。演示只启用一个数据事实角度，本轮保留了日期事实，不代表提取了新闻全部可核查陈述。
- 上述单链结果之后，按用户校正补充真实分叉验收：`test-results/105-codex-live-news-biHG8v/summary.json`，9节点10边，结果见本文件补充验收一节；此前单链记录保留，不替换成新成绩。
- 相关回归141/141、生产与新增代码strict、架构/消息、Web构建、桌面运行检查通过。失败轮次、精确引用修复和验收脚本误报均如实保留在[105实施记录](./105-implement-Codex执行器与新闻核查闭环.md)。
- 本轮仍是提供材料核查；未接入联网检索，未新增桌面执行器切换入口。两次最终演示的自有进程已关闭，数据、摘要及截图保留；原5173服务未切换为演示实例。
