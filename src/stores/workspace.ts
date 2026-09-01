import { defineStore, acceptHMRUpdate } from 'pinia'
import type {
  DisplayWorkspaceSummary,
} from '../../electron/api/types'
import type {
  MapperMapSummary,
  MapperSnapshot,
} from '../../electron/mapper/types'

const WORKSPACE_STORAGE_KEY = 'chongming.currentWorkspaceId'

function getApi() {
  return typeof window !== 'undefined' ? window.electronAPI : undefined
}

function workspaceReadStoredId(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY)
  } catch {
    return null
  }
}

function workspaceWriteStoredId(id: string): void {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    workspaceList: [] as DisplayWorkspaceSummary[],
    currentWorkspaceId: null as string | null,
    mapList: [] as MapperMapSummary[],
    currentMapId: null as string | null,
    currentMap: null as MapperSnapshot | null,
    loading: false,
  }),

  getters: {
    currentWorkspace(state): DisplayWorkspaceSummary | null {
      if (!state.currentWorkspaceId) return null
      return state.workspaceList.find(w => w._id === state.currentWorkspaceId) ?? null
    },
  },

  actions: {
    async loadWorkspaces() {
      const api = getApi()
      if (!api?.workspace) return
      this.workspaceList = await api.workspace.list()
      if (this.workspaceList.length === 0) return

      const stored = workspaceReadStoredId()
      const match = stored && this.workspaceList.some(w => w._id === stored)
        ? stored
        : this.workspaceList[0]._id
      this.currentWorkspaceId = match
      workspaceWriteStoredId(match)
    },

    async selectWorkspace(workspaceId: string) {
      if (this.currentWorkspaceId === workspaceId) return
      const { useWorkspaceTabsStore } = await import('./workspace-tabs')
      const { useFlowMapStore } = await import('./flow-map')
      useWorkspaceTabsStore().closeAllMapTabs()
      useFlowMapStore().detachMap()
      this.currentWorkspaceId = workspaceId
      workspaceWriteStoredId(workspaceId)
      this.currentMapId = null
      this.currentMap = null
      await this.loadMapList()
    },

    async createWorkspace(name: string, copyLocalAgents = true) {
      const api = getApi()
      if (!api?.workspace) return
      const ws = await api.workspace.create({
        name: name.trim() || '未命名工作区',
        copyLocalAgents,
      })
      await this.loadWorkspaces()
      await this.selectWorkspace(ws._id)
    },

    async uploadLocalAgents(mode: 'merge' | 'replace' = 'merge') {
      const api = getApi()
      if (!api?.workspace || !this.currentWorkspaceId) return
      await api.workspace.uploadLocalAgents(this.currentWorkspaceId, mode)
      await this.loadWorkspaces()
    },

    async loadMapList() {
      const api = getApi()
      if (!api || !this.currentWorkspaceId) return
      this.loading = true
      try {
        const result = await api.mapper.read({
          type: 'map.list',
          workspaceId: this.currentWorkspaceId,
        })
        if (result.type === 'map.list') this.mapList = result.maps
      } finally {
        this.loading = false
      }
    },

    async selectMap(mapId: string) {
      const api = getApi()
      if (!api) return
      this.currentMapId = mapId
      const result = await api.mapper.read({ type: 'map.snapshot', mapId })
      this.currentMap = result.type === 'map.snapshot' ? result.snapshot : null
    },

    async refreshCurrentMap() {
      if (!this.currentMapId) return
      const api = getApi()
      if (!api) return
      const result = await api.mapper.read({
        type: 'map.snapshot',
        mapId: this.currentMapId,
      })
      this.currentMap = result.type === 'map.snapshot' ? result.snapshot : null
    },

    async renameMap(mapId: string, name: string) {
      const api = getApi()
      if (!api) return
      const { useWorkspaceTabsStore } = await import('./workspace-tabs')
      const tabs = useWorkspaceTabsStore()
      const hadTab = tabs.hasMapTab(mapId)
      let acquiredHere = false
      {
        const lease = await api.mapper.dispatch({ type: 'lease.acquire', mapId })
        if (lease.type !== 'lease.updated' || !lease.ok) {
          throw new Error('地图正被其他客户端占用，无法重命名')
        }
        acquiredHere = !hadTab
      }
      try {
        const result = await api.mapper.dispatch({
          type: 'map.rename',
          mapId,
          name: name.trim(),
        })
        if (result.type !== 'map.updated') throw new Error('rename failed')
        const map = result.snapshot
        const idx = this.mapList.findIndex(m => m.id === mapId)
        if (idx >= 0) {
          this.mapList[idx] = {
            ...this.mapList[idx],
            name: map.name,
            updatedAt: new Date().toISOString(),
          }
        }
        if (this.currentMapId === mapId) {
          this.currentMap = map
        }
        tabs.updateMapTitle(mapId, map.name?.trim() || 'Map')
      } finally {
        if (acquiredHere) {
          await api.mapper.dispatch({ type: 'lease.release', mapId })
        }
      }
    },

    async deleteMap(mapId: string) {
      const api = getApi()
      if (!api) return
      await api.mapper.dispatch({ type: 'map.delete', mapId })
      const { useWorkspaceTabsStore } = await import('./workspace-tabs')
      const { useFlowMapStore } = await import('./flow-map')
      const tabs = useWorkspaceTabsStore()
      if (tabs.hasMapTab(mapId)) {
        await tabs.closeTab(mapId, { forceCancelRunning: true })
      } else if (this.currentMapId === mapId) {
        useFlowMapStore().detachMap({ unload: true })
        this.currentMapId = null
        this.currentMap = null
      }
      await this.loadMapList()
      await this.loadWorkspaces()
    },

    async createMap() {
      const api = getApi()
      if (!api || !this.currentWorkspaceId) return
      this.loading = true
      try {
        const result = await api.mapper.dispatch({
          type: 'map.create',
          workspaceId: this.currentWorkspaceId,
        })
        if (result.type !== 'map.updated') throw new Error('map create failed')
        const map = result.snapshot
        await this.loadMapList()
        await this.loadWorkspaces()
        const { useWorkspaceTabsStore } = await import('./workspace-tabs')
        await useWorkspaceTabsStore().openMapTab(map.mapId, map.name?.trim() || 'Map')
      } finally {
        this.loading = false
      }
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceStore, import.meta.hot))
}
