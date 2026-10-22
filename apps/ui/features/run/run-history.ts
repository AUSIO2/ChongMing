// 面板级运行历史：目录与单份详情各自取消和报错，只读身份不进入当前Run控制状态。
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'

import { ClientError, type ClientErrorData, type ClientGateway, type QueryInputMap } from '../../../../contracts/client'
import type { GraphRun, GraphRunSummary } from '../../../../contracts/graph-run'
import { clientReadError } from '../../../../client/graph-client'
import { provenanceMatchOperation, type OperationOriginTarget } from '../graph/node-origin'

export interface RunHistoryContext {
  userId: string | null
  connectionKey: string | null
  workspaceId: string | null
  mapId: string | null
  active: boolean
  supported: boolean
  target?: OperationOriginTarget
}

/** 面板拥有只读状态；只有显式刷新、续页和选择可以启动读取，关闭后全部清空。 */
export interface RunHistoryView {
  items: Readonly<Ref<GraphRunSummary[]>>
  nextCursor: Readonly<Ref<string | null>>
  directoryVersion: Readonly<Ref<string | null>>
  selectedId: Readonly<Ref<string | null>>
  detail: Readonly<Ref<GraphRun | null>>
  loading: Readonly<Ref<boolean>>
  detailLoading: Readonly<Ref<boolean>>
  error: Readonly<Ref<ClientErrorData | null>>
  detailError: Readonly<Ref<ClientErrorData | null>>
  cursorExpired: Readonly<Ref<boolean>>
  originOutputRevision: Readonly<Ref<number | null>>
  refresh: () => Promise<boolean>
  loadMore: () => Promise<boolean>
  select: (runId: string) => Promise<boolean>
}

enum HistoryMessage {
  CURSOR_EXPIRED = '运行目录已变化，请刷新列表后继续加载。',
  PAGE_MISMATCH = '运行目录响应与当前图或已读取的记录不匹配，请刷新列表。',
  DETAIL_MISMATCH = '运行详情与当前选择不匹配，请重新读取。',
  ORIGIN_MISMATCH = '保存的来源记录与该处理项或产物映射不符，请确认来源身份。',
}
interface Attempt { identity: number; generation: number; controller: AbortController }

/**
 * 在面板作用域内读取有界运行目录和一份详情，关闭、换身份或卸载后丢弃迟到成功和失败。
 * @param gateway 已有公共网关，仅使用run.list和run.get，不提交控制权或写入意图。
 * @param context 面板身份、Map、活动状态和目录能力；不依赖图revision或控制权续租。
 * @param onUnauthorized 仅当前有效读取认证失败时通知会话所有者。
 */
