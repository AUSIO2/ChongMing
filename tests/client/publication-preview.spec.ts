// C10先行：审核只读取权威发布集合，并隔离旧审核、身份和版本的读取结果。
import { effectScope, shallowReactive, shallowRef } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { ClientError, type ClientGateway, type QueryInputMap, type QueryOutputMap } from '../../contracts/client'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphProposedOutput, GraphPublicationPreview, GraphStageResult } from '../../contracts/graph-run'
import { runCreateRun } from '../../backend/modules/graph/run-state'
import { libraryTestCatalog, libraryTestDocument, libraryTestFrozenClaim, libraryTestStartInput, LIBRARY_TEST_AGENT, LIBRARY_TEST_OUTPUT, LIBRARY_TEST_TIME } from '../backend/fixtures/library-claims'
import {
  reviewJoinCandidates, reviewReadCandidateUses, reviewReadFrozenMaterials, reviewReadInputVersions,
  usePublicationPreview, type PublicationPreviewContext,
} from '../../apps/ui/features/run/publication-preview'

enum PreviewTestMessage { RUN_MISSING = 'Expected fixture Run', OPERATION_MISSING = 'Expected fixture Operation', READ_MISSING = 'Expected publication read', UNEXPECTED = 'Unexpected preview transport' }

/** 建立真实冻结规格和完整材料，仅候选与待审核状态由本测试固定。 */
function reviewFixture() {
  // 复用真实冻结规格与材料，只固定前端核对所需的候选和待审核状态。
  const { document, input } = libraryTestDocument()
  const material = libraryTestFrozenClaim()
  runCreateRun(document, libraryTestStartInput(document, input.id, [material]), {
    definitions: libraryTestCatalog(), agents: [LIBRARY_TEST_AGENT], tools: [], maxSlots: 4,
    libraryClaimSets: [{ stepId: 'verify', claims: [material] }],
  }, LIBRARY_TEST_TIME)
  const run = document.runs[0]
  if (!run) throw new Error(PreviewTestMessage.RUN_MISSING)
  const operation = run.operations[0]
  if (!operation) throw new Error(PreviewTestMessage.OPERATION_MISSING)
  const candidate = (/* 服务端接纳后的稳定候选键。 */ key: string): GraphProposedOutput => /* 建立保留0评分的已接纳候选。 */ ({
    key, port: 'opinion', typeRef: { ...LIBRARY_TEST_OUTPUT }, payload: { score: 0, reason: `候选 ${key}` },
  })
  const outputs: Extract<GraphStageResult, { mode: 'outputs' }> = {
    mode: 'outputs', workId: 'work-a', stageId: 'assess', slotId: 'slot-a', acceptedAt: LIBRARY_TEST_TIME,
    reason: '第一份生成说明', outputs: [candidate('a'), candidate('b'), candidate('c')],
  }
  outputs.outputs[0].libraryClaimRefs = [{ ...material.ref, reason: '本次使用固定材料的理由' }]
  operation.stages[0].results = [outputs]
  operation.stages.push({ stageId: 'select', expectedWorkIds: ['selector-a', 'selector-b'], closed: true, planSlots: [], results: [
    { mode: 'selection', workId: 'selector-a', stageId: 'select', slotId: 'pick-a', acceptedAt: LIBRARY_TEST_TIME, reason: '选择A', selection: [{ workId: 'work-a', key: 'a' }] },
    { mode: 'selection', workId: 'selector-b', stageId: 'select', slotId: 'pick-b', acceptedAt: LIBRARY_TEST_TIME, reason: '再次选择A', selection: [{ workId: 'work-a', key: 'a' }] },
  ] })
  operation.status = 'waiting'
  operation.review = { id: 'review-a', revision: 1, kind: 'result', state: 'pending', decision: null, createdAt: LIBRARY_TEST_TIME, answeredAt: null }
  run.status = 'waiting'
  const snapshot: GraphSnapshot = {
    mapId: document.id, workspaceId: document.workspaceId, revision: document.revision, name: document.name,
    nodes: document.nodes, edges: document.edges, runs: document.runs, ownershipRevision: 1, ownerships: [], runControls: [], updatedAt: LIBRARY_TEST_TIME,
  }
  const preview: GraphPublicationPreview = {
    mapId: snapshot.mapId, runId: run.id, operationId: operation.id, reviewId: operation.review.id,
    reviewRevision: operation.review.revision, specHash: operation.specHash, publicationVersion: 'publication-a',
    ports: [{ port: 'opinion', typeRef: { ...LIBRARY_TEST_OUTPUT }, count: 2 }], items: [
      { workId: 'work-a', key: 'a', stageId: 'assess', slotId: 'slot-a', port: 'opinion', typeRef: { ...LIBRARY_TEST_OUTPUT }, directlySelected: true, referencedBy: [] },
      { workId: 'work-a', key: 'b', stageId: 'assess', slotId: 'slot-a', port: 'opinion', typeRef: { ...LIBRARY_TEST_OUTPUT }, directlySelected: false, referencedBy: [{ workId: 'work-a', key: 'a' }] },
    ],
  }
  return { snapshot, run, operation, preview, outputs, material }
}

