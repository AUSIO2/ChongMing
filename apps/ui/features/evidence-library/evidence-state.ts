// 每个窗口持有证据库读取、选择与固定请求重试，隔离服务、身份和工作区切换后的旧结果。
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'

import { ClientError, type ClientErrorData, type ClientGateway, type CommandInputMap } from '../../../../contracts/client'
import type {
  EvidenceBasisRef, EvidenceCollectParams, EvidenceCollectResult, EvidenceEntrySummary,
  EvidenceLibraryEntry, EvidenceRelationNode, EvidenceRelationsView, EvidenceSearchParams,
} from '../../../../contracts/evidence-library'
import { clientReadError } from '../../../../client/graph-client'

export interface EvidenceUiContext {
  userId: string | null
  connectionKey: string | null
  workspaceId: string | null
  active: boolean
  canEdit: boolean
}
export interface EvidenceFilters {
  query: string
  confidence: 'all' | '0' | '1'
  subject: string
  event: string
  includeInactive: boolean
}

/** 表单已完成显式判断后的收录意图；原始传输协议仍在服务端接纳 unknown 并验证。 */
export type EvidenceCollectInput = Omit<EvidenceCollectParams, 'workspaceId' | 'confidence'> & { confidence: 0 | 1 }
type EvidenceCollectPayload = EvidenceCollectInput & { workspaceId: string }

enum EvidenceUiMessage {
  UNAVAILABLE = '当前服务尚未提供证据库，请切换到支持证据库的服务。',
  FORBIDDEN = '当前成员只有读取权限，不能收录或撤回证据。',
  REVISION_CONFLICT = '条目版本已变化，请重新读取后再决定是否撤回。',
  SOURCE_VERSION_CONFLICT = '来源节点已变化，请重新打开节点后收录。',
  CURSOR_EXPIRED = '证据库已变化，请刷新列表后继续加载。',
  CURSOR_INVALID = '筛选条件已变化，请先搜索再继续加载。',
  DETAIL_INVALID = '服务返回的固定条目身份与当前选择不匹配。',
  RELATIONS_INVALID = '服务返回的关系与当前条目的固定内容不匹配。',
}
const EVIDENCE_UI_MESSAGES = new Map<string, EvidenceUiMessage>([
  ['EVIDENCE_UNAVAILABLE', EvidenceUiMessage.UNAVAILABLE],
  ['FORBIDDEN', EvidenceUiMessage.FORBIDDEN],
  ['EVIDENCE_REVISION_CONFLICT', EvidenceUiMessage.REVISION_CONFLICT],
  ['EVIDENCE_SOURCE_VERSION_CONFLICT', EvidenceUiMessage.SOURCE_VERSION_CONFLICT],
  ['EVIDENCE_CURSOR_EXPIRED', EvidenceUiMessage.CURSOR_EXPIRED],
  ['EVIDENCE_CURSOR_INVALID', EvidenceUiMessage.CURSOR_INVALID],
])

interface ReadAttempt { controller: AbortController; generation: number; identity: number }
type RetryOperation =
  | { kind: 'read'; target: 'search' | 'detail'; attempt: () => Promise<boolean> }
  | { kind: 'command'; attempt: () => Promise<boolean> }

/**
 * 管理库的读取代次、身份隔离与命令收据重试；调用者只提交完整用户动作。
 * @param gateway 已有公共网关，负责传输、协议校验和实际取消。
 * @param context 当前窗口的身份、连接、工作区、库活动状态与写权限。
 * @param onUnauthorized 当前有效请求遭遇 401 时通知会话所有者退出。
 */
