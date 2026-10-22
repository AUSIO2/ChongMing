// 经真实 Mongo/HTTP/公共网关验证窗口状态的收录、读取、撤回、分页和幂等重试。
import { randomUUID } from 'node:crypto'

import { ref } from 'vue'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ClientError, type ClientGateway, type CommandInputMap, type CommandOutputMap } from '../../contracts/client'
import type { EvidenceClaimRef } from '../../contracts/evidence-library'
import type { GraphSuccess } from '../../contracts/graph-api'
import { evidenceCreateState, type EvidenceCollectInput, type EvidenceUiContext } from '../../apps/ui/features/evidence-library/evidence-state'
import { clientCreateGateway } from '../../client/graph-client'
import { evidenceCreateUiFixture } from '../../experiments/evidence-library-tests/ui-fixture'

let fixture: Awaited<ReturnType<typeof evidenceCreateUiFixture>>
beforeAll(async () => {
  // 只启动本套自有副本集和 HTTP，不使用部署数据库或模型/队列。
  fixture = await evidenceCreateUiFixture()
})
afterAll(async () => {
  // 测试失败也关闭 HTTP、公共网关与自有 Mongo 子进程。
  await fixture?.close()
})

function collectParams(
  /* 真实图夹具保存的 Claim 身份与版本。 */ claim: EvidenceClaimRef,
  /* 用户显式选择的固定判断。 */ confidence: 0 | 1,
): EvidenceCollectInput {
  // 给界面状态提供完整收录输入，状态只绑定当前工作区。
  return { claim, confidence, applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
    reason: '界面明确收录这份陈述。', basisRefs: [{ kind: 'manual', text: '人工核对原始记录。' }] }
}

function context(
  /* 本次状态归属的真实工作区。 */ workspaceId: string,
  /* 当前是否在库中浏览，Map 中收录使用 false。 */ active = false,
) {
  // 为测试窗口绑定真实用户、服务与写权限，切换直接触发模块生命周期。
  return ref<EvidenceUiContext>({ userId: fixture.ownerId, connectionKey: fixture.baseUrl,
    workspaceId, active, canEdit: true })
}

