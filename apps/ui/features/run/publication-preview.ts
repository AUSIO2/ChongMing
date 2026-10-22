// 每项审核独立持有权威预览读取；纯投影只对齐冻结身份，不重算发布集合或模型投影。
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'

import { ClientError, type ClientErrorData, type ClientGateway } from '../../../../contracts/client'
import type { EvidenceFrozenClaim, EvidenceUseRef } from '../../../../contracts/evidence-library'
import type { GraphNode } from '../../../../contracts/graph'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphOperation, GraphPortDataRef, GraphProposedOutput, GraphPublicationItem, GraphPublicationPreview, GraphRun, GraphStageResult } from '../../../../contracts/graph-run'
import { clientReadError } from '../../../../client/graph-client'

export interface PublicationPreviewContext {
  userId: string | null
  connectionKey: string | null
  workspaceId: string | null
  snapshot: GraphSnapshot | null
  run: GraphRun | null
  operation: GraphOperation | null
  supported: boolean
}

type OutputResult = Extract<GraphStageResult, { mode: 'outputs' }>
interface ReviewCandidate { output: GraphProposedOutput; result: OutputResult }
interface PublishedReviewCandidate extends ReviewCandidate { item: GraphPublicationItem }
export type ReviewJoinedCandidates =
  | { ok: true; published: PublishedReviewCandidate[] }
  | { ok: false }
export interface ReviewInputVersion {
  ref: GraphPortDataRef
  node: GraphNode | null
  currentRevision: number | null
  state: 'matched' | 'changed' | 'missing'
}
type PublicationPreviewPhase = 'inactive' | 'unsupported' | 'loading' | 'error' | 'stale' | 'ready'
export type PublicationPreviewState =
  | { status: Exclude<PublicationPreviewPhase, 'ready'> }
  | { status: 'ready'; preview: GraphPublicationPreview; published: PublishedReviewCandidate[] }
interface PublicationPreviewView {
  loading: ComputedRef<boolean>
  error: Readonly<Ref<ClientErrorData | null>>
  state: ComputedRef<PublicationPreviewState>
  reload: () => Promise<boolean>
  invalidate: () => void
}

enum PreviewMessage { CANDIDATE_MISMATCH = '发布预览与当前审核候选不匹配，请重新读取预览。' }

/**
 * 在组件作用域内自动读取预览；身份、审核或图revision改变时取消旧读取，卸载后拒绝迟到结果。
 * @param gateway 已有公共网关，仅使用其校验后的权威预览查询。
 * @param context 当前服务身份、工作区、图和审核目标；读取不要求编辑或控制权。
 * @param onUnauthorized 当前有效读取认证失败时交给会话所有者处理。
 */
