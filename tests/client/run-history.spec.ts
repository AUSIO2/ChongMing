// C11先行：运行历史只读目录与单份详情隔离身份、分页和迟到响应。
import { effectScope, shallowReactive, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClientError, type ClientGateway, type QueryInputMap, type QueryOutputMap } from '../../contracts/client'
import type { GraphRun, GraphRunPage, GraphRunSummary } from '../../contracts/graph-run'
import { runCreateRun } from '../../backend/modules/graph/run-state'
import { libraryTestCatalog, libraryTestDocument, libraryTestStartInput, LIBRARY_TEST_AGENT, LIBRARY_TEST_TIME } from '../backend/fixtures/library-claims'
import { useRunHistory, type RunHistoryContext } from '../../apps/ui/features/run/run-history'
import type { OperationOriginTarget } from '../../apps/ui/features/graph/node-origin'

enum HistoryTestMessage {
  RUN_MISSING = 'Expected history fixture Run',
  READ_MISSING = 'Expected history query',
  UNEXPECTED = 'Unexpected history transport',
}
type ReadValue = GraphRun | GraphRunPage
interface ReadCall {
  method: 'run.list' | 'run.get'
  params: QueryInputMap['run.list'] | QueryInputMap['run.get']
  signal?: AbortSignal
  resolve: (/* 测试主动交付的目录或单份详情。 */ value: ReadValue) => void
  reject: (/* 测试主动交付的查询失败。 */ cause: unknown) => void
}
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  // 失败断言也释放测试自有Vue作用域，避免请求存活到后续用例。
  for (const scope of scopes.splice(0)) scope.stop()
})

/** 建立一份真实冻结Run，目录测试不自行拼造完整运行合同。 */
function historyRun(): GraphRun {
  // 复用已有真实冻结规格，只固定运行身份供目录与详情对照。
  const { document, input } = libraryTestDocument()
  runCreateRun(document, libraryTestStartInput(document, input.id, []), {
    definitions: libraryTestCatalog(), agents: [LIBRARY_TEST_AGENT], tools: [], maxSlots: 4, libraryClaimSets: [],
  }, LIBRARY_TEST_TIME)
  const run = document.runs[0]
  if (!run) throw new Error(HistoryTestMessage.RUN_MISSING)
  return run
}

/** 从保存的Run形成轻摘要，数量细则由后端目录用例覆盖。 */
function summary(
  /* 当前列表中的稳定运行身份。 */ runId: string,
): GraphRunSummary {
  // 仅返回目录公开字段，不夹带正文或完整Operation。
  return { runId, status: 'completed', archived: true, mode: 'human-in-loop', paused: false,
    createdAt: LIBRARY_TEST_TIME, updatedAt: LIBRARY_TEST_TIME,
    stepCount: 1, operationCount: 1, pendingReviewCount: 0, outputCount: 1 }
}