interface ReadCall {
  params: QueryInputMap['run.publication.preview']
  signal?: AbortSignal
  resolve: (/* 实际后端预览响应。 */ value: GraphPublicationPreview) => void
  reject: (/* 实际传输错误。 */ cause: unknown) => void
}

/** 创建忽略取消仍可回包的受控公共网关，验证本组件自己隔离迟到结果。 */
function stateFixture(
  /* 旧服务可不具备预览能力；默认真实支持。 */ supported = true,
) {
  // 以组件作用域和可控网关记录读取，让测试独立交付旧结果验证隔离。
  const domain = reviewFixture()
  const context = shallowRef<PublicationPreviewContext>(shallowReactive({ userId: 'viewer', connectionKey: 'service-a', workspaceId: domain.snapshot.workspaceId,
    snapshot: shallowReactive(domain.snapshot), run: shallowReactive(domain.run),
    operation: shallowReactive({ ...domain.operation, review: domain.operation.review ? shallowReactive(domain.operation.review) : null }), supported }))
  const reads: ReadCall[] = []
  const unexpected = async (): Promise<never> => { /* 预览只使用查询，不发送控制权或写入命令。 */ throw new Error(PreviewTestMessage.UNEXPECTED) }
  const gateway: ClientGateway = {
    watch: unexpected, getConnection: unexpected, connect: unexpected, disconnect: unexpected,
    dispatch: unexpected, upload: unexpected, download: unexpected,
    async read<K extends keyof QueryInputMap>(
      /* 组件仅允许权威预览查询。 */ method: K,
      /* 查询启动时固定的审核身份。 */ params: QueryInputMap[K],
      /* 组件作用域拥有的取消信号。 */ signal?: AbortSignal,
    ): Promise<QueryOutputMap[K]> {
      // 仅记录权威预览查询，取消后仍由测试主动完成以验证代次保护。
      if (method !== 'run.publication.preview') return unexpected()
      const value = await new Promise<GraphPublicationPreview>((/* 测试主动交付成功。 */ resolve, /* 测试主动交付失败。 */ reject) => {
        // 泛型K不能随method窄化；此分支已限制为唯一预览协议。
        reads.push({ params: params as QueryInputMap['run.publication.preview'], signal, resolve, reject })
      })
      return value as QueryOutputMap[K]
    },
  }
  const onUnauthorized = vi.fn()
  const scope = effectScope()
  const state = scope.run(() => /* 所有自动读取与取消均归该组件作用域。 */ usePublicationPreview(gateway, context, onUnauthorized))
  if (!state) throw new Error(PreviewTestMessage.RUN_MISSING)
  return { ...domain, context, reads, onUnauthorized, scope, state }
}

/** 取得已发生的请求，缺请求时保留明确失败而非非空断言。 */
function readAt(
  /* 当前小型状态夹具。 */ f: ReturnType<typeof stateFixture>,
  /* 实际请求的顺序。 */ index: number,
): ReadCall {
  // 按真实调用顺序取得请求，缺少预期读取时给出明确夹具错误。
  const value = f.reads[index]
  if (!value) throw new Error(PreviewTestMessage.READ_MISSING)
  return value
}

/** 排空预览接纳与Vue计算的微任务，不依赖定时器猜测。 */
async function settle(): Promise<void> {
  // 排空已经完成的网关读取与响应接纳，不等待任何计时器。
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
}

