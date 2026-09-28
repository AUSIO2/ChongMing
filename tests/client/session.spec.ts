// 会话状态测试：用可控事件流和虚拟时间验证视图隔离、重连与偏好保存。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientGateway } from '../../contracts/client'
import type { AppBootstrap, WorkspaceView } from '../../contracts/control'
import type { GraphStreamEvent } from '../../contracts/events'
import type { GraphSnapshot } from '../../contracts/graph'
import { sessionCreateState } from '../../apps/ui/state/client-session'
import { verificationConfiguration } from '../backend/fixtures/verification'

vi.mock('../../apps/ui/transport/client-gateway', () => /* 替换默认应用网关，避免会话单元测试依赖真实传输环境。 */ ({ api: {} }))

const time = '2026-09-11T00:00:00.000Z'
const error = (
  /* 模拟 HTTP 错误状态，0 表示网络或本地失败。 */ status: number,
  /* 模拟业务错误代码，同时用于 Error 的消息。 */ code: string,
  /* 是否可重试，默认 false，网络重连用例可显式开启。 */ retryable = false
) =>
  /* 构造带 HTTP 状态、错误代码和重试标记的测试异常。 */
  Object.assign(new Error(code), { status, code, retryable })
function deferred<T>() {
  // 创建可手动完成或拒绝的 Promise，供测试安排异步先后顺序。
  let resolve!: (/* 测试手动交付的延迟 Promise 成功值。 */ value: T) => void, reject!: (/* 测试手动注入的任意 Promise 拒绝原因。 */ reason: unknown) => void
  const promise = new Promise<T>((/* Promise 构造器提供的完成入口，保存给测试使用。 */ yes, /* Promise 构造器提供的拒绝入口，保存给测试使用。 */ no) => {
    // 保存 Promise 的完成与拒绝函数。
    resolve = yes; reject = no
  })
  return { promise, resolve, reject }
}
function success(/* 要包装为命令成功响应的测试业务结果。 */ data: unknown) {
  // 将测试业务数据包装为成功命令结果。
  return { ok: true, requestId: 'request', replayed: false, data }
}
function map(
  /* 测试图身份，同时派生图名称和事实节点身份。 */ id: string,
  /* 测试图所属工作区身份，默认 workspace-a。 */ workspaceId = 'workspace-a',
  /* 测试图版本，默认 1，用于安排新旧快照顺序。 */ revision = 1
): GraphSnapshot {
  // 创建包含一个事实节点的指定工作区图快照。
  return { mapId: id, workspaceId, revision, name: id, updatedAt: time, edges: [], run: null,
    nodes: [{ id: `${id}-claim`, revision: 0, data: { kind: 'claim', content: `${id} content`, category: null }, createdAt: time, updatedAt: time }] }
}
function processingMap(/* 测试运行是否暂停，默认 false。 */ paused = false, /* 带运行测试图的版本，默认 2。 */ revision = 2): GraphSnapshot {
  // 创建等待结果审核的运行快照，并允许指定暂停状态和图版本。
  return { ...map('map-a', 'workspace-a', revision), run: {
    id: 'run-a', scope: { nodeIds: ['map-a-claim'] }, until: 'verified', paused, regenerate: false, mode: 'human-in-loop', status: 'waiting', configuration: verificationConfiguration(),
    operations: [{ id: 'operation-a', kind: 'verify', targetId: 'map-a-claim', status: 'waiting', inputRefs: [], configurationHash: 'fixture', outputRefs: [], splitReports: [], contentDraft: null,
      route: null, reports: [], draft: null, review: { id: 'review-a', revision: 0, kind: 'result', state: 'pending', decision: null, createdAt: time, answeredAt: null }, resultNodeId: null }], createdAt: time, updatedAt: time,
  } }
}
function workspace(/* 测试工作区身份，同时用于名称和偏好所属范围。 */ id: string): WorkspaceView {
  // 创建所有者视角的工作区与空偏好。
  return { id, name: id, description: '', revision: 0, role: 'owner', mapCount: 2, updatedAt: time, agents: [], members: [],
    preferences: { workspaceId: id, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} } }
}

