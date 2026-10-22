// 在公共网关 seam 控制结果时序，验证窗口隔离、分页基线和原命令重试。
import { effectScope, reactive, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { ClientError, type ClientGateway, type CommandInputMap, type CommandOutputMap, type QueryInputMap,
  type QueryOutputMap } from '../../contracts/client'
import type { EvidenceCollectParams, EvidenceCollectResult, EvidenceLibraryEntry, EvidencePage } from '../../contracts/evidence-library'
import type { GraphSuccess } from '../../contracts/graph-api'
import { evidenceCreateState, type EvidenceCollectInput, type EvidenceUiContext } from '../../apps/ui/features/evidence-library/evidence-state'

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void }
interface ReadCall extends Deferred<EvidencePage | EvidenceLibraryEntry> {
  method: keyof QueryInputMap
  params: unknown
  signal?: AbortSignal
}
interface WriteCall extends Deferred<EvidenceCollectResult | EvidenceLibraryEntry> {
  method: keyof CommandInputMap
  requestId: string
  params: unknown
  signal?: AbortSignal
}

/** 建立测试可控制完成时机的 Promise，不以 sleep 猜测请求竞态。 */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => { /* Promise 构造器会同步替换此入口。 */ }
  let reject: (cause: unknown) => void = () => { /* Promise 构造器会同步替换此入口。 */ }
  const promise = new Promise<T>((
    /* Promise 的成功完成入口。 */ accept,
    /* Promise 的异常完成入口。 */ fail,
  ) => {
    // 保留测试推进时序所需的成功和拒绝入口。
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

/**
 * 建立完整网关协议的受控 seam，查询和命令只允许本测试覆盖的证据库方法。
 * @param options 初始库活动状态与写权限，默认活动且可编辑。
 */
function fixture(options: { active?: boolean; canEdit?: boolean } = {}) {
  const reads: ReadCall[] = []
  const relationsReads: Array<{ params: unknown; signal?: AbortSignal }> = []
  const writes: WriteCall[] = []
  const context = ref<EvidenceUiContext>({
    userId: 'user-a', connectionKey: 'http://service-a', workspaceId: 'workspace-a',
    active: options.active ?? true, canEdit: options.canEdit ?? true,
  })
  const onUnauthorized = vi.fn()
  const gateway: ClientGateway = {
    /** 此状态套件不建立图订阅。 */
    async watch() { throw new Error('Unexpected watch') },
    /** 此状态套件不改变连接。 */
    async getConnection() { throw new Error('Unexpected getConnection') },
    /** 此状态套件不执行登录。 */
    async connect() { throw new Error('Unexpected connect') },
    /** 退出由认证通知测试观察，不在状态内重新实现连接。 */
    async disconnect() { throw new Error('Unexpected disconnect') },
    /**
     * 记录实际公开查询并由测试交付成功或失败；本地断言仅处理已限制的泛型方法。
     * @param method 状态提交的公开查询名；新增关系读取使用独立记录，不改变原用例时序。
     * @param params 状态提交的查询输入，原引用保留以核验副本隔离。
     * @param signal 状态持有的取消信号，即使取消仍可故意交付旧结果。
     */
    async read<K extends keyof QueryInputMap>(
      method: K,
      params: QueryInputMap[K],
      signal?: AbortSignal,
    ): Promise<QueryOutputMap[K]> {
      if (method === 'evidence.relations') {
        relationsReads.push({ params, signal })
        // 泛型 K 不随 method 缩窄；公开查询映射保证此分支只有关系查询参数。
        const input = params as QueryInputMap['evidence.relations']
        // 原 090 用例使用旧记录语义，不改变原 get/search 索引和断言。
        return { workspaceId: input.workspaceId, entryId: input.entryId, contentDigest: `digest-${input.entryId}`, snapshot: null } as QueryOutputMap[K]
      }
      if (method !== 'evidence.search' && method !== 'evidence.get') throw new Error('Unexpected evidence query')
      const call: ReadCall = { ...deferred<EvidencePage | EvidenceLibraryEntry>(), method, params, signal }
      reads.push(call)
      // TypeScript 不缩窄泛型映射 K；上面的运行时限制确保结果只属于此 seam 的两种库协议。
      return await call.promise as QueryOutputMap[K]
    },
    /**
     * 记录原命令编号和输入，由测试制造不确定提交与重试。
     * @param requestId 本次业务命令的稳定身份。
     * @param method 只接受已实现的收录和撤回命令。
     * @param params 状态冻结后交给网关的独立输入副本。
     * @param signal 状态持有的命令取消信号。
     */
    async dispatch<K extends keyof CommandInputMap>(
      requestId: string,
      method: K,
      params: CommandInputMap[K],
      signal?: AbortSignal,
    ): Promise<GraphSuccess<CommandOutputMap[K]>> {
      if (method !== 'evidence.collect' && method !== 'evidence.withdraw') throw new Error('Unexpected evidence command')
      const call: WriteCall = { ...deferred<EvidenceCollectResult | EvidenceLibraryEntry>(), requestId, method, params, signal }
      writes.push(call)
      // 与查询 seam 一样，泛型映射的局部断言只覆盖以上限制的两个公开库命令。
      const data = await call.promise as CommandOutputMap[K]
      return { ok: true, requestId, replayed: false, data }
    },
    /** 此状态套件不上传资产。 */
    async upload() { throw new Error('Unexpected upload') },
    /** 此状态套件不下载文件。 */
    async download() { throw new Error('Unexpected download') },
  }
  const state = evidenceCreateState(gateway, context, onUnauthorized)
  return { state, context, reads, relationsReads, writes, onUnauthorized }
}

/**
 * 取得必须已经发出的查询，缺少请求时给出明确测试失败。
 * @param f 当前测试窗口环境。
 * @param index 预期已发出的查询序号。
 */
function readAt(f: ReturnType<typeof fixture>, index: number): ReadCall {
  const call = f.reads[index]
  if (!call) throw new Error('Expected evidence read is missing')
  return call
}

/**
 * 取得必须已经发出的写请求，避免非空断言掩盖生命周期错误。
 * @param f 当前测试窗口环境。
 * @param index 预期已发出的命令序号。
 */
function writeAt(f: ReturnType<typeof fixture>, index: number): WriteCall {
  const call = f.writes[index]
  if (!call) throw new Error('Expected evidence write is missing')
  return call
}

/**
 * 生成固定 Claim 的合法库详情，来源身份与库条目身份保持区别。
 * @param id 固定库条目编号。
 * @param overrides 本场景需要变化的条目状态或版本。
 */
function libraryEntry(id: string, overrides: Partial<EvidenceLibraryEntry> = {}): EvidenceLibraryEntry {
  const time = '2026-10-06T01:00:00.000Z'
  return {
    id, workspaceId: 'workspace-a', revision: 1,
    claim: {
      origin: { mapId: 'map-a', nodeId: 'claim-a', revision: 3 }, type: { id: 'factcheck.claim', version: 1 },
      definitionDigest: 'definition-digest',
      nodeSnapshot: { id: 'claim-a', revision: 3, typeId: 'factcheck.claim', typeVersion: 1,
        payload: { content: `固定陈述 ${id}` }, createdAt: time, updatedAt: time },
    },
    confidence: 0,
    applicability: { subject: '主体', event: null, time: null, place: null, conditions: ['条件'] },
    decision: { reason: '确定错误的理由', basisRefs: [{ kind: 'manual', text: '原始依据' }] },
    collectedBy: 'user-a', collectedAt: time, contentDigest: `digest-${id}`,
    status: 'active', statusReason: null, replacementEntryId: null,
    ...overrides,
  }
}

/**
 * 生成与公开库分页协议一致的摘要页。
 * @param ids 本页返回的固定条目编号。
 * @param options 本场景的后续游标和库 revision。
 */
function page(ids: string[], options: { nextCursor?: string | null; revision?: number } = {}): EvidencePage {
  return { items: ids.map(
    /* 本页单个固定条目编号。 */ id => /* 摘要只有浏览所需字段，不载入 GraphSnapshot。 */
      ({ id, content: `固定陈述 ${id}`, confidence: 0, contentDigest: `digest-${id}`, status: 'active' }),
  ), nextCursor: options.nextCursor ?? null, libraryRevision: options.revision ?? 4 }
}

/** 生成可变收录草稿，覆盖范围、时间和多种嵌套引用依据。 */
function collectDraft(): EvidenceCollectInput {
  return {
    claim: { mapId: 'map-a', nodeId: 'claim-a', revision: 3 }, confidence: 0, reason: '原判断理由',
    applicability: { subject: '主体', event: '事件', time: { from: '2026-01-01', to: '2026-12-31' }, place: null,
      conditions: ['原条件'] },
    basisRefs: [{ kind: 'manual', text: '原人工依据' }, { kind: 'node', ref: { mapId: 'map-a', nodeId: 'basis-a', revision: 2 } },
      { kind: 'library', ref: { entryId: 'prior-a', contentDigest: 'prior-digest' } },
      { kind: 'asset', assetId: 'asset-a', sha256: 'asset-digest' }],
  }
}

/** 创建可重试网络失败，模拟提交已经发生而响应尚未确认。 */
function networkError(): ClientError {
  return new ClientError({ status: 0, code: 'NETWORK_ERROR', message: 'Disconnected', retryable: true })
}

/** 排空受控响应已经完成后的微任务，不引入时间猜测。 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('Evidence window read lifetime', () => {
  // 查询成功、失败和取消均按窗口身份及读取代次接纳。
  it.each(['toString', 'constructor', '__proto__'])('原型名称库错误码 %s 不会变成非字符串文案', async (
    /* 远端错误中与对象原型同名但未登记翻译的稳定码。 */ code,
  ) => {
    // 只有库实际登记的业务码会翻译，其他码继续携带原字符串。
    const f = fixture()
    readAt(f, 0).reject(new ClientError({ code, message: '库业务失败', status: 422, retryable: false }))
    await settle()
    expect(f.state.error.value).toMatchObject({ code, message: '库业务失败', status: 422 })
    f.state.dispose()
  })
  it('loads only an active authenticated workspace and cancels reads when leaving the library', async () => {
    // Map 页不自动读库，激活后自动读第一页，离开后迟到响应不回填。
    const f = fixture({ active: false })
    expect(f.reads).toHaveLength(0)
    f.context.value.active = true
    expect(f.reads).toHaveLength(1)
    expect(readAt(f, 0).params).toEqual({ workspaceId: 'workspace-a', limit: 25, includeInactive: false })
    f.context.value.active = false
    expect(readAt(f, 0).signal?.aborted).toBe(true)
    readAt(f, 0).resolve(page(['old']))
    await settle()
    expect(f.state.items.value).toEqual([])
    expect(f.state.loading.value).toBe(false)
    f.context.value.userId = null
    f.context.value.active = true
    expect(f.reads).toHaveLength(1)
    f.state.dispose()
  })

  it.each(['workspaceId', 'userId', 'connectionKey'] as const)(
    'isolates late search failures and details after changing %s', async (
      /* 本轮要切换的窗口身份字段。 */ field,
    ) => {
      // 服务、用户和工作区各自都构成身份隔离边界，旧 401 不退出新会话。
      const f = fixture()
      const detail = f.state.select('old-entry')
      f.context.value[field] = `new-${field}`
      expect(readAt(f, 0).signal?.aborted).toBe(true)
      expect(readAt(f, 1).signal?.aborted).toBe(true)
      readAt(f, 2).resolve(page(['current']))
      readAt(f, 0).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Old session', retryable: false }))
      readAt(f, 1).resolve(libraryEntry('old-entry'))
      expect(await detail).toBe(false)
      await settle()
      expect(f.state.items.value.map(
        /* 当前接纳的库摘要。 */ item => /* 对比接纳身份而非内部调用次数。 */ item.id,
      )).toEqual(['current'])
      expect(f.state.entry.value).toBeNull()
      expect(f.state.selectedId.value).toBeNull()
      expect(f.state.error.value).toBeNull()
      expect(f.onUnauthorized).not.toHaveBeenCalled()
      f.state.dispose()
    },
  )

  it('ignores an older search success after a newer search establishes its page', async () => {
    // 用户第二次搜索先完成时，第一次成功不能覆盖新的筛选结果。
    const f = fixture()
    f.state.filters.value.query = '新查询'
    const latest = f.state.search()
    readAt(f, 1).resolve(page(['new']))
    expect(await latest).toBe(true)
    readAt(f, 0).resolve(page(['old']))
    await settle()
    expect(f.state.items.value).toEqual(page(['new']).items)
    expect(readAt(f, 0).signal?.aborted).toBe(true)
    f.state.dispose()
  })

  it.each(['workspaceId', 'userId', 'connectionKey'] as const)(
    'clears filter drafts before loading the new identity after changing %s', async (
      /* 本轮切换的工作区、用户或服务字段。 */ field,
    ) => {
      // 筛选草稿也是窗口身份数据，不能把前身份的关键词或历史偏好带入新工作区。
      const f = fixture()
      f.state.filters.value = { query: '前身份关键词', confidence: '0', subject: '前主体', event: '前事件', includeInactive: true }
      f.context.value[field] = `new-${field}`
      expect(f.state.filters.value).toEqual({ query: '', confidence: 'all', subject: '', event: '', includeInactive: false })
      expect(readAt(f, 1).params).toEqual({ workspaceId: f.context.value.workspaceId, limit: 25, includeInactive: false })
      readAt(f, 0).resolve(page(['old']))
      readAt(f, 1).resolve(page(['current']))
      await settle()
      expect(f.state.items.value).toEqual(page(['current']).items)
      f.state.dispose()
    },
  )

  it('keeps the same workspace view while away and refreshes the selected entry when returning', async () => {
    // 库画布在同身份切回 Map 时不清空，返回后刷新固定详情并隔离离开前的响应。
    const f = fixture()
    readAt(f, 0).resolve(page(['kept'], { nextCursor: 'kept-cursor' }))
    await settle()
    const selecting = f.state.select('kept')
    readAt(f, 1).resolve(libraryEntry('kept'))
    await selecting
    const keptFilters = { query: '保留筛选', confidence: '0', subject: '主体', event: '事件', includeInactive: true } as const
    f.state.filters.value = { ...keptFilters }
    const pendingRefresh = f.state.search()
    f.context.value.active = false
    expect(readAt(f, 2).signal?.aborted).toBe(true)
    expect(f.state.items.value).toEqual(page(['kept']).items)
    expect(f.state.selectedId.value).toBe('kept')
    expect(f.state.entry.value?.id).toBe('kept')
    expect(f.state.nextCursor.value).toBe('kept-cursor')
    expect(f.state.libraryRevision.value).toBe(4)
    expect(f.state.filters.value).toEqual(keptFilters)
    readAt(f, 2).resolve(page(['stale']))
    expect(await pendingRefresh).toBe(false)
    expect(f.state.items.value).toEqual(page(['kept']).items)
    f.context.value.active = true
    expect(f.state.filters.value).toEqual(keptFilters)
    expect(readAt(f, 3).method).toBe('evidence.search')
    expect(readAt(f, 4).params).toEqual({ workspaceId: 'workspace-a', entryId: 'kept' })
    readAt(f, 3).resolve(page([], { revision: 5 }))
    readAt(f, 4).resolve(libraryEntry('kept', { revision: 2, status: 'withdrawn', statusReason: '离开后撤回' }))
    await settle()
    expect(f.state.items.value).toEqual([])
    expect(f.state.selectedId.value).toBe('kept')
    expect(f.state.entry.value).toMatchObject({ revision: 2, status: 'withdrawn' })
    f.state.dispose()
  })

  it('opens a pinned withdrawn entry using the existing detail request', async () => {
    // 固定引用允许阅读已撤回的原条目，摘要校验不另发预读请求。
    const f = fixture()
    readAt(f, 0).resolve(page([]))
    await settle()
    const selecting = f.state.select('fixed', 'digest-fixed')
    readAt(f, 1).resolve(libraryEntry('fixed', { status: 'withdrawn', statusReason: '停止新增使用，保留旧引用。' }))

    expect(await selecting).toBe(true)

    expect(f.state.entry.value).toMatchObject({ id: 'fixed', contentDigest: 'digest-fixed', status: 'withdrawn' })
    expect(f.reads.filter((
      /* 从打开节点固定引用时发出的查询。 */ call,
    ) => /* 正文仍只由原本的一次get交付。 */ call.method === 'evidence.get')).toHaveLength(1)
    expect(f.relationsReads).toHaveLength(1)
    f.state.dispose()
  })

  it('retains the pinned digest on detail retry and refuses mismatched content and relations', async () => {
    // 首次网络失败后仍按原固定摘要重试，不能接纳同条目身份下的另一份内容。
    const f = fixture()
    readAt(f, 0).resolve(page([]))
    await settle()
    const selecting = f.state.select('fixed', 'digest-fixed')
    readAt(f, 1).reject(new ClientError({ status: 0, code: 'NETWORK_ERROR', message: 'Disconnected', retryable: true }))
    expect(await selecting).toBe(false)
    expect(f.state.canRetry.value).toBe(true)

    const retrying = f.state.retry()
    readAt(f, 2).resolve(libraryEntry('fixed', { contentDigest: 'another-digest' }))
    expect(await retrying).toBe(false)

    expect(readAt(f, 2).params).toEqual({ workspaceId: 'workspace-a', entryId: 'fixed' })
    expect(f.state.entry.value).toBeNull()
    expect(f.state.relations.value).toBeNull()
    expect(f.state.error.value).toMatchObject({ code: 'INVALID_RESPONSE', retryable: false })
    expect(f.state.canRetry.value).toBe(false)
    f.state.dispose()
  })

  it('keeps the pinned digest when the same fixed selection refreshes after reactivation', async () => {
    // 同身份往返Map与证据库只刷新撤回状态，不能丢掉节点引用指定的原摘要。
    const f = fixture()
    readAt(f, 0).resolve(page([]))
    await settle()
    const selecting = f.state.select('fixed', 'digest-fixed')
    readAt(f, 1).resolve(libraryEntry('fixed'))
    expect(await selecting).toBe(true)

    f.context.value.active = false
    f.context.value.active = true
    readAt(f, 2).resolve(page([]))
    expect(readAt(f, 3).params).toEqual({ workspaceId: 'workspace-a', entryId: 'fixed' })
    readAt(f, 3).resolve(libraryEntry('fixed', { contentDigest: 'another-digest' }))
    await settle()

    expect(f.state.entry.value).toBeNull()
    expect(f.state.relations.value).toBeNull()
    expect(f.state.error.value).toMatchObject({ code: 'INVALID_RESPONSE', retryable: false })
    f.state.dispose()
  })

  it('isolates late detail success and failure after selecting another entry', async () => {
    // 选中条目 B 后，条目 A 的迟到结果不能修改详情、错误或认证状态。
    const f = fixture()
    readAt(f, 0).resolve(page(['a', 'b']))
    await settle()
    const first = f.state.select('a')
    const latest = f.state.select('b')
    readAt(f, 2).resolve(libraryEntry('b'))
    expect(await latest).toBe(true)
    readAt(f, 1).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Old detail', retryable: false }))
    expect(await first).toBe(false)
    expect(f.state.entry.value?.id).toBe('b')
    expect(f.state.selectedId.value).toBe('b')
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    const closedDetail = f.state.select('a')
    expect(await f.state.select(null)).toBe(true)
    readAt(f, 3).resolve(libraryEntry('a'))
    expect(await closedDetail).toBe(false)
    expect(f.state.entry.value).toBeNull()
    f.state.dispose()
  })

  it('notifies the session owner for a current 401 and never offers authorization retry', async () => {
    // 当前详情认证失败通知会话，401 即使标为可重试也不保留操作。
    const f = fixture({ active: false })
    f.context.value.active = true
    readAt(f, 0).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Expired', retryable: true }))
    await settle()
    expect(f.onUnauthorized).toHaveBeenCalledOnce()
    expect(f.state.canRetry.value).toBe(false)
    expect(await f.state.retry()).toBe(false)
    f.state.dispose()
  })

  it('disposes through the Vue scope and ignores responses after disposal', async () => {
    // 状态被窗口作用域释放后同时取消读写，迟到结果不能重新填充。
    const scope = effectScope()
    const f = scope.run(() => /* 在有生命周期的窗口作用域中创建状态。 */ fixture())
    if (!f) throw new Error('Evidence scope did not create state')
    const collecting = f.state.collect(collectDraft())
    scope.stop()
    expect(readAt(f, 0).signal?.aborted).toBe(true)
    expect(writeAt(f, 0).signal?.aborted).toBe(true)
    readAt(f, 0).resolve(page(['late']))
    writeAt(f, 0).resolve({ entry: libraryEntry('late'), replayed: false, existing: false, conflictEntryIds: [] })
    expect(await collecting).toBeNull()
    await settle()
    expect(f.state.items.value).toEqual([])
    expect(f.state.entry.value).toBeNull()
    expect(f.state.busy.value).toBe(false)
    expect(f.state.canEdit.value).toBe(false)
    expect(await f.state.select('after-close')).toBe(false)
    expect(f.state.selectedId.value).toBeNull()
  })

  it('retries the failed query with its captured inputs after filter drafts change', async () => {
    // 可恢复查询失败保留原输入；重试不会悄悄提交用户后来修改的筛选。
    const f = fixture()
    const original = structuredClone(readAt(f, 0).params)
    readAt(f, 0).reject(networkError())
    await settle()
    expect(f.state.canRetry.value).toBe(true)
    f.state.filters.value.query = '稍后修改的草稿'
    f.state.filters.value.confidence = '1'
    const retrying = f.state.retry()
    expect(readAt(f, 1).params).toEqual(original)
    readAt(f, 1).resolve(page(['original-query']))
    expect(await retrying).toBe(true)
    expect(f.state.items.value).toEqual(page(['original-query']).items)
    expect(f.state.filters.value.query).toBe('稍后修改的草稿')
    expect(f.state.canRetry.value).toBe(false)
    f.state.dispose()
  })

  it('shows unavailable evidence service without offering a blind retry', async () => {
    // 本机没有库适配时直接说明服务能力，不无限重试不可用 API。
    const f = fixture()
    readAt(f, 0).reject(new ClientError({ status: 503, code: 'EVIDENCE_UNAVAILABLE', message: 'Unavailable', retryable: true }))
    await settle()
    expect(f.state.error.value).toMatchObject({ code: 'EVIDENCE_UNAVAILABLE', status: 503 })
    expect(f.state.error.value?.message).toContain('支持证据库的服务')
    expect(f.state.canRetry.value).toBe(false)
    expect(await f.state.retry()).toBe(false)
    f.state.dispose()
  })
})

