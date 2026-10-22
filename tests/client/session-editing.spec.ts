// S2 先行测试：只经真实会话公开方法与类型化网关边界验证正文快照和分支证明配对。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientError, type ClientGateway, type CommandInputMap, type CommandOutputMap, type QueryInputMap, type QueryOutputMap } from '../../contracts/client'
import type { AppBootstrap, WorkspaceView } from '../../contracts/control'
import type { GraphStreamEvent } from '../../contracts/events'
import type { GraphSnapshot, GraphSuccess, GraphWriteResult } from '../../contracts/graph-api'
import type { GraphBranchGrant, GraphBranchOwnership, GraphBranchSnapshot } from '../../contracts/graph-branch'
import { sessionCreateState } from '../../apps/ui/state/client-session'

const MAP_ID = '61000000-0000-4000-8000-000000000001'
const WORKSPACE_ID = '62000000-0000-4000-8000-000000000001'
const NODE_A = '63000000-0000-4000-8000-000000000001'
const NODE_B = '63000000-0000-4000-8000-000000000002'
const TIME = '2026-10-18T00:00:00.000Z'

enum EditingMessage {
  QUERY_UNEXPECTED = 'S2 网关收到未配置的公开查询。',
  COMMAND_UNEXPECTED = 'S2 网关收到未配置的公开命令。',
  FILE_UNEXPECTED = 'S2 配对测试不使用文件传输。',
  BRANCH_MISSING = 'S2 测试没有取得当前公开分支证明。',
  ROOT_MISSING = 'S2 权威读取中的分支根已经不存在。',
  BRANCH_CONFLICT = 'S2 公开写入的分支版本已经改变。',
  NETWORK_FAILED = 'S2 受控运输结果没有成功交付。',
  STREAM_MISSING = 'S2 测试没有找到当前公开图订阅。',
  READ_BUDGET = 'S2 读取没有在有限公开边界内收敛。',
  CHANGE_UNSUPPORTED = 'S2 测试只接受现有独立根的正文写入和删除。',
  RESULT_MISSING = 'S2 测试没有记录已经提交的写入结果。',
  LEASE_MISSING = 'S2 公开命令没有与当前有效租约匹配的证明。',
}

interface EditingDeferred<T> {
  readonly promise: Promise<T>
  resolve(/* 该公开异步边界应交付的完整 DTO。 */ value: T): void
  reject(/* 该公开异步边界应保留的结构化失败。 */ reason: unknown): void
}
type EditingQueryHandlers = { [K in keyof QueryInputMap]?: (/* 与此公开方法精确绑定的参数。 */ params: QueryInputMap[K]) => Promise<QueryOutputMap[K]> }
type EditingCommandHandlers = { [K in keyof CommandInputMap]?: (/* 与此公开方法精确绑定的参数。 */ params: CommandInputMap[K]) => Promise<CommandOutputMap[K]> }
type EditingSession = ReturnType<typeof sessionCreateState>
interface EditingStream {
  readonly signal: AbortSignal | undefined
  emit(/* 从网关公开订阅进入生产会话的完整事件。 */ event: GraphStreamEvent): void
}

/** 为公开传输结果设置有明确完成入口的屏障，不修改会话内部状态。 */
function editingDeferred<T>(): EditingDeferred<T> {
  // 调用者提供精确结果；屏障仅改变交付顺序，不改变后端提交事实。
  let complete: (/* 该请求的完整公开返回值。 */ value: T) => void = () => { /* 构造 Promise 时同步交接。 */ }
  let fail: (/* 该请求应观察到的原始失败。 */ reason: unknown) => void = () => { /* 构造 Promise 时同步交接。 */ }
  const promise = new Promise<T>((/* 本次结果成功交付时完成。 */ resolve, /* 本次结果运输失败时拒绝。 */ reject) => {
    // 保存边界完成入口，测试不持有生产模块私有引用。
    complete = resolve; fail = reject
  })
  return { promise,
    resolve(/* 该次请求合法且完整的返回 DTO。 */ value): void { /* 完成原公开等待。 */ complete(value) },
    reject(/* 该次请求原样保留的失败。 */ reason): void { /* 拒绝原公开等待。 */ fail(reason) },
  }
}

/** 构造可重试运输错误，避免身份退出或权限刷新掩盖配对问题。 */
function editingNetworkFailure(): ClientError {
  // 同一命令可经 session.retry 重放，是否提交由独立权威边界决定。
  return new ClientError({ status: 0, code: 'NETWORK_ERROR', retryable: true, message: EditingMessage.NETWORK_FAILED })
}

/** 从完整快照投影两个独立根的稳定内容证明，图 revision 不进入 version。 */
function editingReadBranch(
  /* 公开权威快照或已在真实传输边界冻结的快照副本。 */ snapshot: GraphSnapshot,
  /* 本次公开读取明确指定的根集合。 */ roots: readonly string[],
): GraphBranchSnapshot {
  // 本测试没有边，独立根闭包只有自身；删除根必须返回真实缺失，而非空假证明。
  const rootIds = [...roots].sort()
  const nodes = snapshot.nodes.filter((/* 该次快照中的节点。 */ node) => /* 只投影请求根。 */ rootIds.includes(node.id))
  if (nodes.length !== rootIds.length) throw new ClientError({ status: 404, code: 'NODE_NOT_FOUND', retryable: false, message: EditingMessage.ROOT_MISSING })
  return { scope: { rootIds, nodeIds: [...rootIds], edgeIds: [] }, mapRevision: snapshot.revision,
    version: nodes.map((/* 根节点及其内容版本。 */ node) => /* 不将独立分支的图 revision 混入版本。 */ `${node.id}:${node.revision}`).sort().join('|'),
    rootRevisions: Object.fromEntries(nodes.map((/* 该次证明覆盖的根节点。 */ node) => /* 完整记录对应根版本。 */ [node.id, node.revision])) }
}

