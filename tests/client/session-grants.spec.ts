// S1 先行测试：仅经真实会话公开方法和类型化网关边界控制授权、读取与事件顺序。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientGateway, CommandInputMap, CommandOutputMap, QueryInputMap, QueryOutputMap } from '../../contracts/client'
import { ClientError } from '../../contracts/client'
import type { AppBootstrap, WorkspaceView } from '../../contracts/control'
import type { GraphStreamEvent } from '../../contracts/events'
import type { GraphSnapshot, GraphSuccess } from '../../contracts/graph-api'
import type { GraphBranchClaimResult, GraphBranchGrant, GraphBranchOwnership, GraphBranchSnapshot } from '../../contracts/graph-branch'
import { sessionCreateState } from '../../apps/ui/state/client-session'

const MAP_ID = '11000000-0000-4000-8000-000000000001'
const WORKSPACE_ID = '22000000-0000-4000-8000-000000000001'
const NODE_A = '33000000-0000-4000-8000-000000000001'
const NODE_B = '33000000-0000-4000-8000-000000000002'
const USER_ID = '44000000-0000-4000-8000-000000000001'
const LEASE_MS = 9_000
const ORIGIN = 'http://s1.fixture'
const TIME = '2026-10-18T00:00:00.000Z'

enum GrantsMessage {
  UNEXPECTED_QUERY = 'S1 网关收到未配置的查询。',
  UNEXPECTED_COMMAND = 'S1 网关收到未配置的命令。',
  UNEXPECTED_FILE = 'S1 授权测试不使用文件传输。',
  LEASE_MISSING = 'S1 权威边界没有与请求匹配的有效租约。',
  BRANCH_READ_FAILED = 'S1 受控旧分支读取失败。',
  RENEW_FAILED = 'S1 受控续租失败。',
  RELEASE_TRANSPORT_FAILED = 'S1 释放请求发生运输失败，提交结果未确认。',
  CLAIM_TRANSPORT_FAILED = 'S1 旧领取请求未提交即发生运输失败。',
  STREAM_MISSING = 'S1 测试没有找到已建立的公开图订阅。',
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(/* 由真实公开边界应返回的完整类型值。 */ value: T): void
  reject(/* 本用例安排到达顺序的结构化失败。 */ reason: unknown): void
}

type QueryHandlers = { [K in keyof QueryInputMap]?: (/* 与当前查询方法精确对应的参数。 */ params: QueryInputMap[K]) => Promise<QueryOutputMap[K]> }
type CommandHandlers = { [K in keyof CommandInputMap]?: (/* 与当前命令方法精确对应的参数。 */ params: CommandInputMap[K]) => Promise<CommandOutputMap[K]> }
type Session = ReturnType<typeof sessionCreateState>

interface StreamControl {
  readonly signal: AbortSignal | undefined
  emit(/* 已经通过网关协议边界的公开流事件。 */ event: GraphStreamEvent): void
}

/** 建立仅用于安排公开异步结果的可控 Promise，不接触会话内部 refs。 */
function grantsDeferred<T>(): Deferred<T> {
  // 保存类型化完成入口，调用方必须提供合法 DTO 或明确错误。
  let complete: (/* 完整的公开返回值。 */ value: T) => void = () => { /* Promise 构造时立即替换。 */ }
  let fail: (/* 本次等待应收到的错误对象。 */ reason: unknown) => void = () => { /* Promise 构造时立即替换。 */ }
  const promise = new Promise<T>((/* 公开边界成功时完成等待。 */ resolve, /* 公开边界失败时拒绝等待。 */ reject) => {
    // 只控制传输完成顺序，不模拟会话内部状态转换。
    complete = resolve; fail = reject
  })
  return {
    promise,
    resolve(/* 本次请求对应的精确返回 DTO。 */ value): void { /* 交付真实类型的成功结果。 */ complete(value) },
    reject(/* 本次请求对应的受控错误。 */ reason): void { /* 交付原始错误对象。 */ fail(reason) },
  }
}

/** 生成授权测试的结构化客户端错误，不用 message 判断控制流。 */
function grantsFailure(
  /* 本例明确选择的固定失败分类。 */ message: GrantsMessage,
): ClientError {
  // 均为运输或当前续租失败，避免顺带退出身份掩盖授权问题。
  return new ClientError({ status: 0, code: 'NETWORK_ERROR', message, retryable: true })
}

/** 从公开快照构造本测试独立根的稳定内容证明，授权变化不改变其版本。 */
function grantsReadBranch(
  /* 网关权威读取中的真实协议形状快照。 */ snapshot: GraphSnapshot,
  /* 公开查询或 claim 明确请求的独立根。 */ roots: readonly string[],
): GraphBranchSnapshot {
  // 测试图没有边，每个根闭包只有自身；版本只由根节点内容版本决定。
  const rootIds = [...roots].sort()
  const nodes = snapshot.nodes.filter((/* 权威快照中的节点。 */ node) => /* 独立根不包含其他节点。 */ rootIds.includes(node.id))
  return { scope: { rootIds, nodeIds: [...rootIds], edgeIds: [] }, mapRevision: snapshot.revision,
    version: nodes.map((/* 当前根节点及其内容版本。 */ node) => /* 租约信息不会进入内容证明。 */ `${node.id}:${node.revision}`).join('|'),
    rootRevisions: Object.fromEntries(nodes.map((/* 当前独立根。 */ node) => /* 为公开证明保留精确节点版本。 */ [node.id, node.revision])) }
}

/** 投影服务端授权为公开 ownership，不把私有 grant 附带字段塞进图快照。 */
function grantsReadOwnership(
  /* 由本边界已确认、仍归当前 holder 的授权。 */ grant: GraphBranchGrant,
): GraphBranchOwnership {
  // 快照只携带公开占有字段，grant 的分支证明及确认序号单独保存。
  return { kind: 'editor', leaseId: grant.leaseId, rootIds: [...grant.rootIds], ownerUserId: grant.ownerUserId,
    holderId: grant.holderId, fence: grant.fence, expiresAt: grant.expiresAt, leaseMs: grant.leaseMs, scope: structuredClone(grant.scope) }
}