export function usePublicationPreview(
  /* 只读取已校验权威预览的既有公共网关。 */ gateway: ClientGateway,
  /* 组件当前身份、图内容与审核目标，变更时取消旧读取。 */ context: Readonly<Ref<PublicationPreviewContext>>,
  /* 当前有效请求认证失败时通知会话所有者。 */ onUnauthorized: () => void,
): PublicationPreviewView {
  // 为本审核持有显示版本和读取代次，自动清理换目标或卸载后的旧结果。
  const preview = shallowRef<GraphPublicationPreview | null>(null)
  const error = shallowRef<ClientErrorData | null>(null)
  const phase = ref<PublicationPreviewPhase>('inactive')
  let generation = 0
  let controller: AbortController | null = null
  let closed = false
  const state = computed<PublicationPreviewState>(() => {
    // 只有当前正文成功关联后才暴露ready及对应版本，消费者不再分别拼接就绪与关联条件。
    if (phase.value !== 'ready') return { status: phase.value }
    const value = preview.value
    const current = context.value
    if (!value || !current.snapshot || !current.run || !current.operation) return { status: 'stale' }
    const joined = reviewJoinCandidates(current.snapshot, current.run, current.operation, value)
    return joined.ok ? { status: 'ready', preview: value, published: joined.published } : { status: 'stale' }
  })
  const loading = computed(() => /* 读取状态只有一个来源。 */ phase.value === 'loading')

  /** 取消当前读取并清空显示版本，保证失效后的旧token不会再用于新意图。 */
  function clear(): void {
    // 取消当前请求并清掉已展示版本，使旧结果失去回填资格。
    generation += 1
    controller?.abort()
    controller = null
    preview.value = null
    error.value = null
  }

  /** 显式批准前失效当前版本；不自动取得另一个版本替用户批准。 */
  function invalidate(): void {
    // 使当前批准版本失效，等待用户明确重读而不自动替换决定内容。
    clear()
    phase.value = closed ? 'inactive' : 'stale'
  }

  /** 显式重读当前审核；每次尝试固定身份与代次，旧成功和旧401都被丢弃。 */
  async function reload(): Promise<boolean> {
    // 固定当前待审核身份读取权威清单，仅接纳本代次的成功与失败。
    clear()
    const current = context.value
    const target = readTarget(current)
    if (closed || target === null) {
      phase.value = 'inactive'
      return false
    }
    if (!current.supported) {
      phase.value = 'unsupported'
      return false
    }
    const requestKey = readContextKey(current)
    const requestGeneration = generation
    const attempt = new AbortController()
    controller = attempt
    phase.value = 'loading'
    /** 取消与身份代次共同保证迟到结果只能被原审核接纳。 */
    function isCurrent(): boolean {
      // 同时核对取消、读取代次与当前审核身份，阻止迟到结果影响新视图。
      return !closed && !attempt.signal.aborted && generation === requestGeneration && requestKey === readContextKey(context.value)
    }
    try {
      const value = await gateway.read('run.publication.preview', target, attempt.signal)
      if (!isCurrent()) return false
      const latest = context.value
      if (!latest.snapshot || !latest.run || !latest.operation || !reviewJoinCandidates(latest.snapshot, latest.run, latest.operation, value).ok) {
        error.value = new ClientError({ status: 502, code: 'INVALID_RESPONSE', message: PreviewMessage.CANDIDATE_MISMATCH, retryable: false })
        phase.value = 'stale'
        return false
      }
      preview.value = value
      phase.value = 'ready'
      return true
    } catch (cause) {
      if (!isCurrent()) return false
      const problem = clientReadError(cause)
      error.value = problem
      phase.value = 'error'
      if (problem.status === 401 || problem.code === 'UNAUTHORIZED') onUnauthorized()
      return false
    } finally {
      if (isCurrent()) controller = null
    }
  }

  const stop = watch(() => /* 只监听身份与内容revision，控制权续租不触发读取。 */ readContextKey(context.value), () => {
    // reload内部收口所有查询异常，后台读取由本作用域的取消和代次负责。
    void reload()
  }, { immediate: true, flush: 'sync' })
  if (getCurrentScope()) onScopeDispose(() => {
    // 卸载结束自动读取，并让不遵守AbortSignal的网关结果失效。
    closed = true
    stop()
    clear()
    phase.value = 'inactive'
  })
  return { loading, error, state, reload, invalidate }
}

/**
 * 对齐同一审核的不可编辑候选；完整集合由后端提供，前端不从selection或引用推算发布项。
 * @param snapshot 当前Map快照，用于核对Map与Run所属关系。
 * @param run 当前选中Run，正文只能来自其Operation。
 * @param operation 当前待结果审核Operation。
 * @param preview 后端返回的权威发布条目和内容版本。
 */
