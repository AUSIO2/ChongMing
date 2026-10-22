# 104 — 全库 50 个确证主题修复记录

103 审计的 **50 个主题、60 条原始记录均已实施并交叉复核，含 14 组行为问题**。逐项改动及原始站点对应见 [closure.json](./closure.json)，各模块的修改、必要保留与验证见分区记录。证据不足项保留，未引入猜测性默认或旧版本兼容分支。

最终 Node 回归：**96 个文件、975 项通过**。生产类型检查、列明的相关测试类型配置、边界检查、Web 构建及随包 Node/SQLite/DSH 重启和父进程断开验证通过。证据库核心/HTTP/关系/使用/本机用例及浏览器结果分别列在下方；补修后的最后一轮回归已完成。

**浏览器没有全绿。** 全量首轮 85 通过、4 失败、7 条按既有能力条件跳过；枚举旧选择器的两个失败修正后均通过，连接表单的一次失败定向复跑通过但根因未确定。另有一项修复前即存在的授权按钮断言重复失败，产品代码和断言均未为通过测试而改动，详见后文。

## 关键行为结果

- 合法原型同名键按自有字段保存和读取，涵盖 JSON、定义展示标签、端口、投影、表单、迁移归档与压力错误计数。交叉审查发现展示标签漏交接后补修，合法输入先红后绿，全部关联位置重新对账。
- 工作授权先绑定目标 Operation，再读取外部来源；错误 Operation 的来源读取、缓存、收据数均为 0。跨异步最终租约和 CAS 检查保留。
- 资产引用携带具体展开路径与真实父容器，通配数组和字典的媒体约束生效；已验附件 bytes 直接交给写入，重映射后的新值仍完整校验。
- 真实 JSON 字节入口拒绝非法 UTF-8；保留各入口原有 BOM、网络/文件错误和可重试分类。Host 初领建立标识字符串类型，续租只核固定身份与真实时长。
- 枚举保持 JSON 值类型，Map 的实际必需边日期在外部边界验证；迟到 Run 控制权归属选择意图，慢释放不覆盖新选择；卸载时终止活动拖动监听。
- 主错误与次生清理失败均保留，已取得资源及时登记清理；需要诊断的入口分别记录真实主/次失败。固定种子和当前工具数据形状直接使用，不再猜测退役结构。

## 50 项闭环清单

表内“完成”表示确证实现及其关联位置已修改、保留必要边界并完成交叉复核，不代表整个既有产品测试从此没有历史红灯。

