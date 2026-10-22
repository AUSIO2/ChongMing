# 089 Mongo 证据库核心收录闭环实施记录

日期：2026-10-06。状态：本阶段核心实现与自动验证完成。设计见 [089 原稿](./089-Mongo证据库核心收录闭环.md)。

本轮授权开始业务实现，并运行已实现核心用例。范围为四个操作、Mongo 有界查询、工作区权限、固定内容、收据和去重、撤回及真实测试接入。完整压力、匹配/Work/快照/数据交换留后续阶段。

工作区已有前端和后端重构改动；本轮逐文件叠加，不提交、不发布、不迁移用户数据。

## 实际实现

- contracts/evidence-library.ts 定义四操作及固定条目；contracts/client.ts、client/graph-client.ts 接入公共方法、结果映射与响应校验。
- backend/modules/evidence-library 负责收录输入、固定记录、0/1、来源精确版本、定义摘要、依据冻结、含依据去重、相反判断提示、幂等与撤回。
- Mongo query adapter 建立唯一键和过滤/排序索引，直接投影摘要并读取 limit+1 条，不全库解码正文。默认每页 25，上限 100；游标绑定工作区、条件与目录版本。
- application 和 graph-server 装配既有 Mongo 连接、会话及权限事务；HTTP 只提前解析命令授权信封，新命令完整输入与来源验证在合法收据检查之后执行。
- 资产删除使用注入的永久库引用保护；撤回保留固定内容、摘要、来源身份和附件历史。
- 存储记录入口校验条目、收据、目录和资产必要字段；条目校验固定摘要。损坏记录返回 500/EVIDENCE_RECORD_INVALID，不透传坏数据。
- 多语言词项支持 Unicode 字母数字与汉字单/双字；非空无词项查询显式返回空页，空白查询仍浏览库。该检索不承担自然语言适用性推理。

## 实际验证

环境为本机 Node 24.11.1、临时 Mongo 8.2.6 单节点副本集、WiredTiger；没有连接用户部署数据库，没有 RabbitMQ、假库实现或业务结果模拟。

| 验证 | 实际结果 |
| --- | --- |
| 首轮原核心业务用例 | 70/70 通过，166.75 秒；114 总用例中 44 条按阶段筛选未选择 |
| 最终 core.config.ts 复跑 | 70/70 通过，171.02 秒，exit 0 |
| 初版真实 HTTP/公共 client | 4/4 首次通过，2.96 秒 |
| 最终 HTTP 专项 | 8/8 首次通过，4.98 秒，exit 0；新增损坏存储、Unicode 词项与纯标点查询 |
| 现有客户端及资产回归 | 最终 2 文件、18/18 通过，4.37 秒，exit 0 |
| 生产 vue-tsc --noEmit | 首轮通过；最终复跑通过，exit 0；中途一次并行 UI 改动错误见下文 |
| 独立实验 tsconfig | 最终 tsc --noEmit 通过，exit 0 |
| test:boundaries | 最终架构 110 模块、本机依赖闭包 77 模块通过；消息检查 107 文件、硬编码消息 0 |
| git diff --check | 通过 |

业务测试没有出现首次失败。只读审阅发现持久化结构/摘要校验缺口，已补校验；走读发现原 ASCII 词项会丢弃重音字母与 Cyrillic，且纯标点非空查询会回落到整库，已修复并增加实际 HTTP 回归。原 114 条业务用例未删除、未放宽；阶段配置的 44 skipped 表示未选择后续功能，不计为通过。

途中生产类型复查曾报告 `apps/ui/features/reader/NodeReader.vue:216` 的 TS2367：模板分支已排除 current 后仍比较 current。该文件属于并行工作区改动，本轮没有编辑；随后读取时条件已变更，最终重新运行 vue-tsc 通过。本轮不把其他工作的修复记为库实现。

核心执行命令：

~~~sh
EVIDENCE_TEST_TARGET=experiments/evidence-library-tests/mongo-target.ts \
  node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/core.config.ts
node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/core-http.config.ts
node node_modules/vitest/vitest.mjs run tests/client/graph-client.spec.ts tests/backend/modules/assets/assets.spec.ts
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/typescript/bin/tsc --noEmit -p experiments/evidence-library-tests/tsconfig.json
npm run test:boundaries
~~~

## 后续与未验证范围

完成的是核心后端闭环，未声明完整证据库交付。UI、替代、人工库引用、上下游/使用追溯、匹配、Work/有限计划材料接入、证据集、历史回放、独立库包和组合包继续按 084 推进。当前依据冻结覆盖显式 node/asset/library 与节点的直接资产，深层节点材料闭包在后续接入设计。

未运行其余 44 条、23 组完整业务压力、完整项目 RabbitMQ/DSH 回归、UI 人工验收、构建或桌面打包。核心 seed 仅支持 usages=0；未实现动作明确 NOT_IMPLEMENTED，不据此宣称压测可用或容量达标。SQLite 库适配尚未实现，本机库请求明确 EVIDENCE_UNAVAILABLE；已有 SQLite 功能和依赖隔离保持。

未提交、推送或发布；软件版本、用户默认定义和用户存量数据库没有被本轮改写。083 资源恢复问题按用户决定暂不处理。
