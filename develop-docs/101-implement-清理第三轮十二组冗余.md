# 101 — 清理第三轮十二组冗余实施记录

对应[设计](./101-清理第三轮十二组冗余.md)。

## 执行清单

- [x] 后端 6 组：使用记录投影/构造、payload+引用、运行输入、当前 Run 发布类型、私有数组。
- [x] UI 3 组：使用记录重复检查、阅读字段重复读取、空 pointer 死分支。
- [x] MQ 严格枚举行为修复与回归。
- [x] SSE 回调异常分类修复与私有可信类型收口。
- [x] 相关测试、类型、边界/文案、差异及交叉审查。

## 实施与验证结果

12 组全部完成，保留之前的功能修改和 publication preview。

| # | 已完成内容 |
|---|---|
| 1 | MQ 种类直接验证字符串字面量，数组不能借字符串化绕过 graph/workspace/activity 必填约束。 |
| 2 | SSE 只在网络建立、错误响应读取和正文读取处转换网络故障；本地观察回调原样失败，解码尾部的消费也移出解码 catch。取消、关闭、超时优先级及读取器清理保留。 |
| 3 | 已验证 EvidenceUseDocument 的公共投影直接复制公开字段，不重复解析摘要。 |
| 4 | 使用记录不再完整自解析和重复计算摘要。保持 identityHash 去重优先；真正跨合同的 Summary、NodeSnapshot 仍各解析一次，投影一致性检查保留，两个 hash 各计算一次后直接插入。 |
| 5 | 完整正文解析同时返回 payload 和 refs，图专用入口同时生成索引并要求对象根。证据冻结、图写入、Run 发布及导入复用同份结果；graph.apply 同一 attempt 的 proof 与修改也共用初始解析状态，新 put 仍完整校验。 |
| 6 | runReadData 复用 runValidateInputs 已取得的节点，不再次逐引用查找和验证。 |
| 7 | 私有发布链接收 GraphCurrentRun，删除空范围补偿和不可达旧结构报错。 |
| 8 | 私有 toInstances 接收已有数组，删除可选参数和空数组默认值。 |
| 9 | 使用记录 UI 删除网关已完成的 DTO/身份检查；代次、取消和 usageRevision 检查保留。坏 DTO 回归移至真实客户端边界，覆盖未减少。 |
| 10 | 阅读 helper 只整理路径并去重，调用方单次读取及过滤实际字段。 |
| 11 | 删除 payloadReadPointer 上一行已经排除的空字符串分支，保留未提供和非法路径语义。 |
| 12 | 私有信封明确为自建对象，DTO 身份比较与首次验证合并；预览只声明实际已验证的身份字段，公开 params 的形状及错配检查仍保留。 |

## 真实边界与所有权

- 新正文入口始终完整验证 JSON/schema，没有跳过校验的开关或 unchecked 导出。图协议要求对象根；通用 schema 仍允许合法标量。
- `graphParseNodes` 返回当前 attempt 独占的节点和引用；分支证明使用其权威索引，修改阶段复制对应状态，新节点替换同时更新正文和引用，不污染旧图。
- GraphStore 对历史节点/上下文的保证弱于 EvidenceUse 合同，因此保留 Summary/Snapshot 的必要解析。`isDeepStrictEqual` 保留原摘要比较隐含的“不能静默丢失额外 metadata”约束，不重新计算第二份摘要。解析位于使用身份去重之后，未改变已有记录直接返回的顺序。
- 查询只为四类需要匹配身份的方法冻结小型参数；使用 `structuredClone` 保留数组/null 的实际种类，避免浅 spread 将坏参数变成普通对象，调用后的参数修改也不改变已发请求身份。没有复制命令或大正文。
- 未修改 GraphDocument 的真实可省略字段、显式迁移、DSH 独立装配或错误文本兼容候选。

## 回归与验证

- MQ 新纯解析回归在旧实现为 5 失败、2 通过，修复后 7 项全部通过；最终真实队列完整套件 14 项全部通过。
- SSE 观察回调回归在旧实现失败（被改为 NETWORK_ERROR），修复后 8 项全部通过；实际 fetch/read 故障仍可重试，协议/取消/认证约束保留。
- 相关最终组合：22 个测试文件、263 项全部通过，包含客户端/SSE、UI、图/Run/发布、资产/包、引用、分支重放和真实队列。
- 独立 Mongo 使用历史：33 项全部通过，含坏 Mixed metadata、UUID、时间的必要边界回归；HTTP 核心：8 项全部通过。与最终组合不同配置，共 41 项。
- 更早的 UI 7 文件 72 项、客户端 6 文件 134 项、后端 10 文件 87 项均通过，与上述有重叠，不重复累计。
- `npx vue-tsc --noEmit`、`npm run test:ui:types`、experiments TypeScript 通过。
- `npm run test:boundaries` 通过：132 个模块、120 个运行文案文件，无新增硬编码错误文案。
- `git diff --check` 通过。客户端及后端经其他代理只读交叉审查。

必要坏元数据测试首轮将未知字段加到 Mongoose 会过滤的节点顶层，未命中目标边界；改为实际保留的 Mixed metadata 注入后，完整回归通过。没有删除该断言或放宽错误接受范围。

最终组合命令：

```sh
caffeinate -is node --import tsx tests/run.ts tests/client/stream.spec.ts tests/client/graph-client.spec.ts tests/client/files.spec.ts tests/client/evidence-relations-client.spec.ts tests/client/evidence-uses-client.spec.ts tests/client/evidence-uses-state.spec.ts tests/client/reader-sources.spec.ts tests/client/layout.spec.ts tests/client/data-payload.spec.ts tests/apps/desktop/ipc-handlers.spec.ts tests/backend/modules/shared/data-definition.spec.ts tests/backend/modules/shared/library-spec.spec.ts tests/backend/modules/graph/graph.spec.ts tests/backend/modules/graph/generic-run.spec.ts tests/backend/modules/graph/run.spec.ts tests/backend/modules/graph/library-claim-run.spec.ts tests/backend/modules/graph/library-commit.spec.ts tests/backend/modules/graph/source-anchors.spec.ts tests/backend/adapters/storage/branch-rebase.spec.ts tests/backend/modules/assets/bundle-v4.spec.ts tests/backend/modules/assets/asset-v4-integration.spec.ts tests/backend/adapters/messaging/queue.spec.ts
```

本轮按实际改动运行相关测试，没有重跑全库长时套件、人工 GUI 或打包验收。没有调高超时、增加重试或跳过失败。

## 原有改动与恢复

实施前差异和未提交文件副本位于本机临时目录 `chongming-before-final-12-1uo2apmd`。只叠加本轮必要修改，未重置原有源码或功能测试；没有迁移用户数据、提交、推送或部署。