describe('Evidence query baseline and pagination', () => {
  // 保留数字 0，续页严格使用成功搜索的筛选和库 revision。
  it('preserves confidence zero and applies every filter to bounded continuation pages', async () => {
    // 字符串筛选 0 必须提交数字 0，而不是因真假判断遗漏。
    const f = fixture()
    readAt(f, 0).resolve(page([]))
    await settle()
    f.state.filters.value = { query: '  判断  ', confidence: '0', subject: '  主体  ', event: '  事件  ', includeInactive: true }
    const searching = f.state.search()
    const params = { workspaceId: 'workspace-a', query: '判断', confidence: 0, subject: '主体', event: '事件', limit: 25, includeInactive: true }
    expect(readAt(f, 1).params).toEqual(params)
    readAt(f, 1).resolve(page(['first'], { nextCursor: 'cursor-a' }))
    expect(await searching).toBe(true)
    const continuing = f.state.loadMore()
    expect(readAt(f, 2).params).toEqual({ ...params, cursor: 'cursor-a' })
    readAt(f, 2).resolve(page(['second']))
    expect(await continuing).toBe(true)
    expect(f.state.items.value).toEqual(page(['first', 'second']).items)
    expect(f.state.libraryRevision.value).toBe(4)
    f.state.dispose()
  })

  it('requires explicit search after editing filters instead of silently mixing pages', async () => {
    // 有效游标绑定成功查询，不把尚未提交的筛选草稿放进续页。
    const f = fixture()
    readAt(f, 0).resolve(page(['first'], { nextCursor: 'cursor-a' }))
    await settle()
    f.state.filters.value.confidence = '1'
    expect(await f.state.loadMore()).toBe(false)
    expect(f.reads).toHaveLength(1)
    expect(f.state.items.value).toEqual(page(['first']).items)
    expect(f.state.error.value?.code).toBe('EVIDENCE_CURSOR_INVALID')
    const searching = f.state.search()
    expect(readAt(f, 1).params).toMatchObject({ confidence: 1 })
    readAt(f, 1).resolve(page(['replacement']))
    expect(await searching).toBe(true)
    expect(f.state.items.value).toEqual(page(['replacement']).items)
    f.state.dispose()
  })

  it.each(['server-rejection', 'mismatched-success'] as const)(
    'retains the old page and exposes refresh after cursor expiry via %s', async (
      /* 后端以拒绝或不同 revision 的成功包表示分页基线变化。 */ failure,
    ) => {
      // 过期分页不会隐式刷新并拼页，既有条目保留供用户明确刷新。
      const f = fixture()
      readAt(f, 0).resolve(page(['first'], { nextCursor: 'cursor-a' }))
      await settle()
      const continuing = f.state.loadMore()
      if (failure === 'server-rejection') {
        readAt(f, 1).reject(new ClientError({ status: 409, code: 'EVIDENCE_CURSOR_EXPIRED', message: 'Changed', retryable: true }))
      } else readAt(f, 1).resolve(page(['wrong-page'], { revision: 5 }))
      expect(await continuing).toBe(false)
      expect(f.state.error.value?.code).toBe('EVIDENCE_CURSOR_EXPIRED')
      expect(f.state.error.value?.message).toContain('刷新')
      expect(f.state.items.value).toEqual(page(['first']).items)
      expect(f.state.nextCursor.value).toBeNull()
      expect(f.state.libraryRevision.value).toBe(4)
      expect(f.state.canRetry.value).toBe(false)
      expect(await f.state.retry()).toBe(false)
      expect(f.reads).toHaveLength(2)
      f.state.dispose()
    },
  )
})