export function reviewJoinCandidates(
  /* 当前Map快照，用于确认Run所属身份。 */ snapshot: GraphSnapshot,
  /* 当前选中Run，候选正文只从其处理项读取。 */ run: GraphRun,
  /* 当前待结果审核的处理项及已接纳候选。 */ operation: GraphOperation,
  /* 后端权威发布条目与待审核身份。 */ preview: GraphPublicationPreview,
): ReviewJoinedCandidates {
  // 逐项对齐权威清单与不可编辑候选，任何身份或元数据错配都使整份清单不可批准。
  const review = operation.review
  if (!review || review.kind !== 'result' || review.state !== 'pending' || operation.status !== 'waiting'
    || preview.mapId !== snapshot.mapId || preview.runId !== run.id || preview.operationId !== operation.id
    || preview.reviewId !== review.id || preview.reviewRevision !== review.revision || preview.specHash !== operation.specHash
    || !snapshot.runs.some((/* 当前Map中的Run。 */ item) => /* 禁止借用别的Map/Run候选。 */ item.id === run.id)
    || !run.operations.some((/* 当前Run中的Operation。 */ item) => /* 身份必须属于所选Run。 */ item.id === operation.id)) return { ok: false }
  const candidates = new Map<string, ReviewCandidate>()
  for (const group of operation.stages) for (const result of group.results) {
    if (result.mode !== 'outputs') continue
    if (result.stageId !== group.stageId) return { ok: false }
    for (const output of result.outputs) {
      const key = candidateKey(result.workId, output.key)
      if (candidates.has(key)) return { ok: false }
      candidates.set(key, { output, result })
    }
  }
  const published: PublishedReviewCandidate[] = []
  for (const item of preview.items) {
    const key = candidateKey(item.workId, item.key)
    const candidate = candidates.get(key)
    if (!candidate || candidate.result.stageId !== item.stageId || candidate.result.slotId !== item.slotId
      || candidate.output.port !== item.port || candidate.output.typeRef.id !== item.typeRef.id
      || candidate.output.typeRef.version !== item.typeRef.version) return { ok: false }
    published.push({ item, ...candidate })
  }
  return { ok: true, published }
}

/**
 * 输入和context只有四项节点身份完全一致才可显示当前正文，错版不伪装历史正文。
 * @param snapshot 当前Map节点，用于核对冻结引用。
 * @param operation 已保存的输入/context精确引用。
 */
export function reviewReadInputVersions(
  /* 当前Map节点，不能替代冻结引用所指的旧版本正文。 */ snapshot: GraphSnapshot,
  /* 保存本次输入与上下文精确引用的处理项。 */ operation: GraphOperation,
): { input: ReviewInputVersion[]; context: ReviewInputVersion[] } {
  // 分别核对输入与上下文的四项节点身份，只为完全匹配的引用提供正文。
  const nodes = new Map(snapshot.nodes.map((/* 当前图节点。 */ node) => /* 按本图身份查当前版本。 */ [node.id, node]))
  /** 将单个冻结引用转换为可读正文或明确的错版/丢失状态。 */
  function readVersion(
    /* 端口中保存的精确节点引用。 */ reference: GraphPortDataRef,
  ): ReviewInputVersion {
    // 将冻结引用对应到当前精确版本，错版或丢失时只保留身份提示。
    const node = nodes.get(reference.id)
    if (!node) return { ref: reference, node: null, currentRevision: null, state: 'missing' }
    const matches = node.revision === reference.revision && node.typeId === reference.type.id && node.typeVersion === reference.type.version
    return { ref: reference, node: matches ? node : null, currentRevision: node.revision, state: matches ? 'matched' : 'changed' }
  }
  return { input: operation.group.inputRefs.map(readVersion), context: operation.group.contextRefs.map(readVersion) }
}

/**
 * 只读取当前步骤获权的完整冻结材料，不查询当前证据库、不模拟智能体字段投影。
 * @param run 启动时保存完整材料的Run。
 * @param operation 含获权entryId/contentDigest及快照摘要的冻结规格。
 */
