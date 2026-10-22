# 092 跨 Map 库引用与使用追溯实施记录

日期：2026-10-07。状态：本轮显式跨Map核查与使用追溯闭环完成。设计见 [092原稿](./092-跨Map库引用与使用追溯.md)。

先写用例并审阅，之后逐模块接入。工作区已有并行未提交修改，保留既有文件；未发布新版，不触碰083默认资源恢复问题或用户不可变定义/数据。

## 已实现行为

运行表单可检索并显式选择库条目，将refs绑定到实际步骤。新Run启动在既有editor授权事务中读取active条目，保存原陈述、数字0/1、范围、理由/依据、精确定义及完整snapshotDigest；每步最多32份/1MiB，整个Run最多4MiB。来源ID不进入目标图nodes/input/context或扩大分支。ExecutionSpec只保存身份/摘要与定义依赖，完整正文每步在Run保存一次。合法启动重放不重新查当前来源或active状态。

Work只得到所属步骤集合，原节点payload沿其冻结definition.agentProjection投影。DSH只读库材料进入用户上下文，系统persona继续使用原模板及原变量。data_propose允许产物明确声明entryId/contentDigest/非空使用理由；候选接纳、正式发布和使用登记都核对所属Operation与Run获权集合。Opinion仍按原已发布payload schema校验，原意见0.5不被库的固定0/1覆盖。冻结后撤回不阻止旧Work发布，新选择会拒绝。

application在真实Graph CAS成功后、外层事务提交前同步evidence_uses；任何错误连同图与收据回滚。正式消费者版本变化/移除或图删除结束当前使用，保留原消费者全文和运行上下文；同一收据重放不重复登记，同一产物复用到新Run会登记新的Run/Operation上下文。人工省略引用字段保留既有引用，显式[]结束；新增/替换要求active，已撤回材料的原引用可继续保留。

evidence.uses与evidence.use.get支持viewer授权、独立使用目录版本、原生Mongo索引过滤/摘要投影/游标及原消费者详情；默认25/上限100，游标绑定workspace、entry与历史筛选。两处库详情均展示当前/历史使用和原消费者正文；只有当前可见模式活动，固定邻域材料没有独立使用目录。身份、工作区、根选择和使用选择变更取消旧读取并使旧导航过期；定位按钮明确打开消费者当前版本。

## 联调审阅修补

1. 无库适配的SQLite入口曾允许graph.apply新增非空引用但不校验条目。先行真实SQLite/HTTP用例首跑2失败/1通过；补同事务提交防护后3/3。无库时新增/改变非空引用返回503 EVIDENCE_UNAVAILABLE，普通编辑、保留历史引用或显式清除仍可用。
2. 新增真实HTTP两个独立步骤分别选甲/乙：每份Work只读本步骤材料，引用对方拒绝，分别合法发布后Run完成及使用记录正确。该例成为专项第28例。
3. 原stored校验只能核对声明的库contentDigest，Run全文正文或0↔1单字段损坏仍能保留旧ref/specHash。先行两例均复现失败；补完整snapshotDigest重算、规格librarySnapshotDigests逐项绑定并参加specHash后通过。投影材料保留完整快照摘要标签，不以投影后的内容重算完整摘要。
4. 现有v4导出会携带libraryClaimRefs，但导入白名单不认识，可能产生无法恢复的包。新codec用例首跑2失败/1通过；修复后新3例及原bundle-v4 4例共7/7。非空引用导出明确422 EVIDENCE_EXCHANGE_UNSUPPORTED并给出中文说明；省略/空引用照常导出，空字段不进入v4投影，原图不变。完整库交换仍留后续。

## 实际验证

