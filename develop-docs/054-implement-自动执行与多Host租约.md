# 054 — 自动执行与多 Host 租约实施原稿

1. 增加工作项、grant/proof和Run错误类型；从route/reports/draft推导工作资格。
2. Mongo增加独立leases字段与服务端时钟claim/renew/release；给业务commit增加固定grant原子围栏。
3. 接内部work接口；data.read/propose取消自报role/slot，校验grant并投影工作状态。
4. 把DSH业务执行器改为一个授权角色工作，删除data_delegate及无授权CLI路径，保持动态profile/tool；Abort关闭共用同一Promise。
5. 增加Host常驻领取/续租/失败处理/关闭入口，人工批准后无需手动调用执行器。
6. 改现有API与DSH测试调用方，增加真实Mongo多Host租约竞争、取消/过期/幂等与原生DSH并行自动执行验收。
7. 更新完整接口和运行文档，执行后端专项、类型、构建与相关回归；按既定规范只提交本阶段改动并push。

代码依然复用已有mongoose、官方DSH和Vitest；不引入队列、记忆插件或旧Mapper依赖。

## 实施结果（2026-09-11）

- 工作从当前Run事实推导为router、各未完成slot和merge；新增Host常驻入口，每项用独立DSH根进程执行冻结profile。两个Host能够同时处理同图不同角度，公开API未增加命令。
- lease与业务字段分开更新，Mongo服务器时间判断过期，fence递增；新写入在最终CAS中同时校验租约、Run及图版本。连接固定primary读取与majority写确认。
- 新增内部work claim/read/renew/release/fail，数据桥只接受grant头。work.read确认历史收据，不需重新读取已被编辑或删除的历史Claim。旧fence可确认相同已接受业务内容，不能新增写入。
- DSH关闭使用共享Promise；Host续租失效/截止/停机后Abort，待执行器退出再释放。临时数据API错误用WorkAccessError保留Run可继续；普通模型/配置最终错误才记录failed。
- 删除data_delegate和无grant的dsh:verify入口，改用npm run host:serve。路由仍动态选择自定义Agent/tool；只把跨Host执行权移到租约边界。

验证记录：

1. `npm test`：32个文件、95项测试全部通过（本次未出现上一阶段旧测试的teardown错误）。
2. `npx vue-tsc --noEmit`、`npm run build:check`、`node develop-docs/052-校验契约.mjs`和`git diff --check`通过；054文档相对链接逐项存在。
3. 真实Mongo覆盖抢占、同图两个slot、报告与续租并发、自然过期接管、最终CAS前失租/取消/失败、跨fence幂等确认及历史work.read。
4. 两个真实Host OS进程/独立DSH目录，真实官方DSH与自定义工具：auto、HITL、SIGKILL崩溃三场景。工具时间区间证明跨Host重叠；崩溃后另一个Host到期接管，仍只有3个有效报告与1个结论。测试仅按自己记录的PID清理孤儿DSH，不承诺外部工具恰好执行一次。
5. 三节点wiredTiger真实副本集stepDown：新主与新连接读到完整已确认报告/收据/租约；自然过期后fence+1，旧proof拒绝，新持有者成功提交。

模型端点使用本机确定性fixture，不把协议/执行测试当成真实外部模型质量验收。尚未接旧前端、用户权限/资产UI、parse/split与产品通知流。当前完整协议和部署参数见[054-接口文档](./054-接口文档.md)。
