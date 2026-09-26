# 072 — 可读性与深模块重构实施清单

实施前先遵循[074版开发规范](../coding.md)，每个切片按其规则编号自查；当前规范文档完成不代表P0—P7代码任务已完成。

graph相关工作进一步按[075逐功能点清单](./075-Graph功能点重构与审核清单.md)执行，每个功能的重构和审核分别记录；优先G01暂停/恢复/取消。

状态：待实施；按codebase-design修订。技术设计见 [072-可读性与服务结构重构.md](./072-可读性与服务结构重构.md)。所有复选项均为后续任务，本轮仅更新计划。

实施前置：先完成[073文件树与模块命名整理](./073-implement-文件树与模块命名整理.md)。072所需文件均按[073迁移表](./073-文件迁移表.json)定位；目录移动不代表本清单中的内部重构已经完成。

## 通用执行约定

唯一设计skill为codebase-design。按module的完整行为迁移，公开协议保持；候选名字不代表必须创建class或文件。

每个切片先填写：调用者 → interface全部规则 → 藏在implementation里的细节 → dependencies类别和adapter → 删除测试 → 涉及的不变式I编号 → 现有/补充行为测试。

每次代码迁移同时完成对应中文用途注释、清楚命名、排版、类型和消息枚举引用。按函数名自动生成注释、增加纯转发外壳、只对私有实现做mock验证均不算完成。

## P0：基线与候选核查

- [ ] 保存精确工作区快照，覆盖未跟踪文件与工程配置；记录恢复路径，不触碰用户数据。
- [ ] 记录实际git状态、维护源码、tests和工程脚本清单；历史审计、生成文件和依赖明确排除。
- [ ] 用Vue SFC解析后再盘点函数/箭头/回调，不把template当TypeScript；记录缺失、重复和无意义注释。
- [ ] 盘点消息的所有实际呈现/抛出出口、枚举引用和动态参数；登记streamError/Vue/脚本漏点。
- [ ] 记录各业务调用者目前跨哪些interface，哪些调用已完整封装、哪些仍手工组合规则。
- [ ] 列明已有真实adapter：Mongo/SQLite、RabbitMQ/进程内通知、HTTP/受控fixture、DSH/确定性runner。
- [ ] 重跑现有npm test、vue-tsc、test:boundaries和git diff --check，单列基线失败。
- [ ] 登记tests当前缺少类型检查的范围，选择切片内逐步纳入方案，不跳过整份测试目录。
- [ ] 对设计第3节I1—I16逐项标出现有测试和缺口。

退出条件：现状、恢复方式、候选价值和验证路径明确，无未解释的基线失败。

## P1：暂停/恢复完整切片

涉及backend/application/graph-application.ts、backend/modules下graph/workspace/identity目录，以及双存储adapter。

- [ ] 保留A方案的read/dispatch interface和HTTP/IPC命令表示；不新增同义公开pauseRun方法或绑定Map对象。
- [ ] 从真实调用开始记录“解析→事务内鉴权/fence→Receipt→版本→状态→原子提交→响应”及现有特例。
- [ ] 将复杂步骤放在module私有implementation中，以名称和中文说明交代副作用。
- [ ] 区分装配/管理/测试需要的store与业务需要的命令interface；业务调用方不能依赖原始未鉴权dispatch。
- [ ] 整理本路径压行、过时注释、泛话和涉及消息成员；旧名称引用同一切片迁完。
- [ ] 验证同用户合法重放、不同输入冲突、跨用户身份隔离、撤权竞态和旧revision重放。
- [ ] 验证暂停后立即恢复，旧grant仍拒绝，新工作可继续，已接受报告和审核不丢。
- [ ] 对Mongo与SQLite执行同一业务断言，并保留各自并发语义检查。
- [ ] 记录interface/depth/locality对照：若调用面本来已简单，说明具体内部阅读或规则集中收益，不虚构减少调用次数。

验证：auth、control、graph、node-run、work、sqlite、sqlite-integration及相关类型检查；跨层完成跑全量回归。

退出条件：I4—I9相关行为成立，无新转发外壳；能从实现顺读事务和暂停效果。

## P2：图命令与Work状态