export function reviewReadFrozenMaterials(
  /* 保存每步完整冻结材料的Run。 */ run: GraphRun,
  /* 当前处理项的步骤身份与精确获权引用。 */ operation: GraphOperation,
): EvidenceFrozenClaim[] {
  // 按当前步骤、固定内容身份和已有快照摘要读取获权原文，不访问当前证据库。
  const claims = run.libraryClaimSets?.find((/* Run内完整步骤材料。 */ set) => /* 跨步骤材料不能串用。 */ set.stepId === operation.stepId)?.claims ?? []
  const refs = operation.executionSpec.libraryClaimRefs ?? []
  const digests = operation.executionSpec.librarySnapshotDigests
  return refs.flatMap((/* 当前规格获权的精确引用。 */ reference, /* 与快照摘要一一对应的位置。 */ index) => {
    // 仅返回该引用精确匹配的启动时材料，缺失时保留给调用者显示的数量差异。
    const material = claims.find((/* 当前步骤完整冻结条目。 */ claim) => /* 身份、内容和已有快照摘要都必须匹配。 */
      claim.ref.entryId === reference.entryId && claim.ref.contentDigest === reference.contentDigest
      && (digests === undefined || claim.snapshotDigest === digests[index]))
    return material ? [material] : []
  })
}

/**
 * 将候选实际使用引用与冻结材料关联，保留本次理由；没有实际引用的材料不标记已使用。
 * @param output 已接受的候选输出。
 * @param materials 当前步骤精确获权的完整冻结材料。
 */
export function reviewReadCandidateUses(
  /* 已接纳候选及其实际固定证据使用声明。 */ output: GraphProposedOutput,
  /* 当前步骤精确获权的完整冻结材料。 */ materials: EvidenceFrozenClaim[],
): Array<{ ref: EvidenceUseRef; material: EvidenceFrozenClaim | null }> {
  // 保留候选实际使用理由，并把每条引用关联到精确冻结材料或明确的缺失状态。
  return (output.libraryClaimRefs ?? []).map((/* 候选声明的实际固定引用及理由。 */ reference) => /* 不补造未引用材料或改用当前库正文。 */ ({
    ref: reference,
    material: materials.find((/* 当前Operation获权的材料。 */ material) => /* 缺少原摘要时不换成当前库内容。 */
      material.ref.entryId === reference.entryId && material.ref.contentDigest === reference.contentDigest) ?? null,
  }))
}

/** 将完整候选身份组成无分隔符碰撞的内部索引。 */
function candidateKey(
  /* 候选所属已接受Work。 */ workId: string,
  /* 同一Work内唯一候选键。 */ key: string,
): string {
  // 将Work与候选键作为完整组合身份编码，避免分隔符造成索引碰撞。
  return JSON.stringify([workId, key])
}

/** 只为当前活动Run的待结果审核建立查询，viewer不需要控制租约。 */
function readTarget(
  /* 当前完整组件上下文。 */ context: PublicationPreviewContext,
): { mapId: string; runId: string; operationId: string; reviewId: string; expectedReviewRevision: number } | null {
  // 仅为有效身份下当前活动Run的待结果审核建立只读请求，不要求控制权。
  const { snapshot, run, operation } = context
  const review = operation?.review
  if (!context.userId || !context.connectionKey || !context.workspaceId || !snapshot || snapshot.workspaceId !== context.workspaceId
    || !run || !operation || !review || (run.status !== 'running' && run.status !== 'waiting')
    || operation.status !== 'waiting' || review.kind !== 'result' || review.state !== 'pending') return null
  return { mapId: snapshot.mapId, runId: run.id, operationId: operation.id, reviewId: review.id, expectedReviewRevision: review.revision }
}

/** 仅身份、图内容和审核状态触发取消重读，不绑定ownership续租或暂停开关。 */
function readContextKey(
  /* 当前组件身份和审核对象。 */ context: PublicationPreviewContext,
): string {
  // 固定触发预览失效的身份、内容revision与审核状态，忽略控制权续租。
  const { snapshot, run, operation } = context
  return JSON.stringify([context.userId, context.connectionKey, context.workspaceId, context.supported,
    snapshot?.mapId, snapshot?.workspaceId, snapshot?.revision, run?.id, run?.status, operation?.id, operation?.status,
    operation?.specHash, operation?.review?.id, operation?.review?.revision, operation?.review?.state, operation?.review?.kind])
}
