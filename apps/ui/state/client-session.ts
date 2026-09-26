import { RuntimeMessage } from '../../../contracts/messages'
import type { GraphActivity } from '../../../contracts/activity'
import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { ClientError, type ClientGateway, type CommandInputMap, type CommandOutputMap } from '../../../contracts/client'
import type { AppBootstrap, Preferences, WorkspaceSummary, WorkspaceView } from '../../../contracts/control'
import type { GraphMapSummary, GraphNodeData, GraphSnapshot, GraphSuccess, GraphCommand } from '../../../contracts/graph'
import { api } from '../transport/client-gateway'

interface SessionProblem { message: string; code: string; status: number; retryable: boolean; errorId: string }
// 用途：读取客户端会话，并把结构化结果交给调用方。
function sessionReadProblem(error: unknown): SessionProblem {
  const details = error as Partial<SessionProblem> | null
  const code = typeof details?.code === 'string' ? details.code : 'CLIENT_ERROR'
  const messages: Record<string, string> = {
    UNAUTHORIZED: RuntimeMessage.SESSION_UNAUTHORIZED,
    FORBIDDEN: RuntimeMessage.SESSION_FORBIDDEN,
    REVISION_CONFLICT: RuntimeMessage.SESSION_REVISION_CONFLICT,
    CONFIGURATION_NOT_INITIALIZED: RuntimeMessage.SESSION_CONFIGURATION_NOT_INITIALIZED,
    CONFIGURATION_INCOMPLETE: RuntimeMessage.SESSION_CONFIGURATION_INCOMPLETE,
  }
  return { code, message: messages[code] ?? (error instanceof ClientError ? error.message : RuntimeMessage.SESSION_OPERATION_FAILED_WITH_ERROR_ID),
    status: typeof details?.status === 'number' ? details.status : 0, retryable: details?.retryable === true,
    errorId: typeof details?.errorId === 'string' ? details.errorId : crypto.randomUUID() }
}

