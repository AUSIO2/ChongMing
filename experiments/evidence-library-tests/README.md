# 证据库独立功能测试与压测用例

状态：**原114条业务用例保持；真实Mongo四操作对应的70条及HTTP专项8条通过。** 091/092另以真实关系与跨Map选材/使用专项验收后续已实现能力，结果见各阶段实施记录；原工厂剩余44条尚未全部映射，完整压测未执行。默认后端为mongo，SQLite库适配保留后续。本目录的工厂只映射真实身份、准备输入、转发生产服务和读取真实观测，没有证据库参考实现。实际结果见 [089](../../develop-docs/089-implement-Mongo证据库核心收录闭环.md)、[091](../../develop-docs/091-implement-证据库出处与上下游.md) 和 [092](../../develop-docs/092-implement-跨Map库引用与使用追溯.md)。需求见 [084计划](../../develop-docs/084-workspace证据库实现计划.md)，边界见 [086用例设计](../../develop-docs/086-证据库独立测试与压测用例.md)。

## 文件

| 文件 | 用途 |
| --- | --- |
| [functional.spec.ts](./functional.spec.ts) | 76 个基础业务及少量适配器集成用例 |
| [business-boundaries.spec.ts](./business-boundaries.spec.ts) | 38 个补充业务边界，覆盖正常匹配、范围、状态和清单成员 |
| [COVERAGE.md](./COVERAGE.md) | 需求对应、职责划分和仍需周边对接的边界 |
| [test-contract.ts](./test-contract.ts) | 真实目标的接入接口、输入输出和观测契约 |
| [mongo-target.ts](./mongo-target.ts) | 四个核心操作接入现有 Mongo 应用服务；未实现动作明确报错 |
| [core.config.ts](./core.config.ts) | 从原 114 条中筛选本阶段的 70 条，不修改原用例 |
| [core-http.spec.ts](./core-http.spec.ts) / core-http.config.ts | 真实 HTTP 到公共客户端的往返与响应边界专项 |
| [ui-fixture.ts](./ui-fixture.ts) / [ui-preview.ts](./ui-preview.ts) | 090 窗口状态及浏览器验收的真实临时 Mongo/HTTP，不计算库规则 |
| [relations.spec.ts](./relations.spec.ts) / [relations-fixture.ts](./relations-fixture.ts) / relations.config.ts | 091 真实固定出处、上下游、历史、边界和附件保护23例 |
| [relations-preview.ts](./relations-preview.ts) | 真实五节点六关系浏览器预览，退出清理临时认证与服务 |
| [usage.spec.ts](./usage.spec.ts) / [usage-fixture.ts](./usage-fixture.ts) / usage.config.ts | 092 真实Mongo/public+internal HTTP步骤冻结、授权及当前/历史使用28例 |
| [local-usage.spec.ts](./local-usage.spec.ts) / local-usage.config.ts | 无库适配的SQLite入口拒绝新增/改变非空引用，失败原子回滚3例 |
| [usage-preview.ts](./usage-preview.ts) | 真实跨Map核查产物及后续人工版本，供两处详情和原消费者正文验收 |
| [fixtures.ts](./fixtures.ts) | 构造明确输入、固定合成语料与引用，不计算业务结果 |
| [load-target.ts](./load-target.ts) | 加载真实工厂，检查接入能力并管理临时资源 |
| [scenarios.ts](./scenarios.ts) | 规模与六类业务负载扩展、组成和预设门槛 |
| [stress.spec.ts](./stress.spec.ts) | 注册每个后端 23 组独立业务压测组合 |
| [stress.ts](./stress.ts) | 未来运行时的限流、计时、正确性检查、报告和失败传播 |
| vitest.config.ts / stress.config.ts | 分别运行功能和压测，避免默认测试意外启动负载 |

## 功能覆盖

- 数字 0/1、保留错误陈述原文、非法置信度、空理由、仅人工依据、错误来源类型及过期版本。
- 固定内容不受来源编辑、节点/图删除、调用方改写对象影响；管理命令不能夹带固定字段更新；历史附件受到保护。
- 合法重放先于来源校验；请求参数冲突、含依据去重、并发唯一、不同范围/来源/依据及相反判断冲突。
- 撤回、替代、自替代/循环/跨工作区拒绝、管理版本冲突、viewer 权限与非成员隔离。
- Work 材料冻结、目标分支范围独立、未获权/错误摘要拒绝、撤回后的发布、使用重放和历史关系。
- 固定清单、显式历史回放、独立库包的附件闭包、摘要、身份重映射、导入幂等与原子失败。
- 0 筛选不被忽略、关键词分页完整性、游标绑定/过期、查询上限及真实索引观测。