function fakeGateway() {
  // 构造可控制快照、工作区、命令和事件流的内存网关夹具。
  let configured = false
  const snapshots = new Map([['map-a', map('map-a')], ['map-b', map('map-b')], ['map-c', map('map-c', 'workspace-b')]])
  const workspaces = new Map([['workspace-a', workspace('workspace-a')], ['workspace-b', workspace('workspace-b')]])
  const bootstrap = { identity: { userId: 'user-a', displayName: 'A', hostAdmin: false }, settings: {
    revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 3 },
  }, metadata: { version: 'fixture', promptKinds: [], executableKinds: ['verify'], scores: [0, 0.5, 1], variables: {}, outputs: [] } } as unknown as AppBootstrap
  const read = vi.fn(async (
    /* 模拟查询的方法名，选择相应内存夹具。 */ method: string,
    /* 模拟查询参数，包含目标工作区或图身份。 */ params: any,
    /* 会话传入的可选取消信号，默认读取夹具不主动响应它。 */ _signal?: AbortSignal
  ): Promise<any> => {
    // 按公开查询方法从夹具读取启动信息、工作区或图副本。
    if (method === 'app.bootstrap') return structuredClone(bootstrap)
    if (method === 'workspace.list') return { items: [...workspaces.values()], nextCursor: null }
    if (method === 'workspace.get') return structuredClone(workspaces.get(params.workspaceId))
    if (method === 'map.list') return [...snapshots.values()].filter(/* 内存图快照，用所属工作区筛选列表。 */ snapshot =>
      /* 只列出请求工作区中的图。 */
      snapshot.workspaceId === params.workspaceId).map(/* 已筛选的图快照，转换为公开列表摘要，不修改原记录。 */ snapshot =>
      /* 把完整图快照转换为列表摘要。 */
      ({
      id: snapshot.mapId, workspaceId: snapshot.workspaceId, revision: snapshot.revision, name: snapshot.name, nodeCount: snapshot.nodes.length,
      claimCount: 1, updatedAt: snapshot.updatedAt,
    }))
    if (method === 'map.get') return structuredClone(snapshots.get(params.mapId))
    throw new Error(`Unexpected query: ${method}`)
  })
  const dispatch = vi.fn(async (
    /* 会话传入的业务请求身份，默认偏好夹具不做重放判定。 */ _id: string,
    /* 模拟命令方法名，默认只支持偏好保存。 */ method: string,
    /* 偏好提交参数，用期望版本生成新版本并回显标签页选择。 */ params: any,
    /* 会话传入的可选取消信号，默认命令夹具不主动响应。 */ _signal?: AbortSignal
  ): Promise<any> => {
    // 模拟偏好保存递增版本，其他未配置命令则使测试失败。
    if (method === 'preferences.set') return success({ workspaceId: params.workspaceId, revision: params.expectedRevision + 1,
      openMapIds: params.openMapIds, currentMapId: params.currentMapId, nodeSelection: params.nodeSelection })
    throw new Error(`Unexpected command: ${method}`)
  })
  const connect = vi.fn(async () => {
    // 模拟登录并返回独立启动信息副本。
    configured = true; return structuredClone(bootstrap)
  })
  const disconnect = vi.fn(async () => {
    // 模拟退出登录并清除连接配置状态。
    configured = false
  })
  const getConnection = vi.fn(async () => /* 返回当前模拟连接的配置状态。 */ ({ baseUrl: 'http://fixture', configured, remembered: false, canRemember: false }))
  const streams: Array<{ mapId: string; signal?: AbortSignal; emit: (
    /* 测试主动推给已登记订阅的业务事件。 */ event: GraphStreamEvent
  ) => void; resolve: () => void; reject: (
    /* 测试主动拒绝订阅时注入的任意失败原因。 */ cause: unknown
  ) => void }> = []
  const watch = vi.fn((
    /* 本次订阅的目标图身份，保存在夹具中供用例核对。 */ mapId: string,
    /* 会话提供的事件接纳回调，测试可主动推送并捕捉其同步错误。 */ onEvent: (
      /* 交给会话接纳回调的模拟图流事件。 */ event: GraphStreamEvent
    ) => void,
    /* 可选的视图取消信号，用于观察切图或退出是否关闭订阅。 */ signal?: AbortSignal
  ) =>
    /* 创建可由测试主动推送、结束或拒绝的图订阅。 */
    new Promise<void>((/* 订阅 Promise 的成功入口，保存后由测试模拟正常断流。 */ resolve, /* 订阅 Promise 的拒绝入口，保存后由测试或取消触发错误。 */ reject) => {
    // 登记订阅控制入口，并令取消信号拒绝该订阅。
    const emit = (/* 测试主动推送的流事件，原样交给会话回调。 */ event: GraphStreamEvent) => {
      // 把测试事件交给订阅者，回调抛错时结束订阅 Promise。
      try { onEvent(event) } catch (cause) { reject(cause) }
    }
    streams.push({ mapId, emit, signal, resolve, reject })
    signal?.addEventListener('abort', () => /* 取消发生时以请求取消错误拒绝订阅。 */ reject(error(0, 'REQUEST_ABORTED')), { once: true })
  }))
  const gateway = { watch, read, dispatch, connect, disconnect, getConnection } as unknown as ClientGateway
  return { gateway, watch, streams, read, dispatch, connect, disconnect, getConnection, snapshots, workspaces, bootstrap }
}

