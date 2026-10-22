# 067 — 模块边界与运行入口拆分实施原稿

1. 提取记录、存储、消息和来源端口，分离活动及配置驱动耦合。
2. 拆开装配根，Host注入工作传输；原位验证后按职责移动文件。
3. 更新所有源码/测试/脚本/构建入口，不保留旧路径shim。
4. 加入可执行边界审计，裁剪本机发行依赖，完成回归及打包验证。

## 完成记录（2026-09-13）

- 按ARCHITECTURE.md落地contracts、core/ports、storage、messaging、worker、api、client与apps；Vue界面移到apps/ui，Electron移到apps/desktop，CLI及本机/协作/诊断入口各自归组。旧路径不留转发文件，所有源码、测试、构建与脚本调用方同步更新。
- GraphStore改为显式端口；GraphDocument、收据、逻辑记录名及确定性哈希从Mongo文件抽出。Persistence不再引用Mongo工厂的ReturnType。
- core/application只接收Persistence、MessagingService与SourceReader；Mongo和SQLite装配分属apps/server/application与apps/local/application。URL读取实现、Mongo URI脱敏、DSH活动转换/上报分别移入自己的模块。
- Host改用注入的WorkTransport；RabbitMQ建立连接只在协作装配/适配器出现，进程内实现无需导入RabbitMQ或SQLite具体类型。
- DSH插件使用模块相邻路径，服务bundle和插件部署到service目录。专项回归发现SDK默认import.meta.resolve在tsx CommonJS转换下失效，改为在共享DSH适配层通过SDK依赖包的bin元数据解析；没有恢复硬编码仓库路径。
- 桌面服务依赖根缩为两个DSH包，保留原lockfile中对应依赖的锁定版本；实际生产依赖从569减到525。服务资源中mongoose/mongodb/amqplib/vue/pinia均不存在；应用Renderer的Vue依赖仍由Vite打包。
- test与build:check自动运行模块边界检查，覆盖type import、core/驱动隔离、本机入口闭包、Main/Renderer/CLI隔离，以及API不加载DSH、Host不加载Mongo。临时加入type-only Mongo导入的负例被正确拒绝并已删除。
- 保留原有业务实现与未提交改动，未修改数据结构或运行迁移；公共HTTP/SSE/客户端协议保持。原066的原生界面点击验收仍待Mac解锁，不计入本轮通过项。

## 验证

- 本机SQLite专项2文件/7项通过，DSH/Multi-Host专项2文件/14项通过。
- 最终全量35文件/242项全部通过，未删除功能测试；阶段树、管理、资产、暂停/恢复、围栏、MQ/SSE和本机持久恢复均继续覆盖。
- 最终build:check通过：类型、自动边界审计、服务准备、Vite、Electron及arm64 DMG。
- 实际.app资源使用所带Node完成SQLite/DSH核查、结果持久重启和父IPC断开清理，检查通过。
- CLI与本机服务help入口通过；064入口隔离和052历史/目标契约审计通过；git diff --check通过。历史源码链接通过冻结的哈希/行数索引校验，不伪称旧路径仍存在。
- 构建未安装/发布，发行签名/公证仍未配置；测试均使用隔离数据和本机确定性模型，不操作用户数据库。

## 迁移备份

/Users/xiong/.codex/backups/chongming-067-lwxzs_hq

chongming-067-before.json保留移动前的源码/测试内容（含未提交修改），chongming-067-map.json记录旧路径到新路径映射。目录0700、文件0600。临时搬移脚本和边界探针已清理，备份不参与运行或构建。
