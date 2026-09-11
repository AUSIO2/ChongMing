# 053 — 动态核查路由实施原稿

对应[设计](./053-动态核查路由.md)。本任务修正必需动态路由能力，不继续固定两slot方案。

1. 定义严格configuration/profile/tool/route/report/merge契约及配置化prompt。
2. Run冻结配置/输入；route提案和路由Review；按批准slots收报告；汇总Agent独立提案；结果Review与原子接受。
3. 保留Run历史与结果意见出处，阻止Run ID复用；内部提案CAS冲突重读校验。
4. 修改HTTP解析/内部Bearer与角色绑定，完善自定义配置读取。
5. DSH插件读取已冻结configuration，按原生Agent身份约束delegate及toolFilter；独立操作执行器可驱动路由→worker→merge，HITL可持久暂停后继续。
6. 重写旧固定两报告测试，验证1/多slot、配置冻结、非法引用/越权、并发、取消、路由/结果Review、汇总值与历史出处；测试自定义tool的真实注册/过滤。
7. 执行专项测试、类型检查及相关回归。真实外部模型测试需有效本机凭证；不使用已暴露Key，不以mock冒称真实付费模型验收。

暂不新增全局claim loop或改动旧前端；已有数据图读写功能继续回归。只提交本任务文件，保留原先未提交的旧Mapper修改。

## 实施结果（2026-09-11）

- 已替换固定两报告与代码投票：动态route、候选Agent/tool配置、1..maxSlots个报告、独立merger；配置和输入版本随Run保存。
- 已完成route/result两种Review、待审路由修改、结果原子接受、并发报告CAS、已接受提案跨Run幂等重放；并发重复批准返回真实赢家的收据ID。
- Verification保留所有意见、Agent/角度/授予工具出处，graph.apply只改reason时可原样保留意见。
- 已接通原生DSH startContinuable；同步Agent创建钩子按实际作用域校验工具，guard约束真实调用者，禁止模型自报operation/slot。通用DSH服务与单operation业务执行器各自装配。
- 新增 `npm run dsh:verify -- --map-id ... --operation-id ...`；人工批准后以新DSH进程读取持久化进度继续。

验证：新后端专项24项通过；`npx vue-tsc --noEmit`、`npm run build:check`、`node develop-docs/052-校验契约.mjs`与`git diff --check`通过。专项覆盖13个Run/API场景、5个业务插件场景、2个真实DSH端到端场景及已有通用DSH/图测试。

全仓回归：第一次`npm test`为29文件/79项通过（HITL第二场景加入前）；最后一次29文件/80个断言通过，但旧`tests/electron/agent-registry-service.spec.ts`出现2个EnvironmentTeardownError，调用链为catalog-service→local-agent-service→database/mongoose在Vitest环境关闭后才完成异步加载，命令退出1。该既有间歇问题不算通过，也未以修改旧Mapper生产代码掩盖；本轮新后端专项独立验证。

端到端使用实际官方DSH CLI/SDK、DeepSeek协议适配器、原生子Agent、真实插件工具执行和Mongo；只把模型HTTP响应替换为本机确定性SSE服务。auto与HITL都跑3个worker及独立merger；HITL验证两个不同OS进程、路由批准前无工具调用、结果批准前不生成Verification。尚未使用真实外部模型验证路由质量或凭证连通性。

当前完整接口见[053-接口文档](./053-接口文档.md)。自动领取/多Host租约、自定义资产管理界面、旧前端接线与DSH用户preset独立装配不在本轮范围。
