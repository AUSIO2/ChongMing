// 会话状态测试：用可控事件流和虚拟时间验证视图隔离、重连与偏好保存。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientGateway } from '../../contracts/client'
import type { AppBootstrap, WorkspaceView } from '../../contracts/control'
import type { DataTypeDefinition } from '../../contracts/data-definition'
import type { GraphStreamEvent } from '../../contracts/events'
import type { GraphSnapshot } from '../../contracts/graph'
import { sessionCreateState } from '../../apps/ui/state/client-session'
import { verificationConfiguration } from '../backend/fixtures/verification'

vi.mock('../../apps/ui/transport/client-gateway', () => /* 替换默认应用网关，避免会话单元测试依赖真实传输环境。 */ ({ api: {} }))

const time = '2026-09-11T00:00:00.000Z'
const claimType: DataTypeDefinition = { id: 'demo.claim', version: 1, title: 'Claim', schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
  successorTypes: [], references: [], agentProjection: { include: ['/content'], mapEntryFilters: [] } }
const definitions = { workspaceId: 'workspace-a', catalog: { revision: 1, packages: [], index: [], dataTypes: [claimType], transitions: [] } }
const emptyPlan = { steps: [] }
/**
 * @param status 模拟 HTTP 错误状态，0 表示网络或本地失败。
 * @param code 模拟业务错误代码，同时用于 Error 的消息。
 * @param retryable 是否可重试，默认 false，网络重连用例可显式开启。
 */
const error = (
  status: number,
  code: string,
  retryable = false
) =>
  /* 构造带 HTTP 状态、错误代码和重试标记的测试异常。 */
  Object.assign(new Error(code), { status, code, retryable })
function deferred<T>() {
  /**
   * 创建可手动完成或拒绝的 Promise，供测试安排异步先后顺序。
   *
   * @param value 测试手动交付的延迟 Promise 成功值。
   * @param reason 测试手动注入的任意 Promise 拒绝原因。
   */
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    // 保存 Promise 的完成与拒绝函数。
    resolve = yes; reject = no
  })
  return { promise, resolve, reject }
}
/**
 * 将测试业务数据包装为成功命令结果。
 *
 * @param data 要包装为命令成功响应的测试业务结果。
 */
function success(data: unknown) {
  return { ok: true, requestId: 'request', replayed: false, data }
}
/**
 * 创建包含一个事实节点的指定工作区图快照。
 *
 * @param id 测试图身份，同时派生图名称和事实节点身份。
 * @param workspaceId 测试图所属工作区身份，默认 workspace-a。
 * @param revision 测试图版本，默认 1，用于安排新旧快照顺序。
 */
function map(
  id: string,
  workspaceId = 'workspace-a',
  revision = 1
): GraphSnapshot {
  return { mapId: id, workspaceId, revision, ownershipRevision: 0, ownerships: [], runControls: [], name: id, updatedAt: time, edges: [], runs: [],
    nodes: [{ id: `${id}-claim`, revision: 0, typeId: claimType.id, typeVersion: claimType.version, payload: { content: `${id} content` }, createdAt: time, updatedAt: time }] }
}
function branch(snapshot: GraphSnapshot, rootIds: string[]) {
  // 测试服务端按 successor 闭包返回稳定分支版本；图级 revision 不进入版本。
  const successors = new Map<string, string[]>()
  for (const edge of snapshot.edges) if (edge.kind === 'successor') successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to])
  const nodes = new Set<string>(), pending = [...rootIds]
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    if (nodes.has(id)) continue
    nodes.add(id); pending.push(...(successors.get(id) ?? []))
  }
  const nodeIds = [...nodes].sort(), edgeIds = snapshot.edges.filter(edge => edge.kind === 'successor' && nodes.has(edge.from) && nodes.has(edge.to)).map(edge => edge.id).sort()
  const versions = snapshot.nodes.filter(node => nodes.has(node.id)).map(node => `${node.id}:${node.revision}`).sort().join('|')
  return { scope: { rootIds: [...rootIds].sort(), nodeIds, edgeIds }, version: `branch:${versions}:${edgeIds.join('|')}`, mapRevision: snapshot.revision,
    rootRevisions: Object.fromEntries(rootIds.map(id => [id, snapshot.nodes.find(node => node.id === id)!.revision])) }
}
function claimed(snapshot: GraphSnapshot, rootIds: string[]) {
  const value = branch(snapshot, rootIds)
  return success({ status: 'claimed', grant: { leaseId: '11111111-1111-4111-8111-111111111111', kind: 'editor', rootIds: value.scope.rootIds,
    ownerUserId: 'user-a', holderId: '22222222-2222-4222-8222-222222222222', fence: 1,
    expiresAt: '2999-01-01T00:00:00.000Z', leaseMs: 30_000, scope: value.scope, branch: value, ownershipRevision: 1 } })
}
const runControl = { leaseId: '33333333-3333-4333-8333-333333333333', runId: 'run-a', ownerUserId: 'user-a',
  holderId: '22222222-2222-4222-8222-222222222222', fence: 2, expiresAt: '2999-01-01T00:00:00.000Z', leaseMs: 30_000 }
