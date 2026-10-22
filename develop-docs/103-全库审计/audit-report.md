# 103 — 全库防御逻辑覆盖审计报告

本轮完成固定工作区快照的只读审计：**301 个 TS/JS/Vue 文件、2107 个文件×类别记录**，另固定 56 个配置/资源/说明文件的哈希用于核对合同。受审源码、测试及上下文文件均未变化，没有新增范围外源码。

归并后确证 **50 个主题**：42 个涉及运行代码，8 个仅涉及测试/实验/构建验证。按性质为 14 组行为缺陷、18 组重复或无效逻辑、18 处低影响小项。原始 60 条分区记录中，同一根因的多处位置已合并；这些数不是“新增问题数”或可直接删掉的条件数。

涉及运行代码的 42 个主题中，11 组影响行为、17 组是重复/无效逻辑、14 处是低影响整理。余下工具主题单独标注，未混算成生产缺陷。

**本轮没有修复实现。** 行为缺陷含“缺少真正必要边界”的情况，不能把它们当作删除校验任务。小项是可读性/维护机会，收益与行为缺陷分开。

## 优先处理的行为风险

- 合法原型同名键在 JSON、投影、表单、端口与工具统计中读写失配；已有隔离复现观察到数据丢失和进程内原型字段被写入。
- 合法 A 工作授权搭配 B Operation 身份时，在最终拒绝前已经读取并缓存了 B 的外部来源。
- 输入 JSON 的非法 UTF-8 被替换后继续处理；Host 初领部分标识允许数字进入 runner；Map 响应缺少实际 reader 必需的边日期仍获接纳。
- 混合 JSON 枚举经字符串化选择错值；切换 Run 后迟到控制权仍获接纳续租；拖动期间卸载后仍处理事件直到鼠标松开。
- 次生清理覆盖主错分布于 SSE、启动入口及验证工具；资源取得后清理责任建立过晚的问题单列。

## 范围、方法和完成含义

文件组成：154 个运行端源码/声明文件、9 个根构建配置/验证脚本、112 个测试文件、26 个实验文件。第三方依赖、生成产物、用户数据库与历史开发文档不作为当前实现审计范围；个别已安装库函数仅用于验证调用假设。

F=默认值/强转；E=异常与清理；V=校验归属；S=状态不变量/死分支/兼容；P=重复解析/遍历/读取；K=字典自有键/指针；L=生命周期/身份代次。逐文件记录包含实际依据；没有相关运行逻辑的类别可以明确不适用。

通用 AST 索引有 26053 个表达式候选，仅作导航；8 条高信号规则的 214 个候选已逐条归类：44 个位置归入确证主题，168 个保留，2 个证据不足。位置数不等于独立问题数，也不证明所有表达式已自动判定。Vue 模板、调用链及嵌入测试代码仍由人工阅读补齐。

覆盖闭环表示：固定文件清单及七类记录齐全、已知清单逐项对账、同类横扫、确证主题有来源与证据、必要保留及证据不足单独记录、交叉复查、最终源码哈希一致。**不宣称证明全库从此没有任何遗漏。**

## 模块×类别覆盖

单元格为“已审阅／不适用”文件数；不表示测试通过数或缺陷数。每文件实际依据见 [coverage.json](./coverage.json) 及相应 scope 记录。

| 模块 | 文件数 | F | E | V | S | P | K | L |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| apps 其他入口/配置 | 19 | 16/3 | 14/5 | 11/8 | 14/5 | 11/8 | 9/10 | 14/5 |
| apps/ui | 60 | 54/6 | 40/20 | 56/4 | 58/2 | 54/6 | 54/6 | 47/13 |
| backend/adapters | 15 | 15/0 | 14/1 | 13/2 | 15/0 | 12/3 | 11/4 | 15/0 |
| backend/application | 1 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 |
| backend/execution | 6 | 6/0 | 6/0 | 6/0 | 6/0 | 4/2 | 2/4 | 5/1 |
| backend/modules/assets | 2 | 2/0 | 2/0 | 2/0 | 2/0 | 2/0 | 2/0 | 1/1 |
| backend/modules/evidence-library | 7 | 7/0 | 7/0 | 7/0 | 7/0 | 7/0 | 7/0 | 7/0 |
| backend/modules/graph | 9 | 9/0 | 9/0 | 9/0 | 9/0 | 9/0 | 9/0 | 6/3 |
| backend/modules/identity | 1 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 |
| backend/modules/shared | 5 | 5/0 | 5/0 | 5/0 | 5/0 | 5/0 | 5/0 | 5/0 |
| backend/modules/workspace | 4 | 4/0 | 4/0 | 4/0 | 4/0 | 4/0 | 4/0 | 1/3 |
| backend/ports | 5 | 5/0 | 5/0 | 5/0 | 5/0 | 5/0 | 5/0 | 5/0 |
| client | 1 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 | 1/0 |
| contracts | 17 | 17/0 | 17/0 | 17/0 | 17/0 | 17/0 | 17/0 | 17/0 |
| experiments | 26 | 26/0 | 18/8 | 26/0 | 26/0 | 18/8 | 18/8 | 25/1 |
| platform | 2 | 2/0 | 2/0 | 1/1 | 2/0 | 1/1 | 1/1 | 2/0 |
| scripts / 根构建验证配置 | 9 | 9/0 | 9/0 | 9/0 | 9/0 | 9/0 | 9/0 | 9/0 |
| tests | 112 | 100/12 | 103/9 | 95/17 | 108/4 | 98/14 | 93/19 | 89/23 |

## 确证主题索引

