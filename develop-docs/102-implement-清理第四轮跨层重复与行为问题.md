# 102 — 清理第四轮跨层重复与行为问题实施记录

对应[设计](./102-清理第四轮跨层重复与行为问题.md)。

## 执行清单

- [x] 客户端 3 组：UTF-8 分类、下载清理、响应重复形状校验。
- [x] 后端 4 组：跨层正文解析、导出目录、导入解析、审核发布计划。
- [x] 运行及 schema 3 组：原型键、严格枚举、DSH 不可达路径。
- [x] UI 4 组：预览投影、ready 状态、required 字段、primary 字段。
- [x] 必要边界交叉审查、相关回归及静态检查。

## 实施与验证结果

### 已完成实现

- 客户端将证据条目、关系和使用详情交给各自完整解析器；其余响应将 scope、items、plan、definitions、fence 等形状检查留在真实所属方法，启动 settings 复用 settings 解析入口，移除通用扫描后的重复检查。保留必要字段、请求身份绑定、分支/快照版本配对以及协议错误分类。
- 普通 JSON 的块内及末尾 UTF-8 解码失败返回不可重试的 INVALID_RESPONSE；真实读取失败仍按网络、取消、关闭、超时区分。JSON 与下载都在结束时取消未读完内容并释放锁，次生清理失败只保护既有主错，不生成假数据、假成功或重试。
- schema 字典采用实际自有条目，JSON/schema 对象构造保留显式 `__proto__`，拒绝继承而未声明的 required、引用与字段。空 required 且无 properties 仍合法。IPC 来源及 Host 队列错误码严格比较原值；删除 DSH 上游已消去的 additionalProperties 对象遍历与写入路径。
- 预览删除已在响应边界验证的重复键检查及无用集合；ready 状态直接持有对应匹配结果。required 初值按已发布顺序建立，并用 Object.fromEntries 保留显式原型同名键；ReaderField primary 的字符串约束由类型承接，展示端不再重复判断。
- graph.apply 的全部 put（含已有节点更新）、Work 正式产物及人工审核产物均携带同次完整解析的节点与引用进入资产检查，不再经 application 和 asset 多次重解析。资产 ready、工作区、媒体类型仍在图提交的同一事务内检查；独立资产检查入口继续完整解析未知正文。
- 导出通过 workspace 的一次快照读取取得目录、精确包体、历史及当前 Agent 和可编辑配置；闭包改为读取这些已配对数据，保留包摘要、生产者与 Agent 依赖检查，取消逐包公开读取及重复目录编译。
- v4 读包明确返回纯协议 bundle 和配对的已解析 maps/nodes/refs；原始正文的引用完整性检查及重写复用同份结果。根对象、4096 成员预算和包体限制保留，身份重映射后的新正文仍按新目录完整解析。未添加 skipValidation、缓存或 DTO 隐式状态。
- 结果审核在一次同步 attempt 内完成输入验证和计划构建；同份计划用于版本摘要与发布。预览版本比较先于审核状态修改，收据优先、无预览版本时的原语义和 CAS 顺序保留。

### 回归与交叉审查

- 新增客户端 5 个核心专项在旧实现全部失败（非法/未完成 UTF-8 两例、下载头拒绝和流超限被清理异常覆盖、读取失败后遗留锁），修复后通过。额外确认未结束的非法 UTF-8 响应会取消流：补充专项首次失败在 cancel 未调用，修复后通过；JSON 超限与响应边界回归也通过。
- schema、IPC、Host 均先复现原型/隐式字符串化缺陷；运行与 schema 首轮 6 文件 78 测通过。
- UI 第一轮 4 文件 27 测通过；交叉审查发现 schema 合法 `__proto__` 需联动表单初值，修正后相关 2 文件 11 测通过（含两个新增正例）。现有审核流程浏览器用例 M04-C10 通过。
- 最终客户端、UI、schema、IPC、Host、DSH 组合共 16 文件 261 测通过；后端资产/包、工作区、图/Run、材料发布与分支并发共 11 个唯一文件 109 个唯一用例通过。合计 **27 个唯一文件、370 个唯一用例通过**，另有 **1 个审核流程浏览器用例通过**。
- 后端新增已有节点写入不存在资产的回滚用例，确认拒绝后内容与收据均不变。该用例首次业务拒绝正确，但对比了领取租约前的 fixture；claim 已补充 payloadReferences，修正为 claim 后的实际基线后通过。未改生产行为规避断言。
- 最终测试类型检查首次发现新增参数化客户端测试的 params 联合推断不符合空参数合同；改为按方法缩窄调用后，6 个相关用例和测试类型检查均通过。
- 客户端、UI 与后端边界已交叉走读；最终主项目类型、测试类型、架构/运行文案及 git diff --check 均通过。未执行全量 npm test 或打包，本次报告仅指下列相关验证。

### 实际验证入口

- 最终 16 文件组合：`caffeinate -is node --import tsx tests/run.ts`，参数为 `tests/client/{graph-client,files,evidence-http,evidence-relations-client,evidence-uses-client,stream,publication-preview,data-payload,payload-labels,reader-sources}.spec.ts`、`tests/backend/modules/shared/{data-definition,library-spec}.spec.ts`、`tests/apps/desktop/ipc-handlers.spec.ts`、`tests/backend/execution/{host,dsh-business,library-contract}.spec.ts`（实际以逐个完整路径传参）。
- 后端首批 7 文件 72 测：`tests/backend/modules/assets/{bundle-v4,asset-v4-integration,assets}.spec.ts`、`tests/backend/modules/workspace/workspace.spec.ts`、`tests/backend/modules/graph/{generic-run,library-claim-run,library-commit}.spec.ts`。
- 后端补测 2 文件 8 测：最终 `tests/backend/modules/assets/asset-v4-integration.spec.ts`（含新增用例）及 `tests/backend/adapters/storage/branch-rebase.spec.ts`；图/Run 正式组合另 3 文件 34 测：`tests/backend/modules/graph/{graph,run,branch-lease}.spec.ts`。前两批包含同一资产测试文件，唯一用例数已去重。
- 浏览器：`npx playwright test --config playwright.config.ts --project=local tests/browser/workspace-acceptance.spec.ts -g M04-C10`。
- 静态检查：`npx vue-tsc --noEmit`、`npm run test:ui:types`、`npm run test:boundaries`、`git diff --check`。

本轮保留全部既有未提交及未跟踪功能，未提交、推送、部署或迁移用户数据。
