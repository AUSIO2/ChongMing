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
import { NEWS_ROOT_ID, getMapAPI } from '../flow-map'
import { toAppError } from '../../electron/shared/errors'

/**
 * Map 层 Pinia store。
 * 完全基于 MapAPI，不引用 legacy workspace store 或 flow-graph store。
 */
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

  async function attachNews(newsId: string) {
    currentNewsId.value = newsId
    await refresh()
  }

  async function refresh() {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await getMapAPI().getSnapshot(newsId)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = toAppError(e).msg
    }
  }

  async function selectNode(nodeId: string | null) {
    selectedNodeId.value = nodeId
    if (nodeId) await loadCatalogFor(nodeId)
  }

  async function loadCatalogFor(parentNodeId: string) {
    try {
      catalog.value = await getMapAPI().getSubAgentCatalog(parentNodeId)
      catalogParent.value = parentNodeId
    } catch (e) {
      errorMessage.value = toAppError(e).msg
    }
  }

  async function loadRootCatalog() {
    await loadCatalogFor(NEWS_ROOT_ID)
  }

  async function addSubAgent(parentNodeId: string, params: MapSubAgentParams) {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await getMapAPI().addSubAgent({ newsId, parentNodeId, params })
    } catch (e) {
      errorMessage.value = toAppError(e).msg
    }
  }

  async function updateNodeParams(nodeId: string, params: UpdateNodeParamsPatch) {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await getMapAPI().updateNodeParams({ newsId, nodeId, params })
    } catch (e) {
      errorMessage.value = toAppError(e).msg
    }
  }

  async function removeNode(nodeId: string) {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await getMapAPI().removeNode({ newsId, nodeId })
      if (selectedNodeId.value === nodeId) selectedNodeId.value = null
    } catch (e) {
      errorMessage.value = toAppError(e).msg
    }
  }

  async function startRun() {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      const { snapshot: next } = await getMapAPI().startRun(newsId, mode.value)
      snapshot.value = next
    } catch (e) {
      errorMessage.value = toAppError(e).msg
    }
  }

  let continueInFlight = false

  async function continueStep() {
    const newsId = currentNewsId.value
    if (!newsId || continueInFlight) return
    if (runPhase.value !== 'interrupted') return
    continueInFlight = true
    try {
      snapshot.value = await getMapAPI().continueStep(newsId)
    } catch (e) {
      errorMessage.value = toAppError(e).msg
    } finally {
      continueInFlight = false
    }
  }

  async function cancelRun() {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await getMapAPI().cancel(newsId)
    } catch (e) {
      errorMessage.value = toAppError(e).msg
    }
  }

  async function setMode(next: ExecutionMode) {
    const newsId = currentNewsId.value
    if (!newsId) return
    try {
      snapshot.value = await getMapAPI().setMode(newsId, next)
    } catch (e) {
      errorMessage.value = toAppError(e).msg
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
    runPhase,
    mode,
    isRunning,
    isInterrupted,
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
