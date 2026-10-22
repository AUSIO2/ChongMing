// 测试 Vite 固定当前文档；外部开发配置的变更不能清空正在验收的内存登录。
import type { Plugin } from 'vite'

enum WorkspaceViteError {
  FILE_WATCH_ACTIVE = 'M00 测试 Web 服务的文件监听未被实际关闭。',
}

export function workspaceCreateStaticDocumentPlugin(): Plugin {
  // 合并配置后直接禁用监听，避开 Vite mergeConfig 忽略 inline null 的行为。
  return {
    name: 'm00-static-document',
    config: {
      order: 'post',
      handler(/* 已经过文件及 inline 配置合并的本轮 Vite 配置。 */ config): void {
        // 不返回待合并对象，让 null 原样进入 resolveServerOptions 并建立 NoopWatcher。
        config.server ??= {}
        config.server.watch = null
      },
    },
    configResolved(/* 当前 Vite 最终解析结果，不读取服务地址或凭据。 */ config): void {
      // 在任何页面启动前确认监听确实关闭，不能把无效配置当作已隔离环境。
      if (config.server.watch !== null) throw new Error(WorkspaceViteError.FILE_WATCH_ACTIVE)
    },
  }
}
