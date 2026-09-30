// 客户端会话状态：管理工作区和图视图、实时订阅、偏好保存及命令重试。
import { RuntimeMessage } from '../../../contracts/messages'
import type { GraphActivity } from '../../../contracts/activity'
import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { ClientError, type ClientGateway, type CommandInputMap, type CommandOutputMap } from '../../../contracts/client'
import type { AppBootstrap, DefinitionView, Preferences, WorkspaceSummary, WorkspaceView } from '../../../contracts/control'
import type { DataTypeDefinition } from '../../../contracts/data-definition'
import type { GraphBranchGrant, GraphBranchLeaseProof, GraphBranchProof, GraphBranchSnapshot, GraphMapSummary, GraphPayload, GraphRunControlGrant, GraphRunControlProof, GraphSnapshot, GraphSuccess, GraphCommand } from '../../../contracts/graph'
import { api } from '../transport/client-gateway'

interface SessionProblem { message: string; code: string; status: number; retryable: boolean; errorId: string }
/**
 * 将异常转换为界面可展示的问题，统一已知错误文案并为缺失的诊断编号生成标识。
 *
 * @param error 任意来源的异常；只信任经类型检查的结构化字段，未知异常使用统一展示文案。
 */
function sessionReadProblem(error: unknown): SessionProblem {
  const details = error as Partial<SessionProblem> | null
  const code = typeof details?.code === 'string' ? details.code : 'CLIENT_ERROR'
  const messages: Record<string, string> = {
    UNAUTHORIZED: RuntimeMessage.SESSION_UNAUTHORIZED,
    FORBIDDEN: RuntimeMessage.SESSION_FORBIDDEN,
    REVISION_CONFLICT: RuntimeMessage.SESSION_REVISION_CONFLICT,
    BRANCH_VERSION_CONFLICT: RuntimeMessage.SESSION_REVISION_CONFLICT,
    CONFIGURATION_NOT_INITIALIZED: RuntimeMessage.SESSION_CONFIGURATION_NOT_INITIALIZED,
    CONFIGURATION_INCOMPLETE: RuntimeMessage.SESSION_CONFIGURATION_INCOMPLETE,
  }
  return { code, message: messages[code] ?? (error instanceof ClientError ? error.message : RuntimeMessage.SESSION_OPERATION_FAILED_WITH_ERROR_ID),
    status: typeof details?.status === 'number' ? details.status : 0, retryable: details?.retryable === true,
    errorId: typeof details?.errorId === 'string' ? details.errorId : crypto.randomUUID() }
}

/**
 * 创建并持有一个客户端会话的工作区、图视图、订阅与偏好状态，供界面发起操作和读取结果。
 *
 * @param gateway 调用者装配的传输网关，负责认证和协议校验；会话只持有其请求与订阅生命周期。
 * @param reconnectMs 初始重连等待毫秒数，默认 1000，实际限制在 100–10000 毫秒。
 */
