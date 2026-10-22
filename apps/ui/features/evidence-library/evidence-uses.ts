// 窗口级只读使用记录：隔离库根/身份、请求代次、使用目录游标与固定消费者详情。
import { getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'

import { ClientError, type ClientErrorData, type ClientGateway, type QueryInputMap } from '../../../../contracts/client'
import type { EvidenceUse, EvidenceUseSummary } from '../../../../contracts/evidence-library'
import { clientReadError } from '../../../../client/graph-client'

export interface EvidenceUsesContext {
  userId: string | null
  connectionKey: string | null
  workspaceId: string | null
  entryId: string | null
  active: boolean
}
enum EvidenceUsesMessage {
  CURSOR_EXPIRED = '使用记录已变化，请刷新列表后继续加载。',
  CURSOR_INVALID = '历史筛选已变化，请先刷新使用记录。',
}
interface Attempt { identity: number; generation: number; controller: AbortController }

export function evidenceCreateUses(
  /* 公共读取网关，服务/认证仍由窗口会话管理。 */ gateway: ClientGateway,
  /* 当前用户、服务、工作区、库根与活动状态。 */ context: Readonly<Ref<EvidenceUsesContext>>,
  /* 当前请求遇到401时通知会话所有者。 */ onUnauthorized?: () => void | Promise<void>,
) {
  // 本工厂拥有所有读取控制器和目录基线；作用域销毁时统一取消并清空。
  const items = shallowRef<EvidenceUseSummary[]>([])
  const detail = shallowRef<EvidenceUse | null>(null)
  const selectedUsageId = ref<string | null>(null)
  const includeHistory = ref(false)
  const loading = ref(false)
  const detailLoading = ref(false)
  const error = shallowRef<ClientErrorData | null>(null)
  const nextCursor = ref<string | null>(null)
  const usageRevision = ref<number | null>(null)
  let closed = false, identity = 0, listGeneration = 0, detailGeneration = 0
  let listController: AbortController | null = null, detailController: AbortController | null = null
  let baseline: QueryInputMap['evidence.uses'] | null = null

  function canRead(): boolean {
    // 只有完整当前身份且面板活动时才发送使用记录查询。
    const value = context.value
    return !closed && value.active && value.userId !== null && value.connectionKey !== null && value.workspaceId !== null && value.entryId !== null
  }
  function isCurrent(
    /* 读取启动时捕获的身份、代次和信号。 */ attempt: Attempt,
    /* 该读取通道的最新代次。 */ generation: number,
  ): boolean {
    // 取消与身份代次同时校验，防止忽略AbortSignal的旧网关结果写回。
    return canRead() && attempt.identity === identity && attempt.generation === generation && !attempt.controller.signal.aborted
  }
  function cancelReads(): void {
    // 停止全部列表和详情读取，不把主动关闭当作当前失败。
    listGeneration += 1
    detailGeneration += 1
    listController?.abort()
    detailController?.abort()
    listController = null
    detailController = null
    loading.value = false
    detailLoading.value = false
  }
  function clearView(): void {
    // 身份或库根改变后不能保留另一条目的记录和消费者正文。
    items.value = []
    detail.value = null
    selectedUsageId.value = null
    nextCursor.value = null
    usageRevision.value = null
    baseline = null
    error.value = null
  }
  async function acceptError(/* 当前仍有效请求已经归一化的失败。 */ problem: ClientErrorData): Promise<void> {
    // 401通知外层会话，其他失败保留稳定code与诊断信息供显式刷新。
    error.value = problem.code === 'EVIDENCE_CURSOR_EXPIRED' ? { ...problem, message: EvidenceUsesMessage.CURSOR_EXPIRED } : problem
    if (problem.status === 401 || problem.code === 'UNAUTHORIZED') await onUnauthorized?.()
  }
  async function readPage(
    /* 固定库根、筛选与可选游标，重读不借新草稿参数。 */ params: QueryInputMap['evidence.uses'],
    /* 是否延续已经接纳的同一使用目录版本。 */ append: boolean,
  ): Promise<boolean> {
    // 网关已核对响应及请求身份；只接纳当前代次并保证续页属于同一目录版本。
    if (!canRead()) return false
    listController?.abort()
    const attempt: Attempt = { identity, generation: ++listGeneration, controller: new AbortController() }
    listController = attempt.controller
    loading.value = true
    error.value = null
    try {
      const page = await gateway.read('evidence.uses', { ...params }, attempt.controller.signal)
      if (!isCurrent(attempt, listGeneration)) return false
      if (append && page.usageRevision !== usageRevision.value) {
        throw new ClientError({ status: 409, code: 'EVIDENCE_CURSOR_EXPIRED', message: EvidenceUsesMessage.CURSOR_EXPIRED, retryable: false })
      }
      items.value = append ? [...items.value, ...page.items] : page.items
      nextCursor.value = page.nextCursor
      usageRevision.value = page.usageRevision
      if (!append) { baseline = { ...params }; delete baseline.cursor }
      return true
    } catch (cause) {
      if (!isCurrent(attempt, listGeneration)) return false
      const problem = clientReadError(cause)
      if (problem.code === 'EVIDENCE_CURSOR_EXPIRED' || problem.code === 'EVIDENCE_CURSOR_INVALID') nextCursor.value = null
      await acceptError(problem)
      return false
    } finally {
      if (isCurrent(attempt, listGeneration)) { listController = null; loading.value = false }
    }
  }
  async function search(): Promise<boolean> {
    // 显式刷新当前筛选，建立新的使用目录基线。
    const { workspaceId, entryId } = context.value
    if (!canRead() || workspaceId === null || entryId === null) return false
    return readPage({ workspaceId, entryId, includeHistory: includeHistory.value, limit: 25 }, false)
  }
  async function loadMore(): Promise<boolean> {
    // 续页只使用成功搜索的固定筛选，历史草稿变化先要求刷新。
    if (!canRead() || loading.value || nextCursor.value === null || baseline === null) return false
    if (baseline.includeHistory !== includeHistory.value) {
      error.value = new ClientError({ status: 422, code: 'EVIDENCE_CURSOR_INVALID', message: EvidenceUsesMessage.CURSOR_INVALID, retryable: false })
      return false
    }
    return readPage({ ...baseline, cursor: nextCursor.value }, true)
  }
  async function select(/* 固定使用记录身份，null关闭消费者详情。 */ usageId: string | null): Promise<boolean> {
    // 接纳网关已核对身份和消费者版本的固定详情，仍隔离旧选择的迟到响应。
    if (closed) return false
    detailController?.abort()
    const generation = ++detailGeneration
    detailController = null
    selectedUsageId.value = usageId
    detail.value = null
    detailLoading.value = false
    if (usageId === null) return true
    const { workspaceId, entryId } = context.value
    if (!canRead() || workspaceId === null || entryId === null) return false
    const attempt: Attempt = { identity, generation, controller: new AbortController() }
    detailController = attempt.controller
    detailLoading.value = true
    error.value = null
    try {
      const result = await gateway.read('evidence.use.get', { workspaceId, entryId, usageId }, attempt.controller.signal)
      if (!isCurrent(attempt, detailGeneration)) return false
      detail.value = result
      return true
    } catch (cause) {
      if (!isCurrent(attempt, detailGeneration)) return false
      await acceptError(clientReadError(cause))
      return false
    } finally {
      if (isCurrent(attempt, detailGeneration)) { detailController = null; detailLoading.value = false }
    }
  }
  const stop = watch(() => /* 只观察窗口身份和活动状态，历史开关由显式search提交。 */ ({ ...context.value }), (
    /* 当前窗口/库根身份。 */ current, /* 前一次身份，首次创建时不存在。 */ previous,
  ) => {
    // 身份变化清空，离开只取消；返回同身份重新读取当前使用目录。
    if (closed) return
    const changed = !previous || current.userId !== previous.userId || current.connectionKey !== previous.connectionKey
      || current.workspaceId !== previous.workspaceId || current.entryId !== previous.entryId
    if (changed) { identity += 1; cancelReads(); clearView(); includeHistory.value = false }
    else if (!current.active && previous.active) { cancelReads(); error.value = null }
    if (canRead() && (changed || current.active !== previous?.active)) {
      // search自行接纳结构化失败，通知回调的异常只保留为当前受控读取错误。
      const reading = search()
      const readIdentity = identity, readGeneration = listGeneration
      void reading.catch((/* 外层认证通知意外拒绝的原因。 */ cause) => {
        // 通知本身的迟到异常也不能改写新身份或后来搜索的错误。
        if (canRead() && identity === readIdentity && listGeneration === readGeneration) error.value = clientReadError(cause)
      })
    }
  }, { immediate: true, flush: 'sync' })
  function dispose(): void {
    // 面板/窗口生命周期结束后统一取消读取并释放上下文watch。
    if (closed) return
    closed = true
    stop()
    identity += 1
    cancelReads()
    clearView()
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { items, detail, selectedUsageId, includeHistory, loading, detailLoading, error, nextCursor, usageRevision, search, loadMore, select, dispose }
}
