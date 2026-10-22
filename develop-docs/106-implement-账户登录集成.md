# 106 实施 — 账户登录集成

2026-10-21用户授权实施，先补测试再改实现。设计见[106计划](./106-账户登录集成.md)。619文件基线在 `test-results/106-account-auth-baseline-1792590649`，附件参考仅在私有测试目录，原用户库/dirty保持。

## 初始核对

- 附件app确有账户前后端代码与SMTP装配，但没有tests；当前图/权限代码比附件更新，只迁入账户增量。
- 附件验证码消费在同一事务写attempts后throw，SQLite/Mongo都会回滚，需先复现再修。附件登录还缺当前签发令牌时的用户栅栏保护，增量实现保持当前保证。
- 当前原令牌与本地模式保持；邮件未配置时明确不可用，验收使用测试内存邮件端口。
- 分工：identity/账户合同及测试；客户端/桌面会话与测试；纸面UI/store/浏览器测试；根负责应用/HTTP/邮件依赖/装配、总体回归与交付记录。

## 最终行为

已增量接入注册、邮箱验证、登录、刷新轮换、退出、找回/重置/修改密码；账户默认工作区仍经当前control的授权事务创建。旧用户、管理员令牌、本地身份与原图/证据库/分支执行保持，未搬附件旧application、存储或图代码。

验证码的旧行为是错误后attempts写入随异常回滚。现消费函数返回固定拒绝结果，验证/重置的事务先提交错误计数，再在事务外返回失败；连续5次后正确旧码也返回`CODE_ATTEMPTS_EXHAUSTED`，重发使旧码失效并给新码独立次数。

### 文件与入口

| 范围 | 最终文件/职责 |
| --- | --- |
| 账户领域 | `backend/modules/identity/identity-service.ts`：保留旧令牌/用户管理，新增9个账户方法、持久化challenge/session、授权栅栏与验证结果提交 |
| 密码 | `backend/ports/account-passwords.ts` + `backend/adapters/identity/argon2-passwords.ts`：两方法端口与真实Argon2id适配，领域不直接加载外部运行时 |
| 邮件 | `backend/ports/account-mailer.ts` + `backend/adapters/email/smtp-account-mailer.ts`：SMTP环境校验和纯文本邮件，未配置不回退日志验证码 |
| 应用/HTTP | 现行graph application默认工作区回调；9个严格auth路由；原业务及内部Host路由保持；graph/local入口可注入邮件与稳定验证码密钥 |
| 客户端 | `client/graph-client.ts`：集中可选`account`能力、会话校验、到期前合并refresh、代次及凭据写队列；原query/dispatch/files/streams实现保持，不为刷新重放未知写入 |
| 桌面 | connection-manager、IPC/preload、renderer transport增量转发账户能力；credential-store升级v2，仅可信safeStorage加密refresh；旧v1只保留地址，需要重新输入旧令牌 |
| 页面 | `apps/ui/features/auth/AccountLogin.vue`、`AccountSettings.vue`及消息；现行store成功后接纳新身份，失败保留旧图/选择/编辑授权；同身份改密保留当前工作区；WorkspacePage组合纸面UI |
| 构建/文档 | 新增锁定argon2 0.45.1、nodemailer 10.1.7及类型；独立Node随包依赖含两者；登记两个适配器的最窄依赖规则，未放宽业务层禁外部运行时；README补SMTP说明 |

`ClientGateway.account`采用集中可选能力，实际HTTP/Desktop提供，旧令牌/本地与既有测试替身保持；没有为8个方法批量给无关fake加空实现。附件的固定rainverse地址、LiquidGlass样式、Windows二进制、Git与开发规则均未迁入。

## 测试先行与修复证据

