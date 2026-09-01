import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { layoutReadSnapshot } from '../flow-map'
import type { LayoutNavDir } from '../flow-map/layout-nav'
import type {
  MapperNode as MapNode,
  MapperSnapshot as MapSnapshot,
  MapperTimeline as MapTimeline,
  MapperDispatchResult,
  MapperLeaseInfo,
  MapperLeaseResult,
  MapperNodePatch,
} from '../../electron/mapper/types'
import type {
  ExecutionMode,
  MapSubAgentParams,
} from '../../electron/shared/types'
import type { CatalogSubAgent } from '../../electron/api/types'
import { MAP_DEFAULT_NEWS_ID } from '../../electron/shared/map-ids'
import { layoutFindNeighbor } from '../flow-map'
import { errReadApp } from '../../electron/shared/errors'

export const useFlowMapStore = defineStore('flow-map', () => {
  const currentMapId = ref<string | null>(null)
  const snapshot = shallowRef<MapSnapshot | null>(null)
  const selectedNodeId = ref<string | null>(null)
  const catalog = shallowRef<CatalogSubAgent[]>([])
  const catalogParent = ref<string | null>(null)
  const errorMessage = ref<string | null>(null)
  const leaseWritable = ref(true)
  const leaseHint = ref<string | null>(null)
  const leaseInfo = shallowRef<MapperLeaseInfo | null>(null)

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

  function applyMapperResult(result: MapperDispatchResult) {
    if (result.type === 'map.updated') snapshot.value = result.snapshot
  }

  function resetSession() {
    selectedNodeId.value = null
    catalog.value = []
    catalogParent.value = null
    errorMessage.value = null
  }

  function applyLeaseResult(result: MapperLeaseResult) {
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

  function detachMap(_options?: { unload?: boolean }) {
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
      const result = await window.electronAPI.mapper.read({
        type: 'map.snapshot',
        mapId,
      })
      if (result.type === 'map.snapshot') snapshot.value = result.snapshot
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
    if (runPhase.value === 'interrupted' || runPhase.value === 'error') {
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
      const module = parentNodeId.startsWith('news:') ? 'split' : 'verify'
      const { useWorkspaceStore } = await import('./workspace')
      const workspaceId = useWorkspaceStore().currentWorkspaceId
      const workspace = workspaceId
        ? await window.electronAPI.workspace.get(workspaceId)
        : null
      catalog.value = workspace?.agents?.length
        ? workspace.agents
          .filter(agent => agent.agentType === module && agent.agentName)
          .map(agent => ({
            agentName: agent.agentName!,
            module,
            displayLabel: agent.displayLabel,
            defaultPriority: agent.defaultPriority,
            description: agent.description,
          }))
        : await window.electronAPI.catalog.list(module)
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'node.create',
        mapId,
        node: { kind: 'route', parentId: parentNodeId, ...params },
      }))
      errorMessage.value = null
    } catch (e) {
      errorMessage.value = errReadApp(e).msg
    }
  }

  async function updateNodeParams(
    nodeId: string,
    params: Partial<{ content: string; category: string; priority: MapSubAgentParams['priority']; hint: string }>,
  ) {
    const mapId = currentMapId.value
    if (!mapId) return
    try {
      assertLeaseWritable()
      const node = snapshot.value?.nodes.find(item => item.id === nodeId)
      if (!node || node.kind === 'parseAgent' || node.kind === 'opinion') return
      const patch: MapperNodePatch = node.kind === 'news'
        ? { kind: 'news', content: params.content }
        : node.kind === 'claim'
          ? {
              kind: 'claim',
              content: params.content,
              category: params.category,
            }
          : node.kind === 'subAgent'
            ? { kind: 'route', priority: params.priority, hint: params.hint }
            : { kind: 'source' }
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'node.update',
        mapId,
        nodeId,
        patch,
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'node.delete',
        mapId,
        nodeId,
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'run.start',
        mapId,
        mode: mode.value,
        selectedNodeId: selectedNodeId.value ?? undefined,
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'timeline.update',
        mapId,
        patch,
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'run.start',
        mapId,
        mode: mode.value,
        selectedNodeId: selectedNodeId.value ?? undefined,
      }))
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
    if (runPhase.value !== 'interrupted' && runPhase.value !== 'error') return
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'run.continue',
        mapId,
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'run.cancel',
        mapId,
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'run.set-mode',
        mapId,
        mode: next,
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'run.start',
        mapId,
        mode: mode.value,
        selectedNodeId: sourceId,
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'node.create',
        mapId,
        node: { kind: 'source', uri, sourceKind: 'file', label },
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'node.create',
        mapId,
        node: { kind: 'news', content: '' },
      }))
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
      applyMapperResult(await window.electronAPI.mapper.dispatch({
        type: 'node.create',
        mapId,
        node: { kind: 'claim', content: '' },
      }))
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