describe('evidence window state over real HTTP', () => {
  // 这里验证界面状态接到生产四操作的完整路径，而非重写后端规则。
  it('collects zero from Map, opens the fixed version and retains it after withdrawal', async () => {
    // Map 中收录成功后进入库；原判断和正文在撤回后的详情中继续保留。
    const claim = await fixture.createClaim('窗口收录的陈述完全错误。')
    const scope = context(fixture.workspaceId)
    const state = evidenceCreateState(fixture.gateway, scope)
    try {
      const result = await state.collect(collectParams(claim, 0))
      expect(result?.entry.confidence).toBe(0)
      if (!result) throw new Error('Expected a real collection result')
      scope.value.active = true
      expect(await state.search()).toBe(true)
      expect(state.items.value.some((/* 本工作区真实摘要。 */ item) => /* 找到刚收录的库身份。 */ item.id === result.entry.id)).toBe(true)
      expect(await state.select(result.entry.id)).toBe(true)
      expect(state.entry.value?.claim.nodeSnapshot.payload.content).toBe('窗口收录的陈述完全错误。')
      const withdrawn = await state.withdraw('人工决定撤回。')
      expect(withdrawn).toMatchObject({ id: result.entry.id, confidence: 0, status: 'withdrawn' })
      expect(state.entry.value?.contentDigest).toBe(result.entry.contentDigest)
      expect(state.items.value.some((/* 撤回后实际保留的活动摘要。 */ item) => /* 默认列表不得继续提供撤回条目。 */ item.id === result.entry.id)).toBe(false)
      state.filters.value.includeInactive = true
      expect(await state.search()).toBe(true)
      expect(state.items.value.find((/* 显式历史查询的真实摘要。 */ item) => /* 按旧收录身份读取历史。 */ item.id === result.entry.id)?.status).toBe('withdrawn')
    } finally { state.dispose() }
  })

  it('paginates twenty six real entries, preserves zero filtering and makes a viewer read only', async () => {
    // 独立工作区的 26 条真实收录跨过默认 25 条边界，再以只读身份浏览。
    for (let index = 0; index < 26; index += 1) {
      const claim = await fixture.createClaim(`分页陈述 ${index} uipagination。`, fixture.otherWorkspaceId)
      await fixture.gateway.dispatch(randomUUID(), 'evidence.collect', {
        ...collectParams(claim, index % 2 === 0 ? 0 : 1), workspaceId: fixture.otherWorkspaceId,
      })
    }
    const scope = context(fixture.otherWorkspaceId)
    const state = evidenceCreateState(fixture.gateway, scope)
    const viewer = clientCreateGateway({ baseUrl: fixture.baseUrl })
    try {
      scope.value.active = true
      expect(await state.search()).toBe(true)
      expect(state.items.value).toHaveLength(25)
      expect(state.nextCursor.value).not.toBeNull()
      expect(await state.loadMore()).toBe(true)
      expect(state.items.value).toHaveLength(26)
      expect(new Set(state.items.value.map((/* 完整实际摘要。 */ item) => /* 检查分页身份不重复。 */ item.id)).size).toBe(26)
      state.filters.value.confidence = '0'
      expect(await state.search()).toBe(true)
      expect(state.items.value).toHaveLength(13)
      expect(state.items.value.every((/* 零判断查询的真实摘要。 */ item) => /* 不接受混入的正确判断。 */ item.confidence === 0)).toBe(true)
      await viewer.connect({ baseUrl: fixture.baseUrl, token: fixture.viewerToken, remember: false })
      const viewerScope = ref<EvidenceUiContext>({ userId: fixture.viewerId, connectionKey: fixture.baseUrl,
        workspaceId: fixture.workspaceId, active: true, canEdit: false })
      const viewerState = evidenceCreateState(viewer, viewerScope)
      try {
        expect(await viewerState.search()).toBe(true)
        expect(viewerState.canEdit.value).toBe(false)
        expect(await viewerState.withdraw('不能从只读界面发送。')).toBeNull()
      } finally { viewerState.dispose() }
    } finally {
      state.dispose()
      await viewer.disconnect()
    }
  })

  it('keeps receipt-time conflicts separate from a new duplicate collection and current withdrawn state', async () => {
    // 原收据保留原冲突集合；新请求按当前活动条目重新判重与查相反判断，不重激活任何条目。
    const content = 'c08receipt 收录时点中的原始陈述。'
    const claim = await fixture.createClaim(content), workspaceId = fixture.workspaceId
    const paramsA = { ...collectParams(claim, 0), workspaceId }, firstRequestId = randomUUID()
    const first = await fixture.gateway.dispatch(firstRequestId, 'evidence.collect', paramsA)
    expect(first).toMatchObject({ replayed: false, data: { replayed: false, existing: false, conflictEntryIds: [] } })
    const a = first.data.entry
    const opposite = await fixture.gateway.dispatch(randomUUID(), 'evidence.collect', { ...collectParams(claim, 1), workspaceId })
    const b = opposite.data.entry
    expect(opposite).toMatchObject({ replayed: false, data: { replayed: false, existing: false, conflictEntryIds: [a.id] } })

    expect(await fixture.gateway.dispatch(firstRequestId, 'evidence.collect', paramsA)).toMatchObject({
      replayed: true, data: { replayed: true, existing: false, conflictEntryIds: [], entry: { id: a.id, confidence: 0 } },
    })
    const duplicateRequestId = randomUUID()
    expect(await fixture.gateway.dispatch(duplicateRequestId, 'evidence.collect', paramsA)).toMatchObject({
      replayed: false, data: { replayed: false, existing: true, conflictEntryIds: [b.id], entry: { id: a.id } },
    })
    await fixture.gateway.dispatch(randomUUID(), 'evidence.withdraw', {
      workspaceId, entryId: b.id, expectedRevision: b.revision, reason: '后续撤回相反判断，但保留固定正文。',
    })
    expect(await fixture.gateway.dispatch(randomUUID(), 'evidence.collect', paramsA)).toMatchObject({
      replayed: false, data: { replayed: false, existing: true, conflictEntryIds: [], entry: { id: a.id } },
    })
    expect(await fixture.gateway.dispatch(duplicateRequestId, 'evidence.collect', paramsA)).toMatchObject({
      replayed: true, data: { replayed: true, existing: true, conflictEntryIds: [b.id], entry: { id: a.id, confidence: 0 } },
    })

    expect(await fixture.gateway.read('evidence.get', { workspaceId, entryId: a.id })).toMatchObject({
      id: a.id, confidence: 0, status: 'active', claim: { nodeSnapshot: { payload: { content } } },
    })
    expect(await fixture.gateway.read('evidence.get', { workspaceId, entryId: b.id })).toMatchObject({
      id: b.id, confidence: 1, status: 'withdrawn', claim: { nodeSnapshot: { payload: { content } } },
    })
    const page = await fixture.gateway.read('evidence.search', { workspaceId, query: 'c08receipt', includeInactive: true })
    expect(page.items).toHaveLength(2)
    expect(new Set(page.items.map((/* 本用例实际保留的两个条目。 */ item) => /* 重放和去重不能创造第三个库身份。 */ item.id))).toEqual(new Set([a.id, b.id]))
    expect((await fixture.gateway.read('map.get', { mapId: claim.mapId })).nodes).toContainEqual(expect.objectContaining({
      id: claim.nodeId, revision: claim.revision, payload: expect.objectContaining({ content }),
    }))
  })

  it('retries the original command after losing a committed HTTP response without duplicate collection', async () => {
    // 网络 seam 丢弃一次实际成功响应，真实重试必须使用已提交收据及原始输入。
    const claim = await fixture.createClaim('丢失响应后的原始零判断。')
    let loseResponse = true
    const attemptedIds: string[] = []
    const gateway: ClientGateway = { ...fixture.gateway,
      async dispatch<K extends keyof CommandInputMap>(
        /* 本次业务收据身份，测试记录实际使用的身份。 */ requestId: string,
        /* 转发给实际公共网关的方法。 */ method: K,
        /* 公共协议定义的真实输入。 */ params: CommandInputMap[K],
        /* 界面拥有的取消信号。 */ signal?: AbortSignal,
      ): Promise<GraphSuccess<CommandOutputMap[K]>> {
        // 写入先经真实 HTTP 完成，随后只在返回 seam 制造客户端未知结果。
        attemptedIds.push(requestId)
        const result = await fixture.gateway.dispatch(requestId, method, params, signal)
        if (loseResponse) {
          loseResponse = false
          throw new ClientError({ code: 'REQUEST_FAILED', message: 'Lost test response', status: 0, retryable: true })
        }
        return result
      },
    }
    const scope = context(fixture.workspaceId)
    const state = evidenceCreateState(gateway, scope)
    try {
      const params = collectParams(claim, 0)
      expect(await state.collect(params)).toBeNull()
      expect(state.canRetry.value).toBe(true)
      expect(state.collectionOutcome.value).toBeNull()
      params.confidence = 1
      params.reason = '后续草稿不能改写原收据。'
      expect(await state.retry()).toBe(true)
      expect(attemptedIds).toHaveLength(2)
      expect(attemptedIds[1]).toBe(attemptedIds[0])
      expect(state.entry.value).toMatchObject({ confidence: 0, decision: { reason: '界面明确收录这份陈述。' } })
      expect(state.collectionOutcome.value).toMatchObject({ replayed: true, existing: false, conflictEntryIds: [],
        entry: { confidence: 0, decision: { reason: '界面明确收录这份陈述。' } } })
      const page = await fixture.gateway.read('evidence.search', { workspaceId: fixture.workspaceId, query: '丢失响应后的原始零判断' })
      expect(page.items).toHaveLength(1)
    } finally { state.dispose() }
  })
})
