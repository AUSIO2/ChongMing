# 055 — 共享管理与资产实施原稿

1. 定义control、asset/bundle及认证上下文类型，明确当前运行profile的配置映射。
2. 实现用户/token、本机admin与公开请求事务授权；图Store接受事务session，公开幂等身份包含用户。
3. 实现Workspace/member/preferences、Agent library/副本/copy及settings，服务端生成Run配置。
4. 实现GridFS流式上传/下载/ready发布、Source/Evidence引用校验及v3包导入导出。
5. 接公开query/command和二进制端点，去掉开发身份与公开Run任意configuration；调整启动与测试fixture。
6. 用真实Mongo副本集覆盖撤权竞争、版本与幂等、资产与导入事务，保留多Host和DSH原生测试。
7. 更新当前完整接口/部署文档，运行专项与全仓检查，只提交本阶段文件并按既定规范push。

不新增认证框架、任务队列、对象存储或记忆依赖；复用Node crypto/http/fs、mongoose/Mongo原生事务及GridFS。

## 实施结果（2026-09-11）

- 公开请求必须用户Bearer token；本机CLI创建/启用/禁用用户、签发/撤销token，库内只存hash。最后HostAdmin与Workspace Owner都有并发保护。
- 用户mutation用原生事务，touch token/user/Workspace私有围栏后提交图和收据；撤权先胜出时旧请求重试鉴权失败。收据按用户隔离，确认重放仍需当前权限。
- Workspace/member/preferences、Agent library/私有副本/merge和replace、两级版本及非秘密settings已接通。默认seed幂等初始化并继承共享模型；显式override和已冻结Run保持独立。
- Run配置由服务器解析；promptVars/priority/category随Run冻结，verify按指定变量顺序注入授权输入。通过DSH的单一不透明变量承载已渲染persona，避免应用模板或用户花括号被二次解析。
- 共享Graph NodeData解析器同时用于HTTP和bundle，支持source/evidence资产引用；8MiB图保护阈值保留取消/删除/失败收尾余量。
- GridFS二进制上传、长度/摘要/幂等、读取、引用保护、逻辑删除与本机清理完成。v3 Map/Workspace包可导入新Workspace，完整事务发布；原Node/Edge版本、历史report标签和未知历史Agent标签保留，不复活Run/lease。
- 本机配置0600、互斥写与原子rename；Mongo显示重建并隐藏所有query选项。CLI可诊断、stage下次连接及只写secret；init生成用户token并在缺失时私下生成Host内部token。

验证：`npm test`为37个文件、128项全部通过；`npm run build:check`、类型检查、文档契约检查及diff检查通过。测试包含真实副本集的token/user/member撤权竞争、最后管理员/Owner、跨工作区隔离、Agent复制及配置快照、GridFS发布与引用删除竞争、两图导入失败回滚、历史数据往返、真实CLI凭据私有输出、本机配置写入竞争。

已有两个Host真实DSH流程、HITL自动继续、SIGKILL接管和Mongo选主继续通过。新的真实provider请求断言覆盖模板变量替换/顺序及private context不进入模型；模型端点仍为本机确定性fixture，不把这些检查当作外部模型质量验收。

当前完整接口见[055-接口文档](./055-接口文档.md)。未迁移旧development数据、未改旧Mapper/前端、未执行用户真实模型或凭据请求。未知提交结果的私有孤儿blob保留供停写维护，不提供不安全的在线全局GC。下一阶段仍是parse/split及产品Client/SSE/前端接线。