/** One client session owns views and subscriptions, never remote execution. */
// 用途：创建客户端会话，供后续流程使用。
export function sessionCreateState(gateway: ClientGateway, reconnectMs = 1000) {
  const connection = shallowRef<Awaited<ReturnType<ClientGateway['getConnection']>> | null>(null)
  const bootstrap = shallowRef<AppBootstrap | null>(null)
  const workspaces = shallowRef<WorkspaceSummary[]>([])
  const workspace = shallowRef<WorkspaceView | null>(null)
  const mapList = shallowRef<GraphMapSummary[]>([])
  const openMapIds = ref<string[]>([])
  const activeMapId = ref<string | null>(null)
  const activities = shallowRef<GraphActivity[]>([])
  const snapshot = shallowRef<GraphSnapshot | null>(null)
  const selectedId = ref<string | null>(null)
  const initializing = ref(false), connecting = ref(false), loading = ref(false), busy = ref(false)
  const online = ref(false)
  const error = shallowRef<SessionProblem | null>(null)
  const streamError = ref('')
  const streamState = ref<'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'>('idle')
  const lastSync = ref<string | null>(null)
  const canRetry = ref(false)
  const canEdit = computed(() => !!workspace.value && workspace.value.role !== 'viewer' && online.value)
  const active = computed(() => ['running', 'waiting'].includes(snapshot.value?.run?.status ?? ''))
  const selectedNode = computed(() => snapshot.value?.nodes.find(node => node.id === selectedId.value) ?? null)
  let sessionEpoch = 0, viewEpoch = 0
  let mapRead = 0, workspaceRead = 0, workspaceListRead = 0, managementRead = 0, settingsRead = 0
  let sessionController = new AbortController()
  let viewController = new AbortController()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let preferenceTimer: ReturnType<typeof setTimeout> | undefined
  let preferencesRunning = false, preferencesDirty = false, preferencesBlocked = false
  let selections: Record<string, string | null> = {}
  let retryCommand: (() => Promise<unknown>) | null = null

  // 用途：处理界面相关工作，并把结果交给调用方。
  function stopView() {
    activities.value = []
    viewEpoch++
    viewController.abort()
    viewController = new AbortController()
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    streamState.value = 'idle'; streamError.value = ''
    retryCommand = null; canRetry.value = false
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function clearWorkspace() {
    stopView()
    clearTimeout(preferenceTimer)
    preferencesDirty = false; preferencesBlocked = false
    workspace.value = null; mapList.value = []; openMapIds.value = []
    activeMapId.value = null; snapshot.value = null; activities.value = []; selectedId.value = null
    loading.value = false
    selections = {}; streamError.value = ''; lastSync.value = null
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function clearSession() {
    sessionEpoch++
    sessionController.abort()
    sessionController = new AbortController()
    clearWorkspace()
    bootstrap.value = null; workspaces.value = []; online.value = false
    error.value = null
    busy.value = false; connecting.value = false; loading.value = false; initializing.value = false
    retryCommand = null; canRetry.value = false
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function disconnect() {
    clearSession()
    const scope = sessionEpoch
    error.value = null
    try {
      await gateway.disconnect()
      if (scope !== sessionEpoch) return
      const info = await gateway.getConnection()
      if (scope === sessionEpoch) connection.value = info
    } catch (cause) { if (scope === sessionEpoch) error.value = sessionReadProblem(cause) }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function handleFailure(cause: unknown, scope: number, view?: number) {
    if (scope !== sessionEpoch || (view !== undefined && view !== viewEpoch)) return
    const problem = sessionReadProblem(cause)
    if (problem.status === 401 || problem.code === 'UNAUTHORIZED') {
      const closing = disconnect()
      const ended = sessionEpoch
      await closing
      if (ended === sessionEpoch) error.value = problem
      return
    }
    error.value = problem
    if (problem.status === 403 || problem.status === 404) await refreshWorkspace()
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function applySnapshot(next: GraphSnapshot, epoch: number) {
    if (epoch !== viewEpoch) return
    if (next.mapId !== activeMapId.value || next.workspaceId !== workspace.value?.id) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_MAP)
    if (snapshot.value && next.revision < snapshot.value.revision) return
    if (!snapshot.value || next.revision > snapshot.value.revision) snapshot.value = next
    activities.value = activities.value.filter(item => item.runId === next.run?.id && !next.run.paused && next.run.status === 'running'
      && next.run.operations.some(operation => operation.id === item.operationId && operation.status === 'running'))
    mapList.value = mapList.value.map(item => item.id === next.mapId && item.revision <= next.revision ? {
      id: next.mapId, workspaceId: next.workspaceId, revision: next.revision, name: next.name, nodeCount: next.nodes.length,
      claimCount: next.nodes.filter(node => node.data.kind === 'claim').length, updatedAt: next.updatedAt,
    } : item)
    if (selectedId.value && !next.nodes.some(node => node.id === selectedId.value)) selectedId.value = null
    online.value = true; streamError.value = ''; lastSync.value = new Date().toISOString()
  }

  // 用途：处理界面相关工作，并把结果交给调用方。
  async function loadWorkspaces() {
    const scope = sessionEpoch, request = ++workspaceListRead
    const items: WorkspaceSummary[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    try {
      do {
        const page = await gateway.read('workspace.list', { limit: 200, ...(cursor ? { cursor } : {}) }, sessionController.signal)
        if (scope !== sessionEpoch || request !== workspaceListRead) return
        items.push(...page.items)
        cursor = page.nextCursor ?? undefined
        if (cursor && seen.has(cursor)) throw new Error(RuntimeMessage.WORKSPACE_PAGE_REPEATED)
        if (cursor) seen.add(cursor)
      } while (cursor)
      workspaces.value = items.map(item => {
        const listed = workspaces.value.find(current => current.id === item.id)
        const current = workspace.value?.id === item.id && workspace.value.revision > (listed?.revision ?? -1) ? workspace.value : listed
        return current && current.revision > item.revision ? current : item
      })
    } catch (cause) { if (scope === sessionEpoch && request === workspaceListRead) throw cause }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function refreshWorkspace() {
    const id = workspace.value?.id, scope = sessionEpoch, epoch = viewEpoch, request = ++workspaceRead
    if (!id) return
    try {
      const [next, maps] = await Promise.all([
        gateway.read('workspace.get', { workspaceId: id }, viewController.signal),
        gateway.read('map.list', { workspaceId: id }, viewController.signal),
      ])
      if (scope !== sessionEpoch || epoch !== viewEpoch || request !== workspaceRead || workspace.value?.id !== id) return
      const current = workspace.value
      const preferences = next.preferences.revision >= current.preferences.revision ? next.preferences : current.preferences
      workspace.value = { ...(next.revision >= current.revision ? next : current), preferences }
      mapList.value = maps.map(item => {
        const prior = mapList.value.find(current => current.id === item.id)
        return prior && prior.revision > item.revision ? prior : item
      })
      openMapIds.value = openMapIds.value.filter(mapId => maps.some(map => map.id === mapId))
      if (activeMapId.value && !maps.some(map => map.id === activeMapId.value)) {
        stopView(); activeMapId.value = null; snapshot.value = null; activities.value = []; selectedId.value = null
      }
      online.value = true
      if (streamState.value !== 'reconnecting' && streamState.value !== 'error') streamError.value = ''
    } catch (cause) {
      if (scope !== sessionEpoch || epoch !== viewEpoch || request !== workspaceRead) return
      const problem = sessionReadProblem(cause)
      if (problem.status === 404 || problem.status === 403) {
        clearWorkspace()
        error.value = { ...problem, message: RuntimeMessage.WORKSPACE_ACCESS_ENDED }
        try { await loadWorkspaces() } catch (failure) { await handleFailure(failure, scope) }
      } else if (problem.status === 401) await handleFailure(cause, scope)
      else { online.value = false; streamError.value = '读取工作区失败，请重试刷新。' }
    }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function refresh() {
    const id = activeMapId.value, scope = sessionEpoch, epoch = viewEpoch, request = ++mapRead
    if (!id || !workspace.value) return
    try {
      const next = await gateway.read('map.get', { mapId: id }, viewController.signal)
      if (request === mapRead) applySnapshot(next, epoch)
    }
    catch (cause) {
      if (scope !== sessionEpoch || epoch !== viewEpoch || request !== mapRead) return
      const problem = sessionReadProblem(cause)
      if (problem.status === 401) await handleFailure(cause, scope, epoch)
      else if (problem.status === 403 || problem.status === 404) {
        clearMapAccess()
        error.value = problem
        await refreshWorkspace()
      } else { online.value = false; error.value = problem; streamError.value = '读取数据图失败，请重试刷新。' }
    }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function refreshSettings() {
    const scope = sessionEpoch, request = ++settingsRead
    try {
      const next = await gateway.read('app.bootstrap', {}, sessionController.signal)
      if (scope !== sessionEpoch || request !== settingsRead) return
      const settings = bootstrap.value && bootstrap.value.settings.revision > next.settings.revision ? bootstrap.value.settings : next.settings
      bootstrap.value = { ...next, settings }
    } catch (cause) { if (request === settingsRead) await handleFailure(cause, scope) }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function refreshManagement() {
    const scope = sessionEpoch, request = ++managementRead
    try {
      await refreshSettings()
      if (scope !== sessionEpoch || request !== managementRead) return
      await loadWorkspaces()
      if (scope !== sessionEpoch || request !== managementRead) return
      await refreshWorkspace()
      if (scope === sessionEpoch && request === managementRead) await refresh()
    } catch (cause) { if (request === managementRead) await handleFailure(cause, scope) }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function clearMapAccess() {
    const id = activeMapId.value
    stopView()
    activeMapId.value = null; snapshot.value = null; activities.value = []; selectedId.value = null
    openMapIds.value = openMapIds.value.filter(item => item !== id)
    loading.value = false
  }
  // 用途：监听界面变化，并交给调用方处理。
  function startWatch() {
    const id = activeMapId.value, scope = sessionEpoch, epoch = viewEpoch
    if (!id) return
    const baseDelay = Math.max(100, Math.min(reconnectMs, 10_000))
    let delay = baseDelay
    const watch = async () => {
      if (scope !== sessionEpoch || epoch !== viewEpoch) return
      activities.value = []
      streamState.value = streamState.value === 'idle' ? 'connecting' : 'reconnecting'
      try {
        await gateway.watch(id, event => {
          if (scope !== sessionEpoch || epoch !== viewEpoch) return
          if (event.type === 'error') throw new ClientError(event.error)
          if (event.type === 'snapshot') {
            ++mapRead // A current stream baseline supersedes in-flight HTTP reads and their failures.
            applySnapshot(event.snapshot, epoch)
            online.value = true; streamError.value = ''; streamState.value = 'live'; delay = baseDelay
          } else if (event.type === 'activity') {
            activities.value = event.items.filter(item => item.mapId === id && item.runId === snapshot.value?.run?.id && !snapshot.value.run.paused && snapshot.value.run.status === 'running')
          } else if (event.scope === 'settings') void refreshSettings()
          else {
            void refreshWorkspace()
            void loadWorkspaces().catch(cause => {
              if (scope === sessionEpoch && epoch === viewEpoch) return handleFailure(cause, scope, epoch)
            })
          }
        }, viewController.signal)
      } catch (cause) {
        if (scope !== sessionEpoch || epoch !== viewEpoch) return
        activities.value = []
        const problem = sessionReadProblem(cause)
        if (problem.status === 401 || problem.code === 'UNAUTHORIZED') { await handleFailure(cause, scope, epoch); return }
        if (problem.status === 403 || problem.status === 404) {
          clearMapAccess(); error.value = problem
          await refreshWorkspace()
          return
        }
        if (!problem.retryable) {
          streamState.value = 'error'; streamError.value = problem.message; online.value = false
          return
        }
      }
      if (scope !== sessionEpoch || epoch !== viewEpoch) return
      streamState.value = 'reconnecting'; streamError.value = '实时连接中断，正在重新连接。'; online.value = false
      reconnectTimer = setTimeout(() => { void watch() }, delay)
      delay = Math.min(delay * 2, 10_000)
    }
    void watch()
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function persistPreferences() {
    if (preferencesRunning || preferencesBlocked || !workspace.value) return
    preferencesRunning = true
    const scope = sessionEpoch, workspaceId = workspace.value.id
    try {
      while (preferencesDirty && workspace.value?.id === workspaceId && scope === sessionEpoch) {
        preferencesDirty = false
        const result: GraphSuccess<Preferences> = await gateway.dispatch(crypto.randomUUID(), 'preferences.set', {
          workspaceId, expectedRevision: workspace.value.preferences.revision,
          openMapIds: [...openMapIds.value], currentMapId: activeMapId.value,
          nodeSelection: Object.fromEntries(openMapIds.value.map(id => [id, selections[id] ?? null])),
        }, sessionController.signal)
        if (workspace.value?.id !== workspaceId || scope !== sessionEpoch) return
        if (result.data.revision >= workspace.value.preferences.revision) workspace.value = { ...workspace.value, preferences: result.data }
      }
    } catch (cause) {
      if (scope === sessionEpoch && workspace.value?.id === workspaceId) {
        preferencesBlocked = true
        await handleFailure(cause, scope)
      }
    } finally {
      preferencesRunning = false
      if (preferencesDirty && !preferencesBlocked && workspace.value) queuePreferences()
    }
  }
  // 用途：处理队列消息相关工作，并把结果交给调用方。
  function queuePreferences() {
    preferencesDirty = true
    clearTimeout(preferenceTimer)
    preferenceTimer = setTimeout(() => { void persistPreferences() }, 250)
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function selectNode(id: string | null) {
    selectedId.value = id && snapshot.value?.nodes.some(node => node.id === id) ? id : null
    if (activeMapId.value) selections[activeMapId.value] = selectedId.value
    queuePreferences()
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function openMap(id: string, persist = true) {
    if (!workspace.value || !mapList.value.some(map => map.id === id)) return
    stopView()
    const epoch = viewEpoch
    activeMapId.value = id; snapshot.value = null; activities.value = []; selectedId.value = selections[id] ?? null
    if (!openMapIds.value.includes(id)) openMapIds.value.push(id)
    error.value = null; loading.value = true; retryCommand = null; canRetry.value = false
    await refresh()
    if (epoch !== viewEpoch) return
    loading.value = false
    startWatch()
    if (persist) queuePreferences()
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function closeMap(id: string) {
    openMapIds.value = openMapIds.value.filter(mapId => mapId !== id)
    delete selections[id]
    if (activeMapId.value === id) {
      stopView(); activeMapId.value = null; snapshot.value = null; activities.value = []; selectedId.value = null
      loading.value = false
      const next = openMapIds.value[openMapIds.value.length - 1]
      if (next) await openMap(next, false)
    }
    queuePreferences()
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function selectWorkspace(id: string) {
    clearWorkspace()
    const scope = sessionEpoch, epoch = viewEpoch
    loading.value = true; error.value = null
    try {
      const [next, maps] = await Promise.all([
        gateway.read('workspace.get', { workspaceId: id }, viewController.signal),
        gateway.read('map.list', { workspaceId: id }, viewController.signal),
      ])
      if (scope !== sessionEpoch || epoch !== viewEpoch) return
      if (next.id !== id || maps.some(map => map.workspaceId !== id)) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_WORKSPACE)
      workspace.value = next; mapList.value = maps; online.value = true
      openMapIds.value = next.preferences.openMapIds.filter(mapId => maps.some(map => map.id === mapId))
      selections = { ...next.preferences.nodeSelection }
      const current = next.preferences.currentMapId
      if (current && openMapIds.value.includes(current)) await openMap(current, false)
    } catch (cause) { await handleFailure(cause, scope, epoch) }
    finally { if (scope === sessionEpoch && epoch === viewEpoch) loading.value = false }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function attachSession(value: AppBootstrap, scope: number) {
    if (scope !== sessionEpoch) return
    bootstrap.value = value; online.value = true
    await loadWorkspaces()
    if (scope === sessionEpoch && workspaces.value[0]) await selectWorkspace(workspaces.value[0].id)
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function initialize() {
    clearSession()
    const scope = sessionEpoch
    initializing.value = true
    try {
      const info = await gateway.getConnection()
      if (scope !== sessionEpoch) return
      connection.value = info
      if (info.configured) await attachSession(await gateway.read('app.bootstrap', {}, sessionController.signal), scope)
    } catch (cause) { await handleFailure(cause, scope) }
    finally { if (scope === sessionEpoch) initializing.value = false }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function connect(input: Parameters<ClientGateway['connect']>[0]) { return connectSession(() => gateway.connect(input)) }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function connectLocal() {
    if (!gateway.connectLocal) return
    return connectSession(() => gateway.connectLocal!())
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function connectSession(connect: () => Promise<AppBootstrap>) {
    clearSession()
    const scope = sessionEpoch
    connecting.value = true; error.value = null
    try {
      const value = await connect()
      if (scope !== sessionEpoch) return
      const info = await gateway.getConnection()
      if (scope !== sessionEpoch) return
      connection.value = info
      await attachSession(value, scope)
    } catch (cause) { await handleFailure(cause, scope) }
    finally { if (scope === sessionEpoch) connecting.value = false }
  }

  // 用途：处理界面相关工作，并把结果交给调用方。
  async function submit<K extends keyof CommandInputMap>(method: K, params: CommandInputMap[K], requestId = crypto.randomUUID()): Promise<GraphSuccess<CommandOutputMap[K]> | null> {
    if (busy.value) return null
    const payload = JSON.parse(JSON.stringify(params)) as CommandInputMap[K]
    const scope = sessionEpoch, epoch = viewEpoch
    busy.value = true; error.value = null; canRetry.value = false; retryCommand = null
    try {
      const result = await gateway.dispatch(requestId, method, payload, sessionController.signal)
      if (scope !== sessionEpoch || epoch !== viewEpoch) return null
      return result
    } catch (cause) {
      if (scope === sessionEpoch && epoch === viewEpoch) {
        const problem = sessionReadProblem(cause)
        if (problem.retryable) {
          canRetry.value = true
          retryCommand = async () => {
            if (scope !== sessionEpoch || epoch !== viewEpoch) return null
            const result = await submit(method, payload, requestId)
            if (result) {
              const reply = result.data as unknown
              if (method === 'workspace.create') {
                await loadWorkspaces()
                if (scope === sessionEpoch && epoch === viewEpoch) await selectWorkspace((reply as WorkspaceView).id)
              } else {
                await refresh(); await refreshWorkspace()
                if (scope === sessionEpoch && epoch === viewEpoch && method === 'map.create') {
                  await openMap((reply as { snapshot: GraphSnapshot }).snapshot.mapId)
                }
              }
            }
            return result
          }
        }
        await handleFailure(cause, scope, epoch)
        if (scope === sessionEpoch && epoch === viewEpoch && problem.status === 409) { await refresh(); await refreshWorkspace() }
      }
      return null
    } finally { if (scope === sessionEpoch) busy.value = false }
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function retry(): Promise<boolean> { return retryCommand ? !!await retryCommand() : false }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function createWorkspace(name: string, description = '') {
    const epoch = viewEpoch, scope = sessionEpoch
    const result = await submit('workspace.create', { id: crypto.randomUUID(), name, description, agentSource: 'library' })
    if (!result) return false
    await loadWorkspaces()
    if (scope !== sessionEpoch || epoch !== viewEpoch) return true
    await selectWorkspace(result.data.id)
    return true
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function createMap(name: string) {
    if (!workspace.value || !canEdit.value) return false
    const epoch = viewEpoch
    const result = await submit('map.create', { workspaceId: workspace.value.id, expectedRevision: workspace.value.revision, id: crypto.randomUUID(), name })
    if (!result) return false
    await refreshWorkspace()
    if (epoch !== viewEpoch) return true
    await openMap(result.data.snapshot.mapId)
    return true
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function applyChanges(expectedRevision: number, changes: Extract<GraphCommand, { method: 'graph.apply' }>['params']['changes']) {
    if (!snapshot.value || !canEdit.value || active.value) return false
    const result = await submit('graph.apply', { mapId: snapshot.value.mapId, expectedRevision, changes })
    if (!result) return false
    applySnapshot(result.data.snapshot, viewEpoch)
    await refreshWorkspace()
    return true
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function createNode(kind: 'claim' | 'news', content: string, category: string | null = null) {
    if (!snapshot.value) return false
    const epoch = viewEpoch
    const id = crypto.randomUUID()
    const data: GraphNodeData = kind === 'claim' ? { kind, content, category } : { kind, content, context: {} }
    if (!await applyChanges(snapshot.value.revision, { nodes: { put: [{ id, data }] } })) return false
    if (epoch === viewEpoch) selectNode(id)
    return true
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function createSource(url: string, label: string) {
    if (!snapshot.value) return false
    const epoch = viewEpoch, id = crypto.randomUUID()
    if (!await applyChanges(snapshot.value.revision, { nodes: { put: [{ id, data: { kind: 'source', locator: { kind: 'url', url }, label: label.trim() || null } }] } })) return false
    if (epoch === viewEpoch) selectNode(id)
    return true
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function saveNode(input: { expectedRevision: number; nodeId: string; data: GraphNodeData }) {
    return applyChanges(input.expectedRevision, { nodes: { put: [{ id: input.nodeId, data: input.data }] } })
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function removeNode(input: { expectedRevision: number; nodeId: string }) {
    return applyChanges(input.expectedRevision, { nodes: { remove: [input.nodeId] } })
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function linkSources(input: { expectedRevision: number; claimId: string; newsIds: string[] }) {
    if (!snapshot.value) return false
    const edges = snapshot.value.edges.filter(edge => edge.kind === 'mentions' && edge.to === input.claimId)
    const put = input.newsIds.filter(id => !edges.some(edge => edge.from === id)).map(id => ({ id: crypto.randomUUID(), kind: 'mentions' as const, from: id, to: input.claimId }))
    const remove = edges.filter(edge => !input.newsIds.includes(edge.from)).map(edge => edge.id)
    if (!put.length && !remove.length) return true
    return applyChanges(input.expectedRevision, { edges: { put, remove } })
  }
  // 用途：执行界面流程，并返回执行结果。
  async function startRun(input: Pick<CommandInputMap['run.start'], 'scope' | 'until' | 'mode' | 'regenerate'>) {
    if (!snapshot.value || !canEdit.value || active.value) return
    const result = await submit('run.start', { mapId: snapshot.value.mapId, expectedRevision: snapshot.value.revision, id: crypto.randomUUID(), ...input })
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
    return !!result
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function updateReview(params: CommandInputMap['review.update']) {
    if (!canEdit.value) return
    const result = await submit('review.update', params)
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  async function answerReview(params: CommandInputMap['review.answer']) {
    if (!canEdit.value) return
    const result = await submit('review.answer', params)
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  // 用途：执行界面流程，并返回执行结果。
  async function cancelRun(params: CommandInputMap['run.cancel']) {
    if (!canEdit.value) return
    const result = await submit('run.cancel', params)
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  // 用途：执行界面流程，并返回执行结果。
  async function pauseRun(params: CommandInputMap['run.pause']) {
    if (!canEdit.value) return
    const result = await submit('run.pause', params)
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  // 用途：执行界面流程，并返回执行结果。
  async function resumeRun(params: CommandInputMap['run.resume']) {
    if (!canEdit.value) return
    const result = await submit('run.resume', params)
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  // 用途：处理界面相关工作，并把结果交给调用方。
  function dispose() { clearSession() }
  return {
    connection, bootstrap, workspaces, workspace, mapList, openMapIds, activeMapId, snapshot, activities, selectedId, selectedNode,
    initializing, connecting, loading, busy, online, error, streamError, streamState, lastSync, canRetry, canEdit, active,
    initialize, connect, connectLocal, disconnect, loadWorkspaces, selectWorkspace, createWorkspace, createMap,
    openMap, closeMap, selectNode, refresh, refreshWorkspace, refreshManagement, retry, createNode, createSource, saveNode, removeNode, linkSources,
    startRun, updateReview, answerReview, cancelRun, pauseRun, resumeRun, dispose,
    // 用途：处理界面相关工作，并把结果交给调用方。
    clearError() { error.value = null; canRetry.value = false; retryCommand = null },
  }
}

export const useClientStore = defineStore('client-workspace', () => sessionCreateState(api))
