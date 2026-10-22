// 客户端会话状态：管理工作区和图视图、实时订阅、偏好保存及命令重试。
import { RuntimeMessage } from '../../../contracts/messages'
import type { GraphActivity } from '../../../contracts/activity'
import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { ClientError, type ClientAccountGateway, type ClientGateway, type CommandInputMap, type CommandOutputMap } from '../../../contracts/client'
import type { AppBootstrap, DefinitionView, Preferences, WorkspaceSummary, WorkspaceView } from '../../../contracts/control'
import type { DataTypeDefinition, DefinitionRef, JsonValue } from '../../../contracts/data-definition'
import type {
  GraphBranchGrant,
  GraphBranchLeaseProof,
  GraphBranchOwnership,
  GraphBranchProof,
  GraphBranchSnapshot,
  GraphRunControlGrant,
  GraphRunControlProof,
} from '../../../contracts/graph-branch'
import type { GraphMapSummary, GraphSnapshot, GraphSuccess, GraphCommand } from '../../../contracts/graph-api'
import type { GraphChanges, GraphNode, GraphPayload, GraphSourceAnchor } from '../../../contracts/graph'
import type { EvidenceUseRef } from '../../../contracts/evidence-library'
import { api } from '../transport/client-gateway'
import { clientReadError } from '../../../client/graph-client'
import { payloadFindType, payloadReadPointer } from '../features/graph/data-payload'
import { branchCreateBaseline, branchBaselineMatchesSnapshot, type BranchBaseline } from '../features/graph/branch-baseline'
import { AccountUiMessage } from '../features/auth/account-messages'

interface SessionProblem { message: string; code: string; status: number; retryable: boolean; errorId: string }
const SESSION_PROBLEM_MESSAGES = new Map<string, string>([
  ['UNAUTHORIZED', RuntimeMessage.SESSION_UNAUTHORIZED],
  ['FORBIDDEN', RuntimeMessage.SESSION_FORBIDDEN],
  ['REVISION_CONFLICT', RuntimeMessage.SESSION_REVISION_CONFLICT],
  ['BRANCH_VERSION_CONFLICT', RuntimeMessage.SESSION_REVISION_CONFLICT],
  ['CONFIGURATION_NOT_INITIALIZED', RuntimeMessage.SESSION_CONFIGURATION_NOT_INITIALIZED],
])
type PreferenceSync = 'synced' | 'saving' | 'unsynced' | 'conflict' | 'error'
interface PreferenceRequest {
  readonly requestId: string
  readonly params: CommandInputMap['preferences.set']
}
/** 固定父版本与后继类型的一次创建意图；会话负责原子写入及授权，未知结果只能重放原请求。 */
export interface ChildNodeInput {
  readonly mapId: string
  readonly parentId: string
  readonly expectedParentRevision: number
  readonly childType: DefinitionRef
  readonly payload: GraphPayload
  readonly sourceAnchors?: GraphSourceAnchor[]
}
interface ScopedChanges {
  readonly mapId: string
  readonly nodeRevisions: Readonly<Record<string, number>>
  readonly edgeRevisions?: Readonly<Record<string, number>>
  readonly changes: GraphChanges
  readonly selectId?: string
}
enum NodeEditMessage {
  RELEASE_PARTIAL_GRANT = '当前编辑权未覆盖本次操作的全部节点，请先释放分支编辑权。',
  INVALID_SUCCESSOR = '当前类型不允许创建这个后继类型。',
  INVALID_REFERENCE = '请选择当前图中符合字段类型的节点。',
}

function sessionReadReferenceTargets(
  /* 本次表单所属的精确类型声明。 */ definition: DataTypeDefinition,
  /* 表单已编辑的JSON正文，仍由服务端作最终schema校验。 */ payload: GraphPayload,
): Array<{ id: string; types: DefinitionRef[] }> {
  // 展开声明的节点引用路径，资产不成为结构授权目标；条件声明只在实际满足时生效。
  const result: Array<{ id: string; types: DefinitionRef[] }> = []
  for (const reference of definition.references) {
    if (reference.target.kind !== 'node' || reference.when && JSON.stringify(payloadReadPointer(payload, reference.when.path)) !== JSON.stringify(reference.when.equals)) continue
    let values: JsonValue[] = [payload]
    for (const part of reference.path.slice(1).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
      values = values.flatMap((/* 引用路径这一层的对象、数组或标量。 */ value) => {
        // 通配符展开真实数组或字典，其余路径只读取实际存在的JSON属性。
        if (!value || typeof value !== 'object') return []
        if (key === '*') return Object.values(value)
        const next = Array.isArray(value) ? value[Number(key)] : value[key]
        return next === undefined ? [] : [next]
      })
    }
    for (const value of values) if (typeof value === 'string') result.push({ id: value, types: reference.target.types })
  }
  return result
}
// ended 只表示本地领取意图完成或失效；原 HTTP 仍可能在途，由其迟到清理负责租约交接。
interface BranchClaimIntent {
  readonly request: number
  readonly mapId: string
  readonly rootIds: readonly string[]
  readonly ended: Promise<void>
  // 完成意图等待，允许旧授权在当前领取结果明确后安全决定是否释放。
  end(): void
}
interface RunControlClaimIntent {
  readonly mapId: string
  readonly runId: string
  readonly ended: Promise<void>
  // 本地意图结束后，迟到授权才能判断是否仍被下一次同Run领取使用。
  end(): void
}
/**
 * 将异常转换为界面可展示的问题，统一已知错误文案并为缺失的诊断编号生成标识。
 *
 * @param error 任意来源的异常；只信任经类型检查的结构化字段，未知异常使用统一展示文案。
 */
function sessionReadProblem(/* 网关归一化后的客户端错误或意外内部异常。 */ error: unknown): SessionProblem {
  // 复用公共错误边界，只在界面层翻译已登记的业务码。
  const problem = clientReadError(error)
  return { ...problem, message: SESSION_PROBLEM_MESSAGES.get(problem.code)
    ?? (error instanceof ClientError ? problem.message : RuntimeMessage.SESSION_OPERATION_FAILED_WITH_ERROR_ID) }
}

/**
 * 创建并持有一个客户端会话的工作区、图视图、订阅与偏好状态，供界面发起操作和读取结果。
 *
 * @param gateway 调用者装配的传输网关，负责认证和协议校验；会话只持有其请求与订阅生命周期。
 * @param reconnectMs 初始重连等待毫秒数，默认 1000，实际限制在 100–10000 毫秒。
 */
