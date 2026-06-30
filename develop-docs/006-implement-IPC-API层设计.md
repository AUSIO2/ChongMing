# IPC API 层 - 实施计划

## 新建文件

| 文件 | 职责 |
|------|------|
| `electron/api/channels.ts` | IPC channel 常量 |
| `electron/api/types.ts` | DTO + `ElectronAPI` 接口 |
| `electron/api/serialize.ts` | 文档与 graph state 序列化 |
| `electron/api/agent-config.ts` | ChatOpenAI + SubAgent 配置 |
| `electron/api/news-service.ts` | 新闻 CRUD |
| `electron/api/graph-service.ts` | 图执行与 HITL 桥接 |
| `electron/api/register-handlers.ts` | 注册 ipcMain.handle |
| `electron/api/index.ts` | 模块导出 |

## 修改文件

| 文件 | 变更 |
|------|------|
| `electron/preload.ts` | 通过 contextBridge 暴露 `ElectronAPI` |
| `electron/main.ts` | `connectDB` + `registerIpcHandlers` |
| `electron/shared/electron-api.ts` | 重导出 `api/types` |

## 验证

- `npx vue-tsc --noEmit` 通过
- 渲染进程可调用 `window.electronAPI.news.list()`
