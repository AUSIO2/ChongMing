# 061 — 消息队列与实时同步实施原稿

对应[061设计](./061-消息队列与实时同步.md)，编码前创建。使用当前059/060工作区基线，不覆盖旧Mapper改动。

1. 定义MQ配置/部署身份/工作消息与SSE事件合同，安装amqplib，准备隔离RabbitMQ测试与本地部署说明。
2. 在Graph create/commit中原子写合并outbox；实现指定工作claim及busy/obsolete，接确认发布、变更触发、启动/重连补查。
3. Host从MQ消费替代空闲轮询，保持lease心跳/失效/关闭和业务失败语义，迁移CLI与fixture；移除mapId筛选，使用namespace隔离。
4. Graph API桥接MQ变化广播为认证SSE，完整首帧、权限重校验、背压与关闭清理；管理变化触发重新读取。
5. Web/Electron watch接入；移除周期快照读取，保留显式刷新和有限重连；验证文件通道/草稿/用户scope未回归。
6. 跑真实broker与Mongo故障矩阵、原DSH多Host场景、SSE/IPC/客户端测试，完成全量与构建检查，更新文档实际结果。

仅测试环境启动临时RabbitMQ容器；不部署生产、不安装应用、不改用户数据。队列本身不替代节点版本、租约或幂等回执；细粒度DSH活动另行实施。

## 完成记录（2026-09-13）

- 新增amqplib 2.0.1和RabbitMQ配置/实际部署身份隔离。API/Host共用base namespace，实际资源名称附Mongo deploymentId；Host校验启用状态和完整namespace，指定mapId/workId领取，保留claimed/busy/obsolete三态。
- Host改为prefetch1、手动ACK的持久quorum队列消费，无空闲图扫描；忙租约等到期后重投，失联先中止该代执行并排空DSH再换连接。原mapId/pollMs调试筛选移除，业务范围仍由Run.scope决定。Broker地址可用私有secret配置且从DSH环境剔除。
- Graph create/commit原子写合并dispatch标记。确认发布检查mandatory未路由和publisher confirm，按同version清pending；Mongo change stream触发处理，启动/重连补查包含tombstone，MQ重连重建活跃Run工作通知。管理/权限变更按真实字段广播，排除writeFence-only与个人preferences噪声。
- 每API共享一个MQ fanout订阅，桥接为认证SSE。先注册再读取完整首快照并刷新workspace/settings；同工作区其他图的创建/改名/删除也触发列表刷新。发出数据前和15秒心跳重新验权，MQ断线/权限撤销/删除关闭订阅；背压10秒上限，最新状态合并发送。
- Web/Electron接watch持续流，取消与窗口销毁保持原边界，listener先于invoke注册。客户端保留初始一次读取与手动刷新，删除定时图快照轮询；断流有限退避重连，完整快照重建，迟到HTTP失败不清掉新实时状态。工作区、Settings、草稿和文件通道回归通过。
- 实测AMQP黑洞暴露库关闭握手可永久等待的缺陷，现关闭同时等待真实close事件并在1.5秒上限通过Node transport AbortSignal强制清理。连接与channel均覆盖，确认超时不会阻塞outbox重连；无需依赖库私有socket字段。
- 提供compose.rabbitmq.yml本机持久卷配置及npm test自动临时broker包装器。各fixture清理自己的随机namespace；缺少测试broker条件明确失败，不跳过消息集成。未操作用户生产数据库、应用安装或正式部署。

验证结果：

- 最终直接运行npm test（未指定外部broker文件）：自动启动新RabbitMQ实例，53文件/274项全部通过，退出码0；包装器正常清理容器与凭据。
- queue专项包含真实TCP黑洞：15秒确认超时后有界结束、代理socket清零、同namespace重连可发布。Host专项覆盖真实AMQP断连、DSH排空、忙租约重投、重复消息与配置错配；多Host官方DSH和Mongo选主回归通过。
- Messaging专项覆盖两API共享图首帧竞态、outbox版本竞争/删除、直接管理DB变化、token撤销、MQ中断期间更新及重连补发、同工作区其他图列表刷新。
- 原旧快照claim测试按指定工作的新语义拆清：暂停中不得取得授权；resume后必须重新读取当前图才能发新grant。已颁发旧grant在快速暂停/恢复后仍被拒绝，相关回归继续通过。
- npm run build:check通过：类型、Vite、Electron Main/preload与arm64 DMG。发行签名未配置，未安装或发布。052目标契约检查、Compose配置解析及git diff --check通过。
- 真实Electron sandbox/contextIsolation下实际preload/IPC收到首帧与后续序列[1,2]，取消传至Main且Renderer无Node权限。临时窗口与userData已清理。
- 双Chrome客户端通过真实API/Rabbit/DSH fixture同步新增事实、待审、暂停/恢复和最终结论；版本1→12一致。B未保存路由草稿跨版本保留；A发起自动重跑后关闭标签，B继续到版本18完成。960×640布局正常。
- DevTools确认认证GET events长连接、SSE Content-Type及无token query，70秒观察总请求固定8，无每秒快照查询。UI撤token未另加测试控制口，依后端真实撤权与客户端错误处理回归验证；不把未观察的逐帧时序宣称为UI实测。

所有本轮临时Rabbit容器、broker凭据、测试namespace、TCP代理、浏览器标签和fixture/dev进程已清理。原059/060及旧Mapper工作区改动保留，未推送。

本阶段仅同步持久业务/管理状态，细粒度DSH Activity、旧运行代码/依赖清理和安装包托管本地服务仍待后续。
