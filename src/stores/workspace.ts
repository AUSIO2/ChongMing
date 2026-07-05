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

    async createMap() {
      const api = getApi()
      if (!api) return
      this.loading = true
      try {
        const map = await api.map.create({
          content: '（请在此粘贴或编辑新闻正文）',
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
