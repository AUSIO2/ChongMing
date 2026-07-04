import { computed, onBeforeUnmount, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { getMapAPI, isMapAPIInstalled, layoutMapSnapshot } from '../flow-map'
import { useFlowMapStore } from '../stores/flow-map'

/**
 * 组合式：绑定当前新闻到 Map 层 store，并订阅 Port 的 onUpdated。
 * 不订阅具体后端事件，只走 MapAPI.onUpdated。
 */
export function useFlowMap(newsIdRef: () => string | null) {
  const store = useFlowMapStore()
  const {
    snapshot,
    selectedNodeId,
    selectedNode,
    catalog,
    catalogParent,
    errorMessage,
    runPhase,
    mode,
    isRunning,
    isInterrupted,
  } = storeToRefs(store)

  const layout = computed(() =>
    snapshot.value ? layoutMapSnapshot(snapshot.value) : null,
  )

  let unsub: (() => void) | null = null

  watch(
    () => newsIdRef(),
    async (newsId) => {
      if (!newsId) return
      if (!isMapAPIInstalled()) return
      await store.attachNews(newsId)
      unsub?.()
      unsub = getMapAPI().onUpdated((id: string) => {
        if (id === newsId) void store.refresh()
      })
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    unsub?.()
    unsub = null
  })

  return {
    store,
    snapshot,
    selectedNodeId,
    selectedNode,
    catalog,
    catalogParent,
    errorMessage,
    runPhase,
    mode,
    isRunning,
    isInterrupted,
    layout,
  }
}