export function evidenceCreateState(
  /* 已有公共传输网关，接纳其校验后的库响应。 */ gateway: ClientGateway,
  /* 当前窗口的服务身份、工作区和读写能力。 */ context: Readonly<Ref<EvidenceUiContext>>,
  /* 当前请求认证失效时交给会话所有者退出。 */ onUnauthorized?: () => void | Promise<void>,
) {
  const items = shallowRef<EvidenceEntrySummary[]>([])
  const filters = ref<EvidenceFilters>({ query: '', confidence: 'all', subject: '', event: '', includeInactive: false })
  const selectedId = ref<string | null>(null)
  // 固定摘要属于当前选择，离开库后自动刷新仍沿用；显式选择和身份清理可重置。
  let selectedDigest: string | undefined
  const entry = shallowRef<EvidenceLibraryEntry | null>(null)
  const collectionOutcome = shallowRef<EvidenceCollectResult | null>(null)
  const relations = shallowRef<EvidenceRelationsView | null>(null)
  const relationsLoading = ref(false)
  const relationsError = shallowRef<ClientErrorData | null>(null)
  const selectedRelationKey = ref<string | null>(null)
  const selectedRelationNode = computed((): EvidenceRelationNode | null => {
    // 邻域选择只属于当前根的固定关系包，不借用普通 Map 或其他条目的节点。
    const snapshot = relations.value?.entryId === selectedId.value ? relations.value.snapshot : null
    const key = selectedRelationKey.value
    if (!snapshot || key === null || key === snapshot.rootKey) return null
    return snapshot.nodes.find((/* 当前根保存的固定邻域节点。 */ node) => /* 只按完整快照 key 选择。 */ node.key === key) ?? null
  })
  const loading = ref(false)
  const detailLoading = ref(false)
  const busy = ref(false)
  const error = shallowRef<ClientErrorData | null>(null)
  const nextCursor = ref<string | null>(null)
  const libraryRevision = ref<number | null>(null)
  const closed = ref(false)
  const canEdit = computed(() => !closed.value && validIdentity() && context.value.canEdit)
  const canRetry = computed(() => {
    // 重试能力还受当前身份和写权限约束，viewer 不显示可执行的命令重试入口。
    const pending = retryOperation.value
    if (pending === null || busy.value || loading.value || detailLoading.value) return false
    return pending.kind === 'command' ? canEdit.value : canRead()
  })
  const canRetryRelations = computed(() => {
    // 关系重试只影响关系读取，不能取代尚未确认命令的原 requestId。
    const problem = relationsError.value
    return canRead() && !relationsLoading.value && selectedId.value !== null && problem !== null
      && problem.retryable && problem.status !== 401 && problem.status !== 403 && problem.status !== 409
      && problem.code !== 'UNAUTHORIZED' && problem.code !== 'EVIDENCE_UNAVAILABLE'
  })
  const retryOperation = shallowRef<RetryOperation | null>(null)
  let identity = 0
  let searchGeneration = 0
  let detailGeneration = 0
  let searchController: AbortController | null = null
  let detailController: AbortController | null = null
  let relationsController: AbortController | null = null
  let commandController: AbortController | null = null
  let acceptedQuery: EvidenceSearchParams | null = null
  let pendingRelations: EvidenceRelationsView | null = null
  let detailRejected = false

  /** 当前窗口具有完整服务身份时才允许读取或提交命令。 */
  function validIdentity(): boolean {
    return context.value.userId !== null && context.value.connectionKey !== null && context.value.workspaceId !== null
  }

  /** 库页可读时才启动搜索和详情请求；Map 中收录另按写权限判断。 */
  function canRead(): boolean {
    return !closed.value && validIdentity() && context.value.active
  }

  /** 取消旧列表读取，让命令前的分页无法再次覆盖更新后的摘要。 */
  function cancelSearch(): void {
    searchGeneration += 1
    searchController?.abort()
    searchController = null
    loading.value = false
    if (retryOperation.value?.kind === 'read' && retryOperation.value.target === 'search') retryOperation.value = null
  }

  /** 取消所有库读取并推进代次，让不遵守 AbortSignal 的旧网关响应也失效。 */
  function cancelReads(): void {
    cancelSearch()
    detailGeneration += 1
    detailController?.abort()
    relationsController?.abort()
    detailController = null
    relationsController = null
    detailLoading.value = false
    relationsLoading.value = false
    relationsError.value = null
    pendingRelations = null
    detailRejected = false
    if (retryOperation.value?.kind === 'read') retryOperation.value = null
  }

  /** 清除当前库视图、分页基线和收录结果，身份隔离时不能保留另一工作区的数据。 */
  function clearView(): void {
    items.value = []
    nextCursor.value = null
    libraryRevision.value = null
    acceptedQuery = null
    selectedId.value = null
    selectedDigest = undefined
    entry.value = null
    clearCollectionOutcome()
    relations.value = null
    relationsError.value = null
    selectedRelationKey.value = null
  }

  /**
   * 校验一次读取仍属于当前身份和对应读取代次。
   * @param attempt 请求启动时捕获的身份、代次和取消控制器。
   * @param generation 对应列表或详情的当前代次。
   */
  function isCurrentRead(
    /* 读取启动时捕获的身份、代次与控制器。 */ attempt: ReadAttempt,
    /* 当前列表或详情的读取代次。 */ generation: number,
  ): boolean {
    return canRead() && attempt.identity === identity && attempt.generation === generation && !attempt.controller.signal.aborted
  }

  /**
   * 展示有效请求的失败；401 由会话所有者处理，409 不自动重试或改写版本。
   * @param problem 本次请求已经归一化的失败，调用者可复用其code作局部处理。
   * @param retry 可恢复失败时保留的同一次请求尝试。
   */
  async function acceptError(
    /* 当前有效请求已经归一化的结构化失败。 */ problem: ClientErrorData,
    /* 可恢复失败时保留的原操作及所属读取目标。 */ retry: RetryOperation,
  ): Promise<void> {
    if (problem.status === 401 || problem.code === 'UNAUTHORIZED') {
      error.value = problem
      retryOperation.value = null
      await onUnauthorized?.()
      return
    }
    if (retry.kind === 'read' && retryOperation.value?.kind === 'command') return
    error.value = problem
    if (problem.retryable && problem.status !== 409 && problem.code !== 'EVIDENCE_UNAVAILABLE') {
      // 不确定写入拥有重试优先权，读取失败不能覆盖它的原请求。
      if (retryOperation.value?.kind !== 'command') retryOperation.value = retry
    }
  }

  /**
   * 读取固定查询的一页，仅在当前代次接纳，并拒绝跨库版本拼接。
   * @param params 捕获的查询参数；重试与继续加载均不读取后续草稿变化。
   * @param append 是否拼接至已接纳的列表与版本基线。
   */
  async function readPage(
    /* 本次查询的固定筛选、工作区及可选游标。 */ params: EvidenceSearchParams,
    /* 是否在既有库 revision 上继续拼接。 */ append: boolean,
  ): Promise<boolean> {
    if (!canRead()) return false
    searchController?.abort()
    const attempt: ReadAttempt = { controller: new AbortController(), generation: ++searchGeneration, identity }
    searchController = attempt.controller
    loading.value = true
    if (retryOperation.value?.kind !== 'command') {
      retryOperation.value = null
      error.value = null
    }
    try {
      const page = await gateway.read('evidence.search', { ...params }, attempt.controller.signal)
      if (!isCurrentRead(attempt, searchGeneration)) return false
      if (append && page.libraryRevision !== libraryRevision.value) {
        nextCursor.value = null
        await acceptError(clientReadError(evidenceCreateCursorError('EVIDENCE_CURSOR_EXPIRED')), {
          kind: 'read', target: 'search',
          attempt: async () => /* 显式重试仍保留原分页请求，不刷新或混合版本。 */ readPage(params, append),
        })
        return false
      }
      items.value = append ? [...items.value, ...page.items] : page.items
      nextCursor.value = page.nextCursor
      libraryRevision.value = page.libraryRevision
      if (!append) {
        acceptedQuery = { ...params }
        delete acceptedQuery.cursor
      }
      return true
    } catch (cause) {
      if (!isCurrentRead(attempt, searchGeneration)) return false
      const problem = evidenceReadUiError(clientReadError(cause))
      if (problem.code === 'EVIDENCE_CURSOR_EXPIRED' || problem.code === 'EVIDENCE_CURSOR_INVALID') nextCursor.value = null
      await acceptError(problem, {
        kind: 'read', target: 'search',
        attempt: async () => /* 读取重试固定原查询参数与分页意图。 */ readPage(params, append),
      })
      return false
    } finally {
      if (isCurrentRead(attempt, searchGeneration)) {
        searchController = null
        loading.value = false
      }
    }
  }

  /** 用当前筛选建立新分页基线，旧分页请求的成功与失败均不能覆盖它。 */
  async function search(): Promise<boolean> {
    const workspaceId = context.value.workspaceId
    if (!canRead() || workspaceId === null) return false
    return readPage(evidenceReadSearchParams(workspaceId, filters.value), false)
  }

  /** 用上次成功搜索的筛选与游标继续读取，草稿变化要求先明确重新搜索。 */
  async function loadMore(): Promise<boolean> {
    const workspaceId = context.value.workspaceId
    if (!canRead() || loading.value || nextCursor.value === null || acceptedQuery === null || workspaceId === null) return false
    if (JSON.stringify(evidenceReadSearchParams(workspaceId, filters.value)) !== JSON.stringify(acceptedQuery)) {
      error.value = evidenceCreateCursorError('EVIDENCE_CURSOR_INVALID')
      return false
    }
    return readPage({ ...acceptedQuery, cursor: nextCursor.value }, true)
  }

  async function readDetail(
    /* 与本次根选择绑定的固定库条目身份。 */ entryId: string,
    /* 读取开始时捕获的工作区身份。 */ workspaceId: string,
    /* 与关系读取共享选择代次的详情控制器。 */ attempt: ReadAttempt,
    /* 节点固定引用指定的内容摘要；普通库浏览可省略。 */ expectedDigest?: string,
  ): Promise<boolean> {
    // 单独接纳固定详情，让较慢的关系读取不阻止正文显示。
    try {
      const result = await gateway.read('evidence.get', { workspaceId, entryId }, attempt.controller.signal)
      if (!isCurrentRead(attempt, detailGeneration)) return false
      if (result.id !== entryId || result.workspaceId !== workspaceId
        || expectedDigest !== undefined && result.contentDigest !== expectedDigest) {
        throw new ClientError({ status: 502, code: 'INVALID_RESPONSE', message: EvidenceUiMessage.DETAIL_INVALID, retryable: false })
      }
      entry.value = result
      if (pendingRelations) bindRelations(pendingRelations)
      return true
    } catch (cause) {
      if (!isCurrentRead(attempt, detailGeneration)) return false
      detailRejected = true
      const problem = evidenceReadUiError(clientReadError(cause))
      if (problem.code === 'INVALID_RESPONSE') {
        relations.value = null
        pendingRelations = null
        selectedRelationKey.value = null
      }
      await acceptError(problem, {
        kind: 'read', target: 'detail',
        attempt: async () => /* 重试仍绑定同一条目及调用者原先指定的固定摘要。 */ select(entryId, expectedDigest),
      })
      return false
    } finally {
      if (isCurrentRead(attempt, detailGeneration)) {
        detailController = null
        detailLoading.value = false
      }
    }
  }

  function bindRelations(
    /* 已经过公共形状校验、仍需与固定 get 根关联的关系响应。 */ result: EvidenceRelationsView,
  ): boolean {
    // 只有固定摘要与根版本对应时暴露邻域；relations 先到则等 get 完成绑定。
    const rootEntry = entry.value
    if (rootEntry === null) {
      if (detailRejected) return false
      pendingRelations = result
      return true
    }
    pendingRelations = null
    const snapshot = result.snapshot
    const rootNode = snapshot?.nodes.find((/* 服务返回的固定节点。 */ node) => /* 按公共 rootKey 找到根版本。 */ node.key === snapshot.rootKey)
    const origin = rootEntry.claim.origin
    const rootMatches = snapshot === null || (rootNode !== undefined && rootNode.role === 'claim'
      && rootNode.ref.mapId === origin.mapId && rootNode.ref.nodeId === origin.nodeId && rootNode.ref.revision === origin.revision)
    if (result.entryId !== rootEntry.id || result.workspaceId !== rootEntry.workspaceId || result.contentDigest !== rootEntry.contentDigest || !rootMatches) {
      relations.value = null
      selectedRelationKey.value = null
      relationsError.value = { status: 502, code: 'INVALID_RESPONSE', message: EvidenceUiMessage.RELATIONS_INVALID, retryable: false, errorId: crypto.randomUUID() }
      return false
    }
    relations.value = result
    const key = selectedRelationKey.value
    if (key !== null && !snapshot?.nodes.some((/* 新接纳的固定节点。 */ node) => /* 保留仍在同一固定关系包的邻域选择。 */ node.key === key)) {
      selectedRelationKey.value = null
    }
    return true
  }

  async function readRelations(
    /* 当前根条目的固定库身份。 */ entryId: string,
    /* 本次读取捕获的工作区身份。 */ workspaceId: string,
    /* 与详情共享选择代次的独立关系控制器。 */ attempt: ReadAttempt,
  ): Promise<boolean> {
    // 关系只来自 evidence.relations，成功和错误均隔离旧身份与旧选择。
    relationsController?.abort()
    relationsController = attempt.controller
    pendingRelations = null
    relationsLoading.value = true
    relationsError.value = null
    try {
      const result = await gateway.read('evidence.relations', { workspaceId, entryId }, attempt.controller.signal)
      if (!isCurrentRead(attempt, detailGeneration)) return false
      return bindRelations(result)
    } catch (cause) {
      if (!isCurrentRead(attempt, detailGeneration)) return false
      const problem = evidenceReadUiError(clientReadError(cause))
      relations.value = null
      pendingRelations = null
      selectedRelationKey.value = null
      relationsError.value = problem
      if (problem.status === 401 || problem.code === 'UNAUTHORIZED') {
        retryOperation.value = null
        await onUnauthorized?.()
      }
      return false
    } finally {
      if (isCurrentRead(attempt, detailGeneration) && relationsController === attempt.controller) {
        relationsController = null
        relationsLoading.value = false
      }
    }
  }

  async function select(
    /* 固定库条目身份；null关闭根详情及邻域。 */ entryId: string | null,
    /* 从节点引用打开时固定其原摘要，不额外预读或静默升级引用。 */ expectedDigest?: string,
  ): Promise<boolean> {
    // 同时开启 get 与 relations；换根清邻域，同根刷新保留固定邻域选择。
    if (closed.value) return false
    const changedRoot = selectedId.value !== entryId
    detailController?.abort()
    relationsController?.abort()
    detailGeneration += 1
    detailController = null
    relationsController = null
    detailLoading.value = false
    relationsLoading.value = false
    relationsError.value = null
    pendingRelations = null
    detailRejected = false
    selectedId.value = entryId
    selectedDigest = entryId === null ? undefined : expectedDigest
    entry.value = null
    if (changedRoot || entryId === null) {
      relations.value = null
      selectedRelationKey.value = null
    }
    if (entryId === null) return true
    const workspaceId = context.value.workspaceId
    if (!canRead() || workspaceId === null) return false
    const detailAttempt: ReadAttempt = { controller: new AbortController(), generation: detailGeneration, identity }
    const relationsAttempt: ReadAttempt = { controller: new AbortController(), generation: detailGeneration, identity }
    detailController = detailAttempt.controller
    detailLoading.value = true
    if (retryOperation.value?.kind !== 'command') {
      retryOperation.value = null
      error.value = null
    }
    const [detailReady] = await Promise.all([
      readDetail(entryId, workspaceId, detailAttempt, expectedDigest),
      readRelations(entryId, workspaceId, relationsAttempt),
    ])
    return detailReady
  }

  function selectRelation(/* 当前固定关系包的节点 key；null 返回根条目。 */ key: string | null): boolean {
    // 只选择已保存的邻域快照，既不读取当前 Map，也不把邻域当另一库条目。
    if (closed.value) return false
    const snapshot = relations.value?.entryId === selectedId.value ? relations.value.snapshot : null
    if (key === null || key === snapshot?.rootKey) {
      selectedRelationKey.value = null
      return true
    }
    if (!snapshot?.nodes.some((/* 当前根固定快照节点。 */ node) => /* 接受真实节点 key，拒绝猜测或任意身份。 */ node.key === key)) return false
    selectedRelationKey.value = key
    return true
  }

  async function retryRelations(): Promise<boolean> {
    // 显式重新读取当前根的关系，保留详情和未确认命令的独立重试能力。
    const entryId = selectedId.value
    const workspaceId = context.value.workspaceId
    if (!canRetryRelations.value || entryId === null || workspaceId === null) return false
    return readRelations(entryId, workspaceId, { controller: new AbortController(), generation: detailGeneration, identity })
  }

  /**
   * 接纳已确认的库命令并停用旧分页；仅在选择未变化时更新固定详情。
   * @param result 已通过公共网关验证的收录或撤回条目。
   * @param selectionGeneration 命令首次提交时的详情选择代次，不随重试更新。
   */
  function acceptCommandEntry(
    /* 后端已确认的收录或撤回固定条目。 */ result: EvidenceLibraryEntry,
    /* 命令首次提交时的选择代次，重试保持原值。 */ selectionGeneration: number,
  ): void {
    cancelSearch()
    if (selectionGeneration === detailGeneration) {
      // 用户仍停留在原选择时接纳命令详情；后来选中的条目及其请求由详情代次独立持有。
      detailGeneration += 1
      detailController?.abort()
      relationsController?.abort()
      detailController = null
      relationsController = null
      detailLoading.value = false
      relationsLoading.value = false
      if (retryOperation.value?.kind === 'read' && retryOperation.value.target === 'detail') retryOperation.value = null
      if (selectedId.value !== result.id) {
        selectedDigest = undefined
        relations.value = null
        selectedRelationKey.value = null
      }
      selectedId.value = result.id
      entry.value = result
      relationsError.value = null
      const workspaceId = context.value.workspaceId
      if (canRead() && workspaceId !== null) {
        // 命令已确认的固定根可先显示；关系错误保存在独立通道，不影响收据结果。
        void readRelations(result.id, workspaceId, { controller: new AbortController(), generation: detailGeneration, identity })
      }
    }
    items.value = items.value.flatMap(
      /* 当前列表中的固定条目摘要。 */ item => {
        // 更新已有摘要；默认活动列表移除已撤回条目。
        if (item.id !== result.id) return [item]
        if (!filters.value.includeInactive && result.status !== 'active') return []
        return [{ ...item, status: result.status }]
      },
    )
    nextCursor.value = null
    libraryRevision.value = null
    acceptedQuery = null
  }

  function acceptCollectOutcome(
    /* 首次提交或同一原请求重放已经确认的完整收录结果。 */ result: EvidenceCollectResult,
  ): void {
    // 保留业务去重、收据确认和相反判断身份的独立副本，不从当前选择或外层旗标推导。
    collectionOutcome.value = structuredClone(result)
  }

  /**
   * 提交复制后的命令，以同一请求身份保留不确定结果的重试。
   * @param execute 捕获原参数和 requestId 的网关调用，每次尝试交付独立副本。
   * @param readEntry 从具体命令成功数据中取得固定条目。
   * @param acceptResult 可选业务结果接纳动作，首次与原请求重放成功时共用。
   */
  async function runCommand<T>(
    /* 捕获原输入与请求身份的网关调用。 */ execute: (
      /* 当前一次尝试的取消信号。 */ signal: AbortSignal,
    ) => Promise<T>,
    /* 从具体命令数据取得固定条目的投影。 */ readEntry: (
      /* 公共网关已校验的命令业务结果。 */ result: T,
    ) => EvidenceLibraryEntry,
    /* 仅在原身份的成功确认处保留业务结果，重放共用同一个接纳动作。 */ acceptResult?: (
      /* 已由公共网关校验且通过本次命令身份检查的结果。 */ result: T,
    ) => void,
  ): Promise<T | null> {
    if (!canEdit.value || busy.value || retryOperation.value?.kind === 'command') return null
    const commandIdentity = identity
    const commandSelection = detailGeneration
    /** 尝试一次原命令，重试不会读取新的界面草稿或改写请求编号。 */
    async function attempt(): Promise<T | null> {
      if (closed.value || commandIdentity !== identity || !canEdit.value || busy.value) return null
      const controller = new AbortController()
      commandController = controller
      busy.value = true
      error.value = null
      retryOperation.value = null
      try {
        const result = await execute(controller.signal)
        if (closed.value || commandIdentity !== identity || controller.signal.aborted) return null
        acceptCommandEntry(readEntry(result), commandSelection)
        acceptResult?.(result)
        return result
      } catch (cause) {
        if (closed.value || commandIdentity !== identity || controller.signal.aborted) return null
        await acceptError(evidenceReadUiError(clientReadError(cause)), {
          kind: 'command', attempt: async () => /* 沿用本次原命令再尝试，明确报告是否确认成功。 */ (await attempt()) !== null,
        })
        return null
      } finally {
        if (!closed.value && commandIdentity === identity && commandController === controller) {
          commandController = null
          busy.value = false
        }
      }
    }
    return attempt()
  }

  /**
   * 显式收录当前来源 Claim，复制范围和依据以隔离响应式草稿及传输层修改。
   * @param params Map 中提供的来源版本、数字判断、范围、理由和依据。
   */
  async function collect(
    /* 表单已确认的来源版本、数字判断、范围及明确依据。 */ params: EvidenceCollectInput,
  ): Promise<EvidenceCollectResult | null> {
    const workspaceId = context.value.workspaceId
    if (!canEdit.value || workspaceId === null || busy.value || retryOperation.value?.kind === 'command') return null
    const payload = evidenceCloneCollectParams({ ...params, workspaceId })
    const requestId = crypto.randomUUID()
    clearCollectionOutcome()
    return runCommand(
      /* 本次命令的取消信号；每次交付原输入的独立副本。 */ async signal =>
        /* 公共写网关使用固定 requestId；响应中的业务结果已经过协议校验。 */
        (await gateway.dispatch(requestId, 'evidence.collect', evidenceCloneCollectParams(payload), signal)).data,
      /* 收录已确认的业务结果。 */ result => /* 固定条目由后端收录结果直接提供。 */ result.entry,
      acceptCollectOutcome,
    )
  }

  /**
   * 撤回当前条目，固定原 revision 和理由，409 交由用户重新决定。
   * @param reason 用户明确输入的撤回原因。
   */
  async function withdraw(/* 用户明确输入的撤回原因。 */ reason: string): Promise<EvidenceLibraryEntry | null> {
    const workspaceId = context.value.workspaceId
    const currentEntry = entry.value
    if (!canEdit.value || workspaceId === null || currentEntry === null || currentEntry.status !== 'active' || selectedRelationNode.value !== null) return null
    const payload: CommandInputMap['evidence.withdraw'] = {
      workspaceId, entryId: currentEntry.id, expectedRevision: currentEntry.revision, reason,
    }
    const requestId = crypto.randomUUID()
    return runCommand(
      /* 同一撤回尝试的取消信号；副本保留原版本条件和原因。 */ async signal =>
        /* 将稳定请求身份与撤回原输入交给公共网关。 */
        (await gateway.dispatch(requestId, 'evidence.withdraw', { ...payload }, signal)).data,
      /* 后端已确认的撤回固定条目。 */ result => /* 撤回响应本身就是条目详情。 */ result,
    )
  }

  /** 只重试显式保留的原操作；不自动刷新、重设版本或提交新的请求身份。 */
  async function retry(): Promise<boolean> {
    if (!canRetry.value) return false
    return retryOperation.value ? retryOperation.value.attempt() : false
  }

  /** 空闲时清除提示并明确放弃原命令重试，此后新输入取得新的 requestId。 */
  function clearError(): void {
    if (busy.value) return
    error.value = null
    retryOperation.value = null
  }

  function clearCollectionOutcome(): void {
    // 仅关闭本次收录结果的展示，不改变当前固定条目、未确认命令或库中数据。
    collectionOutcome.value = null
  }

  const stopContext = watch(
    /* 只观察请求身份和能力，筛选草稿由显式 search 提交。 */ () => ({ ...context.value }),
    (
      /* 当前窗口上下文。 */ current,
      /* 上次窗口上下文；首次装配时不存在。 */ previous,
    ) => {
      // 身份变化隔离全部请求；离开库只取消读取，Map 中提交仍可确认。
      if (closed.value) return
      const identityChanged = previous === undefined
        || current.userId !== previous.userId
        || current.connectionKey !== previous.connectionKey
        || current.workspaceId !== previous.workspaceId
      if (identityChanged) {
        identity += 1
        cancelReads()
        commandController?.abort()
        commandController = null
        busy.value = false
        retryOperation.value = null
        error.value = null
        clearView()
        filters.value = { query: '', confidence: 'all', subject: '', event: '', includeInactive: false }
      } else if (current.active !== previous.active && !current.active) {
        cancelReads()
        if (retryOperation.value?.kind !== 'command') error.value = null
      }
      if (canRead() && (identityChanged || previous?.active !== current.active)) {
        void search()
        // 同身份返回库保留画布与选择，同时重新确认条目的当前撤回状态。
        const entryId = selectedId.value
        if (entryId !== null) void select(entryId, selectedDigest)
      }
    },
    { immediate: true, flush: 'sync' },
  )

  /** 释放窗口所有读取和写请求，任何迟到结果都不能重新填充已关闭状态。 */
  function dispose(): void {
    if (closed.value) return
    closed.value = true
    stopContext()
    identity += 1
    cancelReads()
    commandController?.abort()
    commandController = null
    busy.value = false
    retryOperation.value = null
    clearView()
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  return {
    items, filters, selectedId, entry, collectionOutcome, relations, relationsLoading, relationsError, selectedRelationKey, selectedRelationNode,
    loading, detailLoading, busy, error, nextCursor, libraryRevision, canRetry, canRetryRelations, canEdit,
    search, loadMore, select, selectRelation, collect, withdraw, retry, retryRelations, clearError, clearCollectionOutcome, dispose,
  }
}

export type EvidenceState = ReturnType<typeof evidenceCreateState>

/**
 * 将用户草稿投影为稳定有界查询，数字 0 必须显式保留。
 * @param workspaceId 当前身份所在工作区。
 * @param filters 本次提交的完整筛选草稿。
 */
function evidenceReadSearchParams(
  /* 本次读取所属的工作区身份。 */ workspaceId: string,
  /* 用户本次明确提交的筛选草稿。 */ filters: EvidenceFilters,
): EvidenceSearchParams {
  const params: EvidenceSearchParams = { workspaceId, limit: 25, includeInactive: filters.includeInactive }
  if (filters.query.trim()) params.query = filters.query.trim()
  if (filters.confidence === '0') params.confidence = 0
  if (filters.confidence === '1') params.confidence = 1
  if (filters.subject.trim()) params.subject = filters.subject.trim()
  if (filters.event.trim()) params.event = filters.event.trim()
  return params
}

/**
 * 复制收录协议字段，解除 Vue 嵌套草稿及依据数组与每次传输的引用关系。
 * @param params 本次原收录输入或其固定副本。
 */
function evidenceCloneCollectParams(
  /* 表单已确认的收录输入或固定重试副本，需解除嵌套引用。 */ params: EvidenceCollectPayload,
): EvidenceCollectPayload {
  // 只复制协议中实际可变的对象和数组，数字判断无需递归处理。
  return {
    workspaceId: params.workspaceId,
    claim: { ...params.claim },
    confidence: params.confidence,
    applicability: {
      ...params.applicability,
      time: params.applicability.time === null ? null : { ...params.applicability.time },
      conditions: [...params.applicability.conditions],
    },
    reason: params.reason,
    basisRefs: params.basisRefs.map(
      /* 原输入中的单项收录依据。 */ basis => /* 保留依据分支并解除内部引用。 */ evidenceCloneBasis(basis),
    ),
  }
}

/**
 * 复制一项已声明的依据引用，不把内部嵌套 ref 留在可变草稿上。
 * @param basis 收录协议中的人工、节点、资产或库引用依据。
 */
function evidenceCloneBasis(/* 收录的人工、节点、资产或库引用依据。 */ basis: EvidenceBasisRef): EvidenceBasisRef {
  if (basis.kind === 'node') return { ...basis, ref: { ...basis.ref } }
  if (basis.kind === 'library') return { ...basis, ref: { ...basis.ref } }
  return { ...basis }
}

/**
 * 将已知库失败解释为可执行的中文提示，保留错误码和诊断编号。
 * @param problem 公共网关归一化后的结构化错误。
 */
function evidenceReadUiError(/* 公共网关归一化后的错误码、诊断与重试信息。 */ problem: ClientErrorData): ClientErrorData {
  // 只翻译实际登记的业务码，原型名称与其他未知码保留原字符串。
  const message = EVIDENCE_UI_MESSAGES.get(problem.code)
  return message === undefined ? problem : { ...problem, message }
}

/**
 * 报告本地分页基线失效，阻止将不同筛选或版本的页面悄悄混在一起。
 * @param code 筛选变化或服务返回不一致版本的明确错误类型。
 */
function evidenceCreateCursorError(
  /* 标识筛选变化或跨库 revision 的本地分页失败。 */ code: 'EVIDENCE_CURSOR_INVALID' | 'EVIDENCE_CURSOR_EXPIRED',
): ClientError {
  return new ClientError({
    status: code === 'EVIDENCE_CURSOR_EXPIRED' ? 409 : 422,
    code,
    message: code === 'EVIDENCE_CURSOR_EXPIRED' ? EvidenceUiMessage.CURSOR_EXPIRED : EvidenceUiMessage.CURSOR_INVALID,
    retryable: false,
  })
}
