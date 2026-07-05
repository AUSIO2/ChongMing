import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type {
  ExecutionMode,
  MapNode,
  MapSnapshot,
  MapSubAgentParams,
  CatalogSubAgent,
  UpdateNodeParamsPatch,
} from '../flow-map'
import { NEWS_ROOT_ID, portReadApi } from '../flow-map'
import { errReadApp } from '../../electron/shared/errors'

/** Map 层 Pinia store（基于 MapAPI）。 */
export const useFlowMapStore = defineStore('flow-map', () => {
  const currentNewsId = ref<string | null>(null)
  const snapshot = shallowRef<MapSnapshot | null>(null)
  const selectedNodeId = ref<string | null>(null)
  const catalog = shallowRef<CatalogSubAgent[]>([])
  const catalogParent = ref<string | null>(null)
  const errorMessage = ref<string | null>(null)

  const selectedNode = computed<MapNode | null>(() => {
    const s = snapshot.value
    const id = selectedNodeId.value
    if (!s || !id) return null
    return s.nodes.find(n => n.id === id) ?? null
  })

  const runPhase = computed(() => snapshot.value?.runPhase ?? 'idle')
  const mode = computed(() => snapshot.value?.mode ?? 'human-in-loop')
  const isRunning = computed(() => runPhase.value === 'running')
  const isInterrupted = computed(() => runPhase.value === 'interrupted')

  /** 统一错误面：API 异常与快照内 error。 */
  const storeReadError = computed(
    () => snapshot.value?.error ?? errorMessage.value ?? null,
  )

  function resetSession() {
    selectedNodeId.value = null
    catalog.value = []
    catalogParent.value = null
    errorMessage.value = null
  }

  function detachNews() {
    const newsId = currentNewsId.value
    if (newsId) portReadApi().unloadNews(newsId)
    currentNewsId.value = null
    snapshot.value = null
    resetSession()
  }

  async function attachNews(newsId: string) {
    currentNewsId.value = newsId
    resetSession()
    await refresh()
  }

  async function refresh() {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await portReadApi().getSnapshot(newsId)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function selectNode(nodeId: string | null) {
    selectedNodeId.value = nodeId
  }

  async function loadCatalogFor(parentNodeId: string) {
    try {
      catalog.value = await portReadApi().getSubAgentCatalog(parentNodeId)
      catalogParent.value = parentNodeId
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function loadRootCatalog() {
    await loadCatalogFor(NEWS_ROOT_ID)
  }

  async function addSubAgent(
    parentNodeId: string,
    params: Omit<MapSubAgentParams, 'instanceId'> & { instanceId?: string },
  ) {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await portReadApi().addSubAgent({ newsId, parentNodeId, params })
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function updateNodeParams(nodeId: string, params: UpdateNodeParamsPatch) {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await portReadApi().updateNodeParams({ newsId, nodeId, params })
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function removeNode(nodeId: string) {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await portReadApi().removeNode({ newsId, nodeId })
      if (selectedNodeId.value === nodeId) selectedNodeId.value = null
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function startRun() {
    const newsId = currentNewsId.value
    if (!newsId) return
    if (snapshot.value) {
      snapshot.value = { ...snapshot.value, runPhase: 'running' }
    }
    try {
      const { snapshot: next } = await portReadApi().startRun(newsId, mode.value)
      snapshot.value = next
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      await refresh()
    }
  }

  let continueInFlight = false

  async function continueStep() {
    const newsId = currentNewsId.value
    if (!newsId || continueInFlight) return
    if (runPhase.value !== 'interrupted') return
    continueInFlight = true
    if (snapshot.value) {
      snapshot.value = {
        ...snapshot.value,
        runPhase: 'running',
        activeNodeId: undefined,
        pendingTool: undefined,
      }
    }
    try {
      snapshot.value = await portReadApi().continueStep(newsId)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      await refresh()
    } finally {
      continueInFlight = false
    }
  }

  async function cancelRun() {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await portReadApi().cancel(newsId)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function setMode(next: ExecutionMode) {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await portReadApi().setMode(newsId, next)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  return {
    currentNewsId,
    snapshot,
    selectedNodeId,
    selectedNode,
    catalog,
    catalogParent,
    errorMessage,
    storeReadError,
    runPhase,
    mode,
    isRunning,
    isInterrupted,
    resetSession,
    detachNews,
    attachNews,
    refresh,
    selectNode,
    loadCatalogFor,
    loadRootCatalog,
    addSubAgent,
    updateNodeParams,
    removeNode,
    startRun,
    continueStep,
    cancelRun,
    setMode,
  }
})
