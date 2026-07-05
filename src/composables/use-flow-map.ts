import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { layoutReadSnapshot } from '../flow-map'
import { useFlowMapStore } from '../stores/flow-map'

/**
 * 组合式：绑定当前新闻到 Map 层 store。
 * 后端推送订阅在 HomeView 层注册（onUpdated）。
 */
export function useFlowMap(newsIdRef: () => string | null) {
  const store = useFlowMapStore()
  const { snapshot, selectedNodeId } = storeToRefs(store)

  const layout = computed(() =>
    snapshot.value ? layoutReadSnapshot(snapshot.value) : null,
  )

  watch(
    () => newsIdRef(),
    async (newsId) => {
      if (!newsId) {
        store.detachNews()
        return
      }
      await store.attachNews(newsId)
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
