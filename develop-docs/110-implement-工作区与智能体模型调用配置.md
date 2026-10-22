# 110 实施 — 工作区与智能体模型调用配置

用户授权把模型配置及Key移到工作区/Agent，并移除服务器Key兜底。初始645文件可恢复基线保存于 `test-results/110-workspace-model-config/initial-source.tar.gz`、`initial-source-manifest.json`，代码相对108无变化；109仅增演示记录和counter。

领域/合同、执行器、UI分别先补有效红灯后实现，根负责真实HTTP、加密适配器、应用装配及发布。

## 文件与行为

- 新合同 `contracts/model-connection.ts`、加密端口 `backend/ports/model-secrets.ts`；control/client合同增加model.get/model.update及modelConnections能力。客户端固定方法与严格View校验拒绝错误scope或额外key/cipher字段，不将明文Key复制为响应身份快照。
- `workspace/model-configuration.ts` 的modelCreateConfigurationService管理独立scope版本、私有密文、Key目标绑定与Agent→工作区继承。`workspace-service.ts`把管理请求纳入原owner授权事务；非成员404、成员仅脱敏读取，合法自定义非UUID Agent ID保持兼容。
- executionCatalog只给当前计划使用的精确Agent解析实际连接，覆写返回执行副本的provider/model/baseUrl。原definitions和已归档Agent未改；模型连接独立于提示词版本，新Run不用重新发布转换。
- `model-secrets.ts`提供modelCreateSecretCodec/modelLoadSecretCodec。AES-256-GCM用独立随机IV、认证标签和版本AAD，master为32字节0600文件；临时完整写入后独占link发布，首次并发初始化一致，损坏拒绝加载而不覆盖。Graph入口用CHONGMING_CONFIG_DIR，本机入口用数据库目录的config。
- `/internal/v1/model/read`先校验Host token；application.readWorkModel沿原data_read校验Work/operation/spec/阶段，交付前再次readLease按存储时钟复验，再从其实际工作区取匹配冻结provider/base的当前Key，响应no-store。公开data_read不附Key。
- workReadModel核对私有回包与冻结配置，workCreateModelEnvironment移除父模型Key/base/认证缓存；DSH及Codex只用本Work所选Key。DSH最后一份补丁固定提供方apiKeyEnv/baseURL，部署补丁误指Tavily等工具Key也会被覆盖；补丁只写变量名和公开地址。
- Codex使用官方自定义provider env_key、requires_openai_auth=false及独立CODEX_HOME，拒绝包含Key的产物（包括JSON解码后字符串）。DSH SDK事件/返回值脱敏；业务插件data_propose在发请求前递归拒绝含本Work Key的字符串或对象键，防止先落库再脱敏。
- 新ModelConnectionEditor复用原管理任务；工作区/Agent两张配置卡、保存后清空密码框、空输入保持、明确移除或继承Key。旧全局模型输入和旧Agent共享模型输入移除。共享库不配置Key，owner以外只看状态，纸面风格保持。
- 独立本机允许loopback模型端点，不放宽来源URL读取策略。远程初版只支持DeepSeek/OpenAI官方HTTPS origin，模型名可自行指定；不新增通用代理或依赖。

## 测试证据

| 范围 | 实际结果 |
| --- | --- |
| 领域/权限/继承 | 新7项未知model接口先红，最终9项SQLite及原workspace33项Mongo共42/42；非UUID Agent scope另有有效先红后绿，领域strict通过 |
| 客户端 | 新5项先红后绿，连原graph-client/account-client共159/159；scope及Key/密文字段白名单、capability布尔和独立strict通过 |
| HTTP/主密钥 | 私有路由404预期401、新装配503预期200均为有效先行红；补root装配后通过。本机loopback另先400后200；3项真实HTTP+3项加密文件共6/6。加密初轮是缺模块前置，不计为产品行为缺陷 |
| 执行器 | 8项DSH与2项Codex先红后绿；模型Key隔离、缺Key不spawn、不同scope、取消/accepted、敏感回显等6文件48项通过，含真实DSH→本机OpenAI协议及3项真实Host/DSH/Mongo |
| 提交前防回显 | 独立内存诊断确认DSH原提案可把fake Key发到/propose；reason和JSON转义payload2项为有效产品红，保护后相关3文件41/41，正常提案保持。对象键初轮被夹具schema先挡下，修为合法字典后验证，不伪称产品红 |
| 最终提供方锁定 | 部署patch把DeepSeek apiKeyEnv/base指向错误来源先红，最后Work patch钉住所选凭据后4文件33/33，再验真实Host自动流程1/1 |
| 浏览器 | 缺“工作区模型调用”区域为有效红。最终local4/4、collab4/4：Key持久化不回显、Agent模型/Key实际Header类别、清Key继承、editor/viewer只读、无Key不创建Run。browser strict及fixture生命周期10/10通过 |
| 桌面/构建 | test:desktop-runtime实际准备Node24并验证SQLite/DSH、模型状态重启持久化、父断连及日志无fake Key；vue-tsc、架构/硬编码消息、Web构建和差异检查通过。Web仍有既有chunk体积提示 |