- [ ] 沿P1组织其余图编辑、运行、审核等完整命令，不把所有命令压进一个没有业务名称的万能处理器。
- [ ] 保留图创建先查重放后插入、删除重放和当前快照/Receipt产物字段语义。
- [ ] Work interface集中领取、busy/obsolete/accepted、数据读取、续租释放和结果提交规则。
- [ ] 区分公开用户命令事务与Work租约下的原子提交；不把工作proof误当用户身份。
- [ ] 后继发现、Operation建立、历史复用、产物接纳和状态汇总在implementation内用具名步骤表达。
- [ ] 先按提案kind/actor缩窄数据，再共享真正相同的逻辑，减少跨分支非空断言。
- [ ] 已接受历史提案按收据确认，换Run/租约或原节点删除后不要求旧输入重建；未接受旧工作仍拒绝。
- [ ] 保持图、Receipt、待发布状态原子提交；数据库重试不重复调用模型。
- [ ] 更新直接业务调用者和测试入口，删除替代完成的旧实现，不保留未使用别名。
- [ ] 同步本切片注释、命名、消息与类型，核对原工作ID和配置hash不变。

验证：graph、run、node-run、work、work-replica、control、sqlite、sqlite-integration；全量回归。

退出条件：I3—I11相关行为成立；新闻、事实和方向工作仍可并行，规则归属可解释。

## P3：Host与桌面生命周期

- [ ] 明确start/close/finished等interface的幂等、并发调用、错误和关闭期限；保留已有有效入口。
- [ ] 标注Host、单次Work、单次投递各自拥有的取消信号、deadline、runner和连接。
- [ ] 所有续租、执行失败和清理路径集中到对应生命周期；不让队列调用方自行安排步骤。
- [ ] 列出现有连接失败、429/5xx、LEASE_LOST、领取401/403、协议/模型错误矩阵，再用结构化分类替换message判断。
- [ ] 共同工作HTTP逻辑只有真实复用需要才提取；响应校验和失败语义保留各自约束。
- [ ] close停止新工作，取消并等待DSH清理，再有界释放/关闭；断连重投先排空旧执行。
- [ ] 桌面本机运行module保留启动合并、就绪验证、状态脱敏、异常退出、超时清理后重试和必要终止。
- [ ] 模式切换、忘记凭据、关闭窗口与停止本机运行分别表达，不能合成一个含混close。
- [ ] 采用class时核对this绑定；保留函数时明确资源owner。选择本身必须有阅读收益。
- [ ] 同步该路径用途注释和错误枚举，移除无用分支但保留全局错误出口。

验证：host、queue、dsh、dsh-business、dsh-verify、activity、diagnostics；electron四组测试；test:desktop-runtime。

退出条件：I1、I4、I8、I10、I15、I16相关行为成立，无资源/执行残留。

## P4：客户端会话完整切片

先完成切图/订阅，再在同一interface下扩展偏好与提交重试。

- [ ] 记录UI当前调用的会话interface及只读投影；组件无需认识scope/epoch/timer/fence。
- [ ] 按设计第6.2节划分单一状态所有者，不预先创建五个公开class。
- [ ] 把旧视图失效、首次读取、订阅和快照接纳作为完整操作；成功与失败回调都校验作用域。
- [ ] HTTP adapter负责单次请求；SSE implementation负责分帧、首帧/空闲期限和reader；会话只保留一个重连流程。
- [ ] 新SSE基线使旧HTTP结果和错误失效，版本不倒退；暂停/断流清掉临时activity。
- [ ] 保持换图/登出不取消远端Run，connection切换立即隔离旧请求。
- [ ] 偏好写入绑定工作区和冻结快照；旧保存完成不覆盖新工作区，也不吃掉新dirty。
- [ ] 重试只使用原requestId和payload，409只刷新并保留草稿；管理面板的作用域继续独立。
- [ ] 保留Pinia/computed与树布局行为；需要内部module时，只暴露它承担的业务操作。
- [ ] 补齐本路径的streamError/Vue文案枚举和正确用途注释，验证实际漏检正反例。
- [ ] 文件传输保持摘要/大小/固定端点/原上传字节重试与断开后的迟到结果隔离。

验证：tests/client的graph-client、stream、files、session、management、layout、integration、management-integration；tests/apps/desktop的ipc-handlers、connection-manager；切图与阶段树的可见行为检查。

