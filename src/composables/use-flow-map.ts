import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { layoutReadSnapshot } from '../flow-map'
import { useFlowMapStore } from '../stores/flow-map'

export function useFlowMap(mapIdRef: () => string | null) {
  const store = useFlowMapStore()
  const { snapshot, selectedNodeId } = storeToRefs(store)

  const layout = computed(() =>
    snapshot.value ? layoutReadSnapshot(snapshot.value) : null,
  )

  watch(
    () => mapIdRef(),
    async (mapId) => {
      if (!mapId) {
        store.detachMap()
        return
      }
      await store.attachMap(mapId)
    },
    { immediate: true },
  )

  return {
    store,
    snapshot,
    selectedNodeId,
    layout,
  }
}
