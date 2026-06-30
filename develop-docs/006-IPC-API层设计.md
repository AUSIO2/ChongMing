# IPC API 层设计

## 目标

将前后端通信从 `main.ts` / `preload.ts` 中抽离到独立 `electron/api/` 模块，提供类型安全的新闻 CRUD 与 LangGraph HITL 桥接。

## 目录结构

```
electron/api/
├── channels.ts          # IPC channel 常量
├── types.ts             # DTO + ElectronAPI 类型（前后端共享）
├── serialize.ts         # Mongoose / Graph State 序列化
├── agent-config.ts      # LLM 与 SubAgent 注册配置
├── news-service.ts      # 新闻 CRUD
├── graph-service.ts     # 图执行 + HITL Promise 桥接
├── register-handlers.ts # ipcMain.handle 注册
└── index.ts
```

## IPC 通道

| Channel | 方向 | 说明 |
|---------|------|------|
| `news:create` | invoke | 创建新闻 |
| `news:list` | invoke | 列表 |
| `news:get` | invoke | 详情 |
| `news:update` | invoke | 更新 |
| `graph:start-split` | invoke | 启动拆分（立即返回 runId） |
| `graph:start-verify` | invoke | 启动核查 |
| `graph:resume` | invoke | HITL 继续 |
| `graph:set-mode` | invoke | 切换 auto / human-in-loop |
| `graph:cancel` | invoke | 取消运行 |
| `graph:interrupted` | push | 中断点暂停 |
| `graph:completed` | push | 执行完成 |
| `graph:error` | push | 执行失败 |

## HITL 桥接

`graph-service` 在 `onInterrupt` 内：
1. `webContents.send('graph:interrupted', payload)`
2. `await waitForResume(runId)` — Promise 挂起
3. `graph:resume` 触发 resolve，将 modifications 回传给 LangGraph

## 序列化原则

- 不向渲染进程传递 `BaseChatModel`、`tools` 等不可序列化对象
- Graph state 使用专用 DTO（`SplitGraphStateDTO` / `VerifyGraphStateDTO`）
- Date → ISO 8601 字符串