退出条件：I2、I4、I13—I15成立，组件侧协调知识没有增加。

## P5：配置、资产、授权观察及adapter整理

- [ ] 为Agent复制/配置冻结、成员修改、资产流和授权观察分别填写候选卡及删除测试。
- [ ] 工作区写入与共享库操作在同一事务中组织，内部规则模块不反向调用上层，避免control/catalog循环依赖。
- [ ] 资产interface尽量接收token和业务参数，调用者不再手工组合auth.read与资产权限检查。
- [ ] 上传/导入在事务外读取流和暂存，后续短事务提交；结果不确定时保留可能已引用资源。
- [ ] 授权观察集中首次订阅/基线/再次鉴权/变化合并/终止规则，SSE adapter负责帧写入和背压。
- [ ] 每个新的观察seam必须列出实际生产与测试adapter；没有真实复用需求则整理events.ts内部，不新增转发层。
- [ ] HTTP解析若提取input.ts，说明复用或理解收益；现有路由、错误输出、headersSent和shutdown语义不变。
- [ ] 存储/消息adapter保留真实差异；纯计算不加不必要port，默认资源仍由apps装配。
- [ ] 同步对应注释、名字、消息和测试类型，删除确认已被替代的内部实现。

验证：auth、control、assets、asset-list、source、bundles相关行为、error-boundary、messaging、queue、client/files、server/headless；双存储场景。

退出条件：I5—I7、I11、I12、I15、I16成立，每项结构调整具有depth/locality证据。

## P6：横向扫尾

- [ ] 全量复核当前维护的函数、箭头和回调用途说明，包括tests/配置/脚本；无模板生成句、重复/误导注释。
- [ ] 完成剩余消息枚举的语义命名、归属、模板参数契约和引用迁移；保持原输出。
- [ ] 扫描Vue script、属性/ref赋值、助手别名和脚本错误，合法空串/普通文案/远端错误有明确规则。
- [ ] DSH和原生Node脚本的冻结枚举仍可直接加载；不增加自动生成链。
- [ ] 完成整个tests目录严格类型检查；不靠忽略目录或批量any消除问题。
- [ ] 按“旧测试证明什么→新interface如何证明→保留/迁移/删除”清单替换浅层测试。
- [ ] 保留真实Mongo/SQLite/RabbitMQ、并发停顿、协议及必要算法测试；删除前确认替代证据存在。
- [ ] 更新coding.md/ARCHITECTURE.md/现行说明，修正071历史验收口径；目录与类数量不作为验收项。
- [ ] 删除无价值外壳、旧内部别名、临时迁移工具；保留有实际用途的一次性数据修复工具。

退出条件：盘点和检查范围真实，必要行为不因测试替换而丢失，代码组织与文档一致。

## P7：整体复核和交付

- [ ] 核对I1—I16各自的自动/人工验证证据，未运行项明确列出。
- [ ] 执行npm test、运行代码和tests类型检查、test:boundaries、git diff --check。
- [ ] 执行build:check、test:desktop-runtime，检查随包Node/SQLite/DSH/资源与重启、父IPC断开。
- [ ] 检查本机和远程连接、阶段树、切图、断流、编辑冲突、退出等可见行为；Node检查不冒充GUI验收。
- [ ] 走读启动运行、报告提交、暂停恢复、Agent复制、切图五条路径，定位interface、规则owner、错误和adapter。
- [ ] 对新增module执行删除测试；只有转发且没有独立保证的外壳移除。
- [ ] 对比规则修改涉及的独立位置、调用者所需知识及旧响应/取消逻辑集中程度，说明实际locality收益。
- [ ] 交付代码、规范、interface约定、测试替代说明、阶段快照和未验证项。

退出条件：业务行为与可读性两类证据都完整，不以测试总数或新目录数量宣布完成。

## 阶段记录与回退

每阶段记录：实际改动、候选价值、interface规则、涉及的I编号、测试命令和结果、已替换测试、仍未验证项目、精确回退快照。

每个阶段保留可运行状态，内部调用方随迁移同步更新。通过文件快照与差异回退，不覆盖用户原始脏工作区；本计划不需要存储schema或外部协议切换。

本轮记录：三种interface方案已比较并选择A；候选按深度与局部修改收益重新组织；只修订两份072计划，未实施以上清单。
