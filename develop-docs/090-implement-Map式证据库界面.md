# 090 Map 式证据库界面实施记录

日期：2026-10-06。状态：首轮界面实现及自动/浏览器验收完成。设计见 [090 原稿](./090-Map式证据库界面.md)。

用户已授权开始实现 Map 式证据库界面。本轮在既有未提交改动上逐文件叠加，分工处理共用画布、库状态/内容和页面装配。已有默认定义恢复问题不在本轮处理，软件版本和用户数据不改写。

## 实际实现

WorkspaceSidebar 提供证据库固定入口，与 Map 标签共用 WorkspacePage/AppShell。库复用 GraphScene 的三维展示、选择、键盘、双击及返回定位；GraphScene3D 继续包装真实 Map，原 GraphCanvas/活动降级保持。新的默认 SVG 场景只消费展示布局，没有制造普通 Map 快照。

EvidenceLibraryView 提供关键词、固定 0/1、主体/事件、显式历史筛选、25 条分页和已加载数量。选中读取 evidence.get，固定单页复用 DataPayloadView；右栏展示固定判断、范围、理由、依据、出处及收录/撤回记录。null 范围显示“未注明”。当前接口没有关系查询，图中只有实际条目节点，连线为 0。

Map 的 Claim 操作提供收录对话框；用户明确选择 0 或 1、输入理由、范围和可选人工依据。收录成功打开返回的库条目。库详情可以撤回，撤回后原文/判断/摘要保持，默认搜索排除，显式历史可读。库权限依据 workspace 成员角色，与 Map 的消息连接状态和编辑租约独立；写命令仍由生产服务完整鉴权。

evidence-state 统一持有取消、身份/读取/选择代次、筛选草稿、分页和稳定命令重试。同身份往返保留画布数据及筛选，返回刷新所选条目；用户、服务或工作区变更清除固定内容及筛选。401 通知会话退出；不自动改写版本或重试 409。撤回确认更新摘要，但不会抢回后来选中的条目或取消其在途读取。

页面收录/重试捕获原对话框目标；取消或来源变化后的迟到确认不跳回库。来源定位捕获导航代次，后续导航使旧跳转失效。权限降级关闭收录草稿。库目录因命令失效时提供刷新列表，不宣称已有页是完整结果。

## 自动验证

| 验证 | 最终结果 |
| --- | --- |
| 窗口状态 | 31 用例通过：身份/服务/工作区及筛选隔离、取消、迟到响应、分页 0、权限、稳定重试、撤回选择竞态 |
| 固定呈现与收录输入 | 8 用例通过：0 原文、精确类型、历史状态、未知范围、plain 参数和时间输入 |
| 共用场景与原 Map 布局 | 新 4 + 原 4 用例通过 |
| 新真实 Mongo/HTTP 界面状态 | 3 用例通过：Map 收录 0、固定详情/撤回、26 条分页、viewer、已提交响应丢失后的同收据重试 |
| 公共客户端及来源阅读回归 | 17 用例通过 |
| 最终合并执行 | 7 文件、67/67 通过，4.25 秒，exit 0 |
| 生产 vue-tsc | 最终通过 |
| tests/client/tsconfig.evidence.json、独立实验 tsconfig | 最终严格 tsc 通过 |
| 架构与消息边界 | 118 模块、77 本机闭包模块通过；110 文件硬编码运行消息 0 |
| Web 构建 | 通过，输出仅在忽略的 .data/evidence-ui-web-build；未打包或发布 |
| 差异卫生 | git diff --check 通过 |

实际执行入口：

~~~sh
node node_modules/vitest/vitest.mjs run tests/client/evidence-http.spec.ts tests/client/evidence-state.spec.ts tests/client/evidence-presentation.spec.ts tests/client/evidence-scene.spec.ts tests/client/layout.spec.ts tests/client/graph-client.spec.ts tests/client/reader-sources.spec.ts
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/typescript/bin/tsc --noEmit -p tests/client/tsconfig.evidence.json
node node_modules/typescript/bin/tsc --noEmit -p experiments/evidence-library-tests/tsconfig.json
npm run test:boundaries
CHONGMING_WEB=1 node node_modules/vite/bin/vite.js build --outDir .data/evidence-ui-web-build
~~~

## 首次失败与修复

状态首跑 20/21：本地游标错误用普通 DTO 抛出，公共 clientReadError 将其归为 CLIENT_ERROR。改用 ClientError 后复跑通过。并行阶段一次 vue-tsc 报 state 中依据 ref 联合类型未充分缩窄，修正分支后通过。

新增真实 fixture 被测试配置的 ES2020 lib 拒绝 AggregateError/replaceAll；专项改用实际 Node 环境对应的 ES2022 lib 后通过。预览入口首次以 .mts 命名导入仓库 CJS fixture 失败，改用 .ts 及 async 启动入口后真实服务正常运行。

只读审阅实际复现了“撤回 A 在途、选择 B、A 确认抢回 A”；新增 B 已读及仍在途两种时序，并修复选择代次。另修复收录重试取消后的跳转、来源导航代次及权限降级表单。浏览器发现跨用户保留筛选草稿，已补 user/service/workspace 三个断言及清理。

最终一次 66/67：不可用提示改为用户可操作的服务说明后，旧测试仍要求文案含底层 MongoDB。同步产品文案断言，并保留 EVIDENCE_UNAVAILABLE/503 与禁止盲目重试的行为检查；最终 67/67 通过。原独立 114 条业务用例没有修改或删除。

## 真实浏览器验收

使用 ui-preview.ts 启动临时 Mongo 8.2.6 单副本集、真实 HTTP 和公共网关；只写合成 Claim。IAB 实际呈现 WebGL 三维球体、固定 0/1 标签、选择与单页。验收了来源 Map 的未收录 Claim → 表单明确 0、理由/范围/人工依据 → 自动定位库条目 → 0 筛选 → 固定单页 → 撤回 → 原正文仍可读及历史图节点。

另验收 viewer 能读取且无撤回按钮；退出后内容消失；换用户不保留旧筛选；空白 workspace 显示 0 条并无旧详情。截图保存于忽略目录 `.data/evidence-library-ui.jpg`，仅含临时测试身份与合成内容。

预览没有配置 RabbitMQ，因此 Map 现有 SSE 返回不可用；没有把此环境宣称为 Map 实时同步验收。库收录/撤回不依赖 MQ，已在这个实际条件下验证权限和闭环。浏览器验收使用实际默认窗口大小；没有强制修改浏览器视口。SVG 降级仅做源码与布局验证，未在浏览器强制关闭 WebGL。

## 后续边界

真实上下游、库条目替代、Work 选材、使用索引、证据集和导入导出继续 084 阶段 C/D/E/F。SQLite 库适配仍未实现，界面如实呈现服务不可用。没有进行完整压力、全项目 RabbitMQ/DSH、Electron 打包或发布；不复用 089 的结果宣称本轮整体回归完成。

本轮未提交/推送、未发布新版、未改写默认定义或用户数据库。临时 HTTP、Vite、Mongo 和令牌目录在验收后关闭清理。