export function useRunHistory(
  /* 统一鉴权和响应校验的公共读取网关。 */ gateway: ClientGateway,
  /* 当前面板身份与活动状态，变化时取消目录和详情。 */ context: Readonly<Ref<RunHistoryContext>>,
  /* 当前有效读取失去认证时交给会话所有者。 */ onUnauthorized: () => void,
): RunHistoryView {
  // 只保存当前目录与单份详情；代次与AbortSignal共同隔离不遵守取消的网关响应。
  const items = shallowRef<GraphRunSummary[]>([])
  const nextCursor = ref<string | null>(null)
  const directoryVersion = ref<string | null>(null)
  const selectedId = ref<string | null>(null)
  const detail = shallowRef<GraphRun | null>(null)
  const loading = ref(false)
  const detailLoading = ref(false)
  const error = shallowRef<ClientErrorData | null>(null)
  const detailError = shallowRef<ClientErrorData | null>(null)
  const cursorExpired = ref(false)
  const originOutputRevision = ref<number | null>(null)
  let closed = false, identity = 0, listGeneration = 0, detailGeneration = 0
  let listController: AbortController | null = null, detailController: AbortController | null = null

  function readMapId(): string | null {
    // 只有完整身份、活动面板和明确支持的服务才允许读取目录或详情。
    const current = context.value
    return !closed && current.active && current.supported && current.userId !== null
      && current.connectionKey !== null && current.workspaceId !== null ? current.mapId : null
  }

  function isCurrent(
    /* 请求开始时固定的身份代次、通道序号和取消信号。 */ attempt: Attempt,
    /* 对应目录或详情通道的最新序号。 */ generation: number,
  ): boolean {
    // 同一runId再次选择仍使用新序号，旧成功和旧401都没有回填资格。
    return readMapId() !== null && attempt.identity === identity && attempt.generation === generation && !attempt.controller.signal.aborted
  }

  function clearDetail(): void {
    // 刷新目录或更换上下文时结束旧详情，不保留与新目录脱节的选中内容。
    detailGeneration += 1
    detailController?.abort()
    detailController = null
    selectedId.value = null
    detail.value = null
    detailError.value = null
    detailLoading.value = false
    originOutputRevision.value = null
  }

  function clear(): void {
    // 关闭或更换身份后统一结束两个通道并清空所有面板状态。
    listGeneration += 1
    listController?.abort()
    listController = null
    loading.value = false
    items.value = []
    nextCursor.value = null
    directoryVersion.value = null
    cursorExpired.value = false
    error.value = null
    clearDetail()
  }

  async function readPage(
    /* 固定Map、页大小及可选原游标。 */ params: QueryInputMap['run.list'],
    /* 是否续接已经展示的同一目录。 */ append: boolean,
  ): Promise<boolean> {
    // 目录只接纳当前身份与同一目录版本，失败不影响独立详情区域。
    if (readMapId() === null) return false
    listController?.abort()
    const attempt: Attempt = { identity, generation: ++listGeneration, controller: new AbortController() }
    const expectedDirectoryVersion = directoryVersion.value
    listController = attempt.controller
    loading.value = true
    error.value = null
    try {
      const page = await gateway.read('run.list', params, attempt.controller.signal)
      if (!isCurrent(attempt, listGeneration)) return false
      if (append && page.directoryVersion !== expectedDirectoryVersion) {
        throw new ClientError({ status: 409, code: 'RUN_CURSOR_EXPIRED', message: HistoryMessage.CURSOR_EXPIRED, retryable: false })
      }
      const previousIds = new Set(items.value.map((/* 已展示目录摘要。 */ item) => /* 重复续页不能被静默去重掩盖。 */ item.runId))
      if (append && page.items.some((/* 待追加目录摘要。 */ item) => /* 重复身份说明续页协议失配。 */ previousIds.has(item.runId))) {
        throw new ClientError({ status: 502, code: 'INVALID_RESPONSE', message: HistoryMessage.PAGE_MISMATCH, retryable: false })
      }
      items.value = append ? [...items.value, ...page.items] : page.items
      nextCursor.value = page.nextCursor
      directoryVersion.value = page.directoryVersion
      cursorExpired.value = false
      const unique = items.value.length === 1 ? items.value[0] : undefined
      if (context.value.target && unique && nextCursor.value === null) void select(unique.runId)
      return true
    } catch (cause) {
      if (!isCurrent(attempt, listGeneration)) return false
      const problem = clientReadError(cause)
      if (problem.code === 'RUN_CURSOR_EXPIRED' || problem.code === 'INVALID_CURSOR') nextCursor.value = null
      cursorExpired.value = problem.code === 'RUN_CURSOR_EXPIRED'
      error.value = cursorExpired.value ? { ...problem, message: HistoryMessage.CURSOR_EXPIRED } : problem
      if (problem.status === 401 || problem.code === 'UNAUTHORIZED') onUnauthorized()
      return false
    } finally {
      if (isCurrent(attempt, listGeneration)) { listController = null; loading.value = false }
    }
  }

  async function refresh(): Promise<boolean> {
    // 手动刷新从第一页建立新目录，旧详情和旧游标不会混入新读取。
    const mapId = readMapId()
    if (mapId === null) return false
    clearDetail()
    items.value = []
    nextCursor.value = null
    directoryVersion.value = null
    cursorExpired.value = false
    const target = context.value.target
    return readPage({ mapId, limit: 25, ...(target ? { operationId: target.operationId } : {}) }, false)
  }

  async function loadMore(): Promise<boolean> {
    // 续页只使用当前成功目录的原游标，过期或正在读取时等待显式操作。
    const mapId = readMapId()
    if (mapId === null || loading.value || cursorExpired.value || nextCursor.value === null || directoryVersion.value === null) return false
    const target = context.value.target
    return readPage({ mapId, limit: 25, cursor: nextCursor.value, ...(target ? { operationId: target.operationId } : {}) }, true)
  }

  async function select(
    /* 独立历史面板选中的运行身份，不写入session.selectedRunId。 */ runId: string,
  ): Promise<boolean> {
    // 详情按需读取且只保留当前一份，错误与目录区域分别重试。
    const mapId = readMapId()
    if (mapId === null) return false
    const target = context.value.target
    clearDetail()
    const attempt: Attempt = { identity, generation: detailGeneration, controller: new AbortController() }
    detailController = attempt.controller
    selectedId.value = runId
    detailLoading.value = true
    try {
      const result = await gateway.read('run.get', { mapId, runId }, attempt.controller.signal)
      if (!isCurrent(attempt, detailGeneration)) return false
      if (result.id !== runId) throw new ClientError({ status: 502, code: 'INVALID_RESPONSE', message: HistoryMessage.DETAIL_MISMATCH, retryable: false })
      if (target) {
        const match = provenanceMatchOperation(result, target)
        if (!match.ok) throw new ClientError({ status: 502, code: 'INVALID_RESPONSE', message: HistoryMessage.ORIGIN_MISMATCH, retryable: false })
        originOutputRevision.value = match.outputRevision ?? null
      }
      detail.value = result
      return true
    } catch (cause) {
      if (!isCurrent(attempt, detailGeneration)) return false
      const problem = clientReadError(cause)
      detailError.value = problem
      if (problem.status === 401 || problem.code === 'UNAUTHORIZED') onUnauthorized()
      return false
    } finally {
      if (isCurrent(attempt, detailGeneration)) { detailController = null; detailLoading.value = false }
    }
  }

  const stop = watch(() => /* 仅监听面板身份与开关，不依赖图内容或控制权。 */ JSON.stringify([
    context.value.userId, context.value.connectionKey, context.value.workspaceId, context.value.mapId, context.value.active, context.value.supported,
    context.value.target,
  ]), () => {
    // 每次身份或活动状态改变都结束旧读取，活动面板自动只取第一页。
    identity += 1
    clear()
    if (readMapId() !== null) void refresh()
  }, { immediate: true, flush: 'sync' })
  if (getCurrentScope()) onScopeDispose(() => {
    // 卸载清空显示并使忽略取消的旧回包永久失效。
    closed = true
    stop()
    identity += 1
    clear()
  })
  return {
    items: computed(() => /* 目录只由本面板操作写入。 */ items.value),
    nextCursor: computed(() => /* 原游标不由组件草稿修改。 */ nextCursor.value),
    directoryVersion: computed(() => /* 成功目录的固定身份。 */ directoryVersion.value),
    selectedId: computed(() => /* 独立于当前Run控制对象的历史选择。 */ selectedId.value),
    detail: computed(() => /* 当前唯一一份只读历史详情。 */ detail.value),
    loading: computed(() => /* 列表状态不占用session busy。 */ loading.value),
    detailLoading: computed(() => /* 详情读取与目录独立。 */ detailLoading.value),
    error: computed(() => /* 目录失败只显示在目录区域。 */ error.value),
    detailError: computed(() => /* 详情失败支持原选择重读。 */ detailError.value),
    cursorExpired: computed(() => /* 目录变化后要求显式刷新。 */ cursorExpired.value),
    originOutputRevision: computed(() => /* 已核对产物映射中保存的发布版本，不以当前节点版本替代。 */ originOutputRevision.value),
    refresh, loadMore, select,
  }
}