/** 建立最小合法图契约，所有状态变化仍由公开查询、命令或订阅进入真实会话。 */
function editingCreateGateway(
  /* 默认 none 隔离正文时序；required 只用于 claim 的新内容证明与占用版本反例。 */ leases: 'none' | 'required' = 'none',
) {
  // 租约完整确认代次仍由 S1 suite 负责，此处只保留合法编辑证明及两个独立根占有。
  let authority: GraphSnapshot = { mapId: MAP_ID, workspaceId: WORKSPACE_ID, revision: 1, name: 'S2 正文证明配对',
    nodes: [NODE_A, NODE_B].map((/* 两个没有共享后继的独立根身份。 */ id) => /* 采用同一精确类型，初始内容版本为零。 */ ({
      id, revision: 0, typeId: 's2.fact', typeVersion: 1, payload: { content: `原文 ${id}` }, createdAt: TIME, updatedAt: TIME,
    })), edges: [], runs: [], ownershipRevision: 0, ownerships: [], runControls: [], updatedAt: TIME }
  const bootstrap: AppBootstrap = { identity: { userId: '64000000-0000-4000-8000-000000000001', displayName: 'S2 用户', hostAdmin: false },
    settings: { revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 1 } },
    metadata: { clientLeases: leases, variables: {} } }
  const workspace: WorkspaceView = { id: WORKSPACE_ID, name: 'S2 工作区', description: '', revision: 0, role: 'editor', mapCount: 1,
    updatedAt: TIME, agents: [], members: [], preferences: { workspaceId: WORKSPACE_ID, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} } }
  const reads: Array<keyof QueryInputMap> = [], applied: Array<CommandInputMap['graph.apply']> = []
  const dispatches: Array<{ requestId: string; method: keyof CommandInputMap }> = []
  const replayedIds = new Set<string>(), streams: EditingStream[] = []
  const grantsByLease = new Map<string, GraphBranchGrant>()
  let configured = false, leaseSerial = 0

  function readOwnership(/* 已由公开 claim 确认且仍在有效期的授权记录。 */ grant: GraphBranchGrant): GraphBranchOwnership {
    // 快照只包含公开占有字段，不把私有 grant 的 branch 与确认 O 混入。
    return { kind: 'editor', leaseId: grant.leaseId, rootIds: [...grant.rootIds], ownerUserId: grant.ownerUserId,
      holderId: grant.holderId, fence: grant.fence, expiresAt: grant.expiresAt, leaseMs: grant.leaseMs, scope: structuredClone(grant.scope) }
  }

  function readLease(/* 写入或释放携带的精确公开租约证明。 */ proof: CommandInputMap['graph.apply']['lease']): GraphBranchGrant {
    // required 场景不允许省略或冒用其他 holder/fence 的授权，运输顺序不代替服务端校验。
    const grant = proof ? grantsByLease.get(proof.leaseId) : undefined
    if (!proof || !grant || grant.holderId !== proof.holderId || grant.fence !== proof.fence || Date.parse(grant.expiresAt) <= Date.now()) {
      throw new ClientError({ status: 409, code: 'BRANCH_LEASE_CONFLICT', retryable: false, message: EditingMessage.LEASE_MISSING })
    }
    return grant
  }

  function commitWrite(/* 当前合法公共命令的正文差量与原始分支证明。 */ params: CommandInputMap['graph.apply']): GraphWriteResult {
    // 版本裁决在权威边界执行；旧草稿不能因 session 当前证明前进而自动获得新 expectedVersion。
    applied.push(structuredClone(params))
    const before = editingReadBranch(authority, params.branch.rootIds)
    if (leases === 'required') {
      const lease = readLease(params.lease)
      if (!before.scope.nodeIds.every((/* 本次写入的实际闭包节点。 */ id) => /* 已确认授权必须覆盖整个所写分支。 */ lease.scope.nodeIds.includes(id))) {
        throw new ClientError({ status: 409, code: 'BRANCH_LEASE_CONFLICT', retryable: false, message: EditingMessage.LEASE_MISSING })
      }
    }
    if (before.version !== params.branch.expectedVersion) throw new ClientError({ status: 409, code: 'BRANCH_VERSION_CONFLICT',
      retryable: false, message: EditingMessage.BRANCH_CONFLICT })
    if (params.changes.edges || params.changes.nodes?.put?.some((/* 此次正文写入的实例。 */ node) => /* 本测试不悄悄实现创建或其他类型行为。 */
      !before.scope.nodeIds.includes(node.id) || !authority.nodes.some((/* 当前权威节点。 */ current) => /* 只改已存在的根。 */ current.id === node.id))) {
      throw new Error(EditingMessage.CHANGE_UNSUPPORTED)
    }
    authority = { ...authority, revision: authority.revision + 1,
      nodes: authority.nodes.filter((/* 当前完整节点。 */ node) => /* 删除只作用于明确列出的实例。 */ !params.changes.nodes?.remove?.includes(node.id))
        .map((/* 本次提交保留的既有节点。 */ node) => {
          // 对命令列出的正文更新精确增加一次节点版本，其他独立根保持原内容。
          const put = params.changes.nodes?.put?.find((/* 要写入的精确实例。 */ candidate) => /* 按身份匹配，不能串到另一根。 */ candidate.id === node.id)
          return put ? { ...node, revision: node.revision + 1, payload: structuredClone(put.payload), updatedAt: TIME } : node
        }) }
    const snapshot = structuredClone(authority)
    const branch = params.branch.rootIds.every((/* 写入所依据的分支根。 */ root) => /* 根被删除后合法响应没有可用证明。 */ snapshot.nodes.some((/* 新快照中的实际实例。 */ node) => /* 核对根仍存在。 */ node.id === root))
      ? editingReadBranch(snapshot, params.branch.rootIds) : undefined
    return { snapshot, createdNodeIds: [], createdEdgeIds: [], ...(branch ? { branch } : {}) }
  }

  const readHandlers: EditingQueryHandlers = {
    'app.bootstrap': async () => { /* 返回明确的本机租约策略，隔离授权实现。 */ return structuredClone(bootstrap) },
    'workspace.list': async () => { /* 当前账号仅可见本测试工作区。 */ return { items: [structuredClone(workspace)], nextCursor: null } },
    'workspace.get': async () => { /* 不用 map 内容变化伪造工作区 revision。 */ return structuredClone(workspace) },
    'definition.get': async () => { /* 提供当前实例采用的不可变精确类型。 */ return { workspaceId: WORKSPACE_ID,
      catalog: { revision: 0, packages: [], index: [], transitions: [], dataTypes: [{ id: 's2.fact', version: 1, title: '事实',
        schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
        successorTypes: [], references: [], agentProjection: { include: ['/content'], mapEntryFilters: [] } }] } } },
    'map.list': async () => { /* 图目录始终指向同一权威图版本。 */ return [{ id: MAP_ID, workspaceId: WORKSPACE_ID, revision: authority.revision,
      name: authority.name, nodeCount: authority.nodes.length, typeCounts: { 's2.fact@1': authority.nodes.length }, updatedAt: TIME }] },
    'map.get': async () => { /* 每次读取产生独立副本，迟到消息不能倒改权威状态。 */ return structuredClone(authority) },
    'branch.get': async (/* 公开请求指定的独立根。 */ params) => { /* 返回与本次完整快照配对的内容证明。 */ return editingReadBranch(authority, params.rootIds) },
  }
  const commandHandlers: EditingCommandHandlers = {
    'graph.apply': async (/* 当前 UI 草稿提交的真实版本及正文参数。 */ params) => { /* 在同次提交中返回 snapshot 和 branch。 */ return commitWrite(params) },
    'branch.claim': async (/* 当前独立根和实际 editor holder 的公共领取请求。 */ params) => {
      // 同 holder 同根可复用；其他活跃闭包重叠返回 busy，不能覆盖已有租约。
      const branch = editingReadBranch(authority, params.rootIds)
      for (const [leaseId, grant] of grantsByLease) if (Date.parse(grant.expiresAt) <= Date.now()) grantsByLease.delete(leaseId)
      const existing = [...grantsByLease.values()].find((/* 当前尚有效的编辑授权。 */ grant) => /* 与真实契约一致地匹配 holder 和根集合。 */
        grant.holderId === params.holderId && [...grant.rootIds].sort().join('|') === branch.scope.rootIds.join('|'))
      const conflict = [...grantsByLease.values()].find((/* 其他尚有效的独立根授权。 */ grant) => /* 只有实际闭包重叠才阻止领取。 */
        grant.leaseId !== existing?.leaseId && grant.scope.nodeIds.some((/* 其他授权覆盖的节点。 */ id) => /* 只拒绝请求范围的交集。 */ branch.scope.nodeIds.includes(id)))
      if (conflict) return { status: 'busy', ownership: readOwnership(conflict) }
      authority.ownershipRevision++
      const grant: GraphBranchGrant = { kind: 'editor', leaseId: existing?.leaseId ?? `65000000-0000-4000-8000-${String(++leaseSerial).padStart(12, '0')}`,
        holderId: params.holderId, ownerUserId: bootstrap.identity.userId, fence: existing?.fence ?? authority.ownershipRevision,
        rootIds: [...branch.scope.rootIds], scope: structuredClone(branch.scope), expiresAt: new Date(Date.now() + 30_000).toISOString(), leaseMs: 30_000,
        branch, ownershipRevision: authority.ownershipRevision }
      grantsByLease.set(grant.leaseId, grant)
      authority.ownerships = [...grantsByLease.values()].map((/* 当前所有有效的独立编辑占有。 */ item) => /* 不让 B 的领取删掉 A。 */ readOwnership(item))
      return { status: 'claimed', grant: structuredClone(grant) }
    },
    'branch.release': async (/* 仅能解除匹配 lease/holder/fence 的公开证明。 */ params) => {
      // 真实释放只删除精确占有，保留同图其他独立根。
      const grant = readLease(params.lease)
      grantsByLease.delete(grant.leaseId)
      authority.ownershipRevision++
      authority.ownerships = [...grantsByLease.values()].map((/* 未被该证明释放的授权。 */ item) => /* 继续公开其他根的占有。 */ readOwnership(item))
      return { released: true, ownershipRevision: authority.ownershipRevision }
    },
    'preferences.set': async (/* 会话正常防抖保存的偏好请求。 */ params) => {
      // 偏好与图内容证明无关，不能因虚拟计时产生无关失败。
      workspace.preferences = { workspaceId: WORKSPACE_ID, revision: params.expectedRevision + 1,
        openMapIds: [...params.openMapIds], currentMapId: params.currentMapId, nodeSelection: { ...params.nodeSelection } }
      return structuredClone(workspace.preferences)
    },
  }
  const gateway: ClientGateway = {
    async connect(/* 用户公开连接输入，测试不靠写入会话 ref 建立身份。 */ _input) { /* 正常建立本次身份。 */ configured = true; return structuredClone(bootstrap) },
    async disconnect() { /* 退出本次网关身份。 */ configured = false },
    async getConnection() { /* 连接摘要不包含令牌。 */ return { baseUrl: 'http://s2.fixture', configured, remembered: false, canRemember: false } },
    async read<K extends keyof QueryInputMap>(
      /* 绑定返回形状的公开查询方法。 */ method: K,
      /* 与该方法对应的唯一参数 DTO。 */ params: QueryInputMap[K],
    ): Promise<QueryOutputMap[K]> {
      // 读取预算只防止错误实现无限重读挂住 runner，不把达到预算当作通过。
      reads.push(method)
      if (reads.length > 128) throw new Error(EditingMessage.READ_BUDGET)
      const handler = readHandlers[method]
      if (!handler) throw new Error(EditingMessage.QUERY_UNEXPECTED)
      return handler(params)
    },
    async dispatch<K extends keyof CommandInputMap>(
      /* 本次公开提交固定的幂等请求身份。 */ requestId: string,
      /* 绑定输入输出 DTO 的公开命令名。 */ method: K,
      /* 当前方法的精确命令参数。 */ params: CommandInputMap[K],
    ): Promise<GraphSuccess<CommandOutputMap[K]>> {
      // 合法重放仍保留原 requestId；测试只显式标记已经真实提交过的请求。
      dispatches.push({ requestId, method })
      const handler = commandHandlers[method]
      if (!handler) throw new Error(EditingMessage.COMMAND_UNEXPECTED)
      return { ok: true, requestId, replayed: replayedIds.has(requestId), data: await handler(params) }
    },
    watch(
      /* 本次打开的真实图身份，不在私有状态里更换目标。 */ _mapId,
      /* 生产会话提供的公开事件回调。 */ onEvent,
      /* 原视图的取消信号，结束时终止旧订阅。 */ signal,
    ): Promise<void> {
      // 持续订阅由生产会话结束，测试只能交付公共协议事件。
      return new Promise<void>((/* 当前视图正常退出时完成。 */ resolve, /* 事件接纳抛错时保留失败。 */ reject) => {
        // 回调对外不暴露生产 refs，只暴露类型化事件交付入口。
        streams.push({ signal, emit(/* 经过公开契约的完整图事件。 */ event): void {
          // 不吞掉实际状态机失败。
          try { onEvent(structuredClone(event)) } catch (cause) { reject(cause) }
        } })
        signal?.addEventListener('abort', () => { /* 旧视图退出后完成公开 watch。 */ resolve() }, { once: true })
      })
    },
    async upload() { /* 本测试不借文件接口制造图状态。 */ throw new Error(EditingMessage.FILE_UNEXPECTED) },
    async download() { /* 本测试没有资产读取步骤。 */ throw new Error(EditingMessage.FILE_UNEXPECTED) },
  }
  return { gateway, readHandlers, commandHandlers, reads, applied, dispatches, commitWrite,
    snapshot(): GraphSnapshot { /* 独立读取权威图副本，供测试核对提交结果。 */ return structuredClone(authority) },
    branch(/* 当前独立权威读取要覆盖的根，默认 A。 */ rootId = NODE_A): GraphBranchSnapshot { /* 不借页面缓存生成预期证明。 */ return editingReadBranch(authority, [rootId]) },
    markReplayed(/* 已经提交过而准备沿原 requestId 重放的命令。 */ requestId: string): void { /* 仅影响真实成功信封中的重放标记。 */ replayedIds.add(requestId) },
    emit(/* 后端真实提交后已经产生的完整快照。 */ snapshot: GraphSnapshot): void {
      // 只改变消息交付，不修改权威数据或会话内部状态。
      const stream = streams.find((/* 本次已建立的公开订阅。 */ item) => /* 排除已经被生产会话取消的旧视图。 */ !item.signal?.aborted)
      if (!stream) throw new Error(EditingMessage.STREAM_MISSING)
      stream.emit({ type: 'snapshot', snapshot })
    },
  }
}

