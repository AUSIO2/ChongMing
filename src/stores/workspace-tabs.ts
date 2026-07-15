import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import type { DisplayMapSummary } from '../../electron/api/types'
import { portReadApi } from '../flow-map'
import { useFlowMapStore } from './flow-map'
import { useRunCoordinatorStore } from './run-coordinator'
import { useWorkspaceStore } from './workspace'

export type WorkspaceTabKind = 'map' | 'database' | 'agents'

export const TAB_ID_DATABASE = '__database__'
export const TAB_ID_AGENTS = '__agents__'

export interface WorkspaceTab {
  id: string
  kind: WorkspaceTabKind
  title: string
  selectedNodeId?: string | null
}

export const useWorkspaceTabsStore = defineStore('workspace-tabs', () => {
  const tabs = ref<WorkspaceTab[]>([])
  const activeTabId = ref<string | null>(null)

  const activeTab = computed(() =>
    tabs.value.find(t => t.id === activeTabId.value) ?? null,
  )

  const activeMapId = computed(() =>
    activeTab.value?.kind === 'map' ? activeTab.value.id : null,
  )

  function hasMapTab(mapId: string): boolean {
    return tabs.value.some(t => t.kind === 'map' && t.id === mapId)
  }

  function tabReadTitle(kind: WorkspaceTabKind): string {
    if (kind === 'database') return '数据库'
    if (kind === 'agents') return '智能体'
    return 'Map'
  }

  function tabSaveMapSelection() {
    const tab = activeTab.value
    if (!tab || tab.kind !== 'map') return
    tab.selectedNodeId = useFlowMapStore().selectedNodeId
  }

  async function tabActivateMap(mapId: string, selectedNodeId?: string | null) {
    const workspace = useWorkspaceStore()
    const flowMap = useFlowMapStore()
    await workspace.selectMap(mapId)
    await flowMap.attachMap(mapId)
    if (selectedNodeId) await flowMap.selectNode(selectedNodeId)
  }

  async function activateTab(id: string) {
    if (activeTabId.value === id) return
    tabSaveMapSelection()
    activeTabId.value = id
    const tab = tabs.value.find(t => t.id === id)
    if (!tab) return
    const workspace = useWorkspaceStore()
    const flowMap = useFlowMapStore()
    if (tab.kind === 'map') {
      await tabActivateMap(tab.id, tab.selectedNodeId ?? null)
      return
    }
    workspace.currentMapId = null
    workspace.currentMap = null
    flowMap.detachMap()
  }

  async function openMapTab(mapId: string, title?: string) {
    const existing = tabs.value.find(t => t.kind === 'map' && t.id === mapId)
    if (existing) {
      if (title && existing.title !== title) existing.title = title
      await activateTab(existing.id)
      return
    }
    tabs.value.push({
      id: mapId,
      kind: 'map',
      title: title?.trim() || 'Map',
    })
    await activateTab(mapId)
    void useRunCoordinatorStore().runSyncPhase(mapId)
  }

  async function openSingletonTab(kind: 'database' | 'agents') {
    const id = kind === 'database' ? TAB_ID_DATABASE : TAB_ID_AGENTS
    const existing = tabs.value.find(t => t.id === id)
    if (existing) {
      await activateTab(id)
      return
    }
    tabs.value.push({ id, kind, title: tabReadTitle(kind) })
    await activateTab(id)
  }

  async function closeTab(id: string, options?: { forceCancelRunning?: boolean }) {
    const tab = tabs.value.find(t => t.id === id)
    if (!tab) return

    if (tab.kind === 'map') {
      const coordinator = useRunCoordinatorStore()
      const phase = coordinator.runReadPhase(tab.id)
      if (phase === 'running') {
        if (!options?.forceCancelRunning) return false
        await portReadApi().cancel(tab.id)
      }
      coordinator.runUntrackMap(tab.id)
    }

    const idx = tabs.value.findIndex(t => t.id === id)
    const wasActive = activeTabId.value === id
    tabs.value.splice(idx, 1)

    if (wasActive) {
      const next = tabs.value[idx] ?? tabs.value[idx - 1]
      activeTabId.value = next?.id ?? null
      if (next) await activateTab(next.id)
      else {
        const workspace = useWorkspaceStore()
        workspace.currentMapId = null
        workspace.currentMap = null
        useFlowMapStore().detachMap()
      }
    }
    return true
  }

  function closeAllMapTabs(): string[] {
    const mapIds = tabs.value.filter(t => t.kind === 'map').map(t => t.id)
    tabs.value = tabs.value.filter(t => t.kind !== 'map')
    const coordinator = useRunCoordinatorStore()
    for (const mapId of mapIds) {
      coordinator.runUntrackMap(mapId)
      portReadApi().unloadMap(mapId)
    }
    return mapIds
  }

  async function onDbSwitched(mapList: DisplayMapSummary[]) {
    closeAllMapTabs()
    const workspace = useWorkspaceStore()
    workspace.currentMapId = null
    workspace.currentMap = null
    useFlowMapStore().detachMap()
    await workspace.loadWorkspaces()
    if (mapList.length > 0 && workspace.currentWorkspaceId) {
      workspace.mapList = mapList.filter(
        m => m.workspaceId === workspace.currentWorkspaceId,
      )
      if (workspace.mapList.length === 0) {
        await workspace.loadMapList()
      }
    } else {
      await workspace.loadMapList()
    }
    if (tabs.value.some(t => t.id === TAB_ID_DATABASE)) {
      activeTabId.value = TAB_ID_DATABASE
      await activateTab(TAB_ID_DATABASE)
    } else {
      activeTabId.value = tabs.value[0]?.id ?? null
      if (activeTabId.value) await activateTab(activeTabId.value)
    }
  }

  function updateMapTitle(mapId: string, title: string) {
    const tab = tabs.value.find(t => t.kind === 'map' && t.id === mapId)
    if (tab) tab.title = title.trim() || 'Map'
  }

  async function flushAllMapTabs(): Promise<void> {
    const { portReadApi } = await import('../flow-map')
    for (const tab of tabs.value) {
      if (tab.kind !== 'map') continue
      await portReadApi().flushMap(tab.id)
    }
  }

  function hasRunningMapTab(): boolean {
    const coordinator = useRunCoordinatorStore()
    return tabs.value.some(
      t => t.kind === 'map' && coordinator.runReadPhase(t.id) === 'running',
    )
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    activeMapId,
    hasMapTab,
    activateTab,
    openMapTab,
    openSingletonTab,
    closeTab,
    closeAllMapTabs,
    onDbSwitched,
    updateMapTitle,
    tabSaveMapSelection,
    flushAllMapTabs,
    hasRunningMapTab,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceTabsStore, import.meta.hot))
}