const sessions: ReturnType<typeof sessionCreateState>[] = []
beforeEach(() => {
  // 每个用例前使用虚拟时间控制防抖与重连。
  vi.useFakeTimers()
})
afterEach(() => {
  // 每个用例后释放所有会话并恢复真实计时器。
  for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers()
})

async function opened() {
  // 创建并登录测试会话，打开默认图并登记清理。
  const f = fakeGateway()
  const session = sessionCreateState(f.gateway, 100)
  sessions.push(session)
  await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
  await session.openMap('map-a', false)
  return { ...f, session }
}

describe('Client session state and subscriptions', () => {
  // 覆盖会话隔离、实时流、版本仲裁、原命令重试和视图清理。
  it('replaces unexpected client exceptions with a safe message and a diagnostic id', async () => {
    // 验证意外异常被替换为安全提示和诊断编号，不泄露原始私密信息。
    const f = await opened()
    f.read.mockRejectedValueOnce(new Error('private-token at /Users/private/file'))
    await f.session.refresh()
    expect(f.session.error.value).toMatchObject({ code: 'CLIENT_ERROR', message: '操作失败，请根据错误编号查看诊断。', errorId: expect.any(String) })
    expect(JSON.stringify(f.session.error.value)).not.toMatch(/private-token|\/Users\/private/)
  })
  it('keeps activity separate from snapshot revision and clears it on pause, disconnect and map switch', async () => {
    // 验证活动摘要不修改快照版本，暂停、断流和切图会清空失效活动。
    const f = await opened()
    const next = processingMap()
    next.run!.status = 'running'
    next.run!.operations[0].status = 'running'
    const activity = { mapId: next.mapId, runId: next.run!.id, operationId: 'operation-a', nodeId: 'map-a-claim', workId: 'work',
      actor: { role: 'router' as const }, agentName: 'Router', status: 'model' as const, fence: 1, sequence: 1, updatedAt: time }
    f.streams[0].emit({ type: 'snapshot', snapshot: next })
    f.streams[0].emit({ type: 'activity', items: [activity] })
    expect(f.session.activities.value).toEqual([activity])
    expect(f.session.snapshot.value?.revision).toBe(next.revision)
    f.streams[0].emit({ type: 'snapshot', snapshot: { ...next, revision: 3, run: { ...next.run!, paused: true } } })
    f.streams[0].emit({ type: 'activity', items: [activity] })
    expect(f.session.activities.value).toEqual([])
    f.streams[0].emit({ type: 'snapshot', snapshot: { ...next, revision: 4 } })
    f.streams[0].emit({ type: 'activity', items: [activity] })
    f.streams[0].reject(error(0, 'NETWORK_ERROR', true))
    await vi.advanceTimersByTimeAsync(1)
    expect(f.session.activities.value).toEqual([])
    await f.session.openMap('map-b', false)
    f.streams[0].emit({ type: 'activity', items: [activity] })
    expect(f.session.activities.value).toEqual([])
  })

  it('keeps paused execution locked and preserves its snapshot against a late running read', async () => {
    // 验证暂停运行仍锁定图编辑，迟到运行中快照不会覆盖暂停与审核结果。
    const f = await opened()
    f.snapshots.set('map-a', processingMap())
    await f.session.refresh()
    const late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => /* 延迟旧图读取，供暂停命令先返回较新快照。 */ late.promise)
    const poll = f.session.refresh()
    const paused = processingMap(true, 3)
    f.snapshots.set('map-a', paused)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.pauseRun({ mapId: 'map-a', expectedRevision: 2, runId: 'run-a' })
    late.resolve(processingMap(false, 2))
    await poll
    expect(f.session.snapshot.value?.run?.paused).toBe(true)
    expect(f.session.active.value).toBe(true)
    expect(await f.session.createSource('https://example.com', 'Blocked edit')).toBe(false)
    await f.session.startRun({ scope: { nodeIds: ['map-a-claim'] }, until: 'verified', mode: 'auto' })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    const approved = processingMap(true, 4)
    approved.run!.operations[0].review!.state = 'answered'
    f.dispatch.mockResolvedValueOnce(success({ snapshot: approved, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.answerReview({ mapId: 'map-a', expectedRevision: 3, runId: 'run-a', operationId: 'operation-a', reviewId: 'review-a', expectedReviewRevision: 0, decision: 'approve' })
    expect(f.session.snapshot.value?.run?.paused).toBe(true)
    expect(f.dispatch.mock.calls[1][2]).toMatchObject({ operationId: 'operation-a' })
    const reads = f.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)
    expect(f.read.mock.calls).toHaveLength(reads)
    f.streams[0].emit({ type: 'snapshot', snapshot: approved })
    expect(f.session.snapshot.value?.run?.paused).toBe(true)
    await f.session.closeMap('map-a')
    expect(f.dispatch.mock.calls.some(/* Vitest 记录的命令参数元组，检查是否误发取消或恢复命令。 */ call =>
      /* 检测关闭标签时是否错误发出了取消或恢复运行命令。 */
      call[1] === 'run.cancel' || call[1] === 'run.resume')).toBe(false)
  })

  it('submits explicit node scope and resumes the same Run with its accepted state', async () => {
    // 验证新运行提交显式节点范围，恢复保留同一 Run 与审核状态，权限刷新后阻止写操作。
    const f = await opened()
    const paused = processingMap(true)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.startRun({ scope: { nodeIds: ['map-a-claim'] }, until: 'verified', mode: 'human-in-loop', regenerate: true })
    expect(f.dispatch.mock.calls[0][2]).toMatchObject({ scope: { nodeIds: ['map-a-claim'] }, until: 'verified', regenerate: true })
    expect(f.dispatch.mock.calls[0][2]).not.toHaveProperty('targetId')
    const resumed = processingMap(false, 3)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: resumed, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.resumeRun({ mapId: 'map-a', expectedRevision: 2, runId: 'run-a' })
    expect(f.session.snapshot.value?.run).toMatchObject({ id: 'run-a', paused: false, operations: [{ id: 'operation-a', review: { id: 'review-a', state: 'pending' } }] })
    f.workspaces.get('workspace-a')!.role = 'viewer'
    await f.session.refreshWorkspace()
    await f.session.pauseRun({ mapId: 'map-a', expectedRevision: 3, runId: 'run-a' })
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })

  it('ignores late Map replies after a different Map is opened and aborts the old view', async () => {
    // 验证切图会取消旧视图并忽略迟到的旧图响应。
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.read.getMockImplementation()!
    let oldSignal: AbortSignal | undefined
    f.read.mockImplementation(async (
      /* 查询方法名，仅 map.get 的旧图读取会被延迟。 */ method,
      /* 查询参数，使用 mapId 选择旧图拦截目标。 */ params,
      /* 会话给旧视图的取消信号，保存供切图后断言。 */ signal
    ) => {
      // 拦截旧图读取并记录取消信号，其他查询保持正常。
      if (method === 'map.get' && params.mapId === 'map-a') { oldSignal = signal; return late.promise }
      return normalRead(method, params, signal)
    })
    const opening = f.session.openMap('map-a', false)
    await f.session.openMap('map-b', false)
    expect(oldSignal?.aborted).toBe(true)
    late.resolve(map('map-a', 'workspace-a', 99))
    await opening
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.session.loading.value).toBe(false)
  })

  it('keeps a newer command snapshot when an earlier read arrives afterward', async () => {
    // 验证较早 HTTP 读取晚到时不会覆盖命令返回的新快照。
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.read.getMockImplementation()!
    f.read.mockImplementation((
      /* 查询方法名，图读取延迟以安排命令响应先到。 */ method,
      /* 未被拦截查询的原始参数，转交默认模拟读取。 */ params,
      /* 未被拦截查询的取消信号，转交默认模拟读取。 */ signal
    ) =>
      /* 延迟图快照读取，其他查询继续走正常夹具。 */
      method === 'map.get' ? late.promise : normalRead(method, params, signal))
    const polling = f.session.refresh()
    const newest = map('map-a', 'workspace-a', 3)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: newest, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data: { kind: 'claim', content: 'Mine', category: null } })
    late.resolve(map('map-a', 'workspace-a', 2))
    await polling
    expect(f.session.snapshot.value?.revision).toBe(3)
  })

  it('does not restore private state from pending requests after disconnect', async () => {
    // 验证退出后未完成请求不能恢复私有状态，也不会取消远端运行。
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => /* 保持图读取未完成，等待退出之后再返回。 */ late.promise)
    const polling = f.session.refresh()
    await f.session.disconnect()
    late.resolve(map('map-a', 'workspace-a', 8))
    await polling
    const reads = f.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.read.mock.calls).toHaveLength(reads)
    expect(f.session.bootstrap.value).toBeNull()
    expect(f.session.workspace.value).toBeNull()
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.online.value).toBe(false)
    expect(f.dispatch.mock.calls.some(/* 命令调用参数元组，检查退出是否误发 run.cancel。 */ call => /* 检查退出登录是否错误提交取消运行命令。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('ignores initialization connection metadata that arrives after a new login', async () => {
    // 验证新登录完成后忽略旧初始化返回的连接信息。
    const f = fakeGateway()
    const session = sessionCreateState(f.gateway, 100)
    sessions.push(session)
    const stale = deferred<Awaited<ReturnType<ClientGateway['getConnection']>>>()
    f.getConnection.mockImplementationOnce(() => /* 延迟初始化读取的旧连接配置。 */ stale.promise)
    const initializing = session.initialize()
    await session.connect({ baseUrl: 'http://fixture', token: 'new-token', remember: false })
    expect(session.connection.value?.configured).toBe(true)
    stale.resolve({ baseUrl: 'http://previous-host', configured: false, remembered: false, canRemember: false })
    await initializing
    expect(session.connection.value).toMatchObject({ baseUrl: 'http://fixture', configured: true })
    expect(session.bootstrap.value?.identity.userId).toBe('user-a')
  })

  it('reconnects ended streams with capped backoff without polling snapshots', async () => {
    // 验证断流按退避时间重连、不轮询快照，关闭标签后停止重连。
    const f = await opened()
    const reads = f.read.mock.calls.length
    expect(f.watch).toHaveBeenCalledTimes(1)
    f.streams[0].resolve()
    await vi.advanceTimersByTimeAsync(99)
    expect(f.watch).toHaveBeenCalledTimes(1)
    expect(f.session.streamState.value).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.watch).toHaveBeenCalledTimes(2)
    f.streams[1].reject(error(0, 'NETWORK_ERROR', true))
    await vi.advanceTimersByTimeAsync(199)
    expect(f.watch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.watch).toHaveBeenCalledTimes(3)
    f.streams[2].emit({ type: 'snapshot', snapshot: map('map-a', 'workspace-a', 8) })
    expect(f.session.streamState.value).toBe('live')
    expect(f.session.snapshot.value?.revision).toBe(8)
    expect(f.read.mock.calls).toHaveLength(reads)
    await f.session.closeMap('map-a')
    expect(f.streams[2].signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.watch).toHaveBeenCalledTimes(3)
    expect(f.dispatch.mock.calls.some(/* 命令调用参数元组，检查关闭订阅是否误取消运行。 */ call => /* 检查关闭订阅时是否错误取消远端运行。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('adopts stream snapshots and summaries while ignoring old HTTP failures and old view callbacks', async () => {
    // 验证实时快照更新摘要并使旧 HTTP 错误失效，旧视图事件也不能覆盖新图。
    const f = await opened(), late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => /* 延迟 HTTP 读取，让实时流先提供较新快照。 */ late.promise)
    const reading = f.session.refresh()
    const next = map('map-a', 'workspace-a', 5)
    next.name = 'Live graph'
    f.streams[0].emit({ type: 'snapshot', snapshot: next })
    late.reject(error(404, 'MAP_NOT_FOUND'))
    await reading
    expect(f.session.snapshot.value?.revision).toBe(5)
    expect(f.session.mapList.value.find(/* 会话缓存的图摘要，用测试图身份定位实时更新结果。 */ map =>
      /* 查找已被实时快照更新的图摘要。 */
      map.id === 'map-a')).toMatchObject({ name: 'Live graph', revision: 5, nodeCount: 1 })
    expect(f.session.online.value).toBe(true)
    expect(f.session.error.value).toBeNull()
    await f.session.openMap('map-b', false)
    f.streams[0].emit({ type: 'snapshot', snapshot: map('map-a', 'workspace-a', 99) })
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.streams[0].signal?.aborted).toBe(true)
  })

  it('refreshes invalidated workspace and settings without another Map read', async () => {
    // 验证工作区和设置失效通知只刷新相应数据，不额外读取图。
    const f = await opened()
    const count = f.read.mock.calls.filter(/* 查询调用参数元组，以方法名统计初始图读取次数。 */ call => /* 统计刷新前已经发生的图读取。 */ call[0] === 'map.get').length
    f.workspaces.get('workspace-a')!.revision = 2
    f.workspaces.get('workspace-a')!.name = 'Shared metadata'
    f.bootstrap.settings.revision = 2
    f.bootstrap.settings.llm.model = 'new model'
    f.streams[0].emit({ type: 'refresh', scope: 'workspace' })
    f.streams[0].emit({ type: 'refresh', scope: 'settings' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.workspace.value?.name).toBe('Shared metadata')
    expect(f.session.bootstrap.value?.settings.llm.model).toBe('new model')
    expect(f.read.mock.calls.filter(/* 查询调用参数元组，以方法名统计刷新后的图读取次数。 */ call => /* 统计刷新后图读取次数，检查没有多余请求。 */ call[0] === 'map.get')).toHaveLength(count)
  })

  it.each([401, 403, 404])('stops inaccessible subscriptions after %s without cancelling the Run', async /* 参数化用例中的状态码，分别覆盖认证失效、权限不足和资源缺失。 */ status => {
    // 验证 401、403、404 会停止不可访问订阅，只有 401 退出登录，且不取消运行。
    const f = await opened()
    f.streams[0].emit({ type: 'error', error: { status, code: status === 401 ? 'UNAUTHORIZED' : 'MAP_NOT_FOUND', message: 'Access ended', retryable: false, errorId: crypto.randomUUID() } })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.activeMapId.value).toBeNull()
    expect(f.streams[0].signal?.aborted).toBe(true)
    expect(f.session.bootstrap.value === null).toBe(status === 401)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.watch).toHaveBeenCalledTimes(1)
    expect(f.dispatch.mock.calls.some(/* 命令调用参数元组，检查访问失效是否误取消运行。 */ call => /* 检查访问失效处理是否错误发出运行取消命令。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('disconnects on 401, clears private data, and does not cancel remote execution', async () => {
    // 验证 401 清除私有会话数据并退出连接，同时保留远端执行。
    const f = await opened()
    f.read.mockRejectedValueOnce(error(401, 'UNAUTHORIZED'))
    await f.session.refresh()
    expect(f.disconnect).toHaveBeenCalledOnce()
    expect(f.session.bootstrap.value).toBeNull()
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.error.value?.status).toBe(401)
    expect(f.dispatch.mock.calls.some(/* 命令调用参数元组，检查 401 退出是否误取消运行。 */ call => /* 检查认证失效时是否错误取消远端运行。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('clears an inaccessible Workspace without signing the user out', async () => {
    // 验证工作区不可访问时清理其视图，但保留当前登录身份。
    const f = await opened()
    const normalRead = f.read.getMockImplementation()!
    f.read.mockImplementation(async (
      /* 查询方法名，用于模拟图和工作区访问消失。 */ method,
      /* 未受影响查询的原始参数，继续交给正常夹具。 */ params,
      /* 未受影响查询的取消信号，继续交给正常夹具。 */ signal
    ) => {
      // 模拟图与工作区消失、工作区列表清空，其他查询仍可读取。
      if (method === 'map.get' || method === 'workspace.get') throw error(404, 'WORKSPACE_NOT_FOUND')
      if (method === 'workspace.list') return { items: [], nextCursor: null }
      return normalRead(method, params, signal)
    })
    await f.session.refresh()
    expect(f.session.workspace.value).toBeNull()
    expect(f.session.openMapIds.value).toEqual([])
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.bootstrap.value?.identity.userId).toBe('user-a')
    expect(f.disconnect).not.toHaveBeenCalled()
  })

  it('refreshes conflicts without auto-retrying or mutating the caller draft', async () => {
    // 验证版本冲突会刷新快照，而不会自动重试或改写调用方草稿。
    const f = await opened()
    const draft = { kind: 'claim' as const, content: 'Unsaved user edit', category: null }
    f.dispatch.mockRejectedValueOnce(error(409, 'REVISION_CONFLICT'))
    f.snapshots.set('map-a', map('map-a', 'workspace-a', 5))
    expect(await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data: draft })).toBe(false)
    expect(f.session.snapshot.value?.revision).toBe(5)
    expect(draft.content).toBe('Unsaved user edit')
    expect(f.session.canRetry.value).toBe(false)
    expect(f.dispatch).toHaveBeenCalledOnce()
  })

  it('retries the exact original mutation identity and payload even if the editor draft changes', async () => {
    // 验证网络失败后重试保持原请求身份与参数，即使编辑草稿已变化。
    const f = await opened()
    const sent: Array<{ id: string; method: string; params: any }> = []
    let failed = false
    f.dispatch.mockImplementation(async (
      /* 会话提交的命令身份，复制记录以核对原操作重试。 */ id,
      /* 会话提交的公开命令方法，复制记录以核对重试一致性。 */ method,
      /* 会话已复制的提交内容，再独立复制保存为调用观察值。 */ params
    ) => {
      // 记录命令副本并只使首次调用网络失败，供比较重试内容。
      sent.push(structuredClone({ id, method, params }))
      if (!failed) { failed = true; throw error(0, 'NETWORK_ERROR', true) }
      return success({ snapshot: map('map-a', 'workspace-a', 2), createdNodeIds: [], createdEdgeIds: [] })
    })
    const data = { kind: 'claim' as const, content: 'Original submitted edit', category: null }
    await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data })
    expect(f.session.canRetry.value).toBe(true)
    data.content = 'A newer unsaved draft'
    await f.session.retry()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
  })

  it('drops a retry belonging to a Workspace that the user has left', async () => {
    // 验证离开工作区后丢弃属于旧工作区的写入重试。
    const f = await opened()
    f.dispatch.mockRejectedValueOnce(error(0, 'NETWORK_ERROR', true))
    await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data: { kind: 'claim', content: 'Edit', category: null } })
    expect(f.session.canRetry.value).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    expect(f.session.canRetry.value).toBe(false)
    await f.session.retry()
    expect(f.dispatch).toHaveBeenCalledOnce()
  })

  it('persists the new Workspace preferences after an old Workspace save finishes late', async () => {
    // 验证旧工作区偏好保存迟到结束后仍会接续保存新工作区改动。
    const f = await opened()
    const pending = deferred<unknown>()
    const normalDispatch = f.dispatch.getMockImplementation()!
    f.dispatch.mockImplementation((
      /* 偏好请求的业务身份，非拦截分支原样转发。 */ id,
      /* 命令方法名，只拦截 preferences.set。 */ method,
      /* 命令参数，用工作区身份挑选要延迟的旧工作区保存。 */ params,
      /* 该命令的可选取消信号，非拦截分支保留原值。 */ signal
    ) => {
      // 仅延迟旧工作区的偏好写入，其他命令沿用正常夹具。
      if (method === 'preferences.set' && params.workspaceId === 'workspace-a') return pending.promise
      return normalDispatch(id, method, params, signal)
    })
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch.mock.calls.some(/* 命令调用参数元组，检查旧工作区偏好确已发出。 */ call =>
      /* 确认已开始保存旧工作区的偏好。 */
      call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-a')).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    await f.session.openMap('map-c', false)
    f.session.selectNode('map-c-claim')
    await vi.advanceTimersByTimeAsync(250)
    pending.resolve(success({ workspaceId: 'workspace-a', revision: 1, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: {} }))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch.mock.calls.some(/* 命令调用参数元组，检查新工作区偏好在旧保存结束后仍发出。 */ call =>
      /* 确认旧保存结束后新工作区偏好也得到提交。 */
      call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-b')).toBe(true)
    expect(f.session.workspace.value?.id).toBe('workspace-b')
  })

  it('closes a tab without cancelling its remote Run and enforces refreshed Viewer permissions', async () => {
    // 验证关闭标签不取消运行，刷新为只读角色后拒绝图修改。
    const f = await opened()
    f.snapshots.get('map-a')!.run = { id: 'run-a', scope: { nodeIds: ['map-a-claim'] }, until: 'verified', paused: false, regenerate: false, mode: 'human-in-loop', status: 'running', configuration: verificationConfiguration(),
      operations: [{ id: 'operation-a', kind: 'verify', targetId: 'map-a-claim', status: 'running', inputRefs: [], configurationHash: 'fixture', outputRefs: [], splitReports: [], contentDraft: null,
        route: null, reports: [], draft: null, review: null, resultNodeId: null }], createdAt: time, updatedAt: time }
    f.snapshots.get('map-a')!.revision++
    await f.session.refresh()
    expect(f.session.active.value).toBe(true)
    await f.session.closeMap('map-a')
    expect(f.session.snapshot.value).toBeNull()
    await f.session.openMap('map-a', false)
    f.workspaces.get('workspace-a')!.role = 'viewer'
    await f.session.refreshWorkspace()
    expect(f.session.canEdit.value).toBe(false)
    expect(await f.session.createNode('claim', 'No write')).toBe(false)
    expect(f.dispatch.mock.calls.some(/* 命令调用参数元组，检查只读与关页操作没有产生图写入或运行取消。 */ call =>
      /* 检查关闭标签或只读写入尝试是否错误发出运行取消或图变更命令。 */
      call[1] === 'run.cancel' || call[1] === 'graph.apply')).toBe(false)
  })
})