| 检查 | 真实先行与最终结果 |
| --- | --- |
| 验证码 | 新API缺失只记前置红；接入附件旧throw算法后，真实SQLite验证/重置两项都在一次错码后读到attempts=0（期望1），2红5绿，`account-counter-red.log`。修后7项账户测试绿，包含5次耗尽、重发/到期、重置改密/轮换及旧令牌保持 |
| 现有身份与撤权 | 旧8项先绿；新增登录/刷新/改密与并发停用/改密/令牌撤销的真实Mongo栅栏测试；手工token改密撤销竞争先实际错误签发红，再推进已认证token栅栏修复，不撤销长期token。最终两身份文件20/20、完整strict通过 |
| 并发注册 | 用Mongo真实暂停insert seam并发同规范化邮箱，直接验证一个成功、一个409，1用户/1有效challenge/1邮件；原事务重试已正确处理，未加生产补丁、不把静态疑点记为修复 |
| HTTP/邮件配置 | 原auth路由404有效2红，装配后绿；SMTP新模块导入缺失仅前置，4项配置边界绿。扩展后实际邮箱账户创建图、沿原branch协议保存节点、非成员404、原管理员token/刷新/退出均通过，2文件6/6；一次预期403误写已按原隐私404纠正，未改产品权限 |
| 客户端/桌面 | 新账户8项及v2两项先红；补正式logout `{}`+Bearer合同红后修客户端错误的refreshToken-body推断。真实HTTP断言保持严格，无服务端兼容补丁。又覆盖手工令牌记住标记、恢复refresh、迟到登录/退出与改密保存顺序。owner 5文件184/184绿及strict；根最终连session 6文件303/303绿（有重叠，不与前者相加） |
| UI/store | 原会话116/116先绿，新会话先合同红，最终119/119；失败登录保留图/已领取分支/选择/stream、旧结果不复活、同身份改密不清工作区。两条真实HTTP浏览器账户旅程先标题缺失红，接入后绿，邮件只进测试内存 |
| 注销后验 | 首次UI仅看登录页，漏检远端错误；现等待真实`/auth/logout`响应并硬断言200后再检查登录页。此后验是在客户端修好后补强，不伪造修复前红 |

原令牌测试入口迁到高级折叠区。集中`workspaceConnectPage`最初无等待就检查isVisible，5项旧UI停在隐藏令牌框；明确为夹具挂载竞态，改为等待summary可见再展开。原图/审核/编排断言保留，不回退产品账户界面。`codex-live.ts`仅更新高级入口点击，不运行模型来验收登录。

## 最终回归与界面检查

- local浏览器8/8，27.606秒：两账户旅程 + 原A01保存恢复、A03换身份、C10审核、C16多步绑定、C21活动、C22窗口布局；`ui-integration-fixed.log`。没有新增skip。
- `npm test`全量初轮108文件中106文件通过，1206项通过、1项失败、3项原有skip，另一个suite未建立；两个失败均为MongoMemoryServer临时端口61097/61341占用、启动未到业务断言。原日志 `full-node-tests.log` 保留，不能称初轮全绿。隔离复跑这两文件12/12，17.07秒，`mongo-port-isolated-rerun.log`；未改产品/端口夹具来掩盖失败。
- `npm run test:desktop-runtime`实际重建独立Node24运行时，包含新增依赖，原Node/SQLite/DSH闭环、重启及父断连检查通过；未拿此结果冒称原生桌面账户界面/系统钥匙串实测。
- 生产vue-tsc、浏览器测试strict、账户/HTTP测试独立strict、架构/消息和差异检查通过；Web及Electron main/preload生产编译均通过，有既有CJS与chunk体积提示。最终client代次修复后重新构建，非复用旧产物；未生成或发布新安装包。
- 根用空字段、无认证/发信动作的真实页面保存并查看纸面截图 `paper-login.png`，中文暖灰/宋体/接近直角，无LiquidGlass。截图预览服务随后关闭。

## 交付边界

真实SMTP投递没有验收；部署者需要按README配置SMTP主机/用户/密码/发件人与至少32字符稳定验证码密钥，并重启后端。所有流程测试使用每环境独占内存收件箱，未向真实地址发邮件。无SMTP不影响旧令牌和本地服务；已有用户的数据未自动归并到新邮箱身份。

原619文件可恢复基线与附件参考保持；本轮差异以该基线为准，未提交/推送/发布，未运行附件二进制或其开发指令，未改用户库。最终源码清单与实际变更范围见同目录`scope-readback.json`和`final-source-manifest.json`。
