# 091 证据库出处与上下游实施记录

日期：2026-10-07。状态：本轮实现与验收完成。设计见 [091 原稿](./091-证据库出处与上下游.md)。

先完成关系/历史用例再开始业务实现。本工作区已有其他未提交修改，逐文件叠加；083 默认定义恢复问题按用户决定暂不处理，本轮使用工作区实际注册 Claim/schema。

## 测试先行

先写独立 Mongo/HTTP 关系用例、UI 状态/呈现用例及公共客户端边界用例，检查后才授权生产实现；没有在接口缺失时伪造功能或执行未实现用例。HTTP 用例口头初报 24，实际 Vitest 收集为 23，按实跑数量记录。UI 初写 18 实例，补根身份/摘要/原版本关联后为 22；客户端为 10。

检查时将跨授权工作区的错误预期校正为既有 get 的 422/EVIDENCE_WORKSPACE_MISMATCH，历史附件保护沿用 409/ASSET_REFERENCED；未为新用例改变已有业务错误语义。原独立 114 条用例未删除或放宽。原 31 个窗口状态用例只扩展关系读取 seam，原 get/search 下标与断言保留。

## 实际实现

- contracts、HTTP、application 与公共 client 增加 evidence.relations，viewer 授权及跨工作区验证沿用 get。客户端检查有限快照、唯一复合身份、实际边/端点、引用种类和查询身份。
- evidence-relations 在收录事务中固定根、显式 node 依据、真实 successor 上下游及 reference/payload 出依赖。优先 root/basis；同一 Map 快照缓存；nodeId 只在声明的 Map 内解释；键绑定 map/node/revision。
- 新记录保存 relationSnapshot，节点/边/锚点/路径纳入固定摘要。复制每个已捕获节点的直接资产元数据并写永久保护引用；原图删除或条目撤回不会丢材料。去重和合法收据重放继续返回第一次快照。
- 严格持久化解析核对根与条目、复合身份、端点闭包、原 GraphEdge、来源锚点和声明引用路径。字段缺失才是旧记录，旧摘要算法保持并返回 snapshot:null；显式 null 或损坏字段返回 EVIDENCE_RECORD_INVALID。
- 128 节点、256 关系、每类路径深度 8 与 visited 限制有限捕获；边界明示 truncated，所有边端点实际保存。固定内容+依据+关系超 1 MiB 原子拒绝。
- 窗口 get/relations 并行，关系错误及重试独立，旧身份/选择/导航不会覆盖当前正文。根身份、内容摘要或精确 ref 不符时拒绝邻域关联。
- 当前根使用实际 entryId，邻域采用该条目下的复合展示 key。场景保留真实 successor/reference；payload/basis 映射为引用。邻域点击、旁栏和单页读取固定 snapshot；原 Opinion 分数不被当作库置信度。旧关系缺失与截断分别提示。

## 自动验证

| 验证 | 实际结果 |
| --- | --- |
| 新真实 Mongo/HTTP 关系专项 | 23/23 首次实跑通过，5.36 秒 |
| 新关系 UI 状态与呈现 | 22/22 通过，含慢关系、旧401、邻域零网络、身份/摘要/ref关联 |
| 新公共 client 关系边界 | 10/10 通过；和原 client 共 22 条通过 |
| 合并界面/客户端/布局/真实HTTP状态回归 | 9 文件、99/99 通过，7.45 秒 |
| 原核心业务专项 | 70/70 通过，168.11 秒；114 总用例中 44 条未来功能按阶段未选择 |
| 原 core HTTP/畸形响应专项 | 8/8 通过，3.11 秒 |
| 生产 vue-tsc、两个专项 tsc | 最终全部通过 |
| 架构与运行消息 | 120 模块/78 本机闭包通过；112 文件、硬编码运行消息 0 |
| Web 构建 | 133 模块通过，1.39 秒；输出仅在忽略的 .data/evidence-relations-web-build |
| git diff --check | 通过 |

命令：

~~~sh
node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/relations.config.ts
node node_modules/vitest/vitest.mjs run tests/client/evidence-relations-client.spec.ts tests/client/evidence-relations.spec.ts tests/client/evidence-state.spec.ts tests/client/evidence-presentation.spec.ts tests/client/evidence-scene.spec.ts tests/client/evidence-http.spec.ts tests/client/layout.spec.ts tests/client/graph-client.spec.ts tests/client/reader-sources.spec.ts
EVIDENCE_TEST_TARGET=experiments/evidence-library-tests/mongo-target.ts node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/core.config.ts
node node_modules/vitest/vitest.mjs run --config experiments/evidence-library-tests/core-http.config.ts
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/typescript/bin/tsc --noEmit -p tests/client/tsconfig.evidence.json
node node_modules/typescript/bin/tsc --noEmit -p experiments/evidence-library-tests/tsconfig.json
npm run test:boundaries
CHONGMING_WEB=1 node node_modules/vite/bin/vite.js build --outDir .data/evidence-relations-web-build
~~~

## 首次失败及修复

测试 fixture 的 role 类型首次推导为宽 string，显式返回窄节点类型后通过。并行接入时生产 tsc 暂报 relationSnapshot 尚未声明；完成记录解析后解决。record 的 pointer 查找变量 found 报 TS7022，补准确 [string,JsonValue]|undefined 类型后通过。UI 受控泛型 query method 不自动缩窄，改用明确三分支窄方法后通过。真实关系 HTTP 首次实跑无失败。

分工期间子任务连接中断过，文件均保留；从原文件继续完成和验证，没有回退到模拟实现，也不将连接中断当成业务测试失败。

## 真实浏览器与历史验证

relations-preview.ts 使用真实临时 Mongo/HTTP，保存 Source→News→Claim→Opinion→Verification、原文锚点、Verification 的 payload 引用和显式 Opinion 依据。浏览器实际显示五节点六关系；邻域意见单页显示原始 0.5，库根仍为固定 0，邻域没有库撤回操作。

随后只在临时环境通过公共 API 删除来源 Map，再读取 relations：删除前后完整 DTO 相同（historyUnchanged=true，5 节点/6 关系）。浏览器退出库、尝试原来源图得到实际缺失提示，再回库重新读取，固定邻域和 0.5 正文仍可见。截图保存 `.data/evidence-relations-ui.jpg`，只含合成内容和临时身份；使用默认浏览器尺寸，未修改系统或浏览器视口。

预览未配置 RabbitMQ，不宣称 Map 实时流或跨 Host 核查验收；库操作与固定关系读取不依赖消息服务。临时浏览器、HTTP、Vite、Mongo 及认证文件在验收后关闭清理。

## 后续边界

本轮完成收录时出处、结构上下游和显式依据/依赖，尚未实现后来跨 Map 核查的使用追溯、替代、Work 选材、证据集及数据交换。捕获是有限历史快照；截断部分不会从来源当前版本补齐。旧条目无关系快照保持明确未知，不迁移或重写用户数据。

未运行剩余 44 条功能、完整压力、全项目 RabbitMQ/DSH 或 Electron 打包。未提交、推送、发布或修改软件版本；083 默认定义恢复问题按用户决定暂不处理。