const sessions: EditingSession[] = []

beforeEach(() => {
  // 不用实际 sleep 控制竞态，偏好计时保持虚拟且不会无故推进正文版本。
  vi.useFakeTimers(); vi.setSystemTime(new Date(TIME))
})
afterEach(async () => {
  // 由生产会话自行结束订阅和计时器，再恢复测试环境时钟。
  for (const session of sessions.splice(0)) session.dispose()
  await Promise.resolve()
  vi.useRealTimers()
})

/** 有界清空公开网关和会话之间的 Promise 链，不推进计时或用 sleep 猜结果。 */
async function editingFlush(): Promise<void> {
  // 当前路径只有有限层 await；无限重读由网关预算明确暴露为失败。
  for (let step = 0; step < 32; step++) await Promise.resolve()
}

/** 正常连接、打开图并选择 A，不注入可写 ref 或生产私有状态。 */
async function editingOpen(
  /* 默认本机对照；claim 内容配对与 O 反例显式使用 required。 */ leases: 'none' | 'required' = 'none',
) {
  // 所有测试共享同一产品入口，后续仅控制公开边界的异步交付。
  const fixture = editingCreateGateway(leases), session = sessionCreateState(fixture.gateway, 100)
  sessions.push(session)
  await session.connect({ baseUrl: 'http://s2.fixture', token: 's2-test-token', remember: false })
  await session.openMap(MAP_ID, false)
  session.selectNode(NODE_A)
  await editingFlush()
  expect(session.selectedBranch.value).toEqual(fixture.branch())
  expect(session.branchLoading.value).toBe(false)
  return { fixture, session }
}

