# 前端界面与交互设计 - 实施计划

## 1. 待修改与新建文件清单

### [MODIFY] [preload.ts](file:///Users/xiong/ChongMing/electron/preload.ts)
- 通过 `contextBridge` 暴露 IPC 接口，包括：
  - `database` 系列：`news:create`, `news:list`, `news:get`
  - `graph` 系列：`graph:start-split`, `graph:start-verify`, `graph:resume`
  - 监听系列：`onGraphInterrupted`, `onGraphCompleted`

### [MODIFY] [main.ts](file:///Users/xiong/ChongMing/electron/main.ts)
- 引入数据库连接与 `runSplitGraph` / `runVerifyGraph`。
- 实现对应的 `ipcMain.handle` 接口。
- 图执行到中断点时，通过 `win.webContents.send('graph:interrupted')` 将 state 与 nextNode 派发给前端，并通过 Promise 挂起等待前端响应。

### [NEW] [shims-vue.d.ts](file:///Users/xiong/ChongMing/src/shims-vue.d.ts) (已新建)
- 支持 TypeScript 对 Vue 单文件组件的声明解析。

### [NEW] [store.ts](file:///Users/xiong/ChongMing/src/store/index.ts)
- 使用 Pinia 存储全局新闻列表、当前选中新闻、拆分中状态、核查中状态及当前 HITL 暂停状态。

### [REWRITE] [App.vue](file:///Users/xiong/ChongMing/src/App.vue)
- 根组件挂载及整体布局样式设置。

### [REWRITE] [HomeView.vue](file:///Users/xiong/ChongMing/src/views/HomeView.vue)
- 双栏工作台核心逻辑与样式实现。
  - 左栏：显示新闻详情、上下文列表（表格）、正文事实高亮。
  - 右栏：顶部放置视图切换开关（工作台/流程图）。
    - **工作台视图**：常规的垂直表单与卡片列表，以及简单的水平进度指示器。
    - **流程图视图**：内置一个基于 SVG 渲染的拓扑图连接图，直观展现从输入到输出的各节点，将当前的暂停节点加粗并呈琥珀呼吸状态。双击或点击节点弹出一个表单卡片进行修改。
    - 当前中断节点的修改配置表单（如：分配角度及优先级的动态配置、各 SubAgent 的结果核对修改、单条事实的最终置信度 0/0.5/1 调整与理由修改）、运行模式控制（Auto / Manual 开关）。

### [MODIFY] [style.css](file:///Users/xiong/ChongMing/src/style.css)
- 引入简单、严肃的高对比度调色盘与全局排版规则。

---

## 2. HITL 桥接机制实现细节
当图执行到中断点触发 `onInterrupt` 回调时：
1. 主进程向渲染进程发送 `graph:interrupted` 消息，附带当前 State 副本与下个节点名称。
2. 主进程创建一个 Promise，并将 resolve 引用暂存在一个全局 Map 中。
3. 渲染进程收到消息后暂停，展示修改表单。
4. 用户点击“继续”时，渲染进程通过 `ipcRenderer.invoke('graph:resume', modifications)` 传回修改内容。
5. 主进程接收到调用，找到对应的 resolve 函数，触发它并将数据返回给 LangGraph 状态图继续运行。
