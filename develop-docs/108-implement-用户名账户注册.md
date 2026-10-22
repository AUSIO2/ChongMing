# 108 实施 — 无需邮件的用户名账户

用户授权增加不依赖邮件的注册入口，并在重明网站使用。先行基线为107发布后的636文件，逐项摘要一致，保存为 `test-results/108-username-auth/initial-source-manifest.json` 与 `initial-source.tar.gz`。

按身份服务/HTTP、客户端/桌面/store、纸面UI三个文件范围并行推进；每部分先运行新增测试记录实际红灯，再实现。不改变原图结构、模型执行器、管理令牌或已有用户权限。

## 具体变更

- `contracts/auth.ts` 增加用户名注册/登录输入与中文提示，`contracts/client.ts` 增加固定Gateway/Bridge方法。HTTP新增 `/auth/register-username`、`/auth/login-username`，注册返回正常账户会话，显式拒绝额外管理字段。
- `identity-service.ts` 新增 `readUsername`、`registerUsername`、`loginUsername`；`usernameNormalized` 是独立可选字段，加稀疏唯一索引兼容原无用户名用户。普通用户、默认私有工作区、access/refresh摘要在同一事务提交；没有假邮箱或假验证状态。刷新仅扩展为同时接受合法用户名账户，原停用、期限、撤销和栅栏保持。
- HTTP客户端的两个入口复用 `clientActivateAccount`，store复用原账户接纳和工作区加载；桌面固定IPC动作及模式切换同步接通。密码不写入本地存储，Renderer只获得bootstrap。
- `AccountLogin.vue` 默认展示用户名登录，注册无需邮箱或验证码，成功即进入工作区；邮箱原流程有明确入口。注册说明用户名格式、密码长度及缺少邮件找回能力，保持纸面风格。
- 浏览器夹具新增 `accountMail:false` 开关，默认保持原装配，用户名旅程明确关闭mailer。独立临时环境、清理和安全报告机制沿用原实现。
- 生产类型检查发现107迁移规划器使用 `.at(-1)` 超出项目ES2021 lib；改成语义相同的 `.slice(-1)[0]`，原27项迁移回归通过。没有改迁移规则。

## 测试记录

| 范围 | 实际结果 |
| --- | --- |
| 身份服务、真实HTTP、Mongo | 新增/扩展测试先红：5项缺方法、2项路由404、1项Mongo缺方法。最终含原邮箱7项共3文件15/15，原邮箱HTTP及邮件装配2文件6/6，总5文件21项通过；独立strict通过 |
| 客户端、桌面IPC及会话 | 8项缺入口/未知IPC先红，4相关文件169/169通过；正式错误码mock从测试自造code纠正为 `INVALID_CREDENTIALS` 后目标6/6复验。生产及测试strict通过 |
| 真实浏览器 | 新用户名流程先因无用户名输入而红。最终local3/3、collab3/3：无mailer注册→私有工作区→真实logout200→错误密码→规范化用户名再登录，确认密码不一致零请求，内存收件箱始终空；原邮箱注册/验证/找回/改密旅程通过各自入口运行 |
| 构建及规范 | 根再次运行vue-tsc、架构/消息检查通过；Web生产构建通过，仅有既有chunk体积提示。107规划器与原分支迁移2文件27/27；差异检查通过 |

没有新增skip。先行红灯中已有邮箱7项显示skipped是 `-t` 聚焦新用例的运行选择，最终完整文件全部执行通过。没有用真实邮件、生产用户或模型输出作为测试夹具。

日志在 `test-results/108-username-auth`，主要为 `backend-{account,http,mongo}-red.log`、`backend-green.log`、`backend-email-regression.log`、`client-red.log`、`client-green.log`、`client-formal-error-green.log`、`username-browser-red.log`、`account-browser-final-local.log`、`account-browser-collab.log`、`migration-regression.log`、`web-build.log`。

## 发布前验收

发布号 `r108-1792625449`。构建时源清单 `build-source-manifest.json` 摘要 `f653def770490b1fcac32cda12b6cfe03647f009448b111b2e6bc5711189bc45`；218个运行文件在Linux服务器逐项校验。package和lockfile与107精确一致，复制同一服务器的已验证Linux依赖，不重复联网安装或复制Mac原生模块。

在专属27623端口、独立副本集恢复生产暖备后，用新版实际初始化并注册用户名账户，验证默认工作区、旧工作区404隔离、规范化登录、刷新和退出。原管理员身份仍能读取其5类数据、3个转换和1个图；没有运行模型或发送邮件。隔离Mongo随后停止。

生产检查没有创建测试用户、会话或图；初始化添加用户名索引，并幂等维护原部署身份。原令牌、工作区、定义及两个用户名路由空输入400通过。当前生产TLS配置保持107修复结果，不再重启Mongo。

## 发布结果

- `publish-result.json` 为 `published`，公开 `/release.json` 匹配 `r108-1792625449` 与构建源码摘要，`/health` 为 `{ok:true,ready:true}`，公开首页200。
- 切换前只为本站启用维护guard，停止Host和API，再取冷备，SHA256 `de56e7620a3697d3c3db80fb2db3d91e1afe5e450fcb6ea0e15021eb72c3d8cc`。原发布目录保留，app链接原子替换后启动API并确认健康，再启动Host。失败脚本只回退链接，不用旧备份全库覆盖数据。
- Graph和Host最终均active/running、NRestarts=0，临时guard/标记已清除，隔离Mongo已停止。旧owner令牌bootstrap/workspace200、两个用户名路由空输入400通过。
- 正式 `usernameNormalized_1` 索引已确认 `unique:true,sparse:true`；后验仍为原1用户、1工作区、1图，没有建立生产测试账户或改写用户图。
- 实际浏览器刷新正式站后，默认用户名/密码登录可见；新注册表单只有用户名、显示名称、密码和确认密码，“注册并登录”及格式/找回限制提示正确，无邮箱或验证码控件。邮箱和令牌入口也已逐个只读打开检查，未填字段或提交，最后保留新注册表单。
- SMTP仍未配置，但用户名入口不依赖邮件，邮箱流程保留原明确不可用回应。真实邮件、桌面安装包、本机Codex认证均不在本次发布范围。

私有冷备、配置备份和旧代码保留在服务器，凭据未复制到本机报告。上线后新增账户和数据不得通过旧全库还原删除；如需回退先评估新账户兼容及新增数据。未提交或推送Git。