/** 固定调用者开始编辑时捕获的证明，后续快照更新不得改写它。 */
function editingCapture(/* 真实会话当前已公开的分支证明。 */ session: EditingSession): GraphBranchSnapshot {
  // 捕获值模拟编辑器持有的基线，只读生产状态而不注入草稿。
  if (!session.selectedBranch.value) throw new Error(EditingMessage.BRANCH_MISSING)
  return structuredClone(session.selectedBranch.value)
}

/** 经公开 saveNode 提交调用者捕获的版本，绝不从后来状态自动替换 expectedVersion。 */
function editingSave(
  /* 真实生产会话，负责命令提交和状态接纳。 */ session: EditingSession,
  /* 编辑开始时捕获的完整分支证明。 */ baseline: GraphBranchSnapshot,
  /* 本次完整正文草稿。 */ content: string,
): Promise<boolean> {
  // 此 helper 不实现保存策略，只映射真实公开方法需要的输入。
  return session.saveNode({ branch: { rootIds: [...baseline.scope.rootIds], expectedVersion: baseline.version }, nodeId: baseline.scope.rootIds[0],
    typeId: 's2.fact', typeVersion: 1, payload: { content } })
}

/** 允许恢复期间只读，但禁止未标记加载的旧证明与新正文冒充已就绪。 */
function editingExpectPairedOrLoading(/* 真实会话公开的当前正文、选择和证明状态。 */ session: EditingSession): void {
  // 内部可选 null 或 loading 表达等待；只约束对外没有可用的混配证明。
  const snapshot = session.snapshot.value, branch = session.selectedBranch.value, rootId = session.selectedId.value
  if (!snapshot || !rootId || !branch || session.branchLoading.value) return
  const expected = editingReadBranch(snapshot, [rootId])
  expect(branch.scope).toEqual(expected.scope)
  expect(branch.version).toBe(expected.version)
  expect(branch.rootRevisions).toEqual(expected.rootRevisions)
  expect(branch.mapRevision).toBeLessThanOrEqual(snapshot.revision)
}

