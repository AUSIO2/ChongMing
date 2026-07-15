import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { layoutReadSnapshot } from '../flow-map'
import type { LayoutNavDir } from '../flow-map/layout-nav'
import type {
  ExecutionMode,
  MapNode,
  MapSnapshot,
  MapSubAgentParams,
  CatalogSubAgent,
  UpdateNodeParamsPatch,
  MapTimeline,
} from '../flow-map'
import { MAP_DEFAULT_NEWS_ID, portReadApi, layoutFindNeighbor } from '../flow-map'
import { errReadApp } from '../../electron/shared/errors'
import type { MapLeaseAcquireResult, MapLeaseInfo } from '../../electron/api/types'

export const useFlowMapStore = defineStore('flow-map', () => {
  const currentMapId = ref<string | null>(null)
  const snapshot = shallowRef<MapSnapshot | null>(null)
  const selectedNodeId = ref<string | null>(null)
  const catalog = shallowRef<CatalogSubAgent[]>([])
  const catalogParent = ref<string | null>(null)
  const errorMessage = ref<string | null>(null)
  const leaseWritable = ref(true)
  const leaseHint = ref<string | null>(null)
  const leaseInfo = shallowRef<MapLeaseInfo | null>(null)

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
    () => snapshot.value?.error ?? errorMessage.value ?? leaseHint.value ?? null,
  )

  function resetSession() {
    selectedNodeId.value = null
    catalog.value = []
    catalogParent.value = null
    errorMessage.value = null
  }

  function applyLeaseResult(result: MapLeaseAcquireResult) {
    leaseWritable.value = result.ok
    leaseInfo.value = result.lease
    if (result.ok) {
      leaseHint.value = null
      return
    }
    const expires = result.lease?.expiresAt
      ? new Date(result.lease.expiresAt).toLocaleTimeString()
      : null
    leaseHint.value = expires
      ? `地图为只读：正被其他客户端占用，预计 ${expires} 后可接管`
      : '地图为只读：无法获取写锁'
  }

  function clearLeaseState() {
    leaseWritable.value = true
    leaseHint.value = null
    leaseInfo.value = null
  }

  function assertLeaseWritable() {
    if (leaseWritable.value) return
    const msg = leaseHint.value ?? '地图为只读（未持有写锁）'
    errorMessage.value = msg
    throw new Error(msg)
  }

  function detachMap(options?: { unload?: boolean }) {
    const mapId = currentMapId.value
    if (mapId && options?.unload) portReadApi().unloadMap(mapId)
    currentMapId.value = null
    snapshot.value = null
    clearLeaseState()
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

  function selectLayoutNeighbor(dir: LayoutNavDir) {
    const s = snapshot.value
    if (!s) return
    const layout = layoutReadSnapshot(s)
    const nextId = layoutFindNeighbor(layout, selectedNodeId.value, dir)
    if (nextId) selectedNodeId.value = nextId
  }

  function runOrContinuePrimary() {
    if (!leaseWritable.value) {
      errorMessage.value = leaseHint.value ?? '地图为只读（未持有写锁）'
      return
    }
    if (runPhase.value === 'running') return
    if (runPhase.value === 'interrupted') {
      void continueStep()
      return
    }
    if (
      runPhase.value === 'idle'
      || runPhase.value === 'error'
      || runPhase.value === 'completed'
    ) {
      void runTimeline()
    }
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
    await loadCatalogFor(MAP_DEFAULT_NEWS_ID)
  }

  async function addSubAgent(
    parentNodeId: string,
    params: Omit<MapSubAgentParams, 'instanceId'> & { instanceId?: string },
  ) {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      assertLeaseWritable()
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
      assertLeaseWritable()
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
      assertLeaseWritable()
      snapshot.value = await portReadApi().removeNode({ mapId, nodeId })
      if (selectedNodeId.value === nodeId) selectedNodeId.value = null
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function runTimeline() {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      assertLeaseWritable()
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      return
    }
    if (snapshot.value) {
      snapshot.value = { ...snapshot.value, runPhase: 'running' }
    }
    try {
      const { snapshot: next } = await portReadApi().runTimeline(
        mapId,
        mode.value,
        selectedNodeId.value,
      )
      snapshot.value = next
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      await refresh()
    }
  }

  async function updateTimeline(patch: Partial<MapTimeline>) {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      assertLeaseWritable()
      snapshot.value = await portReadApi().updateTimeline(mapId, patch)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function startRun() {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      assertLeaseWritable()
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      return
    }
    if (snapshot.value) {
      snapshot.value = { ...snapshot.value, runPhase: 'running' }
    }
    try {
      const { snapshot: next } = await portReadApi().startRun(
        mapId,
        mode.value,
        selectedNodeId.value,
      )
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
    try {
      assertLeaseWritable()
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      return
    }
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
      assertLeaseWritable()
      snapshot.value = await portReadApi().setMode(mapId, next)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function startParse(sourceId?: string) {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      assertLeaseWritable()
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
      return
    }
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

  async function addSourceChain(uri: string, label?: string, forMapId?: string) {
    const mapId = forMapId ?? currentMapId.value
    if (!mapId) return
    if (currentMapId.value !== mapId) await attachMap(mapId)
    try {
      assertLeaseWritable()
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

  async function addRootNews(forMapId?: string) {
    const mapId = forMapId ?? currentMapId.value
    if (!mapId) return
    if (currentMapId.value !== mapId) await attachMap(mapId)
    try {
      assertLeaseWritable()
      snapshot.value = await portReadApi().addRootNews(mapId)
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function addRootClaim(forMapId?: string) {
    const mapId = forMapId ?? currentMapId.value
    if (!mapId) return
    if (currentMapId.value !== mapId) await attachMap(mapId)
    try {
      assertLeaseWritable()
      snapshot.value = await portReadApi().addRootClaim(mapId)
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
    leaseWritable,
    leaseHint,
    leaseInfo,
    storeReadError,
    runPhase,
    mode,
    isRunning,
    isInterrupted,
    resetSession,
    applyLeaseResult,
    clearLeaseState,
    detachMap,
    attachMap,
    refresh,
    selectNode,
    selectLayoutNeighbor,
    runOrContinuePrimary,
    loadCatalogFor,
    loadRootCatalog,
    addSubAgent,
    updateNodeParams,
    removeNode,
    runTimeline,
    updateTimeline,
    startRun,
    startParse,
    addSourceChain,
    addRootNews,
    addRootClaim,
    continueStep,
    cancelRun,
    setMode,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useFlowMapStore, import.meta.hot))
}
