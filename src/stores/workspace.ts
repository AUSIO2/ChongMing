import { defineStore } from 'pinia'
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
        await this.selectMap(map._id)
      } finally {
        this.loading = false
      }
    },
  },
})
