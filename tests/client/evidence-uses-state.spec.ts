// 092 使用记录状态先行测试：窗口身份、分页目录及固定消费者快照读取。
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { ClientError, type ClientGateway, type QueryInputMap, type QueryOutputMap } from '../../contracts/client'
import type { EvidenceUse, EvidenceUsesPage } from '../../contracts/evidence-library'
import { evidenceCreateUses, type EvidenceUsesContext } from '../../apps/ui/features/evidence-library/evidence-uses'

enum UsesTestMessage { UNEXPECTED = 'Unexpected use state transport', MISSING = 'Expected use state read', OLD_AUTH = 'Old use authorization', CURRENT_AUTH = 'Current use authorization' }
interface Call { method: 'evidence.uses' | 'evidence.use.get'; params: unknown; signal: AbortSignal | undefined;
  resolve(/* 已确认的公开回复。 */ value: EvidenceUsesPage | EvidenceUse): void; reject(/* 当前读取异常。 */ cause: unknown): void }
function fixture() {
  // 受控公共网关只控制异步时序，不实现证据数据库或使用索引。
  const reads: Call[] = []
  const context = ref<EvidenceUsesContext>({ userId: 'user', connectionKey: 'service', workspaceId: 'workspace', entryId: 'entry', active: true })
  const unauthorized = vi.fn()
  const gateway: ClientGateway = {
    async read<K extends keyof QueryInputMap>(/* 状态实际请求的方法。 */ method: K, /* 本次固定参数。 */ params: QueryInputMap[K], /* 状态拥有的取消信号。 */ signal?: AbortSignal): Promise<QueryOutputMap[K]> {
      // 泛型方法经明确分支限制为本状态的两个公开查询。
      let readMethod: Call['method']
      if (method === 'evidence.uses') readMethod = 'evidence.uses'
      else if (method === 'evidence.use.get') readMethod = 'evidence.use.get'
      else throw new Error(UsesTestMessage.UNEXPECTED)
      const result = new Promise<EvidenceUsesPage | EvidenceUse>((/* 成功完成入口。 */ resolve, /* 异常完成入口。 */ reject) => {
        // 记录原信号，测试仍可故意交付取消后的迟到响应。
        reads.push({ method: readMethod, params, signal, resolve, reject })
      })
      // 公开泛型映射不随method缩窄；上面运行时分支确保只有两种合法seam返回。
      return await result as QueryOutputMap[K]
    },
    async watch() { /* 使用记录不订阅图。 */ throw new Error(UsesTestMessage.UNEXPECTED) },
    async getConnection() { /* 连接由窗口外层维护。 */ throw new Error(UsesTestMessage.UNEXPECTED) },
    async connect() { /* 状态不自行登录。 */ throw new Error(UsesTestMessage.UNEXPECTED) },
    async disconnect() { /* 401通过通知交给会话所有者。 */ throw new Error(UsesTestMessage.UNEXPECTED) },
    async dispatch() { /* 使用记录读取没有命令。 */ throw new Error(UsesTestMessage.UNEXPECTED) },
    async upload() { /* 使用记录读取没有上传。 */ throw new Error(UsesTestMessage.UNEXPECTED) },
    async download() { /* 固定消费者正文通过公共详情返回。 */ throw new Error(UsesTestMessage.UNEXPECTED) },
  }
  return { state: evidenceCreateUses(gateway, context, unauthorized), context, reads, unauthorized }
}
function use(/* 固定使用记录身份。 */ id: string, /* 消费者是否已经结束当前引用。 */ ended = false): EvidenceUse {
  // 已结束使用依旧保留原消费者版本，来源当前图不是正文读取来源。
  return { id, workspaceId: 'workspace', ref: { entryId: 'entry', contentDigest: 'fixed-digest' }, consumer: { mapId: 'map', nodeId: 'consumer', revision: 4 },
    reason: '原使用理由', kind: 'work', runId: 'run', operationId: 'operation', workId: 'work', reusedFromOperationId: 'prior-operation',
    startedAt: '2026-10-07T00:00:00.000Z', endedAt: ended ? '2026-10-07T01:00:00.000Z' : null,
    consumerSnapshot: { id: 'consumer', revision: 4, typeId: 'factcheck.opinion', typeVersion: 1,
      payload: { score: 0.5, reason: '原消费者正文' }, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' } }
}
function page(/* 本页使用记录身份。 */ ids: string[], /* 下一页游标，可省略为已结束。 */ cursor: string | null = null, /* 本页使用目录版本。 */ revision = 2): EvidenceUsesPage {
  // 列表返回实际轻量摘要，不附带消费者全文或伪总量。
  return { workspaceId: 'workspace', entryId: 'entry', items: ids.map((/* 单条实际记录身份。 */ id) => {
    // 摘要移除唯一详情字段，保持同一公开记录协议。
    const { consumerSnapshot: _snapshot, ...summary } = use(id)
    return summary
  }), nextCursor: cursor, usageRevision: revision }
}
function call(/* 当前测试状态窗口。 */ f: ReturnType<typeof fixture>, /* 预期请求序号。 */ index: number): Call {
  // 取得实际已经发出的查询，拒绝以非空断言掩盖遗漏请求。
  const result = f.reads[index]
  if (!result) throw new Error(UsesTestMessage.MISSING)
  return result
}
async function settle(): Promise<void> { /* 排空受控响应的微任务，无延时猜测。 */ await Promise.resolve(); await Promise.resolve() }

describe('evidence usage window state', () => {
  // 用户/服务/工作区/库根和查询目录版本共同限定当前可接纳的使用记录。
  it('automatically reads a bounded current-use page and explicitly searches history', async () => {
    // 历史是用户明确筛选，默认不把结束记录混进当前使用。
    const f = fixture()
    expect(call(f, 0).params).toEqual({ workspaceId: 'workspace', entryId: 'entry', includeHistory: false, limit: 25 })
    call(f, 0).resolve(page(['first']))
    await settle()
    f.state.includeHistory.value = true
    const searching = f.state.search()
    expect(call(f, 1).params).toEqual({ workspaceId: 'workspace', entryId: 'entry', includeHistory: true, limit: 25 })
    call(f, 1).resolve(page(['history']))
    expect(await searching).toBe(true)
    f.state.dispose()
  })
  it.each(['userId', 'connectionKey', 'workspaceId', 'entryId'] as const)('rejects old page responses after changing %s', async (
    /* 这次改变的窗口身份字段。 */ field,
  ) => {
    // 旧列表成功和错误均不能进入另一身份的数据面板。
    const f = fixture()
    f.context.value[field] = `other-${field}`
    expect(call(f, 0).signal?.aborted).toBe(true)
    call(f, 0).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: UsesTestMessage.OLD_AUTH, retryable: false }))
    await settle()
    expect(f.state.items.value).toEqual([])
    expect(f.state.error.value).toBeNull()
    expect(f.unauthorized).not.toHaveBeenCalled()
    f.state.dispose()
  })
  it('keeps only the latest explicit list request', async () => {
    // 同身份重复搜索也必须用请求代次隔离迟到旧页。
    const f = fixture()
    const searching = f.state.search()
    call(f, 1).resolve(page(['latest']))
    await searching
    call(f, 0).resolve(page(['old']))
    await settle()
    expect(f.state.items.value.map((/* 当前接纳的摘要。 */ item) => /* 核验真实身份。 */ item.id)).toEqual(['latest'])
    f.state.dispose()
  })
  it('reads fixed consumer history and isolates a later selected usage', async () => {
    // 结束的使用仍读原消费者快照；旧详情401不抢回新详情或注销会话。
    const f = fixture()
    call(f, 0).resolve(page(['a', 'b']))
    await settle()
    const first = f.state.select('a'), latest = f.state.select('b')
    call(f, 2).resolve(use('b', true))
    expect(await latest).toBe(true)
    call(f, 1).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: UsesTestMessage.OLD_AUTH, retryable: false }))
    expect(await first).toBe(false)
    expect(f.state.detail.value).toMatchObject({ id: 'b', endedAt: '2026-10-07T01:00:00.000Z', consumerSnapshot: { revision: 4, payload: { score: 0.5 } } })
    expect(f.unauthorized).not.toHaveBeenCalled()
    expect(f.reads.every((/* 实际公开读取。 */ read) => /* 不向当前Map获取消费者正文。 */ read.method.startsWith('evidence.'))).toBe(true)
    f.state.dispose()
  })
  it('continues one usage revision and refuses changed history drafts', async () => {
    // 续页仅属于上次成功筛选，用户修改历史开关后必须显式刷新。
    const f = fixture()
    call(f, 0).resolve(page(['first'], 'cursor'))
    await settle()
    const loading = f.state.loadMore()
    expect(call(f, 1).params).toEqual({ workspaceId: 'workspace', entryId: 'entry', includeHistory: false, limit: 25, cursor: 'cursor' })
    call(f, 1).resolve(page(['second'], 'second-cursor'))
    await loading
    expect(f.state.items.value).toHaveLength(2)
    f.state.includeHistory.value = true
    expect(await f.state.loadMore()).toBe(false)
    expect(f.state.error.value?.code).toBe('EVIDENCE_CURSOR_INVALID')
    expect(f.reads).toHaveLength(2)
    f.state.dispose()
  })
  it('keeps the accepted page when a continuation returns another catalog revision', async () => {
    // 不同使用目录版本不能拼成一页，原摘要保留供用户明确刷新。
    const f = fixture()
    call(f, 0).resolve(page(['first'], 'cursor'))
    await settle()
    const loading = f.state.loadMore()
    call(f, 1).resolve(page(['wrong-page'], null, 3))
    expect(await loading).toBe(false)
    expect(f.state.items.value.map((/* 已接纳的摘要。 */ item) => /* 原页身份不被新版本覆盖。 */ item.id)).toEqual(['first'])
    expect(f.state.nextCursor.value).toBeNull()
    expect(f.state.error.value?.code).toBe('EVIDENCE_CURSOR_EXPIRED')
    f.state.dispose()
  })
  it('notifies the owner only for a current unauthorized reply', async () => {
    // 当前读取认证失败交给会话所有者，没有状态内重新登录流程。
    const f = fixture()
    call(f, 0).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: UsesTestMessage.CURRENT_AUTH, retryable: false }))
    await settle()
    expect(f.unauthorized).toHaveBeenCalledOnce()
    f.state.dispose()
  })
  it('cancels both list and detail on close and ignores their late replies', async () => {
    // 面板关闭后在途读取全部取消，不能把旧消费者恢复到已关闭窗口。
    const f = fixture()
    const selecting = f.state.select('a')
    f.state.dispose()
    expect(call(f, 0).signal?.aborted).toBe(true)
    expect(call(f, 1).signal?.aborted).toBe(true)
    call(f, 0).resolve(page(['late']))
    call(f, 1).resolve(use('a'))
    expect(await selecting).toBe(false)
    expect(f.state.items.value).toEqual([])
    expect(f.state.detail.value).toBeNull()
    expect(f.state.loading.value).toBe(false)
    expect(f.state.detailLoading.value).toBe(false)
    expect(await f.state.search()).toBe(false)
  })
})