describe('C10 authority preview and frozen review projections', () => {
  // 验证审核只读投影不重算发布集合，也不混用当前版本或其它步骤材料。
  it('joins only the authoritative published set and retains both selection and reference roles', () => {
    // 后端清单决定发布项，生成说明、直接入选与被引用关系同时保留。
    const f = reviewFixture()
    f.preview.items[0].referencedBy = [{ workId: 'work-a', key: 'b' }]
    const result = reviewJoinCandidates(f.snapshot, f.run, f.operation, f.preview)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.published.map((/* 已按后端清单对齐的候选。 */ entry) => /* 不重算selection合集。 */ entry.output.key)).toEqual(['a', 'b'])
    expect(result.published[0].item).toMatchObject({ directlySelected: true, referencedBy: [{ workId: 'work-a', key: 'b' }] })
    expect(result.published[1].item.directlySelected).toBe(false)
    expect(result.published[0].result.reason).toBe('第一份生成说明')
    expect(result.published[0].output.payload.score).toBe(0)
  })

  it('fails the whole join for wrong review identity, duplicate candidate keys or mismatched metadata', () => {
    // 每次仅破坏一个对齐条件，整份预览必须失败而不是静默跳过坏条目。
    const changes: Array<(/* 独立克隆的审核夹具。 */ f: ReturnType<typeof reviewFixture>) => void> = [
      (/* 独立审核夹具。 */ f) => { /* 制造审核版本错配。 */ f.preview.reviewRevision += 1 },
      (/* 独立审核夹具。 */ f) => { /* 制造Map身份错配。 */ f.preview.mapId = 'other-map' },
      (/* 独立审核夹具。 */ f) => { /* 制造冻结规格错配。 */ f.preview.specHash = 'other-spec' },
      (/* 独立审核夹具。 */ f) => { /* 制造清单引用不存在的候选。 */ f.preview.items[0].key = 'missing' },
      (/* 独立审核夹具。 */ f) => { /* 制造已接纳候选键重复。 */ f.outputs.outputs.push(structuredClone(f.outputs.outputs[0])) },
      (/* 独立审核夹具。 */ f) => { /* 制造生成阶段错配。 */ f.preview.items[0].stageId = 'other-stage' },
      (/* 独立审核夹具。 */ f) => { /* 制造智能体槽位错配。 */ f.preview.items[0].slotId = 'other-slot' },
      (/* 独立审核夹具。 */ f) => { /* 制造输出端口错配。 */ f.preview.items[0].port = 'other-port' },
      (/* 独立审核夹具。 */ f) => { /* 制造精确类型版本错配。 */ f.preview.items[0].typeRef.version += 1 },
    ]
    for (const change of changes) {
      const f = reviewFixture()
      change(f)
      expect(reviewJoinCandidates(f.snapshot, f.run, f.operation, f.preview)).toEqual({ ok: false })
    }
  })

  it('retains unregistered payloads and exact type identities rather than guessing a template', () => {
    // 未注册的精确类型与嵌套字段也必须完整保留，不套用其它业务模板。
    const f = reviewFixture()
    f.outputs.outputs[0].typeRef = { id: 'unknown.payload', version: 9 }
    f.outputs.outputs[0].payload = { custom: { raw: '完整未知字段' }, score: 0 }
    f.preview.items[0].typeRef = { ...f.outputs.outputs[0].typeRef }
    const result = reviewJoinCandidates(f.snapshot, f.run, f.operation, f.preview)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.published[0].output).toMatchObject({ typeRef: { id: 'unknown.payload', version: 9 }, payload: { custom: { raw: '完整未知字段' }, score: 0 } })
  })

  it('reads input and context bodies only at exact id revision type and type version', () => {
    // 同一输入分别充当input和context，更新、类型变化和删除都停止提供当前正文。
    const f = reviewFixture()
    const input = f.snapshot.nodes[0]
    f.operation.group.contextRefs = [{ ...f.operation.group.inputRefs[0], key: 'context-key', port: 'background' }]
    let result = reviewReadInputVersions(f.snapshot, f.operation)
    expect(result.input[0]).toMatchObject({ state: 'matched', node: input, currentRevision: input.revision })
    expect(result.context[0]).toMatchObject({ ref: { key: 'context-key', port: 'background' }, state: 'matched', node: input })
    input.revision += 1
    result = reviewReadInputVersions(f.snapshot, f.operation)
    expect(result.input[0]).toMatchObject({ state: 'changed', node: null, currentRevision: input.revision })
    input.revision -= 1
    input.typeVersion += 1
    expect(reviewReadInputVersions(f.snapshot, f.operation).input[0]).toMatchObject({ state: 'changed', node: null })
    f.snapshot.nodes = []
    expect(reviewReadInputVersions(f.snapshot, f.operation).context[0]).toMatchObject({ state: 'missing', node: null, currentRevision: null })
  })

  it('reads complete current-step frozen material and keeps fixed zero separate from actual use reasons', () => {
    // 当前步骤冻结原文供审核者完整阅读，固定判断、收录理由与候选实际理由互不覆盖。
    const f = reviewFixture()
    const other = libraryTestFrozenClaim()
    f.run.libraryClaimSets?.push({ stepId: 'other', claims: [other] })
    const materials = reviewReadFrozenMaterials(f.run, f.operation)
    expect(materials).toHaveLength(1)
    expect(materials[0].entry.confidence).toBe(0)
    expect(materials[0].entry.claim.nodeSnapshot.payload.secret).toBe('不应提供给模型的字段')
    expect(materials[0].entry.claim.nodeSnapshot.payload.context).toHaveProperty('hidden')
    expect(materials[0].definition.agentProjection).toEqual(f.material.definition.agentProjection)
    expect(materials[0].entry.decision.reason).toBe('固定判断依据')
    expect(reviewReadCandidateUses(f.outputs.outputs[0], materials)).toEqual([{ ref: { ...f.material.ref, reason: '本次使用固定材料的理由' }, material: materials[0] }])
    expect(reviewReadCandidateUses(f.outputs.outputs[1], materials)).toEqual([])
    // 当前库状态不在该投影的输入中；缺失精确固定材料也不改用其他条目正文。
    f.outputs.outputs[0].libraryClaimRefs = [{ ...f.material.ref, contentDigest: 'wrong-digest', reason: '保留实际理由' }]
    expect(reviewReadCandidateUses(f.outputs.outputs[0], materials)).toEqual([{ ref: { ...f.material.ref, contentDigest: 'wrong-digest', reason: '保留实际理由' }, material: null }])
    f.operation.executionSpec.libraryClaimRefs = [{ ...f.material.ref, contentDigest: 'wrong-digest' }]
    expect(reviewReadFrozenMaterials(f.run, f.operation)).toEqual([])
  })
})

