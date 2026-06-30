/** preload 暴露给渲染进程的 API 类型（与 preload.ts 保持同步） */
export interface ElectronAPI {
  // 后续在此添加业务 API
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
