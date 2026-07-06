import { defineStore, acceptHMRUpdate } from 'pinia'
import type {
  DisplayMap,
  DisplayMapSummary,
} from '../../electron/api/types'

function getApi() {
  return typeof window !== 'undefined' ? window.electronAPI : undefined
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    mapList: [] as DisplayMapSummary[],
    currentMapId: null as string | null,
    currentMap: null as DisplayMap | null,
    loading: false,
  }),

  actions: {
    async loadMapList() {
      const api = getApi()
      if (!api) return
      this.loading = true
      try {
        this.mapList = await api.map.list()
      } finally {
        this.loading = false
      }
    },

    async selectMap(mapId: string) {
      const api = getApi()
      if (!api) return
      this.currentMapId = mapId
      this.currentMap = await api.map.get(mapId)
    },

    async refreshCurrentMap() {
      if (!this.currentMapId) return
      const api = getApi()
      if (!api) return
      this.currentMap = await api.map.get(this.currentMapId)
    },

    async renameMap(mapId: string, name: string) {
      const api = getApi()
      if (!api) return
      const map = await api.map.update(mapId, { name: name.trim() })
      const idx = this.mapList.findIndex(m => m._id === mapId)
      if (idx >= 0) {
        this.mapList[idx] = {
          ...this.mapList[idx],
          name: map.name,
          updatedAt: map.updatedAt,
        }
      }
      if (this.currentMapId === mapId) {
        this.currentMap = map
      }
      const { useWorkspaceTabsStore } = await import('./workspace-tabs')
      useWorkspaceTabsStore().updateMapTitle(mapId, map.name?.trim() || 'Map')
    },

    async deleteMap(mapId: string) {
      const api = getApi()
      if (!api?.map.delete) {
        throw new Error('map.delete API 不可用，请重启 Electron 应用')
      }
      await api.map.delete(mapId)
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
    },

    async createMap() {
      const api = getApi()
      if (!api) return
      this.loading = true
      try {
        const map = await api.map.create({
          content: '',
          context: {},
        })
        await this.loadMapList()
        const { useWorkspaceTabsStore } = await import('./workspace-tabs')
        await useWorkspaceTabsStore().openMapTab(map._id, map.name?.trim() || 'Map')
      } finally {
        this.loading = false
      }
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceStore, import.meta.hot))
}
