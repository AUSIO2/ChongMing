import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { ClientGateway, CommandInputMap, CommandOutputMap } from '../../contracts/client'
import type { AppBootstrap, Preferences, WorkspaceSummary, WorkspaceView } from '../../contracts/control'
import type { GraphMapSummary, GraphNodeData, GraphSnapshot, GraphSuccess, GraphCommand } from '../../contracts/graph'
import { api } from '../api'

interface SessionProblem { message: string; code: string; status: number; retryable: boolean }
function sessionReadProblem(error: unknown): SessionProblem {
  const details = error as Partial<SessionProblem> | null
  const code = typeof details?.code === 'string' ? details.code : 'CLIENT_ERROR'
  const messages: Record<string, string> = {
    UNAUTHORIZED: '登录已失效，请重新输入用户令牌。',
    FORBIDDEN: '你当前没有执行此操作的权限。',
    REVISION_CONFLICT: '数据已被更新。已刷新服务器版本，你的编辑草稿仍保留。',
    CONFIGURATION_NOT_INITIALIZED: '服务尚未初始化，请联系管理员。',
    CONFIGURATION_INCOMPLETE: '工作区缺少可用的核查配置，请先配置路由、核查与汇总 Agent。',
  }
  return { code, message: messages[code] ?? (error instanceof Error ? error.message : '操作失败，请重试。'),
    status: typeof details?.status === 'number' ? details.status : 0, retryable: details?.retryable === true }
}