| ID | 性质 | 范围 | 主题 |
|---|---|---|---|
| [G01](#g01) | 行为缺陷 | 运行代码／实验工具 | 动态字典没有按自有字段读写，导致合法同名键丢失、类型失配或原型污染 |
| [G02](#g02) | 行为缺陷 | 构建/验证／测试／运行代码／实验工具 | 次生清理失败覆盖主错误；部分路径还跳过后续清理 |
| [G03](#g03) | 行为缺陷 | 测试／实验工具 | 取得资源后初始化清理责任建立过晚，中途失败遗留自有资源 |
| [G04](#g04) | 低影响小项 | 测试／实验工具 | 私有分位数 helper 在已保证非空/有效分位的分支保留不可达回落 |
| [G05](#g05) | 行为缺陷 | 测试 | 恢复夹具误把Vite port:0当随机口，实际回退固定5173且strictPort失败 |
| [G06](#g06) | 重复/无效逻辑 | 运行代码 | asset.delete对每张图重编同一事务目录 |
| [G07](#g07) | 重复/无效逻辑 | 运行代码 | 同次自动发布重复完整解析候选及双扫描candidate哨兵 |
| [G08](#g08) | 行为缺陷 | 运行代码 | 已展开引用未保留具体path，通配资产媒体约束被省略 |
| [G09](#g09) | 低影响小项 | 运行代码 | 确定rest形状又做通用对象白名单检查 |
| [G10](#g10) | 行为缺陷 | 运行代码 | data_read未先绑定Operation，拒绝前已读取并提交另一Operation外部来源 |
| [G11](#g11) | 重复/无效逻辑 | 运行代码 | 内嵌附件丢弃已验bytes后再解码和完整哈希 |
| [G12](#g12) | 低影响小项 | 运行代码 | graphSameRoots每个元素重新排序同一right集合 |
| [G13](#g13) | 重复/无效逻辑 | 运行代码 | pause/resume对同Run每个Operation重复计算相同branch证明 |
| [G14](#g14) | 行为缺陷 | 实验工具 | 动态工厂executionModel先String导致数组被接受 |
| [G15](#g15) | 重复/无效逻辑 | 实验工具 | 隔离当前应用fixture仍猜测退役Opinion evidenceIds形状 |
| [G16](#g16) | 行为缺陷 | 运行代码 | 空字符串未知字段绕过固定白名单 |
| [G17](#g17) | 重复/无效逻辑 | 运行代码 | 证据输入对刚收窄的对象重复校验形状 |
| [G18](#g18) | 重复/无效逻辑 | 运行代码 | 证据冻结丢弃同次完整parse的正文/定义，再复制原值 |
| [G19](#g19) | 低影响小项 | 运行代码 | 理由非空检查后再次readText重复相同条件 |
| [G20](#g20) | 低影响小项 | 运行代码 | 固定collect解析后防御返回其他方法 |
| [G21](#g21) | 低影响小项 | 运行代码 | 私有来源缓存始终传入却声明可选 |
| [G22](#g22) | 低影响小项 | 运行代码 | 关系固定路径先查自有键再枚举查同一键 |
| [G23](#g23) | 低影响小项 | 运行代码 | 同一时间范围条件重复解析不变的from/to字符串 |
| [G24](#g24) | 低影响小项 | 测试 | 测试工作区装配仍兼容缺失parse/split种子 |
| [G25](#g25) | 重复/无效逻辑 | 运行代码 | Host 对同一续租响应完整校验后又逐字段相等比较，并丢弃新冻结副本 |
| [G26](#g26) | 重复/无效逻辑 | 运行代码 | HTTP 路由预解析后委托解析器重复检查同一同步信封 |
| [G27](#g27) | 行为缺陷 | 运行代码 | 运行端 JSON 字节边界静默替换非法 UTF-8 后继续处理 |
| [G28](#g28) | 重复/无效逻辑 | 运行代码 | 同一纯迁移计划中反复验证 verification 的 score/reportIds |
| [G29](#g29) | 行为缺陷 | 运行代码 | Host初次授权将真值数字当作必填字符串交给执行器 |
| [G30](#g30) | 重复/无效逻辑 | 运行代码 | 运行目录再次验证公共客户端已绑定的Map身份 |
| [G31](#g31) | 重复/无效逻辑 | 运行代码 | 来源行定位同一修改字段被完整解析两次 |
| [G32](#g32) | 重复/无效逻辑 | 运行代码 | Reader只返回ready字符串导致重新证明节点与上下文 |
| [G33](#g33) | 重复/无效逻辑 | 运行代码 | 网关连接成功时active清理不可达 |
| [G34](#g34) | 重复/无效逻辑 | 运行代码 | 续租DTO递归验证同一data时重复通用扫描 |
| [G35](#g35) | 低影响小项 | 运行代码 | 动态字段添加的字符串schema fallback无生产入口 |
| [G36](#g36) | 低影响小项 | 运行代码 | 可打开单页条件重复loading约束 |
| [G37](#g37) | 低影响小项 | 运行代码 | 已建立单根baseline又检查单根长度 |
| [G38](#g38) | 低影响小项 | 运行代码 | 同一个读取失败被反复归一化 |
| [G39](#g39) | 低影响小项 | 运行代码 | 2D布局父节点已存在却仍有零fallback的前轮同类遗留 |
| [G40](#g40) | 行为缺陷 | 运行代码 | 枚举控件字符串化混淆合法JSON值类型 |
| [G41](#g41) | 低影响小项 | 运行代码 | 单调用纯转发包装不拥有实际规则或资源 |
| [G42](#g42) | 重复/无效逻辑 | 运行代码 | 新增证据把同源selected引用投影反向join并重复证明数量 |
| [G43](#g43) | 行为缺陷 | 运行代码 | 切换Run后迟到领取仍持有并续租旧Run控制权 |
| [G44](#g44) | 重复/无效逻辑 | 运行代码 | 保存引用变化时同一对payload重复展开引用目标 |
| [G45](#g45) | 低影响小项 | 运行代码 | 固定字符串split后的空数组检查恒假 |
| [G46](#g46) | 行为缺陷 | 运行代码 | 公共Map边界未拒绝实际reader必需的边createdAt缺失 |
| [G47](#g47) | 重复/无效逻辑 | 运行代码 | 2D布局每个节点重新展开同一份Run operations集合 |
| [G48](#g48) | 低影响小项 | 测试 | 旧branch proof测试被无关坏node日期提前拒绝，未隔离目标条件 |
| [G49](#g49) | 低影响小项 | 测试 | 固定会话fixture捕获的基础mock实现仍走optional调用分支 |
| [G50](#g50) | 行为缺陷 | 运行代码 | 活动布局拖动在外壳卸载后仍更新状态并保存旧布局 |

## 完整证据与建议

<a id="g01"></a>
### G01 — 动态字典没有按自有字段读写，导致合法同名键丢失、类型失配或原型污染

性质：行为缺陷。范围：运行代码／实验工具。原始记录：P01、D04、R05、U10、U13、E05。

位置：[backend/modules/shared/data-definition.ts:343](../../backend/modules/shared/data-definition.ts)；[backend/modules/shared/data-definition.ts:1276](../../backend/modules/shared/data-definition.ts)；[backend/modules/graph/run-state.ts:229](../../backend/modules/graph/run-state.ts)；[backend/modules/shared/data-definition.ts:337](../../backend/modules/shared/data-definition.ts)；[backend/modules/shared/data-definition.ts:344](../../backend/modules/shared/data-definition.ts)；[backend/modules/graph/graph-input.ts:39](../../backend/modules/graph/graph-input.ts)；[backend/modules/graph/run-state.ts:488](../../backend/modules/graph/run-state.ts)；[backend/modules/graph/run-state.ts:383](../../backend/modules/graph/run-state.ts)；[backend/modules/graph/run-state.ts:308](../../backend/modules/graph/run-state.ts)；[backend/adapters/storage/branch-migration.ts:375](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:377](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:398](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:462](../../backend/adapters/storage/branch-migration.ts)；[apps/ui/features/graph/DataPayloadEditor.vue:174](../../apps/ui/features/graph/DataPayloadEditor.vue)；[apps/ui/features/assets/AssetManagement.vue:149](../../apps/ui/features/assets/AssetManagement.vue)；[apps/ui/features/assets/AssetManagement.vue:153](../../apps/ui/features/assets/AssetManagement.vue)；[apps/ui/features/assets/AssetManagement.vue:157](../../apps/ui/features/assets/AssetManagement.vue)；[apps/ui/features/graph/DataPayloadEditor.vue:50](../../apps/ui/features/graph/DataPayloadEditor.vue)；[apps/ui/features/graph/DataPayloadEditor.vue:243](../../apps/ui/features/graph/DataPayloadEditor.vue)；[apps/ui/features/graph/data-payload.ts:109](../../apps/ui/features/graph/data-payload.ts)；[apps/ui/features/reader/reader-content.ts:133](../../apps/ui/features/reader/reader-content.ts)；[apps/ui/features/agents/AgentManagement.vue:303](../../apps/ui/features/agents/AgentManagement.vue)；[experiments/evidence-library-tests/stress.ts:226](../../experiments/evidence-library-tests/stress.ts)。

**P01：动态自有键字典仍有继承读取或setter写入**

目录允许constructor端口；合法目录及source payload启动Run抛TypeError。schema允许__proto__枚举原值，definitionsReadPackage把其显式enumLabels标签丢失。域/UI/迁移同根位置由相应scope补齐，最终合并为一个主题。 8规则二遍已用实际definitionsReadPackage证实fieldLabels/enumLabels外层自有__proto__配置键也被丢弃（enumLabels外层还改变临时字典原型）；这只声称准入配置映射不保留输入，不声称非法显示路径被UI使用。

建议：只解释实际自有条目，构造字典用定义自有属性的方法；保留合法字段/端口/枚举名，不增加默认数据。

必须保留：保持真实未知JSON、schema、引用及固定字段白名单校验。

证据入口：root-repro.cjs; root-repro-output.json

**D04：普通对象作为动态字典造成合法原型同名键丢失/崩溃**

graphInput JSON对象result[key]写__proto__触发原型setter；root复现constructor端口从result={}桶读原型函数后.push报错。 103新复现：合法own __proto__ schema与/__proto__/audit103投影通过发布/Run建立，runReadData后projectedOwnKeys=[]，Object.prototype.audit103被写入；finally删除进程内marker。 第二轮规则复核按源码确认explicit members缺省读取constructor同根风险；追加试构未同步output anchor，故在schema阶段拒绝，不把D04-explicit-members这次观察当正向复现实证。

建议：数据字段复制与字典桶使用自有字段安全构造/Map，保留合法键而非新增保留字兼容拒绝。

必须保留：JSON深度/成员预算、合法端口/变量语义、对象根/schema约束。

证据入口：同脚本D04-json-key：ownProtoField=false、ordinaryPrototype=false、inheritedMarker=own value；constructor端口证据由root负责。；D04-projection-key输出globalPrototypeMarker=projected value。

**R05：迁移 legacyProducers 普通字典写入 __proto__ 时静默丢旧 producer**

node.id边界migrationString只要求非空，已准入的__proto__进入legacyProducers={}赋值:398触发原型setter，未成为自有键；Object.keys长度为0后结果遗漏整个legacyProducers。真实纯迁移函数普通id保留producer marker，同一输入改id=__proto__仍返回migrate却丢metadata，源producer未变。reportIds使用Object.fromEntries安全，不误报该映射。

建议：用Object.fromEntries等实际自有字典构造保存旧producer条目，保持同名字段作为普通数据；若真实历史合同要求限制ID，应明确验证并blocked，不能默默接纳后丢失元信息。不加入泛用hasOwn/getter包装或新默认补偿。

必须保留：显式迁移与旧producer完整归档保留；原图不修改、迁移失败blocked；reportIds的现有安全字典构造、节点关系和apply原子写入

证据入口：{"script":"develop-docs/103-全库审计/runtime-repro.mts","output":"develop-docs/103-全库审计/runtime-repro-output.txt","stderr":"develop-docs/103-全库审计/runtime-repro-stderr.txt","command":"node --import tsx develop-docs/103-全库审计/runtime-repro.mts > develop-docs/103-全库审计/runtime-repro-output.txt 2> develop-docs/103-全库审计/runtime-repro-stderr.txt","exitCode":0,"environment":"Only owned loopback HTTP listeners, memory business receivers, and temporary files strictly inside 103; no user DB, broker, or external writes","case":"migration-producer-dictionary","result":"ordinary-node retains migration.legacyProducers; __proto__ returns migrate but omits it"}

**U10：UI JSON字段自有成员与原型同名键读取/写入失配**

editorRenameObject复制原对象、delete旧键后next[key]=value，合法__proto__被setter处理。assetSetPointer读取target[part]未限自有键，optional /__proto__/assetId初值未创建容器时读到Object.prototype并写入。sourceType只筛存在asset reference；发布schema允许显式同名properties。 本轮横扫：dynamicFields将继承constructor/toString当固定字段而隐藏合法additionalProperties正文；known-field读取缺省同名payload时取继承函数而忽略default；payloadReadPointer合法空对象读取constructor返回function。reader schema标签对additionalProperties同名字段也可能选继承项，非owner成员语义。

建议：读取中间容器采用自有字段语义；创建和改名采用定义普通可枚举自有属性的对象构造，不禁用合法键。

必须保留：已发布指针格式边界；精确sourceType及实际asset引用声明；表单空名称和冲突名称校验；合法原型同名字段仍可读写

证据入口：103/reproduce-ui.cjs/output已复现rename、asset write、pointer read及合法发布schema的dynamicFields；从真实源提取函数/声明，不复制被审实现。

**U13：Agent自定义kind同名原型项使未知类型option不渲染**

模板v-if=!kinds[draft.kind]使用普通对象继承查找。contracts/control.ts的PromptKind为string，workspace-input controlReadKind仅要求非空名称；通用绑定Agent允许toString/constructor。继承函数为truthy，抑制本应显示的保存kind option。uiReadAgentKind自身已有hasOwn，故列表显示与编辑下拉不同。

建议：未知kind存在性采用自有键语义或Map，不禁用合法自定义kind。

必须保留：新建角色范围；已有kind身份只读；缺少绑定目录时保留原promptVars并交服务端验证

证据入口：103/reproduce-ui.cjs/output：实际controlReadAgent接受kind=toString及合法已知绑定；源kinds对象hasOwn=false，模板fallbackOptionVisible=false。

**E05：压力驱动动态错误码普通字典取到原型成员导致错误计数损坏**

实际measureRound注入合法字符串错误码constructor时counter变string；__proto__时无自有counter。业务失败仍记failed，但按错误码统计不可信。

建议：Map或安全自有字段计数，保留所有原始错误身份。

必须保留：失败数/timeout/pending真实未完成追踪及阈值拒绝，不能把错误改成成功。

证据入口：E05 constructor failed1 ownCountertrue counterType=string；__proto__ failed1 ownCounterfalse counterType=object。

<a id="g02"></a>
### G02 — 次生清理失败覆盖主错误；部分路径还跳过后续清理

性质：行为缺陷。范围：构建/验证／测试／运行代码／实验工具。原始记录：P05、U11、R07、E02。

位置：[scripts/check-desktop-runtime.ts:121](../../scripts/check-desktop-runtime.ts)；[tests/backend/fixtures/rabbitmq.ts:95](../../tests/backend/fixtures/rabbitmq.ts)；[client/graph-client.ts:1020](../../client/graph-client.ts)；[apps/graph-server/main.ts:32](../../apps/graph-server/main.ts)；[apps/local-server/runtime.ts:102](../../apps/local-server/runtime.ts)；[tests/browser/workspace-recovery.spec.ts:66](../../tests/browser/workspace-recovery.spec.ts)；[experiments/evidence-library-tests/ui-fixture.ts:97](../../experiments/evidence-library-tests/ui-fixture.ts)；[experiments/evidence-library-tests/relations-fixture.ts:212](../../experiments/evidence-library-tests/relations-fixture.ts)；[experiments/evidence-library-tests/usage-fixture.ts:260](../../experiments/evidence-library-tests/usage-fixture.ts)；[experiments/evidence-library-tests/ui-preview.ts:60](../../experiments/evidence-library-tests/ui-preview.ts)；[experiments/evidence-library-tests/relations-preview.ts:63](../../experiments/evidence-library-tests/relations-preview.ts)；[experiments/evidence-library-tests/usage-preview.ts:57](../../experiments/evidence-library-tests/usage-preview.ts)。

**P05：验证脚本/代理夹具次生清理覆盖主错并阻断后续清理**

高信号C04复核后，精确源函数体受控双故障实测：rabbitCreateBroker主初始化失败后rm失败只抛secondary temporary cleanup failure；desktopCheckRuntime外层finally的service.close拒绝后只抛secondary service cleanup failure且providerClosed=false。未启动真实进程。

建议：所有自有资源尽力释放，保留原始故障并关联真实清理失败；不以空catch把关闭失败伪装成功。

必须保留：独立/借用broker归属、关闭失败非零退出、日志脱敏与用户环境恢复。

证据入口：root-repro.cjs; root-repro-output.json

**U11：非SSE响应拒绝分支的取消错误覆盖主协议错误**

wrong content-type时先await response.body.cancel再throw INVALID_STREAM；底层cancel拒绝会绕过主错，外层catch原样抛普通Error。102仅JSON/download同类已修，该分支尚在。

建议：取消只作为次要清理，保证INVALID_STREAM主错保留；仍完成监听器和计时器释放。

必须保留：SSE content-type/body真实边界；关闭/取消/超时优先分类；不屏蔽真正网络读取错误

证据入口：node --import tsx develop-docs/103-全库审计/reproduce-ui.cjs；输出U11-sse-cleanup code:null,message:secondary cleanup failure。实际公共clientCreateApi.watch，无网络或DB。

**R07：入口启动失败后的清理拒绝覆盖原始启动错误**

两个入口catch原始启动错误后先await close，只有清理成功才throw原错；若清理也拒绝，原错误不再抛出且未进入cause/errors。准确入口函数体受控initialize失败+现有close边界失败均观察secondary，primaryRetained=false。 同类恢复page helper:66精确函数体也已复现newPage主错被close次级拒绝覆盖。

建议：保留清理执行，双失败时同时保留原启动错误和清理错误（cause或AggregateError）；清理成功仍抛原对象。不增加重试/忽略真实资源回收失败。

必须保留：所有已取得资源仍要尝试回收；关闭失败不能伪装释放成功/删仍在使用的目录；既有诊断/退出码/未知网络存储错误边界

证据入口：{"script":"develop-docs/103-全库审计/runtime-cleanup-repro.cjs","output":"develop-docs/103-全库审计/runtime-cleanup-repro-output.json","command":"node develop-docs/103-全库审计/runtime-cleanup-repro.cjs","exitCode":0,"limits":"提取准确函数体，在现有initialize/close异步依赖边界受控注入两错误；无真实DB/端口/模型。"}

**E02：实验fixture/preview清理失败覆盖原启动或准备错误**

catch awaitclose;throwerror在close抛出时丢原error。实际ui fixture内存注入mongo.start primary+mongo.stop secondary后，抛cleanup Aggregate不含primary。preview finally rm也可能盖fixture.close；正常逐资源close本身必要。

建议：清理所有自有资源，同时Aggregate保留主错误与各清理错误；避免secondary替代primary。

必须保留：close幂等Promise/逐资源清理/最后rm认证文件与正常失败退出。

证据入口：E02 includesPrimary=false includesSecondary=true。

<a id="g03"></a>
### G03 — 取得资源后初始化清理责任建立过晚，中途失败遗留自有资源

性质：行为缺陷。范围：测试／实验工具。原始记录：PT01、E03。

位置：[tests/backend/fixtures/graph-api.ts:70](../../tests/backend/fixtures/graph-api.ts)；[experiments/evidence-library-tests/ui-preview.ts:15](../../experiments/evidence-library-tests/ui-preview.ts)；[experiments/evidence-library-tests/relations-preview.ts:11](../../experiments/evidence-library-tests/relations-preview.ts)；[experiments/evidence-library-tests/usage-preview.ts:12](../../experiments/evidence-library-tests/usage-preview.ts)。

**PT01：真实API测试工厂初始化中途失败没有释放已取得资源**

createGraphApi先取得rabbitCreateFixture，再await MongoMemoryReplSet.create；后者拒绝时尚未返回close，函数本身无finally。在内存执行该精确工厂函数体、提供受控broker和Mongo失败时，acquiredBrokerCount=1且cleanupCallsBeforeRejection=0。独立fixture拥有临时broker；套件共享broker时不应由fixture销毁，但后续已开Mongo/application也同样需取得后有owner。

建议：由工厂完整拥有初始化失败与正常结束的自有资源清理；不为借用broker加销毁，不用吞错假成功。

必须保留：独立/借用资源区别、非零失败、namespace隔离、真实Mongo/HTTP行为。

证据入口：root-repro.cjs; root-repro-output.json (exact function body, inert controlled dependencies)

**E03：实验fixture获取后初始化try建立过晚泄漏已取得资源**

三个preview先await真实fixture，再在try/signal注册前mkdtemp；该真实FS边界可拒绝，目录创建失败时没有fixture close。精确函数体用受控mkdtemp拒绝均观察到fixtureCloseCalls=0。usage fixture的app构造失败仅被人为注入，未证明其在shared已就绪前提下的真实同步拒绝路径，故该站点不作为确证需加保护的依据。

建议：取得临时fixture后、进入任何真实可拒绝FS步骤前建立自有资源清理责任；不凭纯构造器任意throw的假想新增防御分支。

必须保留：不关闭借用用户部署资源；本组只清理本factory明确拥有的临时服务/目录。

证据入口：E03三个MKTEMP_FAILURE fixtureCloseCalls=0；APP_CONSTRUCTOR_FAILURE sharedCloseCalls=0。

同类仅静态核对、未声称逐入口复现：[experiments/evidence-library-tests/usage-fixture.ts:38](../../experiments/evidence-library-tests/usage-fixture.ts)。

<a id="g04"></a>
### G04 — 私有分位数 helper 在已保证非空/有效分位的分支保留不可达回落

性质：低影响小项。范围：测试／实验工具。原始记录：B02、E06。

位置：[tests/browser/workspace-performance.spec.ts:99](../../tests/browser/workspace-performance.spec.ts)；[experiments/evidence-library-tests/stress.ts:97](../../experiments/evidence-library-tests/stress.ts)。

**B02：私有经验分位 helper 的空样本默认0与索引下界保护无实际调用路径**

全部调用位于:227 samples.values.length条件、:374-383已workspaceReadRaf强制values.length>=2、:685/:686 allDurations.length>=100/1000条件之后。percentile全部为0.5/0.95/0.99，无外部调用或导出。对这些前提，ceil(n*p)-1始终处于0..n-1；??0与Math.max0不会生效。

建议：直接按已保证的非空样本和固定分位取索引，私有helper说明实际前提；不增加assert/默认替代原兜底。

必须保留：RAF完整窗口与至少2样本要求；p95/p99不同样本门槛；失败样本不丢弃，缺观测以空values+unavailable显式表达；正式容量/长时测试的明确许可

证据入口：{"method":"核对私有helper全部6处调用及RAF返回边界，无需浏览器运行"}

**E06：非空分位数数组的尾部空值回落不可达**

私有percentile先对空数组return null；所有caller比例固定0.5/0.95/0.99，稠密latenciesMs由push构造；索引落在0..length-1，末尾??null没有真实调用分支。

建议：只保留无样本return null，非空分支直接返回计算出的实际样本。

必须保留：缺失指标不能伪造0、延迟样本仍需排序及正确最近秩公式。

证据入口：静态逐caller/样本生产者及索引范围核对，不新增镜像测试。

<a id="g05"></a>
### G05 — 恢复夹具误把Vite port:0当随机口，实际回退固定5173且strictPort失败

性质：行为缺陷。范围：测试。原始记录：B01。

位置：[tests/browser/workspace-recovery-fixture.ts:271](../../tests/browser/workspace-recovery-fixture.ts)。

**B01：恢复夹具误把Vite port:0当随机口，实际回退固定5173且strictPort失败**

该恢复fixture传server.port=0/strictPort=true；已安装Vite5 startServer使用(!configPort ? server._currentServerPort : configPort) ?? DEFAULT_DEV_PORT，首次0回退5173。普通workspace-fixture.ts:92-94已经说明同问题并采用strictPort:false。恢复fixture注释和lifecycle测试称随机origin，但用户5173预览存在时会争用固定端口而失败。

建议：与普通fixture采用一致的真实空闲端口策略并读取实际origin，或在真正Node监听层建立随机口；不要靠重试重跑/换数据库掩盖端口装配错误。

必须保留：server.address真实校验、监听失败传播；固定Web origin跨应用重启保留；旧应用进程实际close/存储所有权/不删用户数据；静态文档插件关闭HMR监听

证据入口：{"script":"develop-docs/103-全库审计/browser-repro.cjs","output":"develop-docs/103-全库审计/browser-repro-output.json","command":"node develop-docs/103-全库审计/browser-repro.cjs","exitCode":0,"result":"configuredPort0 → exact installed Vite startServer passes actualRequestedPort5173, strictPorttrue","limits":"提取已安装Vite准确函数体纯内存调用；无监听、无浏览器/DB/broker，无完整浏览器测试运行。"}

<a id="g06"></a>
### G06 — asset.delete对每张图重编同一事务目录

性质：重复/无效逻辑。范围：运行代码。原始记录：D01。

位置：[backend/modules/assets/asset-service.ts:513](../../backend/modules/assets/asset-service.ts)；[backend/modules/assets/asset-service.ts:301](../../backend/modules/assets/asset-service.ts)。

**D01：asset.delete对每张图重编同一事务目录**

delete在活动ctx.session中owner授权后逐graph调用control.definitions；helper重复requireRole/viewer writeFence及完整catalog编译。3空图内存实际service编译3次。

建议：取得一次目录后逐图运行纯assetsCollectNodeAssetReferences；各图正文仍独立解析。

必须保留：owner授权/写栅栏、receipt优先、预期sha、所有图实际引用检查及同事务删除。

证据入口：node --import tsx develop-docs/103-全库审计/repro-domain.cjs；D01-delete-catalog

<a id="g07"></a>
### G07 — 同次自动发布重复完整解析候选及双扫描candidate哨兵

性质：重复/无效逻辑。范围：运行代码。原始记录：D02。

位置：[backend/modules/graph/run-state.ts:602](../../backend/modules/graph/run-state.ts)；[backend/modules/graph/run-state.ts:802](../../backend/modules/graph/run-state.ts)；[backend/modules/graph/run-state.ts:579](../../backend/modules/graph/run-state.ts)；[backend/modules/graph/run-state.ts:598](../../backend/modules/graph/run-state.ts)。

**D02：同次自动发布重复完整解析候选及双扫描candidate哨兵**

917预分配nodeId后，921校验当次新outputs；940同步进入runFinishResult→runCreateOutputs再次完整JSON/schema解析同值。内存单无引用产物schema读取2次，对应两栈。scan与readRefs也对同份未改正文重复同shape判定。

建议：当次候选解析返回payload/真实refs/candidate位置，直接自动发布复用；只对来自旧存储或后续审核请求的候选重新完整parse。

必须保留：首次候选合同/计数/授权检查，候选重映射的新值schema，跨请求旧候选完整parse；不引入通用cache/unchecked入口。

证据入口：同脚本D02-auto-parse，published=1 outputSchemaReads=2。

<a id="g08"></a>
### G08 — 已展开引用未保留具体path，通配资产媒体约束被省略

性质：行为缺陷。范围：运行代码。原始记录：D03。

位置：[backend/modules/assets/asset-service.ts:284](../../backend/modules/assets/asset-service.ts)；[backend/modules/assets/bundle-codec.ts:377](../../backend/modules/assets/bundle-codec.ts)。

**D03：已展开引用未保留具体path，通配资产媒体约束被省略**

父指针仍是声明/locators/*，确定pointer读不到实际locator.mediaType，expectedMediaType=undefined。真实parser+实际资产service复现：同错配media确定path拒绝，合法arraypath接受。root evidence关系也重复展开相同path，合并同根。

建议：完整引用解析保留具体path或父对象；资产/包/证据消费者直接读同次结果。

必须保留：asset ready/workspace/media检查和包引用闭包均保留，不通过删除media策略消除问题。

证据入口：同脚本D03-media：audit.single ASSET_REFERENCE；audit.array ACCEPTED。

<a id="g09"></a>
### G09 — 确定rest形状又做通用对象白名单检查

性质：低影响小项。范围：运行代码。原始记录：D05。

位置：[backend/modules/workspace/seed-configuration.ts:61](../../backend/modules/workspace/seed-configuration.ts)；[backend/modules/workspace/seed-configuration.ts:63](../../backend/modules/workspace/seed-configuration.ts)；[backend/modules/assets/bundle-codec.ts:131](../../backend/modules/assets/bundle-codec.ts)；[backend/modules/assets/bundle-codec.ts:134](../../backend/modules/assets/bundle-codec.ts)。

**D05：确定rest形状又做通用对象白名单检查**

seedReadConfiguration白名单固定后剥definitionPackage再交seedReadInput重验object和相同7keys；bundlesReadAgent外层白名单含revision后剥revision再交controlReadAgent重验同一固定形状。无await/外传，第二形状分支不可触发，字段值仍须解析。

建议：公共未知边界一次决定白名单，内部字段解析消费已建立明确形状；不新增uncheckedflag/只转发兼容层。

必须保留：独立seedReadInput/controlReadAgent未知入口，以及定义包和字段枚举/工具/身份规则。

证据入口：静态逐项对照rest构造与callee keys；不新增镜像测试。

<a id="g10"></a>
### G10 — data_read未先绑定Operation，拒绝前已读取并提交另一Operation外部来源

性质：行为缺陷。范围：运行代码。原始记录：D06。

位置：[backend/modules/graph/graph-service.ts:928](../../backend/modules/graph/graph-service.ts)；[backend/modules/graph/graph-service.ts:942](../../backend/modules/graph/graph-service.ts)；[backend/modules/graph/graph-service.ts:953](../../backend/modules/graph/graph-service.ts)；[backend/modules/graph/graph-service.ts:964](../../backend/modules/graph/graph-service.ts)；[backend/adapters/http/graph-http-server.ts:623](../../backend/adapters/http/graph-http-server.ts)。

**D06：data_read未先绑定Operation，拒绝前已读取并提交另一Operation外部来源**

同Run两输入各Operation，只有A有效grant却传B operationId，readSource(B)及source.read receipt先提交；runReadData最后才因work不属于B拒绝。内存现有sourceStore实际service复现见输出；HTTP路由绑定还待runtime交叉确认。 runtime交叉确认HTTP623–629仅验内部token、proof及body字符串，直接service.readData，没有grant.operationId绑定；application继承graphBase.readData，真实生产可达。

建议：任何来源读取/缓存写入前校验grant.operationId===operationId并验证operation/stage/work资格；异步读取后仍保留最终租约/CAS复核。

必须保留：动态来源CAS赢家策略、lease有效期/holder/fence、Run ownership、receipt/CAS重试。

证据入口：同脚本D06-read-operation：WORK_STOPPED但readSourceCalls=1 fetchedOtherNode=true otherOperationCacheKeys=1 sourceReceipts=1。

<a id="g11"></a>
### G11 — 内嵌附件丢弃已验bytes后再解码和完整哈希

性质：重复/无效逻辑。范围：运行代码。原始记录：D07。

位置：[backend/modules/assets/bundle-codec.ts:335](../../backend/modules/assets/bundle-codec.ts)；[backend/modules/assets/bundle-codec.ts:337](../../backend/modules/assets/bundle-codec.ts)；[backend/modules/assets/asset-service.ts:622](../../backend/modules/assets/asset-service.ts)；[backend/modules/assets/asset-service.ts:131](../../backend/modules/assets/asset-service.ts)。

**D07：内嵌附件丢弃已验bytes后再解码和完整哈希**

bundlesReadAsset完整Base64解码、规范编码/长度/sha检查后仅返回base64；同一私有import再decode为相同Buffer并经assetsReadChunks重算sha。真实service内存替身：14字节附件哈希两次；外层2942字节包stream另检查一次（该检查必要）。

建议：ParsedWorkspaceBundle携带配对的已验附件bytes，导入直接交现有blob写接口；保留未知uploadstream和外层存储包完整验证。

必须保留：外层blob读完整性、64MiB、规范Base64/sha、导入新增filename/media规则、授权重查及不确定commit时保留blob。

证据入口：node --import tsx develop-docs/103-全库审计/repro-domain-import.cjs，embeddedHashPasses=2，exit0。

<a id="g12"></a>
### G12 — graphSameRoots每个元素重新排序同一right集合

性质：低影响小项。范围：运行代码。原始记录：D08。

位置：[backend/modules/graph/graph-service.ts:438](../../backend/modules/graph/graph-service.ts)。

**D08：graphSameRoots每个元素重新排序同一right集合**

left/right为readonlystring数组，同步方法内不变；every每轮都复制并排序right，排序与index无关，调用者为editor proof同根比较。

建议：左右各复制排序一次再比较，保留长度和身份相等。

必须保留：授权范围相等和不原地修改caller根数组。

证据入口：静态同值循环证据。

<a id="g13"></a>
### G13 — pause/resume对同Run每个Operation重复计算相同branch证明

性质：重复/无效逻辑。范围：运行代码。原始记录：D10。

位置：[backend/modules/graph/run-state.ts:1046](../../backend/modules/graph/run-state.ts)；[backend/modules/graph/run-state.ts:108](../../backend/modules/graph/run-state.ts)。

**D10：pause/resume对同Run每个Operation重复计算相同branch证明**

runUpdatePause对run.operations调用同步runValidateInputs，循环内无修改，所有operation共用run.branchState和同一document，每次完整branchReadSnapshot相同；内存2Operation得到branchRootReads=2。

建议：一次验证当前Run的branch证明，再逐Operation保留各自输入id/revision/type、sealed和specHash检查。

必须保留：操作级输入与规格校验、run活跃状态、外层控制权/最终CAS/异步后复核。

证据入口：repro-domain.cjs D10-pause-branch operations=2 branchRootReads=2。

<a id="g14"></a>
### G14 — 动态工厂executionModel先String导致数组被接受

性质：行为缺陷。范围：实验工具。原始记录：E01。

位置：[experiments/evidence-library-tests/load-target.ts:22](../../experiments/evidence-library-tests/load-target.ts)。

**E01：动态工厂executionModel先String导致数组被接受**

assertTarget未知factory结果info.executionModel=[remote]经String被接受，随后asserts EvidenceTestTarget把数组当标量；真实私有parser内存调用复现。

建议：直接比较三个字符串枚举，不字符串化unknown。

必须保留：未知模块工厂/隔离声明/必需方法存在的独立边界。

证据入口：repro-experiments.cjs E01 acceptedArray=true。

<a id="g15"></a>
### G15 — 隔离当前应用fixture仍猜测退役Opinion evidenceIds形状

性质：重复/无效逻辑。范围：实验工具。原始记录：E04。

位置：[experiments/evidence-library-tests/relations-fixture.ts:141](../../experiments/evidence-library-tests/relations-fixture.ts)；[experiments/evidence-library-tests/usage-fixture.ts:226](../../experiments/evidence-library-tests/usage-fixture.ts)。

**E04：隔离当前应用fixture仍猜测退役Opinion evidenceIds形状**

所有调用由当前factory创建empty/library工作区，当前默认不可变factcheck.opinion只有evidenceClaimIds，旧evidenceIds类型不注册且不能覆盖同version；usage额外读current目录只为二选一字段。

建议：明确使用当前evidenceClaimIds字段，移除该兼容分支及仅为它服务的usage outputProposal目录重读。

必须保留：独立readType为通用nodeInput选择实际精确type/version仍有用途；不删真实未知HTTP响应parser。

证据入口：E04 currentField=true retiredField=false；调用者relations.spec/createChain、preview以及usage.createScope/outputProposal链已核对。

<a id="g16"></a>
### G16 — 空字符串未知字段绕过固定白名单

性质：行为缺陷。范围：运行代码。原始记录：P02。

位置：[backend/modules/shared/input-validation.ts:15](../../backend/modules/shared/input-validation.ts)。

**P02：空字符串未知字段绕过固定白名单**

Object.keys.find可能返回空字符串，if(unknown)把它当未命中。实际inputReadObject({required:"valid","":1},["required"])接受；非空unexpected被INVALID_ARGUMENT拒绝。

建议：按是否找到字段判断，或直接逐键拒绝；保留字段白名单。

必须保留：外部envelope/params/node等对象形状和允许字段都必须仍校验。

证据入口：root-repro.cjs; root-repro-output.json

<a id="g17"></a>
### G17 — 证据输入对刚收窄的对象重复校验形状

性质：重复/无效逻辑。范围：运行代码。原始记录：P03。

位置：[backend/modules/evidence-library/evidence-input.ts:39](../../backend/modules/evidence-library/evidence-input.ts)；[backend/modules/evidence-library/evidence-input.ts:203](../../backend/modules/evidence-library/evidence-input.ts)。

**P03：证据输入对刚收窄的对象重复校验形状**

readEnvelope已建立普通params；readCommand只需新命令字段白名单却再次readObject。readBasisRefs在同一循环先readObject(item)，各kind分支又readObject(input,keys)，之间无await/修改。

建议：让未知对象解析与已收窄对象的字段白名单各有一次所有权，不提供公共skipValidation。

必须保留：收据前信封与收据后固定字段解析顺序、basis未知种类、所有字段值和容量上限保留。

<a id="g18"></a>
### G18 — 证据冻结丢弃同次完整parse的正文/定义，再复制原值

性质：重复/无效逻辑。范围：运行代码。原始记录：P04。

位置：[backend/modules/evidence-library/evidence-service.ts:133](../../backend/modules/evidence-library/evidence-service.ts)；[backend/modules/evidence-library/evidence-service.ts:143](../../backend/modules/evidence-library/evidence-service.ts)。

**P04：证据冻结丢弃同次完整parse的正文/定义，再复制原值**

freezeNode先在catalog找definition，definitionsReadPayloadReferences内部完整解析并复制definition/payload却只返回refs；紧接着structuredClone(node)和definition重做复制。实际EvidenceService.collect+内存存储测单节点payloadReads=2、definitionClones=2，中间没有正文修改。

建议：承接同次完整解析的definition/payload/references；独立复制元数据，取消同值重复解释。

必须保留：精确版本、Claim要求、节点revision/工作区、真实资产ready与快照独立性必须保留。

证据入口：root-repro.cjs; root-repro-output.json

<a id="g19"></a>
### G19 — 理由非空检查后再次readText重复相同条件

性质：低影响小项。范围：运行代码。原始记录：PM01。

位置：[backend/modules/evidence-library/evidence-input.ts:163](../../backend/modules/evidence-library/evidence-input.ts)。

**PM01：理由非空检查后再次readText重复相同条件**

readReason先验证typeof/nonempty，再readText重复同样条件；后者真正新增的是字节上限。

建议：一次保留专用REASON_REQUIRED错误与字节上限，避免重复形状检查。

必须保留：专用错误码、原文和TEXT_BYTES上限。

<a id="g20"></a>
### G20 — 固定collect解析后防御返回其他方法

性质：低影响小项。范围：运行代码。原始记录：PM02。

位置：[backend/modules/evidence-library/evidence-record.ts:158](../../backend/modules/evidence-library/evidence-record.ts)。

**PM02：固定collect解析后防御返回其他方法**

readEntry只构造method:evidence.collect，evidenceReadCommand该分支固定返回同method；parsed.method不可能为withdraw。

建议：用准确的输入输出类型承接固定collect分支，不以强制断言替代解析。

必须保留：存储内容仍未知，confidence/applicability/basis及节点快照的完整解析不能移除。

<a id="g21"></a>
### G21 — 私有来源缓存始终传入却声明可选

性质：低影响小项。范围：运行代码。原始记录：PM03。

位置：[backend/modules/evidence-library/evidence-service.ts:118](../../backend/modules/evidence-library/evidence-service.ts)；[backend/modules/evidence-library/evidence-service.ts:153](../../backend/modules/evidence-library/evidence-service.ts)。

**PM03：私有来源缓存始终传入却声明可选**

freezeNode全部3个调用及readSourceMap的直接callback均传collect拥有的sourceMaps；私有函数无独立外部入口。?.get/?.set支持的无缓存路径不可达。

建议：把同次收录缓存作为必需参数，保留真实缓存未命中时读取与工作区检查。

必须保留：无缓存项与缓存本身不存在是不同状态；前者必须保留。

<a id="g22"></a>
### G22 — 关系固定路径先查自有键再枚举查同一键

性质：低影响小项。范围：运行代码。原始记录：PM04。

位置：[backend/modules/evidence-library/evidence-record.ts:290](../../backend/modules/evidence-library/evidence-record.ts)。

**PM04：关系固定路径先查自有键再枚举查同一键**

readNodePointer在hasOwn成功后Object.entries(value).find(token)又扫描容器；缺失结果的?.[1]已有拒绝路径。仅同一次同步JSON字段读取。

建议：保留一次自有字段查找，兼顾数组实际索引；不引入继承字段读取。

必须保留：JSON Pointer格式、真实路径目标值与关系摘要检查。

<a id="g23"></a>
### G23 — 同一时间范围条件重复解析不变的from/to字符串

性质：低影响小项。范围：运行代码。原始记录：PM05。

位置：[backend/modules/evidence-library/evidence-input.ts:186](../../backend/modules/evidence-library/evidence-input.ts)；[client/graph-client.ts:278](../../client/graph-client.ts)。

**PM05：同一时间范围条件重复解析不变的from/to字符串**

readText后同一同步if先各Date.parse一次查finite，再各parse一次比较from<=to，没有变更或异步。 跨分区二遍同样确认client evidence scope.time.from/to在276–278重复解析；并为同一局部时间解析主题，不列为续租DTO重复扫描。

建议：各解析一次并复用，所有合法性与时间顺序条件保留。

必须保留：时间字符串原值、有限时间判断和from<=to。

<a id="g24"></a>
### G24 — 测试工作区装配仍兼容缺失parse/split种子

性质：低影响小项。范围：测试。原始记录：PTM01。

位置：[tests/backend/fixtures/graph-api.ts:287](../../tests/backend/fixtures/graph-api.ts)。

**PTM01：测试工作区装配仍兼容缺失parse/split种子**

createWorkspace参数WorkspaceSeedInput的parse/split已由seed-configuration.ts定义必需；verificationConfiguration始终提供完整种子，测试helper却用configuration.parse?/split?条件展开支持已退役缺省。

建议：按完整测试种子直接装配，保留真正可选profile字段和显式坏值测试入口。

必须保留：未知输入仍交seedReadInput验证，不能用强制断言接受不完整seed。

<a id="g25"></a>
### G25 — Host 对同一续租响应完整校验后又逐字段相等比较，并丢弃新冻结副本

性质：重复/无效逻辑。范围：运行代码。原始记录：R01。

位置：[backend/execution/host-worker.ts:217](../../backend/execution/host-worker.ts)；[backend/execution/host-worker.ts:163](../../backend/execution/host-worker.ts)；[backend/execution/host-worker.ts:219](../../backend/execution/host-worker.ts)。

**R01：Host 对同一续租响应完整校验后又逐字段相等比较，并丢弃新冻结副本**

初次claim在:325取得hostReadGrant返回的冻结grant。续租:216取得新的renewed，:217调用hostReadGrant验证host/holder、字段非空、fence和leaseMs并返回Object.freeze副本，但没有保存返回值；:219-222又把同一renewed的work/map/run/operation/stage/slot/specHash/fence/leaseMs与原已验证grant全相等比较。期间没有await或其他来源。相等本身保证这些字段非空和数值合法，唯一需要额外合并的hostId/holderId也有已知精确值。

建议：初次claim保留完整验证+冻结。续租在同一个响应入口检查存在性及所有不可变字段相等，不创建无用copy/freeze。需保留现有leaseMs非法值普通Error与协议差异HostProtocolError的可观察分类，或作为明确行为修复另行统一，不能声称直接删除无语义差异。

必须保留：每一轮新HTTP续租响应都必须核对，不能删除整个续租验证；holder/host/fence/specHash/slot等全部精确身份；请求起点单调时钟deadline、异步取消、失租retry、最终release及排空；初次grant不能只truthy；R06已证实5个string字段可为数字17进入runner，简化续租不能沿用宽松首次边界。

证据入口：{"method":"production call-chain inspection","existingTests":["tests/backend/execution/host.spec.ts:127-176","tests/backend/execution/host.spec.ts:271-319"],"notRun":"No existing test suite was rerun during read-only audit"}

<a id="g26"></a>
### G26 — HTTP 路由预解析后委托解析器重复检查同一同步信封

性质：重复/无效逻辑。范围：运行代码。原始记录：R02。

位置：[backend/adapters/http/graph-http-server.ts:148](../../backend/adapters/http/graph-http-server.ts)；[backend/adapters/http/graph-http-server.ts:150](../../backend/adapters/http/graph-http-server.ts)；[backend/adapters/http/graph-http-server.ts:186](../../backend/adapters/http/graph-http-server.ts)；[backend/adapters/http/graph-http-server.ts:264](../../backend/adapters/http/graph-http-server.ts)；[backend/adapters/http/graph-http-server.ts:267](../../backend/adapters/http/graph-http-server.ts)；[backend/adapters/http/graph-http-server.ts:408](../../backend/adapters/http/graph-http-server.ts)；[backend/adapters/http/graph-http-server.ts:409](../../backend/adapters/http/graph-http-server.ts)；[backend/modules/workspace/workspace-input.ts:142](../../backend/modules/workspace/workspace-input.ts)；[backend/modules/workspace/workspace-input.ts:178](../../backend/modules/workspace/workspace-input.ts)；[backend/modules/assets/asset-service.ts:92](../../backend/modules/assets/asset-service.ts)；[backend/modules/evidence-library/evidence-input.ts:55](../../backend/modules/evidence-library/evidence-input.ts)。

**R02：HTTP 路由预解析后委托解析器重复检查同一同步信封**

apiReadQuery的Object.keys白名单检查之后，将原value交给evidenceReadQuery/controlReadQuery再检查完全相同method/params信封。apiReadCommand同理，控制/资产分支还在所属parser重复UUID requestId。实际隔离回环HTTP复现对app.bootstrap、evidence.get、workspace.create、asset.delete在相同对象上的Object.keys检查均为2次，图自身map.rename只1次。无await/新来源介入。

建议：统一路由与所属解析器的信封所有权，只解析一次允许字段与请求身份，业务params由所属解析器继续完整解析。各独立公开未知输入入口仍需完整边界，不增加unchecked入口或只为跳过检查的标志。跨scope实现需与domain协调。

必须保留：HTTP未解析字节/JSON及全部字段白名单；evidence独立262144字节限制与收据后固定字段检查；未知方法错误、UUID/版本/权限和输入摘要；root已确认inputReadObject空字符串未知字段漏洞单独归root，不在本组重复计数

证据入口：{"script":"develop-docs/103-全库审计/runtime-repro.mts","output":"develop-docs/103-全库审计/runtime-repro-output.txt","stderr":"develop-docs/103-全库审计/runtime-repro-stderr.txt","command":"node --import tsx develop-docs/103-全库审计/runtime-repro.mts > develop-docs/103-全库审计/runtime-repro-output.txt 2> develop-docs/103-全库审计/runtime-repro-stderr.txt","exitCode":0,"environment":"Only owned loopback HTTP listeners, memory business receivers, and temporary files strictly inside 103; no user DB, broker, or external writes","case":"actual-http-envelope-visits","result":"four delegated methods: same object count 1 then 2; direct graph method count 1"}

<a id="g27"></a>
### G27 — 运行端 JSON 字节边界静默替换非法 UTF-8 后继续处理

性质：行为缺陷。范围：运行代码。原始记录：R03。

位置：[backend/adapters/http/graph-http-server.ts:58](../../backend/adapters/http/graph-http-server.ts)；[backend/adapters/http/dsh-diagnostic-server.ts:33](../../backend/adapters/http/dsh-diagnostic-server.ts)；[apps/config/local-settings.ts:23](../../apps/config/local-settings.ts)。

**R03：运行端 JSON 字节边界静默替换非法 UTF-8 后继续处理**

JSON.parse前使用Buffer.toString(utf8)或readFile(utf8)，默认解码把0xff改为U+FFFD。实际apiCreateServer收到name中的0xff后返回200，application.dispatch收到name=�；实际dshHttpCreateServer收到prompt中0xff返回200并把�交runtime.run；实际localReadConfiguration读取相同坏字节dshHome后成功返回�。字段仍是非空string，后续校验无法恢复被替换原字节。

建议：在真正JSON字节入口使用严格UTF-8解码后再JSON.parse，非法编码进入既有非法输入/配置错误分类；保持网络、FS及取消错误各自传播。横向处理同类入口时按实际字节来源统一，不扩大到正常string JSON复制或BSON转换。

必须保留：HTTP请求大小、字段形状、鉴权和业务校验；文件读取的ENOENT首次启动语义，非编码FS错误传播；DSH诊断流内/流前错误区分；显式允许的可省配置和值null不受影响

证据入口：{"script":"develop-docs/103-全库审计/runtime-repro.mts","output":"develop-docs/103-全库审计/runtime-repro-output.txt","stderr":"develop-docs/103-全库审计/runtime-repro-stderr.txt","command":"node --import tsx develop-docs/103-全库审计/runtime-repro.mts > develop-docs/103-全库审计/runtime-repro-output.txt 2> develop-docs/103-全库审计/runtime-repro-stderr.txt","exitCode":0,"environment":"Only owned loopback HTTP listeners, memory business receivers, and temporary files strictly inside 103; no user DB, broker, or external writes","cases":["invalid-utf8-http-command","invalid-utf8-diagnostic-prompt","invalid-utf8-local-settings"],"result":"All three accept replacement character; HTTP statuses 200"}

同类仅静态核对、未声称逐入口复现：[apps/cli/main.ts:74](../../apps/cli/main.ts)；[apps/cli/main.ts:75](../../apps/cli/main.ts)；[apps/graph-server/admin.ts:29](../../apps/graph-server/admin.ts)；[apps/graph-server/admin.ts:37](../../apps/graph-server/admin.ts)；[backend/adapters/messaging/rabbitmq.ts:77](../../backend/adapters/messaging/rabbitmq.ts)；[apps/desktop/credential-store.ts:45](../../apps/desktop/credential-store.ts)；[apps/desktop/connection-manager.ts:27](../../apps/desktop/connection-manager.ts)。

<a id="g28"></a>
### G28 — 同一纯迁移计划中反复验证 verification 的 score/reportIds

性质：重复/无效逻辑。范围：运行代码。原始记录：R04。

位置：[backend/adapters/storage/branch-migration.ts:221](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:364](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:381](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:386](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:388](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:444](../../backend/adapters/storage/branch-migration.ts)；[backend/adapters/storage/branch-migration.ts:417](../../backend/adapters/storage/branch-migration.ts)。

**R04：同一纯迁移计划中反复验证 verification 的 score/reportIds**

migrationValidateLegacyPayload:222-224验证score及reportIds；调用它的:381后只structuredClone(data)，:386-387对同值score再次做完全相同枚举检查。reportIds原数组在published收集:364、payload验证:224、生成边:444三次重新Array.isArray，字符串元素也重复解析，clone后的:388又一遍。真实migrationPlanBranchGraph对同一原reportIds数组Array.isArray实测3次，结果migrate且源未变。纯函数内没有await，原数据不变。 二遍还确认:313先已验source.edges数组，:417同一纯plan重验容器，可承接首解析结果但保留新edge字段/端点检查。

建议：在纯plan的既有verification解析阶段承接一份已验证score及去重reportIds，后续发布集合、payload和关系复用；至少删刚验证score后的完全重复枚举检查。按同一解析所有权根因一组，不按每个循环计数。

必须保留：全部旧格式未知输入首次验证；旧run/runs/history/Evidence歧义及活动租约阻断；apply事务内重新读取当前记录和revision/CAS检查是不同异步阶段，必须保留；旧报告矛盾内容比较、节点/关系目标及图类型转换保留

证据入口：{"script":"develop-docs/103-全库审计/runtime-repro.mts","output":"develop-docs/103-全库审计/runtime-repro-output.txt","stderr":"develop-docs/103-全库审计/runtime-repro-stderr.txt","command":"node --import tsx develop-docs/103-全库审计/runtime-repro.mts > develop-docs/103-全库审计/runtime-repro-output.txt 2> develop-docs/103-全库审计/runtime-repro-stderr.txt","exitCode":0,"environment":"Only owned loopback HTTP listeners, memory business receivers, and temporary files strictly inside 103; no user DB, broker, or external writes","case":"migration-same-reportIds-array-checks","result":"status migrate; sameReportArrayChecks 3; sourceUnchanged true"}

<a id="g29"></a>
### G29 — Host初次授权将真值数字当作必填字符串交给执行器

性质：行为缺陷。范围：运行代码。原始记录：R06。

位置：[backend/execution/host-worker.ts:165](../../backend/execution/host-worker.ts)；[backend/execution/host-worker.ts:240](../../backend/execution/host-worker.ts)；[backend/execution/dsh/work-executor.ts:128](../../backend/execution/dsh/work-executor.ts)。

**R06：Host初次授权将真值数字当作必填字符串交给执行器**

hostReadGrant对runId/operationId/stageId/slotId/specHash只使用!value，不校验typeof。实际Host对回环HTTP返回的每个字段数字17均调用注入runner，已越过声明GraphWorkGrant字符串合同。dshReadWork只把远端data字段与grant严格相等比较；若两响应同为数字不能补足形状约束。map/work来自queue精确匹配、host/holder精确比较仍有效，问题限这5个字段。

建议：在Host首次未知HTTP授权响应边界验证这些字段为非空字符串，再承接可信冻结grant；R01续租只与该已验证grant精确匹配。不能只删重复检查而继续允许宽松初领shape。

必须保留：所有首次未知响应必须建立真实Grant形状；host/holder/map/work精确匹配、fence/leaseMs约束；DSH后续数据响应仍属新边界须绑定原grant；取消/续租/最终release/排空保留

证据入口：{"script":"develop-docs/103-全库审计/runtime-grant-repro.mts","output":"develop-docs/103-全库审计/runtime-grant-repro-output.json","command":"node --import tsx develop-docs/103-全库审计/runtime-grant-repro.mts","exitCode":0,"result":"runId,operationId,stageId,slotId,specHash各数字17均进入实际Host runner","limits":"真实Host及隔离HTTP；queue/runner使用现有注入seam，仅证明Host响应边界，不冒充Rabbit或模型集成。"}

<a id="g30"></a>
### G30 — 运行目录再次验证公共客户端已绑定的Map身份

性质：重复/无效逻辑。范围：运行代码。原始记录：U01。

位置：[apps/ui/features/run/run-history.ts:121](../../apps/ui/features/run/run-history.ts)。

**U01：运行目录再次验证公共客户端已绑定的Map身份**

WorkspacePage:831→RunHistoryPanel:21→useRunHistory.readPage:119调用实际gateway.read(run.list)。graph-client:539进入clientAssertRunPage，407已拒value.mapId!==params.mapId；HTTP与桌面主进程共用该公共client。 状态层tests/client/run-history.spec.ts末段wrongMap故障注入绕过了public client所属边界；同一mapId错误已有graph-client.spec.ts run.list公开边界回归，应随精简移除重复子段而保留current401断言。

建议：仅删除面板page.mapId二验。

必须保留：client原DTO与请求身份校验；目录版本跨页一致性；跨页重复ID；会话/读取代次

证据入口：静态完整生产调用链及两处相同比较已核对；不重复执行测试。

<a id="g31"></a>
### G31 — 来源行定位同一修改字段被完整解析两次

性质：重复/无效逻辑。范围：运行代码。原始记录：U02。

位置：[apps/ui/features/reader/SourceAnchorEditor.vue:86](../../apps/ui/features/reader/SourceAnchorEditor.vue)；[apps/ui/features/reader/SourceAnchorEditor.vue:99](../../apps/ui/features/reader/SourceAnchorEditor.vue)。

**U02：来源行定位同一修改字段被完整解析两次**

当前文本字段的非空ranges与initialRanges不同后，validation全字段解析和selectedValidation均对同一固定originalSource/path/ranges调用readerCreateSourceAnchors；template158/166/187及选中预览同时消费二者。

建议：建立每字段一次解析结果，整体保存汇总与当前预览共享。

必须保留：用户行号格式/范围/重复检查；未修改旧版本anchors原样保留；source id/revision变化锁草稿

证据入口：同步纯函数调用链，无await或source/ranges写入；两处同实参已验证。

<a id="g32"></a>
### G32 — Reader只返回ready字符串导致重新证明节点与上下文

性质：重复/无效逻辑。范围：运行代码。原始记录：U03。

位置：[apps/ui/features/reader/reader-content.ts:47](../../apps/ui/features/reader/reader-content.ts)；[apps/ui/features/reader/NodeReader.vue:47](../../apps/ui/features/reader/NodeReader.vue)；[apps/ui/features/reader/NodeReader.vue:71](../../apps/ui/features/reader/NodeReader.vue)。

**U03：Reader只返回ready字符串导致重新证明节点与上下文**

readerReadState47–51已确认identity、匹配snapshot及nodes.some目标存在，NodeReader node computed又检查并find??null，relations/sourceNotes/childNotes71/75/77又组合相同ready前提。同一reactive同步读取，无await。

建议：ready判别状态携带已找到的node/snapshot/identity，组件从该分支取数据。

必须保留：真实Map/Workspace身份关系；非ready正常空/缺失/错误状态；nextTick后restoreRevision与当前目标复核；公开relation/source helper独立调用的真实边界

证据入口：完整状态构造及唯一生产consumer已核对，避免用非空断言替换。

<a id="g33"></a>
### G33 — 网关连接成功时active清理不可达

性质：重复/无效逻辑。范围：运行代码。原始记录：U04。

位置：[client/graph-client.ts:1247](../../client/graph-client.ts)。

**U04：网关连接成功时active清理不可达**

connect入口1232已close并置active=null；初始化1187只允许generation0写active；所有connect串行，候选read/save后1244/1246核代次，其他connect/disconnect/close会推进generation，不能在同代次悄悄重建active。

建议：删除成功分支active?.close，保留入口旧连接及失败candidate清理。

必须保留：初始化/登录代次；每个await后的generation检查；串行凭据写入和原失败传播

证据入口：全文件active赋值点横扫完成，仅init/成功接纳/清空三类，已独立交叉审查请求。

<a id="g34"></a>
### G34 — 续租DTO递归验证同一data时重复通用扫描

性质：重复/无效逻辑。范围：运行代码。原始记录：U05。

位置：[client/graph-client.ts:583](../../client/graph-client.ts)；[client/graph-client.ts:587](../../client/graph-client.ts)；[client/graph-client.ts:665](../../client/graph-client.ts)；[client/graph-client.ts:679](../../client/graph-client.ts)。

**U05：续租DTO递归验证同一data时重复通用扫描**

branch.renew/run.control.renew先按自己的重叠必要字段表及通用属性扫描，再将同一data递归送branch.ownership/run.control，重复必要字段存在性与ownershipRevision等扫描；不是nested不同对象的app.settings或snapshot.runs。

建议：base结构仅完整验证一次，再验证renew附加字段并保留branch/snapshot配对。

必须保留：外部base DTO完整解析；renew ownershipRevision/branch字段；editor kind、期限、fence；原branch与snapshot关系

证据入口：clientAssertData全分支与字段表/递归同对象路径已核对。

<a id="g35"></a>
### G35 — 动态字段添加的字符串schema fallback无生产入口

性质：低影响小项。范围：运行代码。原始记录：U06。

位置：[apps/ui/features/graph/DataPayloadEditor.vue:159](../../apps/ui/features/graph/DataPayloadEditor.vue)。

**U06：动态字段添加的字符串schema fallback无生产入口**

editorAddObject唯一生产caller在template250，v-if已要求additionalProperties是对象；handler同步读取同一resolved schema，无await。

建议：从已缩窄caller传入实际schema，去掉字符串替代路径。

必须保留：additionalProperties为true或省略时既有数据仍可展示；其他数组items真正可省默认；动态键冲突校验

证据入口：全apps/ui caller搜索仅该按钮，已完整读模板。

<a id="g36"></a>
### G36 — 可打开单页条件重复loading约束

性质：低影响小项。范围：运行代码。原始记录：U07。

位置：[apps/ui/features/workspace/use-workspace-view.ts:48](../../apps/ui/features/workspace/use-workspace-view.ts)。

**U07：可打开单页条件重复loading约束**

selectedIdentity唯一构造workspaceCreateSelectedIdentity113–114在loading时返回null；canOpenPage已要求selectedIdentity非null，再!loading恒真。

建议：canOpenPage只按非null selectedIdentity判断。

必须保留：完整user/workspace/map/node及节点存在前提；书签数值/当前page身份检查

证据入口：同一computed上下文同步纯投影已核对。

<a id="g37"></a>
### G37 — 已建立单根baseline又检查单根长度

性质：低影响小项。范围：运行代码。原始记录：U08。

位置：[apps/ui/features/graph/branch-baseline.ts:52](../../apps/ui/features/graph/branch-baseline.ts)。

**U08：已建立单根baseline又检查单根长度**

唯一生产baseline赋值由session.acceptSelectedBranch:345→branchCreateBaseline:18保证rootIds.length===1；没有生产变更baseline根数组的写入者。Matches仍需检查selectedId但不需重查长度。

建议：删除重复单根长度检查。

必须保留：新snapshot完整身份；selectedId与原根相同；分支成员/邻边/派生引用完整事实比较

证据入口：构造者与session所有赋值点已核对；测试直接构造不能当新生产信任入口。

<a id="g38"></a>
### G38 — 同一个读取失败被反复归一化

性质：低影响小项。范围：运行代码。原始记录：U09。

位置：[apps/ui/features/evidence-library/evidence-uses.ts:103](../../apps/ui/features/evidence-library/evidence-uses.ts)；[apps/ui/features/evidence-library/evidence-uses.ts:75](../../apps/ui/features/evidence-library/evidence-uses.ts)；[apps/ui/features/evidence-library/evidence-state.ts:241](../../apps/ui/features/evidence-library/evidence-state.ts)；[apps/ui/features/evidence-library/evidence-state.ts:294](../../apps/ui/features/evidence-library/evidence-state.ts)。

**U09：同一个读取失败被反复归一化**

uses readPage用clientReadError(cause)两次查code，acceptError又调用一次；evidence-state readPage/readDetail先检查code再将raw cause交acceptError再次归一化。未知Error会生成被丢弃的errorId，ClientError也重复复制同字段。

建议：当前失败只建立一次ClientErrorData，分类和接纳共用；保持过期代次检查顺序。

必须保留：原catch真实网络/协议分类；401回调；原命令重试优先级；旧错误不得改新身份

证据入口：完整catch/acceptError调用链已核对；不把catch本身标为冗余。

<a id="g39"></a>
### G39 — 2D布局父节点已存在却仍有零fallback的前轮同类遗留

性质：低影响小项。范围：运行代码。原始记录：U12。

位置：[apps/ui/features/graph/graph-layout.ts:236](../../apps/ui/features/graph/graph-layout.ts)；[apps/ui/features/graph/graph-layout.ts:237](../../apps/ui/features/graph/graph-layout.ts)。

**U12：2D布局父节点已存在却仍有零fallback的前轮同类遗留**

incoming只在213确认两端actual后写入，CanvasNode全集来自同一originals，231 byId完整覆盖；非空parentId的lookup必存在。无父节点的外层0是真实基础排序，内层?.y??0不可达。

建议：布局内部携带已解析父节点状态，直接取父y；不加非空断言或新getter校验。

必须保留：真正无parent的根排序0；关系未载入端点的接入过滤；输入数组不原地排序

证据入口：完整构造链同步闭合；与99已修Map初始化问题同组残留，不当新增主组计数。

<a id="g40"></a>
### G40 — 枚举控件字符串化混淆合法JSON值类型

性质：行为缺陷。范围：运行代码。原始记录：U14。

位置：[apps/ui/features/graph/DataPayloadEditor.vue:231](../../apps/ui/features/graph/DataPayloadEditor.vue)；[apps/ui/features/graph/DataPayloadEditor.vue:232](../../apps/ui/features/graph/DataPayloadEditor.vue)。

**U14：枚举控件字符串化混淆合法JSON值类型**

option值为String(item)，change按String(item)查首项；实际发布解析/目录校验/payload校验均接受type:[integer,string],enum:[0,0字符串]。用户选字符串0时emit首项数字0，两个值都合法因而后端不能识别用户选择被改写。对象enum也可碰撞[object Object]。

建议：DOM option使用稳定索引或保类型的唯一编码，再取原enum JSON值；标签翻译不改提交值。

必须保留：合法混合标量/对象枚举；真实用户选择索引范围；null可选语义；发布schema边界

证据入口：103/reproduce-ui.cjs实际提取当前模板change表达式，合法definitionsValidateCatalog正例输出U14 emittedType:number，requestedType:string。

<a id="g41"></a>
### G41 — 单调用纯转发包装不拥有实际规则或资源

性质：低影响小项。范围：运行代码。原始记录：U15。

位置：[apps/ui/features/reader/NodeReader.vue:195](../../apps/ui/features/reader/NodeReader.vue)；[apps/ui/features/graph/GraphSceneFallback.vue:139](../../apps/ui/features/graph/GraphSceneFallback.vue)；[apps/ui/features/evidence-library/EvidenceLibraryView.vue:131](../../apps/ui/features/evidence-library/EvidenceLibraryView.vue)；[apps/ui/features/evidence-library/EvidenceUsesPanel.vue:29](../../apps/ui/features/evidence-library/EvidenceUsesPanel.vue)。

**U15：单调用纯转发包装不拥有实际规则或资源**

readerDisposeRestore只调readerCancelRestore；readNodeColor只return node.color；库/使用面板部分submitSearch/loadMore/retry wrappers只await同一state方法，没有参数冻结、错误或生命周期规则。其他有真实状态更新/多caller绑定的helper未归此项。

建议：在对应注册/模板直接使用既有能力，保留真正的焦点、导航和状态接纳动作。

必须保留：readerCancelRestore代次；实际task/gateway生命周期包装；场景业务色/opacity语义；库命令原请求重试身份

证据入口：仅静态转发关系，低影响维护项，不视为行为缺陷或主要校验清理收益。

<a id="g42"></a>
### G42 — 新增证据把同源selected引用投影反向join并重复证明数量

性质：重复/无效逻辑。范围：运行代码。原始记录：U16。

位置：[apps/ui/features/evidence-library/NodeEvidenceEditor.vue:90](../../apps/ui/features/evidence-library/NodeEvidenceEditor.vue)；[apps/ui/features/evidence-library/NodeEvidenceEditor.vue:95](../../apps/ui/features/evidence-library/NodeEvidenceEditor.vue)。

**U16：新增证据把同源selected引用投影反向join并重复证明数量**

selection.refs由同一selection.selected按id/digest排序map生成且owner保证唯一。additions去已有entry后，addSelected又从selected按additions id/digest反查并校验length相等；全过程同步无await，两个集合不能失配。

建议：additions直接携带选中的summary和提交ref，在实际加入时各投影一次。

必须保留：旧draft同entry不得被新摘要替换；原引用撤回仍保留；32容量与每条使用理由；目标版本/pendingRetry锁定

证据入口：evidence-selection refs构造及NodeEvidenceEditor实际唯一UI调用已完整核对。

<a id="g43"></a>
### G43 — 切换Run后迟到领取仍持有并续租旧Run控制权

性质：行为缺陷。范围：运行代码。原始记录：U17。

位置：[apps/ui/state/client-session.ts:954](../../apps/ui/state/client-session.ts)；[apps/ui/state/client-session.ts:964](../../apps/ui/state/client-session.ts)；[apps/ui/state/client-session.ts:974](../../apps/ui/state/client-session.ts)；[apps/ui/state/client-session.ts:993](../../apps/ui/state/client-session.ts)；[apps/ui/views/WorkspacePage.vue:821](../../apps/ui/views/WorkspacePage.vue)。

**U17：切换Run后迟到领取仍持有并续租旧Run控制权**

领取只捕session/view，Run下拉busy时仍可切B；selectRun此时无已确认grant可释放。A成功迟到不核runSelectionEpoch，成为B视图selectedRunControl并启动周期续租。answerReview的选择保护阻旧审核写，但不清该闲置grant。

建议：Run领取有明确选择/意图归属，失效结果不接纳并清理不再被后续意图使用的grant；复用lease/fence时保交接保护，不能简单无条件release新授权。

必须保留：session/view/holder/fence保护；Run选择不取消已提交远端Run；审核await后完整意图复核；同授权再次使用的安全交接

证据入口：103/reproduce-ui.cjs复用现有session测试完整currentRun/Map/Workspace fixture，输出accepted:true,selectedRun:run-b,heldRun:run-a,releasedBeforeDispose:false；dispose清理，未接DB/服务。

<a id="g44"></a>
### G44 — 保存引用变化时同一对payload重复展开引用目标

性质：重复/无效逻辑。范围：运行代码。原始记录：U18。

位置：[apps/ui/state/client-session.ts:1414](../../apps/ui/state/client-session.ts)；[apps/ui/state/client-session.ts:1399](../../apps/ui/state/client-session.ts)。

**U18：保存引用变化时同一对payload重复展开引用目标**

saveNode先对node.payload/input.payload各sessionReadReferenceTargets一次比较，变化后同步进入saveReferencedPayload又对old/next各一次；无await或输入变动。另saveNodeReferences直接进入helper仍需要其一次展开。

建议：本次保存显式携带old/next引用状态，在两个真实caller各建立一次，helper复用；不新增optional/unchecked快捷入口。

必须保留：referencesAreValid精确目标type检查；旧新目标联合授权；原node/edge版本与跨await contentCurrent；固定请求差量与幂等重试

证据入口：同步完整生产链已核对，计数脚本可增补但无待确认前提。

<a id="g45"></a>
### G45 — 固定字符串split后的空数组检查恒假

性质：低影响小项。范围：运行代码。原始记录：U19。

位置：[apps/ui/state/client-session.ts:1370](../../apps/ui/state/client-session.ts)。

**U19：固定字符串split后的空数组检查恒假**

parts=input.path.slice(1).split('/').map(...)，String.split始终至少一段且map保持长度；此前只有slice迭代未修改parts。!parts.length不可达。

建议：删除!parts.length这一项，不改容器真实类型/缺失检查。

必须保留：实际对象/数组容器检查；节点引用声明路径匹配；原内容版本

证据入口：String split/map语义及局部无变更已核对；不是缺少路径输入校验的借口。

<a id="g46"></a>
### G46 — 公共Map边界未拒绝实际reader必需的边createdAt缺失

性质：行为缺陷。范围：运行代码。原始记录：U20。

位置：[client/graph-client.ts:638](../../client/graph-client.ts)；[apps/ui/features/reader/reader-sources.ts:82](../../apps/ui/features/reader/reader-sources.ts)。

**U20：公共Map边界未拒绝实际reader必需的边createdAt缺失**

map.get边分支仅查id/from/to/kind/sourceAnchors，缺createdAt仍返回成功；readerReadSourceNotes对两条真实后继边排序时直接a.createdAt.localeCompare，运行TypeError。不是让UI新增兜底，而是外部DTO需由所属边界建立真正必要字段。

建议：只对实际消费的GraphEdge.createdAt建立受控外部响应验证；同类字段需逐项实际consumer证明，勿扩成全协议strict validator。

必须保留：有效createdAt排序语义；GraphEdge身份/端点/kind/sourceAnchor原检查；真正历史可省字段；UI不将坏外部DTO静默替成默认时间

证据入口：103/reproduce-ui.cjs用完整合法节点/Map与两条正常后继边，仅省边createdAt；实际client.read成功，readerReadSourceNotes抛TypeError(localeCompare)。

<a id="g47"></a>
### G47 — 2D布局每个节点重新展开同一份Run operations集合

性质：重复/无效逻辑。范围：运行代码。原始记录：U21。

位置：[apps/ui/features/graph/graph-layout.ts:218](../../apps/ui/features/graph/graph-layout.ts)。

**U21：2D布局每个节点重新展开同一份Run operations集合**

placements.map节点回调中每次snapshot.runs.flatMap(run.operations)后find；同一同步布局调用中snapshot.runs/operations不改变，N节点创建N份同一展开数组。SVG fallback是真实生产路径。

建议：在本次布局调用中先展开一次，节点仍按原顺序find第一份活动Operation，不引入新索引协议或缓存生命周期。

必须保留：只关联running/waiting输入Operation；多个Operation的原first匹配次序；snapshot.runs真正可省；不修改源数组

证据入口：完整布局map与readonly输入链已核对，属于重复遍历，不声称已有性能基准收益。

<a id="g48"></a>
### G48 — 旧branch proof测试被无关坏node日期提前拒绝，未隔离目标条件

性质：低影响小项。范围：测试。原始记录：U22。

位置：[tests/client/graph-client.spec.ts:430](../../tests/client/graph-client.spec.ts)；[tests/client/graph-client.spec.ts:432](../../tests/client/graph-client.spec.ts)。

**U22：旧branch proof测试被无关坏node日期提前拒绝，未隔离目标条件**

声称验证新snapshot/旧branch配对，但current.nodes中的createdAt/updatedAt为空串，clientAssertNode先报INVALID_RESPONSE；只把branch.mapRevision改为匹配7仍拒绝。用同份fixture改合法node日期后，旧proof拒绝、匹配proof接受，证明该用例当前可能假绿。

建议：未来修复时提供合法node日期，仅破坏branch.mapRevision目标条件，并保留匹配proof正例；同类故障注入需先建立正常对照。

必须保留：node日期外部响应校验；snapshot/branch同次内容配对；U20当前positive edge缺日期仅是必要边界补齐后的fixture调整，不是当前失败

证据入口：103/reproduce-ui.cjs实际client四象限对照：坏日期+旧/匹配proof都INVALID_RESPONSE；合法日期+旧proof拒绝；合法日期+匹配proof接受。

<a id="g49"></a>
### G49 — 固定会话fixture捕获的基础mock实现仍走optional调用分支

性质：低影响小项。范围：测试。原始记录：U23。

位置：[tests/client/session.spec.ts:351](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:522](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:582](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:628](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:686](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:716](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:907](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:1744](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:1828](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:1861](../../tests/client/session.spec.ts)；[tests/client/session.spec.ts:1898](../../tests/client/session.spec.ts)。

**U23：固定会话fixture捕获的基础mock实现仍走optional调用分支**

这里只针对本文件实际构造链：fakeGateway在162/184行用vi.fn(async...)初始化read/dispatch；opened/openedSource/openedChildren均返回这些mock，捕获getMockImplementation前无mockReset。因而11处normalRead/normalDispatch?.的undefined静默分支不可达。不是声称vi.fn一般必有实现，也不将测试边界失败哨兵判冗余。

建议：如整理fixture，可保留具名基础read/dispatch实现供包装器直接调用；不使用非空断言或新增guard，也不值得为该低影响项单独扩展框架。

必须保留：vi.fn一般允许无实现的真实能力；意外query/command明确失败；其他可替换handler及故障注入的missing检查

证据入口：完整逐段读本文件，逐一追踪11次getMockImplementation捕获到初始化；无mockReset路径。

<a id="g50"></a>
### G50 — 活动布局拖动在外壳卸载后仍更新状态并保存旧布局

性质：行为缺陷。范围：运行代码。原始记录：U24。

位置：[apps/ui/composables/usePanelResize.ts:80](../../apps/ui/composables/usePanelResize.ts)；[apps/ui/composables/usePanelResize.ts:105](../../apps/ui/composables/usePanelResize.ts)；[apps/ui/composables/usePanelResize.ts:114](../../apps/ui/composables/usePanelResize.ts)；[apps/ui/composables/useBottomDockResize.ts:64](../../apps/ui/composables/useBottomDockResize.ts)；[apps/ui/components/shell/ResizableSplit.vue:25](../../apps/ui/components/shell/ResizableSplit.vue)；[apps/ui/components/shell/ResizableRowSplit.vue:21](../../apps/ui/components/shell/ResizableRowSplit.vue)；[apps/ui/views/WorkspacePage.vue:764](../../apps/ui/views/WorkspacePage.vue)。

**U24：活动布局拖动在外壳卸载后仍更新状态并保存旧布局**

AppShell17/18持有两composable，分隔条mousedown同时安装move/up和恢复userSelect的up监听；仅mouseup移除。WorkspacePage739/764在bootstrap变null时真实卸载AppShell（当前401可在拖动中发生）。usePanelResize卸载仅重置userSelect，bottom与split无卸载清理。原composable真实Vue mount/unmount复现：卸载后留3个window监听，后续mousemove修改已卸载ref，mouseup还写localStorage。

建议：单次拖动持有可统一结束的监听所有权，正常mouseup保存，组件卸载清理当前监听及文本选择；避免引入新的默认/异常吞没。

必须保留：正常拖动范围约束与mouseup持久化；storage不可用时内存布局仍可用；左右方向差异；不声称mouseup后仍存在永久泄漏或已证明blur影响

证据入口：103/reproduce-ui.cjs使用真实Vue自定义renderer驱动实际composable hooks、原SFC onMouseDown与本进程EventTarget。left卸载后200→250、bottom132→182，各残留3监听且mouseup写1次，输出末2行。

## 前轮 14 组主要问题与 7 处小项对账

全部 21 条已按当前源码重新确认。原条目与本轮合并主题的对应如下；保留它们不表示本轮已经修复。

| 原条目 | 内容 | 本轮主题 |
|---|---|---|
| Q01 | 合法端口名与原型同名导致运行报错 | [G01](#g01)（P01） |
| Q02 | UI原型同名键写入丢失/继承对象写入 | [G01](#g01)（U10） |
| Q03 | 通配资产媒体约束失效 | [G08](#g08)（D03） |
| Q04 | SSE次生清理覆盖协议错误 | [G02](#g02)（U11） |
| Q05 | 删除资产逐图编译目录 | [G06](#g06)（D01） |
| Q06 | 候选即时自动发布重复解析与扫描 | [G07](#g07)（D02） |
| Q07 | HTTP委托重复解析信封 | [G26](#g26)（R02） |
| Q08 | Host续租同响应重复校验 | [G25](#g25)（R01） |
| Q09 | 证据输入重复对象形状检查 | [G17](#g17)（P03） |
| Q10 | 客户端续租DTO重复扫描 | [G34](#g34)（U05） |
| Q11 | 运行目录Map身份二验 | [G30](#g30)（U01） |
| Q12 | 来源定位修改字段双解析 | [G31](#g31)（U02） |
| Q13 | Reader ready后重新证明上下文 | [G32](#g32)（U03） |
| Q14 | 连接成功时死active清理 | [G33](#g33)（U04） |
| Q15 | 动态字段添加不可达schema回落 | [G35](#g35)（U06） |
| Q16 | 单页可打开重复loading检查 | [G36](#g36)（U07） |
| Q17 | 基线单根长度重复检查 | [G37](#g37)（U08） |
| Q18 | 同一读取异常重复归一化 | [G38](#g38)（U09） |
| Q19 | 理由重复非空检查 | [G19](#g19)（PM01） |
| Q20 | 固定collect又防御其他方法 | [G20](#g20)（PM02） |
| Q21 | 布局已存在父节点的零回落遗留 | [G39](#g39)（U12） |

## 必要保留与证据不足

鉴权/授权写栅栏、Receipt 优先与输入摘要、CAS 最终条件、真实历史/可选字段、跨异步阶段的身份与租约复核、未知存储/响应边界、导入重映射后新值校验，均按实际合同保留。不同阶段或不同值的验证没有仅凭语法相似列为重复。

完整保留、待确认及调用链依据见 [decisions-and-flows.json](./decisions-and-flows.json)。下列待确认/排除项不作为删除建议：

- workReadStage未匹配slot时构造默认Work：当前生产构造器保持slots/workIds配对，但stored graph浅schema不覆盖planSlots；须区分明确支持旧记录和损坏记录，不直接删除默认。（scope-domain.json）
- editor过期null分支：Mongo storeReadIso拒null，但SQLite仅浅验ownerships并返回JSON，可交付editor.expiresAt:null；删除null guard会令Date.parse(null)=NaN且<=now不成立，须先加持久化边界深验，当前不删。（scope-domain.json）
- read-only应用鉴权与graph.read重复读图：ctx.session通常缺省，两个读取并非天然同版本；只有改为单次授权快照并交接文档后才能消除，不直接删除第二次存储边界校验。（scope-domain.json）
- 受控上传测试release缺finally：撤权步骤若先失败，resume未在finally调用，上传generator可能等到test超时；未注入该基础设施失败，不算已复现生产bug。（scope-domain.json）
- message.includes(LEASE_LOST)能否删除？：工作执行器直接HTTP错误在work-executor:97为WorkAccessError；插件businessCall:231仍普通Error含远端code。当前SDK运行时run通常将模型/工具结果作为事件返回，但TransportClosedError仍可携带stderr tail。未证明所有跨进程lease文本只由WorkAccessError承担。（scope-runtime.json）
- 业务插件默认4320是否死默认？：标准Host经work-executor:214明确环境注入；插件apply/patch为独立DSH进程部署资源，仓库未声明只能经Host装配的稳定封闭约束，101也明确保留独立装配。（scope-runtime.json）
- UI-held-assetSchemaHasPointer：直接properties[part]存在同名继承读取形态，但生产caller仅已发布titlePath或已发布asset ref parent的固定mediaType sibling；尚无合法已发布schema下可走错分支的正例，不能与assetSetPointer实际污染证据混列确认。（scope-ui.json）
- UI-held-fixed-digest-sharing：两次SHA计算分别绑定当前ETag与冻结basis；若未来ClientFile携带公共已验证digest并统一desktop才可共享，不是现状可直接删校验。（scope-ui.json）
- UI-held-resize-blur：U24已用真实unmount确认活动drag残留并在mouseup后清理；没有声称blur/窗口外松开永久泄漏，不用未复现情形扩大结论。（scope-ui.json）
- usage fixture在shared取得后同步装配app是否可能实际拒绝：精确函数体可注入任意constructor异常，但实际shared保证就绪connection且同一装配此前已成功，尚无真实独立外部失败条件。保留为结构观察，不据此建议新增catch；E03只计三个真实mkdtemp边界。（scope-root-experiments.json）
- BU01：sourceFiles有不存在workspace-smoke.spec.ts，但tests/client/ui-reporter.spec.ts仍把该固定路径作为白名单正反例fixture使用；仅静态测试坐标，未构造运行兼容机制。（scope-ui-browser.json）

高信号规则仍有两处实际清理双失败可达性证据不足，保留原实现：

- C04:apps/config/local-settings.ts:60:13：lock为本函数唯一持有的真实FileHandle，close释放与unlink锁都必要。若close也拒绝会盖write主错/跳unlink，但尚未证明正常所有权下该FileHandle close双故障可达，不凭finally await计问题；不建议删除清理。
- C04:backend/adapters/messaging/mongo-outbox.ts:143:7：stream.close是实际Mongo游标资源边界，必须执行。已读安装驱动：ChangeStream.close→cursor.cleanup，killCursors错误被squash，隐式session.endSession仍可传播。未建立实际session-close双失败复现，不能仅凭finally await确认盖致命QUEUE_HANDLER；保留此清理并记录证据不足。

## 复现与限制

10 份隔离复现脚本最终组合均正常退出；命令、输出、stderr、退出码与时间见 [reproduction-runs.json](./reproduction-runs.json)。**这是观察缺陷/重复工作的审计证据，不是修复后的产品绿色验收。**

复现使用实际导出函数、实际公共客户端、受控回环 HTTP、已有存储/runner seam、Vue 内存 renderer，或精确源码函数体的受控依赖。每份记录分别注明这些层次；没有运行真实 Mongo/Rabbit/模型/浏览器/桌面打包，也没有把函数体故障注入称作完整集成测试。原型字段只在自有子进程内使用并清理。

本轮未重跑产品测试套件，未用历史 370 项测试通过充当当前证明。没有改业务/测试/构建实现，所以本轮验证针对审计工件、隔离复现与源码未变性。

语义限制包括：第三方 SDK 的全部跨进程错误传播、真实浏览器/GPU/桌面生命周期、任意部署历史数据及全部故障组合未被穷举。尚不能证明多余的行为保留或明确列为证据不足，未以“看着像兜底”删除。

## 可核对工件与重跑

- [inventory.json](./inventory.json)：固定清单、SHA-256、函数及导入索引；[coverage.json](./coverage.json)：301×7 记录。
- [findings.json](./findings.json)：合并主题及全部原始证据；[raw-findings.json](./raw-findings.json)：分区原始记录；[prior-findings.json](./prior-findings.json)：21 条对账。
- [rule-candidates.json](./rule-candidates.json) / [rule-review.json](./rule-review.json)：214 个高信号候选与逐项结论；[candidate-index.json](./candidate-index.json)：通用 AST 导航。
- [decisions-and-flows.json](./decisions-and-flows.json)：必要保留、待确认及完整调用链；`cross-review*.json` / `runtime-cross-review.json`：独立交叉记录。
- [verification.json](./verification.json)：覆盖无空项、源码/上下文无漂移、无范围外新增源码、候选无漏项的最终结果。

```sh
node develop-docs/103-全库审计/candidate-rules.cjs
node develop-docs/103-全库审计/run-reproductions.cjs
node develop-docs/103-全库审计/finish-audit.cjs --final
node develop-docs/103-全库审计/render-report.cjs
```

`index-sources.cjs` 是建立新审计基线的工具，会重写初始清单；验证本轮时不要用它替代哈希核验。源码改变后，本轮结论不能自动沿用，应重新审核受影响文件与调用链。

本轮只新增 103 审计工件并维护编号。未提交、推送、部署或迁移用户数据。