| 主题 | 性质 | 原始记录 | 处理结果 |
|---|---|---|---|
| G01 动态字典没有按自有字段读写，导致合法同名键丢失、类型失配或原型污染 | 行为修复 | P01、D04、R05、U10、U13、E05 | 完成 |
| G02 次生清理失败覆盖主错误；部分路径还跳过后续清理 | 行为修复 | P05、U11、R07、E02 | 完成 |
| G03 取得资源后初始化清理责任建立过晚，中途失败遗留自有资源 | 行为修复 | PT01、E03 | 完成 |
| G04 私有分位数 helper 在已保证非空/有效分位的分支保留不可达回落 | 小项整理 | B02、E06 | 完成 |
| G05 恢复夹具误把Vite port:0当随机口，实际回退固定5173且strictPort失败 | 行为修复 | B01 | 完成 |
| G06 asset.delete对每张图重编同一事务目录 | 冗余清理 | D01 | 完成 |
| G07 同次自动发布重复完整解析候选及双扫描candidate哨兵 | 冗余清理 | D02 | 完成 |
| G08 已展开引用未保留具体path，通配资产媒体约束被省略 | 行为修复 | D03 | 完成 |
| G09 确定rest形状又做通用对象白名单检查 | 小项整理 | D05 | 完成 |
| G10 data_read未先绑定Operation，拒绝前已读取并提交另一Operation外部来源 | 行为修复 | D06 | 完成 |
| G11 内嵌附件丢弃已验bytes后再解码和完整哈希 | 冗余清理 | D07 | 完成 |
| G12 graphSameRoots每个元素重新排序同一right集合 | 小项整理 | D08 | 完成 |
| G13 pause/resume对同Run每个Operation重复计算相同branch证明 | 冗余清理 | D10 | 完成 |
| G14 动态工厂executionModel先String导致数组被接受 | 行为修复 | E01 | 完成 |
| G15 隔离当前应用fixture仍猜测退役Opinion evidenceIds形状 | 冗余清理 | E04 | 完成 |
| G16 空字符串未知字段绕过固定白名单 | 行为修复 | P02 | 完成 |
| G17 证据输入对刚收窄的对象重复校验形状 | 冗余清理 | P03 | 完成 |
| G18 证据冻结丢弃同次完整parse的正文/定义，再复制原值 | 冗余清理 | P04 | 完成 |
| G19 理由非空检查后再次readText重复相同条件 | 小项整理 | PM01 | 完成 |
| G20 固定collect解析后防御返回其他方法 | 小项整理 | PM02 | 完成 |
| G21 私有来源缓存始终传入却声明可选 | 小项整理 | PM03 | 完成 |
| G22 关系固定路径先查自有键再枚举查同一键 | 小项整理 | PM04 | 完成 |
| G23 同一时间范围条件重复解析不变的from/to字符串 | 小项整理 | PM05 | 完成 |
| G24 测试工作区装配仍兼容缺失parse/split种子 | 小项整理 | PTM01 | 完成 |
| G25 Host 对同一续租响应完整校验后又逐字段相等比较，并丢弃新冻结副本 | 冗余清理 | R01 | 完成 |
| G26 HTTP 路由预解析后委托解析器重复检查同一同步信封 | 冗余清理 | R02 | 完成 |
| G27 运行端 JSON 字节边界静默替换非法 UTF-8 后继续处理 | 行为修复 | R03 | 完成 |
| G28 同一纯迁移计划中反复验证 verification 的 score/reportIds | 冗余清理 | R04 | 完成 |
| G29 Host初次授权将真值数字当作必填字符串交给执行器 | 行为修复 | R06 | 完成 |
| G30 运行目录再次验证公共客户端已绑定的Map身份 | 冗余清理 | U01 | 完成 |
| G31 来源行定位同一修改字段被完整解析两次 | 冗余清理 | U02 | 完成 |
| G32 Reader只返回ready字符串导致重新证明节点与上下文 | 冗余清理 | U03 | 完成 |
| G33 网关连接成功时active清理不可达 | 冗余清理 | U04 | 完成 |
| G34 续租DTO递归验证同一data时重复通用扫描 | 冗余清理 | U05 | 完成 |
| G35 动态字段添加的字符串schema fallback无生产入口 | 小项整理 | U06 | 完成 |
| G36 可打开单页条件重复loading约束 | 小项整理 | U07 | 完成 |
| G37 已建立单根baseline又检查单根长度 | 小项整理 | U08 | 完成 |
| G38 同一个读取失败被反复归一化 | 小项整理 | U09 | 完成 |
| G39 2D布局父节点已存在却仍有零fallback的前轮同类遗留 | 小项整理 | U12 | 完成 |
| G40 枚举控件字符串化混淆合法JSON值类型 | 行为修复 | U14 | 完成 |
| G41 单调用纯转发包装不拥有实际规则或资源 | 小项整理 | U15 | 完成 |
| G42 新增证据把同源selected引用投影反向join并重复证明数量 | 冗余清理 | U16 | 完成 |
| G43 切换Run后迟到领取仍持有并续租旧Run控制权 | 行为修复 | U17 | 完成 |
| G44 保存引用变化时同一对payload重复展开引用目标 | 冗余清理 | U18 | 完成 |
| G45 固定字符串split后的空数组检查恒假 | 小项整理 | U19 | 完成 |
| G46 公共Map边界未拒绝实际reader必需的边createdAt缺失 | 行为修复 | U20 | 完成 |
| G47 2D布局每个节点重新展开同一份Run operations集合 | 冗余清理 | U21 | 完成 |
| G48 旧branch proof测试被无关坏node日期提前拒绝，未隔离目标条件 | 小项整理 | U22 | 完成 |
| G49 固定会话fixture捕获的基础mock实现仍走optional调用分支 | 小项整理 | U23 | 完成 |
| G50 活动布局拖动在外壳卸载后仍更新状态并保存旧布局 | 行为修复 | U24 | 完成 |

每条原始记录的具体修改、仍保留的校验与验证入口：

- [domain-result.json](./domain-result.json)：D01–D08、D10、P01，含 G26 与正文解析接口协作。
- [runtime-result.json](./runtime-result.json)：R01–R07、E01–E06，含 JSON 字节、Host、迁移与实验资源归属。
- [ui-result.json](./ui-result.json)：U01–U24、PM05 客户端，含合法输入对照和选择/释放竞态。
- [root-result.json](./root-result.json)：证据输入/冻结/关系、共享白名单、验证脚本、图夹具和浏览器设施。

## 必要边界与证据不足

保留独立的输入、存储与响应边界，鉴权与写栅栏、Receipt 优先、输入摘要、CAS、重映射后新值、真正可选字段和跨异步代次校验。相同已解析值只在同次同步阶段交接；没有 optional/unchecked 快捷入口跳过真实校验。

未动的证据不足项包括历史 Work stage 回落、浅存储中的 editor expiresAt:null、防止跨进程租约丢失的文本识别、独立插件端口、配置锁 close 与 Mongo stream.close 的双失败、未证明错误的 assetSchemaHasPointer、独立授权读取以及固定材料的双摘要归属。11 处整文件或具体函数/表达式与 104 初始基线一致，见 [preserved-boundaries.json](./preserved-boundaries.json)。

