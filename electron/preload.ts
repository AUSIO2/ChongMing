import { contextBridge } from 'electron'

// 通过 contextBridge 向渲染进程暴露 API
// 后续在此添加业务 API
contextBridge.exposeInMainWorld('electronAPI', {})
