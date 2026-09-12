# 重明图服务技术说明书基线

| 字段 | 内容 |
|---|---|
| 服务名 | 重明图服务（Graph API、Host 与 DSH 工作适配器） |
| 仓库 | AUSIO2/ChongMing |
| 分支 | `codex/run-review-core` |
| 基础 Commit | `1ae38fa93d616fb2b32bfa567808b2d7c61d347e` |
| 当前源码快照 | 55 个新架构文件内容 SHA-256：`cbc2b902e029abb2fca2c960f2e18245ba5a201cd58f2b531366074fbab6a02d` |
| 工作区状态 | dirty；059 节点驱动架构尚未提交，本文绑定上述内容快照 |
| 构建环境 | Node.js 24.11.1、npm 11.6.2、TypeScript 5.2、Mongoose 9.7、Electron 30 |
| 工程规则 | 根目录 `AGENTS.md` 会话指令、`coding.md`；参考流程为 WisePen AI 生产规范 v2.13 |
| 分析范围 | `backend/`、`client/`、`contracts/`、`electron/client-*`、`src/api.ts` 及新客户端状态对服务语义的消费 |
| 排除范围 | 旧 `electron/mapper`、旧 `electron/api`、旧 `server/`；它们不在默认新客户端启动依赖中 |
| 未取得材料 | 生产部署清单、正式域名、证书、监控系统、外部 DSH 插件实现清单；只按仓库可见契约陈述 |

## Dirty 文件隔离

以下文件在基线前已有用户改动，既不作为新图服务事实来源，也不由本说明书任务修改：`coding.md`、`electron/api/map-lease.ts`、`electron/mapper/project.ts`、`electron/mapper/service.ts`、`electron/mapper/types.ts`、`electron/shared/database.ts`、`index.html` 及五个旧 Mapper/lease 测试文件。

## 版本边界

主文首页复制服务名、分支、基础 Commit 和工作树快照。证据层使用源码符号；行号以快照为准。parse/split/verify 已接通，完整管理 UI、SSE 和旧源码清理仍不写成已完成。
