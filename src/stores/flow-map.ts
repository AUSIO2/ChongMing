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

export const useFlowMapStore = defineStore('flow-map', () => {
  const currentMapId = ref<string | null>(null)
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

  const storeReadError = computed(
    () => snapshot.value?.error ?? errorMessage.value ?? null,
  )

  function resetSession() {
    selectedNodeId.value = null
    catalog.value = []
    catalogParent.value = null
    errorMessage.value = null
  }

  function detachMap() {
    const mapId = currentMapId.value
    if (mapId) portReadApi().unloadMap(mapId)
    currentMapId.value = null
    snapshot.value = null
    resetSession()
  }

  async function attachMap(mapId: string) {
    currentMapId.value = mapId
    resetSession()
    await refresh()
  }

  async function refresh() {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      snapshot.value = await portReadApi().getSnapshot(mapId)
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
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      snapshot.value = await portReadApi().addSubAgent({ mapId, parentNodeId, params })
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function updateNodeParams(nodeId: string, params: UpdateNodeParamsPatch) {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      snapshot.value = await portReadApi().updateNodeParams({ mapId, nodeId, params })
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function removeNode(nodeId: string) {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      snapshot.value = await portReadApi().removeNode({ mapId, nodeId })
      if (selectedNodeId.value === nodeId) selectedNodeId.value = null
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function startRun() {
    const mapId = currentMapId.value
    if (!mapId) return
    if (snapshot.value) {
      snapshot.value = { ...snapshot.value, runPhase: 'running' }
    }
    try {
      const { snapshot: next } = await portReadApi().startRun(mapId, mode.value)
      snapshot.value = next
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      await refresh()
    }
  }

  let continueInFlight = false

  async function continueStep() {
    const mapId = currentMapId.value
    if (!mapId || continueInFlight) return
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
      snapshot.value = await portReadApi().continueStep(mapId)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      await refresh()
    } finally {
      continueInFlight = false
    }
  }

  async function cancelRun() {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      snapshot.value = await portReadApi().cancel(mapId)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function setMode(next: ExecutionMode) {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      snapshot.value = await portReadApi().setMode(mapId, next)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function startParse(sourceId?: string) {
    const mapId = currentMapId.value
    if (!mapId) return
    if (snapshot.value) {
      snapshot.value = { ...snapshot.value, runPhase: 'running' }
    }
    try {
      const { snapshot: next } = await portReadApi().startParse(mapId, sourceId)
      snapshot.value = next
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      await refresh()
    }
  }

  async function addSourceChain(uri: string, label?: string) {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      snapshot.value = await portReadApi().addSourceChain(mapId, {
        uri,
        kind: 'file',
        label,
      })
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  return {
    currentMapId,
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
    detachMap,
    attachMap,
    refresh,
    selectNode,
    loadCatalogFor,
    loadRootCatalog,
    addSubAgent,
    updateNodeParams,
    removeNode,
    startRun,
    startParse,
    addSourceChain,
    continueStep,
    cancelRun,
    setMode,
  }
})
