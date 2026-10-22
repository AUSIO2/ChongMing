# 浏览器与夹具回归

2026-10-18：按用户决定精简过重的测试设施，保留已验证的业务回归，跳过 M00 剩余扩展验收，进入 [M01 讨论](../../develop-docs/096-前后端功能补齐/M01-服务能力与会话恢复.md)。暂缓项不记为通过；历次首失败、修复与测量结果统一保留在[实施台账](../../develop-docs/096-implement-前后端功能补齐.md)。

## 当前维护范围

| 文件 | 维护的行为 |
| --- | --- |
| `workspace-acceptance.spec.ts` | 真实界面创建、同账号重入、视图切换、换账号与角色权限 |
| 同文件 `M01-C02` 与 A04 扩展 | 真实本机/协作能力门控、旧 bootstrap 缺字段兼容、viewer 可读不可写；禁用后无证据库请求且图保存正常 |
| 同文件 `M02-C04` | 当前图空/非空改名、取消/确认删除、其他图与固定证据保留；协作真实占用/释放及两模式 Viewer 拒绝 |
| 同文件 `M02-C05` | 显式后继/引用关系的页面增改删、来源脚注及标签保留、协作新目标占用/释放与 Viewer 拒绝 |
| `workspace-reliability.spec.ts` | 已提交上传丢响应后重试原请求，核对资产唯一性及字节 |
| 同文件 `M01-C03` | 偏好实际提交后丢响应的原请求恢复，以及同身份并发写的真实版本冲突；恢复期间图仍可交互 |
| `workspace-concurrency.spec.ts` | 同分支竞争、独立分支写入、迟到响应和 SSE 断流恢复 |
| `workspace-grant-reliability.spec.ts`、`workspace-grant-relay.ts` | 真实旧帧不撤销新授权，真正释放仍撤权；保留原始字节和实际消费边界 |
| `workspace-editing-reliability.spec.ts` | 连续编辑不假冲突、真实外部冲突保留草稿、删除后孤稿可复制 |
| `workspace-recovery.spec.ts` | 优雅/强杀重开 API，保留原身份、正文、资产、收据，并继续编辑 |
| `workspace-recovery-lifecycle.spec.ts` | 当前恢复设施正常关闭、重开/关闭交错和原存储归属 |
| `workspace-fixture.ts`、`workspace-recovery-fixture.ts`、`fixtures/workspace-recovery-process.ts` | 装配真实服务和测试页面；恢复 child 只重开 API，不启动 Host/Run |
| `workspace-vite.ts`、`../client/ui-web-config.spec.ts` | 使用真实 Vite 配置解析确认监听实际关闭，避免 inline null 合并问题 |
| `fixtures/workspace-startup-diagnostic.ts`、`../client/ui-startup-diagnostic.spec.ts` | 固定诊断字段、未知值/额外字段拒绝与安全 cause 的轻量合同 |
| `../client/ui-fixture-lifecycle.spec.ts` | 旧夹具清理、幂等、首错/多错误及真实资源保持 |
| `safe-reporter.ts`、`../client/ui-reporter.spec.ts`、`../client/ui-report-artifacts.spec.ts` | 安全字段投影及真实失败产物脱敏 |
| `workspace-dataset.ts`、`workspace-performance.spec.ts`、`workspace-performance-report.ts` | 已有数据集和独立性能入口，正式容量与耐久本轮暂缓 |

## 运行

在仓库根执行：

```sh
npm run test:ui:types
npm run test:ui:fixture
npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --project=local
npm run test:ui -- --project=local
npm run test:ui -- --project=collab
```

C02 可单独运行 `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M01-C02`。复用原服务与客户端；旧服务模拟仅删除真实 bootstrap 的可选能力字段，不伪造查询/命令成功。源服务依旧相同，不把这项测试当作 Web 跨域连接验证。

C03 可单独运行 `npm run test:ui -- tests/browser/workspace-reliability.spec.ts --grep M01-C03`。每模式两条单轮流程：真实提交后仅丢回包；页面旧请求形成后插入一次独立真实写入，再原样转发产生 409。以独立 API 核对最终偏好和版本，不伪造提交/冲突结果，不把同身份客户端竞态称为双浏览器验收。

C04 可单独运行 `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M02-C04`。复用现有创建、改名与确认控件，以独立 API 核对图版本/内容/删除及固定证据。编辑占用仅在 collab 真正 claim/release，本机不发送租约命令；两模式都验证 Viewer 接口拒绝，不启动模型运行。

C05 可单独运行 `npm run test:ui -- tests/browser/workspace-acceptance.spec.ts --grep M02-C05`。页面建立后继并标第一/三行脚注，再修改标签；引用换目标后明确删除，节点和正文仍保留。普通 Web fixture 使用 Vite 原生空闲端口选择，不把 `port:0` 当作随机端口，允许用户5173预览与验收共存。

`test:ui:fixture` 维护 28 项生命周期、报告、产物、配置和诊断合同；业务会话回归另在 `tests/client/session*.spec.ts` 等文件中维护。Vitest 排除 `tests/browser/**`，普通 Playwright 排除 `fixtures/**` 与性能 spec。没有新增 `skip/fixme/test.fail` 作为精简手段。

local 使用独立 SQLite；collab 使用临时 Mongo 与 RabbitMQ，需要 Docker。可通过既有 `CHONGMING_TEST_BROKER_FILE` 借用 broker，仅清理自有 namespace。普通和恢复页面共用测试 Vite 配置插件，开发预览配置保持不变。

独立性能命令仍可按需运行，默认只做短校准：

```sh
npm run test:ui:perf -- --project=local
```

正式容量、长时测试、看门狗和扩展异常退出资格已按用户决定暂缓，不再阻塞 M01。原偶发启动失败没有定位，阶段/错误码诊断保留；它不再成为继续扩建测试框架的任务。

## 精简及覆盖边界

已移除三个重型启动故障 Node suite、两个专用故障 fixture 和配置变更重新领取场景。原真实 IPC、故障进程退出与 HMR/导航联动证据保留在台账，退出当前维护集。

轻量诊断测试只验证纯投影合同；真实 Vite 解析测试只验证配置装配。两者不冒充完整跨进程或重启/租期验证。真实业务授权、草稿基线、正常生命周期、脱敏产物及原 R04/R05 仍保留。

默认关闭 trace、HAR、video 与自动截图，失败产物不保留原始 error-context。报告不输出凭据、正文、原始错误或自由附件。TestResult.duration 不代表带独立时限 fixture 的完整启动墙钟；历史性能、前置故障与各轮结果不拼成一次全绿。
