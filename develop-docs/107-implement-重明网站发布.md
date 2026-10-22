# 107 实施 — 重明网站发布

用户已授权上线。目标`https://chongming.rainverse.cloud`已确认；本机基线634文件，`test-results/107-deploy-1792599307`。SSH只通过现有可信主机记录与本机密钥，未读取/输出私钥或服务器凭据值。

## 已完成只读清点

线上Node24、Nginx、Graph/Host、Mongo副本集和RabbitMQ服务存在；一个无活动任务的空图，旧单run结构。用户/工作区/Agent均保留。SMTP缺失已询问用户；不从其他站点复用邮件秘密。

## 发布包和迁移

- 发布号 `r107-1792599307`，目录 `/opt/chongming/releases/r107-1792599307`，`/opt/chongming/app` 最终指向该目录。旧目录保留为 `/opt/chongming/releases/prior-r107-1792599307`。Web 使用 `CHONGMING_WEB=1` 构建；218个运行文件逐项SHA256校验通过。
- Linux依赖在服务器安装，Argon2使用现有Node头文件/Python3.11/GCC构建；以服务账户实际hash/verify成功，未复制Mac原生模块。
- `scripts/deploy/legacy-configuration.ts` 的 `planLegacyConfigurationUpgrade` 是纯规划函数，按原Agent身份映射默认定义，先归档旧版本，只升级与旧stock哈希一致的正文，再冻结新快照。部分定义、身份歧义、类型冲突、历史版本冲突会停止；完整配置重跑无变化。共享库和工作区逐条CAS事务提交，保留其余配置。
- 先补上述规划器测试，记录于 `legacy-configuration-contract-red.log`、`legacy-configuration-green.log`；结合原分支迁移测试最终2文件27/27通过（`migration-tests.log`），独立strict通过。
- 暖备在独立27622端口、独立副本集恢复，真实迁移及HTTP旧身份读取通过；生产迁移前阻断本站写入、停止Host/API并再次取得冷备。1个空图转换为 `runs[]`，共享库及工作区各补5类数据、3个转换、22个精确Agent快照。生产复查无待迁项目，模型、工具、成员、部署身份保持。

## 首次失败与恢复

首次生产检查卡在Mongo建索引，自动回滚恢复了文档，却同样卡在索引阶段，造成维护窗口明显超时；不能把本次发布描述为无停机。停止本次卡住的检查/恢复进程后，保留全部原始日志和第一次冷备，排查确认是服务器原有TLS配置：副本集内部使用仅有serverAuth的网站证书、CA链缺可信根、成员声明IP不在证书SAN内。隔离副本未启用TLS，因此未覆盖这一环境问题。

修复仅作用于 `chongming-mongo.service`（27018），没有修改独立27017实例或其他站点：

1. 私有备份 `mongod-before-tls-fix.conf` 和 `replica-before.json`；新 `trusted-ca.pem` 合并系统根与现有中间链，openssl sslserver验证通过。
2. 保持requireTLS、authorization及原keyFile；startup参数 `tlsWithholdClientCertificate: true` 采用现有keyFile成员认证，不再把server-only证书用于内部客户端认证。没有启用无效证书/主机名豁免。
3. 普通、非force的单成员reconfig只将host改为证书覆盖的 `rainverse.cloud:27018`；保持副本集身份、票数等属性。重启该专用Mongo清除旧IP监控连接缓存。
4. 先恢复旧版API和Host，旧身份读取200、公开站点及health200后才重新发布。实际默认索引探针14ms完成并清理；原1用户、1工作区、1空图核对一致。

诊断期间尝试过对本次恢复索引更改commitQuorum及重建；这不是最终应用修补。最终服务仍使用默认索引参数和原唯一约束，生产无待构建索引。没有给业务实现增加异常兼容分支。

## 最终检查与运维边界

- 第二次切换给外部命令设置120秒超时；重新停写、冷备、preview/apply/check后切换成功。`switch-result.json` 为 `published`，冷备SHA256 `30a776ba4f5fd2be1e92123b855ed1468a72068a7160d0344382de4ac7fc2b81`。两次操作记录分别保留，未覆盖首次失败证据。
- 公网 `/` 200、`/health` 为 `{ok:true,ready:true}`、`/release.json` 匹配本次ID及源码基线摘要。原Bearer令牌的bootstrap/workspace/map/definition读取通过；注册空输入400确认新路由已装配，未创建生产测试用户或发送邮件。
- 切换成功时Graph和Host均active/running、NRestarts=0；清除Mongo旧IP监控缓存的重启带动依赖服务重新启动，Host曾因API尚未就绪而启动失败一次，随后systemd重启成功。最终Graph为0、Host为1，均active/running，最后host.started已确认，不能写成全程零重启（`services-final-check.json`）。Nginx维护标记与临时guard清除。隔离验证Mongo已停止，备份保留在私有目录，不复制秘密到本机工件。
- 专用Mongo再次重启后，最近60秒日志无issuer/purpose/handshake/hostname错误；PRIMARY正常，无待构建索引。原token的hash唯一索引及新邮箱唯一索引均就绪，原1用户、1令牌、1工作区、1图保留；服务重连后原身份读取仍通过（`tls-final-check.json`、`database-final-check.json`）。
- 浏览器只读核对正式中文纸面登录页、正确同源服务地址，实际打开注册、找回密码、访问令牌表单后回到登录页；不使用真实身份或生产验证码做UI测试，不创建测试账号。
- SMTP和稳定验证码密钥仍未配置，邮箱注册验证/找回密码的真实邮件投递尚不可用；原访问令牌入口可用。应按README配置SMTP及至少32字符稳定密钥并重启后端后，再验收真实邮件。未声称已验收此能力。
- 本次保持线上原DSH模型环境，没有复制本机Codex认证或宣称网站已能调用本机Codex。没有提交或推送Git，也没有发布桌面安装包。

切回代码可在停写后把app链接指回旧发布目录；当前数据已升级，不能只切代码就假定旧服务兼容。只有确认上线后无新增写入且明确接受回退范围时才恢复冷备。上线后有新数据时必须单独制定向前修复或保留新增数据的迁移，禁止直接旧全库覆盖。