/** 建立类型化可控网关；只有公开查询/命令/事件可改变会话观察到的状态。 */
function grantsCreateGateway(
  /* 服务端公布的真实策略分支，none 用于本机对照。 */ leases: 'required' | 'none' = 'required',
) {
  // 权威占有与可延迟交付的消息分开，允许合法模拟已提交但响应尚在途。
  const authority: GraphSnapshot = { mapId: MAP_ID, workspaceId: WORKSPACE_ID, revision: 1, name: 'S1 授权时序',
    nodes: [NODE_A, NODE_B].map((/* 测试图的合法独立根身份。 */ id) => /* 沿用同一精确类型与固定正文。 */ ({
      id, revision: 0, typeId: 's1.fact', typeVersion: 1, payload: { content: `S1 ${id}` }, createdAt: TIME, updatedAt: TIME,
    })), edges: [], runs: [], ownershipRevision: 0, ownerships: [], runControls: [], updatedAt: TIME }
  const bootstrap: AppBootstrap = { identity: { userId: USER_ID, displayName: 'S1 用户', hostAdmin: false },
    settings: { revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 1 } },
    metadata: { clientLeases: leases, variables: {} } }
  const workspace: WorkspaceView = { id: WORKSPACE_ID, name: 'S1 工作区', description: '', revision: 0, role: 'editor', mapCount: 1,
    updatedAt: TIME, agents: [], members: [{ userId: USER_ID, displayName: 'S1 用户', role: 'editor' }],
    preferences: { workspaceId: WORKSPACE_ID, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} } }
  let configured = false, activeOrigin = ORIGIN, latestGrant: GraphBranchGrant | null = null, serial = 0
  const grantsByLease = new Map<string, GraphBranchGrant>()
  const commandMethods: Array<keyof CommandInputMap> = []
  const claimCalls: Array<CommandInputMap['branch.claim']> = []
  const renewCalls: Array<CommandInputMap['branch.renew']> = []
  const releaseCalls: Array<CommandInputMap['branch.release']> = []
  const releaseOrigins: string[] = []
  const branchCalls: Array<QueryInputMap['branch.get']> = []
  const streams: StreamControl[] = []

  function commitClaim(/* 当前公开 claim 请求的真实根与 holder。 */ params: CommandInputMap['branch.claim']): GraphBranchClaimResult {
    // 同 holder/同根可复用；其他活跃重叠必须 busy，不能用新授权覆盖旧租约。
    for (const [leaseId, grant] of grantsByLease) {
      // 真实 claim 会清掉已经到期的记录，再为新确认创建新身份；不复用已到期 lease。
      if (Date.parse(grant.expiresAt) <= Date.now()) grantsByLease.delete(leaseId)
    }
    const branch = grantsReadBranch(authority, params.rootIds)
    const existing = [...grantsByLease.values()].find((/* 当前服务端仍保存的独立根租约。 */ grant) =>
      /* 同 holder 的未过期同根租约才可复用身份，成功 release 后不会再找到它。 */
      grant.holderId === params.holderId && [...grant.rootIds].sort().join('|') === branch.scope.rootIds.join('|'))
    const conflict = [...grantsByLease.values()].find((/* 当前仍有效的其他租约。 */ grant) =>
      /* 独立根不冲突；多根领取与既有根重叠时仍须由服务端拒绝。 */ grant.leaseId !== existing?.leaseId
      && grant.scope.nodeIds.some((/* 当前已占有闭包内的节点身份。 */ id) => /* 本图无边，节点闭包重叠就是实际冲突。 */ branch.scope.nodeIds.includes(id)))
    if (conflict) return { status: 'busy', ownership: grantsReadOwnership(conflict) }
    authority.ownershipRevision++
    const grant: GraphBranchGrant = { kind: 'editor', leaseId: existing?.leaseId ?? `55000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
      holderId: params.holderId, ownerUserId: USER_ID, fence: existing?.fence ?? authority.ownershipRevision,
      rootIds: [...params.rootIds], scope: structuredClone(branch.scope), expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      leaseMs: LEASE_MS, branch, ownershipRevision: authority.ownershipRevision }
    latestGrant = grant
    grantsByLease.set(grant.leaseId, grant)
    authority.ownerships = [...grantsByLease.values()].map((/* 同图多个合法独立根的实际租约。 */ item) => /* 不让 B 的 claim 隐式删除 A。 */ grantsReadOwnership(item))
    return { status: 'claimed', grant: structuredClone(grant) }
  }

  function commitRenew(/* 当前公开续租请求，不允许替换租约身份或 fence。 */ params: CommandInputMap['branch.renew']): GraphBranchGrant {
    // 每次权威续租增加占有版本并延长截止时间，分支内容保持原值。
    const current = grantsByLease.get(params.lease.leaseId)
    if (!current || current.holderId !== params.lease.holderId || current.fence !== params.lease.fence) throw new Error(GrantsMessage.LEASE_MISSING)
    authority.ownershipRevision++
    latestGrant = { ...current, expiresAt: new Date(Date.now() + LEASE_MS).toISOString(), ownershipRevision: authority.ownershipRevision }
    grantsByLease.set(latestGrant.leaseId, latestGrant)
    authority.ownerships = [...grantsByLease.values()].map((/* 独立根的实际租约。 */ item) => /* 续租只延长匹配项，保留其他根。 */ grantsReadOwnership(item))
    return structuredClone(latestGrant)
  }

  function confirmExpiry(
    /* 真实服务端新投影仍指向的同一 lease。 */ leaseId: string,
    /* 新的绝对 ISO 截止时间，身份和 fence 不随投影改变。 */ expiresAt: string,
  ): GraphSnapshot {
    // 按公开合同模拟更高 O 的权威期限确认，不直接修改客户端授权。
    const current = grantsByLease.get(leaseId)
    if (!current) throw new Error(GrantsMessage.LEASE_MISSING)
    authority.ownershipRevision++
    const confirmed = { ...current, expiresAt, ownershipRevision: authority.ownershipRevision }
    grantsByLease.set(leaseId, confirmed)
    if (latestGrant?.leaseId === leaseId) latestGrant = confirmed
    authority.ownerships = [...grantsByLease.values()].map((/* 真实记录中的各独立根租约。 */ item) => /* 只投影已确认的公开字段。 */ grantsReadOwnership(item))
    return structuredClone(authority)
  }

  const readHandlers: QueryHandlers = {
    'app.bootstrap': async () => { /* 返回明确策略，不经过全局默认网关。 */ return structuredClone(bootstrap) },
    'workspace.list': async () => { /* 当前普通用户仅可见本测试工作区。 */ return { items: [structuredClone(workspace)], nextCursor: null } },
    'workspace.get': async () => { /* 读取同一个已授权工作区及独立偏好。 */ return structuredClone(workspace) },
    'map.list': async () => { /* 摘要和完整快照属于同一个真实协议身份。 */ return [{ id: MAP_ID, workspaceId: WORKSPACE_ID, revision: authority.revision,
      name: authority.name, nodeCount: authority.nodes.length, typeCounts: { 's1.fact@1': authority.nodes.length }, updatedAt: TIME }] },
    'map.get': async () => { /* 公共读取返回权威状态的副本，旧 SSE 不会倒改它。 */ return structuredClone(authority) },
    'definition.get': async () => { /* 只提供测试图采用的精确类型，不启动转换或执行。 */ return { workspaceId: WORKSPACE_ID,
      catalog: { revision: 0, packages: [], index: [], transitions: [], dataTypes: [{ id: 's1.fact', version: 1, title: '事实',
        schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
        successorTypes: [], references: [], agentProjection: { include: ['/content'], mapEntryFilters: [] } }] } } },
    'branch.get': async (/* 当前公开查询所选的根。 */ params) => { /* 默认直接读取独立根，个别用例只替换传输顺序。 */ return grantsReadBranch(authority, params.rootIds) },
  }
  const commandHandlers: CommandHandlers = {
    'preferences.set': async (/* 会话防抖保存的原偏好参数。 */ params) => {
      // 偏好不影响图内容或授权版本，避免假计时推进引发无关错误。
      workspace.preferences = { workspaceId: params.workspaceId, revision: params.expectedRevision + 1,
        openMapIds: [...params.openMapIds], currentMapId: params.currentMapId, nodeSelection: { ...params.nodeSelection } }
      return structuredClone(workspace.preferences)
    },
    'branch.claim': async (/* 当前会话通过公开方法声明的根和 holder。 */ params) => { /* 按合法契约确认授权。 */ return commitClaim(params) },
    'branch.renew': async (/* 当前会话持有的精确 lease 证明。 */ params) => { /* 保留身份和 fence，只推进确认版本及期限。 */ return commitRenew(params) },
    'branch.release': async (/* 只能解除此精确 lease/holder/fence 的公开证明。 */ params) => {
      // 迟到 A 的释放不得删除 B；成功释放后的同根 claim 必须产生新身份/fence。
      const current = grantsByLease.get(params.lease.leaseId)
      if (!current || current.holderId !== params.lease.holderId || current.fence !== params.lease.fence) throw new Error(GrantsMessage.LEASE_MISSING)
      grantsByLease.delete(current.leaseId)
      if (latestGrant?.leaseId === current.leaseId) latestGrant = null
      authority.ownerships = [...grantsByLease.values()].map((/* 未被本次精确释放的其他租约。 */ item) => /* 保留其他根和 holder 的占有。 */ grantsReadOwnership(item))
      authority.ownershipRevision++
      return { released: true, ownershipRevision: authority.ownershipRevision }
    },
  }
  const gateway: ClientGateway = {
    async connect(/* 用户通过公开方法选定的服务 origin，凭据不进入断言。 */ input) {
      // 记录真实网关会切换的路由归属，便于验证旧清理不会误发给新服务。
      configured = true; activeOrigin = input.baseUrl; return structuredClone(bootstrap)
    },
    async disconnect() { /* 仅清除本测试网关的连接状态。 */ configured = false },
    async getConnection() { /* 展示连接信息不包含测试令牌。 */ return { baseUrl: activeOrigin, configured, remembered: false, canRemember: false } },
    async read<K extends keyof QueryInputMap>(
      /* 与参数/返回映射相绑定的公开查询键。 */ method: K,
      /* 此键唯一允许的参数 DTO。 */ params: QueryInputMap[K],
    ): Promise<QueryOutputMap[K]> {
      // 由 mapped handler 保留输入输出关联，不用 any 或双重强制转换绕过合同。
      const handler = readHandlers[method]
      if (!handler) throw new Error(GrantsMessage.UNEXPECTED_QUERY)
      return handler(params)
    },
    async dispatch<K extends keyof CommandInputMap>(
      /* 会话生成的稳定请求身份，原样放进成功信封。 */ requestId: string,
      /* 与参数/返回映射相绑定的公开命令键。 */ method: K,
      /* 此键唯一允许的业务参数 DTO。 */ params: CommandInputMap[K],
    ): Promise<GraphSuccess<CommandOutputMap[K]>> {
      // 记录方法名便于验证本机不发租约命令，参数仍由精确 handler 校验。
      commandMethods.push(method)
      if (method === 'branch.release') releaseOrigins.push(activeOrigin)
      const handler = commandHandlers[method]
      if (!handler) throw new Error(GrantsMessage.UNEXPECTED_COMMAND)
      return { ok: true, requestId, replayed: false, data: await handler(params) }
    },
    watch(
      /* 此会话已经打开的图身份；测试仅有这一张图。 */ _mapId,
      /* 会话提供的真实公开事件接纳回调。 */ onEvent,
      /* 视图退出时结束订阅，避免留下重连和未处理拒绝。 */ signal,
    ): Promise<void> {
      // 只控制真实会话的外部事件入口，不访问其私有函数或可写 refs。
      return new Promise<void>((/* 视图正常取消后结束等待。 */ resolve, /* 回调自身失败时保留异常。 */ reject) => {
        // 事件交付发生在当前活跃订阅；旧视图通过 AbortSignal 结束。
        streams.push({ signal, emit(/* 已经由测试构造为公开合同的流事件。 */ event): void {
          // 事件处理错误交给真实订阅 Promise，不能吞掉状态机失败。
          try { onEvent(structuredClone(event)) } catch (error) { reject(error) }
        } })
        signal?.addEventListener('abort', () => { /* 退出视图后让旧 watch 有界结束。 */ resolve() }, { once: true })
      })
    },
    async upload() { /* S1 不通过文件路径或其他接口制造状态。 */ throw new Error(GrantsMessage.UNEXPECTED_FILE) },
    async download() { /* S1 不使用文件读取。 */ throw new Error(GrantsMessage.UNEXPECTED_FILE) },
  }

  // 单独包裹精确 handler，记录 typed 参数，后续测试可继续替换该边界。
  const defaultBranch = readHandlers['branch.get']
  readHandlers['branch.get'] = async (/* 当前真实会话请求的独立根。 */ params) => {
    // 保留请求顺序，供用例把一个早发响应扣住。
    branchCalls.push(structuredClone(params))
    if (!defaultBranch) throw new Error(GrantsMessage.UNEXPECTED_QUERY)
    return defaultBranch(params)
  }
  const defaultClaim = commandHandlers['branch.claim']
  commandHandlers['branch.claim'] = async (/* 会话 claim 的精确参数。 */ params) => {
    // 参数记录不会改变权威授权或会话选择。
    claimCalls.push(structuredClone(params))
    if (!defaultClaim) throw new Error(GrantsMessage.UNEXPECTED_COMMAND)
    return defaultClaim(params)
  }
  const defaultRenew = commandHandlers['branch.renew']
  commandHandlers['branch.renew'] = async (/* 会话自动续租的精确参数。 */ params) => {
    // 自动计时只触发公开命令，测试不调用私有 renewBranch。
    renewCalls.push(structuredClone(params))
    if (!defaultRenew) throw new Error(GrantsMessage.UNEXPECTED_COMMAND)
    return defaultRenew(params)
  }
  const defaultRelease = commandHandlers['branch.release']
  commandHandlers['branch.release'] = async (/* 公开释放时应删除的精确 lease。 */ params) => {
    // 成功和运输失败的区别由 handler 明确保留。
    releaseCalls.push(structuredClone(params))
    if (!defaultRelease) throw new Error(GrantsMessage.UNEXPECTED_COMMAND)
    return defaultRelease(params)
  }
  return {
    gateway, readHandlers, commandHandlers, authority, claimCalls, renewCalls, releaseCalls, releaseOrigins, branchCalls, commandMethods,
    commitClaim, commitRenew, confirmExpiry,
    snapshot(): GraphSnapshot { /* 独立读取当前权威事实，不让旧消息改写它。 */ return structuredClone(authority) },
    grant(): GraphBranchGrant | null { /* 返回已确认授权的副本，仅用于公开事实核对。 */ return latestGrant ? structuredClone(latestGrant) : null },
    emit(/* 需要按受控顺序交给会话的原始公开快照。 */ snapshot: GraphSnapshot): void {
      // 不修改权威状态；此入口只模拟传输迟到或服务端当前投影交付。
      const stream = streams.find((/* 已建立的公开 watch。 */ item) => /* 只选当前未退出视图。 */ !item.signal?.aborted)
      if (!stream) throw new Error(GrantsMessage.STREAM_MISSING)
      stream.emit({ type: 'snapshot', snapshot })
    },
  }
}

const sessions: Session[] = []

beforeEach(() => {
  // 固定真实期限语义，测试只通过推进虚拟时钟触发公开续租。
  vi.useFakeTimers(); vi.setSystemTime(new Date(TIME))
})

afterEach(async () => {
  // 会话自身释放计时器和 watch，再恢复时钟，不等待永远悬挂的受控运输结果。
  for (const session of sessions.splice(0)) session.dispose()
  await Promise.resolve()
  vi.useRealTimers()
})

/** 初始化真实会话并等待公开选择读取就绪，不修改任何会话状态 refs。 */
async function grantsOpen(
  /* 服务端明确公布的协作/本机策略。 */ leases: 'required' | 'none' = 'required',
) {
  // 连接、进入工作区、打开图和选点均采用生产会话的公开方法。
  const fixture = grantsCreateGateway(leases)
  const session = sessionCreateState(fixture.gateway, 100)
  sessions.push(session)
  await session.connect({ baseUrl: ORIGIN, token: 's1-test-token', remember: false })
  await session.openMap(MAP_ID, false)
  session.selectNode(NODE_A)
  await vi.waitFor(() => { /* 等待公开 branch 读取完成，尚不领取授权。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_A]) })
  return { fixture, session }
}

/** 有限推进 Promise/响应接纳微任务，不推进租期或用固定 sleep 决定先后。 */
async function grantsFlush(): Promise<void> {
  // 网关及 session 各有少量 await；明确清空本测试边界的微任务链。
  for (let step = 0; step < 8; step++) await Promise.resolve()
}

describe('S1 confirmed branch grants and asynchronous ownership', () => {
  // 只覆盖授权确认与异步隔离，不在此测试 S2 的正文保存/基线配对。
  it('CS01 claim O1 survives an old same-content O0 snapshot and still renews', async () => {
    // 先保留旧帧，再确认授权，最后交付旧帧，权威占有始终存在。
    const { fixture, session } = await grantsOpen()
    const stale = fixture.snapshot()
    expect(await session.claimBranch()).toBe(true)
    const confirmed = fixture.grant()
    expect(confirmed?.ownershipRevision).toBe(1)
    fixture.emit(stale)
    expect.soft(session.selectedBranchGrant.value).toEqual(confirmed)
    expect(session.snapshot.value?.ownershipRevision).toBe(0)
    expect(fixture.snapshot().ownerships).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3)
    expect(fixture.renewCalls).toHaveLength(1)
    expect(session.selectedBranchGrant.value?.ownershipRevision).toBe(2)
  })

  it('CS02 renewed O2 survives a delayed O1 snapshot without restoring old expiry', async () => {
    // 旧快照确实产生于续租之前，不更改权威状态来制造失败。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const beforeRenew = fixture.snapshot()
    const firstExpiry = session.selectedBranchGrant.value?.expiresAt
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3)
    const renewed = fixture.grant()
    expect(renewed?.ownershipRevision).toBe(2)
    expect(renewed?.expiresAt).not.toBe(firstExpiry)
    fixture.emit(beforeRenew)
    expect(session.selectedBranchGrant.value).toEqual(renewed)
  })

  it('CS02 renewed O2 survives a genuinely pre-claim O0 frame with no lease', async () => {
    // 原始 O0 帧始终不含租约，不能因确认来自 renew 就漏掉版本保护。
    const { fixture, session } = await grantsOpen()
    const beforeClaim = fixture.snapshot()
    await session.claimBranch()
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3)
    const renewed = fixture.grant()
    expect(renewed?.ownershipRevision).toBe(2)
    fixture.emit(beforeClaim)
    expect(session.selectedBranchGrant.value).toEqual(renewed)
  })

  it('CS02 same-O expired projection revokes a grant without inventing a newer O', async () => {
    // 当前续租悬挂，服务端按原期限投影缺失占有，O 数字本身不增加。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const confirmed = fixture.grant()
    const pending = grantsDeferred<GraphBranchGrant>()
    fixture.commandHandlers['branch.renew'] = async () => { /* 续租未确认时不能延长期限。 */ return pending.promise }
    await vi.advanceTimersByTimeAsync(LEASE_MS)
    const expired = fixture.snapshot()
    expired.ownerships = []
    expect(expired.ownershipRevision).toBe(confirmed?.ownershipRevision)
    fixture.emit(expired)
    expect(session.selectedBranchGrant.value).toBeNull()
  })

  it('CS02 current grant expires even when its renewal transport never answers', async () => {
    // 不依赖新快照或失败回包；已确认授权不能在原 expiresAt 后无限有效。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const pending = grantsDeferred<GraphBranchGrant>()
    fixture.commandHandlers['branch.renew'] = async () => { /* 当前续租保持在途，不代表成功。 */ return pending.promise }
    await vi.advanceTimersByTimeAsync(LEASE_MS)
    expect(fixture.commandMethods.filter((/* 公开命令身份。 */ method) => /* 确认实际触发过续租。 */ method === 'branch.renew')).toHaveLength(1)
    expect(session.selectedBranchGrant.value).toBeNull()
  })

  it('CS01 a released O2 snapshot received before delayed claim O1 prevents resurrection', async () => {
    // 服务端先提交 claim 再合法 release，只把较旧的 claim 成功响应留在运输中。
    const { fixture, session } = await grantsOpen()
    const held = grantsDeferred<GraphBranchClaimResult>()
    let response: GraphBranchClaimResult | undefined
    fixture.commandHandlers['branch.claim'] = async (/* 原选择 A 的公开请求。 */ params) => {
      // 权威状态确实先获得 O1，响应随后被扣住。
      response = fixture.commitClaim(params)
      return held.promise
    }
    const claiming = session.claimBranch()
    await grantsFlush()
    const granted = fixture.grant()
    if (!granted || !response) throw new Error(GrantsMessage.LEASE_MISSING)
    await fixture.gateway.dispatch('s1-release-before-ack', 'branch.release', { mapId: MAP_ID,
      lease: { leaseId: granted.leaseId, holderId: granted.holderId, fence: granted.fence } })
    fixture.emit(fixture.snapshot())
    expect(session.snapshot.value?.ownershipRevision).toBe(2)
    held.resolve(response)
    expect(await claiming).toBe(false)
    expect(session.selectedBranchGrant.value).toBeNull()
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3)
    expect(fixture.renewCalls).toHaveLength(0)
    expect(session.snapshot.value?.ownershipRevision).toBe(2)
  })

  it('CS02 authoritative shorter expiry uses its absolute deadline rather than a fresh lease duration', async () => {
    // 更高 O 可缩短期限；续租没有确认时不能擅自延长，合法提前续租本身不受禁止。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const granted = fixture.grant()
    if (!granted) throw new Error(GrantsMessage.LEASE_MISSING)
    const pending = grantsDeferred<GraphBranchGrant>()
    fixture.commandHandlers['branch.renew'] = async () => { /* 允许发起真实续租，但运输悬挂不能构成期限确认。 */ return pending.promise }
    const deadline = Date.now() + 500
    fixture.emit(fixture.confirmExpiry(granted.leaseId, new Date(deadline).toISOString()))
    expect(session.selectedBranchGrant.value?.expiresAt).toBe(new Date(deadline).toISOString())
    await vi.advanceTimersByTimeAsync(499)
    expect(session.selectedBranchGrant.value).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(Date.now()).toBe(deadline)
    expect(session.selectedBranchGrant.value).toBeNull()
  })

  it('CS02 a late matching expiry confirmation renews before its short remaining deadline', async () => {
    // SSE 先产生后延迟交付；到达时 remaining 小于 leaseMs/3，不能把续租排到 expiry 同刻。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const granted = fixture.grant()
    if (!granted) throw new Error(GrantsMessage.LEASE_MISSING)
    const deadline = Date.now() + 3_500
    const heldFrame = fixture.confirmExpiry(granted.leaseId, new Date(deadline).toISOString())
    await vi.advanceTimersByTimeAsync(2_500)
    fixture.emit(heldFrame)
    expect(Date.now()).toBeLessThan(deadline)
    expect(deadline - Date.now()).toBeLessThan(LEASE_MS / 3)
    await vi.advanceTimersByTimeAsync(999)
    expect(Date.now()).toBeLessThan(deadline)
    expect.soft(fixture.renewCalls).toHaveLength(1)
    expect(Date.parse(session.selectedBranchGrant.value?.expiresAt ?? TIME)).toBeGreaterThan(deadline)
  })

  it('CS02 public claim cache rejects expired proof before a delayed expiry timer runs', async () => {
    // 只跳绝对时钟不执行任何 timer，模拟后台节流或长任务后的首次用户操作。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const first = fixture.grant()
    if (!first) throw new Error(GrantsMessage.LEASE_MISSING)
    vi.setSystemTime(new Date(first.expiresAt))
    expect(session.selectedBranchGrant.value?.leaseId).toBe(first.leaseId)
    expect(fixture.renewCalls).toHaveLength(0)
    expect(await session.claimBranch()).toBe(true)
    expect(fixture.claimCalls).toHaveLength(2)
    expect(session.selectedBranchGrant.value?.leaseId).not.toBe(first.leaseId)
    expect(Date.parse(session.selectedBranchGrant.value?.expiresAt ?? TIME)).toBeGreaterThan(Date.now())
  })

  it('CS02 a matching authoritative renewal snapshot wins over the old deadline and late renewal failure', async () => {
    // 服务端已经提交延长，只扣住 HTTP 响应；真实 O2 SSE 可以先于该响应确认新期限。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const first = fixture.grant()
    const inFlight = grantsDeferred<GraphBranchGrant>()
    fixture.commandHandlers['branch.renew'] = async (/* 真实会话已经发出的旧续租证明。 */ params) => {
      // 先推进真实契约权威事实，再仅延迟运输结果，不改客户端 refs。
      fixture.commitRenew(params)
      return inFlight.promise
    }
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3)
    const extended = fixture.grant()
    expect(extended?.ownershipRevision).toBe(2)
    expect(extended?.leaseId).toBe(first?.leaseId)
    expect(extended?.fence).toBe(first?.fence)
    expect(extended?.expiresAt).not.toBe(first?.expiresAt)
    fixture.emit(fixture.snapshot())
    expect.soft(session.selectedBranchGrant.value?.expiresAt).toBe(extended?.expiresAt)
    expect.soft(session.selectedBranchGrant.value?.ownershipRevision).toBe(2)
    // 不确认下一次请求，防止测试靠第二次 HTTP 成功弥补 SSE 接纳缺口。
    fixture.commandHandlers['branch.renew'] = async () => { /* 后续续租没有确认，也不再推进服务端事实。 */ return grantsDeferred<GraphBranchGrant>().promise }
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2 / 3)
    expect(Date.now()).toBe(Date.parse(first?.expiresAt ?? TIME))
    expect(Date.now()).toBeLessThan(Date.parse(extended?.expiresAt ?? TIME))
    expect.soft(session.selectedBranchGrant.value?.expiresAt).toBe(extended?.expiresAt)
    inFlight.reject(grantsFailure(GrantsMessage.RENEW_FAILED))
    await grantsFlush()
    expect.soft(session.selectedBranchGrant.value?.expiresAt).toBe(extended?.expiresAt)
    expect(session.error.value).toBeNull()
  })

  it('CS02 unrelated global O changes with identical own expiry do not postpone renewal', async () => {
    // 无关根可在两帧之间领取并释放，只提高全局 O；本 lease 的期限和 fence 没变。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const ownExpiry = fixture.grant()?.expiresAt
    for (let round = 0; round < 2; round++) {
      await vi.advanceTimersByTimeAsync(1_000)
      // 仅改变受控服务端全局 O，表示另一根完成一轮 claim/release；没有修改会话私有状态。
      fixture.authority.ownershipRevision += 2
      fixture.emit(fixture.snapshot())
      expect(session.selectedBranchGrant.value?.expiresAt).toBe(ownExpiry)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fixture.renewCalls).toHaveLength(1)
    expect(session.selectedBranchGrant.value?.expiresAt).not.toBe(ownExpiry)
  })

  it('CS02 a genuinely newer authoritative removal revokes the grant', async () => {
    // 更高占有版本明确撤销，不允许为保护旧帧而忽略全部 ownership 更新。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const grant = fixture.grant()
    if (!grant) throw new Error(GrantsMessage.LEASE_MISSING)
    await fixture.gateway.dispatch('s1-authoritative-release', 'branch.release', { mapId: MAP_ID,
      lease: { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence } })
    const revoked = fixture.snapshot()
    expect(revoked.ownershipRevision).toBe(grant.ownershipRevision + 1)
    fixture.emit(revoked)
    expect(session.selectedBranchGrant.value).toBeNull()
  })

  it('CS02 failure of the current renewal still removes the current grant', async () => {
    // 当前失败没有后来确认可保护，必须使编辑授权失效。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    fixture.commandHandlers['branch.renew'] = async () => { /* 真实当前请求以结构化失败结束。 */ throw grantsFailure(GrantsMessage.RENEW_FAILED) }
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3)
    expect(session.selectedBranchGrant.value).toBeNull()
    expect(session.error.value?.code).toBe('NETWORK_ERROR')
  })

  it('CS03 claim settles loading while an earlier same-version branch success remains in flight', async () => {
    // 相同内容版本的旧成功不应虚构冲突，授权确认本身已提供可用证明。
    const { fixture, session } = await grantsOpen()
    const oldRead = grantsDeferred<GraphBranchSnapshot>()
    const branch = grantsReadBranch(fixture.snapshot(), [NODE_A])
    fixture.readHandlers['branch.get'] = async () => { /* 扣住 claim 之前已经发出的同版本证明。 */ return oldRead.promise }
    fixture.emit(fixture.snapshot())
    expect(session.branchLoading.value).toBe(true)
    await session.claimBranch()
    expect.soft(session.branchLoading.value).toBe(false)
    oldRead.resolve(branch)
    await grantsFlush()
    expect(session.selectedBranch.value).toEqual(branch)
    expect(session.selectedBranchGrant.value).toEqual(fixture.grant())
    expect(session.branchLoading.value).toBe(false)
    expect(session.error.value).toBeNull()
  })

  it('CS03 an older branch failure cannot clear proof accepted by a successful claim', async () => {
    // 将旧失败安排在新确认之后交付，不能把当前分支重新变成只读未知状态。
    const { fixture, session } = await grantsOpen()
    const oldRead = grantsDeferred<GraphBranchSnapshot>()
    fixture.readHandlers['branch.get'] = async () => { /* 此请求早于 claim 开始。 */ return oldRead.promise }
    fixture.emit(fixture.snapshot())
    await session.claimBranch()
    const confirmed = session.selectedBranch.value
    oldRead.reject(grantsFailure(GrantsMessage.BRANCH_READ_FAILED))
    await grantsFlush()
    expect.soft(session.selectedBranch.value).toEqual(confirmed)
    expect.soft(session.error.value).toBeNull()
    expect(session.branchLoading.value).toBe(false)
  })

  it('CS03 selecting B before delayed claim A arrives releases A without overwriting B', async () => {
    // 服务端已确认 A，只是响应延迟；改变选择后必须释放旧根，不能冒充 B 授权。
    const { fixture, session } = await grantsOpen()
    const delayed = grantsDeferred<GraphBranchClaimResult>()
    let result: GraphBranchClaimResult | undefined
    fixture.commandHandlers['branch.claim'] = async (/* 仍为 A 发出的原 claim。 */ params) => {
      // 权威占用已提交，但公开成功响应暂不交给会话。
      result = fixture.commitClaim(params)
      return delayed.promise
    }
    const claiming = session.claimBranch()
    await grantsFlush()
    session.selectNode(NODE_B)
    await vi.waitFor(() => { /* B 的真实公开读取先完成。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_B]) })
    if (!result) throw new Error(GrantsMessage.LEASE_MISSING)
    delayed.resolve(result)
    await claiming
    await grantsFlush()
    expect.soft(session.selectedId.value).toBe(NODE_B)
    expect.soft(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_B])
    expect.soft(session.selectedBranchGrant.value).toBeNull()
    expect.soft(fixture.releaseCalls).toHaveLength(1)
    expect(fixture.snapshot().ownerships).toHaveLength(0)
  })

  it('CS03 switching service prevents delayed old claim cleanup from reaching the new service', async () => {
    // 两服务即使复用业务 ID，也不能把前一连接的授权清理发送到新 origin。
    const { fixture, session } = await grantsOpen()
    const held = grantsDeferred<GraphBranchClaimResult>()
    let oldResponse: GraphBranchClaimResult | undefined
    fixture.commandHandlers['branch.claim'] = async (/* 仍属于旧服务连接的原始请求。 */ params) => {
      // 仅扣住旧响应，记录其服务端已提交身份。
      oldResponse = fixture.commitClaim(params)
      return held.promise
    }
    const oldClaim = session.claimBranch()
    await grantsFlush()
    const newOrigin = 'http://s1-new.fixture'
    await session.connect({ baseUrl: newOrigin, token: 's1-new-test-token', remember: false })
    await session.openMap(MAP_ID, false)
    session.selectNode(NODE_A)
    await vi.waitFor(() => { /* 新连接正常读取同 ID 的当前选择，不恢复旧私有授权。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_A]) })
    if (!oldResponse) throw new Error(GrantsMessage.LEASE_MISSING)
    held.resolve(oldResponse)
    expect(await oldClaim).toBe(false)
    await grantsFlush()
    expect(session.connection.value?.baseUrl).toBe(newOrigin)
    expect(session.selectedBranchGrant.value).toBeNull()
    expect(fixture.releaseOrigins).not.toContain(newOrigin)
    expect(fixture.releaseCalls).toHaveLength(0)
  })

  it('CS03 old A cleanup cannot revoke a newer A confirmation after A to B to A', async () => {
    // 第一份 A 的 ack 在途；没有成功 release，故再次同 holder claim 合法复用同 lease/fence。
    const { fixture, session } = await grantsOpen()
    const held = grantsDeferred<GraphBranchClaimResult>()
    let oldResponse: GraphBranchClaimResult | undefined, count = 0
    fixture.commandHandlers['branch.claim'] = async (/* 当前选择意图发出的真实根和 holder。 */ params) => {
      // 两次 claim 都提交；第一份响应延迟，第二份响应直接交付。
      const result = fixture.commitClaim(params)
      if (++count === 1) { oldResponse = result; return held.promise }
      return result
    }
    const oldClaim = session.claimBranch()
    await grantsFlush()
    session.selectNode(NODE_B)
    await vi.waitFor(() => { /* B 的公开读取完成后再作新一次选择。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_B]) })
    session.selectNode(NODE_A)
    await vi.waitFor(() => { /* 此时 A 已经属于新选择代次。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_A]) })
    expect(await session.claimBranch()).toBe(true)
    const current = fixture.grant()
    if (!oldResponse || oldResponse.status !== 'claimed' || !current) throw new Error(GrantsMessage.LEASE_MISSING)
    expect(current.leaseId).toBe(oldResponse.grant.leaseId)
    expect(current.fence).toBe(oldResponse.grant.fence)
    expect(current.ownershipRevision).toBeGreaterThan(oldResponse.grant.ownershipRevision)
    held.resolve(oldResponse)
    expect(await oldClaim).toBe(false)
    await grantsFlush()
    expect.soft(session.selectedBranchGrant.value).toEqual(current)
    expect.soft(fixture.releaseCalls).toHaveLength(0)
    expect(fixture.snapshot().ownerships).toMatchObject([{ leaseId: current.leaseId, rootIds: [NODE_A] }])
  })

  it('CS03 old A cleanup preserves a newly committed A whose newer acknowledgement is still held', async () => {
    // 新 A 已在服务端提交但 ack 未到；旧 A 清理不能用同 proof 删除它，也不能靠互相等待造死锁。
    const { fixture, session } = await grantsOpen()
    const oldHeld = grantsDeferred<GraphBranchClaimResult>(), newHeld = grantsDeferred<GraphBranchClaimResult>()
    let oldResponse: GraphBranchClaimResult | undefined, newResponse: GraphBranchClaimResult | undefined, count = 0
    fixture.commandHandlers['branch.claim'] = async (/* 当时选择代次发出的真实根和同 holder。 */ params) => {
      // 两次均先合法提交，再分别扣住响应；没有成功 release 后复用 lease 的非法前提。
      const result = fixture.commitClaim(params)
      if (++count === 1) { oldResponse = result; return oldHeld.promise }
      newResponse = result; return newHeld.promise
    }
    const oldClaim = session.claimBranch()
    await grantsFlush()
    session.selectNode(NODE_B)
    await vi.waitFor(() => { /* 等待 B 的公开证明，确保 A→B 确实发生。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_B]) })
    session.selectNode(NODE_A)
    await vi.waitFor(() => { /* 新 A 的选择代次已经建立，但未领取旧私有授权。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_A]) })
    const newClaim = session.claimBranch()
    await grantsFlush()
    const current = fixture.grant()
    if (!oldResponse || oldResponse.status !== 'claimed' || !newResponse || newResponse.status !== 'claimed' || !current) {
      throw new Error(GrantsMessage.LEASE_MISSING)
    }
    expect(current.leaseId).toBe(oldResponse.grant.leaseId)
    expect(current.fence).toBe(oldResponse.grant.fence)
    expect(current.ownershipRevision).toBeGreaterThan(oldResponse.grant.ownershipRevision)
    oldHeld.resolve(oldResponse)
    await grantsFlush()
    expect.soft(fixture.releaseCalls).toHaveLength(0)
    expect.soft(fixture.snapshot().ownerships).toMatchObject([{ leaseId: current.leaseId, rootIds: [NODE_A] }])
    // 旧清理允许等待新领取收尾，因此必须先交付新 ack，之后才能 await 旧 claiming。
    newHeld.resolve(newResponse)
    expect(await newClaim).toBe(true)
    expect(await oldClaim).toBe(false)
    await grantsFlush()
    expect(session.selectedBranchGrant.value).toEqual(current)
    expect(fixture.snapshot().ownerships).toMatchObject([{ leaseId: current.leaseId, rootIds: [NODE_A] }])
  })

  it('CS03 replacement claim owns busy while old release is held and a new selection can cancel that owner', async () => {
    // 同选择重复请求应被串行拒绝；真正切换选择仍能取消旧准备阶段并合法领取 B。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const held = grantsDeferred<CommandOutputMap['branch.release']>()
    const originalRelease = fixture.commandHandlers['branch.release']
    let committedRelease: CommandOutputMap['branch.release'] | undefined, heldOnce = false
    fixture.commandHandlers['branch.release'] = async (/* 当前会话公开发送的精确释放证明。 */ params) => {
      // 先按精确 proof 真正释放旧 A，只延迟第一次运输回应；后续 B 清理仍真实完成。
      if (!originalRelease) throw new Error(GrantsMessage.UNEXPECTED_COMMAND)
      const result = await originalRelease(params)
      if (!heldOnce) { heldOnce = true; committedRelease = result; return held.promise }
      return result
    }
    const replacing = session.claimBranch([NODE_A, NODE_B])
    await grantsFlush()
    expect.soft(session.busy.value).toBe(true)
    const duplicate = await session.claimBranch([NODE_A, NODE_B])
    expect.soft(duplicate).toBe(false)
    expect.soft(fixture.claimCalls).toHaveLength(1)
    session.selectNode(NODE_B)
    await vi.waitFor(() => { /* 选择变化使旧准备任务失效，B 的新证明正常就绪。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_B]) })
    expect(await session.claimBranch()).toBe(true)
    const selectedGrant = fixture.grant()
    if (!committedRelease || !selectedGrant) throw new Error(GrantsMessage.LEASE_MISSING)
    held.resolve(committedRelease)
    expect(await replacing).toBe(false)
    await grantsFlush()
    expect(session.busy.value).toBe(false)
    expect(session.selectedBranchGrant.value).toEqual(selectedGrant)
    expect(session.selectedBranchGrant.value?.rootIds).toEqual([NODE_B])
    expect(fixture.snapshot().ownerships).toMatchObject([{ leaseId: selectedGrant.leaseId, rootIds: [NODE_B] }])
  })

  it('CS03 a same-root claim waits for an already-sent public release to commit before claiming again', async () => {
    // 旧 release 尚未提交时同 holder 可以复用旧 lease，因此必须先等待精确释放结束再领取。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const first = fixture.grant()
    if (!first) throw new Error(GrantsMessage.LEASE_MISSING)
    const commitRelease = grantsDeferred<void>()
    const originalRelease = fixture.commandHandlers['branch.release']
    fixture.commandHandlers['branch.release'] = async (/* 已发出但尚未在权威服务端提交的旧证明。 */ params) => {
      // 完成屏障后才真正按 leaseId/holder/fence 删除，不能在请求开始时提前清空。
      await commitRelease.promise
      if (!originalRelease) throw new Error(GrantsMessage.UNEXPECTED_COMMAND)
      return originalRelease(params)
    }
    const releasing = session.releaseBranch()
    await grantsFlush()
    expect(fixture.commandMethods.filter((/* 已经发出的真实方法名。 */ method) => /* 确认 release 已进入网关运输。 */ method === 'branch.release')).toHaveLength(1)
    expect(fixture.snapshot().ownerships).toMatchObject([{ leaseId: first.leaseId }])
    let settled = false
    const reclaiming = session.claimBranch().then((/* 当前同根领取意图最终得到的公开结果。 */ result) => {
      // 只观测 Promise 是否结束，不推动或改变会话授权状态。
      settled = true
      return result
    })
    await grantsFlush()
    expect.soft(settled).toBe(false)
    expect.soft(session.busy.value).toBe(true)
    expect.soft(fixture.claimCalls).toHaveLength(1)
    // 新领取需要等释放完成，故必须先放行服务端 commit，再等待新领取结果。
    commitRelease.resolve()
    await releasing
    expect(await reclaiming).toBe(true)
    await grantsFlush()
    const current = session.selectedBranchGrant.value
    expect.soft(current).not.toBeNull()
    expect.soft(current?.leaseId).not.toBe(first.leaseId)
    expect.soft(current?.fence ?? 0).toBeGreaterThan(first.fence)
    expect(fixture.snapshot().ownerships).toMatchObject([{ leaseId: current?.leaseId, rootIds: [NODE_A] }])
    expect(session.busy.value).toBe(false)
  })

  it('CS03 failed release transport cannot let a late release delete a reused current confirmation', async () => {
    // 运输失败不撤销服务端在途提交；未确认释放后不能再借同 holder 复用可被旧 proof 删除的 lease。
    const { fixture, session } = await grantsOpen()
    expect(await session.claimBranch()).toBe(true)
    const first = fixture.grant()
    if (!first) throw new Error(GrantsMessage.LEASE_MISSING)
    const originalRelease = fixture.commandHandlers['branch.release']
    let lateRelease: CommandInputMap['branch.release'] | undefined
    fixture.commandHandlers['branch.release'] = async (/* 已送达但其提交会晚于运输拒绝的原始释放证明。 */ params) => {
      // 只结束客户端运输；保留精确命令供后续真实提交，当前权威租约暂时不变。
      lateRelease = structuredClone(params)
      throw grantsFailure(GrantsMessage.RELEASE_TRANSPORT_FAILED)
    }
    await session.releaseBranch()
    expect(session.selectedBranchGrant.value).toBeNull()
    expect(fixture.snapshot().ownerships).toMatchObject([{ leaseId: first.leaseId }])
    expect.soft(await session.claimBranch()).toBe(false)
    expect.soft(fixture.claimCalls.at(-1)?.holderId).not.toBe(first.holderId)
    expect.soft(session.selectedBranchGrant.value).toBeNull()
    expect.soft(session.error.value?.code).toBe('BRANCH_BUSY')
    expect(session.busy.value).toBe(false)
    if (!lateRelease || !originalRelease) throw new Error(GrantsMessage.UNEXPECTED_COMMAND)
    // 晚提交仍按最初 lease/holder/fence 精确删除，不能靠新快照先撤权掩盖本地假授权。
    const committed = await originalRelease(lateRelease)
    expect(committed.released).toBe(true)
    expect(fixture.snapshot().ownerships).toHaveLength(0)
    expect.soft(session.selectedBranchGrant.value).toBeNull()
    fixture.commandHandlers['branch.release'] = originalRelease
    expect(await session.claimBranch()).toBe(true)
    const current = session.selectedBranchGrant.value
    expect(current).not.toBeNull()
    expect(current?.leaseId).not.toBe(first.leaseId)
    expect(current?.fence ?? 0).toBeGreaterThan(first.fence)
    expect(fixture.snapshot().ownerships).toMatchObject([{ leaseId: current?.leaseId, holderId: current?.holderId }])
  })

  for (const oldOutcome of ['success', 'failure'] as const) {
    it(`CS03 old A claim ${oldOutcome} cannot end pending B busy state or corrupt B`, async () => {
      // A 与 B 的公开请求真实交错；A 的晚结果不能替 B 收尾，也不能撤销 B 的服务端占有。
      const { fixture, session } = await grantsOpen()
      const delayedA = grantsDeferred<GraphBranchClaimResult>(), delayedB = grantsDeferred<GraphBranchClaimResult>()
      let resultA: GraphBranchClaimResult | undefined, resultB: GraphBranchClaimResult | undefined
      fixture.commandHandlers['branch.claim'] = async (/* A 或 B 当时公开声明的实际根和 holder。 */ params) => {
        // 失败 A 表示运输未提交；成功 A 和 B 均真实记录服务端占有，响应各自扣住。
        if (params.rootIds.includes(NODE_A)) {
          if (oldOutcome === 'success') resultA = fixture.commitClaim(params)
          return delayedA.promise
        }
        resultB = fixture.commitClaim(params)
        return delayedB.promise
      }
      const claimingA = session.claimBranch()
      await grantsFlush()
      session.selectNode(NODE_B)
      await vi.waitFor(() => { /* B 的公开分支证明先准备好，才启动 B 的 claim。 */ expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_B]) })
      const claimingB = session.claimBranch()
      await grantsFlush()
      expect(session.busy.value).toBe(true)
      if (oldOutcome === 'success') {
        if (!resultA) throw new Error(GrantsMessage.LEASE_MISSING)
        delayedA.resolve(resultA)
      } else delayedA.reject(grantsFailure(GrantsMessage.CLAIM_TRANSPORT_FAILED))
      await claimingA
      await grantsFlush()
      expect.soft(session.busy.value).toBe(true)
      expect.soft(session.error.value).toBeNull()
      expect.soft(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_B])
      expect.soft(session.selectedBranchGrant.value).toBeNull()
      if (oldOutcome === 'success') expect.soft(fixture.releaseCalls).toHaveLength(1)
      if (!resultB) throw new Error(GrantsMessage.LEASE_MISSING)
      delayedB.resolve(resultB)
      expect(await claimingB).toBe(true)
      await grantsFlush()
      expect(session.busy.value).toBe(false)
      expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_B])
      expect(session.selectedBranchGrant.value?.rootIds).toEqual([NODE_B])
      expect(fixture.snapshot().ownerships).toMatchObject([{ rootIds: [NODE_B] }])
    })
  }

  it('CS02 stale renewal failure cannot remove a fresh lease after committed release loses its response', async () => {
    // release 实际提交但 ack 丢失；再次合法领取产生新 lease/fence，旧续租失败不属于它。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const first = fixture.grant()
    const oldRenew = grantsDeferred<GraphBranchGrant>()
    fixture.commandHandlers['branch.renew'] = async () => { /* 旧续租保持在途，尚未取得新确认。 */ return oldRenew.promise }
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3)
    const originalRelease = fixture.commandHandlers['branch.release']
    fixture.commandHandlers['branch.release'] = async (/* 已实际提交但运输回应会丢失的释放证明。 */ params) => {
      // 精确删除真实租约后才报告运输失败，不把成功释放后旧 lease 复用造为测试前提。
      if (!originalRelease) throw new Error(GrantsMessage.UNEXPECTED_COMMAND)
      await originalRelease(params)
      throw grantsFailure(GrantsMessage.RELEASE_TRANSPORT_FAILED)
    }
    await session.releaseBranch()
    expect(session.selectedBranchGrant.value).toBeNull()
    expect(fixture.snapshot().ownerships).toHaveLength(0)
    expect(await session.claimBranch()).toBe(true)
    const reconfirmed = fixture.grant()
    expect(reconfirmed?.leaseId).not.toBe(first?.leaseId)
    expect(reconfirmed?.fence ?? 0).toBeGreaterThan(first?.fence ?? 0)
    expect(reconfirmed?.ownershipRevision).toBe(3)
    oldRenew.reject(grantsFailure(GrantsMessage.RENEW_FAILED))
    await grantsFlush()
    expect(session.selectedBranchGrant.value).toEqual(reconfirmed)
  })

  it('CS02 an old expiry deadline cannot revoke a later confirmed extension', async () => {
    // 新续租先真实确认，随后当前请求悬挂；只跨过旧截止点，不跨过新截止点。
    const { fixture, session } = await grantsOpen()
    await session.claimBranch()
    const first = fixture.grant()
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3)
    const renewed = fixture.grant()
    const pending = grantsDeferred<GraphBranchGrant>()
    fixture.commandHandlers['branch.renew'] = async () => { /* 后续未确认请求不能改变当前新截止时间。 */ return pending.promise }
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2 / 3)
    expect(Date.now()).toBe(Date.parse(first?.expiresAt ?? TIME))
    expect(Date.now()).toBeLessThan(Date.parse(renewed?.expiresAt ?? TIME))
    expect(session.selectedBranchGrant.value).toEqual(renewed)
  })

  it('local none strategy never dispatches branch claim or automatic renewal', async () => {
    // 本机策略只保留内容证明，不因新增授权保护发出服务端禁用的命令。
    const { fixture, session } = await grantsOpen('none')
    expect(await session.claimBranch()).toBe(true)
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2)
    expect(fixture.commandMethods.filter((/* 已经过公共边界的命令。 */ method) => /* 检查全部租约操作而非只看 grant 是否为空。 */
      method === 'branch.claim' || method === 'branch.renew' || method === 'branch.release')).toHaveLength(0)
    expect(session.selectedBranchGrant.value).toBeNull()
    expect(session.selectedBranch.value?.scope.rootIds).toEqual([NODE_A])
  })
})
