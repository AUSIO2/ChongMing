# 012 — 全局 AppError 异常体系

## 背景

当前各模块使用裸 `throw new Error(string)`，图运行仅在 `executeRun` 顶层 catch 后推送 `{ error: string }`。问题：

- 无稳定错误码，前端/日志无法分类
- LangGraph 节点失败时丢失「死在哪个节点」
- `graph:error` 不含 `newsId`，前端靠 `lastRun` 匹配存在竞态丢错

## 目标

1. 统一异常形态：`{ code, msg }`，可选 `failedNode`
2. `ErrorCode` 枚举集中管理 code
3. 各模块只抛 `AppError`，由全局捕获器规范化并下发
4. LangGraph 异常在编排循环按步捕获，附带 `failedNode`

## 错误模型

### ErrorCode（字符串枚举）

| 分组 | code | 场景 |
|---|---|---|
| 通用 | `INTERNAL_ERROR` | 未知异常 |
| 配置 | `CONFIG_API_KEY_MISSING` | DeepSeek key 未配置 |
| 新闻 | `NEWS_NOT_FOUND` | 文档不存在 |
| 图 | `GRAPH_RUN_NOT_FOUND` | runId 无效 |
| 图 | `GRAPH_NO_PENDING_INTERRUPT` | resume 时无挂起 |
| 图 | `GRAPH_EXECUTION_FAILED` | LangGraph / LLM 节点失败 |
| 核查 | `CLAIM_NOT_FOUND` | claim 不存在 |
| Map | `MAP_API_NOT_INSTALLED` 等 | 前端 Map 操作非法 |

### AppError

```ts
class AppError extends Error {
  code: ErrorCode
  msg: string          // 与 message 同值
  failedNode?: string  // 图路径：loadNews / route / subAgent / merge / save / checkpoint
  cause?: unknown      // 原始错误，仅主进程日志
}
```

### 工具函数

- `normalizeError(error, fallbackCode?, extras?)`：已是 AppError 则合并 extras；否则包装
- `serializeAppError` / `toAppError`：IPC invoke 只保证 `Error.message`，用 `__APP_ERROR__:{json}` 前缀序列化
- `errorMessage(e)` → `toAppError(e).msg`

## 捕获架构

```
节点 throw AppError | LLM Error
        ↓
graph.invoke reject
        ↓
runGraphWithInterrupts 逐步 catch
  → normalizeError(..., GRAPH_EXECUTION_FAILED, { failedNode })
        ↓
executeRun catch
  → GraphErrorPayload { runId, newsId, graphType, code, msg, failedNode? }
        ↓
renderer onError(newsId)
```

IPC invoke 路径：

```
news / resume / setMode throw AppError
        ↓
register-handlers handle() catch
  → serializeAppError(normalizeError(e))
        ↓
renderer toAppError
```

### LangGraph 捕获要点

- LangGraph 无全局 onError；错误表现为 `invoke` Promise reject
- 在 `runGraphWithInterrupts` 对每次 `invoke` / `getState` / `updateState` 包 try/catch
- 业务 AppError **保留原 code/msg**，只补 `failedNode`
- interrupt（`interruptBefore`）不是异常
- 扇出 fail-fast，`failedNode: 'subAgent'`，不拆 agentName

## GraphErrorPayload

```ts
{
  runId: string
  newsId: string
  graphType: 'split' | 'verify'
  code: ErrorCode
  msg: string
  failedNode?: string
}
```

用 `newsId` 直接更新前端 meta，消除 `lastRun` 竞态。

## 边界

- DB 连接 fallback、LLM JSON 静默降级：不改为抛异常
- 取消语义本轮不改
- 不引入 Result 包装 IPC 返回值