/** 创建忽略取消仍可回包的网关，直接验证组件自身的代次隔离。 */
function stateFixture(
  /* 首次打开条件；测试可在完整身份上覆盖active或supported。 */ initial: Partial<RunHistoryContext> = {},
) {
  // 两类查询都由测试主动完成，写接口若被调用立即失败。
  const run = historyRun()
  const context = shallowRef<RunHistoryContext>(shallowReactive({ userId: 'viewer', connectionKey: 'service-a', workspaceId: 'workspace-a',
    mapId: 'map-a', active: true, supported: true, ...initial }))
  const reads: ReadCall[] = []
  const unexpected = vi.fn(async (): Promise<never> => { /* 历史没有任何控制或写入意图。 */ throw new Error(HistoryTestMessage.UNEXPECTED) })
  const gateway: ClientGateway = {
    watch: unexpected, getConnection: unexpected, connect: unexpected, disconnect: unexpected,
    dispatch: unexpected, upload: unexpected, download: unexpected,
    async read<K extends keyof QueryInputMap>(
      /* 历史只允许目录和按需详情。 */ method: K,
      /* 已固定的Map、分页或运行身份。 */ params: QueryInputMap[K],
      /* 组件作用域拥有的取消信号。 */ signal?: AbortSignal,
    ): Promise<QueryOutputMap[K]> {
      // 类型参数不能随method窄化；分支已限制到两个确定的只读合同。
      if (method !== 'run.list' && method !== 'run.get') return unexpected()
      const value = await new Promise<ReadValue>((/* 测试主动交付成功。 */ resolve, /* 测试主动交付失败。 */ reject) => {
        reads.push({ method, params: params as QueryInputMap['run.list'] | QueryInputMap['run.get'], signal, resolve, reject })
      })
      return value as QueryOutputMap[K]
    },
  }
  const onUnauthorized = vi.fn()
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => /* 目录与详情的读取生命周期只属于该面板。 */ useRunHistory(gateway, context, onUnauthorized))
  if (!state) throw new Error(HistoryTestMessage.RUN_MISSING)
  const page = (/* 需要返回的目录身份。 */ ids: string[], /* 当前目录版本。 */ version = 'directory-a', /* 可选下一页游标。 */ cursor: string | null = null): GraphRunPage =>
    /* 明确保留Map与目录版本供接纳时核对。 */ ({ mapId: context.value.mapId ?? 'map-a', items: ids.map(summary), nextCursor: cursor, directoryVersion: version })
  return { run, context, reads, gateway, unexpected, onUnauthorized, scope, state, page }
}

/** 读取实际已发起的查询，缺查询时明确失败而不使用非空断言。 */
function readAt(
  /* 当前面板状态夹具。 */ fixture: ReturnType<typeof stateFixture>,
  /* 实际查询的零起始顺序。 */ index: number,
): ReadCall {
  // 严格使用真实请求顺序，使多查或漏查都可定位。
  const value = fixture.reads[index]
  if (!value) throw new Error(HistoryTestMessage.READ_MISSING)
  return value
}

/** 排空已经交付的网关与Vue微任务，不使用定时器猜测。 */
async function settle(): Promise<void> {
  // 只等待本轮读取接纳，不引入后台轮询或真实延时。
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
}

function reuseTarget(
  /* 已保存且带精确产物引用的来源运行。 */ run: GraphRun,
): OperationOriginTarget {
  // 只建立已保存Operation的直接来源目标，不从Work身份猜运行。
  const operation = run.operations[0]
  if (!operation) throw new Error(HistoryTestMessage.RUN_MISSING)
  operation.status = 'completed'
  return { kind: 'reuse', operationId: operation.id, source: {
    id: 'reused-operation', transitionRef: structuredClone(operation.transitionRef), specHash: operation.specHash,
    outputRefs: structuredClone(operation.outputRefs),
  } }
}

