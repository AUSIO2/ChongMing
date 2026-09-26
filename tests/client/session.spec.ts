import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientGateway } from '../../contracts/client'
import type { AppBootstrap, WorkspaceView } from '../../contracts/control'
import type { GraphStreamEvent } from '../../contracts/events'
import type { GraphSnapshot } from '../../contracts/graph'
import { sessionCreateState } from '../../apps/ui/state/client-session'
import { verificationConfiguration } from '../backend/fixtures/verification'

vi.mock('../../apps/ui/transport/client-gateway', () => ({ api: {} }))

const time = '2026-09-11T00:00:00.000Z'
const error = (status: number, code: string, retryable = false) => Object.assign(new Error(code), { status, code, retryable })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function success(data: unknown) { return { ok: true, requestId: 'request', replayed: false, data } }
function map(id: string, workspaceId = 'workspace-a', revision = 1): GraphSnapshot {
  return { mapId: id, workspaceId, revision, name: id, updatedAt: time, edges: [], run: null,
    nodes: [{ id: `${id}-claim`, revision: 0, data: { kind: 'claim', content: `${id} content`, category: null }, createdAt: time, updatedAt: time }] }
}
function processingMap(paused = false, revision = 2): GraphSnapshot {
  return { ...map('map-a', 'workspace-a', revision), run: {
    id: 'run-a', scope: { nodeIds: ['map-a-claim'] }, until: 'verified', paused, regenerate: false, mode: 'human-in-loop', status: 'waiting', configuration: verificationConfiguration(),
    operations: [{ id: 'operation-a', kind: 'verify', targetId: 'map-a-claim', status: 'waiting', inputRefs: [], configurationHash: 'fixture', outputRefs: [], splitReports: [], contentDraft: null,
      route: null, reports: [], draft: null, review: { id: 'review-a', revision: 0, kind: 'result', state: 'pending', decision: null, createdAt: time, answeredAt: null }, resultNodeId: null }], createdAt: time, updatedAt: time,
  } }
}
function workspace(id: string): WorkspaceView {
  return { id, name: id, description: '', revision: 0, role: 'owner', mapCount: 2, updatedAt: time, agents: [], members: [],
    preferences: { workspaceId: id, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} } }
}

function fakeGateway() {
  let configured = false
  const snapshots = new Map([['map-a', map('map-a')], ['map-b', map('map-b')], ['map-c', map('map-c', 'workspace-b')]])
  const workspaces = new Map([['workspace-a', workspace('workspace-a')], ['workspace-b', workspace('workspace-b')]])
  const bootstrap = { identity: { userId: 'user-a', displayName: 'A', hostAdmin: false }, settings: {
    revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 3 },
  }, metadata: { version: 'fixture', promptKinds: [], executableKinds: ['verify'], scores: [0, 0.5, 1], variables: {}, outputs: [] } } as unknown as AppBootstrap
  const read = vi.fn(async (method: string, params: any, _signal?: AbortSignal): Promise<any> => {
    if (method === 'app.bootstrap') return structuredClone(bootstrap)
    if (method === 'workspace.list') return { items: [...workspaces.values()], nextCursor: null }
    if (method === 'workspace.get') return structuredClone(workspaces.get(params.workspaceId))
    if (method === 'map.list') return [...snapshots.values()].filter(snapshot => snapshot.workspaceId === params.workspaceId).map(snapshot => ({
      id: snapshot.mapId, workspaceId: snapshot.workspaceId, revision: snapshot.revision, name: snapshot.name, nodeCount: snapshot.nodes.length,
      claimCount: 1, updatedAt: snapshot.updatedAt,
    }))
    if (method === 'map.get') return structuredClone(snapshots.get(params.mapId))
    throw new Error(`Unexpected query: ${method}`)
  })
  const dispatch = vi.fn(async (_id: string, method: string, params: any, _signal?: AbortSignal): Promise<any> => {
    if (method === 'preferences.set') return success({ workspaceId: params.workspaceId, revision: params.expectedRevision + 1,
      openMapIds: params.openMapIds, currentMapId: params.currentMapId, nodeSelection: params.nodeSelection })
    throw new Error(`Unexpected command: ${method}`)
  })
  const connect = vi.fn(async () => { configured = true; return structuredClone(bootstrap) })
  const disconnect = vi.fn(async () => { configured = false })
  const getConnection = vi.fn(async () => ({ baseUrl: 'http://fixture', configured, remembered: false, canRemember: false }))
  const streams: Array<{ mapId: string; signal?: AbortSignal; emit: (event: GraphStreamEvent) => void; resolve: () => void; reject: (cause: unknown) => void }> = []
  const watch = vi.fn((mapId: string, onEvent: (event: GraphStreamEvent) => void, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const emit = (event: GraphStreamEvent) => { try { onEvent(event) } catch (cause) { reject(cause) } }
    streams.push({ mapId, emit, signal, resolve, reject })
    signal?.addEventListener('abort', () => reject(error(0, 'REQUEST_ABORTED')), { once: true })
  }))
  const gateway = { watch, read, dispatch, connect, disconnect, getConnection } as unknown as ClientGateway
  return { gateway, watch, streams, read, dispatch, connect, disconnect, getConnection, snapshots, workspaces, bootstrap }
}