编译声明仅把生产 lib 从 ES2020 调整为 ES2021，以使用运行环境已原生支持的 AggregateError；编译 target 仍为 ES2020。没有加入兼容错误类或新依赖，package.json 与 package-lock.json 未改。

## 验证与实际红灯

最终测试汇总、命令退出码和范围见 [validation.json](./validation.json)：

| 验证 | 结果 | 证据 |
|---|---|---|
| npm test（含边界检查） | 96 文件 / 975 项通过 | [npm-test-final.txt](./npm-test-final.txt) |
| 生产类型 | 通过 | [types-production-final.txt](./types-production-final.txt) |
| 浏览器相关类型 | 通过 | [types-browser-final.txt](./types-browser-final.txt) |
| Web 生产构建 | 通过 | [web-build.txt](./web-build.txt) |
| 随包 Node / SQLite / DSH、重启与父 IPC 断开 | 通过 | [desktop-runtime-final.txt](./desktop-runtime-final.txt) |
| 证据核心 70 / HTTP 8 / 关系 27 / 使用 33 / 本机 3 | 全部通过 | [核心](./evidence-core-final.txt)、[HTTP](./evidence-core-http-final.txt)、[关系](./evidence-relations-final.txt)、[使用](./evidence-usage-final.txt)、[本机](./evidence-local-usage.txt) |
| 全量浏览器 local + collab | 首轮 85 通过 / 4 失败 / 7 既定跳过，退出码 1 | [browser-full.txt](./browser-full.txt) |
| 两个评分枚举用例复测 | local + collab 通过，保持 score=1 断言 | [browser-enum-focused.txt](./browser-enum-focused.txt) |
| R02 双分支并发保存 | 首次连接表单失败未复现，定向一次通过；未增加重试 | [browser-concurrency-focused.txt](./browser-concurrency-focused.txt) |
| CS04 真实释放帧 | 较新释放用例的保存按钮断言重复失败；同 ID 旧帧用例通过 | [browser-grant-focused.txt](./browser-grant-focused.txt)、[诊断](./browser-grant-focused-diagnostic.json) |
| 经验分位数实际浏览器校准 | P01 本机通过；不作为容量/长时压测 | [browser-performance-calibration.txt](./browser-performance-calibration.txt) |

全量浏览器首轮失败的四次执行，最新对照为三个已得到通过证据、一个基线断言仍失败；按本轮发现的 96 个用例对账为 88 通过、7 既定跳过、1 红灯。不能把定向复跑称作整套命令退出码为 0。

CS04 的正文在真实释放帧后已正确禁用，草稿和后端数据未丢。失败在测试要求“保存按钮也禁用”，而修复前 NodeInspector 的 canSave 已有意不依赖 owned，支持用户显式释放部分授权后让会话取得完整联合写入范围。直接加回 owned 会改变这一既有流程。上述基线归因依据是同一公式和断言已存在，未执行整库回退套件。此项不在 103 的 50 个确证主题内，语义冲突单列，未删除断言、扩大超时或补新分支来消除红灯。

原实验全量 114 条中，既有 core.config 只映射已接入的 70 条；其余 44 条仍按既有配置排除。最初误用未设置 EVIDENCE_TEST_TARGET 的完整配置导致准备阶段 114 条拒绝，后按仓库 README 使用明确真实 Mongo 目标和原核心配置验证；未加内存回落或把未实现能力算作通过。

## 交叉复核与并发工作区

- [cross-review-domain.json](./cross-review-domain.json)：root 证据/清理及 UI 选择/枚举/拖动的独立复核；重启检查单错多包已纠正。
- [cross-review-runtime-domain.json](./cross-review-runtime-domain.json)：领域 8 模块；展示标签遗漏已补修并重新复核，当前无开放实现问题。
- [cross-review-runtime-ui.json](./cross-review-runtime-ui.json)：运行边界、UTF/BOM、Host 错误分类、迁移和实验资源归属的独立复核。

执行中检测到另一任务在修改运行历史与来源导航。WorkspacePage、NodeInspector、NodeReader、run-history 等存在并发改动；保留全部外部改动，不将其记为本轮修复。最终 npm test 的 975 项已包含当时合入的新测试。UI 冻结哈希与外部漂移事实见 ui-result.json，未据此把一次浏览器初始化失败武断归因给外部任务。

初始可恢复快照及哈希见 [baseline.json](./baseline.json)；收尾源码快照见 [source-snapshot.json](./source-snapshot.json)。103 审计工件保持冻结。没有删除初始工作区文件，没有提交、推送、部署或迁移数据。

最终核验：354 个源码/测试/配置/资源快照文件无漂移、无快照后新增源码；初始文件无删除，103 工件无漂移，差异空白检查通过。