function controlled() { return success({ status: 'claimed', grant: { ...runControl, ownershipRevision: 1 } }) }
/**
 * 创建等待结果审核的运行快照，并允许指定暂停状态和图版本。
 *
 * @param paused 测试运行是否暂停，默认 false。
 * @param revision 带运行测试图的版本，默认 2。
 */
function processingMap(paused = false, revision = 2): GraphSnapshot {
  return { ...map('map-a', 'workspace-a', revision), ownershipRevision: 1, runControls: [{ ...runControl }], runs: [{
    id: 'run-a', scope: { nodeIds: ['map-a-claim'] }, until: 'verified', paused, regenerate: false, mode: 'human-in-loop', status: 'waiting', configuration: verificationConfiguration(),
    operations: [{ id: 'operation-a', kind: 'verify', targetId: 'map-a-claim', status: 'waiting', inputRefs: [], configurationHash: 'fixture', outputRefs: [], splitReports: [], contentDraft: null,
      route: null, reports: [], draft: null, review: { id: 'review-a', revision: 0, kind: 'result', state: 'pending', decision: null, createdAt: time, answeredAt: null }, resultNodeId: null }], createdAt: time, updatedAt: time,
  }] }
}
/**
 * 创建所有者视角的工作区与空偏好。
 *
 * @param id 测试工作区身份，同时用于名称和偏好所属范围。
 */