const sessions: ReturnType<typeof sessionCreateState>[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers() })

async function opened() {
  const f = fakeGateway()
  const session = sessionCreateState(f.gateway, 100)
  sessions.push(session)
  await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
  await session.openMap('map-a', false)
  return { ...f, session }
}

describe('Client session state and subscriptions', () => {
  it('replaces unexpected client exceptions with a safe message and a diagnostic id', async () => {
    const f = await opened()
    f.read.mockRejectedValueOnce(new Error('private-token at /Users/private/file'))
    await f.session.refresh()
    expect(f.session.error.value).toMatchObject({ code: 'CLIENT_ERROR', message: '操作失败，请根据错误编号查看诊断。', errorId: expect.any(String) })
    expect(JSON.stringify(f.session.error.value)).not.toMatch(/private-token|\/Users\/private/)
  })
  it('keeps activity separate from snapshot revision and clears it on pause, disconnect and map switch', async () => {
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
    const f = await opened()
    f.snapshots.set('map-a', processingMap())
    await f.session.refresh()
    const late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => late.promise)
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
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel' || call[1] === 'run.resume')).toBe(false)
  })

  it('submits explicit node scope and resumes the same Run with its accepted state', async () => {
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
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.read.getMockImplementation()!
    let oldSignal: AbortSignal | undefined
    f.read.mockImplementation(async (method, params, signal) => {
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
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.read.getMockImplementation()!
    f.read.mockImplementation((method, params, signal) => method === 'map.get' ? late.promise : normalRead(method, params, signal))
    const polling = f.session.refresh()
    const newest = map('map-a', 'workspace-a', 3)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: newest, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data: { kind: 'claim', content: 'Mine', category: null } })
    late.resolve(map('map-a', 'workspace-a', 2))
    await polling
    expect(f.session.snapshot.value?.revision).toBe(3)
  })

  it('does not restore private state from pending requests after disconnect', async () => {
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => late.promise)
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
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel')).toBe(false)
  })

  it('ignores initialization connection metadata that arrives after a new login', async () => {
    const f = fakeGateway()
    const session = sessionCreateState(f.gateway, 100)
    sessions.push(session)
    const stale = deferred<Awaited<ReturnType<ClientGateway['getConnection']>>>()
    f.getConnection.mockImplementationOnce(() => stale.promise)
    const initializing = session.initialize()
    await session.connect({ baseUrl: 'http://fixture', token: 'new-token', remember: false })
    expect(session.connection.value?.configured).toBe(true)
    stale.resolve({ baseUrl: 'http://previous-host', configured: false, remembered: false, canRemember: false })
    await initializing
    expect(session.connection.value).toMatchObject({ baseUrl: 'http://fixture', configured: true })
    expect(session.bootstrap.value?.identity.userId).toBe('user-a')
  })

  it('reconnects ended streams with capped backoff without polling snapshots', async () => {
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
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel')).toBe(false)
  })

  it('adopts stream snapshots and summaries while ignoring old HTTP failures and old view callbacks', async () => {
    const f = await opened(), late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => late.promise)
    const reading = f.session.refresh()
    const next = map('map-a', 'workspace-a', 5)
    next.name = 'Live graph'
    f.streams[0].emit({ type: 'snapshot', snapshot: next })
    late.reject(error(404, 'MAP_NOT_FOUND'))
    await reading
    expect(f.session.snapshot.value?.revision).toBe(5)
    expect(f.session.mapList.value.find(map => map.id === 'map-a')).toMatchObject({ name: 'Live graph', revision: 5, nodeCount: 1 })
    expect(f.session.online.value).toBe(true)
    expect(f.session.error.value).toBeNull()
    await f.session.openMap('map-b', false)
    f.streams[0].emit({ type: 'snapshot', snapshot: map('map-a', 'workspace-a', 99) })
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.streams[0].signal?.aborted).toBe(true)
  })

  it('refreshes invalidated workspace and settings without another Map read', async () => {
    const f = await opened()
    const count = f.read.mock.calls.filter(call => call[0] === 'map.get').length
    f.workspaces.get('workspace-a')!.revision = 2
    f.workspaces.get('workspace-a')!.name = 'Shared metadata'
    f.bootstrap.settings.revision = 2
    f.bootstrap.settings.llm.model = 'new model'
    f.streams[0].emit({ type: 'refresh', scope: 'workspace' })
    f.streams[0].emit({ type: 'refresh', scope: 'settings' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.workspace.value?.name).toBe('Shared metadata')
    expect(f.session.bootstrap.value?.settings.llm.model).toBe('new model')
    expect(f.read.mock.calls.filter(call => call[0] === 'map.get')).toHaveLength(count)
  })

  it.each([401, 403, 404])('stops inaccessible subscriptions after %s without cancelling the Run', async status => {
    const f = await opened()
    f.streams[0].emit({ type: 'error', error: { status, code: status === 401 ? 'UNAUTHORIZED' : 'MAP_NOT_FOUND', message: 'Access ended', retryable: false, errorId: crypto.randomUUID() } })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.activeMapId.value).toBeNull()
    expect(f.streams[0].signal?.aborted).toBe(true)
    expect(f.session.bootstrap.value === null).toBe(status === 401)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.watch).toHaveBeenCalledTimes(1)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel')).toBe(false)
  })

  it('disconnects on 401, clears private data, and does not cancel remote execution', async () => {
    const f = await opened()
    f.read.mockRejectedValueOnce(error(401, 'UNAUTHORIZED'))
    await f.session.refresh()
    expect(f.disconnect).toHaveBeenCalledOnce()
    expect(f.session.bootstrap.value).toBeNull()
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.error.value?.status).toBe(401)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel')).toBe(false)
  })

  it('clears an inaccessible Workspace without signing the user out', async () => {
    const f = await opened()
    const normalRead = f.read.getMockImplementation()!
    f.read.mockImplementation(async (method, params, signal) => {
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
    const f = await opened()
    const sent: Array<{ id: string; method: string; params: any }> = []
    let failed = false
    f.dispatch.mockImplementation(async (id, method, params) => {
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
    const f = await opened()
    const pending = deferred<unknown>()
    const normalDispatch = f.dispatch.getMockImplementation()!
    f.dispatch.mockImplementation((id, method, params, signal) => {
      if (method === 'preferences.set' && params.workspaceId === 'workspace-a') return pending.promise
      return normalDispatch(id, method, params, signal)
    })
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-a')).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    await f.session.openMap('map-c', false)
    f.session.selectNode('map-c-claim')
    await vi.advanceTimersByTimeAsync(250)
    pending.resolve(success({ workspaceId: 'workspace-a', revision: 1, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: {} }))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-b')).toBe(true)
    expect(f.session.workspace.value?.id).toBe('workspace-b')
  })

  it('closes a tab without cancelling its remote Run and enforces refreshed Viewer permissions', async () => {
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
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel' || call[1] === 'graph.apply')).toBe(false)
  })
})