错误码在用例中明确约定，不接受“随便抛错”代替所需错误。沿用当前 workspace 约定：有成员身份但权限不足返回 403/FORBIDDEN；有效系统身份但非成员返回 404/WORKSPACE_NOT_FOUND。fixtures.revoke 将 editor 从主 workspace 移除，保留有效系统身份。

本套范围已收窄为证据库新增行为。数据库引擎的事务/锁/持久化/崩溃恢复，以及 Host/Run 的租约、接管和暂停恢复，复用已有层及其测试；不再作为本套待补项。保留业务唯一键、事务组合与有界查询的少量适配器集成检查。手工图引用和组合包的真正对接仍在相应接口实现时验收，不用模拟实现填补。详见 [覆盖矩阵](./COVERAGE.md)。

新增 match 候选 scope.status 为 compatible/different/unknown，表达适用性，confidence 仍是库陈述本身的固定 0/1。该字段是本套明确的测试契约；接入层不得从理由字符串自行推断或替真实匹配服务计算。未来正式接口调整时同步更新契约和断言。

## 真实目标接入

`mongo-target.ts` 导出 `createEvidenceTestTarget(options)`，类型见 TargetFactory。通过 EVIDENCE_TEST_TARGET 显式选择该模块；未设置、导出错误、工厂失败或缺少接口均失败，不回退内存实现。四个核心操作已接入；其他动作明确报 NOT_IMPLEMENTED。核心配置只筛选当前阶段用例，原全量配置仍验收全部功能。

工厂建立两个隔离工作区和真实身份：owner 管理两者，editor/viewer 只属于主工作区，outsider 有有效系统身份但不属于任一工作区。主目标使用独立临时 Mongo 副本集；可选 SQLite 使用 options.directory；模块导入时不建立连接，工厂负责初始化，close 负责关闭所有连接/进程并响应取消。

接入层只负责真实身份映射、传输解包、准备数据、观测和清理。不得替目标校验 0/1、计算内容摘要、去重、冻结材料、维护历史、生成导入映射或伪造错误/指标。request 的 freeze/readFrozen/submitUse/endUse 是测试语义动作，应调用真实 Run/Work/图接口，不要求生产新增这些同名 HTTP 方法。读取冻结视图必须保留实际身份授权，不能借 Host 凭证绕过成员权限。

fixtures.createNode 每次在新 Map 创建节点，保证引用负载的目标分支独立；默认分配新 nodeId，传入 options.nodeId 时按指定身份创建，用于跨 Map 同名节点测试。fixtures.failNextCommit 在真实存储事务提交 seam 注入故障。inspect.counts 统计库条目、库收据、使用记录、快照及附件；不将普通图操作收据混入库收据。inspect.telemetry 的 queryObservation 来自最近一次 evidence.search 的真实查询计划，materializedRows 表示解码的完整库条目数。

## 合成语料与负载

seed 使用 fixtures.ts 的 seedItem：固定种子、数字 0/1 各半、每 hitEvery 条一条含 pressurehit（默认5），正文补齐为场景要求的字节数。预置通过真实业务接口或目标已有的验证过的批量导入完成；使用关系也必须实际持久化。expectedQueryIds 从已知输入标记和真实返回身份得到，不能用 search 结果反推。

SeedResult 必须返回实际条目引用、至少含 0/1 各一条的实际样本、完整查询预期及真实数量。每个压测组合建立新环境；预置和写入来源准备不计入正式延迟。每轮新增收录、使用和快照会使存量增长，报告保留初始及最终实际数量。

| 场景 | 库条目 | 使用关系 | 并发业务操作 |
| --- | ---: | ---: | --- |
| small | 1,000 | 10,000 | 1 / 4 / 8 / 16 / 32 |
| medium | 10,000 | 50,000 | 同上 |
| large | 50,000 | 200,000 | 同上 |
| hotspot | 10,000 | 50,000 | 8 / 32；读取/引用集中于8条记录 |
| large-text | 10,000 | 50,000 | 1 / 8；正文8KiB |
| zero-hit | 10,000 | 50,000 | 8；测量搜索无命中 |
| high-hit | 10,000 | 50,000 | 8；全部预置条目含查询词 |
| first-use | 10,000 | 50,000 | 1；没有额外预热，不清空底层缓存 |
| soak | 10,000 | 50,000 | 8；10轮，每轮10,000业务操作 |

