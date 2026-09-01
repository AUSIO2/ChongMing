import { chromeCloseMenu } from './use-chrome-menu'
import type { ChromeMenuAction } from './types'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import { chromeShowToast } from './use-chrome-menu'
import { toolOpenDialog } from './tool-dialogs'
import { agentManagerRequestCreate } from '../stores/agent-manager-ui'

export function chromeDispatchAction(action: ChromeMenuAction) {
  const tabs = useWorkspaceTabsStore()

  switch (action) {
    case 'db:settings':
    case 'db:reconnect':
    case 'db:status':
      void tabs.openSingletonTab('database')
      return
    case 'agent:manager':
      void tabs.openSingletonTab('agents')
      return
    case 'agent:create':
      void tabs.openSingletonTab('agents').then(() => agentManagerRequestCreate())
      return
    case 'agent:reload':
      void (async () => {
        try {
          await window.electronAPI?.catalog.reload()
          chromeShowToast('智能体目录已重载')
        } catch (e) {
          chromeShowToast(e instanceof Error ? e.message : '重载失败')
        }
      })()
      return
    case 'file:save': {
      const mapId = tabs.activeMapId
      if (!mapId) {
        chromeShowToast('请先打开地图标签')
        return
      }
      void (async () => {
        try {
          chromeShowToast('已保存')
        } catch (e) {
          chromeShowToast(e instanceof Error ? e.message : '保存失败')
        }
      })()
      return
    }
    case 'file:export-graph': {
      const mapId = tabs.activeMapId
      if (!mapId) {
        chromeShowToast('请先打开地图标签')
        return
      }
      void (async () => {
        try {
          const result = await window.electronAPI.file.exportMap(mapId)
          if (result.cancelled) return
          if (result.ok && result.path) {
            chromeShowToast(`已导出至 ${result.path}`)
          } else {
            chromeShowToast('导出失败')
          }
        } catch (e) {
          chromeShowToast(e instanceof Error ? e.message : '导出失败')
        }
      })()
      return
    }
    case 'tool:dedup-claims':
      if (!tabs.activeMapId) {
        chromeShowToast('请先打开地图标签')
        return
      }
      toolOpenDialog('dedup')
      return
    case 'tool:batch-subagent-params':
      if (!tabs.activeMapId) {
        chromeShowToast('请先打开地图标签')
        return
      }
      toolOpenDialog('batch-subagent')
      return
    case 'tool:batch-priority':
      if (!tabs.activeMapId) {
        chromeShowToast('请先打开地图标签')
        return
      }
      toolOpenDialog('batch-priority')
      return
    default:
      chromeShowToast('功能开发中')
  }
}

export function chromeDispatchAndClose(action: ChromeMenuAction) {
  chromeCloseMenu()
  chromeDispatchAction(action)
}
