# 012-implement — 全局 AppError 异常体系

## 步骤

1. **errors.ts**：`ErrorCode`、`AppError`、`normalizeError`、`serializeAppError`、`toAppError`、更新 `errorMessage`
2. **graph-utils.ts**：`runGraphWithInterrupts` 逐步 try/catch，附带 `failedNode`
3. **types.ts**：`GraphErrorPayload` 改为 `code` + `msg` + `newsId` + `failedNode?`
4. **graph-service.ts**：`executeRun` 用 `normalizeError` 下发新 payload；resume/setMode 抛 `AppError`
5. **register-handlers.ts**：`handle()` 全局捕获
6. **模块迁移**：news-service、agent-config、extractor、verifier、electron-ipc、port 改为 `AppError`
7. **前端**：`onError` 按 `newsId` 写错；flow-map store 用 `toAppError`

## 验收

- 节点 `NEWS_NOT_FOUND` → UI 显示对应 msg，payload 含 code 与 failedNode
- LLM 失败 → `GRAPH_EXECUTION_FAILED` + failedNode
- 缺 API key → `CONFIG_API_KEY_MISSING`，且不因 lastRun 竞态丢错
- resume 无挂起 → invoke reject，前端能解析 code/msg
