import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref } from 'vue'
import type { MapperSnapshot } from '../../electron/mapper/types'

type MapRunPhase = MapperSnapshot['runPhase']

export const useRunCoordinatorStore = defineStore('run-coordinator', () => {
  const phaseByMapId = ref<Record<string, MapRunPhase>>({})

  function runReadPhase(mapId: string): MapRunPhase {
    return phaseByMapId.value[mapId] ?? 'idle'
  }

  function runSetPhase(mapId: string, phase: MapRunPhase) {
    phaseByMapId.value = { ...phaseByMapId.value, [mapId]: phase }
  }

  function runUntrackMap(mapId: string) {
    if (!(mapId in phaseByMapId.value)) return
    const next = { ...phaseByMapId.value }
    delete next[mapId]
    phaseByMapId.value = next
  }

  async function runSyncPhase(mapId: string) {
    const result = await window.electronAPI.mapper.read({
      type: 'map.snapshot',
      mapId,
    })
    const phase = result.type === 'map.snapshot'
      ? result.snapshot?.runPhase ?? 'idle'
      : 'idle'
    runSetPhase(mapId, phase)
    return phase
  }

  return {
    phaseByMapId,
    runReadPhase,
    runSetPhase,
    runUntrackMap,
    runSyncPhase,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRunCoordinatorStore, import.meta.hot))
}