| 验证 | 本轮结果 |
| --- | --- |
| usage.config.ts：真实Mongo/public+internal HTTP | 最终28/28通过，15.29s；含步骤隔离、撤回/来源删除后发布、重放、复用上下文、人工引用、权限、分页与预算回滚 |
| local-usage.config.ts：无库SQLite入口 | 3/3通过，0.90s |
| relations.config.ts：原固定关系/历史回归 | 最终23/23通过，8.17s |
| core.config.ts：原核心业务 | 70通过/44跳过，共114，179.46s；原工厂尚未映射其余能力，不删除原用例 |
| core-http.config.ts：原核心HTTP | 8/8通过，3.11s |
| UI/Graph/spec/DSH/导出相关回归 | 最终批次17文件148/148通过，8.24s；含真实UI HTTP与请求取消/身份/分页/响应校验 |
| Graph/spec完整材料损坏与跨层绑定 | 最终23/23通过（Graph18/shared spec3/commit2）；局部重新计算Frozen摘要但旧规格不变、规格重新计算hash但Run原摘要不变，两种自洽篡改均拒绝 |
| 类型与边界 | 全量vue-tsc；client evidence/evidence-uses、backend library、experiments四个专项strict tsc通过；架构/消息及git diff --check通过 |

先写usage、Graph/spec/commit、DSH、picker及使用状态/客户端用例，再接生产。首轮实际失败与处理：

- 27个HTTP最初均在beforeEach被测试转换的1:N与output max=1矛盾挡住，未到业务；修正临时包为1:1后25通过。余2预算例单条正文225,000/200,000B超过089的65,536B上限，改为合法单条（22×50,000B单步；14×50,000B×6步整Run），保持1MiB/4MiB拒绝及回滚断言后27/27，再补步骤隔离后最终28/28。未放宽生产边界。
- DSH首轮8失败/5通过：SDK不支持maxItems/minLength/maxLength DSL，改用其支持的schema描述与真实execute入口数量/长度校验。未知字段由SDK先拒绝，测试匹配真实拒绝边界；最终13/13，另外11个执行/并发回归通过。不修改默认提示词或Agent包。
- 核心70首个调用遗漏EVIDENCE_TEST_TARGET，环境装配全部失败；补显式真实mongo-target后70通过。不是改业务断言。
- 原generic-run 6例中5通过/1失败：旧用例要求evidenceClaimIds，而默认文件恢复后实际Opinion仍要求evidenceIds。按用户决定保留默认文件和原用例；本轮临时定义使用实际schema。未将此结果记为全库通过。

最后补充的两项跨层摘要用例在已有保护上一次通过，没有再修改生产：完整材料局部重新计算snapshotDigest仍须匹配Operation对应标签；Operation局部替换标签并重算specHash仍须匹配Run冻结材料。17文件148批次之后专项Graph/spec/commit23例及其严格类型再次通过，不将重叠用例数量累加。

主要复现入口：

```sh
npx vitest run --config experiments/evidence-library-tests/usage.config.ts
npx vitest run --config experiments/evidence-library-tests/local-usage.config.ts
npx vitest run --config experiments/evidence-library-tests/relations.config.ts
EVIDENCE_TEST_TARGET=experiments/evidence-library-tests/mongo-target.ts \
  node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/core.config.ts
npx vitest run --config experiments/evidence-library-tests/core-http.config.ts
npx vue-tsc --noEmit
npx tsc --noEmit -p tests/client/tsconfig.evidence.json
npx tsc --noEmit -p tests/client/tsconfig.evidence-uses.json
npx tsc --noEmit -p tests/backend/tsconfig.library.json
npx tsc --noEmit -p experiments/evidence-library-tests/tsconfig.json
npm run test:boundaries
git diff --check
```

## 浏览器及资源清理

新增usage-preview.ts，真实Mongo/公开及内部HTTP先发布跨MapOpinion0.5，再人工编辑为版本1/score1，形成一条当前引用和一条已结束Work使用。浏览器在库图旁栏及固定单页均读到真实记录；历史正文明确显示原版本0/score0.5，点击当前消费者定位后显示版本1/score1与版本说明。截图：[使用追溯验收](../.data/evidence-usage-ui.jpg)。

预览首次人工编辑用0.75被实际Opinion枚举拒绝，改用合法score1；不是放宽生产schema。临时服务/标签及认证目录已关闭/移除，端口不再监听。进程组SIGINT结束时mongod先停，memory-server清理曾输出ECONNREFUSED诊断，但预览退出0且认证文件/服务端口实际清除。

本轮未配置RabbitMQ或外部模型，真实浏览器验证的是库详情和消费者定位；Run表单picker通过状态用例及Vue编译，未记为浏览器全链启动或真实模型核查。完整23组压力、证据集历史回放、替代、导入导出、SQLite库适配与桌面打包未执行，未发布新版。