/** 验证读取已经收敛到同一正文快照和证明，而非只比较单一根 revision。 */
function editingExpectReady(
  /* 真实生产会话当前公开状态。 */ session: EditingSession,
  /* 独立权威边界返回的完整目标快照。 */ snapshot: GraphSnapshot,
  /* 当前确实选中的独立根，默认 A。 */ rootId = NODE_A,
): void {
  // 无关提交可保留较早真实 mapRevision，但 version、闭包与全部根版本仍须对应当前内容。
  expect(session.snapshot.value).toEqual(snapshot)
  expect(session.selectedId.value).toBe(rootId)
  const branch = session.selectedBranch.value, expected = editingReadBranch(snapshot, [rootId])
  expect(branch).not.toBeNull()
  expect(branch?.scope).toEqual(expected.scope)
  expect(branch?.version).toBe(expected.version)
  expect(branch?.rootRevisions).toEqual(expected.rootRevisions)
  expect(branch?.mapRevision ?? Infinity).toBeLessThanOrEqual(snapshot.revision)
  expect(session.branchLoading.value).toBe(false)
}

describe('S2 paired edit snapshots and branch proofs', () => {
  // 仅覆盖状态层可观察的 CS05/06，草稿 DOM 与界面冲突提示由产品用例另验。
  for (const oldOutcome of ['success', 'failure'] as const) {
    it(`CS05 same-write snapshot and branch are ready before a held refresh, ignoring old read ${oldOutcome}`, async () => {
      // 旧读取先发出；写响应携带完整配对，不允许再等 branch.get 才能开始下一稿。
      const { fixture, session } = await editingOpen()
      const baseline = editingCapture(session), oldRead = editingDeferred<GraphBranchSnapshot>(), nextRead = editingDeferred<GraphBranchSnapshot>()
      let reads = 0
      fixture.readHandlers['branch.get'] = async () => { /* 区分写入前旧请求和写入后冗余刷新，均只扣住运输。 */ return ++reads === 1 ? oldRead.promise : nextRead.promise }
      await session.refresh()
      expect(session.branchLoading.value).toBe(true)
      expect(await editingSave(session, baseline, '第一次由 UI 提交的正文')).toBe(true)
      const committed = fixture.snapshot(), paired = fixture.branch()
      expect.soft(session.selectedBranch.value).toEqual(paired)
      expect.soft(session.branchLoading.value).toBe(false)
      if (oldOutcome === 'success') oldRead.resolve(baseline)
      else oldRead.reject(editingNetworkFailure())
      await editingFlush()
      expect.soft(session.selectedBranch.value).toEqual(paired)
      expect.soft(session.error.value).toBeNull()
      nextRead.resolve(paired)
      await editingFlush()
      editingExpectReady(session, committed)
    })
  }

  it('CS05 a committed retry with omitted branch stays unready until public refresh obtains its pair', async () => {
    // 原提交成功但丢回应；后来独立根更新使合法重放省略旧 branch，必须经公共读取恢复。
    const { fixture, session } = await editingOpen()
    const baseline = editingCapture(session), pending = editingDeferred<GraphBranchSnapshot>()
    let committed: GraphWriteResult | undefined, originalInput: CommandInputMap['graph.apply'] | undefined
    fixture.commandHandlers['graph.apply'] = async (/* 原保存或沿同 requestId 重放的固定参数。 */ params) => {
      // 首次已提交才报告运输失败，重放返回当前快照而不冒充原提交证明仍与之配对。
      if (!committed) { originalInput = structuredClone(params); committed = fixture.commitWrite(params); throw editingNetworkFailure() }
      expect(params).toEqual(originalInput)
      return { snapshot: fixture.snapshot(), createdNodeIds: [], createdEdgeIds: [] }
    }
    expect(await editingSave(session, baseline, '原请求已提交但响应丢失')).toBe(false)
    expect(session.canRetry.value).toBe(true)
    const request = fixture.dispatches.find((/* 公开发出的请求身份记录。 */ item) => /* 找到已经真实提交的写请求。 */ item.method === 'graph.apply')
    if (!request || !committed) throw new Error(EditingMessage.RESULT_MISSING)
    fixture.commitWrite({ mapId: MAP_ID, branch: { rootIds: [NODE_B], expectedVersion: fixture.branch(NODE_B).version },
      changes: { nodes: { put: [{ id: NODE_B, typeId: 's2.fact', typeVersion: 1, payload: { content: '重放前独立分支的新正文' } }] } } })
    fixture.markReplayed(request.requestId)
    fixture.readHandlers['branch.get'] = async () => { /* 当前配对查询保持真实在途，不提前交付旧证明。 */ return pending.promise }
    expect(await session.retry()).toBe(true)
    expect(session.snapshot.value).toEqual(fixture.snapshot())
    editingExpectPairedOrLoading(session)
    const latest = fixture.branch()
    pending.resolve(latest)
    await editingFlush()
    editingExpectReady(session, fixture.snapshot())
    expect(fixture.dispatches.filter((/* 经过公开网关的命令记录。 */ item) => /* 原请求和重放保持同一幂等身份。 */ item.method === 'graph.apply').map((/* 同一逻辑保存的两次运输。 */ item) => /* 只核对安全测试身份，不读凭据。 */ item.requestId)).toEqual([request.requestId, request.requestId])
  })

  for (const changedRoot of [NODE_A, NODE_B]) {
    it(`CS05 late write response preserves an already newer snapshot after ${changedRoot === NODE_A ? 'selected' : 'independent'} branch changes`, async () => {
      // 保存先提交但 ack 延迟；较新真实快照先接纳，旧 ack 仍是成功但不能倒退或混配。
      const { fixture, session } = await editingOpen()
      const baseline = editingCapture(session), response = editingDeferred<GraphWriteResult>(), freshRead = editingDeferred<GraphBranchSnapshot>()
      let committed: GraphWriteResult | undefined
      fixture.commandHandlers['graph.apply'] = async (/* 已提交而暂不交付回应的原保存请求。 */ params) => {
        // 保存结果冻结在 R2，后来的公开提交不会倒改这个副本。
        committed = fixture.commitWrite(params); return response.promise
      }
      const saving = editingSave(session, baseline, '先提交的原保存')
      await editingFlush()
      if (!committed) throw new Error(EditingMessage.RESULT_MISSING)
      fixture.commitWrite({ mapId: MAP_ID, branch: { rootIds: [changedRoot], expectedVersion: fixture.branch(changedRoot).version },
        changes: { nodes: { put: [{ id: changedRoot, typeId: 's2.fact', typeVersion: 1, payload: { content: '晚于保存的真实新提交' } }] } } })
      const newer = fixture.snapshot(), newerBranch = fixture.branch()
      fixture.readHandlers['branch.get'] = async () => { /* 较新快照的证明读取保持在途，旧写响应不能替它拼接。 */ return freshRead.promise }
      fixture.emit(newer)
      response.resolve(committed)
      expect(await saving).toBe(true)
      expect(session.snapshot.value).toEqual(newer)
      editingExpectPairedOrLoading(session)
      freshRead.resolve(newerBranch)
      await editingFlush()
      editingExpectReady(session, newer)
    })
  }

  it('CS05 selection changes during a write cannot install the old roots paired response over the new selection', async () => {
    // A 保存 ack 在途时选择 B，响应中的 A 证明虽合法，也不属于当前选择意图。
    const { fixture, session } = await editingOpen()
    const response = editingDeferred<GraphWriteResult>(), baseline = editingCapture(session)
    let committed: GraphWriteResult | undefined
    fixture.commandHandlers['graph.apply'] = async (/* 原 A 的精确保存请求。 */ params) => { /* 先真实提交，仅保留回应。 */ committed = fixture.commitWrite(params); return response.promise }
    const saving = editingSave(session, baseline, 'A 已保存，当前去看 B')
    await editingFlush()
    session.selectNode(NODE_B)
    await editingFlush()
    editingExpectReady(session, fixture.snapshot(), NODE_B)
    if (!committed) throw new Error(EditingMessage.RESULT_MISSING)
    response.resolve(committed)
    expect(await saving).toBe(true)
    await editingFlush()
    editingExpectReady(session, fixture.snapshot(), NODE_B)
    const settledReads = fixture.reads.length
    await editingFlush()
    expect(fixture.reads.length).toBe(settledReads)
  })

  it('CS05 a deleted root clears selection and ends reads even when its successful old write arrives later', async () => {
    // 写入本身成功，随后另一次合法提交删除根；旧成功不能复活选择或无限追读已删除分支。
    const { fixture, session } = await editingOpen()
    const response = editingDeferred<GraphWriteResult>(), baseline = editingCapture(session)
    let committed: GraphWriteResult | undefined
    fixture.commandHandlers['graph.apply'] = async (/* 删除之前已经真实提交的正文请求。 */ params) => { /* 冻结该次成功，等待后续选择事实。 */ committed = fixture.commitWrite(params); return response.promise }
    const saving = editingSave(session, baseline, '删除前已经提交的正文')
    await editingFlush()
    fixture.commitWrite({ mapId: MAP_ID, branch: { rootIds: [NODE_A], expectedVersion: fixture.branch().version }, changes: { nodes: { remove: [NODE_A] } } })
    const deleted = fixture.snapshot()
    fixture.emit(deleted)
    if (!committed) throw new Error(EditingMessage.RESULT_MISSING)
    response.resolve(committed)
    expect(await saving).toBe(true)
    await editingFlush()
    expect(session.snapshot.value).toEqual(deleted)
    expect(session.selectedId.value).toBeNull()
    expect(session.selectedBranch.value).toBeNull()
    expect(session.branchLoading.value).toBe(false)
    const settledReads = fixture.reads.length
    await editingFlush()
    expect(fixture.reads.length).toBe(settledReads)
  })

  it('CS06 unrelated branch revisions preserve the selected stable proof and allow its captured baseline to save', async () => {
    // B 的图 revision 变化不改变 A 的分支 version，恢复配对后原 A 基线仍应合法可用。
    const { fixture, session } = await editingOpen()
    const baseline = editingCapture(session)
    fixture.commitWrite({ mapId: MAP_ID, branch: { rootIds: [NODE_B], expectedVersion: fixture.branch(NODE_B).version },
      changes: { nodes: { put: [{ id: NODE_B, typeId: 's2.fact', typeVersion: 1, payload: { content: '独立 B 的外部修改' } }] } } })
    fixture.emit(fixture.snapshot())
    await editingFlush()
    editingExpectReady(session, fixture.snapshot())
    expect(session.selectedBranch.value?.version).toBe(baseline.version)
    expect(await editingSave(session, baseline, 'A 基线没有因 B 提交而失效')).toBe(true)
    await editingFlush()
    editingExpectReady(session, fixture.snapshot())
    expect(fixture.snapshot().nodes.find((/* 独立权威图中的实例。 */ node) => /* 核对原 A 草稿确实写入。 */ node.id === NODE_A)?.payload.content).toBe('A 基线没有因 B 提交而失效')
  })

  it('CS06 a real external selected-branch edit never upgrades the callers dirty baseline before save', async () => {
    // 状态层不能替编辑器升级已经捕获的旧 expectedVersion，真实外部变化应保持版本冲突。
    const { fixture, session } = await editingOpen()
    const baseline = editingCapture(session), captured = structuredClone(baseline)
    fixture.commitWrite({ mapId: MAP_ID, branch: { rootIds: [NODE_A], expectedVersion: fixture.branch().version },
      changes: { nodes: { put: [{ id: NODE_A, typeId: 's2.fact', typeVersion: 1, payload: { content: '其他编辑者的新正文' } }] } } })
    const external = fixture.snapshot()
    fixture.emit(external)
    await editingFlush()
    editingExpectReady(session, external)
    expect(session.selectedBranch.value?.version).not.toBe(baseline.version)
    expect(baseline).toEqual(captured)
    expect(await editingSave(session, baseline, '尚未解决冲突的原草稿')).toBe(false)
    expect(fixture.applied.at(-1)?.branch.expectedVersion).toBe(captured.version)
    expect(session.error.value?.code).toBe('BRANCH_VERSION_CONFLICT')
    expect(fixture.snapshot()).toEqual(external)
  })

  it('CS06 verified A proof stays usable at its original map revision while unrelated B snapshots arrive and branch reads are held', async () => {
    // 已验证 A 的内容、闭包与邻接未变；连续 B 更新不能让它永远等待额外读取或伪造 mapRevision。
    const { fixture, session } = await editingOpen()
    const baseline = editingCapture(session), pending = editingDeferred<GraphBranchSnapshot>()
    fixture.readHandlers['branch.get'] = async () => { /* 只扣住公开刷新结果，已有证明仍是此前真实验证的值。 */ return pending.promise }
    for (const content of ['B 第一笔独立提交', 'B 第二笔独立提交']) {
      fixture.commitWrite({ mapId: MAP_ID, branch: { rootIds: [NODE_B], expectedVersion: fixture.branch(NODE_B).version },
        changes: { nodes: { put: [{ id: NODE_B, typeId: 's2.fact', typeVersion: 1, payload: { content } }] } } })
      fixture.emit(fixture.snapshot())
      await editingFlush()
      expect.soft(session.selectedBranch.value).toEqual(baseline)
      expect.soft(session.selectedBranch.value?.mapRevision).toBe(baseline.mapRevision)
      expect.soft(session.branchLoading.value).toBe(false)
    }
    expect(await editingSave(session, baseline, 'A 未受无关提交影响，继续保存')).toBe(true)
    pending.resolve(fixture.branch())
    await editingFlush()
    editingExpectReady(session, fixture.snapshot())
  })

  it('CS05 a claim with newer content proof cannot mark the older payload ready before public refresh pairs it', async () => {
    // 远端真实持权修改再释放，SSE 尚未交付；本客户端领取到 R2 证明时仍只有 R1 正文。
    const { fixture, session } = await editingOpen('required')
    const old = fixture.snapshot(), remote = await fixture.gateway.dispatch(crypto.randomUUID(), 'branch.claim', {
      mapId: MAP_ID, rootIds: [NODE_A], holderId: '66000000-0000-4000-8000-000000000001',
    })
    if (remote.data.status !== 'claimed') throw new Error(EditingMessage.LEASE_MISSING)
    const lease = { leaseId: remote.data.grant.leaseId, holderId: remote.data.grant.holderId, fence: remote.data.grant.fence }
    await fixture.gateway.dispatch(crypto.randomUUID(), 'graph.apply', { mapId: MAP_ID,
      branch: { rootIds: [NODE_A], expectedVersion: remote.data.grant.branch.version }, lease,
      changes: { nodes: { put: [{ id: NODE_A, typeId: 's2.fact', typeVersion: 1, payload: { content: '远端已提交的新正文' } }] } } })
    await fixture.gateway.dispatch(crypto.randomUUID(), 'branch.release', { mapId: MAP_ID, lease })
    const content = editingDeferred<GraphSnapshot>(), proof = editingDeferred<GraphBranchSnapshot>()
    const originalClaim = fixture.commandHandlers['branch.claim']
    let returnedProof: GraphBranchSnapshot | undefined
    fixture.commandHandlers['branch.claim'] = async (/* 当前客户端正常发出的领取根与 holder。 */ params) => {
      // 观察真实类型响应，不要求会话在正文配对之前就公布私有 grant。
      if (!originalClaim) throw new Error(EditingMessage.COMMAND_UNEXPECTED)
      const result = await originalClaim(params)
      if (result.status === 'claimed') returnedProof = result.grant.branch
      return result
    }
    fixture.readHandlers['map.get'] = async () => { /* 较新正文只经正常公开刷新交付。 */ return content.promise }
    fixture.readHandlers['branch.get'] = async () => { /* 与较新正文配对的正常证明仍保持在途。 */ return proof.promise }
    const claiming = session.claimBranch()
    await editingFlush()
    expect(returnedProof?.mapRevision).toBeGreaterThan(old.revision)
    expect(session.snapshot.value).toEqual(old)
    // 暂未取得正文时允许 null 或 loading，只禁止新 proof 配旧 payload 被宣布为已就绪。
    try { editingExpectPairedOrLoading(session) } finally {
      content.resolve(fixture.snapshot()); proof.resolve(fixture.branch())
      await claiming
      await session.refresh()
      await editingFlush()
    }
    editingExpectReady(session, fixture.snapshot())
    expect(session.selectedBranchGrant.value).not.toBeNull()
  })

  it('CS05 a same-content write branch pairs with a current higher ownership revision without lowering ownership or waiting for reads', async () => {
    // 写回应冻结在 R2/O1，先到的独立 B 领取发布 R2/O2；内容配对不应把 O 倒退。
    const { fixture, session } = await editingOpen('required')
    expect(await session.claimBranch()).toBe(true)
    fixture.emit(fixture.snapshot())
    await editingFlush()
    const baseline = editingCapture(session), response = editingDeferred<GraphWriteResult>(), pending = editingDeferred<GraphBranchSnapshot>()
    let committed: GraphWriteResult | undefined
    fixture.commandHandlers['graph.apply'] = async (/* 本客户端合法授权下提交的 A 正文。 */ params) => { /* 真提交后冻结较低 O 的同次写回应。 */ committed = fixture.commitWrite(params); return response.promise }
    const saving = editingSave(session, baseline, 'A 本次写入的新正文')
    await editingFlush()
    if (!committed) throw new Error(EditingMessage.RESULT_MISSING)
    const remote = await fixture.gateway.dispatch(crypto.randomUUID(), 'branch.claim', { mapId: MAP_ID, rootIds: [NODE_B], holderId: '66000000-0000-4000-8000-000000000002' })
    expect(remote.data.status).toBe('claimed')
    const current = fixture.snapshot()
    expect(current.revision).toBe(committed.snapshot.revision)
    expect(current.ownershipRevision).toBeGreaterThan(committed.snapshot.ownershipRevision)
    fixture.readHandlers['branch.get'] = async () => { /* 扣住额外查询，必须利用已有同次内容证明完成配对。 */ return pending.promise }
    fixture.emit(current)
    response.resolve(committed)
    expect(await saving).toBe(true)
    expect(session.snapshot.value).toEqual(current)
    expect.soft(session.selectedBranch.value).toEqual(fixture.branch())
    expect.soft(session.branchLoading.value).toBe(false)
    pending.resolve(fixture.branch())
    await editingFlush()
    editingExpectReady(session, current)
  })

  it('CS06 ownership-only B claim keeps the verified A proof ready while its public branch refresh is held', async () => {
    // 同 R 的占有变化不改变任何内容事实；扣住读取也不能把 A 的已验证基线锁成只读。
    const { fixture, session } = await editingOpen('required')
    expect(await session.claimBranch()).toBe(true)
    fixture.emit(fixture.snapshot())
    await editingFlush()
    const baseline = editingCapture(session), before = fixture.snapshot(), pending = editingDeferred<GraphBranchSnapshot>()
    editingExpectReady(session, before)
    fixture.readHandlers['branch.get'] = async () => { /* 保留当前真实查询运输，不能靠它迅速返回掩盖不必要的 loading。 */ return pending.promise }
    const remote = await fixture.gateway.dispatch(crypto.randomUUID(), 'branch.claim', {
      mapId: MAP_ID, rootIds: [NODE_B], holderId: '66000000-0000-4000-8000-000000000003',
    })
    expect(remote.data.status).toBe('claimed')
    const occupied = fixture.snapshot()
    expect(occupied.revision).toBe(before.revision)
    expect(occupied.nodes).toEqual(before.nodes)
    expect(occupied.ownershipRevision).toBeGreaterThan(before.ownershipRevision)
    fixture.emit(occupied)
    await editingFlush()
    expect.soft(session.selectedBranch.value).toEqual(baseline)
    expect.soft(session.selectedBranch.value?.mapRevision).toBe(baseline.mapRevision)
    expect.soft(session.branchLoading.value).toBe(false)
    expect(await editingSave(session, baseline, '纯占用变化后 A 继续正常保存')).toBe(true)
    // 即便实现曾误发读取，其旧成功也不能盖掉后来已保存正文的配套证明。
    pending.resolve(baseline)
    await editingFlush()
    editingExpectReady(session, fixture.snapshot())
  })
})