describe('C10 per-operation preview lifecycle', () => {
  // 验证每个审核组件拥有读取与取消代次，只有当前目标才能接纳回包。
  it('lets a viewer read once and becomes ready only after joining the current review', async () => {
    // 预览读取不要求编辑或控制权，对齐后才提供可批准的显示版本。
    const f = stateFixture()
    expect(f.state.state.value).toEqual({ status: 'loading' })
    expect(readAt(f, 0).params).toEqual({ mapId: f.snapshot.mapId, runId: f.run.id, operationId: f.operation.id, reviewId: 'review-a', expectedReviewRevision: 1 })
    readAt(f, 0).resolve(f.preview)
    await settle()
    expect(f.state.state.value).toMatchObject({ status: 'ready', preview: { publicationVersion: 'publication-a' },
      published: [{ output: { key: 'a' } }, { output: { key: 'b' } }] })
    expect(f.reads).toHaveLength(1)
    f.scope.stop()
  })

  it('does not query unsupported services or plan and completed reviews', async () => {
    // 旧服务与非待结果审核状态均不发预览查询。
    const f = stateFixture(false)
    expect(f.state.state.value).toEqual({ status: 'unsupported' })
    expect(f.reads).toHaveLength(0)
    const operation = f.context.value.operation
    if (!operation?.review) throw new Error(PreviewTestMessage.OPERATION_MISSING)
    operation.review.kind = 'plan'
    f.context.value.supported = true
    expect(f.state.state.value).toEqual({ status: 'inactive' })
    expect(await f.state.reload()).toBe(false)
    operation.review.state = 'answered'
    operation.status = 'completed'
    operation.review.kind = 'result'
    expect(f.reads).toHaveLength(0)
    f.scope.stop()
  })

  it('shows a read error, supports explicit reload and invalidates a displayed token without auto retry', async () => {
    // 可恢复读取由用户明确重试，批准前失效不能自动换入另一个显示版本。
    const f = stateFixture()
    readAt(f, 0).reject(new ClientError({ status: 503, code: 'UNAVAILABLE', message: '临时不可用', retryable: true }))
    await settle()
    expect(f.state.state.value).toEqual({ status: 'error' })
    expect(f.state.error.value?.code).toBe('UNAVAILABLE')
    const loading = f.state.reload()
    expect(f.state.loading.value).toBe(true)
    readAt(f, 1).resolve(f.preview)
    expect(await loading).toBe(true)
    expect(f.state.state.value.status).toBe('ready')
    f.state.invalidate()
    expect(f.state.state.value).toEqual({ status: 'stale' })
    expect(f.reads).toHaveLength(2)
    f.scope.stop()
  })

  it('re-reads document revisions but ignores control ownership renewals', async () => {
    // 内容revision使当前显示版本失效，控制权续租不触发查询或闪烁。
    const f = stateFixture()
    readAt(f, 0).resolve(f.preview)
    await settle()
    const snapshot = f.context.value.snapshot
    if (!snapshot) throw new Error(PreviewTestMessage.RUN_MISSING)
    snapshot.ownershipRevision += 1
    expect(f.reads).toHaveLength(1)
    expect(f.state.state.value.status).toBe('ready')
    snapshot.revision += 1
    expect(f.state.state.value).toEqual({ status: 'loading' })
    expect(f.reads).toHaveLength(2)
    readAt(f, 1).resolve(f.preview)
    await settle()
    expect(f.state.state.value.status).toBe('ready')
    f.scope.stop()
  })

  it('withdraws the ready version when current candidate bodies no longer match', async () => {
    // 当前正文变化即使未形成新的文档revision，也不能继续暴露已关联版本或批准集合。
    const f = stateFixture()
    readAt(f, 0).resolve(f.preview)
    await settle()
    expect(f.state.state.value.status).toBe('ready')
    const operation = f.context.value.operation
    if (!operation) throw new Error(PreviewTestMessage.OPERATION_MISSING)
    const outputs = structuredClone(f.outputs)
    outputs.outputs[0].key = 'replaced'
    operation.stages = [{ ...operation.stages[0], results: [outputs] }, ...operation.stages.slice(1)]

    expect(f.state.state.value).toEqual({ status: 'stale' })
    expect(f.reads).toHaveLength(1)
    f.scope.stop()
  })

  it('clears and aborts on review switches and ignores an old successful response', async () => {
    // 换审核立即取消旧请求，旧成功回包不能填充新审核正文或版本。
    const f = stateFixture()
    const operation = f.context.value.operation
    if (!operation?.review) throw new Error(PreviewTestMessage.OPERATION_MISSING)
    operation.review.id = 'review-b'
    expect(readAt(f, 0).signal?.aborted).toBe(true)
    readAt(f, 0).resolve(f.preview)
    await settle()
    expect(f.state.state.value).toEqual({ status: 'loading' })
    readAt(f, 1).resolve({ ...f.preview, reviewId: 'review-b', publicationVersion: 'publication-b' })
    await settle()
    expect(f.state.state.value).toMatchObject({ status: 'ready', preview: { publicationVersion: 'publication-b' } })
    f.scope.stop()
  })

  it('does not sign out a new identity for an old unauthorized read', async () => {
    // 身份切换后旧401只能被丢弃，不能通知会话退出新连接。
    const f = stateFixture()
    f.context.value.userId = 'new-user'
    expect(readAt(f, 0).signal?.aborted).toBe(true)
    readAt(f, 0).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: '旧身份过期', retryable: false }))
    readAt(f, 1).resolve(f.preview)
    await settle()
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    expect(f.state.state.value.status).toBe('ready')
    f.scope.stop()
  })

  it('rejects mismatched candidates and cancels a pending read on component disposal', async () => {
    // 错配清单不能就绪，卸载后的重读错误也不能回填或触发认证事件。
    const f = stateFixture()
    const wrong = structuredClone(f.preview)
    wrong.items[0].slotId = 'other-slot'
    readAt(f, 0).resolve(wrong)
    await settle()
    expect(f.state.state.value).toEqual({ status: 'stale' })
    const reloading = f.state.reload()
    f.scope.stop()
    expect(readAt(f, 1).signal?.aborted).toBe(true)
    readAt(f, 1).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: '卸载后的旧响应', retryable: false }))
    expect(await reloading).toBe(false)
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    expect(f.state.state.value).toEqual({ status: 'inactive' })
    expect(f.state.loading.value).toBe(false)
  })
})
