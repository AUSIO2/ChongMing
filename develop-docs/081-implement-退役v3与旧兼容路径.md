# 081 — 退役 v3 与旧兼容路径实施记录

日期：2026-10-04。设计见 [081](./081-退役v3与旧兼容路径.md)。

## 起点

保留 079/080 未提交修改。080 的全量 302 个测试及收尾 59 个回归曾通过；本轮审计另确认 session 测试仍有两处旧 Run 类型错误。

## 已完成

1. 导入统一使用严格 v4 解析器，删除 bundlesConvertV3、LegacyReport 和固定旧业务转换。界面及 README 明确只接受 v4。两个 v3 格式均验证拒绝、重复拒绝，以及工作区/图/资产/收据/GridFS 无新增；v4 仍覆盖权限、重放与输入冲突。
2. 删除 data.migrate-node-runs、repairMigrateNodeRuns 和 legacy-run-configuration.ts，maintenance 仅保留显式新闻上下文修复。统一迁移保留 run、多个 runs[]、runHistory 的身份和顺序，报告/Review/原配置保存在完整终态归档。双容器、重复身份、双 Operation 格式、新旧混合、旧活动 Run 和有效租约均明确阻断。迁移错误指引改为 data.migrate-branches，部署定义包改为必填。
3. Agent 草稿保留 role/bindings 及其嵌套引用；agent-editor.ts 根据精确绑定展示阶段输出合同和变量交集。旧 Bootstrap 提案样例与无人消费元数据删除；共享库没有定义查询 API 时显示未解析绑定说明，不用其他工作区的目录冒充。已绑定 Agent 的变量按阶段校验，未绑定配置继续遵守当前 kind 规则。
4. 删除画布 synthetic、selectId、displayFrom、displayTo，选择直接使用真实 id。删除 branchValidateImpact，原范围冲突测试改为调用生产使用的 branchValidateMutation；删除 configuredSlots 及退休迁移留下的 verificationSlots/VerificationSlot。清理 75 个无引用 RuntimeMessage，删除失去消费者的 CONTROL_PROMPT_KINDS。
5. session 两处旧 Run 夹具替换为当前计划、冻结规格、阶段结果与审核结构；layout 运行夹具补齐分支与预算。重点测试的严格类型检查同时修复已存在的 payload 推导过窄、mock 无参数元组、DiagnosticReporter 假实现缺少返回编号/close 的问题。
6. 交叉审阅修复确认切换绕过 busy 锁的竞态：agentUpdateSelection 先检查 locked，确认按钮同样禁用，避免旧保存响应污染新作用域。

## 保留项及原因

引用索引重建本轮保留。旧 Mongo 的 default: [] 可能把“未生成索引”持久化成“空索引”；仅要求字段存在无法证明索引正确，直接删除重建会遗漏跨分支引用。后续必须通过离线重算、活动 Run/租约校验和可验证的存储升级边界统一退役。本轮没有把停止 v3 数据包导入扩大成所有现有数据库格式失效，也未对用户数据库执行任何迁移。

kind 分类仍被当前 seed 和未绑定 Agent 管理使用，保留真实业务依赖；已绑定 Agent 不再错误套用旧变量白名单。历史终态归档及必要 schema 拒绝也保留。

## 测试替换依据

- 旧 v3 转换成功用例改为版本拒绝及无写入验证，v4 引用/摘要/资产一致性用例保留。
- 旧中间格式 Run 的成功用例改由统一迁移验证归档身份、报告、Review 和历史；旧暂停迁移改验终态要求；真实 Mongo/SQLite 和 CLI 覆盖原子拒绝、dry-run/apply 与幂等。
- branchValidateImpact 的旧测试迁到完整变更校验，没有删除范围越界的行为覆盖。
- 旧 Bootstrap 外壳断言改为当前变量能力；新增编辑草稿隔离、三种 OutputContract、绑定精确版本、自定义阶段变量及错误变量拒绝的回归。

## 验证记录

- v3/v4 资产专项：3 文件、14 个测试通过；迁移/新闻修复专项：18 个测试通过；管理及工作区专项：30 个测试通过。根代理分支/会话/布局/客户端专项 51 个测试通过。
- 首次迁移专项出现一条测试夹具别名问题：意见和报告共享对象，原地修改同时改动两份数据。改为替换一份报告后复验通过；迁移测试类型问题也已修复。
- 初次 Agent SFC 检查遇到递归 schema 导致 Vue 深层解包超限，目录改用 shallowRef 后通过。
- 根代理重点测试类型检查先发现 layout payload 默认值推导过窄、查询 mock 参数元组及旧 DiagnosticReporter 假实现问题；均已修复，不通过断言放宽生产边界。
- `npm test` 全量：53 文件、309 个测试全部通过，包含架构/消息检查。收尾管理单元 12 项复验通过。
- 最终 `vue-tsc --noEmit` 通过；11 个重点测试入口使用 `tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --resolveJsonModule` 类型检查通过（同时检查其传递依赖）。`npm run test:boundaries` 与 `git diff --check` 通过。
- 未执行桌面安装包构建或手动 UI 验收。
