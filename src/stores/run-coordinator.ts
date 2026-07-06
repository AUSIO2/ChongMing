import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref } from 'vue'
import type { MapRunPhase } from '../flow-map'
import { portReadApi } from '../flow-map'

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
    const snap = await portReadApi().getSnapshot(mapId)
    runSetPhase(mapId, snap.runPhase)
    return snap.runPhase
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