describe('C11 independent read-only Run history', () => {
  // 目录与详情各自拥有状态；不存在session写入或运行控制调用。
  it('does not read while closed or unsupported and opens with one bounded directory query', async () => {
    // 关闭与旧服务都不探测未知方法，打开后首读25条而不预载详情。
    const f = stateFixture({ active: false })
    expect(f.reads).toHaveLength(0)
    expect(await f.state.refresh()).toBe(false)
    f.context.value.supported = false
    f.context.value.active = true
    expect(f.reads).toHaveLength(0)
    f.context.value.supported = true
    expect(readAt(f, 0)).toMatchObject({ method: 'run.list', params: { mapId: 'map-a', limit: 25 } })
    expect(f.state.loading.value).toBe(true)
    readAt(f, 0).resolve(f.page([f.run.id]))
    await settle()
    expect(f.state.items.value.map((/* 目录公开摘要。 */ item) => /* 只核对运行身份。 */ item.runId)).toEqual([f.run.id])
    expect(f.state.selectedId.value).toBeNull()
    expect(f.state.detail.value).toBeNull()
    expect(f.reads).toHaveLength(1)
    expect(f.unexpected).not.toHaveBeenCalled()
  })

  it('continues only the accepted cursor and keeps a single on-demand detail', async () => {
    // 翻页沿成功目录版本，选择详情使用run.get且不改当前运行控制。
    const f = stateFixture()
    readAt(f, 0).resolve(f.page([f.run.id], 'directory-a', 'cursor-a'))
    await settle()
    const more = f.state.loadMore()
    expect(readAt(f, 1)).toMatchObject({ method: 'run.list', params: { mapId: 'map-a', limit: 25, cursor: 'cursor-a' } })
    readAt(f, 1).resolve(f.page(['run-b']))
    expect(await more).toBe(true)
    expect(f.state.items.value.map((/* 已接纳的摘要。 */ item) => /* 保持服务端页序。 */ item.runId)).toEqual([f.run.id, 'run-b'])
    const selection = f.state.select(f.run.id)
    expect(readAt(f, 2)).toMatchObject({ method: 'run.get', params: { mapId: 'map-a', runId: f.run.id } })
    readAt(f, 2).resolve(f.run)
    expect(await selection).toBe(true)
    expect(f.state.detail.value?.id).toBe(f.run.id)
    expect(f.state.selectedId.value).toBe(f.run.id)
    expect(f.state.directoryVersion.value).toBe('directory-a')
    expect(f.unexpected).not.toHaveBeenCalled()
  })

  it('stops an expired continuation and explicitly refreshes from page one without old detail', async () => {
    // 过期保留已读目录，停止继续追加，只有手动刷新建立新第一页。
    const f = stateFixture()
    readAt(f, 0).resolve(f.page([f.run.id], 'directory-a', 'cursor-a'))
    await settle()
    const selected = f.state.select(f.run.id)
    readAt(f, 1).resolve(f.run)
    await selected
    const more = f.state.loadMore()
    readAt(f, 2).reject(new ClientError({ status: 409, code: 'RUN_CURSOR_EXPIRED', message: '目录已变化', retryable: false }))
    expect(await more).toBe(false)
    expect(f.state.cursorExpired.value).toBe(true)
    expect(f.state.nextCursor.value).toBeNull()
    expect(f.state.items.value).toHaveLength(1)
    expect(await f.state.loadMore()).toBe(false)
    const refreshing = f.state.refresh()
    expect(f.state.selectedId.value).toBeNull()
    expect(f.state.detail.value).toBeNull()
    expect(readAt(f, 3).params).toEqual({ mapId: 'map-a', limit: 25 })
    readAt(f, 3).resolve(f.page(['run-new'], 'directory-b'))
    expect(await refreshing).toBe(true)
    expect(f.state.cursorExpired.value).toBe(false)
    expect(f.state.items.value.map((/* 新目录公开摘要。 */ item) => /* 不拼接旧目录。 */ item.runId)).toEqual(['run-new'])
  })

  it('rejects a different continuation version rather than appending another directory', async () => {
    // 即使网关返回成功，续页版本错配也不能把两个目录拼成一个。
    const f = stateFixture()
    readAt(f, 0).resolve(f.page([f.run.id], 'directory-a', 'cursor-a'))
    await settle()
    const more = f.state.loadMore()
    readAt(f, 1).resolve(f.page(['run-new'], 'directory-b'))
    expect(await more).toBe(false)
    expect(f.state.error.value?.code).toBe('RUN_CURSOR_EXPIRED')
    expect(f.state.cursorExpired.value).toBe(true)
    expect(f.state.items.value.map((/* 原已接纳的摘要。 */ item) => /* 错版续页没有混入。 */ item.runId)).toEqual([f.run.id])
  })

  it('separates list and detail failures and lets the same detail be retried', async () => {
    // 详情失败只影响详情区域，目录失败也不清掉已经读到的单份详情。
    const f = stateFixture()
    readAt(f, 0).resolve(f.page([f.run.id], 'directory-a', 'cursor-a'))
    await settle()
    const first = f.state.select(f.run.id)
    readAt(f, 1).reject(new ClientError({ status: 503, code: 'UNAVAILABLE', message: '详情暂不可用', retryable: true }))
    expect(await first).toBe(false)
    expect(f.state.detailError.value?.code).toBe('UNAVAILABLE')
    expect(f.state.error.value).toBeNull()
    expect(f.state.items.value).toHaveLength(1)
    const retrying = f.state.select(f.run.id)
    readAt(f, 2).resolve(f.run)
    expect(await retrying).toBe(true)
    expect(f.state.detailError.value).toBeNull()
    const more = f.state.loadMore()
    readAt(f, 3).reject(new ClientError({ status: 503, code: 'UNAVAILABLE', message: '目录暂不可用', retryable: true }))
    expect(await more).toBe(false)
    expect(f.state.error.value?.code).toBe('UNAVAILABLE')
    expect(f.state.detail.value?.id).toBe(f.run.id)
    expect(f.state.detailError.value).toBeNull()
  })

  it('isolates A to B to A detail attempts and rejects a mismatched returned Run', async () => {
    // 回到同一runId也需要新代次，旧A与B都不能覆盖最新A。
    const f = stateFixture()
    readAt(f, 0).resolve(f.page([f.run.id, 'run-b']))
    await settle()
    const firstA = f.state.select(f.run.id)
    const b = f.state.select('run-b')
    const lastA = f.state.select(f.run.id)
    expect(readAt(f, 1).signal?.aborted).toBe(true)
    expect(readAt(f, 2).signal?.aborted).toBe(true)
    readAt(f, 3).resolve(f.run)
    expect(await lastA).toBe(true)
    readAt(f, 1).resolve({ ...f.run, updatedAt: '2026-10-07T00:00:01.000Z' })
    readAt(f, 2).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: '旧详情身份过期', retryable: false }))
    expect(await firstA).toBe(false)
    expect(await b).toBe(false)
    expect(f.state.detail.value?.updatedAt).toBe(f.run.updatedAt)
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    const mismatch = f.state.select('run-b')
    readAt(f, 4).resolve(f.run)
    expect(await mismatch).toBe(false)
    expect(f.state.detail.value).toBeNull()
    expect(f.state.detailError.value?.code).toBe('INVALID_RESPONSE')
  })

  it.each(['userId', 'connectionKey', 'workspaceId', 'mapId'] as const)('clears both channels when %s changes and ignores old success and old unauthorized replies', async (/* 更换的面板身份维度。 */ field) => {
    // 四个身份维度都结束前一目录与详情，不让旧401结束后来会话。
    const f = stateFixture()
    readAt(f, 0).resolve(f.page([f.run.id], 'directory-a', 'cursor-a'))
    await settle()
    const more = f.state.loadMore()
    const selected = f.state.select(f.run.id)
    f.context.value[field] = `${field}-new`
    expect(readAt(f, 1).signal?.aborted).toBe(true)
    expect(readAt(f, 2).signal?.aborted).toBe(true)
    expect(f.state.items.value).toEqual([])
    expect(f.state.selectedId.value).toBeNull()
    expect(f.state.detail.value).toBeNull()
    readAt(f, 1).resolve({ mapId: 'map-a', items: [summary('late-run')], directoryVersion: 'directory-a', nextCursor: null })
    readAt(f, 2).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: '旧身份过期', retryable: false }))
    expect(await more).toBe(false)
    expect(await selected).toBe(false)
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    readAt(f, 3).resolve(f.page(['current-run'], 'directory-new'))
    await settle()
    expect(f.state.items.value.map((/* 新身份目录。 */ item) => /* 旧目录没有混入。 */ item.runId)).toEqual(['current-run'])
  })

  it('closes and disposes both reads without accepting late results or querying on an equivalent context', async () => {
    // 同身份对象替换不触发读取；关闭和卸载都清空并使两类迟到回包失效。
    const f = stateFixture()
    readAt(f, 0).resolve(f.page([f.run.id], 'directory-a', 'cursor-a'))
    await settle()
    f.context.value = shallowReactive({ ...f.context.value })
    expect(f.reads).toHaveLength(1)
    const more = f.state.loadMore()
    const selected = f.state.select(f.run.id)
    f.context.value.active = false
    expect(readAt(f, 1).signal?.aborted).toBe(true)
    expect(readAt(f, 2).signal?.aborted).toBe(true)
    expect(f.state.items.value).toEqual([])
    expect(f.state.detail.value).toBeNull()
    expect(f.state.loading.value).toBe(false)
    expect(f.state.detailLoading.value).toBe(false)
    readAt(f, 1).resolve(f.page(['late-run']))
    readAt(f, 2).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: '关闭后的旧身份', retryable: false }))
    expect(await more).toBe(false)
    expect(await selected).toBe(false)
    f.context.value.active = true
    expect(f.reads).toHaveLength(4)
    f.scope.stop()
    expect(readAt(f, 3).signal?.aborted).toBe(true)
    readAt(f, 3).resolve(f.page(['disposed-run']))
    await settle()
    expect(f.state.items.value).toEqual([])
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    expect(await f.state.refresh()).toBe(false)
  })

  it('notifies authorization loss only for the current request', async () => {
    // 当前401交由会话所有者处理；Map身份由公共客户端边界校验。
    const f = stateFixture()
    readAt(f, 0).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: '当前身份过期', retryable: false }))
    await settle()
    expect(f.onUnauthorized).toHaveBeenCalledTimes(1)
    expect(f.state.error.value?.code).toBe('UNAUTHORIZED')
    expect(f.unexpected).not.toHaveBeenCalled()
  })
})