describe('Evidence mutations and uncertain receipts', () => {
  // 命令原输入与请求身份不因草稿编辑、筛选或网关修改而改变。
  it('lets a viewer read while refusing collect and withdraw without a write request', async () => {
    // 只读身份仍可打开固定详情；本地写权限边界不会发出命令。
    const f = fixture({ canEdit: false })
    readAt(f, 0).resolve(page(['view']))
    await settle()
    const selecting = f.state.select('view')
    readAt(f, 1).resolve(libraryEntry('view'))
    expect(await selecting).toBe(true)
    expect(f.state.canEdit.value).toBe(false)
    expect(await f.state.collect(collectDraft())).toBeNull()
    expect(await f.state.withdraw('理由')).toBeNull()
    expect(f.writes).toHaveLength(0)
    f.state.dispose()
  })

  it('collects from Map without automatic reads and preserves zero in the fixed entry', async () => {
    // Map 页仍可显式收录；无需先进入库启动浏览请求。
    const f = fixture({ active: false })
    const collecting = f.state.collect(collectDraft())
    expect(f.reads).toHaveLength(0)
    expect(writeAt(f, 0).params).toMatchObject({ workspaceId: 'workspace-a', confidence: 0 })
    writeAt(f, 0).resolve({ entry: libraryEntry('new'), replayed: false, existing: false, conflictEntryIds: ['opposite'] })
    const result = await collecting
    expect(result?.entry.confidence).toBe(0)
    expect(f.state.entry.value?.id).toBe('new')
    expect(f.state.selectedId.value).toBe('new')
    expect(f.state.busy.value).toBe(false)
    f.state.dispose()
  })

  it.each([
    { existing: false, replayed: false }, { existing: true, replayed: false },
    { existing: false, replayed: true }, { existing: true, replayed: true },
  ])('keeps the complete collection outcome independently with existing=$existing and replayed=$replayed', async (
    /* 业务去重与原请求确认各自独立的后端结果，不从外层收据推导。 */ flags,
  ) => {
    // 相反判断只是收录成功附带的结果，完整独立副本不能被响应对象的后续修改污染。
    const f = fixture({ active: false })
    expect(f.state).toHaveProperty('collectionOutcome')
    const collecting = f.state.collect(collectDraft())
    const result: EvidenceCollectResult = { entry: libraryEntry('accepted'), ...flags, conflictEntryIds: ['opposite-a', 'opposite-b'] }
    const expected = structuredClone(result)
    writeAt(f, 0).resolve(result)
    expect(await collecting).toEqual(expected)

    expect(f.state.collectionOutcome.value).toEqual(expected)
    expect(f.state.error.value).toBeNull()
    expect(f.state.canRetry.value).toBe(false)
    expect(await f.state.retry()).toBe(false)
    result.entry.claim.nodeSnapshot.payload.content = '传输对象后来改变的正文。'
    result.conflictEntryIds.push('later-id')
    expect(f.state.collectionOutcome.value).toEqual(expected)
    expect(f.writes).toHaveLength(1)
    f.state.dispose()
  })

  it('retains the complete outcome after retrying the original collection request', async () => {
    // 网络失败后只恢复原命令，确认结果保留原existing、replayed及相反判断身份。
    const f = fixture({ active: false })
    expect(f.state).toHaveProperty('collectionOutcome')
    const collecting = f.state.collect(collectDraft())
    const original = writeAt(f, 0)
    original.reject(networkError())
    expect(await collecting).toBeNull()
    expect(f.state.collectionOutcome.value).toBeNull()
    const retrying = f.state.retry()
    expect(writeAt(f, 1).requestId).toBe(original.requestId)
    expect(writeAt(f, 1).params).toEqual(original.params)
    const result: EvidenceCollectResult = { entry: libraryEntry('confirmed'), replayed: true, existing: true, conflictEntryIds: ['opposite'] }
    writeAt(f, 1).resolve(result)

    expect(await retrying).toBe(true)
    expect(f.state.collectionOutcome.value).toEqual(result)
    expect(f.state.error.value).toBeNull()
    f.state.dispose()
  })

  it('keeps collection display through reads and withdrawals and dismisses it without abandoning a pending command', async () => {
    // 普通选择与撤回不改旧收录结果，关闭展示也不能清掉未知撤回请求的原重试。
    const f = fixture()
    expect(f.state).toHaveProperty('collectionOutcome')
    expect(f.state).toHaveProperty('clearCollectionOutcome', expect.any(Function))
    readAt(f, 0).resolve(page([]))
    await settle()
    const collecting = f.state.collect(collectDraft())
    const result: EvidenceCollectResult = { entry: libraryEntry('first'), replayed: false, existing: false, conflictEntryIds: ['opposite'] }
    writeAt(f, 0).resolve(result)
    await collecting
    const selecting = f.state.select('another')
    readAt(f, 1).resolve(libraryEntry('another'))
    await selecting
    expect(f.state.collectionOutcome.value).toEqual(result)
    f.context.value.active = false
    expect(f.state.collectionOutcome.value).toEqual(result)
    const withdrawing = f.state.withdraw('撤回另一份条目。')
    expect(await f.state.collect(collectDraft())).toBeNull()
    expect(f.state.collectionOutcome.value).toEqual(result)
    const withdrawal = writeAt(f, 1)
    withdrawal.reject(networkError())
    await withdrawing
    expect(await f.state.collect(collectDraft())).toBeNull()
    expect(f.state.collectionOutcome.value).toEqual(result)
    expect(f.state.canRetry.value).toBe(true)
    const beforeDismiss = structuredClone(f.state.entry.value)

    f.state.clearCollectionOutcome()

    expect(f.state.collectionOutcome.value).toBeNull()
    expect(f.state.entry.value).toEqual(beforeDismiss)
    expect(f.state.canRetry.value).toBe(true)
    const retrying = f.state.retry()
    expect(writeAt(f, 2).requestId).toBe(withdrawal.requestId)
    writeAt(f, 2).resolve(libraryEntry('another', { revision: 2, status: 'withdrawn' }))
    expect(await retrying).toBe(true)
    expect(f.state.collectionOutcome.value).toBeNull()
    f.state.dispose()
  })

  it('clears a prior outcome only for an accepted new intent or an ended workspace identity', async () => {
    // 无权限的新意图不能擦掉已有结果，有效收录开始和工作区结束则清理旧展示。
    const f = fixture({ active: false })
    expect(f.state).toHaveProperty('collectionOutcome')
    const first = f.state.collect(collectDraft())
    const result: EvidenceCollectResult = { entry: libraryEntry('first'), replayed: false, existing: false, conflictEntryIds: [] }
    writeAt(f, 0).resolve(result)
    await first
    f.context.value.canEdit = false
    expect(await f.state.collect(collectDraft())).toBeNull()
    expect(f.state.collectionOutcome.value).toEqual(result)
    f.context.value.canEdit = true

    const next = f.state.collect(collectDraft())
    expect(f.state.collectionOutcome.value).toBeNull()
    writeAt(f, 1).resolve({ ...result, entry: libraryEntry('next'), existing: true })
    await next
    expect(f.state.collectionOutcome.value?.entry.id).toBe('next')
    f.context.value.workspaceId = 'workspace-b'
    expect(f.state.collectionOutcome.value).toBeNull()
    expect(f.state.entry.value).toBeNull()
    f.state.dispose()
  })

  it('deeply isolates a reactive collect draft and retries the original request after an unknown failure', async () => {
    // 传输层修改首次副本和用户修改草稿均不改变重试参数或 requestId。
    const f = fixture({ active: false })
    const draft = reactive(collectDraft())
    const collecting = f.state.collect(draft)
    const first = writeAt(f, 0)
    const original = structuredClone(first.params)
    // 测试知道方法为收录，只在真实 seam 中缩窄这一个命令参数。
    const delivered = first.params as EvidenceCollectParams
    delivered.claim.revision = 99
    delivered.applicability.conditions.push('传输改写')
    expect(delivered.basisRefs.map((
      /* 这次传输实际包含的有序依据。 */ basis,
    ) => /* 四类分支共同经过同一个复制与原请求恢复路径。 */ basis.kind)).toEqual(['manual', 'node', 'library', 'asset'])
    for (const basis of delivered.basisRefs) {
      if (basis.kind === 'manual') basis.text = '传输改写人工原文'
      else if (basis.kind === 'node') basis.ref.revision = 99
      else if (basis.kind === 'library') basis.ref.contentDigest = 'transport-digest'
      else basis.sha256 = 'transport-asset-digest'
    }
    first.reject(networkError())
    expect(await collecting).toBeNull()
    expect(f.state.canRetry.value).toBe(true)
    draft.claim.revision = 7
    draft.reason = '新输入'
    draft.applicability.conditions[0] = '新条件'
    for (const basis of draft.basisRefs) {
      if (basis.kind === 'manual') basis.text = '草稿后改人工原文'
      else if (basis.kind === 'node') basis.ref.mapId = 'another-map'
      else if (basis.kind === 'library') basis.ref.contentDigest = 'draft-digest'
      else basis.sha256 = 'draft-asset-digest'
    }
    draft.basisRefs.reverse()
    expect(await f.state.collect(draft)).toBeNull()
    expect(f.writes).toHaveLength(1)
    const retrying = f.state.retry()
    expect(writeAt(f, 1).requestId).toBe(first.requestId)
    expect(writeAt(f, 1).params).toEqual(original)
    writeAt(f, 1).resolve({ entry: libraryEntry('accepted'), replayed: true, existing: false, conflictEntryIds: [] })
    expect(await retrying).toBe(true)
    expect(f.state.entry.value?.id).toBe('accepted')
    expect(f.state.canRetry.value).toBe(false)
    expect(draft.claim.revision).toBe(7)
    f.state.dispose()
  })

  it('ignores a four-kind collection confirmation after the workspace changes', async () => {
    // 同一套四类精确依据只属于原工作区，旧确认不能填入新库或恢复旧命令。
    const f = fixture({ active: false })
    const collecting = f.state.collect(collectDraft())
    expect((writeAt(f, 0).params as EvidenceCollectParams).basisRefs).toHaveLength(4)
    f.context.value.workspaceId = 'workspace-b'
    expect(writeAt(f, 0).signal?.aborted).toBe(true)

    writeAt(f, 0).resolve({ entry: libraryEntry('old'), replayed: false, existing: false, conflictEntryIds: [] })
    expect(await collecting).toBeNull()

    expect(f.state.entry.value).toBeNull()
    expect(f.state.selectedId.value).toBeNull()
    expect(f.state.error.value).toBeNull()
    expect(f.state.canRetry.value).toBe(false)
    expect(f.writes).toHaveLength(1)
    f.state.dispose()
  })

  it('blocks duplicate busy commands and gives new input a new identity only after explicit abandonment', async () => {
    // 操作正在执行或结果不确定时都不能提交新命令；clearError 是明确放弃入口。
    const f = fixture({ active: false })
    const collecting = f.state.collect(collectDraft())
    expect(await f.state.collect(collectDraft())).toBeNull()
    f.state.clearError()
    expect(f.state.busy.value).toBe(true)
    writeAt(f, 0).reject(networkError())
    await collecting
    expect(await f.state.collect({ ...collectDraft(), reason: '改变理由' })).toBeNull()
    const firstId = writeAt(f, 0).requestId
    f.state.clearError()
    expect(f.state.canRetry.value).toBe(false)
    const changed = f.state.collect({ ...collectDraft(), reason: '改变理由' })
    expect(writeAt(f, 1).requestId).not.toBe(firstId)
    expect(writeAt(f, 1).params).toMatchObject({ reason: '改变理由' })
    writeAt(f, 1).resolve({ entry: libraryEntry('changed'), replayed: false, existing: false, conflictEntryIds: [] })
    expect((await changed)?.entry.id).toBe('changed')
    f.state.dispose()
  })

  it('retains an uncertain command when a later read also fails', async () => {
    // 浏览错误不能覆盖尚未确认命令的重试身份或显示成另一个可重试操作。
    const f = fixture()
    readAt(f, 0).resolve(page([]))
    await settle()
    const collecting = f.state.collect(collectDraft())
    writeAt(f, 0).reject(networkError())
    await collecting
    const commandErrorId = f.state.error.value?.errorId
    const searching = f.state.search()
    readAt(f, 1).reject(new ClientError({ status: 503, code: 'QUERY_FAILED', message: 'Read failed', retryable: true }))
    expect(await searching).toBe(false)
    expect(f.state.error.value?.errorId).toBe(commandErrorId)
    expect(f.state.error.value?.code).toBe('NETWORK_ERROR')
    const retrying = f.state.retry()
    expect(f.reads).toHaveLength(2)
    expect(writeAt(f, 1).requestId).toBe(writeAt(f, 0).requestId)
    writeAt(f, 1).resolve({ entry: libraryEntry('receipt'), replayed: true, existing: false, conflictEntryIds: [] })
    expect(await retrying).toBe(true)
    f.state.dispose()
  })

  it('disables command retry after write permission is removed', async () => {
    // 原命令保留但当前只读身份不能发出重试；恢复权限后仍沿用原身份确认。
    const f = fixture({ active: false })
    const collecting = f.state.collect(collectDraft())
    writeAt(f, 0).reject(networkError())
    await collecting
    f.context.value.canEdit = false
    expect(f.state.canEdit.value).toBe(false)
    expect(f.state.canRetry.value).toBe(false)
    expect(await f.state.retry()).toBe(false)
    expect(f.writes).toHaveLength(1)
    f.context.value.canEdit = true
    expect(f.state.canRetry.value).toBe(true)
    const retrying = f.state.retry()
    expect(writeAt(f, 1).requestId).toBe(writeAt(f, 0).requestId)
    writeAt(f, 1).resolve({ entry: libraryEntry('restored'), replayed: true, existing: false, conflictEntryIds: [] })
    expect(await retrying).toBe(true)
    f.state.dispose()
  })

  it('never rebases or retries a 409 and keeps the fixed revision for a withdrawal', async () => {
    // 收据失败的版本冲突必须显示，不自动读取当前版本或再次撤回。
    const f = fixture()
    readAt(f, 0).resolve(page(['withdraw'], { nextCursor: 'before-command' }))
    await settle()
    const selecting = f.state.select('withdraw')
    readAt(f, 1).resolve(libraryEntry('withdraw', { revision: 8 }))
    await selecting
    const withdrawing = f.state.withdraw('原撤回原因')
    expect(writeAt(f, 0).params).toEqual({ workspaceId: 'workspace-a', entryId: 'withdraw', expectedRevision: 8, reason: '原撤回原因' })
    writeAt(f, 0).reject(new ClientError({ status: 409, code: 'EVIDENCE_REVISION_CONFLICT', message: 'Changed', retryable: true, currentRevision: 9 }))
    expect(await withdrawing).toBeNull()
    expect(f.state.error.value).toMatchObject({ code: 'EVIDENCE_REVISION_CONFLICT', currentRevision: 9 })
    expect(f.state.error.value?.message).toContain('重新读取')
    expect(f.state.entry.value?.revision).toBe(8)
    expect(f.state.canRetry.value).toBe(false)
    expect(await f.state.retry()).toBe(false)
    expect(f.reads).toHaveLength(2)
    expect(f.writes).toHaveLength(1)
    f.state.dispose()
  })

  it('keeps withdrawal revision and reason on retry and updates only the accepted fixed entry', async () => {
    // 撤回重试依旧保留原 revision 和原因；成功后列表去掉撤回项，详情仍可读。
    const f = fixture()
    readAt(f, 0).resolve(page(['withdraw'], { nextCursor: 'before-command' }))
    await settle()
    const selecting = f.state.select('withdraw')
    readAt(f, 1).resolve(libraryEntry('withdraw', { revision: 8 }))
    await selecting
    const withdrawing = f.state.withdraw('原撤回原因')
    writeAt(f, 0).reject(networkError())
    await withdrawing
    const original = structuredClone(writeAt(f, 0).params)
    const retrying = f.state.retry()
    expect(writeAt(f, 1).params).toEqual(original)
    expect(writeAt(f, 1).requestId).toBe(writeAt(f, 0).requestId)
    writeAt(f, 1).resolve(libraryEntry('withdraw', { revision: 9, status: 'withdrawn', statusReason: '原撤回原因' }))
    expect(await retrying).toBe(true)
    expect(f.state.entry.value).toMatchObject({ id: 'withdraw', revision: 9, status: 'withdrawn' })
    expect(f.state.items.value).toEqual([])
    expect(f.state.nextCursor.value).toBeNull()
    expect(f.state.libraryRevision.value).toBeNull()
    f.state.dispose()
  })

  it.each(['completed-detail', 'pending-detail'] as const)(
    'keeps a later selected entry when withdrawal confirms with %s', async (
      /* 撤回确认时，新条目的详情已经完成或仍在读取。 */ timing,
    ) => {
      // 撤回 A 在途时用户可选择 B；A 的确认只更新摘要和分页，不抢回选择或取消 B。
      const f = fixture()
      readAt(f, 0).resolve(page(['a', 'b'], { nextCursor: 'before-withdrawal' }))
      await settle()
      const selectingA = f.state.select('a')
      readAt(f, 1).resolve(libraryEntry('a'))
      await selectingA
      const withdrawingA = f.state.withdraw('撤回 A')
      const selectingB = f.state.select('b')
      if (timing === 'completed-detail') {
        readAt(f, 2).resolve(libraryEntry('b'))
        expect(await selectingB).toBe(true)
      }
      writeAt(f, 0).resolve(libraryEntry('a', { revision: 2, status: 'withdrawn', statusReason: '撤回 A' }))
      expect((await withdrawingA)?.id).toBe('a')
      expect(f.state.selectedId.value).toBe('b')
      expect(readAt(f, 2).signal?.aborted).toBe(false)
      expect(f.state.items.value).toEqual(page(['b']).items)
      expect(f.state.nextCursor.value).toBeNull()
      if (timing === 'pending-detail') {
        expect(f.state.entry.value).toBeNull()
        expect(f.state.detailLoading.value).toBe(true)
        readAt(f, 2).resolve(libraryEntry('b'))
        expect(await selectingB).toBe(true)
      }
      expect(f.state.entry.value?.id).toBe('b')
      expect(f.state.detailLoading.value).toBe(false)
      f.state.dispose()
    },
  )

  it.each(['workspaceId', 'userId', 'connectionKey'] as const)(
    'aborts writes and abandons uncertain receipts when changing %s', async (
      /* 本轮改变的命令身份字段。 */ field,
    ) => {
      // 命令只能向原身份重试，另一工作区或凭据不能继承原 requestId。
      const f = fixture({ active: false })
      const collecting = f.state.collect(collectDraft())
      f.context.value[field] = `new-${field}`
      expect(writeAt(f, 0).signal?.aborted).toBe(true)
      writeAt(f, 0).resolve({ entry: libraryEntry('old'), replayed: false, existing: false, conflictEntryIds: [] })
      expect(await collecting).toBeNull()
      expect(f.state.entry.value).toBeNull()
      expect(f.state.collectionOutcome.value).toBeNull()
      expect(f.state.busy.value).toBe(false)
      expect(f.state.canRetry.value).toBe(false)
      expect(await f.state.retry()).toBe(false)
      f.state.dispose()
    },
  )
})
