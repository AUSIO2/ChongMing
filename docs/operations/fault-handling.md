# 故障处理与诊断

本文说明当前已实现的错误边界、诊断位置和恢复语义。它不承诺自动上传、进程外监控或未经验证的平台能力。

## 公共错误与内部诊断

- 已知业务拒绝保留稳定 `code`、安全文案、是否可重试及必要的版本信息。未知 HTTP 故障只公开 `INTERNAL_ERROR`、固定文案和 `errorId`，不返回原始 `Error.message`、cause 或栈首行。
- `errorId` 用于关联用户可见错误与本机诊断。它不是幂等身份；写操作继续使用原 `requestId` 重试。
- 诊断上下文只接受 `requestId/mapId/runId/operationId/workId/phase/route/reason` 白名单和受限标量。默认记录不包含授权头、Token、模型正文、请求体或完整本机用户路径。
- 每条结构化诊断最多 16 KiB，栈最多 40 帧。文件达到 5 MiB 时轮转，最多保留 3 个归档。诊断写入失败只尝试一次最小 stderr 退路，不递归记录。

实现入口：[`contracts/diagnostics.ts`](../../contracts/diagnostics.ts)、[`platform/node/diagnostics.ts`](../../platform/node/diagnostics.ts)和 [`platform/node/process-boundary.ts`](../../platform/node/process-boundary.ts)。

## 进程终端与受控关闭

受控关闭与未捕获致命错误是两条路径：

- 正常信号、启动失败或主动退出进入可等待的关闭流程。Node 入口默认共用 15 秒总期限；一个关闭步骤失败不应阻止其他安全资源释放。
- `uncaughtException` 或 `unhandledRejection` 说明进程状态不再可信。此路径只做有界同步诊断，然后立即以状态码 1 退出，不在损坏进程中运行异步业务清理。
- 桌面本机子服务先等待 20 秒优雅停止，再发 `SIGTERM` 并等待 2 秒，最后发 `SIGKILL` 并等待 1 秒确认进程树退出。未确认退出必须报错，不得继续启动重叠实例。

## HTTP、SSE、IPC 与执行器

- HTTP 未知错误在最外层转换；已发送响应头或错误回复本身失败时，终止连接并记录一次诊断，不重复写头。
- SSE 认证、首帧、后续写入、取消和订阅释放各自有责任边界。客户断连不应杀死服务，撤权后不得继续推送。
- Electron IPC 校验 sender/主 Frame；Renderer 只能上报 UUID `errorId` 和固定来源，不能提交 message、stack 或任意诊断字段。
- Host/MQ 将短暂网络、选主和忙租约与永久协议/配置错误分开。永久错误终止无效循环；只有当前有效 grant/fence 可写入结果或 `work.fail`。

## 桌面与 Web 恢复

- Electron Main 持有页面加载失败、Renderer 退出/卡死和子进程故障的最小恢复入口。Vue 根应用已失效时，用户仍可重新打开界面或退出。
- Vue 在 mount 前安装框架、`window.error`、`unhandledrejection` 和 router 错误边界。普通业务拒绝与用户取消不应升级为整页崩溃。
- 重新加载不自动重放最后一次写操作；结果不确定的写入由原 `requestId` 显式重试。

## 日志位置

- 桌面 Main：Electron `userData/main-diagnostics.log`。
- 桌面本机服务：Electron `userData/local-service/service-diagnostics.log`。
- 独立 Graph API、Host、CLI 和 admin：结构化诊断写入当前进程 stderr，由部署环境决定收集与保留。

这些诊断默认不上传。向他人提供日志前仍应检查部署自定义的上下文与外部进程输出。

## 验证与已知缺口

```bash
npm run test:faults
npm run test:desktop-runtime
npm run build:check
```

自动化覆盖诊断脱敏、Node 终端边界、关闭期限、HTTP/IPC、Host/MQ 与客户端恢复的核心路径。正式发行前仍需在解锁的目标平台验收 Electron 真实加载失败、Renderer 崩溃/卡死和最小错误页二次失败。静态模块加载失败、错误回复 socket 二次故障、真实 stdout `EPIPE` 和本机通知子进程故障仍只有部分等价覆盖，不应声称已完整验收。