这些是库记录和使用关系，不是 workspace 全类型节点数。基础配置每组合预热 100 次，正式 3 轮、每轮 1,000 次；first-use/soak 使用表中覆盖；组成是搜索40%、读取30%、收录10%、引用15%、快照5%。基础搜索请求有命中，命中文档占预置语料20%；zero-hit/high-hit 改变命中分布。引用延迟包括 freeze 和 submitUse 的完整闭环；来源节点在计时外准备。

限流为每秒最多 200 个逻辑业务操作，不宣称是 SQL/HTTP QPS。报告另计暖机和测量操作调用的测试协议尝试数；一次协议动作可能映射多个底层请求。并发表示在途业务操作数，目标的 single-owner/pooled/remote 模型原样报告。

门槛是首次测量前的工程目标，可在 scenarios.ts 显式修订：零失败/超时/未完成、至少10成功操作/秒；p95 上限分别为搜索250ms、读取100ms、收录300ms、引用500ms、快照500ms，p99 见配置。驱动 RSS 上限512MiB、阶段边界采样目标 RSS 上限1GiB。

报告保留每轮每种操作的成功/失败/超时、错误分类、原始延迟及 p50/p95/p99；失败延迟也参与分位数。吞吐包含限流等待，操作延迟从放行后计时。内存是完成操作时的驱动采样与轮边界目标采样，不代表瞬时峰值。存储/目标内存/查询观测不可用时明确失败，不填0或算通过。

每轮停止新增请求后结算工作者；未实际结束的调用单独计数。超时通知取消，但不能把取消通知当成实际结束；适配模块必须响应 AbortSignal 并关闭资源。清理失败保留为失败。测量后还检查固定内容、完整命中、幂等、workspace 隔离、获权集合及撤回/历史回放。

## 核心执行命令

以下命令使用临时真实 Mongo 副本集，无需部署数据库或 RabbitMQ。首轮核心结果为 70 通过、44 未选择；这些未选择用例仍由全量配置验收。

~~~sh
EVIDENCE_TEST_TARGET=experiments/evidence-library-tests/mongo-target.ts \
  node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/core.config.ts
node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/core-http.config.ts
~~~

当前冻结依据包含显式node/asset/library引用和节点直接资产引用；091增加固定有界关系及资产保护，092增加按步骤材料冻结与使用历史。原核心工厂仅支持`seed({ usages: 0 })`，关系与使用另走上述真实专项；固定证据集及完整导入导出继续后续。

091 在上述核心上冻结有限真实关系邻域及其节点直接资产。新关系专项23例、界面/客户端合并99例和原核心70例实跑通过，见 [091 实施记录](../../develop-docs/091-implement-证据库出处与上下游.md)。关系不是 Work 使用记录，完整压力仍未运行。运行 `node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/relations.config.ts` 验证独立关系；`node --import tsx experiments/evidence-library-tests/relations-preview.ts` 仅创建临时真实验收环境。

090 界面相关专项位于 tests/client/evidence-*.spec.ts；组合现有布局、公共 client 和来源阅读回归共 67 条通过，见 [090 实施记录](../../develop-docs/090-implement-Map式证据库界面.md)。可用 `node --import tsx experiments/evidence-library-tests/ui-preview.ts` 启动临时 Mongo/HTTP；输出只含服务地址和受限令牌文件路径，退出时清理。本夹具没有 RabbitMQ，库可直接操作，普通 Map 实时流须由实际消息部署提供。

## 后续全量执行命令

以下仅供余下真实实现接入之后使用；本轮没有执行全量功能或压测命令，也没有生成压力 results。

~~~sh
# 工厂路径可以是绝对路径或相对仓库根目录的路径。
export EVIDENCE_TEST_TARGET=/absolute/path/to/real-evidence-test-adapter.ts
export EVIDENCE_TEST_BACKEND=mongo
node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/vitest.config.ts

# 单档、单并发先运行；不设置两个筛选变量时为当前后端的全部23组。
EVIDENCE_STRESS_SCENARIO=small EVIDENCE_STRESS_CONCURRENCY=1 \
  node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/stress.config.ts

# 可选 SQLite 在其实际适配完成后才运行，不是本阶段交付前置。
EVIDENCE_TEST_BACKEND=sqlite \
  node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/vitest.config.ts
~~~

未来压力报告写入 results/，可用 EVIDENCE_STRESS_REPORT_DIR 指定位置；每次使用独立文件名。results 已忽略。独立套件的 TypeScript 静态检查：

~~~sh
node_modules/.bin/tsc --noEmit -p experiments/evidence-library-tests/tsconfig.json
~~~