/** One client session owns views and polling, never remote execution. */
export function sessionCreateState(gateway: ClientGateway, pollMs = 1000) {
  const connection = shallowRef<Awaited<ReturnType<ClientGateway['getConnection']>> | null>(null)
  const bootstrap = shallowRef<AppBootstrap | null>(null)
  const workspaces = shallowRef<WorkspaceSummary[]>([])
  const workspace = shallowRef<WorkspaceView | null>(null)
  const mapList = shallowRef<GraphMapSummary[]>([])
  const openMapIds = ref<string[]>([])
  const activeMapId = ref<string | null>(null)
  const snapshot = shallowRef<GraphSnapshot | null>(null)
  const selectedId = ref<string | null>(null)
  const initializing = ref(false), connecting = ref(false), loading = ref(false), busy = ref(false)
  const online = ref(false)
  const error = shallowRef<SessionProblem | null>(null)
  const pollError = ref('')
  const lastSync = ref<string | null>(null)
  const canRetry = ref(false)
  const canEdit = computed(() => !!workspace.value && workspace.value.role !== 'viewer' && online.value)
  const active = computed(() => ['running', 'waiting'].includes(snapshot.value?.run?.status ?? ''))
  const selectedNode = computed(() => snapshot.value?.nodes.find(node => node.id === selectedId.value) ?? null)
  let sessionEpoch = 0, viewEpoch = 0
  let sessionController = new AbortController()
  let viewController = new AbortController()
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let preferenceTimer: ReturnType<typeof setTimeout> | undefined
  let preferencesRunning = false, preferencesDirty = false, preferencesBlocked = false
  let selections: Record<string, string | null> = {}
  let retryCommand: (() => Promise<unknown>) | null = null

  function stopView() {
    viewEpoch++
    viewController.abort()
    viewController = new AbortController()
    clearTimeout(pollTimer)
    pollTimer = undefined
    retryCommand = null; canRetry.value = false
  }
  function clearWorkspace() {
    stopView()
    clearTimeout(preferenceTimer)
    preferencesDirty = false; preferencesBlocked = false
    workspace.value = null; mapList.value = []; openMapIds.value = []
    activeMapId.value = null; snapshot.value = null; selectedId.value = null
    loading.value = false
    selections = {}; pollError.value = ''; lastSync.value = null
  }
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
  async function disconnect() {
    clearSession()
    const scope = sessionEpoch
    error.value = null
    try { await gateway.disconnect() }
    catch (cause) { if (scope === sessionEpoch) error.value = sessionReadProblem(cause) }
    if (scope !== sessionEpoch) return
    const info = await gateway.getConnection()
    if (scope === sessionEpoch) connection.value = info
  }
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
  function applySnapshot(next: GraphSnapshot, epoch: number) {
    if (epoch !== viewEpoch) return
    if (next.mapId !== activeMapId.value || next.workspaceId !== workspace.value?.id) throw new Error('服务返回了其他数据图的内容。')
    if (snapshot.value && next.revision < snapshot.value.revision) return
    if (!snapshot.value || next.revision > snapshot.value.revision) snapshot.value = next
    if (selectedId.value && !next.nodes.some(node => node.id === selectedId.value)) selectedId.value = null
    online.value = true; pollError.value = ''; lastSync.value = new Date().toISOString()
  }

  async function loadWorkspaces() {
    const scope = sessionEpoch
    const items: WorkspaceSummary[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await gateway.read('workspace.list', { limit: 200, ...(cursor ? { cursor } : {}) }, sessionController.signal)
      if (scope !== sessionEpoch) return
      items.push(...page.items)
      cursor = page.nextCursor ?? undefined
      if (cursor && seen.has(cursor)) throw new Error('工作区分页响应重复。')
      if (cursor) seen.add(cursor)
    } while (cursor)
    workspaces.value = items
  }
  async function refreshWorkspace() {
    const id = workspace.value?.id, scope = sessionEpoch, epoch = viewEpoch
    if (!id) return
    try {
      const [next, maps] = await Promise.all([
        gateway.read('workspace.get', { workspaceId: id }, viewController.signal),
        gateway.read('map.list', { workspaceId: id }, viewController.signal),
      ])
      if (scope !== sessionEpoch || epoch !== viewEpoch || workspace.value?.id !== id) return
      workspace.value = next; mapList.value = maps
      openMapIds.value = openMapIds.value.filter(mapId => maps.some(map => map.id === mapId))
      if (activeMapId.value && !maps.some(map => map.id === activeMapId.value)) {
        stopView(); activeMapId.value = null; snapshot.value = null; selectedId.value = null
      }
    } catch (cause) {
      if (scope !== sessionEpoch || epoch !== viewEpoch) return
      const problem = sessionReadProblem(cause)
      if (problem.status === 404 || problem.status === 403) {
        clearWorkspace()
        error.value = { ...problem, message: '该工作区已不可访问，请重新选择。' }
        try { await loadWorkspaces() } catch (failure) { await handleFailure(failure, scope) }
      } else if (problem.status === 401) await handleFailure(cause, scope)
      else { online.value = false; pollError.value = '连接暂时中断，正在重试。' }
    }
  }
  async function refresh() {
    const id = activeMapId.value, scope = sessionEpoch, epoch = viewEpoch
    if (!id || !workspace.value) return
    try { applySnapshot(await gateway.read('map.get', { mapId: id }, viewController.signal), epoch) }
    catch (cause) {
      if (scope !== sessionEpoch || epoch !== viewEpoch) return
      const problem = sessionReadProblem(cause)
      if (problem.status === 401) await handleFailure(cause, scope, epoch)
      else if (problem.status === 403 || problem.status === 404) {
        snapshot.value = null; selectedId.value = null
        await refreshWorkspace()
      } else { online.value = false; pollError.value = '连接暂时中断，正在重试。' }
    }
  }
  function startPolling() {
    const epoch = viewEpoch
    let ticks = 0
    const tick = async () => {
      if (epoch !== viewEpoch || !activeMapId.value) return
      await refresh()
      if (++ticks % 5 === 0 && epoch === viewEpoch) await refreshWorkspace()
      if (epoch === viewEpoch && activeMapId.value) pollTimer = setTimeout(() => { void tick() }, pollMs)
    }
    // ponytail: bounded snapshot polling until the product SSE stream is implemented.
    pollTimer = setTimeout(() => { void tick() }, pollMs)
  }
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
        workspace.value = { ...workspace.value, preferences: result.data }
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
  function queuePreferences() {
    preferencesDirty = true
    clearTimeout(preferenceTimer)
    preferenceTimer = setTimeout(() => { void persistPreferences() }, 250)
  }
  function selectNode(id: string | null) {
    selectedId.value = id && snapshot.value?.nodes.some(node => node.id === id) ? id : null
    if (activeMapId.value) selections[activeMapId.value] = selectedId.value
    queuePreferences()
  }
  async function openMap(id: string, persist = true) {
    if (!workspace.value || !mapList.value.some(map => map.id === id)) return
    stopView()
    const epoch = viewEpoch
    activeMapId.value = id; snapshot.value = null; selectedId.value = selections[id] ?? null
    if (!openMapIds.value.includes(id)) openMapIds.value.push(id)
    error.value = null; loading.value = true; retryCommand = null; canRetry.value = false
    await refresh()
    if (epoch !== viewEpoch) return
    loading.value = false
    startPolling()
    if (persist) queuePreferences()
  }
  async function closeMap(id: string) {
    openMapIds.value = openMapIds.value.filter(mapId => mapId !== id)
    delete selections[id]
    if (activeMapId.value === id) {
      stopView(); activeMapId.value = null; snapshot.value = null; selectedId.value = null
      loading.value = false
      const next = openMapIds.value[openMapIds.value.length - 1]
      if (next) await openMap(next, false)
    }
    queuePreferences()
  }
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
      if (next.id !== id || maps.some(map => map.workspaceId !== id)) throw new Error('服务返回了其他工作区的内容。')
      workspace.value = next; mapList.value = maps; online.value = true
      openMapIds.value = next.preferences.openMapIds.filter(mapId => maps.some(map => map.id === mapId))
      selections = { ...next.preferences.nodeSelection }
      const current = next.preferences.currentMapId
      if (current && openMapIds.value.includes(current)) await openMap(current, false)
    } catch (cause) { await handleFailure(cause, scope, epoch) }
    finally { if (scope === sessionEpoch && epoch === viewEpoch) loading.value = false }
  }
  async function attachSession(value: AppBootstrap, scope: number) {
    if (scope !== sessionEpoch) return
    bootstrap.value = value; online.value = true
    await loadWorkspaces()
    if (scope === sessionEpoch && workspaces.value[0]) await selectWorkspace(workspaces.value[0].id)
  }
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
  async function connect(input: Parameters<ClientGateway['connect']>[0]) {
    clearSession()
    const scope = sessionEpoch
    connecting.value = true; error.value = null
    try {
      const value = await gateway.connect(input)
      if (scope !== sessionEpoch) return
      const info = await gateway.getConnection()
      if (scope !== sessionEpoch) return
      connection.value = info
      await attachSession(value, scope)
    } catch (cause) { await handleFailure(cause, scope) }
    finally { if (scope === sessionEpoch) connecting.value = false }
  }

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
  async function retry(): Promise<boolean> { return retryCommand ? !!await retryCommand() : false }
  async function createWorkspace(name: string, description = '') {
    const epoch = viewEpoch, scope = sessionEpoch
    const result = await submit('workspace.create', { id: crypto.randomUUID(), name, description, agentSource: 'library' })
    if (!result) return false
    await loadWorkspaces()
    if (scope !== sessionEpoch || epoch !== viewEpoch) return true
    await selectWorkspace(result.data.id)
    return true
  }
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
  async function applyChanges(expectedRevision: number, changes: Extract<GraphCommand, { method: 'graph.apply' }>['params']['changes']) {
    if (!snapshot.value || !canEdit.value || active.value) return false
    const result = await submit('graph.apply', { mapId: snapshot.value.mapId, expectedRevision, changes })
    if (!result) return false
    applySnapshot(result.data.snapshot, viewEpoch)
    await refreshWorkspace()
    return true
  }
  async function createNode(kind: 'claim' | 'news', content: string, category: string | null = null) {
    if (!snapshot.value) return false
    const epoch = viewEpoch
    const id = crypto.randomUUID()
    const data: GraphNodeData = kind === 'claim' ? { kind, content, category } : { kind, content, context: {} }
    if (!await applyChanges(snapshot.value.revision, { nodes: { put: [{ id, data }] } })) return false
    if (epoch === viewEpoch) selectNode(id)
    return true
  }
  async function saveNode(input: { expectedRevision: number; nodeId: string; data: GraphNodeData }) {
    return applyChanges(input.expectedRevision, { nodes: { put: [{ id: input.nodeId, data: input.data }] } })
  }
  async function removeNode(input: { expectedRevision: number; nodeId: string }) {
    return applyChanges(input.expectedRevision, { nodes: { remove: [input.nodeId] } })
  }
  async function linkSources(input: { expectedRevision: number; claimId: string; newsIds: string[] }) {
    if (!snapshot.value) return false
    const edges = snapshot.value.edges.filter(edge => edge.kind === 'mentions' && edge.to === input.claimId)
    const put = input.newsIds.filter(id => !edges.some(edge => edge.from === id)).map(id => ({ id: crypto.randomUUID(), kind: 'mentions' as const, from: id, to: input.claimId }))
    const remove = edges.filter(edge => !input.newsIds.includes(edge.from)).map(edge => edge.id)
    if (!put.length && !remove.length) return true
    return applyChanges(input.expectedRevision, { edges: { put, remove } })
  }
  async function startRun(input: { targetId: string; mode: 'auto' | 'human-in-loop' }) {
    if (!snapshot.value || !canEdit.value || active.value) return
    const result = await submit('run.start', { mapId: snapshot.value.mapId, expectedRevision: snapshot.value.revision, id: crypto.randomUUID(), ...input })
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  async function updateReview(params: CommandInputMap['review.update']) {
    if (!canEdit.value) return
    const result = await submit('review.update', params)
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  async function answerReview(params: CommandInputMap['review.answer']) {
    if (!canEdit.value) return
    const result = await submit('review.answer', params)
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  async function cancelRun(params: CommandInputMap['run.cancel']) {
    if (!canEdit.value) return
    const result = await submit('run.cancel', params)
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  function dispose() { clearSession() }
  return {
    connection, bootstrap, workspaces, workspace, mapList, openMapIds, activeMapId, snapshot, selectedId, selectedNode,
    initializing, connecting, loading, busy, online, error, pollError, lastSync, canRetry, canEdit, active,
    initialize, connect, disconnect, loadWorkspaces, selectWorkspace, createWorkspace, createMap,
    openMap, closeMap, selectNode, refresh, refreshWorkspace, retry, createNode, saveNode, removeNode, linkSources,
    startRun, updateReview, answerReview, cancelRun, dispose,
    clearError() { error.value = null; canRetry.value = false; retryCommand = null },
  }
}

export const useClientStore = defineStore('client-workspace', () => sessionCreateState(api))
