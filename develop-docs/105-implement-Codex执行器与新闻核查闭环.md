# 105 实施 — Codex exec执行器与新闻核查闭环

2026-10-20用户授权先补测试、再实现，保持简单；2026-10-21已通过真实验收并完成持续goal。设计见[105计划](./105-Codex执行器与新闻核查闭环.md)。原608文件可恢复基线在 `test-results/105-codex-exec-baseline-689056003000`，原5173预览/用户数据/既有dirty保持；未提交/推送。

## 初始核对

- 本机CLI 0.162.0-alpha.17.2，ChatGPT已登录；仅检查状态和model/provider白名单，未读认证文件或输出凭据。
- Host已有runner注入，claim/renew/取消和接受确认可复用；现有默认模型是DeepSeek，必须显式Codex初始化配置，不能把旧执行标签当新执行事实。
- 现有真实Host测试是分段且使用确定性模拟模型，未拿它冒称真实Codex整链。
- 本版tools=[]，读取和提交由宿主完成，外部检索未接入。提供参考材料的核查与在线取证明确区分。

## 分工和顺序

根先验证既有DSH/Host绿对照并提取共用work API；Codex执行器和新确定性测试独占同目录/对应测试；装配与部署参数独占apps执行Host/local入口及对应测试；真实模型/普通页面验收另用显式脚本，不进默认矩阵。测试红灯与后验、外部模型调用和最终回归分别记录，待执行项不提前标绿。


## 既有对照、确定性适配与真实访问

- 原DSH/Host/prompt/local runtime：4文件31/31，8.50秒；提取共用work-api后仍31/31，8.30秒。共享WorkAccessError和获权读取身份/状态检查不变，无旧helper转发。
- Codex新增7组展开15项先API导入前置红（0业务例），实现后15/15；追加安全started/accepted和父环境canary先5红，再16/16，连原DSH/prompt30/30，6.92秒、strict绿。fake CLI只算确定性协议/生命周期测试，不冒称真实模型。
- 入口先行12项8红4绿：显式codex原被忽略、非法executor原仍建立资源，两个CLI新参数未识别；新增onEvent透传又先1红12绿。实现后连原runtime共17/17（0.828秒）、strict/vue-tsc绿。runtime-lifecycle测试仅补Reporter类型以纳入strict，未删断言。
- 一次独立真实CLI readiness：安装CLI0.162.0-alpha.17.2、gpt-6-astra/openai、ChatGPT登录缓存；完整只读/禁工具/JSON Schema参数exit0，ready=true，usage input14208/output15。仅固定小请求，不算业务闭环。

## 单事实真实首轮与定位（尚未完成闭环）

先通过页面创建NASA韦布发射参考资料News和单Claim，明确提供材料/未在线取证边界，正式定义与provider/model冻结。首轮 `test-results/105-codex-live-claim-w99lI0`：route和assess真实Codex/服务accepted都到达，merge失败；未自动重试、未回填虚构结论。原运行错误是Host旧通用文案，初始live诊断未保留cause细节。

仅增强显式live脚本的私有0600诊断，复用既有diagnosticReadLine去首行/脱敏栈和大写API错误码，不记录凭据/原CLI内容。第二轮 `test-results/105-codex-live-claim-ocrz4C`：route/assess再次真实accepted，merge在data/propose被拒，code=INVALID_OUTPUT；排除CLI连接/最终外壳解析失败。尚无具体被拒提案，暂不猜修或放宽后端。将通过live脚本透明只读观察真实非2xx请求取得精确格式，再先补稳定后端用例修根因。以上原始失败轮次保留，不能记作单事实或完整链已成功。