export function sessionCreateState(
  gateway: ClientGateway,
  reconnectMs = 1000
) {
  const connection = shallowRef<Awaited<ReturnType<ClientGateway['getConnection']>> | null>(null)
  const bootstrap = shallowRef<AppBootstrap | null>(null)
  const workspaces = shallowRef<WorkspaceSummary[]>([])
  const workspace = shallowRef<WorkspaceView | null>(null)
  const definitions = shallowRef<DefinitionView | null>(null)
  const catalog = computed(() => definitions.value?.catalog ?? null)
  const mapList = shallowRef<GraphMapSummary[]>([])
  const openMapIds = ref<string[]>([])
  const activeMapId = ref<string | null>(null)
  const activities = shallowRef<GraphActivity[]>([])
  const snapshot = shallowRef<GraphSnapshot | null>(null)
  const selectedId = ref<string | null>(null)
  const selectedBranch = shallowRef<GraphBranchSnapshot | null>(null)
  const selectedBranchGrant = shallowRef<GraphBranchGrant | null>(null)
  const selectedRunControl = shallowRef<GraphRunControlGrant | null>(null)
  const selectedRunId = ref<string | null>(null)
  const branchLoading = ref(false)
  const initializing = ref(false), connecting = ref(false), loading = ref(false), busy = ref(false)
  const online = ref(false)
  const error = shallowRef<SessionProblem | null>(null)
  const streamError = ref('')
  const streamState = ref<'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'>('idle')
  const lastSync = ref<string | null>(null)
  const canRetry = ref(false)
  const canEdit = computed(() => /* 根据工作区角色和在线状态判断界面是否允许编辑。 */ !!workspace.value && workspace.value.role !== 'viewer' && online.value)
  const clientLeasesRequired = computed(() => bootstrap.value?.metadata.clientLeases !== 'none')
  const selectedRun = computed(() => snapshot.value?.runs.find(run => run.id === selectedRunId.value) ?? null)
  const active = computed(() =>
    /* 任一运行中或等待中的 Run 都表示该图仍有后台工作。 */
    snapshot.value?.runs.some(run => ['running', 'waiting'].includes(run.status)) === true)
  const selectedNode = computed(() =>
    /* 从当前图快照中解析选中节点，找不到时返回 null。 */
    snapshot.value?.nodes.find(node =>
      /* 匹配当前选中的节点标识。 */
      node.id === selectedId.value) ?? null)
  // 会话代次隔离登录身份，视图代次隔离工作区和图切换；即使底层未及时取消，迟到结果也会失效。
  let sessionEpoch = 0, viewEpoch = 0
  // 同一会话或视图内仍可能并发刷新，各类读取序号让后发请求取代先发请求。
  let mapRead = 0, branchRead = 0, workspaceRead = 0, workspaceListRead = 0, managementRead = 0, settingsRead = 0
  // 命令和偏好保存属于会话；图读取和订阅属于视图，切图不向服务端取消已经提交的运行。
  let sessionController = new AbortController()
  let viewController = new AbortController()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let branchRenewTimer: ReturnType<typeof setTimeout> | undefined
  let runControlRenewTimer: ReturnType<typeof setTimeout> | undefined
  const branchHolderId = crypto.randomUUID()
  let preferenceTimer: ReturnType<typeof setTimeout> | undefined
  let preferencesRunning = false, preferencesDirty = false, preferencesBlocked = false
  let selections: Record<string, string | null> = {}
  let retryCommand: (() => Promise<unknown>) | null = null
  const definitionCache = new Map<string, DefinitionView>()

  function stopView() {
    // 使旧视图失效，取消它的读取与订阅，清除重连定时器、执行活动和命令重试入口。
    activities.value = []
    void releaseBranch()
    void releaseRunControl()
    selectedBranch.value = null; selectedBranchGrant.value = null; selectedRunId.value = null; branchLoading.value = false; branchRead++
    viewEpoch++
    viewController.abort()
    viewController = new AbortController()
    clearTimeout(reconnectTimer)
    clearTimeout(branchRenewTimer)
    clearTimeout(runControlRenewTimer)
    reconnectTimer = undefined
    streamState.value = 'idle'; streamError.value = ''
    retryCommand = null; canRetry.value = false
  }
  function clearWorkspace() {
    // 关闭当前视图并清空工作区、标签页和选择记录，同时撤销尚未触发的偏好保存。
    stopView()
    clearTimeout(preferenceTimer)
    // 正在执行的偏好保存仍持有串行写入标记，等它结束后再接续新工作区的待保存改动。
    preferencesDirty = false; preferencesBlocked = false
    workspace.value = null; definitions.value = null; mapList.value = []; openMapIds.value = []
    activeMapId.value = null; snapshot.value = null; activities.value = []; selectedId.value = null; selectedBranch.value = null; selectedRunId.value = null
    loading.value = false
    selections = {}; streamError.value = ''; lastSync.value = null
  }
  function clearSession() {
    // 使旧会话及其请求失效，释放当前视图资源并清空登录后的界面状态。
    sessionEpoch++
    sessionController.abort()
    sessionController = new AbortController()
    clearWorkspace()
    bootstrap.value = null; workspaces.value = []; definitionCache.clear(); online.value = false
    error.value = null
    busy.value = false; connecting.value = false; loading.value = false; initializing.value = false
    retryCommand = null; canRetry.value = false
  }
  async function disconnect() {
    // 先清除本地会话，再让网关退出登录，并仅为当前会话更新连接信息。
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
  /**
   * 仅处理仍属当前会话和视图的错误；认证失效时退出登录，权限或资源缺失时刷新工作区。
   *
   * @param cause 异步读取或命令产生的异常，经过期检查后再转为界面问题。
   * @param scope 发起操作时捕获的会话代次，防止旧身份错误影响新登录。
   * @param view 可选的发起视图代次；提供时同时拒绝旧图或旧工作区错误。
   */
  async function handleFailure(
    cause: unknown,
    scope: number,
    view?: number
  ) {
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
  /**
   * 接纳当前视图中版本未倒退的图快照，同步图摘要、有效执行活动、节点选择和同步时间。
   *
   * @param next 网关返回的只读图快照，仍需核对图、工作区身份并拒绝版本倒退。
   * @param epoch 发起读取或订阅时捕获的视图代次，用于拒绝迟到快照。
   */
  function applySnapshot(
    next: GraphSnapshot,
    epoch: number
  ) {
    if (epoch !== viewEpoch) return
    if (next.mapId !== activeMapId.value || next.workspaceId !== workspace.value?.id) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_MAP)
    const currentOwnershipRevision = snapshot.value?.ownershipRevision ?? 0, nextOwnershipRevision = next.ownershipRevision ?? 0
    if (snapshot.value && (next.revision < snapshot.value.revision
      || next.revision === snapshot.value.revision && nextOwnershipRevision < currentOwnershipRevision)) return
    if (!snapshot.value || next.revision > snapshot.value.revision || nextOwnershipRevision > currentOwnershipRevision) snapshot.value = next
    if (!next.runs.some(run => run.id === selectedRunId.value)) {
      selectedRunId.value = next.runs.find(run => ['running', 'waiting'].includes(run.status))?.id ?? next.runs[next.runs.length - 1]?.id ?? null
    }
    if (selectedBranchGrant.value && !(next.ownerships ?? []).some(ownership => ownership.kind === 'editor'
      && ownership.leaseId === selectedBranchGrant.value!.leaseId && ownership.holderId === selectedBranchGrant.value!.holderId
      && ownership.fence === selectedBranchGrant.value!.fence)) {
      selectedBranchGrant.value = null; clearTimeout(branchRenewTimer)
    }
    if (selectedRunControl.value) {
      const control = next.runControls.find(item => item.leaseId === selectedRunControl.value!.leaseId
        && item.holderId === selectedRunControl.value!.holderId && item.fence === selectedRunControl.value!.fence)
      if (control) selectedRunControl.value = { ...control, ownershipRevision: next.ownershipRevision }
      else { selectedRunControl.value = null; clearTimeout(runControlRenewTimer) }
    }
    activities.value = activities.value.filter(item =>
      /* 仅保留当前未暂停运行中、且所属 Operation 仍在执行的活动。 */
      next.runs.some(run => item.runId === run.id && !run.paused && run.status === 'running'
        && run.operations.some(operation => /* 确认活动关联的 Operation 仍处于运行状态。 */ operation.id === item.operationId && operation.status === 'running')))
    mapList.value = mapList.value.map(item =>
      /* 用本次快照更新同一张图的旧摘要，其余图和较新摘要保持原值。 */
      item.id === next.mapId && item.revision <= next.revision ? {
      id: next.mapId, workspaceId: next.workspaceId, revision: next.revision, name: next.name, nodeCount: next.nodes.length,
      typeCounts: next.nodes.reduce<Record<string, number>>((counts, node) => {
        const key = `${node.typeId}@${node.typeVersion}`
        counts[key] = (counts[key] ?? 0) + 1
        return counts
      }, {}), updatedAt: next.updatedAt,
    } : item)
    if (selectedId.value && !next.nodes.some(node => /* 确认所选节点仍存在于新快照中。 */ node.id === selectedId.value)) {
      selectedId.value = null; selectedBranch.value = null; branchRead++
    }
    online.value = true; streamError.value = ''; lastSync.value = new Date().toISOString()
    if (selectedId.value) void refreshSelectedBranch()
  }

  async function refreshSelectedBranch(): Promise<void> {
    // 从服务端取得所选根的闭包与稳定版本；结果按视图、图和选择身份隔离。
    const mapId = activeMapId.value, rootId = selectedId.value, scope = sessionEpoch, epoch = viewEpoch, request = ++branchRead
    if (!mapId || !rootId || !snapshot.value?.nodes.some(node => node.id === rootId)) {
      selectedBranch.value = null; branchLoading.value = false; return
    }
    branchLoading.value = true
    try {
      const branch = await gateway.read('branch.get', { mapId, rootIds: [rootId] }, viewController.signal)
      if (scope !== sessionEpoch || epoch !== viewEpoch || request !== branchRead || activeMapId.value !== mapId || selectedId.value !== rootId) return
      if (branch.scope.rootIds.length !== 1 || branch.scope.rootIds[0] !== rootId) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_BRANCH)
      const root = snapshot.value?.nodes.find(node => node.id === rootId)
      if (!root || root.revision !== branch.rootRevisions[rootId] || snapshot.value?.revision !== branch.mapRevision) {
        const latest = await gateway.read('map.get', { mapId }, viewController.signal)
        if (scope === sessionEpoch && epoch === viewEpoch && request === branchRead) applySnapshot(latest, epoch)
        return
      }
      selectedBranch.value = branch
    } catch (cause) {
      if (scope !== sessionEpoch || epoch !== viewEpoch || request !== branchRead) return
      selectedBranch.value = null
      const problem = sessionReadProblem(cause)
      if (problem.status === 401 || problem.status === 403 || problem.status === 404) await handleFailure(cause, scope, epoch)
      else { error.value = problem; streamError.value = '读取分支版本失败，请重试刷新。' }
    } finally {
      if (scope === sessionEpoch && epoch === viewEpoch && request === branchRead) branchLoading.value = false
    }
  }

  async function loadWorkspaces() {
    // 遍历工作区列表分页，拒绝循环游标，并在本次读取仍有效时保留各工作区的较新版本。
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
        // 合并列表记录时，优先保留已有列表或当前工作区中版本更高的数据。
        const listed = workspaces.value.find(current => /* 查找该工作区已缓存的列表记录。 */ current.id === item.id)
        const current = workspace.value?.id === item.id && workspace.value.revision > (listed?.revision ?? -1) ? workspace.value : listed
        return current && current.revision > item.revision ? current : item
      })
    } catch (cause) { if (scope === sessionEpoch && request === workspaceListRead) throw cause }
  }
  async function refreshWorkspace() {
    // 并行读取当前工作区和图列表，保留较新版本，并在访问权失效时清空工作区视图。
    const id = workspace.value?.id, scope = sessionEpoch, epoch = viewEpoch, request = ++workspaceRead
    if (!id) return
    try {
      const [next, maps, nextDefinitions] = await Promise.all([
        gateway.read('workspace.get', { workspaceId: id }, viewController.signal),
        gateway.read('map.list', { workspaceId: id }, viewController.signal),
        gateway.read('definition.get', { workspaceId: id }, viewController.signal),
      ])
      if (scope !== sessionEpoch || epoch !== viewEpoch || request !== workspaceRead || workspace.value?.id !== id) return
      const current = workspace.value
      const preferences = next.preferences.revision >= current.preferences.revision ? next.preferences : current.preferences
      workspace.value = { ...(next.revision >= current.revision ? next : current), preferences }
      definitionCache.set(id, nextDefinitions)
      definitions.value = nextDefinitions
      mapList.value = maps.map(item => {
        // 合并图列表时保留本地已有的较新图摘要。
        const prior = mapList.value.find(current => /* 查找同一张图在现有列表中的摘要。 */ current.id === item.id)
        return prior && prior.revision > item.revision ? prior : item
      })
      openMapIds.value = openMapIds.value.filter(mapId =>
        /* 仅保留最新可访问图列表中仍存在的已打开标签页。 */
        maps.some(map =>
          /* 判断该标签页对应的图是否仍可访问。 */
          map.id === mapId))
      if (activeMapId.value && !maps.some(map => /* 检查当前图是否仍在工作区的可访问图列表中。 */ map.id === activeMapId.value)) {
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
  async function refresh() {
    // 读取当前图的快照，仅接纳仍有效的读取结果；图不可访问时关闭它并刷新工作区。
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
  async function refreshSettings() {
    // 刷新当前会话的启动信息，仅接纳最新一次读取并保留版本较新的全局设置。
    const scope = sessionEpoch, request = ++settingsRead
    try {
      const next = await gateway.read('app.bootstrap', {}, sessionController.signal)
      if (scope !== sessionEpoch || request !== settingsRead) return
      const settings = bootstrap.value && bootstrap.value.settings.revision > next.settings.revision ? bootstrap.value.settings : next.settings
      bootstrap.value = { ...next, settings }
    } catch (cause) { if (request === settingsRead) await handleFailure(cause, scope) }
  }
  async function refreshManagement() {
    // 依次刷新设置、工作区列表、当前工作区和图，在会话切换或被新刷新取代时停止后续步骤。
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
  function clearMapAccess() {
    // 关闭已失去访问权的当前图，取消它的视图资源并从已打开标签页中移除。
    const id = activeMapId.value
    stopView()
    activeMapId.value = null; snapshot.value = null; activities.value = []; selectedId.value = null
    openMapIds.value = openMapIds.value.filter(item => /* 从标签页中排除刚失去访问权的图。 */ item !== id)
    loading.value = false
  }
  function startWatch() {
    // 为当前图启动实时订阅，将消息限制在所属会话与视图内，并对可恢复的断流安排退避重连。
    const id = activeMapId.value, scope = sessionEpoch, epoch = viewEpoch
    if (!id) return
    const baseDelay = Math.max(100, Math.min(reconnectMs, 10_000))
    let delay = baseDelay
    const watch = async () => {
      // 连接所属视图的事件流，处理结束与错误，并仅在视图仍有效时安排下一次重连。
      if (scope !== sessionEpoch || epoch !== viewEpoch) return
      activities.value = []
      streamState.value = streamState.value === 'idle' ? 'connecting' : 'reconnecting'
      try {
        await gateway.watch(id, event => {
          // 将当前视图的流事件应用到快照、活动或管理数据，并将服务端错误交给订阅流程处理。
          if (scope !== sessionEpoch || epoch !== viewEpoch) return
          if (event.type === 'error') throw new ClientError(event.error)
          if (event.type === 'snapshot') {
            // 实时快照已成为当前基线，先前 HTTP 读取的结果和错误都不应再覆盖它。
            ++mapRead
            applySnapshot(event.snapshot, epoch)
            online.value = true; streamError.value = ''; streamState.value = 'live'; delay = baseDelay
          } else if (event.type === 'activity') {
            activities.value = event.items.filter(item =>
              /* 仅展示当前图中仍运行且未暂停的 Run 所属活动。 */
              item.mapId === id && snapshot.value?.runs.some(run => item.runId === run.id && !run.paused && run.status === 'running'))
          } else if (event.scope === 'settings') void refreshSettings()
          else {
            void refreshWorkspace()
            void loadWorkspaces().catch(cause => {
              // 仅在订阅所属会话和视图仍有效时展示工作区列表刷新错误。
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
      reconnectTimer = setTimeout(() => {
        // 在退避等待结束后重新连接事件流，由 watch 检查视图是否仍有效。
        void watch()
      }, delay)
      delay = Math.min(delay * 2, 10_000)
    }
    void watch()
  }
  async function persistPreferences() {
    // 串行保存当前工作区的标签页和节点选择，合并保存期间的新改动，并在本工作区写入失败后阻止继续保存。
    if (preferencesRunning || preferencesBlocked || !workspace.value) return
    preferencesRunning = true
    const scope = sessionEpoch, workspaceId = workspace.value.id
    try {
      while (preferencesDirty && workspace.value?.id === workspaceId && scope === sessionEpoch) {
        // 发送前清除脏标记；等待期间的新选择会再次置脏，由下一轮保存。
        preferencesDirty = false
        const result: GraphSuccess<Preferences> = await gateway.dispatch(crypto.randomUUID(), 'preferences.set', {
          workspaceId, expectedRevision: workspace.value.preferences.revision,
          openMapIds: [...openMapIds.value], currentMapId: activeMapId.value,
          nodeSelection: Object.fromEntries(openMapIds.value.map(id => /* 为每个已打开的图生成节点选择记录，未选中时写入 null。 */ [id, selections[id] ?? null])),
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
  function queuePreferences() {
    // 标记偏好待保存，并以 250 毫秒防抖合并连续的标签页和节点选择变动。
    preferencesDirty = true
    clearTimeout(preferenceTimer)
    preferenceTimer = setTimeout(() => {
      // 在连续偏好变动暂歇后启动保存，由保存流程处理失败。
      void persistPreferences()
    }, 250)
  }
  /**
   * @param grant 当前选中分支 grant。
   */
  function sessionReadLeaseProof(grant = selectedBranchGrant.value): GraphBranchLeaseProof | null {
    return grant ? { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence } : null
  }
  /**
   * @param grant 刚领取或续租成功的 editor grant。
   */
  function scheduleBranchRenewal(grant: GraphBranchGrant): void {
    clearTimeout(branchRenewTimer)
    branchRenewTimer = setTimeout(() => { void renewBranch(grant) }, Math.max(250, Math.floor(grant.leaseMs / 3)))
  }
  /**
   * @param expected 调度时捕获的 grant，迟到响应不得复活已替换授权。
   */
  async function renewBranch(expected: GraphBranchGrant): Promise<void> {
    if (selectedBranchGrant.value?.leaseId !== expected.leaseId || selectedBranchGrant.value.fence !== expected.fence || !activeMapId.value) return
    try {
      const result = await gateway.dispatch(crypto.randomUUID(), 'branch.renew', { mapId: activeMapId.value,
        lease: { leaseId: expected.leaseId, holderId: expected.holderId, fence: expected.fence } }, sessionController.signal)
      if (selectedBranchGrant.value?.leaseId !== expected.leaseId || selectedBranchGrant.value.fence !== expected.fence) return
      selectedBranchGrant.value = result.data
      scheduleBranchRenewal(result.data)
    } catch (cause) {
      if (selectedBranchGrant.value?.leaseId === expected.leaseId && selectedBranchGrant.value.fence === expected.fence) {
        selectedBranchGrant.value = null; clearTimeout(branchRenewTimer)
        error.value = sessionReadProblem(cause)
      }
    }
  }
  /**
   * @param rootIds 可选多根；省略时领取当前选择。
   */
  async function claimBranch(rootIds = selectedBranch.value?.scope.rootIds ?? []): Promise<boolean> {
    if (!clientLeasesRequired.value) return canEdit.value
    const mapId = activeMapId.value
    if (!mapId || !canEdit.value || !rootIds.length) return false
    if (selectedBranchGrant.value && selectedBranchGrant.value.rootIds.length === rootIds.length
      && selectedBranchGrant.value.rootIds.every(id => rootIds.includes(id))) return true
    if (selectedBranchGrant.value) await releaseBranch()
    const scope = sessionEpoch, epoch = viewEpoch
    busy.value = true; error.value = null
    try {
      const result = await gateway.dispatch(crypto.randomUUID(), 'branch.claim', { mapId, rootIds: [...rootIds], holderId: branchHolderId }, sessionController.signal)
      if (scope !== sessionEpoch || epoch !== viewEpoch || activeMapId.value !== mapId) {
        if (result.data.status === 'claimed') void gateway.dispatch(crypto.randomUUID(), 'branch.release', { mapId,
          lease: { leaseId: result.data.grant.leaseId, holderId: result.data.grant.holderId, fence: result.data.grant.fence } }).catch(() => {})
        return false
      }
      if (result.data.status === 'busy') {
        error.value = { code: 'BRANCH_BUSY', message: RuntimeMessage.BRANCH_IS_CURRENTLY_OWNED_BY_ANOTHER_CLIENT,
          status: 409, retryable: false, errorId: crypto.randomUUID() }
        return false
      }
      selectedBranchGrant.value = result.data.grant
      selectedBranch.value = result.data.grant.branch
      scheduleBranchRenewal(result.data.grant)
      return true
    } catch (cause) { await handleFailure(cause, scope, epoch); return false }
    finally { if (scope === sessionEpoch) busy.value = false }
  }
  async function releaseBranch(): Promise<void> {
    const grant = selectedBranchGrant.value, mapId = activeMapId.value
    clearTimeout(branchRenewTimer); branchRenewTimer = undefined; selectedBranchGrant.value = null
    if (!grant || !mapId) return
    try { await gateway.dispatch(crypto.randomUUID(), 'branch.release', { mapId,
      lease: { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence } }, sessionController.signal) }
    catch { /* 释放失败由租期回收；切图/退出不让次级错误覆盖主流程。 */ }
  }
  /**
   * @param grant 当前 Run 控制租约。
   */
  function sessionReadRunControlProof(grant = selectedRunControl.value): GraphRunControlProof | null {
    return grant ? { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence } : null
  }
  /**
   * @param grant 最近一次服务端确认的控制授权。
   */
  function scheduleRunControlRenewal(grant: GraphRunControlGrant): void {
    clearTimeout(runControlRenewTimer)
    runControlRenewTimer = setTimeout(() => { void renewRunControl(grant) }, Math.max(250, Math.floor(grant.leaseMs / 3)))
  }
  /**
   * @param expected 调度时捕获的 grant，迟到响应不得复活已替换授权。
   */
  async function renewRunControl(expected: GraphRunControlGrant): Promise<void> {
    if (selectedRunControl.value?.leaseId !== expected.leaseId || selectedRunControl.value.fence !== expected.fence || !activeMapId.value) return
    try {
      const result = await gateway.dispatch(crypto.randomUUID(), 'run.control.renew', { mapId: activeMapId.value, runId: expected.runId,
        control: { leaseId: expected.leaseId, holderId: expected.holderId, fence: expected.fence } }, sessionController.signal)
      if (selectedRunControl.value?.leaseId !== expected.leaseId || selectedRunControl.value.fence !== expected.fence) return
      selectedRunControl.value = result.data
      scheduleRunControlRenewal(result.data)
    } catch (cause) {
      if (selectedRunControl.value?.leaseId === expected.leaseId && selectedRunControl.value.fence === expected.fence) {
        selectedRunControl.value = null; clearTimeout(runControlRenewTimer)
        error.value = sessionReadProblem(cause)
      }
    }
  }
  /**
   * @param runId 目标 Run；省略时领取当前选择。
   */
  async function claimRunControl(runId = selectedRun.value?.id): Promise<boolean> {
    if (!clientLeasesRequired.value) return canEdit.value
    const mapId = activeMapId.value
    if (!mapId || !runId || !canEdit.value) return false
    if (selectedRunControl.value?.runId === runId) return true
    if (selectedRunControl.value) await releaseRunControl()
    const scope = sessionEpoch, epoch = viewEpoch
    busy.value = true; error.value = null
    try {
      const result = await gateway.dispatch(crypto.randomUUID(), 'run.control.claim', { mapId, runId, holderId: branchHolderId }, sessionController.signal)
      if (scope !== sessionEpoch || epoch !== viewEpoch || activeMapId.value !== mapId) {
        if (result.data.status === 'claimed') void gateway.dispatch(crypto.randomUUID(), 'run.control.release', { mapId, runId,
          control: { leaseId: result.data.grant.leaseId, holderId: result.data.grant.holderId, fence: result.data.grant.fence } }).catch(() => {})
        return false
      }
      if (result.data.status === 'busy') {
        error.value = { code: 'RUN_CONTROL_BUSY', message: RuntimeMessage.RUN_CONTROL_IS_CURRENTLY_OWNED_BY_ANOTHER_CLIENT,
          status: 409, retryable: false, errorId: crypto.randomUUID() }
        return false
      }
      selectedRunControl.value = result.data.grant
      scheduleRunControlRenewal(result.data.grant)
      return true
    } catch (cause) { await handleFailure(cause, scope, epoch); return false }
    finally { if (scope === sessionEpoch) busy.value = false }
  }
  async function releaseRunControl(): Promise<void> {
    const control = selectedRunControl.value, mapId = activeMapId.value
    clearTimeout(runControlRenewTimer); runControlRenewTimer = undefined; selectedRunControl.value = null
    if (!control || !mapId) return
    try { await gateway.dispatch(crypto.randomUUID(), 'run.control.release', { mapId, runId: control.runId,
      control: { leaseId: control.leaseId, holderId: control.holderId, fence: control.fence } }, sessionController.signal) }
    catch { /* 释放失败由租期回收；离开视图不让次级错误覆盖主流程。 */ }
  }
  /**
   * @param runId 用户在同图多个 Run 中选择查看和控制的身份。
   */
  async function selectRun(runId: string | null): Promise<void> {
    if (runId !== selectedRunId.value) await releaseRunControl()
    selectedRunId.value = runId && snapshot.value?.runs.some(run => run.id === runId) ? runId : null
  }
  /**
   * 仅选中当前快照中存在的节点，记住该图的选择并安排保存偏好。
   *
   * @param id 用户选择的真实节点身份；null 清空选择，不在当前快照中的身份也归为空。
   */
  function selectNode(id: string | null) {
    if (selectedId.value !== id) void releaseBranch()
    selectedId.value = id && snapshot.value?.nodes.some(node => /* 检查待选节点是否属于当前图快照。 */ node.id === id) ? id : null
    selectedBranch.value = null; branchRead++
    if (selectedId.value) void refreshSelectedBranch()
    if (activeMapId.value) selections[activeMapId.value] = selectedId.value
    queuePreferences()
  }
  /**
   * 取消旧视图，恢复目标图的节点选择，读取快照后启动订阅，并按需保存标签页偏好。
   *
   * @param id 要打开的图身份，必须存在于当前工作区的可访问列表。
   * @param persist 是否安排保存标签页偏好，默认 true；恢复偏好或内部换页时可传 false。
   */
  async function openMap(
    id: string,
    persist = true
  ) {
    if (!workspace.value || !mapList.value.some(map => /* 确认目标图在当前工作区的可访问列表中。 */ map.id === id)) return
    stopView()
    const epoch = viewEpoch
    activeMapId.value = id; snapshot.value = null; activities.value = []; selectedId.value = selections[id] ?? null; selectedBranch.value = null; selectedRunId.value = null
    if (!openMapIds.value.includes(id)) openMapIds.value.push(id)
    error.value = null; loading.value = true; retryCommand = null; canRetry.value = false
    await refresh()
    if (epoch !== viewEpoch) return
    loading.value = false
    startWatch()
    if (persist) queuePreferences()
  }
  /**
   * 移除图标签页和选择记录；关闭当前图时切换到最后一个标签页，再保存偏好。
   *
   * @param id 要关闭的标签页图身份；若为当前图则切换到剩余最后一页。
   */
  async function closeMap(id: string) {
    openMapIds.value = openMapIds.value.filter(mapId => /* 从已打开标签页中移除指定图。 */ mapId !== id)
    delete selections[id]
    if (activeMapId.value === id) {
      stopView(); activeMapId.value = null; snapshot.value = null; activities.value = []; selectedId.value = null
      loading.value = false
      const next = openMapIds.value[openMapIds.value.length - 1]
      if (next) await openMap(next, false)
    }
    queuePreferences()
  }
  /**
   * 清理旧工作区视图，读取目标工作区与图列表，并从已保存偏好恢复可访问的标签页和当前图。
   *
   * @param id 用户要进入的工作区身份，返回资料和图列表都需与它匹配。
   */
  async function selectWorkspace(id: string) {
    clearWorkspace()
    const scope = sessionEpoch, epoch = viewEpoch
    loading.value = true; error.value = null
    try {
      const cachedDefinitions = definitionCache.get(id)
      if (cachedDefinitions) definitions.value = cachedDefinitions
      const [next, maps, nextDefinitions] = await Promise.all([
        gateway.read('workspace.get', { workspaceId: id }, viewController.signal),
        gateway.read('map.list', { workspaceId: id }, viewController.signal),
        gateway.read('definition.get', { workspaceId: id }, viewController.signal),
      ])
      if (scope !== sessionEpoch || epoch !== viewEpoch) return
      if (next.id !== id || maps.some(map =>
        /* 检测返回图列表中是否混入其他工作区的图。 */
        map.workspaceId !== id)) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_WORKSPACE)
      workspace.value = next; mapList.value = maps; definitions.value = nextDefinitions; definitionCache.set(id, nextDefinitions); online.value = true
      openMapIds.value = next.preferences.openMapIds.filter(mapId =>
        /* 恢复偏好时仅保留当前仍可访问的图标签页。 */
        maps.some(map =>
          /* 匹配偏好中记录的图标识。 */
          map.id === mapId))
      selections = { ...next.preferences.nodeSelection }
      const current = next.preferences.currentMapId
      if (current && openMapIds.value.includes(current)) await openMap(current, false)
    } catch (cause) { await handleFailure(cause, scope, epoch) }
    finally { if (scope === sessionEpoch && epoch === viewEpoch) loading.value = false }
  }
  /**
   * 接纳仍有效的登录结果，加载工作区列表并进入第一个可访问的工作区。
   *
   * @param value 网关已验证的登录启动信息，只有原会话代次仍有效才接纳。
   * @param scope 发起初始化或连接时捕获的会话代次，防止旧登录结果回写。
   */
  async function attachSession(
    value: AppBootstrap,
    scope: number
  ) {
    if (scope !== sessionEpoch) return
    bootstrap.value = value; online.value = true
    await loadWorkspaces()
    if (scope === sessionEpoch && workspaces.value[0]) await selectWorkspace(workspaces.value[0].id)
  }
  async function initialize() {
    // 重置会话并读取已有连接配置，在网关已有配置时恢复启动信息和工作区。
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
  /**
   * 使用用户提供的服务地址和令牌建立新会话，并由统一连接流程接纳登录结果。
   *
   * @param input 用户提供的服务地址、访问令牌和记住登录选项，交给网关校验。
   */
  async function connect(input: Parameters<ClientGateway['connect']>[0]) {
    return connectSession(() => /* 将服务地址、令牌和记住登录选项传给网关。 */ gateway.connect(input))
  }
  async function connectLocal() {
    // 在网关支持本机服务时建立本机会话，并复用统一的会话切换与错误处理。
    if (!gateway.connectLocal) return
    return connectSession(() => /* 调用已确认存在的本机服务连接入口。 */ gateway.connectLocal!())
  }
  /**
   * 清理旧会话，执行连接并读取连接信息，仅让本次会话接纳登录结果和工作区。
   *
   * @param connect 已绑定远程或本机连接参数的异步入口，成功返回登录启动信息。
   */
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

  /**
   * 同一会话一次只接受一个界面命令，隔离过期结果；失败时保留可重试命令，版本冲突时刷新图和工作区。
   *
   * @param method 公开写命令方法名，决定参数和响应类型。
   * @param params 界面当前提交参数，先复制再保存用于重试，不修改调用方草稿。
   * @param requestId 业务幂等请求身份，默认生成 UUID；重试必须复用原标识。
   */
  async function submit<K extends keyof CommandInputMap>(
    method: K,
    params: CommandInputMap[K],
    requestId = crypto.randomUUID()
  ): Promise<GraphSuccess<CommandOutputMap[K]> | null> {
    if (busy.value) return null
    // 固定本次提交内容，用户随后编辑草稿时，重试仍能复用原 requestId 和原始参数。
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
            // 在原会话和视图内重放同一命令标识及提交内容，成功后刷新相关状态并打开新建资源。
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
  async function retry(): Promise<boolean> {
    // 执行仍保留的命令重试，并返回这次提交是否取得成功结果。
    return retryCommand ? !!await retryCommand() : false
  }
  /**
   * 创建使用共享 Agent 库的工作区，刷新列表，并在视图未切换时进入新工作区。
   *
   * @param name 新工作区展示名称，由界面提供，最终约束由服务端校验。
   * @param description 新工作区说明，默认空字符串。
   */
  async function createWorkspace(name: string, description = '') {
    const epoch = viewEpoch, scope = sessionEpoch
    const result = await submit('workspace.create', { id: crypto.randomUUID(), name, description, agentSource: 'library' })
    if (!result) return false
    await loadWorkspaces()
    if (scope !== sessionEpoch || epoch !== viewEpoch) return true
    await selectWorkspace(result.data.id)
    return true
  }
  /**
   * 在可编辑工作区中创建图，刷新工作区摘要，并在视图未切换时打开新图。
   *
   * @param name 新图展示名称，由界面提供，最终约束由服务端校验。
   */
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
  /**
   * 按分支版本提交局部变化；同图其他分支的提交不会使这份证明失效。
   *
   * @param branch 编辑草稿所依据的分支根和稳定内容版本。
   * @param changes 要提交的节点、边或图属性差量，不直接修改本地已保存快照。
   * @param lease 已有分支必须携带的 editor 租约；新根省略。
   */
  async function applyChanges(
    branch: GraphBranchProof,
    changes: Extract<GraphCommand, { method: 'graph.apply' }>['params']['changes'],
    lease?: GraphBranchLeaseProof,
  ) {
    if (!snapshot.value || !canEdit.value) return false
    const result = await submit('graph.apply', { mapId: snapshot.value.mapId, branch, ...(lease ? { lease } : {}), changes })
    if (!result) return false
    applySnapshot(result.data.snapshot, viewEpoch)
    await refreshWorkspace()
    return true
  }
  /**
   * 创建精确绑定类型版本的通用数据实例，并在仍处于原视图时选中新节点。
   *
   * @param definition 新节点的精确不可变类型定义。
   * @param payload 已按定义编辑的通用 payload。
   */
  async function createNode(definition: DataTypeDefinition, payload: GraphPayload) {
    if (!snapshot.value) return false
    const epoch = viewEpoch
    const id = crypto.randomUUID()
    if (!await applyChanges({ rootIds: [id], expectedVersion: null }, { nodes: { put: [{ id, typeId: definition.id, typeVersion: definition.version, payload }] } })) return false
    if (epoch === viewEpoch) selectNode(id)
    return true
  }
  /**
   * 按调用者开始编辑时取得的分支版本保存指定数据实例。
   *
   * @param input 包含节点身份、精确类型、payload 和草稿分支证明的保存请求。
   */
  async function saveNode(input: { branch: GraphBranchProof; nodeId: string; typeId: string; typeVersion: number; payload: GraphPayload }) {
    if (clientLeasesRequired.value && !sessionReadLeaseProof() && !await claimBranch(input.branch.rootIds)) return false
    const lease = clientLeasesRequired.value ? sessionReadLeaseProof() : undefined
    if (clientLeasesRequired.value && !lease) return false
    return applyChanges(input.branch, { nodes: { put: [{ id: input.nodeId, typeId: input.typeId, typeVersion: input.typeVersion, payload: input.payload }] } }, lease ?? undefined)
  }
  /**
   * 按调用者开始编辑时取得的分支版本提交节点删除。
   *
   * @param input 包含要删除的节点身份与草稿分支证明的请求。
   */
  async function removeNode(input: { branch: GraphBranchProof; nodeId: string }) {
    if (clientLeasesRequired.value && !sessionReadLeaseProof() && !await claimBranch(input.branch.rootIds)) return false
    const lease = clientLeasesRequired.value ? sessionReadLeaseProof() : undefined
    if (clientLeasesRequired.value && !lease) return false
    return applyChanges(input.branch, { nodes: { remove: [input.nodeId] } }, lease ?? undefined)
  }
  /**
   * 先读取整个运行根集合的同一分支版本，再由 run.start 原子核对，避免静默采用选择后的变化。
   *
   * @param input 用户选择的节点范围、有限计划、运行模式及可选重新生成标记。
   */
  async function startRun(input: Pick<CommandInputMap['run.start'], 'scope' | 'plan' | 'mode' | 'regenerate'>) {
    if (!snapshot.value || !canEdit.value || busy.value) return false
    const mapId = snapshot.value.mapId, roots = [...input.scope.nodeIds], scope = sessionEpoch, epoch = viewEpoch
    busy.value = true; error.value = null; canRetry.value = false; retryCommand = null
    let branch: GraphBranchSnapshot
    try {
      branch = await gateway.read('branch.get', { mapId, rootIds: roots }, viewController.signal)
      if (scope !== sessionEpoch || epoch !== viewEpoch || snapshot.value?.mapId !== mapId) return false
      if (branch.scope.rootIds.length !== roots.length || roots.some(id => !branch.scope.rootIds.includes(id))) {
        throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_BRANCH)
      }
      if (snapshot.value?.revision !== branch.mapRevision
        || roots.some(id => snapshot.value?.nodes.find(node => node.id === id)?.revision !== branch.rootRevisions[id])) {
        const latest = await gateway.read('map.get', { mapId }, viewController.signal)
        if (scope === sessionEpoch && epoch === viewEpoch) applySnapshot(latest, epoch)
        throw new Error(RuntimeMessage.BRANCH_VERSION_CHANGED)
      }
    } catch (cause) {
      if (scope === sessionEpoch && epoch === viewEpoch) await handleFailure(cause, scope, epoch)
      return false
    } finally {
      if (scope === sessionEpoch && epoch === viewEpoch) busy.value = false
    }
    if (scope !== sessionEpoch || epoch !== viewEpoch || snapshot.value?.mapId !== mapId) return false
    await releaseRunControl()
    if (clientLeasesRequired.value && !await claimBranch(branch.scope.rootIds)) return false
    const lease = clientLeasesRequired.value ? sessionReadLeaseProof() : undefined
    if (clientLeasesRequired.value && !lease) return false
    const runId = crypto.randomUUID()
    const result = await submit('run.start', { mapId, id: runId, branch: {
      rootIds: [...branch.scope.rootIds], expectedVersion: branch.version,
    }, ...(lease ? { lease } : {}), ...input })
    if (result) {
      selectedBranchGrant.value = null; clearTimeout(branchRenewTimer)
      selectedRunControl.value = result.data.runControl ?? null
      selectedRunId.value = result.data.snapshot.runs.find(run => run.id === runId)?.id ?? null
      if (selectedRunControl.value) scheduleRunControlRenewal(selectedRunControl.value)
      applySnapshot(result.data.snapshot, viewEpoch)
      const startedRun = result.data.snapshot.runs.find(run => run.id === selectedRunId.value)
      if (clientLeasesRequired.value && !selectedRunControl.value && startedRun && ['running', 'waiting'].includes(startedRun.status)) {
        void claimRunControl(startedRun.id)
      }
    }
    return !!result
  }
  /**
   * 有编辑权限时提交审核决定，并用返回快照展示审核后的运行状态。
   *
   * @param params 含当前审核身份、预期版本和批准或拒绝决定的请求。
   */
  async function answerReview(params: Omit<CommandInputMap['review.answer'], 'control'>) {
    if (!canEdit.value) return
    if (clientLeasesRequired.value && !sessionReadRunControlProof() && !await claimRunControl(params.runId)) return
    const control = clientLeasesRequired.value ? sessionReadRunControlProof() : undefined
    if (clientLeasesRequired.value && !control) return
    const result = await submit('review.answer', { ...params, ...(control ? { control } : {}) })
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  /**
   * 有编辑权限时向服务端取消指定运行，并接纳返回的图快照。
   *
   * @param params 含目标图与 Run 身份的取消请求。
   */
  async function cancelRun(params: Omit<CommandInputMap['run.cancel'], 'control'>) {
    if (!canEdit.value) return
    if (clientLeasesRequired.value && !sessionReadRunControlProof() && !await claimRunControl(params.runId)) return
    const control = clientLeasesRequired.value ? sessionReadRunControlProof() : undefined
    if (clientLeasesRequired.value && !control) return
    const result = await submit('run.cancel', { ...params, ...(control ? { control } : {}) })
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  /**
   * 有编辑权限时向服务端暂停指定运行，并接纳返回的图快照。
   *
   * @param params 含目标图与 Run 身份的暂停请求。
   */
  async function pauseRun(params: Omit<CommandInputMap['run.pause'], 'control'>) {
    if (!canEdit.value) return
    if (clientLeasesRequired.value && !sessionReadRunControlProof() && !await claimRunControl(params.runId)) return
    const control = clientLeasesRequired.value ? sessionReadRunControlProof() : undefined
    if (clientLeasesRequired.value && !control) return
    const result = await submit('run.pause', { ...params, ...(control ? { control } : {}) })
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  /**
   * 有编辑权限时向服务端恢复指定运行，并接纳返回的图快照。
   *
   * @param params 含目标图与 Run 身份的恢复请求。
   */
  async function resumeRun(params: Omit<CommandInputMap['run.resume'], 'control'>) {
    if (!canEdit.value) return
    if (clientLeasesRequired.value && !sessionReadRunControlProof() && !await claimRunControl(params.runId)) return
    const control = clientLeasesRequired.value ? sessionReadRunControlProof() : undefined
    if (clientLeasesRequired.value && !control) return
    const result = await submit('run.resume', { ...params, ...(control ? { control } : {}) })
    if (result) applySnapshot(result.data.snapshot, viewEpoch)
  }
  function dispose() {
    // 在界面卸载时清理会话状态、请求、订阅与定时器，不发送取消远端运行的命令。
    clearSession()
  }
  return {
    connection, bootstrap, workspaces, workspace, definitions, catalog, mapList, openMapIds, activeMapId, snapshot, activities, selectedId, selectedNode, selectedBranch, selectedBranchGrant, selectedRunId, selectedRun, selectedRunControl,
    initializing, connecting, loading, busy, branchLoading, online, error, streamError, streamState, lastSync, canRetry, canEdit, clientLeasesRequired, active,
    initialize, connect, connectLocal, disconnect, loadWorkspaces, selectWorkspace, createWorkspace, createMap,
    openMap, closeMap, selectNode, selectRun, refresh, refreshWorkspace, refreshManagement, retry, createNode, saveNode, removeNode, claimBranch, releaseBranch, claimRunControl, releaseRunControl,
    startRun, answerReview, cancelRun, pauseRun, resumeRun, dispose,
    clearError() {
      // 清除当前错误提示，同时丢弃其命令重试入口。
      error.value = null; canRetry.value = false; retryCommand = null
    },
  }
}

export const useClientStore = defineStore('client-workspace', () => /* 以应用网关创建 Pinia 持有的客户端会话状态。 */ sessionCreateState(api))