全Node初轮117文件中113通过/4失败，1263项通过/5失败，222.47秒，原日志full-node-tests.log保留；3个旧集成fixture需要按新规则显式配置假Key，另1项本机loopback用例载入当时修复前实现。仅补fixture配置、维持产品无服务器兜底规则后，4文件23/23精准复验。不能把初轮写成全仓一次全绿；没有再重复全仓矩阵。

新增HTTP/浏览器用例中也修正过自身plan遗漏scope/news端口、转换选择器、双alert及错误operation的既有404预期；均不据此制造产品兼容分支。最后带-t的原生自动流程只选择1例，另2例是运行选择，不是新增skip。

## 发布前验收

发布号r110-1792635480，最终构建源码摘要 `266dd22275ffcf862436ac6a454c68018d2d5e59c82fca41eff5baa4c648b471`。223个运行文件逐项SHA256校验，package/lockfile保持r108，复用同服务器已验证Linux依赖；未复制Mac依赖或实际API Key。

以服务用户chongming首次创建持久加密主密钥后，把它纳入服务器私有配置备份。生产暖备恢复到独立27624副本集；在该副本配置假Key，真实验证加密往返、调用解析和旧定义不变，没有创建GraphRun或请求模型。

生产只读预检查到两个原工作区（5类数据、分别5/3个转换版本）及原图/历史运行正常；model.get均为未配置，旧服务器Key没有自动迁入工作区。不存在活动Run。临时副本Mongo随后停止。

## 正式发布结果

- `publish-result.json` 为published，公网 `/release.json` 匹配r110与最终构建摘要，首页及health200。冷备SHA256 `99538ff0fadc7cb225afabafd1295fdefd7aa40130564bc7cd59cacbdfb542d7`，旧r108目录及私有配置备份保留。
- 停止Host/API并冷备后，从活动环境文件移除DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、DEEPSEEK_MODEL，没有迁入用户模型配置。切换后实际读两个服务的进程环境：服务器模型凭据名称集合均为空；Graph/Host均active/running、NRestarts=0。检索工具配置属于独立工具能力，本次没有变更它的Key归属。
- 加密主密钥文件实际owner=chongming、mode0600、32字节；备份和密钥均未上传浏览器或本机报告。临时维护guard/标记清除、隔离Mongo已停止；未重启Mongo或影响其他站点。
- 旧Owner登录、工作区/定义/图及历史运行读取正常，公开用户名认证路由保持。正式浏览器实际查看工作区和Agent两层卡片，Agent下拉为“继承工作区”，原全局模型来源输入不再出现；未填写或保存任何真实API Key。
- `published-workspace-model.png` 已保存并查看，完整显示工作区模型卡、deepseek-flash、官方地址、空Key输入及未配置状态。浏览器保留该管理入口供用户输入自己的Key；临时Owner登录文件已删除，没有把令牌放截图或报告。
- 生产后验没有发起推理、没有新建GraphRun或测试用户，也没有把原两轮失败新闻演示改成成功。用户填入有效Key后才可继续新闻闭环。

回退脚本只切代码链接，不用旧全库覆盖用户数据，也不自动恢复已停用的服务器模型Key。旧版本不具备新配置界面，发布后有用户配置时应优先向前修复；主密钥与数据库需配套保留。没有提交/推送或发布新桌面安装包。