参考资料来源：[NASA Webb Launch](https://science.nasa.gov/mission/webb/launch/)。演示中文概述只取2021-12-25、阿丽亚娜5号与库鲁三项有限事实；页面说明由宿主提供，不声称Codex访问网页。

## 2026-10-21：真实拒绝提案、测试与修正

第三轮 `test-results/105-codex-live-claim-igaHCF` 通过显式演示脚本的透明只读fetch观察器保留非2xx提案。观察器原样透传请求和响应，只留白名单业务字段及错误码，不记录请求头、令牌或原CLI输出；文件权限0600。仍是route/assess通过、merge失败，没有人为发布产物。

精确原因有两项：结论的 `sourceKeys` 使用了原Claim输入键，而冻结定义要求以核查意见作为后继来源；`opinionIds` 使用了前阶段尚未发布的预留UUID，而当前模式要求 `{candidate:{workId,key}}`。先在既有generic-run真实合同测试中加入这两个拒绝分支及合法候选闭合断言，原后端正确拒绝/接纳，后端实现不变。再为现有导出的Codex提示函数补精确来源指导测试，先出现有效红灯；实现后Codex/generic-run/prompt合计63/63，strict通过。

修正局限于模型可见协议：`codexReadOutputGuide` 从冻结 `successorOf` 和引用定义推导本阶段可用来源键及候选对象，`codexReadPrompt` 将当前执行规则放在既有persona之后。模型仍自己生成提案，宿主没有自动改写其payload、来源或引用，服务端合同校验不放宽。

另将11份既有Agent提示的 `content` 更新到当前plan/outputs/selection协议，去除旧reportIds/merge提交格式；逐字段确认id、promptVars、tools、provider、model及其它元数据保持，configuration.json保持。改前及改后prompt/seed/definition测试均35/35，12份JSON可解析。只影响新建冻结规格，不篡改前三轮已有Run。

## 最终文件与函数

| 文件 | 职责及主要入口 |
| --- | --- |
| `backend/execution/work-api.ts` | `workReadReply`、`workReadStatus`、`workReadData`、`workReadProfile`；两种执行器共用获权读取、提交与原有网络错误分类。 |
| `backend/execution/dsh/work-executor.ts` | 使用提取的公共函数，保留原DSH行为。 |
| `backend/execution/codex/work-executor.ts` | `codexRunWork` 负责原Work接受状态与提案提交；私有 `runCli` 负责独立进程、stdin、结构化输出、实际close和取消。 |
| `backend/execution/codex/proposal.ts` | `codexReadProposal` 严格挑选模式外壳字段；`codexReadPrompt`、`codexReadOutputGuide` 渲染获权材料和精确引用指导。 |
| `apps/local-server/runtime.ts` | `localCreateRuntime` 通过既有runner入口选择执行器，默认DSH，非法配置在分配资源前拒绝。 |
| `apps/execution-host/main.ts`、`apps/local-server/main.ts` | 解析 `--executor dsh\|codex`、`--codex-bin` 及对应环境变量；命令行优先。 |
| `contracts/messages.ts` | 显式执行器参数错误枚举。 |
| `resources/prompts/{parse,split,verify}/…` | 11份既有Agent提示正文对齐现行阶段协议，配置身份和工具不变。 |
| `tests/backend/execution/codex.spec.ts`、`tests/backend/fixtures/codex-cli.mjs` | 明确标记的fake子进程协议/取消/提交确认测试，不计真实模型成功。 |
| `tests/apps/local-server/executor-selection.spec.ts` | 默认/显式选择、非法参数、入口参数优先级与事件透传。 |
| `tests/backend/modules/graph/generic-run.spec.ts` | 在正式核查合同中验证两类真实错误及合法候选发布。 |
| `tests/experiments/codex-live.ts` | `liveCreateSeed`、`liveConfigureRun`、`liveVerifyResults` 等；显式隔离真实验收，不加入默认测试矩阵。 |

实际启动参数示例：`npm run local:serve -- --directory <独立目录> --executor codex --codex-bin <CLI绝对路径>`；冻结Agent须声明provider=openai、明确模型并且tools=[]。这只是执行器选择，不自动修改用户工作区的Agent配置。

## 确定性最终回归及演示脚本误报

2026-10-21：相关10文件141/141，13.88秒（`final-targeted-tests.log`）；生产vue-tsc、新增/改动Node测试和真实脚本独立strict、架构与硬编码消息检查均通过；Web生产构建通过。`npm run test:desktop-runtime` 重新准备并验证随包Node/SQLite/默认DSH、原有重启/父进程断连行为通过。这里没有新增M00扩展测试，也没有新增桌面执行器切换功能；桌面内置服务仍默认DSH，CLI/编程入口可显式选Codex。构建有原有Vite CJS及包体提示，不是测试失败。

第四轮单事实 `test-results/105-codex-live-claim-SYBGqx` 实际Run completed，3项真实CLI工作全部后端accepted，意见/结论及Claim→Opinion→Verification两条结构边已落库；最后的独立核对脚本误报OUTPUT_MISMATCH。只读定位为脚本用JSON.stringify比较原输入：运行启动时既有graphParseNodes重排对象键，但字段和正文未变。先做小型红/绿对照（`live-node-comparison-red-green.json`）：旧比较仅换序即误报，新node:util.isDeepStrictEqual通过换序且仍拒真实正文改动。仅修脚本比较并补固定调用位置，不改产品或原第四轮failed摘要；重新从正常页面创建单事实做最终验收。

基线608文件逐项核对保存于 `scope-readback.json`：本轮未改前端、Host生命周期、图模块实现、package.json或package-lock.json；原有dirty工作保留。本轮变化以105基线为准，不能将git HEAD全部差异计为本轮。没有新运行依赖，没有提交/推送。

## 最终真实验收通过

两轮均通过正式前端的添加数据/运行转换表单启动，未注入Vue状态、未用API代写运行或产物。每个工作都对应一次真实spawn、CLI thread及原后端accepted确认；独立公共API核对冻结模型/工具、producer、候选发布闭合、正式opinionIds和结构边。CLI为本机0.162.0-alpha.17.2，模型gpt-6-astra，provider=openai。

| 最终轮次 | 实际结果与证据 |
| --- | --- |
| 单事实，第5轮 | `test-results/105-codex-live-claim-FY2qu4`；Run `0a270b23-382c-4d60-80b6-6d137aa0b77f`；route/assess/merge 3工作accepted，1 Opinion、1 Verification、2 successor边；完整核对通过，进程exit0，自有资源关闭。 |
| 新闻，第1轮 | `test-results/105-codex-live-news-Ts7OdB`；Run `66b7bc14-d93b-48c0-9779-c1b0e365a60e`；split-news→verify-claim两步、2 Operation、6工作accepted；1正式Claim、1 Opinion、1 Verification及3 successor边；后步group.inputRefs恰为前步claims正式outputRefs；完整核对通过、exit0，自有资源关闭。 |

最终每轮目录保留0600的 `summary.json`、`diagnostics.json`、`configured-plan.png`、`saved-results.png` 和隔离SQLite。上海时间2026-10-21 00:18:41单事实完成、00:20:57新闻链完成；两轮 `workFailures=[]`，无cleanup失败。根已查看两张实际完成截图，页面显示处理完成及新闻的2/2步骤完成。没有因比较器修复而覆盖第4轮原failed摘要。

演示范围：只启用单个数据事实拆分角度和单个无工具资料核查角度；新闻实际提取了日期事实，火箭型号留在原新闻/背景材料中，因此不把本轮称作全文穷尽拆分。评分和理由由真实模型生成；结论明确注明基于提供材料、未在线取证，不宣称独立验证NASA网页。多角度覆盖、联网检索、桌面执行器切换按后续实际需要另定范围。

## 用户校正：补足分叉验收（已通过）

用户指出期望树状结构后，只读核对前轮最终SQLite：确有4节点3边，但仅一条News→Claim→Opinion→Verification路径。根因是显式演示只保留split-data和provided-materials各一个候选、maxSlots=1；真实路由只覆盖日期，火箭型号未提取。验收只要求Claim/Opinion数量大于零，未验证分叉；图相机又在首次扩展后保持旧范围，因此截图只显示第一条边。此前“完成”仅成立于所述单路径范围，本轮补足用户期望，旧摘要不改写。

2026-10-21用户授权继续。实施前617文件可恢复基线 `test-results/105-branching-baseline-1792555998`。分工：正式后端多事实/多意见合同测试；演示配置/分叉验收先行测试；真实浏览器新增后继取景测试后修GraphScene；根负责材料、集成、真实模型与数据库核对。保留原DSH、Host、提案权威校验，不新增检索工具，不提交/推送。

### 补充分叉的先行证据

- 演示验收的有效红：新增小型 `codex-live-branching` 纯函数先保留原“大于零”语义，使用前轮单链公开结构验证“应拒绝”时实际失败，`branching-validator-red.log`。这不是模块缺失或环境准备失败；随后再加强本演示至少两Claim、每Claim至少两种核查角度、意见真实被引用和完整关系闭合。该限制仅用于树状样例，不强制普通Run制造多条事实。
- 取景原U02/U03先2/2绿。新增U11先缩放，再检查选择/纯活动/正文替换保持投影，最后同sceneKey从2节点扩到4节点。旧实现统计已4节点3线却仅2个可见标签，真实WebGL在line84得到Expected4/Received2，`camera-red-diagnostic.log`。修复只调整 `GraphScene.vue/rebuildScene` 的节点增长条件，任意新增节点重新适应；没有改关系或引入相机框架。
- 修后local U02/U03/U11 3/3通过，4.468秒，U11本身1.748秒；标签全部在真实容器范围内，未手点适应；生产与浏览器测试类型检查通过。日志 `camera-green.log`、`camera-test-types.log`、`camera-ui-types.log`。

演示材料仍使用此前两句新闻，NASA原页面的Launch Date/Vehicle/Location（本次重新只读核对318/321/324行）支持日期和火箭型号，不为增加分支另编事实。通用原文拆分角色覆盖独立陈述，两种无工具核查职责分别核对材料一致性和逻辑/语境限定；最终结论引用实际两种意见，保持未在线取证边界。默认定义和用户工作区的Agent配置不改。

### 补充实现与确定性结果

- 正式后端合同新增一条两步Run：1 News拆2 Claim，每条各sources/logic两意见，再各自一个结论，共3 Operation、9正式节点、10 successor。精确验证所有producer、outputRefs、opinionIds、引用索引与完整边集合，防止分支串线。原44/44、加入后45/45及strict通过；后端实现保持。首次新测试误把既有schema声明的`/opinionIds/*`索引当成数组下标路径，修正测试预期后绿，属于夹具预期错误，不记为产品缺陷修复。
- 新增 `tests/experiments/codex-live-branching.ts` 和同名spec，只供显式news演示调用，4项先红后绿；旧单链拒绝、两事实/双角度闭合接受、缺边/重复角度拒绝、重复消费/跨事实意见拒绝。固定错误类别进入安全摘要，不输出任意模型正文。夹具数据是合成结构，不计真实模型成功。
- `liveCreateSeed` 只修改新建隔离演示的配置：通用原文事实拆分、材料一致性和逻辑语境两个核查角色、maxSlots=2；路由和汇总的显式任务要求覆盖两种职责，并引用实际使用的意见。没有改默认提示资源、普通Run合同或用户现存Agent。
- 真实脚本在独立API验收后，还等待全部保存节点的公开标签可见且完整落在视窗，再截图，未手动点击适应。该纯检查没有给前端添加测试入口。
- 本轮相关11文件146/146，16.50秒；既有M00-A02视角往返、M10-C21活动显示local 2/2，7.472秒；生产类型、浏览器测试类型、显式脚本/helper/spec的strict、架构/消息、Web生产构建及差异检查均通过。日志均在补充617基线目录。未重复全仓矩阵或M00暂缓扩展。

### 真实分叉最终结果

全新目录 `test-results/105-codex-live-news-biHG8v`，从正常页面创建并确认两步Run，真实运行一次通过：

- Map `0ba1423a-0f3b-4fa8-a2b1-884ec662d367`，Run `651b76aa-4fc4-4481-88bf-e6ecd9a68096`；2026-10-21上海时间12:24:28完成。
- 正式1 News、2 Claim、4 Opinion、2 Verification，共9节点、10条successor；3 Operation、11个独立Codex工作均accepted，逐项关联其started/accepted和CLI thread来源。
- 原新闻两项陈述分别是发射日期和火箭型号，真实模型分别形成独立Claim，没有从参考资料补发射地点。每条Claim各有“提供材料一致性”和“逻辑与语境限定审查”两种独立Work生成的意见，结论分别引用本分支两种意见，未串线。结论理由说明两种意见的作用，仍区分提供材料支持与独立在线证实。
- 独立公共API完成后，全部9个公开节点标签自动进入视窗且完整可见，未点击适应、未注入相机状态。根查看 `saved-results.png` 确认两事实分支、四意见和两结论都在场景中，右侧显示2/2步骤、3/3处理项完成。
- 脚本exit0、自有Host/API/Vite/browser均关闭，`workFailures=[]`，没有cleanup失败。关闭后再以只读SQLite按精确Map ID读取，得到同样9节点10边；安全业务核对保存于0600的 `database-readback.json`。未改用户库或终止其它服务，以前单链/失败轮记录保持。

本补充相对617基线：生产只改 `GraphScene.vue` 新增节点时适应条件；其余是正式合同测试、浏览器夹具/测试、显式演示配置与分叉验收器，以及本号文档。后端实现、Codex执行器、默认资源、依赖和counter均保持；未提交/推送。准确范围及最终源码摘要见补充基线目录 `scope-readback.json` / `final-source-manifest.json`。