describe('C12 exact Operation origin in read-only Run history', () => {
  // 来源过滤与详情沿原目录生命周期，当前运行控制和写入意图不参与。
  it('preserves the exact Operation filter on initial, continuation and refresh reads and resolves only a complete unique directory', async () => {
    // 首次不完整目录即使只有一项也不自动选，刷新后的完整唯一项才读取详情。
    const f = stateFixture({ active: false })
    const target = reuseTarget(f.run)
    f.context.value = shallowReactive({ ...f.context.value, active: true, target })
    const originalParams = { mapId: 'map-a', limit: 25, operationId: target.operationId }
    expect(readAt(f, 0).params).toEqual(originalParams)
    readAt(f, 0).resolve(f.page([f.run.id], 'source-directory', 'source-cursor'))
    await settle()
    expect(f.reads).toHaveLength(1)
    const more = f.state.loadMore()
    expect(readAt(f, 1).params).toEqual({ ...originalParams, cursor: 'source-cursor' })
    readAt(f, 1).resolve(f.page(['second-run'], 'source-directory'))
    expect(await more).toBe(true)
    expect(f.reads).toHaveLength(2)
    const refreshed = f.state.refresh()
    expect(readAt(f, 2).params).toEqual(originalParams)
    readAt(f, 2).resolve(f.page([f.run.id], 'source-directory'))
    expect(await refreshed).toBe(true)
    expect(readAt(f, 3)).toMatchObject({ method: 'run.get', params: { mapId: 'map-a', runId: f.run.id } })
    readAt(f, 3).resolve(f.run)
    await settle()
    expect(f.state.detail.value?.id).toBe(f.run.id)
    expect(f.context.value.target).toEqual(target)
    expect(readAt(f, 0).params).toEqual(originalParams)
    expect(f.unexpected).not.toHaveBeenCalled()
  })

  it('does not guess a missing or ambiguous source and accepts only an explicitly chosen matching detail', async () => {
    // 空目录不猜runId，多项保留供用户选；选择后仍核对真实Operation。
    const f = stateFixture({ active: false })
    const target = reuseTarget(f.run)
    f.context.value = shallowReactive({ ...f.context.value, active: true, target })
    readAt(f, 0).resolve(f.page([]))
    await settle()
    expect(f.reads).toHaveLength(1)
    expect(f.state.detail.value).toBeNull()
    const refreshed = f.state.refresh()
    readAt(f, 1).resolve(f.page([f.run.id, 'other-matching-run']))
    expect(await refreshed).toBe(true)
    expect(f.reads).toHaveLength(2)
    expect(f.state.items.value).toHaveLength(2)
    const chosen = f.state.select(f.run.id)
    readAt(f, 2).resolve(f.run)
    expect(await chosen).toBe(true)
    expect(f.state.detail.value?.id).toBe(f.run.id)
    expect(f.unexpected).not.toHaveBeenCalled()
  })

  it.each(['operation', 'mapping'] as const)('rejects a source detail with mismatched %s while retaining the fixed target and chosen Run', async (/* 损坏的来源关联维度。 */ mismatch) => {
    // 返回Run身份正确也不足以证明来源，错Operation或产物映射都不展示为已核实记录。
    const f = stateFixture({ active: false })
    const target = reuseTarget(f.run)
    f.context.value = shallowReactive({ ...f.context.value, active: true, target })
    readAt(f, 0).resolve(f.page([f.run.id, 'another-source-run']))
    await settle()
    const chosen = f.state.select(f.run.id)
    const broken = structuredClone(f.run)
    const operation = broken.operations[0]
    if (!operation) throw new Error(HistoryTestMessage.RUN_MISSING)
    if (mismatch === 'operation') operation.id = 'another-operation'
    else operation.outputRefs = [{ id: 'unexpected-output', revision: 1, port: 'opinion', workId: 'another-work', key: 'another-key' }]
    readAt(f, 1).resolve(broken)
    expect(await chosen).toBe(false)
    expect(f.state.detail.value).toBeNull()
    expect(f.state.detailError.value?.code).toBe('INVALID_RESPONSE')
    expect(f.state.detailError.value?.message).toContain('来源')
    expect(f.state.selectedId.value).toBe(f.run.id)
    expect(f.context.value.target).toEqual(target)
    expect(f.unexpected).not.toHaveBeenCalled()
  })

  it('isolates source target A to B to A and ignores stale success and unauthorized detail responses', async () => {
    // 回到相同Operation仍有新代次，旧成功和旧401不能覆盖最后一次来源导航。
    const f = stateFixture({ active: false })
    const targetA = reuseTarget(f.run)
    const targetB: OperationOriginTarget = { ...targetA, operationId: 'source-operation-b' }
    f.context.value = shallowReactive({ ...f.context.value, active: true, target: targetA })
    readAt(f, 0).resolve(f.page([f.run.id]))
    await settle()
    f.context.value = shallowReactive({ ...f.context.value, target: targetB })
    expect(readAt(f, 1).signal?.aborted).toBe(true)
    expect(readAt(f, 2).params).toEqual({ mapId: 'map-a', limit: 25, operationId: targetB.operationId })
    readAt(f, 2).resolve(f.page(['source-run-b']))
    await settle()
    f.context.value = shallowReactive({ ...f.context.value, target: targetA })
    expect(readAt(f, 3).signal?.aborted).toBe(true)
    expect(f.state.selectedId.value).toBeNull()
    expect(f.state.detail.value).toBeNull()
    readAt(f, 4).resolve(f.page([f.run.id]))
    await settle()
    readAt(f, 5).resolve(f.run)
    await settle()
    readAt(f, 1).resolve({ ...f.run, updatedAt: '2026-10-20T12:00:00.000Z' })
    readAt(f, 3).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: '旧来源身份过期', retryable: false }))
    await settle()
    expect(f.state.detail.value?.updatedAt).toBe(f.run.updatedAt)
    expect(f.state.detailError.value).toBeNull()
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    expect(f.unexpected).not.toHaveBeenCalled()
  })

  it('restarts for a changed saved mapping and returns to an unfiltered directory when the source target is cleared', async () => {
    // 来源身份包含保存映射而不只OperationID；返回全部目录清掉精确过滤。
    const f = stateFixture({ active: false })
    const target = reuseTarget(f.run)
    f.context.value = shallowReactive({ ...f.context.value, active: true, target })
    readAt(f, 0).resolve(f.page([]))
    await settle()
    const changed = structuredClone(target)
    if (changed.kind !== 'reuse') throw new Error(HistoryTestMessage.RUN_MISSING)
    changed.source.outputRefs = [{ id: 'saved-output', revision: 1, port: 'opinion', workId: 'saved-work', key: 'saved-key' }]
    f.context.value = shallowReactive({ ...f.context.value, target: changed })
    expect(readAt(f, 1).params).toEqual({ mapId: 'map-a', limit: 25, operationId: target.operationId })
    f.context.value = shallowReactive({ ...f.context.value, target: undefined })
    expect(readAt(f, 1).signal?.aborted).toBe(true)
    expect(readAt(f, 2).params).toEqual({ mapId: 'map-a', limit: 25 })
    readAt(f, 2).resolve(f.page([f.run.id]))
    await settle()
    expect(f.reads).toHaveLength(3)
    expect(f.state.selectedId.value).toBeNull()
    expect(f.state.detail.value).toBeNull()
  })

  it('fixes the saved producer node version in the source identity without reacting to equivalent target objects', async () => {
    // 同一节点的新版本需要重新定位，等值来源对象替换不会重复读取目录。
    const f = stateFixture({ active: false })
    const operation = f.run.operations[0]
    if (!operation) throw new Error(HistoryTestMessage.RUN_MISSING)
    const target: OperationOriginTarget = { kind: 'producer', operationId: operation.id, node: {
      id: 'generated-node', revision: 0, typeId: 'fixture.library-opinion', typeVersion: 1,
      producer: { operationId: operation.id, transitionRef: structuredClone(operation.transitionRef), stageId: 'assess',
        workId: 'saved-work', agentRef: structuredClone(LIBRARY_TEST_AGENT.ref), agentName: LIBRARY_TEST_AGENT.profile.name },
    } }
    f.context.value = shallowReactive({ ...f.context.value, active: true, target })
    readAt(f, 0).resolve(f.page([]))
    await settle()
    f.context.value = shallowReactive({ ...f.context.value, target: structuredClone(target) })
    expect(f.reads).toHaveLength(1)
    f.context.value = shallowReactive({ ...f.context.value, target: { ...target, node: { ...target.node, revision: 1 } } })
    expect(readAt(f, 1).params).toEqual({ mapId: 'map-a', limit: 25, operationId: target.operationId })
    expect(f.state.detail.value).toBeNull()
    expect(f.context.value.target?.kind === 'producer' && f.context.value.target.node.revision).toBe(1)
  })

  it('accepts the original producer record after a node edit and preserves publication revision zero', async () => {
    // 当前节点变版只需提示差异，详情仍是精确产物映射和发布时保存候选。
    const f = stateFixture({ active: false })
    const operation = f.run.operations[0]
    if (!operation) throw new Error(HistoryTestMessage.RUN_MISSING)
    operation.status = 'completed'
    operation.outputRefs = [{ id: 'generated-node', revision: 0, port: 'opinion', workId: 'saved-work', key: 'saved-key' }]
    operation.stages = [{ stageId: 'assess', expectedWorkIds: ['saved-work'], closed: true, planSlots: [], results: [{
      workId: 'saved-work', stageId: 'assess', slotId: 'saved-slot', acceptedAt: LIBRARY_TEST_TIME, reason: '已保存的产物', mode: 'outputs',
      outputs: [{ key: 'saved-key', port: 'opinion', typeRef: { id: 'fixture.library-opinion', version: 1 },
        payload: { score: 0.5, reason: '发布时保存正文' }, nodeId: 'generated-node' }],
    }] }]
    const target: OperationOriginTarget = { kind: 'producer', operationId: operation.id, node: {
      id: 'generated-node', revision: 1, typeId: 'fixture.library-opinion', typeVersion: 1,
      producer: { operationId: operation.id, transitionRef: structuredClone(operation.transitionRef), stageId: 'assess',
        workId: 'saved-work', agentRef: structuredClone(LIBRARY_TEST_AGENT.ref), agentName: LIBRARY_TEST_AGENT.profile.name },
    } }
    f.context.value = shallowReactive({ ...f.context.value, active: true, target })
    readAt(f, 0).resolve(f.page([f.run.id]))
    await settle()
    readAt(f, 1).resolve(f.run)
    await settle()
    expect(f.state.detail.value?.id).toBe(f.run.id)
    expect(f.state.originOutputRevision.value).toBe(0)
    expect(f.context.value.target?.kind === 'producer' && f.context.value.target.node.revision).toBe(1)
    expect(f.state.detailError.value).toBeNull()
    expect(f.unexpected).not.toHaveBeenCalled()
  })
})
