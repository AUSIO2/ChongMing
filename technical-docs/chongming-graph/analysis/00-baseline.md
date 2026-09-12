# 重明图服务技术说明书基线

| 字段 | 内容 |
|---|---|
| 服务名 | 重明图服务（Graph API、Host 与 DSH 工作适配器） |
| 仓库 | AUSIO2/ChongMing |
| 分支 | `codex/run-review-core` |
| Commit | `b5b6df5af5367b1147f0311c6fe96f1cf0fbf903` |
| Commit 时间 | 2026-09-12T12:53:49+08:00 |
| 工作区状态 | dirty；目标新后端、客户端与契约在该 Commit 上无未提交改动 |
| 构建环境 | Node.js 24.11.1、npm 11.6.2、TypeScript 5.2、Mongoose 9.7、Electron 30 |
| 工程规则 | 根目录 `AGENTS.md` 会话指令、`coding.md`；参考流程为 WisePen AI 生产规范 v2.13 |
| 分析范围 | `backend/`、`client/`、`contracts/`、`electron/client-*`、`src/api.ts` 及新客户端状态对服务语义的消费 |
| 排除范围 | 旧 `electron/mapper`、旧 `electron/api`、旧 `server/`、旧页面内部实现；它们不在默认新客户端启动依赖中 |
| 未取得材料 | 生产部署清单、正式域名、证书、监控系统、外部 DSH 插件实现清单；只按仓库可见契约陈述 |

## Dirty 文件隔离

以下文件在基线前已有用户改动，既不作为新图服务事实来源，也不由本说明书任务修改：`coding.md`、`electron/api/map-lease.ts`、`electron/mapper/project.ts`、`electron/mapper/service.ts`、`electron/mapper/types.ts`、`electron/shared/database.ts`、`index.html` 及五个旧 Mapper/lease 测试文件。

## 版本边界

主文首页复制服务名、分支和完整 Commit。证据层使用源码符号与基线行号；后续代码提交会使行号漂移，符号为主定位。说明书描述“当前已实现”，不把 parse/split 配置能力写成已接通的执行能力。