function workspace(id: string): WorkspaceView {
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
    method: string,
    params: any,
    _signal?: AbortSignal
  ): Promise<any> => {
    // 按公开查询方法从夹具读取启动信息、工作区或图副本。
    if (method === 'app.bootstrap') return structuredClone(bootstrap)
    if (method === 'workspace.list') return { items: [...workspaces.values()], nextCursor: null }
    if (method === 'workspace.get') return structuredClone(workspaces.get(params.workspaceId))
    if (method === 'map.list') return [...snapshots.values()].filter(snapshot =>
      /* 只列出请求工作区中的图。 */
      snapshot.workspaceId === params.workspaceId).map(snapshot =>
      /* 把完整图快照转换为列表摘要。 */
      ({
      id: snapshot.mapId, workspaceId: snapshot.workspaceId, revision: snapshot.revision, name: snapshot.name, nodeCount: snapshot.nodes.length,
      typeCounts: { 'demo.claim@1': 1 }, updatedAt: snapshot.updatedAt,
    }))
    if (method === 'definition.get') return structuredClone({ ...definitions, workspaceId: params.workspaceId })
    if (method === 'map.get') return structuredClone(snapshots.get(params.mapId))
    if (method === 'branch.get') return structuredClone(branch(snapshots.get(params.mapId)!, params.rootIds))
    throw new Error(`Unexpected query: ${method}`)
  })
  const dispatch = vi.fn(async (
    _id: string,
    method: string,
    params: any,
    _signal?: AbortSignal
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
    event: GraphStreamEvent
  ) => void; resolve: () => void; reject: (
    cause: unknown
  ) => void }> = []
  const watch = vi.fn((
    mapId: string,
    onEvent: (
      event: GraphStreamEvent
    ) => void,
    signal?: AbortSignal
  ) =>
    /* 创建可由测试主动推送、结束或拒绝的图订阅。 */
    new Promise<void>((resolve, reject) => {
    /**
     * 登记订阅控制入口，并令取消信号拒绝该订阅。
     *
     * @param event 测试主动推送的流事件，原样交给会话回调。
     */
    const emit = (event: GraphStreamEvent) => {
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
  it('uses local capabilities to edit, start and control without any client lease commands or timers', async () => {
    const f = fakeGateway()
    f.bootstrap.metadata.clientLeases = 'none'
    const session = sessionCreateState(f.gateway, 100)
    sessions.push(session)
    await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
    await session.openMap('map-a', false)
    expect(session.clientLeasesRequired.value).toBe(false)
    const edited = map('map-a', 'workspace-a', 2)
    edited.nodes[0].revision++
    edited.nodes[0].payload.content = 'Local edit'
    f.dispatch.mockResolvedValueOnce(success({ snapshot: edited, createdNodeIds: [], createdEdgeIds: [] }))
    expect(await session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' },
      nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: 'Local edit' } })).toBe(true)
    f.snapshots.set('map-a', edited)
    let runId = ''
    f.dispatch.mockImplementationOnce(async (_id, method, params) => {
      expect(method).toBe('run.start'); expect(params).not.toHaveProperty('lease')
      runId = params.id
      const running = processingMap(false, 3)
      running.nodes = edited.nodes; running.runControls = []; running.runs[0].id = runId
      f.snapshots.set('map-a', running)
      return success({ snapshot: running, createdNodeIds: [], createdEdgeIds: [] })
    })
    expect(await session.startRun({ scope: { nodeIds: ['map-a-claim'] }, plan: emptyPlan, mode: 'human-in-loop' })).toBe(true)
    const paused = structuredClone(f.snapshots.get('map-a')!)
    paused.revision++; paused.runs[0].paused = true
    f.dispatch.mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [] }))
    await session.pauseRun({ mapId: 'map-a', runId })
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['graph.apply', 'run.start', 'run.pause'])
    expect(f.dispatch.mock.calls[0][2]).not.toHaveProperty('lease')
    expect(f.dispatch.mock.calls[2][2]).not.toHaveProperty('control')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.dispatch.mock.calls.some(call => call[1].startsWith('branch.') || call[1].startsWith('run.control.'))).toBe(false)
    expect(session.selectedBranchGrant.value).toBeNull()
    expect(session.selectedRunControl.value).toBeNull()
  })

  // 覆盖会话隔离、实时流、版本仲裁、原命令重试和视图清理。
  it('loads and refreshes the workspace definition catalog as session state', async () => {
    const f = await opened()
    expect(f.session.definitions.value).toMatchObject({ workspaceId: 'workspace-a', catalog: { revision: 1 } })
    definitions.catalog.revision = 2
    await f.session.refreshWorkspace()
    expect(f.session.catalog.value?.revision).toBe(2)
    expect(f.read.mock.calls.some(call => call[0] === 'definition.get' && call[1].workspaceId === 'workspace-a')).toBe(true)
    definitions.catalog.revision = 1
  })
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
    next.runs[0].status = 'running'
    next.runs[0].operations[0].status = 'running'
    const activity = { mapId: next.mapId, runId: next.runs[0].id, operationId: 'operation-a', nodeId: 'map-a-claim', workId: 'work',
      stageId: 'route', slotId: 'route', agentName: 'Router', status: 'model' as const, fence: 1, sequence: 1, updatedAt: time }
    f.streams[0].emit({ type: 'snapshot', snapshot: next })
    f.streams[0].emit({ type: 'activity', items: [activity] })
    expect(f.session.activities.value).toEqual([activity])
    expect(f.session.snapshot.value?.revision).toBe(next.revision)
    f.streams[0].emit({ type: 'snapshot', snapshot: { ...next, revision: 3, runs: [{ ...next.runs[0], paused: true }] } })
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

  it('keeps a paused run branch protected while allowing an independent new root', async () => {
    // 验证暂停运行仍保护自己的范围，但不会把同图中新建的独立根降级为整图锁。
    const f = await opened()
    f.snapshots.set('map-a', processingMap())
    await f.session.refresh()
    const late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => /* 延迟旧图读取，供暂停命令先返回较新快照。 */ late.promise)
    const poll = f.session.refresh()
    const paused = processingMap(true, 3)
    f.snapshots.set('map-a', paused)
    f.dispatch.mockResolvedValueOnce(controlled()).mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.pauseRun({ mapId: 'map-a', runId: 'run-a' })
    late.resolve(processingMap(false, 2))
    await poll
    expect(f.session.snapshot.value?.runs[0]?.paused).toBe(true)
    expect(f.session.active.value).toBe(true)
    const withIndependentRoot = processingMap(true, 4)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: withIndependentRoot, createdNodeIds: ['new-root'], createdEdgeIds: [],
      branch: { scope: { rootIds: ['new-root'], nodeIds: ['new-root'], edgeIds: [] }, version: 'new-root-v1', rootRevisions: { 'new-root': 0 }, mapRevision: 4 } }))
    expect(await f.session.createNode(claimType, { content: 'Independent edit' })).toBe(true)
    expect(f.dispatch.mock.calls.find(call => call[1] === 'graph.apply')?.[2]).toMatchObject({ branch: { expectedVersion: null } })
    await f.session.startRun({ scope: { nodeIds: ['map-a-claim'] }, plan: emptyPlan, mode: 'auto' })
    expect(f.dispatch).toHaveBeenCalledTimes(3)
    const approved = processingMap(true, 5)
    approved.runs[0].operations[0].review!.state = 'answered'
    f.dispatch.mockResolvedValueOnce(success({ snapshot: approved, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.answerReview({ mapId: 'map-a', runId: 'run-a', operationId: 'operation-a', reviewId: 'review-a', expectedReviewRevision: 0, decision: 'approve' })
    expect(f.session.snapshot.value?.runs[0]?.paused).toBe(true)
    expect(f.dispatch.mock.calls.find(call => call[1] === 'review.answer')?.[2]).toMatchObject({ operationId: 'operation-a', control: { leaseId: runControl.leaseId } })
    const reads = f.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)
    expect(f.read.mock.calls).toHaveLength(reads)
    f.streams[0].emit({ type: 'snapshot', snapshot: approved })
    expect(f.session.snapshot.value?.runs[0]?.paused).toBe(true)
    await f.session.closeMap('map-a')
    expect(f.dispatch.mock.calls.some(call =>
      /* 检测关闭标签时是否错误发出了取消或恢复运行命令。 */
      call[1] === 'run.cancel' || call[1] === 'run.resume')).toBe(false)
  })

  it('submits explicit node scope and resumes the same Run with its accepted state', async () => {
    // 验证新运行提交显式节点范围，恢复保留同一 Run 与审核状态，权限刷新后阻止写操作。
    const f = await opened()
    const paused = processingMap(true)
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
      .mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [], runControl: { ...runControl, ownershipRevision: 1 } }))
    await f.session.startRun({ scope: { nodeIds: ['map-a-claim'] }, plan: emptyPlan, mode: 'human-in-loop', regenerate: true })
    const startCall = f.dispatch.mock.calls.find(call => call[1] === 'run.start')!
    expect(startCall[2]).toMatchObject({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' },
      scope: { nodeIds: ['map-a-claim'] }, plan: emptyPlan, regenerate: true })
    expect(startCall[2]).not.toHaveProperty('targetId')
    expect(startCall[2]).not.toHaveProperty('expectedRevision')
    const resumed = processingMap(false, 3)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: resumed, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.resumeRun({ mapId: 'map-a', runId: 'run-a' })
    expect(f.session.snapshot.value?.runs[0]).toMatchObject({ id: 'run-a', paused: false, operations: [{ id: 'operation-a', review: { id: 'review-a', state: 'pending' } }] })
    f.workspaces.get('workspace-a')!.role = 'viewer'
    await f.session.refreshWorkspace()
    await f.session.pauseRun({ mapId: 'map-a', runId: 'run-a' })
    expect(f.dispatch).toHaveBeenCalledTimes(3)
  })

  it('keeps Run controls read-only while occupied and enables them after takeover', async () => {
    const f = await opened(), running = processingMap(false, 2)
    f.snapshots.set('map-a', running)
    await f.session.refresh()
    f.dispatch.mockResolvedValueOnce(success({ status: 'busy', control: { ...runControl } }))
    await f.session.pauseRun({ mapId: 'map-a', runId: 'run-a' })
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['run.control.claim'])
    expect(f.session.selectedRunControl.value).toBeNull()

    const available = { ...running, ownershipRevision: 2, runControls: [] }
    f.streams[0].emit({ type: 'snapshot', snapshot: available })
    const paused = { ...processingMap(true, 3), ownershipRevision: 3 }
    f.dispatch.mockResolvedValueOnce(controlled()).mockResolvedValueOnce(success({ snapshot: paused, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.pauseRun({ mapId: 'map-a', runId: 'run-a' })
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['run.control.claim', 'run.control.claim', 'run.pause'])
    expect(f.dispatch.mock.calls[2][2]).toMatchObject({ control: { leaseId: runControl.leaseId, fence: runControl.fence } })
    expect(f.session.snapshot.value?.runs[0]?.paused).toBe(true)
  })

  it('selects one of multiple Runs and releases the previous control', async () => {
    const f = await opened(), multi = processingMap(false, 2)
    multi.runs.push({ ...structuredClone(multi.runs[0]), id: 'run-b', scope: { nodeIds: ['map-a-claim-b'] } })
    f.snapshots.set('map-a', multi)
    await f.session.refresh()
    expect(f.session.selectedRun.value?.id).toBe('run-a')
    f.dispatch.mockResolvedValueOnce(controlled())
      .mockResolvedValueOnce(success({ released: true, ownershipRevision: 2 }))
    expect(await f.session.claimRunControl('run-a')).toBe(true)
    await f.session.selectRun('run-b')
    expect(f.session.selectedRun.value?.id).toBe('run-b')
    expect(f.session.selectedRunControl.value).toBeNull()
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(['run.control.claim', 'run.control.release'])
  })

  it('creates a node with its exact registered type and generic payload', async () => {
    const f = await opened()
    f.dispatch.mockImplementationOnce(async (_id, method, params: any) => {
      expect(method).toBe('graph.apply')
      const input = params.changes.nodes.put[0]
      expect(input).toMatchObject({ typeId: claimType.id, typeVersion: claimType.version, payload: { content: 'Registered data' } })
      expect(input).not.toHaveProperty('data')
      const next = map('map-a', 'workspace-a', 2)
      next.nodes.push({ id: input.id, revision: 0, typeId: input.typeId, typeVersion: input.typeVersion, payload: input.payload, createdAt: time, updatedAt: time })
      return success({ snapshot: next, createdNodeIds: [input.id], createdEdgeIds: [] })
    })
    expect(await f.session.createNode(claimType, { content: 'Registered data' })).toBe(true)
    expect(f.session.selectedId.value).toBe(f.session.snapshot.value?.nodes[1].id)
  })

  it('reads and submits the selected branch version instead of the whole Map revision', async () => {
    const f = await opened()
    f.session.selectNode('map-a-claim')
    await vi.waitFor(() => expect(f.session.selectedBranch.value).toMatchObject({
      scope: { rootIds: ['map-a-claim'], nodeIds: ['map-a-claim'] }, version: 'branch:map-a-claim:0:', rootRevisions: { 'map-a-claim': 0 },
    }))
    const proof = { rootIds: ['map-a-claim'], expectedVersion: f.session.selectedBranch.value!.version }
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
    f.dispatch.mockImplementationOnce(async (_id, method, params: any) => {
      expect(method).toBe('graph.apply')
      expect(params).toMatchObject({ branch: proof })
      expect(params).not.toHaveProperty('expectedRevision')
      const next = map('map-a', 'workspace-a', 9)
      next.nodes[0].revision = 1; next.nodes[0].payload = { content: 'Saved by branch' }
      f.snapshots.set('map-a', next)
      return success({ snapshot: next, createdNodeIds: [], createdEdgeIds: [],
        branch: { scope: { rootIds: ['map-a-claim'], nodeIds: ['map-a-claim'], edgeIds: [] }, version: 'branch:map-a-claim:1:', rootRevisions: { 'map-a-claim': 1 }, mapRevision: 9 } })
    })
    expect(await f.session.saveNode({ branch: proof, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1,
      payload: { content: 'Saved by branch' } })).toBe(true)
    expect(f.session.selectedBranch.value?.version).toBe('branch:map-a-claim:1:')
  })

  it('ignores late Map replies after a different Map is opened and aborts the old view', async () => {
    // 验证切图会取消旧视图并忽略迟到的旧图响应。
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.read.getMockImplementation()!
    let oldSignal: AbortSignal | undefined
    f.read.mockImplementation(async (
      method,
      params,
      signal
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
      method,
      params,
      signal
    ) =>
      /* 延迟图快照读取，其他查询继续走正常夹具。 */
      method === 'map.get' ? late.promise : normalRead(method, params, signal))
    const polling = f.session.refresh()
    const newest = map('map-a', 'workspace-a', 3)
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
      .mockResolvedValueOnce(success({ snapshot: newest, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' }, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: 'Mine' } })
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
    expect(f.dispatch.mock.calls.some(call => /* 检查退出登录是否错误提交取消运行命令。 */ call[1] === 'run.cancel')).toBe(false)
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
    expect(f.dispatch.mock.calls.some(call => /* 检查关闭订阅时是否错误取消远端运行。 */ call[1] === 'run.cancel')).toBe(false)
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
    expect(f.session.mapList.value.find(map =>
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
    const count = f.read.mock.calls.filter(call => /* 统计刷新前已经发生的图读取。 */ call[0] === 'map.get').length
    f.workspaces.get('workspace-a')!.revision = 2
    f.workspaces.get('workspace-a')!.name = 'Shared metadata'
    f.bootstrap.settings.revision = 2
    f.bootstrap.settings.llm.model = 'new model'
    f.streams[0].emit({ type: 'refresh', scope: 'workspace' })
    f.streams[0].emit({ type: 'refresh', scope: 'settings' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.workspace.value?.name).toBe('Shared metadata')
    expect(f.session.bootstrap.value?.settings.llm.model).toBe('new model')
    expect(f.read.mock.calls.filter(call => /* 统计刷新后图读取次数，检查没有多余请求。 */ call[0] === 'map.get')).toHaveLength(count)
  })

  it.each([401, 403, 404])('stops inaccessible subscriptions after %s without cancelling the Run', async status => {
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
    expect(f.dispatch.mock.calls.some(call => /* 检查访问失效处理是否错误发出运行取消命令。 */ call[1] === 'run.cancel')).toBe(false)
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
    expect(f.dispatch.mock.calls.some(call => /* 检查认证失效时是否错误取消远端运行。 */ call[1] === 'run.cancel')).toBe(false)
  })

  it('clears an inaccessible Workspace without signing the user out', async () => {
    // 验证工作区不可访问时清理其视图，但保留当前登录身份。
    const f = await opened()
    const normalRead = f.read.getMockImplementation()!
    f.read.mockImplementation(async (
      method,
      params,
      signal
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
    // 验证分支版本冲突会刷新快照，而不会自动重试或改写调用方草稿。
    const f = await opened()
    const draft = { kind: 'claim' as const, content: 'Unsaved user edit', category: null }
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
      .mockRejectedValueOnce(error(409, 'BRANCH_VERSION_CONFLICT'))
    f.snapshots.set('map-a', map('map-a', 'workspace-a', 5))
    expect(await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' }, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: draft.content } })).toBe(false)
    expect(f.session.snapshot.value?.revision).toBe(5)
    expect(draft.content).toBe('Unsaved user edit')
    expect(f.session.canRetry.value).toBe(false)
    expect(f.dispatch.mock.calls.filter(call => call[1] === 'graph.apply')).toHaveLength(1)
  })

  it('retries the exact original mutation identity and payload even if the editor draft changes', async () => {
    // 验证网络失败后重试保持原请求身份与参数，即使编辑草稿已变化。
    const f = await opened()
    const sent: Array<{ id: string; method: string; params: any }> = []
    let failed = false
    f.dispatch.mockImplementation(async (
      id,
      method,
      params
    ) => {
      // 记录命令副本并只使首次调用网络失败，供比较重试内容。
      if (method === 'branch.claim') return claimed(f.snapshots.get('map-a')!, params.rootIds)
      sent.push(structuredClone({ id, method, params }))
      if (!failed) { failed = true; throw error(0, 'NETWORK_ERROR', true) }
      return success({ snapshot: map('map-a', 'workspace-a', 2), createdNodeIds: [], createdEdgeIds: [] })
    })
    const data = { kind: 'claim' as const, content: 'Original submitted edit', category: null }
    await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' }, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: data.content } })
    expect(f.session.canRetry.value).toBe(true)
    data.content = 'A newer unsaved draft'
    await f.session.retry()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
  })

  it('drops a retry belonging to a Workspace that the user has left', async () => {
    // 验证离开工作区后丢弃属于旧工作区的写入重试。
    const f = await opened()
    f.dispatch.mockResolvedValueOnce(claimed(f.snapshots.get('map-a')!, ['map-a-claim']))
      .mockRejectedValueOnce(error(0, 'NETWORK_ERROR', true))
    await f.session.saveNode({ branch: { rootIds: ['map-a-claim'], expectedVersion: 'branch:map-a-claim:0:' }, nodeId: 'map-a-claim', typeId: claimType.id, typeVersion: 1, payload: { content: 'Edit' } })
    expect(f.session.canRetry.value).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    expect(f.session.canRetry.value).toBe(false)
    await f.session.retry()
    expect(f.dispatch.mock.calls.filter(call => call[1] === 'graph.apply')).toHaveLength(1)
  })

  it('persists the new Workspace preferences after an old Workspace save finishes late', async () => {
    // 验证旧工作区偏好保存迟到结束后仍会接续保存新工作区改动。
    const f = await opened()
    const pending = deferred<unknown>()
    const normalDispatch = f.dispatch.getMockImplementation()!
    f.dispatch.mockImplementation((
      id,
      method,
      params,
      signal
    ) => {
      // 仅延迟旧工作区的偏好写入，其他命令沿用正常夹具。
      if (method === 'preferences.set' && params.workspaceId === 'workspace-a') return pending.promise
      return normalDispatch(id, method, params, signal)
    })
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch.mock.calls.some(call =>
      /* 确认已开始保存旧工作区的偏好。 */
      call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-a')).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    await f.session.openMap('map-c', false)
    f.session.selectNode('map-c-claim')
    await vi.advanceTimersByTimeAsync(250)
    pending.resolve(success({ workspaceId: 'workspace-a', revision: 1, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: {} }))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch.mock.calls.some(call =>
      /* 确认旧保存结束后新工作区偏好也得到提交。 */
      call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-b')).toBe(true)
    expect(f.session.workspace.value?.id).toBe('workspace-b')
  })

  it('closes a tab without cancelling its remote Run and enforces refreshed Viewer permissions', async () => {
    // 验证关闭标签不取消运行，刷新为只读角色后拒绝图修改。
    const f = await opened()
    f.snapshots.get('map-a')!.runs = [{ id: 'run-a', scope: { nodeIds: ['map-a-claim'] }, until: 'verified', paused: false, regenerate: false, mode: 'human-in-loop', status: 'running', configuration: verificationConfiguration(),
      operations: [{ id: 'operation-a', kind: 'verify', targetId: 'map-a-claim', status: 'running', inputRefs: [], configurationHash: 'fixture', outputRefs: [], splitReports: [], contentDraft: null,
        route: null, reports: [], draft: null, review: null, resultNodeId: null }], createdAt: time, updatedAt: time }]
    f.snapshots.get('map-a')!.revision++
    await f.session.refresh()
    expect(f.session.active.value).toBe(true)
    await f.session.closeMap('map-a')
    expect(f.session.snapshot.value).toBeNull()
    await f.session.openMap('map-a', false)
    f.workspaces.get('workspace-a')!.role = 'viewer'
    await f.session.refreshWorkspace()
    expect(f.session.canEdit.value).toBe(false)
    expect(await f.session.createNode(claimType, { content: 'No write' })).toBe(false)
    expect(f.dispatch.mock.calls.some(call =>
      /* 检查关闭标签或只读写入尝试是否错误发出运行取消或图变更命令。 */
      call[1] === 'run.cancel' || call[1] === 'graph.apply')).toBe(false)
  })
})