export function sessionCreateState(
  /* 当前会话独占的传输边界，身份、命令和订阅仍由它处理。 */ gateway: ClientGateway,
  /* 断流后首次重连等待的毫秒数，实际间隔仍由既有上限限制。 */ reconnectMs = 1000
) {
  // 持有一份客户端会话及其当前视图，按代次结束旧请求、订阅、授权和编辑基线。
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
  const preferenceSync = ref<PreferenceSync>('synced')
  const accountAvailable = computed(() => /* 旧网关缺少账户能力时仍保留令牌与本机登录。 */ !!gateway.account)
  const canEdit = computed(() => /* 根据工作区角色和在线状态判断界面是否允许编辑。 */ !!workspace.value && workspace.value.role !== 'viewer' && online.value)
  const canRenameMap = computed(() => /* 服务能力与角色同时满足时才允许改名，不向旧服务尝试新命令。 */
    canEdit.value && bootstrap.value?.metadata.capabilities?.mapRename === true)
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
  // 编辑授权请求属于当前选择意图；busy 标记只由对应的领取任务结束。
  let selectionEpoch = 0, branchClaimRequest = 0
  // 运行选择代次只隔离本会话的旧审核点击，返回同一运行也不恢复先前意图。
  let runSelectionEpoch = 0
  let runControlClaim: RunControlClaimIntent | null = null
  const runControlReleases = new Set<{ mapId: string; runId: string; scope: number; finished: Promise<void> }>()
  let branchClaimBusyRequest: BranchClaimIntent | null = null
  const branchReleases = new Set<{ mapId: string; scope: number; nodeIds: readonly string[]; finished: Promise<void> }>()
  // 命令和偏好保存属于会话；图读取和订阅属于视图，切图不向服务端取消已经提交的运行。
  let sessionController = new AbortController()
  let viewController = new AbortController()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let branchRenewTimer: ReturnType<typeof setTimeout> | undefined
  let branchExpiryTimer: ReturnType<typeof setTimeout> | undefined
  let runControlRenewTimer: ReturnType<typeof setTimeout> | undefined
  const branchHolderId = crypto.randomUUID()
  let runControlHolderId = branchHolderId
  // 未确认的旧释放仍可能晚提交，后续编辑领取不能复用它可撤销的 holder/lease。
  let editorHolderId = branchHolderId
  let preferenceTimer: ReturnType<typeof setTimeout> | undefined
  // 偏好请求与最新本地选择由本会话独占；工作区代次结束时同时失效，不受同区切图影响。
  let preferenceEpoch = 0, preferenceChanges = 0
  let preferencesRunning = false, preferencesDirty = false
  let preferencesRequest: PreferenceRequest | null = null
  let selections: Record<string, string | null> = {}
  // 图管理重试属于当前工作区；其他命令仍随图视图结束而失效。
  let retryCommand: { run: () => Promise<unknown>; workspaceEpoch?: number } | null = null
  const definitionCache = new Map<string, DefinitionView>()
  // 当前选择只持有一份已配对基线；选择/视图结束即清除，不形成图历史缓存。
  let selectedBranchBaseline: BranchBaseline | null = null

  function stopView() {
    // 结束旧视图的读取、订阅、活动与重试；仍属当前工作区的图管理请求继续保留。
    activities.value = []
    void releaseBranch()
    void releaseRunControl()
    selectedBranch.value = null; selectedBranchBaseline = null
    selectedBranchGrant.value = null; selectedRunId.value = null; branchLoading.value = false; branchRead++
    viewEpoch++
    viewController.abort()
    viewController = new AbortController()
    clearTimeout(reconnectTimer)
    clearTimeout(branchRenewTimer)
    clearTimeout(runControlRenewTimer)
    reconnectTimer = undefined
    streamState.value = 'idle'; streamError.value = ''
    if (retryCommand?.workspaceEpoch !== preferenceEpoch) { retryCommand = null; canRetry.value = false }
  }
  function clearWorkspace() {
    // 结束旧工作区及其偏好代次，清空视图和恢复提示；迟到保存不再占用新工作区队列。
    stopView()
    clearTimeout(preferenceTimer)
    preferenceTimer = undefined
    preferenceEpoch++
    preferenceChanges = 0
    preferencesRunning = false
    preferencesDirty = false
    preferencesRequest = null
    preferenceSync.value = 'synced'
    busy.value = false
    retryCommand = null
    canRetry.value = false
    workspace.value = null; definitions.value = null; mapList.value = []; openMapIds.value = []
    activeMapId.value = null; snapshot.value = null; activities.value = []; selectedId.value = null; selectedBranch.value = null; selectedRunId.value = null
    loading.value = false
    selections = {}; streamError.value = ''; lastSync.value = null
  }
  function clearSession() {
    // 使旧会话及其请求失效，释放当前视图资源并清空登录后的界面状态。
    sessionEpoch++
    editorHolderId = crypto.randomUUID()
    runControlHolderId = crypto.randomUUID()
    sessionController.abort()
    sessionController = new AbortController()
    clearWorkspace()
    bootstrap.value = null; workspaces.value = []; definitionCache.clear(); online.value = false
    error.value = null
    busy.value = false; connecting.value = false; loading.value = false; initializing.value = false
    retryCommand = null; canRetry.value = false
  }
  async function disconnect() {
    // 原令牌与认证过期路径只结束当前连接，不额外发出账户撤销请求。
    await disconnectSession(() => /* 交给原网关取消连接与已保存的凭据。 */ gateway.disconnect())
  }
  async function logout(): Promise<void> {
    // 用户明确退出账户时撤销服务器会话；旧令牌和本机连接保持原退出语义。
    const account = gateway.account
    await disconnectSession(() => /* 只有已标记的账户会话才使用新退出接口。 */
      connection.value?.account && account ? account.logout() : gateway.disconnect())
  }
  async function disconnectSession(
    /* 已绑定当前连接的实际退出动作。 */ closeConnection: () => Promise<void>,
  ): Promise<void> {
    // 先清除本地数据，再等待网关结束连接；迟到退出不能覆盖后来一次登录。
    clearSession()
    const scope = sessionEpoch
    error.value = null
    try {
      await closeConnection()
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
    /* 当前图的完整公共快照，内容版本与占用版本分别校验。 */ next: GraphSnapshot,
    /* 本次读取或订阅所属的视图代次。 */ epoch: number,
    /* 可选的同次写响应证明，只有仍属于当前选择且内容配对时才接纳。 */ pairedBranch?: GraphBranchSnapshot,
  ): void {
    // 接纳未倒退的内容；撤销私有授权还必须有不早于该授权的占用事实。
    if (epoch !== viewEpoch) return
    if (next.mapId !== activeMapId.value || next.workspaceId !== workspace.value?.id) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_MAP)
    const currentOwnershipRevision = snapshot.value?.ownershipRevision ?? 0, nextOwnershipRevision = next.ownershipRevision
    if (snapshot.value && next.revision < snapshot.value.revision) return
    if (snapshot.value && next.revision === snapshot.value.revision && nextOwnershipRevision < currentOwnershipRevision) {
      // 同 R 的较新占用保持；内容证明仍能配对此时相同内容的当前快照。
      if (pairedBranch) acceptSelectedBranch(pairedBranch, snapshot.value)
      return
    }
    const previousRevision = snapshot.value?.revision
    const acceptedSnapshot = !snapshot.value || next.revision > snapshot.value.revision || nextOwnershipRevision > currentOwnershipRevision
      ? next : snapshot.value
    snapshot.value = acceptedSnapshot
    if (!next.runs.some((/* 当前快照中的运行。 */ run) => /* 保留仍存在的运行选择。 */ run.id === selectedRunId.value)) {
      selectedRunId.value = next.runs.find((/* 当前图的候选运行。 */ run) => /* 优先恢复仍在执行或审核中的运行。 */ ['running', 'waiting'].includes(run.status))?.id ?? next.runs[next.runs.length - 1]?.id ?? null
    }
    reconcileBranchGrant(next)
    const confirmedControl = selectedRunControl.value
    if (confirmedControl && nextOwnershipRevision >= confirmedControl.ownershipRevision) {
      const control = next.runControls.find((/* 当前权威快照中的控制占用。 */ item) => /* 按完整控制证明匹配，不用旧 O 撤销新确认。 */
        item.leaseId === confirmedControl.leaseId && item.holderId === confirmedControl.holderId && item.fence === confirmedControl.fence)
      if (control) selectedRunControl.value = { ...control, ownershipRevision: next.ownershipRevision }
      else { selectedRunControl.value = null; clearTimeout(runControlRenewTimer) }
    }
    activities.value = activities.value.filter((/* 当前展示的运行活动。 */ item) =>
      /* 仅保留当前未暂停运行中、且所属 Operation 仍在执行的活动。 */
      next.runs.some((/* 本次快照中的真实运行。 */ run) => /* 暂停或终态运行不保留执行活动。 */ item.runId === run.id && !run.paused && run.status === 'running'
        && run.operations.some((/* 活动所属的执行步骤。 */ operation) => /* 确认活动关联的 Operation 仍处于运行状态。 */ operation.id === item.operationId && operation.status === 'running')))
    mapList.value = mapList.value.map((/* 工作区目录中的已有图概况。 */ item) =>
      /* 用本次快照更新同一张图的旧摘要，其余图和较新摘要保持原值。 */
      item.id === next.mapId && item.revision <= next.revision ? {
      id: next.mapId, workspaceId: next.workspaceId, revision: next.revision, name: next.name, nodeCount: next.nodes.length,
      typeCounts: next.nodes.reduce<Record<string, number>>((/* 已累积的精确类型计数。 */ counts, /* 新快照中的实际节点。 */ node) => {
        // 按类型与版本重新统计当前图概况，其他图仍保留原目录值。
        const key = `${node.typeId}@${node.typeVersion}`
        counts[key] = (counts[key] ?? 0) + 1
        return counts
      }, {}), updatedAt: next.updatedAt,
    } : item)
    if (selectedId.value && !next.nodes.some((/* 新快照中的图内节点。 */ node) => /* 确认所选节点仍存在于新快照中。 */ node.id === selectedId.value)) {
      selectedId.value = null; selectionEpoch++; invalidateBranchClaim()
      selectedBranch.value = null; selectedBranchBaseline = null; branchRead++; branchLoading.value = false
    }
    online.value = true; streamError.value = ''; lastSync.value = new Date().toISOString()
    if (selectedId.value) {
      if (pairedBranch && acceptSelectedBranch(pairedBranch, acceptedSnapshot)) return
      const baseline = selectedBranchBaseline
      if (previousRevision !== undefined && (next.revision > previousRevision || nextOwnershipRevision > currentOwnershipRevision) && baseline
        && selectedBranch.value === baseline.branch && branchBaselineMatchesSnapshot(baseline, next, selectedId.value)) {
        // 新内容或占用版本没有改变当前分支事实，保留原证明，不等待无关读取锁住当前编辑。
        branchRead++
        branchLoading.value = false
      } else void refreshSelectedBranch()
    }
  }

  function acceptSelectedBranch(
    /* 真实服务端证明，不能用客户端拼装 version 或改写 mapRevision。 */ branch: GraphBranchSnapshot,
    /* 已经接纳的同图内容快照，可能只有 O 比写响应更新。 */ current: GraphSnapshot,
  ): boolean {
    // 只有同次内容及实际闭包配对成功才结束加载，旧读成功/失败同时失效。
    const id = selectedId.value
    if (!id || current.mapId !== activeMapId.value || current.workspaceId !== workspace.value?.id) return false
    const baseline = branchCreateBaseline(current, branch, id)
    if (!baseline) return false
    selectedBranchBaseline = baseline
    selectedBranch.value = branch
    branchRead++
    branchLoading.value = false
    return true
  }

  async function refreshSelectedBranch(): Promise<void> {
    // 从服务端取得所选根的闭包与稳定版本；结果按视图、图和选择身份隔离。
    const mapId = activeMapId.value, rootId = selectedId.value, scope = sessionEpoch, epoch = viewEpoch, request = ++branchRead
    if (!mapId || !rootId || !snapshot.value?.nodes.some((/* 当前图内的实际节点。 */ node) => /* 只读取仍存在的当前根。 */ node.id === rootId)) {
      selectedBranch.value = null; selectedBranchBaseline = null; branchLoading.value = false; return
    }
    branchLoading.value = true
    try {
      const branch = await gateway.read('branch.get', { mapId, rootIds: [rootId] }, viewController.signal)
      if (scope !== sessionEpoch || epoch !== viewEpoch || request !== branchRead || activeMapId.value !== mapId || selectedId.value !== rootId) return
      if (branch.scope.rootIds.length !== 1 || branch.scope.rootIds[0] !== rootId) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_BRANCH)
      const root = snapshot.value?.nodes.find((/* 当前已接纳快照中的节点。 */ node) => /* 比较同一根的已保存内容版本。 */ node.id === rootId)
      if (!root || root.revision !== branch.rootRevisions[rootId] || snapshot.value?.revision !== branch.mapRevision) {
        const latest = await gateway.read('map.get', { mapId }, viewController.signal)
        if (scope === sessionEpoch && epoch === viewEpoch && request === branchRead) applySnapshot(latest, epoch)
        return
      }
      const current = snapshot.value
      if (!current || !acceptSelectedBranch(branch, current)) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_BRANCH)
    } catch (cause) {
      if (scope !== sessionEpoch || epoch !== viewEpoch || request !== branchRead) return
      selectedBranch.value = null; selectedBranchBaseline = null
      const problem = sessionReadProblem(cause)
      if (problem.status === 401 || problem.status === 403 || problem.status === 404) await handleFailure(cause, scope, epoch)
      else { error.value = problem; streamError.value = '读取分支版本失败，请重试刷新。' }
    } finally {
      // 成功接纳会自行结束所属 loading；旧 finally 不能结束后来一次刷新。
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
    // 串行确认原偏好请求，再保存等待期间的新选择；不确定与明确冲突分别停下供用户恢复。
    if (preferencesRunning || preferenceSync.value !== 'synced' || !workspace.value) return
    if (!preferencesRequest && !preferencesDirty) return
    preferencesRunning = true
    const scope = sessionEpoch, epoch = preferenceEpoch, workspaceId = workspace.value.id
    const current = () => /* 同一工作区再次进入也不能接纳离开前的保存或清理。 */
      scope === sessionEpoch && epoch === preferenceEpoch && workspace.value?.id === workspaceId
    preferenceSync.value = 'saving'
    try {
      while (current() && (preferencesRequest || preferencesDirty)) {
        const owner: WorkspaceView | null = workspace.value
        if (!owner) return
        if (!preferencesRequest) {
          preferencesDirty = false
          preferencesRequest = { requestId: crypto.randomUUID(), params: {
            workspaceId, expectedRevision: owner.preferences.revision,
            openMapIds: [...openMapIds.value], currentMapId: activeMapId.value,
            nodeSelection: Object.fromEntries(openMapIds.value.map(
              /* 当前仍打开的图，未选择节点时保存 null。 */ id => /* 为请求独占一份节点选择快照。 */ [id, selections[id] ?? null],
            )),
          } }
        }
        const request: PreferenceRequest = preferencesRequest
        const result: GraphSuccess<Preferences> = await gateway.dispatch(request.requestId, 'preferences.set', request.params, sessionController.signal)
        const live: WorkspaceView | null = workspace.value
        if (!current() || !live) return
        preferencesRequest = null
        // 重放可能返回服务器当前偏好，只接纳版本基线，不能覆盖等待期间的本地标签和节点选择。
        if (result.data.revision >= live.preferences.revision) workspace.value = { ...live, preferences: result.data }
        if (result.replayed && (result.data.currentMapId !== request.params.currentMapId
          || result.data.openMapIds.length !== request.params.openMapIds.length
          || result.data.openMapIds.some(
            /* 重放返回的标签页及其位置。 */ (id, /* 该标签在原请求中的位置。 */ index) =>
              /* 标签顺序也是个人视图设置的一部分。 */ id !== request.params.openMapIds[index],
          )
          || Object.keys(result.data.nodeSelection).length !== Object.keys(request.params.nodeSelection).length
          || Object.entries(request.params.nodeSelection).some(
            /* 原请求中每张图的明确节点选择。 */ ([id, selection]) =>
              /* 其他窗口后来的选择不能被当成原请求的同步成功。 */ result.data.nodeSelection[id] !== selection,
          ))) {
          preferencesDirty = true
          preferenceSync.value = 'conflict'
          return
        }
      }
      if (current()) preferenceSync.value = 'synced'
    } catch (cause) {
      if (!current()) return
      const problem = sessionReadProblem(cause)
      if (problem.code === 'REVISION_CONFLICT') {
        preferencesRequest = null
        preferencesDirty = true
        preferenceSync.value = 'conflict'
      } else if (problem.status === 401 || problem.code === 'UNAUTHORIZED' || problem.status === 403 || problem.status === 404) {
        preferencesRequest = null
        preferencesDirty = false
        preferenceSync.value = 'error'
        await handleFailure(cause, scope)
      } else if (problem.retryable || problem.status === 0 || problem.status >= 500) {
        preferenceSync.value = 'unsynced'
      } else {
        // 编号冲突不得通过换编号绕过；其他明确拒绝可在用户更改选择后重新提交。
        if (problem.code !== 'IDEMPOTENCY_CONFLICT') preferencesRequest = null
        preferencesDirty = true
        preferenceSync.value = 'error'
      }
    } finally {
      if (current()) {
        preferencesRunning = false
        if (preferencesDirty && preferenceSync.value === 'synced') queuePreferences()
      }
    }
  }
  function queuePreferences() {
    // 合并当前工作区的最新选择；不改写待确认原请求，也不自动越过冲突或不确定状态。
    preferencesDirty = true
    preferenceChanges++
    if (preferenceSync.value === 'error' && !preferencesRequest) preferenceSync.value = 'synced'
    clearTimeout(preferenceTimer)
    preferenceTimer = setTimeout(() => {
      // 在连续偏好变动暂歇后启动保存，由保存流程处理失败。
      void persistPreferences()
    }, 250)
  }
  async function retryPreferences(): Promise<void> {
    // 由用户重试保留的完整原请求；仅在先前明确拒绝且可重建时，用当前选择建立新请求。
    if (preferencesRunning || !workspace.value || !['unsynced', 'error'].includes(preferenceSync.value)) return
    preferenceSync.value = 'synced'
    await persistPreferences()
  }
  async function restorePreferences(
    /* 用户明确采用或首次进入工作区时读取的服务器偏好。 */ next: Preferences,
  ): Promise<void> {
    // 恢复仍可访问的标签页与节点选择，内部打开图不再次写回偏好。
    openMapIds.value = next.openMapIds.filter(
      /* 服务器偏好保存的图身份。 */ id => /* 排除已经失去访问权或删除的图。 */ mapList.value.some(
        /* 当前工作区可访问的图摘要。 */ map => /* 只恢复可访问列表中的同一张图。 */ map.id === id,
      ),
    )
    selections = { ...next.nodeSelection }
    if (next.currentMapId && openMapIds.value.includes(next.currentMapId)) await openMap(next.currentMapId, false)
    else {
      stopView()
      activeMapId.value = null
      snapshot.value = null
      selectedId.value = null
      loading.value = false
    }
  }
  async function resolvePreferencesConflict(
    /* server 明确采用服务器选择；local 用新版本保存本窗口当前选择。 */ choice: 'server' | 'local',
  ): Promise<void> {
    // 冲突后重新读取偏好基线，由用户决定恢复远端选择或提交当前本地选择。
    if (preferencesRunning || preferenceSync.value !== 'conflict' || !workspace.value) return
    const scope = sessionEpoch, epoch = preferenceEpoch, workspaceId = workspace.value.id
    const changes = preferenceChanges
    const current = () => /* 读取结果与后续清理都只属于发起选择的工作区代次。 */
      scope === sessionEpoch && epoch === preferenceEpoch && workspace.value?.id === workspaceId
    preferencesRunning = true
    preferenceSync.value = 'saving'
    try {
      const next = await gateway.read('workspace.get', { workspaceId }, sessionController.signal)
      const live = workspace.value
      if (!current() || !live) return
      if (next.id !== workspaceId || next.preferences.workspaceId !== workspaceId) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_WORKSPACE)
      const preferences = next.preferences.revision >= live.preferences.revision ? next.preferences : live.preferences
      workspace.value = { ...live, preferences }
      if (choice === 'server') {
        // 读取期间若用户继续操作，保留新选择，待其再次明确采用服务器设置。
        if (changes !== preferenceChanges) { preferenceSync.value = 'conflict'; return }
        preferencesDirty = false
        await restorePreferences(preferences)
      } else preferencesDirty = true
      if (current()) preferenceSync.value = 'synced'
    } catch (cause) {
      if (!current()) return
      preferenceSync.value = 'conflict'
      const problem = sessionReadProblem(cause)
      if (problem.status === 401 || problem.code === 'UNAUTHORIZED' || problem.status === 403 || problem.status === 404) {
        await handleFailure(cause, scope)
      }
    } finally {
      if (current()) preferencesRunning = false
    }
    if (current() && preferenceSync.value === 'synced' && preferencesDirty) await persistPreferences()
  }
  /**
   * @param grant 当前选中分支 grant。
   */
  function sessionReadLeaseProof(
    /* 需要用于本次写入的确认授权，缺省读取当前选中分支。 */ grant = selectedBranchGrant.value,
  ): GraphBranchLeaseProof | null {
    // 写入前同步核对期限，后台节流或长任务延迟到期回调也不能继续提交旧证明。
    if (!grant) return null
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      if (selectedBranchGrant.value === grant) clearBranchGrant()
      return null
    }
    return { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
  }

  function clearBranchGrant(): void {
    // 本会话只保留一份私有编辑授权，失权与主动释放都结束其续租和到期计时。
    selectedBranchGrant.value = null
    clearTimeout(branchRenewTimer); branchRenewTimer = undefined
    clearTimeout(branchExpiryTimer); branchExpiryTimer = undefined
  }

  function invalidateBranchClaim(): void {
    // 新选择或释放意图使旧领取结果失效；只取消该任务拥有的忙碌状态。
    branchClaimRequest++
    if (branchClaimBusyRequest !== null) {
      branchClaimBusyRequest.end()
      branchClaimBusyRequest = null
      busy.value = false
    }
  }

  function reconcileBranchGrant(
    /* 真实快照携带的占用事实；不能据它重建已经清除的私有授权。 */ next: GraphSnapshot,
  ): void {
    // 相等版本也能反映真实到期；更旧的缺失项不能撤销已确认的新 grant。
    const grant = selectedBranchGrant.value
    if (!grant || next.ownershipRevision < grant.ownershipRevision) return
    const ownership = next.ownerships.find((/* 当前快照中的公开分支占用。 */ item): item is Extract<GraphBranchOwnership, { kind: 'editor' }> =>
      /* 只有同一种类、身份、持有者与 fence 才能确认当前授权。 */ item.kind === 'editor'
      && item.leaseId === grant.leaseId && item.holderId === grant.holderId && item.fence === grant.fence)
    if (!ownership || Date.parse(ownership.expiresAt) <= Date.now()) {
      clearBranchGrant()
      return
    }
    if (ownership.expiresAt !== grant.expiresAt) {
      // SSE 可能先于续租 HTTP 确认新期限；仅无关 O 增长不重排本租约，避免续租饥饿。
      const confirmed: GraphBranchGrant = { ...grant, expiresAt: ownership.expiresAt,
        leaseMs: ownership.leaseMs, ownershipRevision: next.ownershipRevision }
      selectedBranchGrant.value = confirmed
      scheduleBranchRenewal(confirmed)
    }
  }
  /**
   * @param grant 刚领取或续租成功的 editor grant。
   */
  function scheduleBranchRenewal(
    /* 刚由命令或匹配 SSE 确认的授权对象，其身份代表本次确认代次。 */ grant: GraphBranchGrant,
  ): void {
    // 续租在途不延长期限；两个定时器都只作用于仍为当前确认的对象。
    clearTimeout(branchRenewTimer)
    clearTimeout(branchExpiryTimer)
    const remainingMs = Date.parse(grant.expiresAt) - Date.now()
    if (remainingMs <= 0) {
      if (selectedBranchGrant.value === grant) clearBranchGrant()
      return
    }
    const expire = (): void => {
      // 旧确认的回调不能撤销新期限；长计时或时钟变化时按当前绝对截止时间复核。
      if (selectedBranchGrant.value !== grant) return
      const remaining = Date.parse(grant.expiresAt) - Date.now()
      if (remaining > 0) {
        branchExpiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
      } else clearBranchGrant()
    }
    branchExpiryTimer = setTimeout(expire, Math.min(remainingMs, 2_147_483_647))
    branchRenewTimer = setTimeout(() => {
      // 只有仍有效的确认才能发起续租，过期由独立截止计时结束编辑。
      void renewBranch(grant)
    }, Math.min(Math.max(0, Math.floor(remainingMs / 3)), Math.max(250, Math.floor(grant.leaseMs / 3))))
  }
  /**
   * @param expected 调度时捕获的 grant，迟到响应不得复活已替换授权。
   */
  async function renewBranch(
    /* 发起续租时的确认对象，之后任何新确认都会使其成功或失败失效。 */ expected: GraphBranchGrant,
  ): Promise<void> {
    // 对象身份同时隔离同 lease/fence 的再次领取与 SSE 提前确认，避免旧失败清新授权。
    if (selectedBranchGrant.value !== expected || !activeMapId.value || !sessionReadLeaseProof(expected)) return
    try {
      const result = await gateway.dispatch(crypto.randomUUID(), 'branch.renew', { mapId: activeMapId.value,
        lease: { leaseId: expected.leaseId, holderId: expected.holderId, fence: expected.fence } }, sessionController.signal)
      if (selectedBranchGrant.value !== expected) return
      selectedBranchGrant.value = result.data
      scheduleBranchRenewal(result.data)
      if (snapshot.value) reconcileBranchGrant(snapshot.value)
    } catch (cause) {
      if (selectedBranchGrant.value === expected) {
        clearBranchGrant()
        error.value = sessionReadProblem(cause)
      }
    }
  }
  /**
   * @param rootIds 可选多根；省略时领取当前选择。
   */
  async function claimBranch(
    /* 本次领取的根集合，默认取当前所选分支；发出请求前复制以隔离后续选择。 */ rootIds = selectedBranch.value?.scope.rootIds ?? [],
  ): Promise<boolean> {
    // 领取结果属于发起时的会话、视图和选择意图，不能写入后来选择的节点。
    if (!clientLeasesRequired.value) return canEdit.value
    const mapId = activeMapId.value
    if (!mapId || !canEdit.value || !rootIds.length || busy.value) return false
    const scope = sessionEpoch, epoch = viewEpoch, selection = selectionEpoch, selected = selectedId.value
    const roots = [...rootIds]
    const proof = selectedBranch.value
    const requestedNodes = proof && proof.scope.rootIds.length === roots.length
      && proof.scope.rootIds.every((/* 当前公开证明覆盖的根。 */ id) => /* 只使用同一请求根的已知闭包。 */ roots.includes(id))
      ? proof.scope.nodeIds : null
    if (sessionReadLeaseProof() && selectedBranchGrant.value && selectedBranchGrant.value.rootIds.length === roots.length
      && selectedBranchGrant.value.rootIds.every((/* 已确认授权中的根。 */ id) => /* 比较复制后的请求根集合。 */ roots.includes(id))) return true
    const request = ++branchClaimRequest
    const isCurrent = (): boolean => /* 只有当前请求可更新授权、错误与该领取任务的忙碌状态。 */
      scope === sessionEpoch && epoch === viewEpoch && selection === selectionEpoch && selected === selectedId.value
      && activeMapId.value === mapId && request === branchClaimRequest
    let end = (): void => { /* Promise 构造时同步交接本意图的完成入口。 */ }
    const ended = new Promise<void>((/* 当前意图完成或被新选择取代时解除等待。 */ resolve) => {
      // 控制的是本地意图交接，不取消或假定回滚已提交的后端请求。
      end = resolve
    })
    const intent: BranchClaimIntent = { request, mapId, rootIds: roots, ended, end }
    branchClaimBusyRequest = intent
    busy.value = true; error.value = null
    try {
      // 在旧 release 的整个等待期间占有 busy；旧调用不能恢复后抢走新的选择意图。
      const previous = selectedBranchGrant.value
      if (previous) {
        clearBranchGrant()
        await releaseUnusedBranchGrant(mapId, previous, scope)
      }
      const releasing = [...branchReleases].filter((/* 当前仍在途的精确释放请求。 */ item) =>
        /* 独立分支不被旧响应阻塞；未知闭包仍保守等待同图释放。 */ item.scope === scope && item.mapId === mapId
        && (!requestedNodes || requestedNodes.some((/* 该次领取已知闭包中的节点。 */ id) => /* 只有重叠才可能复用或争用旧授权。 */ item.nodeIds.includes(id))))
      await Promise.all(releasing.map((/* 该意图之前已经发出的释放。 */ item) => /* 明确旧释放结束后再重领。 */ item.finished))
      if (!isCurrent()) return false
      const result = await gateway.dispatch(crypto.randomUUID(), 'branch.claim', { mapId, rootIds: roots, holderId: editorHolderId }, sessionController.signal)
      if (!isCurrent()) {
        if (result.data.status === 'claimed') await releaseUnusedBranchGrant(mapId, result.data.grant, scope)
        return false
      }
      if (result.data.status === 'busy') {
        error.value = { code: 'BRANCH_BUSY', message: RuntimeMessage.BRANCH_IS_CURRENTLY_OWNED_BY_ANOTHER_CLIENT,
          status: 409, retryable: false, errorId: crypto.randomUUID() }
        return false
      }
      selectedBranchGrant.value = result.data.grant
      if (!snapshot.value || !acceptSelectedBranch(result.data.grant.branch, snapshot.value)) {
        // 授权可真实有效，但内容已变化时不能用旧 payload 配新 proof 开放编辑。
        selectedBranchBaseline = null
        selectedBranch.value = null
        void refreshSelectedBranch()
      }
      scheduleBranchRenewal(result.data.grant)
      if (snapshot.value) reconcileBranchGrant(snapshot.value)
      return sessionReadLeaseProof() !== null
    } catch (cause) {
      if (isCurrent()) await handleFailure(cause, scope, epoch)
      return false
    } finally {
      intent.end()
      if (branchClaimBusyRequest === intent) {
        branchClaimBusyRequest = null
        if (scope === sessionEpoch) busy.value = false
      }
    }
  }
  async function releaseBranch(): Promise<void> {
    // 主动释放同时取消尚在途的领取意图，不影响其他命令持有的 busy。
    invalidateBranchClaim()
    const grant = selectedBranchGrant.value, mapId = activeMapId.value
    clearBranchGrant()
    if (!grant || !mapId) return
    await releaseUnusedBranchGrant(mapId, grant, sessionEpoch)
  }

  async function releaseUnusedBranchGrant(
    /* 这份授权最初取得时的原图身份，不读取后来切换的当前图。 */ mapId: string,
    /* 原始确认中的 lease 证明，只有不再被新意图使用时才释放。 */ grant: GraphBranchGrant,
    /* 发起该授权操作时的连接/登录代次，禁止向后来连接发送旧清理。 */ scope: number,
  ): Promise<void> {
    // 同 holder 重领可以复用 lease/fence；旧 ack 的清理不能删除新确认或仍在途的同根领取。
    while (scope === sessionEpoch) {
      const current = selectedBranchGrant.value
      if (activeMapId.value === mapId && current && current.leaseId === grant.leaseId
        && current.holderId === grant.holderId && current.fence === grant.fence) return
      const pending = branchClaimBusyRequest
      if (pending?.mapId === mapId && pending.rootIds.length === grant.rootIds.length
        && pending.rootIds.every((/* 当前新意图所需的分支根。 */ id) => /* 同根领取可能合法复用这份授权身份。 */ grant.rootIds.includes(id))) {
        await pending.ended
        continue
      }
      const finished = gateway.dispatch(crypto.randomUUID(), 'branch.release', { mapId,
        lease: { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence } }, sessionController.signal).then(
        () => { /* 真实释放已经得到确认。 */ },
        () => {
          // 请求结束不证明释放已提交；新 holder 遇旧活跃占用应只读，不能复用后再被旧释放撤销。
          if (scope === sessionEpoch && editorHolderId === grant.holderId) editorHolderId = crypto.randomUUID()
        },
      )
      const release = { scope, mapId, nodeIds: [...grant.scope.nodeIds], finished }
      branchReleases.add(release)
      try { await finished } finally { branchReleases.delete(release) }
      return
    }
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
    if (selectedRunControl.value !== expected || !activeMapId.value) return
    try {
      const result = await gateway.dispatch(crypto.randomUUID(), 'run.control.renew', { mapId: activeMapId.value, runId: expected.runId,
        control: { leaseId: expected.leaseId, holderId: expected.holderId, fence: expected.fence } }, sessionController.signal)
      if (selectedRunControl.value !== expected) return
      selectedRunControl.value = result.data
      scheduleRunControlRenewal(result.data)
    } catch (cause) {
      if (selectedRunControl.value === expected) {
        selectedRunControl.value = null; clearTimeout(runControlRenewTimer)
        error.value = sessionReadProblem(cause)
      }
    }
  }
  function finishRunControlClaim(/* 已完成或已被新选择取消的领取意图。 */ intent: RunControlClaimIntent): void {
    // 仅当前领取所有者归还busy，旧任务完成不能结束下一份领取。
    intent.end()
    if (runControlClaim === intent) {
      runControlClaim = null
      busy.value = false
    }
  }
  async function releaseUnusedRunControl(
    /* 取得授权时的原图，不借用后来视图。 */ mapId: string,
    /* 仅在不被新确认或在途同Run意图复用时释放的完整授权。 */ grant: GraphRunControlGrant,
    /* 原连接/身份代次，跨服务后不发送旧释放。 */ scope: number,
  ): Promise<void> {
    // 同holder同Run可能复用lease/fence；等待新的同Run领取明确后再决定旧授权清理。
    while (scope === sessionEpoch) {
      const current = selectedRunControl.value
      if (activeMapId.value === mapId && current && current.leaseId === grant.leaseId
        && current.holderId === grant.holderId && current.fence === grant.fence) return
      const pending = runControlClaim
      if (pending?.mapId === mapId && pending.runId === grant.runId) {
        await pending.ended
        continue
      }
      const finished = gateway.dispatch(crypto.randomUUID(), 'run.control.release', { mapId, runId: grant.runId,
        control: { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence } }, sessionController.signal).then(
        () => { /* 该份控制权释放已经得到确认。 */ },
        () => {
          // 释放结果未知时，新领取改用holder，避免晚提交撤销后来复用的同一租约。
          if (scope === sessionEpoch && runControlHolderId === grant.holderId) runControlHolderId = crypto.randomUUID()
        },
      )
      const release = { mapId, runId: grant.runId, scope, finished }
      runControlReleases.add(release)
      try { await finished } finally { runControlReleases.delete(release) }
      return
    }
  }
  async function claimRunControl(
    /* 本次动作的目标Run，缺省使用当前选择；后续选择不改写本意图。 */ runId = selectedRun.value?.id,
  ): Promise<boolean> {
    // 授权和busy只归当前会话、视图及选择意图；同Run再次选择也不能恢复旧点击。
    if (!clientLeasesRequired.value) return canEdit.value
    const mapId = activeMapId.value
    if (!mapId || !runId || !canEdit.value || busy.value) return false
    if (selectedRunControl.value?.runId === runId) return true
    const scope = sessionEpoch, epoch = viewEpoch, selection = runSelectionEpoch, selected = selectedRunId.value
    const completion = new AbortController()
    const ended = new Promise<void>((/* 解除迟到授权对本次领取的等待。 */ resolve) => {
      // 本地意图完成只解除交接等待，不取消HTTP或假定后端提交已经回滚。
      completion.signal.addEventListener('abort', () => { /* 意图结束后释放唯一完成监听。 */ resolve() }, { once: true })
    })
    const intent: RunControlClaimIntent = { mapId, runId, ended,
      end(): void { /* 成功、选择取消与finally都可幂等结束本地意图。 */ completion.abort() },
    }
    const isCurrent = (): boolean => /* 只有原选择与请求所有者仍有效时才接纳结果。 */
      scope === sessionEpoch && epoch === viewEpoch && selection === runSelectionEpoch && selected === selectedRunId.value
      && activeMapId.value === mapId && runControlClaim === intent && canEdit.value
    runControlClaim = intent
    busy.value = true
    error.value = null
    try {
      const previous = selectedRunControl.value
      selectedRunControl.value = null
      clearTimeout(runControlRenewTimer)
      if (previous) await releaseUnusedRunControl(mapId, previous, scope)
      await Promise.all([...runControlReleases].filter((/* 同连接仍在途的控制权释放。 */ release) =>
        /* 同Run必须等释放明确，其他Run不阻塞当前选择。 */ release.scope === scope && release.mapId === mapId && release.runId === runId)
        .map((/* 该Run先前已经发送的释放。 */ release) => /* 领取不能复用仍可能被撤销的旧lease。 */ release.finished))
      if (!isCurrent()) return false
      const result = await gateway.dispatch(crypto.randomUUID(), 'run.control.claim', { mapId, runId, holderId: runControlHolderId }, sessionController.signal)
      if (!isCurrent()) {
        finishRunControlClaim(intent)
        if (result.data.status === 'claimed') await releaseUnusedRunControl(mapId, result.data.grant, scope)
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
    } catch (cause) {
      if (isCurrent()) await handleFailure(cause, scope, epoch)
      return false
    } finally {
      finishRunControlClaim(intent)
    }
  }
  async function releaseRunControl(): Promise<void> {
    // 离开选择先结束本地领取所有权；已有控制权沿原身份有界交回，不接纳旧清理错误。
    if (runControlClaim) finishRunControlClaim(runControlClaim)
    const control = selectedRunControl.value, mapId = activeMapId.value
    clearTimeout(runControlRenewTimer)
    runControlRenewTimer = undefined
    selectedRunControl.value = null
    if (control && mapId) await releaseUnusedRunControl(mapId, control, sessionEpoch)
  }
  /**
   * @param runId 用户在同图多个 Run 中选择查看和控制的身份。
   */
  async function selectRun(/* 用户最后明确选择的图内运行，null表示清空。 */ runId: string | null): Promise<void> {
    // 选择意图在等待旧释放前同步交接，迟到释放结束后不再覆盖后来选择。
    const changed = runId !== selectedRunId.value
    if (changed) runSelectionEpoch++
    selectedRunId.value = runId && snapshot.value?.runs.some((/* 当前Map中的真实运行。 */ run) =>
      /* 无效身份只清空选择，不借其他Map的Run。 */ run.id === runId) ? runId : null
    if (changed) await releaseRunControl()
  }
  /**
   * 仅选中当前快照中存在的节点，记住该图的选择并安排保存偏好。
   *
   * @param id 用户选择的真实节点身份；null 清空选择，不在当前快照中的身份也归为空。
   */
  function selectNode(/* 用户选择的图内节点身份；不存在时清空选择。 */ id: string | null) {
    // 同图 A→B→A 也是新意图，旧 claim 不能因节点身份又相同而恢复写入权。
    const next = id && snapshot.value?.nodes.some((/* 当前图中实际存在的节点。 */ node) => /* 只允许图内身份。 */ node.id === id) ? id : null
    if (selectedId.value !== next) { selectionEpoch++; void releaseBranch() }
    selectedId.value = next
    selectedBranch.value = null; selectedBranchBaseline = null; branchRead++; branchLoading.value = false
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
    /* 当前工作区中要打开的可访问图身份。 */ id: string,
    /* 用户切图时同步标记选择意图；恢复服务器偏好时为 false。 */ persist = true
  ) {
    // 立即建立用户切图意图，再读取和订阅目标图，避免较慢读取让旧偏好恢复覆盖新选择。
    if (!workspace.value || !mapList.value.some(map => /* 确认目标图在当前工作区的可访问列表中。 */ map.id === id)) return
    if (persist) preferenceChanges++
    stopView()
    const epoch = viewEpoch
    activeMapId.value = id; snapshot.value = null; activities.value = []; selectedId.value = selections[id] ?? null; selectedBranch.value = null; selectedRunId.value = null
    if (!openMapIds.value.includes(id)) openMapIds.value.push(id)
    loading.value = true
    if (retryCommand?.workspaceEpoch !== preferenceEpoch) {
      error.value = null
      retryCommand = null
      canRetry.value = false
    }
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
  async function closeMap(/* 用户明确关闭的图标签身份。 */ id: string) {
    // 同步标记关页意图，关闭当前图时恢复剩余标签，再安排保存最新偏好。
    preferenceChanges++
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
  async function selectWorkspace(/* 用户明确进入的目标工作区身份。 */ id: string) {
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
      await restorePreferences(next.preferences)
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
  async function registerUsername(
    /* 当前目标服务和无需邮箱的账户注册资料。 */ input: Parameters<ClientAccountGateway['registerUsername']>[0],
  ): Promise<boolean> {
    // 注册成功后复用原工作区加载，不在注册表单复制会话接纳逻辑。
    const account = gateway.account
    return connectAccount(() => /* 只接受当前网关提供的固定用户名注册动作。 */ account ? account.registerUsername(input) : rejectAccount())
  }
  async function loginUsername(
    /* 当前目标服务、用户名密码及记住登录意愿。 */ input: Parameters<ClientAccountGateway['loginUsername']>[0],
  ): Promise<boolean> {
    // 与邮箱登录共享失败保留旧图和迟到结果隔离。
    const account = gateway.account
    return connectAccount(() => /* 缺少可选能力时返回受控提示。 */ account ? account.loginUsername(input) : rejectAccount())
  }
  async function login(
    /* 用户当前选择的服务、邮箱、密码与记住意愿。 */ input: Parameters<ClientAccountGateway['login']>[0],
  ): Promise<boolean> {
    // 认证失败保留已有图和授权，成功后才交给原会话接纳流程。
    const account = gateway.account
    return connectAccount(() => /* 缺少可选能力时交付统一的受控提示。 */ account ? account.login(input) : rejectAccount())
  }
  async function verifyEmail(
    /* 当前待验证邮箱、一次性代码、服务和记住意愿。 */ input: Parameters<ClientAccountGateway['verifyEmail']>[0],
  ): Promise<boolean> {
    // 邮箱验证成功也建立正常会话，不在表单内复制工作区加载与订阅逻辑。
    const account = gateway.account
    return connectAccount(() => /* 仅使用已装配的账户能力，不尝试旧服务未知命令。 */ account ? account.verifyEmail(input) : rejectAccount())
  }
  async function rejectAccount(): Promise<never> {
    // 旧网关提供明确能力提示，不因访问不存在的方法产生页面异常。
    throw new ClientError({ status: 0, code: 'ACCOUNT_UNAVAILABLE', message: AccountUiMessage.UNAVAILABLE, retryable: false })
  }
  async function connectAccount(
    /* 仅验证新账户且成功后返回已激活连接的启动信息。 */ authenticate: () => Promise<AppBootstrap>,
  ): Promise<boolean> {
    // 先验证再清理旧身份；退出或其它连接改变代次后丢弃这次迟到结果。
    if (connecting.value || initializing.value) return false
    const scope = sessionEpoch
    connecting.value = true; error.value = null
    try {
      const value = await authenticate()
      if (scope !== sessionEpoch) return false
      await connectSession(() => /* 既有流程只接纳已经认证成功的同一份结果。 */ Promise.resolve(value))
      return bootstrap.value === value
    } catch (cause) {
      if (scope === sessionEpoch) error.value = sessionReadProblem(cause)
      return false
    } finally { if (scope === sessionEpoch) connecting.value = false }
  }
  async function changePassword(
    /* 当前账户原密码、新密码和凭据记住意愿。 */ input: Parameters<ClientAccountGateway['changePassword']>[0],
  ): Promise<boolean> {
    // 同一身份原地轮换账户凭据，保留当前图、分支授权和所有编辑草稿。
    if (connecting.value || initializing.value) return false
    const account = gateway.account, scope = sessionEpoch
    connecting.value = true; error.value = null
    try {
      const value = account ? await account.changePassword(input) : await rejectAccount()
      const info = await gateway.getConnection()
      if (scope !== sessionEpoch) return false
      bootstrap.value = value; connection.value = info
      return true
    } catch (cause) {
      if (scope === sessionEpoch) error.value = sessionReadProblem(cause)
      return false
    } finally { if (scope === sessionEpoch) connecting.value = false }
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
    /* 本次公开写命令，决定参数和确认结果的类型。 */ method: K,
    /* 发送前复制的用户意图，重试沿用副本。 */ params: CommandInputMap[K],
    /* 原请求及其所有重试共用的幂等编号。 */ requestId = crypto.randomUUID(),
    /* 该动作成功后及原请求重放后共用的界面更新，不另建重试队列。 */
    afterSuccess?: (/* 已由网关验证的本次正式写入确认。 */ result: GraphSuccess<CommandOutputMap[K]>) => Promise<void>,
  ): Promise<GraphSuccess<CommandOutputMap[K]> | null> {
    // 保留同一次命令与确认动作；图管理归工作区，删除导致当前图退出也不丢失在途确认。
    if (busy.value) return null
    // 固定本次提交内容，用户随后编辑草稿时，重试仍能复用原 requestId 和原始参数。
    const payload = JSON.parse(JSON.stringify(params)) as CommandInputMap[K]
    const scope = sessionEpoch, epoch = viewEpoch, workspaceEpoch = preferenceEpoch
    const mapAction = method === 'map.rename' || method === 'map.delete'
    const current = () => /* 普通命令保持原视图隔离，图管理结果只在原工作区代次内接纳。 */
      scope === sessionEpoch && (mapAction ? workspaceEpoch === preferenceEpoch : epoch === viewEpoch)
    busy.value = true; error.value = null; canRetry.value = false; retryCommand = null
    try {
      const result = await gateway.dispatch(requestId, method, payload, sessionController.signal)
      if (!current()) return null
      if (afterSuccess) await afterSuccess(result)
      if (!current()) return null
      return result
    } catch (cause) {
      if (current()) {
        const problem = sessionReadProblem(cause)
        if (problem.retryable) {
          canRetry.value = true
          retryCommand = { workspaceEpoch: mapAction ? workspaceEpoch : undefined, run: async () => {
            // 在原命令归属内重放编号与冻结参数，成功后复用接纳动作或刷新既有创建流程。
            if (!current()) return null
            const result = await submit(method, payload, requestId, afterSuccess)
            if (result && !afterSuccess) {
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
          } }
        }
        await handleFailure(cause, scope, mapAction ? undefined : epoch)
        if (current() && problem.status === 409) { await refresh(); await refreshWorkspace() }
      }
      return null
    } finally { if (scope === sessionEpoch && workspaceEpoch === preferenceEpoch) busy.value = false }
  }
  async function retry(): Promise<boolean> {
    // 执行仍保留的命令重试，并返回这次提交是否取得成功结果。
    return retryCommand ? !!await retryCommand.run() : false
  }
  /**
   * 按用户选择建立工作区初始配置，刷新列表，并在视图未切换时进入新工作区。
   *
   * @param name 新工作区展示名称，由界面提供，最终约束由服务端校验。
   * @param description 新工作区说明，默认空字符串。
   * @param agentSource 初始智能体策略，省略时保持复制共享库。
   */
  async function createWorkspace(
    /* 新工作区的展示名称，最终约束由服务端校验。 */ name: string,
    /* 用户明确填写的说明，不借用当前工作区信息。 */ description = '',
    /* 保留旧字符串调用的共享库默认值，也允许显式空配置。 */
    agentSource: CommandInputMap['workspace.create']['agentSource'] = 'library',
  ): Promise<boolean> {
    // 待确认写入仍归原requestId；新创建意图不能清掉其参数或错误状态。
    if (busy.value || canRetry.value) return false
    const epoch = viewEpoch, scope = sessionEpoch
    const result = await submit('workspace.create', { id: crypto.randomUUID(), name, description, agentSource })
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
  async function renameMap(
    /* 用户为当前数据图填写的名称；服务端仍负责权威名称校验。 */ name: string,
  ): Promise<boolean> {
    // 改名只更新当前图元数据，重放成功也复用同一接纳与目录刷新动作。
    const target = snapshot.value
    if (!target || !canRenameMap.value || busy.value) return false
    return !!await submit('map.rename', { mapId: target.mapId, expectedRevision: target.revision, name }, crypto.randomUUID(), async (
      /* 原改名请求取得的正式图快照。 */ result,
    ) => {
      // 当前仍阅读该图时接纳名称和版本；目录刷新不改变另一张图的选择。
      if (activeMapId.value === target.mapId) applySnapshot(result.data.snapshot, viewEpoch)
      await refreshWorkspace()
    })
  }
  async function deleteMap(): Promise<boolean> {
    // 确认删除后才清理标签和偏好；订阅先得知删除时仍能接纳同工作区的原请求确认。
    const target = snapshot.value
    if (!target || !canEdit.value || busy.value) return false
    const workspaceEpoch = preferenceEpoch
    return !!await submit('map.delete', { mapId: target.mapId, expectedRevision: target.revision }, crypto.randomUUID(), async () => {
      // 只移除已确认的目标图；已有其他标签继续使用，迟到清理不跨工作区。
      mapList.value = mapList.value.filter(
        /* 仍在当前工作区目录中的图。 */ item => /* 保留其他图的身份与摘要。 */ item.id !== target.mapId,
      )
      if (error.value?.code === 'MAP_NOT_FOUND') error.value = null
      await closeMap(target.mapId)
      if (workspaceEpoch !== preferenceEpoch) return
      const next = openMapIds.value[openMapIds.value.length - 1]
      if (!activeMapId.value && next) await openMap(next, false)
      if (workspaceEpoch === preferenceEpoch) await refreshWorkspace()
    })
  }
  /**
   * 按分支版本提交局部变化；同图其他分支的提交不会使这份证明失效。
   *
   * @param branch 编辑草稿所依据的分支根和稳定内容版本。
   * @param changes 要提交的节点、边或图属性差量，不直接修改本地已保存快照。
   * @param lease 已有分支必须携带的 editor 租约；新根省略。
   */
  async function applyChanges(
    /* 草稿建立时捕获的原分支证明，不能自动提升到服务器新版本。 */ branch: GraphBranchProof,
    /* 本次局部变化，提交后不再读取调用方的可变草稿。 */ changes: Extract<GraphCommand, { method: 'graph.apply' }>['params']['changes'],
    /* 协作场景已有的有效授权，本机和独立新根省略。 */ lease?: GraphBranchLeaseProof,
  ): Promise<boolean> {
    // 同次写响应的正文与证明一并接纳，选择变化或更新快照不能被旧候选覆盖。
    if (!snapshot.value || !canEdit.value) return false
    const epoch = viewEpoch, selection = selectionEpoch, selected = selectedId.value
    const result = await submit('graph.apply', { mapId: snapshot.value.mapId, branch, ...(lease ? { lease } : {}), changes })
    if (!result) return false
    const candidate = epoch === viewEpoch && selection === selectionEpoch && selected === selectedId.value ? result.data.branch : undefined
    applySnapshot(result.data.snapshot, epoch, candidate)
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
  async function createChildNode(
    /* 对话框捕获的原父身份、版本、精确后继类型及正文。 */ input: ChildNodeInput,
  ): Promise<boolean> {
    // 只在合法旧父下原子创建节点与后继，不能用独立新根的null证明跳过父分支授权。
    if (!snapshot.value || snapshot.value.mapId !== input.mapId || busy.value || canRetry.value || !canEdit.value) return false
    const parent = snapshot.value.nodes.find((/* 当前图中的真实节点。 */ node) => /* 不接受其他图的父身份。 */ node.id === input.parentId)
    const parentType = parent ? payloadFindType(catalog.value, parent) : undefined
    const childType = catalog.value?.dataTypes.find((/* 当前工作区已发布的类型。 */ type) => /* 精确匹配指定后继版本。 */ type.id === input.childType.id && type.version === input.childType.version)
    if (!parent || parent.revision !== input.expectedParentRevision) {
      error.value = sessionReadProblem(new ClientError({ status: 409, code: 'REVISION_CONFLICT', retryable: false, message: RuntimeMessage.BRANCH_VERSION_CHANGED }))
      return false
    }
    if (!childType || !parentType?.successorTypes.some((/* 父类型许可的精确后继。 */ type) => /* 不接受同名其他版本。 */ type.id === childType.id && type.version === childType.version)) {
      error.value = sessionReadProblem(new ClientError({ status: 422, code: 'INVALID_SUCCESSOR', retryable: false, message: NodeEditMessage.INVALID_SUCCESSOR }))
      return false
    }
    const references = sessionReadReferenceTargets(childType, input.payload)
    if (!referencesAreValid(references)) return false
    const id = crypto.randomUUID(), edgeId = crypto.randomUUID()
    return submitScopedChanges({ mapId: input.mapId, nodeRevisions: revisionsFor([parent.id, ...references.map((/* 本次子正文声明的引用目标。 */ target) => /* 目标也必须获得必要授权。 */ target.id)]),
      selectId: id, changes: {
        nodes: { put: [{ id, typeId: childType.id, typeVersion: childType.version, payload: input.payload }] },
        edges: { put: [{ id: edgeId, kind: 'successor', from: parent.id, to: id,
          ...(input.sourceAnchors ? { sourceAnchors: input.sourceAnchors } : {}) }] },
      } })
  }
  function referencesAreValid(
    /* 已从实际类型声明和正文中取得的节点引用。 */ references: Array<{ id: string; types: DefinitionRef[] }>,
  ): boolean {
    // 新引用必须指向同图且精确类型允许的真实节点，后端继续校验数量与完整schema。
    const valid = references.every((/* 一个真实引用目标及其允许类型。 */ reference) => {
      // 不用显式reference边代替payload字段的业务含义。
      const node = snapshot.value?.nodes.find((/* 当前图中的真实节点。 */ item) => /* 只能引用当前图的身份。 */ item.id === reference.id)
      return !!node && reference.types.some((/* 字段允许的精确类型。 */ type) => /* 同ID不同版本仍不合法。 */ type.id === node.typeId && type.version === node.typeVersion)
    })
    if (!valid) error.value = sessionReadProblem(new ClientError({ status: 422, code: 'INVALID_REFERENCE', retryable: false, message: NodeEditMessage.INVALID_REFERENCE }))
    return valid
  }
  function revisionsFor(
    /* 本次写入实际涉及的现有节点，不含尚未出生的子节点。 */ ids: string[],
  ): Record<string, number> {
    // 捕获节点版本用于授权等待期间的冲突保护，已经移除的旧引用不扩大当前范围。
    const revisions: Record<string, number> = {}
    for (const id of ids) {
      const node = snapshot.value?.nodes.find((/* 当前图中的实际节点。 */ item) => /* 查找本次参与者。 */ item.id === id)
      if (node) revisions[id] = node.revision
    }
    return revisions
  }
  async function saveNodeReferences(
    /* 独立引用编辑固定原节点版本、声明数组路径及用户选择。 */ input: { mapId: string; nodeId: string; expectedNodeRevision: number; path: string; targetIds: string[] },
  ): Promise<boolean> {
    // 修改声明的payload数组，派生索引只接受服务端结果，不创建手工reference边。
    const node = snapshot.value?.nodes.find((/* 当前图中的实际节点。 */ item) => /* 锁定引用来源。 */ item.id === input.nodeId)
    const definition = node ? payloadFindType(catalog.value, node) : undefined
    if (!node || snapshot.value?.mapId !== input.mapId || node.revision !== input.expectedNodeRevision || !definition
      || !definition.references.some((/* 类型真实声明的引用。 */ reference) => /* 首版只将节点数组字段作为此明确意图入口。 */ reference.target.kind === 'node' && reference.path === `${input.path}/*`)) return false
    const payload = structuredClone(node.payload)
    const parts = input.path.slice(1).split('/').map((/* JSON Pointer的一段。 */ part) => /* 恢复字段原名称。 */ part.replace(/~1/g, '/').replace(/~0/g, '~'))
    let container: JsonValue | undefined = payload
    for (const part of parts.slice(0, -1)) {
      if (!container || typeof container !== 'object') return false
      container = Array.isArray(container) ? container[Number(part)] : Object.prototype.hasOwnProperty.call(container, part) ? container[part] : undefined
    }
    if (!container || typeof container !== 'object') return false
    Object.defineProperty(container, parts[parts.length - 1], { value: [...input.targetIds], enumerable: true, configurable: true, writable: true })
    return saveReferencedPayload(node, payload, {
      previous: sessionReadReferenceTargets(definition, node.payload), next: sessionReadReferenceTargets(definition, payload),
    })
  }
  async function saveNodeEvidence(
    /* 固定消费者图、节点原版本及用户明确保存的完整库引用；[]表示清空。 */
    input: { mapId: string; nodeId: string; expectedNodeRevision: number; refs: EvidenceUseRef[] },
  ): Promise<boolean> {
    // 只授权消费者并修改其库引用，保留正文和类型；共用提交器在等待前冻结完整差量。
    if (bootstrap.value?.metadata.capabilities?.evidenceLibrary !== true || !canEdit.value || busy.value || canRetry.value) return false
    const current = snapshot.value
    const node = current?.nodes.find((
      /* 当前图中的真实消费者。 */ item,
    ) => /* 不从库原图或原Claim取节点来扩张编辑范围。 */ item.id === input.nodeId)
    if (!current || current.mapId !== input.mapId || !node) return false
    const refs = input.refs.map((
      /* 原草稿里的一项固定引用和本次使用理由。 */ reference,
    ) => /* 解除可变表单引用，只保留允许写入的三个协议字段。 */
      ({ entryId: reference.entryId, contentDigest: reference.contentDigest, reason: reference.reason }))
    return submitScopedChanges({ mapId: input.mapId, nodeRevisions: { [node.id]: input.expectedNodeRevision },
      changes: { nodes: { put: [{ id: node.id, typeId: node.typeId, typeVersion: node.typeVersion,
        payload: node.payload, libraryClaimRefs: refs }] } } })
  }
  async function saveReferencedPayload(
    /* 当前图中仍匹配编辑基线的引用来源。 */ node: GraphNode,
    /* 包含本次引用变化及其余未丢失正文的完整草稿。 */ payload: GraphPayload,
    /* 本次保存已按精确定义展开一次的旧、新引用。 */ references: {
      previous: ReturnType<typeof sessionReadReferenceTargets>; next: ReturnType<typeof sessionReadReferenceTargets>
    },
  ): Promise<boolean> {
    // 联合授权覆盖来源及旧、新目标，保留正文与原有固定证据引用。
    if (!referencesAreValid(references.next) || !snapshot.value) return false
    const targets = [...references.previous, ...references.next]
    return submitScopedChanges({ mapId: snapshot.value.mapId, nodeRevisions: revisionsFor([node.id, ...targets.map((/* 旧或新声明引用。 */ target) => /* 这些节点共同参与授权。 */ target.id)]),
      changes: { nodes: { put: [{ id: node.id, typeId: node.typeId, typeVersion: node.typeVersion, payload }] } } })
  }
  /**
   * 按调用者开始编辑时取得的分支版本保存指定数据实例。
   *
   * @param input 包含节点身份、精确类型、payload 和草稿分支证明的保存请求。
   */
  async function saveNode(input: { branch: GraphBranchProof; nodeId: string; typeId: string; typeVersion: number; payload: GraphPayload }) {
    // 声明引用变化需要覆盖旧、新目标；先核对正文原证明，再建立联合范围，不能提升脏稿基线。
    const node = snapshot.value?.nodes.find((/* 当前图中的实际节点。 */ item) => /* 本次保存的来源身份。 */ item.id === input.nodeId)
    const definition = node ? payloadFindType(catalog.value, node) : undefined
    const references = node && definition ? {
      previous: sessionReadReferenceTargets(definition, node.payload), next: sessionReadReferenceTargets(definition, input.payload),
    } : null
    if (node && references && JSON.stringify(references.previous) !== JSON.stringify(references.next)) {
      if (!selectedBranch.value || selectedBranch.value.version !== input.branch.expectedVersion || selectedBranch.value.rootRevisions[node.id] !== node.revision) {
        error.value = sessionReadProblem(new ClientError({ status: 409, code: 'REVISION_CONFLICT', retryable: false, message: RuntimeMessage.BRANCH_VERSION_CHANGED }))
        return false
      }
      return saveReferencedPayload(node, input.payload, references)
    }
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
   * 在真实 successor 边上保存来源定位，固定边和来源版本，切图后的迟到结果不再提交。
   *
   * @param input 阅读页当前 Map、边版本与相对于来源 payload 的完整锚点列表；空列表清除标记。
   */
  async function saveSourceAnchors(/* 单页打开时固定的边版本与全部来源锚点。 */ input: {
    mapId: string; edgeId: string; expectedEdgeRevision: number; sourceAnchors: GraphSourceAnchor[]
  }): Promise<boolean> {
    // 保留历史锚点校验，再复用固定业务差量的联合授权和提交。
    if (!snapshot.value || snapshot.value.mapId !== input.mapId || activeMapId.value !== input.mapId || !canEdit.value || busy.value) return false
    const initial = snapshot.value
    const edge = initial.edges.find((/* 当前图中的实际关系。 */ item) => /* 只编辑用户打开的同一条来源边。 */ item.id === input.edgeId)
    const source = initial.nodes.find((/* 当前图中的真实节点。 */ node) => /* 定位脚注所指的上游原文。 */ node.id === edge?.from)
    const target = initial.nodes.find((/* 当前图中的真实节点。 */ node) => /* 定位引用原文的后继节点。 */ node.id === edge?.to)
    if (!edge || edge.kind !== 'successor' || !source || !target) return false
    const anchors = input.sourceAnchors.map((/* 用户已确认的单个定位。 */ anchor) => /* 请求持有独立副本。 */ ({ ...anchor }))
    const isOriginalAnchor = (/* 可能来自旧原文版本的定位。 */ anchor: GraphSourceAnchor) => /* 允许原样保留既有历史定位。 */ edge.sourceAnchors?.some(
      (/* 服务端既有的完整历史定位。 */ original) => /* 只允许逐字段完全保留历史摘录。 */
        original.path === anchor.path && original.sourceRevision === anchor.sourceRevision && original.startLine === anchor.startLine
      && original.endLine === anchor.endLine && original.quote === anchor.quote) === true
    if (edge.revision !== input.expectedEdgeRevision || anchors.some(
      (/* 本次待保存定位。 */ anchor) => /* 新定位必须绑定当前原文，既有历史摘录允许原样保留。 */ anchor.sourceRevision !== source.revision && !isOriginalAnchor(anchor),
    )) {
      error.value = sessionReadProblem(new ClientError({ status: 409, code: 'REVISION_CONFLICT', retryable: false, message: RuntimeMessage.BRANCH_VERSION_CHANGED }))
      return false
    }
    return submitScopedChanges({ mapId: input.mapId, nodeRevisions: { [source.id]: source.revision, [target.id]: target.revision },
      edgeRevisions: { [edge.id]: edge.revision }, changes: { edges: { put: [{ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to,
        ...(edge.label !== undefined ? { label: edge.label } : {}), sourceAnchors: anchors }] } } })
  }
  async function submitScopedChanges(
    /* 业务入口已构造的单次差量与现有参与者原版本。 */ input: ScopedChanges,
  ): Promise<boolean> {
    // 对固定业务差量统一取得证明和授权；临时授权finally释放，成功后才接纳快照与选择。
    if (!snapshot.value || snapshot.value.mapId !== input.mapId || activeMapId.value !== input.mapId || !canEdit.value || busy.value || canRetry.value) return false
    const changes = JSON.parse(JSON.stringify(input.changes)) as GraphChanges
    const initial = snapshot.value, endpointIds = Object.keys(input.nodeRevisions)
    const versions = { ...input.nodeRevisions }, edges = { ...input.edgeRevisions }
    const conflict = () => /* 原节点或边版本不再匹配时保留草稿并拒绝提升基线。 */
      new ClientError({ status: 409, code: 'REVISION_CONFLICT', retryable: false, message: RuntimeMessage.BRANCH_VERSION_CHANGED })
    const scope = sessionEpoch, epoch = viewEpoch, workspaceEpoch = preferenceEpoch, selection = selectionEpoch, mapId = input.mapId
    const current = () => /* 切图、工作区或身份后旧动作不能污染新页面。 */
      scope === sessionEpoch && epoch === viewEpoch && activeMapId.value === mapId && snapshot.value?.mapId === mapId
    const contentCurrent = () => /* 等待证明和授权期间逐项保持原业务基线。 */
      current() && canEdit.value && endpointIds.every((/* 本次实际参与的现有节点。 */ id) => /* 必须仍存在且内容版本匹配。 */ snapshot.value?.nodes.find((/* 最新真实节点。 */ node) => /* 以同图ID匹配。 */ node.id === id)?.revision === versions[id])
      && Object.entries(edges).every((/* 既有来源边及其原版本。 */ [id, revision]) => /* 新建结构边不要求预先存在。 */ snapshot.value?.edges.find((/* 最新真实边。 */ edge) => /* 校验原来源关系。 */ edge.id === id)?.revision === revision)
    const checkBranch = (/* 服务端返回的联合结构证明。 */ branch: GraphBranchSnapshot, /* 本次实际请求的根集合。 */ roots: string[]) => {
      // 只接纳覆盖参与者且与当前图配对的证明，不借新证明升级原节点版本。
      if (branch.scope.rootIds.length !== roots.length || roots.some((/* 原请求的根。 */ id) => /* 服务端不得替换范围。 */ !branch.scope.rootIds.includes(id))
        || endpointIds.some((/* 现有参与者。 */ id) => /* 全部必须在可写范围内。 */ !branch.scope.nodeIds.includes(id))
        || Object.keys(edges).some((/* 原来源后继边。 */ id) => /* 脚注写入还需覆盖既有边。 */ !branch.scope.edgeIds.includes(id))) throw new Error(RuntimeMessage.CLIENT_RETURNED_ANOTHER_BRANCH)
      if (!contentCurrent() || branch.mapRevision !== snapshot.value?.revision || roots.some((/* 实际授权的根身份。 */ id) => /* 根版本来自该意图开始时的快照。 */ branch.rootRevisions[id] !== initial.nodes.find((/* 原图节点。 */ node) => /* 以身份取得原版本。 */ node.id === id)?.revision)) throw conflict()
    }
    if (!endpointIds.length || !contentCurrent()) { error.value = sessionReadProblem(conflict()); return false }
    let temporaryLease: GraphBranchLeaseProof | undefined
    let preparing = true
    busy.value = true; error.value = null; canRetry.value = false; retryCommand = null
    try {
      let roots = endpointIds
      let branch = await gateway.read('branch.get', { mapId, rootIds: roots }, viewController.signal)
      if (!current()) return false
      checkBranch(branch, roots)
      let lease: GraphBranchLeaseProof | undefined
      if (clientLeasesRequired.value) {
        const grant = selectedBranchGrant.value, originalLease = grant ? sessionReadLeaseProof(grant) : null
        if (grant && originalLease && !endpointIds.every((/* 参与本次写入的节点。 */ id) => /* 不隐式扩大或替换已有编辑权。 */ grant.scope.nodeIds.includes(id))) throw new ClientError({ status: 409, code: 'BRANCH_BUSY', retryable: false, message: NodeEditMessage.RELEASE_PARTIAL_GRANT })
        if (grant && originalLease) {
          roots = [...grant.rootIds]
          branch = await gateway.read('branch.get', { mapId, rootIds: roots }, viewController.signal)
          if (!current()) return false
          checkBranch(branch, roots)
          if (selectedBranchGrant.value?.leaseId !== grant.leaseId || selectedBranchGrant.value.fence !== grant.fence) throw conflict()
          lease = sessionReadLeaseProof(grant) ?? undefined
        } else {
          const result = await gateway.dispatch(crypto.randomUUID(), 'branch.claim', { mapId, rootIds: roots, holderId: crypto.randomUUID() }, sessionController.signal)
          if (result.data.status === 'claimed') temporaryLease = sessionReadLeaseProof(result.data.grant) ?? undefined
          if (!current()) return false
          if (result.data.status === 'busy') throw new ClientError({ status: 409, code: 'BRANCH_BUSY', retryable: false, message: RuntimeMessage.BRANCH_IS_CURRENTLY_OWNED_BY_ANOTHER_CLIENT })
          checkBranch(result.data.grant.branch, roots)
          if (branch.version !== result.data.grant.branch.version) throw conflict()
          lease = temporaryLease
        }
        if (!lease) return false
      }
      if (!current()) return false
      if (!contentCurrent()) throw conflict()
      preparing = false; busy.value = false
      return !!await submit('graph.apply', { mapId, branch: { rootIds: roots, expectedVersion: branch.version }, ...(lease ? { lease } : {}), changes }, crypto.randomUUID(), async (
        /* 这次原子写入或相同原请求重放的正式确认。 */ result,
      ) => {
        // 成功确认动作由submit统一复用；网络恢复后仍选中同一个已创建子节点。
        if (!current()) return
        applySnapshot(result.data.snapshot, epoch)
        if (input.selectId && selection === selectionEpoch) selectNode(input.selectId)
        await refreshWorkspace()
      })
    } catch (cause) {
      await handleFailure(cause, scope, epoch)
      return false
    } finally {
      if (preparing && scope === sessionEpoch && workspaceEpoch === preferenceEpoch) busy.value = false
      if (temporaryLease) {
        try { await gateway.dispatch(crypto.randomUUID(), 'branch.release', { mapId, lease: temporaryLease }) }
        catch { /* 租期回收仅影响临时授权，不覆盖主要保存错误；未知写入仍按原请求确认。 */ }
      }
    }
  }
  /**
   * 先读取整个运行根集合的同一分支版本，再由 run.start 原子核对，避免静默采用选择后的变化。
   *
   * @param input 用户选择的节点范围、有限计划、运行模式及可选重新生成标记。
   */
  async function startRun(input: Pick<CommandInputMap['run.start'], 'scope' | 'plan' | 'mode' | 'regenerate'>) {
    if (!snapshot.value || !canEdit.value || busy.value || canRetry.value) return false
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
  async function answerReview(
    /* 用户已核对的审核身份、版本和决定；结果批准还包含已展示的发布预览版本。 */
    params: Omit<CommandInputMap['review.answer'], 'control'>,
  ): Promise<void> {
    // 固定点击时的审核意图，控制权等待前后核对同一目标；未知结果仍交既有 submit 原请求重放。
    const payload = { ...params }
    const scope = sessionEpoch, epoch = viewEpoch, selectedRunAtStart = selectedRunId.value, runSelectionAtStart = runSelectionEpoch
    function canAnswerCurrentReview(): boolean {
      // 只接纳当前图与所选运行中仍待决定的同一审核，不让等待期间的切换或撤权继续写入。
      if (scope !== sessionEpoch || epoch !== viewEpoch || runSelectionAtStart !== runSelectionEpoch || !canEdit.value || busy.value || canRetry.value
        || activeMapId.value !== payload.mapId || snapshot.value?.mapId !== payload.mapId
        || selectedRunAtStart !== payload.runId || selectedRunId.value !== selectedRunAtStart) return false
      const run = selectedRun.value
      if (!run || run.id !== payload.runId || run.status !== 'running' && run.status !== 'waiting') return false
      const operation = run.operations.find((
        /* 当前所选运行中已冻结的处理项。 */ item,
      ) => /* 精确定位本次审核所属处理项。 */ item.id === payload.operationId)
      if (operation?.status !== 'waiting') return false
      const review = operation?.review
      if (!review || review.id !== payload.reviewId || review.state !== 'pending' || review.revision !== payload.expectedReviewRevision) return false
      if (review.kind === 'result' && payload.decision === 'approve') {
        return bootstrap.value?.metadata.capabilities?.publicationPreview === true && !!payload.expectedPublicationVersion?.trim()
      }
      return true
    }
    if (!canAnswerCurrentReview()) return
    if (clientLeasesRequired.value && selectedRunControl.value?.runId !== payload.runId && !await claimRunControl(payload.runId)) return
    if (!canAnswerCurrentReview()) return
    const grant = selectedRunControl.value
    const control = clientLeasesRequired.value && grant?.runId === payload.runId ? sessionReadRunControlProof(grant) : undefined
    if (clientLeasesRequired.value && !control) return
    const result = await submit('review.answer', { ...payload, ...(control ? { control } : {}) })
    if (result) applySnapshot(result.data.snapshot, epoch)
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
    initializing, connecting, loading, busy, branchLoading, online, error, streamError, streamState, lastSync, canRetry, canEdit, canRenameMap, clientLeasesRequired, active, preferenceSync, accountAvailable,
    initialize, connect, connectLocal, registerUsername, loginUsername, login, verifyEmail, changePassword, logout, disconnect, loadWorkspaces, selectWorkspace, createWorkspace, createMap, renameMap, deleteMap,
    openMap, closeMap, selectNode, selectRun, refresh, refreshWorkspace, refreshManagement, retry, retryPreferences, resolvePreferencesConflict, createNode, saveNode, removeNode, saveSourceAnchors, createChildNode, saveNodeReferences, saveNodeEvidence, claimBranch, releaseBranch, claimRunControl, releaseRunControl,
    startRun, answerReview, cancelRun, pauseRun, resumeRun, dispose,
    clearError() {
      // 清除当前错误提示，同时丢弃其命令重试入口。
      error.value = null; canRetry.value = false; retryCommand = null
    },
  }
}

export const useClientStore = defineStore('client-workspace', () => /* 以应用网关创建 Pinia 持有的客户端会话状态。 */ sessionCreateState(api))
